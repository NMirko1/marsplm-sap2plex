/**
 * Bootstrap condiviso dei job batch.
 *
 * Sostituisce il blocco `if (require.main === module)` che era duplicato in tutti i job,
 * e garantisce che il riepilogo venga chiuso e il recap tentato ANCHE quando il job muore.
 *
 * Coda di ogni job:
 *     if (require.main === module) {
 *       const { runJob } = require('./lib/runJob');
 *       runJob({ jobCode: 'MAT_SYNC', serveAll: true, main: (summary) => run(summary) });
 *     }
 *
 * `serveAll` resta opt-in: solo MAT_SYNC e ROUTING_SYNC invocano action di servizi locali
 * (PlexService / ProductionRouting) e hanno bisogno di cds.serve('all'). Accenderlo per gli
 * altri due istanzierebbe ogni implementazione di servizio in un processo che non ne ha bisogno.
 *
 * EXIT CODE: deriva da TotalFailed, dall'errore fatale e - dalla DEC-124 - da `blocked`, cioe' da
 * almeno una chiamata verso un sistema esterno che non ha prodotto una risposta utilizzabile
 * ([RUN-BLOCKED]). Prima mancava la terza, e un run che non aveva potuto fare NIENTE perche' la sua
 * lettura di perimetro era caduta usciva 0: il Job Scheduler registrava COMPLETED/SUCCESS.
 * TotalExhausted resta escluso di proposito - altrimenti un retry esaurito tingerebbe di rosso il
 * job per sempre, ed e' esattamente il motivo per cui postProdOrderConfirmation ritorna
 * {sent, failed} senza `exhausted`. Un fallimento di invio mail NON cambia l'exit code: il segnale
 * allo scheduler riguarda l'integrazione, non il canale di notifica.
 * Il calcolo NON e' scritto qui: sta in srv/lib/jobRunStatusRules.js accanto alla cascata dello
 * stato, perche' due copie della stessa decisione in due file sono divergibili in silenzio.
 *
 * COPERTURA DEI FALLIMENTI, onestamente:
 *   main() lancia .................. coperto: fatal() -> HDR 'E', POS flushate, mail inviata, exit 1
 *   un record lancia ............... coperto dal try/catch per-record gia' presente nei job
 *   flush POS fallisce a metà ...... parziale: i blocchi precedenti sono committati, quello
 *                                    fallito viene ritentato riga per riga; i contatori
 *                                    vengono dalla memoria, quindi la mail e' corretta ma il
 *                                    CSV puo' mostrare meno righe (dichiarato nel corpo mail)
 *   il DB cade a metà run .......... parziale: i destinatari sono precaricati, la mail parte
 *   cds.load('*') fallisce ......... parziale: nessun modello -> nessun run log e nessun
 *                                    destinatario leggibile; unica via MAIL_FALLBACK_TO
 *   SIGTERM da CF .................. best effort: il budget basta a flushare le POS e scrivere
 *                                    HDR 'E', NON a costruire un PDF e completare una POST
 *   SIGKILL / OOM-kill ............. non coperto: nessun handler viene eseguito. Rilevamento:
 *                                    ZJobRunHDR con Status='R' e FinishedAt NULL
 */

'use strict';

const cds = require('@sap/cds');
const {
  createJobSummary, E_RUN_HDR, E_RUN_POS, E_RUN_MAIL
} = require('../../lib/jobSummary');
const { jobLabel } = require('../../lib/jobCodes');
// [RUN-BLOCKED] L'exit code e lo stato della testata sono la stessa decisione: stanno insieme,
// puri e collaudati, in un modulo solo (DEC-124).
const { exitCodeOf } = require('../../lib/jobRunStatusRules');
// [IS-EGRESS] Il nome del marcatore arriva da dove vive la decisione, non copiato: una stringa
// ripetuta qui divergerebbe in silenzio, e il silenzio sarebbe «le chiamate del job escono sul
// canale del cockpit» — l'omissione opposta a quella del 26/08 (DEC-98).
const { IS_BATCH_ENV } = require('../../lib/isEgress');
// [IS-CALL-LOG] Solo per il CENSIMENTO di fine run: un log senza voci di dump non distingue
// «nessuna lettura sospetta» da «il dump era spento», e questa e' l'unica funzione che a fine run
// sa quante letture sono passate. Il modulo non tocca `cds` al require.
const isCallLog = require('../../lib/isCallLog');

const RETENTION_DAYS = parseInt(process.env.JOB_RUNLOG_RETENTION_DAYS || '90', 10);
const SIGTERM_BUDGET_MS = parseInt(process.env.PLEX_JOB_SIGTERM_BUDGET_MS || '8000', 10);
const PURGE_CHUNK = 200;

/**
 * Purge dei run vecchi. Gira all'INIZIO, non alla fine: non deve ritardare la mail.
 * Non e' opzionale - tutti i MAX_*_PER_RUN valgono 0 (illimitato), quindi il primo sync
 * completo scrive migliaia di righe POS in uno schema hdi-shared, per sempre.
 */
async function purgeOldRuns(db, jobCode) {
  if (!(RETENTION_DAYS > 0)) return 0;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5).toISOString();
  try {
    const ids = (await db.run(
      SELECT.from(E_RUN_HDR).columns('RunId').where({ JobCode: jobCode, StartedAt: { '<': cutoff } })
    ) || []).map((r) => r.RunId);
    if (!ids.length) return 0;
    for (let i = 0; i < ids.length; i += PURGE_CHUNK) {
      const chunk = ids.slice(i, i + PURGE_CHUNK);
      await db.run(DELETE.from(E_RUN_POS).where({ RunId: { in: chunk } }));
      await db.run(DELETE.from(E_RUN_MAIL).where({ RunId: { in: chunk } }));
      await db.run(DELETE.from(E_RUN_HDR).where({ RunId: { in: chunk } }));
    }
    console.log(`>>> [JOB ${jobCode}] retention: rimossi ${ids.length} run piu' vecchi di ${RETENTION_DAYS} giorni`);
    return ids.length;
  } catch (e) {
    // Non-bloccante: la pulizia non deve impedire il run.
    console.error(`>>> [JOB ${jobCode}] retention fallita (non-blocking): ${e.message}`);
    return 0;
  }
}

/**
 * Avvia un job batch. Non ritorna: termina il processo con l'exit code calcolato.
 *
 * @param {object} spec
 * @param {string} spec.jobCode         MAT_SYNC | ROUTING_SYNC | PROD_ORDER | PROD_CONF |
 *                                      PROD_TECO | ORDER_COMPLETE | ORDER_SCHEDULED
 *                                      (elenco canonico: srv/lib/jobCodes.js)
 * @param {boolean} [spec.serveAll]     true se il job invoca action di servizi locali
 * @param {(summary:object, ctx:object) => Promise<any>} spec.main
 */
async function runJob({ jobCode, serveAll = false, main }) {
  // [IS-EGRESS] Questo processo E' un run batch, e lo dichiara nel PROPRIO ambiente: da qui — e
  // SOLO da qui — le chiamate verso gli iFlow escono sulla destination con utenza tecnica
  // (`MARS_SAP_CON_BA`), perche' un run batch non ha un utente da propagare. Mai dal server web
  // (DEC-98). Fino al 28/08/2026 il marcatore decideva anche un header applicativo, ora rimosso.
  // Sta in cima e non altrove perche' i quattro punti d'uscita leggono il marcatore quando
  // costruiscono la loro istanza remota — cioe' alla prima chiamata, dentro main() — e non lo
  // rileggono piu'. Il figlio del `fork` di [JOB-TRIGGER] eredita l'ambiente del padre, dove la
  // variabile NON c'e': la scrive qui per se stesso, come ogni `npm run job-*` e ogni `cf run-task`.
  process.env[IS_BATCH_ENV] = jobCode;
  // [JOB-TRIGGER] Il RunId puo' arrivare DA FUORI (feature 0032). Quando il run e' avviato da un
  // endpoint per il Job Scheduler BTP, il processo padre lo genera prima del `fork` e lo passa
  // nell'ambiente: senza, il padre non saprebbe QUALE riga di ZJobRunHDR leggere alla morte del
  // figlio, e il messaggio mandato allo scheduler resterebbe «exit code 0» — vero e inutile.
  // Con `cf run-task` e con `npm run job-*` la variabile non c'e' e l'UUID lo genera questo modulo,
  // esattamente come prima.
  const runId = process.env.JOB_RUN_ID || cds.utils.uuid();
  let summary = null;
  let aborting = false;

  // Registrato PRIMA di ogni await: su CF il task puo' morire durante il bootstrap.
  const onSigterm = async () => {
    if (aborting) return;
    aborting = true;
    console.warn(`>>> [JOB ${jobCode}] SIGTERM: chiusura best-effort entro ${SIGTERM_BUDGET_MS}ms`);
    const timer = setTimeout(() => process.exit(143), SIGTERM_BUDGET_MS);
    try {
      if (summary) await summary.abort('SIGTERM');
    } catch (e) { /* best effort */ }
    clearTimeout(timer);
    process.exit(143);
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);

  let db;
  try {
    // '*' include db, srv e i modelli dei servizi esterni in cds.requires.
    // L'ORDINE conta: cds.model deve essere impostato PRIMA di cds.connect.to('db'),
    // altrimenti db.model resta undefined. (Il commento storico nei job secondo cui
    // db.entities non sarebbe invocabile in contesto standalone e' errato: srv/license.js
    // lo fa e gira dentro ogni job. Si usano comunque gli FQN come stringa perche'
    // srv.entities() e' deprecato.)
    cds.model = cds.linked(await cds.load('*'));

    // Un FQN sbagliato non fallisce a livello di modello: cade nel percorso senza modello,
    // dove UUID fill-in e conversione tipi sono saltati, e fallisce solo sul DB. Meglio
    // accorgersene subito e con un messaggio chiaro.
    for (const fqn of [E_RUN_HDR, E_RUN_POS, E_RUN_MAIL]) {
      if (!cds.model.definitions[fqn]) {
        throw new Error(`Entita' non presente nel modello: ${fqn} - eseguire cds build / cds deploy`);
      }
    }

    if (serveAll) {
      // I servizi locali (PlexService, ProductionRouting) non sono in cds.requires: vanno
      // istanziati (senza listen HTTP) prima di poterne invocare le action.
      await cds.serve('all');
    }
    db = await cds.connect.to('db');
  } catch (error) {
    // Senza modello non si puo' scrivere il run log ne' leggere i destinatari.
    console.error(`>>> [JOB ${jobCode}] bootstrap fallito:`, error);
    try {
      const { sendBootstrapFailureMail } = require('../../lib/jobNotifier');
      await sendBootstrapFailureMail({ jobCode, runId, error });
    } catch (e) {
      console.error(`>>> [JOB ${jobCode}] notifica di bootstrap fallita: ${e.message}`);
    }
    process.exit(1);
    return;
  }

  console.log(`>>> [JOB ${jobCode}] avvio (${jobLabel(jobCode)}, profilo: ${cds.env.profiles?.join(',') || 'default'})`);

  // ================================================================
  // [IS-SOURCE] M-08 (feature 0013, FR-06): il canale attivo per ciascuna area e la sua
  // ORIGINE, dichiarati all'avvio del job. È ciò che rende un pin dimenticato visibile
  // GUARDANDO, invece che scoprendolo da una lista vuota. Le sorgenti sono memoizzate e
  // dichiarano gli indirizzi da sé al primo uso: qui si stampa solo il quadro d'insieme,
  // senza connettersi (leggere la variabile non ha effetti collaterali).
  //
  // La CLASSIFICAZIONE è nell'elenco anche se nessun job la legge per conto proprio (passa da
  // `resolveAutoAssignments`, srv/lib/autoAssign.js): proprio per questo il suo primo uso può non
  // arrivare mai — `AutoAssignBomOnSync` spento su tutti i plant, o nessun componente mancante in
  // PROD_ORDER — e la dichiarazione della sorgente al primo uso non comparirebbe. È anche l'area
  // dove un pin sbagliato non dà un errore: dà componenti senza gruppo, cioè si legge come
  // customizing assente (0018, DEC-54).
  // ================================================================
  for (const [area, envVar] of [['materiali', 'PRODUCT_SOURCE'], ['ordini', 'PROD_ORDER_SOURCE'], ['cicli', 'ROUTING_SOURCE'], ['classificazione', 'CLASSIFICATION_SOURCE']]) {
    const raw = process.env[envVar] || (envVar === 'ROUTING_SOURCE' ? process.env.ROUTING_LIST_SOURCE : undefined);
    const explicit = raw !== undefined && String(raw).trim() !== '';
    const mode = explicit && String(raw).trim().toUpperCase() === 'ONPREM' ? 'ONPREM' : 'IS';
    console.log(`>>> [JOB ${jobCode}] [IS-SOURCE] area ${area}: canale ${mode}`
      + ` (${explicit ? `impostazione esplicita: ${envVar}=${String(raw).trim()}` : 'predefinito'})`);
  }

  await purgeOldRuns(db, jobCode);

  let totals = null;
  try {
    summary = await createJobSummary(jobCode, { db, runId });
    await summary.preloadRecipients();
    try {
      await main(summary, { db, runId });
    } catch (error) {
      // Il job e' morto a metà: il riepilogo di quanto fatto finora deve comunque partire.
      console.error(`>>> [JOB ${jobCode}] errore fatale:`, error);
      summary.fatal(error);
    }
    totals = await summary.finish();
  } catch (error) {
    // Nemmeno il riepilogo si e' potuto scrivere.
    console.error(`>>> [JOB ${jobCode}] riepilogo non scrivibile:`, error);
    process.exit(1);
    return;
  }

  const exitCode = exitCodeOf(totals);

  try {
    await summary.notify();
  } catch (error) {
    // Un fallimento di notifica NON cambia l'exit code.
    console.error(`>>> [JOB ${jobCode}] invio recap fallito (exit code invariato): ${error.message}`);
  }

  // [IS-CALL-LOG] Il censimento delle letture: UNA riga, e in try/catch per la stessa ragione della
  // notifica qui sopra — una diagnostica non tocca l'exit code dato allo scheduler. Sta prima del
  // `process.exit()` ed e' corta di proposito: su una pipe una scrittura grossa messa qui puo' non
  // uscire affatto.
  try {
    console.log(`>>> [JOB ${jobCode}] ${isCallLog.dumpCensus()}`);
  } catch (error) {
    console.warn(`>>> [JOB ${jobCode}] censimento delle letture non disponibile: ${error.message}`);
  }

  console.log(`>>> [JOB ${jobCode}] terminato con exit code ${exitCode}`);
  process.exit(exitCode);
}

module.exports = { runJob, purgeOldRuns };

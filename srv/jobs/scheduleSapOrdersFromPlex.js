/**
 * ============================================================================
 * [ORDER-SCHEDULED] Job ORDER_SCHEDULED — il job Plex pianificato diventa uno stato utente in SAP
 * ============================================================================
 * Feature 0046, requisito W1-11 della BBP (§8.2.2).
 *
 * Legge da Plex i job in stato `Scheduled` e lo dichiara sull'ordine di produzione SAP collegato,
 * chiamando il Function Import `TechlyCmpltOrder` — che dal 02/09/2026 imposta uno STATO UTENTE
 * informativo e non la chiusura tecnica.
 *
 * ⚠️ IL NOME DELL'INDIRIZZO MENTE, E VA SAPUTO. `TechlyCmpltOrder`, `ZMARS_PROD_ORDER_TECO` e
 * `…_ORDER_TECO_POST;v=1` si chiamano cosi' perche' nascevano come chiusura tecnica: la RFC dietro
 * quell'iFlow e' stata CORRETTA e scrive lo stato utente «pianificato». Chi legge «TECO» in questo
 * file e pensa alla chiusura tecnica sta leggendo il nome, non il comportamento. Vedi la voce `teco`
 * di `CALLS` in srv/lib/prodOrderStatusPost.js e
 * srv/external/PROD_ORDER_STATUS_POST_IS.md.
 *
 * ============================================================================
 * LA DIFFERENZA CON IL JOB GEMELLO: QUI NON C'E' UN ASSE TEMPORALE
 * ============================================================================
 * `ORDER_COMPLETE` legge una FINESTRA su `completedDateBegin`/`completedDateEnd` con punto di
 * ripresa persistito. Qui non si puo', e non e' una scelta: dei dodici parametri di query di
 * `GET /scheduling/v1/jobs` gli assi temporali sono tre coppie, e nessuna serve —
 * `completedDate*` e' l'evento del completamento, `dueDate*` e `*EarliestStartDateTime` battono su
 * campi che scriviamo NOI in creazione. Non esiste `modifiedDate`, `statusChangedDate` ne'
 * `updatedSince`, e `createdDate` c'e' solo come campo di RISPOSTA. Nessun'altra strada: delle 15
 * operazioni della Job Scheduling API solo due leggono job e nessuna restituisce transizioni; la
 * Production History non conosce `jobStatus`; delle Data Source censite nessuna elenca i job per
 * stato (le due che nominano uno stato lo SCRIVONO).
 *
 * Il rilevamento e' quindi una FOTOGRAFIA dello stato corrente:
 *
 *   GET /scheduling/v1/jobs?jobStatuses=Scheduled
 *
 * FILTRARE PER STATO NON E' UN'OTTIMIZZAZIONE: E' L'UNICO MODO DI LIMITARE LA LETTURA. Senza filtro
 * non c'e' nessun asse su cui restringere, e la risposta sarebbe l'elenco INTERO dei job del tenant.
 *
 * IL DIVIETO DEL REPO NON SI APPLICA, E VA DETTO PERCHE'. «Un filtro lato Plex farebbe MENTIRE il
 * watermark … e' la prima ottimizzazione che viene in mente guardando questi endpoint. Non si fa»
 * (PLEX_PRODUCTION_HISTORY_API_CONTRACT.md, ripreso in DEC-117). Quella regola protegge un
 * WATERMARK: un filtro fa avanzare il punto di ripresa oltre righe mai ricevute. Qui non c'e'
 * nessun watermark — non esiste un asse su cui costruirlo — quindi non c'e' niente che possa
 * mentire. Senza questa riga il prossimo lettore vede un filtro spinto e crede che la regola sia
 * stata violata.
 *
 * ============================================================================
 * LE TRE CONSEGUENZE DELLA FOTOGRAFIA
 * ============================================================================
 *  1. UN JOB CHE ENTRA ED ESCE DA `Scheduled` FRA DUE RUN NON VIENE VISTO. E' il prezzo, e non ha
 *     rimedio tecnico: non esiste un registro dei cambi. Si mitiga con la FREQUENZA e configurando
 *     piu' stati (`Scheduled;Sequenced`), perche' il criterio e' una lista.
 *  2. UN TRONCAMENTO SI AUTOGUARISCE, al contrario del gemello. La' un troncamento faceva avanzare
 *     il watermark su righe mai lette e quei completamenti si perdevano per sempre; qui la lettura
 *     e' lo stato DI ADESSO, quindi cio' che non e' entrato in questa risposta entra nella
 *     prossima. Resta da DICHIARARE — non c'e' una finestra da dimezzare — ma non e' una perdita.
 *  3. NIENTE `ZJobReadWatermark`, e non e' una dimenticanza: come in `PROD_TECO`, il punto di
 *     ripresa e' lo STATO PER JOB persistito, che rende il run idempotente per costruzione.
 *
 * ============================================================================
 * LE DUE COSE CHE ROMPONO IN SILENZIO, E CHE IL GEMELLO NON HA
 * ============================================================================
 *  A. IL FORMATO DEL PARAMETRO RIPETUTO NON E' DOCUMENTATO. Il contratto dice solo «`jobStatuses`
 *     (ripetibile)», e nel repo non esiste un solo precedente di parametro ripetuto verso la
 *     Connect API. Si manda la forma predefinita di OpenAPI — la chiave ripetuta — con la leva
 *     `PLEX_SCHEDULED_STATUS_PARAM=repeat|csv` per commutare senza un rilascio.
 *  B. GUARDIA DEL FILTRO ONORATO. Se Plex non riconoscesse la forma, il rischio non e' ricevere
 *     NIENTE: e' ricevere TUTTO, cioe' l'elenco intero dei job del tenant trattato come se fossero
 *     tutti pianificati — e questo flusso SCRIVE in SAP. Quindi ogni riga tornata deve avere un
 *     `jobStatus` DENTRO il criterio: una riga fuori criterio DIMOSTRA che il filtro e' stato
 *     ignorato, e la lettura si dichiara degradata e non si usa. E' la stessa guardia di
 *     `[PRODUCT-ROWS]` («una riga di un altro plant dimostra che `SO_PLANT` e' stato ignorato») e di
 *     `[PLANT-PAGE]` sullo `$skip` non onorato: un filtro non onorato e' piu' pericoloso di un
 *     filtro assente, perche' il chiamante ci conta.
 *
 * ============================================================================
 * UN SOLO INTERRUTTORE
 * ============================================================================
 * `ZProdOrderScheduledConfig.IsEnabled`, per plant, dal customizing. NESSUNA leva di processo: un
 * job che parte dallo scheduler deve scrivere. Chiusa la casella, il job RILEVA, scrive 'D' e lo
 * dichiara nel recap; l'arretrato parte da se' quando si accende (DEC-71).
 *
 * LA FASE B — prenotazione, POST, stato, storico, recap — E' CONDIVISA con `ORDER_COMPLETE` e vive
 * in srv/lib/orderStatusSend.js. Qui c'e' la sola fase A.
 *
 * LEVE (nessuna richiede un rilascio, tutte da impostare SIA sul modulo srv SIA sui task dello
 * scheduler — le env non si ereditano, DEC-30)
 *   PLEX_SCHEDULED_STATUS_PARAM    repeat  forma del parametro ripetuto: repeat | csv
 *   PLEX_SCHEDULED_ROWS_SUSPECT       500  oltre questo la lettura si dichiara sospetta
 *   PLEX_SCHEDULED_READ_TIMEOUT_MS  60000  scadenza della lettura; 0 = nessuna
 *   PLEX_SCHEDULED_MAX_ATTEMPTS         3  rifiuti applicativi prima di 'X'
 *   PLEX_SCHEDULED_MAX_PER_RUN          0  tetto di ordini per run; 0 = illimitato
 *   PLEX_SCHEDULED_STALE_MINUTES       30  oltre questo una prenotazione e' orfana
 *   PLEX_SCHEDULED_QUARANTINE_DAYS     30  oltre questo una quarantena non si ri-risolve
 *   PLEX_SCHEDULED_STALE_DAYS           7  da quanto una riga in attesa entra nella «coda ferma»
 *
 * Perimetro completo: grep -rn "ORDER-SCHEDULED"
 */

'use strict';

const cds = require('@sap/cds');
const { resolveActivePlants, plexGet } = require('./lib/plexJobsClient');
// [PLEX-CONN] Connessione a Plex PER PLANT (feature 0020): punto unico di risoluzione.
const { resolvePlexConnection, PlexConnectionMissing } = require('../lib/plexConnection');
// [PLEX-CALL] Le chiamate Plex si tracciano: il wrapper non ne aggiunge nessuna e ne stampa
// indirizzo, corpo e stato in `cf logs` — che per un job e' l'unico posto dove si vedono, perche'
// l'anello in memoria di isCallLog.js non copre i processi separati.
const plexCallTrace = require('../lib/plexCallTrace');
// [ORDER-SCHEDULED] Il legame al flusso `SCHEDULED` delle regole condivise.
const rules = require('../lib/prodOrderScheduled');
// [ORDER-COMPLETE] [ORDER-SCHEDULED] La fase B, condivisa col job gemello.
const send = require('../lib/orderStatusSend');
const logMsg = require('../lib/logMessage');
const { PLANT_NA: PLANT_UNKNOWN } = require('../lib/jobCodes');

const FLOW = rules.FLOW;
const JOB_CODE = FLOW.jobCode;
const OBJECT_TYPE = 'PROD_ORDER_SCHED';

const NS = rules.NS;
const E_MAPPING = `${NS}.ZProdOrderPlexMapping`;

const { STATE, cut, s } = rules;

// ---------------------------------------------------------------------------------------------
// LEVE
// ---------------------------------------------------------------------------------------------

const env = process.env;
const MAX_ATTEMPTS = rules.intEnv(env, 'PLEX_SCHEDULED_MAX_ATTEMPTS', 3);
const MAX_PER_RUN = rules.intEnv(env, 'PLEX_SCHEDULED_MAX_PER_RUN', 0);
const STALE_MINUTES = rules.intEnv(env, 'PLEX_SCHEDULED_STALE_MINUTES', 30);
const QUARANTINE_DAYS = rules.intEnv(env, 'PLEX_SCHEDULED_QUARANTINE_DAYS', 30);
const ROWS_SUSPECT = rules.intEnv(env, 'PLEX_SCHEDULED_ROWS_SUSPECT', 500);
const READ_TIMEOUT_MS = rules.intEnv(env, 'PLEX_SCHEDULED_READ_TIMEOUT_MS', 60000);
const STALE_DAYS = rules.intEnv(env, 'PLEX_SCHEDULED_STALE_DAYS', 7);

/**
 * La forma con cui si manda il parametro ripetuto.
 *
 * Solo i due valori previsti: un refuso non deve tradursi silenziosamente nell'altra forma, che e'
 * precisamente il genere di errore che costa un giro di collaudo per capirlo.
 */
const STATUS_PARAM = (() => {
  const raw = String(env.PLEX_SCHEDULED_STATUS_PARAM || '').trim().toLowerCase();
  if (raw === 'csv' || raw === 'repeat') return raw;
  if (raw) {
    console.warn(`>>> [ORDER-SCHEDULED] PLEX_SCHEDULED_STATUS_PARAM='${raw}' non riconosciuta `
      + '(valori ammessi: repeat, csv): resta \'repeat\'');
  }
  return 'repeat';
})();

const PERMANENT_MESSAGES = rules.readPermanentMessages(env);

// ---------------------------------------------------------------------------------------------
// PASSO A — LA LETTURA PER STATO
// ---------------------------------------------------------------------------------------------

/**
 * L'indirizzo della lettura. FUNZIONE PURA rispetto ai suoi argomenti.
 *
 * `repeat` e' `?jobStatuses=A&jobStatuses=B`, la forma predefinita di OpenAPI per un parametro
 * ripetibile; `csv` e' `?jobStatuses=A,B`. Il contratto non dichiara quale delle due sia, e non
 * esiste un precedente in questo repo: si manda la prima e la leva commuta.
 */
function statusPath(statuses, form = STATUS_PARAM) {
  const list = (statuses || []).map((x) => s(x)).filter(Boolean);
  if (!list.length) return '/scheduling/v1/jobs';
  if (form === 'csv') {
    return `/scheduling/v1/jobs?jobStatuses=${encodeURIComponent(list.join(','))}`;
  }
  return `/scheduling/v1/jobs?${list.map((x) => `jobStatuses=${encodeURIComponent(x)}`).join('&')}`;
}

/**
 * IL FILTRO E' STATO ONORATO? FUNZIONE PURA, ed e' la guardia B della testata.
 *
 * Se Plex non riconoscesse la forma del parametro non risponderebbe «niente»: risponderebbe TUTTO.
 * Una riga con uno stato fuori criterio e' la PROVA che il filtro e' stato ignorato — e siccome
 * questo flusso scrive in SAP, la lettura si scarta invece di essere usata.
 *
 * Le righe SENZA stato non contano come prova: `jobStatus` vuoto e' un dato mancante, non uno stato
 * diverso, e trattarlo come prova farebbe scartare una lettura buona.
 *
 * @returns {{honoured: boolean, outside: string[]}} `outside` sono gli stati fuori criterio visti,
 *   distinti: e' cio' che il recap mostra, perche' «il filtro e' stato ignorato» senza dire COSA e'
 *   tornato non si diagnostica.
 */
function filterHonoured(rows, statuses) {
  const outside = new Set();
  for (const row of rows || []) {
    const st = s(row && row.jobStatus);
    if (!st) continue;
    if (!rules.matchesStatus(st, statuses)) outside.add(st);
  }
  return { honoured: outside.size === 0, outside: [...outside].sort() };
}

/**
 * Una lettura per stato. NON LANCIA: l'esito e' un valore di ritorno.
 *
 * `plexGet` RITORNA `{ok:false}` su HTTP non-2xx ma LANCIA su errore di rete (`fetch` rigetta su
 * DNS, TLS, connessione rifiutata, abort): sono la stessa notizia — quella lettura non e' avvenuta
 * — e finiscono nello stesso ramo.
 */
async function readByStatus(get, statuses) {
  const path = statusPath(statuses);
  let r;
  try {
    r = await get(path);
  } catch (e) {
    return { ok: false, rows: [], path, status: 0, error: `errore di rete: ${e.message}` };
  }
  if (!r.ok) {
    return { ok: false, rows: [], path, status: r.status || 0, error: `HTTP ${r.status}` };
  }
  const parsed = rules.readJobRows(r.body);
  if (!parsed.recognized) {
    return {
      ok: false, rows: [], path, status: r.status || 200,
      error: 'forma della risposta non riconosciuta: non è un array né un involucro noto. NON è un '
        + 'elenco vuoto, ed è un guasto'
    };
  }
  const guard = filterHonoured(parsed.rows, statuses);
  if (!guard.honoured) {
    return {
      ok: false, rows: [], path, status: r.status, filterIgnored: true, outside: guard.outside,
      error: `il filtro per stato NON è stato onorato: sono tornate righe in ${guard.outside.join(', ')}`
    };
  }
  return {
    ok: true, rows: parsed.rows, path, status: r.status, error: '',
    suspect: rules.truncationVerdict(parsed.rows.length, ROWS_SUSPECT).suspect
  };
}

/**
 * Il passo A per un plant: rileva e persiste. NON manda niente.
 *
 * @returns {Promise<{readOk: boolean}>}
 */
async function ingestPlant(ctx, plant, cfg, creds) {
  const { db, summary, index, stats } = ctx;

  const traced = plexCallTrace.wrap({
    get: (p) => plexGet(creds, p, { timeoutMs: READ_TIMEOUT_MS }),
    post: () => { throw new Error('[ORDER-SCHEDULED] questo job non scrive su Plex'); },
    put: () => { throw new Error('[ORDER-SCHEDULED] questo job non scrive su Plex'); }
  }, { order: `PLANT/${plant}`, root: creds.baseUrl, tag: 'PLEX-CALL' });

  console.log(`>>> [ORDER-SCHEDULED] plant ${plant}: stati in criterio ${cfg.statuses.join(';')} `
    + `(forma ${STATUS_PARAM})`);

  const read = await readByStatus(traced.get, cfg.statuses);
  if (!read.ok) {
    rules.addWindowOutcome(stats, plant, { readOk: false });
    console.error(`>>> [ORDER-SCHEDULED] plant ${plant}: ${read.error}`);
    // [RUN-BLOCKED] Tutti e quattro i rami di `!read.ok` sono la stessa notizia — nessuna risposta
    // utilizzabile — e fanno chiudere il run in errore (DEC-124). Il filtro ignorato ci sta dentro
    // benche' Plex abbia risposto `200`: DEC-118 impone di SCARTARE quella lettura, e una lettura
    // scartata e' una lettura che non c'e'. Il troncamento sospetto invece resta un'attenzione, ed
    // e' qui sotto: la' la chiamata e' riuscita e non si perde niente.
    summary.scope({
      plant,
      objectKey: 'READ/SCHEDULED',
      objectType: OBJECT_TYPE,
      status: 'E',
      segments: read.filterIgnored
        // Il filtro ignorato non e' un guasto di lettura come gli altri: ha un rimedio preciso — la
        // leva della forma del parametro — e va detto, o si cerca dalla parte sbagliata.
        ? [logMsg.seg('logScheduledFilterIgnored', read.outside.join(', '))]
        : [logMsg.seg('logScheduledReadFailed', 1), logMsg.technical(read.error)]
    });
    return { readOk: false };
  }

  if (read.suspect) {
    // Non c'e' nessuna finestra da restringere: si DICHIARA e si va avanti. Niente si perde, perche'
    // la lettura e' lo stato di adesso — cio' che non e' entrato entra al prossimo run.
    rules.addWindowOutcome(stats, plant, { truncated: true });
    summary.scope({
      plant,
      objectKey: 'READ/SCHEDULED',
      objectType: OBJECT_TYPE,
      status: 'W',
      segments: [logMsg.seg('logScheduledTruncationSuspect', read.rows.length)]
    });
  }

  let persisted = 0;
  let unidentified = 0;
  for (const job of read.rows) {
    const jobStatus = s(job && job.jobStatus);
    const inCriteria = rules.matchesStatus(jobStatus, cfg.statuses);
    rules.addWindowRow(stats, plant, jobStatus, inCriteria);
    // Con il filtro onorato ogni riga e' in criterio; il controllo resta perche' una riga senza
    // stato passa la guardia (un dato mancante non e' una prova) e non deve diventare un invio.
    if (!inCriteria) continue;

    const plexJobId = s(job && job.id);
    if (!plexJobId) {
      // La chiave della tabella E' l'identita' Plex: senza `id` la riga non e' persistibile, e
      // inventare un segnaposto farebbe collidere job diversi.
      unidentified += 1;
      continue;
    }

    const res = rules.resolveJob(job, index, plant);
    rules.addResolution(stats, plant, res.kind);
    if (res.kind === 'package') continue;
    if (res.kind === 'plantMismatch') {
      summary.scope({
        plant,
        objectKey: s(job.jobNumber) || plexJobId,
        objectType: OBJECT_TYPE,
        status: 'W',
        segments: [logMsg.seg('logScheduledPlantMismatch', s(job.jobNumber), res.mappingPlant, plant)]
      });
      continue;
    }

    const quarantine = res.kind === 'quarantine';
    const state = quarantine
      ? STATE.QUARANTINE
      : (cfg.enabled ? STATE.FAILED : STATE.DETECTED);
    const segments = quarantine
      ? [logMsg.seg('logScheduledQuarantine', s(job.jobNumber) || plexJobId)]
      : (cfg.enabled
        ? [logMsg.seg('logScheduledDetected', jobStatus)]
        : [logMsg.seg('logScheduledPlantDisabled')]);

    // Una riga gia' TERMINALE non si tocca: 'A' e' fatto, 'X' si ri-arma solo a mano. Una 'P' la sta
    // trattando il passo B.
    const existing = await db.run(
      SELECT.one.from(FLOW.stateEntity).columns('State').where({ PlexJobId: plexJobId })
    );
    if (existing && rules.TERMINAL_STATES.includes(s(existing.State))) continue;
    if (existing && s(existing.State) === STATE.CLAIMED) continue;

    await send.saveState(db, {
      plexJobId,
      plant,
      plexJobNumber: s(job.jobNumber),
      plexStatus: jobStatus,
      quantity: Number(job.quantity),
      order: res.order,
      state,
      attempts: existing ? undefined : 0,
      segments
    }, FLOW);
    persisted += 1;
  }

  if (unidentified) {
    summary.scope({
      plant,
      objectKey: 'UNIDENTIFIED/SCHEDULED',
      objectType: OBJECT_TYPE,
      status: 'W',
      segments: [logMsg.seg('logScheduledNoJobId', unidentified)]
    });
  }

  console.log(`>>> [ORDER-SCHEDULED] plant ${plant}: ${read.rows.length} job letti, `
    + `${persisted} persistiti`);
  return { readOk: true };
}

// ---------------------------------------------------------------------------------------------
// IL RUN
// ---------------------------------------------------------------------------------------------

async function run(summary) {
  console.log(`>>> [JOB ScheduleSapOrdersFromPlex] avvio (profilo ${cds.env.profile || '-'})`);
  const db = await cds.connect.to('db');
  const now = new Date();
  const activePlants = await resolveActivePlants(db);

  console.log(`>>> [ORDER-SCHEDULED] configurazione: forma parametro ${STATUS_PARAM}, `
    + `soglia sospetto ${ROWS_SUSPECT}, timeout ${READ_TIMEOUT_MS}ms, tentativi ${MAX_ATTEMPTS}, `
    + `prenotazione orfana ${STALE_MINUTES}min, quarantena ${QUARANTINE_DAYS}gg`);

  if (!activePlants.size) {
    summary.noScope({ active: 0, usable: 0 });
    return { failed: 0 };
  }

  const scope = await rules.resolveScope(db, activePlants);
  for (const plant of scope.unconfigured) {
    // FAIL-CLOSED e DICHIARATO: non e' un'anomalia, e' un'informazione (DEC-39).
    summary.scope({
      plant,
      objectKey: 'CONFIG',
      objectType: OBJECT_TYPE,
      status: 'S',
      degrade: false,
      segments: [logMsg.seg('logScheduledPlantUnconfigured')]
    });
  }
  if (!scope.configured.length) {
    summary.note([logMsg.seg('logScheduledNoPlants')]);
    return { failed: 0 };
  }

  for (const plant of scope.configured) {
    if (scope.byPlant.get(plant).enabledButNoStatuses) {
      summary.scope({
        plant,
        objectKey: 'CONFIG',
        objectType: OBJECT_TYPE,
        status: 'W',
        segments: [logMsg.seg('logScheduledEnabledNoStatuses')]
      });
    }
  }

  const stats = {};

  // Il dizionario dei lotti, UNA lettura per run, indicizzato in memoria per UUID e per numero.
  const mapping = await db.run(
    SELECT.from(E_MAPPING).columns(
      'ManufacturingOrder', 'PlexJobNumber', 'PlexJobId', 'Plant', 'SplitState', 'SplitSequence'
    )
  );
  const index = rules.indexMapping(mapping);
  console.log(`>>> [ORDER-SCHEDULED] dizionario dei lotti: ${(mapping || []).length} righe, `
    + `${index.byId.size} per UUID`);

  const ctx = { db, summary, now, index, stats, queryGuard: new Set() };

  // ---- connessioni Plex, memoizzate per il run ---------------------------------------------
  const connections = new Map();
  const connFor = async (plant) => {
    const key = String(plant || '');
    if (!connections.has(key)) {
      try {
        connections.set(key, { creds: await resolvePlexConnection(key, { db }), error: null });
      } catch (e) {
        if (!(e instanceof PlexConnectionMissing)) throw e;
        connections.set(key, { creds: null, error: e });
        console.error(`>>> [PLEX-CONN] plant ${key}: nessuna connessione configurata`);
        summary.scope({
          plant: key,
          objectKey: 'PLEX_CONN',
          objectType: OBJECT_TYPE,
          segments: [logMsg.seg('logScheduledPlantNoConnection')]
        });
      }
    }
    return connections.get(key);
  };

  // ============================== PASSO A — la lettura per stato ===========================
  for (const plant of scope.configured) {
    const cfg = scope.byPlant.get(plant);
    const conn = await connFor(plant);
    if (!conn.creds) {
      rules.addWindowOutcome(stats, plant, { readOk: false });
      continue;
    }
    try {
      await ingestPlant(ctx, plant, cfg, conn.creds);
    } catch (e) {
      // Rete di sicurezza: un plant che esplode non porta via gli altri.
      // [RUN-BLOCKED] `'E'` per la stessa ragione del gemello: qui si arriva solo per un'eccezione
      // inattesa, e quel plant non ha rilevato niente (DEC-124).
      rules.addWindowOutcome(stats, plant, { readOk: false });
      console.error(`>>> [ORDER-SCHEDULED] plant ${plant}: ingest fallito: ${e.message}`);
      summary.scope({
        plant,
        objectKey: 'READ/SCHEDULED',
        objectType: OBJECT_TYPE,
        status: 'E',
        segments: [logMsg.seg('logScheduledIngestFailed'), logMsg.technical(e.message)]
      });
    }
  }

  // ============================== PASSO B — l'invio, condiviso =============================
  const { sent, deferred, failed } = await send.sendPending({
    db, summary, now, index, stats, scope,
    flow: FLOW,
    rules,
    limits: {
      maxAttempts: MAX_ATTEMPTS,
      maxPerRun: MAX_PER_RUN,
      staleMinutes: STALE_MINUTES,
      quarantineDays: QUARANTINE_DAYS,
      staleDays: STALE_DAYS
    },
    permanentMessages: PERMANENT_MESSAGES,
    objectType: OBJECT_TYPE,
    // Nessun `skipOrders`: l'eco del TECO e' del flusso gemello, e nessuna nostra scrittura rende
    // un job Plex `Scheduled`.
    queryGuard: ctx.queryGuard
  });

  // ---- le note e il recap ------------------------------------------------------------------
  for (const plant of ctx.queryGuard) {
    summary.scope({
      plant,
      objectKey: 'IFLOW_GUARD',
      objectType: OBJECT_TYPE,
      status: 'W',
      segments: [logMsg.seg('logScheduledQueryGuard')]
    });
  }
  if (deferred) {
    summary.note([logMsg.seg('logScheduledDeferred', deferred, MAX_PER_RUN)]);
  }
  for (const entry of rules.recapEntries(stats)) {
    summary.scope({
      plant: entry.plant,
      objectKey: 'SCHEDULED_RECAP',
      objectType: OBJECT_TYPE,
      status: entry.status,
      degrade: entry.degrade,
      segments: entry.segments
    });
  }
  // ULTIMA nota: `ZJobRunHDR.Message` e' String(255) e il troncamento scarta la CODA, quindi la
  // configurazione va dopo gli esiti.
  summary.note([logMsg.seg('logScheduledRunConfig', STATUS_PARAM, MAX_ATTEMPTS, QUARANTINE_DAYS)]);

  console.log(`>>> [JOB ScheduleSapOrdersFromPlex] fine: ${sent} inviati, ${failed} falliti`);
  return { failed };
}

module.exports = {
  run, ingestPlant, readByStatus, statusPath, filterHonoured,
  // per i test che le sorvegliano da fuori
  saveState: send.saveState,
  claimRow: send.claimRow
};

// Bootstrap condiviso (srv/jobs/lib/runJob.js): modello, riepilogo, recap garantito e exit code.
if (require.main === module) {
  const { runJob } = require('./lib/runJob');
  // serveAll non serve: questo job non invoca action di servizi locali, scrive solo sul db e su SAP.
  runJob({ jobCode: JOB_CODE, serveAll: false, main: (summary) => run(summary) });
}

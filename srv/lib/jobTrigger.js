/**
 * [JOB-TRIGGER] Avvio di un job batch da un endpoint HTTP, per il Job Scheduler BTP (feature 0032).
 *
 * >>> Perimetro completo: grep -rn "JOB-TRIGGER" <<<
 *
 * IL JOB GIRA IN UN PROCESSO FIGLIO, e non dentro il server web. Non e' una precauzione: e'
 * l'unica forma corretta. `srv/jobs/lib/runJob.js` fa quattro cose che dentro il server sono
 * SBAGLIATE, non solo scomode —
 *
 *     cds.model = cds.linked(await cds.load('*'))   riscrive il modello SERVITO a tutte le app
 *     await cds.serve('all')                        ri-istanzia servizi gia' serviti
 *     process.on('SIGTERM', ...)                    un handler per run, e chiude il processo
 *     process.exit(exitCode)                        UCCIDE IL COCKPIT
 *
 * — e in piu' un run in-process andrebbe eseguito staccato dal contesto della richiesta (con
 * `cds._with(undefined, ...)`, API interna) o diventerebbe UNA SOLA TRANSAZIONE per tutto il run,
 * che il divieto in testa a srv/lib/jobSummary.js esclude.
 *
 * Col `fork` il figlio e' ESATTAMENTE `npm run job-*` e `cf run-task`: un solo modo di eseguire un
 * run, non due implementazioni che possono divergere. E l'`exitCode` che `runJob` gia' calcola
 * (`TotalFailed > 0 || fatal -> 1`) e' di per se' il `success` da mandare allo scheduler.
 *
 * IL GIRO
 *   1. verdetto di ammissione e PRENOTAZIONE del job (in memoria) — sincroni, prima di ogni await;
 *   2. seconda rete sul registro dei run: una testata in 'R' recente dice che un run e' vivo;
 *   3. risposta `202 Accepted` — entro i quindici secondi dello scheduler;
 *   4. `fork` di `node srv/jobs/<file>.js` con `JOB_RUN_ID` nell'ambiente;
 *   5. alla morte del figlio: lettura di `ZJobRunHDR[runId]`, esito, UNA callback allo scheduler.
 *
 * CONTORNI CHE VANNO INSIEME.
 *
 *   - STDIO EREDITATI, NON IN PIPE. Una pipe che nessuno legge BLOCCA il figlio quando si riempie,
 *     e un job che stampa una riga per materiale la riempie. I job prefissano gia' ogni riga con
 *     `>>> [JOB <CODE>]`, quindi in `cf logs` non si perde niente. Prezzo dichiarato: il padre non
 *     puo' allegare la coda di stderr al messaggio, e per un bootstrap morto il messaggio dira'
 *     «nessuna testata di run: guardare cf logs».
 *
 *   - `execArgv: []`. Il `fork` erediterebbe gli argomenti del padre, `--inspect` compreso: il
 *     figlio proverebbe ad aprire la stessa porta del debugger e morirebbe con `EADDRINUSE`. Il
 *     guasto si vedrebbe solo in sviluppo, cioe' dove si collauda.
 *
 *   - IL `runId` LO DECIDE IL PADRE (`JOB_RUN_ID`). Senza, il padre non saprebbe QUALE riga di
 *     `ZJobRunHDR` leggere, e il messaggio allo scheduler resterebbe «exit code 0» — vero e
 *     inutile. Con `cf run-task` la variabile non c'e' e `runJob` genera l'UUID come sempre.
 *
 *   - IL SIGTERM SI INOLTRA, MA L'HANDLER SI INSTALLA SOLO CON UN FIGLIO VIVO. `@sap/cds` non
 *     registra handler di segnale: aggiungerne uno SOPPRIME l'uscita di default di Node, e il
 *     server smetterebbe di chiudersi su SIGTERM anche quando non c'e' nessun job. Quindi
 *     l'handler nasce col primo figlio e muore con l'ultimo, e in ogni caso esce da se'.
 *
 *   - LA LETTURA DEL REGISTRO E' FAIL-OPEN. Se il DB non risponde si procede: il guardiano vero e'
 *     la prenotazione in memoria, e un job che non puo' leggere il registro non potrebbe comunque
 *     fare niente — fallirebbe da solo, dichiarandolo.
 *
 * IL LOCK IN MEMORIA E' AUTOREVOLE PERCHE' `mta.yaml` FISSA `instances: 1`. Con due istanze non
 * vedrebbe piu' niente e resterebbe solo la rete sul registro. E' scritto anche accanto a
 * `instances: 1`.
 *
 * Le regole verificabili senza sistemi esterni stanno in srv/lib/jobTriggerRules.js
 * (node test/jobTriggerRules.test.js); la chiamata allo scheduler in srv/lib/jobSchedulerCallback.js.
 */

'use strict';

const cds = require('@sap/cds');
const path = require('node:path');
const { fork } = require('node:child_process');

const { jobLabel } = require('./jobCodes');
const rules = require('./jobTriggerRules');
const { updateRunLog } = require('./jobSchedulerCallback');

const TAG = '>>> [JOB-TRIGGER]';

/** FQN della testata di run. Stessa costante di srv/lib/jobSummary.js, che non la esporta. */
const E_RUN_HDR = 'avvaleplm.marsplm.sap2plex.ZJobRunHDR';

/** Quanto si aspetta un figlio dopo avergli inoltrato il SIGTERM, prima di uscire. */
const SHUTDOWN_WAIT_MS = 9000;

/** jobCode -> { runId, child, startedAt, timer, target } */
const running = new Map();

let signalHandlersInstalled = false;

// ---------------------------------------------------------------------------------------------
// segnali
// ---------------------------------------------------------------------------------------------

function onShutdownSignal(signal) {
  const codes = [...running.keys()];
  if (!codes.length) {
    process.exit(signal === 'SIGINT' ? 130 : 143);
    return;
  }
  console.warn(`${TAG} ${signal}: inoltrato a ${codes.length} job in corso (${codes.join(', ')}),`
    + ` attesa ${SHUTDOWN_WAIT_MS}ms`);
  for (const entry of running.values()) {
    try { entry.child.kill('SIGTERM'); } catch (e) { /* best effort */ }
  }
  setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), SHUTDOWN_WAIT_MS);
}

const onSigterm = () => onShutdownSignal('SIGTERM');
const onSigint = () => onShutdownSignal('SIGINT');

function installSignalForwarding() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
}

function removeSignalForwarding() {
  if (!signalHandlersInstalled || running.size) return;
  signalHandlersInstalled = false;
  process.off('SIGTERM', onSigterm);
  process.off('SIGINT', onSigint);
}

// ---------------------------------------------------------------------------------------------
// registro dei run
// ---------------------------------------------------------------------------------------------

/**
 * L'ultima testata di run del job. Fail-open: su errore torna `{ read: false }` e l'avvio procede.
 */
async function readLastRun(jobCode) {
  try {
    const db = cds.db || await cds.connect.to('db');
    const rows = await db.run(
      SELECT.from(E_RUN_HDR)
        .columns('RunId', 'Status', 'StartedAt')
        .where({ JobCode: jobCode })
        .orderBy('StartedAt desc')
        .limit(1)
    );
    return { read: true, hdr: (rows || [])[0] || null };
  } catch (e) {
    console.warn(`${TAG} ${jobCode}: registro dei run non leggibile (si procede): ${e.message}`);
    return { read: false, hdr: null };
  }
}

/** La testata scritta dal figlio. `read: false` NON e' «non c'e'»: e' «non lo so». */
async function readRunHeader(runId) {
  try {
    const db = cds.db || await cds.connect.to('db');
    const rows = await db.run(SELECT.from(E_RUN_HDR).where({ RunId: runId }));
    return { read: true, hdr: (rows || [])[0] || null };
  } catch (e) {
    console.error(`${TAG} testata ${runId} non leggibile: ${e.message}`);
    return { read: false, hdr: null };
  }
}

// ---------------------------------------------------------------------------------------------
// la callback
// ---------------------------------------------------------------------------------------------

/**
 * Dichiara l'esito allo scheduler, se e solo se sappiamo dove rispondere.
 *
 * Senza le quattro intestazioni non c'e' niente da chiamare, e non e' un errore: e' una chiamata
 * fatta a mano. Lo si scrive nel log e si va avanti.
 */
async function declareToScheduler(target, jobCode, success, message) {
  if (!target || !target.ok) {
    console.log(`${TAG} ${jobCode}: nessuna callback (intestazioni scheduler assenti). Esito: `
      + `${success ? 'OK' : 'FALLITO'} - ${message}`);
    return;
  }
  const url = rules.callbackUrl(target.host, target);
  const res = await updateRunLog({ url, success, message });
  if (res.ok) {
    console.log(`${TAG} ${jobCode}: esito dichiarato allo scheduler (run ${target.runId}, `
      + `success=${success}, tentativi ${res.attempts})`);
  } else {
    // Non c'e' un secondo canale: la verita' resta ZJobRunHDR e il recap mail. Va detto per intero,
    // perche' lato scheduler quel run rimarra' in ACK_NOT_RECVD e poi UNKNOWN.
    console.error(`${TAG} ${jobCode}: CALLBACK NON RIUSCITA dopo ${res.attempts} tentativi `
      + `(run ${target.runId}): ${res.error}. Il run resta senza esito sullo scheduler; `
      + 'la verita\' e\' in ZJobRunHDR e nel recap mail.');
  }
}

// ---------------------------------------------------------------------------------------------
// avvio
// ---------------------------------------------------------------------------------------------

function jobFilePath(jobCode) {
  return path.join(__dirname, '..', 'jobs', rules.JOB_FILES[jobCode]);
}

function spawnJob(jobCode, runId, target) {
  const file = jobFilePath(jobCode);
  const timeoutMinutes = rules.readTimeoutMinutes(process.env, jobCode);

  const child = fork(file, [], {
    cwd: cds.root || process.cwd(),
    env: { ...process.env, JOB_RUN_ID: runId },
    // Vedi l'intestazione: gli stdio si EREDITANO (una pipe non letta blocca il figlio) e gli
    // execArgv NON si ereditano (`--inspect` due volte = EADDRINUSE).
    silent: false,
    execArgv: []
  });

  const entry = { runId, child, startedAt: Date.now(), target, timedOut: false, settled: false };
  running.set(jobCode, entry);
  installSignalForwarding();

  entry.timer = setTimeout(() => {
    entry.timedOut = true;
    console.error(`${TAG} ${jobCode}: tetto di durata di ${timeoutMinutes} minuti superato, `
      + 'SIGTERM al processo');
    try { child.kill('SIGTERM'); } catch (e) { /* best effort */ }
    // runJob ha un budget di 8 secondi per chiudere la testata in 'E' e flushare le posizioni.
    entry.hardTimer = setTimeout(() => {
      console.error(`${TAG} ${jobCode}: non e' uscito dopo il SIGTERM, SIGKILL`);
      try { child.kill('SIGKILL'); } catch (e) { /* best effort */ }
    }, 12000);
  }, timeoutMinutes * 60000);

  const finish = async (exitCode, signal, spawnError) => {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    if (entry.hardTimer) clearTimeout(entry.hardTimer);
    running.delete(jobCode);
    removeSignalForwarding();

    const ms = Date.now() - entry.startedAt;
    console.log(`${TAG} ${jobCode}: processo terminato dopo ${Math.round(ms / 1000)}s `
      + `(exit ${exitCode}, segnale ${signal || '-'})`);

    let outcome;
    if (spawnError) {
      // Il figlio non e' nemmeno partito: nessuna testata da leggere, e la causa e' qui.
      outcome = {
        success: false,
        message: rules.clampMessage(`${jobLabel(jobCode)} (${jobCode}): il processo del job non e' `
          + `partito: ${spawnError.message}. File atteso: ${file}. RunId ${runId}`)
      };
    } else {
      const { read, hdr } = await readRunHeader(runId);
      outcome = rules.runOutcome({
        jobCode,
        runId,
        exitCode,
        signal,
        hdr,
        hdrReadFailed: !read,
        timedOut: entry.timedOut,
        timeoutMinutes
      });
    }

    try {
      await declareToScheduler(target, jobCode, outcome.success, outcome.message);
    } catch (e) {
      // Non deve mai diventare un unhandledRejection: con
      // `cds.env.server.shutdown_on_uncaught_errors` un errore di sistema puo' spegnere il server.
      console.error(`${TAG} ${jobCode}: callback in eccezione: ${e.message}`);
    }
  };

  child.on('error', (err) => {
    console.error(`${TAG} ${jobCode}: avvio del processo fallito: ${err.message}`);
    finish(null, null, err);
  });
  child.on('exit', (code, signal) => { finish(code, signal, null); });

  return child;
}

/**
 * Il punto unico chiamato dalle cinque action.
 *
 * Risponde SEMPRE `202` quando la richiesta e' autorizzata e il codice job e' noto — anche quando
 * l'avvio viene saltato: il `202` e' l'acknowledgement del protocollo asincrono, e il fatto che il
 * run sia stato saltato lo dice `accepted: false` piu' la callback con `success: false`. Un codice
 * job sconosciuto e' invece un errore del chiamante e resta un `400`.
 *
 * @param {string} jobCode
 * @param {object} req la cds.Request dell'action
 * @returns {Promise<{accepted:boolean, jobCode:string, runId:string, message:string}>}
 */
async function trigger(jobCode, req) {
  const httpReq = req?.http?.req;
  const headers = httpReq?.headers || req?.headers || {};
  const target = rules.callbackTargetFrom(headers);

  const maxConcurrent = rules.readMaxConcurrent(process.env);
  const staleMinutes = rules.readStaleMinutes(process.env);

  // --- 1. verdetto e PRENOTAZIONE, sincroni: fra il controllo e la prenotazione non ci deve
  //        stare nessun await, o due chiamate contemporanee passerebbero entrambe.
  const verdict = rules.admissionVerdict({
    jobCode,
    runningCodes: [...running.keys()],
    maxConcurrent,
    dbRunActive: false,
    staleMinutes
  });
  if (!verdict.admitted) {
    if (verdict.reason === 'UNKNOWN_JOB') return req.reject(400, verdict.message);
    return refuse(req, jobCode, target, verdict.message);
  }

  const runId = cds.utils.uuid();
  // Segnaposto: occupa lo slot prima del primo await. Sostituito da spawnJob con l'entry vera.
  running.set(jobCode, { runId, child: { kill() {} }, startedAt: Date.now(), target, settled: true });

  try {
    // --- 2. seconda rete: il registro dei run.
    const last = await readLastRun(jobCode);
    if (rules.isRunActive(last.hdr, new Date(), staleMinutes)) {
      running.delete(jobCode);
      const v = rules.admissionVerdict({
        jobCode, runningCodes: [], maxConcurrent, dbRunActive: true, staleMinutes
      });
      return refuse(req, jobCode, target, v.message);
    }
  } catch (e) {
    running.delete(jobCode);
    throw e;
  }

  // --- 3. risposta 202, e solo dopo il fork.
  if (req?.http?.res) req.http.res.status(202);

  console.log(`${TAG} ${jobCode}: avvio (${jobLabel(jobCode)}), RunId ${runId}, `
    + `callback ${target.ok ? `run ${target.runId}` : `NON possibile: mancano ${target.missing.join(', ')}`}`);

  // --- 4. il figlio. Fuori dal ciclo della risposta: `setImmediate` garantisce che il 202 sia
  //        gia' in volo quando il processo parte, cosi' un fork lento non mangia i 15 secondi.
  setImmediate(() => {
    try {
      spawnJob(jobCode, runId, target);
    } catch (e) {
      running.delete(jobCode);
      removeSignalForwarding();
      console.error(`${TAG} ${jobCode}: fork non riuscito: ${e.message}`);
      declareToScheduler(target, jobCode, false,
        rules.clampMessage(`${jobLabel(jobCode)} (${jobCode}): fork non riuscito: ${e.message}. RunId ${runId}`)
      ).catch(() => {});
    }
  });

  return {
    accepted: true,
    jobCode,
    runId,
    message: target.ok
      ? `Avvio accettato. L'esito sara' dichiarato allo scheduler sul run ${target.runId}.`
      : 'Avvio accettato. Nessuna callback allo scheduler: intestazioni assenti '
        + `(${target.missing.join(', ')}). L'esito e' in ZJobRunHDR e nel recap mail.`
  };
}

/** Avvio saltato: `202` col motivo, e la callback lo dichiara come run fallito. */
function refuse(req, jobCode, target, message) {
  if (req?.http?.res) req.http.res.status(202);
  console.warn(`${TAG} ${jobCode}: avvio SALTATO - ${message}`);
  setImmediate(() => {
    declareToScheduler(target, jobCode, false, rules.clampMessage(message)).catch(() => {});
  });
  return { accepted: false, jobCode, runId: '', message };
}

/** Solo per diagnostica e collaudo. */
function runningJobs() {
  return [...running.entries()].map(([jobCode, e]) => ({
    jobCode, runId: e.runId, startedAt: new Date(e.startedAt).toISOString()
  }));
}

module.exports = { trigger, runningJobs, E_RUN_HDR, SHUTDOWN_WAIT_MS };

/**
 * [JOB-TRIGGER] Regole PURE dell'avvio di un job batch dal Job Scheduler BTP (feature 0032).
 *
 * >>> Perimetro completo: grep -rn "JOB-TRIGGER" <<<
 *
 * COSA GOVERNA QUESTO MODULO. Il Job Scheduling Service di BTP chiama un endpoint dell'app e
 * aspetta la risposta per QUINDICI SECONDI. Oltre quel tetto la chiamata e' «long-running» e il
 * contratto cambia: l'applicazione risponde `202 Accepted`, avvia il lavoro, e a lavoro finito
 * dichiara l'esito con la Update Job Run Log —
 * `PUT /scheduler/jobs/{jobId}/schedules/{scheduleId}/runs/{runId}` con `{success, message}`.
 * Senza quella PUT il run resta `ACK_NOT_RECVD` e diventa `UNKNOWN`: lo scheduler non sa se il job
 * e' andato bene, e chi guarda il dashboard non lo sa nemmeno lui.
 *
 * I cinque job durano minuti, quindi siamo SEMPRE nel caso asincrono. Non c'e' un ramo sincrono.
 *
 * QUI DENTRO STA CIO' CHE SI PUO' VERIFICARE SENZA SISTEMI ESTERNI: quale file avvia quale job, le
 * quattro intestazioni che rendono possibile la callback, la forma dell'indirizzo a cui tornare, la
 * decisione di ammettere o rifiutare un avvio, e la derivazione di `success` e del messaggio
 * dall'exit code piu' la testata di run. Nessun `cds`, nessuna rete, nessun orologio — `now` arriva
 * da fuori. L'orchestrazione (fork, watchdog, lettura del DB, chiamata HTTP) sta in
 * srv/lib/jobTrigger.js e srv/lib/jobSchedulerCallback.js.
 *
 * DUE REGOLE CHE SEMBRANO DETTAGLI E NON LO SONO.
 *
 *   1. `success` VIENE DALL'EXIT CODE, non dal fatto che il job abbia risposto. `runJob` calcola
 *      gia' l'exit code (`TotalFailed > 0 || fatal -> 1`) ed e' lo stesso segnale che un CF task
 *      darebbe allo scheduler: usarne un altro — per esempio «la PUT e' partita, quindi va bene» —
 *      tingerebbe di verde un run fallito, che e' il difetto piu' insidioso di tutti perche' NON SI
 *      VEDE. Un run che nessuno guarda e' un run che non c'e'.
 *
 *   2. UN AVVIO RIFIUTATO SI DICHIARA. Lo scheduler conosce solo vero e falso: un run saltato
 *      perche' il precedente e' ancora in corso non ha una terza casella. Va in `success: false`
 *      col motivo scritto per intero, altrimenti e' indistinguibile da un run mai partito.
 *
 * E UNA CHE E' UN CONTORNO DEL PROTOCOLLO: le quattro intestazioni ci sono TUTTE o non c'e' la
 * callback. Una chiamata a mano (curl di collaudo, prova dopo un deploy) non ne ha nessuna, ed e'
 * legittima: il run parte e la risposta lo dichiara. «Non ho potuto chiedere» non e' «mi ha detto
 * no» (DEC-63) — quindi la mancanza si NOMINA, non si tace e non fa fallire l'avvio.
 *
 * Collaudo: node test/jobTriggerRules.test.js
 */

'use strict';

const { JOB_CODES, RUN_STATUS_LABELS, jobLabel } = require('./jobCodes');

/**
 * Quale file avvia quale job. E' la mappa che rende il `fork` possibile, e l'unica copia:
 * `package.json` ha gli stessi cinque percorsi negli script `job-*`, e il test verifica che questa
 * mappa copra ESATTAMENTE i codici di jobCodes.js — ne' uno in meno (un job non avviabile) ne' uno
 * in piu' (un codice inventato qui che nessun recap conosce).
 */
const JOB_FILES = Object.freeze({
  MAT_SYNC: 'syncMaterialsToPlex.js',
  ROUTING_SYNC: 'syncRoutingsToPlex.js',
  PROD_ORDER: 'createPlexProductionOrders.js',
  PROD_CONF: 'postProdOrderConfirmation.js',
  PROD_TECO: 'closeTecoPlexJobs.js',
  // [ORDER-COMPLETE] feature 0045
  ORDER_COMPLETE: 'completeSapOrdersFromPlex.js',
  // [ORDER-SCHEDULED] feature 0046
  ORDER_SCHEDULED: 'scheduleSapOrdersFromPlex.js'
});

/**
 * Le quattro intestazioni con cui lo scheduler dice CHI sta chiamando e DOVE rispondere.
 * Sono documentate in «Asynchronous Mode» e sono i path parameter della Update Job Run Log.
 */
const SCHEDULER_HEADERS = Object.freeze({
  jobId: 'x-sap-job-id',
  scheduleId: 'x-sap-job-schedule-id',
  runId: 'x-sap-job-run-id',
  host: 'x-sap-scheduler-host'
});

/** Tetto del testo mandato allo scheduler. Il contratto non ne dichiara uno: questo e' nostro. */
const MESSAGE_MAX = 2000;

/** Valori di default dei tre parametri d'ambiente. */
const MAX_CONCURRENT_DEFAULT = 2;
const STALE_MINUTES_DEFAULT = 120;
const TIMEOUT_MINUTES_DEFAULT = 240;

/**
 * Etichette degli stati della testata. NON sono definite qui: vengono da jobCodes.js, che le
 * condivide col recap mail. La prima stesura ne aveva una copia con quattro voci su sei, e il
 * messaggio allo scheduler diceva «stato non riconosciuto» sui due stati che contavano di piu' —
 * 'N' (nessun lavoro da fare) e 'X' (retry esauriti).
 */
const STATUS_LABEL = RUN_STATUS_LABELS;

// ---------------------------------------------------------------------------------------------
// parametri d'ambiente
// ---------------------------------------------------------------------------------------------

/**
 * Legge un intero POSITIVO da una variabile d'ambiente, ricadendo sul default per qualunque
 * valore non utilizzabile — zero e negativi compresi. Nessuno dei tre parametri ha uno zero
 * sensato: un tetto di concorrenza zero non farebbe partire nulla, una soglia di stantio zero
 * dichiarerebbe morto un run appena avviato, e un tetto di durata zero lo ucciderebbe subito.
 */
function readPositiveInt(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Quanti job possono girare insieme. E' un guardiano di MEMORIA, non di correttezza. */
function readMaxConcurrent(env) {
  return readPositiveInt(env, 'JOB_TRIGGER_MAX_CONCURRENT', MAX_CONCURRENT_DEFAULT);
}

/** Oltre quanti minuti una testata rimasta in 'R' e' un run morto e non un run in corso. */
function readStaleMinutes(env) {
  return readPositiveInt(env, 'JOB_TRIGGER_STALE_MIN', STALE_MINUTES_DEFAULT);
}

/**
 * Tetto di durata, con override PER JOB (`JOB_TRIGGER_TIMEOUT_MIN_MAT_SYNC`): una
 * sincronizzazione completa dei materiali e la chiusura tecnica non durano lo stesso tempo, e un
 * tetto unico taglierebbe la prima o non proteggerebbe dalla seconda.
 */
function readTimeoutMinutes(env, jobCode) {
  const perJob = readPositiveInt(env, `JOB_TRIGGER_TIMEOUT_MIN_${jobCode}`, 0);
  if (perJob > 0) return perJob;
  return readPositiveInt(env, 'JOB_TRIGGER_TIMEOUT_MIN', TIMEOUT_MINUTES_DEFAULT);
}

// ---------------------------------------------------------------------------------------------
// la callback
// ---------------------------------------------------------------------------------------------

/**
 * Estrae dalle intestazioni HTTP il bersaglio della callback.
 *
 * TUTTE O NIENTE: con tre intestazioni su quattro non si puo' comporre l'indirizzo, e mandare la
 * PUT «indovinando» la quarta significherebbe aggiornare il run di qualcun altro. Chi manca viene
 * elencato in `missing`, cosi' la risposta e il log possono NOMINARLO.
 *
 * @param {object} headers intestazioni in minuscolo, come le consegna express
 * @returns {{ok:boolean, missing:string[], jobId?:string, scheduleId?:string, runId?:string, host?:string}}
 */
function callbackTargetFrom(headers) {
  const h = headers || {};
  const missing = [];
  const out = {};
  for (const [field, header] of Object.entries(SCHEDULER_HEADERS)) {
    const raw = h[header] ?? h[header.toUpperCase()];
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!value) missing.push(header);
    else out[field] = value;
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, missing: [], ...out };
}

/** Il path della Update Job Run Log. Ogni segmento e' codificato: sono valori di terzi. */
function callbackPath({ jobId, scheduleId, runId }) {
  return '/scheduler/jobs/' + encodeURIComponent(jobId)
    + '/schedules/' + encodeURIComponent(scheduleId)
    + '/runs/' + encodeURIComponent(runId);
}

/**
 * Indirizzo completo della PUT.
 *
 * L'host arriva dall'intestazione `x-sap-scheduler-host` — cioe' dallo scheduler stesso, che sa
 * qual e' la sua rotta su questo landscape meglio di quanto la sappia il nostro binding — e senza
 * intestazione si ripiega su `credentials.url`. Lo schema si aggiunge se manca: il valore
 * osservato lo porta, ma una stringa nuda non deve diventare un path relativo.
 */
function callbackUrl(host, target) {
  const raw = String(host || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  const base = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return base + callbackPath(target);
}

// ---------------------------------------------------------------------------------------------
// ammissione di un avvio
// ---------------------------------------------------------------------------------------------

/** Istante oltre il quale una testata in 'R' e' un run morto. */
function staleCutoff(now, minutes) {
  return new Date(new Date(now).getTime() - minutes * 60000).toISOString();
}

/**
 * La testata letta dal DB rappresenta un run ANCORA VIVO?
 *
 * Solo 'R' conta, e solo se abbastanza recente. Una 'R' vecchia e' il marcatore documentato di
 * un'esecuzione morta (srv/jobs/lib/runJob.js): senza la finestra bloccherebbe quel job per
 * sempre, cioe' un SIGKILL una volta e mai piu' un run.
 */
function isRunActive(hdr, now, minutes) {
  if (!hdr || hdr.Status !== 'R') return false;
  const startedAt = hdr.StartedAt;
  if (!startedAt) return false;
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return false;
  return started >= new Date(staleCutoff(now, minutes)).getTime();
}

/**
 * Si avvia o no?
 *
 * @param {object} p
 * @param {string} p.jobCode
 * @param {string[]} p.runningCodes  i job in corso IN QUESTO PROCESSO
 * @param {number} p.maxConcurrent
 * @param {boolean} p.dbRunActive    esito di isRunActive sulla testata piu' recente del job
 * @param {number} p.staleMinutes    serve solo a scrivere il motivo
 * @returns {{admitted:boolean, reason:string, message:string}}
 */
function admissionVerdict({ jobCode, runningCodes = [], maxConcurrent, dbRunActive = false, staleMinutes }) {
  if (!JOB_CODES.has(jobCode)) {
    return {
      admitted: false,
      reason: 'UNKNOWN_JOB',
      message: `Codice job sconosciuto: ${jobCode}.`
    };
  }
  if (runningCodes.includes(jobCode)) {
    return {
      admitted: false,
      reason: 'ALREADY_RUNNING',
      message: `${jobLabel(jobCode)} (${jobCode}): un'esecuzione e' ancora in corso su questa `
        + 'istanza, l\'avvio e\' stato saltato. Nessun dato e\' stato perso: il prossimo avvio '
        + 'schedulato riprende da dove il run in corso si fermera\'.'
    };
  }
  if (dbRunActive) {
    return {
      admitted: false,
      reason: 'DB_RUN_ACTIVE',
      message: `${jobLabel(jobCode)} (${jobCode}): il registro dei run ha una testata in stato 'R' `
        + `piu' recente di ${staleMinutes} minuti, quindi un'esecuzione risulta in corso. L'avvio e' `
        + 'stato saltato. Se quella testata e\' il residuo di un processo morto, si sblocca da se\' '
        + `dopo ${staleMinutes} minuti.`
    };
  }
  if (runningCodes.length >= maxConcurrent) {
    return {
      admitted: false,
      reason: 'MAX_CONCURRENT',
      message: `${jobLabel(jobCode)} (${jobCode}): raggiunto il tetto di ${maxConcurrent} job `
        + `contemporanei (in corso: ${runningCodes.join(', ')}). L'avvio e' stato saltato.`
    };
  }
  return { admitted: true, reason: 'OK', message: '' };
}

// ---------------------------------------------------------------------------------------------
// esito di un run
// ---------------------------------------------------------------------------------------------

function clampMessage(text) {
  const s = String(text ?? '');
  return s.length <= MESSAGE_MAX ? s : `${s.slice(0, MESSAGE_MAX - 3)}...`;
}

/**
 * L'esito da mandare allo scheduler.
 *
 * `success` e' l'exit code e nient'altro: e' il segnale che `runJob` calcola e quello che un CF
 * task darebbe. Un tetto di durata scattato e un processo ucciso da un segnale sono fallimenti
 * anche quando l'exit code non c'e' (`null`).
 *
 * Il messaggio invece si costruisce da CIO' CHE SI E' RIUSCITI A LEGGERE, e i due casi non si
 * confondono: con la testata si scrivono i contatori, SENZA la testata si dice che la testata non
 * c'e'. Una testata assente non e' «zero record trattati» — e' un job morto prima di poterne
 * scrivere una, cioe' un bootstrap fallito, e la differenza e' tutta la diagnosi.
 *
 * @param {object} p
 * @param {string} p.jobCode
 * @param {string} p.runId
 * @param {number|null} p.exitCode
 * @param {string|null} [p.signal]
 * @param {object|null} [p.hdr]      la riga di ZJobRunHDR, se leggibile
 * @param {boolean} [p.timedOut]
 * @param {number} [p.timeoutMinutes]
 * @param {boolean} [p.hdrReadFailed] la lettura della testata e' FALLITA (diverso da «non c'e'»)
 * @returns {{success:boolean, message:string}}
 */
function runOutcome({
  jobCode, runId, exitCode, signal = null, hdr = null,
  timedOut = false, timeoutMinutes = 0, hdrReadFailed = false
}) {
  const success = !timedOut && exitCode === 0;
  const parts = [`${jobLabel(jobCode)} (${jobCode})`];

  if (timedOut) {
    parts.push(`INTERROTTO dal tetto di durata di ${timeoutMinutes} minuti`);
  } else if (exitCode === null || exitCode === undefined) {
    parts.push(`terminato dal segnale ${signal || 'ignoto'}`);
  } else {
    parts.push(`exit code ${exitCode}`);
  }

  if (hdr) {
    const status = hdr.Status || '?';
    parts.push(`esito ${status} (${STATUS_LABEL[status] || 'stato non riconosciuto'})`);
    parts.push(
      `trattati ${hdr.TotalProcessed ?? 0}`
      + ` · ok ${hdr.TotalOk ?? 0}`
      + ` · attenzioni ${hdr.TotalWarning ?? 0}`
      + ` · errori ${hdr.TotalFailed ?? 0}`
      + ` · esauriti ${hdr.TotalExhausted ?? 0}`
      + ` · saltati ${hdr.TotalSkipped ?? 0}`
    );
    if (hdr.Message) parts.push(hdr.Message);
    if (hdr.FatalMessage) parts.push(`ERRORE FATALE: ${hdr.FatalMessage}`);
  } else if (hdrReadFailed) {
    parts.push('testata di run NON LEGGIBILE: il run puo' + "' essere andato a buon fine, "
      + 'il registro non risponde. Guardare ZJobRunHDR e cf logs');
  } else {
    parts.push('NESSUNA testata di run scritta: il job e\' morto prima del bootstrap '
      + '(modello, binding o DB). Guardare cf logs');
  }

  parts.push(`RunId ${runId}`);
  return { success, message: clampMessage(parts.join(' · ')) };
}

// ---------------------------------------------------------------------------------------------
// forma delle credenziali del binding
// ---------------------------------------------------------------------------------------------

/**
 * Che forma ha il binding dello scheduler?
 *
 * Le due forme documentate non si assomigliano e non si possono trattare insieme:
 *
 *   binding-secret : uaa.clientid + uaa.clientsecret, token su uaa.url, Basic auth
 *   x509           : uaa.clientid + uaa.certificate + uaa.key, token su uaa.certurl, in mTLS
 *
 * SAP RACCOMANDA i certificati, quindi il secondo ramo non e' teorico: trattare solo il primo
 * significherebbe un canale che funziona in collaudo e tace il giorno del binding «giusto».
 *
 * Quando NESSUNA delle due e' riconosciuta si ELENCANO LE CHIAVI TROVATE e si nomina quella
 * attesa — solo i nomi, mai i valori. E' lo stesso rimedio di DEC-93 sul canale mail, e nasce
 * dalla stessa constatazione: il binding lo crea qualcun altro, quindi il guasto probabile non e'
 * «non esiste» ma «esiste coi nomi che non mi aspetto».
 *
 * @returns {{kind:'binding-secret'|'x509'|'unknown', tokenUrl?:string, clientId?:string, message?:string}}
 */
function credentialShape(credentials) {
  const uaa = credentials?.uaa;
  if (!uaa || typeof uaa !== 'object') {
    const found = credentials && typeof credentials === 'object' ? Object.keys(credentials) : [];
    return {
      kind: 'unknown',
      message: 'Binding jobscheduler senza la sezione `uaa`: nessun modo di ottenere un token. '
        + `Chiavi trovate in credentials: ${found.length ? found.join(', ') : '(nessuna)'}.`
    };
  }
  if (uaa.clientid && uaa.certificate && uaa.key && uaa.certurl) {
    return { kind: 'x509', tokenUrl: `${String(uaa.certurl).replace(/\/+$/, '')}/oauth/token`, clientId: uaa.clientid };
  }
  if (uaa.clientid && uaa.clientsecret && uaa.url) {
    return { kind: 'binding-secret', tokenUrl: `${String(uaa.url).replace(/\/+$/, '')}/oauth/token`, clientId: uaa.clientid };
  }
  return {
    kind: 'unknown',
    message: 'Binding jobscheduler in una forma non riconosciuta: attesi `uaa.clientid` con '
      + '`uaa.clientsecret` + `uaa.url` (binding-secret), oppure con `uaa.certificate` + `uaa.key` '
      + `+ \`uaa.certurl\` (x509). Chiavi trovate in credentials.uaa: ${Object.keys(uaa).join(', ') || '(nessuna)'}.`
  };
}

module.exports = {
  JOB_FILES,
  SCHEDULER_HEADERS,
  MESSAGE_MAX,
  MAX_CONCURRENT_DEFAULT,
  STALE_MINUTES_DEFAULT,
  TIMEOUT_MINUTES_DEFAULT,
  STATUS_LABEL,
  readPositiveInt,
  readMaxConcurrent,
  readStaleMinutes,
  readTimeoutMinutes,
  callbackTargetFrom,
  callbackPath,
  callbackUrl,
  staleCutoff,
  isRunActive,
  admissionVerdict,
  clampMessage,
  runOutcome,
  credentialShape
};

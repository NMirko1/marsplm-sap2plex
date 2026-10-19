/**
 * Orchestrazione dello spacchettamento di un ordine di produzione su Plex (feature 0012).
 *
 * Espone quattro funzioni, tutte invocate dalle due action di `PlexService`
 * (srv/cat-service.js) e da nessun altro punto d'ingresso (FR-01):
 *
 *   readSplitInfo   lettura completa per la finestra + ripetizione della verifica R0 sui
 *                   pacchetti in stato incerto ('U'/'P'), che è ciò che rende l'action di
 *                   lettura NON side-effect-free (contratto §3)
 *   executeSplit    la sequenza P0…P6 con il rollback compensativo R0…R3 (FR-20, FR-42)
 *   executeComplete sanatoria «Completa»  = R0 + P6           (FR-26)
 *   executeRestore  sanatoria «Ripristina» = R0? + R1 + R2 + R3 (FR-26)
 *
 * NESSUNA delle quattro lancia mai: un'eccezione imprevista è catturata e tradotta in un
 * esito applicativo (riga della matrice, `status` 'E', chiave `splitUnexpectedError`), con
 * il dettaglio tecnico nei passi. È la stessa politica di sendMail (DEC-15) per la stessa
 * ragione: un esito non visibile è peggiore di un esito brutto. Ed è il presupposto di TD-4,
 * che vieta `req.error` dopo P0 — un `req.error` dentro un'action rollerebbe indietro anche
 * le righe di log su cui si basa l'intera sanatoria di FR-26.
 *
 * TD-5: ogni scrittura di stato (marcatura, riga pacchetto, log, rilascio del lock) avviene
 * in TRANSAZIONE AUTONOMA e viene committata man mano. È il principio di DEC-11 («il run log
 * è scritto e committato man mano») applicato a un'action invece che a un job.
 *
 * Tutto ciò che è deciso da una regola e non da una chiamata sta in srv/lib/splitRules.js,
 * puro e testato (test/splitRules.test.js). Qui c'è la sequenza, non le regole.
 *
 * Dipendenze per INJECTION (`deps`), così che il modulo sia collaudabile con un doppio del
 * client Plex e del servizio S/4:
 *   db                  connessione CDS al db (transazioni autonome)
 *   plex                { get(path), post(path, body), put(path, body) } già legati alle
 *                       credenziali del customizing e al timeout di TD-6
 *   localize            (key, params[]) => testo localizzato (DEC-07)
 *   writeMappingAndLog  la funzione del job, usata con { skipMapping: true } (FR-27)
 *   loadOrderDetails    (order) => Promise<void>, carica operazioni/componenti SAP (P5)
 *   align               (order, steps, jobNumber) => Promise<void> (P5)
 *   addBom              (order, steps, jobId, jobNumber, partId) =>
 *                         Promise<{ok, created, failures, message}> (P5a, feature 0025).
 *                         OPZIONALE: se assente il passo non gira e il comportamento e' quello di
 *                         prima della 0025 — e' la proprieta' che rende sicuro il rollback.
 *   user                identità di chi ha richiesto l'operazione (FR-03, FR-27)
 *   decimals            decimali ammessi nella quantità (PLEX_SPLIT_QTY_DECIMALS)
 *   lockTtlMs           TTL dell'esclusiva (PLEX_SPLIT_LOCK_TTL_MS)
 *   maxCodeProbes       tentativi di ricerca di un codice libero (PLEX_SPLIT_MAX_CODE_PROBES)
 *   now / uuid          iniettabili per i test
 */

'use strict';

const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE } = cds.ql;

const {
  SPLIT_STATES,
  MESSAGE_KEYS,
  formatPackageCode,
  nextSplitSequence,
  validateSplitQuantity,
  isResidualSplittable,
  classifyCreateVerdict,
  decideRollback,
  resolveOutcomeRow,
  commandForResidual,
  messageKeyForResidual,
  sortPackages,
  computeMismatch,
  COMMANDS,
  COUNTED_PACKAGE_STATES,
  OPEN_RESIDUAL_STATES,
  plexTouched
} = require('./splitRules');

// [SPLIT-TRACE] Il testo di un errore Plex — stato PIU' corpo — è lo stesso in schermata, nello
// storico e nella sonda: sta nel modulo del tracciato, che non dipende da `cds`.
const { plexErrText } = require('./plexCallTrace');
// [JOB-READ] Le regole di lettura di un job su Plex (id-first, DEC-80), con il loro test:
// node test/plexJobRead.test.js
const plexJobRead = require('./plexJobRead');
// [JOB-BUILDING] Da `buildingCode` a `buildingId`: il campo dello schema `UpdateJob` che non
// mandavamo. Test: node test/plexBuildings.test.js
const plexBuildings = require('./plexBuildings');
// [PART-QUERY] Gli indirizzi del Parts API in un punto solo: il filtro e' `number`, non
// `partNumber`, che su quell'indirizzo non esiste. Test: node test/plexPartQuery.test.js
const plexPartsApi = require('./plexPartsApi');
// [LOG-MSG-I18N] `LastMessage` della riga pacchetto e' cio' che la scheda «Lotti» del dettaglio
// ordine mostra: erano frasi italiane cablate, ora sono segmenti resi alla lettura (feature 0029).
const logMsg = require('./logMessage');
const i18nMessages = require('./i18nMessages');

const NS = 'avvaleplm.marsplm.sap2plex';
const E_MAPPING = `${NS}.ZProdOrderPlexMapping`;
const E_SPLIT = `${NS}.ZProdOrderSplit`;

// [JOB-FIELDS] I campi della testata job ricavati dall'ordine SAP: regola unica e pura, condivisa
// col passo 4 del job batch.
const {
  inheritedJobFields,
  jobPutBodies,
  schedulingWindow,
  earliestStartField
} = require('./plexJobFields');

// Placeholder di creazione job: gli stessi del job batch (createPlexProductionOrders.js),
// riletti qui perché sono costanti di modulo là e il payload di P3 deve essere identico a
// quello del passo 4 del job.
const BUILDING_ID = process.env.PLEX_BUILDING_ID || null;
// [JOB-FIELDS] Non è più il valore di `jobType`: è il RIPIEGO quando l'ordine non porta l'AUART.
const JOB_TYPE = process.env.PLEX_JOB_TYPE || null;
const PRIORITY = process.env.PLEX_JOB_PRIORITY || null;
const JOB_NUMBER_PREFIX = process.env.PLEX_JOB_NUMBER_PREFIX || null;
const JOB_NUMBER_SUFFIX = process.env.PLEX_JOB_NUMBER_SUFFIX || null;
// [WC-FALSE] Default FALSE, allineato al gemello di srv/jobs/createPlexProductionOrders.js, dove
// sta la spiegazione. PLEX_USE_FIRST_APPROVED_WC=true riporta al valore precedente.
const USE_FIRST_APPROVED_WORKCENTER = (process.env.PLEX_USE_FIRST_APPROVED_WC || 'false') === 'true';

// ================================================================
// Utility
// ================================================================

/** Normalizza il body di una risposta Connect REST in array (come il job batch). */
function asArray(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  return body.value || body.results || body.data || [];
}

/** Converte una data (Date | ISO string) in ISO 8601 UTC per Plex. */
function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : d.toISOString();
  } catch (e) {
    return String(value);
  }
}

/** Numero o null, senza trasformare in 0 un valore assente. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Arrotondamento a 3 decimali (la Scale persistita), per non propagare artefatti float. */
function round3(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 1000) / 1000;
}

/** Rappresentazione testuale di un parametro di messaggio (contratto §3.2: stringhe non formattate). */
function p(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(round3(v));
  return String(v);
}

/**
 * Transazione AUTONOMA: apre e committa subito, indipendentemente dalla transazione della
 * richiesta. Serve a due cose diverse e ugualmente necessarie:
 *   - il lock (§3.4): se l'acquisizione restasse dentro la transazione della richiesta, la
 *     riga resterebbe write-locked per tutta l'esecuzione e la seconda richiesta
 *     ATTENDEREBBE invece di essere respinta (FR-15 chiede l'opposto);
 *   - lo stato residuale (TD-5): marcatura, riga pacchetto, log e rilascio devono
 *     sopravvivere a un'eccezione imprevista o alla caduta del processo a metà esecuzione.
 * Rischio noto R-06: se il runtime non committasse subito, il lock degenererebbe in attesa.
 * È il test di integrazione I-07 a verificarlo (due richieste in parallelo, la seconda
 * respinta entro un secondo).
 */
function autoTx(db, fn) {
  return db.tx({}, fn);
}

// ================================================================
// Letture di base
// ================================================================

/** Riga di mapping del lotto principale: accesso a chiave PIENA. */
async function readMainRow(deps, order) {
  return await deps.db.run(
    SELECT.one.from(E_MAPPING).where({ ManufacturingOrder: order, PlexJobNumber: order })
  );
}

/** Righe dei pacchetti dell'ordine (tutto tranne la riga del lotto principale). */
async function readPackageRows(deps, order) {
  const rows = await deps.db.run(SELECT.from(E_MAPPING).where({ ManufacturingOrder: order }));
  return (rows || []).filter((r) => r.PlexJobNumber !== order);
}

/** Riga di stato dell'ordine (marcatura, progressivo, esclusiva). */
async function readSplitRow(deps, order) {
  return await deps.db.run(SELECT.one.from(E_SPLIT).where({ ManufacturingOrder: order }));
}

/**
 * Il caso residuale APERTO dell'ordine, se c'è. Ne può esistere uno solo: finché è aperto,
 * un nuovo spacchettamento è vietato (FR-26). Se per qualunque ragione ce ne fosse più di
 * uno, si prende il primo dell'ordinamento normativo (anomali per primi, poi progressivo).
 */
function pickOpenResidual(packageRows) {
  return sortPackages(packageRows).find((r) => OPEN_RESIDUAL_STATES.has(r.SplitState)) || null;
}

/** Come sopra, leggendo dal database. Usata dall'handler per la verifica C-1. */
async function findOpenResidual(deps, order) {
  return pickOpenResidual(await readPackageRows(deps, order));
}

/**
 * UNICA funzione che cerca un lotto su Plex, in tutto il perimetro della 0012 (FR-19). Il
 * confronto sul numero è ESATTO: il codice dei pacchetti INIZIA con il numero d'ordine, e una
 * corrispondenza parziale ridurrebbe o rischedulerebbe un pacchetto credendo di operare sul
 * lotto principale.
 *
 * [JOB-READ] DEC-80: **con `jobId` si legge per identità** (`GET /scheduling/v1/jobs/{id}`) e il
 * filtro per numero resta l'autorità sull'ASSENZA. Le regole stanno in srv/lib/plexJobRead.js,
 * con il loro test; qui resta il choke-point che la 0012 prescrive. Chi non ha un id — la ricerca
 * di un codice pacchetto LIBERO e la verifica R0 dopo una POST non conclusiva — chiama senza, e
 * ottiene esattamente la lettura di prima.
 *
 * @param {object} deps
 * @param {string} jobNumber numero del lotto cercato
 * @param {string} [jobId] UUID Plex dal dizionario, quando c'è
 * @returns {{ok, found, status, error, url, via, thrown, aborted, notes}} `ok` dice se la
 *   RISPOSTA è interpretabile, `found` se il lotto esiste. I due non coincidono: `ok:true,
 *   found:null` è «accertatamente assente», `ok:false` è «non lo so».
 */
async function findJobByExactNumber(deps, jobNumber, jobId) {
  return await plexJobRead.findJob(deps.plex, { jobNumber, jobId });
}

/**
 * [JOB-READ] Il dettaglio di una lettura NON riuscita, per l'utente e per lo storico: l'errore
 * PIU' le note della lettura per id. Una lettura caduta perché l'id del dizionario punta a un
 * altro lotto e una caduta perché Plex non risponde vanno lette in modo diverso, e il testo è
 * l'unico posto in cui quella differenza arriva a chi guarda. Tetto a 255: `LastMessage` e il
 * messaggio del passo sono `String(255)`.
 */
function readDetail(probe) {
  const parts = [probe.error || 'Plex non raggiungibile'];
  if (probe.notes && probe.notes.length) parts.push(probe.notes.join('; '));
  return parts.join(' | ').slice(0, 255);
}

// ================================================================
// Esclusiva sull'ordine (FR-15, §3.4)
// ================================================================

/**
 * Acquisizione dell'esclusiva: una UPDATE CONDIZIONALE, atomica per definizione, dove il
 * numero di righe modificate È il verdetto. Ottimistica e non pessimistica perché FR-15
 * chiede che la seconda richiesta sia «respinta senza modificare nulla e senza attendere»:
 * un lock pessimistico la metterebbe in attesa per la durata di sette chiamate HTTP.
 *
 * @returns {Promise<string|null>} il token, oppure null se l'esclusiva è di qualcun altro.
 */
async function acquireSplitLock(deps, { order, plant, owner }) {
  const token = deps.uuid();
  const nowIso = deps.now().toISOString();
  const staleBefore = new Date(deps.now().getTime() - deps.lockTtlMs).toISOString();

  const claim = () => autoTx(deps.db, (tx) => tx.run(
    UPDATE(E_SPLIT)
      .set({ LockToken: token, LockedAt: nowIso, LockedBy: owner, UpdatedAt: nowIso })
      .where`ManufacturingOrder = ${order} and (LockToken is null or LockedAt < ${staleBefore})`
  ));

  // Furto di un lock scaduto: evento raro, va poter essere indagato.
  const previous = await readSplitRow(deps, order);
  if (previous && previous.LockToken && previous.LockedAt && new Date(previous.LockedAt).toISOString() < staleBefore) {
    console.warn(
      `>>> [SPLIT] ordine ${order}: lock scaduto di ${previous.LockedBy || '(ignoto)'} ` +
      `(acquisito ${previous.LockedAt}) rubato dopo il TTL di ${deps.lockTtlMs} ms`
    );
  }

  let n = await claim();
  if (!n) {
    // Riga assente (primo tentativo su questo ordine) -> INSERT già lockata. Due richieste
    // simultanee: una vince, l'altra prende duplicate-key e ritenta la UPDATE.
    try {
      await autoTx(deps.db, (tx) => tx.run(INSERT.into(E_SPLIT).entries({
        ManufacturingOrder: order,
        Plant: plant || null,
        IsSplit: false,
        LastSequence: 0,
        LockToken: token,
        LockedAt: nowIso,
        LockedBy: owner,
        CreatedAt: nowIso,
        UpdatedAt: nowIso
      })));
      return token;
    } catch (e) {
      n = await claim();
    }
  }
  return n === 1 ? token : null;
}

/**
 * Rilascio: sempre in `finally`, sempre autonomo, sempre CONDIZIONATO AL TOKEN, così non si
 * rilascia mai un lock che nel frattempo è stato rubato per scadenza.
 */
async function releaseSplitLock(deps, { order, token }) {
  if (!token) return;
  const nowIso = deps.now().toISOString();
  try {
    await autoTx(deps.db, (tx) => tx.run(
      UPDATE(E_SPLIT)
        .set({ LockToken: null, LockedAt: null, LockedBy: null, UpdatedAt: nowIso })
        .where({ ManufacturingOrder: order, LockToken: token })
    ));
  } catch (e) {
    console.error(`>>> [SPLIT] rilascio esclusiva fallito per l'ordine ${order}: ${e.message}`);
  }
}

// ================================================================
// Contesto di esecuzione: passi, parametri dei messaggi, esito
// ================================================================

/**
 * Parametri POSIZIONALI di ogni messaggio (contratto §5.3). L'ordine è normativo e i testi
 * i18n usano {0}, {1}, … in questa sequenza: cambiarlo qui significa cambiare il contratto.
 */
function messageParamsFor(key, c) {
  switch (key) {
    case MESSAGE_KEYS['M-01']: return [p(c.order)];
    case MESSAGE_KEYS['M-02']: return [p(c.plant)];
    case MESSAGE_KEYS['M-03']: return [p(c.missingJobNumber || c.mainJobNumber)];
    case MESSAGE_KEYS['M-04']: return [];
    case MESSAGE_KEYS['M-05']: return [p(c.mainQty), p(c.unit)];
    case MESSAGE_KEYS['M-06']: return [p(c.mainQty), p(c.unit)];
    case MESSAGE_KEYS['M-08']: return [p(c.unit), p(c.decimals)];
    case MESSAGE_KEYS['M-09']: return [p(c.mainQty), p(c.unit)];
    case MESSAGE_KEYS['M-10']: return [p(c.mainJobNumber), p(c.mainQty), p(c.unit), p(c.pkgCode), p(c.pkgQty)];
    case MESSAGE_KEYS['M-11']: return [];
    case MESSAGE_KEYS['M-12']: return [p(c.order)];
    case MESSAGE_KEYS['M-13']: return [p(c.plannedPkgCode), p(c.pkgCode)];
    case MESSAGE_KEYS['M-14']: return [p(c.order), p(c.packageCount)];
    case MESSAGE_KEYS['M-15']: return [p(c.sapQty), p(c.unit), p(c.lotSum)];
    case MESSAGE_KEYS['M-16']: return [p(c.pkgCode), p(c.mainQtyBefore), p(c.unit), p(c.detail)];
    case MESSAGE_KEYS['M-16a']: return [p(c.mainQtyBefore), p(c.unit), p(c.mainJobNumber)];
    case MESSAGE_KEYS['M-16b']: return [
      p(c.mainJobNumber), p(c.mainQty), p(c.unit), p(c.mainQtyBefore),
      p(round3((num(c.mainQtyBefore) || 0) - (num(c.mainQty) || 0)))
    ];
    case MESSAGE_KEYS['M-17']: return [p(c.mainJobNumber)];
    case MESSAGE_KEYS['M-18']: return [p(c.pkgCode), p(c.pkgQty), p(c.unit)];
    case MESSAGE_KEYS['M-19']: return [p(c.pkgCode)];
    case MESSAGE_KEYS['M-20']: return [p(c.pkgCode), p(c.order)];
    case MESSAGE_KEYS['M-21']: return [];
    case MESSAGE_KEYS['M-22']: return [p(c.pkgCode), p(c.pkgQty), p(c.unit)];
    case MESSAGE_KEYS['M-22a']: return [p(c.pkgQty), p(c.unit), p(c.pkgCode)];
    case MESSAGE_KEYS['M-23']: return [p(c.detail)];
    case MESSAGE_KEYS['M-24']: return [p(c.mainJobNumber), p(c.mainQtyBefore), p(c.unit), p(c.pkgCode)];
    case MESSAGE_KEYS['M-25']: return [p(c.pkgCode), p(c.order)];
    case MESSAGE_KEYS['M-26']: return [p(c.pkgCode), p(c.pkgQty), p(c.unit), p(c.mainQty)];
    case MESSAGE_KEYS['M-27']: return [p(c.pkgCode), p(c.mainQty), p(c.unit)];
    case MESSAGE_KEYS['M-28']: return [p(c.pkgCode), p(c.pkgQty), p(c.unit)];
    default: return [];
  }
}

/** Stato mutabile di un'esecuzione: i passi eseguiti e i valori che alimentano i messaggi. */
function newRun(deps, order) {
  return {
    steps: [],
    seq: 0,
    c: {
      order: order.ManufacturingOrder,
      plant: order.ProductionPlant,
      unit: order.ProductionUnit || null,
      decimals: deps.decimals,
      sapQty: num(order.TotalQuantity),
      mainJobNumber: order.ManufacturingOrder,
      mainJobId: null,
      mainQty: null,
      mainQtyBefore: null,
      pkgCode: null,
      plannedPkgCode: null,
      codeChanged: false,
      pkgId: null,
      pkgQty: null,
      pkgState: null,
      packageCount: 0,
      lotSum: null,
      isSplit: false,
      residualOpen: false,
      offeredCommand: COMMANDS.NONE,
      detail: '',
      missingJobNumber: null
    },
    /**
     * Registra un passo. `status`: 'S' riuscito, 'W' riuscito con riserva, 'E' fallito con
     * certezza, 'U' esito NON CONCLUSIVO. La distinzione E/U è il cuore della feature.
     */
    rec(step, status, extra = {}) {
      this.seq += 1;
      const s = {
        seq: this.seq,
        step,
        status,
        httpStatus: Number(extra.httpStatus) || 0,
        verdict: extra.verdict || '',
        message: extra.message === undefined || extra.message === null ? '' : String(extra.message).slice(0, 255),
        // Solo per lo storico: NON escono nella risposta dell'action (DEC-10, C-3).
        request: extra.request === undefined ? null : extra.request,
        response: extra.response === undefined ? null : extra.response
      };
      if (extra.messageKey) s.messageKey = extra.messageKey;
      if (extra.codeChanged) s.codeChanged = true;
      // [JOB-SORT-SPLIT] Passo ACCESSORIO: resta nella traccia e ESCE dal semaforo «HTTP nnn» della
      // riga di storico (DEC-38). Non basta che sia l'ultimo passo della sequenza: la posizione
      // cambia al primo passo aggiunto dopo, e il semaforo cambierebbe in silenzio.
      if (extra.aux) s.aux = true;
      this.steps.push(s);
      return s;
    }
  };
}

/** Compone l'esito finale a partire dalla riga della matrice risolta dai passi. */
function finish(deps, run, { row, status, messageKey, extraKey, data }) {
  const params = messageParamsFor(messageKey, run.c);
  let message = deps.localize(messageKey, params);
  // Riga C2: successo con la NOTA sul codice cambiato in coda al testo (matrice §6).
  if (extraKey) {
    message = `${message} ${deps.localize(extraKey, messageParamsFor(extraKey, run.c))}`;
  }
  // [LOG-MSG-I18N] I SEGMENTI dello stesso messaggio, e qui non costano niente: la chiave i18n e i
  // suoi parametri posizionali questa funzione li ha gia' in mano — e' il disegno della 0012. La
  // riga C2 diventa due segmenti invece di due frasi concatenate, che e' la stessa cosa detta
  // meglio. `message` resta perche' e' il testo che l'action restituisce al cockpit, dove viene
  // mostrato subito e nella lingua della richiesta.
  const segments = [
    ...(messageKey ? [{ c: messageKey, p: params }] : []),
    ...(extraKey ? [{ c: extraKey, p: messageParamsFor(extraKey, run.c) }] : [])
  ];
  return {
    status,
    row: row || '',
    messageKey,
    messageParams: params,
    message: String(message).slice(0, 500),
    segments,
    steps: run.steps,
    data: data || {}
  };
}

/** Esito di uno SPLIT: riga della matrice dai passi + campi di risposta del contratto §4.2. */
function finishSplit(deps, run) {
  const outcome = resolveOutcomeRow(run.steps);
  const c = run.c;
  const extraKey = outcome.row === 'C2' ? MESSAGE_KEYS['M-13'] : null;
  return finish(deps, run, {
    row: outcome.row,
    status: outcome.status,
    messageKey: outcome.messageKey,
    extraKey,
    data: splitResponseData(c)
  });
}

/** Campi di risposta comuni alle tre modalità di scrittura (contratto §4.2). */
function splitResponseData(c) {
  return {
    ManufacturingOrder: c.order,
    Unit: c.unit,
    MainJobNumber: c.mainJobNumber,
    MainJobQuantity: round3(c.mainQty),
    MainQtyBefore: round3(c.mainQtyBefore),
    PackageJobNumber: c.pkgCode,
    PlannedPackageJobNumber: c.plannedPkgCode,
    CodeChanged: !!c.codeChanged,
    PackageJobId: c.pkgId,
    PackageQuantity: round3(c.pkgQty),
    PackageState: c.pkgState,
    IsSplit: !!c.isSplit,
    PackageCount: c.packageCount || 0,
    ResidualOpen: !!c.residualOpen,
    OfferedCommand: c.offeredCommand || COMMANDS.NONE
  };
}

/** Aggiorna nel contesto il conteggio dei pacchetti e lo stato residuale, dal database. */
async function refreshOrderState(deps, run) {
  const c = run.c;
  const [packages, splitRow] = await Promise.all([
    readPackageRows(deps, c.order),
    readSplitRow(deps, c.order)
  ]);
  c.packageCount = packages.filter((r) => COUNTED_PACKAGE_STATES.has(r.SplitState)).length;
  const residual = pickOpenResidual(packages);
  c.residualOpen = !!residual;
  c.offeredCommand = residual ? commandForResidual(residual.SplitState) : COMMANDS.NONE;
  c.isSplit = !!(splitRow && splitRow.IsSplit);
  return { packages, splitRow, residual };
}

/** Scrive la riga di storico del tentativo (FR-27) in transazione autonoma. */
async function writeHistory(deps, run, order, status, segments) {
  try {
    await autoTx(deps.db, (tx) => deps.writeMappingAndLog(
      tx,
      order,
      {
        status,
        // [LOG-MSG-I18N] Solo i segmenti: `writeMappingAndLog` rende da se' lo snapshot testuale.
        // Passare anche un `message` significherebbe due sorgenti per la stessa colonna.
        segments,
        // Forma attesa dallo storico: `status` è il codice HTTP, non l'esito del passo.
        // [JOB-SORT-SPLIT] `aux` va inoltrato: `serializeSteps` lo filtra già per calcolare
        // `ResponseStatus`, e senza questa riga il semaforo della riga di storico diventerebbe
        // quello dell'ordinamento invece che quello dell'operazione (DEC-38).
        steps: run.steps.map((s) => ({
          step: `${s.step} [${s.status}${s.verdict ? ' ' + s.verdict : ''}]`,
          request: s.request,
          status: s.httpStatus,
          response: s.response === null ? s.message : s.response,
          ...(s.aux ? { aux: true } : {})
        })),
        plex: {}
      },
      { skipMapping: true }
    ));
    return true;
  } catch (e) {
    console.error(`>>> [SPLIT] storico non scrivibile per l'ordine ${run.c.order}: ${e.message}`);
    run.rec('LOG', 'E', { message: `storico non scrivibile: ${e.message}` });
    return false;
  }
}

// ================================================================
// readSplitInfo — apertura della finestra (contratto §3)
// ================================================================

/**
 * Tutto ciò che serve ad aprire la finestra, senza che l'utente debba aprire Plex.
 * NON è side-effect-free: quando trova un pacchetto in stato incerto ('U'/'P') ripete la
 * verifica su Plex e, se Plex risponde, TRANSITA la riga a 'L' o 'R' (FR-26, variante V5).
 * È la ragione per cui è un'action e non una function.
 */
async function readSplitInfo(deps, { order, materialDescription = '' }) {
  const run = newRun(deps, order);
  const c = run.c;
  const data = {
    ManufacturingOrder: c.order,
    Material: order.Material || '',
    MaterialDescription: materialDescription || '',
    ProductionPlant: c.plant || '',
    Unit: c.unit || '',
    SapOrderQuantity: round3(c.sapQty),
    QuantityDecimals: deps.decimals,
    MainJobFound: false,
    MainJobNumber: c.order,
    MainJobId: '',
    MainJobQuantity: null,
    MainJobDueDate: '',
    ReferenceQuantity: null,
    LotSum: null,
    HasMismatch: false,
    IsSplit: false,
    PackageCount: 0,
    NextPackageCode: '',
    CanSplit: false,
    OfferedCommand: COMMANDS.NONE,
    ResidualJobNumber: '',
    packages: []
  };

  try {
    const mainRow = await readMainRow(deps, c.order);
    let packages = await readPackageRows(deps, c.order);
    const splitRow = await readSplitRow(deps, c.order);

    data.IsSplit = !!(splitRow && splitRow.IsSplit);
    data.ReferenceQuantity = round3(splitRow ? splitRow.ReferenceQuantity : null);

    // --- ripetizione della verifica sugli stati incerti ('U'/'P') -----------------
    // È l'unico effetto di questa action, ed è un avvicinamento alla verità: si accerta
    // che cosa esista davvero su Plex e si transita la riga allo stato corrispondente.
    for (const pkg of packages) {
      if (pkg.SplitState !== SPLIT_STATES.UNCERTAIN && pkg.SplitState !== SPLIT_STATES.PENDING) continue;
      // [JOB-READ] L'id c'è solo se la POST aveva risposto: una riga 'P' è pre-inserita PRIMA di
      // quella chiamata, quindi qui `PlexJobId` è spesso vuoto e si legge per numero (DEC-80).
      const probe = await findJobByExactNumber(deps, pkg.PlexJobNumber, pkg.PlexJobId);
      if (!probe.ok) continue;                                   // ancora non conclusiva: si resta 'U'/'P'
      const next = probe.found ? SPLIT_STATES.TO_LINK : SPLIT_STATES.TO_RESTORE;
      const patch = {
        SplitState: next,
        UpdatedAt: deps.now().toISOString(),
        ...messageFields([logMsg.seg(probe.found
          ? 'logSplitRecheckExists'
          : 'logSplitRecheckAbsent')])
      };
      if (probe.found && probe.found.id) patch.PlexJobId = probe.found.id;
      try {
        await autoTx(deps.db, (tx) => tx.run(
          UPDATE(E_MAPPING).set(patch)
            .where({ ManufacturingOrder: c.order, PlexJobNumber: pkg.PlexJobNumber })
        ));
        Object.assign(pkg, patch);
      } catch (e) {
        console.error(`>>> [SPLIT] transizione di stato non scritta per ${pkg.PlexJobNumber}: ${e.message}`);
      }
    }

    packages = sortPackages(packages);
    data.packages = packages.map((r) => ({
      PackageJobNumber: r.PlexJobNumber,
      PackageJobId: r.PlexJobId || '',
      SplitSequence: Number(r.SplitSequence) || 0,
      Quantity: round3(r.Quantity),
      MainQtyBefore: round3(r.MainQtyBefore),
      SplitState: r.SplitState || '',
      CreatedAt: r.CreatedAt || null,
      UpdatedAt: r.UpdatedAt || null,
      // [LOG-MSG-I18N] Reso nella lingua della richiesta. Su una riga senza segmenti — scritta
      // prima della 0029 — resta il testo salvato: e' il fallback, non un difetto.
      LastMessage: renderLastMessage(r, deps.locale)
    }));
    data.PackageCount = packages.filter((r) => COUNTED_PACKAGE_STATES.has(r.SplitState)).length;

    // --- ordine mai condiviso con Plex (FR-02) ------------------------------------
    if (!mainRow || !mainRow.PlexJobId) {
      c.detail = 'nessuna riga di mapping per il lotto principale';
      return finish(deps, run, {
        row: '', status: 'E', messageKey: MESSAGE_KEYS['M-01'], data
      });
    }
    data.MainJobId = mainRow.PlexJobId;

    // --- stato reale del lotto principale su Plex (FR-05, FR-19) ------------------
    // [JOB-READ] Per l'id salvato alla creazione, con il numero come autorità sull'assenza (DEC-80).
    const mainProbe = await findJobByExactNumber(deps, c.order, mainRow.PlexJobId);
    if (!mainProbe.ok) {
      // Plex non raggiungibile all'apertura: la finestra si apre in sola lettura.
      c.detail = readDetail(mainProbe);
      return finish(deps, run, { row: '', status: 'E', messageKey: MESSAGE_KEYS['M-23'], data });
    }
    if (!mainProbe.found) {
      return finish(deps, run, { row: '', status: 'E', messageKey: MESSAGE_KEYS['M-03'], data });
    }

    const job = mainProbe.found;
    c.mainQty = num(job.quantity);
    c.mainJobId = job.id || mainRow.PlexJobId;
    data.MainJobFound = true;
    data.MainJobId = c.mainJobId || '';
    data.MainJobQuantity = round3(c.mainQty);
    // Stringa ISO 8601 così come restituita da Plex: non riformattata di proposito (C-5).
    data.MainJobDueDate = job.dueDate === undefined || job.dueDate === null ? '' : String(job.dueDate);

    const mismatch = computeMismatch({ sapQty: c.sapQty, mainQty: c.mainQty, packages });
    data.LotSum = mismatch.sum;
    data.HasMismatch = mismatch.mismatch;
    c.lotSum = mismatch.sum;

    // --- codice previsto del prossimo pacchetto (FR-16, FR-18) --------------------
    const seq = nextSplitSequence({
      lastSequence: splitRow ? splitRow.LastSequence : 0,
      usedSequences: packages.map((r) => r.SplitSequence)
    });
    data.NextPackageCode = seq ? formatPackageCode(c.order, seq) : '';

    // --- caso residuale aperto: sanatoria, non nuovo spacchettamento (FR-26) ------
    const residual = pickOpenResidual(packages);
    if (residual) {
      c.pkgCode = residual.PlexJobNumber;
      c.pkgQty = num(residual.Quantity);
      data.ResidualJobNumber = residual.PlexJobNumber;
      data.OfferedCommand = commandForResidual(residual.SplitState);
      const key = messageKeyForResidual(residual.SplitState);
      return finish(deps, run, {
        row: residual.SplitState === SPLIT_STATES.TO_LINK ? 'H' : (key === MESSAGE_KEYS['M-28'] ? 'E4' : 'E3'),
        status: 'W', messageKey: key, data
      });
    }

    if (!seq) {
      return finish(deps, run, { row: '', status: 'E', messageKey: MESSAGE_KEYS['M-12'], data });
    }
    if (!isResidualSplittable(c.mainQty, deps.decimals)) {
      return finish(deps, run, { row: '', status: 'E', messageKey: MESSAGE_KEYS['M-09'], data });
    }

    data.CanSplit = true;
    data.OfferedCommand = COMMANDS.SPLIT;
    // Nessun messaggio in apertura nominale: non c'è nulla da comunicare.
    return { status: 'S', row: '', messageKey: '', messageParams: [], message: '', steps: [], data };
  } catch (e) {
    console.error(`>>> [SPLIT] readSplitInfo fallita per l'ordine ${c.order}: ${e.stack || e.message}`);
    c.detail = e.message;
    run.rec('READ', 'E', { message: e.stack || e.message });
    return finish(deps, run, { row: '', status: 'E', messageKey: MESSAGE_KEYS['M-23'], data });
  }
}

// ================================================================
// executeSplit — P0…P6 con rollback R0…R3 (FR-20, FR-42)
// ================================================================

async function executeSplit(deps, { order, quantityRaw }) {
  const run = newRun(deps, order);
  const c = run.c;
  let token = null;

  try {
    // ---- A5: il lotto principale deve esistere nel dizionario (FR-02) -----------
    const mainRow = await readMainRow(deps, c.order);
    if (!mainRow || !mainRow.PlexJobId) {
      run.rec('A5', 'E', { messageKey: MESSAGE_KEYS['M-01'], message: 'ordine mai condiviso con Plex' });
      await refreshOrderState(deps, run);
      return finishSplit(deps, run);
    }

    // ---- A6: stato REALE del lotto principale su Plex (FR-05, FR-14, FR-19) -----
    // [JOB-READ] Per l'id salvato alla creazione (DEC-80): `mainRow.PlexJobId` è già stato
    // verificato non vuoto in A5, che è ciò che distingue «mai condiviso» da «non leggibile».
    const mainProbe = await findJobByExactNumber(deps, c.order, mainRow.PlexJobId);
    if (!mainProbe.ok) {
      c.detail = readDetail(mainProbe);
      run.rec('A6', 'E', {
        httpStatus: mainProbe.status, messageKey: MESSAGE_KEYS['M-23'],
        message: `lettura del lotto principale non riuscita: ${c.detail}`
      });
      await refreshOrderState(deps, run);
      return finishSplit(deps, run);
    }
    if (!mainProbe.found) {
      run.rec('A6', 'E', {
        httpStatus: mainProbe.status, messageKey: MESSAGE_KEYS['M-03'],
        message: 'lotto principale non presente su Plex (match esatto)'
      });
      await refreshOrderState(deps, run);
      return finishSplit(deps, run);
    }
    const mainJob = mainProbe.found;
    c.mainJobId = mainJob.id || mainRow.PlexJobId;
    c.mainQty = num(mainJob.quantity);
    c.mainQtyBefore = c.mainQty;
    // TD-8: la dueDate rinviata nel PUT è quella LETTA DAL JOB, non quella dell'ordine SAP.
    // Lo spacchettamento non deve riportare dentro Plex una data che qualcuno ha cambiato lì.
    const dueDate = mainJob.dueDate === undefined ? null : mainJob.dueDate;
    // [JOB-FIELDS] DEC-77: la stessa regola estesa agli altri quattro campi di testata. Il
    // contratto `UpdateJob` ha `jobType` OBBLIGATORIO — un PUT senza è `400 ARGUMENT_INVALID`,
    // ed è ciò che fermava P1 — e tre opzionali che un PUT che li omette azzera in silenzio.
    // Si calcola UNA volta qui, sulla lettura di A6, e alimenta P1, P3d e R1: il pacchetto non
    // riapplica la regola dell'ordine, copia il padre.
    const inherited = inheritedJobFields(mainJob, { order, fallback: JOB_TYPE });

    // [JOB-WINDOW] Il vincolo di inizio ereditato dal padre si tiene solo se e' una finestra vera.
    // Il padre ha `earliestStartDateTime` uguale alla `dueDate` — inizio e fine pianificati SAP
    // coincidono — e uno scheduler a rovescio con ampiezza zero non ha su cosa calcolare. Era anche
    // una delle ipotesi sul `500 Data is Null` del 20/08/2026: non era la causa (difetto Plex,
    // corretto il 27/08), ma la regola non dipendeva da quella. Si filtra QUI, una volta, perche'
    // `inherited` alimenta P1, P3d e R1.
    const win = schedulingWindow({ start: inherited.earliestStartDateTime, due: dueDate });
    if (!win.send) delete inherited.earliestStartDateTime;
    console.log(`>>> [JOB-WINDOW] ordine ${c.order}: ${win.note}`);

    // ---- A8: nessun caso residuale aperto (FR-26) -------------------------------
    const state = await refreshOrderState(deps, run);
    if (state.residual) {
      c.pkgCode = state.residual.PlexJobNumber;
      c.pkgQty = num(state.residual.Quantity);
      run.rec('A8', 'E', {
        messageKey: messageKeyForResidual(state.residual.SplitState),
        message: `caso residuale aperto sul pacchetto ${state.residual.PlexJobNumber} (stato ${state.residual.SplitState})`
      });
      return finishSplit(deps, run);
    }

    // ---- A8b: la residua è ancora spacchettabile in sé (M-09) -------------------
    if (!isResidualSplittable(c.mainQty, deps.decimals)) {
      run.rec('A8b', 'E', {
        messageKey: MESSAGE_KEYS['M-09'],
        message: `quantità residua ${c.mainQty} non ulteriormente divisibile`
      });
      return finishSplit(deps, run);
    }

    // ---- A9: rivalidazione della quantità sui valori del MOMENTO (FR-14) --------
    const v = validateSplitQuantity({ raw: quantityRaw, residual: c.mainQty, decimals: deps.decimals });
    if (!v.ok) {
      // q >= R alla conferma significa che la situazione è cambiata da quando la finestra
      // è stata aperta (a video la stessa regola era già stata applicata): il messaggio
      // giusto in questo momento è M-06, che riporta la residua aggiornata.
      const key = v.code === 'M-05' ? MESSAGE_KEYS['M-06'] : MESSAGE_KEYS[v.code];
      run.rec('A9', 'E', { messageKey: key, message: `quantità non valida (${v.code}): ${quantityRaw}` });
      return finishSplit(deps, run);
    }
    const q = v.quantity;
    c.pkgQty = q;

    // ---- A9b: progressivo disponibile (FR-18) ----------------------------------
    // Verificato PRIMA di toccare qualunque cosa, così l'esaurimento dei progressivi resta
    // la riga A della matrice ("niente è stato modificato") e non un fallimento a metà.
    const seq0 = nextSplitSequence({
      lastSequence: state.splitRow ? state.splitRow.LastSequence : 0,
      usedSequences: state.packages.map((r) => r.SplitSequence)
    });
    if (!seq0) {
      run.rec('A9b', 'E', { messageKey: MESSAGE_KEYS['M-12'], message: 'progressivi esauriti (9999)' });
      return finishSplit(deps, run);
    }
    c.plannedPkgCode = formatPackageCode(c.order, seq0);

    // ---- A9c: il partId con cui creare il pacchetto (FR-22) ---------------------
    // Il pacchetto nasce con lo STESSO materiale del lotto principale. L'id della part si
    // prende dal dizionario o dal job appena letto; solo se mancano entrambi si interroga
    // Plex, perché senza partId la creazione non è possibile.
    let partId = mainRow.PlexPartId || mainJob.partId || null;
    // [JOB-BUILDING] Se la part la leggiamo comunque, ci prendiamo anche il suo building: è il
    // secondo anello della catena di A9e. Se il partId era già noto non si legge niente in più.
    let partBuildingCode = '';
    if (!partId) {
      try {
        // [PART-QUERY] `number`, non `partNumber`: quel parametro su questo indirizzo non
        // esiste, Plex lo ignorava e rispondeva con l'intero catalogo del tenant.
        const path = plexPartsApi.partByNumberPath(order.Material);
        const r = await deps.plex.get(path);
        const part = asArray(r.body).find((x) => x && plexPartsApi.numberOf(x) === order.Material);
        partId = (part ? plexPartsApi.idOf(part) : '') || null;
        partBuildingCode = (part && (part.buildingCode || part.building)) || '';
        run.rec('A9c', partId ? 'S' : 'E', {
          httpStatus: r.status, request: { url: path },
          message: partId ? `partId risolto da Plex: ${partId}` : `part ${order.Material} non trovata su Plex`,
          messageKey: partId ? undefined : MESSAGE_KEYS['M-23']
        });
      } catch (e) {
        run.rec('A9c', 'E', { messageKey: MESSAGE_KEYS['M-23'], message: `lettura part fallita: ${e.message}` });
      }
      if (!partId) {
        c.detail = `part ${order.Material} non risolvibile su Plex: impossibile creare il pacchetto`;
        return finishSplit(deps, run);
      }
    }

    // ---- A9d: il job type con cui aggiornare il lotto principale (DEC-77) -------
    // Gemello di A9c, e per la stessa ragione: `jobType` è obbligatorio nello schema `UpdateJob`,
    // quindi senza di esso il PUT di P1 non è costruibile. Verificato QUI, prima di P0, così
    // l'esito resta la riga A («niente è stato modificato»): scoprirlo in P1 significherebbe la
    // riga B, con la marcatura IsSplit già scritta e da rimuovere.
    if (!inherited.jobType) {
      c.detail = `job type non determinabile per l'ordine ${c.order}: né il lotto principale su Plex`
        + ', né l\'AUART dell\'ordine, né PLEX_JOB_TYPE lo dichiarano';
      run.rec('A9d', 'E', { messageKey: MESSAGE_KEYS['M-23'], message: c.detail });
      return finishSplit(deps, run);
    }

    // ---- A9e: [JOB-BUILDING] il building della testata --------------------------
    // `buildingId` è l'unico campo dello schema `UpdateJob` che il progetto non mandava, ed era
    // l'unico valore nullo della riga che Plex restituiva (`buildingId: null`, `buildingCode: ""`) —
    // sullo stesso job in cui la GET per id rispondeva 200 e il PUT `500 Data is Null`. Il sospetto
    // era ragionevole e sbagliato: il difetto era di Plex, corretto il 27/08/2026. Ma il campo va
    // mandato lo stesso, e per una ragione che non dipende da quel caso: un PUT è il modello intero
    // (DEC-77), quindi ciò che non si manda si AZZERA.
    //
    // NON è un gate: se il building non si risolve la sequenza PROSEGUE senza quel campo, cioè col
    // corpo di prima. Bloccare qui vorrebbe dire far dipendere lo spacchettamento da un dato di
    // setup di Plex sulla base di una causa che il messaggio d'errore non nomina.
    if (!inherited.buildingId) {
      const b = await plexBuildings.resolveBuildingId(deps.plex, {
        parentBuildingId: mainJob.buildingId,
        partBuildingCode,
        tenantKey: deps.plexTenant
      });
      if (b.id) inherited.buildingId = b.id;
      // Stato 'W' e non 'E'/'U' di proposito: `resolveOutcomeRow` manda in riga A qualunque passo
      // `A*` FALLITO (splitRules.js, `stepFailed` = 'E' | 'U'), e un building non risolto non deve
      // fermare lo spacchettamento. Nessun `httpStatus`, quindi non tinge il semaforo del cockpit.
      run.rec('A9e', b.id ? 'S' : 'W', { message: b.note });
    }

    // ---- P0a: esclusiva (FR-15) ------------------------------------------------
    token = await acquireSplitLock(deps, { order: c.order, plant: c.plant, owner: deps.user });
    if (!token) {
      run.rec('P0', 'E', { messageKey: MESSAGE_KEYS['M-11'], message: 'esclusiva non ottenuta' });
      await refreshOrderState(deps, run);
      return finishSplit(deps, run);
    }

    try {
      // ---- P0b: marcatura + quantità di riferimento ----------------------------
      const nowIso = deps.now().toISOString();
      try {
        const fresh = await readSplitRow(deps, c.order);
        await autoTx(deps.db, (tx) => tx.run(UPDATE(E_SPLIT).set({
          IsSplit: true,
          Plant: c.plant || (fresh ? fresh.Plant : null),
          // La quantità di riferimento si fissa al PRIMO spacchettamento e non si aggiorna
          // più: è il termine di paragone della quadratura (FR-30).
          ReferenceQuantity: fresh && fresh.ReferenceQuantity !== null && fresh.ReferenceQuantity !== undefined
            ? fresh.ReferenceQuantity : c.mainQty,
          ReferenceUnit: fresh && fresh.ReferenceUnit ? fresh.ReferenceUnit : c.unit,
          LastAttemptAt: nowIso,
          LastAttemptBy: deps.user,
          UpdatedAt: nowIso
        }).where({ ManufacturingOrder: c.order })));
        c.isSplit = true;
        run.rec('P0', 'S', {
          message: `esclusiva acquisita, IsSplit=true, ReferenceQuantity=${p(c.mainQty)}`
        });
      } catch (e) {
        c.detail = e.message;
        run.rec('P0', 'E', { messageKey: MESSAGE_KEYS['M-23'], message: `marcatura non scritta: ${e.message}` });
        await refreshOrderState(deps, run);
        await writeHistory(deps, run, order, 'E', [{ c: MESSAGE_KEYS['M-23'], p: [p(e.message)] }]);
        return finishSplit(deps, run);
      }

      // ---- P1: riduzione del lotto principale a R - q --------------------------
      const newMainQty = round3(c.mainQty - q);
      // [JOB-FIELDS] DEC-77: la testata del lotto principale si rimanda INTERA, così come è stata
      // letta in A6. La quantità è l'unica cosa che cambia.
      // [JOB-PUT] Due tentativi: modello intero, e sul solo 5xx i tre campi obbligatori. Vedi
      // `jobPutBodies` in srv/lib/plexJobFields.js per il perché e per cosa il ripiego azzera.
      const put1 = await putJobHeader(deps, run, {
        stepName: 'P1',
        what: 'lotto principale',
        jobId: c.mainJobId,
        bodies: jobPutBodies(inherited, { dueDate, quantity: newMainQty })
      });
      if (put1.thrown) {
        // Esito non conclusivo: la riduzione POTREBBE essere avvenuta. Non si crea nulla e
        // si rimuove la marcatura: senza pacchetti la somma dei lotti non può in nessun caso
        // superare la quantità di riferimento (riga B della matrice).
        c.detail = put1.thrown.message;
        run.rec('P1', 'U', {
          request: put1.request,
          message: `PUT lotto principale senza risposta: ${put1.thrown.message}`
        });
      } else if (!put1.ok) {
        c.detail = plexErrText(put1.r, 'PUT lotto principale');
        run.rec('P1', 'E', {
          httpStatus: put1.status, request: put1.request, response: put1.r.body, message: c.detail
        });
      } else {
        run.rec('P1', 'S', {
          httpStatus: put1.status, request: put1.request, response: put1.r.body,
          message: `quantity ${p(c.mainQty)} -> ${p(newMainQty)}${clearedNote(put1)}`
        });
        c.mainQty = newMainQty;
      }

      const p1 = run.steps.find((s) => s.step === 'P1');
      if (p1.status !== 'S') {
        await unmarkIfNoPackages(deps, run);
        // [ORDER-SORT-ON-WRITE] Su un P1 senza risposta la riduzione POTREBBE essere avvenuta: si
        // riordina. Su un P1 rifiutato no — `sortIfPlexTouched` lo decide da sola.
        const sort = await sortIfPlexTouched(deps, run);
        await refreshOrderState(deps, run);
        const out = finishSplit(deps, run);
        await writeHistory(deps, run, order, out.status, out.segments);
        return withSort(out, sort);
      }

      // ---- P2: rischedulazione del lotto principale (FR-21) --------------------
      await backwardsSchedule(deps, run, 'P2', c.mainJobId, 'lotto principale');

      // ---- P3: codice libero, pre-insert, creazione ----------------------------
      const created = await createPackage(deps, run, { order, seq0, partId, dueDate, quantity: q, inherited });

      if (!created.proceed) {
        // Rollback compensativo (FR-42): R0 ha già deciso dentro createPackage.
        if (created.decision === 'COMPENSATE') {
          await compensate(deps, run, { dueDate, inherited });
        } else {
          // UNCERTAIN: non si compensa. È l'unico caso in cui il sistema accetta
          // consapevolmente un ammanco, per l'asimmetria del danno (FR-42, §3.6).
          await setPackageState(deps, run, SPLIT_STATES.UNCERTAIN, 'E', [logMsg.seg('logSplitCreateUnverified')]);
          c.pkgState = SPLIT_STATES.UNCERTAIN;
        }
        // [ORDER-SORT-ON-WRITE] P1 e' riuscito, quindi la lista di lavoro e' cambiata comunque:
        // compensata (R1/R2 hanno riscritto e rischedulato il principale) o incerta (il pacchetto
        // potrebbe esistere). Dopo la compensazione, che e' l'ultima scrittura.
        const sort = await sortIfPlexTouched(deps, run);
        await refreshOrderState(deps, run);
        const out = finishSplit(deps, run);
        await writeHistory(deps, run, order, out.status, out.segments);
        return withSort(out, sort);
      }

      c.pkgId = created.jobId;

      // ---- P4: schedulazione del pacchetto (FR-21, FR-22) ----------------------
      await backwardsSchedule(deps, run, 'P4', c.pkgId, `pacchetto ${c.pkgCode}`);

      // ---- P5a: i componenti extra dell'ordine nella distinta del pacchetto (0025) ----
      //
      // [ORDER-BOM-ADD] Un pacchetto e' un job NUOVO sulla stessa part, quindi nasce con la distinta
      // della part e NON eredita i componenti che l'ODP ha in piu' rispetto al ciclo standard: quelli
      // il lotto principale li ha ricevuti con una scrittura sul proprio job, e ogni pacchetto ha
      // bisogno della sua. Senza questo passo un ordine spacchettato avrebbe il lotto principale
      // giusto e i pacchetti no, e la differenza si vedrebbe solo aprendo Plex.
      //
      // Il PIANO si calcola una volta per ordine e si riusa (`order._bomAddPlan`, dentro `addBom`):
      // i pacchetti nascono dalla stessa part e hanno gli stessi componenti.
      //
      // Non ferma niente, come P4 e P5: un pacchetto gia' creato non si annulla per un passo
      // accessorio. Concorre pero' ad `accessoryFailed` qui sotto, cioe' lascia il pacchetto in
      // stato INCOMPLETE — perche' una distinta a cui manca un componente e' esattamente il difetto
      // che questa feature esiste per evitare.
      if (deps.addBom) {
        try {
          if (!order.components) await deps.loadOrderDetails(order);
          const bomSteps = [];
          const res = await deps.addBom(order, bomSteps, c.pkgId, c.pkgCode, partId);
          run.rec('P5a', res.ok ? 'S' : 'W', {
            httpStatus: res.ok ? 200 : 0,
            request: { jobNumber: c.pkgCode },
            response: bomSteps,
            message: res.message
              || `${res.created} componenti extra aggiunti alla distinta del pacchetto`
          });
        } catch (e) {
          run.rec('P5a', 'W', {
            request: { jobNumber: c.pkgCode },
            message: `componenti extra non aggiunti: ${e.message}`
          });
        }
      }

      // ---- P5: allineamento di fasi e distinta del pacchetto (FR-22) -----------
      try {
        // [ORDER-BOM-ADD] Condizionale: P5a puo' averli gia' letti, e `loadOrderDetails` rilegge
        // sempre da SAP. Su un ordine da N pacchetti erano N letture identiche.
        if (!order.components) await deps.loadOrderDetails(order);
        const alignSteps = [];
        await deps.align(order, alignSteps, c.pkgCode);
        // [JOB-OP-ALIGN] Il conteggio delle operazioni NON viene piu' da `order.operations`, che
        // sono quelle SAP e dal 27/08/2026 non c'entrano piu' con questo passo: il confronto e' fra
        // l'albero Plex dell'ordine e cio' che Plex ha messo sul lotto. Il numero vero lo dichiara
        // la riga di riepilogo del 6.3, e leggerlo da li' e' cio' che impedisce alle due frasi di
        // divergere di nuovo.
        const opsRecap = alignSteps.find((s) => s.step === '6.3 allineamento operazioni');
        run.rec('P5', 'S', {
          httpStatus: 200, request: { jobNumber: c.pkgCode },
          response: alignSteps,
          message: `operazioni: ${opsRecap ? opsRecap.response : 'non dichiarate'}`
            + ` | ${(order.components || []).length} componenti d'ordine`
        });
      } catch (e) {
        run.rec('P5', 'E', { request: { jobNumber: c.pkgCode }, message: `allineamento incompleto: ${e.message}` });
      }

      // ---- P6: aggancio all'ordine SAP (FR-23) ---------------------------------
      const accessoryFailed = run.steps.some(
        (s) => (s.step === 'P4' || s.step === 'P5' || s.step === 'P5a') && s.status !== 'S'
      );
      const finalState = accessoryFailed ? SPLIT_STATES.INCOMPLETE : SPLIT_STATES.ACTIVE;
      const linked = await setPackageState(deps, run, finalState, accessoryFailed ? 'W' : 'S',
        [logMsg.seg(accessoryFailed ? 'logSplitCreatedAccessoryFailed' : 'logSplitCreatedLinked')],
        { PlexJobId: c.pkgId, PlexPartId: partId, ExternalJobCode: c.pkgCode, Quantity: q, MainQtyBefore: c.mainQtyBefore },
        'P6');
      if (linked) {
        c.pkgState = finalState;
      } else {
        // Il pacchetto ESISTE su Plex ma non risulta agganciato: è l'anomalia a priorità
        // massima (riga H). Non si distrugge nulla: si tenta di lasciare la riga in 'L',
        // che è ciò che la sanatoria «Completa» andrà a chiudere.
        c.pkgState = SPLIT_STATES.TO_LINK;
        await setPackageState(deps, run, SPLIT_STATES.TO_LINK, 'W', [logMsg.seg('logSplitLinkFailed')], {}, null);
      }

      // ---- P7: ordinamento della lista di lavoro (feature 0014) -----------------
      // Ultimo passo, come il passo 8 di `processOrder`. Gira SEMPRE che si arrivi qui, anche con
      // P4/P5/P5a/P6 falliti: il pacchetto esiste su Plex ed è nella lista di lavoro, quindi la
      // sequenza va ricalcolata comunque — è la forma di [SCHED-CONTINUE].
      // [ORDER-SORT-ON-WRITE] Sui rami di compensazione, su `UNCERTAIN` e su un P1 senza risposta
      // non si arriva qui, ma il P7 parte lo stesso dalla loro uscita (`sortIfPlexTouched`): prima
      // si diceva «là il pacchetto non esiste, non c'è niente da risequenziare», e il lotto
      // principale era però già stato riscritto da P1 (addendum del 06/10/2026 a DEC-100).
      // Dopo P6 e non prima: un tetto di attesa di 30 secondi davanti all'aggancio lascerebbe il
      // pacchetto scollegato per tutto quel tempo, che è la riga H della matrice.
      const sort = await runSortStep(deps, run);

      await refreshOrderState(deps, run);
      // La riga di storico va scritta PRIMA di risolvere l'esito solo per la riga J, che
      // dichiara proprio l'impossibilità di scriverla: si compone quindi due volte.
      const provisional = finishSplit(deps, run);
      await writeHistory(deps, run, order, provisional.status, provisional.segments);
      // [JOB-SORT-SPLIT] `sort` è ADDITIVO, come lo è nel ritorno di `processOrder`: non entra in
      // `status`, non entra nella riga della matrice, e la finestra lo legge in due campi propri.
      return { ...finishSplit(deps, run), sort };
    } finally {
      await releaseSplitLock(deps, { order: c.order, token });
    }
  } catch (e) {
    console.error(`>>> [SPLIT] executeSplit fallita per l'ordine ${c.order}: ${e.stack || e.message}`);
    c.detail = e.message;
    run.rec('EXCEPTION', 'E', { messageKey: MESSAGE_KEYS['M-23'], message: e.stack || e.message });
    // [ORDER-SORT-ON-WRITE] Un'eccezione dopo P1 lascia comunque Plex cambiato. Non lancia: il
    // `catch` non puo' a sua volta fallire per l'ordinamento.
    const sort = await sortIfPlexTouched(deps, run);
    try { await refreshOrderState(deps, run); } catch (_) { /* best-effort */ }
    return withSort(finish(deps, run, {
      row: run.steps.some((s) => s.step === 'P1' && s.status === 'S') ? 'B' : 'A',
      status: 'E', messageKey: MESSAGE_KEYS['M-23'], data: splitResponseData(c)
    }), sort);
  }
}

/**
 * [JOB-PUT] Il `PUT` di una testata, con la scala dei tentativi di `jobPutBodies`.
 *
 * UN SOLO PASSO COL NOME CHE CONTA. `resolveOutcomeRow` cerca i passi per nome esatto
 * (`at('P1')`, e con `.pop()`) mentre qui dentro si guarda `find()`: due passi omonimi renderebbero
 * l'esito dipendente da quale dei due si legge. Quindi il tentativo scartato si registra come
 * `${stepName}a` — resta nella traccia, non entra nella matrice — e il chiamante registra il passo
 * che decide.
 *
 * IL RITENTATIVO E' SOLO SUI `5xx`. Un `4xx` è un rifiuto conclusivo dello schema: ripetere con
 * meno campi significherebbe sperare, e `jobType` è obbligatorio in entrambi i corpi. Il `PUT` è
 * idempotente per costruzione (stesso URL, modello intero) e sul `500` allora osservato non applicava
 * nulla — verificato rileggendo il job dopo il fallimento — quindi il secondo tentativo non è un
 * secondo movimento. Quel `500` era un difetto di Plex, corretto da Rockwell il 27/08/2026 e
 * verificato sul tenant: oggi il primo corpo passa, e la scala resta come rete su un `5xx` futuro.
 *
 * @returns {{ok, status, r, request, thrown, attempt, kind, cleared}}
 */
async function putJobHeader(deps, run, { stepName, what, jobId, bodies }) {
  let last = null;
  for (let i = 0; i < bodies.length; i += 1) {
    const { body, kind, cleared } = bodies[i];
    const isLast = i === bodies.length - 1;
    try {
      const r = await deps.plex.put(`/scheduling/v1/jobs/${jobId}`, body);
      if (r.ok) {
        return { ok: true, status: r.status, r, request: body, attempt: i + 1, kind, cleared };
      }
      last = { ok: false, status: r.status, r, request: body, attempt: i + 1, kind, cleared: [] };
      if (isLast || r.status < 500) break;
      run.rec(`${stepName}a`, 'E', {
        httpStatus: r.status, request: body, response: r.body,
        message: `PUT ${what} (${kind}) rifiutato: ${plexErrText(r)} — si ritenta col corpo ridotto`
      });
    } catch (e) {
      return { ok: false, thrown: e, status: 0, r: null, request: body, attempt: i + 1, kind, cleared: [] };
    }
  }
  return last;
}

/** Cosa il corpo ridotto ha lasciato indietro, da accodare al messaggio del passo (DEC-77). */
function clearedNote(put) {
  return put && put.cleared && put.cleared.length
    ? ` (corpo ridotto: ${put.cleared.join(', ')} azzerati su Plex)`
    : '';
}

/** P2 / P4 / R2 — rischedulazione, sempre dopo una variazione di quantità (FR-21). */
async function backwardsSchedule(deps, run, stepName, jobId, what) {
  const body = { useFirstApprovedWorkcenter: USE_FIRST_APPROVED_WORKCENTER };
  try {
    const r = await deps.plex.post(`/scheduling/v1/jobs/${jobId}/backwards-schedule`, body);
    run.rec(stepName, r.ok ? 'S' : 'E', {
      httpStatus: r.status, request: body, response: r.body,
      message: r.ok
        ? `backwards-schedule ${what}`
        : `backwards-schedule ${what} fallito (${plexErrText(r)})`
    });
    return r.ok;
  } catch (e) {
    run.rec(stepName, 'E', { request: body, message: `backwards-schedule ${what} senza risposta: ${e.message}` });
    return false;
  }
}

/**
 * [JOB-SORT-SPLIT] P7 — ordinamento della lista di lavoro Plex (feature 0014), DOPO l'ultima
 * scrittura su Plex della sequenza.
 *
 * Perché sta anche qui: la Data Source di ordinamento aveva un solo chiamante, il passo 8 di
 * `processOrder`, e lo spacchettamento non passa da lì — crea il job del pacchetto con la POST di
 * P3d e cambia la quantità del principale con il PUT di P1. Senza questo passo la lista di lavoro
 * del centro di lavoro restava nella sequenza precedente fino al prossimo invio o al job notturno,
 * cioè il difetto che la 0014 esiste per chiudere. Nella creazione normale l'ordinamento parte anche
 * dopo un semplice aggiornamento di quantità (passo 3 -> passo 8): qui la simmetria è quella.
 *
 * NON TOCCA L'ESITO, e non per cautela ma per costruzione: il nome `P7` non è fra quelli che
 * `resolveOutcomeRow` cerca (`P0`…`P6`, `R0`…`R3`, `LOG`, più il prefisso `A` dei preliminari) e non
 * è fra quelli di `accessoryFailed` (`P4`/`P5`/`P5a`), quindi non sposta né la riga della matrice né
 * lo stato del pacchetto. Il terzo presidio è `aux: true`, che lo tiene fuori dal semaforo dello
 * storico. Il test che sorveglia il primo è in test/splitRules.test.js.
 *
 * `NOT_CONFIGURED` non lascia NESSUN passo e non emette nessuna richiesta: è la stessa regola del
 * passo 8 (FR-24/FR-31 della 0014), e serve perché un plant non configurato debba restare
 * indistinguibile da come si comportava prima di questa modifica.
 *
 * La chiamata esce sul canale Data Source e NON passa da `plexCallTrace.wrap`, che avvolge il client
 * Connect API: non comparirà in `window.plexCalls()`, esattamente come il passo 8. La sua traccia è
 * questo passo, più la riga `>>> [PLEX DS] POST …` nel log.
 *
 * @returns {Promise<object|null>} l'esito di `runJobSortStep`, o null se la dipendenza non c'è
 */
async function runSortStep(deps, run) {
  // Dipendenza non iniettata (test, chiamanti storici): niente cambia rispetto a prima.
  if (typeof deps.sort !== 'function') return null;
  const res = await deps.sort(run.c.plant);
  const outcome = res && res.outcome;
  if (!outcome || outcome.state === 'NOT_CONFIGURED') return outcome || null;
  const s = res.step || {};
  run.rec('P7', outcome.state === 'OK' ? 'S' : 'W', {
    httpStatus: s.status || 0,
    request: s.request === undefined ? null : s.request,
    response: s.response === undefined ? null : s.response,
    // 'W' e non 'E' su un ordinamento fallito: è la convenzione di P5a per un passo accessorio non
    // fatale, e da quando il pacchetto esiste la matrice promette che nessun esito è più 'E'.
    aux: true,
    message: outcome.state === 'OK'
      ? 'lista di lavoro riordinata'
      : `ordinamento non applicato: ${res.reasonText || outcome.message || 'motivo non dichiarato'}`
  });
  return outcome;
}

/**
 * [ORDER-SORT-ON-WRITE] P7 sulle uscite di «Conferma» che NON arrivano in fondo alla sequenza: P1
 * senza risposta, rollback compensativo, creazione incerta, eccezione.
 *
 * La regola e' dettata: ogni scrittura su un ordine verso Plex si chiude con l'ordinamento della
 * lista di lavoro (addendum del 06/10/2026 a DEC-100). Se lo spacchettamento ha toccato Plex lo
 * dice `plexTouched` (splitRules.js, puro e testato); se P7 c'e' gia' non si ripete, perche' due
 * richieste per un'esecuzione renderebbero la traccia ambigua. Non lancia, come `runSortStep`.
 */
async function sortIfPlexTouched(deps, run) {
  if (!plexTouched(run.steps)) return null;
  if (run.steps.some((s) => s && s.step === 'P7')) return null;
  try {
    return await runSortStep(deps, run);
  } catch (e) {
    console.error(`>>> [ORDER-SORT-ON-WRITE] ordinamento non eseguito per l'ordine ${run.c.order}: ${e.message}`);
    return null;
  }
}

/** `sort` e' un campo ADDITIVO dell'esito (come in `processOrder`): assente se non e' stato chiesto. */
function withSort(out, sort) {
  return sort ? { ...out, sort } : out;
}

/**
 * P3 — assegnazione definitiva del codice e creazione del pacchetto, con la verifica R0
 * quando l'esito non è un successo certo.
 * @returns {{proceed: boolean, jobId: string|null, decision: string|null}}
 */
async function createPackage(deps, run, { order, seq0, partId, dueDate, quantity, inherited }) {
  const c = run.c;

  // --- P3b: primo codice LIBERO su Plex (FR-17) --------------------------------
  let seq = seq0;
  let code = formatPackageCode(c.order, seq);
  let probes = 0;
  while (probes < deps.maxCodeProbes) {
    const probe = await findJobByExactNumber(deps, code);
    if (!probe.ok) {
      // Verifica non conclusiva: si procede con il candidato. Se Plex è davvero giù, sarà
      // la creazione a fallire e R0 a decidere; il codice resta comunque bruciato.
      run.rec('P3b', 'U', {
        httpStatus: probe.status,
        message: `verifica del codice ${code} non conclusiva: ${probe.error}`
      });
      break;
    }
    if (!probe.found) break;
    // Codice occupato — tipicamente un lotto creato a mano fuori dal sistema: è bruciato,
    // NON viene mai aggiornato né riusato (FR-17).
    run.rec('P3b', 'S', {
      httpStatus: probe.status,
      message: `codice ${code} già presente su Plex: si passa al progressivo successivo`
    });
    seq = nextSplitSequence({ lastSequence: seq, usedSequences: [] });
    if (!seq) {
      run.rec('P3', 'E', {
        verdict: 'FAILED', messageKey: MESSAGE_KEYS['M-12'], message: 'progressivi esauriti durante la ricerca del codice libero'
      });
      run.rec('R0', 'S', { verdict: 'ABSENT', message: 'nessuna richiesta di creazione inviata' });
      return { proceed: false, jobId: null, decision: 'COMPENSATE' };
    }
    code = formatPackageCode(c.order, seq);
    probes += 1;
  }
  if (probes >= deps.maxCodeProbes) {
    run.rec('P3', 'E', {
      verdict: 'FAILED', messageKey: MESSAGE_KEYS['M-12'],
      message: `nessun codice libero trovato in ${deps.maxCodeProbes} tentativi`
    });
    run.rec('R0', 'S', { verdict: 'ABSENT', message: 'nessuna richiesta di creazione inviata' });
    return { proceed: false, jobId: null, decision: 'COMPENSATE' };
  }
  c.pkgCode = code;
  c.codeChanged = code !== c.plannedPkgCode;

  // --- P3c: PRE-INSERT della riga pacchetto, prima della POST -------------------
  // La chiave primaria (ManufacturingOrder, PlexJobNumber) è il secondo presidio del
  // progressivo: se un'altra esecuzione ha già preso questo codice, l'INSERT fallisce con
  // duplicate key invece di creare un secondo lotto (DEC-03 applicato bene: vincolo di
  // database PIÙ rete di sicurezza applicativa).
  const nowIso = deps.now().toISOString();
  try {
    await autoTx(deps.db, (tx) => tx.run(INSERT.into(E_MAPPING).entries({
      ManufacturingOrder: c.order,
      PlexJobNumber: code,
      // [ORDER-TECO] Il plant di produzione: senza, un pacchetto sarebbe invisibile al gate di
      // licenza sui log e il job di chiusura tecnica non saprebbe a chi appartiene.
      Plant: c.plant || null,
      SplitSequence: seq,
      SplitState: SPLIT_STATES.PENDING,
      Quantity: quantity,
      MainQtyBefore: c.mainQtyBefore,
      Status: 'E',
      ...messageFields([logMsg.seg('logSplitCreating')]),
      CreatedAt: nowIso,
      UpdatedAt: nowIso
    })));
    await autoTx(deps.db, (tx) => tx.run(
      // LastSequence è l'ultimo progressivo ASSEGNATO, non l'ultimo riuscito: non viene mai
      // decrementato, nemmeno se il pacchetto non arriva a esistere (FR-16, FR-42 regola 1).
      UPDATE(E_SPLIT).set({ LastSequence: seq, UpdatedAt: nowIso }).where({ ManufacturingOrder: c.order })
    ));
  } catch (e) {
    c.detail = `codice ${code} già assegnato da un'altra esecuzione: ${e.message}`;
    run.rec('P3', 'E', { verdict: 'FAILED', message: c.detail });
    run.rec('R0', 'S', { verdict: 'ABSENT', message: 'nessuna richiesta di creazione inviata' });
    return { proceed: false, jobId: null, decision: 'COMPENSATE' };
  }

  // --- P3d: creazione su Plex --------------------------------------------------
  const body = {
    partId,
    dueDate,
    quantity,
    jobNumber: code,
    externalJobCode: code,
    // [JOB-WINDOW] Come sopra: una finestra di ampiezza zero non si manda. `inherited`, sparso in
    // coda, e' già stato filtrato con la stessa regola in A6.
    ...earliestStartField({ start: toIso(order.MfgOrderPlannedStartDate), due: dueDate }),
    ...(BUILDING_ID ? { buildingId: BUILDING_ID } : {}),
    ...(PRIORITY ? { priority: PRIORITY } : {}),
    ...(JOB_NUMBER_PREFIX ? { jobNumberPrefix: JOB_NUMBER_PREFIX } : {}),
    ...(JOB_NUMBER_SUFFIX ? { jobNumberSuffix: JOB_NUMBER_SUFFIX } : {}),
    // [JOB-FIELDS] DEC-77: l'eredità del lotto padre va sparsa PER ULTIMA. Il pacchetto nasce con
    // la testata che il padre ha ADESSO su Plex — un pacchetto con un job type diverso dal suo
    // lotto padre non si vedrebbe da qui — e le costanti d'ambiente qui sopra restano come
    // riempimento dei soli campi su cui il padre tace.
    ...inherited
  };
  let verdict;
  let jobId = null;
  let httpStatus = 0;
  let response = null;
  try {
    const r = await deps.plex.post('/scheduling/v1/jobs', body);
    httpStatus = r.status;
    response = r.body;
    jobId = r.body?.id || null;
    verdict = classifyCreateVerdict({ ok: r.ok, status: r.status, hasId: !!jobId });
    if (!r.ok) c.detail = plexErrText(r);
  } catch (e) {
    verdict = classifyCreateVerdict({ thrown: true, aborted: e.name === 'AbortError' });
    c.detail = e.message;
  }
  run.rec('P3', verdict === 'CREATED' ? 'S' : (verdict === 'FAILED' ? 'E' : 'U'), {
    httpStatus, verdict, request: body, response,
    codeChanged: c.codeChanged,
    message: verdict === 'CREATED'
      ? `job ${code} creato`
      : `creazione del pacchetto ${code}: ${verdict} (${c.detail || 'nessun dettaglio'})`
  });

  if (verdict === 'CREATED') return { proceed: true, jobId, decision: 'PROCEED' };

  // --- R0: si verifica su Plex PRIMA di compensare (FR-42) ---------------------
  const probe = await findJobByExactNumber(deps, code);
  const probeVerdict = probe.ok ? (probe.found ? 'FOUND' : 'ABSENT') : 'INCONCLUSIVE';
  run.rec('R0', probe.ok ? 'S' : 'U', {
    httpStatus: probe.status, verdict: probeVerdict,
    message: probeVerdict === 'FOUND'
      ? `job ${code} trovato su Plex`
      : (probeVerdict === 'ABSENT' ? `nessun job con jobNumber ${code}` : `verifica non conclusiva: ${probe.error}`)
  });

  const decision = decideRollback(verdict, probeVerdict);
  if (decision === 'PROCEED') {
    return { proceed: true, jobId: probe.found?.id || jobId, decision };
  }
  return { proceed: false, jobId: null, decision };
}

/** R1 + R2 + R3 — ripristino compensativo, solo quando R0 ha accertato che il lotto non c'è. */
async function compensate(deps, run, { dueDate, inherited }) {
  const c = run.c;

  // R1 — quantità ASSOLUTA: idempotente per costruzione, nessuna verifica preventiva
  // (FR-42 regola 5). La testata è la stessa di P1 (DEC-77): senza `jobType` il ripristino
  // fallirebbe SEMPRE, e un P3 andato male lascerebbe il lotto principale ridotto per sempre.
  // [JOB-PUT] La stessa scala di P1: qui conta il doppio, perché un ripristino che non parte lascia
  // il lotto principale ridotto per sempre (riga E3 della matrice).
  const put = await putJobHeader(deps, run, {
    stepName: 'R1',
    what: 'ripristino del lotto principale',
    jobId: c.mainJobId,
    bodies: jobPutBodies(inherited, { dueDate, quantity: c.mainQtyBefore })
  });
  const restored = !!(put && put.ok);
  if (put && put.thrown) {
    run.rec('R1', 'E', {
      request: put.request, message: `ripristino della quantità senza risposta: ${put.thrown.message}`
    });
  } else {
    run.rec('R1', restored ? 'S' : 'E', {
      httpStatus: put.status, request: put.request, response: put.r ? put.r.body : null,
      message: restored
        ? `quantity ${p(c.mainQty)} -> ${p(c.mainQtyBefore)} (valore assoluto)${clearedNote(put)}`
        : `ripristino della quantità fallito (${plexErrText(put.r)})`
    });
  }

  if (restored) {
    c.mainQty = c.mainQtyBefore;
    // R2 — la quantità è cambiata di nuovo, quindi si rischedula di nuovo (FR-21).
    await backwardsSchedule(deps, run, 'R2', c.mainJobId, 'lotto principale (ripristino)');
  }

  // R3 — il codice resta bruciato: SplitState='X' e LastSequence NON decrementato.
  const closedState = restored ? SPLIT_STATES.CLOSED : SPLIT_STATES.TO_RESTORE;
  await setPackageState(deps, run, closedState, 'E',
    [logMsg.seg(restored ? 'logSplitNeverCreatedRestored' : 'logSplitNeverCreatedNotRestored')],
    {}, 'R3');
  c.pkgState = closedState;

  if (restored) {
    // La marcatura si rimuove solo se non resta alcun pacchetto attivo o residuale (FR-34).
    await unmarkIfNoPackages(deps, run);
  }
  // [ORDER-SORT-ON-WRITE] `uncertain`: R1 e' partito senza risposta, quindi il ripristino POTREBBE
  // essere avvenuto. Il passo resta registrato 'E' — la matrice degli esiti non cambia — e chi
  // chiama lo usa solo per decidere l'ordinamento («Ripristina»).
  return { restored, uncertain: !!(put && put.thrown) };
}

/**
 * Rimuove la marcatura di ordine spacchettato se e solo se non esiste nessun'altra riga
 * pacchetto in ('A','I','L','R','U','P'): finché una esiste, l'ordine resta spacchettato e
 * quindi escluso dalla ri-sincronizzazione (FR-34).
 */
async function unmarkIfNoPackages(deps, run) {
  const c = run.c;
  try {
    const packages = await readPackageRows(deps, c.order);
    const alive = packages.filter((r) => r.SplitState !== SPLIT_STATES.CLOSED && r.SplitState !== SPLIT_STATES.MAIN);
    if (alive.length) return false;
    await autoTx(deps.db, (tx) => tx.run(
      UPDATE(E_SPLIT).set({ IsSplit: false, UpdatedAt: deps.now().toISOString() })
        .where({ ManufacturingOrder: c.order })
    ));
    c.isSplit = false;
    return true;
  } catch (e) {
    console.error(`>>> [SPLIT] marcatura non rimossa per l'ordine ${c.order}: ${e.message}`);
    return false;
  }
}

/**
 * [LOG-MSG-I18N] Il messaggio di una riga pacchetto, nella lingua di chi guarda.
 *
 * Il fallback sul testo salvato non e' una cortesia: e' cio' che permette di non migrare niente. Una
 * riga scritta prima della 0029 non ha segmenti, e mostrare il suo `LastMessage` e' esattamente cio'
 * che il cockpit mostrava — mentre azzerarlo farebbe sparire l'esito dell'ultimo tentativo.
 *
 * @param {object} row la riga di ZProdOrderPlexMapping
 * @param {string} locale
 * @returns {string}
 */
function renderLastMessage(row, locale) {
  const segs = logMsg.unpack(row && row.LastMessageJson);
  if (!segs.length) return (row && row.LastMessage) || '';
  return i18nMessages.render(segs, i18nMessages.COCKPIT_APP, locale);
}

/**
 * [LOG-MSG-I18N] Le DUE colonne del messaggio di una riga pacchetto, dai segmenti.
 *
 * Un punto solo che sa come si scrive un messaggio su `ZProdOrderPlexMapping`: i segmenti sono la
 * verita' e il testo lo snapshot. Tenerle separate significherebbe poter scrivere l'una senza
 * l'altra, e una riga con il testo e senza i segmenti e' una riga che non si traduce — invisibile a
 * chi non conosce i testi attesi.
 *
 * @param {Array} segments
 * @returns {{LastMessage: string, LastMessageJson: string}}
 */
function messageFields(segments) {
  const segs = logMsg.normalize(segments);
  return {
    LastMessage: i18nMessages
      .render(segs, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE)
      .slice(0, 255),
    LastMessageJson: logMsg.pack(segs)
  };
}

/**
 * Scrive lo stato della riga pacchetto in transazione autonoma (TD-5).
 * @param {string|null} stepName se valorizzato, registra il passo corrispondente (P6 / R3).
 * @returns {Promise<boolean>} true se la scrittura è riuscita
 */
async function setPackageState(deps, run, splitState, status, segments, extra = {}, stepName = null) {
  const c = run.c;
  if (!c.pkgCode) return false;
  const nowIso = deps.now().toISOString();
  // [LOG-MSG-I18N] Accetta SEGMENTI e non una stringa: e' la stessa difesa strutturale di
  // `writeRoutingSyncLog`. Con un testo libero un chiamante non convertito scriverebbe `LastMessage`
  // senza `LastMessageJson`, e la riga resterebbe nella lingua di chi ha lanciato lo spacchettamento
  // senza che niente lo segnali.
  try {
    await autoTx(deps.db, (tx) => tx.run(UPDATE(E_MAPPING).set({
      SplitState: splitState,
      Status: status,
      ...messageFields(segments),
      UpdatedAt: nowIso,
      ...extra
    }).where({ ManufacturingOrder: c.order, PlexJobNumber: c.pkgCode })));
    if (stepName) {
      run.rec(stepName, 'S', { message: `${stepName === 'P6' ? 'mapping scritto' : 'stato aggiornato'}, SplitState=${splitState}` });
    }
    return true;
  } catch (e) {
    console.error(`>>> [SPLIT] stato del pacchetto ${c.pkgCode} non scritto: ${e.message}`);
    if (stepName) run.rec(stepName, 'E', { message: `scrittura dello stato fallita: ${e.message}` });
    return false;
  }
}

// ================================================================
// Sanatorie (FR-26, §3.7)
// ================================================================

/**
 * «Completa» — ripete il SOLO aggancio del pacchetto all'ordine SAP: R0 per riottenere
 * l'id del lotto, poi P6. Non ricrea il pacchetto e non tocca alcuna quantità.
 */
async function executeComplete(deps, { order }) {
  return await runSanatoria(deps, order, async (run, residual) => {
    const c = run.c;
    const probe = await findJobByExactNumber(deps, residual.PlexJobNumber, residual.PlexJobId);
    const verdict = probe.ok ? (probe.found ? 'FOUND' : 'ABSENT') : 'INCONCLUSIVE';
    run.rec('R0', probe.ok ? 'S' : 'U', {
      httpStatus: probe.status, verdict,
      message: verdict === 'FOUND'
        ? `job ${residual.PlexJobNumber} trovato, id ${probe.found.id || '(assente)'}`
        : (verdict === 'ABSENT' ? `nessun job con jobNumber ${residual.PlexJobNumber}` : `verifica non conclusiva: ${probe.error}`)
    });

    if (verdict === 'ABSENT') {
      // Il pacchetto non risulta più su Plex: il cockpit non ricrea pacchetti, il caso si
      // gestisce dentro Plex.
      c.missingJobNumber = residual.PlexJobNumber;
      return { status: 'E', row: '', messageKey: MESSAGE_KEYS['M-03'] };
    }
    if (verdict === 'INCONCLUSIVE') {
      await setPackageState(deps, run, SPLIT_STATES.UNCERTAIN, 'E', [logMsg.seg('logSplitProbeInconclusive')]);
      c.pkgState = SPLIT_STATES.UNCERTAIN;
      return { status: 'E', row: 'E4', messageKey: MESSAGE_KEYS['M-27'] };
    }

    c.pkgId = probe.found.id || residual.PlexJobId || null;
    const linked = await setPackageState(deps, run, SPLIT_STATES.ACTIVE, 'S', [logMsg.seg('logSplitLinked')],
      { PlexJobId: c.pkgId, ExternalJobCode: residual.PlexJobNumber }, 'P6');
    if (!linked) {
      c.pkgState = SPLIT_STATES.TO_LINK;
      return { status: 'W', row: 'H', messageKey: MESSAGE_KEYS['M-20'] };
    }
    c.pkgState = SPLIT_STATES.ACTIVE;
    return { status: 'S', row: '', messageKey: MESSAGE_KEYS['M-25'] };
  });
}

/**
 * «Ripristina» — riporta al lotto principale la quantità sottratta (R1 + R2 + R3). Non crea
 * alcun pacchetto e il codice resta bruciato. È idempotente perché R1 scrive una quantità
 * ASSOLUTA (FR-42 regola 5).
 */
async function executeRestore(deps, { order }) {
  return await runSanatoria(deps, order, async (run, residual) => {
    const c = run.c;

    // Su uno stato incerto ('U'/'P') si verifica PRIMA: ripristinare la quantità mentre il
    // pacchetto esiste produrrebbe la sovra-allocazione che l'intero design evita.
    if (residual.SplitState !== SPLIT_STATES.TO_RESTORE) {
      const probe = await findJobByExactNumber(deps, residual.PlexJobNumber, residual.PlexJobId);
      const verdict = probe.ok ? (probe.found ? 'FOUND' : 'ABSENT') : 'INCONCLUSIVE';
      run.rec('R0', probe.ok ? 'S' : 'U', {
        httpStatus: probe.status, verdict,
        message: verdict === 'FOUND'
          ? `job ${residual.PlexJobNumber} trovato: non si ripristina`
          : (verdict === 'ABSENT' ? `nessun job con jobNumber ${residual.PlexJobNumber}` : `verifica non conclusiva: ${probe.error}`)
      });
      if (verdict === 'FOUND') {
        await setPackageState(deps, run, SPLIT_STATES.TO_LINK, 'W', [logMsg.seg('logSplitExistsLinkNotRestore')],
          probe.found.id ? { PlexJobId: probe.found.id } : {});
        c.pkgState = SPLIT_STATES.TO_LINK;
        return { status: 'E', row: 'H', messageKey: MESSAGE_KEYS['M-22'] };
      }
      if (verdict === 'INCONCLUSIVE') {
        await setPackageState(deps, run, SPLIT_STATES.UNCERTAIN, 'E', [logMsg.seg('logSplitProbeInconclusive')]);
        c.pkgState = SPLIT_STATES.UNCERTAIN;
        return { status: 'E', row: 'E4', messageKey: MESSAGE_KEYS['M-27'] };
      }
    }

    // Stato reale del lotto principale: serve la dueDate da rinviare nel PUT (TD-8).
    // [JOB-READ] L'id non è nel caso residuale: si legge dal dizionario, con la stessa chiave piena
    // di A5. Una SELECT locale in più costa meno di una lettura per numero che può non concludere.
    const mainRow = await readMainRow(deps, c.order);
    const mainProbe = await findJobByExactNumber(deps, c.order, mainRow && mainRow.PlexJobId);
    if (!mainProbe.ok || !mainProbe.found) {
      c.detail = mainProbe.ok ? 'lotto principale non presente su Plex' : readDetail(mainProbe);
      run.rec('R1', 'E', { httpStatus: mainProbe.status, message: `ripristino non tentato: ${c.detail}` });
      return { status: 'E', row: 'E3', messageKey: MESSAGE_KEYS['M-16b'] };
    }
    c.mainJobId = mainProbe.found.id;
    c.mainQty = num(mainProbe.found.quantity);
    c.mainQtyBefore = num(residual.MainQtyBefore);
    c.pkgQty = num(residual.Quantity);

    const comp = await compensate(deps, run, { dueDate: mainProbe.found.dueDate });

    const r1 = run.steps.find((s) => s.step === 'R1');
    const r2 = run.steps.find((s) => s.step === 'R2');
    // R1 rifiutato: la quantità del lotto principale su Plex è quella di prima, la lista di lavoro
    // non è cambiata, e nessuna richiesta di ordinamento deve partire.
    // [ORDER-SORT-ON-WRITE] R1 SENZA RISPOSTA invece si', perche' il ripristino potrebbe essere
    // avvenuto: l'esito resta E3, l'ordinamento si chiede lo stesso.
    if (!r1 || r1.status !== 'S') {
      const sort = comp && comp.uncertain ? await runSortStep(deps, run) : undefined;
      return { status: 'E', row: 'E3', messageKey: MESSAGE_KEYS['M-16b'], ...(sort ? { sort } : {}) };
    }

    // ---- P7: ordinamento della lista di lavoro (feature 0014) -------------------
    // [JOB-SORT-SPLIT] «Ripristina» riporta sul lotto principale la quantità sottratta e lo
    // rischedula: è una variazione della lista di lavoro esattamente come la creazione di un
    // pacchetto, e nella creazione normale il passo 8 segue anche il solo aggiornamento di quantità
    // del passo 3. Dopo R1 riuscito, quindi, anche se R2 non è andato: il valore su Plex è cambiato.
    // «Completa» invece non arriva qui, e non è una dimenticanza — non scrive niente su Plex.
    const sort = await runSortStep(deps, run);

    if (r2 && r2.status !== 'S') return { status: 'W', row: 'E2', messageKey: MESSAGE_KEYS['M-16a'], sort };
    return { status: 'S', row: '', messageKey: MESSAGE_KEYS['M-24'], sort };
  });
}

/**
 * Impianto comune delle due sanatorie: stessa esclusiva dello spacchettamento (FR-26),
 * caso residuale risolto dal server (ce ne può essere uno solo), propria riga di storico
 * perché è un'azione dell'utente distinta nel tempo.
 */
async function runSanatoria(deps, order, body) {
  const run = newRun(deps, order);
  const c = run.c;
  let token = null;
  try {
    token = await acquireSplitLock(deps, { order: c.order, plant: c.plant, owner: deps.user });
    if (!token) {
      run.rec('P0', 'E', { messageKey: MESSAGE_KEYS['M-11'], message: 'esclusiva non ottenuta' });
      await refreshOrderState(deps, run);
      return finish(deps, run, {
        row: 'A', status: 'E', messageKey: MESSAGE_KEYS['M-11'], data: splitResponseData(c)
      });
    }
    try {
      const state = await refreshOrderState(deps, run);
      if (!state.residual) {
        // Qualcuno ha già sanato: nulla da fare, il client ricarica lo stato.
        return finish(deps, run, {
          row: 'A', status: 'E', messageKey: MESSAGE_KEYS['M-06'], data: splitResponseData(c)
        });
      }
      c.pkgCode = state.residual.PlexJobNumber;
      c.pkgQty = num(state.residual.Quantity);
      c.pkgId = state.residual.PlexJobId || null;
      c.pkgState = state.residual.SplitState;
      c.mainQtyBefore = num(state.residual.MainQtyBefore);

      const res = await body(run, state.residual);
      await refreshOrderState(deps, run);
      const out = finish(deps, run, {
        row: res.row, status: res.status, messageKey: res.messageKey, data: splitResponseData(c)
      });
      await writeHistory(deps, run, order, out.status, out.segments);
      // [JOB-SORT-SPLIT] Campo ADDITIVO, e solo se la sanatoria l'ha prodotto: «Ripristina» sì
      // (cambia la quantità su Plex), «Completa» no. Un `sort` assente e un `sort` a null sono la
      // stessa cosa per la finestra, che mostra la nota solo su un esito conclamato.
      return res.sort === undefined ? out : { ...out, sort: res.sort };
    } finally {
      await releaseSplitLock(deps, { order: c.order, token });
    }
  } catch (e) {
    console.error(`>>> [SPLIT] sanatoria fallita per l'ordine ${c.order}: ${e.stack || e.message}`);
    c.detail = e.message;
    run.rec('EXCEPTION', 'E', { message: e.stack || e.message });
    try { await refreshOrderState(deps, run); } catch (_) { /* best-effort */ }
    return finish(deps, run, {
      row: '', status: 'E', messageKey: MESSAGE_KEYS['M-23'], data: splitResponseData(c)
    });
  }
}

module.exports = {
  readSplitInfo,
  executeSplit,
  executeComplete,
  executeRestore,
  // esposte per l'handler e per i test
  findJobByExactNumber,
  // [JOB-SORT-SPLIT] Il passo P7 e lo stato di un'esecuzione: non toccano ne' Plex ne' il database
  // (`deps.sort` arriva iniettata), quindi la traduzione dell'esito in passo tracciato e'
  // collaudabile da sola — test/splitJobSort.test.js. Stessa forma di srv/lib/orderBomAdd.js.
  runSortStep,
  newRun,
  // [SPLIT-TRACE] la sonda legge la riga del lotto principale con gli STESSI criteri
  readMainRow,
  findOpenResidual,
  acquireSplitLock,
  releaseSplitLock,
  autoTx
};

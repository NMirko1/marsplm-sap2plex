/**
 * [ORDER-BOM-ADD] Regole pure dell'aggiunta dei componenti extra dell'ordine alla distinta DEL SUO
 * JOB su Plex (feature 0025).
 *
 * IL PROBLEMA. Un ODP SAP non e' una copia del ciclo standard: chi lo rilascia puo' aggiungere
 * componenti che nella distinta del materiale non ci sono. Fino alla 0025 quel componente non
 * arrivava su Plex e NESSUNO LO DICEVA — `alignJobOperationsAndBom` itera sulle righe BOM del job,
 * quindi una riga che non esiste non viene nemmeno guardata, e l'ordine chiudeva verde. Intanto in
 * SAP il 261 lo consumava lo stesso, perche' `confMatDoc` costruisce il documento su TUTTI i
 * componenti dell'ordine letti da SAP (0021): merce scaricata a fronte di un consumo che in
 * fabbrica non e' mai passato.
 *
 * IL VERSO E' OPPOSTO A QUELLO DEL PASSO 7.2, E CONVIVONO SULLO STESSO OGGETTO. Il passo 7.2
 * SOTTRAE dal job le righe che l'ordine non ha; questo modulo AGGIUNGE al job quelle che l'ordine ha
 * e la part no. Non si pestano i piedi: cio' che si aggiunge E' fra i componenti dell'ordine, quindi
 * il 7.2 non lo disattivera' mai.
 *
 * PERCHE' SUL JOB E NON SULLA PART. La part e' master data condivisa da tutti gli ordini di quel
 * materiale: una riga aggiunta per l'ordine di oggi resterebbe li' e comparirebbe nel job di domani,
 * dove il 7.2 la disattiverebbe. `POST /scheduling/v1/jobs/{id}/bom-components` scrive sul singolo
 * lotto e non lascia niente dietro di se'. Il prezzo e' che il job deve gia' esistere, quindi la
 * sequenza si spezza in DUE: un PREVOLO sulla part — che e' cio' che il job erediterà — prima della
 * creazione, e la SCRITTURA dopo.
 *
 * COSA QUESTO MODULO NON FA: le OPERAZIONI. Non si aggiungono e non si rilevano. Il
 * `POST /mdm/v1/part-operations` pretende un `operationId` del catalogo del tenant, e quel catalogo
 * e' di sola lettura — nessun verbo di scrittura in tutte le 71 API
 * (srv/external/PLEX_OPERATION_API_CONTRACT.md). Un'operazione SAP non nomina niente di Plex,
 * quindi non e' derivabile: si puo' solo appendere un componente a un'operazione che ESISTE gia'.
 *
 * Nessuna dipendenza oltre a srv/lib/plexBomRules.js, che e' puro anch'esso e da cui arrivano i soli
 * VALORI costanti della riga di distinta (mai i nomi dei campi: vedi `buildJobBomBody`). Ne' `cds`,
 * ne' rete, ne' db, ne' orologio, ne' `process.env`. Non aggiungerne: il test si lancia con
 *     node test/orderBomAddRules.test.js
 * Stessa convenzione di srv/lib/splitRules.js, srv/lib/isQueryShape.js e srv/lib/plexBomRules.js.
 * L'orchestrazione — chiamate a Plex, auto-assegnazione, traccia — sta in srv/lib/orderBomAdd.js.
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

// I VALORI costanti della riga di distinta — `autoDeplete: false`, `validate: false`, fattore `1` —
// sono assunzioni vincolanti della BBP e vivono in un posto solo. Da qui si prendono i valori, MAI i
// nomi dei campi: quelli cambiano fra i due contratti, vedi `buildJobBomBody`. Modulo puro anche
// lui, quindi questa dipendenza non toglie niente alla collaudabilita' senza sistemi esterni.
const bomRules = require('./plexBomRules');

/**
 * Il fattore di conversione sulla riga di distinta di un JOB si chiama `depletionConversionFact` —
 * senza `or` finale — mentre sulla BOM della part e' `depletionConversionFactor`. Due API, stesso
 * significato, nomi diversi: letto dal portale il 23/08/2026, non dedotto.
 */
const JOB_DEPLETION_FACTOR_FIELD = 'depletionConversionFact';

/**
 * Perche' un componente dell'ordine NON e' arrivato sulla distinta della part.
 *
 * Sono CODICI e non testi, ma a differenza di altri moduli del progetto il testo lo compone
 * `describe` qui dentro e non un file i18n: questo modulo serve `processOrder`, che gira anche nel
 * job `PROD_ORDER` — un processo standalone, senza `req`, quindi senza `getLocalizedMessage`. Tutti
 * gli altri messaggi di `processOrder` sono gia' stringhe italiane in chiaro, per la stessa
 * ragione: «Part X non presente in Plex», «Update Job fallito». Un solo messaggio localizzato in
 * mezzo a quelli sarebbe l'incoerenza, non la coerenza.
 */
const FAILURE = Object.freeze({
  /** L'auto-assegnazione non ha prodotto un bersaglio (NO_GROUP / NO_MAPPING / NO_CLFN / …). */
  UNASSIGNED: 'UNASSIGNED',
  /** Bersaglio risolto, ma quella operazione non esiste fra le part-operation della part. */
  NO_TARGET_OP: 'NO_TARGET_OP',
  /**
   * Il prevolo aveva trovato l'operazione sulla part, ma il job nato da quella part non ha una
   * operazione con quel numero. Non e' `NO_TARGET_OP`: la' il customizing punta a un'operazione che
   * il ciclo non ha, qui il ciclo ce l'ha e il job non l'ha ereditata — due cause con due rimedi.
   */
  NO_JOB_OP: 'NO_JOB_OP',
  /** Il materiale componente non e' una part su Plex: `componentId` non esiste. */
  NO_PLEX_PART: 'NO_PLEX_PART',
  /** Plex ha rifiutato la creazione della riga. */
  POST_REJECTED: 'POST_REJECTED'
});

/** I due sentinelle che `ZCycleAutoAssignConfig.PlexOperation` puo' portare al posto di un codice. */
const SENTINEL = Object.freeze({ FIRST: 'FIRST_OP', LAST: 'LAST_OP' });

/** Quanti materiali si nominano per esteso in `describe` prima di contare i restanti. */
const NAMED_IN_SUMMARY = 3;

/**
 * Il tetto di `ZProdOrderExcLogPOS.Message` / `ZProdOrderExcLogHDR.Message`: `String(255)`, che
 * sqlite ignora e HANA impone. `writeMappingAndLog` taglia comunque, ma tagliare LI' significa
 * perdere la coda — cioe' proprio il «e altri N» che dichiara quanto non si sta vedendo. Il
 * riepilogo si costruisce quindi dentro il budget, non ci finisce dentro per fortuna.
 */
const MESSAGE_MAX_CHARS = 255;

const str = (v) => (v === null || v === undefined) ? '' : String(v).trim();

/**
 * Chiave di confronto di un codice materiale. FUNZIONE PURA.
 *
 * TOLLERANTE SULLA GRAFIA, STRETTA SUGLI ZERI. I due lati vengono da sistemi diversi — il
 * `Material` di SAP e il `componentPartNumber` che Plex restituisce — quindi maiuscole e spazi
 * sono differenze di forma e si assorbono. Gli zeri iniziali NO: allinearli significherebbe
 * decidere il formato di una chiave SAP, ed e' esattamente il divieto di DEC-51. Se un materiale
 * risulta assente per uno zero di troppo, il difetto e' a monte e va visto.
 */
function matKey(v) {
  return str(v).toUpperCase();
}

/**
 * Chiave di confronto di un UUID Plex. FUNZIONE PURA.
 *
 * Insensibile alla grafia, perche' i due lati arrivano da DUE chiamate Plex diverse e
 * `F9EEC9B7…` *e'* `f9eec9b7…` (stessa regola di `normalizeUuid` in recvOpRules.js, W1-03). Non
 * contraddice DEC-51: la' la differenza sarebbe semantica, qui e' solo maiuscolo/minuscolo.
 */
function uuidKey(v) {
  return str(v).toLowerCase();
}

/**
 * La riga BOM che Plex restituisce, nella forma che serve qui. FUNZIONE PURA.
 *
 * `plexBomRules.readBomRow` NON basta: rende `componentPartId` (l'UUID) ma non
 * `componentPartNumber`, che il `BomComponentDto` dichiara e che e' l'unico campo confrontabile con
 * un codice materiale SAP senza prima risolvere N UUID. Il numero e' quindi la chiave del confronto
 * di presenza, e l'UUID resta quello dell'identita'.
 *
 * @param {object} row riga grezza di `GET /engineering/v1/boms`
 * @returns {{bomId: string, partOperationId: string, componentPartId: string,
 *            componentPartNumber: string}}
 */
function readRemoteBomRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    bomId: str(r.id || r.Id),
    partOperationId: str(r.partOperationId || r.PartOperationId),
    componentPartId: str(r.componentPartId || r.componentId || r.ComponentPartId),
    componentPartNumber: str(r.componentPartNumber || r.ComponentPartNumber)
  };
}

/**
 * La part-operation che Plex restituisce, nella forma che serve qui. FUNZIONE PURA.
 *
 * `id` e' la grafia del contratto (`PartOperationDTO`); `partOperationId` e' solo cio' che
 * `syncRoutingPlexCycle` prova per primo da sempre. Si accettano entrambe.
 *
 * @param {object} row riga grezza di `GET /mdm/v1/part-operations`
 * @returns {{id: string, operationId: string, operationNumber: number, active: boolean}}
 */
function readRemotePartOperation(row) {
  const r = row && typeof row === 'object' ? row : {};
  const n = Number(r.operationNumber ?? r.OperationNumber);
  return {
    id: str(r.partOperationId || r.id || r.Id),
    operationId: str(r.operationId || r.OperationId),
    operationNumber: Number.isFinite(n) ? n : 0,
    // Il contratto dichiara `active` NON obbligatorio: assente va letto come ATTIVA, altrimenti un
    // tenant che non lo rende farebbe sparire operazioni che ci sono (W1-03, DEC-63).
    active: (r.active === undefined || r.active === null) ? true : !!r.active
  };
}

/**
 * Le part-operation utilizzabili come bersaglio, ordinate per numero. FUNZIONE PURA.
 *
 * Le DISATTIVATE si scartano: appendere un componente a un'operazione che Plex non esegue piu'
 * equivale a non appenderlo, ma senza dirlo. Una part-operation disattivata non e' nemmeno
 * riattivabile dalla Connect API (DEC-78), quindi non c'e' un rimedio automatico da tentare.
 *
 * @param {Array<object>} rows righe grezze
 * @returns {Array<object>} righe lette, attive, ordinate per `operationNumber` crescente
 */
function usablePartOperations(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(readRemotePartOperation)
    .filter((op) => op.id && op.active)
    .sort((a, b) => a.operationNumber - b.operationNumber);
}

/**
 * I componenti dell'ordine, come insieme di chiavi confrontabili. FUNZIONE PURA.
 *
 * ESISTE PER AVERE UN PUNTO SOLO. La stessa domanda — «questo numero parte di Plex e' uno dei
 * componenti dell'ordine?» — si pone in DUE punti che fanno cose opposte: il prevolo la usa per NON
 * aggiungere un componente che c'e' gia', il passo 7.2 per DISATTIVARE una riga che l'ordine non
 * ha. Finche' erano due confronti scritti a mano hanno divergito: il 7.2 pretendeva stringhe
 * identiche carattere per carattere, il prevolo tollerava maiuscole e spazi. Con `C-NEW` da una
 * parte e `c-new` dall'altra il prevolo concludeva «c'e' gia', non aggiungo» e il 7.2 «non e'
 * nell'ordine, disattivo»: il componente finiva spento su un job che ne aveva bisogno, e l'ordine
 * chiudeva verde.
 *
 * TOLLERANTE, e la regola dice perche': i due lati vengono da SISTEMI DIVERSI — il `Material` di SAP
 * e il numero parte che Plex restituisce — quindi maiuscole e spazi sono differenze di forma
 * (DEC-51, ramo «fra un valore e un valore esterno»). Gli zeri iniziali NO, quelli restano parte
 * della chiave: allinearli significherebbe decidere il formato di una chiave SAP.
 *
 * IN ESERCIZIO NON DOVREBBE MORDERE, ed e' una precisazione utile a chi legge: il numero parte su
 * Plex lo scrive la nostra sincronizzazione materiali copiando il codice SAP, quindi i due sono
 * identici. Questa e' una misura di coerenza fra due punti che devono ragionare allo stesso modo,
 * non la correzione di un difetto osservato.
 *
 * @param {Array<object>} components componenti SAP dell'ordine
 * @returns {Set<string>}
 */
function orderComponentKeys(components) {
  const keys = new Set();
  for (const c of (Array.isArray(components) ? components : [])) {
    const k = matKey(c && c.Material);
    if (k) keys.add(k);
  }
  return keys;
}

/**
 * Questo numero parte di Plex e' uno dei componenti dell'ordine? FUNZIONE PURA.
 *
 * @param {Set<string>} keys da `orderComponentKeys`
 * @param {string} partNumber numero parte come Plex lo restituisce
 * @returns {boolean}
 */
function isOrderComponent(keys, partNumber) {
  const k = matKey(partNumber);
  return !!k && keys instanceof Set && keys.has(k);
}

/**
 * Quali componenti dell'ordine NON hanno alcuna riga sulla distinta della part. FUNZIONE PURA.
 *
 * IL CONFRONTO E' PER SOLO MATERIALE, SU TUTTA LA PART — non per coppia (operazione, materiale).
 * Due ragioni, e vanno insieme. E' la stessa granularita' del passo 7.2, che disattiva una riga BOM
 * del job quando il suo componente non e' fra i materiali dell'ordine: due granularita' diverse
 * sullo stesso oggetto darebbero un aggiungi-e-poi-disattiva a ogni giro. E impedisce il duplicato:
 * un componente gia' presente ma appeso a un'altra operazione verrebbe altrimenti ricreato, e la
 * distinta della part porterebbe due volte lo stesso materiale.
 *
 * @param {object} p
 * @param {Array<object>} p.components componenti SAP dell'ordine (gia' esplosi ed esclusi)
 * @param {Array<object>} p.remoteBomRows righe grezze di `GET /engineering/v1/boms`
 * @returns {{missing: Array<object>, presentCount: number, distinctCount: number}}
 */
function missingComponents({ components, remoteBomRows } = {}) {
  const present = new Set();
  for (const raw of (Array.isArray(remoteBomRows) ? remoteBomRows : [])) {
    const r = readRemoteBomRow(raw);
    if (r.componentPartNumber) present.add(matKey(r.componentPartNumber));
  }

  const seen = new Set();
  const missing = [];
  let presentCount = 0;
  for (const c of (Array.isArray(components) ? components : [])) {
    const key = matKey(c && c.Material);
    if (!key || seen.has(key)) continue;   // un materiale ripetuto e' UNA riga di distinta
    seen.add(key);
    if (present.has(key)) { presentCount++; continue; }
    missing.push(c);
  }
  return { missing, presentCount, distinctCount: seen.size };
}

/**
 * Da bersaglio dell'auto-assegnazione a part-operation di Plex. FUNZIONE PURA.
 *
 * `ZCycleAutoAssignConfig.PlexOperation` puo' portare tre cose diverse — i due sentinelle, l'UUID
 * di catalogo dell'operazione, oppure il suo CODICE — ed e' il chiamante lato client a scioglierle
 * contro l'albero a schermo (`_applyAutoAssignments`). Qui si sciolgono contro cio' che Plex ha
 * davvero sulla part, che e' l'unico insieme su cui si possa scrivere.
 *
 * Il CODICE non e' nella `PartOperationDTO`: la risposta porta `operationId`, non il codice. Serve
 * quindi il catalogo del tenant (`plexOperationCatalog`) per la corrispondenza id -> codice. Se il
 * catalogo non e' stato letto, un bersaglio espresso per codice non si risolve — e si dichiara
 * invece di ripiegare sulla prima operazione, che sarebbe appendere il componente a caso.
 *
 * @param {object} p
 * @param {string} p.target `TargetOperation` dell'assegnazione
 * @param {Array<object>} p.partOperations da `usablePartOperations`, gia' ordinate
 * @param {Map<string,string>|object} [p.codeById] id di catalogo (minuscolo) -> codice operazione
 * @returns {{partOperationId: string, operationNumber: number, via: string}|null}
 *   `null` = nessun bersaglio risolvibile. `operationNumber` e' il **ponte verso la job operation**:
 *   la scrittura non avviene sulla part ma sul job, e `JobOperationDTO` non porta l'`operationId` di
 *   catalogo — porta il codice e il numero. Il numero e' l'unico campo che i due DTO condividono.
 */
function resolveTargetPartOperation({ target, partOperations, codeById } = {}) {
  const ops = Array.isArray(partOperations) ? partOperations : [];
  if (!ops.length) return null;

  const want = str(target);
  if (!want) return null;

  const hit = (op, via) => ({
    partOperationId: op.id, operationNumber: op.operationNumber, via
  });

  if (want === SENTINEL.FIRST) return hit(ops[0], 'FIRST_OP');
  if (want === SENTINEL.LAST) return hit(ops[ops.length - 1], 'LAST_OP');

  // 1. bersaglio espresso come UUID dell'operazione di catalogo
  const byId = ops.find((op) => op.operationId && uuidKey(op.operationId) === uuidKey(want));
  if (byId) return hit(byId, 'OPERATION_ID');

  // 2. bersaglio espresso come codice: serve il catalogo per tradurre id -> codice
  const get = (k) => (codeById instanceof Map ? codeById.get(k) : (codeById || {})[k]);
  const wantCode = matKey(want);
  const byCode = ops.find((op) => {
    const code = get(uuidKey(op.operationId));
    return code && matKey(code) === wantCode;
  });
  if (byCode) return hit(byCode, 'OPERATION_CODE');

  return null;
}

// ================================================================
// Dal PIANO al JOB
// ================================================================

/**
 * La job operation che Plex restituisce, nella forma che serve qui. FUNZIONE PURA.
 *
 * `JobOperationDTO` di `GET /scheduling/v1/jobs/{id}/operations`. Porta `operationCode` — che la
 * `PartOperationDTO` non ha — ma **non** l'`operationId` di catalogo: il ponte con il prevolo, che
 * gira sulle part-operation, e' quindi il NUMERO.
 *
 * @param {object} row
 * @returns {{id: string, number: number, code: string, status: string}}
 */
function readJobOperation(row) {
  const r = row && typeof row === 'object' ? row : {};
  const n = Number(r.jobOperationNumber ?? r.JobOperationNumber);
  return {
    id: str(r.jobOperationId || r.JobOperationId),
    number: Number.isFinite(n) ? n : NaN,
    code: str(r.operationCode || r.OperationCode),
    status: str(r.jobOperationStatus || r.JobOperationStatus)
  };
}

/**
 * Dal piano del prevolo alle righe scrivibili sul job. FUNZIONE PURA.
 *
 * Il ponte e' il numero di operazione: il job nasce dalle part-operation della sua part e ne eredita
 * la numerazione. Un numero che sul job non compare NON si sostituisce con la prima operazione
 * disponibile — si dichiara `NO_JOB_OP`, perche' appendere un componente a un'operazione a caso
 * significa consumarlo nel posto sbagliato, ed e' peggio che non averlo aggiunto.
 *
 * Un numero **ripetuto** fra le job operation e' ambiguo e si rifiuta per la stessa ragione per cui
 * la 0023 rifiuta una lettura che torna piu' righe senza match esatto (DEC-70): la' il rischio era
 * chiudere il job di un altro, qui e' scrivere sull'operazione di un altro.
 *
 * @param {object} p
 * @param {Array<object>} p.plan voci del prevolo, ognuna con `operationNumber`
 * @param {Array<object>} p.jobOperations righe grezze di `GET /scheduling/v1/jobs/{id}/operations`
 * @returns {{entries: Array<object>, failures: Array<object>}}
 */
function bridgeToJobOperations({ plan, jobOperations } = {}) {
  const byNumber = new Map();
  const duplicated = new Set();
  for (const raw of (Array.isArray(jobOperations) ? jobOperations : [])) {
    const op = readJobOperation(raw);
    if (!op.id || !Number.isFinite(op.number)) continue;
    if (byNumber.has(op.number)) duplicated.add(op.number);
    else byNumber.set(op.number, op);
  }

  const entries = [];
  const failures = [];
  for (const item of (Array.isArray(plan) ? plan : [])) {
    const n = Number(item && item.operationNumber);
    const op = Number.isFinite(n) && !duplicated.has(n) ? byNumber.get(n) : null;
    if (!op) {
      failures.push({
        material: str(item && item.material),
        code: FAILURE.NO_JOB_OP,
        detail: duplicated.has(n) ? `numero operazione ${n} ambiguo sul job` : `operazione ${n}`
      });
      continue;
    }
    entries.push({ ...item, jobOpId: op.id, jobOperationCode: op.code });
  }
  return { entries, failures };
}

/**
 * Il body di una riga di distinta del JOB (`JobBomComponentCommand`). FUNZIONE PURA.
 *
 * NON SI RIUSA `plexBomRules.buildCreateBody`, e non è una svista. Fra i due contratti **tre nomi su
 * quattro cambiano** per lo stesso significato:
 *
 *   riga BOM della part            riga BOM del job
 *   ------------------------------ ------------------------------
 *   partOperationId                jobOpId          (e non e' lo stesso oggetto: job op, non part op)
 *   componentId                    componentPartId  (che sulla part e' il nome in LETTURA — DEC-28)
 *   depletionConversionFactor      depletionConversionFact
 *
 * Derivare un nome di scrittura da un altro contratto è esattamente il divieto di DEC-28. I VALORI
 * invece sono gli stessi e si importano da `plexBomRules`: `autoDeplete` e `validate` a `false` sono
 * assunzioni vincolanti della BBP, e riscriverle qui creerebbe un secondo posto in cui sbagliarle.
 *
 * @param {object} p
 * @returns {object}
 */
function buildJobBomBody({
  jobOpId, componentPartId, quantity, depletionUnitOfMeasure, sendValidate, sendFlag
} = {}) {
  const q = Number(quantity);
  const body = {
    jobOpId,
    componentPartId,
    quantity: Number.isFinite(q) ? q : 0
  };
  const uom = str(depletionUnitOfMeasure);
  if (uom) {
    body.depletionUnitOfMeasure = uom;
    // Sulla BOM della part il fattore e' obbligatorio DI FATTO quando l'unita' viaggia, benche' lo
    // schema lo dia opzionale (DEC-68): qui la coppia si manda insieme per la stessa ragione, senza
    // aspettare di scoprirlo da un 400.
    body[JOB_DEPLETION_FACTOR_FIELD] = bomRules.DEPLETION_FACTOR_VALUE;
  }
  if (sendValidate) body.validate = bomRules.VALIDATE_VALUE;
  if (sendFlag) body.autoDeplete = bomRules.AUTODEPLETE_VALUE;
  return body;
}

/**
 * Il testo del motivo di un fallimento, per l'utente. FUNZIONE PURA.
 *
 * @param {{code: string, reason?: string, detail?: string}} f
 * @returns {string}
 */
function failureText(f) {
  const x = f || {};
  switch (x.code) {
    case FAILURE.UNASSIGNED:
      return {
        NO_GROUP: 'nessuna regola di assegnazione lo aggancia',
        NO_MAPPING: 'gruppo agganciato ma nessuna operazione configurata',
        NO_CLFN: 'classificazione non leggibile: assegnazione non decidibile',
        NO_PLANT_DATA: 'dati di plant del materiale non letti'
      }[str(x.reason)] || `non assegnabile (${str(x.reason) || 'motivo ignoto'})`;
    case FAILURE.NO_TARGET_OP:
      return `operazione bersaglio «${str(x.detail) || '?'}» non presente sulla part in Plex`;
    case FAILURE.NO_JOB_OP:
      return `il job non ha l'${str(x.detail) || 'operazione bersaglio'} che la part dichiara`;
    case FAILURE.NO_PLEX_PART:
      return 'materiale non presente come part su Plex';
    case FAILURE.POST_REJECTED:
      return `Plex ha rifiutato la riga (${str(x.detail) || 'nessun dettaglio'})`;
    default:
      return str(x.detail) || 'motivo ignoto';
  }
}

/**
 * La riga compatta per `Message`, che `writeMappingAndLog` taglia a 255 caratteri. FUNZIONE PURA.
 *
 * Nomina i primi materiali con il loro motivo e conta i restanti: il dettaglio integrale sta negli
 * `steps`, che finiscono in `ZProdOrderExcLogPOS` senza limite di lunghezza. Un elenco tagliato a
 * meta' dalla colonna sarebbe peggio di un elenco dichiaratamente parziale.
 *
 * QUANTI NOMI ENTRANO LO DECIDE IL BUDGET, non solo `NAMED_IN_SUMMARY`. Un motivo lungo — «gruppo
 * agganciato ma nessuna operazione configurata» sono 48 caratteri — con tre materiali da dodici
 * cifre supera i 255 da solo. Si aggiungono nomi finche' ci stanno, e il conteggio dei restanti
 * resta SEMPRE: e' l'unica parte che non si puo' perdere, perche' e' quella che dice che si sta
 * guardando un elenco parziale.
 *
 * @param {Array<{material: string, code: string, reason?: string, detail?: string}>} failures
 * @param {number} [maxChars=MESSAGE_MAX_CHARS] budget disponibile per questa stringa
 * @returns {string}
 */
function describe(failures, maxChars) {
  const list = Array.isArray(failures) ? failures : [];
  if (!list.length) return '';
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : MESSAGE_MAX_CHARS;

  const head = `${list.length} componenti dell'ordine non sono sulla distinta della part in Plex e`
    + ' non si sono potuti aggiungere: ';
  const compose = (names) => {
    const rest = list.length - names.length;
    return `${head}${names.join('; ')}${rest > 0 ? ` e altri ${rest}` : ''}.`;
  };

  const names = [];
  for (const f of list.slice(0, NAMED_IN_SUMMARY)) {
    const candidate = names.concat(`${str(f.material)} (${failureText(f)})`);
    if (compose(candidate).length > budget) break;
    names.push(candidate[candidate.length - 1]);
  }

  // Nemmeno un nome ci sta: si dichiara il solo conteggio. E' il caso patologico, ma un messaggio
  // troncato a meta' parola sarebbe peggio di un messaggio che dice meno e lo dice per intero.
  if (!names.length) {
    return `${list.length} componenti dell'ordine non sono sulla distinta della part in Plex e non`
      + ' si sono potuti aggiungere. Il dettaglio è nella traccia della sequenza.';
  }
  return compose(names);
}

module.exports = {
  FAILURE,
  SENTINEL,
  NAMED_IN_SUMMARY,
  MESSAGE_MAX_CHARS,
  JOB_DEPLETION_FACTOR_FIELD,
  matKey,
  orderComponentKeys,
  isOrderComponent,
  uuidKey,
  readRemoteBomRow,
  readRemotePartOperation,
  usablePartOperations,
  missingComponents,
  resolveTargetPartOperation,
  readJobOperation,
  bridgeToJobOperations,
  buildJobBomBody,
  failureText,
  describe
};

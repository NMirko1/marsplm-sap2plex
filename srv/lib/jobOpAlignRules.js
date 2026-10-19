/**
 * [JOB-OP-ALIGN] Quali operazioni del job Plex vanno disattivate.
 *
 * LA REGOLA, dichiarata dal committente il 27/08/2026:
 *
 *   > Le operazioni del nostro albero devono essere presenti nel job Plex. Quelle che il job ha IN
 *   > PIU' rispetto all'albero vanno disattivate.
 *
 * IL DIFETTO CHE QUESTO MODULO CHIUDE. Fino a qui il passo 6.3 di
 * srv/jobs/createPlexProductionOrders.js confrontava le operazioni del job con le operazioni
 * dell'ordine SAP, e le confrontava per NUMERO:
 *
 *     sapOpNumbers = { parseInt('0010'), parseInt('0020') }        // 10, 20
 *     if (!sapOpNumbers.has(Number(jobOp.Op_No))) -> NOT Required
 *
 * Due cose sbagliate, indipendenti.
 *
 *   1. IL TERMINE DI CONFRONTO. Le operazioni di un job Plex le deriva Plex dalla ROUTING DELLA
 *      PART, non da SAP. Confrontarle con la numerazione SAP mette a confronto due insiemi che non
 *      hanno motivo di coincidere: sull'ordine 000700000243 sono quattro operazioni Plex agganciate
 *      a due operazioni SAP, e le due che avanzavano venivano spente pur essendo nell'albero.
 *
 *   2. IL NUMERO NON IDENTIFICA NIENTE: E' POSIZIONALE. Nasce da `(indice + 1) * 10` quando il
 *      ciclo viene costruito, e i due sistemi possono numerare lo stesso insieme in ordine diverso.
 *      La prova sta nel dossier versionato srv/external/PLEX_ISSUE_BACKWARDS_SCHEDULE_500.it.md:
 *      su un job dello stesso materiale la Data Source 4701 restituisce `30 -> L1901…` e
 *      `40 -> L1500…`, mentre nell'albero dell'ordine la 30 e' `L1500…` e la 40 e' `L1901…`. Gli
 *      stessi numeri sulle operazioni SCAMBIATE: un confronto per numero avrebbe tenuto le righe
 *      sbagliate credendo di aver agganciato.
 *
 * SI CONFRONTANO GLI IDENTIFICATIVI, E LA CATENA HA TRE ANELLI.
 * Sul lato job l'UUID NON ESISTE: la Data Source 4701 restituisce `Op_No`, `Operation_Code`,
 * `Job_Op_Key` e `Part_Operation_Key` (interi), e anche `GET /scheduling/v1/jobs/{id}/operations`
 * porta `operationCode` ma non l'`operationId` di catalogo — sta scritto in
 * srv/external/PLEX_JOB_API_CONTRACT.md. L'anello che chiude la catena e' il catalogo operazioni del
 * tenant, che il progetto legge gia' (`GET /mdm/v1/operations`, `OperationDTO { id, code, type }`):
 *
 *     riga del job --Operation_Code--> catalogo del tenant --> id  ==?  ZPlexCycleOperation.PlexOperationId
 *
 * QUELLO CHE NON SI VALUTA NON SI SOTTRAE. Una riga del job senza codice, o il cui codice non si
 * risolve nel catalogo, NON viene disattivata: la' il criterio non e' valutabile su quella riga, e
 * un criterio non valutabile non sottrae (DEC-56). L'errore qui e' DISTRUTTIVO — un'operazione spenta
 * e' un passo che in fabbrica non si esegue — quindi nel dubbio si tiene e si DICHIARA.
 *
 * UN CODICE AMBIGUO SI RIFIUTA. Due righe di catalogo con lo stesso codice e id diversi non
 * autorizzano a prendere la prima: e' la regola di DEC-78 e DEC-80, e qui sceglierne una potrebbe
 * spegnere l'operazione giusta.
 *
 * «NON LO SO» NON DIVENTA «NON C'E'» (DEC-80). Se l'albero e' vuoto o il catalogo non e' stato letto,
 * l'insieme di confronto non esiste e NON si disattiva niente: era esattamente il guasto dell'ordine
 * 000700000243, dove l'insieme SAP arrivava vuoto e la sottrazione spegneva l'intero job in silenzio.
 *
 * FUNZIONI PURE: nessun `cds`, nessuna rete. Le letture le fa l'orchestrazione, la decisione sta qui
 * — ed e' cio' che la rende collaudabile a secco (test/jobOpAlignRules.test.js).
 *
 * Perimetro: grep -rn "JOB-OP-ALIGN"
 */

'use strict';

// La regola dell'UUID case-insensitive vive in un punto solo (DEC-63): i due lati vengono da due
// chiamate Plex diverse, e `F9EEC9B7…` E' `f9eec9b7…`.
const { normalizeUuid } = require('./recvOpRules');

/** Le colonne che la SELECT sull'albero deve chiedere. In un posto solo, cosi' non divergono. */
const TREE_COLUMNS = Object.freeze(['PlexOperationId', 'OperationCode', 'OperationNumber']);

const ACTION = Object.freeze({ KEEP: 'KEEP', DEACTIVATE: 'DEACTIVATE' });

/**
 * I codici di causa. Sono CODICI e non frasi: e' su questi che il log raggruppa, e un codice non si
 * traduce (stessa scelta di `cause` in srv/lib/prodConfOperationBridge.js).
 */
const CAUSE = Object.freeze({
  IN_TREE: 'IN_TREE',                   // c'e' nell'albero -> si tiene
  NOT_IN_TREE: 'NOT_IN_TREE',           // il job ce l'ha in piu' -> si disattiva
  NO_CODE: 'NO_CODE',                   // la riga del job non porta il codice -> si tiene
  NOT_IN_CATALOG: 'NOT_IN_CATALOG',     // il codice non e' nel catalogo del tenant -> si tiene
  AMBIGUOUS_CODE: 'AMBIGUOUS_CODE'      // due righe di catalogo con lo stesso codice -> si tiene
});

/** Perche' l'insieme di confronto non esiste. Vuoto = esiste, si e' potuto decidere. */
const NOT_EVALUABLE = Object.freeze({
  NO_TREE: 'NO_TREE',                   // l'albero dell'ordine e' vuoto o non e' stato letto
  NO_CATALOG: 'NO_CATALOG'              // il catalogo operazioni del tenant non e' stato letto
});

/**
 * Chiave di confronto di un codice operazione. FUNZIONE PURA.
 *
 * `trim` e maiuscole/minuscole appiattite. I due lati vengono da due chiamate Plex diverse dello
 * STESSO tenant, quindi un disallineamento di grafia non e' un dato da vedere ma un accidente del
 * canale — e qui l'errore e' distruttivo: un codice che differisse per la sola grafia farebbe
 * spegnere un'operazione che serve. E' lo stesso verso di DEC-63, sull'altra specie di chiave.
 */
function opCodeKey(value) {
  return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
}

/**
 * L'indice `codice -> id` del catalogo operazioni del tenant. FUNZIONE PURA.
 *
 * @param {Array<object>} operations righe gia' mappate da `plexOperationCatalog.mapOperation`
 *   (servono `id` e `code`)
 * @returns {{byCode: Map<string,string>, ambiguousCodes: Set<string>}}
 *   un codice ambiguo NON sta in `byCode`: sta solo in `ambiguousCodes`, cosi' chi interroga non
 *   puo' ottenere per sbaglio uno dei due id.
 */
function buildCodeIndex(operations) {
  const byCode = new Map();
  const ambiguousCodes = new Set();
  for (const op of Array.isArray(operations) ? operations : []) {
    if (!op) continue;
    const code = opCodeKey(op.code);
    const id = normalizeUuid(op.id);
    if (!code || !id) continue;
    if (ambiguousCodes.has(code)) continue;
    const seen = byCode.get(code);
    if (seen === undefined) {
      byCode.set(code, id);
    } else if (seen !== id) {
      // Due id diversi sotto lo stesso codice: la voce si RITIRA, non si tiene la prima.
      byCode.delete(code);
      ambiguousCodes.add(code);
    }
  }
  return { byCode, ambiguousCodes };
}

/**
 * L'insieme degli id delle operazioni del NOSTRO albero. FUNZIONE PURA.
 *
 * @param {Array<object>} rows righe di ZPlexCycleOperation (serve `PlexOperationId`)
 * @returns {Set<string>} UUID normalizzati; le righe senza id non entrano
 */
function treeOperationIds(rows) {
  const out = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = normalizeUuid(r && r.PlexOperationId);
    if (id) out.add(id);
  }
  return out;
}

/**
 * La decisione, riga per riga. FUNZIONE PURA.
 *
 * @param {object} args
 * @param {Array<object>} args.jobOps righe della Data Source 4701 (`Job_Op_Key`, `Op_No`,
 *   `Operation_Code`)
 * @param {Set<string>|Array<string>} args.cycleOpIds da `treeOperationIds`
 * @param {{ok: boolean, byCode: Map<string,string>, ambiguousCodes: Set<string>}|null} args.catalog
 *   `ok: false` o `null` = catalogo non letto, che NON e' un catalogo vuoto
 * @returns {{evaluable: boolean, notEvaluable: string, decisions: Array<object>, stats: object}}
 *   `decisions` e' VUOTO quando `evaluable` e' `false`: senza insieme di confronto non c'e' niente
 *   da decidere, e in particolare niente da spegnere.
 */
function decideJobOperations({ jobOps, cycleOpIds, catalog } = {}) {
  const rows = (Array.isArray(jobOps) ? jobOps : []).filter(Boolean);
  const tree = cycleOpIds instanceof Set ? cycleOpIds : new Set(
    (Array.isArray(cycleOpIds) ? cycleOpIds : []).map(normalizeUuid).filter(Boolean)
  );
  const catalogOk = !!(catalog && catalog.ok && catalog.byCode instanceof Map);
  const ambiguous = catalog && catalog.ambiguousCodes instanceof Set ? catalog.ambiguousCodes : new Set();

  const base = { tree: tree.size, job: rows.length, deactivate: 0, keep: 0, unevaluable: 0 };

  // I due modi in cui l'insieme di confronto non esiste. L'ordine conta solo per il messaggio: la
  // conseguenza e' la stessa, e non e' «disattivo tutto».
  if (!tree.size) {
    return { evaluable: false, notEvaluable: NOT_EVALUABLE.NO_TREE, decisions: [], stats: base };
  }
  if (!catalogOk) {
    return { evaluable: false, notEvaluable: NOT_EVALUABLE.NO_CATALOG, decisions: [], stats: base };
  }

  const decisions = [];
  for (const row of rows) {
    const code = opCodeKey(row.Operation_Code);
    const entry = {
      jobOpKey: row.Job_Op_Key,
      opNo: row.Op_No,
      code: String(row.Operation_Code === null || row.Operation_Code === undefined ? '' : row.Operation_Code).trim(),
      action: ACTION.KEEP,
      cause: CAUSE.NO_CODE
    };

    if (!code) {
      base.unevaluable++;
    } else if (ambiguous.has(code)) {
      entry.cause = CAUSE.AMBIGUOUS_CODE;
      base.unevaluable++;
    } else {
      const id = catalog.byCode.get(code);
      if (!id) {
        entry.cause = CAUSE.NOT_IN_CATALOG;
        base.unevaluable++;
      } else if (tree.has(id)) {
        entry.cause = CAUSE.IN_TREE;
        base.keep++;
      } else {
        entry.action = ACTION.DEACTIVATE;
        entry.cause = CAUSE.NOT_IN_TREE;
        base.deactivate++;
      }
    }
    decisions.push(entry);
  }

  return { evaluable: true, notEvaluable: '', decisions, stats: base };
}

/**
 * L'insieme dei componenti dell'ordine esiste? FUNZIONE PURA.
 *
 * Il passo 7.2 disattiva le righe BOM del job che l'ordine non ha, e il termine di confronto resta
 * quello di DEC-74 / DEC-87 — i componenti SAP con esclusioni di plant e rimozioni manuali gia'
 * applicate. Quello che manca e' il presidio gemello: un insieme di confronto VUOTO — lettura SAP a
 * zero righe — porterebbe a `Active = 0` l'INTERA distinta del lotto, in silenzio.
 *
 * `null`/`undefined` e lista vuota si trattano allo stesso modo, e di proposito: un ordine di
 * produzione senza componenti non e' un caso da cui valga la pena distinguersi, mentre una lettura
 * andata a vuoto lo e' — e le due arrivano qui indistinguibili. Nel dubbio non si sottrae.
 *
 * @param {Array<object>|null|undefined} components
 * @returns {boolean}
 */
function componentsEvaluable(components) {
  return Array.isArray(components) && components.length > 0;
}

module.exports = {
  TREE_COLUMNS,
  ACTION,
  CAUSE,
  NOT_EVALUABLE,
  opCodeKey,
  buildCodeIndex,
  treeOperationIds,
  decideJobOperations,
  componentsEvaluable
};

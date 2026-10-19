/**
 * [ORDER-STATUS-FILTER] Perimetro degli ordini di produzione, per plant (feature 0017).
 * [W1-09] Esteso ai criteri su VALORE: tipo ordine (AUART) e responsabile di schedulazione (FEVOR).
 *
 * Perimetro completo della feature: grep -rn "ORDER-STATUS-FILTER"
 * Perimetro della sola estensione W1-09: grep -rn "W1-09"
 *
 * Decide, a partire dal customizing ZProdOrderFilterConfig, QUALI ordini SAP entrano in
 * perimetro. È il punto UNICO in cui quella decisione viene presa: prima della 0017 il criterio
 * era cablato nel job («rilasciato, non chiuso, non cancellato», il vecchio RELEASED_STATE di
 * prodOrderSource.js) e la dashboard non ne aveva nessuno, quindi i due mostravano insiemi
 * diversi. I consumatori sono quattro e passano tutti da qui: il criterio nuovo si aggiunge in
 * questo modulo, non in quattro posti.
 *
 * SEMANTICA:
 *   - `required`:    l'ordine deve avere TUTTI questi flag impostati   (AND);
 *   - `excluded`:    l'ordine non deve averne impostato NESSUNO        (AND NOT);
 *   - `orderTypes`:  il tipo ordine dev'essere UNO di questi           (OR);
 *   - `supervisors`: il responsabile dev'essere UNO di questi          (OR);
 *   - i quattro elenchi fra loro sono in AND; un elenco VUOTO non vincola;
 *   - plant SENZA riga di configurazione => NESSUN ordine di quel plant, per nessuno.
 *
 * [W1-09] FLAG IN AND, VALORI IN OR: non è un'incoerenza. Un flag è booleano e «tutti impostati»
 * è soddisfacibile; un campo a valore singolo no — un ordine ha UN tipo ordine, quindi
 * «richiesti PP01 e PP02» sarebbe un perimetro vuoto, non un perimetro stretto. Per la stessa
 * ragione i due elenchi di valore non hanno il gemello «esclusi».
 *
 * È IL GEMELLO ROVESCIATO DI routingVisibility.js. Stessa forma, stesso stile, stessa
 * separazione fra confronto puro e caricamento — ma il ramo «non configurato» è l'opposto:
 * là nessuna regola significa nessuna restrizione (fail-open), qui significa nessun ordine
 * (fail-closed). La ragione è che questo perimetro governa anche ciò che viene SCRITTO su
 * Plex: un plant non configurato che ricadesse in «nessun filtro» manderebbe in produzione
 * ordini mai rilasciati. Se cambi la semantica qui, NON allinearla a quella di là senza
 * leggere prima docs/0017.
 *
 * Consumato da:
 *   - srv/cat-service.js  READ ProductionOrders          (lista del cockpit)
 *   - srv/cat-service.js  createJobInPlex, splitProdOrder (gate delle azioni manuali)
 *   - srv/cat-service.js  prodOrderScope                  («perché la lista è vuota?»)
 *   - srv/jobs/createPlexProductionOrders.js              (perimetro del job pianificato)
 *
 * Le funzioni pure non dipendono da `cds`, dalla rete o dal database, e hanno il proprio test:
 *     node test/prodOrderStatusFilter.test.js
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

/**
 * [W1-09] Il confronto tollerante NON si riscrive qui: e' gia' quello di routingVisibility.js, e
 * i due casi sono lo stesso caso — un codice DIGITATO da un utente confrontato con un valore che
 * arriva da SAP, dove DEC-51 impone tolleranza sugli zeri iniziali perche' il difetto sarebbe
 * nostro. `unpad` agisce solo su token interamente numerici, quindi su un AUART alfanumerico
 * come 'PP01' non tocca niente. Importarlo invece di ricopiarlo e' cio' che tiene allineate le
 * due tolleranze: se un giorno una delle due cambia, cambiano insieme o non cambiano.
 * Il modulo importato non dipende da `cds` ne' dalla rete, quindi questo resta collaudabile con
 * `node test/prodOrderStatusFilter.test.js`.
 */
const { codeMatches } = require('./routingVisibility');

/**
 * Nome pienamente qualificato dell'entita', non `db.entities(NS)`: quello e' deprecato in CAP 9
 * e, soprattutto, NON e' invocabile in contesto job standalone. Stessa scelta di
 * routingVisibility.js e dei job.
 */
const E_FILTER = 'avvaleplm.marsplm.sap2plex.ZProdOrderFilterConfig';

/**
 * I 20 flag di stato della testata d'ordine, nell'ordine in cui li dichiara
 * A_ProductionOrder_2 (srv/external/OP_API_PRODUCTION_ORDER_2_SRV_0001.cds:1246-1265) e in cui
 * li porta la struttura ABAP ZMARS_PROD_ORDER dietro l'iFlow ZMARS_PROD_ORDER_GET.
 *
 * E' una lista CHIUSA, a differenza dei codici di ZRoutingFilterConfig: questi non sono
 * customizing del cliente, sono i nomi dei campi del contratto OData. Un nome fuori catalogo
 * non e' un valore esotico da rispettare, e' un errore di battitura che filtrerebbe a vuoto.
 *
 * ATTENZIONE: solo quattro di questi (`OrderIsReleased`, `OrderIsConfirmed`, `OrderIsClosed`,
 * `OrderIsDeleted`) erano nel $select prima della 0017 e sono gli unici dichiarati nel
 * contratto E-12/E-13. Gli altri esistono nella struttura ABAP ma la loro presenza EFFETTIVA
 * nella risposta dell'iFlow va verificata sul filo prima di fidarsene: `unavailable` di
 * applyStatusFilter() serve esattamente a questo, e non tace.
 *
 * L'ordine conta: e' quello in cui le liste vengono normalizzate e riscritte a video.
 */
const STATUS_CATALOG = Object.freeze([
  'OrderIsCreated',
  'OrderIsReleased',
  'OrderIsPrinted',
  'OrderIsConfirmed',
  'OrderIsPartiallyConfirmed',
  'OrderIsDelivered',
  'OrderIsDeleted',
  'OrderIsPreCosted',
  'SettlementRuleIsCreated',
  'OrderIsPartiallyReleased',
  'OrderIsLocked',
  'OrderIsTechnicallyCompleted',
  'OrderIsClosed',
  'OrderIsPartiallyDelivered',
  'OrderIsMarkedForDeletion',
  'SettlementRuleIsCrtedManually',
  'OrderIsScheduled',
  'OrderHasGeneratedOperations',
  'OrderIsToBeHandledInBatches',
  'MaterialAvailyIsNotChecked'
]);

/** Indice minuscolo -> nome canonico, per il match case-insensitive della normalizzazione. */
const CATALOG_BY_LOWER = new Map(STATUS_CATALOG.map((f) => [f.toLowerCase(), f]));

/** Posizione nel catalogo, per riordinare le liste normalizzate. */
const CATALOG_ORDER = new Map(STATUS_CATALOG.map((f, i) => [f, i]));

/** Limite di colonna di tutte e quattro le liste (schema: String(600)). */
const LIST_MAX_LENGTH = 600;

/** Separatore delle liste. Il punto e virgola, come gli altri elenchi del customizing ordini. */
const SEP = ';';

/**
 * [W1-09] I criteri su VALORE: i due assi con cui la BBP §8.2.1 definisce il perimetro Plex.
 *
 * A differenza degli stati NON hanno un catalogo: AUART e FEVOR sono customizing del cliente
 * (T003O, T024F) e un elenco chiuso sarebbe sbagliato per chi ne ha aggiunti — e' la stessa
 * scelta di ZRoutingFilterConfig. L'unico controllo possibile alla scrittura e' `maxLen`, la
 * lunghezza DDIC del campo: un codice piu' lungo non puo' esistere in SAP, quindi non e' un
 * valore esotico da rispettare, e' un errore di battitura che filtrerebbe a vuoto.
 *
 *   `list`     nome della colonna sul customizing
 *   `cfg`      nome della proprieta' nel criterio caricato in memoria
 *   `sapField` campo di A_ProductionOrder_2 su cui si confronta
 *   `maxLen`   lunghezza DDIC (AUFART CHAR(4), FEVOR CHAR(3))
 *
 * L'ordine di questo elenco e' quello in cui i campi vengono aggiunti al `$select` e nominati
 * nei messaggi: e' stabile perche' due esecuzioni non devono produrre due `$select` diversi.
 */
const VALUE_CRITERIA = Object.freeze([
  Object.freeze({ list: 'OrderTypes', cfg: 'orderTypes', sapField: 'ManufacturingOrderType', maxLen: 4 }),
  Object.freeze({ list: 'ProductionSupervisors', cfg: 'supervisors', sapField: 'ProductionSupervisor', maxLen: 3 })
]);

/** I due campi SAP dei criteri su valore, nell'ordine di VALUE_CRITERIA. */
const VALUE_FIELDS = Object.freeze(VALUE_CRITERIA.map((c) => c.sapField));

// ================================================================
// Normalizzazione e validazione delle liste
// ================================================================

/** `trim` e nient'altro. */
function s(v) {
  return String(v ?? '').trim();
}

/**
 * Da stringa a nomi canonici.
 *
 * Accetta `;` e `,` come separatori — chi ha configurato l'elenco degli stati congelati della
 * 0014 ha imparato la virgola, e farlo fallire qui sarebbe una trappola gratuita.
 * Il match e' case-insensitive, il risultato e' deduplicato e RIORDINATO come il catalogo:
 * cosi' due configurazioni equivalenti si scrivono nello stesso modo, e la UI puo' riscrivere
 * a video il valore normalizzato dopo il salvataggio (pattern 0014).
 *
 * @param {*} list
 * @returns {{ codes: string[], unknown: string[] }} `unknown` conserva i token cosi' come sono
 *          stati scritti, perche' e' quello che va rimandato all'utente nel messaggio d'errore
 */
function parseList(list) {
  const raw = s(list);
  if (!raw) return { codes: [], unknown: [] };
  const codes = [];
  const unknown = [];
  const seen = new Set();
  for (const token of raw.split(/[;,]/)) {
    const t = s(token);
    if (!t) continue;
    const canonical = CATALOG_BY_LOWER.get(t.toLowerCase());
    if (!canonical) {
      if (!unknown.includes(t)) unknown.push(t);
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    codes.push(canonical);
  }
  codes.sort((a, b) => CATALOG_ORDER.get(a) - CATALOG_ORDER.get(b));
  return { codes, unknown };
}

/**
 * [W1-09] Da stringa a codici, per i due elenchi di VALORE.
 *
 * Gemella di parseList ma senza catalogo, quindi con tre differenze che vanno capite insieme:
 *
 *  1. NON riordina. Nei due elenchi di stato l'ordine e' quello del catalogo, cosi' due
 *     configurazioni equivalenti si scrivono nello stesso modo; qui un ordine canonico non
 *     esiste, e riordinare alfabeticamente rimescolerebbe una lista che l'utente ha scritto
 *     nell'ordine che gli e' comodo. Si conserva il suo.
 *  2. Mette in MAIUSCOLO. Non e' una nostra riscrittura del dato: `ManufacturingOrderType` e
 *     `ProductionSupervisor` sono entrambi @sap.display.format:'UpperCase' nel CSN, cioe' SAP li
 *     tiene gia' cosi'. Senza, chi digita 'pp01' otterrebbe una lista vuota e nessun modo di
 *     capirlo. Gli zeri iniziali invece NON si toccano: quelli li normalizza il CONFRONTO
 *     (codeMatches), che e' la sola cosa che DEC-51 autorizza a normalizzare.
 *  3. Segnala i token piu' lunghi del campo DDIC invece dei token fuori catalogo.
 *
 * @param {*} list
 * @param {number} maxLen lunghezza DDIC del codice
 * @returns {{ codes: string[], tooLong: string[] }} `tooLong` conserva i token come sono stati
 *          scritti, perche' e' quello che va rimandato all'utente nel messaggio d'errore
 */
function parseCodeList(list, maxLen) {
  const raw = s(list);
  if (!raw) return { codes: [], tooLong: [] };
  const codes = [];
  const tooLong = [];
  const seen = new Set();
  for (const token of raw.split(/[;,]/)) {
    const t = s(token).toUpperCase();
    if (!t) continue;
    if (maxLen && t.length > maxLen) {
      if (!tooLong.includes(t)) tooLong.push(t);
      continue;
    }
    if (seen.has(t)) continue;
    seen.add(t);
    codes.push(t);
  }
  return { codes, tooLong };
}

/** Da nomi canonici a stringa da persistere. */
function formatList(codes) {
  return (Array.isArray(codes) ? codes : []).join(SEP);
}

/**
 * Validazione delle due liste di una riga di customizing.
 *
 * Restituisce gli errori invece di sollevare: il chiamante e' un handler `before` che deve
 * poter emettere `req.error` con il `target` giusto, e la UI mostra il testo cosi' com'e'.
 *
 * @param {{ RequiredStatuses?: string, ExcludedStatuses?: string,
 *           OrderTypes?: string, ProductionSupervisors?: string }} row
 * @returns {{ errors: Array<{field: string, code: string, tokens?: string[], max?: number}>,
 *             RequiredStatuses: string, ExcludedStatuses: string,
 *             OrderTypes: string, ProductionSupervisors: string,
 *             required: string[], excluded: string[],
 *             orderTypes: string[], supervisors: string[] }}
 */
function validateFilter(row) {
  const r = parseList(row && row.RequiredStatuses);
  const e = parseList(row && row.ExcludedStatuses);
  const errors = [];

  if (r.unknown.length) errors.push({ field: 'RequiredStatuses', code: 'unknown', tokens: r.unknown });
  if (e.unknown.length) errors.push({ field: 'ExcludedStatuses', code: 'unknown', tokens: e.unknown });

  // Uno stato richiesto E escluso non e' un criterio restrittivo: e' un criterio che nessun
  // ordine puo' soddisfare, cioe' un plant spento per errore. Si rifiuta invece di lasciarlo
  // passare e far cercare per giorni perche' la lista e' vuota.
  const both = r.codes.filter((c) => e.codes.includes(c));
  if (both.length) errors.push({ field: 'RequiredStatuses', code: 'contradiction', tokens: both });

  const required = formatList(r.codes);
  const excluded = formatList(e.codes);
  if (required.length > LIST_MAX_LENGTH) errors.push({ field: 'RequiredStatuses', code: 'tooLong' });
  if (excluded.length > LIST_MAX_LENGTH) errors.push({ field: 'ExcludedStatuses', code: 'tooLong' });

  // [W1-09] I due elenchi di valore. Nessuna contraddizione da cercare: non esiste il gemello
  // «esclusi», e due codici diversi nello stesso elenco sono un OR, non un conflitto.
  const out = {
    errors,
    RequiredStatuses: required,
    ExcludedStatuses: excluded,
    required: r.codes,
    excluded: e.codes
  };
  for (const c of VALUE_CRITERIA) {
    const p = parseCodeList(row && row[c.list], c.maxLen);
    if (p.tooLong.length) {
      errors.push({ field: c.list, code: 'codeTooLong', tokens: p.tooLong, max: c.maxLen });
    }
    const text = formatList(p.codes);
    if (text.length > LIST_MAX_LENGTH) errors.push({ field: c.list, code: 'tooLong' });
    out[c.list] = text;
    out[c.cfg] = p.codes;
  }
  return out;
}

// ================================================================
// Valutazione di un ordine
// ================================================================

/**
 * Il flag e' impostato?
 *
 * SAP manda `XFELD`: `'X'` quando e' acceso, spazio o stringa vuota quando non lo e'.
 * Deliberatamente PIU' TOLLERANTE del vecchio `isReleasedOpenOrder`, che pretendeva `=== ''`
 * sui flag negativi e avrebbe considerato «chiuso» un ordine il cui `OrderIsClosed` fosse
 * arrivato come `' '`. Qui si guarda solo se c'e' la X.
 */
function isSet(v) {
  return s(v).toUpperCase() === 'X';
}

/**
 * Il valore del flag e' ARRIVATO dalla sorgente?
 *
 * `undefined` / `null` = il campo non c'e' nella risposta, ed e' un caso diverso da «non
 * impostato»: significa che il criterio configurato NON E' VALUTABILE. La stringa vuota invece
 * e' un valore, e vale «non impostato».
 */
function isPresent(v) {
  return v !== undefined && v !== null;
}

/**
 * [W1-09] Gli assi su valore effettivamente configurati in un criterio.
 * @returns {Array<{list, cfg, sapField, maxLen, codes: string[]}>}
 */
function activeValueCriteria(cfg) {
  const out = [];
  for (const c of VALUE_CRITERIA) {
    const codes = (cfg && cfg[c.cfg]) || [];
    if (codes.length) out.push({ ...c, codes });
  }
  return out;
}

/**
 * [W1-09] Almeno un plant in perimetro ha un criterio su valore?
 *
 * Serve ai due call site per una ragione precisa: i criteri su valore si valutano SEMPRE a valle
 * (non si spingono, vedi la testata di pushableWhere), quindi la loro presenza deve accendere il
 * filtro a valle ANCHE quando i flag di stato sono stati spinti. Senza, in ONPREM con criterio
 * unico il ramo a valle non girerebbe e il criterio su FEVOR non verrebbe mai valutato: un
 * fail-OPEN silenzioso, proprio sull'asse nuovo.
 *
 * @param {Map|Iterable} cfgs
 */
function hasValueCriteria(cfgs) {
  const list = cfgs instanceof Map ? [...cfgs.values()] : [...(cfgs || [])];
  return list.some((cfg) => activeValueCriteria(cfg).length > 0);
}

/**
 * L'ordine soddisfa il criterio del suo plant?
 *
 * @param {object} order riga con i flag di stato e i campi valore
 * @param {{required: string[], excluded: string[], orderTypes?: string[], supervisors?: string[]}} cfg
 * @returns {{ passes: boolean, missing: string[], failedValue: object|null }}
 *          `missing` = campi citati dal criterio che non sono ARRIVATI sulla riga. Con `missing`
 *          non vuoto `passes` e' SEMPRE false: un criterio non valutabile non si ignora (vedi la
 *          testata del file).
 *          [W1-09] `failedValue` = l'asse su valore che ha respinto l'ordine, con il valore che
 *          l'ordine porta davvero: e' cio' che spiega il rifiuto a chi preme un pulsante, e la
 *          stringa vuota va mostrata come tale — un FEVOR sempre vuoto e' il sintomo che DEC-64
 *          insegna a riconoscere.
 */
function orderPasses(order, cfg) {
  const row = order || {};
  const required = (cfg && cfg.required) || [];
  const excluded = (cfg && cfg.excluded) || [];
  const values = activeValueCriteria(cfg);

  const missing = [
    ...required, ...excluded, ...values.map((v) => v.sapField)
  ].filter((f) => !isPresent(row[f]));
  if (missing.length) return { passes: false, missing, failedValue: null };

  const okRequired = required.every((f) => isSet(row[f]));
  const okExcluded = excluded.every((f) => !isSet(row[f]));
  if (!okRequired || !okExcluded) return { passes: false, missing: [], failedValue: null };

  // [W1-09] OR dentro l'elenco, AND fra gli assi. Confronto TOLLERANTE (DEC-51): '1' configurato
  // aggancia '001' letto da SAP, e viceversa.
  for (const v of values) {
    if (!v.codes.some((code) => codeMatches(code, row[v.sapField]))) {
      return {
        passes: false,
        missing: [],
        failedValue: { list: v.list, sapField: v.sapField, expected: v.codes, actual: s(row[v.sapField]) }
      };
    }
  }
  return { passes: true, missing: [], failedValue: null };
}

/**
 * I campi da aggiungere al `$select` perche' i criteri in vigore siano valutabili.
 *
 * Unione su TUTTI i plant in perimetro: la lista del cockpit legge piu' plant in una sola
 * query, quindi il `$select` deve bastare al criterio piu' esigente fra quelli coinvolti.
 *
 * [W1-09] I due campi dei criteri su valore escono DOPO i flag e nell'ordine di VALUE_CRITERIA,
 * non mescolati fra loro: non hanno una posizione nel catalogo degli stati, quindi
 * `CATALOG_ORDER.get()` restituirebbe `undefined` e l'ordinamento diventerebbe indefinito.
 *
 * @param {Map<string, {required: string[], excluded: string[]}>|Iterable} cfgs
 * @returns {string[]} nomi di campo: prima i flag nell'ordine del catalogo, poi i campi valore
 */
function selectColumns(cfgs) {
  const list = cfgs instanceof Map ? [...cfgs.values()] : [...(cfgs || [])];
  const flags = new Set();
  const values = new Set();
  for (const cfg of list) {
    for (const f of (cfg && cfg.required) || []) flags.add(f);
    for (const f of (cfg && cfg.excluded) || []) flags.add(f);
    for (const v of activeValueCriteria(cfg)) values.add(v.sapField);
  }
  return [
    ...[...flags].sort((a, b) => CATALOG_ORDER.get(a) - CATALOG_ORDER.get(b)),
    ...VALUE_FIELDS.filter((f) => values.has(f))
  ];
}

/**
 * Tutti i plant in perimetro hanno lo STESSO criterio?
 *
 * Serve alla sola ottimizzazione ONPREM: quando il criterio e' uno solo, i flag si spingono nel
 * `where` e la query resta della forma di prima della 0017, senza trasferire il perimetro
 * intero. Con criteri diversi per plant un `$filter` unico non esiste e si filtra a valle.
 *
 * [W1-09] La chiave di confronto comprende ANCHE i due elenchi di valore, benche' non siano
 * spingibili: due plant con gli stessi flag ma tipi ordine diversi non hanno lo stesso criterio,
 * e trattarli come tali farebbe spingere i flag di uno solo dei due.
 *
 * @returns {{required: string[], excluded: string[], orderTypes: string[], supervisors: string[]}|null}
 */
function commonFilter(cfgs) {
  const list = cfgs instanceof Map ? [...cfgs.values()] : [...(cfgs || [])];
  if (!list.length) return null;
  const key = (c) => [
    formatList(c.required), formatList(c.excluded),
    ...VALUE_CRITERIA.map((v) => formatList(c[v.cfg]))
  ].join('|');
  const first = key(list[0]);
  if (!list.every((c) => key(c) === first)) return null;
  const out = { required: [...(list[0].required || [])], excluded: [...(list[0].excluded || [])] };
  for (const v of VALUE_CRITERIA) out[v.cfg] = [...(list[0][v.cfg] || [])];
  return out;
}

/**
 * Un criterio che non vincola niente? (nessun flag e nessun elenco di valore)
 *
 * [W1-09] Vale la pena avere una funzione per una condizione cosi' semplice: i due call site
 * calcolavano `!required.length && !excluded.length` a mano, e con due liste in piu' la stessa
 * espressione ripetuta e' il modo naturale di dimenticarne una — cioe' di spegnere il filtro.
 */
function criteriaIsEmpty(cfg) {
  if (!cfg) return true;
  if ((cfg.required || []).length || (cfg.excluded || []).length) return false;
  return activeValueCriteria(cfg).length === 0;
}

/**
 * Il `where` che esprime un criterio come filtro spingibile.
 *
 * SOLO PER I FLAG DI STATO, e SOLO per ONPREM: dietro l'iFlow non esiste select-option per i
 * flag (contratto E-13, richiesta R-2b), quindi in IS questi criteri NON sono spingibili e vanno
 * valutati a valle. Il chiamante decide; qui c'e' solo la traduzione.
 *
 * [W1-09] I DUE CRITERI SU VALORE NON SI SPINGONO, su nessun canale, e non e' una dimenticanza.
 * Le select-option esisterebbero (`SO_ORDER_TYPE`, `SO_PRODUCTION_SUPERVISOR`, contratto E-13) e
 * i due campi sono gia' in PROD_ORDER_PUSHABLE, ma il confronto a valle e' TOLLERANTE sugli zeri
 * iniziali mentre quello della sorgente e' stretto: spingere `ProductionSupervisor eq '1'`
 * scarterebbe alla sorgente proprio l'ordine che porta '001' e che il confronto a valle avrebbe
 * tenuto. Un filtro spinto puo' solo essere un SOVRAINSIEME di quello valutato, mai piu' stretto,
 * e qui non e' garantito. Il costo e' la lettura del perimetro plant, che con un criterio di
 * stato configurato in IS avviene comunque.
 *
 * `''` per gli esclusi e non `!= 'X'` perche' e' la forma che il gateway ha sempre ricevuto
 * (era il vecchio RELEASED_STATE) e che sappiamo funzionare.
 */
function pushableWhere(cfg) {
  const where = {};
  for (const f of (cfg && cfg.required) || []) where[f] = 'X';
  for (const f of (cfg && cfg.excluded) || []) where[f] = '';
  return where;
}

/**
 * Applica il perimetro a un insieme di righe gia' lette.
 *
 * Le righe dei plant SENZA configurazione vengono scartate: e' il fail-closed, e non dipende
 * dal fatto che il chiamante abbia gia' ristretto la query ai soli plant configurati (lo fa,
 * ma qui non si da' per scontato).
 *
 * @param {Array<object>} rows righe con `ProductionPlant`, i flag e i campi valore
 * @param {Map<string, {required,excluded,orderTypes,supervisors}>} cfgByPlant
 * @returns {{ kept: Array<object>, stats: object }}
 *          `stats.unavailable` = campi citati da un criterio e mai arrivati: e' la spia del
 *          contratto iFlow incompleto.
 *          [W1-09] `stats.blank` = campi VALORE citati da un criterio, arrivati su ogni riga, e
 *          vuoti su TUTTE: e' un'altra spia, e serve perche' i due casi si somigliano nell'esito
 *          (zero ordini) e non nella causa. Un campo che non arriva e' un iFlow incompleto; un
 *          campo che arriva sempre vuoto e' il campo non alimentato, oppure — ed e' il caso che
 *          DEC-64 insegna ad aspettarsi su questo canale — un campo consegnato senza il suo
 *          contenuto. Senza dichiararlo, il plant produce zero ordini e nulla lo dice.
 */
function applyStatusFilter(rows, cfgByPlant) {
  const all = Array.isArray(rows) ? rows : [];
  const byPlant = cfgByPlant instanceof Map ? cfgByPlant : new Map();
  const unavailable = new Set();
  const unconfigured = new Map(); // plant -> righe scartate
  const kept = [];
  let excluded = 0;

  // [W1-09] Per ogni campo valore citato da un criterio: quante righe lo portano valorizzato.
  // Si guarda solo sulle righe di un plant CONFIGURATO che cita quel campo — su un plant che non
  // lo cita, un campo vuoto non significa niente.
  const valueSeen = new Map();  // sapField -> { rows, filled }

  for (const row of all) {
    const plant = s(row && row.ProductionPlant);
    const cfg = byPlant.get(plant);
    if (!cfg) {
      unconfigured.set(plant, (unconfigured.get(plant) || 0) + 1);
      continue;
    }
    for (const v of activeValueCriteria(cfg)) {
      const seen = valueSeen.get(v.sapField) || { rows: 0, filled: 0 };
      seen.rows += 1;
      if (s(row[v.sapField]) !== '') seen.filled += 1;
      valueSeen.set(v.sapField, seen);
    }
    const verdict = orderPasses(row, cfg);
    verdict.missing.forEach((f) => unavailable.add(f));
    if (verdict.passes) kept.push(row); else excluded++;
  }

  const blank = VALUE_FIELDS.filter((f) => {
    const seen = valueSeen.get(f);
    // `unavailable` ha la precedenza: un campo mai arrivato e' gia' dichiarato di la', e
    // dichiararlo due volte con due cause diverse confonderebbe chi legge il recap.
    return seen && seen.rows > 0 && seen.filled === 0 && !unavailable.has(f);
  });

  return {
    kept,
    stats: {
      in: all.length,
      kept: kept.length,
      excluded,
      unconfiguredPlants: [...unconfigured.keys()].sort(),
      unconfiguredRows: [...unconfigured.values()].reduce((a, b) => a + b, 0),
      unavailable: [...unavailable].sort((a, b) => {
        // I flag nell'ordine del catalogo, i campi valore in coda: CATALOG_ORDER non li conosce
        // e una sottrazione con `undefined` darebbe NaN, cioe' un ordinamento indefinito.
        const ia = CATALOG_ORDER.has(a) ? CATALOG_ORDER.get(a) : STATUS_CATALOG.length + VALUE_FIELDS.indexOf(a);
        const ib = CATALOG_ORDER.has(b) ? CATALOG_ORDER.get(b) : STATUS_CATALOG.length + VALUE_FIELDS.indexOf(b);
        return ia - ib;
      }),
      blank
    }
  };
}

// ================================================================
// Caricamento del customizing
// ================================================================

/**
 * Il customizing dei plant indicati, gia' normalizzato in liste.
 *
 * NESSUN `try/catch`, a differenza del gemello routingVisibility.js: la' inghiottire l'errore
 * significa «mostra tutto», che e' innocuo; qui significherebbe «non mostrare niente e dire che
 * non e' configurato», cioe' spacciare un guasto per una scelta dell'utente. Se questa lettura
 * fallisce, e' un guasto del database locale — lo stesso che avrebbe gia' fatto fallire
 * getActiveStatusPlants() poche righe prima — e deve arrivare al chiamante come tale.
 *
 * @param {object} db
 * @param {Iterable<string>} [plants] se omesso, tutti i plant configurati
 * @returns {Promise<Map<string, {Plant, required: string[], excluded: string[],
 *                                orderTypes: string[], supervisors: string[]}>>}
 */
async function loadProdOrderFilterConfig(db, plants) {
  const wanted = plants ? [...plants].map(s).filter(Boolean) : null;
  const map = new Map();
  if (wanted && !wanted.length) return map;

  let q = SELECT.from(E_FILTER).columns(
    'Plant', 'RequiredStatuses', 'ExcludedStatuses',
    ...VALUE_CRITERIA.map((c) => c.list)   // [W1-09]
  );
  if (wanted) q = q.where({ Plant: { in: wanted } });
  const rows = await db.run(q);

  for (const r of rows || []) {
    const plant = s(r.Plant);
    if (!plant) continue;
    // I token fuori catalogo (e, dalla W1-09, quelli piu' lunghi del campo DDIC) di una riga gia'
    // persistita si IGNORANO invece di far fallire la lettura: la validazione li rifiuta alla
    // scrittura, e una riga scritta a mano nel database non deve poter spegnere la lista del
    // cockpit.
    const cfg = {
      Plant: plant,
      required: parseList(r.RequiredStatuses).codes,
      excluded: parseList(r.ExcludedStatuses).codes
    };
    for (const c of VALUE_CRITERIA) cfg[c.cfg] = parseCodeList(r[c.list], c.maxLen).codes;
    map.set(plant, cfg);
  }
  return map;
}

/**
 * Perimetro effettivo: quali dei plant candidati sono configurati e quali no.
 * E' la funzione che i chiamanti usano per restringere la query PRIMA di emetterla.
 *
 * @returns {Promise<{ byPlant: Map, configured: string[], unconfigured: string[] }>}
 */
async function resolveOrderScope(db, plants) {
  const candidates = [...(plants || [])].map(s).filter(Boolean).sort();
  const byPlant = await loadProdOrderFilterConfig(db, candidates);
  const configured = candidates.filter((p) => byPlant.has(p));
  const unconfigured = candidates.filter((p) => !byPlant.has(p));
  return { byPlant, configured, unconfigured };
}

/**
 * Riga leggibile per log e diagnostica: i criteri in vigore, per plant.
 *
 * [W1-09] I due assi su valore compaiono solo se configurati: su un cliente che non li usa la
 * riga di log resta quella di prima, e chi la legge non deve chiedersi cosa siano due
 * `(qualunque)` che non ha mai impostato.
 */
function describeFilters(cfgByPlant) {
  const byPlant = cfgByPlant instanceof Map ? cfgByPlant : new Map();
  const parts = [];
  for (const plant of [...byPlant.keys()].sort()) {
    const cfg = byPlant.get(plant) || {};
    const req = (cfg.required || []).join('+') || '(nessuno)';
    const exc = (cfg.excluded || []).join('+') || '(nessuno)';
    let line = `${plant}: richiesti=${req} esclusi=${exc}`;
    for (const v of activeValueCriteria(cfg)) line += ` ${v.sapField}=${v.codes.join('/')}`;
    parts.push(line);
  }
  return parts.length ? parts.join(' | ') : '(nessun plant configurato)';
}

module.exports = {
  parseList,
  parseCodeList,
  formatList,
  validateFilter,
  isSet,
  orderPasses,
  selectColumns,
  commonFilter,
  criteriaIsEmpty,
  hasValueCriteria,
  pushableWhere,
  applyStatusFilter,
  loadProdOrderFilterConfig,
  resolveOrderScope,
  describeFilters,
  STATUS_CATALOG,
  VALUE_CRITERIA,
  VALUE_FIELDS,
  LIST_MAX_LENGTH,
  E_FILTER
};

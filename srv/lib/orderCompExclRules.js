/**
 * [COMP-EXCL] Regole PURE dell'esclusione configurabile dei componenti dell'ordine.
 *
 * Nessuna dipendenza da `cds` ne' dalla rete: tutto quello che sta qui e' collaudabile con
 * `node test/orderCompExclRules.test.js`. L'orchestrazione — caricare il customizing, leggere
 * l'anagrafica quando serve, dichiarare nel recap — sta in srv/lib/orderCompExcl.js.
 *
 * COSA CHIEDE IL CLIENTE. Field mapping Ariston, foglio `5. Orders or Jobs`, cella `H18`: dai
 * componenti dell'ordine vanno tolti quelli con `RESB-DUMPS = "X"`, quelli con `RESB-RGEKZ` vuoto e
 * quelli il cui materiale ha `MARA-MTART = "ZSFR"` — «Parts that do not need to be moved or consumed
 * by MES» (nota `A25`). Il primo dei tre e' gia' coperto dall'esplosione dei fantasma (feature 0019),
 * gli altri due si configurano con questo customizing: nessuno dei tre e' cablato.
 *
 * SEMANTICA. OR fra le regole attive, AND fra le condizioni di una regola (`evaluateRule` di
 * plexPartMapper.js, lo stesso valutatore delle categorie materiali: una regola *e'* un insieme di
 * condizioni in AND, un secondo valutatore divergerebbe). La prima regola che combacia esclude, e il
 * suo nome e' quello che finisce nel log: `Sequence` ordina la valutazione, non cambia l'esito.
 *
 * ═══ I DUE PUNTI CHE NON SI POSSONO SEMPLIFICARE ═══
 *
 * 1. I BOOLEAN SI LEGGONO PER FORMA, E DIVENTANO 'X' / ''. Nel modello OData
 *    `MatlCompIsMarkedForBackflush` e i suoi fratelli sono `Boolean`, ma ogni operatore del progetto
 *    ragiona su stringhe SAP. Senza la conversione, `String(false)` sarebbe `'false'`: `BLANK` non
 *    aggancerebbe MAI e la regola del foglio («RGEKZ blank») risulterebbe configurata e inerte —
 *    esattamente il difetto che non si vede da qui e si scopre in linea. La conversione e' anche
 *    l'unica ragione per cui `EQ 'X'` funziona come chi configura si aspetta. Lo stesso valore
 *    arriva `true` su un canale e `'X'` sull'altro, quindi si legge per forma (come `bool` di
 *    bomExplodeRules.js) e si RI-EMETTE nella forma SAP.
 *
 * 2. LA PROVENIENZA DEL CAMPO E' PARTE DELLA REGOLA. `COMP` sta sulla riga di prenotazione e costa
 *    solo un nome nel `$select`; `MATERIAL` sta sull'anagrafica del componente e costa UNA LETTURA
 *    PER MATERIALE, perche' su Integration Suite `A_Product` non ha `_QUERYGET` (DEC-43). Da qui
 *    `needsMaterialRead`: senza, ogni ordine pagherebbe la lettura dell'anagrafica anche quando
 *    nessuna regola la usa. E da qui il fatto che un'anagrafica NON LETTA non e' un'anagrafica
 *    vuota: vedi `evaluate`.
 */

'use strict';

// Stesso valutatore delle condizioni di categoria materiale: EQ|NE|IN|NOTIN|BLANK|NOTBLANK.
const { evaluateRule } = require('./plexPartMapper');
// Lettura di un Boolean per FORMA e non per verita' JavaScript ('X' / 'true' / 1 / 'Y').
const { bool } = require('./bomExplodeRules');

/** Gli operatori ammessi in una condizione. Sono quelli che `evaluateCondition` sa valutare. */
const OPERATORS = Object.freeze(['EQ', 'NE', 'IN', 'NOTIN', 'BLANK', 'NOTBLANK']);

/** Gli operatori che NON hanno bisogno di un valore di confronto. */
const VALUELESS_OPERATORS = Object.freeze(['BLANK', 'NOTBLANK']);

const SOURCE_COMP = 'COMP';
const SOURCE_MATERIAL = 'MATERIAL';

/**
 * I campi di `A_ProductionOrderComponent_2` (RESB) selezionabili in una condizione.
 *
 * Elenco CHIUSO, e non e' una limitazione: un nome offerto e non popolato dal runtime non da
 * errore, da `undefined` — cioe' una condizione che risulta sempre vuota e una regola configurata
 * che non esclude niente. Ogni nome qui e' verificato sul CSN
 * (srv/external/OP_API_PRODUCTION_ORDER_2_SRV_0001.cds) ed entra nel `$select` solo se una regola
 * attiva lo usa (`selectColumns`).
 */
const COMP_FIELDS = Object.freeze([
  'MatlCompIsMarkedForBackflush',    // RGEKZ — il criterio del foglio
  'MaterialComponentIsPhantomItem',  // DUMPS
  'BOMItemCategory',                 // POSTP
  'MatlCompIsMarkedForDeletion',     // XLOEK
  'ReservationIsFinallyIssued',      // KZEAR
  'IsBulkMaterialComponent',         // SCHGT
  'QuantityIsFixed',                 // FMENG
  'MaterialCompIsCostRelevant',      // SANKA
  'StorageLocation',                 // LGORT
  'GoodsMovementType',               // BWART
  'SupplyArea',                      // PRVBE
  'MaterialGroup'                    // MATKL sulla riga componente
]);

/**
 * I campi di `A_Product` (MARA) selezionabili in una condizione.
 *
 * Tutti e quattro sono GIA' in `PRODUCT_SELECT` (srv/lib/productSource.js): la lettura
 * dell'anagrafica non va estesa, va solo fatta quando serve.
 */
const MATERIAL_FIELDS = Object.freeze([
  'ProductType',          // MTART — il criterio del foglio ('ZSFR')
  'ProductGroup',         // MATKL
  'CrossPlantStatus',     // MSTAE
  'IsMarkedForDeletion'   // LVORM
]);

/**
 * I campi che il modello OData tipizza `Boolean` e che vanno RESI in forma SAP ('X' / '').
 * Vedi il punto 1 in testa al file: e' la differenza fra una regola che funziona e una inerte.
 */
const BOOLEAN_FIELDS = new Set([
  'MatlCompIsMarkedForBackflush',
  'MaterialComponentIsPhantomItem',
  'MatlCompIsMarkedForDeletion',
  'ReservationIsFinallyIssued',
  'IsBulkMaterialComponent',
  'QuantityIsFixed',
  'IsMarkedForDeletion'
]);

const COMP_SET = new Set(COMP_FIELDS);
const MATERIAL_SET = new Set(MATERIAL_FIELDS);

/** Testo utilizzabile o stringa vuota. */
function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** La provenienza di un campo: `'COMP'`, `'MATERIAL'` o `''` se il nome non e' del catalogo. */
function fieldSource(name) {
  const n = str(name);
  if (COMP_SET.has(n)) return SOURCE_COMP;
  if (MATERIAL_SET.has(n)) return SOURCE_MATERIAL;
  return '';
}

/** Il nome e' del catalogo? */
function isKnownField(name) {
  return fieldSource(name) !== '';
}

/**
 * `Conditions` come array, qualunque forma abbia restituito il driver.
 *
 * L'expand di una composizione VUOTA non torna `[]`: su SQLite arriva la STRINGA `'[]'`, che e'
 * truthy e non ha `.every` (DEC-61). Una regola senza condizioni e' rifiutata in scrittura, ma il
 * customizing si puo' scrivere anche da fuori l'app e questo codice sta dentro il percorso che
 * allinea la distinta di un job schedulato: normalizzare qui costa niente, lanciare costa un job.
 */
function asConditions(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Le regole ATTIVE, in ordine di `Sequence`, con `Conditions` normalizzato e senza le condizioni
 * su campi fuori catalogo.
 *
 * PERCHE' SI BUTTA LA CONDIZIONE E NON LA REGOLA. Una condizione su un campo che il runtime non
 * popola sarebbe sempre «vuota» e renderebbe la regola piu' larga o piu' stretta a caso; tenerla
 * significherebbe far dipendere l'esclusione da un `undefined`. Una regola che resta senza
 * condizioni non aggancia piu' niente (`evaluateRule` la rifiuta), che e' lo stato sicuro.
 *
 * LA FUNZIONE E' IDEMPOTENTE, E NON E' UN DETTAGLIO. L'orchestrazione normalizza una volta e passa
 * il risultato in giro (`resolveExclRules` restituisce regole gia' normalizzate), mentre
 * `partition`, `selectColumns` e `needsMaterialRead` normalizzano a loro volta — perche' i test e
 * i chiamanti possono passare righe grezze. Se l'output non fosse valido come input, il secondo
 * giro scarterebbe tutto e NESSUNA esclusione verrebbe applicata, in silenzio: e' esattamente
 * quello che e' successo al primo collaudo end-to-end, con `IsActive` che si perdeva nella copia.
 * Per questo `IsActive: true` viene RI-EMESSO: la copia normalizzata deve poter rientrare da qui.
 *
 * @param {Array<object>} rules righe di ZOrderCompExclRule con `Conditions` (grezze o normalizzate)
 * @returns {Array<object>} copie normalizzate: `{ RuleName, Sequence, IsActive, Conditions[] }`
 */
function activeRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  return list
    // `IsActive` ASSENTE conta come SPENTA, non come accesa: se la colonna non e' stata letta non
    // si sa se la regola e' attiva, e l'unico verso sicuro di questa feature e' non escludere.
    .filter((r) => r && bool(r.IsActive))
    .map((r) => ({
      RuleName: str(r.RuleName),
      Sequence: Number(r.Sequence) || 0,
      IsActive: true,
      Conditions: asConditions(r.Conditions).filter((c) => c && isKnownField(c.SapField))
    }))
    .filter((r) => r.Conditions.length > 0)
    .sort((a, b) => a.Sequence - b.Sequence || a.RuleName.localeCompare(b.RuleName));
}

/** I nomi di campo, per provenienza, citati da un elenco di regole GIA' normalizzate. */
function fieldsUsed(rules, source) {
  const out = new Set();
  for (const r of (rules || [])) {
    for (const c of (r.Conditions || [])) {
      const n = str(c.SapField);
      if (fieldSource(n) === source) out.add(n);
    }
  }
  return [...out];
}

/**
 * Le colonne di `A_ProductionOrderComponent_2` da aggiungere al `$select` dei componenti.
 *
 * Stesso schema di `prodOrderStatusFilter.selectColumns`: si chiede solo cio' che il customizing
 * cita davvero. Il chiamante deve togliere i nomi che ha gia' in elenco — un nome ripetuto nel
 * `$select` e' una richiesta malformata.
 *
 * @param {Array<object>} rules righe di customizing (grezze o normalizzate)
 * @returns {Array<string>}
 */
function selectColumns(rules) {
  return fieldsUsed(activeRules(rules), SOURCE_COMP);
}

/** Le colonne di `A_Product` che servono per valutare le regole. */
function materialColumns(rules) {
  return fieldsUsed(activeRules(rules), SOURCE_MATERIAL);
}

/**
 * Serve leggere l'anagrafica dei materiali dei componenti?
 *
 * E' la domanda che evita una lettura per materiale su ogni ordine quando nessuno ha configurato
 * criteri sull'anagrafica — cioe' il caso normale.
 */
function needsMaterialRead(rules) {
  return materialColumns(rules).length > 0;
}

/**
 * La mappa `{ FieldName: valore }` su cui `evaluateRule` lavora.
 *
 * I Boolean diventano `'X'` / `''` (punto 1 in testa al file). Tutto il resto e' `trim`: il valore
 * LETTO non si normalizza altrimenti — nessun allineamento di zeri iniziali, nessuna maiuscola
 * forzata (DEC-51, C-7).
 *
 * @param {object} component riga di `A_ProductionOrderComponent_2`
 * @param {object|undefined} material riga di `A_Product` del materiale del componente
 * @returns {object}
 */
function fieldsOf(component, material) {
  const out = {};
  const put = (name, raw) => {
    out[name] = BOOLEAN_FIELDS.has(name) ? (bool(raw) ? 'X' : '') : str(raw);
  };
  for (const n of COMP_FIELDS) put(n, component ? component[n] : undefined);
  if (material) for (const n of MATERIAL_FIELDS) put(n, material[n]);
  return out;
}

/**
 * Il verdetto su UN componente.
 *
 * ANAGRAFICA NON LETTA != ANAGRAFICA VUOTA. Se una regola cita un campo `MATERIAL` e la riga
 * d'anagrafica non c'e' (lettura fallita, materiale non restituito), quella regola NON e'
 * valutabile: non esclude, e lo si dichiara. Escludere sulla base di un dato che non si e' potuto
 * leggere significa portare a `Active = 0` righe BOM buone di un job gia' schedulato — la stessa
 * ragione per cui un fantasma non esploso resta in elenco invece di sparire (DEC-56). Se invece la
 * riga c'e' e il campo e' vuoto, quello e' un VALORE: `BLANK` aggancia, ed e' corretto.
 *
 * @param {object} component riga componente
 * @param {object|undefined} material riga d'anagrafica, `undefined` se NON LETTA
 * @param {Array<object>} rules regole normalizzate (`activeRules`)
 * @returns {{excluded: boolean, ruleName: string, unevaluable: Array<string>}}
 */
function evaluate(component, material, rules) {
  const fields = fieldsOf(component, material);
  const unevaluable = [];
  for (const r of (rules || [])) {
    const needsMaterial = (r.Conditions || []).some((c) => fieldSource(c.SapField) === SOURCE_MATERIAL);
    if (needsMaterial && !material) {
      unevaluable.push(r.RuleName);
      continue;
    }
    if (evaluateRule(r, fields)) {
      return { excluded: true, ruleName: r.RuleName, unevaluable };
    }
  }
  return { excluded: false, ruleName: '', unevaluable };
}

/**
 * Divide i componenti in tenuti ed esclusi.
 *
 * @param {object} args
 * @param {Array<object>} args.components righe componente (dopo l'esplosione dei fantasma)
 * @param {Array<object>} args.rules righe di customizing grezze
 * @param {Map<string, object>} [args.materialByProduct] anagrafiche lette, per materiale. Una
 *   chiave ASSENTE significa «non letta», non «vuota».
 * @returns {{kept: Array<object>, excluded: Array<object>, stats: object}}
 *   `stats.byRule` conta gli esclusi per nome di regola; `stats.unevaluable` elenca le coppie
 *   regola/materiale che non si sono potute valutare.
 */
function partition({ components, rules, materialByProduct } = {}) {
  const list = Array.isArray(components) ? components : [];
  const active = activeRules(rules);
  const stats = { read: list.length, kept: 0, excluded: 0, byRule: {}, unevaluable: [] };
  if (!active.length) {
    stats.kept = list.length;
    return { kept: list, excluded: [], stats };
  }

  const kept = [];
  const excluded = [];
  const seenUnevaluable = new Set();
  for (const c of list) {
    const product = str(c && c.Material);
    const material = materialByProduct instanceof Map ? materialByProduct.get(product) : undefined;
    const v = evaluate(c, material, active);
    for (const ruleName of v.unevaluable) {
      const k = `${ruleName}|${product}`;
      if (seenUnevaluable.has(k)) continue;
      seenUnevaluable.add(k);
      stats.unevaluable.push({ rule: ruleName, material: product });
    }
    if (v.excluded) {
      excluded.push({ ...c, ExclusionRule: v.ruleName });
      stats.byRule[v.ruleName] = (stats.byRule[v.ruleName] || 0) + 1;
    } else {
      kept.push(c);
    }
  }
  stats.kept = kept.length;
  stats.excluded = excluded.length;
  return { kept, excluded, stats };
}

/**
 * Validazione di una regola in scrittura.
 *
 * UNA REGOLA SENZA CONDIZIONI E' INERTE, NON UN PASSA-TUTTO: `evaluateRule` la rifiuta, quindi non
 * esclude niente e non svuota nessuna distinta. Il difetto e' l'altro, ed e' quello che DEC-27 non
 * vuole: un customizing che si salva, si vede in elenco e non fa niente. Per questo si rifiuta
 * l'ATTIVAZIONE a vuoto — la regola nasce spenta e si accende quando ha i suoi criteri.
 *
 * `IsActive` non e' guardato qui: chi chiama sa se la riga risultante e' attiva (su una PATCH per
 * chiave il valore puo' arrivare dall'esistente e non dal payload) e chiama questa funzione solo
 * quando lo e'. La regola di composizione della riga sta nell'handler, come per validateMatCategory.
 *
 * @param {object} rule `{ RuleName, Plant }`
 * @param {Array<object>} conditions condizioni della regola
 * @returns {{ok: boolean, code: string, field: string}} `code` e' la chiave i18n del messaggio
 */
function validateRule(rule, conditions) {
  const name = str(rule && rule.RuleName);
  if (!name) return { ok: false, code: 'oceRuleNameRequired', field: '' };
  const conds = asConditions(conditions);
  if (!conds.length) return { ok: false, code: 'oceNoConditions', field: '' };
  for (const c of conds) {
    const field = str(c && c.SapField);
    if (!isKnownField(field)) return { ok: false, code: 'oceUnknownField', field };
    const op = str(c && c.Operator).toUpperCase();
    if (!OPERATORS.includes(op)) return { ok: false, code: 'oceUnknownOperator', field: op };
    if (!VALUELESS_OPERATORS.includes(op) && !str(c && c.Value)) {
      return { ok: false, code: 'oceValueRequired', field };
    }
  }
  return { ok: true, code: '', field: '' };
}

/** Una riga di recap leggibile, o `''` se non c'e' niente da dire. */
function describe(stats) {
  if (!stats || !stats.excluded) return '';
  const parts = Object.entries(stats.byRule).map(([r, n]) => `${r}: ${n}`);
  return `componenti esclusi dal customizing: ${stats.excluded} di ${stats.read} (${parts.join(', ')})`;
}

module.exports = {
  OPERATORS,
  VALUELESS_OPERATORS,
  SOURCE_COMP,
  SOURCE_MATERIAL,
  COMP_FIELDS,
  MATERIAL_FIELDS,
  BOOLEAN_FIELDS,
  fieldSource,
  isKnownField,
  asConditions,
  activeRules,
  selectColumns,
  materialColumns,
  needsMaterialRead,
  fieldsOf,
  evaluate,
  partition,
  validateRule,
  describe
};

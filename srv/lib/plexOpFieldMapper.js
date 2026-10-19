/**
 * Plex part-operation payload resolver.
 *
 * Builds the Plex "part-operation" field values for a routing operation from the per-plant
 * customizing (ZPlexOpFieldMap + rules + conditions), given a flat SAP context (material +
 * routing operation fields). Same generic rule engine as plexPartMapper.js, but the target
 * fields have mixed types (string/int/boolean/decimal) so coercion is per target field.
 *
 * Pure functions (no I/O) so they are easily unit-testable. Consumed by syncRoutingPlexCycle
 * in srv/cat-service.js.
 */

'use strict';

// Part-operation payload fields that must be integers.
const INTEGER_FIELDS = new Set(['operationNumber']);
// Part-operation payload fields that must be decimals.
const DECIMAL_FIELDS = new Set(['netWeight', 'standardQuantity']);
// Part-operation payload fields that must be booleans.
const BOOLEAN_FIELDS = new Set(['subOperation', 'shippable']);
// Identity fields that are ALWAYS set by the send code and are NOT configurable through the
// customizing: partId (the Plex part) and operationId (the Plex operation). Any mapping row
// targeting these fields is ignored / rejected.
const LOCKED_FIELDS = new Set(['partId', 'operationId']);

/**
 * [PLEX-OP-TYPE] Campi DERIVATI da Plex, non configurabili (feature 0024, DEC-84).
 *
 * Non sono identita' come i LOCKED_FIELDS: sono campi il cui valore vero e' un dato che vive nel
 * catalogo Plex, quindi dichiararlo una seconda volta da questa parte significa poter dire una cosa
 * diversa da quella vera. `type` era una riga FIXED di ZPlexOpFieldMap — un valore UNICO per tutte
 * le operazioni del ciclo, mentre il tipo e' una proprieta' della SINGOLA operazione — e un tipo
 * sbagliato non produce un dato sbagliato: produce `400 FIELD_REFERENCE_NOT_FOUND`, cioe' il
 * trasferimento del ciclo non crea niente, nemmeno distinta e centri di lavoro (dipendono dagli id
 * delle operazioni).
 *
 * Tenuti SEPARATI dai LOCKED_FIELDS perche' la ragione dell'esclusione e' diversa e il messaggio di
 * rifiuto della scheda deve dirla: «e' identita'» e «lo dice Plex» sono due spiegazioni distinte.
 */
const DERIVED_FIELDS = new Set(['type']);

// Truthy string tokens accepted for boolean fields.
const TRUE_TOKENS = new Set(['true', '1', 'x', 'yes', 'y', 'si', 'sì']);

/**
 * [PLEX-OP-TYPE] Il ripiego del campo `type` della part-operation.
 *
 * `type` e' OBBLIGATORIO nel contratto Plex (`CreatePartOperationDTO`: string, nessun enum) e Plex
 * lo risolve PER NOME contro una tabella di setup del TENANT. Quindi il valore giusto non e' un
 * fatto del progetto ne' della BBP — che l'Operation Type non la nomina mai — ma del tenant: sul
 * tenant di Albacina la tendina offre «Produzione», «Ricevere», «Rework», e `'Production'` non
 * esiste. Un `POST` con un nome sconosciuto risponde
 * `400 FIELD_REFERENCE_NOT_FOUND { field: 'Type' }`, cioe' il ciclo non parte affatto.
 *
 * Il valore resta comunque `'Production'` e non diventa vuoto: e' il COMPORTAMENTO STORICO
 * (DEC-53). Su un tenant inglese e' quello giusto, e togliere il ripiego trasformerebbe un plant
 * non configurato in un invio impossibile invece che in un invio come quello di ieri. La lacuna si
 * DICHIARA (contatore `OpTypeDefaulted` sull'esito, riga di recap, MessageStrip nella scheda), non
 * si trasforma in un errore.
 *
 * Dalla feature 0024 questo ripiego e' quasi irraggiungibile, e le due cose vanno lette insieme: il
 * tipo lo dichiara il CATALOGO Plex (`OperationDTO.type`), quindi ci si arriva solo quando il
 * catalogo non e' leggibile o quando quell'operazione non ha un tipo. Proprio perche' e' diventato
 * raro non va rimosso: e' l'unico valore che resta da mandare in un campo obbligatorio quando non
 * si e' potuto sapere quale fosse quello giusto.
 *
 * Sta QUI e non piu' in srv/lib/recvOpRules.js perche' questo e' il modulo del payload della
 * part-operation: il commento di la' dichiarava gia' di tenerne una copia «identica a
 * syncRoutingPlexCycle», ed erano due costanti da cambiare insieme.
 */
const DEFAULT_OP_TYPE = 'Production';

/**
 * [OP-SAP-FIELDS] I nomi che il CONTESTO di risoluzione popola, per sorgente.
 *
 * Gemello di `MAT_SAP_FIELDS` in srv/lib/plexPartMapper.js, e nasce dalla stessa ragione: la
 * tendina «SAP Field» di questa scheda e' alimentata da un CSV di seed (`ZOpFieldVH`), mentre la
 * risoluzione a runtime e' un accesso diretto per nome (`ctx[row.SapField]`, resolveFieldValue).
 * Un nome offerto all'utente e non popolato dal runtime non produce un errore: produce
 * `undefined`, `buildPartOperationPayload` lo scarta in silenzio, e il campo risulta configurato
 * mentre a Plex non arriva niente. E' il difetto RB-20 del lato materiali (DEC-64), qui non ancora
 * accaduto solo perche' questo mapping non ha MAI girato — la lettura del customizing lanciava
 * `ReferenceError` a ogni chiamata (DEC-76). Con quella corretta, il rischio diventa reale.
 *
 * `test/opSapFields.test.js` confronta questa lista col seed nelle DUE direzioni: un nome nel CSV
 * e non qui e' un campo selezionabile e morto, un nome qui e non nel CSV e' una lettura pagata e
 * mai offerta.
 */
const OP_SAP_FIELDS = Object.freeze({
  // 1:1 con le colonne di A_Product: stesso nome nel `$select` e nel contesto, quindi la lista
  // guida entrambi (srv/cat-service.js, fetchProductOpFields).
  fromProduct: Object.freeze([
    'NetWeight', 'GrossWeight', 'WeightUnit', 'ProductType', 'ProductGroup', 'BaseUnit'
  ]),
  // NON 1:1: qui stanno i nomi del CONTESTO, non le colonne SAP da cui derivano
  // (`Operation` -> OperationNumber, `WorkCenterInternalID` -> WorkCenter,
  // `OperationControlProfile` -> OperationType, `StandardWorkQuantity1` -> StandardWorkQuantity).
  // La traduzione resta esplicita in fetchRoutingOpFields; questa lista dice cosa ne esce.
  fromRoutingOp: Object.freeze([
    'OperationNumber', 'WorkCenter', 'OperationType',
    'OperationReferenceQuantity', 'StandardWorkQuantity'
  ]),
  // Non viene da SAP: lo aggiunge il call site dal ciclo salvato in locale.
  injected: Object.freeze(['OperationCode'])
});

/** Normalize a value to a trimmed string ('' for null/undefined). */
function s(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Evaluate a single condition against the SAP context values. */
function evaluateCondition(cond, ctx) {
  const actual = s(ctx ? ctx[cond.SapField] : '');
  const expected = s(cond.Value);
  switch ((cond.Operator || 'EQ').toUpperCase()) {
    case 'EQ':       return actual === expected;
    case 'NE':       return actual !== expected;
    case 'IN':       return expected.split(',').map(x => x.trim()).filter(Boolean).includes(actual);
    case 'BLANK':    return actual === '';
    case 'NOTBLANK': return actual !== '';
    default:         return false;
  }
}

/** A rule matches when ALL its conditions match. A rule with no conditions never matches. */
function evaluateRule(rule, ctx) {
  const conds = rule && Array.isArray(rule.Conditions) ? rule.Conditions : [];
  if (conds.length === 0) return false;
  return conds.every(c => evaluateCondition(c, ctx));
}

/** Resolve the raw value for one mapping row (undefined if nothing applies). */
function resolveFieldValue(row, ctx) {
  switch ((row.MappingKind || '').toUpperCase()) {
    case 'FIXED':
      return row.FixedValue;
    case 'SAP_FIELD':
      return ctx ? ctx[row.SapField] : undefined;
    case 'RULE': {
      const rules = Array.isArray(row.Rules) ? [...row.Rules] : [];
      rules.sort((a, b) => (a.Sequence || 0) - (b.Sequence || 0)); // first match wins
      const hit = rules.find(r => evaluateRule(r, ctx));
      return hit ? hit.OutputValue : undefined;
    }
    default:
      return undefined;
  }
}

/** Coerce a resolved value to the target type of the given part-operation field. */
function coerce(plexField, value) {
  if (INTEGER_FIELDS.has(plexField)) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  if (DECIMAL_FIELDS.has(plexField)) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (BOOLEAN_FIELDS.has(plexField)) {
    if (typeof value === 'boolean') return value;
    return TRUE_TOKENS.has(s(value).toLowerCase());
  }
  return value; // string passthrough (e.g. type)
}

/**
 * Build the mapped Plex part-operation field values from the customizing rows + the SAP context.
 * Returns ONLY the mapped fields (unmapped fields are absent, so the caller can fall back to its
 * own defaults). Identity fields (partId/operationId) are never emitted.
 * @param {object} opts
 * @param {object} opts.opContext flat map { NetWeight, StandardWorkQuantity, OperationType, ... }
 * @param {Array}  opts.mapRows   ZPlexOpFieldMap rows (with Rules[].Conditions[])
 * @returns {object} partial payload, e.g. { netWeight: 0.1, type: 'Production' }
 */
function buildPartOperationPayload({ opContext = {}, mapRows = [] } = {}) {
  const out = {};
  for (const row of mapRows) {
    if (!row || !row.PlexField) continue;
    if (LOCKED_FIELDS.has(row.PlexField)) continue; // partId/operationId not configurable
    // [PLEX-OP-TYPE] `type` non e' configurabile: lo dichiara il catalogo Plex (DEC-84). Le righe
    // salvate prima della 0024 restano in tabella e si scartano QUI — la scheda le mostra con un
    // avviso e l'utente le elimina. Non si ignorano in silenzio: un customizing configurato e
    // inerte e' il difetto invisibile che questo progetto denuncia in cinque punti.
    if (DERIVED_FIELDS.has(row.PlexField)) continue;
    const raw = resolveFieldValue(row, opContext);
    if (raw === undefined || raw === null || raw === '') continue; // skip unset -> caller default
    out[row.PlexField] = coerce(row.PlexField, raw);
  }
  return out;
}

/**
 * [PLEX-OP-TYPE] Il `type` da mandare per UNA part-operation.
 *
 * Precedenza: **valore gia' su Plex → catalogo delle operazioni → ripiego**.
 *
 * Il primo anello conta piu' di quanto sembri. In aggiornamento la GET ci ha gia' consegnato il
 * `type` della part-operation remota (`PartOperationDTO.type`): riscriverlo significherebbe
 * riportare a «Produzione» un'operazione che qualcuno ha messo a «Rework» su Plex. E' la stessa
 * regola con cui DEC-65 fa viaggiare lo `status` della part SOLO in creazione: cio' che non abbiamo
 * deciso noi non si sovrascrive. Ha anche un effetto pratico immediato — su un plant non ancora
 * configurato la ri-sincronizzazione dei cicli esistenti non fallisce, perche' rimanda a Plex quello
 * che Plex ha gia'.
 *
 * Il secondo anello e' la feature 0024 (DEC-84), e ha SOSTITUITO il `mapped` che stava in testa: il
 * tipo di un'operazione e' un dato del catalogo Plex (`OperationDTO.type`,
 * srv/external/PLEX_OPERATION_API_CONTRACT.md), non una decisione di customizing. Il valore vecchio
 * veniva da una riga FIXED di ZPlexOpFieldMap, cioe' UN valore per tutte le operazioni del ciclo,
 * mentre il tipo e' una proprieta' della SINGOLA operazione: un ciclo con un'operazione di rework in
 * mezzo non era esprimibile, e chi configurava poteva scrivere un nome che il tenant non ha —
 * `400 FIELD_REFERENCE_NOT_FOUND`, e il ciclo non parte affatto.
 *
 * Perche' il remoto vince sul catalogo e non viceversa: il catalogo dice qual e' il tipo NATURALE di
 * quell'operazione, il remoto dice cosa una persona ha deciso su QUELLA part. La seconda e' una
 * decisione, la prima un default.
 *
 * @param {{remote: *, operation: *, fallback: string}} args
 *        `remote` il `type` letto dalla part-operation gia' presente su Plex (assente in creazione),
 *        `operation` il `type` che il catalogo Plex dichiara per quell'operazione
 *          (srv/lib/plexOperationCatalog.js: `''` sia se il catalogo non e' leggibile sia se
 *          l'operazione non ha un tipo — la distinzione la fa `catalog.ok` e la dichiara chi chiama).
 * @returns {{value: string, source: 'remote'|'operation'|'default'}} `source` non e' decorazione:
 *          alimenta il contatore che DICHIARA quante operazioni sono partite col ripiego.
 */
function resolveOpType({ remote, operation, fallback = DEFAULT_OP_TYPE } = {}) {
  const r = s(remote);
  if (r) return { value: r, source: 'remote' };
  const o = s(operation);
  if (o) return { value: o, source: 'operation' };
  return { value: s(fallback) || DEFAULT_OP_TYPE, source: 'default' };
}

module.exports = {
  DEFAULT_OP_TYPE,
  OP_SAP_FIELDS,
  evaluateCondition,
  evaluateRule,
  resolveFieldValue,
  buildPartOperationPayload,
  resolveOpType,
  LOCKED_FIELDS,
  DERIVED_FIELDS
};

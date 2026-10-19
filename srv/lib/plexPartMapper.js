/**
 * Plex part payload resolver.
 *
 * Builds the Plex "part" payload for a material from the per-plant customizing
 * (ZPlexFieldMap + rules + conditions), given the material's SAP field values.
 *
 * Pure functions (no I/O) so they are easily unit-testable. Consumed by
 * sendProductToPlex in srv/cat-service.js.
 */

'use strict';

// Plex payload fields that are arrays (customizing stores a comma-separated list).
const ARRAY_FIELDS = new Set(['allergens', 'storageConditions']);
// Plex payload fields that must be numeric.
const NUMBER_FIELDS = new Set(['leadTimeDays']);
// Identity fields that are ALWAYS taken directly from SAP and are NOT configurable
// through the customizing: number = MATNR (Product), name/description = MAKTX
// (ProductDescription). Any mapping row targeting these fields is ignored.
const LOCKED_FIELDS = new Set(['number', 'name', 'description']);

/**
 * [MAT-SAP-FIELDS] I campi SAP che il contesto di invio POPOLA, dichiarati per sorgente.
 *
 * Nasce per chiudere RB-20 (docs/0004), che non era un caso di scuola: `MRPType`, `ProfitCenter` e
 * `PurchasingGroup` stavano nel seed di `ZMatFieldVH` — cioe' nella dropdown «SAP Field» della
 * scheda Plex Part Mapping — e `fetchMaterialSapFields` non li leggeva da nessuna parte. La
 * risoluzione e' un accesso diretto (`sapFields[row.SapField]`, vedi resolveFieldValue), quindi il
 * valore era `undefined` e buildPlexPartPayload lo scartava SENZA ERRORE: il campo risultava
 * configurato, il log diceva `S`, e su Plex non arrivava niente. In condizione era peggio, perche'
 * `undefined` diventa `''` e ogni `EQ`/`IN` era sempre falso mentre `BLANK` era sempre vero.
 *
 * Il difetto era possibile perche' NIENTE legava il seed al runtime: due elenchi scritti a mano in
 * file diversi, e la sola convenzione a tenerli insieme (il commento in testa a
 * materialVisibility.js). Questa costante e' quel legame, e `test/matSapFields.test.js` lo verifica
 * nelle DUE direzioni — un nome nel CSV e non qui e' un campo selezionabile e morto; un nome qui e
 * non nel CSV e' un campo letto da SAP e mai offerto all'utente.
 *
 * Aggiungendo un campo: la riga nel CSV, il nome nell'elenco della sua sorgente e — se e' di
 * `A_ProductPlant` e serve anche in condizione di categoria — `PRODUCT_PLANT_SELECT`
 * (srv/lib/isQueryShape.js) e `extractSapFields` (srv/lib/materialVisibility.js).
 *
 *   fromProduct      -> campi flat di A_Product (MARA)
 *   fromProductPlant -> campi flat di A_ProductPlant (MARC)
 *   viaNav           -> SOBSL e FEVOR: in ONPREM dalle navigazioni espanse, su IS dai due campi
 *                       PORTANTI di IS_FIELD_ALIASES (DEC-64). NON si leggono per nome dalla riga.
 *   injected         -> nessuna lettura SAP dietro: lo passa il chiamante (MAKTX).
 */
const MAT_SAP_FIELDS = Object.freeze({
  fromProduct: Object.freeze([
    'ProductType', 'ProductGroup', 'BaseUnit', 'CrossPlantStatus', 'Division', 'ProductHierarchy'
  ]),
  fromProductPlant: Object.freeze([
    'ProcurementType', 'MRPType', 'ProfitCenter', 'PurchasingGroup', 'ProfileCode'
  ]),
  viaNav: Object.freeze(['ProcurementSubType', 'ProductionSupervisor']),
  injected: Object.freeze(['ProductDescription'])
});

/** Normalize a value to a trimmed string ('' for null/undefined). */
function s(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Evaluate a single condition against the material's SAP field values. */
function evaluateCondition(cond, sapFields) {
  const actual = s(sapFields ? sapFields[cond.SapField] : '');
  const expected = s(cond.Value);
  switch ((cond.Operator || 'EQ').toUpperCase()) {
    case 'EQ':       return actual === expected;
    case 'NE':       return actual !== expected;
    case 'IN':       return expected.split(',').map(x => x.trim()).filter(Boolean).includes(actual);
    case 'NOTIN':    return !expected.split(',').map(x => x.trim()).filter(Boolean).includes(actual);
    case 'BLANK':    return actual === '';
    case 'NOTBLANK': return actual !== '';
    default:         return false;
  }
}

/** A rule matches when ALL its conditions match. A rule with no conditions never matches. */
function evaluateRule(rule, sapFields) {
  const conds = rule && Array.isArray(rule.Conditions) ? rule.Conditions : [];
  if (conds.length === 0) return false;
  return conds.every(c => evaluateCondition(c, sapFields));
}

/** Resolve the raw value for one mapping row (undefined if nothing applies). */
function resolveFieldValue(row, sapFields) {
  switch ((row.MappingKind || '').toUpperCase()) {
    case 'FIXED':
      return row.FixedValue;
    case 'SAP_FIELD':
      return sapFields ? sapFields[row.SapField] : undefined;
    case 'RULE': {
      const rules = Array.isArray(row.Rules) ? [...row.Rules] : [];
      rules.sort((a, b) => (a.Sequence || 0) - (b.Sequence || 0)); // first match wins
      const hit = rules.find(r => evaluateRule(r, sapFields));
      return hit ? hit.OutputValue : undefined;
    }
    default:
      return undefined;
  }
}

/** Coerce a resolved value to the target type of the given Plex field. */
function coerce(plexField, value) {
  if (ARRAY_FIELDS.has(plexField)) {
    return s(value).split(',').map(x => x.trim()).filter(Boolean);
  }
  if (NUMBER_FIELDS.has(plexField)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return value;
}

/**
 * Build the Plex part payload from the customizing rows + the material's SAP fields.
 * @param {object} opts
 * @param {string} opts.product            SAP material number (fallback for `number`)
 * @param {string} opts.productDescription material description (fallback for `name`)
 * @param {object} opts.sapFields          flat map { ProductType, ProductGroup, ProcurementType, ... }
 * @param {Array}  opts.mapRows            ZPlexFieldMap rows (with Rules[].Conditions[])
 * @returns {object} the payload to POST/PUT to /mdm/v1/parts
 */
function buildPlexPartPayload({ product, productDescription, sapFields = {}, mapRows = [] } = {}) {
  const payload = {};

  for (const row of mapRows) {
    if (!row || !row.PlexField) continue;
    if (LOCKED_FIELDS.has(row.PlexField)) continue; // number/name/description: SAP-driven, not configurable
    const raw = resolveFieldValue(row, sapFields);
    if (raw === undefined || raw === null || raw === '') continue; // skip unset
    payload[row.PlexField] = coerce(row.PlexField, raw);
  }

  // Identity fields always come straight from SAP (never from the customizing):
  // number = MATNR, name/description = MAKTX.
  payload.number = product;
  payload.name = productDescription;
  payload.description = productDescription;

  return payload;
}

module.exports = {
  evaluateCondition, evaluateRule, resolveFieldValue, buildPlexPartPayload,
  LOCKED_FIELDS, MAT_SAP_FIELDS
};

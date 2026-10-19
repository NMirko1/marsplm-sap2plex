'use strict';

/**
 * [UNIQUE-VIOLATION] Un vincolo di unicita' violato dal database, reso leggibile.
 *
 * PERCHE' QUESTO MODULO ESISTE. `@assert.unique` e' SOLO compile-time: genera un indice unico sul
 * database e NON un handler (lo dichiara db/schema.cds, righe 350-353). Quindi una violazione non
 * torna come `400` con un messaggio, torna come errore del driver — cioe' `500` col testo grezzo di
 * HANA, che l'utente si e' visto in un MessageBox:
 *
 *   unique constraint violated: Table(AVVALEPLM_MARSPLM_SAP2PLEX_ZCYCLEAUTOASSIGNCONFIG),
 *   Index(AVVALEPLM_MARSPLM_SAP2PLEX_ZCYCLEAUTOASSIGNCONFIG_MATGROUP) ... value='2,07;7,3201811;2,73'
 *
 * I controlli applicativi in `before CREATE/UPDATE` ci sono, ma NON possono essere l'unica difesa, e
 * la ragione e' nel runtime: dentro un change set di `$batch` CAP lancia le sottorichieste IN
 * PARALLELO — in node_modules/@sap/cds/libx/odata/middleware/batch.js ogni richiesta del gruppo parte
 * da `Promise.resolve()` e vengono attese insieme con `Promise.allSettled`, e il `max_parallel = 1`
 * governa i change set FRA LORO, non le richieste dentro uno. Con due righe uguali nello stesso Salva
 * l'ordine reale sulla connessione e' `SELECT #1 → SELECT #2 → INSERT #1 → INSERT #2`: nessuno dei
 * due controlli vede l'altro. Lo stesso vale per due schede del browser aperte sullo stesso plant.
 *
 * L'unico punto che vede sempre la verita' e' il database. Questo modulo non aggiunge una difesa:
 * TRADUCE quella che c'e' gia'.
 *
 * PURO di proposito — niente `cds`, niente rete, niente i18n: prende un errore e il modello CSN e
 * risponde QUALE vincolo di QUALE entity e' stato violato. La scelta del testo sta in
 * srv/cat-service.js, dove vivono i bundle. Test: `node test/uniqueConstraintError.test.js`.
 *
 * Perimetro: `grep -rn "UNIQUE-VIOLATION"`.
 */

/**
 * Codice HANA della violazione di vincolo unico. Arriva come STRINGA ('301'), non come numero:
 * confrontarlo con `=== 301` non aggancerebbe mai — e un mancato aggancio qui non da' errore, da'
 * il `500` di prima, cioe' e' invisibile.
 */
const HANA_UNIQUE_CODE = '301';

/**
 * Riconosce una violazione di unicita' nell'errore del driver.
 *
 * Due forme, perche' i due database la dichiarano in due modi diversi e il progetto usa entrambi
 * (HANA in esercizio, SQLite in sviluppo — e se il riconoscimento funzionasse solo su HANA la
 * riparazione non sarebbe collaudabile in locale, cioe' si scoprirebbe rotta in produzione):
 *
 *   - HANA nomina l'INDICE: `Index(AVVALEPLM_..._MATGROUP)`, con `code` '301'.
 *   - SQLite nomina TABELLA E COLONNE e non l'indice, perche' il compilatore CAP genera per SQLite
 *     un vincolo di tabella e non un indice: `UNIQUE constraint failed: t.Plant, t.Material`.
 *
 * @param {Error|Object} err l'errore cosi' come arriva dal driver
 * @returns {{index: string}|{table: string, fields: Array<string>}|null} `null` se non e' una
 *   violazione di unicita': un errore estraneo NON va tradotto, va lasciato passare com'e'.
 */
function parseUniqueViolation(err) {
  if (!err) return null;
  const message = String(err.message || '');

  // --- HANA ---------------------------------------------------------------------------------
  // Il codice da solo non basta come discriminante e il testo da solo nemmeno: si accetta l'uno
  // O l'altro, perche' `code` puo' arrivare avvolto (cds lo ricopia, i wrapper lo perdono) e il
  // testo puo' cambiare fra versioni. Quello che conta e' che si estragga un nome di indice.
  const codeMatches = String(err.code || '') === HANA_UNIQUE_CODE;
  if (codeMatches || /unique constraint violated/i.test(message)) {
    const m = /\bIndex\(\s*([A-Za-z0-9_$."]+?)\s*\)/.exec(message);
    if (m) return { index: m[1].replace(/"/g, '') };
  }

  // --- SQLite -------------------------------------------------------------------------------
  if (/UNIQUE constraint failed:/i.test(message) || String(err.code || '') === 'SQLITE_CONSTRAINT_UNIQUE') {
    const m = /UNIQUE constraint failed:\s*([^\n]+)/i.exec(message);
    if (!m) return null;
    const pairs = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const tables = new Set();
    const fields = [];
    for (const pair of pairs) {
      const dot = pair.lastIndexOf('.');
      if (dot < 0) { fields.push(pair); continue; }
      tables.add(pair.slice(0, dot));
      fields.push(pair.slice(dot + 1));
    }
    if (!fields.length) return null;
    return { table: tables.size === 1 ? [...tables][0] : '', fields };
  }

  return null;
}

/**
 * Il nome dell'indice che il compilatore CAP genera per un `@assert.unique`.
 *
 * Il nome dell'entity ha i punti sostituiti da underscore, poi il nome del vincolo. HANA
 * maiuscolizza gli identificatori non quotati, quindi il confronto si fa su tutto maiuscolo: e'
 * cosi' che `avvaleplm.marsplm.sap2plex.ZCycleAutoAssignConfig` + `matGroup` diventa
 * `AVVALEPLM_MARSPLM_SAP2PLEX_ZCYCLEAUTOASSIGNCONFIG_MATGROUP`, che e' esattamente la stringa del
 * log di produzione.
 *
 * @param {string} entityName nome pieno dell'entity nel modello
 * @param {string} constraintName nome del vincolo dentro `@assert.unique`
 * @returns {string} nome dell'indice, MAIUSCOLO
 */
function indexNameOf(entityName, constraintName) {
  return `${String(entityName || '').replace(/\./g, '_')}_${constraintName}`.toUpperCase();
}

/** Firma tabella+campi con cui si riconosce un vincolo dal messaggio di SQLite. */
function fieldsKey(entityName, fields) {
  const table = String(entityName || '').replace(/\./g, '_').toUpperCase();
  return `${table}|${[...fields].map(f => String(f).toUpperCase()).sort().join(',')}`;
}

/**
 * Dizionario dei vincoli del modello, indicizzato nelle DUE forme in cui i database li nominano.
 *
 * Si costruisce una volta e si tiene in cache sul modello (WeakMap): scorrere ~200 definizioni a
 * ogni errore sarebbe sprecato, ma soprattutto la cache va legata AL MODELLO e non a una variabile
 * di processo, o `cds watch` con un modello ricaricato risponderebbe col dizionario vecchio.
 *
 * @param {Object} model il CSN (`cds.model`)
 * @returns {Map<string, {entity: string, constraint: string, fields: Array<string>}>}
 */
function buildIndexMap(model) {
  const map = new Map();
  const defs = (model && model.definitions) || {};
  for (const name of Object.keys(defs)) {
    const def = defs[name];
    if (!def) continue;
    for (const [constraint, raw] of _constraintsOf(def)) {
      // Le voci sono riferimenti CSN (`{ '=': 'Plant' }` oppure `{ ref: ['Plant'] }`) o stringhe
      // semplici, secondo come il compilatore ha risolto l'annotazione: si accettano tutte e tre
      // le forme, perche' una forma non gestita non da' errore — da' un vincolo assente dal
      // dizionario, cioe' il `500` di prima su quella sola entity.
      const fields = raw.map(f => {
        if (typeof f === 'string') return f;
        if (f && typeof f === 'object') return f['='] || (Array.isArray(f.ref) ? f.ref[f.ref.length - 1] : null);
        return null;
      }).filter(Boolean);
      if (!fields.length) continue;
      const entry = { entity: name, constraint, fields };
      map.set(indexNameOf(name, constraint), entry);
      map.set(fieldsKey(name, fields), entry);
    }
  }
  return map;
}

/**
 * I vincoli `@assert.unique` di UNA definizione, come coppie `[nome, campi]`.
 *
 * DUE forme, e vanno gestite entrambe. Nel CSN caricato l'annotazione arriva APPIATTITA — la chiave
 * e' `@assert.unique.matGroup` e non esiste alcun `@assert.unique` — mentre il compilatore, in altri
 * percorsi, la lascia annidata. Leggerne una sola darebbe un dizionario VUOTO, cioe' la traduzione
 * silenziosamente inerte: il difetto tornerebbe identico senza che nulla lo segnali.
 */
function _constraintsOf(def) {
  const out = [];
  const nested = def['@assert.unique'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const constraint of Object.keys(nested)) {
      if (Array.isArray(nested[constraint])) out.push([constraint, nested[constraint]]);
    }
  }
  const PREFIX = '@assert.unique.';
  for (const key of Object.keys(def)) {
    if (!key.startsWith(PREFIX)) continue;
    const constraint = key.slice(PREFIX.length);
    if (constraint && Array.isArray(def[key])) out.push([constraint, def[key]]);
  }
  return out;
}

const _mapCache = new WeakMap();

function indexMapFor(model) {
  if (!model) return new Map();
  let map = _mapCache.get(model);
  if (!map) {
    map = buildIndexMap(model);
    _mapCache.set(model, map);
  }
  return map;
}

/**
 * Da un errore del driver al vincolo che l'ha causato.
 *
 * @param {Error|Object} err
 * @param {Object} model il CSN
 * @returns {{entity: string, constraint: string, fields: Array<string>}|null} `null` quando
 *   l'errore non e' una violazione di unicita' OPPURE quando il vincolo non si riconosce: in
 *   entrambi i casi l'errore va lasciato passare intatto. Inventare un messaggio su un vincolo
 *   ignoto significherebbe dire all'utente una cosa che non sappiamo.
 */
function describeViolation(err, model) {
  const parsed = parseUniqueViolation(err);
  if (!parsed) return null;
  const map = indexMapFor(model);

  if (parsed.index) return map.get(parsed.index.toUpperCase()) || null;

  // SQLite: la tabella e' nel messaggio, ma se l'insieme di colonne e' unico in tutto il modello
  // si aggancia anche senza. Il fallback NON e' cosmetico: SQLite omette il nome tabella quando la
  // violazione arriva da un indice senza qualificatori.
  if (parsed.table) {
    const hit = map.get(fieldsKey(parsed.table, parsed.fields));
    if (hit) return hit;
  }
  const wanted = [...parsed.fields].map(f => f.toUpperCase()).sort().join(',');
  const candidates = [];
  for (const [key, entry] of map) {
    if (key.includes('|') && key.endsWith(`|${wanted}`)) candidates.push(entry);
  }
  // Un insieme di colonne AMBIGUO si rifiuta invece di prendere il primo: due entity con lo stesso
  // vincolo (`[Plant]` ne ha piu' di una) darebbero un messaggio riferito all'entity sbagliata, che
  // e' peggio del testo tecnico — manda a cercare dalla parte opposta.
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = {
  HANA_UNIQUE_CODE,
  parseUniqueViolation,
  indexNameOf,
  buildIndexMap,
  describeViolation
};

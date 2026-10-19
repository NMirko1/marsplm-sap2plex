/**
 * [COMP-EXCL] Orchestrazione dell'esclusione configurabile dei componenti dell'ordine.
 *
 * Le REGOLE sono in orderCompExclRules.js, che e' puro e collaudato. Qui c'e' solo quello che
 * tocca il mondo: il customizing del plant (con cache, come bomExplode.js), la lettura
 * dell'anagrafica quando serve, e le note per il recap.
 *
 * DOVE SI INNESTA. Subito DOPO l'esplosione dei fantasma, nei tre punti che la chiamano —
 * `loadOrderDetails` del job (che serve anche «Crea Job» e lo spacchettamento), l'albero
 * componenti del cockpit e l'auto-assegnazione manuale. Dopo e non prima, perche' l'esclusione deve
 * valere anche sui figli che l'esplosione ha portato dentro: un fantasma puo' contenere un ZSFR.
 * Vale la stessa ragione scritta in testa a `explodeProdOrderComponents`: in due punti su tre,
 * l'albero a schermo direbbe una cosa e cio' che si allinea su Plex un'altra.
 *
 * NON LANCIA MAI. Su qualunque intoppo restituisce le righe di partenza e lo dichiara in `notes`.
 * Questo codice sta dentro il percorso che disattiva le righe BOM di un job GIA' schedulato su
 * Plex: un'eccezione qui vale un ordine fermo, e un'esclusione fatta al buio vale una distinta
 * svuotata.
 */

'use strict';

// Il require di `@sap/cds` non e' decorativo: e' quello che mette in globale `SELECT`.
require('@sap/cds');
const R = require('./orderCompExclRules');
const productSource = require('./productSource');

const { fetchProductsByKey } = productSource;

/** Nome dell'entity di customizing, in forma pienamente qualificata (come bomExplode.js:45). */
const E_RULE = 'avvaleplm.marsplm.sap2plex.ZOrderCompExclRule';

/** TTL della cache delle regole. L'invalidazione esplicita e' il meccanismo, il TTL la rete. */
const RULES_TTL_MS = Number(process.env.COMP_EXCL_RULES_TTL_MS || 60000);

const rulesCache = new Map(); // plant -> { at, value }

// ================================================================
// Customizing
// ================================================================

/**
 * Le regole di esclusione di un plant, normalizzate e in ordine di valutazione.
 *
 * NESSUNA RIGA => NESSUNA ESCLUSIONE, che e' anche il comportamento di prima (DEC-53). Su lettura
 * FALLITA si va nello stesso stato — non si esclude niente sulla base di un customizing che non si
 * e' potuto leggere — ma la causa viene restituita in `readError`, perche' un plant che ha
 * configurato regole e non le vede applicate deve poterlo sapere.
 *
 * @param {object} db connessione CDS al db
 * @param {string} plant
 * @param {{ force?: boolean }} [opts] `force` ignora la cache (test e diagnostica)
 * @returns {Promise<{ rules: Array<object>, plant: string, readError?: string }>}
 */
async function resolveExclRules(db, plant, opts = {}) {
  const key = plant === null || plant === undefined ? '' : String(plant).trim();
  if (!key) return { rules: [], plant: key };

  const hit = rulesCache.get(key);
  if (!opts.force && hit && (Date.now() - hit.at) < RULES_TTL_MS) return hit.value;

  let value;
  try {
    // Proiezione ESPLICITA: un campo non elencato qui non arriva mai al valutatore.
    const rows = await db.run(
      SELECT.from(E_RULE).columns((r) => {
        r.RuleName, r.Sequence, r.IsActive,
        r.Conditions((c) => { c.SapField, c.Operator, c.Value });
      }).where({ Plant: key })
    );
    value = { rules: R.activeRules(rows), plant: key };
  } catch (e) {
    console.error(`>>> [COMP-EXCL] lettura regole del plant ${key} fallita: ${e.message}`);
    value = { rules: [], plant: key, readError: e.message };
  }
  rulesCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Svuota la cache. La chiamano l'handler after(['CREATE','UPDATE','DELETE']) sulle due entity del
 * customizing e la cascata di `deletePlant`.
 * @param {string} [plant] se assente svuota tutto
 */
function invalidateExclRulesCache(plant) {
  const key = plant === null || plant === undefined ? '' : String(plant).trim();
  if (key) {
    rulesCache.delete(key);
    console.log(`>>> [COMP-EXCL] cache regole invalidata per il plant ${key}`);
  } else {
    rulesCache.clear();
    console.log('>>> [COMP-EXCL] cache regole invalidata (tutti i plant)');
  }
}

// ================================================================
// Colonne da chiedere a SAP
// ================================================================

/**
 * Le regole di TUTTI i plant, per i chiamanti che non conoscono il plant prima di leggere.
 * Cache sotto la chiave `'*'`: e' un elenco di interruttori, non dati SAP.
 */
async function resolveAllExclRules(db, opts = {}) {
  const hit = rulesCache.get('*');
  if (!opts.force && hit && (Date.now() - hit.at) < RULES_TTL_MS) return hit.value;
  let value;
  try {
    const rows = await db.run(
      SELECT.from(E_RULE).columns((r) => {
        r.Plant, r.RuleName, r.Sequence, r.IsActive,
        r.Conditions((c) => { c.SapField, c.Operator, c.Value });
      })
    );
    value = { rules: R.activeRules(rows), plant: '*' };
  } catch (e) {
    console.error(`>>> [COMP-EXCL] lettura regole (tutti i plant) fallita: ${e.message}`);
    value = { rules: [], plant: '*', readError: e.message };
  }
  rulesCache.set('*', { at: Date.now(), value });
  return value;
}

/**
 * Le colonne di `A_ProductionOrderComponent_2` che il customizing richiede, al netto di quelle che
 * il chiamante ha gia' in elenco.
 *
 * Un nome ripetuto nel `$select` e' una richiesta malformata, ed e' la ragione del filtro: il
 * chiamante passa le sue colonne fisse e riceve solo il delta. Su lettura del customizing fallita
 * torna `[]`: senza le colonne le condizioni non aggancerebbero, ma e' lo stesso stato in cui
 * `resolveExclRules` mette le regole — nessuna esclusione, coerente.
 *
 * IL PLANT PUO' NON ESSERE ANCORA NOTO, e non e' un caso limite: la READ dell'albero componenti
 * del cockpit ricava il plant DALLE RIGHE LETTE, cioe' dopo la query. Per questo si accetta anche
 * un ELENCO di plant (quelli in perimetro) o `null` (tutti): l'unione delle colonne e' un
 * sovrainsieme, e una colonna chiesta e non usata da nessuna regola costa un nome nel `$select` —
 * mentre una colonna mancante costa una condizione che non aggancia, in silenzio.
 *
 * @param {object} db
 * @param {string|Array<string>|null} plant un plant, un elenco di plant, o `null` per tutti
 * @param {Array<string>} [already] colonne gia' presenti nel `$select` del chiamante
 * @returns {Promise<Array<string>>}
 */
async function extraComponentColumns(db, plant, already = []) {
  const have = new Set(already || []);
  const list = Array.isArray(plant)
    ? plant.map((p) => String(p || '').trim()).filter(Boolean)
    : (plant === null || plant === undefined || String(plant).trim() === '' ? null : [String(plant).trim()]);

  const cols = new Set();
  if (list === null) {
    const { rules } = await resolveAllExclRules(db);
    for (const c of R.selectColumns(rules)) cols.add(c);
  } else {
    for (const p of list) {
      const { rules } = await resolveExclRules(db, p);
      for (const c of R.selectColumns(rules)) cols.add(c);
    }
  }
  return [...cols].filter((c) => !have.has(c));
}

// ================================================================
// Applicazione
// ================================================================

/**
 * Applica l'esclusione a un elenco di componenti d'ordine.
 *
 * @param {object} args
 * @param {object} args.db connessione CDS al db
 * @param {string} args.plant plant dell'ordine (dalla testata: i componenti non sempre lo portano)
 * @param {Array<object>} args.rows righe di `A_ProductionOrderComponent_2`
 * @param {object} [args.productSrc] sorgente materiali gia' aperta dal chiamante (si riusa)
 * @param {Map<string, object>} [args.materialCache] cache materiale -> riga d'anagrafica, viva
 *   quanto l'operazione del chiamante. Come la cache di `bomExplode`: dati SAP non si tengono
 *   caldi a livello di processo, ma un job che itera su molti ordini dello stesso plant non deve
 *   rileggere lo stesso materiale a ogni ordine.
 * @param {string} [args.tag] prefisso di log
 * @returns {Promise<{ rows: Array<object>, excluded: Array<object>, applied: boolean,
 *   stats: object|null, notes: Array<{level: string, text: string}> }>}
 */
async function applyComponentExclusions(args) {
  const { db, plant, rows, productSrc, materialCache, tag = '' } = args || {};
  const inert = { rows: rows || [], excluded: [], applied: false, stats: null, notes: [] };
  if (!inert.rows.length) return inert;

  try {
    const p = plant === null || plant === undefined ? '' : String(plant).trim();
    if (!p) return inert;

    const { rules, readError } = await resolveExclRules(db, p);
    if (readError) {
      inert.notes.push({
        level: 'W',
        text: `regole di esclusione componenti del plant ${p} non leggibili (${readError}):`
          + ' nessuna esclusione applicata'
      });
      return inert;
    }
    if (!rules.length) return inert;

    // L'anagrafica si legge SOLO se una regola attiva la usa: su Integration Suite A_Product non
    // ha un _QUERYGET e ogni materiale e' una chiamata per chiave (DEC-43).
    let materialByProduct;
    if (R.needsMaterialRead(rules)) {
      const wanted = [...new Set(inert.rows.map((r) => String(r?.Material || '').trim()).filter(Boolean))];
      const read = await loadMaterials({
        products: wanted, columns: R.materialColumns(rules), productSrc, cache: materialCache, tag
      });
      materialByProduct = read.byProduct;
      for (const n of read.notes) inert.notes.push(n);
    }

    const { kept, excluded, stats } = R.partition({ components: inert.rows, rules, materialByProduct });

    const line = R.describe(stats);
    if (line) {
      console.log(`>>> [COMP-EXCL] ${tag ? `${tag}: ` : ''}${line}`);
      inert.notes.push({ level: 'I', text: line });
    }
    // Un criterio che non si e' potuto valutare NON esclude, e non resta muto: e' il caso in cui
    // il perimetro applicato e' piu' LARGO di quello configurato, e senza dichiararlo sarebbe
    // indistinguibile da un perimetro configurato cosi'.
    if (stats.unevaluable.length) {
      const materials = [...new Set(stats.unevaluable.map((u) => u.material))];
      const text = `criteri di esclusione non valutabili su ${materials.length} materiali`
        + ` (anagrafica non letta: ${materials.slice(0, 10).join(', ')}`
        + `${materials.length > 10 ? ', …' : ''}): i loro componenti NON sono stati esclusi`;
      console.warn(`>>> [COMP-EXCL] ${tag ? `${tag}: ` : ''}${text}`);
      inert.notes.push({ level: 'W', text });
    }

    return { rows: kept, excluded, applied: true, stats, notes: inert.notes };
  } catch (e) {
    // Il percorso disattiva righe BOM di un job schedulato: si torna alle righe di partenza.
    const text = `esclusione componenti non applicata (${e.message}): elenco invariato`;
    console.error(`>>> [COMP-EXCL] ${tag ? `${tag}: ` : ''}${text}`);
    inert.notes.push({ level: 'W', text });
    return inert;
  }
}

/**
 * Le anagrafiche dei materiali citati, dalla cache o da SAP.
 *
 * Una chiave ASSENTE dalla mappa restituita significa «non letta», ed e' cio' su cui
 * `partition` decide di non escludere: per questo un materiale che la lettura non ha reso NON
 * viene messo nella mappa con una riga vuota.
 */
async function loadMaterials({ products, columns, productSrc, cache, tag }) {
  const byProduct = cache instanceof Map ? cache : new Map();
  const notes = [];
  const missing = products.filter((m) => !byProduct.has(m));
  if (!missing.length) return { byProduct, notes };

  const src = productSrc || await productSource();
  // `Product` serve come chiave della mappa, i campi del customizing come valori. Tutti e quattro
  // i campi MATERIAL del catalogo sono gia' in PRODUCT_SELECT: la lettura non va estesa.
  const wantedColumns = [...new Set(['Product', ...columns])];
  const { byProduct: read, failed } = await fetchProductsByKey(src, missing, {
    columns: wantedColumns,
    onpremColumns: wantedColumns
  });
  for (const [k, v] of read) byProduct.set(k, v);

  if (failed && failed.length) {
    const text = `anagrafica non letta per ${failed.length} materiali`
      + ` (${failed.slice(0, 5).map((f) => f.key).join(', ')}${failed.length > 5 ? ', …' : ''})`;
    console.warn(`>>> [COMP-EXCL] ${tag ? `${tag}: ` : ''}${text}`);
    notes.push({ level: 'W', text });
  }
  return { byProduct, notes };
}

/** Una cache di anagrafiche, viva quanto l'operazione che la crea (vedi `applyComponentExclusions`). */
function createMaterialCache() {
  return new Map();
}

module.exports = {
  resolveExclRules,
  resolveAllExclRules,
  invalidateExclRulesCache,
  extraComponentColumns,
  applyComponentExclusions,
  createMaterialCache,
  E_RULE
};

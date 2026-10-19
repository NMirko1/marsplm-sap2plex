/**
 * [KEY-READ] Il criterio EFFETTIVO di una lettura in ingresso — feature 0041.
 *
 * PERCHE' ESISTE
 * In una lettura OData **per chiave** — `GET /products/Products(Product='X',Plant='07')` — CAP
 * NON mette il predicato in `SELECT.where`: lo mette in `SELECT.from.ref[<ultimo>].where` e alza
 * `SELECT.one`. Verificato eseguendo cds 9.9.2:
 *
 *     ### SELECT.where = undefined
 *     ### SELECT.from  = {"ref":[{"id":"P.Things","where":[…Product='X' and Plant='07'…]}]}
 *     ### SELECT.one   = true
 *
 * Tutti i tredici handler `on('READ')` custom del progetto leggevano il solo `SELECT.where`,
 * quindi su una lettura per chiave non vedevano NESSUN criterio e restituivano una pagina di
 * righe. E CAP, per una lettura singola, prende `result[0]` **senza confrontare la chiave**
 * (`libx/odata/utils/result.js:62`): rispondeva `200` con la riga sbagliata. Sul dettaglio
 * materiale del cockpit questo significava vedere un materiale e, premendo «Invia a Plex»,
 * scriverne un altro sul tenant di un altro plant — senza un errore da nessuna parte.
 *
 * Il repo sapeva gia' dove guardare: `deriveOp` in srv/lib/isQueryShape.js legge il key predicate
 * da `from.ref[0].where`. Ma quel modulo riguarda le query in USCITA verso l'Integration Suite,
 * e la sua intestazione lo dichiara: questo modulo riguarda la query IN INGRESSO dal client, ed e'
 * per questo che sono due. L'unico punto del progetto che gia' faceva la cosa giusta e'
 * `connReadPlant` (srv/cat-service.js), per una entity sola: qui la stessa regola diventa
 * condivisa e collaudabile.
 *
 * Nessuna dipendenza oltre a `isQueryShape`, che e' a sua volta puro: ne' `cds`, ne' rete, ne' db,
 * ne' orologio. Non aggiungerne: il test si lancia con
 *     node test/keyReadRules.test.js
 *
 * Nessuna funzione muta l'input.
 *
 * Perimetro: grep -rn "KEY-READ"
 */

'use strict';

const { splitTopLevelAnd, joinAnd, lastRef } = require('./isQueryShape');

// ================================================================
// Le due forme del criterio
// ================================================================

/**
 * L'ULTIMO segmento di `SELECT.from.ref`: una stringa `'ns.E'` oppure un oggetto `{id, where}`.
 *
 * L'ultimo e non il primo: su una navigazione — `Entity(chiave)/toMany` — il key predicate sta sul
 * segmento che porta la chiave, e leggere sempre `ref[0]` prenderebbe la chiave del PADRE
 * scambiandola per quella della lettura.
 *
 * @param {object} query CQN
 * @returns {object|string|undefined}
 */
function fromRefTail(query) {
  const ref = query && query.SELECT && query.SELECT.from && query.SELECT.from.ref;
  return Array.isArray(ref) && ref.length ? ref[ref.length - 1] : undefined;
}

/**
 * Il predicato di CHIAVE della lettura, se c'e'.
 * @param {object} query CQN
 * @returns {Array|undefined}
 */
function keyPredicateOf(query) {
  const tail = fromRefTail(query);
  const where = tail && typeof tail === 'object' ? tail.where : undefined;
  return Array.isArray(where) && where.length ? where : undefined;
}

/** Il `$filter` del client, cioe' il `where` di primo livello. */
function filterWhereOf(query) {
  const where = query && query.SELECT && query.SELECT.where;
  return Array.isArray(where) && where.length ? where : undefined;
}

/**
 * Il `where` EFFETTIVO della lettura: l'unione delle due forme.
 *
 * E' la sostituzione da fare in ogni handler che oggi legge `req.query?.SELECT?.where`.
 *
 * CON UNA SOLA FORMA PRESENTE SI RESTITUISCE QUELL'ARRAY, PER RIFERIMENTO. Non e' un dettaglio di
 * prestazioni: `pluckEquality` ha una via rapida che confronta l'identita' del `where` residuo, e
 * restituire una copia la spegnerebbe. Soprattutto, e' cio' che rende il cambiamento
 * DIMOSTRABILMENTE INERTE sulle letture di lista, che oggi funzionano e non devono cambiare.
 *
 * CON ENTRAMBE LE FORME l'unione dipende da cosa contengono:
 *   - se entrambe si spezzano in AND, si concatenano PIATTE, con la chiave PRIMA (cosi' chi legge
 *     «il primo vince» prende il valore autorevole);
 *   - se una delle due contiene un `or` di primo livello si avvolgono in `{xpr}`. La
 *     concatenazione piatta sarebbe SBAGLIATA: `A or B` seguito da `and K='x'` si legge
 *     `A or (B and K='x')`, perche' l'AND lega piu' forte. Nessun errore, risultato diverso.
 *
 * @param {object} query CQN
 * @returns {Array|undefined}
 */
function readWhere(query) {
  const key = keyPredicateOf(query);
  const filter = filterWhereOf(query);
  if (!key) return filter;
  if (!filter) return key;

  const keyTerms = splitTopLevelAnd(key);
  const filterTerms = splitTopLevelAnd(filter);
  if (keyTerms && filterTerms) return joinAnd([...keyTerms, ...filterTerms]);
  return [{ xpr: key }, 'and', { xpr: filter }];
}

// ================================================================
// Uguaglianze
// ================================================================

/** Un termine `[{ref}, '=', {val}]`? (`isEqualityTerm` di isQueryShape non e' esportata.) */
function isEquality(term) {
  return Array.isArray(term) && term.length === 3
    && term[0] && term[0].ref
    && term[1] === '='
    && term[2] && typeof term[2] === 'object' && 'val' in term[2];
}

/**
 * Le uguaglianze semplici di primo livello di un `where`, limitate a `names` (tutte se vuoto).
 *
 * DUE REGOLE CHE NON SONO OVVIE:
 *
 * 1. IL VALORE VUOTO E' UN VALORE. Il criterio e' `'val' in node`, non la verita' del valore: i sei
 *    loop scritti a mano che questa funzione sostituisce facevano `if (!val) continue` e
 *    scartavano `Material = ''`, che sull'entity `Routings` e' una chiave DICHIARATA legittima
 *    (l'unica riga con chiave a valore vuoto, vedi srv/cat-service.cds). Con quel controllo, la
 *    lettura per chiave di un ciclo senza assegnazione materiale non sarebbe filtrata affatto.
 *
 * 2. PRIMO-VINCE, dove i loop di prima erano ultimo-vince. Differisce solo se lo stesso campo
 *    compare due volte in AND — cosa che nessun chiamante di questo progetto fa — ed e' la
 *    direzione giusta: `readWhere` mette la CHIAVE davanti al `$filter`, quindi in caso di
 *    conflitto vince l'identita' della riga chiesta, non un criterio aggiunto sopra.
 *
 * Un `or` di primo livello NON si scompone: togliere o valutare un termine dentro un OR
 * cambierebbe la semantica del filtro. Si dichiara con `topLevelOr` e non si estrae niente.
 *
 * @param {Array|undefined} where
 * @param {string[]} [names]
 * @returns {{ equals: object, topLevelOr: boolean }}
 */
function equalitiesOf(where, names = []) {
  const wanted = names.length ? new Set(names) : null;
  const terms = splitTopLevelAnd(where);
  if (!terms) return { equals: {}, topLevelOr: Array.isArray(where) && where.length > 0 };

  const equals = {};
  for (const term of terms) {
    if (!isEquality(term)) continue;
    const name = lastRef(term[0]);
    if (!name) continue;
    if (wanted && !wanted.has(name)) continue;
    if (name in equals) continue;              // primo-vince, vedi la regola 2
    equals[name] = term[2].val;
  }
  return { equals, topLevelOr: false };
}

/**
 * L'IDENTITA' di una lettura: cosa e' stato chiesto, e se e' una lettura singola.
 *
 * `complete` significa che TUTTE le chiavi dell'entity sono state determinate: e' la condizione
 * per poter filtrare senza rischio di scartare righe legittime. Una chiave PARZIALE (`$filter` su
 * uno solo dei due campi chiave) resta `complete: false` e non autorizza nessun filtro d'identita'.
 *
 * @param {object} query CQN
 * @param {string[]} keys i nomi dei campi chiave dell'entity
 * @returns {{one: boolean, equals: object, missing: string[], complete: boolean,
 *            from: 'none'|'key'|'filter'|'both'}}
 */
function keyReadOf(query, keys = []) {
  const key = keyPredicateOf(query);
  const filter = filterWhereOf(query);

  // Le due forme si scompongono SEPARATAMENTE, e non e' un vezzo: spezzando l'array gia' unito, un
  // `or` di primo livello nel `$filter` farebbe rendere `null` a splitTopLevelAnd e la chiave si
  // perderebbe — cioe' il difetto tornerebbe dov'era, e solo su una richiesta esotica.
  const fromKey = equalitiesOf(key, keys).equals;
  const fromFilter = equalitiesOf(filter, keys).equals;
  const equals = { ...fromFilter, ...fromKey };   // la CHIAVE e' autorevole sul $filter

  const missing = keys.filter((k) => !(k in equals));
  const hasKey = Object.keys(fromKey).length > 0;
  const hasFilter = Object.keys(fromFilter).length > 0;

  return {
    one: !!(query && query.SELECT && query.SELECT.one === true),
    equals,
    missing,
    complete: keys.length > 0 && missing.length === 0,
    from: hasKey && hasFilter ? 'both' : hasKey ? 'key' : hasFilter ? 'filter' : 'none'
  };
}

// ================================================================
// Confronto
// ================================================================

/**
 * La riga corrisponde alle uguaglianze richieste?
 *
 * IL CONFRONTO E' STRETTO, ed e' DEC-51: fra due chiavi scritte da SAP gli zeri iniziali non si
 * allineano, perche' un disallineamento e' un difetto a monte che deve restare visibile. Qui
 * entrambi i lati vengono da SAP — l'URL porta la chiave che una nostra lista ha emesso — quindi
 * la tolleranza sarebbe mascheramento.
 *
 * L'UNICA DEROGA e' la grafia degli UUID (`caseInsensitive`), ed e' DEC-63: la' i due lati vengono
 * da due posti diversi (l'URL e il database) e `F9EEC9B7…` *e'* `f9eec9b7…`. Serve alle sei entity
 * locali del progetto, che hanno tutte `key ID : UUID`.
 *
 * `null` e `undefined` sulla riga valgono come stringa vuota: e' la stessa normalizzazione che il
 * filtro a valle di `READ Products` usa da sempre.
 *
 * @param {object} row
 * @param {object} equals
 * @param {{caseInsensitive?: string[]}} [opts]
 * @returns {boolean}
 */
function matchesKey(row, equals, opts = {}) {
  if (!row || typeof row !== 'object') return false;
  const loose = new Set(opts.caseInsensitive || []);
  for (const [field, wanted] of Object.entries(equals || {})) {
    const actual = String(row[field] ?? '');
    const expected = String(wanted ?? '');
    const same = loose.has(field)
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
    if (!same) return false;
  }
  return true;
}

// ================================================================
// La tabella della rete
// ================================================================

/**
 * Le entity servite da un handler `on('READ')` CUSTOM, per nome di servizio.
 *
 * Un handler custom costruisce l'array a mano, quindi il predicato di chiave non lo applica il
 * database: lo deve applicare l'handler, e la rete di srv/cat-service.js e' cio' che verifica che
 * l'abbia fatto. Su ogni altra entity il database filtra da se' e la rete sarebbe peso morto.
 *
 * SI STA IN QUESTO ELENCO, NON IN UN `'*'`, e l'elenco e' sorvegliato da
 * test/keyReadGuarded.test.js: un quattordicesimo handler aggiunto e non registrato qui
 * renderebbe la rete cieca su di lui, in silenzio.
 *
 * Le CHIAVI non si scrivono qui: si leggono dal CSN (`req.target.keys`), o una chiave aggiunta al
 * modello e non a questa tabella produrrebbe lo stesso silenzio.
 */
const GUARDED_ENTITIES = Object.freeze({
  Product: Object.freeze(['Products']),
  ProductionOrder: Object.freeze([
    'ProductionOrders', 'ProductionOrderOperations', 'ProductionOrderComponents',
    'PlexCycleOperations', 'PlexCycleComponents', 'PlexCycleApprovedWorkcenters',
    // [PLANT-ACCESS] La quarta tabella dell'albero, che dalla 0048 ha il suo handler: prima
    // leggeva dall'handler generico di CAP, e una GET senza criteri rendeva la tabella intera.
    'PlexCycleRemovedComponents'
  ]),
  ProductionRouting: Object.freeze([
    'Routings', 'RoutingOperations', 'RoutingComponentAllocations',
    'PlexRoutingCycleOperations', 'PlexRoutingCycleComponents', 'PlexRoutingApprovedWorkcenters'
  ])
});

module.exports = {
  fromRefTail,
  keyPredicateOf,
  filterWhereOf,
  readWhere,
  equalitiesOf,
  keyReadOf,
  matchesKey,
  GUARDED_ENTITIES
};

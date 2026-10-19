/**
 * [IS-SOURCE] Forma delle query verso i service root di SAP Integration Suite (feature 0013).
 *
 * Qui vivono le trasformazioni delicate di questa migrazione — derivazione della coppia
 * (entity, operazione) dal CQN, riscrittura in key predicate, spezzettamento delle liste
 * `in`, pianificazione del fan-out per chiave, riconoscimento del filtro del client,
 * sospetto di troncamento — estratte in funzioni **pure** per un motivo preciso: sono le
 * uniche cose di questa feature che si possono verificare senza toccare l'Integration
 * Suite. Le quattordici righe del piano di test (TDD 0013 §8.1) diventano altrettante
 * asserzioni in test/isQueryShape.test.js.
 *
 * Nessuna dipendenza: né `cds`, né rete, né database, né stato globale. Non aggiungerne:
 * il test si lancia con `node test/isQueryShape.test.js`, senza runtime CAP.
 *
 * NESSUNA FUNZIONE MUTA L'INPUT. È la proprietà che rende innocuo spezzettare o
 * riscrivere una query che il chiamante riusa (U-09).
 *
 * L'orchestrazione (istanze remote, chiamate, concorrenza, log) sta in srv/lib/isRemoteSource.js.
 */

'use strict';

// ================================================================
// Lettura del CQN
// ================================================================

/** Ultimo segmento di un `ref` (`['to_X','Product']` -> `'Product'`). */
function lastRef(node) {
  const ref = node && node.ref;
  return Array.isArray(ref) && ref.length ? ref[ref.length - 1] : undefined;
}

/** Primo elemento di `SELECT.from.ref`: stringa `'ns.E'` oppure oggetto `{id, where}`. */
function fromRefHead(query) {
  const ref = query && query.SELECT && query.SELECT.from && query.SELECT.from.ref;
  return Array.isArray(ref) ? ref[0] : undefined;
}

/** Nome entity NON qualificato dal CQN. Gestisce ref:['ns.E'] e ref:[{id:'ns.E'}]. */
function entityNameOf(query) {
  const head = fromRefHead(query);
  const id = head && typeof head === 'object' ? head.id : head;
  return typeof id === 'string' ? id.split('.').pop() : undefined;
}

/**
 * Operazione richiesta dalla query, secondo la regola meccanica di TD-4:
 *   GET   se `SELECT.one === true` oppure se `from.ref[0].where` è già un key predicate
 *   QUERY altrimenti
 * L'ambiguità non è un caso da gestire: è routeFor() a decidere cosa farne.
 */
function deriveOp(query) {
  if (query && query.SELECT && query.SELECT.one === true) return 'GET';
  const head = fromRefHead(query);
  if (head && typeof head === 'object' && head.where) return 'GET';
  return 'QUERY';
}

/** True se la query porta una navigazione espansa (colonna con `expand`). */
function hasExpand(query) {
  const cols = query && query.SELECT && query.SELECT.columns;
  return Array.isArray(cols) && cols.some(c => c && c.expand);
}

/** `$top` dichiarato dalla query, oppure undefined. */
function topOf(query) {
  const rows = query && query.SELECT && query.SELECT.limit && query.SELECT.limit.rows;
  return rows ? Number(rows.val) : undefined;
}

// ================================================================
// Route table
// ================================================================

/**
 * Rotta della coppia (entity, op) nella route table della sorgente.
 *
 * - entity assente dalla tabella                  -> throw (FR-02: un mis-route silenzioso
 *   produrrebbe dati plausibili e sbagliati, che è l'esito peggiore);
 * - op mancante ma l'entity ha UNA SOLA rotta      -> si usa quella, con `fallback: true`
 *   così che la sorgente possa dichiararlo nel log (è il caso di ProductionRoutingHeader,
 *   che ha solo il _QUERYGET);
 * - op mancante e l'entity ha DUE rotte            -> throw (instradamento ambiguo).
 *
 * @returns {{entity:string, op:string, fallback:boolean, derivedOp:string,
 *            keyPredicate?:string[], fanOut?:string, expectsList?:boolean, collectionFilter?:string,
 *            tolerant?:boolean, identity?:string[]}}
 */
function routeFor(routes, entity, op) {
  if (!entity) {
    throw new Error('[IS-SOURCE] query senza entity riconoscibile: impossibile scegliere un indirizzo');
  }
  const byOp = routes && routes[entity];
  if (!byOp) {
    throw new Error(
      `[IS-SOURCE] entity '${entity}' non prevista dalla route table ` +
      `(ammesse: ${Object.keys(routes || {}).join(', ') || 'nessuna'})`
    );
  }
  if (byOp[op]) return { ...byOp[op], entity, op, derivedOp: op, fallback: false };
  const ops = Object.keys(byOp);
  if (ops.length === 1) {
    return { ...byOp[ops[0]], entity, op: ops[0], derivedOp: op, fallback: true };
  }
  throw new Error(
    `[IS-SOURCE] entity '${entity}': nessun indirizzo per l'operazione ${op} e ` +
    `${ops.length} rotte disponibili (${ops.join(', ')}): instradamento ambiguo`
  );
}

/**
 * Il path di un service root deve iniziare con '/': CAP concatena `service.path` così
 * com'è (remote/utils/query.js), quindi senza lo slash iniziale l'URL risulta malformato
 * senza alcun errore (anomalia A1 del foglio degli endpoint). Il `;v=1` non va toccato:
 * `encodeURI` lascia passare `;` e `=`.
 */
function assertPath(key, path) {
  if (!path || typeof path !== 'string') {
    throw new Error(`[IS-SOURCE] path mancante per '${key}'`);
  }
  if (!path.startsWith('/')) {
    throw new Error(`[IS-SOURCE] il path di '${key}' deve iniziare con '/': ${path}`);
  }
  return path;
}

// ================================================================
// where: scomposizione e ricomposizione
// ================================================================

/** Un termine `[{ref}, '=', {val}]`? */
function isEqualityTerm(term) {
  return Array.isArray(term) && term.length === 3
    && term[0] && term[0].ref
    && term[1] === '='
    && term[2] && typeof term[2] === 'object' && 'val' in term[2];
}

/**
 * Spezza un `where` di primo livello nei suoi termini in AND.
 * Restituisce `null` se il primo livello contiene un OR: togliere o riscrivere un termine
 * dentro un OR cambierebbe la semantica del filtro, e questo modulo non lo fa mai.
 */
function splitTopLevelAnd(where) {
  if (!Array.isArray(where) || where.length === 0) return null;
  const terms = [];
  let current = [];
  for (const token of where) {
    if (typeof token === 'string') {
      const op = token.toLowerCase();
      if (op === 'and') { terms.push(current); current = []; continue; }
      if (op === 'or') return null;
    }
    current.push(token);
  }
  terms.push(current);
  return terms;
}

/** Ricompone termini in AND in un `where` piatto. */
function joinAnd(terms) {
  const out = [];
  for (const t of terms) {
    if (!t.length) continue;
    if (out.length) out.push('and');
    out.push(...t);
  }
  return out;
}

/**
 * Uguaglianze semplici presenti nel `where`, limitate ai nomi richiesti (tutte se `names`
 * è vuoto). Ignora `in`, `like`, funzioni e qualunque cosa dentro un OR.
 */
function equalityMap(query, names) {
  const out = {};
  const terms = splitTopLevelAnd(query && query.SELECT && query.SELECT.where);
  if (!terms) return out;
  const want = new Set(names || []);
  for (const term of terms) {
    if (!isEqualityTerm(term)) continue;
    const name = lastRef(term[0]);
    if (name === undefined) continue;
    if (want.size && !want.has(name)) continue;
    if (!(name in out)) out[name] = term[2].val;
  }
  return out;
}

/**
 * Estrae dal `where` l'uguaglianza semplice su `field` e restituisce il RESIDUO senza quel
 * termine: `{ val, rest }`, con `val` `undefined` se il campo non c'è.
 *
 * Serve dove un campo inviato dal client NON va inoltrato così com'è alla sorgente, perché è
 * il chiamante a decidere se e come usarlo: è il caso dell'AUFPL sulle operazioni d'ordine,
 * che in `IS` diventa key predicate e in `ONPREM` non deve arrivare al gateway (DEC-42, DEC-34).
 * Se il primo livello contiene un OR non si tocca nulla (`splitTopLevelAnd` -> `null`): togliere
 * un termine da dentro un OR cambierebbe la semantica del filtro.
 */
function pluckEquality(where, field) {
  const terms = splitTopLevelAnd(where);
  if (!terms) return { val: undefined, rest: where };
  let val;
  const kept = [];
  for (const term of terms) {
    if (val === undefined && isEqualityTerm(term) && lastRef(term[0]) === field) {
      val = term[2].val;
      continue;
    }
    kept.push(term);
  }
  if (val === undefined) return { val: undefined, rest: where };
  const rest = joinAnd(kept);
  return { val, rest: rest.length ? rest : null };
}

/** Indice del token `{ref:[name]}` di un termine `name in (…)` di primo livello, altrimenti -1. */
function inListIndex(where, name) {
  if (!Array.isArray(where)) return -1;
  for (let i = 0; i < where.length; i++) {
    if (!where[i] || !where[i].ref) continue;
    if (lastRef(where[i]) !== name) continue;
    if (String(where[i + 1]).toLowerCase() !== 'in') continue;
    if (!where[i + 2] || !Array.isArray(where[i + 2].list)) continue;
    return i;
  }
  return -1;
}

/** Valore grezzo di un elemento di `list` (`{val:'x'}` -> `'x'`). */
function listValue(item) {
  return item && typeof item === 'object' && 'val' in item ? item.val : item;
}

/** Copia della query senza `SELECT.one` (l'indirizzo risponde con la lista dei figli). */
function withoutOne(query) {
  const SELECT = { ...query.SELECT };
  delete SELECT.one;
  return { SELECT };
}

/**
 * Riscrive la query in `Entity(k1='…',k2='…')` quando TUTTE le chiavi sono risolvibili
 * come uguaglianza semplice nel `where`. Le condizioni consumate escono dal `where`
 * (il residuo resta accanto al key predicate); `$select`, `$top`, `$skip` e le altre
 * condizioni sono conservati.
 *
 * `expectsList: true` rimuove `SELECT.one`: l'indirizzo padre->figli risponde con la
 * lista, e con `one` il client remoto scarterebbe tutte le righe tranne la prima.
 *
 * Chiavi incomplete -> `applied: false` e query **invariata**: sarà la sorgente a
 * dichiarare nel log che la lettura resta in forma collection + `$filter`.
 *
 * [IS-FULL-KEY] `blanks` sono le chiavi che l'entity DICHIARA e che l'applicazione non
 * conosce: entrano nel predicate con valore VUOTO. Serve dove l'indirizzo pretende il
 * predicate completo e la funzione dietro di esso tratta quei parametri come opzionali —
 * vuoto vale «tutti» (DEC-41). Non sono mai `missing`: il criterio tutto-o-niente resta
 * sulle sole `keys`, perché una chiave di `keys` inventata vuota cambierebbe l'insieme
 * letto invece di allargarlo. Se una `blanks` è comunque risolvibile dal `where`, si invia
 * col SUO valore e il termine esce dal `where` come per le altre chiavi.
 * L'ordine del predicate è `[...keys, ...blanks]`.
 *
 * `blankValues` è la deroga per chiave sul valore di riempimento, che per difetto è la stringa
 * vuota: serve dove l'indirizzo **non accetta** il valore vuoto e pretende un altro «iniziale»
 * — per esempio `'0'` dove il parametro dietro la chiave è NUMERICO, e una stringa vuota o uno
 * spazio non sono convertibili (`CX_SY_CONVERSION_NO_NUMBER`). Il valore è dichiarato nella route
 * table e la sorgente lo scrive nel log: un `0` in un URL non si distingue da una svista, e senza
 * dichiararlo sembrerebbe un difetto di riempimento.
 */
function toKeyPredicate(query, keys, { expectsList = false, blanks = [], blankValues = {} } = {}) {
  const wanted = Array.isArray(keys) ? keys : [];
  const filler = (Array.isArray(blanks) ? blanks : []).filter(k => !wanted.includes(k));
  const all = [...wanted, ...filler];
  const fillOf = (k) => (blankValues && Object.prototype.hasOwnProperty.call(blankValues, k)
    ? blankValues[k]
    : '');
  const terms = splitTopLevelAnd(query && query.SELECT && query.SELECT.where);
  const found = new Map();
  if (terms) {
    for (const term of terms) {
      if (!isEqualityTerm(term)) continue;
      const name = lastRef(term[0]);
      if (all.includes(name) && !found.has(name)) found.set(name, { term, val: term[2].val });
    }
  }
  const missing = wanted.filter(k => !found.has(k));
  if (!wanted.length || missing.length) return { query, applied: false, missing };

  const consumed = new Set([...found.values()].map(f => f.term));
  const residual = joinAnd(terms.filter(t => !consumed.has(t)));

  const head = fromRefHead(query);
  const id = head && typeof head === 'object' ? head.id : head;
  const predicate = [];
  for (const k of all) {
    if (predicate.length) predicate.push('and');
    predicate.push({ ref: [k] }, '=', { val: found.has(k) ? found.get(k).val : fillOf(k) });
  }

  const from = { ...query.SELECT.from, ref: [{ id, where: predicate }, ...query.SELECT.from.ref.slice(1)] };
  const SELECT = { ...query.SELECT, from };
  if (residual.length) SELECT.where = residual; else delete SELECT.where;
  if (expectsList) delete SELECT.one;
  // [IS-FULL-KEY] `$top` e `$skip` sono opzioni di COLLECTION: su una lettura per chiave il
  // gateway le rifiuta con 400 «System query option '$top' is not compatible with the return
  // type», perché il return type dichiarato dall'indirizzo è l'entity — anche quando poi la
  // function module risponde con la lista dei figli. Il tetto scritto al call site non è
  // comunque applicabile qui: quante righe tornano lo decide l'indirizzo. `$select` resta.
  delete SELECT.limit;
  return { query: { SELECT }, applied: true, missing: [] };
}

/** Indice del nodo `{list:[…]}` di primo livello la cui lista supera `max`, altrimenti -1. */
function oversizedListIndex(where, max) {
  if (!Array.isArray(where)) return -1;
  return where.findIndex(n => n && Array.isArray(n.list) && n.list.length > max);
}

/**
 * Spezza la lista `in` più lunga di `max` in N query clonate (DEC-19). In OData V2 un
 * `{ in: [...] }` viene espanso in un OR di `eq`, e oltre `max_get_url_length` CAP
 * converte il GET in `POST /$batch` multipart/mixed in automatico e in silenzio: un iFlow
 * basato su function module quasi certamente non lo espone.
 *
 * Il `$top` originale resta applicato a OGNI chunk: era un tetto di sicurezza contro
 * letture illimitate, e per chunk lo resta.
 */
function splitInList(query, max) {
  const where = query && query.SELECT && query.SELECT.where;
  const idx = oversizedListIndex(where, max);
  if (idx < 0) return [query];
  const list = where[idx].list;
  const out = [];
  for (let i = 0; i < list.length; i += max) {
    const w = where.slice();
    w[idx] = { list: list.slice(i, i + max) };
    out.push({ SELECT: { ...query.SELECT, where: w } });
  }
  return out;
}

/**
 * Trasforma `{key: {in: [v1…vN]}}` in N query **per chiave**, una per valore.
 *
 * Esiste perché un key predicate NON può contenere una lista: `SELECT.from(E, {k:{in:[…]}})`
 * produce un URL corrotto (`…(ProductionRoutingGroupin[object Object],…)`). Non è un limite
 * da aggirare con più attenzione: è la ragione per cui una lista su una rotta solo-`GET`
 * DEVE diventare N chiamate.
 *
 * `throw` se la query porta un `expand`: una lettura per chiave non può portarsi dietro
 * una navigazione.
 *
 * @param {number} [maxCalls] tetto opzionale al numero di letture. Le sorgenti NON lo
 *   passano (FR-08: la completezza prevale sulla durata, nessun tetto); è nella firma
 *   perché un chiamante futuro possa limitarsi in modo esplicito e non per errore.
 */
function fanOutByKey(query, keyName, maxCalls = 0) {
  if (hasExpand(query)) {
    throw new Error(
      `[IS-SOURCE] fan-out su '${keyName}' impossibile: la query contiene un $expand, ` +
      'e una lettura per chiave non può portarsi dietro una navigazione'
    );
  }
  const where = query && query.SELECT && query.SELECT.where;
  const i = inListIndex(where, keyName);
  if (i < 0) return [query];
  const list = where[i + 2].list;
  if (maxCalls > 0 && list.length > maxCalls) {
    throw new Error(`[IS-SOURCE] fan-out su '${keyName}': ${list.length} letture oltre il tetto ${maxCalls}`);
  }
  return list.map(item => {
    const w = where.slice();
    w.splice(i, 3, { ref: [keyName] }, '=', { val: listValue(item) });
    return { SELECT: { ...query.SELECT, where: w } };
  });
}

// ================================================================
// Troncamento
// ================================================================

/**
 * Sospetto di troncamento (FR-12). CAP **non segue** `__next`: lo copia in una proprietà
 * non enumerabile `$next` che nessuno legge, quindi un troncamento lato server produrrebbe
 * una pagina plausibile e incompleta, con conteggi coerenti e dati mancanti.
 */
function looksTruncated(rows, top) {
  if (rows && rows.$next != null) return true;
  if (!Array.isArray(rows)) return false;
  return !!top && rows.length === top;
}

// ================================================================
// Righe prive di identità
// ================================================================

/**
 * [IS-BLANK-ROWS] Valore di identità di una riga: stringa vuota se il campo manca o è nullo.
 * Il `trim` serve a riconoscere come vuoto un campo a soli spazi, che è come una CHAR ABAP
 * iniziale può arrivare da un mapping. NON normalizza il valore restituito al chiamante:
 * qui si decide soltanto «c'è o non c'è» (TD-10, C-7).
 */
function identityValue(row, field) {
  const v = row ? row[field] : undefined;
  return v === undefined || v === null ? '' : String(v).trim();
}

/**
 * [IS-BLANK-ROWS] Righe INUTILIZZABILI in una risposta, per due motivi distinti e indipendenti.
 *
 * PERCHE' ESISTE
 * Il 06/08/2026 l'iFlow `PRODUCTIONORDER_QUERYGET` (E-13) ha risposto `200` con 11 righe che
 * portavano i 19 campi chiesti, nell'ordine di dichiarazione dell'EDMX, TUTTI a valore iniziale:
 * `ManufacturingOrder: ""`, `TotalQuantity: "0.0"`, `MfgOrderCreationDate: /Date(-62169984000000)/`
 * (la data ABAP `00000000`). Una risposta strutturalmente valida e semanticamente vuota: peggio di
 * un corpo vuoto, perché è indistinguibile da dati (contratto C-6). Il binding OData V4 del
 * cockpit si è fermato con `Duplicate key predicate: ('')` — 11 entity con la stessa chiave in
 * una collection non sono rappresentabili — e il messaggio non nomina né l'area né l'indirizzo.
 *
 * Le due misure, tenute separate perché hanno cause diverse:
 *   `blank`      righe con TUTTI i campi identità vuoti. È la firma della risposta iniziale. La
 *                condizione è «tutti» e non «almeno uno» di proposito: una riga in cui ogni
 *                identificativo è iniziale è spazzatura per definizione, mentre un singolo campo
 *                vuoto potrebbe essere un dato legittimo — e questo rilevatore non deve produrre
 *                falsi positivi su dati veri.
 *   `duplicates` righe la cui tupla di identità si ripete. È ciò che rompe il binding, anche con
 *                chiavi valorizzate (per esempio un fan-off che rilegge due volte la stessa chiave).
 *
 * Rilevazione, non normalizzazione: come `looksTruncated`, dichiara e non aggiusta. `kept` è
 * l'insieme delle righe utilizzabili, nell'ordine di arrivo e con i valori INTATTI — chi lo usa
 * (i READ handler) si fa carico di dichiarare quante righe ha scartato.
 *
 * I due insiemi di campi possono differire, e nella lista materiali DEVONO: la chiave esposta è
 * `(Product, Plant)`, ma `Plant` arriva dal customizing locale ed è sempre valorizzato, quindi
 * includerlo nel controllo di vuoto renderebbe cieco il controllo. `blankFields` è allora il solo
 * `Product`, mentre le righe ripetute si contano sulla tupla completa — due plant dello stesso
 * materiale sono due righe legittime.
 *
 * @param {Array|object|null} rows righe della risposta (array, oggetto singolo o niente)
 * @param {string[]} fields campi che identificano la riga (`route.identity`, o la chiave esposta)
 * @param {object} [opts]
 * @param {string[]} [opts.blankFields=fields] campi che devono essere vuoti TUTTI perché la riga
 *   sia dichiarata priva di identità: i soli campi che arrivano dalla sorgente
 * @param {boolean} [opts.dedupe=true] `false` dove la ripetizione della tupla è LEGITTIMA e c'è
 *   già una deduplicazione voluta a valle (le versioni interne della testata di ciclo): lì si
 *   rileva il solo vuoto, e `duplicates` resta 0 per non dichiarare un difetto che non c'è
 * @returns {{total:number, blank:number, duplicates:number, kept:Array}}
 */
function identityCheck(rows, fields = [], { blankFields, dedupe = true } = {}) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  if (!Array.isArray(fields) || !fields.length) {
    return { total: list.length, blank: 0, duplicates: 0, kept: list };
  }
  const emptyFields = Array.isArray(blankFields) && blankFields.length ? blankFields : fields;
  const seen = new Set();
  const kept = [];
  let blank = 0;
  let duplicates = 0;
  for (const row of list) {
    if (emptyFields.every(f => identityValue(row, f) === '')) { blank++; continue; }
    if (dedupe) {
      // JSON e non un separatore: due tuple diverse non devono collidere per via del separatore.
      const key = JSON.stringify(fields.map(f => identityValue(row, f)));
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
    }
    kept.push(row);
  }
  return { total: list.length, blank, duplicates, kept };
}

// ================================================================
// Filtro del client
// ================================================================

/** Funzioni di ricerca testuale ammesse in un filtro di ricerca del client. */
const SEARCH_FUNCS = new Set(['contains', 'substringof', 'startswith', 'endswith', 'tolower', 'toupper']);
/** Operatori/token che un filtro riconoscibile può contenere. */
const KNOWN_TOKENS = new Set(['and', 'or', '=', 'like', '(', ')']);

/**
 * Classifica il `$filter` inviato dal client, per decidere se e come applicarlo a valle
 * (FR-13). `fields` è l'insieme dei campi chiave ammessi per una lettura per chiave.
 *
 *   'empty'           nessun filtro
 *   'contains-search' ricerca dell'utente (OR di contains): si applica in memoria
 *   'key-equality'    uguaglianze sui soli campi chiave: si applica in memoria
 *   'unsupported'     tutto il resto: la richiesta va RESPINTA, mai soddisfatta a metà
 */
function classifyClientFilter(where, fields = []) {
  const empty = { kind: 'empty', fields: [], terms: [], equals: {} };
  if (!where || (Array.isArray(where) && where.length === 0)) return empty;

  // 1. uguaglianze in AND sui soli campi chiave -> lettura per chiave
  const terms = splitTopLevelAnd(where);
  if (terms && terms.every(isEqualityTerm)) {
    const names = terms.map(t => lastRef(t[0]));
    if (names.every(n => fields.includes(n))) {
      const equals = {};
      for (const t of terms) equals[lastRef(t[0])] = t[2].val;
      return { kind: 'key-equality', fields: names, terms: [], equals };
    }
  }

  // 2. ricerca testuale
  let hasSearch = false;
  let unsupported = false;
  const refs = new Set();
  const values = new Set();
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'string') {
      const op = node.toLowerCase();
      if (op === 'like') { hasSearch = true; return; }
      if (!KNOWN_TOKENS.has(op)) unsupported = true;
      return;
    }
    if (typeof node !== 'object') return;
    if (node.func) {
      if (SEARCH_FUNCS.has(String(node.func).toLowerCase())) hasSearch = true;
      else unsupported = true;
    }
    if (node.ref && node.ref.length) refs.add(node.ref[node.ref.length - 1]);
    if (typeof node.val === 'string') {
      const t = node.val.replace(/^%+|%+$/g, '').trim();
      if (t) values.add(t);
    }
    if (node.list) unsupported = true;
    if (node.args) walk(node.args);
    if (node.xpr) walk(node.xpr);
  };
  walk(where);

  if (hasSearch && !unsupported && refs.size && values.size) {
    return { kind: 'contains-search', fields: [...refs], terms: [...values], equals: {} };
  }
  return { kind: 'unsupported', fields: [...refs], terms: [...values], equals: {} };
}

/**
 * Predicato di ricerca in memoria: la riga passa se QUALSIASI campo contiene QUALSIASI
 * termine.
 *
 * `caseSensitive` è **true per default**, e non è una svista: sul gateway `substringof` è
 * una sottostringa sensibile alle maiuscole, e il confronto a valle deve RIPRODURRE la
 * semantica della sorgente, non migliorarla (TDD §3.6.4 M3: «stesso risultato di prima»).
 * La variante insensibile già in esercizio sulla lista cicli resta dov'è, sulla lista cicli.
 */
function matchesContains(row, fields, terms, { caseSensitive = true } = {}) {
  if (!row || !Array.isArray(fields) || !Array.isArray(terms)) return false;
  return fields.some(f => {
    const v = row[f];
    if (v === null || v === undefined) return false;
    const s = caseSensitive ? String(v) : String(v).toLowerCase();
    return terms.some(t => {
      const needle = caseSensitive ? String(t) : String(t).toLowerCase();
      return needle !== '' && s.includes(needle);
    });
  });
}

// ================================================================
// [MAT-SCOPE] `needsDetails` NON C'E' PIU', e non è una ripulitura estetica (feature 0050).
//
// Decideva quale delle due vie prendesse l'elenco materiali — veloce (una lettura di
// `A_ProductPlant`, dettagli a blocchi dal client) o lenta (il merge completo) — guardando se il
// client nominava un campo di dettaglio.
//
// Quella scelta non esiste più: dalla 0050 un materiale entra in perimetro solo se una categoria
// gli assegna una tipologia Plex, e quella risposta esiste solo DOPO il join fra la riga
// product-plant e l'anagrafica (`ProductType`/MTART sta su `A_Product`). La via veloce restituiva
// quindi un elenco di CANDIDATI presentato come la lista, e nessun passo successivo poteva
// togliere una riga: `productDetails` riempie celle, non cancella righe.
//
// La funzione è uscita col suo unico chiamante, e `refsOf` con lei: una funzione tenuta in vita
// solo dal proprio test è la trappola che invecchia — il test continua a passare e il prossimo
// lettore crede che qualcuno la usi. Vedi anche l'eccezione rimossa in test/keyReadGuarded.test.js.
// ================================================================

// ================================================================
// $select di A_ProductPlant
// ================================================================

/**
 * [W1-26] Le due informazioni che su Integration Suite NON hanno un campo proprio, e i campi di
 * `A_ProductPlant` su cui l'iFlow `ZMARS_PRODUCT_PLANT_GET` le trasporta:
 *
 *   SOBSL  ProcurementSubType   -> ProductCFOPCategory     (`product_cfop_category`,     String(2))
 *   FEVOR  ProductionSupervisor -> StockDeterminationGroup (`stock_determination_group`, String(4))
 *
 * Vivono entrambe, in SAP, su navigazioni per cui su IS non esiste alcun indirizzo
 * (`A_ProductSupplyPlanning` e `A_ProductWorkScheduling`); il lato SAP ha scelto di farle
 * viaggiare su due campi flat già esposti. Fino a questa modifica erano dichiarate mancanti in
 * `UNAVAILABLE_IN_IS`, e ogni condizione di categoria che le usava restava non valutabile.
 *
 * DUE VINCOLI, ed è tutto ciò che rende accettabile un campo che ne trasporta un altro:
 *
 *   1. vale SOLO in modalità IS. In `ONPREM` `StockDeterminationGroup` è davvero il gruppo di
 *      determinazione stock e `ProductCFOPCategory` è davvero la categoria CFOP: leggerli come
 *      FEVOR/SOBSL classificherebbe i materiali su un dato che non c'entra niente. Chi consuma
 *      questa tabella deve avere il canale in mano — vedi `extractSapFields(pp, mode)`;
 *   2. vale SOLO in LETTURA. Non è la normalizzazione di un valore letto (C-7, DEC-51): è la
 *      forma in cui il canale consegna il dato, cioè un fatto del contratto dell'iFlow, e sta
 *      qui accanto al `$select` perché i due non possano divergere.
 *
 * Vedi DEC-64 e W1-26 in docs/GAP-WAVE1-BBP.md.
 */
const IS_FIELD_ALIASES = Object.freeze({
  ProcurementSubType:   'ProductCFOPCategory',      // SOBSL
  ProductionSupervisor: 'StockDeterminationGroup'   // FEVOR
});

/**
 * I 9 campi di `A_ProductPlant` che i consumatori a valle leggono davvero, in modalità IS
 * (TDD §3.6.4 M1). Unione verificata sul CSN, non una scelta di comodo:
 *   - extractSapFields usa ProcurementType, MRPType, ProfitCenter, PurchasingGroup, ProfileCode;
 *   - il merge della riga di dashboard usa Product e Plant;
 *   - [W1-26] i due campi PORTANTI di IS_FIELD_ALIASES, da cui escono SOBSL e FEVOR.
 *
 * I portanti sono DERIVATI dalla tabella degli alias e non riscritti a mano: un alias aggiunto
 * senza il suo campo nel `$select` non darebbe alcun errore — darebbe `undefined`, cioè una
 * condizione di categoria che non aggancia più e materiali che cambiano perimetro in silenzio.
 *
 * [MAT-SAP-FIELDS] `ProfileCode` (MMSTA, stato materiale specifico per stabilimento) è l'ultimo
 * arrivato, ed è già nel contratto dell'iFlow — specs/0013-collegamento-path-is/04-contracts.md
 * lo elenca fra gli otto campi che E-09/E-10 devono esporre, quindi non serve chiedere nulla al
 * team Integration e NON serve un alias: qui ha un indirizzo proprio.
 *
 * `ProductType` NON è nell'elenco: **non esiste** su A_ProductPlant (48 campi flat, verificato
 * su srv/external/OP_API_PRODUCT_SRV_0001.cds). Chiederlo produrrebbe un errore su un campo
 * inesistente. L'incoerenza pre-esistente che ne deriva è dichiarata nel TDD §10.1 e NON si
 * corregge qui: correggerla cambierebbe il perimetro dei materiali.
 */
const PRODUCT_PLANT_SELECT = Object.freeze([
  'Product', 'Plant', 'ProcurementType', 'MRPType', 'ProfitCenter', 'PurchasingGroup',
  'ProfileCode',
  ...Object.values(IS_FIELD_ALIASES)
]);

/**
 * @param {boolean} needNav il chiamante dichiara di sapere che le due navigazioni servono.
 *   [W1-26] NON cambia più nulla su questo canale, ed è la buona notizia: SOBSL e FEVOR
 *   arrivano ora sui due campi portanti di `IS_FIELD_ALIASES`, che sono SEMPRE nel `$select`.
 *   Il `$select` di IS resta quindi uno solo, deterministico, senza un secondo ramo da tenere
 *   allineato. Il parametro resta nella firma perché i chiamanti lo passano e perché in
 *   `ONPREM` continua a decidere gli `$expand` (vedi `needsNav` in materialVisibility.js).
 */
function productPlantSelect(needNav) { // eslint-disable-line no-unused-vars
  return [...PRODUCT_PLANT_SELECT];
}

// ================================================================
// Diagnostica (log)
// ================================================================

/** Rende leggibili i token di un `where` per la riga di log, senza esporne il volume. */
function describeTokens(tokens) {
  const out = [];
  for (const t of tokens || []) {
    if (typeof t === 'string') { out.push(t); continue; }
    if (t && t.ref) { out.push(lastRef(t)); continue; }
    if (t && typeof t === 'object' && 'val' in t) { out.push(`'${t.val}'`); continue; }
    if (t && Array.isArray(t.list)) { out.push(`(${t.list.length} valori)`); continue; }
    if (t && t.func) { out.push(`${t.func}(…)`); continue; }
    if (t && t.xpr) { out.push(`(${describeTokens(t.xpr)})`); continue; }
    out.push('…');
  }
  return out.join(' ');
}

/** I criteri effettivamente inviati con questa query, per la riga di log M-07. */
function describeWhere(query) {
  const head = fromRefHead(query);
  const parts = [];
  if (head && typeof head === 'object' && Array.isArray(head.where)) {
    parts.push(`chiave(${describeTokens(head.where)})`);
  }
  const where = query && query.SELECT && query.SELECT.where;
  if (Array.isArray(where) && where.length) parts.push(describeTokens(where));
  return (parts.join(' + ') || '(nessuno)').slice(0, 400);
}

module.exports = {
  entityNameOf,
  deriveOp,
  hasExpand,
  topOf,
  routeFor,
  assertPath,
  equalityMap,
  pluckEquality,
  toKeyPredicate,
  splitInList,
  fanOutByKey,
  withoutOne,
  looksTruncated,
  identityCheck,
  classifyClientFilter,
  matchesContains,
  productPlantSelect,
  PRODUCT_PLANT_SELECT,
  IS_FIELD_ALIASES,
  describeWhere,
  // esportate per i test e per le sorgenti: sono pure e già usate qui sopra
  splitTopLevelAnd,
  // [KEY-READ] `joinAnd` e' il DUALE di `splitTopLevelAnd` e va esportato insieme a lei: chi
  // spezza un `where` per guardarci dentro prima o poi lo ricompone, e una seconda copia della
  // ricomposizione e' esattamente la classe di difetto che srv/lib/keyReadRules.js chiude.
  joinAnd,
  inListIndex,
  lastRef
};

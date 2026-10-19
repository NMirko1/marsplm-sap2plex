/**
 * [PLANT-ROWS] [PLANT-PAGE] Le righe `A_ProductPlant` di un plant: lettura paginata, cache,
 * dichiarazione di cio' che manca.
 *
 * PERCHE' E' USCITO DA autoAssign.js (feature 0035). La stessa paginazione era scritta DUE
 * volte — qui e nello STEP 2 di `loadConfiguredProducts` in cat-service.js — e le due copie
 * erano gia' divergenti: questa ordina, mette in cache e dichiara ogni incompletezza, quella
 * no. A parita' di plant e di `withNav` le due letture sono la STESSA query (stesso
 * `productPlantColumns`), quindi a cache fredda la dashboard leggeva due volte da SAP lo stesso
 * perimetro. Ora il lettore e' uno.
 *
 * [PAGED-READ] E DALLA 0040 IL CICLO NON STA PIU' QUI. Sta in srv/lib/pagedRead.js, perche' la
 * lettura per plant di `A_Product` (la query nuova) ha bisogno delle stesse identiche cose:
 * dimezzamento, onde, ordine stabile, guardia dello `$skip`, scadenza, verdetto. Scriverla accanto
 * avrebbe fatto la terza copia. Qui restano l'entity, le colonne, la cache, il verdetto per plant e
 * le DUE PORTE — cioe' tutto cio' che e' specifico di `A_ProductPlant`. Le regole verificabili senza
 * rete stanno in srv/lib/plantRowsPaging.js, con il loro test.
 *
 * PERCHE' NON SI FILTRA PER MATERIALE — e NON e' il key predicate.
 *
 * Una `.where({ Plant, Product: { in: [...] } })` resta una lettura in COLLECTION: la rotta
 * QUERY di A_ProductPlant e' `{ identity: ['Product','Plant'] }`, SENZA `keyPredicate`
 * (srv/lib/productSource.js), `deriveOp` rende 'GET' solo con `SELECT.one` o con un predicate
 * gia' in `from.ref[0]` (srv/lib/isQueryShape.js), e `toKeyPredicate` raccoglie i soli termini
 * `=`: un `in` non lo vede. L'indirizzo scelto e' quindi il _QUERYGET, giusto.
 *
 * Il guasto e' un altro, ed e' peggiore perche' risponde 200: la lista `in` viene spezzata a
 * `chunkSize` 15 (DEC-19), il blocco che il client chiede e' di 25 codici — quindi 15 + 10, due
 * richieste — e l'iFlow ONORA UN SOLO VALORE dell'OR `Product eq ... or Product eq ...`. Da ogni
 * richiesta torna una riga utile: una cella piena ogni 15 e una ogni 10, periodo 25. E' la
 * trappola di DEC-49, gia' dichiarata su A_ProductClass in srv/lib/clfnSource.js, dove la
 * risposta e' stata il fan-out per chiave.
 *
 * Qui il fan-out costerebbe una chiamata per materiale del blocco; il plant intero ne costa UNA
 * (paginata) e si riusa fra i blocchi. Percio': filtro sul SOLO plant (obbligatorio, DEC-49),
 * paginazione, e incrocio coi materiali del blocco IN MEMORIA.
 *
 * Un insieme parziale qui e' indistinguibile da «quel materiale non ha tipologia»: per questo
 * ogni incompletezza — troncamento, duplicati, righe senza Product, paginazione non ordinata,
 * scadenza, `$skip` non onorato — viene DICHIARATA e non lasciata scoprire.
 *
 * DUE PORTE, E NON SONO UNA SOLA:
 *   - `loadPlantRowsIndex` torna la Mappa e LANCIA se la lettura e' fallita. E' il contratto di
 *     sempre, e i suoi due chiamanti storici (l'auto-assegnazione e `productDetails`) hanno gia'
 *     il loro `catch` con un ripiego dichiarato: cambiarlo in silenzio darebbe loro una mappa
 *     mezza vuota che si legge come «quei materiali non esistono».
 *   - `loadPlantRowsOutcome` torna la Mappa CON il suo verdetto e non lancia mai. La usa chi
 *     deve dichiarare l'incompletezza all'utente invece di ripiegare.
 *
 * Perimetro: grep -rn "PLANT-ROWS\|PLANT-PAGE".
 */

'use strict';

const { productPlantColumns } = require('./materialVisibility');
const { readPaged, createPagedCache } = require('./pagedRead');

/**
 * Stesso TTL della value help delle classi (PART_TYPE_VH_TTL_MS): sono entrambe letture di
 * anagrafica che cambiano di rado, e allinearli evita due politiche per lo stesso problema.
 */
const PLANT_ROWS_TTL_MS = Number(process.env.PLANT_ROWS_TTL_MS || 5 * 60 * 1000);

const plantRowsCache = createPagedCache({ ttlMs: PLANT_ROWS_TTL_MS });

/**
 * L'esito dell'ULTIMA lettura di ogni plant: `plant -> { at, complete, readOk, text, … }`.
 *
 * Serve a `productScope`, che e' cio' che il cockpit interroga per dichiarare sopra la tabella
 * un perimetro incompleto. Non sta ne' nella cache delle righe — un esito incompleto la' non
 * resta, di proposito — ne' sul servizio, dove sarebbe uno stato condiviso fra utenti che
 * guardano plant diversi: il verdetto e' una proprieta' della LETTURA DI QUEL PLANT, e come
 * tale si conserva. Non ha TTL: dice cos'e' successo l'ultima volta, con il suo timestamp.
 */
const lastVerdict = new Map();      // plant -> verdetto dell'ultima lettura

function plantRowsKey(plant, opts) {
  const cols = opts.columns ? opts.columns.join(',') : (opts.withNav ? 'nav' : 'std');
  const extra = opts.filter ? JSON.stringify(opts.filter) : '';
  return `${plant}|${cols}|${extra}`;
}

/**
 * Le colonne della lettura, nelle tre forme di sempre: quelle chieste dal chiamante, il `$select`
 * esplicito del canale IS (o l'`$expand` di ONPREM quando servono le navigazioni), oppure niente —
 * cioe' la select-all che ONPREM usa quando le navigazioni non servono.
 */
function columnsFor(s4, opts) {
  if (opts.columns) return opts.columns;
  if (s4.mode === 'IS' || opts.withNav) return productPlantColumns(!!opts.withNav, s4.mode);
  return null;
}

/**
 * Il perimetro di un plant, pagina dopo pagina.
 *
 * @returns {Promise<{byProduct: Map, readOk: boolean, complete: boolean, reasons: string[],
 *                    text: string, rows: number, pages: number, ms: number, pageSize: number,
 *                    shrinks: number, error: string}>}
 *   NON lancia: un guasto e' un esito, e chi legge decide se ripiegare o dichiarare.
 */
async function readPlantRows(s4, plant, opts = {}) {
  const out = await readPaged(s4, {
    entity: 'A_ProductPlant',
    columns: columnsFor(s4, opts),
    where: { Plant: plant, ...(opts.filter || {}) },
    keyField: 'Product',
    orderBy: 'Product',
    tag: '[PLANT-ROWS]',
    label: `plant ${plant}`,
    unit: 'materiali',
    missingNote: 'I materiali mancanti escono SENZA tipologia: non e\' assenza di dato.',
    deadlineMs: opts.deadlineMs
  });

  const verdict = {
    plant,
    at: Date.now(),
    readOk: out.readOk,
    complete: out.complete,
    reasons: out.reasons,
    text: out.text,
    rows: out.rows,
    materials: out.keys,
    pages: out.pages,
    pageSize: out.pageSize,
    shrinks: out.shrinks,
    dup: out.dup,
    blank: out.blank,
    ms: out.ms,
    error: out.error
  };
  lastVerdict.set(plant, verdict);
  return { byProduct: out.byKey, ...verdict };
}

/**
 * L'esito completo, con SINGLE-FLIGHT e con la regola «un esito incompleto non resta in cache»:
 * entrambe stanno in `createPagedCache` (srv/lib/pagedRead.js), perche' valgono identiche per la
 * lettura per plant di `A_Product`.
 */
function loadPlantRowsOutcome(s4, plant, opts = {}) {
  return plantRowsCache.get(plantRowsKey(plant, opts), () => readPlantRows(s4, plant, opts));
}

/**
 * L'indice del plant. Contratto di sempre: una `Map` materiale -> riga, e un'eccezione se la
 * lettura non e' riuscita.
 */
async function loadPlantRowsIndex(s4, plant, opts = {}) {
  const out = await loadPlantRowsOutcome(s4, plant, opts);
  if (!out.readOk) throw new Error(`[PLANT-ROWS] plant ${plant}: ${out.text}${out.error ? ` — ${out.error}` : ''}`);
  return out.byProduct;
}

/**
 * Butta via quello che sappiamo di un plant (tutte le combinazioni di colonne).
 * La usa il tasto «Aggiorna» della dashboard: con una cache da cinque minuti, senza questo
 * quel tasto smetterebbe di aggiornare senza dirlo.
 */
function invalidatePlantRows(plant) {
  return plantRowsCache.invalidate(plant);
}

/**
 * Com'e' andata l'ultima lettura di questo plant, o `null` se non e' mai stato letto in questo
 * processo. «Mai letto» e «letto e completo» non sono la stessa cosa, e chi dichiara deve poterle
 * distinguere: per questo si torna `null` e non un verdetto ottimista.
 */
function lastPlantReadVerdict(plant) {
  return lastVerdict.get(plant) || null;
}

module.exports = {
  readPlantRows,
  loadPlantRowsIndex,
  loadPlantRowsOutcome,
  invalidatePlantRows,
  lastPlantReadVerdict,
  plantRowsKey,
  PLANT_ROWS_TTL_MS
};

/**
 * [PRODUCT-ROWS] L'anagrafica `A_Product` di un plant, in una lettura sola (feature 0040).
 *
 * PERCHE' ESISTE. Fino alla 0039 `A_Product` aveva sul canale IS il solo indirizzo per chiave: una
 * lista di materiali diventava N letture, piu' altre N su `A_ProductDescription` per la descrizione
 * — 4600 chiamate per un plant da 2300 materiali, ed e' la ragione per cui la dashboard ha una via
 * veloce, i blocchi da 100 e una cache dei dettagli. La riga 34 di `EndpointFlussiMARS_V1` ha
 * pubblicato il `_QUERYGET`, che prende il PLANT come criterio (`SO_PLANT`) e porta la descrizione
 * DENTRO la riga: il perimetro anagrafico di un plant costa ora una lettura paginata, come
 * `A_ProductPlant` dalla 0035.
 *
 * E' IL GEMELLO DI plantRows.js, e le due letture insieme sono il perimetro di un plant:
 *   - `A_ProductPlant` porta i campi con cui si decide CHI entra (BESKZ, MRP, profit center, MMSTA,
 *     SOBSL/FEVOR) — non stanno su `A_Product` e non ci saranno mai;
 *   - `A_Product` porta l'anagrafica di mandante (MTART, MEINS, descrizione, `LastChangeDate`).
 * Il ciclo di paginazione e la cache sono gli stessi oggetti, in srv/lib/pagedRead.js.
 *
 * UN PLANT PER CHIAMATA, e non e' una scelta di prudenza: `SO_PLANT` e' un select-option con una
 * riga sola nella forma concordata (srv/external/PRODUCT_QUERY_IS.md §3), e piu' plant nello stesso
 * `$filter` non sono esprimibili. Con piu' plant si fanno piu' letture, in parallelo.
 *
 * LA GUARDIA DEL PLANT. La riga porta il `Plant` con cui e' stata chiesta: se torna un plant
 * DIVERSO, `SO_PLANT` non e' stato applicato — e allora quello che si ha in mano non e' il perimetro
 * di un plant ma l'anagrafica dell'intero mandante, creduta un plant. Non da' nessun errore: da' un
 * insieme piu' grande. E' la lezione di DEC-49 e DEC-83, ed e' il motivo per cui `Plant` sta nel
 * `$select` pur non servendo a nessun consumatore.
 *
 * NESSUN RIPIEGO SULLE LETTURE PER CHIAVE. Se questa lettura non riesce, il perimetro esce
 * INCOMPLETO e DICHIARATO, esattamente come fa `plantRows.js`: tornare alle 2N letture per chiave
 * significherebbe far pagare a un guasto il tempo peggiore proprio nel momento peggiore, e
 * nascondere che l'indirizzo nuovo non funziona. Chi legge decide cosa farne.
 *
 * Perimetro: grep -rn "PRODUCT-ROWS\|PRODUCT-QUERY".
 */

'use strict';

const { readPaged, createPagedCache } = require('./pagedRead');

/** Stesso TTL di PLANT_ROWS_TTL_MS: le due letture di un plant scadono insieme. */
const PRODUCT_ROWS_TTL_MS = Number(process.env.PLANT_ROWS_TTL_MS || 5 * 60 * 1000);

const productRowsCache = createPagedCache({ ttlMs: PRODUCT_ROWS_TTL_MS });

/** L'esito dell'ULTIMA lettura di ogni plant. Vedi `lastVerdict` in plantRows.js: stesse ragioni. */
const lastVerdict = new Map();

const trim = (v) => String(v == null ? '' : v).trim();

function productRowsKey(plant, opts) {
  return `${plant}|${(opts.columns || []).join(',')}`;
}

/**
 * L'anagrafica dei materiali di un plant, pagina dopo pagina.
 *
 * @param {object}   src       la sorgente della QUERY (base ZMARS_PRODUCT_SRV, srv/lib/productSource.js)
 * @param {string}   plant
 * @param {object}   opts
 * @param {string[]} opts.columns    `$select` — lo passa il chiamante, perche' l'elenco dei campi
 *                                   che i consumatori leggono vive accanto alle rotte
 * @param {number}   [opts.deadlineMs] 0 nei job: la scadenza di 90 s esiste per l'approuter
 * @returns {Promise<object>} `{ byProduct, readOk, complete, reasons, text, … }`. NON lancia.
 */
async function readProductRows(src, plant, opts = {}) {
  let checked = 0;   // righe su cui la guardia ha potuto pronunciarsi
  const out = await readPaged(src, {
    entity: 'A_Product',
    columns: opts.columns,
    where: { Plant: plant },
    keyField: 'Product',
    orderBy: 'Product',
    tag: '[PRODUCT-ROWS]',
    label: `plant ${plant}`,
    unit: 'materiali',
    missingNote: 'I materiali mancanti escono SENZA anagrafica e SENZA descrizione: '
      + 'non e\' assenza di dato.',
    deadlineMs: opts.deadlineMs,
    // [PRODUCT-ROWS] Una riga di un ALTRO plant dimostra che `SO_PLANT` non e' stato applicato.
    // Non si tiene e si dichiara. Se il campo torna vuoto la guardia TACE: non poter verificare
    // non e' la stessa cosa che aver verificato, e scartare tutto renderebbe questa lettura
    // dipendente da un campo che l'iFlow potrebbe non valorizzare.
    guard: (row) => {
      const got = trim(row.Plant);
      if (!got) return null;
      checked++;
      return got === trim(plant)
        ? null
        : `la sorgente ignora il criterio sul plant: chiesto ${plant}, ricevute righe di ${got}`;
    }
  });

  if (out.rows && !checked && !out.offScope) {
    console.warn(`>>> [PRODUCT-ROWS] plant ${plant}: nessuna riga porta il Plant, quindi non e' `
      + 'verificabile che SO_PLANT sia stato applicato. Le righe si usano lo stesso; se un giorno '
      + 'questo perimetro sembrasse quello di un altro plant, e\' qui che manca la prova.');
  }

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
    offScope: out.offScope,
    ms: out.ms,
    error: out.error
  };
  lastVerdict.set(plant, verdict);
  return { byProduct: out.byKey, ...verdict };
}

/** L'esito completo, con single-flight e senza cache degli esiti incompleti. Non lancia. */
function loadProductRowsOutcome(src, plant, opts = {}) {
  return productRowsCache.get(productRowsKey(plant, opts), () => readProductRows(src, plant, opts));
}

/** L'indice del plant: `Map` materiale -> riga, e un'eccezione se la lettura non e' riuscita. */
async function loadProductRowsIndex(src, plant, opts = {}) {
  const out = await loadProductRowsOutcome(src, plant, opts);
  if (!out.readOk) throw new Error(`[PRODUCT-ROWS] plant ${plant}: ${out.text}${out.error ? ` — ${out.error}` : ''}`);
  return out.byProduct;
}

/** «Aggiorna» deve aggiornare: la dashboard butta via anche questa lettura, non solo l'altra. */
function invalidateProductRows(plant) {
  return productRowsCache.invalidate(plant);
}

/** Com'e' andata l'ultima lettura di questo plant, o `null` se non e' mai stato letto. */
function lastProductReadVerdict(plant) {
  return lastVerdict.get(plant) || null;
}

module.exports = {
  readProductRows,
  loadProductRowsOutcome,
  loadProductRowsIndex,
  invalidateProductRows,
  lastProductReadVerdict,
  productRowsKey,
  PRODUCT_ROWS_TTL_MS
};

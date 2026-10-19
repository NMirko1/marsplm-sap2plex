'use strict';

// ================================================================
// [DETAILS-PREFETCH] Cache di processo dei DETTAGLI MATERIALE (A_Product + descrizione).
//
// PERCHE'. In modalita' IS `A_Product` non ha rotta di collection (srv/lib/productSource.js,
// ROUTES): ogni materiale costa DUE letture per chiave — il materiale e la sua descrizione. La
// dashboard chiede quei dettagli a blocchi, e dalla feature del precaricamento li chiede per
// l'INTERO perimetro, non per le sole righe a schermo. Senza cache quel costo si ripeterebbe a
// ogni apertura, a ogni refresh, a ogni cambio plant e per ogni utente.
//
// SINGLE-FLIGHT PER MATERIALE, non per blocco: si mette in cache la PROMESSA, non il risultato.
// E' lo stesso schema di `plantRowsCache` in srv/cat-service.js, e qui serve ancora di piu':
// mentre il precaricamento macina i blocchi di coda, l'utente puo' scorrere e far partire il
// riempimento di righe che stanno in un blocco gia' in volo. Senza la promessa in cache quei
// materiali verrebbero letti due volte.
//
// UN ESITO FALLITO NON RESTA IN CACHE, e il criterio e' volutamente grossolano: se il caricamento
// dichiara anche un solo fallimento, NIENTE di quel blocco viene messo in cache. Il motivo e' che
// `fetchProductsByKey` dichiara il fallimento per LETTURA, non per materiale (`key` vale
// 'A_Product' o 'A_ProductDescription(IT)'): non c'e' modo di sapere quali materiali del blocco
// siano stati colpiti. Con una lettura descrizioni fallita e una lettura materiali riuscita, le
// righe tornano con `ProductDescription: ''`, che e' identica alla descrizione di un materiale che
// davvero non ce l'ha in quella lingua — metterla in cache significherebbe tenere una degradazione
// per l'intero TTL senza poterla distinguere da un dato buono.
//
// Il modulo non dipende ne' da `cds` ne' dalla rete: la lettura arriva iniettata (`load`) e il
// tempo pure (`now`). E' cio' che lo rende collaudabile — test/productDetailCache.test.js.
// ================================================================

/** TTL predefinito: 5 minuti, lo stesso di PLANT_ROWS_TTL_MS e di PART_TYPE_VH_TTL_MS. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * @param {object}   [opts]
 * @param {number}   [opts.ttlMs=300000]  durata di una voce in cache
 * @param {function} [opts.now=Date.now]  orologio iniettabile (i test non aspettano 5 minuti)
 */
function createProductDetailCache({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const entries = new Map();   // `${lingua}|${materiale}` -> { at, promise }

  const keyOf = (language, product) => `${language}|${product}`;

  /**
   * I dettagli di un elenco di materiali, presi dalla cache dove ci sono e letti dove mancano.
   *
   * @param {string[]} products  materiali (i doppioni si perdono, come in fetchProductsByKey)
   * @param {object}   opts
   * @param {string}   [opts.language='EN']
   * @param {function} opts.load  (materialiMancanti) => Promise<{byProduct: Map, failed: Array}>
   *                              invocata UNA volta sola, con i soli materiali non in cache;
   *                              non viene invocata affatto se non manca niente.
   * @returns {Promise<{byProduct: Map<string,object>, failed: Array<{key:string,message:string}>}>}
   *          la stessa forma di fetchProductsByKey, cosi' il chiamante non cambia.
   */
  async function fetch(products, { language = 'EN', load } = {}) {
    const asked = [...new Set((products || []).filter(Boolean).map(String))];
    const byProduct = new Map();
    const failed = [];
    if (!asked.length) return { byProduct, failed };

    const t = now();
    const pending = [];   // [materiale, promessa] — hit e miss insieme, nell'ordine chiesto
    const missing = [];
    const settle = new Map();   // materiale -> { resolve, reject } della sua promessa

    for (const product of asked) {
      const key = keyOf(language, product);
      const hit = entries.get(key);
      if (hit && (t - hit.at) < ttlMs) { pending.push([product, hit.promise]); continue; }
      if (hit) entries.delete(key);   // scaduta
      missing.push(product);
      // La promessa si registra PRIMA di leggere: e' questo a rendere il single-flight tale.
      const promise = new Promise((resolve, reject) => settle.set(product, { resolve, reject }));
      // Il ciclo in fondo le aspetta una per volta: senza questo aggancio, una promessa respinta
      // prima del proprio turno diventerebbe una unhandled rejection.
      promise.catch(() => { /* dichiarato dal chiamante, non qui */ });
      entries.set(key, { at: t, promise });
      pending.push([product, promise]);
    }

    const missingSet = new Set(missing);
    if (missing.length) {
      let result = null;
      let loadError = null;
      try {
        result = await load(missing);
      } catch (e) {
        loadError = e;
      }
      const read = (result && result.byProduct) || new Map();
      const readFailed = (result && result.failed) || [];
      // Nessuna cache su un caricamento che ha dichiarato qualcosa: vedi la testata.
      const keep = !loadError && readFailed.length === 0;
      const why = loadError
        ? (loadError.message || String(loadError))
        : readFailed.map(f => `${f.key}: ${f.message}`).join(' | ');
      for (const product of missing) {
        if (!keep) entries.delete(keyOf(language, product));
        const row = read.get(product);
        // Riga letta: si consegna comunque, anche se il blocco ha dichiarato un fallimento (e'
        // quello che fa oggi il chiamante diretto). Riga assente E fallimento dichiarato: non e'
        // un'assenza, e' un'ignoranza — si RESPINGE, cosi' anche una chiamata sovrapposta che sta
        // aspettando questa stessa promessa lo sa, invece di leggerla come «materiale inesistente».
        if (row === undefined && !keep) settle.get(product).reject(new Error(why || 'lettura dettagli non riuscita'));
        else settle.get(product).resolve(row);
      }
      if (loadError) failed.push({ key: 'productDetailCache', message: why });
      else failed.push(...readFailed);
    }

    for (const [product, promise] of pending) {
      let row;
      try {
        row = await promise;
      } catch (e) {
        // I materiali di QUESTO blocco sono gia' dichiarati dalle righe di `failed` qui sopra:
        // si dichiara solo chi stava sulla lettura di un'altra chiamata, che altrimenti sparirebbe.
        if (!missingSet.has(product)) failed.push({ key: product, message: e.message });
        continue;
      }
      if (row !== undefined) byProduct.set(product, row);
    }
    return { byProduct, failed };
  }

  /** Svuota la cache. Serve ai test e a un eventuale aggancio di invalidazione. */
  function invalidate() { entries.clear(); }

  /** Quante voci sono in cache adesso (comprese quelle scadute non ancora toccate). */
  function size() { return entries.size; }

  return { fetch, invalidate, size };
}

module.exports = createProductDetailCache;
module.exports.DEFAULT_TTL_MS = DEFAULT_TTL_MS;

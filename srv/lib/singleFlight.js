'use strict';

/**
 * [ROUTING-HEADER-FLIGHT] Una cache a TTL che mette in volo UNA SOLA lettura per chiave.
 *
 * PERCHE' ESISTE. Una cache scritta cosi' —
 *
 *     const hit = cache.get(k);
 *     if (hit && fresca(hit)) return hit.value;
 *     const value = await leggi(k);      // <-- la Map e' ancora vuota, qui
 *     cache.set(k, { at: now(), value });
 *
 * — protegge dalle richieste SUCCESSIVE e non da quelle SIMULTANEE: fra il miss e la `set` la voce
 * non esiste, quindi N chiamate concorrenti sulla stessa chiave fanno tutte miss e partono tutte.
 * Sembra una cache che funziona, perche' il secondo giro e' veloce; il primo costa N volte.
 *
 * Misurato il 14/09/2026 su `cf logs`: aprendo il dettaglio di un ciclo il browser lancia sei
 * richieste insieme, ognuna passa dal gate di perimetro, e per `07NPE079/01` sono uscite SEI letture
 * identiche di `ProductionRoutingHeader` in 244 ms — ~950 ms l'una verso lo stesso iFlow. La cache
 * c'era dal primo giorno.
 *
 * LA CORREZIONE E' UNA RIGA SPOSTATA: si mette in cache la PROMESSA, prima di attenderla. E' lo
 * stesso stampo di `srv/lib/productDetailCache.js` («si mette in cache la promessa, non il
 * risultato»), qui ridotto al meccanismo nudo perche' serviva anche altrove.
 *
 * DUE REGOLE CHE NON SI TOCCANO:
 *
 *   1. UN ESITO FALLITO NON RESTA IN CACHE. Sul rigetto la voce si toglie, o un guasto di rete di un
 *      istante resterebbe appiccicato alla chiave per tutto il TTL — e chi legge quella cache per
 *      distinguere «non esiste» da «non l'ho potuto sapere» riceverebbe la seconda risposta anche
 *      quando la prima e' tornata a essere vera. Stessa regola di `productDetailCache`.
 *   2. IL RIGETTO SI AGGANCIA SUBITO (`promise.catch`), o una promessa in cache che nessun chiamante
 *      ha ancora atteso diventa un `unhandledRejection` e su Node abbatte il processo. L'aggancio
 *      NON consuma l'errore: chi ha chiesto la chiave riceve il rigetto come prima.
 *
 * Nessuna dipendenza da `cds` ne' dalla rete: `now` e il `load` sono iniettati, quindi si collauda
 * (`node test/singleFlight.test.js`). Perimetro: grep -rn "ROUTING-HEADER-FLIGHT"
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] quanto vale una voce risolta. `0` = nessuna scadenza.
 * @param {function} [opts.now] orologio iniettabile, per il test
 * @returns {{get: function, invalidate: function, clear: function, size: function}}
 */
function createSingleFlightCache(opts) {
  const o = opts || {};
  const ttlMs = Number.isFinite(Number(o.ttlMs)) ? Number(o.ttlMs) : 0;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const entries = new Map(); // chiave -> { at, promise }

  /**
   * La voce della chiave: quella in volo o in cache se c'e', altrimenti una nuova da `load`.
   * @param {string} key
   * @param {function(): Promise<*>} load eseguita SOLO sul miss
   */
  function get(key, load) {
    const hit = entries.get(key);
    // `ttlMs === 0` vuol dire «non scade»: il confronto si salta del tutto, invece di affidarsi a
    // un `< 0` che sarebbe falso per un istante e vero per un altro.
    if (hit && (ttlMs === 0 || (now() - hit.at) < ttlMs)) return hit.promise;
    if (hit) entries.delete(key);

    let promise;
    try {
      promise = Promise.resolve(load());
    } catch (e) {
      // Un `load` che lancia SINCRONO non deve entrare in cache ne' cambiare forma: il chiamante
      // riceve un rigetto come per qualunque altro guasto.
      return Promise.reject(e);
    }

    entries.set(key, { at: now(), promise });
    promise.catch(() => {
      // Solo la voce che questa chiamata ha messo: se nel frattempo la chiave e' stata invalidata e
      // rimessa in volo da un'altra, quella e' piu' recente e non si tocca.
      const cur = entries.get(key);
      if (cur && cur.promise === promise) entries.delete(key);
    });
    return promise;
  }

  function invalidate(key) { return entries.delete(key); }
  function clear() { entries.clear(); }
  function size() { return entries.size; }

  return { get, invalidate, clear, size };
}

module.exports = createSingleFlightCache;
module.exports.createSingleFlightCache = createSingleFlightCache;

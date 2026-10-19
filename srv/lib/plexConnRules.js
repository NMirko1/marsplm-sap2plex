/**
 * Regole PURE della connessione a Plex (feature 0020).
 *
 * Nessuna dipendenza da `cds`, dal database o dalla rete: è la parte della feature che si può
 * verificare senza avere davanti né Plex né un tenant, e ha il suo test in
 * test/plexConnRules.test.js. L'orchestrazione che le usa sta accanto, in
 * srv/lib/plexConnection.js e negli handler di srv/cat-service.js.
 *
 * Perché esiste: questa feature parla SOLO con sistemi esterni, e senza un modulo così l'unico
 * modo di collaudare «cosa consideriamo un indirizzo valido» sarebbe salvare una riga e guardare
 * il fallimento della chiamata. È la stessa ragione di splitRules.js, isQueryShape.js e
 * plexJobSortRules.js.
 */

'use strict';

/**
 * Forma ammessa per un host Plex: schema `https://`, un host, NESSUN path.
 *
 * Il vincolo sul path non è pignoleria: i due indirizzi vengono CONCATENATI con i path delle API
 * (`${baseUrl}/mdm/v1/parts`, `${dataSourceUrl}/api/datasources/…/execute`). Una barra finale o
 * un pezzo di path già incollato produce un indirizzo doppio, che non fallisce al salvataggio ma
 * alla prima chiamata, come un 404 di Plex — cioè lontano dalla causa.
 *
 * `http://` è escluso: le due API viaggiano su TLS e degradare lo schema significherebbe mandare
 * in chiaro una API key e una password.
 */
const RX_PLEX_HOST = /^https:\/\/[^/]+$/;

/** @param {string} url @returns {boolean} */
function isPlexHost(url) {
  return RX_PLEX_HOST.test(String(url === null || url === undefined ? '' : url).trim());
}

/** Campi che compongono una connessione, nell'ordine in cui la schermata li presenta. */
const FIELDS = ['BaseUrl', 'ConsumerKey', 'DataSourceUrl', 'DataSourceUser', 'DataSourcePassword'];

/**
 * Verifica una connessione e restituisce TUTTI i difetti, non solo il primo: chi compila cinque
 * campi deve poterli correggere in un giro solo.
 *
 * Ogni difetto porta il nome del campo e una chiave i18n STABILE, non un testo: il chiamante
 * localizza (handler CAP) o mostra (schermata). Stessa scelta del `messageCode` della 0012.
 *
 * @param {object} data valori da verificare
 * @param {{partial?: boolean}} [opts] `partial: true` verifica SOLO i campi presenti nell'oggetto
 *   — è la forma di una UPDATE, dove il payload porta i soli campi toccati. Con `partial: false`
 *   (default, forma della CREATE) un campo assente è un campo mancante.
 * @returns {Array<{field: string, code: string}>} elenco vuoto = connessione valida
 */
function validateConnection(data, opts = {}) {
  const d = data || {};
  const partial = !!opts.partial;
  const errors = [];
  const present = (f) => !partial || d[f] !== undefined;
  const text = (v) => String(v === null || v === undefined ? '' : v).trim();

  if (present('BaseUrl') && !isPlexHost(d.BaseUrl)) {
    errors.push({ field: 'BaseUrl', code: 'plexConnBaseUrlInvalid' });
  }
  if (present('ConsumerKey') && !text(d.ConsumerKey)) {
    errors.push({ field: 'ConsumerKey', code: 'plexConnConsumerKeyMandatory' });
  }
  if (present('DataSourceUrl') && !isPlexHost(d.DataSourceUrl)) {
    errors.push({ field: 'DataSourceUrl', code: 'plexConnDsUrlInvalid' });
  }
  if (present('DataSourceUser') && !text(d.DataSourceUser)) {
    errors.push({ field: 'DataSourceUser', code: 'plexConnDsUserMandatory' });
  }
  // DataSourcePassword NON è obbligatoria: una password vuota è un valore legittimo per un
  // web-service account, ed è l'unico dei cinque campi che lo schema non impone.
  return errors;
}

/**
 * Normalizza i valori da persistere: via gli spazi ai bordi dei quattro campi di indirizzo e
 * identità. La password NON si tocca — uno spazio in una password è un carattere, non un refuso.
 *
 * @param {object} data
 * @returns {object} solo le chiavi presenti in `data`, così è utilizzabile anche su una UPDATE
 */
function normalizeConnection(data) {
  const d = data || {};
  const out = {};
  for (const f of FIELDS) {
    if (d[f] === undefined) continue;
    out[f] = f === 'DataSourcePassword'
      ? String(d[f] === null ? '' : d[f])
      : String(d[f] === null ? '' : d[f]).trim();
  }
  return out;
}

module.exports = { isPlexHost, validateConnection, normalizeConnection, FIELDS, RX_PLEX_HOST };

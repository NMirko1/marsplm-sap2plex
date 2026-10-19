/**
 * [CONF-POSTING] Lettore della configurazione dei consumi e degli scarti, per plant (feature 0028).
 *
 * COSA FA
 * Legge una riga di `ZProdConfPostingConfig` e la consegna normalizzata dalle regole pure di
 * srv/lib/confPostingRules.js. E' l'unico punto che tocca il db per questa tabella: il job e
 * `confMatDoc` ricevono un oggetto e non sanno che esiste una tabella.
 *
 * RIGA ASSENTE => DEFAULT, e il default e' il comportamento di PRIMA della 0028. Su lettura
 * FALLITA si va nello stesso stato, e la ragione e' l'opposto di quella di `bomExplode`: la' un
 * motore acceso su parametri non letti esploderebbe una distinta con dati inventati, qui il default
 * e' esattamente cio' che il codice faceva ieri. Ma la causa NON si perde: `readError` viaggia
 * nell'oggetto e il job la dichiara nel recap, perche' un plant configurato che si comporta come
 * non configurato non deve essere indistinguibile da un plant non configurato.
 *
 * PERCHE' UNA CACHE. `resolveConfPostingConfig` viene chiamata una volta per plant per run dal job,
 * quindi la cache non serve a lui: serve al server web, dove la scheda «Consuntivazione» e le
 * letture del cockpit passano dallo stesso modulo. Il TTL e' la rete di sicurezza,
 * l'invalidazione esplicita dagli handler after(['CREATE','UPDATE','DELETE']) e' il meccanismo —
 * stessa forma di `bomExplode.resolveExplodeConfig`.
 *
 * PERIMETRO: grep -rn "CONF-POSTING".
 */

'use strict';

const R = require('./confPostingRules');

/** Nome dell'entity di customizing, in forma pienamente qualificata (come bomExplode.js:44). */
const E_CONFIG = 'avvaleplm.marsplm.sap2plex.ZProdConfPostingConfig';

/** TTL della cache. L'invalidazione esplicita e' il meccanismo, il TTL la rete di sicurezza. */
const CONFIG_TTL_MS = Number(process.env.CONF_POSTING_CONFIG_TTL_MS || 60000);

const configCache = new Map(); // plant -> { at, value }

/**
 * Configurazione dei consumi e degli scarti di un plant.
 *
 * @param {object} db connessione CDS al db
 * @param {string} plant
 * @param {{ force?: boolean }} [opts] `force` ignora la cache (test e diagnostica)
 * @returns {Promise<object>} nella forma di `confPostingRules.normalizeConfig`, piu':
 *   - `plant`      il plant richiesto, normalizzato;
 *   - `configured` `true` se una riga esiste E dice qualcosa di diverso dai default. E' quello che
 *                  il recap dichiara: «plant non configurato» deve valere anche per una riga
 *                  salvata e lasciata tutta ai default, altrimenti si prometterebbe un
 *                  comportamento che non c'e';
 *   - `readError`  il messaggio, se la lettura e' fallita.
 */
async function resolveConfPostingConfig(db, plant, opts = {}) {
  const key = String(plant === null || plant === undefined ? '' : plant).trim();
  if (!key) return { ...R.normalizeConfig(null), plant: key, configured: false };

  const hit = configCache.get(key);
  if (!opts.force && hit && (Date.now() - hit.at) < CONFIG_TTL_MS) return hit.value;

  let value;
  try {
    const row = await db.run(SELECT.one.from(E_CONFIG).where({ Plant: key }));
    value = { ...R.normalizeConfig(row), plant: key, configured: !!row && !R.isDefault(row) };
  } catch (e) {
    console.error(`>>> [CONF-POSTING] lettura configurazione del plant ${key} fallita: ${e.message}`);
    value = { ...R.normalizeConfig(null), plant: key, configured: false, readError: e.message };
  }
  configCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Svuota la cache. Chiamata dall'handler after(['CREATE','UPDATE','DELETE']) su
 * ZProdConfPostingConfig e dalla cascata di deletePlant.
 * @param {string} [plant] se assente svuota tutto
 */
function invalidateConfPostingConfigCache(plant) {
  const key = plant === null || plant === undefined ? '' : String(plant).trim();
  if (key) {
    configCache.delete(key);
    console.log(`>>> [CONF-POSTING] cache di configurazione invalidata per il plant ${key}`);
  } else {
    configCache.clear();
    console.log('>>> [CONF-POSTING] cache di configurazione invalidata (tutti i plant)');
  }
}

module.exports = {
  E_CONFIG,
  CONFIG_TTL_MS,
  resolveConfPostingConfig,
  invalidateConfPostingConfigCache
};

/**
 * Connessione a Plex di un plant — PUNTO UNICO di risoluzione (feature 0020).
 *
 * È il choke-point che rende vera la frase «la connessione si legge solamente dal customizing»:
 * ogni chiamata verso Plex, dagli handler CAP e dai job batch, passa di qui. Prima di questa
 * feature la stessa risoluzione viveva in DUE funzioni gemelle e divergenti — `loadPlexCredentials`
 * in srv/cat-service.js (cache a slot singolo, TTL 5 min) e `resolvePlexCredentials` in
 * srv/jobs/lib/plexJobsClient.js (nessuna cache) — che leggevano entrambe l'unica riga globale
 * `IsDefault && IsActive` di ZPlexCredentials.
 *
 * NIENTE FALLBACK. La riga di ZPlexConnConfig è l'unica fonte: sono spariti i tre `process.env
 * .PLEX_DS_*` e il tenant di TEST che era cablato nel sorgente. Quella catena rendeva «credenziali
 * assenti» di fatto irraggiungibile, e il modo realistico di sbagliare diventava puntare al tenant
 * sbagliato IN SILENZIO — al punto che plexJobsClient.js aveva dovuto aggiungere un
 * `declareDataSourceOrigin()` solo per rendere visibile nel log su quale host si stesse scrivendo.
 * Con una fonte sola quel presidio non serve più: se manca la configurazione la chiamata non parte.
 *
 * FAIL-CLOSED e DICHIARATO (DEC-52): plant non configurato ⇒ `PlexConnectionMissing`, che nomina il
 * plant. L'errore porta un `code` i18n STABILE invece di un testo, perché questo modulo è
 * condiviso fra handler HTTP (che localizzano con getLocalizedMessage) e job batch (che scrivono
 * sul recap): la traduzione è responsabilità del chiamante, che sa in quale delle due situazioni si
 * trova. È la stessa scelta del `messageCode` della feature 0012.
 *
 * CACHE CHIAVATA SUL PLANT, mai a slot singolo. La cache di `loadPlexCredentials` controllava la
 * validità PRIMA di discriminare su quale configurazione fosse stata chiesta: trasportato al
 * per-plant, quel difetto diventa «il plant B scrive sul tenant del plant A», cioè esattamente il
 * fallimento che la feature deve impedire. Struttura e invalidazione sono quelle già in esercizio
 * per `resolveSortConfig` in srv/lib/plexJobSort.js.
 */

const cds = require('@sap/cds');

const E_CONN = 'avvaleplm.marsplm.sap2plex.ZPlexConnConfig';

/** TTL della cache. L'invalidazione esplicita è il meccanismo, il TTL è la rete di sicurezza. */
const CONN_TTL_MS = Number(process.env.PLEX_CONN_TTL_MS || 60000);

// Cache module-scoped: condivisa da tutte le istanze di servizio del processo. Chiave = plant.
const connCache = new Map();   // plant -> { at: <ms>, value: <connessione> }

/**
 * Plant senza connessione configurata. Non è un errore tecnico: è lo stato «questo plant non è
 * ancora stato messo in servizio», e va detto nominando il plant.
 */
class PlexConnectionMissing extends Error {
  constructor(plant) {
    super(`Nessuna connessione Plex configurata per il plant ${plant || '(non indicato)'}.`);
    this.name = 'PlexConnectionMissing';
    /** Chiave i18n stabile: il chiamante la localizza (vedi il commento in testa al file). */
    this.code = 'plexConnNotConfigured';
    this.plant = plant || '';
  }
}

/** Plant non indicato dal chiamante: è un difetto di programmazione, non un dato mancante. */
class PlexConnectionPlantMissing extends Error {
  constructor() {
    super('Risoluzione della connessione Plex richiesta senza plant.');
    this.name = 'PlexConnectionPlantMissing';
    this.code = 'plexConnPlantMandatory';
    this.plant = '';
  }
}

/**
 * Connessione Plex di un plant.
 *
 * @param {string} plant codice plant (obbligatorio: non esiste più una connessione «di default»)
 * @param {{ db?: object, force?: boolean }} [opts]
 *   `db` connessione CDS già aperta (i job la passano; gli handler la lasciano risolvere qui);
 *   `force: true` ignora la cache — lo usa il test di connessione, che deve provare ciò che
 *   l'utente ha appena salvato e non ciò che era in cache.
 * @returns {Promise<{plant: string, baseUrl: string, consumerKey: string,
 *                    dataSourceUrl: string, dataSourceUser: string, dataSourcePassword: string}>}
 * @throws {PlexConnectionPlantMissing} plant non indicato
 * @throws {PlexConnectionMissing} plant senza riga di configurazione
 *
 * I nomi dei campi restituiti sono quelli che i wrapper di srv/jobs/lib/plexJobsClient.js già
 * consumano (`baseUrl`, `consumerKey`, `dataSource*`): il vecchio `plexUrl` di cat-service.js
 * spariva a metà strada e obbligava ogni chiamante a ricordarsi quale delle due forme avesse in
 * mano.
 */
async function resolvePlexConnection(plant, opts = {}) {
  const key = String(plant === null || plant === undefined ? '' : plant).trim();
  if (!key) throw new PlexConnectionPlantMissing();

  const hit = connCache.get(key);
  if (!opts.force && hit && (Date.now() - hit.at) < CONN_TTL_MS) return hit.value;

  const db = opts.db || await cds.connect.to('db');
  // Una lettura FALLITA non viene messa in cache e non viene mascherata da «non configurato»: le
  // due situazioni si riparano in modi diversi (configurare un plant vs guardare il database), e
  // confonderle manderebbe l'utente a riscrivere una riga che c'è già.
  const row = await db.run(SELECT.one.from(E_CONN).where({ Plant: key }));
  if (!row) throw new PlexConnectionMissing(key);

  const value = {
    plant: key,
    baseUrl: row.BaseUrl,
    consumerKey: row.ConsumerKey,
    dataSourceUrl: row.DataSourceUrl,
    dataSourceUser: row.DataSourceUser,
    dataSourcePassword: row.DataSourcePassword || ''
  };
  connCache.set(key, { at: Date.now(), value });
  // L'host su cui si sta per scrivere è la cosa che conta vedere nel log, e va appaiato al plant:
  // è l'unico modo di accorgersi a colpo d'occhio di due plant puntati sullo stesso tenant.
  console.log(`>>> [PLEX CONN] plant ${key}: connect ${value.baseUrl}, data source ${value.dataSourceUrl}`);
  return value;
}

/**
 * Svuota la cache. La chiamano gli handler after(['CREATE','UPDATE','DELETE']) su ZPlexConnConfig
 * e la cascata di deletePlant.
 * @param {string} [plant] se assente svuota tutto (cascata e test)
 */
function invalidatePlexConnection(plant) {
  const key = plant === null || plant === undefined ? '' : String(plant);
  if (key) {
    connCache.delete(key);
    console.log(`>>> [PLEX CONN] cache invalidata per il plant ${key}`);
  } else {
    connCache.clear();
    console.log('>>> [PLEX CONN] cache invalidata (tutti i plant)');
  }
}

/**
 * `true` se il plant ha una connessione configurata, senza sollevare eccezioni.
 * Serve a chi deve DECIDERE prima di agire — la lista che dichiara «plant non configurato», il job
 * che salta un plant e prosegue con gli altri — e non a chi sta per chiamare Plex: lì la
 * risoluzione va fatta e l'errore va lasciato passare.
 * @param {string} plant
 * @param {{ db?: object }} [opts]
 * @returns {Promise<boolean>}
 */
async function hasPlexConnection(plant, opts = {}) {
  try {
    await resolvePlexConnection(plant, opts);
    return true;
  } catch (e) {
    if (e instanceof PlexConnectionMissing || e instanceof PlexConnectionPlantMissing) return false;
    throw e;
  }
}

module.exports = {
  resolvePlexConnection,
  invalidatePlexConnection,
  hasPlexConnection,
  PlexConnectionMissing,
  PlexConnectionPlantMissing
};

/**
 * Plex client helper per i job schedulati (standalone, senza contesto HTTP `req`).
 *
 * Raccoglie in un unico modulo:
 *   - i wrapper fetch per la Connect REST API (header X-Plex-Connect-Api-Key);
 *   - il wrapper per la Data Source API (host *.on.plex.com, Basic auth).
 *
 * La RISOLUZIONE della connessione non sta più qui: dalla feature 0020 è per plant e vive nel
 * punto unico srv/lib/plexConnection.js, che ha sostituito questa gemella e la sua omologa
 * `loadPlexCredentials` di srv/cat-service.js. Qui restano solo i wrapper di trasporto, che
 * ricevono le credenziali già risolte dal chiamante — il quale è l'unico a sapere di quale plant
 * si stia trattando.
 */

const { getUsablePlants } = require('../../license');

/**
 * Estrae host/utente/password Data Source dalla connessione già risolta, rifiutando l'incompleto.
 *
 * Sostituisce la catena `riga -> env PLEX_DS_* -> tenant di test cablato` che stava qui prima
 * (0020). Quella catena non lasciava mai la chiamata senza credenziali, e il prezzo era che una
 * configurazione mancante non si manifestava come errore ma come scrittura sul tenant sbagliato.
 * Ora l'assenza è un errore, e nomina il plant.
 *
 * @param {{plant?: string, dataSourceUrl?: string, dataSourceUser?: string, dataSourcePassword?: string}} creds
 * @returns {{base: string, user: string, pass: string}}
 */
function requireDataSourceCreds(creds) {
  const c = creds || {};
  const base = c.dataSourceUrl;
  const user = c.dataSourceUser;
  if (!base || !user) {
    const who = c.plant ? `del plant ${c.plant}` : 'richiesta';
    throw new Error(`Connessione Data Source Plex ${who} incompleta: host e utente sono obbligatori.`);
  }
  // La password vuota resta ammessa: è un valore legittimo per un web-service account, ed è
  // l'unico dei tre campi che lo schema non impone.
  return { base, user, pass: c.dataSourcePassword || '' };
}

/**
 * Esegue una chiamata alla Connect REST API di Plex.
 * @param {{baseUrl: string, consumerKey: string}} creds
 * @param {string} method - GET/POST/PUT
 * @param {string} path - path relativo, es. '/scheduling/v1/jobs' (o assoluto se inizia con http)
 * @param {object} [body] - payload JSON per POST/PUT
 * @param {{timeoutMs?: number}} [opts] - timeout esplicito via AbortController.
 *   DEFAULT INVARIATO = nessun timeout, quindi i job si comportano esattamente come prima.
 *   Lo usa lo spacchettamento (feature 0012, TD-6): senza timeout un endpoint che accetta la
 *   connessione e non risponde appenderebbe la richiesta HTTP dell'utente per sempre e
 *   renderebbe l'«esito non conclusivo» di FR-42 un evento non limitato nel tempo, cioè
 *   inosservabile. Stessa motivazione del timeout esplicito del mailer (DEC-15).
 * @returns {Promise<{ok: boolean, status: number, body: any, url: string}>}
 */
async function plexConnect(creds, method, path, body, opts = {}) {
  const url = path.startsWith('http') ? path : `${creds.baseUrl}${path}`;
  const headers = {
    'Accept': 'application/json',
    'X-Plex-Connect-Api-Key': creds.consumerKey
  };
  const options = { method, headers };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const timeoutMs = Number(opts && opts.timeoutMs) || 0;
  let timer = null;
  if (timeoutMs > 0) {
    const controller = new AbortController();
    options.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  console.log(`>>> [PLEX] ${method} ${url}${timeoutMs > 0 ? ` (timeout ${timeoutMs} ms)` : ''}`);
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = text; }

    if (!response.ok) {
      console.error(`>>> [PLEX] ${method} ${url} -> HTTP ${response.status}: ${text}`);
    }
    return { ok: response.ok, status: response.status, body: parsed, url };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Risolve i plant USABILI (ZPlant Status='Active' AND licenza valida) dal customizing.
 * Solo gli ordini di questi plant vengono elaborati dal job (CP3): un plant scaduto viene
 * saltato, gli altri procedono. Il verdetto licenza usa la cache di srv/license.js.
 * @param {object} db - connessione CDS al db (cds.connect.to('db'))
 * @returns {Promise<Set<string>>}
 */
async function resolveActivePlants(db) {
  const rows = await db.run(
    SELECT.from('avvaleplm.marsplm.sap2plex.ZPlant').columns('PlantCode').where({ Status: 'Active' })
  );
  const active = rows.map((r) => r.PlantCode);
  const usable = await getUsablePlants(active);
  console.log(`>>> [JOB] Usable (active+licensed) plants: ${[...usable].join(', ') || '(none)'}`);
  return usable;
}

// L'ultimo argomento `opts` è opzionale e si propaga a plexConnect: se assente il
// comportamento è quello di sempre (nessun timeout).
const plexGet = (creds, path, opts) => plexConnect(creds, 'GET', path, undefined, opts);
const plexPost = (creds, path, body, opts) => plexConnect(creds, 'POST', path, body, opts);
const plexPut = (creds, path, body, opts) => plexConnect(creds, 'PUT', path, body, opts);

/**
 * Esegue una Plex Data Source (host tenant *.on.plex.com, Basic auth).
 * Host/utente/password presi da creds, cioè dalla connessione del plant già risolta da
 * srv/lib/plexConnection.js. Replica executePlexDataSource di cat-service.js.
 * @param {{dataSourceUrl: string, dataSourceUser: string, dataSourcePassword: string}} creds
 * @param {number|string} dataSourceId - es. 4216, 4701, 20051, 10603, 4858 (dallo sheet Jobs Creation)
 * @param {object} inputs - parametri di input della Data Source
 * @returns {Promise<{ok: boolean, status: number, body: any, url: string}>}
 */
async function executeDataSource(creds, dataSourceId, inputs) {
  // Host/utente/password arrivano dalla connessione del plant, già risolta: nessun fallback su env
  // né su un tenant di default (0020). Se sono vuoti è perché il chiamante ha risolto male, e va
  // detto qui invece di finire su un host altrui.
  const { base, user, pass } = requireDataSourceCreds(creds);
  const url = `${base}/api/datasources/${dataSourceId}/execute?format=2`;
  const basicAuth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': basicAuth
  };
  // Data Source execute (format=2) expects the input parameters at the TOP LEVEL of the
  // body (e.g. { "Job_No": "..." }), NOT wrapped in an { inputs: {...} } object.
  const requestBody = inputs || {};
  console.log(`>>> [PLEX DS] POST ${url}`, JSON.stringify(requestBody));

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  console.log(`>>> [PLEX DS] Response status ${response.status}`);
  return { ok: response.ok, status: response.status, body, url };
}

/**
 * Esegue una Plex Data Source secondo il contratto documentato dal FORNITORE per il servizio di
 * ordinamento (feature 0014): parametri ANNIDATI in `inputs`, nessun `?format=2`, esito
 * atteso in `outputs`.
 *
 * PERCHE' UNA FUNZIONE NUOVA E NON UN PARAMETRO DI executeDataSource: le 5 Data Source in
 * esercizio (4216, 4701, 20051, 10603, 4858) usano la forma PIATTA con `?format=2`, verificata
 * sul tenant (DEC-25). Le due forme non sono equivalenti e una delle due viene ignorata dal
 * servizio: unificarle sembra una pulizia ed e' una regressione su un flusso in produzione. La
 * duplicazione e' quindi CONSAPEVOLE e circoscritta a questo file (TD-3).
 *
 * A differenza di plexConnect NON PROPAGA le eccezioni: le restituisce come
 * `{ ok:false, status:0, thrown }`, perche' il chiamante deve poter distinguere un timeout da
 * un errore di rete da un 500, e un throw glielo impedirebbe (matrice §6, righe H/J).
 *
 * @param {{ dataSourceUrl: string, dataSourceUser: string, dataSourcePassword: string }} creds
 * @param {number|string} dataSourceId es. 239905
 * @param {object} inputs parametri applicativi (gia' costruiti da buildSortInputs)
 * @param {{ timeoutMs?: number, bodyShape?: 'nested'|'flat' }} [opts]
 *   `timeoutMs` > 0 arma un AbortController, come plexConnect;
 *   0 o assente = nessun tetto, che e' il comportamento di tutte le chiamate del batch.
 * @returns {Promise<{ ok: boolean, status: number, body: any, url: string,
 *                     aborted: boolean, thrown: Error|null }>}
 */
async function executeDataSourceOutputs(creds, dataSourceId, inputs, opts = {}) {
  const c = creds || {};
  // STESSA risoluzione di executeDataSource: la connessione del plant e nient'altro. Nessuna
  // seconda politica (DEC-25).
  const { base, user, pass } = requireDataSourceCreds(c);
  // NIENTE ?format=2: quel parametro cambia la forma della RISPOSTA (array `rows` al primo
  // livello) e questo servizio dichiara l'esito in `outputs`.
  const url = `${base}/api/datasources/${dataSourceId}/execute`;
  const basicAuth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': basicAuth
  };
  const requestBody = (opts && opts.bodyShape === 'flat')
    ? { ...(inputs || {}) }        // forma delle 5 DS in esercizio (leva PLEX_JOB_SORT_BODY_SHAPE)
    : { inputs: { ...(inputs || {}) } };  // forma del contratto Rockwell (default)

  const timeoutMs = Number(opts && opts.timeoutMs) || 0;
  const options = { method: 'POST', headers, body: JSON.stringify(requestBody) };
  let controller = null;
  let timer = null;
  if (timeoutMs > 0) {
    controller = new AbortController();
    options.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  console.log(`>>> [PLEX DS] POST ${url}${timeoutMs > 0 ? ` (timeout ${timeoutMs} ms)` : ''}`, JSON.stringify(requestBody));
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    console.log(`>>> [PLEX DS] Response status ${response.status}`);
    return { ok: response.ok, status: response.status, body, url, aborted: false, thrown: null };
  } catch (err) {
    // Un abort e' un timeout, tutto il resto e' un errore di rete: la distinzione la fa il
    // chiamante (interpretSortResponse), qui si conserva solo il fatto.
    const aborted = !!(controller && controller.signal && controller.signal.aborted);
    console.error(`>>> [PLEX DS] POST ${url} -> ${aborted ? `nessuna risposta entro ${timeoutMs} ms` : `errore: ${err.message}`}`);
    return { ok: false, status: 0, body: null, url, aborted, thrown: err };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  resolveActivePlants,
  plexConnect,
  plexGet,
  plexPost,
  plexPut,
  executeDataSource,
  executeDataSourceOutputs
};

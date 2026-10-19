// [PLEX-OP-TYPE] Il catalogo delle operazioni del tenant Plex: un punto solo che legge
// `GET /mdm/v1/operations` (feature 0024).
//
// PERCHE' ESISTE. Il `type` della part-operation e' obbligatorio nel contratto Plex e viene risolto
// PER NOME contro una tabella di setup del tenant — «Produzione», «Ricevere», «Rework» su Albacina,
// dove `'Production'` non esiste. Fino alla 0024 quel nome lo decidevamo NOI in due posti: una riga
// FIXED di `ZPlexOpFieldMap` per il ciclo e un campo a testo libero di `ZMatRecvOpConfig` per il
// ricevimento. Ma il tipo di un'operazione **e' un dato del catalogo Plex**
// (`OperationDTO.type`, srv/external/PLEX_OPERATION_API_CONTRACT.md): dichiararlo una seconda volta
// da questa parte significa poter dire una cosa diversa da quella vera, e un tipo sbagliato non da'
// un dato sbagliato — da' `400 FIELD_REFERENCE_NOT_FOUND`, cioe' l'operazione non nasce.
//
// PERCHE' UNA LETTURA E NON UNA COLONNA. Salvarsi il tipo accanto all'id sembrava piu' economico ed
// e' la strada fragile: una copia andrebbe portata a mano attraverso ogni percorso che copia una
// riga di ciclo (seed dell'ordine, import, applicazione di un template, spacchettamento: gli stessi
// punti che oggi copiano `OperationType`), e il primo dimenticato darebbe un tipo VUOTO, cioe' il
// ripiego, cioe' il difetto invisibile di prima. L'`id` invece c'e' sempre, perche' e' identita'.
// E' la regola che il progetto ha gia' scelto tre volte: un fatto che vive in Plex si legge da Plex
// (DEC-70, DEC-77, DEC-80).
//
// ATTENZIONE a non confondere questo `type` con `OperationType` delle tabelle di ciclo: quello e'
// `OperationControlProfile` (STEUS) di SAP e alimenta il motore di mapping
// (srv/lib/plexOpFieldMapper.js). Sono due campi con due significati e nomi quasi identici.
//
// NON LANCIA MAI. Una lettura fallita non e' un motivo per fermare un invio: si torna
// `ok: false` con una mappa vuota, e chi chiama ripiega sul comportamento storico DICHIARANDOLO
// (DEC-53). Vale anche il contrario: `ok: true` con una mappa che non contiene un id significa che
// quell'operazione non e' nel catalogo, e non e' la stessa cosa di «non ho potuto leggere».

'use strict';

// La regola dell'UUID case-insensitive vive in un punto solo: i due lati del confronto vengono da
// due chiamate Plex diverse, e `F9EEC9B7…` E' `f9eec9b7…` (DEC-63). Non e' una violazione di DEC-51:
// la' la differenza fra due chiavi SAP e' semantica, qui e' solo grafia esadecimale.
const { normalizeUuid } = require('./recvOpRules');
const { sortPlexOperations } = require('./plexOpSort');
// [JOB-OP-ALIGN] L'indice per CODICE. Sta nel modulo puro insieme alla regola che lo consuma, e non
// qui, perche' la chiave del codice e la decisione sono la stessa domanda: se divergessero, il passo
// 6.3 spegnerebbe un'operazione che l'indice diceva di conoscere.
const { buildCodeIndex } = require('./jobOpAlignRules');

/** TTL della cache del catalogo. Gemello di CONFIG_TTL_MS in srv/lib/recvOpStep.js. */
const CATALOG_TTL_MS = Number(process.env.PLEX_OP_CATALOG_TTL_MS || 60000);

// Cache module-scoped per plant, come configCache del passo di ricevimento.
const catalogCache = new Map();   // plant -> { at, value: { ok, byId, byCode, ambiguousCodes, count } }

/**
 * Le operazioni di una risposta Plex, nelle tre forme che il progetto incontra: array nudo,
 * `{ value: [...] }`, `{ results: [...] }`. Gemello di `extractPartOperations`.
 * @param {*} data
 * @returns {Array<object>}
 */
function extractOperations(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.value)) return data.value;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

/**
 * Una riga del catalogo nella forma che il progetto usa.
 *
 * `name` e `description` NON esistono nel `OperationDTO`
 * (srv/external/PLEX_OPERATION_API_CONTRACT.md): restano qui a `''` perche' la chiave
 * d'ordinamento e' `name || code` di proposito (srv/lib/plexOpSort.js) e la tendina della
 * configurazione plant compone l'etichetta come `code - name`. Nessuna schermata li mostra piu' in
 * una colonna propria.
 */
function mapOperation(op) {
  const o = op && typeof op === 'object' ? op : {};
  return {
    id: o.id || o.Id || '',
    code: o.code || o.number || o.Code || '',
    name: o.name || '',
    description: o.description || '',
    // Il campo su cui filtrano le tendine e da cui viene il `type` della part-operation.
    type: o.type !== undefined && o.type !== null ? String(o.type)
      : (o.Type !== undefined && o.Type !== null ? String(o.Type) : '')
  };
}

/**
 * Legge il catalogo operazioni del tenant. SENZA cache: e' la lettura che serve a una schermata,
 * dove «fresco» e' il comportamento di sempre.
 *
 * @param {{baseUrl: string, consumerKey: string}} conn connessione Plex del plant (feature 0020)
 * @returns {Promise<{ok: boolean, status: number, operations: Array<object>, error: string|null}>}
 *   `operations` e' gia' ORDINATO (PLEX-OP-SORT): l'ordinamento sta in un punto solo, e questo e'
 *   il punto per cui era stato scritto.
 */
async function fetchOperations({ baseUrl, consumerKey } = {}) {
  const url = `${baseUrl}/mdm/v1/operations`;
  const headers = {
    'Accept': 'application/json',
    'X-Plex-Connect-Api-Key': consumerKey
  };

  try {
    console.log('>>> Calling Plex Operations API:', url);
    const resp = await fetch(url, { method: 'GET', headers });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, status: resp.status, operations: [], error: `HTTP ${resp.status}: ${text}` };
    }

    const data = await resp.json();
    const rows = extractOperations(data);
    // Il conteggio si stampa DOPO lo scarto dell'involucro: contarlo sul grezzo scriveva
    // `received 0 operations` su una risposta incapsulata, cioe' il solo strumento per verificare
    // «sono arrivate tutte» mentiva proprio nel caso dubbio. Il contratto di
    // `GET /mdm/v1/operations` non dichiara paginazione (parametri: id, code, type,
    // inventoryType), quindi questo numero e' l'elenco intero del tenant.
    console.log(`>>> Plex Operations: received ${rows.length} operations`);
    if (rows.length > 0) {
      // Le chiavi grezze della prima riga: e' cosi' che si scopre in un colpo una grafia di campo
      // diversa da quella attesa, ed e' quello che fa gia' il passo 4 di syncRoutingPlexCycle.
      console.log(`>>> Plex Operations: chiavi prima riga ${JSON.stringify(Object.keys(rows[0]))}`);
    }

    // [PLEX-OP-SORT] Si ordina DOPO il map, non prima: e' il map a normalizzare
    // `code: op.code || op.number`, e ordinare sul grezzo darebbe una chiave diversa da quella che
    // l'utente vede.
    return { ok: true, status: resp.status, operations: sortPlexOperations(rows.map(mapOperation)), error: null };
  } catch (e) {
    return { ok: false, status: 0, operations: [], error: e.message };
  }
}

/**
 * Il catalogo operazioni del tenant in forma interrogabile, con cache per plant e TTL.
 *
 * E' la lettura dei percorsi di INVIO (sincronizzazione del ciclo, passo di ricevimento del job
 * materiali, allineamento delle operazioni del job), dove la stessa domanda si ripete per ogni
 * operazione e per ogni materiale: una chiamata per plant, non una per operazione.
 *
 * DUE INDICI, UNA LETTURA, UNA VOCE DI CACHE. `byId` risponde «che tipo ha questa operazione»
 * (feature 0024) e `byCode` risponde «che id ha questo codice» ([JOB-OP-ALIGN], il passo 6.3, che
 * dal lato job ha SOLO il codice — la Data Source 4701 e il `JobOperationDTO` non portano l'UUID di
 * catalogo). Una seconda funzione con la sua cache significherebbe due chiamate allo stesso
 * indirizzo e due TTL che scadono in momenti diversi, cioe' due verita' sullo stesso tenant.
 *
 * Si chiamava `loadOperationTypes` fino al 27/08/2026: il nome diceva meno di quel che la funzione
 * fa, e un nome che dice meno e' il primo passo verso una seconda lettura scritta accanto.
 *
 * @param {{baseUrl: string, consumerKey: string}} conn
 * @param {string} plant chiave della cache: due plant sono due tenant (feature 0020)
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, byId: Map<string,string>, byCode: Map<string,string>,
 *                    ambiguousCodes: Set<string>, count: number, error: string|null}>}
 *   `byId` ha le chiavi UUID normalizzate: si interroga con `typeOf(catalog, id)`, non a mano.
 *   `byCode` ha le chiavi da `opCodeKey`, e un codice AMBIGUO non ci sta: sta in `ambiguousCodes`.
 */
async function loadOperationCatalog(conn, plant, opts = {}) {
  const key = String(plant === null || plant === undefined ? '' : plant);
  const hit = catalogCache.get(key);
  if (!opts.force && hit && (Date.now() - hit.at) < CATALOG_TTL_MS) return hit.value;

  const read = await fetchOperations(conn || {});
  const byId = new Map();
  for (const op of read.operations) {
    const id = normalizeUuid(op.id);
    if (!id) continue;
    // Una riga senza `type` NON entra: la mappa risponde `''` da sola per una chiave assente, e
    // memorizzare la stringa vuota renderebbe «non ha tipo» indistinguibile da «non c'e'».
    if (op.type) byId.set(id, op.type);
  }
  const { byCode, ambiguousCodes } = buildCodeIndex(read.operations);

  const value = {
    ok: read.ok, byId, byCode, ambiguousCodes, count: read.operations.length, error: read.error
  };
  if (!read.ok) {
    console.warn(`>>> [PLEX-OP-TYPE] catalogo operazioni del plant ${key || '(assente)'} non letto: ${read.error}`);
  } else {
    console.log(`>>> [PLEX-OP-TYPE] catalogo operazioni del plant ${key || '(assente)'}: `
      + `${byId.size}/${read.operations.length} operazioni con un tipo dichiarato, `
      + `${byCode.size} codici indicizzati`
      + (ambiguousCodes.size ? `, ${ambiguousCodes.size} codici AMBIGUI (rifiutati)` : ''));
  }
  // La riga si scrive anche su lettura FALLITA: senza, un tenant irraggiungibile farebbe ripartire
  // una chiamata per ogni materiale del run. Il TTL e' corto e la prossima finestra riprova.
  catalogCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Il tipo dichiarato da Plex per un'operazione, o `''`.
 *
 * `''` copre DUE casi che chi chiama deve poter distinguere e che questa funzione non distingue:
 * catalogo illeggibile e operazione senza tipo. La distinzione la fa `catalog.ok`, ed e' la
 * ragione per cui `resolveOpType` riceve il valore e non la mappa.
 *
 * @param {{byId: Map<string,string>}} catalog
 * @param {*} operationId
 * @returns {string}
 */
function typeOf(catalog, operationId) {
  const id = normalizeUuid(operationId);
  if (!id || !catalog || !(catalog.byId instanceof Map)) return '';
  return catalog.byId.get(id) || '';
}

/**
 * Svuota la cache. Non c'e' un handler che la chiami — il catalogo lo cambia Plex, non noi — ma
 * serve ai test e a un eventuale comando di servizio.
 * @param {string} [plant] se assente svuota tutto
 */
function invalidateOperationCatalogCache(plant) {
  const key = plant === null || plant === undefined ? '' : String(plant);
  if (key) catalogCache.delete(key);
  else catalogCache.clear();
}

module.exports = {
  CATALOG_TTL_MS,
  extractOperations,
  mapOperation,
  fetchOperations,
  loadOperationCatalog,
  typeOf,
  invalidateOperationCatalogCache
};

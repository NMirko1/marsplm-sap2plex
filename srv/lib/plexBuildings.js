/**
 * [JOB-BUILDING] Il building del tenant Plex: da `buildingCode` a `buildingId`.
 *
 * PERCHE' ESISTE
 * Nacque il 19/08/2026 da un sospetto: il `PUT` del lotto principale (P1 dello spacchettamento)
 * rispondeva `500 REQUEST_PROCESSING_ERROR` / «Data is Null…» su un job che aveva `buildingId: null`
 * e `buildingCode: ""`, mentre la GET per id sullo stesso job rispondeva 200. Il sospetto era
 * ragionevole e SBAGLIATO: il difetto era di Plex, e Rockwell l'ha corretto il 27/08/2026 (dossier in
 * srv/external/PLEX_ISSUE_*_500.it.md, entrambi chiusi e verificati sul tenant).
 *
 * IL MODULO RESTA, e per una ragione che non dipende da quel caso. Il corpo che mandavamo era
 * conforme al contratto ma NON era il modello intero: mancava l'unico campo dello schema che il
 * sample della documentazione mostra valorizzato. Un `PUT` e' il modello intero (DEC-77), quindi cio'
 * che non si manda si AZZERA — un building non rimandato sparisce dal job. E questo tenant i building
 * li usa davvero: altre part portano `buildingCode: "Albacina"`. Va risolto e mandato, in
 * aggiornamento e in creazione, cosi' un job non nasce senza.
 *
 * DUE VOCABOLARI, COME SEMPRE SU PLEX. Il job vuole `buildingId` (UUID); la part dichiara il suo
 * building per `buildingCode`, che e' un NOME della tabella di setup del tenant. E' la stessa forma
 * di DEC-65 (tipologia/stato della part) e DEC-76 (tipo dell'operazione): il codice si traduce, non
 * si indovina. La traduzione la fa la Buildings API — `GET /mdm/v1/buildings`, che restituisce
 * `id`, `buildingCode`, `name`, `active`.
 *
 * LE REGOLE
 *   - solo i building ATTIVI sono candidati: mandare un building disattivato e' peggio che non
 *     mandarlo, perche' l'errore si vedrebbe in fabbrica e non qui;
 *   - con un `buildingCode` si cerca quello, e il confronto e' STRETTO (a meno degli spazi): i due
 *     lati vengono entrambi da Plex, quindi un disallineamento e' un dato sbagliato, non una
 *     tolleranza da concedere (DEC-51);
 *   - senza codice, se il tenant ha UN SOLO building attivo quello e' il building: non c'e' niente
 *     da scegliere;
 *   - senza codice e con piu' building attivi si RIFIUTA: `ambiguous`. Scegliere il primo
 *     dell'elenco significherebbe schedulare la produzione nel posto sbagliato, e nessuna delle
 *     alternative e' piu' probabile dell'altra (stessa regola di DEC-70 sulle chiavi ambigue).
 *
 * La cache e' PER TENANT e per processo: la connessione Plex e' per plant (0020), quindi una cache
 * globale servirebbe i building di un altro cliente. Sono dati di setup, non di esercizio: leggerli
 * una volta per processo e per tenant e' corretto.
 *
 * Nessuna dipendenza da `cds`: le regole si collaudano con `node test/plexBuildings.test.js`.
 * Perimetro: grep -rn "JOB-BUILDING".
 */

'use strict';

/** Ripiego d'ambiente, ultimo della catena. Era l'unica sorgente, e non era valorizzato. */
const ENV_BUILDING_ID = process.env.PLEX_BUILDING_ID || null;

const PATH = '/mdm/v1/buildings';

/** Cache per tenant: chiave = base URL della connessione del plant. */
const cache = new Map();

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

/** Le righe di una risposta Connect: lista, oggetto solo, involucro `data`. PURA. */
function asArray(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && typeof body === 'object') return [body];
  return [];
}

/**
 * I soli building utilizzabili: con un id e ATTIVI. `active` assente si considera attivo — il
 * campo e' opzionale nel contratto, e assumere «disattivato» escluderebbe tutto su un tenant che
 * non lo popola. PURA.
 */
function activeBuildings(rows) {
  return asArray(rows).filter((b) => b && str(b.id) && b.active !== false);
}

/**
 * Il building da usare. FUNZIONE PURA: nessuna rete, nessun `cds`.
 *
 * @param {Array<object>} rows righe della Buildings API
 * @param {{code?: string}} [o] `code` = `buildingCode` dichiarato dalla part
 * @returns {{id: string|null, code: string, name: string, reason: string, count: number}}
 *   `reason`: 'code' | 'single' | 'none' | 'unknownCode' | 'ambiguous'
 */
function pickBuilding(rows, { code } = {}) {
  const list = activeBuildings(rows);
  const wanted = str(code);
  const none = { id: null, code: '', name: '', count: list.length };

  if (!list.length) return { ...none, reason: 'none' };

  if (wanted) {
    const hit = list.find((b) => str(b.buildingCode) === wanted);
    if (hit) {
      return { id: str(hit.id), code: str(hit.buildingCode), name: str(hit.name), reason: 'code', count: list.length };
    }
    // Il codice della part non esiste fra i building attivi: e' un dato da correggere su Plex, non
    // un caso da risolvere prendendo un altro building.
    return { ...none, reason: 'unknownCode' };
  }

  if (list.length === 1) {
    const only = list[0];
    return { id: str(only.id), code: str(only.buildingCode), name: str(only.name), reason: 'single', count: 1 };
  }

  return { ...none, reason: 'ambiguous' };
}

/** Testo per la riga di log / di passo: dice sempre COME si e' deciso. PURA. */
function declare(pick, source) {
  if (pick.id) {
    return `building ${pick.code || pick.id}${pick.name ? ` (${pick.name})` : ''} da ${source}`;
  }
  const perche = {
    none: 'il tenant non ha building attivi',
    unknownCode: 'il codice della part non e\' fra i building attivi del tenant',
    ambiguous: `il tenant ha ${pick.count} building attivi e nessun codice per scegliere`
  }[pick.reason] || pick.reason;
  return `building NON risolto: ${perche}`;
}

/**
 * Legge i building del tenant, una volta per processo e per tenant.
 * Non lancia mai: un errore di lettura restituisce lista vuota e viene dichiarato dal chiamante.
 *
 * @param {{get: Function}} plex tripla Plex (tracciata)
 * @param {string} tenantKey base URL del tenant (`creds.baseUrl`)
 */
async function readBuildings(plex, tenantKey) {
  const key = str(tenantKey) || '(default)';
  if (cache.has(key)) return cache.get(key);
  let rows = [];
  try {
    const r = await plex.get(PATH);
    if (r && r.ok) {
      rows = asArray(r.body);
    } else {
      console.warn(`>>> [JOB-BUILDING] ${PATH} non leggibile (HTTP ${(r && r.status) || 0}): `
        + 'il building non verra\' mandato');
    }
  } catch (e) {
    console.warn(`>>> [JOB-BUILDING] ${PATH} senza risposta (${e.message}): il building non verra' mandato`);
  }
  cache.set(key, rows);
  console.log(`>>> [JOB-BUILDING] tenant ${key}: ${activeBuildings(rows).length} building attivi su ${rows.length}`
    + `${rows.length ? ` — ${activeBuildings(rows).map((b) => str(b.buildingCode) || str(b.id)).slice(0, 10).join(', ')}` : ''}`);
  return rows;
}

/**
 * L'id del building da mandare, con la catena di ripiego dichiarata:
 *   1. quello che il job padre ha GIA' su Plex (chi scrive non cambia cio' che non deve cambiare)
 *   2. il `buildingCode` della part, tradotto dalla Buildings API
 *   3. l'unico building attivo del tenant
 *   4. `PLEX_BUILDING_ID`
 * Nessuno risponde => `null`, e il campo non si manda: meglio un `PUT` senza building di un `PUT`
 * col building di un altro stabilimento.
 *
 * @returns {Promise<{id: string|null, source: string, note: string}>}
 */
async function resolveBuildingId(plex, { parentBuildingId, partBuildingCode, tenantKey } = {}) {
  const fromParent = str(parentBuildingId);
  if (fromParent) {
    return { id: fromParent, source: 'padre', note: `building ${fromParent} dal lotto padre` };
  }

  const rows = await readBuildings(plex, tenantKey);
  const byCode = pickBuilding(rows, { code: partBuildingCode });
  if (byCode.id) {
    const source = byCode.reason === 'code' ? 'buildingCode della part' : 'unico building attivo del tenant';
    return { id: byCode.id, source, note: declare(byCode, source) };
  }

  if (ENV_BUILDING_ID) {
    return {
      id: ENV_BUILDING_ID,
      source: 'PLEX_BUILDING_ID',
      note: `building ${ENV_BUILDING_ID} da PLEX_BUILDING_ID (${declare(byCode, '')})`
    };
  }

  return { id: null, source: '', note: declare(byCode, '') };
}

/** Solo per i test: azzera la cache per tenant. */
function _resetCache() {
  cache.clear();
}

module.exports = {
  resolveBuildingId,
  readBuildings,
  pickBuilding,
  activeBuildings,
  declare,
  asArray,
  PATH,
  ENV_BUILDING_ID,
  _resetCache
};

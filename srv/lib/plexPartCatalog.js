/**
 * [PART-ALIVE] Quali part esistono DAVVERO sul tenant Plex di un plant — feature 0042.
 *
 * PERCHE' ESISTE
 * Il delta di `MAT_SYNC` si fidava solo del nostro registro: `ZMatExcLogHDR` dice «inviato» e nessuno
 * chiedeva a Plex se la part ci fosse ancora. Il tenant di test si azzera ogni settimana — verificato
 * in DEV: 304 coppie in perimetro, il nostro registro le dava tutte inviate, su Plex non ce n'era
 * nessuna — e in produzione una part si puo' cancellare a mano. Senza questa lettura quelle coppie
 * non tornano mai piu' nel delta: un MES a cui manca l'anagrafica, e niente che lo dica.
 *
 * UNA LETTURA PER PLANT, NON UNA PER MATERIALE. `GET /mdm/v1/parts` senza parametri restituisce
 * l'elenco del tenant: e' lo stesso indirizzo che il tasto «Test connessione» della configurazione
 * plant usa da sempre, dove ne conta le righe. Una lettura per materiale costerebbe N chiamate per
 * rispondere alla stessa domanda, e saturerebbe l'anello del tracciato.
 *
 * SI INDICIZZANO GLI UUID, NON I NUMERI PART. La domanda e' «la part che il nostro dizionario
 * dichiara esiste ancora?», e il dizionario la nomina col `PlexId` che Plex stesso ci ha risposto
 * quando l'ha creata: confrontare id contro id chiude la condizione da sola al run successivo. I
 * numeri si tengono solo per il log — «numero presente con un altro id» vuol dire part rifatta a
 * mano, ed e' un reinvio corretto. Il perche' in lungo sta in `partMissingSet`
 * (srv/lib/matPlantRules.js).
 *
 * [PART-DUPLICATE] QUI C'ERA SCRITTO «e innocuo», E NON LO ERA. Quel reinvio arriva a
 * `sendProductToPlex` con un mapping che c'e' ancora e punta a una part sparita: PUT → `404` →
 * ripiego su POST → e il numero e' occupato dalla part rifatta, quindi `400`. Fino al 14/09/2026
 * quel ramo LANCIAVA — l'unico dei due POST a non leggere l'id che Plex mette nel rifiuto — e il
 * materiale si fermava (025032052001 / plant 07, il primo giro utile di questa condizione). Ora i
 * due POST condividono `recoverOrThrowOnCreate`, e la condizione si chiude davvero da sola. La
 * frase resta a memoria: una lettura che rimette di proposito una coppia nel delta deve sapere
 * DOVE la manda, e quel ramo non lo aveva mai percorso nessuno.
 *
 * `ok` NON E' «INSIEME NON VUOTO», ed e' la ragione per cui questo modulo esiste invece di due righe
 * dentro il job. Un tenant appena azzerato risponde `200` con zero part: e' un fatto, e va distinto
 * da una lettura che non e' riuscita — perche' sulla prima si reinvia e sulla seconda non si conclude
 * niente. `remoteKnown: false` e' il flag che porta quella differenza a valle.
 *
 * NESSUNA PAGINAZIONE, E NESSUN MODO DI SAPERE SE E' TRONCATA. I contratti in srv/external/ lo
 * dichiarano per gli indirizzi gemelli. E' il limite di questa feature, e il rimedio non e' tecnico:
 * sono i tre numeri che il job scrive nel recap, che rendono un elenco corto visibile la prima
 * notte invece che dopo un mese.
 *
 * [PART-QUERY] QUI C'ERA SCRITTO «per `/mdm/v1/parts` un contratto non esiste», E NON E' VERO. Il
 * contratto c'e' ed e' interrogabile sul portale sviluppatori, come DEC-67 dice da sempre:
 * `parts-api` / `list-parts`, versioni v1 e v2. Quella frase e' costata cara altrove — e' la stessa
 * ricerca non fatta che ha lasciato il passo 1 degli ordini a filtrare con un parametro inesistente
 * (`partNumber`), scaricando 3957 part per usarne una. Il contratto dichiara anche i parametri di
 * questo indirizzo: se un giorno servisse restringere questo elenco, si restringe con `number`,
 * `type` o `status`, non inventando un nome.
 *
 * Perimetro: grep -rn "PART-ALIVE"
 */

'use strict';

const { normalizeUuid } = require('./recvOpRules');
// [PART-QUERY] L'indirizzo del Parts API in un punto solo. Questo elenco resta su v1 finche' non
// e' misurato che l'UUID scritto da una POST v1 sia lo stesso che la v2 restituisce: vedi la
// testata di plexPartsApi.js, il rischio e' reinviare l'intera anagrafica ogni notte.
const plexPartsApi = require('./plexPartsApi');

/** TTL della cache. Gemello di quello del catalogo operazioni: la cache e' PER PLANT. */
const CATALOG_TTL_MS = Number(process.env.PLEX_PART_CATALOG_TTL_MS || 60000);

const catalogCache = new Map();   // plant -> { at, value }

// ================================================================
// Le parti pure: forma della risposta e indice
// ================================================================

/**
 * Le righe di una risposta Plex, e LA FORMA in cui sono arrivate.
 *
 * IL SECONDO VALORE DI RITORNO E' LA DIFESA PIU' IMPORTANTE DEL MODULO. Nel progetto convivono due
 * convenzioni di involucro — `{data}`/`{results}` sulle letture inventory, `{value}`/`{results}` sul
 * catalogo operazioni — e un estrattore che prendesse quella sbagliata renderebbe un insieme VUOTO
 * su una risposta piena. Con `remoteKnown` a `true`, quel vuoto significherebbe «nessuna part esiste»
 * e il job reinvierebbe l'intero perimetro OGNI NOTTE, con esito verde. Percio': forma non
 * riconosciuta con un corpo NON vuoto non e' un tenant vuoto, e' una lettura da dichiarare non
 * conclusiva.
 *
 * @param {*} data corpo della risposta
 * @returns {{rows: Array<object>, shape: 'array'|'data'|'results'|'value'|'empty'|'unknown'}}
 */
function extractParts(data) {
  if (Array.isArray(data)) return { rows: data, shape: 'array' };
  if (data && Array.isArray(data.data)) return { rows: data.data, shape: 'data' };
  if (data && Array.isArray(data.results)) return { rows: data.results, shape: 'results' };
  if (data && Array.isArray(data.value)) return { rows: data.value, shape: 'value' };
  // Un corpo assente o vuoto e' un'informazione: il tenant non ha part. Un corpo che c'e' ma non si
  // sa leggere, no.
  if (data === null || data === undefined || data === '') return { rows: [], shape: 'empty' };
  if (typeof data === 'object' && Object.keys(data).length === 0) return { rows: [], shape: 'empty' };
  return { rows: [], shape: 'unknown' };
}

/**
 * L'indice degli id del tenant, piu' quello dei numeri (che serve al solo log).
 *
 * Una riga senza id non entra: non e' una part che possiamo confrontare col dizionario, e contarla
 * come presente vorrebbe dire dichiarare vivo qualcosa che non sappiamo nominare.
 *
 * @param {Array<object>} rows
 * @returns {{ids: Set<string>, numbers: Set<string>, withoutId: number}}
 */
function indexParts(rows) {
  const ids = new Set();
  const numbers = new Set();
  let withoutId = 0;
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') { withoutId++; continue; }
    // Le stesse due grafie che leggono gia' le altre quattro letture part del progetto.
    const id = normalizeUuid(r.partId || r.id || r.PartId || r.Id);
    if (!id) { withoutId++; } else { ids.add(id); }
    const num = String(r.number || r.partNumber || r.Number || r.PartNumber || '').trim().toUpperCase();
    if (num) numbers.add(num);
  }
  return { ids, numbers, withoutId };
}

// ================================================================
// La lettura
// ================================================================

/**
 * Legge l'elenco delle part del tenant di un plant.
 *
 * Non lancia mai: un guasto e' `remoteKnown: false`, che a valle vale «non lo so» e non «non c'e'
 * niente». Il chiamante lo dichiara nel recap.
 *
 * @param {{baseUrl: string, consumerKey: string}} conn connessione Plex del plant (feature 0020)
 * @param {string} plant  solo per la cache e per il log
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{remoteKnown: boolean, ids: Set<string>, numbers: Set<string>, count: number,
 *                    shape: string, status: number, error: string|null, withoutId: number}>}
 */
async function loadPartCatalog(conn, plant, opts = {}) {
  const key = String(plant === null || plant === undefined ? '' : plant);
  const hit = catalogCache.get(key);
  if (!opts.force && hit && (Date.now() - hit.at) < CATALOG_TTL_MS) return hit.value;

  const notKnown = (status, error, shape) => ({
    remoteKnown: false, ids: new Set(), numbers: new Set(), count: 0,
    shape: shape || 'none', status, error, withoutId: 0
  });

  if (!conn || !conn.baseUrl) {
    return notKnown(0, 'connessione Plex non risolta per il plant');
  }

  const url = `${conn.baseUrl}${plexPartsApi.partsCatalogPath()}`;
  let value;
  try {
    console.log(`>>> [PART-ALIVE] plant ${key}: elenco part del tenant, GET ${url}`);
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Plex-Connect-Api-Key': conn.consumerKey }
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`>>> [PART-ALIVE] plant ${key}: HTTP ${resp.status} — elenco NON letto`);
      value = notKnown(resp.status, `HTTP ${resp.status}: ${String(text || '').substring(0, 200)}`);
    } else {
      const data = await resp.json();
      const { rows, shape } = extractParts(data);
      if (shape === 'unknown') {
        // Vedi `extractParts`: un corpo che non si sa leggere e' il difetto piu' pericoloso di questa
        // feature, quindi si dichiara con le chiavi trovate — sono l'unico indizio su cosa e'
        // cambiato — e NON si conclude che il tenant sia vuoto.
        const chiavi = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
        console.error(`>>> [PART-ALIVE] plant ${key}: forma della risposta NON riconosciuta`
          + ` (chiavi: ${chiavi}). L'elenco si considera NON letto: un corpo illeggibile non e' un`
          + ' tenant vuoto, e trattarlo come tale reinvierebbe tutto il perimetro.');
        value = notKnown(resp.status, `forma non riconosciuta (${chiavi})`, 'unknown');
      } else {
        const idx = indexParts(rows);
        value = {
          remoteKnown: true, ids: idx.ids, numbers: idx.numbers, count: rows.length,
          shape, status: resp.status, error: null, withoutId: idx.withoutId
        };
        console.log(`>>> [PART-ALIVE] plant ${key}: ${rows.length} part sul tenant`
          + ` (${idx.ids.size} con id${idx.withoutId ? `, ${idx.withoutId} senza id` : ''})`
          + `, forma «${shape}»`);
        if (rows.length > 0) {
          // Le chiavi grezze della prima riga: e' cosi' che si scopre in un colpo una grafia di campo
          // diversa da quella attesa. Stessa riga del catalogo operazioni.
          console.log(`>>> [PART-ALIVE] plant ${key}: chiavi prima riga ${JSON.stringify(Object.keys(rows[0]))}`);
        }
      }
    }
  } catch (e) {
    console.warn(`>>> [PART-ALIVE] plant ${key}: lettura fallita (${e.message})`);
    value = notKnown(0, e.message);
  }

  // Anche un esito NON conclusivo si mette in cache, per il TTL: dentro un run non si ritenta una
  // lettura appena fallita una volta per plant. Il TTL e' breve e il run successivo riprova.
  catalogCache.set(key, { at: Date.now(), value });
  return value;
}

/** Svuota la cache. `plant` assente = tutti. */
function invalidatePartCatalog(plant) {
  const key = plant === null || plant === undefined ? '' : String(plant);
  if (key) catalogCache.delete(key); else catalogCache.clear();
}

module.exports = {
  extractParts,
  indexParts,
  loadPartCatalog,
  invalidatePartCatalog,
  CATALOG_TTL_MS
};

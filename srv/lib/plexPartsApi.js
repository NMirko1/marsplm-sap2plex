/**
 * [PART-QUERY] Gli indirizzi del Parts API di Plex, in un punto solo.
 *
 * PERCHE' ESISTE, E COSA E' COSTATO NON AVERLO
 *
 * Il progetto cercava una part con `GET /mdm/v1/parts?partNumber=<numero>`. Quel parametro NON
 * ESISTE: il contratto del portale sviluppatori (DEC-67) dichiara per `list-parts`, su ENTRAMBE le
 * versioni, i parametri `id`, `number`, `revision`, `type`, `status`, `source`, `productType`,
 * `allergens`. Plex ignora un parametro che non conosce e risponde con TUTTO.
 *
 * Misurato il 21/09/2026 sull'ordine `000700000069`: la risposta del passo `1 Check Part` pesava
 * 1.901.325 byte e conteneva l'intero catalogo del tenant, 3957 part, per usarne UNA. Quel corpo
 * finisce nello storico invii, e l'ordine aveva 204 tentativi — circa 45 al giorno, cioe' ~79 MB
 * al giorno per un ordine solo. E' anche la riga che, riletta tutta insieme, faceva morire il
 * processo per memoria esaurita (DEC-136).
 *
 * IL COMMENTO CHE HA COPERTO IL DIFETTO diceva «si filtra lato client perche' alcuni tenant
 * ignorano il query parameter e restituiscono l'intera lista parti». Era un'IPOTESI scritta come
 * un fatto, e ha retto per mesi perche' il codice compensava a valle con un `.find`. La lezione e'
 * di DEC-123: quando resta una variabile sola non la si deduce, la si misura — e qui bastava
 * leggere il contratto, che c'e' ed e' interrogabile (DEC-67).
 *
 * DA DOVE VENIVA IL NOME SBAGLIATO. Il progetto parla con DUE famiglie di API che servono la
 * stessa cosa con nomi diversi:
 *
 *     /mdm/v2/parts                              -> `number`      (Parts API)
 *     /inventory/v1/inventory-definitions/parts  -> `partNumber`  (Inventory Operations Mgmt API)
 *
 * `partNumber` e' corretto sulla seconda — la usa `resolveComponentId` in orderBomAdd.js, ed e'
 * giusta cosi'. Il nome e' stato portato dalla seconda alla prima. `test/plexPartQuery.test.js`
 * tiene la differenza: livellarla dalla parte sbagliata e' l'errore gia' fatto una volta.
 *
 * PERCHE' LA v2 IN LETTURA. Sul `parts-api` il portale offre SOLO operazioni v2 (base
 * `https://connect.plex.com/mdm/v2`): la v1 sopravvive come specifica ma non e' piu' pubblicata.
 * I campi che il progetto usa — `id`, `number`, `buildingCode` — ci sono in entrambe; la v2 ne
 * aggiunge otto e rinomina solo `createdDate`/`modifiedDate` in `…DateTime`, che non leggiamo.
 *
 * PERCHE' LE SCRITTURE RESTANO IN v1, ed e' una differenza che morde. Nel corpo di creazione part
 * la v1 dichiara obbligatorio il solo `number`; la v2 dichiara obbligatori anche `type` e
 * `status`. Quei due valori arrivano dal customizing per plant (`ZPlexFieldMap`, feature 0022):
 * un plant che non mappa `status` oggi crea la part e su v2 riceverebbe un `400`, su `MAT_SYNC`,
 * cioe' sull'anagrafica che alimenta il MES. Spostarle e' una feature sua, e il suo primo passo e'
 * un censimento per plant. Fino ad allora il debito e' qui, dichiarato.
 *
 * Le altre API Plex che il progetto usa NON hanno una v2 e non c'entrano: `process-routings-api`
 * (part-operations, operations) e `buildings-api` esistono solo in `v1`/`v1-beta1`, e
 * `job-scheduling-api` solo in v1.
 *
 * Perimetro: grep -rn "PART-QUERY". Test: `node test/plexPartQuery.test.js`.
 */

'use strict';

/** Le letture per numero e per id: la sola versione che il portale pubblica. */
const PARTS_READ_BASE = '/mdm/v2/parts';

/**
 * Le scritture, e per ora anche l'elenco non filtrato del tenant.
 *
 * Le scritture per la ragione in testata. L'ELENCO per una ragione diversa e temporanea: lo legge
 * `[PART-ALIVE]`, che confronta gli id del dizionario con quelli del tenant, e nessuno ha ancora
 * misurato che l'UUID scritto da una `POST /mdm/v1/parts` sia lo stesso che la v2 restituisce. Se
 * i due spazi di identificativi non coincidessero, quel confronto dichiarerebbe OGNI part mancante
 * e rimanderebbe l'intera anagrafica ogni notte, in verde. Si sposta quando la misura c'e'.
 */
const PARTS_WRITE_BASE = '/mdm/v1/parts';

/** Il literal di un parametro di query, codificato una volta sola. */
const q = (v) => encodeURIComponent(String(v === null || v === undefined ? '' : v));

/**
 * La lettura di una part per NUMERO.
 *
 * Chi chiama non smette di filtrare lato client, e non e' pleonastico: il contratto dice «The part
 * number» e non dichiara se il confronto sia esatto o per prefisso. DEC-80 ha gia' pagato un
 * `jobNumber=` che agganciava per prefisso, quindi finche' non e' misurato a scegliere la riga e'
 * il confronto nostro — e una riga sola tornata non autorizza a fidarsi.
 *
 * @param {string} number il numero part (il materiale SAP)
 * @returns {string} path relativo alla base della connessione Plex del plant
 */
function partByNumberPath(number) {
  return `${PARTS_READ_BASE}?number=${q(number)}`;
}

/**
 * La lettura di una part per UUID.
 * @param {string} id
 * @returns {string}
 */
function partByIdPath(id) {
  return `${PARTS_READ_BASE}/${q(id)}`;
}

/**
 * L'elenco delle part del tenant, senza filtro: e' voluto, ed e' il modo in cui `[PART-ALIVE]`
 * risponde con UNA lettura per plant a una domanda che per materiale ne costerebbe N.
 * Resta su `PARTS_WRITE_BASE` finche' la misura descritta li' non c'e'.
 * @returns {string}
 */
function partsCatalogPath() {
  return PARTS_WRITE_BASE;
}

/**
 * L'indirizzo di scrittura: creazione senza id, aggiornamento e cancellazione con.
 * @param {string} [id]
 * @returns {string}
 */
function partsWritePath(id) {
  return id ? `${PARTS_WRITE_BASE}/${q(id)}` : PARTS_WRITE_BASE;
}

/**
 * Il numero part di una riga, comunque l'indirizzo lo chiami.
 *
 * Sul Parts API la riga porta `number`; sull'Inventory API porta `partNumber`. Le due forme si
 * tollerano entrambe perche' questa funzione serve a tutti e due i lettori — ma NON e' un invito a
 * mandare `partNumber` come filtro: quello e' il difetto che questo modulo chiude.
 */
function numberOf(row) {
  return String((row && (row.number || row.partNumber)) || '');
}

/**
 * L'UUID di una riga, comunque l'indirizzo lo chiami. Parts API: `id`. Inventory API: `partId`.
 */
function idOf(row) {
  return String((row && (row.id || row.partId)) || '');
}

module.exports = {
  PARTS_READ_BASE,
  PARTS_WRITE_BASE,
  partByNumberPath,
  partByIdPath,
  partsCatalogPath,
  partsWritePath,
  numberOf,
  idOf
};

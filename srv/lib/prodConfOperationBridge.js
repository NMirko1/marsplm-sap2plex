/**
 * [CONF-OP-BRIDGE] Da un'operazione Plex all'operazione SAP, per NUMERO (feature 0027).
 *
 * IL DIFETTO CHE QUESTO MODULO CHIUDE. Fino a qui `postProdOrderConfirmation` risolveva
 * l'operazione cosi':
 *
 *     SELECT SAPOperationId FROM ZPlexCycleOperation
 *      WHERE ManufacturingOrder = :ordine AND PlexOperationId = :partOperationId
 *
 * I due lati sono UUID di SPECIE DIVERSA e non agganciano mai.
 *   - `ZPlexCycleOperation.PlexOperationId` e' l'id dell'operazione nel CATALOGO del tenant, cioe'
 *     `OperationDTO.id` di `GET /mdm/v1/operations`. Lo dice il docblock di ZMatRecvOpConfig
 *     («il POST /mdm/v1/part-operations vuole `operationId`, che e' l'`id` restituito da
 *     getPlexOperations») e lo conferma cat-service.js, che lo manda proprio in `operationId`.
 *   - `partOperationId` delle production/scrap entries e' l'id della PART-OPERATION. Il contratto
 *     Plex: «The ID of the part operation» / «UUID of the part operation that was produced».
 *
 * Che le due specie siano distinte il progetto lo sapeva gia' in tre punti: ZMatRecvOpMapping le
 * tiene in DUE colonne (`PartOperationId` e `PlexOperationId`), cat-service.js costruisce la mappa
 * `operationId -> partOperationId`, e approvedWcRules.opIdOfPartOp la inverte. Solo questo job le
 * confrontava fra loro.
 *
 * Conseguenza del difetto: OGNI production entry e OGNI scrap entry finiva in quarantena, la fase
 * che costruisce i documenti non veniva mai raggiunta, e il flusso con effetti contabili non
 * registrava NIENTE in SAP. Non un movimento sbagliato: zero movimenti. Non e' emerso perche'
 * ZPlant.MatDocPostEnabled nasce `false` e il run chiudeva in ATTENZIONE — non in errore — con un
 * messaggio («partOperationId non mappato») che si legge come «il ciclo non e' ancora stato
 * salvato», cioe' come una configurazione mancante.
 *
 * IL PONTE E' IL NUMERO, e non e' una scelta di comodo: e' quello che il modello dichiarava gia'.
 * db/schema.cds su ZProdConfPlexEntry.OperationNumber: «Numero operazione Plex (intero: 10, 20). E'
 * il RIPIEGO per risalire all'operazione SAP quando ZPlexCycleOperation non ha la riga». Quel
 * ripiego non era mai stato implementato — il campo veniva scritto e non letto da nessuno. E il
 * contratto dei job Plex dice la stessa cosa: «`JobOperationDTO` porta `operationCode` ma non
 * l'`operationId` di catalogo; `PartOperationDTO` porta l'`operationId` ma non il codice. Il ponte
 * con la part-operation e' il NUMERO».
 *
 * QUATTRO ESITI, E NESSUNO DI ESSI E' «PRENDO LA PRIMA RIGA».
 *   1. numero assente o non numerico  -> non si risolve, e si dice che il numero manca;
 *   2. nessuna riga                   -> non si risolve: il ciclo dell'ordine non e' stato salvato;
 *   3. PIU' di una riga               -> non si risolve, si RIFIUTA. Due operazioni di ciclo con lo
 *      stesso numero sullo stesso ordine sono un dato ambiguo, e scegliere la prima significherebbe
 *      registrare un movimento contabile sull'operazione sbagliata. E' la regola di DEC-78 e DEC-80:
 *      una chiave che torna ambigua si rifiuta;
 *   4. una riga ma `SAPOperationId` vuoto -> non si risolve. La colonna e' nullable di proposito e
 *      orderCycleImportRules la azzera quando il collegamento salvato non corrisponde a nessuna
 *      operazione dell'ordine: la riga esiste, il collegamento no.
 *
 * Tutti e quattro portano la registrazione in QUARANTENA, non in `'I'`: sono dati che possono
 * arrivare (si salva il ciclo, si corregge l'ambiguita') e la fase A-bis li ritenta a ogni run.
 *
 * FUNZIONI PURE: nessun `cds`, nessuna rete. La SELECT la fa il job, la decisione sta qui — ed e'
 * cio' che la rende collaudabile a secco (test/prodConfOperationBridge.test.js).
 *
 * Perimetro: grep -rn "CONF-OP-BRIDGE"
 */

'use strict';

const { opNum } = require('./confMatDoc');
// [LOG-MSG-I18N] I messaggi sono segmenti: il testo si rende alla lettura (feature 0031).
const logMsg = require('./logMessage');

/** Le colonne che la SELECT del ponte deve chiedere. In un posto solo, cosi' non divergono. */
const BRIDGE_COLUMNS = Object.freeze(['SAPOperationId', 'OperationCode', 'OperationNumber']);

/**
 * Il numero d'operazione Plex in forma confrontabile. FUNZIONE PURA.
 *
 * Plex manda un intero (`20`); `ZPlexCycleOperation.OperationNumber` e' `Integer not null`. Si
 * tronca perche' un numero d'operazione non ha decimali, e un `20.4` sarebbe un dato da vedere, non
 * da arrotondare in silenzio: `opNum` lo lascia passare e `Math.trunc` lo normalizza allo stesso
 * valore che il dizionario contiene.
 *
 * @param {number|string|null|undefined} v
 * @returns {number|null} null se non e' un numero
 */
function bridgeNumber(v) {
  const n = opNum(v);
  return n === null ? null : Math.trunc(n);
}

/**
 * L'operazione SAP, dalle righe di ZPlexCycleOperation lette per (ordine, numero). FUNZIONE PURA.
 *
 * @param {object[]} rows righe di ZPlexCycleOperation con le colonne di BRIDGE_COLUMNS
 * @param {object} ctx
 * @param {number|string} ctx.operationNumber numero d'operazione Plex della registrazione
 * @param {string} ctx.manufacturingOrder ordine SAP, solo per il messaggio
 * @returns {{operation: string|null, segments: Array, cause: string}}
 *   `cause` e' il codice della causa, per raggruppare nel recap senza dover confrontare frasi:
 *   `OK` · `NO_NUMBER` · `NOT_MAPPED` · `AMBIGUOUS` · `NO_SAP_LINK`
 *
 *   [LOG-MSG-I18N] `segments` e non `reason` (feature 0031): questi messaggi finiscono in
 *   `ZProdConfPlexEntry.Message`, che dalla 0031 si legge da schermata — quindi si rendono nella
 *   lingua di chi guarda. La `cause` NON e' un messaggio e resta un codice: e' cio' su cui il recap
 *   raggruppa, e un codice non si traduce.
 */
function resolveOperationRow(rows, { operationNumber, manufacturingOrder } = {}) {
  const num = bridgeNumber(operationNumber);
  const order = manufacturingOrder || '?';

  if (num === null) {
    return {
      operation: null,
      cause: 'NO_NUMBER',
      segments: [logMsg.seg('logConfOpNoNumber', operationNumber)]
    };
  }

  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);

  if (!list.length) {
    return {
      operation: null,
      cause: 'NOT_MAPPED',
      segments: [logMsg.seg('logConfOpNotMapped', num, order)]
    };
  }

  // AMBIGUA: non si sceglie. Vedi la testata, esito 3.
  if (list.length > 1) {
    const codes = list.map((r) => r.OperationCode || r.SAPOperationId || '?').join(', ');
    return {
      operation: null,
      cause: 'AMBIGUOUS',
      segments: [logMsg.seg('logConfOpAmbiguous', num, order, list.length, codes)]
    };
  }

  const sap = list[0].SAPOperationId;
  if (sap === null || sap === undefined || String(sap).trim() === '') {
    return {
      operation: null,
      cause: 'NO_SAP_LINK',
      segments: [logMsg.seg('logConfOpNoSapLink', num, order)]
    };
  }

  return {
    operation: String(sap).trim(),
    cause: 'OK',
    segments: [logMsg.seg('logConfOpResolved', num, String(sap).trim())]
  };
}

module.exports = {
  BRIDGE_COLUMNS,
  bridgeNumber,
  resolveOperationRow
};

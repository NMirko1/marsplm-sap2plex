/**
 * [MATDOC-CONF] Le tre letture Plex del job PROD_CONF e la forma dei loro record (feature 0021).
 *
 * FUNZIONI PURE: nessun `cds`, nessuna rete, nessun orologio. Il TRASPORTO resta nel job
 * (`plexGet` di srv/jobs/lib/plexJobsClient.js) e la CONNESSIONE nel punto unico per plant
 * (srv/lib/plexConnection.js, feature 0020): qui c'è solo il contratto delle risposte, che è la
 * parte che si sbaglia e l'unica collaudabile senza un tenant.
 *
 * TRE SORGENTI, NON UNA. Fino alla 0021 il job leggeva le sole production entries, e da lì
 * discendeva un difetto documentato come limite dell'endpoint: «scrap e rework non sono
 * disponibili -> 0» (0009, RB-20). Non era un limite di Plex, era l'endpoint sbagliato: lo scarto
 * ha una API propria. `ScrapQuantity` smette quindi di essere una costante.
 *
 *   PROD_ENTRY   /production/v1/production-history/production-entries   il prodotto buono
 *   SCRAP_ENTRY  /production/v1/production-history/scrap-entries        lo scarto
 *   CONT_ADJ     /inventory/v1/inventory-history/container-adjustments  le rettifiche di giacenza
 *
 * Tutte e tre filtrano con `beginDate` / `endDate` in ISO 8601, e ognuna ha il PROPRIO watermark
 * (srv/lib/plexConfWindow.js): l'esito di una non tocca le altre.
 *
 * LA CHIAVE DI DEDUP, E PERCHE' UNA DELLE TRE NON HA IL PREFISSO
 * Nessuna delle tre API espone un identificativo di riga, quindi la chiave si costruisce. Le due
 * sorgenti nuove portano un prefisso ('S|', 'A|'); le production entries NO, e non è una svista:
 * prefissarle renderebbe NUOVE tutte le righe già in ZProdConfPlexEntry, che tornerebbero 'E' e
 * verrebbero rispedite a SAP come movimenti di magazzino. La forma storica È la forma della
 * sorgente 'P', per sempre.
 *
 * Budget della chiave, che è `String(150)`: il caso peggiore è lo scarto, `S|` + jobId(36) +
 * partOperationId(36) + serialNo(25) + transactionDate(24) e tre separatori = 124. Non si tronca
 * mai — troncare fonderebbe due registrazioni distinte in una, cioè perderebbe un movimento.
 *
 * [PLEX-HISTORY-WIDTH] Il conto diceva 139 e assumeva `serialNo` a 40 caratteri: il contratto
 * versionato ne dichiara 25, quindi il margine è più ampio di quanto si credesse. È il tipo di
 * correzione che solo un contratto in repo permette di fare.
 *
 * COSA NON SI LEGGE, DI PROPOSITO
 * `GET /inventory-tracking/v1-beta1/containers/{serialNumber}` (passo 3.1 del foglio degli
 * endpoint) restituisce la `location` del contenitore, e serviva a dare un magazzino allo scarto.
 * Non è usata: il magazzino SAP si legge dall'ordine di produzione, non da un codice Plex a cui
 * dovrebbe corrispondere (feature 0021, D8). Evitarla toglie anche una chiamata per ogni scarto.
 *
 * Collaudo: test/confMatDoc.test.js (la forma dei record) e il job per il trasporto.
 */

'use strict';

/** Un valore Plex -> stringa pulita, senza inventare nulla quando manca. */
function s(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * [CONF-POSTING] Il LOTTO nella chiave di deduplica, e perché non è `${e.jobId}` nudo.
 *
 * Il contratto Plex dichiara `jobId` OPZIONALE su tutte e tre le letture, e per gli scarti è il
 * discriminante dello scarto di un pezzo già versato. Interpolato nudo, un campo assente diventa la
 * stringa `undefined` e un campo `null` diventa `null`: due chiavi DIVERSE per la stessa
 * registrazione fisica, quindi il giorno in cui Plex passasse dall'omettere il campo a mandarlo
 * `null` — o viceversa — tutte quelle registrazioni risulterebbero nuove e verrebbero registrate una
 * seconda volta in SAP. Con il campo assente reso `''` la chiave è la stessa in entrambi i casi.
 *
 * NON si tocca il resto della chiave: `partOperationId`, `serialNo` e la data sono l'identità del
 * record, e un `undefined` là dentro dev'essere VISTO dal guardiano dell'ingest, non normalizzato.
 */
function jobKeyPart(v) {
  return s(v);
}

/** Un numero Plex -> Number, oppure null. Lo zero è un valore, non un'assenza. */
function n(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/**
 * Il numero d'operazione Plex, che è un INTERO nel contratto (`"operationNumber": 0`) mentre in
 * SAP l'operazione è `String(4)` con gli zeri davanti. Qui si conserva l'intero: la conversione è
 * un confronto e sta in confMatDoc.isFinalOperation, che è dove si decide qualcosa.
 */
function opNumber(v) {
  const x = n(v);
  return x === null ? null : Math.trunc(x);
}

// ---------------------------------------------------------------------------------------------
// I NORMALIZZATORI — uno per sorgente, tutti verso la STESSA forma
//
// La forma comune è ciò che permette a fase A, quarantena e recap di essere scritte una volta
// sola: un campo che una sorgente non ha resta `''`/`null`, non viene riempito con un segnaposto.
// ---------------------------------------------------------------------------------------------

/**
 * Production entry -> forma comune.
 *
 * I 31 campi della risposta, con tipi e lunghezze, stanno nel contratto versionato
 * srv/external/PLEX_PRODUCTION_HISTORY_API_CONTRACT.md: non si ripetono qui, perche' un elenco in
 * due posti divergerebbe — ed e' proprio quello che e' successo con `serialNo`, che questo commento
 * dava a 40 caratteri mentre il contratto ne dichiara 25 (vedi il budget della chiave in testata).
 */
function mapProductionEntry(raw) {
  const e = raw || {};
  return {
    sourceType: 'P',
    // FORMA STORICA, senza prefisso: vedi la testata. Non si tocca.
    // [CONF-POSTING] `jobKeyPart` NON la cambia dove un lotto c'è, che è ogni riga oggi in tabella:
    // cambia solo il caso in cui il lotto MANCA, dove la chiave conteneva la stringa `undefined` e
    // il guardiano dell'ingest scartava il record senza persisterlo. Là non c'è niente da
    // conservare, e senza la normalizzazione la stessa registrazione avrebbe due chiavi.
    plexEntryId: `${jobKeyPart(e.jobId)}|${e.partOperationId}|${e.serialNo}|${e.transactionDate}`,
    jobId: s(e.jobId),
    jobCode: s(e.jobCode),
    jobNo: s(e.jobNo),
    partOperationId: s(e.partOperationId),
    operationNumber: opNumber(e.operationNumber),
    operationCode: s(e.operationCode),
    workcenterId: s(e.workcenterId),
    serialNo: s(e.serialNo),
    partNumber: s(e.partNumber),
    // [CONF-POSTING] L'UUID della part. Il contratto lo dichiara su tutte e tre le letture e prima
    // della 0028 veniva buttato via: è l'unico aggancio al materiale SAP quando l'ordine non c'è
    // (srv/lib/plexMatDictionary.js). Il NUMERO non basta — su Plex la chiave è l'UUID.
    partId: s(e.partId),
    // La quantità del prodotto buono. Scarto e rilavorazione NON sono qui e non si inventano: lo
    // scarto ha la sua sorgente, la rilavorazione non ha endpoint e resta 0.
    yieldQuantity: n(e.quantity),
    scrapQuantity: 0,
    reworkQuantity: 0,
    unit: s(e.unit),
    lotNo: s(e.lotNo),
    heatNo: s(e.heatNo),
    trackingNo: s(e.trackingNo),
    // Dati di FATTO del lotto prodotto: finiscono nel documento di versamento (Batch, shelf life),
    // non sono codici da far corrispondere.
    shelfDateTime: s(e.shelfDateTime) || null,
    manufacturedDateTime: s(e.manufacturedDateTime) || null,
    entryDate: s(e.transactionDate) || null,
    scrapReason: '',
    transactionType: '',
    adjustmentCode: '',
    plexLocation: '',
    netWeight: null
  };
}

/**
 * Scrap entry -> forma comune.
 *
 * I 16 campi stanno nel contratto (srv/external/PLEX_PRODUCTION_HISTORY_API_CONTRACT.md), che
 * fissa anche i due valori di `transactionType`: `Control Panel Scrap` oppure `Scrap`.
 *
 * Nota: `jobId` c'è, quindi lo scarto risale all'ordine SAP esattamente come il prodotto. Non c'è
 * `jobNo` e non c'è la location — vedi la testata per quest'ultima.
 */
function mapScrapEntry(raw) {
  const e = raw || {};
  return {
    sourceType: 'S',
    plexEntryId: `S|${jobKeyPart(e.jobId)}|${e.partOperationId}|${e.serialNo}|${e.transactionDate}`,
    jobId: s(e.jobId),
    jobCode: s(e.jobCode),
    jobNo: '',
    partOperationId: s(e.partOperationId),
    operationNumber: opNumber(e.operationNumber),
    operationCode: s(e.operationCode),
    workcenterId: s(e.workcenterId),
    serialNo: s(e.serialNo),
    partNumber: s(e.partNumber),
    // [CONF-POSTING] Qui `partId` non è un riferimento comodo: è il DATO su cui si costruisce lo
    // scarto di un pezzo già versato, dove `jobId` manca e con esso l'ordine e il suo materiale.
    partId: s(e.partId),
    // Qui la quantità E' lo scarto: è l'inversione rispetto alla production entry, ed è il punto
    // in cui una svista produrrebbe un versamento al posto di uno scarico.
    yieldQuantity: 0,
    scrapQuantity: n(e.quantity),
    reworkQuantity: 0,
    unit: '',
    lotNo: '',
    heatNo: '',
    trackingNo: '',
    shelfDateTime: null,
    manufacturedDateTime: null,
    entryDate: s(e.transactionDate) || null,
    // Causale e tipo transazione Plex: NON sono un GoodsMovementReasonCode SAP. Viaggiano nel
    // testo riga del documento, dove sono leggibili e non pretendono di essere un codice (D8).
    scrapReason: s(e.scrapReason),
    transactionType: s(e.transactionType),
    adjustmentCode: '',
    plexLocation: '',
    netWeight: null
  };
}

/**
 * Container adjustment -> forma comune.
 * I 14 campi stanno nel contratto (srv/external/PLEX_PRODUCTION_HISTORY_API_CONTRACT.md). Nota che
 * `quantity` e `netWeight` sono DELTA CON SEGNO, positivi o negativi: non sono giacenze.
 *
 * NON HA `jobId`: una rettifica di giacenza non è agganciata a un ordine di produzione, quindi non
 * è traducibile in un movimento d'ordine. Per la 0021 si LEGGE e si PERSISTE (stato 'I') senza
 * generare documenti: quale movimento SAP debba diventare è una decisione che non è stata presa, e
 * inventarla qui significherebbe scrivere movimenti contabili a caso.
 */
function mapAdjustment(raw) {
  const e = raw || {};
  return {
    sourceType: 'A',
    plexEntryId: `A|${e.serialNo}|${e.partOperationId}|${e.adjustmentDate}`,
    jobId: '',
    jobCode: '',
    jobNo: '',
    partOperationId: s(e.partOperationId),
    operationNumber: opNumber(e.operationNumber),
    operationCode: s(e.operationCode),
    workcenterId: '',
    serialNo: s(e.serialNo),
    partNumber: s(e.partNumber),
    partId: s(e.partId),
    yieldQuantity: 0,
    scrapQuantity: 0,
    reworkQuantity: 0,
    unit: '',
    lotNo: '',
    heatNo: '',
    trackingNo: '',
    shelfDateTime: null,
    manufacturedDateTime: null,
    entryDate: s(e.adjustmentDate) || null,
    scrapReason: '',
    transactionType: '',
    adjustmentCode: s(e.adjustmentCode),
    plexLocation: s(e.location),
    netWeight: n(e.netWeight),
    // La quantità della rettifica c'è, ma non alimenta né yield né scarto: senza un movimento
    // deciso non ha un verso. Resta nel RawJson e in questo campo, per quando servirà.
    adjustmentQuantity: n(e.quantity)
  };
}

/**
 * LE TRE SORGENTI, e l'ordine di questa tabella è l'ordine di lettura.
 *
 * `producesDocuments` è dichiarativo di proposito: dice che una sorgente viene letta e persistita
 * ma non genera movimenti, invece di lasciarlo dedurre da un `if` sepolto nella fase A. Quando le
 * rettifiche avranno un movimento, qui cambia una riga.
 */
const SOURCES = Object.freeze([
  Object.freeze({
    code: 'PROD_ENTRY',
    label: 'registrazioni di produzione',
    path: '/production/v1/production-history/production-entries',
    sourceType: 'P',
    producesDocuments: true,
    map: mapProductionEntry
  }),
  Object.freeze({
    code: 'SCRAP_ENTRY',
    label: 'scarti',
    path: '/production/v1/production-history/scrap-entries',
    sourceType: 'S',
    producesDocuments: true,
    map: mapScrapEntry
  }),
  Object.freeze({
    code: 'CONT_ADJ',
    label: 'rettifiche di giacenza',
    path: '/inventory/v1/inventory-history/container-adjustments',
    sourceType: 'A',
    // Letta e persistita, nessun documento: vedi mapAdjustment.
    producesDocuments: false,
    map: mapAdjustment
  })
]);

const SOURCE_BY_CODE = Object.freeze(
  SOURCES.reduce((acc, s2) => Object.assign(acc, { [s2.code]: s2 }), {})
);

/**
 * La query string della lettura. FUNZIONE PURA.
 * Nessun filtro opzionale (workcenter, job, part): si legge tutta la finestra e si filtra a valle,
 * come già faceva la lettura storica — un filtro lato Plex renderebbe il watermark bugiardo,
 * perché la finestra risulterebbe letta anche per ciò che il filtro ha escluso.
 *
 * @param {{path: string}} source voce di SOURCES
 * @param {{beginDate: string, endDate: string}} window
 * @returns {string} path completo, pronto per plexGet
 */
function requestPath(source, window) {
  const qs = new URLSearchParams({
    beginDate: window.beginDate,
    endDate: window.endDate
  }).toString();
  return `${source.path}?${qs}`;
}

/**
 * Normalizza il body di una risposta Connect REST in array.
 * Le tre API rispondono con un array nudo; le altre forme sono tollerate perché costano una riga e
 * perché una risposta inattesa non deve far cadere il lettore.
 */
function asArray(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  return body.value || body.results || body.data || [];
}

/**
 * [PLEX-HISTORY-WIDTH] Le larghezze delle colonne di ZProdConfPlexEntry che ricevono una stringa di
 * origine Plex, e il troncatore che le rispetta.
 *
 * PERCHE' ESISTE. Nessuno di questi campi veniva troncato in scrittura, e il contratto Plex
 * (srv/external/PLEX_PRODUCTION_HISTORY_API_CONTRACT.md) dichiara per quattro di essi una lunghezza
 * MAGGIORE della nostra colonna. ./jobSummary.js dice già perché il difetto non si vedeva in
 * collaudo: «sqlite ignora NVARCHAR(n), HANA lo impone». Su HANA l'INSERT fallito faceva cadere
 * l'ingest di quel plant, il watermark NON avanzava, e la stessa finestra veniva riletta e rifalliva
 * a ogni run — una pillola avvelenata.
 *
 * Tre colonne sono state ALLARGATE al contratto (`PartNumber`, `TrackingNo`, `AdjustmentCode`), e
 * questo troncatore è la CINTURA: un cambio di contratto domani degrada un valore invece di
 * avvelenare la finestra. Quando morde, si dichiara.
 *
 * `PlexEntryId` NON E' IN QUESTO ELENCO, e non può entrarci: è la chiave di deduplica, e
 * questo modulo è esplicito — troncarla fonderebbe due registrazioni distinte, cioè
 * perderebbe un movimento. Con `serialNo` a 25 caratteri (contratto) e non 40 il caso peggiore è 124
 * su 150, quindi il troncamento non servirebbe comunque.
 */
const PLEX_FIELD_WIDTH = Object.freeze({
  PlexJobNumber: 40, PartOperationId: 36, JobId: 36, WorkcenterId: 36,
  ConfirmationUnit: 3,      // unità SAP: vedi il docblock della colonna, NON si allarga
  SerialNo: 40, PartNumber: 100, PlexPartId: 36, OperationCode: 50, LotNo: 40, HeatNo: 40,
  TrackingNo: 50,
  ScrapReason: 100, TransactionType: 40, AdjustmentCode: 50, PlexLocation: 50
});

/**
 * Tronca alla larghezza di colonna e dichiara cosa ha tagliato. FUNZIONE PURA.
 *
 * @param {object} row la riga da scrivere
 * @returns {{row: object, truncated: string[]}} `truncated` sono i nomi dei campi tagliati
 */
function fitPlexWidths(row) {
  const out = { ...row };
  const truncated = [];
  for (const [field, width] of Object.entries(PLEX_FIELD_WIDTH)) {
    const v = out[field];
    if (typeof v === 'string' && v.length > width) {
      out[field] = v.slice(0, width);
      truncated.push(`${field} (${v.length}>${width})`);
    }
  }
  return { row: out, truncated };
}

module.exports = {
  jobKeyPart,
  PLEX_FIELD_WIDTH,
  fitPlexWidths,
  SOURCES,
  SOURCE_BY_CODE,
  mapProductionEntry,
  mapScrapEntry,
  mapAdjustment,
  requestPath,
  asArray
};

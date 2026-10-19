/**
 * Job BTP — Registrazioni di produzione Plex -> documenti materiale S/4HANA.
 *
 * >>> [MATDOC-CONF] La feature 0021 ha cambiato ENTRAMBI i lati di questo job. <<<
 *
 * PRIMA, e perché non poteva funzionare. Il job leggeva UNA sorgente Plex (le production entries)
 * e scriveva una CONFERMA D'ORDINE con `POST /ProdnOrdConf2` sul path storico
 * `/sap/opu/odata/sap/API_PROD_ORDER_CONFIRMATION_2_SRV`. Presso un cliente servito da Integration
 * Suite quel path non esiste: la 0013 lo dichiara flusso INTERROTTO — le registrazioni si leggono
 * da Plex e restano in attesa, la scrittura non riesce, e ha effetti contabili.
 *
 * ORA. Le registrazioni diventano DOCUMENTI MATERIALE sull'iFlow di Integration Suite, per il quale
 * contratto, indirizzo e trasporto erano già collaudati (srv/lib/materialDocPost.js [MATDOC-POST],
 * fino a ieri una sonda con dati finti innescata dall'apertura della dashboard).
 *
 *   production entry, ULTIMA operazione  ->  '03' con il 261 di TUTTI i componenti
 *                                        +   '02' con il 101 del prodotto
 *   production entry, altre operazioni   ->  nessun movimento, riga 'I'
 *   scrap entry                          ->  '03' con il 551. Nessun 261
 *   container adjustment                 ->  letta e persistita, nessun movimento
 *
 * Le regole stanno nei due moduli PURI srv/lib/confMatDoc.js e srv/lib/plexConfSources.js, con i
 * loro test: è ciò che rende collaudabile senza sistemi esterni un flusso che ne tocca due.
 *
 * TRE SORGENTI, NON UNA. Lo scarto ha una API propria: `ScrapQuantity` smette di essere la costante
 * `0` che la 0009 dichiarava come limite dell'endpoint (RB-20). Non era un limite di Plex, era
 * l'endpoint sbagliato.
 *
 * LA FINESTRA HA MEMORIA (ZJobReadWatermark). Prima `beginDate` veniva da `MAX(EntryDate)` delle
 * righe persistite e una lettura fallita restituiva un array vuoto: il job non distingueva «Plex
 * non ha risposto» da «non c'era niente», il run chiudeva verde e quella finestra si perdeva. Ora
 * la fine della finestra si scrive SOLO se la lettura è riuscita: se fallisce, il run successivo
 * riprende da dov'era — quattro run falliti e il quinto chiede l'intervallo intero. E l'avvio a
 * freddo NON risale all'inizio dei tempi: parte da un'ora fa, mai prima
 * (srv/lib/plexConfWindow.js).
 *
 * NIENTE SI PERDE PIU' IN SILENZIO. Prima le registrazioni non risolvibili facevano `continue`
 * PRIMA dell'INSERT: non venivano persistite, e con una finestra che avanza sarebbero sparite. Ora
 * si persistono in QUARANTENA ('Q') e la loro risoluzione viene ritentata a ogni run: quando il job
 * Plex o il ciclo arrivano, l'arretrato si sblocca da solo.
 *
 * [PLEX-CONN] L'host Plex è per plant (feature 0020): il ciclo esterno sui plant è la struttura, e
 * ogni plant ha i propri watermark — uno per sorgente. Un plant che non risponde non ferma gli
 * altri, e non fa saltare la finestra a nessuno.
 *
 * >>> [MATDOC-FIX] SEI RIPARAZIONI, e la prima è la ragione per cui questo flusso non registrava
 * >>> NIENTE in SAP. Non movimenti sbagliati: zero movimenti. (feature 0027)
 *
 * U1 — L'OPERAZIONE SI RISOLVE PER NUMERO. `resolveSapOperation` confrontava
 *   `ZPlexCycleOperation.PlexOperationId` — l'id dell'operazione nel CATALOGO del tenant — con il
 *   `partOperationId` della registrazione, che è l'id della PART-OPERATION: due specie di UUID che
 *   non agganciano mai. Ogni production entry e ogni scrap entry finiva in quarantena e la fase che
 *   costruisce i documenti non veniva mai raggiunta. Il ponte è il NUMERO, come il modello già
 *   dichiarava (`ZProdConfPlexEntry.OperationNumber`, «è il RIPIEGO»: mai implementato). Le prove e
 *   i quattro esiti — e il perché un numero AMBIGUO si rifiuta invece di prendere la prima riga —
 *   stanno in srv/lib/prodConfOperationBridge.js.
 *
 * U2 — L'ANCORA DEL VERSAMENTO ESCLUDE LE OPERAZIONI CANCELLATE. L'ancora è il massimo del numero
 *   d'operazione: una sola operazione cancellata numerata più in alto di quella vera — una 0099
 *   lasciata da una modifica del ciclo — la spostava su di sé, e da lì OGNI registrazione di fine
 *   linea risultava «non è l'ultima» e finiva archiviata terminale, senza errore. Su dati SAP
 *   standard, non su un plant esotico. `OperationIsDeleted` è nel `$select` e in confMatDoc.
 *
 * U3 — UN DOCUMENTO AL TETTO DEI RETRY SI PARCHEGGIA. Prima lo si annunciava nel recap e si
 *   proseguiva: la riga restava 'E', veniva riselezionata a ogni run, consumava il tetto per
 *   esecuzione e la madre continuava a dire «in attesa di registrazione». Un rosso permanente che
 *   nessuno poteva togliere.
 *
 * U4 — IL VERSAMENTO NON PARTE PRIMA DEL CONSUMO. L'ordinamento dei candidati tentava il '03' per
 *   primo, ma i due giri erano indipendenti e tutte e quattro le combinazioni erano raggiungibili —
 *   compresa «entrata merci del prodotto senza uscita dei suoi componenti», che sbilancia l'ordine e
 *   che `refreshEntryStatus` rendeva indistinguibile da una registrazione mai inviata. Vale anche
 *   sull'esito NON CONCLUSIVO del '03' (DEC-60): là il movimento POTREBBE essere passato, e si
 *   aspetta un umano. Il rinvio non consuma un tentativo.
 *
 * U5 — LE NOTE NOMINANO I MATERIALI, E QUELLA CHE CONTA DEGRADA. «12 componenti senza materiale,
 *   senza fabbisogno o con quota sotto il millesimo» non permetteva di andare a guardare nulla, e le
 *   due cause hanno rimedi opposti. E il caso «nessuna riga di consumo» ora degrada il run: prima
 *   partiva il versamento da solo con una nota informativa, e il run chiudeva verde.
 *
 * U6 — IL TETTO PER ESECUZIONE NON PUÒ DARE INSIEME VUOTO. Con `PLEX_CONF_MAX_PER_RUN=1` e una
 *   registrazione che produce due documenti, il taglio sul confine di registrazione scendeva a zero
 *   e svuotava i candidati: ogni run chiudeva 'S' con zero registrazioni, per sempre. Un tetto messo
 *   per prudenza fermava tutto il flusso in silenzio.
 *
 * Perimetro delle sei: grep -rn "MATDOC-FIX"
 *
 * >>> [MATDOC-CLAIM] E POI: I MOVIMENTI DUPLICATI. Le sei riparazioni qui sopra hanno reso questo
 * >>> rischio ATTUALE — prima non si registrava niente, quindi non si poteva duplicare niente.
 *
 * `postMaterialDoc` veniva chiamato e SOLO DOPO la riga aggiornata. Due strade portavano a merce
 * scaricata due volte in SAP, che nessuno riconcilia: una morte del processo fra la chiamata e
 * l'aggiornamento (su CF lo shutdown ha 8 secondi) lasciava la riga 'E' e il run successivo
 * ripubblicava; e due run sovrapposti — uno scheduled e un `npm run` a mano — selezionavano gli
 * STESSI documenti. DEC-60 copriva solo l'esito non conclusivo dichiarato da SAP: ne' il crash ne'
 * la concorrenza.
 *
 * Ora la riga si PRENOTA prima di chiamare ('E' -> 'P'), e il perche' funzioni sta in una cosa che
 * il progetto aveva gia' verificato: fuori da un request context ogni `db.run` e' una
 * root-transaction che CAP committa da sola, quindi la prenotazione e' committata PRIMA della
 * chiamata. Una 'P' piu' vecchia della soglia e' un run morto e si parcheggia 'X' come l'esito non
 * conclusivo, perche' non si sa se SAP ha registrato e ritentare e' l'azione pericolosa. I candidati
 * si selezionano per 'E', quindi la concorrenza si risolve senza lock — e dove due run si
 * incrociano sugli INSERT, la collisione di chiave si TOLLERA invece di far cadere il run: un lock
 * stantio fermerebbe un flusso contabile, e un difetto che ferma e' peggio di uno che fa rumore.
 *
 * Le regole a secco e il perche' della forma stanno in srv/lib/matDocClaim.js.
 * Perimetro: grep -rn "MATDOC-CLAIM"
 *
 * Eseguito dal SAP BTP Job Scheduler tramite:
 *     node srv/jobs/postProdOrderConfirmation.js      (oppure `npm run job-prod-order-confirmation`)
 *
 * LEVE
 *   MATDOC_POST=off                 non manda nulla a SAP (i documenti restano 'E')
 *   PLEX_CONF_MAX_PER_RUN           tetto di DOCUMENTI per esecuzione (0 = illimitato). Un tetto più
 *                                   basso dei documenti di UNA registrazione viene sforato di
 *                                   proposito e dichiarato: vedi U6
 *   PLEX_CONF_COLD_START_MINUTES    quanto indietro parte la PRIMA lettura (60)
 *   PLEX_CONF_LOOKBACK_SECONDS      sovrapposizione fra due finestre (120)
 *   PLEX_CONF_WINDOW_MAX_HOURS      ampiezza massima di una lettura (24)
 *   PLEX_CONF_MAX_WINDOWS_PER_RUN   tetto di finestre per (sorgente, plant) per run; 0 = fino a
 *                                   `now`, ed e' il default
 *   PLEX_CONF_QUARANTINE_DAYS       entro quanti giorni si ritenta una 'Q' (30)
 *   MATDOC_PERMANENT_MESSAGES       messaggi SAP da trattare come definitivi (vuoto)
 *   MATDOC_INFLIGHT_STALE_MINUTES   da quanti minuti una prenotazione e' di un run morto (15)
 * Perimetro completo: grep -rn "MATDOC-CONF"
 */

const cds = require('@sap/cds');
const { resolveActivePlants, plexGet } = require('./lib/plexJobsClient');
// [PLEX-CONN] Connessione a Plex PER PLANT (feature 0020): una lettura per tenant.
const { resolvePlexConnection, PlexConnectionMissing } = require('../lib/plexConnection');
// [IS-SOURCE] Sorgente dell'area ordini (feature 0013): è il punto unico in cui si sceglie il
// canale di lettura verso SAP, e da qui vengono testata, operazioni e componenti dell'ordine.
const prodOrderSource = require('../lib/prodOrderSource');
const { operationsFilter, componentsFilter, keepOperationsOfOrder, keepComponentsOfOrder } =
  require('../lib/prodOrderSource');
// [MATDOC-CONF] Le tre letture Plex, la finestra a watermark, le regole dei documenti e la
// scrittura verso l'iFlow.
const { SOURCES, requestPath, asArray, fitPlexWidths } = require('../lib/plexConfSources');
const {
  resolveWindow, readWindowConfig, readFailureMessage, readFailureSegments
} = require('../lib/plexConfWindow');
const { buildDocuments, classifyFailure, readPermanentMessages, DOC_ISSUE, DOC_RECEIPT,
  DOC_CONFIRM } = require('../lib/confMatDoc');
// [CONF-OP-BRIDGE] Il ponte fra l'operazione Plex e quella SAP passa dal NUMERO, non dagli UUID:
// le due specie di id che il confronto precedente metteva a confronto non agganciavano mai.
const opBridge = require('../lib/prodConfOperationBridge');
// [MATDOC-CLAIM] La prenotazione di un documento prima di spedirlo: e' cio' che impedisce a una
// morte del processo, o a due run sovrapposti, di registrare due volte lo stesso movimento.
const claimRules = require('../lib/matDocClaim');
// [CONF-POSTING] Il customizing per plant dei consumi e degli scarti (feature 0028), e il dizionario
// delle part Plex letto al contrario, che serve al solo scarto di un pezzo gia' versato.
const { resolveConfPostingConfig } = require('../lib/confPostingConfig');
// [CONF-OP-BRIDGE] Le regole pure del canale. Serve `sapLinkFatal`: su `ProdPosting='CONF'` la
// conferma e' di TESTATA e non porta l'operazione, quindi un collegamento mancante non ferma la
// registrazione. La decisione sta la' e non qui, perche' ha quattro confini e un test suo.
const confRules = require('../lib/confPostingRules');
const { createPlexMatDictionary } = require('../lib/plexMatDictionary');
// [CONF-POSTING] L'albero Plex dell'ordine: e' l'asse su cui si misura il perimetro dei componenti
// quando il plant ha configurato «fino a questa operazione» o «a ogni operazione».
const { createPlexAllocationCache } = require('../lib/plexCycleAllocation');
const { postMaterialDoc } = require('../lib/materialDocPost');
// [CONF-POSTING] L'invio della CONFERMA d'ordine (feature 0030). Questo job e' l'unico chiamante di
// quel modulo: la sonda che gli viveva accanto e' stata rimossa, e con lei `isConfPostEnabled` —
// vedi il gate qui sotto.
const { postOrderConfirmation, classifyConfirmation } = require('../lib/prodOrderConfPost');
// [CONF-GROUP] Le conferme di uno stesso ordine partono in UNA chiamata per run (25/09/2026).
const groupRules = require('../lib/confGroupRules');
// [LOG-MSG-I18N] I messaggi sono segmenti (feature 0031). Il testo si rende qui, dove si scrive:
// in italiano per le colonne e per la mail, nella lingua di chi guarda alla lettura.
// [ORDER-LOG-OP] Lo storico invii dell'ORDINE: una registrazione contabile e' un'operazione su
// quell'ordine, e si vede da la' (feature 0031). Writer condiviso con l'invio job e il TECO.
const excLog = require('../lib/prodOrderExcLog');
const logMsg = require('../lib/logMessage');
const i18nMessages = require('../lib/i18nMessages');

const JOB_CODE = 'PROD_CONF';

const NS = 'avvaleplm.marsplm.sap2plex';
// Nomi entità fully-qualified: in contesto job standalone db.entities non è invocabile come
// funzione, si usano i nomi FQN come stringa nelle query CQL.
const E_ORDER_MAPPING = `${NS}.ZProdOrderPlexMapping`;
const E_CYCLE_OPERATION = `${NS}.ZPlexCycleOperation`;
const E_CONF_ENTRY = `${NS}.ZProdConfPlexEntry`;
const E_MAT_DOC = `${NS}.ZProdConfMatDoc`;
const E_WATERMARK = `${NS}.ZJobReadWatermark`;
const E_PLANT = `${NS}.ZPlant`;

// Tetto di DOCUMENTI per esecuzione (0 = illimitato). Il nome della variabile è quello storico
// perché è la stessa manopola; cambia l'unità, che ora è il documento — l'unità di invio.
const MAX_DOCS_PER_RUN = parseInt(process.env.PLEX_CONF_MAX_PER_RUN || '0', 10);

/** Entro quanti giorni si ritenta la risoluzione di una riga in quarantena. */
const QUARANTINE_DAYS = parseInt(process.env.PLEX_CONF_QUARANTINE_DAYS || '30', 10);
/**
 * Quante finestre al massimo puo' percorrere un run per (sorgente, plant). `0` = fino a `now`.
 *
 * NON serve alla terminazione — quella la garantisce `now` fissato una volta per run — serve a poter
 * fermare il recupero dall'ambiente senza un rilascio.
 */
const CONF_MAX_WINDOWS_PER_RUN = Math.max(
  0, parseInt(process.env.PLEX_CONF_MAX_WINDOWS_PER_RUN || '0', 10) || 0
);

/** Converte una data (Date | ISO string) in ISO 8601 UTC. */
function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : d.toISOString();
  } catch (e) {
    return String(value);
  }
}

const cut = (v, n) => String(v === null || v === undefined ? '' : v).slice(0, n);

/** Il testo di una lista di segmenti, in italiano: e' cio' che va nelle colonne e nella mail. */
const renderMsg = (segments) => i18nMessages.render(
  logMsg.normalize(segments), i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE
);

/** Testo + JSON di un messaggio, per le due colonne che vanno sempre insieme. */
const msgCols = (segments, textField = 'Message', jsonField = 'MessageJson') => {
  const segs = logMsg.normalize(segments);
  return { [textField]: cut(renderMsg(segs), 255), [jsonField]: logMsg.pack(segs) };
};

/** Tetto della colonna `ResponseJson`: e' LargeString, quindi il tetto e' nostro, non del DB. */
const RESPONSE_JSON_MAX = parseInt(process.env.PLEX_CONF_RESPONSE_MAX || '100000', 10);
/** Tetto di UN corpo dentro lo scambio: e' il campo che si stringe, non il JSON. */
const BODY_MAX = parseInt(process.env.PLEX_CONF_BODY_MAX || '20000', 10);

/**
 * [MATDOC-TRACE] Lo scambio con SAP, per intero, pronto per la colonna (feature 0031).
 *
 * PRIMA QUI C'ERA UN RIASSUNTO: esito, stato HTTP, numero documento, messaggio. Il corpo che SAP
 * aveva risposto, gli header e la diagnosi del 403 finivano solo su `console` — cioe' in `cf logs`,
 * che scade — e a posteriori, sull'unico flusso con effetti contabili, non erano piu' recuperabili.
 * Lo scambio arriva da `postMaterialDoc` gia' con gli HEADER MASCHERATI (`maskHeaders` in
 * srv/lib/materialDocPost.js), quindi persisterlo non espone segreti.
 *
 * I DUE CORPI SI STRINGONO, IL JSON NO. Tagliare il JSON a 100 000 caratteri lo renderebbe
 * illeggibile — il visualizzatore del cockpit ricadrebbe sul testo grezzo — quindi si accorciano i
 * campi lunghi e si DICHIARA, che e' la stessa regola di `logMessage.pack`: mai una struttura a
 * metà.
 */
function clampBody(value, max = BODY_MAX) {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return null;
  return s.length <= max ? s : `${s.slice(0, max)}\n… [troncato: ${s.length} caratteri in tutto]`;
}

/**
 * [ORDER-LOG-OP] La riga di storico di una registrazione verso SAP (feature 0031).
 *
 * SI SCRIVE SOLO QUANDO LA CHIAMATA E' PARTITA DAVVERO. I casi in cui non parte —
 * `ConfPostEnabled` non acceso, configurazione illeggibile, retry al limite, payload
 * illeggibile, prenotazione non ottenuta, registrazione in quarantena — non lasciano riga: nello
 * storico di un ordine ci va cio' che al suo ordine E' STATO FATTO, e una chiamata mai partita non
 * e' un'operazione. Quei casi restano nel recap del job, che e' il posto delle cose che riguardano
 * l'esecuzione e non l'oggetto.
 *
 * LA PROVA DI VALIDAZIONE (`TestRun`) INVECE SCRIVE: SAP e' stato interrogato e ha risposto, ed e'
 * la risposta che su questo repo non e' mai stata osservata — nasconderla sarebbe perdere l'unica
 * occasione di vederla.
 *
 * UN DOCUMENTO SENZA ORDINE non ha uno storico in cui andare: lo scarto di un pezzo gia' versato non
 * cita nessun ordine (DEC-91), e il writer condiviso lo scarta restituendo `null`. Il recap lo
 * dichiara comunque.
 *
 * @returns {Promise<number|null>} il Counter della riga, per il `LogRef` del recap
 */
async function writeOrderExcLog(db, doc, { isConf, status, segments, r, response }) {
  return excLog.appendProdOrderLog(db, {
    order: doc.ManufacturingOrder,
    operation: isConf ? excLog.OPERATION.CONF : excLog.OPERATION.MATDOC,
    status,
    segments,
    // Un passo solo, ed e' la chiamata: `request` e' il payload che il documento portava — lo stesso
    // che `postMaterialDoc` ha spedito — e `response` lo scambio intero, header mascherati compresi.
    steps: [{
      step: isConf ? 'order-confirmation' : `material-document ${doc.GoodsMovementCode || ''}`.trim(),
      request: safeParse(doc.RequestJson),
      status: Number.isFinite(r && r.httpStatus) ? r.httpStatus : null,
      response: safeParse(response)
    }]
    // `updateHeader` assente: la testata dell'ordine resta «l'ultimo invio del job».
  });
}

/** Un JSON che si legge, o il testo cosi' com'e': un corpo illeggibile e' un dato, non un errore. */
function safeParse(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return v; }
}

function exchangeJson(r) {
  const x = r || {};
  const exchange = {
    // Prima cio' che serve a capire l'esito, poi cio' che serve a riprodurlo.
    outcome: x.outcome, httpStatus: x.httpStatus, ms: x.ms,
    materialDocument: x.materialDocument, materialDocumentYear: x.materialDocumentYear,
    confirmationGroup: x.confirmationGroup, confirmationCount: x.confirmationCount,
    // [CONF-OUTCOME] I due campi con cui la conferma d'ordine dichiara il proprio esito dal
    // 02/09/2026 — l'ordine restituito e il testo, che su un rifiuto porta il motivo — piu' QUALE
    // regola ha deciso (`outcomeRule`: dal 25/09/2026 sempre `orderid`; `keys` resta sulle righe
    // scritte prima, quando sull'eco completa decidevano le chiavi) e se
    // il rifiuto e' DICHIARATO. Stanno qui perche' questo oggetto e' cio' che si rilegge mesi dopo
    // dalla scheda dell'ordine: senza la regola, un esito senza chiavi non e' interpretabile, e
    // senza il testo il motivo del rifiuto vivrebbe solo nel `cf logs` del run che lo ha ricevuto.
    orderIdReturned: x.orderIdReturned, confirmationText: x.confirmationText,
    outcomeRule: x.outcomeRule, declaredRejected: x.declaredRejected,
    inconclusive: x.inconclusive,
    messageType: x.messageType, messageId: x.messageId, messageNumber: x.messageNumber,
    messageRow: x.messageRow, message: x.message, warn: x.warn,
    reason: x.reason, error: x.error,
    // Le chiavi con cui il team Integration apre l'esecuzione nel monitor di Cloud Integration.
    mplId: x.mplId, correlationId: x.correlationId,
    url: x.url, destination: x.destination, path: x.path,
    testRun: x.testRun, testRunSource: x.testRunSource, itemCount: x.itemCount, plants: x.plants,
    rowCount: x.rowCount, rowsWithKeys: x.rowsWithKeys, responseShape: x.responseShape,
    csrf: x.csrf, csrfTokenObtained: x.csrfTokenObtained,
    requestHeaders: x.requestHeaders || null,
    responseHeaders: x.responseHeaders || null,
    requestBody: clampBody(x.requestBody),
    responseBody: clampBody(x.responseBody)
  };
  const out = JSON.stringify(exchange, null, 2);
  if (out.length <= RESPONSE_JSON_MAX) return out;
  // Ultima difesa: si buttano i due corpi, che sono il volume, e lo si dice. Il JSON resta valido.
  return JSON.stringify({
    ...exchange,
    requestBody: '[non conservato: lo scambio eccedeva il tetto della colonna]',
    responseBody: '[non conservato: lo scambio eccedeva il tetto della colonna]'
  }, null, 2);
}

// =============================================================================================
// IL WATERMARK
// Regole in srv/lib/plexConfWindow.js (puro, con test). Qui c'è solo la persistenza.
// =============================================================================================

async function readWatermark(db, sourceCode, plant) {
  return db.run(
    SELECT.one.from(E_WATERMARK).where({ JobCode: JOB_CODE, SourceCode: sourceCode, Plant: plant })
  );
}

/**
 * Crea la riga di watermark PRIMA della chiamata a Plex, col seme di avvio a freddo.
 *
 * E' il punto che rende il primo run identico a tutti gli altri: se lo si scrivesse dopo, un primo
 * tentativo fallito lascerebbe la sorgente senza watermark, il run successivo ricalcolerebbe il
 * seme da `now` e la finestra scivolerebbe in avanti — perdendo esattamente l'intervallo che il
 * tentativo fallito non ha letto.
 */
async function seedWatermark(db, sourceCode, plant, seed, now) {
  await db.run(INSERT.into(E_WATERMARK).entries({
    JobCode: JOB_CODE,
    SourceCode: sourceCode,
    Plant: plant,
    WindowEnd: toIso(seed),
    LastAttemptAt: now.toISOString(),
    LastSuccessAt: null,
    FailureCount: 0,
    LastMessage: 'avvio a freddo: watermark inizializzato prima della prima lettura',
    UpdatedAt: now.toISOString()
  }));
}

/** Lettura riuscita: la finestra avanza alla sua FINE (non a `now`: con il tetto non coincidono). */
async function advanceWatermark(db, sourceCode, plant, endDate, now, message) {
  await db.run(UPDATE(E_WATERMARK).set({
    WindowEnd: endDate,
    LastAttemptAt: now.toISOString(),
    LastSuccessAt: now.toISOString(),
    FailureCount: 0,
    LastMessage: cut(message, 255),
    UpdatedAt: now.toISOString()
  }).where({ JobCode: JOB_CODE, SourceCode: sourceCode, Plant: plant }));
}

/** Lettura fallita: `WindowEnd` NON si tocca. È tutto il meccanismo di ripresa. */
async function failWatermark(db, sourceCode, plant, now, failureCount, message) {
  await db.run(UPDATE(E_WATERMARK).set({
    LastAttemptAt: now.toISOString(),
    FailureCount: failureCount,
    LastMessage: cut(message, 255),
    UpdatedAt: now.toISOString()
  }).where({ JobCode: JOB_CODE, SourceCode: sourceCode, Plant: plant }));
}

// =============================================================================================
// RISOLUZIONE DI UNA REGISTRAZIONE: Plex -> ordine, operazione, plant SAP
// =============================================================================================

/**
 * Risolve l'ordine SAP a partire dal jobId Plex (dizionario ZProdOrderPlexMapping).
 *
 * La query è un filtro su colonna NON chiave e resta invariata anche dopo la chiave composta
 * introdotta dalla feature 0012 (D5): la riga di un pacchetto porta lo STESSO ManufacturingOrder
 * del lotto principale, quindi una registrazione fatta su un pacchetto torna sull'ordine
 * principale per costruzione (FR-38). L'unico invariante da sorvegliare è la molteplicità: due
 * righe con lo stesso PlexJobId renderebbero la SELECT non deterministica. Non può accadere (ogni
 * job Plex ha un id proprio) e per questo si logga soltanto, senza fallire.
 */
async function resolveSapOrder(db, jobId) {
  if (!jobId) return null;
  const rows = await db.run(
    SELECT.from(E_ORDER_MAPPING).columns('ManufacturingOrder', 'PlexJobNumber')
      .where({ PlexJobId: jobId }).limit(2)
  );
  if (!rows || !rows.length) return null;
  if (rows.length > 1) {
    console.warn(
      `>>> [ANOMALIA] PlexJobId ${jobId} presente su ${rows.length} righe di ZProdOrderPlexMapping: `
      + `si usa ${rows[0].ManufacturingOrder}/${rows[0].PlexJobNumber}`
    );
  }
  return rows[0].ManufacturingOrder ? rows[0] : null;
}

/**
 * [CONF-OP-BRIDGE] Operazione SAP dal NUMERO d'operazione Plex (dizionario ZPlexCycleOperation).
 *
 * PRIMA confrontava `PlexOperationId` con il `partOperationId` della registrazione: due UUID di
 * specie diversa — l'id dell'operazione di CATALOGO contro l'id della PART-OPERATION — che non
 * agganciavano mai. Ogni registrazione finiva in quarantena e questo flusso non registrava niente
 * in SAP. Il perché, le prove e i quattro esiti stanno in srv/lib/prodConfOperationBridge.js.
 *
 * Il `limit(2)` è quello che permette di RILEVARE l'ambiguità senza leggere righe inutili: due
 * bastano a sapere che ce n'è più di una, e la regola è che una chiave ambigua si rifiuta.
 */
async function resolveSapOperation(db, manufacturingOrder, operationNumber) {
  const num = opBridge.bridgeNumber(operationNumber);
  if (num === null) return opBridge.resolveOperationRow([], { operationNumber, manufacturingOrder });
  const rows = await db.run(
    SELECT.from(E_CYCLE_OPERATION).columns(...opBridge.BRIDGE_COLUMNS)
      .where({ ManufacturingOrder: manufacturingOrder, OperationNumber: num }).limit(2)
  );
  return opBridge.resolveOperationRow(rows, { operationNumber, manufacturingOrder });
}

/**
 * Cache dell'ordine per RUN: testata, operazioni e componenti.
 *
 * Molte registrazioni condividono lo stesso ordine, e senza cache la fase B farebbe tre letture
 * SAP per registrazione. La cache vive quanto il run: non è un TTL da sorvegliare.
 *
 * NON LANCIA. Distingue le due cause che altrimenti collasserebbero su `null`, come la 0013 (V3,
 * caso limite 24): «non ho potuto leggere» è un guasto e la registrazione resta da elaborare;
 * «l'ordine non c'è» è un difetto del dato.
 */
function createOrderCache(s4prod) {
  const cache = new Map();
  return async function loadOrder(orderId) {
    if (cache.has(orderId)) return cache.get(orderId);
    const { A_ProductionOrder_2, A_ProductionOrderOperation_2, A_ProductionOrderComponent_2 } =
      s4prod.entities;
    const out = { order: null, operations: [], components: [], error: null, notes: [] };
    try {
      // 1. La testata. In IS porta l'AUFPL e la prenotazione, che sono i SOLI criteri contrattati
      //    sulle due letture figlie: sono tre letture, non una (DEC-42, DEC-43, DEC-45).
      // [ORDER-TOP] Il tetto non e' un dettaglio su QUESTA lettura. La chiave e' completa ma non
      // c'e' `SELECT.one`, quindi la query va sul `_QUERYGET`: senza `$top` quel root rende `200`
      // con zero righe da quando `IV_TOP` esiste lato ABAP (01/09/2026), e zero righe qui NON
      // finiscono in `out.error` — finiscono in `out.order = null`, cioe' nel ramo «l'ordine non
      // c'e'», che e' un difetto del dato e non un guasto. Il flusso con effetti contabili avrebbe
      // archiviato registrazioni buone dando la colpa a SAP.
      //
      // L'instradamento NON si cambia in `SELECT.one`, e non si passa da `readOrderHeader`: quella
      // funzione collassa «non ho potuto leggere» e «l'ordine non c'e'» in `order: null`, cioe'
      // proprio la distinzione che questa cache tiene in piedi con il try/catch qui sotto. E il
      // `_GET` consegna un `$select` diverso: senza AUFPL e prenotazione le due letture figlie non
      // hanno criterio.
      const heads = await s4prod.run(
        SELECT.from(A_ProductionOrder_2).columns(
          'ManufacturingOrder', 'Material', 'ProductionPlant', 'StorageLocation', 'ProductionUnit',
          'TotalQuantity', 'OrderInternalBillOfOperations', 'MasterProductionOrder'
        ).where({ ManufacturingOrder: orderId }).limit(prodOrderSource.HEADER_MAX_ROWS)
      );
      out.order = (Array.isArray(heads) ? heads[0] : heads) || null;
    } catch (e) {
      out.error = `lettura testata ordine non riuscita: ${e.message}`;
      cache.set(orderId, out);
      return out;
    }
    if (!out.order) {
      cache.set(orderId, out);
      return out;
    }

    // 2. Le operazioni: servono a sapere QUAL E' L'ULTIMA, cioè se questa registrazione genera
    //    movimenti. `null` = lettura non eseguibile su questo canale: si dichiara, non si tenta.
    const opWhere = operationsFilter(s4prod.mode, out.order);
    if (!opWhere) {
      out.error = 'AUFPL assente sulla testata: in IS è il solo criterio contrattato, le operazioni '
        + 'non sono leggibili su questo canale';
    } else {
      try {
        const rows = await s4prod.run(
          SELECT.from(A_ProductionOrderOperation_2).columns(
            // [MATDOC-FIX] `OperationIsDeleted` serve all'ancora del versamento: una sola
            // operazione cancellata numerata più in alto di quella vera spostava l'ancora su di sé
            // e archiviava in silenzio ogni registrazione di fine linea. È fra i 15 campi che
            // l'iFlow consegna, quindi si può chiedere su entrambi i canali.
            'ManufacturingOrder', 'ManufacturingOrderOperation', 'OperationIsReleased',
            'OperationIsDeleted', 'OperationUnit'
            // [ORDER-TOP] Il tetto: stessa RFC, stesso difetto. Un elenco di operazioni vuoto
            // sposterebbe l'ancora del versamento e archivierebbe la registrazione in silenzio.
          ).where(opWhere).limit(prodOrderSource.DETAIL_MAX_ROWS.operations)
        );
        const kept = keepOperationsOfOrder(s4prod.mode, out.order, rows);
        out.operations = kept.kept;
        if (kept.dropped) out.notes.push(`${kept.dropped} operazioni di altri ordini scartate a valle`);
      } catch (e) {
        out.error = `lettura operazioni non riuscita: ${e.message}`;
      }
    }

    // 3. I componenti: le righe del 261. Stessa struttura, stesso trattamento del `null`.
    const compWhere = componentsFilter(s4prod.mode, out.order);
    if (!compWhere) {
      out.notes.push('prenotazione assente sulla testata: in IS è il solo criterio contrattato, i '
        + 'componenti non sono leggibili su questo canale');
    } else {
      try {
        const rows = await s4prod.run(
          SELECT.from(A_ProductionOrderComponent_2).columns(
            'ManufacturingOrder', 'Reservation', 'ReservationItem', 'Material', 'Plant',
            'StorageLocation', 'RequiredQuantity', 'BaseUnit', 'ManufacturingOrderOperation'
            // [ORDER-TOP] Il tetto: sono le righe del 261, e senza `$top` non ne arriva nessuna.
          ).where(compWhere).limit(prodOrderSource.DETAIL_MAX_ROWS.components)
        );
        const kept = keepComponentsOfOrder(s4prod.mode, out.order, rows);
        out.components = kept.kept;
        if (kept.dropped) out.notes.push(`${kept.dropped} componenti di altri ordini scartati a valle`);
      } catch (e) {
        // Un guasto sui componenti NON è come uno sulle operazioni: senza operazioni non si sa
        // nemmeno se la registrazione debba muovere qualcosa, senza componenti si sa che deve e
        // non si sa cosa. Entrambi bloccano, ed entrambi si dichiarano.
        out.error = out.error || `lettura componenti non riuscita: ${e.message}`;
      }
    }

    cache.set(orderId, out);
    return out;
  };
}

/**
 * Traduce una registrazione Plex in ordine + operazione + plant SAP.
 *
 * IL PLANT DI UNA RIGA IN QUARANTENA E' QUELLO DEL TENANT, e non è un dettaglio: fino al 09/09/2026
 * ogni ramo di quarantena tornava `plant: null`, coerente con DEC-117 — il plant è un *esito* della
 * risoluzione — ma `ZProdConfPlexEntry` sta nel gate per plant della 0048, che aggiunge a ogni READ
 * un `Plant IN (<licenziati>, '#NA')`. Su `NULL` quel predicato non è soddisfatto: la riga, **con la
 * ragione scritta dentro**, era invisibile a qualunque lettura OData e a qualunque utente. Le due
 * entity gemelle (`ZProdOrderCompleteState`, `ZProdOrderScheduledState`) portano il plant del tenant
 * proprio per questo, e il commento accanto al gate lo dichiara; qui la garanzia mancava.
 * I due plant restano concetti diversi: quello del tenant dice DOVE si è letto, quello risolto DI CHI
 * è l'ordine — e alla risoluzione riuscita il secondo sovrascrive il primo.
 *
 * @param {object} db
 * @param {function} loadOrder la cache delle testate (`createOrderCache`)
 * @param {object} e la registrazione mappata (`plexConfSources`)
 * @param {string} sourcePlant il plant del TENANT su cui è stata letta
 * @param {{prodPosting: string, readOk: boolean}} [channel] il canale del plant. **Assente = nessuna
 *   esenzione**: `sapLinkFatal` nasce fail-closed, quindi un innesco nuovo che dimenticasse di
 *   passarlo si comporta come prima e non come se il plant fosse a `CONF`.
 * @returns {{status: 'E'|'Q'|'I', orderId, plexJobNumber, operation, plant, unit, reason,
 *            fault: boolean, linkExempt: string|null}}
 *   `fault: true` distingue il GUASTO (sorgente irraggiungibile) dal DIFETTO DEL DATO: il primo
 *   va dichiarato nel recap come errore, il secondo campionato come avviso. Con la sorgente giù,
 *   prima si vedeva «plant non risolvibile» su ogni registrazione e la causa era un'altra.
 *   `linkExempt` porta la causa del ponte che è stata ESENTATA, e serve a dichiararla: senza, il
 *   giorno in cui un plant passa da `CONF` a `MATDOC` quelle righe diventano inadeguate in silenzio.
 */
async function resolveEntry(db, loadOrder, e, sourcePlant, channel) {
  // [CONF-POSTING] LA REGISTRAZIONE SENZA LOTTO non è un mapping che manca (feature 0028).
  //
  // Il contratto Plex dichiara `jobId` opzionale, e per uno SCARTO l'assenza è il discriminante del
  // pezzo già versato: i componenti li ha già addebitati il 101, quindi si scarica il solo prodotto
  // e senza riferimento all'ordine. Prima quelle righe finivano al guardiano dell'id (la chiave
  // conteneva la stringa `undefined`) o in quarantena con «jobId non presente in
  // ZProdOrderPlexMapping» — un mapping che non poteva esistere, ritentato per trenta giorni e poi
  // abbandonato. In entrambi i casi SAP non veniva informato, e il run chiudeva verde.
  //
  // Il PLANT è quello del tenant su cui la registrazione è stata letta, e qui è la risoluzione: il
  // pezzo è stato scartato in quel plant. È l'unica riga in cui `sourcePlant` diventa il plant della
  // registrazione, e per questo il ramo NON si applica alla ri-risoluzione della quarantena, che non
  // sa su quale tenant la riga fu letta (vedi il guardiano in requeueQuarantined).
  if (!String(e.jobId || '').trim()) {
    if (e.sourceType === 'S') {
      return {
        status: 'E', orderId: null, plexJobNumber: null, operation: null, plant: sourcePlant,
        unit: null, fault: false, cause: 'NO_JOB', linkExempt: null,
        segments: [logMsg.seg('logConfScrapNoJob')]
      };
    }
    // Una registrazione di PRODUZIONE senza lotto non è attribuibile a nessun ordine: non ha una
    // distinta da consumare né un ordine su cui versare. Terminale, e dichiarato.
    return {
      status: 'I', orderId: null, plexJobNumber: null, operation: null, plant: sourcePlant,
      unit: null, fault: false, cause: 'NO_JOB', linkExempt: null,
      segments: [logMsg.seg('logConfProdNoJob')]
    };
  }

  const mapping = await resolveSapOrder(db, e.jobId);
  const orderId = mapping?.ManufacturingOrder || null;
  const plexJobNumber = mapping?.PlexJobNumber || null;
  if (!orderId) {
    return {
      status: 'Q', orderId: null, plexJobNumber: null, operation: null, plant: sourcePlant,
      unit: null, fault: false, cause: 'NO_JOB_MAPPING', linkExempt: null,
      segments: [logMsg.seg('logConfJobNotMapped', e.jobId)]
    };
  }

  // [CONF-OP-BRIDGE] Per NUMERO, non per UUID. La causa viene dal modulo puro e non si riscrive
  // qui: e' quella che il recap raggruppa senza dover confrontare frasi.
  //
  // IL PONTE SI CHIAMA SEMPRE, anche dove il collegamento non serve: dove c'e' si risolve e si
  // persiste (`OrderOperation` sulla riga), ed e' cio' che rende questa correzione reversibile senza
  // aver perso dati. Cambia solo se la sua ASSENZA e' fatale, e quella decisione ha quattro confini
  // che stanno in `confRules.sapLinkFatal` — non qui.
  const op = await resolveSapOperation(db, orderId, e.operationNumber);
  let linkExempt = null;
  if (!op.operation) {
    const fatal = confRules.sapLinkFatal({
      cause: op.cause,
      sourceType: e.sourceType,
      prodPosting: channel && channel.prodPosting,
      configReadOk: !!(channel && channel.readOk)
    });
    if (fatal) {
      return {
        status: 'Q', orderId, plexJobNumber, operation: null, plant: sourcePlant, unit: null,
        fault: false, cause: op.cause, linkExempt: null,
        segments: op.segments
      };
    }
    // Esente: la conferma d'ordine e' di testata e non manda l'operazione. Si prosegue con
    // `operation` nullo, e la causa si porta dietro per DICHIARARLA (vincolo 3 del piano).
    linkExempt = op.cause;
  }
  const operation = op.operation;

  const info = await loadOrder(orderId);
  if (info.error) {
    return {
      status: 'Q', orderId, plexJobNumber, operation, plant: sourcePlant, unit: null, fault: true,
      linkExempt,
      // Errore di lettura verso SAP: testo di terzi, non si traduce.
      segments: [logMsg.technical(info.error)]
    };
  }
  if (!info.order || !info.order.ProductionPlant) {
    return {
      status: 'Q', orderId, plexJobNumber, operation, plant: sourcePlant, unit: null, fault: false,
      cause: 'NO_PLANT', linkExempt,
      segments: [logMsg.seg('logConfNoPlant', orderId)]
    };
  }

  const plant = info.order.ProductionPlant;
  // [PLEX-CONN] L'ordine risolto dev'essere del plant di cui si sta leggendo il tenant. Con un
  // tenant per plant questo non è un caso normale: o due plant condividono il tenant (contro il
  // presupposto della 0020), o un job Plex è stato creato sul tenant sbagliato. Terminale: non è
  // una risoluzione che possa riuscire più tardi.
  if (sourcePlant && plant !== sourcePlant) {
    return {
      status: 'I', orderId, plexJobNumber, operation, plant, unit: null, fault: false,
      foreign: plant, linkExempt,
      segments: [logMsg.seg('logConfForeignPlant', sourcePlant, plant)]
    };
  }

  return {
    status: 'E', orderId, plexJobNumber, operation, plant,
    unit: info.order.ProductionUnit || null, fault: false, linkExempt,
    segments: linkExempt
      // L'esenzione si dichiara sulla RIGA, non solo nel recap: è il messaggio che una persona
      // legge aprendo la registrazione, e dice perché l'operazione SAP è vuota.
      ? [logMsg.seg('logConfLinkNotRequired'), ...logMsg.normalize(op.segments)]
      : [logMsg.seg('logConfToProcess')]
  };
}

// =============================================================================================
// FASE A — lettura e persistenza, per plant e per sorgente
// =============================================================================================

/**
 * Legge UNA FINESTRA di UNA sorgente sul tenant di UN plant e persiste ciò che ha letto.
 *
 * L'ordine dei passi è la garanzia: watermark seminato -> lettura -> ingest -> watermark avanzato.
 * L'ultimo passo avviene SOLO se i due precedenti sono riusciti, ed è ciò che rende una selezione
 * fallita un rinvio invece di una perdita.
 *
 * UNA finestra per invocazione, e il tetto di 24 ore resta quello della CHIAMATA. Il giro che porta
 * il punto di ripresa fino a `now` è del chiamante (`ingestAllPlants`): con una finestra per run e
 * un'esecuzione notturna, `span = 24h + 2min` è comunque oltre il tetto, quindi si perdevano DUE
 * MINUTI al giorno che non tornavano più — e un giorno di fermo diventava un giorno di movimenti
 * merci mai registrati. Vedi `catchUpSource` e il difetto gemello di ORDER_COMPLETE del 09/09/2026.
 *
 * `resumeAt` è dove è rimasto il punto di ripresa, e si valorizza in TUTTI i casi: la fine della
 * finestra letta se la lettura è riuscita, il `WindowEnd` invariato se è caduta.
 */
async function ingestSource(ctx, source, plant, creds) {
  const { db, loadOrder, summary, now, windowCfg } = ctx;
  // `truncated` sono le righe in cui almeno un valore Plex e' stato tagliato alla larghezza di
  // colonna: non degradano il run ma si dichiarano, perche' un valore tagliato non corrisponde
  // piu' a quello di Plex e se il contratto e' cambiato va saputo.
  const out = {
    ingested: 0, duplicates: 0, quarantined: 0, ignored: 0, truncated: 0,
    readOk: false, resumeAt: null
  };
  const truncNotes = new Map();   // «quali campi» -> quante volte

  let wm = await readWatermark(db, source.code, plant);
  // La continuità serve solo a freddo, e solo alle production entries: sono le uniche che hanno
  // righe storiche in tabella da cui riprendere.
  let fallbackFrom = null;
  if (!wm && source.sourceType === 'P') {
    const last = await db.run(
      SELECT.one.from(E_CONF_ENTRY).columns('EntryDate')
        .where({ Plant: plant, SourceType: 'P' }).orderBy('EntryDate desc')
    );
    fallbackFrom = last?.EntryDate || null;
  }

  const window = resolveWindow({ watermark: wm, now, fallbackFrom, cfg: windowCfg });
  if (window.coldStart) {
    // PRIMA della chiamata: vedi seedWatermark.
    await seedWatermark(db, source.code, plant, window.seed, now);
    wm = { WindowEnd: toIso(window.seed) };
    if (summary) {
      summary.scope({
        plant, objectKey: `COLD_START/${source.code}`, status: 'W', degrade: false,
        segments: [
          logMsg.seg('logConfColdStart', source.label, window.beginDate),
          // Il MOTIVO del seme e' prosa del modulo puro (`coldStartSeed.from`) e non e' ancora a
          // segmenti: lacuna dichiarata, non silenziosa (grep logMsgVerbatim).
          logMsg.verbatim(window.reason)
        ]
      });
    }
  }
  console.log(`>>> [MATDOC-CONF] plant ${plant} · ${source.code}: ${window.beginDate} -> ${window.endDate} (${window.reason})`);

  // `plexGet` RITORNA `{ok:false}` su HTTP non-2xx ma LANCIA su errore di rete (fetch rifiuta:
  // host irraggiungibile, DNS, TLS, timeout). Le due cose sono la stessa notizia — quella finestra
  // non è stata letta — e devono finire nello stesso ramo: se l'eccezione risalisse, il watermark
  // non avanzerebbe comunque, ma `FailureCount` resterebbe fermo e il recap direbbe «errore
  // generico» invece di «questa sorgente non risponde dal terzo run».
  let r;
  try {
    r = await plexGet(creds, requestPath(source, window));
  } catch (e) {
    r = { ok: false, status: 0, body: null, thrown: e };
  }
  if (!r.ok) {
    const failureCount = (wm?.FailureCount || 0) + 1;
    const message = readFailureMessage({
      sourceCode: source.code, failureCount, now,
      windowEnd: wm?.WindowEnd,
      error: r.thrown ? `errore di rete: ${r.thrown.message}` : `HTTP ${r.status}`
    });
    await failWatermark(db, source.code, plant, now, failureCount, message);
    console.error(`>>> [MATDOC-CONF] plant ${plant} · ${message}`);
    // La lettura non riuscita è un GUASTO, non un difetto del dato: il run non deve chiudere 'S'.
    // Il TESTO sta sul watermark (stato della sorgente, si legge in italiano dal supporto), i
    // SEGMENTI nella riga di recap, che si legge da schermata: due colonne diverse, non due sorgenti
    // per la stessa colonna.
    if (summary) {
      summary.scope({
        plant,
        objectKey: `READ/${source.code}`,
        status: 'E',
        segments: readFailureSegments({
          sourceCode: source.code, failureCount, now, windowEnd: wm?.WindowEnd,
          error: r.thrown ? `errore di rete: ${r.thrown.message}` : `HTTP ${r.status}`
        })
      });
    }
    // Il punto di ripresa e' rimasto dov'era: `failWatermark` non tocca `WindowEnd`, ed e' tutto il
    // meccanismo per cui il blocco caduto si richiede al run successivo.
    out.resumeAt = toIso(wm?.WindowEnd);
    return out;
  }
  out.readOk = true;

  const entries = asArray(r.body);
  console.log(`>>> [MATDOC-CONF] plant ${plant} · ${source.code}: ${entries.length} record ricevuti`);

  // Il campionamento degli avvisi di risoluzione. Le righe in quarantena vengono RITENTATE a ogni
  // run: una riga POS per ciascuna significherebbe la stessa mail a ogni esecuzione finché il
  // difetto non si ripara, e un destinatario che smette di leggerle. I CONTATORI restano esatti.
  const sampleLimit = parseInt(process.env.PLEX_SUMMARY_SKIP_SAMPLE || '50', 10);
  const sampled = new Map();
  const sampleWarn = (reason, dedupKey, payload) => {
    if (!summary) return;
    if (!sampled.has(reason)) sampled.set(reason, new Set());
    const seen = sampled.get(reason);
    if (seen.size >= sampleLimit || seen.has(dedupKey)) return;
    seen.add(dedupKey);
    summary.record({ objectType: 'CONF_ENTRY', status: 'W', ...payload });
  };
  const faults = new Map();       // causa -> conteggio, per i guasti (aggregati, non campionati)
  const foreignPlants = new Map();
  // [CONF-OP-BRIDGE] Le esenzioni dal collegamento all'operazione SAP, per causa: si DICHIARANO.
  const linkExempt = new Map();
  // [MATDOC-CONF] LE RAGIONI DELLA QUARANTENA, per causa, con il PRIMO oggetto fermo.
  //
  // Esistono perché il 09/09/2026 due registrazioni si sono fermate e il log diceva «in quarantena
  // 2»: un numero, senza ragione e senza oggetto. La ragione era scritta in due posti — sulla riga
  // e nel recap — e nessuno dei due si legge da `cf logs`, che finché `MARS_MAIL` non esiste è
  // l'unico canale che arriva a una persona. Il conteggio dice QUANTE, il nome dice QUAL E': è la
  // lezione dell'addendum del 07/09 alla DEC-124, e nominarle tutte non entrerebbe in una riga.
  const qCauses = new Map();

  // [CONF-OP-BRIDGE] Il canale del plant serve GIA' IN FASE A, perché decide se un collegamento
  // mancante ferma la registrazione. Una lettura per plant per run — `resolveConfPostingConfig` ha
  // la sua cache — e `readOk` è ciò che rende l'esenzione fail-closed: con la configurazione
  // illeggibile non si sa qual è il canale, e allora vale il comportamento di prima.
  const confCfg = await resolveConfPostingConfig(db, plant);
  const channel = { prodPosting: confCfg.ProdPosting, readOk: !confCfg.readError };

  for (const raw of entries) {
    const e = source.map(raw);
    // [CONF-POSTING] Il guardiano non scarta più una registrazione solo perché non ha un LOTTO: il
    // lotto è normalizzato nella chiave (plexConfSources.jobKeyPart) e la sua assenza è un caso
    // previsto dal contratto. Quello che resta qui è ciò che il guardiano deve davvero fermare — un
    // `partOperationId`, un numero di serie o una data mancanti, cioè l'identità del record. E
    // `null` ci entra accanto a `undefined`: prima passava, e la riga finiva in quarantena con un
    // motivo che parlava d'altro.
    if (!e.plexEntryId || e.plexEntryId.includes('undefined') || e.plexEntryId.includes('null')) {
      out.ignored++;
      sampleWarn('no-id', String(out.ignored), {
        plant, objectKey: '(record senza id)',
        segments: [logMsg.seg('logConfEntryNoId', source.code, cut(e.plexEntryId, 60))]
      });
      continue;
    }

    // Dedup: la finestra si sovrappone di proposito (lookback), quindi i doppioni sono attesi.
    // Una riga già presente NON si tocca: potrebbe essere in retry o già registrata.
    const existing = await db.run(
      SELECT.one.from(E_CONF_ENTRY).columns('PlexEntryId').where({ PlexEntryId: e.plexEntryId })
    );
    if (existing) { out.duplicates++; continue; }

    // Le rettifiche non hanno un ordine: si persistono 'I' senza tentare una risoluzione che non
    // ha senso. Quale movimento SAP debbano diventare non è stato deciso, e sceglierlo qui
    // significherebbe scrivere movimenti contabili a caso.
    let res;
    if (!source.producesDocuments) {
      res = {
        status: 'I', orderId: null, plexJobNumber: null, operation: null, plant, unit: null,
        fault: false, segments: [logMsg.seg('logConfAdjustmentIgnored')]
      };
    } else {
      res = await resolveEntry(db, loadOrder, e, plant, channel);
    }

    // [CONF-OP-BRIDGE] L'esenzione si conta per CAUSA, e vale su qualunque esito: una riga esentata
    // che poi si fermi altrove (plant estraneo, testata illeggibile) è comunque una riga passata
    // senza collegamento, e il conteggio non deve dipendere da dove è arrivata.
    if (res.linkExempt) {
      linkExempt.set(res.linkExempt, (linkExempt.get(res.linkExempt) || 0) + 1);
    }

    if (res.status === 'Q') {
      out.quarantined++;
      // La causa per stdout, col primo oggetto fermo. `FAULT` per i guasti: là la causa non è nostra
      // e il testo di terzi non entra in una riga di riepilogo.
      const qKey = res.fault ? 'FAULT' : (res.cause || 'Q');
      if (!qCauses.has(qKey)) {
        qCauses.set(qKey, { n: 0, order: res.orderId || String(e.jobId || '?'), op: e.operationNumber });
      }
      qCauses.get(qKey).n++;
      if (res.fault) {
        // Il guasto si raggruppa per TESTO, perche' e' un errore di terzi e non ha una causa nostra:
        // il testo reso e' l'unica chiave disponibile.
        const key = renderMsg(res.segments);
        const prev = faults.get(key);
        faults.set(key, { n: (prev ? prev.n : 0) + 1, segments: res.segments });
      } else {
        // [MATDOC-FIX] Il gruppo di campionamento è la CAUSA, non le prime 40 lettere del motivo.
        // Prima il motivo cominciava con il `partOperationId`, quindi ogni registrazione formava un
        // gruppo per conto suo e il tetto di campionamento non teneva niente insieme: il recap
        // riempiva la mail di righe che dicevano tutte la stessa cosa. Con il codice i gruppi sono
        // pochi e fissi, e il tetto fa quello per cui esiste.
        // [LOG-MSG-I18N] Con i segmenti la causa e' SEMPRE un codice: il ripiego sulle prime 40
        // lettere del motivo non serve piu' — era proprio la frase che rendeva i gruppi inutili.
        sampleWarn(res.cause || (res.segments && res.segments[0] && res.segments[0].c) || 'Q',
          `${e.jobId}|${e.partOperationId}`, {
            plant, objectKey: e.plexEntryId, objectKey2: res.orderId || String(e.jobId),
            segments: [logMsg.seg('logConfQuarantined'), ...logMsg.normalize(res.segments)]
          });
      }
    } else if (res.status === 'I') {
      out.ignored++;
      if (res.foreign) foreignPlants.set(res.foreign, (foreignPlants.get(res.foreign) || 0) + 1);
    }

    // [MATDOC-CLAIM] Stessa tolleranza dell'INSERT dei documenti: la dedup qui sopra non e' atomica,
    // quindi due run sovrapposti possono leggere la stessa finestra e provare a inserire la stessa
    // registrazione. La chiave primaria lo impedisce; senza questo `try` l'ingest dell'intero plant
    // cadeva e il suo watermark non avanzava.
    // [PLEX-HISTORY-WIDTH] La riga si compone, poi si fa STARE nelle colonne. Vedi fitPlexWidths.
    const entryRow = {
      PlexEntryId: e.plexEntryId,
      SourceType: e.sourceType,
      JobId: e.jobId || null,
      PlexJobNumber: res.plexJobNumber,
      PartOperationId: e.partOperationId || null,
      WorkcenterId: e.workcenterId || null,
      ManufacturingOrder: res.orderId,
      OrderOperation: res.operation,
      // [PLANT-ACCESS] IL PLANT C'E' SEMPRE, e fino al 09/09/2026 non era così: su una riga in
      // quarantena restava nullo — «il plant è un esito della risoluzione» (DEC-117) — e il gate per
      // plant della 0048 la rendeva invisibile a QUALUNQUE lettura, con la ragione scritta dentro.
      // Ora `resolveEntry` torna il plant del TENANT su ogni quarantena: vedi la sua testata. Quando
      // la risoluzione riesce è quello dell'ORDINE, e i due non si confondono.
      Plant: res.plant,
      YieldQuantity: e.yieldQuantity,
      ScrapQuantity: e.scrapQuantity,
      ReworkQuantity: e.reworkQuantity,
      // [PLEX-HISTORY-WIDTH] NIENTE RIPIEGO sul `unit` di Plex. Arriva fino a 20 caratteri e non è
      // un'unità SAP: da qui finiva nel documento materiale come `EntryUnit`, dove SAP lo
      // rifiuterebbe — e su HANA non ci arrivava nemmeno, perché la colonna è `String(3)`.
      // L'unità è quella dell'ORDINE; se l'ordine non ce l'ha resta vuota e lo si vede.
      ConfirmationUnit: res.unit || null,
      IsFinalConfirmation: false,
      ExecutionStart: toIso(e.entryDate),
      ExecutionEnd: toIso(e.entryDate),
      EntryDate: toIso(e.entryDate) || now.toISOString(),
      SerialNo: e.serialNo || null,
      PartNumber: e.partNumber || null,
      // [CONF-POSTING] L'aggancio al materiale SAP quando l'ordine non c'è (feature 0028).
      PlexPartId: e.partId || null,
      OperationNumber: e.operationNumber,
      OperationCode: e.operationCode || null,
      LotNo: e.lotNo || null,
      HeatNo: e.heatNo || null,
      TrackingNo: e.trackingNo || null,
      ShelfDateTime: toIso(e.shelfDateTime),
      ManufacturedDateTime: toIso(e.manufacturedDateTime),
      ScrapReason: e.scrapReason || null,
      TransactionType: e.transactionType || null,
      AdjustmentCode: e.adjustmentCode || null,
      PlexLocation: e.plexLocation || null,
      NetWeight: e.netWeight,
      Status: res.status,
      // [LOG-MSG-I18N] Testo e segmenti insieme: il testo e' lo snapshot italiano, i segmenti sono
      // cio' che la scheda «Consuntivi» rende nella lingua di chi guarda.
      ...msgCols(res.segments),
      RetryCount: 0,
      RawJson: JSON.stringify(raw),
      CreatedAt: now.toISOString(),
      UpdatedAt: now.toISOString()
    };
    const fitted = fitPlexWidths(entryRow);
    if (fitted.truncated.length) {
      // Si dichiara: un valore tagliato è un dato che non corrisponde più a quello di Plex, e se il
      // contratto è cambiato va saputo. Non degrada il run — la registrazione entra ed è elaborabile.
      out.truncated++;
      truncNotes.set(fitted.truncated.join(', '),
        (truncNotes.get(fitted.truncated.join(', ')) || 0) + 1);
    }
    try {
      await db.run(INSERT.into(E_CONF_ENTRY).entries(fitted.row));
      if (res.status === 'E') out.ingested++;
    } catch (err) {
      const clash = await db.run(
        SELECT.one.from(E_CONF_ENTRY).columns('PlexEntryId').where({ PlexEntryId: e.plexEntryId })
      );
      if (!clash) throw err;      // non e' una corsa: e' un guasto, e non si nasconde
      out.duplicates++;
    }
  }

  if (summary) {
    for (const [, f] of faults) {
      summary.scope({
        plant, objectKey: `FAULT/${source.code}`, status: 'E',
        segments: [logMsg.seg('logConfFaultQuarantined', f.n), ...logMsg.normalize(f.segments)]
      });
    }
    for (const [campi, n] of truncNotes) {
      summary.scope({
        plant, objectKey: `TRUNCATED/${source.code}`, status: 'W', degrade: false,
        segments: [logMsg.seg('logConfTruncated', n, campi)]
      });
    }
    for (const [foreign, n] of foreignPlants) {
      summary.scope({
        plant, objectKey: 'PLANT_MISMATCH', status: 'W',
        segments: [logMsg.seg('logConfPlantMismatch', n, plant, foreign)]
      });
    }
    // [CONF-OP-BRIDGE] L'esenzione si DICHIARA, e NON degrada: su un plant a conferma d'ordine è il
    // caso normale. Serve al giorno in cui quel plant passasse a `MATDOC` — là quelle righe
    // diventano inadeguate, e chi guarda deve poterlo sapere prima di scoprirlo da una quarantena.
    let esenti = 0;
    for (const [, n] of linkExempt) esenti += n;
    if (esenti) {
      summary.scope({
        plant, objectKey: 'CONF_LINK_NOT_REQUIRED', status: 'W', degrade: false,
        segments: [logMsg.seg('logConfLinkExempt', esenti)]
      });
    }
  }

  // [MATDOC-CONF] LA QUARANTENA SU STDOUT: vedi `qCauses`. Va DOPO i contatori del recap e prima del
  // watermark, ed è `console.warn` perché una riga ferma è un'attenzione — non un dettaglio.
  if (qCauses.size) {
    const dett = [...qCauses]
      .map(([c, v]) => `${c} ${v.n} (es. ${v.order}${v.op == null ? '' : ` op ${v.op}`})`)
      .join(' · ');
    console.warn(`>>> [MATDOC-CONF] plant ${plant} · ${source.code}: `
      + `${out.quarantined} in quarantena — ${dett}`);
  }
  if (linkExempt.size) {
    console.log(`>>> [CONF-OP-BRIDGE] plant ${plant} · ${source.code}: `
      + `${[...linkExempt].map(([c, n]) => `${c} ${n}`).join(' · ')} risolte SENZA collegamento `
      + 'all\'operazione SAP (canale conferma d\'ordine: il collegamento non e\' richiesto)');
  }

  // >>> IL PASSO CHE CHIUDE IL GIRO. Solo qui, e solo se tutto sopra è andato.
  await advanceWatermark(db, source.code, plant, window.endDate, now,
    `${entries.length} record letti · nuove ${out.ingested} · duplicate ${out.duplicates}`);

  // L'ARRETRATO NON SI DICHIARA QUI: lo dichiara `catchUpSource` UNA volta, sul residuo vero alla
  // fine del giro. Da qui dentro si vedrebbe l'arretrato di QUESTA finestra, e su un run che poi lo
  // recupera tutto sarebbe un numero che non significa niente — con `degrade: false`, cioe' un
  // plant indietro che chiude verde e muto: e' il difetto del 09/09/2026 su ORDER_COMPLETE.
  out.resumeAt = window.endDate;
  return out;
}

/** Perché il giro si è fermato, per la riga di log. Non è un'enumerazione di dominio. */
const STOP_REASON = {
  now: 'arrivato a adesso',
  read: 'lettura caduta: il blocco si richiede al prossimo run',
  cap: 'tetto di finestre per run',
  stuck: 'la finestra non avanza: giro interrotto',
  noResume: 'nessun punto di ripresa leggibile'
};

/**
 * IL GIRO DELLE FINESTRE per una (sorgente, plant): un run arriva a `now`.
 *
 * Gemello di `catchUpPlant` in srv/jobs/completeSapOrdersFromPlex.js, e le due copie NON si fondono:
 * l'unità qui è la coppia (sorgente, plant) — il watermark ha `SourceCode` in chiave — i contatori
 * da accumulare sono cinque invece di zero, e il tetto della chiamata è 24 ore e non 2. Un modulo
 * condiviso dovrebbe prendere in argomento tutte e tre le differenze, cioè sarebbe il ciclo scritto
 * due volte con un'astrazione in mezzo.
 *
 * LE QUATTRO USCITE, e la prima è l'invariante da non rompere:
 *  1. `readOk === false` -> SI FERMA. Un blocco di tempo che non si è potuto leggere non si perde e
 *     non si scavalca: `failWatermark` non tocca `WindowEnd`, quindi il run successivo RICHIEDE LO
 *     STESSO BLOCCO. Proseguire il giro qui farebbe avanzare la finestra oltre righe che nessuno ha
 *     visto — su un flusso con effetti contabili, movimenti merci mai registrati.
 *  2. il punto di ripresa ha raggiunto `now` -> finito, ed è l'uscita normale.
 *  3. il punto di ripresa NON AVANZA -> guardia anti-ciclo: senza, un run che non termina.
 *  4. tetto `PLEX_CONF_MAX_WINDOWS_PER_RUN`.
 *
 * Il confronto è su `endDate` e non su `capped`: sono la stessa cosa solo finché nessuno accorcia la
 * finestra dopo averla calcolata.
 */
async function catchUpSource(ctx, source, plant, creds) {
  const { now, summary } = ctx;
  const totals = {
    ingested: 0, duplicates: 0, quarantined: 0, ignored: 0, truncated: 0,
    readOk: false, windows: 0
  };
  let resumeAt = null;
  let stoppedBy = 'now';

  for (;;) {
    const r = await ingestSource(ctx, source, plant, creds);
    totals.windows += 1;
    totals.ingested += r.ingested;
    totals.duplicates += r.duplicates;
    totals.quarantined += r.quarantined;
    totals.ignored += r.ignored;
    totals.truncated += r.truncated;
    // `readOk` del GIRO è quello dell'ultima finestra tentata: una lettura caduta a metà giro deve
    // contare come lettura fallita anche se le prime erano andate.
    totals.readOk = r.readOk;

    const before = resumeAt ? Date.parse(resumeAt) : NaN;
    if (r.resumeAt) resumeAt = r.resumeAt;

    if (!r.readOk) { stoppedBy = 'read'; break; }
    const end = Date.parse(resumeAt || '');
    if (!Number.isFinite(end)) { stoppedBy = 'noResume'; break; }
    if (Number.isFinite(before) && end <= before) { stoppedBy = 'stuck'; break; }
    if (end >= now.getTime()) { stoppedBy = 'now'; break; }
    if (CONF_MAX_WINDOWS_PER_RUN > 0 && totals.windows >= CONF_MAX_WINDOWS_PER_RUN) {
      stoppedBy = 'cap'; break;
    }
  }

  const at = Date.parse(resumeAt || '');
  const residual = Number.isFinite(at) ? Math.max(0, Math.round((now.getTime() - at) / 60000)) : 0;
  console.log(`>>> [MATDOC-CONF] plant ${plant} · ${source.code}: giro chiuso — ${totals.windows} `
    + `finestre, punto di ripresa ${resumeAt || '(invariato)'}, arretrato residuo ${residual} min `
    + `(${STOP_REASON[stoppedBy] || stoppedBy})`);

  // L'arretrato residuo DEGRADA: con il giro che arriva a `now` è zero a ogni run, quindi un numero
  // diverso da zero significa che il giro si è fermato prima — e le cause hanno rimedi diversi.
  if (residual > 0 && summary) {
    summary.scope({
      plant, objectKey: `BACKLOG/${source.code}`, status: 'W', degrade: true,
      segments: [logMsg.seg('logConfBacklog', source.label, residual)]
    });
  }
  if ((stoppedBy === 'stuck' || stoppedBy === 'noResume') && summary) {
    console.error(`>>> [MATDOC-CONF] plant ${plant} · ${source.code}: giro interrotto dalla `
      + `guardia (${stoppedBy}): punto di ripresa ${resumeAt || 'assente'}`);
    summary.scope({
      plant, objectKey: `READ/${source.code}`, status: 'E',
      segments: [
        logMsg.seg('logConfIngestFailed', source.label),
        logMsg.technical(`giro delle finestre interrotto dalla guardia (${stoppedBy}): punto di `
          + `ripresa ${resumeAt || 'assente'} dopo ${totals.windows} finestre`)
      ]
    });
  }
  return totals;
}

/**
 * FASE A su tutti i plant utilizzabili e tutte le sorgenti.
 *
 * Un plant senza connessione configurata NON ferma gli altri: si dichiara e si prosegue. È lo
 * stesso trattamento del plant con licenza scaduta, e passa da `scope()` perché non è un oggetto
 * trattato (DEC-39). Idem per una sorgente che lancia: le altre due devono comunque essere lette.
 */
async function ingestAllPlants(ctx, usablePlants) {
  const { db, summary } = ctx;
  const totals = { ingested: 0, duplicates: 0, quarantined: 0, ignored: 0, truncated: 0, reads: 0, readFailures: 0 };
  for (const plant of usablePlants) {
    let creds;
    try {
      creds = await resolvePlexConnection(plant, { db });
    } catch (e) {
      if (!(e instanceof PlexConnectionMissing)) throw e;
      console.error(`>>> [PLEX-CONN] plant ${plant}: nessuna connessione configurata, nessuna lettura`);
      if (summary) {
        summary.scope({
          plant, segments: [logMsg.seg('logConfPlantNoConnection')]
        });
      }
      continue;
    }
    for (const source of SOURCES) {
      totals.reads++;
      try {
        // IL GIRO DELLE FINESTRE, non una finestra sola: vedi `catchUpSource`.
        const r = await catchUpSource(ctx, source, plant, creds);
        totals.ingested += r.ingested;
        totals.duplicates += r.duplicates;
        totals.quarantined += r.quarantined;
        totals.ignored += r.ignored;
        totals.truncated += r.truncated;
        if (!r.readOk) totals.readFailures++;
      } catch (e) {
        totals.readFailures++;
        console.error(`>>> [MATDOC-CONF] plant ${plant} · ${source.code}: ingest fallito: ${e.message}`);
        if (summary) {
          summary.scope({
            plant, objectKey: `READ/${source.code}`, status: 'E',
            segments: [
              logMsg.seg('logConfIngestFailed', source.label), logMsg.technical(e.message)
            ]
          });
        }
      }
    }
  }
  console.log(`>>> [MATDOC-CONF] ingest: nuove ${totals.ingested}, duplicate ${totals.duplicates},`
    + ` in quarantena ${totals.quarantined}, ignorate ${totals.ignored},`
    + ` letture fallite ${totals.readFailures}/${totals.reads}`);
  return totals;
}

// =============================================================================================
// FASE A-bis — la quarantena si ri-risolve
// =============================================================================================

/**
 * Ritenta la risoluzione delle righe 'Q'.
 *
 * E' ciò che rende la quarantena una sala d'attesa invece di un cimitero: quando il job Plex crea
 * il mapping mancante, o il ciclo viene salvato, o la sorgente SAP torna su, la riga si sblocca da
 * sola al primo run utile. Senza, l'unico modo di recuperarla sarebbe rileggerla da Plex — cioè
 * proprio ciò che il watermark non fa più.
 *
 * Le righe più vecchie di PLEX_CONF_QUARANTINE_DAYS non si ritentano: un difetto che non si è
 * riparato in un mese non si ripara al run successivo, e continuare a interrogare SAP per ognuna
 * a ogni esecuzione costa senza servire. Restano 'Q' e vengono contate, non dimenticate.
 */
async function requeueQuarantined(ctx) {
  const { db, loadOrder, summary, now } = ctx;
  const cutoff = new Date(now.getTime() - QUARANTINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const out = { requeued: 0, stillQuarantined: 0, stale: 0, noPlant: 0 };

  const stale = await db.run(
    SELECT.from(E_CONF_ENTRY).columns('count(*) as n')
      .where({ Status: 'Q', CreatedAt: { '<': cutoff } })
  );
  out.stale = (Array.isArray(stale) ? stale[0]?.n : stale?.n) || 0;

  const rows = await db.run(
    SELECT.from(E_CONF_ENTRY).where({ Status: 'Q', CreatedAt: { '>=': cutoff } })
  );

  // [CONF-OP-BRIDGE] Il canale, una lettura per plant per run. `resolveConfPostingConfig` ha la sua
  // cache, ma la riga di plant vuoto non deve nemmeno provarci: senza plant non c'è un canale, e
  // `readOk: false` è ciò che tiene l'esenzione fail-closed.
  const channels = new Map();
  const channelOf = async (p) => {
    const key = String(p || '').trim();
    if (!key) return { prodPosting: '', readOk: false };
    if (!channels.has(key)) {
      const cfg = await resolveConfPostingConfig(db, key);
      channels.set(key, { prodPosting: cfg.ProdPosting, readOk: !cfg.readError });
    }
    return channels.get(key);
  };

  /**
   * [CONF-OP-BRIDGE] IL PLANT DEL CANALE DI UNA RIGA IN QUARANTENA — e perché non è `row.Plant`.
   *
   * Le righe scritte PRIMA del 09/09/2026 portano `Plant` NULL: tutti e quattro i rami di quarantena
   * di `resolveEntry` tornavano `plant: null`, di proposito, perché il plant è un esito della
   * risoluzione (DEC-117) — dimenticando che i plant sono DUE, e che quello del TENANT si conosce
   * sempre. Leggendo il canale da là, `channelOf('')` rende `readOk: false` e l'esenzione non scatta:
   * la correzione dell'addendum del 09/09 alla DEC-88 non arriva proprio alle righe che l'hanno
   * motivata. Il run delle 13:56 su quality lo ha misurato: «sbloccate 0, ancora ferme 5».
   *
   * IL RIPIEGO NON E' UN'IPOTESI, ed è la ragione per cui è preferibile a un backfill che il plant
   * lo sceglierebbe: è il plant dell'ORDINE su cui la registrazione andrà a finire — lo stesso che la
   * fase B usa per costruire e per inviare (`Plant: { in: [...usablePlants] }`), e lo stesso che
   * all'ingest il presidio [PLEX-CONN] pretende UGUALE a quello del tenant. Se l'ordine non si
   * risolve non si ripiega su niente: una riga senza ordine non ha un canale, e vale il
   * comportamento di prima.
   *
   * IL COSTO SI DICHIARA, o il prossimo lettore lo «ottimizza»: su una riga senza plant la lettura di
   * `ZProdOrderPlexMapping` avviene DUE volte — qui e dentro `resolveEntry`. Si accetta perché la
   * colonna ha il suo indice nativo, perché riguarda le sole righe in quarantena, e perché
   * l'alternativa sarebbe cambiare la firma di `resolveEntry` per farsi passare il mapping già
   * risolto, cioè toccare anche la fase A. La testata viene dalla cache di `loadOrder`: nessuna
   * chiamata verso SAP in più.
   */
  const channelPlantOf = async (row) => {
    if (String(row.Plant || '').trim()) return row.Plant;
    const mapping = await resolveSapOrder(db, row.JobId);
    if (!mapping || !mapping.ManufacturingOrder) return null;
    const info = await loadOrder(mapping.ManufacturingOrder);
    return (info && info.order && info.order.ProductionPlant) || null;
  };

  for (const row of rows) {
    // Si ripercorre la STESSA risoluzione della fase A, con i dizionari di adesso. Il plant del
    // tenant non si può ricontrollare (la riga non ricorda su quale tenant fu letta), quindi il
    // presidio [PLEX-CONN] qui non si applica: è già stato applicato all'ingest.
    // [CONF-OP-BRIDGE] `operationNumber` va passato, o la ri-risoluzione userebbe `undefined` e
    // ogni riga in quarantena resterebbe ferma con «numero operazione assente» — cioè la
    // quarantena tornerebbe il cimitero che DEC-59 le ha tolto di essere.
    // [CONF-OP-BRIDGE] Il CANALE serve anche qui, o la correzione del 09/09/2026 non arriverebbe
    // alle righe già in quarantena — cioè proprio a quelle che si vogliono sbloccare. Il plant da
    // cui leggerlo lo decide `channelPlantOf`: quello della RIGA dove c'è, quello dell'ORDINE sulle
    // righe storiche che nascevano col plant nullo. `sourcePlant` resta `null` di proposito: è
    // un'altra cosa — «su quale tenant ho letto» — e ha il suo guardiano qui sotto.
    const res = await resolveEntry(db, loadOrder, {
      jobId: row.JobId,
      partOperationId: row.PartOperationId,
      operationNumber: row.OperationNumber,
      // [CONF-POSTING] La sorgente serve al ramo «senza lotto», che tratta uno scarto in modo
      // diverso da una produzione. Senza, una riga storica senza lotto verrebbe letta come una
      // produzione — cioè archiviata invece di restare dov'è.
      sourceType: row.SourceType
    }, null, await channelOf(await channelPlantOf(row)));
    if (res.status !== 'E') { out.stillQuarantined++; continue; }
    // [CONF-POSTING] Una riga in quarantena non ricorda su quale TENANT fu letta, quindi per uno
    // scarto senza lotto il plant resta ignoto — e la fase B seleziona per plant: sbloccarla la
    // renderebbe INVISIBILE invece di elaborabile. Resta in quarantena, e si dichiara. Le righe
    // nuove non passano da qui: all'ingest il plant del tenant si conosce.
    if (!res.plant) { out.noPlant++; out.stillQuarantined++; continue; }
    await db.run(UPDATE(E_CONF_ENTRY).set({
      ManufacturingOrder: res.orderId,
      PlexJobNumber: res.plexJobNumber,
      OrderOperation: res.operation,
      Plant: res.plant,
      ConfirmationUnit: res.unit || row.ConfirmationUnit,
      Status: 'E',
      Message: 'risolta dalla quarantena: da elaborare',
      UpdatedAt: now.toISOString()
    }).where({ PlexEntryId: row.PlexEntryId }));
    out.requeued++;
  }

  if (summary) {
    if (out.requeued) {
      summary.scope({
        objectKey: 'QUARANTINE_REQUEUED', status: 'W', degrade: false,
        segments: [logMsg.seg('logConfQuarantineRequeued', out.requeued)]
      });
    }
    if (out.stillQuarantined) {
      summary.scope({
        objectKey: 'QUARANTINE_PENDING', status: 'W',
        segments: [logMsg.seg('logConfQuarantinePending', out.stillQuarantined)]
      });
    }
    if (out.noPlant) {
      summary.scope({
        objectKey: 'QUARANTINE_NO_PLANT', status: 'W',
        segments: [logMsg.seg('logConfQuarantineNoPlant', out.noPlant)]
      });
    }
    if (out.stale) {
      summary.scope({
        objectKey: 'QUARANTINE_STALE', status: 'W',
        segments: [logMsg.seg('logConfQuarantineStale', out.stale, QUARANTINE_DAYS)]
      });
    }
  }
  console.log(`>>> [MATDOC-CONF] quarantena: sbloccate ${out.requeued}, ancora ferme `
    + `${out.stillQuarantined}, oltre il termine ${out.stale}`);
  return out;
}

// =============================================================================================
// FASE B1 — dalle registrazioni ai documenti
// =============================================================================================

/**
 * Costruisce i documenti materiale delle registrazioni 'E' che non ne hanno ancora.
 *
 * Separata dall'invio di proposito: una registrazione può avere documenti costruiti e non ancora
 * spediti (invio fallito al run precedente), e ricostruirli ogni volta significherebbe perdere il
 * loro contatore di retry — cioè non uscire mai dal ciclo.
 */
/**
 * Scrive le righe di ZProdConfMatDoc di una registrazione. Restituisce quante ne ha scritte.
 *
 * [MATDOC-CLAIM] La collisione di chiave si TOLLERA, invece di far cadere il run. Due run
 * sovrapposti possono costruire i documenti della stessa registrazione: la lettura che precede non
 * e' atomica, quindi la corsa esiste. La chiave primaria (PlexEntryId, DocSeq) impedisce il doppione
 * — quindi non c'e' nessun rischio contabile — ma l'INSERT che perde la corsa sollevava un'eccezione
 * che faceva fallire l'intero run.
 *
 * E' PREFERIBILE a un lock di esecuzione: un lock stantio FERMEREBBE un flusso contabile, e un
 * difetto che ferma e' peggio di uno che fa rumore. Qui il perdente si accoda e prosegue.
 *
 * [CONF-POSTING] Il documento di CONFERMA (DocSeq 3) non ha righe ne' codice di movimento: il suo
 * payload sta sotto `confirmation`, e il ramo d'invio lo riconosce da `DocSeq`.
 */
async function insertDocuments(db, row, documents, now, out) {
  let scritti = 0;
  for (const d of documents) {
    try {
      await db.run(INSERT.into(E_MAT_DOC).entries({
        PlexEntryId: row.PlexEntryId,
        DocSeq: d.docSeq,
        GoodsMovementCode: d.goodsMovementCode,
        Plant: d.plant || row.Plant,
        ManufacturingOrder: d.manufacturingOrder,
        ItemCount: Array.isArray(d.items) ? d.items.length : 0,
        Status: 'E',
        FailureClass: null,
        RetryCount: 0,
        TestRun: false,
        InFlightAt: null,
        InFlightRun: null,
        MaterialDocument: null,
        MaterialDocumentYear: null,
        ConfirmationGroup: null,
        ConfirmationCount: null,
        MessageType: null,
        MessageText: null,
        // Il payload in forma NATURALE: la codifica in letterali XSD la fa il modulo d'invio a
        // valle. Serve a poter rileggere cosa si è deciso di mandare, non cosa è partito.
        RequestJson: JSON.stringify(d.confirmation
          ? { confirmation: d.confirmation }
          : { header: d.header, items: d.items }, null, 2),
        ResponseJson: null,
        CreatedAt: now.toISOString(),
        UpdatedAt: now.toISOString()
      }));
      out.documents++;
      scritti++;
    } catch (e) {
      // La riga c'è: l'ha scritta un altro run, e va bene. Se NON c'è, l'INSERT è fallito per
      // un'altra ragione, e quella non si nasconde.
      const clash = await db.run(
        SELECT.one.from(E_MAT_DOC).columns('DocSeq')
          .where({ PlexEntryId: row.PlexEntryId, DocSeq: d.docSeq })
      );
      if (!clash) throw e;
      out.raced++;
    }
  }
  return scritti;
}

async function buildPendingDocuments(ctx, usablePlants) {
  const { db, loadOrder, summary, now, matDict, plexAlloc } = ctx;
  // `raced` sono i documenti che un run sovrapposto aveva gia' scritto: la chiave primaria li ha
  // impediti, quindi non e' un problema — ma si conta, perche' e' il segnale che due run girano.
  // [CONF-POSTING] `filled` sono i documenti aggiunti a registrazioni che ne avevano già altri (un
  // run interrotto a metà); `channelMixed` le registrazioni lasciate stare perché il canale
  // configurato ora è diverso da quello dei documenti che hanno già.
  const out = { built: 0, documents: 0, ignored: 0, blocked: 0, raced: 0, filled: 0, channelMixed: 0 };
  // [RUN-BLOCKED] Le registrazioni che non si sono potute costruire perche' la TESTATA DELL'ORDINE
  // non e' arrivata da SAP, per plant. Sono dentro `out.blocked` — che pero' conta anche le attese
  // legittime («un dato che manca») — e fino alla DEC-124 finivano solo la' dentro, cioe' in un
  // numero dentro una `note`, che non degrada: un `A_ProductionOrder_2` giu' per un run intero
  // chiudeva il recap in verde. Si aggregano per plant e non per registrazione, come i `faults`
  // della fase di risoluzione: la causa e' UNA lettura, e una riga per registrazione ne farebbe
  // trecento per lo stesso guasto.
  const orderReadFail = new Map();
  if (!usablePlants.size) return out;

  // [CONF-POSTING] La configurazione si legge UNA VOLTA PER PLANT PER RUN (feature 0028). Il lettore
  // ha una cache propria con TTL, ma quella e' la rete di sicurezza del server web: qui la mappa
  // locale garantisce che tutte le registrazioni di un run vedano la STESSA configurazione, che e'
  // cio' che rende leggibile il recap.
  const configs = new Map();
  const configFor = async (plant) => {
    const key = String(plant || '');
    if (!configs.has(key)) {
      const cfg = await resolveConfPostingConfig(db, key);
      configs.set(key, cfg);
      // `ProdPosting` VA PER PRIMO, ed è l'unico dei sei che mancava: è il campo che decide se una
      // produzione diventa 261+101 o una conferma d'ordine — e dal 09/09/2026 anche se il
      // collegamento all'operazione SAP è richiesto. Per un'indagine su una registrazione è il primo
      // dato da guardare, e leggerlo era possibile solo dal database.
      console.log(`>>> [CONF-POSTING] plant ${key}: ProdPosting=${cfg.ProdPosting}`
        + ` ConsumeAt=${cfg.ConsumeAt}`
        + ` ScrapConsume=${cfg.ScrapConsume} ScrapMove=${cfg.ScrapMove} ScrapIssue=${cfg.ScrapIssue}`
        + ` ScrapNoOrder=${cfg.ScrapNoOrder}${cfg.configured ? '' : ' (non configurato: come prima)'}`
        + (cfg.readError ? ` — LETTURA FALLITA: ${cfg.readError}` : ''));
      if (cfg.readError && summary) {
        // Il default e' il comportamento di prima, quindi il run non si ferma — ma un plant
        // configurato che si comporta come non configurato non deve essere indistinguibile da un
        // plant non configurato.
        summary.scope({
          plant: key, objectKey: 'CONF_POSTING_READ', status: 'W',
          segments: [
            logMsg.seg('logConfPostingUnreadable'), logMsg.technical(cut(cfg.readError, 120))
          ]
        });
      }
    }
    return configs.get(key);
  };
  // Le cause degli esiti senza documenti, aggregate per CODICE: il motivo e' una frase con dentro
  // numeri d'ordine, quindi raggrupparlo per testo darebbe un gruppo per registrazione.
  const causes = new Map();
  const noteCause = (cause, plant) => {
    const key = `${plant || '-'}|${cause || 'IGNOTA'}`;
    causes.set(key, (causes.get(key) || 0) + 1);
  };
  // Le part Plex non risolvibili si NOMINANO, ma con un tetto: il motivo e' lo stesso per tutte le
  // registrazioni della stessa part, e senza tetto una part sconosciuta con 500 scarti riempirebbe la
  // mail di righe identiche. Dieci nomi bastano per andare a guardare; il CONTEGGIO completo resta
  // nella riga di causa (SCRAP_NO_MATERIAL), che non ha tetto.
  const DICT_NAMED_MAX = 10;
  const dictNamed = new Set();
  // Gli ordini il cui albero e' stato dichiarato: una riga per ordine, non per registrazione.
  const allocNoted = new Set();

  const rows = await db.run(
    SELECT.from(E_CONF_ENTRY).where({ Status: 'E', Plant: { in: [...usablePlants] } })
  );
  for (const row of rows) {
    // [CONF-POSTING] SI GUARDA QUALI DOCUMENTI CI SONO, NON SE CE N'E' UNO (feature 0030).
    //
    // Prima bastava una riga qualunque e la costruzione si saltava: una registrazione rimasta con
    // il solo '03' — un run morto fra i due INSERT — non riceveva MAI il suo '02', cioe' componenti
    // usciti e prodotto mai versato, per sempre e senza una riga di recap. Ora si completa
    // l'insieme che manca.
    //
    // MA I DUE CANALI NON SI MESCOLANO SULLA STESSA REGISTRAZIONE. Se un plant passa a `CONF`
    // mentre ha documenti di movimento ancora da inviare, aggiungere la conferma manderebbe in SAP
    // il 261+101 E la conferma: merce mossa due volte. Si dichiara e si lascia stare — l'arretrato
    // si fa drenare prima di cambiare canale.
    const esistenti = await db.run(
      SELECT.from(E_MAT_DOC).columns('DocSeq', 'Status').where({ PlexEntryId: row.PlexEntryId })
    ) || [];
    const haveSeq = new Set(esistenti.map((d) => d.DocSeq));

    // Il canale del plant si legge PRIMA della testata dell'ordine: è una lettura locale e cachata,
    // e serve alle due uscite qui sotto — che così non costano nessuna lettura verso SAP.
    const config = await configFor(row.Plant);

    if (haveSeq.size) {
      // I DUE CANALI NON SI MESCOLANO. Il canale voluto si sa dalla configurazione, senza costruire
      // niente: la produzione di un plant a `CONF` non deve affiancarsi a documenti di movimento.
      const vuoleConferma = config.ProdPosting === 'CONF' && row.SourceType === 'P';
      const haMovimenti = haveSeq.has(DOC_ISSUE) || haveSeq.has(DOC_RECEIPT);
      if ((vuoleConferma && haMovimenti) || (haveSeq.has(DOC_CONFIRM) && !vuoleConferma)) {
        out.channelMixed++;
        noteCause('CHANNEL_SWITCH', row.Plant);
        if (summary) {
          summary.scope({
            plant: row.Plant, objectKey: `BUILD/${row.ManufacturingOrder || row.PlexEntryId}`,
            status: 'W',
            segments: [logMsg.seg(
              'logConfChannelSwitch', [...haveSeq].join(','), config.ProdPosting
            )]
          });
        }
        continue;
      }
      // INSIEME CERTAMENTE COMPLETO: la conferma è un documento solo, e '03' + '02' sono i due che
      // una produzione può produrre. Uscire qui evita di rileggere la testata dell'ordine a ogni run
      // per ogni registrazione in attesa di invio — che è il caso normale, non l'eccezione. Gli
      // insiemi di UNA riga invece si guardano: `{'03'}` è completo per uno scarto e mancante per
      // una produzione, e la differenza la sa solo `buildDocuments`.
      if (haveSeq.has(DOC_CONFIRM) || (haveSeq.has(DOC_ISSUE) && haveSeq.has(DOC_RECEIPT))) {
        continue;
      }
    }

    // [CONF-POSTING] Senza ordine non c'e' niente da leggere, e chiedere la testata di un ordine
    // vuoto sarebbe una lettura verso SAP con un filtro nullo: e' il caso dello scarto di un pezzo
    // gia' versato, l'unico che arriva qui in stato 'E' senza ordine.
    const info = row.ManufacturingOrder
      ? await loadOrder(row.ManufacturingOrder)
      : { order: null, operations: [], components: [], error: null, notes: [] };
    if (info.error) {
      // Guasto: la registrazione resta 'E' e si riprova al run successivo. NON si archivia.
      out.blocked++;
      // [RUN-BLOCKED] Si tiene il PRIMO motivo per plant e non l'ultimo: e' quello della prima
      // lettura caduta, cioe' la piu' vicina alla causa. I successivi sono spesso la stessa cosa
      // detta da una chiamata che nel frattempo ha anche cambiato sintomo.
      const k = String(row.Plant || '');
      const prev = orderReadFail.get(k);
      if (prev) prev.n += 1;
      else orderReadFail.set(k, { n: 1, reason: String(info.error) });
      continue;
    }
    // Il materiale dello scarto senza ordine: il dizionario delle part Plex, letto al contrario. La
    // mappa e' PIGRA — su un run senza scarti post-produzione non legge niente — e la si interroga
    // solo dove serve, cioe' quando il plant ha chiesto di registrarli.
    let noOrderMaterial = '';
    if (!row.ManufacturingOrder && row.SourceType === 'S' && config.ScrapNoOrder === 'POST') {
      const look = await matDict.lookup(row.PlexPartId);
      if (look.status === 'FOUND') noOrderMaterial = look.product;
      else if (summary) {
        const named = String(row.PlexPartId || '(senza id)');
        if (!dictNamed.has(named) && dictNamed.size < DICT_NAMED_MAX) {
          dictNamed.add(named);
          summary.scope({
            plant: row.Plant, objectKey: `SCRAP/${look.status}`, status: 'W',
            // Il motivo viene dal dizionario inverso delle part (srv/lib/plexMatDictionary.js), che
            // costruisce ancora prosa: lacuna dichiarata (grep logMsgVerbatim).
            segments: [logMsg.verbatim(look.reason)]
          });
        }
      }
    }
    // [CONF-POSTING] L'albero Plex si legge SOLO se la configurazione del plant ne ha bisogno: a
    // plant non configurato queste due letture non avvengono, ed e' la condizione che rende il cambio
    // a costo zero dove nessuno l'ha chiesto. Ne ha bisogno chi ha un perimetro d'operazione
    // (`EACH_OP`, `UP_TO_OP`) e, dalla 0030, chi manda la produzione come CONFERMA: da la' viene
    // l'ANCORA (l'ultima operazione del ciclo dell'ordine). Sullo scarto no — quello resta un
    // documento materiale con le regole della 0028.
    const perimetroRichiesto = config.ConsumeAt === 'EACH_OP' || config.ScrapConsume === 'UP_TO_OP'
      || (config.ProdPosting === 'CONF' && row.SourceType === 'P');
    let allocation = null;
    if (perimetroRichiesto && row.ManufacturingOrder) {
      allocation = await plexAlloc.allocationFor(row.ManufacturingOrder);
      if (allocation.reason && !allocNoted.has(row.ManufacturingOrder)) {
        // Gli orfani e le operazioni senza numero si dichiarano UNA VOLTA per ordine: sono una
        // proprieta' dell'albero, non della registrazione, e ripeterle per ogni riga riempirebbe il
        // recap di frasi identiche.
        allocNoted.add(row.ManufacturingOrder);
        if (summary) {
          summary.scope({
            plant: row.Plant, objectKey: `ALLOC/${row.ManufacturingOrder}`, status: 'W', degrade: false,
            segments: [
              logMsg.seg('logConfAllocTree', row.ManufacturingOrder),
              // Il motivo viene da srv/lib/plexCycleAllocation.js, ancora a prosa: lacuna dichiarata.
              logMsg.verbatim(allocation.reason)
            ]
          });
        }
      }
    }
    const built = buildDocuments({
      entry: row, order: info.order, components: info.components, operations: info.operations,
      config, noOrderMaterial, allocation
    });

    // [CONF-POSTING] LA REGISTRAZIONE CHE HA GIA' DEI DOCUMENTI: si completa l'insieme, e lo stato
    // della madre NON si tocca — quello lo decide `refreshEntryStatus` dai suoi figli. Rimetterlo a
    // 'I' o riscriverne il messaggio qui archivierebbe una registrazione con documenti in attesa.
    if (haveSeq.size) {
      const mancanti = built.documents.filter((d) => !haveSeq.has(d.docSeq));
      if (!mancanti.length) continue;
      const scritti = await insertDocuments(db, row, mancanti, now, out);
      if (scritti && summary) {
        summary.scope({
          plant: row.Plant, objectKey: `BUILD/${row.ManufacturingOrder || row.PlexEntryId}`,
          status: 'W',
          segments: [logMsg.seg('logConfDocsFilled', scritti, [...haveSeq].join(','))]
        });
      }
      out.filled += scritti;
      continue;
    }

    if (!built.documents.length) {
      noteCause(built.cause, row.Plant);
      if (built.ignore) {
        await db.run(UPDATE(E_CONF_ENTRY).set({
          Status: 'I', Message: cut(built.reason, 255), UpdatedAt: now.toISOString()
        }).where({ PlexEntryId: row.PlexEntryId }));
        out.ignored++;
      } else {
        // Non è una regola, è un dato che manca: resta 'E' e ci si riprova.
        out.blocked++;
        await db.run(UPDATE(E_CONF_ENTRY).set({
          // Il motivo viene da srv/lib/confMatDoc.js, che costruisce ancora prosa: avvolto in
          // `verbatim` e' una lacuna DICHIARATA e cercabile (grep logMsgVerbatim), non un testo che
          // scivola in una colonna tradotta senza che niente lo segnali.
          ...msgCols([logMsg.verbatim(built.reason)]),
          UpdatedAt: now.toISOString()
        }).where({ PlexEntryId: row.PlexEntryId }));
        // [MATDOC-FIX] La sospensione che DEGRADA. La maggior parte delle sospensioni è un'attesa
        // normale e non deve tingere il run; «nessuna riga di consumo» invece sì, perché è il caso
        // in cui prima partiva il versamento da solo e nessuno lo vedeva.
        if (built.degrade === true && summary) {
          summary.scope({
            // [CONF-POSTING] Senza ordine la chiave e' la registrazione: `BUILD/null` non si cerca.
            plant: row.Plant, objectKey: `BUILD/${row.ManufacturingOrder || row.PlexEntryId}`,
            status: 'W',
            segments: [built.reason, ...built.notes].filter(Boolean).map((t) => logMsg.verbatim(t))
          });
        }
      }
      continue;
    }

    await insertDocuments(db, row, built.documents, now, out);
    out.built++;
    if (built.notes.length && summary) {
      summary.scope({
        plant: row.Plant, objectKey: `BUILD/${row.ManufacturingOrder || row.PlexEntryId}`, status: 'W',
        // [MATDOC-FIX] `degrade` viene dalle regole e non è più una costante: una nota che dice
        // «tre componenti sotto il millesimo» è informativa, «nessuna riga di consumo» no.
        degrade: built.degrade === true,
        segments: built.notes.map((t) => logMsg.verbatim(t))
      });
    }
  }
  // [CONF-POSTING] LE CAUSE SI DICHIARANO, e in una riga per causa e plant. Senza, un plant con
  // `ScrapNoOrder = 'OFF'` o con `GR_OP_ONLY` + `NONE` non registrerebbe certi movimenti e il recap
  // direbbe solo «N ignorate»: cioe' una configurazione che lavora sarebbe indistinguibile da un
  // difetto. `degrade: false` perche' sono esiti previsti, non attenzioni.
  if (summary) {
    for (const [key, n] of causes) {
      const [plant, cause] = key.split('|');
      if (cause === 'OK') continue;
      summary.scope({
        plant: plant === '-' ? null : plant, objectKey: `CAUSE/${cause}`, status: 'W', degrade: false,
        // La CAUSA e' un codice e non si traduce: e' un dato, e finisce come parametro (DEC-92).
        segments: [logMsg.seg('logConfNoDocsCause', n, cause)]
      });
    }
  }
  // [RUN-BLOCKED] `status: 'E'`: la testata non letta e' una chiamata verso SAP senza risposta
  // utilizzabile, e quelle registrazioni non sono state costruite (DEC-124). Sta accanto alle voci
  // per plant qui sopra e non fra le cause, che sono `degrade: false` perche' sono esiti previsti.
  if (summary) {
    for (const [plant, f] of orderReadFail) {
      summary.scope({
        plant: plant || null, objectKey: 'BUILD/ORDER_READ', status: 'E',
        segments: [logMsg.seg('logConfOrderReadFailed', f.n), logMsg.technical(f.reason)]
      });
    }
  }
  const alloc = plexAlloc ? plexAlloc.stats() : { orders: 0 };
  console.log(`>>> [MATDOC-CONF] documenti costruiti: ${out.documents} da ${out.built} registrazioni`
    + ` · ignorate ${out.ignored} · in attesa di dati ${out.blocked}`
    + (out.filled ? ` · ${out.filled} completati su registrazioni gia' avviate` : '')
    + (out.channelMixed ? ` · ${out.channelMixed} lasciate stare (canale cambiato)` : '')
    + (out.raced ? ` · ${out.raced} gia' scritti da un run sovrapposto` : '')
    + (alloc.orders ? ` · alberi Plex letti ${alloc.orders}` : '')
    + (causes.size ? ` · cause: ${[...causes].map(([k, n]) => `${k}=${n}`).join(', ')}` : ''));
  return out;
}

// =============================================================================================
// FASE B2 — invio dei documenti, con retry
// =============================================================================================

/** Lo stato della registrazione discende da quello dei suoi documenti. */
async function refreshEntryStatus(db, plexEntryId, now) {
  const docs = await db.run(
    SELECT.from(E_MAT_DOC).columns('Status', 'MaterialDocument', 'MaterialDocumentYear', 'DocSeq',
      'ConfirmationGroup', 'ConfirmationCount')
      .where({ PlexEntryId: plexEntryId })
  );
  if (!docs || !docs.length) return;
  const status = docs.some((d) => d.Status === 'X') ? 'X'
    : (docs.every((d) => d.Status === 'S') ? 'S' : 'E');
  // Il documento «principale» per la consultazione rapida è il primo che ha un numero: in pratica
  // l'uscita merci, che è quella che si va a cercare in MB51.
  const main = docs.filter((d) => d.MaterialDocument).sort((a, b) => a.DocSeq - b.DocSeq)[0];
  // [CONF-POSTING] Le due chiavi della CONFERMA salgono sulla madre come il numero documento: e' da
  // la' che si arriva a CO14. La regola dello stato non cambia — «tutti i figli 'S'» — e non deve
  // cambiare: con `ProdPosting='CONF'` la registrazione ha un figlio solo, quindi «tutti» e' lui, e
  // i due canali non convivono mai sulla stessa registrazione (vedi la fase di costruzione).
  // [CONF-OUTCOME] Il documento di conferma si riconosce dal suo `DocSeq` e NON dall'avere le
  // chiavi: dal 02/09/2026 la risposta dell'iFlow non le porta piu', e con la condizione di prima
  // una registrazione confermata chiudeva col messaggio generico dei movimenti merci — «registrata
  // in SAP» invece di «confermata». Le due colonne restano scritte solo se le chiavi ci sono: una
  // colonna vuota e' il vero, un `null` inventato no.
  const conf = docs.find((d) => d.DocSeq === DOC_CONFIRM);
  await db.run(UPDATE(E_CONF_ENTRY).set({
    Status: status,
    MaterialDocument: main?.MaterialDocument || null,
    MaterialDocumentYear: main?.MaterialDocumentYear || null,
    ConfirmationGroup: conf?.ConfirmationGroup || null,
    ConfirmationCount: conf?.ConfirmationCount || null,
    Message: status === 'S'
      ? (conf
        ? (conf.ConfirmationGroup
          ? `confermata in SAP (${conf.ConfirmationGroup}/${conf.ConfirmationCount})`
          : 'confermata in SAP')
        : 'registrata in SAP')
      : (status === 'X' ? 'almeno un documento non registrabile' : 'in attesa di registrazione'),
    UpdatedAt: now.toISOString()
  }).where({ PlexEntryId: plexEntryId }));
}

async function sendPendingDocuments(ctx, usablePlants) {
  const { db, summary, now, permanentMessages, runId } = ctx;
  // `heldBack` sono i versamenti rinviati perché il loro consumo non è ancora registrato: non sono
  // né riusciti né falliti, e non consumano un tentativo.
  // `claimTaken` sono le righe che un altro run aveva gia' preso: sovrapposizione legittima, non
  // si dichiara. `claimUnknown` invece si dichiara: e' il conteggio delle righe toccate che non
  // si e' saputo leggere, cioe' il modo in cui un cambio di forma del risultato di UPDATE
  // smetterebbe di registrare in silenzio. `staleParked` sono le prenotazioni di run morti.
  // [CONF-POSTING] `confHeld` sono le CONFERME non spedite dal gate del plant: si contano a parte
  // da `disabled`, o il messaggio della leva dei movimenti merci direbbe «MATDOC_POST=off» per
  // conferme fermate da un interruttore che non e' quello.
  const out = {
    sent: 0, failed: 0, exhausted: 0, testRun: 0, disabled: 0, heldBack: 0,
    claimTaken: 0, claimUnknown: 0, staleParked: 0, confHeld: 0
  };
  if (usablePlants.size === 0) {
    console.log('>>> [MATDOC-CONF] nessun plant attivo/licenziato: nessun invio.');
    if (summary) summary.noScope({ active: 0, usable: 0 });
    return out;
  }

  const plantRows = await db.run(SELECT.from(E_PLANT).columns('PlantCode', 'MaxRetryAttempts'));
  const maxRetryByPlant = new Map(plantRows.map((r) => [r.PlantCode, r.MaxRetryAttempts]));

  // Documenti in attesa su plant NON usabili: la query dei candidati li esclude, quindi un plant
  // con licenza scaduta accumulerebbe arretrato in modo del tutto invisibile.
  if (summary) {
    try {
      const stuck = await db.run(
        // [MATDOC-CLAIM] Anche le 'P': un documento prenotato su un plant che perde la licenza
        // uscirebbe da entrambe le viste e diventerebbe invisibile.
        SELECT.from(E_MAT_DOC).columns('Plant', 'count(*) as n')
          .where({ Status: { in: ['E', claimRules.STATUS_IN_FLIGHT] } }).groupBy('Plant')
      ) || [];
      for (const s of stuck) {
        if (!usablePlants.has(s.Plant)) {
          summary.scope({
            plant: s.Plant, objectKey: 'PENDING_NOT_USABLE', status: 'W',
            segments: [logMsg.seg('logConfPendingNotUsable', s.n)]
          });
        }
      }
    } catch (e) {
      console.error(`>>> [MATDOC-CONF] conteggio arretrato non usabile fallito: ${e.message}`);
    }
  }

  // =========================================================================================
  // [MATDOC-CLAIM] LE PRENOTAZIONI DI RUN MORTI, prima di ogni altra cosa.
  //
  // Una riga 'P' più vecchia della soglia è un run che è morto fra la chiamata a SAP e la risposta:
  // NON sappiamo se il movimento è stato registrato. È la stessa situazione dell'esito non
  // conclusivo, quindi la stessa regola di DEC-60 — si parcheggia 'X', non si ritenta, e si chiede
  // un umano. Ritentare è l'azione pericolosa: se il movimento è passato, il secondo tentativo lo
  // duplica.
  //
  // QUESTA RACCOLTA È OBBLIGATORIA, non un abbellimento: le righe 'P' non sono più selezionate
  // dalla query dei candidati qui sotto, quindi senza di essa spariscono dalla vista invece di
  // essere duplicate — un difetto diverso e non migliore.
  //
  // Il filtro sui plant usabili NON si applica: una riga in volo va chiusa comunque, perché
  // descrive una chiamata che è già partita. Il plant serve solo a etichettarla nel recap.
  const staleMinutes = claimRules.readStaleMinutes();
  try {
    const stale = await db.run(
      SELECT.from(E_MAT_DOC)
        .columns('PlexEntryId', 'DocSeq', 'Plant', 'ManufacturingOrder', 'GoodsMovementCode',
          'InFlightAt', 'InFlightRun')
        .where({
          Status: claimRules.STATUS_IN_FLIGHT,
          InFlightAt: { '<': claimRules.staleCutoff(now, staleMinutes) }
        })
    ) || [];
    for (const d of stale) {
      // Non si parcheggia mai una prenotazione di QUESTO run: la soglia sull'istante lo esclude
      // gia', ma un orologio che va indietro (NTP) o una riga scritta a mano lo renderebbero
      // possibile, e parcheggiare una chiamata propria in volo e' il caso peggiore.
      if (runId && d.InFlightRun === runId) continue;
      const claimCtx = { inFlightAt: toIso(d.InFlightAt), inFlightRun: d.InFlightRun };
      const message = claimRules.staleClaimMessage(claimCtx);
      const staleSegments = claimRules.staleClaimSegments(claimCtx);
      await db.run(UPDATE(E_MAT_DOC).set({
        Status: 'X',
        FailureClass: 'P',                       // permanente: non si ritenta, come DEC-60
        ...msgCols(staleSegments, 'MessageText', 'MessageTextJson'),
        InFlightAt: null, InFlightRun: null,
        UpdatedAt: now.toISOString()
      }).where({ PlexEntryId: d.PlexEntryId, DocSeq: d.DocSeq }));
      await refreshEntryStatus(db, d.PlexEntryId, now);
      out.staleParked++;
      console.error(`>>> [MATDOC-CLAIM] ${d.ManufacturingOrder || d.PlexEntryId}/${d.GoodsMovementCode} `
        + `(${d.PlexEntryId}/${d.DocSeq}): ${message}`);
      if (summary) {
        summary.record({
          plant: d.Plant, objectType: 'MATDOC',
          objectKey: `${d.ManufacturingOrder || d.PlexEntryId}/${d.GoodsMovementCode}`,
          objectKey2: d.PlexEntryId, status: 'X', segments: staleSegments,
          logRef: `ZProdConfMatDoc/${d.PlexEntryId}/${d.DocSeq}`
        });
      }
    }
  } catch (e) {
    // La raccolta non deve impedire l'invio del resto, ma il suo fallimento non si nasconde: senza
    // di essa le righe in volo restano invisibili, ed è la ragione per cui esiste.
    console.error(`>>> [MATDOC-CLAIM] raccolta delle prenotazioni scadute fallita: ${e.message}`);
    if (summary) {
      summary.scope({
        objectKey: 'STALE_CLAIM_SWEEP', status: 'E',
        segments: [logMsg.seg('logConfStaleSweepFailed'), logMsg.technical(e.message)]
      });
    }
  }

  let candidates = await db.run(
    SELECT.from(E_MAT_DOC).where({ Status: 'E', Plant: { in: [...usablePlants] } })
      .orderBy('PlexEntryId', 'DocSeq')
  );

  // Il tetto per esecuzione taglia su confine di REGISTRAZIONE, non di documento: spedire l'uscita
  // merci e rimandare il versamento al run successivo lascerebbe l'ordine sbilanciato nel mezzo.
  // [MATDOC-FIX] Se il tetto e' piu' piccolo della prima registrazione, la si manda INTERA: un
  // taglio a zero fermava tutto il flusso in silenzio. [CONF-GROUP] E le conferme di un ordine gia'
  // incluso entrano anche oltre il tetto: un ordine spezzato fra due run sarebbero due conferme
  // sullo stesso ordine. Le tre regole sono pure, in srv/lib/confGroupRules.js (`cutCandidates`).
  if (MAX_DOCS_PER_RUN > 0 && candidates.length > MAX_DOCS_PER_RUN) {
    const cut = groupRules.cutCandidates(candidates, MAX_DOCS_PER_RUN, DOC_CONFIRM);
    candidates = cut.kept;
    console.log(`>>> [MATDOC-CONF] limite per run: ${candidates.length} documenti su ${cut.total}`
      + (cut.overflow > 0 ? ` (tetto ${MAX_DOCS_PER_RUN} sforato di ${cut.overflow}: prima registrazione intera)` : '')
      + (cut.pulled > 0 ? ` (${cut.pulled} conferme aggiunte per non spezzare un ordine)` : ''));
    if (summary) {
      summary.note([logMsg.seg('logConfDocsDeferred', cut.total - candidates.length)]);
      if (cut.overflow > 0) {
        // Sforare un tetto configurato si DICHIARA: chi l'ha messo deve sapere che non è stato
        // rispettato, e perché.
        summary.scope({
          objectKey: 'MAX_PER_RUN_TOO_LOW', status: 'W',
          segments: [logMsg.seg('logConfMaxPerRunTooLow', MAX_DOCS_PER_RUN, candidates.length)]
        });
      }
    }
  }

  const touched = new Set();
  const testRunByPlant = new Map();
  // [CONF-POSTING] La configurazione del plant serve al GATE della conferma, che sta PRIMA della
  // prenotazione. Una lettura per plant per run, come nella fase di costruzione.
  const confConfigs = new Map();
  const confConfigFor = async (plant) => {
    const key = String(plant || '');
    if (!confConfigs.has(key)) confConfigs.set(key, await resolveConfPostingConfig(db, key));
    return confConfigs.get(key);
  };
  // Le due ragioni per cui una conferma non parte, contate per plant: hanno rimedi DIVERSI, quindi
  // sono due righe di recap e non una. (Erano tre: vedi il gate.)
  const confSkipped = { disabled: new Map(), unreadable: new Map() };
  const bump = (m, plant) => m.set(plant, (m.get(plant) || 0) + 1);
  // [MATDOC-FIX] Le registrazioni il cui consumo non è partito perché la leva è spenta: il
  // versamento le segue in silenzio, invece di aggiungere un avviso a una condizione voluta.
  const offEntries = new Set();
  // [CONF-GROUP] Le conferme d'ordine che hanno passato il gate, per (plant, ordine): partono sommate
  // nel secondo passaggio, dopo il ciclo.
  const confGroups = new Map();

  /** La chiave d'oggetto e la riga di recap di un documento. */
  const recFor = (doc) => {
    // [CONF-POSTING] Uno scarto senza lotto non cita l'ordine (DEC-91), quindi la chiave dell'oggetto
    // e' la registrazione: `null/03` non si cerca in nessun elenco.
    // [CONF-POSTING] La conferma non ha un codice di movimento: la sua chiave d'oggetto lo dice, o
    // nel recap comparirebbe come `1000123/` e sembrerebbe un dato mancante.
    const isConf = doc.DocSeq === DOC_CONFIRM;
    const objectKey = `${doc.ManufacturingOrder || doc.PlexEntryId}/${isConf ? 'CONF' : doc.GoodsMovementCode}`;
    // [LOG-MSG-I18N] Il wrapper prende SEGMENTI: e' il punto in cui nove rami di esito scrivono la
    // loro riga di recap, quindi e' anche il punto in cui una stringa passerebbe inosservata.
    // [ORDER-LOG-OP] Il `logRef` e' un parametro: dove una riga di storico dell'ordine esiste, il
    // recap punta LA', perche' e' dove ci sono i corpi delle chiamate. Dove non esiste — la chiamata
    // non e' partita — resta il puntatore al documento, che e' l'unica cosa che c'e'.
    const rec = (status, segments, logRef) => {
      if (!summary) return;
      summary.record({
        plant: doc.Plant, objectType: 'MATDOC', objectKey, objectKey2: doc.PlexEntryId,
        status, segments,
        logRef: logRef || `ZProdConfMatDoc/${doc.PlexEntryId}/${doc.DocSeq}`
      });
    };
    return { isConf, objectKey, rec };
  };

  // [CONF-GROUP] I passi che seguono il gate sono FUNZIONI e non righe del ciclo, perche' li
  // percorrono due strade: il documento materiale, uno per volta nel ciclo qui sotto, e la conferma
  // d'ordine, che parte sommata per ordine nel secondo passaggio. Una copia per strada divergerebbe.

  /** Prenota la riga ('E' -> 'P'). `false` se non e' nostra: non si spedisce. */
  const claimDoc = async (doc, rec) => {
    // [MATDOC-CLAIM] SI PRENOTA LA RIGA PRIMA DI CHIAMARE SAP.
    //
    // Ogni `db.run` qui è una root-transaction che CAP committa da sola (jobSummary.js), quindi
    // questa UPDATE è committata PRIMA della chiamata e sopravvive alla morte del processo. Da lì
    // discendono le due protezioni: una riga rimasta 'P' è un run morto e NON verrà rispedita, e un
    // run concorrente non la vede più fra i candidati, che si selezionano per 'E'.
    //
    // La `where` include `Status: 'E'`: è quello che rende la prenotazione atomica. Se un altro run
    // l'ha già presa la UPDATE tocca zero righe, e zero righe significa «non è mia».
    // `InFlightAt` e' l'istante DELLA PRENOTAZIONE, non l'inizio del run, e la differenza conta:
    // con `ctx.now` tutte le prenotazioni di un run porterebbero l'ora di partenza, e su un run
    // lungo — piu' della soglia — un run successivo vedrebbe come «scadute» righe che il primo sta
    // ancora spedendo, parcheggiandole mentre la chiamata e' in volo.
    const claimAt = new Date().toISOString();
    const claim = claimRules.claimVerdict(await db.run(UPDATE(E_MAT_DOC).set({
      Status: claimRules.STATUS_IN_FLIGHT,
      InFlightAt: claimAt,
      InFlightRun: runId || null,
      UpdatedAt: claimAt
    }).where({ PlexEntryId: doc.PlexEntryId, DocSeq: doc.DocSeq, Status: 'E' })));

    if (!claim.claimed) {
      if (claim.verdict === 'UNKNOWN') {
        // Non sappiamo quante righe abbiamo toccato, quindi non sappiamo se la riga è nostra:
        // spedirla è il duplicato che stiamo evitando. Va DICHIARATO, perché è il modo in cui un
        // cambio di forma del risultato di UPDATE si vedrebbe invece di fermare tutto in silenzio.
        out.claimUnknown++;
        // `claim.reason` viene da srv/lib/matDocClaim.js, ancora a prosa: lacuna dichiarata.
        rec('E', [logMsg.verbatim(claim.reason)]);
      } else {
        out.claimTaken++;      // sovrapposizione legittima: non si dichiara
      }
      return false;
    }
    return true;
  };

  /** Rilascia la prenotazione riportando la riga a 'E'. */
  const releaseFor = (doc) => async (extra = {}) => db.run(UPDATE(E_MAT_DOC).set({
    Status: 'E', InFlightAt: null, InFlightRun: null, UpdatedAt: now.toISOString(), ...extra
  }).where({ PlexEntryId: doc.PlexEntryId, DocSeq: doc.DocSeq }));

  /** Il corpo salvato alla costruzione. `null` se illeggibile: la riga e' gia' parcheggiata 'X'. */
  const readPayload = async (doc, rec, isConf) => {
    let data;
    try {
      data = JSON.parse(doc.RequestJson);
      // [CONF-GROUP] Una conferma che non si puo' sommare non parte: sommata a zero confermerebbe
      // meno di quanto prodotto, senza dirlo. Per costruzione non capita (`confirmationFor`).
      if (isConf && !groupRules.isSummable(data && data.confirmation)) {
        throw new Error('conferma senza OrderID o senza una quantità positiva');
      }
    } catch (e) {
      const badPayload = [logMsg.seg('logConfPayloadUnreadable'), logMsg.technical(e.message)];
      rec('X', badPayload);
      await db.run(UPDATE(E_MAT_DOC).set({
        Status: 'X', FailureClass: 'P',
        ...msgCols(badPayload, 'MessageText', 'MessageTextJson'),
        InFlightAt: null, InFlightRun: null,
        UpdatedAt: now.toISOString()
      }).where({ PlexEntryId: doc.PlexEntryId, DocSeq: doc.DocSeq }));
      out.exhausted++;
      touched.add(doc.PlexEntryId);
      return null;
    }
    return data;
  };

  /**
   * L'esito di UNA chiamata applicato a UN documento: stato, tentativi, storico dell'ordine, recap.
   * [CONF-GROUP] Su una conferma sommata gira una volta per registrazione con lo stesso `r`: ognuna
   * conta i SUOI tentativi contro il tetto del plant, ha la SUA riga di storico con il suo testo e la
   * sua quantita', e `group` aggiunge a quella riga la conferma cumulativa di cui fa parte.
   */
  const settle = async (doc, { isConf, objectKey, rec, max, unlimited, data, r, response, stamp, group }) => {
    const release = releaseFor(doc);
    const groupSegs = group ? [logMsg.seg('logConfGroupCall', group.size, group.qtyText)] : [];

    // ---- chiamata DISATTIVATA: non è successa, quindi non conta come niente ---------------
    // `MATDOC_POST=off` (o `post.enabled=false`) fa uscire postMaterialDoc senza spedire nulla.
    // Va intercettato PRIMA degli altri rami, e per due ragioni opposte: sul ramo della prova
    // scriveremmo «validato da SAP», che è falso perché SAP non ha visto niente; su quello del
    // fallimento incrementeremmo RetryCount, e una leva lasciata spenta qualche giorno
    // esaurirebbe i tentativi di documenti mai partiti. La riga resta intatta.
    if (r.outcome === 'OFF') {
      out.disabled++;
      if (doc.DocSeq === DOC_ISSUE) offEntries.add(doc.PlexEntryId);
      // [MATDOC-CLAIM] E' il rilascio che si dimentica. Senza, la riga resterebbe 'P' e la raccolta
      // la parcheggerebbe 'X' come se un run fosse morto — su una leva spenta di proposito.
      await release();
      return;
    }

    // ---- registrazione in PROVA: non è né un successo né un fallimento -------------------
    // Con MatDocPostEnabled non abilitato SAP valida e non registra. Se contassimo il tentativo,
    // un plant in prova esaurirebbe i retry su documenti che nessuno ha mai rifiutato, e alla sua
    // abilitazione quei documenti non partirebbero più: la riga resta 'E' e RetryCount NON avanza.
    if (r.testRun === 'X') {
      out.testRun++;
      testRunByPlant.set(doc.Plant, (testRunByPlant.get(doc.Plant) || 0) + 1);
      await db.run(UPDATE(E_MAT_DOC).set({
        // [MATDOC-CLAIM] `Status: 'E'` e' il rilascio: la riga torna disponibile, che e' la regola
        // di sempre (una prova non consuma un tentativo), ora scritta esplicitamente.
        Status: 'E', InFlightAt: null, InFlightRun: null,
        TestRun: true,
        MessageType: r.messageType || null,
        MessageText: cut(r.outcome === 'OK'
          ? 'validato da SAP senza registrare (plant non abilitato alla registrazione reale)'
          : `prova non superata: ${r.reason || r.message || r.error || ''}`, 255),
        ResponseJson: response,
        UpdatedAt: stamp.toISOString()
      }).where({ PlexEntryId: doc.PlexEntryId, DocSeq: doc.DocSeq }));
      // [ORDER-LOG-OP] La prova E' una chiamata: SAP ha risposto, e la riga di storico lo dice.
      await writeOrderExcLog(db, doc, {
        isConf,
        status: r.outcome === 'OK' ? 'W' : 'E',
        segments: r.outcome === 'OK'
          ? [logMsg.seg('logConfTestRunOne')]
          : [logMsg.seg('logConfTestRunFailed'),
            ...(r.reason || r.message || r.error
              ? [logMsg.technical(r.reason || r.message || r.error)] : [])],
        r,
        response
      });
      return;
    }

    if (r.outcome === 'OK') {
      out.sent++;
      // [CONF-POSTING] L'esito di una conferma sono le DUE CHIAVI, non un numero documento, e vanno
      // in colonne loro: `MaterialDocument` e' String(10) e la coppia non ci sta.
      // [LOG-MSG-I18N] Due chiavi e non una frase con un `?:` dentro: «conferma» e «documento» sono
      // due esiti diversi, e una sola chiave con il tipo come parametro darebbe una frase che in
      // un'altra lingua non si puo' comporre.
      // [CONF-OUTCOME] IL MESSAGGIO DI UNA CONFERMA DICE COSA E' STATO CONFERMATO, NON LE DUE CHIAVI
      // (09/09/2026).
      //
      // Le due chiavi erano l'esito, e dal 02/09/2026 non tornano piu': DEC-119 aveva previsto il
      // caso con una terza chiave, perche' `logConfPostedConfirmation` su due valori vuoti
      // renderebbe «conferma /» — la frase che annuncia la registrazione sembrerebbe dire che non
      // c'e' stata. Ma la risposta le manda A ZERI, non assenti: `field()` rende `'0000000000'`,
      // che e' una stringa TRUTHY, quindi la guardia non scattava e a schermo si leggeva
      // «conferma 0000000000/00000000». Visto su quality il 09/09/2026 alle 14:31 su tre conferme
      // riuscite. Lo zero non e' ne' «c'e'» ne' «non c'e'»: e' la terza forma che nessuna delle due
      // chiavi copriva.
      //
      // Quello che serve a chi guarda e' l'IDENTITA' della registrazione e la QUANTITA'. Entrambe
      // sono nel corpo, che `data` ha gia' in mano: `ConfirmationText` non esiste come colonna in
      // tutto lo schema. Si usa il corpo INVIATO e non l'eco `r.confirmationText`, che c'e' o non
      // c'e' a seconda della forma della risposta — un messaggio che cambia contenuto col variare
      // della forma e' precisamente il difetto che si sta correggendo. L'eco resta in `ResponseJson`.
      //
      // Nessuna prosa davanti: la colonna «Operazione» dice gia' «Conferma d'ordine» e la colonna
      // «Stato» dice gia' «Successo». E se la quantita' non c'e' si cambia CHIAVE invece di mandare
      // un parametro vuoto, o la frase renderebbe «SN … - » col trattino orfano: e' la lezione
      // dell'addendum del 07/09/2026 alla DEC-124.
      //
      // Le due chiavi vecchie NON si toccano nei bundle: `MessageJson` si rende alla lettura, e ogni
      // riga storica le cita. Le colonne `ConfirmationGroup`/`ConfirmationCount` si continuano a
      // scrivere qui sotto: cambia il messaggio, non il dato.
      const confText = String((data.confirmation && data.confirmation.ConfirmationText) || '').trim();
      const confQty = data.confirmation
        ? confRules.confQtyText(
          data.confirmation.ConfirmationYieldQuantity, data.confirmation.ConfirmationUnit)
        : '';
      let esitoSeg;
      if (!isConf) {
        esitoSeg = logMsg.seg('logConfPostedDocument', r.materialDocument, r.materialDocumentYear);
      } else if (confText && confQty) {
        esitoSeg = logMsg.seg('logConfPostedConfirmationYield', confText, confQty);
      } else if (confText) {
        esitoSeg = logMsg.seg('logConfConfirmationText', confText);
      } else {
        // Nemmeno il testo: si nomina l'ORDINE della riga, che c'e' sempre. Una chiave con un
        // parametro vuoto renderebbe un messaggio VUOTO su una riga riuscita — che e' peggio della
        // frase inutile da cui si e' partiti.
        esitoSeg = logMsg.seg('logConfPostedConfirmationOrder', doc.ManufacturingOrder);
      }
      const esito = renderMsg([esitoSeg]);
      await db.run(UPDATE(E_MAT_DOC).set({
        Status: 'S', TestRun: false, FailureClass: null,
        InFlightAt: null, InFlightRun: null,                       // [MATDOC-CLAIM] rilascio
        MaterialDocument: isConf ? null : r.materialDocument,
        MaterialDocumentYear: isConf ? null : r.materialDocumentYear,
        ConfirmationGroup: isConf ? r.confirmationGroup : null,
        ConfirmationCount: isConf ? r.confirmationCount : null,
        MessageType: r.messageType || null,
        // Il messaggio di SAP e' testo di terzi: si mostra, non si traduce.
        ...msgCols(r.message ? [logMsg.technical(r.message)] : [], 'MessageText', 'MessageTextJson'),
        ResponseJson: response, UpdatedAt: stamp.toISOString()
      }).where({ PlexEntryId: doc.PlexEntryId, DocSeq: doc.DocSeq }));
      console.log(`>>> [OK] ${objectKey} -> ${esito}`);
      const okSegs = [esitoSeg, ...groupSegs, ...(r.warn && r.message ? [logMsg.technical(r.message)] : [])];
      // [ORDER-LOG-OP] La riga di storico dell'ORDINE: e' qui che si vede che quella registrazione
      // e' stata contabilizzata, con il corpo mandato e quello ricevuto.
      const okCounter = await writeOrderExcLog(db, doc, {
        isConf, status: r.warn ? 'W' : 'S', segments: okSegs, r, response
      });
      rec('S', okSegs, excLog.logRefFor(doc.ManufacturingOrder, okCounter));
      return;
    }

    // ---- fallimento: guasto o rifiuto? ----------------------------------------------------
    // [CONF-POSTING] LA CLASSIFICAZIONE DELLA CONFERMA NON E' QUELLA DEI MOVIMENTI, e la ragione sta
    // in `classifyConfirmation`: su un movimento un rifiuto prova che niente e' passato, su una
    // conferma no — e una seconda conferma non e' un doppione visibile, e' quantita' in piu'.
    const verdict = isConf ? classifyConfirmation(r) : classifyFailure(r, permanentMessages);
    const newCount = (doc.RetryCount || 0) + 1;
    const permanent = verdict.permanent || (!unlimited && newCount >= max);
    await db.run(UPDATE(E_MAT_DOC).set({
      Status: permanent ? 'X' : 'E',
      InFlightAt: null, InFlightRun: null,                         // [MATDOC-CLAIM] rilascio
      FailureClass: verdict.failureClass,
      RetryCount: newCount,
      MessageType: r.messageType || null,
      ...msgCols(
        r.message || r.reason || r.error
          ? [logMsg.technical(r.message || r.reason || r.error)]
          : [logMsg.seg('logConfGenericError')],
        'MessageText', 'MessageTextJson'
      ),
      ResponseJson: response,
      UpdatedAt: stamp.toISOString()
    }).where({ PlexEntryId: doc.PlexEntryId, DocSeq: doc.DocSeq }));
    if (permanent) out.exhausted++; else out.failed++;

    // [LOG-MSG-I18N] Il tentativo e' un segmento (con o senza tetto), il DETTAGLIO e' testo di terzi
    // e viaggia in `technical`: l'id MPL e' la chiave con cui il team Integration apre l'esecuzione
    // nel monitor, quindi va davanti al messaggio e non si perde.
    const attemptSeg = unlimited
      ? logMsg.seg('logConfAttempt', newCount)
      : logMsg.seg('logConfAttemptOf', newCount, max);
    // [CONF-OUTCOME] Anche un fallimento deve dire QUALE registrazione e' rimasta indietro
    // (09/09/2026). Il testo della conferma porta il numero di SERIE e il lotto Plex, cioe' l'unico
    // modo di risalire al contenitore fisico: senza, dallo storico si sa che una conferma non e'
    // partita ma non quale — e su un rifiuto permanente e' proprio l'informazione che serve per
    // stornare in CO13. Va DOPO il tentativo e PRIMA dell'id MPL, e l'ordine non e' estetico: l'MPL
    // e' la chiave con cui il team Integration apre l'esecuzione nel monitor e non si perde, il
    // testo e' identita' (una trentina di caratteri), la causa e' il dettaglio piu' lungo.
    // Solo per una CONFERMA: sul canale MATDOC il testo riga e' un'altra cosa.
    const failConfText = isConf && data.confirmation
      ? String(data.confirmation.ConfirmationText || '').trim()
      : '';
    const detailSegs = [
      ...(failConfText ? [logMsg.seg('logConfConfirmationText', failConfText)] : []),
      ...groupSegs,
      ...(r.mplId ? [logMsg.seg('logConfMpl', r.mplId)] : []),
      ...(r.message || r.reason || r.error ? [logMsg.technical(r.message || r.reason || r.error)] : [])
    ];
    const attempt = renderMsg([attemptSeg]);
    const detail = renderMsg(detailSegs);
    console.error(`>>> [ERRORE] ${objectKey} (${attempt}${permanent ? ', PERMANENTE' : ''}): ${detail}`);
    // Semantica di retry nel recap (invariata dalla 0009, RB-24):
    //   primo fallimento -> 'E'  notizia nuova, qualcuno deve guardare
    //   retry in corso   -> 'W'  il sistema se ne sta occupando: con 'E' ogni destinatario
    //                            ON_ERROR riceverebbe una mail a ogni run della finestra di retry
    //   permanente       -> 'X'  serve intervento manuale (non conta nell'exit code)
    // `verdict.reason` viene da confMatDoc.js / prodOrderConfPost.js, ancora a prosa: lacuna
    // dichiarata (grep logMsgVerbatim), non un testo che entra in silenzio in una colonna tradotta.
    const failSegs = verdict.permanent
      ? [logMsg.verbatim(verdict.reason), ...detailSegs]
      : (permanent
        ? [attemptSeg, logMsg.seg('logConfRetriesExhausted'), ...detailSegs]
        : (newCount === 1
          ? [attemptSeg, ...detailSegs]
          : [attemptSeg, logMsg.seg('logConfRetryInProgress'), ...detailSegs]));
    // [ORDER-LOG-OP] Anche il rifiuto e' un'operazione avvenuta su quell'ordine: la chiamata e'
    // partita e SAP ha risposto no. La riga porta il corpo del rifiuto, che e' cio' che serve.
    const koCounter = await writeOrderExcLog(db, doc, {
      isConf, status: 'E', segments: failSegs, r, response
    });
    const koRef = excLog.logRefFor(doc.ManufacturingOrder, koCounter);
    // Semantica di retry invariata: la 'X' non conta nell'exit code, la 'W' non rimanda una mail a
    // ogni run della finestra di riprova.
    if (verdict.permanent) rec('X', failSegs, koRef);
    else if (permanent) rec('X', failSegs, koRef);
    else if (newCount === 1) rec('E', failSegs, koRef);
    else rec('W', failSegs, koRef);
  };

  for (const doc of candidates) {
    const max = maxRetryByPlant.get(doc.Plant);
    const unlimited = max === null || max === undefined || max <= 0;
    const { isConf, objectKey, rec } = recFor(doc);

    // [MATDOC-FIX] Riga già al limite ma ancora 'E'. PRIMA si limitava ad annunciarlo e proseguiva:
    // la riga restava 'E', veniva riselezionata a OGNI run, consumava il tetto per esecuzione e la
    // madre continuava a dire «in attesa di registrazione» — un rosso permanente che nessuno poteva
    // togliere. Ora si PARCHEGGIA, che è ciò che l'annuncio diceva già di aver fatto.
    if (!unlimited && (doc.RetryCount || 0) >= max) {
      const atLimit = [logMsg.seg('logConfRetryAtLimit', doc.RetryCount, max)];
      await db.run(UPDATE(E_MAT_DOC).set({
        Status: 'X',
        FailureClass: doc.FailureClass || 'T',
        ...msgCols(atLimit, 'MessageText', 'MessageTextJson'),
        UpdatedAt: now.toISOString()
      }).where({ PlexEntryId: doc.PlexEntryId, DocSeq: doc.DocSeq }));
      touched.add(doc.PlexEntryId);
      rec('X', atLimit);
      out.exhausted++;
      continue;
    }

    // [MATDOC-FIX] IL VERSAMENTO NON PARTE PRIMA DEL CONSUMO, e non basta l'ordinamento.
    //
    // I candidati sono ordinati per (PlexEntryId, DocSeq), quindi l'uscita merci viene TENTATA
    // prima dell'entrata — ma ogni giro del ciclo era indipendente, e tutte e quattro le
    // combinazioni erano raggiungibili: consumo riuscito + versamento riuscito, entrambi falliti,
    // e le due miste. Fra queste, «versamento riuscito e consumo no» mette in SAP un'entrata merci
    // del prodotto finito senza l'uscita dei suoi componenti, e `refreshEntryStatus` la collassa in
    // uno stato in cui è indistinguibile da una registrazione mai inviata.
    //
    // Il caso più insidioso non è il fallimento: è l'esito NON CONCLUSIVO sul '03' (DEC-60), che
    // `classifyFailure` marca permanente proprio perché il movimento POTREBBE essere passato.
    // Anche là il versamento non deve partire: si aspetta che un umano guardi.
    //
    // Il consumo che manca NON è un fallimento del versamento: la riga resta 'E' e al run
    // successivo, quando il '03' sarà 'S', partirà. Per questo non si tocca `RetryCount`.
    //
    // DUE ECCEZIONI, e sono quelle in cui NIENTE viene registrato in SAP, quindi non c'è nessun
    // ordine da sbilanciare:
    //   - REGISTRAZIONE IN PROVA (`ZPlant.MatDocPostEnabled` non abilitato): SAP valida e non
    //     registra, e il '03' resta 'E' di proposito per non consumare tentativi. Bloccare qui il
    //     '02' toglierebbe alla prova proprio quello per cui esiste — la prima risposta vera di SAP
    //     sul 101, che in questo repo non è mai stata osservata;
    //   - LEVA SPENTA (`MATDOC_POST=off`): non parte nulla, e il recap lo dichiara già una volta per
    //     tutte. Un avviso per ogni versamento sarebbe rumore su una condizione voluta.
    if (doc.DocSeq === DOC_RECEIPT) {
      if (offEntries.has(doc.PlexEntryId)) {
        out.disabled++;
        continue;
      }
      const issue = await db.run(
        SELECT.one.from(E_MAT_DOC).columns('Status', 'TestRun', 'MessageText')
          .where({ PlexEntryId: doc.PlexEntryId, DocSeq: DOC_ISSUE })
      );
      // [MATDOC-CLAIM] Se il consumo è IN VOLO se l'è preso un altro run, e lo sta spedendo adesso:
      // il versamento è suo, non nostro. Si esce in silenzio, senza avviso, perché non c'è niente
      // di storto — dichiararlo riempirebbe il recap a ogni sovrapposizione, che è legittima.
      if (issue && issue.Status === claimRules.STATUS_IN_FLIGHT) {
        out.claimTaken++;
        continue;
      }
      // [CONF-POSTING] IL GATE TRATTIENE SOLO SE IL CONSUMO ESISTE, e la differenza non e' una
      // sfumatura: era un difetto.
      //
      // `if (!consumoFatto)` con `issue` assente rinviava un versamento che NON avra' mai un
      // consumo — e non riparte da se', perche' il guardiano `already` della fase B1 non ricostruisce
      // piu' i documenti di quella registrazione. Restava in attesa per sempre, con una `W` a ogni
      // esecuzione. Il caso e' quello dichiarato in confMatDoc (`perimetroVuotoLecito`): con
      // `ConsumeAt = 'EACH_OP'` un'operazione senza componenti propri emette il solo '02', perche' i
      // componenti sono gia' usciti alle LORO operazioni e l'ordine non e' sbilanciato.
      //
      // «Non esiste» e «esiste e non e' passato» sono due cose diverse — la stessa distinzione fra
      // «vuoto» e «non lo so» su cui poggia tutta la 0028 — e il gate riguarda solo la seconda.
      const consumoFatto = !issue || issue.Status === 'S' || issue.TestRun === true;
      if (!consumoFatto) {
        out.heldBack++;
        rec('W', [logMsg.seg('logConfReceiptHeldBack', issue.Status)]);
        continue;
      }
    }

    // [CONF-POSTING] IL GATE DELLA CONFERMA STA PRIMA DELLA PRENOTAZIONE (feature 0030).
    //
    // Se non si deve chiamare, la riga non deve entrare in volo: una 'P' su una chiamata mai partita
    // verrebbe parcheggiata 'X' dalla raccolta delle prenotazioni scadute, come se un run fosse
    // morto — su una leva spenta di proposito.
    //
    // DUE CASI, DUE RIGHE DI RECAP, perche' i rimedi sono diversi: l'interruttore del plant si
    // accende nella scheda «Consuntivazione», e una configurazione non leggibile e' un guasto da
    // guardare. Contarli insieme direbbe «N conferme non inviate» senza dire a chi rivolgersi.
    //
    // ERANO TRE. Il terzo era la variabile d'ambiente `PRODCONF_POST`, che la 0030 aveva promosso da
    // leva della sonda a cancello del flusso vero (DEC-94): stava a `off` in produzione e si apriva
    // solo con un RILASCIO, quindi la scheda del plant poteva dichiarare «invia le conferme d'ordine
    // a SAP» e questo job non mandarne nessuna — dichiarandolo nel recap, ma senza che nessuna
    // schermata dicesse perche'. Un job batch che parte dallo scheduler DEVE scrivere: e' la stessa
    // ragione con cui la 0046 ha tolto `ORDER_STATUS_POST` dai suoi due flussi d'esercizio.
    //
    // I DUE CASI CHE RESTANO HANNO UN RIMEDIO IN MANO A UNA PERSONA, e nessuno dei due richiede un
    // rilascio. L'interruttore e' ora uno solo, ed e' fail-closed per default
    // (`ConfPostEnabled : Boolean not null default false`): togliere la leva non ha aperto niente.
    if (isConf) {
      const cfg = await confConfigFor(doc.Plant);
      if (cfg.readError) {
        // Non si ricade sul default: il default e' `MATDOC`, e con documenti di conferma gia'
        // costruiti significherebbe non mandarli mai senza dirlo. La riga resta 'E'.
        bump(confSkipped.unreadable, doc.Plant);
        out.confHeld++;
        continue;
      }
      if (!cfg.ConfPostEnabled) {
        bump(confSkipped.disabled, doc.Plant);
        out.confHeld++;
        continue;
      }
    }

    // [CONF-GROUP] LA CONFERMA NON PARTE DA QUI: si raccoglie per ordine, e il secondo passaggio la
    // spedisce sommata a quelle dello stesso ordine — le nuove e quelle da ritentare. Il tetto gia'
    // raggiunto e il gate qui sopra restano per documento: chi non deve partire non entra nel gruppo.
    if (isConf) {
      const key = groupRules.groupKey(doc);
      if (!confGroups.has(key)) confGroups.set(key, []);
      confGroups.get(key).push(doc);
      continue;
    }

    if (!(await claimDoc(doc, rec))) continue;
    const data = await readPayload(doc, rec, false);
    if (!data) continue;
    const callOpts = {
      label: `PROD_CONF ${doc.ManufacturingOrder || `senza ordine ${doc.PlexEntryId}`} doc ${doc.DocSeq}`,
      correlationId: `${JOB_CODE}-${doc.PlexEntryId}-${doc.DocSeq}`
    };
    const r = await postMaterialDoc(data, callOpts);
    touched.add(doc.PlexEntryId);
    // [MATDOC-TRACE] Lo scambio INTERO (feature 0031): corpo inviato, corpo ricevuto, header
    // mascherati e diagnosi. E' cio' che la scheda «Consuntivi» del cockpit mostra.
    await settle(doc, {
      isConf, objectKey, rec, max, unlimited, data, r,
      response: exchangeJson(r), stamp: new Date(), group: null
    });
  }

  // =========================================================================================
  // [CONF-GROUP] LE CONFERME D'ORDINE, UNA CHIAMATA PER ORDINE (25/09/2026).
  //
  // Con N registrazioni sullo stesso ordine partivano N chiamate di fila sullo stesso oggetto SAP, e
  // si prendevano errori di lock. Ora le conferme dello stesso ordine si SOMMANO in una chiamata sola
  // (regole pure in srv/lib/confGroupRules.js), e l'esito vale per tutte: `OrderID` uguale a quello
  // mandato, tutte registrate; altrimenti tutte da ritentare, ognuna con i suoi tentativi.
  //
  // SI SOMMA SOLO CIO' CHE QUESTA RUN HA PRENOTATO. Una riga presa da un altro run la sta spedendo
  // lui: sommarla qui la confermerebbe due volte. Con una registrazione sola la chiamata e' quella
  // di prima, byte per byte: stesso corpo, stessa etichetta, stesso correlation id.
  const readLots = async (ready) => {
    try {
      const rows = await db.run(SELECT.from(E_CONF_ENTRY).columns('PlexEntryId', 'PlexJobNumber')
        .where({ PlexEntryId: { in: ready.map((x) => x.doc.PlexEntryId) } })) || [];
      return new Map(rows.map((e) => [e.PlexEntryId, e.PlexJobNumber]));
    } catch (e) {
      // Il lotto serve solo al testo: senza, il testo nomina l'ordine. Non ferma la conferma.
      console.error(`>>> [CONF-GROUP] lotti Plex non letti (${e.message}): il testo nomina l'ordine`);
      return new Map();
    }
  };

  for (const docs of confGroups.values()) {
    const ready = [];
    for (const doc of docs) {
      const { rec } = recFor(doc);
      if (!(await claimDoc(doc, rec))) continue;
      const data = await readPayload(doc, rec, true);
      if (data) ready.push({ doc, data });
    }
    if (!ready.length) continue;

    const lots = ready.length > 1 ? await readLots(ready) : new Map();
    const calls = groupRules.mergeConfirmations(
      ready.map((x) => ({ key: x.doc.PlexEntryId, confirmation: x.data.confirmation })), { lots });

    for (const [i, call] of calls.entries()) {
      const members = call.keys.map((k) => ready.find((x) => x.doc.PlexEntryId === k));
      const first = members[0].doc;
      const single = members.length === 1;
      const callOpts = single
        ? {
          label: `PROD_CONF ${first.ManufacturingOrder || `senza ordine ${first.PlexEntryId}`} doc ${first.DocSeq}`,
          correlationId: `${JOB_CODE}-${first.PlexEntryId}-${first.DocSeq}`
        }
        : {
          label: `PROD_CONF ${first.ManufacturingOrder} ${members.length} conferme`,
          correlationId: `${JOB_CODE}-${first.ManufacturingOrder}-${runId || now.toISOString()}`
            + (calls.length > 1 ? `-${i + 1}` : '')
        };
      // [CONF-POSTING] LA CHIAMATA DELLA CONFERMA STA IN UN try/catch, e non perche' lanci: non lancia,
      // per contratto. Ma una riga rimasta 'P' per un'eccezione inattesa e' un movimento contabile che
      // nessuno rispedira' piu', e la differenza fra «non lo so» e «no» qui costa una conferma persa.
      let r;
      try {
        r = await postOrderConfirmation(single ? members[0].data : { confirmation: call.confirmation }, callOpts);
      } catch (e) {
        r = {
          outcome: 'KO', httpStatus: null, message: '', messageType: '', messageId: '',
          messageNumber: '', mplId: '', reason: '', testRun: '',
          confirmationGroup: '', confirmationCount: '', rowCount: 0,
          error: `eccezione inattesa durante l'invio della conferma: ${e.message}`
        };
      }
      const stamp = new Date();
      // Lo scambio porta il corpo SOMMATO, cioe' quello davvero inviato: e' lo stesso su ogni riga.
      const response = exchangeJson(r);
      const group = single ? null : {
        size: members.length,
        qtyText: confRules.confQtyText(call.confirmation.ConfirmationYieldQuantity,
          call.confirmation.ConfirmationUnit)
      };
      for (const x of members) {
        touched.add(x.doc.PlexEntryId);
        const max = maxRetryByPlant.get(x.doc.Plant);
        const unlimited = max === null || max === undefined || max <= 0;
        const { isConf, objectKey, rec } = recFor(x.doc);
        await settle(x.doc, { isConf, objectKey, rec, max, unlimited, data: x.data, r, response, stamp, group });
      }
    }
  }

  for (const key of touched) await refreshEntryStatus(db, key, now);

  if (summary) {
    for (const [plant, n] of testRunByPlant) {
      summary.scope({
        plant, objectKey: 'MATDOC_TEST_RUN', status: 'W',
        segments: [logMsg.seg('logConfTestRun', n)]
      });
    }
  }

  // [CONF-POSTING] LE DUE RAGIONI PER CUI UNA CONFERMA NON PARTE, una riga per ciascuna:
  // l'interruttore nella scheda del plant, e una configurazione illeggibile che e' un guasto.
  // Contarle insieme direbbe «N conferme non inviate» senza dire a chi rivolgersi.
  //
  // La terza — `CONF_POST_OFF`, la leva d'ambiente — e' un codice di recap RITIRATO: vedi il gate.
  if (summary) {
    // Il CONTEGGIO e' un parametro della chiave, non un pezzo di frase incollato davanti: in un'altra
    // lingua il numero non sta necessariamente all'inizio.
    const dichiara = (mappa, key, status, code) => {
      for (const [plant, n] of mappa) {
        summary.scope({ plant, objectKey: key, status, segments: [logMsg.seg(code, n)] });
      }
    };
    dichiara(confSkipped.disabled, 'CONF_POST_NOT_ENABLED', 'W', 'logConfPostNotEnabled');
    dichiara(confSkipped.unreadable, 'CONF_POST_CONFIG', 'E', 'logConfPostConfigUnreadable');
  }

  // Una leva spenta è una condizione di esercizio, non un dettaglio di log: se nessuno la
  // dichiara, il run chiude verde con zero movimenti e sembra che non ci fosse niente da fare.
  if (out.disabled && summary) {
    summary.scope({
      objectKey: 'MATDOC_POST_OFF', status: 'W',
      segments: [logMsg.seg('logConfPostOff', out.disabled)]
    });
  }

  // [MATDOC-CLAIM] Un run che non riesce a leggere quante righe ha prenotato non registra NIENTE,
  // ed e' esattamente il modo di rompersi che questa feature e' nata per chiudere: va dichiarato una
  // volta, forte, invece di apparire come «zero documenti inviati».
  if (out.claimUnknown && summary) {
    summary.scope({
      objectKey: 'CLAIM_UNREADABLE', status: 'E',
      segments: [logMsg.seg('logConfClaimUnreadable', out.claimUnknown)]
    });
  }
  if (out.staleParked && summary) {
    summary.scope({
      objectKey: 'STALE_CLAIMS_PARKED', status: 'W',
      segments: [logMsg.seg('logConfStaleParked', out.staleParked)]
    });
  }

  console.log(`>>> [MATDOC-CONF] invio: registrati ${out.sent}, falliti ${out.failed},`
    + ` permanenti ${out.exhausted}, in prova ${out.testRun}, non inviati ${out.disabled},`
    + ` versamenti rinviati ${out.heldBack}, prenotati da altri ${out.claimTaken},`
    + ` in volo parcheggiati ${out.staleParked}, conferme trattenute ${out.confHeld}`);
  return out;
}

// =============================================================================================

/**
 * @param {object} [summary] collettore del riepilogo di fine job (srv/lib/jobSummary.js).
 * @param {{db?: object, runId?: string}} [jobCtx] il contesto che runJob passa al `main`. Il
 *   `runId` serve alla PRENOTAZIONE dei documenti ([MATDOC-CLAIM]): marca CHI ha preso la riga,
 *   cosi' una prenotazione rimasta in volo si lega alla testata di run che l'ha lasciata la'. Prima
 *   questo job lo buttava via, perche' `main: (summary) => run(summary)`.
 */
async function run(summary, jobCtx = {}) {
  console.log(`>>> [JOB ProdOrderConfirmation] avvio (profilo: ${cds.env.profiles?.join(',') || 'default'})`);

  const db = await cds.connect.to('db');
  const s4prod = await prodOrderSource();          // [IS-SOURCE]
  if (summary) {
    summary.note([logMsg.seg('logConfOrderSource', s4prod.mode, s4prod.originDetail)]);
  }

  const ctx = {
    db,
    summary,
    // [MATDOC-CLAIM] `runId` marca la prenotazione dei documenti. Se manca — un chiamante che
    // invoca `run()` a mano — la prenotazione funziona comunque: e' lo stato 'P' a proteggere, il
    // run e' solo l'etichetta di CHI.
    runId: jobCtx.runId || null,
    now: new Date(),
    loadOrder: createOrderCache(s4prod),
    // [CONF-POSTING] Il dizionario delle part Plex letto al contrario, per il solo scarto di un pezzo
    // gia' versato. E' PIGRO: costruirlo qui non legge niente, e su un run senza scarti
    // post-produzione resta vuoto.
    matDict: createPlexMatDictionary(db),
    // [CONF-POSTING] Anche questa e' PIGRA e per ordine: un run in cui nessun plant ha configurato un
    // perimetro non legge mai le due tabelle del ciclo.
    plexAlloc: createPlexAllocationCache(db),
    windowCfg: readWindowConfig(),
    permanentMessages: readPermanentMessages()
  };

  // Gate licenza (stesso choke-point degli altri job). Vale anche per la LETTURA: con un tenant per
  // plant «leggere» significa presentarsi con le credenziali di quel cliente, e un plant fuori
  // licenza non deve farlo (0020).
  const usablePlants = await resolveActivePlants(db);

  // FASE A — le tre sorgenti Plex, per plant, ognuna col proprio watermark.
  const ingest = await ingestAllPlants(ctx, usablePlants);
  if (summary) {
    summary.note([logMsg.seg(
      'logConfIngestNote',
      ingest.reads - ingest.readFailures, ingest.reads,
      ingest.ingested, ingest.duplicates, ingest.quarantined, ingest.ignored
    )]);
  }

  // FASE A-bis — la quarantena si ri-risolve: chi era senza mapping può averlo adesso.
  await requeueQuarantined(ctx);

  // FASE B1 — dalle registrazioni ai documenti materiale.
  const build = await buildPendingDocuments(ctx, usablePlants);
  if (summary) {
    summary.note([logMsg.seg(
      'logConfBuildNote', build.documents, build.built, build.ignored, build.blocked
    )]);
  }

  // FASE B2 — invio verso l'iFlow, con retry per plant e classificazione del fallimento.
  const { sent, failed, exhausted, testRun, disabled, heldBack } =
    await sendPendingDocuments(ctx, usablePlants);

  console.log(`>>> [JOB ProdOrderConfirmation] completato — registrati: ${sent}, falliti: ${failed},`
    + ` permanenti: ${exhausted}, in prova: ${testRun}, non inviati: ${disabled},`
    + ` versamenti rinviati: ${heldBack}`);
  return { sent, failed };
}

// Bootstrap condiviso (srv/jobs/lib/runJob.js): carica e linka il modello, crea il riepilogo di
// esecuzione, garantisce che venga chiuso e che il recap parta anche in caso di errore fatale, e
// calcola l'exit code (non-zero = fallimenti, per il Job Scheduler).
// Eseguito SOLO quando il file è lanciato direttamente; quando importato NON si auto-esegue.
if (require.main === module) {
  const { runJob } = require('./lib/runJob');
  // serveAll non serve: questo job usa solo servizi remoti (cds.requires) e il db.
  runJob({ jobCode: JOB_CODE, serveAll: false, main: (summary, jobCtx) => run(summary, jobCtx) });
}

module.exports = {
  run,
  // Esposte per i test e per il riuso: la risoluzione e la costruzione sono le parti che si
  // vorranno provare da fuori senza far partire un run.
  resolveEntry,
  createOrderCache,
  ingestSource,
  // Il giro delle finestre: e' l'unita' che porta il punto di ripresa a `now`, e la sola parte
  // della fase A che aveva zero test fino al 09/09/2026.
  catchUpSource,
  requeueQuarantined,
  buildPendingDocuments,
  sendPendingDocuments,
  refreshEntryStatus
};

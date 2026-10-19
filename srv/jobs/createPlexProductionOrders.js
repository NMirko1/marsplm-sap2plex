/**
 * Job BTP — Creazione ordini di produzione (Job) in Plex a partire da SAP.
 *
 * In loop sugli ordini di produzione SAP **rilasciati**:
 *   1. verifica che l'ordine non sia già stato inviato a Plex (tabella delta
 *      ZProdOrderPlexMapping): salta quelli con esito precedente = Success;
 *   2. crea (o aggiorna) il Job su Plex seguendo il foglio "Jobs Creation":
 *        - step 1 Check Part      GET  /mdm/v1/parts
 *        - step 2 Check Job       GET  /scheduling/v1/jobs
 *        - step 3 Update Job      PUT  /scheduling/v1/jobs/{id}      (se esiste)
 *        - step 4 Add Job         POST /scheduling/v1/jobs           (se non esiste)
 *        - step 5 Backwards Sched POST /scheduling/v1/jobs/{id}/backwards-schedule
 *                                 (fallito: esito degradato a 'W', ma la sequenza PROSEGUE —
 *                                  un job non schedulato ha comunque una distinta da allineare,
 *                                  vedi [SCHED-CONTINUE] al passo 5)
 *        - step 6 (Data Source)   allineamento stato operazioni Job (NOT Required)
 *        - step 7 (Data Source)   allineamento Job BOM (Active=0)
 *        - step 8 (Data Source)   ordinamento della lista di lavoro Plex (feature 0014),
 *                                 solo per i plant con la configurazione abilitata; il suo
 *                                 esito NON altera l'esito dell'ordine (FR-20)
 *   3. traccia l'esito su ZProdOrderPlexMapping (delta) e ZProdOrderExcLogHDR/POS
 *      (storico request/response JSON), rendendo il flusso idempotente.
 *
 * [PLEX-CONN] È il **customizing** (ZPlexConnConfig) a decidere il server Plex Connect, e lo
 * decide PER PLANT: la connessione si risolve col plant dell'ordine in lavorazione.
 * Vedi srv/lib/plexConnection.js.
 *
 * Eseguito dal SAP BTP Job Scheduler tramite:
 *     node srv/jobs/createPlexProductionOrders.js
 * (oppure `npm run job-create-plex-orders`).
 *
 * Profili di connessione (package.json -> cds.requires):
 *   - development : SAP API Business Hub sandbox (APIKey)
 *   - hybrid/prod : destination `MARS_SAP_CON`
 */

const cds = require('@sap/cds');
const {
  resolveActivePlants,
  plexGet,
  plexPost,
  plexPut,
  executeDataSource
} = require('./lib/plexJobsClient');
// [PLEX-CONN] Connessione a Plex PER PLANT (feature 0020): punto unico, condiviso con gli
// handler CAP. Prima il job risolveva UNA connessione globale per l'intero run.
const { resolvePlexConnection, PlexConnectionMissing } = require('../lib/plexConnection');

// [JOB-READ] Le regole di lettura di un job su Plex (id-first, DEC-80): condivise con lo
// spacchettamento, con il loro test — node test/plexJobRead.test.js
const plexJobRead = require('../lib/plexJobRead');
// [JOB-BUILDING] `buildingCode` -> `buildingId`: il campo che il PUT di aggiornamento pretende di
// fatto e che un job creato senza rende impossibile. Test: node test/plexBuildings.test.js
const plexBuildings = require('../lib/plexBuildings');

// [IS-SOURCE] Sorgente dell'area ordini (feature 0013): canale scelto da PROD_ORDER_SOURCE.
const prodOrderSource = require('../lib/prodOrderSource');
const {
  operationsFilter, componentsFilter, keepOperationsOfOrder, keepComponentsOfOrder
} = prodOrderSource;

// [ORDER-ROWS] LA lettura del perimetro ordini, condivisa con la lista del cockpit: colonne, tetto
// e ORDINE di costruzione della query vivono la', in un punto solo. Prima questa lettura e quella
// del cockpit erano scritte in due posti e differivano — nel `$select` e nell'ordine dei parametri
// dell'URL — senza che niente lo dichiarasse.
const orderRows = require('../lib/orderRows');

// [ORDER-STATUS-FILTER] Perimetro degli ordini per stato, customizing per plant (feature 0017).
// Ha SOSTITUITO il criterio cablato «rilasciato, non chiuso, non cancellato» che stava qui: ora
// il perimetro lo decide il cliente, plant per plant, e lo stesso modulo lo applica alla lista
// del cockpit. FAIL-CLOSED: un plant senza configurazione non produce ordini.
const prodOrderStatusFilter = require('../lib/prodOrderStatusFilter');

// Passo 8 — ordinamento della lista di lavoro Plex (feature 0014). L'orchestrazione sta in
// srv/lib/plexJobSort.js e le regole (payload, interpretazione, contatori, testi del recap) nel
// modulo puro srv/lib/plexJobSortRules.js.
const { runJobSortStep, resolveSortConfig } = require('../lib/plexJobSort');
// [PHANTOM-EXPLODE] Esplosione dei componenti fantasma (feature 0019), customizing per plant.
const bomExplode = require('../lib/bomExplode');
// [JOB-FIELDS] Campi della testata job ricavati dall'ordine SAP (jobType <- AUART): regola pura,
// condivisa con la creazione del pacchetto dello spacchettamento.
const {
  jobTypeField,
  inheritedJobFields,
  schedulingWindow,
  earliestStartField,
  quantityOf,
  jobPutBodies
} = require('../lib/plexJobFields');
// [ORDER-QTY-SYNC] Le regole pure del riallineamento quantita' (feature 0033). Servono al passo 3,
// che e' il punto in cui il `PUT` verso Plex gia' esiste: cosi' la formula sta in UN posto solo e
// vale sia qui sia nel percorso mirato degli ordini spacchettati (srv/lib/orderQtySync.js).
const qtyRules = require('../lib/orderQtyRules');
const orderQtySync = require('../lib/orderQtySync');
// [SCHED-CONTINUE] Testo di una risposta Plex non riuscita: stato PIU' il corpo che Plex ha
// mandato. Funzione pura, la stessa che lo spacchettamento usa sul backwards-schedule.
// [PLEX-CALL] Dello stesso modulo serve anche `wrap`: il passo 5 e' l'unica chiamata di questa
// sequenza che si vuole leggere PER INTERO, in `cf logs` e nella console del cockpit.
const plexCallTrace = require('../lib/plexCallTrace');
const { plexErrText } = plexCallTrace;
// [COMP-EXCL] Esclusione configurabile dei componenti dell'ordine, per plant.
const orderCompExcl = require('../lib/orderCompExcl');
const orderCompExclRules = require('../lib/orderCompExclRules');
// [ORDER-COMP-REMOVE] Rimozione manuale di un componente dall'albero dell'ordine (feature 0026).
const orderCompRemoval = require('../lib/orderCompRemoval');
const orderCompRemovalRules = require('../lib/orderCompRemovalRules');
// [ORDER-MAP-JOB] Il dizionario dei job si scrive solo se un job su Plex esiste: una riga con
// `PlexJobId` vuoto veniva letta come «l'ordine e' gia' uscito». Puro: node test/orderMappingWrite.test.js
const orderMappingRules = require('../lib/orderMappingRules');
// [PART-QUERY] Gli indirizzi del Parts API in un punto solo: il filtro e' `number`, non
// `partNumber`, e le letture stanno su v2. Test: node test/plexPartQuery.test.js
const plexPartsApi = require('../lib/plexPartsApi');
// [ORDER-BOM-ADD] Allineamento ADDITIVO della distinta della part prima che il job nasca (0025).
// Verso opposto al passo 7.2, e su un oggetto diverso: la' si sottrae dal JOB, qui si aggiunge
// alla PART — che e' l'unico momento in cui Plex la guarda per costruire la distinta del job.
const orderBomAdd = require('../lib/orderBomAdd');
const orderBomAddRules = require('../lib/orderBomAddRules');
const { addSortStat, sortRecapEntries, guardSortOnWrite } = require('../lib/plexJobSortRules');
// [ORDER-CYCLE-SEED] Il ciclo dell'ordine, seminato dal ciclo salvato del materiale al primo
// sguardo. Lo stesso modulo che usa l'action `autoImportPlexCycle` del server: la scelta del
// modello e la scrittura sono una sola, in due processi. Perimetro: grep -rn "ORDER-CYCLE-SEED".
const orderCycleSeed = require('../lib/orderCycleSeed');
// [JOB-OP-ALIGN] Quali operazioni del job Plex vanno disattivate: regole pure, con il loro test —
// node test/jobOpAlignRules.test.js. Il catalogo operazioni del tenant e' l'anello che traduce il
// CODICE che la Data Source 4701 restituisce nell'UUID che il nostro albero conserva.
const jobOpAlignRules = require('../lib/jobOpAlignRules');
const opCatalog = require('../lib/plexOperationCatalog');
// L'albero Plex dell'ordine: la costante dell'entita' sta accanto a chi lo legge per il perimetro
// componenti della consuntivazione (feature 0028), e non si ridichiara qui.
const { E_CYCLE_OP } = require('../lib/plexCycleAllocation');
// Sorgente d'area CICLI: serve solo al perimetro cicli del passo di semina (testata del ciclo).
const routingSource = require('../lib/routingSource');
// [LOG-MSG-I18N] I messaggi di questo modulo finiscono nella colonna `Message` dello storico
// dell'ordine, e prima erano frasi italiane cablate: `processOrder` non riceve `req` — e' chiamato
// sia dal job sia dalla UI — quindi non poteva localizzare niente. Ora porta SEGMENTI, e chi legge
// li rende nella propria lingua (feature 0029).
const logMsg = require('../lib/logMessage');
// [ORDER-LOG-OP] Lo storico invii dell'ordine: writer condiviso con TECO e consuntivazione (0031).
const excLog = require('../lib/prodOrderExcLog');
const i18nMessages = require('../lib/i18nMessages');

const NS = 'avvaleplm.marsplm.sap2plex';
// Nomi entità fully-qualified (in contesto job standalone `db.entities` non è
// invocabile come funzione: si usano i nomi FQN come stringa nelle query CQL).
const E_MAPPING = `${NS}.ZProdOrderPlexMapping`;
const E_SPLIT = `${NS}.ZProdOrderSplit`;   // marcatura di ordine spacchettato (feature 0012)
// [ORDER-TECO] Stato della chiusura tecnica riportata su Plex (feature 0023): la sua sola
// ESISTENZA esclude l'ordine dalla ri-sincronizzazione.
const E_TECO_STATE = `${NS}.ZProdOrderTecoState`;

// ================================================================
// PLACEHOLDER — parametri di creazione Job non presenti sull'ordine SAP.
// L'utente non li ha ancora forniti: valorizzare più avanti (o via env).
// ================================================================
const BUILDING_ID = process.env.PLEX_BUILDING_ID || null;              // TODO/PLACEHOLDER
// [JOB-FIELDS] Non è più il valore di `jobType`, è il suo RIPIEGO: il valore primario è l'AUART
// dell'ordine (srv/lib/plexJobFields.js). Resta per i tenant in cui il job type non dipende
// dall'ordine.
const JOB_TYPE = process.env.PLEX_JOB_TYPE || null;
const PRIORITY = process.env.PLEX_JOB_PRIORITY || null;                // TODO/PLACEHOLDER
const JOB_NUMBER_PREFIX = process.env.PLEX_JOB_NUMBER_PREFIX || null;  // TODO/PLACEHOLDER
const JOB_NUMBER_SUFFIX = process.env.PLEX_JOB_NUMBER_SUFFIX || null;  // TODO/PLACEHOLDER
// [WC-FALSE] `useFirstApprovedWorkcenter` viaggia a FALSE, e il default cablato e' quello.
//
// Il contratto Plex descrive il campo cosi': «Indicates whether operations will be scheduled to first
// approved workcenter (True) or to all scheduled workcenters (False)», ed e' `false` l'esempio che il
// contratto stesso porta. L'API List del cliente annota di mettere False per schedulare su piu' centri
// di lavoro. Il `true` di prima era una scelta nostra, mai verificata con il cliente, e nel dossier
// del `500` figurava fra le due sole configurazioni che non avevamo mai provato — ma il difetto era
// altrove (era di Plex, corretto il 27/08/2026) e il valore NON si riporta a `true`: la ragione per
// cui e' `false` sono il contratto e l'API List, non l'indagine di allora.
//
// La variabile d'ambiente resta l'interruttore, nel verso opposto a prima:
// PLEX_USE_FIRST_APPROVED_WC=true riporta al valore precedente senza rilascio. Il gemello di questa
// costante sta in srv/lib/plexJobSplit.js e i due DEVONO restare allineati.
// Perimetro: grep -rn "WC-FALSE".
const USE_FIRST_APPROVED_WORKCENTER =
  (process.env.PLEX_USE_FIRST_APPROVED_WC || 'false') === 'true';      // step 5 e spacchettamento
// Numero massimo di ordini elaborati per esecuzione (0 = illimitato). Utile per
// il batching in produzione e per test controllati.
const MAX_ORDERS_PER_RUN = Number(process.env.PLEX_JOB_MAX_ORDERS || 0);
/**
 * [ORDER-QTY-SYNC] Tetto degli ordini sottoposti al CONTROLLO DI QUANTITA' per esecuzione
 * (0 = illimitato). Ha un default diverso da zero, a differenza del tetto qui sopra, e la ragione e'
 * strutturale: gli ordini gia' inviati si ACCUMULANO — un ordine entra in quell'insieme il giorno in
 * cui riesce e ci resta finche' non viene chiuso tecnicamente — quindi senza tetto la fase
 * crescerebbe di run in run e ogni ordine costa almeno una lettura verso Plex. Un tetto raggiunto si
 * DICHIARA nel recap: un troncamento silenzioso si legge come «controllati tutti».
 */
const QTY_CHECK_MAX_ORDERS = Number(
  process.env.PLEX_QTY_CHECK_MAX_ORDERS === undefined ? 500 : process.env.PLEX_QTY_CHECK_MAX_ORDERS
);

// Identificativi delle Data Source: elenco unico in srv/lib/plexDataSources.js (feature 0020).
// Prima erano dichiarati qui, e la 239905 andava importata da plexJobSort.js per non farla
// divergere: ora nessun file li dichiara per conto proprio.
const {
  DS_GET_JOB_KEY,          // 6.1
  DS_GET_JOB_OPS,          // 6.2
  DS_UPDATE_JOB_OP_STATUS, // 6.3
  DS_GET_JOB_BOM,          // 7.1
  DS_UPDATE_JOB_BOM,       // 7.2
  DS_JOB_SORT_ORDER        // 8 (feature 0014)
} = require('../lib/plexDataSources');
// Non e' un id di Data Source ma un INPUT del passo 6.3: resta qui, dove viene usato.
const JOB_OP_STATUS_KEY_NOT_REQUIRED = Number(process.env.PLEX_JOB_OP_STATUS_NOT_REQUIRED || 204);
// Tetto di attesa del passo 8 nel job PIANIFICATO: 0 = NESSUN tetto (decisione D-04), che e' il
// comportamento di ogni altra chiamata verso Plex del batch. La leva esiste perche' il rischio
// residuo R-5 sia sanabile su Cloud Foundry senza rilascio.
const SORT_BATCH_TIMEOUT_MS = Number(process.env.PLEX_JOB_SORT_BATCH_TIMEOUT_MS || 0);

// ================================================================
// Utility
// ================================================================

/** Converte una data SAP (Date | ISO string) in ISO 8601 UTC per Plex. */
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

/** Estrae l'array `rows` dalla risposta di una Data Source (format=2). */
function dsRows(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.rows)) return body.rows;
  return [];
}

/** Normalizza il body di una risposta Connect REST in array. */
function asArray(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  return body.value || body.results || body.data || [];
}

// ================================================================
// Lettura ordini SAP
// ================================================================

/**
 * Legge da SAP gli ordini di produzione IN PERIMETRO, con le relative operazioni e
 * componenti (necessari per gli step 6-7 di allineamento).
 *
 * [ORDER-STATUS-FILTER] (feature 0017) Il perimetro non è più cablato qui: lo decide il
 * customizing per plant (ZProdOrderFilterConfig), lo stesso che governa la lista del cockpit.
 * Un plant senza configurazione NON produce ordini — fail-closed — e la cosa finisce nel recap,
 * plant per plant: un plant che non lavora è un'informazione, non un silenzio.
 * [W1-09] Il customizing porta ora anche tipo ordine e responsabile di schedulazione, che è il
 * criterio con cui la BBP §8.2.1 definisce il perimetro Plex.
 *
 * @param {object} s4 - sorgente dell'area ordini
 * @param {Iterable<string>} activePlants - plant attivi E licenziati
 * @param {object} [summary] - recap di esecuzione
 * @returns {Promise<Array<object>>}
 */
async function loadOrdersInScope(s4, activePlants, summary = null, db = null) {
  // [ORDER-ROWS] L'entity non si prende piu' qui: la risolve il lettore condiviso da `s4.entities`,
  // perche' e' lui a costruire la query e l'entity fa parte di quella costruzione.
  const plantList = [...(activePlants || [])];
  if (!plantList.length) {
    console.log('>>> [JOB CreatePlexOrders] nessun plant attivo: nessun ordine da elaborare');
    return [];
  }

  // ================================================================
  // [ORDER-STATUS-FILTER] Perimetro per stato, per plant.
  // ================================================================
  const database = db || await cds.connect.to('db');
  const scope = await prodOrderStatusFilter.resolveOrderScope(database, plantList);

  for (const plant of scope.unconfigured) {
    const msg = 'Nessun perimetro per stato configurato per il plant'
      + ` ${plant}: nessun ordine considerato.`;
    console.log(`>>> [ORDER-STATUS-FILTER] ${msg}`);
    // scope() e non record(): non è un oggetto trattato, è una porzione di perimetro che non
    // ha prodotto lavoro. `degrade: false` perché è una scelta di configurazione, non un
    // guasto — un plant deliberatamente non configurato non deve tingere di giallo il run.
    // `status: 'S'` e non 'I': REC_STATUS non conosce 'I' e lo riscriverebbe in 'W', cioe' una
    // riga gialla per una scelta deliberata. E' la stessa forma delle informative della 0014.
    if (summary) {
      summary.scope({
        plant, objectType: 'PROD_ORDER_SCOPE', status: 'S', degrade: false,
        segments: [logMsg.seg('logOrderNoStatusScope', plant)]
      });
    }
  }
  if (!scope.configured.length) {
    console.log('>>> [ORDER-STATUS-FILTER] nessun plant configurato: nessun ordine da elaborare');
    return [];
  }
  console.log(`>>> [ORDER-STATUS-FILTER] criteri in vigore -> ${prodOrderStatusFilter.describeFilters(scope.byPlant)}`);

  const where = { ProductionPlant: { in: scope.configured } };

  // ================================================================
  // [IS-SOURCE] (M5/FR-15) I flag di stato NON hanno select-option dietro l'iFlow
  // (ZMARS_PROD_ORDER_GET, contratto E-13, richiesta R-2b): in modalità IS il `where` inviato
  // porta SOLO il perimetro plant e la selezione si applica A VALLE. In ONPREM è spingibile,
  // ma solo se il criterio è UNO — con criteri diversi per plant una query sola non può
  // portarli entrambi. Quando lo è, la query è identica a quella di prima della 0017 (TD-5).
  // Il log dichiara letti/tenuti: è il numero che misura il costo della deroga.
  //
  // [W1-09] I due criteri su VALORE non si spingono su nessun canale (il perché è in testa a
  // pushableWhere), quindi la loro presenza accende il ramo a valle ANCHE quando i flag sono
  // stati spinti: senza, in ONPREM il criterio su FEVOR non verrebbe mai valutato e il job
  // manderebbe su Plex ordini fuori perimetro.
  // ================================================================
  const common = prodOrderStatusFilter.commonFilter(scope.byPlant);
  const noCriteria = !!common && prodOrderStatusFilter.criteriaIsEmpty(common);
  const pushed = (s4.mode !== 'IS' && common && !noCriteria)
    ? prodOrderStatusFilter.pushableWhere(common)
    : null;
  if (pushed) Object.assign(where, pushed);
  const hasValues = prodOrderStatusFilter.hasValueCriteria(scope.byPlant); // [W1-09]
  const selectDownstream = !noCriteria && (!pushed || hasValues);

  // ================================================================
  // [ORDER-ROWS] LE COLONNE NON SI ELENCANO QUI: SONO LE STESSE DELLA LISTA DEL COCKPIT.
  //
  // Fino al 02/09/2026 questa lettura elencava 13 colonne mentre la lista del cockpit, sullo STESSO
  // service root e per lo STESSO plant, ne elencava 21 — e per due giorni la prima ha reso zero
  // righe e la seconda 41. Le 13 erano un sottoinsieme delle 21, quindi non erano la causa; ma
  // finche' i due elenchi restavano scritti in due punti diversi non era possibile DIMOSTRARLO, e
  // non si puo' chiedere a un team esterno «perche' questa risposta e' vuota?» portando due
  // richieste che non sono la stessa.
  //
  // Ora l'elenco vive in un punto solo (srv/lib/orderRows.js) e questa lettura usa `list`, cioe'
  // ESATTAMENTE quello del cockpit. Il prezzo, dichiarato in testa a quel modulo: entra anche
  // `OrderLongText`, oggi consegnato VUOTO dall'iFlow, che il giorno in cui la FM implementasse il
  // `READ_TEXT` andrebbe tolto da QUESTA lettura — che legge il perimetro intero, non una pagina.
  // ================================================================
  // [ORDER-TOP] IL TETTO NON E' OPZIONALE SU QUESTA LETTURA.
  //
  // Fino al 02/09/2026 questa `SELECT` non aveva `.limit()`, quindi CAP non emetteva `$top`, ed era
  // l'unica lista ordini del progetto in quella forma. NON e' provato che fosse la causa dello zero
  // di quei due giorni — col tetto messo la lettura rende ancora zero righe, e la variabile
  // superstite e' il CANALE (vedi `[ORDER-SCOPE-EMPTY]` piu' sotto). Il tetto resta perche' vale da
  // se': verso questi iFlow una collection senza tetto e' un rischio comunque, e il sospetto di
  // troncamento della sorgente si accende SOLO se `$top` c'e' — senza limit non c'e' ne' tetto ne'
  // avviso. Il numero vive in prodOrderSource (uno solo per server web e job) e il suo
  // raggiungimento si DICHIARA qui sotto.
  //
  // Limite noto: `splitInList` clona `SELECT` e replica il `$top` su OGNI chunk, quindi con piu' di
  // `chunkSize` (15) plant nel criterio il tetto effettivo diventa `chunk x tetto`. Coi plant reali
  // (1 oggi, 3 a regime) non scatta, e non si introduce qui il trigger che nel cockpit in quel caso
  // ricade sulla lettura intera: sarebbe una seconda strada da tenere allineata per un caso che
  // questo job non ha.
  // ================================================================
  // [ORDER-ROWS] Il tetto e l'ordine di costruzione della query li decide il lettore condiviso:
  // `.columns().limit().where()`, cioe' l'ordine del cockpit, cioe' `$select&$top&$filter` sul filo.
  // Non e' un dettaglio estetico — vedi la testata di srv/lib/orderRows.js.
  // [RUN-BLOCKED] Questa lettura NON era in try/catch, ne' qui ne' in `run()`: l'errore risaliva
  // fino a runJob e diventava `fatal()`. L'esito era gia' rosso (exit 1), ma senza una riga che
  // nominasse la lettura, il canale e il tetto — e sono i tre numeri con cui si confrontano due
  // letture quando si apre un ticket a un team esterno (addendum del 02/09/2026 a DEC-83). La
  // testata di orderRows.js dichiara che il job deve trasformarlo «in una voce di recap», e il job
  // non lo faceva. Una riga SOLA e senza plant: e' una lettura unica su `Plant in (…)`, e un guasto
  // che riguarda tutti i plant si dichiara una volta sola.
  let read;
  try {
    read = await orderRows.readOrdersInScope(s4, { where, cfgs: scope.byPlant, kind: 'list' });
  } catch (error) {
    const segs = [
      logMsg.seg('logOrderScopeReadFailed', scope.configured.join(', '),
        s4.destination || '-', prodOrderSource.listMaxRows()),
      logMsg.technical(error.message)
    ];
    console.error(`>>> [ORDER-ROWS] ${renderMsg(segs)}`);
    // `status: 'E'` fa chiudere il run in errore ed uscire 1, come faceva il `fatal` di prima
    // (DEC-124): il perimetro non letto e' il caso in cui un verde mentirebbe di piu'.
    if (summary) {
      summary.scope({ objectType: 'PROD_ORDER_SCOPE', objectKey: 'SCOPE_READ', status: 'E', segments: segs });
    }
    return [];
  }
  const cap = read.cap;

  let orders = read.rows;

  // [ORDER-TOP] Un perimetro tagliato dal tetto NON passa per completo. Va nel recap e non solo in
  // `cf logs`, perche' in un job significa ordini che non sono stati inviati e nessuno lo saprebbe:
  // `scope()` e non `record()` (non e' un oggetto trattato, DEC-39), `degrade: true` perche' e'
  // l'opposto di una scelta di configurazione, e una `objectKey` PROPRIA o nel recap finirebbe
  // sotto la stessa chiave della lettura (lezione di DEC-115).
  if (orders.length >= cap) {
    const segs = [logMsg.seg('logOrderScopeTruncated', orders.length)];
    console.error(`>>> [ORDER-TOP] ${renderMsg(segs)}`);
    if (summary) {
      summary.scope({
        objectType: 'PROD_ORDER_SCOPE', objectKey: 'PROD_ORDER_SCOPE_TRUNCATED',
        status: 'W', degrade: true, segments: segs
      });
    }
  }
  // ================================================================
  // [ORDER-SCOPE-EMPTY] ZERO ORDINI LETTI NON CHIUDE IL RUN IN VERDE.
  //
  // Questa lettura NON porta criteri di stato — li applica il filtro a valle — quindi chiede a SAP
  // *tutti* gli ordini del plant. Zero righe su un plant configurato e licenziato non e' uno stato
  // di esercizio: e' il canale, i criteri, o le autorizzazioni dell'utenza con cui la lettura esce.
  //
  // PERCHE' VA DICHIARATO. Il 01-02/09/2026 questo job ha letto zero ordini per due giorni e ha
  // chiuso `S` con exit 0: nessun errore da nessuna parte, e il difetto e' emerso solo perche'
  // qualcuno ha confrontato il cockpit col log. Le voci di questo blocco coprivano il caso «il
  // criterio non aggancia» (`logOrderScopeFieldsBlank`) e non «la lettura non porta niente»: i due
  // contatori a valle sono vuoti PER COSTRUZIONE con zero righe (vogliono `rows > 0`), e il tetto
  // del troncamento qui sopra non scatta perche' `0 < cap`. Restava una `note()`, che non degrada.
  //
  // La voce e' PER PLANT perche' con tre plant serve sapere QUALE non risponde, e nomina il CANALE
  // su cui la lettura e' uscita (`s4.destination`): e' cio' che rende la prossima occorrenza
  // auto-diagnosticante invece di far ripetere l'indagine.
  //
  // `degrade: true`, e il prezzo si dichiara: su un plant che davvero non lavora questo diventa un
  // giallo ricorrente. E' accettato — una bugia verde e' costata due giorni — ed e' il tono che ha
  // gia' `logOrderScopeFieldsBlank` qui sotto. L'exit code non cambia (`scope()` non passa da
  // `bumpTotals`), quindi lo scheduler non vede un fallimento dove non c'e'.
  // ================================================================
  const readByPlant = new Map();
  for (const o of orders) {
    const p = String(o.ProductionPlant || '').trim();
    readByPlant.set(p, (readByPlant.get(p) || 0) + 1);
  }
  for (const plant of scope.configured) {
    if (readByPlant.get(String(plant).trim())) continue;
    const segs = [logMsg.seg('logOrderScopeEmpty', plant, s4.destination || '(non dichiarato)')];
    console.error(`>>> [ORDER-SCOPE-EMPTY] ${renderMsg(segs)}`);
    if (summary) {
      summary.scope({
        plant,
        objectType: 'PROD_ORDER_SCOPE',
        // Chiave PROPRIA: con quella del troncamento le due voci finirebbero sovrapposte nel
        // recap, e sono due difetti opposti (troppo e niente) — lezione di DEC-115.
        objectKey: 'PROD_ORDER_SCOPE_EMPTY',
        status: 'W', degrade: true, segments: segs
      });
    }
  }

  if (selectDownstream) {
    const read = orders.length;
    const f = prodOrderStatusFilter.applyStatusFilter(orders, scope.byPlant);
    orders = f.kept;
    const msg = `selezione di perimetro a valle: tenuti ${orders.length} di ${read} ordini letti`;
    console.log(`>>> [ORDER-STATUS-FILTER] ${msg}`);
    if (summary) summary.note([logMsg.seg('logOrderScopeDownstream', orders.length, read)]);

    // Un criterio che la sorgente non permette di valutare è un DIFETTO del canale, e con il
    // fail-closed si porta via tutti gli ordini di quel plant: è la sola voce di questo blocco
    // che DEVE degradare il run, altrimenti un iFlow incompleto fermerebbe la produzione con
    // un recap tutto verde.
    if (f.stats.unavailable.length) {
      const segs = [logMsg.seg('logOrderScopeFieldsUnavailable', f.stats.unavailable.join(', '))];
      console.error(`>>> [ORDER-STATUS-FILTER] ${renderMsg(segs)}`);
      if (summary) summary.scope({ objectType: 'PROD_ORDER_SCOPE', status: 'W', segments: segs });
    }

    // [W1-09] L'altra faccia dello stesso guasto: il campo arriva, ma è VUOTO su tutte le righe
    // lette. Il criterio è valutabile e non aggancia nulla, quindi l'esito è identico — nessun
    // ordine — e la causa no: campo non alimentato in SAP, oppure consegnato senza contenuto dal
    // canale (DEC-64). Degrada come sopra: un plant che non lavora per un difetto del filo non
    // può chiudere il run in verde.
    if (f.stats.blank.length) {
      const segs = [logMsg.seg('logOrderScopeFieldsBlank', f.stats.blank.join(', '))];
      console.error(`>>> [W1-09] ${renderMsg(segs)}`);
      if (summary) summary.scope({ objectType: 'PROD_ORDER_SCOPE', status: 'W', segments: segs });
    }
  }

  console.log(`>>> [JOB CreatePlexOrders] ordini in perimetro (plant attivi e configurati) letti: ${orders.length}`);
  return orders;
}

/**
 * Carica lazily operazioni e componenti di un ordine (servono solo agli step 6-7).
 * Chiamata per-ordine, dopo il delta, così da non interrogare SAP per ordini già
 * inviati o da saltare.
 */
async function loadOrderDetails(s4, order) {
  const { A_ProductionOrderOperation_2, A_ProductionOrderComponent_2 } = s4.entities;
  // [IS-QUERYGET-OPS] In IS la lettura delle operazioni è una collection sul `_QUERYGET` filtrata
  // sull'AUFPL, che arriva con la testata (loadReleasedOrders per il job, blocco A2 per lo
  // spacchettamento); il numero d'ordine NON è spinto, quindi va chiesto nel $select e verificato
  // sulle righe. In ONPREM è il filtro sul numero d'ordine di sempre (DEC-45 per la forma, DEC-42
  // per l'origine della chiave).
  // Chiave interna assente = lettura non eseguibile su questo canale: si LANCIA.
  // Un elenco vuoto allineerebbe Plex su operazioni e distinta inesistenti; l'errore, invece,
  // ferma quell'ordine e lo dice nel run log con la causa vera (DEC-42).
  const opWhere = operationsFilter(s4.mode, order);
  if (!opWhere) {
    throw new Error(`AUFPL non disponibile sulla testata dell'ordine ${order.ManufacturingOrder}`
      + ' (campo OrderInternalBillOfOperations vuoto): è il solo criterio contrattato su questo'
      + ' indirizzo, quindi le operazioni non sono leggibili su questo canale');
  }
  // [ORDER-TOP] Il tetto c'e' anche qui perche' un elenco di operazioni troncato in silenzio
  // fermerebbe l'ordine dichiarando una causa falsa («l'ordine non ha operazioni»). Non poggia
  // sulla causa attribuita allo zero di `PROD_ORDER` il 02/09 — «senza `IV_TOP` quella RFC rende
  // zero righe con esito OK» — che e' un'IPOTESI NON CONFERMATA: vedi srv/lib/prodOrderSource.js.
  const opRows = await s4.run(
    SELECT.from(A_ProductionOrderOperation_2)
      .columns('ManufacturingOrder', 'ManufacturingOrderOperation', 'MfgOrderOperationText', 'OperationIsReleased')
      .where(opWhere)
      .limit(prodOrderSource.DETAIL_MAX_ROWS.operations)
  );
  const own = keepOperationsOfOrder(s4.mode, order, opRows);
  if (own.dropped) {
    console.warn(`>>> [JOB CreatePlexOrders] ordine ${order.ManufacturingOrder}: scartate`
      + ` ${own.dropped} operazioni di ALTRI ordini (il numero d'ordine non è spinto su questo indirizzo)`);
  }
  order.operations = own.kept;
  // [IS-QUERYGET-COMP] In IS la lettura è una collection sul `_QUERYGET` filtrata sulla
  // prenotazione, che la testata veicola in MasterProductionOrder: il numero d'ordine NON è
  // spinto, quindi va nel $select e si verifica sulle righe. In ONPREM è il filtro sul numero
  // d'ordine di sempre (DEC-43 per la forma, DEC-42 per l'origine della chiave).
  const compWhere = componentsFilter(s4.mode, order);
  if (!compWhere) {
    throw new Error('Numero di prenotazione non disponibile sulla testata dell\'ordine '
      + `${order.ManufacturingOrder} (campo MasterProductionOrder vuoto): è il solo criterio`
      + ' contrattato su questo indirizzo, quindi i componenti non sono leggibili su questo canale');
  }
  const compColumns = ['ManufacturingOrder', 'Material', 'RequiredQuantity', 'BaseUnit',
    // [PHANTOM-EXPLODE] Il flag del fantasma e l'operazione. Prima non li chiedeva nessuno,
    // ed è la ragione per cui un assieme fantasma finiva su Plex come componente vero.
    'MaterialComponentIsPhantomItem', 'ManufacturingOrderOperation', 'ReservationItem'];
  // [COMP-EXCL] I campi citati dalle regole di esclusione del plant, oltre a quelli fissi qui
  // sopra. Un nome ripetuto nel `$select` è una richiesta malformata: il delta lo calcola il
  // modulo. Nessuna regola => nessuna colonna in più, cioè la query di prima.
  const exclColumns = await orderCompExcl.extraComponentColumns(
    await cds.connect.to('db'), order.ProductionPlant, compColumns
  );
  const compRows = await s4.run(
    SELECT.from(A_ProductionOrderComponent_2)
      .columns(...compColumns, ...exclColumns)
      .where(compWhere)
      .limit(prodOrderSource.DETAIL_MAX_ROWS.components) // [ORDER-TOP] come sopra
  );
  const ownComps = keepComponentsOfOrder(s4.mode, order, compRows);
  if (ownComps.dropped) {
    console.warn(`>>> [JOB CreatePlexOrders] ordine ${order.ManufacturingOrder}: scartati`
      + ` ${ownComps.dropped} componenti di ALTRI ordini — la prenotazione usata come criterio non è`
      + ' quella dell\'ordine: la distinta può essere INCOMPLETA');
  }

  // ================================================================
  // [PHANTOM-EXPLODE] Esplosione dei fantasma (feature 0019), se il plant l'ha accesa.
  //
  // QUESTA FUNZIONE E' IL PUNTO DA CUI PASSANO TRE PERCORSI: il job pianificato, l'azione
  // manuale «Crea Job» e lo spacchettamento (che la riceve iniettata come dipendenza). Metterla
  // qui è ciò che rende impossibile che uno dei tre allinei su Plex una distinta diversa
  // dagli altri due.
  //
  // `order.components` alimenta `alignJobOperationsAndBom`, che DISATTIVA su Plex i componenti
  // del job non presenti in SAP: senza l'esplosione i figli del fantasma non sarebbero in
  // quell'insieme e verrebbero disattivati uno per uno.
  // ================================================================
  const explodeCache = order._phantomCache || (order._phantomCache = bomExplode.createExplodeCache());
  const { rows: explodedComps, stats: phantomStats } = await bomExplode.explodeProdOrderComponents({
    db: await cds.connect.to('db'),
    plant: order.ProductionPlant,
    rows: ownComps.kept,
    orderStartDate: parseOrderStartDate(order),
    cache: explodeCache,
    tag: `ordine ${order.ManufacturingOrder}`
  });
  // Le statistiche restano SULL'ORDINE e non nel valore di ritorno: `loadOrderDetails` e'
  // chiamata da tre percorsi con firme diverse, e il ciclo di run le raccoglie da qui.
  order._phantomStats = phantomStats;

  // ================================================================
  // [COMP-EXCL] Esclusione configurabile dei componenti (field mapping Ariston, foglio
  // `5. Orders or Jobs` cella `H18`), se il plant ha regole.
  //
  // DOPO l'esplosione e non prima: le regole devono valere anche sui figli che l'esplosione ha
  // portato dentro — un fantasma può contenere un componente che la MES non deve consumare.
  //
  // Sta nello STESSO punto dell'esplosione, e per la stessa ragione: `order.components` è
  // l'insieme che `alignJobOperationsAndBom` confronta col job Plex, e un componente che non è
  // in quell'insieme viene portato a `Active = 0`. È esattamente l'effetto che il foglio chiede.
  // ================================================================
  const excl = await orderCompExcl.applyComponentExclusions({
    db: await cds.connect.to('db'),
    plant: order.ProductionPlant,
    rows: explodedComps,
    // Nessuna sorgente materiali da riusare su questo percorso (`s4` è quella degli ORDINI): il
    // modulo apre la sua, che è memoizzata.
    materialCache: order._compExclMatCache
      || (order._compExclMatCache = orderCompExcl.createMaterialCache()),
    tag: `ordine ${order.ManufacturingOrder}`
  });
  // ================================================================
  // [ORDER-COMP-REMOVE] Rimozione MANUALE dei componenti (feature 0026), ultimo strato.
  //
  // DOPO le esclusioni di customizing, e non prima, perché la rimozione è un atto su un elenco che
  // una persona ha VISTO nel cockpit — e quell'elenco è già esploso e già filtrato dalle regole del
  // plant. Nominare qui un materiale che a schermo non compare non avrebbe senso.
  //
  // Sta nello STESSO punto dell'esplosione e delle esclusioni, e per la stessa ragione: da qui
  // passano il job pianificato, l'azione «Crea Job» e lo spacchettamento, e `order.components` è
  // l'insieme su cui il passo 2bis decide cosa aggiungere e il passo 7.2 cosa portare a
  // `Active = 0`. Un componente rimosso non viene «non mandato» — non lo mandavamo comunque —
  // viene DISATTIVATO sul job, che è l'unico effetto che la fabbrica vede (DEC-87, come DEC-74).
  // ================================================================
  const removal = await orderCompRemoval.applyManualRemovals({
    db: await cds.connect.to('db'),
    ManufacturingOrder: order.ManufacturingOrder,
    rows: excl.rows,
    tag: `ordine ${order.ManufacturingOrder}`
  });
  order.components = removal.rows;
  // Come le statistiche del fantasma: restano SULL'ORDINE, perché `loadOrderDetails` è chiamata da
  // tre percorsi con firme diverse e il ciclo di run le raccoglie da qui. Le `notes` non si
  // portano dietro: il modulo le ha già scritte sulla console, e ciò che deve arrivare al recap
  // sta dentro `stats` — un secondo canale per gli stessi fatti finirebbe per divergere.
  order._compExclStats = excl.stats;
  order._compRemovalStats = removal.stats;
}

/**
 * [PHANTOM-EXPLODE] La data di inizio dell'ordine, per `EffectivityDateMode = 'ORDER_START_DATE'`.
 *
 * Restituisce `null` — non «oggi» — quando la testata non la porta o non è interpretabile: chi
 * riceve `null` non aggiunge `BOMExplosionDate` alla chiamata, e SAP applica la sua data di
 * default. Sostituirla con oggi sarebbe far passare per «data d'ordine» una data che l'ordine
 * non ha, cioè esplodere una distinta a una validità inventata.
 * @param {object} order
 * @returns {Date|null}
 */
function parseOrderStartDate(order) {
  // `MfgOrderPlannedStartDate` è il campo che la testata porta davvero (vedi il $select di
  // loadOrdersInScope); gli altri due sono i nomi che la stessa data assume su altri percorsi.
  const raw = order && (order.MfgOrderPlannedStartDate
    || order.MfgOrderScheduledStartDate || order.ProductionStartDate);
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Applica il delta: scarta gli ordini già inviati con successo (mapping Status='S') e gli
 * ordini SPACCHETTATI (feature 0012, FR-31), questi ultimi PRIMA di qualunque chiamata
 * verso Plex: ri-sincronizzarli riporterebbe il lotto principale alla quantità piena
 * dell'ordine mentre i pacchetti continuano a esistere con la loro, cioè più quantità in
 * produzione di quella ordinata.
 *
 * [ORDER-TECO] E gli ordini di cui il job PROD_TECO ha rilevato la CHIUSURA TECNICA (feature
 * 0023): SAP li ha dichiarati chiusi, quindi non si ri-sincronizzano — nemmeno se la chiusura sul
 * job Plex non è ancora riuscita.
 *
 * [ORDER-QTY-SYNC] «Saltato dal ciclo principale» non vuol piu' dire «ignorato»: gli ordini gia'
 * inviati e quelli spacchettati escono da qui come RIGHE, e il controllo di quantita' della feature
 * 0033 gira su di loro. I soli davvero fuori restano i chiusi tecnicamente: SAP li ha dichiarati
 * chiusi, e cambiare la quantita' di un lotto che si sta chiudendo non ha senso.
 *
 * @returns {Promise<{todo: Array<object>, alreadySent: number, alreadySentRows: Array<object>,
 *                    splitSkipped: Array<{order: object, packages: number}>,
 *                    tecoSkipped: Array<{order: object}>}>}
 */
async function filterNotYetSent(db, orders) {
  // Con la chiave composta (ManufacturingOrder, PlexJobNumber) la tabella ha una riga per
  // lotto: il delta guarda SOLO la riga del lotto principale, quella il cui PlexJobNumber
  // coincide con il numero d'ordine.
  const rows = await db.run(
    SELECT.from(E_MAPPING).columns('ManufacturingOrder', 'PlexJobNumber').where({ Status: 'S' })
  );
  const sentSet = new Set(
    rows.filter((r) => r.PlexJobNumber === r.ManufacturingOrder).map((r) => r.ManufacturingOrder)
  );

  // Ordini spacchettati (marcatura per ordine) + numero di pacchetti, per il recap.
  const splitRows = await db.run(
    SELECT.from(E_SPLIT).columns('ManufacturingOrder').where({ IsSplit: true })
  );
  const splitSet = new Set(splitRows.map((r) => r.ManufacturingOrder));
  const pkgCount = new Map();
  if (splitSet.size) {
    const pkgs = await db.run(
      SELECT.from(E_MAPPING).columns('ManufacturingOrder', 'PlexJobNumber', 'SplitState')
        .where({ ManufacturingOrder: { in: [...splitSet] } })
    );
    for (const p of pkgs) {
      if (p.PlexJobNumber === p.ManufacturingOrder) continue;      // riga del lotto principale
      if (p.SplitState !== 'A' && p.SplitState !== 'I') continue;  // conta solo i pacchetti attivi
      pkgCount.set(p.ManufacturingOrder, (pkgCount.get(p.ManufacturingOrder) || 0) + 1);
    }
  }

  // [ORDER-TECO] Ordini di cui il job PROD_TECO ha rilevato la chiusura tecnica (feature 0023).
  // Il criterio è l'ESISTENZA della riga, non lo stato 'A': la riga significa «SAP dice che
  // quest'ordine è tecnicamente chiuso», e ri-mandarlo a Plex sarebbe sbagliato anche quando la
  // chiusura su Plex non è (ancora) riuscita. È la metà «smettere di riproporlo» del gap W1-13.
  const tecoRows = await db.run(SELECT.from(E_TECO_STATE).columns('ManufacturingOrder'));
  const tecoSet = new Set((tecoRows || []).map((r) => r.ManufacturingOrder));

  const todo = [];
  const splitSkipped = [];
  const tecoSkipped = [];
  // [ORDER-QTY-SYNC] Gli ordini gia' inviati non sono piu' solo un CONTATORE: sono le righe su cui
  // gira il controllo di quantita' (feature 0033). Sono state lette da SAP poco fa, con
  // `TotalQuantity` gia' nel `$select`, quindi tenerle non costa nessuna lettura in piu'.
  const alreadySentRows = [];
  for (const o of orders) {
    if (tecoSet.has(o.ManufacturingOrder)) {
      tecoSkipped.push({ order: o });
      continue;
    }
    if (splitSet.has(o.ManufacturingOrder)) {
      splitSkipped.push({ order: o, packages: pkgCount.get(o.ManufacturingOrder) || 0 });
      continue;
    }
    if (sentSet.has(o.ManufacturingOrder)) {
      alreadySentRows.push(o);
      continue;
    }
    todo.push(o);
  }
  const alreadySent = orders.length - todo.length - splitSkipped.length - tecoSkipped.length;
  console.log(
    `>>> [JOB CreatePlexOrders] già inviati (skip): ${alreadySent}, spacchettati (skip): ${splitSkipped.length},`
    + ` chiusi tecnicamente (skip): ${tecoSkipped.length}, da elaborare: ${todo.length}`
  );
  return { todo, alreadySent, alreadySentRows, splitSkipped, tecoSkipped };
}

// ================================================================
// Persistenza esito (mapping delta + log HDR/POS)
// ================================================================

/**
 * Registra l'esito dell'invio: append su ZProdOrderExcLogPOS (storico), upsert su
 * ZProdOrderExcLogHDR (ultimo stato) e upsert su ZProdOrderPlexMapping (delta).
 * Pattern identico ai flussi Materiali/Routing (cat-service.js).
 *
 * @param {object} db  connessione CDS al db
 * @param {object} order  ordine SAP (serve almeno ManufacturingOrder)
 * @param {object} outcome  { status, message, steps, plex }
 * @param {object} [options] feature 0012:
 *   - `jobNumberKey` (default `order.ManufacturingOrder`): seconda colonna della chiave
 *     composta del mapping, cioè QUALE lotto si sta scrivendo. Il lotto principale usa
 *     sempre il numero d'ordine, un pacchetto il proprio codice `<ordine>-000N`;
 *   - `mapExtra`: campi aggiuntivi da scrivere sulla riga di mapping (SplitSequence,
 *     SplitState, Quantity, MainQtyBefore);
 *   - `skipMapping`: scrive solo lo storico HDR/POS e non tocca il dizionario. Lo usano lo
 *     spacchettamento (che gestisce da sé la riga del pacchetto, in transazioni autonome)
 *     e il gate FR-32 di createJobInPlex (che non deve alterare il delta).
 * @returns {Promise<number>} il Counter della riga POS appena scritta, usato dal riepilogo
 *          di fine job come LogRef per puntare al dettaglio richiesta/risposta senza
 *          duplicarlo (contiene anche le credenziali Data Source: non deve finire in un
 *          allegato mail).
 */
async function writeMappingAndLog(db, order, outcome, options = {}) {
  const { status, plex } = outcome; // status: 'S'|'E'|'W'
  const key = order.ManufacturingOrder;

  // [ORDER-LOG-OP] La riga di storico la scrive il writer CONDIVISO (srv/lib/prodOrderExcLog.js),
  // che dalla 0031 serve anche alla chiusura tecnica e alla consuntivazione: la stessa scrittura in
  // tre punti divergerebbe al primo campo aggiunto. Da la' vengono anche il progressivo, le due
  // proiezioni dei passi, il semaforo dell'ultimo passo non accessorio e la derivazione del testo
  // dai segmenti.
  //
  // `updateHeader: true` E' SOLO DI QUESTO FLUSSO: la testata dell'ordine e' «l'ultimo invio», e le
  // altre operazioni scrivono la sola posizione (vedi la testata del modulo).
  const nextCounter = await excLog.appendProdOrderLog(db, {
    order: key,
    // Lo spacchettamento passa da qui con `skipMapping`: e' un invio verso Plex come l'altro, ma di
    // un pacchetto, e in lista si distingue.
    operation: options.skipMapping ? excLog.OPERATION.SPLIT : excLog.OPERATION.JOB,
    status,
    segments: outcome.segments,
    message: outcome.message,   // ripiego per un esito costruito a mano
    steps: outcome.steps,
    updateHeader: true
  });

  // Mapping delta (upsert). Lo spacchettamento lo salta: la riga del pacchetto è scritta
  // dall'orchestratore in transazione autonoma (TD-5).
  if (options.skipMapping) return nextCounter;

  const now = new Date();

  // Chiave PIENA: (ManufacturingOrder, PlexJobNumber). PlexJobNumber è chiave e quindi non
  // può essere null: per il lotto principale è SEMPRE il numero d'ordine, anche sui
  // tentativi in cui Plex non ha risposto (è comunque il numero con cui il job verrebbe
  // cercato). Il valore restituito da Plex non finisce in chiave: se diverge si logga come
  // anomalia, perché scriverlo creerebbe una seconda riga per lo stesso lotto.
  const jobNumberKey = options.jobNumberKey || key;
  if (plex?.jobNumber && plex.jobNumber !== jobNumberKey) {
    console.warn(
      `>>> [ANOMALIA] ordine ${key}: Plex ha restituito jobNumber '${plex.jobNumber}' ` +
      `invece di '${jobNumberKey}': la chiave del mapping resta '${jobNumberKey}'`
    );
  }

  const existingMap = await db.run(
    SELECT.one.from(E_MAPPING).where({ ManufacturingOrder: key, PlexJobNumber: jobNumberKey })
  );

  // ================================================================
  // [ORDER-MAP-JOB] IL DIZIONARIO E' DEI JOB CHE ESISTONO, e il log e' un'altra tabella.
  //
  // Fin qui la riga nasceva su QUALUNQUE esito, compreso ogni `return outcome('E', ...)` che esce
  // prima di una sola chiamata verso Plex — il gate del ciclo vuoto, la part non trovata, la
  // lettura di SAP caduta. Nasceva con `PlexJobId: null`, e due punti del progetto leggevano
  // «esiste una riga» come «l'ordine e' gia' uscito»: la striscia del dettaglio e il gate che
  // spegne «Rimuovi» sui componenti. Intanto il delta di questo stesso job riciclava l'ordine,
  // perche' filtra `Status: 'S'`.
  //
  // LA RIGA DI STORICO E' GIA' STATA SCRITTA, qui sopra e senza condizioni: e' quella che deve
  // registrare i falliti, ed e' da li' che viene «l'ordine non ha operazioni nel ciclo Plex» nella
  // lista. L'indipendenza fra le due tabelle e' il punto, non un effetto collaterale.
  // ================================================================
  if (!orderMappingRules.shouldWriteMapping({
    jobId: plex?.jobId,
    jobCreated: plex?.jobCreated,
    existingJobId: existingMap?.PlexJobId
  })) {
    console.log(`>>> [ORDER-MAP-JOB] ordine ${key} (${jobNumberKey}): nessun job su Plex`
      + ` (esito ${status}), il dizionario NON si scrive. Lo storico ha la sua riga.`);
    return nextCounter;
  }

  // Le due colonne del mapping vengono dalla STESSA sorgente della riga di storico: il writer
  // condiviso le calcola una volta, qui si riusano.
  const mapCols = excLog.messageColumns(outcome.segments, outcome.message);
  const mapFields = {
    // [ORDER-TECO] Il plant di produzione, copiato dalla testata. Sta anche nell'UPDATE e non solo
    // nell'INSERT di proposito: e' cio' che ripara da se' le righe scritte prima che la colonna
    // esistesse, al primo reinvio di quell'ordine. Se la testata non lo porta si tiene quello che
    // c'e' gia' invece di azzerarlo — vuoto significa IGNOTO, e chi legge non deve confonderlo con
    // «fuori perimetro» (vedi candidateLots).
    Plant: String(order.ProductionPlant || '').trim() || existingMap?.Plant || null,
    PlexJobId: plex?.jobId || existingMap?.PlexJobId || null,
    PlexPartId: plex?.partId || existingMap?.PlexPartId || null,
    ExternalJobCode: plex?.externalJobCode || existingMap?.ExternalJobCode || null,
    Status: status,
    LastMessage: mapCols.Message,
    LastMessageJson: mapCols.MessageJson,
    UpdatedAt: now.toISOString(),
    ...(options.mapExtra || {})
  };
  if (existingMap) {
    await db.run(
      UPDATE(E_MAPPING).set(mapFields).where({ ManufacturingOrder: key, PlexJobNumber: jobNumberKey })
    );
  } else {
    await db.run(INSERT.into(E_MAPPING).entries({
      ManufacturingOrder: key,
      PlexJobNumber: jobNumberKey,
      // Il lotto principale è la riga con progressivo 0 e stato 'M' (FDD 0012 §5.2).
      SplitSequence: 0,
      SplitState: 'M',
      CreatedAt: now.toISOString(),
      ...mapFields
    }));
  }

  return nextCounter;
}

// ================================================================
// Step 6-7 — allineamento operazioni/BOM del Job via Data Source API
// ================================================================

/**
 * Mette a "NOT Required" le operazioni che il Job Plex ha IN PIÙ rispetto al nostro albero
 * dell'ordine, e disattiva (Active=0) le righe BOM del Job non presenti tra i componenti SAP.
 *
 * [JOB-OP-ALIGN] I DUE PASSI HANNO DUE TERMINI DI CONFRONTO DIVERSI, e non è una svista.
 *
 *   6.3 — operazioni: il confronto è col NOSTRO ALBERO (`ZPlexCycleOperation` dell'ordine), non
 *   con SAP, e per IDENTIFICATIVO, mai per numero. Le operazioni di un job Plex le deriva Plex
 *   dalla routing della part: sono oggetti Plex, e vanno confrontate con ciò che noi abbiamo
 *   dichiarato su Plex. La regola, le sue ragioni e i suoi contorni stanno in
 *   srv/lib/jobOpAlignRules.js — inclusa la prova che il numero è posizionale e non identifica.
 *
 *   7.2 — distinta: il confronto resta coi COMPONENTI SAP dell'ordine, ed è per costruzione il
 *   meccanismo con cui l'esclusione di plant (DEC-74) e la rimozione manuale (DEC-87) disattivano
 *   su Plex. Restringere `order.components` È la regola di invio: qui non si tocca.
 *
 * In entrambi, un insieme di confronto VUOTO non autorizza a spegnere tutto: senza il termine di
 * paragone non si sottrae niente e lo si dichiara (DEC-80). È il guasto che il 27/08/2026 ha
 * portato a *Not Required* tutte e quattro le operazioni dell'ordine 000700000243.
 *
 * @param {string} [jobNumber] numero del lotto Plex da allineare. Default: il numero
 *   dell'ordine SAP, cioè il lotto principale (comportamento invariato per il job batch).
 *   Lo spacchettamento passa il codice del PACCHETTO (`<ordine>-000N`), che è l'unico punto
 *   in cui la DS 4216 viene interrogata con un numero diverso da quello dell'ordine. L'albero è
 *   invece SEMPRE quello dell'ordine: un pacchetto non ne ha uno proprio.
 * @returns {Promise<Array<object>>} steps (per il log). Lancia eccezione solo su
 * errori che devono degradare l'esito complessivo a Warning.
 */
async function alignJobOperationsAndBom(creds, order, steps, jobNumber = order.ManufacturingOrder) {
  // 6.1 Job_No -> Job_Key
  const r61 = await executeDataSource(creds, DS_GET_JOB_KEY, { Job_No: jobNumber });
  steps.push({ step: '6.1 get Job_Key', request: { Job_No: jobNumber }, status: r61.status, response: r61.body });
  const keyRows = dsRows(r61.body);
  // Non è documentato se il filtro su Job_No della DS sia per uguaglianza o per prefisso, e
  // il codice dei pacchetti INIZIA con il numero d'ordine. Il comportamento resta quello in
  // esercizio (si prende la prima riga): più di una riga produce una riga di log
  // informativa, non un errore — trasformare in errore un caso mai osservato farebbe
  // fallire un passo che funziona (decisione G3-2 della feature 0012).
  if (keyRows.length > 1) {
    console.warn(
      `>>> [PLEX DS ${DS_GET_JOB_KEY}] Job_No '${jobNumber}': ${keyRows.length} righe restituite, ` +
      'si usa la prima (verificare se il filtro della Data Source sia per prefisso)'
    );
  }
  const jobKey = keyRows[0]?.Job_Key;
  if (!r61.ok || !jobKey) {
    throw new Error(`Impossibile ricavare Job_Key per il job ${jobNumber} (DS ${DS_GET_JOB_KEY}).`);
  }

  // 6.2 Job_Key -> operazioni del job
  const r62 = await executeDataSource(creds, DS_GET_JOB_OPS, { Job_Key: jobKey });
  steps.push({ step: '6.2 get Job Operations', request: { Job_Key: jobKey }, status: r62.status, response: r62.body });
  const jobOps = dsRows(r62.body);

  // ================================================================
  // [JOB-OP-ALIGN] 6.2bis — i due lati del confronto, e la loro traduzione.
  //
  // L'albero è quello dell'ORDINE anche quando si allinea un pacchetto: un pacchetto non ha un
  // ciclo proprio, nasce dalla stessa part e le sue operazioni sono le stesse.
  //
  // Il catalogo del tenant serve perché dal lato job l'UUID NON ESISTE: la 4701 dà il codice, e
  // `GET /scheduling/v1/jobs/{id}/operations` pure (PLEX_JOB_API_CONTRACT.md). È una chiamata per
  // plant, non per operazione: la cache con TTL è già dentro il modulo del catalogo.
  //
  // Nessuna delle due letture LANCIA. Una lettura fallita non è un insieme vuoto, e la conseguenza
  // qui non è «disattivo tutto» ma «non decido»: la dichiara il passo 6.3 qui sotto.
  // ================================================================
  const cycleRows = await readOrderCycleOperations(order.ManufacturingOrder);
  const catalog = await opCatalog.loadOperationCatalog(creds, order.ProductionPlant);
  const opPlan = jobOpAlignRules.decideJobOperations({
    jobOps,
    cycleOpIds: jobOpAlignRules.treeOperationIds(cycleRows),
    catalog
  });

  // 6.3 disattiva (NOT Required) le operazioni che il job ha in più rispetto all'albero.
  //
  // LA RIGA DI RIEPILOGO SI SCRIVE SEMPRE, anche con zero disattivazioni. Finché il passo compariva
  // nel log solo quando agiva, «tutto allineato» e «non ho potuto valutare» erano la stessa assenza
  // — ed è per questo che l'ordine 000700000243 ha spento quattro operazioni senza che nulla lo
  // dicesse.
  steps.push({
    step: '6.3 allineamento operazioni',
    request: { ManufacturingOrder: order.ManufacturingOrder, Job_No: jobNumber },
    status: 0,                  // non è una chiamata HTTP: nessuno stato da fingere
    response: opPlan.evaluable
      ? `albero=${opPlan.stats.tree} job=${opPlan.stats.job} tenute=${opPlan.stats.keep} `
        + `da disattivare=${opPlan.stats.deactivate} non valutabili=${opPlan.stats.unevaluable}`
      : `NON VALUTABILE (${opPlan.notEvaluable}): nessuna operazione disattivata `
        + `[albero=${opPlan.stats.tree} job=${opPlan.stats.job} catalogo=${catalog.ok ? 'letto' : 'NON letto'}]`,
    aux: true                   // riga informativa: non tinge il semaforo dell'ordine (DEC-38)
  });

  // L'attenzione si RACCOGLIE e la sequenza prosegue: la distinta va allineata comunque, e non
  // dipende dalle operazioni. È la forma di [SCHED-CONTINUE] — un `throw` qui si porterebbe dietro
  // il passo 7 intero, cioè il difetto che quella decisione è nata per chiudere. Il degrado a `W`
  // arriva in fondo alla funzione.
  let opAlignSkipped = '';
  if (!opPlan.evaluable) {
    opAlignSkipped = opPlan.notEvaluable;
    console.warn(`>>> [JOB-OP-ALIGN] job ${jobNumber}: allineamento operazioni NON eseguito`
      + ` (${opPlan.notEvaluable}) — nessuna operazione portata a NOT Required`);
  } else {
    for (const d of opPlan.decisions) {
      if (d.action !== jobOpAlignRules.ACTION.DEACTIVATE) continue;
      const inputs = { Job_Op_Key: d.jobOpKey, Job_Op_Status_Key: JOB_OP_STATUS_KEY_NOT_REQUIRED };
      const r63 = await executeDataSource(creds, DS_UPDATE_JOB_OP_STATUS, inputs);
      steps.push({
        step: `6.3 op ${d.opNo} (${d.code || 'senza codice'}) -> NOT Required`,
        request: inputs, status: r63.status, response: r63.body
      });
    }
    // Le righe che non si è potuto giudicare si NOMINANO: sono operazioni rimaste attive per
    // prudenza, e senza questa riga sarebbero indistinguibili da operazioni riconosciute.
    if (opPlan.stats.unevaluable) {
      const kept = opPlan.decisions
        .filter((d) => d.cause !== jobOpAlignRules.CAUSE.IN_TREE
          && d.cause !== jobOpAlignRules.CAUSE.NOT_IN_TREE)
        .map((d) => `${d.opNo}:${d.code || '(senza codice)'}=${d.cause}`);
      steps.push({
        step: '6.3 operazioni non valutabili (tenute)',
        request: null, status: 0, response: kept.join(' | '), aux: true
      });
      console.warn(`>>> [JOB-OP-ALIGN] job ${jobNumber}: ${opPlan.stats.unevaluable} operazioni`
        + ` tenute perché non giudicabili — ${kept.join(' | ')}`);
    }
  }

  // [ORDER-BOM-ADD] Insieme dei codici componente SAP, dal PUNTO UNICO.
  //
  // Il confronto era un `Set` di stringhe grezze, quindi ESATTO, mentre il prevolo del passo 2bis
  // tollera maiuscole e spazi: due punti che rispondono alla stessa domanda e la rispondevano in
  // due modi. Con `C-NEW` da una parte e `c-new` dall'altra il 2bis concludeva «c'e' gia', non
  // aggiungo» e questo «non e' nell'ordine, disattivo» — componente spento su un job che ne aveva
  // bisogno, e ordine chiuso verde. Ora la domanda si pone in un posto solo
  // (`orderComponentKeys` / `isOrderComponent`), che e' anche l'unico modo per non farli divergere
  // di nuovo.
  //
  // Il verso dell'allineamento e' quello della DEC-51: i due lati vengono da SISTEMI DIVERSI, quindi
  // il confronto tollerante e' quello giusto e il rigido era il difetto. In esercizio non dovrebbe
  // mordere — il numero parte su Plex lo scrive la nostra sincronizzazione materiali copiando il
  // codice SAP — ed e' per questo che e' una misura di coerenza e non la correzione di un guasto.
  const sapComponents = orderBomAddRules.orderComponentKeys(order.components);

  // [JOB-OP-ALIGN] Il presidio GEMELLO del 6.3, sull'altro insieme.
  //
  // Il termine di confronto qui non cambia — restano i componenti SAP dell'ordine, esclusioni di
  // plant (DEC-74) e rimozioni manuali (DEC-87) gia' applicate, ed e' cosi' che quelle due feature
  // disattivano su Plex. Quello che mancava e' la domanda prima della sottrazione: se l'insieme e'
  // VUOTO, il 7.2 porta a `Active = 0` l'INTERA distinta del lotto, in silenzio. Una lettura SAP
  // andata a vuoto e un ordine davvero senza componenti arrivano qui indistinguibili: nel dubbio
  // non si sottrae (DEC-80). Le letture 7.1 si fanno comunque — restano nella traccia.
  const bomEvaluable = jobOpAlignRules.componentsEvaluable(order.components);
  if (!bomEvaluable) {
    steps.push({
      step: '7.2 allineamento distinta',
      request: { ManufacturingOrder: order.ManufacturingOrder, Job_No: jobNumber },
      status: 0,
      response: 'NON VALUTABILE: nessun componente d\'ordine in mano, nessuna riga BOM disattivata',
      aux: true
    });
    console.warn(`>>> [JOB-OP-ALIGN] job ${jobNumber}: allineamento distinta NON eseguito`
      + ' — l\'insieme dei componenti dell\'ordine e\' vuoto');
  }

  // 7.1/7.2 per ogni operazione recupera le righe BOM e disattiva quelle non SAP.
  for (const jobOp of jobOps) {
    const r71 = await executeDataSource(creds, DS_GET_JOB_BOM, { Job_Key: jobKey, Job_Op_Key: jobOp.Job_Op_Key });
    steps.push({ step: `7.1 get Job BOM (op ${jobOp.Op_No})`, request: { Job_Key: jobKey, Job_Op_Key: jobOp.Job_Op_Key }, status: r71.status, response: r71.body });
    if (!bomEvaluable) continue;
    const bomRows = dsRows(r71.body);
    for (const bom of bomRows) {
      const compNo = bom.Component_Part_No || bom.Component_Part_No_Revision;
      if (compNo && !orderBomAddRules.isOrderComponent(sapComponents, compNo)) {
        const inputs = { Active: 0, Job_BOM_Key: bom.Job_BOM_Key };
        const r72 = await executeDataSource(creds, DS_UPDATE_JOB_BOM, inputs);
        steps.push({ step: `7.2 BOM ${compNo} -> Active=0`, request: inputs, status: r72.status, response: r72.body });
      }
    }
  }

  // [JOB-OP-ALIGN] Il degrado, IN FONDO e non al punto in cui la notizia e' arrivata: la sequenza
  // doveva proseguire (vedi sopra), ma un allineamento non fatto non puo' chiudere in verde — o
  // «job allineato» e «job che non ho potuto allineare» sarebbero lo stesso esito. Il chiamante lo
  // trasforma in `alignWarning`, cioe' `W` sull'ordine, senza fermare i passi che seguono.
  if (opAlignSkipped || !bomEvaluable) {
    const causes = [
      ...(opAlignSkipped ? [`operazioni (${opAlignSkipped})`] : []),
      ...(!bomEvaluable ? ['distinta (nessun componente d\'ordine)'] : [])
    ];
    throw new Error(`Allineamento non eseguito sul job ${jobNumber}: ${causes.join(', ')}.`
      + ' Nessuna operazione e nessuna riga di distinta sono state disattivate.');
  }
}

/**
 * [JOB-OP-ALIGN] Le operazioni del NOSTRO albero Plex per quell'ordine.
 *
 * NON LANCIA, e la ragione è che il chiamante deve poter distinguere: una lettura locale fallita
 * torna `[]`, che a valle vale «insieme di confronto assente» e quindi «non disattivo niente». Il
 * contrario — propagare l'errore — fermerebbe anche l'allineamento della distinta, che non ha
 * niente a che vedere con l'albero.
 *
 * @param {string} manufacturingOrder
 * @returns {Promise<Array<object>>} righe con le colonne di `jobOpAlignRules.TREE_COLUMNS`
 */
async function readOrderCycleOperations(manufacturingOrder) {
  try {
    const db = await cds.connect.to('db');
    const rows = await db.run(
      SELECT.from(E_CYCLE_OP)
        .columns(...jobOpAlignRules.TREE_COLUMNS)
        .where({ ManufacturingOrder: manufacturingOrder })
    );
    return Array.isArray(rows) ? rows : (rows ? [rows] : []);
  } catch (err) {
    console.warn(`>>> [JOB-OP-ALIGN] ordine ${manufacturingOrder}: albero Plex non letto`
      + ` (${err.message}) — l'allineamento delle operazioni non verra' eseguito`);
    return [];
  }
}

// ================================================================
// Elaborazione di un singolo ordine (step 1-7)
// ================================================================

/**
 * [JOB-READ] L'UUID Plex del LOTTO PRINCIPALE, dal dizionario. Chiave piena, la stessa di
 * `readMainRow` dello spacchettamento: (ordine, numero di job = ordine).
 *
 * BEST-EFFORT DI PROPOSITO. Senza `db` — `processOrder` chiamata senza `opts`, che resta un caso
 * ammesso — o su un errore di lettura locale si torna stringa vuota, e la lettura del job ricade
 * sul numero, cioe' sul comportamento storico. Una SELECT locale fallita non deve fermare un
 * ordine: al massimo fa perdere la scorciatoia.
 */
async function readMappedJobId(db, jobNumber) {
  if (!db) return '';
  try {
    const row = await db.run(
      SELECT.one.from(E_MAPPING).columns('PlexJobId')
        .where({ ManufacturingOrder: jobNumber, PlexJobNumber: jobNumber })
    );
    return (row && row.PlexJobId) || '';
  } catch (e) {
    console.warn(`>>> [JOB-READ] PlexJobId di ${jobNumber} non letto dal dizionario `
      + `(si legge per numero): ${e.message}`);
    return '';
  }
}

/**
 * @param {{ sortConfig?: object, sortTimeoutMs?: number, db?: object, manual?: boolean }} [opts]
 *   feature 0014:
 *   - `sortConfig`: configurazione di ordinamento del plant, GIA' risolta dal chiamante (il job
 *     la risolve una volta per esecuzione, §2.6);
 *   - `sortTimeoutMs`: tetto di attesa del solo passo 8 (0 = nessun tetto, D-04);
 *   - `db`: usata solo se `sortConfig` e' assente.
 *   Chiamare processOrder SENZA opts lascia il comportamento identico a prima della 0014
 *   (nessuna configurazione risolvibile => passo 8 «non previsto»): e' la proprieta' che rende
 *   sicuro il rollback di questa feature.
 *
 *   [ORDER-BOM-ADD] `manual`: C'E' UN UTENTE DIETRO QUESTA CHIAMATA. Lo passa solo l'action
 *   `createJobInPlex` (srv/cat-service.js), cioe' il tasto «Crea Job in Plex» del cockpit. L'unico
 *   effetto e' al passo 2bis: il prevolo della distinta smette di essere un gate e diventa una
 *   dichiarazione, perche' chi preme il tasto decide di inviare e si assume la responsabilita' di
 *   un lotto con la distinta incompleta. IL DEFAULT E' `false`, ed e' quello che tiene bloccante il
 *   job pianificato: non c'e' nessuno a cui chiedere, quindi si ferma.
 *
 * [ORDER-SORT-ON-WRITE] UN INVOLUCRO, e la ragione e' una sola: ogni scrittura su un ordine verso
 * Plex si chiude con l'ordinamento della lista di lavoro (addendum del 06/10/2026 a DEC-100). Il
 * passo 8 sta in coda a `processOrderSteps` e la' resta; l'involucro copre le due uscite che
 * arrivano DOPO una scrittura senza raggiungere la coda — la creazione OK senza id e un'eccezione
 * di rete a meta' di una scrittura — e lo decide in un punto solo (`guardSortOnWrite`, puro). Se il
 * passo 8 e' gia' girato non fa niente. Su un'eccezione l'esito dell'ordinamento viaggia
 * sull'errore (`err.sort`, `err.sortSteps`), e lo raccolgono i due chiamanti.
 */
async function processOrder(creds, s4, order, opts = {}) {
  const trace = { written: false, inFlight: false };
  return guardSortOnWrite(
    trace,
    () => processOrderSteps(creds, s4, order, opts, trace),
    (steps) => runJobSortStep({
      creds,
      plant: order.ProductionPlant,
      config: opts.sortConfig,
      db: opts.db,
      steps,
      timeoutMs: opts.sortTimeoutMs
    })
  );
}

/**
 * La sequenza dei passi 1-8 su UN ordine. Chiamarla solo da `processOrder`.
 *
 * [ORDER-SORT-ON-WRITE] `trace` dice all'involucro se Plex e' gia' stato toccato: si compila intorno
 * alle DUE scritture che possono essere le prime — il `PUT` del passo 3 e il `POST` del passo 4.
 * Ogni altra scrittura della sequenza viene dopo una di queste due riuscita, quindi e' gia' coperta.
 */
async function processOrderSteps(creds, s4, order, opts, trace) {
  const steps = [];
  const plex = {};
  const jobNumber = order.ManufacturingOrder;

  // --- Step 1: Check Part ---
  // Serve l'UUID della part, non un «esiste?»: `partId` va nel corpo di creazione del job (il job
  // nasce SULLA part, ed e' da lei che Plex deriva operazioni e distinta del lotto), va al prevolo
  // della 0025 che con quell'id legge operazioni e distinta della part, e finisce nel dizionario.
  // Si cerca il solo materiale di TESTATA: i componenti li risolve `resolveComponentId`.
  //
  // [PART-QUERY] Il filtro e' `number`, e fin qui era `partNumber` — un parametro che su questo
  // indirizzo NON ESISTE. Plex ignorava il parametro sconosciuto e rispondeva con l'intero
  // catalogo del tenant: misurato il 21/09/2026, 3957 part e 1,9 MB per usarne una, salvati nella
  // traccia a ogni tentativo. Il commento che stava qui dava la colpa al tenant; era un'ipotesi
  // mai verificata. Il contratto e' sul portale (DEC-67), e dichiara `number` su entrambe le
  // versioni.
  //
  // IL FILTRO LATO CLIENT RESTA: il contratto non dichiara se il confronto sia esatto o per
  // prefisso, e DEC-80 ha gia' pagato un `jobNumber=` che agganciava per prefisso.
  const partQuery = plexPartsApi.partByNumberPath(order.Material);
  const r1 = await plexGet(creds, partQuery);
  steps.push({ step: '1 Check Part', request: { url: partQuery }, status: r1.status, response: r1.body });
  const part = asArray(r1.body).find(
    (p) => plexPartsApi.numberOf(p) === order.Material
  );
  const partId = part ? plexPartsApi.idOf(part) : '';
  // [JOB-BUILDING] Il building della part, se la dichiara: secondo anello della catena qui sotto.
  const partBuildingCode = (part && (part.buildingCode || part.building)) || '';
  if (!r1.ok || !partId) {
    return outcome('E', [logMsg.seg('logOrderPartMissing', order.Material)], { steps, plex });
  }
  plex.partId = partId;

  // --- Step 2: Check Job ---
  // [JOB-READ] DEC-80: il job si cerca per il suo UUID quando il dizionario ce l'ha, e il numero
  // resta l'autorità sull'assenza. Due difetti in uno: la lettura per numero risponde `500` sui job
  // che esistono (tenant di test, plant 07), e questo passo NON guardava `r2.ok` — un corpo
  // d'errore passava per `asArray` come lista vuota, `existingJob` restava `undefined` e si andava
  // al passo 4, creando un SECONDO job con lo stesso numero. Ora un esito non conclusivo ferma
  // l'ordine: in una scrittura «non so» è più pericoloso di «no» (DEC-60).
  const knownJobId = await readMappedJobId(opts.db, jobNumber);
  const probe = await plexJobRead.findJob({ get: (p) => plexGet(creds, p) }, {
    jobNumber,
    jobId: knownJobId
  });
  steps.push({
    step: '2 Check Job',
    request: { url: probe.url, via: probe.via, jobId: knownJobId || null },
    status: probe.status,
    response: probe.found || { error: probe.error || '', notes: probe.notes || [] }
  });
  if (!probe.ok) {
    const detail = [probe.error, (probe.notes || []).join('; ')].filter(Boolean).join(' | ');
    // Il dettaglio viene da Plex e dalla sonda: testo tecnico, avvolto e non tradotto.
    return outcome('E', [
      logMsg.seg('logOrderJobProbeInconclusive', jobNumber),
      logMsg.technical(detail)
    ], { steps, plex });
  }
  const existingJob = probe.found;

  // ================================================================
  // [JOB-HEADER-ONLY] UN JOB CHE ESISTE SI AGGIORNA NELLA TESTATA, NON NEL CONTENUTO (0038).
  //
  // Se Plex ci restituisce quel job, quel job E' STATO CREATO CON SUCCESSO: l'esistenza e' la prova.
  // Da qui in avanti il ramo di aggiornamento scrive la sola testata — data, quantita', i campi che
  // un `PUT` porta con se' — e NON tocca ne' la distinta ne' le operazioni del lotto. In fabbrica
  // qualcuno ci sta lavorando.
  //
  // IL DISCRIMINANTE E' IL RAMO, NON L'ESITO DELL'ULTIMO INVIO, e la differenza non e' teorica:
  // con l'esito basterebbe che un aggiornamento di testata fallisse per far rifare tutto al giro
  // successivo — «l'ultimo invio e' andato male» — su un job creato correttamente. Cioe' esattamente
  // il caso da evitare. L'esistenza del job non cambia a ogni tentativo; l'esito si'.
  //
  // NESSUNO L'AVEVA CHIESTO. Il comportamento di prima nasce dal passo 2bis portato «su entrambi i
  // rami» dalla 0025 per rendere possibile il RITENTATIVO, con una premessa che lo rendeva innocuo —
  // «un ordine gia' riuscito non arriva comunque fin qui, lo esclude il delta» — falsa per il tasto
  // del cockpit, che non guarda l'esito dell'ultimo invio ed e' l'unico percorso che porta qui un
  // ordine perfettamente riuscito. Il solo requisito esterno sull'aggiornamento post-invio (W1-34,
  // foglio field mapping) e' di SOLA TESTATA, e per di piu' non implementato per decisione.
  //
  // IL PREZZO, DICHIARATO: dopo il primo invio riuscito una modifica dei componenti in SAP — o una
  // regola di esclusione aggiunta dopo — non arriva piu' su Plex per nessuna strada, perche' il 7.2
  // era l'unico veicolo. Vedi DEC-108 e docs/0038.
  //
  // Perimetro: grep -rn "JOB-HEADER-ONLY".
  // ================================================================
  const jobExists = !!(existingJob && existingJob.id);

  // ================================================================
  // --- Step 2bis: PREVOLO della distinta del job (feature 0025) ---
  //
  // I componenti che l'ODP ha in piu' rispetto al ciclo standard finiranno nella distinta DEL
  // LOTTO, non su quella della part: la part e' master data condivisa, e una riga aggiunta per
  // l'ordine di oggi comparirebbe nel job di domani (dove il passo 7.2 la disattiverebbe). Scrivere
  // sul job pero' richiede che il job ESISTA, e allora il gate «se fallisce non si crea niente»
  // andrebbe perso.
  //
  // Da qui le due fasi. QUI si accerta tutto cio' che puo' fallire in modo PREVEDIBILE, guardando
  // la part — che e' esattamente cio' che il job erediterà: componente non assegnabile, materiale
  // che non e' una part su Plex, operazione bersaglio che non esiste. Se qualcosa non torna, si
  // esce e NESSUN job viene creato. La scrittura e' il passo 4bis, dopo.
  //
  // MA E' UN GATE SOLO DOVE NON C'E' NESSUNO CHE DECIDE (`opts.manual`). Il job pianificato non ha
  // a chi chiedere se un ordine vada mandato lo stesso, quindi si ferma. Dietro il tasto «Crea Job
  // in Plex» c'e' una persona che guarda l'ordine, decide di inviarlo e si assume la responsabilita'
  // di un lotto con la distinta incompleta: la' il prevolo gira comunque — serve a preparare il
  // piano e a dire cosa non si e' potuto collocare — ma non ferma niente, e l'ordine chiude in
  // ATTENZIONE invece che in errore. La stessa forma che lo spacchettamento usa gia' per `addBom`
  // (cat-service.js): li' il job esiste gia', qui e' l'utente ad autorizzarlo.
  //
  // GIRA SU ENTRAMBI I RAMI, non piu' solo in creazione: e' cio' che rende possibile il ritentativo
  // di un ordine il cui passo 4bis era fallito. Un ordine gia' riuscito non arriva comunque fin
  // qui — lo esclude il delta di `filterNotYetSent` (`Status = 'S'`) — quindi il ramo di
  // aggiornamento si percorre solo su ordini da riparare.
  // ================================================================
  // I componenti servono ADESSO, non piu' al passo 6-7: `loadOrderDetails` si sposta qui. Una
  // lettura fallita non degrada piu' a 'W' come faceva quando il job era gia' creato — senza i
  // componenti la distinta non e' verificabile, quindi l'ordine si ferma.
  try {
    await loadOrderDetails(s4, order);
  } catch (err) {
    return outcome('E', [
      logMsg.seg('logOrderComponentsUnread', jobNumber),
      logMsg.technical(err.message)
    ], { steps, plex });
  }

  // ================================================================
  // --- Step 2ter: il CICLO dell'ordine, e il gate del ciclo vuoto (feature 0026) ---
  //
  // [ORDER-CYCLE-SEED] PERCHE' LA SEMINA SI E' SPOSTATA QUI, dal passo 7b in coda.
  // Il ciclo Plex di un ordine nasce come copia del ciclo salvato del MATERIALE, ed e' da quelle
  // operazioni che il job deriva le proprie. Finche' la semina stava dopo la creazione, «l'ordine ha
  // un ciclo» non era una domanda che si potesse porre PRIMA di creare il job: il ciclo non c'era
  // ancora. Il posto nuovo e' sicuro perche' `seedIfMissing` legge e scrive SOLO il database locale
  // e non lancia mai; e le operazioni SAP che le servono per verificare i collegamenti sono in mano
  // da `loadOrderDetails`, appena sopra. Resta un passo ACCESSORIO — `aux: true`, nessun effetto sul
  // semaforo dell'ordine (DEC-38): quello che blocca e' il gate qui sotto, che e' un'altra cosa.
  //
  // COSA CAMBIA, DICHIARATO: spostandola prima, ora vengono seminati anche gli ordini che poi
  // FALLISCONO al passo 2bis o alla creazione — prima quei casi non arrivavano al 7b. Non e' un
  // effetto indesiderato: il ciclo dell'ordine e' un artefatto LOCALE, e' esattamente quello che
  // l'apertura della schermata scrive da se' (`autoImportPlexCycle` con `Persist`), e senza di esso
  // il gate non avrebbe niente da guardare. Chi esce prima del passo 2 — part assente su Plex,
  // esistenza del job non accertata — continua a non essere seminato.
  //
  // [ORDER-CYCLE-REQUIRED] IL GATE: un ordine senza operazioni nel ciclo non si crea su Plex.
  // Un job creato da un ciclo vuoto e' un lotto senza operazioni e senza distinta: in fabbrica non
  // ci si lavora, le registrazioni che tornassero non avrebbero un `partOperationId` da risolvere
  // e il passo 2bis avrebbe comunque dichiarato ogni componente non assegnabile. Meglio non
  // crearlo, e dire perche': il materiale non ha un ciclo Plex salvato per quel plant, e il rimedio
  // sta nella tab «Cicli».
  //
  // [JOB-OP-ALIGN] VALE SU ENTRAMBI I RAMI, e fino al 27/08/2026 valeva solo sulla CREAZIONE.
  // Il motivo di allora era: «su un job che su Plex esiste gia' bloccare la ri-sincronizzazione lo
  // lascerebbe indietro per sempre — e la sua distinta e' comunque piu' vicina al vero dopo
  // l'allineamento che senza». Quella premessa e' caduta il giorno in cui l'albero e' diventato il
  // TERMINE DI CONFRONTO del passo 6.3: su un albero vuoto l'allineamento non avvicina il job al
  // vero, lo SPEGNE — e un lotto in cui nessuna operazione e' da eseguire e' peggio di un lotto
  // rimasto indietro. Il presidio dentro `alignJobOperationsAndBom` copre lo spacchettamento, che
  // chiama quella funzione senza passare di qui; questo gate copre il resto, e lo fa PRIMA di
  // qualunque chiamata verso Plex.
  // ================================================================
  const db = opts.db || await cds.connect.to('db');
  // L'esito della semina viaggia fino al `return` (`outcome.seed`), da cui il ciclo di run ricava la
  // sua riga di recap: e' la stessa variabile di prima, solo valorizzata prima.
  let seed = null;
  {
    const orderOpIds = Array.isArray(order.operations)
      ? order.operations.map((o) => o.ManufacturingOrderOperation)
      : null; // lettura non riuscita: i collegamenti si conservano senza verifica
    // Il verificatore di perimetro si crea PER ORDINE, non una volta per run: la sua cache e'
    // dentro la chiusura, e una cache di processo qui — in un server che vive per giorni e serve
    // anche l'azione manuale — servirebbe verdetti vecchi dopo un cambio di customizing. Il costo
    // e' una lettura di testata ciclo per ordine da seminare, e un ordine gia' seminato esce prima
    // (`hasSavedCycle` viene per primo), quindi non paga niente.
    seed = await orderCycleSeed.seedIfMissing({
      db,
      order,
      orderOpIds,
      checkScope: orderCycleSeed.makeScopeCheck({ db, routingSource })
    });
    if (seed.reason !== 'alreadySaved') {
      steps.push({
        step: '2ter Seed Order Cycle',
        request: seed.routing ? { routing: seed.routing } : null,
        status: 0,                 // non e' una chiamata HTTP: nessuno stato da fingere
        response: seed.message,
        aux: true                  // NON tinge il semaforo dell'ordine (DEC-38)
      });
      const log = seed.status === 'W' ? console.warn : console.log;
      log(`>>> [ORDER-CYCLE-SEED] ordine ${jobNumber}: ${seed.message}`);
    }
  }

  // ================================================================
  // [COMP-ORPHAN] Step 2quater: si tolgono dall'albero i componenti che SAP non ha piu' (0037).
  //
  // La semina copre solo il PRIMO import, e l'albero si semina una volta sola: se SAP toglie un
  // componente dopo, la semina non ha piu' occasione di accorgersene — `hasSavedCycle` la fa uscire
  // subito. Questo passo sì, e qui `order.components` e' gia' in mano dal passo 2, quindi la
  // verifica non costa nessuna lettura verso SAP.
  //
  // NON DEGRADA L'ESITO, e la ragione e' concreta: un ordine che chiude 'W' non ha piu' `Status='S'`
  // e il delta del job lo RIPESCA a ogni run, per sempre. Una modifica in SAP e' manutenzione
  // normale, non un guasto dell'ordine. Si dichiara nella traccia come passo ACCESSORIO
  // (`aux: true`, DEC-38) e in `cf logs`, che sono i due posti dove si va a guardare.
  //
  // Verso Plex non cambia niente: il passo 7.2 disattivava gia' quella riga di distinta confrontando
  // `order.components`. Quello che cambia e' che il cockpit smette di mostrare un componente che la
  // fabbrica ha spento, e che una collocazione manuale non puo' piu' RISORGERE se SAP reinserisce il
  // materiale.
  // ================================================================
  try {
    const treePrune = await orderCycleSeed.pruneOrderTreeOrphans({
      db, ManufacturingOrder: order.ManufacturingOrder, components: order.components
    });
    if (treePrune.dropped.length) {
      steps.push({
        step: '2quater Prune order tree',
        request: { componentiSAP: (order.components || []).length },
        status: 0,
        response: treePrune.note,
        aux: true
      });
      console.warn(`>>> [COMP-ORPHAN] ordine ${jobNumber}: ${treePrune.note}`);
    } else if (!treePrune.evaluated) {
      console.log(`>>> [COMP-ORPHAN] ordine ${jobNumber}: potatura non valutata (componenti`
        + ' dell\'ordine non noti): l\'albero resta com\'e\'');
    }
  } catch (pruneErr) {
    // Una potatura non riuscita non ferma l'invio: e' manutenzione dell'albero locale, e cio' che
    // parte verso Plex non dipende da essa. Si dichiara e si prosegue.
    console.error(`>>> [COMP-ORPHAN] ordine ${jobNumber}: potatura dell'albero non riuscita`
      + ` (${pruneErr.message}): l'albero resta com'e'`);
  }

  // [JOB-HEADER-ONLY] IL GATE TORNA A VALERE SOLO IN CREAZIONE (0038), com'era prima di DEC-99.
  //
  // DEC-99 lo aveva esteso al ramo di aggiornamento con una motivazione sola — «su un albero vuoto
  // l'allineamento non avvicina il job al vero, lo SPEGNE» — cioe' per proteggere dall'allineamento.
  // Togliendo l'allineamento da quel ramo la motivazione cade, e il gate resterebbe a bloccare un
  // aggiornamento di SOLA TESTATA senza nessuna ragione: la quantita' non arriverebbe in fabbrica
  // per via di un albero che quel `PUT` non guarda nemmeno.
  //
  // Il presidio DENTRO `alignJobOperationsAndBom` («un insieme di confronto vuoto non autorizza a
  // spegnere tutto») RESTA, e non e' ridondante: lo spacchettamento chiama quella funzione
  // direttamente, senza passare da qui.
  if (!jobExists) {
    let hasCycle;
    try {
      hasCycle = await orderCycleSeed.hasSavedCycle(db, order.ManufacturingOrder);
    } catch (err) {
      // Lettura locale fallita: NON e' «ciclo vuoto», ed e' un'altra causa con un altro rimedio.
      // Si blocca comunque — creare un lotto senza sapere se ha un ciclo e' il caso che il gate
      // esiste per evitare — ma il messaggio non mente sul perche' (DEC-80).
      return outcome('E', [
        logMsg.seg('logOrderCycleUnverifiable', jobNumber),
        logMsg.technical(err.message)
      ], { steps, plex });
    }
    if (!hasCycle) {
      const segments = [logMsg.seg('logOrderCycleEmpty', jobNumber, order.Material || '',
        order.ProductionPlant || '')];
      const msg = i18nMessages.render(segments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
      steps.push({
        step: '2ter Order Cycle required',
        request: { material: order.Material || '', plant: order.ProductionPlant || '' },
        status: 0,
        response: msg
      });
      console.error(`>>> [ORDER-CYCLE-REQUIRED] ${msg}`);
      return outcome('E', segments, { steps, plex });
    }
  }

  // [PLEX-CALL] Il passo 4bis scrive su Plex: il cockpit deve poterlo stampare subito dopo
  // l'operazione dell'utente (`window.plexCalls()`), come il passo 5. Il wrapper non aggiunge
  // nessuna chiamata: avvolge quelle che partono comunque. Si crea qui, PRIMA del ramo, perche' lo
  // usano le due fasi del passo 4bis e il passo 5, e la traccia dev'essere una sola: ogni `wrap`
  // porta il proprio contatore `seq`, quindi due wrap darebbero due `#1` sullo stesso ordine.
  const tracedPlex = plexCallTrace.wrap({
    get: (p) => plexGet(creds, p),
    post: (p, b) => plexPost(creds, p, b),
    put: (p, b) => plexPut(creds, p, b)
  }, { order: jobNumber, root: creds.baseUrl, tag: 'PLEX-CALL' });

  // [ORDER-BOM-ADD] Attenzione del prevolo in modalita' manuale, raccolta invece che restituita:
  // stessa forma di [SCHED-CONTINUE]. Resta `null` sul job pianificato, che esce qui sotto.
  let bomPreflightWarning = null;
  // [COMP-SOURCE] Le dichiarazioni del prevolo che NON lo fanno fallire (feature 0036).
  let bomManualNotes = [];
  // [JOB-HEADER-ONLY] Il piano parte VUOTO: su un job che esiste il prevolo non gira affatto, e un
  // piano vuoto e' esattamente cio' che fa saltare la scrittura del passo 4bis piu' in basso — un
  // solo cancello, non due condizioni da tenere allineate.
  let bomPlan = { ok: true, message: '', plan: [], failures: [], notes: [] };

  // [JOB-HEADER-ONLY] IL PREVOLO GIRA SOLO SE IL JOB VA CREATO (0038). Costa due letture verso Plex
  // — le part-operation e la distinta della part — e serve a preparare una scrittura che sul ramo di
  // aggiornamento non avviene piu': girarlo sarebbe due chiamate per niente, e i suoi fallimenti
  // parlerebbero di componenti che nessuno sta per scrivere.
  if (!jobExists) {
    bomPlan = await orderBomAdd.planPartBomAdditions({
      creds,
      plexGet: tracedPlex.get,
      // Era `opts.db || await cds.connect.to('db')`: la stessa espressione risolta poco sopra per il
      // passo 2ter, e `cds.connect.to('db')` rende sempre la stessa connessione.
      db,
      order,
      partId: plex.partId,
      steps,
      // Il messaggio deve dire cosa succede al job, e non e' la stessa cosa nei due punti d'ingresso.
      blocking: !opts.manual
    });
    // Come le statistiche del fantasma e delle esclusioni: restano SULL'ORDINE, perche' il ciclo di
    // run le raccoglie da qui per il recap.
    order._bomAddStats = { created: 0, failures: bomPlan.failures, planned: bomPlan.plan.length };
    // [COMP-SOURCE] Un bersaglio scelto a mano che su Plex non esiste piu', per cui si e' ripiegato
    // sulle regole. Il componente e' collocato — quindi non e' un `E` — ma e' collocato ALTROVE
    // rispetto a dove una persona lo aveva messo, e tacerlo renderebbe l'icona dell'albero una
    // promessa non mantenuta.
    bomManualNotes = Array.isArray(bomPlan.notes) ? bomPlan.notes : [];
    if (bomManualNotes.length) {
      console.warn(`>>> [COMP-SOURCE] ordine ${jobNumber}: ${bomManualNotes.join(' · ')}`);
    }
    if (!bomPlan.ok) {
      if (!opts.manual) {
        console.error(`>>> [ORDER-BOM-ADD] ordine ${jobNumber}: ${bomPlan.message}`);
        // `verbatim` e non `technical`: e' prosa NOSTRA, di srv/lib/orderBomAdd.js, non ancora
        // convertita a segmenti — lacuna dichiarata (grep -rn "logMsgVerbatim").
        return outcome('E', [logMsg.verbatim(bomPlan.message)], { steps, plex });
      }
      // INVIO MANUALE: il prevolo non e' un gate, e' una dichiarazione. Il job si crea lo stesso,
      // con i componenti che si sono potuti collocare, e cio' che manca finisce nel messaggio, nella
      // traccia e nell'esito `W` piu' in basso.
      bomPreflightWarning = bomPlan.message;
      console.warn(`>>> [ORDER-BOM-ADD] ordine ${jobNumber}: invio manuale, si prosegue —`
        + ` ${bomPlan.message}`);
      steps.push({
        step: '2bis.6 prevolo non superato — invio manuale',
        request: { falliti: bomPlan.failures.length, pianificati: bomPlan.plan.length },
        status: 0,
        response: bomPlan.message,
        // Dichiarazione, non chiamata: `status: 0` in coda spegnerebbe il semaforo «HTTP nnn» dello
        // storico, che deve restare quello dell'invio del job (DEC-38).
        aux: true
      });
    }
  } else {
    // Il recap legge questo campo con la sua guardia, ma lasciarlo `undefined` renderebbe «non ho
    // scritto niente» indistinguibile da «non ho nemmeno guardato».
    order._bomAddStats = { created: 0, failures: [], planned: 0, skipped: true };
  }

  let jobId;
  let created = false;
  // [SCHED-CONTINUE] Attenzione del passo 5, raccolta invece di restituita: vedi il passo 5.
  let scheduleWarning = null;
  if (existingJob?.id) {
    // --- Step 3: Update Job ---
    // [JOB-FIELDS] Un `PUT` è il modello INTERO, non una patch (DEC-77): mandava solo `dueDate` e
    // `quantity`, quindi era un `400 ARGUMENT_INVALID / The JobType field is required` in attesa —
    // ed è la stessa forma che ha fermato P1 dello spacchettamento. La testata si erede dal job che
    // Plex ha ADESSO, con l'AUART come ripiego, e ciò che non si manda si azzera.
    jobId = existingJob.id;
    // [ORDER-MAP-JOB] Il marcatore si scrive quando il fatto diventa vero, non a fine sequenza.
    // Da qui in poi il job ESISTE: ogni `return outcome('E', ...)` piu' sotto deve comunque
    // arrivare a `writeMappingAndLog` portandosi dietro l'id, o la riga di dizionario non si
    // aggiorna e il lotto si perde di vista.
    plex.jobId = jobId;
    const inherited3 = inheritedJobFields(existingJob, { order, fallback: JOB_TYPE });
    // [JOB-BUILDING] Se il job esistente non ha un building, si risolve. Nacque dal sospetto che
    // fosse il null del `500` — non lo era (il difetto era di Plex, corretto il 27/08/2026) — ma la
    // risoluzione resta giusta per conto suo: un `PUT` e' il modello INTERO, quindi un building non
    // rimandato viene AZZERATO sul job (DEC-77).
    if (!inherited3.buildingId) {
      const b3 = await plexBuildings.resolveBuildingId({ get: (p) => plexGet(creds, p) }, {
        partBuildingCode,
        tenantKey: creds.baseUrl
      });
      if (b3.id) inherited3.buildingId = b3.id;
      console.log(`>>> [JOB-BUILDING] ordine ${jobNumber} (aggiornamento): ${b3.note}`);
    }
    // ================================================================
    // [ORDER-QTY-SYNC] LA QUANTITA' NON E' PIU' `TotalQuantity` E BASTA, E IL `PUT` NON PARTE
    // SEMPRE (feature 0033).
    //
    // Due cose insieme. La prima: la quantita' da scrivere sul lotto principale e' la quantita'
    // SAP MENO la somma dei pacchetti vivi su Plex. Qui i pacchetti sono sempre zero — un ordine
    // spacchettato non arriva a `processOrder`, lo escludono `filterNotYetSent` nel job e il
    // dirottamento sul percorso mirato nell'action — quindi il target coincide con la quantita'
    // dell'ordine, cioe' il comportamento di prima. La formula sta comunque in `qtyRules` e non
    // in un `?:` qui, perche' e' la STESSA che usa srv/lib/orderQtySync.js per gli ordini
    // spacchettati: due copie divergerebbero al primo caso limite aggiunto da una parte sola.
    //
    // La seconda, ed e' quella che si vede subito: se sul job non c'e' niente da cambiare il `PUT`
    // NON SI MANDA. Prima partiva a ogni ri-sincronizzazione, e allora quel `PUT` rispondeva `500`
    // (srv/external/PLEX_ISSUE_JOB_QUANTITY_UPDATE_500.it.md, difetto Plex girato il 20/08/2026 e
    // CORRETTO da Rockwell il 27/08, verificato sul tenant): l'ordine chiudeva `E` e veniva ritentato
    // indefinitamente per un aggiornamento che non aveva niente da aggiornare. La regola NON era un
    // aggiramento e resta: una scrittura che non ha niente da scrivere non si manda comunque — costa
    // una richiesta e riscrive una testata intera su un oggetto vivo. `existingJob` viene dal passo 2,
    // quindi il confronto non costa nessuna lettura.
    // ================================================================
    const target3 = qtyRules.computeMainTarget({
      order: jobNumber,
      sapQty: order.TotalQuantity,
      lots: [{
        jobNumber,
        verdict: qtyRules.LOT_VERDICT.FOUND,
        quantity: existingJob.quantity
      }]
    });
    if (!target3.ok) {
      // Qui l'unico motivo raggiungibile e' `NO_SAP_QTY`: il lotto e' stato letto (siamo in questo
      // ramo perche' esiste) e i pacchetti non ci sono. Si dichiara comunque il motivo, o un caso
      // futuro uscirebbe con un messaggio che non lo nomina.
      return outcome('E', [
        logMsg.seg(orderQtySync.REASON_KEY[target3.reason] || 'logOrderQtyNoSapQty', jobNumber)
      ], { steps, plex });
    }
    const dueDate3 = toIso(order.MfgOrderPlannedEndDate);
    const verdict3 = qtyRules.classifySync({
      target: target3.target,
      currentQty: existingJob.quantity,
      sapDueDate: dueDate3,
      plexDueDate: existingJob.dueDate
    });

    if (verdict3.state === qtyRules.SYNC.IN_SYNC) {
      console.log(`>>> [ORDER-QTY-SYNC] ordine ${jobNumber}: job gia' allineato`
        + ` (quantita ${verdict3.to}, consegna ${dueDate3}), nessun PUT`);
      steps.push({
        step: '3 Update Job non necessario',
        // Le due date e le due quantita', non solo quelle SAP: il verdetto ha DUE variabili, e una
        // traccia che ne dichiara una sola fa attribuire a quella ogni differenza.
        request: {
          quantity: verdict3.to,
          quantitaSuPlex: existingJob.quantity,
          dueDate: dueDate3,
          dataSuPlex: existingJob.dueDate || null
        },
        status: 0,
        response: 'job gia\' allineato: nessuna chiamata verso Plex',
        // Dichiarazione, non chiamata: `status: 0` in coda spegnerebbe il semaforo «HTTP nnn»
        // dello storico, che deve restare quello dell'operazione principale (DEC-38).
        aux: true
      });
    } else {
      // [JOB-PUT] La scala dei due corpi, la stessa che usa lo spacchettamento: sul `5xx` si
      // ritenta con i soli tre campi obbligatori, cosi' il log dice QUALE forma questo tenant
      // accetta invece di farci indovinare. Su un `4xx` no: e' un rifiuto conclusivo dello schema.
      const bodies3 = jobPutBodies(inherited3, { dueDate: dueDate3, quantity: target3.target });
      let r3 = null;
      let body3 = null;
      for (let i = 0; i < bodies3.length; i += 1) {
        body3 = bodies3[i].body;
        // [PLEX-CALL] Tracciato come il passo 5. Lo era perche' su questo tenant rispondeva `500`
        // (difetto Plex, corretto il 27/08/2026); resta tracciato perche' su QUALUNQUE risposta non
        // documentata dal contratto il corpo e' l'unico indizio. Si riusa `tracedPlex`, perche' due
        // `wrap` darebbero due contatori `seq` sullo stesso ordine.
        // [ORDER-SORT-ON-WRITE] Una scrittura in volo: se lancia qui, l'esito su Plex e' ignoto.
        trace.inFlight = true;
        r3 = await tracedPlex.put(`/scheduling/v1/jobs/${jobId}`, body3);
        trace.inFlight = false;
        if (r3.ok) trace.written = true;
        if (r3.ok || i === bodies3.length - 1 || r3.status < 500) break;
        steps.push({
          step: '3a Update Job (tentativo scartato)',
          request: body3,
          status: r3.status,
          response: r3.body,
          // Il semaforo dev'essere quello del tentativo che DECIDE, non del primo che cade.
          aux: true
        });
      }
      steps.push({ step: '3 Update Job', request: body3, status: r3.status, response: r3.body });
      if (!r3.ok) {
        return outcome('E', [
          logMsg.seg('logOrderJobUpdateFailed', jobNumber),
          logMsg.technical(plexErrText(r3))
        ], { steps, plex });
      }
      // [SCHED-CONTINUE] Il contratto richiede una rischedulazione dopo un cambio di quantita' o di
      // data (PLEX_JOB_API_CONTRACT.md), e lo spacchettamento la fa gia' al passo P2. Qui mancava:
      // il ramo di aggiornamento cambiava la testata e lasciava le operazioni schedulate sulla
      // vecchia. E' un passo ACCESSORIO — se cade si raccoglie l'attenzione e la sequenza prosegue,
      // perche' allineare distinta e operazioni di un job non rischedulato resta utile.
      const schedBody3 = { useFirstApprovedWorkcenter: USE_FIRST_APPROVED_WORKCENTER };
      try {
        const rs3 = await tracedPlex.post(`/scheduling/v1/jobs/${jobId}/backwards-schedule`, schedBody3);
        steps.push({
          step: '3b Backwards Schedule (dopo aggiornamento)',
          request: schedBody3, status: rs3.status, response: rs3.body, aux: true
        });
        if (!rs3.ok) scheduleWarning = plexErrText(rs3, 'backwards-schedule dopo aggiornamento');
      } catch (e) {
        steps.push({
          step: '3b Backwards Schedule (dopo aggiornamento)',
          request: schedBody3, status: 0, response: `nessuna risposta: ${e.message}`, aux: true
        });
        scheduleWarning = `backwards-schedule dopo aggiornamento senza risposta: ${e.message}`;
      }
    }
  } else {
    // --- Step 4: Add Job ---
    // [JOB-BUILDING] Il building si risolve PRIMA di creare. L'ipotesi del 19/08/2026 era che un job
    // nato con `buildingId: null` fosse la causa del `500` sull'aggiornamento: si e' rivelata falsa
    // (difetto Plex, corretto il 27/08), ma il tenant USA i building e un job senza e' comunque un
    // job mal collocato. Catena: `buildingCode` della part -> unico building attivo -> PLEX_BUILDING_ID.
    const building = await plexBuildings.resolveBuildingId({ get: (p) => plexGet(creds, p) }, {
      partBuildingCode,
      tenantKey: creds.baseUrl
    });
    console.log(`>>> [JOB-BUILDING] ordine ${jobNumber}: ${building.note}`);

    // [JOB-WINDOW] Il vincolo di inizio si manda solo se e' una finestra vera. Inizio = fine
    // pianificati (frequente in SAP) darebbe ampiezza zero: era una delle sei precondizioni sospettate
    // per il `500` del passo 5 — non era la causa, il difetto era di Plex ed e' stato corretto il
    // 27/08/2026 — ma uno scheduler a rovescio con zero spazio non ha comunque niente su cui
    // calcolare, e il campo e' opzionale. Vedi `schedulingWindow` in srv/lib/plexJobFields.js.
    const win4 = schedulingWindow({
      start: toIso(order.MfgOrderPlannedStartDate),
      due: toIso(order.MfgOrderPlannedEndDate)
    });
    console.log(`>>> [JOB-WINDOW] ordine ${jobNumber}: ${win4.note}`);

    const body4 = {
      partId: plex.partId,
      dueDate: toIso(order.MfgOrderPlannedEndDate),
      // [JOB-FIELDS] `TotalQuantity` e' un `Edm.Decimal`, cioe' una STRINGA su OData V2 — nel run
      // del 20/08/2026 partiva `"quantity": "100.0"` mentre `AddJobInput` dichiara `number/double`.
      quantity: quantityOf(order.TotalQuantity),
      jobNumber,
      externalJobCode: jobNumber,
      ...earliestStartField({
        start: toIso(order.MfgOrderPlannedStartDate),
        due: toIso(order.MfgOrderPlannedEndDate)
      }),
      // [JOB-FIELDS] `jobType` <- AUART dell'ordine (foglio `5. Orders or Jobs`), con la costante
      // d'ambiente come solo ripiego. Vuoto = chiave omessa e Plex usa il suo default.
      ...jobTypeField(order, JOB_TYPE),
      // [JOB-BUILDING] Risolto qui sopra; `BUILDING_ID` resta l'ultimo anello della catena.
      ...(building.id ? { buildingId: building.id } : {}),
      // PLACEHOLDER — inclusi solo se valorizzati (vedi costanti in testa al file)
      ...(!building.id && BUILDING_ID ? { buildingId: BUILDING_ID } : {}),
      ...(PRIORITY ? { priority: PRIORITY } : {}),
      ...(JOB_NUMBER_PREFIX ? { jobNumberPrefix: JOB_NUMBER_PREFIX } : {}),
      ...(JOB_NUMBER_SUFFIX ? { jobNumberSuffix: JOB_NUMBER_SUFFIX } : {})
    };
    // [ORDER-SORT-ON-WRITE] Come al passo 3. `written` anche sull'OK senza id: il job esiste, e
    // l'uscita in errore qui sotto non arriva al passo 8 — e' l'involucro a chiudere con l'ordinamento.
    trace.inFlight = true;
    const r4 = await plexPost(creds, '/scheduling/v1/jobs', body4);
    trace.inFlight = false;
    if (r4.ok) trace.written = true;
    steps.push({ step: '4 Add Job', request: body4, status: r4.status, response: r4.body });
    if (!r4.ok || !r4.body?.id) {
      // [ORDER-MAP-JOB] Questa condizione ne collassa DUE, e le due hanno esiti opposti sul
      // dizionario: «Plex ha rifiutato» (nessun job) e «Plex ha creato il job e non ci ha detto
      // l'id» (il job ESISTE). Il secondo caso non si vede dai dati — `plex.jobId` resta vuoto in
      // entrambi — quindi il marcatore si mette QUI, dove la differenza e' ancora nota: senza,
      // la riga non verrebbe scritta e il lotto sarebbe perso di vista. «Non lo so» non e'
      // «non c'e'» (DEC-80).
      if (r4.ok) {
        plex.jobCreated = true;
        console.warn(`>>> [ORDER-MAP-JOB] ordine ${jobNumber}: la POST del job ha risposto`
          + ` ${r4.status} SENZA id nel corpo. Il job su Plex puo' esistere: il dizionario si`
          + ' scrive lo stesso, senza id.');
      }
      return outcome('E', [logMsg.seg('logOrderJobCreateFailed', jobNumber, r4.status)], { steps, plex });
    }
    jobId = r4.body.id;
    // [ORDER-MAP-JOB] Come sopra: il job esiste da adesso, e ogni uscita in errore piu' sotto
    // deve portarsi dietro il suo id.
    plex.jobId = jobId;
    created = true;
    plex.jobNumber = r4.body.jobNumber || jobNumber;
    plex.externalJobCode = r4.body.externalJobCode || jobNumber;

    // ================================================================
    // --- Step 5: Backwards Schedule ---
    //
    // [SCHED-CONTINUE] IL FALLIMENTO NON E' PIU' UN'USCITA ANTICIPATA.
    // Prima un passo 5 fallito faceva `return`, e con quel return saltavano i passi 6, 7 e 8: il
    // job restava su Plex con TUTTA la distinta attiva e nessuna operazione messa a NOT Required,
    // cioe' in fabbrica comparivano componenti che l'ordine SAP non ha. Il contratto dice che le
    // operazioni del job esistono GIA' dopo il POST del passo 4 («Both the job header and job
    // operations are created, but job operations are not scheduled»), quindi 6 e 7 hanno di che
    // lavorare anche su un job non schedulato: allineare una distinta e' utile, schedularla no.
    //
    // E' lo stesso verso della 0014 sul fallimento dell'allineamento: esito degradato a 'W',
    // sequenza che prosegue. L'esito resta quello di prima — cambia che la traccia arriva completa e
    // che il messaggio porta il CORPO dell'errore di Plex.
    //
    // Il corpo c'era e si buttava via: `plexPost` lo restituisce anche sul ramo d'errore, e
    // `plexErrText` (srv/lib/plexCallTrace.js, gia' usato dallo spacchettamento su QUESTA stessa
    // chiamata) rende `code` + `metadata.internalMessage`. Su un backwards-schedule serve: il
    // contratto documenta solo 200/400/404, quindi un 500 «Data is Null» e' un null non gestito
    // dentro Plex e l'unico indizio su quale campo sia nullo sta in quel corpo.
    // ================================================================
    // [SCHED-OFF] STORIA DI QUESTA CHIAMATA — sospesa dal 20 al 27/08/2026, IN ESERCIZIO, difetto CHIUSO.
    //
    // PERCHE' ERA SPENTA. Su questo tenant l'operazione rispondeva `500 Data is Null` in modo
    // RIPRODUCIBILE: cinque precondizioni su sei dimostrate verdi — rate compreso, valorizzato a mano
    // su tutte e quattro le part-operation e riletto dalla GET approved-workcenters — e payload
    // conforme al contratto campo per campo, con otto variabili escluse a esperimento singolo. Era un
    // difetto di Plex, non una nostra configurazione da correggere, e finche' e' restato aperto ogni
    // ordine inviato chiudeva in attenzione con un messaggio inutilizzabile per l'utente. Le prove
    // sono versionate, coi payload esatti, la matrice delle variabili escluse e le precondizioni:
    //   srv/external/PLEX_ISSUE_BACKWARDS_SCHEDULE_500.en.md  (e la versione .it.md)
    //   srv/external/PLEX_ISSUE_JOB_QUANTITY_UPDATE_500.en.md (il difetto gemello sul PUT)
    //
    // CHIUSO IL 27/08/2026. Girato a Rockwell il 20/08, corretto da loro insieme al gemello sul `PUT`,
    // e la correzione e' stata VERIFICATA sul tenant: l'operazione risponde. I due dossier restano
    // come traccia del caso, ciascuno con la sua sezione di chiusura.
    //
    // COSA RESTA, ORA CHE IL DIFETTO NON C'E' PIU'. Un passo 5 fallito continua a NON interrompere la
    // sequenza: l'ordine chiude `W` col corpo dell'errore di Plex nel messaggio e i passi 6, 7 e 8
    // girano COMUNQUE — e' il punto di [SCHED-CONTINUE] qui sopra, che non era una difesa contro
    // QUESTO difetto ma la constatazione che allineare la distinta di un lotto non schedulato e'
    // comunque utile. Spenta, invece, `scheduleWarning` restava `null`: l'ordine chiudeva `S` e le
    // operazioni del job non erano schedulate, cioe' senza date — un silenzio peggiore dell'errore.
    // Il corpo manda `useFirstApprovedWorkcenter: FALSE` ([WC-FALSE]) e continua a mandarlo: era una
    // delle due configurazioni che il dossier dichiarava mai provate, ma la ragione per cui e' il
    // default sono il contratto Plex e l'API List del cliente, non l'indagine.
    //
    // LA LEZIONE, che vale piu' della correzione. «Data is Null» e' un involucro generico e per una
    // settimana ha fatto sembrare UN SOLO fenomeno tre chiamate rotte: due lo erano per il difetto di
    // Plex, la terza — `GET /scheduling/v1/jobs?jobNumber=` — non lo era affatto. La' sbagliavamo noi,
    // chiedendo per numero un job di cui avevamo gia' l'id, e il rimedio e' stato leggerlo per
    // IDENTIFICATIVO (DEC-80, srv/lib/plexJobRead.js). Un corpo d'errore identico non e' una prova di
    // causa comune: e' un'assenza di informazione.
    //
    // IL TRACCIATO E' QUELLO DEL PASSO 4bis, non un secondo. `steps` porta request e response nello
    // storico dell'ordine ma non in console e non verso il browser (DEC-10, C-3), mentre
    // `plexCallTrace.wrap` NON aggiunge nessuna chiamata: avvolge questa, ne stampa in `cf logs`
    // corpo inviato e corpo ricevuto, e ne registra una voce nell'anello che il cockpit stampa subito
    // dopo «Crea Job in Plex» (`window.plexCalls()`). Si riusa `tracedPlex` perche' due wrap
    // aprirebbero due contatori `seq` e nella traccia dello STESSO ordine comparirebbero due `#1`.
    // Le credenziali non passano da li': il wrapper vede path e body.
    //
    // Perimetro: grep -rn "SCHED-OFF" (la storia) e grep -rn "PLEX-CALL" (il tracciato).
    // ================================================================
    const body5 = { useFirstApprovedWorkcenter: USE_FIRST_APPROVED_WORKCENTER };
    const r5 = await tracedPlex.post(`/scheduling/v1/jobs/${jobId}/backwards-schedule`, body5);
    steps.push({ step: '5 Backwards Schedule', request: body5, status: r5.status, response: r5.body });
    if (!r5.ok) {
      // [LOG-MSG-I18N] SEGMENTI, non la stringa italiana che questo passo scriveva prima della
      // sospensione: da qui il testo finisce nello «Storico Invii» dell'ordine, dove si rende alla
      // LETTURA nella lingua di chi guarda (DEC-92) — e un messaggio nuovo nasce a segmenti. Il corpo
      // d'errore di Plex e' testo di terzi, quindi `technical`.
      scheduleWarning = [
        logMsg.seg('logOrderJobScheduleFailed', jobNumber),
        logMsg.technical(plexErrText(r5))
      ];
      console.warn(`>>> [SCHED-CONTINUE] ordine ${jobNumber}: ${renderMsg(scheduleWarning)}.`
        + ' I passi 6-7 proseguono: il job esiste e la sua distinta va allineata comunque.');
    }
  }

  // [ORDER-MAP-JOB] `plex.jobId` NON si assegna qui: stava qui e basta, cioe' in fondo alla
  // sequenza, quindi ogni uscita in errore fra la nascita del job e questo punto produceva un
  // `plex` senza id — e la riga di dizionario del lotto restava con `PlexJobId: null` su un job
  // che su Plex esisteva davvero. Ora lo scrivono i due punti in cui il job diventa noto
  // (`jobId = existingJob.id` e `jobId = r4.body.id`), che sono anche i soli due che assegnano
  // `jobId`. Riassegnarlo qui sarebbe scrivere lo stesso valore una terza volta.
  if (!plex.jobNumber) plex.jobNumber = jobNumber;

  // ================================================================
  // --- Step 4bis: i componenti extra nella distinta DEL LOTTO (feature 0025) ---
  //
  // Il piano l'ha costruito il passo 2bis; qui si scrive, e si puo' farlo solo adesso perche'
  // `jobOpId` e' l'id di una operazione DEL JOB, che prima non esisteva. Una sola `POST`:
  // `JobBomComponentCommand` viaggia in un array.
  //
  // E' L'UNICO PUNTO DELLA SEQUENZA CHE PUO' FALLIRE A JOB GIA' NATO, e per questo non e' un gate:
  // il job c'e' e cancellarlo non e' una strada (`cancel` non e' mai stato provato su questo tenant,
  // e un annullamento fallito lascerebbe uno stato peggiore). Si chiude in ERRORE dichiarando che la
  // distinta del lotto e' incompleta, e il run successivo ripete la `POST` — l'operazione e'
  // `add-update`, quindi ripeterla non duplica.
  //
  // Un `return` qui salterebbe i passi 6-8, ed e' il difetto che [SCHED-CONTINUE] ha gia' pagato una
  // volta: l'attenzione si RACCOGLIE e la sequenza prosegue. Allineare per sottrazione la distinta
  // di un lotto a cui manca una riga e' comunque utile, e non dipende da questo passo.
  //
  // [JOB-HEADER-ONLY] SU UN JOB CHE ESISTEVA QUESTO PASSO NON GIRA, e non serve un cancello qui: il
  // piano e' vuoto per costruzione, perche' il prevolo del 2bis non e' stato eseguito. Un solo
  // cancello, non due condizioni da tenere allineate (0038).
  // ================================================================
  let bomAddWarning = null;
  if (bomPlan.plan.length) {
    const bomWrite = await orderBomAdd.applyJobBomAdditions({
      plexGet: tracedPlex.get,
      plexPost: tracedPlex.post,
      jobId,
      jobNumber,
      plan: bomPlan.plan,
      steps
    });
    order._bomAddStats = {
      created: bomWrite.created,
      failures: bomWrite.failures,
      planned: bomPlan.plan.length
    };
    if (!bomWrite.ok) {
      bomAddWarning = bomWrite.message;
      console.error(`>>> [ORDER-BOM-ADD] ordine ${jobNumber}: ${bomWrite.message}`);
    }
  }

  // --- Step 6-7: allineamento operazioni/BOM (Data Source API) ---
  // FEATURE 0014: il fallimento NON e' piu' un early return. Il job esiste ed e' nella lista di
  // lavoro, quindi il passo 8 ha senso anche con l'allineamento incompleto (FDD §2.2, riga D).
  // Il messaggio e lo status restituiti restano IDENTICI a prima: qui si trasforma solo il
  // punto di uscita in una variabile.
  //
  // [JOB-HEADER-ONLY] GIRA SOLO SUL JOB NATO IN QUESTO GIRO (0038). `created` e' il termine giusto e
  // c'e' gia': dice «il lotto e' stato creato adesso», che e' esattamente la condizione. Su un job
  // che esisteva la distinta e le operazioni non si toccano.
  let alignWarning = null;
  // [JOB-HEADER-ONLY] La dichiarazione del salto: chi apre lo Storico Invii deve trovare scritto
  // che quel giro NON ha riallineato, o l'assenza di righe 6-7 si legge come un allineamento
  // riuscito. Passo ACCESSORIO: non e' una chiamata e non tinge il semaforo dell'ordine (DEC-38).
  let headerOnlyNote = null;
  if (!created) {
    const skipMsg = i18nMessages.render(
      [logMsg.seg('logOrderAlignSkippedExisting', jobNumber)],
      i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE
    );
    steps.push({
      step: '3ter Allineamento non eseguito — job già creato',
      request: { componenti: (order.components || []).length },
      status: 0,
      response: skipMsg,
      aux: true
    });
    console.log(`>>> [JOB-HEADER-ONLY] ordine ${jobNumber}: ${skipMsg}`);
    headerOnlyNote = [logMsg.seg('logOrderAlignSkippedExisting', jobNumber)];

    // ================================================================
    // [JOB-HEADER-ONLY] LA LACUNA RESIDUA, che va NOMINATA una volta e poi non tornera' piu'.
    //
    // Un ordine il cui primo invio si era fermato DOPO la creazione del job — la scrittura dei
    // componenti extra non riuscita, l'allineamento caduto — veniva ripescato ogni notte e riparato.
    // Ora no: questo giro fa la sola testata, l'ordine chiude riuscito e il delta non lo ripeschera'
    // piu'. E' voluto (continuare non servirebbe: i componenti non si riscriverebbero comunque), ma
    // il lotto su Plex resta con quella lacuna, e se nessuno lo dice l'ordine passa da «rotto» a
    // «riuscito» senza che niente lo ricordi.
    //
    // Si guarda l'esito dell'invio PRECEDENTE, non per decidere — il discriminante resta il ramo —
    // ma solo per sapere se c'e' qualcosa da dichiarare. Una lettura locale, e se fallisce si tace:
    // e' una dichiarazione, non un gate, e non deve far cadere l'aggiornamento di una testata.
    // ================================================================
    try {
      const prev = await db.run(
        SELECT.one.from(E_MAPPING).columns('Status')
          .where({ ManufacturingOrder: order.ManufacturingOrder, PlexJobNumber: jobNumber })
      );
      if (prev && prev.Status && prev.Status !== 'S') {
        headerOnlyNote.push(logMsg.seg('logOrderAlignGapResidual', jobNumber));
        console.warn(`>>> [JOB-HEADER-ONLY] ordine ${jobNumber}: l'invio precedente era chiuso`
          + ` '${prev.Status}' col job già creato — la lacuna sul lotto NON viene riallineata`);
      }
    } catch (prevErr) {
      console.warn(`>>> [JOB-HEADER-ONLY] ordine ${jobNumber}: esito precedente non letto`
        + ` (${prevErr.message}): nessuna dichiarazione di lacuna residua`);
    }
  } else {
    try {
      // Dettagli ordine (operazioni/componenti): dalla 0025 li carica il passo 2bis. Il guardiano
      // resta perche' `processOrder` non e' l'unico percorso che arriva a questo allineamento (lo
      // spacchettamento inietta `align` con un ordine proprio), e rileggere sarebbe una seconda
      // coppia di chiamate a SAP per ogni ordine.
      if (!order.components) await loadOrderDetails(s4, order);
      await alignJobOperationsAndBom(creds, order, steps);
    } catch (err) {
      alignWarning = [
        // [JOB-HEADER-ONLY] Una chiave sola: l'allineamento gira ormai solo in creazione, quindi la
        // gemella `logOrderAlignIncompleteUpdated` non era piu' raggiungibile ed e' stata rimossa.
        logMsg.seg('logOrderAlignIncompleteCreated', jobNumber),
        logMsg.technical(err.message)
      ];
    }
  }

  // [ORDER-CYCLE-SEED] Il passo 7b — la semina del ciclo dell'ordine — sta ora al passo 2ter,
  // PRIMA della creazione del job: e' cio' che rende possibile il gate «un ordine senza operazioni
  // nel ciclo non si crea» ([ORDER-CYCLE-REQUIRED], feature 0026). Il suo esito e' in `seed`.

  // --- Step 8: ordinamento della lista di lavoro (feature 0014) ---
  // Ultimo passo per ordine elaborato, nei due punti d'ingresso (FR-01, FR-03). Non lancia mai
  // e non tocca l'esito dell'ordine: `sort` e' un campo ADDITIVO del ritorno (P2, FR-20).
  const sort = await runJobSortStep({
    creds,
    plant: order.ProductionPlant,
    config: opts.sortConfig,
    db: opts.db,
    steps,
    timeoutMs: opts.sortTimeoutMs
  });

  // [SCHED-CONTINUE] Le due attenzioni non bloccanti della sequenza, nell'ordine in cui sono
  // capitate: la schedulazione prima, l'allineamento dopo. Con la sola prima il messaggio e
  // l'esito sono identici a quelli che il `return` del passo 5 produceva; con entrambe si vedono
  // entrambe, invece della sola che era arrivata prima a un punto d'uscita.
  //
  // L'ORDINE NON E' CRONOLOGICO PER CASO: `writeMappingAndLog` taglia `Message` a 255 caratteri
  // (la colonna e' String(255) e HANA lo impone), e la sola attenzione del passo 5 col corpo
  // d'errore di Plex ne occupa circa 156. Quando scattano entrambe, quella che perde la coda nel
  // log e' la SECONDA: davanti va il guasto primario, e il dettaglio integrale di entrambe resta
  // comunque nella traccia dei passi (`steps`, con richiesta e risposta per intero) e sulla
  // console. Se un giorno servisse il testo intero in testata, la strada e' guardare lo step —
  // non allargare la colonna.
  //
  // [ORDER-BOM-ADD] La distinta incompleta del lotto va PER PRIMA, e per due ragioni. Nel
  // troncamento a 255 caratteri e' il guasto primario a dover sopravvivere; e a differenza delle
  // altre due non e' un'attenzione ma un ERRORE — un lotto in produzione senza un componente che
  // l'ordine ha e' il difetto che questa feature esiste per evitare, e serve anche a far tornare
  // l'ordine al prossimo run, che e' il modo in cui si ripara.
  //
  // Subito dopo il prevolo non superato dell'invio manuale, che e' la stessa notizia vista prima
  // della creazione: non degrada a `E` — il job e' stato creato APPOSTA, con l'utente che ha
  // deciso — ma non puo' tacere, o un lotto con la distinta incompleta sarebbe indistinguibile da
  // uno completo.
  // [LOG-MSG-I18N] Le attenzioni sono SEGMENTI e si concatenano come tali. Due di esse — il
  // prevolo e la scrittura della distinta — arrivano da srv/lib/orderBomAdd.js come prosa nostra
  // non ancora convertita, quindi viaggiano avvolte in `verbatim`: lacuna dichiarata, non
  // scorciatoia (grep -rn "logMsgVerbatim").
  const warnings = [
    ...(bomAddWarning ? [logMsg.verbatim(bomAddWarning)] : []),
    ...(bomPreflightWarning ? [logMsg.verbatim(bomPreflightWarning)] : []),
    // [COMP-SOURCE] Il ripiego di un bersaglio manuale: prosa nostra come le due qui sopra, e con
    // la stessa lacuna dichiarata. Non degrada a `E` — il componente e' stato collocato.
    ...bomManualNotes.map((n) => logMsg.verbatim(n)),
    ...(Array.isArray(scheduleWarning) ? scheduleWarning : []),
    ...(Array.isArray(alignWarning) ? alignWarning : [])
  ];

  // [JOB-HEADER-ONLY] Le DICHIARAZIONI si accodano al messaggio e NON entrano in `warnings`: se
  // entrassero, ogni aggiornamento di testata chiuderebbe in attenzione, l'ordine perderebbe lo
  // stato «riuscito» e il delta del job lo ripescherebbe a ogni run — per sempre, e senza poterlo
  // mai riparare. Sono notizie, non guasti.
  const headerOnlyNotes = Array.isArray(headerOnlyNote) ? headerOnlyNote : [];

  return outcome(
    bomAddWarning ? 'E' : (warnings.length ? 'W' : 'S'),
    (warnings.length
      ? warnings
      : [logMsg.seg(created ? 'logOrderJobCreated' : 'logOrderJobUpdated', jobNumber)]
    ).concat(headerOnlyNotes),
    {
      steps,
      plex,
      sort,
      // [ORDER-CYCLE-SEED] Esito del passo accessorio, ADDITIVO come `sort`: non entra in `status`.
      seed
    }
  );
}

/**
 * [LOG-MSG-I18N] L'esito di `processOrder`, con il messaggio in DUE forme.
 *
 * `segments` e' la verita' — la porta `ZProdOrderExcLogPOS.MessageJson` e la lettura la rende nella
 * lingua di chi guarda — e `message` e' lo snapshot testuale, che resta perche' lo usano tre
 * consumatori che non sanno niente di segmenti: il recap del job, la risposta dell'action
 * `createJobInPlex` verso il cockpit, e i `console` di questo file.
 *
 * Lo snapshot e' reso a `SNAPSHOT_LOCALE`, cioe' in italiano, che e' la lingua in cui il ciclo di
 * run compone le righe di recap attorno a questo testo: con l'inglese una riga sola dentro il PDF
 * uscirebbe in un'altra lingua.
 *
 * @param {'S'|'W'|'E'} status
 * @param {Array} segments
 * @param {object} [extra] `steps`, `plex`, `sort`, `seed`, …
 */
/** Il testo di una lista di segmenti, in italiano: per i log del task e i messaggi del recap. */
const renderMsg = (segments) => i18nMessages.render(
  logMsg.normalize(segments), i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE
);

function outcome(status, segments, extra = {}) {
  const segs = logMsg.normalize(segments);
  return {
    status,
    segments: segs,
    message: i18nMessages.render(segs, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE),
    ...extra
  };
}

// ================================================================
// [ORDER-QTY-SYNC] Controllo di quantita' degli ordini gia' inviati (feature 0033)
// ================================================================

/**
 * Per ogni ordine gia' presente su Plex, verifica che la quantita' del lotto principale sia ancora
 * quella che l'ordine SAP dichiara — al netto dei pacchetti — e la riallinea se non lo e'.
 *
 * PERCHE' E' UNA FASE A SE' E NON UN RAMO DEL CICLO PRINCIPALE. Il ciclo principale INVIA: legge il
 * ciclo, esplode i fantasma, allinea distinta e operazioni. Un ordine gia' inviato non ha bisogno di
 * niente di tutto questo, e su un ordine SPACCHETTATO `processOrder` e' addirittura vietato (RB-28
 * della 0012: riporterebbe il lotto principale alla quantita' piena).
 *
 * [ORDER-SORT-ON-WRITE] L'ORDINAMENTO DELLA LISTA DI LAVORO INVECE SI', quando questa fase scrive.
 * Era nell'elenco qui sopra, ed era la premessa sbagliata: ogni volta che un ordine cambia su Plex
 * perche' gli abbiamo mandato dei dati la lista si riordina, dal job come dal cockpit (addendum del
 * 06/10/2026 a DEC-100). Il passo lo fa `syncOrderQuantity` con la dipendenza iniettata qui; la
 * configurazione e' quella memoizzata dal run (`sortConfigFor`), e i contatori finiscono nello
 * stesso `sortStats` del ciclo principale, cioe' nella stessa riga di recap per plant. Senza i tre
 * parametri la regola vale lo stesso: la configurazione si legge da `db`, i contatori restano qui.
 *
 * EFFICIENZA, che era una richiesta esplicita. Tre cose:
 *   - gli ordini sono GIA' stati letti da SAP dal ciclo principale, con `TotalQuantity` nel
 *     `$select`: nessuna lettura SAP in piu';
 *   - il dizionario dei lotti si legge in UNA query per l'intero run e si indicizza in memoria, non
 *     una query per ordine (e' la forma di `loadCandidates` del job PROD_TECO);
 *   - un ordine non spacchettato costa UNA lettura verso Plex, e se non e' cambiato niente non ne
 *     costa nemmeno una di scrittura.
 *
 * NESSUN PRE-FILTRO sullo snapshot `ZProdOrderPlexMapping.Quantity`: sarebbe la strada breve per
 * evitare le letture, ma quello snapshot per il lotto principale NON viene nemmeno scritto da questo
 * flusso, e dove esiste racconta l'ultima scrittura NOSTRA — non cosa c'e' su Plex adesso.
 *
 * @returns {Promise<{checked: number, updated: number, inSync: number, warned: number, failed: number}>}
 */
async function runQuantityCheck({
  db, summary, connFor, orders,
  sortConfigFor = (plant) => resolveSortConfig(db, String(plant || '')),
  sortStats = {},
  sortTimeoutMs = SORT_BATCH_TIMEOUT_MS
}) {
  const stats = { checked: 0, updated: 0, inSync: 0, warned: 0, failed: 0 };
  let list = Array.isArray(orders) ? orders : [];
  if (!list.length) return stats;

  if (QTY_CHECK_MAX_ORDERS > 0 && list.length > QTY_CHECK_MAX_ORDERS) {
    const dropped = list.length - QTY_CHECK_MAX_ORDERS;
    console.log(`>>> [ORDER-QTY-SYNC] tetto per run: controllo ${QTY_CHECK_MAX_ORDERS} di ${list.length} ordini`);
    // Il troncamento si dichiara: passa da `scope()` e non da `record()`, perche' non e' un oggetto
    // trattato — e degrada, perche' un perimetro ridotto in silenzio si legge come «tutti allineati».
    if (summary) {
      summary.scope({
        objectType: 'PROD_ORDER_QTY',
        objectKey: 'QTY_CAP',
        status: 'W',
        segments: [logMsg.seg('logOrderQtyCapped', dropped, list.length)]
      });
    }
    list = list.slice(0, QTY_CHECK_MAX_ORDERS);
  }

  // UNA query per l'intero run, indicizzata per ordine.
  const wanted = [...new Set(list.map((o) => o.ManufacturingOrder))];
  const mapRows = await db.run(
    SELECT.from(E_MAPPING)
      .columns('ManufacturingOrder', 'PlexJobNumber', 'PlexJobId', 'SplitState')
      .where({ ManufacturingOrder: { in: wanted } })
  );
  const byOrder = new Map();
  for (const r of mapRows || []) {
    if (!byOrder.has(r.ManufacturingOrder)) byOrder.set(r.ManufacturingOrder, []);
    byOrder.get(r.ManufacturingOrder).push(r);
  }

  console.log(`>>> [ORDER-QTY-SYNC] controllo quantita su ${list.length} ordini gia' inviati`);

  for (const order of list) {
    const key = order.ManufacturingOrder;
    const rows = byOrder.get(key) || [];
    // Un ordine senza righe di dizionario non e' su Plex: non c'e' niente da riallineare, e non e'
    // un'anomalia da dichiarare a ogni giro (potrebbe essere una riga cancellata a mano).
    if (!rows.length) continue;

    stats.checked++;
    try {
      const conn = await connFor(order.ProductionPlant);
      if (!conn.creds) throw conn.error;
      const creds = conn.creds;

      // [PLEX-CALL] La traccia e' per ordine, con la stessa etichetta del flusso di invio: in
      // `cf logs` le due si cercano insieme.
      const tracedPlex = plexCallTrace.wrap({
        get: (p) => plexGet(creds, p),
        post: (p, b) => plexPost(creds, p, b),
        put: (p, b) => plexPut(creds, p, b)
      }, { order: key, root: creds.baseUrl, tag: 'PLEX-CALL' });

      // [ORDER-SORT-ON-WRITE] L'ordinamento dopo una scrittura: lo decide `syncOrderQuantity`, qui
      // si mette solo cio' che lei non vede — credenziali, plant, configurazione del run, tetto.
      const sort = async (steps) => runJobSortStep({
        creds,
        plant: order.ProductionPlant,
        config: await sortConfigFor(order.ProductionPlant),
        steps,
        timeoutMs: sortTimeoutMs
      });
      const res = await orderQtySync.syncOrderQuantity({ plex: tracedPlex, sort }, {
        order,
        sapDueDate: toIso(order.MfgOrderPlannedEndDate),
        mappingRows: rows,
        jobTypeFallback: JOB_TYPE
      });
      addSortStat(sortStats, order.ProductionPlant, res.sort);

      if (res.status === 'S' && res.written) stats.updated++;
      else if (res.status === 'S') stats.inSync++;
      else if (res.status === 'E') stats.failed++;
      else stats.warned++;

      // Storico dell'ORDINE, operazione `QTY` e SENZA `updateHeader`: la testata deve continuare a
      // dire com'e' andato l'ultimo INVIO del job, non l'ultimo riallineamento di quantita'.
      //
      // NIENTE RIGA SUL NO-OP NOMINALE. Il ramo `IN_SYNC` esiste per NON parlare con Plex, e una
      // riga di storico si scrive quando la chiamata parte davvero (DEC-96). Questa fase gira a
      // ogni esecuzione su tutti gli ordini gia' inviati, quindi ogni ordine fermo si portava a
      // casa una riga «gia' allineata» per run: un rendiconto di controlli dentro lo storico degli
      // INVII, che seppelliva le righe che contano. Il conteggio non si perde — resta in
      // `stats.inSync`, nel recap del run e in `cf logs`.
      //
      // Il confine — gli altri rami che non scrivono su Plex la riga CE L'HANNO — sta dentro
      // `writesHistory`, che e' pura e ha il suo test: qui non si scrive `res.written`.
      let counter = null;
      if (qtyRules.writesHistory(res.reason)) {
        try {
          counter = await excLog.appendProdOrderLog(db, {
            order: key,
            operation: excLog.OPERATION.QTY,
            status: res.status,
            segments: res.segments,
            steps: res.steps
          });
        } catch (logErr) {
          console.error(`>>> [ORDER-QTY-SYNC] storico non scritto per ${key}: ${logErr.message}`);
        }
      }

      if (summary) {
        summary.record({
          plant: order.ProductionPlant,
          objectType: 'PROD_ORDER_QTY',
          objectKey: key,
          objectKey2: order.Material,
          status: res.status,
          segments: res.segments,
          logRef: counter ? excLog.logRefFor(key, counter) : null
        });
      }
    } catch (error) {
      stats.failed++;
      console.error(`>>> [ORDER-QTY-SYNC] ordine ${key}: ${error.message}`);
      if (summary) {
        summary.record({
          plant: order.ProductionPlant,
          objectType: 'PROD_ORDER_QTY',
          objectKey: key,
          objectKey2: order.Material,
          status: 'E',
          segments: [logMsg.technical(error.message)]
        });
      }
    }
  }

  console.log(`>>> [ORDER-QTY-SYNC] completato — allineati: ${stats.inSync},`
    + ` aggiornati: ${stats.updated}, attenzioni: ${stats.warned}, falliti: ${stats.failed}`
    + ` (su ${stats.checked})`);
  return stats;
}

// ================================================================
// Entry point
// ================================================================

/**
 * @param {object} [summary] collettore del riepilogo di fine job (srv/lib/jobSummary.js).
 *   Opzionale: se assente il job si comporta come prima. Le chiamate a summary.record()
 *   stanno accanto ai console.log/error esistenti, non al loro posto (i log restano la
 *   traccia in `cf logs`).
 */
async function run(summary) {
  console.log(`>>> [JOB CreatePlexOrders] avvio (profilo: ${cds.env.profiles?.join(',') || 'default'})`);

  const db = await cds.connect.to('db');
  const s4 = await prodOrderSource(); // [IS-SOURCE]
  const activePlants = await resolveActivePlants(db);
  // Il canale usato dall'esecuzione entra nel recap come nota (FR-06 punto 3).
  if (summary) summary.note([logMsg.seg('logOrderSource', s4.mode, s4.originDetail)]);

  // ================================================================
  // FEATURE 0014 — passo 8, ordinamento della lista di lavoro Plex.
  // La configurazione di ogni plant si risolve UNA VOLTA per esecuzione e viene memoizzata per
  // la durata del run: tutte le richieste di un'esecuzione devono essere spiegabili con una
  // sola configurazione, anche se il run dura piu' del TTL della cache (FDD §2.6, FR-27, R-6).
  // ================================================================
  const sortConfigs = new Map();
  const sortConfigFor = async (plant) => {
    const key = String(plant || '');
    if (!sortConfigs.has(key)) sortConfigs.set(key, await resolveSortConfig(db, key));
    return sortConfigs.get(key);
  };

  // ================================================================
  // [PLEX-CONN] Connessione Plex del plant (feature 0020), memoizzata per la durata del run
  // sullo stesso modello di sortConfigFor qui sopra e per la stessa ragione: tutte le chiamate
  // di un'esecuzione devono essere spiegabili con una sola configurazione per plant, anche se
  // il run dura piu' del TTL della cache del modulo.
  //
  // Non c'e' un ciclo sui plant da cui appendersi: il ciclo e' PIATTO SUGLI ORDINI, ed e'
  // l'ordine a portare il proprio plant.
  //
  // Un plant NON configurato non ferma il run: fa fallire i propri ordini e basta (fail-closed
  // per plant). La memoizzazione tiene anche l'esito negativo, cosi' venti ordini dello stesso
  // plant non configurato non producono venti letture identiche.
  // ================================================================
  const connections = new Map();
  const connFor = async (plant) => {
    const key = String(plant || '');
    if (!connections.has(key)) {
      try {
        connections.set(key, { creds: await resolvePlexConnection(key, { db }), error: null });
      } catch (e) {
        if (!(e instanceof PlexConnectionMissing)) throw e;
        connections.set(key, { creds: null, error: e });
        console.error(`>>> [PLEX-CONN] plant ${key}: nessuna connessione configurata, i suoi ordini non partono`);
        // Il plant non configurato e' una degradazione di PERIMETRO, non un oggetto trattato:
        // va da scope() e non da record(), che alimenta i contatori e l'exit code (DEC-39).
        if (summary) {
          summary.scope({
            plant: key,
            segments: [logMsg.seg('logOrderPlantNoConnection')]
          });
        }
      }
    }
    return connections.get(key);
  };
  // Contatori per plant del passo 8: oggetto piatto passato al modulo puro (FR-32).
  const sortStats = {};
  // L'identificativo del servizio e' un parametro di RILASCIO, non di customizing (FR-11):
  // dichiararlo nel log e' cio' che rende diagnosticabile un valore sbagliato.
  console.log(`>>> [JOB SORT] Data Source di ordinamento: ${DS_JOB_SORT_ORDER}`
    + `${SORT_BATCH_TIMEOUT_MS > 0 ? `, tetto di attesa ${SORT_BATCH_TIMEOUT_MS} ms` : ', nessun tetto di attesa'}`);

  if (summary && (!activePlants || activePlants.size === 0)) {
    // Oggi questo caso esce 0 in silenzio: nel recap diventa uno stato visibile.
    summary.noScope({ active: 0, usable: 0 });
  }

  const inScope = await loadOrdersInScope(s4, activePlants, summary, db);
  const delta = await filterNotYetSent(db, inScope);
  let todo = delta.todo;

  if (summary) {
    if (delta.alreadySent > 0) summary.skip(delta.alreadySent);

    // Ordini spacchettati (feature 0012, FR-33): una riga di recap per ordine saltato, con
    // esito NORMALE ('S') e non attenzione. Con 'W' l'HDR del run chiuderebbe in anomalia a
    // OGNI esecuzione (jobSummary.js:142 -> :277) e ogni destinatario ON_ERROR riceverebbe
    // una mail a ogni giro, per sempre: è lo scenario che la decisione D-01 evita.
    // Nessuna riga di storico sull'ordine e nessuna chiamata verso Plex.
    for (const s of delta.splitSkipped) {
      summary.record({
        plant: s.order.ProductionPlant,
        objectType: 'PROD_ORDER_SPLIT',
        objectKey: s.order.ManufacturingOrder,
        objectKey2: s.order.Material,
        status: 'S',
        segments: [logMsg.seg('logOrderSplitSkipped', s.packages)]
      });
    }

    // [ORDER-TECO] Ordini chiusi tecnicamente in SAP (feature 0023): stessa forma della riga
    // degli spacchettati, e per la stessa ragione — esito 'S' e non attenzione, altrimenti il
    // run chiuderebbe in anomalia a OGNI esecuzione e i destinatari ON_ERROR riceverebbero una
    // mail per sempre (decisione D-01 della 0012).
    for (const s of delta.tecoSkipped) {
      summary.record({
        plant: s.order.ProductionPlant,
        objectType: 'PROD_ORDER_TECO',
        objectKey: s.order.ManufacturingOrder,
        objectKey2: s.order.Material,
        status: 'S',
        segments: [logMsg.seg('logOrderTecoSkipped')]
      });
    }
  }
  if (delta.tecoSkipped.length) {
    console.log(
      '>>> [ORDER-TECO] ordini con chiusura tecnica rilevata, esclusi dalla ri-sincronizzazione: '
      + delta.tecoSkipped.map((s) => s.order.ManufacturingOrder).join(', ')
    );
  }
  if (delta.splitSkipped.length) {
    console.log(
      `>>> [JOB CreatePlexOrders] ordini spacchettati esclusi dalla ri-sincronizzazione: ` +
      delta.splitSkipped.map((s) => s.order.ManufacturingOrder).join(', ')
    );
  }

  if (MAX_ORDERS_PER_RUN > 0 && todo.length > MAX_ORDERS_PER_RUN) {
    console.log(`>>> [JOB CreatePlexOrders] limite per run: elaboro ${MAX_ORDERS_PER_RUN} di ${todo.length} ordini`);
    if (summary) {
      summary.note([logMsg.seg('logOrderDeferred', todo.length - MAX_ORDERS_PER_RUN)]);
    }
    todo = todo.slice(0, MAX_ORDERS_PER_RUN);
  }

  let sent = 0;
  let warned = 0;
  let failed = 0;

  for (const order of todo) {
    try {
      // [PLEX-CONN] La connessione del plant DELL'ORDINE. Se il plant non è configurato l'ordine
      // fallisce come un invio fallito qualunque — riga di recap, log, contatore — e il ciclo
      // prosegue con gli ordini degli altri plant.
      const conn = await connFor(order.ProductionPlant);
      if (!conn.creds) throw conn.error;
      const creds = conn.creds;

      const outcome = await processOrder(creds, s4, order, {
        sortConfig: await sortConfigFor(order.ProductionPlant),
        sortTimeoutMs: SORT_BATCH_TIMEOUT_MS,
        db
      });
      // PRIMA di writeMappingAndLog: se la scrittura della traccia lanciasse, l'esecuzione
      // salterebbe al catch per-ordine e la statistica del passo 8 sarebbe persa. Contando
      // qui i contatori del recap restano corretti anche in quel caso (riga L della matrice).
      addSortStat(sortStats, order.ProductionPlant, outcome.sort);
      const counter = await writeMappingAndLog(db, order, outcome);

      // processOrder ritorna già 'S'|'W'|'E': mappatura 1:1, nessuna interpretazione.
      if (summary) {
        summary.record({
          plant: order.ProductionPlant,
          objectType: 'PROD_ORDER',
          objectKey: order.ManufacturingOrder,
          objectKey2: order.Material,
          status: outcome.status,
          // I segmenti dell'esito: la stessa verita' scritta nello storico invii dell'ordine.
          segments: outcome.segments,
          logRef: `ZProdOrderExcLogPOS/${order.ManufacturingOrder}/${counter}`
        });
      }

      // [ORDER-CYCLE-SEED] La semina del ciclo dell'ordine si DICHIARA, e passa da `scope()`
      // perche' non e' un oggetto trattato: l'ordine ha gia' la sua riga di recap (DEC-39).
      //
      // Due toni, per la stessa ragione per cui i componenti esclusi non degradano: un ciclo
      // seminato e' l'esito voluto (`degrade: false`, informativo), mentre un ciclo che c'era e non
      // si e' potuto usare — perimetro non verificabile, scrittura fallita — e' un'attenzione. Un
      // materiale che semplicemente non ha ancora un ciclo Plex salvato non e' ne' l'uno ne'
      // l'altro e resta fuori dal recap: sarebbe rumore su ogni ordine di ogni plant non ancora
      // configurato.
      if (summary && outcome.seed && outcome.seed.status !== 'I') {
        summary.scope({
          plant: order.ProductionPlant,
          objectType: 'ORDER_CYCLE_SEED',
          objectKey: order.ManufacturingOrder,
          status: outcome.seed.status,
          segments: [
            logMsg.seg('logOrderCycleSeedHead', order.ManufacturingOrder, order.Material),
            // Il motivo viene da srv/lib/orderCycleSeed.js, ancora a prosa: lacuna dichiarata.
            logMsg.verbatim(outcome.seed.message)
          ],
          degrade: outcome.seed.status !== 'S'
        });
      }

      // [PHANTOM-EXPLODE] Un fantasma non esploso NON cambia l'esito dell'ordine — il job su
      // Plex esiste e la sua distinta e' quella che si e' potuta costruire — ma il run deve
      // andare in ATTENZIONE, altrimenti una distinta incompleta passerebbe con un recap verde.
      // Passa da `scope()` e non da `record()` perche' non e' un oggetto trattato: l'ordine ha
      // gia' la sua riga (RB della 0014, DEC-39).
      if (summary && order._phantomStats && order._phantomStats.unresolved > 0) {
        summary.scope({
          plant: order.ProductionPlant,
          objectType: 'PHANTOM_EXPLODE',
          status: 'W',
          segments: [logMsg.seg(
            'logOrderPhantomUnresolved', order.ManufacturingOrder, order._phantomStats.unresolved
          )]
        });
      }

      // [COMP-EXCL] Due dichiarazioni distinte, e la differenza conta.
      //
      // I componenti ESCLUSI dal customizing sono l'esito voluto: si dicono e non degradano,
      // perche' un perimetro configurato e rispettato non e' un'attenzione (`degrade: false`).
      // Un criterio NON VALUTABILE e' l'opposto: il perimetro applicato e' piu' LARGO di quello
      // configurato, cioe' a Plex e' arrivato qualcosa che il cliente voleva fuori, e senza
      // l'attenzione sarebbe indistinguibile da un perimetro configurato cosi'.
      //
      // Entrambe da `scope()` e non da `record()`: non sono oggetti trattati, l'ordine ha gia' la
      // sua riga (DEC-39).
      if (summary && order._compExclStats && order._compExclStats.excluded > 0) {
        summary.scope({
          plant: order.ProductionPlant,
          objectType: 'COMP_EXCL',
          status: 'S',
          degrade: false,
          segments: [
            logMsg.seg('logOrderHead', order.ManufacturingOrder),
            logMsg.verbatim(orderCompExclRules.describe(order._compExclStats))
          ]
        });
      }
      // [ORDER-COMP-REMOVE] I componenti che una persona ha rimosso dall'albero: esito VOLUTO,
      // quindi `degrade: false` come gli esclusi dal customizing. Si dichiara lo stesso, e per una
      // ragione in più rispetto a quelli: là il perimetro sta in una tabella di customizing che si
      // può riaprire, qui la decisione è di una persona su un ordine solo, e il recap è il posto in
      // cui resta scritto che quel componente su Plex è stato disattivato per volontà, non per
      // errore. Da `scope()` e non da `record()`: l'ordine ha già la sua riga (DEC-39).
      if (summary && order._compRemovalStats && order._compRemovalStats.removed > 0) {
        summary.scope({
          plant: order.ProductionPlant,
          objectType: 'COMP_REMOVED',
          objectKey: order.ManufacturingOrder,
          status: 'S',
          degrade: false,
          segments: [
            logMsg.seg('logOrderHead', order.ManufacturingOrder),
            logMsg.verbatim(orderCompRemovalRules.describe(order._compRemovalStats)),
            logMsg.seg('logOrderCompRemovedTail')
          ]
        });
      }
      // [ORDER-BOM-ADD] Cosa e' finito nella distinta del lotto, e cosa no. Due righe distinte, e
      // la differenza e' la stessa dei componenti esclusi.
      //
      // Le righe AGGIUNTE sono l'esito voluto e non degradano (`degrade: false`): un ODP con un
      // componente extra e' normale. Si dichiarano lo stesso, perche' un componente che il ciclo
      // standard non prevede e' un'informazione che in fabbrica serve, e perche' e' l'unico posto
      // in cui si vede che la feature ha lavorato.
      //
      // I FALLIMENTI degradano, e non serve `degrade: false` per evitare il doppio conteggio:
      // l'ordine ha gia' la sua riga `record({status:'E'})`, quindi il run e' gia' rosso. Questa
      // riga serve a NOMINARE i materiali, che nel messaggio dell'ordine ci stanno solo in parte
      // (`Message` e' String(255)).
      if (summary && order._bomAddStats && order._bomAddStats.created > 0) {
        summary.scope({
          plant: order.ProductionPlant,
          objectType: 'ORDER_BOM_ADD',
          objectKey: order.ManufacturingOrder,
          status: 'S',
          degrade: false,
          segments: [logMsg.seg(
            'logOrderBomAdded', order.ManufacturingOrder, order._bomAddStats.created, order.Material
          )]
        });
      }
      if (summary && order._bomAddStats && order._bomAddStats.failures.length > 0) {
        const s = order._bomAddStats;
        const detail = s.failures
          .map((f) => `${f.material} (${orderBomAddRules.failureText(f)})`).join('; ');
        // Due esiti diversi, e vanno distinti: se non e' stato creato NIENTE il job non esiste
        // (prevolo fallito); se qualcosa e' stato creato o pianificato il job C'E' con la distinta
        // incompleta, e il prossimo run ci riprova. Chi legge il recap deve sapere quale dei due.
        // Due esiti diversi = due CHIAVI diverse, non una frase scelta con un `?:`: sono due
        // notizie opposte per chi legge, e in un'altra lingua non si compongono allo stesso modo.
        const esitoSeg = logMsg.seg(
          s.planned > 0 && s.created === 0 && s.failures.some(
            (f) => f.code === orderBomAddRules.FAILURE.POST_REJECTED
              || f.code === orderBomAddRules.FAILURE.NO_JOB_OP
          ) ? 'logOrderBomIncomplete' : 'logOrderBomNoJob',
          order.ManufacturingOrder
        );
        summary.scope({
          plant: order.ProductionPlant,
          objectType: 'ORDER_BOM_ADD',
          objectKey: order.ManufacturingOrder,
          status: 'W',
          segments: [esitoSeg, logMsg.verbatim(detail)]
        });
      }

      if (summary && order._compExclStats && order._compExclStats.unevaluable.length > 0) {
        const materials = [...new Set(order._compExclStats.unevaluable.map((u) => u.material))];
        summary.scope({
          plant: order.ProductionPlant,
          objectType: 'COMP_EXCL',
          status: 'W',
          segments: [logMsg.seg(
            'logOrderCompExclUnevaluable', order.ManufacturingOrder, materials.length
          )]
        });
      }

      if (outcome.status === 'S') {
        sent++;
        console.log(`>>> [OK] ${outcome.message}`);
      } else if (outcome.status === 'W') {
        warned++;
        console.warn(`>>> [WARN] ${outcome.message}`);
      } else {
        failed++;
        console.error(`>>> [ERRORE] ${outcome.message}`);
      }
    } catch (error) {
      failed++;
      console.error(`>>> [ERRORE] Ordine ${order.ManufacturingOrder}: ${error.message}`);
      // [ORDER-SORT-ON-WRITE] Se l'eccezione e' arrivata dopo una scrittura, `processOrder` ha gia'
      // chiesto l'ordinamento e ne ha appeso l'esito all'errore: si conta e si mette nello storico.
      addSortStat(sortStats, order.ProductionPlant, error && error.sort);
      let counter = null;
      try {
        counter = await writeMappingAndLog(db, order, {
          status: 'E',
          // [LOG-MSG-I18N] Un'eccezione e' testo di terzi: `technical` la mostra senza tradurla, e
          // `writeMappingAndLog` deriva da qui sia il testo che il JSON — una sorgente sola.
          segments: [logMsg.technical(error.message)],
          steps: [
            { step: 'exception', request: null, status: 0, response: error.message },
            ...((error && Array.isArray(error.sortSteps)) ? error.sortSteps : [])
          ],
          plex: {}
        });
      } catch (logErr) {
        console.error(`>>> [ERRORE] Log fallito per ${order.ManufacturingOrder}: ${logErr.message}`);
      }
      if (summary) {
        summary.record({
          plant: order.ProductionPlant,
          objectType: 'PROD_ORDER',
          objectKey: order.ManufacturingOrder,
          objectKey2: order.Material,
          status: 'E',
          segments: [logMsg.technical(error.message)],
          logRef: counter ? `ZProdOrderExcLogPOS/${order.ManufacturingOrder}/${counter}` : null
        });
      }
    }
  }

  // [ORDER-QTY-SYNC] Feature 0033 — gli ordini che il ciclo qui sopra ha SALTATO perche' gia'
  // inviati (e quelli spacchettati) passano ora dal controllo di quantita'.
  // [ORDER-SORT-ON-WRITE] Stessa configurazione memoizzata e stessi contatori del ciclo principale:
  // la fase gira PRIMA del recap qui sotto, quindi la riga per plant conta anche i riallineamenti.
  const qtyStats = await runQuantityCheck({
    db, summary, connFor,
    orders: [...delta.alreadySentRows, ...delta.splitSkipped.map((s) => s.order)],
    sortConfigFor,
    sortStats,
    sortTimeoutMs: SORT_BATCH_TIMEOUT_MS
  });

  // Feature 0014 / FR-32 — UNA voce per plant, non una per ordine: con la cadenza per ordine una
  // riga di attenzione per ordine produrrebbe una notifica mail ricorrente e un recap illeggibile
  // (rischio R-03 del BR). Passa da scope() e non da record() perche' record() alimenta i
  // contatori degli ordini e, con status 'E', l'exit code del job (TDD §5.6).
  if (summary) {
    for (const entry of sortRecapEntries(sortStats)) {
      summary.scope({
        plant: entry.plant,
        objectType: 'PROD_ORDER_SORT',
        objectKey: 'JOB_SORT',
        status: entry.status,          // 'S' informativa | 'W' attenzione
        degrade: entry.degrade,        // true SOLO se almeno una richiesta e' fallita
        // M-06 | M-07 | M-08. `sortRecapEntries` compone ancora prosa (plexJobSortRules.js ha
        // MESSAGE_KEYS per i motivi, non per il recap): lacuna dichiarata.
        segments: [logMsg.verbatim(entry.message)]
      });
      console.log(`>>> [JOB SORT] recap ${entry.plant}: ${entry.message}`);
    }
  }

  console.log(
    `>>> [JOB CreatePlexOrders] completato — creati: ${sent}, warning: ${warned}, falliti: ${failed} (su ${todo.length})`
    + `; quantita controllate: ${qtyStats.checked}, aggiornate: ${qtyStats.updated}, fallite: ${qtyStats.failed}`
  );
  // [ORDER-QTY-SYNC] I fallimenti del controllo quantita' entrano nell'EXIT CODE. Una quantita' che
  // non si e' potuta riallineare e' una divergenza fra SAP e la fabbrica, ed e' cosi' che il run
  // chiude in errore e la mail parte ai destinatari.
  return { failed: failed + qtyStats.failed };
}

// Funzioni riutilizzabili anche fuori dal batch (es. action CAP createJobInPlex
// in srv/cat-service.js, che crea il job per un singolo ordine "manuale", e lo
// spacchettamento in srv/lib/plexJobSplit.js, che riusa loadOrderDetails +
// alignJobOperationsAndBom sul codice del pacchetto).
module.exports = {
  processOrder,
  writeMappingAndLog,
  loadOrderDetails,
  alignJobOperationsAndBom,
  loadOrdersInScope,
  filterNotYetSent,
  // [ORDER-QTY-SYNC] Esportata per il test: la fase gira su una lista di ordini e una connessione
  // iniettate, quindi si collauda senza database ne' rete.
  runQuantityCheck,
  // [ORDER-QTY-SYNC] La conversione delle date SAP verso Plex serve anche all'action del cockpit,
  // che dal ramo dell'ordine spacchettato chiama `syncOrderQuantity` direttamente. Esportare quella
  // che c'e' gia' e' l'alternativa a una seconda copia che diverge sul formato.
  toIso,
  run
};

// Bootstrap condiviso (srv/jobs/lib/runJob.js): carica e linka il modello, crea il riepilogo di
// esecuzione, garantisce che venga chiuso e che il recap parta anche in caso di errore fatale,
// e calcola l'exit code (non-zero = fallimenti, per il Job Scheduler).
// Eseguito SOLO quando il file è lanciato direttamente (`node srv/jobs/createPlexProductionOrders.js`);
// quando importato (require) da un altro modulo NON si auto-esegue.
if (require.main === module) {
  const { runJob } = require('./lib/runJob');
  // serveAll non serve: questo job non invoca action di servizi locali, scrive solo sul db.
  runJob({ jobCode: 'PROD_ORDER', serveAll: false, main: (summary) => run(summary) });
}

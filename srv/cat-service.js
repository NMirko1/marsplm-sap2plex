const cds = require('@sap/cds');
// [LOG-MSG-I18N] I testi localizzati e la forma strutturata dei messaggi di log (feature 0029).
// `fs` e `path` non servono piu' qui: leggere i bundle e' compito di i18nMessages, che sta in
// srv/lib/ perche' serve anche ai cinque job — questo file e' una closure e non esporta niente.
const i18nMessages = require('./lib/i18nMessages');
// `logMsg` e non `logMessage`: in questo file esistono variabili locali di quel nome, e un
// import ombreggiato non da' errore — da' un `TypeError` dentro il ramo sbagliato.
const logMsg = require('./lib/logMessage');
// [UNIQUE-VIOLATION] Un vincolo `@assert.unique` violato, riconosciuto e reso leggibile. Serve
// perche' `@assert.unique` genera un indice e NON un handler, e perche' i controlli applicativi in
// `before` non possono vedere due righe dello stesso change set: CAP ne lancia le sottorichieste in
// parallelo. L'unico che vede sempre la verita' e' il database.
const { describeViolation } = require('./lib/uniqueConstraintError');
// [MAT-SAP-FIELDS] MAT_SAP_FIELDS: i campi SAP che fetchMaterialSapFields popola, dichiarati per
// sorgente accanto al motore che li consuma. E' il legame col seed di ZMatFieldVH (RB-20).
const { buildPlexPartPayload, LOCKED_FIELDS, MAT_SAP_FIELDS } = require('./lib/plexPartMapper');
// [PART-QUERY] Gli indirizzi del Parts API in un punto solo: letture su v2, scritture ancora su v1
// (la' `type` e `status` sono obbligatori). Test: node test/plexPartQuery.test.js
const plexPartsApi = require('./lib/plexPartsApi');
const {
  buildPartOperationPayload,
  resolveOpType,
  DEFAULT_OP_TYPE: OP_TYPE_FALLBACK,
  OP_SAP_FIELDS,
  LOCKED_FIELDS: OP_LOCKED_FIELDS,
  // [PLEX-OP-TYPE] `type`: non e' identita' come partId/operationId, ma il suo valore vero lo
  // dichiara il catalogo Plex, quindi non e' configurabile (feature 0024, DEC-84).
  DERIVED_FIELDS: OP_DERIVED_FIELDS
} = require('./lib/plexOpFieldMapper');
const {
  // [MAT-SCOPE] `loadCategoryConfig` (la sola mappa) NON ESISTE PIU': da qui si decidono
  // perimetri, e per farlo serve sapere se la lettura del customizing e' riuscita — una mappa
  // vuota e' indistinguibile da «nessun plant ha categorie», cioe' dal ramo che invia tutto
  // senza `type`. Convertiti i suoi due chiamanti non restava nessuno: il perche' non sia stata
  // lasciata «per comodita'» sta sulla funzione, in materialVisibility.js.
  loadCategoryConfigOutcome,  // [MAT-SCOPE] la mappa PIU' il verdetto della lettura
  loadPlantCategoriesOutcome, // [MAT-SCOPE] idem, per il percorso d'invio
  loadTypeMappedPlants,       // [MAT-SCOPE] i plant che mappano `type` a mano (0004 RB-17)
  loadPartTypeIndex,
  mergeProductFields,   // [POST-GET-CLASSIFY]
  needsProductDetails,  // [POST-GET-CLASSIFY]
  loadPartTypeCodeIndex,
  loadPartStatusConfig,
  invalidatePlexPartCodeCache,
  classifyMaterial,
  extractSapFields,
  needsNav,
  fieldsUsedBy
  // [PLANT-ROWS] `productPlantColumns` non serve piu' qui: la scelta delle colonne della riga
  // di stabilimento e' passata al lettore condiviso (srv/lib/plantRows.js) insieme alla query.
} = require('./lib/materialVisibility');
// [W1-26] I campi PORTANTI da cui, sul canale Integration Suite, escono SOBSL e FEVOR.
const { IS_FIELD_ALIASES } = require('./lib/isQueryShape');
// [MAT-SCOPE] Il verdetto DEFINITIVO sul perimetro di un materiale, preso DOPO il join fra la riga
// product-plant e l'anagrafica (feature 0050). Puro, con il suo test: test/matScopeRules.test.js.
const matScope = require('./lib/matScopeRules');
// [AUTO-ASSIGN] Auto-assegnazione dei componenti alle operazioni Plex: stava dentro questa
// closure fino alla 0025, quando il job PROD_ORDER ha avuto bisogno della stessa risposta e la
// closure gliela negava. Punto unico, due processi.
const { resolveAutoAssignments } = require('./lib/autoAssign');
// [PLANT-ROWS] [PLANT-PAGE] Il perimetro materiali di un plant: lettura paginata, cache e
// dichiarazione di cio' che manca (0035). Era scritto due volte — qui nello STEP 2 e in
// autoAssign.js — e le due copie divergevano gia'.
const {
  loadPlantRowsIndex, loadPlantRowsOutcome, invalidatePlantRows, lastPlantReadVerdict,
  PLANT_ROWS_TTL_MS
} = require('./lib/plantRows');
// [PRODUCT-QUERY] Il verdetto della SECONDA lettura del plant — l'anagrafica `A_Product`, feature
// 0040. `productScope` dichiara la SOMMA delle due: entrambe, se incomplete, accorciano la lista.
const { lastProductReadVerdict } = require('./lib/productRows');
// [ORDER-BOM-ADD] I componenti extra dell'ordine nella distinta del suo job (0025): serve allo
// spacchettamento, che di job ne crea uno per pacchetto e nessuno di essi eredita nulla.
const orderBomAdd = require('./lib/orderBomAdd');
// [DETAILS-PREFETCH] Cache di processo dei dettagli materiale: single-flight per materiale, TTL.
// Serve al precaricamento integrale della dashboard e NON e' usata dai flussi che scrivono su
// Plex, che devono leggere l'anagrafica fresca. Test: test/productDetailCache.test.js.
const createProductDetailCache = require('./lib/productDetailCache');
// [W1-02] La classe che MARS distingue non e' la tipologia che Plex conosce (DEC-62).
const { plexValueOf, isKnownClass, flag: matFlag } = require('./lib/materialClass');
// [PLEX-PART-CODES] E la tipologia che Plex conosce non e' il CODICE con cui Plex la identifica
// (feature 0022, DEC-65). Terzo e ultimo anello della stessa catena.
const {
  typeCodeOf,
  emitCode,
  isValidPlexCode,
  missingTypeCodes
} = require('./lib/plexPartCodes');
// [W1-03] Operazione di RICEVIMENTO sulla part dei materiali che Plex non produce (BBP §7.3.4).
// Passo accessorio dell'invio materiale: non lancia mai e non altera l'esito della part.
const {
  runReceivingOpStep,
  clearRecvOpMapping,
  invalidateRecvOpConfigCache
} = require('./lib/recvOpStep');
const recvOpRules = require('./lib/recvOpRules');
const { getUsablePlants, isPlantLicensed, invalidateLicense, getUserRole, getUserPlantRole, invalidateApiKeys } = require('./license');
// [PLANT-ACCESS] Il perimetro plant di CHI sta chiedendo (feature 0048): l'hub che compone i plant
// attivi, quelli licenziati e il ruolo dell'utente su ognuno. Le regole pure sono accanto, in
// srv/lib/plantAccessRules.js.
const plantAccess = require('./lib/plantAccess');
const plantAccessRules = require('./lib/plantAccessRules');
// [PLEX-CONN] Connessione a Plex, per plant (feature 0020). Punto UNICO di risoluzione, condiviso
// con i job batch: ha sostituito la coppia di gemelle loadPlexCredentials (qui) /
// resolvePlexCredentials (srv/jobs/lib/plexJobsClient.js). Perimetro: grep -rn "PLEX-CONN".
const {
  resolvePlexConnection,
  invalidatePlexConnection,
  PlexConnectionMissing,
  PlexConnectionPlantMissing
} = require('./lib/plexConnection');
// [PLEX-CONN] Regole PURE della connessione (forma degli indirizzi, campi obbligatori,
// normalizzazione): nessuna dipendenza da cds/db/rete, test in test/plexConnRules.test.js.
const plexConnRules = require('./lib/plexConnRules');
// [PLEX-CONN] Identificativi delle Data Source: elenco unico, parametri di RILASCIO (non
// customizing, non per plant). Qui servono alla sonda del test di connessione e a
// uploadPartAttribute.
const plexDataSources = require('./lib/plexDataSources');
// `Job_No` della sonda del canale Data Source: deliberatamente un valore che non corrisponde a
// nessun job. Il test deve dimostrare l'AUTENTICAZIONE, non l'esistenza di un dato: la risposta
// attesa e' un 200 con zero righe.
const PLEX_CONN_PROBE_JOB_NO = '__MARSPLM_CONNECTION_PROBE__';
// ================================================================
// [IS-SOURCE] Sorgenti dati SAP per area (feature 0013). Sostituiscono i
// cds.connect.to diretti: scelgono il canale attivo (Integration Suite per default,
// gateway on-premise col pin di area) e instradano ogni lettura sul proprio service
// root. Il lotto 1 marcato [IS-ROUTING-LIST] (sola LISTA cicli) è assorbito da
// routingSource: grep -rn "IS-ROUTING-LIST\|IS-SOURCE" dà il perimetro completo.
// ================================================================
const routingSource = require('./lib/routingSource');
// [ROUTING-HEADER-FLIGHT] Una cache a TTL che mette in volo UNA sola lettura per chiave: le sei
// richieste che l'apertura di un ciclo lancia insieme facevano sei letture identiche della testata.
const createSingleFlightCache = require('./lib/singleFlight');
const productSource = require('./lib/productSource');
const prodOrderSource = require('./lib/prodOrderSource');
const {
  operationsFilter, componentsFilter, reservationOf,
  keepOperationsOfOrder, keepComponentsOfOrder,
  // [ORDER-CYCLE-SEED] testata dell'ordine con ripiego di forma: chiave -> collection col plant
  readOrderHeader
} = prodOrderSource;
// [ORDER-ROWS] LA lettura del perimetro ordini, condivisa con il job `PROD_ORDER`: colonne, tetto e
// ORDINE di costruzione della query vivono là, in un punto solo. Questo file è una closure e i job
// non ci arrivano: è la stessa ragione per cui il tetto sta in prodOrderSource, e il costo di averla
// ignorata è che le due letture hanno potuto divergere per due giorni senza dichiararlo.
const orderRows = require('./lib/orderRows');
// [PRODUCT-QUERY] `fetchProductsForPlants` legge il perimetro anagrafico di un plant in UNA query
// (feature 0040) e ha sostituito qui `fetchProductsByKey`, che resta la lettura di
// srv/lib/orderCompExcl.js. `invalidatePlantReads` e' cio' che rende «Aggiorna» un tasto onesto:
// le letture di un plant sono ora DUE, e chi preme non deve saperlo.
const { fetchProductsForPlants, invalidatePlantReads, PRODUCT_SELECT, UNAVAILABLE_IN_IS } = productSource;
const isQueryShape = require('./lib/isQueryShape');
// [IS-CALL-LOG] Anello in memoria delle letture verso SAP, servito dalla function isCallLog e
// letto dalla console del browser. Da rimuovere a migrazione conclusa: grep -rn "IS-CALL-LOG".
const isCallLog = require('./lib/isCallLog');
// [SPLIT-TRACE] Tracciato delle chiamate Plex dello spacchettamento — corpo inviato e corpo
// ricevuto, in `cf logs` e nella console del browser (alimenta lo stesso anello di isCallLog).
// Spegnimento: PLEX_CALL_TRACE=off. Perimetro: grep -rn "SPLIT-TRACE".
const plexCallTrace = require('./lib/plexCallTrace');
// [MATDOC-POST] Registrazione movimento merci verso l'iFlow IS. Perimetro: grep -rn "MATDOC-POST".
// `MATDOC_MOCK` sono i dati di prova: si importano per nome perché `postMaterialDoc` non ha più un
// default (W1-20) — chi vuole i finti li chiede, e non li ottiene per dimenticanza.
const { postMaterialDoc, MOCK: MATDOC_MOCK } = require('./lib/materialDocPost');
// [ORDER-STATUS-POST] Sonda: chiusura ordine (CloseOrder) e chiusura tecnica (TechlyCmpltOrder)
// verso i due iFlow IS delle righe N.20/N.21 del foglio, mai chiamati da nessuno, su un ordine
// INESISTENTE. Perimetro: grep -rn "ORDER-STATUS-POST".
const { postProdOrderStatus } = require('./lib/prodOrderStatusPost');
// [IS-SOURCE] Le due sorgenti dell'area classificazione, per la lettura d'esercizio qui sotto.
const { clfnProductSource, clfnCharcSource } = require('./lib/clfnSource');
// [IS-SOURCE] La lettura di classificazione dell'auto-assegnazione (feature 0018): sceglie il
// canale — `$expand` a due livelli su ONPREM, catena di letture dirette su IS — e restituisce
// l'indice che `matchCond` confronta. Test delle regole: node test/clfnRules.test.js
const clfnRead = require('./lib/clfnRead');
// [IS-SOURCE] Sorgente dell'area distinta base, usata da una lettura
// d'esercizio: [ROUTING-BY-MATERIAL] risolve materiale+plant -> distinta su `MaterialBOM` per
// attribuire al materiale le assegnazioni componenti del ciclo (vedi READ RoutingComponentAllocations).
const bomSource = require('./lib/bomSource');
// [ROUTING-BY-MATERIAL] Regole pure della lista cicli per materiale: chiave di join tollerante,
// join con spina MAPL e unione, attribuzione dei componenti alla distinta.
// Test: node test/routingMaterialRules.test.js
const routingMaterialRules = require('./lib/routingMaterialRules');
// [ROUTING-FILTER] Visibilita' dei cicli per stato e utilizzo (feature 0016), customizing per
// plant. Gemello di materialVisibility.js. Test: node test/routingVisibility.test.js
const routingVisibility = require('./lib/routingVisibility');
// [LAST-LOG-WORST-DAY] Quale riga di storico riassume un oggetto nelle tre liste del cruscotto
// (feature 0049): la PEGGIORE del GIORNO PIU' RECENTE, non l'ultima scritta. `lastLog` e' la
// lettura — una sola, con tre descrittori — e `lastLogRules` il verdetto puro.
// Test: node test/lastLogRules.test.js
const lastLog = require('./lib/lastLog');
// [MAT-PLANT-PAIR] Il materiale e' un oggetto per (materiale, plant), feature 0039: chiave della
// coppia — UNA definizione sola, era composta a mano in tre punti di questo file — rifiuto del
// plant vuoto e delta. Test: node test/matPlantRules.test.js
const matPlantRules = require('./lib/matPlantRules');
// [PART-DUPLICATE] Quale part occupa il numero che Plex ha appena rifiutato: `POST /mdm/v1/parts`
// consegna quell'id dentro il proprio `400`, ed e' tutto cio' che serve per riagganciare invece di
// fermarsi. La decisione sta qui perche' i POST di part in questo file sono DUE e divergevano.
// Test: node test/plexDuplicateRules.test.js e node test/plexPartCreateRecovery.test.js
const plexDuplicateRules = require('./lib/plexDuplicateRules');
// [KEY-READ] Il criterio EFFETTIVO di una lettura in ingresso (feature 0041): in una lettura per
// CHIAVE il predicato sta in `SELECT.from.ref[<ultimo>].where` e `SELECT.where` e' undefined.
// Ogni handler `on('READ')` di questo file legge il criterio da qui, e mai piu' dal solo
// `SELECT.where`. Test: node test/keyReadRules.test.js e node test/keyReadGuarded.test.js
const keyReadRules = require('./lib/keyReadRules');
// [ORDER-CYCLE-IMPORT] Regole pure dell'import del ciclo del materiale sull'ordine: selezione del
// modello, collegamento come arricchimento, verifica contro Plex e motivo di un import vuoto.
// Test: node test/orderCycleImportRules.test.js
const orderCycleImport = require('./lib/orderCycleImportRules');
// [ORDER-CYCLE-SEED] Orchestrazione del travaso ciclo del materiale -> ciclo dell'ordine, condivisa
// col job PROD_ORDER: scelta del modello per materiale+plant, copia completa (operazioni,
// componenti, work center) e scrittura al primo sguardo. Perimetro: grep -rn "ORDER-CYCLE-SEED".
const orderCycleSeed = require('./lib/orderCycleSeed');
// [ORDER-STATUS-FILTER] Perimetro degli ordini per stato (feature 0017), customizing per plant.
// Gemello ROVESCIATO di routingVisibility.js: la' non configurato = nessun filtro, qui non
// configurato = nessun ordine. Test: node test/prodOrderStatusFilter.test.js
const prodOrderStatusFilter = require('./lib/prodOrderStatusFilter');
// [ORDER-TECO] Chiusura tecnica riportata su Plex (feature 0023, W1-13), customizing per plant.
// Qui serve solo la VALIDAZIONE del customizing: il flusso vive nel job closeTecoPlexJobs.js.
// Test: node test/prodOrderTeco.test.js
const prodOrderTeco = require('./lib/prodOrderTeco');
// [ORDER-COMPLETE] Il job Plex completato -> stato utente sull'ordine SAP (feature 0045, W1-12),
// customizing per plant. Qui serve solo la VALIDAZIONE: il flusso vive nel job
// completeSapOrdersFromPlex.js. Test: node test/prodOrderComplete.test.js
const prodOrderComplete = require('./lib/prodOrderComplete');
// [ORDER-SCHEDULED] Il gemello della precedente sull'altro estremo del ciclo (feature 0046, W1-11).
// Anche qui serve solo la VALIDAZIONE del customizing: il flusso vive nel job
// scheduleSapOrdersFromPlex.js. Test: node test/orderStatusFlow.test.js
const prodOrderScheduled = require('./lib/prodOrderScheduled');
// [PHANTOM-EXPLODE] Esplosione ricorsiva dei componenti fantasma (feature 0019), customizing per
// plant. Le regole verificabili a secco stanno in ./lib/bomExplodeRules.js, con il loro test:
// node test/bomExplodeRules.test.js
const bomExplode = require('./lib/bomExplode');
// [W1-05] Le stesse regole pure servono ora anche fuori dall'esplosione: quantita' e unita' reali
// dei componenti diretti del ciclo vengono dalla distinta, con la stessa chiave di join.
const bomExplodeRules = require('./lib/bomExplodeRules');
// [ROUTING-COMP-SOURCE] La sorgente componenti del ciclo (feature 0025): fusione delle due
// letture SAP, precedenza della collocazione manuale sulla regola, e il verdetto di blocco che
// impedisce di mandare a Plex un ciclo con anche un solo componente senza operazione. Regole
// pure, nessuna dipendenza: node test/routingCompSourceRules.test.js
const routingCompRules = require('./lib/routingCompSourceRules');
// [COMP-SOURCE] Il vocabolario della provenienza, condiviso dai DUE alberi (feature 0036): la
// normalizzazione che tiene in vita il marcatore attraverso il delete+insert del salvataggio, e i
// bersagli manuali che l'invio rispetta. Regole pure: node test/compSourceRules.test.js
const compSource = require('./lib/compSourceRules');
// [ROUTING-BOM-DRIFT] Il confronto fra il ciclo SAP e la distinta su Plex (feature 0047): il
// verdetto «si invia / non si invia» e le sue tre guardie. Regole pure, e il criterio per riga e'
// quello dell'invio (`plexBomRules.decideBomAction`): node test/routingBomDriftRules.test.js
const bomDrift = require('./lib/routingBomDriftRules');
// [COMP-ORPHAN] `orderComponentKeys`: la STESSA chiave con cui il passo 7.2 decide se un componente
// e' dell'ordine. Una seconda definizione farebbe potare qui una riga che l'invio tiene (0037).
const orderBomAddRules = require('./lib/orderBomAddRules');
// [COMP-EXCL] Esclusione configurabile dei componenti dell'ordine, per plant (field mapping
// Ariston, foglio `5. Orders or Jobs` cella `H18`). Regole pure e collaudabili in
// ./lib/orderCompExclRules.js: node test/orderCompExclRules.test.js
const orderCompExcl = require('./lib/orderCompExcl');
const orderCompExclRules = require('./lib/orderCompExclRules');
// [ORDER-COMP-REMOVE] Rimozione manuale di un componente dall'albero dell'ordine (feature 0026).
const orderCompRemoval = require('./lib/orderCompRemoval');
const orderCompRemovalRules = require('./lib/orderCompRemovalRules');
// [W1-08] Un work center su una sola operazione del ciclo di una part (BBP §7.6.2). Regole pure,
// nessuna dipendenza: node test/approvedWcRules.test.js
const approvedWcRules = require('./lib/approvedWcRules');
// [TEMPLATE-GROUP] Un gruppo oggetti su una sola operazione del template, e le righe da scrivere.
// Modulo a parte e non un parametro di approvedWcRules: la' la chiave di confronto e' maiuscola
// (GUID di Plex), qui e' stretta (codici nostri, dove piegare il caso fonderebbe due gruppi
// diversi). Regole pure: node test/templateGroupRules.test.js
const templateGroupRules = require('./lib/templateGroupRules');
// [BOM-AUTODEPLETE] W1-06: «Autodeplete = false» esplicito sulle righe BOM (BBP §4.2.4/§7.5.2), la
// forma dei due body e la decisione fra creare / aggiornare / saltare. Regole pure, nessuna
// dipendenza: node test/plexBomRules.test.js. Il contratto della BOM API di Plex, da cui vengono i
// nomi dei campi e i verbi, e' in srv/external/PLEX_BOM_API_CONTRACT.md.
const bomRules = require('./lib/plexBomRules');
// [PLEX-OP-SORT] L'elenco delle operazioni Plex arriva nell'ordine che decide Plex, e compare in
// quattro schermate che leggono tutte `getPlexOperations`: si ordina qui, in un punto solo, per
// l'etichetta che l'utente legge. Regole pure, nessuna dipendenza: node test/plexOpSort.test.js
const { sortPlexOperations } = require('./lib/plexOpSort');
// [PLEX-OP-TYPE-FILTER] Quali TIPI di operazione servono a un ambito, per plant: regole pure
// (node test/plexOpTypeFilter.test.js). E il catalogo operazioni del tenant, unico punto che legge
// `GET /mdm/v1/operations` — da cui viene anche il `type` che il progetto non decide piu'.
const opTypeFilter = require('./lib/plexOpTypeFilter');
const opCatalog = require('./lib/plexOperationCatalog');

/**
 * [IS-FULL-KEY] Una lettura che NON si può eseguire si dichiara, non si tenta (DEC-42).
 *
 * Sui due service root `_GET` dei figli dell'ordine la forma collection non è esposta: senza la
 * chiave interna che deve arrivare dalla testata, la richiesta è persa in partenza. Invece di
 * mandarla e incassare un `500 GET_FEED is not configured` a ogni apertura del dettaglio, si
 * scrive una voce nella traccia leggibile dal BROWSER — dove il collaudatore guarda — e si
 * risponde con una lista vuota. Il `cf logs` la porta comunque.
 */
function declareSkippedRead(source, { entity, op = 'GET', criteria, columns, reason }) {
  console.warn(`>>> [IS-SOURCE] ${source.area}/${entity} ${op}: lettura NON eseguita — ${reason}`);
  isCallLog.push({
    area: source.area,
    entity,
    op,
    derivedOp: op,
    mode: source.mode,
    // [IS-CHANNEL] Il canale su cui la lettura SAREBBE uscita: la sorgente lo espone già.
    destination: source.destination || '',
    root: (source.paths || {})[`${entity}.${op}`] || '',
    form: 'non eseguita',
    calls: 0,
    rows: 0,
    ms: 0,
    outcome: 'KO',
    criteria: criteria || '',
    columns: columns || '',
    error: reason,
    notes: [reason]
  });
}

// ================================================================
// ACTIVE PLANTS - authoritative from ZPlant (Status='Active').
// MODULE-SCOPED (shared across all service instances) so that invalidating the
// cache after a ZPlant change in CatalogService is seen by the Product /
// ProductionOrder / ProductionRouting services too. Only these plants are
// considered when reading materials/routings/orders and creating jobs in Plex.
// ================================================================
let activePlantsCache = null;
let activePlantsCacheTimestamp = null;
const ACTIVE_PLANTS_TTL_MS = 60 * 1000; // 1 minute

/** Returns the Set of plant codes with Status='Active' from ZPlant (cached, DB-only). */
async function getActiveStatusPlants() {
  const now = Date.now();
  if (activePlantsCache && activePlantsCacheTimestamp &&
      (now - activePlantsCacheTimestamp < ACTIVE_PLANTS_TTL_MS)) {
    return activePlantsCache;
  }
  const db = await cds.connect.to('db');
  const { ZPlant } = db.entities('avvaleplm.marsplm.sap2plex');
  const rows = await db.run(SELECT.from(ZPlant).columns('PlantCode').where({ Status: 'Active' }));
  activePlantsCache = new Set(rows.map(r => r.PlantCode));
  activePlantsCacheTimestamp = now;
  console.log(`>>> Active plants (status): ${[...activePlantsCache].join(', ') || '(none)'}`);
  return activePlantsCache;
}

/**
 * I plant LICENZIATI: `Status='Active'` AND coperti da licenza (vedi srv/license.js).
 *
 * NON E' PIU' IL PERIMETRO DI UNA RICHIESTA, dalla 0048: e' l'insieme che non dipende da chi
 * chiede. Lo usano il gate di attivazione di un plant e i punti che non hanno un utente; ogni
 * lettura che espone dati di un plant passa da `getUserPlants(req)` qui sotto.
 *
 * Il nome vecchio (`getActivePlants`) E' STATO RITIRATO di proposito: un call site non convertito
 * darebbe un `ReferenceError`, cioe' un guasto rumoroso, invece di continuare a servire tutti i
 * plant a chiunque — che e' un guasto muto. La licenza sta in cache (positivo 24 h, negativo live,
 * grace 96 h), quindi questa resta economica anche se chiamata per richiesta.
 */
async function getLicensedPlants() {
  return await getUsablePlants(await getActiveStatusPlants());
}

/**
 * [PLANT-ACCESS] Il perimetro di CHI STA CHIEDENDO, con il verdetto di ogni plant (feature 0048).
 *
 * E' il choke-point (CP0): le liste, il selettore, i log e i gate di scrittura derivano il loro
 * insieme da qui, quindi un plant su cui l'utente non ha un ruolo e' escluso in ogni punto mentre
 * gli altri continuano a funzionare.
 *
 * RENDE LA BUSTA INTERA e non solo l'insieme, perche' un perimetro che si svuota deve dichiarare
 * PERCHE' (DEC-52): `byPlant` porta il verdetto anche dei plant esclusi, e le cause hanno rimedi
 * diversi — plant non attivo, non licenziato, nessun ruolo, oppure non si e' potuto sapere.
 *
 * FUORI DA UNA RICHIESTA E' FAIL-CLOSED, e non serve un `if` per ottenerlo: senza `req`
 * `plantAccess.identify` rende un'identita' vuota e l'hub risponde insieme vuoto, dichiarandolo nel
 * log. Prima della 0048 lo stesso caso rendeva l'insieme INTERO. Dentro un run batch invece
 * l'utente non si valuta affatto (il marcatore di processo vince): e' cio' che tiene interi i due
 * job che eseguono questi handler nel proprio processo.
 */
async function resolveUserScope(req) {
  const active = await getActiveStatusPlants();
  const licensed = await getUsablePlants(active);
  return await plantAccess.resolveUserPlants(active, licensed, plantAccess.identify(req));
}

/** [PLANT-ACCESS] I soli plant che questa richiesta puo' vedere. Vedi `resolveUserScope`. */
async function getUserPlants(req) {
  return (await resolveUserScope(req)).plants;
}

/**
 * [PLANT-ACCESS] Questo plant e' utilizzabile da chi sta chiedendo? Attivo AND licenziato AND con
 * un ruolo per l'utente corrente.
 *
 * Le tre condizioni si valutano nell'ordine dalla piu' locale alla piu' remota, cosi' un plant
 * disattivato non costa una chiamata di rete. E si chiede il ruolo di UN plant, non del perimetro
 * intero: qui il chiamante ha gia' un plant in mano, e risolverli tutti sarebbe N chiamate per
 * sapere di una.
 */
async function plantVerdict(req, plantCode) {
  const A = plantAccessRules.ACCESS;
  if (!plantCode) return A.NOT_ACTIVE;
  if (!(await getActiveStatusPlants()).has(plantCode)) return A.NOT_ACTIVE;
  if (!(await isPlantLicensed(plantCode))) return A.NOT_LICENSED;
  const one = [plantCode];
  const out = await plantAccess.resolveUserPlants(one, new Set(one), plantAccess.identify(req));
  const v = out.byPlant.get(plantCode);
  return (v && v.verdict) || A.UNKNOWN;
}

/** [PLANT-ACCESS] Il verdetto ridotto a un sì/no, per chi non deve spiegare niente. */
async function isPlantUsable(req, plantCode) {
  return plantAccessRules.accessGranted(await plantVerdict(req, plantCode));
}

/**
 * [PLANT-ACCESS] L'utente ha un RUOLO su questo plant? Senza `Active`, senza licenza (feature 0048).
 *
 * PERCHE' UNA SOGLIA PIU' LARGA DI `plantVerdict`, e non e' una svista. Un plant nasce
 * `InProgress` e la sua configurazione si apre PRIMA dell'attivazione: le tendine del catalogo
 * Plex, che una persona usa proprio mentre configura, con la terna sarebbero vuote su ogni plant
 * nuovo — e una tendina vuota si legge come «questa operazione non esiste» (DEC-81). La forma
 * esisteva gia': `testPlexConnection` e' gatata sul solo ruolo.
 *
 * E LA SOGLIA E' «QUALSIASI RUOLO», non `admin`. `rejectIfNotFullAdmin` pretende esattamente
 * 'admin' e scarta 'admin-config': usarlo qui svuoterebbe le tendine a un `admin-config`, che nella
 * configurazione plant e' un utente legittimo.
 *
 * NON TOCCA `req`: rende un verdetto. Chi deve comporre una busta (`getPlexOperations` ha `readOk`
 * e `message`, e i suoi client ASSORBONO l'errore HTTP in «HTTP 403») lo usa cosi'; chi puo'
 * rifiutare usa `rejectIfNoPlantRole` qui sotto.
 *
 * @returns {Promise<{ok: boolean, key: ?string}>} `key` = la chiave i18n del rifiuto, `null` se ok
 */
async function plantRoleVerdict(req, plantCode) {
  if (!plantCode) return { ok: false, key: 'plantCodeMandatory' };
  const who = plantAccess.identify(req);
  // Un run batch non ha un utente da valutare: e' la stessa decisione del perimetro (0048).
  if (who.kind === plantAccessRules.KIND.BATCH) return { ok: true, key: null };
  const { role, known } = await getUserPlantRole(who.email, plantCode);
  if (plantAccessRules.enablesDashboard(role)) return { ok: true, key: null };
  // «Non si e' potuto sapere» non e' «non hai un ruolo»: il primo si riprova, il secondo si chiede.
  return { ok: false, key: known ? 'plantNoRole' : 'plantRoleUnknown' };
}

function invalidateActivePlantsCache() {
  console.log('>>> Invalidating active plants cache');
  activePlantsCache = null;
  activePlantsCacheTimestamp = null;
}

// ================================================================
// [ROUTING-SCOPE] TESTATA DEL CICLO, IN CACHE (feature 0016).
//
// Il perimetro dei cicli si valuta su tre campi della testata — Plant, stato e utilizzo — e va
// valutato in OGNI punto d'ingresso, non solo nella lista. Senza cache aprire un dettaglio
// costerebbe CINQUE letture SAP in piu': il dettaglio fa cinque richieste (operazioni, componenti,
// e le tre del ciclo salvato), e sul canale IS ognuna sono secondi.
//
// Si mette in cache la SOLA TESTATA, non il verdetto: le regole sono una lettura locale, si
// rivalutano ogni volta, e cosi' una modifica del customizing ha effetto subito senza che nessuno
// debba ricordarsi di invalidare qualcosa. Module-scoped e con TTL breve, sul modello di
// activePlantsCache qui sopra.
//
// Il TTL e' anche il limite dichiarato della freschezza: se in SAP lo stato di un ciclo cambia, il
// perimetro se ne accorge entro il TTL. Per stato e utilizzo di una lista di operazioni e' una
// granularita' abbondante.
// ================================================================
const ROUTING_HEADER_TTL_MS = Number(process.env.ROUTING_HEADER_TTL_MS || 60 * 1000);
// [ROUTING-HEADER-FLIGHT] 'gruppo|contatore' -> la testata. Single-flight: vedi srv/lib/singleFlight.js.
const routingHeaderCache = createSingleFlightCache({ ttlMs: ROUTING_HEADER_TTL_MS });

/**
 * La testata di un ciclo, con i campi che il perimetro guarda.
 *
 * [ROUTING-HEADER-FLIGHT] SI METTE IN CACHE LA PROMESSA, NON IL RISULTATO — stampo di
 * `srv/lib/productDetailCache.js`. Con la Map popolata DOPO l'`await`, N richieste concorrenti sulla
 * stessa chiave facevano tutte miss e partivano tutte: aprendo il dettaglio di un ciclo il browser
 * ne lancia sei insieme (`_loadTreeData` e `_loadPlexCycleData`, tre `Promise.all` ciascuna), e
 * ognuna passa da `checkRoutingInScope`. Misurate il 14/09/2026 su `cf logs`: SEI letture identiche
 * di `ProductionRoutingHeader` per `07NPE079/01` in 244 ms, ~950 ms l'una, tutte verso lo stesso
 * iFlow. La cache c'era dal primo giorno e non poteva vederle, perche' il TTL protegge dalle
 * richieste SUCCESSIVE, non da quelle SIMULTANEE.
 *
 * Non cambia ne' il TTL ne' cosa si mette in cache (la sola testata, non il verdetto: vedi sopra).
 *
 * UN ESITO FALLITO NON RESTA IN CACHE: sulla caduta la voce si toglie, o un guasto di rete di un
 * istante resterebbe appiccicato al ciclo per un minuto — e il `@throws` qui sotto smetterebbe di
 * essere vero per i chiamanti che arrivano dopo.
 *
 * @returns {Promise<object|null>} `null` = SAP non ha restituito la testata (ciclo inesistente).
 * @throws se la lettura verso SAP fallisce: chi chiama deve poter distinguere «non esiste» da
 *         «non l'ho potuto sapere», e i due casi hanno esiti diversi.
 */
function readRoutingHeader(group, routing) {
  const key = `${String(group ?? '').trim()}|${String(routing ?? '').trim()}`;
  return routingHeaderCache.get(key, async () => {
    const s4r = await routingSource(); // [IS-SOURCE]
    const { ProductionRoutingHeader } = s4r.entities;
    const hdr = await s4r.run(
      SELECT.one.from(ProductionRoutingHeader)
        .columns('ProductionRoutingGroup', 'ProductionRouting', 'Plant',
          'BillOfOperationsStatus', 'BillOfOperationsUsage')
        .where({ ProductionRoutingGroup: group, ProductionRouting: routing })
    );
    return hdr || null;
  });
}

/**
 * Optional per-request plant selection from the custom query option `?plants=1710,1010`
 * (set by the dashboard plant selector). Returns an array of codes, or null if absent.
 */
function readSelectedPlants(req) {
  const q = (req && ((req._ && req._.req && req._.req.query) || (req.req && req.req.query))) || {};
  const raw = q.plants;
  if (!raw) return null;
  const arr = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return arr.length ? arr : null;
}

/**
 * [PLANT-ROWS] Il tasto «Aggiorna» ha chiesto una lettura NUOVA?
 *
 * Viaggia come opzione di query, accanto a `plants`, e per la stessa ragione: non e' un filtro
 * di vista, cambia cosa il server va a leggere. Senza, con la cache del perimetro da cinque
 * minuti quel tasto ridisegnerebbe la stessa lista senza dirlo.
 */
function wantsFreshRead(req) {
  const q = (req && ((req._ && req._.req && req._.req.query) || (req.req && req.req.query))) || {};
  const raw = String(q.refresh == null ? '' : q.refresh).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'x';
}

/**
 * I plant che una lettura deve considerare: il PERIMETRO DELL'UTENTE, eventualmente ristretto alla
 * sua selezione (l'opzione di query `plants` del selettore in dashboard).
 *
 * Nessuna selezione => tutto il perimetro. La selezione e' sempre intersecata col perimetro, quindi
 * puo' solo RESTRINGERE: un plant scelto ma fuori perimetro viene ignorato.
 *
 * [PLANT-ACCESS] Dalla 0048 l'insieme di partenza e' quello dell'utente e non solo quello
 * licenziato. Il fail-closed fuori da una richiesta viene da `resolveUserScope` — nessun `if` qui:
 * senza `req` l'hub rende insieme vuoto, dove prima rendeva tutti i plant attivi.
 */
async function resolveEffectivePlants(req) {
  const scope = await getUserPlants(req);
  const sel = readSelectedPlants(req);
  if (!sel) return scope;
  return new Set([...scope].filter(code => sel.includes(code)));
}

/**
 * Tolerant extraction of a free-text search from a CQN `where` produced by a
 * SearchField (an OR of contains(field,'term')). Walks the where tree collecting
 * every referenced field name and every string literal (stripping SQL '%' wildcards),
 * so callers can match a row if ANY field contains ANY term. Returns { fields, terms }.
 */
function extractContainsSearch(where) {
  const fields = new Set();
  const terms = new Set();
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.ref && node.ref.length) fields.add(node.ref[node.ref.length - 1]);
    if (typeof node.val === 'string') {
      const t = node.val.replace(/^%+|%+$/g, '').trim().toLowerCase();
      if (t) terms.add(t);
    }
    if (node.args) walk(node.args);
    if (node.xpr) walk(node.xpr);
    if (node.list) walk(node.list);
  };
  walk(where);
  return { fields: [...fields], terms: [...terms] };
}

// ================================================================
// PLEX PART FIELD MAPPING - runtime resolution for sendProductToPlex.
// Fetches the material's SAP fields and builds the Plex part payload from the
// per-plant customizing (ZPlexFieldMap). Falls back to { number, name }.
// ================================================================

/**
 * Read the SAP material fields needed by the mapping/rules for (product, plant),
 * keyed by the ZMatFieldVH FieldName values.
 *
 * [IS-SOURCE] (feature 0013, TDD §3.6.5 V1) — this used to swallow the error and return
 * {}, so buildPlexPartRequestBody proceeded with the { number, name } fallback and sent
 * Plex a payload built on an UNVERIFIED absence. It now tells the two cases apart:
 *   ok: false     -> the read did not succeed. The caller must NOT send to Plex (FR-21).
 *   unavailable[] -> the information does not exist on the active channel (SOBSL/FEVOR in
 *                    IS mode): it does NOT block the send, it is declared in the log (FR-22).
 *
 * @returns {Promise<{fields: object, ok: boolean, failures: string[], unavailable: string[]}>}
 */
async function fetchMaterialSapFields(product, plant) {
  const sap = {};
  const failures = [];
  const unavailable = [];
  // [MAT-SCOPE] L'ANAGRAFICA E' STATA OTTENUTA? Non e' deducibile dai campi (feature 0050).
  //
  // Sotto, `if (prod)` significa che una risposta VUOTA non e' un fallimento: `ok` resta `true`,
  // `failures` resta vuoto e `ProductType` resta `undefined`. Da fuori quel `undefined` e'
  // indistinguibile da un MTART davvero vuoto, e i due hanno rimedi OPPOSTI — «configura la
  // tipologia della categoria» contro «guarda perche' l'anagrafica non arriva». Senza questo
  // flag il verdetto di perimetro direbbe `NO_PART_TYPE` mentre la verita' e' `DETAIL_UNKNOWN`,
  // cioe' manderebbe a correggere il customizing per un guasto di lettura.
  let productFound = false;
  const S4 = await productSource();
  const { A_Product, A_ProductPlant } = S4.entities;
  const isMode = S4.mode === 'IS';

  try {
    const prod = await S4.run(
      SELECT.one.from(A_Product)
        .columns('Product', ...MAT_SAP_FIELDS.fromProduct)
        .where({ Product: product })
    );
    if (prod) {
      productFound = true;
      for (const f of MAT_SAP_FIELDS.fromProduct) sap[f] = prod[f];
    }
  } catch (e) {
    failures.push(`A_Product(${product}): ${e.message}`);
    console.warn(`>>> [MAPPING] SAP material fetch failed for ${product}: ${e.message}`);
  }

  if (plant) {
    try {
      // In IS: $select esplicito, nessun $expand (su questo canale le due navigazioni non hanno
      // indirizzo). [W1-26] SOBSL e FEVOR arrivano dai due campi PORTANTI di IS_FIELD_ALIASES,
      // che qui vanno CHIESTI esplicitamente.
      // In ONPREM: la query di oggi, expand compresi (TD-5). La proiezione e' ESPLICITA anche qui
      // — non e' il `*` di productPlantColumns — quindi un campo nuovo va aggiunto a ENTRAMBI i
      // rami. Non si uniformano (DEC-34): cio' che li tiene allineati e' MAT_SAP_FIELDS.
      //
      // [MAT-SAP-FIELDS] Questa SELECT non passa da productPlantColumns e non eredita
      // PRODUCT_PLANT_SELECT: i campi piatti li dichiara MAT_SAP_FIELDS.fromProductPlant, che e'
      // lo stesso elenco legato al seed di ZMatFieldVH da test/matSapFields.test.js. Prima era
      // scritto a mano e fermo a ProcurementType, ed e' per questo che MRPType, ProfitCenter e
      // PurchasingGroup erano configurabili nella dropdown e non arrivavano mai a Plex (RB-20).
      const q = isMode
        ? SELECT.one.from(A_ProductPlant)
          .columns('Product', 'Plant', ...MAT_SAP_FIELDS.fromProductPlant, ...Object.values(IS_FIELD_ALIASES))
          .where({ Product: product, Plant: plant })
        : SELECT.one.from(A_ProductPlant)
          .columns(p => {
            // La callback di proiezione di cds.ql costruisce le colonne per EFFETTO COLLATERALE
            // dell'accesso alla proprieta': `p['MRPType']` equivale a `p.MRPType`. Resta la forma
            // callback — e non un array CQN — perche' su questo canale gli `$expand` che seguono
            // sono quelli che decidono il perimetro materiali di un cliente non migrato (DEC-34).
            p.Product, p.Plant;
            for (const f of MAT_SAP_FIELDS.fromProductPlant) p[f]; // eslint-disable-line no-unused-expressions
            p.to_ProductSupplyPlanning(sp => { sp.ProcurementSubType }),
            p.to_ProductWorkScheduling(ws => { ws.ProductionSupervisor })
          })
          .where({ Product: product, Plant: plant });
      const pp = await S4.run(q);
      if (pp) {
        for (const f of MAT_SAP_FIELDS.fromProductPlant) sap[f] = pp[f];
        // [W1-26] Le due informazioni si valorizzano su ENTRAMBI i canali, ciascuno dalla sua
        // sorgente. Questo percorso alimenta il motore di mapping campi Plex e la classe del
        // materiale in invio: se restasse fermo al ramo ONPREM, la stessa regola darebbe esiti
        // diversi fra la lista del cockpit e la part creata su Plex.
        if (isMode) {
          sap.ProcurementSubType = pp[IS_FIELD_ALIASES.ProcurementSubType];
          sap.ProductionSupervisor = pp[IS_FIELD_ALIASES.ProductionSupervisor];
        } else {
          const spArr = pp.to_ProductSupplyPlanning;
          const sp = Array.isArray(spArr) ? spArr[0] : spArr;
          sap.ProcurementSubType = sp && sp.ProcurementSubType;
          const wsArr = pp.to_ProductWorkScheduling;
          const ws = Array.isArray(wsArr) ? wsArr[0] : wsArr;
          sap.ProductionSupervisor = ws && ws.ProductionSupervisor;
        }
      }
    } catch (e) {
      failures.push(`A_ProductPlant(${product}/${plant}): ${e.message}`);
      console.warn(`>>> [MAPPING] SAP material fetch failed for ${product}/${plant}: ${e.message}`);
    }
  }

  // Cio' che il canale IS non fornisce: dichiarato, non surrogato (FR-17/FR-22).
  // [W1-26] L'elenco e' vuoto, quindi qui non si aggiunge piu' nulla; il ramo resta perche' e'
  // il modo in cui una lacuna futura torna a comparire nel log di scambio.
  if (isMode) unavailable.push(...UNAVAILABLE_IN_IS);

  return { fields: sap, ok: failures.length === 0, failures, unavailable, productFound };
}

/**
 * Build the Plex part payload for a material from the per-plant field mapping.
 * Returns { number, name } (previous behaviour) when no mapping exists for the plant
 * or on any error.
 *
 * [IS-SOURCE] (feature 0013, FR-21/FR-22) — returns an envelope instead of the bare
 * payload: `ok: false` means the SAP read did not succeed and the caller must not send
 * anything to Plex; `unavailable` lists the information the active channel does not
 * provide, which is declared in the exchange log but does NOT block the send.
 *
 * [PLEX-PART-CODES] (feature 0022) — l'envelope porta anche `partStatus` e `typeCodeMissing`.
 * Lo stato NON entra nel payload qui: viaggia solo in creazione, e chi crea o aggiorna lo decide
 * sendProductToPlex piu' avanti (vedi createBody la').
 *
 * @returns {Promise<{payload: object, ok: boolean, failures: string[], unavailable: string[],
 *                    plexPartType: string|null, baseUnit: string|null,
 *                    partStatus: {code: string, label: string}|null, typeCodeMissing: string|null}>}
 */
async function buildPlexPartRequestBody({ Product, ProductDescription, Plant, db }) {
  const fallback = { number: Product, name: ProductDescription };
  if (!Plant) {
    return {
      payload: fallback, ok: true, failures: [], unavailable: [],
      plexPartType: null, baseUnit: null, partStatus: null, typeCodeMissing: null
    };
  }
  let read = { fields: {}, ok: true, failures: [], unavailable: [] };
  // [W1-03] La CLASSE risolta e l'unita' di misura escono dall'envelope insieme al payload.
  // Sono gia' entrambe qui — la prima la calcola la classificazione per il `type`, la seconda la
  // legge fetchMaterialSapFields — e il passo dell'operazione di ricevimento le vuole: farle
  // ricalcolare al chiamante significherebbe rileggere SAP e le categorie una seconda volta.
  let plexPartType = null;
  // [PLEX-PART-CODES] Lo stato configurato per il plant e la tipologia rimasta senza codice
  // escono dall'envelope per la stessa ragione: chi le vuole sta a valle — i due rami POST di
  // sendProductToPlex il primo, il log e il recap la seconda — e ricalcolarle costerebbe una
  // seconda lettura del customizing.
  let partStatus = null;
  let typeCodeMissing = null;
  // [MAT-SCOPE] Il verdetto di perimetro (feature 0050). Resta `null` se non si e' potuto
  // calcolare — un'eccezione INATTESA nel blocco delle categorie — e `null` NON blocca l'invio:
  // il file dichiara da sempre di non voler introdurre nuovi modi di far fallire l'invio di un
  // materiale, e un difetto nel nostro codice non e' un motivo per fermare un plant intero. I casi
  // che la feature governa non passano da li': `loadPlantCategoriesOutcome` NON lancia, e rende il
  // verdetto della lettura.
  let scopeVerdict = null;
  try {
    read = await fetchMaterialSapFields(Product, Plant);
    const sapFields = read.fields;
    sapFields.ProductDescription = ProductDescription;

    const { ZPlexFieldMap } = db.entities('avvaleplm.marsplm.sap2plex');
    const rows = await db.run(
      SELECT.from(ZPlexFieldMap).where({ Plant }).columns(m => {
        m.PlexField, m.MappingKind, m.FixedValue, m.SapField,
        m.Rules(r => {
          r.Sequence, r.OutputValue,
          r.Conditions(c => { c.SapField, c.Operator, c.Value })
        })
      })
    );

    const payload = (rows && rows.length)
      ? buildPlexPartPayload({ product: Product, productDescription: ProductDescription, sapFields, mapRows: rows })
      : { ...fallback };

    // Per-plant material category classification -> Plex part type ("Plex value").
    // Only fills `type` when the field mapping above didn't already set it (explicit
    // mapping wins). No category configured / no match => leaves the payload untouched.
    //
    // [W1-02] E' l'UNICO punto di traduzione classe -> tipologia Plex. L'altra sorgente di
    // `payload.type` e' il mapping esplicito di ZPlexFieldMap, che vince e non passa di qui:
    // chi mappa `type` a mano sta gia' scrivendo un valore Plex (0004 RB-17).
    //
    // Il try/catch che segue inghiotte e prosegue, ed e' voluto anche per la traduzione: se la
    // value help non si legge, loadPartTypeIndex rende un indice vuoto e plexValueOf rende la
    // classe verbatim — cioe' il comportamento che c'era prima della W1-02. Nessun nuovo modo
    // di far fallire l'invio materiale.
    try {
      const { categories, ok: categoriesKnown } = await loadPlantCategoriesOutcome(Plant, db);
      if (categories.length) {
        // [W1-03] La classe risolta sale alla variabile esterna e viene restituita: e' il
        // criterio con cui si decide se il materiale vuole l'operazione di ricevimento. La
        // CLASSE, non il valore Plex tradotto: `type` puo' essere gia' stato scritto dal
        // mapping esplicito, e su 'Semifinished External' i due valori nemmeno coincidono.
        plexPartType = classifyMaterial(sapFields, categories).plexPartType || null;
        if (plexPartType && (payload.type === undefined || payload.type === null || payload.type === '')) {
          // Si assegna solo un valore VERO: una classe fatta di soli spazi — che la validazione
          // tratta come vuota — tradurrebbe a `null`, e `type: null` nel corpo JSON e' peggio
          // del campo assente. Assente significa «non lo dico», ed e' gia' cio' che succede
          // quando il plant non ha categorie.
          const plexType = plexValueOf(await loadPartTypeIndex(db), plexPartType);
          if (plexType) payload.type = plexType;
        }
      }
      // ================================================================
      // [MAT-SCOPE] IL VERDETTO DI PERIMETRO, ED E' QUI CHE E' ESATTO (feature 0050).
      //
      // Il blocco qui sopra prendeva da `classifyMaterial` il solo `plexPartType` e buttava
      // `visible`: un materiale che nessuna categoria aggancia usciva con `plexPartType: null`,
      // il corpo partiva SENZA `type` e Plex rispondeva `HTTP 400`. Ora l'envelope porta il
      // verdetto, e chi scrive si ferma.
      //
      // `typeAvailable` guarda `payload.type` — non la classe — ed e' la differenza fra un gate
      // giusto e una regressione secca: `type` e' mappabile a mano su `ZPlexFieldMap` (0004
      // RB-17, `LOCKED_FIELDS` esclude solo number/name/description), quindi un plant puo'
      // fornire la tipologia senza che nessuna categoria porti una classe. Il controllo va su
      // cio' che Plex ricevera' davvero. Si legge DOPO i due blocchi qui sopra, perche' prima di
      // loro `payload.type` non e' ancora quello definitivo.
      //
      // `detailKnown` e' `read.productFound` e non «ProductType e' valorizzato»: un MTART
      // davvero vuoto e un'anagrafica non letta sono due cose con rimedi opposti.
      // ================================================================
      scopeVerdict = matScope.finalScope({
        sapFields,
        detailKnown: read.productFound === true,
        categories,
        categoriesKnown,
        typeAvailable: !!String(payload.type ?? '').trim()
      });
    } catch (eCat) {
      console.warn(`>>> [MAPPING] category part-type skipped for ${Product}/${Plant} (${eCat.message})`);
    }

    // [PLEX-PART-CODES] Terzo anello: la tipologia diventa il CODICE del tenant Plex (DEC-65).
    //
    // Gira su `payload.type` qualunque sia la sua provenienza — categoria (blocco qui sopra) o
    // mapping esplicito di ZPlexFieldMap — e questo NON viola DEC-62 conseguenza 3: la traduzione
    // resta in un punto solo, e' solo l'ultimo passo dello stesso punto. Anzi chiude la
    // scorciatoia: prima chi mappava `type` a mano scriveva un valore Plex che nessuno
    // controllava, e con i codici avrebbe scritto un nome che Plex non riconosce (0004 RB-17).
    //
    // Anche questo blocco ha il suo try/catch che inghiotte e prosegue: nessun codice trovato,
    // customizing illeggibile o eccezione ⇒ `payload.type` resta la STRINGA, cioe' il
    // comportamento che il progetto aveva prima della 0022. Non si introduce un nuovo modo di
    // far fallire l'invio di un materiale.
    //
    // `typeCodeMissing` porta a valle la tipologia rimasta scoperta: la lacuna si DICHIARA nel
    // log e nel recap, perche' «nessun codice» e «codice giusto» sono indistinguibili
    // guardando l'esito — in entrambi i casi la part esce.
    try {
      const currentType = payload.type;
      if (currentType !== undefined && currentType !== null && String(currentType).trim() !== '') {
        const codeIndex = await loadPartTypeCodeIndex(Plant, db);
        const code = typeCodeOf(codeIndex, currentType);
        if (code) {
          const emitted = emitCode(code);
          if (emitted !== null) payload.type = emitted;
        } else if (!isValidPlexCode(currentType)) {
          // Un `type` che e' GIA' un codice non e' una lacuna: e' un mapping esplicito che ha
          // scritto direttamente la chiave, e la traduzione su di esso e' un no-op.
          typeCodeMissing = String(currentType).trim();
        }
      }
      partStatus = await loadPartStatusConfig(Plant, db);
    } catch (eCode) {
      console.warn(`>>> [PLEX-PART-CODES] code translation skipped for ${Product}/${Plant} (${eCode.message})`);
    }

    return {
      payload, ok: read.ok, failures: read.failures, unavailable: read.unavailable,
      plexPartType, baseUnit: sapFields.BaseUnit || null,
      partStatus, typeCodeMissing,
      scopeVerdict   // [MAT-SCOPE]
    };
  } catch (e) {
    console.warn(`>>> [MAPPING] fallback to {number,name} for ${Product}/${Plant} (${e.message})`);
    return {
      payload: fallback,
      ok: read.ok,
      failures: read.failures,
      unavailable: read.unavailable,
      // La classificazione non e' arrivata in fondo: nessuna classe, quindi il passo del
      // ricevimento non parte. Non si tira a indovinare su un materiale che non si e' letto.
      plexPartType: null,
      baseUnit: (read.fields && read.fields.BaseUnit) || null,
      // [PLEX-PART-CODES] Idem per lo stato: il payload qui e' il ripiego { number, name }, che
      // non ha una tipologia da tradurre, e uno stato di nascita su una part che non si e'
      // riusciti a costruire non lo si manda.
      partStatus: null,
      typeCodeMissing: null,
      // [MAT-SCOPE] Nessun verdetto: `read.ok === false` fermera' comunque l'invio (FR-21), e su
      // un `ok: true` con il ripiego `{number, name}` non si e' in grado di dire nulla sul
      // perimetro. `null` non blocca — vedi la dichiarazione della variabile.
      scopeVerdict: null
    };
  }
}

/**
 * [W1-03] Serializza il JSON di log dell'invio materiale aggiungendo, se c'e' qualcosa da
 * dire, la traccia del passo dell'operazione di ricevimento.
 *
 * ZMatExcLogPOS.RequestJson/ResponseJson sono `String(4000)` e contengono UNO scambio per
 * tentativo, non un array di step come il flusso ordini: la traccia del passo accessorio e'
 * quindi una CHIAVE ADDITIVA dentro lo stesso oggetto, accanto a `notes` (IS-SOURCE).
 * Additiva = nessun consumatore esistente del log si rompe.
 *
 * Se la nota non ci sta nel limite di colonna, si OMETTE: meglio perdere l'accessorio che
 * troncare il JSON principale, che e' cio' che il cockpit apre nei due CodeEditor.
 *
 * Non entrano mai `NOT_REQUIRED` e `NO_CONFIG`: nel primo caso il materiale e' fuori dal
 * perimetro della feature, nel secondo la sua unita' di misura non ha una riga di ricevimento —
 * e nessuno dei due e' qualcosa che manchi alla part. Per entrambi la riga di log deve restare
 * identica a quella di prima della feature, JSON compreso.
 *
 * @param {object} baseJson  httpExchange.requestJson o .responseJson
 * @param {object} recvOp    esito di runReceivingOpStep
 * @param {'request'|'response'} kind
 * @returns {string}
 */
const LOG_JSON_MAX_CHARS = 4000;
function withReceivingNote(baseJson, recvOp, kind) {
  const plain = JSON.stringify(baseJson);
  const SILENT = [recvOpRules.RECV_STATE.NOT_REQUIRED, recvOpRules.RECV_STATE.NO_CONFIG];
  if (!recvOp || SILENT.includes(recvOp.state)) return plain;
  try {
    const ex = recvOp.exchange || {};
    // [W1-03] `probe` e `recheck` sono la traccia delle DUE letture di
    // `GET /mdm/v1/part-operations` — quella prima del POST e quella dopo un rifiuto — e ci sono
    // anche quando NON hanno trovato niente. Prima la lettura compariva solo nel ramo che
    // riusciva: dopo tre rifiuti identici del POST non si sapeva ne' se fosse partita ne' cosa
    // avesse risposto, e «ho guardato e non c'era» era indistinguibile da «non ho potuto
    // guardare». Il messaggio ha il tetto piu' alto di ERROR_MAX_CHARS perche' a 200 caratteri
    // il codice di errore specifico di Plex non ci stava (recvOpRules.plexValidationText).
    const full = kind === 'request'
      ? { state: recvOp.state, method: ex.method || null, body: ex.body || null }
      : {
        state: recvOp.state,
        status: ex.status === undefined ? null : ex.status,
        partOperationId: recvOp.partOperationId || null,
        message: recvOpRules.truncate(recvOp.message, recvOpRules.ERROR_MAX_CHARS),
        probe: ex.probe || null,
        recheck: ex.recheck || null
      };
    // Forma ridotta, tentata prima di rinunciare del tutto: la colonna e' String(4000) e il
    // payload della part la riempie gia' parecchio. Meglio l'esito senza la traccia che una
    // riga di log identica a quella di prima della feature.
    const compact = kind === 'request'
      ? { state: recvOp.state, method: full.method }
      : { state: full.state, status: full.status, message: recvOpRules.truncate(recvOp.message) };

    for (const note of [full, compact]) {
      const enriched = JSON.stringify({ ...baseJson, receivingOperation: note });
      if (enriched.length <= LOG_JSON_MAX_CHARS) return enriched;
    }
    return plain;
  } catch (e) {
    console.warn(`>>> [W1-03] traccia del ricevimento non serializzata: ${e.message}`);
    return plain;
  }
}

// ================================================================
// PLEX PART-OPERATION FIELD MAPPING - runtime resolution for syncRoutingPlexCycle.
// Loads the per-plant customizing and the SAP context (material + routing operation) so the
// part-operation payload fields can be filled dynamically. All best-effort: on error the caller
// falls back to its existing defaults.
// ================================================================

/**
 * Load the per-plant part-operation field mapping rows (deep: Rules -> Conditions).
 *
 * [PLEX-OP-TYPE] Restituisce `{ rows, readOk, plant }` e non piu' il solo array, perche' le tre
 * risposte «plant assente», «lettura fallita» e «nessuna riga» erano indistinguibili — tutte e tre
 * un `[]` — e portano a conseguenze diverse: la prima e' un difetto a monte, la seconda un guasto,
 * la terza un customizing da fare. E' lo stesso principio di DEC-58: una lettura fallita che torna
 * vuoto e' peggio di un errore, perche' fa credere che non ci fosse niente.
 */
async function loadOpFieldMapRows(plant, db) {
  if (!plant) {
    console.warn('>>> [OP-MAPPING] nessun plant: il mapping campi operazione non viene nemmeno letto');
    return { rows: [], readOk: false, plant: null };
  }
  try {
    const { ZPlexOpFieldMap } = db.entities('avvaleplm.marsplm.sap2plex');
    const rows = await db.run(
      // [PLEX-OP-TYPE] `Plant: plant`, non la scorciatoia `{ Plant }`: quella e' `{ Plant: Plant }`
      // e `Plant` maiuscolo NON esiste in questo scope — la lettura lanciava `ReferenceError` a
      // ogni chiamata, il catch qui sotto la inghiottiva e il chiamante riceveva «nessuna riga».
      // Il mapping campi operazione non ha quindi mai agganciato, per nessun campo e nessun plant,
      // e non si vedeva perche' il ripiego di ogni campo e' un valore plausibile.
      SELECT.from(ZPlexOpFieldMap).where({ Plant: plant }).columns(m => {
        m.PlexField, m.MappingKind, m.FixedValue, m.SapField,
        m.Rules(r => {
          r.Sequence, r.OutputValue,
          r.Conditions(c => { c.SapField, c.Operator, c.Value })
        })
      })
    );
    return { rows: rows || [], readOk: true, plant };
  } catch (e) {
    console.warn(`>>> [OP-MAPPING] load field map failed for plant ${plant}: ${e.message}`);
    return { rows: [], readOk: false, plant };
  }
}

/**
 * [PLEX-OP-TYPE-FILTER] Le righe del filtro per tipo operazione di un plant (feature 0024).
 *
 * Lettura FALLITA => elenco vuoto, cioe' NESSUN filtro. E' il fail-open dichiarato di DEC-53: qui
 * il customizing governa solo cio' che si vede in una tendina, e mostrare qualche operazione in
 * piu' e' un fastidio che si vede, mentre non mostrarne nessuna e' una sparizione silenziosa. Il
 * chiamante lo dichiara comunque, perche' `readOk: false` viaggia con l'esito.
 */
async function loadOpTypeFilterRows(plant, db) {
  if (!plant) return { rows: [], readOk: false };
  try {
    const { ZPlexOpTypeFilter } = db.entities('avvaleplm.marsplm.sap2plex');
    // `Plant: plant` e non la scorciatoia `{ Plant }`: quella e' `{ Plant: Plant }` e `Plant`
    // maiuscolo non esiste in questo scope — e' l'errore che ha reso inerte per mesi il mapping
    // campi operazione (vedi loadOpFieldMapRows).
    const rows = await db.run(SELECT.from(ZPlexOpTypeFilter).where({ Plant: plant })) || [];
    return { rows, readOk: true };
  } catch (e) {
    console.warn(`>>> [PLEX-OP-TYPE-FILTER] lettura del filtro tipi del plant ${plant} fallita: ${e.message}`);
    return { rows: [], readOk: false };
  }
}

/** Fetch material-level SAP fields (weights, type/group) for the op-mapping context. */
async function fetchProductOpFields(product) {
  const ctx = {};
  try {
    const S4 = await productSource(); // [IS-SOURCE]
    const { A_Product } = S4.entities;
    // [OP-SAP-FIELDS] `$select` e contesto derivano dalla STESSA lista: qui i nomi sono 1:1 con
    // le colonne di A_Product, quindi tenerne due copie a mano era solo un modo di farle divergere
    // — che e' esattamente come nacque RB-20 sul lato materiali (DEC-64).
    const prod = await S4.run(
      SELECT.one.from(A_Product)
        .columns('Product', ...OP_SAP_FIELDS.fromProduct)
        .where({ Product: product })
    );
    if (prod) {
      for (const f of OP_SAP_FIELDS.fromProduct) ctx[f] = prod[f];
    }
  } catch (e) {
    console.warn(`>>> [OP-MAPPING] product fetch failed for ${product}: ${e.message}`);
  }
  return ctx;
}

/**
 * Fetch routing-operation SAP fields for all operations of a routing, keyed by
 * ProductionRoutingOpIntID. Best-effort (returns {} on error).
 */
async function fetchRoutingOpFields(S4Routing, ProductionRoutingGroup, ProductionRouting) {
  const byOpIntId = {};
  try {
    const { ProductionRoutingOperation } = S4Routing.entities;
    const ops = await S4Routing.run(
      SELECT.from(ProductionRoutingOperation)
        .columns('ProductionRoutingOpIntID', 'Operation', 'WorkCenterInternalID',
                 'OperationControlProfile', 'OperationReferenceQuantity', 'StandardWorkQuantity1')
        .where({ ProductionRoutingGroup, ProductionRouting })
    );
    for (const op of (ops || [])) {
      byOpIntId[op.ProductionRoutingOpIntID] = {
        OperationNumber: op.Operation,
        WorkCenter: op.WorkCenterInternalID,
        OperationType: op.OperationControlProfile,
        OperationReferenceQuantity: op.OperationReferenceQuantity,
        StandardWorkQuantity: op.StandardWorkQuantity1 != null ? op.StandardWorkQuantity1 : op.OperationReferenceQuantity
      };
    }
  } catch (e) {
    console.warn(`>>> [OP-MAPPING] routing op fetch failed for ${ProductionRoutingGroup}/${ProductionRouting}: ${e.message}`);
  }
  return byOpIntId;
}

// La cache di processo dei nomi di caratteristica (ATNAM -> ATINN) è passata in
// srv/lib/clfnRead.js insieme alla lettura: la usano entrambi i canali, e lì le sta accanto la
// gemella CLINT -> nome della classe.

// ================================================================
// [MAT-SCOPE] Com'è andata la POTATURA del perimetro materiali, per plant (feature 0050).
//
// STA FUORI DALLA CLOSURE, e non è una sfumatura. `cds.service.impl` gira UNA VOLTA PER SERVIZIO:
// chi scrive il verdetto (`loadConfiguredProducts`, chiamata dalla READ di `Product` e dall'invio
// massivo di `PlexService`) e chi lo legge (`productScope`, in `Product`) vivono quindi in closure
// diverse. Dichiarato là dentro, il verdetto scritto dall'invio massivo non sarebbe mai leggibile —
// e nessun errore lo direbbe: la striscia mostrerebbe semplicemente meno di quel che sa.
//
// È la stessa forma di `lastPlantReadVerdict` in srv/lib/plantRows.js: non si RILEGGE niente per
// rispondere a `productScope`, si rende il verdetto che il processo ha conservato. Rileggere
// costerebbe un secondo giro lento esattamente dove il primo non ce l'ha fatta.
//
// «MAI POTATO» NON È «NIENTE DA DICHIARARE»: un plant assente dalla mappa esce `Known: false`, come
// per i due lettori. Un'informazione che non abbiamo non è una rassicurazione.
// ================================================================
const _matScopeVerdicts = new Map(); // plant -> { tally, untypedCategories, at }

function rememberScopeVerdict(plant, tally, untypedCategories) {
  if (!plant) return;
  _matScopeVerdicts.set(plant, { tally, untypedCategories, at: Date.now() });
}

/** Il verdetto conservato per un plant, o `null` se questo processo non l'ha mai valutato. */
function lastScopeVerdict(plant) {
  return _matScopeVerdicts.get(plant) || null;
}

module.exports = cds.service.impl(async function() {

  // ================================================================
  // I18N HELPER FUNCTION - Localized messages from app i18n files
  // ================================================================
  //
  // [LOG-MSG-I18N] Il meccanismo vero sta in `srv/lib/i18nMessages.js` (feature 0029). Stava QUI,
  // dentro la closure, e per questo i cinque job non potevano usarlo: girano come processi separati
  // e possono fare `require` di un file, non entrare in una closure — la stessa ragione per cui
  // `resolveAutoAssignments` e' uscito in `srv/lib/autoAssign.js` con la 0025. Quello che resta qui
  // e' l'unica cosa che ha bisogno di `req`: la risoluzione del LOCALE.
  //
  // La firma non cambia, e i suoi ~170 call site non si toccano.

  /**
   * Il locale di una richiesta. Fuori da una richiesta utente — invocazione interna da un job via
   * `srv.send` — non c'e' nessuna lingua da rispettare e si usa il default.
   *
   * @param {Object} req - CDS request object
   * @returns {string}
   */
  function localeOf(req) {
    return req?.locale || req?.user?.locale || i18nMessages.DEFAULT_LOCALE;
  }

  /**
   * [LOG-MSG-I18N] Il locale del campo `message` che un'action RESTITUISCE, quando quel campo ha
   * due consumatori: il cockpit, che lo mostra subito, e il recap di un job, che lo incastona fra
   * le proprie righe italiane.
   *
   * Differisce da `localeOf` sul solo ripiego, e la differenza e' tutta la ragione per cui esiste.
   * `syncRoutingPlexCycle` e' invocata sia dall'utente sia dal job `ROUTING_SYNC` via `srv.send`:
   * con `localeOf` un'invocazione senza lingua cadrebbe su 'en' e nel PDF del recap comparirebbe
   * UNA riga inglese in mezzo a venti italiane. Ripiegando sullo snapshot, l'utente legge la sua
   * lingua e il job la lingua del suo recap.
   */
  function responseLocale(req) {
    return req?.locale || req?.user?.locale || i18nMessages.SNAPSHOT_LOCALE;
  }

  /**
   * Get localized message based on request locale from specific app
   * @param {Object} req - CDS request object
   * @param {string} key - Message key from i18n files
   * @param {string} appName - App name where the message is defined
   * @param {...any} params - Optional parameters for placeholder replacement {0}, {1}, etc.
   * @returns {string} Localized message
   */
  function getLocalizedMessage(req, key, appName, ...params) {
    return i18nMessages.text(key, appName, localeOf(req), params);
  }

  // ================================================================
  // [UNIQUE-VIOLATION] Un vincolo di unicita' violato diventa un 400 leggibile
  // ================================================================
  //
  // IL 27/08/2026 il salvataggio dell'auto-assegnazione ha risposto `500` col testo grezzo di HANA
  // — `unique constraint violated ... Index(..._MATGROUP)`, valore `07 / 3201811 / 73` — tre volte
  // di fila. Non era un controllo mancante: `validateAutoAssign` c'e' da sempre. E' che dentro un
  // change set di `$batch` CAP lancia le sottorichieste IN PARALLELO (ogni richiesta del gruppo
  // parte da `Promise.resolve()`, e il `max_parallel = 1` governa i change set FRA LORO, non le
  // richieste dentro uno), quindi con due righe uguali nello stesso Salva l'ordine reale e'
  //     SELECT #1 → SELECT #2 → INSERT #1 → INSERT #2
  // e nessuno dei due controlli vede l'altro. Lo stesso vale per due schede del browser aperte.
  //
  // Quindi NON si aggiunge una difesa: si traduce quella che c'e' gia'. `@assert.unique` e' solo
  // compile-time (lo dichiara db/schema.cds), quindi la violazione torna come errore driver — ed e'
  // l'unico punto del progetto in cui l'utente vedeva un messaggio di HANA.
  //
  // UN SOLO PUNTO, e con `'*'`: le entity con `@assert.unique` sono DICIANNOVE e tutte esposte allo
  // stesso modo. Diciannove `try/catch` sarebbero diciotto occasioni di dimenticarne uno, e il
  // dimenticato non darebbe un errore — darebbe il `500` di prima, cioe' il difetto invisibile.
  //
  // I controlli in `before` NON si tolgono: restano la strada che da' il messaggio migliore nel
  // caso normale (una richiesta sola), e questo e' l'ultimo anello. Vedi
  // srv/lib/uniqueConstraintError.js e test/uniqueConstraintError.test.js.

  /**
   * Messaggio specifico per i vincoli che ne hanno gia' uno, con i campi da passare come parametri.
   *
   * Chi non e' in elenco prende il messaggio generico, che NOMINA i campi: e' meno bello e sempre
   * vero. Un messaggio specifico agganciato al vincolo sbagliato manderebbe a cercare dalla parte
   * opposta, quindi qui si mappa solo cio' che e' stato verificato testo per testo — e i parametri
   * sono i campi che quel testo si aspetta, non i campi del vincolo (per `rfDuplicate` sono due dei
   * tre, perche' il plant nel testo non compare).
   */
  const NS_PREFIX = 'avvaleplm.marsplm.sap2plex.';
  const UNIQUE_MESSAGES = {
    'ZCycleAutoAssignConfig.matGroup':   { key: 'aaGroupAlreadyAssigned', params: [] },
    'ZObjectGroup.plantGroup':           { key: 'ogGroupAlreadyExists',   params: [] },
    'ZJobNotifyRecipient.plantJobEmail': { key: 'jnDuplicate',            params: [] },
    'ZPlexConnConfig.plant':             { key: 'plexConnAlreadyExists',  params: ['Plant'] },
    'ZPlexJobSortConfig.plant':          { key: 'jsortDuplicate',         params: ['Plant'] },
    'ZProdOrderFilterConfig.plant':      { key: 'osfDuplicate',           params: ['Plant'] },
    'ZProdOrderTecoConfig.plant':        { key: 'tecoDuplicate',          params: ['Plant'] },
    'ZProdOrderCompleteConfig.plant':    { key: 'completeDuplicate',      params: ['Plant'] },
    'ZProdOrderScheduledConfig.plant':   { key: 'schedDuplicate',         params: ['Plant'] },
    'ZPhantomExplodeConfig.plant':       { key: 'phxDuplicate',           params: ['Plant'] },
    'ZProdConfPostingConfig.plant':      { key: 'cpcDuplicate',           params: ['Plant'] },
    'ZPlexOpTypeFilter.plantScope':      { key: 'potScopeAlreadySet',     params: ['Scope'] },
    'ZRoutingFilterConfig.plantRule':    {
      key: 'rfDuplicate', params: ['BillOfOperationsStatus', 'BillOfOperationsUsage']
    }
  };

  /**
   * L'etichetta di un campo, come la scheda la mostra.
   *
   * Il nome tecnico e' l'ultimo ripiego: `ComponentGroup` dice qualcosa a chi ha il modello sotto
   * gli occhi, «Group» a chi sta guardando la colonna.
   */
  function fieldLabel(entityName, field) {
    const el = cds.model?.definitions?.[entityName]?.elements?.[field];
    return (el && (el['@title'] || el['@Common.Label'])) || field;
  }

  /**
   * Il testo da mostrare per una violazione di unicita'.
   *
   * @param {Object} req
   * @param {{entity: string, constraint: string, fields: Array<string>}} hit
   * @returns {string}
   */
  function uniqueViolationMessage(req, hit) {
    const shortName = hit.entity.startsWith(NS_PREFIX) ? hit.entity.slice(NS_PREFIX.length) : hit.entity;
    const specific = UNIQUE_MESSAGES[`${shortName}.${hit.constraint}`];
    const data = (req && req.data) || {};

    if (specific) {
      // Un messaggio con segnaposto si usa SOLO se i suoi valori ci sono davvero. Su una `PATCH`
      // parziale il payload puo' non portarli, e un `{0}` reso vuoto direbbe «il plant  ha gia'…»:
      // meglio il generico, che almeno nomina i campi.
      const values = specific.params.map(f => data[f]);
      if (values.every(v => v !== undefined && v !== null && String(v) !== '')) {
        return getLocalizedMessage(req, specific.key, 'adminconfigplant', ...values);
      }
    }

    const detail = hit.fields
      .map((f) => {
        const value = data[f];
        const label = fieldLabel(hit.entity, f);
        return (value === undefined || value === null || String(value) === '') ? label : `${label} = ${value}`;
      })
      .join(', ');
    return getLocalizedMessage(req, 'uniqueConstraintViolation', 'adminconfigplant', detail);
  }

  // Il wrapper e' registrato QUI, in testa all'impl, di proposito: un handler `on` custom viene
  // provato nell'ordine di registrazione, quindi registrandolo per primo `next()` attraversa tutti
  // gli altri — quelli specifici di entity compresi — e la traduzione vale per tutto cio' che viene
  // dopo, incluso quello che verra' aggiunto domani.
  this.on(['CREATE', 'UPDATE'], '*', async function (req, next) {
    try {
      return await next();
    } catch (e) {
      const hit = describeViolation(e, cds.model);
      // Nessun aggancio: l'errore passa INTATTO. Inventare un messaggio su un vincolo che non si
      // riconosce vorrebbe dire dire all'utente una cosa che non sappiamo.
      if (!hit) throw e;
      console.warn(`>>> [UNIQUE-VIOLATION] ${hit.entity}.${hit.constraint} (${hit.fields.join(', ')})`);
      return req.reject(400, uniqueViolationMessage(req, hit), hit.fields[hit.fields.length - 1]);
    }
  });

  // ================================================================
  // [LOG-MSG-I18N] La resa del messaggio di log ALLA LETTURA (feature 0029)
  // ================================================================
  //
  // Il testo delle colonne `Message` degli storici invii era persistito nella lingua di CHI AVEVA
  // LANCIATO L'INVIO — e i cinque job non ne portano nessuna, quindi scrivevano in inglese mentre
  // il cockpit scriveva in italiano. La stessa colonna conteneva tre lingue.
  //
  // Ora la verita' e' `MessageJson`, i segmenti; `Message` e' lo snapshot testuale. Chi legge rende
  // i segmenti nella SUA lingua, e chi non ha segmenti — le righe scritte prima di questa feature —
  // vede il testo salvato, cioe' quello che vedeva prima. Nessuna migrazione.

  /**
   * Il testo di una riga di log nella lingua della richiesta.
   *
   * @param {string} json il contenuto di `MessageJson` / `LastMessageJson`
   * @param {Object} req
   * @param {string} fallback il `Message` salvato, usato quando non ci sono segmenti
   * @returns {string} il testo da mostrare
   */
  function renderLogMessage(json, req, fallback) {
    const segments = logMsg.unpack(json);
    if (!segments.length) return fallback === undefined ? null : fallback;
    return i18nMessages.render(segments, i18nMessages.COCKPIT_APP, localeOf(req));
  }

  /**
   * Rende in posto il messaggio delle righe lette.
   *
   * Il controllo `jsonField in row` NON e' pleonastico: se una richiesta arriva con un `$select`
   * che non comprende la colonna dei segmenti, non e' vero che «non ci sono segmenti» — e' vero che
   * non lo sappiamo, e si lascia il testo salvato. Confondere i due casi vorrebbe dire azzerare il
   * messaggio di una riga che ce l'ha, che e' peggio di non tradurlo.
   *
   * @param {Array|Object} data le righe restituite dalla READ
   * @param {Object} req
   * @param {string} textField nome della colonna testuale (`Message` / `LastMessage`)
   * @param {string} jsonField nome della colonna dei segmenti
   * @returns {Array|Object} `data`, modificato in posto
   */
  function localizeLogRows(data, req, textField = 'Message', jsonField = 'MessageJson') {
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (!(jsonField in row)) continue;
      row[textField] = renderLogMessage(row[jsonField], req, row[textField]);
    }
    return data;
  }

  /**
   * [W1-08] Il messaggio del PRIMO conflitto di work center approvato, o `null` se non ce ne sono
   * (BBP §7.6.2). Condiviso dalle DUE azioni che scrivono work center — `saveRoutingPlexCycle` per
   * il ciclo di (gruppo, contatore, materiale) e `saveRoutingTemplate` per il template — perche' e'
   * la stessa regola: che il template sia riusabile e il ciclo no non cambia nulla per un work
   * center che finisce su due operazioni della stessa part. E il template e' proprio la strada per
   * cui il conflitto arriverebbe nel ciclo senza passare dal popover, via «Import from Template».
   *
   * Il PRIMO e non tutti: il messaggio deve dire una cosa azionabile, e chi corregge il primo
   * conflitto risalva e vede il successivo. La marcatura nel popover, lato client, li mostra tutti
   * insieme (webapp/util/ApprovedWcConflicts.js).
   *
   * @param {Object} req
   * @param {Array<Object>} operations operazioni nella forma del payload dell'action
   * @returns {string|null}
   */
  function workcenterConflictMessage(req, operations) {
    const conflicts = approvedWcRules.findWorkcenterConflicts(operations);
    if (conflicts.length === 0) return null;

    const c = conflicts[0];
    if (c.kind === approvedWcRules.WC_CONFLICT.SAME_OP) {
      return getLocalizedMessage(req, 'wcDuplicateOnSameOp', 'marsplm-sap2plex',
        c.wcLabel, c.offender.label);
    }
    return getLocalizedMessage(req, 'wcOneOperationOnly', 'marsplm-sap2plex',
      c.wcLabel, c.offender.label, c.holder.label);
  }

  /**
   * [TEMPLATE-GROUP] Il messaggio del PRIMO conflitto di gruppo oggetti, o `null`.
   *
   * Gemello di `workcenterConflictMessage` qui sopra, e per lo stesso motivo rende un conflitto
   * solo: il messaggio deve dire una cosa azionabile, e chi corregge il primo risalva e vede il
   * successivo. La marcatura nel popover, lato client, li mostra tutti insieme
   * (webapp/util/TemplateGroupConflicts.js).
   *
   * A differenza del gemello, la chiama UNA sola action — `saveRoutingTemplate` — perche' i gruppi
   * per operazione oggi vivono solo sul template: nel ciclo l'assegnazione dei componenti passa
   * dall'auto-assegnazione, che ha le sue regole (srv/lib/autoAssignRules.js).
   *
   * @param {Object} req
   * @param {Array<Object>} operations operazioni nella forma del payload dell'action
   * @returns {string|null}
   */
  function templateGroupConflictMessage(req, operations) {
    const conflicts = templateGroupRules.findGroupConflicts(operations);
    if (conflicts.length === 0) return null;

    const c = conflicts[0];
    if (c.kind === templateGroupRules.GROUP_CONFLICT.SAME_OP) {
      return getLocalizedMessage(req, 'ogDuplicateOnSameOp', 'marsplm-sap2plex',
        c.GroupId, c.offender.label);
    }
    return getLocalizedMessage(req, 'ogOneOperationOnly', 'marsplm-sap2plex',
      c.GroupId, c.offender.label, c.holder.label);
  }

  // ================================================================
  // [PLEX-CONN] Connessione Plex del plant (feature 0020)
  //
  // La risoluzione NON vive piu' qui. `loadPlexCredentials`, che leggeva l'unica riga globale
  // `IsDefault && IsActive` di ZPlexCredentials in una cache a slot singolo, e' stata sostituita
  // dal punto unico srv/lib/plexConnection.js, condiviso con i job batch — che avevano la loro
  // copia divergente della stessa logica.
  //
  // Qui resta solo l'adattatore che traduce l'assenza di configurazione in un errore OData
  // LOCALIZZATO: il modulo condiviso porta una chiave i18n stabile e non un testo, perche' non
  // sa se il chiamante sia una richiesta HTTP o un job.
  // ================================================================

  /**
   * Connessione Plex di un plant, per un handler HTTP.
   * @param {Object} req richiesta CDS (per la localizzazione del messaggio)
   * @param {string} plant
   * @param {{force?: boolean}} [opts] `force: true` ignora la cache (test di connessione)
   * @returns {Promise<{plant, baseUrl, consumerKey, dataSourceUrl, dataSourceUser, dataSourcePassword}>}
   * @throws {Error} con testo gia' localizzato se il plant non e' configurato
   */
  async function loadPlexConnection(req, plant, opts = {}) {
    try {
      return await resolvePlexConnection(plant, opts);
    } catch (e) {
      if (e instanceof PlexConnectionMissing) {
        throw new Error(getLocalizedMessage(req, 'plexConnNotConfigured', 'adminconfigplant', e.plant));
      }
      if (e instanceof PlexConnectionPlantMissing) {
        throw new Error(getLocalizedMessage(req, 'plantCodeMandatory', 'adminconfigplant'));
      }
      throw e;
    }
  }

  /**
   * Gate di ruolo lato server: la richiesta prosegue solo se l'utente e' 'admin' PIENO sul plant.
   *
   * E' l'unico gate di ruolo server-side del progetto, e c'e' una ragione per cui non basta il
   * gate della UI usato dalle altre tab riservate: quelle nascondono DATI DI CONFIGURAZIONE, qui
   * si tratta di due segreti, e una tab nascosta non impedisce a nessuno di chiamare l'URL OData
   * a mano. Il ruolo 'admin-config' non passa, come richiesto.
   *
   * La mail e' ricavata da req.user e MAI dal client, esattamente come nell'handler getUserRole.
   *
   * NB: si applica all'entita' di configurazione e alla action di test, MAI al percorso di
   * risoluzione della connessione: getUserRole va live sul license server a ogni chiamata (nessuno
   * short-circuit sul positivo, DEC-09) e metterlo li' aggiungerebbe un round trip a ogni
   * chiamata verso Plex.
   *
   * @param {Object} req
   * @param {string} plantCode
   * @returns {Promise<boolean>} true se la richiesta e' stata RIFIUTATA (il chiamante deve fermarsi)
   */
  async function rejectIfNotFullAdmin(req, plantCode) {
    if (!plantCode) {
      req.reject(400, getLocalizedMessage(req, 'plantCodeMandatory', 'adminconfigplant'));
      return true;
    }
    const email = req.user?.id || req.user?.attr?.email || null;
    if (!email) {
      req.reject(403, getLocalizedMessage(req, 'roleAccessDenied', 'adminconfigplant'));
      return true;
    }
    let role = null;
    try {
      role = await getUserRole(email, plantCode);
    } catch (e) {
      // Fail-closed: un ruolo che non si e' potuto verificare non e' un ruolo.
      console.error(`>>> [PLEX CONN] verifica del ruolo fallita per ${email}/${plantCode}: ${e.message}`);
    }
    if (role !== 'admin') {
      req.reject(403, getLocalizedMessage(req, 'roleAccessDenied', 'adminconfigplant'));
      return true;
    }
    return false;
  }

  /**
   * [PLANT-ACCESS] Ferma un'azione (con `req.error` 400) quando il plant non e' utilizzabile da chi
   * sta chiedendo: attivo AND licenziato AND con un ruolo per l'utente corrente (feature 0048).
   *
   * Rende `true` se l'azione e' stata RIFIUTATA e il chiamante deve fermarsi.
   *
   * IL MESSAGGIO DICE LA CAUSA, e sono quattro con rimedi diversi: il customizing (plant non
   * attivo), la licenza, l'abilitazione dell'utente, e «non si e' potuto sapere» — che NON e' «non
   * hai un ruolo». Un messaggio solo per tutte manderebbe a cercare il rimedio sbagliato: e' la
   * ragione per cui il verdetto arriva fin qui invece di essere ridotto a un booleano prima.
   */
  async function rejectIfPlantNotUsable(req, plantCode) {
    const verdict = await plantVerdict(req, plantCode);
    if (plantAccessRules.accessGranted(verdict)) return false;
    // La mappa verdetto -> chiave sta in plantAccessRules: una chiave che manca nel bundle non da'
    // errore, esce come CHIAVE GREZZA a schermo, e la' un test la sorveglia.
    const key = plantAccessRules.messageKeyFor(verdict);
    req.error(400, getLocalizedMessage(req, key, 'adminconfigplant', plantCode || ''));
    return true;
  }

  /**
   * [PLANT-ACCESS] Ferma un'azione quando l'utente non ha un RUOLO sul plant (feature 0048).
   *
   * Il gate del catalogo Plex e della configurazione: soglia piu' larga di `rejectIfPlantNotUsable`
   * — nessun `Active`, nessuna licenza — e la ragione sta nel docblock di `plantRoleVerdict`.
   *
   * `req.reject` E NON `req.error`, a differenza della gemella: qui non c'e' un esito applicativo da
   * comporre, e i client di queste action srotolano `data.error.message` per mostrare il motivo.
   * Chi invece ha una busta (`getPlexOperations`) usa `plantRoleVerdict` direttamente.
   *
   * @returns {Promise<boolean>} `true` se la richiesta e' stata RIFIUTATA
   */
  async function rejectIfNoPlantRole(req, plantCode) {
    const { ok, key } = await plantRoleVerdict(req, plantCode);
    if (ok) return false;
    req.reject(key === 'plantCodeMandatory' ? 400 : 403,
      getLocalizedMessage(req, key, 'adminconfigplant', plantCode || ''));
    return true;
  }

  /**
   * [MASS-IMPORT] Ferma un'azione quando l'utente non ha un ruolo di CONFIGURAZIONE sul plant.
   *
   * TERZA SOGLIA, e non si fonde con le altre due. `rejectIfNoPlantRole` qui sopra ammette
   * QUALSIASI ruolo — e' la soglia del cockpit, dove un `user` lavora legittimamente;
   * `rejectIfNotFullAdmin` pretende `admin` e scarta `admin-config`, che nella configurazione e'
   * un utente legittimo. Questa sta in mezzo: `admin` oppure `admin-config`, cioe' esattamente
   * `plantAccessRules.enablesPlantConfig`, che e' anche il contratto della function `getUserRole`.
   *
   * Serve ai gesti che dalla dashboard scrivono CUSTOMIZING invece che esercizio — l'import
   * massivo di un template riscrive N cicli e le regole di auto-assegnazione dei loro materiali.
   * Usare la soglia del cockpit lo aprirebbe a un `user`; usare `admin` lo chiuderebbe a un
   * `admin-config`. Nessuno dei due errori da' un messaggio: uno da' un permesso di troppo,
   * l'altro un pulsante che non fa niente.
   *
   * `known === false` NON e' «non hai il ruolo»: il license server non ha risposto, e il rimedio e'
   * riprovare, non chiedere un'abilitazione. Sono due messaggi diversi, come in `plantRoleVerdict`.
   *
   * @returns {Promise<boolean>} `true` se la richiesta e' stata RIFIUTATA
   */
  async function rejectIfNoPlantConfigRole(req, plantCode) {
    if (!plantCode) {
      req.reject(400, getLocalizedMessage(req, 'plantCodeMandatory', 'adminconfigplant', ''));
      return true;
    }
    const who = plantAccess.identify(req);
    // Un run batch non ha un utente da valutare: stessa decisione del perimetro (0048).
    if (who.kind === plantAccessRules.KIND.BATCH) return false;
    const { role, known } = await getUserPlantRole(who.email, plantCode);
    if (plantAccessRules.enablesPlantConfig(role)) return false;
    console.warn(`>>> [MASS-IMPORT] plant ${plantCode}: ruolo`
      + ` ${role || '(nessuno)'} non abilita la configurazione: RIFIUTATA`);
    req.reject(403, getLocalizedMessage(req,
      known ? 'plantNoConfigRole' : 'plantRoleUnknown', 'adminconfigplant', plantCode));
    return true;
  }

  // ================================================================
  // [ORDER-STATUS-FILTER] Il perimetro applicato a UN ordine (feature 0017).
  // [W1-09] Comprende ora anche tipo ordine e responsabile di schedulazione.
  //
  // Le due azioni manuali che scrivono su Plex — «Crea Job» e lo spacchettamento — leggono un
  // singolo ordine per chiave, quindi non passano dal filtro della lista. Senza questo gate un
  // ordine mai rilasciato, o di un plant non configurato, resterebbe creabile a mano: il
  // perimetro varrebbe per il pianificato e non per l'umano, che è il contrario di ciò che
  // serve (chi preme un pulsante è proprio chi può sbagliare ordine).
  //
  // Il plant si conosce solo DOPO aver letto l'ordine, quindi le colonne da chiedere a SAP sono
  // l'unione dei criteri di TUTTI i plant configurati: una lettura in più sul database locale,
  // nessuna in più verso SAP.
  // ================================================================

  /**
   * [ORDER-ROWS] Le colonne della testata lette dalle DUE azioni manuali (createJobInPlex e
   * prepareSplit) e dalla sonda ordine. Erano due elenchi identici copiati inline, poi uno solo
   * qui, e una terza copia viveva nel job — che gira in un altro processo e non vede questa
   * closure. Ora l'elenco è in srv/lib/orderRows.js, insieme a quello della lista.
   *
   * Resta DISTINTO da `LIST_COLUMNS` di proposito: queste sono letture per CHIAVE, e non devono
   * ereditare `OrderLongText`, che è il campo caro (testo lungo via `READ_TEXT`). Il perché sta
   * in testa a quel modulo.
   */
  const PROD_ORDER_HEAD_COLUMNS = orderRows.HEAD_COLUMNS;

  /**
   * I campi citati da un qualunque criterio configurato, da aggiungere al $select per chiave.
   * @param {string[]} already colonne gia' presenti nella lettura: un nome ripetuto nel
   *        `$select` e' una richiesta malformata, non una ridondanza innocua. [W1-09] Va passata
   *        la lista INTERA, non i soli flag: `ManufacturingOrderType` e' gia' selezionato da
   *        entrambi i chiamanti e senza di esso qui finirebbe due volte.
   */
  async function prodOrderStatusColumns(db, already = []) {
    const cfg = await prodOrderStatusFilter.loadProdOrderFilterConfig(db);
    const have = new Set(already);
    return prodOrderStatusFilter.selectColumns(cfg).filter((c) => !have.has(c));
  }

  /**
   * L'ordine è nel perimetro per stato del suo plant?
   * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
   *          `code` è la chiave i18n usata, che i chiamanti riportano in `messageCode`.
   */
  async function checkProdOrderInScope(req, db, order) {
    const plant = String(order?.ProductionPlant || '').trim();
    const cfg = (await prodOrderStatusFilter.loadProdOrderFilterConfig(db, [plant])).get(plant);
    if (!cfg) {
      return {
        ok: false,
        code: 'osfPlantNotConfigured',
        message: getLocalizedMessage(req, 'osfPlantNotConfigured', 'marsplm-sap2plex', plant)
      };
    }
    const verdict = prodOrderStatusFilter.orderPasses(order, cfg);
    if (verdict.passes) return { ok: true };
    if (verdict.missing.length) {
      // Criterio non valutabile: è un difetto del canale, non uno stato dell'ordine, e il testo
      // deve dirlo — altrimenti l'utente cercherebbe la causa nell'ordine.
      return {
        ok: false,
        code: 'osfUnavailableFields',
        message: getLocalizedMessage(req, 'osfUnavailableFields', 'marsplm-sap2plex',
          verdict.missing.join(', '))
      };
    }
    // [W1-09] Rifiuto su un criterio di VALORE: l'informazione utile non sono gli stati, è il
    // valore che l'ordine porta davvero contro quelli ammessi. Il valore effettivo si mostra
    // anche — anzi soprattutto — quando è vuoto: un responsabile sempre vuoto è il sintomo che
    // DEC-64 insegna a riconoscere, e nasconderlo lo renderebbe indistinguibile da un ordine
    // fuori perimetro per davvero.
    if (verdict.failedValue) {
      const fv = verdict.failedValue;
      return {
        ok: false,
        code: 'osfOrderValueOutOfScope',
        message: getLocalizedMessage(req, 'osfOrderValueOutOfScope', 'marsplm-sap2plex',
          order.ManufacturingOrder || '', plant, fv.sapField,
          fv.actual || getLocalizedMessage(req, 'osfValueEmpty', 'marsplm-sap2plex'),
          fv.expected.join(', '))
      };
    }
    // Gli stati che l'ordine HA, fra quelli che il criterio nomina: è l'informazione che spiega
    // il rifiuto senza costringere ad aprire il customizing.
    const cited = [...cfg.required, ...cfg.excluded];
    const held = cited.filter((f) => prodOrderStatusFilter.isSet(order[f]));
    return {
      ok: false,
      code: 'osfOrderOutOfScope',
      message: getLocalizedMessage(req, 'osfOrderOutOfScope', 'marsplm-sap2plex',
        order.ManufacturingOrder || '', plant, held.join(', ') || '-')
    };
  }

  // ================================================================
  // [ROUTING-SCOPE] Il perimetro dei cicli applicato a UN ciclo (feature 0016).
  //
  // Le regole per plant dicono quali cicli esistono per noi. Se un ciclo e' fuori, deve esserlo
  // OVUNQUE: non basta toglierlo dalla lista, perche' il dettaglio e' indirizzabile per URL e le
  // azioni di salvataggio e invio si invocano per chiave, senza passare dalla lista.
  //
  // Restituisce un VERDETTO invece di sollevare l'errore, come `checkProdOrderInScope` per gli
  // ordini: i percorsi che scrivono lo trasformano in `req.error`, quelli che leggono in una
  // risposta vuota, il job in una voce di recap. Un solo posto in cui la regola e' scritta, tre
  // modi di reagire.
  //
  // Restituisce ANCHE la testata, cosi' i chiamanti che oggi la leggono per il gate del plant non
  // ne fanno una seconda: cambia il $select, non il numero di chiamate.
  // ================================================================

  /**
   * Il ciclo è nel perimetro configurato del suo plant?
   * @returns {Promise<{ ok: true, hdr: object } | { ok: false, code: string, message: string, hdr: object|null }>}
   *          `code` è la chiave i18n usata, per chi deve riportarla in un log o in un recap.
   */
  async function checkRoutingInScope(req, db, group, routing) {
    let hdr;
    try {
      hdr = await readRoutingHeader(group, routing);
    } catch (e) {
      // Lettura fallita: NON e' «il ciclo non esiste», e' «non l'ho potuto sapere». Sui percorsi
      // che scrivono e' comunque un blocco — non si manda niente a Plex su una verifica non fatta
      // — ma il messaggio deve dire che il guasto e' del canale, altrimenti si cerca la causa nel
      // ciclo.
      console.error(`>>> [ROUTING-SCOPE] lettura testata ${group}/${routing} fallita: ${e.message}`);
      return {
        ok: false, hdr: null, code: 'routingScopeUnavailable',
        message: getLocalizedMessage(req, 'routingScopeUnavailable', 'marsplm-sap2plex',
          `${group}/${routing}`, e.message || '')
      };
    }

    if (!hdr) {
      // SAP non restituisce la testata: il ciclo non esiste davvero. Prima questo caso finiva nel
      // gate del plant e usciva come «il plant  non è Active», col segnaposto vuoto.
      return {
        ok: false, hdr: null, code: 'routingNotFound',
        message: getLocalizedMessage(req, 'routingNotFound', 'marsplm-sap2plex', `${group}/${routing}`)
      };
    }

    const plant = String(hdr.Plant ?? '').trim();
    const { rules, readOk } = await routingVisibility.loadPlantRoutingFilters(plant, db);
    if (!readOk) {
      // FAIL-CLOSED, al contrario della lista. Vedi loadPlantRoutingFilters.
      return {
        ok: false, hdr, code: 'routingScopeUnavailable',
        message: getLocalizedMessage(req, 'routingScopeUnavailable', 'marsplm-sap2plex',
          `${group}/${routing}`, 'configurazione del perimetro non leggibile')
      };
    }

    // Nessuna regola per il plant => nessuna restrizione. E' il caso di chi non configura nulla, e
    // deve restare indistinguibile da prima della feature.
    if (routingVisibility.routingPasses(hdr, rules)) return { ok: true, hdr };

    // Il messaggio nomina lo stato e l'utilizzo che il ciclo HA, e le regole in vigore: spiega il
    // rifiuto senza costringere ad aprire il customizing (come osfOrderOutOfScope per gli ordini).
    return {
      ok: false, hdr, code: 'routingOutOfScope',
      message: getLocalizedMessage(req, 'routingOutOfScope', 'marsplm-sap2plex',
        `${group}/${routing}`, plant,
        routingVisibility.describeRow(hdr), routingVisibility.describePlantRules(rules))
    };
  }

  /**
   * Variante «gate» per i percorsi che scrivono: solleva l'errore e dice se fermarsi, nella forma
   * di `rejectIfPlantNotUsable` — che viene applicato PRIMA, perche' un plant non attivo e' una
   * ragione di rifiuto piu' generale e il suo messaggio e' piu' preciso.
   * @returns {Promise<{ blocked: boolean, hdr: object|null }>}
   */
  async function rejectIfRoutingNotUsable(req, db, group, routing) {
    const verdict = await checkRoutingInScope(req, db, group, routing);
    if (verdict.hdr && await rejectIfPlantNotUsable(req, verdict.hdr.Plant)) {
      return { blocked: true, hdr: verdict.hdr };
    }
    if (!verdict.ok) {
      console.warn(`>>> [ROUTING-SCOPE] ${group}/${routing} rifiutato: ${verdict.code}`);
      req.error(400, verdict.message);
      return { blocked: true, hdr: verdict.hdr };
    }
    return { blocked: false, hdr: verdict.hdr };
  }

  // ================================================================
  // PAGINATION HELPERS - shared by the custom READ handlers (Products,
  // ProductionOrders, Routings). CAP does NOT auto-apply $top/$skip/$orderby to
  // arrays returned by custom handlers, so we read them from req.query.SELECT and
  // apply paging ourselves. $count is returned as an ENUMERABLE property on the
  // returned array (result.$count = N) so the OData adapter emits @odata.count.
  // ================================================================
  // [LIST-WHOLE-SET] Perche' il tetto per richiesta non e' piu' 500.
  //
  // Le tre liste della dashboard NON paginano verso SAP: il server legge il perimetro INTERO —
  // A_ProductPlant a blocchi di 1000, le testate ciclo + MAPL per plant, e dalla stessa modifica
  // anche gli ordini in modalita' IS — e poi affetta in memoria. Lo `$skip` del browser non
  // diventa mai uno skip verso ECC, ed e' la ragione per cui gli ordini non spingono piu'
  // $top/$skip (vedi readOrders).
  //
  // ATTENZIONE (02/09/2026): la premessa di quella scelta era «le RFC dietro gli iFlow non hanno
  // paginazione», e sugli ORDINI non vale piu' — `IV_TOP`/`IV_SKIP` sono stati implementati lato
  // ABAP il 01/09/2026. Il rollback di DEC-83 e' sbloccato ma NON fatto: il ramo resta, quindi
  // questo tetto resta quello che e'. Chi lo toglie legga l'addendum del 02/09 a DEC-83 — e sappia
  // che «senza `IV_TOP` quella RFC risponde `200` con ZERO righe» e' un'IPOTESI NON CONFERMATA:
  // era la causa attribuita allo zero di `PROD_ORDER`, e col tetto a bordo il job ha letto ancora
  // zero. Il perimetro di quella premessa e' in testa a srv/lib/prodOrderSource.js.
  //
  // Conseguenza: chiedere N pagine da 500 significa rileggere N volte lo stesso perimetro da
  // ECC per buttarne via ogni volta il 99%. Con il cockpit che ordina e filtra nel BROWSER —
  // e quindi vuole l'insieme intero una volta sola — quel tetto era diventato puro spreco.
  //
  // `defTop` resta 100: un client che non chiede niente riceve quello che riceveva prima. Solo
  // chi chiede esplicitamente di piu' ne ottiene di piu'. I tetti VERI restano quelli di area e
  // continuano a dichiararsi da soli — PLANT_ROWS_MAX_PAGES x PLANT_ROWS_PAGE sui materiali,
  // IS_PROD_ORDER_MAX_ROWS sugli ordini: questo e' solo il limite della singola risposta HTTP,
  // e serve a non spedire un JSON smisurato se un perimetro sfugge di mano.
  //
  // ----------------------------------------------------------------
  // MA QUESTO TETTO NON MORDE DA SOLO, e per mesi non ha morso affatto. `paging.js` di CAP
  // (libx/_runtime/common/generic/paging.js) gira nella fase `_initial`, cioe' PRIMA di ogni
  // handler dell'applicazione, e riscrive il `$top` del client a
  // `Math.min($top, cds.env.query.limit.max)` — default 1000. `readPaging` riceveva quindi un
  // valore GIA' TAGLIATO e il suo `Math.min(..., LIST_MAX_TOP)` era inerte: la dashboard chiedeva
  // 20000, il server ne rendeva 1000 su 4761 e la striscia `listTruncated` accusava la sorgente,
  // che invece le aveva consegnate tutte. Quello che lo rende effettivo e' l'annotazione
  // `@cds.query.limit.max: 0` sulle tre entity di lista in cat-service.cds, dove sta anche il
  // perche' per esteso. Chi la togliesse riavrebbe le liste tagliate a 1000 SENZA nessun errore.
  //
  // NELLA STESSA TRAPPOLA sta `defTop = 100` qui sotto: e' CODICE MORTO. `paging.js` mette
  // SEMPRE un `SELECT.limit` (`{ val: $top ?? conf.default }`, e `conf.default` e' 1000), quindi
  // `readPaging` non ricade mai sul suo default. E' lo stesso inganno della guardia
  // sull'`orderBy`, gia' documentato in testa a srv/lib/naturalOrderRead.js: due comportamenti di
  // CAP che sembrano assenti finche' non si legge il codice della fase `_initial`.
  // Si lascia dov'e' — toglierlo cambierebbe il comportamento di una lettura per chiave, dove
  // `SELECT.limit` e' davvero `undefined` (vedi il blocco [KEY-READ] su `readPaging`).
  // ----------------------------------------------------------------
  const LIST_MAX_TOP = parseInt(process.env.LIST_MAX_TOP || '20000', 10);

  // ================================================================
  // [MAT-SCOPE] Il budget che le DUE letture del perimetro materiali si dividono (feature 0050).
  //
  // Dalla 0050 la lista si produce solo dopo il join, quindi `A_ProductPlant` e `A_Product` girano
  // in SEQUENZA dentro la stessa richiesta. Ognuna aveva la propria scadenza da 90 s
  // (`DEADLINE_DEFAULT_MS` in plantRowsPaging.js) e due volte 90 non stanno sotto i 120 s
  // dell'approuter: la seconda riceve il RESIDUO.
  //
  // Il minimo NON e' zero, e la ragione e' che `deadlineMs: 0` non significa «tempo scaduto» ma
  // «nessuna scadenza» — e' il valore dei job, che l'approuter non ce l'hanno. Passare `0` a
  // budget esaurito toglierebbe la difesa esattamente nel momento in cui serve.
  // ================================================================
  const REQUEST_BUDGET_MS = parseInt(process.env.MAT_LIST_BUDGET_MS || '105000', 10);
  const DETAIL_MIN_BUDGET_MS = parseInt(process.env.MAT_DETAIL_MIN_BUDGET_MS || '10000', 10);

  // ================================================================
  // [NATURAL-ORDER] Gruppi e Auto-assegnazione si ordinano in NODE, e l'handler vive in
  // `srv/lib/naturalOrderRead.js` (DEC-102).
  //
  // Il perche' dell'ordinamento in Node, il perche' di `before`+`after` invece di un `on`, la
  // guardia sugli ordinamenti CHIESTI (CAP ne aggiunge sempre uno implicito sulle chiavi, quindi
  // scritta come «l'orderBy e' vuoto» non proteggeva niente) e il perche' il limite si rimette a posto — CAP lo
  // rilegge dopo di noi per decidere il `@odata.nextLink` — stanno tutti in testa a quel file, dove
  // il test li sorveglia. Qui restano i due innesti.
  // ================================================================
  const naturalOrderRead = require('./lib/naturalOrderRead');
  const codedValues = require('./lib/codedValues');

  /** Le dipendenze che solo il servizio sa risolvere: il locale viene da `req`. */
  function naturalOrderDeps() {
    return { codedValues, i18nMessages, localeOf };
  }

  /**
   * [KEY-READ] NON guarda `SELECT.one`, ed e' voluto — ma va saputo da chi tocca un handler.
   *
   * Su una lettura per CHIAVE CAP non applica ne' paginazione ne' ordinamento (`SELECT.limit` e
   * `SELECT.orderBy` sono entrambi `undefined`), quindi `top` ricade sul default e questa funzione
   * rende «la prima pagina da cento». E' innocuo SOLTANTO perche' negli handler il filtro
   * d'identita' gira PRIMA dello `slice`: chi lo spostasse dopo riavrebbe la riga sbagliata con un
   * `200` e nessun log. Nessun test lo cattura senza un runtime: questo commento e' la difesa.
   */
  function readPaging(req, { defTop = 100, maxTop = LIST_MAX_TOP } = {}) {
    const L = req.query?.SELECT?.limit;
    return {
      top: Math.min(Number(L?.rows?.val) || defTop, maxTop),
      skip: Number(L?.offset?.val) || 0,
      wantCount: req.query?.SELECT?.count === true,
      orderBy: req.query?.SELECT?.orderBy // array [{ref:['F'], sort:'asc'|'desc'}] or undefined
    };
  }

  // Comparator: order by the first non-null of dateFields (desc), nulls last,
  // then by keyFields asc for a deterministic tie-break (stable paging).
  function byDateDescChain(dateFields, keyFields) {
    const firstDate = (row) => {
      for (const f of dateFields) {
        const v = row[f];
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    };
    return (a, b) => {
      const da = firstDate(a), db = firstDate(b);
      if (da !== db) {
        if (da === null) return 1;       // nulls last
        if (db === null) return -1;
        return da < db ? 1 : -1;         // desc
      }
      for (const k of keyFields) {
        const ka = a[k] ?? '', kb = b[k] ?? '';
        if (ka !== kb) return ka < kb ? -1 : 1;
      }
      return 0;
    };
  }

  // Comparator built from an incoming CQN orderBy (used if the UI adds a Sorter).
  function cmpFromCqn(orderBy) {
    return (a, b) => {
      for (const o of orderBy) {
        const f = o.ref?.[o.ref.length - 1];
        if (!f) continue;
        const av = a[f], bv = b[f];
        if (av === bv) continue;
        const desc = o.sort === 'desc';
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av < bv ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    };
  }

  // ================================================================
  // [IS-BLANK-ROWS] GUARDIA DELLE RIGHE PRIVE DI IDENTITA', per i READ delle tre liste.
  //
  // PERCHE' ESISTE
  // Il 06/08/2026 l'iFlow `PRODUCTIONORDER_QUERYGET` (E-13) ha risposto `200` con 11 righe che
  // portavano i 19 campi chiesti, tutti a valore iniziale: `ManufacturingOrder: ""`,
  // `TotalQuantity: "0.0"`, la data ABAP `00000000`. Il binding OData V4 del cockpit si è fermato
  // con `Duplicate key predicate: ('')` — 11 entity con la stessa chiave non sono rappresentabili
  // in una collection — e quel messaggio non nomina né l'area né l'indirizzo. Peggio: sul ramo
  // d'errore il handler restituiva `[]`, che la dashboard mostra come «nessun ordine trovato».
  // Un guasto della sorgente era quindi indistinguibile da «non ci sono dati», che è il caso che
  // il contratto chiama il peggiore (C-6).
  //
  // COSA FA
  // Tiene le righe utilizzabili, con i valori INTATTI (nessuna normalizzazione, C-7), e dichiara
  // ciò che ha scartato. Due casi, con cause diverse e lo stesso effetto sul client — una entity
  // che non si può rappresentare:
  //   - riga senza identità: tutti i campi che vengono dalla sorgente sono vuoti;
  //   - chiave ripetuta: due righe con la stessa chiave dell'entity set. Non è un caso teorico —
  //     sui 3478 record di `A_ProductPlant` del sandbox 2 arrivano DUE volte, perché la
  //     paginazione a `$skip` senza ordinamento stabile può restituire la stessa riga su due
  //     pagine. Finora quelle due righe finivano in lista.
  // Se non resta NULLA di utilizzabile la lettura viene respinta con un messaggio che nomina il
  // difetto, invece di mostrare una lista vuota.
  //
  // La rilevazione condivisa (una nota per lettura, valida anche per i job batch) sta a monte, in
  // srv/lib/isRemoteSource.js: qui c'è la sola politica delle tre liste del cockpit.
  // Perimetro: grep -rn "IS-BLANK-ROWS".
  // ================================================================
  /**
   * @param {string[]} fields chiave esposta dall'entity set: su questa si contano le ripetizioni
   * @param {string[]} [blankFields=fields] i soli campi che arrivano dalla sorgente
   * @param {string} label nome dell'entity set, non un testo tradotto: finisce sia nei log sia nel
   *   messaggio localizzato, dove serve a dire QUALE lista non è stata mostrata
   * @param {boolean} [dedupe=true] `false` dove la ripetizione della tupla è legittima
   */
  function identityGuard({ fields, blankFields, label, dedupe = true }) {
    const guard = {
      fields,
      blank: 0,
      duplicates: 0,
      dropped: 0,
      /** true quando la sorgente ha restituito righe e NESSUNA era utilizzabile. */
      nothingUsable: false,

      /** Righe utilizzabili di un blocco appena letto. Registra, non altera i valori. */
      keep(rows) {
        const check = isQueryShape.identityCheck(rows, fields, { blankFields, dedupe });
        if (!check.blank && !check.duplicates) return Array.isArray(rows) ? rows : check.kept;
        guard.blank += check.blank;
        guard.duplicates += check.duplicates;
        guard.dropped += check.total - check.kept.length;
        if (check.total > 0 && check.kept.length === 0) guard.nothingUsable = true;
        // Le due cause si dichiarano separate perché hanno origini diverse e rimedi diversi.
        const why = [];
        if (check.blank) {
          why.push(`${check.blank} PRIVE DI IDENTITA' (${(blankFields || fields).join(', ')} tutti vuoti):`
            + ' la sorgente ha risposto 200 con valori iniziali, il difetto è a monte');
        }
        if (check.duplicates) {
          why.push(`${check.duplicates} con CHIAVE RIPETUTA (${fields.join(', ')}): due entity con la stessa`
            + ' chiave non sono rappresentabili in un entity set e fermerebbero il binding del client'
            + ' (le cause tipiche sono a monte: paginazione non ordinata, oppure unione di più letture)');
        }
        console.error(
          `>>> [IS-BLANK-ROWS] ${label}: SCARTATE ${check.total - check.kept.length} righe su ${check.total},`
          + ` tenute ${check.kept.length} — ${why.join(' | ')}`
        );
        return check.kept;
      },

      /** Il messaggio da mostrare quando non è rimasto nulla. Vuoto se c'è qualcosa da mostrare. */
      rejectMessage(req) {
        if (!guard.nothingUsable) return '';
        return getLocalizedMessage(req, 'sourceRowsWithoutIdentity', 'marsplm-sap2plex',
          guard.blank + guard.duplicates, label, (blankFields || fields).join(', '));
      }
    };
    return guard;
  }

  // ================================================================
  // [KEY-READ] LA RETE: nessuna lettura per chiave puo' servire una riga di un altro oggetto.
  //
  // IL DIFETTO CHE CHIUDE. In una lettura per chiave CAP mette il predicato in
  // `SELECT.from.ref[<ultimo>].where` e lascia `SELECT.where` a `undefined`; tutti e tredici gli
  // handler `on('READ')` custom del progetto leggevano il solo secondo, quindi non vedevano
  // criteri e restituivano una pagina di righe. E per una lettura singola CAP prende `result[0]`
  // SENZA confrontare la chiave (`libx/odata/utils/result.js:62`): rispondeva `200` con la riga
  // sbagliata. Sul dettaglio materiale, premere «Invia a Plex» scriveva su un altro tenant.
  //
  // QUESTA NON E' LA CORREZIONE, ED E' LA FRASE DA NON PERDERE. La rete trasforma «riga
  // SBAGLIATA» in «riga ASSENTE»: su un handler che pagina, la riga cercata spesso non e' nella
  // prima pagina, quindi l'esito diventa `404`. E' un enorme miglioramento — un 404 si vede, e i
  // due chiamanti reali lo mostrano gia' — ma le correzioni sono negli handler, uno per uno. La
  // rete e' il fondo che vale anche per un handler scritto domani, ed e' per questo che la riga di
  // log dice che il difetto e' dell'HANDLER: un 404 muto sarebbe opaco quanto la riga sbagliata.
  //
  // TRE MECCANICHE VERIFICATE NEI SORGENTI CAP 9.9.2, non assunte:
  //  1. l'array si muta IN LOCO: un `return` in un `after` di READ non ha effetto (vedi
  //     [CODED-VALUES] e `sortInPlace` in srv/lib/naturalOrderRead.js);
  //  2. si scrive su `req.results` e non sull'array ricevuto: se un handler rendesse un OGGETTO,
  //     `lib/srv/srv-dispatch.js:66-70` passa agli `after` un involucro monouso e `handle()` rende
  //     `req.results` — mutare l'involucro sarebbe un no-op SILENZIOSO. Quel ramo si rifiuta;
  //  3. svuotare l'array su `SELECT.one` produce un 404 VERO: `result[0]` diventa `undefined`,
  //     `getODataResult` rende `undefined` e `libx/odata/middleware/read.js:301` fa `cds.error(404)`.
  //
  // Le CHIAVI si leggono dal CSN e non si scrivono qui: una chiave aggiunta al modello e non alla
  // tabella renderebbe la rete cieca in silenzio. La tabella delle entity sta in
  // srv/lib/keyReadRules.js ed e' sorvegliata da test/keyReadGuarded.test.js.
  //
  // Registrata QUI, in testa all'impl, perche' gli `after` girano in ordine di registrazione
  // (`Promise.all`): cosi' qualunque altro `after` aggiunto domani lavora sull'insieme gia'
  // ristretto. Gli altri due del progetto — [LOG-MSG-I18N] e naturalOrderRead — insistono su
  // entity disgiunte da queste tredici.
  // ================================================================
  for (const entity of (keyReadRules.GUARDED_ENTITIES[this.name] || [])) {
    this.after('READ', entity, (data, req) => {
      const sel = req.query && req.query.SELECT;
      if (!sel || sel.one !== true) return;          // solo le letture SINGOLE
      if (!Array.isArray(data) || data.length === 0) return;

      const target = req.target || {};
      const elements = target.elements || {};
      const keyNames = Object.keys(target.keys || {})
        .filter((k) => elements[k] && !elements[k].isAssociation);
      const uuidKeys = keyNames.filter((k) => elements[k] && elements[k].type === 'cds.UUID');

      const k = keyReadRules.keyReadOf(req.query, keyNames);
      // Chiave incompleta: non si scarta niente. Con una chiave parziale il confronto
      // scarterebbe righe legittime, che e' il difetto opposto e altrettanto silenzioso.
      if (!k.complete) return;

      const kept = data.filter((r) => keyReadRules.matchesKey(r, k.equals, { caseInsensitive: uuidKeys }));
      if (kept.length === data.length) return;       // niente da scartare: nessun tocco, nessun log

      const chiesta = Object.entries(k.equals).map(([f, v]) => `${f}='${v}'`).join(' ');
      console.warn(`>>> [KEY-READ] ${entity}: la lettura per chiave ha reso ${data.length} righe e`
        + ` ne corrisponde${kept.length === 1 ? '' : 'ro'} ${kept.length} a ${chiesta}.`
        + ' Il criterio di chiave NON e\' stato applicato dall\'handler: e\' un difetto'
        + ' dell\'handler, non un dato assente.');

      if (Array.isArray(req.results)) {
        req.results.length = 0;
        req.results.push(...kept);
      } else {
        // L'handler ha reso un oggetto: l'array che abbiamo in mano e' un involucro monouso e
        // mutarlo non ha effetto. Servire la riga sbagliata e' peggio di un errore dichiarato.
        req.reject(404, `[KEY-READ] ${entity}: la riga restituita non corrisponde alla chiave richiesta`);
      }
    });
  }

  // ================================================================
  // [W1-05] BOM NODE MAP — RIMOSSA. Era il residuo del modello routing pre-v3, tenuto «non
  // referenziato per eventuale riuso futuro (es. recuperare quantità/unità componente)». Quel
  // riuso è arrivato, e non è passato di qui: `bomExplode.buildBomIndex` legge la distinta dalla
  // sorgente d'area (`bomSource`), quindi sui DUE canali, mentre questa si connetteva a mano al
  // path storico — su Integration Suite non sarebbe esistito.
  //
  // La sua chiave NON va resuscitata, ed è il motivo per cui non la si è riciclata: spogliava gli
  // zeri iniziali su entrambi i lati del join («SAP returns '00000743', the comp-alloc carries
  // '743'»). Fra due chiavi scritte da SAP il confronto è STRETTO (DEC-51): un disallineamento di
  // riempimento è un difetto a monte da vedere, e allinearlo qui lo nasconderebbe — proprio dove
  // W1-27 dice di andarlo a cercare. La chiave in esercizio è `bomItemKey` in
  // srv/lib/bomExplodeRules.js, gemella di `bomKey` di srv/lib/routingMaterialRules.js.
  // ================================================================

  // ================================================================
  // [AUTO-ASSIGN] AUTO-ASSIGNMENT RESOLVER — SPOSTATO in srv/lib/autoAssign.js (feature 0025).
  //
  // Viveva qui dentro, cioe' dentro la closure di `cds.service.impl`, ed era percio' raggiungibile
  // solo dal server web. Il job `PROD_ORDER` e' un processo standalone e dalla 0025 ha bisogno
  // della stessa risposta — su quale operazione appendere un componente che l'ordine ha e la part
  // Plex no — quindi la funzione e' uscita. Duplicarla avrebbe prodotto due auto-assegnazioni che
  // divergono, cioe' un albero a schermo diverso da cio' che viene inviato.
  //
  // Il codice e' quello di prima, spostato: nessun cambio di comportamento. Con lei e' uscito il
  // suo unico aggancio di closure, `loadPlantRowsIndex` — che dalla 0035 ha una casa sua,
  // srv/lib/plantRows.js, insieme alla paginazione che questo file scriveva una seconda volta.
  // I tre chiamanti di questo file restano identici.
  // ================================================================


  // ================================================================
  // [FAST-LIST] I campi di `Products` che NON arrivano da A_ProductPlant: vengono da A_Product
  // e dalle descrizioni. Questo elenco è la definizione di «campo di dettaglio».
  //
  // [MAT-SCOPE] I SUOI USI SONO ORA DUE, non tre. Il primo era «decidere quale via prende una
  // READ» (`needsDetails`), e non c'è più: dalla 0050 la lista si produce sempre dopo il join con
  // l'anagrafica, quindi nessun campo di questo elenco è mai `null` per costruzione della via —
  // filtrare o ordinare su uno di essi non ha più bisogno di un permesso. Restano:
  //   - dare forma alla risposta dell'azione productDetails;
  //   - dire al client quali campi patchare quando un blocco arriva.
  // ================================================================
  const PRODUCT_DETAIL_FIELDS = Object.freeze([
    'ProductDescription', 'ProductType', 'CrossPlantStatus', 'IsMarkedForDeletion', 'ProductGroup',
    'ProductHierarchy', 'Division', 'BaseUnit', 'GrossWeight', 'WeightUnit', 'NetWeight', 'CreationDate'
  ]);

  /** La riga di dettaglio di un materiale, nella forma che la dashboard mostra. */
  // ================================================================
  // [PLANT-ROWS] [AUTO-ASSIGN] L'indice A_ProductPlant di un plant — SPOSTATO in
  // srv/lib/autoAssign.js (feature 0025).
  //
  // E' uscito insieme a `resolveAutoAssignments`, che ne era il chiamante piu' stretto: la
  // funzione doveva diventare importabile dal job, e lasciare qui l'indice avrebbe significato
  // spezzare la coppia. Gli altri due chiamanti di questo file lo importano dal modulo.
  //
  // Le regole che lo governano — perche' si filtra sul SOLO plant (DEC-49), la paginazione, e il
  // fatto che ogni incompletezza va DICHIARATA — stanno in testa al modulo.
  // ================================================================

  // ================================================================
  // [DETAILS-PREFETCH] Cache dei dettagli materiale (A_Product + descrizione).
  //
  // Stesso schema di `plantRowsCache` qui sopra — la promessa in cache, non il risultato — ma
  // per MATERIALE, perche' i blocchi che il client chiede si sovrappongono: mentre il
  // precaricamento macina la coda dell'elenco, chi scorre fa partire il riempimento di righe che
  // stanno in un blocco gia' in volo. Le regole e il perche' stanno in testa al modulo.
  //
  // La usa SOLO l'azione `productDetails`, cioe' la dashboard. La via lenta della lista,
  // `getConfiguredProducts` e il job MAT_SYNC continuano a leggere da SAP senza cache: da li' i
  // dati vengono SCRITTI su Plex, e mandare un'anagrafica vecchia di cinque minuti e' un rischio
  // che una schermata non ha.
  // ================================================================
  const PRODUCT_DETAIL_TTL_MS = Number(process.env.PRODUCT_DETAIL_TTL_MS || PLANT_ROWS_TTL_MS);
  const productDetailCache = createProductDetailCache({ ttlMs: PRODUCT_DETAIL_TTL_MS });

  function detailRowOf(row) {
    return {
      ProductDescription: row.ProductDescription || '',
      ProductType: row.ProductType,
      CrossPlantStatus: row.CrossPlantStatus,
      IsMarkedForDeletion: row.IsMarkedForDeletion,
      ProductGroup: row.ProductGroup,
      ProductHierarchy: row.ProductHierarchy,
      Division: row.Division,
      BaseUnit: row.BaseUnit,
      GrossWeight: row.GrossWeight,
      WeightUnit: row.WeightUnit,
      NetWeight: row.NetWeight,
      CreationDate: row.CreationDate
    };
  }

  // [MAT-SCOPE] `loadTypeMappedPlants` sta in srv/lib/materialVisibility.js e non qui: la vuole
  // anche il job MAT_SYNC, e questo file e' una closure. Il perche' completo e' sulla funzione.

  // ================================================================
  // CONFIGURED PRODUCTS LOADER - single source of the "materials for the
  // configured plants (with config filters)" set. Used by the Products READ
  // handler AND the Send-all-to-Plex flow so both cover the SAME set.
  // Fetches A_Product in BATCHES (the external OData v2 returns a default page of
  // ~100 and CAP does not follow nextLink; a 653-id `in` would also overflow the URL).
  // Returns { plantRows, uniqueProducts, productMap }.
  //
  // [MAT-SCOPE] QUI ERA DESCRITTA LA VIA VELOCE ([FAST-LIST], 0013 RB-16c): `details: false` si
  // fermava dopo la lettura di A_ProductPlant, `productMap` restava vuota e il client chiedeva i
  // dettagli a blocchi con `productDetails`. Dalla 0050 non esiste più — il perché sta sulla firma
  // della funzione, poco più sotto: senza il join non si sa se un materiale ha una categoria, e
  // nessun passo successivo può togliere una riga dalla lista.
  // ================================================================
  // [MAT-PLANT-PAIR] `language` e' ora un'OPZIONE. Il default e' la derivazione di sempre — la
  // lingua di chi guarda, per la lista — ma chi da qui SCRIVE su Plex deve poterla fissare: la
  // descrizione letta finisce sulla part, e una part che cambia lingua a seconda del browser di chi
  // preme il pulsante e' un difetto che nessun errore segnala. Vedi `getConfiguredProducts`.
  // ================================================================
  // [MAT-SCOPE] IL PARAMETRO `details` NON C'E' PIU', E NON E' UNA SEMPLIFICAZIONE (feature 0050).
  //
  // La via veloce restituiva le righe PRIMA della lettura dell'anagrafica, cioe' prima che si
  // sapesse se un materiale ha una categoria: `ProductType` (MTART) sta su `A_Product`, non su
  // `A_ProductPlant`, e il verdetto sulla sola riga di stabilimento e' cieco per costruzione. La
  // lista era quindi un elenco di CANDIDATI, e la riclassificazione dopo la GET ne correggeva solo
  // il tipo — mai l'appartenenza. Il join non e' piu' un'opzione del chiamante: e' una proprieta'
  // di questa funzione, ed e' cio' che rende «la vera lista dei materiali» una cosa sola per la
  // dashboard, per l'invio massivo e per il job.
  //
  // NON si e' forzato `wantDetails = true` nel chiamante: il ramo veloce sarebbe rimasto qui senza
  // chiamanti, restituendo righe NON POTATE — un interruttore morto che riapre esattamente il
  // difetto che la feature chiude, il giorno che qualcuno lo ritrova e lo riusa.
  //
  // E IL COSTO E' QUASI NULLO su Integration Suite, il che va saputo o la modifica sembra un lusso:
  // la dashboard leggeva GIA' l'anagrafica dell'intero perimetro, solo dopo il primo disegno di
  // schermo e per un'altra strada (il client la chiedeva a blocchi con `productDetails`, e il primo
  // blocco legge il PLANT INTERO nella stessa voce di cache di questa lettura). Il conto verso SAP
  // non cambia; spariscono una ventina di andate e ritorni fra browser e CAP.
  // ================================================================
  async function loadConfiguredProducts({ req = null, s4 = null, refresh = false, language: languageOpt = null } = {}) {
    const startedAt = Date.now();   // [MAT-SCOPE] il budget che le due letture si dividono
    const S4Product = s4 || await productSource(); // [IS-SOURCE]
    const language = languageOpt
      || req?.headers?.['accept-language']?.substring(0, 2)?.toUpperCase() || 'EN';
    const isMode = S4Product.mode === 'IS';

    const USE_TEST_DATA_FILTER = process.env.USE_TEST_DATA_FILTER === 'true';
    const TEMP_TEST_MATERIALS = ['FG126','SG124','MZ-FG-R10','MZ-FG-R11','MZ-FG-R12','MZ-FG-R13','MZ-FG-R14','MZ-FG-C900','MZ-FG-C950','MZ-FG-C990','MZ-FG-M500','MZ-FG-M525','MZ-FG-M550','MZ-FG-R100','MZ-FG-R200','MZ-FG-R300','MZ-RM-R14-01','MZ-RM-R14-02','MZ-RM-R14-03','MZ-RM-R14-04','MZ-RM-R14-05','MZ-RM-R14-06','MZ-RM-R14-07'];
    const TEMP_TEST_PLANT = '1710';

    // STEP 1: which plants to consider. Source of truth is now ZPlant (Status='Active'),
    // maintained in the adminconfigplant dashboard. ZMatFilterConfig is no longer used here
    // (so the extra ProfitCenter/MRPType/... criteria no longer apply — all materials of each
    // active plant are considered).
    let filterConfigs;
    if (USE_TEST_DATA_FILTER) {
      filterConfigs = [{ Plant: TEMP_TEST_PLANT, _tempMaterials: TEMP_TEST_MATERIALS }];
      console.log(`>>> TEST DATA FILTER active: Plant=${TEMP_TEST_PLANT}, ${TEMP_TEST_MATERIALS.length} materials`);
    } else {
      // Active plants, optionally narrowed by the dashboard plant selector (?plants=...).
      const effectivePlants = await resolveEffectivePlants(req);
      filterConfigs = [...effectivePlants].map(code => ({ Plant: code }));
      console.log(`>>> Plants for Products: ${[...effectivePlants].join(', ') || '(none)'}`);
    }

    // STEP 1b: per-plant material category / visibility customizing (ZMatCategory).
    // Decides which materials are shown/sent and which Plex part type they get.
    // No active category for a plant => ALL its materials are taken.
    //
    // [MAT-SCOPE] Il VERDETTO della lettura viaggia accanto alla mappa: `loadCategoryConfig`
    // inghiotte l'errore e rende una mappa vuota, che e' indistinguibile da «nessun plant ha
    // categorie» — cioe' dal ramo che prende tutto e non manda nessun `type`. Con la lettura caduta
    // la lista resta piena (mostrare di piu' e' un fastidio che si vede, DEC-52) ma niente e'
    // inviabile, e il perche' si dichiara.
    const db = await cds.connect.to('db');
    const { byPlant: categoryConfig, ok: categoriesKnown } = await loadCategoryConfigOutcome(db);
    if (!categoriesKnown) {
      console.warn('>>> [MAT-SCOPE] customizing categorie NON LETTO: la lista resta piena, ma'
        + ' nessun materiale e\' inviabile finche\' la lettura non riesce');
    }

    // [MAT-SCOPE] I plant che forniscono `type` per un'altra strada: una riga di `ZPlexFieldMap`
    // con `PlexField = 'type'`. Senza questo insieme il verdetto `NO_PART_TYPE` sarebbe una
    // REGRESSIONE SECCA — quei plant possono mappare la tipologia a mano (0004 RB-17) e smetterebbero
    // di comparire in lista per intero. E' una lettura LOCALE sola per l'intera richiesta.
    const typeMappedPlants = await loadTypeMappedPlants(db);

    // STEP 2: A_ProductPlant rows per config (Plant + optional criteria).
    //
    // [PLANT-ROWS] [PLANT-PAGE] LA PAGINAZIONE NON STA PIU' QUI. Sta in srv/lib/plantRows.js,
    // con la scala delle pagine, la cache e la dichiarazione di cio' che manca (0035). Prima
    // erano due cicli — questo e quello di autoAssign.js — che a parita' di plant emettevano la
    // STESSA query e gia' divergevano: quello di la' ordinava le pagine e teneva l'esito in
    // cache, questo no. Il difetto peggiore pero' era il terzo: un plant la cui lettura cadeva a
    // meta' finiva in un `console.error`, le righe gia' arrivate restavano, e il perimetro usciva
    // CORTO — indistinguibile da «non ci sono dati», che e' l'esito che la 0013 esiste per evitare.
    //
    // I plant si leggono INSIEME. Sono letture indipendenti, ognuna gia' single-flight, e in fila
    // costavano la somma dei loro tempi dentro una richiesta che ha 120 s di tetto (approuter).
    const plantRows = [];
    const scope = { complete: true, plants: [] };   // cosa dichiarare a chi guarda la lista
    // [PLANT-ROWS] «Aggiorna» deve aggiornare. Con una cache da cinque minuti, senza questa riga
    // il tasto della dashboard rileggerebbe la cache e l'utente non avrebbe alcun modo di
    // costringere una lettura nuova — un tasto che non fa quello che dice.
    if (refresh) {
      for (const config of filterConfigs) {
        // [PRODUCT-QUERY] Due letture per plant, due cache da buttare: `A_ProductPlant` e
        // `A_Product`. Invalidarne una sola lascerebbe l'altra a cinque minuti di distanza.
        const n = invalidatePlantRows(config.Plant) + invalidatePlantReads(config.Plant);
        if (n) console.log(`>>> [PLANT-ROWS] refresh richiesto: buttate ${n} voci di cache del plant ${config.Plant}`);
      }
    }
    const perPlant = await Promise.all(filterConfigs.map(async (config) => {
      const out = { plant: config.Plant, rows: [], complete: true, readOk: true, text: '' };
      const extraFilter = {};
      if (config.ProfitCenter)    extraFilter.ProfitCenter = config.ProfitCenter;
      if (config.MRPType)         extraFilter.MRPType = config.MRPType;
      if (config.ProcurementType) extraFilter.ProcurementType = config.ProcurementType;
      if (config.PurchasingGroup) extraFilter.PurchasingGroup = config.PurchasingGroup;
      // [PLANT-ROWS] ATTENZIONE: questo filtro fornisce ENTRAMBI i campi chiave di A_ProductPlant
      // (Product, Plant), quindi su Integration Suite la lettura viene instradata sull'indirizzo
      // PER CHIAVE e risponde con UNA riga (DEC-43/44/45). Vale solo con USE_TEST_DATA_FILTER=true,
      // cioe' fuori dall'esercizio: se lo si riaccende su IS, la lista dei dati di prova arrivera'
      // quasi vuota, e non e' un difetto dei dati. Le letture d'esercizio filtrano sul solo plant.
      if (config._tempMaterials)  extraFilter.Product = { in: config._tempMaterials };
      const cats = categoryConfig.get(config.Plant) || [];
      const withNav = needsNav(cats);
      // [MULTI-CATCHALL] Piu' ripieghi attivi sullo stesso plant: la scrittura non lo permette
      // piu', ma righe salvate prima di quel controllo esistono. Va detto UNA volta per plant,
      // prima di leggere: da li' in poi ogni materiale prende il part type di uno solo dei tre,
      // e gli altri due non classificano niente.
      // [POST-GET-CLASSIFY] Le categorie di questo plant dipendono da un campo che la riga
      // product-plant non porta (MTART)? Allora la classificazione fatta qui NON e' attendibile:
      // si decide la VISIBILITA' ma non il tipo, che viene risolto dopo la lettura di A_Product.
      const typeNeedsDetails = needsProductDetails(cats);
      const catchAlls = cats.filter(c => matFlag(c.IsCatchAll)).map(c => c.CategoryName || '(senza nome)');
      if (catchAlls.length > 1) {
        console.warn(
          `>>> [MULTI-CATCHALL] Plant=${config.Plant}: ${catchAlls.length} categorie di ripiego ATTIVE `
          + `(${catchAlls.join(', ')}). Ne e' ammessa una sola: le altre non classificano nulla, `
          + 'perche\' un ripiego non ha condizioni e prende tutto cio\' che avanza. '
          + 'Vince quella in ordine alfabetico, per non dipendere dall\'ordine di lettura del database.'
        );
      }
      // [W1-26] Cosa il canale attivo NON fornisce, fra i campi che QUESTE categorie usano.
      // Non piu' `withNav`: le due cose coincidevano finche' SOBSL/FEVOR erano insieme «da
      // espandere» e «non disponibili su IS». Ora su IS arrivano dai campi portanti, quindi
      // `withNav` direbbe ancora «attenzione» su un perimetro valutato per intero.
      const missingFields = isMode ? fieldsUsedBy(cats, UNAVAILABLE_IN_IS) : [];
      let count = 0, kept = 0, viaCatchAll = 0;
      // [MAT-VIS-UNEVAL] Quanti materiali questa passata NON HA POTUTO DECIDERE, perche' le
      // categorie del plant dipendono da un campo che A_ProductPlant non porta, e quale campo e'.
      let viaUnevaluable = 0;
      let blindFields = [];
      try {
        // [PLANT-ROWS] Il perimetro del plant: paginato, ordinato, in cache. Le colonne sono le
        // stesse di prima (`productPlantColumns` col canale attivo), quindi questa lettura e
        // quella dell'auto-assegnazione sono la STESSA voce di cache invece di due letture.
        const read = await loadPlantRowsOutcome(S4Product, config.Plant, { withNav, filter: extraFilter });
        out.readOk = read.readOk;
        out.complete = read.complete;
        out.text = read.text;
        // Apply the per-plant visibility filter. Keep the resolved Plex part type on the row so
        // the dashboard can display it (send re-resolves it independently).
        for (const pp of read.byProduct.values()) {
          count++;
          // [PLANT-ROWS] LA RIGA SI COPIA PRIMA DI ANNOTARLA. Ora quelle righe stanno in cache e
          // sono le stesse che vede l'auto-assegnazione: scriverci sopra `PlexPartType` farebbe
          // uscire da una scheda il tipo deciso con le categorie di un'altra lettura.
          const r = { ...pp };
          if (cats.length === 0) { out.rows.push(r); kept++; continue; }
          // [W1-26] Il canale va passato: su IS SOBSL e FEVOR escono dai campi portanti,
          // in ONPREM dalle navigazioni espanse. Senza, si prende sempre il ramo ONPREM.
          const { visible, plexPartType, catchAll, unevaluable } =
            classifyMaterial(extractSapFields(r, S4Product.mode), cats);
          if (visible) {
            // [POST-GET-CLASSIFY] `null` significa «non ancora determinabile», non «nessuno»:
            // meglio una colonna vuota di un tipo sbagliato. Lo riempie la riclassificazione
            // dopo la GET, qui sotto o in productDetails.
            r.PlexPartType = typeNeedsDetails ? null : plexPartType;
            r.__typePending = typeNeedsDetails || undefined;
            out.rows.push(r); kept++;
            if (catchAll) viaCatchAll++; // [W1-01] quanti sono entrati dal ripiego
            // [MAT-VIS-UNEVAL] Entrato perche' il criterio non era verificabile, non perche' lo
            // soddisfa: e' un CANDIDATO, non il perimetro. Scartarlo QUI sarebbe una sparizione
            // decisa su un dato che questa passata non ha; il verdetto lo prende la potatura
            // [MAT-SCOPE], dopo la lettura di A_Product, dove MTART c'e'.
            if (unevaluable) { viaUnevaluable++; blindFields = unevaluable; }
          }
        }
        // [W1-01] Il ripiego si DICHIARA: senza il conteggio, un perimetro allargato dal
        // ripiego e uno allargato per errore di configurazione hanno lo stesso aspetto.
        // `count` sono ora i MATERIALI del plant, non le righe lette: il lettore le deduplica, e
        // il conteggio grezzo — con quante pagine e quanti duplicati — sta nella sua riga di log.
        console.log(`>>> Config Plant=${config.Plant}: ${count} product-plant materials, ${kept} kept after category filter`
          + (viaCatchAll > 0 ? ` (di cui ${viaCatchAll} dalla categoria di ripiego)` : '')
          + (viaUnevaluable > 0 ? ` (di cui ${viaUnevaluable} per criterio NON VALUTABILE)` : ''));

        // [MAT-VIS-UNEVAL] SI DICHIARA, E NON SI ALLARMA: era un `console.warn` che accusava una
        // configurazione CORRETTA. Il testo di allora — «N materiali restano visibili SENZA part
        // type invece di sparire», con il consiglio di riscrivere le condizioni su campi della riga
        // product-plant o di aggiungere un ripiego — descriveva il mondo PRIMA della 0050, quando
        // il verdetto cieco era finale. Oggi non lo e': questa passata e' una SOVRA-approssimazione
        // voluta (la premessa su cui poggia tutta la feature, vedi classifyMaterial), e il perimetro
        // lo decide la potatura [MAT-SCOPE] poco piu' sotto, dove MTART c'e'.
        //
        // I due rimedi che suggeriva sono anzi diventati consigli SBAGLIATI: togliere MTART dalle
        // condizioni e' una regressione — e' il campo giusto, e al momento del verdetto e'
        // disponibile — e un `IsCatchAll` e' una decisione di perimetro vera, per giunta quella che
        // [POST-GET-CLASSIFY] segnala come pericolosa (il ripiego intercetta il materiale PRIMA di
        // questo ramo, e un ZPF esce come Component).
        //
        // Resta una riga, e resta il NOME DEL CAMPO: e' l'unico posto che dice QUALE condizione e'
        // cieca. L'unico caso in cui quei materiali restano davvero in lista senza tipologia e'
        // l'anagrafica non letta, e la conta [MAT-SCOPE] a parte («trattenuti»).
        if (viaUnevaluable > 0) {
          console.log(
            `>>> [MAT-VIS-UNEVAL] Plant=${config.Plant}: ${viaUnevaluable} materiali NON DECIDIBILI `
            + `in questa passata — le categorie usano ${blindFields.join('/')}, che A_ProductPlant `
            + 'non porta (MTART sta su A_Product). Restano CANDIDATI senza tipologia; il perimetro '
            + 'vero lo decide la potatura dopo la lettura dell\'anagrafica: vedi [MAT-SCOPE].'
          );
        }
        // [IS-SOURCE] M-03: il perimetro è stato valutato con informazioni incomplete. Va
        // detto qui, una volta per plant, non per materiale (FR-19, FR-23).
        // [W1-26] Si dichiarano i campi EFFETTIVAMENTE mancanti e usati da queste categorie:
        // con UNAVAILABLE_IN_IS vuoto l'avviso tace da sé, e il giorno che tornasse a
        // riempirsi nomina il campo giusto invece dell'elenco intero.
        if (missingFields.length) {
          console.warn(
            `>>> [IS-SOURCE] Plant=${config.Plant}: le categorie usano ${missingFields.join('/')}, ` +
            'informazioni NON fornite dal canale attivo per l\'area materiali: quelle condizioni non sono ' +
            'valutabili, quindi non sono soddisfatte e i materiali che ne dipendono restano fuori perimetro (FR-17/FR-18)'
          );
        }
      } catch (error) {
        // Il lettore non lancia per una pagina caduta: se si arriva qui e' successo qualcos'altro
        // (la sorgente non si e' connessa, il modello non ha l'entity). Resta un perimetro
        // INCOMPLETO, e come tale va dichiarato — non solo scritto in console.
        out.readOk = false;
        out.complete = false;
        out.text = `lettura fallita: ${error.message}`;
        console.error(`>>> ERROR querying A_ProductPlant for Plant=${config.Plant}:`, error.message);
      }
      return out;
    }));

    // L'ordine e' quello dei plant configurati, non quello in cui hanno risposto.
    for (const p of perPlant) {
      plantRows.push(...p.rows);
      scope.plants.push({ plant: p.plant, readOk: p.readOk, complete: p.complete, text: p.text });
      if (!p.complete) scope.complete = false;
    }
    if (!scope.complete) {
      scope.text = scope.plants.filter(p => !p.complete).map(p => `${p.plant}: ${p.text}`).join(' | ');
      console.warn(`>>> [PLANT-ROWS] PERIMETRO INCOMPLETO — ${scope.text}`);
    }

    // [MAT-SCOPE] I CANDIDATI, non ancora il perimetro: la potatura piu' sotto li restringe.
    const candidateProducts = [...new Set(plantRows.map(r => r.Product))];
    console.log(`>>> [MAT-SCOPE] ${candidateProducts.length} materiali candidati (verdetto cieco);`
      + ' il perimetro vero si decide dopo la lettura dell\'anagrafica');

    // STEP 4: dettagli materiale.
    // [IS-SOURCE] (M2/M3) La modalità decide la FORMA, non il contenuto:
    //   ONPREM -> batch da 150 con $expand to_Description e il $filter del client spinto,
    //             cioè la query di oggi, invariata (TD-5);
    //   IS     -> [PRODUCT-QUERY] UNA lettura paginata per plant su A_Product (feature 0040), con
    //             la descrizione dentro la riga. Erano N letture per chiave più N su
    //             A_ProductDescription, e il $filter del client resta applicato A VALLE dal
    //             chiamante (READ Products), perché su questo canale non è spingibile.
    const clientWhere = isMode ? null : (req?.query?.SELECT?.where || null);
    // ================================================================
    // [MAT-SCOPE] LE DUE LETTURE SI DIVIDONO UN BUDGET, e non ne hanno una ciascuna.
    //
    // Erano una lettura paginata dentro la richiesta (scadenza 90 s, `DEADLINE_DEFAULT_MS`) piu'
    // una asincrona fatta dal browser; ora sono DUE IN SEQUENZA dentro la stessa richiesta, e
    // 90 + 90 non stanno sotto i 120 s dell'approuter. Alla seconda si passa il residuo.
    //
    // TRAPPOLA: `deadlineMs: 0` significa «NESSUNA scadenza» — e' il valore che usano i job, dove
    // la scadenza dell'approuter non esiste. Un residuo esaurito passato come `0` toglierebbe la
    // difesa proprio quando serve, quindi il minimo e' esplicito e non nullo.
    // ================================================================
    const spentMs = Date.now() - startedAt;
    const detailBudgetMs = Math.max(DETAIL_MIN_BUDGET_MS, REQUEST_BUDGET_MS - spentMs);
    if (spentMs > REQUEST_BUDGET_MS - DETAIL_MIN_BUDGET_MS) {
      console.warn(`>>> [MAT-SCOPE] il perimetro ha consumato ${spentMs} ms: all'anagrafica`
        + ` restano ${detailBudgetMs} ms (minimo), la lettura puo' uscire incompleta`);
    }
    // [MAT-SCOPE] `scope` serviva gia' — lo conserva `productRows.js` per `productScope` — ma qui
    // non veniva raccolto: e' il verdetto PER PLANT della lettura anagrafica, e senza di esso
    // «anagrafica non letta» diventerebbe un giudizio globale. Nome diverso da `scope`, che in
    // questa funzione e' il perimetro.
    const { byProduct, failed, scope: detailScope } = await fetchProductsForPlants(S4Product, candidateProducts, {
      plants: filterConfigs.map(c => c.Plant),
      columns: PRODUCT_SELECT,
      onpremColumns: '*',
      language,
      chunkSize: 150,
      clientWhere,
      deadlineMs: detailBudgetMs
    });
    // [PRODUCT-QUERY] Una lettura anagrafica incompleta ACCORCIA LA LISTA, perché un materiale
    // assente da `productMap` viene escluso dalla riga qui sotto: va quindi nello stesso `scope`
    // del perimetro, che è ciò che questa funzione dichiara a chi la chiama. Quello che il cockpit
    // mostra sopra la tabella è invece l'action `productScope`, che NON legge questo oggetto ma i
    // verdetti conservati dai due lettori — ed è là che la lettura anagrafica è stata aggiunta.
    for (const f of failed) {
      console.error(`>>> ERROR querying ${f.key}: ${f.message}`);
      scope.complete = false;
      scope.plants.push({ plant: '', readOk: false, complete: false, text: `${f.key}: ${f.message}` });
    }
    if (!scope.complete) {
      scope.text = scope.plants.filter(p => !p.complete)
        .map(p => `${p.plant ? `${p.plant}: ` : ''}${p.text}`).join(' | ');
      console.warn(`>>> [PLANT-ROWS] PERIMETRO INCOMPLETO — ${scope.text}`);
    }

    const productMap = new Map();
    for (const [product, row] of byProduct) productMap.set(product, detailRowOf(row));
    console.log(`>>> Retrieved data for ${productMap.size} products (of ${candidateProducts.length})`);

    // ================================================================
    // [MAT-SCOPE] IL PERIMETRO SI DECIDE QUI, ED E' UNA POTATURA — non piu' una riassegnazione del
    // solo tipo (feature 0050).
    //
    // Qui `A_Product` e' stato letto e MTART c'e': e' l'unico momento in cui la domanda «questo
    // materiale ha una categoria?» ha una risposta. Prima, il ciclo scriveva
    // `r.PlexPartType = classifyMaterial(merged, cats).plexPartType || null` e buttava `visible`:
    // un materiale che nessuna categoria aggancia usciva `{visible: false, plexPartType: null}`, e
    // quel `null` diventava la COLONNA VUOTA in dashboard — riga in lista, riga nell'invio massivo,
    // e `HTTP 400` da Plex perche' il corpo non porta `type`.
    //
    // TRE COSE CHE L'INNESTO OVVIO SBAGLIA:
    //
    // 1. SI GIRA SU OGNI RIGA, non piu' sulle sole `__typePending`. Quella guardia salta i plant le
    //    cui categorie non usano MTART — ed e' esattamente dove vive il caso «categoria senza
    //    tipologia», che di MTART non ha alcun bisogno: quelle righe non verrebbero MAI potate.
    //
    // 2. «DETTAGLIO ASSENTE» HA DUE CAUSE, E UNA SOLA E' UN'ANOMALIA. Con la lettura RIUSCITA
    //    l'assenza significa «il materiale non ha una riga A_Product», oppure — in ONPREM — «il
    //    `$filter` del client l'ha scartato», perche' li' il criterio viene SPINTO su `A_Product`.
    //    Quello e' il comportamento di sempre (nessun dettaglio, nessuna riga in lista) e non si
    //    conta: contarlo riempirebbe la dichiarazione di centinaia di «anagrafica non letta» a ogni
    //    ricerca dell'utente. Solo con la lettura CADUTA l'assenza e' `DETAIL_UNKNOWN`.
    //
    // 3. LA POTATURA NON DEGRADA `scope`. Un materiale fuori perimetro non e' una lettura
    //    incompleta: confonderli farebbe dire a `productScope` «perimetro incompleto» a ogni
    //    categoria mal configurata, cioe' renderebbe muto proprio l'avviso che serve.
    // ================================================================
    // [MAT-SCOPE] Il verdetto della lettura anagrafica, PER PLANT dove esiste.
    //
    // Sul canale IS `fetchProductsForPlants` legge per plant e conserva un verdetto per ciascuno:
    // con la lettura di UN plant caduta, prendere il `failed` globale terrebbe indietro anche i
    // materiali dei plant letti benissimo, dichiarandoli «non si sa». In ONPREM la lettura e' per
    // CHIAVE su tutti i plant insieme (`fetchProductsByKey`, che non rende `scope`): la' un
    // fallimento non e' attribuibile a un plant, e il verdetto globale e' l'unico onesto.
    const detailOkByPlant = new Map();
    for (const s of (detailScope || [])) {
      if (s && s.plant) detailOkByPlant.set(s.plant, s.readOk !== false && s.complete !== false);
    }
    const anagraficaOkGlobale = failed.length === 0;
    const anagraficaOkDi = (plant) => (detailOkByPlant.has(plant)
      ? detailOkByPlant.get(plant)
      : anagraficaOkGlobale);

    const tallies = new Map();   // plant -> conteggi da dichiarare
    const inScopeRows = [];
    for (const r of plantRows) {
      const plant = r.Plant;
      const cats = categoryConfig.get(plant) || [];
      if (!tallies.has(plant)) tallies.set(plant, matScope.newTally());
      const acc = tallies.get(plant);
      const detail = productMap.get(r.Product);

      // Punto 2 qui sopra: assenza benigna. La riga non entra in lista — come oggi, e' il merge a
      // scartarla poco piu' avanti — e non si conta come potatura.
      if (!detail && anagraficaOkDi(plant)) { continue; }

      const v = matScope.finalScope({
        sapFields: mergeProductFields(extractSapFields(r, S4Product.mode), detail),
        detailKnown: !!detail,
        categories: cats,
        categoriesKnown,
        typeAvailable: typeMappedPlants.has(plant)
      });
      matScope.tally(acc, v.reason, v.listable);
      if (!v.listable) continue;
      r.PlexPartType = v.plexPartType;
      r.__sendable = v.sendable;   // [MAT-SCOPE] lo legge `getConfiguredProducts`, non la READ
      delete r.__typePending;
      inScopeRows.push(r);
    }
    plantRows.length = 0;
    plantRows.push(...inScopeRows);

    // [MAT-SCOPE] La potatura SI DICHIARA, per plant. Senza, quando svuota la lista si arriva a
    // `if (plantRows.length === 0) return []` in READ Products e l'unica traccia e' una riga di
    // console: la sparizione silenziosa che il progetto vieta. Il verdetto si conserva accanto a
    // quelli dei due lettori, ed e' `productScope` a rileggerlo.
    for (const [plant, acc] of tallies) {
      const perConfig = matScope.prunedByConfig(acc);
      const perIgnoto = matScope.prunedByUnknown(acc);
      const senzaTipo = matScope.untypedCategories(categoryConfig.get(plant) || []);
      // Si conserva SEMPRE, anche a potatura zero: `productScope` distingue «mai valutato» da
      // «valutato, niente da dichiarare», e un plant assente dalla mappa e' il primo caso.
      rememberScopeVerdict(plant, acc, senzaTipo);
      if (perConfig === 0 && perIgnoto === 0) continue;
      console.warn(`>>> [MAT-SCOPE] Plant=${plant}: ${acc.kept} materiali in perimetro su ${acc.total}`
        + ` — ${acc[matScope.SCOPE.NO_CATEGORY_MATCH]} senza categoria,`
        + ` ${acc[matScope.SCOPE.NO_PART_TYPE]} con una categoria che non assegna la tipologia,`
        + ` ${acc[matScope.SCOPE.DETAIL_UNKNOWN]} trattenuti (anagrafica non letta),`
        + ` ${acc[matScope.SCOPE.CATEGORIES_UNKNOWN]} trattenuti (customizing non letto)`);
      if (acc[matScope.SCOPE.NO_PART_TYPE] > 0 && senzaTipo.length) {
        // Si NOMINA la riga, non si conta: `classifyMaterial` prende la PRIMA categoria che
        // aggancia per `Sequence`, quindi una senza tipologia in testa OMBREGGIA tutte le
        // successive e il ripiego. Il rimedio e' quella riga, e un numero manderebbe a cercare
        // nei materiali.
        console.warn(`>>> [MAT-SCOPE] Plant=${plant}: categorie ATTIVE senza tipologia Plex —`
          + ` ${senzaTipo.join(', ')}. Finche' restano cosi', i materiali che agganciano non`
          + ' entrano in perimetro.');
      }
    }

    // [MAT-SCOPE] Si RICALCOLA dopo la potatura. Era calcolato prima del join e restava un
    // soprainsieme delle righe restituite: chi lo usa come perimetro (la lettura dello storico in
    // READ Products) leggerebbe per materiali che non sono piu' in lista.
    const uniqueProducts = [...new Set(plantRows.map(r => r.Product))];
    console.log(`>>> [MAT-SCOPE] perimetro finale: ${plantRows.length} righe,`
      + ` ${uniqueProducts.length} materiali (candidati: ${candidateProducts.length})`);

    return { plantRows, uniqueProducts, productMap, scope };
  }

  // ================================================================
  // [WC-SUBTRACT] I quattro helper della Plex Data Source API stanno nello scope CONDIVISO
  // dell'impl, e non dentro un `if (this.name === ...)`, perché hanno DUE servizi che li usano:
  // `removeExcessWorkcenters` la chiama ProductionRouting (rimozione dei work center in eccesso
  // dal ciclo, DEC-78) e `executePlexDataSource` la chiama anche PlexService (uploadPartAttribute).
  //
  // NON RIPORTARLI DENTRO UN BLOCCO DI SERVIZIO. Una `function` dichiarata in un blocco è visibile
  // in QUEL blocco: l'impl gira una volta per servizio, quindi mentre gira quello di
  // ProductionRouting il blocco di PlexService non viene eseguito e il nome resta `undefined` —
  // `TypeError: removeExcessWorkcenters is not a function` alla prima riga in eccesso da rimuovere,
  // cioè al primo uso vero della sottrazione.
  // ================================================================
  // ----------------------------------------------------------------
  // Plex Data Source API helper
  // NOTE: Data Sources do NOT live on the Connect host (*.connect.plex.com)
  // used by the MDM calls — that host returns 404 RESOURCE_NOT_FOUND for
  // /api/datasources. They live on the tenant host (*.on.plex.com).
  // Auth is HTTP Basic with a dedicated web-service account (NOT the Connect
  // API key, which this endpoint ignores and returns 419 for).
  // [PLEX-CONN] Host + credenziali Basic vengono dalla connessione DEL PLANT
  // (ZPlexConnConfig: DataSourceUrl/User/Password). Nessun fallback su env né su un tenant di
  // default: la riga di customizing è l'unica fonte (feature 0020).
  // POST {DS_BASE}/api/datasources/{id}/execute?format=2  body: { inputs: {...} }
  // ----------------------------------------------------------------
  async function executePlexDataSource(req, plant, dataSourceId, inputs) {
    const { dataSourceUrl, dataSourceUser, dataSourcePassword } = await loadPlexConnection(req, plant);
    console.log(`>>> Executing Plex Data Source ${dataSourceId} (plant: ${plant})`);

    const url = `${dataSourceUrl}/api/datasources/${dataSourceId}/execute?format=2`;
    const basicAuth = 'Basic ' + Buffer.from(`${dataSourceUser}:${dataSourcePassword}`).toString('base64');
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': basicAuth
    };
    // Data Source execute (format=2) expects the input parameters at the TOP LEVEL of the
    // body (e.g. { "Part_No": "..." }), NOT wrapped in an { inputs: {...} } object.
    const requestBody = inputs || {};
    console.log(`>>> [PLEX DS] POST ${url}`, JSON.stringify(requestBody));

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    console.log(`>>> [PLEX DS] Response status ${response.status}`);

    return { ok: response.ok, status: response.status, body };
  }

  /**
   * Le righe di una risposta Data Source `?format=2`. Gemella di `dsRows` in
   * srv/jobs/createPlexProductionOrders.js: la duplicazione e' quella dichiarata fra server e job,
   * che non condividono modulo.
   */
  function dsRows(body) {
    if (!body) return [];
    if (Array.isArray(body)) return body;
    if (Array.isArray(body.rows)) return body.rows;
    return [];
  }

  /**
   * [WC-SUBTRACT] Una chiave INTERA di Plex, da una Data Source di lettura.
   *
   * TRE ESITI E NON DUE, ed e' il punto della funzione: `NONE` e' «non c'e'», `AMBIGUOUS` e' «piu'
   * di una». Su una lettura che alimentava un altro READ prendere la prima riga era un rischio di
   * un dato in piu'; qui alimenta una CANCELLAZIONE, quindi si rifiuta (DEC-70). E l'input vuoto
   * non si manda: `Workcenter_Code` sulla 11835 non e' obbligatorio, e una chiamata in bianco
   * restituirebbe l'elenco intero.
   *
   * @returns {{state: 'OK'|'NONE'|'AMBIGUOUS'|'ERROR', value: number|null}}
   */
  async function readPlexKey(req, plant, dataSourceId, inputs, column) {
    for (const [name, value] of Object.entries(inputs)) {
      if (value === null || value === undefined || String(value).trim() === '') {
        console.warn(`>>> [WC-SUBTRACT] DS ${dataSourceId}: input ${name} vuoto, chiamata non inviata`);
        return { state: 'NONE', value: null };
      }
    }
    const res = await executePlexDataSource(req, plant, dataSourceId, inputs);
    if (!res.ok) {
      console.warn(`>>> [WC-SUBTRACT] DS ${dataSourceId} HTTP ${res.status}`);
      return { state: 'ERROR', value: null };
    }
    return approvedWcRules.singleKey(dsRows(res.body), column);
  }

  /**
   * [WC-SUBTRACT] Porta via da Plex le assegnazioni in eccesso, tramite la Data Source 755.
   *
   * LA CATENA. La 755 pretende tre `int` e la Connect API non ne restituisce nessuno, quindi ogni
   * riga in eccesso va tradotta: `Part_No`(+`Revision`) -> `Part_Key` (DS 1786),
   * (`Operation_Code`, `Part_Key`) -> `Part_Operation_Key` (DS 29200), `Workcenter_Code` ->
   * `Workcenter_Key` (DS 11835). Tutti gli input vengono dalla riga che la GET ha restituito: cio'
   * che si cancella e' identificato da CIO' CHE PLEX HA DETTO, non dalla nostra riga locale.
   *
   * LE CACHE sono per invio e non globali: `Part_Key` una volta sola (la part e' una),
   * `Workcenter_Key` per codice, `Part_Operation_Key` per codice operazione. Servono a non ripetere
   * la stessa lettura su piu' righe in eccesso, non a evitare di rileggere fra un invio e l'altro —
   * qui si SCRIVE, e una chiave stantia colpirebbe l'oggetto di un altro.
   *
   * L'INTERRUTTORE SI GUARDA PRIMA DI TUTTO: a `0` non parte nemmeno la risoluzione delle chiavi.
   * Il rilevamento e' gia' avvenuto e resta dichiarato (DEC-71).
   *
   * @param {object} req
   * @param {string} plant
   * @param {Array<object>} excess righe di `wcDiff.excess`
   * @param {number} dataSourceId `0` = non scrivere
   * @param {object} syncLog
   * @param {(reason: string) => void} onNotRemoved
   * @param {() => void} onRemoved
   */
  async function removeExcessWorkcenters(req, plant, excess, dataSourceId, syncLog, onNotRemoved, onRemoved) {
    const R = approvedWcRules.WC_NOT_REMOVED;

    if (!dataSourceId) {
      console.warn(`>>> [WC-SUBTRACT] ${excess.length} assegnazioni in eccesso su Plex: rimozione `
        + 'disattivata (PLEX_DS_APPROVED_WC_DELETE=0)');
      for (const ex of excess) {
        syncLog.workcenters.push({ code: ex.workcenterCode, opId: ex.PlexOperationId, result: 'EXCESS_NOT_REMOVED', reason: R.DS_DISABLED });
        onNotRemoved(R.DS_DISABLED);
      }
      return;
    }

    const partKeyByNo = new Map();
    const partOpKeyByCode = new Map();
    const wcKeyByCode = new Map();
    /** Risolve una chiave una volta sola per valore d'ingresso, cache negativa compresa. */
    const cached = async (cache, cacheKey, run) => {
      if (cache.has(cacheKey)) return cache.get(cacheKey);
      const out = await run();
      cache.set(cacheKey, out);
      return out;
    };

    for (const ex of excess) {
      const logRow = { code: ex.workcenterCode, opId: ex.PlexOperationId, wcId: ex.workcenterId };
      try {
        const partKey = await cached(partKeyByNo, `${ex.partNo}|${ex.partRevision}`, () =>
          readPlexKey(req, plant, plexDataSources.DS_PART_KEY,
            // `Revision` e' opzionale sulla 1786: si manda solo se la riga remota la porta, e NON
            // si ritenta senza — una chiave piu' permissiva puo' agganciare un'altra revisione.
            ex.partRevision ? { Part_No: ex.partNo, Revision: ex.partRevision } : { Part_No: ex.partNo },
            'Part_Key'));

        const partOpKey = partKey.state === 'OK'
          ? await cached(partOpKeyByCode, `${partKey.value}|${ex.operationCode}`, () =>
            readPlexKey(req, plant, plexDataSources.DS_PART_OPERATION_KEY,
              { Operation_Code: ex.operationCode, Part_Key: partKey.value },
              // La 29200 restituisce anche `Operation_Key`: serve la seconda colonna.
              'Part_Operation_Key'))
          : { state: 'NONE', value: null };

        const wcKeyRes = await cached(wcKeyByCode, ex.workcenterCode, () =>
          readPlexKey(req, plant, plexDataSources.DS_WORKCENTER_KEY,
            { Workcenter_Code: ex.workcenterCode }, 'Workcenter_Key'));

        const states = [partKey.state, partOpKey.state, wcKeyRes.state];
        if (states.includes('AMBIGUOUS')) {
          // Piu' di una chiave: si rifiuta. Cancellare con quella sbagliata colpisce l'oggetto di
          // un altro, e nessuna delle due e' piu' probabile dell'altra.
          console.warn(`>>> [WC-SUBTRACT] chiave ambigua per ${ex.workcenterCode} su ${ex.operationCode}: non rimosso`);
          syncLog.workcenters.push({ ...logRow, result: 'EXCESS_NOT_REMOVED', reason: R.KEY_AMBIGUOUS });
          onNotRemoved(R.KEY_AMBIGUOUS);
          continue;
        }
        if (states.some((s) => s !== 'OK')) {
          console.warn(`>>> [WC-SUBTRACT] chiavi non risolte per ${ex.workcenterCode} su ${ex.operationCode} `
            + `(part=${partKey.state}, partOp=${partOpKey.state}, wc=${wcKeyRes.state}): non rimosso`);
          syncLog.workcenters.push({ ...logRow, result: 'EXCESS_NOT_REMOVED', reason: R.KEY_UNRESOLVED });
          onNotRemoved(R.KEY_UNRESOLVED);
          continue;
        }

        const inputs = approvedWcRules.buildApprovedWcDeleteInputs({
          partKey: partKey.value,
          partOperationKey: partOpKey.value,
          workcenterKey: wcKeyRes.value
        });
        const res = await executePlexDataSource(req, plant, dataSourceId, inputs);
        if (res.ok) {
          // Il `Return` della 755 non e' documentato, quindi un `200` che non ha fatto niente e'
          // indistinguibile da uno che ha rimosso: l'oracolo e' la GET dell'invio SUCCESSIVO.
          console.log(`>>> [WC-SUBTRACT] rimosso ${ex.workcenterCode} da ${ex.operationCode}`);
          syncLog.workcenters.push({ ...logRow, result: 'REMOVED', status: res.status, keys: inputs });
          onRemoved();
        } else {
          console.warn(`>>> [WC-SUBTRACT] DS ${dataSourceId} HTTP ${res.status} su ${ex.workcenterCode}`);
          syncLog.workcenters.push({ ...logRow, result: 'EXCESS_NOT_REMOVED', reason: R.REMOVE_FAILED, status: res.status });
          syncLog.errors.push({ step: 'WC_REMOVE', code: ex.workcenterCode, status: res.status, error: typeof res.body === 'string' ? res.body : JSON.stringify(res.body) });
          onNotRemoved(R.REMOVE_FAILED);
        }
      } catch (err) {
        console.error(`>>> [WC-SUBTRACT] rimozione di ${ex.workcenterCode} non riuscita: ${err.message}`);
        syncLog.workcenters.push({ ...logRow, result: 'EXCESS_NOT_REMOVED', reason: R.REMOVE_FAILED, error: err.message });
        syncLog.errors.push({ step: 'WC_REMOVE', code: ex.workcenterCode, error: err.message });
        onNotRemoved(R.REMOVE_FAILED);
      }
    }
  }

  // ================================================================
  // PRODUCT SERVICE - SAP S/4HANA Product API integration
  // Handles: /products/Products (OData endpoint)
  // Source:  OP_API_PRODUCT_SRV_0001 (external OData v2 API)
  // UI:     DashboardNavigation.view.xml -> productsTable
  // ================================================================
  if (this.name === 'Product') {

    // [IS-SOURCE] Sorgente dell'area materiali (feature 0013): espone `entities` e
    // `run(query)` come un servizio remoto, ma instrada ogni lettura sul service root del
    // canale attivo (Integration Suite per default, gateway on-premise con
    // PRODUCT_SOURCE=ONPREM). Le credenziali della entry base restano in
    // package.json > cds.requires.OP_API_PRODUCT_SRV_0001, gli indirizzi iFlow nel suo
    // blocco `isSource`.
    this.S4Product = await productSource();

    // READ handler for /products/Products
    // NEW LOGIC: Returns ONE ROW per (Product, Plant) combination
    // Flow: UI -> this handler -> ZMatFilterConfig (local DB) -> A_ProductPlant (API query)
    //       -> A_Product (API fetch) -> Merge data -> one row per (Product, Plant)
    this.on('READ', 'Products', async (req) => {
      console.log(">>> READ Products - one row per (Product, Plant) combination");

      // ================================================================
      // [KEY-READ] L'IDENTITA' della lettura, che NON e' il filtro del client (feature 0041).
      //
      // Su una lettura per chiave — `Products(Product='X',Plant='07')`, cioe' il ripiego del
      // dettaglio materiale dopo un F5 — CAP mette il predicato in `SELECT.from.ref[0].where` e
      // lascia `SELECT.where` a `undefined`. Questo handler leggeva solo il secondo: non vedeva
      // criteri, restituiva la prima pagina del perimetro, e CAP ne serviva `result[0]`. La
      // scheda mostrava un altro materiale su un altro plant, e «Invia a Plex» ci scriveva.
      //
      // Resta una variabile SEPARATA da `clientFilter` qui sotto, e non e' ridondanza: quello e'
      // un criterio del client da SPINGERE verso SAP (e in ONPREM viene forzato a `empty` di
      // proposito), questo e' l'identita' della riga chiesta e si applica su ENTRAMBI i canali.
      // Il `where` NON si tocca: piu' sotto, in ONPREM, viene spinto su `A_Product`, che non ha
      // l'elemento `Plant` — copiarci dentro il key predicate romperebbe la lettura dei dettagli.
      // ================================================================
      const keyRead = keyReadRules.keyReadOf(req.query, ['Product', 'Plant']);

      // ================================================================
      // [IS-SOURCE] (M3) Il $filter del client: in ONPREM resta spinto su A_Product come
      // oggi; in IS non è spingibile (A_Product ha il solo _GET per chiave) e si applica a
      // valle, sulle righe già unite, dove `Plant` esiste. Un criterio che non si può
      // riprodurre a valle NON viene soddisfatto a metà: la richiesta è respinta (FR-13).
      // ================================================================
      const clientFilter = this.S4Product.mode === 'IS'
        ? isQueryShape.classifyClientFilter(req.query?.SELECT?.where, ['Product', 'Plant'])
        : { kind: 'empty', fields: [], terms: [], equals: {} };
      if (clientFilter.kind === 'unsupported') {
        return req.reject(400,
          'Criterio di ricerca non supportato dalla sorgente materiali attiva: la richiesta non è stata ' +
          'eseguita per non restituire un risultato solo parzialmente filtrato'
        );
      }

      // ================================================================
      // [MAT-SCOPE] QUI C'ERA LA SCELTA FRA VIA VELOCE E VIA LENTA ([FAST-LIST], 0013 RB-16c),
      // e dalla 0050 non c'è più: la via è una sola, quella che passa dal join.
      //
      // La via veloce restituiva le righe PRIMA di leggere l'anagrafica, cioè prima che si sapesse
      // se un materiale ha una categoria — `ProductType` (MTART) sta su `A_Product`. Era quindi un
      // elenco di CANDIDATI presentato come la lista, e nessun passo successivo poteva toglierne
      // una riga: `productDetails` riempie celle, non cancella righe. Le due proprietà che reggevano
      // quel disegno restano vere e non bastano più.
      //
      // Il costo su Integration Suite è quasi nullo, ed è il punto che va saputo prima di
      // «riottimizzare»: l'anagrafica dell'intero perimetro veniva letta comunque, solo dopo il
      // primo disegno di schermo e per un'altra strada — il client la chiedeva a blocchi, e il primo
      // blocco legge il PLANT INTERO nella stessa voce di cache. Vedi il blocco in testa a
      // `loadConfiguredProducts`.
      // ================================================================

      // STEP 1-5: configured plants -> A_ProductPlant rows + A_Product data (batched).
      // Shared with the Send-all-to-Plex flow so both cover the same configured set.
      const { plantRows, uniqueProducts, productMap, scope } = await loadConfiguredProducts({
        req, s4: this.S4Product, refresh: wantsFreshRead(req)
      });
      // [PLANT-ROWS] Il verdetto della lettura non si tiene qui — sarebbe uno stato del SERVIZIO,
      // condiviso fra utenti che guardano plant diversi. Lo conserva il lettore, per plant, ed e'
      // `productScope` a rileggerlo: una READ non puo' rispondere altro che righe.
      if (scope && !scope.complete) console.warn(`>>> [PLANT-ROWS] lista materiali servita su un ${scope.text}`);
      if (plantRows.length === 0) {
        console.log(">>> No product-plant combinations match the filters");
        return [];
      }
      console.log(`>>> Total product-plant rows: ${plantRows.length}`);

      // ----------------------------------------------------------------
      // STEP 5.5: la riga di storico che riassume ogni coppia (LEFT OUTER JOIN)
      //
      // [LAST-LOG-WORST-DAY] Si legge `ZMatExcLogPOS` e non piu' la testata `ZMatExcLogHDR`
      // (feature 0049). La testata tiene UNA riga — l'ultima scritta — e «il peggiore del giorno
      // piu' recente» non e' esprimibile su una riga sola: un `MAT_SYNC` in errore alle 03:00 e un
      // reinvio riuscito alle 10:00 lasciavano questa colonna VERDE. Il verdetto e' puro
      // (srv/lib/lastLogRules.js), la lettura sta in un punto solo per tutte e tre le liste
      // (srv/lib/lastLog.js) e le colonne che chiede sono leggere: `ZMatExcLogPOS` porta anche
      // `RequestJson`/`ResponseJson` come `LargeString`.
      // ----------------------------------------------------------------
      const db = await cds.connect.to('db');
      // [MAT-LOG-PLANT] La chiave e' (Product, Plant), non il solo materiale (feature 0031). Un
      // materiale in perimetro su due plant e' DUE oggetti da inviare, con due esiti: con la chiave
      // sul solo materiale la lista mostrava su entrambe le righe l'esito dell'ultimo plant
      // inviato — un dato sbagliato che sembrava giusto. `Plant` ha `default ''`, quindi le righe
      // storiche si agganciano alla coppia a plant vuoto e a nessun'altra.
      const matLogKey = (r) => `${r.Product}|${r.Plant || ''}`;
      const pickedLogs = await lastLog.readLastLogByKey(db, {
        entity: 'avvaleplm.marsplm.sap2plex.ZMatExcLogPOS',
        keyColumns: ['Product', 'Plant'],
        scopeColumn: 'Product',
        scopeValues: uniqueProducts,
        keyOf: matLogKey,
        label: 'lista materiali'
      });

      const logMap = new Map();
      for (const [key, log] of pickedLogs) {
        logMap.set(key, {
          LastSendCounter: log.Counter,
          LastSendDate: log.SentDate,
          LastSendTime: log.SentTime,
          LastSendStatus: log.Status,
          // [LOG-MSG-I18N] Reso nella lingua della richiesta. La colonna e' ordinabile e
          // filtrabile lato client sul valore grezzo del modello (DEC-82), che ora e' il testo
          // tradotto: si cerca cio' che si vede, ed e' proprio quello che DEC-81/DEC-82 chiedono.
          LastSendMessage: renderLogMessage(log.MessageJson, req, log.Message)
        });
      }

      // ----------------------------------------------------------------
      // STEP 6: Merge A_ProductPlant + A_Product + ZMatExcLogPOS data
      // Create one row for each (Product, Plant) combination with optional log data
      // ----------------------------------------------------------------
      // [MAT-SCOPE] `EMPTY_DETAILS` è uscito con la via veloce: senza quel ramo l'assenza da
      // `productMap` ha un solo significato — «scartato dal `$filter` spinto su A_Product», in
      // ONPREM, oppure «il materiale non ha una riga anagrafica» — e in entrambi i casi la regola
      // è quella di sempre: nessuna riga prodotto, nessuna riga in elenco. Il caso «anagrafica non
      // LETTA» non arriva più fin qui: lo intercetta la potatura, che lo dichiara come
      // `DETAIL_UNKNOWN` invece di lasciarlo passare per una riga a celle vuote.
      const mergedResults = [];
      for (const plantRow of plantRows) {
        const productInfo = productMap.get(plantRow.Product) || null;
        if (productInfo) {  // Only include if product data exists (after $filter)
          const logInfo = logMap.get(`${plantRow.Product}|${plantRow.Plant || ''}`) || {
            LastSendCounter: null,
            LastSendDate: null,
            LastSendTime: null,
            LastSendStatus: null,
            LastSendMessage: null
          };

          mergedResults.push({
            Product: plantRow.Product,
            Plant: plantRow.Plant,  // SINGLE plant value (not comma-separated)
            ...productInfo,
            PlexPartType: plantRow.PlexPartType || null, // resolved from ZMatCategory (per-plant)
            ...logInfo  // Add log fields (null if no log entry exists - LEFT OUTER JOIN)
          });
        }
      }

      // ================================================================
      // [IS-BLANK-ROWS] Righe non rappresentabili come entity: si scartano dichiarandole, e se
      // non resta nulla la lettura viene respinta invece di mostrare una lista vuota.
      // `blankFields` è il solo `Product`: `Plant` arriva dal customizing locale ed è sempre
      // valorizzato, quindi includerlo renderebbe cieco il controllo di vuoto. Le righe ripetute
      // si contano invece sulla chiave esposta `(Product, Plant)` — lo stesso materiale su due
      // plant sono due righe legittime.
      // ================================================================
      const guard = identityGuard({
        fields: ['Product', 'Plant'], blankFields: ['Product'], label: 'Products'
      });
      const usableResults = guard.keep(mergedResults);
      const blankMessage = guard.rejectMessage(req);
      if (blankMessage) return req.reject(502, blankMessage);

      // NOTE: the test-data filter (opt-in) is already applied inside loadConfiguredProducts
      // at the config level, so mergedResults is already scoped correctly here.
      // ================================================================
      // [IS-SOURCE] (M3) In IS il criterio del client si valuta QUI, dopo il merge, con la
      // stessa semantica della sorgente (sottostringa sensibile alle maiuscole: riprodurre,
      // non migliorare — FR-30). La riga di log dichiara quante righe vengono scartate: se
      // un criterio è stato inviato e a valle si scartano righe, la sorgente non lo ha
      // applicato (contratto C-5).
      // ================================================================
      let filteredResults = usableResults;

      // ================================================================
      // [KEY-READ] Il predicato di CHIAVE si applica su ENTRAMBI i canali, e sta QUI.
      //
      // Non passa da `clientFilter`, che in ONPREM e' forzato a `empty`: senza questo blocco la
      // lettura per chiave resterebbe rotta sul canale storico esattamente com'era.
      //
      // La posizione e' vincolata da due lati, e spostarla rompe in silenzio:
      //  - DOPO `identityGuard` qui sopra, perche' la guardia giudica la SORGENTE sull'insieme
      //    intero: restringere prima farebbe leggere una sorgente rotta come «materiale non
      //    trovato» (404) invece che come il difetto dichiarato che e' (502);
      //  - PRIMA di `readPaging` e dello `slice` piu' sotto. Dopo lo `slice` tornerebbe la riga
      //    sbagliata con `200` e NESSUN log — `readPaging` non guarda mai `SELECT.one` e su una
      //    lettura per chiave rende `top = 100`.
      // ================================================================
      if (keyRead.one && keyRead.complete) {
        const before = filteredResults.length;
        filteredResults = filteredResults.filter((r) => keyReadRules.matchesKey(r, keyRead.equals));
        console.log(`>>> [KEY-READ] Products per chiave: tenute ${filteredResults.length} di ${before} righe`
          + ` | ${Object.entries(keyRead.equals).map(([f, v]) => `${f}='${v}'`).join(' ')}`);
      }

      if (clientFilter.kind === 'contains-search') {
        const before = filteredResults.length;
        filteredResults = filteredResults.filter(r => isQueryShape.matchesContains(r, clientFilter.fields, clientFilter.terms));
        console.log(`>>> [IS-SOURCE] ricerca materiali a valle: tenute ${filteredResults.length} di ${before} righe`
          + ` | campi=[${clientFilter.fields}] termini=[${clientFilter.terms}]`);
      } else if (clientFilter.kind === 'key-equality') {
        const before = filteredResults.length;
        const wanted = Object.entries(clientFilter.equals);
        filteredResults = filteredResults.filter(r => wanted.every(([f, v]) => String(r[f] ?? '') === String(v)));
        console.log(`>>> [IS-SOURCE] lettura per chiave a valle: tenute ${filteredResults.length} di ${before} righe`
          + ` | ${wanted.map(([f, v]) => `${f}='${v}'`).join(' ')}`);
      }

      // ----------------------------------------------------------------
      // STEP 7: order + paginate in memory; return with $count.
      // We page AFTER the merge so every returned row keeps its LastSend* fields,
      // and the total ($count) is exact and free (full set already materialized).
      //
      // [MAT-SCOPE] L'ORDINE PREDEFINITO È TORNATO UNO SOLO, e su Integration Suite è un CAMBIO
      // VISIBILE A SCHERMO: la lista si apre «più recenti prima» e non più per codice materiale.
      //
      // Il ramo per `(Product, Plant)` esisteva perché nella via veloce `CreationDate` non era
      // stata letta e ordinare su di essa metteva in fila 304 `null` — un ordine finto. Ora la
      // data c'è sempre, quindi quel ripiego non ha più una condizione che lo giustifichi, e
      // «più recenti prima» era l'ordine dichiarato come voluto. `(Product, Plant)` resta la
      // catena di spareggio, che è dove serviva davvero.
      // ----------------------------------------------------------------
      const { top, skip, wantCount, orderBy } = readPaging(req, { defTop: 100 });
      const ordered = (orderBy && orderBy.length)
        ? [...filteredResults].sort(cmpFromCqn(orderBy))
        : [...filteredResults].sort(byDateDescChain(['CreationDate'], ['Product', 'Plant']));
      const page = ordered.slice(skip, skip + top);
      if (wantCount) page.$count = ordered.length;
      console.log(`>>> Returning ${page.length} of ${ordered.length} product rows (skip=${skip}, top=${top}${wantCount ? `, count=${ordered.length}` : ''})`);
      return page;
    });

    // ================================================================
    // [FAST-LIST] Dettagli materiale di un blocco di codici (0013, RB-16c).
    //
    // Nessuna logica di lettura nuova: riusa la stessa lettura della lista e del job. Un
    // materiale che non arriva torna con i campi `null`, e i fallimenti sono dichiarati nel log e
    // nell'IS-CALL-LOG.
    //
    // [MAT-SCOPE] DALLA 0050 LA LISTA NON LA CHIAMA PIÙ, e l'action non è per questo morta: è il
    // RIPIEGO DELLA SCHEDA dopo un F5 (`DetailRead.recover` in DetailNavigation), che è anche il
    // motivo per cui applica il verdetto di perimetro come la lista — vedi il blocco più sotto.
    // Le righe della lista arrivano ora complete, quindi il giro di riempimento lato client trova
    // `_pendingDetailRows` vuota ed esce subito: nessuna chiamata, e nessun avviso.
    //
    // [PRODUCT-QUERY] DALLA 0040 IL BLOCCO NON DECIDE PIÙ IL VOLUME DELLA LETTURA. Prima erano due
    // letture per chiave per ogni codice del blocco, quindi cento codici erano duecento chiamate;
    // ora il primo blocco legge il PERIMETRO DEL PLANT in una query paginata e i blocchi successivi
    // non toccano SAP affatto. Il tetto a cento resta perché è il tetto della RISPOSTA — quante
    // righe questa action rimanda al browser — non più quello del costo verso SAP.
    //
    // Non usa `req.error`: un blocco che non arriva lascia le celle vuote, non deve far fallire
    // la lista che l'utente ha già davanti.
    // ================================================================
    const DETAILS_MAX_PER_BLOCK = 100;
    this.on('productDetails', async (req) => {
      const asked = [...new Set((req.data?.products || []).filter(Boolean).map(String))];
      if (!asked.length) return [];

      const products = asked.slice(0, DETAILS_MAX_PER_BLOCK);
      if (asked.length > products.length) {
        console.warn(`>>> [FAST-LIST] productDetails: blocco di ${asked.length} codici TRONCATO a `
          + `${DETAILS_MAX_PER_BLOCK}: ${asked.length - products.length} materiali NON letti in questa chiamata`);
      }

      const language = req.headers?.['accept-language']?.substring(0, 2)?.toUpperCase() || 'EN';
      // [PRODUCT-QUERY] I plant si risolvono PRIMA della lettura, non più solo per la
      // riclassificazione: la query per plant è la lettura stessa, e senza plant non è componibile.
      // Il gate di licenza resta quello di sempre — `resolveEffectivePlants` (0001) — quindi questa
      // action non allarga di un plant ciò che l'utente può vedere.
      // CONSEGUENZA DA SAPERE: se i plant non si risolvono, i dettagli NON si leggono e le celle
      // restano vuote (con la riga di log qui sotto). Prima si leggeva comunque per chiave, perché
      // la lettura non aveva bisogno del plant: ora il gate di licenza governa anche questa lettura,
      // ed è la posizione giusta — un dettaglio letto per un plant che non si può vedere è un dato
      // che non doveva uscire.
      let effectivePlants = [];
      try {
        effectivePlants = [...(await resolveEffectivePlants(req))];
      } catch (e) {
        console.warn(`>>> [PRODUCT-QUERY] productDetails: plant non risolti (${e.message})`);
      }
      // [DETAILS-PREFETCH] La cache decide solo QUALI materiali del blocco vanno letti davvero.
      // Resta davanti anche ora che la lettura è per plant: è una cache indifferente a cosa il
      // caricatore faccia, e sul ramo ONPREM è l'unica che c'è.
      let readFromSap = 0;
      const { byProduct, failed } = await productDetailCache.fetch(products, {
        language,
        load: (missing) => {
          readFromSap = missing.length;
          return fetchProductsForPlants(this.S4Product, missing, {
            plants: effectivePlants,
            columns: PRODUCT_SELECT,
            onpremColumns: '*',
            language,
            chunkSize: 150
          });
        }
      });
      for (const f of failed) console.error(`>>> [FAST-LIST] productDetails: ${f.key}: ${f.message}`);

      const detailOf = (product) => {
        const row = byProduct.get(product);
        return row ? detailRowOf(row) : Object.fromEntries(PRODUCT_DETAIL_FIELDS.map(f => [f, null]));
      };

      // ================================================================
      // [POST-GET-CLASSIFY] La tipologia si decide QUI, dopo la GET.
      // ================================================================
      // La lista classifica sulle righe di A_ProductPlant, che NON portano MTART: una condizione
      // su MTART e' li' inconoscibile, quindi «Finished Product» non aggancia mai e il materiale
      // cade nel ripiego. MTART sta su A_Product, che questa action ha appena letto.
      // [PRODUCT-QUERY] Qui c'era scritto «per le sole righe che l'utente sta guardando, che e'
      // l'unica lettura sostenibile su Integration Suite (A_Product non ha un _QUERYGET)»: dalla
      // 0040 quell'indirizzo ESISTE e la lettura e' del plant intero, in cache. Il blocco resta
      // perche' e' il momento in cui la tipologia si risolve, non perche' la lettura sia parziale.
      //
      // Servono anche i campi della riga plant, per i criteri su BESKZ/SOBSL/FEVOR: li da'
      // loadPlantRowsIndex, che legge nella forma sicura (solo plant nel filtro) e tiene il
      // risultato in cache. Vedi il commento su quella funzione: filtrare anche per materiale
      // farebbe tornare UNA riga per richiesta, non per via della rotta ma perche' l'iFlow onora
      // un solo valore della lista.
      // ================================================================
      // [MAT-SCOPE] E QUI SI APPLICA ANCHE IL PERIMETRO, non solo la tipologia (feature 0050).
      //
      // Sembra ridondante — dalla 0050 la READ non restituisce piu' righe fuori perimetro, quindi
      // il client non dovrebbe chiedere dettagli per una di quelle — e non lo e': questa action e'
      // il RIPIEGO DELLA SCHEDA DOPO UN F5 (`recover:` in DetailNavigation.controller.js). Un
      // materiale potato da' `404` sulla lettura per chiave, il client ricade qui, e senza il
      // verdetto la scheda mostrerebbe un materiale fuori perimetro il cui «Invia a Plex» viene poi
      // rifiutato: due schermate che si contraddicono, e la contraddizione la scopre l'utente.
      //
      // La guardia `!needsProductDetails(cats)` NON c'e' piu': salta i plant le cui categorie non
      // usano MTART, cioe' proprio dove vive il caso «categoria senza tipologia».
      // ================================================================
      const typeByKey = new Map();   // `${Product}|${Plant}` -> classe risolta
      const plantsOfProduct = new Map();
      try {
        const dbCat = await cds.connect.to('db');
        const { byPlant: categoryConfig, ok: categoriesKnown } = await loadCategoryConfigOutcome(dbCat);
        const typeMappedPlants = await loadTypeMappedPlants(dbCat);
        // [PRODUCT-QUERY] Gli stessi plant della lettura qui sopra: risolverli due volte nella
        // stessa richiesta significherebbe poter classificare su un insieme e leggere su un altro.
        const effective = effectivePlants;

        for (const plant of effective) {
          const cats = categoryConfig.get(plant) || [];
          // Nome diverso da `byProduct`: quello e' la mappa dei DETTAGLI (A_Product) che
          // `detailOf` usa in chiusura, e ombreggiarlo qui e' un incidente che aspetta.
          const plantRows = await loadPlantRowsIndex(this.S4Product, plant, { withNav: needsNav(cats) });
          for (const product of products) {
            const pp = plantRows.get(product);
            if (!pp) continue;   // il materiale non esiste in questo plant
            const v = matScope.finalScope({
              sapFields: mergeProductFields(extractSapFields(pp, this.S4Product.mode), byProduct.get(product)),
              detailKnown: byProduct.has(product),
              categories: cats,
              categoriesKnown,
              typeAvailable: typeMappedPlants.has(plant)
            });
            if (!v.listable) {
              console.log(`>>> [MAT-SCOPE] productDetails: ${product}/${plant} fuori perimetro`
                + ` (${v.reason}): nessuna riga restituita`);
              continue;
            }
            typeByKey.set(`${product}|${plant}`, v.plexPartType);
            if (!plantsOfProduct.has(product)) plantsOfProduct.set(product, []);
            plantsOfProduct.get(product).push(plant);
          }
        }
      } catch (e) {
        // Fail-open: senza la tipologia le celle restano vuote, la lista resta usabile e il
        // perche' e' in console. Non si tira a indovinare un tipo.
        console.warn(`>>> [POST-GET-CLASSIFY] productDetails: tipologia non risolta (${e.message})`);
      }

      // Una riga per (Product, Plant) dove la tipologia e' stata risolta; una riga sola, senza
      // plant, per i materiali che non hanno righe plant nei plant utilizzabili.
      const rows = [];
      for (const product of products) {
        const detail = detailOf(product);
        const plants = plantsOfProduct.get(product);
        if (plants && plants.length) {
          for (const plant of plants) {
            rows.push({ Product: product, Plant: plant, PlexPartType: typeByKey.get(`${product}|${plant}`) || null, ...detail });
          }
        } else {
          rows.push({ Product: product, Plant: null, PlexPartType: null, ...detail });
        }
      }
      console.log(`>>> [FAST-LIST] productDetails: ${products.length} codici chiesti, `
        + `${byProduct.size} risolti (${readFromSap} letti da SAP, ${products.length - readFromSap} dalla cache), `
        + `${typeByKey.size} tipologie risolte dopo la GET`
        + `${failed.length ? `, ${failed.length} letture dichiarate KO` : ''}`);
      return rows;
    });

    // ================================================================
    // [PLANT-ROWS] Com'è andata la lettura del perimetro materiali (0035).
    //
    // Il perché della busta — e perché non restituisce più i codici materiale — sta sulla
    // function in srv/cat-service.cds. Qui contano due regole.
    //
    // NON LEGGE NIENTE. Rende il verdetto che il lettore ha conservato per ciascun plant. Se
    // rileggesse, un perimetro che non si riesce a leggere costerebbe un secondo giro lento
    // esattamente dove il primo non ce l'ha fatta — e la nota arriverebbe minuti dopo la lista
    // che deve descrivere.
    //
    // «MAI LETTO» NON È «COMPLETO». Un plant che questo processo non ha ancora letto esce con
    // `Known: false` e non fa scattare la dichiarazione: un'informazione che non abbiamo non è
    // una rassicurazione. Succede dopo un riavvio, o se la lista viene aperta su un plant che
    // nessuno aveva ancora guardato.
    //
    // [PRODUCT-QUERY] LE LETTURE DI UN PLANT SONO ORA DUE, e il verdetto è la loro somma. Dalla
    // 0040 accanto ad `A_ProductPlant` c'è l'anagrafica `A_Product`, letta per plant: un'anagrafica
    // incompleta accorcia la lista esattamente come un perimetro incompleto — il merge esclude la
    // riga di un materiale senza dettaglio — quindi dichiararne una sola sarebbe dichiararne
    // metà. `Materials`, `Pages` e `Ms` restano quelli della lettura del PERIMETRO: sono i numeri
    // che descrivono quanti materiali ha il plant, e l'anagrafica non ne aggiunge di suoi.
    // ================================================================
    this.on('productScope', async (req) => {
      const plants = [...(await resolveEffectivePlants(req))];
      const rows = plants.map((Plant) => {
        const v = lastPlantReadVerdict(Plant);
        const a = lastProductReadVerdict(Plant);
        // [MAT-SCOPE] Il terzo verdetto: la POTATURA. Non è una lettura, è il customizing.
        const s = lastScopeVerdict(Plant);
        if (!v && !a && !s) {
          return {
            Plant, ReadOk: true, Complete: true, Known: false, Reason: '',
            Materials: 0, Pages: 0, Ms: 0,
            Excluded: 0, ExcludedReason: ''   // [MAT-SCOPE]
          };
        }
        // Una lettura MAI FATTA non degrada il verdetto dell'altra: non sapere non è sapere male.
        const reasons = [];
        if (v && !v.complete) reasons.push(`perimetro — ${v.text}`);
        if (a && !a.complete) reasons.push(`anagrafica — ${a.text}`);
        // ================================================================
        // [MAT-SCOPE] LA POTATURA SI DICHIARA, MA IN UN CAMPO SUO (feature 0050).
        //
        // NON entra in `Reason` e non abbassa `Complete`: un materiale fuori perimetro non è una
        // lettura incompleta. Confonderli renderebbe muto proprio l'avviso che serve — la
        // striscia direbbe «perimetro incompleto» su ogni plant con una categoria mal
        // configurata, e chi la legge imparerebbe a ignorarla.
        //
        // Ma DICHIARARLA è obbligatorio: se la potatura svuota la lista, la READ arriva a
        // `plantRows.length === 0` e restituisce una tabella vuota. Senza questo campo l'unica
        // traccia sarebbe una riga di console, e «i materiali non ci sono» e «nessuno di loro ha
        // una categoria» sarebbero la stessa schermata.
        // ================================================================
        const excludedParts = [];
        let excluded = 0;
        if (s) {
          const t = s.tally;
          excluded = matScope.prunedByConfig(t) + matScope.prunedByUnknown(t);
          if (t[matScope.SCOPE.NO_CATEGORY_MATCH]) {
            excludedParts.push(`${t[matScope.SCOPE.NO_CATEGORY_MATCH]} senza categoria`);
          }
          if (t[matScope.SCOPE.NO_PART_TYPE]) {
            excludedParts.push(`${t[matScope.SCOPE.NO_PART_TYPE]} con una categoria senza tipologia Plex`
              + (s.untypedCategories && s.untypedCategories.length
                ? ` (${s.untypedCategories.join(', ')})` : ''));
          }
          if (t[matScope.SCOPE.DETAIL_UNKNOWN]) {
            excludedParts.push(`${t[matScope.SCOPE.DETAIL_UNKNOWN]} trattenuti: anagrafica non letta`);
          }
          if (t[matScope.SCOPE.CATEGORIES_UNKNOWN]) {
            excludedParts.push(`${t[matScope.SCOPE.CATEGORIES_UNKNOWN]} trattenuti: customizing non letto`);
          }
        }
        return {
          Plant,
          ReadOk: (!v || v.readOk) && (!a || a.readOk),
          Complete: reasons.length === 0,
          Known: true,
          Reason: reasons.join(' | '),
          Materials: v ? v.materials : 0,
          Pages: v ? v.pages : 0,
          Ms: v ? v.ms : 0,
          Excluded: excluded,                        // [MAT-SCOPE]
          ExcludedReason: excludedParts.join(' | ')   // [MAT-SCOPE]
        };
      });
      const incomplete = rows.filter(r => r.Known && !r.Complete);
      // [MAT-SCOPE] Il totale della potatura viaggia in testata insieme alla sua spiegazione, per
      // gli stessi due motivi del campo per plant: si dichiara, e non si mescola con `Complete`.
      const pruned = rows.filter(r => r.Excluded > 0);
      const out = {
        Complete: incomplete.length === 0,
        Reason: incomplete.map(r => `${r.Plant}: ${r.Reason}`).join(' | '),
        Excluded: pruned.reduce((n, r) => n + r.Excluded, 0),
        ExcludedReason: pruned.map(r => `${r.Plant}: ${r.ExcludedReason}`).join(' | '),
        Plants: rows
      };
      console.log(`>>> [PLANT-ROWS] productScope: ${rows.length} plant, `
        + `${rows.filter(r => !r.Known).length} mai letti, ${incomplete.length} incompleti`
        + (out.Reason ? ` — ${out.Reason}` : '')
        + (out.Excluded ? ` | [MAT-SCOPE] ${out.Excluded} esclusi dal perimetro — ${out.ExcludedReason}` : ''));
      return out;
    });

    // ================================================================
    // [MATDOC-POST] Registrazione movimento merci verso l'iFlow IS. Tutta la logica sta in
    // srv/lib/materialDocPost.js: qui c'è solo l'aggancio della SONDA, che dalla W1-20 non parte
    // più da sola — si lancia da window.matDocPost(). Non usa `req.error`: l'esito è applicativo,
    // così una chiamata respinta mostra il proprio scambio invece di diventare un 500.
    //
    // I dati di prova si passano PER NOME. È l'unico posto del progetto in cui `MOCK` viaggia
    // verso SAP, e si vede: l'altro chiamante (il job PROD_CONF) manda documenti veri costruiti
    // da confMatDoc.js. `label` distingue le due cose negli MPL di Cloud Integration.
    // Perimetro: grep -rn "MATDOC-POST".
    // ================================================================
    this.on('postMaterialDoc', async () => postMaterialDoc(MATDOC_MOCK, { label: 'sonda' }));
  }

  // ================================================================
  // PRODUCTION ORDER SERVICE - SAP S/4HANA Production Order API integration
  // Handles: /production-orders/ProductionOrders (OData endpoint)
  // Source:  OP_API_PRODUCTION_ORDER_2_SRV_0001 (external OData v2 API)
  // UI:     DashboardNavigation.view.xml -> productionOrdersTable
  // ================================================================
  if (this.name === 'ProductionOrder') {

    // [IS-SOURCE] Sorgente dell'area ordini (feature 0013): stessa interfaccia di un
    // servizio remoto (`entities` + `run(query)`), canale scelto da PROD_ORDER_SOURCE.
    this.S4ProdOrder = await prodOrderSource();

    // ================================================================
    // [ORDER-STATUS-FILTER] Il perimetro in vigore per l'utente corrente (feature 0017).
    // Risponde a «perché la lista è vuota?»: il cockpit ne ricava il `noDataText`, così una
    // lista vuota per plant non configurato non si legge come «non ci sono ordini».
    // Non legge SAP, non scrive nulla, e usa lo STESSO perimetro utente della lettura della
    // lista — altrimenti direbbe una cosa e la lista ne mostrerebbe un'altra.
    // ================================================================
    this.on('prodOrderScope', async (req) => {
      const effectivePlants = [...(await resolveEffectivePlants(req))];
      if (!effectivePlants.length) {
        return { configured: [], unconfigured: [], rules: '(nessun plant utilizzabile per questo utente)' };
      }
      const dbScope = await cds.connect.to('db');
      const scope = await prodOrderStatusFilter.resolveOrderScope(dbScope, effectivePlants);
      return {
        configured: scope.configured,
        unconfigured: scope.unconfigured,
        rules: prodOrderStatusFilter.describeFilters(scope.byPlant)
      };
    });

    // ================================================================
    // [ORDER-STATUS-POST] Chiusura ordine e chiusura tecnica verso i due iFlow IS. Tutta la logica
    // sta in srv/lib/prodOrderStatusPost.js: qui c'è solo l'aggancio. Non usa `req.error` e non
    // applica il gate di licenza — non espone dati di alcun plant, manda un ordine inesistente.
    // `Full` aggiunge i controlli; senza, partono le sole due chiamate.
    // Perimetro: grep -rn "ORDER-STATUS-POST".
    // ================================================================
    this.on('postProdOrderStatus', async (req) => postProdOrderStatus(req.data?.Full === true));

    // [ORDER-ROWS] Le colonne della lista NON si elencano qui: vivono in srv/lib/orderRows.js,
    // insieme al tetto e all'ORDINE di costruzione della query. Questo file è una closure e i job
    // non ci arrivano — è la stessa ragione per cui il tetto `$top` è già in prodOrderSource.js, e
    // il costo di averlo ignorato è che la lettura del job e questa hanno potuto divergere per due
    // giorni senza che niente lo dichiarasse.
    const PROD_ORDER_LIST_COLUMNS = orderRows.LIST_COLUMNS;
    // [IS-SOURCE] [ORDER-TOP] Tetto della lettura completa del perimetro ordini (TD-6/A-7): è un
    // limite di SICUREZZA, non una dimensione misurata. Il suo raggiungimento è dichiarato come
    // sospetto di troncamento dalla sorgente (FR-12), mai in silenzio.
    //
    // Il numero e il nome della sua variabile d'ambiente vivono in srv/lib/prodOrderSource.js, non
    // qui: questo file è una closure, e i due job che leggono un perimetro d'ordine non ci
    // arrivano. Averlo in due posti è ciò che il 02/09/2026 ha lasciato le letture dei job senza
    // tetto. (Che senza `$top` quella RFC renda zero righe con esito OK era la causa attribuita
    // allo zero di `PROD_ORDER`, ed è un'IPOTESI NON CONFERMATA: vedi la testata di
    // srv/lib/prodOrderSource.js. Il tetto vale sul suo merito, non su quella causa.)
    const IS_PROD_ORDER_MAX_ROWS = prodOrderSource.listMaxRows();
    // Criteri che l'iFlow della lista ordini espone come select-option (contratto E-13):
    // restano SPINTI. `substringof` non c'è: la ricerca dell'utente è l'unico criterio a valle.
    const PROD_ORDER_PUSHABLE = [
      'ManufacturingOrder', 'Material', 'ProductionPlant', 'ManufacturingOrderType',
      'ProductionSupervisor', 'MfgOrderCreationDate'
    ];

    // READ handler for /production-orders/ProductionOrders
    this.on('READ', 'ProductionOrders', async (req) => {
      console.log(">>> READ ProductionOrders");

      const { top, skip, wantCount, orderBy } = readPaging(req, { defTop: 100 });
      const { A_ProductionOrder_2 } = this.S4ProdOrder.entities;
      const isMode = this.S4ProdOrder.mode === 'IS';
      // [IS-BLANK-ROWS] `ManufacturingOrder` è la chiave dell'entity esposta: una riga che ce l'ha
      // vuota non è rappresentabile, e due righe così mandano il binding in errore.
      const guard = identityGuard({ fields: ['ManufacturingOrder'], label: 'ProductionOrders' });

      // ---- perimetro -------------------------------------------------------------------
      // >>> TEST DATA FILTER (opt-in): restrict to a fixed test material list. Set env
      //     USE_TEST_DATA_FILTER=true to enable (disabled by default → real data). <<<
      let scopeWhere;
      // [ORDER-STATUS-FILTER] Criteri di stato dei soli plant in perimetro. `null` = il perimetro
      // per stato non si applica affatto (ramo dei dati di test), ed è l'unico caso in cui non si
      // applica: è deliberatamente diverso da «mappa vuota», che significa nessun plant configurato.
      let statusCfg = null;
      if (process.env.USE_TEST_DATA_FILTER === 'true') {
        scopeWhere = { Material: { in: ['FG126','SG124','MZ-FG-R10','MZ-FG-R11','MZ-FG-R12','MZ-FG-R13','MZ-FG-R14','MZ-FG-C900','MZ-FG-C950','MZ-FG-C990','MZ-FG-M500','MZ-FG-M525','MZ-FG-M550','MZ-FG-R100','MZ-FG-R200','MZ-FG-R300'] } };
      } else {
        // Only orders of ACTIVE plants, optionally narrowed by the plant selector (?plants=...).
        const effectivePlants = [...(await resolveEffectivePlants(req))];
        if (!effectivePlants.length) { console.log(">>> No plants in scope; returning no production orders"); return []; }

        // ================================================================
        // [ORDER-STATUS-FILTER] (feature 0017) Il perimetro per STATO, per plant. FAIL-CLOSED:
        // un plant senza riga di configurazione non produce ordini, qui come nel job.
        //
        // Restringere la query ai soli plant configurati NON è un'ottimizzazione: è la sola
        // forma corretta. Leggere anche i plant non configurati per poi scartarli a valle
        // consumerebbe il tetto di righe con ordini destinati a sparire, e su un cliente con un
        // plant configurato e tre no la lista risulterebbe troncata senza motivo apparente.
        //
        // La lista vuota che ne può derivare NON è muta: il cockpit chiede il motivo a
        // prodOrderScope() e lo scrive nel `noDataText` (contratto C-6 della 0013).
        // ================================================================
        const dbScope = await cds.connect.to('db');
        const scope = await prodOrderStatusFilter.resolveOrderScope(dbScope, effectivePlants);
        if (scope.unconfigured.length) {
          console.log(`>>> [ORDER-STATUS-FILTER] plant senza perimetro configurato, esclusi dalla`
            + ` lettura: ${scope.unconfigured.join(', ')}`);
        }
        if (!scope.configured.length) {
          console.log('>>> [ORDER-STATUS-FILTER] nessun plant del perimetro utente ha una'
            + ' configurazione di stato: nessun ordine viene letto (fail-closed).');
          return [];
        }
        console.log(`>>> [ORDER-STATUS-FILTER] criteri in vigore -> ${prodOrderStatusFilter.describeFilters(scope.byPlant)}`);
        statusCfg = scope.byPlant;
        scopeWhere = { ProductionPlant: { in: scope.configured } };
      }

      // ================================================================
      // [ORDER-STATUS-FILTER] Dove si applica il criterio, e perché.
      //
      // I flag di stato NON hanno select-option dietro l'iFlow (contratto E-13, richiesta R-2b):
      // in IS il criterio si valuta SEMPRE a valle. In ONPREM è spingibile, ma solo se è UNO —
      // il criterio è per plant, e una query sola non può portarne due diversi. Quando lo è, la
      // query resta identica a quella di prima della 0017 (era il vecchio RELEASED_STATE) e il
      // volume trasferito non cresce: è il caso realistico di un cliente con un solo criterio.
      //
      // [W1-09] I due criteri su VALORE (tipo ordine, responsabile di schedulazione) non si
      // spingono su NESSUN canale — il perché è in testa a pushableWhere — quindi la loro sola
      // presenza accende il ramo a valle ANCHE quando i flag sono stati spinti. Senza questa
      // riga, in ONPREM con criterio unico il filtro su FEVOR non verrebbe mai valutato: un
      // fail-OPEN silenzioso dentro un perimetro fail-closed.
      // ================================================================
      const commonStatus = statusCfg ? prodOrderStatusFilter.commonFilter(statusCfg) : null;
      const noStatusCriteria = !!commonStatus && prodOrderStatusFilter.criteriaIsEmpty(commonStatus);
      const pushedStatus = (!isMode && commonStatus && !noStatusCriteria)
        ? prodOrderStatusFilter.pushableWhere(commonStatus)
        : null;
      if (pushedStatus) Object.assign(scopeWhere, pushedStatus);
      const valueDownstream = !!statusCfg && prodOrderStatusFilter.hasValueCriteria(statusCfg); // [W1-09]
      const statusDownstream = !!statusCfg && !noStatusCriteria && (!pushedStatus || valueDownstream);
      // [ORDER-ROWS] L'unione «elenco fisso + campi citati dai criteri» la fa il lettore condiviso,
      // con la stessa funzione e lo stesso ordine con cui la fa il job: senza i campi dei criteri il
      // criterio non sarebbe valutabile e il fail-closed svuoterebbe la lista, e un nome ripetuto
      // nel `$select` è una richiesta malformata (i due campi valore sono già nell'elenco fisso).
      const listColumns = orderRows.columnsFor('list', statusCfg);
      // Campi citati da un criterio e mai arrivati dalla sorgente: si valuta FUORI dal `catch`,
      // come blankMessage, perché dentro il `req.reject` diverrebbe la lista vuota di sempre.
      let statusUnavailable = [];

      // [KEY-READ] Il criterio EFFETTIVO: il `$filter` del client PIU' il predicato di una lettura
      // per chiave, che CAP mette altrove (feature 0041). Qui, a differenza di `Products`, il
      // criterio SI PUO' spingere: `ManufacturingOrder` e' l'unica chiave ed e' gia' fra i campi
      // dichiarati spingibili, quindi non c'e' nessun campo assente dal modello a valle.
      const clientWhere = keyReadRules.readWhere(req.query) || null;
      const keyRead = keyReadRules.keyReadOf(req.query, ['ManufacturingOrder']);
      // ================================================================
      // [IS-SOURCE] (M4/TD-6) La forma della lettura. Dietro l'iFlow ci sono
      // SO_PRODUCTION_PLANT, IV_TOP, IV_SKIP, IV_ORDER_BY ma NESSUN equivalente di
      // substringof e nessun conteggio dichiarato.
      //
      // QUESTA DESCRIZIONE E' STORIA, e va letta come tale: i due trigger che nominava —
      //   1. il client ha inviato una ricerca (filtrare DOPO la paginazione darebbe un
      //      risultato sbagliato, FR-13);
      //   2. è richiesto il conteggio e la risposta non porta un conteggio proprio;
      // sono stati RIMOSSI da DEC-83, che in IS porta ogni lettura su `runFull` (il ramo è più
      // sotto, cercare [LIST-WHOLE-SET]). Restano qui perché il rollback di DEC-83 deve
      // rimetterli, e senza il loro enunciato nessuno saprebbe quali erano.
      //
      // E `IV_TOP`/`IV_SKIP` ora ci sono DAVVERO (ABAP, 01/09/2026): dichiarare non era
      // implementare. Cosa renda quella RFC quando `IV_TOP` NON arriva resta invece NON MISURATO:
      // il «risponde `200` con ZERO righe» era la causa attribuita allo zero di `PROD_ORDER` il
      // 02/09, e col tetto a bordo il job ha letto ancora zero — vedi l'addendum a DEC-83, il tag
      // [ORDER-TOP] e la testata di srv/lib/prodOrderSource.js.
      // ================================================================
      const clientFilter = isMode
        ? isQueryShape.classifyClientFilter(clientWhere, PROD_ORDER_PUSHABLE)
        : { kind: 'empty', fields: [], terms: [], equals: {} };
      if (clientFilter.kind === 'unsupported') {
        return req.reject(400,
          'Criterio di ricerca non supportato dalla sorgente ordini attiva: la richiesta non è stata ' +
          'eseguita per non restituire un risultato solo parzialmente filtrato'
        );
      }
      const searchDownstream = clientFilter.kind === 'contains-search';

      /** Lettura di oggi: perimetro + eventuale filtro del client + $top/$skip/$orderby spinti. */
      const buildPushed = () => {
        const query = SELECT.from(A_ProductionOrder_2).columns(...listColumns).limit(top, skip);
        query.SELECT.orderBy = (orderBy && orderBy.length) ? orderBy : [{ ref: ['MfgOrderCreationDate'], sort: 'desc' }];
        query.where(scopeWhere);
        if (clientWhere) query.where(clientWhere);
        if (wantCount) query.SELECT.count = true; // -> $inlinecount=allpages (odata-v2)
        return query;
      };
      const runPushed = async (query) => {
        const rows = await this.S4ProdOrder.run(query);
        // [IS-BLANK-ROWS] Lo scarto avviene PRIMA di qualunque uso delle righe.
        const result = guard.keep(Array.isArray(rows) ? [...rows] : []);
        // remote $count arrives as a NON-enumerable prop -> re-assign enumerably so
        // the outbound adapter emits @odata.count
        const remoteCount = Number(rows && rows.$count);
        return { result, remoteCount: Number.isFinite(remoteCount) && remoteCount > 0 ? remoteCount : null };
      };

      /** Lettura del perimetro con tetto, poi ricerca/ordinamento/paginazione in memoria. */
      const runFull = async (reason) => {
        console.log(`>>> [IS-SOURCE] lista ordini: lettura completa del perimetro (${reason}), tetto ${IS_PROD_ORDER_MAX_ROWS} righe`);
        // [ORDER-ROWS] LA lettura del perimetro, la stessa che fa il job: colonne, tetto e ORDINE
        // di costruzione della query (`.columns().limit().where()`, cioè `$select&$top&$filter` sul
        // filo) vivono in srv/lib/orderRows.js. Questa è la richiesta con l'esito buono osservato,
        // e il lettore condiviso esiste per garantire che il job mandi la stessa.
        //
        // I criteri spingibili restano spinti: a valle si applica SOLO la ricerca. In ONPREM il
        // filtro del client resta spinto INTERAMENTE, com'è sempre stato (TD-5): lì il gateway
        // gestisce anche l'OR di substringof.
        const read = await orderRows.readOrdersInScope(this.S4ProdOrder, {
          where: scopeWhere,
          cfgs: statusCfg,
          kind: 'list',
          cap: IS_PROD_ORDER_MAX_ROWS,
          extraWhere: (clientWhere && (!isMode || clientFilter.kind === 'key-equality'))
            ? clientWhere
            : undefined
        });
        let rows = read.rows;
        // [IS-BLANK-ROWS] Prima della ricerca, dell'ordinamento e del conteggio: così il totale
        // dichiarato al client conta solo righe che esistono davvero.
        rows = guard.keep(Array.isArray(rows) ? [...rows] : (rows ? [rows] : []));
        // [ORDER-STATUS-FILTER] Gira QUI: dopo la guardia e PRIMA di ricerca, ordinamento e
        // paginazione. È l'unico punto in cui `$count` resta coerente con ciò che si vede —
        // filtrare dopo la paginazione darebbe pagine di dimensione variabile e un totale che
        // non corrisponde. È la stessa collocazione del filtro di visibilità dei cicli.
        if (statusDownstream) {
          const f = prodOrderStatusFilter.applyStatusFilter(rows, statusCfg);
          console.log(`>>> [ORDER-STATUS-FILTER] ${f.stats.kept} ordini tenuti,`
            + ` ${f.stats.excluded} esclusi dal perimetro su ${f.stats.in} letti`);
          if (f.stats.unavailable.length) {
            // Un criterio non valutabile non si ignora (fail-closed): senza questa riga la lista
            // sarebbe vuota e nessuno saprebbe che la causa è un campo mai arrivato dall'iFlow.
            console.error('>>> [ORDER-STATUS-FILTER] campi configurati e MAI arrivati dalla'
              + ` sorgente: ${f.stats.unavailable.join(', ')}. Il criterio non è valutabile e`
              + ' nessun ordine passa: va verificata la mappatura dell\'iFlow su quei campi.');
            statusUnavailable = f.stats.unavailable;
          }
          // [W1-09] L'altra faccia: il campo ARRIVA, ma è vuoto su tutte le righe lette. Non è un
          // 502 — la risposta è formalmente valida e il criterio è valutabile — ma è la firma del
          // campo consegnato senza contenuto che DEC-64 insegna ad aspettarsi su questo canale, e
          // l'esito (zero ordini) è identico a quello di un iFlow incompleto.
          if (f.stats.blank.length) {
            console.warn('>>> [W1-09] campi del perimetro arrivati VUOTI su tutte le righe lette:'
              + ` ${f.stats.blank.join(', ')}. Il criterio è valutabile ma non aggancia nulla: va`
              + ' verificato che l\'iFlow valorizzi quei campi e in quale forma.');
          }
          if (f.stats.kept === 0 && f.stats.in > 0 && !f.stats.unavailable.length) {
            console.warn('>>> [ORDER-STATUS-FILTER] il perimetro ha svuotato la lista: nessun'
              + ' ordine soddisfa i criteri configurati.');
          }
          rows = f.kept;
        }
        if (searchDownstream) {
          const before = rows.length;
          // Sensibile alle maiuscole: riproduce `substringof` del gateway, non lo migliora (M3).
          rows = rows.filter(r => isQueryShape.matchesContains(r, clientFilter.fields, clientFilter.terms));
          console.log(`>>> [IS-SOURCE] ricerca ordini a valle: tenute ${rows.length} di ${before} righe`
            + ` | campi=[${clientFilter.fields}] termini=[${clientFilter.terms}]`);
        }
        rows.sort((orderBy && orderBy.length)
          ? cmpFromCqn(orderBy)
          : byDateDescChain(['MfgOrderCreationDate'], ['ManufacturingOrder']));
        const total = rows.length;
        const page = rows.slice(skip, skip + top);
        if (wantCount) page.$count = total;
        console.log(`>>> Returning ${page.length} of ${total} production orders (skip=${skip}, top=${top}${wantCount ? `, count=${total}` : ''})`);
        return page;
      };

      /**
       * La lettura di oggi, nelle sue tre forme. È una funzione perché l'esito della guardia
       * [IS-BLANK-ROWS] va valutato FUORI dal `catch`: dentro, il `req.reject` diverrebbe la
       * lista vuota di sempre.
       */
      const readOrders = async () => {
        // ================================================================
        // [LIST-WHOLE-SET] In IS la paginazione NON si spinge mai. Prima trigger, e assorbe i
        // quattro che seguono.
        //
        // PERCHE'. Il contratto dell'iFlow dichiara `IV_TOP` e `IV_SKIP` (vedi il commento sulla
        // forma della lettura, piu' sopra), ma le RFC ABAP dietro di esso NON li implementano:
        // rispondono sempre con l'insieme intero. Spingere `$top`/`$skip` su una sorgente che li
        // ignora e' peggio che non spingerli — la prima pagina sembra giusta, e alla seconda il
        // browser chiede `$skip=500` e RIRICEVE le prime righe. Righe duplicate in lista, e il
        // difetto non si vede finche' un perimetro non supera una pagina: e' il caso peggiore
        // del contratto (C-6), un risultato plausibile e sbagliato.
        //
        // Con questo ramo gli ordini si comportano come le ALTRE DUE LISTE: si legge il
        // perimetro intero (tetto IS_PROD_ORDER_MAX_ROWS, dichiarato) e si affetta in memoria.
        // Nessuno `$skip` raggiunge ECC da nessuna delle tre aree.
        //
        // ONPREM NON PASSA DI QUI, ed e' deliberato: la' c'e' il gateway vero, `$top`/`$skip`
        // sono nativi e la via spinta resta quella di sempre. Uniformare le due modalita'
        // sembra una pulizia ed e' una regressione (DEC-34, RB-29/RB-42).
        //
        // DEI QUATTRO TRIGGER CHE C'ERANO NE RESTANO DUE, e non e' una svista. I due che
        // portavano `isMode` nella condizione — la ricerca non spingibile e il conteggio non
        // dichiarato dalla sorgente — da qui in poi sono irraggiungibili: questo ramo li
        // precede e copre esattamente i loro casi. Lasciarli scritti avrebbe fatto credere a
        // chi legge che la via spinta possa ancora servire in IS. Gli altri due valgono in
        // ENTRAMBE le modalita' e restano dove sono, perche' in ONPREM sono l'unica difesa.
        //
        // Se un giorno le RFC paginassero davvero, il rollback e' togliere questa riga: i due
        // trigger rimossi vanno rimessi insieme a lei, o la loro difesa sparisce in silenzio.
        // ================================================================
        if (isMode) return await runFull('la sorgente non pagina: lettura intera e paginazione in memoria');
        // [ORDER-STATUS-FILTER] Trigger valido in ENTRAMBE le modalità: se il criterio di stato
        // si valuta a valle, `$top`/`$skip` non sono onorabili — la pagina verrebbe filtrata dopo
        // essere stata tagliata, e il totale dichiarato conterebbe ordini che non si vedono.
        if (statusDownstream) return await runFull('criterio di perimetro per plant: paginazione non spingibile');

        const pushed = buildPushed();
        // ================================================================
        // [IS-SOURCE] Terzo trigger della stessa regola, e vale in ENTRAMBE le modalità
        // perché il chunking vale in entrambe (DEC-19): se il perimetro va spezzato in più
        // richieste, `$top`/`$skip` NON sono onorabili — il tetto verrebbe applicato a ogni
        // chunk e l'unione restituirebbe fino a (chunk × $top) righe, cioè una pagina
        // plausibile e sbagliata. Con i plant reali (3) non scatta mai; scatta con più di
        // `chunkSize` valori nel criterio, per esempio con USE_TEST_DATA_FILTER attivo.
        // ================================================================
        if (isQueryShape.splitInList(pushed, this.S4ProdOrder.chunkSize).length > 1) {
          return await runFull('criterio da spezzare in più richieste: paginazione non spingibile');
        }

        // [LIST-WHOLE-SET] Qui arriva solo ONPREM. Il trigger «conteggio non dichiarato dalla
        // sorgente» che stava in questo punto era condizionato a `isMode` ed e' stato rimosso
        // insieme alla via spinta in IS: il gateway un `$inlinecount` lo dichiara sempre.
        const { result, remoteCount } = await runPushed(pushed);
        if (wantCount) {
          // [IS-BLANK-ROWS] Se righe sono state scartate, il conteggio della sorgente ha contato
          // anche quelle: prometterebbe al client righe che non esistono. Si dichiara il numero di
          // righe utilizzabili, e la discrepanza si scrive nel log.
          if (guard.dropped && remoteCount !== null) {
            console.warn(`>>> [IS-BLANK-ROWS] conteggio della sorgente (${remoteCount}) NON attendibile:`
              + ` contava anche righe non rappresentabili. Dichiarate ${result.length} righe utilizzabili.`);
          }
          result.$count = guard.dropped ? result.length : (remoteCount || result.length);
        }
        console.log(`>>> Retrieved ${result.length} production orders (skip=${skip}, top=${top}${wantCount ? `, count=${result.$count}` : ''})`);
        return result;
      };

      let page;
      try {
        page = await readOrders();
      } catch (error) {
        console.error(`>>> ERROR querying A_ProductionOrder_2:`, error.message);
        return [];
      }

      // ================================================================
      // [KEY-READ] Su una lettura per chiave il criterio si RIVERIFICA a valle.
      //
      // E' gia' stato spinto verso la sorgente, ma un criterio spinto puo' essere ignorato IN
      // SILENZIO — e' il contratto C-5, ed e' un caso che questo progetto ha gia' incontrato
      // (DEC-49). Qui la conseguenza sarebbe servire il primo ordine del perimetro al posto di
      // quello chiesto: la testata su cui il dettaglio costruisce l'albero e salva il ciclo Plex.
      //
      // UN PUNTO SOLO, e non dentro `readOrders()`, che ha tre uscite: tre copie divergerebbero.
      // ================================================================
      if (keyRead.one && keyRead.complete && Array.isArray(page)) {
        const before = page.length;
        page = page.filter((r) => keyReadRules.matchesKey(r, keyRead.equals));
        if (page.length !== before) {
          console.warn(`>>> [KEY-READ] ProductionOrders per chiave: scartate ${before - page.length}`
            + ` righe su ${before} — la sorgente NON ha applicato`
            + ` ManufacturingOrder='${keyRead.equals.ManufacturingOrder}'`);
        }
      }

      // [IS-BLANK-ROWS] Fuori dal `catch`: un difetto DICHIARATO non deve diventare una lista
      // vuota, che l'utente legge come «non ci sono ordini» (contratto C-6). Se qualche riga
      // buona è arrivata la lista si mostra: lo scarto è già dichiarato nel log e nella nota
      // della traccia IS-CALL-LOG.
      const blankMessage = guard.rejectMessage(req);
      if (blankMessage) return req.reject(502, blankMessage);
      // [ORDER-STATUS-FILTER] Un criterio configurato che la sorgente non permette di valutare è
      // un DIFETTO, non una configurazione: si dichiara, non lo si lascia diventare una lista
      // vuota. Fuori dal `catch` per la stessa ragione di blankMessage.
      if (statusUnavailable.length) {
        return req.reject(502, getLocalizedMessage(req, 'osfUnavailableFields', 'marsplm-sap2plex',
          statusUnavailable.join(', ')));
      }

      // ================================================================
      // [LAST-LOG-WORST-DAY] Le due colonne di storico della lista ordini (feature 0049).
      //
      // Fino alla 0049 questa lista non ne aveva nessuna: per sapere com'era andato un ordine
      // bisognava aprirne il dettaglio, uno per uno. La riga mostrata e' la PEGGIORE DEL GIORNO
      // PIU' RECENTE fra le righe di `ZProdOrderExcLogPOS`, e NON la testata `ZProdOrderExcLogHDR`:
      // la testata la aggiorna solo l'invio del job (`updateHeader`, srv/lib/prodOrderExcLog.js),
      // quindi mostrarla vorrebbe dire tacere una chiusura tecnica o una consuntivazione fallita —
      // che sono operazioni su QUESTO ordine, e la seconda ha effetti contabili.
      //
      // QUATTRO COSE DECIDONO *DOVE* E *COME*, e nessuna di esse da' un errore se sbagliata:
      //
      //   1. QUI, e non dentro `readOrders()`: quella funzione ha TRE uscite, e tre copie
      //      divergerebbero. E' la stessa ragione scritta sopra per [KEY-READ]. Sta dopo i due
      //      `req.reject`, cosi' su una lista rifiutata non si legge niente.
      //   2. SI MUTA LA RIGA IN POSTO. `page.$count` e' una proprieta' dell'ARRAY: una `map` la
      //      perderebbe, il client leggerebbe un `@odata.count` sbagliato e «Mostra di piu'»
      //      girerebbe all'infinito (`isLengthFinal()` non diventa mai vero, addendum a DEC-102).
      //      Restano intatti per la stessa ragione i due campi tecnici [IS-FULL-KEY] su cui il
      //      dettaglio costruisce l'albero.
      //   3. IL DIFETTO DI LETTURA NON ABBATTE LA LISTA: `readLastLogByKey` lo dichiara e rende una
      //      mappa vuota, cioe' due colonne nulle. Un ordine senza storico e' il caso NORMALE.
      //   4. LE DUE COLONNE NON SONO ORDINABILI LATO SERVER, ed e' simmetrico a `Routings`:
      //      l'arricchimento e' a valle del `sort` di `runFull`. Non e' una lacuna — le tre liste
      //      caricano l'insieme INTERO e ordinano e filtrano nel browser (DEC-82).
      // ================================================================
      if (Array.isArray(page) && page.length) {
        const dbLog = await cds.connect.to('db');
        const picked = await lastLog.readLastLogByKey(dbLog, {
          entity: 'avvaleplm.marsplm.sap2plex.ZProdOrderExcLogPOS',
          keyColumns: ['ManufacturingOrder'],
          scopeColumn: 'ManufacturingOrder',
          scopeValues: page.map((r) => r.ManufacturingOrder),
          keyOf: (r) => String(r.ManufacturingOrder || ''),
          label: 'lista ordini'
        });
        for (const row of page) {
          const log = picked.get(String(row.ManufacturingOrder || ''));
          row.LastSendStatus = log ? (log.Status || null) : null;
          // [LOG-MSG-I18N] Reso nella lingua della richiesta, come nelle altre due liste: il
          // messaggio e' persistito a SEGMENTI e la lingua e' di chi guarda, non di chi ha lanciato
          // l'invio — i job non ne portano nessuna (DEC-92).
          row.LastSendMessage = log
            ? renderLogMessage(log.MessageJson, req, log.Message || null)
            : null;
        }
      }
      return page;
    });

    // [KEY-READ] `orderFilterOf` RIMOSSA (feature 0041). Era una quarta copia della stessa
    // estrazione — `orderKeysOf` qui sotto l'aveva sostituita ai due call site — e non aveva piu'
    // nessun chiamante: leggeva `SELECT.where` a mano, cioe' era gia' cieca a una lettura per
    // chiave, e aspettava solo di divergere dalle altre tre. Il criterio si estrae da
    // `keyReadRules.readWhere`, in un punto solo.

    /**
     * [IS-FULL-KEY] Le chiavi delle letture dei figli dell'ordine, estratte dal CQN del client, e
     * il RESTO del suo filtro: `rest` non porta più né il numero d'ordine né le chiavi interne
     * (l'AUFPL per le operazioni, la prenotazione per i componenti), perché quale spingere lo
     * decide il canale e non il client (DEC-42): in `IS` si spinge la sola chiave interna, come
     * `$filter` sulla collection del `_QUERYGET` (DEC-43 e DEC-45); in `ONPREM` il solo numero
     * d'ordine, cioè la query identica a prima del rilascio (DEC-34). Tutto ciò che il client ha
     * chiesto oltre a quelle chiavi resta e viene inoltrato tale e quale.
     * La UI del cockpit manda le chiavi interne perché le ha dalla riga della lista; chi non le
     * manda (deep link, client esterno) fa risolvere la testata all'handler.
     */
    function orderKeysOf(req) {
      // [KEY-READ] Il criterio EFFETTIVO, non il solo `SELECT.where`: su una lettura per chiave il
      // predicato sta in `SELECT.from.ref[<ultimo>].where`. Su una lettura di COLLECTION
      // `readWhere` rende lo STESSO array per riferimento, quindi la via rapida di `pluckEquality`
      // resta intatta e il cambiamento e' inerte sulle liste.
      //
      // Onesto su cosa NON risolve: le chiavi di queste due entity sono l'AUFPL e la prenotazione,
      // non `ManufacturingOrder`, quindi su una lettura per chiave `order` resta vuoto e la guardia
      // qui sotto rende `[]` come prima — cioe' 404, che e' l'esito giusto. Il valore di questa
      // riga e' che il criterio si legge da un punto solo, come in tutti gli altri handler.
      const where = keyReadRules.readWhere(req.query);
      const k = isQueryShape.pluckEquality(where, 'OrderInternalBillOfOperations');
      const r = isQueryShape.pluckEquality(k.rest, 'Reservation');
      const o = isQueryShape.pluckEquality(r.rest, 'ManufacturingOrder');
      return {
        order: String(o.val || '').trim(),
        aufpl: String(k.val || '').trim(),
        reservation: String(r.val || '').trim(),
        rest: o.rest || null
      };
    }

    // READ handler for /production-orders/ProductionOrderOperations
    this.on('READ', 'ProductionOrderOperations', async (req) => {
      console.log(">>> READ ProductionOrderOperations");

      const top = Number(req._queryOptions?.$top) || 500;
      const { A_ProductionOrderOperation_2 } = this.S4ProdOrder.entities;
      const isMode = this.S4ProdOrder.mode === 'IS';

      const { order: sOrder, aufpl: sClientAufpl, rest: clientWhere } = orderKeysOf(req);
      if (!sOrder) {
        console.log('>>> [IS-SOURCE] READ ProductionOrderOperations senza filtro ManufacturingOrder:'
          + ' richiesta RIFIUTATA (una collection senza criteri non è una lettura eseguibile in perimetro)');
        return [];
      }

      const query = SELECT.from(A_ProductionOrderOperation_2)
        .columns(
          'OrderInternalBillOfOperations',
          'OrderIntBillOfOperationsItem',
          'ManufacturingOrder',
          'ManufacturingOrderOperation',
          'ManufacturingOrderSubOperation',
          'MfgOrderOperationText',
          'WorkCenter',
          'ProductionPlant',
          'OpPlannedTotalQuantity',
          'OpTotalConfirmedYieldQty',
          'OperationUnit',
          'OperationIsReleased',
          'OperationIsConfirmed',
          'OperationIsClosed',
          'OperationIsDeleted'
        )
        .limit(top);

      // [IS-SOURCE] Il perimetro plant NON è spingibile su questo indirizzo (la funzione ha
      // solo IV_MANUFACTURING_ORDER e le due chiavi interne): in IS si applica a valle, sulle
      // righe lette, PRIMA che compaiano in una lista. Il presidio non si salta, si sposta
      // (FR-14). In ONPREM resta spinto, come oggi.
      let activePlants = null;
      if (process.env.USE_TEST_DATA_FILTER !== 'true') {
        activePlants = [...(await getUserPlants(req))];
        if (!activePlants.length) { console.log(">>> No active plants; returning no operations"); return []; }
        if (!isMode) query.where({ ProductionPlant: { in: activePlants } });
      }

      if (clientWhere) {
        query.where(clientWhere);
      }

      // [IS-QUERYGET-OPS] In IS la lettura è una collection sul `_QUERYGET` con
      // `$filter=OrderInternalBillOfOperations eq '…'` (DEC-45). L'AUFPL arriva dalla riga già
      // letta dal cockpit, dove viaggia come campo tecnico della testata; se non c'è — deep link,
      // cache vecchia, client esterno — lo si risolve con UNA lettura di testata. Se anche quella
      // non lo dà, non resta alcun criterio e la lettura viene dichiarata, non tentata.
      let sAufpl = '';
      if (isMode) {
        sAufpl = sClientAufpl;
        if (!sAufpl) {
          try {
            const { A_ProductionOrder_2 } = this.S4ProdOrder.entities;
            const header = await this.S4ProdOrder.run(
              SELECT.one.from(A_ProductionOrder_2)
                .columns('ManufacturingOrder', 'OrderInternalBillOfOperations')
                .where({ ManufacturingOrder: sOrder })
            );
            sAufpl = String(header?.OrderInternalBillOfOperations || '').trim();
            console.log(`>>> [IS-SOURCE] operazioni ordine ${sOrder}: AUFPL non inviato dal client,`
              + ` risolto dalla testata = '${sAufpl || '(vuoto)'}'`);
          } catch (e) {
            console.warn(`>>> [IS-SOURCE] operazioni ordine ${sOrder}: lettura della testata per l'AUFPL`
              + ` fallita (${e.message}) — senza AUFPL la lettura non è eseguibile`);
          }
        }
      }
      // Una sola delle due chiavi va nel filtro: l'helper è lo stesso dei percorsi server-side.
      const opsKeys = { ManufacturingOrder: sOrder, OrderInternalBillOfOperations: sAufpl };
      const opsWhere = operationsFilter(isMode ? 'IS' : 'ONPREM', opsKeys);
      if (!opsWhere) {
        declareSkippedRead(this.S4ProdOrder, {
          entity: 'A_ProductionOrderOperation_2',
          criteria: `ordine ${sOrder}`,
          reason: 'AUFPL (OrderInternalBillOfOperations) non disponibile: né inviato dal client né '
            + 'restituito dalla testata. È il solo criterio contrattato su questo indirizzo, e una '
            + 'collection interrogata senza filtro sarebbe le operazioni di TUTTI gli ordini'
        });
        return [];
      }
      query.where(opsWhere);

      try {
        const rows = await this.S4ProdOrder.run(query);
        // [IS-QUERYGET-OPS] Il numero d'ordine non è stato spinto: si verifica sulle righe lette,
        // così una risposta che ignorasse il filtro non contamina l'albero dell'ordine.
        const own = keepOperationsOfOrder(isMode ? 'IS' : 'ONPREM',
          { ManufacturingOrder: sOrder, OrderInternalBillOfOperations: sAufpl }, rows);
        if (own.dropped) {
          console.warn(`>>> [IS-SOURCE] operazioni ordine ${sOrder}: scartate ${own.dropped} righe`
            + ' di ALTRI ordini (il numero d\'ordine non è spinto su questo indirizzo)');
        }
        let results = own.kept;
        if (isMode && activePlants) {
          const allowed = new Set(activePlants);
          const before = results.length;
          results = results.filter(r => allowed.has(r.ProductionPlant));
          console.log(`>>> [IS-SOURCE] filtro plant a valle (operazioni ordine ${sOrder}):`
            + ` tenute ${results.length} di ${before} righe | plant ammessi=[${activePlants}]`);
        }
        console.log(`>>> Retrieved ${results.length} production order operations`);
        return results;
      } catch (error) {
        console.error(`>>> ERROR querying A_ProductionOrderOperation_2:`, error.message);
        return [];
      }
    });

    // READ handler for /production-orders/ProductionOrderComponents
    this.on('READ', 'ProductionOrderComponents', async (req) => {
      console.log(">>> READ ProductionOrderComponents");

      const top = Number(req._queryOptions?.$top) || 1000;
      const { A_ProductionOrderComponent_2 } = this.S4ProdOrder.entities;
      const isMode = this.S4ProdOrder.mode === 'IS';

      // [IS-SOURCE] TD-7, vedi READ ProductionOrderOperations. Il numero d'ordine resta
      // OBBLIGATORIO nella richiesta del client — è ciò che identifica l'insieme da mostrare — ma
      // in IS non viene inoltrato a SAP: al suo posto va la prenotazione come key predicate, e la
      // selezione dell'ordine si verifica a valle (DEC-42).
      const { order: sOrder, reservation: sClientReservation, rest: clientWhere } = orderKeysOf(req);
      if (!sOrder) {
        console.log('>>> [IS-SOURCE] READ ProductionOrderComponents senza filtro ManufacturingOrder:'
          + ' richiesta RIFIUTATA (una collection senza criteri non è una lettura eseguibile in perimetro)');
        return [];
      }

      const compColumns = [
        'Reservation',
        'ReservationItem',
        'ManufacturingOrder',
        'ManufacturingOrderOperation',
        'Material',
        'BOMItemDescription',
        'RequiredQuantity',
        'WithdrawnQuantity',
        'BaseUnit',
        'Plant',
        'StorageLocation',
        'Batch',
        'ReservationIsFinallyIssued',
        // [PHANTOM-EXPLODE] Il flag che dice se la riga e' un assieme fantasma. E' contrattato
        // sull'iFlow (E-13, campo 41) ed esiste da sempre sull'entity: semplicemente non lo
        // chiedeva nessuno, ed e' il motivo per cui i fantasma finivano su Plex come part.
        'MaterialComponentIsPhantomItem'
      ];
      // [COMP-EXCL] I campi citati dalle regole di esclusione. Qui il plant NON è ancora noto — lo
      // si ricava dalle righe lette, più sotto — quindi si chiede l'unione delle colonne di TUTTI
      // i plant: una colonna in più nel `$select` non costa nulla, una colonna mancante costa una
      // condizione che non aggancia in silenzio.
      const exclColumns = await orderCompExcl.extraComponentColumns(
        await cds.connect.to('db'), null, compColumns
      );
      const query = SELECT.from(A_ProductionOrderComponent_2)
        .columns(...compColumns, ...exclColumns)
        .limit(top);

      // [IS-SOURCE] come sopra: `Plant` non è spingibile su questo indirizzo, il gate si
      // applica a valle in IS e resta spinto in ONPREM (FR-14).
      let activePlants = null;
      if (process.env.USE_TEST_DATA_FILTER !== 'true') {
        activePlants = [...(await getUserPlants(req))];
        if (!activePlants.length) { console.log(">>> No active plants; returning no components"); return []; }
        if (!isMode) query.where({ Plant: { in: activePlants } });
      }

      if (clientWhere) {
        query.where(clientWhere);
      }

      // [IS-QUERYGET-COMP] In IS la lettura è una collection sul `_QUERYGET` con
      // `$filter=Reservation eq '…'` (DEC-43). La prenotazione arriva dalla riga già letta
      // dal cockpit, dove viaggia nel campo contenitore `MasterProductionOrder`; se non c'è — deep
      // link, cache vecchia, client esterno — lo si risolve con UNA lettura di testata. Se anche
      // quella non la dà, non resta alcun criterio e la lettura viene dichiarata, non tentata.
      let sReservation = '';
      if (isMode) {
        sReservation = sClientReservation;
        if (!sReservation) {
          try {
            const { A_ProductionOrder_2 } = this.S4ProdOrder.entities;
            const header = await this.S4ProdOrder.run(
              SELECT.one.from(A_ProductionOrder_2)
                .columns('ManufacturingOrder', 'MasterProductionOrder')
                .where({ ManufacturingOrder: sOrder })
            );
            sReservation = reservationOf(header);
            console.log(`>>> [IS-SOURCE] componenti ordine ${sOrder}: prenotazione non inviata dal client,`
              + ` risolta dalla testata = '${sReservation || '(vuota)'}'`);
          } catch (e) {
            console.warn(`>>> [IS-SOURCE] componenti ordine ${sOrder}: lettura della testata per la`
              + ` prenotazione fallita (${e.message}) — senza RSNUM la lettura non è eseguibile`);
          }
        }
      }
      // Una sola chiave va nel filtro: l'helper è lo stesso dei percorsi server-side.
      const orderKeys = { ManufacturingOrder: sOrder, MasterProductionOrder: sReservation };
      const compWhere = componentsFilter(isMode ? 'IS' : 'ONPREM', orderKeys);
      if (!compWhere) {
        declareSkippedRead(this.S4ProdOrder, {
          entity: 'A_ProductionOrderComponent_2',
          criteria: `ordine ${sOrder}`,
          reason: 'numero di prenotazione (RSNUM) non disponibile: la testata non lo ha restituito nel '
            + 'campo MasterProductionOrder. È il solo criterio contrattato su questo indirizzo, e senza '
            + 'di esso resterebbe una collection interrogata senza filtro, cioè la lettura di tutto. '
            + 'In quale campo l\'iFlow mandi le chiavi si vede dal corpo crudo della lettura di testata '
            + 'nell\'anello: window.isCalls() dal cockpit'
        });
        return [];
      }
      query.where(compWhere);

      try {
        const rows = await this.S4ProdOrder.run(query);
        // [IS-QUERYGET-COMP] Il numero d'ordine non è stato spinto: si verifica sulle righe lette. La
        // chiave arriva da un campo RIUSATO (MasterProductionOrder), quindi righe di un altro
        // ordine sono il segnale che quel campo non porta la prenotazione attesa.
        const own = keepComponentsOfOrder(isMode ? 'IS' : 'ONPREM', orderKeys, rows);
        if (own.dropped) {
          console.warn(`>>> [IS-SOURCE] componenti ordine ${sOrder}: scartate ${own.dropped} righe di ALTRI`
            + ' ordini — la prenotazione usata come criterio non è quella dell\'ordine: risultato INCOMPLETO');
        }
        let results = own.kept;
        if (isMode && activePlants) {
          const allowed = new Set(activePlants);
          const before = results.length;
          results = results.filter(r => allowed.has(r.Plant));
          console.log(`>>> [IS-SOURCE] filtro plant a valle (componenti ordine ${sOrder}):`
            + ` tenute ${results.length} di ${before} righe | plant ammessi=[${activePlants}]`);
        }
        console.log(`>>> Retrieved ${results.length} production order components`);

        // ================================================================
        // [PHANTOM-EXPLODE] Esplosione dei fantasma (feature 0019), se il plant l'ha accesa.
        // Il plant si prende dalle righe: qui, a differenza del ramo cicli, ce l'hanno. Righe di
        // plant diversi nello stesso ordine non esistono, quindi la prima basta.
        // ================================================================
        const compPlant = (results.find((r) => r.Plant) || {}).Plant || '';
        const db = await cds.connect.to('db');
        const { rows: explodedRows } = await bomExplode.explodeProdOrderComponents({
          db,
          plant: compPlant,
          rows: results,
          tag: `albero ordine ${sOrder}`
        });
        // [COMP-EXCL] Esclusione configurabile, DOPO l'esplosione. L'albero a schermo deve mostrare
        // gli stessi componenti che il job confronterà con Plex: se qui non si applicasse,
        // l'operatore vedrebbe righe che l'invio disattiva, senza sapere perché.
        const { rows: keptRows } = await orderCompExcl.applyComponentExclusions({
          db,
          plant: compPlant,
          rows: explodedRows,
          // Nessuna sorgente materiali da riusare in questo servizio (`this.S4Product` vive nel
          // servizio Product): il modulo apre la sua, che è memoizzata.
          tag: `albero ordine ${sOrder}`
        });
        return keptRows;
      } catch (error) {
        console.error(`>>> ERROR querying A_ProductionOrderComponent_2:`, error.message);
        return [];
      }
    });

    // ================================================================
    // [KEY-READ] Il filtro delle tre tabelle del ciclo dell'ORDINE, dal criterio EFFETTIVO.
    //
    // Erano TRE COPIE dello stesso loop a indice, e nessuna guardava dove CAP mette il predicato
    // di una lettura per chiave: su `PlexCycleOperations(<uuid>)` il filtro restava `{}`, cioe'
    // `where({})`, cioe' LA TABELLA INTERA — tutti i cicli di tutti gli ordini di tutti i plant —
    // e CAP ne serviva la prima riga con un `200`.
    //
    // `ID` entra fra i nomi riconosciuti perche' e' LA CHIAVE di queste tre proiezioni: senza di
    // lui una lettura per chiave resterebbe senza criterio.
    //
    // Due differenze dal loop di prima, entrambe volute e nessuna osservabile sui chiamanti reali
    // (l'albero dell'ordine manda sempre `$filter=ManufacturingOrder eq '…'`, un AND di
    // uguaglianze): `equalitiesOf` e' PRIMO-vince dove il loop era ultimo-vince, e non pesca
    // un'uguaglianza da dentro un `or` — su un `or` la direzione giusta e' non restringere a caso.
    // ================================================================
    function plexCycleFilter(query) {
      return keyReadRules.equalitiesOf(
        keyReadRules.readWhere(query), ['ManufacturingOrder', 'ID']
      ).equals;
    }

    /**
     * [KEY-READ] Una lettura senza NESSUN criterio non e' una lettura da fare: renderebbe la
     * tabella intera. E' il fail-closed che gli altri quattro handler dei figli dell'ordine e del
     * ciclo applicano da sempre (`if (!sOrder) return []`), esteso a queste tre.
     */
    function plexCycleRefused(label, filter) {
      if (Object.keys(filter).length) return false;
      console.log(`>>> [KEY-READ] READ ${label} senza alcun criterio: richiesta RIFIUTATA`
        + ' (una lettura senza criteri renderebbe la tabella intera, di tutti gli ordini)');
      return true;
    }

    // READ handler for /production-orders/PlexCycleOperations
    this.on('READ', 'PlexCycleOperations', async (req) => {
      console.log('>>> READ PlexCycleOperations');

      const db = await cds.connect.to('db');
      const { ZPlexCycleOperation } = db.entities('avvaleplm.marsplm.sap2plex');

      const filter = plexCycleFilter(req.query);
      if (plexCycleRefused('PlexCycleOperations', filter)) return [];

      try {
        const query = SELECT.from(ZPlexCycleOperation)
          .where(filter)
          .orderBy('OperationNumber asc');
        const results = await db.run(query);
        console.log(`>>> Retrieved ${results.length} Plex cycle operations`);
        return results;
      } catch (error) {
        console.error('>>> ERROR reading PlexCycleOperations:', error.message);
        return [];
      }
    });

    // READ handler for /production-orders/PlexCycleComponents
    this.on('READ', 'PlexCycleComponents', async (req) => {
      console.log('>>> READ PlexCycleComponents');

      const db = await cds.connect.to('db');
      const { ZPlexCycleComponent } = db.entities('avvaleplm.marsplm.sap2plex');

      const filter = plexCycleFilter(req.query);
      if (plexCycleRefused('PlexCycleComponents', filter)) return [];

      try {
        const query = SELECT.from(ZPlexCycleComponent)
          .where(filter)
          .orderBy('PlexOperationId asc', 'Sequence asc');
        const results = await db.run(query);
        console.log(`>>> Retrieved ${results.length} Plex cycle components`);
        return results;
      } catch (error) {
        console.error('>>> ERROR reading PlexCycleComponents:', error.message);
        return [];
      }
    });

    // [ORDER-CYCLE-SEED] READ handler for /production-orders/PlexCycleApprovedWorkcenters.
    // Gemello dei due sopra: stesso filtro condiviso (`plexCycleFilter`), e su errore la lista
    // vuota — i work center sono un arricchimento dell'albero, non la sua spina dorsale.
    this.on('READ', 'PlexCycleApprovedWorkcenters', async (req) => {
      console.log('>>> READ PlexCycleApprovedWorkcenters');

      const db = await cds.connect.to('db');
      const { ZPlexCycleApprovedWorkcenter } = db.entities('avvaleplm.marsplm.sap2plex');

      const filter = plexCycleFilter(req.query);
      if (plexCycleRefused('PlexCycleApprovedWorkcenters', filter)) return [];

      try {
        const results = await db.run(
          SELECT.from(ZPlexCycleApprovedWorkcenter).where(filter).orderBy('PlexOperationId asc')
        );
        console.log(`>>> Retrieved ${results.length} Plex cycle approved workcenters`);
        return results;
      } catch (error) {
        console.error('>>> ERROR reading PlexCycleApprovedWorkcenters:', error.message);
        return [];
      }
    });

    // ================================================================
    // [PLANT-ACCESS] La QUARTA tabella dell'albero non aveva nessun handler (feature 0048).
    //
    // `PlexCycleRemovedComponents` e' esposta `@readonly` e leggeva dall'handler generico di CAP:
    // una GET senza criteri rendeva la TABELLA INTERA, cioe' i componenti che ogni persona ha
    // rimosso da ogni ordine. Le tre gemelle qui sopra hanno il fail-closed dal
    // [KEY-READ]; questa era rimasta fuori — l'elenco delle entity da proteggere diceva «tre».
    //
    // Il plant non c'e' e non e' ricavabile: la chiave e' (ManufacturingOrder, Material). Il gate
    // esprimibile e' quindi lo stesso delle gemelle — nessun criterio, nessuna lettura — e il
    // client la chiede sempre con `$filter=ManufacturingOrder eq …`, quindi il criterio c'e'.
    // ================================================================
    this.on('READ', 'PlexCycleRemovedComponents', async (req) => {
      const db = await cds.connect.to('db');
      const { ZProdOrderCompRemoved } = db.entities('avvaleplm.marsplm.sap2plex');

      const filter = plexCycleFilter(req.query);
      if (plexCycleRefused('PlexCycleRemovedComponents', filter)) return [];

      try {
        const results = await db.run(
          SELECT.from(ZProdOrderCompRemoved).where(filter).orderBy('Material asc')
        );
        console.log(`>>> Retrieved ${results.length} Plex cycle removed components`);
        return results;
      } catch (error) {
        console.error('>>> ERROR reading PlexCycleRemovedComponents:', error.message);
        return [];
      }
    });

    // Batch save: replaces all cycle operations and components for a manufacturing order
    this.on('savePlexCycle', async (req) => {
      const { ManufacturingOrder, Operations, RemovedComponents } = req.data;
      console.log(`>>> Saving Plex cycle for order ${ManufacturingOrder}: ${Operations ? Operations.length : 0} operations`);

      const db = await cds.connect.to('db');
      const { ZPlexCycleOperation, ZPlexCycleComponent, ZPlexCycleApprovedWorkcenter,
        ZProdOrderCompRemoved } = db.entities('avvaleplm.marsplm.sap2plex');

      try {
        // Skip orders of non-active plants.
        // [ORDER-CYCLE-SEED] La testata passa da `readOrderHeader`: la sola lettura per chiave
        // lasciava il plant `undefined` quando il root `_GET` non consegna la riga, e il gate
        // rifiutava un salvataggio legittimo dicendo che il plant non è attivo.
        const hdr = await readOrderHeader(this.S4ProdOrder, ManufacturingOrder, {
          columns: ['ManufacturingOrder', 'ProductionPlant'],
          require: ['ProductionPlant'],
          plants: [...(await resolveEffectivePlants(req))]
        });
        if (hdr.shape !== 'key') {
          console.log(`>>> [ORDER-CYCLE-SEED] savePlexCycle ${ManufacturingOrder}: testata via`
            + ` ${hdr.shape} — ${hdr.note}`);
        }
        if (await rejectIfPlantNotUsable(req, hdr.order && hdr.order.ProductionPlant)) return;

        // ================================================================
        // [ORDER-COMP-REMOVE] IL GUARDIANO DELLA RIMOZIONE, PRIMA DI QUALUNQUE SCRITTURA.
        //
        // Una rimozione si puo' chiedere solo su un ordine che NON e' ancora uscito verso Plex:
        // dopo, quel componente e' una riga BOM di un lotto in produzione e portarla a `Active = 0`
        // e' un'altra decisione, che questa schermata non prende.
        //
        // SI GUARDA IL DELTA, NON L'ELENCO. Il client rimanda ogni volta le rimozioni che ha letto,
        // quindi rifiutare «lista non vuota su ordine inviato» renderebbe insalvabile l'albero di
        // ogni ordine gia' mandato — comprese le modifiche alle operazioni, che qui non c'entrano.
        // Si rifiutano le rimozioni NUOVE. Un ripristino (materiale che esce dall'elenco) resta
        // ammesso anche dopo l'invio: rimette il componente nel confronto, e il passo 7.2 disattiva
        // ma non riattiva, quindi su Plex non produce niente — mentre negarlo lascerebbe un errore
        // di battitura inchiodato per sempre.
        //
        // Il gate lato client e' comodita': la regola e' questa.
        // ================================================================
        const removalsSent = Array.isArray(RemovedComponents);
        const wantedRemovals = removalsSent
          ? orderCompRemovalRules.normalizeMaterials(RemovedComponents) : null;
        if (removalsSent && wantedRemovals.length > 0) {
          const before = await orderCompRemoval.loadRemovedMaterials(db, ManufacturingOrder);
          if (before.readError) {
            return req.error(500, getLocalizedMessage(req, 'orderCompRemoveReadFailed',
              'marsplm-sap2plex', before.readError));
          }
          const added = orderCompRemovalRules.addedMaterials(wantedRemovals, before.materials);
          if (added.length > 0) {
            const { sent } = await orderCompRemoval.isOrderAlreadySent(db, ManufacturingOrder);
            if (sent) {
              console.warn(`>>> [ORDER-COMP-REMOVE] ${ManufacturingOrder}: rifiutate`
                + ` ${added.length} rimozioni nuove su un ordine gia' inviato (${added.join(', ')})`);
              return req.error(400, getLocalizedMessage(req, 'orderCompRemoveAlreadySent',
                'marsplm-sap2plex', added.slice(0, 5).join(', ')));
            }
          }
        }

        // Delete existing operations and components for this order
        // [ORDER-CYCLE-SEED] I work center NON si cancellano tutti: se il client non li manda
        // (payload senza `ApprovedWorkcenters`) si conservano quelli delle operazioni sopravvissute
        // e si toglie solo il resto, più sotto. Cancellarli qui renderebbe il primo salvataggio
        // dell'albero una perdita silenziosa di ciò che la semina aveva copiato.
        await db.run(DELETE.from(ZPlexCycleComponent).where({ ManufacturingOrder }));
        await db.run(DELETE.from(ZPlexCycleOperation).where({ ManufacturingOrder }));

        let totalComponents = 0;

        // Insert new operations with sequence
        if (Operations && Operations.length > 0) {
          const opEntries = Operations.map((op, index) => ({
            ID: cds.utils.uuid(),
            ManufacturingOrder,
            PlexOperationId: op.PlexOperationId,
            OperationCode: op.OperationCode,
            OperationName: op.OperationName,
            Sequence: op.OperationNumber || (index + 1) * 10,
            SAPOperationId: op.SAPOperationId || null,
            OperationNumber: op.OperationNumber || (index + 1) * 10,
            OperationType: op.OperationType || null,
            SubOperation: op.SubOperation || false,
            Shippable: op.Shippable || false,
            NetWeight: op.NetWeight || null,
            StandardQuantity: op.StandardQuantity || null
          }));

          await db.run(INSERT.into(ZPlexCycleOperation).entries(opEntries));

          // Insert components for each operation
          const compEntries = [];
          Operations.forEach(op => {
            if (op.Components && op.Components.length > 0) {
              op.Components.forEach((comp, compIndex) => {
                compEntries.push({
                  ID: cds.utils.uuid(),
                  ManufacturingOrder,
                  PlexOperationId: op.PlexOperationId,
                  Material: comp.Material,
                  RequiredQuantity: comp.RequiredQuantity,
                  BaseUnit: comp.BaseUnit,
                  Sequence: (compIndex + 1) * 10,
                  // [PHANTOM-EXPLODE] La provenienza arriva dal client, che l'ha ricevuta
                  // nell'albero SAP: e' l'unico modo perche' sopravviva al salvataggio.
                  PhantomSource: comp.PhantomSource || '',
                  // [COMP-SOURCE] Chi ha collocato la riga, con lo STESSO giro di `PhantomSource` e
                  // per la stessa ragione: il salvataggio e' un delete+insert, quindi senza il
                  // percorso completo server -> client -> server ogni Salva azzererebbe la
                  // provenienza e cancellerebbe l'unico segno della decisione presa a mano.
                  // Normalizzata qui perche' la validazione dei valori ammessi sta nell'handler di
                  // scrittura e non in un'annotazione (DEC-02), come sulla gemella dei cicli.
                  AssignmentSource: compSource.normalizeOrigin(comp.AssignmentSource)
                });
              });
            }
          });

          if (compEntries.length > 0) {
            await db.run(INSERT.into(ZPlexCycleComponent).entries(compEntries));
            totalComponents = compEntries.length;
          }
        }

        // ================================================================
        // [ORDER-CYCLE-SEED] I CENTRI DI LAVORO APPROVATI: il payload vince, l'assenza conserva.
        //
        // Due comportamenti perché ci sono due tipi di chiamante. Un client che li conosce li
        // rimanda interi e riscrive (ed è così che si toglie un work center dall'operazione). Un
        // client che non li manda — o una chiamata che arriva da un'altra schermata — non sta
        // dicendo «togli tutto»: sta dicendo «non è affare mio». Là si tengono le righe delle
        // operazioni che sono ancora nel ciclo e si tolgono solo quelle rimaste orfane.
        //
        // La sottrazione si fa leggendo e cancellando per ID invece di un `not in`: sono poche
        // righe e la forma è la stessa su SQLite e su HANA.
        // ================================================================
        const opsIn = Operations || [];
        const keptOpIds = new Set(opsIn.map((o) => o.PlexOperationId).filter(Boolean));
        const clientSentWorkcenters = opsIn.some((o) => Array.isArray(o.ApprovedWorkcenters));
        let totalWorkcenters = 0;

        if (clientSentWorkcenters) {
          await db.run(DELETE.from(ZPlexCycleApprovedWorkcenter).where({ ManufacturingOrder }));
          // Le righe le costruisce lo STESSO codice della semina: due costruzioni separate
          // divergerebbero al primo campo aggiunto. Deduplica su (operazione, work center), DEC-66.
          const wcEntries = orderCycleSeed.workcenterEntries(ManufacturingOrder, opsIn, cds.utils.uuid);
          if (wcEntries.length > 0) await db.run(INSERT.into(ZPlexCycleApprovedWorkcenter).entries(wcEntries));
          totalWorkcenters = wcEntries.length;
        } else {
          const existing = await db.run(
            SELECT.from(ZPlexCycleApprovedWorkcenter).columns('ID', 'PlexOperationId')
              .where({ ManufacturingOrder })
          );
          const orphans = orderCycleSeed.orphanWorkcenterIds(existing, keptOpIds);
          if (orphans.length > 0) {
            await db.run(DELETE.from(ZPlexCycleApprovedWorkcenter).where({ ID: { in: orphans } }));
            console.log(`>>> [ORDER-CYCLE-SEED] ${orphans.length} work center di operazioni rimosse`
              + ` cancellati sull'ordine ${ManufacturingOrder}`);
          }
          totalWorkcenters = existing.length - orphans.length;
        }

        // ================================================================
        // [ORDER-COMP-REMOVE] LE RIMOZIONI: il payload vince, l'assenza conserva.
        //
        // Stessa asimmetria dei work center, e per la stessa ragione: un chiamante che non manda il
        // campo non sta dicendo «ripristina tutto», sta dicendo «non e' affare mio» — e i chiamanti
        // che non lo mandano esistono (l'auto-import, un client non aggiornato). Senza questa
        // regola una rimozione sparirebbe in silenzio e il componente ricomparirebbe su Plex.
        //
        // Un array VUOTO invece e' un ripristino chiesto, e cancella: e' l'unico modo che il
        // cockpit ha di rimettere in gioco l'ultimo componente rimosso.
        // ================================================================
        let removedCount = null;
        if (removalsSent) {
          await db.run(DELETE.from(ZProdOrderCompRemoved).where({ ManufacturingOrder }));
          if (wantedRemovals.length > 0) {
            await db.run(INSERT.into(ZProdOrderCompRemoved).entries(
              wantedRemovals.map((Material) => ({ ManufacturingOrder, Material }))
            ));
          }
          removedCount = wantedRemovals.length;
          console.log(`>>> [ORDER-COMP-REMOVE] ordine ${ManufacturingOrder}: ${removedCount}`
            + ` componenti rimossi a mano${removedCount ? ` (${wantedRemovals.join(', ')})` : ''}`);
        }
        // `removedCount` resta `null` quando il payload non portava il campo: la' non si e' scritto
        // niente e il numero non e' stato guardato. Leggerlo per restituirlo sarebbe una query in
        // piu' per un valore che nessun chiamante di quel ramo chiede — chi manda il campo sa gia'
        // quante rimozioni ha mandato.

        console.log(`>>> Plex cycle saved: ${opsIn.length} operations, ${totalComponents} components,`
          + ` ${totalWorkcenters} approved workcenters, ${removedCount} removed components`);
        return { success: true, count: Operations ? Operations.length : 0, removedCount };
      } catch (error) {
        console.error('>>> ERROR saving Plex cycle:', error.message);
        req.error(500, error.message);
      }
    });

    // ================================================================
    // [COMP-ORPHAN] I componenti di un ordine come il cockpit li vede, in un punto solo (0037).
    //
    // PERCHE' ESISTE. La catena — lettura filtrata sulla prenotazione, scarto delle righe di altri
    // ordini, esplosione dei fantasma, esclusioni di plant, rimozioni manuali — era scritta
    // IDENTICA in `autoAssignPlexCycle`, e la 0037 ne aveva bisogno anche in
    // `autoImportPlexCycle`: sarebbe stata la terza copia (la seconda vive nel job, come
    // `loadOrderDetails`, e la' non e' estraibile perche' il job e' un processo separato che non
    // entra in questa closure). L'ORDINE degli strati non e' arbitrario ed e' motivato in
    // `loadOrderDetails`: le esclusioni valgono anche sui figli del fantasma, e la rimozione
    // manuale e' un atto su un elenco che una persona ha visto.
    //
    // NON CHIAMA `req.error`: rende un esito, e chi chiama decide. I due chiamanti fanno cose
    // OPPOSTE sullo stesso impedimento — l'auto-assegnazione si ferma (girerebbe su niente e
    // sembrerebbe un customizing mancante), l'import prosegue copiando tutto (potare su una lettura
    // non riuscita svuoterebbe l'albero).
    // ================================================================
    const loadCockpitOrderComponents = async ({ ManufacturingOrder, order, plant, tag }) => {
      const { A_ProductionOrderComponent_2 } = this.S4ProdOrder.entities;
      const compKeys = {
        ManufacturingOrder,
        MasterProductionOrder: order && order.MasterProductionOrder
      };
      const compWhere = componentsFilter(this.S4ProdOrder.mode, compKeys);
      if (!compWhere) {
        return {
          ok: false,
          reason: 'NO_RESERVATION',
          note: `numero di prenotazione non disponibile sulla testata dell'ordine`
            + ` ${ManufacturingOrder} (campo MasterProductionOrder vuoto): i componenti non sono`
            + ' leggibili su questo canale',
          rows: []
        };
      }
      const cols = ['ManufacturingOrder', 'Material', 'RequiredQuantity', 'BaseUnit',
        // [PHANTOM-EXPLODE] Il flag del fantasma e l'operazione: la seconda e' la chiave
        // con cui si fondono i duplicati che arrivano da rami diversi.
        'MaterialComponentIsPhantomItem', 'ManufacturingOrderOperation', 'ReservationItem'];
      const dbLocal = await cds.connect.to('db');
      // [COMP-EXCL] Qui il plant è noto dalla testata: si chiedono le colonne del SOLO plant.
      const exclCols = await orderCompExcl.extraComponentColumns(dbLocal, plant, cols);
      const compRows = await this.S4ProdOrder.run(
        SELECT.from(A_ProductionOrderComponent_2)
          .columns(...cols, ...exclCols)
          .where(compWhere)
          .limit(1000)
      );
      const ownComps = keepComponentsOfOrder(this.S4ProdOrder.mode, compKeys, compRows);
      if (ownComps.dropped) {
        console.warn(`>>> ${tag}: scartati ${ownComps.dropped} componenti di ALTRI ordini —`
          + ' la prenotazione usata come criterio non è quella dell\'ordine');
      }
      // [PHANTOM-EXPLODE] Stessa funzione della READ e del job: si gira sull'albero che l'utente
      // vede, non su quello grezzo di SAP.
      const { rows: exploded } = await bomExplode.explodeProdOrderComponents({
        db: dbLocal, plant, rows: ownComps.kept, tag
      });
      // [COMP-EXCL] Stesso customizing della READ e del job, e nello stesso ordine (dopo
      // l'esplosione): un componente che l'invio disattiverà su Plex non è una riga su cui lavorare.
      const { rows: kept } = await orderCompExcl.applyComponentExclusions({
        db: dbLocal, plant, rows: exploded, tag
      });
      // [ORDER-COMP-REMOVE] Ultimo strato: cio' che una persona ha rimosso non torna in gioco.
      const { rows: live } = await orderCompRemoval.applyManualRemovals({
        db: dbLocal, ManufacturingOrder, rows: kept, tag
      });
      return { ok: true, reason: '', note: '', rows: live };
    };

    // autoAssignPlexCycle action - resolve the order's BOM components to Plex operations
    // via the ZObjectGroup / ZCycleAutoAssignConfig customizing (see resolveAutoAssignments).
    this.on('autoAssignPlexCycle', async (req) => {
      const { ManufacturingOrder } = req.data;
      console.log(`>>> autoAssignPlexCycle (order): order=${ManufacturingOrder}`);

      try {
        // [COMP-ORPHAN] L'entity dei componenti non si destruttura piu' qui: la lettura e' passata
        // in `loadCockpitOrderComponents`, che e' anche la sua unica utilizzatrice (0037).

        // [ORDER-CYCLE-SEED] Testata con ripiego di forma: con la sola lettura per chiave, su un
        // canale il cui root `_GET` non consegna la riga, l'auto-assegnazione usciva con l'elenco
        // vuoto e sembrava un customizing mancante.
        // [IS-QUERYGET-COMP] MasterProductionOrder veicola la prenotazione, criterio della lettura
        // dei componenti qui sotto (DEC-42 per l'origine, DEC-43 per la forma).
        const hdr = await readOrderHeader(this.S4ProdOrder, ManufacturingOrder, {
          columns: ['ManufacturingOrder', 'MasterProductionOrder', 'Material', 'ProductionPlant'],
          require: ['Material', 'ProductionPlant'],
          plants: [...(await resolveEffectivePlants(req))]
        });
        const order = hdr.order;
        if (hdr.notes.length) {
          console.log(`>>> [ORDER-CYCLE-SEED] autoAssign: testata ${ManufacturingOrder}`
            + ` (${hdr.shape}) — ${hdr.note}`);
        }
        const plant = order && order.ProductionPlant;
        const headerMaterial = ((order && order.Material) || '').trim();
        if (!plant || !headerMaterial) {
          console.log('>>> autoAssign order: plant or header material not found');
          return { Plant: plant || '', HeaderMaterial: headerMaterial || '', assignments: [], unassigned: [], counts: { total: 0, assigned: 0, unassigned: 0 } };
        }
        // Skip orders of non-active plants.
        if (await rejectIfPlantNotUsable(req, plant)) return;

        // [COMP-ORPHAN] La catena sta in `loadCockpitOrderComponents`, punto unico condiviso con
        // l'import del ciclo (0037): lettura filtrata sulla prenotazione, scarto delle righe di
        // altri ordini, esplosione dei fantasma, esclusioni di plant, rimozioni manuali.
        const loaded = await loadCockpitOrderComponents({
          ManufacturingOrder, order, plant, tag: `auto-assegna ordine ${ManufacturingOrder}`
        });
        if (!loaded.ok) {
          // [IS-QUERYGET-COMP] Un elenco vuoto qui sarebbe indistinguibile da «l'ordine non ha
          // componenti», e l'auto-assegnazione girerebbe su niente: si dichiara l'impedimento (DEC-43).
          return req.error(502, `${loaded.note}. La lettura e il suo corpo crudo sono nell'anello:`
            + ' window.isCalls()');
        }
        const liveComps = loaded.rows;
        const components = liveComps.map(c => ({
          Material: c.Material,
          RequiredQuantity: c.RequiredQuantity || 0,
          BaseUnit: c.BaseUnit || '',
          BOMItemNodeNumber: null,
          PhantomSource: c.PhantomSource || ''
        }));

        const result = await resolveAutoAssignments({ plant, headerMaterial, components });
        console.log(`>>> autoAssign order: ${result.counts.assigned}/${result.counts.total} assigned, ${result.counts.unassigned} unassigned`);
        return { Plant: plant, HeaderMaterial: headerMaterial, ...result };
      } catch (error) {
        console.error('>>> ERROR autoAssignPlexCycle (order):', error.message);
        req.error(500, error.message);
      }
    });

    // ================================================================
    // [ORDER-CYCLE-IMPORT] Import nel ciclo Plex dell'ordine del ciclo salvato DI QUEL MATERIALE.
    //
    // LA REGOLA: il ciclo che qualcuno ha costruito nella tab «Routing» E' la sorgente; Plex e'
    // solo una VERIFICA e il collegamento all'operazione d'ordine un ARRICCHIMENTO. Prima l'import
    // scartava il ciclo salvato in tre punti — pretendeva il collegamento manuale, buttava
    // l'operazione quando quel collegamento non compariva fra quelle dell'ordine, e cedeva
    // l'elenco a Plex quando la part aveva gia' part-operation, facendo sparire le operazioni non
    // ancora trasferite — e quando non importava nulla taceva. Le tre esclusioni insieme rendevano
    // inutile costruire il ciclo. Le regole verificabili senza SAP ne' Plex stanno in
    // srv/lib/orderCycleImportRules.js (test: node test/orderCycleImportRules.test.js).
    //
    // UN IMPORT VUOTO DICE PERCHE': `reason` + `message` localizzato coprono i casi (nessun ciclo
    // salvato, cicli salvati in un altro plant, ciclo fuori perimetro, perimetro non verificabile,
    // testata non arrivata). Un albero vuoto e muto era indistinguibile da un customizing mancante.
    //
    // [ORDER-CYCLE-SEED] DUE COSE SONO CAMBIATE, E VANNO INSIEME.
    //
    //   IL MODELLO SI CERCA PER MATERIALE E PLANT. Prima si cercava sul (gruppo, contatore) che la
    //   testata dell'ordine dichiara, o su quelli che `ProductionRoutingMatlAssgmt` restituisce per
    //   (materiale, plant): un ciclo Plex costruito dalla tab «Cicli» su un altro gruppo/contatore
    //   dello stesso materiale non veniva MAI usato — `savedCycleOtherRouting` era un vicolo cieco
    //   con l'albero vuoto in mano. Ora i candidati sono i cicli salvati del materiale, filtrati
    //   per plant dell'ordine e perimetro cicli, e fra quelli vince il ciclo dell'ordine se c'e',
    //   altrimenti l'ultimo salvato (srv/lib/orderCycleSeed.js, `resolveModel`).
    //
    //   LA SCRITTURA C'E', MA SOLO NEL VUOTO. Con `Persist` il ciclo importato viene scritto
    //   sull'ordine se e solo se l'ordine non ne ha ancora uno: e' l'innesco automatico
    //   (apertura pagina a ciclo vuoto, job PROD_ORDER). «Importa dal Ciclo» a mano continua a NON
    //   scrivere — la' si sostituisce un albero che qualcuno ha salvato, e il Salva resta l'atto
    //   esplicito. Il divieto di 0007 RB-09 vale ancora dove serve.
    // ================================================================
    this.on('autoImportPlexCycle', async (req) => {
      const { ManufacturingOrder, Persist } = req.data;
      console.log(`>>> autoImportPlexCycle: order=${ManufacturingOrder}, persist=${!!Persist}`);

      /** Risposta di un import che non ha prodotto operazioni: SEMPRE con il motivo. */
      const emptyResult = (reason, message) => {
        console.log(`>>> [ORDER-CYCLE-IMPORT] ordine ${ManufacturingOrder}: nessun import`
          + ` (${reason}) — ${message}`);
        return {
          plexRoutingExists: false, operations: [], totalCount: 0, linkedCount: 0,
          unlinkedCount: 0, conflictCount: 0, plexOnlyCount: 0, missingOnPlexCount: 0,
          reason, message,
          modelSource: '', modelRouting: '', persisted: false, workcenterCount: 0
        };
      };

      try {
        const db = await cds.connect.to('db');
        const { ZMatPlexMapping } = db.entities('avvaleplm.marsplm.sap2plex');

        // Step 1: la testata dell'ordine — materiale, plant e le due chiavi interne.
        const { A_ProductionOrderOperation_2 } = this.S4ProdOrder.entities;

        // [ORDER-CYCLE-SEED] La testata passa da `readOrderHeader`, che prova la lettura per
        // chiave e, se quell'indirizzo non consegna la riga, la rilegge come COLLECTION sul root
        // della lista col plant nel filtro. Prima qui c'erano due letture per chiave, la seconda
        // solo come ripiego sul `$select`: sull'ordine 000700000162 la prima rispondeva senza
        // riga, `order.Material` era vuoto e l'import moriva dichiarando l'ordine introvabile —
        // mentre la lista, che legge dall'altro root, ne mostrava materiale e plant.
        //
        // `optionalColumns` sono le due colonne del riferimento al ciclo (BillOfOperationsGroup =
        // ProductionRoutingGroup, BillOfOperations = ProductionRouting): qualche sistema non le
        // espone e il `$select` completo fallisce, quindi si rilegge senza di esse. Non sono
        // indispensabili: da questa modifica il modello si cerca per materiale e plant, e il ciclo
        // dell'ordine serve solo a dare la PRECEDENZA a un candidato.
        // [IS-FULL-KEY] `OrderInternalBillOfOperations` e' la chiave della lettura delle operazioni
        // piu' sotto (DEC-42).
        const hdr = await readOrderHeader(this.S4ProdOrder, ManufacturingOrder, {
          columns: ['ManufacturingOrder', 'OrderInternalBillOfOperations', 'Material', 'ProductionPlant'],
          optionalColumns: ['BillOfOperationsGroup', 'BillOfOperations'],
          require: ['Material'],
          plants: [...(await resolveEffectivePlants(req))]
        });
        const order = hdr.order;
        if (hdr.notes.length) {
          console.log(`>>> [ORDER-CYCLE-SEED] testata ${ManufacturingOrder} (${hdr.shape}): ${hdr.note}`);
        }

        if (!order || !order.Material) {
          return emptyResult(orderCycleImport.EMPTY_REASONS.ORDER_NOT_FOUND,
            getLocalizedMessage(req, 'orderCycleImportOrderNotFound', 'marsplm-sap2plex',
              ManufacturingOrder, hdr.note || ''));
        }

        const sMaterial = order.Material;
        const orderPlant = (order.ProductionPlant || '').trim();
        const rtgGroup = (order.BillOfOperationsGroup || '').trim();
        const rtgCounter = (order.BillOfOperations || '').trim();
        const orderRoutingKey = rtgGroup ? orderCycleImport.cycleKey(rtgGroup, rtgCounter) : '';
        console.log(`>>> autoImport: Material=${sMaterial}, plant=${orderPlant || '(assente)'}`
          + `${orderRoutingKey ? `, order routing=${orderRoutingKey}` : ''}`);

        // ================================================================
        // [ORDER-CYCLE-SEED] IL MODELLO: il ciclo Plex salvato di QUESTO materiale in QUESTO plant.
        //
        // Tutta la scelta sta in `orderCycleSeed.resolveModel`, perche' la stessa scelta la deve
        // fare il job PROD_ORDER, che gira in un altro processo. Il perimetro cicli (0016) resta un
        // cancello e arriva iniettato: un ciclo fuori perimetro non fa da modello nemmeno da questa
        // porta di servizio, e il rifiuto si DICHIARA invece di finire in una riga di console.
        // ================================================================
        const dbScope = await cds.connect.to('db');
        const model = await orderCycleSeed.resolveModel({
          db,
          material: sMaterial,
          plant: orderPlant,
          orderRoutingKey,
          checkScope: (g, r) => checkRoutingInScope(req, dbScope, g, r)
        });
        const savedKeysForMaterial = model.savedKeys || [];
        console.log(`>>> [ORDER-CYCLE-SEED] cicli salvati per il materiale ${sMaterial}:`
          + ` [${savedKeysForMaterial.join(', ')}]`
          + ` | esclusi dal perimetro: [${(model.excludedByScope || []).join(', ')}]`
          + ` | di altri plant: [${(model.rejectedByPlant || []).join(', ')}]`);

        if (!model.ok) {
          const R = orderCycleImport.EMPTY_REASONS;
          const messages = {
            [R.NO_SAVED_CYCLE]: () => getLocalizedMessage(req, 'orderCycleImportNoSavedCycle',
              'marsplm-sap2plex', sMaterial, orderPlant || '-'),
            [R.SAVED_OTHER_PLANT]: () => getLocalizedMessage(req, 'orderCycleImportSavedOtherPlant',
              'marsplm-sap2plex', sMaterial, savedKeysForMaterial.join(', '), orderPlant || '-',
              (model.rejectedByPlant || []).join(', ')),
            [R.SCOPE_UNAVAILABLE]: () => getLocalizedMessage(req, 'orderCycleImportScopeUnavailable',
              'marsplm-sap2plex', (model.excludedByScope || []).join(', '), sMaterial),
            [R.OUT_OF_SCOPE]: () => getLocalizedMessage(req, 'orderCycleImportOutOfScope',
              'marsplm-sap2plex', (model.excludedByScope || []).join(', '), sMaterial),
            [R.SAVED_OTHER_ROUTING]: () => getLocalizedMessage(req, 'orderCycleImportOtherRouting',
              'marsplm-sap2plex', sMaterial, savedKeysForMaterial.join(', '), orderRoutingKey),
            [R.NO_ROUTING_LINKED]: () => getLocalizedMessage(req, 'orderCycleImportNoRouting',
              'marsplm-sap2plex', ManufacturingOrder, sMaterial, savedKeysForMaterial.join(', '))
          };
          const compose = messages[model.reason] || messages[R.NO_SAVED_CYCLE];
          return emptyResult(model.reason, compose());
        }

        const modelRows = model.modelRows;
        console.log(`>>> [ORDER-CYCLE-SEED] modello: ${modelRows.length} operazioni salvate dal ciclo`
          + ` ${model.routingKey} (${model.source}) per il materiale ${sMaterial}`
          + (model.discarded.length ? ` | altri cicli ammessi e scartati: ${model.discarded.join(', ')}` : ''));

        // Step 2: Resolve Material → PlexId via ZMatPlexMapping
        // [MAT-PLANT-PAIR] Sul plant del ciclo scelto come modello, con l'ordine come ripiego: e'
        // la STESSA precedenza gia' usata poco sotto per la connessione Plex, e i due coincidono
        // per costruzione (un candidato di un altro plant e' gia' stato scartato da `resolveModel`).
        // Ricomporla due volte sarebbe l'occasione di farle divergere.
        const cyclePlant = matPlantRules.keyPart(model.plantOfModel || orderPlant);
        const mapping = await db.run(
          SELECT.one.from(ZMatPlexMapping).where({ Product: sMaterial, Plant: cyclePlant })
        );

        // ================================================================
        // [ORDER-CYCLE-IMPORT] PLEX E' UNA VERIFICA, NON LA SORGENTE.
        // Prima, quando la part aveva part-operation su Plex, l'elenco delle operazioni veniva da
        // Plex e il ciclo salvato forniva solo le etichette: un'operazione costruita e non ancora
        // sincronizzata SPARIVA dall'albero dell'ordine. Ora la lettura resta ma serve solo a
        // dichiarare le due differenze (operazioni solo su Plex, operazioni del ciclo non ancora
        // su Plex). `null` = «non ho potuto sapere», e non produce alcun confronto: il guasto
        // della lettura Plex non svuota l'import.
        // ================================================================
        let plexPartOps = null;
        let plexNote = '';

        if (mapping && mapping.PlexId) {
          console.log(`>>> autoImport: PlexId=${mapping.PlexId}, fetching part-operations...`);

          try {
            // [PLEX-CONN] Il plant su cui si legge Plex e' quello del ciclo scelto come modello,
            // che `resolveModel` restituisce dalla testata del ciclo; l'ordine e' il ripiego,
            // perche' i due coincidono per costruzione (il candidato di un altro plant e' scartato).
            const { baseUrl, consumerKey } = await loadPlexConnection(req, cyclePlant);
            const partOpsUrl = `${baseUrl}/mdm/v1/part-operations?partId=${encodeURIComponent(mapping.PlexId)}`;
            console.log(`>>> autoImport: calling ${partOpsUrl}`);

            const response = await fetch(partOpsUrl, {
              method: 'GET',
              headers: {
                'Accept': 'application/json',
                'X-Plex-Connect-Api-Key': consumerKey
              }
            });

            if (response.ok) {
              const data = await response.json();
              const rawOps = Array.isArray(data) ? data : (data.value || data.results || []);
              plexPartOps = rawOps.map(op => op.operationId || op.id || '').filter(Boolean);
              console.log(`>>> autoImport: PLEX part-operations returned ${plexPartOps.length} operations`);
            } else {
              plexNote = `lettura part-operation Plex: HTTP ${response.status}`;
              console.log(`>>> [ORDER-CYCLE-IMPORT] ${plexNote} — confronto con Plex non fatto`);
            }
          } catch (plexErr) {
            plexNote = `lettura part-operation Plex non riuscita: ${plexErr.message}`;
            console.error(`>>> [ORDER-CYCLE-IMPORT] ${plexNote}`);
          }
        } else {
          // [MAT-PLANT-PAIR] Il plant si NOMINA. «Non mappato» e «non mappato SU QUESTO PLANT» sono
          // due cose con rimedi diversi — mandare il materiale a Plex per quel plant, oppure
          // guardare la connessione — e dopo la 0039 la seconda e' quella frequente. Resta un caso
          // non bloccante: qui Plex e' una verifica, non la sorgente (vedi il blocco qui sopra).
          plexNote = `materiale non e' una part sul plant ${cyclePlant || '(assente)'}:`
            + ' confronto con Plex non fatto';
          console.log(`>>> [ORDER-CYCLE-IMPORT] ${plexNote}`);
        }

        // Step 4: Fetch production order operations from SAP
        // [IS-QUERYGET-OPS] In IS la lettura è una collection filtrata sull'AUFPL (della testata
        // letta allo step 1) e il numero d'ordine NON è spinto: si verifica sulle righe lette, per
        // cui va chiesto nel $select. In ONPREM è il filtro sul numero d'ordine di sempre
        // (DEC-45 per la forma, DEC-42 per l'origine della chiave).
        const opsKeys = {
          ManufacturingOrder, // il numero della richiesta, come prima del rilascio
          OrderInternalBillOfOperations: order?.OrderInternalBillOfOperations
        };
        const opsWhere = operationsFilter(this.S4ProdOrder.mode, opsKeys);
        // [ORDER-CYCLE-IMPORT] `null` = operazioni dell'ordine NON leggibili, e allora i
        // collegamenti salvati si conservano senza verifica invece di essere azzerati tutti: una
        // lettura non fatta non deve far perdere, al primo salvataggio, un collegamento che
        // qualcuno aveva stabilito a mano. Prima questo caso restituiva un albero vuoto.
        let prodOrderOpIds = null;
        let opsNote = '';
        if (!opsWhere) {
          // [IS-QUERYGET-OPS] Senza l'AUFPL non resta alcun criterio contrattato su questo
          // indirizzo: lo si dice, invece di mandare una richiesta persa (DEC-45).
          opsNote = `AUFPL non disponibile sulla testata dell'ordine ${ManufacturingOrder}:`
            + ' le operazioni SAP non sono leggibili su questo canale';
          console.warn(`>>> [ORDER-CYCLE-IMPORT] ${opsNote}`);
        } else {
          try {
            const sapOpRows = await this.S4ProdOrder.run(
              SELECT.from(A_ProductionOrderOperation_2)
                .columns('ManufacturingOrder', 'ManufacturingOrderOperation')
                .where(opsWhere)
                // [ORDER-TOP] Il tetto c'e' perche' zero operazioni, qui, si legge come «l'ordine
                // non ne ha»: un troncamento muto diventa un dato di fatto sbagliato. (Che senza
                // `$top` questo root renda zero righe e' un'IPOTESI NON CONFERMATA — la causa
                // attribuita allo zero di `PROD_ORDER` il 02/09/2026, poi smentita dal run col
                // tetto a bordo: vedi la testata di srv/lib/prodOrderSource.js.)
                .limit(prodOrderSource.DETAIL_MAX_ROWS.operations)
            );
            const own = keepOperationsOfOrder(this.S4ProdOrder.mode, opsKeys, sapOpRows);
            if (own.dropped) {
              console.warn(`>>> autoImport: scartate ${own.dropped} operazioni di ALTRI ordini`
                + ' (il numero d\'ordine non è spinto su questo indirizzo: il filtro è il solo AUFPL)');
            }
            prodOrderOpIds = own.kept.map(op => op.ManufacturingOrderOperation);
            console.log(`>>> autoImport: ${prodOrderOpIds.length} SAP prod order operations: [${prodOrderOpIds.join(', ')}]`);
          } catch (e) {
            opsNote = `lettura operazioni dell'ordine non riuscita: ${e.message}`;
            console.error(`>>> [ORDER-CYCLE-IMPORT] ${opsNote}`);
          }
        }

        // ================================================================
        // [ORDER-CYCLE-IMPORT] Step 5: il ciclo importato.
        // Un solo ramo, al posto del caso A / caso B di prima: la sorgente e' sempre il ciclo
        // salvato, e Plex non la sostituisce mai. Regole pure in
        // srv/lib/orderCycleImportRules.js.
        // ================================================================
        // [ORDER-CYCLE-SEED] Componenti e work center del ciclo scelto li ha già letti
        // `resolveModel`, con la chiave COMPLETA (gruppo e contatore) invece del solo gruppo: un
        // contatore diverso è un altro ciclo, con un'altra distinta.
        // ================================================================
        // [COMP-ORPHAN] I componenti che l'ORDINE ha davvero (0037).
        //
        // E' qui che l'orfano nasce: il ciclo porta i componenti del MATERIALE — la distinta — e un
        // ordine puo' averne meno. La lettura passa dal punto unico condiviso con
        // l'auto-assegnazione, e a differenza di quella NON fa fallire l'import: se i componenti non
        // sono leggibili si copia tutto e lo si DICHIARA, perche' potare su una lettura non riuscita
        // svuoterebbe l'albero. Non letto non e' vuoto.
        // ================================================================
        let orderCompKeys = null;
        let orderCompNote = '';
        try {
          const loadedComps = await loadCockpitOrderComponents({
            ManufacturingOrder, order, plant: orderPlant,
            tag: `import ciclo ordine ${ManufacturingOrder}`
          });
          if (loadedComps.ok) {
            orderCompKeys = orderBomAddRules.orderComponentKeys(loadedComps.rows);
          } else {
            orderCompNote = loadedComps.note;
          }
        } catch (compErr) {
          orderCompNote = compErr.message;
        }
        if (orderCompNote) {
          console.warn(`>>> [COMP-ORPHAN] import ciclo ordine ${ManufacturingOrder}: componenti`
            + ` dell'ordine non letti (${orderCompNote}): si copia tutto il ciclo`);
        }

        const built = orderCycleSeed.buildOperations(model, prodOrderOpIds, orderCompKeys);
        const resultOps = built.operations;
        if ((built.orphansDropped || []).length) {
          console.log(`>>> [COMP-ORPHAN] import ciclo ordine ${ManufacturingOrder}:`
            + ` ${built.orphansDropped.length} componenti del ciclo non sono nell'ordine e non sono`
            + ` stati copiati: ${built.orphansDropped.join(', ')}`);
        }
        const plexDiff = orderCycleImport.comparePlexOps(resultOps, plexPartOps);

        console.log(`>>> [ORDER-CYCLE-IMPORT] importate ${resultOps.length} operazioni`
          + ` (${built.linkedCount} collegate, ${built.unlinkedCount} senza collegamento,`
          + ` ${built.conflictCount} conflitti, ${built.workcenterCount} work center)`
          + (built.droppedLinks.length
            ? ` | collegamenti caduti: ${built.droppedLinks.join('; ')}`
            : '')
          + (plexDiff.compared
            ? ` | solo su Plex: ${plexDiff.plexOnly.length}, non ancora su Plex: ${plexDiff.missingOnPlex.length}`
            : ' | confronto con Plex non fatto'));

        // ================================================================
        // [ORDER-CYCLE-SEED] LA SEMINA: si scrive solo nel vuoto, e solo su un plant utilizzabile.
        //
        // Tre condizioni, tutte necessarie. `Persist` — cioè l'innesco automatico, non il pulsante.
        // Nessuna operazione già salvata per l'ordine — un ciclo che qualcuno ha modificato non si
        // sovrascrive da solo. Plant attivo e sotto licenza — è il choke-point di ogni scrittura, e
        // qui NON si usa `rejectIfPlantNotUsable`: un `req.error` trasformerebbe una lettura
        // riuscita in un errore, mentre il ciclo va comunque restituito a chi guarda. Si rinuncia
        // a scrivere e si dichiara.
        // ================================================================
        let persisted = false;
        let seedNote = '';
        if (Persist && resultOps.length > 0) {
          if (await orderCycleSeed.hasSavedCycle(db, ManufacturingOrder)) {
            seedNote = 'ciclo già salvato sull\'ordine: non sovrascritto';
          } else if (!(await isPlantUsable(req, orderPlant))) {
            // [PLANT-ACCESS] Le cause sono ora tre — non attivo, non licenziato, nessun ruolo per
            // chi sta chiedendo — e qui si nominano insieme: distinguerle vorrebbe dire portare il
            // verdetto fin qui, per una nota che non ferma niente.
            seedNote = `plant ${orderPlant || '(assente)'} non nel tuo perimetro:`
              + ' ciclo non salvato';
          } else {
            const written = await orderCycleSeed.seedOrderCycle({
              db, ManufacturingOrder, operations: resultOps
            });
            persisted = true;
            console.log(`>>> [ORDER-CYCLE-SEED] ordine ${ManufacturingOrder}: ciclo salvato`
              + ` (${written.operations} operazioni, ${written.components} componenti,`
              + ` ${written.workcenters} work center) dal ciclo ${model.routingKey}`);
          }
          if (seedNote) console.log(`>>> [ORDER-CYCLE-SEED] ordine ${ManufacturingOrder}: ${seedNote}`);
        }

        // Il messaggio: l'esito, piu' ogni cosa che si e' dovuta dichiarare. Le avvertenze si
        // ACCODANO invece di sostituire l'esito, perche' un import riuscito con un'avvertenza
        // resta un import riuscito.
        const parts = [getLocalizedMessage(req, 'orderCycleImportDone', 'marsplm-sap2plex',
          resultOps.length, `${model.group}/${model.routing}`, sMaterial,
          built.linkedCount, built.unlinkedCount)];
        if (!built.linksVerified) {
          parts.push(getLocalizedMessage(req, 'orderCycleImportLinksUnverified', 'marsplm-sap2plex',
            opsNote));
        }
        // [COMP-ORPHAN] Un albero piu' povero del ciclo da cui viene si SPIEGA (0037), e le due
        // notizie sono diverse: «l'ordine non li ha» e «non ho potuto verificare» hanno rimedi
        // opposti, quindi hanno due chiavi.
        if ((built.orphansDropped || []).length) {
          parts.push(getLocalizedMessage(req, 'orderCycleImportOrphans', 'marsplm-sap2plex',
            built.orphansDropped.length, built.orphansDropped.slice(0, 5).join(', ')));
        }
        if (orderCompNote) {
          parts.push(getLocalizedMessage(req, 'orderCycleImportCompsUnread', 'marsplm-sap2plex'));
        }
        if (built.conflictCount > 0) {
          parts.push(getLocalizedMessage(req, 'orderCycleImportConflicts', 'marsplm-sap2plex',
            built.conflictCount, built.conflicts.join('; ')));
        }
        if (built.droppedLinks.length > 0) {
          parts.push(getLocalizedMessage(req, 'orderCycleImportDroppedLinks', 'marsplm-sap2plex',
            built.droppedLinks.length, built.droppedLinks.join('; ')));
        }
        if (plexDiff.compared) {
          if (plexDiff.plexOnly.length > 0 || plexDiff.missingOnPlex.length > 0) {
            parts.push(getLocalizedMessage(req, 'orderCycleImportPlexDiff', 'marsplm-sap2plex',
              plexDiff.plexOnly.length, plexDiff.missingOnPlex.length));
          }
        } else {
          parts.push(getLocalizedMessage(req, 'orderCycleImportPlexUnknown', 'marsplm-sap2plex',
            plexNote));
        }
        // [ORDER-CYCLE-SEED] Un modello che NON e' il ciclo dell'ordine si dichiara: l'albero e'
        // legittimo — e' il ciclo salvato per quel materiale in quel plant — ma chi guarda deve
        // sapere che non viene dal (gruppo, contatore) che l'ordine dichiara.
        if (model.source === orderCycleImport.MODEL_SOURCES.MATERIAL_PLANT_CYCLE) {
          parts.push(getLocalizedMessage(req, 'orderCycleImportFromMaterialCycle', 'marsplm-sap2plex',
            model.routingKey, sMaterial, orderPlant || '-', orderRoutingKey || '-'));
        }
        if (persisted) {
          parts.push(getLocalizedMessage(req, 'orderCycleImportSeeded', 'marsplm-sap2plex',
            resultOps.length, built.workcenterCount));
        } else if (seedNote) {
          parts.push(getLocalizedMessage(req, 'orderCycleImportNotSeeded', 'marsplm-sap2plex',
            seedNote));
        }
        const msg = parts.join(' ');

        return {
          // Conservato per compatibilita' del contratto: dice se la part ha operazioni su Plex,
          // e non decide piu' nulla sull'import.
          plexRoutingExists: Array.isArray(plexPartOps) && plexPartOps.length > 0,
          operations: resultOps,
          totalCount: resultOps.length,
          linkedCount: built.linkedCount,
          unlinkedCount: built.unlinkedCount,
          conflictCount: built.conflictCount,
          plexOnlyCount: plexDiff.plexOnly.length,
          missingOnPlexCount: plexDiff.missingOnPlex.length,
          reason: orderCycleImport.IMPORTED,
          message: msg,
          modelSource: model.source,
          modelRouting: `${model.group}/${model.routing}`,
          persisted,
          workcenterCount: built.workcenterCount
        };
      } catch (error) {
        console.error('>>> ERROR autoImportPlexCycle:', error.message);
        req.error(500, error.message);
      }
    });
  }

  // ================================================================
  // PRODUCTION ROUTING SERVICE - SAP S/4HANA Production Routing API
  // Handles: /production-routings/Routings (OData endpoint)
  // Source:  OP_API_PRODUCTION_ROUTING_0003 (external OData v2 API)
  //          [IS-ROUTING-LIST] eccezione: la sola LISTA (READ Routings) passa da
  //          this.S4RoutingList, che legge dagli iFlow di SAP Integration Suite.
  //          Tutto il resto usa this.S4Routing (gateway on-premise).
  // UI:     DashboardNavigation -> RoutingsTab fragment
  // ================================================================
  if (this.name === 'ProductionRouting') {

    // ================================================================
    // [IS-SOURCE] Sorgente dell'area cicli (feature 0013). Assorbe il lotto 1
    // [IS-ROUTING-LIST], che serviva la sola LISTA: ORA TUTTA l'area passa da qui —
    // lista, tab del dettaglio, action, ricerca dati di test e job.
    // Espone entities + run(query) come un servizio remoto, ma instrada ogni coppia
    // (entity, operazione) sul proprio service root e spezza le liste `in` troppo lunghe.
    // Attiva per default: nessuna variabile d'ambiente da impostare.
    // Rollback: ROUTING_SOURCE=ONPREM (o l'alias storico ROUTING_LIST_SOURCE=ONPREM,
    // ancora onorato: DEC-21) -> stessi risultati di prima.
    // Vedi srv/lib/routingSource.js e specs/0013-collegamento-path-is/
    // ================================================================
    this.S4Routing = await routingSource();
    // [IS-ROUTING-LIST] alias conservato: i blocchi marcati del lotto 1 restano leggibili
    // e grep-abili senza toccarli. È lo STESSO oggetto, non una seconda connessione.
    this.S4RoutingList = this.S4Routing;

    // GET /production-routings/routingListDiag()
    // Rifa' le letture della lista SENZA nessun filtro in memoria e restituisce l'esito, cosi'
    // dal browser si distinguono i casi che altrimenti appaiono tutti come lista vuota:
    // chiamata fallita (error), 200 vuoto (headerRows=0), righe arrivate ma scartate dal filtro
    // plant (plantsAllowed != plantsInData).
    // [ROUTING-BY-MATERIAL] Sonda ANCHE l'assegnazione materiale, che e' la spina della lista.
    // Fermarsi alla testata e' la ragione per cui la colonna Materiale vuota e' rimasta
    // invisibile: la lettura MAPL rispondeva 200 con results vuoto e nessuno lo diceva.
    this.on('routingListDiag', async (req) => {
      const { ProductionRoutingHeader, ProductionRoutingMatlAssgmt } = this.S4RoutingList.entities;
      const out = {
        mode: this.S4RoutingList.mode,
        paths: '',
        headerRows: 0,
        error: '',
        firstRow: '',
        plantsAllowed: '',
        plantsInData: '',
        filterSent: '',
        testDataFilter: process.env.USE_TEST_DATA_FILTER === 'true'
          ? 'true -> la lista filtra sui 17 gruppi hardcoded, NON sui plant'
          : '(non impostata) -> la lista filtra sui plant Active+licenziati',
        matlRows: 0,
        matlError: '',
        matlFirstRow: '',
        matlFilterSent: '',
        matlPlantsInData: '',
        joinStats: '',
        listRows: 0,
        routingFilterRules: '',
        routingFilterExcluded: ''
      };

      const dh = this.S4RoutingList.describe(SELECT.from(ProductionRoutingHeader));
      const dm = this.S4RoutingList.describe(SELECT.from(ProductionRoutingMatlAssgmt));
      out.paths = `header=${dh.path || '(gateway on-prem)'} | matlAssgmt=${dm.path || '(gateway on-prem)'}`;

      // Stessa risoluzione plant della lista, cosi' la diagnostica manda la STESSA
      // query e riproduce l'esito reale invece di una chiamata che non esiste piu'.
      const useTestData = process.env.USE_TEST_DATA_FILTER === 'true';
      let diagPlants = null;
      try {
        diagPlants = useTestData ? null : await resolveEffectivePlants(req);
        out.plantsAllowed = JSON.stringify(diagPlants ? [...diagPlants] : []);
      } catch (e) {
        out.plantsAllowed = `ERRORE: ${e.message}`;
      }

      let rows;
      try {
        const q = SELECT.from(ProductionRoutingHeader)
          .columns(
            'ProductionRoutingGroup', 'ProductionRouting', 'LastChangeDate', 'ChangedDateTime',
            'CreationDate', 'BillOfOperationsDesc', 'BillOfOperationsStatus',
            'ResponsiblePlannerGroup', 'PlanningWorkCenter', 'Plant'
          )
          .limit(10000);
        if (diagPlants && diagPlants.size) {
          q.where({ Plant: { in: [...diagPlants] } });
          out.filterSent = `Plant in (${[...diagPlants].join(', ')})`;
          rows = await this.S4RoutingList.run(q);
        } else if (useTestData) {
          // La leva di test spegne il gate per costruzione: qui la diagnostica riproduce cio' che
          // la lista fa davvero, e la lista in quel ramo non filtra.
          out.filterSent = '(nessuno: USE_TEST_DATA_FILTER attivo, il gate plant non si applica)';
          rows = await this.S4RoutingList.run(q);
        } else {
          // [PLANT-ACCESS] PERIMETRO VUOTO: NON SI LEGGE (feature 0048).
          //
          // Questa query non ha un `where` sul plant, e fino alla 0048 con zero plant partiva
          // COSI', con `limit(10000)`: era innocuo perche' «zero plant» significava «nessun plant
          // licenziato». Ora significa anche «questo utente non ha nessun ruolo», e una
          // diagnostica non puo' essere la strada da cui chi non ha accesso a niente legge i cicli
          // di tutti. Si dichiara e non si legge — la forma di `plexHistoryProbe`, che su perimetro
          // vuoto rende una riga «OFF» invece di un errore.
          out.filterSent = '(nessuno: nessun plant nel tuo perimetro — lettura NON eseguita)';
          rows = [];
        }
      } catch (e) {
        // ATTENZIONE: e.statusCode e' 502 per QUALUNQUE fallimento remoto - lo normalizza
        // CAP, non e' lo stato restituito da CPI. Quello vero e' annidato nella causa.
        const upstream = e.reason?.response?.status ?? e.reason?.status;
        out.error = `${e.message}`
          + (upstream ? ` [stato reale upstream: ${upstream}]` : '')
          + (e.statusCode ? ` (${e.statusCode} = codice normalizzato da CAP, ignoralo)` : '');
        console.error('>>> [IS-ROUTING-LIST] routingListDiag: lettura header FALLITA:', out.error);
        return out;
      }

      out.headerRows = Array.isArray(rows) ? rows.length : rows ? 1 : 0;
      if (out.headerRows) {
        out.firstRow = JSON.stringify(rows[0]).slice(0, 500);
        out.plantsInData = JSON.stringify(
          [...new Set(rows.map(r => (r.Plant === '' || r.Plant == null) ? '(vuoto)' : r.Plant))]
        );
      }

      // ================================================================
      // [ROUTING-BY-MATERIAL] La spina: l'assegnazione materiale, con LO STESSO filtro della
      // lista. Se `matlRows` e' 0 mentre `headerRows` non lo e', la colonna Materiale sara' vuota
      // e la causa e' qui, non nel join: e' esattamente lo stato da cui questa feature parte.
      // `matlFirstRow` e' il posto dove si vede come la funzione ABAP rende `PLNAL` — se qui
      // uscisse '1' e nella testata '01', il join mancherebbe malgrado le righe ci siano.
      // ================================================================
      const matlPlants = diagPlants
        ? [...diagPlants]
        : [...new Set((rows || []).map(r => routingMaterialRules.keyPart(r.Plant)).filter(Boolean))];
      let matlRows = [];
      if (matlPlants.length === 0) {
        out.matlFilterSent = '(nessuno: nessun plant da mandare, la lettura non e\' stata eseguita)';
      } else {
        out.matlFilterSent = `Plant in (${matlPlants.join(', ')})`;
        try {
          matlRows = await this.S4RoutingList.run(
            SELECT.from(ProductionRoutingMatlAssgmt)
              .columns('ProductionRoutingGroup', 'ProductionRouting', 'Product', 'Plant',
                'ValidityStartDate', 'ValidityEndDate')
              .where({ Plant: { in: matlPlants } })
              .limit(10000)
          );
          out.matlRows = Array.isArray(matlRows) ? matlRows.length : matlRows ? 1 : 0;
          if (out.matlRows) {
            out.matlFirstRow = JSON.stringify(matlRows[0]).slice(0, 500);
            out.matlPlantsInData = JSON.stringify(
              [...new Set(matlRows.map(r => (r.Plant === '' || r.Plant == null) ? '(vuoto)' : r.Plant))]
            );
          }
        } catch (e) {
          const upstream = e.reason?.response?.status ?? e.reason?.status;
          out.matlError = `${e.message}` + (upstream ? ` [stato reale upstream: ${upstream}]` : '');
          console.error('>>> [ROUTING-BY-MATERIAL] routingListDiag: lettura MAPL FALLITA:', out.matlError);
        }
      }

      // L'esito del join, che dice QUALE scarto ha ridotto la lista.
      const joined = routingMaterialRules.joinRoutingRows({
        matlRows: Array.isArray(matlRows) ? matlRows : [],
        headers: rows || [],
        plantsInScope: diagPlants ? [...diagPlants] : null,
        today: new Date().toISOString().slice(0, 10)
      });
      out.joinStats = JSON.stringify(joined.stats);
      out.listRows = joined.rows.length;

      // [ROUTING-FILTER] L'effetto del filtro di visibilita': dopo la 0016 «lista vuota» ha una
      // causa in piu', e senza queste due righe sarebbe indistinguibile dalle altre.
      try {
        const dbDiag = await cds.connect.to('db');
        const rules = await routingVisibility.loadRoutingFilterConfig(dbDiag);
        out.routingFilterRules = routingVisibility.describeRules(rules);
        const f = routingVisibility.applyRoutingFilter(joined.rows, rules);
        out.routingFilterExcluded = f.stats.plantsWithRules.length
          ? `${f.stats.excluded} righe escluse su ${f.stats.in}; coppie rifiutate: `
            + (f.stats.rejectedPairs.length
              ? f.stats.rejectedPairs.map(p => `${p.Plant}/stato=${p.BillOfOperationsStatus || '(vuoto)'}`
                + `/uso=${p.BillOfOperationsUsage || '(vuoto)'} x${p.count}`).join(', ')
              : '(nessuna)')
          : '(nessun filtro configurato: nessuna riga esclusa)';
        out.listRows = f.stats.kept;
      } catch (e) {
        out.routingFilterRules = `ERRORE: ${e.message}`;
      }

      console.log(`>>> [IS-ROUTING-LIST] routingListDiag: mode=${out.mode} headerRows=${out.headerRows}`
        + ` filtro=[${out.filterSent}] plantsAllowed=${out.plantsAllowed} plantsInData=${out.plantsInData}`);
      console.log(`>>> [ROUTING-BY-MATERIAL] routingListDiag: matlRows=${out.matlRows}`
        + ` filtro=[${out.matlFilterSent}] listRows=${out.listRows} join=${out.joinStats}`
        + (out.matlError ? ` matlError=${out.matlError}` : ''));
      console.log(`>>> [ROUTING-FILTER] routingListDiag: regole=[${out.routingFilterRules}]`
        + ` esclusioni=[${out.routingFilterExcluded}]`);
      return out;
    });
    // ================================================================
    // [IS-ROUTING-LIST] fine
    // ================================================================

    // [W1-05] IL RIPIEGO, NON IL RISULTATO. Erano i valori che il progetto mandava a Plex su OGNI
    // riga di distinta, perché il modello routing v3 non espone `STPO-MENGE` / `STPO-MEINS`. Ora
    // quantità e unità arrivano dalla DISTINTA (`prepareRoutingComponents`), e questi due restano
    // solo dove il nodo non si risolve — un caso che si conta, si logga e degrada il recap del job.
    // Non si eliminano: sono anche ciò che garantisce i due campi presenti su ogni riga del payload,
    // così un client non deve distinguere «assente» da «non risolto».
    const DEFAULT_COMP_QTY = 1;
    const DEFAULT_COMP_UNIT = '';

    // ================================================================
    // [ROUTING-BY-MATERIAL] READ /production-routings/Routings
    //
    // UNA RIGA PER (ciclo, materiale). La spina e' l'ASSEGNAZIONE MATERIALE
    // (`ProductionRoutingMatlAssgmt` = `MAPL`), che E' GIA' l'insieme espanso, e la testata e'
    // l'arricchimento. Prima era il contrario: si paginavano le testate e POI si cercavano i
    // materiali dei soli gruppi di pagina, unendoli in una stringa separata da virgola.
    //
    // DUE COSE SONO CAMBIATE, E LA SECONDA DIPENDE DALLA PRIMA.
    //
    // 1. LA LETTURA MAPL PASSA IL PLANT. Filtrata per solo gruppo rispondeva `200` con
    //    `{"d":{"results":[]}}` — rotta giusta, wrapper riconosciuto, ZERO righe — e l'handler
    //    trasformava quel vuoto in `Material: ''` su ogni riga della lista. Il criterio che la
    //    funzione ABAP dietro l'iFlow pretende e' il PLANT (`SO_PLANT`, obbligatorio nella sua
    //    firma), mentre il gruppo (`SO_PRODUCTION_ROUTING_GROUP`) e' opzionale. Il precedente e'
    //    `findRoutingTestData`, che legge la stessa entity col plant e il cui commento dice che il
    //    perimetro plant «e' anche il criterio che le funzioni dietro gli iFlow richiedono».
    //    NON rimettere il filtro per gruppo pensando di contenere i volumi: e' la forma che non
    //    restituisce nulla.
    //
    // 2. LA PAGINAZIONE E' L'ULTIMO PASSO. Prima era a metà, ed era il motivo per cui
    //    l'arricchimento poteva limitarsi ai gruppi di pagina. Con una riga per materiale il
    //    numero di righe non e' noto finche' il join non e' fatto, quindi `$count` e `$skip`
    //    devono venire dopo. Da qui la lettura MAPL per plant in UNA chiamata invece di una per
    //    chunk di 15 gruppi.
    //
    // Regole pure e loro test: srv/lib/routingMaterialRules.js, test/routingMaterialRules.test.js
    // ================================================================
    this.on('READ', 'Routings', async (req) => {
      console.log('>>> READ Routings (una riga per ciclo+materiale)');

      // [IS-ROUTING-LIST] entities dalla sorgente della lista (gli oggetti CSN sono gli stessi
      // di this.S4Routing). ProductionRoutingOperation non serve piu' qui: vedi Step 5.
      const { ProductionRoutingHeader, ProductionRoutingMatlAssgmt } = this.S4RoutingList.entities;
      const { top, skip, wantCount, orderBy } = readPaging(req, { defTop: 100 });

      // ================================================================
      // [IS-ROUTING-LIST] Plant Active+licenziati risolti QUI, prima della lettura, per poterli
      // spingere nel $filter di ENTRAMBE le query (testata e assegnazione). Il set e' poi riusato
      // dal gate in memoria dentro joinRoutingRows, quindi la risoluzione licenza resta una sola
      // per richiesta.
      // Nel ramo USE_TEST_DATA_FILTER il gate plant non si applica (il perimetro sono i 17 gruppi
      // cablati), ma la lettura MAPL ha bisogno del plant COMUNQUE: li' i plant si ricavano dalle
      // testate sopravvissute al filtro dei gruppi (Step 2).
      // ================================================================
      const useTestData = process.env.USE_TEST_DATA_FILTER === 'true';
      const effectivePlants = useTestData ? null : await resolveEffectivePlants(req);
      if (effectivePlants && effectivePlants.size === 0) {
        console.log('>>> No plants in scope; returning no routings');
        const empty = [];
        if (wantCount) empty.$count = 0;
        return empty;
      }
      // ================================================================
      // [IS-ROUTING-LIST] fine
      // ================================================================

      // Step 1: Query routing HEADERS. This service (cds_api_productionrouting) has no
      // top-level ProductionRouting entity; the header carries Group/Routing + dates.
      // Header key includes ProductionRoutingInternalVers, so the (Group, Routing) pair repeats:
      // the dedupe (keep first version) is inside joinRoutingRows.
      // High cap so newly created routings are within the fetched universe (the ZFM-based
      // service is not relied on for $skip/$orderby — paging is done in memory below).
      let headerResults;
      try {
        // NOTE: the incoming SEARCH $filter is applied IN MEMORY below (see searchMatch),
        // not pushed to the external routing API: that OData v2 service does not handle an
        // OR of substringof() across fields (it silently returns 0).
        // [IS-ROUTING-LIST] Il filtro sui PLANT invece SI', vedi sotto: quello e' un OR di
        // eq, che il servizio gestisce, e riduce il volume di un ordine di grandezza.
        const qHeader = SELECT.from(ProductionRoutingHeader)
          .columns(
            'ProductionRoutingGroup',
            'ProductionRouting',
            'LastChangeDate',
            'ChangedDateTime',
            'CreationDate',
            'BillOfOperationsDesc',
            'BillOfOperationsStatus',
            // [ROUTING-FILTER] L'utilizzo (PLNAW): secondo criterio del filtro di visibilita' per
            // plant, e colonna della lista. E' fra i 24 campi che ET_HEADER restituisce.
            'BillOfOperationsUsage',
            'ResponsiblePlannerGroup',
            'PlanningWorkCenter', // [IS-ROUTING-LIST] sostituisce la query su ProductionRoutingOperation (Step 5)
            'Plant',
            // [ROUTING-BY-MATERIAL] Il flag di cancellazione del CICLO. Esiste solo qui: sulla
            // assegnazione (`MAPL-LOEKZ`) l'endpoint non lo espone, vedi Step 3.
            'IsMarkedForDeletion'
          )
          .limit(10000);
        // [IS-ROUTING-LIST] Prima questa query non aveva ALCUN $filter: scaricava l'intero
        // universo delle testate per poi buttarne la quasi totalita' in memoria. Ed e' anche
        // la forma che fa fallire l'iFlow di Integration Suite (uno script che dereferenzia
        // un getFilter() null). Le righe scartate qui non arrivano nemmeno sulla rete.
        if (effectivePlants) qHeader.where({ Plant: { in: [...effectivePlants] } });
        headerResults = await this.S4RoutingList.run(qHeader); // [IS-ROUTING-LIST]
        console.log(`>>> Retrieved ${headerResults.length} routing headers`);
      } catch (error) {
        console.error(`>>> ERROR querying ProductionRoutingHeader:`, error.message);
        return [];
      }
      if (headerResults.length === 0) {
        const empty = [];
        if (wantCount) empty.$count = 0;
        return empty;
      }

      // ================================================================
      // [IS-BLANK-ROWS] Testate prive di identità: senza questa guardia una risposta `200` tutta
      // a valori iniziali sarebbe silenziata due volte — dal dedupe (che collassa tutte le righe
      // vuote in una) e dal gate plant (che la scarta, `Plant` vuoto) — e la lista uscirebbe
      // vuota come se non ci fossero cicli.
      // `dedupe: false`: qui la ripetizione della coppia (Group, Routing) è NORMALE e voluta,
      // sono le versioni interne della testata, deduplicate dentro joinRoutingRows.
      // ================================================================
      const guard = identityGuard({
        fields: ['ProductionRoutingGroup', 'ProductionRouting'], label: 'Routings', dedupe: false
      });
      headerResults = guard.keep(headerResults);
      const blankMessage = guard.rejectMessage(req);
      if (blankMessage) return req.reject(502, blankMessage);

      // Step 2: nel ramo dei dati di test il perimetro sono i gruppi cablati, non i plant.
      const TEMP_ROUTING_GROUPS = ['41710000','41710001','50000004','50000005','50000006','50000007','50000008','50000018','50000019','50000020','50000021','50000022','50000023','50000024','50000025','50000026','50000170'];
      if (useTestData) {
        headerResults = headerResults.filter(r => TEMP_ROUTING_GROUPS.includes(r.ProductionRoutingGroup));
      }

      // I plant da mandare nel $filter della lettura MAPL. Nel ramo normale sono il perimetro
      // licenza; nel ramo dei dati di test si ricavano dalle testate rimaste, perche' la lettura
      // MAPL ha bisogno del plant in ogni caso (Step 3).
      const matlPlants = effectivePlants
        ? [...effectivePlants]
        : [...new Set(headerResults.map(h => routingMaterialRules.keyPart(h.Plant)).filter(Boolean))];

      // ================================================================
      // Step 3: LA SPINA — assegnazioni materiale (`MAPL`) del perimetro, in UNA chiamata.
      //
      // Il filtro e' sul PLANT e non sul gruppo: vedi il blocco in testa all'handler. Il tetto e'
      // lo stesso della lettura testate (10000) e il troncamento si DICHIARA, perche' una lista
      // troncata in silenzio sarebbe indistinguibile da un perimetro piu' piccolo.
      //
      // NON si filtra per validita' ne' per cancellazione dell'assegnazione:
      //   - `ValidityStartDate`/`ValidityEndDate` ci sono, e le assegnazioni scadute si CONTANO
      //     (joinRoutingRows, `assegnazioniScadute`) ma restano in lista: scaduto non e'
      //     cancellato, e il conteggio serve a decidere con i numeri invece che a intuito;
      //   - `MAPL-LOEKZ` NON e' esposto. L'entity ha 6 chiavi + 11 campi e nessun flag di
      //     cancellazione, e i 17 campi corrispondono esattamente all'export `ET_MATL_ASSGMT`
      //     del FM. Se le righe cancellate arrivano, serve una richiesta al team Integration per
      //     aggiungere `LOEKZ` a `ZPLM_MATL_ASSGMT`. Cio' che si esclude qui e' cosa diversa: il
      //     CICLO cancellato, via `IsMarkedForDeletion` della testata.
      // ================================================================
      const MATL_LIMIT = 10000;
      let matlResults = [];
      let matlError = '';
      if (matlPlants.length === 0) {
        console.log('>>> [ROUTING-BY-MATERIAL] nessun plant per la lettura MAPL: assegnazioni non lette');
      } else {
        try {
          matlResults = await this.S4RoutingList.run( // [IS-ROUTING-LIST]
            SELECT.from(ProductionRoutingMatlAssgmt)
              .columns(
                'ProductionRoutingGroup',
                'ProductionRouting',
                'Product',
                'Plant',
                'ValidityStartDate',
                'ValidityEndDate'
              )
              .where({ Plant: { in: matlPlants } })
              .limit(MATL_LIMIT)
          );
          // [IS-BLANK-ROWS] La guardia copriva le sole testate: un `200` di assegnazioni tutte a
          // valori iniziali passava liscio e produceva righe con materiale vuoto indistinguibili
          // dai cicli che davvero non hanno assegnazioni.
          const matlGuard = identityGuard({
            fields: ['ProductionRoutingGroup', 'ProductionRouting', 'Product'],
            label: 'RoutingMatlAssgmt'
          });
          matlResults = matlGuard.keep(matlResults);
          if (matlGuard.nothingUsable) {
            matlError = 'nessuna assegnazione utilizzabile: la sorgente ha risposto con valori iniziali';
          }
          console.log(`>>> [ROUTING-BY-MATERIAL] MAPL: ${matlResults.length} assegnazioni`
            + ` | filtro=[Plant in (${matlPlants.join(', ')})]`
            + (matlResults.length >= MATL_LIMIT
              ? ` | ATTENZIONE: TRONCATO al tetto di ${MATL_LIMIT}, la lista e' incompleta`
              : ''));
        } catch (error) {
          // Non bloccante: la lista si rende comunque, con i cicli e senza i materiali. Ma
          // l'errore NON resta muto — prima finiva in un console.error e la colonna vuota
          // sembrava «questi cicli non hanno materiali».
          matlError = error.message;
          console.error('>>> [ROUTING-BY-MATERIAL] ERRORE lettura ProductionRoutingMatlAssgmt:'
            + ` ${error.message} — la lista uscira' senza materiali`);
        }
      }

      // ================================================================
      // Step 4: join e unione. Qui vive il gate licenza — il choke-point (cfr. CP0 in testa al
      // file) — che vale sul plant dell'assegnazione E su quello della testata. Il filtro
      // in memoria NON e' ridondante col $filter spinto negli Step 1 e 3: se il servizio remoto
      // ignorasse il $filter, il gate deve valere comunque.
      // Da rimuovere a migrazione conclusa: NO. Il gate resta.
      // ================================================================
      const today = new Date().toISOString().slice(0, 10);
      const { rows: listRows, stats: joinStats } = routingMaterialRules.joinRoutingRows({
        matlRows: matlResults,
        headers: headerResults,
        plantsInScope: effectivePlants ? [...effectivePlants] : null,
        // ================================================================
        // I CICLI SENZA ALCUN MATERIALE RESTANO IN LISTA, con materiale vuoto.
        // Il riscontro sul campo dice cosa sono: la funzione ABAP dietro l'iFlow esclude gia' a
        // monte le assegnazioni cancellate, quindi un ciclo che arriva senza materiali e' un ciclo
        // le cui assegnazioni sono state TUTTE cancellate. Si mostra per quello che e'.
        // Sono anche le uniche righe con chiave OData a valore vuoto: la route del dettaglio le
        // gestisce col segnaposto '-'.
        //
        // Quando entreranno i cicli a fasi (`PLNTY = 'R'`) questa scelta va RIDECISA per tipo, non
        // ereditata: oggi il perimetro e' implicitamente il solo tipo `N` — `TaskListType` non
        // esiste in nessun punto del modello CSN — quindi «cicli N senza materiale» e «cicli senza
        // materiale» sono la stessa frase, e quel giorno non lo saranno piu'.
        // ================================================================
        keepUnassigned: true,
        today
      });
      console.log('>>> [ROUTING-BY-MATERIAL] join: ' + JSON.stringify(joinStats)
        + ` | plant ammessi=[${effectivePlants ? [...effectivePlants] : '(nessun gate: dati di test)'}]`);
      // I cicli nascosti perche' privi di materiale sono l'unico segnale che resta se la lettura
      // MAPL torna vuota: senza questa riga una lista svuotata da un guasto a monte sarebbe
      // indistinguibile da «non ci sono cicli lavorabili». Si dichiara sempre.
      if (joinStats.senzaAssegnazione > 0) {
        const tutti = joinStats.senzaAssegnazione === joinStats.headersDistinct;
        console.warn(`>>> [ROUTING-BY-MATERIAL] ${joinStats.senzaAssegnazione} cicli SENZA materiale`
          + ' assegnato'
          + (tutti
            ? ` — SONO TUTTI (${joinStats.headersDistinct} testate lette, ${joinStats.matlRows}`
              + ' assegnazioni): sospetta la lettura MAPL, non il dato'
            : ` su ${joinStats.headersDistinct} testate`));
      }

      // ================================================================
      // [ROUTING-FILTER] Filtro di visibilita' per stato e utilizzo (feature 0016).
      //
      // Gira QUI: dopo il join e PRIMA di ricerca, ordinamento e paginazione. E' l'unico punto in
      // cui `$count` resta coerente con cio' che si vede — filtrare dopo la paginazione darebbe
      // pagine di dimensione variabile e un totale che non corrisponde.
      //
      // Nessuna regola configurata per un plant => nessuna restrizione su quel plant: chi non
      // configura nulla non deve accorgersi di questa feature.
      //
      // Le righe a materiale VUOTO seguono la stessa sorte: stato e utilizzo sono attributi della
      // TESTATA, quindi il filtro vale per il ciclo, non per la coppia ciclo-materiale.
      // ================================================================
      const dbLocal = await cds.connect.to('db');
      const routingFilterRules = await routingVisibility.loadRoutingFilterConfig(dbLocal);
      const filtered = routingVisibility.applyRoutingFilter(listRows, routingFilterRules);
      if (filtered.stats.plantsWithRules.length) {
        console.log(`>>> [ROUTING-FILTER] regole in vigore -> ${routingVisibility.describeRules(routingFilterRules)}`);
        console.log(`>>> [ROUTING-FILTER] ${filtered.stats.kept} righe tenute,`
          + ` ${filtered.stats.excluded} escluse su ${filtered.stats.in}`);
        // Le coppie rifiutate sono l'unico modo, senza value help sui due codici, di accorgersi
        // che una regola non aggancia perche' il codice e' stato scritto in un'altra forma.
        if (filtered.stats.rejectedPairs.length) {
          const pairs = filtered.stats.rejectedPairs
            .map(p => `${p.Plant}: stato=${p.BillOfOperationsStatus || '(vuoto)'}`
              + `/uso=${p.BillOfOperationsUsage || '(vuoto)'} x${p.count}`)
            .join(' | ');
          console.log(`>>> [ROUTING-FILTER] coppie rifiutate: ${pairs}`);
        }
        if (filtered.stats.kept === 0 && filtered.stats.in > 0) {
          console.warn('>>> [ROUTING-FILTER] il filtro ha svuotato la lista: nessun ciclo soddisfa'
            + ' le regole configurate. Confronta le coppie rifiutate qui sopra con cio\' che hai'
            + ' scritto in configurazione.');
        }
      }
      let distinct = filtered.kept;

      // ================================================================
      // [KEY-READ] L'IDENTITA' della riga chiesta, che NON e' una ricerca (feature 0041).
      //
      // Questo handler non applicava NESSUN criterio di chiave: una lettura per chiave —
      // `Routings(ProductionRoutingGroup='…',ProductionRouting='…',Material='…')` — rendeva la
      // prima pagina del perimetro e CAP ne serviva `result[0]`.
      //
      // Sta in un blocco SEPARATO e non passa da `extractContainsSearch`, che e' la trappola piu'
      // affilata di questa feature: quella funzione raccoglie OGNI `ref` come campo cercabile e
      // OGNI stringa come termine, e il filtro qui sotto tiene la riga se QUALSIASI campo contiene
      // QUALSIASI termine. Dandogli il predicato di chiave, `('50000004', '1', 'MAT-A')`
      // diventerebbe «tieni ogni ciclo in cui un campo contiene `50000004` OPPURE `1` OPPURE
      // `MAT-A`» — con `'1'` fra i termini, praticamente tutto. Un filtro che ALLARGA invece di
      // restringere, senza un errore da nessuna parte.
      //
      // `Material` puo' essere legittimamente VUOTO (l'unica riga con chiave a valore vuoto, vedi
      // la sua dichiarazione in srv/cat-service.cds): `''` e' un valore, non un'assenza.
      //
      // [DETAIL-REREAD] LE UGUAGLIANZE DI CHIAVE SI APPLICANO SU QUALUNQUE LETTURA, non solo su
      // `SELECT.one`. Il gate `keyRead.one` che stava qui lasciava una collection con un `$filter`
      // di uguaglianze — `?$filter=Group eq … and Routing eq … and Material eq …`, che era la forma
      // del ripiego del dettaglio ciclo — in mano al SOLO `extractContainsSearch` qui sotto: una
      // ricerca tollerante in OR che tiene tutte le righe del gruppo. Con lo spareggio
      // `(Group, Routing, Material) asc`, un `$top=1` serviva il materiale piu' BASSO del ciclo, con
      // `200` e nessun log. La scheda mostrava un materiale e le sue azioni ne scrivevano un altro:
      // e' lo stesso difetto della 0041 su un'altra forma di lettura.
      //
      // E' INERTE su cio' che gira oggi, ed e' la ragione per cui la condizione puo' cadere: la
      // lista della dashboard non manda `$filter` (DEC-82, carica l'insieme intero e filtra nel
      // browser), quindi `equals` e' vuoto e `matchesKey` rende `true` per ogni riga; una ricerca
      // manda `contains`, che non e' un'uguaglianza e non entra in `equals`. Una chiave PARZIALE si
      // applica per quello che dichiara — chi manda `Material eq X` sta chiedendo quel materiale.
      // ================================================================
      const keyRead = keyReadRules.keyReadOf(req.query,
        ['ProductionRoutingGroup', 'ProductionRouting', 'Material']);
      if (Object.keys(keyRead.equals).length) {
        const before = distinct.length;
        distinct = distinct.filter((r) => keyReadRules.matchesKey(r, keyRead.equals));
        console.log(`>>> [KEY-READ] Routings per chiave: tenute ${distinct.length} di ${before} righe`
          + ` | ${Object.entries(keyRead.equals).map(([f, v]) => `${f}='${v}'`).join(' ')}`
          + ` | lettura ${keyRead.one ? 'singola' : 'di collection'}, criterio ${keyRead.from}`);
      }

      // Apply the UI search filter IN MEMORY (SearchField -> OR of contains over header
      // fields). Tolerant extraction: collect all fields and terms from the CQN where, then
      // keep a row if ANY field contains ANY term (case-insensitive). Avoids the external
      // v2 API's inability to OR substringof() across fields.
      // [ROUTING-BY-MATERIAL] Gira DOPO il join, quindi `Material` e' fra i campi cercabili.
      // [KEY-READ] Riceve il `where` DI PRIMO LIVELLO, e non il criterio effettivo: e' voluto, ed
      // e' spiegato nel blocco qui sopra. Non sostituire con `readWhere`.
      const { fields: aSearchFields, terms: aSearchTerms } = extractContainsSearch(req.query?.SELECT?.where);
      if (aSearchTerms.length && aSearchFields.length) {
        distinct = distinct.filter(r =>
          aSearchFields.some(f => {
            const v = String(r[f] ?? '').toLowerCase();
            return aSearchTerms.some(t => v.includes(t));
          })
        );
        console.log(`>>> Routings search: fields=[${aSearchFields}] terms=[${aSearchTerms}] -> ${distinct.length} matches`);
      }

      // [ROUTING-BY-MATERIAL] `Material` chiude la catena di spareggio, cosi' le righe dello
      // stesso ciclo restano ADIACENTI e la paginazione e' stabile fra due richieste.
      distinct.sort((orderBy && orderBy.length)
        ? cmpFromCqn(orderBy)
        : byDateDescChain(['ChangedDateTime', 'LastChangeDate', 'CreationDate'],
          ['ProductionRoutingGroup', 'ProductionRouting', 'Material']));

      const total = distinct.length;
      const page = distinct.slice(skip, skip + top);
      if (page.length === 0) {
        const empty = [];
        if (wantCount) empty.$count = total;
        return empty;
      }

      // ================================================================
      // [IS-ROUTING-LIST] Step 5 disattivato: il work center arriva dall'header.
      // Prima si leggeva ProductionRoutingOperation per ricavare il work center
      // della prima operazione (WorkCenterInternalID, che in SAP e' l'ARBID, label
      // "Object ID"). Non e' riproducibile via SAP Integration Suite: l'iFlow
      // Operation e' solo _GET per chiave, e un key predicate non puo' contenere
      // la lista dei gruppi della pagina (fino a 100) — servirebbe una chiamata
      // per routing. Inoltre l'OR espanso di quel { in: [...] } superava i 1028
      // caratteri, quindi CAP lo convertiva in POST /$batch in silenzio.
      // Adesso PlanningWorkCenter viene selezionato direttamente dall'header
      // (Step 1): stesso campo di destinazione, zero chiamate aggiuntive.
      // La colonna e' stata disattivata anche in RoutingsTab.fragment.xml; il
      // campo resta valorizzato per la banda header del dettaglio.
      // Vedi srv/external/PRODUCTION_ROUTING_IS.md
      // ================================================================

      // ================================================================
      // Step 6: la riga di storico che riassume ogni (ciclo, MATERIALE).
      //
      // [ROUTING-BY-MATERIAL] Il log e' per materiale: due materiali dello stesso ciclo possono
      // chiudere con esiti diversi — uno mappato su Plex e l'altro no — e prima l'unica riga per
      // ciclo li sovrascriveva a vicenda. Le righe storiche, migrate con `Material` vuoto, si
      // agganciano alla riga a materiale vuoto e a nessun'altra.
      //
      // [LAST-LOG-WORST-DAY] Si legge `ZRoutingExcLogPOS` e non piu' la testata (feature 0049): la
      // riga mostrata e' la PEGGIORE DEL GIORNO PIU' RECENTE, e su una testata — che di righe ne
      // tiene una — non e' esprimibile. Il verdetto e' puro (srv/lib/lastLogRules.js) e la lettura
      // sta in un punto solo per tutte e tre le liste (srv/lib/lastLog.js), che chiede colonne
      // esplicite e leggere: `ZRoutingExcLogPOS` porta anche i due JSON delle chiamate.
      //
      // Solo le righe di PAGINA: e' l'unica lettura che resta legata alla pagina, ed e' locale.
      // ================================================================
      const syncLogMap = new Map();
      {
        const pageGroups = [...new Set(page.map(r => r.ProductionRoutingGroup))];
        // Il `try` non serve piu' qui: `readLastLogByKey` dichiara il guasto e rende una mappa
        // vuota, cioe' le due colonne nulle — una lista che non si apre perche' il suo log non si
        // legge sarebbe un difetto peggiore.
        const picked = await lastLog.readLastLogByKey(dbLocal, {
          entity: 'avvaleplm.marsplm.sap2plex.ZRoutingExcLogPOS',
          keyColumns: ['ProductionRoutingGroup', 'ProductionRouting', 'Material'],
          scopeColumn: 'ProductionRoutingGroup',
          scopeValues: pageGroups,
          keyOf: (r) => routingMaterialRules.routingMaterialKey(
            r.ProductionRoutingGroup, r.ProductionRouting, r.Material),
          label: 'lista cicli'
        });
        for (const [key, log] of picked) {
          syncLogMap.set(key, {
            Status: log.Status, Message: log.Message, MessageJson: log.MessageJson
          });
        }
      }

      // Step 7: projection. I campi di sola ordinazione (ChangedDateTime, CreationDate) NON
      // escono: non sono dichiarati nell'entity set.
      const out = page.map(r => {
        const syncLog = syncLogMap.get(routingMaterialRules.routingMaterialKey(
          r.ProductionRoutingGroup, r.ProductionRouting, r.Material)) || {};
        return {
          ProductionRoutingGroup: r.ProductionRoutingGroup,
          ProductionRouting: r.ProductionRouting,
          Material: r.Material,
          LastChangeDate: r.LastChangeDate,
          BillOfOperationsDesc: r.BillOfOperationsDesc || '',
          BillOfOperationsStatus: r.BillOfOperationsStatus || '',
          BillOfOperationsUsage: r.BillOfOperationsUsage || '', // [ROUTING-FILTER]
          ResponsiblePlannerGroup: r.ResponsiblePlannerGroup || '',
          PlanningWorkCenter: r.PlanningWorkCenter || '', // [IS-ROUTING-LIST] era wcMap.get(key), vedi Step 5
          Plant: r.Plant || '',
          LastSendStatus: syncLog.Status || null,
          // [LOG-MSG-I18N] Come la lista materiali: reso nella lingua della richiesta.
          LastSendMessage: renderLogMessage(syncLog.MessageJson, req, syncLog.Message || null)
        };
      });
      if (wantCount) out.$count = total;
      console.log(`>>> Returning ${out.length} of ${total} routing rows (skip=${skip}, top=${top})`
        + (matlError ? ` | ATTENZIONE: assegnazioni materiale NON lette (${matlError})` : ''));
      return out;
    });

    // READ handler for /production-routings/RoutingOperations
    // Fetches operations for a specific routing from the external CE_API
    this.on('READ', 'RoutingOperations', async (req) => {
      console.log(">>> READ RoutingOperations");

      const { ProductionRoutingOperation } = this.S4Routing.entities;

      // [KEY-READ] Il criterio EFFETTIVO, in un punto solo: su una lettura per chiave il predicato
      // sta in `SELECT.from.ref[<ultimo>].where`. Questo handler non e' mai stato ROTTO — senza
      // gruppo rende `[]`, cioe' 404, che e' gia' l'esito giusto — ma legge il criterio come tutti
      // gli altri, cosi' la classe e' chiusa uniformemente e il test puo' verificare che nessun
      // handler legga piu' `SELECT.where` da solo.
      const rk = keyReadRules.equalitiesOf(
        keyReadRules.readWhere(req.query), ['ProductionRoutingGroup', 'ProductionRouting']).equals;
      const sGroup = rk.ProductionRoutingGroup || '';
      const sRouting = rk.ProductionRouting || '';

      if (!sGroup) {
        console.log(">>> No ProductionRoutingGroup filter provided");
        return [];
      }

      // [ROUTING-SCOPE] Un ciclo fuori perimetro non esiste per noi, nemmeno per URL.
      if (await routingOutOfScopeForRead(req, sGroup, sRouting)) return [];

      try {
        const isMode = this.S4Routing.mode === 'IS';
        const filter = { ProductionRoutingGroup: sGroup };
        if (sRouting) filter.ProductionRouting = sRouting;
        // [IS-SOURCE] ZMARS_ROUTING_OPERATION_GET non ha SO_PLANT: in IS il perimetro plant
        // NON è spingibile e si applica a valle, con il conteggio delle righe scartate. In
        // ONPREM resta spinto, come oggi (TD-5). Il gate non si salta: si sposta (FR-14).
        let activePlants = null;
        if (process.env.USE_TEST_DATA_FILTER !== 'true') {
          activePlants = [...(await getUserPlants(req))];
          if (!activePlants.length) { console.log(">>> No active plants; returning no routing operations"); return []; }
          if (!isMode) filter.Plant = { in: activePlants };
        }

        const rows = await this.S4Routing.run(
          SELECT.from(ProductionRoutingOperation)
            .columns(
              'ProductionRoutingGroup',
              'ProductionRouting',
              'ProductionRoutingSequence',
              'ProductionRoutingOpIntID',
              'Operation',
              'OperationText',
              'Plant',
              'WorkCenterInternalID',
              'OperationControlProfile'
            )
            .where(filter)
            .limit(500)
        );
        let results = Array.isArray(rows) ? rows : (rows ? [rows] : []);
        if (isMode && activePlants) {
          const allowed = new Set(activePlants);
          const before = results.length;
          results = results.filter(r => allowed.has(r.Plant));
          console.log(`>>> [IS-SOURCE] filtro plant a valle (operazioni ciclo ${sGroup}/${sRouting || '*'}):`
            + ` tenute ${results.length} di ${before} righe | plant ammessi=[${activePlants}]`);
        }
        console.log(`>>> Retrieved ${results.length} routing operations`);
        // [ROUTING-DEFAULT-OP] Ordinate per (sequenza, operazione), che e' la stessa regola con cui
        // `pickAnchorOperation` sceglie la prima e l'ultima. Prima si rendevano nell'ordine in cui
        // SAP le restituiva: con l'allocazione dichiarata accesa il server ancorerebbe a
        // un'operazione che l'albero a schermo puo' non disegnare per prima, e «prima operazione»
        // diventerebbe un'affermazione non verificabile a occhio. Nessun filtro: la READ mostra il
        // ciclo INTERO, sequenze alternative comprese — restringere e' una decisione dell'ancora.
        return routingCompRules.sortSapOperations(results);
      } catch (error) {
        console.error(`>>> ERROR querying ProductionRoutingOperation:`, error.message);
        return [];
      }
    });

    // READ handler for /production-routings/RoutingComponentAllocations
    // Fetches component allocations for a specific routing from the external CE_API
    // ================================================================
    // [ROUTING-BY-MATERIAL] FILTRO PER MATERIALE.
    //
    // In SAP l'assegnazione componente-operazione (`PLMZ`) NON punta al materiale: punta alla
    // posizione di una distinta specifica (`STLNR`/`STLTY`/`STLAL`) e a un'operazione (`PLNKN`).
    // Le operazioni sono del ciclo — identiche per tutti i materiali dello stesso gruppo+contatore
    // — ma ogni materiale ha la sua distinta (`MAST`), quindi materiali diversi sullo stesso ciclo
    // hanno componenti DIVERSI appesi alle STESSE operazioni.
    //
    // Senza il filtro l'albero mostrava i componenti di TUTTE le distinte fusi insieme: e' il
    // comportamento da cui veniamo, e resta quello quando il filtro `Material` non arriva.
    //
    // Il legame materiale -> distinta si risolve su `MaterialBOM` (= `MAST`) via `bomSource`.
    // Il plant NON arriva dal client: l'entity set non lo espone, quindi si risolve dalla testata
    // del ciclo, come fa `syncRoutingPlexCycle`.
    // ================================================================
    this.on('READ', 'RoutingComponentAllocations', async (req) => {
      console.log(">>> READ RoutingComponentAllocations");

      // [ROUTING-DEFAULT-OP] `ProductionRoutingCompAlloc` non si nomina piu' qui: la sua lettura e'
      // in `resolveRoutingCompAllocs`, punto unico. La testata serve ancora, per la distinta.
      const { ProductionRoutingHeader } = this.S4Routing.entities;

      // [KEY-READ] Il criterio EFFETTIVO, come nel gemello delle operazioni qui sopra.
      // [ROUTING-BY-MATERIAL] `Material` e' il materiale di TESTATA, e serve a scegliere la
      // distinta. E' un criterio, ma E' ANCHE UN CAMPO dichiarato dell'entity set, e deve esserlo:
      // l'adapter OData V4 valida il `$filter` contro l'entity type prima di questo handler, quindi
      // un criterio non dichiarato non arriva qui — arriva un 400. Vedi il commento sull'elemento
      // in srv/cat-service.cds.
      const rk = keyReadRules.equalitiesOf(keyReadRules.readWhere(req.query),
        ['ProductionRoutingGroup', 'ProductionRouting', 'Material']).equals;
      const sGroup = rk.ProductionRoutingGroup || '';
      const sRouting = rk.ProductionRouting || '';
      const sMaterial = String(rk.Material ?? '').trim();

      if (!sGroup) {
        console.log(">>> No ProductionRoutingGroup filter provided");
        return [];
      }

      // [ROUTING-SCOPE] Un ciclo fuori perimetro non esiste per noi, nemmeno per URL.
      if (await routingOutOfScopeForRead(req, sGroup, sRouting)) return [];

      try {
        // [ROUTING-DEFAULT-OP] UNA cache per le due letture di distinta di questa richiesta: quella
        // della sorgente (se il plant legge dalla distinta) e quella che `explodeAllocRows` fa per
        // quantita' e fantasma. Stessa chiave `materiale|plant|data`, quindi la seconda e' un hit.
        const cache = bomExplode.createExplodeCache();
        const tag = `albero ciclo ${sGroup}/${sRouting}${sMaterial ? `/${sMaterial}` : ''}`;

        // Il plant e la sorgente in un colpo solo. In modo `BOM` le righe tornano gia' complete —
        // materiale di testata compreso — e l'attribuzione qui sotto non ha nulla da fare.
        const src = await resolveRoutingCompAllocs({
          group: sGroup, routing: sRouting, headerMaterial: sMaterial, cache, tag
        });
        const results = src.allocs;
        const rtgPlant = src.plant;
        console.log(`>>> Retrieved ${results.length} component allocations (sorgente ${src.mode})`);

        let rows = results;
        if (src.mode === 'ALLOC') {
          // SORGENTE CAMBIATA (v3): il comp-alloc del routing contiene già BillOfMaterialComponent,
          // quindi il materiale componente non si va più a cercare nella distinta.
          // [W1-05] Quantità e unità sì, invece: il v3 non le espone, e la distinta è l'unico posto
          // dove sono. Le riempie `explodeAllocRows` qui sotto, dal nodo (STLKN) che la riga porta.
          for (const comp of results) {
            // Ripiego, non risultato: è il valore che resta se il nodo non si risolve, ed è anche
            // ciò che garantisce i due campi presenti nel payload su OGNI riga.
            comp.BillOfMaterialItemQuantity = DEFAULT_COMP_QTY;
            comp.BillOfMaterialItemUnit = DEFAULT_COMP_UNIT;
            // [ROUTING-BY-MATERIAL] Il materiale di testata parte VUOTO, e resta vuoto se
            // l'attribuzione alla distinta non avviene: la riga letta da SAP non sa a quale
            // materiale appartiene, lo sappiamo noi dopo il confronto con `MAST`. Sempre presente
            // nel payload, così un client non deve distinguere «assente» da «non attribuito».
            comp.Material = '';
          }

          // ================================================================
          // [ROUTING-BY-MATERIAL] Attribuzione al materiale: si tengono le sole righe della sua
          // distinta. FAIL-OPEN dichiarato — se la distinta non e' risolvibile (plant sconosciuto,
          // lettura fallita, materiale senza distinta) l'albero resta indistinto come prima,
          // perche' un albero VUOTO direbbe «questo materiale non ha componenti», che e' una cosa
          // falsa e indistinguibile dal vero.
          //
          // [ROUTING-DEFAULT-OP] Non gira sull'altra sorgente, e non e' una dimenticanza: la' le
          // righe VENGONO dalla distinta del materiale, quindi l'attribuzione e' certa per
          // costruzione e questo confronto non avrebbe un secondo termine.
          // ================================================================
          if (sMaterial && results.length > 0) {
            const boms = await resolveMaterialBomKeys(
              sMaterial, sGroup, sRouting, ProductionRoutingHeader, rtgPlant);
            if (boms.size === 0) {
              console.warn(`>>> [ROUTING-BY-MATERIAL] distinta di ${sMaterial} non risolta:`
                + ' albero componenti INDISTINTO (tutte le distinte del ciclo), come prima del filtro');
            } else {
              rows = results.filter(r => routingMaterialRules.belongsToMaterial(r, boms));
              // L'attribuzione e' avvenuta: solo ORA la riga puo' dire a quale materiale appartiene.
              // Si marca PRIMA di `explodeAllocRows`, così il campo lo portano anche le righe esplose,
              // che ereditano da `base` con lo spread — e le righe dirette restano lo stesso oggetto,
              // come vuole quella funzione.
              for (const r of rows) r.Material = sMaterial;
              console.log(`>>> [ROUTING-BY-MATERIAL] componenti di ${sMaterial}: ${rows.length}`
                + ` di ${results.length} | distinte=[${[...boms].join(', ')}]`);
            }
          }
        }

        // ================================================================
        // [PHANTOM-EXPLODE] Esplosione dei fantasma (feature 0019), se il plant l'ha accesa.
        // Sta DOPO l'attribuzione al materiale, e non prima: esplodere anche i fantasma delle
        // distinte degli ALTRI materiali del ciclo produrrebbe componenti che a questo materiale
        // non appartengono — cioe' rimetterebbe nell'albero l'indistinzione che la 0015 ha tolto.
        //
        // [ROUTING-DEFAULT-OP] Vale IDENTICA sulle righe sintetizzate dalla distinta: il fantasma
        // si riconosce dal NODO (la riga di assegnazione non porta alcun flag, vedi il docblock di
        // `prepareRoutingComponents`), e quelle righe il nodo ce l'hanno. Stessa distinta, stessa
        // cache, stesso indice.
        // ================================================================
        return explodeAllocRows(rows, {
          plant: rtgPlant,
          headerMaterial: sMaterial,
          cache,
          tag
        });
      } catch (error) {
        console.error(`>>> ERROR querying ProductionRoutingCompAlloc:`, error.message);
        return [];
      }
    });

    /**
     * [ROUTING-BY-MATERIAL] Le chiavi di distinta (STLNR, STLTY, STLAL) di un materiale.
     *
     * FORMA DELLA QUERY OBBLIGATA: collection con `where`, MAI `SELECT.one`. `MaterialBOM` ha due
     * rotte in srv/lib/bomSource.js (GET e QUERY) e `isQueryShape.deriveOp` manda un `SELECT.one`
     * sul root `_GET`, la cui chiave a 4 campi comprende `BillOfMaterialCategory` e
     * `BillOfMaterialVariant` — che sono esattamente i due valori che stiamo cercando e che quindi
     * non possiamo mettere in un key predicate. Il `limit` tiene la forma collection e prende
     * tutte le alternative del materiale.
     *
     * @param {string} material materiale di testata
     * @param {string} group
     * @param {string} routing
     * @param {object} HeaderEntity entity CSN della testata, per risolvere il plant
     * @returns {Promise<Set<string>>} vuoto = non risolvibile (il chiamante va in fail-open)
     */
    /**
     * [PHANTOM-EXPLODE] Il plant di un ciclo, dalla sua testata.
     *
     * Estratto perche' ora serve a DUE cose nello stesso handler — scegliere la distinta del
     * materiale e decidere se il plant ha acceso l'esplosione — e leggerlo due volte
     * significherebbe due chiamate a SAP per la stessa informazione a ogni apertura di ciclo.
     * @returns {Promise<string>} vuoto = non risolto (nessun chiamante deve bloccarsi per questo)
     */
    const routingPlantOf = async (group, routing, HeaderEntity) => {
      try {
        // [ROUTING-HEADER-FLIGHT] Con il contatore si passa dalla cache della testata invece di
        // leggere `this.S4Routing` per conto proprio: e' LA STESSA riga di SAP, e la lettura diretta
        // ne aggiungeva altre due a ogni apertura di ciclo (una da `resolveRoutingCompAllocs` e una
        // da `resolveMaterialBomKeys`), che si sommavano alle sei del gate di perimetro.
        //
        // Cambia il `$select` — qui bastava `Plant`, `readRoutingHeader` ne chiede cinque — ed e'
        // gia' la scelta dichiarata da `checkRoutingInScope`: «cambia il $select, non il numero di
        // chiamate». Il costo di quattro colonne in piu' su una riga sola non si misura; quello di
        // una chiamata in piu' verso l'iFlow e' ~950 ms.
        //
        // SENZA contatore la cache non si puo' usare: la sua chiave e' `gruppo|contatore` e qui la
        // `where` e' sul solo gruppo, cioe' una domanda diversa — «un ciclo qualsiasi di questo
        // gruppo». Riusare la voce vorrebbe dire rispondere a una domanda con l'altra.
        if (routing) {
          const hdr = await readRoutingHeader(group, routing);
          return routingMaterialRules.keyPart(hdr && hdr.Plant);
        }
        const hdr = await this.S4Routing.run(
          SELECT.one.from(HeaderEntity).columns('Plant')
            .where({ ProductionRoutingGroup: group })
        );
        return routingMaterialRules.keyPart(hdr && hdr.Plant);
      } catch (error) {
        console.error(`>>> [ROUTING-BY-MATERIAL] ERRORE lettura testata ${group}/${routing}:`
          + ` ${error.message}`);
        return '';
      }
    };

    const resolveMaterialBomKeys = async (material, group, routing, HeaderEntity, plantHint) => {
      try {
        // Il plant non arriva dal client: l'entity set dei comp-alloc non lo espone.
        const plant = routingMaterialRules.keyPart(plantHint)
          || await routingPlantOf(group, routing, HeaderEntity);
        if (!plant) {
          console.warn(`>>> [ROUTING-BY-MATERIAL] plant del ciclo ${group}/${routing} non risolto:`
            + ' la distinta non e\' interrogabile');
          return new Set();
        }
        const bom = await bomSource();
        const { MaterialBOM } = bom.entities;
        const bomRows = await bom.run(
          SELECT.from(MaterialBOM)
            .columns('BillOfMaterial', 'BillOfMaterialCategory', 'BillOfMaterialVariant',
              'Material', 'Plant')
            .where({ Material: material, Plant: plant })
            .limit(50)
        );
        const keys = routingMaterialRules.bomKeySet(bomRows);
        console.log(`>>> [ROUTING-BY-MATERIAL] MaterialBOM ${material}/${plant}:`
          + ` ${Array.isArray(bomRows) ? bomRows.length : 0} righe, ${keys.size} distinte`);
        return keys;
      } catch (error) {
        // Non blocca: il chiamante torna all'albero indistinto e lo dichiara.
        console.error(`>>> [ROUTING-BY-MATERIAL] ERRORE lettura MaterialBOM per ${material}:`
          + ` ${error.message}`);
        return new Set();
      }
    };

    // ================================================================
    // [PHANTOM-EXPLODE] I COMPONENTI DEL CICLO, IN UN PUNTO SOLO (feature 0019).
    //
    // La costruzione della lista componenti da un'assegnazione `PLMZ` era ripetuta IDENTICA in
    // tre punti — la READ che alimenta l'albero del cockpit, l'auto-assegnazione manuale e il
    // ramo `AutoAssignMissing` di `syncRoutingPlexCycle`, cioe' quello che il job usa e da cui
    // la distinta finisce su Plex. Aggiungerci l'esplosione dei fantasma in due su tre avrebbe
    // prodotto la peggiore delle incoerenze: un albero a schermo diverso da cio' che viene
    // inviato. Da qui in avanti la costruzione e' una sola.
    // ================================================================

    /**
     * [ROUTING-DEFAULT-OP] LE RIGHE DI ASSEGNAZIONE DI UN CICLO, DA QUALUNQUE SORGENTE (0051).
     *
     * E' il punto unico in cui si decide SE l'assegnazione componente-operazione si chiede a SAP
     * (`PLMZ`) o si DICHIARA dal customizing del plant. Prima la `SELECT` su
     * `ProductionRoutingCompAlloc` era scritta in TRE posti — la READ che disegna l'albero,
     * l'auto-assegnazione del cockpit e il ramo del job — e cambiarne meno di tre ricrea
     * esattamente la divergenza che la 0019 ha chiuso: un albero a schermo diverso da cio' che
     * viene inviato. Vedi il commento qui sopra.
     *
     * IL PLANT E' QUELLO DELLA ROUTING, E SI RISOLVE PRIMA DI DECIDERE. Un run del job tratta cicli
     * di piu' plant e plant diversi possono avere impostazioni diverse: il verdetto e' del CICLO,
     * mai del run e mai del processo. Non si memorizza niente qui dentro — la cache e'
     * `resolveExplodeConfig`, che e' chiavata per plant e si invalida per plant — o un ciclo
     * erediterebbe l'impostazione di quello prima, che e' un altro plant.
     *
     * CHE COSA SUCCEDE QUANDO NON SI PUO'. Si torna a `PLMZ` e lo si DICHIARA (`fellBack`): plant
     * non risolto, materiale di testata assente, ciclo senza operazioni su cui ancorare, lettura
     * della distinta fallita. Mai un albero vuoto — direbbe «questo ciclo non ha componenti», che
     * e' falso e indistinguibile dal vero — e mai il customizing di un altro plant. Il chiamante
     * che SCRIVE usa `fellBack` per non autorizzare la potatura delle righe manuali: una
     * fotografia diversa da quella richiesta non puo' far cancellare decisioni umane (DEC-107).
     *
     * `noBom` NON E' UN RIPIEGO, E' UN BLOCCO. Un materiale senza distinta, con questa sorgente
     * accesa, non da' zero componenti: da' `NO_BOM` al chiamante, che si ferma. Qui si scrive verso
     * la fabbrica, e `listBomComponents` rende «non ha distinta» nella stessa forma di «tutto bene,
     * zero righe» (DEC-52).
     *
     * @param {object} args
     * @param {string} args.group gruppo del ciclo
     * @param {string} args.routing contatore del ciclo (puo' essere vuoto)
     * @param {string} [args.plant] se il chiamante l'ha gia', si evita la lettura della testata
     * @param {string} args.headerMaterial materiale di TESTATA
     * @param {object} [args.cache] cache di esecuzione condivisa: senza, la distinta si rilegge
     * @param {string} [args.tag] per il log
     * @returns {Promise<{ allocs: Array<object>, mode: 'ALLOC'|'BOM', plant: string,
     *   anchor: object|null, fellBack: boolean, reason: string, noBom: boolean, error: string }>}
     */
    const resolveRoutingCompAllocs = async (args) => {
      const { group, routing, headerMaterial, cache, tag = '' } = args || {};
      const sGroup = String(group || '').trim();
      const sRouting = String(routing || '').trim();
      const material = routingMaterialRules.keyPart(headerMaterial);
      const { ProductionRoutingCompAlloc, ProductionRoutingOperation, ProductionRoutingHeader } =
        this.S4Routing.entities;
      const label = tag || `ciclo ${sGroup}/${sRouting || '*'}`;

      // Il plant PRIMA di tutto: e' su di lui che si legge il customizing. `routingPlantOf` rende
      // '' sia quando la testata non ha plant sia quando la lettura FALLISCE — due cose diverse che
      // escono uguali — quindi l'assenza si dichiara invece di essere subita.
      const plant = routingMaterialRules.keyPart(args && args.plant)
        || await routingPlantOf(sGroup, sRouting, ProductionRoutingHeader);

      /** La sorgente storica: la `SELECT` che stava nei tre punti, invariata. */
      const readAllocs = async () => {
        const filter = { ProductionRoutingGroup: sGroup };
        if (sRouting) filter.ProductionRouting = sRouting;
        const rows = await this.S4Routing.run(
          SELECT.from(ProductionRoutingCompAlloc)
            .columns(
              'ProductionRoutingGroup',
              'ProductionRouting',
              'ProductionRoutingSequence',
              'ProductionRoutingOpIntID',
              'ProdnRtgOpBOMItemInternalID',
              'BillOfMaterial',
              // [ROUTING-BY-MATERIAL] categoria e alternativa completano la chiave della distinta:
              // lo stesso STLNR puo' esistere in categorie diverse, e un materiale puo' avere piu'
              // alternative. Sono anche esposte nell'entity set, cosi' il client puo' mostrare a
              // quale distinta appartiene una riga.
              'BillOfMaterialCategory',
              'BillOfMaterialVariant',
              'BillOfMaterialComponent', // presente nel modello v3: materiale componente
              'BillOfMaterialItemNodeNumber',
              'MatlCompIsMarkedForBackflush'
            )
            .where(filter)
            .limit(1000)
        );
        return Array.isArray(rows) ? rows : (rows ? [rows] : []);
      };

      const fallBack = async (reason) => {
        console.warn(`>>> [ROUTING-DEFAULT-OP] ${label}: allocazione di default NON applicata`
          + ` (${reason}): componenti dall'assegnazione di SAP, come a opzione spenta`);
        return {
          allocs: await readAllocs(), mode: 'ALLOC', plant, anchor: null,
          fellBack: true, reason, noBom: false, error: ''
        };
      };

      let decision;
      try {
        const db = await cds.connect.to('db');
        // Chiavata per plant, con TTL e invalidazione per plant: e' gia' la forma giusta. Con plant
        // vuoto rende i default, cioe' opzione spenta — lo stato sicuro — ma il silenzio la
        // renderebbe indistinguibile da un plant che ha scelto PLMZ, quindi si passa da `fallBack`.
        const config = await bomExplode.resolveExplodeConfig(db, plant);
        decision = routingCompRules.compDefaultOp(config);
        if (!decision.on) {
          if (decision.state === routingCompRules.DEFAULT_OP_STATE.OFF) {
            return {
              allocs: await readAllocs(), mode: 'ALLOC', plant, anchor: null,
              fellBack: false, reason: '', noBom: false, error: ''
            };
          }
          // Acceso ma configurato a meta': un campo che si salva e non fa niente e' il difetto che
          // il progetto rifiuta, quindi si nomina invece di ricadere in silenzio su FIRST_OP.
          return await fallBack(decision.state === routingCompRules.DEFAULT_OP_STATE.NO_TARGET
            ? 'operazione di default non scelta sulla scheda del plant'
            : `operazione di default "${decision.target}" non ammessa`);
        }
        if (!plant) return await fallBack('plant del ciclo non risolto');
        if (!material) return await fallBack('materiale di testata non risolto');

        // L'ancora, sulle operazioni SAP del ciclo. Stesso tetto del READ gemello.
        const opRows = await this.S4Routing.run(
          SELECT.from(ProductionRoutingOperation)
            .columns('ProductionRoutingGroup', 'ProductionRouting', 'ProductionRoutingSequence',
              'ProductionRoutingOpIntID', 'Operation', 'Plant')
            .where(sRouting
              ? { ProductionRoutingGroup: sGroup, ProductionRouting: sRouting }
              : { ProductionRoutingGroup: sGroup })
            .limit(500)
        );
        const ops = Array.isArray(opRows) ? opRows : (opRows ? [opRows] : []);
        const anchor = routingCompRules.pickAnchorOperation(ops, decision.target);
        if (!anchor) return await fallBack('il ciclo non ha operazioni su cui collocare i componenti');

        // La distinta di OGGI, con la cache dell'esecuzione: e' la stessa lettura che
        // `prepareRoutingComponents` fa subito dopo per le quantita' e per i fantasma, quindi
        // condividendo la cache e la data e' un colpo di cache e non traffico nuovo.
        const read = await bomExplode.listBomComponents(
          material, plant, config, cache || bomExplode.createExplodeCache(), null);
        if (read.error) return await fallBack(`distinta non letta (${read.error})`);

        const allocs = routingCompRules.allocRowsFromBom({
          rows: read.rows,
          anchor,
          bom: read.bom,
          headerMaterial: material,
          group: sGroup,
          routing: sRouting || String(anchor.ProductionRouting || '').trim(),
          defaultQuantity: DEFAULT_COMP_QTY,
          defaultUnit: DEFAULT_COMP_UNIT
        });

        // Distinta assente o senza posizioni: BLOCCO, non insieme vuoto. Non si ripiega su PLMZ —
        // sarebbe un'altra fotografia, e il plant ha dichiarato quale vuole.
        const noBom = read.noBom === true || allocs.length === 0;
        console.log(`>>> [ROUTING-DEFAULT-OP] ${label}: plant ${plant},`
          + ` componenti dalla distinta ${read.bomNumber || '(nessuna)'} di ${material}`
          + ` -> operazione ${anchor.Operation} (${decision.target}),`
          + ` ${allocs.length} righe${noBom ? ' — NESSUN COMPONENTE: ciclo bloccato' : ''}`);

        return {
          allocs, mode: 'BOM', plant, anchor, fellBack: false, reason: '', noBom, error: ''
        };
      } catch (error) {
        // Non si lancia: la costruzione della sorgente non deve poter abbattere una lista o un job.
        // Ma un ripiego silenzioso sarebbe peggio, quindi passa da `fallBack`, che dichiara.
        try {
          return await fallBack(`errore nella sorgente componenti (${error.message})`);
        } catch (readError) {
          console.error(`>>> [ROUTING-DEFAULT-OP] ${label}: anche l'assegnazione di SAP non e'`
            + ` leggibile (${readError.message})`);
          return {
            allocs: [], mode: 'ALLOC', plant, anchor: null,
            fellBack: true, reason: 'sorgente non leggibile', noBom: false,
            error: readError.message
          };
        }
      }
    };

    // ================================================================
    // [ROUTING-DEFAULT-OP] La dichiarazione per il cockpit (feature 0051).
    //
    // L'albero SAP a schermo, con l'allocazione dichiarata accesa, NON e' l'albero di SAP: i
    // componenti vengono dalla distinta e stanno tutti su una operazione. Senza avviso quella
    // schermata afferma qualcosa di falso su cosa SAP contiene.
    //
    // Rifa' la stessa risoluzione della READ — stessa funzione, stesso plant, stesso customizing —
    // invece di ricevere un riassunto: due strade per la stessa domanda darebbero due risposte, e
    // quella a schermo sarebbe la piu' facile da non aggiornare. La lettura e' in cache per plant,
    // quindi il costo e' la sola distinta, che la READ ha appena messo in cache... in un'ALTRA
    // richiesta, quindi qui si ripaga: e' il prezzo di non avere due verita'.
    // ================================================================
    this.on('routingCompSource', async (req) => {
      const sGroup = String(req.data.ProductionRoutingGroup || '').trim();
      const sRouting = String(req.data.ProductionRouting || '').trim();
      const sMaterial = String(req.data.Material || '').trim();
      const inert = {
        mode: 'ALLOC', plant: '', anchor: '', target: '',
        fellBack: false, reason: '', noBom: false
      };
      if (!sGroup) return inert;
      // [ROUTING-SCOPE] Stesso gate della READ che disegna l'albero: un ciclo fuori perimetro non
      // esiste per noi, nemmeno per dire da dove verrebbero i suoi componenti.
      if (await routingOutOfScopeForRead(req, sGroup, sRouting)) return inert;
      try {
        const src = await resolveRoutingCompAllocs({
          group: sGroup, routing: sRouting, headerMaterial: sMaterial,
          tag: `dichiarazione ciclo ${sGroup}/${sRouting}`
        });
        return {
          mode: src.mode,
          plant: src.plant || '',
          anchor: src.anchor ? String(src.anchor.Operation || '') : '',
          target: src.anchor ? String(src.anchor.ProductionRoutingOpIntID || '') : '',
          fellBack: src.fellBack === true,
          reason: src.reason || '',
          noBom: src.noBom === true
        };
      } catch (error) {
        // Una dichiarazione che fallisce non deve poter impedire di aprire un ciclo: il peggio che
        // puo' fare e' non comparire, e l'albero resta quello che era prima di questa feature.
        console.error(`>>> [ROUTING-DEFAULT-OP] dichiarazione ciclo ${sGroup}/${sRouting} non`
          + ` disponibile: ${error.message}`);
        return inert;
      }
    });

    /**
     * Da assegnazioni componente-operazione a componenti.
     *
     * `_opKey` NON e' un campo del contratto: e' l'operazione a cui il componente e' appeso, e
     * serve alla fusione dei duplicati (`mergeSameMaterial`), che deve fondere due righe solo se
     * stanno sulla STESSA operazione. `_alloc` tiene la riga d'origine, cosi' la READ puo'
     * ricostruire la forma dell'entity senza rileggere niente.
     *
     * [W1-05] Quantita' e unita' nascono qui come RIPIEGO e vengono riempite subito dopo, da
     * `prepareRoutingComponents`, con i valori veri della distinta. Restano quelle di ripiego solo
     * se il nodo non si risolve — e in quel caso qualcuno lo dichiara.
     * @param {Array<object>} allocs
     * @returns {Array<object>}
     */
    const routingComponentsOf = (allocs) => (allocs || []).map((a) => ({
      // `.trim()` come faceva il ramo AutoAssignMissing: e' l'unico dei tre che lo aveva, e
      // toglierlo qui cambierebbe cio' che il job confronta con i componenti gia' inseriti.
      Material: (a.BillOfMaterialComponent || '').trim(),
      RequiredQuantity: DEFAULT_COMP_QTY,
      BaseUnit: DEFAULT_COMP_UNIT,
      BOMItemNodeNumber: a.BillOfMaterialItemNodeNumber || null,
      _opKey: a.ProductionRoutingOpIntID || '',
      // [PHANTOM-EXPLODE] [W1-05] La distinta a cui l'assegnazione si riferisce. Serve a DUE
      // agganci, e per la stessa ragione: `STLKN` e' unico DENTRO una distinta, non fra
      // alternative diverse dello stesso materiale, quindi sia l'indice dei fantasma sia quello
      // delle quantita' sono chiavati su (distinta, nodo) e non sul solo nodo.
      _bomNo: a.BillOfMaterial || '',
      _alloc: a
    }));
    // NIENTE `.filter(c => c.Material)` QUI, ed e' una scelta: la READ deve restituire le righe
    // di assegnazione COSI' COME SONO, e una riga senza materiale componente e' una riga che
    // l'albero mostra oggi. Filtrarla qui la farebbe sparire il giorno in cui si accende
    // l'esplosione — cioe' una modifica a cio' che l'esplosione non doveva toccare. Il filtro
    // resta dove serviva: nei due punti che costruiscono l'input dell'auto-assegnazione.

    /**
     * [W1-05] Il riepilogo delle quantita' nel log. Una riga sola, e dice tutto cio' che puo'
     * essere andato storto: senza, «quantita' 1» e «quantita' vera che vale 1» sono la stessa cosa
     * a schermo.
     * @param {string} tag
     * @param {object|null} s da `applyBomQuantities`
     */
    const logBomQtyStats = (tag, s) => {
      if (!s) return;
      let line = `>>> [W1-05] ${tag}quantita' di distinta: ${s.resolved} risolte su ${s.in}`;
      if (s.unresolved) {
        line += `, ${s.unresolved} NON risolte (ripiego ${DEFAULT_COMP_QTY})`;
        if (s.otherBom) line += ` di cui ${s.otherBom} su una distinta diversa da quella indicizzata`;
      }
      if (s.assumedBase) line += `, ${s.assumedBase} con quantita' base assunta 1`;
      if (s.roundedToZero) {
        line += `, ${s.roundedToZero} arrotondate a ZERO a ${bomExplodeRules.QTY_SCALE} decimali`;
      }
      if (s.altUnit.length) {
        line += `, ${s.altUnit.length} in unita' alternativa [`
          + s.altUnit.map((a) => `${a.Material} ${a.CompUom}!=${a.BaseUom}`).join(', ') + ']';
      }
      if (s.unresolved || s.roundedToZero || s.altUnit.length) console.warn(line);
      else console.log(line);
    };

    /**
     * [PHANTOM-EXPLODE] [W1-05] I componenti di un ciclo, pronti da usare: quantita' e unita' VERE
     * dalla distinta, e i fantasma esplosi se il plant l'ha acceso.
     *
     * L'ORDINE DEI DUE PASSI NON E' INVERTIBILE, ED E' LA RAGIONE PER CUI STANNO NELLA STESSA
     * FUNZIONE. `childQuantity` riscala i figli di un fantasma sulla quantita' del PADRE: finche'
     * quella quantita' era il ripiego `1`, ogni figlio nasceva sbagliato quanto il padre. Riempire
     * le quantita' PRIMA di esplodere rende corretta anche la ricorsione, senza toccarla.
     *
     * IL PRIMO PASSO GIRA SEMPRE, IL SECONDO NO. La quantita' reale e' la correzione di un difetto
     * — la riga BOM su Plex aveva quantita' 1 e unita' vuota su OGNI componente — quindi non e'
     * subordinata a `ZPhantomExplodeConfig`: un plant che non usa i fantasma ha comunque diritto
     * alla distinta giusta. L'esplosione resta invece esattamente com'era: riga assente = motore
     * spento.
     *
     * UNA SOLA LETTURA VERSO SAP PER I DUE PASSI. La cache dell'esecuzione si crea QUI e si passa
     * a entrambi gli indici: `readBomItems` e' chiavata su `material|plant`, quindi il secondo e'
     * un hit. Chi chiama passando la propria cache (il job, che itera su molti cicli dello stesso
     * plant) la riusa per tutti.
     *
     * COSA COSTA, DETTO PER INTERO: sui percorsi che prima non esplodevano niente questo e' traffico
     * NUOVO — la testata `MaterialBOM` piu' le posizioni, per (ciclo, materiale). Una delle due e'
     * anche ridondante: `resolveMaterialBomKeys` legge `MaterialBOM` per lo STESSO (materiale,
     * plant) poche righe prima, e non passa da questa cache. Non e' stato unificato perche'
     * quella funzione ha tre chiamanti in esercizio dalla 0015 e serve un `Set` di chiavi, non le
     * righe; se il volume diventasse un problema, e' li' che si interviene — condividendo la
     * cache, non togliendo una delle due letture.
     *
     * IL RICONOSCIMENTO SUL RAMO CICLI NON PUO' VENIRE DALLA RIGA. `ProductionRoutingCompAlloc`
     * non porta alcun flag phantom: porta il NODO della posizione di distinta. Per questo si passa
     * `parentMaterial`, con cui il motore esplode UNA VOLTA la distinta del materiale di testata e
     * ne indicizza i nodi fantasma — una lettura per ciclo, non una per componente.
     *
     * NON LANCIA MAI: su qualunque intoppo restituisce i componenti di partenza e lo dichiara nel
     * log, perche' un albero incompleto che si dichiara e' meglio di una lettura che fallisce — e
     * questo codice sta anche dentro il percorso che invia a Plex.
     *
     * [ROUTING-COMP-SOURCE] `ctx.explosionDate` E' LA DATA A CUI SI GUARDA LA DISTINTA, e vale
     * per ENTRAMBI i passi: le quantita' e i fantasma. Assente = oggi, cioe' il comportamento di
     * sempre, ed e' cio' che vede il cockpit. Il job la valorizza sulla seconda lettura, quella
     * che scopre i componenti futuri: e li' il fantasma va riconosciuto sulla distinta di QUELLA
     * data, perche' una modifica tecnica puo' introdurre un assieme fantasma tanto quanto un
     * componente qualunque. Con la data su un passo solo, i figli di un fantasma futuro
     * sarebbero cercati su una distinta in cui il padre non esiste ancora.
     *
     * @param {Array<object>} components da `routingComponentsOf`
     * @param {{ plant: string, headerMaterial: string, tag: string, cache?: object,
     *   explosionDate?: Date|null }} ctx
     * @returns {Promise<{ components: Array<object>, exploded: boolean, stats: object,
     *   qty: object|null, changed: boolean }>} `changed` = le righe non sono piu' quelle in
     *   ingresso, per un motivo qualunque dei due: chi ricostruisce la forma dell'entity deve
     *   guardare quello, non `exploded`.
     */
    const prepareRoutingComponents = async (components, ctx) => {
      const inert = {
        components: components || [], exploded: false, stats: null, qty: null, changed: false
      };
      const tag = (ctx && ctx.tag) ? `${ctx.tag}: ` : '';
      try {
        const plant = routingMaterialRules.keyPart(ctx && ctx.plant);
        if (!plant) return inert;
        const headerMaterial = routingMaterialRules.keyPart(ctx && ctx.headerMaterial);
        const db = await cds.connect.to('db');
        // La configurazione serve a DUE cose, e la seconda vale anche a motore spento: decidere se
        // esplodere, e dire QUALE alternativa di distinta guardare (`BomUsage` / `BomVariant`).
        // Leggerla comunque e' cio' che garantisce che quantita' e fantasma guardino la stessa.
        const config = await bomExplode.resolveExplodeConfig(db, plant);
        const cache = (ctx && ctx.cache) || bomExplode.createExplodeCache();
        // [ROUTING-COMP-SOURCE] Assente = oggi, cioe' esattamente cio' che faceva prima.
        const explosionDate = (ctx && ctx.explosionDate) || null;

        // ---- Passo 1 [W1-05]: quantita' e unita' dalla distinta. Sempre.
        let list = inert.components;
        let qtyStats = null;
        let changed = false;
        if (headerMaterial) {
          const qtyNotes = [];
          const index = await bomExplode.buildBomIndex(headerMaterial, plant, config, cache, explosionDate, qtyNotes);
          const applied = bomExplodeRules.applyBomQuantities(list, index);
          list = applied.components;
          qtyStats = applied.stats;
          changed = true;
          for (const n of qtyNotes) {
            const line = `>>> [W1-05] ${tag}${n.text}`;
            if (n.level === 'W') console.warn(line); else console.log(line);
          }
          logBomQtyStats(tag, qtyStats);
        } else {
          console.warn(`>>> [W1-05] ${tag}materiale di testata non risolto:`
            + ' quantita\' e unita\' dei componenti restano quelle di ripiego');
        }

        // ---- Passo 2 [PHANTOM-EXPLODE]: l'esplosione, solo se il plant l'ha accesa.
        if (!config.exists || !config.ExplodeInRouting) {
          return { components: list, exploded: false, stats: null, qty: qtyStats, changed };
        }

        const res = await bomExplode.explodeComponents({
          plant,
          components: list,
          parentMaterial: headerMaterial,
          config,
          cache,
          // [ROUTING-COMP-SOURCE] La stessa data del passo 1: i due passi devono guardare la
          // STESSA distinta, o l'indice dei fantasma e quello delle quantita' divergono.
          explosionDate,
          tag: ctx && ctx.tag
        });
        for (const n of res.notes) {
          const line = `>>> [PHANTOM-EXPLODE] ${tag}${n.text}`;
          if (n.level === 'W') console.warn(line); else console.log(line);
        }
        console.log(`>>> [PHANTOM-EXPLODE] ${tag}`
          + `${res.stats.phantoms} fantasma su ${res.stats.in} componenti,`
          + ` ${res.stats.added} figli aggiunti, ${res.stats.unresolved} non risolti,`
          + ` profondita' max ${res.stats.maxLevel} (tetto ${config.MaxDepth})`);
        return {
          components: res.components, exploded: true, stats: res.stats, qty: qtyStats, changed: true
        };
      } catch (error) {
        console.error('>>> [PHANTOM-EXPLODE] preparazione dei componenti del ciclo NON eseguita'
          + ` (${error.message}): componenti come da SAP`);
        return inert;
      }
    };

    /**
     * [ROUTING-COMP-SOURCE] Da posizioni di distinta a componenti, nella stessa forma che
     * `routingComponentsOf` produce dalle assegnazioni del ciclo (feature 0025).
     *
     * Le due sorgenti devono arrivare al motore con la STESSA forma, o la fusione confronterebbe
     * oggetti diversi e la preparazione — quantita' e fantasma — funzionerebbe su una sola.
     *
     * `_bomNo` viene dalla TESTATA letta, non dalla riga: e' la distinta che `chooseBom` ha
     * scelto, ed e' la stessa su cui l'indice delle quantita' e' costruito. Il nodo da solo non
     * basterebbe, perche' e' unico dentro una distinta e non fra le alternative di un materiale.
     *
     * Quantita' e unita' nascono di RIPIEGO come nell'altra sorgente: le riempie subito dopo
     * `prepareRoutingComponents` con i valori della distinta a quella data.
     *
     * @param {Array<object>} rows righe normalizzate da `bomExplode.listBomComponents`
     * @param {string} bomNumber la distinta da cui provengono
     * @returns {Array<object>}
     */
    const bomComponentsOf = (rows, bomNumber) => (rows || [])
      .map((r) => ({
        Material: String((r && r.Material) || '').trim(),
        RequiredQuantity: DEFAULT_COMP_QTY,
        BaseUnit: DEFAULT_COMP_UNIT,
        BOMItemNodeNumber: (r && r.ItemNode) || null,
        // Nessuna operazione SAP: questa riga non viene da un'assegnazione. La fusione dei
        // duplicati e' per (materiale, operazione), e con la chiave vuota due righe della
        // distinta non si fondono con quelle del ciclo — che e' giusto, perche' la fusione fra
        // le due SORGENTI la fa `mergeComponentSources`, per materiale.
        _opKey: '',
        _bomNo: bomNumber || ''
      }))
      .filter((c) => c.Material);

    /**
     * [ROUTING-COMP-SOURCE] L'ELENCO DESIDERATO DEI COMPONENTI DI UN CICLO (feature 0025).
     *
     * DUE LETTURE, E LA SECONDA E' DEL SOLO JOB.
     *   1. le assegnazioni componente-operazione del ciclo, a oggi — cioe' quello che il progetto
     *      ha sempre fatto, ed e' anche quello che l'albero del cockpit mostra;
     *   2. la distinta del materiale di testata alla data di riferimento del plant, che aggiunge
     *      cio' che la prima non porta: i componenti che in SAP nessuno ha mai agganciato a
     *      un'operazione, e quelli che una modifica tecnica fa entrare in distinta piu' avanti.
     *
     * ENTRAMBE PASSANO DALLA STESSA PREPARAZIONE — quantita' vere ed esplosione dei fantasma —
     * ognuna alla PROPRIA data. Un assieme fantasma puo' entrare in distinta col futuro esattamente
     * come un componente qualunque, e cercarne i figli sulla distinta di oggi non troverebbe
     * nulla.
     *
     * DATA ASSENTE = SECONDA LETTURA SPENTA, cioe' il comportamento di prima della 0025. E' lo
     * stato del primo rilascio, e la ragione per cui questa funzione non cambia niente finche'
     * nessuno configura la data.
     *
     * NON LANCIA. Qualunque intoppo sulla seconda lettura riporta all'elenco della prima e viene
     * DICHIARATO: un perimetro rimasto quello di ieri e un perimetro allargato correttamente non
     * si distinguono guardando il ciclo.
     *
     * @param {Array<object>} allocs righe di ProductionRoutingCompAlloc gia' filtrate sul materiale
     * @param {{ plant: string, headerMaterial: string, tag: string, cache?: object }} ctx
     * @returns {Promise<{ components: Array<object>, keyDate: Date|null, honored: boolean,
     *   secondError: string, merge: object|null, phantomUnresolved: number, qtyBad: number,
     *   altUnit: Array<object> }>}
     */
    const buildDesiredRoutingComponents = async (allocs, ctx) => {
      const plant = routingMaterialRules.keyPart(ctx && ctx.plant);
      const headerMaterial = routingMaterialRules.keyPart(ctx && ctx.headerMaterial);
      const tag = (ctx && ctx.tag) || '';
      // UNA cache per le due letture: la lettura a oggi e quella alla data di riferimento hanno
      // chiavi diverse (vedi bomExplode.cacheDateKey) e quindi convivono senza sovrascriversi,
      // mentre l'esplosione dei fantasma di ciascuna riusa la propria.
      const cache = (ctx && ctx.cache) || bomExplode.createExplodeCache();

      const first = await prepareRoutingComponents(routingComponentsOf(allocs), {
        plant, headerMaterial, tag, cache, explosionDate: null
      });
      const cycleComponents = (first.components || []).filter((c) => c.Material);

      const out = {
        components: cycleComponents,
        keyDate: null,
        honored: true,
        secondError: '',
        merge: null,
        phantomUnresolved: (first.stats && Number(first.stats.unresolved)) || 0,
        qtyBad: first.qty ? (Number(first.qty.unresolved) + Number(first.qty.roundedToZero)) : 0,
        altUnit: (first.qty && first.qty.altUnit) || []
      };

      if (!plant || !headerMaterial) return out;

      try {
        const db = await cds.connect.to('db');
        const config = await bomExplode.resolveExplodeConfig(db, plant);
        const keyDate = routingCompRules.normalizeKeyDate(config.RoutingBomKeyDate);
        if (!keyDate) {
          // Campo compilato ma illeggibile: e' un difetto di configurazione, e tacerlo lo
          // renderebbe identico a un campo mai compilato.
          const raw = String(config.RoutingBomKeyDate || '').trim();
          if (raw) {
            out.secondError = `data di riferimento della distinta non interpretabile ("${raw}"):`
              + ' seconda lettura non eseguita';
            console.warn(`>>> [ROUTING-COMP-SOURCE] ${tag}: ${out.secondError}`);
          }
          return out;
        }
        out.keyDate = keyDate;

        const read = await bomExplode.listBomComponents(headerMaterial, plant, config, cache, keyDate);
        out.honored = read.honored;
        if (read.error) {
          out.secondError = read.error;
          return out;
        }
        // Il canale storico non sa esprimere la data, che quindi non viene inviata. La lettura
        // porta comunque la distinta — e con essa i componenti che in SAP nessuno ha agganciato a
        // un'operazione, che e' meta' del valore della feature — ma cio' che torna NON e' la
        // distinta a quella data. Si prosegue e lo si dichiara: fermarsi renderebbe la feature
        // inesercitabile in sviluppo, tacere farebbe credere che le modifiche tecniche non
        // producano nulla.
        if (!read.honored) {
          console.warn(`>>> [ROUTING-COMP-SOURCE] ${tag}: il canale attivo non sa esprimere la data`
            + ` ${routingCompRules.keyDateLabel(keyDate)}, che non viene inviata: cio' che la`
            + ' seconda lettura restituisce non e\' la distinta a quella data');
        }

        const second = await prepareRoutingComponents(
          bomComponentsOf(read.rows, read.bomNumber),
          {
            plant,
            headerMaterial,
            cache,
            explosionDate: keyDate,
            tag: `${tag} distinta al ${routingCompRules.keyDateLabel(keyDate)}`
          }
        );
        const bomComponents = (second.components || []).filter((c) => c.Material);

        const merged = routingCompRules.mergeComponentSources(cycleComponents, bomComponents);
        out.components = merged.components;
        out.merge = merged.stats;
        out.phantomUnresolved += (second.stats && Number(second.stats.unresolved)) || 0;
        if (second.qty) {
          out.qtyBad += Number(second.qty.unresolved) + Number(second.qty.roundedToZero);
          out.altUnit = out.altUnit.concat(second.qty.altUnit || []);
        }
        console.log(`>>> [ROUTING-COMP-SOURCE] ${tag}: ${merged.stats.cycle} componenti dal ciclo,`
          + ` ${merged.stats.bom} dalla distinta al ${routingCompRules.keyDateLabel(keyDate)},`
          + ` ${merged.stats.added} aggiunti -> ${merged.stats.total} desiderati`);
      } catch (error) {
        // Come sopra: si torna all'elenco della prima lettura e lo si dichiara.
        out.secondError = error.message;
        console.error(`>>> [ROUTING-COMP-SOURCE] ${tag}: seconda lettura NON eseguita`
          + ` (${error.message}): componenti del solo ciclo`);
      }
      return out;
    };

    /**
     * [PHANTOM-EXPLODE] [W1-05] La stessa preparazione, ma sulla forma dell'entity
     * `RoutingComponentAllocations`.
     *
     * Serve alla sola READ, che deve restituire righe di assegnazione e non componenti. Le righe
     * esplose ricevono una chiave SINTETICA, `<nodoPadre>.<n>`, perche' non hanno un'assegnazione
     * propria in SAP e la chiave OData deve comunque essere unica — con la chiave del padre
     * ripetuta, un fantasma con due figli ne farebbe vedere uno solo.
     *
     * [W1-05] LE RIGHE DIRETTE NON TORNANO PIU' INTATTE, E LA DIFFERENZA E' MINORE DI QUANTO
     * SEMBRI. Prima erano l'oggetto letto da SAP, byte per byte; ora ricevono `quantita'` e
     * `unita'` dalla distinta. Non e' una mutazione nuova: la READ assegnava GIA' quei due campi
     * poche righe piu' su, con i ripieghi `1` e `''` — questa scrittura sostituisce un valore
     * finto con quello vero, e nient'altro cambia. Il resto della riga resta quello di SAP.
     *
     * Per lo stesso motivo il salto anticipato non guarda piu' `exploded` ma `changed`: con
     * l'esplosione spenta le quantita' sono comunque cambiate, e uscire prima rimetterebbe in
     * pagina i ripieghi.
     *
     * @param {Array<object>} allocs righe lette da ProductionRoutingCompAlloc
     * @param {{ plant: string, headerMaterial: string, tag: string, cache?: object }} ctx
     * @returns {Promise<Array<object>>}
     */
    const explodeAllocRows = async (allocs, ctx) => {
      if (!allocs || !allocs.length) return allocs || [];
      const { components, changed } = await prepareRoutingComponents(routingComponentsOf(allocs), ctx);
      if (!changed) return allocs;

      let n = 0;
      return components.map((c) => {
        const base = c._alloc;
        if (!c.PhantomSource) {
          // Riga diretta: solo i due campi della quantita', sull'oggetto letto da SAP.
          return {
            ...base,
            BillOfMaterialItemQuantity: c.RequiredQuantity,
            BillOfMaterialItemUnit: c.BaseUnit || DEFAULT_COMP_UNIT
          };
        }
        n++;
        return {
          ...base,
          ProdnRtgOpBOMItemInternalID: `${base.ProdnRtgOpBOMItemInternalID || ''}.${n}`,
          BillOfMaterialComponent: c.Material,
          BillOfMaterialItemNodeNumber: c.BOMItemNodeNumber || null,
          BillOfMaterialItemQuantity: c.RequiredQuantity,
          BillOfMaterialItemUnit: c.BaseUnit || DEFAULT_COMP_UNIT,
          PhantomSource: c.PhantomSource,
          PhantomPath: c.PhantomPath || ''
        };
      });
    };

    /**
     * [ROUTING-SCOPE] Il ciclo e' fuori perimetro? Per i percorsi che LEGGONO.
     *
     * Rispondono `[]` e non un errore: una collection filtrata che non trova nulla e' una risposta
     * legittima, ed e' esattamente «non esiste». Il motivo va nel log, non in faccia all'utente —
     * che oltretutto ci arriva solo per URL costruito a mano, visto che dalla lista il ciclo non
     * e' raggiungibile.
     *
     * Senza gruppo non si puo' decidere: si lascia passare, perche' il chiamante ha gia' i suoi
     * controlli su una lettura senza criteri.
     *
     * LA DIREZIONE DEL FALLIMENTO E' OPPOSTA A QUELLA DEI PERCORSI CHE SCRIVONO, di proposito.
     * Blocca solo su un verdetto ACCERTATO — ciclo fuori regole, o ciclo che SAP non conosce.
     * Se il perimetro non e' VERIFICABILE (SAP irraggiungibile, configurazione illeggibile) si
     * lascia passare: una lettura non scrive niente da nessuna parte, mentre nascondere durante un
     * disservizio farebbe sparire agli occhi dell'utente il lavoro che ha gia' salvato — e con
     * SAP giu' il ciclo Plex salvato in locale e' l'unica cosa che gli resta da guardare.
     * Sui percorsi che scrivono la stessa incertezza blocca, perche' li' il danno e' l'opposto.
     */
    async function routingOutOfScopeForRead(req, group, routing) {
      if (!group) return false;
      const db = await cds.connect.to('db');
      const verdict = await checkRoutingInScope(req, db, group, routing);
      if (verdict.ok) return false;
      if (verdict.code === 'routingScopeUnavailable') {
        console.warn(`>>> [ROUTING-SCOPE] perimetro di ${group}/${routing} NON verificabile:`
          + ' la lettura passa (una lettura non scrive niente)');
        return false;
      }
      console.log(`>>> [ROUTING-SCOPE] lettura di ${group}/${routing} respinta (${verdict.code}):`
        + ' il ciclo non esiste per noi, si risponde vuoto');
      return true;
    }

    /**
     * [ROUTING-BY-MATERIAL] Il filtro (ciclo, materiale) per le letture del ciclo salvato. Estratto
     * in una funzione perche' sono tre i campi da leggere in tre handler diversi, e dimenticare
     * `HeaderMaterial` in uno dei tre significherebbe restituire il ciclo di TUTTI i materiali.
     *
     * `HeaderMaterial` si applica solo se il client lo manda: senza, la lettura resta quella di
     * prima e serve ai casi che ragionano per ciclo (es. il job che enumera cosa e' stato salvato).
     *
     * [KEY-READ] Prende la QUERY e non il `where`, e legge il criterio EFFETTIVO: su una lettura
     * per chiave — `PlexRoutingCycleOperations(<uuid>)` — CAP mette il predicato in
     * `SELECT.from.ref[<ultimo>].where`, quindi il loop di prima trovava `{}` e la SELECT leggeva
     * LA TABELLA INTERA, cioe' i cicli di tutti i materiali di tutti i plant. `ID` entra fra i
     * nomi riconosciuti perche' e' la chiave di queste tre proiezioni.
     *
     * Il valore VUOTO e' un valore: `equalitiesOf` guarda `'val' in node` e non la verita' del
     * valore, quindi un `HeaderMaterial = ''` — che sull'entity dei cicli e' una chiave legittima —
     * ora filtra invece di essere scartato.
     * @param {object} query CQN della richiesta
     * @returns {object} filtro per una SELECT locale
     */
    function routingCycleFilter(query) {
      return keyReadRules.equalitiesOf(
        keyReadRules.readWhere(query),
        ['ProductionRoutingGroup', 'ProductionRouting', 'HeaderMaterial', 'ID']
      ).equals;
    }

    /**
     * [KEY-READ] Il gate di perimetro dei cicli, applicabile ANCHE a una lettura per `ID`.
     *
     * `routingOutOfScopeForRead` esce a `false` senza gruppo, e su una lettura per chiave il gruppo
     * non e' nel criterio: l'URL con l'UUID scavalcava quindi [ROUTING-SCOPE], che e' anche il gate
     * del PLANT (passa da `checkRoutingInScope` -> testata del ciclo -> `hdr.Plant`). Qui il gruppo
     * si prende dalla riga LETTA quando il criterio non ce l'ha: il filtro seleziona per
     * costruzione le righe di un ciclo solo, quindi il gruppo della prima riga e' quello di tutte.
     */
    async function routingCycleOutOfScope(req, filter, rows) {
      const group = filter.ProductionRoutingGroup || (rows[0] || {}).ProductionRoutingGroup;
      const routing = filter.ProductionRouting || (rows[0] || {}).ProductionRouting;
      return routingOutOfScopeForRead(req, group, routing);
    }

    /**
     * [KEY-READ] Una lettura senza NESSUN criterio renderebbe la tabella intera: si rifiuta, come
     * fanno da sempre gli altri handler dei figli del ciclo (`if (!sGroup) return []`).
     */
    function routingCycleRefused(label, filter) {
      if (Object.keys(filter).length) return false;
      console.log(`>>> [KEY-READ] READ ${label} senza alcun criterio: richiesta RIFIUTATA`
        + ' (una lettura senza criteri renderebbe la tabella intera, di tutti i cicli)');
      return true;
    }

    // READ handler for /production-routings/PlexRoutingCycleOperations
    // Reads saved Plex operations linked to a routing AND header material from the local DB
    this.on('READ', 'PlexRoutingCycleOperations', async (req) => {
      console.log(">>> READ PlexRoutingCycleOperations");

      const db = await cds.connect.to('db');
      const { ZPlexRoutingCycleOperation } = db.entities('avvaleplm.marsplm.sap2plex');
      const filter = routingCycleFilter(req.query);

      if (routingCycleRefused('PlexRoutingCycleOperations', filter)) return [];

      const results = await db.run(
        SELECT.from(ZPlexRoutingCycleOperation)
          .where(filter)
          .orderBy('OperationNumber asc')
      );

      // [ROUTING-SCOPE] Il ciclo salvato di un ciclo fuori perimetro non si legge: e' il ciclo
      // Plex di qualcosa che per noi non esiste. Il dato NON si cancella — se lo stato torna in
      // perimetro il lavoro fatto e' ancora li' — semplicemente non lo si serve.
      // [KEY-READ] Il gate gira DOPO la lettura, perche' su una lettura per `ID` il gruppo non e'
      // nel criterio e senza di lui il gate uscirebbe subito a «passa»: lo si prende dalla riga.
      if (await routingCycleOutOfScope(req, filter, results)) return [];

      console.log(`>>> PlexRoutingCycleOperations: ${results.length} operations found`
        + ` (filtro=${JSON.stringify(filter)})`);
      return results;
    });

    // READ handler for /production-routings/PlexRoutingCycleComponents
    this.on('READ', 'PlexRoutingCycleComponents', async (req) => {
      console.log('>>> READ PlexRoutingCycleComponents');

      const db = await cds.connect.to('db');
      const { ZPlexRoutingCycleComponent } = db.entities('avvaleplm.marsplm.sap2plex');
      const filter = routingCycleFilter(req.query);

      if (routingCycleRefused('PlexRoutingCycleComponents', filter)) return [];

      try {
        const results = await db.run(
          SELECT.from(ZPlexRoutingCycleComponent)
            .where(filter)
            .orderBy('PlexOperationId asc', 'Sequence asc')
        );
        // [ROUTING-SCOPE] + [KEY-READ]: vedi il gemello delle operazioni qui sopra — il gate gira
        // dopo la lettura, cosi' vale anche per una lettura per `ID`, dove il gruppo non e' nel
        // criterio e il gate uscirebbe altrimenti a «passa».
        if (await routingCycleOutOfScope(req, filter, results)) return [];
        console.log(`>>> PlexRoutingCycleComponents: ${results.length} components found`);
        return results;
      } catch (error) {
        console.error('>>> ERROR reading PlexRoutingCycleComponents:', error.message);
        return [];
      }
    });

    // READ handler for /production-routings/PlexRoutingApprovedWorkcenters
    // [ROUTING-SCOPE] Questa entity era una proiezione NUDA, senza handler: leggeva tutte le righe
    // di tutti i cicli di tutti i plant. E' la terza tabella del ciclo salvato e deve comportarsi
    // come le altre due — stesso filtro, stesso gate di perimetro.
    this.on('READ', 'PlexRoutingApprovedWorkcenters', async (req) => {
      console.log('>>> READ PlexRoutingApprovedWorkcenters');

      const db = await cds.connect.to('db');
      const { ZPlexRoutingApprovedWorkcenter } = db.entities('avvaleplm.marsplm.sap2plex');
      const filter = routingCycleFilter(req.query);

      if (routingCycleRefused('PlexRoutingApprovedWorkcenters', filter)) return [];

      try {
        const results = await db.run(SELECT.from(ZPlexRoutingApprovedWorkcenter).where(filter));
        // [ROUTING-SCOPE] + [KEY-READ]: vedi il gemello delle operazioni qui sopra.
        if (await routingCycleOutOfScope(req, filter, results)) return [];
        console.log(`>>> PlexRoutingApprovedWorkcenters: ${results.length} workcenters found`);
        return results;
      } catch (error) {
        console.error('>>> ERROR reading PlexRoutingApprovedWorkcenters:', error.message);
        return [];
      }
    });

    // autoAssignPlexCycle action - resolve BOM components to Plex operations via
    // the ZObjectGroup / ZCycleAutoAssignConfig customizing (see resolveAutoAssignments).
    this.on('autoAssignPlexCycle', async (req) => {
      const { ProductionRoutingGroup, ProductionRouting, Material, Operations } = req.data;
      console.log(`>>> autoAssignPlexCycle (routing): group=${ProductionRoutingGroup},`
        + ` routing=${ProductionRouting}, material=${Material || '(non passato)'}`
        + `, regole dal template: ${templateGroupRules.hasAnyGroup(Operations) ? 'SI' : 'no'}`);

      try {
        // [ROUTING-DEFAULT-OP] La lettura delle assegnazioni sta in `resolveRoutingCompAllocs`.
        const { ProductionRoutingMatlAssgmt, ProductionRoutingHeader } = this.S4Routing.entities;
        const db = await cds.connect.to('db');

        // [ROUTING-SCOPE] Plant attivo E ciclo dentro il perimetro, PRIMA di ogni altra cosa.
        // Prima il controllo del plant stava in fondo, dopo un `return` di comodo sul plant
        // mancante: una testata assente usciva con un risultato VUOTO e di successo, senza mai
        // passare dal gate. Ora la testata assente e' un rifiuto esplicito, come deve essere per
        // un ciclo che non esiste.
        const { blocked, hdr } = await rejectIfRoutingNotUsable(req, db, ProductionRoutingGroup, ProductionRouting);
        if (blocked) return;
        const plant = hdr && hdr.Plant;
        // ================================================================
        // [ROUTING-BY-MATERIAL] Il materiale ARRIVA dal chiamante. Prima veniva dedotto leggendo
        // la prima assegnazione del ciclo, cioe' l'auto-assegnazione girava SEMPRE sul primo
        // materiale, qualunque fosse quello che l'utente stava lavorando: su un ciclo con sei
        // materiali (come 07N01028) cinque utenti su sei ottenevano l'assegnazione di un altro.
        // Il ripiego al primo materiale resta per i chiamanti che non lo passano ancora.
        // ================================================================
        let headerMaterial = routingMaterialRules.keyPart(Material);
        if (!headerMaterial) {
          const matl = await this.S4Routing.run(
            SELECT.one.from(ProductionRoutingMatlAssgmt).columns('Product')
              .where({ ProductionRoutingGroup, ProductionRouting })
          );
          headerMaterial = routingMaterialRules.keyPart(matl && matl.Product);
          if (headerMaterial) {
            console.warn('>>> [ROUTING-BY-MATERIAL] autoAssign routing: materiale non passato,'
              + ` ripiego sul primo del ciclo (${headerMaterial})`);
          }
        }
        // Il plant a questo punto c'e' per costruzione (il gate sopra lo garantisce): resta il
        // solo caso del ciclo senza alcuna assegnazione materiale, che non ha nulla da assegnare.
        if (!headerMaterial) {
          console.log('>>> autoAssign routing: nessun materiale di testata, niente da assegnare');
          return { Plant: plant || '', HeaderMaterial: '', assignments: [], unassigned: [], counts: { total: 0, assigned: 0, unassigned: 0 } };
        }

        // [ROUTING-DEFAULT-OP] La sorgente delle assegnazioni, dal punto unico: `PLMZ` oppure la
        // distinta con l'allocazione dichiarata, secondo il customizing DI QUESTO plant.
        const aaTag = `auto-assegna ${ProductionRoutingGroup}/${ProductionRouting}/${headerMaterial}`;
        const aaCache = bomExplode.createExplodeCache();
        const aaSrc = await resolveRoutingCompAllocs({
          group: ProductionRoutingGroup, routing: ProductionRouting, plant,
          headerMaterial, cache: aaCache, tag: aaTag
        });
        let allocs = aaSrc.allocs;
        // [ROUTING-BY-MATERIAL] La distinta serve per tenere i soli componenti DI QUESTO
        // materiale: `PLMZ` porta le posizioni di tutte le distinte dei materiali del ciclo.
        // Sull'altra sorgente le righe vengono GIA' dalla distinta di questo materiale: il
        // confronto non avrebbe un secondo termine, e il ripiego «come prima» non c'e' da fare.
        if (aaSrc.mode === 'ALLOC') {
          const boms = await resolveMaterialBomKeys(
            headerMaterial, ProductionRoutingGroup, ProductionRouting, ProductionRoutingHeader, plant);
          if (boms.size > 0) {
            const before = allocs.length;
            allocs = allocs.filter(a => routingMaterialRules.belongsToMaterial(a, boms));
            console.log(`>>> [ROUTING-BY-MATERIAL] autoAssign: ${allocs.length} di ${before} componenti`
              + ` appartengono alla distinta di ${headerMaterial}`);
          } else {
            console.warn(`>>> [ROUTING-BY-MATERIAL] autoAssign: distinta di ${headerMaterial} non risolta,`
              + ' si auto-assegnano i componenti di tutte le distinte del ciclo (come prima)');
          }
        } else if (aaSrc.noBom) {
          // Non si blocca: qui si PREPARA, non si scrive verso Plex. Ma zero componenti con questa
          // sorgente e' un fatto, non un esito normale, e va detto — il blocco vero sta sull'invio.
          console.warn(`>>> [ROUTING-DEFAULT-OP] autoAssign: la distinta di ${headerMaterial} non ha`
            + ' componenti: nessuna assegnazione da proporre');
        }

        // SORGENTE CAMBIATA (v3): materiale componente direttamente dal routing, niente BOM.
        // [PHANTOM-EXPLODE] [W1-05] Costruzione, quantità dalla distinta ed esplosione in un punto
        // solo, condiviso con la READ e con `syncRoutingPlexCycle`: vedi `routingComponentsOf` /
        // `prepareRoutingComponents`. Le quantità servono anche qui: da `resolveAutoAssignments`
        // finiscono nelle righe di `ZPlexRoutingCycleComponent`, cioè in ciò che va a Plex.
        const { components: prepared } = await prepareRoutingComponents(routingComponentsOf(allocs), {
          plant,
          headerMaterial,
          cache: aaCache,
          tag: aaTag
        });
        const components = prepared.filter((c) => c.Material);

        // [TEMPLATE-AUTOASSIGN] Le regole che il template appena importato porta e che il database
        // ancora non ha. Le compone lo STESSO modulo puro che le persiste al salvataggio del ciclo:
        // e' cio' che fa combaciare questa anteprima con l'albero del dopo-Salva. Senza gruppi
        // l'override e' vuoto e la lettura resta quella di sempre.
        const { rows: configOverride, skipped: aaSkipped } =
          templateGroupRules.autoAssignRowsOf(Operations, headerMaterial);
        if (aaSkipped.length) {
          console.warn('>>> [TEMPLATE-AUTOASSIGN] gruppi senza operazione bersaglio, ignorati'
            + ` nell'anteprima: ${aaSkipped.join(', ')}`);
        }
        const result = await resolveAutoAssignments({
          plant, headerMaterial, components, configOverride
        });
        console.log(`>>> autoAssign routing: ${result.counts.assigned}/${result.counts.total} assigned, ${result.counts.unassigned} unassigned`);
        // [AUTO-ASSIGN] I non assegnati si NOMINANO, col motivo e coi gruppi che avevano agganciato.
        // Il contatore qui sopra dice quanti; da solo non basta a sapere quale riga di customizing
        // manca, ed e' esattamente cio' che l'11/09/2026 ha costretto a leggere il codice per capire.
        // Stesso tetto del recap del job: nominarli tutti non sarebbe leggibile.
        if (result.unassigned.length) {
          const named = result.unassigned.slice(0, 10)
            .map((u) => `${u.Material} (${u.Reason}`
              + (u.Groups && u.Groups.length ? `: gruppi ${u.Groups.join(', ')}` : '') + ')')
            .join(' · ');
          const more = result.unassigned.length > 10 ? ` · e altri ${result.unassigned.length - 10}` : '';
          console.warn(`>>> [AUTO-ASSIGN] ${aaTag}: non assegnati — ${named}${more}`);
        }
        return { Plant: plant, HeaderMaterial: headerMaterial, ...result };
      } catch (error) {
        console.error('>>> ERROR autoAssignPlexCycle (routing):', error.message);
        req.error(500, error.message);
      }
    });

    // saveRoutingPlexCycle action - batch save (DELETE + INSERT)
    // ================================================================
    // [ROUTING-BY-MATERIAL] IL DELETE E' CIRCOSCRITTO AL MATERIALE, e non e' un dettaglio: con la
    // `where` di prima — solo (gruppo, contatore) — salvare il ciclo di un materiale CANCELLAVA il
    // ciclo di tutti gli altri materiali dello stesso ciclo SAP. Su un ciclo con sei materiali
    // sarebbe stata una perdita di dati silenziosa a ogni salvataggio.
    // Il materiale e' obbligatorio proprio per questo: senza, il delete tornerebbe ad avere una
    // portata che nessuno ha chiesto. Meglio rifiutare la richiesta che indovinare.
    // ================================================================
    this.on('saveRoutingPlexCycle', async (req) => {
      const { ProductionRoutingGroup, ProductionRouting, Operations } = req.data;
      const HeaderMaterial = routingMaterialRules.keyPart(req.data.Material);
      console.log(`>>> saveRoutingPlexCycle: Group=${ProductionRoutingGroup}, Routing=${ProductionRouting},`
        + ` material=${HeaderMaterial || '(assente)'}, ops=${Operations ? Operations.length : 0}`);

      const db = await cds.connect.to('db');
      const { ZPlexRoutingCycleOperation, ZPlexRoutingCycleComponent, ZPlexRoutingApprovedWorkcenter } = db.entities('avvaleplm.marsplm.sap2plex');

      try {
        // [ROUTING-SCOPE] Plant attivo E ciclo dentro il perimetro configurato: un ciclo fuori
        // dalle regole non esiste per noi, quindi non se ne salva il ciclo Plex. Una sola lettura
        // di testata per entrambi i controlli.
        const { blocked, hdr } = await rejectIfRoutingNotUsable(req, db, ProductionRoutingGroup, ProductionRouting);
        if (blocked) return;

        // [ROUTING-BY-MATERIAL] Nessun materiale, nessun salvataggio: vedi il blocco sopra.
        // L'unico caso legittimo di materiale vuoto e' il ciclo SAP senza alcuna assegnazione, e
        // quello non ha una part Plex su cui vivere, quindi non ha un ciclo da salvare.
        if (!HeaderMaterial) {
          req.error(400, getLocalizedMessage(req, 'routingCycleMaterialRequired', 'marsplm-sap2plex'));
          return;
        }

        // [W1-08] UN WORK CENTER SU UNA SOLA OPERAZIONE del ciclo di questa part (BBP §7.6.2), e il
        // controllo sta QUI, PRIMA del delete: il perimetro del confronto e' esattamente cio' che
        // si sta scrivendo — (gruppo, contatore, materiale) — quindi tutto quello che serve e' nel
        // payload, senza rileggere niente. Su altri cicli SAP dello stesso materiale non si
        // guarda: sono cicli alternativi legittimi (DEC-66).
        // Il `req.error` e' ammesso perche' nessuna scrittura e' ancora partita (0012, RB-15); un
        // ciclo rifiutato lascia intatto quello salvato prima, che e' il solo esito accettabile —
        // un delete eseguito e un insert rifiutato lo avrebbe svuotato.
        const wcConflict = workcenterConflictMessage(req, Operations);
        if (wcConflict) {
          console.warn(`>>> [W1-08] saveRoutingPlexCycle rifiutato: ${wcConflict}`);
          req.error(400, wcConflict, 'Operations');
          return;
        }

        // Step 1: DELETE old workcenters, components and operations for this routing AND material
        const scope = { ProductionRoutingGroup, ProductionRouting, HeaderMaterial };
        await db.run(DELETE.from(ZPlexRoutingApprovedWorkcenter).where(scope));
        await db.run(DELETE.from(ZPlexRoutingCycleComponent).where(scope));
        await db.run(DELETE.from(ZPlexRoutingCycleOperation).where(scope));

        let totalComponents = 0;
        let totalWorkcenters = 0;

        // Step 2: INSERT new operations
        if (Operations && Operations.length > 0) {
          const opEntries = Operations.map((op, index) => ({
            ID: cds.utils.uuid(),
            ProductionRoutingGroup,
            ProductionRouting,
            HeaderMaterial,
            PlexOperationId: op.PlexOperationId,
            OperationCode: op.OperationCode,
            OperationName: op.OperationName,
            Sequence: op.OperationNumber || (index + 1) * 10,
            SAPOperationId: op.SAPOperationId || null,
            ProductionRoutingOpIntID: op.ProductionRoutingOpIntID || null,
            OperationNumber: op.OperationNumber || (index + 1) * 10,
            OperationType: op.OperationType || null,
            SubOperation: op.SubOperation || false,
            Shippable: op.Shippable || false,
            NetWeight: op.NetWeight || null,
            StandardQuantity: op.StandardQuantity || null
          }));

          await db.run(INSERT.into(ZPlexRoutingCycleOperation).entries(opEntries));

          // Step 3: INSERT components for each operation
          const compEntries = [];
          Operations.forEach(op => {
            if (op.Components && op.Components.length > 0) {
              op.Components.forEach((comp, compIndex) => {
                compEntries.push({
                  ID: cds.utils.uuid(),
                  ProductionRoutingGroup,
                  ProductionRouting,
                  HeaderMaterial,
                  PlexOperationId: op.PlexOperationId,
                  Material: comp.Material,
                  BOMItemNodeNumber: comp.BOMItemNodeNumber || null,
                  RequiredQuantity: comp.RequiredQuantity || 0,
                  BaseUnit: comp.BaseUnit || '',
                  Sequence: (compIndex + 1) * 10,
                  // [PHANTOM-EXPLODE] Come la gemella del ramo ordini: la provenienza arriva dal
                  // client insieme al componente.
                  PhantomSource: comp.PhantomSource || '',
                  // [ROUTING-COMP-SOURCE] Chi l'ha collocato. Il salvataggio ricrea le righe
                  // (DELETE + INSERT), quindi se questo campo non arrivasse dal client la
                  // provenienza si azzererebbe a ogni salvataggio e il job tornerebbe a spostare
                  // anche cio' che una persona ha messo a mano. Assente = 'AUTO' (DEC-02: la
                  // validazione dei valori ammessi sta qui, non nell'annotazione).
                  AssignmentSource: routingCompRules.normalizeOrigin(comp.AssignmentSource)
                });
              });
            }
          });

          if (compEntries.length > 0) {
            await db.run(INSERT.into(ZPlexRoutingCycleComponent).entries(compEntries));
            totalComponents = compEntries.length;
          }

          // Step 4: INSERT approved workcenters for each operation
          const wcEntries = [];
          Operations.forEach(op => {
            if (op.ApprovedWorkcenters && op.ApprovedWorkcenters.length > 0) {
              op.ApprovedWorkcenters.forEach(wc => {
                wcEntries.push({
                  ID: cds.utils.uuid(),
                  ProductionRoutingGroup,
                  ProductionRouting,
                  HeaderMaterial,
                  PlexOperationId: op.PlexOperationId,
                  WorkcenterId: wc.WorkcenterId,
                  WorkcenterCode: wc.WorkcenterCode || '',
                  WorkcenterName: wc.WorkcenterName || ''
                });
              });
            }
          });

          if (wcEntries.length > 0) {
            await db.run(INSERT.into(ZPlexRoutingApprovedWorkcenter).entries(wcEntries));
            totalWorkcenters = wcEntries.length;
          }
        }

        // ================================================================
        // [TEMPLATE-AUTOASSIGN] LE REGOLE DI AUTO-ASSEGNAZIONE DEL MATERIALE
        //
        // Se le operazioni portano ALMENO UN gruppo — cioe' se questo salvataggio segue un import
        // di template che ne aveva — la configurazione di `ZCycleAutoAssignConfig` di questo
        // (plant, materiale) si SOSTITUISCE con le terne del template. Nessun gruppo: non si tocca
        // niente, ed e' il caso normale di ogni salvataggio di ciclo — `hasAnyGroup` e' un
        // `.some()` in memoria, quindi la strada ordinaria non paga nemmeno una query.
        //
        // SI CANCELLA TUTTO IL MATERIALE, non i soli gruppi che il template nomina: il template
        // diventa l'unica descrizione della configurazione di quel materiale. Cancellare i soli
        // gruppi nominati sarebbe una fusione, e lascerebbe in vita regole che il template ha
        // deciso di non avere.
        //
        // LE RIGHE `Material = '*'` NON ENTRANO nel perimetro, e l'uguaglianza le esclude da se'.
        // Sono il ripiego di PLANT, valido per tutti i materiali di testata: la forma da non
        // imitare e' la lettura di srv/lib/autoAssign.js (`Material: { in: [mat, '*'] }`), che
        // risponde a un'altra domanda. Da li' anche il rifiuto di un materiale uguale a `'*'`:
        // riscriverebbe il ripiego del plant credendo di scrivere un materiale.
        // ================================================================
        let autoAssignRewritten = false;
        let autoAssignRows = 0;
        if (templateGroupRules.hasAnyGroup(Operations)) {
          const plant = hdr && hdr.Plant;
          if (!plant) {
            console.warn('>>> [TEMPLATE-AUTOASSIGN] plant del ciclo non noto:'
              + ' la configurazione di auto-assegnazione NON viene riscritta');
          } else if (HeaderMaterial === '*') {
            console.warn('>>> [TEMPLATE-AUTOASSIGN] materiale di testata `*`: riscrittura RIFIUTATA'
              + ' (sarebbe il ripiego di plant, non un materiale)');
          } else {
            // Il conflitto si rifiuta PRIMA di cancellare: un delete eseguito con l'insert rifiutato
            // dal vincolo `(Plant, Material, ComponentGroup)` lascerebbe il materiale SENZA
            // configurazione. Stessa ragione, e stessa collocazione, del controllo dei work center.
            const groupConflict = templateGroupConflictMessage(req, Operations);
            if (groupConflict) {
              console.warn(`>>> [TEMPLATE-AUTOASSIGN] saveRoutingPlexCycle rifiutato: ${groupConflict}`);
              req.error(400, groupConflict, 'Operations');
              return;
            }

            const { ZCycleAutoAssignConfig } = db.entities('avvaleplm.marsplm.sap2plex');
            // Le righe le compone lo STESSO modulo puro che alimenta l'anteprima di
            // «Auto-Assegna»: se fossero due, l'albero cambierebbe dopo il Salva senza un errore.
            const { rows, skipped } = templateGroupRules.autoAssignRowsOf(Operations, HeaderMaterial);
            if (skipped.length) {
              console.warn('>>> [TEMPLATE-AUTOASSIGN] gruppi senza operazione bersaglio, scartati:'
                + ` ${skipped.join(', ')}`);
            }

            await db.run(DELETE.from(ZCycleAutoAssignConfig).where({ Plant: plant, Material: HeaderMaterial }));
            if (rows.length) {
              await db.run(INSERT.into(ZCycleAutoAssignConfig).entries(rows.map(r => ({
                ID: cds.utils.uuid(),
                Plant: plant,
                Material: r.Material,
                ComponentGroup: r.ComponentGroup,
                PlexOperation: r.PlexOperation,
                PlexOperationName: r.PlexOperationName
              }))));
            }
            autoAssignRewritten = true;
            autoAssignRows = rows.length;
            console.log(`>>> [TEMPLATE-AUTOASSIGN] plant ${plant}, materiale ${HeaderMaterial}:`
              + ` configurazione sostituita con ${rows.length} regole dal template`);
          }
        }

        console.log(`>>> Routing Plex cycle saved: ${Operations ? Operations.length : 0} operations, ${totalComponents} components, ${totalWorkcenters} workcenters`);
        return {
          success: true,
          count: Operations ? Operations.length : 0,
          autoAssignRewritten,
          autoAssignRows
        };
      } catch (error) {
        console.error('>>> ERROR saving Routing Plex cycle:', error.message);
        req.error(500, error.message);
      }
    });

    // ================================================================
    // [MASS-IMPORT] IMPORT MASSIVO DI UN TEMPLATE SU N BERSAGLI.
    //
    // NON REIMPLEMENTA NIENTE, ed e' tutto il disegno: per ogni bersaglio chiama
    // `saveRoutingPlexCycle`, che e' gia' l'unica implementazione della sostituzione del ciclo,
    // della riscrittura delle regole di auto-assegnazione [TEMPLATE-AUTOASSIGN] e dei gate di
    // perimetro. Un import massivo che ricopiasse quei passi finirebbe per costruire un albero
    // diverso da quello dell'import singolo — e nessuno se ne accorgerebbe, perche' i due gesti
    // non si confrontano mai.
    //
    // `this.send` E NON UNA CHIAMATA DIRETTA. Crea una richiesta NUOVA, quindi un rifiuto arriva
    // come eccezione da raccogliere per bersaglio. Chiamando i gate sulla STESSA `req` si
    // accumulerebbero errori su di essa: il primo ciclo fuori perimetro abbatterebbe l'intero
    // blocco, compresi i bersagli che sarebbero passati.
    //
    // IN SEQUENZA E NON IN PARALLELO, a differenza di `sendProductsChunkToPlex`. La' ogni elemento
    // e' una chiamata di rete verso Plex e la concorrenza compra tempo; qui ogni bersaglio e' un
    // delete-then-insert sulle stesse tabelle, e due bersagli dello stesso ciclo che si
    // sovrappongono scriverebbero sullo stesso scope. Il costo e' locale: la testata SAP che il
    // gate legge sta in una cache single-flight per (gruppo, contatore), quindi N materiali dello
    // stesso ciclo pagano UNA lettura.
    //
    // IL BLOCCO E' DEL CLIENT: una richiesta sola su duecento bersagli supererebbe il `timeout`
    // dell'approuter (DEC-131), e un taglio per tempo su una scrittura non e' un rifiuto.
    // ================================================================
    this.on('massImportTemplateChunk', async (req) => {
      const { Plant, Operations, Targets } = req.data;
      const targets = Array.isArray(Targets) ? Targets : [];
      console.log(`>>> [MASS-IMPORT] plant ${Plant || '(assente)'}: ${targets.length} bersagli,`
        + ` ${Array.isArray(Operations) ? Operations.length : 0} operazioni dal template`);

      // Il ruolo si verifica QUI e sul plant del TEMPLATE: il `visible` del pulsante e' comodita',
      // la difesa e' questa. La soglia e' la configurazione, non il cockpit.
      if (await rejectIfNoPlantConfigRole(req, Plant && String(Plant).trim())) return;

      const results = [];
      let success = 0;
      let errors = 0;

      for (const t of targets) {
        const one = {
          ProductionRoutingGroup: t && t.ProductionRoutingGroup,
          ProductionRouting: t && t.ProductionRouting,
          Material: t && t.Material
        };
        try {
          const r = await this.send('saveRoutingPlexCycle', {
            ...one,
            Operations: Operations || []
          });
          results.push({ ...one, ok: true, message: '', autoAssignRows: (r && r.autoAssignRows) || 0 });
          success++;
        } catch (e) {
          // Il messaggio e' gia' localizzato da chi ha rifiutato: si riporta com'e', perche' dice
          // QUALE regola ha fermato quel bersaglio — «3 falliti» senza il motivo manda a indovinare.
          const msg = (e && e.message) || '';
          console.error(`>>> [MASS-IMPORT] ${one.ProductionRoutingGroup}/${one.ProductionRouting}`
            + ` materiale ${one.Material}: FALLITO - ${msg}`);
          results.push({ ...one, ok: false, message: msg.slice(0, 500), autoAssignRows: 0 });
          errors++;
        }
      }

      console.log(`>>> [MASS-IMPORT] blocco concluso: ${success} riusciti, ${errors} falliti`);
      return { results, success, errors };
    });

    // syncRoutingPlexCycle — deactivate old part-operations on Plex, create new ones from local cycle
    // ================================================================
    // [ROUTING-BY-MATERIAL] Sincronizza il ciclo DI UN MATERIALE sulla part di quel materiale.
    // Prima `Material` arrivava come stringa di materiali separati da virgola (la vecchia colonna
    // della lista) e l'handler prendeva `split(',')[0]`: il ciclo finiva SEMPRE sulla part del
    // primo materiale, e gli altri materiali del ciclo non ricevevano nulla — senza che niente lo
    // dicesse, perche' l'esito era un successo.
    // Ora il materiale e' uno, arriva dalla riga di lista, ed e' lo scope di TUTTO: il ciclo
    // locale che si legge, la part Plex su cui si scrive, e la riga di log che si aggiorna.
    // ================================================================
    /**
     * [ROUTING-COMP-SOURCE] Una riga di log dell'invio di un ciclo: posizione in append e testata
     * in upsert, la coppia che il progetto usa da sempre.
     *
     * Estratta perche' dalla 0025 i punti che la scrivono sono TRE — l'invio riuscito, il ramo
     * d'errore e il ciclo BLOCCATO, che non passa per nessuno dei due — e un ciclo che non
     * scrive nulla e' peggio di uno che scrive un esito brutto: il cockpit continuerebbe a
     * mostrare l'esito dell'ultimo invio RIUSCITO come se fosse l'attuale.
     *
     * NON LANCIA MAI: un log non scritto non deve trasformarsi nell'errore dell'operazione che
     * stava descrivendo.
     *
     * [LOG-MSG-I18N] ACCETTA `Segments`, NON UNA STRINGA, ed e' la difesa strutturale della 0029.
     * Finche' un writer accettava un testo libero, un produttore non convertito scriveva `Message`
     * senza `MessageJson`, la lettura ricadeva sul testo salvato e la riga restava nella lingua di
     * chi aveva lanciato l'invio — cioe' il difetto che stiamo chiudendo, ricreato dall'altro lato e
     * invisibile a chi non conosce i testi attesi. Con questa firma non c'e' modo di persistire un
     * messaggio senza il suo codice.
     *
     * @param {object} db
     * @param {object} a chiavi del ciclo, esito, `Segments`, e il corpo per `ResponseJson`
     */
    const writeRoutingSyncLog = async (db, a) => {
      try {
        const now = new Date();
        const day = now.toISOString().split('T')[0];
        // UTC, coerente con SentDate: e' su questa coppia che il job calcola il delta.
        const time = now.toISOString().split('T')[1].split('.')[0];
        const segments = logMsg.normalize(a.Segments);
        const msg = i18nMessages
          .render(segments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE)
          .substring(0, 255);
        const messageJson = logMsg.pack(segments);
        const key = {
          ProductionRoutingGroup: a.ProductionRoutingGroup,
          ProductionRouting: a.ProductionRouting,
          Material: a.Material   // [ROUTING-BY-MATERIAL]
        };
        await db.run(INSERT.into(a.ZRoutingExcLogPOS).entries({
          ...key,
          Counter: a.Counter,
          SentDate: day,
          SentTime: time,
          Status: a.Status,
          Message: msg,
          MessageJson: messageJson,
          // [ROUTING-REQ-TRACE] Le richieste vere, quando ce ne sono state (feature 0031). Sul ciclo
          // BLOCCATO l'elenco e' vuoto per costruzione, ed e' l'informazione giusta: verso Plex non
          // e' partita nessuna chiamata. Un elenco assente e uno vuoto direbbero la stessa cosa a
          // schermo, e non e' la stessa cosa — per questo la chiave c'e' sempre.
          RequestJson: JSON.stringify({ ...key, calls: a.Calls || [] }),
          ResponseJson: JSON.stringify(a.Response || {}),
          ResponseStatus: a.ResponseStatus
        }));
        const existing = await db.run(SELECT.one.from(a.ZRoutingExcLogHDR).where(key));
        const data = { Counter: a.Counter, SentDate: day, SentTime: time, Status: a.Status, Message: msg, MessageJson: messageJson };
        if (existing) await db.run(UPDATE(a.ZRoutingExcLogHDR).set(data).where(key));
        else await db.run(INSERT.into(a.ZRoutingExcLogHDR).entries({ ...key, ...data }));
      } catch (logErr) {
        console.error('>>> syncRoutingPlexCycle: log save failed (non-blocking):', logErr.message);
      }
    };

    this.on('syncRoutingPlexCycle', async (req) => {
      const { ProductionRoutingGroup, ProductionRouting, Material } = req.data;
      // ================================================================
      // [ROUTING-BOM-DRIFT] Modalita' verifica (feature 0047): si invia solo se non combacia.
      //
      // Il confronto e' `=== true`, come ogni flag di questo handler: un chiamante che passi
      // qualcosa di diverso da `true` ottiene l'invio di sempre, che e' il comportamento
      // conservativo — e nessun percorso esistente passa questo campo.
      // ================================================================
      const verifyOnly = req.data.SendOnlyIfDrift === true;
      console.log(`>>> syncRoutingPlexCycle: group=${ProductionRoutingGroup}, routing=${ProductionRouting},`
        + ` material=${Material}${verifyOnly ? ' [verifica: invio solo se non combacia]' : ''}`);

      // ================================================================
      // DICHIARATI FUORI DAL `try` PERCHE' IL `catch` LI USA.
      // Erano `const` dentro il try, quindi il ramo d'errore li vedeva come non definiti: la
      // scrittura del log di errore lanciava `ReferenceError`, veniva inghiottita dal suo try
      // interno e stampava «error log save failed». Risultato: gli invii FALLITI non finivano nel
      // log, e il cockpit mostrava l'esito dell'ultimo invio RIUSCITO come se fosse l'attuale.
      // ================================================================
      let sMaterial = routingMaterialRules.keyPart(Material);
      let nextCounter = 1;
      // [W1-05] `bomQtyUom` sta FUORI da `errors` di proposito: e' una dichiarazione, non un
      // difetto accertato, e `errors` accende il semaforo del ciclo (vedi `logStatus`).
      const syncLog = { operations: [], bom: [], workcenters: [], errors: [], bomQtyUom: [] };
      // [ROUTING-REQ-TRACE] LE RICHIESTE EFFETTIVAMENTE INVIATE A PLEX (feature 0031).
      //
      // `RequestJson` conteneva le chiavi del ciclo e il numero di operazioni locali: il pannello
      // «Richiesta JSON Inviata a Plex» del dettaglio ciclo mostrava dunque qualcosa che NON e' la
      // richiesta — e su una risposta non documentata dal contratto il corpo inviato e' l'unico
      // indizio su quale campo sia nullo (0009, RB-06d). Materiali e ordini lo salvavano da sempre;
      // i cicli no, ed era l'asimmetria meno visibile delle tre.
      //
      // Un ciclo e' N chiamate — operazioni, distinta, centri di lavoro — quindi la forma e' quella
      // del flusso ordini: una voce per passo. Il tetto non serve: la colonna e' LargeString.
      const plexCalls = [];
      const trackCall = (step, method, url, body) => {
        plexCalls.push({
          step, method, url,
          // Il corpo si registra come OGGETTO e non come stringa: il visualizzatore del cockpit lo
          // apre come JSON, e una stringa dentro il JSON sarebbe illeggibile.
          body: body === undefined ? null : body
        });
      };
      // Feature 0018: esito della lettura di classificazione dell'auto-assegnazione. Resta 'OK'
      // quando l'auto-assegnazione non viene nemmeno chiesta (azione manuale, flag di plant spento).
      let classificationStatus = 'OK';
      // [PHANTOM-EXPLODE] Quanti fantasma NON si sono potuti esplodere. Resta 0 quando
      // l'esplosione non e' accesa per il plant o non ci sono fantasma.
      let phantomUnresolved = 0;
      // [W1-05] Quante righe di distinta sono partite con una quantita' non attendibile: nodo non
      // risolto (ripiego 1) oppure quantita' vera che si arrotonda a zero. Resta 0 quando la
      // distinta si legge e tutti i nodi agganciano.
      let bomQtyUnresolved = 0;
      // [ROUTING-COMP-SOURCE] La SECONDA lettura della distinta non e' riuscita per QUESTO ciclo:
      // data illeggibile, oppure lettura fallita. Il ciclo parte lo stesso, con i soli componenti
      // del ciclo, ma cio' che il cliente si aspetta di vedere su Plex non ci arriva — e senza
      // questa bandiera il recap direbbe «inviato» esattamente come per un ciclo completo.
      //
      // NON comprende il caso «il canale non onora la data»: quello e' una proprieta' del canale,
      // non del ciclo, e lo dichiara il job UNA volta per plant. Metterlo anche qui farebbe
      // degradare ogni singolo ciclo di quel plant, cioe' rumore al posto di un'informazione.
      let compSourceError = '';
      // [ROUTING-DEFAULT-OP] La sorgente EFFETTIVA di questo ciclo, per il recap del job. Come
      // `PhantomUnresolved` e le altre: non entra in `success` — il ciclo e' stato inviato — ma il
      // job ne fa una voce per plant, e il ripiego la degrada. Nascono al valore di «nessun
      // ricalcolo»: fuori dal ramo `AutoAssignMissing` l'elenco componenti non si tocca affatto.
      let compSourceMode = 'ALLOC';
      let compSourceFellBack = false;
      // [BOM-AUTODEPLETE] Esito del flag `autoDeplete` su ogni riga BOM trattata (uno dei
      // bomRules.FLAG_STATE). Dichiarato QUI, fuori dal try del passo BOM, perche' lo leggono il
      // messaggio, lo stato del log e il valore di ritorno: se il passo esplode a meta', cio' che
      // si sa fin li' deve arrivare comunque al recap.
      const autodepleteStates = [];
      // La leva d'esercizio, letta UNA volta per invio. Accesa per default; `PLEX_BOM_AUTODEPLETE=off`
      // riporta i body a quelli di prima di W1-06 senza un rilascio, e l'esito `DISABLED` lo scrive
      // nel log: non e' una lacuna scoperta, e' una scelta d'esercizio.
      const adEnabled = bomRules.isEnabled(process.env.PLEX_BOM_AUTODEPLETE);
      // Il campo e' osservabile nella risposta della GET su questo tenant? Verdetto preso sui dati,
      // una volta per part.
      let adObservability = { observable: false, field: null, rows: 0, withField: 0 };
      // [W1-05] Esito dell'UNITA' DI CONSUMO su ogni riga BOM trattata (uno dei bomRules.UOM_STATE).
      // Stessa collocazione e stessa ragione degli stati del flag: se il passo BOM esplode a meta',
      // quello che si sa fin li' deve arrivare comunque al log.
      const uomStates = [];
      // Leva di ripristino di `validate`, SEPARATA da quella di `autoDeplete`: sono due decisioni
      // diverse e vanno potute revocare una per volta. L'unita' non ha leva, ed e' la regola —
      // i valori fissi di POLICY hanno un interruttore di ripristino, i DATI SAP no (`quantity`
      // non ce l'ha, e `depletionUnitOfMeasure` e' dato quanto lei).
      const validateEnabled = bomRules.isEnabled(process.env.PLEX_BOM_VALIDATE);
      // [WC-SUBTRACT] Verdetto della sottrazione dei work center. Stessa collocazione e stessa
      // ragione delle tre qui sopra: li leggono il messaggio, `logStatus` e il valore di ritorno.
      // `null` finche' il passo non gira, perche' «non ancora guardato» e «guardato e niente da
      // fare» non sono la stessa cosa nel JSON del log.
      let wcDiff = null;
      let wcRemovedCount = 0;
      // Gli eccessi RILEVATI e non rimossi, per ragione. E' questo che degrada l'esito, non
      // `wcDiff.excess.length`: un eccesso rimosso non e' un difetto residuo.
      const wcNotRemovedBy = {};
      // Interruttore di rilascio, letto UNA volta per invio. `0` spegne la SCRITTURA e non il
      // rilevamento (DEC-71).
      const wcDeleteDsId = plexDataSources.DS_APPROVED_WC_DELETE;
      // [ROUTING-BOM-DRIFT] L'esito del confronto con Plex (feature 0047). Stessa collocazione e
      // stessa ragione di `wcDiff` qui sopra: lo leggono il messaggio, `logStatus` e il valore di
      // ritorno, quindi se la sequenza si interrompe a meta' cio' che si sa fin qui arriva comunque
      // al log. `null` finche' il confronto non gira — e non gira affatto senza `SendOnlyIfDrift`.
      let verifyDiff = null;
      let verifySegments = [];
      let verifyDegrades = false;

      try {
        const db = await cds.connect.to('db');
        const { ZPlexRoutingCycleOperation, ZPlexRoutingCycleComponent, ZPlexRoutingApprovedWorkcenter, ZMatPlexMapping, ZRoutingExcLogHDR, ZRoutingExcLogPOS } = db.entities('avvaleplm.marsplm.sap2plex');

        // [ROUTING-SCOPE] Plant attivo E ciclo dentro il perimetro. Il gate sta PRIMA del try di
        // logging: un rifiuto di perimetro non e' un invio fallito e non deve scrivere nulla in
        // ZRoutingExcLog* — sporcherebbe la cronologia di un ciclo con un evento che non c'e'
        // stato.
        const { blocked, hdr } = await rejectIfRoutingNotUsable(req, db, ProductionRoutingGroup, ProductionRouting);
        if (blocked) return;

        // ================================================================
        // [MAT-PLANT-PAIR] Il plant del ciclo, risolto QUI e usato ovunque serva.
        //
        // Dalla 0039 la part e' per (materiale, plant), quindi risolvere un `PlexId` senza dire su
        // quale plant e' una domanda incompleta: la risposta sarebbe una riga qualsiasi fra quelle
        // del materiale — su HANA colonnare l'ordine di un SELECT senza ORDER BY non e' definito,
        // in SQLite di sviluppo e' quasi sempre la prima, cioe' la riga storica.
        //
        // NON SI PERSISTE UNA COLONNA `Plant` SULLE TABELLE DEL CICLO, ed e' una scelta: un ciclo
        // SAP appartiene per costruzione a un solo plant (`PLKO-WERKS`), quindi il plant e' una
        // FUNZIONE della chiave, non un fatto della riga — e una copia di una funzione della chiave
        // e' una copia che puo' divergere senza violare niente. La stessa ragione di DEC-84 («non si
        // tiene una copia del tipo accanto all'id»): andrebbe portata a mano attraverso ogni punto
        // che scrive una riga di ciclo, e con `default ''` il punto dimenticato non fallirebbe.
        // Qui il valore c'e' gia': lo porta il gate di perimetro, che e' obbligatorio su ogni
        // percorso, e la testata e' in cache (`routingHeaderCache`).
        // ================================================================
        const cyclePlant = matPlantRules.keyPart(hdr && hdr.Plant);

        // 2. Il materiale, che e' lo scope di tutto: risolto in testa all'handler, perche' senza di
        // lui non si sa quale ciclo leggere ne' su quale part scrivere.
        if (!sMaterial) {
          req.error(400, 'No material assigned to this routing. Cannot sync to Plex.');
          return;
        }

        // Get next log counter — per (ciclo, MATERIALE): la cronologia di un materiale non e'
        // interrotta dagli invii di un altro.
        const lastLog = await db.run(
          SELECT.one.from(ZRoutingExcLogPOS)
            .columns('Counter')
            .where({ ProductionRoutingGroup, ProductionRouting, Material: sMaterial })
            .orderBy('Counter desc')
        );
        nextCounter = (lastLog?.Counter || 0) + 1;

        // 1. Load local Plex cycle operations for this routing AND material
        const cycleScope = {
          ProductionRoutingGroup, ProductionRouting, HeaderMaterial: sMaterial
        };
        const localOps = await db.run(
          SELECT.from(ZPlexRoutingCycleOperation)
            .where(cycleScope)
            .orderBy('OperationNumber asc')
        );

        if (!localOps || localOps.length === 0) {
          // ============================================================================
          // [ROUTING-ORPHAN] IL RIFIUTO LASCIA LA SUA RIGA NELLO STORICO DEL CICLO (DEC-96).
          //
          // `req.error()` non lancia: registra l'errore e questo `return` esce dal `try` SENZA
          // passare dal `catch`, che e' l'unico punto che scriveva il log. Conseguenza: il recap
          // del job dichiarava il fallimento e la scheda del ciclo no — e chi guardava la scheda
          // continuava a vedere l'esito dell'ultimo invio RIUSCITO come se fosse l'attuale. E' lo
          // stesso difetto gia' corretto per il ramo d'eccezione, dall'altro lato.
          //
          // VALE ANCHE PER IL PULSANTE DEL COCKPIT: `_executeSyncPlexCycle` rilegge lo storico
          // subito dopo, quindi la riga compare senza toccare la UI.
          //
          // DUE RIFIUTI VICINI CHE *NON* SCRIVONO, E NON E' UNA DIMENTICANZA:
          //   - il gate di perimetro / plant non attivo qui sopra: e' un gate di CUSTOMIZING, e
          //     DEC-96 dice che un gate non lascia riga — sporcherebbe la cronologia di un ciclo
          //     con un evento che non c'e' stato;
          //   - «No material assigned»: `Material` e' in CHIAVE nel log, e una riga a chiave
          //     vuota e' peggio di nessuna riga.
          // ============================================================================
          await writeRoutingSyncLog(db, {
            ZRoutingExcLogHDR, ZRoutingExcLogPOS,
            ProductionRoutingGroup, ProductionRouting, Material: sMaterial,
            Counter: nextCounter,
            Status: 'E',
            Segments: [logMsg.seg('logRoutingNoOperations')],
            // Nessuna chiamata verso Plex e' partita, ed e' proprio cio' che la riga dichiara.
            Calls: plexCalls,
            ResponseStatus: 400,
            Response: { error: 'no local Plex operations saved for this routing and material' }
          });
          req.error(400, 'No Plex operations to synchronize. Add and save operations first.');
          return;
        }
        console.log(`>>> syncRoutingPlexCycle: ${localOps.length} local operations to sync`);

        // ============================================================================
        // [ROUTING-COMP-SOURCE] 1b. I COMPONENTI DEL CICLO, RICALCOLATI — E IL GATE (feature 0025).
        //
        // STA QUI, E NON PIU' AL PASSO 6b, PER UNA RAGIONE SOLA: al passo 6b le operazioni erano
        // gia' state create o aggiornate su Plex, quindi un ciclo con un componente non
        // assegnabile lasciava dietro di se' meta' lavoro — operazioni nuove senza i loro
        // componenti, cioe' esattamente il ciclo incompleto che il blocco vuole evitare. Qui
        // tutto e' ancora lettura: verso Plex non e' partito niente e, se si esce, non partira'.
        //
        // GIRA SOLO PER IL JOB (`AutoAssignMissing`). L'azione manuale del cockpit invia quello
        // che l'utente ha costruito e salvato, e non deve trovarsi una schermata che rifiuta di
        // partire per una regola di customizing: la' i componenti li vede e li sistema a mano.
        //
        // TRE COSE CAMBIANO RISPETTO AL RAMO DI PRIMA.
        //   - l'elenco desiderato ha DUE sorgenti (`buildDesiredRoutingComponents`), non piu' la
        //     sola assegnazione componente-operazione del ciclo;
        //   - l'auto-assegnazione gira su TUTTI i componenti e non sui soli mancanti, quindi una
        //     riga automatica si SPOSTA quando la scheda dei gruppi cambia idea. Prima non si
        //     spostava mai, e cambiare il customizing non aveva effetto su nessun ciclo esistente;
        //   - un componente senza operazione FERMA il ciclo, invece di sparire in un contatore.
        // ============================================================================
        let compPlan = null;
        // [ROUTING-BOM-DRIFT] La riscrittura locale delle righe automatiche, MESSA IN ATTESA.
        //
        // In modalita' verifica non si scrive niente finche' non si sa se c'e' qualcosa da inviare:
        // una verifica che pota l'albero salvato e poi conclude «tutto allineato, non invio» avrebbe
        // cancellato una collocazione umana su un run che dichiara di non aver fatto nulla. La
        // riscrittura resta quindi in questa chiusura e la chiama il cancello, subito prima
        // dell'invio — e nell'invio normale la chiama dove stava, cioe' qui sotto.
        let applyCompPlan = null;
        // [ROUTING-BOM-DRIFT] `sourceComplete` serve anche al confronto: con l'elenco SAP incompleto
        // le righe in eccesso su Plex si gonfiano (vedi `diffBom`). `null` = il ricalcolo non ha
        // girato, quindi l'elenco desiderato E' l'albero salvato: completo per costruzione.
        let compSourceComplete = null;
        if (req.data.AutoAssignMissing === true) {
          const compTag = `sync ciclo ${ProductionRoutingGroup}/${ProductionRouting}/${sMaterial}`;
          try {
            // [ROUTING-DEFAULT-OP] La sorgente, dal punto unico e sul plant DI QUESTO ciclo: un run
            // tratta cicli di piu' plant e l'impostazione e' per plant, mai per run.
            const { ProductionRoutingHeader } = this.S4Routing.entities;
            const compCache = bomExplode.createExplodeCache();
            const compSrc = await resolveRoutingCompAllocs({
              group: ProductionRoutingGroup, routing: ProductionRouting, plant: hdr && hdr.Plant,
              headerMaterial: sMaterial, cache: compCache, tag: compTag
            });
            let allocs = compSrc.allocs;
            // Le assegnazioni componente-operazione del ciclo, ristrette alla distinta di QUESTO
            // materiale: `PLMZ` porta le posizioni delle distinte di tutti i materiali del ciclo.
            // Sull'altra sorgente le righe SONO gia' quelle della sua distinta.
            if (compSrc.mode === 'ALLOC') {
              const aaBoms = await resolveMaterialBomKeys(
                sMaterial, ProductionRoutingGroup, ProductionRouting, ProductionRoutingHeader,
                hdr && hdr.Plant);
              if (aaBoms.size > 0) {
                const before = allocs.length;
                allocs = allocs.filter(a => routingMaterialRules.belongsToMaterial(a, aaBoms));
                console.log(`>>> [ROUTING-BY-MATERIAL] autoassign: ${allocs.length} di ${before}`
                  + ` componenti appartengono alla distinta di ${sMaterial}`);
              } else {
                console.warn(`>>> [ROUTING-BY-MATERIAL] autoassign: distinta di ${sMaterial} non`
                  + ' risolta, si considerano i componenti di tutte le distinte del ciclo (come prima)');
              }
            }
            // La sorgente si DICHIARA sul log del ciclo, sempre: un ciclo costruito dalla distinta e
            // uno costruito da PLMZ hanno lo stesso aspetto a cose fatte.
            compSourceMode = compSrc.mode;
            compSourceFellBack = compSrc.fellBack === true;
            syncLog.compDefaultOp = {
              mode: compSrc.mode,
              anchor: compSrc.anchor ? String(compSrc.anchor.Operation || '') : null,
              fellBack: compSrc.fellBack === true,
              reason: compSrc.reason || null
            };
            if (compSrc.fellBack) {
              syncLog.errors.push({ step: 'COMP_SOURCE', error: compSrc.reason });
            }

            // Le due letture, ognuna preparata alla propria data. In modo `BOM` la prima E' gia' la
            // distinta di oggi: la seconda resta e continua ad AGGIUNGERE quello che entrera' a una
            // data futura, che nessuna delle due sorgenti di oggi puo' portare.
            const desired = await buildDesiredRoutingComponents(allocs, {
              plant: hdr && hdr.Plant, headerMaterial: sMaterial, cache: compCache, tag: compTag
            });

            // [PHANTOM-EXPLODE] [W1-05] Le stesse dichiarazioni di prima, ora sommate sulle DUE
            // letture: un fantasma non esploso sulla distinta futura e' esattamente grave quanto
            // uno non esploso su quella di oggi.
            if (desired.phantomUnresolved > 0) {
              phantomUnresolved += desired.phantomUnresolved;
              syncLog.errors.push({
                step: 'PHANTOM_EXPLODE',
                error: `${desired.phantomUnresolved} componenti fantasma non esplosi (distinta non `
                  + 'leggibile, anello o profondita\' massima)'
              });
            }
            if (desired.qtyBad > 0) {
              bomQtyUnresolved += desired.qtyBad;
              syncLog.errors.push({
                step: 'BOM_QTY',
                error: `${desired.qtyBad} componenti con quantita' di distinta non attendibile `
                  + `(ripiego ${DEFAULT_COMP_QTY}, oppure arrotondata a zero)`
              });
            }
            if (desired.altUnit.length) {
              syncLog.bomQtyUom = (syncLog.bomQtyUom || []).concat(desired.altUnit);
            }
            // La seconda lettura si DICHIARA sempre che sia andata o no: un perimetro rimasto
            // quello di ieri e un perimetro allargato correttamente si vedono uguali sul ciclo.
            syncLog.compSource = {
              keyDate: routingCompRules.keyDateLabel(desired.keyDate) || null,
              honored: desired.honored,
              error: desired.secondError || null,
              merge: desired.merge
            };
            if (desired.secondError) {
              compSourceError = desired.secondError;
              syncLog.errors.push({ step: 'BOM_SECOND_READ', error: desired.secondError });
            }

            // Le righe gia' salvate: e' da qui che si sa chi ha collocato cosa.
            const storedComps = await db.run(
              SELECT.from(ZPlexRoutingCycleComponent).where(cycleScope)
            );

            // L'auto-assegnazione gira su TUTTO l'elenco desiderato meno i materiali gia'
            // collocati a mano: chiedere una regola per un componente che una persona ha gia'
            // messo fermerebbe l'invio di un ciclo che e' completo.
            const manualMaterials = new Set(
              storedComps
                .filter((r) => routingCompRules.normalizeOrigin(r.AssignmentSource) === routingCompRules.ORIGIN.MANUAL)
                .map((r) => String(r.Material || '').trim())
            );
            const toResolve = desired.components.filter((c) => !manualMaterials.has(c.Material));
            const aa = await resolveAutoAssignments({
              plant: hdr && hdr.Plant, headerMaterial: sMaterial, components: toResolve
            });

            // ================================================================
            // [COMP-ORPHAN] La potatura si autorizza SOLO su una fotografia completa (0037).
            //
            // `desired` e' completo quando la seconda lettura non ha avuto errori E la sua data e'
            // stata ONORATA dal canale. I due casi che restano fuori sono diversi fra loro e
            // portano alla stessa conclusione: con `secondError` la distinta alla data di
            // riferimento non e' stata letta, con `honored: false` e' stata letta ma NON a quella
            // data — in entrambi `desired` e' piu' STRETTO del vero, e potare su un insieme
            // stretto cancella righe manuali che esistono.
            //
            // Se la data non e' configurata affatto (`keyDate: null`) la seconda lettura non ha
            // ragione di girare, `honored` resta `true` e la prima lettura E' la fotografia
            // completa: e' l'insieme su cui il progetto invia da sempre.
            // ================================================================
            // [ROUTING-DEFAULT-OP] E un RIPIEGO di sorgente e' il terzo caso, per la stessa ragione:
            // il plant ha chiesto la distinta e ha ricevuto `PLMZ`, cioe' un'altra fotografia. Piu'
            // stretta o piu' larga non si sa, e non importa — non e' quella su cui le righe manuali
            // erano state decise, quindi non autorizza a cancellarne nessuna.
            const sourceComplete = compSrc.fellBack !== true
              && !desired.secondError && desired.honored !== false;
            compSourceComplete = sourceComplete;   // [ROUTING-BOM-DRIFT] lo legge anche il confronto
            compPlan = routingCompRules.planCycleComponents({
              desired: desired.components,
              stored: storedComps,
              operations: localOps,
              assignments: aa.assignments,
              unassigned: aa.unassigned,
              sourceComplete
            });

            // ================================================================
            // [ROUTING-DEFAULT-OP] G1 — DISTINTA VUOTA E' UN BLOCCO, NON UN INSIEME VUOTO.
            //
            // `EMPTY_SOURCE` non copre questo caso: la sua guardia pretende che il ciclo abbia gia'
            // righe automatiche salvate (`autoReplacedIds.length > 0`), e su un ciclo al primo invio
            // quell'elenco e' vuoto. Il ciclo passerebbe il gate, le operazioni si creerebbero su
            // Plex, il passo distinta non avrebbe niente da mandare e il recap lo conterebbe fra i
            // RIUSCITI. Qui si scrive verso la fabbrica: cio' che non si e' potuto verificare non
            // passa (DEC-52).
            //
            // Si aggiunge al piano invece di sostituirlo, cosi' gli altri bloccati restano nominati.
            // ================================================================
            if (compSrc.noBom === true) {
              compPlan.blocked.push({
                Material: sMaterial,
                Reason: routingCompRules.BLOCK_REASON.NO_BOM
              });
              compPlan.counts.blocked = compPlan.blocked.length;
              console.error(`>>> [ROUTING-DEFAULT-OP] ${compTag}: ${routingCompRules.REASON_TEXT[routingCompRules.BLOCK_REASON.NO_BOM]}`);
            }
            if (!sourceComplete) {
              console.log(`>>> [COMP-ORPHAN] ${compTag}: potatura NON valutata (lettura SAP`
                + ` incompleta): le righe manuali restano tutte`);
            }

            // Feature 0018: la classificazione non letta resta una degradazione a se'. Se ha
            // impedito a un componente di agganciare, quel componente e' gia' fra i bloccati col
            // motivo NO_CLFN e il ciclo non parte; se invece tutti hanno agganciato per altra via,
            // il ciclo parte e questa resta l'unica traccia del fatto che la lettura e' fallita.
            if (aa.ClassificationStatus === 'KO') {
              classificationStatus = 'KO';
              syncLog.errors.push({
                step: 'AUTO_ASSIGN_CLFN',
                error: aa.ClassificationDetail || 'classificazione non leggibile'
              });
            }
            syncLog.autoAssign = {
              desired: compPlan.counts.desired,
              fromBom: compPlan.counts.fromBom,
              auto: compPlan.counts.auto,
              manual: compPlan.counts.manual,
              moved: compPlan.counts.moved,
              blocked: compPlan.counts.blocked,
              classification: aa.ClassificationStatus || 'OK'
            };
            console.log(`>>> [ROUTING-COMP-SOURCE] ${compTag}: ${JSON.stringify(syncLog.autoAssign)}`);
            if (compPlan.moved.length) {
              // Uno spostamento e' l'effetto voluto della feature, ma resta una modifica a un
              // ciclo che qualcuno ha guardato: si NOMINA, non si conta soltanto.
              syncLog.movedComponents = compPlan.moved;
              console.log(`>>> [ROUTING-COMP-SOURCE] ${compTag}: ${compPlan.moved.length} componenti`
                + ' spostati dalle regole: '
                + compPlan.moved.slice(0, 10).map((m) => `${m.Material} ${m.From}->${m.To}`).join(', '));
            }
          } catch (planErr) {
            // ============================================================
            // IL RICALCOLO NON RIUSCITO E' UN BLOCCO, NON UNA DEGRADAZIONE.
            //
            // E' il contrario di quello che faceva il ramo di prima («autoassign failed
            // (non-blocking)»): li' l'auto-assegnazione era un'aggiunta, e senza di lei partiva
            // comunque cio' che c'era. Qui l'elenco desiderato E' cio' che si invia, quindi
            // proseguire significherebbe mandare a Plex i componenti di ieri credendo di aver
            // mandato quelli di oggi — su una lettura che non si e' potuta fare.
            // ============================================================
            console.error(`>>> [ROUTING-COMP-SOURCE] ${compTag}: ricalcolo NON eseguito:`
              + ` ${planErr.message}`);
            syncLog.errors.push({ step: 'COMP_SOURCE', error: planErr.message });
            compPlan = {
              rows: [], manualKept: [], autoReplacedIds: [], moved: [],
              blocked: [{ Material: '*', Reason: 'COMP_SOURCE_FAILED' }],
              counts: { desired: 0, auto: 0, manual: 0, blocked: 1, moved: 0, fromBom: 0 },
              failure: planErr.message
            };
          }

          // ---- IL GATE. Da qui in poi si scrive su Plex, quindi si esce adesso o mai piu'. ----
          if (compPlan.blocked.length > 0) {
            // [LOG-MSG-I18N] Segmenti, non una frase. Il ricalcolo non eseguito porta con se' il
            // testo dell'eccezione, che e' tecnico e di terzi: va in un segmento `technical`, cosi'
            // arriva a schermo dentro una cornice tradotta senza pretendere di essere una frase
            // nostra.
            const messageSegments = compPlan.failure
              ? [logMsg.seg('logRoutingCompRecalcFailed'), logMsg.technical(compPlan.failure)]
              : routingCompRules.describeBlockedSegments(compPlan.blocked);
            // Due rese dello stesso messaggio, per due destinatari: il `console` e il recap del job
            // parlano italiano, chi ha premuto il tasto legge la sua lingua (vedi `responseLocale`).
            const message = i18nMessages.render(messageSegments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
            const replyMessage = i18nMessages.render(messageSegments, i18nMessages.COCKPIT_APP, responseLocale(req));
            console.error(`>>> [ROUTING-COMP-SOURCE] ${compTag}: ${message}`);
            await writeRoutingSyncLog(db, {
              ZRoutingExcLogHDR, ZRoutingExcLogPOS,
              ProductionRoutingGroup, ProductionRouting, Material: sMaterial,
              Counter: nextCounter,
              Status: 'E',
              Segments: messageSegments,
              Calls: plexCalls,    // vuoto: il gate sta PRIMA di qualunque scrittura su Plex
              ResponseStatus: 0,   // nessuna chiamata a Plex: non c'e' uno stato HTTP da riportare
              Response: {
                blocked: compPlan.blocked,
                counts: compPlan.counts,
                compSource: syncLog.compSource || null,
                details: syncLog
              }
            });
            return {
              success: false,
              Blocked: true,
              BlockedCount: compPlan.blocked.length,
              deactivatedCount: 0,
              createdCount: 0,
              message: replyMessage,
              messageJson: logMsg.pack(messageSegments),   // [LOG-MSG-I18N]
              ClassificationStatus: classificationStatus,
              PhantomUnresolved: phantomUnresolved,
              BomQtyUnresolved: bomQtyUnresolved,
              // [ROUTING-DEFAULT-OP] Da dove sono venuti i componenti, e se e' stato un ripiego.
              CompSourceMode: compSourceMode,
              CompSourceFellBack: compSourceFellBack,
              AutodepleteUnverified: 0,
              OpTypeDefaulted: 0,
              WcExcessNotRemoved: 0,
              WcRemoved: 0,
              SecondReadFailed: !!compSourceError
            };
          }

          // ---- Nessun blocco: si riscrivono le sole righe AUTOMATICHE di questo ciclo. ----
          // La cancellazione e' PER IDENTIFICATIVO e non per criterio sulla provenienza: un
          // `WHERE AssignmentSource <> 'MANUAL'` sarebbe una SECONDA decisione su cosa e'
          // automatico, presa in SQL accanto a quella che `planCycleComponents` ha appena preso,
          // e le due non coincidono — il confronto SQL e' esatto, quello delle regole no. Gli
          // identificativi restano comunque circoscritti a (ciclo, MATERIALE), perche' vengono
          // dalla SELECT qui sopra: con una portata piu' larga si cancellerebbero i cicli degli
          // altri materiali (0015, RB-16).
          // [COMP-ORPHAN] Nella stessa cancellazione entrano le righe MANUALI il cui componente SAP
          // non ha piu' (0037): stesso criterio — per identificativo — e per la stessa ragione. Un
          // `WHERE AssignmentSource = 'MANUAL' AND Material NOT IN (...)` sarebbe la seconda
          // decisione che il commento qui sopra vieta, moltiplicata per due.
          applyCompPlan = async () => {
            const compIdsToDelete = compPlan.autoReplacedIds.concat(compPlan.manualDroppedIds || []);
            if (compIdsToDelete.length > 0) {
              await db.run(
                DELETE.from(ZPlexRoutingCycleComponent).where({ ID: { in: compIdsToDelete } })
              );
            }
            if (compPlan.rows.length > 0) {
              await db.run(INSERT.into(ZPlexRoutingCycleComponent).entries(
                compPlan.rows.map((r) => ({
                  ID: cds.utils.uuid(),
                  ProductionRoutingGroup,
                  ProductionRouting,
                  HeaderMaterial: sMaterial,
                  PlexOperationId: r.PlexOperationId,
                  Material: r.Material,
                  BOMItemNodeNumber: r.BOMItemNodeNumber,
                  RequiredQuantity: r.RequiredQuantity,
                  BaseUnit: r.BaseUnit,
                  Sequence: r.Sequence,
                  PhantomSource: r.PhantomSource,
                  AssignmentSource: routingCompRules.ORIGIN.AUTO
                }))
              ));
            }
            console.log(`>>> [ROUTING-COMP-SOURCE] ${compTag}: riscritte ${compPlan.rows.length}`
              + ` righe automatiche, ${compPlan.manualKept.length} manuali lasciate intatte`
              + ` [COMP-ORPHAN] ${compPlan.manualDropped.length} manuali potate`);
            // [COMP-ORPHAN] La potatura entra nel JSON della risposta: chi apre il pannello di
            // dettaglio vede QUALI materiali sono stati rimossi, non solo quanti. Nel messaggio va
            // invece come SEGMENTO (vedi `pruneSegments` piu' sotto), perche' quello si rende nella
            // lingua di chi guarda (DEC-92) e questa e' prosa italiana.
            if (compPlan.manualDropped.length) {
              syncLog.compPruned = {
                total: compPlan.manualDropped.length,
                materials: compPlan.manualDropped.map((r) => r.Material),
                text: compSource.describePruned(compPlan.manualDropped)
              };
            }
          };
          // [ROUTING-BOM-DRIFT] Nell'invio normale la riscrittura avviene ESATTAMENTE dove
          // avveniva. In verifica la chiama il cancello, e solo se si invia davvero.
          if (!verifyOnly) await applyCompPlan();
        }

        // [MAT-PLANT-PAIR] La part di TESTATA, sul tenant di QUESTO plant.
        const mapping = await db.run(
          SELECT.one.from(ZMatPlexMapping).where({ Product: sMaterial, Plant: cyclePlant })
        );

        if (!mapping || !mapping.PlexId) {
          // Il messaggio NOMINA il plant, e non e' una rifinitura: senza, chi legge «invia prima il
          // materiale a Plex» va in dashboard, lo trova gia' inviato — su un altro plant — e non
          // capisce cosa gli si stia chiedendo.
          req.error(400, `Material ${sMaterial} is not a Plex part on plant ${cyclePlant || '(assente)'}.`
            + ' Send the product to Plex for that plant first.');
          return;
        }

        let sPlexId = mapping.PlexId;
        console.log(`>>> syncRoutingPlexCycle: PlexId=${sPlexId} for material ${sMaterial}/${cyclePlant}`);

        // 3. [PLEX-CONN] Connessione del plant del ciclo: `hdr` arriva dal gate di perimetro
        // qui sopra e porta gia' il plant.
        const { baseUrl: plexUrl, consumerKey } = await loadPlexConnection(req, cyclePlant);
        const headers = {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Plex-Connect-Api-Key': consumerKey
        };

        // ================================================================
        // [ROUTING-BOM-DRIFT] LA DISTINTA SU PLEX, LETTA UNA VOLTA PER INVIO (feature 0047).
        //
        // La stessa lettura serve a due cose: al CANCELLO della verifica, che decide se partire, e
        // all'invio idempotente del passo 7b-bis, che decide riga per riga fra creare, aggiornare e
        // saltare. Due `fetch` darebbero due fotografie, e il cancello deciderebbe su una diversa
        // da quella su cui l'invio poi lavora — cioe' la classe di difetto di DEC-99 (due cache,
        // due verita'). Da qui la memoizzazione: la prima chiamata legge, le successive rendono.
        //
        // `ok` E' UN'INFORMAZIONE, NON UN DETTAGLIO. L'invio tratta una lettura fallita come «lista
        // vuota, creo tutto», ed e' corretto per lui: creare una riga che esiste costa un `400`
        // «already exist». Per il VERDETTO e' l'opposto — con la lettura caduta ogni componente
        // appare assente e si reinvierebbe tutto — quindi il flag esce di qui e la guardia sta in
        // `diffBom`. Stessa lettura, due usi, un solo posto in cui si distinguono.
        // ================================================================
        const bomListUrl = `${plexUrl}/engineering/v1/boms?partId=${encodeURIComponent(sPlexId)}`;
        let bomReadCache = null;
        const readPlexBomList = async () => {
          if (bomReadCache) return bomReadCache;
          const out = { ok: false, status: 0, error: null, rows: [], map: new Map(), url: bomListUrl };
          try {
            const resp = await fetch(bomListUrl, { method: 'GET', headers });
            out.status = resp.status;
            if (resp.ok) {
              out.ok = true;
              out.rows = bomRules.extractBomList(await resp.json());
              for (const b of out.rows) {
                const r = bomRules.readBomRow(b);
                if (r.partOperationId && r.componentPartId) {
                  out.map.set(bomRules.bomKey(r.partOperationId, r.componentPartId), r);
                }
              }
            }
          } catch (err) {
            out.error = err.message;
          }
          bomReadCache = out;
          return out;
        };

        // 3b. Verify PartId exists on Plex via MDM parts API (same API used for create/update)
        // [PART-QUERY] Lettura per id su v2: e' la sola versione che il portale pubblica, e i
        // campi che leggiamo ci sono in entrambe. Il ripiego qui sotto resta sull'indirizzo
        // `inventory/v1`, dove `partNumber` E' il parametro giusto.
        const verifyMdmUrl = `${plexUrl}${plexPartsApi.partByIdPath(sPlexId)}`;
        console.log(`>>> syncRoutingPlexCycle: verifying PartId via GET ${verifyMdmUrl}`);
        try {
          const verifyResp = await fetch(verifyMdmUrl, { method: 'GET', headers });
          if (verifyResp.ok) {
            console.log(`>>> syncRoutingPlexCycle: PartId ${sPlexId} verified via MDM API`);
          } else {
            console.warn(`>>> syncRoutingPlexCycle: MDM GET returned ${verifyResp.status} for PartId ${sPlexId}, trying list parts lookup`);
            // Try to find correct id via list parts
            const listUrl = `${plexUrl}/inventory/v1/inventory-definitions/parts?partNumber=${encodeURIComponent(sMaterial)}`;
            const listResp = await fetch(listUrl, { method: 'GET', headers });
            if (listResp.ok) {
              const listData = await listResp.json();
              const parts = Array.isArray(listData) ? listData : (listData.data || listData.results || []);
              console.log(`>>> syncRoutingPlexCycle: list parts returned ${parts.length} results, raw: ${JSON.stringify(listData).substring(0, 500)}`);
              const matchedPart = parts.find(p =>
                (p.number || p.partNumber || '').toUpperCase() === sMaterial.toUpperCase()
              );
              const foundPlexId = matchedPart ? (matchedPart.partId || matchedPart.id) : null;
              if (foundPlexId && foundPlexId !== sPlexId) {
                console.log(`>>> syncRoutingPlexCycle: PlexId mismatch! DB has ${sPlexId}, Plex has ${foundPlexId}. Updating mapping.`);
                sPlexId = foundPlexId;
                // [MAT-PLANT-PAIR] LA RIPARAZIONE E' DI QUESTA COPPIA, e senza il plant nel `where`
                // sarebbe una corruzione attiva: l'id appena letto dal tenant di QUESTO plant
                // finirebbe anche sulle righe degli altri, che su quel tenant non esiste. Il loro
                // prossimo invio farebbe PUT -> 404 -> ramo di fallback -> una part DUPLICATA sul
                // loro tenant, con un log che dice «part cancellata da Plex e ricreata» su una part
                // che nessuno ha cancellato. Nessun errore, da nessuna parte.
                await db.run(UPDATE(ZMatPlexMapping)
                  .set({ PlexId: sPlexId, UpdatedAt: new Date().toISOString() })
                  .where({ Product: sMaterial, Plant: cyclePlant }));
              }
            }
          }
        } catch (verifyErr) {
          console.warn(`>>> syncRoutingPlexCycle: PartId verification failed: ${verifyErr.message}, proceeding with stored PlexId`);
        }

        // 3c. Per-plant part-operation field mapping (customizing). Precompute the mapped fields
        // once per operation (keyed by PlexOperationId); the build points below merge them over
        // the existing defaults. No mapping for the plant -> mappedByOpId stays empty -> unchanged.
        const opFieldMap = await loadOpFieldMapRows(hdr && hdr.Plant, db);
        const opFieldMapRows = opFieldMap.rows;
        // [CONF-POSTING] `operationNumber` MAPPATO ROMPE LA CONSUNTIVAZIONE, e va detto.
        //
        // Quel numero non e' un valore di comodo: e' il PONTE con cui le registrazioni che tornano da
        // Plex ritrovano l'operazione SAP (DEC-88, e ora osservato in entrambe le letture del
        // contratto PLEX_PRODUCTION_HISTORY_API_CONTRACT.md). Il ponte regge perche' siamo NOI a
        // mandarlo, prendendolo da `ZPlexCycleOperation.OperationNumber` — e una riga di mapping lo
        // SOVRASCRIVE (`m.operationNumber ?? finalNumber`, nei due rami PUT e POST qui sotto).
        //
        // Se un plant lo mappa, Plex restituisce QUEL numero mentre la nostra tabella conserva il
        // proprio: il ponte non aggancia piu' e ogni registrazione finisce in quarantena — cioe' il
        // guasto che la 0027 ha chiuso, raggiungibile da una tendina. Con `FIXED` e' peggio in modo
        // diverso: tutte le operazioni prendono lo stesso numero, e il ponte lo rifiuta come AMBIGUO.
        //
        // Non si rifiuta la riga: renderla inerte cambierebbe cosa un plant gia' configurato manda a
        // Plex al prossimo allineamento. Si DICHIARA, perche' il guasto a valle e' visibile ma la sua
        // causa sta qui, in un'altra schermata. Perimetro: grep -rn "CONF-POSTING".
        const opNumberMapped = opFieldMapRows.filter((r) => r.PlexField === 'operationNumber').length;
        if (opNumberMapped) {
          console.warn(`>>> [CONF-POSTING] plant ${hdr && hdr.Plant}: ${opNumberMapped} riga(he) di`
            + ' mapping su `operationNumber`. E\' il ponte con cui le registrazioni Plex ritrovano'
            + ' l\'operazione SAP: se il numero mandato non e\' quello di ZPlexCycleOperation, il job'
            + ' PROD_CONF mette ogni registrazione in quarantena.');
        }
        const mappedByOpId = {};
        if (opFieldMapRows.length > 0) {
          const materialFields = await fetchProductOpFields(sMaterial);
          const routingOpFields = await fetchRoutingOpFields(this.S4Routing, ProductionRoutingGroup, ProductionRouting);
          for (const op of localOps) {
            const rop = routingOpFields[op.ProductionRoutingOpIntID] || {};
            const opCtx = { ...materialFields, ...rop, OperationCode: op.OperationCode };
            mappedByOpId[op.PlexOperationId] = buildPartOperationPayload({ opContext: opCtx, mapRows: opFieldMapRows });
          }
          console.log(`>>> syncRoutingPlexCycle: op-field mapping active for plant ${hdr.Plant} (${opFieldMapRows.length} field(s) mapped)`);
        } else {
          // [PLEX-OP-TYPE] «Nessuna riga» non e' piu' muto: era il caso in cui il ReferenceError
          // finiva, e un customizing corretto sembrava assente.
          console.warn(`>>> [OP-MAPPING] nessun mapping campi operazione per il plant `
            + `${(hdr && hdr.Plant) || '(assente)'} (lettura ${opFieldMap.readOk ? 'riuscita' : 'FALLITA'})`);
        }

        // 3d. [PLEX-OP-TYPE] Il catalogo operazioni del tenant, UNA volta per sincronizzazione: e'
        // da qui che viene il `type` di ogni part-operation (feature 0024, DEC-84), che prima era
        // una riga FIXED del mapping — un valore unico per tutte le operazioni del ciclo, deciso da
        // noi, con `400 FIELD_REFERENCE_NOT_FOUND` come premio se il nome non era quello del tenant.
        // Una chiamata in piu' su una sequenza che ne fa decine, e nessuna copia da mantenere
        // allineata: la mappa e' per `id`, che e' identita' e c'e' sempre.
        const opCatalogRead = await opCatalog.loadOperationCatalog({ baseUrl: plexUrl, consumerKey }, hdr && hdr.Plant);

        // 4. GET current part-operations from Plex
        const getUrl = `${plexUrl}/mdm/v1/part-operations?partId=${encodeURIComponent(sPlexId)}`;
        console.log(`>>> syncRoutingPlexCycle: GET ${getUrl}`);

        const getResponse = await fetch(getUrl, { method: 'GET', headers });
        let existingOps = [];
        // [ROUTING-BOM-DRIFT] Per l'invio una GET caduta e' «nessuna operazione, le creo tutte»;
        // per il VERDETTO e' «non lo so», e sono due conclusioni opposte sulla stessa riga. Il flag
        // si prende qui, dove la risposta c'e' ancora.
        const opsReadOk = getResponse.ok === true;

        if (getResponse.ok) {
          const data = await getResponse.json();
          existingOps = Array.isArray(data) ? data : (data.value || data.results || []);
          console.log(`>>> syncRoutingPlexCycle: ${existingOps.length} existing part-operations on Plex`);
          if (existingOps.length > 0) {
            console.log(`>>> syncRoutingPlexCycle: first op raw keys: ${JSON.stringify(Object.keys(existingOps[0]))}, sample: ${JSON.stringify(existingOps[0]).substring(0, 300)}`);
          }
        } else {
          console.log(`>>> syncRoutingPlexCycle: GET returned ${getResponse.status}, treating as empty`);
        }

        // 5. Build map of existing remote operations by operationId
        const remoteByOpId = {};
        for (const op of existingOps) {
          const opId = op.operationId || op.OperationId;
          if (opId) {
            remoteByOpId[opId] = op;
          }
        }
        console.log(`>>> syncRoutingPlexCycle: ${Object.keys(remoteByOpId).length} remote ops mapped by operationId`);

        // 6. Separate local ops into existing (PUT) and new (POST)
        let updatedCount = 0;
        let createdCount = 0;
        // [PLEX-OP-TYPE] Quante operazioni sono partite col ripiego del `type` invece che col
        // valore del tenant. Non tocca `success` — come PhantomUnresolved e BomQtyUnresolved —
        // ma DICHIARA la lacuna: senza, «nessun customizing» e «customizing giusto» sarebbero
        // indistinguibili guardando l'esito, e su un tenant non inglese il primo e' un 400 secco.
        let opTypeDefaulted = 0;
        const lastIndex = localOps.length - 1;

        const opsToUpdate = []; // { localOp, remoteId, remoteType, index }
        const opsToCreate = []; // { localOp, index }

        for (let i = 0; i < localOps.length; i++) {
          const op = localOps[i];
          const remoteOp = remoteByOpId[op.PlexOperationId];
          if (remoteOp) {
            // [PLEX-OP-TYPE] `remoteType` viaggia insieme all'id: la GET lo consegna gia'
            // (PartOperationDTO.type) e finora si scartava, cosi' i due PUT riscrivevano col
            // ripiego un tipo deciso su Plex.
            opsToUpdate.push({
              localOp: op,
              remoteId: remoteOp.partOperationId || remoteOp.id || remoteOp.Id,
              remoteType: remoteOp.type || remoteOp.Type || null,
              index: i
            });
          } else {
            opsToCreate.push({ localOp: op, index: i });
          }
        }

        // ============================================================================
        // [ROUTING-BOM-DRIFT] IL CANCELLO DEL CONFRONTO (feature 0047).
        //
        // STA QUI, E LA POSIZIONE E' LA REGOLA: e' l'ultimo punto in cui verso Plex non e' ancora
        // partita NESSUNA scrittura e si sa gia' tutto quello che serve — le operazioni remote
        // (passo 4), l'elenco desiderato dei componenti (passo 1b) e, con la lettura qui sotto, la
        // distinta su Plex. Un passo piu' avanti e il PASS 1 avrebbe gia' portato le operazioni ai
        // numeri transitori `90010+` su una part che la fabbrica sta usando; un passo piu' indietro
        // e non ci sarebbe niente con cui confrontare.
        //
        // COSA FA REINVIARE, e cosa no, sta tutto in `routingBomDriftRules`: qui si raccolgono i
        // fatti e si obbedisce al verdetto. Le tre cose che questo blocco NON deve fare, e che sono
        // le tre in cui e' facile cascare:
        //   1. non conclude niente da una lettura fallita (`opsReadOk`, `bomRead.ok`): con la GET
        //      caduta ogni operazione appare da creare e ogni componente assente, cioe' il reinvio
        //      completo di tutti i cicli di tutti i plant deciso su un'informazione che non c'era;
        //   2. non chiede a Plex la part di ogni componente per riparare il dizionario, come fa il
        //      passo 7c: sarebbe una chiamata PER COMPONENTE su ogni ciclo di ogni notte. Il
        //      componente che il dizionario non risolve non e' quindi un disallineamento — e'
        //      dichiarato, e il rimedio e' `MAT_SYNC` su quel materiale;
        //   3. non scrive: nemmeno le righe locali (`applyCompPlan` e' in attesa), nemmeno una riga
        //      di storico. Un run che dichiara «niente da fare» non deve aver toccato niente.
        // ============================================================================
        if (verifyOnly) {
          const bomRead = await readPlexBomList();
          // La lettura del confronto entra nella traccia SEMPRE, non solo quando trova qualcosa:
          // «ho guardato e combaciava» e «non ho potuto guardare» devono essere distinguibili nella
          // riga di storico dell'invio che segue (0009, RB-06d/RB-06e).
          trackCall('bom-verify', 'GET', bomRead.url, null);

          // Il dizionario operazione -> part-operation viene dalla GET del passo 4: nessuna
          // chiamata in piu' per costruirlo.
          const partOpIdByOperationId = {};
          for (const [opId, rop] of Object.entries(remoteByOpId)) {
            const partOpId = rop.partOperationId || rop.id || rop.Id;
            if (partOpId) partOpIdByOperationId[opId] = partOpId;
          }

          // L'albero salvato, e l'elenco desiderato. Senza ricalcolo (`AutoAssignMissing` spento)
          // l'elenco desiderato E' l'albero: il confronto resta quello verso Plex, che e' l'unico
          // che ha ancora un termine di paragone.
          const storedComps = await db.run(
            SELECT.from(ZPlexRoutingCycleComponent).where(cycleScope)
          );
          const desiredRows = compPlan
            ? compPlan.rows.concat(compPlan.manualKept)
            : storedComps;

          // Il dizionario materiale -> part del componente, sul tenant di QUESTO plant
          // ([MAT-PLANT-PAIR]): una lettura locale sola, per i materiali di questo ciclo.
          const compMaterials = [...new Set(
            desiredRows.map((r) => matPlantRules.keyPart(r.Material)).filter(Boolean)
          )];
          const compMapRows = compMaterials.length
            ? await db.run(SELECT.from(ZMatPlexMapping).columns('Product', 'PlexId')
              .where({ Product: { in: compMaterials }, Plant: cyclePlant }))
            : [];
          const componentIdByMaterial = {};
          for (const r of compMapRows) {
            if (r.PlexId) componentIdByMaterial[matPlantRules.keyPart(r.Product)] = r.PlexId;
          }

          const localDiff = compPlan
            ? bomDrift.diffLocal({ desired: desiredRows, stored: storedComps })
            : { changed: false, added: [], removed: [], moved: [], qtyDiff: [], counts: {} };
          const expected = bomDrift.expectedBomRows({
            rows: desiredRows, partOpIdByOperationId, componentIdByMaterial
          });
          const bomDiff = bomDrift.diffBom({
            expected: expected.entries,
            remote: bomRead.map,
            remoteKnown: bomRead.ok,
            // Vedi `diffBom`: le righe in eccesso si ricavano per sottrazione, quindi si cercano
            // solo su un elenco desiderato completo. Senza ricalcolo l'elenco E' l'albero salvato,
            // che e' completo per costruzione.
            declareExtra: compPlan ? compSourceComplete === true : true
          });
          const verdict = bomDrift.decideVerify({
            opsReadOk, opsMissing: opsToCreate.length, local: localDiff, bom: bomDiff
          });
          verifySegments = bomDrift.driftSegments({
            local: localDiff, bom: bomDiff, unresolved: expected.unresolved
          });
          verifyDegrades = bomDrift.degradesVerify({ bom: bomDiff, unresolved: expected.unresolved });
          verifyDiff = { verdict, local: localDiff, bom: bomDiff, unresolved: expected.unresolved };
          // La PROVA di cosa e' stato confrontato, nel JSON della risposta: chi apre il pannello del
          // ciclo deve poter rispondere a «perche' questo ciclo e' (o non e') partito stanotte?».
          syncLog.verify = {
            reason: verdict.reason,
            sent: verdict.send,
            opsReadOk,
            opsMissing: opsToCreate.length,
            bomReadOk: bomRead.ok,
            bomReadStatus: bomRead.status,
            bomReadError: bomRead.error,
            expected: expected.entries.length,
            unresolved: expected.unresolved,
            local: localDiff.counts,
            bom: bomDiff.counts,
            extraRows: bomDiff.extra,
            extraKnown: bomDiff.extraKnown
          };
          console.log(`>>> [ROUTING-BOM-DRIFT] ${ProductionRoutingGroup}/${ProductionRouting}/`
            + `${sMaterial}: ${verdict.reason} -> ${verdict.send ? 'REINVIO' : 'nessun invio'}`
            + ` | ${JSON.stringify(syncLog.verify.bom)} locale=${JSON.stringify(localDiff.counts)}`);

          if (!verdict.send) {
            // NESSUNA RIGA DI STORICO, ed e' voluto (DEC-96): lo storico di un ciclo e' l'elenco
            // degli INVII, e qui non ce n'e' stato uno. Una riga per notte e per ciclo che dice
            // «niente da fare» renderebbe illeggibile la cronologia che quella regola esiste per
            // tenere leggibile. Il confronto si dichiara nel recap del job, che e' il posto di cio'
            // che non appartiene a un oggetto.
            const noOpSegments = [logMsg.seg('logRoutingBomChecked'), ...verifySegments];
            return {
              success: true,
              NoOp: true,
              VerifyReason: verdict.reason,
              BomMissing: bomDiff.counts.missing,
              BomQtyDiff: bomDiff.counts.qtyDiff,
              BomExtra: bomDiff.counts.extra,
              BomRemoteKnown: bomDiff.remoteKnown,
              Blocked: false,
              BlockedCount: 0,
              deactivatedCount: 0,
              createdCount: 0,
              message: i18nMessages.render(noOpSegments, i18nMessages.COCKPIT_APP, responseLocale(req)),
              messageJson: logMsg.pack(noOpSegments),
              ClassificationStatus: classificationStatus,
              PhantomUnresolved: phantomUnresolved,
              BomQtyUnresolved: bomQtyUnresolved,
              // [ROUTING-DEFAULT-OP] Da dove sono venuti i componenti, e se e' stato un ripiego.
              CompSourceMode: compSourceMode,
              CompSourceFellBack: compSourceFellBack,
              AutodepleteUnverified: 0,
              OpTypeDefaulted: 0,
              WcExcessNotRemoved: 0,
              WcRemoved: 0,
              // Il confronto e' stato fatto su un elenco SAP incompleto: il job non lo conta fra
              // gli allineati, perche' «combacia» detto su meta' dei componenti non e' un verdetto.
              SecondReadFailed: !!compSourceError
            };
          }
          // Si invia. La riscrittura locale messa in attesa avviene ADESSO, prima del passo 7a che
          // rilegge le righe dal database: senza questa chiamata partirebbero i componenti di ieri.
          if (applyCompPlan) await applyCompPlan();
        }

        // 6a. PASS 1 — PUT existing ops with temporary high operationNumbers to free up all slots
        if (opsToUpdate.length > 0) {
          console.log(`>>> syncRoutingPlexCycle: PASS 1 — setting ${opsToUpdate.length} ops to temporary operationNumbers`);
          for (let j = 0; j < opsToUpdate.length; j++) {
            const { localOp, remoteId, remoteType } = opsToUpdate[j];
            const tempNumber = 90000 + (j + 1) * 10; // 90010, 90020, 90030...
            const m = mappedByOpId[localOp.PlexOperationId] || {};
            // Il conteggio del ripiego si fa in PASS 2 e nel POST: PASS 1 scorre le stesse
            // operazioni di PASS 2 con numeri transitori, contarlo qui le conterebbe due volte.
            const opType = resolveOpType({
              remote: remoteType,
              operation: opCatalog.typeOf(opCatalogRead, localOp.PlexOperationId)
            });
            const putBody = {
              operationId: localOp.PlexOperationId,
              type: opType.value,
              operationNumber: tempNumber, // transient slot: mapping does NOT override here
              subOperation: m.subOperation ?? (localOp.SubOperation || false),
              shippable: false,           // transient PASS-1 state; final value set in PASS-2
              netWeight: m.netWeight ?? (localOp.NetWeight || 0),
              standardQuantity: m.standardQuantity ?? (localOp.StandardQuantity || 0)
            };
            const putUrl = `${plexUrl}/mdm/v1/part-operations/${encodeURIComponent(remoteId)}`;
            try {
              trackCall('op-put', 'PUT', putUrl, putBody);
              const putResp = await fetch(putUrl, { method: 'PUT', headers, body: JSON.stringify(putBody) });
              if (!putResp.ok) {
                const errText = await putResp.text();
                console.warn(`>>> syncRoutingPlexCycle: PASS1 PUT ${localOp.OperationCode} temp=${tempNumber} returned ${putResp.status}: ${errText}`);
                syncLog.errors.push({ step: 'PASS1_PUT', code: localOp.OperationCode, status: putResp.status, error: errText });
              }
            } catch (err) {
              console.error(`>>> syncRoutingPlexCycle: PASS1 PUT error:`, err.message);
              syncLog.errors.push({ step: 'PASS1_PUT', code: localOp.OperationCode, error: err.message });
            }
          }

          // 6b. PASS 2 — PUT existing ops with final operationNumbers from local tree
          console.log(`>>> syncRoutingPlexCycle: PASS 2 — setting final operationNumbers`);
          for (const { localOp, remoteId, remoteType, index } of opsToUpdate) {
            const isLast = (index === lastIndex);
            const finalNumber = localOp.OperationNumber || ((index + 1) * 10);
            const m = mappedByOpId[localOp.PlexOperationId] || {};
            const opType = resolveOpType({
              remote: remoteType,
              operation: opCatalog.typeOf(opCatalogRead, localOp.PlexOperationId)
            });
            if (opType.source === 'default') opTypeDefaulted++;
            const putBody = {
              operationId: localOp.PlexOperationId,
              type: opType.value,
              operationNumber: m.operationNumber ?? finalNumber,
              subOperation: m.subOperation ?? (localOp.SubOperation || false),
              shippable: m.shippable ?? (isLast ? true : (localOp.Shippable || false)),
              netWeight: m.netWeight ?? (localOp.NetWeight || 0),
              standardQuantity: m.standardQuantity ?? (localOp.StandardQuantity || 0)
            };
            const putUrl = `${plexUrl}/mdm/v1/part-operations/${encodeURIComponent(remoteId)}`;
            console.log(`>>> syncRoutingPlexCycle: PUT ${localOp.OperationCode} (remoteId=${remoteId}, opNum=${finalNumber})`);
            try {
              trackCall('op-put', 'PUT', putUrl, putBody);
              const putResp = await fetch(putUrl, { method: 'PUT', headers, body: JSON.stringify(putBody) });
              if (putResp.ok) {
                updatedCount++;
                syncLog.operations.push({ code: localOp.OperationCode, method: 'PUT', opNum: finalNumber, status: putResp.status, result: 'OK' });
              } else {
                const errText = await putResp.text();
                console.warn(`>>> syncRoutingPlexCycle: PASS2 PUT returned ${putResp.status}: ${errText}`);
                syncLog.operations.push({ code: localOp.OperationCode, method: 'PUT', opNum: finalNumber, status: putResp.status, error: errText });
                syncLog.errors.push({ step: 'PASS2_PUT', code: localOp.OperationCode, status: putResp.status, error: errText });
              }
            } catch (err) {
              console.error(`>>> syncRoutingPlexCycle: PASS2 PUT error:`, err.message);
              syncLog.operations.push({ code: localOp.OperationCode, method: 'PUT', error: err.message });
              syncLog.errors.push({ step: 'PASS2_PUT', code: localOp.OperationCode, error: err.message });
            }
          }
        }

        // 6c. POST new operations
        for (const { localOp, index } of opsToCreate) {
          const isLast = (index === lastIndex);
          const m = mappedByOpId[localOp.PlexOperationId] || {};
          // [PLEX-OP-TYPE] In creazione non c'e' nessun valore remoto da conservare: o lo dice il
          // catalogo Plex, o parte il ripiego — che su un tenant non inglese Plex rifiuta con
          // 400 FIELD_REFERENCE_NOT_FOUND. Per questo il ripiego si conta e si dichiara.
          const opType = resolveOpType({
            operation: opCatalog.typeOf(opCatalogRead, localOp.PlexOperationId)
          });
          if (opType.source === 'default') opTypeDefaulted++;
          const createBody = {
            partId: sPlexId,                                   // identity, never from customizing
            operationId: localOp.PlexOperationId,              // identity, never from customizing
            type: opType.value,
            operationNumber: m.operationNumber ?? (localOp.OperationNumber || ((index + 1) * 10)),
            subOperation: m.subOperation ?? (localOp.SubOperation || false),
            shippable: m.shippable ?? (isLast ? true : (localOp.Shippable || false)),
            netWeight: m.netWeight ?? (localOp.NetWeight || 0),
            standardQuantity: m.standardQuantity ?? (localOp.StandardQuantity || 0)
          };
          const createUrl = `${plexUrl}/mdm/v1/part-operations`;
          console.log(`>>> syncRoutingPlexCycle: POST ${localOp.OperationCode} (opId=${localOp.PlexOperationId})`);
          try {
            trackCall('op-post', 'POST', createUrl, createBody);
            const createResp = await fetch(createUrl, { method: 'POST', headers, body: JSON.stringify(createBody) });
            if (createResp.ok || createResp.status === 201) {
              createdCount++;
              syncLog.operations.push({ code: localOp.OperationCode, method: 'POST', opNum: createBody.operationNumber, status: createResp.status, result: 'CREATED' });
            } else {
              const errText = await createResp.text();
              console.warn(`>>> syncRoutingPlexCycle: POST returned ${createResp.status}: ${errText}`);
              syncLog.operations.push({ code: localOp.OperationCode, method: 'POST', opNum: createBody.operationNumber, status: createResp.status, error: errText });
              syncLog.errors.push({ step: 'POST_OP', code: localOp.OperationCode, status: createResp.status, error: errText });
            }
          } catch (err) {
            console.error(`>>> syncRoutingPlexCycle: POST error:`, err.message);
            syncLog.operations.push({ code: localOp.OperationCode, method: 'POST', error: err.message });
            syncLog.errors.push({ step: 'POST_OP', code: localOp.OperationCode, error: err.message });
          }
        }

        console.log(`>>> syncRoutingPlexCycle: updated ${updatedCount}, created ${createdCount} / ${localOps.length} total`);

        // [ROUTING-COMP-SOURCE] IL PASSO 6b NON ESISTE PIU'.
        // L'auto-assegnazione dei componenti girava QUI, cioe' dopo che le operazioni erano gia'
        // state create o aggiornate su Plex, e assegnava i soli materiali non ancora presenti nel
        // ciclo. Dalla feature 0025 e' al passo 1b, prima di qualunque scrittura: e' l'unico punto
        // in cui un ciclo con un componente non assegnabile puo' fermarsi senza lasciare dietro di
        // se' meta' lavoro. Vedi il blocco [ROUTING-COMP-SOURCE] in testa a questo handler.

        // 7. Sync BOM components to Plex
        let bomCreatedCount = 0;
        let bomUpdatedCount = 0;
        let partOpIdMap = {};
        try {
          // 7a. Load local components for this routing AND material
          const localComps = await db.run(
            SELECT.from(ZPlexRoutingCycleComponent)
              .where(cycleScope) // [ROUTING-BY-MATERIAL]
              .orderBy('PlexOperationId asc', 'Sequence asc')
          );
          console.log(`>>> syncRoutingPlexCycle: ${localComps.length} local BOM components to sync`);

          if (localComps.length > 0) {
            // 7b. Re-fetch part-operations from Plex to get fresh IDs (after creates/updates)
            const refreshResp = await fetch(
              `${plexUrl}/mdm/v1/part-operations?partId=${encodeURIComponent(sPlexId)}`,
              { method: 'GET', headers }
            );
            let freshOps = [];
            if (refreshResp.ok) {
              const refreshData = await refreshResp.json();
              freshOps = Array.isArray(refreshData) ? refreshData : (refreshData.value || refreshData.results || []);
            }

            // Build map: operationId (PlexOperationId) → partOperationId (Plex remote ID)
            partOpIdMap = {};
            for (const fop of freshOps) {
              const opId = fop.operationId || fop.OperationId;
              const partOpId = fop.partOperationId || fop.id || fop.Id;
              if (opId && partOpId) {
                partOpIdMap[opId] = partOpId;
              }
            }
            if (freshOps.length > 0) {
              console.log(`>>> syncRoutingPlexCycle: BOM refresh first op raw: ${JSON.stringify(freshOps[0]).substring(0, 300)}`);
            }
            console.log(`>>> syncRoutingPlexCycle: ${Object.keys(partOpIdMap).length} part-operation IDs mapped`);

            // 7b-bis. Idempotent send: read the BOM components already present on Plex for this part.
            // Map key = `${partOperationId}|${componentPartId}` → riga letta da bomRules.readBomRow:
            // serve sia per saltare i componenti già presenti con stessa qtà, sia per aggiornare
            // (PATCH per `id`) quelli con qtà cambiata, sia per OSSERVARE `autoDeplete`.
            // NB: nella risposta GET /engineering/v1/boms il componente è `componentPartId` (NON
            // `componentId`), mentre nel POST il campo si chiama `componentId`: stesso valore, nome
            // diverso (DEC-28). La part-operation è `partOperationId` su entrambi i lati.
            // [ROUTING-BOM-DRIFT] La lettura passa da `readPlexBomList`, memoizzata: in modalita'
            // verifica l'ha gia' fatta il cancello e questa e' la STESSA fotografia. Due `fetch`
            // darebbero due verita' fra il verdetto e le decisioni riga per riga qui sotto.
            const bomRead = await readPlexBomList();
            // La mappa E' quella della lettura condivisa: `readBomRow` e `bomKey` sono applicati la'
            // dentro, una volta sola, con gli stessi valori grezzi di prima.
            const existingBoms = bomRead.map;
            if (bomRead.ok) {
              const bomList = bomRead.rows;
              // [BOM-AUTODEPLETE] Il campo `autoDeplete` è nel contratto della GET
              // (BomComponentDto), ma non c'è alcuna garanzia che il tenant lo popoli: il verdetto
              // di osservabilità si prende sui dati, una volta per part, e finisce nel log. Con
              // zero righe NON è una lacuna: non c'era niente da osservare.
              adObservability = bomRules.bomListObservability(bomList);
              if (bomList.length > 0) {
                console.log(`>>> syncRoutingPlexCycle: BOM list first entry raw keys: ${JSON.stringify(Object.keys(bomList[0]))}, sample: ${JSON.stringify(bomList[0]).substring(0, 400)}`);
                console.log(`>>> [BOM-AUTODEPLETE] osservabilità del flag sulla GET: ${JSON.stringify(adObservability)}`);
              }
              console.log(`>>> syncRoutingPlexCycle: ${existingBoms.size} BOM components already present on Plex (out of ${bomList.length} raw entries)`);
            } else {
              // Per l'INVIO una lettura caduta vale «lista vuota, creo tutto», e resta cosi': una
              // creazione di troppo costa un `400 already exist`. Il VERDETTO del cancello la
              // interpreta all'opposto, e la distinzione sta in `bomRead.ok` — vedi
              // [ROUTING-BOM-DRIFT] in testa a `readPlexBomList`.
              console.log(`>>> syncRoutingPlexCycle: BOM list GET returned ${bomRead.status}`
                + `${bomRead.error ? ` (${bomRead.error})` : ''}, treating as empty (will POST all)`);
            }
            // [BOM-AUTODEPLETE] Il verbo di aggiornamento è `PATCH`: la BOM API non ha un `PUT` (vedi
            // srv/external/PLEX_BOM_API_CONTRACT.md). Si logga la prima risposta finché il verbo non
            // è collaudato su un tenant reale — prima di W1-06 il ramo mandava un `PUT` con i campi
            // d'identità, che UpdateBomComponentDto non prevede.
            let bomPatchDiscovered = false;

            // 7c. For each local component, resolve componentId and POST to Plex BOM
            for (const comp of localComps) {
              const partOperationId = partOpIdMap[comp.PlexOperationId];
              if (!partOperationId) {
                console.warn(`>>> syncRoutingPlexCycle: no partOperationId for PlexOperationId=${comp.PlexOperationId}, skipping component ${comp.Material}`);
                continue;
              }

              // ================================================================
              // [MAT-PLANT-PAIR] Il componente e' una part DEL TENANT DI QUESTO CICLO.
              //
              // Il plant giusto e' `cyclePlant` e non un ipotetico plant «di casa» del componente:
              // quel componente sta nella distinta di QUESTO ciclo, che vive su QUESTO tenant.
              //
              // E LA LETTURA SU PLEX NON E' PIU' GATATA DAL DIZIONARIO. Prima si chiedeva a Plex
              // solo quando il dizionario aveva gia' risposto — cioe' mai nel caso che conta — e un
              // componente non ancora inviato spariva dalla distinta con un `console.warn`. Con la
              // chiave per coppia quel caso passa da raro a normale (un componente inviato solo dal
              // plant A non ha riga per B), quindi si guarda comunque: se la part c'e' sul tenant,
              // il dizionario si RIEMPIE. E' la stessa riparazione che questo blocco fa da sempre
              // quando gli id divergono, estesa al caso in cui l'id non c'e' affatto.
              // ================================================================
              const compMapping = await db.run(
                SELECT.one.from(ZMatPlexMapping).where({ Product: comp.Material, Plant: cyclePlant })
              );
              let componentId = compMapping?.PlexId;

              try {
                const compVerifyUrl = `${plexUrl}/inventory/v1/inventory-definitions/parts?partNumber=${encodeURIComponent(comp.Material)}`;
                const compVerifyResp = await fetch(compVerifyUrl, { method: 'GET', headers });
                if (compVerifyResp.ok) {
                  const compVerifyData = await compVerifyResp.json();
                  const compParts = Array.isArray(compVerifyData) ? compVerifyData : (compVerifyData.data || compVerifyData.results || []);
                  const compMatch = compParts.find(p => (p.number || p.partNumber || '').toUpperCase() === comp.Material.toUpperCase());
                  const correctId = compMatch ? (compMatch.partId || compMatch.id) : null;
                  if (correctId && correctId !== componentId) {
                    const now = new Date().toISOString();
                    if (componentId) {
                      console.log(`>>> syncRoutingPlexCycle: component ${comp.Material}/${cyclePlant} PlexId mismatch: DB=${componentId}, Plex=${correctId}. Updating.`);
                      await db.run(UPDATE(ZMatPlexMapping)
                        .set({ PlexId: correctId, UpdatedAt: now })
                        .where({ Product: comp.Material, Plant: cyclePlant }));
                    } else {
                      console.log(`>>> [MAT-PLANT-PAIR] component ${comp.Material}/${cyclePlant}: part trovata su Plex (${correctId}), dizionario riempito`);
                      await db.run(INSERT.into(ZMatPlexMapping).entries({
                        Product: comp.Material, Plant: cyclePlant, PlexId: correctId,
                        CreatedAt: now, UpdatedAt: now
                      }));
                    }
                    componentId = correctId;
                  }
                }
              } catch (compVerifyErr) {
                console.warn(`>>> syncRoutingPlexCycle: component ${comp.Material} verify failed: ${compVerifyErr.message}`);
              }

              if (!componentId) {
                // [MAT-PLANT-PAIR] Il salto SI DICHIARA. Prima era un solo `console.warn`: il ciclo
                // usciva 'S' con la distinta incompleta su Plex, e «componente saltato» era
                // indistinguibile da «componente mandato». Non e' un `errors.push` — non e' una
                // chiamata fallita, e' un componente che su questo tenant non e' una part — ma deve
                // stare nella traccia che il cockpit apre.
                console.warn(`>>> syncRoutingPlexCycle: component ${comp.Material} non e' una part sul plant ${cyclePlant}, saltato`);
                syncLog.bom.push({
                  material: comp.Material, opId: comp.PlexOperationId,
                  result: 'SKIPPED_NOT_A_PART', plant: cyclePlant
                });
                continue;
              }

              // Idempotent send con gestione quantità E flag `autoDeplete` ([BOM-AUTODEPLETE], W1-06):
              //  - assente su Plex        -> POST (crea) col flag a false
              //  - presente, stessa qtà   -> skip, e il flag OSSERVATO si dichiara
              //  - presente, qtà diversa  -> PATCH (aggiorna la riga per id) col flag a false
              // Nessuna chiamata parte per il SOLO flag: le righe già su Plex non si riscrivono. Ma
              // una riga trovata con `autoDeplete: true` è un doppio consumo possibile (i 261 della
              // 0021), quindi diventa `LEGACY_TRUE` e degrada l'esito invece di sparire.
              const bomKey = `${partOperationId}|${componentId}`;
              const desiredQty = parseFloat(comp.RequiredQuantity) || 0;
              // [W1-05] L'unità di consumo, che il foglio 3.BOM vuole valorizzata con `STPO-MEINS`.
              // Arriva da `ZPlexRoutingCycleComponent.BaseUnit`, cioè dalla STESSA riga di distinta
              // da cui viene la quantità: è letteralmente ciò che il field mapping descrive
              // («Based on the logic to get STPO-MENGE, extract the values of STPO-MEINS»). Vuota
              // solo dove il nodo non si è risolto, e in quel caso il campo non parte affatto.
              const desiredUom = (comp.BaseUnit || '').trim();
              const existingBom = existingBoms.get(bomKey);
              const adDecision = bomRules.decideBomAction({
                existing: existingBom || null,
                desiredQuantity: desiredQty,
                enabled: adEnabled
              });
              autodepleteStates.push(adDecision.flagState);
              // [W1-05] L'unità non decide nulla: OSSERVA la decisione già presa. Con l'azione
              // `SKIP` l'unità non parte, e se su Plex manca o è diversa la riga è arretrato —
              // conseguenza accettata del perimetro, ma da contare.
              uomStates.push(bomRules.uomState({
                existing: existingBom || null,
                desiredUom,
                action: adDecision.action
              }));

              if (existingBom) {
                const currentQty = parseFloat(existingBom.quantity) || 0;
                // Si guarda l'AZIONE, non la ragione: una ragione di skip aggiunta in futuro alle
                // regole non deve poter cadere nel ramo di scrittura con un bomId che non c'è.
                if (adDecision.action === 'SKIP') {
                  if (adDecision.reason === 'NO_ID') {
                    // Quantità cambiata, ma la GET non ha restituito l'id della riga: senza id non
                    // c'è niente da aggiornare.
                    console.warn(`>>> syncRoutingPlexCycle: BOM ${comp.Material} qty changed but no bomId available, skipping update`);
                    syncLog.bom.push({ material: comp.Material, opId: comp.PlexOperationId, result: 'SKIPPED_NO_ID', flag: adDecision.flagState });
                  } else {
                    console.log(`>>> syncRoutingPlexCycle: BOM ${comp.Material} already on op ${comp.PlexOperationId} (qty=${currentQty}, autoDeplete=${adDecision.flagState}), skipping`);
                    syncLog.bom.push({ material: comp.Material, opId: comp.PlexOperationId, result: 'SKIPPED_SAME_QTY', flag: adDecision.flagState });
                  }
                  continue;
                }
                const patchUrl = `${plexUrl}/engineering/v1/boms/${encodeURIComponent(existingBom.bomId)}`;
                // Solo i campi da cambiare, e NESSUN campo d'identità: UpdateBomComponentDto non li
                // prevede, e mandarli era uno dei due motivi per cui questo ramo non funzionava.
                // [W1-05] L'unità viaggia con la quantità a costo zero: questo PATCH parte comunque.
                const patchBody = bomRules.buildPatchBody({
                  quantity: desiredQty,
                  depletionUnitOfMeasure: desiredUom,
                  sendValidate: validateEnabled,
                  sendFlag: adDecision.sendFlag
                });
                console.log(`>>> syncRoutingPlexCycle: PATCH BOM ${comp.Material} → op ${comp.PlexOperationId} (qty ${currentQty}→${desiredQty}, uom=${desiredUom || 'non inviata'}, autoDeplete=${adDecision.sendFlag ? 'false' : 'non inviato'})`);
                try {
                  trackCall('bom-patch', 'PATCH', patchUrl, patchBody);
                  const patchResp = await fetch(patchUrl, { method: 'PATCH', headers, body: JSON.stringify(patchBody) });
                  const patchText = await patchResp.text();
                  if (!bomPatchDiscovered) { // prima risposta del verbo corretto: da leggere in collaudo
                    console.log(`>>> syncRoutingPlexCycle: PATCH BOM first response ${patchResp.status}: ${patchText.substring(0, 400)}`);
                    bomPatchDiscovered = true;
                  }
                  if (patchResp.ok) {
                    bomUpdatedCount++;
                    existingBoms.set(bomKey, {
                      ...existingBom,
                      quantity: desiredQty,
                      // [W1-05] Anche l'unità entra nello stato intra-run: senza, un secondo
                      // passaggio sulla stessa coppia la conterebbe come arretrato appena scritto.
                      depletionUnitOfMeasure: desiredUom || existingBom.depletionUnitOfMeasure,
                      autoDeplete: adDecision.sendFlag ? false : existingBom.autoDeplete
                    });
                    syncLog.bom.push({ material: comp.Material, opId: comp.PlexOperationId, from: currentQty, to: desiredQty, uom: desiredUom || null, status: patchResp.status, result: 'UPDATED', flag: adDecision.flagState });
                  } else {
                    console.warn(`>>> syncRoutingPlexCycle: BOM PATCH returned ${patchResp.status}: ${patchText}`);
                    syncLog.bom.push({ material: comp.Material, opId: comp.PlexOperationId, status: patchResp.status, error: patchText, result: 'UPDATE_FAILED', flag: adDecision.flagState });
                    syncLog.errors.push({ step: 'BOM_PATCH', material: comp.Material, status: patchResp.status, error: patchText });
                  }
                } catch (patchErr) {
                  console.error(`>>> syncRoutingPlexCycle: BOM PATCH error:`, patchErr.message);
                  syncLog.bom.push({ material: comp.Material, opId: comp.PlexOperationId, error: patchErr.message, result: 'UPDATE_FAILED', flag: adDecision.flagState });
                  syncLog.errors.push({ step: 'BOM_PATCH', material: comp.Material, error: patchErr.message });
                }
                continue;
              }

              // Assente su Plex → crea. `autoDeplete: false` è la costante della BBP §4.2.4 e viaggia
              // su ogni riga nuova: senza, vale il default del tenant, che nessuno ha verificato.
              // [W1-05] Con lei l'unità di consumo (`STPO-MEINS`) e `validate`: i quattro campi che
              // il foglio 3.BOM dichiara in scope, nell'ordine in cui il foglio li elenca.
              const bomBody = bomRules.buildCreateBody({
                partOperationId,
                componentId,
                quantity: desiredQty,
                depletionUnitOfMeasure: desiredUom,
                sendValidate: validateEnabled,
                sendFlag: adDecision.sendFlag
              });

              const bomUrl = `${plexUrl}/engineering/v1/boms`;
              console.log(`>>> syncRoutingPlexCycle: POST BOM ${comp.Material} → op ${comp.PlexOperationId} (qty=${bomBody.quantity}, uom=${desiredUom || 'non inviata'}, autoDeplete=${adDecision.sendFlag ? 'false' : 'non inviato'})`);

              try {
                trackCall('bom-post', 'POST', bomUrl, bomBody);
                const bomResp = await fetch(bomUrl, { method: 'POST', headers, body: JSON.stringify(bomBody) });
                if (bomResp.ok || bomResp.status === 201) {
                  bomCreatedCount++;
                  // dedup intra-run: marca la coppia come presente con la qtà appena inviata
                  existingBoms.set(bomKey, { bomId: null, quantity: desiredQty, depletionUnitOfMeasure: desiredUom, autoDeplete: adDecision.sendFlag ? false : null, flagField: null });
                  syncLog.bom.push({ material: comp.Material, opId: comp.PlexOperationId, qty: bomBody.quantity, uom: desiredUom || null, status: bomResp.status, result: 'OK', flag: adDecision.flagState });
                } else {
                  const errText = await bomResp.text();
                  console.warn(`>>> syncRoutingPlexCycle: BOM POST returned ${bomResp.status}: ${errText}`);
                  syncLog.bom.push({ material: comp.Material, opId: comp.PlexOperationId, status: bomResp.status, error: errText });
                  syncLog.errors.push({ step: 'BOM_POST', material: comp.Material, status: bomResp.status, error: errText });
                }
              } catch (bomErr) {
                console.error(`>>> syncRoutingPlexCycle: BOM POST error:`, bomErr.message);
                syncLog.bom.push({ material: comp.Material, opId: comp.PlexOperationId, error: bomErr.message });
                syncLog.errors.push({ step: 'BOM_POST', material: comp.Material, error: bomErr.message });
              }
            }
          }
        } catch (bomError) {
          console.warn(`>>> syncRoutingPlexCycle: BOM sync failed (non-blocking): ${bomError.message}`);
        }

        // ============================================================================
        // 8. [WC-SUBTRACT] Work center approvati: si RIMUOVE cio' che il ciclo non vuole piu', poi
        //    si crea cio' che manca.
        //
        // Prima questo passo era POST-only: si ri-POSTava tutto l'insieme locale e il
        // `400 "already exist"` di Plex faceva da deduplicazione. Ma Plex risponde `already exist`
        // solo sulla TRIPLA IDENTICA, quindi un work center tolto dall'albero restava approvato per
        // sempre, e uno SPOSTATO da un'operazione a un'altra finiva approvato su entrambe — cioe'
        // la doppia approvazione che la BBP §7.6.2 vieta. L'invio chiudeva `S` e la divergenza si
        // scopriva solo aprendo Plex.
        //
        // LA RIMOZIONE NON PASSA DALLA CONNECT API, perche' non e' esprimibile: la' esistono solo
        // GET e POST, e la riga non ha nemmeno un id proprio. Passa dalla Data Source 755, che
        // pretende tre CHIAVI INTERE, ricavate dai codici di business che la GET restituisce.
        // ============================================================================
        let wcCreatedCount = 0;
        try {
          // Si legge il MATERIALE, non il ciclo, e le due viste si ricavano qui:
          //   `desired` — questo ciclo — guida le CREAZIONI (identico a prima);
          //   `materialWCs` guida le RIMOZIONI.
          // Su una part-operation che due cicli del materiale condividono, la configurazione su Plex
          // e' l'UNIONE dei loro work center: sottrarre col solo desiderato di questo ciclo
          // cancellerebbe quelli dell'altro, che e' il falso positivo che DEC-66 rifiuta. Una sola
          // SELECT e non due, cosi' un difetto della rilevazione non fa fallire anche le creazioni.
          const materialWCs = await db.run(
            SELECT.from(ZPlexRoutingApprovedWorkcenter).where({ HeaderMaterial: sMaterial })
          );
          // Confronto STRETTO su gruppo e contatore: sono colonne nostre, scritte dalle stesse
          // chiavi della richiesta (DEC-51).
          const localWCs = materialWCs.filter((w) =>
            w.ProductionRoutingGroup === ProductionRoutingGroup && w.ProductionRouting === ProductionRouting);
          console.log(`>>> syncRoutingPlexCycle: ${localWCs.length} approved workcenters del ciclo `
            + `(${materialWCs.length} sul materiale)`);

          // La mappa serve SEMPRE, non solo quando ci sono work center locali: senza di essa non si
          // sa quali righe remote appartengano a questo ciclo, e con l'insieme locale VUOTO — tolto
          // l'ultimo work center — l'eccesso e' proprio tutto cio' che sta su Plex nel perimetro.
          if (Object.keys(partOpIdMap).length === 0) {
            const refreshResp = await fetch(
              `${plexUrl}/mdm/v1/part-operations?partId=${encodeURIComponent(sPlexId)}`,
              { method: 'GET', headers }
            );
            if (refreshResp.ok) {
              const refreshData = await refreshResp.json();
              const freshOps = Array.isArray(refreshData) ? refreshData : (refreshData.value || refreshData.results || []);
              for (const fop of freshOps) {
                const opId = fop.operationId || fop.OperationId;
                const partOpId = fop.partOperationId || fop.id || fop.Id;
                if (opId && partOpId) partOpIdMap[opId] = partOpId;
              }
            }
            console.log(`>>> syncRoutingPlexCycle: workcenter step - refreshed ${Object.keys(partOpIdMap).length} part-operation IDs`);
          }

          const awcUrl = `${plexUrl}/production/v1/production-definitions/approved-workcenters`;

          // --- 8a. Lo stato su Plex, che prima non si leggeva mai. ---
          // Il `try` e' SUO e non quello del passo: l'esito di questa lettura decide se si puo'
          // DICHIARARE l'allineamento, e va distinto da qualunque altro guasto. Non e' una difesa
          // contro cancellazioni sbagliate — una lettura incompleta fa rimuovere MENO, non di piu' —
          // ma contro un `excess: 0` che sembrerebbe «tutto a posto» senza che nessuno abbia
          // guardato: vedi il docblock di `diffApprovedWorkcenters`.
          let remoteAwc = [];
          let awcRemoteKnown = false; // il valore prudente e' «non lo so»
          try {
            const awcListResp = await fetch(
              `${awcUrl}?partId=${encodeURIComponent(sPlexId)}`, { method: 'GET', headers });
            if (awcListResp.ok) {
              remoteAwc = approvedWcRules.extractApprovedWcList(await awcListResp.json());
              // Vero ANCHE con zero righe: un `200` vuoto e' un fatto, non una lettura fallita.
              awcRemoteKnown = true;
            } else {
              const errText = await awcListResp.text();
              console.warn(`>>> [WC-SUBTRACT] GET approved-workcenters ${awcListResp.status}: nessuna `
                + `rimozione in questo invio, le creazioni proseguono — ${errText.substring(0, 200)}`);
              syncLog.workcenters.push({ step: 'WC_LIST', result: 'REMOTE_UNKNOWN', status: awcListResp.status });
            }
          } catch (listErr) {
            // Una chiamata che NON PARTE e' un guasto, non una verifica non fatta: come la GET della
            // distinta, questa va anche fra gli errori.
            console.warn(`>>> [WC-SUBTRACT] GET approved-workcenters non riuscita: ${listErr.message}`);
            syncLog.workcenters.push({ step: 'WC_LIST', result: 'REMOTE_UNKNOWN', error: listErr.message });
            syncLog.errors.push({ step: 'WC_LIST', error: listErr.message });
          }

          // --- 8b. Il confronto. Con `remoteKnown: false` l'eccesso e' [] per costruzione. ---
          wcDiff = approvedWcRules.diffApprovedWorkcenters({
            desired: localWCs,
            keep: materialWCs,
            remote: remoteAwc,
            remoteKnown: awcRemoteKnown,
            partOpIdByOpId: partOpIdMap,
            cycleOpIds: localOps.map((o) => o.PlexOperationId)
          });
          console.log(`>>> [WC-SUBTRACT] ${JSON.stringify(wcDiff.counts)}`);

          // Le operazioni senza part-operation su Plex: prima erano un `console.warn` e nient'altro,
          // quindi `logStatus` restava 'S' e nessuno si accorgeva che quei work center non erano
          // partiti. Ora sono nel log e degradano l'esito.
          for (const u of wcDiff.unmapped) {
            console.warn(`>>> [WC-SUBTRACT] nessun partOperationId per PlexOperationId=${u.PlexOperationId}: `
              + `work center ${u.WorkcenterCode} non inviato`);
            syncLog.workcenters.push({ code: u.WorkcenterCode, opId: u.PlexOperationId, result: 'NO_PART_OP' });
          }

          // --- 8c. Le RIMOZIONI, prima delle creazioni. ---
          // Uno spostamento e' una rimozione piu' una creazione: rimuovere dopo aver creato lascia
          // la doppia approvazione visibile su Plex nella finestra fra le due chiamate, e se un
          // giorno Plex applicasse il vincolo §7.6.2 lato server il POST verrebbe rifiutato con la
          // riga vecchia ancora la'. E' anche la forma che il field mapping prescrive per la gemella
          // BOM: «first deactivate the existing component and then add a new one».
          if (wcDiff.excess.length > 0) {
            await removeExcessWorkcenters(req, hdr && hdr.Plant, wcDiff.excess, wcDeleteDsId, syncLog,
              (reason) => { wcNotRemovedBy[reason] = (wcNotRemovedBy[reason] || 0) + 1; },
              () => { wcRemovedCount++; });
          }

          // --- 8d. Le creazioni: solo cio' che MANCA. ---
          for (const wc of wcDiff.present) {
            // Nessuna chiamata: l'abbiamo VISTA nella GET. Nome diverso da `SKIPPED_EXISTS`, che e'
            // «me l'ha detto Plex rifiutando»: sono due fatti e nel JSON si distinguono.
            syncLog.workcenters.push({ code: wc.WorkcenterCode, opId: wc.PlexOperationId, result: 'SKIPPED_PRESENT' });
          }

          for (const wc of wcDiff.missing) {
            const awcBody = {
              partId: sPlexId,
              partOperationId: wc.partOperationId,
              workcenterId: wc.WorkcenterId
            };
            console.log(`>>> syncRoutingPlexCycle: POST approved-workcenter ${wc.WorkcenterCode} → op ${wc.PlexOperationId}`);

            try {
              trackCall('wc-post', 'POST', awcUrl, awcBody);
              const awcResp = await fetch(awcUrl, { method: 'POST', headers, body: JSON.stringify(awcBody) });
              if (awcResp.ok || awcResp.status === 201) {
                wcCreatedCount++;
                syncLog.workcenters.push({ code: wc.WorkcenterCode, opId: wc.PlexOperationId, status: awcResp.status, result: 'OK' });
              } else {
                const errText = await awcResp.text();
                // Il ramo RESTA anche ora che i POST sono guidati dal delta: e' la rete di sicurezza
                // per il percorso a GET fallita (dove si ri-POSTa tutto) e per una GET stantia.
                if (awcResp.status === 400 && /already\s+exist/i.test(errText)) {
                  console.log(`>>> syncRoutingPlexCycle: approved-workcenter ${wc.WorkcenterCode} already on op ${wc.PlexOperationId}, skipping`);
                  syncLog.workcenters.push({ code: wc.WorkcenterCode, opId: wc.PlexOperationId, result: 'SKIPPED_EXISTS' });
                } else {
                  console.warn(`>>> syncRoutingPlexCycle: approved-workcenter POST returned ${awcResp.status}: ${errText}`);
                  syncLog.workcenters.push({ code: wc.WorkcenterCode, opId: wc.PlexOperationId, status: awcResp.status, error: errText });
                  syncLog.errors.push({ step: 'WC_POST', code: wc.WorkcenterCode, status: awcResp.status, error: errText });
                }
              }
            } catch (awcErr) {
              console.error(`>>> syncRoutingPlexCycle: approved-workcenter POST error:`, awcErr.message);
              syncLog.workcenters.push({ code: wc.WorkcenterCode, opId: wc.PlexOperationId, error: awcErr.message });
              syncLog.errors.push({ step: 'WC_POST', code: wc.WorkcenterCode, error: awcErr.message });
            }
          }
        } catch (wcError) {
          console.warn(`>>> syncRoutingPlexCycle: approved workcenters sync failed (non-blocking): ${wcError.message}`);
        }

        console.log(`>>> syncRoutingPlexCycle: ops updated=${updatedCount}, created=${createdCount}, BOM created=${bomCreatedCount}, BOM updated=${bomUpdatedCount}, workcenters=${wcCreatedCount}`);

        const totalOk = updatedCount + createdCount;
        // [BOM-AUTODEPLETE] Conteggi degli esiti del flag: calcolati QUI, fuori dal try del passo
        // BOM, così valgono anche se quel passo è esploso a metà.
        const adCounts = bomRules.summarizeFlagStates(autodepleteStates);
        const adSegments = bomRules.flagDeclarationSegments(adCounts);
        // [W1-05] Stessa collocazione, stessa ragione: i conteggi dell'unità di consumo. NON
        // entrano in `logStatus` — l'arretrato è una conseguenza scelta del perimetro, non un
        // difetto accertato dell'invio, al contrario di `LEGACY_TRUE` che è un possibile doppio
        // consumo con effetti contabili. Il canale per accorgersene è il conteggio, non il colore.
        const uomCounts = bomRules.summarizeUomStates(uomStates);
        const uomSegments = bomRules.uomDeclarationSegments(uomCounts);
        // [WC-SUBTRACT] I conteggi della sottrazione, calcolati QUI come i due qui sopra: valgono
        // anche se il passo work center è esploso a metà. `wcExcessPending` è il numero di eccessi
        // RILEVATI e NON rimossi — non `wcDiff.excess.length`, perché un eccesso rimosso non è un
        // difetto residuo.
        const wcExcessPending = Object.values(wcNotRemovedBy).reduce((a, b) => a + b, 0);
        const wcCounts = Object.assign({}, wcDiff ? wcDiff.counts : { remoteKnown: false },
          { removed: wcRemovedCount, notRemovedBy: wcNotRemovedBy });
        const wcSegments = wcDiff ? approvedWcRules.excessDeclarationSegments(wcCounts) : [];

        // ================================================================
        // [COMP-ORPHAN] La potatura si DICHIARA nel messaggio dell'invio (0037).
        //
        // Una riga automatica che sparisce e' manutenzione e non si nomina — succede a ogni giro.
        // Una riga MANUALE che sparisce e' la decisione di una persona annullata perche' SAP l'ha
        // superata: se non la si nomina, quella persona riapre il ciclo, non trova il componente
        // dove l'aveva messo e non ha modo di sapere perche'.
        //
        // Non degrada l'esito: `logStatus` piu' sotto non guarda questo. Una modifica in SAP e'
        // manutenzione normale, non un guasto del ciclo.
        // ================================================================
        const pruneSegments = (compPlan && compPlan.manualDropped && compPlan.manualDropped.length)
          ? [logMsg.seg('logRoutingCompPruned',
            compPlan.manualDropped.length,
            compPlan.manualDropped.slice(0, 5).map((r) => r.Material).join(', '))]
          : [];

        // [LOG-MSG-I18N] IL MESSAGGIO NON E' PIU' UNA STRINGA (feature 0029). Era un template
        // literal inglese piu' tre code italiane concatenate: la testa non passava da i18n affatto,
        // ed e' il difetto segnalato — «Sync complete: 0 ops updated, …» a video in un'applicazione
        // italiana. Ora e' una lista di segmenti: `MessageJson` la porta, la lettura la rende nella
        // lingua di chi guarda, e `Message` resta lo snapshot testuale.
        //
        // L'ORDINE E' L'ORDINE DI IMPORTANZA, perche' `logMessage.pack` scarta dalla coda: prima la
        // testa, poi il doppio consumo (effetti contabili), poi l'unita' di consumo, per ultimi i
        // work center. Vedi il commento in testa a `excessDeclarationSegments`.
        const messageSegments = [
          logMsg.seg('logRoutingSyncDone', updatedCount, createdCount, bomCreatedCount, bomUpdatedCount, wcCreatedCount),
          // [ROUTING-BOM-DRIFT] Subito dopo la testa, e prima di tutto il resto: se questo invio
          // esiste perche' il confronto ha trovato una differenza, il PERCHE' e' la notizia. Vuoto
          // in ogni invio normale — il cancello non ha girato, e la lista resta quella di prima.
          ...(verifyDiff ? [logMsg.seg('logRoutingResent', verifyDiff.verdict.reason)] : []),
          ...verifySegments,
          // [COMP-ORPHAN] Subito dopo la testa: una collocazione a mano annullata e' la notizia che
          // interessa piu' di tutte a chi ha costruito il ciclo, e `logMessage.pack` scarta dalla
          // coda.
          ...pruneSegments,
          ...adSegments,
          ...uomSegments,
          ...wcSegments
        ];
        // Lo snapshot: in italiano, la lingua in cui i job compongono il recap attorno a questo
        // testo (i18nMessages.SNAPSHOT_LOCALE).
        const message = i18nMessages.render(messageSegments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
        const messageJson = logMsg.pack(messageSegments);
        // Vedi il ramo bloccato: `message` e' lo snapshot (database, `console`, recap del job) e
        // questo e' cio' che l'action restituisce a chi l'ha chiamata.
        const replyMessage = i18nMessages.render(messageSegments, i18nMessages.COCKPIT_APP, responseLocale(req));

        // I `console.warn` restano in italiano: li legge chi guarda `cf logs`, non un utente.
        if (pruneSegments.length) console.warn(`>>> [COMP-ORPHAN] ${i18nMessages.render(pruneSegments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE)}`);
        if (adSegments.length) console.warn(`>>> [BOM-AUTODEPLETE] ${i18nMessages.render(adSegments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE)}`);
        if (uomSegments.length) console.warn(`>>> [W1-05] ${i18nMessages.render(uomSegments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE)}`);
        if (wcSegments.length) console.warn(`>>> [WC-SUBTRACT] ${i18nMessages.render(wcSegments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE)}`);

        // Log success to DB
        const now = new Date();
        // [BOM-AUTODEPLETE] Una riga BOM il cui «autoDeplete» non è verificato degrada l'esito, e la
        // condizione è esplicita: NON si spinge una finta riga in `syncLog.errors` per ottenere la
        // 'W' gratis, perché quell'array è l'elenco degli errori mostrato nel pannello JSON e una
        // lacuna non è un errore d'invio.
        //
        // [WC-SUBTRACT] Terzo termine, stessa forma e stessa ragione — con una giustificazione più
        // forte: là il fatto è «non verificato», qui è ACCERTATO, perché abbiamo letto Plex e visto
        // la riga. Un 'S' su un ciclo che sappiamo divergente afferma il falso, e `needsSend()` non
        // ripescherà più questo ciclo. Una lettura NON RIUSCITA invece non degrada: `wcExcessPending`
        // resta 0 perché non si dichiara un arretrato che non si è misurato, e dare la 'W' a una
        // verifica non fatta renderebbe indistinguibile «Plex diverge» da «non ho potuto guardare».
        //
        // [ROUTING-BOM-DRIFT] Quarto termine, e la stessa distinzione: cio' che il reinvio SISTEMA
        // non degrada (fra un attimo su Plex ci sara'), cio' che nessun reinvio sistemera' si', ed e'
        // esattamente cio' che `degradesVerify` raccoglie — righe in eccesso su Plex, quantita' non
        // correggibili, un componente che su quel plant non e' una part. Senza questo termine
        // l'unico posto in cui il fatto e' scritto sarebbe il JSON della risposta, e `needsSend()`
        // non ripeschera' piu' questo ciclo.
        const logStatus = (syncLog.errors.length > 0 || adCounts.unverified > 0 || wcExcessPending > 0
          || verifyDegrades) ? 'W' : 'S';
        try {
          await db.run(INSERT.into(ZRoutingExcLogPOS).entries({
            ProductionRoutingGroup, ProductionRouting, Material: sMaterial, // [ROUTING-BY-MATERIAL]
            Counter: nextCounter,
            SentDate: now.toISOString().split('T')[0],
            SentTime: now.toISOString().split('T')[1].split('.')[0], // UTC, coerente con SentDate (delta job)
            Status: logStatus,
            Message: message.substring(0, 255),
            MessageJson: messageJson,   // [LOG-MSG-I18N] la forma resa alla lettura
            // [ROUTING-REQ-TRACE] Le chiavi del ciclo E le richieste vere, una per passo.
            RequestJson: JSON.stringify({
              ProductionRoutingGroup, ProductionRouting, Material: sMaterial,
              plexId: sPlexId, localOpsCount: localOps.length,
              calls: plexCalls
            }),
            ResponseJson: JSON.stringify({
              updatedCount, createdCount, bomCreatedCount, wcCreatedCount,
              // [BOM-AUTODEPLETE] La PROVA di ciò che è stato mandato e di ciò che si è osservato:
              // campo, leva, osservabilità sul tenant e conteggi per esito. È il livello di chi apre
              // il JSON dal pannello di dettaglio del ciclo.
              autodeplete: {
                field: bomRules.AUTODEPLETE_FIELD,
                enabled: adEnabled,
                observable: adObservability.observable,
                observedField: adObservability.field,
                counts: adCounts
              },
              // [W1-05] La prova di ciò che è partito come unità di consumo, e di quanto arretrato
              // resta. [BOM-DEPLETION-FACTOR] `factorValue` è dichiarato e non omesso: il runtime
              // Plex impone il fattore INSIEME all'unità — contratto alla mano sarebbe facoltativo,
              // ma un `POST` con la sola unità risponde `400 ARGUMENT_INVALID` e la riga non nasce
              // — e `1` è l'identità rispetto alla coppia che parte, perché quantità e unità
              // vengono dalla stessa riga STPO. Chi apre questo JSON deve vedere che è un valore
              // scelto e non un dato letto: quello vero, per unità alternative, sta in `MARM`.
              depletionUom: {
                field: bomRules.DEPLETION_UOM_FIELD,
                source: 'STPO-MEINS',
                // `validateSent` dice SE il campo è partito, `validateValue` QUALE valore portava:
                // gemello di `factorValue` qui sotto e per la stessa ragione. Dal 19/08/2026 il
                // valore è `false` (DEC-68) — senza questa chiave un log di prima e uno di dopo
                // sono identici, e il rilascio che ha invertito il flag diventa invisibile.
                validateSent: validateEnabled,
                validateValue: bomRules.VALIDATE_VALUE,
                factorField: bomRules.DEPLETION_FACTOR_FIELD,
                factorSent: true,
                factorValue: bomRules.DEPLETION_FACTOR_VALUE,
                counts: uomCounts
              },
              // [PLEX-OP-TYPE] La prova di QUALE `type` è partito e da dove viene. È il primo
              // posto in cui guardare quando Plex risponde `FIELD_REFERENCE_NOT_FOUND` su `Type`.
              // Dalla feature 0024 il valore viene dal CATALOGO Plex e non più dal customizing
              // (DEC-84), quindi le domande da distinguere sono cambiate: `catalogOk: false` dice
              // che il catalogo non è stato letto — ed è l'unico caso, insieme a un'operazione
              // priva di tipo sul tenant, in cui parte ancora il nome inglese di ripiego.
              opType: {
                field: 'type',
                source: 'plex-operation-catalog',
                defaultedCount: opTypeDefaulted,
                fallback: OP_TYPE_FALLBACK,
                catalogOk: !!(opCatalogRead && opCatalogRead.ok),
                catalogTyped: opCatalogRead && opCatalogRead.byId ? opCatalogRead.byId.size : 0,
                catalogCount: (opCatalogRead && opCatalogRead.count) || 0,
                catalogError: (opCatalogRead && opCatalogRead.error) || null,
                // Il mapping campi operazione resta, ma NON per `type`: le tre domande «riga non
                // configurata», «riga sotto un altro plant» e «lettura fallita» valgono per gli
                // altri cinque campi, e senza queste chiavi un customizing corretto e uno assente
                // producono lo stesso JSON — ed è esattamente quello che è successo una volta.
                lookupPlant: opFieldMap.plant || null,
                lookupOk: opFieldMap.readOk,
                mappedFields: opFieldMapRows.length
              },
              // [WC-SUBTRACT] La prova di che cosa si è MISURATO su Plex e di che cosa si è fatto.
              // `remoteKnown: false` è il campo da guardare quando qualcuno chiede perché questo
              // invio non ha rimosso niente. E `outOfScope` non è un dettaglio ozioso: è la prova
              // che il perimetro di DEC-66 ha lavorato, cioè il primo numero da guardare se un
              // giorno si accusasse la sottrazione di aver cancellato la configurazione di un altro
              // ciclo del materiale.
              approvedWc: {
                remoteKnown: !!(wcDiff && wcDiff.counts.remoteKnown),
                dataSource: wcDeleteDsId || null, // null = rimozione disattivata
                scopePartOperations: wcDiff ? wcDiff.scope.partOperationIds.length : 0,
                removed: wcRemovedCount,
                pending: wcExcessPending,
                counts: wcDiff ? wcCounts : null
              },
              details: syncLog
            }),
            ResponseStatus: 200
          }));
          // Upsert HDR — [ROUTING-BY-MATERIAL] per (ciclo, MATERIALE): con la chiave di prima
          // l'invio di un materiale sovrascriveva l'esito dell'altro, e il semaforo della lista
          // mostrava lo stato sbagliato su una riga.
          const hdrKey = { ProductionRoutingGroup, ProductionRouting, Material: sMaterial };
          const existingHdr = await db.run(SELECT.one.from(ZRoutingExcLogHDR).where(hdrKey));
          const hdrData = { Counter: nextCounter, SentDate: now.toISOString().split('T')[0], SentTime: now.toISOString().split('T')[1].split('.')[0], Status: logStatus, Message: message.substring(0, 255), MessageJson: messageJson };
          if (existingHdr) {
            await db.run(UPDATE(ZRoutingExcLogHDR).set(hdrData).where(hdrKey));
          } else {
            await db.run(INSERT.into(ZRoutingExcLogHDR).entries({ ...hdrKey, ...hdrData }));
          }
        } catch (logErr) {
          console.error('>>> syncRoutingPlexCycle: log save failed (non-blocking):', logErr.message);
        }

        return {
          success: totalOk === localOps.length,
          deactivatedCount: updatedCount,
          createdCount,
          message: replyMessage,
          // [LOG-MSG-I18N] I segmenti serializzati (feature 0031): il job ROUTING_SYNC compone la
          // propria riga di recap da qui e non da `message`, che e' reso in UNA lingua sola.
          messageJson,
          // Feature 0018: il job ne fa una riga di recap in attenzione. Non entra in `success`,
          // che dice se il CICLO è stato inviato per intero: l'invio è riuscito, è
          // l'auto-assegnazione ad aver girato su una classificazione incompleta.
          ClassificationStatus: classificationStatus,
          // [PHANTOM-EXPLODE] Come ClassificationStatus: non entra in `success`, degrada la riga
          // di recap del job (feature 0019).
          PhantomUnresolved: phantomUnresolved,
          // [W1-05] Idem: il ciclo e' stato inviato, ma qualche riga di distinta porta una
          // quantita' che non e' quella di SAP.
          BomQtyUnresolved: bomQtyUnresolved,
          // [ROUTING-DEFAULT-OP] Idem: il ciclo e' partito, ma da quale sorgente e con quale
          // ripiego decide la voce per plant del recap.
          CompSourceMode: compSourceMode,
          CompSourceFellBack: compSourceFellBack,
          // [BOM-AUTODEPLETE] Idem: su quante righe di distinta «autoDeplete = false» non e'
          // verificato ne' verificabile — flag attivo su una riga preesistente, oppure campo assente
          // dalla risposta di Plex. Non entra in `success` (la distinta E' arrivata) ma degrada la
          // riga di recap: un flag attivo e' un DOPPIO CONSUMO sui 261 della 0021, e `needsSend()`
          // non ripeschera' questo ciclo.
          AutodepleteUnverified: adCounts.unverified,
          // [PLEX-OP-TYPE] Idem: quante operazioni sono partite col `type` di ripiego invece che
          // col valore del tenant. Su un tenant non inglese e' la differenza fra un ciclo inviato
          // e cinque 400 secchi, quindi non puo' restare muto — ma non entra in `success`, che
          // resta l'esito dell'invio.
          OpTypeDefaulted: opTypeDefaulted,
          // [CONF-POSTING] Quante righe di mapping puntano a `operationNumber`. Non tocca `success`
          // — il ciclo E' partito — ma e' la causa di un guasto che si manifesta in un ALTRO job, e
          // senza questo contatore la si cerca nel posto sbagliato. Vedi il commento al rilevamento.
          OpNumberMapped: opNumberMapped,
          // [WC-SUBTRACT] Idem: quanti work center che il ciclo NON vuole più restano assegnati alle
          // operazioni su Plex. È accertato, non sospetto — la GET li ha visti — quindi degrada la
          // riga di recap del job e l'avviso dell'azione manuale; non entra in `success`, che dice se
          // le OPERAZIONI sono arrivate su Plex.
          WcExcessNotRemoved: wcExcessPending,
          WcRemoved: wcRemovedCount,
          // [ROUTING-COMP-SOURCE] Il ciclo E' partito, ma senza la seconda lettura della distinta:
          // i componenti che una modifica tecnica fa entrare piu' avanti non ci sono. Come le
          // altre degradazioni non tocca `success`, e come loro non puo' restare muta — qui
          // `needsSend()` non ripeschera' il ciclo, quindi se non lo si dice adesso non lo dice
          // piu' nessuno.
          SecondReadFailed: !!compSourceError,
          // [ROUTING-BOM-DRIFT] L'esito del confronto, quando il confronto ha girato. `NoOp: false`
          // e non assente: qui l'invio E' avvenuto, e un campo mancante si legge come `undefined`
          // in ogni `if` del chiamante — cioe' come «non lo so», che qui e' falso.
          NoOp: false,
          VerifyReason: verifyDiff ? verifyDiff.verdict.reason : null,
          BomMissing: verifyDiff ? verifyDiff.bom.counts.missing : 0,
          BomQtyDiff: verifyDiff ? verifyDiff.bom.counts.qtyDiff : 0,
          BomExtra: verifyDiff ? verifyDiff.bom.counts.extra : 0,
          // Senza confronto e' `false`, e vuol dire cio' che dice: nessuno ha letto la distinta per
          // confrontarla. L'invio idempotente del passo 7 la legge, ma per decidere riga per riga.
          BomRemoteKnown: verifyDiff ? verifyDiff.bom.remoteKnown : false,
          Blocked: false,
          BlockedCount: 0
        };
      } catch (error) {
        console.error('>>> ERROR syncRoutingPlexCycle:', error.message);

        // Log error to DB. [ROUTING-COMP-SOURCE] Stessa scrittura del ciclo bloccato e dell'invio
        // riuscito, dalla funzione condivisa: erano tre copie della stessa coppia posizione +
        // testata, e la terza — quella del blocco — sarebbe stata la quarta occasione di sbagliare
        // la chiave per materiale.
        const db2 = await cds.connect.to('db');
        const { ZRoutingExcLogHDR: LogHDR, ZRoutingExcLogPOS: LogPOS } = db2.entities('avvaleplm.marsplm.sap2plex');
        await writeRoutingSyncLog(db2, {
          ZRoutingExcLogHDR: LogHDR, ZRoutingExcLogPOS: LogPOS,
          ProductionRoutingGroup, ProductionRouting, Material: sMaterial, // [ROUTING-BY-MATERIAL]
          Counter: nextCounter,
          Status: 'E',
          // [LOG-MSG-I18N] Un'eccezione e' testo tecnico — di Plex, di axios o nostro — e non si
          // traduce: si avvolge, cosi' resta leggibile dentro una cornice tradotta.
          Segments: [
            logMsg.seg('logRoutingSyncFailed'),
            logMsg.technical(error.message || 'Unknown error')
          ],
          // [ROUTING-REQ-TRACE] Qui l'elenco NON e' vuoto e conta piu' che altrove: l'eccezione e'
          // arrivata dopo N chiamate, e quale sia l'ultima partita e' la prima cosa da guardare.
          Calls: plexCalls,
          ResponseStatus: 500,
          Response: { error: error.message, stack: error.stack, partialResults: syncLog }
        });

        req.error(500, error.message);
      }
    });

    // findRoutingTestData — diagnostic action: cross-reference production orders with routing material assignments
    this.on('findRoutingTestData', async (req) => {
      console.log(">>> findRoutingTestData: cross-referencing production orders with routing templates");

      try {
        // 1. Connect to production order API
        const S4ProdOrder = await prodOrderSource(); // [IS-SOURCE]
        const { A_ProductionOrder_2 } = S4ProdOrder.entities;

        // 2. Query routing material assignments (Product+Plant → RoutingGroup+Routing)
        const { ProductionRoutingMatlAssgmt, ProductionRoutingHeader } = this.S4Routing.entities;

        // ================================================================
        // [IS-SOURCE] (M6/TD-7) Questa action interrogava TRE collection senza alcun filtro
        // e senza gate di plant né di licenza: era l'unico punto che esponeva dati di plant
        // non licenziati, che FR-14 vieta «in nessun punto». Ora il perimetro si spinge come
        // $filter su tutte e tre le letture — che è anche il criterio che le funzioni dietro
        // gli iFlow richiedono. MODIFICA DI COMPORTAMENTO VOLUTA E DICHIARATA: su un ambiente
        // con plant fuori perimetro l'action restituisce meno righe di prima.
        // ================================================================
        const effectivePlants = [...(await resolveEffectivePlants(req))];
        if (!effectivePlants.length) {
          console.log('>>> findRoutingTestData: nessun plant in perimetro, nessuna lettura eseguita');
          return [];
        }
        console.log(`>>> [IS-SOURCE] findRoutingTestData: perimetro plant=[${effectivePlants}]`);

        const matlAssignments = await this.S4Routing.run(
          SELECT.from(ProductionRoutingMatlAssgmt)
            .columns('Product', 'Plant', 'ProductionRoutingGroup', 'ProductionRouting')
            .where({ Plant: { in: effectivePlants } })
            .limit(2000)
        );
        console.log(`>>> Retrieved ${matlAssignments.length} routing material assignments`);

        // Build lookup map: "Product|Plant" → [{RoutingGroup, Routing}]
        const matlMap = new Map();
        for (const ma of matlAssignments) {
          const key = `${ma.Product}|${ma.Plant}`;
          if (!matlMap.has(key)) matlMap.set(key, []);
          matlMap.get(key).push({
            ProductionRoutingGroup: ma.ProductionRoutingGroup,
            ProductionRouting: ma.ProductionRouting
          });
        }

        // 3. Query routing headers for descriptions
        // [ROUTING-SCOPE] Stato e utilizzo entrano nel $select: questa diagnostica applicava il
        // perimetro PLANT ma non quello dei cicli, quindi proponeva come dati di prova cicli che
        // la lista non mostra e su cui le azioni si rifiutano di lavorare.
        const headers = await this.S4Routing.run(
          SELECT.from(ProductionRoutingHeader)
            .columns('ProductionRoutingGroup', 'ProductionRouting', 'BillOfOperationsDesc',
              'Plant', 'BillOfOperationsStatus', 'BillOfOperationsUsage')
            .where({ Plant: { in: effectivePlants } })
            .limit(2000)
        );
        const dbScope = await cds.connect.to('db');
        const scopeRules = await routingVisibility.loadRoutingFilterConfig(dbScope);
        const inScopeHeaders = routingVisibility.applyRoutingFilter(headers, scopeRules);
        if (inScopeHeaders.stats.excluded) {
          console.log(`>>> [ROUTING-SCOPE] findRoutingTestData: ${inScopeHeaders.stats.excluded}`
            + ` cicli esclusi dal perimetro su ${inScopeHeaders.stats.in}`);
        }
        const headerMap = new Map();
        for (const h of inScopeHeaders.kept) {
          headerMap.set(`${h.ProductionRoutingGroup}|${h.ProductionRouting}`, h.BillOfOperationsDesc || '');
        }

        // 4. Query production orders
        const prodOrders = await S4ProdOrder.run(
          SELECT.from(A_ProductionOrder_2)
            .columns('ManufacturingOrder', 'Material', 'ProductionPlant', 'ProductionVersion')
            .where({ ProductionPlant: { in: effectivePlants } })
            .limit(500)
        );
        console.log(`>>> Retrieved ${prodOrders.length} production orders`);

        // 5. Cross-reference
        const results = [];
        for (const po of prodOrders) {
          const key = `${po.Material}|${po.ProductionPlant}`;
          const routings = matlMap.get(key);
          if (routings) {
            for (const rtg of routings) {
              const descKey = `${rtg.ProductionRoutingGroup}|${rtg.ProductionRouting}`;
              // [ROUTING-SCOPE] `headerMap` contiene ora le sole testate IN PERIMETRO: un ciclo che
              // non c'e' non va proposto come dato di prova. Vale anche per i cicli la cui testata
              // non e' stata letta affatto — non verificabile, quindi fuori.
              if (!headerMap.has(descKey)) continue;
              results.push({
                Material: po.Material,
                Plant: po.ProductionPlant,
                ManufacturingOrder: po.ManufacturingOrder,
                ProductionVersion: po.ProductionVersion || '',
                ProductionRoutingGroup: rtg.ProductionRoutingGroup,
                ProductionRouting: rtg.ProductionRouting,
                RoutingDescription: headerMap.get(descKey) || ''
              });
            }
          }
        }

        console.log(`>>> Found ${results.length} matches (material+order+routing)`);
        results.sort((a, b) => a.Material.localeCompare(b.Material));
        return results;
      } catch (error) {
        console.error('>>> ERROR in findRoutingTestData:', error.message);
        req.error(500, error.message);
      }
    });
  }

  // ================================================================
  // PLEX SERVICE - Integration with Plex external system
  // ================================================================
  if (this.name === 'PlexService') {
    // ================================================================
    // [PLEX-CONN] Prova la connessione configurata per UN plant (feature 0020).
    //
    // Prova ENTRAMBI i canali, perche' Plex si raggiunge su due host distinti con due schemi di
    // autenticazione distinti e i flussi usano tutti e due. Finche' provava il solo Connect, un
    // utente o una password Data Source sbagliati passavano il test col semaforo verde e il guasto
    // si scopriva al primo job notturno — lontano da chi aveva compilato il campo.
    //
    // I due canali si provano SEMPRE tutti e due, anche quando il primo fallisce: chi ha sbagliato
    // entrambi deve vederli entrambi in un giro solo.
    //
    // NON solleva errore OData su fallimento: un test che fallisce e' un ESITO, non un guasto del
    // servizio, e la schermata deve poterlo mostrare accanto ai campi che l'utente sta compilando.
    // L'esito viene scritto su LastTest* con una UPDATE diretta sul db — deliberatamente, per non
    // far scattare l'after UPDATE dell'entita' (che invaliderebbe la cache senza motivo: il test
    // non cambia la connessione).
    // ================================================================

    /**
     * Prova il canale Connect: GET {baseUrl}/mdm/v1/parts con la Consumer Key in header.
     * @returns {Promise<{ok: boolean, status: number, message: string, partsCount: number}>}
     */
    async function probeConnectChannel(creds) {
      // [PART-QUERY] Elenco non filtrato, e resta su v1 insieme a `[PART-ALIVE]`: i due devono
      // leggere lo STESSO indirizzo, o «test connessione OK, 3957 part» e il confronto degli id
      // della verifica part-viva parlerebbero di due elenchi diversi. Si spostano insieme, quando
      // la misura sullo spazio degli UUID c'e' (vedi srv/lib/plexPartsApi.js).
      const url = `${creds.baseUrl}${plexPartsApi.partsCatalogPath()}`;
      console.log('>>> [PLEX-CONN] sonda Connect:', url);
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json', 'X-Plex-Connect-Api-Key': creds.consumerKey }
        });
        if (!response.ok) {
          const text = await response.text();
          return {
            ok: false, status: response.status, partsCount: 0,
            message: `HTTP ${response.status}: ${String(text || '').substring(0, 200)}`
          };
        }
        const data = await response.json();
        const partsCount = Array.isArray(data) ? data.length : 0;
        return { ok: true, status: response.status, partsCount, message: `HTTP ${response.status} — ${partsCount} part` };
      } catch (e) {
        // Errore di rete: host irraggiungibile o inesistente. Non c'e' uno status HTTP.
        return { ok: false, status: 0, partsCount: 0, message: e.message };
      }
    }

    /**
     * Prova il canale Data Source: una execute sul tenant, in Basic auth.
     *
     * SONDA IN SOLA LETTURA. Si usa la 4216 (`Job_No` -> `Job_Key`), che e' il passo 6.1 del flusso
     * ordini, con un `Job_No` sentinella che non corrisponde a nessun job: la risposta attesa e' un
     * 200 con `rows` vuoto, e cio' che dimostra e' l'AUTENTICAZIONE, non l'esistenza di un dato. Le
     * quattro Data Source che scrivono (20051, 4858, 239905, 20793) non possono fare da sonda: un
     * pulsante di test non deve lasciare tracce sul tenant.
     *
     * Si riusa `executeDataSource` di plexJobsClient.js, cioe' esattamente la funzione che i job
     * usano in esercizio: una meccanica diversa proverebbe una cosa diversa da quella che poi gira.
     *
     * I tre modi di sbagliare portano a tre correzioni diverse e vanno distinti:
     *   401/419  credenziale sbagliata (419 = si sta mandando la Connect API key su questo canale)
     *   404      host giusto, IDENTIFICATIVO della Data Source sbagliato
     *   rete     host sbagliato o irraggiungibile
     *
     * @returns {Promise<{ok: boolean, status: number, message: string}>}
     */
    async function probeDataSourceChannel(req, creds) {
      const { executeDataSource } = require('./jobs/lib/plexJobsClient');
      const dsId = plexDataSources.DS_GET_JOB_KEY;
      console.log(`>>> [PLEX-CONN] sonda Data Source ${dsId} su ${creds.dataSourceUrl}`);
      try {
        const r = await executeDataSource(creds, dsId, { Job_No: PLEX_CONN_PROBE_JOB_NO });
        if (r.ok) {
          return {
            ok: true, status: r.status,
            message: getLocalizedMessage(req, 'plexConnProbeOk', 'adminconfigplant', String(r.status), String(dsId))
          };
        }
        const key = r.status === 404 ? 'plexConnProbeBadId'
          : (r.status === 401 || r.status === 403 || r.status === 419) ? 'plexConnProbeBadCredentials'
            : 'plexConnProbeHttp';
        return {
          ok: false, status: r.status,
          message: getLocalizedMessage(req, key, 'adminconfigplant', String(r.status), String(dsId))
        };
      } catch (e) {
        // `executeDataSource` PROPAGA: qui finiscono sia l'errore di rete sia il rifiuto di
        // requireDataSourceCreds quando host o utente sono vuoti.
        return {
          ok: false, status: 0,
          message: getLocalizedMessage(req, 'plexConnProbeUnreachable', 'adminconfigplant', e.message)
        };
      }
    }

    this.on('testPlexConnection', async (req) => {
      const plant = (req.data.Plant || '').trim();
      // Stesso gate dell'entita' che configura: provare una connessione significa vedere se una
      // chiave segreta e' quella giusta.
      if (await rejectIfNotFullAdmin(req, plant)) return;

      console.log(`>>> [PLEX-CONN] test della connessione del plant ${plant}...`);
      const db = await cds.connect.to('db');
      const { ZPlexConnConfig } = db.entities('avvaleplm.marsplm.sap2plex');

      // Esito scritto sulla riga, cosi' che la schermata lo ritrovi anche riaprendola.
      const persist = async (status, message) => {
        try {
          await db.run(UPDATE(ZPlexConnConfig).set({
            LastTestedAt: new Date().toISOString(),
            LastTestStatus: status,
            LastTestMessage: (message || '').substring(0, 255)
          }).where({ Plant: plant }));
        } catch (e) {
          console.error(`>>> [PLEX-CONN] esito del test non salvato per il plant ${plant}: ${e.message}`);
        }
      };

      let creds;
      try {
        // `force: true`: il test deve provare cio' che l'utente ha appena salvato, non cio' che
        // era in cache un minuto fa.
        creds = await loadPlexConnection(req, plant, { force: true });
      } catch (error) {
        // Plant non configurato: non c'e' niente da provare, e i due canali non esistono ancora.
        console.error(`>>> [PLEX-CONN] test non eseguibile per il plant ${plant}: ${error.message}`);
        await persist('E', error.message);
        return {
          success: false,
          connectOk: false, connectStatus: 0, connectMessage: error.message, partsCount: 0,
          dataSourceOk: false, dataSourceStatus: 0, dataSourceMessage: error.message
        };
      }

      // I due canali sono INDIPENDENTI: si provano tutti e due, in parallelo, e nessuno dei due
      // puo' impedire all'altro di rispondere.
      const [connect, dataSource] = await Promise.all([
        probeConnectChannel(creds),
        probeDataSourceChannel(req, creds)
      ]);

      const success = connect.ok && dataSource.ok;
      console.log(`>>> [PLEX-CONN] plant ${plant}: Connect ${connect.ok ? 'OK' : 'KO'} (${connect.message}),`
        + ` Data Source ${dataSource.ok ? 'OK' : 'KO'} (${dataSource.message})`);

      // Una sola colonna di esito, come prima: porta il PEGGIORE dei due, e il messaggio li
      // riassume entrambi — altrimenti «riuscito» direbbe una cosa vera a meta'.
      await persist(success ? 'S' : 'E',
        getLocalizedMessage(req, 'plexConnTestSummary', 'adminconfigplant', connect.message, dataSource.message));

      return {
        success,
        connectOk: connect.ok,
        connectStatus: connect.status,
        connectMessage: connect.message,
        partsCount: connect.partsCount,
        dataSourceOk: dataSource.ok,
        dataSourceStatus: dataSource.status,
        dataSourceMessage: dataSource.message
      };
    });

    // ================================================================
    // [PLEX-VALUE-PROBE] ---- SONDA TEMPORANEA DI DIAGNOSI, DA RIMUOVERE ----
    // ================================================================
    // Le regole (matrice, oracolo, verdetto) stanno nel modulo puro srv/lib/plexPartValueProbe.js,
    // con i loro test. Qui c'e' solo l'orchestrazione: quattro giri e le chiamate.
    //
    // NON LANCIA MAI. `plexConnect` lancia sugli errori di rete: si inghiotte in httpStatus 0,
    // come fa probeConnectChannel del test di connessione.
    this.on('probePlexPartValues', async (req) => {
      const probe = require('./lib/plexPartValueProbe');
      const { plexPost } = require('./jobs/lib/plexJobsClient');

      const product = (req.data.Product || '').trim();
      const plant = (req.data.Plant || '').trim();

      if (String(process.env.PLEX_VALUE_PROBE || '').toLowerCase() === 'off') {
        const off = probe.emptyRow();
        off.id = 'OFF';
        off.what = 'sonda SPENTA (PLEX_VALUE_PROBE=off): nessuna chiamata verso Plex';
        return [off];
      }
      if (!product) return req.reject(400, 'Product obbligatorio: la sonda deriva da lui il numero della part di prova');
      if (!plant) return req.reject(400, 'Plant obbligatorio: la connessione Plex e per plant (feature 0020)');

      // Gate del PLANT, come le altre sonde, e non gate di ruolo admin.
      //
      // La sonda scrive, quindi la tentazione e' chiedere l'admin. Sarebbe pero' un gate PIU'
      // STRETTO di quello dell'invio vero: `sendProductToPlex` sta sullo stesso bottone di questa
      // e crea la part VERA senza chiedere nessun ruolo. Una sonda che crea una part usa e getta
      // non e' piu' pericolosa dell'azione accanto, e gatarla di piu' avrebbe il solo effetto di
      // rendere la diagnosi impossibile a chi ha il problema. Resta il choke-point della licenza,
      // che e' quello che ogni lettura di dati di plant attraversa.
      const usable = [...(await resolveEffectivePlants(req))];
      if (!usable.includes(plant)) {
        return req.reject(403, `Plant '${plant}' non utilizzabile per questo utente `
          + `(attivo e licenziato: ${usable.join(', ') || 'nessuno'})`);
      }

      let creds;
      try {
        creds = await loadPlexConnection(req, plant);
      } catch (e) {
        const bad = probe.emptyRow();
        bad.id = 'CONN';
        bad.what = `connessione Plex non risolta: ${e.message}`;
        return [bad];
      }

      const rows = [];
      const createdParts = [];
      const runAll = String(process.env.PLEX_VALUE_PROBE_ALL || '').toLowerCase() === 'on';

      /** Una chiamata di sonda. Non lancia: un errore di rete diventa httpStatus 0. */
      const call = async ({ id, field, candidate, sentAs, isControl, what, type, status }) => {
        const r = probe.emptyRow();
        r.id = id;
        r.field = field || '';
        r.candidate = candidate === undefined ? '' : String(candidate);
        r.sentAs = sentAs || '';
        r.isControl = !!isControl;
        r.what = what || '';

        const body = probe.buildProbeBody({ product, id, type, status });
        r.partNumber = body.number;
        const t0 = Date.now();
        try {
          // [PART-QUERY] Scrittura: resta su v1 (su v2 `type` e `status` sono obbligatori).
          const res = await plexPost(creds, plexPartsApi.partsWritePath(), body);
          r.httpStatus = res.status;
          const rejected = probe.rejectedFieldsOf(res.body);
          r.rejectedFields = rejected.join(', ');
          r.accepted = probe.isAccepted({
            ok: res.ok, status: res.status, rejectedFields: rejected, probedField: field
          });
          r.created = !!res.ok;
          r.plexId = (res.ok && res.body && res.body.id) ? String(res.body.id) : '';
          r.responseBody = (typeof res.body === 'string' ? res.body : JSON.stringify(res.body || null)).slice(0, 2000);
        } catch (e) {
          // Errore di trasporto: la richiesta non e' arrivata. NON e' un verdetto.
          r.httpStatus = 0;
          r.error = String(e && e.message ? e.message : e).slice(0, 2000);
        }
        r.ms = Date.now() - t0;

        // Una part creata si dichiara SEMPRE, e si tenta di rimuoverla. Una prova che lascia
        // rifiuti sul tenant senza dirlo e' peggio di una prova non fatta.
        if (r.created) {
          createdParts.push({ partNumber: r.partNumber, plexId: r.plexId, deleted: false });
          if (r.plexId) {
            try {
              const del = await plexConnectDelete(creds, plexPartsApi.partsWritePath(r.plexId));
              r.deleted = del.ok;
              createdParts[createdParts.length - 1].deleted = del.ok;
              if (!del.ok) r.error = `${r.error} | DELETE ha risposto ${del.status}: la part resta su Plex`.trim();
            } catch (e) {
              r.error = `${r.error} | DELETE non riuscita (${e.message}): la part resta su Plex`.trim();
            }
          }
        }
        rows.push(r);
        return r;
      };

      // ---- giro 0: calibratura. Sentinella su ENTRAMBI i campi: non crea nulla e dice se
      //      l'oracolo esiste.
      const cal = await call({
        id: 'CAL', field: '', candidate: probe.SENTINEL, sentAs: 'string',
        what: 'CALIBRATURA — sentinella su entrambi i campi: Plex deve nominarli entrambi in errors[]',
        type: probe.SENTINEL, status: probe.SENTINEL
      });
      const calRejected = cal.rejectedFields ? cal.rejectedFields.split(', ') : [];
      const calibration = probe.calibrationVerdict({
        ok: cal.created, status: cal.httpStatus, rejectedFields: calRejected
      });
      cal.what += `\n  -> ${calibration.why}`;

      if (!calibration.usable) {
        // Senza oracolo non si sonda: si dichiarano tutte le varianti come non eseguite.
        for (const c of probe.TYPE_CANDIDATES) rows.push(probe.skipped(c.id, probe.FIELD_TYPE, calibration.why));
        for (const c of probe.STATUS_CANDIDATES) rows.push(probe.skipped(c.id, probe.FIELD_STATUS, calibration.why));
        rows.push(probe.skipped('CONF', '', calibration.why));
        rows.unshift(probe.verdict({ calibration, typeRows: [], statusRows: [], createdParts }));
        logProbeRows(rows);
        return rows;
      }

      // ---- giro 1: la tipologia. `status` = spina, quindi nessuna creazione.
      const typeRows = [];
      for (const c of probe.TYPE_CANDIDATES) {
        if (!runAll && !c.control && typeRows.some((r) => r.accepted && !r.isControl)) {
          rows.push(probe.skipped(c.id, probe.FIELD_TYPE,
            'un candidato precedente e gia stato accettato (PLEX_VALUE_PROBE_ALL=on per eseguirli tutti)'));
          continue;
        }
        typeRows.push(await call({
          id: c.id, field: probe.FIELD_TYPE, candidate: c.value, sentAs: c.sentAs,
          isControl: c.control, what: c.what, type: c.value, status: probe.SENTINEL
        }));
      }

      // ---- giro 2: lo stato. `type` = spina.
      const statusRows = [];
      for (const c of probe.STATUS_CANDIDATES) {
        if (!runAll && !c.control && statusRows.some((r) => r.accepted && !r.isControl)) {
          rows.push(probe.skipped(c.id, probe.FIELD_STATUS,
            'un candidato precedente e gia stato accettato (PLEX_VALUE_PROBE_ALL=on per eseguirli tutti)'));
          continue;
        }
        statusRows.push(await call({
          id: c.id, field: probe.FIELD_STATUS, candidate: c.value, sentAs: c.sentAs,
          isControl: c.control, what: c.what, type: probe.SENTINEL, status: c.value
        }));
      }

      // ---- giro 3: conferma. E' l'UNICA chiamata che puo' creare, e crea UNA part usa e getta.
      const winner = probe.pickWinner(typeRows, statusRows);
      let confirmation = null;
      if (!winner) {
        rows.push(probe.skipped('CONF', '', 'nessuna coppia accettata da confermare'));
      } else {
        const conf = await call({
          id: 'CONF', field: '', candidate: `${winner.type} + ${winner.status}`, sentAs: 'string',
          what: `CONFERMA — la coppia accettata, su una part usa e getta. E' l'unica chiamata che crea.`,
          type: winner.type, status: winner.status
        });
        confirmation = {
          created: conf.created, partNumber: conf.partNumber,
          httpStatus: conf.httpStatus, plexId: conf.plexId, deleted: conf.deleted
        };
      }

      rows.unshift(probe.verdict({ calibration, typeRows, statusRows, winner, confirmation, createdParts }));
      logProbeRows(rows);
      return rows;
    });

    /**
     * [PLEX-VALUE-PROBE] DELETE sulla Connect API. `plexJobsClient` espone get/post/put e non
     * delete — nessun flusso d'esercizio cancella niente su Plex, ed e' giusto cosi'. Qui serve
     * solo per rimuovere la part di prova, quindi la chiamata sta qui e non nel modulo condiviso:
     * aggiungere una `plexDelete` riusabile darebbe a tutto il progetto un attrezzo che nessun
     * flusso deve avere.
     */
    async function plexConnectDelete(creds, path) {
      const url = `${creds.baseUrl}${path}`;
      console.log(`>>> [PLEX-VALUE-PROBE] DELETE ${url}`);
      const response = await fetch(url, {
        method: 'DELETE',
        headers: { 'Accept': 'application/json', 'X-Plex-Connect-Api-Key': creds.consumerKey }
      });
      return { ok: response.ok, status: response.status };
    }

    /** [PLEX-VALUE-PROBE] Il verdetto sul log, e le sole righe che spiegano qualcosa. */
    function logProbeRows(rows) {
      const verdetto = rows.find((r) => r.id === 'VERDETTO');
      if (verdetto) console.log(`>>> [PLEX-VALUE-PROBE]\n${verdetto.what}`);
      for (const r of rows) {
        if (r.id === 'VERDETTO') continue;
        if (r.accepted || r.created || r.error || r.httpStatus === 0) {
          console.log(`>>> [PLEX-VALUE-PROBE] ${r.id} ${r.field} «${r.candidate}» -> HTTP ${r.httpStatus}`
            + `${r.accepted ? ' ACCETTATO' : ''}${r.created ? ' CREATO ' + r.plexId : ''}`
            + `${r.rejectedFields ? ' rifiutati: ' + r.rejectedFields : ''}${r.error ? ' | ' + r.error : ''}`);
        }
      }
    }

    // Full list of configured products, ONE ROW PER (Product, Plant).
    // Used by the "Send all to Plex" flow to get the complete set without the paginated
    // READ's maxTop clamp.
    //
    // [PLANT-ROWS] `refresh: true` — e non e' un dettaglio. Dalla 0035 il perimetro di un plant
    // sta in cache per cinque minuti, ma la cache si ferma alla DASHBOARD: da qui si SCRIVE su
    // Plex, e [DEC-75] dice che chi scrive legge sempre fresco. Un materiale creato in SAP dieci
    // minuti fa deve poter partire adesso, non al prossimo scadere del TTL.
    //
    // ================================================================
    // [MAT-PLANT-PAIR] IL SELETTORE PLANT DELLA DASHBOARD VALE ANCHE QUI (feature 0039).
    //
    // Fino alla 0039 questa action chiamava `loadConfiguredProducts` SENZA `req`, quindi
    // `resolveEffectivePlants(null)` rendeva tutti i plant attivi e il selettore in alto veniva
    // ignorato (0006 RB-17). Con un tenant Plex per plant quella stranezza diventa un fatto grosso:
    // chi guarda UN plant preme un tasto che scrive su TUTTI i MES. Ora si passa `req`, e il
    // perimetro puo' solo restringersi — `resolveEffectivePlants` interseca sempre con i plant
    // attivi e licenziati, che resta il choke-point unico (0001).
    //
    // MA LA LINGUA SI PINNA, e senza questa riga il cambio sarebbe un difetto muto:
    // `loadConfiguredProducts` deriva `language` da `accept-language` con ripiego `'EN'`, e quella
    // lingua e' la descrizione letta da SAP — cioe' la descrizione SCRITTA SU PLEX. Passando `req`
    // e basta, la part cambierebbe lingua a seconda del browser di chi preme il pulsante. Si passa
    // quindi la stessa lingua del job (`PLEX_MAT_LANGUAGE`, default `'EN'`), cosi' cockpit e job
    // scrivono su Plex lo stesso testo.
    // ================================================================
    this.on('getConfiguredProducts', async (req) => {
      const language = (process.env.PLEX_MAT_LANGUAGE || 'EN').toUpperCase();
      const { plantRows, productMap } = await loadConfiguredProducts({ req, refresh: true, language });
      // One entry per (Product, Plant) so the per-plant field mapping — and the per-plant Plex
      // tenant — can be resolved on send.
      //
      // [MAT-SCOPE] SI FILTRA SU `__sendable`, e non basta che la riga sia in lista (feature 0050).
      //
      // `loadConfiguredProducts` restituisce cio' che si VEDE, e le due domande divergono su un
      // caso: `CATEGORIES_UNKNOWN`. Con il customizing delle categorie non letto la lista resta
      // piena — mostrare di piu' e' un fastidio che si vede, DEC-52 — ma verso Plex non si scrive
      // su una configurazione che non si e' riusciti a leggere: sarebbe di nuovo un corpo senza
      // `type`, cioe' l'`HTTP 400` da cui questa feature nasce, con un'altra causa a monte.
      //
      // Il gate esatto resta comunque a valle, in `sendProductToPlex`: questo evita di CHIEDERE
      // l'invio di cio' che verrebbe rifiutato, e con esso una riga di rifiuto per materiale nel
      // dialogo di avanzamento.
      const sendable = plantRows.filter((r) => r.__sendable !== false);
      const trattenute = plantRows.length - sendable.length;
      const list = matPlantRules.dedupePairs(sendable).map((r) => ({
        Product: r.Product,
        ProductDescription: productMap.get(r.Product)?.ProductDescription || '',
        Plant: r.Plant
      }));
      const stats = matPlantRules.pairStats(list);
      console.log(`>>> getConfiguredProducts: ${stats.pairs} coppie (materiale, plant)`
        + ` — ${stats.materials} materiali su ${stats.plants} plant`
        + (trattenute ? ` (${trattenute} righe in lista ma NON inviabili: vedi [MAT-SCOPE])` : ''));
      return list;
    });

    // Send a CHUNK of products to Plex (server-side). The client fetches the full configured
    // list once, then calls this per page so it can show live progress. Reuses the existing
    // single-product send handler (mapping + CREATE/UPDATE + logging).
    this.on('sendProductsChunkToPlex', async (req) => {
      const incoming = req.data.products || [];
      // ================================================================
      // [MAT-PLANT-PAIR] Il perimetro si applica ANCHE QUI (feature 0039).
      //
      // Questa action riceve dal client un elenco di coppie e le manda a `sendProductToPlex`, che
      // scrive sul tenant del plant dichiarato — e `loadPlexConnection` non ha gate di licenza.
      // Finche' l'elenco veniva dal server il problema era latente; ora che il client dichiara i
      // plant, va chiuso qui: fuori perimetro non si scrive.
      //
      // E LO SCARTO SI CONTA. Scartare in silenzio farebbe credere all'utente di aver mandato cio'
      // che aveva selezionato — che e' la classe di difetto che tutta questa feature corregge —
      // quindi `skipped` esce nella risposta e il dialogo lo mostra.
      // ================================================================
      const usable = await resolveEffectivePlants(req);
      const list = [];
      let skipped = 0;
      for (const p of incoming) {
        const plant = matPlantRules.keyPart(p && p.Plant);
        if (!matPlantRules.sendablePlant(plant) || !usable.has(plant)) { skipped++; continue; }
        list.push({ ...p, Plant: plant });
      }
      if (skipped > 0) {
        console.warn(`>>> [MAT-PLANT-PAIR] sendProductsChunkToPlex: ${skipped} coppie fuori`
          + ` perimetro scartate (plant utilizzabili: ${[...usable].join(', ') || '(nessuno)'})`);
      }

      let success = 0, errors = 0;
      const CONCURRENCY = 5;
      for (let i = 0; i < list.length; i += CONCURRENCY) {
        const batch = list.slice(i, i + CONCURRENCY);
        const outcomes = await Promise.all(batch.map(async (p) => {
          try {
            const r = await this.send('sendProductToPlex', { Product: p.Product, ProductDescription: p.ProductDescription, Plant: p.Plant });
            return r && r.success;
          } catch (e) {
            console.error(`>>> sendProductsChunkToPlex: ${p.Product} ERROR - ${e.message}`);
            return false;
          }
        }));
        for (const ok of outcomes) ok ? success++ : errors++;
      }
      console.log(`>>> sendProductsChunkToPlex: ${list.length} sent (success=${success}, errors=${errors}, skipped=${skipped})`);
      return { success, errors, skipped };
    });

    // Send product to Plex (CREATE or UPDATE with fallback)
    this.on('sendProductToPlex', async (req) => {
      const { Product, ProductDescription, Plant } = req.data;
      console.log(`>>> Sending Product ${Product} (plant ${Plant || 'n/a'}) to Plex...`);

      // ================================================================
      // [MAT-PLANT-PAIR] Senza plant non si scrive NIENTE (feature 0039).
      //
      // Dalla 0039 il plant e' in chiave sui due dizionari e sui due log, e `''` non e' «un plant
      // come un altro»: e' la chiave con cui sono rimaste in tabella le righe scritte PRIMA della
      // feature, quelle dichiarate invisibili. Una scrittura con `Plant = ''` andrebbe a collidere
      // con una riga storica — violazione di unicita', il caso rumoroso — oppure a RISCRIVERLA,
      // che e' il caso muto.
      //
      // Il caso era gia' coperto, ma solo PER COINCIDENZA DI ORDINE: `loadPlexConnection` qui sotto
      // lancia `PlexConnectionPlantMissing` prima che si apra la connessione al db. Bastava
      // spostare una lettura sopra quella riga per aprire il buco. Qui la protezione diventa una
      // regola, con il suo nome e il suo test.
      //
      // ESITO APPLICATIVO E NON `req.error`: il job propaga gia' i segmenti di questo ritorno nella
      // sua riga di recap, mentre un'eccezione finirebbe nel suo `catch` e uscirebbe come testo
      // tecnico non tradotto (DEC-92). E NESSUNA RIGA DI LOG: la chiave dello storico e'
      // (Product, Plant, Counter) e il plant e' proprio cio' che manca — scriverla con `Plant = ''`
      // sarebbe la bugia che [MAT-LOG-PLANT] denuncia.
      // ================================================================
      const plant = matPlantRules.keyPart(Plant);
      if (!matPlantRules.sendablePlant(plant)) {
        const segs = [logMsg.seg('logMatPlantMissing', Product)];
        const msg = i18nMessages.render(segs, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
        console.error(`>>> [MAT-PLANT-PAIR] ${msg}`);
        return {
          success: false, operation: 'ERROR', plexId: null, message: msg,
          messageJson: logMsg.pack(segs),
          receivingOperation: recvOpRules.RECV_STATE.NOT_REQUIRED
        };
      }

      // ================================================================
      // [PLANT-ACCESS] Il perimetro dell'utente vale anche QUI (feature 0048).
      //
      // Questa action crea o aggiorna la part sul tenant Plex del plant che il CLIENT dichiara, e
      // non aveva nessun gate: il commento vicino affermava che «resta il choke-point della
      // licenza, che e' quello che ogni lettura di dati di plant attraversa» — vero per le letture,
      // falso su questo percorso, che e' una scrittura. Il gate del perimetro stava un livello
      // sopra, in `sendProductsChunkToPlex`: una chiamata diretta a questo indirizzo lo scavalcava.
      //
      // ESITO APPLICATIVO E NON `req.error`, per la stessa ragione del rifiuto qui sopra: il job
      // propaga questo ritorno nella sua riga di recap, e un'eccezione uscirebbe come testo tecnico
      // non tradotto (DEC-92). La chiave sta nel bundle del COCKPIT perche' `render` usa
      // `COCKPIT_APP`, non `adminconfigplant` come i gate che usano `req.error`.
      //
      // DENTRO UN RUN BATCH NON SCATTA: `identify` rende `BATCH` e il perimetro resta quello
      // licenziato. E' cio' che tiene intero `MAT_SYNC`, che invoca questa action con `send()` nudo.
      // ================================================================
      if (!(await isPlantUsable(req, plant))) {
        const segs = [logMsg.seg('logMatPlantOutOfScope', Product, plant)];
        const msg = i18nMessages.render(segs, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
        console.warn(`>>> [PLANT-ACCESS] ${msg}`);
        return {
          success: false, operation: 'ERROR', plexId: null, message: msg,
          messageJson: logMsg.pack(segs),
          receivingOperation: recvOpRules.RECV_STATE.NOT_REQUIRED
        };
      }

      // [PLEX-CONN] Connessione del plant: `Plant` e' gia' in firma, e serviva gia' a risolvere
      // il mapping campi per plant. Ora decide anche su quale tenant Plex si scrive.
      const { baseUrl: plexUrl, consumerKey } = await loadPlexConnection(req, plant);

      const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Plex-Connect-Api-Key': consumerKey
      };

      // Concatenate base URL with Parts API path
      // [PART-QUERY] La base di creazione/aggiornamento part: resta su v1, perche' la v2
      // pretende `type` e `status` e su un plant che non li mappa `MAT_SYNC` comincerebbe a
      // fallire. Il debito e' dichiarato in srv/lib/plexPartsApi.js.
      const partsApiUrl = `${plexUrl}${plexPartsApi.partsWritePath()}`;

      const db = await cds.connect.to('db');
      const { ZMatPlexMapping, ZMatExcLogHDR, ZMatExcLogPOS } = db.entities('avvaleplm.marsplm.sap2plex');

      // Get next counter for logging
      // [MAT-LOG-PLANT] Il progressivo e' PER (materiale, plant): con un contatore per materiale i
      // due plant si sarebbero contesi la stessa sequenza e la chiave (Product, Plant, Counter)
      // avrebbe collisioni proprio sui materiali condivisi.
      // [MAT-PLANT-PAIR] Dopo il gate qui sopra `''` non e' piu' raggiungibile: `logPlant` e' il
      // plant vero, sempre. E' cio' che tiene le righe nuove FUORI dal secchio storico.
      const logPlant = plant;
      const lastLog = await db.run(
        SELECT.one.from(ZMatExcLogPOS)
          .columns('Counter')
          .where({ Product, Plant: logPlant })
          .orderBy('Counter desc')
      );
      const nextCounter = (lastLog?.Counter || 0) + 1;
      console.log(`>>> [COUNTER] Next counter for Product ${Product}: ${nextCounter}`);

      // [IS-SOURCE] (V2, FR-22/FR-23/M-04) Nota dello scambio: le informazioni che il canale
      // attivo NON fornisce, dichiarate UNA VOLTA e in forma aggregata dentro RequestJson.
      // `substituteValues` è vuoto PER COSTRUZIONE: nessun valore di riempimento viene usato.
      // La chiave è AGGIUNTIVA, quindi nessun consumatore esistente del log si rompe.
      let exchangeNotes = null;

      // [PART-DUPLICATE] L'ULTIMA richiesta preparata, per la riga di log del `catch`.
      //
      // Quel blocco sintetizzava `method`/`url`/`body` da `mapping` e `requestBody`, che sono
      // `const` dichiarate DENTRO il `try`: nel `catch` non sono in scope, quindi `typeof` rendeva
      // 'undefined' e ogni riga d'errore di ogni materiale dichiarava `method: 'POST'` e
      // `body: {}` — due costanti travestite da misura. Il `body: {}` osservato sulla riga 4 del
      // 14/09/2026 e' la prova, e quella riga ha mandato la diagnosi sul ramo sbagliato.
      //
      // Qui invece c'e' gia' tutto: metodo, URL e corpo VERI della chiamata, con la Consumer Key
      // gia' mascherata poche righe piu' sotto. Si conserva l'ultima preparata e il `catch` la usa.
      // Non e' una chiamata in piu' e non e' una sonda (DEC-72): e' la stessa richiesta che stava
      // per partire.
      let lastRequestJson = null;

      // Helper function to capture full HTTP request/response details
      const captureHttpExchange = async (method, url, headers, body) => {
        const requestTimestamp = new Date().toISOString();
        const startTime = Date.now();

        // Mask sensitive headers
        const maskedHeaders = { ...headers };
        if (maskedHeaders['X-Plex-Connect-Api-Key']) {
          maskedHeaders['X-Plex-Connect-Api-Key'] = '***MASKED***';
        }

        // Build request JSON
        const requestJson = {
          timestamp: requestTimestamp,
          method,
          url,
          headers: maskedHeaders,
          body: body ? JSON.parse(body) : null,
          ...(exchangeNotes ? { notes: exchangeNotes } : {})
        };

        lastRequestJson = requestJson;   // [PART-DUPLICATE] vedi la dichiarazione qui sopra
        return { requestJson, startTime };
      };

      const finalizeHttpExchange = async (requestJson, startTime, response) => {
        const endTime = Date.now();
        const responseTime = endTime - startTime;

        // Capture response headers
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Parse response body
        const responseBodyText = await response.clone().text();
        let responseBody;
        try {
          responseBody = JSON.parse(responseBodyText);
        } catch (e) {
          responseBody = responseBodyText;
        }

        // Build response JSON
        const responseJson = {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          responseTime,
          body: responseBody
        };

        return { requestJson, responseJson };
      };

      // [MAT-PLANT-PAIR] La chiave del dizionario e la riga da scrivere, in UN punto solo.
      //
      // I quattro rami che creano una riga di mapping — CREATE, CREATE (fallback), EXISTING e il
      // recupero da DUPLICATE — scrivevano quattro letterali identici. Con `Plant` in chiave e
      // `default ''` addosso, il ramo in cui qualcuno dimenticasse la colonna NON fallirebbe: il
      // database la riempirebbe da solo e la riga finirebbe nel secchio storico, per riemergere
      // mesi dopo come violazione di unicita' su un altro plant. Un letterale solo, un posto solo.
      const mappingKey = { Product, Plant: plant };
      const mappingRow = (id) => ({
        ...mappingKey, PlexId: id, CreatedAt: new Date().toISOString(), UpdatedAt: new Date().toISOString()
      });

      // [PART-ALIVE] Scrivere il dizionario di una part NUOVA e azzerare quello del ricevimento sono
      // UNA cosa sola (feature 0042).
      //
      // `ZMatRecvOpMapping` non registra di QUALE part parla, e le sue righe storiche restano
      // visibili — a differenza della gemella. Quindi su una part nuova una riga sopravvissuta fa
      // rispondere «gia' fatta» al passo di ricevimento, su una part-operation che non esiste:
      // nessuna chiamata, nessuna degradazione, e la part nasce senza operazione su cui ricevere con
      // esito 'S'. Osservato in DEV dopo un azzeramento del tenant, non ipotetico.
      //
      // Il discriminante e' che la PART e' nuova, non che la RIGA sia nuova: i due rami «part gia'
      // su Plex» (EXISTING e recupero da DUPLICATE) scrivono anche loro una riga nuova, ma la part
      // esiste da prima e la sua part-operation con lei — la' questa funzione NON va usata, e il
      // commento accanto a ognuno dei due lo dice. Idempotente: il ramo 404 azzera gia' prima di
      // ricreare, insieme alla cancellazione del mapping stantio.
      const saveMappingForNewPart = async (id) => {
        await db.run(INSERT.into(ZMatPlexMapping).entries(mappingRow(id)));
        await clearRecvOpMapping(db, Product, plant);
      };

      try {
        // Step 1: Check if mapping exists
        console.log(`>>> [MAPPING CHECK] Checking if Product ${Product}/${plant} has existing Plex mapping...`);
        const mapping = await db.run(
          SELECT.one.from(ZMatPlexMapping).where(mappingKey)
        );

        if (mapping) {
          console.log(`>>> [MAPPING FOUND] Product ${Product}/${plant} → Plex ID: ${mapping.PlexId}`);
        } else {
          console.log(`>>> [MAPPING NOT FOUND] Product ${Product}/${plant} has no existing mapping`);
        }

        let operation, plexId, responseData, httpExchange;
        // Build the Plex part payload from the per-plant field mapping (customizing).
        // Falls back to { number, name } when there is no mapping for the plant.
        const built = await buildPlexPartRequestBody({ Product, ProductDescription, Plant: plant, db });
        const requestBody = built.payload;
        if (built.unavailable.length) {
          exchangeNotes = { unavailableFields: built.unavailable, substituteValues: [] };
        }

        // [PLEX-PART-CODES] La tipologia rimasta senza codice si DICHIARA nel log di scambio.
        // Non e' un errore e non degrada l'esito — la part esce comunque, con la stringa di
        // sempre — ma senza questa riga «configurazione mancante» e «configurazione giusta»
        // sarebbero indistinguibili guardando un invio riuscito.
        if (built.typeCodeMissing) {
          exchangeNotes = { ...(exchangeNotes || {}), missingPlexTypeCode: built.typeCodeMissing };
        }

        // ================================================================
        // [PLEX-PART-CODES] Lo stato prodotto viaggia SOLO IN CREAZIONE (feature 0022, DEC-65).
        // ================================================================
        // Lo stato configurato per il plant e' lo stato con cui una part NASCE. Rimandarlo a ogni
        // aggiornamento significherebbe riscrivere uno stato che qualcuno ha cambiato a mano su
        // Plex, e quello e' il lato del quale Plex e' padrone: la part vive la'.
        //
        // E' una deroga voluta a 0006 RB-02 («lo stesso body per PUT e POST»), ed e' il motivo per
        // cui il corpo di creazione e' una variabile a se': `createBody` va usato — E LOGGATO —
        // sui due soli rami POST, 'CREATE' e 'CREATE (fallback)'. Il PUT resta su `requestBody`.
        //
        // Un `status` mappato a mano su ZPlexFieldMap e' gia' dentro `requestBody`, quindi
        // continua a viaggiare anche in PUT e VINCE su questo: e' il comportamento di oggi e non
        // si tocca (0004 RB-17). La scheda «Codici Plex» lo dichiara con un avviso.
        const createBody = (built.partStatus && requestBody.status === undefined)
          ? { ...requestBody, status: emitCode(built.partStatus.code) }
          : requestBody;

        // ================================================================
        // [IS-SOURCE] (V1, FR-21) La lettura SAP non è riuscita: NIENTE VIENE INVIATO A PLEX.
        // Prima si procedeva col fallback { number, name }, cioè si mandava a Plex un
        // contenuto costruito su un'assenza non verificata. Qui siamo PRIMA di qualunque
        // chiamata verso Plex, quindi l'esito è applicativo (status 'E' + riga di log) e non
        // un req.error: un req.error rollerebbe indietro anche le righe di log.
        // ================================================================
        if (!built.ok) {
          // [LOG-MSG-I18N] I motivi del fallimento vengono dalle sorgenti d'area e sono testo
          // tecnico: la frase e' nostra e tradotta, l'elenco dei motivi viaggia avvolto.
          const messageSegments = [
            logMsg.seg('logMatSapReadFailed'),
            logMsg.technical(built.failures.join(' | '))
          ];
          const msg = i18nMessages.render(messageSegments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
          console.error(`>>> [IS-SOURCE] ${Product}/${plant}: ${msg}`);
          const now = new Date();
          const day = now.toISOString().split('T')[0];
          const time = now.toTimeString().split(' ')[0];
          const logRow = {
            Product,
            Counter: nextCounter,
            SentDate: day,
            SentTime: time,
            Status: 'E',
            Message: msg.substring(0, 255),
            MessageJson: logMsg.pack(messageSegments)
          };
          await db.run(INSERT.into(ZMatExcLogPOS).entries({
            ...logRow,
            Plant: logPlant,                       // [MAT-LOG-PLANT]
            RequestJson: JSON.stringify({
              timestamp: now.toISOString(), method: 'NONE', url: '', headers: {}, body: null,
              notes: { unavailableFields: built.unavailable, substituteValues: [], readFailures: built.failures }
            }),
            ResponseJson: JSON.stringify({ status: 0, statusText: 'Not sent', headers: {}, responseTime: 0, body: { error: msg } }),
            ResponseStatus: 0
          }));
          const hdrKey = { Product, Plant: logPlant };   // [MAT-LOG-PLANT]
          const existing = await db.run(SELECT.one.from(ZMatExcLogHDR).where(hdrKey));
          if (existing) await db.run(UPDATE(ZMatExcLogHDR).set(logRow).where(hdrKey));
          else await db.run(INSERT.into(ZMatExcLogHDR).entries({ ...hdrKey, ...logRow }));
          // [W1-03] Non si e' inviato niente a Plex: il passo del ricevimento non e'
          // nemmeno partito, e va dichiarato tale invece di lasciare il campo assente.
          return { success: false, operation: 'ERROR', plexId: null, message: msg,
            messageJson: logMsg.pack(messageSegments),   // [LOG-MSG-I18N] vedi il ramo di successo
            receivingOperation: recvOpRules.RECV_STATE.NOT_REQUIRED };
        }

        // ================================================================
        // [MAT-SCOPE] IL MATERIALE E' IN PERIMETRO? (feature 0050)
        //
        // E' il gate ESATTO, e sta qui perche' `sendProductToPlex` e' l'unico punto del progetto
        // che scrive su `/mdm/v1/parts` (a parte la sonda usa-e-getta): copre da solo i suoi tre
        // chiamanti — l'invio massivo, il job `MAT_SYNC` e il tasto della scheda dettaglio.
        //
        // DOPO `!built.ok`, e l'ordine e' una decisione: con la lettura SAP caduta la causa da
        // dichiarare e' quella, che e' piu' a monte e piu' precisa. Un «non ha categoria» su un
        // materiale che non si e' riusciti a leggere manderebbe a correggere il customizing.
        //
        // NESSUNA RIGA DI STORICO, come per i due gate qui sopra: verso Plex non e' partito
        // niente, e DEC-96 e' esplicita — un gate di customizing non lascia riga. Il conteggio
        // non si perde: il job lo dichiara nel recap, la lista in `productScope`.
        //
        // ESITO APPLICATIVO E NON `req.error`: il job propaga questo ritorno nella sua riga di
        // recap, e un'eccezione uscirebbe come testo tecnico non tradotto (DEC-92).
        // ================================================================
        if (built.scopeVerdict && built.scopeVerdict.sendable === false) {
          const segs = [logMsg.seg(matScope.msgKeyOf(built.scopeVerdict.reason), Product, plant)];
          const msg = i18nMessages.render(segs, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
          console.warn(`>>> [MAT-SCOPE] ${Product}/${plant} NON inviato (${built.scopeVerdict.reason}): ${msg}`);
          return {
            success: false, operation: 'ERROR', plexId: null, message: msg,
            messageJson: logMsg.pack(segs),
            receivingOperation: recvOpRules.RECV_STATE.NOT_REQUIRED,
            // [MAT-SCOPE] Il job lo legge per contare separatamente «non in perimetro» da «invio
            // fallito»: sono due cose diverse, e sommarle farebbe sembrare rotto un customizing
            // che sta funzionando.
            outOfScope: built.scopeVerdict.reason
          };
        }

        console.log(`>>> [REQUEST BODY] Plex API request:`, JSON.stringify(requestBody, null, 2));

        // ================================================================
        // [MAT-PLANT-PAIR] La PUT di aggiornamento, in una funzione sola.
        //
        // Serviva a un ramo (mapping presente) e ora ne serve a due: dalla 0039 anche il
        // riaggancio di una part gia' su Plex PROSEGUE con l'aggiornamento. Vedi il blocco
        // `existingPlexId` piu' sotto per il perche'.
        // ================================================================
        const putPart = async (id) => {
          console.log(`>>> [PLEX API] Calling PUT ${partsApiUrl}/${id}`);
          const { requestJson, startTime } =
            await captureHttpExchange('PUT', `${partsApiUrl}/${id}`, headers, JSON.stringify(requestBody));
          const response = await fetch(`${partsApiUrl}/${id}`, {
            method: 'PUT', headers, body: JSON.stringify(requestBody)
          });
          const exchange = await finalizeHttpExchange(requestJson, startTime, response);
          console.log(`>>> [PLEX RESPONSE] UPDATE status: ${response.status}`);
          return { response, exchange };
        };

        // [MAT-PLANT-PAIR] Il mapping e' stato riagganciato ma l'aggiornamento NON e' riuscito:
        // la part su Plex resta con i dati che aveva. E' un'attenzione, non un successo.
        let restoredNotUpdated = false;

        // ================================================================
        // [PART-DUPLICATE] «La part su Plex ESISTE con questo id»: si riaggancia il dizionario E si
        // aggiorna. In un punto solo.
        //
        // Questo blocco era scritto DUE volte — il ramo `existingPlexId` e il recupero da DUPLICATE
        // — identiche a meno del testo di log, e il ramo di ripiego dopo un `404` ne avrebbe voluta
        // una terza. Non e' un riordino estetico: e' che il 14/09/2026 quel terzo ramo, invece di
        // copiarlo, LANCIAVA, e il materiale 025032052001 / plant 07 si e' fermato con l'id della
        // part che occupa il numero gia' scritto dentro il rifiuto di Plex. Tre copie divergono,
        // una no.
        //
        // Non si azzera MAI il dizionario di ricevimento: `saveMappingForNewPart` e' per una part
        // NUOVA, e qui la part esiste da prima. Il ramo `404` lo ha gia' azzerato per conto suo, ed
        // e' corretto la' — vedi il commento del suo call site.
        //
        // Assegna le `let` dell'action (`operation`, `plexId`, `responseData`, `httpExchange`,
        // `restoredNotUpdated`), cosi' i tre chiamanti non ripetono nemmeno quello.
        // ================================================================
        const rehookAndUpdate = async (id, why) => {
          console.log(`>>> [DB INSERT] Restoring mapping (${why}): Product ${Product}/${plant} → Plex ID ${id}`);
          await db.run(INSERT.into(ZMatPlexMapping).entries(mappingRow(id)));

          plexId = id;
          responseData = { id };
          console.log(`>>> [MAPPING RESTORED] Product ${Product}/${plant} → Plex ID ${id}, ora aggiorno i dati SAP`);

          const { response, exchange } = await putPart(id);
          httpExchange = exchange;
          if (response.ok) {
            operation = 'UPDATE (restored)';
            responseData = await response.json().catch(() => ({ id }));
          } else {
            // Non si rilancia: la part esiste e il mapping ora e' corretto, quindi il prossimo
            // invio riprende dal ramo UPDATE normale. Quello che non si fa e' dichiararlo riuscito.
            operation = 'EXISTING';
            restoredNotUpdated = true;
            console.warn(`>>> [MAT-PLANT-PAIR] ${Product}/${plant}: mapping riagganciato (${why}) ma PUT`
              + ` fallita (HTTP ${response.status}): i dati SAP non sono stati propagati`);
          }
        };

        // ================================================================
        // [PART-DUPLICATE] Un POST di part RIFIUTATO, per tutti e due i POST di questa action.
        //
        // E' L'UNICO punto di questo file che lancia su una creazione di part fallita, e non e' un
        // dettaglio di forma: finche' erano due, uno leggeva il corpo del rifiuto e l'altro no.
        // Plex, quando il numero e' gia' preso, mette l'id della part che lo occupa dentro
        // `errors[].metadata.id` — il rifiuto CONTIENE la risposta. Il ramo che la buttava via
        // fermava il materiale, e il suo invio successivo rifaceva lo stesso giro.
        //
        // «Non lo so» non diventa «non c'e'»: se l'id non e' dichiarato, o e' ambiguo, si lancia
        // com'e' sempre stato — il verdetto sta in srv/lib/plexDuplicateRules.js, con il suo test.
        // ================================================================
        const recoverOrThrowOnCreate = async (response, exchange, why) => {
          // Il corpo gia' parsato da `finalizeHttpExchange`: non si rilegge la response (l'altro
          // ramo lo faceva con `.text()`, ed era la seconda lettura dello stesso corpo).
          const errorBody = exchange.responseJson.body;
          const duplicateId = plexDuplicateRules.duplicateIdOf(errorBody);

          if (!duplicateId) {
            const rendered = typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody);
            throw new Error(`CREATE failed: HTTP ${response.status} - ${rendered}`);
          }

          console.log(`>>> [DUPLICATE RECOVERY] Part ${Product}/${plant} exists on Plex with ID:`
            + ` ${duplicateId} (${why}), saving mapping`);
          await rehookAndUpdate(duplicateId, why);
        };

        if (mapping) {
          // ATTEMPT UPDATE
          console.log(`>>> Product ${Product} has Plex mapping ${mapping.PlexId}, attempting UPDATE`);
          const { response: updateResponse, exchange: updateExchange } = await putPart(mapping.PlexId);

          if (updateResponse.status === 404) {
            // Disallineamento! Parte eliminata da Plex
            console.log(`>>> UPDATE failed with 404 - Part deleted from Plex, fallback to CREATE`);

            // Delete stale mapping
            // [MAT-PLANT-PAIR] Solo la riga di QUESTA coppia: la part e' sparita dal tenant di
            // questo plant, non da quelli degli altri. Senza il plant nel `where` un 404 su un
            // plant cancellerebbe il dizionario di tutti — e nessuno leggerebbe mai il conteggio
            // di righe toccate che la DELETE restituisce.
            console.log(`>>> [DB DELETE] Removing stale mapping for Product ${Product}/${plant}`);
            await db.run(DELETE.from(ZMatPlexMapping).where(mappingKey));
            // [W1-03] Con la part se ne sono andate anche le sue part-operation: il dizionario
            // del ricevimento va cancellato QUI, insieme a questo. Se sopravvivesse, la part
            // ricreata resterebbe per sempre senza operazione di ricevimento, perche' il passo
            // vedrebbe la riga e concluderebbe «gia' fatto».
            await clearRecvOpMapping(db, Product, plant);

            // Fallback to CREATE
            console.log(`>>> [PLEX API] Calling POST ${partsApiUrl} (fallback)`);

            // [PLEX-PART-CODES] Ramo di CREAZIONE: `createBody`, non `requestBody`. La part era
            // stata cancellata da Plex e qui rinasce, quindi lo stato di nascita va rimesso.
            // Anche la cattura del log usa createBody, cosi' il RequestJson dice il vero.
            const { requestJson: createFallbackRequestJson, startTime: createFallbackStartTime } =
              await captureHttpExchange('POST', partsApiUrl, headers, JSON.stringify(createBody));

            const createResponse = await fetch(partsApiUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(createBody)
            });

            const createFallbackExchange = await finalizeHttpExchange(createFallbackRequestJson, createFallbackStartTime, createResponse);
            console.log(`>>> [PLEX RESPONSE] CREATE (fallback) status: ${createResponse.status}`);

            if (!createResponse.ok) {
              // ============================================================
              // [PART-DUPLICATE] Il `404` sulla PUT diceva «la part non c'e' piu'», ma il numero
              // puo' essere occupato da un'ALTRA part: e' il caso che
              // srv/lib/plexPartCatalog.js chiama «numero presente con un altro id», cioe' una
              // part rifatta a mano o dopo un azzeramento del tenant. Succede, ed e' successo il
              // 14/09/2026 su 025032052001 / plant 07.
              //
              // Qui si lanciava e basta, mentre il POST gemello piu' sotto riagganciava: due
              // reazioni opposte allo stesso rifiuto, e quella rotta era proprio quella su cui
              // `PART-ALIVE` manda il reinvio. Ora la decisione e' una.
              //
              // Il dizionario di ricevimento e' gia' stato azzerato sopra, insieme al mapping
              // stantio, ed e' GIUSTO anche su questo ramo: la part a cui ci si riaggancia e'
              // un'altra, quindi quella riga puntava alla part-operation della part sparita. Il
              // passo [W1-03] rilegge da Plex prima di creare (srv/lib/recvOpStep.js, passo 4),
              // quindi il costo e' una GET in piu' e non una part-operation doppia.
              // ============================================================
              await recoverOrThrowOnCreate(createResponse, createFallbackExchange,
                'numero gia\' occupato dopo un 404 sulla PUT');

            } else {
              responseData = await createResponse.json();
              plexId = responseData.id;
              operation = 'CREATE (fallback)';
              httpExchange = createFallbackExchange;
              console.log(`>>> [PLEX RESPONSE] Part created with ID: ${plexId}`);
              console.warn(`⚠️  WARNING: Part was deleted from Plex, successfully recreated with new ID: ${plexId}`);

              // Save new mapping
              console.log(`>>> [DB INSERT] Saving new mapping: Product ${Product}/${plant} → Plex ID ${plexId}`);
              // [PART-ALIVE] La part e' NUOVA (ricreata dopo un 404): il dizionario del ricevimento va
              // azzerato con lei. Qui e' gia' stato fatto sopra, insieme alla cancellazione del mapping
              // stantio; passare da qui rende quel passo indipendente da quello.
              await saveMappingForNewPart(plexId);
            }

          } else if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            throw new Error(`UPDATE failed: HTTP ${updateResponse.status} - ${errorText}`);
          } else {
            responseData = await updateResponse.json();
            plexId = mapping.PlexId;
            operation = 'UPDATE';
            httpExchange = updateExchange;
            console.log(`>>> [PLEX RESPONSE] Part updated successfully, Plex ID: ${plexId}`);

            // Update timestamp
            console.log(`>>> [DB UPDATE] Updating timestamp for mapping: Product ${Product}/${plant}`);
            await db.run(UPDATE(ZMatPlexMapping)
              .set({ UpdatedAt: new Date().toISOString() })
              .where(mappingKey)
            );
          }

        } else {
          // No local mapping — check if part already exists on Plex via list parts API
          const listPartsUrl = `${plexUrl}/inventory/v1/inventory-definitions/parts?partNumber=${encodeURIComponent(Product)}`;
          console.log(`>>> [PLEX API] Checking if part exists: GET ${listPartsUrl}`);

          let existingPlexId = null;
          let listHttpExchange = null;
          try {
            const { requestJson: listRequestJson, startTime: listStartTime } =
              await captureHttpExchange('GET', listPartsUrl, headers, null);
            const listResponse = await fetch(listPartsUrl, { method: 'GET', headers });
            listHttpExchange = await finalizeHttpExchange(listRequestJson, listStartTime, listResponse);

            if (listResponse.ok) {
              // Use the body already parsed by finalizeHttpExchange
              const listData = listHttpExchange.responseJson.body;
              // Handle both array and { data: [...] } response formats
              const parts = Array.isArray(listData) ? listData : (listData.data || listData.results || []);
              console.log(`>>> [PLEX RESPONSE] List parts status: ${listResponse.status}, count: ${parts.length}, raw: ${JSON.stringify(listData).substring(0, 500)}`);
              // Match by partNumber/number against SAP Product
              const matchedPart = parts.find(p =>
                (p.number || p.partNumber || '').toUpperCase() === Product.toUpperCase()
              );
              if (matchedPart) {
                existingPlexId = matchedPart.partId || matchedPart.id;
                console.log(`>>> [PLEX FOUND] Part ${Product} matched on Plex with ID: ${existingPlexId}`);
              } else if (parts.length > 0) {
                console.log(`>>> [PLEX MISMATCH] Found ${parts.length} parts but none match ${Product}. First: ${JSON.stringify(parts[0]).substring(0, 200)}`);
              }
            } else {
              console.log(`>>> [PLEX RESPONSE] List parts failed: ${listResponse.status} - ${JSON.stringify(listHttpExchange.responseJson.body)}`);
            }
          } catch (listErr) {
            console.log(`>>> [PLEX LIST ERROR] ${listErr.message}, proceeding with CREATE`);
          }

          if (existingPlexId) {
            // ================================================================
            // [MAT-PLANT-PAIR] La part c'e' gia' su Plex: si riaggancia E SI AGGIORNA.
            //
            // Fino alla 0039 questo ramo ripristinava il solo mapping e usciva con
            // `operation = 'EXISTING'`, cioe' senza propagare NIENTE — ed era un esito `'S'`, che il
            // delta legge come «inviato». Il materiale spariva quindi dal delta con i dati vecchi su
            // Plex, finche' non cambiava di nuovo in SAP (RB-05 della 0006, dichiarato come caso
            // raro di disallineamento).
            //
            // Con il plant in chiave quel caso raro diventa il PERCORSO NORMALE: al primo invio dopo
            // il rilascio nessuna coppia ha un mapping, quindi l'intero perimetro passerebbe di qui
            // e risulterebbe «inviato» senza esserlo. Non e' una toppa di transizione: e' la
            // chiusura di RB-05, e vale da qui in avanti per ogni riaggancio.
            //
            // Un aggiornamento fallito NON annulla il riaggancio — il mapping e' comunque la verita'
            // su cosa esiste su Plex — ma degrada l'esito e lo dichiara con le parole di sempre
            // («mapping ripristinato, dati NON aggiornati»).
            // ================================================================
            // [PART-ALIVE] La RIGA e' nuova, la PART no: `saveMappingForNewPart` qui sarebbe
            // sbagliata, e `rehookAndUpdate` non la chiama mai. La part esiste da prima e la sua
            // operazione di ricevimento con lei — azzerare il dizionario la farebbe ricreare su una
            // part che ce l'ha gia'. E' l'opposto del ramo di ripiego dopo il `404`, dove la part a
            // cui ci si riaggancia e' un'ALTRA e quell'azzeramento e' invece corretto.
            await rehookAndUpdate(existingPlexId, 'part gia\' presente sul tenant');

          } else {
            // Part not found via list — CREATE
            console.log(`>>> No mapping and no existing part found, creating new Part in Plex`);
            console.log(`>>> [PLEX API] Calling POST ${partsApiUrl}`);

            // [PLEX-PART-CODES] Ramo di CREAZIONE: `createBody`, non `requestBody`. E' la nascita
            // della part, quindi e' l'unico momento in cui lo stato configurato viene spedito.
            const { requestJson: createRequestJson, startTime: createStartTime } =
              await captureHttpExchange('POST', partsApiUrl, headers, JSON.stringify(createBody));

            const createResponse = await fetch(partsApiUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(createBody)
            });

            const createExchange = await finalizeHttpExchange(createRequestJson, createStartTime, createResponse);
            console.log(`>>> [PLEX RESPONSE] CREATE status: ${createResponse.status}`);

            if (!createResponse.ok) {
              console.log(`>>> [CREATE ERROR] Status: ${createResponse.status},`
                + ` body type: ${typeof createExchange.responseJson.body}`);
              // [PART-DUPLICATE] Stessa decisione dell'altro POST, e ora e' letteralmente la
              // stessa riga. Plex ci ha appena detto quale part occupa quel numero, quindi da qui
              // in poi e' un aggiornamento normale; se non lo ha detto, si lancia.
              // `saveMappingForNewPart` NON viene usata: la riga e' nuova, la part no.
              await recoverOrThrowOnCreate(createResponse, createExchange,
                'numero gia\' occupato, senza mapping locale');
            } else {
              responseData = await createResponse.json();
              plexId = responseData.id;
              operation = 'CREATE';
              httpExchange = createExchange;
              console.log(`>>> [PLEX RESPONSE] Part created with ID: ${plexId}`);

              // Save mapping
              console.log(`>>> [DB INSERT] Saving new mapping: Product ${Product}/${plant} → Plex ID ${plexId}`);
              // [PART-ALIVE] Part NUOVA: la riga di dizionario e l'azzeramento di quello del
              // ricevimento sono una cosa sola (vedi `saveMappingForNewPart`). La posizione conta —
              // QUI, nella sotto-diramazione in cui la creazione e' RIUSCITA: non in cima al ramo,
              // che contiene anche il recupero da DUPLICATE, dove la part non e' nuova, ne' sul ramo
              // in cui la lettura per numero e' FALLITA, che e' un'assenza non verificata.
              await saveMappingForNewPart(plexId);
            }
          }
        }

        // ================================================================
        // [W1-03] Passo accessorio: operazione di RICEVIMENTO sulla part (BBP §7.3.4).
        //
        // Gira QUI, dopo che la part e' su Plex e prima del log, perche' ha bisogno del
        // `plexId` e perche' il suo esito entra nella riga di log dello stesso invio.
        //
        // Un solo innesto copre i TRE canali: dettaglio materiale, invio massivo a chunk e job
        // MAT_SYNC passano tutti da questa action (0006 RB-13, RB-16).
        //
        // Non e' gatato su `operation === 'CREATE'`: lo decide il DIZIONARIO
        // (ZMatRecvOpMapping), che copre anche 'CREATE (fallback)' ed 'EXISTING' — due rami in
        // cui la part su Plex esiste ma la sua operazione puo' non esserci.
        // ================================================================
        const recvOp = await runReceivingOpStep({
          product: Product, plant, plexId, baseUnit: built.baseUnit,
          plexPartType: built.plexPartType, baseUrl: plexUrl, consumerKey, db
        });

        // Lo stato dell'invio: il ricevimento puo' DEGRADARE a 'W', mai portare a 'E'. La part
        // e' uscita su Plex, e un passo accessorio non tinge di rosso l'operazione principale
        // (DEC-38). Per la stessa ragione `ResponseStatus` piu' sotto resta quello della part:
        // e' il semaforo «HTTP nnn» del cockpit.
        //
        // A degradare e' il solo `ERROR`, cioe' una chiamata partita e non riuscita. Un
        // `NO_CONFIG` — unita' di misura senza riga di ricevimento — NON degrada: l'unita' di
        // misura non e' un dato della part su Plex, vive sul componente della distinta, quindi
        // non e' qualcosa che manchi alla part appena inviata (DEGRADING_STATES in
        // srv/lib/recvOpRules.js).
        const isFallback = operation === 'CREATE (fallback)';
        const recvDegrades = recvOpRules.degradesSend(recvOp.state);
        // [MAT-PLANT-PAIR] Il terzo motivo di attenzione: mapping riagganciato ma aggiornamento non
        // riuscito. Senza di lui quel caso uscirebbe 'S', e 'S' con la data di oggi fa uscire la
        // coppia dal delta — cioe' la part resterebbe con i dati vecchi e nessuno tornerebbe a
        // guardarla finche' il materiale non cambia in SAP.
        const logStatus = (isFallback || recvDegrades || restoredNotUpdated) ? 'W' : 'S';
        // [LOG-MSG-I18N] Le due chiavi c'erano gia' — questo era il solo ramo di log localizzato del
        // progetto — ma il testo veniva RESO ALLA SCRITTURA, quindi la lingua era quella di chi
        // aveva lanciato l'invio: dal cockpit italiano, dal job MAT_SYNC inglese, sulla stessa
        // colonna. Ora viaggiano come segmenti e la lingua la decide chi guarda.
        //
        // Il messaggio del ricevimento si accoda solo quando c'e' qualcosa da dire: un NOT_REQUIRED
        // non deve cambiare di una virgola la riga di log di prima della feature. E' avvolto in
        // `verbatim` e non in `technical`: e' prosa NOSTRA non ancora passata da i18n — una lacuna
        // dichiarata, non un testo di terzi. Chiuderla vuol dire convertire srv/lib/recvOpStep.js e
        // srv/lib/recvOpRules.js, che hanno i loro messaggi.
        const messageSegments = [
          // [MAT-PLANT-PAIR] `logMatAlreadyOnPlex` dice gia' la cosa giusta — «mapping ripristinato,
          // dati NON aggiornati» — ed e' la stessa frase che il recap del job usa da sempre: qui
          // vale ora solo quando la PUT del riaggancio non e' riuscita.
          isFallback ? logMsg.seg('partDeletedRecreated')
            : restoredNotUpdated ? logMsg.seg('logMatAlreadyOnPlex', plexId)
              : logMsg.seg('dataSentCorrectly'),
          ...((recvDegrades || recvOp.uomChanged) ? [logMsg.verbatim(recvOp.message)] : [])
        ];
        const messageJson = logMsg.pack(messageSegments);
        const logText = i18nMessages
          .render(messageSegments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE)
          .slice(0, 255);

        // SUCCESS - Log to ZMatExcLogPOS (append)
        console.log(`>>> [DB INSERT] Logging success to ZMatExcLogPOS - Counter: ${nextCounter}`);
        const now = new Date();

        // [W1-03] La traccia del passo accessorio e' una chiave ADDITIVA dentro i due JSON, non
        // una riga di log a se': ZMatExcLogPOS ha UNO scambio per tentativo, non un array di
        // step come il flusso ordini, e (Product, Counter) e' chiave.
        // Le due colonne sono String(4000) e il payload della part le riempie gia' parecchio:
        // se la nota non ci sta, si OMETTE. Meglio perdere l'accessorio che troncare il JSON
        // principale, che e' cio' che il cockpit apre nei due CodeEditor.
        const requestJsonString = withReceivingNote(httpExchange.requestJson, recvOp, 'request');
        const responseJsonString = withReceivingNote(httpExchange.responseJson, recvOp, 'response');

        await db.run(INSERT.into(ZMatExcLogPOS).entries({
          Product,
          Plant: logPlant,            // [MAT-LOG-PLANT]
          Counter: nextCounter,
          SentDate: now.toISOString().split('T')[0],
          SentTime: now.toTimeString().split(' ')[0],
          Status: logStatus,
          Message: logText,
          MessageJson: messageJson,   // [LOG-MSG-I18N]
          RequestJson: requestJsonString,
          ResponseJson: responseJsonString,
          ResponseStatus: httpExchange.responseJson.status
        }));

        // SUCCESS - Update ZMatExcLogHDR (upsert last send)
        const hdrKeyOk = { Product, Plant: logPlant };   // [MAT-LOG-PLANT]
        const existingHdr = await db.run(
          SELECT.one.from(ZMatExcLogHDR).where(hdrKeyOk)
        );

        if (existingHdr) {
          console.log(`>>> [DB UPDATE] Updating ZMatExcLogHDR for Product ${Product}`);
          await db.run(UPDATE(ZMatExcLogHDR).set({
            Counter: nextCounter,
            SentDate: now.toISOString().split('T')[0],
            SentTime: now.toTimeString().split(' ')[0],
            Status: logStatus,
            Message: logText,
            MessageJson: messageJson
          }).where(hdrKeyOk));
        } else {
          console.log(`>>> [DB INSERT] Creating ZMatExcLogHDR for Product ${Product}`);
          await db.run(INSERT.into(ZMatExcLogHDR).entries({
            ...hdrKeyOk,
            Counter: nextCounter,
            SentDate: now.toISOString().split('T')[0],
            SentTime: now.toTimeString().split(' ')[0],
            Status: logStatus,
            Message: logText,
            MessageJson: messageJson
          }));
        }

        console.log(`>>> Product ${Product} sent successfully (${operation}), Plex ID: ${plexId}`
          + `, ricevimento: ${recvOp.state}`);

        return {
          success: true,
          operation,
          plexId,
          message: getLocalizedMessage(req, 'dataSentCorrectly', 'marsplm-sap2plex'),
          // [LOG-MSG-I18N] I SEGMENTI escono dall'action, serializzati (feature 0031). Il job
          // MAT_SYNC li propaga nella propria riga di recap: senza, componeva quella riga attorno a
          // `message`, che una chiamata SENZA richiesta HTTP — cioe' quella del job — rende in
          // inglese, mentre il cockpit la rende in italiano.
          messageJson,
          // [W1-03] Additivo: `success` resta l'esito della PART. Chi vuole distinguere legge
          // questo campo — il job MAT_SYNC lo usa per la propria riga di recap.
          receivingOperation: recvOp.state,
          // [RECV-OP-DRIFT] Con quale strada il disallineamento e' stato risolto: `PUT`
          // (ripuntamento della part-operation esistente) o `CREATE+DEACTIVATE` (ripiego). Vuoto
          // quando non c'era niente da riallineare. E' l'unica cosa che dice se il tenant accetta
          // il ripuntamento, che il contratto Plex non garantisce, e per questo esce dall'action
          // invece di restare nel JSON del log di un materiale solo (feature 0044).
          receivingRealignWay: recvOp.way || ''
        };

      } catch (error) {
        console.error(`>>> [ERROR] Sending Product ${Product} failed:`, error.message);
        console.error(`>>> [ERROR] Stack trace:`, error.stack);

        // ERROR - Log to ZMatExcLogPOS (append)
        console.log(`>>> [DB INSERT] Logging error to ZMatExcLogPOS - Counter: ${nextCounter}`);
        const now = new Date();

        // [PART-DUPLICATE] La richiesta VERA che e' caduta, non una ricostruita a indovinare.
        // `lastRequestJson` porta gia' metodo, URL, corpo e header mascherati della chiamata che
        // stava per partire; il ripiego vale solo per un fallimento che precede ogni chiamata
        // verso Plex (lettura SAP, customizing), dove una richiesta non c'e' mai stata — e la'
        // dichiara l'indirizzo e basta, senza attribuire un metodo che nessuno ha eseguito.
        const errorRequestJson = lastRequestJson
          ? { ...lastRequestJson, timestamp: lastRequestJson.timestamp || new Date().toISOString() }
          : {
            timestamp: new Date().toISOString(),
            method: '',
            url: typeof partsApiUrl !== 'undefined' ? partsApiUrl : '',
            headers: typeof headers !== 'undefined' ? { ...headers, 'X-Plex-Connect-Api-Key': '***MASKED***' } : {},
            body: {},
            ...(exchangeNotes ? { notes: exchangeNotes } : {}) // [IS-SOURCE] V2
          };

        // Build error response JSON (structured)
        const errorResponseJson = {
          status: 0,
          statusText: 'Error',
          headers: {},
          responseTime: 0,
          body: {
            error: error.message,
            stack: error.stack?.substring(0, 500)
          }
        };

        // [LOG-MSG-I18N] Un'eccezione e' testo tecnico e non si traduce: si avvolge, cosi' resta
        // leggibile dentro una cornice tradotta invece di essere l'intero messaggio.
        const errSegments = [
          logMsg.seg('logMatSendFailed'),
          logMsg.technical(error.message)
        ];
        const errText = i18nMessages
          .render(errSegments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE)
          .substring(0, 255);
        const errJson = logMsg.pack(errSegments);

        await db.run(INSERT.into(ZMatExcLogPOS).entries({
          Product,
          Plant: logPlant,            // [MAT-LOG-PLANT]
          Counter: nextCounter,
          SentDate: now.toISOString().split('T')[0],
          SentTime: now.toTimeString().split(' ')[0],
          Status: 'E',
          Message: errText,
          MessageJson: errJson,
          RequestJson: JSON.stringify(errorRequestJson),
          ResponseJson: JSON.stringify(errorResponseJson),
          ResponseStatus: 0
        }));

        // ERROR - Update ZMatExcLogHDR (upsert last send)
        const hdrKeyErr = { Product, Plant: logPlant };   // [MAT-LOG-PLANT]
        const existingHdr = await db.run(
          SELECT.one.from(ZMatExcLogHDR).where(hdrKeyErr)
        );

        if (existingHdr) {
          console.log(`>>> [DB UPDATE] Updating ZMatExcLogHDR with error for Product ${Product}`);
          await db.run(UPDATE(ZMatExcLogHDR).set({
            Counter: nextCounter,
            SentDate: now.toISOString().split('T')[0],
            SentTime: now.toTimeString().split(' ')[0],
            Status: 'E',
            Message: errText,
            MessageJson: errJson
          }).where(hdrKeyErr));
        } else {
          console.log(`>>> [DB INSERT] Creating ZMatExcLogHDR with error for Product ${Product}`);
          await db.run(INSERT.into(ZMatExcLogHDR).entries({
            ...hdrKeyErr,
            Counter: nextCounter,
            SentDate: now.toISOString().split('T')[0],
            SentTime: now.toTimeString().split(' ')[0],
            Status: 'E',
            Message: errText,
            MessageJson: errJson
          }));
        }

        return {
          success: false,
          operation: 'ERROR',
          plexId: null,
          message: error.message,
          messageJson: errJson,       // [LOG-MSG-I18N]
          // [W1-03] L'invio della part e' fallito: il passo accessorio non e' stato
          // raggiunto. Il prossimo tentativo lo eseguira', perche' il dizionario e' vuoto.
          receivingOperation: recvOpRules.RECV_STATE.NOT_REQUIRED
        };
      }
    });


    // Upload part attribute to Plex via the Part_Attribute_Upload Data Source.
    // [PLEX-CONN] L'identificativo NON e' piu' un numero letterale qui dentro: sta nell'elenco
    // unico con la sua variabile PLEX_DS_PART_ATTRIBUTE, come gli altri sei (feature 0020).
    // TEMPORARY test: Attribute_Name='Famiglia', fixed Attribute_Value 'A'.
    // Part_No must be the SAP material number (= Plex part number); the upload SP
    // resolves it internally to Part_Key. The Plex UUID does NOT work here.
    this.on('uploadPartAttribute', async (req) => {
      const { Product, Plant } = req.data;
      console.log(`>>> Uploading part attribute 'Famiglia'='A' for Product ${Product} (plant ${Plant || 'n/a'})...`);

      // [PLANT-ACCESS] Scrive sul tenant Plex del plant che il CLIENT dichiara, e non aveva nessun
      // gate (feature 0048). Qui la terna intera — attivo, licenziato, con un ruolo — perche' e' una
      // SCRITTURA verso un sistema esterno, non la lettura di un catalogo.
      //
      // PRIMA DEL `try`, e non dentro: il `catch` qui sotto trasformerebbe il rifiuto in un
      // `{ success: false }`, cioe' in un esito applicativo — e una richiesta non autorizzata non e'
      // un tentativo fallito.
      if (await rejectIfPlantNotUsable(req, Plant)) return;

      try {
        const inputs = {
          Part_No: Product,        // SAP material number = Plex part number
          Attribute_Name: 'Famiglia',
          Attribute_Value: 'A'     // fixed test value
        };
        const result = await executePlexDataSource(req, Plant, plexDataSources.DS_PART_ATTRIBUTE, inputs);
        const responseStr = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
        console.log(`>>> [UPLOAD] Part_No='${Product}' -> HTTP ${result.status} ok=${result.ok}: ${responseStr}`);

        return {
          success: result.ok,
          status: result.status,
          response: responseStr,
          message: result.ok
            ? `Attributo 'Famiglia'='A' caricato sulla part ${Product} (HTTP ${result.status})`
            : `Upload fallito per la part ${Product} (HTTP ${result.status})`
        };
      } catch (error) {
        console.error('>>> Error uploading part attribute:', error.message);
        return { success: false, status: 0, response: null, message: error.message };
      }
    });

    // Fetch available operations from Plex MDM API
    //
    // [PLEX-OP-TYPE-FILTER] Punto UNICO in cui il filtro per tipo si applica: le cinque tendine che
    // offrono il catalogo operazioni leggono tutte da qui, e cinque filtri lato client sarebbero
    // cinque punti da riallineare a mano — la stessa ragione per cui anche l'ordinamento sta qui
    // (PLEX-OP-SORT). L'ordine dei due conta: si filtra e POI si ordina, cosi' la lista consegnata
    // e' ordinata su cio' che resta.
    //
    // NESSUN req.error, e non e' distrazione: l'elenco vuoto di una lettura fallita e quello di un
    // filtro che non aggancia sono la stessa schermata, e vanno distinti DALLA SCHERMATA. Un errore
    // HTTP mette il motivo in un corpo d'errore OData che tre chiamanti su quattro non guardavano
    // nemmeno (non controllavano `res.ok`), quindi ogni esito e' un valore di ritorno con `readOk`
    // e `message`. E' la stessa forma delle action che scrivono verso Plex (DEC-11).
    this.on('getPlexOperations', async (req) => {
      const plant = (req.data.Plant || '').trim();
      const scope = opTypeFilter.normalizeScope(req.data.Scope);
      console.log(`>>> Fetching Plex operations (plant ${plant || 'n/a'}, ambito ${scope || 'nessuno'})...`);

      /** La busta, in un punto solo: nessun ramo puo' dimenticarsi un contatore. */
      const envelope = (over = {}) => ({
        operations: [],
        readOk: false,
        message: '',
        filterScope: scope,
        filterTypes: '',
        filterConfigured: false,
        total: 0,
        kept: 0,
        droppedNoType: 0,
        ...over
      });

      // ================================================================
      // [PLANT-ACCESS] Il ruolo dell'utente su questo plant (feature 0048).
      //
      // IL RIFIUTO ESCE NELLA BUSTA, non con `req.reject`, e non e' una scelta di stile: entrambi i
      // client ASSORBONO l'errore HTTP in un elenco vuoto con `message: "HTTP 403"` — la
      // configurazione plant a `_fetchScopedOperations`, il cockpit in `PlexOpsCatalog.load` —
      // quindi un messaggio localizzato non arriverebbe mai a chi guarda. La busta esiste proprio
      // perche' «elenco vuoto» ha piu' cause: questa e' una in piu'.
      //
      // SOGLIA «QUALSIASI RUOLO», e senza `Active` ne' licenza: questa tendina si usa MENTRE si
      // configura un plant, che nasce `InProgress`, e un `admin-config` e' un utente legittimo
      // della configurazione. Con la terna o con `admin` pieno le tendine si svuoterebbero
      // proprio nel caso normale.
      // ================================================================
      const roleOk = await plantRoleVerdict(req, plant);
      if (!roleOk.ok) {
        const message = getLocalizedMessage(req, roleOk.key, 'adminconfigplant', plant || '');
        console.warn(`>>> [PLANT-ACCESS] getPlexOperations rifiutata su ${plant || '(nessun plant)'}`);
        return envelope({ message });
      }

      try {
        // [PLEX-CONN] Le operazioni sono quelle del tenant DEL PLANT: senza il parametro la
        // schermata di un plant mostrerebbe le operazioni di un altro.
        const conn = await loadPlexConnection(req, plant);

        // Il filtro si legge in parallelo alla chiamata Plex: sono due letture indipendenti, e
        // aspettare la prima per cominciare la seconda aggiungerebbe latenza a ogni apertura.
        const db = await cds.connect.to('db');
        const [read, filterCfg] = await Promise.all([
          opCatalog.fetchOperations(conn),
          loadOpTypeFilterRows(plant, db)
        ]);

        if (!read.ok) {
          console.error(`>>> Error fetching Plex operations: ${read.error}`);
          return envelope({ message: read.error || 'lettura del catalogo operazioni non riuscita' });
        }

        const filter = opTypeFilter.resolveOpTypeFilter(filterCfg.rows, scope);
        const filtered = opTypeFilter.filterOperationsByType(read.operations, filter.tokens);

        if (filter.tokens.length > 0) {
          console.log(`>>> [PLEX-OP-TYPE-FILTER] plant ${plant} ambito ${filter.scope}: `
            + `filtro «${filter.value}» — ${filtered.kept.length}/${read.operations.length} operazioni`
            + `${filtered.droppedNoType ? `, ${filtered.droppedNoType} senza tipo` : ''}`);
        }

        return envelope({
          // [PLEX-OP-SORT] Si ordina DOPO il map (che normalizza `code: op.code || op.number`) e
          // dopo il filtro. Qui e' il punto unico: le cinque schermate che aprono questo elenco lo
          // ricevono gia' filtrato e ordinato, e restano coerenti fra loro.
          operations: sortPlexOperations(filtered.kept),
          readOk: true,
          filterTypes: filter.value,
          filterConfigured: filter.configured,
          total: read.operations.length,
          kept: filtered.kept.length,
          droppedNoType: filtered.droppedNoType
        });
      } catch (error) {
        // Ci si arriva con un plant senza riga di connessione (fail-closed dichiarato di DEC-52):
        // il messaggio e' gia' localizzato da loadPlexConnection.
        console.error('>>> Error fetching Plex operations:', error.message);
        return envelope({ message: error.message });
      }
    });

    // Fetch available workcenters from Plex Production API
    this.on('getPlexWorkcenters', async (req) => {
      const plant = (req.data.Plant || '').trim();
      console.log(`>>> Fetching Plex workcenters (plant ${plant || 'n/a'})...`);

      // [PLANT-ACCESS] Come le operazioni, ma con `req.reject` (feature 0048): questa action rende
      // un `array of` NUDO, senza busta, quindi non c'e' nessun campo in cui mettere un motivo. E i
      // suoi due client srotolano gia' `data.error.message` per mostrarlo — la riga [ROUTE-KEY] che
      // ognuno ha, messa la' proprio perche' un errore inghiottito diventava un popover vuoto.
      if (await rejectIfNoPlantRole(req, plant)) return;

      try {
        // [PLEX-CONN] Stessa ragione delle operazioni: i centri di lavoro sono del tenant del plant.
        const { baseUrl: plexUrl, consumerKey } = await loadPlexConnection(req, plant);

        const headers = {
          'Accept': 'application/json',
          'X-Plex-Connect-Api-Key': consumerKey
        };

        const workcentersUrl = `${plexUrl}/production/v1/production-definitions/workcenters`;
        console.log('>>> Calling Plex Workcenters API:', workcentersUrl);

        const response = await fetch(workcentersUrl, {
          method: 'GET',
          headers
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const data = await response.json();
        const workcenters = Array.isArray(data) ? data : (data.value || data.results || []);
        console.log(`>>> Plex Workcenters: received ${workcenters.length} workcenters`);
        if (workcenters.length > 0) {
          console.log('>>> Raw Plex workcenters sample:', JSON.stringify(workcenters[0]).substring(0, 300));
        }

        return workcenters.map(wc => ({
          id: wc.workcenterId || wc.id || '',
          workcenterCode: wc.workcenterCode || wc.code || '',
          name: wc.name || '',
          workcenterType: wc.workcenterType || '',
          workcenterGroup: wc.workcenterGroup || ''
        }));
      } catch (error) {
        console.error('>>> Error fetching Plex workcenters:', error.message);
        req.error(500, error.message);
      }
    });

    // ================================================================
    // Create a Plex Job for a SINGLE SAP production order (manual trigger).
    // Reuses the batch job logic in srv/jobs/createPlexProductionOrders.js so the
    // exact same code path is exercised, and records the outcome in the delta
    // table ZProdOrderPlexMapping + exchange logs ZProdOrderExcLogHDR/POS.
    // ================================================================
    // Feature 0014 / D-04 — tetto di attesa del solo passo 8 (ordinamento della lista di
    // lavoro) NELL'AZIONE MANUALE: il tetto sta dove c'e' un utente in attesa, come
    // PLEX_SPLIT_TIMEOUT_MS. Da configurare su CF, mai in .env (DEC-30). Con 0 il tetto
    // sparirebbe anche qui: non farlo.
    const JOB_SORT_TIMEOUT_MS = Number(process.env.PLEX_JOB_SORT_TIMEOUT_MS || 30000);
    // Solo per tradurre il motivo del passo 8 nella nota all'utente (M-01 + M-02…M-05, M-15):
    // le regole restano nel modulo puro, qui c'e' la sola scelta della chiave i18n.
    const jobSortRules = require('./lib/plexJobSortRules');
    // [JOB-SORT-SPLIT] Lo stesso passo serve allo SPACCHETTAMENTO, che non passa da `processOrder`:
    // la dipendenza si inietta in `prepareSplit` piu' sotto, e queste due const stanno a livello di
    // impl proprio perche' i due punti d'uso le condividano (un secondo tetto di attesa, o un
    // secondo require, sarebbero due valori da riallineare a mano).
    const { runJobSortStep } = require('./lib/plexJobSort');

    /**
     * [ORDER-SORT-ON-WRITE] L'esito dell'ordinamento nei due campi ADDITIVI `sortStatus`/`sortNote`
     * delle action (feature 0014 FR-22). Erano due copie — invio e spacchettamento — e il
     * riallineamento della quantita' ne avrebbe fatta una terza: le tre divergerebbero alla prima
     * correzione.
     *
     * La nota c'e' solo su un ordinamento FALLITO, e `noteKey` la sceglie il chiamante perche' la
     * frase dice cosa e' successo PRIMA: «l'ordine e' stato inviato» (`jobSortNoteHeader`) e «lo
     * spacchettamento non va ripetuto» (`splitJobSortNote`) sono false su un esito in errore e su un
     * riallineamento, e la' va `jobSortNoteNeutral`, che non afferma niente sull'operazione.
     */
    const sortFieldsOf = (req, sort, noteKey) => {
      if (sort && sort.state === 'OK') return { sortStatus: 'S', sortNote: '' };
      if (sort && sort.state === 'KO') {
        const reason = jobSortRules.reasonMessageKey(sort);
        const reasonText = getLocalizedMessage(req, reason.key, 'marsplm-sap2plex', ...reason.params);
        return {
          sortStatus: 'E',
          sortNote: getLocalizedMessage(req, noteKey, 'marsplm-sap2plex', reasonText)
        };
      }
      return { sortStatus: '', sortNote: '' };
    };

    this.on('createJobInPlex', async (req) => {
      const { ManufacturingOrder } = req.data;
      console.log(`>>> createJobInPlex: ManufacturingOrder=${ManufacturingOrder}`);

      if (!ManufacturingOrder || String(ManufacturingOrder).trim() === '') {
        return req.error(400, 'ManufacturingOrder is mandatory', 'ManufacturingOrder');
      }

      // Reuse the standalone job's per-order logic (importable now that the script guards its
      // bootstrap behind require.main === module). La connessione la risolve
      // loadPlexConnection col plant dell'ordine (feature 0020).
      const { processOrder, writeMappingAndLog, toIso } = require('./jobs/createPlexProductionOrders');
      // [ORDER-QTY-SYNC] Il percorso mirato per gli ordini spacchettati (feature 0033) e il writer
      // condiviso dello storico, che qui scrive l'operazione `QTY`.
      const orderQtySync = require('./lib/orderQtySync');
      const excLog = require('./lib/prodOrderExcLog');
      const { plexGet, plexPost, plexPut } = require('./jobs/lib/plexJobsClient');

      const db = await cds.connect.to('db');
      const s4 = await prodOrderSource(); // [IS-SOURCE]
      const { A_ProductionOrder_2 } = s4.entities;

      // Load the single SAP order (same columns the batch selects / processOrder needs).
      let order = null;
      let sapReadError = null;
      try {
        order = await s4.run(
          SELECT.one.from(A_ProductionOrder_2)
            .columns(
              ...PROD_ORDER_HEAD_COLUMNS,
              // [ORDER-STATUS-FILTER] I campi citati dai criteri configurati, che possono andare
              // oltre quelli fissi qui sopra. Unione su tutti i plant: il plant dell'ordine si
              // conosce solo dopo questa lettura.
              ...(await prodOrderStatusColumns(db, PROD_ORDER_HEAD_COLUMNS))
            )
            .where({ ManufacturingOrder })
        );
      } catch (e) {
        sapReadError = e.message;
        console.error(`>>> createJobInPlex: SAP read failed for ${ManufacturingOrder}:`, e.message);
      }

      // SAP unreachable → still record an error outcome (exercises persistence path).
      if (sapReadError) {
        const outcome = {
          status: 'E',
          message: `SAP read failed: ${sapReadError}`,
          steps: [{ step: 'read SAP order', request: { ManufacturingOrder }, status: 0, response: sapReadError }],
          plex: {}
        };
        try { await writeMappingAndLog(db, { ManufacturingOrder }, outcome); } catch (_) { /* best-effort */ }
        // Feature 0014: nessun passo 8 su questo ramo (la sequenza non parte), quindi i due
        // campi additivi tornano vuoti — «non previsto o non eseguito» (C-1).
        return {
          success: false, status: 'E', jobId: '', jobNumber: '', message: outcome.message,
          messageCode: '', sortStatus: '', sortNote: ''
        };
      }

      // Order genuinely absent (SAP reachable) → 404, nothing recorded.
      if (!order) {
        return req.error(404, `Production order ${ManufacturingOrder} not found in SAP`);
      }

      // Block jobs for orders of non-active plants.
      if (await rejectIfPlantNotUsable(req, order.ProductionPlant)) return;

      // ================================================================
      // [ORDER-QTY-SYNC] ORDINE SPACCHETTATO: non piu' un rifiuto, ma il RIALLINEAMENTO DELLA
      // QUANTITA' (feature 0033, che sostituisce il gate FR-32 della 0012).
      //
      // FR-32 rifiutava la ri-sincronizzazione manuale di un ordine spacchettato, e la ragione era
      // giusta: `processOrder` riporterebbe il lotto principale alla quantita' PIENA dell'ordine
      // mentre i pacchetti continuano a esistere con la loro, cioe' piu' quantita' in produzione di
      // quella ordinata. Cio' che mancava non era il rifiuto — era la formula: al lotto principale
      // va la quantita' SAP MENO la somma dei pacchetti vivi.
      //
      // Quindi qui non si chiama `processOrder` ma il percorso MIRATO, che tocca la sola testata
      // del lotto principale e non riallinea distinta ne' operazioni: su un ordine spacchettato
      // quelle vivono sui pacchetti, e il divieto della RB-28 resta intatto.
      //
      // Il gate sta DOPO il controllo di plant/licenza (un ordine spacchettato su un plant fuori
      // perimetro riceve comunque il 400 del plant, che e' la risposta piu' specifica) e ora anche
      // DOPO la risoluzione delle credenziali, perche' stavolta verso Plex si parla davvero.
      // ================================================================
      const splitRow = await db.run(
        SELECT.one.from('avvaleplm.marsplm.sap2plex.ZProdOrderSplit')
          .where({ ManufacturingOrder, IsSplit: true })
      );

      // ================================================================
      // [ORDER-STATUS-FILTER] (feature 0017) Perimetro per stato, sull'ordine appena letto.
      // Nessuna chiamata verso Plex, esito `W` e riga nello storico, perché è un'azione umana e chi
      // ha premuto il pulsante deve trovare scritto perché non è successo niente.
      //
      // [ORDER-QTY-SYNC] STA PRIMA DEL RAMO DELLO SPACCHETTAMENTO, e dalla 0033 non è più una
      // sottigliezza di presentazione: quel ramo ora SCRIVE su Plex. Un ordine uscito dal perimetro
      // — non più rilasciato, cancellato, chiuso — non deve vedersi riallineare la quantità del
      // lotto in fabbrica, e il perimetro è il primo filtro di tutto ciò che parte.
      //
      // Fino alla 0032 l'ordine era l'opposto, per una ragione che è caduta con la 0033: il cockpit
      // riconosceva il rifiuto da spacchettamento anche per ESCLUSIONE (`status W` + nessun job
      // number + ordine spacchettato), quindi un `W` emesso qui su un ordine spacchettato veniva
      // mostrato con il testo dell'altro gate. Quel ripiego è stato rimosso
      // (ProdOrderSplit.mixin.js, `_isSplitResyncRejection`) e il caso non si presenta più.
      // ================================================================
      const scopeGate = await checkProdOrderInScope(req, db, order);
      if (!scopeGate.ok) {
        console.log(`>>> [ORDER-STATUS-FILTER] createJobInPlex: ordine ${ManufacturingOrder} fuori`
          + ` perimetro (${scopeGate.code}), nessuna chiamata verso Plex`);
        try {
          await writeMappingAndLog(db, order, {
            status: 'W',
            message: scopeGate.message,
            steps: [{
              // [W1-09] Il passo non nomina più il solo stato: il perimetro comprende ora anche
              // tipo ordine e responsabile di schedulazione, e `reason` dice quale dei tre.
              step: 'gate perimetro ordini (0017/W1-09)',
              request: { ManufacturingOrder, plant: order.ProductionPlant, reason: scopeGate.code },
              status: 0,
              response: 'nessuna chiamata verso Plex'
            }],
            plex: {}
          }, { skipMapping: true });
        } catch (logErr) {
          console.error(`>>> createJobInPlex: storico non scritto per ${ManufacturingOrder}: ${logErr.message}`);
        }
        return {
          success: false, status: 'W', jobId: '', jobNumber: '',
          message: scopeGate.message, messageCode: scopeGate.code,
          // Feature 0014: l'ordine non viene elaborato, quindi nessun passo 8 (FR-04, BR-37).
          sortStatus: '', sortNote: ''
        };
      }

      // [PLEX-CONN] Connessione del plant DELL'ORDINE: `order.ProductionPlant` e' gia' letto da
      // SAP e gia' usato dal gate di perimetro poche righe sopra.
      let creds;
      try {
        creds = await resolvePlexConnection(order.ProductionPlant, { db });
      } catch (e) {
        return req.error(400, e instanceof PlexConnectionMissing
          ? getLocalizedMessage(req, 'plexConnNotConfigured', 'adminconfigplant', e.plant)
          : e.message);
      }

      // ================================================================
      // [ORDER-QTY-SYNC] Il ramo dell'ordine SPACCHETTATO (feature 0033): si riallinea la QUANTITA'
      // del lotto principale e basta. Vedi il blocco di commento poco sopra, dove il gate FR-32
      // stava prima.
      // ================================================================
      if (splitRow) {
        const mappingRows = await db.run(
          SELECT.from('avvaleplm.marsplm.sap2plex.ZProdOrderPlexMapping')
            .columns('ManufacturingOrder', 'PlexJobNumber', 'PlexJobId', 'SplitState')
            .where({ ManufacturingOrder })
        );
        // [PLEX-CALL] La stessa etichetta del flusso di invio: le due tracce si leggono insieme, in
        // `cf logs` e nella console del cockpit (`window.plexCalls()`).
        const tracedPlex = plexCallTrace.wrap({
          get: (p) => plexGet(creds, p),
          post: (p, b) => plexPost(creds, p, b),
          put: (p, b) => plexPut(creds, p, b)
        }, { order: ManufacturingOrder, root: creds.baseUrl, tag: 'PLEX-CALL' });

        // [ORDER-SORT-ON-WRITE] Se il riallineamento scrive su Plex, la lista di lavoro si riordina:
        // e' la stessa regola del job. La configurazione si legge a ogni invocazione (`db`) e il
        // tetto e' quello dell'utente in attesa, come per l'invio.
        const sort = async (steps) => runJobSortStep({
          creds,
          plant: order.ProductionPlant,
          db,
          steps,
          timeoutMs: JOB_SORT_TIMEOUT_MS
        });

        let qty;
        try {
          qty = await orderQtySync.syncOrderQuantity({ plex: tracedPlex, sort }, {
            order,
            sapDueDate: toIso(order.MfgOrderPlannedEndDate),
            mappingRows,
            jobTypeFallback: process.env.PLEX_JOB_TYPE || null
          });
        } catch (err) {
          console.error(`>>> [ORDER-QTY-SYNC] createJobInPlex ${ManufacturingOrder}: ${err.message}`);
          qty = {
            status: 'E',
            segments: [logMsg.technical(err.message)],
            steps: [{ step: 'exception', request: null, status: 0, response: err.message }],
            written: false, jobId: null
          };
        }

        // Storico dell'ordine: operazione `QTY`, e NON `writeMappingAndLog` — la testata deve
        // continuare a dire com'e' andato l'ultimo INVIO del job, e il dizionario non si tocca.
        try {
          await excLog.appendProdOrderLog(db, {
            order: ManufacturingOrder,
            operation: excLog.OPERATION.QTY,
            status: qty.status,
            segments: qty.segments,
            steps: qty.steps
          });
        } catch (logErr) {
          console.error(`>>> createJobInPlex: storico non scritto per ${ManufacturingOrder}: ${logErr.message}`);
        }

        return {
          success: qty.status === 'S',
          status: qty.status,
          jobId: qty.jobId || '',
          jobNumber: ManufacturingOrder,
          message: i18nMessages.render(
            logMsg.normalize(qty.segments), i18nMessages.COCKPIT_APP, localeOf(req)
          ),
          // Il cockpit riconosce da qui che si e' trattato di un riallineamento e non di un invio.
          messageCode: 'orderQtySync',
          // [ORDER-SORT-ON-WRITE] Vuoti quando non e' partita nessuna scrittura (gia' allineato,
          // calcolo rifiutato, PUT rifiutato con risposta). La nota e' quella NEUTRA: non e' stato
          // inviato un ordine e non e' stato spacchettato niente.
          ...sortFieldsOf(req, qty.sort, 'jobSortNoteNeutral')
        };
      }

      // Run the create-job flow; always persist the outcome (success OR error) so the
      // job code + persistence are verified end-to-end even if Plex is unreachable.
      let outcome;
      try {
        // Feature 0014: la configurazione di ordinamento NON viene pre-risolta qui — nell'azione
        // manuale si risolve a ogni invocazione (FDD §2.6), con la cache + TTL del modulo e
        // l'invalidazione esplicita al salvataggio, cosi' una modifica appena salvata si vede
        // subito. Il tetto di attesa e' quello dell'utente in attesa (D-04).
        // [ORDER-BOM-ADD] `manual: true` — dietro questa chiamata c'e' una persona che ha premuto
        // «Crea Job in Plex». L'unico effetto e' il prevolo della distinta al passo 2bis, che qui
        // NON blocca la creazione: e' l'utente a decidere di inviare, e cio' che non si e' potuto
        // collocare si dichiara con un esito `W`. Il job pianificato non lo passa e resta
        // bloccante, perche' la' nessuno puo' prendere quella decisione.
        outcome = await processOrder(creds, s4, order, {
          db, sortTimeoutMs: JOB_SORT_TIMEOUT_MS, manual: true
        });
      } catch (err) {
        console.error(`>>> createJobInPlex: processOrder failed for ${ManufacturingOrder}:`, err.message);
        outcome = {
          status: 'E',
          message: err.message,
          steps: [
            { step: 'exception', request: null, status: 0, response: err.message },
            // [ORDER-SORT-ON-WRITE] Un'eccezione dopo una scrittura porta con se' l'ordinamento che
            // `processOrder` ha chiesto: nello storico, e nei due campi della risposta.
            ...((err && Array.isArray(err.sortSteps)) ? err.sortSteps : [])
          ],
          plex: {},
          sort: (err && err.sort) || null
        };
      }

      try {
        await writeMappingAndLog(db, order, outcome);
      } catch (logErr) {
        console.error(`>>> createJobInPlex: writeMappingAndLog failed for ${ManufacturingOrder}:`, logErr.message);
      }

      // ================================================================
      // Feature 0014 / FR-22 — esito del passo 8 in due campi ADDITIVI, INDIPENDENTI da
      // `status`: il tipo del messaggio mostrato all'utente continua a dipendere solo
      // dall'esito dell'INVIO (FR-20). `sortNote` e' vuota quando il passo 8 e' riuscito, non
      // era previsto o non e' stato eseguito: la UI la concatena senza conoscere i casi.
      // [ORDER-SORT-ON-WRITE] Su un esito in ERRORE la nota e' quella neutra: `jobSortNoteHeader`
      // dice «l'ordine e' stato inviato … non verra' rielaborato», falso proprio li'.
      // ================================================================
      const { sortStatus, sortNote } = sortFieldsOf(
        req, outcome.sort, outcome.status === 'E' ? 'jobSortNoteNeutral' : 'jobSortNoteHeader'
      );

      return {
        success: outcome.status === 'S',
        status: outcome.status,
        jobId: outcome.plex?.jobId || '',
        jobNumber: outcome.plex?.jobNumber || '',
        // [LOG-MSG-I18N] Reso nella lingua della RICHIESTA e non nello snapshot. `outcome.message`
        // e' in italiano per costruzione — e' il testo che finisce in database e nel recap — ma
        // questo campo il cockpit lo mostra subito in un MessageBox, quindi qui la lingua giusta e'
        // quella di chi ha premuto il tasto. Su un esito senza segmenti resta lo snapshot.
        message: outcome.segments?.length
          ? i18nMessages.render(outcome.segments, i18nMessages.COCKPIT_APP, localeOf(req))
          : outcome.message,
        // Valorizzato solo dove esiste una chiave stabile: oggi il solo ramo FR-32.
        messageCode: '',
        sortStatus,
        sortNote
      };
    });


    // ================================================================
    // FEATURE 0012 — Spacchettamento di un ordine di produzione su Plex.
    //
    // Due action e un solo punto d'ingresso (FR-01): la finestra del cockpit operativo sul
    // dettaglio ordine. L'orchestrazione sta in srv/lib/plexJobSplit.js e le regole in
    // srv/lib/splitRules.js: qui restano le VERIFICHE PRELIMINARI (le uniche che possono
    // usare req.error, TD-4) e la traduzione dell'esito nel payload del contratto.
    //
    // TD-4 — dopo P0 l'action non usa MAI req.error: dentro un'action esiste un request
    // context e un req.error rollerebbe indietro anche le righe di log, cioè proprio la
    // traccia dello stato residuale su cui si basa l'intera sanatoria di FR-26. Da lì in poi
    // si restituisce sempre 200 con un esito applicativo (status S/W/E + riga della matrice).
    // ================================================================
    const SPLIT_APP = 'marsplm-sap2plex';
    // Un codice pacchetto ('1000123-0001') NON è un ordine: il trattino non passa (FR-04).
    const SPLIT_ORDER_RE = /^[0-9A-Z]{1,12}$/;
    // Tutte con default, nessuna obbligatoria; da configurare su CF, mai in .env (DEC-30).
    const SPLIT_QTY_DECIMALS = Number(process.env.PLEX_SPLIT_QTY_DECIMALS || 3);
    const SPLIT_TIMEOUT_MS = Number(process.env.PLEX_SPLIT_TIMEOUT_MS || 60000);
    const SPLIT_LOCK_TTL_MS = Number(process.env.PLEX_SPLIT_LOCK_TTL_MS || 300000);
    const SPLIT_MAX_CODE_PROBES = Number(process.env.PLEX_SPLIT_MAX_CODE_PROBES || 20);

    /**
     * Verifiche preliminari comuni alle due action (passi A1…A4 del TDD §3.5). Restituisce
     * `{ order, deps }` oppure `null` quando ha già risposto con un errore OData: nessuna di
     * queste risposte lascia effetti, né su Plex né in locale.
     */
    async function prepareSplit(req, { requireQuantity = false, traceForm } = {}) {
      const { ManufacturingOrder, Mode, Quantity } = req.data;

      // --- A1: forma della richiesta ---------------------------------------------
      const order = String(ManufacturingOrder || '').trim();
      if (!order || !SPLIT_ORDER_RE.test(order)) {
        req.error(400, 'ManufacturingOrder is mandatory and must match ^[0-9A-Z]{1,12}$ (a package code is not an order)', 'ManufacturingOrder');
        return null;
      }
      if (requireQuantity) {
        const q = Number(Quantity);
        if (Quantity === null || Quantity === undefined || Quantity === '' || !Number.isFinite(q)) {
          req.error(400, `Quantity is mandatory when Mode is ${Mode}`, 'Quantity');
          return null;
        }
      }

      // --- A2: lettura dell'ordine SAP, STESSE colonne di createJobInPlex ---------
      const db = await cds.connect.to('db');
      const s4 = await prodOrderSource(); // [IS-SOURCE]
      const { A_ProductionOrder_2 } = s4.entities;
      let sapOrder = null;
      let sapReadError = null;
      try {
        sapOrder = await s4.run(
          SELECT.one.from(A_ProductionOrder_2)
            .columns(
              ...PROD_ORDER_HEAD_COLUMNS,
              // [ORDER-STATUS-FILTER] I campi citati dai criteri configurati (feature 0017).
              ...(await prodOrderStatusColumns(db, PROD_ORDER_HEAD_COLUMNS))
            )
            .where({ ManufacturingOrder: order })
        );
      } catch (e) {
        sapReadError = e.message;
        console.error(`>>> [SPLIT] lettura SAP fallita per l'ordine ${order}: ${e.message}`);
      }
      // SAP irraggiungibile NON è "ordine assente": è un esito applicativo, così che il
      // tentativo resti tracciato (contratto §6.2).
      if (sapReadError) return { sapReadError, order };
      if (!sapOrder) {
        req.error(404, `Production order ${order} not found in SAP`);
        return null;
      }

      // --- A3: perimetro plant + licenza, choke-point unico riusato (DEC-08) ------
      if (await rejectIfPlantNotUsable(req, sapOrder.ProductionPlant)) return null;

      // --- A3a: [ORDER-STATUS-FILTER] perimetro per STATO (feature 0017) ----------
      // Lo spacchettamento crea lotti su Plex, quindi rientra in pieno nel perimetro. Qui è un
      // `req.error` e non l'esito `W` di createJobInPlex: siamo ancora nelle verifiche
      // preliminari, prima di P0, dove req.error è ammesso e non c'è nulla da rollare (TD-4).
      // È esattamente la forma del gate di plant una riga più sopra.
      const statusGate = await checkProdOrderInScope(req, db, sapOrder);
      if (!statusGate.ok) {
        console.log(`>>> [ORDER-STATUS-FILTER] splitProdOrder: ordine ${order} fuori perimetro`
          + ` (${statusGate.code})`);
        req.error(400, statusGate.message);
        return null;
      }

      // --- A3b: identità dell'utente, parte del requisito (FR-03, FR-27) ---------
      const user = req.user?.id || req.user?.attr?.email || null;
      if (!user) {
        req.error(403, 'User identity cannot be determined: the split is traced by user');
        return null;
      }

      // --- A4: [PLEX-CONN] connessione del plant dell'ordine ----------------------
      // `sapOrder.ProductionPlant` è già stato usato dal gate di plant in A3.
      const { plexGet, plexPost, plexPut } = require('./jobs/lib/plexJobsClient');
      let creds;
      try {
        creds = await resolvePlexConnection(sapOrder.ProductionPlant, { db });
      } catch (e) {
        req.error(400, e instanceof PlexConnectionMissing
          ? getLocalizedMessage(req, 'plexConnNotConfigured', 'adminconfigplant', e.plant)
          : e.message);
        return null;
      }

      const { writeMappingAndLog, loadOrderDetails, alignJobOperationsAndBom } =
        require('./jobs/createPlexProductionOrders');

      // Timeout esplicito su TUTTE le chiamate dello spacchettamento (TD-6): i job restano
      // invariati, perché il parametro è opzionale e loro non lo passano.
      const opts = { timeoutMs: SPLIT_TIMEOUT_MS };
      // [SPLIT-TRACE] Porta UNICA verso Plex di tutto lo spacchettamento: avvolgerla qui traccia
      // richiesta e risposta sia dell'apertura della finestra sia della sequenza P0…P6, senza
      // toccare plexJobSplit.js e senza aggiungere nessuna chiamata.
      // [ORDER-BOM-ADD] Estratta in una const perché la usa anche `addBom` qui sotto: due client
      // diversi sullo stesso spacchettamento darebbero due tracce, e una delle due sparirebbe.
      const tracedPlex = plexCallTrace.wrap({
        get: (path) => plexGet(creds, path, opts),
        post: (path, body) => plexPost(creds, path, body, opts),
        put: (path, body) => plexPut(creds, path, body, opts)
      }, { order, root: creds.baseUrl, ...(traceForm ? { form: traceForm } : {}) });
      const deps = {
        db,
        plex: tracedPlex,
        // [JOB-BUILDING] Chiave della cache dei building: è PER TENANT, e dalla 0020 il tenant è
        // per plant. Una cache globale servirebbe i building di un altro cliente.
        plexTenant: creds.baseUrl,
        localize: (key, params) => getLocalizedMessage(req, key, SPLIT_APP, ...(params || [])),
        writeMappingAndLog,
        loadOrderDetails: (o) => loadOrderDetails(s4, o),
        align: (o, steps, jobNumber) => alignJobOperationsAndBom(creds, o, steps, jobNumber),
        // [ORDER-BOM-ADD] P5a: i componenti che l'ODP ha in piu' rispetto al ciclo standard nella
        // distinta DEL PACCHETTO. Il piano si calcola UNA volta per ordine e si riusa su tutti i
        // pacchetti: nascono dalla stessa part e hanno gli stessi componenti, quindi ricalcolarlo
        // sarebbe una coppia di letture Plex per pacchetto con lo stesso risultato.
        addBom: async (o, bomSteps, jobId, jobNumber, partId) => {
          if (!o._bomAddPlan) {
            o._bomAddPlan = await orderBomAdd.planPartBomAdditions({
              creds, plexGet: tracedPlex.get, db, order: o, partId, steps: bomSteps,
              // Qui il prevolo non e' MAI un gate — vedi il commento sotto — e il suo messaggio
              // finisce nella riga P5a di un pacchetto che ESISTE: con la coda bloccante quella
              // riga diceva «Nessun job creato» accanto al codice del pacchetto appena creato.
              blocking: false
            });
          }
          const plan = o._bomAddPlan;
          // Un prevolo fallito NON annulla il pacchetto: qui il job esiste gia' e il gate «se
          // fallisce non si crea» vale per la creazione dell'ordine, non per lo spacchettamento di
          // un lotto che e' gia' in produzione. Si dichiara e basta.
          if (!plan.ok) {
            return { ok: false, created: 0, failures: plan.failures, message: plan.message };
          }
          return orderBomAdd.applyJobBomAdditions({
            plexGet: tracedPlex.get,
            plexPost: tracedPlex.post,
            jobId,
            jobNumber,
            plan: plan.plan,
            steps: bomSteps
          });
        },
        // [JOB-SORT-SPLIT] P7: l'ordinamento della lista di lavoro Plex (feature 0014) dopo la
        // creazione di un pacchetto e dopo «Ripristina». Closure come `align` e `addBom`, e per la
        // stessa ragione: `plexJobSplit.js` non vede `creds` e non deve vederle. Restituisce una
        // forma GIA' pronta da registrare, cosi' l'orchestrazione non deve conoscere il vocabolario
        // del passo 8 — stati, motivi, chiavi i18n restano di chi li possiede.
        //
        // La configurazione NON si pre-risolve: si passa `db` e `runJobSortStep` legge
        // `ZPlexJobSortConfig` a ogni invocazione, con la sua cache + TTL e l'invalidazione al
        // salvataggio, cosi' una riga appena modificata si vede subito. La pre-risoluzione per
        // esecuzione serve al job pianificato, che elabora N ordini e deve essere spiegabile con una
        // sola configurazione.
        //
        // Il tetto di attesa e' `JOB_SORT_TIMEOUT_MS` e non `SPLIT_TIMEOUT_MS`: e' un altro canale
        // (Data Source, non Connect API), ha gia' la sua leva, e il tetto sta dove c'e' un utente
        // che aspetta (D-04). La chiamata non passa da `plexCallTrace.wrap`, che avvolge il client
        // Connect API: come il passo 8, non compare in `window.plexCalls()` — la sua traccia e' il
        // passo P7 piu' la riga `>>> [PLEX DS] POST …` nel log.
        sort: async (plant) => {
          const sortSteps = [];
          const outcome = await runJobSortStep({
            creds, plant, db, steps: sortSteps, timeoutMs: JOB_SORT_TIMEOUT_MS
          });
          return {
            outcome,
            step: sortSteps[0] || null,
            reasonText: jobSortRules.sortReasonText(outcome)
          };
        },
        user,
        decimals: SPLIT_QTY_DECIMALS,
        lockTtlMs: SPLIT_LOCK_TTL_MS,
        maxCodeProbes: SPLIT_MAX_CODE_PROBES,
        now: () => new Date(),
        uuid: () => cds.utils.uuid(),
        // [LOG-MSG-I18N] La lingua della richiesta, per `LastMessage` delle righe pacchetto:
        // `plexJobSplit.js` non ha `req` e non deve averlo, quindi il locale gli arriva come
        // dipendenza — la stessa forma con cui riceve `now` e `uuid`.
        locale: localeOf(req)
      };
      return { order: sapOrder, deps };
    }

    /**
     * Descrizione del materiale: costa una lettura in più verso S/4 perché
     * A_ProductionOrder_2 non la porta (contratto C-7). È BEST-EFFORT: in caso di errore
     * torna stringa vuota, mai un null mascherato da descrizione.
     */
    async function readMaterialDescription(req, material) {
      if (!material) return '';
      try {
        const S4Product = await productSource(); // [IS-SOURCE]
        const { A_ProductDescription } = S4Product.entities;
        const language = req.headers?.['accept-language']?.substring(0, 2)?.toUpperCase() || 'EN';
        const row = await S4Product.run(
          SELECT.one.from(A_ProductDescription).columns('ProductDescription')
            .where({ Product: material, Language: language })
        );
        if (row?.ProductDescription) return row.ProductDescription;
        const any = await S4Product.run(
          SELECT.one.from(A_ProductDescription).columns('ProductDescription').where({ Product: material })
        );
        return any?.ProductDescription || '';
      } catch (e) {
        console.warn(`>>> [SPLIT] descrizione del materiale ${material} non risolvibile: ${e.message}`);
        return '';
      }
    }

    /** Involucro d'esito comune alle due action (contratto §3.2). */
    function splitEnvelope(result) {
      return {
        status: result.status,
        row: result.row || '',
        // `messageKey` è il nome interno in plexJobSplit.js; sul filo si chiama messageCode.
        messageCode: result.messageKey || '',
        messageParams: result.messageParams || [],
        message: result.message || ''
      };
    }

    // ----------------------------------------------------------------
    // Lettura: tutto ciò che serve ad aprire la finestra (contratto §3)
    // ----------------------------------------------------------------
    this.on('getProdOrderSplitInfo', async (req) => {
      const prepared = await prepareSplit(req);
      if (!prepared) return;                       // req.error già emesso
      if (prepared.sapReadError) {
        return {
          status: 'E', row: '', messageCode: 'splitUnexpectedError',
          messageParams: [String(prepared.sapReadError)],
          message: getLocalizedMessage(req, 'splitUnexpectedError', SPLIT_APP, prepared.sapReadError),
          ManufacturingOrder: prepared.order, MainJobFound: false, CanSplit: false,
          OfferedCommand: 'NONE', QuantityDecimals: SPLIT_QTY_DECIMALS, packages: []
        };
      }

      const { order, deps } = prepared;
      const { readSplitInfo } = require('./lib/plexJobSplit');
      const materialDescription = await readMaterialDescription(req, order.Material);
      const result = await readSplitInfo(deps, { order, materialDescription });
      const out = { ...splitEnvelope(result), ...result.data };
      // [SPLIT-TRACE] L'esito che esce verso il browser. Senza questa riga, di una finestra che si
      // apre in errore restava solo l'effetto a schermo: quale ramo di readSplitInfo ha risposto,
      // e con quale dettaglio, non era leggibile da nessuna parte.
      console.log(`>>> [SPLIT-TRACE] getProdOrderSplitInfo ${out.ManufacturingOrder}: `
        + `status=${out.status} messageCode=${out.messageCode || '(nessuno)'} `
        + `messageParams=${JSON.stringify(out.messageParams || [])} `
        + `MainJobFound=${out.MainJobFound} MainJobQuantity=${out.MainJobQuantity} `
        + `PackageCount=${out.PackageCount} CanSplit=${out.CanSplit} `
        + `OfferedCommand=${out.OfferedCommand}`);
      return out;
    });

    // ----------------------------------------------------------------
    // Scrittura: spacchetta, oppure sana un caso residuale (contratto §4)
    // ----------------------------------------------------------------
    this.on('splitProdOrderJob', async (req) => {
      const { Mode, PackageJobNumber } = req.data;
      const mode = String(Mode || '').trim();
      const { isValidMode, MODES } = require('./lib/splitRules');
      if (!isValidMode(mode)) {
        return req.error(400, `Mode is mandatory and must be one of ${Object.values(MODES).join(', ')}`, 'Mode');
      }

      const prepared = await prepareSplit(req, { requireQuantity: mode === MODES.SPLIT });
      if (!prepared) return;                       // req.error già emesso
      if (prepared.sapReadError) {
        return {
          status: 'E', row: 'A', messageCode: 'splitUnexpectedError',
          messageParams: [String(prepared.sapReadError)],
          message: getLocalizedMessage(req, 'splitUnexpectedError', SPLIT_APP, prepared.sapReadError),
          ManufacturingOrder: prepared.order, IsSplit: false, PackageCount: 0,
          ResidualOpen: false, OfferedCommand: 'NONE', CodeChanged: false, steps: []
        };
      }

      const { order, deps } = prepared;
      const split = require('./lib/plexJobSplit');

      // C-1 — verifica OTTIMISTICA del pacchetto: il server risolve comunque da sé il caso
      // residuale (ne può esistere uno solo, FR-26), il parametro serve solo a impedire che
      // una finestra rimasta aperta a lungo sani un caso diverso da quello che ha letto.
      if (mode !== MODES.SPLIT && PackageJobNumber) {
        const residual = await split.findOpenResidual(deps, order.ManufacturingOrder);
        if (!residual || residual.PlexJobNumber !== String(PackageJobNumber).trim()) {
          return req.error(
            400,
            `PackageJobNumber ${PackageJobNumber} does not match the open residual case of order ${order.ManufacturingOrder}`,
            'PackageJobNumber'
          );
        }
      }

      let result;
      if (mode === MODES.SPLIT) {
        result = await split.executeSplit(deps, { order, quantityRaw: req.data.Quantity });
      } else if (mode === MODES.COMPLETE) {
        result = await split.executeComplete(deps, { order });
      } else {
        result = await split.executeRestore(deps, { order });
      }

      // `steps` esce in forma COMPATTA: nessun payload Plex, nessun header, nessuna
      // credenziale (DEC-10, C-3). I payload completi restano nella riga di storico.
      const steps = (result.steps || []).map((s) => ({
        seq: s.seq,
        step: s.step,
        status: s.status,
        httpStatus: s.httpStatus || 0,
        verdict: s.verdict || '',
        message: s.message || ''
      }));
      // ================================================================
      // [JOB-SORT-SPLIT] Esito del passo P7 in due campi ADDITIVI, INDIPENDENTI da `status` e dalla
      // riga della matrice: un ordinamento fallito non cambia l'esito dello spacchettamento, che e'
      // riuscito. Stessa forma dei due campi gemelli di `createJobInPlex`, e vuoti negli stessi tre
      // casi — ordinamento non previsto per il plant, non raggiunto, o comando che non lo prevede
      // («Completa») — cosi' la finestra li accoda senza conoscere i casi.
      // Chiave PROPRIA e non `jobSortNoteHeader`: quella dice «l'ordine e' stato inviato a Plex»,
      // che non e' quello che e' accaduto qui. [ORDER-SORT-ON-WRITE] E su un esito in ERRORE — il
      // rollback compensativo, un P1 senza risposta — la neutra, perche' `splitJobSortNote` dice
      // «lo spacchettamento non va ripetuto».
      // ================================================================
      const { sortStatus, sortNote } = sortFieldsOf(
        req, result.sort, result.status === 'E' ? 'jobSortNoteNeutral' : 'splitJobSortNote'
      );

      const out ={ ...splitEnvelope(result), ...result.data, steps, sortStatus, sortNote };
      // [SPLIT-TRACE] Come sopra, sul percorso di scrittura: l'esito e la riga della matrice che
      // il dialog tradurra' in messaggio, accanto ai passi realmente eseguiti.
      console.log(`>>> [SPLIT-TRACE] splitProdOrderJob ${out.ManufacturingOrder} mode=${mode}: `
        + `status=${out.status} row=${out.row || '(nessuna)'} `
        + `messageCode=${out.messageCode || '(nessuno)'} `
        + `messageParams=${JSON.stringify(out.messageParams || [])} `
        + `passi=[${steps.map((s) => `${s.step}:${s.status}${s.httpStatus ? `/${s.httpStatus}` : ''}`).join(' ')}] `
        // [JOB-SORT-SPLIT] Lo stato del passo P7 anche quando NON ha lasciato un passo: «non
        // previsto per il plant» e «non raggiunto» sono due cose diverse, e senza questa riga
        // sarebbero la stessa assenza.
        + `sort=${result.sort ? result.sort.state : '(non eseguito)'}`);
      return out;
    });

    // ----------------------------------------------------------------
    // [SPLIT-TRACE] Sonda di sola lettura: dove si rompe la lettura del job su Plex.
    // Stesse verifiche preliminari delle due action (plant, licenza, perimetro, connessione
    // del plant), così la sonda non è una porta che scavalca i gate. Non scrive niente.
    // ----------------------------------------------------------------
    this.on('splitJobReadProbe', async (req) => {
      const probe = require('./lib/splitJobReadProbe');
      const prepared = await prepareSplit(req, { traceForm: probe.PROBE_FORM });
      if (!prepared) return;                       // req.error già emesso
      if (prepared.sapReadError) {
        return [{
          id: 'VERDETTO',
          what: `Lettura dell'ordine ${prepared.order} da SAP fallita: ${prepared.sapReadError}. `
            + 'La sonda non è stata eseguita — senza la testata non si risolve né il plant né la '
            + 'connessione Plex.',
          ok: false
        }];
      }

      const { order, deps } = prepared;
      const { readMainRow } = require('./lib/plexJobSplit');
      const mapping = await readMainRow(deps, order.ManufacturingOrder);
      return await probe.runSplitJobReadProbe(deps, {
        order: order.ManufacturingOrder,
        mapping
      });
    });

    // ----------------------------------------------------------------
    // [JOB-SCHED-PROBE] Sonda: quale campo è nullo nel backwards-schedule del passo 5.
    //
    // GATE APPLICATI: plant attivo + licenza (choke-point unico, DEC-08) e connessione Plex del
    // plant. Sono quelli che governano l'ESPOSIZIONE dei dati di un plant, ed è di quelli che una
    // sonda di lettura deve rispondere.
    //
    // GATE NON APPLICATO, DI PROPOSITO: il perimetro per stato (0017). Quel perimetro governa cosa
    // viene SCRITTO su Plex, e qui non si scrive; applicarlo renderebbe la diagnosi impossibile
    // esattamente nei casi in cui serve — un job da diagnosticare appartiene spesso a un ordine
    // che nel frattempo è uscito dal perimetro (chiuso tecnicamente, per esempio), e in quel
    // momento la domanda «perché la schedulazione fallì» resta aperta.
    // ----------------------------------------------------------------
    this.on('jobScheduleProbe', async (req) => {
      const probe = require('./lib/jobScheduleProbe');
      const order = String(req.data.ManufacturingOrder || '').trim();
      if (!order) {
        return req.error(400, 'ManufacturingOrder is mandatory', 'ManufacturingOrder');
      }

      const db = await cds.connect.to('db');
      const s4 = await prodOrderSource(); // [IS-SOURCE]
      const { A_ProductionOrder_2 } = s4.entities;

      // Testata SAP: è da qui che vengono materiale, plant e date pianificate. Il browser passa il
      // solo numero d'ordine, quindi non può puntare la sonda su un bersaglio che ha scelto lui.
      let head = null;
      try {
        head = await s4.run(
          SELECT.one.from(A_ProductionOrder_2)
            .columns(...PROD_ORDER_HEAD_COLUMNS)
            .where({ ManufacturingOrder: order })
        );
      } catch (e) {
        return [{
          id: 'VERDETTO',
          what: `Lettura dell'ordine ${order} da SAP fallita: ${e.message}. La sonda non è stata `
            + 'eseguita — senza la testata non si risolvono né il materiale né il plant né la '
            + 'connessione Plex.',
          ok: false
        }];
      }
      if (!head) return req.error(404, `Production order ${order} not found in SAP`);
      if (await rejectIfPlantNotUsable(req, head.ProductionPlant)) return;

      let creds;
      try {
        creds = await resolvePlexConnection(head.ProductionPlant, { db });
      } catch (e) {
        return req.error(400, e instanceof PlexConnectionMissing
          ? getLocalizedMessage(req, 'plexConnNotConfigured', 'adminconfigplant', e.plant)
          : e.message);
      }

      const { plexGet, plexPost, executeDataSource } = require('./jobs/lib/plexJobsClient');
      const { DS_GET_JOB_KEY, DS_GET_JOB_OPS } = require('./lib/plexDataSources');

      // [JOB-READ] L'UUID del lotto principale dal dizionario, con la stessa chiave piena dello
      // spacchettamento: la sonda legge il job per identità (DEC-80) e ripiega sul numero solo se
      // quell'id non c'è o non risponde. Best-effort: senza id la sonda resta quella di prima.
      let knownJobId = '';
      try {
        const { readMainRow } = require('./lib/plexJobSplit');
        const mapped = await readMainRow({ db }, order);
        knownJobId = (mapped && mapped.PlexJobId) || '';
      } catch (e) {
        console.warn(`>>> [JOB-READ] PlexJobId di ${order} non letto dal dizionario `
          + `(la sonda legge per numero): ${e.message}`);
      }

      return await probe.runJobScheduleProbe({
        // Tracciata come ogni altra chiamata verso Plex, con la sua forma: le letture della sonda
        // finiscono in `cf logs` e nell'anello, distinguibili da quelle d'esercizio.
        plex: plexCallTrace.wrap({
          get: (path) => plexGet(creds, path),
          post: (path, body) => plexPost(creds, path, body)
        }, { order, root: creds.baseUrl, form: probe.PROBE_FORM }),
        ds: (id, inputs) => executeDataSource(creds, id, inputs),
        dsJobKey: DS_GET_JOB_KEY,
        dsJobOps: DS_GET_JOB_OPS
      }, {
        order,
        material: head.Material,
        plant: head.ProductionPlant,
        dates: { start: head.MfgOrderPlannedStartDate, end: head.MfgOrderPlannedEndDate },
        knownJobId
      });
    });

    // ----------------------------------------------------------------
    // [PLEX-HISTORY-PROBE] Sonda: cosa rispondono oggi le due letture di storico produzione.
    //
    // Due letture per plant — production-entries e scrap-entries — su una finestra di quindici
    // minuti che finisce nell'istante dell'invocazione. Restituisce la risposta CRUDA.
    //
    // GATE APPLICATO: plant attivo + licenza, dal choke-point unico `resolveEffectivePlants`
    // (DEC-08). La sonda espone dati di produzione di un plant, ed è di quello che deve rispondere.
    // Un plant chiesto e non utilizzabile è un 403 che NOMINA i plant utilizzabili; nessun plant
    // utilizzabile è una riga 'OFF', non un errore — la sonda dichiara, non rompe.
    //
    // NESSUNA LETTURA SAP e nessuna scrittura: né su Plex, né sulle tabelle di consuntivazione, né
    // su ZJobReadWatermark. La finestra la calcola il modulo dalla `now` che gli passiamo, quindi
    // c'è un orologio solo e non dipende dallo stato del job.
    // ----------------------------------------------------------------
    this.on('plexHistoryProbe', async (req) => {
      const probe = require('./lib/plexHistoryProbe');
      const asked = String(req.data.Plant || '').trim();

      // Stesso preambolo delle altre sonde (vedi probePlexPartValues).
      const usable = [...(await resolveEffectivePlants(req))];
      if (asked && !usable.includes(asked)) {
        return req.reject(403, `Plant '${asked}' non utilizzabile per questo utente `
          + `(attivo e licenziato: ${usable.join(', ') || 'nessuno'})`);
      }
      const plants = asked ? [asked] : usable;
      if (!plants.length) {
        return [{
          id: 'OFF',
          what: 'Nessun plant utilizzabile per questo utente: nessuna lettura eseguita. '
            + 'Serve un plant attivo e coperto da licenza (feature 0001).',
          ok: false
        }];
      }

      const { plexGet } = require('./jobs/lib/plexJobsClient');
      const targets = [];
      for (const plant of plants) {
        try {
          const creds = await loadPlexConnection(req, plant);
          targets.push({
            plant,
            // Tracciata come ogni altra chiamata verso Plex: richiesta e RISPOSTA finiscono in
            // `cf logs` e nell'anello, con la forma `sonda …` che il dump d'esercizio esclude.
            // Nessun `order`: quel campo diventa il prefisso «ordine <x>» dell'etichetta, e qui
            // non c'è un ordine — passarci il plant scriverebbe una cosa falsa nel log.
            plex: plexCallTrace.wrap(
              { get: (path) => plexGet(creds, path) },
              { root: creds.baseUrl, form: probe.PROBE_FORM, tag: probe.PROBE_TAG }
            )
          });
        } catch (e) {
          // Un plant senza connessione non ferma gli altri, e la sua assenza si DICHIARA: il
          // messaggio di loadPlexConnection è già localizzato.
          targets.push({ plant, error: e.message });
        }
      }

      return await probe.runPlexHistoryProbe({ targets }, { now: new Date() });
    });
  }

  // CATALOG SERVICE - Material Filter Configuration
  // ================================================================
  // OBJECT GROUPS EDIT SERVICE - Validation for the embedded
  // adminconfigplant Groups tab (mandatory Plant/GroupId + unique per plant)
  // ================================================================
  if (this.name === 'ObjGroupEditService') {
    const { ObjectGroups } = this.entities;

    async function validateObjectGroup(req) {
      const isUpdate = req.event === 'UPDATE';
      let row = { ...req.data };

      if (isUpdate) {
        const existing = await SELECT.one.from(ObjectGroups).where({ ID: req.data.ID });
        if (existing) {
          row = { ...existing, ...req.data };
        }
      }

      const { Plant, GroupId } = row;

      if (!Plant || String(Plant).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'ogPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (Plant && !/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'ogPlantFormat', 'adminconfigplant'), 'Plant');
      }
      if (!GroupId || String(GroupId).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'ogGroupIdMandatory', 'adminconfigplant'), 'GroupId');
      }

      // Uniqueness safety-net (friendly localized message; @assert.unique.plantGroup also enforces it)
      const clash = await SELECT.one.from(ObjectGroups).where({
        Plant, GroupId,
        ID: { '!=': req.data.ID }
      });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'ogGroupAlreadyExists', 'adminconfigplant'), 'GroupId');
      }
    }

    this.before('CREATE', 'ObjectGroups', validateObjectGroup);
    this.before('UPDATE', 'ObjectGroups', validateObjectGroup);

    // [NATURAL-ORDER] Il menu di colonna della scheda «Gruppi» ordina qui, non in SQL (DEC-102).
    naturalOrderRead.install(this, 'ObjectGroups', naturalOrderDeps());
  }

  // ================================================================
  // PLEX FIELD MAP SERVICE - Validation for the adminconfigplant
  // "Plex Part Mapping" tab (mandatory Plant/PlexField + unique per plant)
  // ================================================================
  if (this.name === 'PlexFieldMapService') {
    const { ZPlexFieldMap } = this.entities;

    async function validatePlexFieldMap(req) {
      const isUpdate = req.event === 'UPDATE';
      let row = { ...req.data };
      if (isUpdate) {
        const existing = await SELECT.one.from(ZPlexFieldMap).where({ ID: req.data.ID });
        if (existing) row = { ...existing, ...req.data };
      }
      const { Plant, PlexField } = row;
      if (!Plant || String(Plant).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'pfmPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (Plant && !/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'pfmPlantFormat', 'adminconfigplant'), 'Plant');
      }
      if (!PlexField || String(PlexField).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'pfmFieldMandatory', 'adminconfigplant'), 'PlexField');
      }
      // number/name/description are always taken from SAP (MATNR/MAKTX) and cannot be mapped.
      if (LOCKED_FIELDS.has(PlexField)) {
        return req.error(400, getLocalizedMessage(req, 'pfmFieldLocked', 'adminconfigplant'), 'PlexField');
      }
      const clash = await SELECT.one.from(ZPlexFieldMap).where({ Plant, PlexField, ID: { '!=': req.data.ID } });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'pfmFieldAlreadyMapped', 'adminconfigplant'), 'PlexField');
      }
    }

    this.before('CREATE', 'ZPlexFieldMap', validatePlexFieldMap);
    this.before('UPDATE', 'ZPlexFieldMap', validatePlexFieldMap);
  }

  if (this.name === 'PlexOpFieldMapService') {
    const { ZPlexOpFieldMap } = this.entities;

    async function validatePlexOpFieldMap(req) {
      const isUpdate = req.event === 'UPDATE';
      let row = { ...req.data };
      if (isUpdate) {
        const existing = await SELECT.one.from(ZPlexOpFieldMap).where({ ID: req.data.ID });
        if (existing) row = { ...existing, ...req.data };
      }
      const { Plant, PlexField } = row;
      if (!Plant || String(Plant).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'pofPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (Plant && !/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'pofPlantFormat', 'adminconfigplant'), 'Plant');
      }
      if (!PlexField || String(PlexField).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'pofFieldMandatory', 'adminconfigplant'), 'PlexField');
      }
      // partId/operationId are always set by the send code and cannot be mapped.
      if (OP_LOCKED_FIELDS.has(PlexField)) {
        return req.error(400, getLocalizedMessage(req, 'pofFieldLocked', 'adminconfigplant'), 'PlexField');
      }
      // [PLEX-OP-TYPE] `type` non e' mappabile: lo dichiara il catalogo Plex per ogni operazione
      // (feature 0024, DEC-84). Messaggio SEPARATO da quello dei campi d'identita' perche' la
      // ragione e' un'altra, e chi legge deve capire da dove viene il valore invece di cercare la
      // riga che gli manca.
      if (OP_DERIVED_FIELDS.has(PlexField)) {
        return req.error(400, getLocalizedMessage(req, 'pofFieldDerived', 'adminconfigplant'), 'PlexField');
      }
      const clash = await SELECT.one.from(ZPlexOpFieldMap).where({ Plant, PlexField, ID: { '!=': req.data.ID } });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'pofFieldAlreadyMapped', 'adminconfigplant'), 'PlexField');
      }
    }

    this.before('CREATE', 'ZPlexOpFieldMap', validatePlexOpFieldMap);
    this.before('UPDATE', 'ZPlexOpFieldMap', validatePlexOpFieldMap);

    // ================================================================
    // [PLEX-OP-TYPE-FILTER] Filtro per TIPO delle operazioni Plex, per plant e ambito
    // (feature 0024, DEC-85). Validazione dell'ambito, normalizzazione dell'elenco e unicita'.
    // ================================================================
    const { ZPlexOpTypeFilter } = this.entities;

    async function validateOpTypeFilter(req) {
      let row = { ...req.data };
      if (req.event === 'UPDATE') {
        // Un update parziale puo' non portare tutti i campi: si valuta la riga RISULTANTE.
        const existing = await SELECT.one.from(ZPlexOpTypeFilter).where({ ID: req.data.ID });
        if (existing) row = { ...existing, ...req.data };
      }

      const { Plant } = row;
      if (!Plant || String(Plant).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'potPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'potPlantFormat', 'adminconfigplant'), 'Plant');
      }

      // L'ambito e' uno dei DUE, e si normalizza in loco: la scheda ne offre solo due e non li fa
      // digitare, ma l'URL OData non e' vincolato dalla schermata — e una riga con un ambito
      // inventato non filtrerebbe niente, restando indistinguibile da una configurazione corretta.
      const scope = opTypeFilter.normalizeScope(row.Scope);
      if (!scope) {
        return req.error(400,
          getLocalizedMessage(req, 'potScopeInvalid', 'adminconfigplant',
            opTypeFilter.OP_TYPE_SCOPES.join(', ')), 'Scope');
      }
      if (req.data.Scope !== undefined) req.data.Scope = scope;

      // L'elenco si NORMALIZZA e basta: quali tipi esistano lo sa il tenant, non il progetto —
      // stesso ragionamento di isValidPlexCode (srv/lib/plexPartCodes.js) e degli stati congelati
      // dell'ordinamento job. Cio' che si memorizza e' cio' che si mostra e cio' che si applica.
      if (req.data.OpTypes !== undefined && req.data.OpTypes !== null) {
        req.data.OpTypes = opTypeFilter.parseOpTypes(req.data.OpTypes).value;
      }

      // Safety-net di unicita': @assert.unique e' SOLO compile-time (genera l'indice, non un
      // handler runtime), quindi senza questo la violazione uscirebbe come errore driver 500.
      const clash = await SELECT.one.from(ZPlexOpTypeFilter).where({
        Plant, Scope: scope, ID: { '!=': req.data.ID }
      });
      if (clash) {
        return req.error(400,
          getLocalizedMessage(req, 'potScopeAlreadySet', 'adminconfigplant', scope), 'Scope');
      }
    }

    this.before('CREATE', 'ZPlexOpTypeFilter', validateOpTypeFilter);
    this.before('UPDATE', 'ZPlexOpTypeFilter', validateOpTypeFilter);
  }

  if (this.name === 'CatalogService') {
    const { ZMatFilterConfig } = this.entities;

    // Keep the active-plants cache fresh when the plant master changes from the dashboard,
    // and drop the license verdict for the affected plant.
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'ZPlant', (data, req) => {
      invalidateActivePlantsCache();
      const pc = (req && req.data && req.data.PlantCode) || (data && data.PlantCode);
      if (pc) invalidateLicense(pc);
    });

    // CP1 - License gate on plant activation. Block only the transition to Status='Active'
    // without a valid license; deactivation (Disabled/InProgress) is always allowed so an
    // expired plant can be disabled. On CREATE, Status defaults to 'Active' when omitted.
    this.before(['CREATE', 'UPDATE'], 'ZPlant', async (req) => {
      const key = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const plantCode = req.data.PlantCode || (key && (key.PlantCode || key));
      const status = req.event === 'CREATE' ? (req.data.Status ?? 'Active') : req.data.Status;
      if (status !== 'Active' || !plantCode) return;
      invalidateLicense(plantCode);
      if (!(await isPlantLicensed(plantCode, { force: true }))) {
        req.error(400, getLocalizedMessage(req, 'plantNotLicensed', 'adminconfigplant', plantCode));
        // [PLANT-ACCESS] Il `return` serve: `req.error` NON interrompe (a differenza di
        // `req.reject`), quindi senza di lui la richiesta arriverebbe anche al gate di ruolo e la
        // risposta porterebbe DUE messaggi — di cui uno sulla causa sbagliata.
        return;
      }

      // ================================================================
      // [PLANT-ACCESS] SOLO UN 'admin' ATTIVA UN PLANT (feature 0048).
      //
      // Sta DOPO il check licenza, e l'ordine e' vincolante: un plant non licenziato deve leggere
      // «non ha una licenza valida», non «non hai i permessi» — la prima nomina il rimedio giusto.
      //
      // E STA DOPO IL `return` DELLA RIGA 'Active', che e' il punto piu' importante: le
      // DISATTIVAZIONI restano libere. Un plant con licenza scaduta si puo' sempre disattivare
      // (docs/0001) e sotto un gate di ruolo non si potrebbe piu': su un plant scaduto il license
      // server non restituisce nessun ruolo, quindi resterebbe bloccato in `Active` per sempre,
      // senza che nessuno possa toglierlo di mezzo.
      //
      // Sulla CREATE il gate scatta solo se `Status` e' 'Active' — omesso vale 'Active' per default
      // di modello — e in quel caso la licenza e' gia' stata verificata sopra, quindi il ruolo e'
      // ottenibile. La dashboard crea sempre `InProgress`, quindi il caso normale non lo paga.
      // ================================================================
      if (await rejectIfNotFullAdmin(req, plantCode)) return;
    });

    // Ruolo dell'utente loggato per un plant (check licenza PER-UTENTE, separato dal check
    // per-plant qui sopra). La mail arriva dall'utente autenticato (req.user); getUserRole
    // (srv/license.js) interroga il server licenza con plant+user. [PLANT-ACCESS] Su QUESTO
    // percorso non c'e' nessuna cache positiva — si va sempre live, cosi' promozione e
    // retrocessione si vedono subito (il commento diceva «24h TTL», e quel TTL non e' mai
    // esistito qui: e' la politica dell'ALTRO check, `getUserPlantRole`, che serve il perimetro
    // della dashboard). Resta il grace di 96 h. Fail-closed: ruolo non determinabile -> 403.
    this.on('getUserRole', async (req) => {
      const plant = req.data.plant;
      if (!plant) return req.reject(400, getLocalizedMessage(req, 'plantCodeMandatory', 'adminconfigplant'));

      // In prod (XSUAA/IAS) req.user.id e' tipicamente la mail dell'utente loggato.
      const email = req.user?.id || req.user?.attr?.email || null;
      if (!email) return req.reject(403, getLocalizedMessage(req, 'roleAccessDenied', 'adminconfigplant'));

      const role = await getUserRole(email, plant);
      if (role === 'admin' || role === 'admin-config') return role;
      return req.reject(403, getLocalizedMessage(req, 'roleAccessDenied', 'adminconfigplant'));
    });

    // ================================================================
    // [PLANT-ACCESS] Il perimetro di chi sta guardando, per il selettore (feature 0048).
    //
    // Il contratto e la ragione per cui non e' un filtro su `ZPlant` stanno in cat-service.cds.
    // Qui contano tre cose.
    //
    // NON LEGGE NIENTE VERSO SAP: il perimetro viene da `resolveUserScope` (plant attivi dal
    // database, licenza dalla cache di srv/license.js, ruolo dal license server) e l'unica lettura
    // e' `ZPlant` per il NOME, che serve alla tendina — nessun altro punto del server lo legge.
    //
    // DICHIARA ANCHE LE LEVE. `USE_TEST_DATA_FILTER` scavalca il gate in sette punti del file:
    // con quella accesa la tendina mostrerebbe il perimetro dell'utente mentre le liste mostrano il
    // plant cablato, cioe' una busta che MENTE. Se e' accesa lo si dice qui.
    //
    // `Excluded` E' IL PEZZO CHE PERMETTE DI SPIEGARE. Un utente che vede due plant su cinque non
    // ha bisogno di sapere quali sono gli altri tre, ma ha bisogno di sapere PERCHE': con i verdetti
    // in mano la nota in testata distingue «chiedi l'abilitazione» da «il license server non
    // risponde», che hanno rimedi diversi.
    // ================================================================
    // ================================================================
    // [SESSION-401] Il bersaglio del keep-alive (feature 0034). Non fa niente di proposito: conta
    // che la richiesta ATTRAVERSI l'approuter e ne tocchi la sessione, non cosa risponde.
    //
    // NESSUNA LETTURA, NESSUN GIRO AL LICENSE SERVER. E' la ragione per cui non si riusa
    // `usablePlants()`, che di chiamate al license server ne fa sedici per una sola apertura: un
    // ping che costa sedici chiamate esterne a ogni finestra di inattivita' non e' un ping.
    //
    // E NIENTE `req.user`, nessun dato, nessuna eco: quello che torna non viene letto da nessuno, e
    // farlo portare qualcosa inviterebbe qualcuno a usarlo per altro — e allora smetterebbe di
    // poter restare a costo zero.
    // ================================================================
    this.on('ping', () => 'OK');

    this.on('usablePlants', async (req) => {
      const scope = await resolveUserScope(req);

      const db = await cds.connect.to('db');
      const { ZPlant } = db.entities('avvaleplm.marsplm.sap2plex');
      const codes = [...scope.byPlant.keys()];
      const names = new Map();
      if (codes.length) {
        const rows = await db.run(
          SELECT.from(ZPlant).columns('PlantCode', 'PlantName').where({ PlantCode: { in: codes } })
        );
        for (const r of (rows || [])) names.set(r.PlantCode, r.PlantName || '');
      }

      // La partizione concessi/esclusi e' una regola pura: decide cosa finisce nella tendina, e
      // un plant dalla parte sbagliata non darebbe nessun errore. Test: plantAccessRules.test.js.
      const { granted, excluded } = plantAccessRules.splitScope({
        byPlant: scope.byPlant, plants: scope.plants, names
      });

      const gates = [];
      if (process.env.USE_TEST_DATA_FILTER === 'true') gates.push('USE_TEST_DATA_FILTER');

      const out = {
        Plants: granted,
        Total: scope.byPlant.size,
        Granted: granted.length,
        RoleReadOk: scope.roleReadOk !== false,
        Reason: scope.reason || '',
        Gates: gates.join(', '),
        Excluded: excluded
      };
      console.log(`>>> [PLANT-ACCESS] usablePlants: ${out.Granted}/${out.Total} plant`
        + (out.Gates ? ` — LEVE ATTIVE: ${out.Gates}` : '')
        + (out.Reason ? ` — ${out.Reason}` : ''));
      return out;
    });

    // ================================================================
    // [IS-SOURCE] FR-06 / TD-9 (feature 0013) — diagnostica del canale attivo per le tre
    // aree. Non c'è nessun presidio di AVVIO che rifiuta di leggere, per tre ragioni:
    // renderebbe l'omissione di una procedura un guasto totale anche dove il default è
    // corretto; non potrebbe verificare ciò che conta (la destination ha lo STESSO nome e
    // host diversi nei vari subaccount); e l'unica verifica che conta — una lettura vera —
    // richiede il JWT dell'utente, che al bootstrap non esiste. Quindi: dichiarazione di
    // avvio (M-08, emessa dalle sorgenti) + questa function, eseguita da un utente
    // autenticato. Il riscontro post-rilascio diventa una chiamata HTTP con tre risposte,
    // invece di archeologia sui log.
    // ================================================================
    this.on('isChannelDiag', async (req) => {
      // Probe MINIMO per area: una riga, con il perimetro plant già applicato dove esiste.
      // Non è un mezzo per estrarre dati.
      const plants = [...(await resolveEffectivePlants(req))];
      const areas = [
        { source: productSource, entity: 'A_ProductPlant', plantField: 'Plant' },
        { source: prodOrderSource, entity: 'A_ProductionOrder_2', plantField: 'ProductionPlant' },
        { source: routingSource, entity: 'ProductionRoutingHeader', plantField: 'Plant' }
      ];

      const out = [];
      for (const a of areas) {
        const row = {
          area: '', mode: '', origin: '', originDetail: '', envVar: '', destination: '',
          roots: '', probeEntity: a.entity, probeRows: 0, probeDropped: 0, probeMs: 0, error: ''
        };
        let src;
        try {
          src = await a.source();
        } catch (e) {
          row.area = a.source.area || '';
          row.envVar = a.source.envVar || '';
          row.error = `sorgente non inizializzabile: ${e.message}`;
          out.push(row);
          continue;
        }
        row.area = src.area;
        row.mode = src.mode;
        row.origin = src.origin;
        row.originDetail = src.originDetail;
        row.envVar = src.envVar;
        row.destination = src.destination;
        row.roots = Object.entries(src.paths).map(([k, v]) => `${k}=${v}`).join(' | ').slice(0, 2000);

        const t0 = Date.now();
        try {
          // [PLANT-ACCESS] PERIMETRO VUOTO: LA SONDA NON PARTE (feature 0048).
          //
          // Il criterio era `if (plants.length) q.where(...)`, cioe' con zero plant la sonda
          // usciva SENZA filtro. Innocuo finche' «zero plant» era una condizione di
          // configurazione; ora e' anche «questo utente non ha nessun ruolo», e questa e' una
          // lettura verso SAP che rende una riga di dati. Si dichiara nell'errore della riga, che
          // e' il canale che questa diagnostica ha gia'.
          if (!plants.length) {
            row.error = 'nessun plant nel tuo perimetro: sonda non eseguita';
            row.probeMs = Date.now() - t0;
            out.push(row);
            continue;
          }
          const E = src.entities[a.entity];
          const q = SELECT.from(E).columns(a.plantField).limit(1);
          q.where({ [a.plantField]: { in: plants } });
          const rows = await src.run(q);
          const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
          row.probeRows = list.length;
          // Righe che il gate di perimetro scarterebbe a valle: se il criterio è stato
          // inviato e a valle si scarta, la sorgente non lo ha applicato (contratto C-5).
          // Il criterio ora è sempre stato inviato: la guardia qui sopra esce quando non c'è.
          const allowed = new Set(plants);
          row.probeDropped = list.filter(r => !allowed.has(r[a.plantField])).length;
        } catch (e) {
          row.error = require('./lib/isRemoteSource').errorText(e).slice(0, 500);
        }
        row.probeMs = Date.now() - t0;
        out.push(row);
      }
      console.log('>>> [IS-SOURCE] isChannelDiag: '
        + out.map(r => `${r.area}=${r.mode}(${r.origin}) righe=${r.probeRows} scartate=${r.probeDropped}${r.error ? ' KO' : ''}`).join(' | '));
      return out;
    });

    // ================================================================
    // [IS-CALL-LOG] Le ultime letture verso SAP, cosi' come sono state fatte: URL reale,
    // criteri, $select, forma, righe, durata, esito, campione. Non esegue NIENTE: restituisce
    // l'anello in memoria riempito da srv/lib/isRemoteSource.js, quindi e' innocua da
    // ricaricare. Il consumo e' la console del browser (webapp/util/IsCallLog.js), ma la
    // function e' apribile anche in una tab.
    // Da rimuovere a migrazione conclusa.
    // ================================================================
    // ================================================================
    // [PLANT-ACCESS] Chi non ha nessun plant non legge la traccia (feature 0048).
    //
    // Questa function non ha un plant su cui filtrare: l'anello e' del PROCESSO, e contiene le
    // letture fatte per chiunque avesse il cockpit aperto — con URL completi, criteri, `$select` e
    // il CORPO CRUDO delle risposte. Non e' filtrabile per plant senza riscrivere l'anello.
    //
    // Il gate esprimibile e' quindi il piu' grezzo: «hai almeno un plant nel tuo perimetro?». Chi
    // non ne ha nessuno non ha nemmeno una lettura propria da diagnosticare. Non e' una protezione
    // fine, ed e' dichiarata come tale: chi ha un plant vede anche le letture degli altri.
    //
    // La leva `IS_CALL_LOG=off` resta e non e' un gate: spegne la traccia per tutti.
    // ================================================================
    this.on('isCallLog', async (req) => {
      if (!(await getUserPlants(req)).size) {
        console.warn('>>> [PLANT-ACCESS] isCallLog: nessun plant nel perimetro, traccia non servita');
        return [];
      }
      const rows = isCallLog.list({ sinceSeq: req.data.sinceSeq, limit: req.data.limit });
      const ko = rows.filter(r => r.outcome === 'KO').length;
      console.log(`>>> [IS-CALL-LOG] isCallLog: ${rows.length} voci da seq ${req.data.sinceSeq || 0}`
        + `${ko ? `, di cui ${ko} KO` : ''}${isCallLog.OFF ? ' (traccia SPENTA: IS_CALL_LOG=off)' : ''}`);
      return rows;
    });

    // ================================================================
    // [IS-CALL-LOG] Svuota l'anello: lo chiama il cockpit all'apertura, perche' una traccia che
    // sopravvive ai refresh del browser seppellisce le letture che si stanno cercando sotto
    // quelle delle sessioni precedenti. Il perche' per esteso sta in srv/cat-service.cds,
    // accanto alla dichiarazione, e in `clear()` di srv/lib/isCallLog.js.
    //
    // Nessun gate di licenza, per simmetria con `isCallLog`: non espone dati di nessun plant —
    // li cancella. L'anello e' unico per processo, quindi il reset vale per tutti.
    // ================================================================
    // [PLANT-ACCESS] Stesso gate della lettura (feature 0048), e per una ragione in piu': l'anello
    // e' UNICO per processo, quindi azzerarlo cancella la diagnostica in corso di chiunque altro.
    // La firma prende ora `req`, che prima non aveva: senza, il perimetro non e' interrogabile.
    this.on('isCallLogReset', async (req) => {
      if (!(await getUserPlants(req)).size) {
        return { cleared: false, message: 'nessun plant nel tuo perimetro: niente da azzerare' };
      }
      if (isCallLog.OFF) {
        return { cleared: false, message: 'traccia SPENTA (IS_CALL_LOG=off): niente da azzerare' };
      }
      isCallLog.clear();
      console.log('>>> [IS-CALL-LOG] anello azzerato: la traccia riparte da seq 1');
      return { cleared: true, message: 'anello azzerato: la traccia riparte da seq 1' };
    });

    // Hard-delete a plant and ALL of its per-plant configuration/data across every table.
    // Children (compositions + flat-FK routing-template children) are removed before their
    // parents, then the plant master row. Irreversible; invoked by the adminconfigplant
    // dashboard behind a triple confirmation. Runs inside the request transaction, so any
    // failure rolls back the whole cascade.
    this.on('deletePlant', async (req) => {
      const plant = req.data.PlantCode;
      if (!plant) return req.error(400, getLocalizedMessage(req, 'plantCodeMandatory', 'adminconfigplant'));

      // [PLANT-ACCESS] SOLO UN 'admin' CANCELLA UN PLANT (feature 0048).
      //
      // Prima non c'era nessun controllo: chiunque raggiungesse questo service poteva cancellare
      // un plant e TUTTO il suo customizing, su ogni tabella, in modo irreversibile. La tripla
      // conferma della dashboard e' una difesa della UI, e una UI non impedisce a nessuno di
      // chiamare l'URL OData a mano.
      //
      // `admin` pieno, non «qualsiasi ruolo»: e' la decisione presa per questa azione e per i
      // cambi di stato. `admin-config` NON passa, ed e' cio' che `rejectIfNotFullAdmin` garantisce.
      if (await rejectIfNotFullAdmin(req, plant)) return;

      const db = await cds.connect.to('db');
      const e = db.entities('avvaleplm.marsplm.sap2plex');

      // Collect parent IDs so composition / flat-FK children can be removed first.
      const idsWhere = async (entity, where) =>
        (await db.run(SELECT.from(entity).columns('ID').where(where))).map((r) => r.ID);
      const idsIn = async (entity, col, parentIds) =>
        parentIds.length
          ? (await db.run(SELECT.from(entity).columns('ID').where({ [col]: parentIds }))).map((r) => r.ID)
          : [];
      const delIn = async (entity, col, ids) =>
        ids.length ? (await db.run(DELETE.from(entity).where({ [col]: ids }))) || 0 : 0;
      const delByPlant = async (entity) =>
        (await db.run(DELETE.from(entity).where({ Plant: plant }))) || 0;

      try {
        let removed = 0;

        // Object groups: header + field/value conditions (composition)
        const ogIds = await idsWhere(e.ZObjectGroup, { Plant: plant });
        removed += await delIn(e.ZObjectGroupField, 'group_ID', ogIds);
        removed += await delByPlant(e.ZObjectGroup);

        // Plex part field mapping: map -> rules -> conditions (composition)
        const pfmIds = await idsWhere(e.ZPlexFieldMap, { Plant: plant });
        const pfmRuleIds = await idsIn(e.ZPlexFieldMapRule, 'map_ID', pfmIds);
        removed += await delIn(e.ZPlexFieldMapRuleCond, 'rule_ID', pfmRuleIds);
        removed += await delIn(e.ZPlexFieldMapRule, 'map_ID', pfmIds);
        removed += await delByPlant(e.ZPlexFieldMap);

        // Plex part-operation field mapping: map -> rules -> conditions (composition)
        const pofIds = await idsWhere(e.ZPlexOpFieldMap, { Plant: plant });
        const pofRuleIds = await idsIn(e.ZPlexOpFieldMapRule, 'map_ID', pofIds);
        removed += await delIn(e.ZPlexOpFieldMapRuleCond, 'rule_ID', pofRuleIds);
        removed += await delIn(e.ZPlexOpFieldMapRule, 'map_ID', pofIds);
        removed += await delByPlant(e.ZPlexOpFieldMap);
        // [PLEX-OP-TYPE-FILTER] Feature 0024: il filtro per tipo delle tendine muore col plant. La
        // conseguenza di dimenticarlo sarebbe silenziosa e fastidiosa nei due sensi: un plant
        // ricreato mostrerebbe le tendine ristrette da un criterio che nessuno ha piu' scelto,
        // oppure — se i tipi del nuovo tenant hanno altri nomi — tendine vuote.
        removed += await delByPlant(e.ZPlexOpTypeFilter);

        // Material categories: category -> conditions (composition)
        const mcIds = await idsWhere(e.ZMatCategory, { Plant: plant });
        removed += await delIn(e.ZMatCategoryCond, 'category_ID', mcIds);
        removed += await delByPlant(e.ZMatCategory);

        // [COMP-EXCL] Esclusione componenti d'ordine: regole + condizioni (composition). Muore col
        // plant come ogni customizing: un plant ricreato non deve riprendere a TOGLIERE componenti
        // dalla distinta di un job — e quelli esclusi vengono disattivati su Plex, quindi non e'
        // un difetto di sola visualizzazione.
        const oceIds = await idsWhere(e.ZOrderCompExclRule, { Plant: plant });
        removed += await delIn(e.ZOrderCompExclCond, 'rule_ID', oceIds);
        removed += await delByPlant(e.ZOrderCompExclRule);

        // Routing templates: header + operations + approved workcenters (flat FK TemplateID)
        const rtIds = await idsWhere(e.ZPlexRoutingTemplate, { Plant: plant });
        // [TEMPLATE-GROUP] Terza figlia dei template, accanto alle due storiche.
        removed += await delIn(e.ZPlexRoutingTemplateGroup, 'TemplateID', rtIds);
        removed += await delIn(e.ZPlexRoutingTemplateWorkcenter, 'TemplateID', rtIds);
        removed += await delIn(e.ZPlexRoutingTemplateOperation, 'TemplateID', rtIds);
        removed += await delByPlant(e.ZPlexRoutingTemplate);

        // Plain per-plant customizing
        removed += await delByPlant(e.ZCycleAutoAssignConfig);
        // [W1-03] La mappa unita' di misura -> operazione di ricevimento muore col plant: un
        // plant ricreato non deve riprendere a istanziare operazioni che nessuno ha piu' scelto.
        removed += await delByPlant(e.ZMatRecvOpConfig);
        // ================================================================
        // [MAT-PLANT-PAIR] E DALLA 0039 MUOIONO COL PLANT ANCHE I DUE DIZIONARI.
        //
        // Qui c'era il contrario, e la ragione era buona: «dicono cosa c'e' su PLEX, e Plex non si
        // svuota perche' qui si cancella un plant». Reggeva pero' su una premessa — che la riga non
        // fosse attribuibile a un plant — che la chiave `(Product, Plant)` ha tolto. Ora una riga
        // descrive il tenant DI QUEL PLANT, e cancellato il plant descrive un tenant a cui non e'
        // piu' attaccato nessuno.
        //
        // Lo scenario che rende dannoso il contrario e' quello gia' scritto qui sotto per i codici
        // tipologia: un plant ricreato puo' puntare a UN ALTRO tenant (0020). Allora una riga
        // `ZMatPlexMapping` sopravvissuta porta l'UUID del vecchio tenant — PUT, 404, ramo di
        // fallback, e un log che dice «part cancellata da Plex e ricreata» su una part mai
        // cancellata — e una riga `ZMatRecvOpMapping` fa concludere «operazione gia' fatta» senza
        // nemmeno guardare il tenant nuovo: la part non avrebbe MAI la sua operazione di
        // ricevimento, e nessuna riga lo direbbe. E' lo stesso guasto che il commento su
        // ZProdConfMatDoc, poche righe piu' giu', descrive per le sue righe orfane.
        //
        // L'ASIMMETRIA DECIDE: il danno del non-cancellare e' illimitato e muto; quello del
        // cancellare, nel caso in cui il plant venga ricreato sullo STESSO tenant, e' una GET per
        // materiale una volta sola — l'invio ritrova la part con la lettura per numero e il passo
        // di ricevimento ritrova la part-operation con la sua lettura mirata. Meccanismi che
        // esistono gia'.
        //
        // I log `ZMatExcLog*` restano dove sono: sono log, e la convenzione e' che sopravvivano.
        // ================================================================
        removed += await delByPlant(e.ZMatPlexMapping);
        removed += await delByPlant(e.ZMatRecvOpMapping);
        // [PLEX-PART-CODES] Feature 0022: i codici sono del TENANT del plant, non del progetto.
        // Un plant ricreato — magari puntando a un altro tenant Plex (0020) — non deve riprendere
        // a mandare chiavi numeriche che nessuno ha piu' scelto: sarebbero part con la tipologia
        // sbagliata, non un errore visibile. Il ripiego alla stringa e' il posto giusto dove
        // ricominciare.
        removed += await delByPlant(e.ZPlexPartTypeCode);
        removed += await delByPlant(e.ZPlexPartStatusConfig);
        removed += await delByPlant(e.ZMatFilterConfig);
        // Feature 0014: la configurazione di ordinamento muore con il plant (FR-29). Sta fra i
        // customizing piatti perche' non ha figli e la chiave di cancellazione e' il plant.
        removed += await delByPlant(e.ZPlexJobSortConfig);
        // Feature 0016: le regole di visibilita' dei cicli muoiono con il plant. Senza questa
        // riga tornerebbero a filtrare se il codice plant venisse riusato.
        removed += await delByPlant(e.ZRoutingFilterConfig);
        // [ORDER-STATUS-FILTER] Feature 0017: idem per il perimetro ordini. Qui la conseguenza
        // di dimenticarlo sarebbe l'opposta e peggiore — un plant ricreato riprenderebbe a
        // leggere ordini con un criterio che nessuno ha piu' scelto, invece di restare fermo.
        removed += await delByPlant(e.ZProdOrderFilterConfig);
        // [ORDER-TECO] Feature 0023: la configurazione della chiusura tecnica muore col plant. Un
        // plant ricreato non deve riprendere a CHIUDERE job su Plex — che e' una scrittura, non
        // una vista — con un criterio che nessuno ha piu' scelto.
        // ZProdOrderTecoState invece SOPRAVVIVE, come ZProdOrderPlexMapping e i log di scambio:
        // dice cosa e' stato fatto su Plex, e Plex non si svuota perche' qui si cancella un plant.
        removed += await delByPlant(e.ZProdOrderTecoConfig);
        // [ORDER-COMPLETE] Feature 0045: idem, nel verso opposto. Un plant ricreato non deve
        // riprendere a impostare stati utente su ordini SAP con un criterio che nessuno ha piu'
        // scelto — ed e' una scrittura verso SAP, non una vista. ZProdOrderCompleteState invece
        // SOPRAVVIVE, come ZProdOrderTecoState: dice cosa e' stato fatto IN SAP, e SAP non si
        // svuota perche' qui si cancella un plant.
        removed += await delByPlant(e.ZProdOrderCompleteConfig);
        // [ORDER-SCHEDULED] Feature 0046: idem per il gemello. Anche qui lo STATO sopravvive.
        removed += await delByPlant(e.ZProdOrderScheduledConfig);
        // [PHANTOM-EXPLODE] Feature 0019: idem per l'esplosione dei fantasma. Un plant ricreato
        // riprenderebbe a esplodere distinte senza che nessuno l'abbia acceso — e i componenti
        // esplosi FINISCONO SU PLEX, quindi non e' un difetto di sola visualizzazione.
        removed += await delByPlant(e.ZPhantomExplodeConfig);
        // [CONF-POSTING] Feature 0028: consumi e scarti della consuntivazione. Un plant ricreato non
        // deve riprendere a registrare movimenti di magazzino con un criterio che nessuno ha piu'
        // scelto — qui l'effetto e' CONTABILE, non una vista. Cancellata la riga si torna ai default,
        // che sono il comportamento di prima della 0028; e la scrittura resta comunque chiusa
        // dall'interruttore MatDocPostEnabled, che su un plant nuovo nasce false.
        removed += await delByPlant(e.ZProdConfPostingConfig);
        // Destinatari del recap mail: sono DATI PERSONALI, quindi questa riga e' anche il
        // percorso di cancellazione GDPR quando il plant viene rimosso.
        removed += await delByPlant(e.ZJobNotifyRecipient);
        // NB: ZJobRunHDR/POS/Mail NON vengono cancellati, come NON lo sono ZMatExcLog*,
        // ZProdOrderExcLog* e ZRoutingExcLog*: per convenzione i log di scambio sopravvivono
        // alla cancellazione del plant. Cancellare le sole POS per plant lascerebbe inoltre i
        // contatori dell'HDR a mentire.

        // Runtime confirmation staging tied to the plant
        // [CONF-POSTING] LA FIGLIA VA PRIMA DELLA MADRE, e prima mancava del tutto. `ZProdConfMatDoc`
        // porta il suo `Plant`, quindi la si cancella per plant come la madre — ma senza questa riga
        // un plant cancellato e ricreato trovava figlie ORFANE: la fase di costruzione le vedeva,
        // concludeva «documenti gia' costruiti» e non ricostruiva piu' niente per quelle
        // registrazioni. Un flusso contabile fermo, senza una riga di errore da nessuna parte.
        //
        // Non e' un log di scambio — quelli sopravvivono per convenzione: e' lo STAGING di cosa resta
        // da mandare, e va con la madre di cui e' la coda di lavoro.
        removed += await delByPlant(e.ZProdConfMatDoc);
        removed += await delByPlant(e.ZProdConfPlexEntry);

        // Finally the plant master row itself
        removed += (await db.run(DELETE.from(e.ZPlant).where({ PlantCode: plant }))) || 0;

        // The service-level after('DELETE','ZPlant') handler does not fire for this raw
        // cascade, so keep the shared caches consistent explicitly.
        invalidateActivePlantsCache();
        invalidateLicense(plant);
        // Idem per la cache della configurazione di ordinamento (feature 0014, §6.3): senza
        // questa riga un plant cancellato e ricreato entro il TTL riporterebbe in vita in
        // memoria una configurazione che non esiste piu'.
        invalidateJobSortConfigCache(plant);
        // [PHANTOM-EXPLODE] Stessa ragione per la cache di esplosione (feature 0019).
        require('./lib/bomExplode').invalidateExplodeConfigCache(plant);
        // [COMP-EXCL] Idem per la cache delle regole di esclusione: si svuota TUTTA, perche'
        // contiene anche la voce `'*'` usata per le colonne del `$select`.
        orderCompExcl.invalidateExclRulesCache();
        // [W1-03] Stessa ragione per la cache del customizing dell'operazione di ricevimento.
        invalidateRecvOpConfigCache(plant);
        // [CONF-POSTING] Idem per la cache dei consumi e degli scarti (feature 0028): un plant
        // cancellato e ricreato entro il TTL riporterebbe in vita in memoria una configurazione che
        // non esiste piu', e qui quella configurazione decide movimenti di magazzino.
        require('./lib/confPostingConfig').invalidateConfPostingConfigCache(plant);

        console.log(`>>> Plant ${plant} deleted with all its data (${removed} rows removed)`);
        return { success: true, deleted: removed };
      } catch (error) {
        console.error(`>>> ERROR deleting plant ${plant}:`, error.message);
        req.error(500, error.message);
      }
    });

    // A change to any customer API key can change which plants validate -> drop all verdicts.
    // [PLANT-ACCESS] E anche l'ELENCO delle chiavi, che dalla 0048 sta in cache: senza questa riga
    // un rinnovo continuerebbe a essere provato con la chiave vecchia fino allo scadere del TTL.
    // NB: `invalidateUserRole` NON si aggancia qui, ed e' una decisione — vedi il suo docblock in
    // srv/license.js: qui non c'e' un'e-mail, quindi la chiamata sarebbe senza argomenti, cioe' via
    // l'intera base del grace di 96 h per ogni utente.
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'ZLicenseConfig', () => {
      invalidateLicense();
      invalidateApiKeys();
    });

    // ================================================================
    // VALIDAZIONE - Before CREATE
    // ================================================================
    this.before('CREATE', 'ZMatFilterConfig', async (req) => {
      const { Plant, ProfitCenter, MRPType, ProcurementType, PurchasingGroup } = req.data;

      // Validazione Plant (obbligatorio)
      if (!Plant || Plant.trim() === '') {
        req.error(400, getLocalizedMessage(req, 'plantMandatory', 'adminconfigmatfil'), 'Plant');
      }

      // Validazione formato Plant (4 caratteri alfanumerici)
      if (Plant && !/^[A-Z0-9]{1,4}$/.test(Plant)) {
        req.error(400, getLocalizedMessage(req, 'plantFormat', 'adminconfigmatfil'), 'Plant');
      }

      // Validazione formato MRPType (massimo 2 caratteri)
      if (MRPType && !/^[A-Z0-9]{0,2}$/.test(MRPType)) {
        req.error(400, getLocalizedMessage(req, 'mrpTypeFormat', 'adminconfigmatfil'), 'MRPType');
      }

      // Validazione formato ProcurementType (1 carattere)
      if (ProcurementType && !/^[A-Z0-9]?$/.test(ProcurementType)) {
        req.error(400, getLocalizedMessage(req, 'procurementTypeFormat', 'adminconfigmatfil'), 'ProcurementType');
      }

      // Validazione formato PurchasingGroup (massimo 3 caratteri)
      if (PurchasingGroup && !/^[A-Z0-9]{0,3}$/.test(PurchasingGroup)) {
        req.error(400, getLocalizedMessage(req, 'purchasingGroupFormat', 'adminconfigmatfil'), 'PurchasingGroup');
      }

      console.log(`Creating new Material Filter Config: Plant=${Plant}`);
    });

    // ================================================================
    // VALIDAZIONE - Before UPDATE
    // ================================================================
    this.before('UPDATE', 'ZMatFilterConfig', async (req) => {
      const { Plant, MRPType, ProcurementType, PurchasingGroup } = req.data;

      // Validazione formati (stessa logica del CREATE)
      if (Plant && !/^[A-Z0-9]{1,4}$/.test(Plant)) {
        req.error(400, getLocalizedMessage(req, 'plantFormat', 'adminconfigmatfil'), 'Plant');
      }

      if (MRPType && !/^[A-Z0-9]{0,2}$/.test(MRPType)) {
        req.error(400, getLocalizedMessage(req, 'mrpTypeFormat', 'adminconfigmatfil'), 'MRPType');
      }

      if (ProcurementType && !/^[A-Z0-9]?$/.test(ProcurementType)) {
        req.error(400, getLocalizedMessage(req, 'procurementTypeFormat', 'adminconfigmatfil'), 'ProcurementType');
      }

      if (PurchasingGroup && !/^[A-Z0-9]{0,3}$/.test(PurchasingGroup)) {
        req.error(400, getLocalizedMessage(req, 'purchasingGroupFormat', 'adminconfigmatfil'), 'PurchasingGroup');
      }

      console.log(`Updating Material Filter Config: ID=${req.data.ID}`);
    });

    // ================================================================
    // BUSINESS LOGIC - Before DELETE
    // ================================================================
    this.before('DELETE', 'ZMatFilterConfig', async (req) => {
      const id = req.data.ID;
      console.log(`Deleting Material Filter Config: ID=${id}`);

      // Eventuali controlli pre-eliminazione (es: configurazione in uso?)
      // Decommentare se necessario:
      // const config = await SELECT.one.from(ZMatFilterConfig).where({ ID: id });
      // if (/* config is in use */) {
      //   req.error(400, 'Cannot delete configuration that is currently in use');
      // }
    });

    // ================================================================
    // SUCCESS HANDLERS - Logging (opzionale)
    // ================================================================
    this.after('CREATE', 'ZMatFilterConfig', async (data, req) => {
      console.log(`Successfully created Material Filter Config: ID=${data.ID}, Plant=${data.Plant}`);
    });

    this.after('UPDATE', 'ZMatFilterConfig', async (data, req) => {
      console.log(`Successfully updated Material Filter Config: ID=${data.ID}`);
    });

    this.after('DELETE', 'ZMatFilterConfig', async (data, req) => {
      console.log(`Successfully deleted Material Filter Config`);
    });

    /**
     * [ROW-KEY] La chiave tecnica della riga in corso di validazione.
     *
     * SU UNA `PATCH` PER CHIAVE LA CHIAVE NON STA NEL PAYLOAD: sta in `req.params`. `req.data.ID` e'
     * valorizzato in CREATE — lo riempie la fase `_initial` di CAP, prima di ogni `before`
     * dell'applicazione — ma su un aggiornamento parziale e' `undefined`, e leggerlo da li' soltanto
     * fa due danni in fila: la rilettura della riga esistente non aggancia (quindi si valida un
     * oggetto che ha i soli campi modificati, e scatta «il plant e' obbligatorio» su una PATCH
     * legittima) e l'esclusione di se' dal confronto di unicita' non funziona.
     *
     * Un punto solo per le tre validazioni che ne hanno bisogno: finche' erano tre estrazioni
     * scritte a mano, due erano sbagliate e una giusta.
     */
    function rowKeyOf(req) {
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      return req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
    }

    // ================================================================
    // CYCLE AUTO-ASSIGNMENT CONFIG - Validation (mandatory fields + uniqueness)
    // ================================================================
    const { ZCycleAutoAssignConfig } = this.entities;

    /**
     * Campi obbligatori e unicita' di (Plant, Material, ComponentGroup).
     *
     * Su UPDATE si valuta la riga RISULTANTE, non il payload: un aggiornamento parziale non porta
     * tutti i campi. La chiave arriva da `rowKeyOf` e non dal solo `req.data.ID` — vedi [ROW-KEY]:
     * con la lettura sbagliata, cambiare la sola operazione Plex di una riga gia' salvata rispondeva
     * «il plant e' obbligatorio», e l'unica strada rimasta all'utente era cancellare e riaggiungere,
     * che e' proprio il gesto che genera il doppione.
     *
     * [UNIQUE-VIOLATION] Questo controllo NON e' l'unica difesa e non puo' esserlo: dentro un change
     * set di `$batch` CAP lancia le sottorichieste in parallelo, quindi due righe uguali dello
     * stesso Salva non si vedono fra loro. Le altre due sono la guardia della scheda
     * ([AA-DUPLICATE], prima dell'invio) e la traduzione dell'errore del database, in testa a questo
     * file. Qui resta perche' e' quella che da' il messaggio migliore nel caso normale.
     */
    async function validateAutoAssign(req) {
      const rowId = rowKeyOf(req);
      let row = { ...req.data };

      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(ZCycleAutoAssignConfig).where({ ID: rowId });
        if (existing) {
          row = { ...existing, ...req.data };
        }
      }

      // NORMALIZZAZIONE SCRITTA SU `req.data`, non solo su `row`: il confronto qui sotto e l'indice
      // del database devono guardare gli STESSI byte. Con la normalizzazione applicata alla sola
      // copia locale, `73 ` e `73` risultano diversi al controllo e uguali per HANA — cioe' il
      // controllo passa e il vincolo rifiuta, che e' esattamente il caso che non si vuole.
      // Il plant si maiuscolizza come nelle altre schede; materiale e gruppo si limitano al `trim`,
      // perche' si persiste cio' che l'utente ha scritto (la stessa scelta di validateRoutingFilter).
      if (req.data.Plant !== undefined && req.data.Plant !== null) {
        req.data.Plant = String(req.data.Plant).trim().toUpperCase();
      }
      row.Plant = String(row.Plant || '').trim().toUpperCase();
      for (const f of ['Material', 'ComponentGroup']) {
        if (req.data[f] !== undefined && req.data[f] !== null) {
          req.data[f] = String(req.data[f]).trim();
          row[f] = req.data[f];
        }
      }

      const { Plant, Material, ComponentGroup, PlexOperation } = row;

      if (!Plant) {
        return req.error(400, getLocalizedMessage(req, 'aaPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'aaPlantFormat', 'adminconfigplant'), 'Plant');
      }
      if (!Material || String(Material).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'aaMaterialMandatory', 'adminconfigplant'), 'Material');
      }
      if (!ComponentGroup || String(ComponentGroup).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'aaGroupMandatory', 'adminconfigplant'), 'ComponentGroup');
      }
      if (!PlexOperation || String(PlexOperation).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'aaOperationMandatory', 'adminconfigplant'), 'PlexOperation');
      }

      // Safety-net di unicita': @assert.unique e' SOLO compile-time (genera l'indice, non un
      // handler), quindi la violazione tornerebbe come errore driver.
      // L'esclusione di se' e' uno SPREAD CONDIZIONALE e non `ID: { '!=': req.data.ID }`: con la
      // chiave assente quel confronto finisce a `ID != NULL`, che oggi CAP rende in forma
      // null-safe e domani no — e un confronto che smette di agganciare non da' errore, da' il
      // `500` del database. Vedi DEC-89.
      const clash = await SELECT.one.from(ZCycleAutoAssignConfig).where({
        Plant, Material, ComponentGroup,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'aaGroupAlreadyAssigned', 'adminconfigplant'), 'ComponentGroup');
      }
    }

    this.before('CREATE', 'ZCycleAutoAssignConfig', validateAutoAssign);
    this.before('UPDATE', 'ZCycleAutoAssignConfig', validateAutoAssign);

    // [NATURAL-ORDER] Il menu di colonna della scheda «Auto-assegnazione» ordina qui, non in SQL
    // (DEC-102). E' la tabella su cui il difetto si vede: numeri SAP riempiti a zeri accanto a
    // numeri digitati a mano. Qui vive anche l'unica colonna a valori codificati del progetto —
    // «Operazione», dove «Prima operazione» e «Ultima operazione» sono etichette TRADOTTE che nel
    // database non esistono e vengono risolte nella lingua di chi chiede ([CODED-VALUES]).
    naturalOrderRead.install(this, 'ZCycleAutoAssignConfig', naturalOrderDeps());

    // ================================================================
    // [W1-03] OPERAZIONE DI RICEVIMENTO per unita' di misura, per plant (BBP §7.3.4).
    // Validazione dei campi obbligatori e unicita' (Plant, BaseUnit).
    // ================================================================
    const { ZMatRecvOpConfig } = this.entities;

    async function validateMatRecvOp(req) {
      // [ROW-KEY] La chiave da `req.params` e non dal solo payload: su una PATCH non c'e'. Stesso
      // difetto e stessa riparazione di validateAutoAssign — e' la scheda gemella.
      const rowId = rowKeyOf(req);
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        // Un update parziale puo' non portare tutti i campi: si valuta la riga RISULTANTE.
        const existing = await SELECT.one.from(ZMatRecvOpConfig).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }
      if (req.data.Plant !== undefined && req.data.Plant !== null) {
        req.data.Plant = String(req.data.Plant).trim().toUpperCase();
      }
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      // Normalizzazione dell'unita' PRIMA del confronto, e in loco: cio' che si vede a schermo
      // e' cio' che verra' confrontato col MEINS di SAP. La tolleranza del confronto a runtime
      // (recvOpRules.normalizeUom) resta, ma non deve servire a coprire due righe che
      // differiscono solo per maiuscole — quelle sono un doppione, e va detto qui.
      if (req.data.BaseUnit !== undefined && req.data.BaseUnit !== null) {
        req.data.BaseUnit = String(req.data.BaseUnit).trim().toUpperCase();
        row.BaseUnit = req.data.BaseUnit;
      }

      const { Plant, BaseUnit, PlexOperationId, OperationNumber } = row;

      if (!Plant || String(Plant).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'roPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'roPlantFormat', 'adminconfigplant'), 'Plant');
      }
      if (!BaseUnit || String(BaseUnit).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'roUomMandatory', 'adminconfigplant'), 'BaseUnit');
      }
      // Una riga senza id operazione NON e' una riga: il POST /mdm/v1/part-operations vuole
      // `operationId`, quindi salvarla significherebbe rimandare l'errore al primo invio, dove
      // non c'e' piu' nessuno a leggerlo. Il codice leggibile e' facoltativo, l'id no.
      if (!PlexOperationId || String(PlexOperationId).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'roOperationMandatory', 'adminconfigplant'),
          'PlexOperationId');
      }
      if (OperationNumber !== undefined && OperationNumber !== null && OperationNumber !== '') {
        const n = Number(OperationNumber);
        if (!Number.isInteger(n) || n <= 0) {
          return req.error(400, getLocalizedMessage(req, 'roOpNumberInvalid', 'adminconfigplant'),
            'OperationNumber');
        }
      }
      // [PLEX-OP-TYPE] NESSUNA validazione del tipo operazione, e non e' una dimenticanza: dalla
      // feature 0024 (DEC-84) il tipo non e' piu' un campo di questa tabella. Lo dichiara il
      // catalogo Plex per l'operazione scelta, quindi non c'e' niente da normalizzare qui — e non
      // c'e' piu' modo di salvare un nome che il tenant non ha.

      // Safety-net di unicita': @assert.unique e' SOLO compile-time (genera l'indice, non un
      // handler runtime), quindi senza questo la violazione uscirebbe come errore driver 500.
      // Spread condizionale sull'esclusione di se': vedi validateAutoAssign e DEC-89.
      const clash = await SELECT.one.from(ZMatRecvOpConfig).where({
        Plant, BaseUnit,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400,
          getLocalizedMessage(req, 'roUomAlreadyMapped', 'adminconfigplant', BaseUnit), 'BaseUnit');
      }
    }

    this.before('CREATE', 'ZMatRecvOpConfig', validateMatRecvOp);
    this.before('UPDATE', 'ZMatRecvOpConfig', validateMatRecvOp);

    // La cache del passo di ricevimento vive per plant con un TTL: senza questa invalidazione
    // una riga appena salvata resterebbe invisibile all'invio materiale fino alla scadenza.
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'ZMatRecvOpConfig', (data, req) => {
      invalidateRecvOpConfigCache((data && data.Plant) || (req && req.data && req.data.Plant));
    });

    // ================================================================
    // [PLEX-PART-CODES] CODICI DEL TENANT PLEX, per plant (feature 0022, DEC-65).
    // Validazione della forma del codice, della tipologia e unicita'.
    // ================================================================
    // La forma del codice va verificata QUI e non solo a runtime: un codice sbagliato non produce
    // un rifiuto leggibile da Plex ma una part con la tipologia sbagliata, o senza. E la tendina
    // e' vincolata solo a schermo — l'URL OData no — quindi la tipologia va confrontata con la
    // value help, come per la classe su ZMatCategory (DEC-62 regola 2).
    //
    // ATTENZIONE (DEC-40): String(20)/String(100) sono verificati da CAP nella fase `_initial`,
    // che precede OGNI before handler. Un codice piu' lungo della colonna viene rifiutato con un
    // messaggio tecnico prima di arrivare qui: la difesa leggibile e' il maxLength lato client.
    const { ZPlexPartTypeCode, ZPlexPartStatusConfig } = this.entities;

    async function validatePlexPartTypeCode(req) {
      let row = { ...req.data };
      if (req.event === 'UPDATE') {
        // Un update parziale puo' non portare tutti i campi: si valuta la riga RISULTANTE.
        const existing = await SELECT.one.from(ZPlexPartTypeCode).where({ ID: req.data.ID });
        if (existing) row = { ...existing, ...req.data };
      }

      if (req.data.Plant !== undefined && req.data.Plant !== null) {
        req.data.Plant = String(req.data.Plant).trim().toUpperCase();
        row.Plant = req.data.Plant;
      }
      // Il trim del codice e della tipologia e' in loco: cio' che si vede a schermo e' cio' che
      // verra' confrontato a runtime, dove indexTypeCodes trimma a sua volta. Due righe che
      // differiscono per soli spazi sono un doppione, e va detto qui.
      if (req.data.PlexTypeCode !== undefined && req.data.PlexTypeCode !== null) {
        req.data.PlexTypeCode = String(req.data.PlexTypeCode).trim();
        row.PlexTypeCode = req.data.PlexTypeCode;
      }
      if (req.data.PlexTypeValue !== undefined && req.data.PlexTypeValue !== null) {
        req.data.PlexTypeValue = String(req.data.PlexTypeValue).trim();
        row.PlexTypeValue = req.data.PlexTypeValue;
      }

      const { Plant, PlexTypeValue, PlexTypeCode } = row;

      if (!Plant || String(Plant).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'ppcPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'ppcPlantFormat', 'adminconfigplant'), 'Plant');
      }
      if (!PlexTypeValue || String(PlexTypeValue).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'ppcTypeValueMandatory', 'adminconfigplant'),
          'PlexTypeValue');
      }
      // La tipologia deve essere una TIPOLOGIA nota, cioe' un PlexValue del seed — non una classe.
      // 'Semifinished External' e' una classe valida e NON una tipologia: mandarla qui darebbe due
      // risposte alla domanda «che tipologia e' un semilavorato esterno», e la risposta la da' il
      // seed (DEC-62).
      const vhDb = await cds.connect.to('db');
      const vhIndex = await loadPartTypeIndex(vhDb);
      const knownTypeValues = new Set();
      for (const r of vhIndex.values()) {
        const v = String((r && r.PlexValue) || '').trim();
        if (v) knownTypeValues.add(v);
      }
      // Value help illeggibile ⇒ non si blocca la scrittura: fail-open come ogni altro suo
      // consumatore (loadPartTypeIndex rende un indice vuoto su errore). Meglio accettare una
      // tipologia non verificata che impedire di configurare un plant.
      if (knownTypeValues.size && !knownTypeValues.has(String(PlexTypeValue).trim())) {
        return req.error(400, getLocalizedMessage(req, 'ppcTypeValueUnknown', 'adminconfigplant',
          String(PlexTypeValue).trim()), 'PlexTypeValue');
      }
      if (!isValidPlexCode(PlexTypeCode)) {
        return req.error(400, getLocalizedMessage(req, 'ppcCodeInvalid', 'adminconfigplant',
          String(PlexTypeCode === undefined || PlexTypeCode === null ? '' : PlexTypeCode)), 'PlexTypeCode');
      }

      // Safety-net di unicita': @assert.unique e' SOLO compile-time (genera l'indice, non un
      // handler runtime), quindi senza questo la violazione uscirebbe come errore driver 500.
      const clash = await SELECT.one.from(ZPlexPartTypeCode).where({
        Plant, PlexTypeValue, ID: { '!=': req.data.ID }
      });
      if (clash) {
        return req.error(400,
          getLocalizedMessage(req, 'ppcTypeAlreadyMapped', 'adminconfigplant', PlexTypeValue),
          'PlexTypeValue');
      }
    }

    async function validatePlexPartStatus(req) {
      let row = { ...req.data };
      if (req.event === 'UPDATE') {
        const existing = await SELECT.one.from(ZPlexPartStatusConfig).where({ ID: req.data.ID });
        if (existing) row = { ...existing, ...req.data };
      }

      if (req.data.Plant !== undefined && req.data.Plant !== null) {
        req.data.Plant = String(req.data.Plant).trim().toUpperCase();
        row.Plant = req.data.Plant;
      }
      if (req.data.PlexStatusCode !== undefined && req.data.PlexStatusCode !== null) {
        req.data.PlexStatusCode = String(req.data.PlexStatusCode).trim();
        row.PlexStatusCode = req.data.PlexStatusCode;
      }
      if (req.data.PlexStatusLabel !== undefined && req.data.PlexStatusLabel !== null) {
        req.data.PlexStatusLabel = String(req.data.PlexStatusLabel).trim();
        row.PlexStatusLabel = req.data.PlexStatusLabel;
      }

      const { Plant, PlexStatusCode, PlexStatusLabel } = row;

      if (!Plant || String(Plant).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'ppcPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'ppcPlantFormat', 'adminconfigplant'), 'Plant');
      }
      if (!isValidPlexCode(PlexStatusCode)) {
        return req.error(400, getLocalizedMessage(req, 'ppcCodeInvalid', 'adminconfigplant',
          String(PlexStatusCode === undefined || PlexStatusCode === null ? '' : PlexStatusCode)),
          'PlexStatusCode');
      }
      // L'etichetta e' OBBLIGATORIA, e non e' decorazione: e' cio' che l'utente vedra' in ogni
      // altra schermata al posto del codice. Una riga senza etichetta e' una riga che costringe a
      // leggere 6387, cioe' esattamente il difetto che questa feature esiste per evitare.
      if (!PlexStatusLabel || String(PlexStatusLabel).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'ppcStatusLabelMandatory', 'adminconfigplant'),
          'PlexStatusLabel');
      }

      // UNA riga per plant: qui il doppione non e' una svista ma due risposte alla domanda «con
      // che stato nasce una part di questo plant».
      const clash = await SELECT.one.from(ZPlexPartStatusConfig).where({
        Plant, ID: { '!=': req.data.ID }
      });
      if (clash) {
        return req.error(400,
          getLocalizedMessage(req, 'ppcStatusAlreadySet', 'adminconfigplant', Plant), 'Plant');
      }
    }

    this.before('CREATE', 'ZPlexPartTypeCode', validatePlexPartTypeCode);
    this.before('UPDATE', 'ZPlexPartTypeCode', validatePlexPartTypeCode);
    this.before('CREATE', 'ZPlexPartStatusConfig', validatePlexPartStatus);
    this.before('UPDATE', 'ZPlexPartStatusConfig', validatePlexPartStatus);

    // Le due cache vivono per plant con un TTL: senza questa invalidazione un codice appena
    // salvato non partirebbe verso Plex per cinque minuti, e chi ha appena configurato il plant
    // vedrebbe uscire ancora la stringa senza capire perche'.
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'ZPlexPartTypeCode', (data, req) => {
      invalidatePlexPartCodeCache((data && data.Plant) || (req && req.data && req.data.Plant));
    });
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'ZPlexPartStatusConfig', (data, req) => {
      invalidatePlexPartCodeCache((data && data.Plant) || (req && req.data && req.data.Plant));
    });

    // ================================================================
    // JOB NOTIFY RECIPIENTS - Validazione destinatari del recap di fine job
    // (tab "Notifiche Job" di adminconfigplant, una sezione per job)
    // ================================================================
    const { ZJobNotifyRecipient } = this.entities;
    const { JOB_CODES, NOTIFY_MODES } = require('./lib/jobCodes');
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

    async function validateJobNotify(req) {
      let row = { ...req.data };
      if (req.event === 'UPDATE') {
        const existing = await SELECT.one.from(ZJobNotifyRecipient).where({ ID: req.data.ID });
        if (existing) row = { ...existing, ...req.data };
      }

      // Normalizzazione: la mail e' la CHIAVE DI RAGGRUPPAMENTO del notifier (1 mail per
      // destinatario) e l'indice UNIQUE su HANA e' case-sensitive. Senza il lowercase
      // Mario.Rossi@x.it e mario.rossi@x.it passerebbero entrambi e la stessa persona
      // riceverebbe DUE mail.
      if (req.data.Email !== undefined) req.data.Email = String(req.data.Email || '').trim().toLowerCase();
      if (req.data.Plant !== undefined) req.data.Plant = String(req.data.Plant || '').trim().toUpperCase();
      row.Email = String(row.Email || '').trim().toLowerCase();
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      const { Plant, JobCode, Email, NotifyMode } = row;

      if (!Plant || Plant === '') {
        return req.error(400, getLocalizedMessage(req, 'jnPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'jnPlantFormat', 'adminconfigplant'), 'Plant');
      }
      if (!JOB_CODES.has(JobCode)) {
        return req.error(400, getLocalizedMessage(req, 'jnJobCodeInvalid', 'adminconfigplant'), 'JobCode');
      }
      if (!Email || Email === '') {
        return req.error(400, getLocalizedMessage(req, 'jnEmailMandatory', 'adminconfigplant'), 'Email');
      }
      if (Email.length > 255 || !EMAIL_RE.test(Email)) {
        return req.error(400, getLocalizedMessage(req, 'jnEmailFormat', 'adminconfigplant'), 'Email');
      }
      if (NotifyMode && !NOTIFY_MODES.has(NotifyMode)) {
        return req.error(400, getLocalizedMessage(req, 'jnNotifyModeInvalid', 'adminconfigplant'), 'NotifyMode');
      }

      // Safety-net di unicita': @assert.unique e' SOLO compile-time (genera l'indice DB, non
      // un handler runtime), quindi la violazione tornerebbe come errore driver 500 senza
      // messaggio utile. Stesso motivo del safety-net in validateAutoAssign qui sopra.
      const clash = await SELECT.one.from(ZJobNotifyRecipient).where({
        Plant, JobCode, Email,
        ...(req.data.ID ? { ID: { '!=': req.data.ID } } : {})
      });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'jnDuplicate', 'adminconfigplant'), 'Email');
      }
    }

    this.before('CREATE', 'ZJobNotifyRecipient', validateJobNotify);
    this.before('UPDATE', 'ZJobNotifyRecipient', validateJobNotify);

    // ================================================================
    // FEATURE 0014 — Configurazione dell'ordinamento della lista di lavoro Plex.
    // Una riga per plant; l'elenco degli stati congelati e' normalizzato al salvataggio, cosi'
    // che cio' che l'amministratore vede sia cio' che verra' trasmesso (FR-16).
    // ================================================================
    const { ZPlexJobSortConfig } = this.entities;
    const jobSortRules = require('./lib/plexJobSortRules');
    const { invalidateJobSortConfigCache } = require('./lib/plexJobSort');

    async function validateJobSortConfig(req) {
      // Su UPDATE la PATCH puo' portare UN SOLO campo: senza il merge, la validazione di
      // unicita' e di lunghezza girerebbe su una riga incompleta (stesso motivo di
      // validateJobNotify e validateAutoAssign).
      // La chiave, su una PATCH per chiave tecnica, arriva da req.params e NON dal payload:
      // leggerla dal solo req.data.ID farebbe girare la validazione su una riga vuota e
      // farebbe scattare «plant obbligatorio» su una PATCH legittima di un solo campo
      // (contratto §B.6.3).
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(ZPlexJobSortConfig).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      // Normalizzazione del plant come nelle altre tab (maiuscolo, senza spazi).
      if (req.data.Plant !== undefined) req.data.Plant = String(req.data.Plant || '').trim().toUpperCase();
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      const { Plant } = row;
      if (!Plant) {
        return req.error(400, getLocalizedMessage(req, 'jsortPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'jsortPlantFormat', 'adminconfigplant'), 'Plant');
      }

      // --- elenco stati congelati: normalizzazione POI validazione (FDD §4.2) -----------
      if (row.FrozenJobStatusList !== undefined && row.FrozenJobStatusList !== null) {
        const check = jobSortRules.validateFrozenList(row.FrozenJobStatusList);
        for (const e of check.errors) {
          if (e.code === 'TOKEN_FORM') {
            return req.error(400,
              getLocalizedMessage(req, 'jsortTokenInvalid', 'adminconfigplant', e.token),
              'FrozenJobStatusList');
          }
          if (e.code === 'TOO_LONG') {
            return req.error(400,
              getLocalizedMessage(req, 'jsortListTooLong', 'adminconfigplant', e.length),
              'FrozenJobStatusList');
          }
        }
        // Il valore NORMALIZZATO e' quello che si persiste: e' l'unico modo perche' cio' che si
        // vede, cio' che si memorizza e cio' che si trasmette siano lo stesso (FR-16).
        // I token NON riconosciuti non bloccano (M-11 e' un avviso della schermata, Q-02).
        req.data.FrozenJobStatusList = check.value;
      }

      // Safety-net di unicita': @assert.unique e' SOLO compile-time (genera l'indice, non un
      // handler), quindi la violazione tornerebbe come errore driver 500 senza messaggio utile.
      // Stesso motivo del safety-net in validateJobNotify.
      const clash = await SELECT.one.from(ZPlexJobSortConfig).where({
        Plant,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'jsortDuplicate', 'adminconfigplant', Plant), 'Plant');
      }
    }

    this.before('CREATE', 'ZPlexJobSortConfig', validateJobSortConfig);
    this.before('UPDATE', 'ZPlexJobSortConfig', validateJobSortConfig);
    // ATTENZIONE, verificato contro il service reale (deviazione D-1 del TDD 0014 §13 e
    // contratto §B.5 regola 5): la validazione di tipo GENERICA di CAP gira nella fase
    // `_initial`, cioe' PRIMA di qualunque before handler dell'applicazione e prima di
    // `prepend` (che agisce sulle fasi on/before/after, non su `_initial`:
    // node_modules/@sap/cds/libx/_runtime/common/generic/input.js, `validate_input._initial`).
    // Ne segue che un valore di FrozenJobStatusList piu' lungo di 200 caratteri viene
    // rifiutato da CAP con `ASSERT_DATA_TYPE` («is not a valid String(200)») e NON arriva mai
    // qui: la nostra M-10 (jsortListTooLong) non e' raggiungibile via OData, e il limite di
    // fatto si misura sul testo DIGITATO e non sul valore NORMALIZZATO. Il controllo TOO_LONG
    // qui sopra resta come rete di sicurezza — per un chiamante non-OData e per il giorno in
    // cui la colonna o il tipo cambiassero — e perche' e' la regola dichiarata nel contratto.
    // Nell'app il caso e' comunque fuori portata: l'Input ha maxLength=200.

    // La cache della configurazione e' module-scoped in srv/lib/plexJobSort.js, come
    // activePlantsCache: condivisa da tutte le istanze di servizio del processo, quindi va
    // invalidata quando il customizing cambia, altrimenti la modifica avrebbe effetto solo
    // allo scadere del TTL (FR-27).
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'ZPlexJobSortConfig', (data, req) => {
      const plant = (req && req.data && req.data.Plant) || (data && data.Plant);
      invalidateJobSortConfigCache(plant);   // senza plant: svuota tutto (una DELETE per
                                             // chiave tecnica non porta il plant nel payload)
    });

    // ================================================================
    // [ROUTING-FILTER] REGOLE DI VISIBILITA' DEI CICLI (feature 0016)
    // Customizing per plant: quali cicli SAP compaiono in lista, per combinazione di stato e
    // utilizzo. Semantica e confronto in srv/lib/routingVisibility.js.
    // ================================================================
    const { ZRoutingFilterConfig } = this.entities;

    /**
     * Validazione di una regola di visibilita'. Sul modello di validateJobSortConfig: la chiave,
     * su una PATCH per chiave tecnica, arriva da `req.params` e NON dal payload — leggerla dal
     * solo `req.data.ID` farebbe girare la validazione su una riga vuota e farebbe scattare
     * «plant obbligatorio» su una PATCH legittima di un solo campo.
     */
    async function validateRoutingFilter(req) {
      // [ROW-KEY] L'estrazione era scritta qui a mano ed era l'unica delle tre corretta: ora e' in
      // un punto solo, cosi' le altre due non possono tornare a divergere.
      const rowId = rowKeyOf(req);
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(ZRoutingFilterConfig).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      // Normalizzazione del plant come nelle altre tab (maiuscolo, senza spazi).
      if (req.data.Plant !== undefined) req.data.Plant = String(req.data.Plant || '').trim().toUpperCase();
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      const { Plant } = row;
      if (!Plant) {
        return req.error(400, getLocalizedMessage(req, 'rfPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'rfPlantFormat', 'adminconfigplant'), 'Plant');
      }

      // I due codici si NORMALIZZANO CON IL SOLO `trim`: si persiste cio' che l'utente ha
      // scritto. La tolleranza agli zeri iniziali vive nel CONFRONTO
      // (routingVisibility.codeMatches), non nel dato — riscriverlo qui significherebbe
      // mostrare all'utente un valore diverso da quello che ha digitato.
      for (const f of ['BillOfOperationsStatus', 'BillOfOperationsUsage']) {
        if (req.data[f] !== undefined) req.data[f] = String(req.data[f] ?? '').trim();
        row[f] = String(row[f] ?? '').trim();
      }

      // LA VALIDAZIONE CHE CONTA. Una regola senza alcun criterio aggancia QUALUNQUE ciclo,
      // cioe' disattiva in silenzio l'intero filtro: una riga aggiunta per sbaglio e mai
      // compilata farebbe ricomparire tutto senza che nulla lo spieghi.
      if (!row.BillOfOperationsStatus && !row.BillOfOperationsUsage) {
        return req.error(400, getLocalizedMessage(req, 'rfCriteriaMandatory', 'adminconfigplant'),
          'BillOfOperationsStatus');
      }

      // Safety-net di unicita': @assert.unique e' SOLO compile-time (genera l'indice, non un
      // handler), quindi la violazione tornerebbe come errore driver 500 senza messaggio utile.
      const clash = await SELECT.one.from(ZRoutingFilterConfig).where({
        Plant,
        BillOfOperationsStatus: row.BillOfOperationsStatus,
        BillOfOperationsUsage: row.BillOfOperationsUsage,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'rfDuplicate', 'adminconfigplant',
          row.BillOfOperationsStatus || '-', row.BillOfOperationsUsage || '-'), 'BillOfOperationsStatus');
      }
    }

    this.before('CREATE', 'ZRoutingFilterConfig', validateRoutingFilter);
    this.before('UPDATE', 'ZRoutingFilterConfig', validateRoutingFilter);
    // Nessuna cache da invalidare: le regole si rileggono a ogni READ della lista (tabella
    // locale, una query). E' la scelta di materialVisibility.js, non quella di plexJobSort.js:
    // qui una modifica del customizing deve avere effetto al primo refresh, non allo scadere
    // di un TTL.

    // ================================================================
    // [ORDER-STATUS-FILTER] PERIMETRO DEGLI ORDINI PER STATO (feature 0017)
    // Customizing per plant: quali ordini SAP entrano in perimetro, per flag di stato della
    // testata. Vale per la lista del cockpit, per il job pianificato e per le due azioni
    // manuali. Semantica e catalogo in srv/lib/prodOrderStatusFilter.js.
    // ================================================================
    const { ZProdOrderFilterConfig } = this.entities;

    /**
     * Validazione e NORMALIZZAZIONE delle due liste. Stessa meccanica di validateRoutingFilter
     * per la chiave (su una PATCH per chiave tecnica il plant arriva da `req.params`, non dal
     * payload), ma qui la normalizzazione RISCRIVE il dato: le due liste sono un formato
     * interno, non testo dell'utente, e cio' che si salva dev'essere cio' che verra' valutato.
     * La UI rilegge il valore normalizzato dopo il salvataggio (pattern 0014).
     */
    async function validateProdOrderFilter(req) {
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(ZProdOrderFilterConfig).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      if (req.data.Plant !== undefined) req.data.Plant = String(req.data.Plant || '').trim().toUpperCase();
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      const { Plant } = row;
      if (!Plant) {
        return req.error(400, getLocalizedMessage(req, 'osfPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'osfPlantFormat', 'adminconfigplant'), 'Plant');
      }

      const verdict = prodOrderStatusFilter.validateFilter(row);
      for (const err of verdict.errors) {
        const tokens = (err.tokens || []).join(', ');
        if (err.code === 'unknown') {
          return req.error(400, getLocalizedMessage(req, 'osfUnknownStatus', 'adminconfigplant', tokens),
            err.field);
        }
        if (err.code === 'contradiction') {
          return req.error(400, getLocalizedMessage(req, 'osfContradiction', 'adminconfigplant', tokens),
            err.field);
        }
        // [W1-09] Un codice piu' lungo del campo DDIC non puo' esistere in SAP: e' un errore di
        // battitura che filtrerebbe a vuoto, e con un perimetro fail-closed «filtra a vuoto»
        // significa un plant fermo. Non esiste altro controllo possibile: AUART e FEVOR sono
        // customizing del cliente e non abbiamo un indirizzo per leggerne il catalogo.
        if (err.code === 'codeTooLong') {
          return req.error(400, getLocalizedMessage(req, 'osfCodeTooLong', 'adminconfigplant',
            tokens, String(err.max)), err.field);
        }
        return req.error(400, getLocalizedMessage(req, 'osfListTooLong', 'adminconfigplant',
          String(prodOrderStatusFilter.LIST_MAX_LENGTH)), err.field);
      }

      // Si riscrivono SEMPRE tutte e quattro: su una PATCH di una sola lista, le altre sono
      // quelle esistenti e riscriverle identiche non fa danno, mentre non riscrivere quella
      // toccata salverebbe il testo grezzo dell'utente.
      req.data.RequiredStatuses = verdict.RequiredStatuses;
      req.data.ExcludedStatuses = verdict.ExcludedStatuses;
      // [W1-09] Qui la normalizzazione riscrive il dato SOLO su separatore, spazi, duplicati e
      // maiuscole — che sono la forma con cui SAP stesso tiene AUART e FEVOR
      // (@sap.display.format:'UpperCase'). Gli zeri iniziali NON si toccano: quelli li normalizza
      // il confronto (DEC-51), e riscriverli sarebbe modificare il valore dell'utente.
      for (const c of prodOrderStatusFilter.VALUE_CRITERIA) req.data[c.list] = verdict[c.list];

      // Safety-net di unicita': @assert.unique e' SOLO compile-time, quindi la violazione
      // tornerebbe come errore driver 500 senza messaggio utile. Una seconda riga per lo stesso
      // plant renderebbe il perimetro dipendente dall'ordine di lettura.
      const clash = await SELECT.one.from(ZProdOrderFilterConfig).where({
        Plant,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'osfDuplicate', 'adminconfigplant', Plant), 'Plant');
      }
    }

    this.before('CREATE', 'ZProdOrderFilterConfig', validateProdOrderFilter);
    this.before('UPDATE', 'ZProdOrderFilterConfig', validateProdOrderFilter);
    // Nessuna cache: stessa scelta di ZRoutingFilterConfig qui sopra. Con un perimetro
    // FAIL-CLOSED un TTL sarebbe anche peggio — un plant appena configurato resterebbe senza
    // ordini per un minuto, e chi ha appena salvato penserebbe di aver sbagliato.

    // ================================================================
    // [ORDER-TECO] CHIUSURA TECNICA RIPORTATA SU PLEX (feature 0023, gap W1-13)
    // Customizing per plant: l'interruttore della scrittura verso Plex e l'elenco dei flag di
    // stato che, in OR, dicono «quest'ordine e' chiuso in SAP». Semantica in
    // srv/lib/prodOrderTeco.js, consumatore srv/jobs/closeTecoPlexJobs.js.
    // ================================================================
    const { ZProdOrderTecoConfig } = this.entities;

    /**
     * Validazione e normalizzazione dell'elenco dei trigger.
     *
     * Stessa meccanica di validateProdOrderFilter — chiave da `req.params` su una PATCH,
     * normalizzazione che RISCRIVE il dato perche' l'elenco e' un formato interno — con una
     * regola in piu': l'interruttore acceso PRETENDE almeno un criterio. Senza, la schermata
     * mostrerebbe una configurazione «attiva» che non chiude niente, indistinguibile da un
     * flusso guasto.
     */
    async function validateTecoConfig(req) {
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(ZProdOrderTecoConfig).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      if (req.data.Plant !== undefined) req.data.Plant = String(req.data.Plant || '').trim().toUpperCase();
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      const { Plant } = row;
      if (!Plant) {
        return req.error(400, getLocalizedMessage(req, 'tecoPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'tecoPlantFormat', 'adminconfigplant'), 'Plant');
      }

      const verdict = prodOrderTeco.validateTecoConfig(row);
      for (const err of verdict.errors) {
        const tokens = (err.tokens || []).join(', ');
        if (err.code === 'unknown') {
          return req.error(400, getLocalizedMessage(req, 'tecoUnknownStatus', 'adminconfigplant', tokens),
            err.field);
        }
        if (err.code === 'requiredWhenEnabled') {
          return req.error(400, getLocalizedMessage(req, 'tecoTriggersMandatory', 'adminconfigplant'),
            err.field);
        }
        return req.error(400, getLocalizedMessage(req, 'tecoListTooLong', 'adminconfigplant',
          String(prodOrderStatusFilter.LIST_MAX_LENGTH)), err.field);
      }
      req.data.TriggerStatuses = verdict.TriggerStatuses;

      // Safety-net di unicita': @assert.unique e' SOLO compile-time. Due righe per lo stesso
      // plant renderebbero il criterio dipendente dall'ordine di lettura.
      const clash = await SELECT.one.from(ZProdOrderTecoConfig).where({
        Plant,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'tecoDuplicate', 'adminconfigplant', Plant), 'Plant');
      }
    }

    this.before('CREATE', 'ZProdOrderTecoConfig', validateTecoConfig);
    this.before('UPDATE', 'ZProdOrderTecoConfig', validateTecoConfig);
    // Nessuna cache da invalidare: il job rilegge il customizing a ogni esecuzione.

    // ================================================================
    // [ORDER-COMPLETE] IL JOB PLEX COMPLETATO -> STATO UTENTE IN SAP (feature 0045, gap W1-12)
    // Customizing per plant: l'interruttore della scrittura verso SAP e l'elenco degli stati Plex
    // che valgono «finito». Semantica in srv/lib/prodOrderComplete.js, consumatore
    // srv/jobs/completeSapOrdersFromPlex.js.
    // ================================================================
    const { ZProdOrderCompleteConfig } = this.entities;

    /**
     * Validazione e normalizzazione dell'elenco degli stati Plex.
     *
     * Stessa meccanica di `validateTecoConfig`, con UNA differenza sostanziale: qui NON c'e' un
     * catalogo chiuso contro cui validare i valori, quindi non esiste l'errore `unknown`. I nomi
     * di stato di un job sono righe della tabella di setup del TENANT Plex e nessun endpoint della
     * Job Scheduling API li elenca (DEC-65): rifiutare un valore «sconosciuto» vorrebbe dire
     * inventare un catalogo, e il primo tenant con uno stato in piu' non potrebbe configurarsi.
     * La difesa e' altrove — il recap del job dichiara gli STATI DISTINTI VISTI nella finestra,
     * cosi' un refuso si legge invece di comparire come uno zero.
     *
     * Resta la regola che conta: l'interruttore acceso PRETENDE almeno uno stato. Senza, la
     * schermata mostrerebbe una configurazione «attiva» che non scrive niente.
     */
    async function validateCompleteConfig(req) {
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(ZProdOrderCompleteConfig).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      if (req.data.Plant !== undefined) {
        req.data.Plant = String(req.data.Plant || '').trim().toUpperCase();
      }
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      const { Plant } = row;
      if (!Plant) {
        return req.error(400,
          getLocalizedMessage(req, 'completePlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400,
          getLocalizedMessage(req, 'completePlantFormat', 'adminconfigplant'), 'Plant');
      }

      const verdict = prodOrderComplete.validateCompleteConfig(row);
      for (const err of verdict.errors) {
        if (err.code === 'requiredWhenEnabled') {
          return req.error(400,
            getLocalizedMessage(req, 'completeStatusesMandatory', 'adminconfigplant'), err.field);
        }
        return req.error(400, getLocalizedMessage(req, 'completeListTooLong', 'adminconfigplant',
          String(prodOrderComplete.LIST_MAX_LENGTH)), err.field);
      }
      // La normalizzazione RISCRIVE il dato: l'elenco e' un formato interno, e due grafie dello
      // stesso stato non sono due criteri.
      req.data.PlexStatuses = verdict.PlexStatuses;

      // Safety-net di unicita': @assert.unique e' SOLO compile-time. Due righe per lo stesso plant
      // renderebbero il criterio dipendente dall'ordine di lettura.
      const clash = await SELECT.one.from(ZProdOrderCompleteConfig).where({
        Plant,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400,
          getLocalizedMessage(req, 'completeDuplicate', 'adminconfigplant', Plant), 'Plant');
      }
    }

    this.before('CREATE', 'ZProdOrderCompleteConfig', validateCompleteConfig);
    this.before('UPDATE', 'ZProdOrderCompleteConfig', validateCompleteConfig);
    // Nessuna cache da invalidare: il job rilegge il customizing a ogni esecuzione.

    // ================================================================
    // [ORDER-SCHEDULED] IL JOB PLEX PIANIFICATO -> STATO UTENTE IN SAP (feature 0046, gap W1-11)
    // Gemella della precedente. La validazione usa la STESSA funzione pura del modulo condiviso —
    // `validateConfig` e' flow-free, perche' la forma della lista e la regola «acceso senza criteri
    // si rifiuta» non dipendono dal flusso — e cambiano solo l'entity e le chiavi dei messaggi.
    // ================================================================
    const { ZProdOrderScheduledConfig } = this.entities;

    async function validateScheduledConfig(req) {
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(ZProdOrderScheduledConfig).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      if (req.data.Plant !== undefined) {
        req.data.Plant = String(req.data.Plant || '').trim().toUpperCase();
      }
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      const { Plant } = row;
      if (!Plant) {
        return req.error(400,
          getLocalizedMessage(req, 'schedPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400,
          getLocalizedMessage(req, 'schedPlantFormat', 'adminconfigplant'), 'Plant');
      }

      const verdict = prodOrderScheduled.validateConfig(row);
      for (const err of verdict.errors) {
        if (err.code === 'requiredWhenEnabled') {
          return req.error(400,
            getLocalizedMessage(req, 'schedStatusesMandatory', 'adminconfigplant'), err.field);
        }
        return req.error(400, getLocalizedMessage(req, 'schedListTooLong', 'adminconfigplant',
          String(prodOrderScheduled.LIST_MAX_LENGTH)), err.field);
      }
      // La normalizzazione RISCRIVE il dato: due grafie dello stesso stato non sono due criteri.
      req.data.PlexStatuses = verdict.PlexStatuses;

      // Safety-net di unicita': @assert.unique e' SOLO compile-time.
      const clash = await SELECT.one.from(ZProdOrderScheduledConfig).where({
        Plant,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400,
          getLocalizedMessage(req, 'schedDuplicate', 'adminconfigplant', Plant), 'Plant');
      }
    }

    this.before('CREATE', 'ZProdOrderScheduledConfig', validateScheduledConfig);
    this.before('UPDATE', 'ZProdOrderScheduledConfig', validateScheduledConfig);
    // Nessuna cache da invalidare: il job rilegge il customizing a ogni esecuzione.

    /**
     * [ORDER-STATUS-FILTER] Il catalogo dei nomi ammessi, per i due elenchi della UI.
     * `contracted` distingue i quattro flag gia' dichiarati nel contratto iFlow E-12/E-13 dagli
     * altri sedici, che esistono nella struttura ABAP ma la cui presenza nella risposta va
     * verificata sul filo: la UI lo dice PRIMA che qualcuno ci costruisca sopra un perimetro.
     */
    const OSF_CONTRACTED = new Set([
      'OrderIsReleased', 'OrderIsConfirmed', 'OrderIsClosed', 'OrderIsDeleted',
      // [ORDER-TECO] Confermato dal team Integration: l'iFlow lo mappa nella risposta. E' il flag
      // su cui si regge la chiusura tecnica (feature 0023), e senza questa riga la sua scheda
      // mostrerebbe come «da verificare» proprio il criterio per cui esiste.
      'OrderIsTechnicallyCompleted'
    ]);
    this.on('prodOrderStatusCatalog', async () => prodOrderStatusFilter.STATUS_CATALOG.map((code) => ({
      code,
      contracted: OSF_CONTRACTED.has(code)
    })));

    // ================================================================
    // [PHANTOM-EXPLODE] FEATURE 0019 — Esplosione dei componenti fantasma.
    // Una riga per plant, editata da TRE schede di adminconfigplant: «Distinta base» per i
    // parametri del motore, «Cicli di lavorazione» e «Ordini di produzione» per i due
    // interruttori. Una riga sola, quindi un solo update group e un solo validatore.
    // ================================================================
    const { ZPhantomExplodeConfig } = this.entities;
    // `bomExplodeRules` e' ora importato in testa al file: dalla W1-05 lo usa anche il punto unico
    // dei componenti del ciclo, non piu' il solo validatore di questa scheda.
    const { invalidateExplodeConfigCache } = require('./lib/bomExplode');

    async function validatePhantomExplodeConfig(req) {
      // Stessa meccanica di chiave degli altri tre validatori: su una PATCH per chiave tecnica
      // il payload porta UN SOLO campo, quindi senza il merge con l'esistente la validazione
      // girerebbe su una riga incompleta e «plant obbligatorio» scatterebbe su una PATCH
      // legittima.
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(ZPhantomExplodeConfig).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      if (req.data.Plant !== undefined) req.data.Plant = String(req.data.Plant || '').trim().toUpperCase();
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      const { Plant } = row;
      if (!Plant) {
        return req.error(400, getLocalizedMessage(req, 'phxPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'phxPlantFormat', 'adminconfigplant'), 'Plant');
      }

      // Normalizzazione dei due codici distinta: solo trim e maiuscolo. NIENTE padStart —
      // allineare '1' a '01' significherebbe decidere il formato di SAP, e qui i due lati del
      // confronto sono entrambi SAP (DEC-51: fra chiavi SAP il confronto e' STRETTO).
      for (const f of ['BomUsage', 'BomVariant']) {
        if (req.data[f] !== undefined) req.data[f] = String(req.data[f] || '').trim().toUpperCase();
        row[f] = String(row[f] || '').trim().toUpperCase();
      }
      if (req.data.EffectivityDateMode !== undefined) {
        req.data.EffectivityDateMode = String(req.data.EffectivityDateMode || '').trim().toUpperCase();
      }
      row.EffectivityDateMode = String(row.EffectivityDateMode || '').trim().toUpperCase();
      // [ROUTING-DEFAULT-OP] Il bersaglio dell'allocazione dichiarata: trim e maiuscolo, come i due
      // codici distinta. La normalizzazione RISCRIVE il dato, o 'first_op' si salverebbe cosi' e il
      // confronto di `compDefaultOp` — che e' stretto sul valore normalizzato — lo scarterebbe.
      if (req.data.RoutingCompDefaultOpTarget !== undefined) {
        req.data.RoutingCompDefaultOpTarget =
          String(req.data.RoutingCompDefaultOpTarget || '').trim().toUpperCase();
      }
      row.RoutingCompDefaultOpTarget = String(row.RoutingCompDefaultOpTarget || '').trim().toUpperCase();

      // Le regole vivono nel modulo puro, con il loro test: qui si traducono in messaggi.
      // [ROUTING-DEFAULT-OP] Due moduli e non uno: il bersaglio e' validato accanto alle sentinelle
      // FIRST_OP/LAST_OP che `routingCompSourceRules` dichiara gia', per non scriverle una terza
      // volta — e `bomExplodeRules` non ha dipendenze, che e' una proprieta' da non rompere.
      const errors = bomExplodeRules.validateConfig(row)
        .concat(routingCompRules.validateCompDefaultOp(row));
      for (const e of errors) {
        return req.error(400, getLocalizedMessage(req, e.key, 'adminconfigplant', ...e.args), e.field);
      }

      // Safety-net di unicita': @assert.unique e' SOLO compile-time (genera l'indice, non un
      // handler), quindi la violazione tornerebbe come errore driver 500 senza messaggio utile.
      // Due righe per lo stesso plant renderebbero l'esplosione dipendente dall'ordine di lettura.
      const clash = await SELECT.one.from(ZPhantomExplodeConfig).where({
        Plant,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'phxDuplicate', 'adminconfigplant', Plant), 'Plant');
      }
    }

    this.before('CREATE', 'ZPhantomExplodeConfig', validatePhantomExplodeConfig);
    this.before('UPDATE', 'ZPhantomExplodeConfig', validatePhantomExplodeConfig);

    // Qui la cache C'E' (a differenza dei due filtri qui sopra) perche' la configurazione viene
    // letta una volta per OGNI ciclo e per OGNI ordine trattato, non una volta per esecuzione:
    // senza, un job su qualche centinaio di oggetti farebbe altrettante SELECT identiche.
    // Il TTL e' la rete; l'invalidazione esplicita e' il meccanismo, come per il job sort.
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'ZPhantomExplodeConfig', async (_data, req) => {
      const plant = (req.data && req.data.Plant) ? String(req.data.Plant).trim().toUpperCase() : null;
      // Su DELETE il plant non e' nel payload: si svuota tutto. E' raro e costa una SELECT.
      invalidateExplodeConfigCache(plant || undefined);
    });

    // ================================================================
    // [CONF-POSTING] FEATURE 0028 — Consumi e scarti della consuntivazione, per plant.
    // Una riga per plant, editata dalla scheda «Consuntivazione» di adminconfigplant. Governa i
    // documenti materiale che il job PROD_CONF costruisce da una registrazione Plex: QUANDO si
    // consumano i componenti (BBP §8.3.3) e che sorte hanno quando un pezzo viene SCARTATO
    // (§8.4.1, che chiede il CONSUMO). I default riproducono il comportamento di prima della 0028.
    //
    // DALLA 0030 la stessa riga dice anche CHI porta in SAP la produzione: i nostri due documenti
    // (`ProdPosting='MATDOC'`, il default) oppure una CONFERMA D'ORDINE (`'CONF'`), dove i movimenti
    // li fa SAP. `ConfPostEnabled` e' l'interruttore della scrittura della conferma, e non e'
    // `ZPlant.MatDocPostEnabled`: quello e' la modalita' di PROVA dei movimenti merci, mentre la
    // conferma non ha una modalita' di prova — l'unico annullamento e' uno storno in CO13.
    // ================================================================
    const { ZProdConfPostingConfig } = this.entities;
    const confPostingRules = require('./lib/confPostingRules');
    const { invalidateConfPostingConfigCache } = require('./lib/confPostingConfig');

    async function validateConfPostingConfig(req) {
      // Stessa meccanica di chiave degli altri validatori: su una PATCH per chiave tecnica il
      // payload porta UN SOLO campo, quindi senza il merge con l'esistente la validazione girerebbe
      // su una riga incompleta — e qui il danno sarebbe peggiore che «plant obbligatorio»: la
      // combinazione a doppio addebito e' fra DUE campi, e con uno solo in mano non si vede.
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(ZProdConfPostingConfig).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      if (req.data.Plant !== undefined) req.data.Plant = String(req.data.Plant || '').trim().toUpperCase();
      row.Plant = String(row.Plant || '').trim().toUpperCase();

      const { Plant } = row;
      if (!Plant) {
        return req.error(400, getLocalizedMessage(req, 'cpcPlantMandatory', 'adminconfigplant'), 'Plant');
      }
      if (!/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'cpcPlantFormat', 'adminconfigplant'), 'Plant');
      }

      // Le regole stanno nel modulo puro, con il loro test: qui si traducono in messaggi. Il `code`
      // che torna E' la chiave i18n, come per orderCompExclRules.
      const verdict = confPostingRules.validateConfig(row);
      if (!verdict.ok) {
        return req.error(400,
          getLocalizedMessage(req, verdict.code, 'adminconfigplant', verdict.param || ''),
          verdict.field);
      }

      // NORMALIZZAZIONE IN SCRITTURA: cio' che si memorizza, cio' che si mostra e cio' che si manda
      // devono essere lo stesso valore. Le cinque modalita' vanno in forma canonica (maiuscolo) e la
      // causale a quattro cifre con gli zeri davanti: chi digita `13` intende `0013`, e vederlo a
      // schermo e' cio' che rende verificabile quello che parte.
      const canon = confPostingRules.normalizeConfig(row);
      for (const f of ['ProdPosting', 'ConsumeAt', 'ScrapConsume', 'ScrapMove', 'ScrapIssue',
        'ScrapNoOrder', 'ScrapStorLoc', 'ScrapReason']) {
        if (req.data[f] !== undefined) req.data[f] = canon[f];
      }

      // Safety-net di unicita': @assert.unique e' SOLO compile-time, quindi la violazione tornerebbe
      // come errore driver 500. Due righe per lo stesso plant renderebbero il comportamento del job
      // dipendente dall'ordine di lettura — su un flusso con effetti contabili.
      const clash = await SELECT.one.from(ZProdConfPostingConfig).where({
        Plant,
        ...(rowId ? { ID: { '!=': rowId } } : {})
      });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'cpcDuplicate', 'adminconfigplant', Plant), 'Plant');
      }
    }

    this.before('CREATE', 'ZProdConfPostingConfig', validateConfPostingConfig);
    this.before('UPDATE', 'ZProdConfPostingConfig', validateConfPostingConfig);

    this.after(['CREATE', 'UPDATE', 'DELETE'], 'ZProdConfPostingConfig', async (_data, req) => {
      const plant = (req.data && req.data.Plant) ? String(req.data.Plant).trim().toUpperCase() : null;
      // Su DELETE il plant non e' nel payload: si svuota tutto. E' raro e costa una SELECT.
      invalidateConfPostingConfigCache(plant || undefined);
    });

    // ================================================================
    // [PLEX-CONN] Connessione a Plex, per plant (feature 0020)
    //
    // Sostituisce gli handler di ZPlexCredentials, che governavano l'unicita' di ConfigName e il
    // flag IsDefault «uno solo in tutto il sistema» — due meccaniche che il per-plant rende prive
    // di senso: la riga giusta ora e' quella del plant, e non c'e' piu' niente da eleggere.
    //
    // La differenza che conta rispetto a ogni altro customizing di questa app: qui c'e' un GATE DI
    // RUOLO LATO SERVER. Le altre tab riservate si nascondono nella UI, e basta perche' espongono
    // configurazione; questa espone due SEGRETI, e una tab nascosta non impedisce a nessuno di
    // chiamare l'URL OData a mano. Il ruolo richiesto e' 'admin' pieno: 'admin-config' non passa.
    // ================================================================
    const { ZPlexConnConfig } = this.entities;

    /** Plant della riga indirizzata da una UPDATE/DELETE per chiave (il payload puo' non averlo). */
    async function connPlantOf(req) {
      if (req.data && req.data.Plant) return String(req.data.Plant).trim();
      const key = req.params && req.params[0];
      const ID = key && typeof key === 'object' ? key.ID : key;
      if (!ID) return null;
      const row = await SELECT.one.from(ZPlexConnConfig).columns('Plant').where({ ID });
      return row ? row.Plant : null;
    }

    /**
     * Applica le regole pure di srv/lib/plexConnRules.js e trasforma i difetti in errori OData
     * localizzati, uno per campo. `partial` distingue la CREATE (campo assente = mancante) dalla
     * UPDATE (si verifica solo cio' che il payload porta).
     * @returns {boolean} true se la richiesta e' stata RIFIUTATA
     */
    function rejectIfConnInvalid(req, data, partial) {
      const errors = plexConnRules.validateConnection(data, { partial });
      for (const e of errors) {
        req.error(400, getLocalizedMessage(req, e.code, 'adminconfigplant'), e.field);
      }
      return errors.length > 0;
    }

    /**
     * Plant a cui una lettura è circoscritta, o null se la lettura le abbraccia tutte.
     * Due forme, entrambe necessarie: la schermata filtra per `Plant`, mentre la RILETTURA che
     * CAP fa da sé dopo una CREATE/UPDATE indirizza per `ID` — senza il secondo ramo un
     * salvataggio riuscito verrebbe rifiutato mentre si rilegge ciò che ha appena scritto.
     */
    async function connReadPlant(req) {
      // DUE posti in cui cercare, e servono entrambi: un filtro `?$filter=Plant eq '...'` finisce
      // in `SELECT.where`, mentre un accesso PER CHIAVE — `ZPlexConnConfig(ID=...)`, che è anche
      // la forma della rilettura automatica dopo una CREATE/UPDATE — mette il predicato dentro
      // `SELECT.from.ref[0].where`. Guardando solo il primo, un salvataggio riuscito veniva
      // rifiutato mentre rileggeva ciò che aveva appena scritto.
      const scan = (where) => {
        const out = { plant: null, id: null };
        if (!Array.isArray(where)) return out;
        for (let i = 0; i < where.length; i++) {
          const field = where[i]?.ref?.[0];
          const val = where[i + 2]?.val;
          if (val === undefined || val === null) continue;
          if (field === 'Plant') out.plant = String(val).trim();
          else if (field === 'ID') out.id = String(val);
        }
        return out;
      };

      const fromRef = req.query?.SELECT?.from?.ref;
      const fromWhere = Array.isArray(fromRef) && fromRef[0] && typeof fromRef[0] === 'object'
        ? fromRef[0].where
        : null;
      const a = scan(req.query?.SELECT?.where);
      const b = scan(fromWhere);
      if (a.plant) return a.plant;
      if (b.plant) return b.plant;

      const key = req.params && req.params[0];
      const paramId = key && typeof key === 'object' ? key.ID : key;
      const ID = a.id || b.id || paramId;
      if (!ID) return null;
      const row = await SELECT.one.from(ZPlexConnConfig).columns('Plant').where({ ID });
      return row ? row.Plant : null;
    }

    // BEFORE READ — gate di ruolo. Una lettura deve essere circoscritta a UN plant: la schermata
    // filtra sempre per plant, e una lettura senza plant verrebbe da qualcuno che sta guardando
    // le righe — cioè i segreti — di tutti. Fail-closed: niente plant, niente lettura.
    this.before('READ', 'ZPlexConnConfig', async (req) => {
      const plant = await connReadPlant(req);
      if (!plant) {
        return req.reject(400, getLocalizedMessage(req, 'plexConnPlantFilterMandatory', 'adminconfigplant'));
      }
      await rejectIfNotFullAdmin(req, plant);
    });

    // BEFORE CREATE — gate di ruolo + validazione + unicita' del plant
    this.before('CREATE', 'ZPlexConnConfig', async (req) => {
      const { Plant } = req.data;
      if (await rejectIfNotFullAdmin(req, Plant && String(Plant).trim())) return;

      const existing = await SELECT.one.from(ZPlexConnConfig).where({ Plant });
      if (existing) {
        return req.error(400, getLocalizedMessage(req, 'plexConnAlreadyExists', 'adminconfigplant', Plant), 'Plant');
      }
      if (rejectIfConnInvalid(req, req.data, false)) return;
      // Cio' che si vede e' cio' che viene usato: gli spazi ai bordi si tolgono al salvataggio,
      // non alla chiamata. La password resta intatta.
      Object.assign(req.data, plexConnRules.normalizeConnection(req.data));
      console.log(`>>> [PLEX-CONN] creazione della connessione del plant ${Plant}`);
    });

    // BEFORE UPDATE — gate di ruolo + validazione dei soli campi presenti nel payload
    this.before('UPDATE', 'ZPlexConnConfig', async (req) => {
      const plant = await connPlantOf(req);
      if (await rejectIfNotFullAdmin(req, plant)) return;
      // Il plant serve anche all'after: su una UPDATE per chiave non è nel payload.
      req._plexConnPlant = plant;

      // `partial: true`: una UPDATE porta i soli campi toccati, e un campo assente non è un campo
      // mancante.
      if (rejectIfConnInvalid(req, req.data, true)) return;
      Object.assign(req.data, plexConnRules.normalizeConnection(req.data));
      console.log(`>>> [PLEX-CONN] aggiornamento della connessione del plant ${plant}`);
    });

    // BEFORE DELETE — gate di ruolo (il plant si ricava dalla riga)
    this.before('DELETE', 'ZPlexConnConfig', async (req) => {
      const plant = await connPlantOf(req);
      if (await rejectIfNotFullAdmin(req, plant)) return;
      // Il plant serve anche all'after, che sul DELETE non trova nulla nel payload.
      req._plexConnPlant = plant;
    });

    // AFTER CREATE/UPDATE/DELETE — invalidazione MIRATA della cache del plant toccato.
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'ZPlexConnConfig', async (_data, req) => {
      const plant = (req.data && req.data.Plant) || req._plexConnPlant || null;
      // Plant non ricavabile (UPDATE per chiave senza Plant nel payload): si svuota tutto. Costa
      // una rilettura per plant ed evita di lasciare in cache una connessione appena cambiata.
      invalidatePlexConnection(plant || undefined);
    });
  }

  // ================================================================
  // ROUTING TEMPLATE SERVICE - Reusable Plex routing templates
  // (header + operations + approved workcenters), scoped per plant.
  // Batch write via saveRoutingTemplate (delete-then-insert on the
  // children), same shape as ProductionRouting.saveRoutingPlexCycle.
  // ================================================================
  if (this.name === 'RoutingTemplate') {
    const APP = 'marsplm-sap2plex';
    const { RoutingTemplates } = this.entities;

    // ================================================================
    // [PLANT-ACCESS] LE LETTURE DEI TEMPLATE (feature 0048).
    //
    // Questo service non aveva NESSUN gate, di nessun tipo: né sulle action né sulle tre entity.
    // Le action sono coperte sopra; qui le letture, che sono la strada più corta — una GET su
    // `/routing-templates/RoutingTemplates` rendeva i template di ogni plant, e le due figlie la
    // loro intera tabella.
    //
    // LA TESTATA E I FIGLI SI PROTEGGONO IN DUE MODI DIVERSI, perché hanno due forme diverse:
    //   - `RoutingTemplates` HA la colonna `Plant`, quindi si filtra sul perimetro, come i log;
    //   - le due figlie NON l'hanno (solo `TemplateID`, db/schema.cds): là il filtro non è
    //     esprimibile, e il gate è il RIFIUTO DI UNA LETTURA SENZA CRITERI — la stessa difesa di
    //     `plexCycleRefused` sui figli dell'ordine. Il client le chiede sempre con
    //     `$filter=TemplateID eq …`, quindi il criterio c'è.
    //
    // Il prezzo dei figli si dichiara: con un `TemplateID` in mano si leggono le operazioni di un
    // template di un altro plant. È un UUID, non si indovina — ma non è un segreto, sta negli URL.
    // Chiuderlo vorrebbe dire una join sulla testata a ogni READ; se servirà, il punto è questo.
    // ================================================================
    /** Un `TemplateID` che nessuna riga può avere: rende una lista VUOTA, non un errore. */
    const TEMPLATE_NONE = '00000000-0000-0000-0000-000000000000';

    this.before('READ', 'RoutingTemplates', async (req) => {
      const allowed = [...(await getUserPlants(req))];
      req.query.where(allowed.length ? { Plant: { in: allowed } } : { Plant: '#NONE' });
    });

    for (const entity of ['RoutingTemplateOperations', 'RoutingTemplateWorkcenters', 'RoutingTemplateGroups']) {
      this.before('READ', entity, (req) => {
        const { equals } = keyReadRules.equalitiesOf(
          keyReadRules.readWhere(req.query), ['TemplateID', 'ID']
        );
        if (Object.keys(equals).length) return;
        console.log(`>>> [PLANT-ACCESS] READ ${entity} senza alcun criterio: RIFIUTATA`
          + ' (renderebbe la tabella intera, di tutti i plant)');
        req.query.where({ TemplateID: TEMPLATE_NONE });
      });
    }

    // [TEMPLATE-GROUP] La value help dei gruppi HA la colonna `Plant`, quindi si filtra sul
    // perimetro come la testata dei template qui sopra — non con il rifiuto dei figli, che e' la
    // difesa di chi il plant non ce l'ha. Senza questa riga il popover dell'editor template sarebbe
    // la strada piu' corta per leggere i gruppi oggetti di ogni plant licenziato (feature 0048).
    this.before('READ', 'ObjectGroupVH', async (req) => {
      const allowed = [...(await getUserPlants(req))];
      req.query.where(allowed.length ? { Plant: { in: allowed } } : { Plant: '#NONE' });
    });

    // Next numeric template code for a plant (MAX+1). Codes are stored as strings but
    // hold numeric content, so we parse and compute the max (a string orderBy would sort
    // "10" before "9"). NOTE: not concurrency-safe; acceptable in dev, on HANA prod a DB
    // sequence could be used instead.
    async function nextTemplateCode(db, Plant) {
      const { ZPlexRoutingTemplate } = db.entities('avvaleplm.marsplm.sap2plex');
      const rows = await db.run(SELECT.from(ZPlexRoutingTemplate).columns('TemplateCode').where({ Plant }));
      let max = 0;
      for (const r of rows) {
        const n = parseInt(r.TemplateCode, 10);
        if (!isNaN(n) && n > max) max = n;
      }
      return String(max + 1);
    }

    this.on('getNextTemplateCode', async (req) => {
      const { Plant } = req.data;
      if (!Plant || String(Plant).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'rtPlantMandatory', APP), 'Plant');
      }
      // [PLANT-ACCESS] Il plant arriva dal CLIENT, e la scheda template si apre da un URL che lo
      // porta (feature 0048): senza gate, chiunque digitasse `#/routingTemplateDetail/9999/new`
      // otteneva il prossimo codice di un plant non suo. Ruolo solo, come le altre del catalogo:
      // un template si costruisce mentre si configura un plant, che nasce `InProgress`.
      if (await rejectIfNoPlantRole(req, String(Plant).trim())) return;
      const db = await cds.connect.to('db');
      return { code: await nextTemplateCode(db, Plant) };
    });

    // Validation for direct CRUD on the header (mandatory Plant/TemplateCode + unique per plant).
    // The @assert.unique.plantCode annotation also enforces uniqueness at DB level; this gives a
    // friendly localized message. On UPDATE we merge req.data with the stored row.
    async function validateRoutingTemplate(req) {
      const isUpdate = req.event === 'UPDATE';
      let row = { ...req.data };
      if (isUpdate) {
        const existing = await SELECT.one.from(RoutingTemplates).where({ ID: req.data.ID });
        if (existing) row = { ...existing, ...req.data };
      }
      const { Plant, TemplateCode } = row;
      if (!Plant || String(Plant).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'rtPlantMandatory', APP), 'Plant');
      }
      if (Plant && !/^[A-Z0-9]{1,4}$/.test(Plant)) {
        return req.error(400, getLocalizedMessage(req, 'rtPlantFormat', APP), 'Plant');
      }
      if (!TemplateCode || String(TemplateCode).trim() === '') {
        return req.error(400, getLocalizedMessage(req, 'rtCodeMandatory', APP), 'TemplateCode');
      }
      const clash = await SELECT.one.from(RoutingTemplates).where({ Plant, TemplateCode, ID: { '!=': req.data.ID } });
      if (clash) {
        return req.error(400, getLocalizedMessage(req, 'rtCodeAlreadyExists', APP), 'TemplateCode');
      }
    }
    this.before('CREATE', 'RoutingTemplates', validateRoutingTemplate);
    this.before('UPDATE', 'RoutingTemplates', validateRoutingTemplate);

    // Batch save: create (empty ID) or update a template header, then replace all of its
    // operations and approved workcenters.
    this.on('saveRoutingTemplate', async (req) => {
      let { ID, Plant, TemplateCode, Description, Operations } = req.data;
      // [PLANT-ACCESS] Questa PERSISTE un template sul plant che il client dichiara, e in UPDATE il
      // `Plant` del payload sovrascrive quello della riga: senza gate si poteva scrivere — e
      // spostare — un template su un plant qualsiasi (feature 0048).
      if (await rejectIfNoPlantRole(req, Plant && String(Plant).trim())) return;
      const db = await cds.connect.to('db');
      const {
        ZPlexRoutingTemplate, ZPlexRoutingTemplateOperation, ZPlexRoutingTemplateWorkcenter,
        ZPlexRoutingTemplateGroup
      } = db.entities('avvaleplm.marsplm.sap2plex');

      try {
        if (!Plant || String(Plant).trim() === '') {
          return req.error(400, getLocalizedMessage(req, 'rtPlantMandatory', APP), 'Plant');
        }

        const isCreate = !ID || String(ID).trim() === '';
        if (isCreate) {
          ID = cds.utils.uuid();
          if (!TemplateCode || String(TemplateCode).trim() === '') {
            TemplateCode = await nextTemplateCode(db, Plant);
          }
        }
        if (!TemplateCode || String(TemplateCode).trim() === '') {
          return req.error(400, getLocalizedMessage(req, 'rtCodeMandatory', APP), 'TemplateCode');
        }

        // Uniqueness (per plant), excluding this template
        const clash = await db.run(SELECT.one.from(ZPlexRoutingTemplate).where({ Plant, TemplateCode, ID: { '!=': ID } }));
        if (clash) {
          return req.error(400, getLocalizedMessage(req, 'rtCodeAlreadyExists', APP), 'TemplateCode');
        }

        // [W1-08] UN WORK CENTER SU UNA SOLA OPERAZIONE, anche qui (BBP §7.6.2). Il template non
        // arriva mai a Plex da solo, ma «Import from Template» copia le sue operazioni CON i loro
        // work center nel ciclo di una part: senza questo controllo il conflitto entrerebbe nel
        // ciclo senza passare dal popover, e si fermerebbe solo al salvataggio del ciclo — dove
        // sarebbe illeggibile, perche' l'errore verrebbe da righe che l'utente non ha scelto.
        // Prima dell'upsert della testata: un template rifiutato non deve restare con la
        // descrizione nuova e le operazioni vecchie.
        const wcConflict = workcenterConflictMessage(req, Operations);
        if (wcConflict) {
          console.warn(`>>> [W1-08] saveRoutingTemplate rifiutato: ${wcConflict}`);
          return req.error(400, wcConflict, 'Operations');
        }

        // [TEMPLATE-GROUP] UN GRUPPO SU UNA SOLA OPERAZIONE, stessa collocazione del controllo qui
        // sopra e per la stessa ragione: prima dell'upsert della testata, o un template rifiutato
        // resterebbe con la descrizione nuova e le operazioni vecchie.
        const groupConflict = templateGroupConflictMessage(req, Operations);
        if (groupConflict) {
          console.warn(`>>> [TEMPLATE-GROUP] saveRoutingTemplate rifiutato: ${groupConflict}`);
          return req.error(400, groupConflict, 'Operations');
        }

        // Upsert header
        const existing = await db.run(SELECT.one.from(ZPlexRoutingTemplate).where({ ID }));
        if (existing) {
          await db.run(UPDATE(ZPlexRoutingTemplate).set({ Plant, TemplateCode, Description: Description || null }).where({ ID }));
        } else {
          await db.run(INSERT.into(ZPlexRoutingTemplate).entries({ ID, Plant, TemplateCode, Description: Description || null }));
        }

        // Replace children (delete-then-insert)
        //
        // [TEMPLATE-GROUP] I gruppi si cancellano SOLO SE il payload li dichiara, e questa e' l'unica
        // asimmetria fra questa collezione e le due sorelle. «Nessuna operazione porta la chiave
        // `ObjectGroups`» e «le operazioni portano una lista vuota» non sono la stessa cosa: la
        // seconda dice «nessun gruppo», la prima dice «non lo so». A produrre la prima e' una scheda
        // rimasta aperta nel browser da prima del rilascio, che manda ancora il payload vecchio — e
        // un delete-then-insert incondizionato cancellerebbe i gruppi appena inseriti da qualcun
        // altro, senza un errore e con chi salva convinto di aver salvato. Il verdetto e' puro
        // (`declaresGroups`), cosi' un test lo fissa senza database.
        const groupsDeclared = templateGroupRules.declaresGroups(Operations);
        if (groupsDeclared) {
          await db.run(DELETE.from(ZPlexRoutingTemplateGroup).where({ TemplateID: ID }));
        }
        await db.run(DELETE.from(ZPlexRoutingTemplateWorkcenter).where({ TemplateID: ID }));
        await db.run(DELETE.from(ZPlexRoutingTemplateOperation).where({ TemplateID: ID }));

        let totalWorkcenters = 0;
        let totalGroups = 0;
        if (Operations && Operations.length > 0) {
          const opEntries = Operations.map((op, index) => ({
            ID: cds.utils.uuid(),
            TemplateID: ID,
            PlexOperationId: op.PlexOperationId,
            OperationCode: op.OperationCode || null,
            OperationName: op.OperationName || null,
            Sequence: op.Sequence || (index + 1) * 10,
            OperationNumber: op.OperationNumber || (index + 1) * 10,
            OperationType: op.OperationType || null,
            SubOperation: op.SubOperation || false,
            Shippable: op.Shippable || false,
            NetWeight: op.NetWeight || null,
            StandardQuantity: op.StandardQuantity || null
          }));
          await db.run(INSERT.into(ZPlexRoutingTemplateOperation).entries(opEntries));

          const wcEntries = [];
          Operations.forEach(op => {
            (op.ApprovedWorkcenters || []).forEach(wc => {
              wcEntries.push({
                ID: cds.utils.uuid(),
                TemplateID: ID,
                PlexOperationId: op.PlexOperationId,
                WorkcenterId: wc.WorkcenterId,
                WorkcenterCode: wc.WorkcenterCode || '',
                WorkcenterName: wc.WorkcenterName || ''
              });
            });
          });
          if (wcEntries.length > 0) {
            await db.run(INSERT.into(ZPlexRoutingTemplateWorkcenter).entries(wcEntries));
            totalWorkcenters = wcEntries.length;
          }

          // [TEMPLATE-GROUP] Le righe le compone il modulo puro, che deduplica la coppia
          // (operazione, gruppo): dopo il rifiuto dei conflitti non ne restano, ma e' cio' che rende
          // quella promessa verificabile da un test senza database.
          const groupRows = templateGroupRules.groupRowsOf(Operations);
          if (groupRows.length > 0) {
            await db.run(INSERT.into(ZPlexRoutingTemplateGroup).entries(groupRows.map(row => ({
              ID: cds.utils.uuid(),
              TemplateID: ID,
              PlexOperationId: row.PlexOperationId,
              GroupId: row.GroupId
            }))));
            totalGroups = groupRows.length;
          }
        }

        console.log(`>>> Routing template saved: ID=${ID}, code=${TemplateCode}, ops=${Operations ? Operations.length : 0}, wcs=${totalWorkcenters}, groups=${totalGroups}`
          + (groupsDeclared ? '' : ' (gruppi NON dichiarati dal payload: lasciati come stavano)'));
        return { success: true, ID, TemplateCode, count: Operations ? Operations.length : 0 };
      } catch (error) {
        console.error('>>> ERROR saving routing template:', error.message);
        req.error(500, error.message);
      }
    });

    // Delete a template and all of its operations/workcenters
    this.on('deleteRoutingTemplate', async (req) => {
      const { ID } = req.data;
      if (!ID) return req.error(400, getLocalizedMessage(req, 'rtIdMandatory', APP));
      const db = await cds.connect.to('db');
      const {
        ZPlexRoutingTemplate, ZPlexRoutingTemplateOperation, ZPlexRoutingTemplateWorkcenter,
        ZPlexRoutingTemplateGroup
      } = db.entities('avvaleplm.marsplm.sap2plex');

      // ================================================================
      // [PLANT-ACCESS] Il plant si LEGGE dalla riga, perche' il payload non lo porta (feature 0048).
      //
      // L'action riceve il solo `ID` e faceva tre `DELETE` cieche: nessuna lettura della testata,
      // quindi nessun modo di sapere di quale plant fosse il template. Un ID e' un UUID e non si
      // indovina, ma non e' un segreto — sta negli URL della scheda e nelle risposte della lista.
      //
      // UNA RIGA CHE NON C'E' NON E' UN RIFIUTO: se il template e' gia' stato cancellato non c'e'
      // niente da proteggere e niente da fare, e l'esito e' quello di prima.
      // ================================================================
      const hdr = await db.run(
        SELECT.one.from(ZPlexRoutingTemplate).columns('Plant').where({ ID })
      );
      if (!hdr) return { success: true };
      if (await rejectIfNoPlantRole(req, hdr.Plant)) return;

      try {
        // [TEMPLATE-GROUP] Terza figlia: senza questa riga cancellare un template lascerebbe le sue
        // righe di gruppo in tabella, legate a un `TemplateID` che non esiste piu'.
        await db.run(DELETE.from(ZPlexRoutingTemplateGroup).where({ TemplateID: ID }));
        await db.run(DELETE.from(ZPlexRoutingTemplateWorkcenter).where({ TemplateID: ID }));
        await db.run(DELETE.from(ZPlexRoutingTemplateOperation).where({ TemplateID: ID }));
        await db.run(DELETE.from(ZPlexRoutingTemplate).where({ ID }));
        return { success: true };
      } catch (error) {
        console.error('>>> ERROR deleting routing template:', error.message);
        req.error(500, error.message);
      }
    });
  }

  // ================================================================
  // MATERIAL CATEGORY SERVICE - per-plant material category customizing.
  // [IS-SOURCE] FR-18 (feature 0013): la function che alimenta l'avviso della tab
  // «Categorie materiali».
  // [W1-01] + la validazione della CATEGORIA DI RIPIEGO (IsCatchAll). Il resto e' CRUD puro.
  // ================================================================
  // ================================================================
  // [COMP-EXCL] OrderCompExclService — esclusione configurabile dei componenti dell'ordine.
  //
  // Copia deliberata della meccanica di MatCategoryService qui sotto: stessa forma
  // regola/condizioni, stessa ricomposizione della riga su PATCH per chiave tecnica, stessi
  // messaggi dagli i18n dell'app di configurazione plant.
  // ================================================================
  if (this.name === 'OrderCompExclService') {
    const { CompExclRules, CompExclConditions } = this.entities;

    /**
     * Validazione di una regola. La meccanica della chiave e' quella di validateMatCategory: su una
     * PATCH per chiave tecnica l'ID arriva da `req.params` e NON dal payload, quindi la riga va
     * RICOMPOSTA con l'esistente — validare il solo `req.data` farebbe girare i controlli su una
     * riga parziale, e una PATCH del solo `IsActive` non porterebbe nemmeno il nome.
     */
    async function validateExclRule(req) {
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(CompExclRules).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      // Nessuna validazione su Plant: `not null` + `assert.format` sono sul tipo CDS e CAP li
      // applica nella fase `_initial`, prima di ogni handler applicativo (DEC-40).

      if (!String(row.RuleName || '').trim()) {
        return req.error(400, getLocalizedMessage(req, 'oceRuleNameRequired', 'adminconfigplant'), 'RuleName');
      }

      // ATTIVAZIONE A VUOTO. Una regola senza condizioni non esclude niente (`evaluateRule` la
      // rifiuta): non e' un passa-tutto, e' un customizing che si salva e non fa niente — quello
      // che DEC-27 non vuole. Per questo la regola nasce SPENTA: qui si difende il momento in cui
      // viene accesa. Su CREATE senza ID risolvibile il controllo non e' eseguibile, e non serve:
      // una riga nuova senza figli e' spenta per default.
      if (row.IsActive === true && rowId) {
        const cond = await SELECT.one.from(CompExclConditions).where({ rule_ID: rowId });
        if (!cond) {
          return req.error(400, getLocalizedMessage(req, 'oceNoConditions', 'adminconfigplant'), 'IsActive');
        }
      }
    }

    /** Validazione di una condizione: campo del catalogo, operatore noto, valore quando serve. */
    async function validateExclCond(req) {
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(CompExclConditions).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      // Si riusa la validazione PURA, su una regola di una sola condizione: cosi' l'elenco dei
      // campi ammessi e quello degli operatori restano in UN posto solo, quello che il runtime usa.
      const v = orderCompExclRules.validateRule({ RuleName: 'x' }, [row]);
      if (!v.ok) {
        const field = v.code === 'oceUnknownOperator' ? 'Operator'
          : (v.code === 'oceValueRequired' ? 'Value' : 'SapField');
        return req.error(400, getLocalizedMessage(req, v.code, 'adminconfigplant', v.field), field);
      }
    }

    this.before('CREATE', 'CompExclRules', validateExclRule);
    this.before('UPDATE', 'CompExclRules', validateExclRule);
    this.before('CREATE', 'CompExclConditions', validateExclCond);
    this.before('UPDATE', 'CompExclConditions', validateExclCond);

    // La cache delle regole ha un TTL, ma l'invalidazione esplicita e' il meccanismo: senza, chi
    // salva nella scheda non vedrebbe l'effetto per un minuto e crederebbe di aver sbagliato.
    //
    // SI SVUOTA TUTTO, non il solo plant: la cache contiene anche la voce `'*'` — l'unione delle
    // colonne di tutti i plant, che serve alla READ dell'albero — e una DELETE o una PATCH per
    // chiave tecnica non portano il plant nel payload. E' una manciata di interruttori, non dati
    // SAP: il costo di rileggerli e' nullo, il costo di lasciarne uno vecchio e' un campo che
    // manca dal `$select`.
    const clearExclCache = () => orderCompExcl.invalidateExclRulesCache();
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'CompExclRules', clearExclCache);
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'CompExclConditions', clearExclCache);
  }

  if (this.name === 'MatCategoryService') {

    // ----------------------------------------------------------------
    // [W1-01] CATEGORIA DI RIPIEGO — «tutto il resto = materia prima» (BBP §7.3.4).
    // Il ripiego prende i materiali che nessuna categoria normale aggancia, e classifyMaterial
    // lo valuta per ultimo PER COSTRUZIONE: la sua Sequence non viene letta (DEC-61). Qui si
    // difendono i tre presupposti di quella semantica.
    // ----------------------------------------------------------------
    const { MaterialCategories, CategoryConditions } = this.entities;

    /**
     * Validazione di una categoria materiale. La meccanica della chiave e' quella di
     * validateRoutingFilter: su una PATCH per chiave tecnica l'ID arriva da `req.params` e NON
     * dal payload, quindi la riga va RICOMPOSTA con l'esistente — validare il solo `req.data`
     * farebbe girare i controlli su una riga parziale (una PATCH del solo `Sequence` non porta
     * ne' IsCatchAll ne' PlexPartType, e il ripiego risulterebbe spento).
     */
    async function validateMatCategory(req) {
      const keyParam = (req.params && req.params.length) ? req.params[req.params.length - 1] : null;
      const rowId = req.data.ID || (keyParam && (keyParam.ID || keyParam)) || null;
      let row = { ...req.data };
      if (req.event === 'UPDATE' && rowId) {
        const existing = await SELECT.one.from(MaterialCategories).where({ ID: rowId });
        if (existing) row = { ...existing, ...req.data };
      }

      // Nessuna validazione su Plant: `not null` + `assert.format` sono sul tipo CDS e CAP li
      // applica nella fase `_initial`, prima di ogni handler applicativo (DEC-40).

      // [W1-02] La CLASSE scritta dev'essere una classe vera. Sta PRIMA del ritorno anticipato
      // qui sotto perche' vale per ogni categoria, non per il solo ripiego: la tendina della
      // tab e' vincolata, l'URL OData no, e una classe inventata resterebbe li' in silenzio
      // finche' qualcuno non guarda il payload spedito a Plex.
      //
      // Restringe e basta (DEC-40): la lunghezza di colonna la vede CAP prima di noi.
      if (String(row.PlexPartType || '').trim()) {
        const db = await cds.connect.to('db');
        if (!isKnownClass(await loadPartTypeIndex(db), row.PlexPartType)) {
          return req.error(400, getLocalizedMessage(req, 'mcPartTypeUnknown', 'adminconfigplant',
            String(row.PlexPartType).trim()), 'PlexPartType');
        }
      }

      // ================================================================
      // [MAT-SCOPE] LA TIPOLOGIA E' OBBLIGATORIA SU OGNI CATEGORIA, non piu' sul solo ripiego
      // (feature 0050).
      //
      // Qui c'era scritto «Vuoto AMMESSO: una categoria senza part type resta un criterio di sola
      // visibilita', ed e' il comportamento storico». Dalla 0050 quel comportamento non esiste
      // piu': un materiale entra in perimetro solo se una categoria gli assegna una tipologia,
      // quindi una categoria senza tipologia non rende i suoi materiali «visibili e non
      // classificati» — li fa SPARIRE.
      //
      // Lasciarla salvabile significherebbe offrire nella scheda un'impostazione il cui effetto e'
      // «questi materiali non si vedono piu'», presentata come un criterio di visibilita': e' il
      // trabocchetto silenzioso che il repo rifiuta, ed e' peggio del divieto perche' chi la salva
      // crede di aver allargato il perimetro.
      //
      // IL DATO ESISTENTE NON SI MIGRA, e va saputo: questo controllo vale su CREATE/UPDATE, le
      // righe salvate prima restano. A runtime non sono mute — la potatura le NOMINA per plant, in
      // `productScope` e nel recap del job — ma il censimento va fatto su UAT/PROD prima del
      // rilascio, perche' per il primo-match-per-`Sequence` una categoria senza tipologia in testa
      // OMBREGGIA tutte le successive E il ripiego: una sola riga puo' svuotare il perimetro di un
      // plant.
      //
      // IL RIPIEGO E' ESCLUSO DA QUESTO CONTROLLO, e non per una deroga: ce l'ha gia' al controllo
      // 2 qui sotto, con un messaggio che spiega la SUA ragione («un ripiego senza tipo manda a
      // Plex tutto cio' che avanza senza classificazione»). Prendendolo qui, quel messaggio
      // diventerebbe irraggiungibile e la sua chiave i18n codice morto.
      // ================================================================
      if (!row.IsCatchAll && !String(row.PlexPartType || '').trim()) {
        return req.error(400, getLocalizedMessage(req, 'mcPartTypeMandatory', 'adminconfigplant'),
          'PlexPartType');
      }

      if (!row.IsCatchAll) return; // categoria normale: niente di nuovo da verificare

      const Plant = String(row.Plant || '').trim().toUpperCase();

      // 1) UN SOLO ripiego attivo per plant. Con due, quale dei due da' il part type
      //    dipenderebbe dall'ordine di lettura del database: un esito non riproducibile.
      //    Il vincolo e' sul ripiego ATTIVO: uno disattivato non e' caricato da
      //    loadCategoryConfig, quindi non entra nella semantica e non deve bloccare.
      if (row.IsActive !== false) {
        const clash = await SELECT.one.from(MaterialCategories).where({
          Plant,
          IsCatchAll: true,
          IsActive: true,
          ...(rowId ? { ID: { '!=': rowId } } : {})
        });
        if (clash) {
          return req.error(400, getLocalizedMessage(req, 'mcCatchAllDuplicate', 'adminconfigplant',
            clash.CategoryName || ''), 'IsCatchAll');
        }
      }

      // 2) PART TYPE obbligatorio. Un ripiego senza tipo manda a Plex tutto cio' che avanza
      //    SENZA classificazione: e' esattamente il lavoro che il ripiego esiste per fare.
      if (!String(row.PlexPartType || '').trim()) {
        return req.error(400, getLocalizedMessage(req, 'mcCatchAllPartTypeMandatory', 'adminconfigplant'),
          'PlexPartType');
      }

      // 3) NESSUNA CONDIZIONE. classifyMaterial non le valuta — un ripiego prende cio' che
      //    avanza, per definizione — quindi lasciarle salvare significherebbe mostrare al
      //    configuratore criteri che non hanno alcun effetto: il passa-tutto silenzioso che
      //    DEC-27 rifiuta. Il controllo e' su ENTRAMBI i lati (vedi l'handler qui sotto)
      //    perche' nel batch `matCategoryChanges` testata e condizioni arrivano in ordine non
      //    garantito; il batch e' UNA transazione, quindi il secondo vede cio' che ha scritto
      //    il primo.
      if (rowId) {
        const cond = await SELECT.one.from(CategoryConditions).where({ category_ID: rowId });
        if (cond) {
          return req.error(400, getLocalizedMessage(req, 'mcCatchAllNoConditions', 'adminconfigplant'),
            'IsCatchAll');
        }
      }
    }

    this.before('CREATE', 'MaterialCategories', validateMatCategory);
    this.before('UPDATE', 'MaterialCategories', validateMatCategory);

    // Il lato gemello del controllo 3: una condizione non si aggiunge a un ripiego.
    this.before('CREATE', 'CategoryConditions', async (req) => {
      const parentId = req.data.category_ID
        || (req.params && req.params.length > 1 && (req.params[0].ID || req.params[0]));
      if (!parentId) return;
      const parent = await SELECT.one.from(MaterialCategories).where({ ID: parentId });
      if (parent && parent.IsCatchAll) {
        return req.error(400, getLocalizedMessage(req, 'mcCatchAllNoConditions', 'adminconfigplant'),
          'SapField');
      }
    });

    // Nessuna cache da invalidare: le categorie si rileggono a ogni READ della dashboard e a
    // ogni run del job (loadCategoryConfig / loadPlantCategories). E' la scelta gia' in atto.

    // Incrocia le categorie ATTIVE del plant con le informazioni che il canale attivo per
    // l'area materiali non fornisce. Nessun dato nuovo, nessuna lettura verso SAP: solo il
    // customizing che la tab mostra già + la modalità della sorgente.
    // Elenco vuoto => nessun avviso (canale storico, o nessuna condizione dipendente).
    this.on('matCategoryFieldAvailability', async (req) => {
      const Plant = req.data.Plant;
      if (!Plant) return req.reject(400, getLocalizedMessage(req, 'plantCodeMandatory', 'adminconfigplant'));

      const src = await productSource();
      const unavailableFields = src.mode === 'IS' ? [...UNAVAILABLE_IN_IS] : [];
      const out = { channel: src.mode, unavailableFields, affectedCategories: [] };
      // [W1-26] Con UNAVAILABLE_IN_IS vuoto si esce di qui: nessun avviso, nessuna lettura del
      // customizing. È l'unica riga che spegne il MessageStrip della scheda.
      if (!unavailableFields.length) return out;

      const db = await cds.connect.to('db');
      const categories = await loadPlantCategories(Plant, db);
      for (const c of categories) {
        // [W1-26] `fieldsUsedBy` al posto del ciclo scritto a mano: stessa risposta del gate
        // della lista materiali e del recap del job, e passa da `_asConditions`, quindi non
        // inciampa su una composizione vuota restituita come stringa `'[]'` (DEC-61).
        const hit = fieldsUsedBy([c], unavailableFields);
        if (hit.length) out.affectedCategories.push({ CategoryName: c.CategoryName, Conditions: hit });
      }
      console.log(`>>> [IS-SOURCE] matCategoryFieldAvailability(${Plant}): canale ${out.channel},`
        + ` ${out.affectedCategories.length} categorie con condizioni non valutabili`
        + ` su ${categories.length} attive`);
      return out;
    });
  }

  // ================================================================
  // [LOG-MSG-I18N] LogService: gli storici invii si leggono nella lingua di chi guarda
  // ================================================================
  //
  // Le sei entity di log non avevano NESSUN handler: sono `@readonly ... as projection on` e la
  // colonna `Message` arrivava a schermo grezza, cioe' nella lingua di chi aveva lanciato l'invio.
  // Sono i tre storici del cockpit — dettaglio materiale, dettaglio ciclo, dettaglio ordine — piu'
  // le tre testate, che alimentano la colonna «ultimo esito» delle liste della dashboard.
  //
  // PERCHE' QUI E NON IN UN FORMATTER UI5. Le stesse frasi servono anche dove non c'e' un browser:
  // le tre code del messaggio ciclo alimentano il recap del job batch, che finisce nel PDF e nel CSV
  // mandati per mail. Un renderer lato server serve comunque; averne due — uno qui e uno nel
  // browser — sarebbe la copia che diverge, la classe di guasto che questo progetto sorveglia da
  // `prepareRoutingComponents` in poi. E rendendo qui NESSUN binding XML cambia: le view continuano
  // a leggere `Message` e cominciano a mostrare testo tradotto.
  if (this.name === 'LogService') {
    // ================================================================
    // [LOG-PLANT-GATE] IL GATE DI LICENZA SUI LOG (feature 0031).
    //
    // Il LogService non aveva ne' `@requires` ne' filtro plant: qualunque utente autenticato
    // leggeva i log di TUTTI i plant. Finche' l'unico consumatore era il dettaglio di un oggetto
    // che l'utente aveva gia' aperto, la cosa era latente; con la scheda «Esecuzioni job», che
    // ELENCA, diventava una lista dei plant di tutti i clienti — su un progetto multi-cliente in cui
    // il gate e' un choke-point unico (0001) e «ogni lettura che espone dati di un plant» ci passa.
    //
    // Si restringe alle entity che HANNO la colonna Plant. Le altre si dichiarano qui sotto invece
    // di essere protette per finta: `ZMatExcLog*` prende il plant dalla 0031 ed entra nell'elenco,
    // `ZRoutingExcLog*` non ce l'ha e resta fuori — il ciclo non porta il plant in chiave, e
    // inventarlo con una join sull'header dei cicli SAP sarebbe una lettura remota dentro un gate.
    //
    // `ZJobRunHDR` non ha un plant perche' un run e' cross-plant, e va da se': la sua testata dice
    // «il job e' girato», non «dati di un plant». Il dettaglio — le righe POS — e' filtrato, quindi
    // un utente vede l'esecuzione e dentro solo i suoi plant. Nasconderla del tutto renderebbe
    // invisibile un run fallito a chi ha un plant solo.
    //
    // `'#NA'` PASSA SEMPRE, e non e' una falla: e' il plant delle righe la cui attribuzione non e'
    // stata possibile (schema.cds), e l'allegato `#NA` viene mandato a tutti i destinatari del job
    // per la stessa ragione — quei KO altrimenti non arriverebbero a nessuno.
    // ================================================================
    // `PLANT_NA` sta in jobCodes.js e non si ricopia: e' lo stesso valore che i job scrivono.
    const { PLANT_NA } = require('./lib/jobCodes');
    const PLANT_FILTERED_LOGS = [
      'ZMatExcLogHDR', 'ZMatExcLogPOS',            // [MAT-LOG-PLANT] plant in chiave dalla 0031
      'ZJobRunPOS',
      'ZProdOrderTecoState',
      // [ORDER-COMPLETE] feature 0045. Le righe in QUARANTENA portano il plant del tenant su cui
      // sono state lette — non quello del mapping, che potrebbe non esserci — quindi non sfuggono
      // a questo gate: `Plant` e' sempre valorizzato, e '#NA' passa per costruzione.
      'ZProdOrderCompleteState',
      // [ORDER-SCHEDULED] feature 0046: come la gemella, le righe in quarantena portano il plant del
      // tenant su cui sono state lette, quindi non sfuggono a questo gate.
      'ZProdOrderScheduledState',
      // [PLANT-ACCESS] Dal 09/09/2026 valgono anche qui: le righe in QUARANTENA di
      // `ZProdConfPlexEntry` portano il plant del TENANT su cui sono state lette. Prima portavano
      // `NULL` — il plant e' un esito della risoluzione (DEC-117) — e `NULL` non soddisfa un `IN`:
      // erano invisibili a QUALUNQUE utente, cioe' proprio le righe che un'indagine va a cercare.
      // La domanda da porsi aggiungendo una entity qui non e' «ha la colonna Plant?» ma «e' SEMPRE
      // valorizzata, compreso il ramo in cui la risoluzione non riesce?». Vedi 0048 RB-13.
      'ZProdConfPlexEntry', 'ZProdConfMatDoc',
      'ZProdOrderPlexMapping', 'ZProdOrderSplit',
      'ZJobReadWatermark'
    ];

    // ================================================================
    // [PLANT-ACCESS] IL RAMO DEL PERIMETRO VUOTO E' CAMBIATO (feature 0048).
    //
    // Fino alla 0048 con zero plant il filtro diventava `{ Plant: PLANT_NA }`, e quella non e' una
    // lista vuota: e' l'elenco di TUTTE le righe non attribuite, di TUTTI i plant. Andava bene
    // finche' il perimetro vuoto significava «nessun plant licenziato» — una condizione di
    // configurazione, rara. Ora significa anche «questo utente non ha nessun ruolo», che e' la
    // condizione NORMALE di un utente nuovo: quel ramo diventerebbe il punto da cui chi non ha
    // accesso a niente legge le righe di tutti.
    //
    // La ragione per cui `'#NA'` passa sempre (righe qui sotto, :12443 nella versione precedente)
    // vale per un gate PER PLANT — quei KO altrimenti non arriverebbero a nessuno — e CADE per un
    // gate per utente: con almeno un plant in perimetro le `'#NA'` continuano a passare, con zero
    // no. Chi non ha nessun plant non ha nessun KO da leggere.
    //
    // IL PREDICATO IMPOSSIBILE, e perche' non e' `in: []`. `{ Plant: { in: [] } }` diventa
    // `IN ()`, che non e' SQL valido su ogni dialetto; `{ Plant: null }` non e' impossibile (le
    // righe scritte prima della 0031 possono avere la colonna vuota). Si usa quindi un valore che
    // nessuna riga puo' avere, nella convenzione `'#'` che il progetto usa gia' per `'#NA'`.
    // Verificato su SQLite: la query e' valida e rende zero righe.
    // ================================================================
    /** Un valore che nessun `Plant` puo' avere: serve a rendere una lista VUOTA, non un errore. */
    const PLANT_NONE = '#NONE';

    for (const entity of PLANT_FILTERED_LOGS) {
      this.before('READ', entity, async (req) => {
        const allowed = [...(await getUserPlants(req))];
        req.query.where(
          allowed.length
            ? { Plant: { in: [...allowed, PLANT_NA] } }
            : { Plant: PLANT_NONE }
        );
      });
    }

    // ================================================================
    // [PLANT-ACCESS] I QUATTRO STORICI CHE NON HANNO UN PLANT (feature 0048).
    //
    // `ZProdOrderExcLog*` e `ZRoutingExcLog*` non hanno la colonna `Plant`, quindi restano fuori
    // dal gate qui sopra — e portano `RequestJson` e `ResponseJson`, cioè il corpo mandato a Plex e
    // la risposta. Sono anche le due letture delle schede di dettaglio: il gate del perimetro si
    // aggirava con una GET su questi indirizzi.
    //
    // IL FILTRO PER PLANT NON SI PUÒ INVENTARE, e la strada che sembra ovvia è quella sbagliata.
    // Per l'ordine il plant starebbe su `ZProdOrderPlexMapping`, ma quella riga nasce solo con un
    // invio e il suo `Plant` può valere `'#NA'` o vuoto, che lo schema dichiara «IGNOTO, mai
    // escludimi»: filtrarci sopra escluderebbe gli ordini il cui invio non è mai riuscito, cioè
    // proprio quelli il cui storico si va a leggere. Per il ciclo non esiste nemmeno quello: il
    // plant vive nella testata SAP, e una lettura remota dentro un gate è ciò che
    // [LOG-PLANT-GATE] rifiuta di fare da sempre.
    //
    // Resta il RIFIUTO DI UNA LETTURA SENZA CRITERI — non protegge chi ha in mano un numero
    // d'ordine, protegge dall'elenco. Il client chiede sempre per oggetto, e le due testate non le
    // legge affatto. Il prezzo è dichiarato: con un numero d'ordine si legge il suo storico anche
    // fuori perimetro.
    //
    // [X-EXCLOG-SCOPE] soffitto: chi conosce un numero d'ordine (o la tripla di un ciclo) legge il
    //                  suo storico di invio anche se il plant non è nel suo perimetro.
    //                  scade quando: `ZProdOrderExcLog*` guadagna una colonna `Plant` scritta
    //                  all'invio — allora entra in `PLANT_FILTERED_LOGS` come le altre. Per i
    //                  cicli serve prima che il plant entri nella loro chiave.
    // ================================================================
    const KEYED_LOGS = [
      ['ZProdOrderExcLogHDR', ['ManufacturingOrder'], 'ManufacturingOrder'],
      ['ZProdOrderExcLogPOS', ['ManufacturingOrder'], 'ManufacturingOrder'],
      ['ZRoutingExcLogHDR', ['ProductionRoutingGroup', 'ProductionRouting', 'Material'], 'ProductionRoutingGroup'],
      ['ZRoutingExcLogPOS', ['ProductionRoutingGroup', 'ProductionRouting', 'Material'], 'ProductionRoutingGroup']
    ];

    for (const [entity, keys, guardField] of KEYED_LOGS) {
      this.before('READ', entity, (req) => {
        const { equals } = keyReadRules.equalitiesOf(keyReadRules.readWhere(req.query), keys);
        if (Object.keys(equals).length) return;
        console.log(`>>> [PLANT-ACCESS] READ ${entity} senza alcun criterio: RIFIUTATA`
          + ' (renderebbe lo storico di tutti gli oggetti, di tutti i plant)');
        req.query.where({ [guardField]: PLANT_NONE });
      });
    }

    /** Le colonne da rendere, per entity. `ZProdOrderPlexMapping` usa nomi propri. */
    const LOG_MSG_COLUMNS = [
      ['ZMatExcLogHDR', 'Message', 'MessageJson'],
      ['ZMatExcLogPOS', 'Message', 'MessageJson'],
      ['ZRoutingExcLogHDR', 'Message', 'MessageJson'],
      ['ZRoutingExcLogPOS', 'Message', 'MessageJson'],
      ['ZProdOrderExcLogHDR', 'Message', 'MessageJson'],
      ['ZProdOrderExcLogPOS', 'Message', 'MessageJson'],
      ['ZProdOrderPlexMapping', 'LastMessage', 'LastMessageJson'],
      // [LOG-MSG-I18N] Feature 0031: il recap dei job, la chiusura tecnica e la consuntivazione.
      // Sono le colonne che le tre schermate nuove del cockpit mostrano, e prima della 0031 non
      // avevano nessuna forma strutturata: quello che si leggeva era la lingua di chi le aveva
      // scritte — cioe' l'italiano dei job, per chiunque.
      ['ZJobRunPOS', 'Message', 'MessageJson'],
      // DUE righe sulla stessa entity, ed e' voluto: `Message` e `FatalMessage` sono due testi
      // indipendenti. I due handler scrivono campi diversi, quindi non si azzerano a vicenda.
      ['ZJobRunHDR', 'Message', 'MessageJson'],
      ['ZJobRunHDR', 'FatalMessage', 'FatalMessageJson'],
      ['ZJobRunMail', 'Message', 'MessageJson'],
      ['ZProdOrderTecoState', 'LastMessage', 'LastMessageJson'],
      // [ORDER-COMPLETE] feature 0045
      ['ZProdOrderCompleteState', 'LastMessage', 'LastMessageJson'],
      // [ORDER-SCHEDULED] feature 0046
      ['ZProdOrderScheduledState', 'LastMessage', 'LastMessageJson'],
      ['ZProdConfPlexEntry', 'Message', 'MessageJson'],
      // Qui la colonna del testo e' `MessageText`, e porta anche il messaggio di SAP: nei segmenti
      // il rifiuto di SAP viaggia in `logMsgTechnical`, che non si traduce.
      ['ZProdConfMatDoc', 'MessageText', 'MessageTextJson']
    ];

    for (const [entity, textField, jsonField] of LOG_MSG_COLUMNS) {
      this.after('READ', entity, (data, req) => localizeLogRows(data, req, textField, jsonField));
    }

    console.log(`>>> [LOG-MSG-I18N] LogService: resa dei messaggi attiva su ${LOG_MSG_COLUMNS.length} entity`);
  }

  // ================================================================================================
  // [JOB-TRIGGER] Avvio dei cinque job batch dal Job Scheduler BTP (feature 0032).
  //
  // Cinque handler SOTTILI: tutto quello che decidono sta in srv/lib/jobTrigger.js, che e' fuori da
  // questa closure per la ragione di sempre — un `fork`, un watchdog e una callback HTTP non hanno
  // niente a che fare col catalogo, e le regole verificabili senza sistemi esterni stanno accanto
  // all'orchestrazione (srv/lib/jobTriggerRules.js, node test/jobTriggerRules.test.js).
  //
  // NON C'E' NIENTE DA FARE QUI DENTRO, ed e' il punto: l'handler non deve toccare il DB oltre la
  // singola lettura del registro che fa `trigger`, perche' ha QUINDICI SECONDI per rispondere
  // `202`. Tutto il lavoro sta nel processo figlio.
  //
  // Perimetro: grep -rn "JOB-TRIGGER"
  // ================================================================================================
  if (this.name === 'JobRunService') {
    const jobTrigger = require('./lib/jobTrigger');

    const TRIGGERS = [
      ['runMatSync', 'MAT_SYNC'],
      ['runRoutingSync', 'ROUTING_SYNC'],
      ['runProdOrder', 'PROD_ORDER'],
      ['runProdConf', 'PROD_CONF'],
      ['runProdTeco', 'PROD_TECO'],
      // [ORDER-COMPLETE] feature 0045
      ['runOrderComplete', 'ORDER_COMPLETE'],
      // [ORDER-SCHEDULED] feature 0046
      ['runOrderScheduled', 'ORDER_SCHEDULED']
    ];

    for (const [action, jobCode] of TRIGGERS) {
      this.on(action, async (req) => jobTrigger.trigger(jobCode, req));
    }

    // Non dentro un job: MAT_SYNC e ROUTING_SYNC chiamano `cds.serve('all')` (serve loro per
    // invocare le action di PlexService e ProductionRouting), quindi istanziano ANCHE questo
    // servizio nel processo figlio. Là gli handler sono inerti — nessun listener HTTP — ma la riga
    // di log ricomparirebbe in mezzo all'output del job, e in `cf logs` si legge come un riavvio
    // del server. `JOB_RUN_ID` c'è solo nel figlio (srv/lib/jobTrigger.js).
    if (!process.env.JOB_RUN_ID) {
      console.log(`>>> [JOB-TRIGGER] JobRunService: ${TRIGGERS.length} endpoint di avvio attivi su /job-run`
        + ` (${TRIGGERS.map(([a]) => a).join(', ')})`);
    }
  }
});

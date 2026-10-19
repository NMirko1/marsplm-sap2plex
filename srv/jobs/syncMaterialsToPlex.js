/**
 * Job BTP — Sincronizzazione delta dei materiali verso Plex.
 *
 * [MAT-PLANT-PAIR] L'OGGETTO DI QUESTO JOB E' LA COPPIA (materiale, plant), feature 0039.
 * Un materiale in perimetro su tre plant sono TRE oggetti da inviare, su tre tenant Plex diversi
 * (la connessione è per plant dalla 0020): tre part, tre esiti, tre righe di delta. Fino alla 0039
 * il job deduplicava per materiale e ne inviava uno solo, scegliendo un «plant rappresentativo» —
 * il primo incontrato — e quella scelta si portava dietro tre conseguenze mute: gli altri plant non
 * ricevevano il materiale, il delta confrontava il materiale con l'esito di un plant arbitrario
 * (`ZMatExcLogHDR` ha il plant in chiave dalla 0031, e l'indicizzazione per solo `Product` teneva
 * l'ultima riga letta), e i destinatari degli altri plant non lo vedevano nel proprio allegato.
 *
 * Invia a Plex le coppie di TUTTI i plant attivi (ZPlant, Status='Active') applicando una logica di
 * **delta su data**, per coppia:
 *   - coppia MAI inviata (nessuna riga in ZMatExcLogHDR per QUEL plant)  -> invia
 *   - ultimo invio NON riuscito (Status != 'S'/'W')                      -> invia
 *   - data di modifica SAP >= data ultimo invio (successiva o             -> invia
 *     contemporanea): A_Product.LastChangeDate >= ZMatExcLogHDR.SentDate
 *   - data di modifica SAP mancante (fallback conservativo)               -> invia
 *   - altrimenti (già inviata e non modificata)                           -> salta
 *
 * La decisione è in `matPlantRules.needsSend`, che è pura e ha il suo test: qui resta
 * l'orchestrazione. SAP traccia la modifica solo a livello di DATA (LastChangeDate), quindi il
 * confronto è a granularità giornaliera (stringhe ISO 'YYYY-MM-DD').
 *
 * L'invio vero e proprio (CREATE/UPDATE idempotente + scrittura log
 * ZMatExcLogPOS/HDR + mapping ZMatPlexMapping) è delegato all'action CAP
 * esistente PlexService.sendProductToPlex (srv/cat-service.js): il job non
 * duplica quella logica, la invoca in-process.
 *
 * [PLEX-CONN] È il **customizing** (ZPlexConnConfig) a decidere il server Plex Connect, e lo
 * decide PER PLANT. Questo job non lo risolve da sé: passa il `Plant` a sendProductToPlex,
 * come già faceva, ed è l'action a risolvere la connessione. Vedi srv/lib/plexConnection.js.
 *
 * Eseguito dal SAP BTP Job Scheduler tramite:
 *     node srv/jobs/syncMaterialsToPlex.js
 * (oppure `npm run job-sync-materials`).
 *
 * Profili di connessione (package.json -> cds.requires):
 *   - development : SAP API Business Hub sandbox (APIKey)
 *   - hybrid/prod : destination `MARS_SAP_CON`
 */

const cds = require('@sap/cds');
const { resolveActivePlants } = require('./lib/plexJobsClient');
const {
  // [MAT-SCOPE] `loadCategoryConfig` e `needsProductDetails` NON sono piu' importati, e non e' una
  // ripulitura estetica: dalla 0050 il verdetto del perimetro lo prende `matScope.finalScope`, che
  // calcola `needsProductDetails` per conto suo — passarglielo da qui vorrebbe dire che tre
  // chiamanti possono sbagliarlo in tre modi diversi. Un import tenuto in vita da un commento
  // invecchia fino a diventare una trappola: chi lo ritrova crede che qui si decida qualcosa.
  loadCategoryConfigOutcome,   // [MAT-SCOPE] la mappa PIU' il verdetto della lettura
  loadTypeMappedPlants,        // [MAT-SCOPE] i plant che mappano `type` a mano (0004 RB-17)
  loadPartTypeIndex,
  loadPartTypeCodeIndex,
  classifyMaterial,            // solo la passata CIECA di enumerateProducts
  extractSapFields,
  needsNav,
  fieldsUsedBy,
  productPlantColumns,
  mergeProductFields
} = require('../lib/materialVisibility');
// [MAT-SCOPE] Il verdetto DEFINITIVO sul perimetro di un materiale (feature 0050): puro, e lo
// STESSO che usa il cockpit. Due copie darebbero un perimetro a schermo diverso da quello inviato.
const matScope = require('../lib/matScopeRules');
// [W1-03] QUALI classi vogliono l'operazione di ricevimento: e' la colonna
// ZPlexPartTypeVH.RequiresReceivingOp introdotta da W1-02, letta dal suo indice.
// [PLEX-PART-CODES] plexValueOf: la classe di una categoria diventa la TIPOLOGIA, che e' cio' che
// ha un codice (feature 0022).
const { classInfo, plexValueOf } = require('../lib/materialClass');
// [PLEX-PART-CODES] Quali tipologie in uso sono rimaste senza codice del tenant.
const { missingTypeCodes } = require('../lib/plexPartCodes');
const recvOpRules = require('../lib/recvOpRules');
// [PLEX-OP-TYPE] Il tipo di un'operazione lo dichiara il CATALOGO Plex (feature 0024, DEC-84): la
// voce di recap non verifica piu' un campo di customizing, verifica il tenant.
const opCatalog = require('../lib/plexOperationCatalog');
const { resolvePlexConnection } = require('../lib/plexConnection');
// [IS-SOURCE] Sorgente dell'area materiali (feature 0013): canale scelto da PRODUCT_SOURCE.
const productSource = require('../lib/productSource');
// [PRODUCT-QUERY] L'anagrafica si legge PER PLANT (feature 0040): una query paginata invece di due
// letture per chiave per materiale. Su ONPREM la funzione delega a `fetchProductsByKey`, quindi il
// canale storico non cambia di una virgola.
const { fetchProductsForPlants, UNAVAILABLE_IN_IS } = productSource;
// [PAGED-READ] Il lettore paginato del perimetro, lo stesso della dashboard: dimezzamento, ordine
// stabile, guardia dello `$skip`, verdetto. È `readPlantRows` e non la versione in cache — vedi
// `enumerateProducts` per il perché.
const { readPlantRows } = require('../lib/plantRows');

// [MAT-PLANT-PAIR] Chiave della coppia, indicizzazione che rende invisibili le righe storiche,
// selezione sotto tetto e la decisione di delta. Regole pure, con il loro test:
// node test/matPlantRules.test.js
const matPlantRules = require('../lib/matPlantRules');
const { pairKey, needsSend } = matPlantRules;
// [PART-ALIVE] L'elenco delle part che esistono DAVVERO sul tenant di un plant (feature 0042): una
// lettura per plant, indicizzata per UUID. Test: node test/plexPartCatalog.test.js
const plexPartCatalog = require('../lib/plexPartCatalog');
// [PART-QUERY] L'indirizzo del Parts API in un punto solo: la voce di recap deve NOMINARE
// l'indirizzo che la lettura ha usato davvero, o il giorno in cui l'elenco passa a v2 il recap
// manderebbe chi indaga sull'indirizzo sbagliato.
const plexPartsApi = require('../lib/plexPartsApi');

// [PART-ALIVE] La META' REMOTA del riallineamento — «il dizionario dichiara una part che il tenant
// non ha» — si puo' spegnere. La META' LOCALE — «non c'e' nessuna riga di dizionario» — no, e non
// e' una svista: e' un fatto nostro, non tocca la rete, non puo' essere non conclusivo, ed e'
// l'implementazione mancante della 0039. Una leva su quella sarebbe una leva che nessuno ha motivo
// di tirare.
//
// La LETTURA e la DICHIARAZIONE girano comunque (modello di DEC-71: il rilevamento gira, l'effetto
// no), cosi' i tre numeri arrivano nel recap ogni notte senza cambiare cosa il job invia.
const REMOTE_CHECK = String(process.env.PLEX_MAT_REMOTE_CHECK || 'on').trim().toLowerCase() !== 'off';

// [LOG-MSG-I18N] I messaggi del recap sono segmenti (feature 0031): il testo si rende qui.
const logMsg = require('../lib/logMessage');
const i18nMessages = require('../lib/i18nMessages');

/** Il testo di una lista di segmenti, in italiano: e' cio' che va nelle colonne e nella mail. */
const renderMsg = (segments) => i18nMessages.render(
  logMsg.normalize(segments), i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE
);

const PLEX_SERVICE = 'PlexService';
const NS = 'avvaleplm.marsplm.sap2plex';
// Nome entità fully-qualified (in contesto job standalone `db.entities` non è
// invocabile come funzione: si usa il nome FQN come stringa nelle query CQL).
const E_LOG_HDR = `${NS}.ZMatExcLogHDR`;
// [W1-03] Dizionario delle operazioni di ricevimento gia' istanziate su Plex.
const E_RECV_OP_MAPPING = `${NS}.ZMatRecvOpMapping`;
// [PART-ALIVE] Il dizionario delle part: quale UUID crediamo che il tenant abbia, per coppia.
const E_MAT_MAPPING = `${NS}.ZMatPlexMapping`;
// [W1-03] Customizing unita' di misura -> operazione di ricevimento, per plant.
const E_RECV_OP_CONFIG = `${NS}.ZMatRecvOpConfig`;

// [PAGED-READ] Qui stavano `PAGE = 1000` e `MAX_ROWS_PER_PLANT = 200000`, cioè la paginazione di
// A_ProductPlant scritta a mano. Ora la governa il lettore condiviso (srv/lib/plantRows.js): la
// dimensione di pagina è `PLANT_ROWS_PAGE` — stesso default di mille — e il tetto è
// `PLANT_ROWS_MAX_PAGES × pagina`, cioè le stesse 200.000 righe, ma DICHIARATE quando si raggiungono
// invece che tacite.
const DETAIL_CHUNK = 150;          // batch di dettaglio A_Product, ramo ONPREM
// Numero massimo di materiali inviati per esecuzione (0 = illimitato). Utile per
// batching in produzione e test controllati.
const MAX_MATERIALS_PER_RUN = parseInt(process.env.PLEX_MAT_MAX_PER_RUN || '0', 10);
// Lingua per la descrizione materiale (to_Description).
const LANGUAGE = (process.env.PLEX_MAT_LANGUAGE || 'EN').toUpperCase();

// ================================================================
// Enumerazione materiali dei plant attivi
// ================================================================

/**
 * Raccoglie le COPPIE (materiale, plant) in perimetro nei plant attivi, leggendo A_ProductPlant
 * con paginazione (stessa strategia del READ handler loadConfiguredProducts).
 * Applica inoltre il filtro di visibilità/classificazione per plant (customizing
 * ZMatCategory): i materiali che non rispettano alcuna categoria attiva del plant
 * vengono esclusi (non visualizzati né inviati). Nessuna categoria per il plant =>
 * si prendono tutti.
 *
 * [MAT-PLANT-PAIR] Fino alla 0039 questa funzione DEDUPLICAVA per materiale e teneva tre mappe
 * `first-wins` (`plantOf`, `partTypeOf`, `plantFieldsOf`): la classificazione per coppia era già
 * calcolata qui — la riga di `A_ProductPlant` è per coppia, e le categorie sono per plant — e
 * veniva buttata via da tre `if (!map.has(r.Product))`. Ora resta dov'è nata. Da qui in avanti è
 * legittimo che lo stesso materiale abbia una classe su un plant e un'altra su un altro: è
 * esattamente ciò che il customizing per plant dichiara, e prima non veniva onorato.
 *
 * `products` — i materiali DISTINTI — resta e non è una comodità: è l'input di
 * `loadProductDetails`, che legge `A_Product`, cioè anagrafica CROSS-PLANT. Vedi là.
 *
 * @param {object} s4 - servizio OP_API_PRODUCT_SRV_0001 connesso
 * @param {Set<string>} activePlants
 * @param {Map<string, Array>} [categoryConfig] - config categorie per plant (loadCategoryConfig)
 * @returns {Promise<{pairs: Array<{Product: string, Plant: string, partType: string|null,
 *                                  fields: object|null}>, products: string[]}>}
 *          `partType` è la CLASSE risolta dalle categorie di QUEL plant ([W1-03]: è ciò che dice
 *          se la coppia vuole l'operazione di ricevimento); `fields` sono i campi della riga
 *          product-plant, conservati per la riclassificazione dopo la lettura di A_Product
 *          ([POST-GET-CLASSIFY]: senza MTART la classe è cieca).
 */
async function enumerateProducts(s4, activePlants, categoryConfig = new Map(), summary = null) {
  // Una voce per coppia, chiave `${Product}|${Plant}`. Il duplicato dentro lo stesso plant è
  // possibile (la chiave di A_ProductPlant è la coppia, ma una lettura paginata può ripetere una
  // riga se la sorgente non onora lo `$skip`): vince la prima, come faceva il `Set` di prima.
  const byPair = new Map();

  const isMode = s4.mode === 'IS';

  for (const plant of activePlants) {
    const cats = categoryConfig.get(plant) || [];
    const withNav = needsNav(cats);
    // [W1-26] I campi che il canale attivo NON fornisce, fra quelli usati da QUESTE categorie.
    // Non più `withNav`: su IS ora SOBSL e FEVOR arrivano dai campi portanti, quindi `withNav`
    // segnalerebbe un perimetro incompleto che incompleto non è.
    const missingFields = isMode ? fieldsUsedBy(cats, UNAVAILABLE_IN_IS) : [];
    let kept = 0;
    let viaCatchAll = 0; // [W1-01] quanti materiali sono entrati dalla categoria di ripiego
    try {
      // ================================================================
      // [PAGED-READ] Qui c'era il TERZO ciclo di paginazione di `A_ProductPlant` del progetto:
      // pagine da mille, `offset += PAGE`, stop a 200.000 righe. Paginava, ma senza `$orderby` —
      // quindi fra due pagine la sorgente poteva ripetere una riga e saltarne un'altra, in
      // silenzio — senza la guardia dello `$skip` non onorato, senza dimezzamento su una pagina
      // rifiutata, e col troncamento al tetto TACITO. La 0035 aveva unificato le due copie del
      // server web e non questa; la 0040 la chiude.
      //
      // È `readPlantRows` e NON `loadPlantRowsOutcome`: niente cache, di proposito. In un run ogni
      // plant si legge una volta sola, e da qui si SCRIVE su Plex — la via lenta e questo job
      // leggono sempre fresco (DEC-75). Un perimetro di cinque minuti fa è ciò che un notturno non
      // deve avere.
      //
      // `deadlineMs: 0`: i 90 secondi del lettore stanno sotto i 120 dell'approuter. Un job non ha
      // né l'uno né l'altro, e quella scadenza gli troncherebbe un plant grosso OGNI NOTTE.
      //
      // Le colonne restano le tre forme di prima, che `columnsFor` in plantRows.js già risolve per
      // canale: senza categorie basta `Product` (la lettura minima), altrimenti il `$select`
      // esplicito su IS e le navigazioni espanse in ONPREM.
      // ================================================================
      const read = await readPlantRows(s4, plant, {
        ...(cats.length === 0 ? { columns: ['Product'] } : { withNav }),
        deadlineMs: 0
      });
      for (const r of read.byProduct.values()) {
        let partType = null;
        let fields = null;
        // Filtro visibilità per plant: skippa i materiali fuori-config.
        if (cats.length > 0) {
          // [W1-26] Il canale va passato: su IS SOBSL e FEVOR escono dai campi portanti,
          // in ONPREM dalle navigazioni espanse. Senza, si prende sempre il ramo ONPREM.
          // [MAT-PLANT-PAIR] `extractSapFields` si chiama UNA volta e il risultato serve sia
          // alla classificazione sia alla riclassificazione post-GET: erano due chiamate identiche
          // sulla stessa riga.
          fields = extractSapFields(r, s4.mode);
          const cls = classifyMaterial(fields, cats);
          if (!cls.visible) continue;
          if (cls.catchAll) viaCatchAll++;
          // [W1-03] La classe di QUESTO plant, non del primo incontrato: è il criterio con cui si
          // decide se la coppia vuole l'operazione di ricevimento, e il customizing che lo dice è
          // per plant su entrambi i lati.
          partType = cls.plexPartType || null;
        }
        kept++;
        const k = pairKey(r.Product, plant);
        if (!byPair.has(k)) byPair.set(k, { Product: r.Product, Plant: plant, partType, fields });
      }
      // [PAGED-READ] `kept` conta ora MATERIALI e non righe lette: il lettore deduplica, e sul
      // sandbox un plant dà 2308 righe per 2306 materiali. Il numero può quindi scendere di qualche
      // unità rispetto ai run precedenti senza che il perimetro sia cambiato — le righe grezze
      // restano leggibili accanto.
      console.log(`>>> [SYNC] Plant ${plant}: ${read.rows} righe product-plant `
        + `(${read.materials} materiali), ${kept} tenute dopo filtro categorie`
        + (viaCatchAll > 0 ? ` (di cui ${viaCatchAll} dalla categoria di ripiego)` : ''));

      // [PAGED-READ] Un perimetro CORTO si dichiara, e i due casi non sono lo stesso caso: «non ho
      // potuto leggere» (`readOk: false`) degrada il run, «ho letto solo in parte» — troncamento al
      // tetto, `$skip` non onorato, pagine senza ordine — è un'attenzione. Prima nessuno dei due
      // arrivava nel recap: il primo solo se `s4.run` lanciava, il secondo mai.
      if (!read.complete && summary) {
        summary.scope({
          plant,
          objectKey: 'A_ProductPlant',
          status: read.readOk ? 'W' : 'E',
          segments: [
            logMsg.seg(read.readOk ? 'logMatPlantReadPartial' : 'logMatPlantReadFailed'),
            logMsg.technical(`${read.text}${read.error ? ` — ${read.error}` : ''}`)
          ]
        });
      }
      // [W1-01] Il ripiego si DICHIARA nel recap. È `note()` e non `record()`: non è un oggetto
      // trattato ed è informativo, quindi NON degrada il run (DEC-39).
      if (viaCatchAll > 0 && summary) {
        summary.note([logMsg.seg('logMatCatchAll', plant, viaCatchAll, kept)]);
      }
      // [IS-SOURCE] M-03/FR-19: il perimetro è stato valutato con informazioni incomplete.
      // Una nota per esecuzione, non una riga per materiale (FR-23).
      // [W1-26] Si nominano i campi EFFETTIVAMENTE mancanti: con UNAVAILABLE_IN_IS vuoto la nota
      // non compare, e il giorno che l'elenco tornasse a riempirsi dice quale campo manca.
      if (missingFields.length && summary) {
        const segs = [logMsg.seg('logMatMissingFields', plant, missingFields.join('/'))];
        console.warn(`>>> [IS-SOURCE] ${renderMsg(segs)}`);
        summary.note(segs);
      }
    } catch (error) {
      // [PAGED-READ] `readPlantRows` NON lancia per una pagina caduta — un guasto è un esito, ed è
      // il ramo qui sopra. Si arriva qui per qualcos'altro: la sorgente che non si connette, il
      // modello senza l'entity, una categoria che rompe la classificazione.
      console.error(`>>> [SYNC] ERRORE lettura A_ProductPlant per Plant=${plant}: ${error.message}`);
      // Scope ridotto: i materiali di questo plant non sono stati nemmeno enumerati, quindi
      // il run non può risultare 'S'. Senza questa riga il recap direbbe "0 errori" mentre
      // un intero plant è stato saltato.
      if (summary) {
        summary.scope({
          plant,
          objectKey: 'A_ProductPlant',
          status: 'E',
          segments: [logMsg.seg('logMatPlantReadFailed'), logMsg.technical(error.message)]
        });
      }
    }
  }

  const pairs = [...byPair.values()];
  return { pairs, products: matPlantRules.distinctProducts(pairs) };
}

/**
 * Recupera in batch i dettagli materiale (descrizione + LastChangeDate + MTART + MEINS) da
 * A_Product.
 *
 * [MAT-PLANT-PAIR] PRENDE I MATERIALI DISTINTI E NON LE COPPIE. `A_Product` è anagrafica a livello
 * mandante: descrizione, `LastChangeDate`, `MTART` e `MEINS` non dipendono dal plant, quindi lo
 * stesso materiale su tre plant resta UNA voce in questa mappa.
 *
 * [PRODUCT-QUERY] I PLANT PERÒ SERVONO, ed è cambiato con la 0040. Qui c'era scritto che passare le
 * coppie avrebbe moltiplicato per il numero di plant un costo di DUE letture per materiale: quel
 * costo non esiste più, perché su canale IS l'anagrafica si legge con una query PER PLANT
 * (`SO_PLANT` è il criterio, un plant per chiamata). I plant non sono quindi un raffinamento della
 * chiave — la chiave resta il materiale — sono ciò che rende la lettura componibile. La regola di
 * prima resta valida al contrario: le COPPIE non si passano, i PLANT sì.
 *
 * Conseguenza coerente: la riga di recap di una lettura fallita (più sotto) resta SENZA plant
 * quando parla di materiali, e lo PORTA quando parla della lettura di un plant — che ora è
 * l'oggetto vero del guasto.
 *
 * @param {object} s4 - sorgente d'area materiali (decide la modalità)
 * @param {string[]} productNumbers materiali DISTINTI
 * @param {Iterable<string>} plants i plant attivi su cui l'anagrafica va cercata
 * @returns {Promise<Map<string, {ProductDescription: string, LastChangeDate: string|null,
 *                                ProductType: string|undefined, BaseUnit: string|null}>>}
 */
async function loadProductDetails(s4, productNumbers, plants = [], summary = null) {
  const map = new Map();

  // [IS-SOURCE] (M2) La forma della lettura la decide la sorgente:
  //   ONPREM -> batch da 150 con $expand to_Description, cioè la query di oggi (TD-5);
  //   IS     -> [PRODUCT-QUERY] una lettura paginata per plant su A_Product, descrizione compresa.
  //
  // [PAGED-READ] `deadlineMs: 0` — NESSUNA SCADENZA, e non è distrazione. I 90 secondi del lettore
  // stanno sotto i 120 dell'approuter, cioè servono a non far scadere una richiesta del browser:
  // un job non ha né l'uno né l'altro, e applicargli quella scadenza troncherebbe il perimetro di
  // un plant grosso a metà, dichiarandolo — cioè manderebbe a Plex meno materiali di quanti ce ne
  // sono, ogni notte, per un motivo che non lo riguarda.
  const { byProduct, failed, scope } = await fetchProductsForPlants(s4, productNumbers, {
    plants,
    deadlineMs: 0,
    // [PRODUCT-QUERY] Niente cache, per la stessa ragione della lettura del perimetro: in un run
    // ogni plant si legge una volta, e da qui si SCRIVE su Plex (DEC-75). Le DUE letture di un plant
    // devono avere la stessa politica, o il job leggerebbe fresco `A_ProductPlant` e dalla cache
    // `A_Product` — due fotografie di istanti diversi confrontate come se fossero una.
    fresh: true,
    // [POST-GET-CLASSIFY] ProductType si aggiunge alle colonne di una lettura che gia' si fa:
    // ZERO chiamate in piu', ed e' il campo che rende la classificazione attendibile.
    // [W1-03] Idem per BaseUnit, con la stessa aritmetica: e' il campo con cui il delta sa se
    // il materiale sta ASPETTANDO la sua operazione di ricevimento o se semplicemente la sua
    // unita' di misura non e' in elenco (findMissingReceivingOps).
    // [PRODUCT-QUERY] Valgono per il solo ramo ONPREM: sul canale IS il `$select` è quello della
    // query (PRODUCT_QUERY_SELECT), uno per tutti i chiamanti, perché la lettura è del PLANT e non
    // di questi materiali — restringerla qui vorrebbe dire leggere due volte lo stesso plant con
    // due proiezioni diverse.
    columns: ['Product', 'LastChangeDate', 'ProductType', 'BaseUnit'],
    onpremColumns: ['Product', 'LastChangeDate', 'ProductType', 'BaseUnit'],
    language: LANGUAGE,
    chunkSize: DETAIL_CHUNK
  });

  for (const [product, row] of byProduct) {
    map.set(product, {
      ProductDescription: row.ProductDescription || '',
      LastChangeDate: row.LastChangeDate || null,
      ProductType: row.ProductType,  // [POST-GET-CLASSIFY]
      BaseUnit: row.BaseUnit || null // [W1-03]
    });
  }

  // [PRODUCT-QUERY] L'anagrafica si dichiara ANCHE quando è andata bene. Fino alla 0040 questa
  // lettura parlava nel recap solo per lamentarsi, e con la query per plant è diventata il passo da
  // cui dipendono descrizione, MTART, MEINS e la data che governa il delta: chi legge la mail deve
  // poter vedere che è riuscita, senza aprire `cf logs`.
  //
  // È `note()` e non `record()` né `scope()`: non è un oggetto trattato ed è informativa, quindi non
  // degrada il run (DEC-39). Esce solo se `scope` c'è, cioè in modalità IS: in ONPREM la lettura non
  // è per plant e «N plant letti» direbbe il falso.
  if (summary && Array.isArray(scope) && scope.length) {
    summary.note([logMsg.seg('logMatProductRead', scope.length, map.size, productNumbers.length)]);
  }

  for (const f of failed) {
    console.error(`>>> [SYNC] ERRORE lettura ${f.key}: ${f.message}`);
    // I materiali coperti da quella lettura verranno inviati a Plex con descrizione VUOTA e
    // senza LastChangeDate (quindi il delta li ri-invierà ogni run): va detto nel recap.
    // [PRODUCT-QUERY] Il plant c'è quando il guasto è di una lettura di plant, e allora la riga va
    // nell'allegato di QUEL plant. Resta assente quando parla di materiali non trovati, che è un
    // fatto di mandante: attribuirlo a uno stabilimento sarebbe un'invenzione.
    // [RUN-BLOCKED] `'E'` e non `'W'`: la riga qui sopra descrive un effetto sul DATO SCRITTO su
    // Plex — part con descrizione vuota — e non una perdita di informazione nostra. Non esiste una
    // chiamata caduta che non lasci un segno sul lavoro, ed è la ragione per cui la regola della
    // DEC-124 non ha una famiglia di letture «solo informative» da tenere allineata.
    if (summary) {
      summary.scope({
        ...(f.plant ? { plant: f.plant } : {}),
        objectKey: f.key,
        status: 'E',
        segments: [logMsg.seg('logMatDetailReadFailed'), logMsg.technical(f.message)]
      });
    }
  }

  return map;
}

// ================================================================
// Logica delta
// ================================================================

/**
 * [W1-03] Le COPPIE (materiale, plant) che ASPETTANO la loro operazione di ricevimento.
 *
 * [MAT-PLANT-PAIR] Ragiona per coppia dalla feature 0039, e non e' un adeguamento formale: il
 * dizionario letto per solo `Product` avrebbe risposto «gia' fatta» al plant B perche' l'aveva
 * fatta il plant A — su un ALTRO tenant, dove quella part-operation non esiste. La part di B
 * sarebbe rimasta senza operazione su cui ricevere, e nulla l'avrebbe detto: `ALREADY_DONE` non
 * degrada niente, il log resta 'S', e il buco non si richiude perche' `needsSend` ripesca solo cio'
 * che QUESTA funzione dichiara in attesa. Le due letture sbaglierebbero insieme.
 *
 * Aspettarla vuol dire tre cose insieme, e servono tutte e tre:
 *   1. la CLASSE la vuole (ZPlexPartTypeVH.RequiresReceivingOp, W1-02) — e la classe e' quella
 *      risolta dalle categorie DI QUEL PLANT, quindi puo' valere su un plant e non sull'altro;
 *   2. l'unita' di misura del materiale ha una riga di ricevimento ATTIVA sul plant DELLA COPPIA,
 *      cioe' la stessa domanda che si pone l'invio — si riusa `resolveReceivingOperation` invece di
 *      riscriverne il criterio, altrimenti delta e invio potrebbero rispondere diversamente;
 *   3. il dizionario ZMatRecvOpMapping e' vuoto PER QUELLA COPPIA.
 *
 * Il punto 2 e' cio' che impedisce il RI-INVIO PERENNE. Senza, un materiale la cui unita' non
 * e' in elenco tornava nella coda a ogni esecuzione per sempre: il suo dizionario non si
 * sarebbe riempito mai, perche' non c'e' niente da istanziare. E l'unita' di misura non e'
 * nemmeno un dato della part su Plex — sta sul componente della distinta — quindi non e' una
 * lacuna della part, e ora non degrada piu' nemmeno l'invio (DEGRADING_STATES in
 * srv/lib/recvOpRules.js).
 *
 * La proprieta' che conta resta intatta: il giorno in cui il configuratore aggiunge l'unita'
 * mancante, quei materiali entrano nel punto 2 e il buco si richiude da solo al run successivo.
 * Vale anche per un POST fallito, che e' l'altro caso in cui il dizionario resta vuoto.
 *
 * Tre letture LOCALI per esecuzione, non per materiale: la value help delle classi (in cache),
 * il customizing del ricevimento e il dizionario. Materiale senza `BaseUnit` (lettura dettagli
 * fallita) => non e' in attesa: quel materiale viene gia' rispedito da `needsSend`, che senza
 * `LastChangeDate` e' conservativo.
 *
 * Lettura fallita => insieme VUOTO, cioe' il delta di prima: non si rimanda in coda l'intero
 * catalogo materiali perche' una lettura locale non e' riuscita.
 *
 * @param {object} db
 * @param {Array<{Product: string, Plant: string, partType: string|null}>} pairs
 * @param {Map<string,object>} detailMap   Product -> dettagli SAP, per il BaseUnit
 * @returns {Promise<Set<string>>} chiavi di coppia (`matPlantRules.pairKey`)
 */
async function findMissingReceivingOps(db, pairs, detailMap = new Map()) {
  return (await analyzeReceivingOps(db, pairs, detailMap)).missing;
}

/**
 * [RECV-OP-DRIFT] Le due domande sul ricevimento, in UNA passata (feature 0044).
 *
 * `missing` — chi ASPETTA la sua operazione (la domanda di W1-03, invariata).
 * `drifted` — chi ce l'ha, ma su un'operazione DIVERSA da quella che il customizing dice adesso:
 *             il plant l'ha cambiata dopo che il materiale era gia' uscito, e prima della 0044
 *             quel cambio non arrivava su NESSUN materiale gia' inviato, in silenzio.
 *
 * SONO UNA FUNZIONE SOLA perche' leggono ESATTAMENTE le stesse tre sorgenti — la value help delle
 * classi, `ZMatRecvOpConfig`, `ZMatRecvOpMapping` — e perche' due funzioni che risolvono lo stesso
 * customizing possono rispondere diversamente. Il dizionario si legge con due colonne in piu'
 * (`PlexOperationId`, `BaseUnit`): stessa lettura, non una in piu'.
 *
 * IL PERIMETRO DEL CONFRONTO E' `byClass`, NON `wanted`. Chi ha una riga di dizionario va guardato
 * anche quando la sua unita' di misura non risolve piu' niente: e' il caso `GONE`, che si dichiara
 * al momento dell'invio e non si riallinea.
 *
 * La regola che classifica il disallineamento e' pura e sta in `recvOpRules.recvOpDrift`, col suo
 * test: qui c'e' solo l'orchestrazione. Si rimanda in coda il SOLO `CONFIG` — `UOM` e' un cambio del
 * materiale, non della configurazione, e resta dichiarato e non corretto (DEC-63 conseguenza 3).
 *
 * Lettura fallita => insiemi VUOTI, cioe' il delta di prima: non si rimanda in coda l'intero
 * catalogo perche' una lettura locale non e' riuscita.
 *
 * @param {object} db
 * @param {Array<{Product: string, Plant: string, partType: string|null}>} pairs
 * @param {Map<string,object>} detailMap Product -> dettagli SAP, per il BaseUnit
 * @returns {Promise<{missing: Set<string>, drifted: Set<string>, driftedByPlant: Map<string, number>}>}
 */
async function analyzeReceivingOps(db, pairs, detailMap = new Map()) {
  const missing = new Set();
  const drifted = new Set();
  const driftedByPlant = new Map();
  if (!pairs || pairs.length === 0) return { missing, drifted, driftedByPlant };
  try {
    const index = await loadPartTypeIndex(db);
    // Solo le coppie la cui CLASSE vuole l'operazione: sulle altre non c'e' niente da attendersi
    // ne' da riallineare, quindi non si interroga nemmeno il dizionario.
    const byClass = pairs.filter((p) => classInfo(index, p.partType).requiresReceivingOp);
    if (byClass.length === 0) return { missing, drifted, driftedByPlant };

    // Il customizing di TUTTI i plant in una lettura, indicizzato per plant: la risoluzione
    // per materiale e' poi in memoria.
    const cfgRows = await db.run(
      SELECT.from(E_RECV_OP_CONFIG)
        .columns('Plant', 'BaseUnit', 'PlexOperationId', 'IsActive')
    ) || [];
    const cfgByPlant = new Map();
    for (const r of cfgRows) {
      if (!r) continue;
      if (!cfgByPlant.has(r.Plant)) cfgByPlant.set(r.Plant, []);
      cfgByPlant.get(r.Plant).push(r);
    }

    // La risoluzione di ogni coppia, fatta UNA volta: la usano tutte e due le domande.
    const resolvedByPair = new Map();
    for (const p of byClass) {
      const baseUnit = (detailMap.get(p.Product) || {}).BaseUnit;
      resolvedByPair.set(pairKey(p.Product, p.Plant), {
        baseUnit,
        resolved: baseUnit
          ? recvOpRules.resolveReceivingOperation({ baseUnit, rules: cfgByPlant.get(p.Plant) || [] })
          : null
      });
    }
    const isWanted = (p) => {
      const r = resolvedByPair.get(pairKey(p.Product, p.Plant));
      return !!(r && r.resolved && r.resolved.state === 'OK');
    };
    const wanted = byClass.filter(isWanted);
    const unmapped = byClass.length - wanted.length;

    // [MAT-PLANT-PAIR] Il filtro resta sul MATERIALE — è un prefisso della chiave primaria, quindi
    // usa l'indice — e la selezione della coppia si fa in memoria. La scorciatoia che sembra ovvia,
    // `where({ Product: { in: … }, Plant: { in: … } })`, è un PRODOTTO CARTESIANO: restituirebbe
    // (X, plantA) mentre si sta chiedendo di (X, plantB), cioè esattamente il difetto da chiudere.
    const rows = await db.run(
      SELECT.from(E_RECV_OP_MAPPING).columns('Product', 'Plant', 'PlexOperationId', 'BaseUnit')
        .where({ Product: { in: matPlantRules.distinctProducts(byClass) } })
    );
    const dict = matPlantRules.indexByPair(rows || []).index;

    for (const p of byClass) {
      const k = pairKey(p.Product, p.Plant);
      const mapping = dict.get(k);
      const { baseUnit, resolved } = resolvedByPair.get(k) || {};

      if (!mapping) {
        // La domanda di W1-03, invariata: aspetta solo chi ha un'operazione da attendersi.
        if (isWanted(p)) missing.add(k);
        continue;
      }
      const d = recvOpRules.recvOpDrift({ mapping, resolved, baseUnit });
      if (d.drift === recvOpRules.DRIFT.CONFIG) {
        drifted.add(k);
        const plant = matPlantRules.keyPart(p.Plant);
        driftedByPlant.set(plant, (driftedByPlant.get(plant) || 0) + 1);
      }
    }

    if (missing.size > 0) {
      console.log(`>>> [W1-03] ${missing.size} coppie su ${wanted.length} attendono ancora`
        + ' l\'operazione di ricevimento'
        + (unmapped > 0 ? ` (altre ${unmapped} hanno un'unita' di misura non in elenco: non sono in attesa)` : ''));
    } else if (unmapped > 0 && wanted.length === 0) {
      console.log(`>>> [W1-03] ${unmapped} coppie di una classe che vuole l'operazione di`
        + ' ricevimento hanno un\'unita\' di misura senza riga di customizing: non sono in attesa');
    }
    if (drifted.size > 0) {
      console.log(`>>> [RECV-OP-DRIFT] ${drifted.size} coppie hanno l'operazione di ricevimento su`
        + ' un\'operazione Plex diversa da quella configurata adesso: rimesse in coda per il'
        + ' riallineamento');
    }
  } catch (e) {
    console.warn(`>>> [W1-03] verifica delle operazioni di ricevimento fallita: ${e.message}`);
    return { missing: new Set(), drifted: new Set(), driftedByPlant: new Map() };
  }
  return { missing, drifted, driftedByPlant };
}

/**
 * [PART-ALIVE] L'elenco delle part di ogni tenant coinvolto: UNA lettura per plant.
 *
 * E' l'unica parte di questa feature che parla con la rete, e sta da sola per questo: cosi' la
 * composizione dell'insieme delle coppie mancanti riceve l'esito come dato e ha il suo test.
 *
 * Un plant la cui connessione Plex non si risolve non produce un'eccezione e non ferma gli altri:
 * produce un esito `remoteKnown: false`, che a valle vale «non lo so» e non «non c'e' niente».
 *
 * @param {Array<string>} plants
 * @returns {Promise<Map<string, object>>} plant -> esito di `loadPartCatalog`
 */
async function readTenantCatalogs(plants) {
  const out = new Map();
  for (const plant of plants || []) {
    let conn = null;
    try {
      conn = await resolvePlexConnection(plant);
    } catch (e) {
      console.warn(`>>> [PART-ALIVE] plant ${plant}: connessione Plex non risolta (${e.message}):`
        + ' elenco part non letto');
    }
    out.set(plant, conn
      ? await plexPartCatalog.loadPartCatalog(conn, plant)
      : {
        remoteKnown: false, ids: new Set(), numbers: new Set(), count: 0,
        error: 'connessione Plex non risolta per il plant'
      });
  }
  return out;
}

/**
 * [PART-ALIVE] Le COPPIE la cui part non risulta esistere su Plex (feature 0042).
 *
 * Gemella di `findMissingReceivingOps` qui sopra, e la somiglianza non e' estetica: entrambe
 * rispondono a «cosa manca DAVVERO là fuori», entrambe alimentano il delta con una condizione che
 * ignora le date, ed entrambe devono AUTO-CHIUDERSI o produrrebbero un reinvio perenne in verde.
 *
 * DUE LETTURE, DI NATURA DIVERSA:
 *   - una LOCALE, il dizionario `ZMatPlexMapping` del perimetro — filtro sul materiale (prefisso di
 *     chiave primaria) e indicizzazione sulla coppia, come per la testata;
 *   - una REMOTA per PLANT, l'elenco delle part del tenant. Una per plant, non una per materiale.
 *
 * La regola che le combina e' pura e sta in `matPlantRules.partMissingSet`, col suo test: qui c'e'
 * solo l'orchestrazione. Su un plant la cui connessione Plex non si risolve non si conclude niente
 * per quel plant, e gli altri proseguono — un plant senza connessione e' il fail-closed dichiarato
 * di DEC-52, e lo dice gia' chi prova a inviare.
 *
 * IL RECAP HA UNA RIGA PER PLANT, mai per coppia: 304 righe della stessa frase non sono
 * informazione. I tre numeri — part sul tenant, coppie con dizionario, coppie riallineate — sono il
 * contenuto: «0 / 304 / 304» e «304 / 304 / 0» sono i due mattini in cui si capisce tutto senza
 * aprire `cf logs`, e sono l'unico modo di accorgersi di un elenco corto prima che diventi un
 * incidente.
 *
 * L'ELENCO DEL TENANT ARRIVA COME PARAMETRO, non lo legge questa funzione: e' la stessa forma di
 * `findMissingReceivingOps`, che riceve `detailMap`. Cosi' l'unica parte non collaudabile — la
 * chiamata di rete — sta in `readTenantCatalogs`, e tutto il resto ha il suo test con un db finto.
 *
 * @param {object} db
 * @param {Array<{Product: string, Plant: string}>} pairs
 * @param {Map<string, {remoteKnown: boolean, ids: Set<string>, count: number, error?: string}>} tenantByPlant
 * @param {object|null} summary
 * @returns {Promise<Set<string>>} chiavi di coppia da (ri)inviare
 */
async function findMissingParts(db, pairs, tenantByPlant = new Map(), summary = null) {
  if (!pairs || pairs.length === 0) return new Set();

  // 1) il dizionario del perimetro
  let mappingIndex = new Map();
  try {
    const rows = await db.run(
      SELECT.from(E_MAT_MAPPING).columns('Product', 'Plant', 'PlexId')
        .where({ Product: { in: matPlantRules.distinctProducts(pairs) } })
    );
    mappingIndex = matPlantRules.indexByPair(rows).index;
  } catch (e) {
    // Il dizionario non letto NON si traduce in «nessuna part esiste»: sarebbe un reinvio di tutto
    // il perimetro su un guasto locale. Si dichiara e si esce senza concludere.
    console.error(`>>> [PART-ALIVE] dizionario materiali non letto (${e.message}):`
      + ' nessun riallineamento in questo run');
    if (summary) {
      summary.scope({
        objectKey: 'ZMatPlexMapping', status: 'E', degrade: true,
        segments: [logMsg.seg('logMatPartCheckFailed'), logMsg.technical(e.message)]
      });
    }
    return new Set();
  }

  // 2) l'elenco del tenant e' gia' stato letto dal chiamante (vedi `readTenantCatalogs`)
  const plants = [...new Set(pairs.map((p) => matPlantRules.keyPart(p.Plant)))];

  // 3) la regola pura
  const verdict = matPlantRules.partMissingSet(pairs, mappingIndex, tenantByPlant);

  // 4) la dichiarazione, una riga per plant
  for (const plant of plants) {
    const t = tenantByPlant.get(plant) || {};
    const ofPlant = pairs.filter((p) => matPlantRules.keyPart(p.Plant) === plant);
    const conMapping = ofPlant.filter((p) => mappingIndex.has(pairKey(p.Product, p.Plant))).length;
    const riallineate = ofPlant.filter((p) => verdict.missing.has(pairKey(p.Product, p.Plant))).length;

    if (summary) {
      summary.scope({
        plant,
        objectKey: plexPartsApi.partsCatalogPath(),
        status: t.remoteKnown ? 'W' : 'E',
        // `degrade` SOLO su lettura fallita. Le coppie riallineate sono gia' oggetti trattati
        // contati da `record()`: degradare anche per lo stesso fatto conterebbe due volte
        // l'anomalia, e con un tenant che si azzera ogni settimana il job chiuderebbe in attenzione
        // ogni settimana su un run corretto — cioe' l'attenzione smetterebbe di significare qualcosa.
        degrade: !t.remoteKnown,
        segments: t.remoteKnown
          ? [logMsg.seg('logMatPlexPartsRead', t.count, conMapping, riallineate)]
          : [logMsg.seg('logMatPlexPartsUnread'), logMsg.technical(t.error || '')]
      });
    }
    console.log(`>>> [PART-ALIVE] plant ${plant}: ${t.remoteKnown ? `${t.count} part sul tenant` : 'elenco NON letto'}`
      + `, ${conMapping} coppie con dizionario su ${ofPlant.length}, ${riallineate} da riallineare`);
  }

  if (!REMOTE_CHECK) {
    // La lettura e la dichiarazione sono gia' avvenute: si spegne il solo EFFETTO, e resta la meta'
    // locale, che non ha leva. Senza questa riga la leva spegnerebbe anche cio' che serve a capire.
    const soloLocali = new Set();
    for (const p of pairs) {
      const k = pairKey(p.Product, p.Plant);
      if (!mappingIndex.has(k)) soloLocali.add(k);
    }
    console.log('>>> [PART-ALIVE] PLEX_MAT_REMOTE_CHECK=off: la meta\' remota non alimenta il delta'
      + ` (${verdict.goneOnPlex} coppie non verranno riallineate). Resta la meta' locale:`
      + ` ${soloLocali.size} coppie senza dizionario.`);
    if (summary) summary.note([logMsg.seg('logMatRemoteCheckOff', verdict.goneOnPlex)]);
    return soloLocali;
  }

  if (verdict.plantsUnknown.length) {
    console.warn(`>>> [PART-ALIVE] elenco non letto per ${verdict.plantsUnknown.join(', ')}:`
      + ' per quei plant vale la sola meta\' locale (una lettura fallita non dimostra che la part non c\'e\')');
  }
  console.log(`>>> [PART-ALIVE] ${verdict.missing.size} coppie da riallineare`
    + ` (${verdict.noMapping} senza dizionario, ${verdict.goneOnPlex} con dizionario ma assenti dal tenant)`);
  return verdict.missing;
}

/**
 * [PLEX-PART-CODES] Dichiara nel recap i plant che mandano ancora la TIPOLOGIA come stringa
 * invece che come codice del tenant (feature 0022, DEC-65).
 *
 * Serve perche' la lacuna e' INVISIBILE dall'esito: senza codice l'invio riesce lo stesso, la
 * part esce, il log dice 'S'. L'unica differenza e' che su Plex quella part ha la tipologia
 * sbagliata o nessuna — e nessuno lo scopre finche' non lo guarda in Plex.
 *
 * E' `scope()` con `degrade: true` e NON `record()`: non e' un oggetto trattato, e una
 * configurazione mancante di plant non deve alimentare l'exit code come se fossero materiali
 * falliti (CLAUDE.md, RB-28…RB-31, DEC-39). Ma il run chiude in attenzione, cosi' i destinatari
 * ON_ERROR lo vedono.
 *
 * UNA riga per plant, non per materiale: quella per materiale sarebbe la stessa frase decine di
 * migliaia di volte.
 *
 * Lettura fallita => nessuna dichiarazione: non si trasforma un problema di lettura locale in
 * un allarme di configurazione.
 *
 * @param {object} db
 * @param {Set<string>} activePlants
 * @param {Map<string, Array>} categoryConfig  per plant, le categorie attive (loadCategoryConfig)
 * @param {object|null} summary
 */
async function declareMissingTypeCodes(db, activePlants, categoryConfig, summary) {
  if (!summary) return;
  try {
    const vhIndex = await loadPartTypeIndex(db);
    for (const plant of activePlants) {
      const cats = categoryConfig.get(plant) || [];
      if (cats.length === 0) continue; // nessuna categoria => nessun `type` nel payload
      // Le TIPOLOGIE che le categorie di questo plant possono produrre: la classe passa prima
      // per il seed (DEC-62), perche' e' la tipologia — non la classe — ad avere un codice.
      const typeValues = cats
        .map(c => plexValueOf(vhIndex, c.PlexPartType))
        .filter(Boolean);
      if (typeValues.length === 0) continue;

      const codeIndex = await loadPartTypeCodeIndex(plant, db);
      const missing = missingTypeCodes(codeIndex, typeValues);
      if (missing.length === 0) continue;

      const segs = [logMsg.seg('logMatNoTypeCodes', plant, missing.join(', '))];
      console.warn(`>>> [PLEX-PART-CODES] ${renderMsg(segs)}`);
      summary.scope({
        plant,
        objectKey: 'ZPlexPartTypeCode',
        status: 'W',
        segments: segs,
        degrade: true
      });
    }
  } catch (e) {
    console.warn(`>>> [PLEX-PART-CODES] verifica dei codici tipologia mancanti fallita: ${e.message}`);
  }
}

/**
 * [PLEX-OP-TYPE] Dichiara le righe di ricevimento la cui operazione non ha un TIPO su Plex.
 *
 * E' la gemella di declareMissingTypeCodes qui sopra, e nasce dalla stessa invisibilita' — anzi
 * peggiore. Il passo di ricevimento e' accessorio: se il POST fallisce, l'invio del materiale
 * degrada a 'W' ma la part esce lo stesso (DEC-38), quindi «operazione di ricevimento mai creata»
 * e «operazione creata» si somigliano moltissimo guardando il log.
 *
 * LA DOMANDA E' CAMBIATA con la feature 0024 (DEC-84), la voce di recap no. Prima il tipo era un
 * campo di customizing e la lacuna era «nessuno l'ha digitato»; ora lo dichiara il catalogo Plex
 * (`OperationDTO.type`) e le lacune possibili sono due, con rimedi opposti: il catalogo non si
 * legge (guasto o connessione), oppure quell'operazione sul tenant non ha un tipo (dato da
 * sistemare su Plex). Si dichiarano SEPARATE, perche' un messaggio unico le renderebbe
 * indistinguibili — che e' esattamente il difetto che questa voce esiste per evitare.
 *
 * Solo le righe ATTIVE: una riga disattivata non viene usata, e dichiararla sarebbe rumore.
 *
 * Il catalogo e' quello che il passo di ricevimento legge comunque, con la stessa cache per plant:
 * qui non si aggiunge una chiamata per materiale, al massimo una per plant per run.
 *
 * `scope()` con `degrade: true`, una riga per plant e per causa; lettura fallita del customizing
 * => nessuna dichiarazione.
 *
 * @param {object} db
 * @param {Set<string>} activePlants
 * @param {object|null} summary
 */
async function declareMissingRecvOpType(db, activePlants, summary) {
  if (!summary) return;
  try {
    const rows = await db.run(
      SELECT.from('avvaleplm.marsplm.sap2plex.ZMatRecvOpConfig')
        .columns('Plant', 'BaseUnit', 'PlexOperationId', 'PlexOperationCode', 'IsActive')
    );
    // Le righe utili, raggruppate per plant: senza il raggruppamento servirebbe una lettura del
    // catalogo per riga, e sono la stessa lettura.
    const byPlant = new Map();
    for (const r of rows || []) {
      if (!r || r.IsActive === false) continue;
      if (!activePlants.has(r.Plant)) continue;
      if (!String(r.PlexOperationId || '').trim()) continue;  // riga inutilizzabile: non e' questa la lacuna
      if (!byPlant.has(r.Plant)) byPlant.set(r.Plant, []);
      byPlant.get(r.Plant).push(r);
    }

    for (const [plant, plantRows] of byPlant) {
      let conn;
      try {
        conn = await resolvePlexConnection(plant);
      } catch (e) {
        // Plant senza connessione Plex: e' il fail-closed dichiarato di DEC-52 e lo dice gia' chi
        // prova a inviare. Ripeterlo qui sarebbe una seconda riga per la stessa causa.
        continue;
      }

      const catalog = await opCatalog.loadOperationCatalog(conn, plant);
      if (!catalog.ok) {
        const segs = [
          logMsg.seg('logMatOpCatalogUnreadable', plant, recvOpRules.DEFAULT_OP_TYPE),
          logMsg.technical(catalog.error)
        ];
        console.warn(`>>> [PLEX-OP-TYPE] ${renderMsg(segs)}`);
        // [RUN-BLOCKED] Il catalogo non letto fa ripiegare sul tipo di default, e un `type` che sul
        // tenant non esiste e' un `400 FIELD_REFERENCE_NOT_FOUND` che rende il trasferimento un
        // no-op completo (DEC-84): il ripiego non e' una degradazione dell'informazione, e' una
        // scrittura che probabilmente fallira'. Chiamata caduta, quindi run in errore (DEC-124).
        summary.scope({ plant, objectKey: 'ZMatRecvOpConfig', status: 'E', segments: segs, degrade: true });
        continue;
      }

      const untyped = plantRows
        .filter((r) => !opCatalog.typeOf(catalog, r.PlexOperationId))
        .map((r) => `${r.BaseUnit || '(senza unita\')'} -> ${r.PlexOperationCode || r.PlexOperationId}`);
      if (untyped.length === 0) continue;

      const segs = [logMsg.seg(
        'logMatOpTypeMissing', plant, untyped.join(', '), recvOpRules.DEFAULT_OP_TYPE
      )];
      console.warn(`>>> [PLEX-OP-TYPE] ${renderMsg(segs)}`);
      summary.scope({ plant, objectKey: 'ZMatRecvOpConfig', status: 'W', segments: segs, degrade: true });
    }
  } catch (e) {
    console.warn(`>>> [PLEX-OP-TYPE] verifica del tipo operazione di ricevimento fallita: ${e.message}`);
  }
}

// [MAT-PLANT-PAIR] `needsSend` viveva qui ed e' arrivata INVARIATA in srv/lib/matPlantRules.js
// (feature 0039): il difetto non e' mai stato in lei, era nella chiave con cui le si passava `hdr`.
// Nel modulo puro ha il suo test — qui non ne aveva nessuno, benche' fosse esportata apposta.
// Resta ri-esportata in fondo al file per chi la importava da qui.

// ================================================================
// Entry point
// ================================================================

/**
 * @param {object} [summary] collettore del riepilogo di fine job (srv/lib/jobSummary.js).
 *   Opzionale: se assente il job si comporta come prima.
 *
 * [MAT-PLANT-PAIR] Qui stava la NOTA che dichiarava il plant rappresentativo come limitazione nota
 * e accettata («emettere una riga per (Product, Plant) richiederebbe di rifare la logica di
 * delta»). E' esattamente cio' che la feature 0039 ha fatto: la nota e' stata rimossa, non
 * aggiornata. Ogni riga di recap porta ora il plant vero, e i destinatari di ogni plant vedono nel
 * proprio allegato tutte e sole le coppie del loro.
 */
async function run(summary) {
  console.log(`>>> [JOB SyncMaterials] avvio (profilo: ${cds.env.profiles?.join(',') || 'default'})`);

  const db = await cds.connect.to('db');
  const s4 = await productSource(); // [IS-SOURCE]
  const plex = await cds.connect.to(PLEX_SERVICE);
  // Il canale usato dall'esecuzione entra nel recap come nota (FR-06 punto 3).
  if (summary) summary.note([logMsg.seg('logMatSource', s4.mode, s4.originDetail)]);

  const activePlants = await resolveActivePlants(db);
  if (activePlants.size === 0) {
    console.log('>>> [JOB SyncMaterials] nessun plant attivo: niente da fare.');
    // Oggi questo caso esce 0 in silenzio, anche quando la causa e' che il server licenze
    // non risponde (in un job la cache licenze e' sempre vuota, quindi la grace non si
    // applica mai): nel recap diventa uno stato visibile che fa scattare ON_FAILURE.
    if (summary) summary.noScope({ active: 0, usable: 0 });
    return { failed: 0 };
  }

  // 1) le COPPIE (materiale, plant) CANDIDATE nei plant attivi, filtrate per plant dalla
  //    config categorie/visibilità (ZMatCategory)
  //
  // [MAT-SCOPE] «CANDIDATE» e non «in perimetro»: questo filtro gira sulla sola riga
  // A_ProductPlant, che non porta MTART, ed e' quindi una SOVRA-approssimazione. Il perimetro vero
  // lo decide il passo 2-bis, dopo la lettura dell'anagrafica. Il verdetto della lettura del
  // customizing viaggia accanto alla mappa: una lettura caduta rende una mappa vuota, che senza il
  // flag e' indistinguibile da «nessun plant ha categorie» — cioe' dal ramo che invia TUTTO senza
  // `type`, che e' l'HTTP 400 da cui la 0050 nasce.
  const { byPlant: categoryConfig, ok: categoriesKnown } = await loadCategoryConfigOutcome(db);
  const { pairs, products } = await enumerateProducts(s4, activePlants, categoryConfig, summary);
  const stats = matPlantRules.pairStats(pairs);
  console.log(`>>> [SYNC] Perimetro: ${stats.materials} materiali su ${stats.plants} plant`
    + `, ${stats.pairs} coppie (materiale, plant)`);
  if (pairs.length === 0) {
    if (summary) summary.note([logMsg.seg('logMatNoneVisible')]);
    return { failed: 0 };
  }
  // [MAT-PLANT-PAIR] Il numero di coppie SI DICHIARA. E' l'unica riga che rende visibile il cambio
  // di volume: senza, un run che manda il triplo degli oggetti e' indistinguibile da un difetto.
  if (summary) {
    summary.note([logMsg.seg('logMatPairsInScope', stats.materials, stats.plants, stats.pairs)]);
  }

  // 2) dettagli SAP (descrizione + data modifica)
  // [PRODUCT-QUERY] I plant attivi entrano nella lettura: sul canale IS l'anagrafica si chiede per
  // plant, ed è l'unico criterio che quell'indirizzo accetta.
  const detailMap = await loadProductDetails(s4, products, activePlants, summary);

  // 2-bis) [POST-GET-CLASSIFY] [MAT-SCOPE] IL PERIMETRO SI DECIDE ORA, con MTART in mano.
  //
  // Quella di enumerateProducts e' cieca su MTART — non sta su A_ProductPlant — quindi un ZPF non
  // aggancia «Finished Product» e cade nel ripiego come `Component`. `Component` vuole
  // l'operazione di ricevimento, quindi findMissingReceivingOps lo marca come in attesa, needsSend
  // lo rispedisce, e all'invio la classe VERA dice che quell'operazione non serve: il dizionario
  // resta vuoto e il materiale si rispedisce al run successivo, per sempre. Questo passo chiude
  // quel giro. Nessuna lettura in piu': i dettagli sono gia' stati letti al passo 2.
  //
  // [MAT-SCOPE] E DALLA 0050 QUESTO PASSO POTA, non riassegna soltanto la classe (feature 0050).
  //
  // Prima faceva `p.partType = classifyMaterial(merged, cats).plexPartType || null` e buttava
  // `visible`: una coppia che nessuna categoria aggancia usciva con `partType: null`, restava nel
  // perimetro, entrava nel delta e veniva INVIATA a Plex, che rifiutava il corpo senza `type` con
  // `HTTP 400`. E si rispediva ogni notte, perche' `needsSend` rimette in coda ogni coppia il cui
  // ultimo esito non e' 'S'/'W'.
  //
  // TRE COSE CHE L'INNESTO OVVIO SBAGLIA, e nessuna delle tre da' errore:
  //
  // 1. SI GIRA SU OGNI COPPIA. La guardia `!cats.length || !needsProductDetails(cats)` salta i
  //    plant le cui categorie non usano MTART — ed e' esattamente dove vive il caso «categoria
  //    senza tipologia», che di MTART non ha alcun bisogno. Quelle coppie non verrebbero MAI
  //    potate. Il ramo «nessuna categoria» resta pero' fuori perimetro dalla potatura per un'altra
  //    ragione: `finalScope` lo tratta da se' come `NO_CATEGORIES`, che e' inviabile.
  //
  // 2. L'ANAGRAFICA MANCANTE E' UNA TERZA COSA, non «tieni la classe di prima». Prima il `continue`
  //    lasciava la classe cieca e la coppia partiva comunque: si mandava a Plex un materiale di cui
  //    non si sapeva se avesse una categoria. Ora si TRATTIENE e si DICHIARA, e il run dopo
  //    riprova — una lettura caduta non dimostra l'assenza. `finalScope` lo fa scattare solo dove
  //    l'anagrafica SERVE (categorie su MTART): altrove il verdetto cieco era gia' definitivo.
  //
  // 3. IL PASSO STA PRIMA del delta e di `analyzeReceivingOps`, e non e' un caso: l'insieme puo'
  //    solo restringersi, quindi tutto cio' che viene dopo lavora sul perimetro vero.
  const typeMappedPlants = await loadTypeMappedPlants(db);
  const scopeTally = new Map();   // plant -> conteggi da dichiarare
  const inScope = [];
  let retyped = 0;
  for (const p of pairs) {
    const cats = categoryConfig.get(p.Plant) || [];
    if (!scopeTally.has(p.Plant)) scopeTally.set(p.Plant, matScope.newTally());
    const acc = scopeTally.get(p.Plant);
    const detail = detailMap.get(p.Product);
    const v = matScope.finalScope({
      sapFields: mergeProductFields(p.fields || {}, detail),
      detailKnown: !!detail,
      categories: cats,
      categoriesKnown,
      typeAvailable: typeMappedPlants.has(p.Plant)
    });
    matScope.tally(acc, v.reason, v.sendable);
    if (!v.sendable) continue;
    if (v.plexPartType !== p.partType) retyped++;
    p.partType = v.plexPartType;
    inScope.push(p);
  }
  const pruned = pairs.length - inScope.length;
  pairs.length = 0;
  pairs.push(...inScope);
  if (retyped) {
    console.log(`>>> [POST-GET-CLASSIFY] classe corretta dopo la GET per ${retyped} coppie`);
  }

  // [MAT-SCOPE] La potatura SI DICHIARA nel recap, e i DUE GRUPPI DI MOTIVI NON SI FONDONO.
  //
  // Customizing (`NO_CATEGORY_MATCH`, `NO_PART_TYPE`): e' la normalita' di un perimetro
  // configurato, quindi `note()` e nessuna degradazione — un giallo perenne senza rimedio insegna
  // a ignorare il giallo (DEC-115). «Non si sa» (`DETAIL_UNKNOWN`, `CATEGORIES_UNKNOWN`): sono
  // materiali che forse andavano inviati, il rimedio non e' il customizing, e degradano.
  //
  // Le voci di verdetto stanno DAVANTI ai contatori, perche' `pack()` scarta la coda e i due tetti
  // della testata tagliano proprio la fine (addendum del 07/09/2026 a DEC-124).
  if (summary && pruned > 0) {
    for (const [plant, acc] of scopeTally) {
      const perConfig = matScope.prunedByConfig(acc);
      const perIgnoto = matScope.prunedByUnknown(acc);
      if (perConfig > 0) {
        summary.note([logMsg.seg('logMatScopePruned', plant, acc.kept, acc.total,
          acc[matScope.SCOPE.NO_CATEGORY_MATCH], acc[matScope.SCOPE.NO_PART_TYPE])]);
        // Le categorie senza tipologia si NOMINANO, non si contano: `classifyMaterial` prende la
        // PRIMA che aggancia per `Sequence`, quindi una senza tipologia in testa OMBREGGIA tutte
        // le successive e il ripiego. Il rimedio e' quella riga; un numero manderebbe a cercare
        // nei materiali.
        const senzaTipo = matScope.untypedCategories(categoryConfig.get(plant) || []);
        if (acc[matScope.SCOPE.NO_PART_TYPE] > 0 && senzaTipo.length) {
          summary.note([logMsg.seg('logMatScopeUntyped', plant, senzaTipo.join(', '))]);
        }
      }
      if (perIgnoto > 0) {
        // `scope({status:'W'})` e non `record`: non sono oggetti TRATTATI, sono oggetti che il run
        // ha deciso di NON trattare, e la notizia non ha un oggetto su cui posarsi (DEC-124).
        summary.scope({
          plant,
          objectKey: 'MAT_SCOPE',
          status: 'W',
          segments: [logMsg.seg('logMatScopeHeld', plant, perIgnoto,
            acc[matScope.SCOPE.DETAIL_UNKNOWN], acc[matScope.SCOPE.CATEGORIES_UNKNOWN])]
        });
      }
    }
  }
  if (pruned > 0) {
    console.log(`>>> [MAT-SCOPE] perimetro finale: ${pairs.length} coppie (${pruned} escluse dopo`
      + ' la lettura dell\'anagrafica — nessuna categoria, nessuna tipologia, o non si sa)');
  }
  if (pairs.length === 0) {
    // Il caso «tutto potato» non deve chiudere in silenzio: le voci qui sopra ci sono, ma senza
    // questa il recap direbbe solo «0 coppie», che si legge come «non c'era niente da fare».
    if (summary) summary.note([logMsg.seg('logMatNoneVisible')]);
    return { failed: 0 };
  }

  // 3) ultimo invio per COPPIA (ZMatExcLogHDR, chiave (Product, Plant) dalla 0031)
  //
  // [MAT-PLANT-PAIR] Il filtro resta sul materiale — prefisso della chiave primaria — e
  // l'indicizzazione e' sulla coppia. Due cose da non toccare: `'Plant'` DEVE stare fra le colonne
  // (senza, ogni chiave diventerebbe `Product|` e nessuna coppia reale aggancerebbe: il job
  // rispedirebbe l'intero catalogo a ogni esecuzione, con esito 'S'), e le righe storiche a
  // `Plant = ''` non agganciano nulla, il che e' voluto e viene dichiarato in console.
  const hdrRows = await db.run(
    SELECT.from(E_LOG_HDR).columns('Product', 'Plant', 'SentDate', 'Status')
      .where({ Product: { in: products } })
  );
  const { index: hdrMap, legacyIgnored } = matPlantRules.indexByPair(hdrRows);
  if (legacyIgnored > 0) {
    console.log(`>>> [MAT-PLANT-PAIR] ${legacyIgnored} testate storiche senza plant ignorate:`
      + ' non appartengono a nessuna coppia (righe scritte prima della 0031)');
    // [PART-ALIVE] Il numero usciva SOLO in console, dove nessuno lo cerca. E' una `note()` e non
    // una `scope()`: non ha dimensione plant — quelle righe un plant non ce l'hanno, e' il punto.
    if (summary) summary.note([logMsg.seg('logMatLegacyHeaders', legacyIgnored)]);
  }

  // 3-bis) [W1-03] quali COPPIE ASPETTANO l'operazione di ricevimento: classe che la vuole,
  // unita' di misura mappata sul plant della coppia, dizionario vuoto per quella coppia. Tre
  // letture LOCALI per esecuzione, non per coppia. Servono al delta qui sotto — e la condizione
  // sull'unita' di misura e' cio' che impedisce di rispedire per sempre chi non ha nulla da attendere.
  const recvOps = await analyzeReceivingOps(db, pairs, detailMap);
  const recvOpMissing = recvOps.missing;

  // 3-ter) [PLEX-PART-CODES] i plant che mandano ancora la tipologia come STRINGA. Non cambia
  // cosa si invia — l'invio degrada da solo al comportamento storico — ma lo dichiara: senza,
  // un plant non configurato e uno configurato bene chiudono il run allo stesso modo.
  await declareMissingTypeCodes(db, activePlants, categoryConfig, summary);

  // 3-quater) [PLEX-OP-TYPE] le righe di ricevimento la cui operazione non ha un tipo su Plex, o
  // il cui catalogo non e' leggibile. Stessa natura della voce qui sopra, con un'invisibilita' in
  // piu': il passo di ricevimento e' accessorio, quindi un suo fallimento degrada l'invio a 'W'
  // senza fermarlo.
  await declareMissingRecvOpType(db, activePlants, summary);

  // 3-quinquies) [PART-ALIVE] La part esiste ancora su Plex? (feature 0042)
  //
  // Il delta si fidava del solo nostro registro: `ZMatExcLogHDR` dice «inviato» e nessuno chiedeva
  // a Plex. Il tenant di test si azzera ogni settimana — 304 coppie date per inviate, zero part su
  // Plex — e in produzione una part si cancella a mano. Senza questo passo quelle coppie non
  // tornano mai piu' nel delta.
  const tenantByPlant = await readTenantCatalogs(
    [...new Set(pairs.map((p) => matPlantRules.keyPart(p.Plant)))]
  );
  const partMissing = await findMissingParts(db, pairs, tenantByPlant, summary);

  // 4) filtro delta, per coppia
  let toSend = pairs.filter((p) => needsSend(
    detailMap.get(p.Product),
    hdrMap.get(pairKey(p.Product, p.Plant)),
    {
      recvOpMissing: recvOpMissing.has(pairKey(p.Product, p.Plant)),
      partMissing: partMissing.has(pairKey(p.Product, p.Plant)),
      // [RECV-OP-DRIFT] il plant ha cambiato QUALE operazione riceve questa unita' di misura
      recvOpDrifted: recvOps.drifted.has(pairKey(p.Product, p.Plant))
    }
  ));
  const skipped = pairs.length - toSend.length;
  console.log(`>>> [SYNC] Delta: ${toSend.length} coppie da inviare, ${skipped} saltate (già inviate e non modificate)`);
  // Solo contatore: sono decine di migliaia di coppie non modificate, una riga POS ciascuna non
  // aggiungerebbe informazione e gonfierebbe il run log. Resta uno scalare sulla testata: non ha
  // dimensione plant, come negli altri job.
  if (summary && skipped > 0) summary.skip(skipped);

  if (MAX_MATERIALS_PER_RUN > 0 && toSend.length > MAX_MATERIALS_PER_RUN) {
    // [MAT-PLANT-PAIR] Il tetto conta COPPIE, perche' la risorsa razionata e' la chiamata verso
    // Plex e una chiamata e' una coppia. Il nome dell'env NON cambia: rinominarlo lascerebbe in
    // produzione un valore configurato che nessuno legge piu', e un nome nuovo non impostato vale
    // 0 = illimitato — il tetto sparirebbe in silenzio proprio nel run che ne ha piu' bisogno.
    //
    // E la selezione e' ROUND-ROBIN fra i plant, non `slice`. `needsSend` rimette in coda ogni
    // coppia il cui ultimo esito non e' 'S'/'W', quindi un plant con la connessione Plex rotta
    // ripresenta ogni notte le stesse coppie fallite; ordinate per plant starebbero sempre in
    // testa, e i plant successivi non partirebbero MAI — con un recap che dice solo «N coppie
    // rinviate». Selezione e ordine di elaborazione restano due decisioni distinte.
    console.log(`>>> [SYNC] Limite per run: elaboro ${MAX_MATERIALS_PER_RUN} di ${toSend.length} coppie (le restanti al prossimo run)`);
    // Contatore DISTINTO da `skipped`: accorparli farebbe credere al destinatario che
    // l'arretrato sia stato smaltito.
    if (summary) {
      summary.note([logMsg.seg('logMatDeferred', toSend.length - MAX_MATERIALS_PER_RUN)]);
    }
    toSend = matPlantRules.selectFairSlice(toSend, MAX_MATERIALS_PER_RUN);
  }

  // Elaborazione per plant: un plant che cade lascia un blocco contiguo di errori nel recap e nel
  // CSV, invece di righe rosse sparse fra i plant sani. Non e' una questione di cache — le cache di
  // connessione e catalogo sono Map chiavate sul plant, non slot singoli.
  toSend = matPlantRules.orderByPlant(toSend);

  // 5) invio via action CAP esistente (idempotenza + logging già gestiti)
  let sent = 0;
  let warned = 0;
  let failed = 0;
  let recvOpFailedAfterSend = 0;    // [W1-03] coppie la cui operazione di ricevimento non e' utilizzabile
  // [RECV-OP-DRIFT] Gli esiti del riallineamento, per plant: la riga di recap li mette accanto al
  // numero di disallineamenti RILEVATI, che e' l'unico modo di distinguere «zero disallineamenti»
  // da «tanti, e tutti riparati» senza aprire `cf logs` (feature 0044).
  const realignByPlant = new Map();   // plant -> { put, fallback, unresolved }
  const bumpRealign = (plant, field) => {
    const k = matPlantRules.keyPart(plant);
    const row = realignByPlant.get(k) || { put: 0, fallback: 0, unresolved: 0 };
    row[field]++;
    realignByPlant.set(k, row);
  };

  for (const { Product, Plant: plant } of toSend) {
    const detail = detailMap.get(Product) || {};
    // NB: si registra SEMPRE dal loop, mai dentro l'action: dentro sendProductToPlex esiste
    // un request context e un req.error(500) rollerebbe back anche le righe del run log.
    // [LOG-MSG-I18N] Il wrapper prende SEGMENTI (feature 0031).
    // [MAT-LOG-PLANT] Il `LogRef` porta anche il plant: la chiave dello storico e' (materiale,
    // plant, contatore), e un riferimento al solo materiale non punterebbe piu' a una riga sola.
    const rec = (status, segments) => {
      if (!summary) return;
      summary.record({
        plant,
        objectType: 'MATERIAL',
        objectKey: Product,
        objectKey2: detail.ProductDescription || null,
        status,
        segments,
        // [MAT-PLANT-PAIR] Dopo la 0039 il plant e' sempre valorizzato: il ripiego `|| ''` resta
        // solo perche' un `LogRef` a due segmenti non punterebbe a niente, ed e' meglio di un
        // `undefined` nel testo.
        logRef: `ZMatExcLogPOS/${Product}/${plant || ''}`
      });
    };
    try {
      const result = await plex.send('sendProductToPlex', {
        Product,
        ProductDescription: detail.ProductDescription || '',
        Plant: plant
      });
      if (result && result.success) {
        // [W1-03] La part e' uscita: l'operazione di ricevimento puo' solo DEGRADARE la riga a
        // 'W', mai portarla a 'E' (DEC-38). Resta pero' `record()` e non `scope()`: il
        // materiale e' un oggetto trattato, quindi il difetto deve contarsi sull'oggetto e far
        // scattare la notifica ON_ERROR come qualunque altra attenzione (DEC-39).
        //
        // Degrada il solo `ERROR`, cioe' una chiamata partita verso Plex e non riuscita. Un
        // `NO_CONFIG` non e' un difetto del materiale: l'unita' di misura non e' un dato della
        // part su Plex, sta sul componente della distinta (DEGRADING_STATES).
        //
        // `EXISTS_INACTIVE` degrada anch'esso, ma NON e' una creazione fallita: l'operazione su
        // Plex c'e' ed e' disattivata, quindi non si e' nemmeno provato a crearla. Dirlo con le
        // parole sbagliate manderebbe a cercare un errore di chiamata che non esiste, mentre
        // l'azione da fare e' su Plex.
        const recvDegrades = recvOpRules.degradesSend(result.receivingOperation);
        if (recvDegrades) recvOpFailedAfterSend++;
        // [RECV-OP-DRIFT] Gli esiti del riallineamento si contano PER PLANT, e la strada usata
        // ('PUT' o 'CREATE+DEACTIVATE') e' il dato che dice se il tenant accetta il ripuntamento.
        if (result.receivingOperation === recvOpRules.RECV_STATE.REALIGNED) {
          bumpRealign(plant, result.receivingRealignWay === 'PUT' ? 'put' : 'fallback');
        } else if (result.receivingOperation === recvOpRules.RECV_STATE.DRIFT_UNRESOLVED) {
          bumpRealign(plant, 'unresolved');
        }
        // La coda sul ricevimento e' un SEGMENTO a se': `pack` puo' scartarla per ultima senza
        // rendere illeggibile la testa del messaggio.
        // [RECV-OP-DRIFT] Tre rami e non piu' due: «non l'ho potuta creare», «c'e' ma e' spenta» e
        // «il plant l'ha cambiata e non sono riuscito a portarla sulla nuova» mandano a fare cose
        // diverse, e un messaggio unico li renderebbe indistinguibili.
        const recvTail = !recvDegrades ? []
          : [logMsg.seg(
            result.receivingOperation === recvOpRules.RECV_STATE.EXISTS_INACTIVE ? 'logMatRecvOpInactive'
              : (result.receivingOperation === recvOpRules.RECV_STATE.DRIFT_UNRESOLVED
                ? 'logMatRecvOpDriftUnresolved' : 'logMatRecvOpFailed'))];
        // Un riallineamento RIUSCITO non degrada — non e' rimasto niente da fare — ma si dice: e'
        // una scrittura su Plex fatta su un oggetto in esercizio, e deve stare nello storico del
        // suo materiale (DEC-96).
        const realignTail = result.receivingOperation === recvOpRules.RECV_STATE.REALIGNED
          ? [logMsg.seg('logMatRecvOpRealigned', result.receivingRealignWay || '?')] : [];
        // I segmenti dell'action: sono la verita' dell'esito dell'invio della part.
        const sentSegs = logMsg.unpack(result.messageJson);

        // 'CREATE (fallback)' viene loggato come Warning dall'action
        if (result.operation === 'CREATE (fallback)') {
          warned++;
          // Messaggio composto qui: l'action ritorna sempre 'dataSentCorrectly' anche per il
          // fallback, quindi result.message da solo direbbe "tutto ok" su un warning.
          const segs = [logMsg.seg('logMatRecreated'), ...sentSegs, ...recvTail, ...realignTail];
          console.warn(`>>> [WARN] ${Product}: ${renderMsg(segs)}`);
          rec('W', segs);
        } else if (result.operation === 'EXISTING') {
          // La part esisteva già: l'action ripristina il mapping e NON esegue la PUT, quindi
          // i dati SAP non sono stati propagati a Plex. Non è un successo pieno.
          warned++;
          const segs = [logMsg.seg('logMatAlreadyOnPlex', result.plexId), ...recvTail, ...realignTail];
          console.warn(`>>> [WARN] ${Product}: ${renderMsg(segs)}`);
          rec('W', segs);
        } else if (recvDegrades) {
          warned++;
          const segs = [logMsg.seg('logMatSentTo', result.operation, result.plexId), ...recvTail];
          console.warn(`>>> [WARN] ${Product}: ${renderMsg(segs)}`);
          rec('W', segs);
        } else {
          sent++;
          console.log(`>>> [OK] ${Product} (${result.operation}) -> Plex ID ${result.plexId}`);
          rec('S', [logMsg.seg('logMatSentTo', result.operation, result.plexId), ...realignTail]);
        }
      } else {
        failed++;
        // I segmenti dell'action se ci sono; altrimenti si dichiara l'esito senza inventare un testo.
        const segs = logMsg.unpack(result && result.messageJson);
        const out = segs.length ? segs : [logMsg.seg('logMatSendFailedGeneric')];
        console.error(`>>> [ERRORE] ${Product}: ${renderMsg(out)}`);
        rec('E', out);
      }
    } catch (error) {
      failed++;
      console.error(`>>> [ERRORE] ${Product}: ${error.message}`);
      rec('E', [logMsg.technical(error.message)]);
    }
  }

  // [W1-03] Il totale si dichiara UNA volta, in aggiunta alle righe per materiale: le singole
  // dicono quali, questa dice quante. Conta le sole chiamate FALLITE — un'unita' di misura
  // fuori elenco non entra piu' qui, perche' non e' un difetto della part.
  // [RECV-OP-DRIFT] Una riga per PLANT, mai per coppia (feature 0044).
  //
  // I quattro numeri sono il contenuto: quanti disallineamenti il delta ha RILEVATO, e come sono
  // finiti — ripuntati, ricreati col ripiego, o rimasti. «0 rilevati» e «12 rilevati, 12 ripuntati»
  // sono due mattine diverse, e senza questa riga si distinguono solo aprendo `cf logs`.
  //
  // `degrade` SOLO sulle non risolte: un riallineamento riuscito non lascia niente da fare, e
  // tingere di giallo un run che ha riparato toglierebbe significato all'attenzione. Le non risolte
  // sono gia' contate da `record()` sull'oggetto — questa riga non le conta una seconda volta, le
  // ATTRIBUISCE al plant, che e' l'unica dimensione su cui l'allegato della mail e' diviso.
  if (summary) {
    const plantsWithDrift = new Set([...recvOps.driftedByPlant.keys(), ...realignByPlant.keys()]);
    for (const plant of plantsWithDrift) {
      const seen = recvOps.driftedByPlant.get(plant) || 0;
      const r = realignByPlant.get(plant) || { put: 0, fallback: 0, unresolved: 0 };
      const segs = [logMsg.seg('logMatRecvOpDrift', seen, r.put, r.fallback, r.unresolved)];
      console.log(`>>> [RECV-OP-DRIFT] plant ${plant}: ${renderMsg(segs)}`);
      summary.scope({
        plant,
        objectKey: 'ZMatRecvOpConfig',
        status: r.unresolved > 0 ? 'W' : 'S',
        degrade: r.unresolved > 0,
        segments: segs
      });
    }
  }

  if (recvOpFailedAfterSend > 0 && summary) {
    summary.note([logMsg.seg('logMatRecvOpTotal', recvOpFailedAfterSend)]);
  }

  console.log(
    `>>> [JOB SyncMaterials] completato — inviate: ${sent}, warning: ${warned}, fallite: ${failed}`
    + `, saltate: ${skipped} (su ${stats.pairs} coppie, ${stats.materials} materiali, ${stats.plants} plant)`
    + (recvOpFailedAfterSend > 0 ? `, operazione di ricevimento non utilizzabile: ${recvOpFailedAfterSend}` : '')
  );
  return { failed };
}

module.exports = {
  run, enumerateProducts, loadProductDetails, findMissingReceivingOps,
  // [RECV-OP-DRIFT] le due domande sul ricevimento in una passata (feature 0044)
  analyzeReceivingOps,
  // [PART-ALIVE] la lettura remota sta a parte dalla composizione, che ha il suo test (feature 0042)
  readTenantCatalogs, findMissingParts,
  // [MAT-PLANT-PAIR] `needsSend` vive ora in srv/lib/matPlantRules.js, dove ha il suo test. Resta
  // ri-esportata da qui per non rompere chi la importava da questo modulo.
  needsSend,
  declareMissingTypeCodes // [PLEX-PART-CODES]
};

// Bootstrap condiviso (srv/jobs/lib/runJob.js): carica e linka il modello, crea il riepilogo di
// esecuzione, garantisce che venga chiuso e che il recap parta anche in caso di errore fatale,
// e calcola l'exit code (non-zero = fallimenti, per il Job Scheduler).
// Eseguito SOLO quando il file è lanciato direttamente (`node srv/jobs/syncMaterialsToPlex.js`);
// quando importato (require) da un altro modulo NON si auto-esegue.
if (require.main === module) {
  const { runJob } = require('./lib/runJob');
  // serveAll: true perché PlexService non è in cds.requires e va istanziato (senza listen
  // HTTP) prima di poterne invocare l'action sendProductToPlex.
  runJob({ jobCode: 'MAT_SYNC', serveAll: true, main: (summary) => run(summary) });
}

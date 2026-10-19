/**
 * Job BTP — [ORDER-TECO] Chiusura tecnica dell'ordine SAP riportata sul job Plex.
 *
 * >>> Feature 0023, gap W1-13. Perimetro completo: grep -rn "ORDER-TECO" <<<
 *
 * COSA FA E PERCHE'. La BBP §8.2.2 chiede «una interfaccia dedicata SAP -> Plex» che tracci in Plex
 * la chiusura tecnica o anticipata dell'ordine eseguita in SAP; §9.1.2.1 la indica come la via per
 * chiudere l'ordine senza intervento manuale. Prima della 0023 il TECO era letto SOLO come flag di
 * PERIMETRO — serviva a tenere l'ordine FUORI scope — e su Plex non veniva scritto niente: il job
 * restava nella lista di lavoro del centro di lavoro e in fabbrica nessuno sapeva che in SAP
 * l'ordine era chiuso.
 *
 * IL GIRO DI UN RUN
 *   1. plant utilizzabili (attivi + licenziati) e loro customizing TECO (ZProdOrderTecoConfig);
 *   2. candidati: i LOTTI di ZProdOrderPlexMapping non ancora chiusi, cioe' cio' che sta su Plex.
 *      Il perimetro parte da qui e non dagli ordini SAP: un ordine TECO mai andato su Plex non ha
 *      niente da chiudere;
 *   3. lettura SAP delle testate dalla sorgente d'area (PROD_ORDER_SOURCE) e valutazione del
 *      criterio: OR fra i flag configurati (srv/lib/prodOrderTeco.js);
 *   4. per ogni ordine scattato, PER OGNI SUO LOTTO:
 *        DS 4216  Job_No  -> Job_Key      (lettura: e' anche la prova che il job esiste)
 *        GET /scheduling/v1/jobs?jobNumber=…   (precheck, solo diagnostica)
 *        stato 'P' su ZProdOrderTecoState      (PRENOTAZIONE: si scrive prima di chiamare)
 *        DS 23101 Update Job Status(Job_Key, Job_Status='TECO')         SCRITTURA
 *        GET /scheduling/v1/jobs?jobNumber=…   (lo stato E' cambiato? rete contro il no-op)
 *   5. stato per lotto su ZProdOrderTecoState, recap per plant.
 *
 * TRE COSE CHE «NON LO SO» NON DEVE DIVENTARE, e sono le tre in cui il job sbagliava.
 *   - Una risposta della 4216 di FORMA IGNOTA non e' «Plex non ha quel job»: quello e' lo stato 'K',
 *     TERMINALE, e un envelope cambiato avrebbe archiviato ogni lotto in silenzio (`teco.readDsRows`).
 *   - Una rilettura dello stato NON RIUSCITA non e' «job non trovato»: la rete contro il no-op non
 *     gira, e lo si DICHIARA invece di chiudere in verde (`readJobStatus` -> `{read, status}`).
 *   - Un PLANT vuoto o '#NA' sul dizionario dei lotti non e' «fuori perimetro»: il lotto resta
 *     candidato, e il plant si impara dalla testata appena letta (`learnLotPlants`).
 *
 * UN ORDINE SPACCHETTATO HA N JOB DA CHIUDERE. Il lotto principale esiste ancora su Plex con la
 * quantita' residua e ogni pacchetto `<ordine>-000N` e' un job vero: si chiudono TUTTI, e chi dice
 * se un job esiste e' PLEX (la 4216), non il nostro `SplitState`. Il ciclo non si ferma al primo
 * pacchetto che fallisce, e un ordine chiuso a meta' viene dichiarato tale.
 *
 * NESSUN WATERMARK, e non e' una dimenticanza rispetto a DEC-58: qui il punto di ripresa non e' una
 * finestra temporale ma lo STATO PER LOTTO persistito, che rende il run idempotente per
 * costruzione. Un lotto in 'A' non si tocca piu'; uno in 'E' torna al run successivo.
 *
 * IL RILEVAMENTO GIRA SEMPRE, LA SCRITTURA NO (DEC-71). `IsEnabled` del plant e' l'unica condizione
 * che fa partire la chiamata verso Plex: a interruttore spento il TECO viene registrato in stato
 * 'D' e dichiarato nel recap, e l'arretrato si applica da se' quando l'interruttore si accende.
 *
 * Eseguito dal SAP BTP Job Scheduler tramite:
 *     node srv/jobs/closeTecoPlexJobs.js        (oppure `npm run job-prod-order-teco`)
 *
 * LEVE — un valore non numerico ricade sul DEFAULT e non toglie il tetto (`intEnv`).
 *   PLEX_DS_JOB_STATUS_UPDATE  id della Data Source di chiusura (23101). 0 = non scrivere nulla
 *   PLEX_TECO_MAX_PER_RUN      tetto di LOTTI per esecuzione (0 = illimitato)
 *   PLEX_TECO_MAX_ATTEMPTS     tentativi di scrittura prima dello stato 'X' (3)
 *   PLEX_TECO_MAX_KEY_READS    tetto delle letture SAP per chiave (200; 0 = illimitato)
 *   PLEX_TECO_READ_MODE        LIST (default) | KEY: come si leggono le testate da SAP
 *   PLEX_TECO_PRECHECK         off = non legge lo stato del job su Plex, ne' prima ne' dopo la
 *                              scrittura (con `on` la rilettura e' la rete contro il no-op)
 */

'use strict';

const cds = require('@sap/cds');
const { resolveActivePlants, plexGet, executeDataSource } = require('./lib/plexJobsClient');
// [PLEX-CONN] Connessione a Plex PER PLANT (feature 0020): punto unico di risoluzione.
const { resolvePlexConnection, PlexConnectionMissing } = require('../lib/plexConnection');
// [IS-SOURCE] Sorgente dell'area ordini (feature 0013): il punto unico in cui si sceglie il canale.
const prodOrderSource = require('../lib/prodOrderSource');
// [ORDER-TECO] Le regole pure: criterio, lotti, payload, stato, recap.
const teco = require('../lib/prodOrderTeco');
const { DS_GET_JOB_KEY, DS_JOB_STATUS_UPDATE } = require('../lib/plexDataSources');
// [LOG-MSG-I18N] I messaggi sono segmenti; il testo si rende qui, dove si scrive (feature 0031).
const logMsg = require('../lib/logMessage');
const i18nMessages = require('../lib/i18nMessages');
// Il plant delle righe la cui attribuzione non e' stata possibile: lo stesso valore che il gate di
// licenza sui log lascia passare per costruzione. Non si ricopia il letterale.
const { PLANT_NA: PLANT_UNKNOWN } = require('../lib/jobCodes');

const JOB_CODE = 'PROD_TECO';

const NS = 'avvaleplm.marsplm.sap2plex';
// FQN come stringa: in contesto job standalone `db.entities` non e' invocabile come funzione.
const E_MAPPING = `${NS}.ZProdOrderPlexMapping`;
const E_STATE = teco.E_TECO_STATE;
// [ORDER-LOG-OP] La traccia di un tentativo va nello STORICO INVII DELL'ORDINE (feature 0031), non
// in una tabella sua: la chiusura tecnica e' un'operazione su quell'ordine, e il registro di un
// ordine e' uno solo. Il writer e' condiviso con l'invio job e la consuntivazione.
const excLog = require('../lib/prodOrderExcLog');

/** Il testo di una lista di segmenti, nella lingua dello snapshot. Per i log del task e le colonne. */
const renderMsg = (segments) => i18nMessages.render(
  logMsg.normalize(segments), i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE
);

const { STATE, OUTCOME, cut } = teco;

/**
 * Un intero da una variabile d'ambiente, col DEFAULT come ripiego di un valore non numerico.
 *
 * NON e' pedanteria. `parseInt('abc')` da' `NaN`, e `NaN > 0` e' falso: sui tetti di questo file la
 * condizione «> 0 ? tetto : illimitato» faceva sì che un REFUSO nella variabile non ricadesse sul
 * default ma togliesse il tetto — e su `PLEX_TECO_MAX_KEY_READS` toglieva insieme al tetto anche la
 * dichiarazione di cio' che restava fuori (`missing.slice(budget)` diventa vuoto). Un limite che
 * sparisce per una lettera sbagliata e' peggio di un limite assente, perche' nessuno lo cerca.
 * `0` resta «illimitato», ma dev'essere uno zero SCRITTO.
 */
function intEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`>>> [ORDER-TECO] ${name}='${raw}' non e' un intero: si usa il default ${def}`);
    return def;
  }
  return n;
}

/** Tetto di LOTTI per esecuzione (0 = illimitato). L'unita' e' il lotto: e' cio' che si scrive. */
const MAX_LOTS_PER_RUN = intEnv('PLEX_TECO_MAX_PER_RUN', 0);
/** Tentativi di scrittura per lotto prima dello stato 'X'. */
const MAX_ATTEMPTS = intEnv('PLEX_TECO_MAX_ATTEMPTS', 3);
/** Tetto delle letture SAP per chiave (ripiego dei candidati non restituiti dalla lista). */
const MAX_KEY_READS = intEnv('PLEX_TECO_MAX_KEY_READS', 200);
/**
 * Come si leggono le testate da SAP.
 *   LIST (default) una collection sui plant configurati, con selezione a valle: e' la forma che il
 *                  job ordini usa da sempre su questo indirizzo, quindi la sappiamo funzionante;
 *   KEY            una lettura per candidato. Esiste perche' se la lista dell'iFlow si rivelasse
 *                  troppo pesante su un tenant, la manopola c'e' senza bisogno di un rilascio.
 */
const READ_MODE = String(process.env.PLEX_TECO_READ_MODE || 'LIST').trim().toUpperCase() === 'KEY'
  ? 'KEY' : 'LIST';
/**
 * Lettura dello stato del job su Plex, PRIMA e DOPO la scrittura.
 *   prima: traccia lo stato di partenza, non decide nulla;
 *   dopo:  e' la RETE contro il no-op silenzioso. L'esito lo decide l'HTTP (`interpretTecoResponse`
 *          dice perche'), quindi un 200 che non ha fatto niente e' indistinguibile da un 200 che
 *          ha chiuso il job — ed e' il modo in cui si manifesterebbe un `Job_Status` che la Data
 *          Source non riconosce.
 * Spegnerla NON cambia cio' che si scrive, solo cio' che si sa di aver scritto.
 */
const PRECHECK = !['off', 'false', '0'].includes(
  String(process.env.PLEX_TECO_PRECHECK ?? 'true').trim().toLowerCase()
);

// ================================================================
// Utility
// ================================================================

// L'estrazione delle righe di una Data Source sta in `teco.readDsRows`, che restituisce ANCHE il
// verdetto sulla forma: qui una forma non riconosciuta non e' un'assenza, e l'assenza e' terminale.

/** Normalizza il body di una risposta Connect REST in array. */
function asArray(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  return body.value || body.results || body.data || [];
}

const nowIso = () => new Date().toISOString();

// ================================================================
// Candidati: cosa sta su Plex e non e' ancora stato chiuso
// ================================================================

/**
 * I lotti da verificare, raggruppati per ordine.
 *
 * Legge il dizionario dei lotti e lo stato TECO e li incrocia in memoria con `candidateLots`, che
 * e' il punto in cui si decide che NESSUNO `SplitState` e NESSUNO `Status` esclude un lotto — e in
 * cui il PLANT, che e' l'altro asse, pota solo cio' che sa di poter potare.
 *
 * @param {object} db
 * @param {Iterable<string>} [plants] i plant in perimetro; assente o vuoto = nessuna potatura
 * @returns {Promise<{lots: Array<object>, byOrder: Map<string, Array<object>>}>}
 */
async function loadCandidates(db, plants) {
  const mapping = await db.run(
    SELECT.from(E_MAPPING).columns(
      'ManufacturingOrder', 'PlexJobNumber', 'PlexJobId', 'Plant', 'CreatedAt',
      'SplitState', 'SplitSequence', 'Status'
    )
  );
  const state = await db.run(
    SELECT.from(E_STATE).columns(
      'ManufacturingOrder', 'PlexJobNumber', 'State', 'Attempts', 'PlexJobId', 'Plant'
    )
  );

  const lots = teco.candidateLots(mapping, state, { plants });
  const byOrder = new Map();
  for (const lot of lots) {
    if (!byOrder.has(lot.ManufacturingOrder)) byOrder.set(lot.ManufacturingOrder, []);
    byOrder.get(lot.ManufacturingOrder).push(lot);
  }
  const pruned = mapping.length - lots.length;
  console.log(`>>> [ORDER-TECO] lotti su Plex da verificare: ${lots.length} su ${byOrder.size} ordini`
    + ` (righe di mapping ${mapping.length}, stati TECO ${state.length}${pruned > 0
      ? `, esclusi ${pruned} fra terminali e plant fuori perimetro` : ''})`);
  return { lots, byOrder };
}

/** Il plant di un lotto e' ignoto? Vuoto e `'#NA'` sono la stessa cosa: «non lo so». */
const plantUnknown = (v) => {
  const p = String(v || '').trim();
  return !p || p === PLANT_UNKNOWN;
};

/**
 * Scrive sul dizionario dei lotti il plant che la testata SAP ha appena dichiarato.
 *
 * PERCHE' IL JOB SCRIVE SU UN DIZIONARIO CHE NON E' SUO. Perche' e' l'unico che ha in mano la
 * risposta: la testata e' appena stata letta, e il plant e' un fatto di SAP, non una nostra
 * deduzione. Senza questo passo l'arretrato — le righe scritte prima che la colonna esistesse —
 * resterebbe `'#NA'` per sempre, e il pre-filtro per plant non toglierebbe dalla coda una sola riga:
 * la potatura funzionerebbe solo sugli ordini futuri, cioe' proprio quelli che non pesano.
 *
 * SOLO DOVE IL PLANT E' IGNOTO. Una riga che ce l'ha gia' non si tocca: la sua verita' e' quella di
 * chi l'ha scritta, e sovrascriverla farebbe di questo job l'autorita' su un dato che non governa.
 *
 * NON LANCIA, e al primo errore SI FERMA. E' una riparazione opportunistica e non deve impedire la
 * chiusura dei job; e se la prima UPDATE non passa non passera' nessuna — tipicamente perche' la
 * colonna non e' ancora deployata — quindi si dichiara una volta invece di N volte.
 *
 * @returns {Promise<number>} righe aggiornate
 */
async function learnLotPlants(db, lots, headersByOrder) {
  let written = 0;
  for (const lot of lots) {
    if (!plantUnknown(lot.Plant)) continue;
    const header = headersByOrder.get(lot.ManufacturingOrder);
    const plant = String((header && header.ProductionPlant) || '').trim();
    if (!plant) continue;
    try {
      await db.run(UPDATE(E_MAPPING).set({ Plant: cut(plant, 4) }).where({
        ManufacturingOrder: lot.ManufacturingOrder, PlexJobNumber: lot.PlexJobNumber
      }));
      lot.Plant = plant;
      written += 1;
    } catch (e) {
      console.error(`>>> [ORDER-TECO] plant non persistito sul dizionario dei lotti`
        + ` (si procede comunque, la coda non si accorcia): ${e.message}`);
      return written;
    }
  }
  if (written) {
    console.log(`>>> [ORDER-TECO] plant appreso e persistito su ${written} lotti del dizionario`);
  }
  return written;
}

// ================================================================
// Lettura delle testate da SAP
// ================================================================

/**
 * Le testate degli ordini candidati, dal canale attivo.
 *
 * In modalita' LIST si legge una collection sui plant configurati, la stessa forma del job ordini.
 *
 * QUANDO IL RIPIEGO PER CHIAVE SERVE, E QUANDO NO. Dipende da una cosa sola: se il criterio e'
 * stato SPINTO nella query, la lista contiene gia' i soli ordini chiusi, e un candidato che non
 * compare semplicemente NON E' CHIUSO — non c'e' niente da ripescare e niente da dichiarare. Se
 * invece il criterio si valuta a valle (modalita' IS, o piu' flag in OR), la lista dovrebbe
 * contenere TUTTI gli ordini del plant: un candidato che non compare e' un'informazione che manca,
 * e va distinto fra «ordine di un plant non configurato» e «ordine che la sorgente non restituisce»
 * — cose che una lista muta confonde. Solo in quel caso si legge per chiave, con un tetto, e cio'
 * che resta fuori si DICHIARA.
 *
 * Senza questa distinzione un plant ONPREM avrebbe pagato fino a `PLEX_TECO_MAX_KEY_READS` letture
 * inutili a ogni esecuzione, e ogni run avrebbe chiuso in attenzione con un avviso «ordini non
 * trovati in SAP» che nomina ordini perfettamente normali: una mail ricorrente per sempre.
 *
 * @returns {Promise<{byOrder: Map<string,object>, notFound: string[], notVerified: string[],
 *                    keyReads: number, notTriggered: number, decisive: boolean}>}
 */
async function readOrderHeaders(s4, scope, wantedOrders, summary) {
  const { A_ProductionOrder_2 } = s4.entities;
  const columns = [
    'ManufacturingOrder', 'ProductionPlant', 'Material',
    ...teco.selectColumns(scope.byPlant)
  ];
  const byOrder = new Map();
  // La lista da sola risponde alla domanda «quest'ordine e' chiuso in SAP?».
  let decisive = false;

  if (READ_MODE === 'LIST') {
    const where = { ProductionPlant: { in: scope.configured } };
    // [ORDER-TECO] Spingibile solo in ONPREM e solo con un unico flag condiviso: un OR fra due
    // flag non si esprime con un `where` di uguaglianze, e in IS quei campi non hanno
    // select-option dietro l'iFlow (contratto E-13, richiesta R-2b).
    const pushed = teco.pushableTrigger(scope.byPlant, s4.mode);
    if (pushed) Object.assign(where, pushed);
    decisive = !!pushed;

    // [ORDER-TOP] Questa lettura era senza `.limit()`, cioe' senza `$top`. Il tetto e' quello
    // dell'area (srv/lib/prodOrderSource.js), lo stesso che usa la lista del cockpit, e ci sta
    // perche' una collection senza tetto verso questi iFlow e' un rischio comunque: se la lista
    // non consegna nulla ogni candidato finisce fra i `missing` e viene ricoperto UNO PER UNO sul
    // root per chiave — fino al tetto di `MAX_KEY_READS`, oltre il quale resta `notVerified`. Cioe'
    // funziona per accidente, a N chiamate invece di una, e il run chiude in verde.
    //
    // Il «da quando `IV_TOP` esiste lato ABAP (01/09/2026) quella forma riceve `200` con ZERO
    // righe» che stava scritto qui e' un'IPOTESI NON CONFERMATA: era la causa attribuita allo zero
    // di `PROD_ORDER`, smentita dal run col tetto a bordo (02/09). Vedi la testata di
    // srv/lib/prodOrderSource.js.
    // [ORDER-ROWS] L'ORDINE DELLE CHIAMATE E' PARTE DEL CONTRATTO, anche qui.
    // `.columns().limit().where()` — non `.where().limit()` — perche' `cqn2odata` itera le chiavi
    // dell'oggetto `SELECT` con un `for…in` e i builder di `cds.ql` le assegnano nell'ordine in cui
    // li chiami: le due forme danno `$select&$top&$filter` e `$select&$filter&$top`, cioe' due URL
    // diversi carattere per carattere a semantica identica. Questa e' la TERZA lettura di collection
    // sullo stesso service root degli altri due chiamanti (cockpit e job PROD_ORDER, entrambi via
    // srv/lib/orderRows.js) e sullo STESSO canale batch: allinearla alla forma del cockpit — l'unica
    // con un esito buono OSSERVATO — costa lo spostamento di una chiamata, e toglie una differenza
    // che nessuno avrebbe confrontato il giorno in cui anche questo job leggesse zero.
    //
    // Le COLONNE invece NON si allineano, ed e' deliberato: qui si legge altro (tre campi piu' i
    // criteri di chiusura) per un altro scopo. Ereditare `LIST_COLUMNS` porterebbe dentro
    // `OrderLongText`, che e' testo lungo via `READ_TEXT` — il campo caro — sul perimetro intero.
    const cap = prodOrderSource.listMaxRows();
    // [RUN-BLOCKED] Anche questa lettura non era in try/catch e uccideva il run diventando
    // `fatal()`: rosso, ma senza una riga che nominasse la lettura, il canale e il tetto. Catturata
    // e dichiarata, l'esito non cambia (era exit 1, resta exit 1, DEC-124) e i candidati passano dal
    // ripiego per chiave, che e' esattamente cio' che quel ripiego esiste per fare.
    let rows;
    try {
      rows = await s4.run(
        SELECT.from(A_ProductionOrder_2).columns(...columns).limit(cap).where(where)
      );
    } catch (error) {
      const segments = [
        logMsg.seg('logTecoHeadersReadFailed', s4.destination || '-', cap),
        logMsg.technical(error.message)
      ];
      console.error(`>>> [ORDER-TECO] ${renderMsg(segments)}`);
      if (summary) {
        summary.scope({
          objectType: 'PROD_ORDER_TECO', objectKey: 'PROD_ORDER_TECO_HEADERS',
          status: 'E', segments
        });
      }
      rows = [];
    }
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    for (const r of list) {
      const key = String(r.ManufacturingOrder || '').trim();
      if (key && wantedOrders.has(key)) byOrder.set(key, r);
    }
    console.log(`>>> [ORDER-TECO] testate lette in lista: ${list.length}, di cui candidate ${byOrder.size}`
      + `${pushed ? ` (criterio spinto: ${JSON.stringify(pushed)})` : ''}`);

    // [ORDER-TOP] Un perimetro tagliato dal tetto si dichiara: qui la conseguenza e' che i
    // candidati non trovati nella lista passano dal ripiego per chiave, e oltre il suo budget
    // restano NON VERIFICATI. Senza questa voce quella coda si legge come «l'iFlow e' lento»
    // invece che «la lista era troncata». `objectKey` propria, o finirebbe sotto quella del
    // ripiego (lezione di DEC-115).
    if (list.length >= cap) {
      const segments = [logMsg.seg('logOrderScopeTruncated', list.length)];
      console.error(`>>> [ORDER-TOP] ${renderMsg(segments)}`);
      if (summary) {
        summary.scope({
          objectType: 'PROD_ORDER_TECO', objectKey: 'PROD_ORDER_TECO_TRUNCATED',
          status: 'W', degrade: true, segments
        });
      }
    }
  }

  const missing = [...wantedOrders].filter((o) => !byOrder.has(o)).sort();

  // La lista portava gia' il criterio: chi non c'e' non e' chiuso, e non si legge per chiave.
  if (decisive) {
    console.log(`>>> [ORDER-TECO] ${missing.length} candidati non risultano chiusi in SAP:`
      + ' il criterio era spinto nella query, quindi nessuna lettura per chiave');
    return {
      byOrder, notFound: [], notVerified: [], keyReads: 0, notTriggered: missing.length, decisive
    };
  }

  // Ripiego per chiave: in modalita' KEY e' l'unica lettura, in LIST copre solo i mancanti.
  const notFound = [];
  const budget = MAX_KEY_READS > 0 ? MAX_KEY_READS : missing.length;
  const toRead = missing.slice(0, budget);
  const notVerified = missing.slice(budget);
  // [RUN-BLOCKED] Le letture CADUTE stanno a parte da quelle mai tentate, benche' l'esito
  // sull'ordine sia lo stesso («non verificato»): i due rimedi sono opposti — alzare il budget
  // oppure guardare il canale — e con un contatore solo il messaggio nominava sempre il primo. E'
  // anche la distinzione che decide l'esito del run: una chiamata caduta lo fa chiudere in errore
  // (DEC-124), un budget consumato no.
  const readFailed = [];

  for (const orderNo of toRead) {
    try {
      const row = await s4.run(
        SELECT.one.from(A_ProductionOrder_2).columns(...columns).where({ ManufacturingOrder: orderNo })
      );
      if (row && row.ManufacturingOrder) byOrder.set(orderNo, row);
      else notFound.push(orderNo);
    } catch (e) {
      // Una lettura fallita non e' «ordine assente»: e' un ordine NON VERIFICATO, e va detto.
      console.error(`>>> [ORDER-TECO] lettura per chiave dell'ordine ${orderNo} fallita: ${e.message}`);
      readFailed.push({ order: orderNo, reason: e.message });
      notVerified.push(orderNo);
    }
  }
  if (toRead.length) {
    console.log(`>>> [ORDER-TECO] letture per chiave: ${toRead.length}`
      + `${notFound.length ? `, ordini non trovati in SAP: ${notFound.length}` : ''}`);
  }
  if (notVerified.length) {
    const segments = [logMsg.seg('logTecoNotVerified', notVerified.length, MAX_KEY_READS)];
    console.warn(`>>> [ORDER-TECO] ${renderMsg(segments)}`);
    if (summary) summary.scope({ objectType: 'PROD_ORDER_TECO', status: 'W', segments });
  }
  // [RUN-BLOCKED] `objectKey` PROPRIA, o le due voci finirebbero sovrapposte nel recap sotto la
  // stessa chiave e la seconda si leggerebbe come un doppione della prima (lezione di DEC-115).
  if (readFailed.length && summary) {
    const segments = [
      logMsg.seg('logTecoKeyReadFailed', readFailed.length),
      logMsg.technical(readFailed[0].reason)
    ];
    summary.scope({
      objectType: 'PROD_ORDER_TECO', objectKey: 'PROD_ORDER_TECO_KEYREAD',
      status: 'E', segments
    });
  }
  return { byOrder, notFound, notVerified, keyReads: toRead.length, notTriggered: 0, decisive };
}

// ================================================================
// Persistenza dello stato
// ================================================================

/**
 * Upsert della riga di stato del lotto. `DetectedAt` si scrive solo alla PRIMA rilevazione: e' il
 * momento in cui SAP ha detto che l'ordine era chiuso, e non va riscritto a ogni tentativo.
 */
async function saveState(db, row) {
  const key = { ManufacturingOrder: row.order, PlexJobNumber: row.lot };
  const now = nowIso();
  const segments = logMsg.normalize(row.segments);
  const fields = {
    Plant: cut(row.plant, 4),
    TriggerStatus: cut(row.flag, 40),
    State: row.state,
    Attempts: row.attempts,
    PlexJobId: cut(row.jobId, 36),
    PlexJobKey: Number.isInteger(row.jobKey) ? row.jobKey : null,
    PlexStatusBefore: cut(row.statusBefore, 40),
    DsHttpStatus: Number.isFinite(row.httpStatus) ? row.httpStatus : null,
    LastMessage: cut(renderMsg(segments), 255),
    LastMessageJson: logMsg.pack(segments),
    UpdatedAt: now
  };
  if (row.state === STATE.APPLIED) fields.AppliedAt = now;

  const existing = await db.run(SELECT.one.from(E_STATE).where(key));
  if (existing) {
    await db.run(UPDATE(E_STATE).set(fields).where(key));
  } else {
    await db.run(INSERT.into(E_STATE).entries({ ...key, DetectedAt: now, CreatedAt: now, ...fields }));
  }
}

/**
 * [ORDER-TECO] La riga di storico del TENTATIVO: cosa e' stato mandato a Plex e cosa ha risposto.
 *
 * Va nello «Storico Invii» dell'ordine, con `Operation = 'TECO'`: la chiusura tecnica e' una cosa
 * che si fa a QUELL'ordine, e chi la cerca la cerca dove cerca tutto il resto di quell'ordine.
 * Prima della 0031 di queste chiamate non restava niente su database — solo un intero e 255
 * caratteri — e i corpi veri stavano in `cf logs`, che scade: un difetto da girare a Rockwell
 * diventava un ricordo.
 *
 * UN ORDINE SPACCHETTATO PRODUCE N RIGHE, una per lotto: sono N chiamate distinte. Quale lotto era
 * lo dice il messaggio, con un segmento di testa che lo nomina SOLO quando e' diverso dall'ordine —
 * per il lotto principale i due numeri coincidono, e ripeterlo su ogni riga sarebbe rumore.
 *
 * NON LANCIA: lo garantisce il writer condiviso. Un log che non si scrive non deve far ritentare una
 * chiusura che su Plex e' gia' avvenuta.
 *
 * @returns {Promise<number|null>} il Counter della riga, per il `LogRef` del recap
 */
async function writeTecoLog(db, { order, lot, status, segments, steps }) {
  const lotSegments = lot && lot !== order
    ? [logMsg.seg('logTecoLotHead', lot), ...logMsg.normalize(segments)]
    : logMsg.normalize(segments);
  return excLog.appendProdOrderLog(db, {
    order,
    operation: excLog.OPERATION.TECO,
    status,
    segments: lotSegments,
    steps
    // `updateHeader` assente di proposito: la testata dell'ordine resta «l'ultimo invio del job».
  });
}

/**
 * Raccoglitore dei passi di un tentativo, nella stessa forma del job ordini:
 * `[{step, request, status, response, aux?}]`, serializzato in due proiezioni.
 *
 * `aux: true` su un passo accessorio — qui le due letture di stato del job — perche' resti nella
 * traccia ma fuori dal semaforo HTTP.
 */
function newTrace() {
  const steps = [];
  return {
    steps,
    /** Un passo compiuto: cosa si e' chiesto, cosa e' tornato. */
    add(step, request, res, aux = false) {
      const r = res || {};
      steps.push({
        step,
        request: request === undefined ? null : request,
        status: Number.isFinite(r.status) ? r.status : (r.status || null),
        response: r.body === undefined ? (r.error || null) : r.body,
        ...(aux ? { aux: true } : {})
      });
    },
    /** Un passo che non e' partito, o che e' morto prima di una risposta. */
    fail(step, request, error, aux = false) {
      steps.push({
        step,
        request: request === undefined ? null : request,
        status: null,
        response: { error: (error && error.message) || String(error) },
        ...(aux ? { aux: true } : {})
      });
    }
  };
}

// ================================================================
// Trattamento di un lotto
// ================================================================

/**
 * Chiude un lotto su Plex, o dichiara perche' non lo si e' fatto.
 *
 * NON LANCIA: ogni esito e' un valore di ritorno. Un pacchetto che non si chiude non deve impedire
 * la chiusura degli altri lotti dello stesso ordine.
 *
 * OGNI PASSO ENTRA NELLA TRACCIA, riuscito o no (feature 0031): `steps` viene persistito in
 * nello storico invii dell'ordine e mostrato dal cockpit. Un passo che NON e' partito lascia la sua
 * riga, perche' «non ho potuto chiedere» e «ho chiesto e mi ha detto no» sono due cose diverse — la
 * stessa distinzione della lettura di controllo del ricevimento materiali (DEC-63).
 *
 * @returns {Promise<{State: string, Attempts: number, segments: Array, steps: Array,
 *                    jobKey: number|null, statusBefore: string|null, httpStatus: number|null}>}
 *          `State`/`Attempts`/`segments` sono il valore di ritorno di `nextState`.
 */
async function processLot({ creds, connError, enabled, lot, claim }) {
  const tr = newTrace();
  const done = (o, extra = {}) => ({
    ...o, steps: tr.steps, jobKey: null, statusBefore: null, httpStatus: null, ...extra
  });

  // --- Una prenotazione ORFANA si guarda prima di tutto, interruttore compreso. ---
  // Il lotto e' in 'P': un run precedente ha scritto «sto per chiamare» e non e' arrivato a
  // scrivere l'esito. La chiamata PUO' essere partita, e non c'e' modo di saperlo — l'esito lo
  // decide l'HTTP, che non abbiamo, e i nomi degli stati del job sono configurazione del tenant
  // (DEC-65). Non si ritenta: un esito non conclusivo e' piu' pericoloso di un rifiuto (DEC-60).
  // Si dichiara.
  if (lot.prevState === STATE.CLAIMED) {
    return done(teco.nextState(lot, {
      kind: OUTCOME.STRANDED,
      segments: [logMsg.seg('logTecoClaimStranded', lot.PlexJobNumber)]
    }, MAX_ATTEMPTS));
  }

  // --- L'interruttore si guarda PRIMA di qualunque chiamata a Plex. ---
  // Anche la lettura del Job_Key fa parte del percorso di SCRITTURA: con la chiusura non
  // abilitata non c'e' niente da preparare, e chiamare Plex significherebbe far FALLIRE i lotti
  // di un plant che ha deliberatamente la leva spenta e nessuna connessione configurata.
  if (!enabled) {
    return done(teco.nextState(lot, {
      kind: OUTCOME.PENDING,
      segments: [logMsg.seg(DS_JOB_STATUS_UPDATE > 0 ? 'logTecoNotEnabled' : 'logTecoDsDisabled')]
    }, MAX_ATTEMPTS));
  }

  // Plant senza connessione Plex configurata: e' un fallimento del lotto, non del run (0020).
  if (connError) {
    return done(teco.nextState(lot, {
      kind: OUTCOME.FAILED,
      segments: [logMsg.seg('logTecoNoConnection'), logMsg.technical(connError.message)]
    }, MAX_ATTEMPTS));
  }

  // --- Passo 1: Job_No -> Job_Key (DS 4216). E' anche la prova che il job esiste su Plex. ---
  const keyInputs = { Job_No: lot.PlexJobNumber };
  let keyRes;
  try {
    keyRes = await executeDataSource(creds, DS_GET_JOB_KEY, keyInputs);
    tr.add(`DS ${DS_GET_JOB_KEY} Job_Key`, keyInputs, keyRes);
  } catch (e) {
    tr.fail(`DS ${DS_GET_JOB_KEY} Job_Key`, keyInputs, e);
    return done(teco.nextState(lot, {
      kind: OUTCOME.FAILED,
      segments: [logMsg.seg('logTecoJobKeyReadFailed'), logMsg.technical(e.message)]
    }, MAX_ATTEMPTS));
  }
  if (!keyRes.ok) {
    return done(teco.nextState(lot, {
      kind: OUTCOME.FAILED, segments: [logMsg.seg('logTecoJobKeyReadHttp', keyRes.status)]
    }, MAX_ATTEMPTS), { httpStatus: keyRes.status });
  }

  // Una forma di risposta che non riconosciamo NON e' un'assenza, e la differenza e' tutto: `'K'`
  // e' TERMINALE, quindi un envelope cambiato archivierebbe in silenzio ogni lotto come «niente da
  // chiudere», lasciando i job aperti in lista di lavoro (DEC-112, DEC-80).
  const shape = teco.readDsRows(keyRes.body);
  if (!shape.recognized) {
    return done(teco.nextState(lot, {
      kind: OUTCOME.FAILED,
      segments: [logMsg.seg('logTecoJobKeyShapeUnknown', lot.PlexJobNumber)]
    }, MAX_ATTEMPTS), { httpStatus: keyRes.status });
  }

  const pick = teco.pickJobKey(shape.rows, lot.PlexJobNumber);
  if (pick.reason === 'unknownShape') {
    // Righe presenti, ma nessuna e' un oggetto: di nuovo una forma, non un'assenza.
    return done(teco.nextState(lot, {
      kind: OUTCOME.FAILED,
      segments: [logMsg.seg('logTecoJobKeyShapeUnknown', lot.PlexJobNumber)]
    }, MAX_ATTEMPTS), { httpStatus: keyRes.status });
  }
  if (pick.reason === 'absent') {
    return done(teco.nextState(lot, {
      kind: OUTCOME.ABSENT, segments: [logMsg.seg('logTecoJobUnknown', lot.PlexJobNumber)]
    }, MAX_ATTEMPTS), { httpStatus: keyRes.status });
  }
  if (!pick.jobKey) {
    // Ambiguo o non intero: NON si scrive. Chiudere il job di un altro lotto e' peggio che non
    // chiudere questo, e la 4216 potrebbe filtrare per prefisso (il codice dei pacchetti inizia
    // col numero d'ordine).
    return done(teco.nextState(lot, {
      kind: OUTCOME.REFUSED,
      segments: [logMsg.seg(
        pick.reason === 'ambiguous' ? 'logTecoJobKeyAmbiguous' : 'logTecoJobKeyNotInteger',
        lot.PlexJobNumber
      )]
    }, MAX_ATTEMPTS), { httpStatus: keyRes.status });
  }

  // --- Passo 2 (opzionale): stato del job su Plex PRIMA della scrittura. ---
  const pre = PRECHECK
    ? await readJobStatus(creds, lot, tr, 'precheck')
    : { read: false, status: null };
  const statusBefore = pre.status;

  // --- Passo 2bis: LA PRENOTAZIONE. Si scrive «sto per chiamare» PRIMA di chiamare. ---
  //
  // Senza, la chiusura partiva e solo DOPO si scriveva lo stato: una morte del processo in mezzo — su
  // Cloud Foundry lo shutdown ha 8 secondi — lasciava il lotto fra i candidati, e il run successivo
  // rimandava la STESSA chiusura. DEC-70 chiama lo stato per lotto «il presidio contro il doppio
  // invio», ma il presidio si armava dopo la chiamata: e' lo scarto che DEC-89 ha gia' chiuso per i
  // movimenti materiale, ed e' lo stesso meccanismo — fuori da un request context ogni `db.run` e'
  // una root-transaction che CAP committa da se'.
  //
  // Se la prenotazione NON riesce non si scrive su Plex: e' l'unico modo di tenere la promessa.
  // Il lotto resta ritentabile, perche' qui non e' partito niente.
  if (claim) {
    try {
      await claim({ jobKey: pick.jobKey, statusBefore });
    } catch (e) {
      tr.fail(`prenotazione DS ${DS_JOB_STATUS_UPDATE}`, { Job_Key: pick.jobKey }, e);
      return done(teco.nextState(lot, {
        kind: OUTCOME.FAILED,
        segments: [logMsg.seg('logTecoClaimFailed'), logMsg.technical(e.message)]
      }, MAX_ATTEMPTS), { jobKey: pick.jobKey, statusBefore });
    }
  }

  // --- Passo 3: Update Job Status (DS 23101). SCRITTURA. ---
  // L'etichetta dice cosa fa la chiamata e non il nome di una stored procedure: della 23101 non
  // abbiamo la schermata, e un nome inventato e' un nome che qualcuno cerchera' sul tenant.
  const closeInputs = teco.buildTecoInputs(pick.jobKey);
  let res;
  try {
    res = await executeDataSource(creds, DS_JOB_STATUS_UPDATE, closeInputs);
    tr.add(`DS ${DS_JOB_STATUS_UPDATE} Update Job Status`, closeInputs, res);
  } catch (e) {
    tr.fail(`DS ${DS_JOB_STATUS_UPDATE} Update Job Status`, closeInputs, e);
    return done(teco.nextState(lot, {
      kind: OUTCOME.FAILED,
      segments: [logMsg.seg('logTecoCloseThrown'), logMsg.technical(e.message)]
    }, MAX_ATTEMPTS), { jobKey: pick.jobKey, statusBefore });
  }
  const interpreted = teco.interpretTecoResponse(res);
  const o = teco.nextState(lot, interpreted, MAX_ATTEMPTS);
  const detail = pick.reason === 'single' && pick.jobNo && pick.jobNo !== lot.PlexJobNumber
    ? [logMsg.seg('logTecoJobNoReturned', pick.jobNo)] : [];

  // --- Passo 4: lo stato E' cambiato? La rete contro il no-op silenzioso. ---
  // L'esito lo decide l'HTTP (`interpretTecoResponse` dice perche' non usiamo `Result_Code`), quindi
  // un 200 che non ha fatto niente e' indistinguibile da un 200 che ha chiuso il job — ed e' il modo
  // in cui si manifesterebbe un `Job_Status` che la Data Source non riconosce. Rileggere lo stato non
  // dimostra che il job sia chiuso (il nome dello stato e' configurazione del tenant, DEC-65), ma
  // «non e' cambiato niente» e' un fatto, e va detto.
  //
  // «INVARIATO» HA ORA DUE CAUSE, E UNA NON E' UN SOSPETTO. Con la 19529 non sapevamo che stato
  // aspettarci; il valore che la 23101 riceve lo mandiamo NOI, quindi un lotto che si rilegge GIA'
  // sullo stato mandato era gia' chiuso — e' un'informazione, non un'anomalia. Solo l'altro caso
  // alimenta il contatore del run e la riga di attenzione dell'ordine. Se la Connect API usasse una
  // grafia diversa da quella che mandiamo, `isTecoStatus` non aggancia e il ramo ricade su quello di
  // prima: si degrada al comportamento di ieri, non a uno nuovo.
  let post = { read: false, status: null };
  let unchanged = false;
  let alreadySet = false;
  if (o.State === STATE.APPLIED && PRECHECK && pre.read) {
    post = await readJobStatus(creds, lot, tr, 'ricontrollo');
    const same = post.read && !!post.status && post.status === statusBefore;
    alreadySet = same && teco.isTecoStatus(post.status);
    unchanged = same && !alreadySet;
  }
  const statusAfter = post.status;
  // E QUANDO LA RETE NON HA POTUTO GIRARE, LO SI DICE. Prima, una rilettura fallita era
  // indistinguibile da «job non trovato» e da un confronto andato bene: la riga chiudeva 'A' in
  // verde e nessuno sapeva che nessuno aveva controllato. «Non ho potuto guardare» non e' «ho
  // guardato»: la scrittura resta riuscita, il dubbio si dichiara.
  const verified = PRECHECK && pre.read && post.read;
  // Lo stato resta 'A' anche quando non e' cambiato: la chiamata E' riuscita, e un lotto il cui job
  // era GIA' completo prima darebbe lo stesso esito — ritentarlo per tre giri produrrebbe
  // un'anomalia falsa. Cio' che si fa e' DICHIARARLO, una volta, invece di archiviarlo (DEC-56).
  const trail = [
    statusBefore ? logMsg.seg('logTecoStatusBefore', statusBefore) : null,
    statusAfter && !unchanged && !alreadySet ? logMsg.seg('logTecoStatusAfter', statusAfter) : null,
    alreadySet ? logMsg.seg('logTecoStatusAlreadySet', statusAfter) : null,
    unchanged ? logMsg.seg('logTecoStatusUnchanged', statusAfter) : null,
    (o.State === STATE.APPLIED && !verified) ? logMsg.seg('logTecoStatusUnverified') : null
  ].filter(Boolean);

  return {
    ...o,
    segments: [...logMsg.normalize(o.segments), ...detail, ...trail],
    steps: tr.steps,
    jobKey: pick.jobKey,
    statusBefore,
    statusAfter,
    unchanged,
    alreadySet,
    verified,
    httpStatus: res.status
  };
}

/**
 * Lo stato del job su Plex, E se lo si e' potuto leggere.
 *
 * DUE INFORMAZIONI E NON UNA, ed e' il difetto che questa firma esiste per chiudere. Prima
 * restituiva una stringa o `null`, e `null` voleva dire due cose opposte: «Plex non ha un job con
 * quel numero» e «non sono riuscito a leggere». Peggio: la funzione non guardava nemmeno `r.ok`,
 * quindi un `401`, un `404` o un `500` finivano in `asArray(r.body)` — che rende `[]` — e uscivano
 * come «job non trovato». Da li' la rete anti no-op del passo 4 non girava e nessuna riga lo diceva:
 * il lotto chiudeva 'A' in verde, identico a uno verificato.
 *
 *   { read: false, status: null }  non ho potuto guardare
 *   { read: true,  status: null }  ho guardato, Plex non ha quel job
 *   { read: true,  status: 'X'  }  ho guardato, ecco lo stato
 *
 * NON BLOCCA MAI e non decide niente da sola: e' diagnostica. Un fallimento qui non deve impedire
 * la chiusura (chiamata prima della scrittura) ne' cambiarne l'esito (chiamata dopo) — ma va
 * DICHIARATO, ed e' il chiamante a farlo.
 * Effetto collaterale voluto: aggiorna `lot.PlexJobId` con l'id che Plex dichiara, che e' l'unico
 * punto in cui quel valore si riallinea se il dizionario porta un id vecchio.
 *
 * @returns {Promise<{read: boolean, status: string|null}>}
 */
async function readJobStatus(creds, lot, trace = null, label = 'stato job') {
  const path = `/scheduling/v1/jobs?jobNumber=${encodeURIComponent(lot.PlexJobNumber)}`;
  try {
    const r = await plexGet(creds, path);
    // `aux: true`: e' diagnostica, e resta fuori dal semaforo HTTP della riga (DEC-38).
    if (trace) trace.add(`GET jobs (${label})`, path, r, true);
    if (!r.ok) {
      console.warn(`>>> [ORDER-TECO] stato del job ${lot.PlexJobNumber} non letto: HTTP ${r.status}`
        + ' — la verifica della chiusura non e\' stata possibile e viene dichiarata');
      return { read: false, status: null };
    }
    const job = asArray(r.body).find((j) => j && j.jobNumber === lot.PlexJobNumber);
    if (job && job.id) lot.PlexJobId = job.id;
    return { read: true, status: (job && job.jobStatus) || null };
  } catch (e) {
    if (trace) trace.fail(`GET jobs (${label})`, path, e, true);
    console.warn(`>>> [ORDER-TECO] lettura stato job ${lot.PlexJobNumber} non riuscita`
      + ` (si procede comunque): ${e.message}`);
    return { read: false, status: null };
  }
}

// ================================================================
// Entry point
// ================================================================

async function run(summary) {
  console.log(`>>> [JOB CloseTecoPlexJobs] avvio (profilo: ${cds.env.profiles?.join(',') || 'default'})`);

  const db = await cds.connect.to('db');
  const s4 = await prodOrderSource();          // [IS-SOURCE]
  const activePlants = await resolveActivePlants(db);
  // La nota sulla CONFIGURAZIONE del run (canale, Data Source, Job_Status) si scrive in CODA e non
  // qui, benche' il dato sia noto adesso: `ZJobRunHDR.Message` e' String(255), il corpo della mail
  // lo stampa cosi' com'e' e `finish()` unisce le note nell'ORDINE DI INSERIMENTO troncando la
  // fine. Mettendo per prima la parte statica, il troncamento si mangiava le note d'esito — cioe'
  // le uniche che il destinatario deve leggere. Nel log del task, invece, quelle righe servono
  // all'avvio: restano qui sotto come console.log.
  console.log(`>>> [ORDER-TECO] Data Source di chiusura: ${DS_JOB_STATUS_UPDATE || '(disattivata)'}`
    + `, Job_Key dalla ${DS_GET_JOB_KEY}, Job_Status=${teco.JOB_STATUS_TECO},`
    + ` tentativi max ${MAX_ATTEMPTS}, precheck ${PRECHECK ? 'attivo' : 'spento'}`);

  if (!activePlants || activePlants.size === 0) {
    if (summary) summary.noScope({ active: 0, usable: 0 });
    console.log('>>> [ORDER-TECO] nessun plant utilizzabile: niente da fare');
    return { failed: 0 };
  }

  // ---- customizing per plant -------------------------------------------------
  const scope = await teco.resolveTecoScope(db, activePlants);
  for (const plant of scope.unconfigured) {
    const segments = [logMsg.seg('logTecoPlantUnconfigured', plant)];
    console.log(`>>> [ORDER-TECO] ${renderMsg(segments)}`);
    // scope() e non record(): e' una porzione di perimetro che non ha prodotto lavoro, e
    // `degrade: false` perche' e' una scelta di configurazione, non un guasto (DEC-39).
    if (summary) {
      summary.scope({ plant, objectType: 'PROD_ORDER_TECO', status: 'S', segments, degrade: false });
    }
  }
  if (!scope.configured.length) {
    console.log('>>> [ORDER-TECO] nessun plant configurato: niente da fare');
    return { failed: 0 };
  }
  console.log(`>>> [ORDER-TECO] criteri in vigore -> ${teco.describeTriggers(scope.byPlant)}`);

  // ---- candidati -------------------------------------------------------------
  // Il perimetro plant si passa QUI e non si applica dopo: un lotto di un plant fuori perimetro
  // non compare mai nella lista SAP, quindi finiva a ogni run nel ripiego per chiave — fino a 200
  // letture bruciate e lo stesso avviso per sempre. Chi ha il plant ignoto resta candidato.
  const { lots, byOrder } = await loadCandidates(db, scope.configured);
  if (!lots.length) {
    if (summary) summary.note([logMsg.seg('logTecoNoLotsToCheck')]);
    console.log('>>> [ORDER-TECO] nessun lotto da verificare');
    return { failed: 0 };
  }

  // ---- testate SAP -----------------------------------------------------------
  const wanted = new Set(byOrder.keys());
  const headers = await readOrderHeaders(s4, scope, wanted, summary);

  // [ORDER-TECO] Il job IMPARA il plant e lo persiste sul dizionario dei lotti.
  //
  // Senza, l'arretrato scritto prima della colonna `Plant` resterebbe '#NA' per sempre e il
  // pre-filtro qui sopra non lo toccherebbe mai: la coda dei candidati non si accorcerebbe di una
  // riga. La testata SAP e' gia' in mano — l'abbiamo appena letta — e il plant e' un fatto che
  // viene da SAP, non una nostra deduzione. Auto-chiudente: in uno o due run l'arretrato si
  // risolve da se'.
  //
  // Si scrive SOLO dove il plant e' ignoto: una riga che ce l'ha gia' non si tocca, perche' il
  // dizionario e' di un'altra feature e la sua verita' e' quella di chi l'ha scritta.
  await learnLotPlants(db, lots, headers.byOrder);

  const stats = {};
  const unavailable = new Set();
  const unconfiguredOrders = new Map();   // plant -> ordini di plant senza configurazione
  let processedLots = 0;
  let deferredLots = 0;
  // Lotti la cui chiusura e' stata accettata da Plex senza che lo stato del job cambiasse.
  let unchangedLots = 0;
  let failed = 0;
  let closed = 0;
  // I lotti su cui questo run ha DECISO qualcosa: trattati o rinviati. Quello che resta e' la coda
  // ferma — candidati il cui criterio non e' scattato — e va contata, non lasciata crescere muta.
  const decided = new Set();

  // ---- connessioni Plex per plant, memoizzate per il run ---------------------
  const connections = new Map();
  const connFor = async (plant) => {
    const key = String(plant || '');
    if (!connections.has(key)) {
      try {
        connections.set(key, { creds: await resolvePlexConnection(key, { db }), error: null });
      } catch (e) {
        if (!(e instanceof PlexConnectionMissing)) throw e;
        connections.set(key, { creds: null, error: e });
        console.error(`>>> [PLEX-CONN] plant ${key}: nessuna connessione configurata,`
          + ' i suoi job non vengono chiusi');
        if (summary) {
          summary.scope({
            plant: key,
            objectType: 'PROD_ORDER_TECO',
            segments: [logMsg.seg('logTecoPlantNoConnection')]
          });
        }
      }
    }
    return connections.get(key);
  };

  // ---- il ciclo ---------------------------------------------------------------
  for (const orderNo of [...byOrder.keys()].sort()) {
    const header = headers.byOrder.get(orderNo);
    if (!header) continue;                       // non verificabile: gia' dichiarato in aggregato

    const plant = String(header.ProductionPlant || '').trim();
    const cfg = scope.byPlant.get(plant);
    if (!cfg) {
      // Ordine ripescato per chiave il cui plant non ha configurazione: la riga per plant di
      // sopra lo dichiara solo per i plant licenziati, questa conta gli ordini rimasti fuori.
      unconfiguredOrders.set(plant, (unconfiguredOrders.get(plant) || 0) + 1);
      continue;
    }

    const trigger = teco.triggerOf(header, cfg);
    if (trigger.missing.length) {
      trigger.missing.forEach((f) => unavailable.add(f));
      continue;
    }
    if (!trigger.fired) continue;
    // Piu' di un flag acceso: l'ordine e' per esempio TECO **e** chiuso. `TriggerStatus` ne porta
    // uno solo — e' String(40) — quindi l'elenco intero va nel messaggio, che e' persistito.
    const flagsSeg = trigger.flags.length > 1
      ? [logMsg.seg('logTecoTriggerFlags', trigger.flags.join(', '))] : [];

    const orderLots = byOrder.get(orderNo) || [];
    teco.addTecoOrder(stats, plant);

    // La connessione si risolve SOLO se si deve scrivere: un plant con la leva spenta non ha
    // bisogno di un tenant Plex, e chiederglielo produrrebbe un avviso per una configurazione
    // che non serve.
    const enabled = !!cfg.IsEnabled && DS_JOB_STATUS_UPDATE > 0;
    const conn = enabled ? await connFor(plant) : { creds: null, error: null };
    const done = [];
    // Lotti di QUESTO ordine rinviati dal tetto per esecuzione: senza contarli, l'esito per ordine
    // direbbe «1 su 1 chiusi» su un ordine di cui restano due pacchetti mai guardati.
    let deferredHere = 0;

    for (const lot of orderLots) {
      decided.add(teco.lotKey(orderNo, lot.PlexJobNumber));
      if (MAX_LOTS_PER_RUN > 0 && processedLots >= MAX_LOTS_PER_RUN) {
        deferredLots += 1;
        deferredHere += 1;
        continue;
      }
      processedLots += 1;

      // La PRENOTAZIONE: `processLot` la chiama subito prima della Data Source di chiusura. Sta
      // qui e non la' perche' e' l'unica riga che ha bisogno del database, e `processLot` deve
      // restare collaudabile senza (nei test e' una spia).
      const claim = async ({ jobKey, statusBefore }) => saveState(db, {
        order: orderNo,
        lot: lot.PlexJobNumber,
        plant,
        flag: trigger.flag,
        state: STATE.CLAIMED,
        // Il tentativo si conta QUI: se il processo muore dopo, e' comunque stato consumato.
        attempts: (Number(lot.attempts) || 0) + 1,
        jobId: lot.PlexJobId,
        jobKey,
        statusBefore,
        httpStatus: null,
        segments: [logMsg.seg('logTecoClaimWriting', lot.PlexJobNumber)]
      });

      let outcome;
      try {
        outcome = await processLot({ creds: conn.creds, connError: conn.error, enabled, lot, claim });
      } catch (error) {
        // Rete di sicurezza: processLot non lancia, ma se lo facesse un pacchetto non deve
        // portarsi via gli altri lotti dell'ordine.
        console.error(`>>> [ORDER-TECO] lotto ${lot.PlexJobNumber}: ${error.message}`);
        outcome = {
          ...teco.nextState(lot, {
            kind: OUTCOME.FAILED, segments: [logMsg.technical(error.message)]
          }, MAX_ATTEMPTS),
          steps: [], jobKey: null, statusBefore: null, httpStatus: null
        };
      }

      // L'elenco dei flag scattati va IN CODA: quando il JSON sfora, `pack` scarta dalla coda, e
      // l'esito deve sopravvivere al dettaglio del perche'.
      const lotSegments = [...logMsg.normalize(outcome.segments), ...flagsSeg];
      const lotText = renderMsg(lotSegments);
      const state = outcome.State;

      try {
        await saveState(db, {
          order: orderNo,
          lot: lot.PlexJobNumber,
          plant,
          flag: trigger.flag,
          state,
          attempts: outcome.Attempts,
          jobId: lot.PlexJobId,
          jobKey: outcome.jobKey,
          statusBefore: outcome.statusBefore,
          httpStatus: outcome.httpStatus,
          segments: lotSegments
        });
      } catch (e) {
        console.error(`>>> [ORDER-TECO] stato non persistito per ${orderNo}/${lot.PlexJobNumber}:`
          + ` ${e.message}`);
      }

      // [ORDER-TECO] La traccia delle chiamate del tentativo (feature 0031). Si scrive SOLO se
      // qualche passo e' partito: un lotto fermo perche' la leva e' spenta non ha chiamato niente, e
      // una riga di log senza chiamate direbbe il falso su cosa e' stato tentato.
      const logCounter = (outcome.steps && outcome.steps.length)
        ? await writeTecoLog(db, {
          order: orderNo,
          lot: lot.PlexJobNumber,
          // La scala del log di invio e' S|W|E: 'X' (tentativi esauriti) e' un errore, qui.
          status: teco.lotRecordStatus(state) === 'S' ? 'S' : 'E',
          segments: lotSegments,
          steps: outcome.steps
        })
        : null;

      done.push({ State: state });
      teco.addTecoStat(stats, plant, state);

      if (state === STATE.DETECTED) {
        // Rilevato e non applicato: non e' un oggetto trattato, e una riga per lotto a ogni run
        // produrrebbe una mail ricorrente per sempre (rischio R-03 della 0014). Lo dichiara la
        // voce aggregata per plant.
        if (summary) summary.skip(1);
        console.log(`>>> [ORDER-TECO] ${orderNo}/${lot.PlexJobNumber}: ${lotText}`);
      } else {
        if (summary) {
          summary.record({
            plant,
            objectType: 'PROD_ORDER_TECO',
            objectKey: orderNo,
            objectKey2: lot.PlexJobNumber,
            status: teco.lotRecordStatus(state),
            segments: lotSegments,
            // Il puntatore va alla riga di STORICO quando c'e': porta i corpi delle chiamate, che
            // sono cio' che serve a capire un fallimento. Senza chiamate resta lo stato del lotto.
            logRef: excLog.logRefFor(orderNo, logCounter)
              || `ZProdOrderTecoState/${orderNo}/${lot.PlexJobNumber}`
          });
        }
        if (state === STATE.APPLIED) {
          closed += 1;
          console.log(`>>> [OK] ${orderNo}/${lot.PlexJobNumber}: ${lotText}`);
          // Scrittura riuscita e stato del job INVARIATO: il lotto resta chiuso per noi, ma il
          // dubbio si dichiara una volta — qui e non nella voce per plant, perche' nomina il lotto e
          // il lotto e' ormai terminale, quindi non torna a ogni esecuzione.
          if (outcome.unchanged) {
            unchangedLots += 1;
            const segments = [logMsg.seg(
              'logTecoLotUnchanged', lot.PlexJobNumber, orderNo, outcome.statusAfter
            )];
            console.warn(`>>> [ORDER-TECO] ${renderMsg(segments)}`);
            if (summary) {
              summary.scope({
                plant, objectType: 'PROD_ORDER_TECO', objectKey: orderNo, status: 'W', segments
              });
            }
          }
        } else if (state === STATE.NOTHING) {
          console.log(`>>> [ORDER-TECO] ${orderNo}/${lot.PlexJobNumber}: ${lotText}`);
        } else {
          failed += 1;
          console.error(`>>> [ERRORE] ${orderNo}/${lot.PlexJobNumber}: ${lotText}`);
        }
      }
    }

    // Esito dell'ORDINE: un ordine spacchettato chiuso a meta' non e' un ordine chiuso, e va detto
    // una volta per ordine — non per lotto.
    const outcomeOfOrder = teco.orderOutcome(done);
    const deferredSeg = deferredHere ? [logMsg.seg('logTecoLotsDeferredHere', deferredHere)] : [];
    const orderSegments = [...logMsg.normalize(outcomeOfOrder.segments), ...deferredSeg];
    console.log(`>>> [ORDER-TECO] ordine ${orderNo} (${plant}, ${trigger.flag}):`
      + ` ${renderMsg(orderSegments)}`);
    if (summary && outcomeOfOrder.partial) {
      summary.scope({
        plant,
        objectType: 'PROD_ORDER_TECO',
        objectKey: orderNo,
        status: 'W',
        segments: [
          logMsg.seg('logTecoOrderPartialHead', orderNo),
          ...orderSegments,
          logMsg.seg('logTecoOrderPartialTail')
        ]
      });
    }
  }

  // ---- la coda ferma ---------------------------------------------------------
  // I candidati su cui questo run non ha deciso niente: il criterio configurato non e' scattato.
  // Un lotto esce dai candidati SOLO con uno stato terminale, quindi questi tornano domani, e
  // dopodomani. Finche' il criterio corrisponde a quello che il plant fa davvero la coda si drena
  // da se'; se non corrisponde cresce, e senza questa riga cresce IN SILENZIO — il job continua a
  // chiudere in verde «0 ordini trattati», che e' identico a «non c'era niente da fare».
  for (const lot of lots) {
    if (decided.has(teco.lotKey(lot.ManufacturingOrder, lot.PlexJobNumber))) continue;
    teco.addTecoStale(stats, lot.Plant, lot.CreatedAt);
  }

  // ---- dichiarazioni di fine run ---------------------------------------------
  if (unavailable.size) {
    const segments = [logMsg.seg('logTecoFlagsUnavailable', [...unavailable].sort().join(', '))];
    console.error(`>>> [ORDER-TECO] ${renderMsg(segments)}`);
    if (summary) summary.scope({ objectType: 'PROD_ORDER_TECO', status: 'W', segments });
  }
  for (const [plant, count] of [...unconfiguredOrders.entries()].sort()) {
    const segments = [logMsg.seg('logTecoOrdersUnconfigured', count, plant || '?')];
    console.log(`>>> [ORDER-TECO] ${renderMsg(segments)}`);
    if (summary) {
      summary.scope({ plant, objectType: 'PROD_ORDER_TECO', status: 'S', segments, degrade: false });
    }
  }
  if (headers.notFound.length) {
    const segments = [logMsg.seg(
      'logTecoOrdersNotInSap', headers.notFound.length, headers.notFound.slice(0, 3).join(', ')
    )];
    console.warn(`>>> [ORDER-TECO] ${renderMsg(segments)}`);
    if (summary) summary.scope({ objectType: 'PROD_ORDER_TECO', status: 'W', segments });
  }
  if (deferredLots) {
    const segments = [logMsg.seg('logTecoLotsDeferred', deferredLots, MAX_LOTS_PER_RUN)];
    console.log(`>>> [ORDER-TECO] ${renderMsg(segments)}`);
    if (summary) summary.note(segments);
  }
  if (summary) {
    for (const entry of teco.tecoRecapEntries(stats)) {
      summary.scope({
        plant: entry.plant,
        objectType: 'PROD_ORDER_TECO',
        objectKey: 'TECO_RECAP',
        status: entry.status,
        degrade: entry.degrade,
        segments: entry.segments
      });
      console.log(`>>> [ORDER-TECO] recap ${entry.plant}: ${renderMsg(entry.segments)}`);
    }
  }

  if (unchangedLots && summary) {
    summary.note([logMsg.seg('logTecoUnchangedLots', unchangedLots)]);
  }
  // Ultima nota, non la prima: e' la CONFIGURAZIONE del run — utile a chi indaga, ma sacrificabile
  // dal troncamento a 255 di `ZJobRunHDR.Message`, a differenza delle note d'esito qui sopra.
  if (summary) {
    summary.note([logMsg.seg(
      'logTecoRunConfig', s4.mode, DS_JOB_STATUS_UPDATE > 0 ? DS_JOB_STATUS_UPDATE : 'off',
      teco.JOB_STATUS_TECO, READ_MODE
    )]);
  }
  console.log(`>>> [JOB CloseTecoPlexJobs] completato — lotti chiusi: ${closed},`
    + `${unchangedLots ? ` di cui ${unchangedLots} con stato invariato,` : ''}`
    + ` falliti: ${failed}, lotti trattati: ${processedLots}`);
  return { failed };
}

module.exports = {
  run, processLot, loadCandidates, readOrderHeaders, saveState, writeTecoLog, newTrace,
  // Esportata per il solo test: e' la regola «un refuso ricade sul default, non toglie il tetto»,
  // e senza un test quella riga sarebbe la prima a essere «semplificata» in un `parseInt`.
  intEnv, learnLotPlants
};

// Bootstrap condiviso (srv/jobs/lib/runJob.js): modello, riepilogo, recap garantito e exit code.
if (require.main === module) {
  const { runJob } = require('./lib/runJob');
  // serveAll non serve: questo job non invoca action di servizi locali, scrive solo sul db.
  runJob({ jobCode: JOB_CODE, serveAll: false, main: (summary) => run(summary) });
}

/**
 * [IS-SOURCE] Sorgente dati dell'area MATERIALI (area A, feature 0013).
 *
 * Sostituisce `cds.connect.to('OP_API_PRODUCT_SRV_0001')` in tutte le letture di
 * materiale: dashboard, invio a Plex, gruppi oggetti, spacchettamento e job di
 * sincronizzazione. La meccanica (pool di istanze, dispatch, chunking, fan-out,
 * troncamento, log) sta in isRemoteSource.js: qui c'è solo la route table, la leva di
 * area e gli helper che sostituiscono l'`$expand to_Description` in modalità IS.
 *
 * Leva: PRODUCT_SOURCE (IS = default, ONPREM = pin sul canale storico).
 *
 * [PRODUCT-QUERY] DALLA 0040 LE SORGENTI SONO DUE, e la seconda ha una BASE DIVERSA. La query per
 * plant di `A_Product` (riga 34 di `EndpointFlussiMARS_V1`) restituisce due campi che
 * `OP_API_PRODUCT_SRV_0001.A_Product` NON HA — `Plant`, il criterio, e `ProductDescription`, che su
 * quel modello vive solo sull'entity figlia. Chiedere un campo che il CSN non porta e' un errore
 * (`ProductType` su `A_ProductPlant`, isQueryShape.js), ed e' la ragione per cui SOBSL e FEVOR
 * viaggiano su campi altrui invece di averne uno proprio (DEC-64). Il modello nuovo li ha entrambi
 * perche' e' il contratto di QUELL'iFlow: srv/external/ZMARS_PRODUCT_SRV.cds. Quindi due entry
 * `cds.requires`, due istanze, due `entities` — e un solo interruttore d'area, `PRODUCT_SOURCE`,
 * perche' il canale e' lo stesso.
 */

'use strict';

const createRemoteSource = require('./isRemoteSource');
const { loadProductRowsOutcome, readProductRows, invalidateProductRows } = require('./productRows');

/** Entry cds.requires che porta il modello CSN condiviso da tutte le istanze (DEC-18). */
const BASE = 'OP_API_PRODUCT_SRV_0001';
/** [PRODUCT-QUERY] Entry del modello della QUERY per plant: e' l'EDMX dell'iFlow, non l'API SAP. */
const QUERY_BASE = 'ZMARS_PRODUCT_SRV';

/**
 * Comportamenti per (entity, operazione). I `path` NON stanno qui: stanno in
 * package.json > cds.requires.<BASE>.isSource.paths, perché sono dato di deploy.
 *
 * - `A_Product` non ha un _QUERYGET (richiesta R-1 del contratto): una lista di materiali
 *   diventa N letture per chiave a concorrenza 8, senza tetto (FR-08).
 * - `A_ProductDescription` ha il solo _GET per (Product, Language). Il `fanOut` è quello
 *   che rende una lista di materiali N letture per chiave anche qui: senza, la lista
 *   arriverebbe come un OR di `eq` su un indirizzo per chiave, che il contratto non prevede.
 *   È l'unica rotta `tolerant` dell'area: vedi sotto il perché, e perché A_Product non lo è.
 *
 * [IS-BLANK-ROWS] `identity` è ciò che rende UTILIZZABILE una riga: le chiavi con cui viaggia
 * verso il cockpit. Tutte vuote = riga spazzatura in una risposta `200` ben formata, da dichiarare
 * invece di consegnarla al binding (vedi `identityCheck` in isQueryShape.js).
 */
const ROUTES = {
  A_Product: {
    // NON tollerante, e non è una dimenticanza: in cat-service.js (merge della READ Products)
    // un materiale assente da `productMap` viene ESCLUSO dalla riga, quindi tollerare letture
    // parziali qui accorcerebbe la lista in silenzio — l'esito che la 0013 esiste per evitare.
    // Prima di renderla tollerante va reso visibile all'utente il numero di righe perse.
    //
    // [PRODUCT-QUERY] LA ROTTA PER CHIAVE RESTA, benche' dalla 0040 la dashboard e il job non la
    // usino piu': la usa ancora `srv/lib/orderCompExcl.js`, che legge l'anagrafica di pochi
    // componenti d'ordine per volta e non ha sempre un plant in mano. Toglierla spegnerebbe
    // l'esclusione componenti degli ordini.
    GET: { keyPredicate: ['Product'], fanOut: 'Product', identity: ['Product'] }
  },
  A_ProductPlant: {
    QUERY: { identity: ['Product', 'Plant'] },
    GET: { keyPredicate: ['Product', 'Plant'], identity: ['Product', 'Plant'] }
  },
  A_ProductDescription: {
    // `tolerant`: la descrizione è un campo, non una riga. UNA chiave che manda l'iFlow in 500
    // non deve svuotare la descrizione di tutti gli altri materiali — è quello che accadeva il
    // 06/08/2026: 229 righe lette su 304 e nessuna a schermo, perché il fan-out lanciava e le
    // righe raccolte venivano buttate. La lettura resta dichiarata KO, il dato buono si usa.
    GET: { keyPredicate: ['Product', 'Language'], fanOut: 'Product', tolerant: true, identity: ['Product', 'Language'] }
  }
};

/**
 * Unione dei campi di `A_Product` che i consumatori a valle leggono, verificata sul CSN
 * (srv/external/OP_API_PRODUCT_SRV_0001.cds). Ogni call site chiede il PROPRIO
 * sottoinsieme: questo elenco è il massimo, non l'obbligo.
 *
 * `LastChangeDate` è il driver del delta del job materiali: se non arriva, ogni esecuzione
 * rinvia tutto a Plex.
 */
const PRODUCT_SELECT = Object.freeze([
  'Product', 'ProductType', 'ProductGroup', 'BaseUnit', 'CrossPlantStatus', 'Division',
  'ProductHierarchy', 'IsMarkedForDeletion', 'GrossWeight', 'NetWeight', 'WeightUnit',
  'CreationDate', 'LastChangeDate'
]);

/**
 * [PRODUCT-QUERY] Il `$select` della query per plant: gli stessi campi di `PRODUCT_SELECT` più i
 * due che soltanto quel modello espone.
 *
 * `ProductDescription` è il motivo per cui questa lettura ne sostituisce DUE: la descrizione arriva
 * dentro la riga, quindi `A_ProductDescription` non si legge più. Con essa se ne va anche la
 * possibilità di CHIEDERE la lingua — su questo indirizzo la decide l'iFlow (§2 di
 * srv/external/PRODUCT_QUERY_IS.md). È una conseguenza accettata, non una svista: la descrizione a
 * schermo non segue più la lingua dell'utente.
 *
 * `Plant` non serve a nessun consumatore: serve alla GUARDIA di srv/lib/productRows.js, che è
 * l'unico modo di accorgersi che `SO_PLANT` non è stato applicato. Un elenco più grande del
 * previsto non dà errore.
 *
 * Ogni nome qui dentro deve esistere in `srv/external/ZMARS_PRODUCT_SRV.cds`: un campo fuori dal
 * CSN non dà un errore leggibile, dà `undefined`. Lo sorveglia test/productQuerySelect.test.js.
 */
const PRODUCT_QUERY_SELECT = Object.freeze([...PRODUCT_SELECT, 'ProductDescription', 'Plant']);

/**
 * Le informazioni che il canale IS NON fornisce — **oggi nessuna**.
 *
 * Conteneva `ProcurementSubType` (SOBSL) e `ProductionSupervisor` (FEVOR): vivono su
 * `A_ProductSupplyPlanning` e `A_ProductWorkScheduling`, per cui su IS non esiste alcun
 * indirizzo pubblicato (FR-17, richiesta R-1b del contratto). Restavano `undefined`, nessun
 * valore di riempimento le sostituiva (FR-22), e una condizione di categoria che le usava non
 * era valutabile: non soddisfatta, materiale fuori perimetro. Era la sola causa di differenze
 * prima/dopo attribuibile alla 0013.
 *
 * [W1-26] Il lato SAP le ha rese disponibili sulla stessa chiamata `ZMARS_PRODUCT_PLANT_GET`,
 * facendole viaggiare su due campi flat già esposti (`IS_FIELD_ALIASES` in isQueryShape.js).
 * L'elenco si è quindi svuotato, ed è **questa costante** l'interruttore che spegne le tre
 * dichiarazioni di lacuna: l'avviso della scheda «Categorie Materiali»
 * (`matCategoryFieldAvailability`), la riga di log per plant della lista materiali e la nota di
 * perimetro incompleto nel recap di MAT_SYNC. Nessuna di esse è stata rimossa.
 *
 * LA COSTANTE NON SI CANCELLA. È il punto in cui si ri-dichiara una lacuna futura: rimettere
 * qui un nome fa ripartire da solo l'intero apparato, per quel campo e solo per quello. La
 * strada sbagliata, il giorno che servisse, è aggiungere un avviso nuovo da qualche altra parte.
 */
const UNAVAILABLE_IN_IS = Object.freeze([]);

const productSource = createRemoteSource({
  base: BASE,
  envVar: 'PRODUCT_SOURCE',
  area: 'materiali',
  routes: ROUTES
});

/**
 * [PRODUCT-QUERY] La sorgente della QUERY per plant di `A_Product`.
 *
 * Stessa leva d'area (`PRODUCT_SOURCE`): il canale è uno solo, cambia il modello. In ONPREM questa
 * sorgente NON viene mai costruita — la memoizzazione è pigra e `fetchProductsForPlants` la tocca
 * solo dentro il ramo IS — perché su gateway on-premise l'indirizzo non esiste e la lettura di
 * sempre (`$expand to_Description`) resta quella giusta (DEC-34).
 *
 * [IS-EGRESS] La destination NON si sceglie qui. `createRemoteSource` passa da `resolveEgress`, per
 * cui dentro un run batch questa istanza esce da sé su `MARS_SAP_CON_BA` (utenza tecnica) e nel
 * server web sulla destination configurata. È il QUINTO punto d'uscita verso gli iFlow (DEC-98).
 *
 * IL BLOCCO `credentials` DELLA ENTRY SERVE E NON VIENE USATO, e va lasciato dov'è: `build()` fa
 * `cds.connect.to(base)` per avere le definizioni CSN, e un servizio remoto con entity e senza
 * credenziali muore all'avvio con «No credentials configured» (remote/Service.js:200). Le letture
 * vere NON passano da lì: ogni istanza nasce con `{ destination, path }` espliciti, che sono quelli
 * dell'iFlow. Il path on-premise scritto in `credentials` è quindi un segnaposto — su gateway
 * on-premise questo service root non esiste, e in ONPREM questa sorgente non viene mai costruita.
 */
const productQuerySource = createRemoteSource({
  base: QUERY_BASE,
  envVar: 'PRODUCT_SOURCE',
  area: 'materiali (query per plant)',
  routes: {
    // Nessun `keyPredicate` e nessun `fanOut`: è una collection + `$filter`, che è esattamente
    // ciò che l'indirizzo è. `identity` fa scattare la guardia [IS-BLANK-ROWS] su questa lettura.
    A_Product: { QUERY: { identity: ['Product'] } }
  }
});

/**
 * Descrizioni materiale in modalità IS: N letture per chiave su `A_ProductDescription`, una per
 * materiale, nella SOLA lingua richiesta (fan-out nella factory, alla concorrenza configurata
 * in package.json > cds.requires.<BASE>.isSource.concurrency).
 *
 * La rotta è `tolerant`: se alcune chiavi fanno fallire l'indirizzo, la lettura è dichiarata KO
 * ma le righe già arrivate vengono usate. Senza questo, un solo materiale che rompe l'iFlow
 * lascia SENZA DESCRIZIONE tutta la lista.
 *
 * NON esiste più il ripiego «prima lingua disponibile»: vedi il commento in fondo alla funzione.
 *
 * In ONPREM non viene usata: la descrizione arriva dall'`$expand to_Description` (TD-5), che
 * conserva il proprio ripiego sulla prima lingua restituita.
 *
 * @returns {Promise<{byProduct: Map<string,string>, failed: Array<{key:string,message:string}>}>}
 */
async function fetchDescriptions(src, products, { language = 'EN' } = {}) {
  const byProduct = new Map();
  const failed = [];
  const list = [...new Set((products || []).filter(Boolean))];
  if (!list.length || src.mode !== 'IS') return { byProduct, failed };

  const { A_ProductDescription } = src.entities;

  /** Righe -> mappa, con la normalizzazione array / oggetto singolo in un posto solo. */
  const collect = (rows) => {
    for (const r of (Array.isArray(rows) ? rows : rows ? [rows] : [])) {
      if (r && r.ProductDescription) byProduct.set(r.Product, r.ProductDescription);
    }
  };

  // Lingua della richiesta, per chiave (Product, Language).
  try {
    collect(await src.run(
      SELECT.from(A_ProductDescription)
        .columns('Product', 'Language', 'ProductDescription')
        .where({ Product: { in: list }, Language: language })
    ));
  } catch (e) {
    // [IS-SOURCE] Rotta tollerante: la lettura è fallita e resta dichiarata tale, ma le righe
    // che l'indirizzo ha restituito prima di rompersi sono buone e si usano. Le chiavi fallite
    // vanno nel messaggio: sono la prova da consegnare a chi gestisce l'iFlow.
    collect(e.partialRows);
    const detail = e.failedCount
      ? ` | ${e.failedCount} letture per chiave fallite su ${list.length}, ` +
        `${byProduct.size} descrizioni comunque recuperate` +
        (e.failedKeys && e.failedKeys.length ? ` | chiavi: ${e.failedKeys.join(' ; ')}` : '')
      : '';
    failed.push({ key: `A_ProductDescription(${language})`, message: `${e.message}${detail}` });
  }

  // [IS-SOURCE] NIENTE secondo passaggio «prima descrizione disponibile in qualsiasi lingua».
  // Non è una semplificazione: su questo canale non è esprimibile. L'indirizzo E-11 espone la
  // SOLA forma per chiave — una collection + $filter risponde `OData operation: GET_FEED is not
  // configured` — e senza la lingua il key predicate non è componibile. Il ripiego valeva quindi
  // 304 chiamate per refresh che possono soltanto dare 500.
  // Conseguenza dichiarata: in IS un materiale privo di descrizione nella lingua richiesta la
  // mostra VUOTA, come già accade per i campi di UNAVAILABLE_IN_IS. ONPREM è invariato.
  return { byProduct, failed };
}

/**
 * Dettagli materiale per un elenco di materiali, nella forma che serve al chiamante.
 *
 * [PRODUCT-QUERY] DALLA 0040 QUESTA È LA VIA SECONDARIA. La dashboard e il job materiali passano da
 * `fetchProductsForPlants`, che legge il perimetro di un plant in una chiamata; qui restano il ramo
 * ONPREM — usato anche da `fetchProductsForPlants`, che gli delega per intero — e l'unico chiamante
 * IS rimasto, `srv/lib/orderCompExcl.js`, che chiede pochi componenti d'ordine per volta e non ha
 * sempre un plant in mano. Non è codice morto: è la lettura giusta quando i materiali sono pochi e
 * il plant non c'è.
 *
 * Contiene il ramo di modalità una volta sola, così le call site non lo duplicano:
 *
 *   IS      -> N letture per chiave su A_Product (fan-out, concorrenza 8)
 *              + N letture per chiave su A_ProductDescription
 *   ONPREM  -> la query di oggi, `$expand to_Description` compreso, INVARIATA (TD-5)
 *
 * Tollerante come oggi: una lettura non riuscita non solleva, popola `failed` e lascia al
 * chiamante la dichiarazione (riga di log della factory + summary.scope nei job, TD-8).
 *
 * @param {object}   src        sorgente (this.S4Product / productSource())
 * @param {string[]} products   materiali distinti
 * @param {object}   opts
 * @param {string[]} opts.columns        `$select` in modalità IS
 * @param {string[]|'*'} [opts.onpremColumns='*'] proiezione in modalità ONPREM (byte per byte come oggi)
 * @param {string}   [opts.language='EN']
 * @param {number}   [opts.chunkSize=150] dimensione del batch ONPREM (come oggi)
 * @param {Array}    [opts.clientWhere]   `$filter` del client spinto in ONPREM (M3)
 * @returns {Promise<{byProduct: Map<string,object>, calls: number, failed: Array}>}
 */
async function fetchProductsByKey(src, products, {
  columns = PRODUCT_SELECT,
  onpremColumns = '*',
  language = 'EN',
  chunkSize = 150,
  clientWhere = null
} = {}) {
  const byProduct = new Map();
  const failed = [];
  let calls = 0;
  const list = [...new Set((products || []).filter(Boolean))];
  if (!list.length) return { byProduct, calls, failed };

  const { A_Product } = src.entities;

  if (src.mode === 'IS') {
    // [IS-SOURCE] I due fan-out partono INSIEME. Non c'è dipendenza di dati: le descrizioni si
    // leggono sulla `list` del chiamante, non sull'esito di A_Product. In sequenza il tempo
    // dell'elenco era t(A_Product) + t(descrizioni) — 304 letture per chiave ciascuna, ~36 s la
    // prima da sola — e il `$batch` della dashboard finiva in 504. Ora è max() dei due.
    // Le richieste in volo raddoppiano: due pool indipendenti da `concurrency`
    // (package.json > cds.requires.OP_API_PRODUCT_SRV_0001.isSource), non un pool condiviso.
    // allSettled e non all: se A_Product fallisce, le descrizioni devono comunque essere lette e
    // dichiarate in `failed`, che è ciò che faceva la sequenza col try/catch.
    // La correlazione URL <-> lettura nel log di collaudo regge, perché isCallLog apre una
    // AsyncLocalStorage per ogni run() (isCallLog.js, sezione CORRELAZIONE).
    calls++;
    const [prod, desc] = await Promise.allSettled([
      src.run(SELECT.from(A_Product).columns(...columns).where({ Product: { in: list } })),
      fetchDescriptions(src, list, { language })
    ]);

    if (prod.status === 'fulfilled') {
      const rows = prod.value;
      for (const r of (Array.isArray(rows) ? rows : rows ? [rows] : [])) {
        byProduct.set(r.Product, { ...r, ProductDescription: '' });
      }
    } else {
      failed.push({ key: 'A_Product', message: prod.reason?.message || String(prod.reason) });
    }

    // fetchDescriptions cattura al suo interno e non rigetta: il ramo rejected c'è perché un
    // errore fuori dai suoi try (per esempio src.entities) non passi via in silenzio.
    if (desc.status === 'fulfilled') {
      failed.push(...desc.value.failed);
      for (const [product, text] of desc.value.byProduct) {
        const row = byProduct.get(product);
        if (row) row.ProductDescription = text;
      }
    } else {
      failed.push({ key: 'A_ProductDescription', message: desc.reason?.message || String(desc.reason) });
    }
    return { byProduct, calls, failed };
  }

  // ---- ONPREM: la query di oggi, invariata ------------------------------------------
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const q = SELECT.from(A_Product, (p) => {
      if (onpremColumns === '*') p('*');
      else for (const c of onpremColumns) p(c);
      p.to_Description(d => { d('ProductDescription'); d('Language'); });
    }).where({ Product: { in: chunk } }).limit(chunk.length);
    if (clientWhere) q.where(clientWhere);
    try {
      calls++;
      const rows = await src.run(q);
      for (const r of (rows || [])) {
        const text = r.to_Description?.find(d => d.Language === language)?.ProductDescription
          || r.to_Description?.[0]?.ProductDescription
          || '';
        byProduct.set(r.Product, { ...r, ProductDescription: text });
      }
    } catch (e) {
      failed.push({ key: `A_Product[${i}-${i + chunk.length}]`, message: e.message });
    }
  }
  return { byProduct, calls, failed };
}

/**
 * [PRODUCT-QUERY] I dettagli materiale letti PER PLANT, con una query invece di 2N letture per
 * chiave (feature 0040).
 *
 * Stessa forma di ritorno di `fetchProductsByKey`, così i tre chiamanti non cambiano oltre
 * all'aggiunta dei plant: `{ byProduct, calls, failed }` — più `scope`, il verdetto di ogni plant,
 * per chi deve dichiararlo a schermo.
 *
 * COSA FA, IN ORDINE:
 *   IS      -> una lettura paginata per plant (srv/lib/productRows.js), in parallelo, ognuna in
 *              cache e single-flight; poi si risolvono i materiali chiesti dagli indici.
 *   ONPREM  -> `fetchProductsByKey` verbatim: `$expand to_Description`, batch da 150, il `$filter`
 *              del client spinto. Non si tocca (DEC-34).
 *
 * QUATTRO COSE CHE VALGONO DA SOLE:
 *
 *  - NESSUN RIPIEGO SULLE LETTURE PER CHIAVE. Un plant che non si riesce a leggere lascia i suoi
 *    materiali FUORI dalla mappa, e l'assenza si dichiara. Ricadere sulle 2N letture nasconderebbe
 *    che l'indirizzo nuovo non funziona, e lo farebbe pagando il tempo peggiore.
 *
 *  - QUESTA FUNZIONE NON LANCIA MAI, e la riga che poteva farlo è `await querySource()`.
 *    `createRemoteSource` solleva se il path manca da `package.json` o se la connessione non si
 *    costruisce, e da lì l'eccezione risalirebbe fino alla READ di `Products` — che non ha un
 *    `try` — facendo fallire l'INTERA LISTA invece di servirne una corta e dichiarata; nel job
 *    ucciderebbe il run. È il contrario della regola qui sopra: «si dichiara» vuol dire che chi
 *    chiama riceve `failed`, non un'eccezione. Prima della 0040 non poteva accadere, perché
 *    `fetchProductsByKey` cattura tutto al suo interno.
 *
 *  - «CHIESTO E NON TROVATO» SI CONTA. Un materiale che sta su `A_ProductPlant` e non su
 *    `A_Product` non è una curiosità: nel merge della READ Products un materiale assente da
 *    `productMap` viene ESCLUSO dalla riga, cioè la lista si accorcia in silenzio. Se le letture
 *    erano tutte complete quell'assenza non ha spiegazione, e allora è un fallimento dichiarato.
 *
 *  - LA RIGA SI COPIA. Quella nella mappa è la riga in CACHE, condivisa con chiunque legga lo
 *    stesso plant nei cinque minuti successivi: chi annota sopra un dato derivato lo farebbe
 *    vedere a tutti (è la stessa regola di `[PLANT-ROWS]` in cat-service.js).
 *
 * @param {object}   src       la sorgente d'area (decide la MODALITÀ; in IS non viene interrogata)
 * @param {string[]} products  materiali chiesti
 * @param {object}   opts
 * @param {string[]|Set} opts.plants  i plant su cui cercarli — obbligatorio in modalità IS
 * @param {number}   [opts.deadlineMs] 0 nei job (la scadenza di 90 s esiste per l'approuter)
 * @param {boolean}  [opts.fresh=false] salta la cache del lettore. Lo passano i JOB: in un run ogni
 *   plant si legge una volta sola, e da lì si SCRIVE su Plex — la via lenta e `MAT_SYNC` leggono
 *   sempre fresco (DEC-75). Deve stare insieme alla stessa scelta sulla lettura del perimetro, o il
 *   job leggerebbe fresco `A_ProductPlant` e dalla cache `A_Product`.
 * @param {function} [opts.querySource] la sorgente della query, iniettabile: è ciò che rende
 *   collaudabile senza rete una funzione che per il resto parla solo con un sistema esterno.
 */
async function fetchProductsForPlants(src, products, {
  plants = [],
  columns = PRODUCT_SELECT,
  onpremColumns = '*',
  language = 'EN',
  chunkSize = 150,
  clientWhere = null,
  deadlineMs = undefined,
  fresh = false,
  querySource = productQuerySource
} = {}) {
  const list = [...new Set((products || []).filter(Boolean))];
  const wanted = [...new Set([...(plants || [])].map(p => String(p == null ? '' : p).trim()).filter(Boolean))];

  // ================================================================
  // [PLANT-ACCESS] SENZA PLANT NON SI LEGGE, SU NESSUNO DEI DUE CANALI (feature 0048).
  //
  // Il controllo stava DOPO lo split qui sotto, quindi valeva solo per IS: in ONPREM la lettura
  // per chiave non ha bisogno del plant e partiva comunque. Era innocuo finché «zero plant»
  // significava «nessun plant licenziato» — una condizione di configurazione. Dalla 0048 significa
  // anche «questo utente non ha nessun ruolo», e su quel ramo ONPREM avrebbe letto l'anagrafica dei
  // materiali per un utente il cui perimetro è vuoto: il gate della lista sarebbe rimasto in piedi
  // e il dettaglio no.
  //
  // In ONPREM il perimetro NON è esprimibile nella query — `A_Product` non ha l'elemento `Plant`,
  // ed è la ragione per cui quel ramo legge per chiave. Quindi la difesa è tutta qui: o c'è almeno
  // un plant in perimetro, o non si legge niente. Un perimetro NON vuoto ma che non contiene il
  // plant del materiale chiesto resta indistinguibile su quel canale: è un limite del modello
  // storico, non di questa guardia.
  //
  // NON RENDE UNA MAPPA VUOTA IN SILENZIO: si dichiara in `failed`, o si leggerebbe come «quei
  // materiali non esistono».
  // ================================================================
  if (!wanted.length) {
    return {
      byProduct: new Map(),
      calls: 0,
      scope: [],
      failed: [{
        key: 'A_Product',
        message: 'nessun plant nel perimetro: anagrafica non letta'
      }]
    };
  }

  if (src.mode !== 'IS') {
    return fetchProductsByKey(src, list, { columns, onpremColumns, language, chunkSize, clientWhere });
  }

  const byProduct = new Map();
  const failed = [];
  const scope = [];
  let calls = 0;
  if (!list.length) return { byProduct, calls, failed, scope };

  // [PRODUCT-QUERY] La riga che poteva far fallire la lista intera: vedi la testata. Un path
  // mancante in `package.json` o una connessione che non si costruisce sono un guasto di
  // configurazione — riguardano TUTTI i plant, non uno — e come tali si dichiarano una volta sola,
  // senza plant.
  let qsrc;
  try {
    qsrc = await querySource();
  } catch (e) {
    const text = `sorgente della query non disponibile: ${e.message}`;
    console.error(`>>> [PRODUCT-QUERY] ${text} — nessuna anagrafica letta per ${wanted.join(', ')}`);
    failed.push({ key: 'A_Product', message: text });
    for (const plant of wanted) {
      scope.push({ plant, readOk: false, complete: false, text, materials: 0 });
    }
    return { byProduct, calls, failed, scope };
  }

  const readOne = fresh
    ? (plant) => readProductRows(qsrc, plant, { columns: PRODUCT_QUERY_SELECT, deadlineMs })
    : (plant) => loadProductRowsOutcome(qsrc, plant, { columns: PRODUCT_QUERY_SELECT, deadlineMs });

  const reads = await Promise.all(wanted.map(async (plant) => {
    try {
      return await readOne(plant);
    } catch (e) {
      // Il lettore non lancia per una pagina caduta: se si arriva qui è successo qualcos'altro
      // (la sorgente non si è connessa, il modello non ha l'entity). Resta un plant non letto.
      return {
        plant, byProduct: new Map(), readOk: false, complete: false,
        text: `lettura fallita: ${e.message}`, error: e.message, materials: 0
      };
    }
  }));

  const asked = new Set(list);
  for (const read of reads) {
    calls++;
    scope.push({
      plant: read.plant, readOk: read.readOk, complete: read.complete,
      text: read.text, materials: read.materials
    });
    if (!read.complete) {
      // `plant` viaggia accanto alla chiave perché ora il guasto HA un plant: il job lo mette nella
      // riga di recap, e chi legge l'allegato del proprio stabilimento vede il proprio guasto.
      failed.push({
        key: `A_Product(plant ${read.plant})`,
        plant: read.plant,
        message: `${read.text}${read.error ? ` — ${read.error}` : ''}`
      });
    }
    for (const [product, row] of read.byProduct) {
      if (!asked.has(product) || byProduct.has(product)) continue;
      byProduct.set(product, { ...row });
    }
  }

  const missing = list.filter(p => !byProduct.has(p));
  if (missing.length) {
    const shown = missing.slice(0, 10);
    const text = `${missing.length} materiali su ${list.length} non trovati nell'anagrafica dei plant `
      + `letti (${wanted.join(', ')}): ${shown.join(', ')}${missing.length > shown.length ? ', …' : ''}`;
    console.warn(`>>> [PRODUCT-QUERY] ${text}`);
    // Se ogni plant è stato letto per intero, questa assenza NON ha una spiegazione a monte: un
    // materiale che ha una riga product-plant e non ha un'anagrafica è un difetto del dato o della
    // sorgente, e a valle diventa una riga che sparisce dalla lista.
    if (reads.every(r => r.complete)) {
      failed.push({ key: 'A_Product', message: text });
    }
  }

  // [PRODUCT-QUERY] LA RIGA CHE CHIUDE IL CONTO. Le righe che ci sono già raccontano ognuna un
  // pezzo — una per pagina (`[IS-SOURCE] … ESITO OK`) e una per plant (`[PRODUCT-ROWS]`) — ma il
  // totale andava ricostruito sommandole a mano, ed è proprio il numero che si vuole leggere in
  // `cf logs` dopo un rilascio: quanti materiali sono stati risolti, su quanti chiesti.
  console.log(`>>> [PRODUCT-QUERY] anagrafica: ${wanted.length} plant `
    + `(${scope.map(s => `${s.plant}: ${s.materials || 0}`).join(', ')}), `
    + `${byProduct.size} materiali risolti su ${list.length} chiesti, ${calls} letture`
    + (failed.length ? `, ${failed.length} dichiarate KO` : ''));

  return { byProduct, calls, failed, scope };
}

/**
 * [PRODUCT-QUERY] «Aggiorna» deve aggiornare ENTRAMBE le letture del plant. Sta qui e non sui due
 * moduli perché chi preme quel tasto non deve sapere che le letture sono due.
 */
function invalidatePlantReads(plant) {
  return invalidateProductRows(plant);
}

module.exports = productSource;
module.exports.ROUTES = ROUTES;
module.exports.PRODUCT_SELECT = PRODUCT_SELECT;
module.exports.UNAVAILABLE_IN_IS = UNAVAILABLE_IN_IS;
module.exports.fetchProductsByKey = fetchProductsByKey;
module.exports.fetchDescriptions = fetchDescriptions;
// [PRODUCT-QUERY] feature 0040
module.exports.PRODUCT_QUERY_SELECT = PRODUCT_QUERY_SELECT;
module.exports.productQuerySource = productQuerySource;
module.exports.fetchProductsForPlants = fetchProductsForPlants;
module.exports.invalidatePlantReads = invalidatePlantReads;

/**
 * Material visibility / classification (per-plant customizing).
 *
 * Decides, from the ZMatCategory + ZMatCategoryCond customizing, whether a
 * material (for a given plant) is VISIBLE in the dashboard and ELIGIBLE to be
 * sent to Plex, and which Plex "part type" it gets.
 *
 * Semantics:
 *   - a material is visible/sendable if it satisfies AT LEAST ONE active
 *     category (OR across categories);
 *   - a category is satisfied when ALL its conditions match (AND) — reuses
 *     evaluateRule() from plexPartMapper.js (a category == a rule with
 *     Conditions[]);
 *   - NO active category for a plant => ALL materials are taken;
 *   - the first matching NORMAL category (by Sequence) yields the PlexPartType;
 *   - [W1-01] if no normal category matches, the plant's CATCH-ALL category
 *     (IsCatchAll) takes the material and gives it its PlexPartType. It is
 *     evaluated LAST BY CONSTRUCTION: its own Sequence is never read (DEC-61).
 *     No catch-all => the material stays out of scope, as before.
 *
 * Consumed by:
 *   - srv/cat-service.js  loadConfiguredProducts (dashboard READ + Send-all)
 *   - srv/cat-service.js  buildPlexPartRequestBody (Plex part-type on send)
 *   - srv/jobs/syncMaterialsToPlex.js (batch sync)
 *
 * The SAP field keys produced by extractSapFields() MUST match the FieldName
 * values in the ZMatFieldVH value help (db/data CSV):
 *   ProductType (MTART), ProcurementType (BESKZ), ProcurementSubType (SOBSL),
 *   ProductionSupervisor (FEVOR), MRPType, ProfitCenter, PurchasingGroup, ProfileCode (MMSTA).
 *
 * [MAT-SAP-FIELDS] Questo «MUST» era una convenzione scritta in un commento, e per tre campi non
 * era vera: vedi MAT_SAP_FIELDS in srv/lib/plexPartMapper.js e test/matSapFields.test.js, che
 * ora legano il seed al runtime dove prima c'era solo la buona volontà.
 */

'use strict';

const { evaluateRule } = require('./plexPartMapper');
// [IS-SOURCE] $select esplicito di A_ProductPlant in modalità IS (feature 0013).
// [W1-26] IS_FIELD_ALIASES: i campi PORTANTI da cui, su quel canale, escono SOBSL e FEVOR.
const { productPlantSelect, IS_FIELD_ALIASES } = require('./isQueryShape');
// [W1-02] Regole pure della classe materiale: qui serve solo l'indicizzazione della value help.
// [CATCHALL-RENDER] `flag` legge un Boolean per FORMA e non per verita' JavaScript: la stessa
// funzione che gia' regge IsActive delle value help. Qui serve a IsCatchAll, che decide il
// part type spedito a Plex.
const { indexPartTypes, flag } = require('./materialClass');
// [PLEX-PART-CODES] Regole pure dei codici Plex (feature 0022): qui servono solo l'indicizzazione
// del customizing dei codici tipologia e la lettura della riga di stato.
const { indexTypeCodes, statusFromRow } = require('./plexPartCodes');

const NS = 'avvaleplm.marsplm.sap2plex';

/**
 * I campi SAP che in `ONPREM` vivono su navigazioni figlie di `A_ProductPlant` e non sulla riga
 * piatta, quindi richiedono un `$expand`.
 *
 * [W1-26] Il significato è ORA SOLO QUESTO. Prima l'insieme faceva doppio servizio — «serve un
 * expand» e «su IS non c'è» — perché le due cose coincidevano. Non coincidono più: su IS i due
 * valori arrivano dai campi portanti di `IS_FIELD_ALIASES`, senza alcuna navigazione. Chi vuole
 * sapere cosa il canale NON fornisce deve guardare `UNAVAILABLE_IN_IS` (productSource.js), non
 * questo insieme.
 */
const NAV_FIELDS = new Set(['ProcurementSubType', 'ProductionSupervisor']);

/** First element of a to-many nav result (or the object itself for a to-one). */
function firstNav(v) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Flatten an A_ProductPlant row into the { FieldName: value } map used for condition matching.
 *
 * Due rami, e il canale decide quale:
 *
 *   - `mode === 'IS'`  -> [W1-26] SOBSL e FEVOR escono dai campi PORTANTI di `IS_FIELD_ALIASES`
 *                         (`ProductCFOPCategory` e `StockDeterminationGroup`), che sono flat e
 *                         sempre nel `$select`. Nessuna navigazione: su questo canale non ne
 *                         esiste una da espandere.
 *   - qualunque altro, `undefined` COMPRESO -> il ramo storico: i due valori vengono dalle
 *                         navigazioni espanse (to_ProductSupplyPlanning / to_ProductWorkScheduling),
 *                         presenti solo se la query le ha espanse (vedi needsNav).
 *
 * IL DEFAULT È ONPREM, E NON È UN DETTAGLIO. In `ONPREM` `StockDeterminationGroup` è davvero il
 * gruppo di determinazione stock e `ProductCFOPCategory` è davvero la categoria CFOP: un
 * chiamante che dimenticasse di passare il canale, con l'alias applicato per default,
 * classificherebbe i materiali su due dati che non c'entrano niente — e lo farebbe in silenzio,
 * perché entrambi i campi sono spesso valorizzati. Chi non dichiara il canale ottiene il
 * comportamento di sempre. Vedi DEC-65.
 */
/**
 * [MAT-VIS-UNEVAL] I campi che una riga A_ProductPlant NON PORTA, e non portera' mai.
 *
 * `ProductType` (MTART) sta su MARA, cioe' su A_Product; A_ProductPlant e' MARC. I suoi 48 campi
 * flat non lo contengono — lo dice gia' isQueryShape.js, che per questo lo esclude dal $select su
 * IS. NON e' una lacuna del canale Integration Suite: manca anche in ONPREM, dove la query e' un
 * select-all su quella stessa entity.
 *
 * Finche' `extractSapFields` lo leggeva da `pp` senza dirlo, il valore era `undefined`,
 * `evaluateCondition` lo normalizzava a `''` e ogni condizione EQ/IN su MTART risultava
 * SEMPRE FALSA. Una categoria costruita come la BBP la descrive («MTART ZPF o ZIBR + BESKZ E»)
 * non agganciava nessun materiale, e senza ripiego l'intero perimetro spariva — in silenzio,
 * perche' «non valutabile» e «non soddisfatta» collassavano nello stesso `false`.
 *
 * Sul percorso di INVIO il campo c'e', perche' `fetchMaterialSapFields` lo legge da A_Product:
 * lista e invio classificano quindi su insiemi di campi diversi, ed e' la lista quella cieca.
 */
const NOT_ON_PRODUCT_PLANT = Object.freeze(['ProductType']);

/**
 * [POST-GET-CLASSIFY] I campi della riga plant PIU' quelli che solo A_Product porta.
 *
 * La classificazione fatta sulla sola riga product-plant e' CIECA su MTART, e con un ripiego
 * configurato non lo si vede nemmeno: il ripiego prende il materiale prima che il ramo «criterio
 * non valutabile» venga raggiunto, e un ZPF esce come Component invece che come Finished Product.
 *
 * La risposta e' stata spostare la CLASSIFICAZIONE dopo la lettura di A_Product, dove il dato c'e'
 * gia'. Questo e' il punto in cui i due insiemi si uniscono, ed e' l'unico: chi classifica dopo aver
 * letto A_Product passa di qui.
 *
 * [PRODUCT-QUERY] Il motivo per cui la lettura non si poteva ANTICIPARE — «su Integration Suite
 * A_Product non ha un _QUERYGET, quindi una lista di materiali sono N letture per chiave» — e'
 * caduto con la 0040: l'indirizzo esiste e il plant intero costa una query. Il disegno pero' non
 * cambia, ed e' bene sapere perche': la classificazione ha comunque bisogno delle DUE letture unite,
 * e farla prima significherebbe farla su meta' dei campi. Il momento giusto resta questo.
 *
 * `detailRow` e' una riga di A_Product (o l'oggetto dettaglio che ne deriva). I campi assenti non
 * sovrascrivono: `undefined` su MTART deve restare `undefined`, perche' e' cosi' che il ramo
 * «non valutabile» riconosce di non poter decidere.
 *
 * @param {object} plantFields da extractSapFields(rigaA_ProductPlant, mode)
 * @param {object} detailRow   riga A_Product; puo' essere assente (lettura fallita)
 * @returns {object} i campi per classifyMaterial
 */
function mergeProductFields(plantFields, detailRow) {
  const out = { ...(plantFields || {}) };
  if (!detailRow) return out;
  for (const f of NOT_ON_PRODUCT_PLANT) {
    if (detailRow[f] !== undefined && detailRow[f] !== null) out[f] = detailRow[f];
  }
  return out;
}

/**
 * [POST-GET-CLASSIFY] Le categorie di questo plant dipendono da un campo che la riga plant non
 * porta? Se si', la classificazione fatta sulla sola riga plant NON e' attendibile e va rifatta
 * dopo la lettura di A_Product.
 */
function needsProductDetails(categories) {
  return fieldsUsedBy(categories, NOT_ON_PRODUCT_PLANT).length > 0;
}

function extractSapFields(pp, mode) {
  if (!pp) return {};
  const common = {
    // [MAT-VIS-UNEVAL] Resta letto: sulle righe che per qualunque ragione lo portassero il valore
    // e' quello vero. Cio' che cambia e' come si legge la sua ASSENZA — vedi classifyMaterial.
    ProductType: pp.ProductType,
    ProcurementType: pp.ProcurementType,
    MRPType: pp.MRPType,
    ProfitCenter: pp.ProfitCenter,
    PurchasingGroup: pp.PurchasingGroup,
    // [MAT-SAP-FIELDS] MMSTA: campo PIATTO su A_ProductPlant, quindi né in NAV_FIELDS (nessun
    // expand da chiedere in ONPREM) né in NOT_ON_PRODUCT_PLANT (c'è, non è un buco come MTART).
    ProfileCode: pp.ProfileCode
  };
  if (String(mode || '').toUpperCase() === 'IS') {
    return {
      ...common,
      ProcurementSubType: pp[IS_FIELD_ALIASES.ProcurementSubType],
      ProductionSupervisor: pp[IS_FIELD_ALIASES.ProductionSupervisor]
    };
  }
  const sp = firstNav(pp.to_ProductSupplyPlanning);
  const ws = firstNav(pp.to_ProductWorkScheduling);
  return {
    ...common,
    ProcurementSubType: sp ? sp.ProcurementSubType : undefined,
    ProductionSupervisor: ws ? ws.ProductionSupervisor : undefined
  };
}

/**
 * Whether any condition in the given categories references a navigation field (SOBSL/FEVOR),
 * i.e. whether the ONPREM query needs the two `$expand`.
 *
 * Passa da `_asConditions` e non da `c.Conditions || []`: i due chiamanti la invocano FUORI dal
 * proprio try/catch, quindi un `TypeError` qui non degrada una lettura — spegne la lista
 * materiali della dashboard e il job MAT_SYNC. Vedi il commento su `_selectCategories`.
 */
function needsNav(categories) {
  return fieldsUsedBy(categories, NAV_FIELDS).length > 0;
}

/**
 * Quali dei `fields` indicati compaiono nelle condizioni delle `categories` (senza duplicati).
 *
 * [W1-26] Un solo posto per una domanda che il progetto si fa in tre punti: il gate dell'avviso
 * per plant nella lista materiali, la nota di perimetro incompleto nel recap del job, e la
 * function `matCategoryFieldAvailability` che alimenta il MessageStrip della scheda «Categorie
 * Materiali». I tre devono rispondere allo stesso modo, o la schermata dice una cosa e il log
 * un'altra.
 *
 * @param {Array} categories  categorie con Conditions[] (anche nella forma stringa `'[]'`)
 * @param {Iterable<string>} fields  i nomi da cercare (array o Set)
 * @returns {string[]}
 */
function fieldsUsedBy(categories, fields) {
  const wanted = fields instanceof Set ? fields : new Set(fields || []);
  if (wanted.size === 0) return [];
  const hit = new Set();
  for (const c of categories || []) {
    for (const cond of _asConditions(c && c.Conditions)) {
      if (wanted.has(cond.SapField)) hit.add(cond.SapField);
    }
  }
  return [...hit];
}

/**
 * Columns for the A_ProductPlant SELECT, per active channel (feature 0013, TDD §3.6.4 M1).
 *
 *   mode 'IS'     -> the EXPLICIT list of the 9 flat fields the consumers actually read.
 *                    No '*', no navigation: [W1-26] SOBSL/FEVOR arrivano dai due campi PORTANTI
 *                    di IS_FIELD_ALIASES, che sono flat e sono nell'elenco. Su questo canale non
 *                    esiste alcuna navigazione da espandere, ed è il motivo per cui i due valori
 *                    viaggiano su campi altrui. Chi li rilegge deve passare da
 *                    `extractSapFields(pp, 'IS')`: l'alias vive lì, non nei chiamanti.
 *   mode 'ONPREM' -> the callback in use today: '*' plus the two child expands.
 *
 * Beware: dropping the two expands in ONPREM too would look like a cleanup and would BE a
 * regression. Those expands are what makes ProcurementSubType / ProductionSupervisor
 * evaluable on the historical channel, i.e. what decides which materials are in scope for a
 * customer that has not migrated (TD-5, BR-09).
 *
 * Usage: SELECT.from(A_ProductPlant).columns(productPlantColumns(needNav, src.mode))
 * (cds.ql accepts both a projection callback and an array of column names).
 */
function productPlantColumns(needNav, mode) {
  if (String(mode || '').toUpperCase() === 'IS') return productPlantSelect(needNav);
  return (p) => {
    p('*');
    if (needNav) {
      p.to_ProductSupplyPlanning(sp => { sp('ProcurementSubType'); });
      p.to_ProductWorkScheduling(ws => { ws('ProductionSupervisor'); });
    }
  };
}

/**
 * Deep SELECT of ZMatCategory (+ Conditions), filtered by an optional where clause.
 *
 * L'expand di una composizione VUOTA non torna `[]`: su SQLite arriva la STRINGA `'[]'`, che
 * e' truthy e non ha `.some`. Prima della W1-01 il caso era teorico — una categoria senza
 * condizioni non aggancia nulla (DEC-27), quindi nessuno ne creava — ma la categoria di
 * RIPIEGO e' per costruzione senza condizioni, e senza questa normalizzazione `needsNav`
 * lanciava `TypeError` FUORI dal try/catch dei due chiamanti, spegnendo la lista materiali
 * della dashboard e il job MAT_SYNC per ogni plant con un ripiego configurato.
 *
 * Si normalizza QUI, che e' il punto unico da cui le categorie entrano nel processo: cosi'
 * `needsNav`, `evaluateRule` e chiunque arrivi dopo vedono sempre un array.
 */
async function _selectCategories(db, where) {
  const { ZMatCategory } = db.entities(NS);
  // La proiezione e' ESPLICITA: un campo non elencato qui non arriva mai al classificatore.
  // `IsCatchAll` fa parte della semantica di classifyMaterial, non della sola UI.
  let q = SELECT.from(ZMatCategory).columns(m => {
    m.Plant, m.CategoryName, m.PlexPartType, m.Sequence, m.IsCatchAll,
    m.Conditions(c => { c.SapField, c.Operator, c.Value });
  });
  if (where) q = q.where(where);
  const rows = await db.run(q);
  for (const r of rows) r.Conditions = _asConditions(r.Conditions);
  return rows;
}

/** `Conditions` come array, qualunque forma abbia restituito il driver (array, `'[]'`, JSON, null). */
function _asConditions(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Load all ACTIVE categories, grouped by plant.
 *
 * [MAT-SCOPE] LA MAPPA VUOTA HA DUE CAUSE, E IL CHIAMANTE DEVE POTERLE DISTINGUERE. Con la sola
 * mappa, una lettura CADUTA e' indistinguibile da «nessun plant ha categorie»: entrambe rendono
 * `cats.length === 0`, cioe' il ramo `NO_CATEGORIES` — perimetro non configurato, tutto visibile e
 * tutto inviabile SENZA `type`. Cioe' esattamente l'`HTTP 400` che la 0050 chiude, con un'altra
 * causa a monte. Il verdetto della lettura viaggia quindi accanto alla mappa.
 *
 * `categoriesOk` si legge con `=== false`, mai per verita' JavaScript: un chiamante che non lo
 * passa non deve ottenere «lettura caduta».
 *
 * @returns {Promise<{byPlant: Map<string, Array>, ok: boolean, error: string|null}>}
 */
async function loadCategoryConfigOutcome(db) {
  const byPlant = new Map();
  try {
    const rows = await _selectCategories(db, { IsActive: true });
    for (const r of rows) {
      if (!byPlant.has(r.Plant)) byPlant.set(r.Plant, []);
      byPlant.get(r.Plant).push(r);
    }
    return { byPlant, ok: true, error: null };
  } catch (e) {
    console.warn(`>>> [MAT-VIS] load category config failed: ${e.message}`);
    return { byPlant, ok: false, error: e.message };
  }
}

// [MAT-SCOPE] `loadCategoryConfig` — la sola mappa, senza verdetto — E' USCITA con la 0050.
//
// I suoi due chiamanti (la lista del cockpit e il job MAT_SYNC) DECIDONO UN PERIMETRO, e per farlo
// devono sapere se la lettura e' riuscita: una mappa vuota e' indistinguibile da «nessun plant ha
// categorie», cioe' dal ramo che prende tutto e invia SENZA `type` — l'HTTP 400 da cui la feature
// nasce, con un'altra causa a monte. Convertiti quei due, non restava nessun chiamante.
//
// Non e' stata lasciata «per comodita' di chi non decide niente»: una funzione senza chiamanti
// continua a compilare, il prossimo lettore la trova e la usa, e quel giorno il verdetto torna a
// perdersi in silenzio. Chi legge le categorie senza deciderci un perimetro usi
// `loadCategoryConfigOutcome` e ignori `ok`: e' una scelta che si vede.

/**
 * Load the ACTIVE categories of a single plant (Conditions expanded), col verdetto della lettura.
 *
 * [MAT-SCOPE] Stessa ragione di `loadCategoryConfigOutcome`, e qui pesa di piu': l'unico chiamante
 * e' `buildPlexPartRequestBody`, cioe' il punto da cui si SCRIVE su Plex.
 *
 * @returns {Promise<{categories: Array, ok: boolean, error: string|null}>}
 */
async function loadPlantCategoriesOutcome(plant, db) {
  if (!plant) return { categories: [], ok: true, error: null };
  try {
    return { categories: await _selectCategories(db, { Plant: plant, IsActive: true }), ok: true, error: null };
  } catch (e) {
    console.warn(`>>> [MAT-VIS] load categories for plant ${plant} failed: ${e.message}`);
    return { categories: [], ok: false, error: e.message };
  }
}

/** Load the ACTIVE categories of a single plant (Conditions expanded). */
async function loadPlantCategories(plant, db) {
  return (await loadPlantCategoriesOutcome(plant, db)).categories;
}

/**
 * [MAT-SCOPE] I plant che scrivono `type` A MANO su ZPlexFieldMap (feature 0050).
 *
 * PERCHE' ESISTE. Serve a un solo scopo, e senza di esso il verdetto `NO_PART_TYPE` di
 * matScopeRules.js sarebbe una REGRESSIONE SECCA: `type` non e' fra i `LOCKED_FIELDS` di
 * plexPartMapper.js — solo `number`, `name` e `description` lo sono — quindi un plant puo' mappare
 * la tipologia a mano e riceverla su Plex senza che nessuna categoria porti una classe (0004
 * RB-17). Escludere quei materiali dalla lista li farebbe sparire tutti insieme, in silenzio, da
 * plant configurati benissimo.
 *
 * E' un'approssimazione PER PLANT, non per materiale, e la direzione e' quella sicura: la lista
 * puo' mostrare un materiale che l'invio poi rifiuta (un mapping CONDIZIONATO che per quel
 * materiale non produce niente — limite dichiarato), mai nascondere uno che l'invio accetterebbe.
 * Il verdetto ESATTO, su `payload.type`, lo prende `buildPlexPartRequestBody`.
 *
 * STA IN `srv/lib/` E NON IN `cat-service.js`, che e' una closure: la vogliono il cockpit E il job
 * `MAT_SYNC`, e una seconda copia dentro il job darebbe un perimetro a schermo diverso da quello
 * inviato — cioe' il difetto che la 0050 esiste per chiudere, spostato di un passo.
 *
 * Una lettura caduta rende un insieme VUOTO e non blocca niente: sarebbe la lista intera a
 * sparire, e questo customizing e' un'eccezione, non il perimetro.
 *
 * @returns {Promise<Set<string>>} i codici plant con un mapping esplicito di `type`
 */
async function loadTypeMappedPlants(db) {
  const plants = new Set();
  try {
    const { ZPlexFieldMap } = db.entities(NS);
    const rows = await db.run(SELECT.from(ZPlexFieldMap).columns('Plant', 'PlexField'));
    for (const r of rows || []) {
      if (String(r.PlexField || '').trim() === 'type') plants.add(String(r.Plant || '').trim());
    }
  } catch (e) {
    console.warn(`>>> [MAT-SCOPE] mapping campi Plex non letto (${e.message}): nessun plant`
      + ' considerato «tipologia da mapping». Il verdetto sull\'invio resta esatto.');
  }
  return plants;
}

// ================================================================
// [W1-02] VALUE HELP DELLE CLASSI MATERIALE (ZPlexPartTypeVH)
// ================================================================
// Sta qui e non in materialClass.js perche' quello e' un modulo PURO: le regole non toccano il
// database. Sta qui e non altrove perche' e' la stessa area di customizing delle categorie, ed
// e' gia' il modulo da cui cat-service.js importa loadPlantCategories.
//
// Cache module-scoped con TTL, sul modello di activePlantsCache e routingHeaderCache in
// cat-service.js. Qui il TTL e' generoso — la tabella e' un SEED, cambia solo al deploy — e
// serve soprattutto a non rileggere cinque righe a ogni materiale di un invio massivo.
let partTypeCache = null; // { at, index }
const PART_TYPE_VH_TTL_MS = Number(process.env.PART_TYPE_VH_TTL_MS || 5 * 60 * 1000);

/**
 * L'indice delle classi materiale, per plexValueOf/classInfo di srv/lib/materialClass.js.
 *
 * FAIL-OPEN come loadCategoryConfig: su errore si logga e si restituisce un indice VUOTO, non
 * si lancia. Un indice vuoto non significa «nessuna classe»: significa che plexValueOf rende
 * la classe verbatim, cioe' il comportamento che il progetto aveva prima della W1-02. Una
 * value help illeggibile non deve poter svuotare `payload.type`.
 *
 * @returns {Promise<Map<string, object>>} classe -> riga di ZPlexPartTypeVH
 */
async function loadPartTypeIndex(db) {
  if (partTypeCache && (Date.now() - partTypeCache.at) < PART_TYPE_VH_TTL_MS) {
    return partTypeCache.index;
  }
  let index = new Map();
  try {
    const { ZPlexPartTypeVH } = db.entities(NS);
    // Proiezione ESPLICITA: un campo non elencato qui non arriva mai a classInfo().
    const rows = await db.run(SELECT.from(ZPlexPartTypeVH).columns(
      'PartType', 'Label', 'PlexValue', 'IsSemifinished', 'IsProducedInPlex', 'RequiresReceivingOp'
    ));
    index = indexPartTypes(rows);
    partTypeCache = { at: Date.now(), index };
  } catch (e) {
    // Volutamente NON si mette in cache un esito fallito: il prossimo invio riprova.
    console.warn(`>>> [W1-02] load part type value help failed: ${e.message}`);
  }
  return index;
}

// ================================================================
// [PLEX-PART-CODES] CODICI DEL TENANT PLEX, PER PLANT (feature 0022)
// ================================================================
// Sta qui per la stessa ragione del blocco W1-02 qui sopra: srv/lib/plexPartCodes.js e' un modulo
// PURO e non tocca il database, e questa e' la stessa area di customizing.
//
// A differenza della value help delle classi, queste due tabelle sono PER PLANT e sono scritte
// dalla UI: la cache e' quindi chiavata sul plant e viene INVALIDATA dagli handler
// after CREATE/UPDATE/DELETE di cat-service.js, non solo dal TTL — altrimenti un codice appena
// salvato non partirebbe per cinque minuti.
let partCodeCache = new Map();   // plant -> { at, index }
let partStatusCache = new Map(); // plant -> { at, status }
const PLEX_PART_CODE_TTL_MS = Number(process.env.PLEX_PART_CODE_TTL_MS || 5 * 60 * 1000);

/** Svuota le cache dei codici Plex: un plant solo, o tutte se `plant` non e' dato. */
function invalidatePlexPartCodeCache(plant) {
  if (plant) {
    partCodeCache.delete(plant);
    partStatusCache.delete(plant);
    return;
  }
  partCodeCache = new Map();
  partStatusCache = new Map();
}

/**
 * L'indice tipologia Plex -> codice del tenant, per un plant.
 *
 * FAIL-OPEN come loadPartTypeIndex: su errore si logga e si restituisce un indice VUOTO, non si
 * lancia. Indice vuoto NON significa «non mandare niente»: significa che typeCodeOf rende `null`
 * e `payload.type` resta la stringa, cioe' il comportamento che il progetto aveva prima della
 * 0022. Un customizing illeggibile non deve poter svuotare `payload.type` ne' fermare un invio.
 *
 * @returns {Promise<Map<string, string>>} tipologia -> codice
 */
async function loadPartTypeCodeIndex(plant, db) {
  if (!plant) return new Map();
  const hit = partCodeCache.get(plant);
  if (hit && (Date.now() - hit.at) < PLEX_PART_CODE_TTL_MS) return hit.index;

  let index = new Map();
  try {
    const { ZPlexPartTypeCode } = db.entities(NS);
    // Proiezione ESPLICITA, come sopra: un campo non elencato qui non arriva mai alle regole.
    const rows = await db.run(SELECT.from(ZPlexPartTypeCode)
      .columns('PlexTypeValue', 'PlexTypeCode', 'IsActive')
      .where({ Plant: plant }));
    index = indexTypeCodes(rows);
    partCodeCache.set(plant, { at: Date.now(), index });
  } catch (e) {
    // Volutamente NON si mette in cache un esito fallito: il prossimo invio riprova.
    console.warn(`>>> [PLEX-PART-CODES] load part type codes for plant ${plant} failed: ${e.message}`);
  }
  return index;
}

/**
 * Lo stato di nascita configurato per il plant, o `null`.
 *
 * `null` e' un esito NORMALE e non un errore: significa `status` assente dal payload, che e' cio'
 * che il progetto fa oggi. Fail-open allo stesso modo — un errore di lettura non deve poter
 * fermare l'invio di una part.
 *
 * @returns {Promise<{code: string, label: string}|null>}
 */
async function loadPartStatusConfig(plant, db) {
  if (!plant) return null;
  const hit = partStatusCache.get(plant);
  if (hit && (Date.now() - hit.at) < PLEX_PART_CODE_TTL_MS) return hit.status;

  let status = null;
  try {
    const { ZPlexPartStatusConfig } = db.entities(NS);
    // UNA riga per plant (@assert.unique su Plant): SELECT.one, non una lista da filtrare.
    const row = await db.run(SELECT.one.from(ZPlexPartStatusConfig)
      .columns('PlexStatusCode', 'PlexStatusLabel', 'IsActive')
      .where({ Plant: plant }));
    status = statusFromRow(row);
    partStatusCache.set(plant, { at: Date.now(), status });
  } catch (e) {
    console.warn(`>>> [PLEX-PART-CODES] load part status for plant ${plant} failed: ${e.message}`);
  }
  return status;
}

/**
 * Classify a material against a plant's categories.
 *
 * [W1-01] Two-step: the NORMAL categories first (OR across them, first match by Sequence),
 * then — only if none matched — the plant's CATCH-ALL category. The catch-all is last BY
 * CONSTRUCTION and not by Sequence: making it a matter of numbering would mean re-checking
 * every normal category created afterwards (DEC-61).
 *
 * A catch-all is expected to have NO conditions (rejected on write, validateMatCategory) and
 * they are not evaluated here either: a catch-all takes whatever is left, by definition. That
 * is why `evaluateRule` stays untouched — a rule with no conditions still never matches
 * (DEC-27).
 *
 * [MAT-VIS-UNEVAL] Terzo passo, in coda: se nessuna categoria aggancia e almeno una di quelle
 * provate dipende da un campo che la riga NON PUO' portare (`NOT_ON_PRODUCT_PLANT`), il materiale
 * resta VISIBILE invece di sparire, con `unevaluable: true`.
 *
 * Una condizione che non si puo' valutare non e' una condizione non soddisfatta: e' una condizione
 * di cui non si sa niente, e le due cose collassavano nello stesso `false`. Su un customizing che
 * governa cio' che si VEDE la regola del progetto e' il fail-OPEN — «mostrare qualcosa in piu' e'
 * un fastidio che si vede, nascondere tutto e' una sparizione silenziosa» — e questo ramo la
 * applica dove mancava.
 *
 * Il ripiego esplicito, se c'e', vince comunque su questo: e' una scelta di configurazione, questo
 * e' un rattoppo su un'informazione mancante. E se le categorie sono TUTTE valutabili e nessuna
 * aggancia, il materiale resta invisibile come prima: quello e' un perimetro vero, deciso da
 * criteri veri.
 *
 * @param {object} sapFields  flat { FieldName: value } map (see extractSapFields)
 * @param {Array}  categories the plant's active categories (Conditions expanded)
 * @returns {{visible: boolean, plexPartType: string|null, catchAll?: boolean, unevaluable?: string[]}}
 *          `catchAll: true` marks the material taken by the fallback: it is what lets the
 *          dashboard log and the job recap DECLARE how many materials went out on it.
 *          `unevaluable` names the fields that could not be evaluated, for the same reason.
 */
function classifyMaterial(sapFields, categories) {
  if (!categories || categories.length === 0) {
    return { visible: true, plexPartType: null }; // no config => take all
  }
  // [MULTI-CATCHALL] Al massimo UNO attivo per plant, e la scrittura lo impone
  // (`mcCatchAllDuplicate` in validateMatCategory). Righe salvate prima di quel controllo pero'
  // esistono: con due o piu' ripieghi, `find()` restituirebbe quello che il database rende per
  // primo, e il part type spedito a Plex dipenderebbe dall'ordine di una SELECT.
  //
  // Si sceglie quindi in modo STABILE, per CategoryName. Non legittima la configurazione doppia —
  // resta vietata — ma rende l'esito riproducibile mentre qualcuno la corregge, e il marcatore
  // `ambiguousCatchAll` permette al chiamante di dirlo.
  // [CATCHALL-RENDER] Si legge con `flag`, non con la verita' JavaScript.
  //
  // Su SQLite CAP rende i Boolean come 1/0 e su HANA come true/false: sotto `filter(c => c.IsCatchAll)`
  // funzionano entrambi, ed e' per questo che il difetto non si e' mai visto. Ma una QUALUNQUE altra
  // forma — la stringa 'false', che e' VERA — ribalterebbe l'intero motore in silenzio: `catchAllRows`
  // prenderebbe TUTTE le categorie e `normal` resterebbe VUOTA, quindi nessun criterio verrebbe mai
  // valutato e ogni materiale prenderebbe il part type del primo ripiego. Non e' teorico: questo
  // codebase ha gia' visto il livello dati rendere forme inattese — l'expand di una composizione
  // vuota torna la STRINGA '[]' e non `[]` (DEC-61).
  //
  // Qui sbagliare costa piu' che altrove: e' cio' che finisce in `payload.type` verso Plex.
  const catchAllRows = categories.filter(c => flag(c.IsCatchAll));
  const catchAll = catchAllRows.length > 1
    ? [...catchAllRows].sort((a, b) =>
      String(a.CategoryName || '').localeCompare(String(b.CategoryName || '')))[0]
    : catchAllRows[0];
  const normal = categories
    .filter(c => !flag(c.IsCatchAll))
    .sort((a, b) => (a.Sequence || 0) - (b.Sequence || 0));

  const hit = normal.find(c => evaluateRule(c, sapFields)); // first match wins (by Sequence)
  if (hit) return { visible: true, plexPartType: hit.PlexPartType || null };
  if (catchAll) {
    return {
      visible: true,
      plexPartType: catchAll.PlexPartType || null,
      catchAll: true,
      // [MULTI-CATCHALL] Presente solo quando i ripieghi sono piu' d'uno: dice quale ha vinto e
      // quanti erano, cosi' la lista puo' dichiararlo invece di lasciarlo scoprire.
      ...(catchAllRows.length > 1
        ? { ambiguousCatchAll: catchAllRows.map(c => c.CategoryName || '(senza nome)') }
        : {})
    };
  }

  // [MAT-VIS-UNEVAL] Nessuna aggancia: prima di dichiarare il materiale fuori perimetro si guarda
  // se le categorie provate potevano essere valutate del tutto.
  //
  // Il criterio e' che il valore MANCHI DAVVERO su QUESTA riga, non che la categoria citi il
  // campo: se il materiale porta `ProductType: 'ZROH'` e la categoria chiede `ZPF`, quello e' un
  // no vero e il materiale resta fuori.
  //
  // [MAT-SCOPE] E la STRINGA VUOTA conta come non consegnato, per questi campi e solo per questi.
  // Altrove nel progetto `''` e' un valore — e' quello che l'operatore BLANK verifica — ma un campo
  // di `NOT_ON_PRODUCT_PLANT` non sta sulla riga product-plant per costruzione: li' `''` non puo'
  // essere un valore vero, puo' solo essere una sorgente che consegna la proprieta' vuota.
  //
  // Non cambia niente oggi: nessun canale la consegna, e su A_Product il valore c'e'. Chiude pero'
  // la premessa su cui poggia TUTTA la feature 0050 — che la prima passata, cieca, sia una
  // SOVRA-approssimazione della seconda. Se un giorno un canale mandasse `ProductType: ''`, senza
  // questa riga il ramo non scatterebbe, la passata cieca diventerebbe fail-CLOSED e il materiale
  // non arriverebbe mai al verdetto definitivo: la potatura pota cio' che ha, non ri-aggiunge cio'
  // che e' gia' sparito.
  const blind = fieldsUsedBy(normal, NOT_ON_PRODUCT_PLANT)
    .filter(f => sapFields === null || sapFields === undefined
      || sapFields[f] === undefined || sapFields[f] === null || String(sapFields[f]).trim() === '');
  if (blind.length) return { visible: true, plexPartType: null, unevaluable: blind };

  return { visible: false, plexPartType: null };
}

module.exports = {
  NOT_ON_PRODUCT_PLANT, // [MAT-VIS-UNEVAL]
  mergeProductFields,   // [POST-GET-CLASSIFY]
  needsProductDetails,  // [POST-GET-CLASSIFY]
  extractSapFields,
  needsNav,
  fieldsUsedBy, // [W1-26]
  productPlantColumns,
  loadCategoryConfigOutcome,  // [MAT-SCOPE]
  loadPlantCategories,
  loadPlantCategoriesOutcome, // [MAT-SCOPE]
  loadTypeMappedPlants,       // [MAT-SCOPE]
  loadPartTypeIndex, // [W1-02]
  // [PLEX-PART-CODES] feature 0022
  loadPartTypeCodeIndex,
  loadPartStatusConfig,
  invalidatePlexPartCodeCache,
  classifyMaterial
};

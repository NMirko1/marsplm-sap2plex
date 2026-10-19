/**
 * [PHANTOM-EXPLODE] Esplosione ricorsiva dei componenti fantasma (feature 0019).
 *
 * COSA FA
 * Prende una lista di componenti e restituisce la stessa lista con ogni FANTASMA sostituito dai
 * suoi componenti di distinta; se un figlio e' a sua volta fantasma si ripete, fino al tetto di
 * profondita' o all'anello. E' l'unico posto in cui si legge la distinta base per esplodere.
 *
 * Le regole verificabili a secco stanno in srv/lib/bomExplodeRules.js e hanno il proprio test.
 * Qui c'e' solo cio' che parla con SAP, con la cache e con il log.
 *
 * I DUE CANALI NON LEGGONO LA STESSA COSA, E NON E' UN'ASIMMETRIA GRATUITA
 *
 *   IS      -> `ExplodeBOM`. Sull'Integration Suite le POSIZIONI di distinta NON HANNO INDIRIZZO:
 *              dei tre indirizzi BOM pubblicati (EndpointFlussiMARS_V1.xlsx righe 17-19) due sono
 *              `MaterialBOM`, che e' la sola TESTATA, e il terzo e' l'esplosione. Quindi
 *              l'esplosione non e' una scelta di comodo: e' l'unica strada esistente.
 *   ONPREM  -> `MaterialBOMItem`. Qui l'entity esiste nel CSN e si legge con una SELECT normale.
 *              `ExplodeBOM` non e' praticabile: e' un Function Import, e il remote service CAP non
 *              lo indirizza come un entity set.
 *
 * IL RICONOSCIMENTO NON PUO' ESSERE LO STESSO SUI DUE CANALI, e va saputo prima di semplificarlo:
 * `MaterialBOMItem` **non ha alcun campo phantom** (verificato sul CSN: ci sono
 * `BillOfMaterialItemCategory` e `SpecialProcurementType`, non `IsPhantomItem`), mentre la
 * struttura dell'esplosione ha tutti e tre. E' per questo che `isPhantom` ha tre riscontri e non
 * uno: su ONPREM il primo non arriva MAI, e affidarsi a quello significherebbe non riconoscere
 * nessun fantasma sul canale storico — senza alcun errore visibile.
 *
 * NON LANCIA MAI VERSO L'ALTO. Un fantasma che non si riesce a esplodere RESTA in elenco cosi'
 * com'e' e produce una nota di attenzione. Farlo sparire sarebbe un buco silenzioso; lasciarlo e'
 * sbagliato ma VISIBILE, e un albero incompleto che si dichiara e' meglio di un albero mutilato
 * che non lo fa. E' la stessa scelta del fail-open dichiarato di `belongsToMaterial`
 * (srv/lib/routingMaterialRules.js:335).
 *
 * PERIMETRO: grep -rn "PHANTOM-EXPLODE".
 */

'use strict';

const cds = require('@sap/cds');
const bomSource = require('./bomSource');
const R = require('./bomExplodeRules');
// [PHANTOM-PARALLEL] Il pool esiste gia' ed e' esportato: indicizza i risultati per posizione di
// PARTENZA, che e' cio' che conserva l'ordine dell'albero. Vedi srv/lib/isRemoteSource.js.
const { withConcurrency } = require('./isRemoteSource');

/** Nome dell'entity di customizing, in forma pienamente qualificata (come plexJobSort.js:31). */
const E_CONFIG = 'avvaleplm.marsplm.sap2plex.ZPhantomExplodeConfig';

/** TTL della cache di configurazione. L'invalidazione esplicita e' il meccanismo, il TTL la rete. */
const CONFIG_TTL_MS = Number(process.env.PHANTOM_EXPLODE_CONFIG_TTL_MS || 60000);

/**
 * Tetto di distinte lette in una singola esplosione. Non e' una precauzione teorica: un errore di
 * customizing su un plant con distinte profonde produrrebbe centinaia di letture sincrone verso
 * l'Integration Suite, e il sintomo sarebbe un job che non finisce piu'. Superato il tetto ci si
 * ferma e lo si DICHIARA, che e' diverso dal fermarsi in silenzio.
 */
const MAX_BOM_READS = Number(process.env.PHANTOM_EXPLODE_MAX_READS || 200);

/**
 * [PHANTOM-PARALLEL] Quanti fantasma dello stesso livello si esplodono insieme.
 *
 * Ogni esplosione costa una lettura di distinta verso l'iFlow, e in fila erano ~2 s l'una: cinque
 * fantasma facevano 10 s. Il default 4 e' quello delle onde di `plantRowsPaging` — un numero che su
 * quell'iFlow e' gia' stato esercitato — e resta basso di proposito, perche' il budget di richieste
 * in volo e' un PRODOTTO: questa onda moltiplica il fan-out della sorgente sottostante, e l'istanza
 * e' una sola (`mta.yaml`, `instances: 1`) condivisa con il cockpit e i job.
 *
 * `1` riporta esattamente al comportamento di prima, in fila: e' la leva da girare se un giorno
 * l'iFlow dovesse rispondere peggio in parallelo che in sequenza.
 */
const EXPLODE_WAVE = (() => {
  const raw = Number(process.env.PHANTOM_EXPLODE_WAVE);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
})();

/** Quante alternative di distinta si guardano per un materiale. */
const BOM_HEADER_LIMIT = 50;
/** Tetto delle posizioni lette per una distinta sul canale storico. */
const BOM_ITEM_LIMIT = 1000;

const configCache = new Map(); // plant -> { at, value }

// ================================================================
// Configurazione
// ================================================================

/**
 * Configurazione di esplosione di un plant.
 *
 * RIGA ASSENTE => MOTORE SPENTO, che qui e' anche il comportamento di prima della 0019 (vedi il
 * docblock di ZPhantomExplodeConfig). Su lettura FALLITA si va nello stesso stato: non si esplode
 * una distinta sulla base di parametri che non si sono potuti leggere, e la causa resta nel log.
 *
 * @param {object} db connessione CDS al db
 * @param {string} plant
 * @param {{ force?: boolean }} [opts] `force` ignora la cache (test e diagnostica)
 * @returns {Promise<object>} nella forma di `normalizeConfig`, piu' `plant` e `readError`
 */
async function resolveExplodeConfig(db, plant, opts = {}) {
  const key = String(plant === null || plant === undefined ? '' : plant).trim();
  if (!key) return { ...R.normalizeConfig(null), plant: key };

  const hit = configCache.get(key);
  if (!opts.force && hit && (Date.now() - hit.at) < CONFIG_TTL_MS) return hit.value;

  let value;
  try {
    const row = await db.run(SELECT.one.from(E_CONFIG).where({ Plant: key }));
    value = { ...R.normalizeConfig(row), plant: key };
  } catch (e) {
    console.error(`>>> [PHANTOM-EXPLODE] lettura configurazione del plant ${key} fallita: ${e.message}`);
    value = { ...R.normalizeConfig(null), plant: key, readError: e.message };
  }
  configCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Svuota la cache. Chiamata dall'handler after(['CREATE','UPDATE','DELETE']) su
 * ZPhantomExplodeConfig e dalla cascata di deletePlant.
 * @param {string} [plant] se assente svuota tutto
 */
function invalidateExplodeConfigCache(plant) {
  const key = plant === null || plant === undefined ? '' : String(plant).trim();
  if (key) {
    configCache.delete(key);
    console.log(`>>> [PHANTOM-EXPLODE] cache di configurazione invalidata per il plant ${key}`);
  } else {
    configCache.clear();
    console.log('>>> [PHANTOM-EXPLODE] cache di configurazione invalidata (tutti i plant)');
  }
}

// ================================================================
// Cache delle distinte, per esecuzione
// ================================================================

/**
 * Una cache di esplosione, viva quanto l'operazione che la crea.
 *
 * PERCHE' NON E' MODULE-SCOPED come quella di configurazione: qui dentro finiscono DATI SAP, non
 * una manciata di interruttori. Una cache di processo li terrebbe caldi oltre la richiesta che li
 * ha chiesti, e un ciclo salvato dopo una modifica di distinta userebbe l'albero di prima — un
 * difetto che si manifesta ore dopo e non si riproduce. Il job cicli itera pero' su molti cicli
 * dello stesso plant: senza NESSUNA cache rifarebbe le stesse esplosioni decine di volte, ed e'
 * per questo che il chiamante ne crea UNA e la passa a tutte le chiamate del suo run.
 *
 * @returns {{ boms: Map, reads: { count: number } }}
 */
function createExplodeCache() {
  return { boms: new Map(), reads: { count: 0 } };
}

/**
 * [ROUTING-COMP-SOURCE] La parte di chiave di cache che rappresenta la data di lettura.
 * `TODAY` per la lettura senza data, cosi' che il ripiego resti quello storico e leggibile nei
 * dump di diagnostica.
 * @param {Date|null} explosionDate
 * @returns {string}
 */
function cacheDateKey(explosionDate) {
  return explosionDate instanceof Date && !Number.isNaN(explosionDate.getTime())
    ? explosionDate.toISOString().slice(0, 10) : 'TODAY';
}

// ================================================================
// Letture verso SAP
// ================================================================

/**
 * Le posizioni della distinta di un materiale, gia' normalizzate, con la quantita' base.
 *
 * LA FORMA DELLA QUERY SU `MaterialBOM` E' OBBLIGATA: collection con `where`, MAI `SELECT.one`.
 * `MaterialBOM` ha due rotte (GET e QUERY) e `isQueryShape.deriveOp` manda un `SELECT.one` sul
 * root `_GET`, la cui chiave a 4 campi comprende `BillOfMaterialCategory` e
 * `BillOfMaterialVariant` — cioe' esattamente i due valori che stiamo cercando. E' lo stesso
 * vincolo di `resolveMaterialBomKeys` in cat-service.js, ed e' documentato in bomSource.js:16-18.
 *
 * @param {string} material
 * @param {string} plant
 * @param {object} config configurazione normalizzata
 * @param {object} cache da `createExplodeCache`
 * @param {Date|null} explosionDate
 * @returns {Promise<{ rows: Array<object>, bom: object|null, baseQty: number }>}
 * @throws se la lettura verso SAP fallisce: il chiamante lo trasforma in nota, non in 500
 */
async function readBomItems(material, plant, config, cache, explosionDate) {
  // [ROUTING-COMP-SOURCE] LA DATA E' PARTE DELLA CHIAVE, e non e' una precauzione teorica.
  // Dalla 0025 la stessa esecuzione legge la distinta dello STESSO materiale DUE volte — a oggi
  // per i componenti del ciclo, alla data di riferimento per quelli che entreranno — e con la
  // chiave di prima (materiale + stabilimento) la seconda lettura sarebbe un colpo di cache
  // sulla prima: stesse righe, nessun componente futuro, e la feature che sembra funzionare
  // senza fare niente. Il guasto peggiore possibile, perche' non produce alcun errore.
  const key = `${material}|${plant}|${cacheDateKey(explosionDate)}`;
  // [PHANTOM-PARALLEL] SI METTE IN CACHE LA PROMESSA, NON IL RISULTATO. Con il valore messo dopo
  // l'`await`, due letture concorrenti della stessa chiave facevano entrambe miss e partivano
  // entrambe — e da quando i fantasma dello stesso livello si esplodono insieme (vedi
  // `explodeComponents`) «concorrenti» e' la norma, non l'eccezione: due fantasma fratelli che
  // portano allo stesso semilavorato sono un caso ordinario. Stampo: srv/lib/singleFlight.js.
  if (cache && cache.boms.has(key)) return cache.boms.get(key);

  if (cache && cache.reads.count >= MAX_BOM_READS) {
    throw new Error(`tetto di ${MAX_BOM_READS} letture di distinta raggiunto in questa esplosione`
      + ' (PHANTOM_EXPLODE_MAX_READS): la distinta e\' anomala o il customizing e\' troppo profondo');
  }
  // Il contatore si alza PRIMA della lettura e non si restituisce sul fallimento: il tetto conta i
  // TENTATIVI verso SAP, non i successi. In parallelo il tetto puo' essere superato al massimo di
  // (concorrenza - 1) letture gia' in volo — e' un contorno dichiarato, non una svista: su un tetto
  // da 200 e un'onda da 4 non cambia nessuna decisione.
  if (cache) cache.reads.count++;

  const promise = readBomItemsUncached(material, plant, config, explosionDate);
  if (cache) {
    cache.boms.set(key, promise);
    // UN ESITO FALLITO NON RESTA IN CACHE — e' il comportamento di prima, dove la `set` stava dopo
    // la lettura riuscita. Il `catch` e' agganciato SUBITO perche' una promessa in cache che nessuno
    // ha ancora atteso, rigettando, diventerebbe un `unhandledRejection`; non consuma l'errore, che
    // continua ad arrivare a `expandOne` e a diventare una nota.
    promise.catch(() => {
      if (cache.boms.get(key) === promise) cache.boms.delete(key);
    });
  }
  return promise;
}

/** La lettura vera, senza cache: la parte che `readBomItems` mette in volo una sola volta. */
async function readBomItemsUncached(material, plant, config, explosionDate) {
  const src = await bomSource();
  const { MaterialBOM } = src.entities;

  // 1. Quale distinta e' quella del materiale.
  const headers = await src.run(
    SELECT.from(MaterialBOM)
      .columns('BillOfMaterial', 'BillOfMaterialCategory', 'BillOfMaterialVariant',
        'BillOfMaterialVersion', 'EngineeringChangeDocument', 'BillOfMaterialVariantUsage',
        'BOMHeaderQuantityInBaseUnit', 'BOMHeaderBaseUnit', 'Material', 'Plant')
      .where({ Material: material, Plant: plant })
      .limit(BOM_HEADER_LIMIT)
  );
  const bom = R.chooseBom(headers, config);
  if (!bom) {
    return { rows: [], bom: null, baseQty: 1, noBom: true };
  }

  // 2. Le posizioni.
  const raw = src.mode === 'IS'
    ? await readItemsViaExplode(src, material, plant, bom, explosionDate)
    : await readItemsViaBomItem(src, material, plant, bom);

  const rows = raw.map((r) => R.normalizeRow(r)).filter((r) => r.Material && !r.IsDeleted);

  // [W1-05] LA QUANTITA' BASE HA DUE SORGENTI, E LA SECONDA NON E' UN LUSSO. Veniva letta SOLO
  // dalla testata (`BOMHeaderQuantityInBaseUnit`): se l'iFlow `MaterialBOM` non espone quel campo
  // il valore diventa `undefined` e il ripiego `1` scatta IN SILENZIO — che su una distinta a
  // ricetta (base 100 o 1000) e' un errore di due o tre ordini di grandezza su ogni componente.
  // Le righe dell'esplosione la portano anche loro (`R.normalizeRow` la calcola gia' e finora
  // nessuno la leggeva), quindi si guarda li' prima di rassegnarsi a 1. Il ripiego resta, ma e'
  // l'ultima spiaggia e chi lo usa lo dichiara (`assumedBase`).
  const rowBase = rows.map((r) => R.num(r.BomBaseQuantity, 0)).find((q) => q > 0) || 0;
  const baseQty = R.num(bom.BOMHeaderQuantityInBaseUnit, 0) || rowBase || 1;

  return { rows, bom, baseQty };
}

/**
 * Canale Integration Suite: il Function Import, con i parametri in QUERY STRING.
 *
 * `rawGet` e' l'unico trasporto che sa scrivere una query string a mano: `plan()` produrrebbe un
 * key predicate, che su questo indirizzo muore sulla guardia `if (!query)` dell'iFlow. La forma
 * della richiesta e' `R.explodeQuery`, LA STESSA che usa la sonda: vedi il commento in testa a
 * srv/lib/bomExplodeRules.js.
 */
async function readItemsViaExplode(src, material, plant, bom, explosionDate) {
  const suffix = R.explodeQuery(R.str(bomSource.E_EXPLODE), {
    Material: material,
    Plant: plant,
    BillOfMaterialCategory: bom.BillOfMaterialCategory,
    BillOfMaterialVariant: bom.BillOfMaterialVariant,
    BillOfMaterialVersion: bom.BillOfMaterialVersion,
    EngineeringChangeDocument: bom.EngineeringChangeDocument,
    BillOfMaterial: bom.BillOfMaterial
  }, { explosionDate });
  const body = await src.rawGet(bomSource.E_EXPLODE, 'GET', suffix);
  return R.unwrapRows(body);
}

/**
 * Canale storico: le posizioni di distinta, lette per chiave di distinta.
 *
 * `SpecialProcurementType` e `BillOfMaterialItemCategory` sono nel `$select` perche' su questo
 * canale sono gli UNICI due riscontri disponibili: `MaterialBOMItem` non ha un campo phantom.
 *
 * NON PASSA DA `src.run`, ED E' UN VINCOLO, NON UNA SCORCIATOIA. `plan()` risolve la rotta con
 * `routeFor`, che LANCIA su un'entity non dichiarata in `ROUTES` (isRemoteSource.js:248); ma
 * dichiarare `MaterialBOMItem` in `srv/lib/bomSource.js` costringerebbe a pubblicarne il path
 * anche per il canale IS — dove l'indirizzo NON ESISTE — e il ciclo che crea le istanze LANCIA
 * su un path mancante (isRemoteSource.js:198-203), cioe' l'intera area distinta base non
 * partirebbe piu' in modalita' IS. In ONPREM il target di `run` e' comunque `baseSrv`, quindi
 * questa connessione e' LA STESSA cosa: cambia solo che non passa dal pianificatore.
 * E' anche la strada che percorreva `buildBomNodeMap`, il consumatore storico.
 */
async function readItemsViaBomItem(src, material, plant, bom) {
  const direct = await cds.connect.to(bomSource.BASE);
  const { MaterialBOMItem } = direct.entities;
  return direct.run(
    SELECT.from(MaterialBOMItem)
      .columns('BillOfMaterial', 'BillOfMaterialCategory', 'BillOfMaterialVariant',
        'BillOfMaterialItemNodeNumber', 'BillOfMaterialItemNumber', 'BillOfMaterialComponent',
        'BOMItemDescription', 'BillOfMaterialItemQuantity', 'BillOfMaterialItemUnit',
        'BillOfMaterialItemCategory', 'SpecialProcurementType', 'IsBulkMaterial')
      .where({
        BillOfMaterial: bom.BillOfMaterial,
        BillOfMaterialCategory: bom.BillOfMaterialCategory,
        BillOfMaterialVariant: bom.BillOfMaterialVariant
      })
      .limit(BOM_ITEM_LIMIT)
  );
}

// ================================================================
// L'esplosione
// ================================================================

/**
 * L'indice dei fantasma della distinta di un materiale, per nodo di posizione (STLKN).
 *
 * SERVE AL SOLO RAMO CICLI. L'assegnazione componenti del ciclo (`PLMZ` /
 * `ProductionRoutingCompAlloc`) NON porta alcun flag phantom: porta il nodo della posizione di
 * distinta a cui si riferisce. Quindi si esplode UNA VOLTA la distinta del materiale di testata e
 * si guarda, nodo per nodo, se quella posizione e' un fantasma — una lettura per (materiale,
 * distinta), non una per componente.
 *
 * LA CHIAVE COMPRENDE IL NUMERO DI DISTINTA, e non e' pedanteria: `STLKN` e' unico DENTRO una
 * distinta, non fra distinte diverse. Il materiale di testata puo' avere piu' alternative, e la
 * scelta la fa `chooseBom` in base al customizing: se l'alternativa esplosa non e' quella a cui le
 * assegnazioni si riferiscono, un nodo `00000001` dell'una coinciderebbe con un nodo `00000001`
 * dell'altra e marcherebbe fantasma un componente che non lo e'. Con la distinta in chiave il
 * lookup semplicemente non aggancia, e la riga passa intatta: e' la direzione giusta del
 * fallimento, e viene DICHIARATA dal chiamante.
 *
 * @returns {Promise<Map<string, { row: object, reason: string }>>} chiave `<distinta>|<nodo>`;
 *   vuota = nessun fantasma, o distinta non risolta. Non lancia: il chiamante non deve poter
 *   fallire per un indice mancante.
 */
/**
 * [ROUTING-COMP-SOURCE] Le posizioni della distinta di un materiale a una data (feature 0025).
 *
 * E' la SECONDA LETTURA del ramo cicli: quella che scopre i componenti che l'assegnazione
 * componente-operazione del ciclo non porta, o perche' in SAP nessuno li ha mai agganciati a
 * un'operazione, o perche' una modifica tecnica li fa entrare in distinta a una data futura.
 *
 * NON E' UNA LETTURA NUOVA VERSO SAP: e' la stessa `readBomItems` che l'esplosione usa da sempre,
 * a una data diversa. Passando la stessa cache dell'esecuzione, la lettura a `null` (oggi) e
 * quella alla data di riferimento coesistono senza pestarsi — vedi la chiave di cache.
 *
 * `honored` E' LA DIFFERENZA FRA «non c'era niente» E «non l'ho potuto chiedere». Sul canale
 * dell'Integration Suite la data e' un parametro dell'esplosione e viene inviata; sul canale
 * storico le posizioni si leggono per chiave di distinta e la data NON e' esprimibile, quindi
 * non parte — e cio' che torna al suo posto lo decide quel canale, non noi. Senza questo flag un
 * canale che ignora la data e una distinta senza componenti futuri sarebbero indistinguibili, e
 * qualcuno concluderebbe che le modifiche tecniche non producono nulla.
 *
 * [ROUTING-DEFAULT-OP] ED E' UNA PROPRIETA' DELLA COPPIA (CANALE, DATA RICHIESTA), NON DEL CANALE.
 * Era `src.mode === 'IS'` e basta, quindi una lettura SENZA data — dove non c'e' niente da onorare —
 * usciva `honored: false` su tutto il canale storico. Il valore non si ferma qui: risale in
 * `buildDesiredRoutingComponents` e da li' in `sourceComplete`, che autorizza la potatura delle
 * righe manuali orfane ([COMP-ORPHAN], 0037) e il calcolo delle righe in eccesso su Plex
 * ([ROUTING-BOM-DRIFT], 0047). Su ONPREM quei due non si sarebbero piu' accesi, in silenzio e per
 * sempre: una lettura riuscita si dichiarava incompleta. Il difetto era gia' li' — questa feature
 * lo tocca perche' chiede la distinta senza data come sorgente primaria, e ne dipende.
 *
 * NON SI GUARDA `explosionDate` PER VERO O FALSO: una data non interpretabile arriva qui gia'
 * normalizzata a `null` da `normalizeKeyDate`, ma un `Date` non valido no — e `new Date('ieri')` e'
 * un oggetto, non un'assenza. Si onora cio' che si sarebbe potuto chiedere davvero.
 *
 * NON LANCIA MAI: su qualunque intoppo torna zero righe e il motivo. Il chiamante deve poter
 * proseguire con la sola prima lettura — cioe' col comportamento di prima della 0025 — e
 * dichiararlo.
 *
 * @param {string} material materiale di TESTATA del ciclo
 * @param {string} plant
 * @param {object} config configurazione normalizzata (sceglie utilizzo e alternativa)
 * @param {object} cache da `createExplodeCache`
 * @param {Date|null} explosionDate la data di riferimento
 * @returns {Promise<{ rows: Array<object>, bomNumber: string, honored: boolean, noBom: boolean,
 *          error: string }>}
 */
async function listBomComponents(material, plant, config, cache, explosionDate) {
  const empty = { rows: [], bomNumber: '', bom: null, honored: false, noBom: false, error: '' };
  const m = R.str(material);
  const p = R.str(plant);
  if (!m || !p) return { ...empty, error: 'materiale o plant non risolti' };
  try {
    const src = await bomSource();
    // [ROUTING-DEFAULT-OP] Senza una data da chiedere non c'e' niente da onorare: vedi il docblock.
    const wantsDate = explosionDate instanceof Date && !Number.isNaN(explosionDate.getTime());
    const honored = !wantsDate || src.mode === 'IS';
    const { rows, bom, noBom } = await readBomItems(m, p, config, cache, explosionDate);
    return {
      rows: rows || [],
      bomNumber: R.str(bom && bom.BillOfMaterial),
      // [ROUTING-DEFAULT-OP] La TESTATA scelta da `chooseBom`, non il solo numero: chi sintetizza
      // una riga di assegnazione dalla distinta deve poterci mettere anche categoria e alternativa,
      // che completano la chiave. Additivo: `bomNumber` resta e nessun chiamante cambia.
      bom: bom || null,
      honored,
      noBom: noBom === true,
      error: ''
    };
  } catch (e) {
    console.error(`>>> [ROUTING-COMP-SOURCE] lettura distinta di ${m}/${p} alla data`
      + ` ${cacheDateKey(explosionDate)} fallita: ${e.message}`);
    return { ...empty, error: e.message };
  }
}

async function buildPhantomIndex(material, plant, config, cache, explosionDate, notes) {
  const index = new Map();
  index.bomNumber = '';
  if (!R.str(material) || !R.str(plant)) return index;
  try {
    const { rows, bom } = await readBomItems(R.str(material), R.str(plant), config, cache, explosionDate);
    index.bomNumber = R.str(bom && bom.BillOfMaterial);
    for (const row of rows) {
      const { phantom, reason } = R.isPhantom(row);
      if (phantom && row.ItemNode) index.set(R.bomItemKey(index.bomNumber, row.ItemNode), { row, reason });
    }
  } catch (e) {
    // L'indice assente significa «nessun fantasma riconosciuto», cioe' l'albero di prima. E' un
    // fail-open, quindi va DETTO: un albero identico a ieri, dopo aver acceso l'esplosione, e'
    // indistinguibile da «questo materiale non ha fantasma».
    notes.push(note('W', `distinta di testata di ${material} non leggibile (${e.message}):`
      + ' nessun fantasma riconosciuto sui componenti del ciclo, albero come prima'));
  }
  return index;
}

/**
 * [W1-05] L'indice di TUTTE le posizioni della distinta di un materiale, per nodo (STLKN).
 *
 * GEMELLA DI `buildPhantomIndex`, E LA SOMIGLIANZA E' IL PUNTO: stessa `readBomItems`, stessa
 * chiave `R.bomItemKey`, stesso `try/catch` che non lancia. Cambia solo il filtro — qui non si
 * tengono le sole righe fantasma, si tengono tutte — perche' serve a una domanda diversa: non
 * «questa posizione e' un assieme fantasma?» ma «quanto ne va, e in che unita'?».
 *
 * LA LETTURA VERSO SAP RESTA UNA SOLA. `readBomItems` e' chiavata su `material|plant` dentro la
 * cache dell'esecuzione: chiamando le due funzioni con la STESSA cache, la seconda e' un hit.
 * Chi le chiama in sequenza senza condividere la cache paga due letture, e non c'e' motivo di
 * farlo — il punto unico dei componenti del ciclo ne crea una e la passa a entrambe.
 *
 * PERCHE' NON SI E' GENERALIZZATA `buildPhantomIndex` INVECE DI AFFIANCARLA. Perche' la 0019 e' in
 * esercizio e il suo indice ha una semantica precisa — «cosa c'e' qui dentro e' un fantasma» —
 * su cui `decidePhantom` fa `if (hit)`. Un indice che contiene tutto renderebbe quel test sempre
 * vero, e il difetto sarebbe: ogni componente diventa un fantasma da esplodere. Due indici sulle
 * stesse righe costano una `Map` in piu' e nessuna lettura in piu'.
 *
 * @param {string} material materiale di testata
 * @param {string} plant
 * @param {object} config configurazione normalizzata (serve a `chooseBom`, anche a motore spento)
 * @param {object} cache da `createExplodeCache`
 * @param {Date|null} explosionDate
 * @param {Array<object>} notes le note del chiamante, per dichiarare una lettura fallita
 * @returns {Promise<Map<string, object>>} chiave `<distinta>|<nodo>` -> riga normalizzata, con
 *   `bomNumber` e `baseQty` come proprieta'. Vuota = distinta non risolta o non leggibile: il
 *   chiamante lascia i ripieghi e li conta. Non lancia.
 */
async function buildBomIndex(material, plant, config, cache, explosionDate, notes) {
  const index = new Map();
  index.bomNumber = '';
  index.baseQty = 0;
  if (!R.str(material) || !R.str(plant)) return index;
  try {
    const { rows, bom, baseQty } = await readBomItems(
      R.str(material), R.str(plant), config, cache, explosionDate);
    index.bomNumber = R.str(bom && bom.BillOfMaterial);
    index.baseQty = R.num(baseQty, 0);
    for (const row of rows) {
      if (row.ItemNode) index.set(R.bomItemKey(index.bomNumber, row.ItemNode), row);
    }
  } catch (e) {
    // Fail-open DICHIARATO, come la gemella: senza indice i componenti tengono il ripiego `1` e il
    // chiamante lo conta. Una distinta illeggibile non deve impedire l'invio di un ciclo — ma una
    // riga BOM con quantita' 1 che nessuno dichiara e' indistinguibile da una quantita' giusta.
    if (Array.isArray(notes)) {
      notes.push(note('W', `distinta di ${material} non leggibile (${e.message}):`
        + ' quantita\' e unita\' dei componenti restano quelle di ripiego'));
    }
  }
  return index;
}

/** Una nota per il log e il recap. `level`: 'I' informativa, 'W' attenzione. */
function note(level, text) {
  return { level, text };
}

/**
 * Sostituisce ogni componente fantasma con i suoi componenti di distinta, ricorsivamente.
 *
 * @param {object} args
 * @param {string} args.plant
 * @param {Array<object>} args.components componenti in ingresso. Ogni riga puo' portare `IsPhantom`
 *   (ramo ordini, dove il flag arriva con la riga) oppure no (ramo cicli, dove si risolve
 *   dall'indice della distinta di testata).
 * @param {string} [args.parentMaterial] materiale di testata: serve solo quando `IsPhantom` non e'
 *   noto sulle righe in ingresso.
 * @param {object} args.config configurazione normalizzata
 * @param {object} [args.cache] da `createExplodeCache`
 * @param {Date|null} [args.explosionDate]
 * @param {Set<string>} [args.alreadyPresent] materiali gia' presenti a monte: i figli che vi
 *   ricadono non si aggiungono. Serve al ramo ordini, dove SAP puo' aver GIA' dissolto i fantasma.
 * @param {string} [args.tag] etichetta per i log
 * @returns {Promise<{ components: Array<object>, notes: Array<object>, stats: object }>}
 */
async function explodeComponents(args) {
  const {
    plant, components, parentMaterial, config, cache,
    explosionDate = null, alreadyPresent = null, tag = ''
  } = args || {};

  const notes = [];
  const stats = { in: 0, phantoms: 0, added: 0, skippedPresent: 0, unresolved: 0, maxLevel: 0 };
  const list = Array.isArray(components) ? components : [];
  stats.in = list.length;

  if (!config || !config.exists || !list.length) {
    return { components: list, notes, stats };
  }

  const p = R.str(plant);
  if (!p) {
    notes.push(note('W', 'plant non risolto: esplosione dei fantasma NON eseguita, componenti come da SAP'));
    return { components: list, notes, stats };
  }

  // Indice dei fantasma della distinta di testata: solo se qualche riga non porta gia' il flag.
  const needsIndex = list.some((c) => c && c.IsPhantom === undefined);
  const phantomIndex = needsIndex
    ? await buildPhantomIndex(parentMaterial, p, config, cache, explosionDate, notes)
    : new Map();

  // Righe che puntano a una distinta DIVERSA da quella indicizzata: per loro il riconoscimento
  // non e' stato fatto, e va detto. Senza questa riga «nessun fantasma» sarebbe indistinguibile
  // da «ho guardato nel posto sbagliato».
  if (needsIndex && phantomIndex.bomNumber) {
    const altre = new Set(list
      .filter((c) => c && c.IsPhantom === undefined && R.str(c._bomNo)
        && R.str(c._bomNo) !== phantomIndex.bomNumber)
      .map((c) => R.str(c._bomNo)));
    if (altre.size) {
      notes.push(note('W', `indicizzata la distinta ${phantomIndex.bomNumber} di ${parentMaterial},`
        + ` ma ${altre.size} distinte diverse compaiono fra i componenti (${[...altre].join(', ')}):`
        + ' su quelle righe i fantasma NON sono stati riconosciuti'));
    }
  }

  const present = alreadyPresent instanceof Set ? alreadyPresent : null;
  const out = [];

  // ------------------------------------------------------------------
  // [PHANTOM-PARALLEL] I fantasma dello STESSO LIVELLO si esplodono insieme.
  //
  // Ogni `expandOne` costa una lettura di distinta verso l'iFlow, e in fila erano ~2 s l'una: il
  // 14/09/2026, su `07NPE079/01`, cinque fantasma hanno preso 10,1 s dei 20,4 s dell'intera
  // auto-assegnazione — la voce piu' grossa, e quella che portava la chiamata a sfiorare il tetto
  // dell'approuter. I fratelli sono indipendenti per costruzione: solo il livello N+1 dipende dal
  // livello N, e quello resta in fila dentro `expandOne`.
  //
  // L'ORDINE E' PARTE DEL RISULTATO, e si conserva in due modi: `withConcurrency` indicizza i
  // risultati PER POSIZIONE di partenza (non di arrivo), e le note di ogni fantasma si raccolgono
  // in un elenco LOCALE che viene riversato in quello vero nell'ordine dei task. E' la stessa
  // disciplina di `absorb` in clfnRead.js: un `push` dentro un task e' la forma in cui l'ordine si
  // perde in silenzio — qui produrrebbe un albero con i componenti rimescolati a ogni esecuzione,
  // perche' a valle la `Sequence` nasce dalla posizione.
  //
  // Ogni task si CATCHA DA SOLO: `withConcurrency` non ha un `catch` per task, e un'eccezione
  // abbatterebbe l'intera esplosione invece di lasciare in elenco il solo fantasma non risolto —
  // che e' il modo in cui questa funzione dichiara di non essere riuscita.
  // ------------------------------------------------------------------
  const planned = [];
  for (const c of list) {
    if (!c) continue;
    const decided = decidePhantom(c, phantomIndex);
    if (decided.phantom) stats.phantoms++;
    planned.push({ component: c, phantom: decided.phantom, reason: decided.reason });
  }

  const results = await withConcurrency(planned.map((e) => async () => {
    if (!e.phantom) return { rows: [e.component], notes: [] };
    const localNotes = [];
    try {
      const produced = await expandOne({
        component: e.component, reason: e.reason, plant: p, config, cache,
        explosionDate, present, notes: localNotes, stats, path: [], tag
      });
      return { rows: produced, notes: localNotes };
    } catch (err) {
      stats.unresolved++;
      localNotes.push(note('W', `${tag ? `${tag} ` : ''}${R.str(e.component.Material)}:`
        + ` esplosione non riuscita (${err.message}). Il fantasma resta in elenco`));
      return { rows: [e.component], notes: localNotes };
    }
  }), EXPLODE_WAVE, null);

  for (const r of results) {
    for (const row of r.rows) out.push(row);
    for (const n of r.notes) notes.push(n);
  }

  // La fusione tocca le SOLE righe esplose: vedi il docblock di `mergeSameMaterial`.
  return { components: R.mergeSameMaterial(out, { only: (r) => !!R.str(r.PhantomSource) }), notes, stats };
}

/**
 * Il componente e' un fantasma? Il flag esplicito vince sull'indice: il ramo ordini SA, e cio' che
 * sa non va rimesso in discussione da una lettura di distinta che potrebbe non essere la stessa.
 */
function decidePhantom(component, phantomIndex) {
  // Una riga senza materiale componente non e' esplodibile e non deve nemmeno essere INTERROGATA
  // contro l'indice: il suo nodo potrebbe coincidere con quello di un fantasma, e si finirebbe a
  // cercare la distinta di un materiale vuoto.
  if (!R.str(component.Material)) return { phantom: false, reason: '' };
  if (component.IsPhantom === true) {
    return { phantom: true, reason: R.str(component.PhantomReason) || 'flag di posizione (SCHGT)' };
  }
  if (component.IsPhantom === false) return { phantom: false, reason: '' };
  const node = R.str(component.BOMItemNodeNumber);
  if (!node) return { phantom: false, reason: '' };
  const hit = phantomIndex.get(R.bomItemKey(component._bomNo, node));
  return hit ? { phantom: true, reason: hit.reason } : { phantom: false, reason: '' };
}

/**
 * Espande UN fantasma e restituisce cio' che prende il suo posto.
 *
 * Restituire il fantasma stesso e' il modo in cui questa funzione dichiara di non essere riuscita:
 * un elenco vuoto direbbe «questo fantasma non contiene niente», che e' un'altra cosa.
 */
async function expandOne(ctx) {
  const {
    component, reason, plant, config, cache, explosionDate, present, notes, stats, path, tag
  } = ctx;
  const material = R.str(component.Material);
  const label = `${tag ? `${tag} ` : ''}${material}`;

  const guard = R.guardRecursion(path, material, config.MaxDepth);
  if (guard === 'CYCLE') {
    stats.unresolved++;
    notes.push(note('W', `${label}: ANELLO nella distinta (percorso ${[...path, material].join(' > ')}).`
      + ' Il fantasma resta in elenco: e\' un dato SAP da correggere, non un caso da nascondere'));
    return [component];
  }
  if (guard === 'DEPTH') {
    stats.unresolved++;
    notes.push(note('W', `${label}: raggiunta la profondita' massima di ${config.MaxDepth} livelli`
      + ` (percorso ${[...path, material].join(' > ')}). Il fantasma resta in elenco`));
    return [component];
  }

  let read;
  try {
    read = await readBomItems(material, plant, config, cache, explosionDate);
  } catch (e) {
    stats.unresolved++;
    notes.push(note('W', `${label}: distinta non leggibile (${e.message}). Il fantasma resta in elenco`));
    return [component];
  }

  if (read.noBom || !read.rows.length) {
    stats.unresolved++;
    notes.push(note('W', `${label}: fantasma ${reason ? `riconosciuto da ${reason} ` : ''}ma`
      + `${read.noBom ? ' senza distinta' : ' con distinta vuota'} sul plant ${plant}.`
      + ' Il fantasma resta in elenco'));
    return [component];
  }

  const parentQty = R.num(component.RequiredQuantity, 0);
  const nextPath = [...path, material];
  stats.maxLevel = Math.max(stats.maxLevel, nextPath.length);
  const produced = [];
  let assumedBaseSeen = false;
  // Conteggio LOCALE, non quello di `stats`: qui serve sapere se QUESTO fantasma ha prodotto
  // qualcosa, e `stats.skippedPresent` porta anche gli scarti dei fantasma precedenti.
  let skippedHere = 0;

  for (const item of read.rows) {
    const { quantity, assumedBase } = R.childQuantity(parentQty, item.Quantity, read.baseQty);
    if (assumedBase) assumedBaseSeen = true;

    const child = {
      ...component,
      Material: item.Material,
      RequiredQuantity: quantity,
      BaseUnit: item.Unit || component.BaseUnit || '',
      BOMItemNodeNumber: item.ItemNode || component.BOMItemNodeNumber || null,
      // La provenienza e' l'ULTIMO fantasma attraversato: e' quello che l'utente riconosce
      // guardando la distinta in CS03, non la radice del percorso.
      PhantomSource: material,
      PhantomPath: nextPath.join('>'),
      IsPhantom: undefined,
      PhantomReason: ''
    };

    const sub = R.isPhantom(item);
    if (sub.phantom) {
      const deeper = await expandOne({
        ...ctx, component: child, reason: sub.reason, path: nextPath
      });
      for (const d of deeper) produced.push(d);
      continue;
    }

    if (present && present.has(child.Material)) {
      // SAP aveva GIA' dissolto il fantasma: il figlio e' gia' nell'elenco d'origine, e
      // aggiungerlo lo raddoppierebbe. Il fantasma sparisce lo stesso — che e' l'esito voluto.
      stats.skippedPresent++;
      skippedHere++;
      continue;
    }
    produced.push(child);
    stats.added++;
  }

  if (assumedBaseSeen) {
    notes.push(note('I', `${label}: quantita' base della distinta assente o zero, assunta 1.`
      + ' Le quantita' + ' dei figli sono quelle di posizione, non riscalate'));
  }
  if (!produced.length && !skippedHere) {
    stats.unresolved++;
    notes.push(note('W', `${label}: l'esplosione non ha prodotto componenti utilizzabili.`
      + ' Il fantasma resta in elenco'));
    return [component];
  }
  return produced;
}

// ================================================================
// Il ramo ORDINI DI PRODUZIONE, in un punto solo
// ================================================================

/**
 * [PHANTOM-EXPLODE] Esplode i componenti di un ordine, se il plant l'ha acceso.
 *
 * TRE CHIAMANTI, UNA FUNZIONE: la READ che alimenta l'albero del cockpit, l'auto-assegnazione
 * manuale e `loadOrderDetails` del job — che a sua volta serve anche l'azione «Crea Job» e lo
 * spacchettamento. Se l'esplosione vivesse in due dei tre, l'albero a schermo e cio' che viene
 * allineato su Plex sarebbero due cose diverse.
 *
 * QUI IL FANTASMA SI RICONOSCE DALLA RIGA: `A_ProductionOrderComponent_2` porta
 * `MaterialComponentIsPhantomItem`. Non serve nessun indice di distinta — a differenza del ramo
 * cicli, dove l'assegnazione componenti non porta alcun flag.
 *
 * `alreadyPresent` NON E' UN'OTTIMIZZAZIONE, E' IL CUORE DEL CASO REALE. In SAP standard l'ordine
 * nasce con i fantasma GIA' DISSOLTI: la distinta d'ordine contiene la riga fantasma *e* i suoi
 * figli. Esplodendo senza guardare cosa c'e' gia', ogni figlio verrebbe RADDOPPIATO. Con lo
 * scarto, l'effetto netto sull'ordine dissolto e' la sola sparizione della riga fantasma — che e'
 * esattamente l'esito voluto — mentre su un ordine non dissolto i figli vengono aggiunti. La
 * stessa funzione copre i due casi, e il conteggio dice quale dei due si e' presentato.
 *
 * NON LANCIA MAI: su qualunque intoppo restituisce le righe di partenza. Questo codice sta dentro
 * il percorso che allinea la distinta di un job GIA' schedulato su Plex.
 *
 * @param {object} args
 * @param {object} args.db connessione CDS al db
 * @param {string} args.plant plant dell'ordine (dalla testata: i componenti non sempre lo portano)
 * @param {Array<object>} args.rows righe di `A_ProductionOrderComponent_2`
 * @param {Date|null} [args.orderStartDate] per `EffectivityDateMode = 'ORDER_START_DATE'`
 * @param {object} [args.cache]
 * @param {string} [args.tag]
 * @returns {Promise<{ rows: Array<object>, exploded: boolean, stats: object|null }>}
 */
async function explodeProdOrderComponents(args) {
  const { db, plant, rows, orderStartDate = null, cache, tag = '' } = args || {};
  const inert = { rows: rows || [], exploded: false, stats: null };
  if (!inert.rows.length) return inert;

  try {
    const p = R.str(plant);
    if (!p) return inert;
    const config = await resolveExplodeConfig(db, p);
    if (!config.exists || !config.ExplodeInProdOrder) return inert;

    const explosionDate = config.EffectivityDateMode === 'ORDER_START_DATE' && orderStartDate
      ? orderStartDate
      : null;

    const components = inert.rows.map((r) => ({
      ...r,
      Material: R.str(r.Material),
      RequiredQuantity: R.num(r.RequiredQuantity, 0),
      BaseUnit: r.BaseUnit || '',
      // Il flag arriva con la riga: niente indice di distinta da costruire.
      IsPhantom: R.bool(r.MaterialComponentIsPhantomItem),
      PhantomReason: 'flag di posizione (SCHGT)',
      _opKey: R.str(r.ManufacturingOrderOperation),
      _resItem: R.str(r.ReservationItem)
    }));

    const alreadyPresent = new Set(
      components.filter((c) => !c.IsPhantom).map((c) => c.Material).filter(Boolean)
    );

    const res = await explodeComponents({
      plant: p,
      components,
      config,
      cache: cache || createExplodeCache(),
      explosionDate,
      alreadyPresent,
      tag
    });

    for (const n of res.notes) {
      const line = `>>> [PHANTOM-EXPLODE] ${tag ? `${tag}: ` : ''}${n.text}`;
      if (n.level === 'W') console.warn(line); else console.log(line);
    }
    console.log(`>>> [PHANTOM-EXPLODE] ${tag ? `${tag}: ` : ''}${res.stats.phantoms} fantasma su`
      + ` ${res.stats.in} componenti, ${res.stats.added} figli aggiunti,`
      + ` ${res.stats.skippedPresent} gia' presenti (SAP li aveva gia' dissolti),`
      + ` ${res.stats.unresolved} non risolti, profondita' max ${res.stats.maxLevel}`);

    // Ritorno alla forma della riga d'ordine. Le righe DIRETTE non si toccano: cio' che
    // l'esplosione non cambia non deve cambiare. Le esplose ricevono una posizione di
    // prenotazione SINTETICA, perche' non ne hanno una e la chiave OData dev'essere unica.
    let n = 0;
    const out = res.components.map((c) => {
      if (!R.str(c.PhantomSource)) {
        const { IsPhantom, PhantomReason, _opKey, _resItem, ...clean } = c;
        return clean;
      }
      n++;
      const { IsPhantom, PhantomReason, _opKey, _resItem, ...clean } = c;
      return {
        ...clean,
        ReservationItem: `${_resItem || ''}.${n}`,
        MaterialComponentIsPhantomItem: false,
        PhantomSource: c.PhantomSource,
        PhantomPath: c.PhantomPath || ''
      };
    });
    return { rows: out, exploded: true, stats: res.stats };
  } catch (error) {
    console.error(`>>> [PHANTOM-EXPLODE] ${tag ? `${tag}: ` : ''}esplosione dei componenti`
      + ` d'ordine NON eseguita (${error.message}): componenti come da SAP`);
    return inert;
  }
}

module.exports = {
  resolveExplodeConfig,
  invalidateExplodeConfigCache,
  createExplodeCache,
  explodeComponents,
  explodeProdOrderComponents,
  buildPhantomIndex,
  buildBomIndex,
  readBomItems,
  // [ROUTING-COMP-SOURCE] La seconda lettura del ramo cicli (feature 0025).
  listBomComponents,
  cacheDateKey,
  E_CONFIG,
  MAX_BOM_READS
};

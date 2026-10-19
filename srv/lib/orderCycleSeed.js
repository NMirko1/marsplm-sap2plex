/**
 * [ORDER-CYCLE-SEED] Il ciclo Plex di un ORDINE nasce dal ciclo salvato del MATERIALE, e al primo
 * sguardo viene scritto.
 *
 * PERCHE' ESISTE
 * Il ciclo Plex di un materiale si costruisce una volta, dalla tab «Cicli», e vale per tutti gli
 * ordini di quel materiale in quel plant. Prima di questo modulo l'ordine lo ereditava solo se
 * (a) qualcuno apriva il dettaglio dell'ordine in UI, (b) l'ordine dichiarava lo stesso
 * (gruppo, contatore) su cui il ciclo era stato salvato, e (c) premeva Salva. Tre condizioni
 * indipendenti, ognuna sufficiente a lasciare l'ordine senza ciclo — e un ordine senza ciclo
 * locale manda le sue registrazioni Plex in quarantena, perche' `postProdOrderConfirmation`
 * risolve `partOperationId -> SAPOperationId` proprio da `ZPlexCycleOperation`.
 *
 * LE TRE REGOLE
 *
 *   1. IL MODELLO SI SCEGLIE PER MATERIALE E PLANT, non per (gruppo, contatore) dell'ordine. Un
 *      ordine e il ciclo di lavorazione da cui nasce possono divergere — l'ordine porta una copia
 *      del ciclo al momento del rilascio — e comunque su Plex il ciclo vive sulla PART, cioe' sul
 *      materiale. Se fra i candidati c'e' anche il ciclo che l'ordine dichiara, quello vince: e'
 *      il piu' specifico (`chooseModelRouting`).
 *
 *   2. SI SEMINA SOLO NEL VUOTO. La scrittura avviene se e solo se l'ordine non ha ancora nessuna
 *      operazione salvata. Un ciclo che qualcuno ha modificato per quell'ordine non si sovrascrive
 *      mai da solo: e' la parte del divieto di 0007 RB-09 che resta in vigore, e l'import a mano
 *      («Importa dal Ciclo») continua a NON scrivere, perche' la' si sostituisce un albero
 *      esistente e il Salva e' l'atto esplicito di chi guarda.
 *
 *   3. LA COPIA E' COMPLETA: operazioni, componenti e centri di lavoro approvati. Un travaso che
 *      perde i work center darebbe un albero d'ordine piu' povero del ciclo da cui viene, e la
 *      differenza si vedrebbe solo aprendo le due schermate una accanto all'altra.
 *      [COMP-SOURCE] Dalla 0036 la copia porta anche la PROVENIENZA della collocazione: un ciclo in
 *      cui qualcuno ha spostato a mano un componente non deve diventare un ordine in cui quella
 *      decisione non c'e' piu' — e sull'ordine quella decisione ha un effetto, perche' il passo 2bis
 *      dell'invio la rispetta invece di interrogare le regole (srv/lib/orderBomAdd.js).
 *
 * Gira in DUE processi — il server CAP (action `autoImportPlexCycle`) e il job `PROD_ORDER` — e per
 * questo il perimetro cicli arriva INIETTATO (`checkScope`): nel server e' la funzione del
 * service, che porta con se' i messaggi i18n, nel job una chiusura equivalente. Qui non si legge
 * SAP e non si parla con Plex: le uniche letture sono sul database locale.
 *
 * Le regole verificabili senza database stanno in srv/lib/orderCycleImportRules.js
 * (test: node test/orderCycleImportRules.test.js).
 */

'use strict';

const cds = require('@sap/cds'); // per i globali di cds.ql (SELECT/INSERT/DELETE)
const rules = require('./orderCycleImportRules');
const routingMaterialRules = require('./routingMaterialRules');
const compSource = require('./compSourceRules'); // [COMP-SOURCE]
// [COMP-ORPHAN] `orderComponentKeys`: la STESSA chiave con cui il passo 7.2 decide se un componente
// e' dell'ordine. Una seconda definizione qui farebbe potare dalla semina una riga che l'invio tiene.
const orderBomAddRules = require('./orderBomAddRules');

const NS = 'avvaleplm.marsplm.sap2plex';
const E_ROUTING_OP = `${NS}.ZPlexRoutingCycleOperation`;
const E_ROUTING_COMP = `${NS}.ZPlexRoutingCycleComponent`;
const E_ROUTING_WC = `${NS}.ZPlexRoutingApprovedWorkcenter`;
const E_ORDER_OP = `${NS}.ZPlexCycleOperation`;
const E_ORDER_COMP = `${NS}.ZPlexCycleComponent`;
const E_ORDER_WC = `${NS}.ZPlexCycleApprovedWorkcenter`;

/** Quante testate di ciclo si accetta di verificare prima di rinunciare: un tetto, non un filtro. */
const MAX_CANDIDATES = 10;

/**
 * L'ordine ha gia' un ciclo Plex salvato?
 *
 * E' la condizione della regola 2, e si fa su `ZPlexCycleOperation` e non sui componenti: un ciclo
 * di sole operazioni, senza componenti assegnati, e' legittimo e va rispettato.
 * @param {object} db
 * @param {string} ManufacturingOrder
 * @returns {Promise<boolean>}
 */
async function hasSavedCycle(db, ManufacturingOrder) {
  const row = await db.run(
    SELECT.one.from(E_ORDER_OP).columns('ID').where({ ManufacturingOrder })
  );
  return !!row;
}

/**
 * Il ciclo salvato che fa da modello per questo ordine, con componenti e work center.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {string} opts.material materiale di testata dell'ordine
 * @param {string} [opts.plant] plant dell'ordine: se c'e', un candidato di un altro plant si
 *        SCARTA (confronto stretto: entrambi i lati li scrive SAP, DEC-51). Se manca — testata
 *        letta parzialmente — il filtro non si applica e lo si dichiara.
 * @param {string} [opts.orderRoutingKey] `gruppo|contatore` dichiarato dalla testata dell'ordine
 * @param {function} opts.checkScope `(group, routing) => Promise<{ok, hdr, code, message}>`
 * @returns {Promise<object>} `{ ok, reason, source, routingKey, group, routing, modelRows,
 *          componentsByOp, workcentersByOp, savedKeys, discarded, excludedByScope,
 *          rejectedByPlant, scopeUnavailable, plantOfModel, notes }`
 */
async function resolveModel(opts) {
  const { db, material, plant = '', orderRoutingKey = '', checkScope } = opts;
  const materialKey = routingMaterialRules.keyPart(material);
  const notes = [];

  // Il SOVRAINSIEME: i cicli salvati di questo materiale, su qualunque ciclo SAP. `HeaderMaterial`
  // vuoto rientra — sono le righe scritte prima della 0015, non ancora attribuite dal backfill
  // (0015 RB-19) — ed e' anche l'insieme da cui si estrae il modello, quindi non costa una lettura
  // in piu'.
  const savedForMaterial = await db.run(
    SELECT.from(E_ROUTING_OP).where({ HeaderMaterial: { in: [materialKey, ''] } })
  );
  const ranked = rules.rankSavedCycles(savedForMaterial, material);
  const savedKeys = ranked.map((c) => c.key);

  if (ranked.length === 0) {
    return {
      ok: false, reason: rules.EMPTY_REASONS.NO_SAVED_CYCLE, savedKeys: [], notes,
      excludedByScope: [], rejectedByPlant: [], scopeUnavailable: false
    };
  }

  // Ogni candidato passa dal perimetro cicli (0016) e dal plant. Le testate sono poche — un
  // materiale ha uno o due cicli salvati — e il tetto serve solo a impedire che un dato anomalo
  // trasformi questo passo in decine di letture.
  const accepted = new Set();
  const plantByKey = new Map();
  const excludedByScope = [];
  const rejectedByPlant = [];
  let scopeUnavailable = false;

  for (const cand of ranked.slice(0, MAX_CANDIDATES)) {
    const verdict = await checkScope(cand.group, cand.routing);
    if (!verdict || !verdict.ok) {
      const code = (verdict && verdict.code) || 'routingScopeUnavailable';
      if (code === 'routingScopeUnavailable') scopeUnavailable = true;
      excludedByScope.push(`${cand.key} (${code})`);
      continue;
    }
    const hdrPlant = String((verdict.hdr && verdict.hdr.Plant) || '').trim();
    if (plant && hdrPlant && hdrPlant !== plant) {
      rejectedByPlant.push(`${cand.key} (plant ${hdrPlant})`);
      continue;
    }
    if (!plant) notes.push(`plant dell'ordine non noto: il ciclo ${cand.key} non e' stato filtrato per plant`);
    accepted.add(cand.key);
    plantByKey.set(cand.key, hdrPlant);
  }
  if (ranked.length > MAX_CANDIDATES) {
    notes.push(`cicli salvati per il materiale: ${ranked.length}, verificati i ${MAX_CANDIDATES} piu' recenti`);
  }

  const choice = rules.chooseModelRouting({ ranked, orderRoutingKey, accepted });
  if (!choice.chosen) {
    return {
      ok: false,
      reason: rules.classifyEmpty({
        imported: 0, scopeUnavailable, excludedByScope, rejectedByPlant,
        routingKeysInScope: [], savedKeysForMaterial: savedKeys
      }),
      savedKeys, notes, excludedByScope, rejectedByPlant, scopeUnavailable
    };
  }

  const { key, group, routing } = choice.chosen;
  const routingKeySet = new Set([key]);
  const modelRows = rules.selectModelRows(savedForMaterial, { routingKeySet, material });
  const plexOpIds = [...new Set(modelRows.map((r) => r.PlexOperationId).filter(Boolean))];

  // Componenti e work center del CICLO SCELTO: la chiave e' completa (gruppo E contatore), non il
  // solo gruppo — un contatore diverso e' un altro ciclo, con un'altra distinta.
  const scope = {
    ProductionRoutingGroup: group,
    ProductionRouting: routing,
    HeaderMaterial: { in: [materialKey, ''] }
  };
  const comps = plexOpIds.length
    ? await db.run(SELECT.from(E_ROUTING_COMP).where({ ...scope, PlexOperationId: { in: plexOpIds } }))
    : [];
  const wcs = plexOpIds.length
    ? await db.run(SELECT.from(E_ROUTING_WC).where({ ...scope, PlexOperationId: { in: plexOpIds } }))
    : [];

  return {
    ok: true,
    reason: rules.IMPORTED,
    source: choice.source,
    routingKey: key,
    group,
    routing,
    discarded: choice.discarded,
    plantOfModel: plantByKey.get(key) || '',
    modelRows,
    componentsByOp: rules.groupComponents(comps, { routingKeySet, material }),
    workcentersByOp: groupWorkcenters(wcs),
    savedKeys,
    notes,
    excludedByScope,
    rejectedByPlant,
    scopeUnavailable
  };
}

/**
 * Work center approvati raggruppati per operazione Plex, senza duplicati di `WorkcenterId`.
 *
 * La deduplicazione non e' cosmetica: su una part-operation lo stesso work center approvato due
 * volte e' la doppia approvazione che DEC-66 rifiuta, e una copia non deve introdurla.
 * @param {Array<object>} rows righe di ZPlexRoutingApprovedWorkcenter
 * @returns {object} `{ [plexOpId]: Array<{WorkcenterId, WorkcenterCode, WorkcenterName}> }`
 */
function groupWorkcenters(rows) {
  const out = {};
  for (const w of (Array.isArray(rows) ? rows : [])) {
    if (!w || !w.PlexOperationId || !w.WorkcenterId) continue;
    const list = (out[w.PlexOperationId] ||= []);
    if (list.some((x) => x.WorkcenterId === w.WorkcenterId)) continue;
    list.push({
      WorkcenterId: w.WorkcenterId,
      WorkcenterCode: w.WorkcenterCode || '',
      WorkcenterName: w.WorkcenterName || ''
    });
  }
  return out;
}

/**
 * Le operazioni del ciclo importato: `buildImportedOps` (regole pure) piu' i work center.
 *
 * I work center si attaccano QUI e non in `buildImportedOps` perche' quella funzione descrive la
 * forma che il contratto dell'action ha sempre avuto, ed e' condivisa con chi non li ha.
 * @param {object} model da `resolveModel` (con `ok: true`)
 * @param {Array<*>|Set<*>|null} orderOpIds operazioni dell'ordine SAP, `null` = non leggibili
 * @param {Set<string>|null} [sapKeys] [COMP-ORPHAN] i componenti che l'ordine ha davvero: cio' che
 *   non c'e' non viene copiato. Assente = nessun filtro, cioe' il comportamento di prima (0037).
 * @returns {object} come `buildImportedOps`, con `ApprovedWorkcenters` su ogni operazione
 */
function buildOperations(model, orderOpIds, sapKeys) {
  const built = rules.buildImportedOps(model.modelRows, model.componentsByOp, orderOpIds, sapKeys);
  let workcenterCount = 0;
  for (const op of built.operations) {
    const wcs = model.workcentersByOp[op.PlexOperationId] || [];
    op.ApprovedWorkcenters = wcs;
    workcenterCount += wcs.length;
  }
  return { ...built, workcenterCount };
}

/**
 * [COMP-ORPHAN] Toglie dall'albero salvato di un ordine i componenti che SAP non ha piu' (0037).
 *
 * PERCHE' ANCHE ALL'INVIO, e non solo alla semina. L'albero si semina UNA volta e non viene mai
 * piu' rifatto (`hasSavedCycle` chiude entrambi gli inneschi): se SAP toglie un componente dopo il
 * primo import, la semina non ha piu' occasione di accorgersene. L'invio si', ed e' anche il momento
 * in cui l'elenco SAP e' gia' in mano — `order.components`, il choke-point con l'esplosione dei
 * fantasma, le esclusioni di plant e le rimozioni manuali gia' applicate — quindi la verifica non
 * costa nessuna lettura verso SAP.
 *
 * COSA CAMBIA PER PLEX: niente, e va detto. Il passo 7.2 disattiva le righe di distinta del lotto
 * confrontando `order.components`, non l'albero, quindi in fabbrica quel componente era gia' spento.
 * Qui si chiude la divergenza fra cio' che la fabbrica ha e cio' che il cockpit mostra — e si toglie
 * il rischio che una collocazione manuale RISORGA se SAP reinserisce il materiale.
 *
 * Cancella PER IDENTIFICATIVO. I due guardiani (insieme non letto, insieme vuoto) stanno in
 * `compSourceRules.pruneOrphans`: senza di loro un ordine i cui componenti non si riescono a leggere
 * si ritroverebbe con l'albero svuotato.
 *
 * @param {object} p
 * @param {object} p.db
 * @param {string} p.ManufacturingOrder
 * @param {Array<object>|null} p.components `order.components`; assente = non si pota niente
 * @returns {Promise<{evaluated: boolean, dropped: Array<object>, note: string}>}
 */
async function pruneOrderTreeOrphans({ db, ManufacturingOrder, components }) {
  const sapKeys = Array.isArray(components)
    ? orderBomAddRules.orderComponentKeys(components)
    : null;
  const stored = await db.run(
    SELECT.from(E_ORDER_COMP)
      .columns('ID', 'Material', 'AssignmentSource')
      .where({ ManufacturingOrder })
  );
  const prune = compSource.pruneOrphans({ stored, sapKeys, keyOf: compSource.matKey });
  if (prune.ids.length) {
    await db.run(DELETE.from(E_ORDER_COMP).where({ ID: { in: prune.ids } }));
  }
  return {
    evaluated: prune.evaluated,
    dropped: prune.dropped,
    note: compSource.describePruned(prune.dropped)
  };
}

/**
 * [ORDER-CYCLE-SEED] Le righe work center da scrivere per un ordine, dalle operazioni in mano.
 *
 * PURA (a parte il generatore di chiavi, che arriva iniettato). Condivisa dalla semina e dal
 * salvataggio dell'albero, che devono produrre le STESSE righe: due costruzioni separate
 * divergerebbero al primo campo aggiunto.
 *
 * Deduplica su (operazione, work center): lo stesso work center approvato due volte sulla stessa
 * part-operation e' la doppia approvazione che DEC-66 rifiuta, e una copia non deve introdurla.
 *
 * @param {string} ManufacturingOrder
 * @param {Array<object>} operations operazioni con `PlexOperationId` e `ApprovedWorkcenters`
 * @param {function} newId generatore di ID (in produzione `cds.utils.uuid`)
 * @returns {Array<object>} entries pronte per l'INSERT
 */
function workcenterEntries(ManufacturingOrder, operations, newId) {
  const seen = new Set();
  const out = [];
  for (const op of (Array.isArray(operations) ? operations : [])) {
    if (!op || !op.PlexOperationId) continue;
    for (const wc of (op.ApprovedWorkcenters || [])) {
      if (!wc || !wc.WorkcenterId) continue;
      const key = `${op.PlexOperationId}|${wc.WorkcenterId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ID: newId(),
        ManufacturingOrder,
        PlexOperationId: op.PlexOperationId,
        WorkcenterId: wc.WorkcenterId,
        WorkcenterCode: wc.WorkcenterCode || '',
        WorkcenterName: wc.WorkcenterName || ''
      });
    }
  }
  return out;
}

/**
 * [ORDER-CYCLE-SEED] Gli ID delle righe work center rimaste ORFANE: quelle di operazioni che il
 * ciclo salvato non ha piu'.
 *
 * PURA. Serve al ramo del salvataggio in cui il client NON manda i work center: la' l'assenza non
 * significa «togli tutto» — significa «non e' affare mio» — quindi si conserva cio' che appartiene
 * a un'operazione ancora presente e si toglie solo il resto. Cancellare tutto renderebbe il primo
 * salvataggio dell'albero una perdita silenziosa di cio' che la semina aveva copiato.
 *
 * @param {Array<object>} existing righe di ZPlexCycleApprovedWorkcenter dell'ordine (`ID`,
 *        `PlexOperationId`)
 * @param {Array<string>|Set<string>} keptOpIds operazioni ancora nel ciclo
 * @returns {Array<string>} ID da cancellare
 */
function orphanWorkcenterIds(existing, keptOpIds) {
  const kept = keptOpIds instanceof Set ? keptOpIds : new Set(keptOpIds || []);
  return (Array.isArray(existing) ? existing : [])
    .filter((w) => w && !kept.has(w.PlexOperationId))
    .map((w) => w.ID);
}

/**
 * Scrive il ciclo sull'ordine: operazioni, componenti e work center.
 *
 * DELETE + INSERT come `savePlexCycle`, e non un INSERT secco: il chiamante ha appena verificato
 * che non c'e' niente da salvare, ma fra la verifica e la scrittura possono passare due percorsi
 * (dashboard e job, due processi) — con la cancellazione davanti, una semina concorrente lascia il
 * ciclo di UNO dei due, non le righe di entrambi.
 *
 * Il gate del plant (licenza, plant attivo) NON e' qui: lo applica il chiamante, che sa come
 * reagire — `req.error` nel server, voce di recap nel job — e va applicato PRIMA di questa
 * chiamata.
 * @param {object} opts
 * @param {object} opts.db
 * @param {string} opts.ManufacturingOrder
 * @param {Array<object>} opts.operations da `buildOperations`
 * @returns {Promise<{operations: number, components: number, workcenters: number}>}
 */
async function seedOrderCycle({ db, ManufacturingOrder, operations }) {
  const ops = Array.isArray(operations) ? operations : [];
  await db.run(DELETE.from(E_ORDER_WC).where({ ManufacturingOrder }));
  await db.run(DELETE.from(E_ORDER_COMP).where({ ManufacturingOrder }));
  await db.run(DELETE.from(E_ORDER_OP).where({ ManufacturingOrder }));

  if (!ops.length) return { operations: 0, components: 0, workcenters: 0 };

  const opEntries = [];
  const compEntries = [];
  const wcEntries = workcenterEntries(ManufacturingOrder, ops, cds.utils.uuid);

  ops.forEach((op, index) => {
    const number = op.OperationNumber || (index + 1) * 10;
    opEntries.push({
      ID: cds.utils.uuid(),
      ManufacturingOrder,
      PlexOperationId: op.PlexOperationId,
      OperationCode: op.OperationCode,
      OperationName: op.OperationName,
      Sequence: number,
      SAPOperationId: op.SAPOperationId || null,
      OperationNumber: number,
      OperationType: op.OperationType || null,
      SubOperation: op.SubOperation || false,
      Shippable: op.Shippable || false,
      NetWeight: op.NetWeight != null ? op.NetWeight : null,
      StandardQuantity: op.StandardQuantity != null ? op.StandardQuantity : null
    });
    (op.Components || []).forEach((comp, compIndex) => {
      compEntries.push({
        ID: cds.utils.uuid(),
        ManufacturingOrder,
        PlexOperationId: op.PlexOperationId,
        Material: comp.Material,
        RequiredQuantity: comp.RequiredQuantity != null ? comp.RequiredQuantity : 0,
        BaseUnit: comp.BaseUnit || '',
        Sequence: (compIndex + 1) * 10,
        PhantomSource: comp.PhantomSource || '',
        // [COMP-SOURCE] L'eredita' vera: la collocazione decisa a mano sul ciclo del materiale
        // arriva sull'ordine DICHIARATA come tale (feature 0036). Le operazioni passano sempre da
        // `buildOperations`, quindi il valore e' gia' normalizzato; `normalizeOrigin` resta perche'
        // la colonna e' `not null` e un chiamante futuro potrebbe non passarci.
        AssignmentSource: compSource.normalizeOrigin(comp.AssignmentSource)
      });
    });
  });

  await db.run(INSERT.into(E_ORDER_OP).entries(opEntries));
  if (compEntries.length) await db.run(INSERT.into(E_ORDER_COMP).entries(compEntries));
  if (wcEntries.length) await db.run(INSERT.into(E_ORDER_WC).entries(wcEntries));

  return { operations: opEntries.length, components: compEntries.length, workcenters: wcEntries.length };
}

/**
 * [ORDER-CYCLE-SEED] Il perimetro cicli per chi NON e' dentro un handler CAP (il job PROD_ORDER).
 *
 * LA REGOLA NON E' DUPLICATA: sta dove e' sempre stata, in srv/lib/routingVisibility.js
 * (`loadPlantRoutingFilters` + `routingPasses`), che e' lo stesso modulo da cui la valuta
 * `checkRoutingInScope` del server. Qui c'e' solo l'impianto idraulico — la lettura della testata
 * del ciclo e una cache per run — perche' nel job non ci sono `req` ne' messaggi i18n da comporre:
 * i codici finiscono nel recap.
 *
 * FAIL-CLOSED sulla lettura, come il gemello del server: una testata che non si riesce a leggere
 * non e' «il ciclo non esiste», e' «non l'ho potuto sapere» — e un modello non verificabile non fa
 * da modello.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {function} opts.routingSource factory della sorgente d'area cicli (iniettata per non
 *        legare questo modulo a una `require` che il job risolve da se')
 * @param {object} [opts.routingVisibility] il modulo delle regole (default: quello del progetto)
 * @returns {function} `(group, routing) => Promise<{ok, hdr, code}>`
 */
function makeScopeCheck({ db, routingSource, routingVisibility }) {
  const rulesModule = routingVisibility || require('./routingVisibility');
  const cache = new Map();

  return async function checkScope(group, routing) {
    const key = `${group}|${routing}`;
    if (cache.has(key)) return cache.get(key);

    let verdict;
    try {
      const s4r = await routingSource();
      const { ProductionRoutingHeader } = s4r.entities;
      const hdr = await s4r.run(
        SELECT.one.from(ProductionRoutingHeader)
          .columns('ProductionRoutingGroup', 'ProductionRouting', 'Plant',
            'BillOfOperationsStatus', 'BillOfOperationsUsage')
          .where({ ProductionRoutingGroup: group, ProductionRouting: routing })
      );
      if (!hdr) {
        verdict = { ok: false, hdr: null, code: 'routingNotFound' };
      } else {
        const plant = String(hdr.Plant ?? '').trim();
        const { rules, readOk } = await rulesModule.loadPlantRoutingFilters(plant, db);
        verdict = !readOk
          ? { ok: false, hdr, code: 'routingScopeUnavailable' }
          : (rulesModule.routingPasses(hdr, rules)
            ? { ok: true, hdr }
            : { ok: false, hdr, code: 'routingOutOfScope' });
      }
    } catch (e) {
      verdict = { ok: false, hdr: null, code: 'routingScopeUnavailable', error: e.message };
    }
    cache.set(key, verdict);
    return verdict;
  };
}

/**
 * [ORDER-CYCLE-SEED] Il passo «se l'ordine non ha un ciclo, prendilo dal ciclo del materiale e
 * salvalo», nella forma che serve al job: nessun messaggio, un esito da mettere in traccia.
 *
 * NON LANCIA MAI. La semina e' un passo ACCESSORIO di un invio verso Plex: se fallisce, l'ordine
 * e' comunque stato mandato e il suo esito non deve cambiare (DEC-38). Chi chiama mette l'esito in
 * uno step marcato `aux: true` e, se e' un'attenzione, in una voce di recap.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {object} opts.order riga di testata (serve `ManufacturingOrder`, `Material`,
 *        `ProductionPlant`, e se ci sono `BillOfOperationsGroup`/`BillOfOperations`)
 * @param {function} opts.checkScope da `makeScopeCheck` (o l'equivalente del server)
 * @param {Array<*>|Set<*>|null} [opts.orderOpIds] operazioni SAP dell'ordine, per verificare i
 *        collegamenti salvati; `null` = non leggibili, e allora si conservano senza verifica
 * @param {object} [opts.rulesLib] iniezione per i test
 * @returns {Promise<{status: 'S'|'W'|'I', seeded: boolean, reason: string, message: string,
 *          routing: string, counts: object|null}>} `I` = niente da fare (nessuna attenzione)
 */
async function seedIfMissing(opts) {
  const { db, order, checkScope, orderOpIds = null } = opts;
  const ManufacturingOrder = order && order.ManufacturingOrder;
  const material = (order && order.Material) || '';
  const plant = String((order && order.ProductionPlant) || '').trim();

  try {
    if (!ManufacturingOrder || !material) {
      return {
        status: 'W', seeded: false, reason: rules.EMPTY_REASONS.ORDER_NOT_FOUND,
        message: `testata incompleta (materiale ${material || 'assente'}): ciclo non seminato`,
        routing: '', counts: null
      };
    }
    if (await hasSavedCycle(db, ManufacturingOrder)) {
      return {
        status: 'I', seeded: false, reason: 'alreadySaved',
        message: 'ciclo già presente sull\'ordine', routing: '', counts: null
      };
    }

    const rtgGroup = String((order.BillOfOperationsGroup || '')).trim();
    const rtgCounter = String((order.BillOfOperations || '')).trim();
    const model = await resolveModel({
      db,
      material,
      plant,
      orderRoutingKey: rtgGroup ? rules.cycleKey(rtgGroup, rtgCounter) : '',
      checkScope
    });

    if (!model.ok) {
      // Non e' un guasto: puo' semplicemente non esistere un ciclo salvato per quel materiale. Il
      // recap lo dice come informazione, e degrada solo quando c'era qualcosa e non si e' potuto
      // usare (perimetro non verificabile).
      const attention = model.reason === rules.EMPTY_REASONS.SCOPE_UNAVAILABLE;
      return {
        status: attention ? 'W' : 'I', seeded: false, reason: model.reason,
        message: `nessun ciclo seminato (${model.reason})`
          + ((model.savedKeys || []).length ? ` | cicli salvati del materiale: ${model.savedKeys.join(', ')}` : '')
          + ((model.rejectedByPlant || []).length ? ` | di altri plant: ${model.rejectedByPlant.join(', ')}` : '')
          + ((model.excludedByScope || []).length ? ` | fuori perimetro: ${model.excludedByScope.join(', ')}` : ''),
        routing: '', counts: null
      };
    }

    // ================================================================
    // [COMP-ORPHAN] I componenti che l'ORDINE ha davvero (feature 0037).
    //
    // E' qui che l'orfano nascerebbe: la copia porta i componenti del ciclo del MATERIALE, cioe' la
    // distinta, e un ordine puo' averne meno. `order.components` e' pronto perche' `loadOrderDetails`
    // gira al passo 2 e la semina al 2ter; se non c'e' — un chiamante che non lo passa — l'insieme
    // resta `null` e non si filtra niente, cioe' il comportamento di prima. Non letto non e' vuoto.
    // ================================================================
    const sapKeys = Array.isArray(order.components)
      ? orderBomAddRules.orderComponentKeys(order.components)
      : null;
    const built = buildOperations(model, orderOpIds, sapKeys);
    const counts = await seedOrderCycle({ db, ManufacturingOrder, operations: built.operations });
    const orphans = built.orphansDropped || [];
    return {
      status: 'S', seeded: true, reason: rules.IMPORTED,
      message: `ciclo importato da ${model.group}/${model.routing} (${model.source}):`
        + ` ${counts.operations} operazioni, ${counts.components} componenti,`
        + ` ${counts.workcenters} work center`
        + (built.linksVerified ? '' : ' | collegamenti conservati senza verifica')
        // [COMP-ORPHAN] Un albero piu' povero del ciclo da cui viene si SPIEGA: senza questa coda
        // la differenza fra le due schermate sembrerebbe una copia incompleta.
        + (orphans.length
          ? ` | ${orphans.length} componenti del ciclo non sono nell'ordine e non sono stati`
            + ` copiati: ${orphans.slice(0, 5).join(', ')}`
            + (orphans.length > 5 ? `, e altri ${orphans.length - 5}` : '')
          : '')
        + (sapKeys ? '' : ' | componenti dell\'ordine non noti: copiati tutti'),
      routing: `${model.group}/${model.routing}`,
      counts,
      orphansDropped: orphans
    };
  } catch (e) {
    return {
      status: 'W', seeded: false, reason: 'seedFailed',
      message: `semina del ciclo non riuscita: ${e.message}`, routing: '', counts: null
    };
  }
}

module.exports = {
  hasSavedCycle,
  resolveModel,
  buildOperations,
  groupWorkcenters,
  seedOrderCycle,
  pruneOrderTreeOrphans, // [COMP-ORPHAN]
  makeScopeCheck,
  seedIfMissing,
  workcenterEntries,
  orphanWorkcenterIds,
  ENTITIES: {
    ORDER_OP: E_ORDER_OP,
    ORDER_COMP: E_ORDER_COMP,
    ORDER_WC: E_ORDER_WC
  }
};

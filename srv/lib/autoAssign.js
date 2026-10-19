/**
 * [AUTO-ASSIGN] Auto-assegnazione dei componenti alle operazioni Plex, e l'indice delle righe
 * A_ProductPlant di un plant su cui si appoggia.
 *
 * PERCHE' E' USCITA DA cat-service.js (feature 0025).
 * Le due funzioni vivevano dentro la closure di `cds.service.impl`, quindi erano raggiungibili
 * SOLO dal server web. Dalla 0025 serve la stessa risposta anche al job `PROD_ORDER`, che e' un
 * processo standalone e non puo' importare niente da dentro quella closure: il passo che allinea
 * la distinta della part prima di creare il job deve sapere su QUALE operazione appendere un
 * componente, ed e' esattamente la domanda a cui `resolveAutoAssignments` risponde.
 *
 * DUPLICARLA SAREBBE STATO IL DIFETTO PEGGIORE. Due auto-assegnazioni che divergono darebbero un
 * albero a schermo diverso da cio' che viene inviato — la stessa classe di guasto che
 * `prepareRoutingComponents` e' nata per chiudere ([PHANTOM-EXPLODE], 0019). Il codice qui dentro
 * e' quello di prima, spostato: nessun cambio di comportamento, nessun ramo nuovo.
 *
 * NON E' UN MODULO PURO — legge dal database locale e da SAP — e per questo non ha un test in
 * `test/`. Le regole verificabili senza sistemi esterni della 0025 stanno in
 * srv/lib/orderBomAddRules.js.
 *
 * Chiamanti: le due action `autoAssignPlexCycle` (ordini e cicli) e il ramo `AutoAssignMissing`
 * di `syncRoutingPlexCycle` in srv/cat-service.js, piu' srv/lib/orderBomAdd.js.
 * Perimetro: grep -rn "AUTO-ASSIGN".
 */

'use strict';

const cds = require('@sap/cds'); // per i globali di cds.ql (SELECT) e cds.connect.to
const productSource = require('./productSource'); // [IS-SOURCE]
const clfnRead = require('./clfnRead');
const { loadPlantRowsIndex } = require('./plantRows'); // [PLANT-ROWS]
// [AUTO-ASSIGN] La precedenza fra riga specifica del materiale e riga `*` e' pura e sta di la',
// col suo test: qui dentro non sarebbe collaudabile, e sbagliarla non da' nessun errore.
const aaRules = require('./autoAssignRules');
// [IS-EGRESS] «sono dentro un run batch?» ha un punto unico che risponde, e serve anche qui: la
// scadenza della paginazione e' dell'approuter, e un job non ne ha uno.
const { resolveEgress } = require('./isEgress');

const NS = 'avvaleplm.marsplm.sap2plex';

// ================================================================
// [PLANT-ROWS] Le righe A_ProductPlant di un plant stanno in srv/lib/plantRows.js.
// ================================================================
// Ci sono uscite con la feature 0035: la stessa paginazione era scritta anche nello STEP 2 di
// `loadConfiguredProducts` (cat-service.js) e le due copie divergevano — una ordinava e teneva
// la cache, l'altra no — pur essendo, a parita' di plant, la STESSA query. Il perche' del
// filtro sul solo plant (DEC-49), della cache single-flight e della dichiarazione di ogni
// incompletezza e' rimasto li', in testa a quel file, insieme alla scala delle pagine.
//
// Qui resta il solo chiamante: `resolveAutoAssignments` chiede l'indice con le colonne che le
// condizioni FIELD del plant nominano.

// ================================================================
// AUTO-ASSIGNMENT RESOLVER - shared by the routing and production-order
// `autoAssignPlexCycle` actions. Given a plant, the header material of the
// cycle and the list of component materials, returns for each component the
// target Plex operation (a concrete operation code/id, or the FIRST_OP /
// LAST_OP sentinels), resolving in two steps:
//   1. group membership: a ZObjectGroup matches when ALL its conditions match
//      the component. [AUTO-ASSIGN] Only the groups named by a rule of the cycle
//      (ZCycleAutoAssignConfig rows of the header material, or '*') are evaluated.
//      A condition is either:
//        - FIELD: A_ProductPlant field (FieldName) = FieldValue; or
//        - CLASS: the material belongs to classification Class, whose
//          Characteristic (a readable name) is valuated to CharcValue.
//      FIELD data comes from OP_API_PRODUCT_SRV_0001 (A_ProductPlant); CLASS
//      data comes from srv/lib/clfnRead.js, che sceglie il canale (feature 0018):
//      il `$expand` a due livelli sul gateway storico, una catena di letture
//      dirette sugli iFlow dell'Integration Suite. Se la classificazione non e'
//      leggibile la funzione lo DICHIARA (`ClassificationStatus` = 'KO' e motivo
//      NO_CLFN sui componenti), invece di restituire «nessun gruppo».
//   2. operation: ZCycleAutoAssignConfig (Plant, headerMaterial, group), with
//      fallback to (Plant, '*', group) evaluated only when the specific header
//      material produces no mapping. Inside each of the two passes the group with
//      MORE conditions wins, GroupId breaks ties (autoAssignRules.pickAssignment).
// The final resolution to an actual operation node is done client-side against
// the live Plex tree (which may contain unsaved operations). [AUTO-ASSIGN] Dalla
// 0025 c'e' un secondo consumatore che la risolve lato SERVER, contro le
// part-operation che Plex ha davvero: srv/lib/orderBomAddRules.js.
// ================================================================
async function resolveAutoAssignments({ plant, headerMaterial, components, configOverride }) {
  const db = await cds.connect.to('db');
  const S4Product = await productSource(); // [IS-SOURCE]

  const norm = (v) => (v === null || v === undefined) ? '' : String(v).trim();
  const normU = (v) => norm(v).toUpperCase();

  // Distinct component materials (keep first occurrence for qty/unit/node)
  const byMaterial = new Map();
  for (const c of (components || [])) {
    const m = (c.Material || '').trim();
    if (m && !byMaterial.has(m)) byMaterial.set(m, c);
  }
  const materials = [...byMaterial.keys()];

  const assignments = [];
  const unassigned = [];
  if (!plant || materials.length === 0) {
    return {
      assignments, unassigned, counts: { total: 0, assigned: 0, unassigned: 0 },
      ClassificationStatus: 'OK', ClassificationDetail: ''
    };
  }

  // 1. Groups of the plant (ordered by GroupId) + their conditions (FIELD or CLASS)
  const groups = await db.run(
    SELECT.from(`${NS}.ZObjectGroup`).where({ Plant: plant }).orderBy('GroupId asc')
  );
  const fieldsByGroup = {};
  // [AUTO-ASSIGN] I campi FIELD di TUTTI i gruppi del plant, anche di quelli che nessuna regola di
  // questo ciclo nomina: fissano le COLONNE della lettura di `A_ProductPlant`, e le colonne sono la
  // chiave della sua cache (plantRows.js). Prenderle dai soli gruppi delle regole darebbe un elenco
  // diverso per ogni materiale di testata, e nei job ogni elenco diverso ripaga la lettura del plant
  // per intero. L'assegnazione non cambia: quei gruppi non si valutano (vedi `candidateGroups`).
  const allFieldNames = new Set();
  if (groups.length) {
    const fieldRows = await db.run(
      SELECT.from(`${NS}.ZObjectGroupField`).where({ group_ID: { in: groups.map(g => g.ID) } })
    );
    for (const f of fieldRows) {
      (fieldsByGroup[f.group_ID] = fieldsByGroup[f.group_ID] || []).push(f);
      if (f.ConditionType !== 'CLASS' && f.FieldName) allFieldNames.add(f.FieldName);
    }
  }

  // 2. Auto-assign config for the plant: specific header material + '*' fallback
  //
  // [TEMPLATE-AUTOASSIGN] `configOverride` sostituisce le righe del MATERIALE DI TESTATA con quelle
  // che un template appena importato porta e che il database ancora non ha. Serve a una cosa sola:
  // «Auto-Assegna» premuto PRIMA di salvare il ciclo deve collocare i componenti secondo il template
  // che si vede a schermo, non secondo la configurazione che il salvataggio sta per sostituire —
  // altrimenti l'albero cambia dopo il Salva e nessuno l'ha detto.
  //
  // LE RIGHE `'*'` SI LEGGONO SEMPRE DAL DATABASE, e non e' un dettaglio: sono il ripiego di plant,
  // l'import non le tocca mai, e un componente che nessuna regola del materiale aggancia va cercato
  // li' — oggi come con l'override. Quindi la sostituzione e' PARZIALE, sulla sola meta' specifica.
  //
  // E CON L'OVERRIDE SI LEGGE MENO: le righe del materiale verrebbero lette e poi buttate via,
  // quindi si chiede il solo `'*'`. Una query sola in entrambi i casi.
  //
  // Cio' che NON cambia e' la precedenza — prima tutte le regole del materiale, poi le `'*'` —
  // perche' vive in `aaRules.pickAssignment` (DEC-129) e questa funzione non la tocca: qui si decide
  // QUALI righe esistono, non come si sceglie fra loro.
  const override = Array.isArray(configOverride) ? configOverride : null;
  const hasOverride = !!(override && override.length);
  const configs = await db.run(
    SELECT.from(`${NS}.ZCycleAutoAssignConfig`)
      .where(hasOverride
        ? { Plant: plant, Material: '*' }
        : { Plant: plant, Material: { in: [headerMaterial, '*'] } })
  );
  const configByKey = {}; // `${Material}||${ComponentGroup}` -> cfg
  // La chiave la compone `autoAssignRules.configKey`, che e' anche chi la legge: scritta a mano qui
  // e la' sono due formati che possono divergere, e il sintomo sarebbe «nessuna mappatura» su un
  // customizing che c'e'.
  for (const cfg of configs) configByKey[aaRules.configKey(cfg.Material, cfg.ComponentGroup)] = cfg;
  if (hasOverride) {
    // Le righe arrivano gia' col `Material` del materiale di testata (`autoAssignRowsOf`), quindi la
    // chiave si compone allo stesso modo delle altre e la precedenza le legge come «specifiche».
    for (const cfg of override) {
      if (cfg && cfg.ComponentGroup) {
        configByKey[aaRules.configKey(cfg.Material, cfg.ComponentGroup)] = cfg;
      }
    }
    console.log(`>>> [TEMPLATE-AUTOASSIGN] regole del materiale ${headerMaterial}: ${override.length}`
      + ' dal template importato (non ancora salvate), ripiego \'*\' dal database');
  }

  // [AUTO-ASSIGN] Si valutano SOLO i gruppi nominati da una regola del ciclo — righe del materiale
  // di testata (o dell'override) e righe `*`. Un gruppo senza regola non potrebbe collocare niente:
  // valutarlo darebbe al piu' un «aggancia ma non ha mappatura», che da qui in poi non esiste piu'
  // per costruzione (niente `NO_MAPPING`). Il criterio «questa riga e' una regola per il ciclo» e'
  // lo stesso con cui `pickAssignment` compone le sue chiavi: vive di la', in un punto solo.
  const cfgRows = Object.values(configByKey);
  const ruleCodes = aaRules.ruleGroupCodes({ configRows: cfgRows, headerMaterial });
  const candidateGroups = groups.filter((g) => ruleCodes.has(g.GroupId));
  // Le condizioni dei soli gruppi candidati decidono COSA serve leggere: la classificazione legge
  // solo le coppie classe/caratteristica di questi gruppi, e `A_ProductPlant` si legge solo se
  // almeno uno di loro ha una condizione FIELD — con le colonne di tutti, per la cache.
  const classConds = [];                 // CLASS conditions: dicono cosa la classificazione deve leggere
  let ruleHasFieldConds = false;
  for (const g of candidateGroups) {
    for (const f of (fieldsByGroup[g.ID] || [])) {
      if (f.ConditionType === 'CLASS') classConds.push(f);
      else if (f.FieldName) ruleHasFieldConds = true;
    }
  }
  const starRules = cfgRows.filter((r) => r.Material === '*').length;
  console.log(`>>> [AUTO-ASSIGN] plant ${plant}, materiale di testata ${headerMaterial}: regole`
    + ` ${cfgRows.length - starRules} specifiche + ${starRules} '*'`
    + `, gruppi valutati ${candidateGroups.length} di ${groups.length}`);

  // 3. Campi A_ProductPlant dei componenti, per le condizioni FIELD.
  //
  // [PLANT-ROWS] La query di prima era
  //     .where({ Plant: plant, Product: { in: materials } })
  // e restava una lettura in collection — la rotta e' giusta — ma la lista `in` viene spezzata a
  // 15 valori e l'iFlow ONORA UN SOLO VALORE dell'OR `Product eq ...`: da ogni richiesta tornava
  // UNA riga. Per una distinta da dieci componenti i campi arrivavano a uno solo, le condizioni
  // FIELD degli altri nove non agganciavano, e i componenti uscivano «senza gruppo» come se il
  // customizing non ci fosse. E' la trappola di DEC-49, gia' dichiarata su A_ProductClass in
  // srv/lib/clfnSource.js: un insieme parziale risponde 200 ed e' indistinguibile da un insieme
  // vuoto.
  //
  // Ora si legge nella forma sicura (solo il plant nel filtro, DEC-49) e si sceglie in memoria.
  const plantDataByProduct = {};
  // [RUN-BLOCKED] Motivo tecnico della lettura dei campi di plant, se e' caduta. Resta `null`
  // quando nessuna condizione FIELD e' in gioco: la' non si legge niente, e «non letto» sarebbe
  // una notizia inventata.
  let plantDataError = null;
  if (ruleHasFieldConds) {
    // [CLFN-PARALLEL] Le colonne si ORDINANO, e non è cosmetica (DEC-122): entrano nella chiave di
    // cache della lettura
    // paginata (plantRows.js), e nascendo da un `Set` il loro ordine è quello delle righe
    // `ZObjectGroupField`. Due plant con gli stessi campi in ordine diverso, o la stessa tabella
    // riletta dopo una modifica, davano DUE voci di cache per la stessa identica lettura.
    const cols = ['Product', ...[...allFieldNames].sort()];
    try {
      // [PLANT-ROWS] La SCADENZA E' DELL'APPROUTER, e un job non ne ha uno. I 90 secondi di
      // `plantRowsPaging` stanno sotto i 120 del browser — dichiarati in `mta.yaml` solo dal
      // 14/09/2026, prima di allora il tetto vero era il default di 30 s della libreria e questa
      // frase era falsa (vedi la testata di plantRowsPaging.js); dentro un run batch quel tetto non
      // protegge nessuno e tronca un plant grosso senza che nessuno l'abbia chiesto — vedi la
      // testata di pagedRead.js, che lo dichiara già a parole («nei job è 0»).
      //
      // Non è solo correttezza. Una lettura troncata torna incompleta, e un esito incompleto NON
      // resta in cache: ogni ciclo del job ripagava da capo l'intera paginazione di
      // `A_ProductPlant`. Era un moltiplicatore nascosto della lentezza, non solo un perimetro
      // corto.
      const deadlineMs = resolveEgress(process.env).batch ? 0 : undefined;
      const byProduct = await loadPlantRowsIndex(S4Product, plant, { columns: cols, deadlineMs });
      for (const m of materials) {
        const r = byProduct.get(String(m || '').trim());
        if (r) plantDataByProduct[String(m || '').trim()] = r;
      }
    } catch (e) {
      // [RUN-BLOCKED] Prima qui c'era SOLO questo `console.warn`, e nient'altro da nessuna parte:
      // senza i campi di `A_ProductPlant` le condizioni FIELD non agganciano, i componenti escono
      // «senza gruppo» e il risultato e' indistinguibile da un customizing che non aggancia — la
      // stessa ambiguita' che la feature 0018 aveva gia' tolto alla classificazione, lasciando
      // questa meta' scoperta. L'esito RISALE al chiamante come `ClassificationStatus`: un
      // `console.warn` in un run batch e' una riga di `cf logs` che nessuno correla.
      plantDataError = e.message || String(e);
      console.warn(`>>> autoAssign: A_ProductPlant read failed: ${e.message}`);
    }
  }

  // ================================================================
  // 4. La CLASSIFICAZIONE delle condizioni CLASS (feature 0018).
  //
  // La lettura sta in srv/lib/clfnRead.js perché è l'unico punto che sceglie il canale: sul
  // gateway storico resta il `$expand` a due livelli di sempre, sull'Integration Suite diventa
  // una catena di letture dirette (là quel `$expand` non è nemmeno inviabile). Qui NON cambia
  // niente: `classByMaterial` e `charcNameToId` hanno la forma di prima, e `matchCond` sotto è
  // rimasto identico.
  //
  // `status` è la differenza che si vede: prima un fallimento diventava «nessun gruppo
  // agganciato», indistinguibile da un customizing che non aggancia. Adesso lo si dichiara.
  // ================================================================
  const clfn = await clfnRead.readClassification({ materials, conditions: classConds });
  const classByMaterial = clfn.classByMaterial; // material -> [{ className(upper), chars: { ATINN: [valori] } }]
  const charcNameToId = clfn.charcNameToId;     // normU(nome caratteristica) -> ATINN (solo positive)

  // Evaluate a single condition against the material's field/classification data.
  const matchCond = (c, pp, classes) => {
    if (c.ConditionType === 'CLASS') {
      const wantClass = normU(c.Class);
      const wantCharcId = charcNameToId[normU(c.Characteristic)];
      if (!wantClass || !wantCharcId) return false;           // unresolved -> never matches (no trivial pass)
      const cls = (classes || []).find(x => x.className === wantClass);
      if (!cls) return false;
      const vals = cls.chars[wantCharcId];
      if (!vals) return false;
      return vals.some(v => normU(v) === normU(c.CharcValue));
    }
    // FIELD condition (default). A row without a field name never matches.
    if (!c.FieldName) return false;
    return norm(pp && pp[c.FieldName]) === norm(c.FieldValue);
  };

  for (const material of materials) {
    const comp = byMaterial.get(material);
    const pp = plantDataByProduct[material];
    const classes = classByMaterial[material];

    // [AUTO-ASSIGN] TUTTI i gruppi candidati che agganciano, in ordine di `GroupId` — non il primo e
    // basta. La scelta di quale regola governa il componente si prende DOPO, in `pickAssignment`:
    // prima le regole del materiale di testata, poi le `*`, e dentro ciascuna il gruppo con piu'
    // condizioni. Il perche' sta in testa a srv/lib/autoAssignRules.js.
    const matched = aaRules.matchingGroups(candidateGroups, fieldsByGroup, (c) => matchCond(c, pp, classes));
    const picked = aaRules.pickAssignment({ matchedGroups: matched, configByKey, headerMaterial, fieldsByGroup });
    if (!picked) {
      // Nessuna regola aggancia. Tre motivi, in ordine di specificità:
      //  - NO_CLFN: la classificazione non è stata letta per intero. Vale per TUTTI i materiali
      //    rimasti fuori, anche se il primo criterio a non tornare era un FIELD: non avendo
      //    valutato le condizioni CLASS non si può dimostrare che non avrebbero agganciato, e
      //    dire NO_GROUP sarebbe un'affermazione che non abbiamo (feature 0018);
      //  - NO_PLANT_DATA: del materiale non è arrivato il dato di plant, quindi le condizioni FIELD
      //    delle regole non sono state valutate. La guardia `&& !classes` che c'era qui lo
      //    MASCHERAVA: un materiale con una classe ma senza riga di plant usciva NO_GROUP, cioè «le
      //    regole non lo agganciano» invece di «non ho letto il dato su cui si decide» — due
      //    diagnosi con rimedi opposti (master data del plant contro lettura caduta). Avere delle
      //    classi non dimostra niente sulle condizioni FIELD, che restano non valutate;
      //  - NO_GROUP: valutato tutto, nessuna regola aggancia. È l'unico esito «normale».
      // NO_MAPPING — «un gruppo aggancia ma non ha una riga» — non esce più: si valutano solo i
      // gruppi che una regola ce l'hanno. I suoi consumatori restano per le righe storiche (DEC-92).
      const reason = clfn.status === 'KO' ? 'NO_CLFN'
        : (!pp && ruleHasFieldConds) ? 'NO_PLANT_DATA' : 'NO_GROUP';
      unassigned.push({ Material: material, Reason: reason });
      continue;
    }

    assignments.push({
      Material: material,
      RequiredQuantity: comp.RequiredQuantity != null ? comp.RequiredQuantity : 0,
      BaseUnit: comp.BaseUnit || '',
      BOMItemNodeNumber: comp.BOMItemNodeNumber || null,
      // [PHANTOM-EXPLODE] La provenienza attraversa l'auto-assegnazione: senza, il componente
      // arriverebbe alla tabella del ciclo — e quindi a Plex — senza piu' traccia del fantasma
      // da cui viene, e il primo che guarda la riga non avrebbe modo di sapere perche' c'e'.
      PhantomSource: comp.PhantomSource || '',
      // Il gruppo che ha DAVVERO fornito la mappatura, non il primo che agganciava: e' l'unica
      // versione vera, ed e' quella che serve a chi legge «perche' e' finito li'».
      ComponentGroup: picked.group.GroupId,
      TargetOperation: picked.cfg.PlexOperation,
      TargetOperationName: picked.cfg.PlexOperationName || '',
      Source: picked.source
    });
  }

  return {
    assignments,
    unassigned,
    counts: { total: materials.length, assigned: assignments.length, unassigned: unassigned.length },
    // L'esito della lettura di classificazione risale fino al chiamante: le due action lo
    // rimandano al client, il job ne fa una riga in attenzione. Un'auto-assegnazione girata
    // su dati incompleti non deve somigliare a una girata su dati completi.
    //
    // [RUN-BLOCKED] E la lettura dei campi di PLANT viaggia sullo stesso canale, perche' la notizia
    // e' la stessa: «questa auto-assegnazione ha girato su dati incompleti». Due status separati
    // darebbero due strade da tenere allineate in cinque chiamanti per una distinzione che nessuno
    // dei cinque userebbe; il MOTIVO resta distinto nel dettaglio, che e' dove lo si va a leggere.
    ClassificationStatus: (clfn.status === 'KO' || plantDataError) ? 'KO' : (clfn.status || 'OK'),
    ClassificationDetail: clfn.detail
      || (plantDataError ? `A_ProductPlant non letto: ${plantDataError}` : null)
  };
}

module.exports = {
  resolveAutoAssignments
  // [PLANT-ROWS] `loadPlantRowsIndex` e `PLANT_ROWS_TTL_MS` non escono piu' da qui: hanno una
  // casa loro in srv/lib/plantRows.js, e chi li usa li prende da li'. Ri-esportarli darebbe due
  // indirizzi per la stessa cosa, che e' il modo in cui una copia ricomincia.
};

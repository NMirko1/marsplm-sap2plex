/**
 * [ORDER-CYCLE-IMPORT] Regole pure dell'import del ciclo del materiale sull'ordine di produzione.
 *
 * PERCHE' ESISTE
 * `autoImportPlexCycle` travasa nel ciclo Plex di un ordine il ciclo che qualcuno ha costruito e
 * salvato sul CICLO SAP di quel materiale (tab «Routing»). Il travaso c'era gia', ma era
 * SELETTIVO e MUTO: pretendeva il collegamento manuale all'operazione SAP, scartava l'operazione
 * intera quando quel collegamento non compariva fra le operazioni dell'ordine, e quando la part
 * aveva gia' operazioni su Plex prendeva l'elenco da Plex — facendo sparire le operazioni salvate
 * e non ancora trasferite. Le tre esclusioni insieme rendevano inutile costruire il ciclo.
 *
 * LA REGOLA ORA: il ciclo salvato del materiale E' la sorgente, Plex e' solo VERIFICA, e il
 * collegamento all'operazione d'ordine e' un ARRICCHIMENTO. Nessuna operazione salvata viene
 * scartata, nessuna operazione viene aggiunta da Plex: cio' che non torna si DICHIARA
 * (`comparePlexOps`, `classifyEmpty`), perche' un import vuoto senza motivo e' indistinguibile
 * da un customizing mancante — la stessa classe di guasto della 0015 e della 0018.
 *
 * Confronto fra chiavi SAP: solo `trim`, via `routingMaterialRules.keyPart`. NESSUN `padStart`:
 * allineare `'10'` a `'0010'` significherebbe decidere il formato di SAP (0015 RB-05, DEC-51).
 * I due lati del confronto qui li scrive SAP entrambi — operazione del ciclo e operazione
 * dell'ordine — quindi la tolleranza si ferma agli spazi.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale, ne' orologio. Non
 * aggiungerne: il test si lancia con
 *     node test/orderCycleImportRules.test.js
 * Stessa convenzione di srv/lib/splitRules.js, srv/lib/isQueryShape.js,
 * srv/lib/plexJobSortRules.js e srv/lib/routingMaterialRules.js.
 *
 * L'orchestrazione — letture SAP, lettura Plex, perimetro cicli, messaggi — sta nell'action
 * `autoImportPlexCycle` di srv/cat-service.js.
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

const { keyPart } = require('./routingMaterialRules');
// [COMP-SOURCE] Un modulo puro che richiede un modulo puro: e' la prassi del repo, e serve perche'
// «cosa conta come collocazione manuale» deve avere una definizione sola sui due alberi (0036).
const compSource = require('./compSourceRules');
const { normalizeOrigin } = compSource;

/**
 * Motivi per cui l'import non ha prodotto operazioni. Sono CODICI, non testi: il testo lo
 * compone l'orchestrazione con `getLocalizedMessage`, perche' i messaggi del backend vivono nei
 * file i18n delle app UI5 (convenzione di progetto).
 *
 * Non sono annotati su alcuna entity: non vengono persistiti, viaggiano nella risposta
 * dell'action e servono al client per decidere il tono della MessageStrip.
 */
const EMPTY_REASONS = Object.freeze({
  /** Nessun ciclo Plex salvato per questo materiale, su alcun ciclo SAP. */
  NO_SAVED_CYCLE: 'noSavedCycle',
  /** Cicli salvati per questo materiale, ma su (gruppo, contatore) diversi da quello dell'ordine. */
  SAVED_OTHER_ROUTING: 'savedCycleOtherRouting',
  /** L'ordine non e' collegato ad alcun ciclo SAP: niente da cui importare. */
  NO_ROUTING_LINKED: 'routingNotLinked',
  /** I cicli dell'ordine esistono ma sono fuori dal perimetro del plant (0016). */
  OUT_OF_SCOPE: 'routingOutOfScope',
  /** Il perimetro non e' verificabile: fail-closed dichiarato (0016). */
  SCOPE_UNAVAILABLE: 'routingScopeUnavailable',
  /**
   * [ORDER-CYCLE-SEED] La testata dell'ordine non e' arrivata da nessuna delle due forme di
   * lettura, quindi materiale e plant non sono noti e non c'e' niente da cercare. Era gia' un
   * esito dell'action (hardcoded) e dichiarato nel contratto CDS: qui prende un nome.
   */
  ORDER_NOT_FOUND: 'orderNotFound',
  /**
   * [ORDER-CYCLE-SEED] Il materiale HA cicli Plex salvati, ma nessuno appartiene al plant
   * dell'ordine (o nessuno passa il perimetro cicli). E' diverso da NO_SAVED_CYCLE: là non c'e'
   * niente da nessuna parte, qui c'e' e non e' utilizzabile per QUESTO ordine.
   */
  SAVED_OTHER_PLANT: 'savedCycleOtherPlant'
});

/**
 * [ORDER-CYCLE-SEED] Da dove viene il modello del ciclo importato sull'ordine.
 *
 * Non e' un dettaglio da log: un ciclo costruito su un ALTRO (gruppo, contatore) dello stesso
 * materiale e' un modello legittimo — e' il ciclo che qualcuno ha salvato dalla tab «Cicli» per
 * quel materiale in quel plant — ma non e' il ciclo che l'ordine dichiara di usare, e chi guarda
 * l'albero deve poterlo sapere.
 */
const MODEL_SOURCES = Object.freeze({
  /** Il (gruppo, contatore) che la testata dell'ordine dichiara. */
  ORDER_ROUTING: 'orderRouting',
  /** Un altro ciclo dello STESSO materiale nello STESSO plant, scelto per data di salvataggio. */
  MATERIAL_PLANT_CYCLE: 'materialPlantCycle'
});

/** Esito non vuoto: l'import ha prodotto almeno un'operazione. */
const IMPORTED = 'imported';

// ================================================================
// Chiavi
// ================================================================

/**
 * Chiave di un ciclo SAP, nella stessa forma usata da `routingKeySet` dell'action:
 * `gruppo|contatore`.
 * @param {*} group
 * @param {*} routing
 * @returns {string}
 */
function cycleKey(group, routing) {
  return `${keyPart(group)}|${keyPart(routing)}`;
}

/**
 * Il materiale di testata di una riga salvata appartiene al materiale dell'ordine?
 *
 * `HeaderMaterial` VUOTO SI ACCETTA: sono le righe scritte prima della 0015, non ancora
 * attribuite dal backfill (srv/lib/routingMaterialBackfill.js). Rifiutarle farebbe smettere di
 * funzionare l'import sugli impianti non ancora migrati — 0015 RB-19.
 * @param {object} row riga di ZPlexRoutingCycleOperation / ZPlexRoutingCycleComponent
 * @param {*} material materiale dell'ordine
 * @returns {boolean}
 */
function matchesMaterial(row, material) {
  const rowMaterial = keyPart(row && row.HeaderMaterial);
  return rowMaterial === '' || rowMaterial === keyPart(material);
}

// ================================================================
// Selezione del modello
// ================================================================

/**
 * Le righe di ciclo salvate che fanno da modello: quelle di uno dei cicli in perimetro E di
 * questo materiale, ordinate come vanno importate.
 *
 * ORDINAMENTO: `OperationNumber` poi `Sequence` poi `OperationCode`, cioe' la numerazione che
 * l'utente ha dato al ciclo. L'ordine dell'albero e' un'informazione che qualcuno ha inserito a
 * mano: non si ricava di nuovo dall'ordine di lettura del database, che non e' garantito.
 *
 * `SAPOperationId` NON entra nel filtro. Era il primo dei tre scarti che rendevano l'import
 * inutile: un'operazione Plex senza collegamento manuale e' un'operazione del ciclo a tutti gli
 * effetti, e va importata — senza collegamento (vedi `buildImportedOps`).
 * @param {Array<object>} savedOps righe di ZPlexRoutingCycleOperation
 * @param {{ routingKeySet: Set<string>|Array<string>, material: * }} opts
 * @returns {Array<object>} sottoinsieme di `savedOps`, ordinato (nuovo array, righe non mutate)
 */
function selectModelRows(savedOps, opts) {
  const rows = Array.isArray(savedOps) ? savedOps : [];
  const keys = opts && opts.routingKeySet
    ? (opts.routingKeySet instanceof Set ? opts.routingKeySet : new Set(opts.routingKeySet))
    : new Set();
  const material = opts ? opts.material : '';

  const kept = rows.filter((r) => r
    && keys.has(cycleKey(r.ProductionRoutingGroup, r.ProductionRouting))
    && matchesMaterial(r, material));

  const num = (v) => (v == null || v === '' ? Number.MAX_SAFE_INTEGER : Number(v));
  return kept.slice().sort((a, b) => (
    num(a.OperationNumber) - num(b.OperationNumber)
    || num(a.Sequence) - num(b.Sequence)
    || String(a.OperationCode || '').localeCompare(String(b.OperationCode || ''))
  ));
}

/**
 * I (gruppo, contatore) per cui questo materiale ha un ciclo salvato. Serve a distinguere
 * «nessun ciclo salvato» da «ciclo salvato su un altro ciclo SAP», che sono due messaggi diversi
 * e due azioni diverse per chi legge.
 * @param {Array<object>} savedOps righe di ZPlexRoutingCycleOperation del solo materiale
 * @param {*} material
 * @returns {Array<string>} chiavi `gruppo|contatore`, senza duplicati, in ordine di comparsa
 */
function savedRoutingKeys(savedOps, material) {
  const out = [];
  for (const r of (Array.isArray(savedOps) ? savedOps : [])) {
    if (!r || !matchesMaterial(r, material)) continue;
    const k = cycleKey(r.ProductionRoutingGroup, r.ProductionRouting);
    if (k !== '|' && !out.includes(k)) out.push(k);
  }
  return out;
}

// ================================================================
// [ORDER-CYCLE-SEED] Scelta del ciclo che fa da MODELLO
// ================================================================

/**
 * Quando quella riga e' stata salvata, in millisecondi confrontabili. `modifiedAt` se c'e',
 * altrimenti `createdAt`: sono i due campi che `managed` scrive da se'.
 *
 * NESSUN OROLOGIO: si legge un valore che sta nella riga, non l'ora corrente. Un timestamp
 * illeggibile vale `0`, cioe' «il piu' vecchio possibile»: non fa vincere una riga per un difetto
 * di formato.
 * @param {object} row
 * @returns {number}
 */
function savedAtMs(row) {
  const raw = (row && (row.modifiedAt || row.createdAt)) || '';
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * I cicli SAP per cui questo materiale ha un ciclo Plex salvato, dal salvataggio piu' RECENTE al
 * piu' vecchio.
 *
 * PERCHE' LA DATA. Un materiale puo' avere il ciclo Plex salvato su piu' (gruppo, contatore) dello
 * stesso plant: sono cicli alternativi, e prenderli tutti insieme mescolerebbe due alberi. Vince
 * l'ultimo salvato, che e' quello su cui qualcuno ha lavorato per ultimo; a pari data vince la
 * chiave piu' bassa, cosi' la scelta e' DETERMINISTICA e non dipende dall'ordine di lettura del
 * database. La stessa aggregazione (`MAX(modifiedAt)` per chiave) la fa gia'
 * `enumerateSavedCycles` del job dei cicli.
 *
 * @param {Array<object>} savedOps righe di ZPlexRoutingCycleOperation (sovrainsieme del materiale)
 * @param {*} material materiale di testata dell'ordine
 * @returns {Array<{key: string, group: string, routing: string, savedAt: number, opCount: number}>}
 */
function rankSavedCycles(savedOps, material) {
  const byKey = new Map();
  for (const r of (Array.isArray(savedOps) ? savedOps : [])) {
    if (!r || !matchesMaterial(r, material)) continue;
    const group = keyPart(r.ProductionRoutingGroup);
    const routing = keyPart(r.ProductionRouting);
    if (!group) continue;
    const key = cycleKey(group, routing);
    const at = savedAtMs(r);
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { key, group, routing, savedAt: at, opCount: 1 });
    else {
      cur.opCount += 1;
      if (at > cur.savedAt) cur.savedAt = at;
    }
  }
  return [...byKey.values()].sort((a, b) => (b.savedAt - a.savedAt) || a.key.localeCompare(b.key));
}

/**
 * Il ciclo che fa da modello, fra i candidati AMMESSI (stesso plant dell'ordine e dentro il
 * perimetro cicli: quei due filtri li applica l'orchestrazione, che deve leggere le testate).
 *
 * PRECEDENZA: se fra gli ammessi c'e' il ciclo che l'ordine dichiara di usare, vince quello — e'
 * il piu' specifico, e finche' esiste il comportamento resta quello di prima di questa modifica.
 * Altrimenti vince il primo di `ranked`, cioe' l'ultimo salvato.
 *
 * Gli SCARTATI si restituiscono: un modello scelto fra tre e' un'informazione da dichiarare, non
 * un dettaglio da nascondere.
 *
 * @param {object} opts
 * @param {Array<object>} opts.ranked da `rankSavedCycles`
 * @param {string} [opts.orderRoutingKey] chiave `gruppo|contatore` della testata dell'ordine
 * @param {Set<string>|Array<string>} opts.accepted chiavi ammesse (plant + perimetro)
 * @returns {{chosen: object|null, source: string|null, discarded: Array<string>}}
 */
function chooseModelRouting(opts) {
  const o = opts || {};
  const ranked = Array.isArray(o.ranked) ? o.ranked : [];
  const accepted = o.accepted instanceof Set ? o.accepted : new Set(o.accepted || []);
  const orderKey = o.orderRoutingKey || '';

  const candidates = ranked.filter((c) => accepted.has(c.key));
  if (candidates.length === 0) return { chosen: null, source: null, discarded: [] };

  const onOrderRouting = orderKey ? candidates.find((c) => c.key === orderKey) : null;
  const chosen = onOrderRouting || candidates[0];
  return {
    chosen,
    source: onOrderRouting ? MODEL_SOURCES.ORDER_ROUTING : MODEL_SOURCES.MATERIAL_PLANT_CYCLE,
    discarded: candidates.filter((c) => c.key !== chosen.key).map((c) => c.key)
  };
}

// ================================================================
// Costruzione delle operazioni importate
// ================================================================

/**
 * Numerazione delle operazioni importate: si CONSERVA quella del ciclo salvato, e si rinumera
 * `(i+1)*10` solo se manca o e' duplicata.
 *
 * Perche' conservarla: e' la sequenza che l'utente ha costruito sul ciclo, ed e' cio' che
 * l'albero dell'ordine deve mostrare. Perche' rinumerare i duplicati: `OperationNumber` e' il
 * criterio di ordinamento della READ di ZPlexCycleOperation (`orderBy('OperationNumber asc')`),
 * quindi due operazioni con lo stesso numero avrebbero un ordine indeterminato al ricaricamento.
 * @param {Array<object>} rows righe del modello, gia' ordinate
 * @returns {Array<number>} numero da assegnare a ciascuna riga, nello stesso ordine
 */
function operationNumbers(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const out = [];
  list.forEach((r, i) => {
    const n = Number(r && r.OperationNumber);
    const usable = Number.isFinite(n) && n > 0 && !seen.has(n);
    const value = usable ? n : (i + 1) * 10;
    seen.add(value);
    out.push(value);
  });
  return out;
}

/**
 * Le operazioni da consegnare al client, costruite dal ciclo salvato.
 *
 * IL COLLEGAMENTO E' UN ARRICCHIMENTO. `SAPOperationId` sopravvive solo se quell'operazione
 * esiste davvero nell'ordine: un ciclo SAP e un ordine possono avere operazioni diverse (l'ordine
 * nasce da una copia del ciclo e puo' essere stato modificato), e un collegamento che punta a
 * un'operazione inesistente ingannerebbe sia l'albero sia il dizionario inverso della
 * consuntivazione. Ma la sua caduta NON porta via l'operazione Plex — era il secondo dei tre
 * scarti. Chi cade viene contato e nominato, cosi' il messaggio puo' dirlo.
 *
 * `conflictCount` conserva il significato di prima: due righe salvate che puntano alla stessa
 * operazione Plex con collegamenti SAP diversi. Non e' un errore bloccante, e' un'ambiguita' da
 * dichiarare.
 *
 * `orderOpIds` NULLO significa «non ho potuto leggere le operazioni dell'ordine» (su Integration
 * Suite quella lettura ha bisogno dell'AUFPL, DEC-45), e allora i collegamenti salvati si
 * CONSERVANO senza verifica: azzerarli tutti su una lettura non fatta perderebbe, al primo
 * salvataggio, un collegamento che qualcuno aveva stabilito a mano. La differenza fra «verificato»
 * e «conservato» si dichiara (`linksVerified`), non si nasconde.
 * @param {Array<object>} modelRows da `selectModelRows`
 * @param {object} compsByOp componenti per PlexOperationId: `{ [plexOpId]: Array<object> }`
 * [COMP-ORPHAN] `sapKeys` — I COMPONENTI CHE L'ORDINE HA DAVVERO (feature 0037). E' qui che
 * l'orfano NASCE: la copia porta i componenti del ciclo del MATERIALE, che sono la distinta, e un
 * ordine puo' averne meno. Con `sapKeys` i componenti che l'ordine non ha non vengono copiati
 * affatto — prevenire invece di potare dopo. `null`/assente = nessun filtro, cioe' il comportamento
 * di prima, e non e' una svista: una lettura dei componenti non riuscita non dimostra che l'ordine
 * non li abbia, e su quel niente si copierebbe un albero vuoto. I due guardiani (insieme non
 * utilizzabile, insieme vuoto) stanno in `compSourceRules.pruneOrphans`.
 *
 * Il filtro sta QUI e non nei due chiamanti perche' questa funzione definisce la forma dei
 * componenti importati sia per la SEMINA sia per la RISPOSTA dell'action: un punto solo serve la
 * scrittura del job, la scrittura dell'action e l'albero che «Importa dal Ciclo» mostra senza
 * persistere.
 * @param {Array<object>} modelRows da `selectModelRows`
 * @param {object} compsByOp componenti per PlexOperationId: `{ [plexOpId]: Array<object> }`
 * @param {Array<*>|Set<*>|null} orderOpIds operazioni dell'ordine SAP
 *        (`ManufacturingOrderOperation`), oppure `null` se non sono leggibili
 * @param {Set<string>|null} [sapKeys] [COMP-ORPHAN] chiavi `matKey` dei componenti dell'ordine
 * @returns {{ operations: Array<object>, linkedCount: number, unlinkedCount: number,
 *             conflictCount: number, droppedLinks: Array<string>, conflicts: Array<string>,
 *             linksVerified: boolean, orphansDropped: Array<string> }}
 */
function buildImportedOps(modelRows, compsByOp, orderOpIds, sapKeys) {
  const rows = Array.isArray(modelRows) ? modelRows : [];
  const comps = compsByOp || {};
  const linksVerified = orderOpIds != null;
  const orderOps = new Set(
    (linksVerified ? [...(orderOpIds instanceof Set ? orderOpIds : orderOpIds)] : []).map((v) => keyPart(v))
  );

  const numbers = operationNumbers(rows);
  const operations = [];
  const droppedLinks = [];
  const conflicts = [];
  // [COMP-ORPHAN] I materiali che il ciclo porta e l'ordine non ha, calcolati UNA volta su tutte le
  // operazioni: serve al filtro qui sotto e all'elenco da dichiarare. `orphanKeys` porta con se' i
  // due guardiani, quindi con `sapKeys` assente o vuoto l'insieme e' vuoto e non si filtra niente.
  const allComps = rows.flatMap((r) => comps[r.PlexOperationId] || []);
  const orphans = compSource.orphanKeys(allComps, sapKeys, compSource.matKey);
  // Collegamento gia' visto per una stessa operazione Plex: serve a riconoscere il conflitto
  // senza raggruppare in anticipo, perche' l'ordine delle righe e' significativo.
  const linkByPlexOp = new Map();

  rows.forEach((r, i) => {
    const plexOpId = r.PlexOperationId;
    const savedLink = keyPart(r.SAPOperationId);
    const linked = savedLink !== '' && (!linksVerified || orderOps.has(savedLink));
    if (savedLink !== '' && !linked) droppedLinks.push(`${r.OperationCode || plexOpId} -> ${savedLink}`);

    if (linked) {
      const prev = linkByPlexOp.get(plexOpId);
      if (prev != null && prev !== savedLink) {
        conflicts.push(`${r.OperationCode || plexOpId}: ${prev} / ${savedLink}`);
      } else {
        linkByPlexOp.set(plexOpId, savedLink);
      }
    }

    operations.push({
      PlexOperationId: plexOpId,
      OperationCode: r.OperationCode || '',
      OperationName: r.OperationName || '',
      SAPOperationId: linked ? savedLink : null,
      OperationNumber: numbers[i],
      // [PLEX-OP-TYPE] Il tipo viaggia com'e' salvato: e' customizing per plant risolto quando il
      // ciclo e' stato costruito, e non si ri-deriva qui (DEC-76).
      OperationType: r.OperationType || null,
      SubOperation: r.SubOperation || false,
      Shippable: r.Shippable || false,
      NetWeight: r.NetWeight != null ? r.NetWeight : null,
      StandardQuantity: r.StandardQuantity != null ? r.StandardQuantity : null,
      // [COMP-ORPHAN] Il filtro PRIMA della copia: un componente che l'ordine non ha non entra
      // nemmeno nell'albero. I materiali scartati si DICHIARANO (`orphansDropped`) — un albero piu'
      // povero del ciclo da cui viene si spiega, o chi apre le due schermate una accanto all'altra
      // vede una differenza inspiegata.
      Components: (comps[plexOpId] || [])
        .filter((c) => !orphans.has(compSource.matKey(c && c.Material)))
        .map((c) => ({
        Material: c.Material,
        RequiredQuantity: c.RequiredQuantity != null ? c.RequiredQuantity : 0,
        BaseUnit: c.BaseUnit || '',
        // [PHANTOM-EXPLODE] La provenienza persistita sul ciclo del routing arriva fino
        // all'albero dell'ordine: senza, un componente nato da un'esplosione sarebbe
        // indistinguibile da uno letto da SAP (0019).
        PhantomSource: c.PhantomSource || '',
        // [COMP-SOURCE] L'EREDITA' DELLA COLLOCAZIONE A MANO, in un punto solo (feature 0036).
        // Questa funzione definisce la forma dei componenti importati sia per la SEMINA
        // (`seedOrderCycle`) sia per la RISPOSTA dell'action, quindi il campo aggiunto qui arriva a
        // entrambe: apertura della schermata a ciclo vuoto, «Importa dal Ciclo» e passo 2ter del job
        // PROD_ORDER. Normalizzato con la funzione del ciclo, mai con un confronto scritto a mano.
        AssignmentSource: normalizeOrigin(c.AssignmentSource)
      }))
    });
  });

  const linkedCount = operations.filter((o) => o.SAPOperationId).length;
  return {
    operations,
    linkedCount,
    unlinkedCount: operations.length - linkedCount,
    conflictCount: conflicts.length,
    droppedLinks,
    conflicts,
    linksVerified,
    // [COMP-ORPHAN] I materiali del ciclo che l'ordine non ha, e che quindi non sono stati copiati.
    // Elenco e non conteggio: il rimedio dipende da QUALE componente, e chi guarda deve poterlo
    // confrontare con l'ordine in SAP.
    orphansDropped: [...orphans]
  };
}

/**
 * Componenti salvati raggruppati per operazione Plex, filtrati sul materiale e sui cicli in
 * perimetro con lo stesso criterio delle operazioni.
 * @param {Array<object>} savedComps righe di ZPlexRoutingCycleComponent
 * @param {{ routingKeySet: Set<string>|Array<string>, material: * }} opts
 * @returns {object} `{ [plexOpId]: Array<object> }`, ordinati per Sequence
 */
function groupComponents(savedComps, opts) {
  const rows = selectComponentRows(savedComps, opts);
  const out = {};
  for (const c of rows) {
    (out[c.PlexOperationId] ||= []).push(c);
  }
  return out;
}

/**
 * Le righe componente ammesse, ordinate per `Sequence`. Estratta da `groupComponents` perche' il
 * filtro e' lo stesso di `selectModelRows` e va verificato una volta sola.
 * @param {Array<object>} savedComps
 * @param {{ routingKeySet: Set<string>|Array<string>, material: * }} opts
 * @returns {Array<object>}
 */
function selectComponentRows(savedComps, opts) {
  const rows = Array.isArray(savedComps) ? savedComps : [];
  const keys = opts && opts.routingKeySet
    ? (opts.routingKeySet instanceof Set ? opts.routingKeySet : new Set(opts.routingKeySet))
    : new Set();
  const material = opts ? opts.material : '';
  const num = (v) => (v == null || v === '' ? Number.MAX_SAFE_INTEGER : Number(v));

  return rows
    .filter((r) => r
      && keys.has(cycleKey(r.ProductionRoutingGroup, r.ProductionRouting))
      && matchesMaterial(r, material))
    .slice()
    .sort((a, b) => num(a.Sequence) - num(b.Sequence));
}

// ================================================================
// Verifica contro Plex
// ================================================================

/**
 * Confronto fra il ciclo importato e le part-operation che la part ha su Plex.
 *
 * NON DECIDE NIENTE: era il terzo scarto — quando la part aveva operazioni su Plex, l'elenco
 * veniva da Plex e le operazioni salvate non ancora trasferite spariva. Ora Plex e' una verifica
 * il cui esito si DICHIARA:
 *   - `plexOnly`      operazioni presenti su Plex e non nel ciclo salvato (qualcuno le ha create
 *                     su Plex, oppure il ciclo salvato e' piu' vecchio);
 *   - `missingOnPlex` operazioni del ciclo salvato non ancora presenti su Plex, cioe' il segnale
 *                     «questo ciclo non e' stato ancora sincronizzato».
 * `plexPartOps` nullo/assente significa «non l'ho potuto sapere» e non produce alcun confronto:
 * la lettura Plex e' advisory, il suo guasto non svuota l'import.
 * @param {Array<object>} importedOps da `buildImportedOps`
 * @param {Array<*>|Set<*>|null} plexPartOps operationId letti da /mdm/v1/part-operations
 * @returns {{ compared: boolean, plexOnly: Array<string>, missingOnPlex: Array<string> }}
 */
function comparePlexOps(importedOps, plexPartOps) {
  if (plexPartOps == null) return { compared: false, plexOnly: [], missingOnPlex: [] };

  const plex = new Set([...(plexPartOps instanceof Set ? plexPartOps : plexPartOps)]
    .map((v) => keyPart(v)).filter(Boolean));
  const imported = new Set((Array.isArray(importedOps) ? importedOps : [])
    .map((o) => keyPart(o && o.PlexOperationId)).filter(Boolean));

  return {
    compared: true,
    plexOnly: [...plex].filter((id) => !imported.has(id)),
    missingOnPlex: [...imported].filter((id) => !plex.has(id))
  };
}

// ================================================================
// Perche' non ho importato niente
// ================================================================

/**
 * Il motivo di un import vuoto, scelto fra `EMPTY_REASONS`.
 *
 * L'ORDINE DELLE DOMANDE E' LA PRECEDENZA DEI MESSAGGI, e va dal piu' specifico al piu' generico:
 * un perimetro non verificabile (fail-closed, 0016) va detto prima di «nessun ciclo salvato»,
 * perche' il ciclo potrebbe esserci e non lo sappiamo. `savedCycleOtherRouting` viene prima di
 * `noSavedCycle` per la stessa ragione: nomina un fatto verificabile — il ciclo c'e', ma su un
 * altro (gruppo, contatore) — invece di far cercare qualcosa che non manca.
 *
 * [ORDER-CYCLE-SEED] `rejectedByPlant` viene prima del perimetro: se il materiale ha cicli salvati
 * e nessuno e' del plant dell'ordine, il fatto da dire e' quello — il perimetro cicli di un plant
 * che non c'entra non aiuterebbe chi legge. Il caso «nessun ciclo salvato da nessuna parte» lo
 * decide l'orchestrazione, che conosce i candidati prima di filtrarli, e non passa da qui.
 * @param {{ scopeUnavailable?: boolean, excludedByScope?: Array<string>,
 *           routingKeysInScope?: Array<string>|Set<string>, savedKeysForMaterial?: Array<string>,
 *           rejectedByPlant?: Array<string>, imported?: number }} state
 * @returns {string} codice di `EMPTY_REASONS`, oppure `IMPORTED`
 */
function classifyEmpty(state) {
  const s = state || {};
  if (Number(s.imported) > 0) return IMPORTED;

  const inScope = s.routingKeysInScope instanceof Set
    ? [...s.routingKeysInScope]
    : (s.routingKeysInScope || []);
  const excluded = s.excludedByScope || [];
  const saved = s.savedKeysForMaterial || [];
  const otherPlant = s.rejectedByPlant || [];

  if (s.scopeUnavailable) return EMPTY_REASONS.SCOPE_UNAVAILABLE;
  if (inScope.length === 0 && otherPlant.length > 0) return EMPTY_REASONS.SAVED_OTHER_PLANT;
  if (inScope.length === 0 && excluded.length > 0) return EMPTY_REASONS.OUT_OF_SCOPE;
  if (inScope.length === 0) return EMPTY_REASONS.NO_ROUTING_LINKED;
  if (saved.length > 0) return EMPTY_REASONS.SAVED_OTHER_ROUTING;
  return EMPTY_REASONS.NO_SAVED_CYCLE;
}

module.exports = {
  EMPTY_REASONS,
  MODEL_SOURCES,
  IMPORTED,
  cycleKey,
  matchesMaterial,
  selectModelRows,
  savedRoutingKeys,
  savedAtMs,
  rankSavedCycles,
  chooseModelRouting,
  operationNumbers,
  buildImportedOps,
  groupComponents,
  selectComponentRows,
  comparePlexOps,
  classifyEmpty
};

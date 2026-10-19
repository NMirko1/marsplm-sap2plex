/**
 * Regole pure della lista cicli per materiale (feature 0015).
 *
 * PERCHE' ESISTE
 * La lista dei cicli non parte piu' dalle testate per poi cercarne i materiali: parte dalle
 * ASSEGNAZIONE MATERIALE (`MAPL` / `ProductionRoutingMatlAssgmt`), che sono GIA' l'insieme
 * espanso — una riga per (materiale, gruppo, contatore) e' la loro forma nativa — e le testate
 * diventano l'arricchimento. Qui vivono le sole cose di quel disegno che si possono verificare
 * SENZA SAP: la chiave di join normalizzata, il join con unione e i suoi scarti, e
 * l'attribuzione di una riga di assegnazione componenti alla distinta di un materiale.
 * L'orchestrazione — letture, licenza, paginazione, log — sta nell'handler `READ Routings` di
 * srv/cat-service.js.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale, ne' orologio (la data
 * "oggi" si passa come parametro). Non aggiungerne: il test si lancia con
 *     node test/routingMaterialRules.test.js
 * Stessa convenzione di srv/lib/splitRules.js, srv/lib/isQueryShape.js e
 * srv/lib/plexJobSortRules.js.
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

// ================================================================
// Chiavi di join
// ================================================================

/**
 * Normalizzazione di un singolo componente di chiave: solo `trim`, niente altro.
 *
 * IL `trim` NON E' DECORATIVO. Le due letture che si uniscono qui arrivano da DUE funzioni ABAP
 * diverse (`ZMARS_ROUTING_HEADER_GET` e `ZMARS_ROUTING_MATL_ASSGMT_GET`) e nulla garantisce che
 * rendano `PLNAL` nello stesso modo: `'01'` da una e `'1'` (o `'01 '`) dall'altra farebbe mancare
 * OGNI lookup, e il sintomo sarebbe di nuovo la colonna Materiale vuota — la stessa che questa
 * feature sta chiudendo, per un'altra strada e senza alcun errore visibile.
 *
 * DOVE VA, E DOVE NON VA. Qui e nell'handler: MAI nel layer sorgente. Il divieto di normalizzare
 * i valori dentro srv/lib/isRemoteSource.js (vedi la sua intestazione) resta intero, perche' la'
 * un valore alterato mentirebbe su cosa ha risposto SAP. In un join in memoria, invece, la
 * tolleranza e' esattamente cio' che serve. Il precedente e' `autoImportPlexCycle`, che gia'
 * normalizza i due lati del confronto.
 *
 * NON si aggiunge `padStart`: allineare `'1'` a `'01'` significherebbe DECIDERE il formato di
 * SAP. Se il disallineamento fosse di zeri iniziali e non di spazi, va visto e portato al team
 * Integration, non tappato qui.
 * @param {*} v
 * @returns {string}
 */
function keyPart(v) {
  return String(v ?? '').trim();
}

/**
 * Chiave di join di un ciclo: (gruppo, contatore).
 * @param {*} group
 * @param {*} routing
 * @returns {string}
 */
function routingKey(group, routing) {
  return `${keyPart(group)}|${keyPart(routing)}`;
}

/**
 * Chiave di una riga di lista: (gruppo, contatore, materiale). E' la chiave dell'entity set
 * `Routings` e quella del log per materiale.
 * @param {*} group
 * @param {*} routing
 * @param {*} material
 * @returns {string}
 */
function routingMaterialKey(group, routing, material) {
  return `${keyPart(group)}|${keyPart(routing)}|${keyPart(material)}`;
}

// ================================================================
// Flag di cancellazione della testata
// ================================================================

/**
 * Valori che contano come VERO leggendo `IsMarkedForDeletion`. Il campo e' `Boolean` nel CSN, ma
 * a valle di una funzione ABAP dietro un iFlow puo' arrivare come `true`, `'X'`, `'true'`, `'1'`.
 *
 * SCELTA DICHIARATA: qui si va fail-OPEN, al contrario di quanto fa
 * srv/lib/plexJobSortRules.js con `Result_Error`. Un valore che non sappiamo interpretare NON
 * cancella la riga. Il motivo e' l'asimmetria del danno: mostrare un ciclo cancellato e' un
 * fastidio che si vede e si segnala, mentre nascondere un ciclo valido e' una sparizione
 * silenziosa da una lista — cioe' la classe di guasto che questa feature sta chiudendo.
 */
const DELETION_TRUE_TOKENS = new Set(['true', 'x', '1', 'y', 'yes']);

/**
 * @param {*} v valore del flag come arriva dalla sorgente
 * @returns {boolean} true SOLO per un valore esplicitamente riconosciuto come «cancellato»
 */
function isMarkedForDeletion(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  return DELETION_TRUE_TOKENS.has(String(v).trim().toLowerCase());
}

// ================================================================
// Dedup delle testate
// ================================================================

/**
 * Una testata per (gruppo, contatore), tenendo la PRIMA. La ripetizione della coppia e' NORMALE
 * e voluta nella risposta: sono le versioni interne della testata
 * (`ProductionRoutingInternalVers` fa parte della chiave dell'entity set, non della nostra).
 * @param {Array<object>} headers
 * @returns {{ byRouting: Map<string, object>, deduped: number }}
 */
function dedupeHeaders(headers) {
  const byRouting = new Map();
  let deduped = 0;
  for (const h of headers || []) {
    const k = routingKey(h.ProductionRoutingGroup, h.ProductionRouting);
    if (byRouting.has(k)) { deduped++; continue; }
    byRouting.set(k, h);
  }
  return { byRouting, deduped };
}

// ================================================================
// Join e unione
// ================================================================

/**
 * I campi di TESTO che la riga di lista prende dalla testata. Assenti diventano stringa vuota,
 * che e' cio' che il client si aspetta di legare a una cella.
 */
const HEADER_TEXT_FIELDS = Object.freeze([
  'BillOfOperationsDesc',
  'BillOfOperationsStatus',
  // [ROUTING-FILTER] L'utilizzo (PLNAW): insieme allo stato e' il criterio su cui il customizing
  // per plant decide quali cicli mostrare (srv/lib/routingVisibility.js), quindi deve arrivare
  // sulla riga PRIMA che il filtro giri.
  'BillOfOperationsUsage',
  'ResponsiblePlannerGroup',
  'PlanningWorkCenter',
  'Plant'
]);

/**
 * I campi DATA. Assenti restano `null`, MAI stringa vuota: `LastChangeDate` e' `Date` nel modello
 * CDS, e una stringa vuota su una proprieta' `Edm.Date` non e' un valore che il serializzatore
 * OData possa rendere. E' la ragione per cui i due elenchi sono separati invece di essere uno solo.
 */
const HEADER_DATE_FIELDS = Object.freeze(['LastChangeDate', 'ChangedDateTime', 'CreationDate']);

/** Retrocompatibilita' di nome per chi importava l'elenco unico. */
const HEADER_FIELDS = Object.freeze([...HEADER_DATE_FIELDS.slice(0, 1), ...HEADER_TEXT_FIELDS]);

/**
 * I campi che servono SOLO a ordinare e non escono nella risposta OData: la proiezione finale
 * dell'handler li lascia fuori, perche' non sono dichiarati nell'entity set.
 */
const SORT_FIELDS = Object.freeze(['ChangedDateTime', 'LastChangeDate', 'CreationDate']);

/**
 * Una riga di lista a partire da testata e (eventuale) assegnazione.
 * `Plant` viene dalla TESTATA, cioe' e' il plant del ciclo: e' quello che la colonna mostra
 * da sempre. Il plant dell'assegnazione serve al gate licenza, non alla vista.
 */
function buildRow(hdr, material) {
  const row = {
    ProductionRoutingGroup: keyPart(hdr.ProductionRoutingGroup),
    ProductionRouting: keyPart(hdr.ProductionRouting),
    Material: keyPart(material)
  };
  for (const f of HEADER_TEXT_FIELDS) row[f] = hdr[f] ?? '';
  for (const f of HEADER_DATE_FIELDS) row[f] = hdr[f] ?? null;
  return row;
}

/**
 * Costruisce le righe della lista cicli: spina `MAPL`, arricchimento dalla testata, unione delle
 * testate senza alcuna assegnazione.
 *
 * IL GATE LICENZA E' STRETTO, DI PROPOSITO. Il plant arriva da due parti — quello
 * dell'assegnazione (`MAPL-WERKS`) e quello della testata (`PLKO-WERKS`). Normalmente
 * coincidono; se divergono devono essere ENTRAMBI in perimetro. Questo e' un choke-point di
 * licenza (vedi docs/0001) e in un choke-point la scelta larga non e' difendibile.
 *
 * LE TESTATE SENZA ASSEGNAZIONE RESTANO IN LISTA, con `Material` vuoto: uscirebbero naturalmente
 * da un join sulla spina `MAPL`, ma un ciclo che esiste va mostrato per quello che e' — e quello
 * che e' lo dice il riscontro sul campo: la funzione ABAP dietro l'iFlow **esclude gia' a monte le
 * assegnazioni cancellate**, quindi un ciclo che arriva senza materiali e' un ciclo le cui
 * assegnazioni sono state TUTTE cancellate. E' anche l'unico caso di riga con `Material` vuoto,
 * quindi l'unico con chiave OData a valore vuoto.
 * Il conteggio (`senzaAssegnazione`) si fa in ogni caso e finisce nel log e nella diagnostica:
 * contare e mostrare sono due decisioni diverse, e se quel numero uguaglia il numero di testate
 * lette il sospetto e' sulla lettura, non sul dato. `keepUnassigned: false` le esclude.
 *
 * ATTENZIONE QUANDO ARRIVERANNO I CICLI A FASI (`PLNTY = 'R'`). Oggi il perimetro e'
 * implicitamente il solo tipo `N`: `TaskListType` NON esiste in nessun punto del modello CSN, e
 * l'API cicli espone solo le liste di tipo N. «Nascondere i cicli N senza materiale» e
 * «nascondere i cicli senza materiale» sono percio' oggi la stessa frase. Non lo saranno piu' il
 * giorno in cui le R entreranno in perimetro: quel giorno questa regola va RIDECISA per tipo, non
 * ereditata, perche' e' stata tarata su cio' che vale per le N.
 *
 * @param {object} p
 * @param {Array<object>} p.matlRows righe di `ProductionRoutingMatlAssgmt` (Product, Plant,
 *   ProductionRoutingGroup, ProductionRouting, [ValidityEndDate])
 * @param {Array<object>} p.headers righe di `ProductionRoutingHeader`, versioni comprese
 * @param {Set<string>|Array<string>|null} p.plantsInScope perimetro plant; `null` = nessun gate
 *   (ramo dei dati di test, dove il perimetro e' dato dai gruppi cablati)
 * @param {boolean} [p.keepUnassigned=true] vedi il blocco sopra: si contano sempre, si mostrano
 *   salvo richiesta contraria
 * @param {string|null} [p.today] data ISO `YYYY-MM-DD` per CONTARE le assegnazioni scadute.
 *   Non le filtra: scaduto non e' cancellato, e finche' non e' chiaro cosa risponda la funzione
 *   ABAP il conteggio serve a decidere con i numeri in mano invece che a intuito.
 * @returns {{ rows: Array<object>, stats: object }}
 */
function joinRoutingRows({ matlRows, headers, plantsInScope, keepUnassigned = true, today = null }) {
  const scope = plantsInScope == null
    ? null
    : (plantsInScope instanceof Set ? plantsInScope : new Set(plantsInScope));
  const inScope = (plant) => scope == null || scope.has(keyPart(plant));

  const { byRouting, deduped } = dedupeHeaders(headers);

  const stats = {
    matlRows: (matlRows || []).length,
    headerRows: (headers || []).length,
    headerVersionsDeduped: deduped,
    headersDistinct: byRouting.size,
    rows: 0,
    senzaTestata: 0,
    testataCancellata: 0,
    plantFuoriPerimetro: 0,
    senzaAssegnazione: 0,
    assegnazioniScadute: 0,
    materialiDuplicati: 0
  };

  const rows = [];
  const seen = new Set();            // chiavi di riga gia' emesse
  // Ogni ciclo che compare in MAPL, QUALUNQUE sia stato l'esito della sua riga. Serve al giro
  // dell'unione: un ciclo le cui assegnazioni sono state scartate NON e' un ciclo «senza
  // assegnazione» — le ha, sono state filtrate — e ricomparirebbe con materiale vuoto dicendo
  // una cosa falsa, oltre a farsi contare due volte fra gli scarti.
  const routingsInMatl = new Set();

  for (const m of matlRows || []) {
    const rk = routingKey(m.ProductionRoutingGroup, m.ProductionRouting);
    const hdr = byRouting.get(rk);
    if (!hdr) { stats.senzaTestata++; continue; }
    routingsInMatl.add(rk);
    if (isMarkedForDeletion(hdr.IsMarkedForDeletion)) { stats.testataCancellata++; continue; }
    if (!inScope(m.Plant) || !inScope(hdr.Plant)) { stats.plantFuoriPerimetro++; continue; }

    const material = keyPart(m.Product);
    const key = routingMaterialKey(m.ProductionRoutingGroup, m.ProductionRouting, material);
    // La chiave dell'entity set e' a tre campi, ma quella di MAPL ne ha sei: lo stesso materiale
    // sullo stesso ciclo puo' tornare piu' volte (contatore criteri, versione interna, validita').
    // Due righe con la stessa chiave fermerebbero il binding OData V4 del cockpit.
    if (seen.has(key)) { stats.materialiDuplicati++; continue; }
    seen.add(key);

    if (today && isExpired(m.ValidityEndDate, today)) stats.assegnazioniScadute++;
    rows.push(buildRow(hdr, material));
  }

  // Il giro si fa SEMPRE, anche quando le righe non vanno emesse: `senzaAssegnazione` e' un
  // segnale di qualita' del dato e deve arrivare al log e alla diagnostica pure quando la lista
  // non le mostra. Contare e non mostrare sono due decisioni diverse.
  for (const [rk, hdr] of byRouting) {
    if (routingsInMatl.has(rk)) continue;
    if (isMarkedForDeletion(hdr.IsMarkedForDeletion)) { stats.testataCancellata++; continue; }
    if (!inScope(hdr.Plant)) { stats.plantFuoriPerimetro++; continue; }
    stats.senzaAssegnazione++;
    if (keepUnassigned) rows.push(buildRow(hdr, ''));
  }

  stats.rows = rows.length;
  return { rows, stats };
}

/**
 * Vero se `validityEndDate` e' una data ISO anteriore a `today`. Tollerante: qualunque valore non
 * interpretabile (vuoto, `'9999-12-31'` no, `'00000000'` di ABAP, `null`) NON e' scaduto.
 * @param {*} validityEndDate
 * @param {string} today `YYYY-MM-DD`
 * @returns {boolean}
 */
function isExpired(validityEndDate, today) {
  const v = keyPart(validityEndDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return v < keyPart(today);
}

// ================================================================
// Attribuzione dei componenti alla distinta del materiale
// ================================================================

/**
 * Chiave di una distinta: (numero, categoria, alternativa) — `STLNR`, `STLTY`, `STLAL`.
 * La categoria e l'alternativa fanno parte della chiave perche' lo stesso `STLNR` puo' esistere
 * in categorie diverse, e perche' un materiale puo' avere piu' alternative.
 * @param {object} r riga con BillOfMaterial / BillOfMaterialCategory / BillOfMaterialVariant
 * @returns {string}
 */
function bomKey(r) {
  return [
    keyPart(r && r.BillOfMaterial),
    keyPart(r && r.BillOfMaterialCategory),
    keyPart(r && r.BillOfMaterialVariant)
  ].join('|');
}

/**
 * Insieme delle chiavi di distinta di un materiale, da `MaterialBOM`.
 * @param {Array<object>} bomRows
 * @returns {Set<string>}
 */
function bomKeySet(bomRows) {
  const s = new Set();
  for (const b of bomRows || []) {
    const k = bomKey(b);
    if (keyPart(b.BillOfMaterial)) s.add(k);
  }
  return s;
}

/**
 * Vero se l'assegnazione componente-operazione appartiene a una delle distinte del materiale.
 *
 * PERCHE' SERVE. In SAP le OPERAZIONI sono del ciclo — identiche per tutti i materiali dello
 * stesso (gruppo, contatore) — mentre `PLMZ` punta alla posizione di una distinta SPECIFICA. Ogni
 * materiale ha la sua distinta (`MAST`), quindi materiali diversi sullo stesso ciclo hanno
 * componenti diversi appesi alle stesse operazioni. Senza questo filtro l'albero mostra i
 * componenti di TUTTE le distinte fusi insieme, che e' il comportamento da cui veniamo.
 *
 * FAIL-OPEN DICHIARATO: se non si e' riusciti a risolvere alcuna distinta per il materiale
 * (`boms` vuoto) la riga passa. Meglio l'albero indistinto di prima che un albero vuoto che
 * suggerisce «questo materiale non ha componenti».
 * @param {object} compAllocRow
 * @param {Set<string>} boms da `bomKeySet`
 * @returns {boolean}
 */
function belongsToMaterial(compAllocRow, boms) {
  if (!boms || boms.size === 0) return true;
  return boms.has(bomKey(compAllocRow));
}

module.exports = {
  keyPart,
  routingKey,
  routingMaterialKey,
  isMarkedForDeletion,
  dedupeHeaders,
  joinRoutingRows,
  isExpired,
  bomKey,
  bomKeySet,
  belongsToMaterial,
  DELETION_TRUE_TOKENS,
  HEADER_FIELDS,
  HEADER_TEXT_FIELDS,
  HEADER_DATE_FIELDS,
  SORT_FIELDS
};

/**
 * [PHANTOM-EXPLODE] Regole pure dell'esplosione dei componenti fantasma (feature 0019).
 *
 * PERCHE' ESISTE
 * L'esplosione parla solo con sistemi esterni — `ExplodeBOM` / `MaterialBOMItem` su SAP — e senza
 * un modulo puro non sarebbe collaudabile in nessun modo che non richieda una destination. Qui
 * vivono le sole cose che si possono verificare a secco: la normalizzazione delle DUE forme di
 * risposta, il riconoscimento del fantasma, la propagazione delle quantita' lungo i livelli, la
 * somma dello stesso materiale raggiunto da rami diversi e le due reti che fermano la ricorsione.
 * L'orchestrazione — letture, cache, canale, log — sta in srv/lib/bomExplode.js.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale, ne' orologio. Non
 * aggiungerne: il test si lancia con
 *     node test/bomExplodeRules.test.js
 * Stessa convenzione di srv/lib/splitRules.js, srv/lib/isQueryShape.js,
 * srv/lib/plexJobSortRules.js e srv/lib/routingMaterialRules.js.
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

// ================================================================
// Normalizzazione delle due forme di risposta
// ================================================================

/**
 * LE DUE FORME NON SONO UNA SVISTA: SONO DUE SORGENTI DIVERSE.
 *
 *   canale IS      -> `ExplodeBOM`, function import dietro il FM `ZMARS_BOM_EXPLODE_GET`, che
 *                     rende i campi in **snake_case** (`is_phantom_item`,
 *                     `bill_of_material_component`, `item_node`, ...). Campione reale versionato:
 *                     srv/external/ZMARS_BOM_EXPLODE_GET.response.example.json.
 *   canale ONPREM  -> `MaterialBOMItem` del servizio standard, che rende **CamelCase**
 *                     (`IsPhantomItem`, `BillOfMaterialComponent`, `BOMItemNodeNumber`, ...).
 *                     Modello: srv/external/OP_API_BILL_OF_MATERIAL_SRV_0002.cds.
 *
 * Ridurle a una forma sola QUI, e non nei due chiamanti, e' cio' che permette a tutto il resto
 * del motore — e a questo test — di ignorare da quale canale e' arrivata la riga.
 *
 * ATTENZIONE ALLE STRINGHE NUMERICHE: OData V2 rende i `Decimal` come STRINGHE (`"0.030"`), e
 * `"0.030" * 2` in JavaScript funziona ma `"0.030" + 2` da' `"0.0302"`. Ogni quantita' passa da
 * `num()`, che e' l'unico punto in cui una stringa diventa un numero.
 */

/** Il valore di chiave/testo: solo `trim`, come `keyPart` di routingMaterialRules.js. */
function str(v) {
  return String(v ?? '').trim();
}

/**
 * Un numero da un campo che puo' arrivare come stringa, come numero o come niente.
 * @param {*} v
 * @param {number} [fallback=0]
 * @returns {number} mai NaN
 */
function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Un booleano da un campo che puo' arrivare come `true`, `"true"`, `"X"` o `""`.
 *
 * `"X"` E' LA RAGIONE PER CUI QUESTA FUNZIONE ESISTE: in ABAP un flag e' un `CHAR1` che vale `X`
 * o spazio, e se il mapping dell'iFlow non lo converte in booleano arriva la lettera. Trattare
 * `"X"` come "una stringa non vuota, quindi truthy" funzionerebbe per caso; trattare `"false"`
 * allo stesso modo sarebbe un difetto silenzioso — un fantasma riconosciuto ovunque.
 * @param {*} v
 * @returns {boolean}
 */
function bool(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  const s = String(v).trim().toUpperCase();
  return s === 'X' || s === 'TRUE' || s === '1' || s === 'Y';
}

/**
 * Il primo campo valorizzato fra piu' nomi alternativi.
 * @param {object} raw
 * @param {Array<string>} names
 * @returns {*} `undefined` se nessuno c'e'
 */
function pick(raw, names) {
  for (const n of names) {
    const v = raw[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * Una riga di distinta, da qualunque canale sia arrivata, nella forma unica del motore.
 *
 * [W1-05] `CompUom` E `BaseUom` NON SONO DOPPIONI DI `Unit`, e servono a una domanda sola: la riga
 * di distinta e' espressa in un'unita' ALTERNATIVA del componente? `Unit` e' l'unita' della
 * quantita' — e' il `sap:unit` dichiarato su `bill_of_material_item_quantity` nell'EDMX
 * dell'esplosione, quindi la coppia (quantita', unita') si prende da li' e non altrove. Gli altri
 * due sono i due termini del confronto: «Component UoM» (STPO-MEINS) e «Base Unit of Measure»
 * (MARA-MEINS del componente). Quando differiscono, il numero che mandiamo a Plex NON e'
 * nell'unita' base del componente, e Plex quel numero lo legge nella UOM che la part ha sul suo
 * tenant — che MARS non imposta mai. Non si converte e non si traduce: si DICHIARA.
 *
 * SU ONPREM I DUE CAMPI NON ESISTONO e restano vuoti: `MaterialBOMItem` ha il solo
 * `BillOfMaterialItemUnit`. Il controllo semplicemente non scatta, ed e' la stessa asimmetria
 * gia' dichiarata per il riconoscimento del fantasma — non un'assenza da riempire indovinando.
 *
 * @param {object} raw riga grezza (snake_case da ExplodeBOM, CamelCase da MaterialBOMItem)
 * @returns {{
 *   Material: string, Description: string, ItemNode: string, ItemNumber: string,
 *   Quantity: number, Unit: string, CompUom: string, BaseUom: string, BomBaseQuantity: number,
 *   ItemCategory: string, SpecialProcurement: string, IsPhantomFlag: boolean,
 *   IsBulk: boolean, IsDeleted: boolean
 * }}
 */
function normalizeRow(raw) {
  const r = raw || {};
  return {
    Material: str(pick(r, ['bill_of_material_component', 'BillOfMaterialComponent'])),
    Description: str(pick(r, ['b_o_m_component_description', 'BOMItemDescription', 'b_o_m_item_description'])),
    // STLKN: e' il campo su cui si aggancia l'assegnazione componenti del ciclo (PLMZ).
    ItemNode: str(pick(r, ['item_node', 'BillOfMaterialItemNodeNumber', 'BOMItemNodeNumber'])),
    // POSNR: la posizione visibile all'utente, usata solo nei messaggi.
    ItemNumber: str(pick(r, ['bill_of_material_item_number', 'BillOfMaterialItemNumber'])),
    Quantity: num(pick(r, ['bill_of_material_item_quantity', 'bill_of_material_comp_quant',
      'BillOfMaterialItemQuantity']), 0),
    Unit: str(pick(r, ['bill_of_material_item_unit', 'BillOfMaterialItemUnit'])),
    // [W1-05] I due termini del confronto «unita' alternativa?». Solo canale IS.
    CompUom: str(pick(r, ['unit_of_measure'])),
    BaseUom: str(pick(r, ['base_uom'])),
    // Quantita' base della distinta: le quantita' di posizione sono riferite a QUESTA, non a 1.
    BomBaseQuantity: num(pick(r, ['bill_of_material_base_quant', 'b_o_m_header_quantity_primary',
      'BillOfMaterialHeaderQuantity', 'BOMHeaderQuantityInBaseUnit']), 0),
    ItemCategory: str(pick(r, ['bill_of_material_item_category', 'BillOfMaterialItemCategory',
      'BOMItemCategory'])).toUpperCase(),
    SpecialProcurement: str(pick(r, ['special_procurement_type', 'SpecialProcurementType'])),
    IsPhantomFlag: bool(r.is_phantom_item ?? r.IsPhantomItem ?? r.MaterialComponentIsPhantomItem),
    IsBulk: bool(r.bulk_material ?? r.IsBulkMaterialComponent ?? r.BulkMaterial),
    IsDeleted: bool(r.deletion_indicator ?? r.BillOfMaterialItemIsMarkedForDeletion
      ?? r.MatlCompIsMarkedForDeletion)
  };
}

// ================================================================
// Riconoscimento del fantasma
// ================================================================

/** Categoria posizione «assieme fantasma» (POSTP). */
const ITEM_CATEGORY_PHANTOM = 'L';
/** Approvvigionamento speciale «assieme fantasma» (SOBSL). */
const SPECIAL_PROCUREMENT_PHANTOM = '50';

/**
 * Il componente e' un fantasma?
 *
 * TRE RISCONTRI, IN ORDINE, E IL PRIMO CHE PARLA VINCE. Non sono ridondanti: sono tre punti del
 * dato SAP che possono essere popolati o no a seconda del canale e della funzione ABAP dietro
 * l'iFlow, e affidarsi a uno solo significherebbe non riconoscere niente il giorno in cui quel
 * campo arriva vuoto — che e' il fallimento peggiore, perche' somiglia a «non ci sono fantasma».
 *
 *   1. `is_phantom_item` / `MaterialComponentIsPhantomItem` — STPO-SCHGT. E' la risposta di SAP
 *      alla domanda esatta, quando c'e';
 *   2. categoria posizione `L` — POSTP. E' cio' che l'utente vede in CS03;
 *   3. approvvigionamento speciale `50` — SOBSL. Sul canale Integration Suite arriva dentro
 *      `ProductCFOPCategory` di A_ProductPlant (vedi srv/lib/bomExplode.js).
 *
 * QUALE HA DECISO FINISCE NEL LOG: un riconoscimento che non dice su cosa si basa e'
 * indiagnosticabile il giorno in cui sbaglia.
 *
 * @param {object} row riga gia' passata da `normalizeRow`
 * @returns {{ phantom: boolean, reason: string }} `reason` vuoto se non e' un fantasma
 */
function isPhantom(row) {
  const r = row || {};
  if (r.IsPhantomFlag === true) return { phantom: true, reason: 'flag di posizione (SCHGT)' };
  if (r.ItemCategory === ITEM_CATEGORY_PHANTOM) {
    return { phantom: true, reason: `categoria posizione '${ITEM_CATEGORY_PHANTOM}' (POSTP)` };
  }
  if (str(r.SpecialProcurement) === SPECIAL_PROCUREMENT_PHANTOM) {
    return { phantom: true, reason: `approvvigionamento speciale '${SPECIAL_PROCUREMENT_PHANTOM}' (SOBSL)` };
  }
  return { phantom: false, reason: '' };
}

// ================================================================
// Quantita'
// ================================================================

/**
 * La quantita' di un figlio dentro la quantita' del padre.
 *
 * LA QUANTITA' BASE NON E' UN DETTAGLIO. Le quantita' di posizione di una distinta sono riferite
 * alla quantita' base della TESTATA (`bill_of_material_base_quant`), che vale 1 nella maggior
 * parte dei casi ma vale 100 o 1000 nei settori a ricetta — dove l'errore sarebbe di due o tre
 * ordini di grandezza e nessuno se ne accorgerebbe finche' Plex non chiede materiale per mille
 * pezzi invece che per uno.
 *
 * Base assente o zero => si assume 1, e il chiamante lo DICHIARA: assumere in silenzio andrebbe
 * bene solo se l'assunzione fosse sempre giusta.
 *
 * @param {number} parentQty quantita' del padre (il fantasma) nel contesto che lo contiene
 * @param {number} itemQty quantita' della posizione figlia dentro la distinta del fantasma
 * @param {number} bomBaseQty quantita' base della distinta del fantasma
 * @returns {{ quantity: number, assumedBase: boolean }}
 */
function childQuantity(parentQty, itemQty, bomBaseQty) {
  const base = num(bomBaseQty, 0);
  const assumedBase = !(base > 0);
  const divisor = assumedBase ? 1 : base;
  return { quantity: (num(parentQty, 0) * num(itemQty, 0)) / divisor, assumedBase };
}

// ================================================================
// [W1-05] Quantita' e unita' REALI dei componenti diretti del ciclo
// ================================================================

/**
 * La chiave di join fra un'assegnazione componenti del ciclo e una posizione di distinta.
 *
 * LA DISTINTA E' IN CHIAVE, E NON E' PEDANTERIA: `STLKN` e' unico DENTRO una distinta, non fra
 * alternative diverse dello stesso materiale. Senza il numero di distinta un nodo `00000001`
 * dell'una coinciderebbe con un nodo `00000001` dell'altra, e la riga prenderebbe la quantita'
 * del componente sbagliato — un errore che nessuno vedrebbe mai, perche' il numero c'e' ed e'
 * plausibile.
 *
 * CONFRONTO STRETTO, SOLO `trim`. I due lati li ha scritti SAP, quindi vale il lato «stretto» di
 * DEC-51 e gli zeri iniziali NON si allineano: un disallineamento e' un difetto a monte da vedere,
 * e il vecchio `bomNodeKey` di cat-service.js — che li spogliava da entrambe le parti — non va
 * resuscitato. Il precedente in esercizio e' `bomKey` / `belongsToMaterial` di
 * srv/lib/routingMaterialRules.js, che confronta le stesse chiavi allo stesso modo dalla 0015.
 *
 * @param {*} bom numero di distinta (STLNR)
 * @param {*} node nodo di posizione (STLKN)
 * @returns {string}
 */
function bomItemKey(bom, node) {
  return `${str(bom)}|${str(node)}`;
}

/**
 * I decimali con cui la quantita' viene PERSISTITA (`ZPlexRoutingCycleComponent.RequiredQuantity`
 * e' `Decimal(13,3)`, come `STPO-MENGE` in SAP). Serve solo a riconoscere il caso limite qui
 * sotto: la scala non si cambia da qui.
 */
const QTY_SCALE = 3;

/**
 * Vero se una quantita' POSITIVA sparisce nell'arrotondamento alla scala persistita.
 *
 * E' il prezzo dichiarato di `Decimal(13,3)`: con una quantita' base di 1000 — distinte a ricetta —
 * `0,030 / 1000` diventa `0,000`, e su Plex «zero» significa NON CONSUMARE. Indistinguibile da una
 * scelta voluta, se non la si dice.
 * @param {number} q
 * @returns {boolean}
 */
function roundsToZero(q) {
  const n = num(q, 0);
  if (!(n > 0)) return false;
  const f = 10 ** QTY_SCALE;
  return Math.round(n * f) === 0;
}

/**
 * [W1-05] Riempie quantita' e unita' dei componenti dalla distinta del materiale di testata.
 *
 * PERCHE' ESISTE. Il modello routing v3 non espone `STPO-MENGE` / `STPO-MEINS` su
 * `ProductionRoutingCompAlloc` (richiesta R-10 al team Integration, ancora aperta), e il progetto
 * mandava a Plex `1` e `''` su OGNI riga di distinta. Ma l'assegnazione porta il numero di distinta
 * e il NODO della posizione, e la distinta il progetto la legge gia' — e' la stessa lettura che la
 * 0019 usa per riconoscere i fantasma. Mancava solo il join.
 *
 * LA QUANTITA' SI NORMALIZZA A UN PEZZO DI PADRE, e si riusa `childQuantity` con `parentQty = 1`
 * invece di scrivere una seconda formula: le quantita' di posizione sono riferite alla quantita'
 * BASE della testata, che vale 1 quasi sempre e 100 o 1000 nei settori a ricetta, mentre la riga
 * BOM di Plex e' la quantita' per UN pezzo della part padre. Due formule per la stessa regola
 * sarebbero due formule da tenere allineate.
 *
 * UN NODO NON RISOLTO LASCIA IL RIPIEGO E SI CONTA. Togliere il componente sarebbe peggio della
 * quantita' sbagliata: Plex perderebbe un componente da prelevare, e la sparizione non si vede.
 * E' la direzione di DEC-56 — il fantasma non esploso resta in elenco e degrada il run.
 *
 * NON MUTA L'INPUT: restituisce righe nuove.
 *
 * @param {Array<object>} components componenti da `routingComponentsOf` (`_bomNo`,
 *   `BOMItemNodeNumber`, `RequiredQuantity`, `BaseUnit`)
 * @param {Map<string, object>} index da `bomItemKey` a riga normalizzata; puo' portare
 *   `bomNumber` e `baseQty` come proprieta' (vedi `buildBomIndex` in srv/lib/bomExplode.js)
 * @param {{ baseQty?: number, indexedBom?: string }} [opts]
 * @returns {{ components: Array<object>, stats: {
 *   in: number, resolved: number, unresolved: number, otherBom: number,
 *   assumedBase: number, roundedToZero: number, altUnit: Array<object>
 * } }}
 */
function applyBomQuantities(components, index, opts = {}) {
  const list = Array.isArray(components) ? components : [];
  const map = index instanceof Map ? index : new Map();
  const indexedBom = str(opts.indexedBom !== undefined ? opts.indexedBom : map.bomNumber);
  const baseQty = num(opts.baseQty !== undefined ? opts.baseQty : map.baseQty, 0);
  const stats = {
    in: list.length, resolved: 0, unresolved: 0, otherBom: 0,
    assumedBase: 0, roundedToZero: 0, altUnit: []
  };

  const out = list.map((c) => {
    if (!c) return c;
    const node = str(c.BOMItemNodeNumber);
    const bomNo = str(c._bomNo);
    // Una riga senza materiale componente non e' un componente: non la si conta fra le irrisolte,
    // o il contatore direbbe che manca una quantita' che non ha nessun senso di esistere.
    if (!str(c.Material)) return c;

    const row = node ? map.get(bomItemKey(bomNo, node)) : undefined;
    if (!row) {
      stats.unresolved++;
      // La riga punta a una distinta DIVERSA da quella indicizzata: e' una diagnosi piu' precisa
      // di «nodo non trovato», e cambia cosa si va a guardare.
      if (indexedBom && bomNo && bomNo !== indexedBom) stats.otherBom++;
      return c;
    }

    const { quantity, assumedBase } = childQuantity(1, row.Quantity, baseQty);
    if (assumedBase) stats.assumedBase++;
    if (roundsToZero(quantity)) stats.roundedToZero++;
    if (str(row.CompUom) && str(row.BaseUom) && str(row.CompUom) !== str(row.BaseUom)) {
      stats.altUnit.push({ Material: str(c.Material), CompUom: str(row.CompUom), BaseUom: str(row.BaseUom) });
    }
    stats.resolved++;
    return { ...c, RequiredQuantity: quantity, BaseUnit: row.Unit || c.BaseUnit || '' };
  });

  return { components: out, stats };
}

/**
 * Somma le righe che portano lo STESSO materiale sulla stessa operazione.
 *
 * PERCHE' NON SI PUO' LASCIARE A VALLE. `resolveAutoAssignments` (srv/cat-service.js) deduplica
 * i componenti per `Material` tenendo la PRIMA occorrenza: due rami fantasma che portano allo
 * stesso componente diventerebbero una riga sola con la quantita' di uno dei due, e l'altra
 * sparirebbe senza traccia. Sommare qui e' l'unico punto in cui la somma e' ancora possibile.
 *
 * La chiave e' (operazione, materiale): componenti uguali su operazioni diverse sono cose
 * diverse — e' esattamente cio' che i gruppi oggetti servono a decidere.
 *
 * PRIORITA' DEI CAMPI NON SOMMABILI: vince la prima riga, TRANNE `PhantomSource`, che sopravvive
 * se una qualunque delle righe fuse viene da un fantasma. Un componente raggiunto sia per via
 * diretta sia attraverso un fantasma resta marcato: dichiarare in eccesso e' recuperabile,
 * dichiarare in difetto no.
 *
 * `only` LIMITA LA FUSIONE, E IL CHIAMANTE LO USA SEMPRE. Il motore la restringe alle sole righe
 * ESPLOSE: due componenti diretti uguali sulla stessa operazione esistono in SAP anche oggi, e
 * fonderli sarebbe una riga che sparisce dall'albero il giorno in cui si accende l'esplosione —
 * cioe' una modifica a cio' che l'esplosione non doveva toccare. La posizione della prima
 * occorrenza e' conservata: l'albero non si riordina.
 *
 * @param {Array<object>} rows righe con `Material`, `RequiredQuantity` ed eventuale `_opKey`
 * @param {{ only?: (row: object) => boolean }} [opts] fonde solo le righe per cui `only` e' vera;
 *   le altre passano intatte e non fanno da bersaglio a nessuna fusione
 * @returns {Array<object>} nuove righe, ordine di prima apparizione
 */
function mergeSameMaterial(rows, opts = {}) {
  const only = typeof opts.only === 'function' ? opts.only : null;
  const out = [];
  const seen = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    if (only && !only(row)) { out.push(row); continue; }
    const key = `${str(row._opKey)}|${str(row.Material)}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push({ ...row });
      continue;
    }
    const hit = out[at];
    hit.RequiredQuantity = num(hit.RequiredQuantity, 0) + num(row.RequiredQuantity, 0);
    if (!str(hit.BaseUnit) && str(row.BaseUnit)) hit.BaseUnit = row.BaseUnit;
    if (!str(hit.PhantomSource) && str(row.PhantomSource)) hit.PhantomSource = row.PhantomSource;
  }
  return out;
}

// ================================================================
// Le due reti che fermano la ricorsione
// ================================================================

/** Il tetto ammesso per `MaxDepth`, condiviso con la validazione del customizing. */
const MIN_DEPTH = 1;
const MAX_DEPTH = 20;
/** Il valore usato quando il customizing non dice niente. */
const DEFAULT_DEPTH = 5;

/**
 * Si puo' scendere dentro questo fantasma?
 *
 * DUE RETI, PER DUE GUASTI DIVERSI:
 *   - `CYCLE`: il materiale e' gia' nel percorso che ci ha portato fin qui (A contiene B, B
 *     contiene A). E' un dato SAP malato, e va VISTO: la ricorsione si ferma e il fantasma resta
 *     in elenco cosi' com'e', dichiarato.
 *   - `DEPTH`: il percorso e' arrivato al tetto. Non e' necessariamente un anello — puo' essere
 *     una distinta legittimamente profonda — ma oltre il tetto non si va comunque, perche' il
 *     costo e' una lettura SAP per fantasma per livello.
 *
 * L'anello si controlla PRIMA della profondita': con un anello e un tetto alto, dire «troppo
 * profondo» sarebbe una diagnosi giusta e una spiegazione sbagliata.
 *
 * @param {Array<string>} path materiali gia' attraversati, dal primo all'ultimo
 * @param {string} material il fantasma in cui si vorrebbe scendere
 * @param {number} maxDepth
 * @returns {'OK'|'CYCLE'|'DEPTH'}
 */
function guardRecursion(path, material, maxDepth) {
  const trail = Array.isArray(path) ? path.map(str) : [];
  const m = str(material);
  if (m && trail.includes(m)) return 'CYCLE';
  const cap = clampDepth(maxDepth);
  if (trail.length >= cap) return 'DEPTH';
  return 'OK';
}

/**
 * `MaxDepth` riportato dentro i limiti ammessi.
 *
 * Non lancia: un customizing fuori scala non deve impedire un'esecuzione, e la validazione che
 * lo rifiuta sta gia' nell'handler before CREATE/UPDATE. Qui si difende il motore da una riga
 * scritta prima di quella validazione, o da un `null` arrivato dal database.
 * @param {*} v
 * @returns {number} fra MIN_DEPTH e MAX_DEPTH
 */
function clampDepth(v) {
  const n = Math.trunc(num(v, DEFAULT_DEPTH));
  if (!Number.isFinite(n) || n < MIN_DEPTH) return MIN_DEPTH;
  if (n > MAX_DEPTH) return MAX_DEPTH;
  return n;
}

// ================================================================
// Scelta della distinta e configurazione
// ================================================================

/**
 * Fra le distinte di un materiale, quella che il customizing chiede.
 *
 * L'ORDINE DEI CRITERI E' UNA SCELTA. `BomUsage` e `BomVariant` vuoti significano «non ho
 * preferenze», non «nessuna distinta va bene»: si filtra su cio' che e' valorizzato e, fra le
 * superstiti, si prende l'alternativa PIU' BASSA. E' la stessa regola che SAP applica quando
 * nessuna determinazione alternativa e' configurata, ed e' l'unica che dia lo stesso risultato
 * a ogni esecuzione — un ordinamento non dichiarato renderebbe l'albero dipendente dall'ordine
 * in cui l'iFlow ha restituito le righe.
 *
 * @param {Array<object>} bomRows righe di `MaterialBOM` (testate)
 * @param {{ BomUsage?: string, BomVariant?: string }} config
 * @returns {object|null} la testata scelta, `null` se non ce n'e' nessuna
 */
function chooseBom(bomRows, config) {
  const cfg = config || {};
  const usage = str(cfg.BomUsage);
  const variant = str(cfg.BomVariant);
  const candidates = (bomRows || []).filter((b) => {
    if (!b) return false;
    if (!str(b.BillOfMaterial)) return false;
    if (usage && str(b.BillOfMaterialVariantUsage) !== usage) return false;
    if (variant && str(b.BillOfMaterialVariant) !== variant) return false;
    return true;
  });
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => {
    const va = str(a.BillOfMaterialVariant);
    const vb = str(b.BillOfMaterialVariant);
    if (va !== vb) return va < vb ? -1 : 1;
    return str(a.BillOfMaterial) < str(b.BillOfMaterial) ? -1 : 1;
  });
  return sorted[0];
}

/** I due modi ammessi di scegliere la data di esplosione. */
const DATE_MODES = Object.freeze(['TODAY', 'ORDER_START_DATE']);

/**
 * La configurazione, riportata alla forma che il motore si aspetta.
 *
 * RIGA ASSENTE = MOTORE SPENTO, non «motore con i default». I default dei campi servono a una
 * riga che esiste ed e' incompleta; una riga che non esiste e' una decisione del cliente di non
 * usare la funzione, e va resa come tale (feature 0019, e l'opposto di DEC-52 per una ragione
 * scritta nel docblock di ZPhantomExplodeConfig).
 *
 * @param {object|null|undefined} row riga di ZPhantomExplodeConfig, oppure niente
 * @returns {{ exists: boolean, MaxDepth: number, BomUsage: string, BomVariant: string,
 *            EffectivityDateMode: string, ExplodeInRouting: boolean, ExplodeInProdOrder: boolean }}
 */
function normalizeConfig(row) {
  if (!row) {
    return {
      exists: false,
      MaxDepth: DEFAULT_DEPTH,
      BomUsage: '',
      BomVariant: '',
      EffectivityDateMode: 'TODAY',
      ExplodeInRouting: false,
      ExplodeInProdOrder: false,
      RoutingBomKeyDate: '',
      // [ROUTING-DEFAULT-OP] Riga assente = component allocation, cioe' il comportamento di sempre.
      RoutingCompDefaultOp: false,
      RoutingCompDefaultOpTarget: ''
    };
  }
  const mode = str(row.EffectivityDateMode).toUpperCase();
  return {
    exists: true,
    MaxDepth: clampDepth(row.MaxDepth),
    BomUsage: str(row.BomUsage),
    BomVariant: str(row.BomVariant),
    EffectivityDateMode: DATE_MODES.includes(mode) ? mode : 'TODAY',
    ExplodeInRouting: row.ExplodeInRouting === true,
    ExplodeInProdOrder: row.ExplodeInProdOrder === true,
    // [ROUTING-COMP-SOURCE] Passa GREZZA: qui non si interpreta una data, si trasporta il campo
    // fino a chi lo usa. La normalizzazione e' in srv/lib/routingCompSourceRules.js, insieme alla
    // regola che una data illeggibile spegne la seconda lettura invece di inventarne una.
    RoutingBomKeyDate: row.RoutingBomKeyDate instanceof Date
      ? row.RoutingBomKeyDate : str(row.RoutingBomKeyDate),
    // [ROUTING-DEFAULT-OP] I due campi dell'allocazione dichiarata (feature 0051). Come per la data
    // qui sopra: si TRASPORTANO, non si interpretano. Il verdetto — acceso ma senza un bersaglio
    // valido vale SPENTO, e non FIRST_OP per ripiego — sta in srv/lib/routingCompSourceRules.js,
    // accanto alle sentinelle FIRST_OP/LAST_OP che quel modulo dichiara gia'. Metterlo qui
    // significherebbe una terza dichiarazione delle due parole, e questo modulo non ha dipendenze.
    //
    // `NULL` e `false` devono uscire uguali: la colonna arriva su una tabella gia' popolata.
    RoutingCompDefaultOp: row.RoutingCompDefaultOp === true,
    RoutingCompDefaultOpTarget: str(row.RoutingCompDefaultOpTarget).toUpperCase()
  };
}

// ================================================================
// La forma della chiamata a ExplodeBOM
// ================================================================

/**
 * L'ORDINE dei parametri in query string: quello dell'esempio §6 riga 189 del contratto
 * (`srv/external/Endpoint_OData_Integration-20260728 (1).md`), non quello dell'EDMX. In una query
 * string l'ordine non conta per OData — ma a leggerla e' `GetQueryFilter.groovy`, uno script
 * scritto a mano, e l'unica forma di cui sappiamo che il team Integration ha discusso e' quella.
 */
const EXPLODE_PARAM_ORDER = Object.freeze([
  'Material', 'Plant', 'BillOfMaterialCategory', 'BillOfMaterialVariant',
  'BillOfMaterialVersion', 'EngineeringChangeDocument', 'BillOfMaterial'
]);

/** I due parametri obbligatori che nessuno valorizza mai, e il loro riempimento. */
const EXPLODE_FILLED_KEYS = Object.freeze(['BillOfMaterialVersion', 'EngineeringChangeDocument']);
/** La stringa vuota, com'e' nell'esempio del contratto (indicazione del 2026-08-14). */
const EXPLODE_KEY_FILL = '';
/** La quantita' richiesta dello screenshot. Le quantita' le riscala `childQuantity`, non SAP. */
const EXPLODE_REQUIRED_QUANTITY = '0';

/** Lo spazio codificato, e NIENT'ALTRO: un apice a `%27` non sarebbe piu' un literal OData. */
function encSpace(s) {
  return String(s).replace(/ /g, '%20');
}

/** Il valore cosi' com'e', senza trim: un riempimento a spazio deve poter restare uno spazio. */
function rawVal(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

/** Un `Edm.DateTime` come literal OData V2: `datetime'2026-08-18T00:00:00'`. */
function datetimeLiteral(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `datetime'${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00'`;
}

/**
 * LA CHIAMATA ALL'ESPLOSIONE, nella forma contrattuale: `Nome?P1='v1'&P2='v2'&…`.
 *
 * `ExplodeBOM` NON e' un entity set: nell'EDMX e' un `<FunctionImport m:HttpMethod="GET">` con 21
 * parametri, quindi **non c'e' nessun key predicate da scrivere** e i parametri stanno nella query
 * string. La prima versione della sonda mandava un key predicate ed e' morta sulla guardia
 * dell'iFlow (`if (!query) throw …` in `GetQueryFilter.groovy`), perche' in una lettura per chiave
 * la query string e' VUOTA. La storia intera e' in DEC-44/DEC-45: la misurò la sonda della distinta
 * base, rimossa il 03/09/2026.
 *
 * QUESTA FUNZIONE E' L'UNICA DEFINIZIONE DELLA FORMA, e la usano entrambi: la sonda per la sua
 * variante contrattuale (`EXPL.par`) e la lettura d'esercizio di srv/lib/bomExplode.js. Se
 * divergessero, la sonda continuerebbe a dire «passa» mentre l'esercizio fallisce — cioe' il
 * peggior modo possibile di avere una diagnostica.
 *
 * Le stringhe vanno fra apici (sintassi dei literal OData); `RequiredQuantity` e' un numero e va
 * nudo. I due parametri di `EXPLODE_FILLED_KEYS`, se vuoti, ricevono il riempimento — ed e' l'unico
 * punto in cui questa scelta viene fatta.
 *
 * @param {string} entitySet nome del function import (`ExplodeBOM`)
 * @param {object} values valori per nome di parametro
 * @param {object} [opts]
 * @param {string} [opts.requiredQuantity] default `EXPLODE_REQUIRED_QUANTITY`
 * @param {Date|null} [opts.explosionDate] se data, aggiunge `BOMExplosionDate`
 * @returns {string} il suffisso da accodare al service root, gia' codificato
 */
function explodeQuery(entitySet, values, opts = {}) {
  const filled = { ...(values || {}) };
  for (const k of EXPLODE_FILLED_KEYS) {
    if (str(filled[k]) === '') filled[k] = EXPLODE_KEY_FILL;
  }
  const parts = EXPLODE_PARAM_ORDER.map((k) => `${k}='${encSpace(rawVal(filled[k]))}'`);
  const qty = opts.requiredQuantity === undefined ? EXPLODE_REQUIRED_QUANTITY : opts.requiredQuantity;
  parts.push(`RequiredQuantity=${qty}`);
  if (opts.explosionDate) {
    parts.push(`BOMExplosionDate=${encSpace(datetimeLiteral(opts.explosionDate))}`);
  }
  return `${entitySet}?${parts.join('&')}`;
}

/**
 * Le righe di una risposta OData V2, da qualunque involucro arrivino.
 *
 * TRE INVOLUCRI POSSIBILI e nessuno garantito: `{d:{results:[…]}}` e' la forma di una collection
 * V2, `{d:[…]}` e `{value:[…]}` sono quelle che si incontrano quando l'iFlow rimaneggia la
 * risposta. Un involucro non riconosciuto deve dare ZERO RIGHE, non lanciare: il chiamante lo
 * dichiara come «esplosione senza righe», che e' una diagnosi, mentre un `TypeError` sarebbe un
 * guasto del nostro codice su un dato di SAP.
 *
 * @param {*} body
 * @returns {Array<object>}
 */
function unwrapRows(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.value)) return body.value;
  const d = body.d;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.results)) return d.results;
  return [];
}

/**
 * Errori del customizing, nella forma dei validatori dell'app (chiave i18n + argomenti).
 *
 * Non rifiuta un `MaxDepth` fuori scala «per sicurezza»: lo rifiuta perche' un valore che il
 * motore andrebbe comunque a riportare dentro i limiti sarebbe un customizing che MENTE — la
 * schermata direbbe 99, l'esecuzione ne userebbe 20.
 *
 * @param {object} row riga in scrittura, gia' fusa con l'esistente sull'UPDATE
 * @returns {Array<{ key: string, args: Array<*>, field: string }>} vuoto = valida
 */
function validateConfig(row) {
  const errors = [];
  const r = row || {};
  const depth = num(r.MaxDepth, NaN);
  if (!Number.isFinite(depth) || !Number.isInteger(depth) || depth < MIN_DEPTH || depth > MAX_DEPTH) {
    errors.push({ key: 'phxDepthRange', args: [MIN_DEPTH, MAX_DEPTH, str(r.MaxDepth) || '(vuoto)'], field: 'MaxDepth' });
  }
  const mode = str(r.EffectivityDateMode).toUpperCase();
  if (mode && !DATE_MODES.includes(mode)) {
    errors.push({ key: 'phxDateModeInvalid', args: [str(r.EffectivityDateMode), DATE_MODES.join(', ')], field: 'EffectivityDateMode' });
  }
  // [ROUTING-COMP-SOURCE] La data della seconda lettura del ramo cicli. Vuota e' legittima —
  // significa «seconda lettura spenta» — ma SCRITTA MALE no: a runtime diventerebbe anch'essa
  // «spenta», cioe' un campo compilato che non fa niente, che e' il difetto che DEC-27 rifiuta.
  //
  // NELLA PRATICA QUESTO CONTROLLO NON SCATTA QUASI MAI, ed e' giusto cosi': la colonna e' un
  // `Date`, quindi una stringa non convertibile viene rifiutata dalla validazione di tipo di CAP
  // nella fase `_initial`, PRIMA di questo handler e con un messaggio tecnico che non possiamo
  // riscrivere (DEC-40). La difesa utile e' lato client, ed e' nel DatePicker della scheda. Il
  // controllo resta perche' il giorno in cui il valore arrivasse gia' convertito — o la colonna
  // cambiasse tipo — l'unica alternativa sarebbe accorgersene dal fatto che il job non aggiunge
  // piu' niente.
  const keyDate = r.RoutingBomKeyDate;
  const keyDateStr = keyDate instanceof Date ? '' : str(keyDate);
  if (keyDateStr && !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(keyDateStr)) {
    errors.push({ key: 'phxKeyDateInvalid', args: [keyDateStr], field: 'RoutingBomKeyDate' });
  }
  return errors;
}

module.exports = {
  // normalizzazione
  str,
  num,
  bool,
  normalizeRow,
  // riconoscimento
  isPhantom,
  ITEM_CATEGORY_PHANTOM,
  SPECIAL_PROCUREMENT_PHANTOM,
  // quantita'
  childQuantity,
  mergeSameMaterial,
  // [W1-05] quantita' e unita' reali dei componenti diretti
  bomItemKey,
  applyBomQuantities,
  roundsToZero,
  QTY_SCALE,
  // ricorsione
  guardRecursion,
  clampDepth,
  MIN_DEPTH,
  MAX_DEPTH,
  DEFAULT_DEPTH,
  // forma della chiamata a ExplodeBOM
  explodeQuery,
  unwrapRows,
  datetimeLiteral,
  EXPLODE_PARAM_ORDER,
  EXPLODE_FILLED_KEYS,
  EXPLODE_KEY_FILL,
  EXPLODE_REQUIRED_QUANTITY,
  // distinta e configurazione
  chooseBom,
  normalizeConfig,
  validateConfig,
  DATE_MODES
};

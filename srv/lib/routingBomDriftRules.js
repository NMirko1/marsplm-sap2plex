/**
 * [ROUTING-BOM-DRIFT] Il ciclo si confronta con Plex, non col proprio orologio (feature 0047).
 *
 * PERCHE' ESISTE
 * Il job `ROUTING_SYNC` decideva cosa inviare guardando UN SOLO DATO, e non era SAP:
 * `MAX(modifiedAt)` sulle righe di `ZPlexRoutingCycleOperation`, cioe' la data dell'ultimo
 * SALVATAGGIO LOCALE. Conseguenza: un componente modificato, aggiunto o tolto in SAP — o una
 * regola dei gruppi oggetto cambiata — non muove nessuna riga locale, quindi il ciclo cadeva fra i
 * «non modificati» e il run chiudeva VERDE, senza una voce. Su Plex restava la distinta di ieri, e
 * nessuno lo sapeva. Il ricalcolo dei componenti gira DENTRO l'invio: corregge un ciclo che sta
 * partendo, non lo fa partire.
 *
 * Qui vive il verdetto, e solo il verdetto: dato l'elenco desiderato (SAP + regole), l'albero
 * salvato e la distinta letta da Plex, si invia o non si invia — e perche'. L'orchestrazione
 * (letture, chiamate, log, recap) resta nel passo 5 di `syncRoutingPlexCycle` in
 * srv/cat-service.js e nel job srv/jobs/syncRoutingsToPlex.js.
 *
 * NON SI INVENTA UN SECONDO CRITERIO DI CONFRONTO. La domanda «questa riga di distinta e' diversa
 * da quella su Plex?» ha gia' una risposta nel progetto: `plexBomRules.decideBomAction`, la stessa
 * funzione con cui l'invio decide POST / PATCH / SKIP, con la sua `QTY_TOLERANCE`. Se il verdetto di
 * qui e quello dell'invio divergessero, il job reinvierebbe cicli che l'invio poi salta — cioe' un
 * reinvio perenne, in verde. Da qui la regola generale di questo modulo:
 *
 *     ==> UNA DIFFERENZA CHE IL REINVIO NON SISTEMA NON E' UN MOTIVO PER REINVIARE. <==
 *
 * E' la ragione dei tre casi che si DICHIARANO senza far partire niente:
 *   1. le righe in ECCESSO su Plex (un componente tolto in SAP, o spostato di operazione: la
 *      riga vecchia resta). L'allineamento della distinta e' ADDITIVO — il progetto non chiama
 *      `POST /engineering/v1/boms/{id}/deactivate`, vedi «Cosa non usiamo» in
 *      srv/external/PLEX_BOM_API_CONTRACT.md — quindi un reinvio non le tocca: contarle come
 *      disallineamento significherebbe reinviare ogni notte, per sempre, senza rimediare a niente;
 *   2. un componente che su quel plant NON E' UNA PART, o la cui operazione non e' su Plex: l'invio
 *      lo salta con `SKIPPED_NOT_A_PART`, quindi il reinvio non cambia l'esito;
 *   3. `SKIP/NO_ID` — quantita' diversa su una riga che Plex ha restituito senza `id`: l'invio non
 *      puo' fare il `PATCH` (serve l'id), quindi nemmeno qui il reinvio sistema qualcosa.
 *
 * E LA GUARDIA CHE ROMPE IN SILENZIO: `remoteKnown !== true` ==> NESSUN DISALLINEAMENTO. Con la
 * lettura della distinta caduta la mappa remota e' VUOTA e ogni componente appare assente: il
 * reinvio partirebbe su tutto, e su una lettura fallita. E' `remoteKnown` di [PART-ALIVE]
 * (DEC-112) e il flag «ho letto il remoto» di [WC-SUBTRACT] (DEC-78) — **vuoto non e' ignoto**.
 * Il confronto e' `=== true` e non `!!`: un chiamante che si dimentica di passare il flag riceve
 * `undefined`, e `undefined` non deve valere «la lettura e' andata bene».
 *
 * ATTENZIONE ALLE DUE CHIAVI, CHE NON SI CONFRONTANO ALLO STESSO MODO.
 *   - Fra l'albero salvato e l'elenco desiderato il confronto e' STRETTO (`trim` e nient'altro):
 *     sono due nostri dati, e un disallineamento di grafia e' un difetto da vedere (DEC-51).
 *   - Verso Plex e' INSENSIBILE ALLA GRAFIA: `partOperationId` arriva dalla GET delle
 *     part-operation e `componentPartId` dalla GET della distinta, cioe' da DUE chiamate Plex
 *     diverse, ed e' esattamente il caso di DEC-63 (W1-03). Con il confronto stretto un tenant che
 *     restituisse gli UUID con una maiuscola diversa fra le due risposte darebbe «tutto assente».
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' `process.env`, ne' orologio. L'unico
 * `require` e' un altro modulo puro. Non aggiungerne: il test si lancia con
 *     node test/routingBomDriftRules.test.js
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

const plexBomRules = require('./plexBomRules');

// ================================================================
// Verdetti
// ================================================================

/**
 * Perche' si invia, oppure perche' no. Stringhe e non numeri: finiscono nei `console.log` del job e
 * nel JSON della risposta, e un verdetto va letto senza una legenda accanto.
 *
 * L'ORDINE DI QUESTO ELENCO E' L'ORDINE DI VALUTAZIONE di `decideVerify`, ed e' parte della regola:
 * `REMOTE_UNKNOWN` viene per primo perche' su una lettura caduta non si conclude NIENTE, e
 * `OPS_MISSING` prima delle cause di distinta perche' senza la part-operation un componente non ha
 * nemmeno un posto dove stare.
 */
const REASON = Object.freeze({
  /** Una delle due letture Plex non e' riuscita: non si conclude niente e non si invia. */
  REMOTE_UNKNOWN: 'REMOTE_UNKNOWN',
  /** Operazioni del ciclo che su Plex non ci sono: si invia (le creera' il passo 6c). */
  OPS_MISSING: 'OPS_MISSING',
  /** L'albero salvato non e' piu' quello che SAP e le regole dicono: si invia. */
  LOCAL_CHANGED: 'LOCAL_CHANGED',
  /** Componenti desiderati che sulla distinta Plex non ci sono: si invia. */
  BOM_MISSING: 'BOM_MISSING',
  /** Righe presenti su Plex con una quantita' diversa: si invia (il `PATCH` la corregge). */
  BOM_QTY: 'BOM_QTY',
  /** Tutto combacia: non si invia, e non e' un difetto. */
  ALIGNED: 'ALIGNED'
});

/** `trim` e nient'altro: come `routingSyncSkipRules.clean`, qui non si decide il formato di SAP. */
const clean = (v) => String(v ?? '').trim();

/**
 * La chiave di confronto verso PLEX: minuscola, perche' i due lati vengono da due chiamate Plex
 * diverse (DEC-63). `plexBomRules.bomKey` non si tocca — la usa l'invio, dove la mappa e' costruita
 * e riletta con gli stessi valori grezzi — ma qui la sua forma grezza darebbe falsi «assente».
 */
const remoteKey = (partOperationId, componentId) =>
  plexBomRules.bomKey(clean(partOperationId).toLowerCase(), clean(componentId).toLowerCase());

/** La chiave di confronto fra due NOSTRE righe: materiale + operazione, stretta. */
const localKey = (material, operationId) => `${clean(material)}|${clean(operationId)}`;

/** Numero utilizzabile come quantita'. Stesso ripiego a 0 di `plexBomRules.toQuantity`. */
function qty(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Due quantita' sono uguali entro la tolleranza dell'invio?
 *
 * IL CONFRONTO E' `<=` E NON `<`, E LA DIFFERENZA E' UN REINVIO PERENNE. Serve solo a `diffLocal`,
 * cioe' al confronto fra la quantita' che SAP dice e quella PERSISTITA sull'albero, e
 * `ZPlexRoutingCycleComponent.RequiredQuantity` e' un `Decimal(13, 3)`: l'errore di arrotondamento
 * della persistenza vale al massimo `0,0005`, cioe' esattamente `QTY_TOLERANCE`. Con `<` una
 * quantita' SAP il cui quarto decimale e' un `5` — `1,2345` -> `1,234` o `1,235` — resterebbe
 * «diversa» dopo ogni salvataggio: il ciclo verrebbe reinviato ogni notte, in verde, e la
 * riscrittura locale non potrebbe farci niente perche' il valore torna arrotondato uguale.
 *
 * `decideBomAction` resta com'e' (`>=` sul lato «diverso»): la' i due lati sono entrambi
 * arrotondati — quello che si manda a Plex E' il valore persistito — quindi il caso non esiste.
 */
function sameQuantity(a, b, tolerance) {
  const tol = Number.isFinite(tolerance) ? tolerance : plexBomRules.QTY_TOLERANCE;
  return Math.abs(qty(a) - qty(b)) <= tol;
}

// ================================================================
// SAP + regole  <->  albero salvato
// ================================================================

/**
 * L'albero salvato e' ancora quello che SAP e le regole dicono?
 *
 * E' il confronto che rende visibile la modifica fatta in SAP: `desired` viene dalle due letture
 * SAP passate per le regole dei gruppi (`planCycleComponents`), `stored` e' cio' che c'e' nelle
 * tabelle del ciclo. Comprende gli SPOSTAMENTI decisi dalle regole, che sono la ragione per cui il
 * ricalcolo va fatto a ogni run: un componente che cambia operazione perche' e' cambiata una regola
 * non lascia altra traccia.
 *
 * PERCHE' `removed` FA PARTIRE UN INVIO, benche' su Plex la riga non venga tolta. Perche' la
 * POTATURA DELL'ALBERO SALVATO avviene all'invio: senza quell'invio la riga locale resterebbe li'
 * per sempre e questo confronto la ritroverebbe ogni notte — un disallineamento perenne. Con
 * l'invio si converge in UN giro: l'albero si allinea, la riga su Plex diventa un ECCESSO, e
 * l'eccesso non fa ripartire niente. Il reinvio quindi TERMINA, ed e' la proprieta' da non perdere.
 *
 * @param {object} args
 * @param {Array<object>} [args.desired] righe volute: `{Material, PlexOperationId, RequiredQuantity}`
 *        (`compPlan.rows` piu' `compPlan.manualKept`)
 * @param {Array<object>} [args.stored] righe di `ZPlexRoutingCycleComponent` del ciclo
 * @param {number} [args.tolerance]
 * @returns {{changed: boolean, added: Array, removed: Array, moved: Array, qtyDiff: Array,
 *            counts: object}}
 */
function diffLocal({ desired, stored, tolerance } = {}) {
  const want = Array.isArray(desired) ? desired.filter(Boolean) : [];
  const have = Array.isArray(stored) ? stored.filter(Boolean) : [];

  const haveByKey = new Map();
  const haveByMaterial = new Map();
  for (const r of have) {
    const material = clean(r.Material);
    if (!material) continue;
    haveByKey.set(localKey(material, r.PlexOperationId), r);
    if (!haveByMaterial.has(material)) haveByMaterial.set(material, r);
  }

  const added = [];
  const moved = [];
  const qtyDiff = [];
  const wantKeys = new Set();

  for (const r of want) {
    const material = clean(r.Material);
    if (!material) continue;
    const key = localKey(material, r.PlexOperationId);
    wantKeys.add(key);
    const exact = haveByKey.get(key);
    if (exact) {
      if (!sameQuantity(exact.RequiredQuantity, r.RequiredQuantity, tolerance)) {
        qtyDiff.push({
          Material: material,
          From: qty(exact.RequiredQuantity),
          To: qty(r.RequiredQuantity)
        });
      }
      continue;
    }
    // Stesso materiale, altra operazione: e' uno SPOSTAMENTO e non una riga nuova. La distinzione
    // non e' estetica — chi legge il recap deve sapere se in fabbrica comparira' un componente
    // nuovo o se lo stesso si sposta di operazione.
    const elsewhere = haveByMaterial.get(material);
    if (elsewhere) {
      moved.push({
        Material: material,
        From: clean(elsewhere.PlexOperationId),
        To: clean(r.PlexOperationId)
      });
    } else {
      added.push({ Material: material, To: clean(r.PlexOperationId) });
    }
  }

  // Cio' che l'albero ha e SAP (con le regole) non vuole piu'. Un materiale spostato NON e' qui:
  // la sua chiave vecchia non e' fra le volute, ma il materiale si', quindi si conta una volta sola
  // come spostamento.
  const movedMaterials = new Set(moved.map((m) => m.Material));
  const removed = [];
  for (const r of have) {
    const material = clean(r.Material);
    if (!material) continue;
    if (wantKeys.has(localKey(material, r.PlexOperationId))) continue;
    if (movedMaterials.has(material)) continue;
    removed.push({ Material: material, From: clean(r.PlexOperationId) });
  }

  const counts = {
    desired: want.length,
    stored: have.length,
    added: added.length,
    removed: removed.length,
    moved: moved.length,
    qtyDiff: qtyDiff.length
  };
  return {
    changed: added.length > 0 || removed.length > 0 || moved.length > 0 || qtyDiff.length > 0,
    added,
    removed,
    moved,
    qtyDiff,
    counts
  };
}

// ================================================================
// Albero  <->  distinta su Plex
// ================================================================

/**
 * Le righe che ci ASPETTIAMO di trovare sulla distinta Plex, con la loro chiave remota.
 *
 * Tradurre una riga dell'albero in una riga di distinta Plex richiede due dizionari, e sono gli
 * stessi due che usa l'invio al passo 7c: l'operazione locale -> `partOperationId` (dalla GET delle
 * part-operation) e il materiale -> `componentId` (da `ZMatPlexMapping` per la coppia
 * materiale/plant). Cio' che non si traduce NON E' un disallineamento: e' un componente che
 * l'invio salterebbe di nuovo, quindi finisce in `unresolved` e si dichiara.
 *
 * @param {object} args
 * @param {Array<object>} [args.rows] righe volute `{Material, PlexOperationId, RequiredQuantity, BaseUnit}`
 * @param {object|Map} [args.partOpIdByOperationId] operazione Plex -> partOperationId
 * @param {object|Map} [args.componentIdByMaterial] materiale -> PlexId del componente
 * @returns {{entries: Array<object>, unresolved: Array<object>}}
 */
function expectedBomRows({ rows, partOpIdByOperationId, componentIdByMaterial } = {}) {
  const get = (dict, k) => {
    if (!dict || !k) return '';
    if (typeof dict.get === 'function') return clean(dict.get(k));
    return clean(dict[k]);
  };

  const entries = [];
  const unresolved = [];
  const seen = new Set();

  for (const r of (Array.isArray(rows) ? rows.filter(Boolean) : [])) {
    const material = clean(r.Material);
    const operationId = clean(r.PlexOperationId);
    if (!material) continue;

    const partOperationId = get(partOpIdByOperationId, operationId);
    if (!partOperationId) {
      // L'operazione non e' (ancora) su Plex. Non e' un disallineamento di distinta: se manca
      // davvero, la dichiara `OPS_MISSING`, che si valuta prima di questa.
      unresolved.push({ Material: material, OperationId: operationId, Reason: 'NO_PART_OPERATION' });
      continue;
    }
    const componentId = get(componentIdByMaterial, material);
    if (!componentId) {
      unresolved.push({ Material: material, OperationId: operationId, Reason: 'NO_COMPONENT_PART' });
      continue;
    }

    const key = remoteKey(partOperationId, componentId);
    if (seen.has(key)) continue;   // stessa riga due volte: la distinta Plex ne ha una sola
    seen.add(key);
    entries.push({
      Key: key,
      Material: material,
      OperationId: operationId,
      partOperationId,
      componentId,
      Quantity: qty(r.RequiredQuantity),
      Uom: clean(r.BaseUnit)
    });
  }
  return { entries, unresolved };
}

/**
 * Il confronto dritto per dritto fra le righe attese e la distinta letta da Plex.
 *
 * `remote` e' la mappa costruita dall'invio con `plexBomRules.readBomRow` (chiave grezza): qui si
 * RE-INDICIZZA in minuscolo, per la ragione scritta in testa al modulo. Il verdetto su ogni riga lo
 * da' `plexBomRules.decideBomAction`, di cui si legge SOLO `action`: il resto (stato del flag
 * `autoDeplete`) e' una faccenda dell'invio e qui non entra.
 *
 * `declareExtra` E' L'ALTRA FACCIA DELLA GUARDIA, e vale sull'insieme di CASA. Le righe in eccesso
 * si ricavano per sottrazione dagli attesi, quindi un elenco desiderato piu' STRETTO del vero le
 * gonfia: con la seconda lettura della distinta non riuscita, o fatta a una data che il canale non
 * onora, ogni componente non letto apparirebbe «di troppo su Plex». E' lo stesso `sourceComplete`
 * che in [COMP-ORPHAN] (0037) autorizza la potatura, e per la stessa ragione: si sottrae solo su
 * una fotografia completa. Sui `missing` non serve — un insieme piu' stretto puo' solo chiedere
 * MENO, mai una riga che non esiste.
 *
 * @param {object} args
 * @param {Array<object>} [args.expected] da `expectedBomRows().entries`
 * @param {Map<string,object>|Array<object>} [args.remote] righe lette da Plex
 * @param {boolean} [args.remoteKnown] la lettura della distinta e' riuscita?
 * @param {boolean} [args.declareExtra=true] l'elenco desiderato e' completo? (`sourceComplete`)
 * @param {number} [args.tolerance]
 * @returns {{drift: boolean, missing: Array, qtyDiff: Array, extra: Array, noId: Array,
 *            remoteKnown: boolean, extraKnown: boolean, counts: object}}
 */
function diffBom({ expected, remote, remoteKnown, declareExtra, tolerance } = {}) {
  const want = Array.isArray(expected) ? expected.filter(Boolean) : [];
  const extraKnown = declareExtra !== false;
  const empty = {
    drift: false,
    missing: [],
    qtyDiff: [],
    extra: [],
    noId: [],
    remoteKnown: false,
    extraKnown,
    counts: { expected: want.length, remote: 0, missing: 0, qtyDiff: 0, extra: 0, noId: 0 }
  };
  // La guardia. Vuoto non e' ignoto: senza la lettura non si dichiara niente e non si invia.
  if (remoteKnown !== true) return empty;

  const byKey = new Map();
  const rows = remote instanceof Map ? [...remote.values()]
    : (Array.isArray(remote) ? remote.filter(Boolean) : []);
  for (const row of rows) {
    if (!row || !row.partOperationId || !row.componentPartId) continue;
    byKey.set(remoteKey(row.partOperationId, row.componentPartId), row);
  }

  const missing = [];
  const qtyDiff = [];
  const noId = [];
  for (const e of want) {
    const existing = byKey.get(e.Key) || null;
    // Solo `action`: la decisione e' la STESSA che prendera' l'invio su questa riga.
    const { action, reason } = plexBomRules.decideBomAction({
      existing,
      desiredQuantity: e.Quantity,
      tolerance
    });
    if (action === 'POST') {
      missing.push({ Material: e.Material, OperationId: e.OperationId, Quantity: e.Quantity });
    } else if (action === 'PATCH') {
      qtyDiff.push({
        Material: e.Material,
        OperationId: e.OperationId,
        From: qty(existing && existing.quantity),
        To: e.Quantity
      });
    } else if (reason === 'NO_ID') {
      // Quantita' diversa, ma Plex non ha dato l'id della riga: il `PATCH` non e' possibile,
      // quindi il reinvio non sistema niente. Si dichiara.
      noId.push({
        Material: e.Material,
        OperationId: e.OperationId,
        From: qty(existing && existing.quantity),
        To: e.Quantity
      });
    }
  }

  // Le righe in ECCESSO: su Plex e non fra le attese. Si DICHIARANO e non fanno partire niente,
  // per la ragione in testa al modulo (l'allineamento e' additivo, non c'e' `deactivate`).
  const wantKeys = new Set(want.map((e) => e.Key));
  const extra = [];
  if (extraKnown) {
    for (const [key, row] of byKey) {
      if (wantKeys.has(key)) continue;
      extra.push({
        partOperationId: clean(row.partOperationId),
        componentPartId: clean(row.componentPartId),
        Quantity: qty(row.quantity)
      });
    }
  }

  return {
    drift: missing.length > 0 || qtyDiff.length > 0,
    missing,
    qtyDiff,
    extra,
    noId,
    remoteKnown: true,
    extraKnown,
    counts: {
      expected: want.length,
      remote: byKey.size,
      missing: missing.length,
      qtyDiff: qtyDiff.length,
      extra: extra.length,
      noId: noId.length
    }
  };
}

// ================================================================
// Il verdetto
// ================================================================

/**
 * Si invia? E' la funzione che il cancello dell'action chiama, e l'unico punto in cui le tre
 * sorgenti di verdetto si mettono insieme.
 *
 * L'ORDINE E' PARTE DELLA REGOLA (vedi `REASON`). Le due letture si guardano per PRIME: con la GET
 * delle part-operation caduta `remoteByOpId` e' vuota e OGNI operazione appare da creare, cioe' il
 * caso in cui il reinvio partirebbe su tutto proprio perche' non si e' potuto leggere niente.
 *
 * @param {object} args
 * @param {boolean} [args.opsReadOk]   la GET delle part-operation e' riuscita?
 * @param {number}  [args.opsMissing]  quante operazioni del ciclo non sono su Plex
 * @param {object}  [args.local]       da `diffLocal`
 * @param {object}  [args.bom]         da `diffBom`
 * @returns {{send: boolean, reason: string}}
 */
function decideVerify({ opsReadOk, opsMissing, local, bom } = {}) {
  if (opsReadOk !== true || !bom || bom.remoteKnown !== true) {
    return { send: false, reason: REASON.REMOTE_UNKNOWN };
  }
  if (Number(opsMissing) > 0) return { send: true, reason: REASON.OPS_MISSING };
  if (local && local.changed === true) return { send: true, reason: REASON.LOCAL_CHANGED };
  if (bom.missing && bom.missing.length > 0) return { send: true, reason: REASON.BOM_MISSING };
  if (bom.qtyDiff && bom.qtyDiff.length > 0) return { send: true, reason: REASON.BOM_QTY };
  return { send: false, reason: REASON.ALIGNED };
}

// ================================================================
// Dichiarazioni
// ================================================================

/** I primi `n` materiali di una lista di differenze, per gli esempi delle voci di recap. */
function sampleMaterials(list, n = 5) {
  return (Array.isArray(list) ? list : [])
    .slice(0, n)
    .map((r) => clean(r && r.Material))
    .filter(Boolean)
    .join(', ');
}

/**
 * [LOG-MSG-I18N] I segmenti che dichiarano il confronto, o `[]` se non c'e' niente da dire.
 *
 * Ogni causa col SUO nome e mai fuse insieme (DEC-56): «manca su Plex» e «la quantita' e' diversa»
 * portano a due verifiche diverse, e «resta di piu' su Plex» e' l'unica che nessun reinvio
 * sistemera'. L'ordine e' l'ordine di importanza, perche' `logMessage.pack` scarta segmenti interi
 * dalla coda.
 *
 * @param {object} args
 * @param {object} [args.local] da `diffLocal`
 * @param {object} [args.bom] da `diffBom`
 * @param {Array<object>} [args.unresolved] da `expectedBomRows().unresolved`
 * @returns {Array<{c: string, p?: Array}>}
 */
function driftSegments({ local, bom, unresolved } = {}) {
  const out = [];
  const b = bom || {};
  const l = local || {};
  if (b.remoteKnown !== true) {
    out.push({ c: 'logRoutingBomNotVerified' });
    return out;
  }
  if ((b.missing || []).length) {
    out.push({ c: 'logRoutingBomMissing', p: [String(b.missing.length), sampleMaterials(b.missing)] });
  }
  if ((b.qtyDiff || []).length) {
    out.push({ c: 'logRoutingBomQtyDiff', p: [String(b.qtyDiff.length), sampleMaterials(b.qtyDiff)] });
  }
  if (l.changed === true) {
    out.push({
      c: 'logRoutingCycleChanged',
      p: [String(l.counts.added), String(l.counts.removed), String(l.counts.moved),
        String(l.counts.qtyDiff)]
    });
  }
  if ((b.extra || []).length) {
    out.push({ c: 'logRoutingBomExtra', p: [String(b.extra.length)] });
  } else if (b.extraKnown === false) {
    // Le righe in eccesso NON sono state cercate: l'elenco desiderato era piu' stretto del vero.
    // Senza questa riga «nessun eccesso» e «non l'ho potuto guardare» si leggono uguali.
    out.push({ c: 'logRoutingBomExtraUnknown' });
  }
  if ((b.noId || []).length) {
    out.push({ c: 'logRoutingBomNoId', p: [String(b.noId.length), sampleMaterials(b.noId)] });
  }
  if ((unresolved || []).length) {
    out.push({
      c: 'logRoutingBomUnresolved',
      p: [String(unresolved.length), sampleMaterials(unresolved)]
    });
  }
  return out;
}

/**
 * L'esito del confronto degrada l'esito del ciclo?
 *
 * DEGRADANO LE COSE CHE NESSUN REINVIO SISTEMERA', ed e' esattamente il complemento di `drift`:
 * cio' che fa reinviare NON degrada (si ripara da se', al prossimo giro), cio' che si dichiara
 * degrada — o l'unico posto in cui il fatto e' scritto sarebbe un JSON che nessuno apre.
 *
 *   - eccesso su Plex: in fabbrica un componente resta su due operazioni, o dove SAP non lo vuole
 *     piu'. Il rimedio e' una persona sul tenant;
 *   - `noId`: quantita' diversa e nessun `id` con cui correggerla;
 *   - lettura non riuscita: non si sa, e non sapere su un flusso che scrive in fabbrica e'
 *     un'attenzione;
 *   - `NO_COMPONENT_PART`: un componente del ciclo che su quel plant non e' una part. Non fa
 *     reinviare (il reinvio lo salterebbe di nuovo, `SKIPPED_NOT_A_PART`) ma il rimedio esiste ed
 *     e' altrove: mandare quel materiale a Plex per quel plant (`MAT_SYNC`).
 *
 * `NO_PART_OPERATION` non degrada: significa che l'operazione non e' su Plex, cioe' `OPS_MISSING`,
 * che fa REINVIARE — e il reinvio la crea. Contarlo qui darebbe un'attenzione su un difetto che si
 * sta giA' riparando.
 *
 * @param {object} args
 * @param {object} [args.bom] da `diffBom`
 * @param {Array<object>} [args.unresolved] da `expectedBomRows().unresolved`
 * @returns {boolean}
 */
function degradesVerify({ bom, unresolved } = {}) {
  const b = bom || {};
  if (b.remoteKnown !== true) return true;
  if ((b.extra || []).length > 0 || (b.noId || []).length > 0) return true;
  return (Array.isArray(unresolved) ? unresolved : [])
    .some((u) => u && u.Reason === 'NO_COMPONENT_PART');
}

module.exports = {
  REASON,
  diffLocal,
  expectedBomRows,
  diffBom,
  decideVerify,
  driftSegments,
  degradesVerify,
  sampleMaterials
};

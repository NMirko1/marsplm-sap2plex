/**
 * [COMP-SOURCE] Chi ha collocato un componente su un'operazione Plex: il vocabolario unico dei DUE
 * alberi, e le regole che ne discendono (feature 0036).
 *
 * PERCHE' ESISTE UN MODULO SOLO PER DUE ALBERI.
 * La domanda «questa collocazione l'ha decisa una persona?» si pone identica sul ciclo del
 * MATERIALE (`ZPlexRoutingCycleComponent`) e sull'ordine (`ZPlexCycleComponent`), ma fino alla 0036
 * esisteva una risposta sola — quella del ciclo, dentro srv/lib/routingCompSourceRules.js — e
 * sull'ordine il campo non c'era affatto: i due gesti del cockpit ordini erano indistinguibili da
 * un'auto-assegnazione, e la semina dal ciclo perdeva la provenienza per costruzione, perche' la
 * colonna di destinazione non esisteva.
 *
 * `ORIGIN` e `normalizeOrigin` sono ARRIVATE DA LA' e sono le stesse, byte per byte:
 * `routingCompSourceRules.js` le ri-esporta invariate, e il suo test le importa ancora da quel
 * modulo — e' cio' che dimostra che lo spostamento non ha cambiato comportamento. Il divieto che
 * quel file dichiara al suo interno («una SECONDA decisione su cosa e' automatico») e' esattamente
 * la ragione per cui non se ne fa una copia qui: se un giorno il ciclo e l'ordine rispondessero
 * diversamente alla stessa domanda, l'albero a schermo direbbe una cosa e cio' che parte verso Plex
 * un'altra.
 *
 * IL GEMELLO LATO CLIENT e' app/marsplm-sap2plex/webapp/util/CompSource.js, e
 * test/compSourceRules.test.js li confronta sulla stessa tabella di casi: i controller hanno bisogno
 * della stessa risposta del server su «questa riga e' manuale?», e tre `=== "MANUAL"` scritti a mano
 * sarebbero tre occasioni di divergere dal `trim().toUpperCase()`.
 *
 * [COMP-ORPHAN] DALLA 0037 QUI STA ANCHE IL SUO CONTORNO: una collocazione vale finche' il
 * componente esiste in SAP. Il marcatore proteggeva la riga dalle regole e, senza volerlo, anche da
 * SAP — un componente tolto dal ciclo o dall'ordine restava nell'albero per sempre. `pruneOrphans`
 * e `orphanKeys` sono la sola definizione di «questa riga non ha piu' un componente dietro», e i due
 * guardiani che le proteggono (insieme SAP non letto, insieme SAP vuoto) stanno la' dentro e non nei
 * chiamanti: sono quattro, e quattro copie del guardiano sarebbero tre occasioni di dimenticarlo.
 *
 * NESSUNA DIPENDENZA: ne' `cds`, ne' rete, ne' database — e' cio' che permette a `srv/lib/` di
 * servire anche i cinque job, che sono processi separati e non possono entrare nella closure di
 * `cat-service.js`. Test: node test/compSourceRules.test.js
 * Perimetro: `grep -rn "COMP-SOURCE"` (che restituisce anche `ROUTING-COMP-SOURCE`: un grep solo per
 * tutta la provenienza, su entrambi gli alberi).
 */

'use strict';

// ================================================================
// Costanti
// ================================================================

/**
 * I due valori di `AssignmentSource`, su entrambi gli alberi.
 *
 *   'AUTO'   -> l'auto-assegnazione. Le regole possono spostare la riga quando cambiano idea.
 *   'MANUAL' -> una persona, nel cockpit. Le regole non la spostano.
 */
const ORIGIN = Object.freeze({ AUTO: 'AUTO', MANUAL: 'MANUAL' });

// ================================================================
// Normalizzazioni
// ================================================================

/** Stringa spogliata: `null`/`undefined` diventano stringa vuota, mai `'null'`. */
function str(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

/**
 * Chiave di confronto di un codice materiale.
 *
 * La stessa di `matKey` in srv/lib/orderBomAddRules.js, che e' il modulo che consuma
 * `manualTargetsByMaterial`: due chiavi diverse sullo stesso confronto darebbero un bersaglio
 * manuale trovato da una parte e non dall'altra. Insensibile alla grafia e non agli zeri iniziali —
 * entrambi i lati vengono da SAP, quindi il confronto e' STRETTO (DEC-51).
 */
function matKey(v) {
  return str(v).toUpperCase();
}

/**
 * La provenienza di una riga salvata.
 *
 * VUOTO = 'AUTO', ed e' una scelta e non una svista: una riga senza provenienza dichiarata e'
 * governata dalle regole. Con il ripiego opposto la feature non avrebbe effetto su nulla di cio'
 * che esiste gia', cioe' non avrebbe effetto.
 * @param {*} v
 * @returns {'AUTO'|'MANUAL'}
 */
function normalizeOrigin(v) {
  return str(v).toUpperCase() === ORIGIN.MANUAL ? ORIGIN.MANUAL : ORIGIN.AUTO;
}

/** `true` se la riga e' stata collocata da una persona. Pilota l'icona e l'override dell'invio. */
function isManual(v) {
  return normalizeOrigin(v) === ORIGIN.MANUAL;
}

// ================================================================
// Insiemi e bersagli
// ================================================================

/**
 * I materiali che almeno una riga dichiara collocati a mano. FUNZIONE PURA.
 *
 * LA GRANULARITA' E' IL MATERIALE, NON LA COPPIA (operazione, materiale), ed e' la stessa che il
 * ramo cicli usa dalla 0025 e che DEC-86 RB-03 ha fissato per il passo 7.2: due granularita'
 * diverse sullo stesso oggetto darebbero un aggiungi-e-poi-disattiva a ogni giro. Conseguenza da
 * conoscere: un materiale appeso a due operazioni, una a mano e una dalle regole, e' manuale per
 * entrambe.
 *
 * @param {Array<object>} rows righe con `Material` e `AssignmentSource`
 * @returns {Set<string>} chiavi `matKey` dei materiali manuali
 */
function manualMaterials(rows) {
  const out = new Set();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!isManual(r && r.AssignmentSource)) continue;
    const key = matKey(r && r.Material);
    if (key) out.add(key);
  }
  return out;
}

/**
 * Dove la mano ha messo ogni materiale. FUNZIONE PURA.
 *
 * E' cio' che serve all'INVIO: il passo 2bis del job deve sapere su quale operazione appendere un
 * componente extra, e per un componente collocato a mano quella risposta e' nell'albero salvato, non
 * nelle regole.
 *
 * A parita' di materiale vince la `Sequence` MINIMA, e non e' un dettaglio estetico: e' l'unico
 * criterio deterministico disponibile: prendere «la prima riga che capita» darebbe due bersagli
 * diversi a due letture della stessa tabella, cioe' un componente che cambia operazione senza che
 * nessuno abbia toccato niente. Le righe senza `PlexOperationId` si SCARTANO: un bersaglio vuoto non
 * e' un bersaglio, e tenerlo cancellerebbe in silenzio quello delle regole.
 *
 * @param {Array<object>} rows righe di `ZPlexCycleComponent` (Material, PlexOperationId, Sequence,
 *   AssignmentSource)
 * @returns {Map<string,{Material: string, PlexOperationId: string, Sequence: number}>}
 */
function manualTargetsByMaterial(rows) {
  const out = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!isManual(r && r.AssignmentSource)) continue;
    const key = matKey(r && r.Material);
    const target = str(r && r.PlexOperationId);
    if (!key || !target) continue;
    // Una `Sequence` ASSENTE va in fondo, non davanti a tutti: `Number(null)` e' `0` — ed e' finito
    // — quindi il solo `Number.isFinite` faceva vincere la riga senza sequenza su una che l'ha.
    // Stessa forma del comparatore `num` di srv/lib/orderCycleImportRules.js.
    const raw = r.Sequence;
    const seq = (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)))
      ? Number.MAX_SAFE_INTEGER
      : Number(raw);
    const prev = out.get(key);
    if (prev && prev.Sequence <= seq) continue;
    out.set(key, { Material: str(r.Material), PlexOperationId: target, Sequence: seq });
  }
  return out;
}

/**
 * L'esito dell'auto-assegnazione corretto da cio' che una persona ha deciso. FUNZIONE PURA.
 *
 * DUE EFFETTI, E IL SECONDO E' QUELLO CHE SI DIMENTICA. Un materiale manuale che le regole avevano
 * assegnato cambia BERSAGLIO; un materiale manuale che le regole NON avevano assegnato affatto —
 * nessun gruppo aggancia, ed e' il caso tipico per cui la collocazione a mano esiste — esce da
 * `unassigned` ed entra fra gli assegnati. Fermarsi al primo effetto lascerebbe l'ordine bloccato
 * su un componente che una persona aveva gia' collocato.
 *
 * NON INVENTA RIGHE: un materiale promosso da `unassigned` prende quantita', unita' e provenienza
 * fantasma dalla sua riga in `components` — le stesse che l'auto-assegnazione avrebbe usato. Senza
 * la riga sorgente il materiale resta fra i non assegnati, perche' una riga BOM con quantita'
 * inventata e' peggio di una riga assente.
 *
 * @param {object} p
 * @param {Array<object>} p.assignments `assignments` di `resolveAutoAssignments`
 * @param {Array<object>} p.unassigned `unassigned` di `resolveAutoAssignments` (`{Material, Reason}`)
 * @param {Map<string,object>} p.manualTargets da `manualTargetsByMaterial`
 * @param {Array<object>} [p.components] le righe passate all'auto-assegnazione, per la promozione
 * @returns {{assignments: Array<object>, unassigned: Array<object>, overridden: Array<object>}}
 *   `overridden`: `{Material, from, to, promoted}` — e' cio' che si DICHIARA nella traccia, perche'
 *   un bersaglio cambiato senza spiegazione si legge come un difetto delle regole.
 */
function applyManualTargets({ assignments, unassigned, manualTargets, components } = {}) {
  const targets = (manualTargets instanceof Map) ? manualTargets : new Map();
  const asIn = Array.isArray(assignments) ? assignments : [];
  const unIn = Array.isArray(unassigned) ? unassigned : [];
  const overridden = [];

  if (targets.size === 0) {
    return { assignments: asIn.slice(), unassigned: unIn.slice(), overridden };
  }

  const byMaterial = new Map();
  for (const c of (Array.isArray(components) ? components : [])) {
    const key = matKey(c && c.Material);
    if (key && !byMaterial.has(key)) byMaterial.set(key, c);
  }

  // 1. I bersagli sostituiti.
  const asOut = asIn.map((a) => {
    const key = matKey(a && a.Material);
    const manual = targets.get(key);
    if (!manual) return a;
    const from = str(a.TargetOperation);
    if (from === manual.PlexOperationId) return a;   // la mano conferma la regola: niente da dire
    overridden.push({
      Material: str(a.Material), from, to: manual.PlexOperationId, promoted: false
    });
    return {
      ...a,
      TargetOperation: manual.PlexOperationId,
      TargetOperationName: '',
      Source: 'MANUAL',
      // Il bersaglio delle REGOLE resta a bordo: e' il ripiego se quello scelto a mano su Plex non
      // esiste. Senza, un'operazione cancellata dal ciclo trasformerebbe questa miglioria in un
      // fermo dell'ordine — e chi ripiega deve poterlo DICHIARARE, non farlo in silenzio.
      RuleTargetOperation: from
    };
  });

  // 2. I materiali che le regole non avevano assegnato e che la mano invece ha collocato.
  const unOut = [];
  for (const u of unIn) {
    const key = matKey(u && u.Material);
    const manual = targets.get(key);
    const src = manual ? byMaterial.get(key) : null;
    if (!manual || !src) { unOut.push(u); continue; }
    overridden.push({
      Material: str(u.Material), from: '', to: manual.PlexOperationId, promoted: true
    });
    asOut.push({
      Material: str(src.Material),
      RequiredQuantity: src.RequiredQuantity != null ? src.RequiredQuantity : 0,
      BaseUnit: src.BaseUnit || '',
      BOMItemNodeNumber: src.BOMItemNodeNumber || null,
      PhantomSource: src.PhantomSource || '',
      ComponentGroup: '',
      TargetOperation: manual.PlexOperationId,
      TargetOperationName: '',
      Source: 'MANUAL',
      // Nessun ripiego: le regole non avevano un bersaglio per questo materiale. Se quello scelto a
      // mano non si risolve, il componente torna fra i falliti — cioe' dov'era prima di questa
      // feature, e non un passo indietro.
      RuleTargetOperation: ''
    });
  }

  return { assignments: asOut, unassigned: unOut, overridden };
}

// ================================================================
// [COMP-ORPHAN] La potatura: una collocazione vale finche' il componente esiste in SAP (0037)
// ================================================================

/**
 * Le righe dell'albero il cui materiale NON esiste piu' in SAP. FUNZIONE PURA.
 *
 * PERCHE' SERVE. Il marcatore manuale della 0036 protegge una riga dalle regole, e la proteggeva
 * anche da SAP: sul ciclo `manualKept` guardava solo `AssignmentSource` e non confrontava mai il
 * materiale con l'elenco letto — quindi un componente tolto dal ciclo SAP restava nell'albero
 * per sempre, e veniva RIINVIATO a Plex a ogni sincronizzazione. Le righe automatiche invece si
 * autopulivano, perche' vengono cancellate tutte e riscritte dall'elenco SAP. La potatura chiude
 * l'asimmetria: la protezione vale finche' il componente esiste.
 *
 * DUE GUARDIANI, E SONO IL CUORE DELLA SICUREZZA. `sapKeys` che non e' un insieme — la lettura non
 * e' stata fatta o non e' riuscita — e `sapKeys` VUOTO non potano NIENTE. Un insieme vuoto non
 * dimostra che i componenti non ci sono: un iFlow interrogato con un criterio che non gli basta
 * risponde `200` con zero righe esattamente come risponde quando i dati davvero non ci sono
 * (DEC-49), e su quel niente si cancellerebbe l'albero intero. «Vuoto» non e' «ignoto»
 * (DEC-80), e qui l'errore e' distruttivo: una riga automatica cancellata per sbaglio torna al
 * run successivo, una MANUALE cancellata per sbaglio e' una decisione umana persa.
 *
 * NON CANCELLA NIENTE: rende liste, e chi chiama cancella PER IDENTIFICATIVO. Un criterio SQL
 * sulla provenienza sarebbe una seconda decisione presa altrove, ed e' il divieto che
 * srv/lib/routingCompSourceRules.js dichiara al suo interno.
 *
 * @param {object} p
 * @param {Array<object>} p.stored righe salvate (`ID`, `Material`, `AssignmentSource`)
 * @param {Set<string>} p.sapKeys chiavi dei materiali che SAP ha, GIA' normalizzate con `keyOf`
 * @param {function(*): string} [p.keyOf] la chiave di confronto. INIETTATA e non scelta qui: si pota
 *   con la STESSA funzione con cui il ramo decide «questo materiale e' manuale», o si potrebbe
 *   potare una riga che l'altro lato tiene. Default `matKey`, che e' quella del ramo ordini.
 * @returns {{kept: Array<object>, dropped: Array<object>, droppedManual: Array<object>,
 *   droppedAuto: Array<object>, ids: Array<string>, evaluated: boolean}}
 *   `evaluated: false` = non si e' potato perche' l'insieme SAP non e' utilizzabile. E' un fatto da
 *   DICHIARARE, non un silenzio: «non ho potuto guardare» non e' «non c'era niente da togliere».
 */
function pruneOrphans({ stored, sapKeys, keyOf } = {}) {
  const rows = (Array.isArray(stored) ? stored : []).filter(Boolean);
  const key = typeof keyOf === 'function' ? keyOf : matKey;
  const usable = (sapKeys instanceof Set) && sapKeys.size > 0;

  if (!usable) {
    return {
      kept: rows.slice(), dropped: [], droppedManual: [], droppedAuto: [], ids: [],
      evaluated: false
    };
  }

  const kept = [];
  const dropped = [];
  for (const r of rows) {
    const k = key(r.Material);
    // Una riga SENZA materiale non e' un orfano dimostrato: si tiene. Cancellarla su un dato
    // assente sarebbe la stessa cosa che cancellare su una lettura fallita, in piccolo.
    if (k && !sapKeys.has(k)) dropped.push(r);
    else kept.push(r);
  }

  return {
    kept,
    dropped,
    droppedManual: dropped.filter((r) => isManual(r.AssignmentSource)),
    droppedAuto: dropped.filter((r) => !isManual(r.AssignmentSource)),
    ids: dropped.map((r) => r.ID).filter((id) => id !== null && id !== undefined && id !== ''),
    evaluated: true
  };
}

/**
 * I materiali dell'albero che SAP non ha piu'. FUNZIONE PURA.
 *
 * E' la stessa domanda di `pruneOrphans` con una risposta piu' piccola: serve a MARCARE a schermo,
 * dove non si cancella niente e non si hanno gli `ID`. Stessi due guardiani: insieme non
 * utilizzabile = nessun orfano dichiarato, perche' marcare su una lettura fallita direbbe a chi
 * guarda che quel componente sta per sparire quando non e' vero.
 *
 * @param {Array<object>} stored
 * @param {Set<string>} sapKeys
 * @param {function(*): string} [keyOf]
 * @returns {Set<string>} chiavi dei materiali orfani
 */
function orphanKeys(stored, sapKeys, keyOf) {
  const out = new Set();
  const key = typeof keyOf === 'function' ? keyOf : matKey;
  if (!(sapKeys instanceof Set) || sapKeys.size === 0) return out;
  for (const r of (Array.isArray(stored) ? stored : [])) {
    const k = key(r && r.Material);
    if (k && !sapKeys.has(k)) out.add(k);
  }
  return out;
}

/**
 * La coda del messaggio che dichiara la potatura. FUNZIONE PURA.
 *
 * Stringa VUOTA quando non c'e' niente da dichiarare. Le due provenienze si NOMINANO separate,
 * perche' sono due notizie diverse: una riga automatica potata e' manutenzione, una riga manuale
 * potata e' la decisione di una persona che viene annullata perche' SAP l'ha superata.
 *
 * @param {Array<object>} dropped righe potate (da `pruneOrphans`)
 * @param {number} [maxNamed] quanti materiali nominare per esteso prima di contare i restanti
 * @returns {string}
 */
function describePruned(dropped, maxNamed = 5) {
  const rows = Array.isArray(dropped) ? dropped : [];
  if (!rows.length) return '';
  const manual = rows.filter((r) => isManual(r.AssignmentSource)).length;
  const names = rows.slice(0, maxNamed).map((r) => str(r.Material)).filter(Boolean);
  const rest = rows.length - names.length;
  const tail = names.join(', ') + (rest > 0 ? `, e altri ${rest}` : '');
  const who = manual ? ` (di cui ${manual} collocati a mano)` : '';
  return `${rows.length} componenti non esistono piu' in SAP e sono stati rimossi dall'albero`
    + `${who}: ${tail}`;
}

// [COMP-SOURCE] `countManualRows` e' USCITO l'11/09/2026 insieme alla conferma che serviva —
// «{0} componenti collocati a mano torneranno sotto le regole» — quando il pulsante «Auto-Assegna»
// ha smesso di riportarli sotto le regole. Non aveva altri chiamanti: cio' che solo una funzione
// rimossa teneva in vita esce con lei, o resta un simbolo che il prossimo lettore crede in uso.
// Chi conta le righe conservate oggi e' `_applyAutoAssignments`, sul suo elenco.

/**
 * La coda del messaggio che dichiara i bersagli rispettati. FUNZIONE PURA.
 *
 * Stringa VUOTA quando non c'e' niente da dichiarare: una frase che dice sempre la stessa assenza
 * non e' un'informazione.
 * @param {Array<object>} overridden da `applyManualTargets`
 * @returns {string}
 */
function describeOverridden(overridden) {
  const rows = Array.isArray(overridden) ? overridden : [];
  if (!rows.length) return '';
  const promoted = rows.filter((r) => r.promoted).length;
  const moved = rows.length - promoted;
  const parts = [];
  if (moved) parts.push(`${moved} spostati su un'altra operazione`);
  if (promoted) parts.push(`${promoted} che nessuna regola agganciava`);
  return `collocazione a mano rispettata per ${rows.length} componenti (${parts.join(', ')})`;
}

module.exports = {
  ORIGIN,
  str,
  matKey,
  normalizeOrigin,
  isManual,
  manualMaterials,
  manualTargetsByMaterial,
  applyManualTargets,
  describeOverridden,
  // [COMP-ORPHAN] La potatura (0037)
  pruneOrphans,
  orphanKeys,
  describePruned
};

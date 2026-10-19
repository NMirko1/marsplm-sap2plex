/**
 * [ORDER-QTY-SYNC] Regole PURE del riallineamento della quantita' di un ordine gia' inviato a Plex
 * (feature 0033). Nessuna dipendenza da `cds` ne' dalla rete: si collauda con
 * `node test/orderQtyRules.test.js`.
 *
 * IL PROBLEMA. Un ordine SAP diventa un job su Plex. Se dopo l'invio qualcuno cambia la quantita'
 * dell'ordine in SAP, quella variazione non arriva in fabbrica: il job pianificato SALTA gli ordini
 * gia' inviati con esito `S` e nessun altro flusso ricontrolla la quantita'.
 *
 * LA FORMULA, e perche' non e' un requisito in piu'. Un ordine spacchettato vive su Plex come lotto
 * principale PIU' N pacchetti, e la quantita' totale in produzione deve restare quella dell'ordine.
 * Quindi cio' che va scritto sul lotto padre e':
 *
 *     target = quantita' SAP  −  somma dei pacchetti VIVI su Plex
 *
 * Il passo 3 «Update Job» mandava invece `TotalQuantity` INTERA
 * (srv/jobs/createPlexProductionOrders.js): su un ordine spacchettato avrebbe riportato il padre alla
 * quantita' piena mentre i pacchetti continuano a esistere con la loro — piu' quantita' in produzione
 * di quella ordinata. Oggi non succede solo perche' due gate tengono fuori gli ordini spacchettati, e
 * questa feature quei gate li apre: la formula e' cio' che rende sicura l'apertura. Su un ordine NON
 * spacchettato la somma e' zero e il target coincide con la quantita' SAP, cioe' il comportamento di
 * prima — UNA SOLA REGOLA per i due rami, non due che divergono al primo campo aggiunto.
 *
 * CHI DICE QUANTO PESA UN LOTTO E' PLEX. Non `ZProdOrderPlexMapping.Quantity`, che e' uno snapshot
 * all'ultima scrittura e per il lotto principale non viene nemmeno scritto da questo flusso: dopo un
 * cambio fatto a mano dentro Plex direbbe una cosa e la fabbrica un'altra. E' la stessa precedenza di
 * DEC-70 e DEC-80 — l'identita' e lo stato di un oggetto esterno li dichiara il sistema esterno.
 *
 * FAIL-CLOSED SUL LOTTO ILLEGGIBILE, ed e' la regola che tiene in piedi tutto il resto. Un lotto che
 * non si e' riusciti a leggere NON si conta come assente: una somma incompleta da' un target TROPPO
 * ALTO, cioe' gonfia il lotto padre — l'errore esattamente opposto a quello che si sta prevenendo, e
 * per giunta invisibile. «Non lo so» non diventa «non c'e'» (DEC-80): con un solo lotto illeggibile
 * l'intero riallineamento di quell'ordine si ferma e lo dichiara.
 *
 * LO ZERO E' UN VALORE. `target === 0` significa che tutta la quantita' e' ormai sui pacchetti, e la
 * somma resta corretta: si tenta la scrittura e decide Plex. La trappola del falsy va evitata qui —
 * `if (!target)` scarterebbe proprio il caso limite — non nei chiamanti.
 */

'use strict';

const { round3, isExactJobNumber } = require('./splitRules');

/**
 * Esito della lettura di UN lotto su Plex, derivato dalla risposta di `plexJobRead.findJob`.
 * I tre stati non sono due: `ok:false` (non ho potuto sapere) e `found:null` (accertatamente
 * assente) sono la distinzione su cui poggia il fail-closed qui sopra.
 */
const LOT_VERDICT = Object.freeze({
  FOUND: 'FOUND',
  ABSENT: 'ABSENT',
  INCONCLUSIVE: 'INCONCLUSIVE'
});

/** Perche' un target non e' utilizzabile. `OK` e' l'unico che autorizza a scrivere. */
const TARGET_REASON = Object.freeze({
  OK: 'OK',
  /** La quantita' SAP e' minore della somma dei pacchetti: il padre andrebbe sotto zero. */
  NEGATIVE: 'NEGATIVE',
  /** `TotalQuantity` assente o non numerica: non c'e' niente con cui confrontare. */
  NO_SAP_QTY: 'NO_SAP_QTY',
  /** Almeno un lotto non e' stato letto: la somma sarebbe incompleta. */
  LOT_UNREADABLE: 'LOT_UNREADABLE',
  /** Plex dichiara che il lotto principale non esiste: non c'e' niente da aggiornare. */
  MAIN_ABSENT: 'MAIN_ABSENT'
});

/** Cosa fare dopo il confronto. */
const SYNC = Object.freeze({
  IN_SYNC: 'IN_SYNC',
  TO_UPDATE: 'TO_UPDATE'
});

/** Numero utilizzabile, oppure `null`. Lo zero passa. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Traduce la risposta di `plexJobRead.findJob` in uno dei tre verdetti. FUNZIONE PURA.
 *
 * `ok:false` e' «non ho potuto sapere» e resta tale anche quando `found` e' nullo: la forma di
 * ritorno di `findJob` tiene i due assi separati proprio perche' qui non si possano confondere.
 *
 * @param {{ok?: boolean, found?: object|null}|null} read
 * @returns {string} uno di `LOT_VERDICT`
 */
function lotVerdict(read) {
  if (!read || read.ok !== true) return LOT_VERDICT.INCONCLUSIVE;
  return read.found ? LOT_VERDICT.FOUND : LOT_VERDICT.ABSENT;
}

/**
 * Somma delle quantita' dei pacchetti PRESENTI su Plex. FUNZIONE PURA.
 *
 * NESSUN FILTRO SU `SplitState`, ed e' deliberato: chi dice se un lotto esiste e' Plex (RB-02 della
 * 0023). Un `'X'` o un `'R'` sono lotti mai creati e Plex li dichiarera' assenti da se'; un `'U'` e'
 * un esito incerto che potrebbe benissimo esistere, e saltarlo per stato sottostimerebbe la somma.
 *
 * Un lotto FOUND con quantita' non numerica vale ZERO e viene segnalato dal chiamante: e' un dato che
 * Plex ha mandato e che non sappiamo leggere, non un lotto assente.
 *
 * @param {Array<{verdict: string, quantity: number|string|null}>} lots
 * @returns {number} somma arrotondata a 3 decimali
 */
function sumPackageQuantities(lots) {
  const list = Array.isArray(lots) ? lots : [];
  return round3(
    list
      .filter((l) => l && l.verdict === LOT_VERDICT.FOUND)
      .reduce((acc, l) => acc + (num(l.quantity) || 0), 0)
  );
}

/**
 * Divide i lotti letti in lotto principale e pacchetti. FUNZIONE PURA.
 *
 * Il principale e' quello il cui numero COINCIDE col numero d'ordine. Il confronto e' esatto
 * (`isExactJobNumber`) perche' un codice pacchetto INIZIA col numero d'ordine — `000700000162-0001`
 * comincia per `000700000162` — ed e' la stessa protezione che serve contro il match per prefisso di
 * Plex.
 *
 * @param {string} order numero dell'ordine SAP
 * @param {Array<{jobNumber: string}>} lots
 * @returns {{main: object|null, packages: Array<object>}}
 */
function splitLots(order, lots) {
  const list = Array.isArray(lots) ? lots : [];
  let main = null;
  const packages = [];
  for (const l of list) {
    if (!l) continue;
    if (main === null && isExactJobNumber(l.jobNumber, order)) main = l;
    else packages.push(l);
  }
  return { main, packages };
}

/**
 * La quantita' da scrivere sul lotto padre. FUNZIONE PURA.
 *
 * L'ordine dei controlli non e' indifferente: il lotto illeggibile viene PRIMA di tutto il resto,
 * perche' con una somma incompleta anche «negativo» e «allineato» sarebbero verdetti su un dato che
 * non c'e'. Poi l'assenza del padre, poi la quantita' SAP, e solo alla fine il segno.
 *
 * @param {object} o
 * @param {string} o.order numero dell'ordine SAP
 * @param {number|string|null} o.sapQty `A_ProductionOrder_2.TotalQuantity` (decimale, quindi puo'
 *   arrivare come stringa: e' `Edm.Decimal` su OData V2)
 * @param {Array<{jobNumber: string, verdict: string, quantity: *}>} o.lots i lotti LETTI da Plex
 * @returns {{ok: boolean, reason: string, target: number|null, sumPackages: number|null,
 *            mainQty: number|null, packageCount: number, unreadable: Array<string>}}
 */
function computeMainTarget({ order, sapQty, lots } = {}) {
  const { main, packages } = splitLots(order, lots);
  const all = [...(main ? [main] : []), ...packages];

  const unreadable = all
    .filter((l) => l.verdict === LOT_VERDICT.INCONCLUSIVE)
    .map((l) => String(l.jobNumber || '').trim() || '(senza numero)');

  const base = {
    ok: false,
    target: null,
    sumPackages: null,
    mainQty: main ? num(main.quantity) : null,
    packageCount: packages.filter((p) => p.verdict === LOT_VERDICT.FOUND).length,
    unreadable
  };

  // 1. Un solo lotto non letto ferma tutto: vedi il fail-closed in testa al file.
  if (unreadable.length) return { ...base, reason: TARGET_REASON.LOT_UNREADABLE };

  // 2. Il padre non c'e' su Plex. Non e' un errore di questo flusso — l'ordine non e' (piu') su
  //    Plex — ma non c'e' niente da aggiornare, e crearlo non e' compito di un riallineamento.
  if (!main || main.verdict !== LOT_VERDICT.FOUND) {
    return { ...base, reason: TARGET_REASON.MAIN_ABSENT };
  }

  // 3. Senza la quantita' SAP non c'e' un termine di confronto. Non si ripiega su niente.
  const sap = num(sapQty);
  if (sap === null) return { ...base, reason: TARGET_REASON.NO_SAP_QTY };

  const sumPackages = sumPackageQuantities(packages);
  const target = round3(sap - sumPackages);

  // 4. Il segno. `< 0` e non `<= 0`: lo zero e' un valore ammesso (vedi testa al file).
  if (target < 0) {
    return { ...base, reason: TARGET_REASON.NEGATIVE, target, sumPackages };
  }
  return { ...base, ok: true, reason: TARGET_REASON.OK, target, sumPackages };
}

/**
 * Le due date sono la stessa? FUNZIONE PURA.
 *
 * Il confronto e' sul TEMPO e non sulla stringa: `2026-08-25T00:00:00Z` e `2026-08-25T00:00:00.000Z`
 * sono lo stesso istante e due stringhe diverse. Una data che non si interpreta NON conta come
 * divergente: farebbe partire un `PUT` per un dato che non sappiamo leggere.
 */
function sameInstant(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return ta === tb;
}

/**
 * C'e' qualcosa da scrivere su Plex? FUNZIONE PURA.
 *
 * PERCHE' ESISTE. Il passo 3 mandava il `PUT` a OGNI ri-sincronizzazione, anche quando non c'era
 * niente da cambiare — e allora quel `PUT` rispondeva `500`
 * (srv/external/PLEX_ISSUE_JOB_QUANTITY_UPDATE_500.it.md, difetto Plex corretto da Rockwell il
 * 27/08/2026 e verificato sul tenant), quindi l'ordine chiudeva in errore e veniva ritentato a ogni
 * esecuzione, indefinitamente.
 *
 * LA REGOLA NON DIPENDEVA DAL DIFETTO e resta ora che il `PUT` funziona: una scrittura che non ha
 * niente da scrivere non si manda comunque — costa una richiesta e riscrive una testata intera su un
 * oggetto vivo. Con il confronto preventivo un ordine non variato non tocca Plex.
 *
 * IL `PUT` PARTE SE DIVERGE LA QUANTITA' **OPPURE** LA DATA. Un `PUT` e' il modello intero (DEC-77),
 * quindi la data viaggia comunque insieme alla quantita': guardare la sola quantita' lascerebbe
 * indietro un ordine a cui in SAP e' cambiata solo la consegna.
 *
 * Le quantita' si confrontano su `round3` di ENTRAMBI i lati, non con `===` su float: `5` e
 * `5.0000000001` sono la stessa quantita' d'ordine, e un confronto stretto manderebbe un `PUT` a
 * ogni giro senza che nulla sia cambiato.
 *
 * @param {object} o
 * @param {number} o.target quantita' da scrivere (`computeMainTarget`)
 * @param {number|string|null} o.currentQty quantita' che il lotto ha ADESSO su Plex
 * @param {string|null} o.sapDueDate data di consegna dall'ordine SAP, gia' in ISO
 * @param {string|null} o.plexDueDate data di consegna che il lotto ha adesso su Plex
 * @returns {{state: string, qtyChanged: boolean, dateChanged: boolean, from: number|null, to: number}}
 */
function classifySync({ target, currentQty, sapDueDate, plexDueDate } = {}) {
  const to = round3(target);
  const cur = num(currentQty);
  const qtyChanged = cur === null || round3(cur) !== to;
  const dateChanged = !sameInstant(sapDueDate, plexDueDate);
  return {
    state: qtyChanged || dateChanged ? SYNC.TO_UPDATE : SYNC.IN_SYNC,
    qtyChanged,
    dateChanged,
    from: cur,
    to
  };
}

/**
 * Questo esito lascia una riga nello storico dell'ORDINE? FUNZIONE PURA.
 *
 * PERCHE' ESISTE, E PERCHE' NON E' `res.written`. La regola e' di DEC-96 — una riga di storico si
 * scrive quando la chiamata parte davvero — e il ramo `IN_SYNC` esiste apposta per NON parlare con
 * Plex: la fase di controllo gira a ogni esecuzione su tutti gli ordini gia' inviati, quindi ogni
 * ordine fermo si portava a casa una riga «gia' allineata» per run, dentro lo storico degli INVII.
 *
 * MA IL CONFINE NON E' «HA SCRITTO SU PLEX», ed e' la trappola di questa funzione. `res.written` e'
 * la scorciatoia che verrebbe in mente, e spegnerebbe anche le righe di `LOT_UNREADABLE`,
 * `MAIN_ABSENT`, `NO_SAP_QTY` e `NEGATIVE` — che non scrivono su Plex nemmeno loro, ma sono anomalie:
 * «non ho potuto chiedere» non e' «non c'era niente da chiedere», e vanno viste sulla scheda
 * dell'ordine, non solo nel recap di un run che nessuno riapre. Il no-op NOMINALE e' uno solo, e si
 * nomina.
 *
 * @param {string|null|undefined} reason il `reason` restituito da `syncOrderQuantity`
 * @returns {boolean}
 */
function writesHistory(reason) {
  return reason !== SYNC.IN_SYNC;
}

module.exports = {
  LOT_VERDICT,
  TARGET_REASON,
  SYNC,
  writesHistory,
  lotVerdict,
  sumPackageQuantities,
  splitLots,
  computeMainTarget,
  classifySync,
  sameInstant
};

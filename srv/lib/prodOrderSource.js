/**
 * [IS-SOURCE] Sorgente dati dell'area ORDINI DI PRODUZIONE (area B, feature 0013).
 *
 * Sostituisce `cds.connect.to('OP_API_PRODUCTION_ORDER_2_SRV_0001')` in tutte le letture
 * d'ordine: lista e dettaglio del cockpit, creazione del lotto su Plex, spacchettamento,
 * job di creazione lotti e job di consuntivazione (solo la lettura dell'ordine: la
 * connessione verso il servizio Confirmation NON si tocca, è fuori perimetro).
 *
 * Leva: PROD_ORDER_SOURCE (IS = default, ONPREM = pin sul canale storico).
 */

'use strict';

require('@sap/cds'); // installa i globali di cds.ql (SELECT), usati da readOrderHeader
const createRemoteSource = require('./isRemoteSource');

/** Entry cds.requires che porta il modello CSN condiviso da tutte le istanze (DEC-18). */
const BASE = 'OP_API_PRODUCTION_ORDER_2_SRV_0001';

// ================================================================
// [ORDER-TOP] IL TETTO DELLE LETTURE DI QUEST'AREA, IN UN PUNTO SOLO.
//
// PERCHE' STA QUI E NON IN cat-service.js. Fino al 02/09/2026 questo tetto era una `const` locale
// dentro il registrar dell'area ordini di `cat-service.js`, che e' una closure: i job NON lo
// vedevano, e i due che leggono un perimetro d'ordine erano scritti senza `.limit()`.
//
// ATTENZIONE, QUI C'ERA SCRITTA UNA CAUSA CHE NON E' MAI STATA MISURATA. Il 01/09/2026 `IV_TOP` e
// `IV_SKIP` sono stati implementati lato ABAP sulla query degli ordini (questo lo ha dichiarato il
// team ABAP), e da li' si era concluso che senza `IV_TOP` la RFC rendesse `200` con ZERO righe, e
// che fosse quella la ragione per cui `PROD_ORDER` aveva smesso di prendere ordini. E' un'IPOTESI
// NON CONFERMATA: col tetto a bordo il job ha letto ancora zero righe (run del 02/09 alle 14:29 e
// del 15:45), quindi quel tetto non era la causa. Cosa renda davvero questa RFC senza `IV_TOP`
// resta non misurato: nessuno ha eseguito la lettura senza tetto tenendo fermo il canale.
//
// IL TETTO RESTA, SUL SUO MERITO E NON SU QUELLA CAUSA. Una lettura di collection verso questi
// iFlow senza `$top` e' un rischio a prescindere: il sospetto di troncamento della sorgente
// (`looksTruncated` in isRemoteSource.js) si accende SOLO se `$top` c'e', quindi senza limit non
// c'e' ne' tetto ne' avviso — e un limite non onorato e' piu' pericoloso di un limite assente. Un
// tetto che vive in due posti e' un tetto che divergera'; un tetto che vive dove i job non arrivano
// e' un tetto che meta' del progetto non ha.
//
// COS'E' E COSA NON E'. E' un limite di SICUREZZA, non una dimensione misurata (DEC-83): serve a
// non chiedere a ECC un insieme senza fondo, e il suo raggiungimento e' un SOSPETTO DI TRONCAMENTO
// che va dichiarato — mai in silenzio. Non e' paginazione: `readPaged` (srv/lib/pagedRead.js) e'
// costruito per un valore scalare di criterio per chiamata, mentre qui si legge
// `ProductionPlant in (…)` in una chiamata sola, e nessuno ha ancora misurato se questa RFC onori
// anche `IV_SKIP`.
//
// FUNZIONE E NON COSTANTE: l'ambiente si legge al momento dell'uso. Una costante calcolata al
// `require` e' gia' stata valutata prima che un `cf set-env` sul task possa contare — e' la stessa
// ragione per cui `resolveEgress` legge il proprio marcatore quando serve e non al caricamento.
//
// Il nome della variabile d'ambiente NON cambia: e' gia' documentato in docs/0013 e in DEC-83.
// ================================================================
const LIST_MAX_ROWS_DEFAULT = 10000;

/** Il tetto di una lettura di perimetro dell'area ordini. */
function listMaxRows(env = process.env) {
  const n = parseInt(env.IS_PROD_ORDER_MAX_ROWS, 10);
  return Number.isFinite(n) && n > 0 ? n : LIST_MAX_ROWS_DEFAULT;
}

/**
 * [ORDER-TOP] I tetti delle letture di DETTAGLIO, cioe' operazioni e componenti DI UN ORDINE.
 *
 * Non sono numeri nuovi: sono quelli che la lista del cockpit applica gia' sulle stesse due entity
 * (`cat-service.js`, gli handler di ProductionOrderOperations e ProductionOrderComponents), dove
 * fanno da default quando il client non chiede un `$top`. Riusarli qui e' l'alternativa a inventare
 * due soglie che divergerebbero dalle prime. Sono letture per SINGOLO ordine, quindi stanno ordini
 * di grandezza sopra la realta': servono a non chiedere un insieme senza fondo, non a paginare.
 */
const DETAIL_MAX_ROWS = Object.freeze({ operations: 500, components: 1000 });

/**
 * [ORDER-TOP] Il tetto di una testata chiesta PER CHIAVE ma in forma di collection.
 *
 * Ne esistono tre nel progetto — il ripiego di `readOrderHeader` qui sotto e le due letture della
 * consuntivazione — e sono la forma sospettata il 02/09/2026 di rendere zero righe: chiave completa
 * nel `where` ma senza `SELECT.one`, quindi instradata sul `_QUERYGET` invece che sul `_GET`. Che
 * senza `IV_TOP` quella rotta non torni niente e' un'IPOTESI NON CONFERMATA (vedi il blocco in
 * testa al file): il tetto ci sta perche' una collection senza `$top` verso questi iFlow e' un
 * rischio comunque, non perche' la causa sia stata misurata.
 *
 * Dieci e non uno: una riga sola basterebbe al risultato, ma la seconda e' il SEGNALE che quella
 * chiave e' ambigua — due righe dello stesso ordine in disaccordo — e `pickOrderHeader` esiste per
 * riconoscerlo e rifiutare la riga invece di prenderne una a caso. Con `.limit(1)` quel controllo
 * non avrebbe mai niente da confrontare.
 */
const HEADER_MAX_ROWS = 10;

/**
 * Comportamenti per (entity, operazione).
 *
 * [IS-QUERYGET-OPS] Le OPERAZIONI leggono da un service root **`_QUERYGET`** in forma
 * **collection + `$filter=OrderInternalBillOfOperations eq '…'`**. Fino al 2026-08-17 erano una
 * lettura PER CHIAVE — `(OrderInternalBillOfOperations, OrderIntBillOfOperationsItem)` con l'AUFPL
 * valorizzato e l'APLZL a `0` — e da lì ci si attendeva la LISTA delle operazioni dell'ordine.
 * È la stessa forma caduta sui componenti d'ordine e sull'allocazione componenti del ciclo: in
 * OData un key predicate indirizza **una** entità e l'operazione read-by-key è tipizzata per
 * serializzare una singola entry, quindi risponde `200` con una riga e `500` con due o più. La
 * deroga concordata in C-1 non era realizzabile. Vedi DEC-45.
 *
 * Cambia la FORMA, non l'origine del criterio: l'AUFPL resta la chiave logica della lettura e
 * continua ad arrivare dalla **testata dell'ordine**, che ogni percorso legge prima delle
 * operazioni (`OrderInternalBillOfOperations` è un campo di `A_ProductionOrder_2`, DEC-42: è la
 * parte di quella decisione che resta integralmente in vigore). L'APLZL — che è il risultato
 * cercato — non si invia più: era lì solo per completare il predicate, riempito a `0` perché il
 * parametro `IV_ORDER_INT_BOO_ITEM` è NUMERICO e con uno spazio la funzione moriva in conversione.
 *
 * Il numero d'ordine **non** viene spinto nemmeno ora — il solo criterio contrattato su questo
 * indirizzo è l'AUFPL, che identifica già l'insieme — quindi il presidio non si salta, si sposta:
 * le righe lette vengono verificate con `keepOperationsOfOrder`. Niente `keyPredicate` e niente
 * `collectionFilter` su questa rotta: il primo non si compone più, il secondo ha un messaggio
 * scritto come ripiego e qui direbbe il falso.
 *
 * [IS-QUERYGET-COMP] Anche i COMPONENTI leggono da un service root **`_QUERYGET`**, in forma
 * **collection + `$filter=Reservation eq '…'`**, e per la stessa ragione: la loro lettura per
 * chiave è caduta per prima, il 2026-08-17, con `java.lang.ClassCastException` nel Message
 * Processing Log di CPI (vedi il blocco qui sopra e DEC-43, che è la misura da cui viene tutto).
 *
 * Cambia la FORMA, non l'origine del criterio: la prenotazione (RSNUM) resta la chiave logica
 * della lettura e continua ad arrivare dalla testata dentro `MasterProductionOrder` (vedi
 * `reservationOf`, che è l'unico punto che conosce la mappatura). Il numero d'ordine non è spinto
 * nemmeno ora, quindi le righe restano verificate a valle con `keepComponentsOfOrder`: la chiave
 * arriva da un campo riusato, e righe di un altro ordine sono il segnale che quel campo non porta
 * ciò che ci aspettiamo. Niente `keyPredicate` e niente `collectionFilter` su questa rotta: il
 * primo non si compone più, il secondo ha un messaggio scritto come ripiego e qui direbbe il
 * falso. Vedi DEC-43.
 *
 * [IS-BLANK-ROWS] `identity` è ciò che rende UTILIZZABILE una riga di questa entity: sono le
 * chiavi con cui la riga viaggia verso il cockpit. Se arrivano tutte vuote la riga è spazzatura
 * anche se la risposta è un `200` ben formato, e va dichiarata come tale invece di finire nel
 * binding — è il difetto misurato su E-13 il 06/08/2026 (vedi `identityCheck` in isQueryShape.js).
 */
const ROUTES = {
  A_ProductionOrder_2: {
    GET: { keyPredicate: ['ManufacturingOrder'], identity: ['ManufacturingOrder'] },
    QUERY: { identity: ['ManufacturingOrder'] }
  },
  A_ProductionOrderOperation_2: {
    // [IS-QUERYGET-OPS] collection + $filter sull'AUFPL, che il chiamante compone in
    // `operationsFilter`. Nessun predicate: vedi il blocco qui sopra e DEC-45.
    QUERY: { identity: ['OrderInternalBillOfOperations', 'OrderIntBillOfOperationsItem'] }
  },
  A_ProductionOrderComponent_2: {
    // [IS-QUERYGET-COMP] collection + $filter sulla prenotazione, che il chiamante compone in
    // `componentsFilter`. Nessun predicate: vedi il blocco qui sopra e DEC-43.
    QUERY: { identity: ['Reservation', 'ReservationItem'] }
  }
};

/**
 * [ORDER-STATUS-FILTER] IL CRITERIO DI STATO NON ABITA PIÙ QUI (feature 0017).
 *
 * Fino alla 0016 questo file esportava `RELEASED_STATE` e `isReleasedOpenOrder`, cioè il
 * criterio CABLATO «rilasciato, non chiuso, non cancellato»: era il perimetro del job, e la
 * lista del cockpit non ne aveva nessuno. Dalla 0017 il perimetro per stato è customizing per
 * plant e vive in `srv/lib/prodOrderStatusFilter.js`, che lo applica a entrambi.
 *
 * Resta vero, e vale per chi legge questo file, che i flag di stato NON hanno select-option
 * dietro l'iFlow (`ZMARS_PROD_ORDER_GET`, contratto E-13, richiesta R-2b): in modalità `IS`
 * qualunque criterio su di essi si valuta A VALLE. In `ONPREM` è spingibile.
 */

/**
 * [IS-QUERYGET-OPS] Filtro della lettura delle OPERAZIONI di un ordine, per i percorsi che
 * partono da una testata già letta: auto-import del ciclo e caricamento dei dettagli del job
 * (usato anche dallo spacchettamento). Il terzo percorso — `READ ProductionOrderOperations`
 * del cockpit — compone gli stessi criteri partendo dal filtro del client, perché lì l'AUFPL
 * può arrivare dalla riga già in mano alla UI invece che da una testata riletta.
 *
 * In `IS` il filtro è il **solo** AUFPL della testata (`OrderInternalBillOfOperations`), e dal
 * 2026-08-17 diventa un `$filter=OrderInternalBillOfOperations eq '…'` sulla collection del
 * `_QUERYGET`: identifica già le operazioni di quell'ordine, e il numero d'ordine non viene
 * inviato perché il solo criterio contrattato su questo indirizzo è l'AUFPL. Fino a quella data
 * era un key predicate con `OrderIntBillOfOperationsItem` a `0`, e da un indirizzo per chiave non
 * esce una lista (DEC-45). In `ONPREM` il filtro è SOLO il numero d'ordine, cioè la query
 * identica a prima del rilascio (DEC-34). L'origine del criterio non cambia: l'AUFPL lo porta la
 * testata (DEC-42, la parte che resta in vigore).
 *
 * **`null` = lettura NON eseguibile su questo canale.** In `IS` senza l'AUFPL non c'è criterio da
 * spingere: il numero d'ordine su questo indirizzo non è contrattato, e una collection senza
 * filtro sarebbe le operazioni di TUTTI gli ordini. Non è un ripiego: è una chiamata che sappiamo
 * perduta, e chi chiama deve dichiararla invece di farla.
 *
 * @param {string} mode 'IS' | 'ONPREM' — `source.mode` della sorgente ordini
 * @param {object} order riga di `A_ProductionOrder_2` (serve `ManufacturingOrder`, e in `IS`
 *   `OrderInternalBillOfOperations`: va richiesto nel `$select` della testata)
 * @returns {object|null} il filtro da spingere, oppure `null` se la lettura non è eseguibile
 */
function operationsFilter(mode, order) {
  const aufpl = String((order && order.OrderInternalBillOfOperations) || '').trim();
  if (mode !== 'IS') return { ManufacturingOrder: order ? order.ManufacturingOrder : undefined };
  return aufpl ? { OrderInternalBillOfOperations: aufpl } : null;
}

/**
 * [IS-FULL-KEY] Il numero di PRENOTAZIONE (RSNUM) dell'ordine.
 *
 * Nel servizio standard non esiste un campo della testata che lo porti, e l'iFlow lo **veicola**
 * dentro `MasterProductionOrder` (contratto E-12/E-13). È un CONTENITORE, non il significato SAP
 * di quel campo, che sarebbe `MAUFNR` — l'ordine superiore di un ordine collettivo. Questa
 * funzione è l'**unico** punto del progetto che conosce la mappatura: il giorno in cui la
 * prenotazione arrivasse in un campo suo, si cambia qui e nient'altro. Vedi DEC-42.
 */
function reservationOf(order) {
  return String((order && order.MasterProductionOrder) || '').trim();
}

/**
 * [IS-QUERYGET-COMP] Filtro della lettura dei COMPONENTI di un ordine.
 *
 * In `IS`, con la prenotazione nota, il criterio è la **sola** prenotazione, e diventa un
 * `$filter=Reservation eq '…'` sulla collection del `_QUERYGET`: il numero d'ordine non viene
 * inviato, perché il solo criterio contrattato su questo indirizzo è il RSNUM. In `ONPREM` è il
 * numero d'ordine, cioè la query identica a prima del rilascio (DEC-34).
 *
 * Quello che restituisce non è cambiato con il passaggio a `_QUERYGET` (DEC-43): è cambiato **cosa
 * ne fa la sorgente**, che prima ne componeva un key predicate e ora lo spinge come `$filter`.
 *
 * **`null` = lettura NON eseguibile su questo canale.** Senza prenotazione non resta alcun
 * criterio: una collection interrogata senza filtro non è la lettura dei componenti di un ordine,
 * è la lettura di tutto. Chi chiama la dichiara invece di tentarla.
 *
 * @returns {object|null} il filtro da spingere, oppure `null` se la lettura non è eseguibile
 */
function componentsFilter(mode, order) {
  const reservation = reservationOf(order);
  if (mode !== 'IS') return { ManufacturingOrder: order ? order.ManufacturingOrder : undefined };
  return reservation ? { Reservation: reservation } : null;
}

/** Due numeri d'ordine sono lo stesso ordine? Tollerante sugli zeri iniziali (vedi sotto). */
function sameOrder(a, b) {
  const norm = (v) => String(v == null ? '' : v).trim().replace(/^0+(?=\d)/, '');
  return norm(a) === norm(b);
}

/**
 * [IS-QUERYGET-OPS] Il presidio che sostituisce il numero d'ordine tolto dal filtro: delle righe
 * lette si tengono solo quelle dell'ordine chiesto. Vale solo dove il criterio è stato tolto,
 * cioè in `IS`, dove si spinge il solo AUFPL; in `ONPREM` il numero d'ordine è spinto e non c'è
 * nulla da verificare. Il passaggio a `_QUERYGET` non lo rende superfluo (DEC-45): il criterio
 * spinto resta l'AUFPL, solo come `$filter` invece che come key predicate.
 *
 * Il confronto è **tollerante sugli zeri iniziali** e solo qui: se l'indirizzo restituisse il
 * numero senza riempimento, un confronto secco scarterebbe TUTTE le righe di un ordine
 * corretto — un presidio che si trasforma in perdita di dati è peggio del problema che
 * sorveglia. Sulla richiesta invece non si normalizza nulla (contratto C-7).
 *
 * Una riga che non porta `ManufacturingOrder` nel `$select` non è giudicabile e si tiene:
 * il controllo è possibile solo dove il campo è stato chiesto.
 *
 * @returns {{kept: Array<object>, dropped: number, checked: boolean}}
 */
function keepOperationsOfOrder(mode, order, rows) {
  const aufpl = String((order && order.OrderInternalBillOfOperations) || '').trim();
  return keepOfOrder(rows, order && order.ManufacturingOrder, mode === 'IS' && !!aufpl);
}

/**
 * [IS-QUERYGET-COMP] Lo stesso presidio per i COMPONENTI, dove il numero d'ordine non viene
 * inviato in `IS` **mai** — il solo criterio contrattato è la prenotazione. Il passaggio a
 * `_QUERYGET` non lo rende superfluo: il criterio spinto resta il RSNUM, che arriva da un campo
 * riusato della testata. Righe di altri ordini non sono un dato da mostrare: sono il segnale che
 * quel campo non porta la prenotazione attesa, e che il risultato potrebbe essere anche
 * INCOMPLETO. Chi chiama lo dichiara nel log.
 *
 * @returns {{kept: Array<object>, dropped: number, checked: boolean}}
 */
function keepComponentsOfOrder(mode, order, rows) {
  return keepOfOrder(rows, order && order.ManufacturingOrder, mode === 'IS');
}

/** Il filtro a valle condiviso dai due presidi. `check: false` = il criterio era spinto. */
function keepOfOrder(rows, wanted, check) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  if (!check) return { kept: list, dropped: 0, checked: false };
  const kept = list.filter(r => !r || r.ManufacturingOrder === undefined || sameOrder(r.ManufacturingOrder, wanted));
  return { kept, dropped: list.length - kept.length, checked: true };
}

// ================================================================
// [ORDER-CYCLE-SEED] LA TESTATA DELL'ORDINE, QUANDO L'INDIRIZZO PER CHIAVE NON LA CONSEGNA.
//
// Sull'Integration Suite la testata ha DUE service root: `A_ProductionOrder_2.GET`
// (…PRODUCTIONORDER_GET) e `A_ProductionOrder_2.QUERY` (…PRODUCTIONORDER_QUERYGET). La lista del
// cockpit legge dal secondo e funziona; le letture per chiave del dettaglio leggono dal primo, e
// quando quello non consegna la riga — 404, che la sorgente traduce in «elemento assente», oppure
// riga priva di identità ([IS-BLANK-ROWS]) — chi chiama vede `null` e non ha modo di distinguere
// «l'ordine non esiste» da «quell'indirizzo non lo restituisce». Sull'ordine 000700000162 (plant
// 07, materiale 3201816) costava l'intero import del ciclo: l'action usciva dichiarando l'ordine
// introvabile mentre la lista, un pannello più a sinistra, ne mostrava materiale e plant.
//
// È la stessa lezione di DEC-43/44/45, presa dal verso opposto: là una lista chiesta a un
// indirizzo per chiave rispondeva 500, qui una riga chiesta per chiave non arriva e la collection
// ce l'ha. Quindi il ripiego NON è «riprova»: è un'altra FORMA, su un altro root.
//
// TRE REGOLE.
//   1. Il PLANT va nel filtro della collection. `SO_PLANT` è obbligatorio nella firma delle
//      funzioni ABAP dietro gli iFlow: senza, la risposta è `200` con zero righe — rotta giusta,
//      wrapper giusto, niente dentro, indistinguibile da «non c'è» (DEC-49). Chi chiama passa i
//      plant del proprio perimetro.
//   2. Non si usa `SELECT.one`: `deriveOp` instraderebbe la query di nuovo sul `_GET`
//      (srv/lib/isQueryShape.js). La forma di collection si ottiene solo senza chiave e senza
//      `one`, e la riga si sceglie a valle con `pickOrderHeader`.
//   3. Il ripiego scatta SOLO quando la prima forma non ha consegnato: in ONPREM, dove il gateway
//      risponde alla lettura per chiave come sempre, nessuna lettura riuscita cambia forma
//      (DEC-34). Una chiamata in più esiste solo là dove oggi c'è un vicolo cieco.
//
// Quale forma ha consegnato la testata si DICHIARA (`shape`, `notes`): un ripiego silenzioso
// renderebbe invisibile il difetto del root per chiave, che va aggiustato a monte.
// ================================================================

/** Il campo è arrivato con un valore utilizzabile? (vuoto e spazi = non arrivato) */
function fieldFilled(row, field) {
  return String((row && row[field]) ?? '').trim() !== '';
}

/**
 * La testata è utilizzabile da chi l'ha chiesta? Non basta che la riga esista: i campi che il
 * chiamante ha dichiarato indispensabili devono portare un valore. Una riga `200` ben formata con
 * i campi iniziali è il difetto di E-13, e trattarla come buona sposta l'errore più a valle.
 * @param {object|null} row
 * @param {Array<string>} required
 * @returns {boolean}
 */
function headerUsable(row, required) {
  if (!row) return false;
  return (required || []).every((f) => fieldFilled(row, f));
}

/**
 * [ORDER-CYCLE-SEED] La riga dell'ordine chiesto, fra quelle di una lettura di collection.
 *
 * PURA: nessuna dipendenza da cds né dalla rete (test: node test/prodOrderOps.test.js).
 *
 * Il confronto è **tollerante sugli zeri iniziali**, come `keepOfOrder`: se l'indirizzo
 * restituisse il numero senza riempimento, un confronto secco scarterebbe la riga di un ordine
 * corretto — e qui lo scarto significa «ordine introvabile», cioè l'errore da cui veniamo.
 *
 * L'AMBIGUITA' SI DICHIARA, e non è «più di una riga»: righe ripetute dello stesso ordine sono
 * innocue, perché dicono la stessa cosa. È ambiguo quando le righe dell'ordine NON CONCORDANO su un
 * campo che serve a chi legge — due materiali diversi per lo stesso ordine — e là prendere la prima
 * significherebbe importare il ciclo del materiale sbagliato: si rinuncia (stessa regola di
 * DEC-70, dove una chiave che torna ambigua si rifiuta invece di prendere la prima riga).
 *
 * @param {Array<object>|object|null} rows righe della collection
 * @param {*} ManufacturingOrder ordine chiesto
 * @param {Array<string>} [fields] i campi su cui le righe devono concordare (quelli che rendono
 *        la testata utilizzabile per chi l'ha chiesta)
 * @returns {{ row: object|null, ambiguous: boolean, disagreeOn: Array<string>, candidates: number,
 *            dropped: number }}
 */
function pickOrderHeader(rows, ManufacturingOrder, fields = []) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  // Righe prive di identità: qui si scartano, perché senza numero d'ordine non sono attribuibili
  // (la sorgente le dichiara ma non le tocca, TD-10).
  const identified = list.filter((r) => fieldFilled(r, 'ManufacturingOrder'));
  const mine = identified.filter((r) => sameOrder(r.ManufacturingOrder, ManufacturingOrder));
  const disagreeOn = (fields || []).filter(Boolean).filter((f) =>
    new Set(mine.map((r) => String((r && r[f]) ?? '').trim())).size > 1);
  return {
    row: disagreeOn.length > 0 ? null : (mine[0] || null),
    ambiguous: disagreeOn.length > 0,
    disagreeOn,
    candidates: mine.length,
    dropped: list.length - identified.length
  };
}

/**
 * [ORDER-CYCLE-SEED] La testata di un ordine, con il ripiego di forma descritto sopra.
 *
 * @param {object} source la sorgente d'area (`await prodOrderSource()`), non `cds.connect.to`
 * @param {string} ManufacturingOrder
 * @param {object} opts
 * @param {Array<string>} opts.columns colonne indispensabili
 * @param {Array<string>} [opts.optionalColumns] colonne che qualche sistema non espone: se il
 *        `$select` completo fallisce si rilegge senza di esse, come faceva l'auto-import
 * @param {Array<string>} [opts.require] campi che rendono la riga utilizzabile (default `Material`)
 * @param {Array<string>} [opts.plants] plant del perimetro di chi chiede, per il filtro del ripiego
 * @returns {Promise<{order: object|null, shape: 'key'|'collection'|'none', optionalDropped: boolean,
 *                    notes: Array<string>, note: string}>}
 */
async function readOrderHeader(source, ManufacturingOrder, opts = {}) {
  const { A_ProductionOrder_2 } = source.entities;
  const columns = (opts.columns || []).filter(Boolean);
  const optional = (opts.optionalColumns || []).filter(Boolean);
  const required = (opts.require && opts.require.length) ? opts.require : ['Material'];
  const plants = (opts.plants || []).filter(Boolean);
  const notes = [];
  let optionalDropped = false;

  const byKey = (cols) => source.run(
    SELECT.one.from(A_ProductionOrder_2).columns(...cols).where({ ManufacturingOrder })
  );

  let order = null;
  try {
    order = await byKey([...new Set([...columns, ...optional])]);
  } catch (e) {
    optionalDropped = optional.length > 0;
    if (optional.length) {
      notes.push(`colonne ${optional.join(', ')} non disponibili su questo canale (${e.message})`);
      try {
        order = await byKey(columns);
      } catch (e2) {
        notes.push(`lettura per chiave non riuscita: ${e2.message}`);
        order = null;
      }
    } else {
      notes.push(`lettura per chiave non riuscita: ${e.message}`);
    }
  }

  if (headerUsable(order, required)) {
    return { order, shape: 'key', optionalDropped, notes, note: notes.join(' | ') };
  }

  notes.push(order
    ? `l'indirizzo per chiave ha restituito una riga senza ${required.join('/')}`
    : "l'indirizzo per chiave non ha restituito la testata");

  if (!plants.length) {
    // Senza plant il ripiego non ha un filtro da spingere, e una collection senza filtro sarebbe
    // la lettura di tutti gli ordini: si dichiara invece di tentarla (DEC-49).
    notes.push('ripiego su collection non eseguito: nessun plant nel perimetro di chi legge');
    return { order: null, shape: 'none', optionalDropped, notes, note: notes.join(' | ') };
  }

  // Il ripiego chiede le sole colonne INDISPENSABILI, non quelle opzionali. Il `$select` che
  // questo root consegna di sicuro è quello della lista del cockpit (`LIST_COLUMNS` in
  // srv/lib/orderRows.js, dove vive anche quello del job), che
  // NON comprende il riferimento al ciclo: chiederlo qui rischierebbe di far cadere anche la
  // seconda forma, cioè di perdere la testata per un campo che non è indispensabile. Chi ha bisogno
  // di quelle colonne sa dal ritorno che non sono arrivate.
  if (optional.length) {
    notes.push(`ripiego su collection: colonne opzionali (${optional.join(', ')}) non richieste`);
    optionalDropped = true;
  }
  try {
    const rows = await source.run(
      SELECT.from(A_ProductionOrder_2)
        .columns(...columns)
        .where({ ManufacturingOrder, ProductionPlant: { in: plants } })
        .limit(HEADER_MAX_ROWS) // [ORDER-TOP] senza `$top` questo root rende zero righe
    );
    const pick = pickOrderHeader(rows, ManufacturingOrder, required);
    if (pick.ambiguous) {
      notes.push(`ripiego su collection: ${pick.candidates} righe dello stesso ordine in disaccordo`
        + ` su ${pick.disagreeOn.join(', ')}, riga non attribuibile`);
      return { order: null, shape: 'none', optionalDropped, notes, note: notes.join(' | ') };
    }
    if (!headerUsable(pick.row, required)) {
      notes.push(`ripiego su collection: ${pick.row ? `riga senza ${required.join('/')}` : 'nessuna riga'}`
        + ` (plant interrogati: ${plants.join(', ')})`);
      return { order: null, shape: 'none', optionalDropped, notes, note: notes.join(' | ') };
    }
    notes.push(`testata letta come collection sul root della lista, plant ${plants.join(', ')}`);
    return { order: pick.row, shape: 'collection', optionalDropped, notes, note: notes.join(' | ') };
  } catch (e) {
    notes.push(`ripiego su collection non riuscito: ${e.message}`);
    return { order: null, shape: 'none', optionalDropped, notes, note: notes.join(' | ') };
  }
}

const prodOrderSource = createRemoteSource({
  base: BASE,
  envVar: 'PROD_ORDER_SOURCE',
  area: 'ordini',
  routes: ROUTES
});

// L'area ordini ha UNA sola sorgente, ed è quella qui sopra. Il 03/09/2026 ne è esistita una seconda
// per qualche ora — stessa base, stesse rotte, stessa leva, solo la destination diversa — perché la
// sonda del canale potesse eseguire dal server web la stessa lettura sui due canali. Ha risposto
// (DEC-123: mancano le autorizzazioni a valle del canale batch) ed è sparita con lei.

module.exports = prodOrderSource;
module.exports.ROUTES = ROUTES;
// [ORDER-TOP] I tetti delle letture: server web e job leggono gli stessi numeri.
module.exports.listMaxRows = listMaxRows;
module.exports.DETAIL_MAX_ROWS = DETAIL_MAX_ROWS;
module.exports.HEADER_MAX_ROWS = HEADER_MAX_ROWS;
// [ORDER-STATUS-FILTER] RELEASED_STATE e isReleasedOpenOrder non sono piu' esportati: il
// criterio di stato e' customizing per plant dalla 0017 (srv/lib/prodOrderStatusFilter.js).
module.exports.operationsFilter = operationsFilter;
module.exports.reservationOf = reservationOf;
module.exports.componentsFilter = componentsFilter;
module.exports.keepOperationsOfOrder = keepOperationsOfOrder;
module.exports.keepComponentsOfOrder = keepComponentsOfOrder;
// [ORDER-CYCLE-SEED] testata dell'ordine con ripiego di forma (chiave -> collection col plant)
module.exports.pickOrderHeader = pickOrderHeader;
module.exports.headerUsable = headerUsable;
module.exports.readOrderHeader = readOrderHeader;

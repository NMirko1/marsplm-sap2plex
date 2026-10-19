/**
 * [MATDOC-CONF] Da una registrazione Plex ai documenti materiale SAP (feature 0021).
 *
 * FUNZIONI PURE: nessun `cds`, nessuna rete, nessun orologio — `day` arriva da fuori. È ciò che
 * rende collaudabili senza sistemi esterni le regole di un flusso che ne tocca due, come
 * srv/lib/splitRules.js e srv/lib/plexJobSortRules.js.
 *
 * COSA DIVENTA UNA REGISTRAZIONE
 *
 *   production entry   ->  documento '03' con il 261 di TUTTI i componenti dell'ordine
 *                      +   documento '02' con il 101 del prodotto
 *                      MA SOLO SE l'operazione è l'ULTIMA dell'ordine. Altrimenti: niente.
 *                      E I DUE VANNO INSIEME: senza righe di consumo non parte nemmeno il
 *                      versamento, perché un'entrata merci senza l'uscita dei componenti
 *                      sbilancia l'ordine ([MATDOC-FIX] U4, che sostituisce 0021 RB-12).
 *   scrap entry        ->  documento '03' con il 551 del pezzo scartato. Nessun 261.
 *   container adjust.  ->  niente: non ha un ordine, quindi non ha un movimento d'ordine.
 *
 * [CONF-POSTING] DALLA 0028 QUESTO SCHEMA E' IL DEFAULT, NON LA REGOLA. Un customizing per plant
 * (ZProdConfPostingConfig, regole in ./confPostingRules.js) puo' spostare il consumo su OGNI
 * operazione confermata e dare ai componenti dello scarto la sorte che la BBP §8.4.1 chiede — il
 * CONSUMO, «fino all'operazione di scarto» o «completo della BOM». Senza configurazione, e con la
 * configurazione di default, l'output di `buildDocuments` e' identico a quello di prima: e' la
 * proprieta' su cui poggia il blocco di regressione del collaudo.
 *
 * DUE DOCUMENTI E NON UNO, e non è una scelta. `IV_GOODS_MOVEMENT_CODE` è uno solo per chiamata:
 * '03' è un'uscita merci e '02' un'entrata, e non possono stare nella stessa busta. Da qui la
 * tabella figlia ZProdConfMatDoc, perché due documenti hanno due esiti e due numeri.
 *
 * I CONSUMI SOLO ALL'ULTIMA OPERAZIONE — e come si fa a saperlo
 * Plex non lo dice: `production-entries` non ha un flag di fine ciclo, ed è il motivo per cui
 * `isFinalConfirmation` era sempre `false` (0009, RB-20). Lo si chiede a SAP, leggendo le
 * operazioni dell'ordine e prendendo la più alta fra quelle RILASCIATE. Il campo che direbbe
 * esattamente «qui si fa l'entrata merci» è il control key `OperationControlProfile`, ma l'API ne
 * espone il CODICE e non il flag di auto-GR, che vive nel customizing SAP: se in un plant l'entrata
 * merci non è all'ultima operazione, servirà l'elenco dei control key e diventerà una costante per
 * plant. Finché non serve, non si inventa.
 *
 * Le registrazioni sulle operazioni precedenti non spariscono: si persistono `I` (ignorate,
 * terminali) e si contano. È la differenza fra «non produce movimenti» e «non è mai arrivata».
 *
 * LA QUANTITA' DEL 261 E' PROPORZIONALE, e la ragione è l'unica che conta:
 *
 *     qty componente = quantità registrata × RequiredQuantity / TotalQuantity
 *
 * L'ultima operazione può essere registrata PIU' DI UNA VOLTA (registrazioni parziali). Mandare
 * l'intera `RequiredQuantity` a ogni registrazione moltiplicherebbe il consumo per il numero di
 * registrazioni, cioè scaricherebbe merce che non è stata consumata. Con la proporzione, N
 * registrazioni parziali che sommano al pianificato consumano esattamente il pianificato, e una
 * registrazione unica a quantità piena dà lo stesso risultato di prima. La proporzione non è quindi
 * un'interpretazione prudente: è l'unica formula che non dipende da quante volte si registra.
 *
 * COSA SI LEGGE DA SAP E COSA RESTA VUOTO
 * Nessuna tabella di corrispondenza Plex -> SAP: i dati SAP vengono dall'ordine di produzione.
 *   Material, StorageLocation, Reservation, ReservationItem, EntryUnit  <- il COMPONENTE (261)
 *   Material, StorageLocation, EntryUnit                                <- la TESTATA  (101, 551)
 *   scrapReason, transactionType, jobCode                               -> testo riga, non un codice
 *   CostCenter, GoodsMovementReasonCode                                 -> VUOTI, vedi sotto
 *
 * `CostCenter` e `GoodsMovementReasonCode` non esistono su nessuna entity dell'ordine e non hanno
 * un corrispondente Plex. Partono vuoti: se il BAPI li pretende lo dirà con un BAPIRET2 in chiaro,
 * e allora diventeranno due costanti per plant. Inventarli adesso significherebbe imputare uno
 * scarto a un centro di costo scelto da noi.
 *
 * [CONF-POSTING] E' successo per uno dei due, e la fonte non era in SAP. `GoodsMovementReasonCode`
 * (`MOVE_REAS`) è ora **customizing per plant** — valore reale `0013` — insieme al magazzino di
 * prelievo e ai due testi: sono quattro colonne della riga `TYPE_FLOW = 'SCRAP'` della tabella
 * `ZMEST_LOCATION` della soluzione ABAP preesistente dello stesso cliente. Il **centro di costo
 * resta vuoto, e questa è la risposta definitiva**: `KOSTL` è vuoto su TUTTE le righe di quella
 * tabella, e quando si scarica con il riferimento all'ordine la parte ABAP di
 * `ZMARS_MATERIAL_DOC_POST` compila i campi mancanti derivandoli dall'ordine e dalle operazioni.
 * Un campo configurato **vuoto non entra nella riga**: non per il filo — `toAbapStruct` emette tutti
 * i campi dichiarati comunque — ma perché la riga è ciò che finisce in `RequestJson`, e a plant non
 * configurato deve restare identica a quella di prima. Vedi DEC-91.
 *
 * Collaudo: test/confMatDoc.test.js
 */

'use strict';

// [CONF-POSTING] Le REGOLE del customizing stanno in confPostingRules.js, che è puro come questo
// modulo: qui si APPLICANO. La separazione non è formale — quel file è collaudato da solo, e questo
// resta la sola sede della forma del documento materiale.
const R = require('./confPostingRules');
// [CONF-POSTING] La forma interna delle chiavi verso le FM su Integration Suite (DEC-58). Modulo
// puro anch'esso: questo file resta senza `cds` e senza rete.
const { internalKey } = require('./prodOrderConfKey');

/** Codici di movimento merci: '03' uscita (261, 551), '02' entrata (101). */
const GM_CODE_ISSUE = '03';
const GM_CODE_RECEIPT = '02';

/**
 * Sequenze dei documenti: la chiave di ZProdConfMatDoc insieme a PlexEntryId.
 *
 * [CONF-POSTING] `DOC_CONFIRM` (feature 0030) non e' un documento materiale: e' la CONFERMA
 * D'ORDINE, che sostituisce i due movimenti della produzione quando il plant ha `ProdPosting='CONF'`.
 * Sta nella stessa tabella per eredare prenotazione, tetto dei tentativi, recap e traccia — vedi il
 * commento sulla chiave in db/schema.cds.
 */
const DOC_ISSUE = 1;
const DOC_RECEIPT = 2;
const DOC_CONFIRM = 3;

/** Lunghezze SAP dei campi di testo, che `toAbap` NON tronca (padStart sui NUMC, e basta). */
const LEN_HEADER_TEXT = 25;   // MaterialDocumentHeaderText CHAR(25)
const LEN_REFERENCE = 16;     // ReferenceDocument          CHAR(16)
const LEN_ITEM_TEXT = 50;     // MaterialDocumentItemText   CHAR(50)
const LEN_CONF_TEXT = 40;     // ConfirmationText           CHAR(40), EDMX MaxLength="40"
const LEN_ORDER = 12;         // OrderID / AFRU-AUFNR       CHAR(12), conversion exit ALPHA
const LEN_UNIT = 3;           // ConfirmationUnit / MEINS    CHAR(3)

const cut = (v, len) => String(v === null || v === undefined ? '' : v).slice(0, len);
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Un flag SAP CHAR(1) è vero quando vale `X`. Tollerante su spazi e maiuscole, come la 0017. */
function flagOn(v) {
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase() === 'X';
}

/** Quanti materiali si nominano in una nota prima di dire «e altri». */
const NAMED_IN_NOTE = 8;

/**
 * L'elenco dei materiali di una nota, con un tetto. FUNZIONE PURA.
 *
 * Il tetto serve perché la nota viene troncata a 255 caratteri dal chiamante: con quaranta
 * componenti l'elenco mangerebbe la frase e le note successive. Il CONTEGGIO sta sempre prima
 * dell'elenco, così sopravvive al troncamento anche quando i nomi no — è il numero che dice se
 * guardare, i nomi dicono dove.
 */
function nameList(materials) {
  const list = (Array.isArray(materials) ? materials : []).filter(Boolean).map(String);
  if (!list.length) return '';
  const shown = list.slice(0, NAMED_IN_NOTE).join(', ');
  return list.length > NAMED_IN_NOTE ? `${shown} e altri ${list.length - NAMED_IN_NOTE}` : shown;
}

/**
 * L'albero Plex dell'ordine e' usabile come asse del perimetro? FUNZIONE PURA.
 *
 * DUE CONDIZIONI, e sono diverse da «questo componente non c'e'»: la lettura deve essere riuscita, e
 * l'albero deve avere almeno un componente allocato. Un ciclo di sole operazioni e' legittimo per
 * l'INVIO (srv/lib/orderCycleSeed.js lo dice), ma non permette di dire «fino a questa operazione».
 */
function allocationUsable(allocation) {
  return !!(allocation && allocation.ok && allocation.hasComponents);
}

/** Perche' l'albero non e' usabile, in una frase da mettere nel motivo. FUNZIONE PURA. */
function allocationGap(allocation) {
  if (!allocation) return 'quell\'albero non e\' stato caricato';
  if (!allocation.ok) return allocation.reason || 'quell\'albero non e\' leggibile';
  return 'il ciclo dell\'ordine non ha nessun componente assegnato a un\'operazione';
}

/**
 * Numero d'operazione confrontabile. FUNZIONE PURA.
 *
 * Plex manda `operationNumber` come INTERO (`20`), SAP `ManufacturingOrderOperation` come
 * `String(4)` con gli zeri davanti (`'0020'`). Il confronto è NUMERICO, ed è lo stesso già in
 * esercizio in createPlexProductionOrders (0009, RB-09): non è una regola nuova introdotta qui.
 *
 * Attenzione a non leggerlo come una violazione di DEC-51 (fra due chiavi SAP il confronto è
 * stretto e gli zeri NON si allineano): lì i due lati vengono entrambi da SAP e un disallineamento
 * è un difetto a monte da vedere. Qui i due lati vengono da SISTEMI DIVERSI, e la rappresentazione
 * del numero è una differenza di forma, non di dato.
 *
 * @returns {number|null} null se non è un numero: un'operazione non numerica non si confronta
 */
function opNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).trim());
  return Number.isFinite(x) ? x : null;
}

/**
 * L'ultima operazione RILASCIATA dell'ordine. FUNZIONE PURA.
 *
 * Se nessuna risulta rilasciata si considerano tutte: un ordine le cui operazioni non portano il
 * flag è un caso di lettura parziale, e rispondere «nessuna operazione finale» bloccherebbe ogni
 * registrazione di quell'ordine in silenzio. Il fatto viene dichiarato dal chiamante.
 *
 * [MATDOC-FIX] LE OPERAZIONI CANCELLATE ESCONO DALL'INSIEME, e non è una rifinitura.
 * L'ancora è il MASSIMO del numero d'operazione: una sola operazione cancellata numerata più in alto di quella vera — 0099
 * lasciata da una modifica del ciclo — spostava l'ancora su di sé, e da quel momento OGNI
 * registrazione di fine linea risultava «non è l'ultima» e veniva archiviata `'I'`, terminale e
 * senza errore. Non è il caso di un plant esotico: è il comportamento su dati SAP standard.
 * `OperationIsDeleted` è fra i 15 campi che l'iFlow delle operazioni d'ordine consegna, quindi la
 * correzione vale su entrambi i canali.
 *
 * Se TUTTE risultano cancellate non si ripiega su di esse: l'insieme resta vuoto, `value` è `null`,
 * e il chiamante lo tratta come «operazioni non leggibili» — cioè la registrazione NON viene
 * archiviata. È la direzione giusta: un ordine le cui operazioni sono tutte cancellate non ha
 * un'operazione di versamento, e questo è un dato da guardare, non una regola da applicare.
 *
 * @param {object[]} operations righe di A_ProductionOrderOperation_2
 * @returns {{value: number|null, fromReleased: boolean, count: number, deleted: number}}
 */
function lastOperationOf(operations) {
  const all = (Array.isArray(operations) ? operations : []).filter(Boolean);
  const list = all.filter((o) => !flagOn(o.OperationIsDeleted));
  const released = list.filter((o) => flagOn(o.OperationIsReleased));
  const pool = released.length ? released : list;
  const nums = pool.map((o) => opNum(o.ManufacturingOrderOperation)).filter((x) => x !== null);
  return {
    value: nums.length ? Math.max(...nums) : null,
    fromReleased: released.length > 0,
    count: pool.length,
    deleted: all.length - list.length
  };
}

/**
 * L'operazione della registrazione è l'ultima dell'ordine? FUNZIONE PURA.
 *
 * @param {string|number} entryOperation operazione SAP risolta della registrazione ('0020')
 * @param {object[]} operations righe di A_ProductionOrderOperation_2
 * @returns {{final: boolean, last: number|null, reason: string}}
 */
function isFinalOperation(entryOperation, operations) {
  const mine = opNum(entryOperation);
  const { value: last, fromReleased, count, deleted } = lastOperationOf(operations);
  if (mine === null) {
    return { final: false, last, reason: `operazione della registrazione non numerica ('${entryOperation}')` };
  }
  if (last === null) {
    return {
      final: false,
      last,
      reason: deleted
        ? `nessuna operazione utile sull'ordine: tutte e ${deleted} risultano cancellate`
        : 'nessuna operazione leggibile sull\'ordine'
    };
  }
  // Le due circostanze si dichiarano perché cambiano il SIGNIFICATO dell'ancora, e chi legge il
  // recap deve poterlo sapere senza andare a guardare l'ordine.
  const suffix = (fromReleased ? '' : ' (nessuna operazione risulta rilasciata: confronto su tutte)')
    + (deleted ? ` (${deleted} operazioni cancellate escluse)` : '');
  if (mine === last) {
    return { final: true, last, reason: `operazione ${mine} è l'ultima delle ${count} dell'ordine${suffix}` };
  }
  return {
    final: false,
    last,
    reason: `operazione ${mine} non è l'ultima dell'ordine (ultima: ${last})${suffix}`
  };
}

// ---------------------------------------------------------------------------------------------
// LE RIGHE
// ---------------------------------------------------------------------------------------------

/**
 * Le righe 261 del consumo componenti. FUNZIONE PURA.
 *
 * Un componente senza materiale o senza fabbisogno non genera riga: sarebbe una riga a zero, che
 * SAP rifiuta o registra a vuoto. Il fatto finisce nelle note, non in un movimento.
 *
 * [CONF-POSTING] `opts` è il perimetro e l'imputazione, e senza `opts` questa funzione fa esattamente
 * ciò che faceva prima della 0028: tutti i componenti, movimento 261, magazzino del componente,
 * nessuna causale. È la ragione per cui il blocco di regressione del collaudo può confrontare
 * l'output con e senza configurazione.
 *
 * @param {object[]} components righe di A_ProductionOrderComponent_2
 * @param {number} quantity quantità di riferimento: PRODOTTA per una production entry, SCARTATA per
 *   uno scarto. La proporzione è la stessa, cambia il numeratore
 * @param {object} order riga di A_ProductionOrder_2 (serve TotalQuantity)
 * @param {string} orderId
 * @param {string} text testo riga
 * @param {object} [opts]
 * @param {number|null} [opts.upTo] operazione oltre la quale i componenti non entrano; `null` o
 *   assente = tutta la distinta. E' l'asse dello SCARTO
 * @param {number|null} [opts.atOp] i componenti agganciati PROPRIO a questa operazione. E' l'asse di
 *   `EACH_OP`, e non e' lo stesso di `upTo`: vedi `confPostingRules.componentAtOp`. I due sono
 *   mutuamente esclusivi per costruzione (li imposta la funzione che decide il perimetro); se
 *   arrivassero entrambi, l'asse esatto prevale
 * @param {function} [opts.opOf] `(componente) => numero|null`: DOVE sta quel componente. La sorgente
 *   e' l'albero Plex dell'ordine (srv/lib/plexCycleAllocation.js), e arriva iniettata perche' questo
 *   modulo resta PURO — non legge tabelle, e non sa da dove venga l'asse. Senza `opOf` si ripiega
 *   sull'operazione della prenotazione SAP, che e' l'unica cosa che una riga componente porta con
 *   se': serve ai test e ai chiamanti che non hanno un albero, non e' il percorso di esercizio
 * @param {string} [opts.movementType] `'261'` (default) o `'551'`: l'imputazione, non il perimetro
 * @param {string} [opts.storageLocation] magazzino che PREVALE su quello del componente. Vuoto =
 *   quello del componente, cioè come prima
 * @param {string} [opts.reasonCode] causale del movimento (MOVE_REAS)
 * @returns {{items: object[], notes: string[], considered: number, inScope: number,
 *            unassigned: number}}
 *   `considered` sono i componenti ricevuti, `inScope` quelli dentro il perimetro d'operazione: la
 *   differenza fra «nessun componente a questa operazione» (normale con EACH_OP) e «i componenti non
 *   si leggono» (un dato che manca) si fa su questi due numeri, non sul conteggio delle righe.
 *   `unassigned` sono i componenti esclusi dall'asse esatto perché senza operazione leggibile: con
 *   `EACH_OP` non verranno consumati da nessuna registrazione, quindi si dichiarano
 */
function consumptionItems(components, quantity, order, orderId, text, opts = {}) {
  const notes = [];
  const upTo = opts.upTo === undefined ? null : opts.upTo;
  const atOp = opts.atOp === undefined ? null : opts.atOp;
  // L'asse: l'albero Plex se il chiamante lo passa, altrimenti la prenotazione SAP.
  const opOf = typeof opts.opOf === 'function'
    ? opts.opOf
    : ((c) => opNum(c.ManufacturingOrderOperation));
  const movementType = opts.movementType || '261';
  const forcedLoc = String(opts.storageLocation || '').trim();
  const reasonCode = String(opts.reasonCode || '').trim();
  const total = num(order && order.TotalQuantity);
  if (!(total > 0)) {
    notes.push(`ordine ${orderId}: TotalQuantity assente o zero, la quota dei componenti non è calcolabile`);
    return { items: [], notes, considered: 0, inScope: 0, unassigned: 0 };
  }
  const all = (Array.isArray(components) ? components : []).filter(Boolean);
  // [CONF-POSTING] Il perimetro d'operazione si applica PRIMA di tutto il resto: un componente fuori
  // perimetro non è un componente scartato per un dato mancante, e confonderli riempirebbe le note di
  // avvisi su una situazione normale.
  let list = all;
  let unassigned = 0;
  if (atOp !== null) {
    list = all.filter((c) => R.componentAtOp(opOf(c), atOp));
    unassigned = all.filter((c) => opOf(c) === null).length;
    if (unassigned) {
      // Non verranno consumati da NESSUNA registrazione: con l'asse esatto un componente che l'albero
      // non ha collocato non aggancia mai. È la stessa assenza che DEC-86 ferma in invio, e si guarda
      // — non si compensa qui, perché includerlo lo consumerebbe a ogni operazione.
      notes.push(`${unassigned} componenti non collocati nell'albero Plex dell'ordine: con il consumo `
        + 'per operazione non verranno consumati, va guardato il ciclo dell\'ordine');
    }
  } else if (upTo !== null) {
    list = all.filter((c) => R.componentInScope(opOf(c), upTo));
    // Sull'asse «fino a» un componente non collocato ENTRA (DEC-56: il criterio non valutabile su una
    // riga non sottrae), e si dichiara nominandolo: il costo e' un consumo in eccesso su quella riga,
    // limitato dalla distinta, mentre escluderlo lo perderebbe in silenzio.
    const orfani = all.filter((c) => opOf(c) === null).map((c) => c.Material).filter(Boolean);
    if (orfani.length) {
      notes.push(`${orfani.length} componenti non collocati nell'albero Plex dell'ordine, inclusi nel `
        + `perimetro: ${nameList(orfani)}`);
    }
  }
  const items = [];
  // [MATDOC-FIX] OGNI CAUSA COL SUO NOME, E I MATERIALI NOMINATI (DEC-56). Prima erano un
  // contatore unico e una frase che non diceva QUALI componenti fossero rimasti fuori: «12 componenti senza materiale,
  // senza fabbisogno o con quota sotto il millesimo» non permette di andare a guardare nulla, e le
  // due cause hanno rimedi opposti — un dato mancante sull'ordine contro una quota che a questa
  // quantità non arriva al millesimo.
  const senzaDato = [];
  const sottoSoglia = [];
  for (const c of list) {
    const required = num(c.RequiredQuantity);
    if (!c.Material || !(required > 0)) { senzaDato.push(c.Material || '(senza materiale)'); continue; }
    // LA PROPORZIONE. Vedi la testata: è l'unica formula che non dipende da quante volte si
    // registra l'ultima operazione.
    const qty = quantity * required / total;
    // Decimal(13,3): sotto il millesimo la riga sarebbe zero, e una riga a zero non è un consumo.
    if (!(Math.abs(qty) >= 0.0005)) { sottoSoglia.push(c.Material); continue; }
    const item = {
      GoodsMovementType: movementType,
      Material: c.Material,
      Plant: c.Plant || (order && order.ProductionPlant) || '',
      StorageLocation: forcedLoc || c.StorageLocation || '',
      QuantityInEntryUnit: qty,
      EntryUnit: c.BaseUnit || '',
      ManufacturingOrder: orderId,
      // Reservation/ReservationItem agganciano il consumo alla prenotazione dell'ordine: senza,
      // SAP registrerebbe un'uscita generica che non chiude il fabbisogno.
      Reservation: c.Reservation || '',
      ReservationItem: c.ReservationItem || '',
      MaterialDocumentItemText: cut(text, LEN_ITEM_TEXT)
    };
    // [CONF-POSTING] La causale entra nella riga solo se è configurata. Sul FILO non farebbe
    // differenza — `toAbapStruct` emette tutti i 94 campi dichiarati, con il vuoto per quelli che non
    // arrivano — ma questa riga finisce in `ZProdConfMatDoc.RequestJson`, cioè in ciò che il cockpit
    // mostra e che il blocco di regressione confronta: un campo sempre presente renderebbe l'output
    // a plant non configurato diverso da quello di prima, senza che nulla sia cambiato.
    if (reasonCode) item.GoodsMovementReasonCode = reasonCode;
    items.push(item);
  }
  if (senzaDato.length) {
    notes.push(`${senzaDato.length} componenti senza materiale o senza fabbisogno, nessuna riga: `
      + nameList(senzaDato));
  }
  if (sottoSoglia.length) {
    notes.push(`${sottoSoglia.length} componenti con quota sotto il millesimo su ${quantity} pz, `
      + `nessuna riga: ${nameList(sottoSoglia)}`);
  }
  return { items, notes, considered: all.length, inScope: list.length, unassigned };
}

/**
 * La riga 101 del versamento del prodotto. FUNZIONE PURA.
 *
 * Lotto e date di shelf life vengono dalla registrazione Plex: sono dati di FATTO del pezzo
 * prodotto, non codici da far corrispondere, e sono esattamente ciò che SAP non può dedurre da sé.
 */
function receiptItem(entry, order, orderId, text) {
  return {
    GoodsMovementType: '101',
    Material: (order && order.Material) || '',
    Plant: (order && order.ProductionPlant) || entry.Plant || '',
    StorageLocation: (order && order.StorageLocation) || '',
    QuantityInEntryUnit: num(entry.YieldQuantity),
    EntryUnit: (order && order.ProductionUnit) || entry.ConfirmationUnit || '',
    ManufacturingOrder: orderId,
    Batch: entry.LotNo || '',
    ShelfLifeExpirationDate: entry.ShelfDateTime || '',
    ManufactureDate: entry.ManufacturedDateTime || '',
    MaterialDocumentItemText: cut(text, LEN_ITEM_TEXT)
  };
}

/**
 * La riga 551 dello scarto. FUNZIONE PURA.
 *
 * `CostCenter` resta VUOTO di proposito: vedi la testata, e la conferma sta nel precursore ABAP, dove
 * la colonna `KOSTL` di ZMEST_LOCATION esiste e non è valorizzata su nessuna riga.
 *
 * [CONF-POSTING] `opts` porta ciò che il customizing decide, e senza `opts` la riga è identica a
 * quella di prima della 0028.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.withOrder=true] `false` per lo scarto di un pezzo GIA' VERSATO: il
 *   riferimento all'ordine non si cita, perché l'ordine può essere già chiuso — e il job PROD_TECO
 *   li chiude
 * @param {string} [opts.material] materiale che PREVALE su quello della testata: è il caso senza
 *   ordine, dove la testata non c'è e il materiale viene dal dizionario delle part Plex
 * @param {string} [opts.storageLocation] magazzino configurato (LGORT_FROM). Il precursore scarica
 *   sempre da qui e non dal magazzino di versamento dell'ordine
 * @param {string} [opts.reasonCode] causale (MOVE_REAS)
 */
function scrapItem(entry, order, orderId, text, opts = {}) {
  const withOrder = opts.withOrder !== false;
  const forcedLoc = String(opts.storageLocation || '').trim();
  const reasonCode = String(opts.reasonCode || '').trim();
  const item = {
    GoodsMovementType: '551',
    Material: String(opts.material || '').trim() || (order && order.Material) || '',
    Plant: (order && order.ProductionPlant) || entry.Plant || '',
    StorageLocation: forcedLoc || (order && order.StorageLocation) || '',
    QuantityInEntryUnit: num(entry.ScrapQuantity),
    // [CONF-POSTING] Senza ordine l'unità di misura resta VUOTA, e SAP usa quella base del materiale.
    // È lo stesso trattamento di CostCenter: non si inventa un valore, e se il BAPI lo pretende lo
    // dice con un BAPIRET2 in chiaro. La risposta di scrap-entries non ha `unit`, e il `unit` di Plex
    // non sarebbe comunque un'unità SAP (vedi il docblock di ConfirmationUnit in db/schema.cds).
    EntryUnit: withOrder ? ((order && order.ProductionUnit) || entry.ConfirmationUnit || '') : '',
    ManufacturingOrder: withOrder ? orderId : '',
    Batch: entry.LotNo || '',
    MaterialDocumentItemText: cut(text, LEN_ITEM_TEXT)
  };
  if (reasonCode) item.GoodsMovementReasonCode = reasonCode;
  return item;
}

/**
 * La testata di un documento. Le date le aggiunge materialDocPost.buildPayload da `day`.
 *
 * [CONF-POSTING] `headText` è il testo di testata configurato (HEADER_TXT del precursore, valore
 * reale `PLEX Scrap`): il cliente si aspetta una stringa fissa e riconoscibile in MB51, e ci si
 * accoda il riferimento al lotto Plex finché i 25 caratteri lo consentono. Senza, la testata è quella
 * di prima della 0028.
 */
function headerFor(code, entry, orderId, headText = '') {
  const fixed = String(headText || '').trim();
  const ref = entry.PlexJobNumber || orderId;
  // Senza testo configurato E senza riferimento la testata resta VUOTA: `Plex ` con lo spazio in coda
  // sarebbe un testo che non dice niente, mandato a SAP. E' il caso dello scarto senza lotto su un
  // plant che non ha configurato ScrapHeadTxt.
  const text = fixed
    ? cut(ref ? `${fixed} ${ref}` : fixed, LEN_HEADER_TEXT)
    : (ref ? cut(`Plex ${ref}`, LEN_HEADER_TEXT) : '');
  return {
    GoodsMovementCode: code,
    // 25 caratteri: il lotto di lavoro Plex è ciò che rende il documento riconoscibile in MB51.
    MaterialDocumentHeaderText: text,
    ReferenceDocument: cut(orderId, LEN_REFERENCE)
  };
}

/**
 * Il testo riga: i codici Plex senza corrispondente SAP, dove restano leggibili.
 *
 * [CONF-POSTING] `prefix` è il testo configurato dello scarto senza lotto (LATE_SCRAP_TXT del
 * precursore, valore reale `Scarto post produzione`). Va PRIMA di tutto, perché è ciò che l'utente
 * cerca in MB51 e i 50 caratteri si esauriscono: il resto è dettaglio, e se viene tagliato il
 * documento resta comunque riconoscibile per quello che è.
 */
function itemText(entry, prefix = '', limit = LEN_ITEM_TEXT) {
  // [CONF-POSTING] UN IDENTIFICATIVO STA INTERO O NON STA, UNA DESCRIZIONE SI PUO' TAGLIARE. E' la
  // regola che decide questa composizione, e viene dai dati veri: con i valori osservati il
  // 25/08/2026 su Albacina — causale `RDF_Operatore`, tipo `Control Panel Scrap`, serie `S000010`,
  // lotto `000500183460` — i pezzi da mettere misurano 68 caratteri su un campo da 50.
  //
  // Il numero di SERIE e' l'unico modo di risalire al contenitore fisico, e tagliato diventa un
  // numero SBAGLIATO — `S00001` e' un altro contenitore. Quindi si PRENOTA il suo posto e va davanti;
  // il resto occupa quello che resta, e se una descrizione viene tagliata resta comunque leggibile.
  // Prima il numero di serie stava terzo, dopo un `transactionType` che si mangia 19 caratteri per
  // dire una cosa con due soli valori — e persistita comunque in `ZProdConfPlexEntry.TransactionType`:
  // sopravviveva per due caratteri, e con una causale lunga (il contratto la da' fino a 50) sparirebbe.
  const SEP = ' \u00b7 ';
  const trimSep = (t) => t.replace(/\s*\u00b7\s*$/, '');

  const serial = entry.SerialNo ? `SN ${entry.SerialNo}` : '';
  const resto = [];
  const head = String(prefix || '').trim();
  if (head) resto.push(head);
  if (entry.SourceType === 'S') {
    if (entry.ScrapReason) resto.push(entry.ScrapReason);
    if (entry.TransactionType) resto.push(entry.TransactionType);
  }
  if (entry.PlexJobNumber) resto.push(`Plex ${entry.PlexJobNumber}`);

  // [CONF-POSTING] `limit` esiste perche' la CONFERMA d'ordine ha un campo di testo da 40 caratteri
  // invece di 50 (feature 0030): la regola di composizione e' la stessa e non si duplica, cambia solo
  // lo spazio disponibile. Il default e' il campo del documento materiale, quindi i chiamanti di
  // prima non cambiano di un byte.
  const budget = serial ? limit - serial.length - SEP.length : limit;
  // Il separatore APPESO si toglie: quando il taglio cade su di lui, in MB51 quel carattere si legge
  // come un dato mancante.
  const coda = trimSep(cut(resto.join(SEP), Math.max(budget, 0)));
  if (!serial) return coda;
  return coda ? `${serial}${SEP}${coda}` : serial;
}


/**
 * [CONF-POSTING] La data e l'ora Plex in forma ABAP, o NIENTE. FUNZIONE PURA (feature 0030).
 *
 * `ConfirmationExternalEntryDate` e' `dats` e `...Time` e' `tims`, e l'encoder accetta una `Date`
 * oppure una stringa gia' formattata (srv/lib/sapPostEncoding.js). Qui serve la seconda forma,
 * perche' il payload viene serializzato in `RequestJson` e riletto al momento dell'invio: una `Date`
 * tornerebbe come stringa ISO, che l'encoder passerebbe a SAP cosi' com'e' — un letterale xsd:date
 * illegale.
 *
 * O ENTRAMBE O NESSUNA. Una data senza ora si legge come «a mezzanotte», e un'ora senza data non
 * dice niente: e' la stessa regola della coppia di tempi di DEC-59, applicata a una marca sola.
 */
function plexStamp(value) {
  if (value === null || value === undefined || value === '') return { date: '', time: '' };
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  };
}

/**
 * [CONF-POSTING] I valori della CONFERMA D'ORDINE di una registrazione. FUNZIONE PURA (feature 0030).
 *
 * Sono i valori, non il corpo della chiamata: la busta la costruisce
 * `srv/lib/prodOrderConfPost.js`, che porta l'inventario dei 105 campi e la codifica ABAP. Tutto
 * quello che non c'e' qui parte VUOTO, ed e' voluto — materiale, plant, centro di lavoro, magazzino
 * e lotto li deriva SAP dall'ordine.
 *
 * CINQUE SCELTE, e ognuna ha un modo di sbagliare che non da' errore.
 *
 * 1. `APIConfHasNoGoodsMovements: false`. La sonda lo manda a `true` — «SAP non muova niente» — che
 *    per lei era giusto, perche' i movimenti li facevamo noi. Qui e' l'opposto: e' la riga che, se
 *    sbagliata, da' un ordine confermato con NESSUNA merce mossa e un run verde.
 * 2. `OpenReservationsIsCleared: false`. Chiudere le prenotazioni aperte a ogni conferma direbbe a
 *    SAP «di questo ordine non uscira' altro», e su un ordine confermato piu' volte — un lotto Plex
 *    per volta — cancellerebbe il fabbisogno residuo.
 * 3. `IsFinalConfirmation: true`, come il precursore ABAP. Non chiude l'ordine e non impedisce una
 *    conferma successiva: dice che per quella quantita' l'avanzamento e' completo.
 * 4. `ConfirmationScrapQuantity` NON si manda. Lo scarto ha il suo flusso (le regole della 0028) e
 *    mandarlo qui lo registrerebbe DUE volte. Il prezzo e' dichiarato: in CO14 la quantita' di
 *    scarto resta a zero.
 * 5. `OrderID` in forma INTERNA. `AFRU-AUFNR` e' CHAR(12) con conversion exit ALPHA, e su questo
 *    canale l'ordine arriva senza riempimento: il riempimento e' dell'EMISSIONE (DEC-58). Non si
 *    aggiunge a `CONF_KEY_LENGTHS` perche' la' lo applicherebbe anche la sonda, che ha una leva
 *    (`PRODCONF_POST_ORDER`) fatta apposta per provare la forma ESTERNA.
 *
 * `PostingDate` non c'e': dipende dall'istante di invio e la mette chi spedisce, come
 * `materialDocPost.buildPayload` fa con le date del documento.
 */
function confirmationFor(entry, order, orderId, qty) {
  const stamp = plexStamp(entry.EntryDate);
  return {
    OrderID: internalKey(orderId, LEN_ORDER),
    ConfirmationYieldQuantity: qty,
    // L'unita' dell'ORDINE, che e' quella in cui la quantita' e' espressa: `ZProdConfPlexEntry`
    // la porta gia' risolta da SAP, e il `unit` di Plex non e' un'unita' SAP (vedi il docblock
    // della colonna in db/schema.cds). Se non la sappiamo resta vuota e la deriva SAP — che e'
    // meglio che mandarne una inventata.
    ConfirmationUnit: cut((order && order.ProductionUnit) || entry.ConfirmationUnit || '', LEN_UNIT),
    IsFinalConfirmation: true,
    APIConfHasNoGoodsMovements: false,
    OpenReservationsIsCleared: false,
    ConfirmationText: cut(itemText(entry, '', LEN_CONF_TEXT), LEN_CONF_TEXT),
    ConfirmationExternalEntryDate: stamp.date,
    ConfirmationExternalEntryTime: stamp.time
  };
}

/**
 * I documenti materiale di una registrazione. FUNZIONE PURA.
 *
 * NON LANCIA: una registrazione che non produce documenti restituisce `documents: []` e dice
 * perché in `notes` e `ignore`. La distinzione fra le due è ciò che il chiamante scrive in
 * `Status`:
 *   `ignore: true`   -> 'I', terminale: la regola dice che questa registrazione non genera nulla;
 *   `ignore: false`  -> resta da elaborare: manca un dato, e il dato può arrivare.
 *
 * `degrade: true` dice al chiamante che il fatto va nel recap come ATTENZIONE e non come nota
 * informativa. Non coincide con `ignore: false`: la maggior parte delle sospensioni è un'attesa
 * normale (le operazioni arriveranno), mentre «nessuna riga di consumo» è una condizione su cui
 * qualcuno deve guardare, perché è l'unico caso in cui prima uscivano merci senza il loro consumo.
 *
 * [CONF-POSTING] `config` è il customizing del plant (feature 0028). SENZA `config` — o con la
 * configurazione di default — questa funzione fa esattamente ciò che faceva prima: è la proprietà su
 * cui poggia il blocco di regressione del collaudo, e la ragione per cui la feature può uscire vicino
 * al go-live.
 *
 * @param {object} args
 * @param {object} args.entry riga di ZProdConfPlexEntry già risolta (ordine, operazione, plant)
 * @param {object} args.order riga di A_ProductionOrder_2
 * @param {object[]} args.components righe di A_ProductionOrderComponent_2
 * @param {object[]} args.operations righe di A_ProductionOrderOperation_2
 * @param {object} [args.config] riga di ZProdConfPostingConfig, anche non normalizzata
 * @param {string} [args.noOrderMaterial] il materiale SAP risolto dal dizionario delle part Plex,
 *   per lo scarto di un pezzo già versato. Il dizionario è una lettura, quindi la risoluzione sta nel
 *   chiamante: qui arriva il risultato
 * @param {object} [args.allocation] l'albero Plex dell'ordine, nella forma che
 *   `srv/lib/plexCycleAllocation.js` restituisce: `{ ok, hasComponents, opOf }`. Serve SOLO ai modi
 *   che hanno un perimetro d'operazione, e chi non li usa non deve leggerla — per questo arriva da
 *   fuori e non è obbligatoria
 * @returns {{documents: object[], notes: string[], ignore: boolean, degrade?: boolean,
 *            cause: string, reason: string}}
 *   `cause` è il CODICE dell'esito, e serve al recap: il motivo è una frase con dentro numeri
 *   d'ordine e d'operazione, quindi raggrupparlo per prefisso darebbe un gruppo per registrazione —
 *   è lo stesso difetto che [MATDOC-FIX] ha corretto sul campionamento della quarantena.
 */
function buildDocuments({ entry, order, components = [], operations = [], config = null,
  noOrderMaterial = '', allocation = null } = {}) {
  const e = entry || {};
  const cfg = R.normalizeConfig(config);
  const orderId = e.ManufacturingOrder || '';
  const notes = [];
  const text = itemText(e);
  // [CONF-POSTING] «Ha un lotto di produzione» lo dice la REGISTRAZIONE, non la nostra risoluzione.
  // Il contratto Plex dichiara `jobId` opzionale su tutte e tre le letture, e le due assenze hanno
  // rimedi opposti: senza `jobId` non c'è un ordine da trovare (ed è il caso dello scarto di un pezzo
  // già versato), mentre un `jobId` che non risolve è un mapping che può ancora arrivare.
  //
  // Un ordine RISOLTO è però prova di un lotto per costruzione — la sua unica strada è
  // ZProdOrderPlexMapping, che si cerca per `jobId` — quindi vale come riscontro: così una riga
  // storica cui `JobId` non fosse valorizzato non viene letta come uno scarto post-produzione.
  const hasJob = !!String(e.JobId || '').trim() || !!orderId;

  // Le rettifiche di giacenza non hanno un ordine, quindi non hanno un movimento d'ordine. Si
  // leggono e si persistono; quale movimento SAP debbano diventare non è stato deciso, e
  // sceglierlo qui significherebbe scrivere movimenti contabili a caso.
  if (e.SourceType === 'A') {
    return {
      documents: [],
      notes,
      ignore: true,
      cause: 'ADJUSTMENT',
      reason: 'rettifica di giacenza: nessun movimento SAP definito, registrazione conservata in staging'
    };
  }

  // [CONF-POSTING] «Senza lotto» e «lotto non risolto» si separano QUI, e solo per lo scarto: una
  // production entry senza lotto non è attribuibile a nessun ordine, quindi non ha una distinta da
  // consumare né un ordine su cui versare, ed è terminale — non un'attesa.
  if (!hasJob && e.SourceType !== 'S') {
    return {
      documents: [], notes, ignore: true, cause: 'NO_JOB_PROD',
      reason: 'registrazione di produzione senza lotto Plex: non è attribuibile a un ordine SAP, '
        + 'nessun movimento possibile'
    };
  }
  if (hasJob && !orderId) {
    return { documents: [], notes, ignore: false, cause: 'ORDER_UNRESOLVED', reason: 'ordine non risolto' };
  }

  // L'ancora del versamento serve a tre decisioni: se questa è l'ultima operazione (prodotto), se lo
  // scarto è all'operazione di versamento, e da dove parte il perimetro dei componenti.
  const anchor = lastOperationOf(operations).value;
  const entryOp = opNum(e.OrderOperation);
  // [CONF-POSTING] Il numero dell'operazione PLEX della registrazione: e' l'asse su cui si misura il
  // perimetro dei componenti, e non e' `entryOp`. Quello e' SAP e serve al confronto con l'ancora.
  const plexOp = opNum(e.OperationNumber);
  // L'asse dei componenti, se l'albero e' arrivato. Chi NON ha un perimetro d'operazione non lo guarda
  // nemmeno: il chiamante lo legge solo quando serve, e i due rami qui sotto lo pretendono solo dove
  // `at` o `upTo` sono valorizzati.
  const opOf = allocation && typeof allocation.opOf === 'function' ? allocation.opOf : null;

  // ---- SCARTO ----------------------------------------------------------------------------------
  if (e.SourceType === 'S') {
    const qty = num(e.ScrapQuantity);
    if (!(qty > 0)) {
      return {
        documents: [], notes, ignore: true, cause: 'SCRAP_ZERO',
        reason: 'scarto a quantità zero: nessun movimento'
      };
    }

    const plan = R.scrapPlan(cfg, { hasJob, entryOp, plexOp, anchor });

    // [CONF-POSTING] UNA MODALITA' CONFIGURATA A CUI MANCA IL SUO DATO NON RICADE SUL DEFAULT.
    // `GR_OP_ONLY` e `UP_TO_OP` hanno bisogno dell'ancora e dell'operazione della registrazione: se
    // non si leggono, il default farebbe partire un movimento che il plant ha chiesto di NON fare —
    // ed è esattamente il 551 su operazione intermedia che questa feature è nata per chiudere.
    // «Non lo so» non diventa «no» (DEC-80): si sospende, e il dato può arrivare.
    if (hasJob && (cfg.ScrapIssue === 'GR_OP_ONLY' || cfg.ScrapConsume === 'UP_TO_OP')
        && (entryOp === null || anchor === null)) {
      return {
        documents: [], notes, ignore: false, degrade: true, cause: 'SCRAP_OP_UNKNOWN',
        reason: `scarto sospeso: la configurazione del plant dipende dall'operazione, e `
          + (entryOp === null
            ? `l'operazione della registrazione non è leggibile ('${e.OrderOperation}')`
            : 'l\'operazione di versamento dell\'ordine non è leggibile')
      };
    }

    // E vale anche per il NUMERO PLEX su cui il perimetro si misura. Senza, `scrapPlan` darebbe
    // `consume: false` e — con `GR_OP_ONLY` su un'intermedia — l'esito «nessun movimento configurato»:
    // un messaggio che dice il contrario di quel che e' successo, su una registrazione archiviata come
    // terminale. Il perimetro non e' valutabile, quindi si sospende.
    if (hasJob && cfg.ScrapConsume === 'UP_TO_OP' && plexOp === null && entryOp !== anchor) {
      return {
        // Causa PROPRIA e non `SCRAP_OP_UNKNOWN`: là il dato che manca è sull'ordine SAP, qui sulla
        // registrazione Plex, e sono due posti diversi dove andare a guardare (DEC-56).
        documents: [], notes, ignore: false, degrade: true, cause: 'SCRAP_PLEX_OP_UNKNOWN',
        reason: 'scarto sospeso: il perimetro dei componenti si misura sull\'operazione PLEX della '
          + `registrazione, che non e' leggibile ('${e.OperationNumber}')`
      };
    }

    // E la stessa regola vale per L'ALBERO su cui il perimetro si misura. Un albero non letto o senza
    // nessun componente allocato non e' «questo componente non c'e'»: e' il criterio non valutabile
    // AFFATTO, e ricadere sul default consumerebbe l'intera distinta su uno scarto intermedio — cioe'
    // esattamente cio' che il plant ha chiesto di non fare. Il rimedio e' assegnare i componenti nel
    // ciclo dell'ordine, che e' un'azione dell'operatore: la registrazione riparte da se'.
    if (hasJob && plan.consume && plan.upTo !== null && !allocationUsable(allocation)) {
      return {
        documents: [], notes, ignore: false, degrade: true, cause: 'SCRAP_NO_ALLOCATION',
        reason: `scarto sospeso: il perimetro «fino all'operazione ${plan.upTo}» si misura `
          + `sull'albero Plex dell'ordine, e ${allocationGap(allocation)}`
      };
    }

    if (plan.ignore) {
      return {
        documents: [], notes, ignore: true,
        // Due cause distinte con rimedi diversi: «il plant non registra lo scarto senza lotto» si
        // corregge in configurazione, «nessun movimento configurato a questa operazione» e' la
        // regola che fa il suo lavoro. Non si aggregano sotto lo stesso nome (DEC-56).
        cause: plan.withOrder ? 'SCRAP_NO_MOVEMENT' : 'SCRAP_NO_ORDER_OFF',
        reason: plan.reason
      };
    }

    // Il materiale dello scarto senza ordine viene dal dizionario delle part Plex, e se il dizionario
    // è muto NON si inventa: la registrazione resta da elaborare, perché la part può essere inviata a
    // Plex domani e allora il dizionario la conoscerà.
    const material = plan.withOrder ? '' : String(noOrderMaterial || '').trim();
    if (!plan.withOrder && !material) {
      return {
        documents: [], notes, ignore: false, degrade: true, cause: 'SCRAP_NO_MATERIAL',
        reason: `scarto di pezzo già versato: la part Plex ${e.PlexPartId || '(senza id)'} non è `
          + 'risolvibile in un materiale SAP, nessun movimento'
      };
    }

    const items = [];
    if (plan.product) {
      items.push(scrapItem(e, order, orderId, itemText(e, plan.withOrder ? '' : cfg.ScrapLateTxt), {
        withOrder: plan.withOrder,
        material,
        storageLocation: cfg.ScrapStorLoc,
        reasonCode: cfg.ScrapReason
      }));
    }
    let cons = null;
    if (plan.consume) {
      // La quantità di riferimento è quella SCARTATA: la proporzione è la stessa del prodotto buono,
      // cambia il numeratore. `movement` è l'imputazione scelta dal plant (261 sull'ordine o 551).
      cons = consumptionItems(components, qty, order, orderId, text, {
        upTo: plan.upTo,
        opOf,
        movementType: plan.movement,
        storageLocation: cfg.ScrapStorLoc,
        reasonCode: cfg.ScrapReason
      });
      notes.push(...cons.notes);
      if (!cons.items.length) {
        notes.push(`nessuna riga di consumo per lo scarto (${cons.inScope} componenti nel perimetro `
          + `su ${cons.considered} dell'ordine)`);
      }
      items.push(...cons.items);
    }

    if (!items.length) {
      // [CONF-POSTING] DUE CAUSE, e la differenza è la stessa del ramo del prodotto. Un perimetro
      // vuoto su un albero LEGGIBILE è la risposta: uno scarto alla prima operazione, dove nessun
      // componente è ancora stato consumato, non deve muovere niente — ed è terminale, o si
      // ritenterebbe per sempre. Zero righe per QUALUNQUE altra ragione (TotalQuantity a zero,
      // componenti non leggibili, quote sotto il millesimo) è un dato che manca: si sospende.
      const perimetroVuotoLecito = !!cons && cons.considered > 0 && cons.inScope === 0;
      if (perimetroVuotoLecito) {
        return {
          documents: [], notes, ignore: true, cause: 'SCRAP_NO_COMPONENTS_AT_OP',
          reason: `${plan.reason}, e nessuno dei ${cons.considered} componenti dell'ordine è nel `
            + 'perimetro: nessun movimento'
        };
      }
      return {
        documents: [], notes, ignore: false, degrade: true, cause: 'SCRAP_NO_ITEMS',
        reason: `scarto senza nessuna riga: ${plan.reason}, ma nessun movimento è risultato costruibile`
      };
    }

    return {
      documents: [{
        docSeq: DOC_ISSUE,
        goodsMovementCode: GM_CODE_ISSUE,
        plant: e.Plant || '',
        // Il documento senza ordine non lo cita nemmeno in testata: `manufacturingOrder` alimenta
        // ZProdConfMatDoc, e una colonna valorizzata direbbe che quel movimento è dell'ordine.
        manufacturingOrder: plan.withOrder ? orderId : '',
        header: headerFor(GM_CODE_ISSUE, e, plan.withOrder ? orderId : '', cfg.ScrapHeadTxt),
        items
      }],
      notes,
      ignore: false,
      degrade: false,
      cause: 'OK',
      reason: plan.reason
    };
  }

  // ---- PRODOTTO, CANALE «CONFERMA D'ORDINE» (feature 0030) -------------------------------------
  // Sta PRIMA del canale dei documenti materiale, e non ne attraversa niente: l'ancora e' un'altra
  // (l'ultima operazione dell'albero PLEX, non quella di versamento SAP), il perimetro dei
  // componenti non esiste — li consuma SAP col prelievo retrogrado — e la quantita' e' quella
  // dell'ordine. Riusare il ramo sotto significherebbe far dipendere la conferma da decisioni che
  // riguardano movimenti che qui non partono.
  if (cfg.ProdPosting === 'CONF') {
    const lastPlexOp = allocation && allocation.lastOperationNumber !== undefined
      ? allocation.lastOperationNumber
      : null;
    const verdict = R.confirmScope(cfg, { plexOp, lastPlexOp });
    if (!verdict.confirm) {
      return {
        documents: [],
        notes,
        ignore: verdict.terminal,
        // Una sospensione qui va GUARDATA: l'ordine e' su Plex, quindi il suo albero dovrebbe
        // esistere. Un archivio invece e' l'esito normale di un avanzamento intermedio, e non
        // degrada niente.
        degrade: !verdict.terminal,
        cause: verdict.code,
        reason: verdict.reason
      };
    }
    const qty = num(e.YieldQuantity);
    if (!(qty > 0)) {
      return {
        documents: [], notes, ignore: true, cause: 'YIELD_ZERO',
        reason: 'registrazione a quantità zero: nessuna conferma'
      };
    }
    return {
      documents: [{
        docSeq: DOC_CONFIRM,
        // Non c'e' un codice di movimento merci: la conferma non e' un documento materiale. La
        // colonna resta vuota, e il recap la mostra come tale.
        goodsMovementCode: '',
        plant: e.Plant || '',
        manufacturingOrder: orderId,
        confirmation: confirmationFor(e, order, orderId, qty)
      }],
      notes,
      ignore: false,
      degrade: false,
      cause: 'OK_CONF',
      reason: `${verdict.reason}: quantità ${qty}`
    };
  }

  // ---- PRODOTTO --------------------------------------------------------------------------------
  const fin = isFinalOperation(e.OrderOperation, operations);
  const scope = R.productionScope(cfg, { entryOp, plexOp, anchor });

  // [CONF-POSTING] Con `EACH_OP` senza numero d'operazione Plex il perimetro non e' valutabile, e il
  // guasto sarebbe il peggiore possibile: `scope.consume` resta false e all'operazione di versamento
  // partirebbe il '02' DA SOLO, cioe' un'entrata merci senza l'uscita dei componenti — esattamente
  // cio' che U4 vieta. Si sospende.
  if (cfg.ConsumeAt === 'EACH_OP' && plexOp === null) {
    return {
      documents: [], notes, ignore: false, degrade: true, cause: 'CONSUME_OP_UNKNOWN',
      reason: 'consumo per operazione sospeso: l\'operazione PLEX della registrazione non e\' '
        + `leggibile ('${e.OperationNumber}'), e il perimetro dei componenti si misura su quella`
    };
  }

  // [CONF-POSTING] Stessa regola dello scarto: con `EACH_OP` il perimetro si misura sull'albero Plex,
  // e se quell'albero non e' usabile non si ricade sul default — la' il default consumerebbe l'INTERA
  // distinta a ogni operazione confermata, cioe' N volte. Si sospende e lo si dichiara (DEC-80).
  if (scope.consume && scope.at !== null && !allocationUsable(allocation)) {
    return {
      documents: [], notes, ignore: false, degrade: true, cause: 'CONSUME_NO_ALLOCATION',
      reason: `consumo per operazione sospeso: il perimetro si misura sull'albero Plex dell'ordine, `
        + `e ${allocationGap(allocation)}`
    };
  }

  // Con `ConsumeAt = 'LAST'` — il default, e la lettera della §8.3.3 — fuori dall'operazione di
  // versamento non si muove niente, ed è il comportamento di prima della 0028. Con `EACH_OP` invece
  // ogni operazione consuma i suoi componenti, quindi il ramo si attraversa: l'ancora serve solo a
  // decidere il versamento.
  if (!scope.consume && !scope.receipt) {
    return {
      documents: [],
      notes,
      // Terminale SOLO se sappiamo davvero che non è l'ultima. Se le operazioni non sono
      // leggibili la registrazione NON va archiviata: è un guasto, e il dato può arrivare.
      ignore: fin.last !== null,
      cause: fin.last === null ? 'OPERATIONS_UNREADABLE' : 'NOT_FINAL_OP',
      reason: `nessun movimento: ${fin.final ? scope.reason : fin.reason}`
    };
  }

  const qty = num(e.YieldQuantity);
  if (!(qty > 0)) {
    return {
      documents: [], notes, ignore: true, cause: 'YIELD_ZERO',
      reason: 'registrazione a quantità zero: nessun movimento'
    };
  }

  const cons = scope.consume
    ? consumptionItems(components, qty, order, orderId, text,
      { upTo: scope.upTo, atOp: scope.at, opOf })
    : { items: [], notes: [], considered: 0, inScope: 0, unassigned: 0 };
  notes.push(...cons.notes);

  // [CONF-POSTING] Con `EACH_OP` un'operazione può legittimamente non avere componenti agganciati —
  // un passaggio di sola lavorazione — e allora «zero righe» NON è un dato che manca: è la risposta.
  // La differenza si fa su `inScope`, non sul conteggio delle righe: perimetro vuoto su una distinta
  // leggibile è normale, perimetro pieno che non produce righe no.
  const perimetro = scope.at !== null || scope.upTo !== null;
  const perimetroVuotoLecito = perimetro && cons.inScope === 0 && cons.considered > 0;

  // [MATDOC-FIX] NIENTE VERSAMENTO SENZA CONSUMO, e questo cambia una regola precedente.
  //
  // Prima il '02' partiva comunque, con la motivazione «il prodotto è stato fatto» (0021, RB-12).
  // Ma il risultato in SAP era un'entrata merci del prodotto finito con NESSUNA uscita dei suoi
  // componenti: l'ordine resta sbilanciato, il costo effettivo è quello di un prodotto uscito dal
  // nulla, e il run chiudeva in verde con una nota che non degradava. Zero righe di consumo non è
  // «un ordine senza componenti»: è un dato che manca — TotalQuantity a zero, componenti non
  // leggibili su questo canale, quote tutte sotto il millesimo — e un dato che manca può arrivare.
  //
  // Quindi non si genera nulla, la registrazione resta da elaborare (`ignore: false`) e il run
  // DEGRADA. È la stessa direzione del ramo delle operazioni non leggibili qui sopra: sospendere,
  // non archiviare, e dirlo.
  //
  // [CONF-POSTING] L'ECCEZIONE è `EACH_OP` con perimetro vuoto lecito: là i componenti sono già
  // usciti alle LORO operazioni, quindi un versamento senza righe proprie non è sbilanciato. È
  // l'unico caso in cui questa funzione emette un '02' da solo, e vale solo perché il perimetro è
  // stato valutato su una distinta che si è potuta leggere.
  if (scope.consume && !cons.items.length && !perimetroVuotoLecito) {
    return {
      documents: [],
      notes,
      ignore: false,
      degrade: true,
      cause: 'NO_CONSUMPTION',
      reason: `nessuna riga di consumo per l'ordine ${orderId}: il versamento non parte da solo, `
        + 'perché un\'entrata merci senza uscita dei componenti sbilancia l\'ordine'
    };
  }

  const documents = [];
  if (cons.items.length) {
    documents.push({
      docSeq: DOC_ISSUE,
      goodsMovementCode: GM_CODE_ISSUE,
      plant: e.Plant || '',
      manufacturingOrder: orderId,
      header: headerFor(GM_CODE_ISSUE, e, orderId),
      items: cons.items
    });
  }
  if (scope.receipt) {
    documents.push({
      docSeq: DOC_RECEIPT,
      goodsMovementCode: GM_CODE_RECEIPT,
      plant: e.Plant || '',
      manufacturingOrder: orderId,
      header: headerFor(GM_CODE_RECEIPT, e, orderId),
      items: [receiptItem(e, order, orderId, text)]
    });
  }

  if (!documents.length) {
    // `EACH_OP` su un'operazione senza componenti e senza versamento: la regola dice che qui non
    // succede niente, e lo si dichiara invece di lasciare la registrazione a girare.
    return {
      documents: [], notes, ignore: true, cause: 'OP_WITHOUT_COMPONENTS',
      reason: `${scope.reason}, e questa operazione non ha componenti agganciati `
        + `(${cons.considered} componenti sull'ordine, nessuno nel perimetro)`
    };
  }

  return {
    documents,
    notes,
    ignore: false,
    degrade: false,
    cause: 'OK',
    reason: scope.receipt && cons.items.length
      ? `${scope.reason}: ${cons.items.length} righe di consumo + versamento`
      : `${scope.reason}: ${cons.items.length} righe di consumo`
  };
}

// ---------------------------------------------------------------------------------------------
// CLASSIFICAZIONE DEL FALLIMENTO
// ---------------------------------------------------------------------------------------------

/**
 * L'elenco dei messaggi SAP considerati DEFINITIVI, in forma `ID/NUMBER`.
 *
 * PARTE VUOTO, E NON E' UNA DIMENTICANZA. Un rifiuto applicativo del BAPI può essere permanente
 * («ordine chiuso») o transitorio («giacenza insufficiente», che domani ci sarà): distinguerli
 * richiede i messaggi VERI di questo sistema, e nessuno di quelli che verrebbe da scrivere adesso
 * è stato osservato qui. Un elenco inventato farebbe il danno peggiore dei due — archiviare come
 * permanente un movimento che sarebbe passato al tentativo dopo.
 *
 * Si riempie dal campo, senza rilascio: `MATDOC_PERMANENT_MESSAGES="M7/021,CO/305"`.
 */
const PERMANENT_MESSAGES_DEFAULT = Object.freeze([]);

function readPermanentMessages(env = process.env) {
  const raw = env.MATDOC_PERMANENT_MESSAGES;
  if (!raw || !String(raw).trim()) return new Set(PERMANENT_MESSAGES_DEFAULT);
  return new Set(
    String(raw).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
  );
}

/**
 * Il fallimento è definitivo o si ritenta? FUNZIONE PURA rispetto ai suoi argomenti.
 *
 * DUE SOLE CAUSE DI «PERMANENTE», ed entrambe hanno una ragione che regge da sola:
 *
 * 1. ESITO NON CONCLUSIVO — SAP dichiara riuscito ma non restituisce il numero documento. Qui
 *    ritentare è la cosa PERICOLOSA: se il documento è stato davvero registrato, il secondo
 *    tentativo ne crea un secondo, e un doppio movimento di magazzino non lo riconcilia nessuno.
 *    Si ferma e si chiede a un umano. È lo stesso ragionamento dell'«esito non conclusivo» dello
 *    spacchettamento (0012, FR-42).
 *
 * 2. RIFIUTO APPLICATIVO RICONOSCIUTO — SAP ha risposto, ha detto no, e il messaggio è
 *    nell'elenco dei definitivi. Un messaggio NON riconosciuto resta transitorio: perdere un
 *    movimento in silenzio è peggio di un retry di troppo, e il tetto per plant
 *    (ZPlant.MaxRetryAttempts) limita comunque i tentativi.
 *
 * Tutto il resto — nessuna risposta, 5xx di Cloud Integration, timeout, errore di rete — è
 * transitorio per definizione: il messaggio non è mai arrivato a ECC.
 *
 * @param {object} outcome il record dello scambio di postMaterialDoc
 * @param {Set<string>} [permanent] elenco dei definitivi (default: da ambiente)
 * @returns {{permanent: boolean, failureClass: string, reason: string}}
 */
function classifyFailure(outcome, permanent = null) {
  const r = outcome || {};
  const set = permanent || readPermanentMessages();
  const type = String(r.messageType || '').trim().toUpperCase();
  const id = String(r.messageId || '').trim().toUpperCase();
  const number = String(r.messageNumber || '').trim();

  if (r.inconclusive) {
    return {
      permanent: true,
      failureClass: 'P',
      reason: 'esito NON CONCLUSIVO: SAP dichiara riuscito ma non restituisce il numero documento. '
        + 'Non si ritenta: se il movimento è stato registrato, un secondo tentativo lo duplicherebbe. '
        + 'Verificare in MB51 e sbloccare a mano.'
    };
  }

  const rejected = ['E', 'A', 'X'].includes(type);
  if (rejected && id && number && set.has(`${id}/${number}`)) {
    return {
      permanent: true,
      failureClass: 'P',
      reason: `rifiuto applicativo ${id} ${number} dichiarato definitivo (MATDOC_PERMANENT_MESSAGES)`
    };
  }
  if (rejected) {
    return {
      permanent: false,
      failureClass: 'T',
      reason: `rifiuto applicativo ${id || '(id ignoto)'} ${number || ''}`.trim()
        + ': non è fra i definitivi, si ritenta fino al tetto del plant'
    };
  }
  return {
    permanent: false,
    failureClass: 'T',
    reason: r.httpStatus
      ? `nessuna risposta applicativa (HTTP ${r.httpStatus}): il messaggio non è arrivato a ECC, si ritenta`
      : 'guasto di trasporto: si ritenta'
  };
}

module.exports = {
  GM_CODE_ISSUE,
  GM_CODE_RECEIPT,
  DOC_ISSUE,
  DOC_RECEIPT,
  DOC_CONFIRM,
  LEN_HEADER_TEXT,
  LEN_REFERENCE,
  LEN_ITEM_TEXT,
  LEN_CONF_TEXT,
  flagOn,
  nameList,
  allocationUsable,
  allocationGap,
  NAMED_IN_NOTE,
  opNum,
  lastOperationOf,
  isFinalOperation,
  consumptionItems,
  receiptItem,
  scrapItem,
  headerFor,
  itemText,
  plexStamp,
  confirmationFor,
  buildDocuments,
  PERMANENT_MESSAGES_DEFAULT,
  readPermanentMessages,
  classifyFailure
};

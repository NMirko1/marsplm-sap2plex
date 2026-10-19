/**
 * [CONF-POSTING] Dove si consumano i componenti, e cosa succede a uno scarto (feature 0028).
 *
 * FUNZIONI PURE: nessun `cds`, nessuna rete, nessun orologio. La lettura del customizing sta in
 * confPostingConfig.js, l'applicazione in confMatDoc.js; qui ci sono le regole, ed e' cio' che le
 * rende collaudabili a secco (test/confPostingRules.test.js).
 *
 * COSA CHIEDE LA BBP, che e' il punto di partenza e non un'interpretazione:
 *
 *   §8.3.3  «Solo l'avanzamento relativo all'ultima operazione produttiva genera: il versamento del
 *            prodotto finito o del semilavorato in SAP; il consumo automatico dei componenti».
 *   §8.4.1  «Scarto su operazione intermedia: non genera versamento del WIP; genera il CONSUMO dei
 *            componenti fino all'operazione di scarto. Scarto sull'ultima operazione: genera il
 *            versamento del prodotto; genera il movimento di scarto in SAP; comporta il consumo
 *            completo della BOM».
 *   §8.5.2  «Il WIP intermedio non viene versato in SAP».
 *
 * La BBP dice CONSUMO, non scarto: in SAP sono due imputazioni diverse — il 261 lascia il costo
 * sull'ordine come scostamento, il 551 lo porta fuori. Entrambe sono possibili e si scelgono per
 * plant (`ScrapMove`), ma il default e' quello della lettera della BBP.
 *
 * TUTTO NASCE SPENTO, E IL DEFAULT E' IL COMPORTAMENTO DI PRIMA DELLA 0028, byte per byte. E' cio'
 * che permette a questa feature di uscire vicino al go-live: un deploy senza configurazione non
 * cambia niente, e il collaudo lo verifica confrontando l'output con e senza il parametro.
 * `normalizeConfig(null)` e riga assente sono la stessa cosa — ramo fail-open di DEC-53, perche' il
 * default pericoloso (registrare documenti veri) e' gia' chiuso un livello sopra da
 * ZPlant.MatDocPostEnabled, che nasce false.
 *
 * MA UNA MODALITA' CONFIGURATA A CUI MANCA IL SUO DATO NON RICADE SUL DEFAULT: la registrazione
 * resta da elaborare e il motivo si scrive (DEC-80, «non lo so» non diventa «no»).
 *
 * DOVE STA UN COMPONENTE LO DICE L'ALBERO PLEX DELL'ORDINE, non la prenotazione SAP. `UP_TO_OP` e
 * `EACH_OP` filtrano sull'allocazione salvata (`ZPlexCycleComponent` -> `ZPlexCycleOperation`, letta
 * da srv/lib/plexCycleAllocation.js), e il numero d'operazione della registrazione con cui si
 * confronta e' quello PLEX (`ZProdConfPlexEntry.OperationNumber`).
 *
 * La 0028 aveva scelto l'asse SAP (`A_ProductionOrderComponent_2.ManufacturingOrderOperation`) con
 * un argomento che resta vero — il 261 chiude una PRENOTAZIONE SAP — ma che non decide questa
 * domanda: la prenotazione si chiude con `Reservation` / `ReservationItem`, che viaggiano comunque
 * sulla riga. L'asse decide QUALI componenti entrano, non la correttezza dell'imputazione. E su
 * quell'asse la distinzione fra scarto intermedio e scarto di fine linea SI PERDEVA IN SILENZIO,
 * perche' la BBP §7.5.2 dice che «attualmente in SAP i componenti sono tutti allocati alla prima
 * operazione»: «dall'operazione 30 alla prima» vuol dire TUTTI, sempre. Sull'albero Plex la
 * distinzione c'e', perche' ogni componente e' stato appeso a un'operazione — a mano col
 * trascinamento, o dall'auto-assegnazione.
 *
 * DALLA 0030 QUESTE REGOLE DECIDONO ANCHE CHI PORTA IN SAP LA PRODUZIONE. Con `ProdPosting='CONF'`
 * la registrazione diventa una CONFERMA D'ORDINE e i movimenti li fa SAP: i due documenti della
 * produzione non partono piu', lo SCARTO resta un documento materiale con le regole di sopra, e
 * `ConsumeAt` cambia domanda — dice DOVE confermare, non dove consumare. L'ancora della conferma e'
 * l'ULTIMA operazione dell'albero Plex dell'ordine (`confirmScope`), che non e' l'ancora di
 * versamento SAP di `productionScope`: sono due numerazioni diverse e tenerle separate e' il punto.
 *
 * Collaudo: node test/confPostingRules.test.js · Perimetro: grep -rn "CONF-POSTING"
 */

'use strict';

// ---------------------------------------------------------------------------------------------
// I VALORI AMMESSI
// Elenchi in un posto solo: li usano la normalizzazione, la validazione e la tendina della scheda.
// ---------------------------------------------------------------------------------------------

/**
 * Chi porta in SAP la PRODUZIONE (feature 0030).
 *
 * MATDOC = i nostri due documenti materiale (261 + 101). CONF = una conferma d'ordine, e i movimenti
 * li fa SAP. Lo SCARTO resta un documento materiale in entrambi i casi.
 */
const PROD_POSTING = Object.freeze(['MATDOC', 'CONF']);

/** Quando si consumano i componenti del prodotto BUONO. */
const CONSUME_AT = Object.freeze(['LAST', 'EACH_OP']);

/** Cosa succede ai componenti quando un pezzo viene scartato. */
const SCRAP_CONSUME = Object.freeze(['NONE', 'UP_TO_OP', 'ALL']);

/** Con quale imputazione contabile escono quei componenti. */
const SCRAP_MOVE = Object.freeze(['ISSUE', 'SCRAP']);

/** Se e dove parte il movimento del PRODOTTO scartato. */
const SCRAP_ISSUE = Object.freeze(['ALWAYS', 'GR_OP_ONLY']);

/** Lo scarto di un pezzo gia' versato, che si riconosce dal lotto assente. */
const SCRAP_NO_ORDER = Object.freeze(['OFF', 'POST']);

/**
 * La configurazione che riproduce il comportamento di prima della 0028 — e, per i due campi della
 * 0030, di prima della 0030: `MATDOC` e interruttore spento.
 */
const DEFAULTS = Object.freeze({
  ProdPosting: 'MATDOC',
  ConfPostEnabled: false,
  ConsumeAt: 'LAST',
  ScrapConsume: 'NONE',
  ScrapMove: 'ISSUE',
  ScrapIssue: 'ALWAYS',
  ScrapNoOrder: 'OFF',
  ScrapStorLoc: '',
  ScrapReason: '',
  ScrapHeadTxt: '',
  ScrapLateTxt: ''
});

/** Lunghezze delle colonne di testo, per il taglio in normalizzazione. */
const WIDTH = Object.freeze({
  ScrapStorLoc: 4, ScrapReason: 4, ScrapHeadTxt: 25, ScrapLateTxt: 50
});

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Un valore d'elenco in forma canonica, oppure `null` se non e' dell'elenco. FUNZIONE PURA.
 *
 * Tollerante su spazi e maiuscole perche' il valore lo digita una persona o arriva da una PATCH
 * OData scritta a mano — e' il ramo di DEC-51 «fra un valore digitato e un valore interno».
 */
function pickMode(value, allowed) {
  const v = str(value).toUpperCase();
  return allowed.includes(v) ? v : null;
}

/**
 * La causale in forma SAP: NUMC(4), zeri davanti. FUNZIONE PURA.
 *
 * Si normalizza in scrittura perche' cio' che si memorizza, cio' che si mostra e cio' che si manda
 * devono essere lo stesso valore — stessa regola di `parseOpTypes` per gli elenchi di tipo. Chi
 * digita `13` intende `0013`, e `sapPostEncoding` riempirebbe comunque: farlo qui rende visibile a
 * schermo quello che parte.
 *
 * @returns {string} `''` se non ci sono cifre; altrimenti quattro cifre
 */
function normalizeReason(value) {
  const digits = str(value).replace(/\D/g, '');
  if (!digits) return '';
  return digits.slice(-WIDTH.ScrapReason).padStart(WIDTH.ScrapReason, '0');
}

/**
 * Un flag di abilitazione letto dal database. FUNZIONE PURA.
 *
 * Le tre forme sono quelle che il progetto ha gia' incontrato sullo stesso tipo di interruttore
 * (`ZProdOrderTecoConfig.IsEnabled`, srv/lib/prodOrderTeco.js): HANA restituisce un booleano, SQLite
 * puo' dare `1`, una PATCH scritta a mano manda la stringa. Tutto il resto — `null`, colonna appena
 * aggiunta e non retro-riempita, valore inatteso — e' SPENTO: e' la lettura sicura di un
 * interruttore che autorizza una scrittura contabile.
 */
function pickFlag(value) {
  return value === true || value === 1 || value === 'true';
}

/**
 * La riga di customizing in forma canonica. FUNZIONE PURA e IDEMPOTENTE.
 *
 * L'idempotenza non e' un vezzo: l'orchestrazione normalizza una volta e le funzioni pure
 * normalizzano ancora, quindi un output non riammissibile in ingresso azzererebbe la configurazione
 * in silenzio. E' la lezione di `activeRules` in DEC-74.
 *
 * `null` e riga assente danno i DEFAULTS: sono la stessa cosa.
 *
 * @param {object|null|undefined} row riga di ZProdConfPostingConfig
 * @returns {object} la configurazione canonica, sempre completa
 */
function normalizeConfig(row) {
  const r = row || {};
  return {
    ProdPosting: pickMode(r.ProdPosting, PROD_POSTING) || DEFAULTS.ProdPosting,
    ConfPostEnabled: pickFlag(r.ConfPostEnabled),
    ConsumeAt: pickMode(r.ConsumeAt, CONSUME_AT) || DEFAULTS.ConsumeAt,
    ScrapConsume: pickMode(r.ScrapConsume, SCRAP_CONSUME) || DEFAULTS.ScrapConsume,
    ScrapMove: pickMode(r.ScrapMove, SCRAP_MOVE) || DEFAULTS.ScrapMove,
    ScrapIssue: pickMode(r.ScrapIssue, SCRAP_ISSUE) || DEFAULTS.ScrapIssue,
    ScrapNoOrder: pickMode(r.ScrapNoOrder, SCRAP_NO_ORDER) || DEFAULTS.ScrapNoOrder,
    // Il magazzino e' una chiave SAP: maiuscolo, senza spazi, tagliato alla colonna.
    ScrapStorLoc: str(r.ScrapStorLoc).toUpperCase().slice(0, WIDTH.ScrapStorLoc),
    ScrapReason: normalizeReason(r.ScrapReason),
    // I due testi sono testo: si tagliano e basta, la grafia e' di chi scrive.
    ScrapHeadTxt: str(r.ScrapHeadTxt).slice(0, WIDTH.ScrapHeadTxt),
    ScrapLateTxt: str(r.ScrapLateTxt).slice(0, WIDTH.ScrapLateTxt)
  };
}

/** Vero se la configurazione e' identica al comportamento di prima della 0028. */
function isDefault(config) {
  const c = normalizeConfig(config);
  return Object.keys(DEFAULTS).every((k) => c[k] === DEFAULTS[k]);
}

// ---------------------------------------------------------------------------------------------
// LA VALIDAZIONE IN SCRITTURA
// ---------------------------------------------------------------------------------------------

/**
 * La riga e' ammissibile? FUNZIONE PURA.
 *
 * Il `code` restituito **e'** la chiave i18n, come in `orderCompExclRules.validateRule`: cosi'
 * l'elenco dei valori ammessi e i messaggi restano in un posto solo, quello che il runtime usa.
 *
 * @param {object} row la riga RISULTANTE (su PATCH va ricomposta con l'esistente dal chiamante)
 * @returns {{ok: boolean, code?: string, field?: string, param?: string}}
 */
function validateConfig(row) {
  const r = row || {};

  for (const [field, allowed] of [
    ['ProdPosting', PROD_POSTING],
    ['ConsumeAt', CONSUME_AT], ['ScrapConsume', SCRAP_CONSUME], ['ScrapMove', SCRAP_MOVE],
    ['ScrapIssue', SCRAP_ISSUE], ['ScrapNoOrder', SCRAP_NO_ORDER]
  ]) {
    // Un campo assente su una PATCH parziale non e' un errore: il chiamante ha ricomposto la riga,
    // e se manca davvero il default lo copre.
    if (r[field] === undefined || r[field] === null || str(r[field]) === '') continue;
    if (!pickMode(r[field], allowed)) {
      return { ok: false, code: 'cpcModeInvalid', field, param: allowed.join(', ') };
    }
  }

  const c = normalizeConfig(r);

  // [CONF-POSTING] `EACH_OP` NON E' ESPRIMIBILE CON LA CONFERMA. Con `CONF` questo campo dice DOVE
  // confermare, non dove consumare: `EACH_OP` significherebbe una conferma a ogni operazione, e la
  // conferma che mandiamo e' FINALE (`IsFinalConfirmation`) sulla TESTATA dell'ordine — N conferme
  // finali sullo stesso ordine sono N volte la quantita' confermata, non un avanzamento per
  // operazione. Si rifiuta invece di degradare a `LAST` in silenzio: una configurazione che fa una
  // cosa diversa da quella scritta e' peggio di un rifiuto.
  if (c.ProdPosting === 'CONF' && c.ConsumeAt === 'EACH_OP') {
    return { ok: false, code: 'cpcEachOpNotWithConf', field: 'ConsumeAt' };
  }

  // Un interruttore che autorizza una scrittura che non avviene e' customizing inerte (DEC-27), e
  // qui e' peggio: chi lo accende crede di aver acceso le conferme.
  if (c.ConfPostEnabled && c.ProdPosting !== 'CONF') {
    return { ok: false, code: 'cpcConfEnabledWithoutConf', field: 'ConfPostEnabled' };
  }

  // LA COMBINAZIONE CHE ADDEBITA DUE VOLTE, e vale SOLO sul canale dei documenti materiale. Con
  // `EACH_OP` ogni operazione confermata consuma i suoi componenti mentre il pezzo avanza: un pezzo
  // scartato ha GIA' consumato quello che ha percorso, e aggiungere la sua quota lo addebiterebbe una
  // seconda volta. Le due combinazioni coerenti sono `LAST` + consumo sullo scarto, oppure `EACH_OP`
  // + nessun consumo sullo scarto.
  //
  // [CONF-POSTING] CON `CONF` IL RAGIONAMENTO NON SI APPLICA, ed e' il motivo per cui la condizione
  // e' ristretta a `MATDOC` invece di restare com'era: la' i componenti li consuma SAP col prelievo
  // retrogrado, in proporzione alla quantita' CONFERMATA — e un pezzo scartato non e' nella
  // quantita' confermata, quindi i suoi componenti non sono ancora usciti. Consumarli sullo scarto e'
  // il primo addebito, non il secondo. (La combinazione `CONF` + `EACH_OP` e' comunque rifiutata
  // sopra: la restrizione qui non e' un buco, e' la ragione scritta.)
  if (c.ProdPosting === 'MATDOC' && c.ConsumeAt === 'EACH_OP' && c.ScrapConsume !== 'NONE') {
    return { ok: false, code: 'cpcDoubleCharge', field: 'ScrapConsume' };
  }

  // Senza testata d'ordine il magazzino non e' derivabile da nessuna parte.
  if (c.ScrapNoOrder === 'POST' && !c.ScrapStorLoc) {
    return { ok: false, code: 'cpcStorLocRequired', field: 'ScrapStorLoc' };
  }

  // Un testo che non verra' mai usato e' un customizing che si salva e non fa niente (DEC-27).
  if (c.ScrapLateTxt && c.ScrapNoOrder === 'OFF') {
    return { ok: false, code: 'cpcLateTxtUnused', field: 'ScrapLateTxt' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// LE DECISIONI, che confMatDoc applica
// ---------------------------------------------------------------------------------------------

/**
 * Il perimetro dei componenti da consumare per una PRODUCTION entry. FUNZIONE PURA.
 *
 * I DUE ASSI DEL PERIMETRO NON SONO LO STESSO ASSE, e confonderli addebita due volte. `EACH_OP`
 * consuma i componenti di QUELLA operazione (`at`), non quelli fino a quella (`upTo`): con `upTo`
 * l'operazione 20 riconsumerebbe i componenti dell'operazione 10, che l'operazione 10 aveva gia'
 * consumato. `upTo` e' l'asse dello SCARTO, dove il pezzo perso si porta dietro tutto quello che ha
 * percorso e la registrazione avviene una volta sola. I due assi vivono entrambi sull'ALBERO PLEX
 * (vedi la testata): quello che cambia fra loro e' il confronto, non la sorgente.
 *
 * DUE NUMERI D'OPERAZIONE, E NON SONO INTERCAMBIABILI. `entryOp` e `anchor` sono numeri SAP e
 * rispondono a «questa e' l'operazione di versamento?»; `plexOp` e' il numero dell'operazione PLEX
 * della registrazione e risponde a «quali componenti sono a questa operazione?». Tenerli separati e'
 * l'unico modo di non far dipendere il perimetro dal fatto che le due numerazioni coincidano.
 *
 * @param {object} config configurazione canonica
 * @param {object} ctx
 * @param {number|null} ctx.entryOp operazione SAP della registrazione
 * @param {number|null} ctx.plexOp operazione PLEX della registrazione (l'asse dei componenti)
 * @param {number|null} ctx.anchor operazione SAP di versamento dell'ordine
 * @returns {{consume: boolean, at: number|null, upTo: number|null, receipt: boolean, reason: string}}
 *   `at` e `upTo` entrambi `null` con `consume: true` significa «tutta la distinta».
 *   `receipt` dice se parte il versamento del prodotto: solo all'ancora, sempre.
 */
function productionScope(config, { entryOp = null, plexOp = null, anchor = null } = {}) {
  const c = normalizeConfig(config);
  const atAnchor = entryOp !== null && anchor !== null && entryOp === anchor;

  if (c.ConsumeAt === 'EACH_OP') {
    // Ogni operazione consuma i SUOI componenti — l'asse ESATTO, vedi sopra. Il versamento resta
    // solo all'ancora: un prodotto si versa una volta, e §8.5.2 vieta di versare il WIP intermedio.
    return {
      consume: plexOp !== null,
      at: plexOp,
      upTo: null,
      receipt: atAnchor,
      reason: atAnchor
        ? `operazione Plex ${plexOp}: componenti di questa operazione + versamento`
        : `operazione Plex ${plexOp}: solo i componenti di questa operazione, nessun versamento`
    };
  }

  // LAST: e' il comportamento di prima della 0028 e la lettera della §8.3.3.
  return {
    consume: atAnchor,
    at: null,
    upTo: null,
    receipt: atAnchor,
    reason: atAnchor
      ? 'operazione di versamento: intera distinta + versamento'
      : `operazione ${entryOp} non e' quella di versamento: nessun movimento`
  };
}

/**
 * [CONF-POSTING] Questa registrazione di produzione diventa una CONFERMA? FUNZIONE PURA (0030).
 *
 * L'ANCORA E' L'ULTIMA OPERAZIONE DELL'ALBERO PLEX DELL'ORDINE, non quella di SAP. E' l'albero che
 * il progetto usa per attivare e disattivare le operazioni del job su Plex (`ZPlexCycleOperation`),
 * quindi e' l'unico insieme in cui «l'ultima» ha lo stesso significato per noi e per la fabbrica: il
 * numero che l'API Plex restituisce sulla registrazione appartiene a QUELLA numerazione. L'ancora
 * SAP (`productionScope`) risponde a un'altra domanda — dove SAP versa — e non e' intercambiabile.
 *
 * TRE ESITI, e la differenza fra gli ultimi due e' la sola cosa che conta qui:
 *
 *   i due numeri combaciano          -> si conferma
 *   NON combaciano                   -> niente, e la registrazione si ARCHIVIA (terminale): il
 *                                       pezzo e' avanzato su un'operazione intermedia, ed e' un
 *                                       fatto definitivo. Il messaggio cita ENTRAMBI i numeri,
 *                                       perche' un archivio sbagliato si vede solo cosi'
 *   l'ancora NON SI SA              -> si SOSPENDE, non si archivia (DEC-80). La semina del ciclo
 *                                       fa DELETE e INSERT in due momenti: esiste una finestra in
 *                                       cui l'albero dell'ordine e' vuoto, e archiviare la'
 *                                       perderebbe la conferma per sempre
 *
 * @param {object} config configurazione canonica
 * @param {object} ctx
 * @param {number|null} ctx.plexOp numero d'operazione PLEX della registrazione
 * @param {number|null} ctx.lastPlexOp ultima operazione dell'albero Plex dell'ordine (`null` = non
 *   letta, o albero senza operazioni: sono la stessa cosa per questa decisione, e chi legge
 *   dichiara quale delle due era)
 * @returns {{confirm: boolean, terminal: boolean, code: string, reason: string}}
 *   `code` e' il nome dell'esito, e serve al recap: ogni causa ha il suo nome, o le tre sospensioni
 *   diventano indistinguibili in una riga sola (DEC-56).
 */
function confirmScope(config, { plexOp = null, lastPlexOp = null } = {}) {
  const c = normalizeConfig(config);

  if (c.ProdPosting !== 'CONF') {
    return {
      confirm: false, terminal: false, code: 'CONF_CHANNEL_MATDOC',
      reason: 'canale MATDOC: la produzione resta un documento materiale'
    };
  }
  // `EACH_OP` e' rifiutato in scrittura. Se comparisse comunque — riga scritta a mano, o una
  // convalida aggirata — non si degrada a `LAST`: si sospende, perche' e' un errore di
  // configurazione da correggere, non una decisione su questa registrazione.
  if (c.ConsumeAt !== 'LAST') {
    return {
      confirm: false, terminal: false, code: 'CONF_CONFIG_INVALID',
      reason: `configurazione non ammessa: ConsumeAt=${c.ConsumeAt} con ProdPosting=CONF. `
        + 'La conferma e\' finale sulla testata dell\'ordine e si manda una volta sola'
    };
  }
  if (lastPlexOp === null || lastPlexOp === undefined) {
    return {
      confirm: false, terminal: false, code: 'CONF_ANCHOR_UNKNOWN',
      reason: 'ultima operazione del ciclo Plex dell\'ordine non nota: conferma sospesa, si riprova '
        + 'al prossimo run'
    };
  }
  if (plexOp === null || plexOp === undefined) {
    // Quasi irraggiungibile: senza numero d'operazione il ponte di DEC-88 mette la registrazione in
    // quarantena molto prima. Resta qui perche' «non lo so» non deve poter diventare «no».
    return {
      confirm: false, terminal: false, code: 'CONF_ENTRY_OP_UNKNOWN',
      reason: `operazione della registrazione non nota (ultima operazione del ciclo: ${lastPlexOp}): `
        + 'conferma sospesa'
    };
  }
  if (plexOp !== lastPlexOp) {
    return {
      confirm: false, terminal: true, code: 'CONF_NOT_LAST_OP',
      reason: `operazione Plex ${plexOp}: non e' l'ultima del ciclo dell'ordine (${lastPlexOp}), `
        + 'nessuna conferma'
    };
  }
  return {
    confirm: true, terminal: false, code: 'CONF_OK',
    reason: `operazione Plex ${plexOp}: e' l'ultima del ciclo dell'ordine, conferma d'ordine`
  };
}

/** [CONF-OP-BRIDGE] Le cause del ponte che riguardano il COLLEGAMENTO e non l'identita' dell'operazione. */
const LINK_ONLY_CAUSES = Object.freeze(['NO_SAP_LINK', 'AMBIGUOUS']);

/**
 * [CONF-OP-BRIDGE] Un collegamento all'operazione SAP che manca FERMA la registrazione?
 * FUNZIONE PURA.
 *
 * PERCHE' NON SEMPRE. Il ponte `numero d'operazione Plex -> SAPOperationId` esiste per il canale dei
 * DOCUMENTI MATERIALE: la' l'operazione SAP e' un dato del movimento. Con `ProdPosting='CONF'` la
 * produzione diventa **una conferma di TESTATA**, e una conferma di testata non porta l'operazione:
 * `Sequence` e `OrderOperation` partono VUOTI (0030 §2, e il corpo registrato nei log lo mostra).
 * L'operazione Plex serve ancora, ma per un'altra domanda — «e' l'ULTIMA del ciclo Plex?», che
 * `confirmScope` decide confrontando NUMERI e senza mai guardare `SAPOperationId`. Pretendere il
 * collegamento in quel caso ferma un flusso contabile per un dato che non verra' mandato.
 *
 * Il 09/09/2026 e' costato due registrazioni in quarantena sull'ordine 5500069342: le righe di ciclo
 * c'erano, il loro `SAPOperationId` era vuoto, e nessuna delle due sarebbe mai ripartita.
 *
 * QUATTRO CONFINI, e sono la ragione per cui questa e' una funzione e non un `if`:
 *
 *   1. E' IL COLLEGAMENTO CHE NON SERVE, NON L'IDENTITA' DELL'OPERAZIONE. `NO_SAP_LINK` e
 *      `AMBIGUOUS` dicono «il collegamento non e' utilizzabile» e sono esenti. `NOT_MAPPED` e
 *      `NO_NUMBER` dicono «non so quale operazione e'» e NON lo sono: l'ancora si confronta con il
 *      ciclo dell'ordine, e senza un numero che appartenga a quel ciclo la conferma sarebbe decisa
 *      su un dato di cui non ci si puo' fidare.
 *   2. L'ESENZIONE E' DELLA PRODUZIONE, NON DEL PLANT. Su un plant a `CONF` lo SCARTO resta un
 *      documento materiale — la conferma non sa esprimerlo senza registrarlo sopra al nostro
 *      (DEC-94) — quindi per lui il collegamento serve come prima: il gate e' `sourceType === 'P'`.
 *   3. CANALE NON LEGGIBILE = NESSUNA ESENZIONE. Senza la configurazione non si sa se il
 *      collegamento serva, e il default (`MATDOC`) e' proprio quello che lo pretende: si tiene il
 *      comportamento di prima. E' la regola di DEC-90/91 — «una modalita' configurata a cui manca il
 *      suo dato non ricade sul default» — e lo stesso ramo che il gate d'invio ha gia'.
 *   4. `configReadOk` NASCE `false` sul chiamante che non lo passa: un innesco nuovo che dimenticasse
 *      il canale si comporta come oggi, non come se fosse a `CONF`.
 *
 * @param {object} ctx
 * @param {string} ctx.cause la `cause` del ponte: `OK` · `NO_NUMBER` · `NOT_MAPPED` · `AMBIGUOUS` ·
 *   `NO_SAP_LINK`
 * @param {string} ctx.sourceType `'P'` produzione · `'S'` scarto · `'A'` rettifica
 * @param {string} ctx.prodPosting il canale del plant (`'MATDOC'` | `'CONF'`)
 * @param {boolean} ctx.configReadOk la configurazione del plant e' stata letta
 * @returns {boolean} `true` = la registrazione va in quarantena, come prima
 */
function sapLinkFatal({ cause = '', sourceType = '', prodPosting = '', configReadOk = false } = {}) {
  const c = String(cause == null ? '' : cause).trim().toUpperCase();
  // Nessun collegamento mancante: non c'e' niente da decidere.
  if (c === 'OK') return false;
  if (!configReadOk) return true;                                          // confine 3
  if (String(prodPosting == null ? '' : prodPosting).trim().toUpperCase() !== 'CONF') return true;
  if (String(sourceType == null ? '' : sourceType).trim().toUpperCase() !== 'P') return true;  // confine 2
  return !LINK_ONLY_CAUSES.includes(c);                                    // confine 1
}

/**
 * [CONF-OUTCOME] La quantita' confermata come pezzo di MESSAGGIO: numero e unita' in UN parametro.
 * FUNZIONE PURA.
 *
 * PERCHE' UN PARAMETRO E NON DUE. `ConfirmationUnit` puo' essere VUOTA di proposito — quando non
 * sappiamo l'unita' la deriva SAP dall'ordine (vedi `confirmationFor`) — e con due segnaposto
 * adiacenti nel testo la frase renderebbe `1 ` con lo spazio orfano: una chiave che promette un
 * pezzo e riceve il vuoto, cioe' l'errore dell'addendum del 07/09/2026 alla DEC-124. Componendo qui
 * il chiamante ha una stringa sola, e sul vuoto puo' scegliere un'ALTRA chiave invece di mandare un
 * parametro vuoto.
 *
 * IL SEPARATORE DECIMALE RESTA IL PUNTO, e non e' una dimenticanza: il parametro viene congelato in
 * `MessageJson` alla SCRITTURA, mentre la frase si rende alla LETTURA nella lingua di chi guarda
 * (DEC-92). Una virgola metterebbe la lingua di chi ha inviato dentro il dato — «un parametro e' un
 * dato e non si traduce».
 *
 * TERZA VOLTA CHE QUESTA REGOLA COMPARE, e va detto perche' il prossimo lettore possa unificarle
 * sapendo dove sono: `fmt` in srv/lib/orderQtySync.js e `p` in srv/lib/plexJobSplit.js arrotondano
 * allo stesso modo. Qui non si riusa nessuna delle due perche' entrambe sono locali al loro modulo e
 * nessuna compone l'unita'.
 *
 * @param {number|string|null} qty quantita' confermata (in `RequestJson` e' un NUMERO: quel payload
 *   e' in forma naturale, la codifica in letterali XSD la fa il modulo d'invio a valle)
 * @param {string} [unit] unita' di misura SAP, eventualmente vuota
 * @returns {string} `'1 ST'` · `'12.5'` · `''` se la quantita' non e' un numero
 */
function confQtyText(qty, unit) {
  const n = Number(qty);
  // `null`/`''`/non numerico -> nessuna quantita' da dichiarare. Lo ZERO invece e' un dato: una
  // conferma a zero pezzi e' un'informazione, non un'assenza.
  if (qty === null || qty === undefined || String(qty).trim() === '' || !Number.isFinite(n)) return '';
  const num = String(Math.round(n * 1000) / 1000);
  const u = String(unit == null ? '' : unit).trim();
  return u ? `${num} ${u}` : num;
}

/**
 * Cosa diventa uno SCARTO. FUNZIONE PURA.
 *
 * LA REGOLA DICHIARATA DAL CLIENTE, che `UP_TO_OP` + `GR_OP_ONLY` + `ISSUE` riproduce:
 *
 *   scarto all'ULTIMA operazione   -> 551 del materiale di TESTATA + 261 sull'INTERA distinta
 *   scarto su operazione INTERMEDIA -> nessun 551, e 261 sui componenti dall'operazione Plex
 *                                      presente ALLA PRIMA
 *
 * `UP_TO_OP` ha quindi DUE BRACCIA, e non e' una scorciatoia: all'operazione di versamento il
 * perimetro e' l'intera distinta, sulle intermedie e' «fino a questa operazione». La differenza fra
 * le due formulazioni non e' teorica — «fino all'ultima operazione» esclude i componenti agganciati a
 * operazioni numerate SOPRA l'ancora, che esistono quando il ciclo ha operazioni non rilasciate o
 * cancellate piu' in alto. `ALL` resta distinto: intera distinta SEMPRE, anche sull'intermedia.
 *
 * @param {object} config configurazione canonica
 * @param {object} ctx
 * @param {boolean} ctx.hasJob la registrazione ha un lotto Plex (quindi un ordine SAP)
 * @param {number|null} ctx.entryOp operazione SAP della registrazione (decide SE il prodotto si muove)
 * @param {number|null} ctx.plexOp operazione PLEX della registrazione (decide il perimetro componenti)
 * @param {number|null} ctx.anchor operazione SAP di versamento
 * @returns {{product: boolean, consume: boolean, upTo: number|null, movement: string,
 *            withOrder: boolean, ignore: boolean, reason: string}}
 *   `movement` e' il tipo movimento dei COMPONENTI: `'261'` o `'551'`.
 *   `withOrder: false` = il movimento del prodotto NON porta il riferimento all'ordine.
 */
function scrapPlan(config, { hasJob, entryOp = null, plexOp = null, anchor = null } = {}) {
  const c = normalizeConfig(config);
  const movement = c.ScrapMove === 'SCRAP' ? '551' : '261';

  // ---- lo scarto di un pezzo GIA' VERSATO: si riconosce dal lotto assente ----------------
  if (!hasJob) {
    if (c.ScrapNoOrder === 'OFF') {
      return {
        product: false, consume: false, upTo: null, movement, withOrder: false, ignore: true,
        reason: 'scarto senza lotto di produzione (pezzo gia\' versato): non registrato, '
          + 'ScrapNoOrder non e\' abilitato su questo plant'
      };
    }
    // I componenti sono gia' stati addebitati dal versamento: si scarica solo il prodotto, e SENZA
    // riferimento all'ordine — che potrebbe essere chiuso, e che il job PROD_TECO chiude.
    return {
      product: true, consume: false, upTo: null, movement, withOrder: false, ignore: false,
      reason: 'scarto di pezzo gia\' versato: solo il prodotto, senza riferimento all\'ordine'
    };
  }

  const atAnchor = entryOp !== null && anchor !== null && entryOp === anchor;

  // ---- il movimento del PRODOTTO ---------------------------------------------------------
  // `GR_OP_ONLY` e' il ramo che §8.5.2 impone: sulle operazioni intermedie il WIP in SAP non e' mai
  // entrato, quindi non c'e' giacenza da scaricare — e oggi quel 551 o viene rifiutato o preleva
  // pezzi buoni di altri ordini.
  const product = c.ScrapIssue === 'ALWAYS' ? true : atAnchor;

  // ---- i COMPONENTI ---------------------------------------------------------------------
  // Il perimetro si misura sull'operazione PLEX, non su quella SAP: e' l'albero Plex che dice dove
  // sta un componente (vedi la testata del modulo).
  let consume = false;
  let upTo = null;
  if (c.ScrapConsume === 'ALL') {
    consume = true;
  } else if (c.ScrapConsume === 'UP_TO_OP') {
    if (atAnchor) {
      // Braccio «ultima operazione»: INTERA distinta. E' la lettera della regola dichiarata, e non
      // coincide con «fino all'ultima operazione» — vedi il docblock.
      consume = true;
      upTo = null;
    } else {
      consume = plexOp !== null;
      upTo = plexOp;
    }
  }

  if (!product && !consume) {
    return {
      product: false, consume: false, upTo: null, movement, withOrder: true, ignore: true,
      reason: `scarto all'operazione ${entryOp}: nessun movimento configurato `
        + '(ScrapIssue=GR_OP_ONLY e ScrapConsume=NONE)'
    };
  }

  const parti = [];
  if (product) parti.push('prodotto');
  if (consume) {
    parti.push(upTo === null ? 'intera distinta' : `componenti fino all'operazione Plex ${upTo}`);
  }
  return {
    product, consume, upTo, movement, withOrder: true, ignore: false,
    reason: `scarto all'operazione ${entryOp}: ${parti.join(' + ')}`
  };
}

/**
 * Un componente rientra nel perimetro «fino all'operazione N»? FUNZIONE PURA.
 *
 * E' l'asse dello SCARTO: il pezzo perso si porta dietro tutto quello che ha percorso.
 *
 * @param {number|null} compOp operazione dell'ALBERO PLEX a cui il componente e' appeso (`null` se
 *   quel componente non e' nell'albero: vedi la regola qui sotto)
 * @param {number|null} upTo `null` = tutta la distinta
 * @returns {boolean}
 */
function componentInScope(compOp, upTo) {
  if (upTo === null || upTo === undefined) return true;
  // Un componente senza operazione leggibile NON si esclude: escluderlo restringerebbe il consumo
  // su un dato che manca, e la direzione giusta e' quella di DEC-56 — il criterio non valutabile non
  // sottrae. Il fatto si dichiara a monte.
  if (compOp === null || compOp === undefined) return true;
  return compOp <= upTo;
}

/**
 * Un componente e' appeso PROPRIO a questa operazione dell'albero Plex? FUNZIONE PURA.
 *
 * E' l'asse di `EACH_OP`, e la regola sul dato mancante e' L'OPPOSTA di `componentInScope`: un
 * componente senza operazione leggibile si ESCLUDE. Non e' un'incoerenza, e' la stessa domanda
 * («cosa fa il criterio non valutabile?») su due assi con conseguenze diverse: sull'asse «fino a» la
 * registrazione avviene UNA volta, quindi includerlo costa al massimo un consumo in eccesso limitato
 * dalla distinta; sull'asse esatto la registrazione avviene a OGNI operazione, quindi includerlo
 * consumerebbe quel componente tante volte quante sono le operazioni. Il fatto si DICHIARA — un
 * componente che l'albero Plex non ha collocato, con `EACH_OP`, non viene consumato mai — ed e' la
 * stessa assenza che DEC-86 ferma in invio al passo 2bis: va guardata, non compensata qui.
 *
 * @param {number|null} compOp operazione dell'albero Plex a cui il componente e' appeso
 * @param {number|null} at `null` = nessun filtro
 * @returns {boolean}
 */
function componentAtOp(compOp, at) {
  if (at === null || at === undefined) return true;
  if (compOp === null || compOp === undefined) return false;
  return compOp === at;
}

module.exports = {
  PROD_POSTING,
  CONSUME_AT,
  SCRAP_CONSUME,
  SCRAP_MOVE,
  SCRAP_ISSUE,
  SCRAP_NO_ORDER,
  DEFAULTS,
  WIDTH,
  pickMode,
  pickFlag,
  normalizeReason,
  normalizeConfig,
  isDefault,
  validateConfig,
  productionScope,
  confirmScope,
  // [CONF-OP-BRIDGE] Il collegamento all'operazione SAP e' un requisito del canale MATDOC, non della
  // conferma di testata: vedi la testata della funzione.
  LINK_ONLY_CAUSES,
  sapLinkFatal,
  // [CONF-OUTCOME] Quantita' e unita' in un parametro solo: vedi la testata.
  confQtyText,
  scrapPlan,
  componentInScope,
  componentAtOp
};

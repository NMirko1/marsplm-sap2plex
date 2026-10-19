/**
 * ============================================================================
 * [ORDER-STATUS-POST] SONDA TEMPORANEA — CHIUSURA E CHIUSURA TECNICA DELL'ORDINE
 * ============================================================================
 *
 * A COSA SERVE
 * Risponde a una domanda sola: **le due POST di chiusura ordine arrivano alla function module in
 * ECC?** Gli indirizzi sono pubblicati da tempo — `EndpointFlussiMARS_V1.xlsx`, righe **N.20** e
 * **N.21** — e non li ha mai chiamati nessuno:
 *
 *   N.20  CloseOrder        ZMARS_PROD_ORDER_CLOSE  POST  …_ORDER_CLOSE_POST;v=1
 *   N.21  TechlyCmpltOrder  ZMARS_PROD_ORDER_TECO   POST  …_ORDER_TECO_POST;v=1
 *
 * Nel repo, di questi due flussi, finora c'era solo carta: il contratto in
 * srv/external/Endpoint_OData_Integration-20260728.md § 2 (un solo parametro `ManufacturingOrder`,
 * ritorno `FunctionMessage`, CSRF richiesto), le due `action` nell'EDMX standard
 * (srv/external/OP_API_PRODUCTION_ORDER_2_SRV_0001.cds:1453-1454) e la nota DEC-24 che dichiara le
 * due FM ABAP ancora **proposte**. Prima di progettare qualunque flusso di chiusura serve la stessa
 * cosa che è servita per la classificazione, la distinta e la conferma d'ordine: una chiamata vera,
 * con valori concreti, che dica se l'indirizzo risponde e **fin dove arriva il messaggio**.
 *
 * L'ESITO ATTESO E' LA DIAGNOSI, NON IL SUCCESSO. Un `BAPIRET2` di errore «ordine non esistente» è
 * la risposta che si cerca: significa che il messaggio ha attraversato l'iFlow ed è arrivato alla FM.
 * Un successo, con questi dati, è un ALLARME — vedi il blocco MOCK.
 *
 * ============================================================================
 * LA FORMA: «COME EXPLODEBOM», E NON E' UN'ANALOGIA APPROSSIMATIVA
 * ============================================================================
 * `CloseOrder` e `TechlyCmpltOrder` sono **Function Import**: non sono entity set, non hanno chiavi,
 * quindi **non c'è nessun key predicate da scrivere e i parametri vanno in QUERY STRING**. E' la
 * stessa forma di `ExplodeBOM`, e con essa si eredita tutto quello che quella sonda ha già pagato
 * (la storia intera è in DEC-44/DEC-45, misurata dalla sonda della distinta base, ora rimossa):
 *
 *   1. LA GUARDIA DELL'IFLOW. Il primo passo del flusso, che il team Integration ci ha passato, è
 *
 *        String query = message.getHeader("CamelHttpQuery", String)
 *        if (!query) { throw new IllegalArgumentException("CamelHttpQuery non valorizzata") }
 *
 *      In Groovy `!query` è vero anche per la stringa VUOTA. Quindi una POST col parametro nel
 *      CORPO e la query string vuota muore lì, prima di ECC — e per la stessa ragione il
 *      `$metadata` del service root non può funzionare: `…;v=1/$metadata` non ha query string.
 *      E' un controllo il cui fallimento è ATTESO e dichiarato tale, non un guasto.
 *
 *   2. GLI APICI. Gli apici sono la sintassi dei literal OData, ma qui a leggere la query string è
 *      uno script scritto a mano: se spezza su `&` e `=` senza spacchettare i literal,
 *      `IV_MANUFACTURING_ORDER` riceve `'999999999999'` VIRGOLETTE COMPRESE. In ABAP non trova
 *      niente e **non dà errore** — è il modo più probabile di ottenere un 200 che non ha fatto
 *      nulla, cioè il fallimento che non sembra un fallimento. La variante `.noq` manda il valore
 *      nudo, ed è l'unico modo di distinguere i due casi.
 *
 * Chiamata di riferimento, corpo VUOTO:
 *
 *   POST …_ORDER_CLOSE_POST;v=1/CloseOrder?ManufacturingOrder='999999999999'
 *   POST …_ORDER_TECO_POST;v=1/TechlyCmpltOrder?ManufacturingOrder='999999999999'
 *
 * ============================================================================
 * COSA SI MISURA: LA PROFONDITA', NON L'HTTP
 * ============================================================================
 * «Raggiungiamo la FM?» non è una domanda a cui il codice HTTP sappia rispondere: un 500 può venire
 * dall'ingresso dell'iFlow o da dentro il BAPI, e sono due notizie opposte. Ogni riga dichiara
 * quindi un `depth`, e il verdetto è quello:
 *
 *   NESSUNA_RISPOSTA  404, 503, o la guardia CamelHttpQuery  -> non si è passato l'ingresso
 *   IFLOW             c'è un MPL ID ma nessun BAPIRET2       -> CPI ha preso in carico, la FM no
 *   FM                è tornato un messaggio applicativo     -> **la prova che si cercava**
 *   ESEGUITO          messaggio di successo, nessun errore   -> SAP ha chiuso qualcosa: ALLARME
 *
 * `ok` vale true da `FM` in su: qui «riuscito» significa ARRIVATO, non «ha chiuso l'ordine».
 *
 * IL NOME DEL PARAMETRO DI USCITA NON E' NOTO, e i due strati dell'endpoint lo renderebbero con due
 * vocabolari diversi: `TYPE`/`MESSAGE` se risponde la FM in ABAP, `SystemMessageType`/
 * `SystemMessageLongText` se risponde l'EDM (è il tipo `FunctionMessage`,
 * OP_API_PRODUCTION_ORDER_2_SRV_0001.cds:1917-1934). Per questo `findMessages` cerca **per forma e
 * non per nome**, conosce entrambi i vocabolari e DICHIARA dove ha trovato il messaggio: così la
 * prima chiamata reale risponde alla domanda invece di richiedere un altro giro di specifiche.
 *
 * ============================================================================
 * COSA E' DEFINITIVO E COSA NO
 * ============================================================================
 * Definitivi sono gli indirizzi e la lettura dell'esito. Provvisori sono i DATI (mock su un ordine
 * inesistente) e l'INNESCO, che dalla W1-20 è A MANO: `window.orderStatusPost()` dalla console del
 * cockpit, e in produzione nemmeno quello, perché `ORDER_STATUS_POST=off` è impostata in mta.yaml.
 * Prima era l'apertura della dashboard, quindi le due POST partivano a ogni refresh.
 *
 * NON SCRIVE NIENTE DA NESSUNA PARTE, dalla nostra parte: nessuna tabella, nessun log applicativo.
 * NON LANCIA MAI: una sonda respinta deve mostrare il proprio scambio, non diventare un 500 in
 * faccia a chi l'ha lanciata.
 *
 * LEVE (nessuna richiede un rilascio)
 *   ORDER_STATUS_POST=off        spegne tutto — ed è già `off` in produzione (mta.yaml)
 *   ORDER_STATUS_POST_FULL=on    scala completa (i controlli, vedi `variantsFor`)
 *   ORDER_STATUS_POST_SHAPE      'qs' (predefinita) | 'noq' | 'fm' — quale variante è la principale
 *   ORDER_STATUS_POST_METADATA=off  esclude il controllo $metadata dalla scala completa
 *   ORDER_STATUS_POST_CSRF=off   disattiva il fetch del token (controprova delle due cause del 403)
 *   ORDER_STATUS_POST_CLOSE_PATH / _TECO_PATH   indirizzi alternativi
 *   ORDER_STATUS_POST_CLOSE_FI   / _TECO_FI     nomi alternativi del Function Import
 *   ORDER_STATUS_POST_ORDER      ordine alternativo — LEVA D'EMERGENZA, leggere il blocco MOCK
 *
 * Perimetro completo: grep -rn "ORDER-STATUS-POST"
 * Contratto verso il team Integration: srv/external/PROD_ORDER_STATUS_POST_IS.md
 */

'use strict';

const cds = require('@sap/cds');
const { upstreamStatus, errorText } = require('./isRemoteSource');
// [IS-CALL-LOG] Serve per il tap sulla RISPOSTA: questo modulo parla con CAP via `cds.connect.to`
// diretto e non passa da `createRemoteSource`, quindi il tap va installato qui — altrimenti lo
// scambio crudo dipenderebbe dal fatto che qualcun altro abbia inizializzato un'area prima.
const Log = require('./isCallLog');
// [IS-EGRESS] come esce una chiamata verso gli iFlow da questo processo: la destination vive in un
// punto solo.
const { resolveEgress } = require('./isEgress');

/**
 * Entry di cds.requires che porta le credenziali verso la destination.
 *
 * ATTENZIONE. E' lo STESSO entry da cui `prodOrderSource()` legge gli ordini in esercizio
 * (srv/lib/prodOrderSource.js). Non si pestano i piedi perché `cds.connect.to(BASE, options)` con
 * `credentials` crea un'ISTANZA NUOVA e non sostituisce quella registrata sul nome del servizio: è
 * lo stesso schema con cui isRemoteSource.js:206 istanzia i 15 service root dell'Integration Suite
 * a partire dallo stesso CSN. Chi cambia questa riga guardi prima `grep -rn "$BASE" srv/`.
 */
const BASE = 'OP_API_PRODUCTION_ORDER_2_SRV_0001';

/** Il parametro, nei due vocabolari: OData davanti all'iFlow, ABAP dietro. */
const PARAM = 'ManufacturingOrder';
const PARAM_ABAP = 'IV_MANUFACTURING_ORDER';

/**
 * LE DUE CHIAMATE, con l'indirizzo pubblicato. `sheet` non è decorazione: quando si scrive al team
 * Integration, la riga del foglio è il modo più corto di dire di quale flusso si sta parlando.
 */
const CALLS = Object.freeze([
  Object.freeze({
    key: 'close',
    id: 'CLOSE',
    sheet: 'N.20',
    functionImport: 'CloseOrder',
    fm: 'ZMARS_PROD_ORDER_CLOSE',
    what: 'chiusura ordine (business close)',
    path: '/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_ORDER_CLOSE_POST;v=1'
  }),
  // [ORDER-SCHEDULED] >>> IL NOME DI QUESTA VOCE MENTE, E VA LETTO PRIMA DI TOCCARLA. <<<
  //
  // Il Function Import si chiama `TechlyCmpltOrder` e la FM `ZMARS_PROD_ORDER_TECO`, ma la RFC
  // dietro questo indirizzo E' STATA CORRETTA e scrive uno STATO UTENTE `Scheduled` sull'ordine:
  // non fa nessuna chiusura tecnica. L'indicazione e' del team di progetto (feature 0046) e la
  // premessa e' che questo indirizzo non era usato da nessun flusso, quindi ci e' stata messa
  // dentro la funzione giusta.
  //
  // Perche' conta: chi legge «TECO» pensa alla chiusura tecnica, che a valle blocca conferme e
  // movimenti. Se qualcuno «correggesse» l'ABAP riportandolo alla funzione che il nome descrive,
  // il job ORDER_SCHEDULED metterebbe in chiusura tecnica OGNI ordine appena pianificato — e non
  // ci sarebbe nessun errore da nessuna parte. La forma giusta a regime e' rinominare
  // l'indirizzo: e' la richiesta 2 in testa a srv/external/PROD_ORDER_STATUS_POST_IS.md.
  //
  // `what` resta il nome di CONTRATTO dell'indirizzo — e' quello che il team Integration usa — con
  // fra parentesi cio' che fa davvero: la sonda del cockpit stampa questa stringa.
  Object.freeze({
    key: 'teco',
    id: 'TECO',
    sheet: 'N.21',
    functionImport: 'TechlyCmpltOrder',
    fm: 'ZMARS_PROD_ORDER_TECO',
    what: 'N.21 «chiusura tecnica» — la RFC scrive lo STATO UTENTE «pianificato» (0046, DEC-118)',
    path: '/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_ORDER_TECO_POST;v=1'
  })
]);

const DEFAULTS = {
  enabled: true,
  destination: 'MARS_SAP_CON',
  orderId: '999999999999',   // ordine INESISTENTE: è la garanzia di sicurezza, vedi il blocco MOCK
  // Quale variante è la principale, cioè l'unica che parte nel giro normale.
  // 'qs' = parametro fra apici in query string (il contratto) | 'noq' = valore nudo | 'fm' = busta
  // della function module nel corpo, query string vuota.
  shape: 'qs',
  full: false,               // scala completa: aggiunge i controlli, vedi `variantsFor`
  metadata: true,            // includi il controllo $metadata nella scala completa
  csrf: true,                // POST su un service root OData V2: il token serve (DEC-24)
  requestTimeout: 60000,
  calls: {
    close: { path: CALLS[0].path, functionImport: CALLS[0].functionImport },
    teco: { path: CALLS[1].path, functionImport: CALLS[1].functionImport }
  }
};

// ====================================================================================
// DATI PROVVISORI — IL BLOCCO MOCK
//
// >>> L'ORDINE INESISTENTE E' L'UNICA COSA CHE SEPARA QUESTA SONDA DA UNA SCRITTURA REALE. <<<
//
// Le due FM `ZMARS_PROD_ORDER_CLOSE` e `ZMARS_PROD_ORDER_TECO` NON hanno un `IV_TEST_RUN`: la
// loro firma proposta è `IV_MANUFACTURING_ORDER` in ingresso e `ET_RETURN` in uscita, e basta
// (Endpoint_OData_Integration-20260728.md, § «Riepilogo Function Module»).
//
// COSA SCRIVONO SU UN ORDINE VERO: secondo l'indicazione del team di progetto, uno STATO UTENTE
// informativo e nient'altro — nessuna chiusura, nessun TECO. Ma l'unica CONFERMA SCRITTA che
// abbiamo dice il contrario («Endpoint_OData_Integration», § omonimo), e finche' le due
// affermazioni non coincidono qui si continua a mandare un ordine inesistente: non e' prudenza
// generica, e' che una chiusura d'ordine da qui non si annulla. La richiesta e' in testa a
// srv/external/PROD_ORDER_STATUS_POST_IS.md.
//
// Quello che lo impedisce è il dato: `999999999999` non è un ordine, SAP non ha nulla da
// chiudere, e la sua risposta — «ordine non esistente» — è precisamente la prova che il
// messaggio ha attraversato l'iFlow. E' lo stesso valore e la stessa logica di [PRODCONF-POST].
//
// Chi cambia questo valore, o chi usa ORDER_STATUS_POST_ORDER, sta chiedendo a SAP di chiudere un
// ordine vero. E' una leva d'emergenza, non un parametro di comodo.
// ====================================================================================

/** I quattro tipi di variante. `qs` è la forma contrattuale; le altre tre sono controlli. */
const KINDS = Object.freeze(['meta', 'qs', 'noq', 'fm']);

/** Quali `shape` sono accettate come variante principale. */
const SHAPES = Object.freeze(['qs', 'noq', 'fm']);

// ---------------------------------------------------------------------------------------------
// COSTRUZIONE DELLA RICHIESTA — PARTI PURE
// ---------------------------------------------------------------------------------------------

/** Lo spazio si codifica, gli apici NO: con `%27` non sarebbe più la richiesta da misurare. */
function enc(s) {
  return String(s).replace(/ /g, '%20');
}

function norm(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

/**
 * LA FORMA DEL FUNCTION IMPORT: `Nome?P1='v1'&P2='v2'&…`. È la forma che la sonda della distinta base
 * aveva misurato come l'unica accettata, perché
 * è la stessa forma e scriverne una seconda versione vorrebbe dire farle divergere.
 *
 * Le stringhe vanno fra apici — sintassi dei literal OData; `quote: false` manda il valore nudo,
 * che è la variante `.noq` (vedi «GLI APICI» nella testata).
 *
 * @param {string}   nome   nome del Function Import
 * @param {object}   values valori per nome di parametro
 * @param {string[]} ordine quali parametri e in quale ordine
 * @param {object}   [opts] `{ quote = true }`
 */
function functionParams(nome, values, ordine, { quote = true } = {}) {
  const parts = ordine.map((k) => {
    const v = enc(norm(values[k]));
    return `${k}=${quote ? `'${v}'` : v}`;
  });
  return `${nome}?${parts.join('&')}`;
}

/**
 * La richiesta di una variante. FUNZIONE PURA: niente rete, niente `cds`, niente orologio — l'ordine
 * arriva da fuori. E' ciò che la rende collaudabile in test/prodOrderStatusPost.test.js.
 *
 * @param {string} kind    'meta' | 'qs' | 'noq' | 'fm'
 * @param {object} call    una voce di CALLS
 * @param {string} fi      nome del Function Import (dalla configurazione: può essere sovrascritto)
 * @param {string} orderId l'ordine — l'invariante di sicurezza
 * @returns {{method: string, suffix: string, body: object|null, accept: string, what: string}}
 */
function buildCall(kind, call, fi, orderId) {
  const values = { [PARAM]: orderId };
  switch (kind) {
    case 'meta':
      return {
        method: 'GET',
        suffix: '$metadata',
        body: null,
        accept: 'application/xml',
        // Il fallimento è ATTESO e va scritto PRIMA di vederlo: un controllo il cui esito negativo
        // sembra un guasto è un controllo che verrà diagnosticato invece di essere letto.
        what: `controllo — $metadata del service root di ${call.functionImport}. Il fallimento è `
          + 'ATTESO: un $metadata non ha query string, quindi cade nella guardia CamelHttpQuery '
          + '(vedi la testata). Se invece risponde, dice se il root dichiara il Function Import e '
          + 'con quali parametri, e allora l\'indirizzo è ispezionabile dall\'esterno'
      };
    case 'noq':
      return {
        method: 'POST',
        suffix: functionParams(fi, values, [PARAM], { quote: false }),
        body: null,
        accept: '',
        what: `controllo — lo stesso parametro NUDO, senza apici. Serve solo se la forma `
          + 'contrattuale risponde 200 senza aver fatto niente: se questa passa e quella no, gli '
          + 'apici dei literal OData arrivano dentro il valore e l\'iFlow non li spacchetta'
      };
    case 'fm':
      return {
        method: 'POST',
        // Sul service root, senza suffisso: su un HTTPS sender non esistono Function Import, è il
        // path stesso a identificare l'operazione. E' com'è finita per il movimento merci.
        suffix: '',
        body: { [PARAM_ABAP]: orderId },
        accept: '',
        what: `controprova — la busta della function module nel CORPO (${PARAM_ABAP}), POST sul `
          + 'service root e query string VUOTA. E\' la forma giusta se l\'indirizzo fosse un HTTPS '
          + 'sender come il movimento merci; con un service root OData il fallimento sulla guardia '
          + 'CamelHttpQuery è ATTESO'
      };
    case 'qs':
    default:
      return {
        method: 'POST',
        suffix: functionParams(fi, values, [PARAM], { quote: true }),
        body: null,
        accept: '',
        what: `${call.what} — la forma CONTRATTUALE: Function Import coi parametri in query string, `
          + `apici dei literal OData, corpo VUOTO. A valle c'è ${call.fm} (foglio ${call.sheet})`
      };
  }
}

/**
 * Le varianti da eseguire. FUNZIONE PURA.
 *
 * GIRO NORMALE = **una chiamata per endpoint**, la principale, cioè due POST in tutto. I controlli
 * costano voci MPL nel monitor del team Integration a ogni lancio, e su una SCRITTURA non si
 * accende un ventaglio per abitudine: si accende quando serve, con `Full`.
 *
 * @param {object}  cfg  la configurazione effettiva
 * @param {boolean} full scala completa
 */
function variantsFor(cfg, full) {
  const kinds = full
    // Il $metadata per primo: è l'unica lettura senza effetti, e va tentata prima di scrivere.
    ? KINDS.filter((k) => k !== 'meta' || cfg.metadata)
    : [SHAPES.includes(cfg.shape) ? cfg.shape : 'qs'];

  const out = [];
  for (const call of CALLS) {
    const conf = (cfg.calls && cfg.calls[call.key]) || {};
    const path = conf.path || call.path;
    const fi = conf.functionImport || call.functionImport;
    for (const kind of kinds) {
      const built = buildCall(kind, call, fi, cfg.orderId);
      out.push({ id: `${call.id}.${kind}`, kind, call, path, fi, ...built });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// LETTURA DELL'ESITO — PARTI PURE
// ---------------------------------------------------------------------------------------------

/**
 * I NOMI DEL MESSAGGIO NEI DUE VOCABOLARI. Davanti all'iFlow c'è un EDM che rende il `BAPIRET2`
 * come `FunctionMessage` (SystemMessage*), dietro c'è la FM che lo rende in ABAP maiuscolo. Cercare
 * solo il primo avrebbe dichiarato «nessun messaggio» su una risposta che ce l'ha — cioè l'errore
 * più costoso che questo modulo possa fare, perché è esattamente la prova che la sonda esiste per
 * trovare.
 */
const MSG_FIELDS = Object.freeze({
  type: ['TYPE', 'SYSTEMMESSAGETYPE', 'MSGTY'],
  id: ['ID', 'SYSTEMMESSAGEIDENTIFICATION', 'MSGID'],
  number: ['NUMBER', 'SYSTEMMESSAGENUMBER', 'MSGNO'],
  text: ['MESSAGE', 'SYSTEMMESSAGELONGTEXT', 'MSGTX', 'MESSAGE_V1']
});

/** Tutti i nomi riconoscibili, per decidere se un oggetto SOMIGLIA a un messaggio. */
const MSG_NAMES = new Set([
  ...Object.values(MSG_FIELDS).flat(),
  'LOG_NO', 'LOG_MSG_NO', 'MESSAGE_V2', 'MESSAGE_V3', 'MESSAGE_V4', 'PARAMETER', 'ROW', 'FIELD',
  'SYSTEM', 'SYSTEMMESSAGEVARIABLE1', 'SYSTEMMESSAGEVARIABLE2', 'SYSTEMMESSAGEVARIABLE3',
  'SYSTEMMESSAGEVARIABLE4'
]);

/** Legge un campo SENZA badare al maiuscolo, provando gli alias nell'ordine dato. */
function field(row, aliases) {
  if (!row || typeof row !== 'object') return '';
  const keys = Object.keys(row);
  for (const a of aliases) {
    const k = keys.find((x) => x.toUpperCase() === a);
    if (k !== undefined) {
      const v = norm(row[k]);
      if (v !== '') return v;
    }
  }
  return '';
}

/**
 * Somiglia a un messaggio applicativo? Servono almeno due campi noti, e uno dei due deve essere il
 * TIPO o il TESTO: senza quelli non c'è niente da leggere, e un oggetto qualunque con un campo `ID`
 * non è un `BAPIRET2`.
 */
function looksLikeMessage(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const noti = Object.keys(v).filter((k) => MSG_NAMES.has(k.toUpperCase()));
  if (noti.length < 2) return false;
  return field(v, MSG_FIELDS.type) !== '' || field(v, MSG_FIELDS.text) !== '';
}

/**
 * Trova il messaggio applicativo nella risposta. FUNZIONE PURA.
 *
 * CERCA PER FORMA, NON PER NOME. Il nome del parametro di uscita non ci è stato dichiarato e
 * indovinarlo significherebbe non trovare nulla e dire «nessuna risposta» quando la risposta c'è.
 * Si scende nell'oggetto fino a `MAX_DEPTH` livelli e si DICHIARA dove si è trovato, così la prima
 * chiamata reale ci dice il nome vero.
 *
 * Le forme tollerate sono tutte quelle in cui un `ET_RETURN` può arrivare in JSON:
 *   { …messaggio… }                 un messaggio solo, senza involucro (è il caso di FunctionMessage)
 *   [ {…} ]                         array nudo
 *   { X: [ {…} ] }                  array sotto una chiave qualunque
 *   { d: { X: {…} } }               involucro JSON di OData V2
 *   { X: { item: [ {…} ] } }        resa ABAP->JSON, come IT_ITEM del movimento merci
 *   { X: { results: [ {…} ] } }     convenzione JSON di OData V2
 *
 * @returns {{messages: object[], shape: string}} `shape` vuota se non si è trovato nulla
 */
function findMessages(body) {
  const MAX_DEPTH = 6;
  if (!body || typeof body !== 'object') return { messages: [], shape: '' };

  const walk = (v, path, depth) => {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return null;
    if (Array.isArray(v)) {
      const messages = v.filter(looksLikeMessage);
      if (messages.length) return { messages, shape: path };
      for (let i = 0; i < v.length; i++) {
        const r = walk(v[i], `${path}[${i}]`, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (looksLikeMessage(v)) {
      return { messages: [v], shape: `${path} (messaggio singolo, senza tabella)` };
    }
    // Gli involucri noti per primi, così `shape` non riporta un percorso più profondo del necessario.
    for (const wrapper of ['d', 'item', 'results', 'value']) {
      if (v[wrapper] !== undefined) {
        const r = walk(v[wrapper], `${path}.${wrapper}`, depth + 1);
        if (r) return r;
      }
    }
    for (const [k, child] of Object.entries(v)) {
      const r = walk(child, path === '(risposta)' ? k : `${path}.${k}`, depth + 1);
      if (r) return r;
    }
    return null;
  };

  return walk(body, '(risposta)', 0) || { messages: [], shape: '' };
}

/**
 * IL GUSCIO DEL MESSAGGIO, VUOTO. Cerca un oggetto che abbia almeno due campi riconoscibili come
 * `BAPIRET2`/`FunctionMessage` ma **nessun valore**: e' la forma che `looksLikeMessage` scarta, ed
 * e' quella che stiamo osservando su `CloseOrder` e `TechlyCmpltOrder`.
 *
 * Distinguerla vale piu' di quanto sembri: dire «nessun messaggio riconosciuto» su una risposta che
 * porta gli otto campi giusti tutti a `null` manda a cercare il difetto dalla parte sbagliata —
 * nella chiamata, invece che nel riempimento della risposta. FUNZIONE PURA.
 *
 * @returns {{found: boolean, shape: string, fields: number}}
 */
function findEmptyMessageShape(body) {
  const MAX_DEPTH = 6;
  if (!body || typeof body !== 'object') return { found: false, shape: '', fields: 0 };

  const walk = (v, path, depth) => {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return null;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const r = walk(v[i], `${path}[${i}]`, depth + 1);
        if (r) return r;
      }
      return null;
    }
    const noti = Object.keys(v).filter((k) => MSG_NAMES.has(k.toUpperCase()));
    const valorizzati = noti.filter((k) => norm(v[k]) !== '');
    if (noti.length >= 2 && valorizzati.length === 0) {
      return { found: true, shape: path, fields: noti.length };
    }
    for (const [k, child] of Object.entries(v)) {
      const r = walk(child, path === '(risposta)' ? k : `${path}.${k}`, depth + 1);
      if (r) return r;
    }
    return null;
  };

  return walk(body, '(risposta)', 0) || { found: false, shape: '', fields: 0 };
}

/**
 * LA RISPOSTA E' UN ERRORE ODATA BEN FORMATO? FUNZIONE PURA.
 *
 * Discrimina i due 404 che finora finivano nello stesso cassetto, e che dicono cose opposte:
 *
 *   404 di ROTTA        nessuno ha trovato l'indirizzo. Corpo assente, HTML, o di un proxy.
 *   404 APPLICATIVO     un servizio OData ha elaborato la richiesta e l'ha RIFIUTATA. Il corpo e'
 *                       `{"error":{"code":…,"message":{"value":…}}}` e gli header portano
 *                       `dataserviceversion`.
 *
 * Sul secondo la catena arriva a destinazione, e su un ordine inesistente «entity could not be
 * found» e' l'esito ATTESO — dirlo «indirizzo che non esiste» manda a cercare dalla parte sbagliata.
 * Misurato su CloseOrder il 2026-08-14, con la RFC osservata girare in debug.
 *
 * Si guarda il corpo e non gli header perche' il corpo c'e' su entrambi i rami del chiamante,
 * mentre `dataserviceversion` arriva solo quando CAP espone gli header della risposta.
 */
function isODataError(r) {
  const testo = `${(r && r.rawBody) || ''} ${(r && r.responseBody) || ''} ${(r && r.error) || ''}`;
  if (/"error"\s*:\s*\{/.test(testo) && /"message"\s*:/.test(testo)) return true;
  // CAP riporta il solo `message.value` nel testo dell'errore: e' comunque la prova che a rispondere
  // e' stato un servizio OData, perche' quel messaggio lo produce il suo gestore delle eccezioni.
  return /dataserviceversion/i.test(`${(r && r.responseHeaders) || ''}`);
}

/**
 * Il `code` dell'errore OData: e' la riga che dice CHI ha rifiutato. I codici del gateway
 * (`/IWBEP/CX_MGW_*`) vengono dallo strato OData, quelli con un namespace applicativo dalla logica
 * ABAP a valle — e la differenza decide a chi si gira la segnalazione. FUNZIONE PURA.
 */
function odataErrorCode(r) {
  const testo = `${(r && r.rawBody) || ''} ${(r && r.responseBody) || ''}`;
  const m = /"code"\s*:\s*"([^"]{1,80})"/.exec(testo);
  return m ? m[1] : '';
}

/** I tipi `BAPIRET2` che dicono «non fatto». `A` è l'abort, ed è un errore a tutti gli effetti. */
const TIPI_ERRORE = new Set(['E', 'A', 'X']);

/**
 * Interpreta la risposta. FUNZIONE PURA.
 *
 * Nel dubbio si dichiara NON ESEGUITO. Dare per chiuso un ordine che non lo è sarebbe sbagliato, ma
 * il contrario è peggio: dichiarare «eseguito» quando non lo è nasconderebbe l'unico caso in cui
 * questa sonda va fermata subito.
 *
 * @returns {{reached: boolean, done: boolean, messageType: string, messageId: string,
 *            messageNumber: string, messageText: string, messageCount: number,
 *            responseShape: string, reason: string}}
 */
function readOutcome(body) {
  const { messages, shape } = findMessages(body);
  const errore = messages.find((m) => TIPI_ERRORE.has(field(m, MSG_FIELDS.type).toUpperCase()));
  const primo = errore || messages[0] || {};
  const tipo = field(primo, MSG_FIELDS.type).toUpperCase();

  const out = {
    reached: messages.length > 0,
    done: false,
    messageType: tipo,
    messageId: field(primo, MSG_FIELDS.id),
    messageNumber: field(primo, MSG_FIELDS.number),
    messageText: field(primo, MSG_FIELDS.text).slice(0, 600),
    messageCount: messages.length,
    responseShape: shape,
    reason: ''
  };

  if (!messages.length) {
    // LA STRUTTURA C'E' MA E' VUOTA non e' «nessuna risposta»: sono i due esiti piu' facili da
    // confondere e accusano persone diverse. Se il guscio del messaggio arriva coi suoi campi
    // riconoscibili e TUTTI nulli, la FM e' stata invocata e l'iFlow ha costruito la risposta —
    // manca solo il riempimento, cioe' il response mapping. Se invece non arriva nemmeno il guscio,
    // la chiamata non e' arrivata alla FM. Misurato su CloseOrder e TechlyCmpltOrder il 2026-08-13.
    const vuoto = findEmptyMessageShape(body);
    if (vuoto.found) {
      out.responseShape = vuoto.shape;
      out.emptyMessage = true;
      out.reason = `la struttura del messaggio C'E' (${vuoto.fields} campi noti in ${vuoto.shape}) ma `
        + 'i valori sono TUTTI nulli. Non e\' «nessuna risposta»: l\'iFlow ha costruito il guscio e '
        + 'non l\'ha riempito con quello che la FM ha restituito. Il difetto e\' nel response mapping, '
        + 'non nella chiamata.';
    } else {
      out.reason = 'nessun messaggio applicativo riconosciuto nella risposta: o non c\'è, o ha una '
        + 'forma che non prevediamo. Il corpo completo è nel log.';
    }
  } else if (errore) {
    // E' l'esito ATTESO su un ordine inesistente, ed è un successo di integrazione.
    out.reason = `la FM ha risposto ${tipo} ${out.messageId} ${out.messageNumber}: `
      + `${out.messageText || '(nessun testo)'}`;
  } else {
    out.done = true;
    out.reason = `la FM ha risposto ${tipo || '(senza tipo)'} e nessun errore: l'operazione risulta `
      + 'ESEGUITA.';
  }
  return out;
}

/**
 * LA GUARDIA DELL'IFLOW. Riconoscerla vale più di qualunque codice HTTP: dice che la richiesta è
 * ARRIVATA e non è mai stata eseguita — nessun dato guardato, nessuna funzione ABAP chiamata. Il
 * messaggio può essere in italiano, il nome dello script e quello dell'header no: si cercano quelli.
 * Stessa funzione che aveva la sonda della distinta base, e per la stessa ragione.
 */
function isQueryGuard(r) {
  const s = `${(r && r.error) || ''} ${(r && r.responseBody) || ''}`;
  return /CamelHttpQuery|GetQueryFilter/i.test(s);
}

const QUERY_GUARD_MSG = 'la QUERY STRING è vuota — guardia in GetQueryFilter.groovy '
  + '(«CamelHttpQuery non valorizzata»): la richiesta è arrivata ed è morta nel primo script, prima '
  + 'di ECC';

/**
 * L'MPL ID che Cloud Integration mette nel messaggio d'errore. Vale più del codice HTTP: esiste solo
 * per messaggi che il runtime ha accettato e iniziato a elaborare, ed è la chiave con cui il team
 * Integration apre l'esecuzione fallita nel proprio monitor.
 */
function extractMplId(body) {
  const s = typeof body === 'string' ? body : safeStringify(body);
  const m = /MPL\s*ID[^:]*:\s*([\w-]+)/i.exec(s || '');
  return m ? m[1] : '';
}

/**
 * QUANTO IN PROFONDITA' E' ARRIVATO IL MESSAGGIO. FUNZIONE PURA, ed è la risposta alla domanda per
 * cui questa sonda esiste. L'ordine dei rami è quello della certezza: un messaggio applicativo è una
 * prova, un MPL ID è un indizio, un codice HTTP non è nessuno dei due.
 *
 * @returns {'ESEGUITO'|'FM'|'IFLOW'|'NESSUNA_RISPOSTA'}
 */
function depthOf(r) {
  if (r.alarm) return 'ESEGUITO';
  if (r.messageCount > 0) return 'FM';
  // La guardia PRIMA di ogni altra cosa: è l'unico caso in cui si sa con certezza che nessuna
  // funzione ABAP è stata chiamata, e viene rifiutata prima che il flusso guardi il messaggio.
  if (isQueryGuard(r)) return 'NESSUNA_RISPOSTA';
  // UN ERRORE ODATA BEN FORMATO NON E' UN INDIRIZZO ASSENTE, nemmeno con un 404. Chi risponde
  // `dataserviceversion` e un corpo `{"error":{...}}` e' un servizio OData che ha ELABORATO la
  // richiesta: la rotta c'era, il documento e' stato interpretato, e la risposta e' un rifiuto
  // applicativo. Misurato su CloseOrder il 2026-08-14: 404 «Requested entity could not be found»
  // con la RFC osservata girare in debug — cioe' l'esito ATTESO su un ordine inesistente.
  if (isODataError(r)) return 'IFLOW';
  // Un 2xx senza messaggio applicativo: l'iFlow ha risposto, ma che la FM sia stata eseguita non è
  // dimostrato. Chiamarlo «FM» sarebbe la bugia comoda, chiamarlo «non raggiunto» quella pigra.
  if (r.httpOk) return 'IFLOW';
  // Un MPL ID senza messaggio applicativo: CPI ha preso in carico e si è fermato dentro il flusso.
  if (r.mplId) return 'IFLOW';
  // Un 5xx che non è la guardia: l'iFlow c'è ed è esploso dentro. Non basta a dire «FM raggiunta»,
  // ma è più di «non risponde nessuno», e confonderli manda a cercare nel posto sbagliato.
  if (r.httpStatus >= 500 && r.httpStatus !== 503) return 'IFLOW';
  return 'NESSUNA_RISPOSTA';
}

// ---------------------------------------------------------------------------------------------
// IL VERDETTO
// ---------------------------------------------------------------------------------------------

/**
 * Perché una singola variante non è arrivata. I codici non vanno appiattiti: 503 e 500 dicono cose
 * opposte — il primo che al canale non ha risposto nessuno, il secondo che l'iFlow c'è ed è esploso
 * dentro — ed è l'errore di lettura più facile da fare.
 */
function perche(r) {
  const st = r.httpStatus || 0;
  if (isQueryGuard(r)) return QUERY_GUARD_MSG;
  if (st === 404 && isODataError(r)) {
    // I due 404 non vanno confusi: qui il servizio HA risposto, con un errore OData suo.
    return '404 CON ERRORE ODATA: l\'indirizzo c\'è e ha elaborato la richiesta — chi non trova una '
      + 'rotta non risponde `dataserviceversion` né un corpo `{"error":…}`. Su un ordine '
      + 'inesistente «entity could not be found» è l\'ESITO ATTESO, quindi la catena arriva a '
      + 'destinazione: quello che manca è il messaggio applicativo della FM, non l\'indirizzo'
      + (odataErrorCode(r)
        ? `. code «${odataErrorCode(r)}»: ${/IWBEP|MGW/i.test(odataErrorCode(r))
          ? 'viene dallo strato OData del gateway, non dalla logica ABAP'
          : 'namespace applicativo, quindi il rifiuto arriva da valle del gateway'}`
        : '. Il codice dentro il corpo direbbe se il rifiuto viene dal gateway o dalla logica ABAP');
  }
  if (st === 404) {
    return `404: a quell'indirizzo non c'è nulla con quel nome. O il Function Import non si chiama `
      + `'${r.call}', o l'iFlow non lo espone. Leva: ORDER_STATUS_POST_${r.id.split('.')[0]}_FI`;
  }
  if (st === 405) {
    return '405: il metodo non è ammesso. L\'indirizzo esiste ma non accetta una POST su quel '
      + 'percorso: il Function Import potrebbe essere esposto in GET';
  }
  if (st === 403) return diagnose403(r);
  if (st === 415) {
    // Su una POST senza corpo axios manda `content-type: application/x-www-form-urlencoded` — si
    // vede negli header echeggiati, ed è ciò che CAP invia per tutte le chiamate del progetto. Su un
    // Function Import il corpo non serve, ma un sender che valida il content-type lo rifiuta: è un
    // 415 che NON parla del parametro, e cercarlo nei dati sarebbe tempo perso.
    return '415: il content-type non è accettato. Su una POST senza corpo CAP manda '
      + '`application/x-www-form-urlencoded` (vedi gli header inviati): non è il parametro a essere '
      + 'sbagliato. Chiedere a IS quale content-type attende, oppure provare '
      + 'ORDER_STATUS_POST_SHAPE=fm, che manda un corpo JSON';
  }
  if (st === 400) {
    return '400: la richiesta è arrivata ed è stata rifiutata — è la forma del parametro o il suo '
      + 'valore, non l\'indirizzo. Controprova: ORDER_STATUS_POST_SHAPE=noq (valore senza apici)';
  }
  if (st === 503) {
    // In locale è la normalità: i path /gw/odata non sono pubblicati sulla destination interna.
    return '503: NON è l\'iFlow. Al service root non ha risposto nessuno — destination '
      + 'MARS_SAP_CON, Cloud Connector, o l\'host che non pubblica i path /gw/odata (in locale è la '
      + 'normalità: la sonda va lanciata dall\'ambiente CF)';
  }
  if (st >= 500) {
    return `${st}: l'iFlow è stato raggiunto ed è esploso DENTRO. Da qui non si va oltre senza il `
      + 'Message Monitoring';
  }
  if (st === 0) {
    return 'nessuno stato upstream: la chiamata non è nemmeno arrivata (destination, auth o rete)';
  }
  return `${st}`;
}

/**
 * Lettura del 403, che su Cloud Integration ha due cause distinte e rimedi opposti. Il discriminante
 * è se il token CSRF è stato davvero ottenuto: se sì, il CSRF non c'entra.
 */
function diagnose403(r) {
  if (!r.csrf) {
    return '403 con fetch CSRF DISATTIVATO: se il runtime protegge l\'adapter sender questo 403 è '
      + 'atteso. Riprovare con ORDER_STATUS_POST_CSRF=on';
  }
  if (r.csrfTokenObtained) {
    return '403 col token CSRF OTTENUTO: NON è CSRF. E\' autorizzazione, tipicamente il ruolo '
      + 'ESBMessaging.send mancante sul client della destination';
  }
  return '403 e token CSRF NON ottenuto: respinta anche la richiesta di fetch. Guardare '
    + 'l\'autorizzazione del client (ESBMessaging.send) prima del payload';
}

/**
 * Il verdetto come blocco leggibile: esito, mossa, caso, poi i fatti UNO PER RIGA. Stesso formato di
 * dalle altre sonde, perché è lo stesso `_printVerdetto` del cockpit a renderlo.
 */
function comporreVerdetto({ esito, mossa, caso, fatti }) {
  const righe = [`ESITO  ${esito}`, `MOSSA  ${mossa}`, `CASO   ${caso}`];
  for (const f of fatti) righe.push(`  · ${f}`);
  return righe.join('\n');
}

/**
 * Legge la tabella al posto di chi la guarda, ed è scritto per essere girato al team Integration così
 * com'è: nomina le due chiamate, cosa hanno risposto e cosa serve adesso.
 *
 * @param {object[]} rows le righe delle varianti già eseguite
 * @param {object}   cfg  la configurazione effettiva
 * @param {boolean}  full se è stata eseguita la scala completa
 */
function verdict(rows, cfg, full) {
  const by = (id) => rows.find((r) => r.id === id) || {};
  const principali = CALLS.map((c) => ({ call: c, r: by(`${c.id}.${cfg.shape}`) || {} }))
    .map((x) => (x.r.id ? x : { call: x.call, r: by(`${x.call.id}.qs`) || {} }));

  const fatti = [];
  for (const { call, r } of principali) {
    if (!r.id) {
      fatti.push(`${call.functionImport}: non eseguito`);
      continue;
    }
    const testa = `${call.functionImport} (${call.fm}, foglio ${call.sheet})`;
    if (r.depth === 'ESEGUITO') {
      fatti.push(`${testa}: ESEGUITO — SAP ha risposto senza errori. ${r.messageText || ''}`.trim());
    } else if (r.depth === 'FM') {
      fatti.push(`${testa}: FM RAGGIUNTA — ${r.messageType || '?'} `
        + `${r.messageId} ${r.messageNumber} «${r.messageText || 'senza testo'}»`
        + ` · messaggio trovato in ${r.responseShape}`);
    } else {
      fatti.push(`${testa}: ${r.depth === 'IFLOW' ? 'IFLOW SI\', FM NO' : 'NON RAGGIUNTO'} — `
        + `${perche(r)}${r.mplId ? ` · MPL ID ${r.mplId}` : ''}`);
    }
  }

  // I controlli, solo se sono stati eseguiti e solo se dicono qualcosa che le principali non dicono.
  if (full) {
    for (const c of CALLS) {
      const met = by(`${c.id}.meta`);
      if (met.ok) {
        fatti.push(`${c.id}.meta: il $metadata RISPONDE — Function Import dichiarati: `
          + `${met.functionImports || '(nessuno)'}; parametri: ${met.params || '(nessuno)'}. `
          + 'L\'indirizzo è ispezionabile dall\'esterno, contrariamente a quanto vale per la BOM');
      }
      const noq = by(`${c.id}.noq`);
      const par = by(`${c.id}.qs`);
      if (noq.ok && !par.ok) {
        fatti.push(`${c.id}: il valore NUDO passa e quello fra apici no — gli apici dei literal `
          + 'OData arrivano dentro il valore, l\'iFlow non li spacchetta. Leva permanente: '
          + 'ORDER_STATUS_POST_SHAPE=noq');
      }
      const fm = by(`${c.id}.fm`);
      if (fm.ok && !par.ok) {
        fatti.push(`${c.id}: la busta della FM nel CORPO passa e la query string no — l'indirizzo è `
          + 'un HTTPS sender piatto, com\'è finita per il movimento merci. Leva: '
          + 'ORDER_STATUS_POST_SHAPE=fm');
      }
    }
  }

  const caso = `ordine ${cfg.orderId} (${cfg.orderForced ? 'ORDER_STATUS_POST_ORDER — POTENZIALMENTE '
    + 'VERO' : 'mock, inesistente'}) · forma ${cfg.shape} · csrf ${cfg.csrf ? 'on' : 'off'} · `
    + `${full ? 'scala completa' : 'giro normale'} · destination ${cfg.destination}`;

  const eseguiti = principali.filter((x) => x.r.depth === 'ESEGUITO');
  const raggiunti = principali.filter((x) => x.r.depth === 'FM');
  const iflow = principali.filter((x) => x.r.depth === 'IFLOW');

  // 1. Il caso che va fermato, e va detto per primo.
  if (eseguiti.length) {
    const nomi = eseguiti.map((x) => x.call.functionImport).join(' e ');
    return comporreVerdetto({
      esito: `ALLARME — ${nomi} ha risposto SENZA ERRORI su ${cfg.orderId}. Con un ordine `
        + 'inesistente non è un esito possibile: o quell\'ordine esiste, e allora è stato chiuso '
        + 'davvero, oppure l\'iFlow risponde OK senza chiamare la FM',
      mossa: `verificare SUBITO in SAP lo stato dell'ordine ${cfg.orderId}, e spegnere la sonda con `
        + 'ORDER_STATUS_POST=off finché non è chiaro quale dei due casi è',
      caso,
      fatti
    });
  }

  // 2. Il risultato che la sonda cerca.
  if (raggiunti.length === CALLS.length) {
    return comporreVerdetto({
      esito: 'ENTRAMBE LE CHIAMATE ARRIVANO ALLA FM: l\'integrazione funziona. Su un ordine '
        + 'inesistente un messaggio d\'errore applicativo è la prova che il messaggio ha '
        + 'attraversato l\'iFlow ed è stato eseguito in ECC',
      mossa: 'il canale è dimostrato: si può progettare il flusso di chiusura. Prima di puntarlo su '
        + 'ordini veri, chiedere a IS un IV_TEST_RUN sulle due FM',
      caso,
      fatti
    });
  }
  if (raggiunti.length) {
    return comporreVerdetto({
      esito: `SOLO ${raggiunti.map((x) => x.call.functionImport).join(' e ')} arriva alla FM: `
        + 'l\'altra no. I due indirizzi sono iFlow distinti e possono essere in stati diversi',
      mossa: 'girare a IS la riga dell\'indirizzo che non risponde, con il suo MPL ID: la differenza '
        + 'fra i due flussi è tutta da loro',
      caso,
      fatti
    });
  }

  // 3. Non ci si arriva.
  if (principali.some((x) => isQueryGuard(x.r))) {
    return comporreVerdetto({
      esito: 'LE RICHIESTE MUOIONO NELLA GUARDIA DELL\'IFLOW: la query string non è stata '
        + 'accettata, e nessuna funzione ABAP è stata chiamata',
      mossa: full
        ? 'girare a IS le righe con l\'MPL ID: GetQueryFilter.groovy rifiuta la richiesta prima di '
          + 'leggerne i parametri'
        : 'window.orderStatusPost(true) — la scala completa dice se l\'indirizzo vuole il parametro '
          + 'nel corpo invece che in query string',
      caso,
      fatti
    });
  }
  if (iflow.length) {
    return comporreVerdetto({
      esito: 'L\'IFLOW PRENDE IN CARICO MA LA FM NON RISPONDE: si è dentro Cloud Integration e non '
        + 'si arriva a ECC, oppure la FM non esiste ancora a sistema (le due ZMARS_PROD_ORDER_* '
        + 'sono dichiarate PROPOSTE nel contratto)',
      mossa: `girare a IS gli MPL ID: ${principali.map((x) => x.r.mplId).filter(Boolean).join(', ')
        || '(nessuno)'} — aprono l'esecuzione fallita nel Message Monitoring`,
      caso,
      fatti
    });
  }
  return comporreVerdetto({
    esito: 'NESSUNA DELLE DUE CHIAMATE RAGGIUNGE L\'INDIRIZZO',
    mossa: principali.some((x) => x.r.httpStatus === 503)
      ? 'la sonda va lanciata dall\'ambiente CF: in locale la destination non pubblica i path '
        + '/gw/odata (0013, flusso E)'
      : 'verificare che i due iFlow siano deployati e che i path siano ancora quelli del foglio. '
        + 'Leve: ORDER_STATUS_POST_CLOSE_PATH, ORDER_STATUS_POST_TECO_PATH',
    caso,
    fatti
  });
}

// ---------------------------------------------------------------------------------------------
// CONFIGURAZIONE
// ---------------------------------------------------------------------------------------------

/**
 * [ORDER-COMPLETE] IL TRASPORTO, SENZA I CAMPI DI SOLA SONDA (feature 0045).
 *
 * Indirizzi, Function Import, forma del parametro, CSRF, timeout e destination sono le stesse cose
 * per la sonda del cockpit e per il flusso d'esercizio del job `ORDER_COMPLETE`, e vivono qui in un
 * punto solo. Restano FUORI da questa funzione i campi che sono della SONDA e di nessun altro:
 * `orderId` (l'ordine di mock), `full` e `metadata` (la scala di controlli).
 *
 * `orderId` in particolare NON deve poter arrivare all'esercizio: e' `999999999999`, e prenderlo da
 * qui significherebbe scrivere sull'ordine sbagliato senza nessun errore — la stessa regola, con la
 * stessa motivazione, di prodOrderConfPost.js:1911-1913.
 *
 * `enabled` STA FUORI, e la storia va detta perche' e' cambiata due volte. `ORDER_STATUS_POST` e'
 * la leva DI PROCESSO che mta.yaml tiene a `off` in produzione, e la 0045 l'aveva fatta governare
 * ANCHE la scrittura del job, sul modello di `PRODCONF_POST` (DEC-94). Dalla 0046 non piu': quando
 * un job batch parte dallo scheduler DEVE scrivere, e una leva che richiede un rilascio rendeva
 * falsa quella richiesta — in produzione il job avrebbe rilevato i completamenti e non ne avrebbe
 * mandato nessuno, in verde. L'unico interruttore dei due flussi d'esercizio e' ora la casella PER
 * PLANT del customizing (`ZProdOrderCompleteConfig.IsEnabled`,
 * `ZProdOrderScheduledConfig.IsEnabled`), che non richiede un rilascio.
 * `ORDER_STATUS_POST` torna quindi a essere cio' che era: la leva della SONDA del cockpit, e di
 * nient'altro.
 */
function readTransportConfig() {
  const fromCds = (cds.env.requires && cds.env.requires[BASE] && cds.env.requires[BASE].post) || {};
  const cfg = { ...DEFAULTS, ...fromCds };
  // I due indirizzi sono un oggetto annidato: uno spread superficiale li sostituirebbe in blocco, e
  // un `post` che ne dichiarasse uno solo cancellerebbe l'altro.
  cfg.calls = {
    close: { ...DEFAULTS.calls.close, ...((fromCds.calls || {}).close || {}) },
    teco: { ...DEFAULTS.calls.teco, ...((fromCds.calls || {}).teco || {}) }
  };

  const isOff = (v) => ['off', 'false', '0', 'no'].includes(String(v).trim().toLowerCase());
  const set = (name) => process.env[name] !== undefined && String(process.env[name]).trim() !== '';

  if (set('ORDER_STATUS_POST_CSRF')) cfg.csrf = !isOff(process.env.ORDER_STATUS_POST_CSRF);
  // Solo i valori previsti: un refuso non deve tradursi silenziosamente nella forma sbagliata, che è
  // precisamente il genere di errore che costa un giro di collaudo per capirlo.
  if (set('ORDER_STATUS_POST_SHAPE')) {
    const s = String(process.env.ORDER_STATUS_POST_SHAPE).trim().toLowerCase();
    if (SHAPES.includes(s)) cfg.shape = s;
    else {
      console.warn(`>>> [ORDER-STATUS-POST] ORDER_STATUS_POST_SHAPE='${s}' non riconosciuta `
        + `(valori ammessi: ${SHAPES.join(', ')}): resta '${cfg.shape}'`);
    }
  }
  for (const c of CALLS) {
    const K = c.key.toUpperCase();
    if (set(`ORDER_STATUS_POST_${K}_PATH`)) {
      cfg.calls[c.key].path = String(process.env[`ORDER_STATUS_POST_${K}_PATH`]).trim();
    }
    if (set(`ORDER_STATUS_POST_${K}_FI`)) {
      cfg.calls[c.key].functionImport = String(process.env[`ORDER_STATUS_POST_${K}_FI`]).trim();
    }
  }

  // [IS-EGRESS] Come esce la chiusura da questo processo. Dal 27/08/2026 questo modulo E' nel
  // perimetro del canale batch: un run batch non ha un utente collegato, quindi su una destination a
  // propagazione utente le sue chiamate non possono funzionare a regime — la stessa ragione delle
  // letture e delle POST (DEC-98). Dal server web, cioe' dalla sonda del cockpit, resta tutto
  // com'era: la destination configurata.
  //
  // La riga qui sotto e' sorvegliata LETTERALMENTE da test/isEgress.test.js: non si sposta e non si
  // riscrive in un'altra forma.
  const eg = resolveEgress(process.env, { destination: cfg.destination });
  cfg.destination = eg.destination;
  cfg.egressWhy = eg.why;

  // `enabled` SI CANCELLA, e non basta smettere di leggere la variabile d'ambiente: `DEFAULTS` lo
  // porta a `true`, quindi un campo con quel nome resterebbe nella config del trasporto e il primo
  // che lo trova lo userebbe come se fosse la leva. Cancellarlo rende impossibile leggerlo per
  // sbaglio: chi ne ha bisogno passa da `readPostConfig`, cioe' e' la sonda.
  delete cfg.enabled;
  return cfg;
}

/**
 * Config della SONDA: il trasporto piu' i campi che sono suoi e di nessun altro.
 *
 * `enabled` E' FRA QUESTI, dalla 0046: `ORDER_STATUS_POST` spegne la SONDA e nient'altro. I due
 * flussi d'esercizio non la leggono — vedi la testata di `readTransportConfig` — e questa e' la
 * riga che glielo impedisce, perche' quel campo non esiste piu' nella config del trasporto.
 *
 * `orderId` da env è la LEVA D'EMERGENZA: punta la sonda su un ordine vero, e quindi lo CHIUDE.
 * `orderForced` dice se è stata usata, così il log può dichiararlo invece di mostrare un numero.
 */
function readPostConfig() {
  const cfg = readTransportConfig();

  const isOff = (v) => ['off', 'false', '0', 'no'].includes(String(v).trim().toLowerCase());
  const set = (name) => process.env[name] !== undefined && String(process.env[name]).trim() !== '';

  // `readTransportConfig` lo cancella di proposito: qui torna, perche' qui e' la leva della sonda.
  const fromCds = (cds.env.requires && cds.env.requires[BASE] && cds.env.requires[BASE].post) || {};
  cfg.enabled = fromCds.enabled === undefined ? DEFAULTS.enabled : !!fromCds.enabled;
  if (set('ORDER_STATUS_POST')) cfg.enabled = !isOff(process.env.ORDER_STATUS_POST);
  if (set('ORDER_STATUS_POST_FULL')) cfg.full = !isOff(process.env.ORDER_STATUS_POST_FULL);
  if (set('ORDER_STATUS_POST_METADATA')) cfg.metadata = !isOff(process.env.ORDER_STATUS_POST_METADATA);

  cfg.orderForced = set('ORDER_STATUS_POST_ORDER');
  if (cfg.orderForced) cfg.orderId = String(process.env.ORDER_STATUS_POST_ORDER).trim();

  return cfg;
}

// ---------------------------------------------------------------------------------------------
// TRASPORTO
// ---------------------------------------------------------------------------------------------

/** JSON leggibile senza mai lanciare, qualunque cosa sia arrivata dal remoto. */
function safeStringify(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const BODY_MAX = 4000;

/** Il corpo ricevuto, troncato: un EDMX intero non serve a nessuno in console. */
function sample(body) {
  const s = typeof body === 'string' ? body : safeStringify(body);
  return s.length > BODY_MAX ? `${s.slice(0, BODY_MAX)}… (troncato)` : s;
}

/**
 * Header mascherati e già serializzati: escono verso il browser, quindi `authorization` e i cookie
 * di sessione non passano di lì.
 *
 * `reveal` esiste per UN caso: `x-csrf-token` IN RISPOSTA. Quando il runtime rifiuta per CSRF quel
 * campo vale letteralmente `Required` — è la diagnosi, non un segreto, e mascherarlo nasconderebbe
 * l'unica prova conclusiva. In RICHIESTA resta mascherato: lì è un token di sessione vero.
 */
function maskHeaders(h, { reveal = [] } = {}) {
  if (!h || typeof h !== 'object') return '';
  const keep = new Set(reveal.map((k) => k.toLowerCase()));
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const secret = /authorization|apikey|api-key|cookie|token/i.test(k) && !keep.has(k.toLowerCase());
    out[k] = secret ? '***MASKED***' : v;
  }
  return safeStringify(out);
}

/**
 * Un'istanza per SERVICE ROOT, memoizzata sul path. I due endpoint sono due indirizzi distinti,
 * quindi due istanze: è lo schema con cui isRemoteSource.js:206 istanzia i 15 service root
 * dell'Integration Suite a partire dallo stesso CSN.
 *
 * `csrf` viaggia FRA LE OPZIONI e non dentro `credentials`: CAP lo legge da `service.options` e
 * `cds.connect.to` fa un merge superficiale `{...conf, ...opts}`, quindi questa leva scavalca
 * package.json. Il valore è letto una volta sola: cambiarlo richiede un restart.
 */
const istanze = new Map();
function connect(cfg, path) {
  const chiave = `${path}|${cfg.csrf ? 'csrf' : 'nocsrf'}`;
  if (!istanze.has(chiave)) {
    // [IS-EGRESS] Nessun gancio `before('*')` su queste istanze: fino al 28/08/2026 ce n'era uno che
    // fondeva l'header applicativo, ora rimosso da ogni canale. Da qui escono le chiamate
    // d'esercizio dei DUE job che scrivono uno stato utente — `close` per ORDER_COMPLETE (0045) e
    // `teco` per ORDER_SCHEDULED (0046) — piu' il `$metadata` e le varianti della sonda del
    // cockpit, e l'unica cosa che le distingue è la `destination`, già risolta dentro `cfg`.
    istanze.set(chiave, cds.connect.to(BASE, {
      csrf: cfg.csrf,
      credentials: {
        destination: cfg.destination,
        path,
        requestTimeout: cfg.requestTimeout
      }
    }).catch((e) => { istanze.delete(chiave); throw e; }));
  }
  return istanze.get(chiave);
}

/**
 * Cosa dichiara il `$metadata`: i Function Import e i loro parametri. Regex e non parser XML —
 * serve un nome, non un albero, e una sonda non deve portarsi una dipendenza. Pura, quindi
 * collaudabile. Sull'entity type non si guarda niente: qui non ci sono entity set in gioco, ed è
 * l'errore che il parser di prodOrderConfPost.js farebbe (la sonda della distinta l'aveva già risolto).
 */
function readMetadata(body) {
  const s = typeof body === 'string' ? body : '';
  const all = (re) => [...new Set([...s.matchAll(re)].map((m) => m[1]).filter(Boolean))];
  return {
    functions: all(/<FunctionImport\s[^>]*?Name="([^"]+)"/g),
    params: all(/<Parameter\s[^>]*?Name="([^"]+)"/g)
  };
}

/** Riga vuota con tutti i campi: la forma della risposta non deve dipendere dal ramo percorso. */
function emptyRow(id, what) {
  return {
    id,
    what: what || '',
    call: '',
    fm: '',
    sheet: '',
    method: '',
    request: '',
    url: '',
    requestBody: '',
    requestHeaders: '',
    httpStatus: null,
    httpOk: false,
    ok: false,
    depth: '',
    alarm: false,
    messageType: '',
    messageId: '',
    messageNumber: '',
    messageText: '',
    messageCount: 0,
    responseShape: '',
    // [ORDER-COMPLETE] I quattro campi su cui `classifyOrderClose` decide, dichiarati qui perche' la
    // forma della riga non deve dipendere dal ramo percorso — e `sent: false` non e' `ok: false`:
    // la prima dice «non e' partito niente», la seconda «e' partito e non e' andato».
    //
    // [ORDER-SCHEDULED] Dalla 0046 `sent` e' SEMPRE vero sul percorso d'esercizio, perche' la leva
    // che poteva fermare la chiamata prima di partire non c'e' piu'. Il campo resta perche' lo
    // legge la SONDA, dove una variante puo' non essere eseguita, e perche' una forma di riga che
    // cambia in base al chiamante e' il difetto che `emptyRow` esiste per evitare.
    sent: false,
    emptyMessage: false,
    odataError: false,
    queryGuard: false,
    functionImports: '',
    params: '',
    correlationId: '',
    mplId: '',
    csrf: false,
    csrfTokenObtained: false,
    responseHeaders: '',
    responseBody: '',
    // ---- lo scambio CRUDO, dal tap sulla risposta ([IS-CALL-LOG]) --------------------
    // `responseBody` qui sopra e' la risposta DOPO `_purgeODataV2` di CAP, che il wrapper `d` lo
    // TOGLIE quando c'e' (remote/utils/client.js:120-124): da quello non si puo' dedurre in che
    // forma abbia risposto l'Integration Suite, ed e' esattamente cio' che stiamo cercando di
    // sapere su questi due Function Import. Questi campi sono cio' che e' arrivato davvero.
    rawSeen: false,          // il tap ha agganciato? false = NON MISURATO, non «vuoto»
    rawStatus: 0,            // stato HTTP reale, anche sulle riuscite
    responseContentType: '', // JSON OData o XML convertito, senza interpretare niente
    rawHasD: false,          // wrapper `d` presente: un dato, non un'ipotesi
    rawBody: '',             // il corpo prima di qualunque normalizzazione
    reason: '',
    error: '',
    ms: 0,
    // Campi di RUN: valorizzati sulla riga di testata, vuoti sulle varianti.
    enabled: true,
    orderId: '',
    orderForced: false,
    orderSource: '',
    shape: '',
    full: false,
    destination: '',
    sentAt: ''
  };
}

/**
 * Esegue una variante. NON LANCIA: l'esito, qualunque sia, è una riga della tabella.
 */
async function runVariant(cfg, v) {
  const r = emptyRow(v.id, v.what);
  Object.assign(r, {
    call: v.fi,
    fm: v.call.fm,
    sheet: v.call.sheet,
    method: v.method,
    request: `${v.path}${v.suffix ? `/${v.suffix}` : '/'}`,
    requestBody: v.body ? JSON.stringify(v.body, null, 2) : '',
    csrf: !!cfg.csrf,
    correlationId: (cds.context && cds.context.id) || ''
  });

  // [IS-CALL-LOG] Il contesto del tap sulla risposta: e' dentro `within` che il wrapper del client
  // HTTP sa a quale chiamata attribuire lo scambio crudo. `begin()` torna `null` a traccia spenta e
  // `within()` in quel caso esegue e basta, quindi non serve ramificare.
  const rec = Log.begin();
  const t0 = Date.now();
  try {
    const srv = await connect(cfg, v.path);
    const res = await Log.within(rec, () => srv.send({
      method: v.method,
      path: v.suffix ? `/${v.suffix}` : '/',
      ...(v.body ? { data: v.body } : {}),
      ...(v.accept ? { headers: { accept: v.accept } } : {})
    }));
    // Su una chiamata riuscita gli header echeggiati non ci sono: che il token sia stato ottenuto è
    // un'INFERENZA (il fetch è attivo e la POST è passata), non un fatto letto. Sull'errore, invece,
    // si legge dagli header davvero partiti — ed è lì che serve, perché è lì che discrimina il 403.
    r.csrfTokenObtained = r.csrf && v.method !== 'GET';
    r.httpOk = true;
    r.responseBody = sample(res);

    if (v.kind === 'meta') {
      const md = readMetadata(res);
      r.functionImports = md.functions.join(', ').slice(0, 500);
      r.params = md.params.join(', ').slice(0, 500);
      r.ok = true;
      r.depth = 'IFLOW';
      r.reason = md.functions.length
        ? `il root dichiara ${md.functions.length} Function Import`
        : 'ha risposto, ma nessun Function Import dichiarato nel documento';
    } else {
      // HTTP 2xx non basta: l'esito è il messaggio applicativo.
      const o = readOutcome(res);
      Object.assign(r, {
        messageType: o.messageType,
        messageId: o.messageId,
        messageNumber: o.messageNumber,
        messageText: o.messageText,
        messageCount: o.messageCount,
        responseShape: o.responseShape,
        reason: o.reason,
        alarm: o.done
      });
      r.depth = depthOf(r);
      r.ok = r.depth === 'FM' || r.depth === 'ESEGUITO';
      if (!o.reached && o.emptyMessage) {
        // Il guscio c'è e i valori no: la FM è stata invocata, la risposta è stata costruita, e il
        // riempimento si è perso. Non è lo stesso caso di sotto e non va raccontato come tale.
        r.reason = `HTTP 2xx e ${o.reason} Su un ordine inesistente la FM produce un errore `
          + 'applicativo: qui la sua sede esiste ed è vuota, quindi il messaggio è stato prodotto e '
          + 'non trasferito. Da girare a IS: il response mapping deve valorizzare i campi, non solo '
          + 'dichiararli.';
      } else if (!o.reached) {
        // 200 senza messaggio: è il caso peggiore, perché non sembra un fallimento.
        r.reason = `HTTP 2xx ma ${o.reason} Su un ordine inesistente un errore applicativo è `
          + 'l\'esito atteso: la sua assenza dice che la FM non è stata chiamata, oppure che ha '
          + 'ricevuto un valore che non ha cercato.';
      }
    }
  } catch (e) {
    // e.statusCode è 502 per QUALUNQUE fallimento: lo normalizza CAP. Quello vero è annidato nella
    // causa, ed è lì che sta anche l'intero scambio.
    r.httpStatus = upstreamStatus(e) || 0;
    r.error = errorText(e).slice(0, 2000);
    const reason = (e && e.reason) || {};
    if (reason.request) {
      if (reason.request.url) r.url = reason.request.url;
      // Gli header ECHEGGIATI sono quelli davvero partiti: se il middleware ha ottenuto il token,
      // `x-csrf-token` è fra questi. E' l'unico modo di sapere se il fetch è riuscito, dato che il
      // Cloud SDK in caso contrario prosegue in silenzio.
      const sent = reason.request.headers || {};
      r.csrfTokenObtained = Object.keys(sent).some((k) => k.toLowerCase() === 'x-csrf-token');
      r.requestHeaders = maskHeaders(sent);
    }
    if (reason.response) {
      r.responseHeaders = maskHeaders(reason.response.headers, { reveal: ['x-csrf-token'] });
      r.responseBody = sample(reason.response.body);
      r.mplId = extractMplId(reason.response.body);
      // Anche su errore HTTP l'iFlow può aver risposto col messaggio applicativo: se c'è, dirlo vale
      // più del codice HTTP, perché è la prova che la FM è stata eseguita.
      const o = readOutcome(reason.response.body);
      if (o.messageCount) {
        Object.assign(r, {
          messageType: o.messageType,
          messageId: o.messageId,
          messageNumber: o.messageNumber,
          messageText: o.messageText,
          messageCount: o.messageCount,
          responseShape: o.responseShape
        });
      }
    }
    if (!r.mplId) r.mplId = extractMplId(r.error);
    r.depth = depthOf(r);
    r.ok = r.depth === 'FM';
    if (!r.reason) r.reason = perche(r);
  }

  // [IS-CALL-LOG] Lo scambio crudo, su ENTRAMBI i rami: su una riuscita e' l'unico modo di sapere
  // in che forma ha risposto l'iFlow, su un errore conferma lo stato reale senza passare dal 502
  // che CAP normalizza. Se il tap non ha agganciato, `rawSeen` resta falso e la riga lo dichiara.
  if (rec && rec.rawSeen) {
    r.rawSeen = true;
    r.rawStatus = rec.httpStatus || 0;
    r.responseContentType = rec.responseContentType || '';
    r.rawHasD = !!rec.rawHasD;
    r.rawBody = rec.rawBody || '';
  }
  r.ms = Date.now() - t0;
  return r;
}

/** Lo scambio completo sul log del server: è ciò che si gira al team Integration. */
function logProbe(rows, cfg, full) {
  const T = '>>> [ORDER-STATUS-POST]';
  const testa = rows[0] || {};
  if (testa.id === 'OFF') {
    console.warn(`${T} ${testa.what}`);
    return;
  }
  console.log(`${T} ====================================================`);
  for (const riga of String(testa.what || '').split('\n')) console.log(`${T} ${riga}`);
  // [IS-EGRESS] Su quale canale sono uscite: destination effettiva e il perché di quella e non
  // dell'altra. Senza questa riga «HTTP 401» e «HTTP 500» dalla chiusura tecnica non dicono da quale
  // delle due destination la chiamata è partita.
  console.log(`${T} destination ${cfg.destination}`
    + `${cfg.egressWhy ? ` [${cfg.egressWhy}]` : ''}`);
  console.log(`${T} ----------------------------------------------------`);
  for (const r of rows.slice(1)) {
    const capo = `${r.id} [${r.depth || '-'}] ${r.method} ${r.request}`;
    if (r.ok && !r.alarm) {
      console.log(`${T} OK  ${capo} · ${r.ms} ms · ${r.reason}`);
      continue;
    }
    console.error(`${T} KO  ${capo}${r.httpStatus ? ` · HTTP ${r.httpStatus}` : ''} · ${r.ms} ms`);
    if (r.reason) console.error(`${T}     ${r.reason}`);
    if (r.mplId) {
      console.error(`${T}     MPL ID: ${r.mplId} — con questo il team Integration apre `
        + 'l\'esecuzione fallita nel monitor di Cloud Integration. Da citare col correlation id');
    }
    if (r.error) console.error(`${T}     errore: ${r.error}`);
    if (r.requestBody) console.error(`${T}     body inviato:\n${r.requestBody}`);
    if (r.requestHeaders) console.error(`${T}     header inviati:\n${r.requestHeaders}`);
    if (r.responseHeaders) console.error(`${T}     header ricevuti:\n${r.responseHeaders}`);
    console.error(`${T}     body ricevuto:\n${r.responseBody || '(vuoto)'}`);
  }
  if (rows.some((r) => r.alarm)) {
    console.error(`${T} >>> ALLARME: una delle due chiamate ha risposto SENZA ERRORI su `
      + `${cfg.orderId}. Verificare SUBITO lo stato dell'ordine in SAP e spegnere la sonda con `
      + 'ORDER_STATUS_POST=off.');
  }
  if (!full) {
    console.log(`${T} giro normale: ${CALLS.length} chiamate. La scala completa (controlli sugli `
      + 'apici, sul corpo e sul $metadata) è ORDER_STATUS_POST_FULL=on oppure '
      + 'window.orderStatusPost(true) dal cockpit.');
  }
  console.log(`${T} ====================================================`);
}

/**
 * LA SONDA. Manda le due POST e restituisce la tabella. NON LANCIA MAI: un fallimento deve mostrare
 * il proprio scambio, non diventare un 500 in faccia a chi l'ha lanciata.
 *
 * @param {boolean} [fullArg] scala completa; se omesso vale la configurazione
 * @returns {Promise<object[]>} riga 0 = VERDETTO (o OFF), poi una riga per variante
 */
async function postProdOrderStatus(fullArg) {
  const cfg = readPostConfig();
  const full = fullArg === undefined ? !!cfg.full : !!fullArg;
  const sentAt = new Date().toISOString();

  if (!cfg.enabled) {
    const off = emptyRow('OFF', 'chiamate DISATTIVATE (ORDER_STATUS_POST=off oppure '
      + `cds.requires.${BASE}.post.enabled=false): niente è stato inviato`);
    off.enabled = false;
    off.sentAt = sentAt;
    logProbe([off], cfg, full);
    return [off];
  }

  // [IS-CALL-LOG] Il tap sulla risposta, prima di qualunque chiamata: da qui in poi ogni scambio
  // porta stato reale, content-type e corpo CRUDO. Idempotente — se una sorgente d'area l'ha già
  // installato non fa nulla.
  Log.installResponseTap();

  const rows = [];
  // Sequenziali di proposito: due POST in parallelo sullo stesso tenant CPI si mescolano nel
  // Message Monitoring, e la sonda esiste per essere letta da lì.
  for (const v of variantsFor(cfg, full)) rows.push(await runVariant(cfg, v));

  const testa = emptyRow('VERDETTO', verdict(rows, cfg, full));
  Object.assign(testa, {
    orderId: cfg.orderId,
    orderForced: !!cfg.orderForced,
    orderSource: cfg.orderForced
      ? 'ORDER_STATUS_POST_ORDER (leva d\'emergenza: se l\'ordine esiste, viene CHIUSO davvero)'
      : 'mock: ordine inesistente, SAP non ha nulla da chiudere',
    shape: cfg.shape,
    full,
    csrf: !!cfg.csrf,
    destination: cfg.destination,
    alarm: rows.some((r) => r.alarm),
    ok: rows.some((r) => r.ok),
    correlationId: (cds.context && cds.context.id) || '',
    sentAt
  });

  const out = [testa, ...rows];
  logProbe(out, cfg, full);
  return out;
}

// ---------------------------------------------------------------------------------------------
// [ORDER-COMPLETE] [ORDER-SCHEDULED] L'ESERCIZIO — uno stato utente su UN ordine vero
// (feature 0045, generalizzata dalla 0046)
// ---------------------------------------------------------------------------------------------

/**
 * Imposta uno stato utente su UN ordine di produzione SAP.
 *
 * Serve DUE flussi, e l'unica cosa che li distingue e' `call`:
 *   'close'  ->  `CloseOrder`       ->  «il lotto e' finito»      (job ORDER_COMPLETE, 0045)
 *   'teco'   ->  `TechlyCmpltOrder` ->  «il lotto e' pianificato» (job ORDER_SCHEDULED, 0046)
 *
 * ⚠️ IL NOME DEL SECONDO INDIRIZZO MENTE, E VA SAPUTO. `TechlyCmpltOrder` e
 * `ZMARS_PROD_ORDER_TECO` si chiamano cosi' perche' nascevano come chiusura tecnica; dal 02/09/2026
 * la RFC dietro quell'iFlow e' stata corretta e scrive lo stato utente `Scheduled`. Il nome non lo
 * dice, e chi legge questo file fra sei mesi pensa alla chiusura tecnica: e' per questo che la
 * voce `teco` di `CALLS` ha il suo avvertimento, e che
 * srv/external/PROD_ORDER_STATUS_POST_IS.md e' stato corretto.
 *
 * ============================================================================
 * ⛔ UNA SOLA CHIAMATA, E `variantsFor` NON SI USA
 * ============================================================================
 * `variantsFor` itera TUTTE le `CALLS` — `close` **e** `teco` — e nel giro normale produce DUE
 * POST. Riusarla qui manderebbe all'ordine ANCHE lo stato utente dell'altro flusso: un lotto appena
 * pianificato risulterebbe anche finito, e uno finito anche pianificato. Questa funzione compone
 * percio' una variante sola, quella di `call`, e i due test di invio sorvegliano che dal trasporto
 * esca ESATTAMENTE una chiamata e che il suo path sia quello del flusso giusto — un test per
 * flusso, perche' e' l'unico modo di accorgersi di un `call` scambiato.
 *
 * ============================================================================
 * L'ORDINE ARRIVA PER ARGOMENTO, ED E' OBBLIGATORIO
 * ============================================================================
 * `cfg.orderId` e' l'ordine di collaudo della SONDA (`999999999999`): leggerlo da qui
 * significherebbe scrivere sull'ordine sbagliato senza nessun errore. Un argomento mancante e' un
 * difetto di programmazione e LANCIA — e' la stessa scelta, con la stessa motivazione, di
 * `postMaterialDoc` (materialDocPost.js:581-584).
 *
 * Il numero va passato GIA' in formato interno: il riempimento a zeri e'
 * `internalOrderNumber`, che sa distinguere un ordine numerico da uno alfanumerico. Qui non si
 * normalizza niente, perche' un numero riempito male e' un ordine SBAGLIATO e non un ordine non
 * trovato.
 *
 * ============================================================================
 * NESSUNA LEVA DI PROCESSO, E NON LANCIA MAI PER UN ESITO
 * ============================================================================
 * Dalla 0046 questa funzione NON guarda `ORDER_STATUS_POST`: quando un job batch parte, scrive.
 * L'unico interruttore e' la casella per plant del customizing, e la legge il job. Vedi la testata
 * di `readTransportConfig`.
 *
 * Qualunque risposta, rifiuto o guasto e' un valore di ritorno: il chiamante e' un job che deve
 * scrivere lo stato di quella riga e passare all'ordine dopo. La classificazione dell'esito NON
 * avviene qui — sta in `classifyOrderClose`, che e' puro e collaudato — e questa funzione
 * restituisce i fatti su cui quella decide, `depth` compresa.
 *
 * @param {{order: string, call?: 'close'|'teco'}} data l'ordine (obbligatorio, formato interno) e
 *   quale dei due stati utente scrivere; `call` omesso vale `'close'`, per i chiamanti storici
 * @param {{correlationId?: string}} [opts]
 * @returns {Promise<object>} la riga dell'esito
 */
async function postOrderStatus(data, opts = {}) {
  const order = String((data && data.order) || '').trim();
  if (!order) {
    throw new Error('[ORDER-STATUS-POST] postOrderStatus: `order` è obbligatorio. È un difetto di '
      + 'programmazione, non un dato mancante: `cfg.orderId` è l\'ordine di collaudo della sonda e '
      + 'non si usa qui.');
  }
  const key = String((data && data.call) || 'close').trim();
  const call = CALLS.find((c) => c.key === key);
  if (!call) {
    throw new Error(`[ORDER-STATUS-POST] postOrderStatus: \`call\` '${key}' non esiste. `
      + `Ammessi: ${CALLS.map((c) => c.key).join(', ')}.`);
  }

  const cfg = readTransportConfig();
  const conf = (cfg.calls && cfg.calls[key]) || {};
  const path = conf.path || call.path;
  const fi = conf.functionImport || call.functionImport;

  const r = emptyRow(`${call.id}.exercise`, `${call.what} — ordine ${order}`);
  Object.assign(r, {
    call: fi,
    fm: call.fm,
    sheet: call.sheet,
    orderId: order,
    shape: cfg.shape,
    csrf: !!cfg.csrf,
    destination: cfg.destination,
    sentAt: new Date().toISOString(),
    // Il correlation id: in un job `cds.context` non esiste, quindi lo porta il chiamante o lo
    // generiamo qui. E' la chiave con cui il team Integration ritrova il messaggio nel proprio
    // monitor, e senza di essa una segnalazione non e' riconciliabile.
    correlationId: String(opts.correlationId || '').trim()
      || (cds.context && cds.context.id)
      || require('crypto').randomUUID()
  });

  const built = buildCall(cfg.shape === 'noq' ? 'noq' : 'qs', call, fi, order);
  Object.assign(r, {
    sent: true,
    method: built.method,
    request: `${path}/${built.suffix}`,
    requestBody: built.body ? JSON.stringify(built.body, null, 2) : ''
  });

  const t0 = Date.now();
  try {
    const srv = await connect(cfg, path);
    const res = await srv.send({
      method: built.method,
      path: `/${built.suffix}`,
      ...(built.body ? { data: built.body } : {}),
      headers: {
        'x-correlation-id': r.correlationId,
        'x-correlationid': r.correlationId
      }
    });
    r.httpOk = true;
    r.csrfTokenObtained = r.csrf;
    r.responseBody = sample(res);
    const o = readOutcome(res);
    Object.assign(r, {
      messageType: o.messageType,
      messageId: o.messageId,
      messageNumber: o.messageNumber,
      messageText: o.messageText,
      messageCount: o.messageCount,
      responseShape: o.responseShape,
      emptyMessage: !!o.emptyMessage,
      alarm: false,
      reason: o.reason
    });
    r.depth = depthOf({ ...r, alarm: o.done });
  } catch (e) {
    // e.statusCode è 502 per QUALUNQUE fallimento: lo normalizza CAP. Quello vero è annidato nella
    // causa, ed è lì che sta anche l'intero scambio.
    r.httpStatus = upstreamStatus(e) || 0;
    r.error = errorText(e).slice(0, 2000);
    const reason = (e && e.reason) || {};
    if (reason.request) {
      if (reason.request.url) r.url = reason.request.url;
      const sent = reason.request.headers || {};
      r.csrfTokenObtained = Object.keys(sent).some((k) => k.toLowerCase() === 'x-csrf-token');
      r.requestHeaders = maskHeaders(sent);
    }
    if (reason.response) {
      r.responseHeaders = maskHeaders(reason.response.headers, { reveal: ['x-csrf-token'] });
      r.responseBody = sample(reason.response.body);
      r.mplId = extractMplId(reason.response.body);
      // Anche su errore HTTP l'iFlow può aver risposto col messaggio applicativo: se c'è, dirlo vale
      // più del codice HTTP, perché è la prova che la FM è stata eseguita.
      const o = readOutcome(reason.response.body);
      if (o.messageCount) {
        Object.assign(r, {
          messageType: o.messageType,
          messageId: o.messageId,
          messageNumber: o.messageNumber,
          messageText: o.messageText,
          messageCount: o.messageCount,
          responseShape: o.responseShape
        });
      }
      r.emptyMessage = !o.messageCount && findEmptyMessageShape(reason.response.body).found;
    }
    if (!r.mplId) r.mplId = extractMplId(r.error);
    r.depth = depthOf(r);
    if (!r.reason) r.reason = perche(r);
  }
  // `isODataError` legge il corpo: un 404 con `{"error":…}` e `dataserviceversion` dimostra che il
  // servizio ha ELABORATO la richiesta, cioe' che la FM e' girata. E' il discriminante fra un
  // rifiuto e un «non partito», e chi classifica l'esito ne ha bisogno.
  r.odataError = isODataError(r);
  r.queryGuard = isQueryGuard(r);
  r.ms = Date.now() - t0;
  return r;
}

/**
 * Alias storico del flusso `close`, per i chiamanti nati con la 0045.
 *
 * NON e' zucchero: `test/orderCompleteSend.test.js` verifica su questo nome, e quel test e' il
 * presidio contro la doppia chiamata. Tenerlo significa che l'estrazione della 0046 si dimostra
 * lasciando quel test invariato.
 */
async function postOrderClose(data, opts = {}) {
  return postOrderStatus({ ...(data || {}), call: 'close' }, opts);
}

module.exports = {
  postProdOrderStatus,
  // [ORDER-COMPLETE] [ORDER-SCHEDULED] l'esercizio (0045, generalizzato dalla 0046)
  postOrderStatus,
  postOrderClose,
  readTransportConfig,
  // parti pure, per test/prodOrderStatusPost.test.js
  functionParams,
  buildCall,
  variantsFor,
  findMessages,
  looksLikeMessage,
  field,
  readOutcome,
  depthOf,
  isQueryGuard,
  isODataError,
  odataErrorCode,
  findEmptyMessageShape,
  readMetadata,
  verdict,
  comporreVerdetto,
  perche,
  readPostConfig,
  CALLS,
  DEFAULTS,
  KINDS,
  SHAPES,
  PARAM,
  PARAM_ABAP,
  BASE
};

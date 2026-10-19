/**
 * [MATDOC-POST] Registrazione movimento merci verso SAP: POST del documento materiale
 * (testata + N righe) sull'iFlow di SAP Integration Suite.
 *
 * COSA E' DEFINITIVO E COSA NO
 * Definitivi sono il contratto, l'indirizzo, il trasporto e la lettura dell'esito.
 *
 * >>> [MATDOC-CONF] DALLA FEATURE 0021 QUESTO MODULO E' IN ESERCIZIO. <<<
 * I due elementi che erano provvisori — i dati e l'innesco — non lo sono più: il job PROD_CONF
 * (srv/jobs/postProdOrderConfirmation.js) chiama `postMaterialDoc(data)` con i documenti costruiti
 * da srv/lib/confMatDoc.js a partire dalle registrazioni lette da Plex, e registra 261, 101 e 551.
 * Il blocco `MOCK` qui sotto NON è stato tolto: alimenta la sonda, che è ancora l'unico modo di
 * provare l'endpoint senza aspettare una registrazione vera. Ma dalla W1-20 non è più il DEFAULT
 * di `postMaterialDoc`: chi vuole i dati finti li passa per nome — `window.matDocPost()` dalla
 * console del cockpit, che arriva all'action, che passa `MOCK` esplicitamente. Chi legge il log
 * distingue i due chiamanti dal campo `chiamante`.
 *
 * IL CONTRATTO, E PERCHE' HA QUESTA FORMA
 * L'endpoint è `/http/btpmars/sapecc/1110.02/materialdocument`: il prefisso `/http/` è quello degli HTTPS
 * sender di Cloud Integration, quindi NON c'è alcuno strato OData. Il messaggio è la firma della FM
 * `ZMARS_MATERIAL_DOC_POST`:
 *
 *   { IS_HEADER: {…14 campi…}, IT_ITEM: { item: [ {…94 campi…} ] },
 *     IV_GOODS_MOVEMENT_CODE, IV_TEST_RUN }
 *
 * Una chiamata, N righe, e a valle UNA invocazione di BAPI_GOODSMVT_CREATE: un documento materiale è
 * atomico, o passa tutto o non passa nulla. E' il vincolo attorno a cui è stato costruito tutto.
 *
 * Ci si è arrivati per esclusione, e vale la pena averlo scritto: in OData V2 non esiste modo
 * tipizzato di portare N righe in una POST che non sia il deep insert (le collection non sono
 * ammesse come tipo di Property, i parametri di FunctionImport devono essere EDMSimpleType), e il
 * deep insert il sender OData V2 di CPI non lo gestisce. Le tre forme valutate, con gli EDMX
 * relativi, sono in srv/external/ZMARS_MATDOC_POST_CONTRACT.md.
 *
 * LA CODIFICA DEI VALORI: XSD, NON FORMATO ABAP INTERNO
 * La regola sta in srv/lib/sapPostEncoding.js — DATS `"2026-08-07"`, TIMS `"09:30:00"`, NUMC
 * riempito a zeri, DEC col punto, XFELD `"X"`/`""` mai true/false — insieme alla storia
 * dell'eccezione CX_ST_DESERIALIZATION_ERROR da cui è stata dedotta. E' scritta una volta sola
 * perché vale identica per ogni FM esposta allo stesso modo: qui e in
 * srv/lib/prodOrderConfPost.js [PRODCONF-POST].
 *
 * TUTTI I CAMPI SONO PRESENTI, ANCHE QUELLI VUOTI
 * Dei 108 ne valorizziamo 18, gli altri 90 partono con la STRINGA VUOTA. I 4 campi che l'EDMX
 * dichiara `Edm.Boolean` sono XFELD CHAR1, e `sap:display-format="NonNegative"` marca un NUMC —
 * 21 campi su 108 — che va riempito a zeri, altrimenti si manda "1" dove SAP vuole "0001".
 *
 * LIMITE NOTO SUI TIPI. L'inventario deduce i tipi dall'EDMX standard S/4, mentre ST valida contro
 * `ZMARS_MATDOC_S_*`. Tre divergenze verificate nella colonna «Tipo DDIC» dei due .xlsx in
 * srv/external/: `ProfitabilitySegment` è NUMC 10 e qui risulta `char`; `GdsMvtExtAmtInCoCodeCrcy` e
 * `SlsPrcAmtInclVATInCoCodeCrcy` sono CURR 13,2 e qui risultano Decimal(14,3). Oggi partono vuoti,
 * quindi non mordono; se andranno valorizzati, l'inventario va rifatto sui data element veri.
 *
 * `IV_TEST_RUN` è sempre presente, anche come "": è l'unico campo dove l'assenza avrebbe un
 * significato pericoloso — parametro non passato, valore iniziale, cioè REGISTRA DAVVERO.
 *
 * La formattazione è guidata dall'inventario dei campi e non da elenchi scritti a mano: è ciò che la
 * rende applicata a tutti e 108 e non ai casi a cui uno pensa mentre scrive.
 *
 * PERCHE' IL TRASPORTO E' IL SERVIZIO REMOTO CAP E NON executeHttpRequest
 * `srv.send({method:'POST', path, data})` bypassa la traduzione CQN: il body passa VERBATIM
 * (remote/Service.js:248, remote/utils/query.js:75-95) e il path del servizio viene anteposto
 * all'URL (query.js:190). Controlliamo quindi il JSON al byte pur mantenendo destination, timeout,
 * resilience, CSRF e propagazione del JWT utente gestite da CAP come per ogni altra chiamata SAP.
 * Il CSN di srv/external/OP_API_MATERIAL_DOCUMENT_SRV non viene usato per serializzare: senza
 * `query` e senza `target` nessun campo viene scartato e nessuna conversione viene applicata.
 *
 * CSRF: NON SERVE SU QUESTO ADAPTER — MA E' SERVITO SU QUELLO PRIMA
 * La storia vale la pena tenerla, perché spiega perché la leva esiste. Il primo indirizzo era un
 * sender **OData V2** e rispondeva 403 con la pagina di errore STOCK DI TOMCAT più `x-csrf-token` e
 * `set-cookie`: era il CsrfPreventionFilter, "CSRF Protected" per default. Il fetch del token lo
 * risolse.
 *
 * L'indirizzo attuale è un **HTTPS sender**, e non lo pretende. Provato sul campo:
 * `csrfTokenObtained: NO` e la chiamata è entrata comunque fino a ECC. Quindi `post.csrf` è **false**.
 *
 * Non è solo inutile, è dannoso: il middleware fa DUE HEAD allo stesso indirizzo prima della POST
 * (csrf-token-middleware.js:132-133), che su un HTTPS sender rischiano di generare voci MPL spurie —
 * rumore nel monitor di Cloud Integration proprio mentre chiediamo a IS di leggere gli MPL ID.
 *
 * `MATDOC_POST_CSRF=on` lo riaccende, se un domani l'adapter cambia. `csrfTokenObtained` resta
 * dichiarato: se il 403 tornasse, distingue due diagnosi opposte — token ottenuto e 403 lo stesso
 * significa autorizzazione (ruolo ESBMessaging.send), token non ottenuto significa fetch respinto.
 * Attenzione che il fetch fallisce IN SILENZIO: il Cloud SDK logga un warning e manda la POST senza
 * token (csrf-token-middleware.js:99).
 *
 * EFFETTO IN SAP: L'ABILITAZIONE ALLA REGISTRAZIONE REALE
 * `IV_TEST_RUN = "X"` fa validare il movimento a SAP senza registrare nulla, ed è lo stato
 * predefinito. Si esce da lì solo abilitando esplicitamente il plant: `ZPlant.MatDocPostEnabled`,
 * tab GlobalParams di adminconfigplant. E' customizing PER PLANT perché è il plant a decidere
 * quando è pronto a scrivere documenti contabili, e quella decisione deve stare dove la prende chi
 * ne risponde, non in un file di configurazione.
 *
 * PERCHE' UN FLAG DI ABILITAZIONE E NON DI PROVA. Con un `MatDocTestRun` (default true) la casella
 * vuota nella UI avrebbe significato «registra davvero», ma su una riga con la colonna NULL il
 * comportamento sarebbe stato l'opposto: casella vuota e nessuna registrazione. La UI avrebbe
 * mentito sullo stato. Invertendolo, `false`, `NULL`, plant non configurato e mappa vuota per
 * errore di lettura diventano la stessa identica cosa — e quella cosa è lo stato sicuro. La
 * sicurezza smette di dipendere dal ricordarsi di scrivere `!== false`.
 *
 * La regola di risoluzione è **la più restrittiva vince**: un documento non è spezzabile, quindi
 * basta che UN plant coinvolto non sia abilitato perché l'intera chiamata sia in prova. Non esiste
 * il mezzo movimento. Nell'ordine:
 *   1. MATDOC_POST_TESTRUN, se impostata: leva d'emergenza, vince su tutto
 *   2. i plant delle righe: registra davvero solo se TUTTI sono abilitati
 *   3. nessun plant risolvibile: `post.testRun` da package.json, default "X"
 *
 * `MATDOC_POST=off` resta la protezione totale.
 *
 * LEVE (nessuna richiede un rilascio)
 *   MATDOC_POST=off           spegne la chiamata
 *   MATDOC_POST_CSRF=off      disattiva il fetch del token (controprova della diagnosi 403)
 *   MATDOC_POST_TESTRUN=off   scavalca il customizing e registra davvero — leggere sopra
 *   MATDOC_POST_PATH          indirizzo alternativo
 * Perimetro completo: grep -rn "MATDOC-POST"
 *
 * Contratto e storia delle decisioni: srv/external/ZMARS_MATDOC_POST_CONTRACT.md
 * Stato del collaudo con IS:          srv/external/MATERIAL_DOC_POST_IS.md
 */

'use strict';

const cds = require('@sap/cds');
const { upstreamStatus, errorText } = require('./isRemoteSource');
// La codifica dei valori in letterali XSD: regola condivisa con [PRODCONF-POST], vedi la testata.
const { toAbap, toAbapStruct } = require('./sapPostEncoding');
// [IS-EGRESS] come esce una chiamata verso gli iFlow da questo processo: la destination vive in un
// punto solo.
const { resolveEgress } = require('./isEgress');

/**
 * Inventario dei 108 campi con il loro tipo ABAP. Generato da
 * srv/external/generate-matdoc-contract.js insieme al JSON Schema del contratto, così la codifica
 * applicata qui e quella dichiarata a IS non possono divergere. `cds build` copia `srv/**` per
 * intero in gen/srv, quindi il file c'è anche in produzione.
 */
const FIELDS = require('../external/ZMARS_MATDOC_POST.fields.json');

/** Entry di cds.requires che porta le credenziali verso la destination. */
const BASE = 'OP_API_MATERIAL_DOCUMENT_SRV';

const DEFAULTS = {
  enabled: true,
  destination: 'MARS_SAP_CON',
  path: '/http/btpmars/sapecc/1110.02/materialdocument',
  entitySet: '',           // HTTPS sender: si posta direttamente sul path, nessun entity set
  testRun: 'X',            // XFELD: valida senza registrare
  csrf: false,             // l'HTTPS sender non lo pretende: provato. Vedi la nota in testa
  requestTimeout: 60000
};

/** Esito dichiarato da ET_RETURN.TYPE. Per insiemi: BAPIRET2 ammette più valori di quelli abituali. */
const TYPE_OK = ['S'];
const TYPE_WARN = ['W', 'I'];
const TYPE_KO = ['E', 'A', 'X'];

// ====================================================================================
// DATI PROVVISORI — segnaposto palesemente finti, in un blocco solo perché sono la parte
// destinata a sparire: quando il flusso applicativo sarà collegato, qui arriveranno i
// movimenti veri e questo blocco se ne va per intero.
//
// I valori si scrivono nella forma NATURALE (data come Date, quantità come numero): la
// conversione in formato ABAP la fa toAbap() sulla base del tipo dichiarato nell'inventario.
// Scriverli già formattati vorrebbe dire ripetere a mano una regola che esiste già.
//
// GoodsMovementCode '03' = goods issue, vale sia per 261 sia per 551
// (srv/external/SAP_CONF_MOVEMENT_API.md, nota finale).
// ====================================================================================
const MOCK = {
  header: {
    GoodsMovementCode: '03',
    MaterialDocumentHeaderText: 'MOCK MARS-BTP',
    ReferenceDocument: 'MOCK-REF-0001'
    // DocumentDate, PostingDate e CreationTime sono aggiunte da buildPayload: dipendono dall'istante
    // di invio.
  },
  items: [
    {
      GoodsMovementType: '261',
      Material: 'MOCK-COMP-01',
      Plant: '07',
      StorageLocation: '0001',
      QuantityInEntryUnit: 3,
      EntryUnit: 'PC',
      ManufacturingOrder: '000010000123',
      Reservation: '12345',              // NUMC(10): toAbap lo porta a '0000012345'
      ReservationItem: '1',              // NUMC(4):  -> '0001'
      MaterialDocumentItemText: 'MOCK consumo componente 1'
    },
    {
      // RIGA DI COPERTURA DEI TIPI. Le altre due valorizzano solo char, numc e un dec: `dats` di
      // riga e `xfeld` non sarebbero collaudati da nessuna parte, e il loro letterale lo
      // scopriremmo sbagliato solo coi dati veri. Qui sono pieni, altrove vuoti: ogni tipo viene
      // provato in entrambi gli stati nella stessa chiamata.
      //
      // Restano fuori di proposito GdsMvtExtAmtInCoCodeCrcy e SlsPrcAmtInclVATInCoCodeCrcy: sono i
      // due campi con la divergenza di tipo nota (CURR 13,2 in DDIC contro Decimal(14,3) nell'EDMX),
      // e valorizzarli ora confonderebbe due domande diverse — «il formato dei decimali e' giusto?»
      // e «la scala e' quella giusta?». ST si ferma al primo errore, quindi una domanda per volta.
      GoodsMovementType: '261',
      Material: 'MOCK-COMP-02',
      Plant: '07',
      StorageLocation: '0001',
      QuantityInEntryUnit: 1.5,
      QuantityInBaseUnit: 1.5,             // dec, secondo campione
      EntryUnit: 'KG',
      MaterialBaseUnit: 'KG',
      ManufacturingOrder: '000010000123',
      Reservation: '12345',
      ReservationItem: '2',
      ShelfLifeExpirationDate: '2027-03-31',  // dats di riga: mai provato altrove
      ManufactureDate: '2026-01-15',          // dats di riga
      IsCompletelyDelivered: true,            // xfeld: mai provato altrove, deve uscire "X"
      MaterialDocumentItemText: 'MOCK consumo componente 2'
    },
    {
      GoodsMovementType: '551',
      Material: 'MOCK-COMP-03',
      Plant: '07',
      StorageLocation: '0001',
      QuantityInEntryUnit: 1,
      EntryUnit: 'PC',
      CostCenter: '0000001000',
      GoodsMovementReasonCode: '1',       // NUMC(4) -> '0001'
      MaterialDocumentItemText: 'MOCK scarto'
    }
  ]
};

// ---------------------------------------------------------------------------------------------
// COSTRUZIONE DEL BODY
// `toAbap` / `toAbapStruct` — la codifica in letterali XSD — stanno in srv/lib/sapPostEncoding.js.
// ---------------------------------------------------------------------------------------------

/**
 * Costruisce il body da inviare. FUNZIONE PURA: nessun accesso a rete, a cds o all'orologio —
 * il giorno arriva da fuori. E' ciò che la rende collaudabile in test/materialDocPost.test.js
 * senza sistemi esterni, come splitRules.js e isQueryShape.js.
 *
 * @param {{header: object, items: object[]}} data valori in forma naturale
 * @param {Date} day  giorno di DocumentDate / PostingDate
 * @param {string} testRun 'X' oppure ''
 * @returns {object} il JSON esatto che finirà nel body della POST
 */
function buildPayload(data, day, testRun) {
  // CreationTime è l'unico campo TIMS del contratto, ed è valorizzato apposta: è il solo modo di
  // mettere alla prova il letterale xsd:time (`HH:MM:SS`) prima di scoprirlo con dati veri.
  // Nota: CPUTM è la marca oraria d'inserimento e in genere la scrive ECC — se la rifiutasse o la
  // ignorasse va tolta, ma intanto il formato l'avremo verificato.
  const header = { ...data.header, DocumentDate: day, PostingDate: day, CreationTime: day };
  return {
    IS_HEADER: toAbapStruct(FIELDS.header, header),
    // L'array annidato sotto `item`: è come una tabella ABAP viene resa in JSON.
    IT_ITEM: { item: data.items.map((it) => toAbapStruct(FIELDS.item, it)) },
    // Presente anche in IS_HEADER.GOODSMOVEMENTCODE, come nel loro esempio. Resta da confermare
    // con IS se uno dei due prevalga; valorizzarli entrambi è la scelta che non può sbagliare.
    IV_GOODS_MOVEMENT_CODE: String(data.header.GoodsMovementCode || ''),
    IV_TEST_RUN: testRun === 'X' ? 'X' : ''
  };
}

// ---------------------------------------------------------------------------------------------
// LETTURA DELL'ESITO
// ---------------------------------------------------------------------------------------------

/**
 * Interpreta la risposta della FM. FUNZIONE PURA.
 *
 * `ET_RETURN` è una STRUTTURA singola, non una tabella: il nome è fuorviante ma è così per scelta
 * di IS. Si tollera comunque la forma tabellare — un array, o `{item:[…]}` come in IT_ITEM — perché
 * costa una riga e perché una risposta inattesa non deve far cadere il lettore.
 *
 * La regola: `TYPE` dichiara l'esito, e nel dubbio si dichiara FALLITA. Dare per registrato un
 * movimento che non c'è è l'unico errore che non possiamo permetterci, e un `TYPE` che non
 * riconosciamo è esattamente il caso in cui saremmo tentati di tirare a indovinare.
 *
 * @returns {{ok:boolean, warn:boolean, materialDocument:string, materialDocumentYear:string,
 *             messageType:string, message:string, messageRow:string, reason:string}}
 */
/**
 * L'MPL ID che Cloud Integration mette nel messaggio d'errore:
 *   "An internal server error occured: The MPL ID for the failed message is : AGp1rc…"
 *
 * E' il *Message Processing Log*, e vale più del codice HTTP: esiste solo per messaggi che il
 * runtime ha accettato e iniziato a elaborare, ed è la chiave con cui il team Integration apre
 * l'esecuzione fallita nel proprio monitor. Sepolto nel testo non lo userebbe nessuno.
 */
function extractMplId(body) {
  const s = typeof body === 'string' ? body : safeStringify(body);
  const m = /MPL\s*ID[^:]*:\s*([\w-]+)/i.exec(s || '');
  return m ? m[1] : '';
}

function readOutcome(body) {
  const b = (body && typeof body === 'object') ? body : {};
  let ret = b.ET_RETURN;
  if (Array.isArray(ret)) ret = ret[0];
  else if (ret && ret.item) ret = [].concat(ret.item)[0];
  ret = ret || {};

  const type = String(ret.TYPE || '').trim().toUpperCase();
  const doc = String(b.EV_MATERIAL_DOCUMENT || '').trim();
  const year = String(b.EV_MATERIAL_DOC_YEAR || '').trim();
  const msg = String(ret.MESSAGE || '').trim();

  const out = {
    ok: false,
    warn: false,
    materialDocument: doc,
    materialDocumentYear: year,
    messageType: type,
    // [MATDOC-CONF] ID e NUMBER del BAPIRET2: sono ciò con cui si riconosce un messaggio SAP
    // senza dover confrontare il TESTO, che cambia con la lingua dell'utente di servizio. Li usa
    // classifyFailure (srv/lib/confMatDoc.js) per decidere se un rifiuto è definitivo.
    messageId: String(ret.ID || '').trim(),
    messageNumber: String(ret.NUMBER || '').trim(),
    message: msg,
    messageRow: String(ret.ROW || '').trim(),
    // [MATDOC-CONF] SAP dichiara riuscito ma non dà il numero documento. Non è un fallimento come
    // gli altri: NON si sa se il movimento sia stato registrato, quindi ritentarlo rischia di
    // duplicarlo. Il flag esiste perché quel caso vada trattato a parte, non riconosciuto dal
    // testo di `reason`.
    inconclusive: false,
    reason: ''
  };

  if (TYPE_KO.includes(type)) {
    out.reason = `SAP ha rifiutato la registrazione (TYPE ${type})`;
  } else if (TYPE_OK.includes(type) || TYPE_WARN.includes(type)) {
    out.ok = true;
    out.warn = TYPE_WARN.includes(type);
    // Un successo senza numero documento è incoerente: si dichiara, non si liscia.
    if (!doc) {
      out.ok = false;
      out.inconclusive = true;
      out.reason = `TYPE ${type} dichiara riuscito ma EV_MATERIAL_DOCUMENT è vuoto: risposta incoerente`;
    }
  } else {
    out.reason = type
      ? `TYPE '${type}' non riconosciuto: esito non interpretabile`
      : 'ET_RETURN.TYPE assente: esito non interpretabile';
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// REGISTRAZIONE IN PROVA (IV_TEST_RUN), customizing per plant
// ---------------------------------------------------------------------------------------------

/** I plant coinvolti nel documento, dedotti dalle righe. */
function plantsOf(data) {
  return [...new Set(data.items.map((i) => i.Plant).filter(Boolean))];
}

/**
 * Decide IV_TEST_RUN a partire dai flag di abilitazione dei plant. FUNZIONE PURA, così la regola
 * — che è una regola di sicurezza — è collaudabile senza database.
 *
 * LA PIU' RESTRITTIVA VINCE. Un documento materiale non è spezzabile: basta che UN plant coinvolto
 * non sia abilitato perché l'intera chiamata sia in prova. Registrare davvero richiede che TUTTI i
 * plant siano stati abilitati esplicitamente.
 *
 * Il flag è di ABILITAZIONE, non di prova, e questo rende la sicurezza strutturale invece che
 * ricordata: `false`, `NULL`, plant non configurato e mappa vuota per errore di lettura collassano
 * tutti sullo stesso ramo, quello sicuro. Registrare richiede un `true` esplicito su ogni plant, e
 * non esiste alcun valore mancante che possa produrlo.
 *
 * @param {string[]} plants  i plant delle righe
 * @param {Map<string,boolean>} enabled  PlantCode -> MatDocPostEnabled letto da ZPlant
 * @param {string} fallback  'X' | '' da package.json, per quando non c'è alcun plant
 * @returns {{testRun:string, source:string}}
 */
function resolveTestRun(plants, enabled, fallback) {
  if (!plants.length) {
    return { testRun: fallback === '' ? '' : 'X', source: 'nessun plant nelle righe: default di configurazione' };
  }
  const unknown = plants.filter((p) => !enabled.has(p));
  if (unknown.length) {
    return { testRun: 'X', source: `plant non configurati in ZPlant (${unknown.join(', ')}): in prova` };
  }
  const notEnabled = plants.filter((p) => enabled.get(p) !== true);
  if (notEnabled.length) {
    return { testRun: 'X', source: `registrazione reale non abilitata su ${notEnabled.join(', ')}` };
  }
  return { testRun: '', source: `registrazione reale abilitata su tutti i plant coinvolti (${plants.join(', ')})` };
}

/** Legge i flag da ZPlant. Non lancia: se il DB non risponde si resta in prova, per costruzione. */
async function readPostEnabledFlags(plants) {
  if (!plants.length) return new Map();
  try {
    const db = await cds.connect.to('db');
    const rows = await db.run(
      SELECT.from('avvaleplm.marsplm.sap2plex.ZPlant')
        .columns('PlantCode', 'MatDocPostEnabled')
        .where({ PlantCode: { in: plants } })
    );
    // `=== true` è qui la lettura SICURA, ed è il motivo per cui il flag è di abilitazione: una
    // colonna NULL — le righe ZPlant già esistenti quando la colonna arriva su HANA, che il
    // default CDS non retro-riempie — diventa false, cioè non abilitata, cioè in prova.
    return new Map(rows.map((r) => [r.PlantCode, r.MatDocPostEnabled === true]));
  } catch (e) {
    console.error(`>>> [MATDOC-POST] lettura di ZPlant.MatDocPostEnabled fallita (${e.message}): si resta in prova`);
    return new Map(); // mappa vuota = plant sconosciuti = in prova
  }
}

// ---------------------------------------------------------------------------------------------

/** Config effettiva: DEFAULTS <- cds.requires.<BASE>.post <- override da env. */
function readPostConfig() {
  const fromCds = (cds.env.requires && cds.env.requires[BASE] && cds.env.requires[BASE].post) || {};
  const cfg = { ...DEFAULTS, ...fromCds };
  const isOff = (v) => ['off', 'false', '0', 'no'].includes(String(v).trim().toLowerCase());
  const set = (name) => process.env[name] !== undefined && String(process.env[name]).trim() !== '';

  if (set('MATDOC_POST')) cfg.enabled = !isOff(process.env.MATDOC_POST);
  if (set('MATDOC_POST_CSRF')) cfg.csrf = !isOff(process.env.MATDOC_POST_CSRF);
  if (set('MATDOC_POST_PATH')) cfg.path = String(process.env.MATDOC_POST_PATH).trim();
  // `testRun` da env e' la leva d'emergenza e scavalca il customizing per plant; `testRunForced`
  // dice se e' stata usata, così il log può dichiarare CHI ha deciso invece di mostrare solo l'esito.
  cfg.testRunForced = set('MATDOC_POST_TESTRUN');
  if (cfg.testRunForced) cfg.testRun = isOff(process.env.MATDOC_POST_TESTRUN) ? '' : 'X';

  // [IS-EGRESS] Come esce questa POST da questo processo: dentro un job la destination e' quella con
  // utenza tecnica; dal server web — cioe' dalla sonda `postMaterialDoc` del cockpit — resta quella
  // configurata. Si risolve QUI e non in `connect()` perche' tutte le righe di log stampano
  // `cfg.destination`: cosi' dicono da se' su quale canale la chiamata e' uscita, senza un secondo
  // posto da tenere allineato.
  const eg = resolveEgress(process.env, { destination: cfg.destination });
  cfg.destination = eg.destination;
  cfg.egressWhy = eg.why;
  return cfg;
}

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

/**
 * Header mascherati e già serializzati: escono verso il browser, quindi `authorization` e i
 * cookie di sessione non devono passare di lì.
 *
 * `reveal` esiste per UN caso: `x-csrf-token` IN RISPOSTA. Quando il runtime rifiuta per CSRF,
 * quel campo vale letteralmente `Required` — è la diagnosi, non un segreto, e mascherarlo
 * nascondeva l'unica prova conclusiva. In RICHIESTA resta mascherato: lì è un token di sessione vero.
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
 * Istanza memoizzata sull'endpoint (stesso schema di isRemoteSource.js:161).
 * `csrf` viaggia FRA LE OPZIONI e non dentro `credentials`: CAP lo legge da `service.options`
 * (remote/Service.js:221) e `cds.connect.to` fa un merge superficiale `{...conf, ...opts}`
 * (lib/srv/cds-connect.js:61), quindi questa leva scavalca package.json.
 * Il valore è letto una volta sola, in init(): cambiarlo richiede un restart.
 */
let pending = null;
function connect(cfg) {
  if (!pending) {
    // [IS-EGRESS] Nessun gancio `before('*')` su questa istanza: fino al 28/08/2026 ce n'era uno che
    // fondeva l'header applicativo, ora rimosso da ogni canale. Ciò che il canale batch decide è la
    // sola `destination`, già risolta dentro `cfg` — un posto solo, quindi niente da tenere allineato.
    pending = cds.connect.to(BASE, {
      csrf: cfg.csrf,
      credentials: {
        destination: cfg.destination,
        path: cfg.path,
        requestTimeout: cfg.requestTimeout
      }
    }).catch((e) => { pending = null; throw e; });
  }
  return pending;
}

/** Lo scambio completo sul log del server: è ciò che si gira al team Integration. */
function logExchange(r) {
  const T = '>>> [MATDOC-POST]';
  if (!r.enabled) {
    console.warn(`${T} chiamata DISATTIVATA (MATDOC_POST=off oppure post.enabled=false): niente inviato`);
    return;
  }
  console.log(`${T} ==================== RICHIESTA ====================`);
  console.log(`${T} POST ${r.url}`);
  // [MATDOC-CONF] Chi sta chiamando: con l'esercizio e la sonda sullo stesso indirizzo, nel monitor
  // di Cloud Integration gli MPL si somigliano tutti e questa riga è ciò che li separa.
  console.log(`${T} chiamante       : ${r.label || 'sonda'}`);
  // [IS-EGRESS] Da dove è uscita e perché da lì: con l'esercizio del job e la sonda del cockpit
  // sullo stesso indirizzo, `[run batch PROD_CONF]` e `[server web …]` sono ciò che li separa.
  console.log(`${T} destination     : ${r.destination}${r.egressWhy ? ` [${r.egressWhy}]` : ''}`);
  console.log(`${T} righe inviate   : ${r.itemCount} (in un'unica chiamata) | x-correlation-id: ${r.correlationId || '(assente)'}`);
  console.log(`${T} IV_TEST_RUN     : ${r.testRun === 'X' ? '"X" — valida SENZA registrare' : '"" — REGISTRA DAVVERO in SAP'}`);
  console.log(`${T} deciso da       : ${r.testRunSource}${r.plants ? ` | plant nelle righe: ${r.plants}` : ''}`);
  console.log(`${T} csrf            : ${r.csrf ? `fetch attivo | token ottenuto: ${r.csrfTokenObtained ? 'SI' : 'NO'}` : 'disattivato'}`);
  console.log(`${T} body inviato:\n${r.requestBody}`);
  console.log(`${T} ==================== RISPOSTA  ====================`);
  if (r.outcome === 'OK') {
    console.log(`${T} ESITO OK${r.warn ? ' CON AVVISO' : ''} | documento ${r.materialDocument}/${r.materialDocumentYear} | ${r.ms} ms`);
    if (r.message) console.log(`${T} ${r.messageType}${r.messageRow ? ` riga ${r.messageRow}` : ''}: ${r.message}`);
  } else {
    console.error(`${T} ESITO KO${r.httpStatus ? ` | HTTP ${r.httpStatus}` : ''} | ${r.ms} ms`);
    if (r.mplId) {
      console.error(`${T} MPL ID: ${r.mplId} — è la chiave con cui il team Integration apre `
        + `l'esecuzione fallita nel monitor di Cloud Integration. Da citare insieme al correlation id.`);
    }
    if (r.reason) console.error(`${T} ${r.reason}`);
    if (r.message) console.error(`${T} ${r.messageType}${r.messageRow ? ` riga ${r.messageRow}` : ''}: ${r.message}`);
    if (r.error) console.error(`${T} errore: ${r.error}`);
    if (r.requestHeaders) console.error(`${T} header inviati:\n${r.requestHeaders}`);
    if (r.responseHeaders) console.error(`${T} header ricevuti:\n${r.responseHeaders}`);
    console.error(`${T} body ricevuto:\n${r.responseBody || '(vuoto)'}`);
    if (r.httpStatus === 403) console.error(`${T} ${diagnose403(r)}`);
    if (r.httpStatus === 404) {
      console.error(`${T} l'indirizzo non risponde: verificare che l'iFlow sia deployato e che `
        + `il path sia ancora ${r.path}`);
    }
  }
  console.log(`${T} ===================================================`);
}

/**
 * Lettura del 403, che su Cloud Integration ha due cause distinte e rimedi opposti.
 * Il discriminante è se il token CSRF è stato davvero ottenuto: se sì, il CSRF non c'entra.
 */
function diagnose403(r) {
  if (!r.csrf) {
    return 'fetch CSRF disattivato: se il runtime protegge l\'adapter sender, questo 403 è atteso. '
      + 'Riprovare con MATDOC_POST_CSRF=on.';
  }
  if (r.csrfTokenObtained) {
    return 'token CSRF ottenuto e 403 lo stesso: NON è CSRF. Guardare l\'autorizzazione del client '
      + 'della destination, tipicamente il ruolo ESBMessaging.send sul tenant di Integration Suite.';
  }
  return 'token CSRF NON ottenuto: anche la richiesta di fetch è stata respinta. Guardare '
    + 'l\'autorizzazione del client (ruolo ESBMessaging.send) prima del payload.';
}

/**
 * Manda la POST e restituisce lo scambio. NON LANCIA per un esito remoto: un fallimento deve
 * mostrare il proprio scambio, non diventare un 500 in faccia al chiamante. L'unica eccezione è
 * `data` mancante, qui sotto, che non è un esito ma un errore di programmazione.
 *
 * @returns {Promise<object>} record dello scambio, pronto per la action e per la UI
 */
/**
 * [MATDOC-CONF] I DATI ARRIVANO DA FUORI, SEMPRE (feature 0021, W1-20).
 *
 * Fino alla 0021 questa funzione non prendeva argomenti e mandava il blocco `MOCK`: era una sonda,
 * e il suo innesco era l'apertura della dashboard. Ora il chiamante di esercizio è il job PROD_CONF,
 * che passa i documenti costruiti da srv/lib/confMatDoc.js dalle registrazioni Plex.
 *
 * `data` È OBBLIGATORIO e non ha più un default. Il default `MOCK` sembrava comodo — teneva viva la
 * sonda senza dire niente — e in realtà rendeva `postMaterialDoc()` una riga innocua che manda a
 * SAP materiali inventati: un chiamante nuovo che dimentica l'argomento non sbaglia in modo
 * visibile, registra MOCK-COMP-01. Chi vuole i dati finti li chiede per nome (`MOCK` è esportato),
 * ed è esattamente ciò che fa l'handler della sonda in cat-service.js.
 *
 * Il `throw` è voluto: i due chiamanti passano `data`, quindi può scattare solo su un chiamante
 * nuovo, subito, la prima volta che lo si prova — non su un movimento sbagliato in produzione.
 *
 * @param {{header: object, items: object[]}} data valori in forma naturale — OBBLIGATORIO
 * @param {{label?: string, correlationId?: string}} [opts] contesto per il log e per il monitor di
 *   Cloud Integration: `label` distingue una chiamata di esercizio da una sonda quando si guardano
 *   gli MPL, che altrimenti si somigliano tutti.
 */
async function postMaterialDoc(data, opts = {}) {
  if (!data || !data.header || !Array.isArray(data.items)) {
    throw new TypeError('postMaterialDoc: `data` è obbligatorio e deve avere {header, items[]}. '
      + 'Per i dati di prova si passa la costante MOCK esplicitamente, come fa la sonda.');
  }
  const cfg = readPostConfig();
  const day = new Date();
  const doc = data;

  // IV_TEST_RUN: customizing per plant, salvo leva d'emergenza. Si risolve PRIMA di costruire il
  // payload perché ne fa parte.
  const plants = plantsOf(doc);
  let testRun = cfg.testRun === 'X' ? 'X' : '';
  let testRunSource = 'MATDOC_POST_TESTRUN (leva d\'emergenza, scavalca il customizing)';
  if (!cfg.testRunForced) {
    const resolved = resolveTestRun(plants, await readPostEnabledFlags(plants), cfg.testRun);
    testRun = resolved.testRun;
    testRunSource = resolved.source;
  }

  const payload = buildPayload(doc, day, testRun);

  const r = {
    enabled: !!cfg.enabled,
    outcome: 'OFF',                       // OK | KO | OFF
    label: String(opts.label || 'sonda'),
    testRun,
    testRunSource,
    plants: plants.join(', '),
    warn: false,
    csrf: !!cfg.csrf,
    csrfTokenObtained: false,
    destination: cfg.destination,
    // [IS-EGRESS] Perché quella destination e non l'altra: la sonda del cockpit e l'esercizio del
    // job escono dallo stesso modulo, e il nome della destination da solo non dice chi ha chiamato.
    egressWhy: cfg.egressWhy || '',
    path: cfg.path,
    url: cfg.path + (cfg.entitySet ? `/${cfg.entitySet}` : ''),
    // In un job batch non c'è `cds.context`: il chiamante passa il proprio identificativo, che è
    // ciò che poi si cita al team Integration insieme all'MPL ID.
    correlationId: opts.correlationId || (cds.context && cds.context.id) || '',
    itemCount: (doc.items || []).length,
    requestBody: JSON.stringify(payload, null, 2),
    requestHeaders: '',
    httpStatus: null,
    responseHeaders: '',
    responseBody: '',
    materialDocument: '',
    materialDocumentYear: '',
    messageType: '',
    messageId: '',
    messageNumber: '',
    message: '',
    messageRow: '',
    // [MATDOC-CONF] Vedi readOutcome: distingue «rifiutato» da «non so se è passato».
    inconclusive: false,
    mplId: '',
    reason: '',
    error: '',
    ms: 0,
    sentAt: day.toISOString()
  };

  if (!r.enabled) {
    r.reason = 'chiamata disattivata: MATDOC_POST=off oppure cds.requires.' + BASE + '.post.enabled=false';
    logExchange(r);
    return r;
  }

  const t0 = Date.now();
  try {
    const srv = await connect(cfg);
    // Nessun header passato a mano QUI: CAP imposta già accept, content-type, content-length e
    // x-correlation-id (remote/Service.js:256-268), il middleware CSRF aggiunge i suoi, e
    // l'header applicativo [IS-EGRESS] lo mette il gancio registrato in connect(), e solo se il
    // processo e' un run batch.
    const res = await srv.send({ method: 'POST', path: cfg.entitySet || '/', data: payload });
    r.csrfTokenObtained = r.csrf;
    r.responseBody = safeStringify(res);

    // HTTP 2xx non basta: l'esito lo dichiara ET_RETURN.TYPE.
    const o = readOutcome(res);
    Object.assign(r, {
      outcome: o.ok ? 'OK' : 'KO',
      warn: o.warn,
      materialDocument: o.materialDocument,
      materialDocumentYear: o.materialDocumentYear,
      messageType: o.messageType,
      messageId: o.messageId,
      messageNumber: o.messageNumber,
      message: o.message,
      messageRow: o.messageRow,
      inconclusive: o.inconclusive,
      reason: o.reason
    });
  } catch (e) {
    r.outcome = 'KO';
    // e.statusCode è 502 per QUALUNQUE fallimento: lo normalizza CAP. Quello vero è annidato
    // nella causa, ed è lì che sta anche l'intero scambio (remote/utils/client.js:140-153).
    r.httpStatus = upstreamStatus(e) || null;
    r.error = errorText(e).slice(0, 2000);
    const reason = (e && e.reason) || {};
    if (reason.request) {
      if (reason.request.url) r.url = reason.request.url;
      // Gli header ECHEGGIATI sono quelli davvero partiti: se il middleware ha ottenuto il token,
      // `x-csrf-token` è fra questi. E' l'unico modo per sapere se il fetch è riuscito, dato che
      // il Cloud SDK in caso contrario prosegue in silenzio.
      const sent = reason.request.headers || {};
      r.csrfTokenObtained = Object.keys(sent).some((k) => k.toLowerCase() === 'x-csrf-token');
      r.requestHeaders = maskHeaders(sent);
    }
    if (reason.response) {
      r.responseHeaders = maskHeaders(reason.response.headers, { reveal: ['x-csrf-token'] });
      r.responseBody = safeStringify(reason.response.body);
      r.mplId = extractMplId(reason.response.body);
      // Anche su errore HTTP l'iFlow può aver risposto con la busta della FM: se c'è un messaggio
      // applicativo è molto più utile del codice HTTP.
      const o = readOutcome(reason.response.body);
      if (o.messageType || o.message) {
        Object.assign(r, {
          messageType: o.messageType,
          messageId: o.messageId,
          messageNumber: o.messageNumber,
          message: o.message,
          messageRow: o.messageRow
        });
      }
    }
  }
  r.ms = Date.now() - t0;

  logExchange(r);
  return r;
}

module.exports = {
  postMaterialDoc,
  buildPayload,
  readOutcome,
  resolveTestRun,
  plantsOf,
  toAbap,
  toAbapStruct,
  readPostConfig,
  FIELDS,
  MOCK,
  BASE
};

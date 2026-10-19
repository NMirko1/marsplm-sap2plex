/**
 * [BOM-AUTODEPLETE] Regole pure delle righe di distinta (BOM) verso Plex — gap W1-06.
 *
 * Qui vive tutto cio' che di questa area si puo' verificare SENZA Plex: la forma dei body di
 * creazione e aggiornamento di una riga BOM, la lettura di una riga restituita dalla GET, la
 * decisione fra creare / aggiornare / saltare, e la classificazione dell'esito del flag
 * `autoDeplete`. L'orchestrazione — connessione, chiamate HTTP, log, contatori — resta nel
 * passo 7 di syncRoutingPlexCycle, in srv/cat-service.js.
 *
 * LA REGOLA DA CUI NASCE IL MODULO. La BBP §4.2.4 mette fra le assunzioni vincolanti che «non
 * sono attivati consumi logici automatici in Plex (flag Autodeplete disattivato)» e che «i
 * consumi contabili e logistici sono governati esclusivamente da SAP»; §7.5.2 lo estende a Wave 1
 * e Wave 2. Il progetto non mandava il campo, quindi valeva il default del tenant: se quel
 * default e' `true`, Plex consuma i componenti da se' e i movimenti 261 che MARS registra in SAP
 * (feature 0021) diventano un DOPPIO CONSUMO, su un flusso con effetti contabili.
 *
 * IL NOME DEL CAMPO NON E' INDOVINATO. `autoDeplete` viene dal contratto pubblicato della BOM API
 * di Plex — vedi srv/external/PLEX_BOM_API_CONTRACT.md, che riporta anche il modo di rileggerlo.
 * E' la regola di DEC-43/44/45: una forma di wire si legge, non si deduce. Attenzione al
 * corollario di DEC-28: su questa stessa API il componente si chiama `componentPartId` in
 * lettura e `componentId` in scrittura, quindi il nome di un campo in scrittura NON si deriva
 * mai da quello trovato in lettura. Qui i due nomi coincidono, ma la coincidenza e' verificata
 * sul contratto.
 *
 * IL FLAG LETTO HA TRE VALORI: `true`, `false` e `null` = non osservabile. `flag()` di
 * srv/lib/materialClass.js NON si riusa: rende `false` sull'ignoto, e qui `false` e' esattamente
 * il valore da riconoscere — «non lo so» non e' «va bene».
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' `process.env` (la leva la legge il
 * chiamante e la passa come argomento — stessa divisione fra plexJobSort.js e
 * plexJobSortRules.js). Non aggiungerne: il test si lancia con `node test/plexBomRules.test.js`.
 * Stessa convenzione di srv/lib/recvOpRules.js, srv/lib/splitRules.js e srv/lib/isQueryShape.js.
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

/**
 * Il nome del campo sul filo, dal contratto: `autoDeplete` in AddBomComponentDto (POST
 * /engineering/v1/boms) e in UpdateBomComponentDto (PATCH /engineering/v1/boms/{id}), e
 * restituito con lo stesso nome in BomComponentDto (GET).
 */
const AUTODEPLETE_FIELD = 'autoDeplete';

/**
 * Il valore, che e' una COSTANTE e non un customizing (RB-01). La BBP dichiara l'unico valore
 * ammesso in Wave 1 e Wave 2: un interruttore per plant offrirebbe solo il modo di sbagliarlo, e
 * lo sbaglio sarebbe un doppio consumo che nessun test intercetta.
 */
const AUTODEPLETE_VALUE = false;

/**
 * [W1-05] L'unita' di misura della riga BOM sul filo.
 *
 * QUESTO E' IL CAMPO CHE IL FIELD MAPPING CHIEDE, e non e' quello che il contratto Plex farebbe
 * scegliere leggendolo da solo. `componentUnitOfMeasure` e' di SOLA LETTURA e viene dalla part;
 * `depletionUnitOfMeasure` e' l'unita' di *consumo*, «to aid readability». Ragionando dalla
 * semantica si concluderebbe che mandare `STPO-MEINS` non corregge il numero — vero, ma non e'
 * la domanda: il foglio `3.BOM` di Ariston_Integration Field Mapping Details lo dichiara
 * `In Scope = 1` con sorgente `STPO-MEINS`, «Based on the logic to get STPO-MENGE». Il contratto
 * dice cosa un campo SIGNIFICA, il field mapping concordato dice cosa ci si METTE: fra i due
 * vince il secondo.
 *
 * IL VALORE SI MANDA VERBATIM, senza tradurlo. Non e' un'omissione: nella risposta REALE catturata
 * nel foglio `BOM Component` dell'API List (part `PILOT_SAMPLE_01`, UUID veri,
 * `componentUnitOfMeasure: "pcs"`) questo campo torna col segnaposto letterale `"string"`, cioe'
 * il valore che la richiesta aveva mandato. Plex l'ha accettato: e' testo libero, non validato
 * contro l'anagrafica unita' del tenant. Da qui la risposta a «serve una tabella di dizionario
 * UoM SAP -> UoM Plex?»: no, e per una ragione verificata.
 */
const DEPLETION_UOM_FIELD = 'depletionUnitOfMeasure';

/**
 * [W1-05] `validate` e il suo valore, gemelli di `autoDeplete`: il foglio `3.BOM` lo da'
 * `In Scope = 1` con la stessa nota «Fixed value populated by middleware», e il progetto non lo
 * mandava affatto. Il campo significa «richiede la presenza del materiale prima di poter produrre».
 *
 * IL VALORE E' `false` DAL 19/08/2026, ED E' UNA SCELTA REVOCATA, NON UN DATO CAMBIATO. Il foglio
 * dichiara il campo in scope ma NON dice quale valore: il `true` di W1-05 era una decisione del
 * progetto — l'unico punto di quel lotto in cui si e' scelto invece di leggere, ed e' la ragione per
 * cui questo campo ha una leva e `quantity` no (DEC-68). Quella scelta e' stata revocata: alla
 * creazione dell'ordine di produzione i componenti della distinta non devono avere il flag.
 *
 * MANDARE `false` NON E' LA STESSA COSA CHE NON MANDARLO, e la differenza e' il motivo per cui la
 * leva non e' la risposta a questa richiesta. `PLEX_BOM_VALIDATE=off` OMETTE la chiave, e su una
 * riga nuova vale allora il default del tenant Plex, che nessuno ha verificato; su una riga
 * esistente non tocca niente. Il `false` esplicito e' l'unico modo per SOVRASCRIVERE un `true`
 * ereditato o messo a mano. Se un giorno la scelta si rovescia di nuovo, si cambia questa costante:
 * la leva resta quello che e', un ripristino del corpo di prima di W1-05.
 *
 * ARRETRATO DICHIARATO: `decideBomAction` innesca il `PATCH` sulla sola QUANTITA', quindi le righe
 * gia' su Plex con quantita' invariata conservano il `true` che avevano. E' la stessa conseguenza
 * accettata per `depletionUnitOfMeasure` (`UOM_STATE.STALE`), e a differenza di quella qui non si
 * conta: `readBomRow` non legge `validate` dalla GET. Chi volesse l'allineamento dell'arretrato deve
 * aggiungere PRIMA quella lettura — senza, un contatore direbbe zero su ogni riga.
 */
const VALIDATE_FIELD = 'validate';
const VALIDATE_VALUE = false;

/**
 * [BOM-DEPLETION-FACTOR] `depletionConversionFactor` SI MANDA, e vale `1`. Fino al 19/08/2026 non
 * si mandava affatto, per una ragione scritta e per un'assunzione sbagliata.
 *
 * LA RAGIONE ERA: il foglio `3.BOM` lo da' `In Scope = 0`, il fattore vero sta in `MARM` per
 * materiale e non lo leggiamo, quindi un `1` fisso sarebbe una bugia proprio quando il fattore
 * serve — cioe' con la riga di distinta in un'unita' ALTERNATIVA del componente.
 *
 * L'ASSUNZIONE SBAGLIATA ERA: che il campo fosse facoltativo. Il contratto lo dichiara
 * `Required: false` — «Conversion factor to be used if DepletionUnitOfMeasure is set» — ma il
 * RUNTIME lo impone in coppia, e lo dice con parole sue:
 *
 *   400 ARGUMENT_INVALID { argument: 'DepletionConversionFactor',
 *     explanation: 'DepletionConversionFactor is a required field if value of
 *                   DepletionUnitOfMeasure is provided.' }
 *
 * Mandare l'unita' senza il fattore non e' quindi «mandare meno»: e' una riga di distinta che
 * NON NASCE. Le quattro righe del ciclo 50000012 sono cadute tutte cosi'. La scelta reale non era
 * fra «fattore onesto» e «fattore inventato», ma fra «distinta con fattore 1» e «nessuna distinta».
 *
 * PERCHE' `1` NON E' UNA BUGIA NUOVA. La `quantity` che mandiamo viene da `STPO-MENGE` e l'unita'
 * da `STPO-MEINS`: sono la stessa riga di distinta, quindi rispetto alla coppia che parte il
 * fattore E' l'identita'. Cio' che resta assunto — in quale unita' Plex legga `quantity`, cioe' la
 * UOM che la part ha sul tenant — era assunto identico anche PRIMA, per OGNI componente e non solo
 * per quelli in unita' alternativa: e' scritto per esteso nel blocco `bomQtyUom` di
 * syncRoutingPlexCycle, ed e' li' che quella lacuna e' gia' dichiarata. Il fattore `1` non aggiunge
 * un'affermazione: rende esplicita quella che la quantita' incorpora gia'.
 *
 * IL FATTORE E L'UNITA' VIAGGIANO INSIEME O NON VIAGGIANO. Sono emessi dallo stesso punto in
 * entrambi i corpi (create e patch) proprio perche' il vincolo e' del runtime e non del contratto:
 * separarli e' l'unico modo di far tornare quel 400, e il ramo PATCH ci sarebbe cascato dopo, con
 * il difetto rimasto invisibile fino alla prima correzione di quantita'.
 *
 * LEVA DI RIPRISTINO: `PLEX_BOM_DEPLETION_UOM=off` spegne la coppia intera (unita' + fattore) e
 * riporta al corpo di prima della W1-05. Non esiste una leva per il solo fattore: sarebbe
 * l'interruttore che riproduce il 400.
 */
const DEPLETION_FACTOR_FIELD = 'depletionConversionFactor';
const DEPLETION_FACTOR_VALUE = 1;

/**
 * L'unita' di consumo e il suo fattore, o niente. Punto UNICO di emissione della coppia, condiviso
 * da buildCreateBody e buildPatchBody: vedi il blocco qui sopra.
 * @param {object} body corpo da completare (mutato)
 * @param {*} depletionUnitOfMeasure
 */
function emitDepletion(body, depletionUnitOfMeasure) {
  const uom = toUom(depletionUnitOfMeasure);
  if (!uom) return;
  body[DEPLETION_UOM_FIELD] = uom;
  body[DEPLETION_FACTOR_FIELD] = DEPLETION_FACTOR_VALUE;
}

/** Tolleranza sul confronto delle quantita'. Era inline in cat-service.js. */
const QTY_TOLERANCE = 0.0005;

/**
 * Esiti del flag su una riga BOM. Chiavi stabili: entrano nel log, nel recap del job e nei test.
 */
const FLAG_STATE = Object.freeze({
  SENT:           'SENT',            // il campo e' partito in questa chiamata (POST o PATCH)
  VERIFIED_FALSE: 'VERIFIED_FALSE',  // la GET mostra il campo e vale false: l'UNICO esito verificato
  LEGACY_TRUE:    'LEGACY_TRUE',     // riga preesistente con true: doppio consumo possibile (RB-06)
  NOT_OBSERVABLE: 'NOT_OBSERVABLE',  // la riga c'e', il campo no: non verificabile (RB-07)
  DISABLED:       'DISABLED'         // leva spenta: il campo non viene inviato per scelta (RB-09)
});

/**
 * Gli esiti che degradano il ciclo a 'W'. Gemello di DEGRADING_STATES in recvOpRules.js.
 *
 * `SENT` NON degrada: la chiamata e' partita col campo e il contratto lo dichiara accettato.
 * Non e' ancora verificato, ma la verifica arriva gratis alla sincronizzazione successiva, dove
 * la GET riflette cio' che abbiamo scritto — tenere `SENT` fra le lacune renderebbe giallo ogni
 * ciclo appena inviato, cioe' il caso normale.
 */
const UNVERIFIED_STATES = Object.freeze([FLAG_STATE.LEGACY_TRUE, FLAG_STATE.NOT_OBSERVABLE]);

/**
 * [W1-05] Esiti dell'unita' su una riga BOM. Chiavi stabili: entrano nel log e nei test.
 *
 * PERCHE' SERVONO, visto che l'unita' non innesca nessuna chiamata. Perche' il PATCH resta
 * innescato dalla SOLA quantita' (perimetro W1-06: le righe gia' su Plex non si riscrivono), e
 * l'unita' non e' mai stata mandata prima: quindi le righe gia' sincronizzate con quantita'
 * invariata NON la riceveranno. E' un arretrato, ed e' una conseguenza accettata — ma un arretrato
 * che nessuno conta e' indistinguibile da «tutto allineato».
 */
const UOM_STATE = Object.freeze({
  SENT:      'SENT',       // la riga e' stata creata o aggiornata: l'unita' e' partita
  MATCH:     'MATCH',      // riga saltata, e su Plex c'e' gia' la nostra unita'
  STALE:     'STALE',      // riga saltata, e su Plex l'unita' manca o e' diversa: ARRETRATO
  NO_SOURCE: 'NO_SOURCE'   // non abbiamo un'unita' da mandare: il nodo di distinta non si e' risolto
});

// [LOG-MSG-I18N] `DECLARATION_MAX_CHARS` e' stato rimosso con la 0029. Il tetto non e' piu' un
// numero di caratteri di UNA frase: le dichiarazioni sono segmenti, e chi sfora scarta segmenti
// interi dalla coda dichiarando quanti (`logMessage.pack`). Prima era il troncamento a decidere
// in silenzio quali cause si dichiarassero.

/** Grafie stringa accettate come vero e come falso, per un booleano che arriva da un JSON altrui. */
const TRUE_TOKENS = new Set(['true', '1', 'y', 'yes', 't', 'on', 'x', 'si', 'sì']);
const FALSE_TOKENS = new Set(['false', '0', 'n', 'no', 'f', 'off']);

/** Valori che spengono una leva d'ambiente. Il default e' ACCESO. */
const OFF_TOKENS = new Set(['off', 'false', '0', 'no']);

/**
 * La leva e' accesa? Default acceso: il campo si manda salvo spegnimento esplicito.
 *
 * `PLEX_BOM_AUTODEPLETE=off` riporta il body a quello di prima di W1-06 senza un rilascio. E'
 * una leva d'esercizio, non un customizing: chi la spegne lo fa per isolare un problema, e il
 * fatto resta scritto nel log come esito `DISABLED` (RB-09).
 *
 * @param {*} raw valore grezzo della variabile d'ambiente
 * @returns {boolean}
 */
function isEnabled(raw) {
  if (raw === null || raw === undefined) return true;
  return !OFF_TOKENS.has(String(raw).trim().toLowerCase());
}

/** Numero utilizzabile come quantita', con lo stesso ripiego a 0 del chiamante. */
function toQuantity(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * [W1-05] L'unita' da mettere nel body, oppure `''` se non c'e' niente da dire.
 *
 * `''` NON SI MANDA, e la differenza conta: un campo assente significa «non lo dico», una stringa
 * vuota scriverebbe su Plex un'unita' di consumo VUOTA — cioe' cancellerebbe un valore che
 * qualcuno potrebbe aver messo a mano. Il caso non e' teorico: e' il ripiego `DEFAULT_COMP_UNIT`
 * di cat-service.js, che resta quando il nodo di distinta non si risolve.
 */
function toUom(value) {
  return String(value ?? '').trim();
}

/**
 * Body del POST /engineering/v1/boms (AddBomComponentDto).
 *
 * Senza `sendFlag`, senza `sendValidate` e senza unita' il body e' identico a quello inviato prima
 * di W1-06 — tre campi, nello stesso ordine: e' il ramo delle leve spente, e il test lo verifica
 * byte per byte perche' una leva che «quasi» ripristina il comportamento di prima non serve a
 * niente.
 *
 * L'ORDINE DELLE CHIAVI E' QUELLO DEL FOGLIO `3.BOM` — identita', `quantity`,
 * `depletionUnitOfMeasure`, `validate`, `autoDeplete`. Non e' estetica: e' l'unica regola d'ordine
 * non arbitraria disponibile, e rende immediato il confronto fra il JSON loggato e la riga del
 * field mapping per chi deve verificarlo.
 *
 * `partOperationId` e `componentId` sono IDENTITA' e il chiamante le ha gia' garantite (salta il
 * componente senza l'una o l'altra): qui non si inventano e non si validano, come per i
 * LOCKED_FIELDS di srv/lib/plexOpFieldMapper.js.
 *
 * @param {{partOperationId: string, componentId: string, quantity: *,
 *          depletionUnitOfMeasure: *, sendValidate: boolean, sendFlag: boolean}} args
 * @returns {object}
 */
function buildCreateBody({
  partOperationId, componentId, quantity, depletionUnitOfMeasure, sendValidate, sendFlag
} = {}) {
  const body = {
    partOperationId,
    componentId,
    quantity: toQuantity(quantity)
  };
  emitDepletion(body, depletionUnitOfMeasure);
  if (sendValidate) body[VALIDATE_FIELD] = VALIDATE_VALUE;
  if (sendFlag) body[AUTODEPLETE_FIELD] = AUTODEPLETE_VALUE;
  return body;
}

/**
 * Body del PATCH /engineering/v1/boms/{id} (UpdateBomComponentDto).
 *
 * NIENTE CAMPI D'IDENTITA' (RB-03). Il body inviato prima di W1-06 portava `partOperationId` e
 * `componentId`, che in UpdateBomComponentDto non esistono — ed era su un `PUT`, verbo che la BOM
 * API non prevede: sono i due motivi per cui quel ramo con ogni probabilita' non ha mai
 * funzionato. Il contratto e' in srv/external/PLEX_BOM_API_CONTRACT.md.
 *
 * Si mandano i soli campi che vogliamo cambiare: e' un PATCH, e ogni campo di quel DTO e'
 * opzionale. Aggiungerne altri «per completezza» significherebbe riscrivere valori che su Plex
 * qualcuno potrebbe aver messo a mano.
 *
 * [W1-05] L'unita' viaggia con la quantita' A COSTO ZERO, come gia' fa il flag: questo PATCH e'
 * innescato dalla quantita' cambiata e parte comunque, quindi correggere anche l'unita' non
 * aggiunge una chiamata. Cio' che NON succede e' l'opposto: un'unita' diversa da sola non fa
 * partire niente (vedi `decideBomAction`, che non la guarda).
 *
 * @param {{quantity: *, depletionUnitOfMeasure: *, sendValidate: boolean, sendFlag: boolean}} args
 * @returns {object}
 */
function buildPatchBody({ quantity, depletionUnitOfMeasure, sendValidate, sendFlag } = {}) {
  const body = { quantity: toQuantity(quantity) };
  emitDepletion(body, depletionUnitOfMeasure);
  if (sendValidate) body[VALIDATE_FIELD] = VALIDATE_VALUE;
  if (sendFlag) body[AUTODEPLETE_FIELD] = AUTODEPLETE_VALUE;
  return body;
}

/**
 * Le righe BOM di una risposta Plex, nelle quattro forme che il progetto gia' incontra:
 * array nudo, `{ value: [...] }`, `{ results: [...] }`, `{ data: [...] }`.
 * @param {*} data
 * @returns {Array<object>}
 */
function extractBomList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.value)) return data.value;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * La chiave di idempotenza di una riga BOM: part-operation + componente, in un punto solo.
 * @param {*} partOperationId
 * @param {*} componentId
 * @returns {string}
 */
function bomKey(partOperationId, componentId) {
  return `${partOperationId}|${componentId}`;
}

/**
 * Il flag come booleano TOLLERANTE, a tre valori.
 *
 * Tollerante sulla grafia perche' il valore arriva dal JSON di un sistema esterno e non da un
 * campo che scriviamo noi; STRETTO sul significato: qualunque cosa non sia riconoscibile rende
 * `null`, cioe' «non lo so», che e' un esito diverso da `false`. Inventare un `false` su un
 * valore illeggibile significherebbe dichiarare verificato cio' che non lo e' (RB-04).
 *
 * @param {*} v
 * @returns {boolean|null} null quando non c'e' niente di concludibile
 */
function readFlagValue(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'number') {
    if (v === 1) return true;
    if (v === 0) return false;
    return null; // 2, -1, NaN: non e' una grafia booleana, non si arrotonda
  }
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (TRUE_TOKENS.has(t)) return true;
    if (FALSE_TOKENS.has(t)) return false;
    return null;
  }
  return null; // null, undefined, oggetti, array
}

/**
 * Il nome della chiave del flag effettivamente presente nella riga.
 *
 * Serve al log di scoperta e alla domanda «il campo e' osservabile su questo tenant?». Il
 * confronto e' per FORMA normalizzata (minuscolo, senza `_` e `-`) perche' qui si LEGGE: se il
 * tenant consegnasse `AutoDeplete` o `auto_deplete` il valore va comunque letto. Il nome che si
 * SCRIVE resta `AUTODEPLETE_FIELD` e non si deriva da qui (DEC-28).
 *
 * @param {object} row
 * @returns {string|null} il nome ORIGINALE della chiave, come Plex l'ha mandata
 */
function findFlagField(row) {
  if (!row || typeof row !== 'object') return null;
  const wanted = AUTODEPLETE_FIELD.toLowerCase();
  for (const key of Object.keys(row)) {
    if (row[key] === undefined) continue; // chiave presente ma vuota di significato
    if (key.toLowerCase().replace(/[_-]/g, '') === wanted) return key;
  }
  return null;
}

/**
 * Una riga della GET /engineering/v1/boms, nella forma che la mappa di idempotenza conserva.
 *
 * Gli alias di `partOperationId` e `componentPartId` sono ESATTAMENTE i tre di prima di W1-06 e
 * nello stesso ordine di precedenza, senza aggiunte: un alias in piu' includerebbe righe che
 * oggi vengono scartate e cambierebbe la decisione fra saltare e creare su dati reali. Il
 * contratto dice `partOperationId` / `componentPartId` / `id`; le grafie alternative restano per
 * non toccare un comportamento collaudato.
 *
 * @param {object} row
 * @returns {{partOperationId: string|null, componentPartId: string|null, bomId: string|null,
 *            quantity: *, autoDeplete: (boolean|null), flagField: string|null}}
 */
function readBomRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  const partOperationId = r.partOperationId || r.PartOperationId || r.partOperationID || null;
  const componentPartId = r.componentPartId || r.componentId || r.ComponentPartId || null;
  const flagField = findFlagField(r);
  return {
    partOperationId,
    componentPartId,
    bomId: r.id || r.Id || null,
    quantity: r.quantity,
    // [W1-05] L'unita' che Plex ha OGGI sulla riga. E' l'unica cosa che distingue «arretrato da
    // riallineare» da «gia' a posto», e senza di lei `UOM_STATE.STALE` sarebbe una supposizione.
    depletionUnitOfMeasure: toUom(r.depletionUnitOfMeasure ?? r.DepletionUnitOfMeasure),
    autoDeplete: flagField ? readFlagValue(r[flagField]) : null,
    flagField
  };
}

/**
 * Il flag e' osservabile in questa risposta? Verdetto UNA volta per part, non per riga.
 *
 * Con zero righe la risposta e' `observable: false`, ma NON e' una lacuna: non c'era niente da
 * osservare. E' il chiamante a non dichiarare nulla quando `rows === 0` — la trappola piu' facile
 * di questa funzione, e per questo sta scritta qui.
 *
 * @param {Array<object>} rows righe grezze della GET
 * @returns {{observable: boolean, field: string|null, rows: number, withField: number}}
 */
function bomListObservability(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let withField = 0;
  let field = null;
  for (const row of list) {
    const f = findFlagField(row);
    if (f) {
      withField++;
      if (!field) field = f;
    }
  }
  return { observable: withField > 0, field, rows: list.length, withField };
}

/**
 * Creare, aggiornare o saltare una riga BOM, considerando quantita' E flag.
 *
 * Le quantita' comandano le CHIAMATE, il flag comanda solo la DICHIARAZIONE: nessun PATCH parte
 * per il solo flag. E' una scelta di perimetro — le righe gia' su Plex non si riscrivono — e non
 * un'omissione: una riga trovata con `autoDeplete: true` resta un doppio consumo possibile, ed e'
 * per questo che diventa `LEGACY_TRUE` e degrada l'esito del ciclo invece di sparire (RB-05,
 * RB-06).
 *
 * @param {object} args
 * @param {object|null} args.existing riga da readBomRow(), o null se assente su Plex
 * @param {*} args.desiredQuantity
 * @param {boolean} args.enabled leva d'invio del campo
 * @param {number} [args.tolerance=QTY_TOLERANCE]
 * @returns {{action: 'POST'|'PATCH'|'SKIP',
 *            reason: 'ABSENT'|'QTY'|'SAME'|'NO_ID',
 *            flagState: string, sendFlag: boolean, qtyChanged: boolean}}
 */
function decideBomAction({ existing, desiredQuantity, enabled, tolerance } = {}) {
  const sendFlag = enabled !== false;
  const tol = Number.isFinite(tolerance) ? tolerance : QTY_TOLERANCE;
  const desired = toQuantity(desiredQuantity);

  // Assente su Plex: si crea, e la riga nasce col flag (o senza, a leva spenta).
  if (!existing) {
    return {
      action: 'POST',
      reason: 'ABSENT',
      flagState: sendFlag ? FLAG_STATE.SENT : FLAG_STATE.DISABLED,
      sendFlag,
      qtyChanged: false
    };
  }

  const observed = existing.autoDeplete === undefined ? null : existing.autoDeplete;
  // Lo stato che l'osservazione da' sola, senza tener conto di cosa manderemo.
  let observedState;
  if (observed === false) observedState = FLAG_STATE.VERIFIED_FALSE;
  else if (observed === true) observedState = FLAG_STATE.LEGACY_TRUE;
  else observedState = sendFlag ? FLAG_STATE.NOT_OBSERVABLE : FLAG_STATE.DISABLED;

  const currentQty = toQuantity(existing.quantity);
  const qtyChanged = Math.abs(currentQty - desired) >= tol;

  if (!qtyChanged) {
    return { action: 'SKIP', reason: 'SAME', flagState: observedState, sendFlag, qtyChanged: false };
  }

  // Quantita' cambiata: serve l'id della riga (dalla GET). Senza id non si puo' aggiornare, ed e'
  // il comportamento di prima — qui si aggiunge solo che il flag osservato resta dichiarato.
  if (!existing.bomId) {
    return { action: 'SKIP', reason: 'NO_ID', flagState: observedState, sendFlag, qtyChanged: true };
  }

  // La riga viene riscritta comunque per la quantita': il flag viaggia con lei, a costo zero.
  return {
    action: 'PATCH',
    reason: 'QTY',
    flagState: sendFlag ? FLAG_STATE.SENT : observedState,
    sendFlag,
    qtyChanged: true
  };
}

/**
 * [W1-05] L'esito dell'unita' su una riga, DATA la decisione gia' presa da `decideBomAction`.
 *
 * NON DECIDE NIENTE, E' LA RAGIONE PER CUI E' UNA FUNZIONE A PARTE. L'azione la sceglie
 * `decideBomAction` guardando la sola quantita': qui si osserva soltanto cosa succede all'unita'
 * come conseguenza. Fonderle darebbe la tentazione di far scattare un PATCH per l'unita', che e'
 * esattamente la decisione presa in senso contrario.
 *
 * L'ORDINE DEI CASI CONTA. `NO_SOURCE` viene per primo perche' e' una causa NOSTRA — il nodo di
 * distinta non risolto della prima parte di W1-05 — e va tenuta separata da `STALE`, che e' invece
 * un arretrato su Plex: confonderle manderebbe a cercare il problema dalla parte sbagliata.
 *
 * @param {object} args
 * @param {object|null} args.existing riga da `readBomRow`, o null se assente su Plex
 * @param {*} args.desiredUom l'unita' che manderemmo
 * @param {'POST'|'PATCH'|'SKIP'} args.action da `decideBomAction`
 * @returns {string} uno di UOM_STATE
 */
function uomState({ existing, desiredUom, action } = {}) {
  const desired = toUom(desiredUom);
  if (!desired) return UOM_STATE.NO_SOURCE;
  if (action === 'POST' || action === 'PATCH') return UOM_STATE.SENT;
  // Riga saltata: l'unita' non parte, quindi conta solo cosa c'e' gia' su Plex.
  const current = toUom(existing && existing.depletionUnitOfMeasure);
  return current === desired ? UOM_STATE.MATCH : UOM_STATE.STALE;
}

/**
 * [W1-05] Conteggi degli esiti dell'unita' su tutte le righe trattate.
 * Gemello di `summarizeFlagStates`, e per lo stesso scopo: una riga sola nel log del ciclo.
 * @param {Array<string>} states
 * @returns {{total: number, sent: number, match: number, stale: number, noSource: number}}
 */
function summarizeUomStates(states) {
  const list = Array.isArray(states) ? states : [];
  const counts = { total: list.length, sent: 0, match: 0, stale: 0, noSource: 0 };
  for (const s of list) {
    if (s === UOM_STATE.SENT) counts.sent++;
    else if (s === UOM_STATE.MATCH) counts.match++;
    else if (s === UOM_STATE.STALE) counts.stale++;
    else if (s === UOM_STATE.NO_SOURCE) counts.noSource++;
  }
  return counts;
}

/**
 * [W1-05][LOG-MSG-I18N] I segmenti che dichiarano l'esito dell'unita'. Vuoti se non c'e' niente da
 * dire.
 *
 * «Niente da dire» e' il caso in cui ogni riga ha ricevuto o gia' possiede l'unita' giusta. Gli
 * altri due si dicono SEMPRE, e con parole diverse: `stale` e' l'arretrato che il perimetro
 * scelto non riallinea, `noSource` e' una quantita' che non siamo riusciti a risolvere a monte.
 *
 * DALLA 0029 SONO SEGMENTI E NON UNA FRASE, e la differenza non e' di forma. Prima le due cause
 * finivano in una stringa sola, tagliata a 200 caratteri: era il TRONCAMENTO a decidere quali cause
 * si dichiarassero. Ora ogni causa e' un segmento con la sua chiave i18n, `logMessage.pack` scarta
 * segmenti INTERI dalla coda e dichiara quanti — quindi l'ordine qui sotto e' l'ordine di importanza
 * e non un dettaglio. E il testo si rende nella lingua di chi guarda, non in quella di chi ha
 * lanciato l'invio.
 *
 * Modulo PURO: qui si scelgono le chiavi, la resa e' di srv/lib/i18nMessages.js.
 *
 * @param {{total: number, stale: number, noSource: number}} counts da `summarizeUomStates`
 * @returns {Array<{c: string, p?: Array}>}
 */
function uomDeclarationSegments(counts) {
  const c = counts || {};
  if (!c.total) return [];
  const out = [];
  if (c.stale) out.push({ c: 'logBomUomStale', p: [String(c.stale), DEPLETION_UOM_FIELD] });
  if (c.noSource) out.push({ c: 'logBomUomNoSource', p: [String(c.noSource), DEPLETION_UOM_FIELD] });
  return out;
}

/**
 * Conteggi degli esiti del flag su tutte le righe trattate.
 * @param {Array<string>} states
 * @returns {{total: number, sent: number, verified: number, legacyTrue: number,
 *            notObservable: number, disabled: number, unverified: number}}
 */
function summarizeFlagStates(states) {
  const list = Array.isArray(states) ? states : [];
  const counts = {
    total: list.length,
    sent: 0,
    verified: 0,
    legacyTrue: 0,
    notObservable: 0,
    disabled: 0,
    unverified: 0
  };
  for (const s of list) {
    if (s === FLAG_STATE.SENT) counts.sent++;
    else if (s === FLAG_STATE.VERIFIED_FALSE) counts.verified++;
    else if (s === FLAG_STATE.LEGACY_TRUE) counts.legacyTrue++;
    else if (s === FLAG_STATE.NOT_OBSERVABLE) counts.notObservable++;
    else if (s === FLAG_STATE.DISABLED) counts.disabled++;
    if (UNVERIFIED_STATES.includes(s)) counts.unverified++;
  }
  return counts;
}

/** L'esito degrada l'esito del ciclo a 'W'? Gemello di degradesSend() in recvOpRules.js. */
function degradesRouting(state) {
  return UNVERIFIED_STATES.includes(state);
}

/**
 * [LOG-MSG-I18N] I segmenti da mettere nel messaggio di log, o `[]` se non c'e' niente da dire.
 *
 * Ogni causa col SUO nome e mai fuse insieme (DEC-56): «N righe hanno il flag attivo su Plex» e'
 * una lista di righe da correggere a mano, «il campo non compare nella risposta» e' una domanda
 * per Rockwell. Chiamarle allo stesso modo manderebbe la persona sbagliata a cercare la cosa
 * sbagliata — e un segmento per causa e' la forma che rende quella regola strutturale invece di
 * affidata al `join('; ')`.
 *
 * @param {object} counts da summarizeFlagStates
 * @returns {Array<{c: string, p?: Array}>}
 */
function flagDeclarationSegments(counts) {
  const c = counts || {};
  const out = [];
  if (c.legacyTrue > 0) out.push({ c: 'logBomAutodepleteActive', p: [String(c.legacyTrue)] });
  if (c.notObservable > 0) out.push({ c: 'logBomAutodepleteUnknown', p: [String(c.notObservable)] });
  return out;
}

module.exports = {
  AUTODEPLETE_FIELD,
  AUTODEPLETE_VALUE,
  // [W1-05] unita' di consumo e `validate`, dal foglio 3.BOM del field mapping Ariston
  DEPLETION_UOM_FIELD,
  VALIDATE_FIELD,
  VALIDATE_VALUE,
  DEPLETION_FACTOR_FIELD,
  DEPLETION_FACTOR_VALUE,
  UOM_STATE,
  QTY_TOLERANCE,
  FLAG_STATE,
  UNVERIFIED_STATES,
  isEnabled,
  buildCreateBody,
  buildPatchBody,
  uomState,
  summarizeUomStates,
  uomDeclarationSegments,
  extractBomList,
  bomKey,
  readFlagValue,
  findFlagField,
  readBomRow,
  bomListObservability,
  decideBomAction,
  summarizeFlagStates,
  degradesRouting,
  flagDeclarationSegments
};

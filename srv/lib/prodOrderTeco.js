/**
 * [ORDER-TECO] Chiusura tecnica dell'ordine riportata su Plex (feature 0023, gap W1-13).
 *
 * Perimetro completo della feature: grep -rn "ORDER-TECO"
 *
 * COSA RISOLVE. La BBP §8.2.2 chiede «una interfaccia dedicata SAP -> Plex» che tracci in Plex la
 * chiusura tecnica o anticipata dell'ordine eseguita in SAP, e §9.1.2.1 la indica come la via per
 * chiudere l'ordine senza intervento manuale. Prima della 0023 il TECO era letto SOLO come flag di
 * PERIMETRO (`OrderIsTechnicallyCompleted` nel catalogo di prodOrderStatusFilter.js), cioe' serviva
 * a tenere l'ordine FUORI scope: su Plex non si scriveva niente, il job restava nella lista di
 * lavoro del centro di lavoro e nessuno in fabbrica sapeva che in SAP l'ordine era chiuso.
 *
 * QUESTO MODULO E' LA PARTE VERIFICABILE SENZA SISTEMI ESTERNI: il catalogo dei flag, la
 * valutazione del criterio, la scelta dei lotti, la forma del payload verso la Data Source Plex,
 * le transizioni di stato e i testi del recap. L'orchestrazione (le chiamate a SAP e a Plex, la
 * persistenza) sta in srv/jobs/closeTecoPlexJobs.js.
 *     node test/prodOrderTeco.test.js
 *
 * GEMELLO DICHIARATO DI prodOrderStatusFilter.js, da cui riusa il CATALOGO dei flag di stato e la
 * normalizzazione delle liste: sono gli stessi campi di A_ProductionOrder_2, e un secondo catalogo
 * divergerebbe al primo campo aggiunto. Ma la SEMANTICA e' opposta di proposito:
 *
 *   ZProdOrderFilterConfig   AND fra i flag   descrive un PERIMETRO  («devono valere tutti»)
 *   ZProdOrderTecoConfig     OR  fra i flag   descrive un EVENTO     («e' successa una di queste»)
 *
 * Non allineare le due semantiche senza leggere docs/0023-teco-verso-plex.md: un AND qui
 * significherebbe «chiudi solo gli ordini che sono TECO *e* CLSD *e* cancellati», cioe' quasi
 * nessuno.
 *
 * UN FLAG CITATO E NON RESTITUITO dalla sorgente non e' «non impostato»: e' un criterio NON
 * VALUTABILE, e l'ordine non scatta. Qui la conseguenza di sbagliare non e' una lista incompleta
 * ma una SCRITTURA su un sistema esterno, quindi il dubbio si risolve non facendo niente e
 * dichiarandolo (stessa scelta di `orderPasses`, ragione diversa).
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

const {
  STATUS_CATALOG, parseList, formatList, isSet, LIST_MAX_LENGTH
} = require('./prodOrderStatusFilter');
// [LOG-MSG-I18N] I messaggi di questo modulo sono SEGMENTI (feature 0031): chiave i18n piu'
// parametri, non prosa. Il testo si rende dove si scrive — il job — perche' rendere qui vorrebbe
// dire leggere i bundle da disco, e questo modulo si collauda senza toccare niente.
const logMsg = require('./logMessage');
// Il plant delle righe la cui attribuzione non e' stata possibile. NON si ricopia il letterale:
// e' lo stesso valore che i job scrivono e che il gate di licenza lascia passare (jobCodes.js).
const { PLANT_NA: PLANT_UNKNOWN } = require('./jobCodes');

/**
 * FQN come stringa e non `db.entities(NS)`: quello e' deprecato in CAP 9 e non e' invocabile in
 * contesto job standalone. Stessa scelta di prodOrderStatusFilter.js e dei job.
 */
const NS = 'avvaleplm.marsplm.sap2plex';
const E_TECO_CONFIG = `${NS}.ZProdOrderTecoConfig`;
const E_TECO_STATE = `${NS}.ZProdOrderTecoState`;

/**
 * Stati di ZProdOrderTecoState.
 *   D  TECO rilevato, chiusura su Plex non ancora applicata (interruttore spento o DS assente)
 *   P  scrittura IN CORSO: la riga e' stata prenotata e la Data Source sta per partire
 *   A  applicato: la Data Source di chiusura ha risposto ok
 *   K  niente da fare: Plex non conosce nessun job con quel numero
 *   E  fallito, ritentabile al prossimo run
 *   X  tentativi esauriti
 */
const STATE = Object.freeze({
  DETECTED: 'D', CLAIMED: 'P', APPLIED: 'A', NOTHING: 'K', FAILED: 'E', EXHAUSTED: 'X'
});

/**
 * Stati TERMINALI: un lotto che li porta non torna piu' fra i candidati.
 *
 * 'X' e' terminale di proposito, e la conseguenza va detta: un lotto che ha esaurito i tentativi
 * resta APERTO su Plex e non verra' piu' ritentato da solo. Per questo il run in cui ci finisce lo
 * registra con status 'X' (TotalExhausted, che NON cambia l'exit code — vedi runJob.js) invece di
 * lasciarlo scivolare via in silenzio.
 */
const TERMINAL_STATES = Object.freeze([STATE.APPLIED, STATE.NOTHING, STATE.EXHAUSTED]);

/** Esiti possibili del trattamento di un lotto. */
const OUTCOME = Object.freeze({
  APPLIED: 'applied',    // la Data Source di chiusura ha risposto ok
  ABSENT: 'absent',      // Plex non ha un job con quel numero
  PENDING: 'pending',    // rilevato ma non applicato: interruttore spento o DS non configurata
  REFUSED: 'refused',    // Job_Key non ricavabile senza ambiguita': NON si scrive
  FAILED: 'failed',      // la chiamata e' stata fatta e non e' riuscita
  // Un tentativo precedente e' morto DOPO la prenotazione: la chiamata puo' essere partita o no.
  // Non si ritenta (DEC-60: un esito non conclusivo e' piu' pericoloso di un rifiuto) e non si
  // archivia in silenzio: diventa 'X', che significa gia' «resta APERTO su Plex, dichiarato».
  STRANDED: 'stranded'
});

/** `trim` e nient'altro. */
function s(v) {
  return String(v ?? '').trim();
}

/** Troncamento per i campi String(n) dello stato: HANA impone i limiti, sqlite no. */
function cut(v, n) {
  return v === null || v === undefined ? null : String(v).slice(0, n);
}

// ================================================================
// Validazione del customizing
// ================================================================

/**
 * Validazione di una riga di ZProdOrderTecoConfig.
 *
 * Restituisce gli errori invece di sollevare, come `validateFilter`: il chiamante e' un handler
 * `before` che deve poter emettere `req.error` con il `target` giusto.
 *
 * UNA RIGA CON L'INTERRUTTORE ACCESO E NESSUN CRITERIO VIENE RIFIUTATA. Non e' pedanteria: senza
 * criteri nessun ordine scatterebbe mai, e la schermata mostrerebbe una configurazione «attiva»
 * che non chiude niente — indistinguibile da un flusso che non funziona. E' la stessa regola per
 * cui una regola di visibilita' senza campi valorizzati e' rifiutata (DEC-27).
 *
 * @param {{ IsEnabled?: boolean, TriggerStatuses?: string }} row
 * @returns {{ errors: Array<{field: string, code: string, tokens?: string[]}>,
 *             TriggerStatuses: string, triggers: string[] }}
 */
function validateTecoConfig(row) {
  const parsed = parseList(row && row.TriggerStatuses);
  const errors = [];

  if (parsed.unknown.length) {
    errors.push({ field: 'TriggerStatuses', code: 'unknown', tokens: parsed.unknown });
  }

  const value = formatList(parsed.codes);
  if (value.length > LIST_MAX_LENGTH) errors.push({ field: 'TriggerStatuses', code: 'tooLong' });

  const enabled = row && (row.IsEnabled === true || row.IsEnabled === 'true');
  if (enabled && !parsed.codes.length) {
    errors.push({ field: 'TriggerStatuses', code: 'requiredWhenEnabled' });
  }

  return { errors, TriggerStatuses: value, triggers: parsed.codes };
}

// ================================================================
// Valutazione di un ordine
// ================================================================

/**
 * L'ordine e' chiuso in SAP secondo il criterio del suo plant?
 *
 * OR fra i flag configurati: basta UNO impostato. `missing` = flag citati dal criterio che non sono
 * arrivati sulla riga; con `missing` non vuoto `fired` e' sempre false, anche se un altro flag
 * della lista e' impostato — se la sorgente non consegna parte del criterio, quello che si sta
 * valutando non e' il criterio configurato, ed e' meglio non scrivere su Plex e dirlo.
 *
 * TUTTI I FLAG SCATTATI, NON SOLO IL PRIMO. `flag` resta il primo — e' la colonna `TriggerStatus`,
 * `String(40)`, che ne contiene uno solo — ma `flags` porta l'elenco intero, che il chiamante mette
 * nei segmenti del messaggio (persistiti in `LastMessageJson`). Un ordine che in SAP e' TECO **e**
 * chiuso accende due flag: registrandone uno solo si perde meta' dell'informazione, e la si perde
 * per sempre — il lotto diventa terminale e nessuno lo guarda piu'.
 *
 * @param {object} order riga di A_ProductionOrder_2
 * @param {{triggers: string[]}} cfg
 * @returns {{ fired: boolean, flag: string|null, flags: string[], missing: string[] }} `flag` = il
 *          PRIMO flag impostato nell'ordine del criterio: e' quello che finisce su
 *          ZProdOrderTecoState e risponde alla domanda «perche' questo ordine e' stato chiuso?».
 */
function triggerOf(order, cfg) {
  const row = order || {};
  const triggers = (cfg && cfg.triggers) || [];
  const missing = triggers.filter((f) => row[f] === undefined || row[f] === null);
  if (missing.length) return { fired: false, flag: null, flags: [], missing };
  const flags = triggers.filter((f) => isSet(row[f]));
  return { fired: flags.length > 0, flag: flags[0] || null, flags, missing: [] };
}

/**
 * I campi da aggiungere al `$select` perche' i criteri in vigore siano valutabili: unione su tutti
 * i plant, nell'ordine del catalogo. Stessa forma di `selectColumns` della 0017, perche' la
 * lettura e' una sola per tutti i plant.
 */
function selectColumns(cfgs) {
  const list = cfgs instanceof Map ? [...cfgs.values()] : [...(cfgs || [])];
  const out = new Set();
  for (const cfg of list) for (const f of (cfg && cfg.triggers) || []) out.add(f);
  return STATUS_CATALOG.filter((f) => out.has(f));
}

/**
 * Il criterio spingibile nella query, se esiste.
 *
 * Solo in `ONPREM`, e solo quando TUTTI i plant in perimetro dichiarano LO STESSO UNICO flag: con
 * un OR fra due flag un `where` di uguaglianze non lo esprime (sarebbe un AND), e in `IS` i flag
 * di stato non hanno select-option dietro l'iFlow (contratto E-13, richiesta R-2b). Negli altri
 * casi si legge il perimetro plant e si valuta a valle — che e' esattamente cio' che fa il job
 * ordini dalla 0017.
 *
 * @returns {object|null} il `where` da aggiungere, oppure null
 */
function pushableTrigger(cfgs, mode) {
  if (mode === 'IS') return null;
  const list = cfgs instanceof Map ? [...cfgs.values()] : [...(cfgs || [])];
  if (!list.length) return null;
  const first = (list[0].triggers || []);
  if (first.length !== 1) return null;
  if (!list.every((c) => (c.triggers || []).length === 1 && c.triggers[0] === first[0])) return null;
  return { [first[0]]: 'X' };
}

// ================================================================
// Quali lotti si verificano
// ================================================================

/** Chiave composta di un lotto, usata come identita' in memoria. */
function lotKey(order, jobNumber) {
  return `${s(order)}|${s(jobNumber)}`;
}

/**
 * I lotti da verificare, a partire dal dizionario ZProdOrderPlexMapping e dallo stato TECO.
 *
 * NESSUN PRE-FILTRO SU `SplitState` NE' SU `Status`, ed e' la regola piu' importante di questo
 * modulo. Un ordine spacchettato ha N job veri su Plex — il lotto principale con la quantita'
 * residua e ogni pacchetto — e vanno chiusi TUTTI. Chi dice se un job esiste e' PLEX, con la
 * lettura della Data Source 4216, non un codice di stato scritto da noi:
 *
 *   - `SplitState` 'P' (pacchetto in creazione), 'L' (da agganciare) e 'U' (esito incerto) sono
 *     esattamente i casi in cui il job PUO' esistere su Plex mentre la nostra riga dice altro:
 *     escluderli lascerebbe pacchetti aperti in lista di lavoro proprio nei casi dubbi;
 *   - `Status` 'E' / 'W' e' l'esito dell'ULTIMO INVIO, non l'esistenza del job: un aggiornamento
 *     fallito lascia 'E' su un job che esiste da giorni.
 *
 * Si esclude solo cio' che e' gia' stato deciso: i lotti in stato TECO terminale.
 *
 * IL PLANT E' L'ALTRO ASSE, E NON CONTRADDICE LA REGOLA QUI SOPRA. Quella riguarda «il job esiste su
 * Plex?», a cui risponde Plex; questo e' il gate di perimetro (RB-24), che ogni altro job applica per
 * primo. Un lotto di un plant fuori perimetro non compare mai nella lista SAP — che filtra sui plant
 * configurati — quindi finiva a OGNI run nel ripiego per chiave, bruciava il budget di letture e
 * produceva lo stesso avviso per sempre.
 *
 * DUE GUARDIE, E STANNO QUI DENTRO E NON NEI CHIAMANTI. Un insieme di plant che non e' un insieme, o
 * che e' VUOTO, non pota niente: «vuoto» non e' «ignoto», ed e' la stessa regola di `pruneOrphans`
 * (DEC-107). E un lotto il cui plant e' vuoto o `'#NA'` resta candidato: `'#NA'` e' il plant delle
 * righe la cui attribuzione non e' stata possibile, cioe' precisamente «non lo so» — e su «non lo so»
 * non si pota. L'errore e' asimmetrico: tenere un lotto di troppo costa una lettura, toglierne uno
 * significa un job che resta aperto in fabbrica e nessuno che lo sappia.
 *
 * @param {Array<object>} mappingRows righe di ZProdOrderPlexMapping
 * @param {Array<object>} stateRows righe di ZProdOrderTecoState
 * @param {{plants?: Iterable<string>}} [opts] `plants` = i plant in perimetro; assente o vuoto = non
 *        si pota per plant
 * @returns {Array<object>} `{ ManufacturingOrder, PlexJobNumber, PlexJobId, Plant, CreatedAt,
 *          SplitState, prevState, attempts }`
 */
function candidateLots(mappingRows, stateRows, opts = {}) {
  const rows = Array.isArray(mappingRows) ? mappingRows : [];
  const byKey = new Map();
  for (const st of (Array.isArray(stateRows) ? stateRows : [])) {
    byKey.set(lotKey(st.ManufacturingOrder, st.PlexJobNumber), st);
  }

  // Le due guardie: un insieme non iterabile e un insieme vuoto non potano niente.
  const wanted = opts && opts.plants && typeof opts.plants[Symbol.iterator] === 'function'
    ? new Set([...opts.plants].map(s).filter(Boolean))
    : null;
  const prunes = !!(wanted && wanted.size);

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const order = s(r && r.ManufacturingOrder);
    const job = s(r && r.PlexJobNumber);
    if (!order || !job) continue;
    const key = lotKey(order, job);
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = byKey.get(key);
    if (prev && TERMINAL_STATES.includes(s(prev.State))) continue;
    // Il plant del lotto: dal dizionario, o dallo stato TECO che lo ha gia' imparato.
    const plant = s(r && r.Plant) || s(prev && prev.Plant);
    if (prunes && plant && plant !== PLANT_UNKNOWN && !wanted.has(plant)) continue;
    out.push({
      ManufacturingOrder: order,
      PlexJobNumber: job,
      PlexJobId: r.PlexJobId || (prev && prev.PlexJobId) || null,
      Plant: plant || null,
      CreatedAt: (r && r.CreatedAt) || null,
      SplitState: r.SplitState || null,
      SplitSequence: r.SplitSequence === undefined ? null : r.SplitSequence,
      MappingStatus: r.Status || null,
      prevState: prev ? s(prev.State) : null,
      attempts: prev && Number(prev.Attempts) > 0 ? Number(prev.Attempts) : 0
    });
  }
  // Lotto principale prima dei pacchetti, poi per numero: un log leggibile vale il sort.
  out.sort((a, b) => (a.ManufacturingOrder.localeCompare(b.ManufacturingOrder))
    || (a.PlexJobNumber.length - b.PlexJobNumber.length)
    || a.PlexJobNumber.localeCompare(b.PlexJobNumber));
  return out;
}

// ================================================================
// Il ponte con Plex
// ================================================================

/** Lettura tollerante di un campo di una riga Data Source: i nomi arrivano da SQL scritto altrove. */
function field(row, ...names) {
  if (!row || typeof row !== 'object') return undefined;
  for (const n of names) {
    if (row[n] !== undefined) return row[n];
  }
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const hit = lower.get(String(n).toLowerCase());
    if (hit) return row[hit];
  }
  return undefined;
}

/**
 * Le righe di una risposta Data Source (`?format=2`), CON il verdetto sulla forma.
 *
 * PERCHE' IL VERDETTO SERVE. Un lettore che restituisce solo le righe non puo' distinguere
 * `{rows: []}` — Plex dice «non c'e' nessun job con quel numero» — da un corpo che non abbiamo
 * capito. Qui la differenza e' tutto: la prima e' un'ASSENZA, che porta il lotto in `'K'`, stato
 * TERMINALE da cui non torna mai piu'; la seconda e' un guasto, che va ritentato. Con un lettore
 * solo, un cambio di envelope della Data Source archivierebbe in silenzio ogni lotto come «niente
 * da chiudere», e i job resterebbero aperti in lista di lavoro senza che una riga lo dica.
 *
 * E' la regola di DEC-112 («una forma di risposta non riconosciuta non e' un tenant vuoto») e di
 * DEC-80 («non lo so» non diventa «non c'e'»), applicate qui. Un corpo `null` — un `200` senza
 * corpo — NON e' una forma riconosciuta: la forma dichiarata da `?format=2` porta `rows`.
 *
 * @param {*} body il corpo gia' parsato della risposta
 * @returns {{ rows: Array<object>, recognized: boolean }}
 */
function readDsRows(body) {
  if (Array.isArray(body)) return { rows: body, recognized: true };
  if (body && typeof body === 'object' && Array.isArray(body.rows)) {
    return { rows: body.rows, recognized: true };
  }
  return { rows: [], recognized: false };
}

/**
 * La chiave interna del job Plex, dalle righe della Data Source 4216 (`Job_No` -> `Job_Key`).
 *
 * PIU' STRETTO del «si usa la prima riga» del passo 6.1 di createPlexProductionOrders.js, e la
 * differenza e' la posta in gioco: la' con quella chiave si LEGGONO le operazioni, qui ci si
 * CHIUDE un job. Non e' documentato se il filtro su `Job_No` della Data Source sia per uguaglianza
 * o per prefisso, e il codice dei pacchetti INIZIA con il numero d'ordine: prendere la prima riga
 * potrebbe chiudere il job di un altro lotto.
 *
 * Con una riga sola la si usa anche se il `Job_No` non coincide — e' il caso di un tenant che
 * applica prefisso o suffisso al numero job (`PLEX_JOB_NUMBER_PREFIX`) — ma il `Job_No` tornato
 * viene riportato al chiamante, che lo scrive nel log: una divergenza resta visibile.
 *
 * UN ARRAY NON VUOTO DA CUI NON SOPRAVVIVE NESSUNA RIGA non e' un'assenza: e' una forma che non
 * riconosciamo, e va tenuta distinta per la stessa ragione di `readDsRows` — l'assenza e' terminale.
 *
 * @param {Array<object>} rows righe della DS 4216
 * @param {string} jobNumber il lotto richiesto
 * @returns {{ jobKey: number|null, jobNo: string|null,
 *             reason: 'exact'|'single'|'absent'|'unknownShape'|'ambiguous'|'notNumeric' }}
 */
function pickJobKey(rows, jobNumber) {
  const all = Array.isArray(rows) ? rows : [];
  const list = all.filter((r) => r && typeof r === 'object');
  if (!list.length) {
    return { jobKey: null, jobNo: null, reason: all.length ? 'unknownShape' : 'absent' };
  }

  const wanted = s(jobNumber);
  const exact = list.filter((r) => {
    const no = field(r, 'Job_No', 'JobNo', 'Job_Number');
    return no !== undefined && s(no) === wanted;
  });

  let chosen = null;
  let reason = null;
  if (exact.length === 1) {
    chosen = exact[0];
    reason = 'exact';
  } else if (exact.length > 1) {
    return { jobKey: null, jobNo: wanted, reason: 'ambiguous' };
  } else if (list.length === 1) {
    chosen = list[0];
    reason = 'single';
  } else {
    return { jobKey: null, jobNo: null, reason: 'ambiguous' };
  }

  const raw = field(chosen, 'Job_Key', 'JobKey');
  const jobNo = field(chosen, 'Job_No', 'JobNo', 'Job_Number');
  // Il parametro della Data Source di chiusura e' un `int`: un valore non intero non si manda,
  // perche' Plex lo rifiuterebbe o — peggio — lo convertirebbe.
  const num = Number(raw);
  if (raw === undefined || raw === null || s(raw) === '' || !Number.isInteger(num)) {
    return { jobKey: null, jobNo: jobNo === undefined ? null : s(jobNo), reason: 'notNumeric' };
  }
  return { jobKey: num, jobNo: jobNo === undefined ? null : s(jobNo), reason };
}

/**
 * Lo stato che si manda a Plex per dire «questo job e' chiuso».
 *
 * E' UNA COSTANTE E NON UNA LEVA, di proposito. Il foglio *TBD-Status Update - Closed job* lo
 * dichiara hardcode, e non e' un parametro di tuning: e' il contratto del passo. Una leva
 * inviterebbe a cercarci una soluzione il giorno in cui la chiamata viene rifiutata, mentre la
 * risposta giusta sarebbe farsi dire dal tenant quali stati esistono.
 *
 * NON e' il nome di uno stato del tenant che abbiamo verificato: e' il valore che il foglio dichiara,
 * e la Data Source lo traduce (o lo rifiuta) per conto suo. Per questo non si confronta con i nomi
 * di stato che la Connect API restituisce, se non per DICHIARARE (DEC-65).
 */
const JOB_STATUS_TECO = 'TECO';

/**
 * Il payload della Data Source di chiusura (id 23101, «Update Job status Closed»).
 *
 * UNICO PUNTO che conosce la forma. Dal foglio *TBD-Status Update - Closed job* di
 * `Ariston - API List_FinalVersion.xlsx`:
 *   Job_Key     int      la chiave interna del job, dalla 4216
 *   Job_Status  string   `"TECO"`, dichiarato hardcode
 * Il corpo e' PIATTO e la chiamata usa `?format=2`, come le altre Data Source in esercizio: la forma
 * annidata e' solo quella del servizio di ordinamento (DEC-37).
 *
 * DAL 03/09/2026 QUESTA E' LA SECONDA FORMA che questa funzione ha avuto: fino a quel giorno la
 * chiusura era la 19529 `Job_Complete`, con `{Job_Key, Checkbox}` — un `bit` di cui non abbiamo mai
 * saputo il significato. Il secondo parametro e' ora una stringa e un dato, non un flag: la vecchia
 * discussione «`1` verso Plex e `'X'` verso SAP» non si applica piu' a questo corpo, e resta valida
 * dove i flag SAP viaggiano davvero (`pushableWhere` in prodOrderStatusFilter.js).
 *
 * Se un giorno la Data Source pretendesse un altro valore o un altro nome di campo, si cambia QUI e
 * in nessun altro punto — e il test se ne accorge, perche' verifica la stringa JSON esatta.
 *
 * @param {number} jobKey
 * @returns {{Job_Key: number, Job_Status: string}}
 */
function buildTecoInputs(jobKey) {
  // `Number(null)` e `Number('')` valgono 0, che E' un intero: senza questo controllo un lotto
  // senza chiave partirebbe come `Job_Key: 0`, cioe' una chiamata su un job che non e' il nostro.
  const key = (jobKey === null || jobKey === undefined || s(jobKey) === '') ? NaN : Number(jobKey);
  if (!Number.isInteger(key)) {
    throw new Error(`[ORDER-TECO] Job_Key non intero: ${jobKey}`);
  }
  return { Job_Key: key, Job_Status: JOB_STATUS_TECO };
}

/** Lo stato letto su Plex E' quello che abbiamo mandato? Confronto TOLLERANTE sulla grafia. */
function isTecoStatus(status) {
  return s(status).trim().toUpperCase() === JOB_STATUS_TECO;
}

/**
 * Esito della chiamata alla Data Source di chiusura.
 *
 * L'ORACOLO E' L'HTTP, ED E' UNA SCELTA. La 23101, a differenza della 19529 che ha sostituito,
 * DICHIARA un esito applicativo: `outputs.Result_Code` e `outputs.Result_Message`. Non lo usiamo
 * come verdetto perche' della sua polarita' abbiamo UNA sola osservazione — `1` con `"Success"` —
 * e una regola d'esito costruita su un campione solo sbaglia in entrambi i versi: archivierebbe
 * come fallita una chiusura passata, o come riuscita una rifiutata. Il giorno in cui la polarita'
 * e' confermata la regola si aggiunge ACCANTO a questa e a scegliere e' la FORMA della risposta,
 * come per le conferme d'ordine (DEC-119) — non si sostituisce.
 *
 * Il corpo viene comunque riassunto nel messaggio, e nella risposta osservata `outputs` viene per
 * PRIMO: `Result_Message` sta quindi dentro i 120 caratteri di `describeBody`, e chi guarda lo
 * storico lo legge. Il corpo intero resta in `ResponseJson` della riga di storico.
 *
 * Il corpo e' testo di TERZI: viaggia in un segmento `technical`, che non si traduce. Tradurre il
 * corpo di una risposta di Plex vorrebbe dire nasconderlo.
 *
 * @param {{ok: boolean, status: number, body: any}} response
 * @returns {{ kind: string, segments: Array }}
 */
function interpretTecoResponse(response) {
  const r = response || {};
  const excerpt = describeBody(r.body);
  const tail = excerpt ? [logMsg.technical(excerpt)] : [];
  if (r.ok) {
    return {
      kind: OUTCOME.APPLIED,
      segments: [logMsg.seg('logTecoClosed', r.status), ...tail]
    };
  }
  return {
    kind: OUTCOME.FAILED,
    segments: [logMsg.seg('logTecoCloseFailed', r.status || 0), ...tail]
  };
}

/** Riassunto del corpo di una risposta, per il messaggio di stato. */
function describeBody(body) {
  if (body === null || body === undefined || body === '') return '';
  try {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return s(text).slice(0, 120);
  } catch (e) {
    return '';
  }
}

// ================================================================
// Transizioni di stato
// ================================================================

/**
 * Lo stato successivo di un lotto.
 *
 * Il conteggio dei tentativi cresce solo dove c'e' stata una DECISIONE nostra di scrivere o un
 * rifiuto: un lotto rilevato e non applicato perche' l'interruttore e' spento non consuma
 * tentativi — non e' un tentativo, e' un'attesa (stessa regola di DEC-60 per la chiamata che non
 * parte).
 *
 * @param {{attempts?: number}} prev
 * @param {{kind: string, segments?: Array}} outcome
 * @param {number} maxAttempts
 * @returns {{ State: string, Attempts: number, segments: Array }}
 */
function nextState(prev, outcome, maxAttempts = 3) {
  const attempts = Math.max(0, Number((prev && prev.attempts) || 0));
  const kind = (outcome && outcome.kind) || OUTCOME.FAILED;
  const segments = logMsg.normalize(outcome && outcome.segments);
  const max = Number(maxAttempts) > 0 ? Number(maxAttempts) : 3;

  if (kind === OUTCOME.APPLIED) return { State: STATE.APPLIED, Attempts: attempts + 1, segments };
  if (kind === OUTCOME.ABSENT) return { State: STATE.NOTHING, Attempts: attempts, segments };
  if (kind === OUTCOME.PENDING) return { State: STATE.DETECTED, Attempts: attempts, segments };
  // Prenotazione orfana: la chiamata PUO' essere partita. Non si ritenta e non si archivia in
  // silenzio — 'X' significa gia' «resta APERTO su Plex», non degrada l'exit code e il recap lo
  // dice. Il tentativo era gia' stato contato dalla prenotazione, quindi `attempts` non cresce.
  if (kind === OUTCOME.STRANDED) {
    return { State: STATE.EXHAUSTED, Attempts: attempts, segments };
  }

  // REFUSED e FAILED consumano un tentativo. L'ambiguita' di Job_No e' conteggiata come un
  // fallimento di proposito: senza, un lotto irrisolvibile verrebbe riproposto per sempre e
  // ogni run chiuderebbe in attenzione.
  const used = attempts + 1;
  return {
    State: used >= max ? STATE.EXHAUSTED : STATE.FAILED,
    Attempts: used,
    segments: used >= max
      ? [...segments, logMsg.seg('logTecoAttemptsExhausted', used, max)]
      : segments
  };
}

/** Lo status di recap di un lotto, dal suo esito. */
function lotRecordStatus(state) {
  if (state === STATE.APPLIED || state === STATE.NOTHING || state === STATE.DETECTED) return 'S';
  if (state === STATE.EXHAUSTED) return 'X';
  return 'E';
}

/**
 * L'esito di un ORDINE, dai suoi lotti.
 *
 * Un ordine spacchettato in cui un solo pacchetto non si chiude NON e' un ordine chiuso: senza
 * questa distinzione un ordine parzialmente chiuso finirebbe fra i riusciti, e il pacchetto
 * rimasto aperto in lista di lavoro non lo saprebbe nessuno.
 *
 * @param {Array<{State: string}>} lots
 * @returns {{ status: 'S'|'W', closed: number, total: number, partial: boolean, segments: Array }}
 */
function orderOutcome(lots) {
  const list = Array.isArray(lots) ? lots : [];
  const total = list.length;
  const closed = list.filter((l) => l && (l.State === STATE.APPLIED || l.State === STATE.NOTHING)).length;
  const pending = list.filter((l) => l && l.State === STATE.DETECTED).length;
  const broken = total - closed - pending;
  const partial = total > 0 && broken > 0 && closed > 0;
  const status = broken > 0 ? 'W' : 'S';
  let segments;
  if (!total) segments = [logMsg.seg('logTecoNoLots')];
  else if (pending === total) segments = [logMsg.seg('logTecoAllPending', total)];
  else if (broken === 0) segments = [logMsg.seg('logTecoAllClosed', closed, total)];
  else segments = [logMsg.seg('logTecoPartiallyClosed', closed, total, broken)];
  return { status, closed, total, partial, segments };
}

// ================================================================
// Contatori e recap
// ================================================================

/** Contatori vuoti di un plant. */
function emptyStat() {
  return {
    orders: 0, lots: 0, applied: 0, nothing: 0, pending: 0, failed: 0, exhausted: 0,
    // Lotti rimasti in coda senza che il criterio scattasse: vedi `addTecoStale`.
    stale: 0, staleSince: null
  };
}

/**
 * I lotti che a fine run sono ancora in coda senza essere scattati, e da quando.
 *
 * PERCHE' SI CONTANO. Un lotto esce dai candidati SOLO con uno stato terminale: un ordine che non
 * scatta mai resta in coda a ogni esecuzione, per sempre. La crescita pero' e' il SINTOMO, non la
 * causa — in SAP ogni ordine prima o poi si chiude, quindi la coda si drena da se' SE i flag
 * configurati corrispondono a quello che il plant fa davvero. Configurato `OrderIsTechnicallyCompleted`
 * mentre in fabbrica si usa CLSD, la coda cresce e non c'e' niente che lo dica: il job continua a
 * chiudere in verde «0 ordini trattati», che e' indistinguibile da «non c'era niente da fare».
 *
 * E' un'informazione e NON degrada il run (DEC-39): non e' un guasto, e' il segnale che il criterio
 * va rivisto. La data piu' vecchia e' cio' che rende leggibile la differenza fra «ieri» e «da un anno».
 */
function addTecoStale(stats, plant, since) {
  const key = s(plant) || PLANT_UNKNOWN;
  const st = (stats[key] || (stats[key] = emptyStat()));
  st.stale += 1;
  const when = since ? String(since instanceof Date ? since.toISOString() : since) : null;
  if (when && (!st.staleSince || when < st.staleSince)) st.staleSince = when;
  return st;
}

/**
 * Accumula l'esito di un lotto nei contatori del plant.
 * Oggetto piatto passato dal job, come `addSortStat` della 0014: il modulo puro non conosce il db.
 */
function addTecoStat(stats, plant, state) {
  const key = s(plant) || '#NA';
  const st = (stats[key] || (stats[key] = emptyStat()));
  st.lots += 1;
  if (state === STATE.APPLIED) st.applied += 1;
  else if (state === STATE.NOTHING) st.nothing += 1;
  else if (state === STATE.DETECTED) st.pending += 1;
  else if (state === STATE.EXHAUSTED) st.exhausted += 1;
  else st.failed += 1;
  return st;
}

/** Conta un ordine con TECO rilevato per il plant (una volta, non per lotto). */
function addTecoOrder(stats, plant) {
  const key = s(plant) || '#NA';
  const st = (stats[key] || (stats[key] = emptyStat()));
  st.orders += 1;
  return st;
}

/**
 * UNA voce di recap per plant, non una per lotto.
 *
 * La cadenza per oggetto produrrebbe una riga di attenzione per lotto a ogni esecuzione e quindi
 * una mail ricorrente per sempre: e' il rischio R-03 della 0014, e la risposta e' la stessa.
 * `degrade` e' true SOLO se qualcosa e' rimasto aperto: un plant che non ha niente da chiudere, o
 * che ha la chiusura non abilitata, e' un'informazione e non un'anomalia (DEC-39).
 *
 * [LOG-MSG-I18N] Un segmento PER CAUSA e non una frase concatenata: quando il JSON sfora, `pack`
 * scarta segmenti interi dalla coda e dichiara quanti — con una stringa unica si perderebbe il
 * troncamento a metà parola, e sarebbe il troncamento a decidere cosa si dichiara. L'ordine e'
 * quello di importanza: cio' che resta aperto su Plex viene prima di cio' che e' andato bene.
 *
 * @param {object} stats mappa plant -> contatori
 * @returns {Array<{plant: string, status: 'S'|'W', degrade: boolean, segments: Array}>}
 */
function tecoRecapEntries(stats) {
  const out = [];
  for (const plant of Object.keys(stats || {}).sort()) {
    const st = stats[plant] || emptyStat();
    const broken = st.failed + st.exhausted;
    const segments = [logMsg.seg('logTecoRecapHead', st.orders, st.lots)];
    if (st.exhausted) segments.push(logMsg.seg('logTecoRecapExhausted', st.exhausted));
    if (st.failed) segments.push(logMsg.seg('logTecoRecapFailed', st.failed));
    if (st.applied) segments.push(logMsg.seg('logTecoRecapApplied', st.applied));
    if (st.nothing) segments.push(logMsg.seg('logTecoRecapNothing', st.nothing));
    if (st.pending) segments.push(logMsg.seg('logTecoRecapPending', st.pending));
    // In coda da sempre: il criterio configurato non aggancia quello che il plant fa davvero.
    if (st.stale) {
      segments.push(logMsg.seg('logTecoRecapStale', st.stale, (st.staleSince || '').slice(0, 10)));
    }
    out.push({
      plant,
      status: broken > 0 ? 'W' : 'S',
      degrade: broken > 0,
      segments
    });
  }
  return out;
}

// ================================================================
// Caricamento del customizing
// ================================================================

/**
 * Il customizing dei plant indicati, con le liste gia' normalizzate.
 *
 * NESSUN `try/catch`, per la stessa ragione di `loadProdOrderFilterConfig`: inghiottire l'errore
 * significherebbe «nessun plant configurato», cioe' spacciare un guasto del database per una
 * scelta dell'utente. I token fuori catalogo di una riga GIA' persistita si ignorano invece di far
 * fallire la lettura: la validazione li rifiuta alla scrittura.
 *
 * @param {object} db
 * @param {Iterable<string>} [plants] se omesso, tutti i plant configurati
 * @returns {Promise<Map<string, {Plant: string, IsEnabled: boolean, triggers: string[]}>>}
 */
async function loadTecoConfig(db, plants) {
  const wanted = plants ? [...plants].map(s).filter(Boolean) : null;
  const map = new Map();
  if (wanted && !wanted.length) return map;

  let q = SELECT.from(E_TECO_CONFIG).columns('Plant', 'IsEnabled', 'TriggerStatuses');
  if (wanted) q = q.where({ Plant: { in: wanted } });
  const rows = await db.run(q);

  for (const r of rows || []) {
    const plant = s(r.Plant);
    if (!plant) continue;
    map.set(plant, {
      Plant: plant,
      IsEnabled: r.IsEnabled === true || r.IsEnabled === 1 || r.IsEnabled === 'true',
      triggers: parseList(r.TriggerStatuses).codes
    });
  }
  return map;
}

/**
 * Perimetro effettivo: quali plant candidati hanno una configurazione UTILIZZABILE e quali no.
 *
 * Una riga senza `TriggerStatuses` non e' una configurazione: non c'e' criterio da valutare, quindi
 * il plant finisce fra i non configurati e il job lo dichiara. La validazione impedisce di
 * salvarla con l'interruttore acceso, ma una riga creata e mai compilata puo' esistere.
 *
 * @returns {Promise<{ byPlant: Map, configured: string[], unconfigured: string[] }>}
 */
async function resolveTecoScope(db, plants) {
  const candidates = [...(plants || [])].map(s).filter(Boolean).sort();
  const all = await loadTecoConfig(db, candidates);
  const byPlant = new Map();
  for (const [plant, cfg] of all) {
    if (cfg.triggers.length) byPlant.set(plant, cfg);
  }
  const configured = candidates.filter((p) => byPlant.has(p));
  const unconfigured = candidates.filter((p) => !byPlant.has(p));
  return { byPlant, configured, unconfigured };
}

/** Riga leggibile per il log: i criteri in vigore, per plant. */
function describeTriggers(cfgByPlant) {
  const byPlant = cfgByPlant instanceof Map ? cfgByPlant : new Map();
  const parts = [];
  for (const plant of [...byPlant.keys()].sort()) {
    const cfg = byPlant.get(plant) || {};
    parts.push(`${plant}: ${(cfg.triggers || []).join(' OR ') || '(nessuno)'}`
      + ` [chiusura su Plex ${cfg.IsEnabled ? 'ABILITATA' : 'non abilitata'}]`);
  }
  return parts.length ? parts.join(' | ') : '(nessun plant configurato)';
}

module.exports = {
  // costanti
  STATE, TERMINAL_STATES, OUTCOME, E_TECO_CONFIG, E_TECO_STATE, NS, JOB_STATUS_TECO,
  // customizing
  validateTecoConfig, loadTecoConfig, resolveTecoScope, describeTriggers,
  // valutazione
  triggerOf, selectColumns, pushableTrigger,
  // lotti
  candidateLots, lotKey,
  // Plex
  readDsRows, pickJobKey, buildTecoInputs, interpretTecoResponse, isTecoStatus,
  // stato e recap
  nextState, lotRecordStatus, orderOutcome,
  addTecoStat, addTecoOrder, addTecoStale, tecoRecapEntries,
  // utilita' condivise col job
  cut
};

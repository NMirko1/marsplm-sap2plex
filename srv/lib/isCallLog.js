/**
 * [IS-CALL-LOG] Traccia delle letture verso SAP, leggibile dalla console del BROWSER.
 *
 * PERCHE' ESISTE
 * Ogni lettura delle tre aree in perimetro passa da srv/lib/isRemoteSource.js, che ne stampa
 * una riga per lettura (M-07, isRemoteSource.js:318). Quella riga finisce in `cf logs`: chi
 * collauda dal browser non vede l'indirizzo usato, i criteri inviati, né cosa è tornato. E
 * siccome sulle destination degli ambienti interni i path `/gw/odata` non esistono, il sintomo
 * tipico di una chiamata mal indirizzata è una lista vuota senza spiegazione (0013, flusso E).
 * Qui le stesse letture si accumulano in un anello in memoria che la function
 * `isCallLog` (CatalogService) restituisce al browser.
 *
 * NON DUPLICA NESSUNA CHIAMATA. A differenza di `routingListDiag`, che rifà la lettura degli
 * header per raccontarne l'esito, questo modulo registra la lettura VERA nel punto in cui
 * `run()` la descrive già: nessuna richiesta in più verso l'Integration Suite.
 *
 * L'URL REALE
 * L'unico dato che `run()` non ha in mano è l'URL che CAP costruisce dentro
 * libx/_runtime/remote/utils/client.js. Lo si prende dalla sua fonte: quel file fa
 *     LOG.debug(`${method} ${destination.url}${requestConfig.url}`, { headers })
 * con `LOG = cds.log('remote')`, sotto la guardia `LOG._debug` (client.js:10-21,46).
 * `cds.log(module, level)` è API pubblica e MUTA IN PLACE l'oggetto logger cachato
 * (lib/log/cds-log.js:45-65): il `const LOG` già catturato da client.js vede quindi sia il
 * nuovo livello sia il `.debug` sostituito qui. Se il livello debug non lo aveva chiesto
 * l'operatore, la riga NON viene ristampata: il volume di `cf logs` non cambia.
 * Se una versione futura di CAP cambia quella riga, `urls` resta vuoto e tutto il resto
 * continua a funzionare — per questo ogni voce porta anche `request`, ricostruita dal CQN.
 *
 * CORRELAZIONE URL <-> LETTURA
 * Con una AsyncLocalStorage aperta attorno all'esecuzione delle chiamate di un `run()`: il
 * fan-out a concorrenza 8 e i chunk sequenziali ereditano lo store, quindi tutti gli URL di
 * quella lettura finiscono nella stessa voce.
 *
 * LIMITI, DA TENERE PRESENTI LEGGENDO IL LOG
 *   - L'anello è PER PROCESSO. mta.yaml fissa `instances: 1` per il server web, quindi è
 *     coerente; ogni voce porta comunque CF_INSTANCE_INDEX perché uno scale-up sia visibile.
 *   - I sette job batch NON compaiono NEL BROWSER: girano in processi separati (il fork di
 *     `[JOB-TRIGGER]`, `cf run-task`, `npm run job-*`) che nessuna rotta HTTP raggiunge. Per loro
 *     il canale sono la riga M-07 e il DUMP su stdout qui sotto.
 *   - `firstRow` è un campione dei dati letti, troncato: esce verso il browser, quindi gli
 *     header sono sempre mascherati (maskHeaders) e non si registra mai un body di richiesta.
 *
 * ------------------------------------------------------------------
 * [IS-CALL-LOG] DUMP — L'ANELLO ESCE SU STDOUT DOVE NESSUN BROWSER ARRIVA (02/09/2026)
 * ------------------------------------------------------------------
 * In un processo batch questo anello moriva col processo senza che nessuno lo leggesse: le letture
 * di un job erano visibili solo attraverso M-07, che porta criteri e righe. Il 02/09/2026 la stessa
 * lettura ordini ha reso 41 righe dal cockpit e 0 da un run batch, e stabilire quale delle tre
 * variabili in ballo (canale, `$top`, `$select`) fosse la causa è costato tre deploy su DEV — mentre
 * il corpo CRUDO e l'URL completo, che questo anello aveva già in mano, avrebbero chiuso la
 * diagnosi al primo run.
 *
 * IL CRITERIO E' DELLA VOCE, NON DEL RUN, e le due alternative cadono entrambe:
 *   - un dump a FINE RUN non può funzionare: l'anello tiene 200 voci e un run di MAT_SYNC ne
 *     produce centinaia, quindi la lettura di perimetro — cioè proprio quella dell'incidente — è
 *     già stata sfrattata; e `process.exit()` su una pipe tronca un burst di corpi;
 *   - un dump LEGATO ALL'ESITO non c'è quando serve: uno zero silenzioso chiude `S`.
 * Quindi ogni voce si dichiara appena nasce, adiacente alla sua riga M-07 — così non può essere
 * sfrattata dall'anello né perduta da un SIGKILL, e non c'è nessun burst.
 *
 * Le regole di selezione e la resa stanno in `srv/lib/isCallDumpRules.js`, che è puro: non ha modo
 * di fare una chiamata, ed è così che DEC-72 («una sonda non si innesca da sola») è verificata dalla
 * forma del modulo invece che promessa. Gli header non escono MAI (DEC-96): `cf logs` è un canale
 * conservato e inoltrabile, e `SECRET_HEADER` è una denylist, che non copre un nome nuovo.
 *
 * Spegnimento: IS_CALL_LOG=off (padrone: senza anello non ci sono voci, quindi nessun dump).
 * Capienza: IS_CALL_LOG_SIZE (default 200). Dump: IS_CALL_LOG_DUMP=off|on|all,
 * IS_CALL_LOG_DUMP_MAX (default 20 corpi per processo).
 * Diagnostica di collaudo: da rimuovere a migrazione conclusa, `grep -rn "IS-CALL-LOG"`.
 *
 * Nessuna dipendenza da `cds` al require: l'unico punto che lo usa è `installRemoteTap()`,
 * che lo richiede al suo interno. Così il test gira con `node test/isCallLog.test.js`,
 * senza runtime CAP. La proprietà RESTA VERA con il dump: `isCallDumpRules` richiede solo
 * `isEgress`, e nessuno dei due tocca `cds`.
 */

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
// [IS-CALL-LOG] Le regole del dump, pure: nessuna dipendenza da `cds`, quindi il test di questo
// file continua a girare senza runtime CAP.
const Rules = require('./isCallDumpRules');

/** Spento del tutto: nessun tap, nessuna voce, la function risponde vuota. */
const OFF = String(process.env.IS_CALL_LOG || '').trim().toLowerCase() === 'off';

/** Voci conservate. Ogni voce sta in qualche centinaio di byte: 200 = poche decine di KB. */
const CAPACITY = Number(process.env.IS_CALL_LOG_SIZE) > 0 ? Number(process.env.IS_CALL_LOG_SIZE) : 200;

/** URL riportati per voce; oltre, si dichiara solo quanti altri ce ne sono state. */
const MAX_URLS = 5;

/**
 * Tetto per singolo URL. Deve stare largo: l'URL COMPLETO è il dato per cui esiste questa
 * traccia, e un `$select` di 13 campi più un `$filter` con 15 valori supera i 700 caratteri.
 * Troncare qui vorrebbe dire perdere proprio la coda della query — dove stanno i criteri.
 */
const MAX_URL_LEN = 1500;

/** Tetti di troncamento, allineati alle lunghezze dichiarate dalla function in cat-service.cds. */
const LIMITS = {
  // [IS-CHANNEL] Su quale canale la lettura e' uscita. Allineato a `String(30)` sul tipo CDS.
  destination: 30,
  root: 300,
  criteria: 500,
  columns: 1000,
  urls: 6000,
  request: 1000,
  headers: 1000,
  notes: 1000,
  error: 1000,
  responseBody: 2000,
  firstRow: 500,
  // Il corpo CRUDO sta largo: e' il dato per cui esiste il tap sulla risposta, e su una collection
  // di 196 campi 2000 caratteri mostrerebbero un quinto della prima riga.
  rawBody: 8000,
  responseContentType: 100
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SECRET_HEADER = /authorization|apikey|api-key|cookie|token|secret|password/i;

/** Prima riga del log di CAP: `<METODO> <url>`. Tutto il resto (`Executing via ...`) si scarta. */
const REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\S[\s\S]*)$/;

const als = new AsyncLocalStorage();

const buf = [];
let nextSeq = 1;
let tapped = false;
let responseTapped = false;

// ================================================================
// Parte pura: formattazione, mascheratura, anello
// ================================================================

function safeStringify(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

function cut(v, n) {
  const s = safeStringify(v);
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/**
 * Header mascherati e serializzati. Escono verso il browser, quindi `authorization` non deve
 * passare di lì: CAP ne sanifica solo il valore echeggiato nell'errore (client.js:23-27) e
 * comunque il costo di rifarlo è nullo. Stessa regola di maskHeaders() in
 * srv/lib/materialDocPost.js (riscritta qui e non importata: quel modulo ha una sua eccezione,
 * `reveal`, che serve solo alla diagnosi del CSRF verso Cloud Integration).
 */
function maskHeaders(h) {
  if (!h || typeof h !== 'object') return '';
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADER.test(k) ? '***MASKED***' : v;
  return safeStringify(out);
}

/**
 * Riga di richiesta del log di CAP -> `{ method, url }`, oppure `null` se non è una richiesta.
 * L'URL può essere assoluto (`https://host/gw/odata/...`) oppure portare il nome della
 * destination fra angolari (`<MARS_SAP_CON>/gw/odata/...`) quando non è ancora risolta.
 */
function parseRequestLine(line) {
  if (typeof line !== 'string') return null;
  const m = REQUEST_LINE.exec(line.trim());
  if (!m) return null;
  const url = m[2].trim();
  if (!/^(https?:\/\/|<|\/)/.test(url)) return null;
  return { method: m[1], url };
}

/** `$select` effettivo, con gli `$expand` resi visibili: un expand di troppo è un bug in IS. */
function columnsOf(query) {
  const cols = query && query.SELECT && query.SELECT.columns;
  if (!Array.isArray(cols) || !cols.length) return '(tutti)';
  return cols
    .map((c) => {
      if (typeof c === 'string') return c;
      if (!c || typeof c !== 'object') return '?';
      const name = Array.isArray(c.ref) ? c.ref[c.ref.length - 1] : c.func || c.val || '?';
      return c.expand ? `${name}{expand}` : String(name);
    })
    .join(',');
}

/** Campione della risposta: la prima riga, troncata. Serve a vedere formato date e zeri iniziali. */
function sample(rows) {
  const first = Array.isArray(rows) ? rows[0] : rows;
  if (first === undefined || first === null) return '';
  return cut(first, LIMITS.firstRow);
}

/**
 * Ricostruzione della richiesta dal CQN. NON è l'URL inviato — è il ripiego quando il tap non
 * scatta, ed è dichiarata come tale nella console del browser.
 */
function requestLine({ root, entity, columns, criteria, top }) {
  const parts = [];
  if (columns && columns !== '(tutti)') parts.push(`$select=${columns}`);
  if (criteria && criteria !== '(nessuno)') parts.push(`criteri: ${criteria}`);
  if (top) parts.push(`$top=${top}`);
  return cut(`GET ${root || '(gateway on-premise)'}/${entity || '?'}${parts.length ? ` ? ${parts.join(' & ')}` : ''}`, LIMITS.request);
}

// ================================================================
// Registrazione
// ================================================================

/** Contesto di UNA lettura. `null` quando il log è spento: i chiamanti non devono ramificare. */
function begin() {
  return OFF ? null : {
    urls: [], urlCount: 0, headers: '',
    // riempiti dal tap sulla risposta, se ha agganciato
    httpStatus: 0, responseContentType: '', rawBody: '', rawHasD: false, rawSeen: false
  };
}

/**
 * LO SCAMBIO CRUDO, dalla risposta che CAP ha appena ricevuto e non ha ancora rimaneggiato.
 * FUNZIONE PURA: si collauda senza rete e senza CAP.
 *
 * PERCHE' ESISTE. Ogni chiamante registra la risposta DOPO `_purgeODataV2`
 * (remote/utils/client.js:120-124), che quando il wrapper `d` c'è **lo toglie**. Il corpo che
 * finiva nella traccia era quindi compatibile sia con una risposta OData corretta sia con una
 * grezza, e su quella base non si poteva concludere niente sulla forma — ma si continuava a
 * provarci. Qui si registra cosa e' arrivato davvero:
 *
 *   status                lo stato HTTP reale ANCHE sulle riuscite: prima lo avevamo solo sugli errori
 *   content-type          distingue un JSON OData da un XML convertito senza interpretare nulla
 *   rawBody               il corpo prima del purge
 *   rawHasD               `d` presente si'/no, come dato e non come ipotesi
 *
 * `rawSeen` dice che il tap ha agganciato: un tap che non scatta e un corpo davvero vuoto non
 * devono somigliarsi.
 *
 * @param {object} rec contesto della lettura, o `null` se la traccia e' spenta
 * @param {object} res risposta axios (`status`, `headers`, `data`)
 */
function annotateResponse(rec, res) {
  if (!rec || !res) return rec;
  const headers = res.headers || {};
  const ct = headers['content-type'] || headers['Content-Type'] || '';
  const data = res.data;
  rec.rawSeen = true;
  rec.httpStatus = Number(res.status) || 0;
  rec.responseContentType = cut(ct, LIMITS.responseContentType);
  rec.rawHasD = !!(data && typeof data === 'object' && !Array.isArray(data) && 'd' in data);
  rec.rawBody = data === undefined || data === null
    ? ''
    : cut(typeof data === 'string' ? data : safeStringify(data), LIMITS.rawBody);
  return rec;
}

/** Esegue `fn` dentro il contesto, così il tap sa a quale lettura attribuire gli URL. */
function within(rec, fn) {
  return rec ? als.run(rec, fn) : fn();
}

/**
 * Aggiunge una voce all'anello. Riceve i valori che `run()` ha già in mano; non calcola nulla
 * di nuovo e non può fallire in modo visibile al chiamante.
 */
function push(entry) {
  if (OFF) return null;
  let row = null;
  try {
    row = build(entry);
  } catch (e) {
    // Principio: si perde la voce, non la lettura. Un solo avviso, non uno per chiamata.
    if (!push._warned) {
      push._warned = true;
      console.warn(`>>> [IS-CALL-LOG] voce non registrata (${e.message}): la lettura prosegue`);
    }
    return null;
  }
  // [IS-CALL-LOG] Il dump ha il `try` SUO, e non è cosmetico: in coda al `try` di sopra un errore
  // di formattazione cadrebbe nel `catch` che stampa «voce non registrata», che sarebbe una BUGIA —
  // la riga è già nell'anello. Qui si perde il dump, non la voce.
  try {
    maybeDump(row);
  } catch (e) {
    if (!push._dumpWarned) {
      push._dumpWarned = true;
      console.warn(`>>> [IS-CALL-LOG] DUMP non emesso (${e.message}): la voce e' comunque nell'anello`);
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// [IS-CALL-LOG] DUMP — l'uscita su stdout per i processi che nessun browser raggiunge
// ---------------------------------------------------------------------------

/** Contatori del processo, per il censimento di fine run. */
const dump = { entries: 0, declared: 0, suppressed: 0, byReason: {}, announced: false, once: {} };

/**
 * Dichiara la voce su stdout se il criterio la seleziona.
 *
 * Il cancello si risolve A OGNI VOCE e non una volta al `require`: `runJob()` scrive il marcatore di
 * run batch DOPO i `require` del job, quindi una decisione presa al caricamento direbbe «server
 * web» in ogni job — la trappola di DEC-98. Il costo è una lettura d'ambiente per voce, e quando il
 * cancello è chiuso finisce lì.
 */
function maybeDump(row) {
  if (!row) return;
  dump.entries += 1;
  const gate = Rules.resolveDumpGate(process.env);
  if (!gate.on) return;

  const verdict = Rules.dumpVerdict(row, { all: gate.all });
  if (!verdict.dump) return;
  // Un motivo `once` è una proprietà del trasporto, non della lettura: su un canale dove il tap non
  // aggancia mai, ogni voce sarebbe notevole e il log diventerebbe illeggibile.
  if (verdict.once) {
    if (dump.once[verdict.reason]) return;
    dump.once[verdict.reason] = true;
  }

  if (!dump.announced) {
    dump.announced = true;
    console.log(Rules.activationLine(gate));
  }

  const full = gate.max === 0 || dump.declared < gate.max;
  if (!full) dump.suppressed += 1;
  dump.declared += 1;
  dump.byReason[verdict.reason] = (dump.byReason[verdict.reason] || 0) + 1;

  // UNA sola `console.log` con i `\n` dentro: lo stdout del figlio del fork è lo stesso del server
  // web, e una scrittura sola tiene le righe adiacenti anche sotto interleaving.
  const lines = Rules.dumpLines(row, {
    jobCode: gate.jobCode,
    pid: process.pid,
    reason: verdict.reason,
    bodyOmitted: !full,
    max: gate.max
  });
  console.log(lines.join('\n'));
}

/** Lo stato dei contatori, per chi scrive il censimento (runJob). */
function dumpStats() {
  const gate = Rules.resolveDumpGate(process.env);
  return {
    off: OFF,
    on: gate.on,
    why: gate.why,
    entries: dump.entries,
    declared: dump.declared,
    suppressed: dump.suppressed,
    byReason: { ...dump.byReason }
  };
}

/** La riga di censimento di fine run, già composta. */
function dumpCensus() {
  return Rules.censusLine(dumpStats());
}

function build(entry) {
  const rec = entry.rec || {};
  const urls = (rec.urls || []).slice();
  if (rec.urlCount > urls.length) urls.push(`(+${rec.urlCount - urls.length} altre chiamate)`);
  // Ripiego: sul ramo d'errore CAP conserva l'URL assoluto della chiamata fallita
  // (client.js:143). Se il tap non ha catturato nulla, quello è comunque l'indirizzo vero.
  if (!urls.length && entry.fallbackUrl) urls.push(`${cut(entry.fallbackUrl, MAX_URL_LEN)}  (dall'errore remoto)`);
  const row = {
    seq: nextSeq++,
    at: new Date().toISOString(),
    instance: String(process.env.CF_INSTANCE_INDEX || ''),
    area: entry.area || '',
    entity: entry.entity || '',
    op: entry.op || '',
    derivedOp: entry.derivedOp || '',
    mode: entry.mode || '',
    // [IS-CHANNEL] Le due destination del progetto puntano allo STESSO host CPI: negli `urls` due
    // letture su canali diversi sono indistinguibili, e questo campo e' l'unica cosa che le separa.
    destination: cut(entry.destination || '', LIMITS.destination),
    root: cut(entry.root || '(gateway on-premise)', LIMITS.root),
    form: entry.form || '',
    calls: Number(entry.calls) || 0,
    rows: Number(entry.rows) || 0,
    ms: Number(entry.ms) || 0,
    outcome: entry.outcome || '',
    criteria: cut(entry.criteria || '', LIMITS.criteria),
    columns: cut(entry.columns || '', LIMITS.columns),
    top: entry.top === undefined || entry.top === null ? 0 : Number(entry.top) || 0,
    urls: cut(urls.join('\n'), LIMITS.urls),
    request: cut(entry.request || '', LIMITS.request),
    headers: cut(rec.headers || '', LIMITS.headers),
    // Lo scambio CRUDO dal tap sulla risposta. `rawSeen` false = il tap non ha agganciato questa
    // chiamata (vedi installResponseTap): i tre campi sotto vanno letti come «non misurato», non
    // come «vuoto».
    rawSeen: !!rec.rawSeen,
    responseContentType: rec.responseContentType || '',
    rawHasD: !!rec.rawHasD,
    rawBody: cut(rec.rawBody || '', LIMITS.rawBody),
    // Lo stato reale: dal tap sulle riuscite, dal chiamante sugli errori.
    rawStatus: Number(rec.httpStatus) || 0,
    notes: cut((entry.notes || []).join(' | '), LIMITS.notes),
    error: cut(entry.error || '', LIMITS.error),
    upstreamStatus: Number(entry.upstreamStatus) || 0,
    responseBody: cut(entry.responseBody || '', LIMITS.responseBody),
    firstRow: cut(entry.firstRow || '', LIMITS.firstRow)
  };
  buf.push(row);
  if (buf.length > CAPACITY) buf.shift();
  return row;
}

/**
 * Voci successive a `sinceSeq`, in ordine cronologico, al massimo `limit`.
 *
 * DUE FINESTRE, E LA DIFFERENZA CONTA.
 *   `sinceSeq > 0` — c'è un punto da cui proseguire: si restituiscono le PIU' VECCHIE fra quelle
 *     nuove, così chiamate ripetute avanzano senza saltare niente. È ciò che serve al polling
 *     incrementale di una sequenza di letture.
 *   `sinceSeq` assente o 0 — non c'è nessun punto da cui proseguire, quindi la finestra giusta è
 *     la CODA dell'anello, non la testa. Prima non era così, ed è il difetto che rendeva la
 *     traccia inutile dopo qualche apertura del cockpit: il browser riparte da `iSince = 0` a ogni
 *     refresh, l'anello no (vive nel processo, capienza 200), e riceveva per sempre le stesse 50
 *     voci più vecchie — le letture appena fatte, quelle con l'MPL ID da girare, restavano in coda
 *     raggiungibili solo paginando a mano.
 *
 * Il risultato è comunque in ordine cronologico crescente: cambia da dove si taglia.
 */
function list({ sinceSeq, limit, area } = {}) {
  if (OFF) return [];
  const from = Number(sinceSeq) > 0 ? Number(sinceSeq) : 0;
  let n = Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT;
  if (n > MAX_LIMIT) n = MAX_LIMIT;
  const ammesse = buf.filter(row => row.seq > from && (!area || row.area === area));
  return from > 0 ? ammesse.slice(0, n) : ammesse.slice(-n);
}

/**
 * Svuota l'anello e riporta la numerazione a 1.
 *
 * La chiama l'action `isCallLogReset` all'apertura del cockpit, perché una traccia che sopravvive
 * ai refresh del browser accumula le letture di tutte le sessioni precedenti e seppellisce quelle
 * che si stanno cercando. **L'anello è unico per processo**: il reset vale per chiunque abbia il
 * cockpit aperto. Con `instances: 1` (mta.yaml) e uno strumento di collaudo è accettabile, ma è
 * bene saperlo prima di stupirsi che la traccia di un collega si sia azzerata.
 */
function clear() {
  buf.length = 0;
  nextSeq = 1;
  // [IS-CALL-LOG] Anche i contatori del dump: `seq` riparte da 1, e un censimento che citasse le
  // voci di prima sarebbe incoerente con i numeri che il log mostra. Nel server web l'azzeramento
  // arriva a ogni apertura del cockpit (`isCallLogReset`), ma là il censimento non si stampa: lo
  // scrive solo `runJob`.
  dump.entries = 0;
  dump.declared = 0;
  dump.suppressed = 0;
  dump.byReason = {};
  dump.announced = false;
  dump.once = {};
}

// ================================================================
// Tap sul log delle richieste remote di CAP
// ================================================================

/** Il livello debug su `remote` lo ha chiesto l'operatore? Se sì, la sua riga si ristampa. */
function operatorWantsDebug(cds) {
  const dbg = String(process.env.DEBUG || '');
  if (/(^|,)\s*(remote|all|y)\s*(,|$)/.test(dbg)) return true;
  const levels = (cds.env && cds.env.log && cds.env.log.levels) || {};
  const configured = String(levels.remote || '').toLowerCase();
  if (configured === 'debug' || configured === 'trace') return true;
  const existing = cds.log.loggers && cds.log.loggers.remote;
  return !!(existing && existing._debug);
}

/**
 * Idempotente: alza `remote` a debug e sostituisce `.debug` con la cattura. Va invocata una
 * volta sola, al primo `build()` di una sorgente di area.
 * @returns {boolean} true se il tap è attivo
 */
function installRemoteTap() {
  if (OFF) return false;
  if (tapped) return true;
  try {
    const cds = require('@sap/cds');
    const echo = operatorWantsDebug(cds);
    // Muta in place il logger cachato: il `const LOG` di client.js vede il nuovo `.debug`.
    const LOG = cds.log('remote', 'debug');
    const original = LOG.debug;
    LOG.debug = function (...args) {
      try {
        const rec = als.getStore();
        if (rec) {
          const parsed = parseRequestLine(args[0]);
          if (parsed) {
            rec.urlCount++;
            if (rec.urls.length < MAX_URLS) rec.urls.push(cut(`${parsed.method} ${parsed.url}`, MAX_URL_LEN));
            const h = args[1] && args[1].headers;
            if (h && !rec.headers) rec.headers = maskHeaders(h);
          }
        }
      } catch (e) {
        // La diagnostica non può rompere una lettura: si perde la voce, non la chiamata.
      }
      if (echo) return original.apply(this, args);
    };
    tapped = true;
    // [IS-CALL-LOG] Dove si legge la traccia dipende dal PROCESSO: in un run batch quell'endpoint
    // OData esiste ma nessuno lo interroga (processo separato, nessuna rotta HTTP), e annunciarlo
    // manderebbe chi legge `cf logs` a cercare una schermata che per lui non c'e'.
    const gate = Rules.resolveDumpGate(process.env);
    const where = gate.batch
      ? `stdout: le letture notevoli si dichiarano in \`cf logs\` (${Rules.DUMP_ENV}=off per spegnere)`
      : 'GET /odata/v4/catalog/isCallLog(sinceSeq=0,limit=50)';
    console.log(
      '>>> [IS-CALL-LOG] traccia delle letture attiva: ultime ' + CAPACITY +
      ' chiamate su ' + where +
      (echo ? ' (livello debug di `remote` richiesto dall\'operatore: le righe di CAP restano in log)' : '') +
      '. Spegnimento: IS_CALL_LOG=off'
    );
    return true;
  } catch (e) {
    console.warn(`>>> [IS-CALL-LOG] tap non installato (${e.message}): le voci avranno solo la richiesta ricostruita`);
    tapped = true; // non riprovare a ogni lettura
    return false;
  }
}

/**
 * TAP SULLA RISPOSTA: avvolge il client HTTP che CAP usa davvero, per leggere lo scambio PRIMA di
 * `_purgeODataV2`.
 *
 * PERCHE' FUNZIONA. CAP risolve il client SDK a ogni chiamata, non all'import
 * (remote/utils/cloudSdkProvider.js:10-16 e client.js:52-59):
 *
 *   _cloudSdk ??= require('@sap-cloud-sdk/http-client')
 *   const { executeHttpRequestWithOrigin } = getCloudSdk()
 *
 * `require` restituisce l'oggetto in cache — lo stesso che vediamo noi — e la destrutturazione
 * avviene dentro `_executeHttpRequest`, cioe' DOPO che questo modulo l'ha sostituita. Nessuna
 * chiamata in piu', nessuna questione di Principal Propagation: e' la chiamata vera di CAP.
 *
 * QUANDO NON SCATTA, E PERCHE' VA DETTO. Se `shouldUseCloudSdk` e' falso (destination locale con
 * auth basic o assente, cloudSdkProvider.js:32-40) CAP passa da `fetchClient` e questo wrapper non
 * viene invocato: le voci avranno `rawSeen: false`. Dichiararlo e' il punto — un tap che non ha
 * agganciato niente e una risposta davvero vuota si leggono uguali, ed e' l'errore che questo
 * modulo esiste per non fare.
 *
 * @returns {boolean} true se il wrapper e' installato
 */
function installResponseTap() {
  if (OFF) return false;
  if (responseTapped) return true;
  responseTapped = true;
  try {
    const sdk = require('@sap-cloud-sdk/http-client');
    const originale = sdk.executeHttpRequestWithOrigin;
    if (typeof originale !== 'function') {
      console.warn('>>> [IS-CALL-LOG] tap sulla risposta NON installato: '
        + 'executeHttpRequestWithOrigin non e\' una funzione in questa versione dell\'SDK. '
        + 'Le voci avranno rawSeen=false');
      return false;
    }
    const wrapper = async function (...args) {
      try {
        const res = await originale.apply(this, args);
        try {
          annotateResponse(als.getStore(), res);
        } catch (e) {
          // La diagnosi non puo' rompere una lettura: si perde l'annotazione, non la chiamata.
        }
        return res;
      } catch (err) {
        // ANCHE SUL RAMO D'ERRORE, e non e' un dettaglio: «non ci torna nulla» si presenta spesso
        // come 4xx/5xx, ed e' proprio li' che serve sapere stato reale, content-type e corpo. Senza
        // questo ramo l'errore uscirebbe con `rawSeen: false`, cioe' «non misurato» — che e' falso.
        try {
          if (err && err.response) annotateResponse(als.getStore(), err.response);
        } catch (e) { /* idem: si perde l'annotazione, non l'errore */ }
        throw err;
      }
    };
    // `defineProperty` e NON un'assegnazione: l'SDK e' compilato da TypeScript ed espone i suoi
    // membri come GETTER sul module.exports (`Object.defineProperty(exports, x, { get })`), quindi
    // `sdk.x = ...` lancia «which has only a getter». La proprieta' e' pero' `configurable`, e
    // ridefinirla e' visibile a CAP perche' `getCloudSdk()` rilegge l'oggetto in cache a ogni
    // chiamata (cloudSdkProvider.js:10-16). Verificato sull'SDK 4.4.0.
    Object.defineProperty(sdk, 'executeHttpRequestWithOrigin', {
      configurable: true,
      enumerable: true,
      get: () => wrapper
    });
    console.log('>>> [IS-CALL-LOG] tap sulla risposta attivo: ogni voce porta stato reale, '
      + 'content-type e corpo CRUDO (prima del purge OData di CAP)');
    return true;
  } catch (e) {
    console.warn(`>>> [IS-CALL-LOG] tap sulla risposta NON installato (${e.message}): `
      + 'le voci avranno rawSeen=false');
    return false;
  }
}

module.exports = {
  OFF,
  CAPACITY,
  LIMITS,
  MAX_URLS,
  MAX_URL_LEN,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  installRemoteTap,
  installResponseTap,
  annotateResponse,
  begin,
  within,
  push,
  list,
  clear,
  // [IS-CALL-LOG] DUMP: `maybeDump` è esportata per il test, `dumpStats`/`dumpCensus` per runJob.
  maybeDump,
  dumpStats,
  dumpCensus,
  parseRequestLine,
  maskHeaders,
  columnsOf,
  requestLine,
  sample,
  cut
};

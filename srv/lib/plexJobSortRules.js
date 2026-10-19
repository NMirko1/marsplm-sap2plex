/**
 * Regole pure dell'ordinamento della lista di lavoro Plex (feature 0014).
 *
 * Qui vivono le sole cose di questa feature che si possono verificare SENZA Plex:
 * normalizzazione e validazione dell'elenco degli stati congelati (FDD §4.2), costruzione del
 * payload (§4.1), interpretazione della risposta (§3.4 e matrice §6), accumulo dei contatori
 * per plant e testo delle voci di recap (FR-32). L'orchestrazione — configurazione, cache,
 * chiamata, log — sta in srv/lib/plexJobSort.js.
 *
 * Nessuna dipendenza: ne' `cds`, ne' rete, ne' db, ne' stato globale. Non aggiungerne: il test
 * si lancia con `node test/plexJobSortRules.test.js`. Stessa convenzione di
 * srv/lib/splitRules.js e srv/lib/isQueryShape.js.
 *
 * Nessuna funzione muta l'input, con UNA eccezione dichiarata nella firma: addSortStat, che
 * accumula in loco sull'oggetto `stats` del chiamante.
 */

'use strict';

/** Valori noti suggeriti nella schermata. NON una lista chiusa: Q-02 l'ha scartata. */
const KNOWN_FROZEN_STATUSES = ['Production', 'Scheduled', 'Sequenced'];

/**
 * Forma ammessa di un token (D-02): lettere e spazi interni SINGOLI fra parole, inizio con
 * lettera. Ammette 'On Hold', rifiuta 'On  Hold' (doppio spazio), 'Prod-1', '2Ready', ' Prod'.
 * Volutamente ASCII: se Rockwell confermasse stati con caratteri accentati o cifre, la regola
 * si allarga QUI e in nessun altro punto (\p{L} con flag u, oppure la classe estesa).
 */
const FROZEN_TOKEN_RE = /^[A-Za-z]+(?: [A-Za-z]+)*$/;

/** Limite del parametro Frozen_Job_Status_List sul contratto del servizio. */
const MAX_FROZEN_LIST_LENGTH = 200;

/** Corpo della risposta conservato nella traccia, troncato (FDD §6 righe H, I). */
const RESPONSE_MAX_CHARS = 2000;

/** Motivi di fallimento del passo 8. Chiavi stabili: entrano nei test e nel recap. */
const SORT_REASON = {
  APPLICATIVE: 'APPLICATIVE',       // risposta interpretabile che dichiara errore  (M-02)
  TRANSPORT: 'TRANSPORT',           // esito di trasporto negativo, non 2xx          (M-02)
  TIMEOUT: 'TIMEOUT',               // nessuna risposta entro il tempo massimo       (M-03)
  NO_CREDENTIALS: 'NO_CREDENTIALS', // credenziali del canale incomplete             (M-04)
  UNPARSABLE: 'UNPARSABLE',         // 2xx senza esito applicativo leggibile         (M-05)
  UNEXPECTED: 'UNEXPECTED'          // eccezione di rete o errore interno            (M-15)
};

/** Chiavi i18n dei motivi, nell'app marsplm-sap2plex (TDD §6.4). */
const MESSAGE_KEYS = Object.freeze({
  NOTE_HEADER: 'jobSortNoteHeader',            // M-01
  SERVICE: 'jobSortReasonService',             // M-02
  TIMEOUT: 'jobSortReasonTimeout',             // M-03
  NO_CREDENTIALS: 'jobSortReasonNoCredentials', // M-04
  UNPARSABLE: 'jobSortReasonUnparsable',       // M-05
  UNEXPECTED: 'jobSortReasonUnexpected'        // M-15
});

/**
 * Valori che contano come FALSO leggendo Result_Error (contratto C-5). Tutto cio' che non e'
 * qui dentro — 'true', '1', 'X' e qualunque valore non riconosciuto — conta come VERO:
 * fail-closed, perche' «una risposta ricevuta non e' mai per se' un successo» (FR-18) e
 * interpretare la stringa 'true' come «oggetto non vuoto quindi successo» sarebbe il
 * fallimento silenzioso peggiore (R-06 del BR).
 */
const FLAG_FALSE_TOKENS = new Set(['', 'false', '0', 'n', 'no']);

/** Campi dell'esito applicativo, nei nomi del contratto Rockwell. */
const OUTCOME_FIELDS = ['Result_Code', 'Result_Error', 'Result_Message'];

// ================================================================
// Elenco degli stati congelati
// ================================================================

/**
 * Normalizza l'elenco degli stati congelati (FDD §4.2.1), nell'ordine prescritto:
 * split sulle virgole, trim di ogni token, scarto dei vuoti, rimozione dei duplicati
 * CASE-INSENSITIVE conservando la PRIMA occorrenza NELLA FORMA SCRITTA, ordine di scrittura
 * conservato, ricomposizione con virgola e SENZA spazi.
 * Maiuscole e minuscole NON vengono alterate: non sappiamo se Plex confronti gli stati in modo
 * sensibile al caso, e alterarle potrebbe togliere la protezione ai job congelati (R-01).
 * @param {string|null|undefined} raw
 * @returns {{ value: string, tokens: string[] }} `value` e' cio' che si memorizza, si mostra e
 *   si trasmette: fra i tre non c'e' trasformazione.
 */
function normalizeFrozenList(raw) {
  const text = raw === null || raw === undefined ? '' : String(raw);
  const tokens = [];
  const seen = new Set();
  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) continue;                     // virgola doppia o finale: nessun token
    const folded = token.toLowerCase();       // dedup case-insensitive...
    if (seen.has(folded)) continue;           // ...conservando la PRIMA occorrenza
    seen.add(folded);
    tokens.push(token);                       // ...nella forma in cui e' stata scritta
  }
  return { value: tokens.join(','), tokens };
}

/**
 * Valida l'elenco normalizzato (FDD §4.2.2).
 * @param {string|null|undefined} raw valore grezzo digitato dall'amministratore
 * @returns {{
 *   ok: boolean, value: string, tokens: string[],
 *   errors: Array<{ code: 'TOKEN_FORM'|'TOO_LONG', token?: string, length?: number }>,
 *   warnings: Array<{ code: 'UNKNOWN_TOKEN', token: string }>
 * }} `ok` false SOLO per gli errori bloccanti; un `warnings` non vuoto non impedisce il
 *   salvataggio (M-11 e' un avviso, non un errore: l'insieme degli stati e' governato da Plex).
 *   Elenco vuoto => `ok: true`, `value: ''`, nessun errore: e' l'assenza di configurazione.
 */
function validateFrozenList(raw) {
  const { value, tokens } = normalizeFrozenList(raw);
  const errors = [];
  const warnings = [];

  // Forma di OGNI token normalizzato: il trim non collassa gli spazi INTERNI, quindi
  // 'On  Hold' resta non ammesso ed e' voluto (TDD §6.2 punto 4).
  for (const token of tokens) {
    if (!FROZEN_TOKEN_RE.test(token)) errors.push({ code: 'TOKEN_FORM', token });
  }
  // Lunghezza del valore NORMALIZZATO: il limite e' del parametro trasmesso, non del testo
  // digitato (un grezzo di 210 caratteri che normalizza a 195 e' ammesso).
  if (value.length > MAX_FROZEN_LIST_LENGTH) errors.push({ code: 'TOO_LONG', length: value.length });
  // Avviso NON bloccante: l'insieme degli stati e' governato da Plex e puo' crescere.
  for (const token of tokens) {
    if (KNOWN_FROZEN_STATUSES.indexOf(token) < 0) warnings.push({ code: 'UNKNOWN_TOKEN', token });
  }

  return { ok: errors.length === 0, value, tokens, errors, warnings };
}

// ================================================================
// Costruzione della richiesta
// ================================================================

/**
 * Costruisce gli `inputs` della richiesta (FDD §4.1). E' la funzione che rende FR-13/FR-14/FR-15
 * verificabili senza Plex: nessun campo oltre a questi due entra MAI nel corpo.
 * @param {{ dueDateSort: boolean, frozenJobStatusList: string|null }} config
 * @returns {{ Due_Date_Sort: boolean, Frozen_Job_Status_List?: string }}
 *   `Due_Date_Sort` SEMPRE presente, anche quando vale false (FR-13).
 *   `Frozen_Job_Status_List` presente SOLO se l'elenco normalizzato ha almeno un token: mai
 *   stringa vuota, mai un elenco «di default» nostro (FR-14, BR-17).
 *   `Workcenter_Code_List` e `Outlook` non compaiono mai (FR-15, BR-18).
 */
function buildSortInputs(config) {
  const cfg = config || {};
  // Oggetto costruito da ZERO, campo per campo: nessuno spread della configurazione, cosi'
  // nessun campo puo' entrare nel corpo per distrazione (FR-15).
  const inputs = { Due_Date_Sort: cfg.dueDateSort === true };
  // La normalizzazione e' IDEMPOTENTE: sul valore memorizzato (gia' normalizzato
  // dall'handler before CREATE/UPDATE) non cambia nulla, quindi cio' che l'amministratore
  // vede e' cio' che si trasmette (FR-16). Serve a decidere se il campo c'e' e a non far
  // partire mai una stringa vuota o una virgola sola arrivata da un percorso diverso.
  const { value } = normalizeFrozenList(cfg.frozenJobStatusList);
  if (value) inputs.Frozen_Job_Status_List = value;
  return inputs;
}

/**
 * Involucro del corpo secondo la forma richiesta (D-01).
 * @param {object} inputs risultato di buildSortInputs
 * @param {'nested'|'flat'} shape 'nested' = { inputs: {...} }, contratto Rockwell (default);
 *   'flat' = parametri al primo livello, forma delle 5 DS in esercizio. La leva esiste perche'
 *   il passaggio da una forma all'altra dopo il collaudo dev'essere un cambiamento di
 *   CONFIGURAZIONE, non di codice.
 * @returns {object} corpo JSON da trasmettere
 */
function wrapSortBody(inputs, shape) {
  const body = { ...(inputs || {}) };
  return shape === 'flat' ? body : { inputs: body };
}

// ================================================================
// Interpretazione della risposta
// ================================================================

/** Testo della risposta per la traccia, troncato. null-safe. */
function responseText(body, max = RESPONSE_MAX_CHARS) {
  if (body === null || body === undefined) return '';
  const text = typeof body === 'string' ? body : safeStringify(body);
  return text.length > max ? text.slice(0, max) : text;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    // Riferimenti circolari o getter che lanciano: la traccia non puo' far fallire nulla.
    return String(value);
  }
}

/**
 * Corpo conservato nella traccia: l'OGGETTO quando sta nel tetto (cosi' il pannello di
 * dettaglio del cockpit lo mostra strutturato come gli altri step), la stringa troncata
 * quando non ci sta (contratto C-3: un corpo di errore del tenant puo' essere una pagina HTML).
 */
function responseTrace(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return responseText(body);
  const text = safeStringify(body);
  return text.length > RESPONSE_MAX_CHARS ? text.slice(0, RESPONSE_MAX_CHARS) : body;
}

/** Result_Error letto in modo tollerante, fail-closed (contratto C-5). */
function isErrorFlagSet(value) {
  if (value === undefined || value === null) return false;   // assente = falso
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return !FLAG_FALSE_TOKENS.has(String(value).trim().toLowerCase());
}

/** Result_Code assente, 0 o '0' => successo dichiarato; qualunque altro valore => no (C-4). */
function isZeroCode(value) {
  if (value === undefined || value === null || value === '') return true;
  const n = Number(value);
  return n === 0;
}

/** Il candidato porta un esito applicativo leggibile? */
function hasOutcomeFields(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  return OUTCOME_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(candidate, f));
}

/**
 * Cerca l'esito applicativo in `outputs`, poi al PRIMO LIVELLO del corpo, poi in `rows[0]`
 * (forma `?format=2`). E' la tolleranza di forma di D-01 (contratto C-6).
 */
function findOutcome(body) {
  if (!body || typeof body !== 'object') return null;
  if (hasOutcomeFields(body.outputs)) return body.outputs;
  if (hasOutcomeFields(body)) return body;
  if (Array.isArray(body.rows) && hasOutcomeFields(body.rows[0])) return body.rows[0];
  if (Array.isArray(body) && hasOutcomeFields(body[0])) return body[0];
  return null;
}

/**
 * Interpreta l'esito della chiamata (FDD §3.4 e matrice §6). TOLLERANTE sulla forma: cerca
 * l'esito applicativo in `body.outputs`, poi al PRIMO LIVELLO del corpo, poi in `body.rows[0]`
 * (forma `?format=2`). Se il servizio accettasse solo la forma piatta, l'esito resta
 * riconosciuto invece di essere classificato «non interpretabile» (D-01).
 * `Result_Error` vince sul codice di trasporto (FR-17); una risposta ricevuta NON e' mai per se'
 * un successo (FR-18).
 * @param {{ thrown?: Error, aborted?: boolean, ok?: boolean, status?: number, body?: any }} res
 *   esattamente cio' che restituisce executeDataSourceOutputs
 * @returns {{ state: 'OK'|'KO', reason?: string, code: number|string|null,
 *             message: string, response: any }} `message` e' il testo Plex INTEGRALE quando
 *   c'e' (nessuna riscrittura, FR-19); `response` e' cio' che va nella traccia, troncato.
 */
function interpretSortResponse(res) {
  const r = res || {};
  const trace = responseTrace(r.body);

  // --- riga J: nessuna risposta entro il tempo massimo -------------------------
  if (r.aborted) {
    const out = { state: 'KO', reason: SORT_REASON.TIMEOUT, code: null, message: '', response: trace };
    out.message = sortReasonText(out);
    if (out.response === null) out.response = out.message;
    return out;
  }

  // --- eccezione di rete o errore interno (TD-7, M-15) ------------------------
  if (r.thrown) {
    const detail = (r.thrown && r.thrown.message) || String(r.thrown);
    const out = { state: 'KO', reason: SORT_REASON.UNEXPECTED, code: null, message: detail, response: trace };
    if (out.response === null) out.response = sortReasonText(out);
    return out;
  }

  const outcome = findOutcome(r.body);
  const plexMessage = outcome && outcome.Result_Message !== undefined && outcome.Result_Message !== null
    ? String(outcome.Result_Message)       // INTEGRALE: nessuna riscrittura (FR-19)
    : '';
  const plexCode = outcome && outcome.Result_Code !== undefined ? outcome.Result_Code : null;

  // --- riga H: esito di trasporto negativo ------------------------------------
  // Il codice di trasporto vale come `code`, il corpo (troncato) come messaggio: e' quanto
  // il servizio ha detto, e non c'e' nulla da interpretare oltre a questo.
  if (r.ok !== true) {
    const status = r.status === undefined || r.status === null ? null : r.status;
    const out = {
      state: 'KO',
      reason: SORT_REASON.TRANSPORT,
      code: status,
      message: plexMessage || responseText(r.body) || `HTTP ${status === null ? '?' : status}`,
      response: trace
    };
    if (out.response === null) out.response = out.message;
    return out;
  }

  // --- riga I: 2xx senza esito applicativo leggibile --------------------------
  if (!outcome) {
    const out = { state: 'KO', reason: SORT_REASON.UNPARSABLE, code: null, message: '', response: trace };
    out.message = sortReasonText(out);
    if (out.response === null) out.response = out.message;
    return out;
  }

  // --- righe F/G: il flag di errore decide, qualunque sia il codice HTTP -------
  if (isErrorFlagSet(outcome.Result_Error)) {
    return {
      state: 'KO', reason: SORT_REASON.APPLICATIVE, code: plexCode,
      message: plexMessage, response: trace
    };
  }

  // --- riga F (variante C-4): flag falso ma codice diverso da 0 ---------------
  if (!isZeroCode(plexCode)) {
    return {
      state: 'KO', reason: SORT_REASON.APPLICATIVE, code: plexCode,
      message: plexMessage, response: trace
    };
  }

  // --- righe D/E/M: unico esito registrato come riuscito ----------------------
  return { state: 'OK', code: plexCode, message: plexMessage, response: trace };
}

// ================================================================
// Testi
// ================================================================

/**
 * Testo italiano BREVE del motivo, per log, recap e colonna Message di ZJobRunPOS.
 * Distinto da reasonMessageKey: il recap dei job non ha `req` ne' locale (nessun job usa
 * getLocalizedMessage: verificato), quindi i suoi testi sono letterali italiani, come il recap
 * dello spacchettamento (createPlexProductionOrders.js:596).
 * @param {object} sortOutcome esito di interpretSortResponse (o { state:'KO', reason:'NO_CREDENTIALS' })
 * @returns {string}
 */
function sortReasonText(sortOutcome) {
  const o = sortOutcome || {};
  if (o.state === 'OK') return o.message || 'ordinamento richiesto';
  if (o.state === 'NOT_CONFIGURED') return 'ordinamento non abilitato per il plant';

  switch (o.reason) {
    case SORT_REASON.APPLICATIVE:
    case SORT_REASON.TRANSPORT:
      // M-02: il messaggio del servizio non viene riscritto (FR-19).
      return `il servizio di ordinamento ha risposto: ${o.message || '(nessun messaggio)'}`
        + ` (codice ${o.code === null || o.code === undefined || o.code === '' ? 'n/d' : o.code})`;
    case SORT_REASON.TIMEOUT:
      // M-03
      return 'il servizio di ordinamento non ha risposto entro il tempo massimo previsto';
    case SORT_REASON.NO_CREDENTIALS:
      // M-04
      return 'le credenziali del canale usato dal servizio di ordinamento non sono configurate: '
        + 'nessuna richiesta è stata inviata';
    case SORT_REASON.UNPARSABLE:
      // M-05
      return 'la risposta del servizio di ordinamento non è interpretabile: '
        + "l'esito dell'ordinamento non è accertabile";
    case SORT_REASON.UNEXPECTED:
      // M-15 (TD-7)
      return 'il passo di ordinamento non è stato completato per un errore interno: '
        + `${o.message || 'dettaglio non disponibile'}`;
    default:
      return o.message || 'ordinamento non applicato';
  }
}

/**
 * Chiave i18n del motivo, per la nota all'utente dell'azione manuale (M-02 … M-05, M-15).
 * Vive nell'app marsplm-sap2plex (§6.4).
 * @param {object} sortOutcome esito del passo 8
 * @returns {{ key: string, params: Array<any> }}
 */
function reasonMessageKey(sortOutcome) {
  const o = sortOutcome || {};
  switch (o.reason) {
    case SORT_REASON.APPLICATIVE:
    case SORT_REASON.TRANSPORT:
      return {
        key: MESSAGE_KEYS.SERVICE,
        params: [
          o.message || '(nessun messaggio)',
          o.code === null || o.code === undefined || o.code === '' ? 'n/d' : o.code
        ]
      };
    case SORT_REASON.TIMEOUT:
      return { key: MESSAGE_KEYS.TIMEOUT, params: [] };
    case SORT_REASON.NO_CREDENTIALS:
      return { key: MESSAGE_KEYS.NO_CREDENTIALS, params: [] };
    case SORT_REASON.UNPARSABLE:
      return { key: MESSAGE_KEYS.UNPARSABLE, params: [] };
    case SORT_REASON.UNEXPECTED:
    default:
      // Un motivo non previsto NON diventa un testo che dice una cosa falsa: M-15 e' il
      // solo messaggio che puo' portare un dettaglio libero (TD-7).
      return { key: MESSAGE_KEYS.UNEXPECTED, params: [o.message || 'dettaglio non disponibile'] };
  }
}

// ================================================================
// Riepilogo per plant (FR-32)
// ================================================================

/**
 * Accumulo dei contatori per plant (FR-32). Puro: `stats` e' un oggetto piatto mutato in loco
 * dal chiamante, cosi' che il test possa verificare le tre situazioni senza un job.
 * Un `sort` assente o con state 'SKIPPED' NON crea la voce del plant: e' il «nessun contributo»
 * delle righe B e C della matrice, e il caso 24 di §11 (nessun ordine elaborato => nessuna voce).
 * @param {object} stats mappa plant -> { plant, enabled, ok, ko, lastReason }
 * @param {string} plant
 * @param {object|undefined} sortOutcome il campo `sort` restituito da processOrder
 */
function addSortStat(stats, plant, sortOutcome) {
  if (!stats || !sortOutcome) return;
  const state = sortOutcome.state;
  // 'SKIPPED' e qualunque stato non previsto: nessun contributo, nessuna voce.
  if (state !== 'NOT_CONFIGURED' && state !== 'OK' && state !== 'KO') return;

  const key = String(plant === null || plant === undefined ? '' : plant) || '(n/d)';
  if (!stats[key]) stats[key] = { plant: key, enabled: false, ok: 0, ko: 0, lastReason: null };
  const cur = stats[key];

  // TD-8: la voce del plant nasce perche' ALMENO UN ordine e' arrivato al punto in cui il
  // passo 8 si valuta. Un plant non abilitato resta `enabled: false` e produce M-08.
  if (state === 'NOT_CONFIGURED') return;

  cur.enabled = true;
  if (state === 'OK') cur.ok += 1;
  else {
    cur.ko += 1;
    cur.lastReason = sortReasonText(sortOutcome);   // «Ultimo errore» di M-07
  }
}

/**
 * Traduce i contatori nelle voci di recap, una per plant (FR-32, M-06/M-07/M-08).
 * @param {object} stats
 * @returns {Array<{ plant: string, status: 'S'|'W', degrade: boolean, message: string }>}
 *   `status:'E'` + `degrade:true` SOLO quando almeno una richiesta e' fallita; le due voci
 *   informative sono `status:'S'` + `degrade:false` (§5.6).
 *   [RUN-BLOCKED] Era `'W'`: la riga era rossa nel recap e il run usciva 0, quindi un riordino che
 *   non partiva non lo vedeva nessuno. Una richiesta fallita e' una chiamata verso Plex senza
 *   risposta utilizzabile e fa chiudere il run in errore (DEC-124) — l'invio dei job resta
 *   intatto, ma la lista di lavoro in fabbrica e' nell'ordine sbagliato, che e' il motivo per cui
 *   la feature 0014 esiste.
 */
function sortRecapEntries(stats) {
  const entries = [];
  for (const plant of Object.keys(stats || {}).sort()) {
    const s = stats[plant] || {};
    if (!s.enabled) {
      // M-08 — informativa: l'ordinamento non e' stato chiesto pur potendolo essere.
      entries.push({
        plant, status: 'S', degrade: false,
        message: `Ordinamento lista di lavoro non abilitato per il plant ${plant}: nessuna richiesta emessa.`
      });
    } else if ((s.ko || 0) > 0) {
      // M-07 — la SOLA voce che degrada l'esito dell'esecuzione, e [RUN-BLOCKED] la sola che lo
      // fa chiudere in errore: `s.ko` conta richieste verso Plex che non hanno risposto.
      entries.push({
        plant, status: 'E', degrade: true,
        message: `Ordinamento lista di lavoro: ${s.ok || 0} richieste riuscite, ${s.ko} non riuscite.`
          + ` Ultimo errore: ${s.lastReason || 'n/d'}. L'invio dei job non è stato compromesso.`
      });
    } else {
      // M-06 — informativa.
      entries.push({
        plant, status: 'S', degrade: false,
        message: `Ordinamento lista di lavoro: ${s.ok || 0} richieste inviate, tutte riuscite.`
      });
    }
  }
  return entries;
}

// ================================================================
// [ORDER-SORT-ON-WRITE] L'ordinamento dopo OGNI scrittura su un ordine
// ================================================================

/**
 * Garantisce che un invio che ha SCRITTO su Plex si chiuda con l'ordinamento della lista di lavoro,
 * anche quando la sequenza esce prima del passo 8.
 *
 * La regola e' dettata (addendum del 06/10/2026 a DEC-100): ogni volta che un ordine di produzione
 * cambia su Plex perche' gli abbiamo mandato dei dati, si riordina. Il passo 8 di `processOrder` sta
 * in coda alla sequenza, e la coda non si raggiunge da due uscite che arrivano DOPO una scrittura:
 * la creazione del job che risponde OK senza id (il job esiste, l'ordine chiude in errore) e
 * un'eccezione di rete partita a meta' di una scrittura. Spostare il passo 8 in ogni uscita sarebbe
 * una condizione ripetuta in ogni `return`; qui la decide un punto solo, guardando cosa e' successo.
 *
 * `trace` lo compila il chiamante:
 *   - `written`  una scrittura ha avuto risposta OK;
 *   - `inFlight` una scrittura e' partita e la risposta non e' (ancora) arrivata. Se la sequenza
 *     lancia in quel momento, l'esito e' INCERTO, e l'ordinamento si chiama lo stesso: ricalcola la
 *     sola sequenza, quindi nel dubbio costa una richiesta, mentre saltarlo lascia la lista
 *     nell'ordine sbagliato. Scelta dell'utente, non deduzione.
 * Un rifiuto CON risposta non tocca nessuno dei due, ed e' giusto: Plex ha detto no, niente e'
 * cambiato.
 *
 * Tre casi, e il terzo e' quello da non rompere:
 *   - ritorno SENZA `sort`, con scrittura → si ordina e si aggiunge `sort` all'esito;
 *   - eccezione, con scrittura → si ordina su un array nuovo, si appendono `sort` e `sortSteps`
 *     all'errore e si RILANCIA: chi chiama decide come registrarla, come oggi;
 *   - ritorno CON `sort` (il passo 8 e' gia' girato) → niente: mai due richieste per un ordine.
 *
 * Puro: nessuna rete, nessun `cds`. `runFn` e `sortFn` arrivano dal chiamante.
 *
 * @param {{written?: boolean, inFlight?: boolean}} trace
 * @param {() => Promise<object>} runFn la sequenza
 * @param {(steps: Array) => Promise<object>} sortFn l'ordinamento, che appende il suo passo a `steps`
 * @returns {Promise<object>} l'esito di `runFn`, con `sort` se l'ha aggiunto
 */
async function guardSortOnWrite(trace, runFn, sortFn) {
  const touched = () => !!(trace && (trace.written || trace.inFlight));
  // Il passo 8 non lancia per costruzione; qui lo si garantisce anche per una `sortFn` che lo
  // facesse, perche' sul ramo dell'eccezione un suo errore COPRIREBBE quello della sequenza.
  const sortSafe = async (steps) => {
    try { return (await sortFn(steps)) || null; } catch (_) { return null; }
  };
  let out;
  try {
    out = await runFn();
  } catch (err) {
    if (touched() && err && typeof err === 'object') {
      const sortSteps = [];
      err.sort = await sortSafe(sortSteps);
      err.sortSteps = sortSteps;
    }
    throw err;
  }
  if (out && !out.sort && touched()) {
    out.sort = await sortSafe(Array.isArray(out.steps) ? out.steps : []);
  }
  return out;
}

module.exports = {
  KNOWN_FROZEN_STATUSES, FROZEN_TOKEN_RE, MAX_FROZEN_LIST_LENGTH, RESPONSE_MAX_CHARS, SORT_REASON,
  MESSAGE_KEYS,
  normalizeFrozenList, validateFrozenList, buildSortInputs, wrapSortBody, interpretSortResponse,
  sortReasonText, reasonMessageKey, addSortStat, sortRecapEntries, guardSortOnWrite
};

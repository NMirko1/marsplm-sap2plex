const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
// [LICENSE-BODY] La resa della RISPOSTA del license server, e il mascheramento che la accompagna:
// regole pure, un punto solo per i due rami. Vedi la testata di srv/lib/licenseLogRules.js.
const L = require('./lib/licenseLogRules');
const { maskEmail } = L;
// [LICENSE-BODY] L'anello che il cockpit già legge (`window.isCalls()` e compagnia): le chiamate di
// licenza non passano da CAP, quindi il tap non le aggancia e si registrano a mano — è la stessa
// strada di srv/lib/plexCallTrace.js, `area: 'plex'`.
const isCallLog = require('./lib/isCallLog');

/**
 * [LICENSE-BODY] L'indirizzo e il CANALE, per la voce dell'anello e per le righe di log.
 *
 * Prende il `dest` già risolto invece di richiamare `resolveDestination()`: due risoluzioni nello
 * stesso istante potrebbero dire due cose diverse (la leva `LICENSE_URL` è letta a ogni giro), e una
 * voce che nomina un canale su cui la chiamata non è uscita è peggio di una voce senza canale.
 */
function traceTargetOf(dest) {
  if (!dest) return { target: '(nessuna destination configurata)', destination: '(nessuna)' };
  return dest.url
    ? { target: dest.url, destination: '(url esplicito)' }
    : { target: `destination:${dest.destinationName}`, destination: dest.destinationName };
}

/** Registra una voce senza poter rompere la chiamata: si perde la voce, non il verdetto. */
function trace(p) {
  try {
    isCallLog.push(L.traceEntry(p));
  } catch (e) {
    if (!trace._warned) {
      trace._warned = true;
      console.warn(`>>> [LICENSE] voce non registrata (${e.message}): il verdetto prosegue`);
    }
  }
}

// ================================================================
// LICENSE CHECK - per-plant, multi-customer (discovery from server).
//
// A plant is "licensed" when ANY active customer API key (ZLicenseConfig) validates it
// (Valid=true) via the external license server (destination MARS_LICENSE). We do NOT store
// a plant->customer mapping: for a given plant we try each active API key and the first
// Valid=true wins (its API key id is remembered to try it first next time).
//
// Cache policy (MODULE-SCOPED, shared across all service instances in this process):
//   - POSITIVE verdict: cached for 24h. Licenses last >= 1 year, so the server's expiry is
//     always >> 24h; the 24h ceiling just bounds detection of an early revocation.
//   - NEGATIVE verdict: NOT cached -> re-checked every time so a renewal is instant.
//   - GRACE 96h (4 days) from last_good (last successful positive): if the server is UNREACHABLE
//     we keep serving the last positive for up to 96h; beyond that -> FAIL-CLOSED (block).
// ================================================================

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
const GRACE_MS = 96 * 60 * 60 * 1000;          // 96 hours (4 days) from last successful check

/**
 * [PLANT-ACCESS] Tetto di tempo di UNA chiamata al license server (feature 0048).
 *
 * PERCHE' QUI E NON IN package.json. `requestTimeout` sotto `cds.requires` lo legge il
 * RemoteService di CAP, cioe' un'istanza creata con `cds.connect.to(...)`: questo modulo non si
 * connette mai al license server — risolve la destination a mano (`resolveDestination`) e chiama
 * `executeHttpRequest` diretto. Una riga la' sarebbe INERTE, e sarebbe anche l'unica difesa che
 * avremmo: senza tetto un server che appende blocca la richiesta fino ai 120 s dell'approuter, e a
 * quel punto «il browser riceve un 504 e con esso zero righe» (srv/lib/plantRowsPaging.js).
 *
 * UNA DEADLINE APPLICATIVA NON BASTEREBBE: dichiara l'esito ma non cancella il socket, e su un
 * canale senza tetto se ne accumulerebbero P x K per risoluzione.
 *
 * IL NUMERO. Dieci secondi per chiamata. Il conto del caso peggiore e' K x questo valore, perche'
 * le API key si provano IN SERIE mentre i plant vanno in parallelo: con tre chiavi sono 30 s, che
 * resta sotto i 120 s dell'approuter. Dalla 0048 quel tetto conta per ogni lettura del cockpit, non
 * piu' solo per l'apertura di una scheda di configurazione.
 */
const LICENSE_TIMEOUT_MS = Number(process.env.LICENSE_TIMEOUT_MS) > 0
  ? Math.floor(Number(process.env.LICENSE_TIMEOUT_MS))
  : 10 * 1000;

/**
 * [LICENSE-OFF] Interruttore d'emergenza/sviluppo: con `LICENSE_DISABLED=true` il license server
 * (destination MARS_LICENSE) NON viene mai chiamato. Tutti i plant risultano licenziati e ogni utente
 * ha il ruolo `LICENSE_DISABLED_ROLE` (default `admin`; ammessi `admin`, `admin-config`, `user`).
 *
 * Si legge a OGNI chiamata, come `LICENSE_URL`, quindi `cf set-env` + restart basta. Solo la stringa
 * `true` attiva: qualunque altro valore (assente, `false`, `1`) lascia il controllo regolare.
 * I job lanciati da `/job-run` ereditano la variabile (`fork`); con `cf run-task` NO (DEC-30).
 */
function licenseDisabled() {
  return String(process.env.LICENSE_DISABLED || '').trim().toLowerCase() === 'true';
}

function disabledRole() {
  const r = accessRules.normalizeRole(String(process.env.LICENSE_DISABLED_ROLE || 'admin').trim().toLowerCase());
  return r || 'admin';
}

let disabledWarned = false;
function warnDisabledOnce() {
  if (disabledWarned) return;
  disabledWarned = true;
  console.warn('>>> [LICENSE] *** CONTROLLO LICENZA DISABILITATO (LICENSE_DISABLED=true) ***: nessuna chiamata a'
    + ` MARS_LICENSE, tutti i plant licenziati, ruolo utente forzato a '${disabledRole()}'`);
}

// plantCode -> { lastGood: <ms epoch of last Valid=true>, apiKeyId: <winning ZLicenseConfig.ID> }
const licenseCache = new Map();

/**
 * [PLANT-ACCESS] Le API key, in cache (feature 0048).
 *
 * Prima della 0048 `getApiKeys()` rifaceva la `SELECT` su `ZLicenseConfig` a OGNI verdetto, e i
 * verdetti erano pochi: uno per plant all'ora, perche' il positivo di licenza sta in cache 24 h.
 * Col perimetro per utente i verdetti diventano molti — e il negativo non sta in cache per scelta
 * (decisione della feature) — quindi quella lettura si moltiplicherebbe per plant e per richiesta.
 *
 * TTL BREVE E INVALIDAZIONE ESPLICITA, come `activePlantsCache` in cat-service.js: la invalida
 * l'`after` handler di `ZLicenseConfig`, e il TTL e' la rete di sicurezza se un giorno qualcuno
 * scrivesse quella tabella da un'altra strada. NON tocca ne' `licenseCache` ne' le due cache dei
 * ruoli: e' una cache di CONFIGURAZIONE, non di verdetti.
 */
const API_KEYS_TTL_MS = 60 * 1000;
let apiKeysCache = null;
let apiKeysCacheAt = 0;

/** Resolve the target: BTP destination (prod/hybrid) or a direct URL (dev). */
function resolveDestination() {
  const creds = (cds.env.requires && cds.env.requires.MARS_LICENSE && cds.env.requires.MARS_LICENSE.credentials) || {};
  if (process.env.LICENSE_URL) return { url: process.env.LICENSE_URL };
  if (creds.destination) return { destinationName: creds.destination };
  if (creds.url) return { url: creds.url };
  return null;
}

/** The configured API keys from ZLicenseConfig. Throws are handled by the caller. */
async function getApiKeys() {
  const now = Date.now();
  if (apiKeysCache && (now - apiKeysCacheAt) < API_KEYS_TTL_MS) return apiKeysCache;
  const db = await cds.connect.to('db');
  const { ZLicenseConfig } = db.entities('avvaleplm.marsplm.sap2plex');
  const rows = await db.run(SELECT.from(ZLicenseConfig).columns('ID', 'ApiKey'));
  apiKeysCache = rows || [];
  apiKeysCacheAt = now;
  return apiKeysCache;
}

/** [PLANT-ACCESS] Scorda le API key lette. La chiama l'`after` handler di `ZLicenseConfig`. */
function invalidateApiKeys() {
  apiKeysCache = null;
  apiKeysCacheAt = 0;
}

/**
 * Call the license server for one (apiKey, plant). Returns:
 *   { ok: true, valid: <bool> }  on a definitive answer — `Valid=false` OR an HTTP 403, which is
 *                                the server DECLARING that this key does not license the plant,
 *   { ok: false }                on a technical/network error (server unreachable).
 */
async function callLicenseServer(dest, apiKey, plantCode, keyId) {
  // [LICENSE-BODY] Si dichiara l'indirizzo chiamato e QUALE delle K chiavi lo ha chiamato, col suo
  // ID di ZLicenseConfig. Il Bearer NON esce: prima era stampato per intero con la nota «rimuovere
  // prima della produzione», e DEC-96 vieta di far uscire gli header proprio perche' le credenziali
  // stanno in `Authorization` — `cf logs` e' conservato. L'ID identifica la chiave meglio del suo
  // valore, ed e' cio' che serve per confrontarla con la riga di customizing.
  const { target, destination } = traceTargetOf(dest);
  const who = `plant ${plantCode}`;
  console.log(`>>> [LICENSE] GET ${target}/LicenseStatus?plant=${plantCode}`
    + ` - chiave ${keyId || '(senza ID)'}`);
  const t0 = Date.now();
  try {
    const res = await executeHttpRequest(dest, {
      method: 'GET',
      url: '/LicenseStatus',
      params: { plant: plantCode },
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: LICENSE_TIMEOUT_MS   // [PLANT-ACCESS] vedi il docblock della costante
    });
    // URL effettivo risolto (utile quando si usa la destination invece di un url esplicito).
    const effectiveUrl = (res && res.request && res.request.res && res.request.res.responseUrl)
      || (res && res.config && res.config.url) || '(n/d)';
    const d = res && res.data && res.data.d;
    const row = d && Array.isArray(d.results) ? d.results[0] : d;
    const valid = !!(row && row.Valid === true);
    // Log del VERDETTO, non solo dello stato HTTP: HTTP 200 = il server ha risposto, ma
    // Valid=false significa plant NON licenziato (quindi correttamente non caricato).
    const rawValid = row ? String(row.Valid) : '(nessuna riga)';
    const statusTxt = row && row.Status ? `, Status=${row.Status}` : '';
    console.log(`>>> [LICENSE] plant ${plantCode}: HTTP ${res && res.status}, Valid=${rawValid}${statusTxt} -> ${valid ? 'LICENZIATO' : 'NON licenziato'} - ${effectiveUrl}`);
    // [LICENSE-BODY] E la risposta da cui quel verdetto viene: `Valid=false` ha tre cause — plant
    // sconosciuto al server, licenza scaduta, chiave API di un altro cliente — e a schermo sono la
    // stessa riga. Lo `Status` e quello che il server ci mette accanto stanno solo qui.
    console.log(`>>> [LICENSE] ${L.bodyLine(res, { who, secrets: [apiKey] })}`);
    trace({
      kind: L.TRACE_OP.PLANT, plant: plantCode, apiKey, target, destination, effectiveUrl, res,
      ms: Date.now() - t0,
      verdict: `Valid=${rawValid}${statusTxt} -> ${valid ? 'LICENZIATO' : 'NON licenziato'}`
    });
    return { ok: true, valid };
  } catch (e) {
    // [PLANT-ACCESS] UN 403 E' UNA RISPOSTA, NON UN GUASTO: il license server dichiara cosi' «questa
    // chiave non licenzia quel plant». Trattarlo come irraggiungibile farebbe riservire il vecchio
    // «si'» entro il grace di 96 h, cioe' terrebbe in piedi una licenza che il server ha appena
    // negato. Vale come `Valid=false`: risposta pulita, negativo definitivo.
    //
    // NON INTERROMPE IL CICLO SULLE CHIAVI. Il chiamante prova le K chiavi di ZLicenseConfig in
    // serie: un rifiuto e' della CHIAVE, non del plant, e la chiave di un altro cliente risponde
    // 403 proprio sui plant che la nostra licenzia. Uscendo qui con un verdetto si spegnerebbe la
    // discovery multi-cliente — e senza nessun errore, perche' il plant risulterebbe non licenziato.
    if (L.isAccessDenied(e)) {
      console.warn(`>>> [LICENSE] plant ${plantCode}: HTTP ${L.DENIED_STATUS}`
        + ' -> NON LICENZIATO per questa chiave (risposta del server, non un guasto)');
      console.warn(`>>> [LICENSE] ${L.errorLine(e, { who, secrets: [apiKey] })}`);
      trace({
        kind: L.TRACE_OP.PLANT, plant: plantCode, apiKey, target, destination, err: e,
        ms: Date.now() - t0,
        verdict: `HTTP ${L.DENIED_STATUS} -> NON LICENZIATO (rifiuto dichiarato)`
      });
      return { ok: true, valid: false };
    }
    console.error(`>>> [LICENSE] plant ${plantCode}: technical error - ${e.message}`);
    // [LICENSE-BODY] `executeHttpRequest` RIGETTA su 4xx/5xx, quindi senza questa riga un 401 o un
    // 500 del license server lascia il solo «Request failed with status code 401» e il motivo, che
    // sta nel corpo, si butta.
    console.error(`>>> [LICENSE] ${L.errorLine(e, { who, secrets: [apiKey] })}`);
    trace({
      kind: L.TRACE_OP.PLANT, plant: plantCode, apiKey, target, destination, err: e,
      ms: Date.now() - t0, verdict: 'chiamata non riuscita: nessun verdetto'
    });
    return { ok: false };
  }
}

/**
 * Live check for a plant across all active API keys (discovery).
 * Returns 'valid' | 'invalid' | 'unreachable'. On 'valid' also returns the winning apiKeyId.
 */
async function checkPlantLive(plantCode) {
  const dest = resolveDestination();
  if (!dest) {
    console.error('>>> [LICENSE] no MARS_LICENSE destination/URL configured');
    return { outcome: 'unreachable' };
  }
  let keys;
  try {
    // [PLANT-ACCESS] Si COPIA: dalla 0048 `getApiKeys()` rende l'array in cache, e il fast-path
    // qui sotto lo riordina con `unshift`/`splice`. Senza la copia quel riordino muterebbe lo stato
    // condiviso, e l'ordine scelto per un plant si porterebbe dietro tutti gli altri.
    keys = [...(await getApiKeys())];
  } catch (e) {
    // Internal error reading the license table (e.g. table not deployed yet, transient DB error).
    // Do NOT crash the whole request: treat as 'unreachable' so the grace/fail-closed policy
    // applies (a licensed plant keeps working within grace; otherwise it is blocked cleanly).
    console.error(`>>> [LICENSE] cannot read ZLicenseConfig, treating as unreachable - ${e.message}`);
    return { outcome: 'unreachable' };
  }
  if (!keys.length) {
    // No API key configured -> nothing can be validated -> fail-closed (definitive).
    console.warn('>>> [LICENSE] no ZLicenseConfig rows: plant treated as unlicensed');
    return { outcome: 'invalid' };
  }
  // Try the previously winning key first (fast path for the common case).
  const prev = licenseCache.get(plantCode);
  if (prev && prev.apiKeyId) {
    const i = keys.findIndex(k => k.ID === prev.apiKeyId);
    if (i > 0) keys.unshift(keys.splice(i, 1)[0]);
  }

  let anyError = false;
  for (const k of keys) {
    const r = await callLicenseServer(dest, k.ApiKey, plantCode, k.ID);
    if (!r.ok) { anyError = true; continue; }
    if (r.valid) return { outcome: 'valid', apiKeyId: k.ID };
  }
  // No key validated the plant. If every key answered cleanly -> genuine negative.
  // If at least one call errored -> we can't be sure -> treat as unreachable (grace/fail-closed).
  return { outcome: anyError ? 'unreachable' : 'invalid' };
}

/**
 * Is the given plant licensed right now?
 * @param {string} plantCode
 * @param {{force?: boolean}} opts  force=true skips the fresh-positive cache (used on activation).
 */
async function isPlantLicensed(plantCode, { force = false } = {}) {
  if (!plantCode) return false;
  if (licenseDisabled()) {
    warnDisabledOnce();
    trace(Object.assign({ kind: L.TRACE_OP.PLANT, plant: plantCode }, traceTargetOf(null),
      { cached: 'LICENSE_DISABLED', verdict: 'LICENZIATO (controllo disabilitato)' }));
    return true;
  }
  const now = Date.now();
  const entry = licenseCache.get(plantCode);

  // Fresh positive -> trust cache (no server call). Skipped when force=true.
  if (!force && entry && (now - entry.lastGood) < POSITIVE_TTL_MS) {
    // [LICENSE-BODY] Il NON-EVENTO si registra: e' il caso normale — dopo il primo verdetto la
    // chiamata non parte per 24 h — e senza questa voce la console del cockpit resta muta, che si
    // legge come «non c'e' nessun check di licenza». E' l'equivoco da cui la traccia nasce.
    trace(Object.assign({ kind: L.TRACE_OP.PLANT, plant: plantCode },
      traceTargetOf(resolveDestination()),
      { cached: 'cache 24 h (positivo di licenza)', verdict: 'LICENZIATO' }));
    return true;
  }

  const live = await checkPlantLive(plantCode);
  if (live.outcome === 'valid') {
    licenseCache.set(plantCode, { lastGood: now, apiKeyId: live.apiKeyId });
    return true;
  }
  if (live.outcome === 'invalid') {
    licenseCache.delete(plantCode);   // negatives are never cached -> instant renewal
    return false;
  }
  // 'unreachable' -> grace window from last_good, else fail-closed.
  if (entry && (now - entry.lastGood) < GRACE_MS) {
    console.warn(`>>> [LICENSE] plant ${plantCode}: server unreachable, serving cached positive (grace)`);
    return true;
  }
  console.warn(`>>> [LICENSE] plant ${plantCode}: server unreachable, no valid grace -> fail-closed`);
  return false;
}

/**
 * Given a set/iterable of ACTIVE plant codes, return the subset that is licensed.
 * This is the single entry point for the enforcement choke-points (getLicensedPlants / jobs).
 */
async function getUsablePlants(activePlantCodes) {
  const codes = [...activePlantCodes];
  const results = await Promise.all(codes.map(async (c) => {
    try {
      return (await isPlantLicensed(c)) ? c : null;
    } catch (e) {
      // Never let one plant's failure crash the whole resolution -> exclude it (fail-closed).
      console.error(`>>> [LICENSE] evaluation failed for plant ${c}, excluding - ${e.message}`);
      return null;
    }
  }));
  return new Set(results.filter(Boolean));
}

/** Drop a cached verdict (call after activating a plant or editing ZLicenseConfig). */
function invalidateLicense(plantCode) {
  if (plantCode) licenseCache.delete(plantCode);
  else licenseCache.clear();
  console.log(`>>> [LICENSE] cache invalidated${plantCode ? ` for ${plantCode}` : ' (all)'}`);
}

// ================================================================
// USER ROLE CHECK - per (user, plant). SEPARATO dal check plant qui sopra.
//
// Chiama LO STESSO endpoint /LicenseStatus del server licenza ma col param
// aggiuntivo `email=<email>` (v1.2); il server risponde col ruolo nel campo `Role`.
// I check per-plant esistenti (isPlantLicensed/getUsablePlants/checkPlantLive)
// NON inviano `email` e restano invariati.
//
// [PLANT-ACCESS] DALLA 0048 I CONSUMATORI SONO DUE, CON POLITICHE OPPOSTE.
//
//   - `getUserRole(email, plant)` — la scheda di configurazione. Va SEMPRE live, cosi' i cambi di
//     ruolo (promozione E retrocessione) si vedono subito. Contratto invariato: rende 'admin' o
//     'admin-config', mai altro.
//   - `getUserPlantRole(email, plant)` — il perimetro della dashboard. Politica IDENTICA al check
//     plant: positivo in cache 24 h, negativo mai in cache, grace 96 h. Rende il ruolo GREZZO,
//     'user' compreso, perche' la' qualunque ruolo abilita.
//
// LE DUE CACHE SONO DUE, E NON E' UN'OTTIMIZZAZIONE MANCATA. Con una mappa sola ogni apertura di
// adminconfigplant riscriverebbe `lastGood` spostando in avanti la finestra di 24 h della
// dashboard — quindi «positivo 24 h» non sarebbe piu' un tetto sulla rilevazione di una revoca — e
// un esito negativo della scheda (`roleCache.delete`) porterebbe via ANCHE il grace del perimetro
// su quella coppia. Il prezzo della separazione e' che una risoluzione non alimenta l'altra: sono
// due domande diverse sulla stessa coppia, e la piu' severa non deve poter allentare l'altra.
//
// IL RUOLO GREZZO ARRIVA AL CHIAMANTE, e prima della 0048 no. Il filtro dei ruoli stava nel
// TRASPORTO (`RECOGNIZED_ROLES`, rimossa): 'user' veniva scartato prima di raggiungere qualunque
// chiamante. Allargare quell'insieme non era possibile — i due consumatori di `getUserRole`
// confrontano per uguaglianza e si sarebbero aperti a 'user' sui due segreti Plex — quindi ora il
// trasporto rende il grezzo e a decidere sono i tre predicati di srv/lib/plantAccessRules.js.
// ================================================================

const accessRules = require('./lib/plantAccessRules');

function roleKey(email, plantCode) {
  return `${email}::${plantCode}`;
}

/**
 * [PLANT-ACCESS] Una cache di verdetti di ruolo, con la sua politica e il suo orologio.
 *
 * PERCHE' UN FACTORY. Le due politiche differiscono per UN numero — il TTL del positivo — e
 * scriverle due volte avrebbe significato due copie che divergono sul grace, che e' la parte che
 * nessuno prova mai. `ttlMs: 0` e' «sempre live»: la semantica della scheda di configurazione
 * diventa un dato invece di un ramo.
 *
 * L'OROLOGIO E' INIETTABILE perche' altrimenti questa politica non e' collaudabile: 24 h e 96 h
 * non si aspettano in un test, e prima della 0048 `Date.now()` era cablato e la mappa non era
 * esportata — cioe' l'intera semantica era protetta soltanto dai commenti. E' il modello di
 * srv/lib/productDetailCache.js.
 *
 * `licenseCache` NON passa da qui, di proposito: quel percorso funziona e riscriverlo sarebbe una
 * regressione cercata su un ramo che non ha nessun test (DEC-34, come criterio).
 */
function createRoleCache({ ttlMs, graceMs, now = () => Date.now() } = {}) {
  // `${email}::${plantCode}` -> { lastGood: <ms>, role: <string>, apiKeyId: <winning ID> }
  const map = new Map();
  return {
    /** Il ruolo positivo ancora fresco, o `null`. Con `ttlMs: 0` rende sempre `null`. */
    fresh(key) {
      const e = map.get(key);
      if (!e || !(ttlMs > 0)) return null;
      return (now() - e.lastGood) < ttlMs ? e.role : null;
    },
    /** Il ruolo dentro la finestra di grace, o `null`. Si usa solo quando il server non risponde. */
    grace(key) {
      const e = map.get(key);
      if (!e) return null;
      return (now() - e.lastGood) < graceMs ? e.role : null;
    },
    /** La chiave che aveva risolto questa coppia l'ultima volta, per provarla per prima. */
    lastApiKeyId(key) {
      const e = map.get(key);
      return e ? e.apiKeyId : null;
    },
    remember(key, role, apiKeyId) { map.set(key, { lastGood: now(), role, apiKeyId }); },
    /** Un negativo DEFINITIVO cancella: nessun grace su un ruolo revocato. */
    forget(key) { map.delete(key); },
    clear() { map.clear(); },
    get size() { return map.size; }
  };
}

/** La cache della scheda di configurazione: nessun positivo fresco, solo il grace. */
const roleCacheLive = createRoleCache({ ttlMs: 0, graceMs: GRACE_MS });
/** [PLANT-ACCESS] La cache del perimetro: la politica del check plant (24 h / live / 96 h). */
const roleCacheScope = createRoleCache({ ttlMs: POSITIVE_TTL_MS, graceMs: GRACE_MS });

/**
 * [PLANT-ACCESS] L'identita' nei log, mascherata. Dalla 0048 questa riga esce per ogni plant di ogni
 * lettura del cockpit, non piu' una volta all'apertura di una scheda: un indirizzo e-mail e' un dato
 * personale (DEC-10) e `cf logs` e' conservato.
 *
 * [LICENSE-BODY] LA FUNZIONE E' UNA E STA IN srv/lib/licenseLogRules.js (importata in testa a questo
 * file). Si e' spostata la' perche' da la' maschera ANCHE il corpo della risposta, e due definizioni
 * della stessa regola vorrebbero dire un indirizzo mascherato nella riga di verdetto e intero nella
 * riga del corpo — cioe' la difesa aggirata dalla diagnostica che le sta accanto.
 */

/**
 * Call the license server for one (apiKey, plant, email). Returns:
 *   { ok: true, role: <ruolo GREZZO riconosciuto, o null> }  su una risposta definitiva — `Role`
 *                                                            assente OPPURE un HTTP 403, con cui il
 *                                                            server dichiara «non abilitato»,
 *   { ok: true, role: null, shapeUnknown: true }             su una risposta di FORMA IGNOTA,
 *   { ok: false }                                            su un errore tecnico/di rete.
 *
 * [PLANT-ACCESS] «VUOTO NON E' IGNOTO», E QUI VALE PER LA FORMA DELLA RISPOSTA.
 *
 * Il ruolo si legge da `res.data.d` (envelope OData V2). Se quella forma cambiasse, `row` sarebbe
 * `undefined`, il ruolo `null`, e dopo K chiavi l'esito sarebbe `invalid` — cioe' un NO-ACCESS
 * DEFINITIVO, senza grace, per ogni utente e ogni plant. E la riga di log direbbe
 * `Role=(nessuno) -> NESSUN ACCESSO`, identica a un no-access vero: il difetto piu' grave che
 * questo modulo puo' avere, reso invisibile. Il ramo plant qui sopra distingue da sempre
 * («(nessuna riga)»); questo no, e fino alla 0048 il danno si fermava a una scheda.
 * Ora la forma ignota si DICHIARA e viaggia fino al chiamante, che la tratta come «non lo so»
 * (grace, e non cancellazione della cache) invece di come «non hai un ruolo».
 */
async function callUserRoleServer(dest, apiKey, plantCode, email, keyId) {
  const { target, destination } = traceTargetOf(dest);
  const who = maskEmail(email);
  // [LICENSE-BODY] Il gettone che nomina la chiamata nelle righe del corpo: i plant si risolvono in
  // parallelo, quindi in `cf logs` le righe si mescolano e una riga senza la sua coppia non e'
  // attribuibile. Il Bearer non esce, esce l'ID della chiave (vedi `callLicenseServer`).
  const label = `user ${who} plant ${plantCode}`;
  console.log(`>>> [LICENSE] GET ${target}/LicenseStatus?plant=${plantCode}&email=${who}`
    + ` - chiave ${keyId || '(senza ID)'}`);
  const t0 = Date.now();
  const traceBase = { kind: L.TRACE_OP.ROLE, plant: plantCode, email, apiKey, target, destination };
  try {
    const res = await executeHttpRequest(dest, {
      method: 'GET',
      url: '/LicenseStatus',
      params: { plant: plantCode, email },
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: LICENSE_TIMEOUT_MS   // [PLANT-ACCESS] vedi il docblock della costante
    });
    const d = res && res.data && res.data.d;
    const row = d && Array.isArray(d.results) ? d.results[0] : d;
    if (!row || typeof row !== 'object') {
      // Forma non riconosciuta: NON e' un no-access. Vedi il docblock.
      console.error(`>>> [LICENSE] user ${who} plant ${plantCode}: HTTP ${res && res.status},`
        + ' RISPOSTA DI FORMA IGNOTA (nessuna riga sotto `d`) -> trattata come NON CONCLUSIVA');
      // [LICENSE-BODY] E' il ramo che ha piu' bisogno del corpo: la riga qui sopra dice che sotto
      // `d` non c'era una riga e non dice COSA c'era al suo posto — un envelope diverso, una pagina
      // di login da una destination sbagliata e un corpo vuoto si leggono tutti uguali.
      console.error(`>>> [LICENSE] ${L.bodyLine(res, { who: label, secrets: [apiKey] })}`);
      // La voce esce KO: la risposta c'e' stata ma non e' utilizzabile, ed e' l'unico modo di
      // distinguere a schermo un envelope cambiato da un utente senza ruolo.
      trace(Object.assign({}, traceBase, {
        res, ms: Date.now() - t0, outcome: 'KO',
        errorText: 'RISPOSTA DI FORMA IGNOTA: nessuna riga sotto `d`',
        verdict: 'FORMA IGNOTA -> non conclusiva (grace, non «nessun ruolo»)'
      }));
      return { ok: true, role: null, shapeUnknown: true };
    }
    // Il server risponde Role solo se Valid=true e l'email e' stata inviata; altrimenti e' assente.
    // Valori possibili: 'admin' | 'admin-config' | 'user' (il confronto e' tollerante).
    const rawRole = row.Role != null ? String(row.Role).trim().toLowerCase() : '';
    const role = accessRules.normalizeRole(rawRole);
    console.log(`>>> [LICENSE] user ${who} plant ${plantCode}: HTTP ${res && res.status},`
      + ` Role=${rawRole || '(assente)'} -> ${role || 'NESSUN RUOLO'}`);
    // [LICENSE-BODY] `Role` assente e `Role` non riconosciuto sono due cose diverse, e la riga qui
    // sopra le rende quasi uguali: il corpo dice quale delle due, e con che grafia.
    console.log(`>>> [LICENSE] ${L.bodyLine(res, { who: label, secrets: [apiKey] })}`);
    trace(Object.assign({}, traceBase, {
      res, ms: Date.now() - t0,
      verdict: `Role=${rawRole || '(assente)'} -> ${role || 'NESSUN RUOLO'}`
    }));
    return { ok: true, role };
  } catch (e) {
    // [PLANT-ACCESS] IL RIFIUTO DICHIARATO: e' QUI che il 403 conta davvero, perche' e' la risposta
    // con cui il server dice «questo utente non e' abilitato su quel plant». Vale come un `Role`
    // assente — risposta pulita, nessun ruolo — quindi il verdetto e' `NO_ROLE` e non `UNKNOWN`, il
    // grace non si applica e un'abilitazione revocata sparisce alla richiesta dopo, non fra 96 ore.
    //
    // Come nel ramo licenza, NON interrompe il ciclo sulle chiavi: una chiave che non copre questo
    // utente rifiuta, un'altra puo' concedergli un ruolo. E la FORMA IGNOTA qui sopra resta un
    // guasto: la' il server ha risposto qualcosa che non sappiamo leggere, qui ha detto no.
    if (L.isAccessDenied(e)) {
      console.warn(`>>> [LICENSE] user ${who} plant ${plantCode}: HTTP ${L.DENIED_STATUS}`
        + ' -> NON ABILITATO per questa chiave (risposta del server, non un guasto)');
      console.warn(`>>> [LICENSE] ${L.errorLine(e, { who: label, secrets: [apiKey] })}`);
      trace(Object.assign({}, traceBase, {
        err: e, ms: Date.now() - t0,
        verdict: `HTTP ${L.DENIED_STATUS} -> NON ABILITATO (rifiuto dichiarato)`
      }));
      return { ok: true, role: null };
    }
    console.error(`>>> [LICENSE] user ${who} plant ${plantCode}: technical error - ${e.message}`);
    // [LICENSE-BODY] Vedi `callLicenseServer`: senza questa riga un 401 non lascia il suo motivo.
    console.error(`>>> [LICENSE] ${L.errorLine(e, { who: label, secrets: [apiKey] })}`);
    trace(Object.assign({}, traceBase, {
      err: e, ms: Date.now() - t0, verdict: 'chiamata non riuscita: nessun verdetto'
    }));
    return { ok: false };
  }
}

/**
 * Live role check across all active API keys (discovery), mirror di checkPlantLive.
 * Returns { outcome:'valid', role, apiKeyId } | { outcome:'invalid' } | { outcome:'unreachable' }.
 *
 * [PLANT-ACCESS] SI TIENE IL RUOLO PIU' FORTE, NON IL PRIMO — E SI ESCE SU 'admin'.
 *
 * Prima della 0048 il ciclo si fermava alla prima chiave che rendeva un ruolo, e funzionava perche'
 * il trasporto scartava 'user': il primo ruolo era per costruzione uno dei due che contavano. Col
 * ruolo grezzo quella regola diventa sbagliata — se la chiave A risponde 'user' e la B 'admin',
 * fermarsi su A DEGRADEREBBE un amministratore, che perderebbe l'accesso alla configurazione con un
 * 403 letto come «licenza scaduta».
 *
 * Ma iterare sempre tutte le chiavi farebbe pagare K chiamate SERIALI anche all'utente abilitato,
 * cioe' al caso normale, e dalla 0048 quel costo si moltiplica per plant e per richiesta. Da qui
 * l'uscita anticipata: su 'admin' nessun ruolo puo' essere piu' forte, quindi la ricerca finisce.
 * Il costo pieno resta a chi non ha nessun ruolo — che e' anche l'unico caso in cui serve davvero.
 *
 * @param {object} cache la cache del chiamante: decide solo quale chiave provare per prima
 */
async function checkUserRoleLive(plantCode, email, cache) {
  const dest = resolveDestination();
  if (!dest) {
    console.error('>>> [LICENSE] no MARS_LICENSE destination/URL configured');
    return { outcome: 'unreachable' };
  }
  let keys;
  try {
    // [PLANT-ACCESS] Si COPIA: `getApiKeys()` rende l'array in cache e il fast-path lo riordina.
    keys = [...(await getApiKeys())];
  } catch (e) {
    console.error(`>>> [LICENSE] cannot read ZLicenseConfig, treating as unreachable - ${e.message}`);
    return { outcome: 'unreachable' };
  }
  if (!keys.length) {
    console.warn('>>> [LICENSE] no ZLicenseConfig rows: user treated as no-access');
    return { outcome: 'invalid' };
  }
  // Try the previously winning key first (fast path for the common case).
  const prevKeyId = cache && cache.lastApiKeyId(roleKey(email, plantCode));
  if (prevKeyId) {
    const i = keys.findIndex(k => k.ID === prevKeyId);
    if (i > 0) keys.unshift(keys.splice(i, 1)[0]);
  }

  let anyError = false;
  let best = null;
  let bestKeyId = null;
  for (const k of keys) {
    const r = await callUserRoleServer(dest, k.ApiKey, plantCode, email, k.ID);
    // Una FORMA IGNOTA non e' una risposta: vale come un errore tecnico, quindi grace e non
    // cancellazione. Se fosse trattata come «nessun ruolo», un envelope cambiato spegnerebbe la
    // dashboard di tutti senza appello.
    if (!r.ok || r.shapeUnknown) { anyError = true; continue; }
    if (!r.role) continue;
    const stronger = accessRules.strongestRole([best, r.role]);
    if (stronger !== best) { best = stronger; bestKeyId = k.ID; }
    if (accessRules.isStrongestRole(best)) break;   // nessuno puo' essere piu' forte
  }
  if (best) return { outcome: 'valid', role: best, apiKeyId: bestKeyId };
  // No key returned a recognized role. Clean answers -> genuine no-access; any error -> unreachable.
  return { outcome: anyError ? 'unreachable' : 'invalid' };
}

/**
 * [PLANT-ACCESS] Il corpo condiviso dei due check di ruolo. La politica la porta la `cache`.
 *
 * @param {string} email
 * @param {string} plantCode
 * @param {object} cache      `roleCacheLive` (sempre live) o `roleCacheScope` (positivo 24 h)
 * @returns {Promise<{role: ?string, known: boolean}>}
 *   `known: false` = non si e' potuto sapere (server irraggiungibile e grace esaurito). NON e'
 *   «nessun ruolo»: chi decide un perimetro deve poter dichiarare le due cose separatamente.
 */
async function resolveRole(email, plantCode, cache) {
  if (licenseDisabled()) {
    warnDisabledOnce();
    const role = disabledRole();
    trace(Object.assign({ kind: L.TRACE_OP.ROLE, plant: plantCode, email }, traceTargetOf(null),
      { cached: 'LICENSE_DISABLED', verdict: `Role=${role} (controllo disabilitato)` }));
    return { role, known: true };
  }
  if (!email || !plantCode) return { role: null, known: true };
  const key = roleKey(email, plantCode);

  const cached = cache.fresh(key);
  if (cached) {
    // [LICENSE-BODY] Vedi `isPlantLicensed`: il ramo che NON chiama e' quello normale, e va detto.
    // La cache della scheda di configurazione ha `ttlMs: 0`, quindi questo ramo e' del solo
    // perimetro della dashboard: la nota nomina la finestra, non «cache» genericamente.
    trace(Object.assign({ kind: L.TRACE_OP.ROLE, plant: plantCode, email },
      traceTargetOf(resolveDestination()),
      { cached: 'cache 24 h (ruolo del perimetro)', verdict: `Role=${cached}` }));
    return { role: cached, known: true };
  }

  const live = await checkUserRoleLive(plantCode, email, cache);
  if (live.outcome === 'valid') {
    cache.remember(key, live.role, live.apiKeyId);
    return { role: live.role, known: true };
  }
  if (live.outcome === 'invalid') {
    cache.forget(key);   // negativo definitivo -> nessun grace sul vecchio positivo
    return { role: null, known: true };
  }
  const graced = cache.grace(key);
  if (graced) {
    console.warn(`>>> [LICENSE] user ${maskEmail(email)} plant ${plantCode}:`
      + ' server unreachable, serving cached role (grace)');
    // [LICENSE-BODY] La voce del grace e' la piu' importante delle tre: qui il ruolo servito NON
    // viene dal server, che non ha risposto, e a schermo un accesso in grace e' identico a uno
    // verificato. La chiamata caduta ha lasciato la sua voce KO poco sopra: le due insieme
    // raccontano «non ha risposto, e sto usando il vecchio positivo».
    trace(Object.assign({ kind: L.TRACE_OP.ROLE, plant: plantCode, email },
      traceTargetOf(resolveDestination()),
      { cached: 'grace 96 h (server non raggiungibile)', verdict: `Role=${graced}` }));
    return { role: graced, known: true };
  }
  console.warn(`>>> [LICENSE] user ${maskEmail(email)} plant ${plantCode}:`
    + ' server unreachable, no valid grace -> fail-closed');
  return { role: null, known: false };
}

/**
 * Il ruolo dell'utente su un plant, per la SCHEDA DI CONFIGURAZIONE.
 *
 * Contratto invariato dalla 0020: va sempre live (la cache serve solo al grace) e rende soltanto
 * uno dei due ruoli che aprono la configurazione. `'user'`, che il trasporto ora fa arrivare, qui
 * non passa — i due consumatori confrontano per uguaglianza e si aprirebbero ai segreti Plex.
 *
 * @param {string} email
 * @param {string} plantCode
 * @returns {Promise<'admin'|'admin-config'|null>}  null = nessun accesso alla config (fail-closed).
 */
async function getUserRole(email, plantCode) {
  const { role } = await resolveRole(email, plantCode, roleCacheLive);
  return accessRules.enablesPlantConfig(role) ? role : null;
}

/**
 * [PLANT-ACCESS] Il ruolo GREZZO dell'utente su un plant, per il PERIMETRO della dashboard.
 *
 * Politica identica al check plant (`isPlantLicensed`), ed e' una decisione di progetto: positivo
 * in cache 24 h, negativo mai in cache — quindi un utente appena abilitato vede il plant subito —
 * e grace 96 h se il server non risponde. La conseguenza da conoscere e' l'altra faccia: un utente
 * REVOCATO continua a vedere il plant fino a 24 h, e fino a 96 h se il server e' irraggiungibile.
 * E' la stessa proprieta' che la licenza ha da sempre: la sicurezza complessiva della schermata
 * resta comunque limitata dalle 24 h del positivo di licenza, qualunque cosa si scelga qui.
 *
 * Rende il ruolo grezzo e non un booleano: chi compone il perimetro deve poter distinguere «non hai
 * un ruolo» da «non l'ho potuto sapere» (`known`), perche' un perimetro che si svuota deve
 * dichiarare PERCHE'.
 *
 * @returns {Promise<{role: ?string, known: boolean}>}
 */
async function getUserPlantRole(email, plantCode) {
  return await resolveRole(email, plantCode, roleCacheScope);
}

/**
 * Drop a cached role verdict.
 *
 * [PLANT-ACCESS] NON E' AGGANCIATA A NESSUN HANDLER, ED E' UNA DECISIONE (feature 0048).
 *
 * I tre punti che invalidano la licenza — l'`after` su `ZPlant`, la cascata di `deletePlant`,
 * l'`after` su `ZLicenseConfig` — non conoscono una e-mail, quindi la chiamerebbero senza argomenti:
 * cioe' `clear()`, cioe' via l'INTERA base del grace di 96 h. E l'`after` su `ZPlant` scatta sui
 * salvataggi ORDINARI di adminconfigplant (Max retry, auto-assegnazione, MatDocPostEnabled sono
 * PATCH su quella entity). L'effetto composto: un amministratore salva un parametro, il license
 * server cade dieci minuti dopo, e il cockpit e' vuoto per ogni utente su ogni plant — senza che
 * niente colleghi le due cose.
 *
 * Resta esportata perche' e' la sola leva manuale se un giorno servisse forzare una rilettura, e
 * perche' con `getUserPlantRole` una cache positiva ora esiste davvero. Chi la aggancia a un
 * handler deve prima avere un'e-mail in mano.
 */
function invalidateUserRole(email, plantCode) {
  if (email && plantCode) {
    roleCacheLive.forget(roleKey(email, plantCode));
    roleCacheScope.forget(roleKey(email, plantCode));
  } else {
    roleCacheLive.clear();
    roleCacheScope.clear();
  }
  console.log('>>> [LICENSE] role cache invalidated'
    + (email && plantCode ? ` for ${maskEmail(email)}::${plantCode}` : ' (all)'));
}

module.exports = {
  isPlantLicensed,
  getUsablePlants,
  invalidateLicense,
  getUserRole,
  getUserPlantRole,
  invalidateUserRole,
  invalidateApiKeys,
  // [PLANT-ACCESS] Esportati per il test della politica di cache: la semantica di 24 h / live /
  // 96 h non e' verificabile senza un orologio, e prima della 0048 non lo era affatto.
  createRoleCache,
  POSITIVE_TTL_MS,
  GRACE_MS
};

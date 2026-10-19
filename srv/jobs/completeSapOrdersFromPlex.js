/**
 * ============================================================================
 * [ORDER-COMPLETE] Job ORDER_COMPLETE — il job Plex completato diventa uno stato utente in SAP
 * ============================================================================
 * Feature 0045, requisito W1-12 della BBP (§8.2.2), ri-aperto dopo il ritiro del 18/08/2026.
 *
 * Legge da Plex i job di produzione passati a `Completed` e lo dichiara sull'ordine di produzione
 * SAP collegato, chiamando `ZMARS_PROD_ORDER_CLOSE` — che su questo sistema imposta uno STATO
 * UTENTE informativo, non la chiusura di sistema. E' il verso opposto del job `PROD_TECO`.
 *
 * ============================================================================
 * IL GIRO DI UN RUN: LA FINESTRA RILEVA, LA TABELLA DI STATO DECIDE CHI SI INVIA
 * ============================================================================
 *
 *   A. FINESTRA        una lettura per plant: `GET /scheduling/v1/jobs?completedDateBegin=…`
 *                      -> filtra per `PlexStatuses`, incrocia col dizionario dei lotti, e
 *                         PERSISTE una riga per job. NESSUNA POST parte in questo passo.
 *   B. INVIO           una lettura dal DATABASE di tutte le righe non terminali — quelle appena
 *                      rilevate E l'arretrato ('D', 'E', 'Q', 'P' orfane) — e per ognuna
 *                         prenotazione condizionale -> POST -> stato.
 *
 * LA DIVISIONE FRA A E B E' LA COSA PIU' IMPORTANTE DI QUESTO FILE, e la prima stesura non l'aveva.
 * Derivare i candidati dalla sola finestra sembra naturale e non funziona: la sovrapposizione fra
 * due finestre e' di DUE MINUTI (`PLEX_COMPLETE_LOOKBACK_SECONDS`), non di un run, e il seme
 * dell'avvio a freddo si sposta solo IN AVANTI. Quindi una riga lasciata in 'D' — che e' cio' che
 * accade a TUTTO l'arretrato di un plant finche' la sua casella e' chiusa — non tornerebbe mai piu'
 * fra i candidati, e il giorno dell'accensione servirebbe un backfill a mano: esattamente cio' che
 * DEC-71 promette di non richiedere. Le stesse promesse reggono in `PROD_TECO` (`loadCandidates`) e in
 * `PROD_CONF` (`requeueQuarantined` + l'invio guidato da `where Status:'E'`) perche' la' i
 * candidati vengono dal DATABASE. Qui e' uguale.
 *
 * ============================================================================
 * UN SOLO INTERRUTTORE, E CON QUELLO CHIUSO SI RILEVA COMUNQUE
 * ============================================================================
 *   ZProdOrderCompleteConfig.IsEnabled   per plant, dal customizing, senza rilascio.
 *
 * Chiuso, il job RILEVA, scrive 'D' e lo DICHIARA nel recap: niente si perde, e l'arretrato parte da
 * se' il giorno in cui la casella si accende (DEC-71).
 *
 * NESSUNA LEVA DI PROCESSO, E LA STORIA VA DETTA PERCHE' E' CAMBIATA. La 0045 aveva messo sopra
 * questo interruttore anche `ORDER_STATUS_POST` — la leva della sonda, che mta.yaml tiene a `off` in
 * produzione — sul modello di come la 0030 aveva promosso `PRODCONF_POST` (DEC-94). Era sbagliato
 * per questo flusso: un job batch che parte dallo scheduler DEVE scrivere, e con quella leva chiusa
 * in produzione avrebbe rilevato i completamenti senza mandarne nessuno, chiudendo in verde. Dalla
 * 0046 quella leva governa la SOLA sonda del cockpit, e questo job non la legge — vedi la testata di
 * `readTransportConfig` in srv/lib/prodOrderStatusPost.js.
 *
 * ============================================================================
 * LE COSE CHE ROMPONO IN SILENZIO, E COME SONO CHIUSE
 * ============================================================================
 *  1. `GET /scheduling/v1/jobs` NON PAGINA — nessun `$top`, nessun cursore, nessun conteggio —
 *     quindi una risposta troncata e' indistinguibile da una completa e il watermark avanzerebbe
 *     come se avesse letto tutto. Difese: tetto della finestra a DUE ore (non 24 come la
 *     consuntivazione), soglia di sospetto oltre la quale la finestra si dimezza e si rilegge, e se
 *     anche la meta' la supera la lettura e' DEGRADATA — watermark fermo.
 *     Quel tetto e' della CHIAMATA e non del RUN, e dal 09/09/2026 le due cose sono distinte: il
 *     run ripete la finestra finche' il punto di ripresa arriva a `now` (vedi `catchUpPlant`).
 *     Prima erano la stessa cosa, e un plant quattro giorni indietro chiudeva in verde: il tetto
 *     limitava non la singola lettura ma quanto passato il job era capace di guardare.
 *  2. `plexGet` LANCIA su errore di rete e RITORNA `{ok:false}` su HTTP non-2xx: sono la stessa
 *     notizia («quella finestra non e' stata letta») e finiscono nello stesso ramo.
 *  3. `plexGet` non ha TIMEOUT per default: un endpoint che accetta la connessione e non risponde
 *     appenderebbe il run finche' non lo uccide il watchdog dello scheduler (240 minuti).
 *  4. FORMA DI RISPOSTA IGNOTA != FINESTRA VUOTA. Con 'A' terminale, una forma cambiata letta come
 *     «nessun completamento» farebbe avanzare il watermark su una finestra che nessuno ha guardato.
 *  5. IL CRITERIO NON SI SPINGE su Plex. `jobStatuses` esiste come filtro, ma un filtro lato Plex
 *     su una lettura a watermark fa MENTIRE il watermark — e' il divieto che
 *     PLEX_PRODUCTION_HISTORY_API_CONTRACT.md dichiara per il flusso gemello: «e' la prima
 *     "ottimizzazione" che viene in mente guardando questi endpoint. Non si fa». Si filtra a valle,
 *     e il recap dichiara gli STATI DISTINTI VISTI: cosi' un refuso nel customizing si legge,
 *     invece di comparire come uno zero.
 *  6. IL TETTO DEI TENTATIVI SI CONSUMA SOLO SUI RIFIUTI APPLICATIVI. Vedi l'asimmetria 2 in testa
 *     a srv/lib/prodOrderComplete.js: l'unico esito misurato su quell'iFlow e' il guscio di
 *     messaggio VUOTO, e col tetto che lo consuma il primo run archivierebbe l'intero arretrato.
 *
 * LEVE (nessuna richiede un rilascio, tutte da impostare SIA sul modulo srv SIA sui task dello
 * scheduler — le env non si ereditano, DEC-30)
 *   PLEX_COMPLETE_COLD_START_MINUTES  60    quanto indietro parte la PRIMA lettura di un plant
 *   PLEX_COMPLETE_LOOKBACK_SECONDS   120    sovrapposizione fra due finestre consecutive
 *   PLEX_COMPLETE_WINDOW_MAX_HOURS     2    ampiezza massima di una singola lettura
 *   PLEX_COMPLETE_MAX_WINDOWS_PER_RUN  0    tetto di finestre per plant per run; 0 = fino a `now`
 *   PLEX_COMPLETE_ROWS_SUSPECT       500    oltre questo la finestra si dimezza (troncamento)
 *   PLEX_COMPLETE_READ_TIMEOUT_MS  60000    scadenza della lettura; 0 = nessuna
 *   PLEX_COMPLETE_MAX_ATTEMPTS         3    rifiuti applicativi prima di 'X'
 *   PLEX_COMPLETE_MAX_PER_RUN          0    tetto di ordini inviati per run; 0 = illimitato
 *   PLEX_COMPLETE_STALE_MINUTES       30    oltre questo una prenotazione e' orfana
 *   PLEX_COMPLETE_QUARANTINE_DAYS     30    oltre questo una quarantena non si ri-risolve piu'
 *   PLEX_COMPLETE_STALE_DAYS           7    da quanto una riga in attesa entra nella «coda ferma»
 *   PLEX_COMPLETE_SKIP_TECO_ECHO      off   non scrivere sugli ordini che il TECO ha chiuso da noi
 * `ORDER_STATUS_POST` NON e' fra le leve di questo job: governa la sola sonda del cockpit.
 *
 * Perimetro completo: grep -rn "ORDER-COMPLETE"
 */

'use strict';

const cds = require('@sap/cds');
const { resolveActivePlants, plexGet } = require('./lib/plexJobsClient');
// [PLEX-CONN] Connessione a Plex PER PLANT (feature 0020): punto unico di risoluzione.
const { resolvePlexConnection, PlexConnectionMissing } = require('../lib/plexConnection');
// [PLEX-CALL] Le chiamate Plex si tracciano: il wrapper non ne aggiunge nessuna, avvolge quelle che
// partono comunque e ne stampa indirizzo, corpo e stato in `cf logs` — che per un job e' l'unico
// posto dove si vedono, perche' l'anello in memoria di isCallLog.js non copre i processi separati
// (isCallLog.js:36-38). Su un endpoint che ha gia' risposto `500` opaco, il corpo e' l'unico indizio.
const plexCallTrace = require('../lib/plexCallTrace');
// [ORDER-COMPLETE] Le regole pure: criterio, incrocio, stati, classificazione dell'esito, recap.
// E' il LEGAME al flusso `COMPLETE` di srv/lib/orderStatusFlow.js, condiviso col job gemello.
const complete = require('../lib/prodOrderComplete');
// [ORDER-COMPLETE] [ORDER-SCHEDULED] La fase B — prenotazione, POST, stato, storico — condivisa
// con `ORDER_SCHEDULED`: qui resta la sola fase A, cioe' la finestra a watermark.
const send = require('../lib/orderStatusSend');
// La finestra a watermark, condivisa con PROD_CONF: `prefix` distinto, tetto distinto.
//
// `readFailureMessage` e `readFailureSegments` NON si riusano, e non e' una dimenticanza: il loro
// testo dice «le REGISTRAZIONI saranno riprese dal prossimo run» (`logConfReadFailed`), che qui
// sarebbe falso — non si tratta di registrazioni di produzione ma di job completati. Un messaggio
// riusato che nomina l'oggetto sbagliato manda a cercare il difetto nel flusso sbagliato, e costa
// piu' delle sei righe di `readFailure` qui sotto.
const { resolveWindow, readWindowConfig } = require('../lib/plexConfWindow');
// [ORDER-COMPLETE] La scrittura verso SAP. `postOrderClose` manda UNA sola chiamata, `close`:
// `variantsFor` della sonda ne manderebbe due, e la seconda e' un TECO vero.
const { postOrderClose } = require('../lib/prodOrderStatusPost');
// [ORDER-LOG-OP] Lo storico invii dell'ordine, con la sua `Operation`.
const excLog = require('../lib/prodOrderExcLog');
const logMsg = require('../lib/logMessage');
const i18nMessages = require('../lib/i18nMessages');
const { PLANT_NA: PLANT_UNKNOWN } = require('../lib/jobCodes');

const JOB_CODE = complete.JOB_CODE;
const SOURCE_CODE = complete.SOURCE_CODE;
const OBJECT_TYPE = 'PROD_ORDER_COMPLETE';

/**
 * FQN come STRINGHE: `db.entities()` e' deprecato in CAP 9 e non e' invocabile in contesto job
 * standalone. Stessa scelta di tutti gli altri job.
 */
const NS = complete.NS;
const E_MAPPING = `${NS}.ZProdOrderPlexMapping`;
const E_STATE = complete.E_COMPLETE_STATE;
const E_TECO_STATE = `${NS}.ZProdOrderTecoState`;
const E_WATERMARK = `${NS}.ZJobReadWatermark`;

const { STATE, OUTCOME, cut, s } = complete;

/** Il messaggio persistito e' uno SNAPSHOT in italiano; la resa alla lettura e' del server. */
const renderMsg = (segments) => i18nMessages.render(
  logMsg.normalize(segments), i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE
);

// ---------------------------------------------------------------------------------------------
// LEVE
// ---------------------------------------------------------------------------------------------

const env = process.env;
const MAX_ATTEMPTS = complete.intEnv(env, 'PLEX_COMPLETE_MAX_ATTEMPTS', 3);
const MAX_PER_RUN = complete.intEnv(env, 'PLEX_COMPLETE_MAX_PER_RUN', 0);
const STALE_MINUTES = complete.intEnv(env, 'PLEX_COMPLETE_STALE_MINUTES', 30);
const QUARANTINE_DAYS = complete.intEnv(env, 'PLEX_COMPLETE_QUARANTINE_DAYS', 30);
const ROWS_SUSPECT = complete.intEnv(env, 'PLEX_COMPLETE_ROWS_SUSPECT', 500);
const READ_TIMEOUT_MS = complete.intEnv(env, 'PLEX_COMPLETE_READ_TIMEOUT_MS', 60000);
const STALE_DAYS = complete.intEnv(env, 'PLEX_COMPLETE_STALE_DAYS', 7);
/**
 * Quante finestre al massimo puo' percorrere un run per plant. `0` = fino a `now`, ed e' il default.
 *
 * NON serve alla terminazione — quella la garantisce `now` fissato una volta per run — serve a poter
 * fermare il recupero dall'ambiente senza un rilascio, se un giorno un arretrato enorme allungasse
 * troppo un run.
 */
const MAX_WINDOWS_PER_RUN = complete.intEnv(env, 'PLEX_COMPLETE_MAX_WINDOWS_PER_RUN', 0);
const SKIP_TECO_ECHO = ['on', 'true', '1', 'yes']
  .includes(String(env.PLEX_COMPLETE_SKIP_TECO_ECHO || '').trim().toLowerCase());

/**
 * La configurazione della finestra, col PREFISSO di questo job.
 *
 * Il tetto e' DUE ORE e non 24, e non e' un numero scelto per prudenza: `GET /scheduling/v1/jobs`
 * non pagina, quindi la finestra piccola e' l'unica difesa vera dal troncamento (punto 1 in testa).
 * Il default si applica solo se nessuno ha impostato la leva — chi la imposta sa cosa sta facendo.
 */
const WINDOW_CFG = (() => {
  const cfg = readWindowConfig(env, 'PLEX_COMPLETE');
  const raw = env.PLEX_COMPLETE_WINDOW_MAX_HOURS;
  if (raw === undefined || String(raw).trim() === '') cfg.windowMaxHours = 2;
  return cfg;
})();

const PERMANENT_MESSAGES = complete.readPermanentMessages(env);

// ---------------------------------------------------------------------------------------------
// IL WATERMARK — le regole sono pure in srv/lib/plexConfWindow.js, qui c'e' solo la persistenza
// ---------------------------------------------------------------------------------------------

const toIso = (v) => (v instanceof Date ? v.toISOString() : (v ? String(v) : null));
const nowIso = () => new Date().toISOString();

async function readWatermark(db, plant) {
  return db.run(
    SELECT.one.from(E_WATERMARK)
      .where({ JobCode: JOB_CODE, SourceCode: SOURCE_CODE, Plant: plant })
  );
}

/**
 * Crea la riga di watermark PRIMA della chiamata a Plex, col seme di avvio a freddo.
 *
 * Se la si scrivesse dopo, un primo tentativo fallito lascerebbe il plant senza watermark, il run
 * successivo ricalcolerebbe il seme da `now` e la finestra scivolerebbe in avanti — perdendo
 * esattamente l'intervallo che il tentativo fallito non ha letto.
 */
async function seedWatermark(db, plant, seed, now) {
  await db.run(INSERT.into(E_WATERMARK).entries({
    JobCode: JOB_CODE,
    SourceCode: SOURCE_CODE,
    Plant: plant,
    WindowEnd: toIso(seed),
    LastAttemptAt: now.toISOString(),
    LastSuccessAt: null,
    FailureCount: 0,
    LastMessage: 'avvio a freddo: watermark inizializzato prima della prima lettura',
    UpdatedAt: now.toISOString()
  }));
}

/**
 * Lettura riuscita E INGEST PERSISTITO: la finestra avanza alla sua FINE.
 *
 * Non a `now`: col tetto le due cose non coincidono. E non dopo la sola lettura: «tutto cio' che si
 * legge si persiste» (DEC-58/DEC-59) — se l'INSERT delle righe cade, la finestra si rilegge.
 */
async function advanceWatermark(db, plant, endDate, now, message) {
  await db.run(UPDATE(E_WATERMARK).set({
    WindowEnd: endDate,
    LastAttemptAt: now.toISOString(),
    LastSuccessAt: now.toISOString(),
    FailureCount: 0,
    LastMessage: cut(message, 255),
    UpdatedAt: now.toISOString()
  }).where({ JobCode: JOB_CODE, SourceCode: SOURCE_CODE, Plant: plant }));
}

/**
 * Il testo e i segmenti di una lettura non riuscita, per QUESTO flusso.
 *
 * Due rese della stessa cosa perche' vanno in due posti diversi: il TESTO su
 * `ZJobReadWatermark.LastMessage`, che e' lo stato della sorgente e si legge in italiano dal
 * supporto; i SEGMENTI nella riga di recap, che si legge da schermata nella lingua di chi guarda
 * (DEC-92). Non sono due sorgenti per la stessa colonna.
 *
 * L'arretrato in minuti e' il numero che distingue «sto recuperando» da «sono fermo».
 */
function readFailure({ failureCount, now, windowEnd, error = '' }) {
  const mark = windowEnd ? new Date(windowEnd) : null;
  const backlog = mark && !Number.isNaN(mark.getTime())
    ? Math.max(0, Math.round((now.getTime() - mark.getTime()) / 60000))
    : null;
  const parts = [
    `lettura dei job completati non riuscita`,
    `tentativo consecutivo n. ${failureCount}`,
    'finestra NON avanzata: i completamenti saranno ripresi dal prossimo run'
  ];
  if (backlog !== null) parts.push(`arretrato ${backlog} min`);
  if (error) parts.push(String(error));
  return {
    message: parts.join(' · '),
    segments: [
      logMsg.seg('logCompleteReadFailed', failureCount),
      ...(backlog !== null ? [logMsg.seg('logCompleteReadBacklog', backlog)] : []),
      ...(error ? [logMsg.technical(String(error))] : [])
    ].filter(Boolean)
  };
}

/** Lettura fallita o degradata: `WindowEnd` NON si tocca. E' tutto il meccanismo di ripresa. */
async function failWatermark(db, plant, now, failureCount, message) {
  await db.run(UPDATE(E_WATERMARK).set({
    LastAttemptAt: now.toISOString(),
    FailureCount: failureCount,
    LastMessage: cut(message, 255),
    UpdatedAt: now.toISOString()
  }).where({ JobCode: JOB_CODE, SourceCode: SOURCE_CODE, Plant: plant }));
}

// ---------------------------------------------------------------------------------------------
// TRACCIA E PERSISTENZA — condivise con il job gemello
// ---------------------------------------------------------------------------------------------
// `newTrace`, `saveState`, `claimRow`, `writeStatusLog` e `sendOne` vivono in
// srv/lib/orderStatusSend.js: sono identiche nei due flussi, e la loro seconda copia e' esattamente
// il difetto che l'estrazione della 0046 esisteva per togliere. Qui restano esportate per i test
// che le sorvegliano da fuori.
const { newTrace, saveState } = send;

// ---------------------------------------------------------------------------------------------
// PASSO A — LA FINESTRA RILEVA E PERSISTE
// ---------------------------------------------------------------------------------------------

/** L'indirizzo della finestra. Il criterio di stato NON si spinge: vedi il punto 5 in testa. */
function windowPath(window) {
  return '/scheduling/v1/jobs'
    + `?completedDateBegin=${encodeURIComponent(window.beginDate)}`
    + `&completedDateEnd=${encodeURIComponent(window.endDate)}`;
}

/**
 * Una lettura della finestra, con il dimezzamento sul sospetto di troncamento.
 *
 * `plexGet` LANCIA su errore di rete e RITORNA `{ok:false}` su HTTP non-2xx: sono la stessa notizia
 * e finiscono nello stesso ramo. Il dimezzamento si tenta UNA volta: se anche la meta' supera la
 * soglia, la lettura si dichiara degradata e il watermark non avanza — meglio una finestra riletta
 * che un watermark avanzato su righe che nessuno ha visto.
 *
 * [RUN-BLOCKED] `blocked` separa i due modi di NON avere una lettura, che il solo `ok:false`
 * confondeva: la chiamata non ha prodotto una risposta utilizzabile (rete, HTTP non-2xx, forma
 * ignota) oppure la chiamata e' RIUSCITA e siamo noi a sospettare un troncamento. Il primo fa
 * chiudere il run in errore (DEC-124), il secondo resta un'attenzione: il chiamante non deve
 * dedurlo da `recognized`, che porterebbe quella distinzione in un campo nato per un'altra domanda.
 *
 * @returns {{ok, rows, recognized, truncated, blocked, window, status, error, halved}}
 */
async function readWindow(get, window, trace) {
  const attempt = async (w, label) => {
    let r;
    try {
      r = await get(windowPath(w));
    } catch (e) {
      r = { ok: false, status: 0, body: null, thrown: e };
    }
    if (trace) trace.add(`GET jobs completati (${label})`, windowPath(w), r, true);
    return r;
  };

  let w = window;
  let r = await attempt(w, 'finestra');
  if (!r.ok) {
    return {
      ok: false, rows: [], recognized: false, truncated: false, blocked: true, window: w,
      status: r.status || 0,
      error: r.thrown ? `errore di rete: ${r.thrown.message}` : `HTTP ${r.status}`,
      halved: false
    };
  }

  let parsed = complete.readJobRows(r.body);
  if (!parsed.recognized) {
    return {
      ok: false, rows: [], recognized: false, truncated: false, blocked: true, window: w,
      status: r.status || 200,
      error: 'forma della risposta non riconosciuta: non è un array né un involucro noto. NON è '
        + 'una finestra vuota, ed è un guasto: il watermark non avanza',
      halved: false
    };
  }

  let verdict = complete.truncationVerdict(parsed.rows.length, ROWS_SUSPECT);
  if (!verdict.suspect) {
    return {
      ok: true, rows: parsed.rows, recognized: true, truncated: false, blocked: false, window: w,
      status: r.status, error: '', halved: false
    };
  }

  // Sospetto di troncamento: si dimezza sullo stesso inizio, come plantRowsPaging.js.
  const halfEnd = new Date(w.begin.getTime() + Math.floor((w.end.getTime() - w.begin.getTime()) / 2));
  if (halfEnd.getTime() <= w.begin.getTime()) {
    return {
      // La chiamata e' RIUSCITA: e' un troncamento sospettato da noi, non un guasto.
      ok: false, rows: parsed.rows, recognized: true, truncated: true, blocked: false, window: w,
      status: r.status,
      error: `${parsed.rows.length} righe con la finestra già al minimo: non si può dimezzare, e `
        + 'un troncamento non si può escludere',
      halved: false
    };
  }
  w = { ...w, end: halfEnd, endDate: halfEnd.toISOString() };
  r = await attempt(w, 'finestra dimezzata');
  if (!r.ok) {
    return {
      ok: false, rows: [], recognized: false, truncated: true, blocked: true, window: w,
      status: r.status || 0,
      error: r.thrown ? `errore di rete: ${r.thrown.message}` : `HTTP ${r.status}`,
      halved: true
    };
  }
  parsed = complete.readJobRows(r.body);
  if (!parsed.recognized) {
    return {
      ok: false, rows: [], recognized: false, truncated: true, blocked: true, window: w,
      status: r.status || 200,
      error: 'forma della risposta non riconosciuta sulla finestra dimezzata',
      halved: true
    };
  }
  verdict = complete.truncationVerdict(parsed.rows.length, ROWS_SUSPECT);
  if (verdict.suspect) {
    return {
      ok: false, rows: parsed.rows, recognized: true, truncated: true, blocked: false, window: w,
      status: r.status,
      error: `${parsed.rows.length} righe anche sulla finestra dimezzata: la lettura si dichiara `
        + 'DEGRADATA e il watermark non avanza',
      halved: true
    };
  }
  return {
    ok: true, rows: parsed.rows, recognized: true, truncated: false, blocked: false, window: w,
    status: r.status, error: '', halved: true
  };
}

/**
 * Il passo A per un plant: UNA finestra, che rileva e persiste. NON manda niente.
 *
 * Una sola finestra per invocazione, e il tetto di due ore resta quello della CHIAMATA: e' l'unica
 * difesa vera dal troncamento su un endpoint che non pagina (punto 1 in testa). Il giro che porta il
 * punto di ripresa fino a `now` e' del CHIAMANTE — vedi il passo A in `run`.
 *
 * `resumeAt` e' dove e' rimasto il punto di ripresa, e si valorizza in TUTTI i casi: la fine della
 * finestra letta se la lettura e' riuscita, il `WindowEnd` invariato se e' caduta. E' cio' su cui il
 * chiamante decide se il giro e' arrivato a `now`, e serve anche quando `readOk` e' falso, perche' il
 * residuo da dichiarare si misura da lì.
 *
 * @returns {Promise<{readOk: boolean, resumeAt: string|null}>}
 */
async function ingestPlant(ctx, plant, cfg, creds) {
  const { db, summary, now, index, stats } = ctx;

  let wm = await readWatermark(db, plant);
  const window = resolveWindow({ watermark: wm, now, cfg: WINDOW_CFG });
  if (window.coldStart) {
    // PRIMA della chiamata: vedi seedWatermark.
    await seedWatermark(db, plant, window.seed, now);
    wm = { WindowEnd: toIso(window.seed) };
    complete.addWindowOutcome(stats, plant, { coldStart: true });
    summary.scope({
      plant,
      objectKey: `COLD_START/${SOURCE_CODE}`,
      objectType: OBJECT_TYPE,
      status: 'W',
      degrade: false,
      segments: [
        logMsg.seg('logCompleteColdStart', window.beginDate),
        // Il MOTIVO del seme e' prosa del modulo puro e non e' ancora a segmenti: lacuna
        // dichiarata, non silenziosa (grep logMsgVerbatim).
        logMsg.verbatim(window.reason)
      ]
    });
  }
  // L'ARRETRATO NON SI DICHIARA QUI. Lo dichiara il chiamante UNA volta, alla fine del giro, sul
  // residuo vero: da qui dentro si vedrebbe l'arretrato di questa finestra, e su un run che poi lo
  // recupera tutto sarebbe un numero che non significa niente.
  complete.addWindowOutcome(stats, plant, { windows: 1 });

  console.log(`>>> [ORDER-COMPLETE] plant ${plant}: finestra ${window.beginDate} -> `
    + `${window.endDate} (${window.reason})`);

  const traced = plexCallTrace.wrap({
    get: (p) => plexGet(creds, p, { timeoutMs: READ_TIMEOUT_MS }),
    post: () => { throw new Error('[ORDER-COMPLETE] questo job non scrive su Plex'); },
    put: () => { throw new Error('[ORDER-COMPLETE] questo job non scrive su Plex'); }
  }, { order: `PLANT/${plant}`, root: creds.baseUrl, tag: 'PLEX-CALL' });

  const read = await readWindow(traced.get, window, null);
  if (!read.ok) {
    const failureCount = ((wm && wm.FailureCount) || 0) + 1;
    const fail = readFailure({
      failureCount, now, windowEnd: wm && wm.WindowEnd, error: read.error
    });
    await failWatermark(db, plant, now, failureCount, fail.message);
    complete.addWindowOutcome(stats, plant, { readOk: false, truncated: read.truncated });
    console.error(`>>> [ORDER-COMPLETE] plant ${plant}: ${fail.message}`);
    // [RUN-BLOCKED] Il 04/09/2026 questa riga era `status: 'W'`: un HTTP 503 di Plex sull'UNICA
    // lettura che decide su cosa il job lavora chiudeva il run in attenzione con exit 0, e sul
    // dashboard del Job Scheduler la riga risultava COMPLETED/SUCCESS. Una chiamata che non ha
    // prodotto una risposta utilizzabile fa chiudere il run in errore (DEC-124); un troncamento
    // che sospettiamo NOI su una chiamata riuscita resta un'attenzione, ed e' la ragione per cui
    // il verdetto lo porta `read.blocked` e non si deduce qui da `ok`.
    summary.scope({
      plant,
      objectKey: `READ/${SOURCE_CODE}`,
      objectType: OBJECT_TYPE,
      status: read.blocked ? 'E' : 'W',
      segments: fail.segments
    });
    // Il punto di ripresa e' rimasto dov'era: `failWatermark` non tocca `WindowEnd`, ed e' tutto il
    // meccanismo per cui il blocco caduto si richiede al run successivo.
    return { readOk: false, resumeAt: toIso(wm && wm.WindowEnd) };
  }

  // ---- si e' letto: si filtra, si incrocia, si PERSISTE ------------------------------------
  let persisted = 0;
  let unidentified = 0;
  for (const job of read.rows) {
    const jobStatus = s(job && job.jobStatus);
    const inCriteria = complete.matchesStatus(jobStatus, cfg.statuses);
    complete.addWindowRow(stats, plant, jobStatus, inCriteria);
    if (!inCriteria) continue;

    const plexJobId = s(job && job.id);
    if (!plexJobId) {
      // Una riga senza `id` non e' persistibile: la chiave di questa tabella E' l'identita' Plex.
      // Non si inventa un segnaposto — farebbe collidere righe diverse — e non si tace: e' la
      // stessa regola di `interpretById` («riga senza jobNumber: non identificabile»).
      unidentified += 1;
      continue;
    }

    const res = complete.resolveJob(job, index, plant);
    complete.addResolution(stats, plant, res.kind);
    if (res.kind === 'package') continue;
    if (res.kind === 'plantMismatch') {
      summary.scope({
        plant,
        objectKey: s(job.jobNumber) || plexJobId,
        objectType: OBJECT_TYPE,
        status: 'W',
        segments: [logMsg.seg('logCompletePlantMismatch', s(job.jobNumber), res.mappingPlant, plant)]
      });
      continue;
    }

    const quarantine = res.kind === 'quarantine';
    const state = quarantine
      ? STATE.QUARANTINE
      : (cfg.enabled ? STATE.FAILED : STATE.DETECTED);
    const segments = quarantine
      ? [logMsg.seg('logCompleteQuarantine', s(job.jobNumber) || plexJobId)]
      : (cfg.enabled
        ? [logMsg.seg('logCompleteDetected', jobStatus)]
        : [logMsg.seg('logCompletePlantDisabled')]);

    // Una riga gia' TERMINALE non si tocca: 'A' e' fatto, 'X' si ri-arma solo a mano.
    const existing = await db.run(
      SELECT.one.from(E_STATE).columns('State').where({ PlexJobId: plexJobId })
    );
    if (existing && complete.TERMINAL_STATES.includes(s(existing.State))) continue;
    // Una riga gia' in 'P' non si sovrascrive dalla finestra: la sta trattando il passo B.
    if (existing && s(existing.State) === STATE.CLAIMED) continue;

    await saveState(db, {
      plexJobId,
      plant,
      plexJobNumber: s(job.jobNumber),
      plexStatus: jobStatus,
      completedAt: s(job.completedDate) || null,
      quantity: Number(job.quantity),
      quantityCompleted: Number(job.quantityCompleted),
      order: res.order,
      state,
      attempts: existing ? undefined : 0,
      segments
    }, complete.FLOW);
    persisted += 1;
  }

  if (unidentified) {
    summary.scope({
      plant,
      objectKey: `UNIDENTIFIED/${SOURCE_CODE}`,
      objectType: OBJECT_TYPE,
      status: 'W',
      segments: [logMsg.seg('logCompleteNoJobId', unidentified)]
    });
  }

  // L'INGEST E' PERSISTITO: solo ora la finestra puo' avanzare.
  await advanceWatermark(db, plant, read.window.endDate, now,
    `finestra ${read.window.beginDate} -> ${read.window.endDate}: ${read.rows.length} righe, `
    + `${persisted} persistite${read.halved ? ' (finestra dimezzata)' : ''}`);
  return { readOk: true, resumeAt: read.window.endDate };
}

/** Perché il giro si è fermato, per la riga di log. Non è un'enumerazione di dominio. */
const STOP_REASON = {
  now: 'arrivato a adesso',
  read: 'lettura caduta: il blocco si richiede al prossimo run',
  cap: `tetto di ${MAX_WINDOWS_PER_RUN} finestre per run`,
  stuck: 'la finestra non avanza: giro interrotto',
  noResume: 'nessun punto di ripresa leggibile'
};

/** I minuti che restano fra il punto di ripresa e `now`. Mai negativo. */
function residualMinutes(resumeAt, now) {
  const at = Date.parse(resumeAt || '');
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.round((now.getTime() - at) / 60000));
}

/**
 * IL GIRO DELLE FINESTRE: un run porta il punto di ripresa fino a `now`.
 *
 * ============================================================================
 * PERCHE' ESISTE (09/09/2026)
 * ============================================================================
 * Il tetto della finestra e' della CHIAMATA e non del run, e prima erano la stessa cosa: un run
 * consumava UNA finestra, cioe' avanzava di 118 minuti netti (120 meno i 2 di sovrapposizione).
 * Con il watermark fermo al 04/09 e un lotto completato il 09/09, il run del 09/09 alle 12:03 ha
 * interrogato Plex sull'intervallo `04/09 21:38 -> 23:38` — dove giustamente non c'era niente — e
 * ha chiuso in VERDE dichiarando 6385 minuti di arretrato in una riga di `cf logs`. Il
 * completamento stava 54 finestre piu' avanti, e nessun'altra strada lo raccoglieva: il passo B
 * ripesca dal database, quindi solo cio' che una finestra ha GIA' rilevato.
 *
 * La strada sbagliata era alzare `PLEX_COMPLETE_WINDOW_MAX_HOURS`: `GET /scheduling/v1/jobs` non
 * pagina, e la finestra piccola e' l'unica difesa vera dal troncamento (RB-11 della 0045). Quindi
 * la chiamata resta di due ore e a ripetersi e' il giro.
 *
 * ============================================================================
 * LE QUATTRO USCITE, E NESSUNA E' DI COMODO
 * ============================================================================
 *  1. `readOk === false` -> SI FERMA, e questo e' l'INVARIANTE da non rompere. Un blocco di tempo
 *     che non si e' potuto leggere non si perde e non si scavalca: `failWatermark` non tocca
 *     `WindowEnd`, quindi il run successivo ricalcola `begin` da lì e RICHIEDE LO STESSO BLOCCO,
 *     senza tetto ai tentativi (`MAX_ATTEMPTS` e' dei rifiuti applicativi del passo B, non della
 *     lettura: punto 6 in testa). Proseguire il giro dopo una lettura caduta e' il solo modo di
 *     rompere tutto questo, e farebbe avanzare la finestra oltre righe che nessuno ha visto.
 *  2. il punto di ripresa ha raggiunto `now` -> FINITO. E' l'uscita normale.
 *  3. il punto di ripresa NON AVANZA -> si ferma e si dichiara. E' la guardia anti-ciclo: senza,
 *     un difetto nell'aritmetica della finestra diventa un run che non termina e che uccide il
 *     watchdog dello scheduler a 240 minuti.
 *  4. tetto `PLEX_COMPLETE_MAX_WINDOWS_PER_RUN` -> si ferma e si dichiara.
 *
 * IL CONFRONTO E' SU `endDate`, NON SU `capped`, e la differenza non e' cosmetica: sul sospetto di
 * troncamento `readWindow` riscrive `endDate` alla meta' ma `capped` resta quello della finestra
 * di partenza. Una finestra NON limitata che viene dimezzata ha quindi `capped: false` senza
 * arrivare a `now`, e un giro guidato da `capped` si fermerebbe lasciando arretrato in silenzio.
 *
 * `now` e' fissato una volta per run (vedi `run`) e non si rilegge: e' cio' che rende il bersaglio
 * fermo e quindi la terminazione una proprieta' dell'aritmetica, non una speranza.
 */
async function catchUpPlant(ctx, plant, cfg, creds) {
  const { now } = ctx;
  let windows = 0;
  let resumeAt = null;

  for (;;) {
    const res = await ingestPlant(ctx, plant, cfg, creds);
    windows += 1;
    const before = resumeAt ? Date.parse(resumeAt) : NaN;
    if (res.resumeAt) resumeAt = res.resumeAt;

    if (!res.readOk) return { windows, resumeAt, stoppedBy: 'read' };

    const end = Date.parse(resumeAt || '');
    if (!Number.isFinite(end)) return { windows, resumeAt, stoppedBy: 'noResume' };
    if (Number.isFinite(before) && end <= before) {
      return { windows, resumeAt, stoppedBy: 'stuck' };
    }
    if (end >= now.getTime()) return { windows, resumeAt, stoppedBy: 'now' };
    if (MAX_WINDOWS_PER_RUN > 0 && windows >= MAX_WINDOWS_PER_RUN) {
      return { windows, resumeAt, stoppedBy: 'cap' };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// IL RUN
// ---------------------------------------------------------------------------------------------

async function run(summary) {
  console.log(`>>> [JOB CompleteSapOrdersFromPlex] avvio (profilo ${cds.env.profile || '-'})`);
  const db = await cds.connect.to('db');
  const now = new Date();
  const activePlants = await resolveActivePlants(db);

  console.log(`>>> [ORDER-COMPLETE] configurazione: finestra max ${WINDOW_CFG.windowMaxHours}h, `
    + `lookback ${WINDOW_CFG.lookbackSeconds}s, avvio a freddo ${WINDOW_CFG.coldStartMinutes}min, `
    + `finestre per run ${MAX_WINDOWS_PER_RUN || 'fino a adesso'}, `
    + `soglia troncamento ${ROWS_SUSPECT}, timeout ${READ_TIMEOUT_MS}ms, tentativi ${MAX_ATTEMPTS}, `
    + `prenotazione orfana ${STALE_MINUTES}min, quarantena ${QUARANTINE_DAYS}gg, `
    + `eco TECO ${SKIP_TECO_ECHO ? 'saltato' : 'incluso'}`);

  if (!activePlants.size) {
    summary.noScope({ active: 0, usable: 0 });
    return { failed: 0 };
  }

  const scope = await complete.resolveCompleteScope(db, activePlants);
  for (const plant of scope.unconfigured) {
    // FAIL-CLOSED e DICHIARATO: nessuna riga di customizing = non si fa niente per quel plant.
    // Non e' un'anomalia, e' un'informazione (DEC-39), quindi `degrade: false`.
    summary.scope({
      plant,
      objectKey: 'CONFIG',
      objectType: OBJECT_TYPE,
      status: 'S',
      degrade: false,
      segments: [logMsg.seg('logCompletePlantUnconfigured')]
    });
  }
  if (!scope.configured.length) {
    summary.note([logMsg.seg('logCompleteNoPlants')]);
    return { failed: 0 };
  }

  // Le righe con la casella accesa e nessuno stato dichiarato: rilevano ma NON scrivono, e il caso
  // si dichiara — altrimenti una casella accesa che non scrive e' indistinguibile da un flusso rotto.
  for (const plant of scope.configured) {
    if (scope.byPlant.get(plant).enabledButNoStatuses) {
      summary.scope({
        plant,
        objectKey: 'CONFIG',
        objectType: OBJECT_TYPE,
        status: 'W',
        segments: [logMsg.seg('logCompleteEnabledNoStatuses')]
      });
    }
  }

  const stats = {};
  const failedRef = { n: 0 };

  // Il dizionario dei lotti, UNA lettura per run, indicizzato in memoria per UUID e per numero.
  const mapping = await db.run(
    SELECT.from(E_MAPPING).columns(
      'ManufacturingOrder', 'PlexJobNumber', 'PlexJobId', 'Plant', 'SplitState', 'SplitSequence'
    )
  );
  const index = complete.indexMapping(mapping);
  console.log(`>>> [ORDER-COMPLETE] dizionario dei lotti: ${(mapping || []).length} righe, `
    + `${index.byId.size} per UUID`);

  // [ORDER-COMPLETE] L'ECO DEL TECO, e dal 03/09/2026 e' una premessa PIU' DEBOLE di prima. La
  // chiusura di `PROD_TECO` passa ora dalla DS 23101, che porta il lotto Plex allo stato `TECO` e non
  // a `Completed`: se la grafia e' quella, questa lettura — che chiede a Plex i job in
  // `FLOW_COMPLETE.defaultStatuses`, cioe' `['Completed']` — non li vede piu', e l'eco non esiste.
  //
  // LA RETE RESTA COMUNQUE, e non e' pigrizia: gli stati sono CONFIGURABILI PER PLANT, quindi un
  // plant che dichiarasse `TECO` fra i suoi la farebbe rivivere. Togliere una difesa perche' si
  // presume che il caso non si presenti piu' e' una decisione a se', non l'effetto collaterale di un
  // cambio di Data Source (addendum del 03/09/2026 a DEC-70). La provenienza si PERSISTE e si conta
  // a parte, e la leva PLEX_COMPLETE_SKIP_TECO_ECHO governa il solo effetto.
  const tecoOrders = new Set();
  try {
    const rows = await db.run(
      SELECT.from(E_TECO_STATE).columns('ManufacturingOrder').where({ State: 'A' })
    );
    for (const r of rows || []) {
      const o = s(r.ManufacturingOrder);
      if (o) tecoOrders.add(o);
    }
  } catch (e) {
    // Non si ferma il run: senza questo insieme si manda comunque, che e' il comportamento voluto.
    console.warn(`>>> [ORDER-COMPLETE] eco TECO non leggibile (si procede): ${e.message}`);
  }

  const ctx = { db, summary, now, index, stats, queryGuard: new Set() };

  // ---- connessioni Plex, memoizzate per il run ---------------------------------------------
  const connections = new Map();
  const connFor = async (plant) => {
    const key = String(plant || '');
    if (!connections.has(key)) {
      try {
        connections.set(key, { creds: await resolvePlexConnection(key, { db }), error: null });
      } catch (e) {
        if (!(e instanceof PlexConnectionMissing)) throw e;
        connections.set(key, { creds: null, error: e });
        console.error(`>>> [PLEX-CONN] plant ${key}: nessuna connessione configurata`);
        summary.scope({
          plant: key,
          objectKey: 'PLEX_CONN',
          objectType: OBJECT_TYPE,
          segments: [logMsg.seg('logCompletePlantNoConnection')]
        });
      }
    }
    return connections.get(key);
  };

  // ============================== PASSO A — la finestra ====================================
  for (const plant of scope.configured) {
    const cfg = scope.byPlant.get(plant);
    const conn = await connFor(plant);
    if (!conn.creds) {
      complete.addWindowOutcome(stats, plant, { readOk: false });
      continue;
    }
    try {
      const giro = await catchUpPlant(ctx, plant, cfg, conn.creds);
      // L'arretrato si dichiara UNA volta, sul residuo vero alla fine del giro. Con il giro che
      // arriva a `now` e' zero a ogni run, quindi un numero diverso da zero e' un'anomalia e
      // DEGRADA il recap (vedi `broken` in srv/lib/orderStatusFlow.js).
      const residual = residualMinutes(giro.resumeAt, now);
      complete.addWindowOutcome(stats, plant, {
        backlogMinutes: residual,
        windowCapReached: giro.stoppedBy === 'cap'
      });
      console.log(`>>> [ORDER-COMPLETE] plant ${plant}: giro chiuso — ${giro.windows} `
        + `finestre, punto di ripresa ${giro.resumeAt || '(invariato)'}, arretrato residuo `
        + `${residual} min (${STOP_REASON[giro.stoppedBy] || giro.stoppedBy})`);
      if (giro.stoppedBy === 'stuck' || giro.stoppedBy === 'noResume') {
        // Non e' un guasto di Plex ne' un dato mancante: e' l'aritmetica della finestra che non fa
        // quello che dichiara, e va vista da una persona invece di diventare un run infinito.
        console.error(`>>> [ORDER-COMPLETE] plant ${plant}: giro interrotto dalla guardia `
          + `(${giro.stoppedBy}): punto di ripresa ${giro.resumeAt || 'assente'}`);
        summary.scope({
          plant,
          objectKey: `READ/${SOURCE_CODE}`,
          objectType: OBJECT_TYPE,
          status: 'E',
          segments: [
            logMsg.seg('logCompleteIngestFailed'),
            logMsg.technical(`giro delle finestre interrotto dalla guardia (${giro.stoppedBy}): `
              + `punto di ripresa ${giro.resumeAt || 'assente'} dopo ${giro.windows} finestre`)
          ]
        });
      }
    } catch (e) {
      // Rete di sicurezza: un plant che esplode non porta via gli altri.
      // [RUN-BLOCKED] `'E'`: qui si arriva solo per un'eccezione inattesa — la lettura, che e'
      // l'unica cosa che ci si aspetta possa cadere, ha gia' il suo ramo sopra. Un plant il cui
      // ingest esplode non ha rilevato NIENTE, ed e' esattamente il caso in cui un run verde
      // mentirebbe (DEC-124).
      complete.addWindowOutcome(stats, plant, { readOk: false });
      console.error(`>>> [ORDER-COMPLETE] plant ${plant}: ingest fallito: ${e.message}`);
      summary.scope({
        plant,
        objectKey: `READ/${SOURCE_CODE}`,
        objectType: OBJECT_TYPE,
        status: 'E',
        segments: [logMsg.seg('logCompleteIngestFailed'), logMsg.technical(e.message)]
      });
    }
  }

  // ============================== PASSO B — l'invio ========================================
  // GUIDATO DAL DATABASE e non dalla finestra, e CONDIVISO col job gemello `ORDER_SCHEDULED`: la
  // ripresa dall'arretrato, la prenotazione condizionale, la POST, la transizione di stato e lo
  // storico dell'ordine sono identici nei due flussi e vivono in srv/lib/orderStatusSend.js.
  // L'unica cosa che li distingue e' il `callKey` del descrittore, cioe' QUALE stato utente si
  // scrive: tenerne due copie qui e in `scheduleSapOrdersFromPlex.js` sarebbe il difetto che questo
  // repo ha gia' pagato con la paginazione (0035/0040) e con l'auto-assegnazione.
  const sendCtx = {
    db, summary, now, index, stats, scope,
    flow: complete.FLOW,
    rules: complete,
    limits: {
      maxAttempts: MAX_ATTEMPTS,
      maxPerRun: MAX_PER_RUN,
      staleMinutes: STALE_MINUTES,
      quarantineDays: QUARANTINE_DAYS,
      staleDays: STALE_DAYS
    },
    permanentMessages: PERMANENT_MESSAGES,
    objectType: OBJECT_TYPE,
    // [ORDER-COMPLETE] L'ECO DEL TECO, che e' di questo flusso e non del gemello: la chiusura di
    // `PROD_TECO` porta il lotto Plex a uno stato di chiusura, quindi quei completamenti li abbiamo
    // causati NOI. Dal 03/09/2026 quello stato e' `TECO` e non `Completed`, percio' l'eco potrebbe
    // non arrivare piu' a questa lettura: la rete resta perche' gli stati sono configurabili per
    // plant. Nessuna nostra scrittura rende invece un job `Scheduled`.
    skipOrders: SKIP_TECO_ECHO ? tecoOrders : null,
    queryGuard: ctx.queryGuard
  };
  const { sent, deferred, failed } = await send.sendPending(sendCtx);
  failedRef.n = failed;
  // ---- le note e il recap ------------------------------------------------------------------
  for (const plant of ctx.queryGuard) {
    summary.scope({
      plant,
      objectKey: 'IFLOW_GUARD',
      objectType: OBJECT_TYPE,
      status: 'W',
      segments: [logMsg.seg('logCompleteQueryGuard')]
    });
  }
  if (deferred) {
    summary.note([logMsg.seg('logCompleteDeferred', deferred, MAX_PER_RUN)]);
  }
  for (const entry of complete.completeRecapEntries(stats)) {
    summary.scope({
      plant: entry.plant,
      objectKey: 'COMPLETE_RECAP',
      objectType: OBJECT_TYPE,
      status: entry.status,
      degrade: entry.degrade,
      segments: entry.segments
    });
  }
  // ULTIMA nota: `ZJobRunHDR.Message` e' String(255) e il troncamento scarta la CODA, quindi la
  // configurazione va dopo gli esiti — la prima stesura della 0023 aveva l'ordine inverso e la nota
  // usciva tagliata a metà parola.
  summary.note([logMsg.seg(
    'logCompleteRunConfig',
    WINDOW_CFG.windowMaxHours, MAX_ATTEMPTS, QUARANTINE_DAYS
  )]);

  console.log(`>>> [JOB CompleteSapOrdersFromPlex] fine: ${sent} inviati, ${failedRef.n} falliti`);
  return { failed: failedRef.n };
}

module.exports = {
  run, ingestPlant, readWindow, windowPath,
  // Ri-esportate da srv/lib/orderStatusSend.js: i test che le usano non devono sapere dove sono
  // finite, e il giorno in cui si spostassero di nuovo cambia una riga sola.
  saveState: send.saveState,
  claimRow: send.claimRow,
  newTrace: send.newTrace,
  sendOne: send.sendOne
};

// Bootstrap condiviso (srv/jobs/lib/runJob.js): modello, riepilogo, recap garantito e exit code.
if (require.main === module) {
  const { runJob } = require('./lib/runJob');
  // serveAll non serve: questo job non invoca action di servizi locali, scrive solo sul db e su SAP.
  runJob({ jobCode: JOB_CODE, serveAll: false, main: (summary) => run(summary) });
}

/**
 * Passo 8 del flusso ordini — richiesta di ordinamento della lista di lavoro Plex (feature 0014).
 *
 * Tre responsabilita', e nessun'altra:
 *   1. risolvere la configurazione di ordinamento di un plant, con cache module-scoped + TTL
 *      sul modello di activePlantsCache (cat-service.js:44-86);
 *   2. eseguire la chiamata sul canale Data Source e interpretarne l'esito (le regole sono nel
 *      modulo puro srv/lib/plexJobSortRules.js);
 *   3. appendere lo step alla sequenza tracciata dell'ordine, nella forma canonica degli altri
 *      step ({ step, request, status, response }, createPlexProductionOrders.js:390 e :464).
 *
 * NON LANCIA MAI (P3): ogni esito e' un valore di ritorno. Dentro un'action esiste un request
 * context e un req.error rollerebbe indietro anche le righe di log (DEC-11, FR-33).
 */

'use strict';

const cds = require('@sap/cds');
const { SELECT } = cds.ql;

const R = require('./plexJobSortRules');
const { executeDataSourceOutputs } = require('../jobs/lib/plexJobsClient');

// Identificativo del servizio: default 239905, sovrascrivibile dall'ambiente (FR-11, D4).
// Dalla feature 0020 vive nell'elenco unico degli id delle Data Source; qui viene RI-ESPORTATO
// perche' createPlexProductionOrders.js lo legge da questo modulo per la riga di log che dichiara
// l'id in uso a inizio esecuzione.
const { DS_JOB_SORT_ORDER } = require('./plexDataSources');
/** Forma del corpo (D-01): 'nested' (contratto Rockwell) | 'flat' (forma delle 5 DS in esercizio). */
const BODY_SHAPE = (process.env.PLEX_JOB_SORT_BODY_SHAPE || 'nested').toLowerCase() === 'flat' ? 'flat' : 'nested';
/** TTL della cache di configurazione. L'invalidazione esplicita e' il meccanismo, il TTL la rete. */
const CONFIG_TTL_MS = Number(process.env.PLEX_JOB_SORT_CONFIG_TTL_MS || 60000);

const E_SORT_CONFIG = 'avvaleplm.marsplm.sap2plex.ZPlexJobSortConfig';

/** Etichetta dello step, identica nei tre punti in cui viene appeso. */
const STEP_LABEL = '8 Job Sort Order';

// Cache module-scoped: condivisa da tutte le istanze di servizio del processo, come
// activePlantsCache. Chiave = plant.
const configCache = new Map();   // plant -> { at: <ms>, value: <config> }

/** Configurazione inerte: e' l'effetto di riga assente, riga spenta e lettura fallita. */
function inertConfig(plant, extra = {}) {
  return { exists: false, enabled: false, dueDateSort: false, frozenJobStatusList: '', plant, ...extra };
}

/**
 * Configurazione di ordinamento di un plant.
 * @param {object} db connessione CDS al db (cds.connect.to('db'))
 * @param {string} plant
 * @param {{ force?: boolean }} [opts] `force: true` ignora la cache (non usato a runtime: serve
 *   ai test e a un'eventuale diagnostica)
 * @returns {Promise<{ exists: boolean, enabled: boolean, dueDateSort: boolean,
 *                     frozenJobStatusList: string, plant: string }>}
 *   Riga assente => `{ exists:false, enabled:false, … }`: e' lo stesso effetto di riga presente e
 *   spenta (FR-24), ma i due stati restano distinti perche' la schermata li distingue (M-12).
 *   Una lettura FALLITA restituisce `enabled:false` e logga: fail-closed. Non si emette una
 *   richiesta verso Plex sulla base di una configurazione che non si e' potuta leggere (TD-10).
 */
async function resolveSortConfig(db, plant, opts = {}) {
  const key = String(plant === null || plant === undefined ? '' : plant);
  if (!key) return inertConfig(key);

  const hit = configCache.get(key);
  if (!opts.force && hit && (Date.now() - hit.at) < CONFIG_TTL_MS) return hit.value;

  let value;
  try {
    const row = await db.run(SELECT.one.from(E_SORT_CONFIG).where({ Plant: key }));
    value = row
      ? {
        exists: true,
        enabled: !!row.IsEnabled,
        dueDateSort: !!row.DueDateSort,
        frozenJobStatusList: row.FrozenJobStatusList || '',
        plant: key
      }
      : inertConfig(key);
  } catch (e) {
    // FAIL-CLOSED: non si emette una richiesta verso Plex sulla base di una configurazione che
    // non si e' potuta leggere. L'effetto e' lo stesso di un plant non abilitato (riga A), e la
    // causa resta nel log.
    console.error(`>>> [JOB SORT] lettura configurazione del plant ${key} fallita: ${e.message}`);
    value = inertConfig(key, { readError: e.message });
  }
  configCache.set(key, { at: Date.now(), value });
  console.log(`>>> [JOB SORT] plant ${key}: ordinamento ${value.enabled ? 'ABILITATO' : 'non abilitato'}`
    + `${value.enabled ? ` (dueDateSort=${value.dueDateSort}, stati congelati='${value.frozenJobStatusList}')` : ''}`);
  return value;
}

/**
 * Svuota la cache. Chiamata dall'handler after(['CREATE','UPDATE','DELETE']) su
 * ZPlexJobSortConfig e dalla cascata di deletePlant (§6.3).
 * @param {string} [plant] se assente svuota tutto (usato da deletePlant e dai test)
 */
function invalidateJobSortConfigCache(plant) {
  const key = plant === null || plant === undefined ? '' : String(plant);
  if (key) {
    configCache.delete(key);
    console.log(`>>> [JOB SORT] cache di configurazione invalidata per il plant ${key}`);
  } else {
    configCache.clear();
    console.log('>>> [JOB SORT] cache di configurazione invalidata (tutti i plant)');
  }
}

/**
 * Esegue il passo 8 e appende il suo step. Non lancia mai.
 * @param {object} args
 * @param {object} args.creds connessione risolta da resolvePlexConnection (srv/lib/plexConnection.js)
 * @param {string} args.plant plant dell'ordine: decide QUALE configurazione si applica
 * @param {object} [args.config] configurazione GIA' risolta dal chiamante. Il job la pre-risolve
 *   una volta per esecuzione (§2.6 dell'FDD: tutte le richieste di un'esecuzione devono essere
 *   spiegabili con una sola configurazione, anche se l'esecuzione dura piu' del TTL)
 * @param {object} [args.db] usata SOLO se `config` e' assente (percorso dell'azione manuale)
 * @param {Array<object>} args.steps sequenza tracciata dell'ordine: lo step viene APPESO qui
 * @param {number} [args.timeoutMs] 0 = nessun tetto (job pianificato); 30000 nell'azione
 *   manuale (D-04)
 * @returns {Promise<{ state: 'NOT_CONFIGURED'|'OK'|'KO', reason?: string,
 *                     code?: number|string|null, message?: string }>}
 *   `NOT_CONFIGURED` => NESSUNO step appeso e nessuna richiesta emessa (FR-24, FR-31).
 */
async function runJobSortStep(args) {
  const { creds, plant, config, db, steps, timeoutMs = 0 } = args || {};
  try {
    // ---- 1. configurazione ------------------------------------------------------
    const cfg = config || (db ? await resolveSortConfig(db, plant) : null);
    if (!cfg || !cfg.enabled) {
      // Riga A: nessuna richiesta, NESSUNO step, nessuna traccia. L'assenza E' l'informazione
      // (FR-24, FR-31).
      return { state: 'NOT_CONFIGURED' };
    }

    // ---- 2. credenziali del canale Data Source (FR-12, riga K) -------------------
    const base = creds && creds.dataSourceUrl;
    const user = creds && creds.dataSourceUser;
    // La PASSWORD non entra nella condizione (feature 0020). Una password vuota e' un valore
    // legittimo per un account di servizio, e lo dicono gia' lo schema (DataSourcePassword e'
    // l'unico dei cinque campi senza `not null`), requireDataSourceCreds in plexJobsClient.js e
    // plexConnRules.js. Finche' entrava qui, sullo stesso plant le cinque Data Source
    // dell'allineamento partivano e il passo 8 no, senza che niente spiegasse la differenza.
    if (!base || !user) {
      const out = {
        state: 'KO', reason: R.SORT_REASON.NO_CREDENTIALS, code: null,
        message: R.sortReasonText({ state: 'KO', reason: R.SORT_REASON.NO_CREDENTIALS })
      };
      // Step SENZA richiesta: il motivo resta leggibile, ma non si finge una chiamata.
      pushStep(steps, { step: STEP_LABEL, request: null, status: 0, response: out.message, aux: true });
      console.warn(`>>> [JOB SORT] ordinamento NON applicato (${out.reason}): ${out.message}`);
      return out;
    }

    // ---- 3. costruzione della richiesta (puro) ----------------------------------
    const inputs = R.buildSortInputs({
      dueDateSort: cfg.dueDateSort,
      frozenJobStatusList: cfg.frozenJobStatusList
    });

    // ---- 4. chiamata ------------------------------------------------------------
    const res = await executeDataSourceOutputs(creds, DS_JOB_SORT_ORDER, inputs,
      { timeoutMs, bodyShape: BODY_SHAPE });

    // ---- 5. interpretazione (puro) ----------------------------------------------
    const out = R.interpretSortResponse(res);

    // ---- 6. traccia -------------------------------------------------------------
    pushStep(steps, {
      step: STEP_LABEL,
      // Solo parametri applicativi: nessuna credenziale, nessun host (DEC-10).
      request: { dataSourceId: DS_JOB_SORT_ORDER, inputs },
      status: res.status,                     // 0 quando nessuna risposta e' arrivata
      response: out.response,                 // troncata a RESPONSE_MAX_CHARS
      aux: true                               // TD-5: NON e' lo stato del passo di invio del job
    });

    if (out.state === 'OK') console.log(`>>> [JOB SORT] ordinamento richiesto: ${out.message}`);
    else console.warn(`>>> [JOB SORT] ordinamento NON applicato (${out.reason}): ${out.message}`);
    return out;
  } catch (err) {
    // P3: non lancia mai. Un errore interno e' un esito, non un'eccezione che risalirebbe fino a
    // far fallire l'invio del job — cioe' esattamente cio' che FR-20 vieta.
    const out = { state: 'KO', reason: R.SORT_REASON.UNEXPECTED, code: null, message: err.message };
    pushStep(steps, {
      step: STEP_LABEL, request: null, status: 0,
      response: `errore interno: ${err.message}`, aux: true
    });
    console.error(`>>> [JOB SORT] errore interno nel passo 8: ${err.message}`);
    return out;
  }
}

/** Append best-effort: la traccia non puo' compromettere l'esito (P3). */
function pushStep(steps, step) {
  try {
    if (Array.isArray(steps)) steps.push(step);
  } catch (e) {
    console.error(`>>> [JOB SORT] step non tracciato: ${e.message}`);
  }
}

module.exports = {
  resolveSortConfig, invalidateJobSortConfigCache, runJobSortStep,
  DS_JOB_SORT_ORDER, BODY_SHAPE, CONFIG_TTL_MS
};

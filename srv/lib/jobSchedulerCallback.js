/**
 * [JOB-TRIGGER] La callback verso il Job Scheduling Service di BTP (feature 0032).
 *
 * >>> Perimetro completo: grep -rn "JOB-TRIGGER" <<<
 *
 * A COSA SERVE. Un job avviato da un endpoint risponde `202 Accepted` e da quel momento lo
 * scheduler NON SA PIU' NIENTE. L'unico modo di dirgli com'e' andata e' la Update Job Run Log:
 *
 *     PUT <host>/scheduler/jobs/{jobId}/schedules/{scheduleId}/runs/{runId}
 *     { "success": true|false, "message": "..." }
 *
 * Se questa PUT non arriva, il run resta `ACK_NOT_RECVD` e dopo un intervallo diventa `UNKNOWN`:
 * il dashboard mostra un run eternamente «in corso» per un job finito da ore. E' il guasto piu'
 * fastidioso da diagnosticare, perche' non e' un errore — e' un'assenza.
 *
 * UNA SOLA PUT PER RUN, con tutto dentro: e' quello che chiedono le best practice del servizio, e
 * il messaggio lo costruisce jobTriggerRules.runOutcome dai contatori della testata.
 *
 * TRE COSE CHE QUESTO MODULO FA E CHE UN PRIMO GIRO NON FA.
 *
 *   1. RITENTA. Una PUT persa per un errore di rete lascia il run appeso per sempre: non c'e'
 *      nessuno che la rimandi, perche' il processo che sapeva com'era andata e' finito. Tre
 *      tentativi con attesa crescente, e si ritenta solo su cio' che ha senso ritentare — un `404`
 *      vuol dire che quel run non esiste piu' e ripetere la chiamata non lo fara' apparire.
 *
 *   2. TIENE IL TOKEN. Non per prestazioni: perche' un token e' valido a lungo e chiederne uno
 *      nuovo a ogni tentativo trasformerebbe un guasto UAA in un fallimento di tutti e tre.
 *
 *   3. RICONOSCE LE DUE FORME DEL BINDING. `clientsecret` (Basic auth su `uaa.url`) e `x509`
 *      (mTLS su `uaa.certurl`) — e SAP raccomanda la seconda. Trattarne una sola darebbe un canale
 *      che funziona in collaudo e tace il giorno del binding «giusto». La forma la classifica
 *      jobTriggerRules.credentialShape, che su una forma ignota ELENCA LE CHIAVI TROVATE senza mai
 *      stampare un valore (DEC-93).
 *
 * `fetch` per il ramo binding-secret, come le chiamate a Plex; `https` nativo per il ramo x509,
 * perche' `fetch` non espone certificato e chiave.
 */

'use strict';

const https = require('node:https');
const { credentialShape } = require('./jobTriggerRules');

const TAG = '[JOB-TRIGGER]';

/** Attese fra i tentativi della PUT. Tre tentativi = due attese. */
const RETRY_BACKOFF_MS = [2000, 6000];
const TOKEN_TIMEOUT_MS = 20000;
const PUT_TIMEOUT_MS = 20000;
/** Margine sulla scadenza del token: non si usa un token che sta per morire. */
const TOKEN_SKEW_MS = 60000;

let tokenCache = null; // { token, expiresAt, clientId }

// ---------------------------------------------------------------------------------------------
// il binding
// ---------------------------------------------------------------------------------------------

/**
 * Il binding del Job Scheduling Service, da VCAP_SERVICES.
 *
 * L'etichetta del servizio e' `jobscheduler`; `job-scheduler` e' accettato per prudenza perche'
 * compare in alcuni esempi. Se non c'e' NIENTE, chi chiama lo dichiara e non lancia: un binding
 * assente e' la situazione normale in sviluppo, dove nessuno scheduler chiama.
 */
function readBinding(env = process.env) {
  let vcap;
  try {
    vcap = JSON.parse(env.VCAP_SERVICES || '{}');
  } catch (e) {
    return { ok: false, message: `VCAP_SERVICES non e' JSON valido: ${e.message}` };
  }
  const list = vcap.jobscheduler || vcap['job-scheduler'] || [];
  const binding = Array.isArray(list) ? list[0] : null;
  if (!binding) {
    const labels = Object.keys(vcap);
    return {
      ok: false,
      message: 'Nessun binding `jobscheduler` in VCAP_SERVICES: la callback verso lo scheduler non '
        + `puo' partire. Servizi presenti: ${labels.length ? labels.join(', ') : '(nessuno)'}.`
    };
  }
  return { ok: true, credentials: binding.credentials || {}, name: binding.name };
}

// ---------------------------------------------------------------------------------------------
// il token
// ---------------------------------------------------------------------------------------------

function postFormWithMtls(url, body, { cert, key }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      cert,
      key,
      timeout: TOKEN_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json'
      }
    }, (res) => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout dopo ${TOKEN_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postFormWithSecret(url, body, { clientId, clientSecret }) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  });
  return { status: res.status, text: await res.text() };
}

/**
 * Un token `client_credentials` per le API dello scheduler.
 *
 * La forma documentata e' `POST /oauth/token` con corpo form-encoded — non una `GET` con i
 * parametri in query string: quella funziona su XSUAA, ma non e' quella dichiarata e non c'e'
 * ragione di dipendere da un comportamento non promesso.
 */
async function getToken(credentials) {
  const shape = credentialShape(credentials);
  if (shape.kind === 'unknown') throw new Error(shape.message);

  const now = Date.now();
  if (tokenCache && tokenCache.clientId === shape.clientId && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const uaa = credentials.uaa;
  let out;
  if (shape.kind === 'x509') {
    out = await postFormWithMtls(
      shape.tokenUrl,
      `grant_type=client_credentials&client_id=${encodeURIComponent(shape.clientId)}`,
      { cert: uaa.certificate, key: uaa.key }
    );
  } else {
    out = await postFormWithSecret(
      shape.tokenUrl,
      'grant_type=client_credentials',
      { clientId: shape.clientId, clientSecret: uaa.clientsecret }
    );
  }

  if (out.status < 200 || out.status >= 300) {
    // Il corpo di UAA non contiene segreti e dice quale delle due cose e' sbagliata (client
    // inesistente vs credenziale errata): si riporta, tagliato.
    throw new Error(`UAA ${out.status} su ${shape.tokenUrl} (${shape.kind}): ${String(out.text).slice(0, 300)}`);
  }
  let token;
  let expiresIn = 0;
  try {
    const parsed = JSON.parse(out.text);
    token = parsed.access_token;
    expiresIn = Number(parsed.expires_in) || 0;
  } catch (e) {
    throw new Error(`Risposta UAA non interpretabile: ${e.message}`);
  }
  if (!token) throw new Error('Risposta UAA senza `access_token`.');

  const ttl = expiresIn > 0 ? expiresIn * 1000 : 600000;
  tokenCache = { token, clientId: shape.clientId, expiresAt: now + Math.max(ttl - TOKEN_SKEW_MS, 30000) };
  return token;
}

/** Solo per i collaudi: dimentica il token tenuto in memoria. */
function resetTokenCache() {
  tokenCache = null;
}

// ---------------------------------------------------------------------------------------------
// la PUT
// ---------------------------------------------------------------------------------------------

/**
 * Vale la pena ritentare questo stato?
 *
 * Un `404` dice che quel run non esiste (o non esiste piu'): ripetere la PUT non lo fara'
 * comparire. Un `401`/`403` e' un problema di autorizzazione che non si risolve in sei secondi —
 * ma il token si butta, perche' la causa possibile e' proprio un token stantio. Tutto il resto
 * (rete, `5xx`, `429`) si ritenta.
 */
function isRetryableStatus(status) {
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Dichiara allo scheduler l'esito di un run.
 *
 * NON LANCIA. Il chiamante e' un `on('exit')` di un processo figlio: un'eccezione la' diventerebbe
 * un `unhandledRejection`, e in CAP con `shutdown_on_uncaught_errors` un errore di sistema puo'
 * spegnere il server. L'esito torna come valore e viene messo nel log.
 *
 * @param {object} p
 * @param {string} p.url      indirizzo completo, da jobTriggerRules.callbackUrl
 * @param {boolean} p.success
 * @param {string} p.message
 * @param {object} [p.credentials] credenziali del binding; assenti = si leggono da VCAP_SERVICES
 * @returns {Promise<{ok:boolean, status?:number, attempts:number, error?:string}>}
 */
async function updateRunLog({ url, success, message, credentials }) {
  let creds = credentials;
  if (!creds) {
    const binding = readBinding();
    if (!binding.ok) return { ok: false, attempts: 0, error: binding.message };
    creds = binding.credentials;
  }

  const body = JSON.stringify({ success: !!success, message: String(message ?? '') });
  const attempts = RETRY_BACKOFF_MS.length + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const token = await getToken(creds);
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body,
        signal: AbortSignal.timeout(PUT_TIMEOUT_MS)
      });
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, status: res.status, attempts: attempt };
      }
      const text = (await res.text().catch(() => '')).slice(0, 300);
      lastError = `HTTP ${res.status} ${text}`;
      // Un rifiuto di autorizzazione puo' venire da un token stantio: si butta e si riprova UNA
      // volta col prossimo giro, invece di ripetere tre volte lo stesso token rifiutato.
      if (res.status === 401 || res.status === 403) resetTokenCache();
      if (!isRetryableStatus(res.status) && res.status !== 401 && res.status !== 403) {
        return { ok: false, status: res.status, attempts: attempt, error: lastError };
      }
    } catch (e) {
      lastError = e.message || String(e);
    }
    if (attempt < attempts) {
      console.warn(`${TAG} callback allo scheduler fallita (tentativo ${attempt}/${attempts}): ${lastError}`);
      await sleep(RETRY_BACKOFF_MS[attempt - 1]);
    }
  }
  return { ok: false, attempts, error: lastError };
}

module.exports = {
  RETRY_BACKOFF_MS,
  readBinding,
  getToken,
  resetTokenCache,
  isRetryableStatus,
  updateRunLog
};

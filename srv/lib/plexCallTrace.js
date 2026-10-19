/**
 * [SPLIT-TRACE] Tracciato delle chiamate verso Plex: RICHIESTA E RISPOSTA, in `cf logs` e nella
 * console del BROWSER.
 *
 * PERCHE' ESISTE
 * `plexConnect` (srv/jobs/lib/plexJobsClient.js:75-85) stampa l'URL di ogni chiamata e, SOLO sul
 * ramo d'errore, lo stato con il corpo. Non stampa mai il corpo INVIATO e non stampa nulla della
 * risposta quando la chiamata riesce. Le `request`/`response` complete esistono, ma solo per lo
 * spacchettamento ESEGUITO: le raccoglie `run.rec` (srv/lib/plexJobSplit.js:377) e finiscono nella
 * riga di storico, non nella risposta dell'action (DEC-10, C-3). L'APERTURA della finestra non
 * scrive nessun passo, quindi di quella lettura non restava traccia interrogabile: il sintomo di
 * un `GET /scheduling/v1/jobs?jobNumber=…` che rispondeva 500 arrivava a schermo come
 * «Detail: HTTP 500», senza il corpo dell'errore che Plex ha effettivamente mandato.
 *
 * DOVE SI LEGGE
 *   - `cf logs marsplm-sap2plex-srv --recent | grep -aE "SPLIT-TRACE|PLEX-CALL"` — due righe per
 *     chiamata: una all'invio (con il corpo, dove c'e') e una alla risposta (stato, durata, corpo).
 *     L'etichetta dice di quale flusso e' la chiamata: `SPLIT-TRACE` lo spacchettamento (default,
 *     ed e' il perimetro grep della 0012), `PLEX-CALL` il passo 5 della creazione job.
 *   - console del browser, `window.plexCalls()` — ogni chiamata diventa una voce dell'anello di
 *     srv/lib/isCallLog.js con `area: 'plex'`, e il cockpit la stampa PER INTERO (indirizzo, corpo
 *     inviato, stato, corpo ricevuto) subito dopo l'operazione che l'ha fatta partire: vedi
 *     `dumpPlex` in app/marsplm-sap2plex/webapp/util/IsCallLog.js. E' la ragione per cui questo
 *     modulo non ha una sua struttura dati: l'anello e la function OData che lo serve esistono
 *     gia' e non cambiano.
 *
 * NESSUNA CHIAMATA IN PIU'. Avvolge la tripla `{get, post, put}` che il chiamante gia' usa e
 * registra la chiamata VERA. Un errore nel tracciato non puo' rompere la chiamata: si perde la
 * voce, non la richiesta.
 *
 * LE CREDENZIALI NON PASSANO DA QUI. Il wrapper vede `path` e `body`; `creds` e gli header
 * (`X-Plex-Connect-Api-Key`) restano dentro `plexConnect`. Non c'e' niente da mascherare.
 *
 * Spegnimento: PLEX_CALL_TRACE=off (l'anello ha il suo, IS_CALL_LOG=off).
 * RIMOZIONE: grep -rn "SPLIT-TRACE".
 */

'use strict';

const isCallLog = require('./isCallLog');

const OFF = String(process.env.PLEX_CALL_TRACE || '').trim().toLowerCase() === 'off';

/** Forma delle voci d'esercizio. Le sonde ne usano un'altra: `sonda <id>`, esclusa dal dump. */
const FORM = 'chiamata Plex';

/**
 * Etichetta del tracciato in `cf logs`. E' `SPLIT-TRACE` per default perche' lo spacchettamento e'
 * stato il primo consumatore e `grep -rn "SPLIT-TRACE"` e' il perimetro dichiarato della 0012:
 * cambiarne il default significherebbe rendere quel grep incompleto. Chi traccia chiamate di un
 * altro flusso passa il suo — `PLEX-CALL` per il passo 5 della creazione job — cosi' l'etichetta
 * dice di quale flusso e' la chiamata invece di mentire.
 */
const TAG = 'SPLIT-TRACE';

/** Tetti allineati a quelli dichiarati dalla function `isCallLog` in srv/cat-service.cds. */
const LIM = {
  request: isCallLog.LIMITS.notes,
  response: isCallLog.LIMITS.rawBody
};

/** UUID di Plex dentro il path: non sono un'entity, e in etichetta rendono ogni voce diversa. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Etichetta e criteri di una path Plex. FUNZIONE PURA.
 *   `/scheduling/v1/jobs?jobNumber=1`              -> { entity: 'jobs', criteria: 'jobNumber=1' }
 *   `/scheduling/v1/jobs/<uuid>/backwards-schedule` -> { entity: 'jobs/backwards-schedule' }
 * I primi due segmenti (area e versione) e gli UUID cadono: quello che resta e' cio' che
 * distingue una chiamata dall'altra nell'elenco della console.
 */
function describe(path) {
  const s = String(path || '');
  const q = s.indexOf('?');
  const route = q >= 0 ? s.slice(0, q) : s;
  const criteria = q >= 0 ? s.slice(q + 1) : '';
  const parts = route.split('/').filter(Boolean).slice(2).filter((p) => !UUID_RE.test(p));
  return { entity: parts.join('/') || route || '?', criteria };
}

/**
 * Testo di una risposta Plex NON riuscita: lo stato PIU' il corpo che Plex ha mandato.
 * FUNZIONE PURA.
 *
 * `plexConnect` restituisce `body` anche sul ramo d'errore
 * (srv/jobs/lib/plexJobsClient.js:85), quindi quel corpo c'era e lo si buttava via: il dettaglio
 * che arrivava a schermo era il solo `HTTP 500`, indistinguibile fra un rifiuto applicativo di
 * Plex e un guasto qualunque — ed è il motivo per cui la striscia rossa della finestra di
 * spacchettamento non diceva niente di utilizzabile.
 *
 * Ripiego sullo stato quando il corpo non è nella forma dichiarata dal contratto
 * (`code` + `metadata.internalMessage`): un corpo di forma inattesa non deve far perdere anche
 * lo stato. Sta qui, e non in plexJobSplit.js, perché lo usano il flusso e la sonda, e perché
 * questo modulo non dipende da `cds`: il suo test gira con `node test/…`.
 */
function plexErrText(r, what = '') {
  const head = `${what ? `${what} ` : ''}HTTP ${(r && r.status) || 0}`;
  const b = r && r.body;
  if (!b) return head;
  if (typeof b === 'string') return `${head} — ${b.slice(0, 200)}`;
  const code = b.code || (b.error && b.error.code) || '';
  const inner = (b.metadata && b.metadata.internalMessage) || b.message || '';
  const tail = [code, inner].filter(Boolean).join(': ');
  return tail ? `${head} — ${String(tail).slice(0, 200)}` : head;
}

/** Quante righe ha portato la risposta: una collection, un oggetto solo, o niente. */
function rowsOf(body) {
  if (Array.isArray(body)) return body.length;
  return body === undefined || body === null || body === '' ? 0 : 1;
}

async function traced(ctx, plex, method, path, body) {
  const n = (ctx.seq += 1);
  const label = `${ctx.order ? `ordine ${ctx.order} ` : ''}#${n} ${method} ${path}`;
  const sent = body === undefined || body === null ? '' : isCallLog.cut(body, LIM.request);
  const tag = ctx.tag || TAG;
  try {
    console.log(`>>> [${tag}] ${label}${sent ? ` | invio: ${sent}` : ''}`);
  } catch (e) { /* la traccia non rompe la chiamata */ }

  const t0 = Date.now();
  let r = null;
  let thrown = null;
  try {
    if (method === 'GET') r = await plex.get(path);
    else if (method === 'POST') r = await plex.post(path, body);
    else r = await plex.put(path, body);
  } catch (e) {
    thrown = e;
  }
  const ms = Date.now() - t0;

  try {
    const status = thrown ? 0 : Number(r && r.status) || 0;
    const ok = !thrown && !!(r && r.ok);
    const received = thrown ? '' : isCallLog.cut(r && r.body, LIM.response);
    const url = (r && r.url) || `${ctx.root || ''}${path}`;
    const { entity, criteria } = describe(path);
    const line = `>>> [${tag}] ${label} -> `
      + `${thrown ? `ECCEZIONE ${thrown.message}` : `HTTP ${status}`} in ${ms} ms`
      + `${received ? ` | ricevo: ${received}` : ''}`;
    if (ok) console.log(line); else console.error(line);

    isCallLog.push({
      area: 'plex',
      entity,
      op: method,
      derivedOp: method,
      mode: 'PLEX',
      // [IS-CHANNEL] Plex non passa da una destination BTP (HTTPS diretta, 0020): lasciare il campo
      // vuoto lo farebbe leggere «non dichiarata», cioe' come un difetto invece di un fatto.
      destination: '(HTTPS diretta: Plex)',
      root: ctx.root || '',
      form: ctx.form,
      calls: 1,
      rows: rowsOf(r && r.body),
      ms,
      outcome: ok ? 'OK' : 'KO',
      criteria,
      columns: '(nessuno: API REST)',
      request: `${method} ${url}`,
      notes: sent ? [`corpo inviato: ${sent}`] : [],
      // Lo stato PIU' il corpo, non il solo stato: e' la riga che si incolla in un ticket, e su un
      // `500 Data is Null` `code` + `internalMessage` sono l'unica informazione utile. Il corpo
      // intero resta in `rawBody`; qui sta la sua sintesi, gia' tagliata da `plexErrText`.
      error: thrown ? `ECCEZIONE ${thrown.message}` : (ok ? '' : plexErrText(r)),
      upstreamStatus: status,
      responseBody: received,
      firstRow: thrown ? '' : isCallLog.sample(r && r.body),
      // `rawSeen` true perche' il corpo lo leggiamo noi, non un tap che puo' non agganciare:
      // qui «non misurato» esiste solo se la chiamata ha lanciato prima di ricevere.
      rec: {
        urls: [`${method} ${url}`],
        urlCount: 1,
        headers: '',
        httpStatus: status,
        rawBody: received,
        rawSeen: !thrown,
        responseContentType: '',
        rawHasD: false
      }
    });
  } catch (e) {
    // Si perde la voce, non la chiamata: identica regola di isCallLog.push.
    if (!traced._warned) {
      traced._warned = true;
      console.warn(`>>> [${tag}] voce non registrata (${e.message}): la chiamata prosegue`);
    }
  }

  if (thrown) throw thrown;
  return r;
}

/**
 * Avvolge la tripla `{get, post, put}` restituendone una equivalente. A tracciato spento
 * restituisce la stessa tripla: il chiamante non ramifica.
 *
 * @param {{get:Function, post:Function, put:Function}} plex la tripla da avvolgere
 * @param {object}  o
 * @param {string}  o.order  ordine di produzione, per correlare le righe nel log
 * @param {string}  o.root   base URL del tenant Plex (`creds.baseUrl`): serve a comporre l'URL
 *                           assoluto quando la risposta non lo rimanda
 * @param {string}  o.form   `chiamata Plex` d'esercizio; `sonda <id>` per una sonda, che il dump
 *                           generico di window.isCalls() esclude di proposito
 * @param {string}  o.tag    etichetta del tracciato in `cf logs`: `SPLIT-TRACE` per default (vedi
 *                           TAG), `PLEX-CALL` per le chiamate della creazione job
 */
function wrap(plex, { order = '', root = '', form = FORM, tag = TAG } = {}) {
  if (OFF || !plex) return plex;
  const ctx = { order, root, form, tag, seq: 0 };
  return {
    get: (path) => traced(ctx, plex, 'GET', path),
    post: (path, body) => traced(ctx, plex, 'POST', path, body),
    put: (path, body) => traced(ctx, plex, 'PUT', path, body)
  };
}

module.exports = { wrap, describe, rowsOf, plexErrText, OFF, FORM, TAG };

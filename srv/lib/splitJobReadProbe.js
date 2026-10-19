/**
 * [SPLIT-TRACE] Sonda: DOVE si rompe la lettura di un job su Plex.
 *
 * IL CASO E' CHIUSO, E LA CAUSA ERA NOSTRA. Questa sonda nacque perché
 * `GET /scheduling/v1/jobs?jobNumber=<ordine>` rispondeva `500 REQUEST_PROCESSING_ERROR / "Data is
 * Null…"` su job che sul portale Plex si vedevano sani, e per una settimana quel `500` è stato
 * istruito come la terza faccia del difetto Plex sul backwards-schedule e sul `PUT` — il corpo
 * d'errore era identico. **Non lo era**: gli altri due erano di Plex e sono stati corretti il
 * 27/08/2026, questo no. Chiedevamo per NUMERO un job di cui avevamo già l'identificativo, e il
 * rimedio è `srv/lib/plexJobRead.js` (id-first, DEC-80). Le rettifiche verso Rockwell sono nei due
 * dossier, §2 e §7.
 *
 * La sonda resta qui, in sola lettura e senza chiamanti automatici: è lo strumento che isola DOVE
 * cede una lettura di job, e quella domanda è utile a prescindere dal caso che l'ha originata. Il
 * testo che segue racconta quel caso e va letto al passato.
 *
 * PERCHE' ESISTE
 * L'apertura della finestra di spacchettamento cadeva sulla lettura del lotto principale — la sola
 * lettura per numero del perimetro 0012, `findJobByExactNumber` — e per segnalare un `500` su una
 * GET bisognava isolarlo: cede il FILTRO per numero, la LISTA, o la riga del job?
 *
 * COSA FA
 * Quattro letture della stessa Job Scheduling API, tutte in SOLA LETTURA, sulle chiavi che il
 * progetto ha già in `ZProdOrderPlexMapping` (nessuna chiave inventata, nessuna scoperta per
 * tentativi):
 *
 *   BY-NUMBER   GET /scheduling/v1/jobs?jobNumber=<ordine>          la lettura d'esercizio
 *   BY-ID       GET /scheduling/v1/jobs/<PlexJobId>                 `get-job`: stessa forma di riga,
 *                                                                   nessun filtro e nessuna lista
 *   BY-PART     GET /scheduling/v1/jobs?partId=<PlexPartId>         lista con un ALTRO filtro
 *   BY-EXTCODE  GET /scheduling/v1/jobs?externalJobCode=<codice>    filtro alternativo per lo stesso job
 *
 * I quattro indirizzi sono quelli del contratto versionato
 * (srv/external/PLEX_JOB_API_CONTRACT.md): `partId`, `externalJobCode` e `jobNumber` sono
 * parametri dichiarati di `list-jobs`, e `get-job` restituisce la stessa forma di riga.
 *
 * NON E' AGGANCIATA A NESSUNA SCHERMATA, nemmeno sul ramo d'errore dell'apertura finestra: si
 * lancia dalla console del cockpit (`window.splitJobProbe('<ordine>')`) o aprendo la function in
 * una tab. E' la regola di DEC-72, e qui non c'è motivo di derogarvi: quattro letture in più a
 * ogni apertura di finestra sarebbero un costo permanente per una domanda che si pone una volta.
 *
 * NON SBLOCCAVA LO SPACCHETTAMENTO. Anche P3b cerca i codici dei pacchetti con la stessa
 * `GET ?jobNumber=`, e finché quel filtro rispondeva 500 lo split si sarebbe fermato un passo più
 * avanti. La sonda serviva a isolare quale richiesta fosse rotta; la risposta è stata che a essere
 * sbagliata era la NOSTRA — un job che esiste si chiede per id (DEC-80) — e per P3b il numero va
 * bene, perché là si cerca un codice LIBERO, cioè un'assenza.
 *
 * Spegnimento: SPLIT_JOB_PROBE=off. RIMOZIONE: grep -rn "SPLIT-TRACE".
 */

'use strict';

// Nessuna dipendenza da `cds` in questo modulo: il verdetto si collauda con
// `node test/splitJobReadProbe.test.js`, senza runtime CAP e senza rete.
const { plexErrText } = require('./plexCallTrace');
const { isExactJobNumber } = require('./splitRules');

const OFF = String(process.env.SPLIT_JOB_PROBE || '').trim().toLowerCase() === 'off';

/** Forma delle voci nell'anello: `sonda <id>` è esclusa dal dump d'esercizio di window.isCalls(). */
const PROBE_FORM = 'sonda split-job';

const MAX_BODY = 2000;
const MAX_ROWS_JSON = 20000;

function cut(v, n) {
  const s = v === undefined || v === null ? '' : (typeof v === 'string' ? v : safeJson(v));
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function asArray(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && typeof body === 'object') return [body];
  return [];
}

/** Riga vuota: tutti i campi dichiarati dalla function, così la tabella in console è regolare. */
function row(id, what, extra = {}) {
  return {
    id,
    what,
    request: '',
    httpStatus: 0,
    ok: false,
    rows: 0,
    exactMatch: false,
    jobNumbers: '',
    error: '',
    responseBody: '',
    firstRow: '',
    rowsJson: '',
    ms: 0,
    ...extra
  };
}

/**
 * Una lettura. Non lancia mai: un'eccezione è un esito della sonda, non un suo guasto.
 * `deps.plex` è già la tripla TRACCIATA (srv/lib/plexCallTrace.js), quindi la richiesta e la
 * risposta di ogni prova finiscono anche in `cf logs` e nell'anello.
 */
async function attempt(deps, { id, what, path, order }) {
  const t0 = Date.now();
  try {
    const r = await deps.plex.get(path);
    const rows = asArray(r.body);
    const numbers = rows
      .map((j) => (j && j.jobNumber !== undefined && j.jobNumber !== null ? String(j.jobNumber).trim() : ''))
      .filter(Boolean);
    return row(id, what, {
      request: `GET ${path}`,
      httpStatus: r.status,
      ok: !!r.ok,
      rows: rows.length,
      exactMatch: !!(order && numbers.some((n) => isExactJobNumber(n, order))),
      jobNumbers: cut(numbers.slice(0, 20).join(', '), 200),
      error: r.ok ? '' : plexErrText(r),
      responseBody: r.ok ? '' : cut(r.body, MAX_BODY),
      firstRow: cut(rows[0], 500),
      rowsJson: r.ok ? cut(rows.slice(0, 5), MAX_ROWS_JSON) : '',
      ms: Date.now() - t0
    });
  } catch (e) {
    return row(id, what, {
      request: `GET ${path}`,
      error: `ECCEZIONE ${e.message}`,
      ms: Date.now() - t0
    });
  }
}

/**
 * Il verdetto, cioè l'unica riga da leggere per prima. Le tre conclusioni sono mutuamente
 * esclusive e vanno insieme all'esito delle altre prove: un `get-job` riuscito assolve la RIGA,
 * una lista riuscita con un altro filtro assolve la LISTA, e quel che resta è il filtro.
 * FUNZIONE PURA: si collauda senza rete.
 */
function verdict({ byNumber, byId, byPart, byExtCode }) {
  /** L'altro filtro, quando c'è: una seconda lettura utilizzabile va detta, non lasciata dedurre. */
  const altre = (r) => {
    if (!r || !r.request) return '';
    if (r.ok && r.exactMatch) return 'Il filtro `externalJobCode` trova lo stesso job: seconda lettura alternativa disponibile.';
    if (r.ok) return `Il filtro \`externalJobCode\` risponde ma non trova il job (${r.rows} righe).`;
    return `Anche il filtro \`externalJobCode\` fallisce (${r.error || `HTTP ${r.httpStatus}`}).`;
  };
  const lines = [];
  if (byNumber && byNumber.ok) {
    if (byNumber.exactMatch) {
      lines.push('ESITO la lettura d\'esercizio FUNZIONA: il lotto principale è stato trovato per numero.');
      lines.push('Se la finestra è comunque in errore, la causa non è questa lettura: guarda la riga '
        + '[SPLIT-TRACE] getProdOrderSplitInfo in `cf logs`, che dichiara quale ramo ha risposto.');
      lines.push('MOSSA nessuna: rilancia la sonda quando l\'errore si ripresenta.');
      return lines.join('\n');
    }
    lines.push('ESITO la lettura per numero risponde, ma NESSUNA riga porta il numero esatto cercato.');
    lines.push(`Righe restituite: ${byNumber.rows}${byNumber.jobNumbers ? ` (${byNumber.jobNumbers})` : ''}. `
      + 'Per Plex quel lotto non esiste: è il caso M-03, non un guasto di lettura.');
    lines.push('MOSSA verifica il numero del job su Plex: il match è ESATTO di proposito (FR-19).');
    return lines.join('\n');
  }

  const err = (byNumber && byNumber.error) || 'nessun dettaglio';
  if (byId && byId.ok) {
    if (byPart && byPart.ok) {
      lines.push('ESITO cede il FILTRO `jobNumber`, non il job e non la lista.');
      lines.push(`La lettura d'esercizio fallisce (${err}), ma il job letto per id risponde `
        + `HTTP ${byId.httpStatus} e la lista filtrata per \`partId\` risponde HTTP ${byPart.httpStatus} `
        + `con ${byPart.rows} righe${byPart.exactMatch ? ', fra cui il job cercato' : ''}.`);
      lines.push(altre(byExtCode));
      lines.push('MOSSA segnala a Rockwell la sola `GET /scheduling/v1/jobs?jobNumber=`, allegando '
        + 'il corpo dell\'errore qui sotto. Se serve un aggancio provvisorio, la lettura per '
        + '`partId` con filtro a valle sul numero è l\'unica alternativa che copre anche P3b — '
        + '`externalJobCode` no: i codici dei pacchetti non ne hanno uno prima di essere creati.');
      return lines.filter(Boolean).join('\n');
    }
    lines.push('ESITO cede la LISTA, non il job.');
    lines.push(`La lettura d'esercizio fallisce (${err}) e la lista per \`partId\` fallisce anch'essa`
      + `${byPart ? ` (${byPart.error || `HTTP ${byPart.httpStatus}`})` : ' (non eseguibile: manca PlexPartId)'}, `
      + `mentre il job letto per id risponde HTTP ${byId.httpStatus}: la riga di questo job è `
      + 'servibile, quindi ciò che non è serializzabile sta in un\'altra riga della lista o nella '
      + 'lista stessa.');
    lines.push(altre(byExtCode));
    lines.push('MOSSA segnala le due letture di lista, dichiarando che `get-job` sullo stesso job '
      + 'riesce: è l\'informazione che circoscrive il difetto in casa loro.');
    return lines.filter(Boolean).join('\n');
  }

  if (byId) {
    lines.push('ESITO il difetto è nella riga di QUESTO job, non nel filtro.');
    lines.push(`Sia la lettura per numero (${err}) sia \`get-job\` per id `
      + `(${byId.error || `HTTP ${byId.httpStatus}`}) falliscono: nessuna delle due forme riesce a `
      + 'servire il job, quindi il campo nullo è su di lui.');
    lines.push('MOSSA gira a Rockwell l\'id del job con i due errori: sanno quale campo il loro '
      + 'serializzatore sta leggendo.');
    return lines.join('\n');
  }

  lines.push('ESITO la lettura per numero fallisce e non ci sono prove alternative eseguibili.');
  lines.push(`Errore: ${err}. Manca il \`PlexJobId\` sulla riga di mapping, quindi né \`get-job\` né `
    + 'la lista per part sono state tentate.');
  lines.push('MOSSA verifica ZProdOrderPlexMapping per quest\'ordine: senza id il lotto principale '
    + 'non è indirizzabile in nessun altro modo.');
  return lines.join('\n');
}

/**
 * @param {object} deps      le stesse dipendenze dello spacchettamento (`prepareSplit`)
 * @param {object} o
 * @param {string} o.order   numero d'ordine SAP
 * @param {object} o.mapping riga di ZProdOrderPlexMapping del LOTTO PRINCIPALE
 */
async function runSplitJobReadProbe(deps, { order, mapping }) {
  if (OFF) {
    return [row('OFF', 'Sonda spenta da SPLIT_JOB_PROBE=off: nessuna lettura eseguita.')];
  }

  const map = mapping || {};
  const known = row('MAPPING', `Chiavi note del lotto principale dell'ordine ${order}`, {
    ok: !!map.PlexJobId,
    jobNumbers: cut(map.PlexJobNumber || '', 200),
    firstRow: cut({
      PlexJobNumber: map.PlexJobNumber || '',
      PlexJobId: map.PlexJobId || '',
      PlexPartId: map.PlexPartId || '',
      ExternalJobCode: map.ExternalJobCode || '',
      SplitState: map.SplitState || '',
      Quantity: map.Quantity === undefined ? null : map.Quantity
    }, 500),
    error: map.PlexJobId ? '' : 'nessun PlexJobId in mapping: le prove per id e per part non sono eseguibili'
  });

  const out = [known];

  const byNumber = await attempt(deps, {
    id: 'BY-NUMBER',
    what: 'La lettura d\'esercizio: lista filtrata per numero di job (findJobByExactNumber, A6/P3b/R0)',
    path: `/scheduling/v1/jobs?jobNumber=${encodeURIComponent(order)}`,
    order
  });
  out.push(byNumber);

  let byId = null;
  let byPart = null;
  let byExtCode = null;

  if (map.PlexJobId) {
    byId = await attempt(deps, {
      id: 'BY-ID',
      what: 'Il solo job, per id (`get-job`): stessa forma di riga, nessun filtro e nessuna lista',
      path: `/scheduling/v1/jobs/${encodeURIComponent(map.PlexJobId)}`,
      order
    });
    out.push(byId);
  } else {
    out.push(row('BY-ID', 'Non eseguita: manca PlexJobId in ZProdOrderPlexMapping'));
  }

  if (map.PlexPartId) {
    byPart = await attempt(deps, {
      id: 'BY-PART',
      what: 'Lista con un ALTRO filtro: tutti i job della part. Isola il filtro dalla lista',
      path: `/scheduling/v1/jobs?partId=${encodeURIComponent(map.PlexPartId)}`,
      order
    });
    out.push(byPart);
  } else {
    out.push(row('BY-PART', 'Non eseguita: manca PlexPartId in ZProdOrderPlexMapping'));
  }

  if (map.ExternalJobCode) {
    byExtCode = await attempt(deps, {
      id: 'BY-EXTCODE',
      what: 'Lista filtrata per externalJobCode: lo stesso job, per un\'altra sua chiave',
      path: `/scheduling/v1/jobs?externalJobCode=${encodeURIComponent(map.ExternalJobCode)}`,
      order
    });
    out.push(byExtCode);
  } else {
    out.push(row('BY-EXTCODE', 'Non eseguita: nessun ExternalJobCode sulla riga di mapping'));
  }

  out.unshift(row('VERDETTO', verdict({ byNumber, byId, byPart, byExtCode }), {
    ok: !!(byNumber && byNumber.ok),
    httpStatus: (byNumber && byNumber.httpStatus) || 0
  }));

  const ko = out.filter((r) => r.id !== 'VERDETTO' && r.id !== 'MAPPING' && !r.ok && r.request).length;
  console.log(`>>> [SPLIT-TRACE] splitJobReadProbe ordine ${order}: ${out.length - 1} righe, ${ko} KO`);
  console.log(`>>> [SPLIT-TRACE] verdetto: ${out[0].what}`);

  return out;
}

module.exports = { runSplitJobReadProbe, verdict, asArray, PROBE_FORM, OFF };

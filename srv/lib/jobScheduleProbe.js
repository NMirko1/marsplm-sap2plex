/**
 * ============================================================================
 * [JOB-SCHED-PROBE] SONDA DI DIAGNOSI — QUALE CAMPO E' NULLO NEL BACKWARDS-SCHEDULE
 * ============================================================================
 *
 * IL CASO E' CHIUSO — 27/08/2026. Il `500` che ha fatto nascere questa sonda era un difetto di Plex:
 * Rockwell l'ha corretto e la correzione e' stata VERIFICATA sul tenant. La sonda ha fatto il suo
 * lavoro — ha dimostrato che NESSUNA delle sei precondizioni era la causa, ed e' cio' che ha permesso
 * di girare il caso come difetto loro invece di continuare a cercare dalla parte sbagliata. Resta
 * qui, in sola lettura e senza chiamanti automatici, come strumento per il prossimo `500` non
 * documentato su questa chiamata. Quel che segue racconta il caso di allora e va letto al passato; i
 * dossier chiusi sono in srv/external/PLEX_ISSUE_*_500.it.md.
 *
 * IL FATTO DA CUI SI PARTIVA
 * Il passo 5 della creazione job — `POST /scheduling/v1/jobs/{id}/backwards-schedule` — rispondeva:
 *
 *   500 REQUEST_PROCESSING_ERROR
 *   metadata.internalMessage: "Data is Null. This method or property cannot be called on Null values."
 *
 * Il path e il body sono quelli giusti, e non e' una supposizione: coincidono con la riga 5 del
 * foglio `Jobs Creation` dell'API List del cliente e con lo schema del portale sviluppatori; i
 * passi 1, 2 e 4 girano sullo STESSO baseUrl e rispondono 200/201; e il 500 arriva
 * nell'involucro d'errore di Plex, non in un errore di rotta. Il contratto documenta per quella
 * operazione soltanto 200 / 400 / 404: un 500 «Data is Null» e' quindi un null NON GESTITO dentro
 * Plex, su un dato che si aspettava di trovare.
 *
 * PERCHE' NON SI PUO' INDOVINARE
 * «Data is Null» e' l'involucro GENERICO di Plex per un null-deref, e su questo stesso tenant e'
 * gia' comparso su una lettura — `GET /scheduling/v1/jobs?jobNumber=` (srv/lib/splitJobReadProbe.js)
 * — dove rate, building e operazioni non c'entrano nulla. Il messaggio dice CHE c'e' un null, non
 * DOVE: va isolato.
 *
 * COSA ISOLA
 * Sei precondizioni che il backwards-schedule legge, ognuna con la sua lettura. La descrizione
 * dell'operazione dice che le date delle operazioni del job sono schedulate a rovescio «based on
 * RATES specified in process routing», e la sua risposta 200 e' un array con `rate`, `setupTime`,
 * `runTime` valorizzati: sono quei campi che devono esistere da qualche parte.
 *
 *   PART-OPS     la part ha operazioni di ciclo?          GET /mdm/v1/part-operations
 *   JOB-OPS      il job ha operazioni?                    DS 4216 -> DS 4701 (i due del passo 6)
 *   APPROVED-WC  hanno un work center approvato?          GET .../approved-workcenters
 *   RATE         quel work center porta un rate?          (stessa lettura, altri campi)
 *   BUILDING     il job ha un building?                   GET /scheduling/v1/jobs
 *   FINESTRA     dueDate e' DOPO earliestStartDateTime?   (stessa lettura, altri campi)
 *
 * Le due ultime non costano una chiamata in piu': sono campi della stessa riga di job.
 *
 * COSA NON FA
 * Non scrive niente: ne' su Plex, ne' su ZProdOrderExcLogHDR/POS, ne' su ZProdOrderPlexMapping —
 * una diagnosi che sporcasse lo storico dell'ordine falserebbe il delta del job, dove un 'S'/'W'
 * conta come inviato. L'unica eccezione e' la prova RETRY-FALSE, che SCHEDULA il job e per questo
 * e' spenta per default (`JOB_SCHED_PROBE_RETRY=on` per accenderla): e' la regola della W1-20 —
 * una sonda che scrive e' spenta da una leva.
 * Non lancia mai: una sonda che fallisce deve mostrare il perche', non produrre un 500.
 * Non parte da sola: si lancia dalla console del cockpit (`window.jobSchedProbe('<ordine>')`),
 * come tutte le altre (DEC-72). Quattro letture in piu' a ogni apertura di schermata sarebbero un
 * costo permanente per una domanda che si pone una volta per materiale.
 * Non scegle il bersaglio dal browser: l'unico ingresso e' il NUMERO D'ORDINE, e materiale, plant
 * e connessione Plex li deriva dalla testata SAP — le stesse tre cose che `processOrder` deriva.
 *
 * SPEGNIMENTO: `JOB_SCHED_PROBE=off` + restart, senza rilascio.
 * RIMOZIONE:   grep -rn "JOB-SCHED-PROBE" (questo file, srv/cat-service.cds, srv/cat-service.js,
 *              app/marsplm-sap2plex/webapp/util/Probes.js, test/jobScheduleProbe.test.js).
 */

'use strict';

// Nessuna dipendenza da `cds` in questo modulo: il verdetto si collauda con
// `node test/jobScheduleProbe.test.js`, senza runtime CAP e senza rete.
const { plexErrText } = require('./plexCallTrace');
// [JOB-READ] Il path della lettura per id: lo stesso che usano lo spacchettamento e il passo 2 del
// job, cosi' la sonda interroga l'indirizzo d'esercizio e non una sua imitazione.
const plexJobRead = require('./plexJobRead');
// [PART-QUERY] Gli indirizzi del Parts API in un punto solo. La sonda deve chiedere come chiede il
// flusso d'esercizio, o misura un'altra cosa. Test: node test/plexPartQuery.test.js
const plexPartsApi = require('./plexPartsApi');

const OFF = String(process.env.JOB_SCHED_PROBE || '').trim().toLowerCase() === 'off';
/** La sola prova che SCRIVE (schedula il job): accesa solo da una leva esplicita (W1-20). */
const RETRY_ON = String(process.env.JOB_SCHED_PROBE_RETRY || '').trim().toLowerCase() === 'on';

/** Forma delle voci nell'anello: `sonda <id>` e' esclusa dal dump d'esercizio di window.isCalls(). */
const PROBE_FORM = 'sonda job-schedule';

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
  if (body && Array.isArray(body.rows)) return body.rows;
  if (body && typeof body === 'object') return [body];
  return [];
}

/** Riga vuota: tutti i campi dichiarati dalla function, cosi' la tabella in console e' regolare. */
function row(id, what, extra = {}) {
  return {
    id,
    what,
    request: '',
    httpStatus: 0,
    ok: false,
    rows: 0,
    findings: '',
    error: '',
    responseBody: '',
    firstRow: '',
    rowsJson: '',
    ms: 0,
    ...extra
  };
}

// ================================================================
// Le regole: FUNZIONI PURE, collaudate senza rete
// ================================================================

/** «1 operazione» / «2 operazioni»: il verdetto lo legge una persona. */
function q(count, singolare, plurale) {
  return `${count} ${count === 1 ? singolare : plurale}`;
}

/** Un numero utilizzabile come rate: presente, finito e maggiore di zero. */
function isRate(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

/**
 * I campi di rate di una riga `ApprovedWorkcenter` che il contratto dichiara
 * (srv/external/PLEX_APPROVED_WC_API_CONTRACT.md). `setupTime` NON e' fra questi: un tempo di
 * setup a zero e' legittimo, un rate a zero no — con rate zero non esiste una durata.
 */
const RATE_FIELDS = ['standardProductionRate', 'idealRate', 'targetRate', 'sequenceRate'];

/** I rate presenti su una riga, per nome: dice QUALE campo e' valorizzato, non solo se lo e'. */
function ratesOf(wc) {
  if (!wc || typeof wc !== 'object') return [];
  return RATE_FIELDS.filter((f) => isRate(wc[f]));
}

/**
 * Le due date del job come Plex le ha memorizzate: la finestra dentro cui lo scheduler deve
 * collocare le operazioni. Ampiezza <= 0 significa «finisci prima di iniziare».
 *
 * Il caso visto in esercizio e' l'uguaglianza: l'ordine SAP porta inizio e fine pianificati sullo
 * stesso giorno e il progetto li manda entrambi a mezzanotte, quindi l'ampiezza e' esattamente
 * zero. E' la stessa classe di difetto della DEC-58 («fine a mezzanotte, cioe' prima
 * dell'inizio»), vista dall'altro lato.
 */
function windowOf(job) {
  const due = job && job.dueDate ? Date.parse(job.dueDate) : NaN;
  const start = job && job.earliestStartDateTime ? Date.parse(job.earliestStartDateTime) : NaN;
  if (!Number.isFinite(due) || !Number.isFinite(start)) return null;
  return { due, start, ms: due - start };
}

/**
 * Le sei precondizioni, ognuna in uno di tre stati. FUNZIONE PURA.
 *
 * PERCHE' TRE STATI E NON DUE. `VUOTO` e `IGNOTO` non sono la stessa cosa e confonderli e' il
 * modo tipico di sbagliare una diagnosi: una lettura FALLITA non dimostra che il dato non c'e' —
 * dimostra che non lo sappiamo. Solo un `VUOTO` e' un candidato al null; un `IGNOTO` e' una
 * lettura da rifare.
 *
 * PERCHE' TUTTE E SEI E NON LA PRIMA. Piu' di una precondizione puo' essere vuota
 * contemporaneamente — una part senza ciclo non ha nemmeno work center approvati, ne' rate — e
 * fermarsi alla prima nasconderebbe il lavoro che resta da fare dopo averla sistemata.
 */
function assess({ part, partOps, approvedWc, job, jobOps, retryFalse } = {}) {
  const checks = [];
  const add = (id, label, state, detail) => checks.push({ id, label, state, detail });

  // --- 1. la part ha operazioni di ciclo -------------------------------------
  if (!part || !part.ok) {
    add('PART-OPS', 'La part ha operazioni di ciclo', 'IGNOTO',
      'la part non e\' stata letta: senza il suo id non si leggono le operazioni');
  } else if (!partOps || !partOps.ok) {
    add('PART-OPS', 'La part ha operazioni di ciclo', 'IGNOTO',
      `lettura non riuscita (${(partOps && partOps.error) || 'non eseguita'})`);
  } else if (partOps.rows === 0) {
    add('PART-OPS', 'La part ha operazioni di ciclo', 'VUOTO',
      'nessuna operazione su Plex: il ciclo del materiale non e\' mai stato trasferito, o il '
      + 'trasferimento e\' stato un no-op (era il caso fino alla DEC-76)');
  } else {
    add('PART-OPS', 'La part ha operazioni di ciclo', 'OK', q(partOps.rows, 'operazione', 'operazioni'));
  }

  // --- 2. il job ha operazioni ----------------------------------------------
  if (!jobOps || !jobOps.ok) {
    add('JOB-OPS', 'Il job ha operazioni', 'IGNOTO',
      `lettura non riuscita (${(jobOps && jobOps.error) || 'non eseguita'})`);
  } else if (jobOps.rows === 0) {
    add('JOB-OPS', 'Il job ha operazioni', 'VUOTO',
      'il job esiste ma non ha nessuna operazione: Plex le deriva dal ciclo della part al momento '
      + 'del POST, quindi un job creato PRIMA del ciclo non le ha e non le prende dopo');
  } else {
    add('JOB-OPS', 'Il job ha operazioni', 'OK', q(jobOps.rows, 'operazione', 'operazioni'));
  }

  // --- 3. le operazioni hanno un work center approvato ----------------------
  const wcRows = (approvedWc && approvedWc.ok && Array.isArray(approvedWc.list)) ? approvedWc.list : null;
  if (!wcRows) {
    add('APPROVED-WC', 'Le operazioni hanno un work center approvato', 'IGNOTO',
      `lettura non riuscita (${(approvedWc && approvedWc.error) || 'non eseguita'})`);
  } else if (wcRows.length === 0) {
    add('APPROVED-WC', 'Le operazioni hanno un work center approvato', 'VUOTO',
      'nessun work center approvato sulla part: mandiamo sempre useFirstApprovedWorkcenter=true, '
      + 'e quel ramo non ha nulla da leggere');
  } else {
    add('APPROVED-WC', 'Le operazioni hanno un work center approvato', 'OK',
      q(wcRows.length, 'riga approvata', 'righe approvate'));
  }

  // --- 4. almeno un work center approvato porta un rate ---------------------
  if (!wcRows) {
    add('RATE', 'I work center approvati portano un rate', 'IGNOTO',
      'i work center approvati non sono stati letti');
  } else if (wcRows.length === 0) {
    add('RATE', 'I work center approvati portano un rate', 'IGNOTO',
      'non ci sono work center approvati su cui cercare un rate');
  } else {
    const withRate = wcRows.filter((w) => ratesOf(w).length > 0);
    if (withRate.length === 0) {
      add('RATE', 'I work center approvati portano un rate', 'VUOTO',
        `nessuna ${wcRows.length === 1 ? 'delle righe' : `delle ${wcRows.length} righe`} porta un rate `
        + `(${RATE_FIELDS.join(', ')} tutti nulli o `
        + 'zero). Il progetto non ne scrive nessuno: al POST approved-workcenters manda i soli tre '
        + 'id obbligatori, e il backwards-schedule schedula «based on rates specified in process '
        + 'routing»');
    } else {
      add('RATE', 'I work center approvati portano un rate', 'OK',
        `${withRate.length}/${wcRows.length} con rate`);
    }
  }

  // --- 5. il job ha un building --------------------------------------------
  const jobRow = (job && job.ok && job.found) ? job.found : null;
  if (!jobRow) {
    add('BUILDING', 'Il job ha un building', 'IGNOTO',
      `job non letto (${(job && job.error) || 'nessuna riga con quel numero'})`);
  } else if (!jobRow.buildingId) {
    add('BUILDING', 'Il job ha un building', 'VUOTO',
      'buildingId nullo sul job. Lo scheduler deve scegliere un work center, e un work center vive '
      + 'in un building; il progetto non lo manda (solo il placeholder PLEX_BUILDING_ID). La W1-25 '
      + 'lo aveva dichiarato non verificato con Rockwell');
  } else {
    add('BUILDING', 'Il job ha un building', 'OK',
      `${jobRow.buildingCode || jobRow.buildingId}`);
  }

  // --- 6. la finestra di schedulazione ha ampiezza ---------------------------
  const win = jobRow ? windowOf(jobRow) : null;
  if (!jobRow) {
    add('FINESTRA', 'La finestra di schedulazione ha ampiezza', 'IGNOTO', 'job non letto');
  } else if (!win) {
    add('FINESTRA', 'La finestra di schedulazione ha ampiezza', 'IGNOTO',
      `date non interpretabili (dueDate=${jobRow.dueDate || '(vuota)'}, `
      + `earliestStartDateTime=${jobRow.earliestStartDateTime || '(vuota)'})`);
  } else if (win.ms <= 0) {
    add('FINESTRA', 'La finestra di schedulazione ha ampiezza', 'VUOTO',
      `ampiezza ${win.ms} ms: dueDate=${jobRow.dueDate} e earliestStartDateTime=`
      + `${jobRow.earliestStartDateTime}. Le due date SAP (fine e inizio pianificati) cadono nello `
      + 'stesso istante, quindi non c\'e\' spazio in cui collocare le operazioni');
  } else {
    add('FINESTRA', 'La finestra di schedulazione ha ampiezza', 'OK',
      `${Math.round(win.ms / 3600000)} ore fra inizio e fine`);
  }

  const gaps = checks.filter((c) => c.state === 'VUOTO');
  const unknown = checks.filter((c) => c.state === 'IGNOTO');
  return { checks, gaps, unknown, firstGap: gaps.length ? gaps[0].id : null, retryFalse };
}

/** La mossa da fare, una per precondizione vuota. FUNZIONE PURA. */
const MOVES = {
  'PART-OPS': 'trasferisci il ciclo del materiale su Plex (feature 0008) e RILANCIA la creazione '
    + 'job: le operazioni del job le deriva Plex al momento del POST, quindi il job va ricreato, '
    + 'non solo rischedulato.',
  'JOB-OPS': 'il ciclo della part c\'e\' ma questo job non lo ha ereditato: e\' stato creato prima. '
    + 'Cancella il job su Plex e rilancia la creazione, oppure schedulalo a mano.',
  'APPROVED-WC': 'approva un work center sulle operazioni della part (feature 0008, W1-08). '
    + 'Nell\'attesa non c\'e\' niente da commutare: dal 20/08/2026 mandiamo GIA\' '
    + 'useFirstApprovedWorkcenter=false, che e\' l\'esempio del contratto e l\'annotazione '
    + 'dell\'API List (WC-FALSE).',
  'RATE': 'il rate va messo su Plex, o mandato da noi: standardProductionRate e setupTime sono '
    + 'campi facoltativi del POST approved-workcenters, presenti nella riga 7 del foglio `Part '
    + 'Operation` dell\'API List e oggi non inviati. Prima di mandarli va deciso da quale campo '
    + 'SAP nasce il rate — e va saputo che il tenant puo\' RISCRIVERE standardProductionRate.',
  'BUILDING': 'valorizza il building del job. Oggi c\'e\' solo il placeholder PLEX_BUILDING_ID: il '
    + 'building e\' del PLANT, quindi la sua casa e\' il customizing per plant. Da confermare con '
    + 'Rockwell (W1-25).',
  'FINESTRA': 'non c\'e\' niente da correggere da questo lato se SAP dichiara inizio = fine: '
    + 'l\'ordine va pianificato su piu\' di un istante, oppure la schedulazione la fa l\'operatore '
    + 'su Plex (commento K6 dell\'API List).'
};

/**
 * Il verdetto: l'unica riga da leggere per prima. FUNZIONE PURA.
 * Elenca lo stato delle sei precondizioni e nomina la prima mossa.
 */
function verdict(parts) {
  const a = assess(parts);
  const lines = [];

  if (a.gaps.length === 0 && a.unknown.length === 0) {
    lines.push('ESITO nessuna delle sei precondizioni e\' vuota: il null non e\' in un dato che '
      + 'possiamo vedere da qui.');
    lines.push('MOSSA gira a Rockwell il corpo dell\'errore del passo 5 insieme a queste sei righe: '
      + 'dicono che operazioni, work center, rate, building e finestra ci sono, quindi il campo '
      + 'nullo e\' interno al loro scheduler.');
  } else if (a.gaps.length === 0) {
    lines.push(`ESITO nessuna precondizione dimostrata vuota, ma ${a.unknown.length} su 6 non sono `
      + 'verificabili: le loro letture non sono riuscite.');
    lines.push('MOSSA rifai le letture in ignoto prima di concludere: una lettura fallita NON '
      + 'dimostra che il dato non c\'e\'.');
  } else {
    lines.push(`ESITO ${a.gaps.length} precondizion${a.gaps.length === 1 ? 'e vuota' : 'i vuote'} su 6`
      + `${a.unknown.length ? `, e ${a.unknown.length} non verificabil${a.unknown.length === 1 ? 'e' : 'i'}` : ''}: `
      + a.gaps.map((g) => g.id).join(', ') + '.');
    lines.push(`MOSSA (${a.firstGap}) ${MOVES[a.firstGap] || 'nessuna mossa nota per questa precondizione.'}`);
  }

  for (const c of a.checks) {
    const mark = c.state === 'OK' ? '[OK]     ' : (c.state === 'VUOTO' ? '[VUOTO]  ' : '[IGNOTO] ');
    lines.push(`${mark}${c.id} — ${c.label}: ${c.detail}`);
  }

  // La prova che scrive, quando e' stata eseguita, vale piu' di ogni ipotesi: dice se il rimedio
  // da una riga funziona.
  const rf = a.retryFalse;
  if (rf && rf.request) {
    lines.push(rf.ok
      ? 'RETRY-FALSE con useFirstApprovedWorkcenter=false la schedulazione RIESCE — ed e\' gia\' '
        + 'il valore che il flusso manda: dal 20/08/2026 il default e\' '
        + 'PLEX_USE_FIRST_APPROVED_WC=false (WC-FALSE), quindi non c\'e\' nessuna leva da girare e '
        + 'la creazione job dovrebbe schedulare da sola.'
      : `RETRY-FALSE anche con useFirstApprovedWorkcenter=false la schedulazione fallisce (${rf.error
        || `HTTP ${rf.httpStatus}`}): il null non e' nel ramo del primo work center approvato.`);
  } else {
    lines.push('RETRY-FALSE non eseguita (scrive: si accende con JOB_SCHED_PROBE_RETRY=on). '
      + 'ATTENZIONE: dal 20/08/2026 il flusso manda GIA\' false (WC-FALSE), quindi questa prova '
      + 'non contrasta piu\' col flusso, lo RIPETE. Per discriminare il ramo del primo work '
      + 'center approvato serve ora la prova opposta, con true.');
  }

  return lines.join('\n');
}

// ================================================================
// Le letture
// ================================================================

/** Una lettura Connect. Non lancia mai: un'eccezione e' un esito della sonda, non un suo guasto. */
async function get(deps, { id, what, path }) {
  const t0 = Date.now();
  try {
    const r = await deps.plex.get(path);
    const list = r.ok ? asArray(r.body) : [];
    return row(id, what, {
      request: `GET ${path}`,
      httpStatus: r.status,
      ok: !!r.ok,
      rows: list.length,
      error: r.ok ? '' : plexErrText(r),
      responseBody: r.ok ? '' : cut(r.body, MAX_BODY),
      firstRow: cut(list[0], 500),
      rowsJson: r.ok ? cut(list.slice(0, 20), MAX_ROWS_JSON) : '',
      ms: Date.now() - t0,
      list
    });
  } catch (e) {
    return row(id, what, {
      request: `GET ${path}`,
      error: `ECCEZIONE ${e.message}`,
      ms: Date.now() - t0,
      list: []
    });
  }
}

/** Una Data Source di sola lettura, con la stessa regola: non lancia mai. */
async function ds(deps, { id, what, dataSourceId, inputs }) {
  const t0 = Date.now();
  try {
    const r = await deps.ds(dataSourceId, inputs);
    const list = r.ok ? asArray(r.body) : [];
    return row(id, what, {
      request: `DS ${dataSourceId} ${safeJson(inputs)}`,
      httpStatus: r.status,
      ok: !!r.ok,
      rows: list.length,
      error: r.ok ? '' : `HTTP ${r.status} — ${cut(r.body, 200)}`,
      responseBody: r.ok ? '' : cut(r.body, MAX_BODY),
      firstRow: cut(list[0], 500),
      rowsJson: r.ok ? cut(list.slice(0, 20), MAX_ROWS_JSON) : '',
      ms: Date.now() - t0,
      list
    });
  } catch (e) {
    return row(id, what, {
      request: `DS ${dataSourceId} ${safeJson(inputs)}`,
      error: `ECCEZIONE ${e.message}`,
      ms: Date.now() - t0,
      list: []
    });
  }
}

/**
 * @param {object} deps
 * @param {{ get: Function, post: Function }} deps.plex  tripla TRACCIATA (srv/lib/plexCallTrace.js)
 * @param {Function} deps.ds                             `(dataSourceId, inputs) => {ok,status,body}`
 * @param {object} o
 * @param {string} o.order      numero d'ordine SAP (= numero job su Plex)
 * @param {string} o.material   materiale dell'ordine (= part number su Plex)
 * @param {string} [o.plant]
 * @param {object} [o.dates]    date pianificate lette da SAP, per il contesto
 */
async function runJobScheduleProbe(deps, { order, material, plant, dates, knownJobId } = {}) {
  if (OFF) {
    return [row('OFF', 'Sonda spenta da JOB_SCHED_PROBE=off: nessuna lettura eseguita.')];
  }
  if (!order || !material) {
    return [row('VERDETTO', 'Sonda non eseguita: senza numero d\'ordine e materiale non c\'e\' un '
      + 'bersaglio. Entrambi si derivano dalla testata SAP dell\'ordine.')];
  }

  const out = [];

  // Il contesto e' una riga della tabella, non un console.log: chi legge il verdetto deve vedere
  // nello stesso posto su quale ordine, materiale e plant lo sta leggendo.
  out.push(row('CONTESTO', `Ordine ${order}, materiale ${material}${plant ? `, plant ${plant}` : ''}`, {
    ok: true,
    firstRow: cut({
      ManufacturingOrder: order,
      Material: material,
      ProductionPlant: plant || '',
      MfgOrderPlannedStartDate: (dates && dates.start) || '',
      MfgOrderPlannedEndDate: (dates && dates.end) || ''
    }, 500),
    findings: (dates && dates.start && dates.end && String(dates.start) === String(dates.end))
      ? 'ATTENZIONE inizio e fine pianificati SAP coincidono: la finestra di schedulazione nasce '
        + 'di ampiezza zero già da SAP.'
      : ''
  }));

  // --- PART: l'id della part, da cui dipendono le due letture successive ------
  const part = await get(deps, {
    id: 'PART',
    what: 'La part su Plex: id (serve alle due letture successive) e buildingCode',
    path: plexPartsApi.partByNumberPath(material)
  });
  // [PART-QUERY] Filtro a valle sul numero, come il passo 1 del flusso d'esercizio. Qui c'era
  // scritto «alcuni tenant ignorano il query parameter»: era falso, il parametro era `partNumber`
  // e su questo indirizzo non esiste. Il filtro resta perche' il contratto non dichiara se il
  // confronto di `number` sia esatto o per prefisso (DEC-80).
  const partRow = part.list.find((p) => plexPartsApi.numberOf(p) === material) || null;
  const partId = partRow ? plexPartsApi.idOf(partRow) : '';
  part.ok = part.ok && !!partId;
  part.findings = partId
    ? `partId=${partId}, buildingCode=${partRow.buildingCode || '(nullo)'}`
    : `la part ${material} non e' fra le ${part.rows} righe restituite`;
  part.found = partRow;
  out.push(part);

  // --- PART-OPS --------------------------------------------------------------
  let partOps = null;
  if (partId) {
    partOps = await get(deps, {
      id: 'PART-OPS',
      what: 'Le operazioni di ciclo della part: sono loro che Plex copia sul job al POST del passo 4',
      path: `/mdm/v1/part-operations?partId=${encodeURIComponent(partId)}`
    });
    // `findings` ha un tetto dichiarato dal tipo di ritorno (String(2000)): si taglia qui, dove il
    // testo si compone, e non si spera che le righe siano poche.
    partOps.findings = partOps.ok
      ? cut(partOps.list.map((o) => `${o.operationNumber}:${o.type || '(tipo vuoto)'}`).slice(0, 30).join(' '), MAX_BODY)
      : '';
    out.push(partOps);
  } else {
    out.push(row('PART-OPS', 'Non eseguita: manca il partId'));
  }

  // --- APPROVED-WC (e con essa RATE) ----------------------------------------
  let approvedWc = null;
  if (partId) {
    approvedWc = await get(deps, {
      id: 'APPROVED-WC',
      what: 'I work center approvati della part, CON i loro rate: useFirstApprovedWorkcenter=true '
        + 'legge il primo di questi, e il backwards-schedule schedula sui rate',
      path: `/production/v1/production-definitions/approved-workcenters?partId=${encodeURIComponent(partId)}`
    });
    approvedWc.findings = approvedWc.ok
      ? cut(approvedWc.list.map((w) => {
        const rates = ratesOf(w);
        return `op${w.operationNo}/${w.workcenterCode || '?'}:`
          + (rates.length ? rates.map((f) => `${f}=${w[f]}`).join(',') : 'NESSUN RATE')
          + (isRate(w.setupTime) ? `,setupTime=${w.setupTime}` : '');
      }).slice(0, 30).join(' | '), MAX_BODY)
      : '';
    out.push(approvedWc);
  } else {
    out.push(row('APPROVED-WC', 'Non eseguita: manca il partId'));
  }

  // --- JOB: buildingId e le due date, come Plex le ha memorizzate ------------
  // [JOB-READ] Id-first (DEC-80): con l'UUID che il dizionario ha salvato alla creazione la lettura
  // e' `get-job`, e il filtro per numero resta il ripiego — su questo tenant e' proprio lui a
  // rispondere `500` sui job che ESISTONO, ed e' il punto in cui questa sonda cadeva prima di
  // arrivare alle precondizioni che deve isolare. Le due prove restano DUE righe in tabella: quale
  // delle due ha risposto e' meta' della diagnosi.
  const jobReads = [];
  if (knownJobId) {
    jobReads.push(await get(deps, {
      id: 'JOB-BY-ID',
      what: 'Il job per il suo UUID (`get-job`): buildingId, dueDate ed earliestStartDateTime',
      path: plexJobRead.pathById(knownJobId)
    }));
  }
  if (!jobReads.length || !jobReads[0].ok || !jobReads[0].list.length) {
    jobReads.push(await get(deps, {
      id: 'JOB',
      what: knownJobId
        ? 'Ripiego: lo stesso job cercato per numero, perche\' la lettura per id non ha risposto'
        : 'Il job su Plex: buildingId, dueDate ed earliestStartDateTime come Plex li ha memorizzati',
      path: `/scheduling/v1/jobs?jobNumber=${encodeURIComponent(order)}`
    }));
  }
  // Le prove scartate restano in tabella, prima di quella che ha risposto.
  for (const scartata of jobReads.slice(0, -1)) out.push(scartata);
  const job = jobReads[jobReads.length - 1];
  const jobRow = job.list.find((j) => String(j.jobNumber || '').trim() === order) || null;
  job.found = jobRow;
  job.ok = job.ok && !!jobRow;
  job.findings = jobRow
    ? `id=${jobRow.id} status=${jobRow.jobStatus || '?'} jobType=${jobRow.jobType || '(vuoto)'} `
      + `buildingId=${jobRow.buildingId || 'NULLO'} dueDate=${jobRow.dueDate || '(vuota)'} `
      + `earliestStart=${jobRow.earliestStartDateTime || '(vuota)'}`
    : `nessuna riga col numero ${order} fra le ${job.rows} restituite`;
  out.push(job);

  // --- JOB-OPS: la catena dei due DS del passo 6 -----------------------------
  let jobOps = null;
  const jobKeyRow = await ds(deps, {
    id: 'JOB-KEY',
    what: 'Job_Key dal numero job (DS del passo 6.1): input della lettura delle operazioni',
    dataSourceId: deps.dsJobKey,
    inputs: { Job_No: order }
  });
  const jobKey = jobKeyRow.list[0] && jobKeyRow.list[0].Job_Key;
  jobKeyRow.ok = jobKeyRow.ok && jobKey !== undefined && jobKey !== null;
  jobKeyRow.findings = jobKey ? `Job_Key=${jobKey}` : 'nessun Job_Key: il job non e\' indirizzabile via Data Source';
  out.push(jobKeyRow);

  if (jobKey) {
    jobOps = await ds(deps, {
      id: 'JOB-OPS',
      what: 'Le operazioni DEL JOB (DS del passo 6.2): Plex le deriva dal ciclo della part al POST',
      dataSourceId: deps.dsJobOps,
      inputs: { Job_Key: jobKey }
    });
    jobOps.findings = jobOps.ok
      ? cut(jobOps.list.map((o) => `${o.Op_No}:${o.Operation_Code || '?'}`).slice(0, 30).join(' '), MAX_BODY)
      : '';
    out.push(jobOps);
  } else {
    out.push(row('JOB-OPS', 'Non eseguita: manca il Job_Key'));
  }

  // --- RETRY-FALSE: la sola prova che SCRIVE, spenta per default -------------
  let retryFalse = null;
  const jobId = jobRow && jobRow.id;
  if (!RETRY_ON) {
    out.push(row('RETRY-FALSE',
      'Non eseguita: SCHEDULA il job, quindi si accende con JOB_SCHED_PROBE_RETRY=on (W1-20). '
      + 'E\' la prova che discrimina il ramo del primo work center approvato.'));
  } else if (!jobId) {
    out.push(row('RETRY-FALSE', 'Non eseguita: il job non e\' stato trovato su Plex, nessun id da schedulare'));
  } else {
    const t0 = Date.now();
    const path = `/scheduling/v1/jobs/${jobId}/backwards-schedule`;
    const body = { useFirstApprovedWorkcenter: false };
    try {
      const r = await deps.plex.post(path, body);
      const list = r.ok ? asArray(r.body) : [];
      retryFalse = row('RETRY-FALSE',
        'Lo stesso backwards-schedule con useFirstApprovedWorkcenter=FALSE: schedula su tutti i '
        + 'centri schedulati invece che sul primo approvato', {
          request: `POST ${path} ${safeJson(body)}`,
          httpStatus: r.status,
          ok: !!r.ok,
          rows: list.length,
          error: r.ok ? '' : plexErrText(r),
          responseBody: r.ok ? '' : cut(r.body, MAX_BODY),
          firstRow: cut(list[0], 500),
          rowsJson: r.ok ? cut(list.slice(0, 20), MAX_ROWS_JSON) : '',
          findings: r.ok
            ? `${list.length} operazioni schedulate: IL JOB E' STATO MODIFICATO su Plex`
            : '',
          ms: Date.now() - t0
        });
    } catch (e) {
      retryFalse = row('RETRY-FALSE', 'Prova con useFirstApprovedWorkcenter=false', {
        request: `POST ${path} ${safeJson(body)}`,
        error: `ECCEZIONE ${e.message}`,
        ms: Date.now() - t0
      });
    }
    out.push(retryFalse);
  }

  out.unshift(row('VERDETTO', verdict({ part, partOps, approvedWc, job, jobOps, retryFalse }), {
    ok: !!(job && job.ok),
    httpStatus: (job && job.httpStatus) || 0
  }));

  // `list` e `found` sono di servizio per il verdetto: non sono nel tipo di ritorno della
  // function CDS e vanno tolte, o CAP le scarta con un avviso a ogni riga.
  const clean = out.map(({ list, found, ...r }) => r);

  const ko = clean.filter((r) => r.id !== 'VERDETTO' && r.id !== 'CONTESTO' && !r.ok && r.request).length;
  console.log(`>>> [JOB-SCHED-PROBE] ordine ${order} materiale ${material}: ${clean.length - 1} righe, ${ko} KO`);
  console.log(`>>> [JOB-SCHED-PROBE] verdetto:\n${clean[0].what}`);

  return clean;
}

module.exports = {
  runJobScheduleProbe,
  // esportate per il test: sono le regole, e si collaudano senza rete
  assess,
  verdict,
  ratesOf,
  windowOf,
  isRate,
  RATE_FIELDS,
  MOVES,
  asArray,
  PROBE_FORM,
  OFF,
  RETRY_ON
};

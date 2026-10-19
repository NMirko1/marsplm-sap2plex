/**
 * ============================================================================
 * [PLEX-HISTORY-PROBE] SONDA DI DIAGNOSI — COSA RISPONDONO OGGI LE DUE LETTURE PLEX
 * ============================================================================
 *
 * COSA FA
 * Chiama le DUE letture di storico produzione della Connect API su una finestra di quindici
 * minuti che finisce nell'istante dell'invocazione, e restituisce la risposta CRUDA:
 *
 *   PROD_ENTRY   GET /production/v1/production-history/production-entries   il prodotto buono
 *   SCRAP_ENTRY  GET /production/v1/production-history/scrap-entries        lo scarto
 *
 * PERCHE' ESISTE
 * Quelle due letture vivono in un posto solo — la fase A del job `PROD_CONF`
 * (srv/jobs/postProdOrderConfirmation.js) — e la loro finestra e' guidata dal watermark
 * persistito, quindi dipende da `ZJobReadWatermark` e non da quando la si lancia. Per sapere cosa
 * Plex risponde ADESSO bisognava far girare il job, e il job risponde a una domanda diversa.
 * Le tabelle di log (`ZProdConfPlexEntry`, `ZProdConfMatDoc`) dicono cosa e' stato ACQUISITO, non
 * cosa torna: dopo la 0027 e la 0028 quest'ultima e' la domanda che serve, perche' la costruzione
 * dei documenti materiale si regge su `partOperationId`, `operationNumber`, `jobId` e `partId`, e
 * di quei campi la risposta cruda di questo tenant non era interrogabile da nessuna parte.
 *
 * COSA NON FA, DI PROPOSITO
 * Non scrive niente: ne' su Plex, ne' su `ZProdConfPlexEntry`, ne' su `ZJobReadWatermark`. Il
 * watermark in particolare non si tocca nemmeno in lettura: farlo avanzare da una diagnosi
 * significherebbe dichiarare letta una finestra che il job non ha ancora elaborato, cioe' perdere
 * quelle registrazioni (0021 RB-01, DEC-58).
 * Non chiama `source.map(...)`: si mostra la risposta come arriva, perche' il normalizzatore e'
 * proprio la cosa che si sta verificando. `rowsJson` porta le righe intere.
 * Non legge SAP: nessun ordine, nessun materiale, nessuna testata. Il plant serve solo perche' la
 * connessione Plex e' per plant (0020) e si prende dai plant utilizzabili, non dal browser.
 * Non filtra: `beginDate`/`endDate` e nient'altro, come il flusso d'esercizio — gli altri filtri
 * che il contratto dichiara restano fuori (srv/external/PLEX_PRODUCTION_HISTORY_API_CONTRACT.md,
 * «I parametri che NON mandiamo, di proposito»).
 * Non lancia mai: un'eccezione e' un esito della sonda, non un suo guasto.
 * Non parte da sola: si lancia dalla console del cockpit (`window.plexHistoryProbe()`), come tutte
 * le altre (DEC-72).
 *
 * LA TERZA SORGENTE E' FUORI PERIMETRO. `CONT_ADJ` (rettifiche di giacenza) e' la terza voce di
 * `SOURCES` e non viene letta: non genera documenti (`producesDocuments: false`) e non era fra le
 * due letture chieste. Il giorno in cui servisse, si aggiunge un codice a `PROBE_SOURCE_CODES`.
 *
 * SPEGNIMENTO: `PLEX_HISTORY_PROBE=off` + restart, senza rilascio.
 * RIMOZIONE:   grep -rn "PLEX-HISTORY-PROBE" (questo file, srv/cat-service.cds, srv/cat-service.js,
 *              app/marsplm-sap2plex/webapp/util/Probes.js, test/plexHistoryProbe.test.js).
 */

'use strict';

// Nessuna dipendenza da `cds` e nessuna rete: il trasporto arriva iniettato in `deps.plex.get`, e
// le regole si collaudano con `node test/plexHistoryProbe.test.js` senza tenant.
//
// I DUE PATH E LA QUERY STRING NON SI RISCRIVONO QUI: vengono dal modulo puro che il job
// d'esercizio usa, cosi' la sonda interroga gli indirizzi VERI e non una loro imitazione. Se un
// path cambia, cambia in un posto e la sonda lo segue.
const { SOURCE_BY_CODE, requestPath } = require('./plexConfSources');
const { plexErrText } = require('./plexCallTrace');

const OFF = String(process.env.PLEX_HISTORY_PROBE || '').trim().toLowerCase() === 'off';

/** Forma delle voci nell'anello: `sonda <id>` e' esclusa dal dump d'esercizio di window.isCalls(). */
const PROBE_FORM = 'sonda plex-history';

/**
 * Etichetta del tracciato in `cf logs`. Il default di plexCallTrace e' `SPLIT-TRACE`, che e' il
 * perimetro grep dichiarato della 0012: un flusso nuovo porta il suo, o quel grep mentirebbe.
 */
const PROBE_TAG = 'PLEX-HISTORY-PROBE';

/** L'ampiezza della finestra, in minuti. E' il contratto della sonda, non un default da rilassare. */
const PROBE_MINUTES = 15;

/** Le DUE sorgenti in perimetro, in quest'ordine. Vedi la testata per la terza. */
const PROBE_SOURCE_CODES = Object.freeze(['PROD_ENTRY', 'SCRAP_ENTRY']);
const PROBE_SOURCES = Object.freeze(PROBE_SOURCE_CODES.map((c) => SOURCE_BY_CODE[c]));

const MAX_BODY = 2000;
const MAX_ROWS_JSON = 20000;
const MS_MIN = 60 * 1000;

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function cut(v, n) {
  const s = v === undefined || v === null ? '' : (typeof v === 'string' ? v : safeJson(v));
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/**
 * Il corpo di una risposta Connect in array.
 * Le due API rispondono con un array nudo; le altre forme si tollerano perche' costano una riga e
 * perche' una risposta inattesa non deve far sparire il dato dalla diagnosi. E' la stessa
 * tolleranza di plexConfSources.asArray, ma qui NON si riusa quella funzione: `{}` deve diventare
 * `[{}]` e non `[]`, o un oggetto solo restituito da Plex non si vedrebbe.
 */
function asArray(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.value)) return body.value;
  if (body && Array.isArray(body.results)) return body.results;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && typeof body === 'object') return [body];
  return [];
}

/** Riga vuota: tutti i campi dichiarati dalla function, cosi' la tabella in console e' regolare. */
function row(id, what, extra = {}) {
  return {
    id,
    what,
    plant: '',
    request: '',
    windowUtc: '',
    httpStatus: 0,
    ok: false,
    rows: 0,
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

/**
 * La finestra della sonda. FUNZIONE PURA.
 *
 * NON passa da plexConfWindow.resolveWindow, e non e' una svista: quella funzione e' guidata dal
 * watermark, applica un lookback di due minuti e un tetto di 24 ore, e con essa la finestra
 * dipenderebbe dallo stato del job invece di essere quella dichiarata. Qui l'ampiezza e' esatta:
 * quindici minuti che finiscono nell'istante dell'invocazione.
 *
 * @param {Date} now l'istante dell'invocazione — obbligatorio
 * @param {number} [minutes] ampiezza in minuti
 * @returns {{beginDate: string, endDate: string, begin: Date, end: Date, minutes: number}}
 *   `beginDate`/`endDate` sono ISO 8601 UTC, la forma che la Connect API vuole nella query string
 *   (il contratto non dichiara in quale fuso il tenant le interpreti: si mandano in UTC come il job).
 */
function probeWindow(now, minutes = PROBE_MINUTES) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) {
    throw new Error('probeWindow: `now` è obbligatorio ed è un difetto di programmazione, non un dato mancante.');
  }
  const span = Number(minutes) > 0 ? Number(minutes) : PROBE_MINUTES;
  const begin = new Date(at.getTime() - span * MS_MIN);
  return {
    beginDate: begin.toISOString(),
    endDate: at.toISOString(),
    begin,
    end: at,
    minutes: span
  };
}

/** «1 riga» / «3 righe»: il verdetto lo legge una persona. */
function q(count, singolare, plurale) {
  return `${count} ${count === 1 ? singolare : plurale}`;
}

/**
 * Lo stato di una riga di lettura, per il verdetto. FUNZIONE PURA.
 *
 * Quattro stati e non tre: `VUOTO` e `KO` sono tenuti distinti perche' una lettura riuscita senza
 * righe e una lettura fallita si leggono uguali a schermo e hanno rimedi opposti — nel primo caso
 * non c'e' niente da fare, nel secondo c'e' un corpo d'errore da guardare. E' la stessa
 * distinzione fra VUOTO e IGNOTO della sonda del backwards-schedule (0009 RB-06c).
 */
function stateOf(r) {
  if (!r.request) return 'NON ESEGUITA';
  if (!r.ok) return 'KO';
  return r.rows > 0 ? 'OK' : 'VUOTO';
}

/**
 * Il verdetto: l'esito complessivo, la mossa e una riga per lettura. FUNZIONE PURA.
 *
 * @param {object[]} rows le righe di lettura, senza la testata
 * @param {{windowUtc: string, minutes: number, plants: string[]}} ctx
 * @returns {string}
 */
function verdict(rows, { windowUtc = '', minutes = PROBE_MINUTES, plants = [] } = {}) {
  const letture = rows.filter((r) => !!r.request);
  const riuscite = letture.filter((r) => r.ok);
  const ko = letture.filter((r) => !r.ok);
  const nonEseguite = rows.filter((r) => !r.request);
  const totali = riuscite.reduce((acc, r) => acc + (Number(r.rows) || 0), 0);

  const lines = [];
  const dove = `${q(plants.length, 'plant', 'plant')} (${plants.join(', ') || 'nessuno'})`;

  if (!letture.length) {
    lines.push(`ESITO nessuna lettura eseguita su ${dove}: nessuna connessione Plex risolta.`);
    lines.push('MOSSA configura la connessione Plex del plant (scheda «Plex connection» della '
      + 'configurazione plant, feature 0020): senza host e consumer key non c\'è niente da chiamare.');
  } else if (!ko.length && totali > 0) {
    lines.push(`ESITO ${q(letture.length, 'lettura riuscita', 'letture riuscite')} su ${dove}, `
      + `${q(totali, 'riga', 'righe')} in tutto nella finestra di ${minutes} minuti (${windowUtc}).`);
    lines.push('MOSSA apri i gruppi qui sotto: `rowsJson` porta le righe come Plex le ha mandate, '
      + 'senza normalizzazione. Sono i campi su cui il job PROD_CONF costruisce i documenti '
      + '(partOperationId, operationNumber, jobId, partId).');
  } else if (!ko.length) {
    lines.push(`ESITO ${q(letture.length, 'lettura riuscita', 'letture riuscite')} su ${dove}, `
      + `e ZERO righe nella finestra di ${minutes} minuti (${windowUtc}).`);
    lines.push(`MOSSA non è un errore: in quei ${minutes} minuti su Plex non è stato registrato `
      + 'niente. Registra una produzione o uno scarto e rilancia entro il quarto d\'ora — oppure '
      + 'guarda `request` per verificare che la finestra sia quella che ti aspetti.');
  } else {
    lines.push(`ESITO ${q(ko.length, 'lettura fallita', 'letture fallite')} su ${letture.length}`
      + `${riuscite.length ? `, ${q(totali, 'riga', 'righe')} dalle altre` : ''} `
      + `(finestra di ${minutes} minuti, ${windowUtc}).`);
    lines.push('MOSSA guarda `error` e `responseBody` delle righe KO, che restano aperte: il corpo '
      + 'che Plex ha risposto è l\'unica informazione utile su queste due letture, per cui il '
      + 'contratto dichiara solo il 200.');
  }

  for (const r of rows) {
    const st = stateOf(r);
    const mark = st === 'OK' ? '[OK]     ' : (st === 'VUOTO' ? '[VUOTO]  ' : (st === 'KO' ? '[KO]     ' : '[NON ESEGUITA] '));
    const detail = st === 'OK' || st === 'VUOTO'
      ? `${q(r.rows, 'riga', 'righe')} in ${r.ms} ms`
      : (st === 'KO' ? (r.error || `HTTP ${r.httpStatus}`) : (r.error || 'lettura non eseguita'));
    lines.push(`${mark}${r.id}${r.plant ? ` (plant ${r.plant})` : ''} — ${detail}`);
  }

  if (nonEseguite.length && letture.length) {
    // I plant fuori si NOMINANO: contarli lascia la domanda «quali?», che è la sola che conta
    // quando si va a configurare la connessione mancante.
    const fuori = nonEseguite.map((r) => r.plant).filter(Boolean).join(', ');
    lines.push(nonEseguite.length === 1
      ? `NOTA il plant ${fuori} è rimasto fuori: la sua connessione Plex non è stata risolta. `
        + 'Gli altri sono stati letti comunque.'
      : `NOTA ${nonEseguite.length} plant sono rimasti fuori (${fuori}): la loro connessione Plex `
        + 'non è stata risolta. Gli altri sono stati letti comunque.');
  }

  return lines.join('\n');
}

// ================================================================
// La lettura
// ================================================================

/**
 * Una lettura Connect. Non lancia mai: un'eccezione e' un esito della sonda, non un suo guasto —
 * `plexGet` risponde `{ok:false}` su un non-2xx ma LANCIA su un errore di rete, e le due cose
 * devono finire nella stessa riga.
 */
async function get(deps, { id, what, plant, path, windowUtc }) {
  const base = { plant, windowUtc, request: `GET ${path}` };
  const t0 = Date.now();
  try {
    const r = await deps.plex.get(path);
    const list = r.ok ? asArray(r.body) : [];
    // Le righe INTERE, non le prime venti: la domanda della sonda è cosa torna. Il tetto è la
    // larghezza della colonna, e quando morde si dichiara — un JSON tagliato che il browser non
    // riesce a riparsare va detto, non lasciato sembrare una risposta strana.
    const rowsJson = r.ok ? cut(list, MAX_ROWS_JSON) : '';
    const tagliato = rowsJson.endsWith('...');
    return row(id, what + (tagliato ? ` · ATTENZIONE: righe tagliate a ${MAX_ROWS_JSON} caratteri` : ''), {
      ...base,
      httpStatus: r.status,
      ok: !!r.ok,
      rows: list.length,
      error: r.ok ? '' : plexErrText(r),
      responseBody: r.ok ? '' : cut(r.body, MAX_BODY),
      firstRow: cut(list[0], 500),
      rowsJson,
      ms: Date.now() - t0
    });
  } catch (e) {
    return row(id, what, {
      ...base,
      error: `ECCEZIONE ${e.message}`,
      ms: Date.now() - t0
    });
  }
}

/**
 * Le due letture per ogni plant, piu' il verdetto in testa.
 *
 * @param {object} deps
 * @param {Array<{plant: string, plex?: {get: Function}, error?: string}>} deps.targets
 *   un elemento per plant: `plex` e' la tripla TRACCIATA (srv/lib/plexCallTrace.js), `error` il
 *   motivo per cui la connessione non e' stata risolta. Chi ha `error` non viene letto e lo
 *   DICHIARA: un plant senza connessione non ferma gli altri.
 * @param {object} o
 * @param {Date} o.now l'istante dell'invocazione: la finestra finisce qui
 * @param {number} [o.minutes]
 * @returns {Promise<object[]>} la testata (`VERDETTO` o `OFF`) e una riga per lettura
 */
async function runPlexHistoryProbe(deps, { now, minutes = PROBE_MINUTES } = {}) {
  if (OFF) {
    return [row('OFF', 'Sonda spenta da PLEX_HISTORY_PROBE=off: nessuna lettura eseguita.')];
  }

  const targets = (deps && deps.targets) || [];
  const win = probeWindow(now, minutes);
  const windowUtc = `${win.beginDate} → ${win.endDate}`;

  const out = [];
  for (const t of targets) {
    if (!t.plex) {
      out.push(row(`CONN-${t.plant}`, 'Connessione Plex del plant non risolta: le due letture non '
        + 'sono state eseguite.', {
        plant: t.plant,
        windowUtc,
        error: t.error || 'connessione Plex non risolta'
      }));
      continue;
    }
    for (const source of PROBE_SOURCES) {
      out.push(await get({ plex: t.plex }, {
        // 'PROD' / 'SCRAP': l'id sta in String(16) anche col plant appeso.
        id: `${source.code.split('_')[0]}-${t.plant}`,
        what: `${source.label} del plant ${t.plant}, finestra di ${win.minutes} minuti`,
        plant: t.plant,
        path: requestPath(source, win),
        windowUtc
      }));
    }
  }

  return [
    row('VERDETTO', verdict(out, {
      windowUtc,
      minutes: win.minutes,
      plants: targets.map((t) => t.plant)
    }), { windowUtc, ok: out.some((r) => r.ok) }),
    ...out
  ];
}

module.exports = {
  runPlexHistoryProbe,
  // esportate per il test: sono le regole, e si collaudano senza rete
  probeWindow,
  verdict,
  stateOf,
  asArray,
  row,
  PROBE_SOURCES,
  PROBE_SOURCE_CODES,
  PROBE_MINUTES,
  PROBE_FORM,
  PROBE_TAG,
  MAX_ROWS_JSON,
  OFF
};

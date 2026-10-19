/**
 * [PLANT-PAGE] Regole pure della paginazione di `A_ProductPlant`.
 *
 * PERCHE' ESISTE. La lettura del perimetro materiali e' l'unica del progetto che pagina davvero
 * verso l'Integration Suite: `$top`/`$skip` su E-09, pagine da mille. Finora quella paginazione
 * era scritta due volte — in `cat-service.js` e in `autoAssign.js` — e le due copie erano gia'
 * divergenti (una ordina e mette in cache, l'altra no). Qui stanno le decisioni che si possono
 * verificare senza rete: quanto grande e' la prossima pagina, quali offset partono insieme,
 * quando l'insieme e' finito, quando la sorgente sta ignorando lo `$skip`, quando si smette.
 * L'orchestrazione — che chiama `run()`, tiene la cache e scrive i log — sta in
 * srv/lib/plantRows.js.
 *
 * NESSUNA DIPENDENZA: ne' `cds` ne' la rete. Test: `node test/plantRowsPaging.test.js`.
 *
 * IL RAMO ONPREM NON HA NIENTE DI TUTTO QUESTO, ed e' voluto: la' a paginare e' un gateway
 * OData vero, la lettura di oggi funziona, e cambiarla sarebbe una regressione cercata
 * (DEC-34). `pagingConfig` lo rende esplicito — finestra 1, nessun dimezzamento, nessuna
 * scadenza — invece di lasciarlo alla disciplina di chi legge.
 *
 * Perimetro: grep -rn "PLANT-PAGE".
 */

'use strict';

/** Pagina di partenza. Mille e' quella in esercizio dal primo giorno della 0013. */
const PAGE_DEFAULT = 1000;
/** Sotto questa soglia non si scende: se non passa neanche 125 righe, il problema non e' il volume. */
const PAGE_MIN_DEFAULT = 125;
/** Quante pagine partono insieme, in modalita' IS. */
const WAVE_DEFAULT = 4;
/**
 * Scadenza della lettura di un plant. Sta SOTTO i 120 s dell'approuter e della destination
 * (`isSource.requestTimeout`): oltre quel tetto il browser riceve un `504` e con esso zero righe,
 * mentre qui si smette di paginare e il perimetro esce troncato e DICHIARATO.
 *
 * I 120 s dell'approuter sono veri dal 14/09/2026, e prima NON LO ERANO: la destination `srv-api`
 * del modulo approuter non dichiarava `timeout`, quindi valeva il default della libreria — 30 s —
 * e questa scadenza da 90 s non ha mai potuto proteggere niente. Il numero adesso e' scritto in
 * `mta.yaml` accanto a `forwardAuthToken`; se lo si abbassa la', va abbassato anche qui.
 */
const DEADLINE_DEFAULT_MS = 90 * 1000;
/** Tetto dichiarato: `MAX_PAGES * page` righe per plant. Era gia' 200 x 1000 = 200.000. */
const MAX_PAGES_DEFAULT = 200;
/** Attesa prima di ritentare una risposta di sovraccarico (429/503): dimezzare non basta. */
const RETRY_WAIT_MS = 1500;

/** Numero positivo da una variabile d'ambiente, altrimenti il default. Mai `NaN`, mai zero. */
function num(env, name, def) {
  const n = Number((env || {})[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/**
 * I parametri di paginazione del canale attivo.
 *
 * @param {object} env  process.env (o una copia, nei test)
 * @param {object} opts `{ mode }` — 'IS' oppure ONPREM/qualunque altro valore
 */
function pagingConfig(env = {}, opts = {}) {
  const adaptive = String(opts.mode || '').toUpperCase() === 'IS';
  const page = num(env, 'PLANT_ROWS_PAGE', PAGE_DEFAULT);
  const maxPages = num(env, 'PLANT_ROWS_MAX_PAGES', MAX_PAGES_DEFAULT);
  if (!adaptive) {
    // ONPREM: esattamente il comportamento di prima — una pagina per volta, sempre della stessa
    // dimensione, nessuna scadenza. Le tre leve restano leggibili nel log, valorizzate a «niente».
    return { adaptive: false, page, pageMin: page, wave: 1, deadlineMs: 0, maxPages, retryWaitMs: 0 };
  }
  const pageMin = Math.min(num(env, 'PLANT_ROWS_PAGE_MIN', PAGE_MIN_DEFAULT), page);
  return {
    adaptive: true,
    page,
    pageMin,
    wave: num(env, 'PLANT_ROWS_PAGE_CONCURRENCY', WAVE_DEFAULT),
    deadlineMs: num(env, 'PLANT_ROWS_DEADLINE_MS', DEADLINE_DEFAULT_MS),
    maxPages,
    retryWaitMs: RETRY_WAIT_MS
  };
}

/**
 * La pagina successiva della scala, o `0` se si e' gia' al minimo.
 * `1000 -> 500 -> 250 -> 125 -> 0`. Non scende mai sotto `pageMin`.
 */
function shrunkPage(pageSize, pageMin) {
  if (!(pageSize > pageMin)) return 0;
  return Math.max(Math.floor(pageSize / 2), pageMin);
}

/** Stato HTTP reale dell'errore, come lo incarta il client remoto di CAP. */
function statusOf(err) {
  if (!err) return undefined;
  const r = err.reason;
  return (r && r.response && r.response.status) || (r && r.status) || err.status || undefined;
}

/**
 * Cosa fare di una pagina rifiutata.
 *
 * Si ritenta — con la pagina dimezzata, sullo STESSO offset — solo cio' che una pagina piu'
 * piccola puo' plausibilmente risolvere: un guasto a valle (`5xx`), un timeout, un sovraccarico
 * (`429`). Un `4xx` no: un campo non esposto o un filtro rifiutato rispondono uguale a qualunque
 * dimensione, e ritentarli sarebbe solo tempo speso prima di dichiarare la stessa cosa.
 *
 * @returns {{retry: boolean, waitMs: number, why: string}}
 */
function classifyPageError(err, cfg = {}) {
  const status = statusOf(err);
  const msg = String((err && err.message) || '');
  const code = String((err && err.code) || '');
  const timeout = /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|socket hang up/i.test(`${code} ${msg}`);
  const overload = status === 429 || status === 503;
  const downstream = typeof status === 'number' && status >= 500;

  if (!cfg.adaptive) return { retry: false, waitMs: 0, why: 'canale non adattivo: nessun ripiego' };
  if (overload) return { retry: true, waitMs: cfg.retryWaitMs || RETRY_WAIT_MS, why: `sovraccarico (${status})` };
  if (downstream) return { retry: true, waitMs: 0, why: `guasto a valle (${status})` };
  if (timeout) return { retry: true, waitMs: 0, why: 'nessuna risposta entro il tempo della destination' };
  return {
    retry: false,
    waitMs: 0,
    why: status ? `rifiuto ${status}: una pagina piu' piccola risponderebbe uguale` : 'errore non ritentabile'
  };
}

/**
 * Gli offset che partono insieme. La finestra si accorcia sul tetto di pagine, cosi' il tetto
 * resta quello dichiarato anche quando le pagine escono a gruppi.
 *
 * Le pagine gia' emesse si PASSANO e non si ricavano da `nextOffset / pageSize`: dopo un
 * dimezzamento quel rapporto non e' piu' il numero di letture fatte, e il tetto scivolerebbe.
 */
function waveOffsets(nextOffset, pageSize, cfg, pagesIssued = 0) {
  const wave = Math.max(1, cfg.wave || 1);
  const maxPages = cfg.maxPages || MAX_PAGES_DEFAULT;
  const room = Math.max(0, maxPages - pagesIssued);
  const n = Math.min(wave, room);
  const out = [];
  for (let i = 0; i < n; i++) out.push(nextOffset + i * pageSize);
  return out;
}

/**
 * Verdetto su un'onda di pagine.
 *
 * `done` quando una pagina torna piu' corta della sua dimensione: e' la fine dell'insieme. Le
 * pagine chieste DOPO quella corta sono lavoro sprecato — al massimo `wave - 1` letture — e si
 * contano per poterle dichiarare: una finestra non si sceglie a occhio.
 *
 * @param {Array<{offset:number, rows:Array}>} pages nell'ordine in cui sono state chieste
 */
function waveVerdict(pages, pageSize) {
  const sorted = pages.slice().sort((a, b) => a.offset - b.offset);
  let firstShort = -1;
  for (const p of sorted) {
    const n = Array.isArray(p.rows) ? p.rows.length : 0;
    if (n < pageSize) { firstShort = p.offset; break; }
  }
  const done = firstShort >= 0;
  const overshoot = done ? sorted.filter(p => p.offset > firstShort).length : 0;
  const nextOffset = done
    ? -1
    : (sorted.length ? sorted[sorted.length - 1].offset + pageSize : 0);
  return { done, overshoot, nextOffset };
}

/**
 * La sorgente sta ignorando lo `$skip`?
 *
 * Se una pagina con offset maggiore di zero comincia con la stessa riga della prima, `IV_SKIP`
 * non e' stato applicato: la lettura tornerebbe per sempre lo stesso blocco, fino al tetto delle
 * pagine, e i duplicati verrebbero contati come dati. Un limite NON ONORATO e' piu' pericoloso
 * di un limite assente (DEC-83), quindi qui ci si ferma e lo si dichiara. E' la verifica che il
 * probe P-2 del contratto fa a mano ("DEVE essere diverso dal primo di pp0.json"), messa in
 * esercizio.
 */
function skipIgnored(firstKeyOfPageZero, firstKeyOfPage, offset) {
  if (!offset) return false;
  if (!firstKeyOfPageZero || !firstKeyOfPage) return false;
  return firstKeyOfPageZero === firstKeyOfPage;
}

/** Scadenza superata? Si guarda FRA una pagina e l'altra, mai a meta' chiamata. */
function deadlineExpired(startedAt, now, deadlineMs) {
  if (!deadlineMs) return false;
  return (now - startedAt) >= deadlineMs;
}

/**
 * Il testo con cui una lettura incompleta si dichiara. Nessuna traduzione: finisce in `cf logs`
 * e nella busta verso il cockpit, che lo mostra al configuratore insieme alla propria frase.
 *
 * @param {object} m metriche accumulate dal lettore
 * @returns {{complete: boolean, reasons: string[], text: string}}
 */
function summarize(m = {}) {
  const reasons = [];
  if (m.readOk === false) reasons.push('lettura fallita');
  if (m.truncatedByCap) reasons.push(`troncato al tetto di ${m.maxRows} righe`);
  if (m.truncatedByDeadline) reasons.push(`interrotto dopo ${Math.round((m.ms || 0) / 1000)} s (scadenza di lettura)`);
  if (m.skipIgnored) reasons.push('la sorgente ignora lo $skip: oltre la prima pagina non si legge');
  // [PAGED-READ] Righe che il criterio chiesto non avrebbe dovuto restituire: e' lo stesso difetto
  // dello `$skip` ignorato visto dall'altro lato — un filtro non applicato — e va dichiarato per la
  // stessa ragione. Il testo lo porta il lettore, perche' solo lui sa QUALE criterio e'.
  if (m.offScope) reasons.push(m.offScopeText || `${m.offScope} righe fuori dal criterio chiesto`);
  if (m.unordered && m.pages > 1) reasons.push('paginato senza ordine stabile');
  if (m.blank) reasons.push(`${m.blank} righe senza Product`);
  const complete = reasons.length === 0;
  return {
    complete,
    reasons,
    text: complete ? '' : `perimetro INCOMPLETO: ${reasons.join('; ')}`
  };
}

module.exports = {
  PAGE_DEFAULT,
  PAGE_MIN_DEFAULT,
  WAVE_DEFAULT,
  DEADLINE_DEFAULT_MS,
  MAX_PAGES_DEFAULT,
  RETRY_WAIT_MS,
  pagingConfig,
  shrunkPage,
  statusOf,
  classifyPageError,
  waveOffsets,
  waveVerdict,
  skipIgnored,
  deadlineExpired,
  summarize
};

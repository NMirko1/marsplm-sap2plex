/**
 * [PAGED-READ] La lettura PAGINATA di un perimetro per plant, in un punto solo.
 *
 * PERCHE' ESISTE. Dalla 0035 il perimetro `A_ProductPlant` si legge a pagine, con dimezzamento,
 * onde, scadenza, guardia dello `$skip` e verdetto: quel ciclo stava tutto dentro
 * srv/lib/plantRows.js. Dalla 0040 lo stesso perimetro ha una SECONDA lettura — `A_Product` con la
 * query per plant — che ha bisogno esattamente delle stesse cose. Riscriverla accanto avrebbe
 * prodotto la terza copia di questa paginazione, cioe' il difetto che la 0035 esisteva per togliere:
 * due copie della stessa lettura DIVERGONO, e l'hanno gia' fatto (una ordinava e metteva in cache,
 * l'altra no).
 *
 * COSA STA QUI e cosa no. Qui c'e' il CICLO — quante righe chiedere, quali offset partono insieme,
 * cosa fare di una pagina rifiutata, quando fermarsi, cosa dichiarare. Le decisioni che si possono
 * verificare senza rete restano in srv/lib/plantRowsPaging.js (pure, col loro test); l'entity, le
 * colonne, i criteri e il significato delle righe restano nei due chiamanti:
 * srv/lib/plantRows.js (`A_ProductPlant`) e srv/lib/productRows.js (`A_Product`).
 *
 * DUE COSE CHE NON SONO UN DETTAGLIO:
 *
 *  - `deadlineMs` E' UN PARAMETRO, e il valore giusto dipende da CHI legge. I 90 secondi di
 *    plantRowsPaging.js stanno sotto i 120 dell'approuter: oltre quel tetto il browser prende un
 *    504 e con esso zero righe, quindi si smette di paginare e il perimetro esce troncato e
 *    dichiarato. Un JOB non ha un approuter: applicargli quella scadenza troncherebbe un plant
 *    grosso senza che nessuno l'abbia chiesto. Nel server web resta quella di sempre, nei job e' 0.
 *
 *  - `guard` E' LA DIFESA CONTRO UN CRITERIO NON ONORATO. La riga tornata puo' dire da se' se il
 *    filtro e' stato applicato (il `Plant` che porta), e un filtro ignorato non da' errore: da' un
 *    insieme piu' GRANDE creduto piu' piccolo. Vedi DEC-49 e DEC-83 — un limite non onorato e' piu'
 *    pericoloso di un limite assente, perche' il chiamante ci conta.
 *
 * NON LANCIA MAI: un guasto e' un esito, e chi legge decide se ripiegare o dichiarare.
 *
 * Perimetro: grep -rn "PAGED-READ".
 */

'use strict';

require('@sap/cds'); // per i globali di cds.ql (SELECT)
const P = require('./plantRowsPaging');

const trim = (v) => String(v == null ? '' : v).trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * La query di UNA pagina.
 *
 * `columns` accetta le tre forme che i chiamanti hanno gia': un array di nomi, la funzione di
 * proiezione del ramo ONPREM (che apre gli `$expand`), oppure `null` per «nessun `$select`»,
 * cioe' la select-all di sempre.
 */
function pageQuery(src, spec, { pageSize, offset, withOrder }) {
  const ent = src.entities[spec.entity];
  const base = spec.columns == null
    ? SELECT.from(ent)
    : SELECT.from(ent).columns(spec.columns);
  const q = base.where({ ...(spec.where || {}) }).limit(pageSize, offset);
  // Ordine stabile: senza, `$skip` puo' ripetere una riga e saltarne un'altra fra due pagine —
  // e' successo davvero, 2 righe su 3478 nel sandbox ([IS-BLANK-ROWS] in cat-service.js). Se
  // l'indirizzo rifiuta l'ordinamento si ripiega senza, DICHIARANDO che oltre la prima pagina
  // la paginazione non e' garantita.
  if (withOrder && spec.orderBy) q.orderBy(spec.orderBy);
  return q;
}

/**
 * Una pagina, con i suoi due ripieghi: prima l'ordinamento, poi la dimensione.
 *
 * Torna `{ rows }` oppure `{ error }`. Non dimezza da se': la scala la governa il ciclo, perche'
 * la pagina piu' piccola vale per TUTTE le pagine successive e non solo per quella caduta.
 */
async function readOnePage(src, spec, state, { pageSize, offset }) {
  try {
    return { rows: (await src.run(pageQuery(src, spec, { pageSize, offset, withOrder: state.ordered }))) || [] };
  } catch (e) {
    if (!state.ordered) return { error: e };
    // Primo ripiego: l'indirizzo potrebbe non reggere l'$orderby. Si prova una volta sola, e da
    // li' in poi si legge senza — dichiarandolo, perche' senza ordine la paginazione puo'
    // ripetere e saltare righe.
    try {
      const rows = (await src.run(pageQuery(src, spec, { pageSize, offset, withOrder: false }))) || [];
      state.ordered = false;
      console.warn(`>>> ${spec.tag} ${spec.label}: ordinamento rifiutato (${e.message}); `
        + 'ripiego senza: oltre la prima pagina la paginazione NON e\' stabile');
      return { rows };
    } catch (e2) {
      return { error: e2 };
    }
  }
}

/**
 * Un perimetro, pagina dopo pagina.
 *
 * @param {object} src  sorgente d'area (productSource() / la sua gemella per la query)
 * @param {object} spec
 * @param {string} spec.entity      nome dell'entity in `src.entities`
 * @param {Array|Function|null} [spec.columns]  `$select`, proiezione ONPREM, o niente
 * @param {object} [spec.where]     criteri della lettura
 * @param {string} [spec.keyField='Product']  il campo che identifica la riga nella mappa
 * @param {string} [spec.orderBy='Product']   ordine stabile ('' = nessuno)
 * @param {Function} [spec.guard]   `(row) => string|null`: perche' questa riga e' FUORI dal
 *                                  criterio chiesto. Il primo testo diventa la ragione dichiarata.
 * @param {string} [spec.tag]       tag grep-abile nei log
 * @param {string} [spec.label]     'plant 1710'
 * @param {string} [spec.unit='materiali'] come si chiamano le chiavi, nella riga di log
 * @param {string} [spec.missingNote] cosa aggiungere all'avviso di perimetro incompleto
 * @param {number} [spec.deadlineMs] scadenza (0 = nessuna); assente = quella del canale
 * @returns {Promise<object>} `{ byKey, readOk, complete, reasons, text, rows, keys, pages,
 *                              pageSize, shrinks, dup, blank, offScope, unordered, ms, error }`
 */
async function readPaged(src, spec = {}) {
  const s = {
    keyField: 'Product',
    orderBy: 'Product',
    tag: '[PAGED-READ]',
    label: '',
    unit: 'materiali',
    missingNote: '',
    ...spec
  };
  const cfg = P.pagingConfig(process.env, { mode: src.mode });
  const deadlineMs = s.deadlineMs === undefined ? cfg.deadlineMs : Number(s.deadlineMs) || 0;
  const byKey = new Map();
  const state = { ordered: true };
  const m = {
    rows: 0, pages: 0, dup: 0, blank: 0, shrinks: 0, overshoot: 0, offScope: 0, readOk: true,
    truncatedByCap: false, truncatedByDeadline: false, skipIgnored: false,
    maxRows: cfg.maxPages * cfg.page, error: ''
  };

  const startedAt = Date.now();
  let pageSize = cfg.page;
  let offset = 0;
  let firstKeyOfPageZero = '';

  // Un duplicato ha TRE cause e nessuna delle tre e' dimostrata dal conteggio, per cui `dup` non
  // entra fra le cause di incompletezza (P.summarize) e resta un numero da leggere accanto a
  // `shrinks` e `pages`: (1) paginazione non ordinata — una riga tornata su due pagine, e allora
  // ce n'e' un'altra che non e' tornata affatto; (2) un dimezzamento, dove e' ATTESO, perche' si
  // riprende dall'offset caduto e le pagine gia' lette oltre quel punto arrivano due volte;
  // (3) la sorgente stessa. La terza non e' teorica: sul sandbox, plant 1710, arrivano 2308
  // righe per 2306 materiali anche leggendo TUTTO IN UNA PAGINA SOLA.
  const absorb = (rows) => {
    for (const row of rows) {
      const k = trim(row[s.keyField]);
      if (!k) { m.blank++; continue; }     // riga priva di identita' (IS-BLANK-ROWS)
      // [PAGED-READ] La riga dice da se' se il criterio e' stato applicato. Una riga fuori dal
      // criterio NON si tiene — sarebbe un altro plant nell'indice di questo — e non si tace:
      // se il filtro e' ignorato, tutte lo sono, e l'insieme in mano non e' quello che si crede.
      if (s.guard) {
        const why = s.guard(row);
        if (why) {
          if (!m.offScope) m.offScopeText = why;
          m.offScope++;
          continue;
        }
      }
      if (byKey.has(k)) m.dup++;
      byKey.set(k, row);
    }
    m.rows += rows.length;
  };

  for (;;) {
    if (m.pages >= cfg.maxPages) { m.truncatedByCap = true; break; }
    if (P.deadlineExpired(startedAt, Date.now(), deadlineMs)) { m.truncatedByDeadline = true; break; }

    const offsets = P.waveOffsets(offset, pageSize, cfg, m.pages);
    if (!offsets.length) { m.truncatedByCap = true; break; }

    const results = await Promise.all(
      offsets.map(o => readOnePage(src, s, state, { pageSize, offset: o }).then(r => ({ ...r, offset: o })))
    );
    m.pages += results.length;

    // Le pagine riuscite si tengono TUTTE, anche quelle oltre un buco: sono righe vere, e il
    // ciclo riprende comunque dall'offset caduto. Il duplicato lo assorbe la mappa.
    const ok = results.filter(r => !r.error).sort((a, b) => a.offset - b.offset);
    const ko = results.filter(r => r.error).sort((a, b) => a.offset - b.offset)[0];

    // Lo `$skip` e' stato applicato? Si guarda la PRIMA riga, prima di assorbire: dopo, le righe
    // ripetute sarebbero gia' confuse con i dati. Se non e' applicato si tiene la sola pagina
    // zero — le altre sono la stessa pagina un'altra volta — e ci si ferma.
    for (const r of ok) {
      const first = trim(r.rows[0] && r.rows[0][s.keyField]);
      if (!r.offset) firstKeyOfPageZero = first;
      else if (P.skipIgnored(firstKeyOfPageZero, first, r.offset)) { m.skipIgnored = true; break; }
    }
    for (const r of ok) { if (!m.skipIgnored || !r.offset) absorb(r.rows); }
    if (m.skipIgnored) break;

    if (ko) {
      const verdict = P.classifyPageError(ko.error, cfg);
      const next = verdict.retry ? P.shrunkPage(pageSize, cfg.pageMin) : 0;
      if (!next) {
        m.readOk = false;
        m.error = `${ko.error && ko.error.message}${verdict.why ? ` (${verdict.why})` : ''}`;
        break;
      }
      m.shrinks++;
      console.warn(`>>> ${s.tag} ${s.label}: pagina da ${pageSize} righe all'offset ${ko.offset} `
        + `rifiutata — ${verdict.why}. Si riprova dallo STESSO offset con ${next}.`);
      if (verdict.waitMs) await sleep(verdict.waitMs);
      pageSize = next;
      offset = ko.offset;
      continue;
    }

    const wave = P.waveVerdict(ok, pageSize);
    m.overshoot += wave.overshoot;
    if (wave.done) break;
    offset = wave.nextOffset;
  }

  m.ms = Date.now() - startedAt;
  m.unordered = !state.ordered;
  const sum = P.summarize(m);

  console.log(`>>> ${s.tag} ${s.label}: ${byKey.size} ${s.unit} da ${m.rows} righe `
    + `in ${m.pages} pagine da ${pageSize} (duplicati ${m.dup}, senza ${s.keyField} ${m.blank}, `
    + `dimezzamenti ${m.shrinks}, letture oltre la fine ${m.overshoot}, ${m.ms} ms)`);
  if (!sum.complete) {
    console.warn(`>>> ${s.tag} ${s.label}: ${sum.text}`
      + (m.error ? ` — ${m.error}` : '')
      + (s.missingNote ? `. ${s.missingNote}` : ''));
  }

  return {
    byKey,
    readOk: m.readOk,
    complete: sum.complete,
    reasons: sum.reasons,
    text: sum.text,
    rows: m.rows,
    keys: byKey.size,
    pages: m.pages,
    pageSize,
    shrinks: m.shrinks,
    dup: m.dup,
    blank: m.blank,
    offScope: m.offScope,
    unordered: m.unordered,
    ms: m.ms,
    error: m.error
  };
}

/**
 * La cache delle letture paginate: SINGLE-FLIGHT, perche' si mette in cache la PROMESSA e non il
 * risultato. Senza, i blocchi che il client chiede in sequenza ravvicinata farebbero partire piu'
 * letture dello stesso plant prima che la prima finisca.
 *
 * Un esito INCOMPLETO non resta in cache — non solo quello fallito: tenere per cinque minuti un
 * perimetro che sappiamo tagliato significa servirlo a chi arriva dopo senza che nessuno possa
 * piu' accorgersene, e la lettura successiva e' l'unica occasione di rimediare.
 *
 * La chiave la costruisce il chiamante e DEVE cominciare con `${plant}|`: `invalidate(plant)`
 * cancella per prefisso, cioe' tutte le combinazioni di colonne di quel plant.
 */
function createPagedCache({ ttlMs, now = Date.now } = {}) {
  const entries = new Map();   // chiave -> { at, promise }

  function get(key, load) {
    const hit = entries.get(key);
    if (hit && (now() - hit.at) < ttlMs) return hit.promise;
    const promise = load()
      .then((out) => { if (!out.complete) entries.delete(key); return out; })
      .catch((e) => { entries.delete(key); throw e; });
    entries.set(key, { at: now(), promise });
    return promise;
  }

  /** Butta via quello che sappiamo di un plant (tutte le combinazioni di colonne). */
  function invalidate(scope) {
    const prefix = scope == null ? null : `${scope}|`;
    let n = 0;
    for (const key of [...entries.keys()]) {
      if (prefix === null || key.startsWith(prefix)) { entries.delete(key); n++; }
    }
    return n;
  }

  return { get, invalidate, size: () => entries.size };
}

module.exports = { readPaged, createPagedCache };

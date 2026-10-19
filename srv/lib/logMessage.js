// [LOG-MSG-I18N] La forma STRUTTURATA del messaggio di un log di invio (feature 0029).
//
// PERCHE' NON BASTA UNA CHIAVE. Il messaggio di un invio e' COMPOSTO: una testa che dice cos'e'
// successo piu' fino a tre code che compaiono solo quando c'e' qualcosa da dichiarare — il flag
// «autoDeplete», l'unita' di consumo, i work center in eccesso. Concatenate a mano erano tre
// stringhe unite da ' — '; tradotte alla lettura sono una LISTA DI SEGMENTI, ognuno con la sua
// chiave i18n e i suoi parametri. Un segmento sta in `{ c, p }` e non in `{ code, params }` perche'
// questo oggetto viene serializzato in una colonna con un tetto: i nomi lunghi si pagano su ogni
// riga di ogni log.
//
// LA REGOLA CHE RENDE IL MODULO NECESSARIO, e non due righe di `JSON.stringify`: quando il JSON
// sfora il tetto si scartano SEGMENTI INTERI, mai il JSON a metà. Un JSON troncato e' illeggibile,
// `unpack` darebbe `[]` e il messaggio sparirebbe DEL TUTTO — cioe' un difetto invisibile al posto
// di un messaggio lungo. E' la stessa preoccupazione che ha dato a `excessDeclaration` il suo
// ordine deliberato (approvedWcRules.js): il troncamento non deve decidere in silenzio cosa si
// dichiara, per questo cio' che si scarta viene DICHIARATO da un segmento suo.
//
// Modulo PURO: nessuna dipendenza da `cds`, dalla rete ne' dal filesystem. La resa nella lingua
// dell'utente e' di `srv/lib/i18nMessages.js`; qui si decide solo la forma. Si collauda con
// `node test/logMessage.test.js`.

'use strict';

/**
 * Il tetto della colonna che ospita il JSON (`MessageJson` / `LastMessageJson`, String(1000)).
 * Non e' il tetto di `Message`, che resta String(255) e ospita lo snapshot testuale.
 */
const MESSAGE_JSON_MAX = 1000;

/**
 * Tetto di UN parametro. Serve al caso vero da cui nasce la lunghezza: `error.message` di Plex o di
 * axios, che avvolto in un segmento tecnico puo' essere lunghissimo. Si stringe SEMPRE, non solo
 * quando il JSON sfora, cosi' il comportamento e' lo stesso su tutte le righe e non dipende da
 * quante code sono presenti.
 */
const PARAM_MAX = 300;

/** Quanto tenere come minimo di un parametro quando lo spazio e' poco: sotto non dice piu' niente. */
const PARAM_MIN = 8;

/**
 * Il segmento che dichiara lo scarto. Il suo parametro e' il NUMERO di segmenti scartati: senza,
 * «messaggio accorciato» e «messaggio completo» sarebbero indistinguibili.
 */
const TRUNCATED_CODE = 'logMsgTruncated';

/** Il segmento che avvolge un testo tecnico di terzi (Plex, axios, SAP). Non si traduce: si mostra. */
const TECHNICAL_CODE = 'logMsgTechnical';

/**
 * Il segmento che avvolge un testo NOSTRO non ancora convertito a segmenti. E' una LACUNA
 * DICHIARATA, non una scorciatoia.
 *
 * La differenza con `TECHNICAL_CODE` e' chi ha scritto il testo: la' e' un sistema esterno e
 * tradurlo non ha senso, qui e' prosa del progetto che semplicemente non e' ancora passata da i18n —
 * quindi resta in italiano anche per un utente inglese. Serve a distinguere «questo pezzo non si
 * traduce» da «questo pezzo non si traduce ANCORA»: senza due codici diversi, la seconda categoria
 * diventerebbe invisibile e nessuno la chiuderebbe piu'.
 *
 * Non usarlo per comodita' su un messaggio nuovo: un messaggio nuovo nasce a segmenti.
 * Perimetro delle lacune aperte: `grep -rn "logMsgVerbatim"`.
 */
const VERBATIM_CODE = 'logMsgVerbatim';

/** Stringa vuota = «nessun messaggio strutturato». E' cio' che hanno le righe scritte prima della 0029. */
const EMPTY = '';

/**
 * Costruisce un segmento.
 *
 * @param {string} code chiave i18n, dai bundle di `marsplm-sap2plex`
 * @param {...any} params valori per i segnaposto {0}, {1}, …
 * @returns {{c: string, p?: Array}} `null` se il codice manca
 */
function seg(code, ...params) {
  const c = typeof code === 'string' ? code.trim() : '';
  if (!c) return null;
  // La lambda NON e' decorativa: `params.map(clampParam)` passerebbe l'INDICE come secondo
  // argomento, cioe' il tetto, e ogni parametro finirebbe stretto a PARAM_MIN caratteri.
  const p = params.map((v) => clampParam(v));
  // `p` si omette quando e' vuoto: due caratteri per riga su tabelle append-only.
  return p.length ? { c, p } : { c };
}

/** Il segmento che avvolge un errore di un sistema esterno. */
function technical(message) {
  return seg(TECHNICAL_CODE, message);
}

/** Il segmento che avvolge prosa nostra non ancora convertita. Vedi `VERBATIM_CODE`. */
function verbatim(message) {
  return seg(VERBATIM_CODE, message);
}

/** Un parametro reso stringa e stretto a PARAM_MAX. `null`/`undefined` diventano ''. */
function clampParam(value, max = PARAM_MAX) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  const cap = Math.max(PARAM_MIN, max);
  return s.length <= cap ? s : `${s.slice(0, cap - 1)}…`;
}

/**
 * Normalizza una lista di segmenti: scarta i vuoti, garantisce la forma, stringe i parametri.
 *
 * IDEMPOTENTE di proposito, come `activeRules` in orderCompExclRules.js: l'orchestrazione
 * normalizza una volta e `pack` normalizza ancora. Un output non riammissibile in ingresso
 * azzererebbe i messaggi in silenzio.
 *
 * @param {Array} segments
 * @returns {Array<{c: string, p?: Array}>}
 */
function normalize(segments) {
  const list = Array.isArray(segments) ? segments : (segments ? [segments] : []);
  const out = [];
  for (const s of list) {
    if (!s) continue;
    const c = typeof s.c === 'string' ? s.c.trim() : '';
    if (!c) continue;
    const p = Array.isArray(s.p) ? s.p.map((v) => clampParam(v)) : [];
    out.push(p.length ? { c, p } : { c });
  }
  return out;
}

/** Stringe i parametri di un segmento entro un budget complessivo di caratteri. */
function shrink(segment, budget) {
  const p = Array.isArray(segment.p) ? segment.p : [];
  if (!p.length) return { c: segment.c };
  const per = Math.max(PARAM_MIN, Math.floor(budget / p.length));
  return { c: segment.c, p: p.map((v) => clampParam(v, per)) };
}

/**
 * Serializza i segmenti per la colonna.
 *
 * Se il JSON sfora il tetto scarta segmenti dalla CODA — l'ordine in cui i produttori li mettono e'
 * l'ordine di importanza, per ultimo cio' su cui nessuno deve agire — e aggiunge un segmento che
 * dichiara quanti ne ha scartati. Se resta un solo segmento e non basta ancora, stringe i suoi
 * parametri: il JSON resta valido in ogni caso, che e' l'unica proprieta' non negoziabile.
 *
 * @param {Array} segments
 * @returns {string} JSON, o '' se non c'e' niente da dire
 */
function pack(segments) {
  const list = normalize(segments);
  if (!list.length) return EMPTY;

  let kept = list.slice();
  let dropped = 0;

  for (;;) {
    const withMark = dropped ? kept.concat([seg(TRUNCATED_CODE, dropped)]) : kept;
    const out = JSON.stringify(withMark);
    if (out.length <= MESSAGE_JSON_MAX) return out;

    if (kept.length > 1) {
      kept.pop();
      dropped++;
      continue;
    }

    // Un solo segmento e ancora troppo lungo: il volume e' nei parametri.
    const mark = seg(TRUNCATED_CODE, dropped || 1);
    const overhead = JSON.stringify([{ c: kept[0].c }, mark]).length;
    const shrunk = shrink(kept[0], Math.max(PARAM_MIN, MESSAGE_JSON_MAX - overhead));
    const last = JSON.stringify([shrunk, mark]);
    // Ultima difesa: la sola dichiarazione di scarto. Non e' un messaggio utile, ma e' leggibile —
    // e dice che qualcosa e' stato tolto, che e' l'informazione che non deve perdersi.
    return last.length <= MESSAGE_JSON_MAX ? last : JSON.stringify([mark]);
  }
}

/**
 * Legge la colonna e restituisce i segmenti.
 *
 * TOLLERANTE per necessita': su questa colonna si incontrano `null` (righe scritte prima della
 * 0029), `''`, `'[]'`, e — se un giorno qualcosa scrivesse male — JSON rotto. Nessuno di questi
 * casi deve far cadere una READ di lista: si torna `[]` e chi legge ricade sul `Message` salvato.
 *
 * @param {string|Array} json
 * @returns {Array<{c: string, p?: Array}>}
 */
function unpack(json) {
  if (!json) return [];
  if (Array.isArray(json)) return normalize(json);
  if (typeof json !== 'string') return [];
  const s = json.trim();
  if (!s || s === '[]') return [];
  try {
    return normalize(JSON.parse(s));
  } catch (err) {
    console.warn(`>>> [LOG-MSG-I18N] MessageJson illeggibile, si ricade sul Message salvato: ${err.message}`);
    return [];
  }
}

/** `true` se la colonna non porta nessun segmento utilizzabile. */
function isEmpty(json) {
  return unpack(json).length === 0;
}

module.exports = {
  MESSAGE_JSON_MAX,
  PARAM_MAX,
  PARAM_MIN,
  TRUNCATED_CODE,
  TECHNICAL_CODE,
  VERBATIM_CODE,
  EMPTY,
  seg,
  technical,
  verbatim,
  clampParam,
  normalize,
  pack,
  unpack,
  isEmpty
};

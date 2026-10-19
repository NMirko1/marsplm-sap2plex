// [LOG-MSG-I18N] Il meccanismo dei messaggi localizzati, fuori dalla closure di cat-service.js.
//
// PERCHE' QUESTO MODULO ESISTE. `getLocalizedMessage` e `loadI18nMessages` vivevano dentro
// `module.exports = cds.service.impl(async function() { … })`: quello che e' dichiarato la' dentro
// non e' esportabile, e i cinque job girano come PROCESSI SEPARATI — possono fare `require` di un
// file, non entrare in una closure. E' la stessa ragione per cui `resolveAutoAssignments` e'
// uscito in `srv/lib/autoAssign.js` quando la 0025 ne ha avuto bisogno dal job PROD_ORDER, e il
// rischio da sorvegliare e' lo stesso: non un import che non compila, ma la COPIA dentro il job di
// logica che non era estraibile. Due parser `.properties` che divergono darebbero a schermo un
// messaggio diverso da quello scritto nel log.
//
// LA DIFFERENZA CON IL CODICE DI PRIMA E' UNA SOLA: il locale e' un PARAMETRO ESPLICITO, non
// ricavato da `req`. Chi ha una richiesta HTTP lo risolve e lo passa (`getLocalizedMessage` in
// cat-service.js e' ora un wrapper di tre righe su `text()`); chi non l'ha — i job, il recap, i
// writer di log — passa `DEFAULT_LOCALE`. Il resto e' identico: cache annidata per (app, locale),
// parser `.properties` a mano, catena di fallback, sostituzione globale dei segnaposto,
// normalizzazione degli apostrofi raddoppiati dei bundle UI5.
//
// ATTENZIONE AL PATH, ED E' LA TRAPPOLA DI QUESTO FILE. In `cat-service.js` il percorso era
// `path.join(__dirname, '..', 'app', …)` perche' quel file sta in `srv/`. Questo modulo sta un
// livello piu' in basso, quindi servono DUE `'..'`. Sbagliarlo non da' un errore: da' `{}` dal
// `catch`, un `console.warn` in mezzo a mille righe di log, e ogni messaggio a video come chiave
// grezza. Il conto torna anche nel pacchetto deployato: `cds build` copia `srv/**` in `gen/srv/srv`,
// quindi `gen/srv/srv/lib` + due livelli = `gen/srv/app`, che e' proprio dove il `before-all` di
// mta.yaml copia le cartelle i18n. Il test `test/i18nMessages.test.js` sorveglia questo.
//
// Nessuna dipendenza da `cds` ne' dalla rete: solo `fs` e `path`, cosi' il modulo e' collaudabile
// con `node test/i18nMessages.test.js`.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Il locale dello SNAPSHOT persistito. Le colonne `Message` dei log restano scritte in questa
 * lingua — e' il testo di riferimento, non quello che l'utente legge: la resa nella lingua di chi
 * guarda avviene alla lettura (feature 0029). 'en' e non 'it' perche' e' cio' che il progetto
 * scrive oggi quando la richiesta non porta una lingua, quindi un rilascio non cambia il contenuto
 * del database.
 */
const DEFAULT_LOCALE = 'en';

/**
 * La lingua in cui si scrive lo SNAPSHOT testuale, cioe' la colonna `Message` dei log.
 *
 * NON e' DEFAULT_LOCALE, e le due non vanno unite. `DEFAULT_LOCALE` e' il fondo della catena di
 * fallback quando una richiesta non dichiara una lingua: la' 'en' e' l'unica scelta sensata, perche'
 * e' la lingua in cui il progetto scrive le chiavi.
 *
 * Qui la domanda e' un'altra: in che lingua resta scritto cio' che finisce in database e nelle mail?
 * E' l'italiano, per due ragioni che valgono insieme. La prima: `ZJobRunPOS.Message` — il recap di
 * un run, che arriva ai destinatari come PDF e CSV — e' scritto in italiano dai job, che compongono
 * le loro righe attorno a `result.message`; con 'en' una riga sola dentro il recap uscirebbe in
 * inglese. La seconda: quattro delle cinque famiglie di messaggi erano GIA' persistite in italiano,
 * e la sola in inglese era il messaggio dei cicli, cioe' il difetto segnalato.
 *
 * Non e' la lingua che l'utente legge: quella viene dai segmenti, resi alla lettura.
 */
const SNAPSHOT_LOCALE = 'it';

/** L'app i18n da cui vengono i testi dei messaggi di log. Copiata in gen/srv da mta.yaml. */
const COCKPIT_APP = 'marsplm-sap2plex';

/** Il separatore fra i segmenti di un messaggio composto: testa + code. */
const SEGMENT_SEPARATOR = ' — ';

// Cache dei bundle caricati, annidata per appName e locale.
const bundleCache = {};

/**
 * Carica e interpreta un file `.properties` di una app UI5.
 *
 * @param {string} locale codice lingua ('en', 'it', …)
 * @param {string} appName nome della cartella sotto `app/`
 * @returns {Object<string,string>} le coppie chiave/valore, `{}` se il file non si legge
 */
function bundle(locale, appName) {
  if (!bundleCache[appName]) bundleCache[appName] = {};
  if (bundleCache[appName][locale]) return bundleCache[appName][locale];

  const fileName = locale === 'en' ? 'i18n.properties' : `i18n_${locale}.properties`;
  // I DUE '..': vedi la nota in testa al file. Uno solo cercherebbe in `srv/app/`.
  const filePath = path.join(__dirname, '..', '..', 'app', appName, 'webapp', 'i18n', fileName);

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const messages = {};
    content.split('\n').forEach((raw) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const sep = line.indexOf('=');
      if (sep > 0) {
        messages[line.substring(0, sep).trim()] = line.substring(sep + 1).trim();
      }
    });
    bundleCache[appName][locale] = messages;
    return messages;
  } catch (err) {
    console.warn(`Warning: Could not load i18n file for app ${appName}, locale ${locale}: ${err.message}`);
    return {};
  }
}

/** Svuota la cache. Serve ai test, che scrivono bundle finti su disco. */
function resetCache() {
  for (const key of Object.keys(bundleCache)) delete bundleCache[key];
}

/**
 * La catena di bundle in cui cercare una chiave, dal piu' specifico al piu' generico.
 *
 * LA LINGUA BASE E' L'ANELLO CHE MANCAVA, e serve perche' un locale puo' arrivare con la regione.
 * `Accept-Language: it-IT` da' un locale `it_IT`, per cui il nome del file diventa
 * `i18n_it_IT.properties` — che nel progetto non esiste, e nessuno lo vuole. Senza questo passo si
 * ricadrebbe direttamente su 'en': un utente italiano leggerebbe l'inglese, e la causa sarebbe
 * l'intestazione del suo browser, cioe' l'ultimo posto in cui uno la cerca. E' la stessa catena dei
 * ResourceBundle di UI5.
 *
 * @param {string} locale
 * @returns {Array<string>} sempre almeno ['en'], senza ripetizioni
 */
function localeChain(locale) {
  const raw = String(locale || '').trim().replace(/-/g, '_');
  const out = [];
  if (raw) {
    out.push(raw);
    const base = raw.split('_')[0];
    if (base && base !== raw) out.push(base);
  }
  if (!out.includes('en')) out.push('en');
  return out;
}

/**
 * Il testo di UNA chiave, nella lingua chiesta.
 *
 * Catena di fallback: locale chiesto → lingua base (vedi `localeChain`) → 'en' → LA CHIAVE STESSA.
 * L'ultimo anello non e' elegante ed e' deliberato: una chiave a video dice quale chiave manca, un
 * testo vuoto non dice niente.
 *
 * @param {string} key chiave del bundle
 * @param {string} appName app da cui leggerla
 * @param {string} [locale] lingua; se assente, DEFAULT_LOCALE
 * @param {Array} [params] valori per i segnaposto {0}, {1}, …
 * @returns {string}
 */
function text(key, appName, locale, params) {
  const app = appName || COCKPIT_APP;
  const loc = locale || DEFAULT_LOCALE;

  let message;
  for (const candidate of localeChain(loc)) {
    message = bundle(candidate, app)[key];
    if (message) break;
  }
  if (!message) message = key;

  // La sostituzione e' GLOBALE (split/join): `String.replace` con una stringa sostituisce solo la
  // PRIMA occorrenza, e diversi messaggi ripetono lo stesso indice — per esempio l'unita' di misura
  // in "il lotto e' rimasto a {1} {2} invece di {3} {2}" (feature 0012). Con la sostituzione
  // singola le occorrenze successive uscivano come `{2}` a video.
  const list = Array.isArray(params) ? params : [];
  list.forEach((param, index) => {
    message = message.split(`{${index}}`).join(param === null || param === undefined ? '' : String(param));
  });

  // I file i18n sono bundle UI5: l'apostrofo e' RADDOPPIATO perche' li' i testi passano da
  // MessageFormat, dove `'` e' il carattere di escape. Il backend non usa MessageFormat, quindi
  // normalizza qui, DOPO la sostituzione (un parametro puo' contenere apostrofi).
  if (message.includes("''")) message = message.replace(/''/g, "'");

  return message;
}

/**
 * Rende una lista di SEGMENTI in una frase sola.
 *
 * Un messaggio di log e' composto: una testa piu' fino a tre code che compaiono solo quando c'e'
 * qualcosa da dichiarare. I segmenti hanno la forma di `srv/lib/logMessage.js` (`{ c, p }`) e qui
 * si uniscono con lo stesso separatore che il codice usava concatenando le stringhe, cosi' il testo
 * reso e' indistinguibile da quello di prima.
 *
 * Un segmento privo di codice si salta: e' cio' che arriva da un `pack`/`unpack` di dati sporchi, e
 * mostrare una riga vuota sarebbe peggio che non mostrarla.
 *
 * @param {Array<{c: string, p: Array}>} segments
 * @param {string} appName
 * @param {string} [locale]
 * @returns {string} '' se non c'e' niente da dire
 */
function render(segments, appName, locale) {
  const list = Array.isArray(segments) ? segments : [];
  const parts = [];
  for (const s of list) {
    if (!s || !s.c) continue;
    parts.push(text(s.c, appName, locale, s.p));
  }
  return parts.join(SEGMENT_SEPARATOR);
}

module.exports = {
  DEFAULT_LOCALE,
  SNAPSHOT_LOCALE,
  COCKPIT_APP,
  SEGMENT_SEPARATOR,
  bundle,
  resetCache,
  localeChain,
  text,
  render
};

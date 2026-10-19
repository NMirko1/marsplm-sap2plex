/**
 * [MATDOC-CONF] La finestra temporale delle letture Plex a watermark (feature 0021).
 *
 * FUNZIONI PURE: nessun `cds`, nessuna rete, nessun accesso all'orologio — `now` arriva da fuori.
 * È ciò che rende collaudabile senza sistemi esterni una regola che governa un flusso che parla
 * solo con sistemi esterni, come srv/lib/splitRules.js e srv/lib/plexJobSortRules.js.
 *
 * IL DIFETTO CHE CHIUDE, E PERCHE' ERA INVISIBILE
 * Prima, `beginDate` veniva da `MAX(EntryDate)` delle righe PERSISTITE e la lettura Plex, se
 * rispondeva non-2xx, restituiva un array vuoto. Le due cose insieme fanno un guasto muto: il job
 * non distingue «Plex non ha risposto» da «non c'era niente da leggere», il run chiude verde, e le
 * registrazioni di quella finestra rientrano solo se qualcuna di esse viene persistita più tardi.
 * Peggio: le registrazioni SALTATE non venivano persistite affatto, quindi `MAX(EntryDate)` poteva
 * scavalcarle e non tornavano mai più.
 *
 * Qui la fine della finestra si scrive SOLO se la lettura è riuscita davvero. Se fallisce, il
 * watermark resta dov'è e il run successivo riparte da lì: quattro run falliti e il quinto chiede
 * l'intera finestra accumulata. Non c'è nulla da recuperare a mano perché non si è perso nulla.
 *
 * L'AVVIO A FREDDO NON RISALE ALL'INIZIO DEI TEMPI
 * È il caso che rende pericoloso qualunque watermark: la prima esecuzione non ha un punto di
 * ripresa, e la scelta ovvia — «parti dal principio» — su una API che filtra per data significa
 * chiedere a Plex tutto lo storico e riversarlo in SAP come movimenti di magazzino. Il seme è
 * quindi `now − coldStartMinutes` (un'ora), e `fallbackFrom` può solo spostarlo IN AVANTI:
 *
 *   tabella vuota                    -> un'ora fa
 *   ultima registrazione di 3 giorni fa -> un'ora fa      (il tetto vince)
 *   ultima registrazione di 10 minuti fa -> 10 minuti fa  (la continuità vince)
 *
 * La seconda riga è il motivo per cui è un `max` e non un `??`: al primo run dopo il rilascio la
 * tabella NON è vuota, e riprendere da una riga vecchia sarebbe esattamente il ripescaggio che si
 * vuole evitare. La terza è il motivo per cui `fallbackFrom` esiste: fra due run ravvicinati non
 * si deve creare un buco.
 *
 * IL LOOKBACK, che sembra un dettaglio e non lo è. `beginDate` arretra di due minuti rispetto al
 * watermark perché l'orologio di Plex e quello del BTP non sono lo stesso: una registrazione
 * scritta a 16:14:59 e visibile un istante dopo la chiusura della finestra, senza sovrapposizione,
 * non verrebbe letta né allora né mai. Il costo è qualche riga riletta, che la dedup su
 * `PlexEntryId` scarta già; il costo dell'alternativa è una perdita silenziosa.
 *
 * IL TETTO, per il fermo lungo. Una finestra di giorni è una sola chiamata HTTP enorme, che va in
 * timeout o si fa troncare in silenzio — e un troncamento qui è di nuovo una perdita muta, perché
 * il watermark avanzerebbe come se avesse letto tutto. Oltre il tetto si legge il primo scaglione e
 * si avanza di quello: il run successivo prende il pezzo dopo, finché non si riallinea. Il recap
 * dichiara quanto arretrato resta, altrimenti «sto recuperando» e «sono fermo» si somigliano
 * troppo.
 *
 * LEVE (nessuna richiede un rilascio)
 *   PLEX_CONF_COLD_START_MINUTES  60   quanto indietro parte la PRIMA lettura
 *   PLEX_CONF_LOOKBACK_SECONDS   120   sovrapposizione fra due finestre consecutive
 *   PLEX_CONF_WINDOW_MAX_HOURS    24   ampiezza massima di una singola lettura
 * Perimetro completo: grep -rn "MATDOC-CONF"
 *
 * Collaudo: test/plexConfWindow.test.js
 */

'use strict';

// [LOG-MSG-I18N] Modulo puro anche questo: logMessage.js non dipende da cds ne' dalla rete, quindi
// importarlo non tocca la collaudabilita' (feature 0031).
const logMsg = require('./logMessage');

/** Difetto di programmazione: una finestra senza `now` non è calcolabile, e non si tira a indovinare. */
const MS_MIN = 60 * 1000;
const MS_HOUR = 60 * MS_MIN;

const DEFAULTS = Object.freeze({
  coldStartMinutes: 60,
  lookbackSeconds: 120,
  windowMaxHours: 24
});

/**
 * Configurazione effettiva: DEFAULTS <- variabili d'ambiente. FUNZIONE PURA rispetto ai suoi
 * argomenti; legge `process.env` una volta sola per chiamata, quindi il test la pilota passando
 * `env`.
 *
 * Un valore non numerico o <= 0 NON diventa zero: si torna al default. Un lookback a zero per un
 * refuso significherebbe perdere le registrazioni al confine, e un tetto a zero una finestra vuota
 * a ogni run — due modi silenziosi di non leggere niente.
 *
 * [ORDER-COMPLETE] IL PREFISSO DELLE LEVE E' UN PARAMETRO, e il default e' quello storico.
 * Dalla feature 0045 questo modulo serve DUE flussi a finestra — la consuntivazione (`PLEX_CONF_*`)
 * e i job completati (`PLEX_COMPLETE_*`) — e le loro finestre non hanno ragione di muoversi insieme:
 * la prima ha un tetto di 24 ore, la seconda di 2, perche' l'endpoint dei job non pagina e la
 * finestra piccola e' l'unica vera difesa dal troncamento. La seconda copia del modulo era
 * l'alternativa, ed e' il difetto che la 0035 e la 0040 esistevano per togliere (`pagedRead`).
 * Il default `'PLEX_CONF'` e' cio' che rende l'estrazione dimostrabile: test/plexConfWindow.test.js
 * passa NON MODIFICATO.
 *
 * @param {object} [env] sorgente delle variabili (default `process.env`)
 * @param {string} [prefix] prefisso delle tre leve, senza underscore finale
 * @returns {{coldStartMinutes:number, lookbackSeconds:number, windowMaxHours:number}}
 */
function readWindowConfig(env = process.env, prefix = 'PLEX_CONF') {
  const num = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const p = String(prefix || 'PLEX_CONF').replace(/_+$/, '');
  return {
    coldStartMinutes: num(`${p}_COLD_START_MINUTES`, DEFAULTS.coldStartMinutes),
    lookbackSeconds: num(`${p}_LOOKBACK_SECONDS`, DEFAULTS.lookbackSeconds),
    windowMaxHours: num(`${p}_WINDOW_MAX_HOURS`, DEFAULTS.windowMaxHours)
  };
}

/** Una data qualsiasi (Date | ISO string | ms) -> Date, oppure null se non è una data. */
function asDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Il SEME di una sorgente che non ha ancora un watermark. FUNZIONE PURA.
 *
 * `now − coldStartMinutes` è un TETTO, non un default: `fallbackFrom` può spostarlo solo in avanti.
 * Vedi la testata per i tre casi e per il motivo di ciascuno.
 *
 * @param {Date} now istante di lancio
 * @param {Date|string|null} fallbackFrom continuità disponibile (es. MAX(EntryDate) del plant)
 * @param {object} cfg da readWindowConfig
 * @returns {{seed: Date, from: string}} `from` dice CHI ha deciso, e finisce nel log
 */
function coldStartSeed(now, fallbackFrom, cfg) {
  const cap = new Date(now.getTime() - cfg.coldStartMinutes * MS_MIN);
  const prev = asDate(fallbackFrom);
  if (prev && prev.getTime() > cap.getTime()) {
    return { seed: prev, from: 'ultima registrazione salvata (più recente del tetto di avvio)' };
  }
  return {
    seed: cap,
    from: prev
      ? `tetto di avvio a freddo (${cfg.coldStartMinutes} min): l'ultima registrazione salvata è più vecchia e NON si ripesca`
      : `tetto di avvio a freddo (${cfg.coldStartMinutes} min): nessuna registrazione salvata`
  };
}

/**
 * La finestra da chiedere a Plex. FUNZIONE PURA: `now` arriva da fuori.
 *
 * @param {object} args
 * @param {{WindowEnd?: any}|null} args.watermark riga di ZJobReadWatermark, o null se assente
 * @param {Date} args.now istante di lancio
 * @param {Date|string|null} [args.fallbackFrom] continuità per il solo avvio a freddo
 * @param {object} [args.cfg] da readWindowConfig; se assente si legge l'ambiente
 * @returns {{beginDate: string, endDate: string, begin: Date, end: Date, coldStart: boolean,
 *            capped: boolean, backlogMinutes: number, seed: Date|null, reason: string}}
 *   `beginDate`/`endDate` sono ISO 8601 UTC, la forma che la Connect API vuole nella query string.
 *   `seed` è valorizzato SOLO all'avvio a freddo: è il valore con cui il chiamante deve creare la
 *   riga di watermark PRIMA di chiamare Plex (vedi la testata del job).
 */
function resolveWindow({ watermark, now, fallbackFrom = null, cfg = null } = {}) {
  const at = asDate(now);
  if (!at) throw new Error('resolveWindow: `now` è obbligatorio ed è un difetto di programmazione, non un dato mancante.');
  // [ORDER-COMPLETE] `cfg` SI PASSA SEMPRE, e questo ripiego e' per il solo flusso storico. Senza
  // `cfg` si rileggono le leve col prefisso di DEFAULT, cioe' `PLEX_CONF_*`: un secondo flusso a
  // finestra che omettesse `cfg` prenderebbe in silenzio la finestra della consuntivazione — nessun
  // errore, nessuna riga di log, e un tetto di 24 ore su un endpoint che non pagina.
  const c = cfg || readWindowConfig();

  const mark = watermark ? asDate(watermark.WindowEnd) : null;
  const coldStart = !mark;
  const { seed, from } = coldStart ? coldStartSeed(at, fallbackFrom, c) : { seed: null, from: '' };
  const anchor = mark || seed;

  // Il lookback si applica SEMPRE, anche al seme: due run ravvicinati si sovrappongono di due
  // minuti, e la prima lettura non fa eccezione.
  let begin = new Date(anchor.getTime() - c.lookbackSeconds * 1000);
  // Una finestra al contrario non si chiede: se il watermark è nel futuro (orologio spostato,
  // riga scritta a mano) si degrada a finestra vuota invece di mandare a Plex begin > end.
  if (begin.getTime() > at.getTime()) begin = new Date(at.getTime());

  const maxMs = c.windowMaxHours * MS_HOUR;
  const spanMs = at.getTime() - begin.getTime();
  const capped = spanMs > maxMs;
  const end = capped ? new Date(begin.getTime() + maxMs) : at;
  const backlogMinutes = capped ? Math.round((at.getTime() - end.getTime()) / MS_MIN) : 0;

  const reason = coldStart
    ? `avvio a freddo: ${from}`
    : (capped
      ? `ripresa dal watermark, finestra limitata a ${c.windowMaxHours}h: restano ${backlogMinutes} min di arretrato`
      : 'ripresa dal watermark');

  return {
    beginDate: begin.toISOString(),
    endDate: end.toISOString(),
    begin,
    end,
    coldStart,
    capped,
    backlogMinutes,
    seed,
    reason
  };
}

/**
 * Il testo per il recap quando una lettura NON è riuscita. FUNZIONE PURA.
 *
 * Dice tre cose e nessuna è ornamentale: che la finestra non è avanzata (cioè che non si è perso
 * nulla), da quanti run quella sorgente non risponde, e quanto arretrato si è accumulato. Senza la
 * terza, «è fallita una volta» e «è ferma da ieri» si leggono uguali.
 *
 * @param {object} args
 * @param {string} args.sourceCode
 * @param {number} args.failureCount letture consecutive fallite, DOPO l'incremento
 * @param {Date} args.now
 * @param {Date|string|null} args.windowEnd il watermark rimasto indietro
 * @param {string} [args.error]
 * @returns {string}
 */
function readFailureMessage({ sourceCode, failureCount, now, windowEnd, error = '' }) {
  const at = asDate(now);
  const mark = asDate(windowEnd);
  const backlog = at && mark ? Math.max(0, Math.round((at.getTime() - mark.getTime()) / MS_MIN)) : null;
  const parts = [`lettura ${sourceCode} non riuscita`];
  parts.push(`tentativo consecutivo n. ${failureCount}`);
  parts.push('finestra NON avanzata: le registrazioni saranno riprese dal prossimo run');
  if (backlog !== null) parts.push(`arretrato ${backlog} min`);
  if (error) parts.push(String(error));
  return parts.join(' · ');
}

/**
 * [LOG-MSG-I18N] Lo stesso messaggio, come SEGMENTI (feature 0031).
 *
 * Convive con `readFailureMessage` e non lo sostituisce, perche' i due finiscono in posti diversi:
 * il TESTO va in `ZJobReadWatermark.LastMessage`, che e' lo stato di una sorgente e si legge in
 * italiano dal supporto, i SEGMENTI vanno nella riga di recap, che si legge da schermata. Una
 * seconda sorgente per la stessa colonna sarebbe un errore; due colonne diverse no.
 *
 * L'arretrato e' un segmento suo: e' l'informazione che cresce a ogni run fallito, cioe' l'unica
 * che dice se il guasto sta diventando grave.
 */
function readFailureSegments({ sourceCode, failureCount, now, windowEnd, error = '' }) {
  const at = asDate(now);
  const mark = asDate(windowEnd);
  const backlog = at && mark ? Math.max(0, Math.round((at.getTime() - mark.getTime()) / MS_MIN)) : null;
  return [
    logMsg.seg('logConfReadFailed', sourceCode, failureCount),
    ...(backlog !== null ? [logMsg.seg('logConfReadBacklog', backlog)] : []),
    ...(error ? [logMsg.technical(String(error))] : [])
  ].filter(Boolean);
}

module.exports = {
  DEFAULTS,
  MS_MIN,
  MS_HOUR,
  readWindowConfig,
  asDate,
  coldStartSeed,
  resolveWindow,
  readFailureMessage,
  readFailureSegments
};

/**
 * [RUN-BLOCKED] Le due decisioni con cui un run dichiara com'e' andato: lo STATO della testata e
 * l'EXIT CODE dato al Job Scheduler. Puro: ne' `cds` ne' rete, test omonimo in test/.
 *
 * ------------------------------------------------------------------
 * PERCHE' STANNO QUI E NON DOVE VENGONO USATE
 * ------------------------------------------------------------------
 * Erano due decisioni scritte in due file — la cascata dello stato in srv/lib/jobSummary.js e
 * l'exit code in srv/jobs/lib/runJob.js — che parlano della stessa cosa e potevano divergere senza
 * che niente lo segnalasse: un run puo' benissimo chiudere 'E' ed uscire 0, ed e' esattamente il
 * difetto che questo modulo esiste per rendere impossibile. Sono qui insieme perche' la seconda si
 * legge solo accanto alla prima.
 *
 * ------------------------------------------------------------------
 * `blocked`: IL TERZO SEGNALE, E PERCHE' NON POTEVA ESSERE UN CONTATORE
 * ------------------------------------------------------------------
 * I contatori di `ZJobRunHDR` contano OGGETTI TRATTATI: e' l'invariante di DEC-39, e alimentarli con
 * una lettura caduta scriverebbe un numero falso nella tabella dei totali. Ma fino alla DEC-124 il
 * corollario era che una chiamata caduta non potesse in nessun modo far chiudere un run in errore:
 * `summary.scope({status:'E'})` coloriva la riga di recap e nient'altro, e dodici call site la
 * usavano CREDENDO di dichiarare un guasto — con i commenti che lo dicono («la lettura non riuscita
 * e' un GUASTO, non un difetto del dato: il run non deve chiudere 'S'»).
 *
 * `blocked` e' quel segnale, e sta accanto ai contatori senza esserne uno: vale per il RUN, non per
 * un oggetto. L'invariante di DEC-39 resta intera — `processed/ok/warning/failed` continuano a
 * contare oggetti — e cade solo la sua conseguenza, che non era l'invariante.
 *
 * ------------------------------------------------------------------
 * I TRE CONFINI, che sono la parte che si sbaglia
 * ------------------------------------------------------------------
 *  1. `exhausted` NON entra nell'exit code, e non e' una dimenticanza: un retry esaurito tingerebbe
 *     di rosso il job per sempre (0010 RB-14). Un guasto di trasporto invece ha un rimedio, e chi
 *     lo vede puo' agire.
 *  2. `degraded` (cioe' `scope()` con status 'W') NON entra nell'exit code: e' il troncamento al
 *     nostro tetto, il perimetro vuoto, il customizing assente — cose in cui NESSUNA chiamata e'
 *     caduta. Se degradasse, il rosso perderebbe significato nel giro di una settimana.
 *  3. `noScope` resta 'N' e resta exit 0: zero plant utilizzabili e' «niente da fare», non un
 *     guasto. Sta PRIMA di `blocked` nella cascata perche' senza plant non parte nessuna chiamata,
 *     quindi i due non possono essere veri insieme se non per un difetto — e in quel caso 'N' e'
 *     comunque la notizia piu' utile (fa gia' scattare i destinatari ON_FAILURE).
 */

'use strict';

/**
 * Lo stato della testata di un run. L'ORDINE dei rami e' il contratto: il primo che aggancia vince,
 * e i rami sono ordinati per quanto la notizia e' specifica, non per gravita'.
 *
 * @param {object}  o
 * @param {boolean} [o.fatal]     `fatal()` chiamata, o `main()` che ha lanciato
 * @param {boolean} [o.noScope]   `noScope()` chiamata: zero plant utilizzabili
 * @param {number}  [o.failed]    oggetti trattati e falliti (`record({status:'E'})`)
 * @param {number}  [o.warning]   oggetti trattati con attenzione
 * @param {number}  [o.exhausted] oggetti coi tentativi esauriti
 * @param {boolean} [o.degraded]  `scope()` degradante: perimetro ridotto, nessuna chiamata caduta
 * @param {boolean} [o.blocked]   [RUN-BLOCKED] almeno una chiamata verso un sistema esterno non ha
 *                                prodotto una risposta utilizzabile (DEC-124)
 * @returns {'E'|'N'|'W'|'S'}
 */
function runStatusOf({
  fatal = false, noScope = false, failed = 0, warning = 0, exhausted = 0,
  degraded = false, blocked = false
} = {}) {
  if (fatal) return 'E';
  if (noScope) return 'N';
  if (failed > 0 || blocked) return 'E';
  if (warning > 0 || exhausted > 0 || degraded) return 'W';
  return 'S';
}

/**
 * L'exit code del processo, che il padre traduce nel `success` dichiarato al Job Scheduler
 * (srv/lib/jobTriggerRules.js: `success = !timedOut && exitCode === 0`).
 *
 * NON si deriva dallo stato della testata, benche' oggi i due coincidano su ogni combinazione:
 * 'N' e' exit 0 ed e' l'unico caso in cui divergerebbero se un domani lo si volesse rosso. Tenerli
 * due funzioni rende quella scelta visibile invece che implicita in una mappa.
 *
 * @param {object}  o
 * @param {number}  [o.failed]  oggetti trattati e falliti
 * @param {boolean} [o.fatal]   errore fatale
 * @param {boolean} [o.blocked] [RUN-BLOCKED] almeno una chiamata caduta
 * @returns {0|1}
 */
function exitCodeOf({ failed = 0, fatal = false, blocked = false } = {}) {
  return (failed > 0 || fatal || blocked) ? 1 : 0;
}

module.exports = { runStatusOf, exitCodeOf };

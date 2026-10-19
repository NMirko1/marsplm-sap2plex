/**
 * Elenco canonico dei job batch che producono un recap di fine esecuzione.
 *
 * Fonte unica di verita' condivisa fra:
 *   - srv/cat-service.js       validazione di ZJobNotifyRecipient.JobCode / .NotifyMode
 *   - srv/lib/jobSummary.js    JobCode scritto su ZJobRunHDR
 *   - srv/lib/jobNotifier.js   etichetta del job nell'oggetto e nel corpo della mail
 *   - srv/jobs/*.js            runJob({ jobCode: ... })
 *
 * Deliberatamente NON e' un'entita' CDS con CSV di seed: sono 7 valori immutabili, il
 * JobCode non viene mai digitato dall'utente (e' implicito nella sezione della tab) e i
 * titoli delle sezioni devono venire da i18n per essere tradotti. Un'entita' costerebbe
 * .hdbtabledata + proiezione + cache, e ogni deploy HDI ri-importerebbe il CSV.
 *
 * Aggiungere un job = una riga in JOB_LABELS + una riga in JOB_FILES (srv/lib/jobTriggerRules.js)
 * + un'action in JobRunService + una riga in TRIGGERS (srv/cat-service.js) + uno script npm
 * + una sezione nel fragment JobNotifyTab + le chiavi i18n corrispondenti.
 * `test/jobTriggerRules.test.js` verifica che JOB_LABELS e JOB_FILES coincidano ESATTAMENTE:
 * aggiornarne una sola rompe il test, e non e' una scocciatura — e' cio' che impedisce a un job di
 * esistere per il recap e non per lo scheduler.
 */

'use strict';

/** Etichette leggibili, usate nell'oggetto della mail e nell'intestazione dei report. */
const JOB_LABELS = {
  MAT_SYNC: 'Sincronizzazione materiali',
  ROUTING_SYNC: 'Sincronizzazione cicli',
  PROD_ORDER: 'Creazione job di produzione su Plex',
  PROD_CONF: 'Consuntivazione ordini di produzione',
  // [ORDER-TECO] feature 0023: la chiusura tecnica fatta in SAP riportata sul job Plex.
  PROD_TECO: 'Chiusura tecnica ordini su Plex',
  // [ORDER-COMPLETE] feature 0045: il job Plex completato riportato come stato utente in SAP. E' il
  // verso opposto di PROD_TECO, ed e' il requisito W1-12 della BBP.
  ORDER_COMPLETE: 'Ordini completati su Plex, stato utente in SAP',
  // [ORDER-SCHEDULED] feature 0046: il gemello del precedente sull'altro estremo del ciclo — il job
  // pianificato in Plex riportato come stato utente in SAP. E' il requisito W1-11 della BBP.
  ORDER_SCHEDULED: 'Ordini pianificati su Plex, stato utente in SAP'
};

const JOB_CODES = new Set(Object.keys(JOB_LABELS));

/**
 * Condizione di invio, per destinatario.
 *   ALWAYS     - sempre, anche a zero errori
 *   ON_ERROR   - solo se il run ha almeno un record in errore o warning
 *   ON_FAILURE - solo se il job e' fallito (errore fatale, scope degradato, retry esauriti)
 */
const NOTIFY_MODES = new Set(['ALWAYS', 'ON_ERROR', 'ON_FAILURE']);

/**
 * Precedenza dei NotifyMode: piu' alto = piu' permissivo.
 * Serve perche' lo stesso indirizzo puo' comparire su piu' plant con modi diversi e la mail
 * e' UNA sola: senza un ordine totale la scelta dipenderebbe dall'ordine di lettura del DB.
 */
const NOTIFY_MODE_RANK = { ALWAYS: 3, ON_ERROR: 2, ON_FAILURE: 1 };

/** Stati ammessi su ZJobRunPOS.Status / ZJobRunHDR.Status. */
const REC_STATUS = new Set(['S', 'W', 'E', 'X']);

/**
 * Etichette degli stati di un run, per gli occhi di una persona.
 *
 * Vive qui e non accanto a chi le usa perche' i consumatori sono DUE e la stessa persona li legge
 * entrambi: il recap mail / CSV / PDF (srv/lib/jobNotifier.js) e il messaggio mandato al Job
 * Scheduler BTP alla fine di un run (srv/lib/jobTriggerRules.js, feature 0032). Due copie
 * divergerebbero, e la prima stesura della 0032 ne aveva gia' una incompleta: senza 'N' e 'X' il
 * messaggio allo scheduler diceva «stato non riconosciuto» proprio nei due casi — nessun lavoro da
 * fare, e retry esauriti — in cui contava di piu' capire cos'era successo.
 *
 * L'insieme e' piu' ampio di REC_STATUS: 'R' e 'N' esistono solo sulla TESTATA.
 */
const RUN_STATUS_LABELS = Object.freeze({
  S: 'OK',
  W: 'Warning',
  E: 'Errore',
  X: 'Errore permanente',
  R: 'in corso',
  N: 'nessun lavoro'
});

/** Plant segnaposto quando il plant di un record non e' risolvibile. */
const PLANT_NA = '#NA';

/** @returns {string} etichetta del job, o il codice stesso se sconosciuto. */
function jobLabel(jobCode) {
  return JOB_LABELS[jobCode] || jobCode || '(job sconosciuto)';
}

module.exports = {
  JOB_CODES,
  JOB_LABELS,
  NOTIFY_MODES,
  NOTIFY_MODE_RANK,
  REC_STATUS,
  RUN_STATUS_LABELS,
  PLANT_NA,
  jobLabel
};

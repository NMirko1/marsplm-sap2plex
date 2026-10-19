/**
 * [MATDOC-CLAIM] La prenotazione di un documento materiale prima di spedirlo (feature 0027).
 *
 * IL DANNO CHE QUESTO MODULO EVITA: merce scaricata DUE VOLTE in SAP, che nessuno riconcilia.
 *
 * `sendPendingDocuments` chiamava `postMaterialDoc` e SOLO DOPO aggiornava la riga. Due strade
 * portavano allo stesso duplicato:
 *
 *   1. MORTE DEL PROCESSO. Un OOM-kill o un SIGTERM fra la chiamata e l'aggiornamento lascia il
 *      documento 'E' con `RetryCount` invariato: il run successivo ripubblica lo stesso movimento.
 *      Su Cloud Foundry lo shutdown ha un budget di 8 secondi, quindi la finestra e' reale.
 *   2. RUN SOVRAPPOSTI. Nessun lock: uno scheduled che si accavalla a un `npm run
 *      job-prod-order-confirmation` selezionava gli STESSI documenti 'E' in due processi.
 *
 * DEC-60 copriva solo l'esito non conclusivo DICHIARATO DA SAP. Non copriva ne' la morte del
 * processo ne' la concorrenza, che sono le due vie per cui questo flusso duplicava davvero.
 *
 * SI PRENOTA PRIMA DI CHIAMARE, e il progetto ha gia' questo idioma due volte: `seedWatermark`
 * scrive prima della chiamata a Plex (DEC-58), e una testata di run rimasta in 'R' E' il marcatore
 * di un'esecuzione morta (srv/lib/jobSummary.js). Funziona per un fatto che il progetto ha
 * verificato e messo per iscritto: FUORI DA UN REQUEST CONTEXT OGNI `db.run` E' UNA
 * ROOT-TRANSACTION CHE CAP COMMITTA DA SOLA. Quindi la prenotazione e' committata PRIMA della
 * chiamata, e sopravvive al crash. Nessun `db.tx` attorno al run: jobSummary lo vieta, e qui non
 * serve.
 *
 * LA PRENOTAZIONE USA `Status`, NON UNA COLONNA NULLABLE, e la ragione e' un rischio concreto.
 * La forma naturale sarebbe `WHERE … AND InFlightAt IS NULL`, cioe' in CQL `where({ InFlightAt:
 * null })`. In tutto il repo NON esiste un precedente di quella forma: se CQN la rendesse `= NULL`
 * invece di `IS NULL`, la prenotazione non aggancerebbe MAI e il flusso tornerebbe a non registrare
 * niente — cioe' esattamente il difetto che la 0027 ha appena chiuso, per un'altra via. Con un
 * valore di stato la `where` e' un'uguaglianza normale e il dubbio non esiste.
 *
 *     Status:  'E'  ->  'P' (in volo)  ->  'S' | 'X' | 'E'
 *
 * Come effetto secondario i candidati, che si selezionano per `Status='E'`, non vedono nemmeno le
 * righe prenotate da un altro run: la concorrenza si risolve senza un lock.
 *
 * LA RIGA TROVATA IN VOLO SI TRATTA COME UN ESITO NON CONCLUSIVO. Una 'P' piu' vecchia della soglia
 * e' un run morto, e NON SAPPIAMO se SAP ha registrato: e' la stessa situazione di «SAP dichiara
 * riuscito senza numero documento», quindi la stessa regola di DEC-60 — 'X', nessun ritentativo,
 * verifica in MB51. Ritentare e' l'azione pericolosa.
 *
 * NIENTE RECUPERO AUTOMATICO, ed e' il prezzo dichiarato del disegno: per sapere se quel documento
 * e' stato registrato servirebbe una LETTURA dei documenti materiale per riferimento, e in questo
 * progetto non esiste — `ZMARS_MATERIAL_DOC_POST` e' di sola scrittura e nessun contratto ne
 * dichiara una di lettura.
 *
 * FUNZIONI PURE: nessun `cds`, nessuna rete, nessun orologio — `now` arriva da fuori. Le UPDATE le
 * fa il job; qui c'e' la soglia, la lettura del conteggio e le frasi.
 *
 * Collaudo: node test/matDocClaim.test.js · Perimetro: grep -rn "MATDOC-CLAIM"
 */

'use strict';

// [LOG-MSG-I18N] logMessage.js e' puro anch'esso — nessun cds, nessuna rete — quindi importarlo non
// tocca la collaudabilita' di questo modulo (feature 0031).
const logMsg = require('./logMessage');

/** Stato di una riga prenotata e in volo verso SAP. */
const STATUS_IN_FLIGHT = 'P';

/** Da quanti minuti una prenotazione e' considerata di un run morto. */
const STALE_MINUTES_DEFAULT = 15;

const MS_MIN = 60 * 1000;

/**
 * La soglia di staleness, dall'ambiente. FUNZIONE PURA rispetto ai suoi argomenti.
 *
 * Un valore assente, non numerico o `<= 0` ricade sul default e NON su zero: con zero ogni
 * prenotazione appena scritta risulterebbe stantia, e la raccolta parcheggerebbe come «run morto»
 * documenti che sono in volo in questo istante. E' la stessa direzione di `readWindowConfig`.
 */
function readStaleMinutes(env = process.env) {
  const raw = Number(env.MATDOC_INFLIGHT_STALE_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : STALE_MINUTES_DEFAULT;
}

/**
 * L'istante prima del quale una prenotazione e' di un run morto. FUNZIONE PURA.
 *
 * @param {Date} now
 * @param {number} [minutes]
 * @returns {string} ISO 8601 UTC
 */
function staleCutoff(now, minutes) {
  if (!(now instanceof Date) || isNaN(now.getTime())) {
    throw new Error('[MATDOC-CLAIM] staleCutoff senza `now`: e\' un difetto di programmazione');
  }
  const m = Number.isFinite(Number(minutes)) && Number(minutes) > 0
    ? Number(minutes) : STALE_MINUTES_DEFAULT;
  return new Date(now.getTime() - m * MS_MIN).toISOString();
}

/**
 * Quante righe ha toccato una UPDATE. FUNZIONE PURA.
 *
 * TOLLERA DUE FORME, e non e' pedanteria. Su `@sap/cds ^9` una UPDATE restituisce un NUMERO — e' la
 * forma su cui `deletePlant` conta gia' per le sue DELETE. Da cds 10 la forma diventa
 * `{ affected: n }`. Se questa funzione leggesse solo la prima, a un aggiornamento di cds ogni
 * prenotazione risulterebbe fallita, e il flusso smetterebbe di registrare IN SILENZIO: lo stesso
 * modo di rompersi che la 0027 e' nata per chiudere.
 *
 * Un valore che non si sa leggere torna `null`, non `0`: `0` significherebbe «nessuna riga toccata»,
 * cioe' una risposta, mentre qui non lo sappiamo — e chi chiama deve poter dichiarare la differenza.
 *
 * @param {number|object|null|undefined} result
 * @returns {number|null}
 */
function affectedRows(result) {
  if (typeof result === 'number') return Number.isFinite(result) ? result : null;
  if (result && typeof result === 'object') {
    const a = result.affected !== undefined ? result.affected : result.affectedRows;
    const n = Number(a);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * L'esito di una prenotazione, dal conteggio delle righe toccate. FUNZIONE PURA.
 *
 * @param {number|object|null} updateResult il valore restituito dalla UPDATE di prenotazione
 * @returns {{claimed: boolean, verdict: string, reason: string}}
 *   `verdict`: `CLAIMED` · `TAKEN` · `UNKNOWN`
 */
function claimVerdict(updateResult) {
  const n = affectedRows(updateResult);

  if (n === null) {
    // Non si prenota alla cieca: se non sappiamo quante righe abbiamo toccato non possiamo sapere
    // se la riga e' nostra, e spedirla comunque e' il duplicato che stiamo evitando.
    return {
      claimed: false,
      verdict: 'UNKNOWN',
      reason: 'la UPDATE di prenotazione non ha restituito un conteggio leggibile: non si spedisce '
        + 'alla cieca. Verificare la forma del risultato di UPDATE su questa versione di @sap/cds'
    };
  }
  if (n >= 1) {
    return { claimed: true, verdict: 'CLAIMED', reason: 'prenotata' };
  }
  // Zero righe: un altro run l'ha presa, oppure lo stato non e' piu' 'E'. Non e' un problema e non
  // si dichiara: dichiararlo riempirebbe il recap a ogni sovrapposizione, che e' legittima.
  return {
    claimed: false,
    verdict: 'TAKEN',
    reason: 'già presa da un altro run, o non più in stato da inviare'
  };
}

/**
 * La frase con cui si parcheggia una riga rimasta in volo. FUNZIONE PURA.
 *
 * Dice le tre cose che servono a chi la legge: che il movimento POTREBBE essere passato, dove
 * guardare, e che non verra' ritentato. Stessa sostanza del messaggio dell'esito non conclusivo di
 * `classifyFailure`, perche' e' la stessa situazione.
 *
 * DEVE STARE IN 255 CARATTERI, che e' la lunghezza di `MessageText`, e il collaudo lo verifica col
 * caso peggiore. La prima stesura ne occupava 332: il troncamento del chiamante avrebbe tagliato la
 * CODA, cioe' «verificare in MB51 e sbloccare a mano» — l'unica parte azionabile della frase. Per
 * questo l'azione sta ORA prima della spiegazione, e la soglia in minuti non c'e': vive nella leva,
 * e ripeterla su ogni riga costava lo spazio del rimedio (stessa lezione di approvedWcRules).
 */
function staleClaimMessage({ inFlightAt, inFlightRun } = {}) {
  const quando = inFlightAt ? String(inFlightAt) : '(istante ignoto)';
  const chi = inFlightRun ? `run ${inFlightRun}` : 'run';
  return `movimento POTREBBE essere passato: ${chi} morto dopo la chiamata a SAP del ${quando}. `
    + 'Verificare in MB51 e sbloccare a mano — non si ritenta, un secondo tentativo lo duplicherebbe';
}

/**
 * [LOG-MSG-I18N] Lo stesso messaggio, come SEGMENTI (feature 0031). FUNZIONE PURA.
 *
 * Un segmento solo, e non tre: la frase e' una catena di causa-rimedio — «potrebbe essere passato,
 * guarda in MB51, non si ritenta» — e spezzarla darebbe a `pack` la facolta' di scartare proprio il
 * rimedio, che e' l'unica parte azionabile. E' la stessa ragione per cui l'azione sta ORA prima
 * della spiegazione dentro il testo.
 *
 * `staleClaimMessage` resta e non e' un duplicato: e' la forma che va nella riga di log tecnica del
 * task, dove non c'e' nessuno a cui chiedere la lingua.
 */
function staleClaimSegments({ inFlightAt, inFlightRun } = {}) {
  const quando = inFlightAt ? String(inFlightAt) : '';
  const chi = inFlightRun ? String(inFlightRun) : '';
  return [logMsg.seg('logConfStaleClaim', chi, quando)];
}

module.exports = {
  STATUS_IN_FLIGHT,
  STALE_MINUTES_DEFAULT,
  readStaleMinutes,
  staleCutoff,
  affectedRows,
  claimVerdict,
  staleClaimMessage,
  staleClaimSegments
};

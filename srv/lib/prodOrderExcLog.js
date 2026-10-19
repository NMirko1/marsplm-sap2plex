// [ORDER-LOG-OP] Lo storico invii di un ordine, scritto da chiunque tocchi quell'ordine (0031).
//
// PERCHE' QUESTO MODULO ESISTE. Lo «Storico Invii» del dettaglio ordine e' il registro di tutto cio'
// che il sistema fa a un ordine, e fino alla 0031 ne conteneva una cosa sola: l'invio del job verso
// Plex. La chiusura tecnica e la consuntivazione — che sono operazioni su QUELLO stesso ordine, e la
// seconda ha effetti contabili — scrivevano altrove, su tabelle che nessuna schermata leggeva.
//
// Il writer stava dentro `writeMappingAndLog`, in srv/jobs/createPlexProductionOrders.js. I cinque
// job girano come PROCESSI SEPARATI: `closeTecoPlexJobs.js` e `postProdOrderConfirmation.js` possono
// fare `require` di un file, non entrare in un altro job. E' la stessa ragione per cui
// `resolveAutoAssignments` e' uscito in srv/lib/autoAssign.js e `getLocalizedMessage` in
// srv/lib/i18nMessages.js — e il rischio da sorvegliare e' sempre quello: non un import che non
// compila, ma la COPIA della stessa scrittura in tre punti, che divergono al primo campo aggiunto.
//
// COSA DECIDE QUESTO FILE, e va letto prima di cambiarlo:
//
//   1. `Operation` dice QUALE operazione ha prodotto la riga. Cinque valori, elencati in OPERATION;
//      senza, cinque nature diverse si somigliano tutte in lista.
//   2. LA TESTATA LA AGGIORNA SOLO L'INVIO DEL JOB (`updateHeader`), e questo NON e' cambiato.
//      Il seguito di questo punto invece SI', ed e' la sola cosa da sapere prima di rimetterlo
//      altrove: diceva che una futura colonna «Stato Invio» sulla lista ordini avrebbe dovuto dire
//      com'e' andato l'ultimo INVIO. Quel giorno e' arrivato con la 0049
//      ([LAST-LOG-WORST-DAY], DEC-126) e la scelta e' stata L'ALTRA — la lista mostra l'ultima cosa
//      fatta all'ordine, cioe' la riga PEGGIORE DEL GIORNO PIU' RECENTE fra tutte e otto le
//      operazioni, letta da `ZProdOrderExcLogPOS`. «L'ordine e' arrivato su Plex?» ha gia' una
//      risposta stabile (l'esistenza del job, che il dettaglio mostra); «c'e' qualcosa che non ha
//      funzionato su quest'ordine?» non ne aveva nessuna in lista.
//      Quindi `ZProdOrderExcLogHDR` e' di nuovo scritta e NON LETTA da nessuna schermata, com'era
//      prima della 0049: chi passasse `updateHeader` da un altro flusso non sposterebbe un semaforo
//      — ma cambierebbe il significato di quella testata, che resta «l'ultimo invio del job».
//   3. `ResponseStatus` e' lo stato dell'ultimo passo NON accessorio. I passi `aux: true` — le
//      letture di controllo, l'ordinamento della lista di lavoro — restano nella traccia ed escono
//      dal semaforo: un passo di contorno fallito non deve tingere di rosso un'operazione riuscita
//      (DEC-38).
//   4. IL MESSAGGIO E' UNA LISTA DI SEGMENTI, non una stringa. Le righe che arrivano qui finiscono
//      in una colonna che si rende nella lingua di chi guarda (feature 0029): un testo libero vi
//      entrerebbe nella lingua di chi ha scritto la riga — l'italiano dei job, per chiunque. Una
//      stringa passata per errore non fa sparire la riga ma viene MARCATA `logMsgVerbatim`, cosi' la
//      lacuna ha il suo grep e non resta invisibile.
//
// La connessione arriva DA FUORI e il modulo non importa `cds`: usa i costruttori CQL globali, che
// e' lo stile dei suoi pari in srv/lib (confPostingConfig, plexCycleAllocation, plexMatDictionary) e
// che dentro la CAP runtime ci sono sempre. Nel test li installa un `require('@sap/cds')`. Si
// collauda con `node test/prodOrderExcLog.test.js`.

'use strict';

const logMsg = require('./logMessage');
const i18nMessages = require('./i18nMessages');

const NS = 'avvaleplm.marsplm.sap2plex';
// FQN come stringhe: `db.entities()` e' deprecato e non e' invocabile in contesto job standalone.
const E_LOG_HDR = `${NS}.ZProdOrderExcLogHDR`;
const E_LOG_POS = `${NS}.ZProdOrderExcLogPOS`;

/**
 * Le operazioni che possono comparire nello storico di un ordine.
 *
 * Sono CODICI sul database e testo tradotto a schermo: l'etichetta sta nei bundle i18n del cockpit
 * (`orderOp<Codice>`), perche' un codice a video sarebbe la stessa chiave grezza che i test dei
 * bundle esistono per impedire.
 */
const OPERATION = Object.freeze({
  JOB: 'JOB',        // invio o aggiornamento del job su Plex
  SPLIT: 'SPLIT',    // spacchettamento in pacchetti
  TECO: 'TECO',      // chiusura tecnica riportata su Plex
  MATDOC: 'MATDOC',  // documento materiale registrato in SAP (261 / 101 / 551)
  CONF: 'CONF',      // conferma d'ordine registrata in SAP
  // [ORDER-QTY-SYNC] riallineamento della sola QUANTITA' del lotto principale (feature 0033).
  //
  // PERCHE' NON E' `JOB`, benche' finisca sullo stesso `PUT /scheduling/v1/jobs/{id}`. Un invio
  // porta su Plex l'ordine intero — testata, distinta, operazioni, ordinamento — e la testata dello
  // storico deve continuare a dire com'e' andato l'ULTIMO INVIO (punto 2 qui sopra). Un
  // riallineamento tocca un campo solo e non passa da `updateHeader`: se un giorno la lista ordini
  // prendesse la colonna «Stato Invio», un aggiornamento di quantita' non deve rispondere alla
  // domanda «l'ordine e' arrivato su Plex?» in silenzio. E' la stessa distinzione per cui `SPLIT`
  // e' un codice a se' pur essendo anch'esso un invio verso Plex.
  QTY: 'QTY',
  // [ORDER-COMPLETE] [ORDER-SCHEDULED] I DUE STATI UTENTE portati in SAP da uno stato del job Plex
  // (feature 0045 e 0046).
  //
  // Sono le uniche operazioni dello storico che vanno nella direzione PLEX -> SAP senza produrre un
  // documento: `MATDOC` e `CONF` scrivono in SAP e hanno effetti contabili, queste impostano uno
  // stato informativo.
  //
  // DUE CODICI E NON UNO, e la 0045 ne aveva scritto uno chiamandolo `STATUS`. Era chiaro finche'
  // era solo: con due stati utente «STATUS» non dice QUALE, e nella scheda dell'ordine la
  // differenza fra «dichiarato finito» e «dichiarato pianificato» e' proprio quello che si va a
  // cercare. Il rinomino e' costato cinque righe perche' fatto prima che esistessero dati in
  // produzione; farlo dopo avrebbe richiesto una migrazione di valori persistiti.
  //
  // Per entrambe, `updateHeader` NON si passa: «Stato Invio» deve continuare a rispondere alla
  // domanda «l'ordine e' arrivato su Plex?» (DEC-96).
  COMPLETED: 'COMPLETED',
  SCHEDULED: 'SCHEDULED'
});

/** L'operazione delle righe scritte prima della 0031: allora scriveva solo l'invio del job. */
const DEFAULT_OPERATION = OPERATION.JOB;

/** Il tetto di `Message`. sqlite lo ignora, HANA lo impone e farebbe fallire l'INSERT. */
const MESSAGE_MAX = 255;

/** Tronca alla lunghezza della colonna. null-safe. */
const cut = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

/**
 * Testo e JSON di un messaggio, dalla stessa sorgente.
 *
 * Gemella di `messageOf` in srv/lib/jobSummary.js, e per la stessa ragione: i segmenti sono la
 * verita' e il testo lo snapshot derivato da loro. Una seconda sorgente per la stessa colonna e' il
 * modo in cui le due si disallineano.
 *
 * @param {Array} segments forma giusta
 * @param {string} [message] ripiego per prosa non ancora convertita, avvolta in `verbatim`
 */
function messageColumns(segments, message) {
  const segs = logMsg.normalize(segments);
  if (segs.length) {
    const text = i18nMessages.render(segs, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
    return { Message: cut(text, MESSAGE_MAX), MessageJson: logMsg.pack(segs) };
  }
  if (message === null || message === undefined || message === '') {
    return { Message: null, MessageJson: logMsg.EMPTY };
  }
  console.warn('>>> [ORDER-LOG-OP] messaggio passato come testo e non come segmenti: resta in '
    + 'italiano per chiunque lo legga (grep -rn "logMsgVerbatim").');
  return {
    Message: cut(message, MESSAGE_MAX),
    MessageJson: logMsg.pack([logMsg.verbatim(message)])
  };
}

/**
 * Le due proiezioni di una sequenza di passi, e il semaforo HTTP.
 *
 * Un'operazione su un ordine e' N chiamate — la creazione job ne fa otto, un tentativo di chiusura
 * fino a quattro, una registrazione una — e la forma e' sempre la stessa: un array per la richiesta,
 * uno per la risposta, allineati per posizione.
 *
 * @param {Array<{step, request, status, response, aux?}>} steps
 */
function serializeSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  // I passi ACCESSORI restano nella traccia ma non nel semaforo (DEC-38).
  const main = list.filter((s) => s && !s.aux);
  return {
    RequestJson: JSON.stringify(list.map((s) => ({ step: s.step, request: s.request }))),
    ResponseJson: JSON.stringify(
      list.map((s) => ({ step: s.step, status: s.status, response: s.response }))
    ),
    ResponseStatus: main.length ? main[main.length - 1].status : null
  };
}

/**
 * Aggiunge una riga allo storico invii di un ordine.
 *
 * NON LANCIA: e' una scrittura di log, e in tutto il progetto un log che non si scrive non deve
 * fermare l'operazione che descrive — a maggior ragione qui, dove l'operazione (un job chiuso su
 * Plex, un movimento registrato in SAP) e' GIA' avvenuta e farla ritentare sarebbe il danno.
 *
 * @param {object} db connessione (arriva da fuori: questo modulo non conosce `cds`)
 * @param {object} args
 * @param {string} args.order numero d'ordine SAP
 * @param {string} args.operation uno di OPERATION
 * @param {'S'|'E'|'W'} args.status
 * @param {Array} [args.segments] il messaggio, come segmenti
 * @param {string} [args.message] ripiego dichiarato
 * @param {Array} [args.steps] i passi, per i due JSON e per il semaforo
 * @param {boolean} [args.updateHeader] `true` SOLO per l'invio del job: vedi la testata del file
 * @returns {Promise<number|null>} il Counter scritto, per il `LogRef` del recap; `null` se non si e'
 *          potuto scrivere
 */
async function appendProdOrderLog(db, {
  order, operation, status, segments, message, steps, updateHeader = false
} = {}) {
  // Il `trim` non e' cosmetico: senza, un ordine di soli spazi passa il controllo qui sotto e finisce
  // in chiave come `'   '`, cioe' una riga di storico attaccata a un ordine che non esiste.
  const key = cut(String(order === null || order === undefined ? '' : order).trim(), 12);
  if (!key) {
    // Senza ordine non c'e' uno storico in cui scrivere, ed e' un caso vero e previsto: lo scarto di
    // un pezzo gia' versato non cita nessun ordine (DEC-91). Chi chiama lo dichiara nel recap.
    return null;
  }
  try {
    const now = new Date();
    const cols = messageColumns(segments, message);
    const last = await db.run(
      SELECT.one.from(E_LOG_POS).columns('Counter')
        .where({ ManufacturingOrder: key }).orderBy('Counter desc')
    );
    const counter = (last?.Counter || 0) + 1;

    await db.run(INSERT.into(E_LOG_POS).entries({
      ManufacturingOrder: key,
      Counter: counter,
      Operation: cut(operation, 20) || DEFAULT_OPERATION,
      SentDate: now.toISOString().split('T')[0],
      SentTime: now.toTimeString().split(' ')[0],
      Status: status,
      ...cols,
      ...serializeSteps(steps)
    }));

    if (updateHeader) {
      const hdr = {
        Counter: counter,
        SentDate: now.toISOString().split('T')[0],
        SentTime: now.toTimeString().split(' ')[0],
        Status: status,
        ...cols
      };
      const existing = await db.run(SELECT.one.from(E_LOG_HDR).where({ ManufacturingOrder: key }));
      if (existing) await db.run(UPDATE(E_LOG_HDR).set(hdr).where({ ManufacturingOrder: key }));
      else await db.run(INSERT.into(E_LOG_HDR).entries({ ManufacturingOrder: key, ...hdr }));
    }

    return counter;
  } catch (e) {
    console.error(`>>> [ORDER-LOG-OP] storico non scritto per l'ordine ${key} `
      + `(${operation}): ${e.message}`);
    return null;
  }
}

/** Il puntatore che il recap dei job mette in `ZJobRunPOS.LogRef`. */
function logRefFor(order, counter) {
  return counter ? `ZProdOrderExcLogPOS/${order}/${counter}` : null;
}

module.exports = {
  OPERATION,
  DEFAULT_OPERATION,
  MESSAGE_MAX,
  E_LOG_HDR,
  E_LOG_POS,
  messageColumns,
  serializeSteps,
  appendProdOrderLog,
  logRefFor
};

/**
 * [ORDER-MAP-JOB] Il dizionario dei job si scrive solo se un job su Plex ESISTE.
 *
 * PERCHE' ESISTE QUESTO MODULO. `ZProdOrderPlexMapping` e' il dizionario dei lotti, non il log:
 * dice quali ordini SAP hanno un job su Plex e con che id. Ma `writeMappingAndLog` faceva l'upsert
 * della riga dopo OGNI esito, compreso ogni `return outcome('E', ...)` che esce prima di qualunque
 * chiamata verso Plex — il gate del ciclo vuoto, la part non trovata, la lettura di SAP caduta.
 * La riga nasceva con `Status: 'E'` e `PlexJobId: null`, e da li' in poi due punti del progetto
 * leggevano «esiste una riga» come «l'ordine e' gia' uscito verso Plex»: la striscia «L'ordine e'
 * gia' stato inviato a Plex» sul dettaglio, e il gate che spegne «Rimuovi» sui componenti.
 *
 * Nel frattempo il job notturno riciclava lo stesso ordine, perche' il suo delta filtra
 * `Status: 'S'`: la domanda giusta era gia' posta in un punto del repo e sbagliata in altri due.
 *
 * IL VERDETTO E' PURO PERCHE' HA TRE INGRESSI E SBAGLIARNE UNO NON DA' NESSUN ERRORE. Sbagliare
 * in senso stretto perde il lotto — un job creato su Plex di cui non si scrive la riga e' un job
 * che nessun flusso ritrovera' piu' (la consuntivazione risolve l'ordine da `PlexJobId`, e il TECO
 * cerca i lotti da qui). Sbagliare in senso largo rimette il difetto. Nessuno dei due si vede.
 *
 * NON E' LA REGOLA DI «GIA' INVIATO». Quella e' `isAlreadySent` in orderCompRemovalRules.js e
 * guarda le righe LETTE; questa decide se la riga si SCRIVE. Sono due lati dello stesso fatto —
 * `PlexJobId` valorizzato significa «un job esiste» — e restano due funzioni perche' una risponde
 * a chi scrive e l'altra a chi legge.
 *
 * Test: `node test/orderMappingWrite.test.js`.
 */

'use strict';

/**
 * Si scrive la riga di dizionario per questo lotto?
 *
 * I tre rami, e perche' sono tre:
 *
 *  1. `jobId` — il job e' noto adesso. E' il caso normale, sia in creazione sia su un job che
 *     esisteva gia'.
 *
 *  2. `jobCreated` — la `POST /scheduling/v1/jobs` ha risposto ok ma il corpo non portava `id`.
 *     IL JOB ESISTE e non ne sappiamo l'id: «non lo so» non e' «non c'e'» (DEC-80), e saltare la
 *     riga qui dentro perderebbe il lotto. E' l'unico ramo che non si vede dai dati: senza un
 *     marcatore messo dove la condizione si verifica, quel caso arriva qui indistinguibile da un
 *     rifiuto di Plex.
 *
 *  3. `existingJobId` — la riga c'e' gia' e porta un id. Il tentativo di oggi e' fallito, ma il
 *     job di ieri esiste ancora: non aggiornare la riga significherebbe lasciarla con lo stato di
 *     un invio vecchio, e su quella riga poggiano il TECO e il riallineamento quantita'.
 *
 * @param {object} o
 * @param {string} [o.jobId] id del job Plex noto in questo giro (`plex.jobId`)
 * @param {boolean} [o.jobCreated] la POST di creazione ha risposto ok (anche senza id nel corpo)
 * @param {string} [o.existingJobId] `PlexJobId` gia' scritto sulla riga di dizionario
 * @returns {boolean}
 */
function shouldWriteMapping(o) {
  const oIn = o || {};
  return !!(nonEmpty(oIn.jobId) || oIn.jobCreated === true || nonEmpty(oIn.existingJobId));
}

/**
 * Una stringa che porta qualcosa.
 *
 * `PlexJobId` e' `String(36)` e nullable: arriva `null` dal database, `undefined` da un `plex`
 * costruito a mano, e `''` da una riga scritta da un ramo che lo ha azzerato. Le tre forme
 * significano tutte «nessun id», e trattarne una sola come vuota lascerebbe passare le altre due.
 *
 * @param {*} v
 * @returns {boolean}
 */
function nonEmpty(v) {
  return typeof v === 'string' ? v.trim() !== '' : !!v;
}

module.exports = { shouldWriteMapping, nonEmpty };

/**
 * Collettore del riepilogo di fine job, condiviso da tutti i job batch.
 *
 * Raccoglie per ogni record trattato esito + messaggio breve, li persiste su
 * ZJobRunHDR / ZJobRunPOS, e alla fine delega a srv/lib/jobNotifier.js l'invio del recap.
 *
 * ------------------------------------------------------------------
 * PERCHE' NON C'E' NESSUNA TRANSAZIONE A LIVELLO DI RUN
 * ------------------------------------------------------------------
 * Fuori da un request context ogni `db.run(...)` e' una root-tx che CAP committa da sola
 * (srv-dispatch -> cds.Service.tx -> commit/rollback per statement). Verificato: dopo 3
 * INSERT committati, uno statement che fallisce rolla back SOLO se stesso e le 3 righe
 * precedenti sopravvivono.
 * Ne segue la sequenza di sopravvivenza al crash:
 *   1) HDR scritto e committato SUBITO con Status='R';
 *   2) POS flushate e committate ogni PLEX_SUMMARY_FLUSH_SIZE righe, mai bufferizzate fino
 *      alla fine;
 *   3) UPDATE finale dell'HDR in try/catch, solo log;
 *   4) una riga 'R' con FinishedAt NULL E' il marcatore di crash / OOM-kill.
 *
 * Quindi, e sono errori facili da introdurre:
 *   - MAI `db.tx(async tx => { tutto il run })`: perderebbe esattamente il riepilogo del
 *     fallimento che deve documentare;
 *   - MAI un secondo `cds.connect.to('db')` sperando in una connessione fresca: e' il
 *     singleton cached e si aggancia alla stessa tx;
 *   - MAI chiamare record()/flush() DENTRO un'action CAP invocata dal job
 *     (plex.send('sendProductToPlex'), routingSrv.send('syncRoutingPlexCycle')): la' esiste
 *     un request context e un req.error(500) rollerebbe back anche le righe di log.
 *     Si registra sempre dal loop del job, fuori dalla .send().
 *
 * TRONCAMENTO OBBLIGATORIO: sqlite ignora NVARCHAR(n), HANA lo impone, e poiche' un
 * INSERT .entries() e' all-or-nothing un solo Message troppo lungo farebbe fallire l'intero
 * blocco di 500 righe. record() tronca ogni stringa alla lunghezza della colonna.
 *
 * ------------------------------------------------------------------
 * [LOG-MSG-I18N] IL MESSAGGIO E' UNA LISTA DI SEGMENTI (feature 0031)
 * ------------------------------------------------------------------
 * La 0029 ha reso i messaggi degli storici di invio traducibili ALLA LETTURA e dichiarava il
 * recap dei job fuori perimetro: qui rientra. `record`, `scope`, `note`, `fatal` e `noScope`
 * vogliono `segments` — `[{c: chiaveI18n, p: [parametri]}]`, costruiti con srv/lib/logMessage.js —
 * e la colonna `Message` si DERIVA da quelli, resa in italiano (SNAPSHOT_LOCALE) perche' e' cio'
 * che finisce nel CSV e nel PDF allegati alla mail. Chi guarda la schermata legge invece la propria
 * lingua, resa da `MessageJson` alla lettura.
 *
 * Un chiamante puo' ancora passare `message` come stringa, e NON e' una scorciatoia ammessa: il
 * testo viene avvolto in `logMsg.verbatim()`, cioe' marcato come lacuna dichiarata, e la cosa viene
 * segnalata a video una volta per canale. Senza questo ripiego un call site dimenticato scriverebbe
 * una riga di recap VUOTA — peggio di una riga non tradotta — e con un'accettazione silenziosa
 * resterebbe invisibile per sempre. Perimetro delle lacune: `grep -rn "logMsgVerbatim"`.
 */

'use strict';

const cds = require('@sap/cds');
const { PLANT_NA, REC_STATUS, jobLabel } = require('./jobCodes');
// [RUN-BLOCKED] Lo stato del run e l'exit code sono UNA decisione sola in due funzioni pure, e non
// vivono qui: srv/jobs/lib/runJob.js legge la seconda, e due copie divergerebbero (DEC-124).
const runStatus = require('./jobRunStatusRules');
const logMsg = require('./logMessage');
const i18nMessages = require('./i18nMessages');

const NS = 'avvaleplm.marsplm.sap2plex';
// FQN come stringhe: db.entities() e' deprecato (rimozione prevista in cds^10). Attenzione,
// un FQN sbagliato NON fallisce a livello di modello - cade nel percorso senza modello, dove
// UUID fill-in e conversione tipi sono saltati, e fallisce solo sul DB. Da qui l'assert in runJob.
const E_RUN_HDR = `${NS}.ZJobRunHDR`;
const E_RUN_POS = `${NS}.ZJobRunPOS`;
const E_RUN_MAIL = `${NS}.ZJobRunMail`;
const E_RECIPIENT = `${NS}.ZJobNotifyRecipient`;

const num = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

const FLUSH_SIZE = num(process.env.PLEX_SUMMARY_FLUSH_SIZE, 500);
// Quali status diventano righe POS. In un primo carico massivo conviene 'EWX' per non
// scrivere decine di migliaia di righe di successo.
const KEEP_STATUS = (process.env.PLEX_SUMMARY_KEEP_STATUS || 'SWEX').toUpperCase();
// Oltre questa soglia si registrano solo le righe non-'S', e l'HDR riporta la nota.
const MAX_POS = num(process.env.PLEX_SUMMARY_MAX_POS, 20000);

/** Tronca alla lunghezza della colonna. null-safe. */
const cut = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

/** Canali per cui la lacuna e' gia' stata segnalata: il warn serve una volta, non a ogni riga. */
const warnedVerbatim = new Set();

/**
 * [LOG-MSG-I18N] Riduce a una forma sola cio' che un chiamante passa come messaggio.
 *
 * Restituisce SEMPRE la coppia {segments, text}: i segmenti sono la verita' e il testo lo snapshot
 * derivato da loro. Una seconda sorgente per la stessa colonna e' il modo in cui le due si
 * disallineano (e' la nota di writeMappingAndLog nel job ordini, e vale identica qui).
 *
 * @param {Array} segments forma giusta
 * @param {string} [message] ripiego: prosa non ancora convertita, avvolta in `verbatim`
 * @param {string} where nome del canale, per il warn
 */
function messageOf(segments, message, where) {
  const segs = logMsg.normalize(segments);
  if (segs.length) {
    const rendered = i18nMessages.render(segs, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
    return { segments: segs, text: cut(rendered, 255) };
  }
  if (message === null || message === undefined || message === '') {
    return { segments: [], text: null };
  }
  if (!warnedVerbatim.has(where)) {
    warnedVerbatim.add(where);
    console.warn(
      `>>> [LOG-MSG-I18N] ${where}(): messaggio passato come testo e non come segmenti. ` +
      'Resta in italiano per chiunque lo legga (grep -rn "logMsgVerbatim").'
    );
  }
  return { segments: logMsg.normalize([logMsg.verbatim(message)]), text: cut(message, 255) };
}

/**
 * INSERT a blocchi. Un INSERT .entries() e' UNA statement con UN parametro JSON su entrambi
 * i dialetti (sqlite json_each, HANA JSON_TABLE) quindi non c'e' limite di parametri: 500 e'
 * una scelta di memoria e di raggio d'azione dell'errore.
 * Poiche' la statement e' all-or-nothing, al fallimento si ritenta riga per riga (si perde 1
 * riga invece di 500) e non si ri-inserisce mai un blocco andato a buon fine.
 */
async function insertChunked(db, entity, rows, size = FLUSH_SIZE) {
  let written = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    if (!chunk.length) continue;
    try {
      await db.run(INSERT.into(entity).entries(chunk));
      written += chunk.length;
    } catch (e) {
      console.error(`>>> [SUMMARY] blocco ${entity} (${chunk.length} righe) fallito: ${e.message}`);
      for (const r of chunk) {
        try {
          await db.run(INSERT.into(entity).entries([r]));
          written += 1;
        } catch (e2) {
          console.error(`>>> [SUMMARY] riga scartata: ${e2.message}`);
        }
      }
    }
  }
  return written;
}

/**
 * Crea il collettore e scrive subito la riga ZJobRunHDR in stato 'R'.
 *
 * @param {string} jobCode
 * @param {{db: object, runId?: string}} ctx
 * @returns {Promise<object>} il Summary
 */
async function createJobSummary(jobCode, { db, runId } = {}) {
  const id = runId || cds.utils.uuid();
  const startedAt = new Date().toISOString();

  const totals = { processed: 0, ok: 0, warning: 0, failed: 0, exhausted: 0, skipped: 0 };
  const notes = [];
  const plants = new Set();      // plant toccati dal run (per gli allegati)
  let counter = 0;               // progressivo POS, in memoria
  let buffer = [];
  let posWritten = 0;
  let posDropped = 0;            // righe non registrate per superamento di MAX_POS
  let flushFailed = false;       // il CSV mostrera' meno righe dei contatori
  let fatalMessage = null;
  let fatalSegments = [];        // [LOG-MSG-I18N] la forma strutturata di fatalMessage
  let degraded = false;          // scope ridotto: HDR non puo' essere 'S'
  // [RUN-BLOCKED] Almeno una chiamata verso un sistema esterno non ha prodotto una risposta
  // utilizzabile: HDR 'E' ed exit 1, contatori degli oggetti INVARIATI (DEC-124). Il numero serve
  // alla nota di testata, perche' con `TotalFailed` a zero un 'E' senza spiegazione e' un enigma.
  let blocked = 0;
  // [RUN-BLOCKED] L'identita' della PRIMA chiamata caduta. Il conteggio dice QUANTE sono, il nome
  // dice QUAL E': due informazioni diverse, e nominarle tutte non entrerebbe in 255 caratteri.
  // Senza questo, il dato esisteva solo nella riga POS — che il messaggio verso lo scheduler e il
  // corpo della mail non guardano — e per sapere quale chiamata fosse serviva `cf logs`.
  let blockedFirst = null;
  let noScopeFlag = false;
  // [RUN-BLOCKED] Il segmento di `noScope()` NON entra in `notes`: il suo posto e' nel blocco di
  // verdetto che `finish()` compone, davanti ai contatori, non in mezzo alle note dei job.
  let noScopeSegment = null;

  /**
   * [RUN-BLOCKED] La nota che spiega un run rosso, con il nome della prima chiamata caduta quando
   * lo si conosce.
   *
   * DUE CHIAVI E NON UNA CON UN PARAMETRO IN PIU'. `MessageJson` si rende ALLA LETTURA (DEC-92):
   * portare `logRunBlocked` da uno a tre parametri farebbe rendere «(la prima: undefined, plant
   * undefined)» su ogni riga storica gia' persistita. E una chiave a tre parametri chiamata con il
   * primo vuoto renderebbe «(la prima: , plant 07)»: la lacuna si dichiara scegliendo la chiave che
   * non promette un nome, non riempiendola di vuoto.
   */
  const blockedSegment = () => (blockedFirst && blockedFirst.objectKey
    ? logMsg.seg('logRunBlockedNamed', blocked, blockedFirst.objectKey, blockedFirst.plant)
    : logMsg.seg('logRunBlocked', blocked));
  let recipients = null;         // precaricati: la mail parte anche se il DB cade dopo
  // Catena delle flush asincrone innescate da record(), che e' sincrona: si accodano qui e
  // si attendono una volta sola in finish().
  let pendingFlush = Promise.resolve();

  await db.run(INSERT.into(E_RUN_HDR).entries({
    RunId: id, JobCode: jobCode, StartedAt: startedAt, FinishedAt: null, Status: 'R',
    TotalProcessed: 0, TotalOk: 0, TotalWarning: 0, TotalFailed: 0,
    TotalExhausted: 0, TotalSkipped: 0,
    Message: null, MessageJson: null, FatalMessage: null, FatalMessageJson: null,
    MailStatus: 'N', MailMessage: null
  }));
  console.log(`>>> [SUMMARY] run ${id} (${jobLabel(jobCode)}) avviato`);

  async function flush() {
    if (!buffer.length) return;
    const pending = buffer;
    buffer = [];
    const written = await insertChunked(db, E_RUN_POS, pending);
    posWritten += written;
    if (written < pending.length) flushFailed = true;
  }

  function bumpTotals(status) {
    totals.processed += 1;
    if (status === 'S') totals.ok += 1;
    else if (status === 'W') totals.warning += 1;
    else if (status === 'X') totals.exhausted += 1;
    else totals.failed += 1;
  }

  const summary = {
    runId: id,
    jobCode,

    /**
     * Registra un record trattato. Sincrona: bufferizza e flusha da sola al raggiungimento
     * della soglia, quindi il chiamante non deve await-are ogni riga. Da chiamare accanto
     * al console.log/error esistente, non al posto suo.
     *
     * @param {Array} [segments] il messaggio, come lista di segmenti i18n (forma giusta)
     * @param {string} [message] ripiego per prosa non ancora convertita: vedi `messageOf`
     */
    record({ plant, objectType, objectKey, objectKey2, status, segments, message, logRef } = {}) {
      const st = REC_STATUS.has(status) ? status : 'E';
      const pl = cut(plant, 4) || PLANT_NA;
      bumpTotals(st);
      plants.add(pl);

      if (KEEP_STATUS.indexOf(st) < 0) return;
      // Oltre il tetto si tengono solo le anomalie: sono quelle che il destinatario deve vedere.
      if (posWritten + buffer.length >= MAX_POS && st === 'S') { posDropped += 1; return; }

      const m = messageOf(segments, message, 'record');
      buffer.push({
        RunId: id,
        Counter: ++counter,
        Plant: pl,
        ObjectType: cut(objectType, 20),
        ObjectKey: cut(objectKey, 150),
        ObjectKey2: cut(objectKey2, 150),
        Status: st,
        Message: m.text,
        MessageJson: logMsg.pack(m.segments),
        LogRef: cut(logRef, 120)
      });
      if (buffer.length >= FLUSH_SIZE) {
        // Fire-and-forget controllato: si accoda la promise e la si attende in finish().
        // Un fallimento di flush NON deve mai far fallire il job.
        pendingFlush = pendingFlush.then(() => flush()).catch((e) => {
          flushFailed = true;
          console.error(`>>> [SUMMARY] flush fallito: ${e.message}`);
        });
      }
    },

    /** Record saltati: solo contatore (non hanno dimensione plant in nessuno dei 4 job). */
    skip(n = 1) { totals.skipped += n; },

    /**
     * Anomalia non riferita a un singolo record ma a una porzione di scope (lettura di un
     * plant fallita, batch di dettaglio KO, plant non licenziato con lavoro in attesa).
     * Degrada l'HDR: un run con scope ridotto non e' un run 'S'.
     *
     * NON passa da bumpTotals: e' cio' che la rende l'unico canale per una voce di riepilogo
     * che non deve toccare i contatori degli ordini (feature 0014, TDD §5.6). I contatori restano
     * conteggi di OGGETTI TRATTATI, e una lettura caduta non e' un oggetto.
     *
     * [RUN-BLOCKED] MA `status: 'E'` FA CHIUDERE IL RUN IN ERRORE (DEC-124). Fino a quella
     * decisione lo status di `scope()` coloriva la riga e nient'altro: dodici call site scrivevano
     * `status: 'E'` credendo di dichiarare un guasto — e il run usciva 0, quindi il Job Scheduler
     * registrava SUCCESS su un run che non aveva potuto fare niente. Ora `'E'` qui significa «una
     * chiamata verso un sistema esterno non ha prodotto una risposta utilizzabile», e sono le sole
     * due parole ammesse: per un perimetro ridotto in cui NESSUNA chiamata e' caduta — troncamento
     * al nostro tetto, perimetro vuoto, customizing assente, deriva non verificabile — si usa
     * `'W'`, che degrada a 'W' e lascia l'exit code a zero.
     *
     * @param {string} [objectType='SCOPE'] tipo dell'oggetto nella riga POS. Default invariato:
     *   le chiamate esistenti (syncMaterialsToPlex.js, postProdOrderConfirmation.js,
     *   syncRoutingsToPlex.js) continuano a scrivere 'SCOPE'.
     * @param {boolean} [degrade=true] se false la riga viene scritta SENZA degradare l'HDR.
     *   Serve alle voci INFORMATIVE per plant introdotte dalla feature 0014 (FR-32): una voce
     *   «ordinamento non abilitato» o «tutte riuscite» non e' un'anomalia e non deve far chiudere
     *   l'esecuzione in attenzione. Default invariato = true.
     */
    scope({ plant, objectKey, objectType = 'SCOPE', status = 'W', segments, message, degrade = true } = {}) {
      if (degrade) degraded = true;
      const st = REC_STATUS.has(status) ? status : 'W';
      // [RUN-BLOCKED] Si conta DOPO la normalizzazione, o uno status scritto male finirebbe in 'W'
      // e il guasto sparirebbe. `degrade: false` non protegge da questo: una chiamata caduta non e'
      // mai informativa, quindi le due leve sono indipendenti di proposito.
      const pl = cut(plant, 4) || PLANT_NA;
      if (st === 'E') {
        blocked += 1;
        // Si memorizza DOPO la normalizzazione del plant, cosi' la nota di testata porta lo stesso
        // valore della riga POS — `#NA` compreso, che e' il modo in cui questo progetto dice «non
        // ha un plant» e non un plant inventato.
        if (!blockedFirst) blockedFirst = { plant: pl, objectKey: cut(objectKey, 150) };
      }
      plants.add(pl);
      const m = messageOf(segments, message, 'scope');
      buffer.push({
        RunId: id, Counter: ++counter, Plant: pl,
        ObjectType: cut(objectType, 20), ObjectKey: cut(objectKey, 150), ObjectKey2: null,
        Status: st,
        Message: m.text, MessageJson: logMsg.pack(m.segments), LogRef: null
      });
    },

    /**
     * Zero plant utilizzabili. Oggi i job in questo caso escono 0 in silenzio: qui diventa
     * HDR Status='N', che fa scattare anche i destinatari ON_FAILURE.
     */
    noScope({ active = 0, usable = 0 } = {}) {
      noScopeFlag = true;
      degraded = true;
      noScopeSegment = logMsg.seg('logRunNoScope', active, usable);
      console.warn(`>>> [SUMMARY] scope vuoto: ${active} plant attivi, ${usable} utilizzabili`);
    },

    /**
     * Nota del run, appesa a ZJobRunHDR.Message e riportata nel corpo mail.
     * Accetta una lista di segmenti; una stringa resta ammessa come lacuna dichiarata.
     */
    note(segments, message) {
      const isText = typeof segments === 'string';
      const m = messageOf(isText ? null : segments, isText ? segments : message, 'note');
      if (m.segments.length) notes.push(...m.segments);
    },

    /**
     * Errore fatale: forza Status='E' e valorizza FatalMessage.
     *
     * Il messaggio di un'eccezione e' testo di TERZI — di axios, di HANA, del runtime — e per
     * questo viaggia in `logMsg.technical()`, che non si traduce: tradurre un errore altrui vuol
     * dire nasconderlo. Chi ha una causa propria da dichiarare passa i suoi segmenti.
     */
    fatal(err, segments) {
      const raw = (err && err.message) || (err === undefined || err === null ? '' : String(err));
      const segs = logMsg.normalize(segments).length
        ? logMsg.normalize(segments)
        : (raw ? [logMsg.technical(raw)] : []);
      const m = messageOf(segs, raw, 'fatal');
      fatalMessage = m.text;
      fatalSegments = m.segments;
      console.error(`>>> [SUMMARY] errore fatale: ${fatalMessage}`);
    },

    flush,

    /** Plant toccati dal run, per la costruzione degli allegati. */
    plants() { return [...plants].sort(); },

    /**
     * Precarica i destinatari in memoria: se il DB cade a metà run la mail parte comunque
     * con i contatori in memoria.
     */
    async preloadRecipients() {
      try {
        recipients = await db.run(
          SELECT.from(E_RECIPIENT)
            .columns('Plant', 'JobCode', 'Email', 'NotifyMode', 'IsActive')
            .where({ JobCode: jobCode, IsActive: true })
        ) || [];
        console.log(`>>> [SUMMARY] ${recipients.length} destinatari configurati per ${jobCode}`);
      } catch (e) {
        recipients = [];
        console.error(`>>> [SUMMARY] lettura destinatari fallita: ${e.message}`);
      }
      return recipients;
    },

    recipients() { return recipients || []; },

    /**
     * Chiude il run: flush finale, calcolo dello stato, UPDATE dell'HDR.
     * @returns {Promise<object>} i totali + status
     */
    async finish() {
      await pendingFlush;
      try {
        await flush();
      } catch (e) {
        flushFailed = true;
        console.error(`>>> [SUMMARY] flush finale fallito: ${e.message}`);
      }

      const status = runStatus.runStatusOf({
        fatal: !!fatalMessage,
        noScope: noScopeFlag,
        failed: totals.failed,
        warning: totals.warning,
        exhausted: totals.exhausted,
        degraded,
        blocked: blocked > 0
      });

      // [RUN-BLOCKED] LE NOTE DI VERDETTO, E PERCHE' STANNO DAVANTI A TUTTO.
      //
      // E' la regola gia' scritta in docs/0023 §«L'ordine delle note del run non e' casuale»: cio'
      // che spiega l'ESITO va per primo, cio' che descrive la CONFIGURAZIONE per ultimo, perche'
      // entrambi i tetti scartano la CODA — `cut(rendered, 255)` sullo snapshot e `pack()` sui
      // segmenti. La posizione E' la priorita'.
      //
      // Quella regola i job la rispettavano e `jobSummary` no: le sue note nascono qui, in
      // `finish()`, cioe' DOPO tutte le `note()` che un job appende durante il run (runJob lo
      // attende prima di chiamarci). Quindi l'unica riga che diceva perche' un run era rosso era
      // sempre l'ultima, ed era la prima a cadere — il 07/09/2026 MAT_SYNC ha chiuso 'E' su un 503
      // di Plex e sul dashboard dello scheduler si leggeva «errori 0 … perimetro: 304 ma».
      //
      // L'ordine QUI DENTRO e' dichiarato e non incidentale: prima cosa ha fermato il run, poi
      // cosa manca al run-log. Chi aggiunge una nota di verdetto la mette in questo elenco, non
      // in `notes`.
      const verdictSegments = [
        ...(blocked > 0 ? [blockedSegment()] : []),
        ...(noScopeSegment ? [noScopeSegment] : []),
        ...(posDropped > 0 ? [logMsg.seg('logRunPosDropped', posDropped, MAX_POS)] : []),
        ...(flushFailed ? [logMsg.seg('logRunFlushFailed')] : [])
      ];

      // [LOG-MSG-I18N] La testata e' il verdetto, poi i contatori, poi le note, ognuna un segmento
      // suo. I permanenti restano un segmento separato e non un parametro dei contatori:
      // comparivano solo quando c'erano, e un «permanenti 0» in ogni riga di recap sarebbe rumore.
      const headSegments = [
        ...verdictSegments,
        logMsg.seg('logRunTotals', totals.ok, totals.warning, totals.failed, totals.skipped),
        ...(totals.exhausted ? [logMsg.seg('logRunExhausted', totals.exhausted)] : []),
        ...notes
      ];
      const head = messageOf(headSegments, null, 'finish');
      const message = head.text;

      // [RUN-BLOCKED] `blocked` viaggia nel risultato perche' e' da qui che runJob ricava l'exit
      // code: e' un NUMERO e non un booleano perche' chi legge un run vuole sapere quante chiamate
      // sono cadute, e perche' `exitCodeOf` accetta comunque un valore veritiero.
      const result = { ...totals, fatal: !!fatalMessage, blocked, status, runId: id, jobCode };

      try {
        await db.run(UPDATE(E_RUN_HDR).set({
          FinishedAt: new Date().toISOString(),
          Status: status,
          TotalProcessed: totals.processed,
          TotalOk: totals.ok,
          TotalWarning: totals.warning,
          TotalFailed: totals.failed,
          TotalExhausted: totals.exhausted,
          TotalSkipped: totals.skipped,
          Message: message,
          MessageJson: logMsg.pack(head.segments),
          FatalMessage: fatalMessage,
          FatalMessageJson: logMsg.pack(fatalSegments)
        }).where({ RunId: id }));
      } catch (e) {
        // Non-bloccante, come le scritture di log in srv/cat-service.js.
        console.error(`>>> [SUMMARY] chiusura HDR fallita (non-blocking): ${e.message}`);
      }

      console.log(
        `>>> [SUMMARY] run ${id} chiuso: ${status} - ${message}`
      );
      return result;
    },

    /**
     * Invia il recap. Delegato a jobNotifier, che riscrive MailStatus/MailMessage sull'HDR.
     * Un fallimento qui non deve mai cambiare l'exit code del job: e' il chiamante (runJob)
     * a garantirlo.
     */
    async notify() {
      const { notify } = require('./jobNotifier');
      return notify({ db, runId: id, jobCode, summary });
    },

    /**
     * Percorso SIGTERM: flush + HDR 'E', NIENTE PDF e NIENTE mail. Il budget di CF non
     * basta a costruire un PDF e completare una POST HTTP, quindi non si finge di coprirlo.
     */
    async abort(reason) {
      console.warn(`>>> [SUMMARY] abort: ${reason}`);
      const m = messageOf([logMsg.seg('logRunAborted', reason)], null, 'abort');
      fatalMessage = m.text;
      fatalSegments = m.segments;
      try { await pendingFlush; await flush(); } catch (e) { /* best effort */ }
      try {
        await db.run(UPDATE(E_RUN_HDR).set({
          FinishedAt: new Date().toISOString(), Status: 'E',
          TotalProcessed: totals.processed, TotalOk: totals.ok,
          TotalWarning: totals.warning, TotalFailed: totals.failed,
          TotalExhausted: totals.exhausted, TotalSkipped: totals.skipped,
          FatalMessage: fatalMessage,
          FatalMessageJson: logMsg.pack(fatalSegments)
        }).where({ RunId: id }));
      } catch (e) { /* best effort */ }
    }
  };

  return summary;
}

module.exports = {
  createJobSummary, insertChunked, cut, messageOf,
  E_RUN_HDR, E_RUN_POS, E_RUN_MAIL, E_RECIPIENT, NS
};

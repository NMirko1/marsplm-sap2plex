/**
 * ============================================================================
 * [ORDER-COMPLETE] [ORDER-SCHEDULED] LA FASE B: l'invio dello stato utente verso SAP
 * (feature 0045, estratta dalla 0046)
 * ============================================================================
 *
 * I due job che portano in SAP uno stato del job Plex — `ORDER_COMPLETE` per «finito»,
 * `ORDER_SCHEDULED` per «pianificato» — differiscono per COME rilevano (una finestra a watermark il
 * primo, una fotografia per stato il secondo) e per QUALE Function Import chiamano. Tutto il resto
 * dell'invio e' identico, ed e' qui: la ripresa dal database, la prenotazione, la POST, la
 * transizione di stato, lo storico dell'ordine, il recap.
 *
 * ============================================================================
 * LA FASE B E' GUIDATA DAL DATABASE, NON DAL RILEVAMENTO
 * ============================================================================
 * E' la proprieta' piu' importante di questo file, e la prima stesura della 0045 non l'aveva.
 * L'insieme da inviare NON viene da cio' che il rilevamento ha appena letto: viene da un `SELECT`
 * sulla tabella di stato, che contiene sia le righe nuove sia l'ARRETRATO — `'D'` (la casella del
 * plant era chiusa), `'E'` (non inviato o rifiutato), `'Q'` (quarantena) e le `'P'` orfane.
 *
 * Senza questo passo, uno stato dichiarato «non terminale» non lo e': nel flusso a finestra la
 * sovrapposizione fra due letture e' di due minuti e il seme dell'avvio a freddo si sposta solo in
 * avanti, quindi una riga lasciata in `'D'` non tornerebbe mai piu' fra i candidati e il giorno
 * dell'accensione servirebbe un backfill a mano — cioe' esattamente cio' che DEC-71 promette di non
 * richiedere. E' la forma di `loadCandidates` in `PROD_TECO` e dei tre passi guidati dal DB in
 * `PROD_CONF`.
 *
 * ============================================================================
 * LE QUATTRO REGOLE CHE NON SI TOCCANO
 * ============================================================================
 *  1. LA PRENOTAZIONE E' UNA `UPDATE` CONDIZIONALE, e viene PRIMA della POST. Il lock in memoria di
 *     `jobTrigger` copre il solo avvio dallo scheduler: `npm run job-*` e `cf run-task` lo
 *     scavalcano, e due run sovrapposti manderebbero due volte la stessa POST. La `where` sullo
 *     stato atteso rende la presa esclusiva. Prima della chiamata perche' su Cloud Foundry lo
 *     shutdown ha otto secondi (DEC-89).
 *  2. `Attempts` SI INCREMENTA NELLA PRENOTAZIONE, e `nextState` lo RIPORTA indietro quando l'esito
 *     non consuma. Le due cose insieme: una morte del processo lascia il tentativo consumato — che
 *     e' cio' che impedisce a un guasto ciclico di girare per sempre — mentre un esito non
 *     conclusivo no.
 *  3. LO STORICO DELL'ORDINE SI SCRIVE SOLO SE LA CHIAMATA E' PARTITA DAVVERO (DEC-95): casella del
 *     plant chiusa, plant senza connessione, quarantena e prenotazione non ottenuta non lasciano
 *     riga. Un rifiuto di SAP si': SAP ha risposto.
 *  4. `updateHeader` NON SI PASSA: la testata dello storico deve continuare a dire com'e' andato
 *     l'ultimo INVIO verso Plex, non l'ultimo stato utente (DEC-96).
 *
 * Perimetro: grep -rn "ORDER-COMPLETE\|ORDER-SCHEDULED"
 */

'use strict';

const excLog = require('./prodOrderExcLog');
const logMsg = require('./logMessage');
const i18nMessages = require('./i18nMessages');
const { PLANT_NA: PLANT_UNKNOWN } = require('./jobCodes');
const { postOrderStatus } = require('./prodOrderStatusPost');
const { requireFlow } = require('./orderStatusFlow');

/** Il messaggio persistito e' uno SNAPSHOT in italiano; la resa alla lettura e' del server. */
const renderMsg = (segments) => i18nMessages.render(
  logMsg.normalize(segments), i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE
);

const s = (v) => String(v ?? '').trim();
const cut = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// TRACCIA E PERSISTENZA
// ---------------------------------------------------------------------------------------------

/** I passi di una sequenza, nella forma che `appendProdOrderLog` serializza. */
function newTrace() {
  const steps = [];
  return {
    steps,
    add(step, request, res, aux = false) {
      const r = res || {};
      steps.push({
        step,
        request: request === undefined ? null : request,
        status: Number.isFinite(r.status) ? r.status : (r.status || null),
        response: r.body === undefined ? (r.error || null) : r.body,
        ...(aux ? { aux: true } : {})
      });
    },
    fail(step, request, error, aux = false) {
      steps.push({
        step,
        request: request === undefined ? null : request,
        status: null,
        response: { error: (error && error.message) || String(error) },
        ...(aux ? { aux: true } : {})
      });
    }
  };
}

/**
 * Upsert di una riga di stato, sulla chiave `PlexJobId`.
 *
 * `DetectedAt` si scrive SOLO alla prima rilevazione: e' la data da cui si misura la coda ferma, e
 * riscriverla a ogni run renderebbe ogni arretrato «di oggi».
 *
 * Le due colonne `PlexCompletedAt` e `QuantityCompleted` esistono su ENTRAMBE le tabelle di stato
 * anche se per il flusso SCHEDULED sono sempre nulle — un job pianificato non ha una data di
 * completamento. E' la scelta che tiene questo scrittore SENZA CONDIZIONALI: due tabelle identiche
 * costano due colonne nulle, due tabelle diverse costerebbero un `if` per flusso in ogni punto che
 * scrive. E' la stessa forma di `ZProdConfPlexEntry`, che porta le colonne delle tre sorgenti Plex
 * e ne riempie quelle di una sola per riga.
 */
async function saveState(db, row, flow) {
  // Il flusso e' obbligatorio, e la guardia serve a NON restare muta. Senza, `flow.stateEntity` su
  // `undefined` lancia un `TypeError` generico che il `try/catch` del chiamante trasforma in
  // «lettura non riuscita»: il difetto vero — un `saveState` chiamato senza flusso — sparisce dietro
  // un messaggio che parla d'altro. E' costato un giro di diagnosi durante l'estrazione stessa.
  requireFlow(flow, 'saveState');
  const key = { PlexJobId: row.plexJobId };
  const now = nowIso();
  const segments = logMsg.normalize(row.segments);
  const fields = {
    Plant: cut(row.plant, 4),
    PlexJobNumber: cut(row.plexJobNumber, 40),
    PlexStatus: cut(row.plexStatus, 40),
    PlexCompletedAt: row.completedAt || null,
    Quantity: Number.isFinite(row.quantity) ? row.quantity : null,
    QuantityCompleted: Number.isFinite(row.quantityCompleted) ? row.quantityCompleted : null,
    ManufacturingOrder: cut(row.order, 12),
    State: row.state,
    Attempts: Number.isFinite(row.attempts) ? row.attempts : 0,
    SapMessageType: cut(row.messageType, 1),
    SapMessageId: cut(row.messageId, 20),
    SapMessageNumber: cut(row.messageNumber, 3),
    HttpStatus: Number.isFinite(row.httpStatus) ? row.httpStatus : null,
    SapDepth: cut(row.depth, 20),
    LastMessage: cut(renderMsg(segments), 255),
    LastMessageJson: logMsg.pack(segments),
    UpdatedAt: now
  };
  if (row.state === 'A') fields.AppliedAt = now;
  if (row.state === 'P') fields.ClaimedAt = now;

  const existing = await db.run(SELECT.one.from(flow.stateEntity).where(key));
  if (existing) {
    await db.run(UPDATE(flow.stateEntity).set(fields).where(key));
    return false;
  }
  await db.run(INSERT.into(flow.stateEntity).entries({
    ...key, DetectedAt: now, CreatedAt: now, ...fields
  }));
  return true;
}

/**
 * LA PRENOTAZIONE, con una UPDATE CONDIZIONALE. Vedi la regola 1 in testa al file.
 *
 * Il numero di righe toccate si legge tollerando DUE FORME: `@sap/cds` ^9 restituisce un numero,
 * cds 10 un oggetto `{ affected }`.
 */
async function claimRow(db, row, fromStates, flow) {
  requireFlow(flow, 'claimRow');
  const res = await db.run(
    UPDATE(flow.stateEntity).set({
      State: 'P',
      Attempts: (Number(row.Attempts) || 0) + 1,
      ClaimedAt: nowIso(),
      UpdatedAt: nowIso()
    }).where({ PlexJobId: row.PlexJobId, State: { in: fromStates } })
  );
  const affected = res && typeof res === 'object' && 'affected' in res ? res.affected : res;
  return Number(affected) > 0;
}

/** Lo storico invii dell'ordine. `updateHeader` assente di proposito: vedi la regola 4. */
async function writeStatusLog(db, { order, status, segments, steps }, flow) {
  requireFlow(flow, 'writeStatusLog');
  return excLog.appendProdOrderLog(db, {
    order,
    operation: excLog.OPERATION[flow.excLogOperation],
    status,
    segments,
    steps
  });
}

// ---------------------------------------------------------------------------------------------
// L'INVIO DI UNA RIGA
// ---------------------------------------------------------------------------------------------

/**
 * Manda lo stato utente per UNA riga. NON LANCIA: ogni esito e' un valore di ritorno, perche' un
 * ordine che non parte non deve impedire agli altri di partire.
 */
async function sendOne(ctx, row) {
  const { flow, rules, permanentMessages, limits } = ctx;
  const OUTCOME = rules.OUTCOME;
  const plant = s(row.Plant) || PLANT_UNKNOWN;
  const order = s(row.ManufacturingOrder);
  const prev = { attempts: Number(row.Attempts) || 0 };
  const trace = newTrace();

  // Il numero va in formato INTERNO: `AUFNR` ha la conversion exit ALPHA, e sul canale Integration
  // Suite l'ordine puo' essere arrivato senza riempimento (DEC-58/DEC-59).
  const internal = rules.internalOrderNumber(order);
  const correlationId = require('crypto').randomUUID();
  const stepName = `POST ${flow.callKey === 'teco' ? 'TechlyCmpltOrder' : 'CloseOrder'}`;

  let r;
  try {
    r = await postOrderStatus({ order: internal, call: flow.callKey }, { correlationId });
  } catch (e) {
    // Solo un difetto di programmazione arriva qui: `postOrderStatus` non lancia per un esito.
    trace.fail(stepName, { ManufacturingOrder: internal }, e);
    const next = rules.nextState(prev, {
      kind: OUTCOME.FAILED,
      consumesAttempt: false,
      segments: [logMsg.seg(`${flow.msg}SendThrown`), logMsg.technical(e.message)]
    }, limits.maxAttempts);
    return { next, trace, r: null, plant, order };
  }

  trace.add(stepName, {
    ManufacturingOrder: internal,
    correlationId,
    destination: r.destination
  }, { status: r.httpStatus || (r.httpOk ? 200 : null), body: r.responseBody });

  const verdict = rules.classifyOrderClose(r, permanentMessages);
  const segments = [];
  if (verdict.kind === OUTCOME.APPLIED) {
    segments.push(logMsg.seg(`${flow.msg}Applied`, order));
  } else if (verdict.kind === OUTCOME.REJECTED) {
    segments.push(logMsg.seg(
      `${flow.msg}Rejected`,
      r.messageType || '', r.messageId || '', r.messageNumber || '', r.messageText || ''
    ));
  } else if (verdict.kind === OUTCOME.INCONCLUSIVE) {
    segments.push(logMsg.seg(`${flow.msg}Inconclusive`, r.depth || ''));
  } else {
    segments.push(logMsg.seg(`${flow.msg}SendFailed`, r.httpStatus || 0));
  }
  if (r.mplId) segments.push(logMsg.seg(`${flow.msg}MplId`, r.mplId));
  segments.push(logMsg.technical(verdict.reason));

  const next = rules.nextState(prev, { ...verdict, segments }, limits.maxAttempts);
  if (r.queryGuard && ctx.queryGuard) {
    // La guardia dell'iFlow: la richiesta e' arrivata e non e' mai stata eseguita. E' una notizia
    // di CONFIGURAZIONE, non del dato, e riguarda tutte le righe: si dichiara una volta per plant.
    ctx.queryGuard.add(plant);
  }
  return { next, trace, r, plant, order };
}

// ---------------------------------------------------------------------------------------------
// LA FASE B
// ---------------------------------------------------------------------------------------------

/**
 * Legge le righe non terminali dal database e le invia. Restituisce i contatori del run.
 *
 * @param {object} ctx
 * @param {object} ctx.db             connessione CDS
 * @param {object} ctx.summary        il collettore del run log
 * @param {Date}   ctx.now
 * @param {object} ctx.index          da `rules.indexMapping`: serve a ri-risolvere le quarantene
 * @param {object} ctx.stats          i contatori del recap, per plant
 * @param {object} ctx.scope          da `rules.resolveScope`
 * @param {object} ctx.flow           il descrittore di flusso
 * @param {object} ctx.rules          il modulo legato al flusso (prodOrderComplete/Scheduled)
 * @param {object} ctx.limits         `{maxAttempts, maxPerRun, staleMinutes, quarantineDays, staleDays}`
 * @param {Set}    ctx.permanentMessages
 * @param {string} ctx.objectType     `ObjectType` delle righe di run log
 * @param {Set}    [ctx.skipOrders]   ordini da NON toccare (l'eco del TECO, solo per COMPLETE)
 * @param {Set}    [ctx.queryGuard]   raccoglie i plant in cui l'iFlow ha rifiutato all'ingresso
 * @returns {Promise<{sent: number, deferred: number, failed: number}>}
 */
async function sendPending(ctx) {
  const { db, summary, now, index, stats, scope, flow, rules, limits, objectType } = ctx;
  const STATE = rules.STATE;
  const OUTCOME = rules.OUTCOME;

  // GUIDATO DAL DATABASE, non dal rilevamento: e' cio' che rende vere le promesse di 'D', 'E' e 'Q'.
  const stateRows = await db.run(
    SELECT.from(flow.stateEntity).where({ State: { in: [
      STATE.DETECTED, STATE.FAILED, STATE.QUARANTINE, STATE.CLAIMED
    ] } })
  );
  const { resume, staleClaims, expiredQuarantine } = rules.resumableRows(stateRows, {
    now, staleMinutes: limits.staleMinutes, quarantineDays: limits.quarantineDays
  });

  for (const r of expiredQuarantine) rules.addSweep(stats, r.Plant, { quarantineExpired: 1 });
  if (expiredQuarantine.length) {
    console.warn(`>>> [${flow.jobCode}] ${expiredQuarantine.length} righe in quarantena scadute: `
      + `non si ri-risolvono piu' (${limits.quarantineDays} giorni)`);
  }
  for (const r of staleClaims) rules.addSweep(stats, r.Plant, { staleClaims: 1 });

  // Le prenotazioni orfane si RITENTANO — e' l'opposto di PROD_TECO, e la ragione e' che
  // reimpostare uno stato utente informativo e' un no-op mentre non impostarlo lascia l'ordine muto.
  // Il ciclo resta bounded perche' la prenotazione morta ha gia' consumato il suo tentativo.
  const candidates = [...resume, ...staleClaims].sort((a, b) => {
    const x = s(a.ManufacturingOrder) || s(a.PlexJobNumber);
    const y = s(b.ManufacturingOrder) || s(b.PlexJobNumber);
    return x.localeCompare(y);
  });

  const staleAt = rules.staleCutoff(now, limits.staleDays * 24 * 60).toISOString();
  let sent = 0;
  let deferred = 0;
  let failed = 0;

  for (const row of candidates) {
    const plant = s(row.Plant) || PLANT_UNKNOWN;
    const cfg = scope.byPlant.get(plant);

    // La CODA FERMA: una riga non terminale ferma da troppo tempo. «0 ordini trattati» e «il
    // criterio non aggancia quello che il plant fa davvero» sono indistinguibili senza questo numero.
    const since = s(row.DetectedAt) || s(row.CreatedAt);
    if (since && since < staleAt) rules.addStale(stats, plant, since);

    // Un plant che ha perso la configurazione fra due run: la riga resta, non si scrive.
    if (!cfg) {
      summary.skip(1);
      continue;
    }

    // ---- quarantena: si RI-RISOLVE contro i dizionari di ADESSO --------------------------
    if (s(row.State) === STATE.QUARANTINE) {
      const res = rules.resolveJob(
        { id: s(row.PlexJobId), jobNumber: s(row.PlexJobNumber) }, index, plant
      );
      if (res.kind !== 'main') {
        // Ancora non risolvibile: resta in quarantena e si conta. Non e' un errore.
        rules.addOutcome(stats, plant, STATE.QUARANTINE);
        summary.skip(1);
        continue;
      }
      // Risolta: da qui prosegue come una riga normale.
      row.ManufacturingOrder = res.order;
      await saveState(db, {
        plexJobId: s(row.PlexJobId),
        plant,
        plexJobNumber: s(row.PlexJobNumber),
        plexStatus: s(row.PlexStatus),
        completedAt: row.PlexCompletedAt,
        quantity: Number(row.Quantity),
        quantityCompleted: Number(row.QuantityCompleted),
        order: res.order,
        state: cfg.enabled ? STATE.FAILED : STATE.DETECTED,
        attempts: Number(row.Attempts) || 0,
        segments: [logMsg.seg(`${flow.msg}QuarantineResolved`, res.order)]
      }, flow);
      row.State = cfg.enabled ? STATE.FAILED : STATE.DETECTED;
      rules.addSweep(stats, plant, { requeued: 1 });
    }

    const order = s(row.ManufacturingOrder);
    if (!order) { summary.skip(1); continue; }

    // ---- L'UNICO INTERRUTTORE: la casella del plant --------------------------------------
    // Dalla 0046 non c'e' piu' nessuna leva di processo sopra questa: quando il job parte dallo
    // scheduler, scrive. Questo e' quindi l'unico ramo dell'attesa, e passa da `OUTCOME.PENDING`
    // perche' la regola «un'attesa non consuma un tentativo» viva in un punto solo.
    if (!cfg.enabled) {
      const next = rules.nextState({ attempts: Number(row.Attempts) || 0 }, {
        kind: OUTCOME.PENDING,
        segments: [logMsg.seg(`${flow.msg}PlantDisabled`)]
      }, limits.maxAttempts);
      await saveState(db, {
        plexJobId: s(row.PlexJobId),
        plant,
        plexJobNumber: s(row.PlexJobNumber),
        plexStatus: s(row.PlexStatus),
        completedAt: row.PlexCompletedAt,
        order,
        state: next.State,
        attempts: next.Attempts,
        segments: next.segments
      }, flow);
      rules.addOutcome(stats, plant, next.State);
      summary.skip(1);
      continue;
    }

    if (ctx.skipOrders && ctx.skipOrders.has(order)) {
      rules.addOutcome(stats, plant, STATE.DETECTED);
      summary.skip(1);
      continue;
    }

    if (limits.maxPerRun > 0 && sent >= limits.maxPerRun) { deferred += 1; continue; }

    // ---- prenotazione, poi scrittura ------------------------------------------------------
    const from = [STATE.DETECTED, STATE.FAILED, STATE.QUARANTINE, STATE.CLAIMED];
    if (!await claimRow(db, row, from, flow)) {
      // Un altro run l'ha preso: non e' un errore, e non si tocca la riga.
      summary.skip(1);
      continue;
    }
    sent += 1;

    const { next, trace, r } = await sendOne(ctx, row);
    const state = next.State;

    await saveState(db, {
      plexJobId: s(row.PlexJobId),
      plant,
      plexJobNumber: s(row.PlexJobNumber),
      plexStatus: s(row.PlexStatus),
      completedAt: row.PlexCompletedAt,
      quantity: Number(row.Quantity),
      quantityCompleted: Number(row.QuantityCompleted),
      order,
      state,
      attempts: next.Attempts,
      messageType: r && r.messageType,
      messageId: r && r.messageId,
      messageNumber: r && r.messageNumber,
      httpStatus: r && r.httpStatus,
      depth: r && r.depth,
      segments: next.segments
    }, flow);

    // Lo storico dell'ordine: SOLO se la chiamata e' partita davvero (DEC-95).
    let logCounter = null;
    if (trace && trace.steps.length) {
      logCounter = await writeStatusLog(db, {
        order,
        status: rules.stateRecordStatus(state) === 'S' ? 'S' : 'E',
        segments: next.segments,
        steps: trace.steps
      }, flow);
    }

    rules.addOutcome(stats, plant, state);
    summary.record({
      plant,
      objectType,
      objectKey: order,
      objectKey2: s(row.PlexJobNumber),
      status: rules.stateRecordStatus(state),
      segments: next.segments,
      logRef: excLog.logRefFor(order, logCounter) || `${flow.stateEntity}/${s(row.PlexJobId)}`
    });

    if (state === STATE.APPLIED) {
      console.log(`>>> [OK] ordine ${order}: stato utente impostato in SAP`);
    } else if (state === STATE.FAILED || state === STATE.EXHAUSTED) {
      if (state === STATE.FAILED) failed += 1;
      console.error(`>>> [ERRORE] ordine ${order}: ${renderMsg(next.segments)}`);
    }
  }

  return { sent, deferred, failed };
}

module.exports = {
  newTrace, saveState, claimRow, writeStatusLog, sendOne, sendPending, renderMsg
};

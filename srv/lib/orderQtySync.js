/**
 * [ORDER-QTY-SYNC] Il riallineamento della quantita' di un ordine GIA' inviato a Plex (feature 0033):
 * lettura dei lotti, calcolo, scrittura. Le regole che si possono decidere senza parlare con nessuno
 * stanno accanto, in srv/lib/orderQtyRules.js, e hanno il loro test.
 *
 * PERCHE' STA IN `srv/lib/` E NON IN `cat-service.js`. Serve al job `PROD_ORDER` e all'action del
 * cockpit, e i cinque job girano come PROCESSI SEPARATI: possono fare `require` di un file, non
 * entrare nella closure di `cds.service.impl`. Il rischio da sorvegliare non e' un import che non
 * compila — e' la COPIA della stessa formula nei due punti, che divergerebbe al primo caso limite
 * aggiunto da una parte sola, dando un numero a schermo e un altro in fabbrica.
 *
 * COSA FA E COSA NON FA. Aggiorna la QUANTITA' (e con essa la data di consegna, perche' un `PUT` e'
 * il modello intero) del LOTTO PRINCIPALE. Non tocca i pacchetti — la loro quantita' l'ha decisa una
 * persona spacchettando — non crea niente, non allinea distinta ne' operazioni. Su un ordine non
 * spacchettato quel riallineamento lo fa gia' `processOrder` per intero; questo modulo e' la strada
 * per gli ordini SPACCHETTATI, dove `processOrder` non si puo' usare (RB-28 della 0012: riporterebbe
 * il lotto principale alla quantita' piena dell'ordine, che e' esattamente cio' che li' e' vietato).
 * Dopo una scrittura chiede l'ordinamento della lista di lavoro, se il chiamante lo inietta
 * ([ORDER-SORT-ON-WRITE], `sortAfterWrite` qui sotto).
 *
 * IL DIFETTO PLEX CHE HA FATTO NASCERE QUESTA CAUTELA — CHIUSO IL 27/08/2026. Quando la 0033 e' stata
 * scritta, `PUT /scheduling/v1/jobs/{id}` rispondeva `500 REQUEST_PROCESSING_ERROR / "Data is Null"` su
 * questo tenant: otto variabili escluse a esperimento singolo, dossier in
 * srv/external/PLEX_ISSUE_JOB_QUANTITY_UPDATE_500.it.md, girato a Rockwell il 20/08/2026. **Rockwell
 * l'ha corretto e la correzione e' stata VERIFICATA sul tenant**: l'operazione risponde, e un ordine
 * la cui quantita' e' davvero cambiata arriva in fabbrica.
 *
 * IL CONFRONTO PREVENTIVO RESTA, e non e' una svista. Non era un aggiramento del difetto: una
 * scrittura che non ha niente da scrivere non si manda comunque — costa una richiesta e riscrive una
 * TESTATA INTERA su un oggetto vivo (DEC-77). Il difetto le ha dato l'urgenza, non la ragione. Chi
 * togliesse il confronto «tanto adesso il `PUT` funziona» rimetterebbe una scrittura inutile per ogni
 * ordine gia' inviato, a ogni esecuzione del job.
 *
 * Perimetro: `grep -rn "ORDER-QTY-SYNC"`.
 */

'use strict';

const plexJobRead = require('./plexJobRead');
const qtyRules = require('./orderQtyRules');
const { plexErrText } = require('./plexCallTrace');
const { inheritedJobFields, jobPutBodies } = require('./plexJobFields');
const logMsg = require('./logMessage');

const { LOT_VERDICT, TARGET_REASON, SYNC } = qtyRules;

/**
 * [WC-FALSE] Il corpo del backwards-schedule manda `useFirstApprovedWorkcenter: false`, allineato ai
 * due gemelli (srv/jobs/createPlexProductionOrders.js e srv/lib/plexJobSplit.js). Il default cablato
 * e' quello: un terzo valore su questa chiamata renderebbe non confrontabili le tracce dei tre flussi.
 */
const USE_FIRST_APPROVED_WORKCENTER =
  String(process.env.PLEX_USE_FIRST_APPROVED_WC || 'false').trim().toLowerCase() === 'true';

/** Il messaggio di recap/log per ciascun motivo di rifiuto. Un motivo = un segmento, mai prosa. */
const REASON_KEY = Object.freeze({
  [TARGET_REASON.NEGATIVE]: 'logOrderQtyNegative',
  [TARGET_REASON.LOT_UNREADABLE]: 'logOrderQtyLotUnreadable',
  [TARGET_REASON.NO_SAP_QTY]: 'logOrderQtyNoSapQty',
  [TARGET_REASON.MAIN_ABSENT]: 'logOrderQtyMainAbsent'
});

/**
 * L'esito che un motivo di rifiuto merita.
 *
 * `NEGATIVE` e' l'unico `E`, ed e' una scelta: la quantita' dell'ordine e' scesa sotto quella gia'
 * distribuita sui pacchetti, cioe' un dato che qualcuno deve correggere — in SAP o su Plex — e il run
 * deve chiudere in errore perche' e' cosi' che parte la mail ai destinatari. Gli altri tre sono
 * situazioni in cui NON SI E' POTUTO fare il confronto: degradano il run e si dichiarano, ma un run
 * che chiudesse in errore ogni volta che un job non e' leggibile renderebbe l'errore vero
 * indistinguibile dal rumore.
 */
const REASON_STATUS = Object.freeze({
  [TARGET_REASON.NEGATIVE]: 'E',
  [TARGET_REASON.LOT_UNREADABLE]: 'W',
  [TARGET_REASON.NO_SAP_QTY]: 'W',
  [TARGET_REASON.MAIN_ABSENT]: 'W'
});

/** Numero leggibile in un messaggio: al piu' tre decimali, senza zeri di coda inutili. */
function fmt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '?';
  return String(Math.round(Number(n) * 1000) / 1000);
}

/**
 * Istante leggibile in un messaggio: COSI' COM'E', o `?` se non c'e'.
 *
 * NON SI RIDUCE AL GIORNO, ed e' il punto. Le due date si confrontano come istanti
 * (`orderQtyRules.sameInstant`), quindi una divergenza puo' stare tutta nell'ora — ed e' proprio il
 * caso in cui l'ora e' l'unica cosa che la spiega. Un messaggio che dicesse «da 09/09 a 09/09»
 * ricreerebbe dall'altro lato il controsenso che questa feature toglie.
 */
function dt(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || '?';
}

/**
 * I lotti di un ordine come li conosce il NOSTRO dizionario, nella forma che questo modulo consuma.
 *
 * NESSUN PRE-FILTRO SU `SplitState`, ed e' la regola RB-02 della 0023 applicata qui: chi dice se un
 * lotto esiste e' Plex. Un `'X'` o un `'R'` sono lotti mai creati e Plex li dichiarera' assenti da
 * se'; un `'U'` e' un esito incerto che potrebbe esistere, e saltarlo per stato sottostimerebbe la
 * somma dei pacchetti — cioe' gonfierebbe il lotto padre.
 *
 * @param {Array<object>} mappingRows righe di `ZProdOrderPlexMapping` di UN ordine
 * @returns {Array<{jobNumber: string, jobId: string|null, splitState: string|null}>}
 */
function lotsFromMapping(mappingRows) {
  return (Array.isArray(mappingRows) ? mappingRows : [])
    .filter((r) => r && r.PlexJobNumber)
    .map((r) => ({
      jobNumber: String(r.PlexJobNumber).trim(),
      jobId: r.PlexJobId ? String(r.PlexJobId).trim() : null,
      splitState: r.SplitState || null
    }));
}

/**
 * Legge da Plex la quantita' di ogni lotto. Una chiamata per lotto, ID-FIRST.
 *
 * L'`id` viene prima del numero perche' e' la regola generale di DEC-80 — un oggetto che esiste si
 * legge per il suo identificativo. Chiedere per numero un job che c'e' era proprio l'errore che
 * faceva rispondere `500` alla `GET /scheduling/v1/jobs?jobNumber=`, e quello non era un difetto di
 * Plex: era nostro. `findJob` tiene comunque il numero in coda, come autorita' sull'ASSENZA — la
 * sola cosa per cui serve.
 *
 * LA LETTURA SI TRACCIA SEMPRE, non solo quando trova: «ho guardato e non c'era» e «non ho potuto
 * guardare» sono due cose diverse e sono l'intero fondamento del fail-closed (W1-03).
 *
 * @param {{get: Function}} plex la tripla Plex, gia' tracciata dal chiamante
 * @param {Array<{jobNumber, jobId}>} lots
 * @returns {Promise<Array<{jobNumber, jobId, verdict, quantity, dueDate, job, error, splitState}>>}
 */
async function readLotQuantities(plex, lots) {
  const out = [];
  for (const lot of Array.isArray(lots) ? lots : []) {
    let read = null;
    try {
      read = await plexJobRead.findJob(plex, { jobNumber: lot.jobNumber, jobId: lot.jobId });
    } catch (e) {
      read = { ok: false, found: null, error: e.message, thrown: true };
    }
    const verdict = qtyRules.lotVerdict(read);
    out.push({
      jobNumber: lot.jobNumber,
      jobId: (read && read.found && read.found.id) || lot.jobId || null,
      splitState: lot.splitState || null,
      verdict,
      quantity: read && read.found ? read.found.quantity : null,
      dueDate: read && read.found ? read.found.dueDate : null,
      job: (read && read.found) || null,
      error: verdict === LOT_VERDICT.INCONCLUSIVE ? ((read && read.error) || 'lettura non conclusiva') : ''
    });
  }
  return out;
}

/**
 * Riassunto delle letture per la traccia: un passo solo, e dice tutto quello che serve.
 *
 * LA `dueDate` STA QUI PERCHE' E' UNA DELLE DUE VARIABILI DEL VERDETTO. Il `PUT` parte se diverge la
 * quantita' OPPURE la data, e finora nessun passo persistito portava le date: «perche' e' partita?»
 * si rispondeva solo da `cf logs`, che si conserva pochi giorni. Una riga di log deve portare le
 * variabili che possono spiegarne il risultato, o una differenza a due variabili viene attribuita a
 * una.
 */
function readSummary(read) {
  return read.map((l) => ({
    jobNumber: l.jobNumber,
    verdict: l.verdict,
    quantity: l.verdict === LOT_VERDICT.FOUND ? l.quantity : null,
    dueDate: l.verdict === LOT_VERDICT.FOUND ? l.dueDate : null,
    splitState: l.splitState,
    ...(l.error ? { error: l.error } : {})
  }));
}

/**
 * [ORDER-SORT-ON-WRITE] L'ordinamento della lista di lavoro Plex (passo 8 della 0014) dopo una
 * scrittura su questo ordine.
 *
 * LA REGOLA E' DETTATA, non dedotta: ogni volta che un ordine di produzione cambia su Plex perche'
 * gli abbiamo mandato dei dati — quantita', data o altro — la lista di lavoro si riordina, dal
 * cockpit come dal job. Questo modulo era l'unica scrittura sull'ordine che non lo faceva, e il
 * commento che lo giustificava («la lista non cambia se la quantita' non e' cambiata») valeva solo
 * per il ramo IN_SYNC, dove infatti non parte niente. Vedi l'addendum del 06/10/2026 a DEC-100.
 *
 * La dipendenza si INIETTA, come `deps.sort` dello spacchettamento: questo modulo non vede le
 * credenziali, e la configurazione si risolve in modo diverso nel job (una volta per run) e
 * nell'action (a ogni invocazione). Assente = nessun ordinamento, cioe' il comportamento di prima.
 *
 * Non lancia, come il passo 8: `runJobSortStep` non lancia per costruzione, e il `try` tiene la
 * stessa promessa anche per una chiusura del chiamante che lo facesse.
 */
async function sortAfterWrite(deps, steps, num) {
  if (!deps || typeof deps.sort !== 'function') return null;
  try {
    return (await deps.sort(steps)) || null;
  } catch (e) {
    console.error(`>>> [ORDER-SORT-ON-WRITE] ordine ${num}: ordinamento non eseguito — ${e.message}`);
    return null;
  }
}

/**
 * Il riallineamento di UN ordine. Non lancia: ogni esito e' un valore di ritorno.
 *
 * @param {object} deps
 * @param {{get, post, put}} deps.plex tripla Plex, gia' passata da `plexCallTrace.wrap` dal chiamante
 *   — qui NON si avvolge di nuovo, o due `wrap` darebbero due contatori `seq` sullo stesso ordine.
 * @param {Function} [deps.sort] `(steps) => Promise<esito di runJobSortStep>`, che appende il proprio
 *   passo a `steps`. Si chiama dopo una scrittura riuscita o rimasta senza risposta
 *   ([ORDER-SORT-ON-WRITE]); l'esito torna nel campo ADDITIVO `sort`, che non entra in `status`.
 * @param {object} o
 * @param {object} o.order riga di `A_ProductionOrder_2` (servono `ManufacturingOrder`,
 *   `TotalQuantity`, `ManufacturingOrderType`)
 * @param {string|null} o.sapDueDate `MfgOrderPlannedEndDate` gia' in ISO
 * @param {Array<object>} o.mappingRows righe di `ZProdOrderPlexMapping` dell'ordine
 * @param {string|null} [o.jobTypeFallback] `PLEX_JOB_TYPE`
 * @returns {Promise<{status, reason, segments, steps, target, sumPackages, currentQty,
 *                    packageCount, written, jobId, note, sort}>}
 */
async function syncOrderQuantity(deps, { order, sapDueDate, mappingRows, jobTypeFallback = null } = {}) {
  const num = order.ManufacturingOrder;
  const steps = [];
  const base = {
    steps, target: null, sumPackages: null, currentQty: null,
    packageCount: 0, written: false, jobId: null, note: '', sort: null
  };

  // ---- Q1: lettura dei lotti su Plex -----------------------------------------------------
  const lots = lotsFromMapping(mappingRows);
  if (!lots.length) {
    // Nessuna riga di dizionario: l'ordine non e' mai stato inviato. Non e' un caso di questo
    // modulo, e chi lo chiama lo sa gia' — resta come rete, dichiarata.
    steps.push({
      step: 'Q1 lettura lotti su Plex',
      request: { ManufacturingOrder: num },
      status: 0,
      response: 'nessun lotto nel dizionario: ordine mai inviato'
    });
    return {
      ...base, status: 'W', reason: TARGET_REASON.MAIN_ABSENT,
      segments: [logMsg.seg('logOrderQtyMainAbsent', num)]
    };
  }

  const read = await readLotQuantities(deps.plex, lots);
  const summary = readSummary(read);
  const unread = read.filter((l) => l.verdict === LOT_VERDICT.INCONCLUSIVE).length;
  steps.push({
    step: 'Q1 lettura lotti su Plex',
    request: { ManufacturingOrder: num, lotti: lots.map((l) => l.jobNumber) },
    status: unread ? 0 : 200,
    response: summary,
    // Lettura di controllo: sta nella traccia e resta fuori dal semaforo (DEC-38).
    aux: true
  });

  // ---- Q2: il calcolo ---------------------------------------------------------------------
  const target = qtyRules.computeMainTarget({
    order: num, sapQty: order.TotalQuantity, lots: read
  });
  Object.assign(base, {
    target: target.target,
    sumPackages: target.sumPackages,
    currentQty: target.mainQty,
    packageCount: target.packageCount
  });

  if (!target.ok) {
    const key = REASON_KEY[target.reason] || 'logOrderQtyMainAbsent';
    const status = REASON_STATUS[target.reason] || 'W';
    // I TRE NUMERI nel messaggio: senza, chi legge non sa se correggere SAP o Plex.
    const segments = target.reason === TARGET_REASON.NEGATIVE
      ? [logMsg.seg(key, num, fmt(order.TotalQuantity), fmt(target.sumPackages), fmt(target.target))]
      : target.reason === TARGET_REASON.LOT_UNREADABLE
        ? [logMsg.seg(key, num, target.unreadable.join(', '))]
        : [logMsg.seg(key, num)];
    steps.push({
      step: 'Q2 calcolo quantita del lotto principale',
      request: {
        ManufacturingOrder: num,
        sapQty: order.TotalQuantity,
        sommaPacchetti: target.sumPackages,
        target: target.target,
        motivo: target.reason
      },
      status: 0,
      response: 'nessuna scrittura verso Plex'
    });
    console.warn(`>>> [ORDER-QTY-SYNC] ordine ${num}: ${target.reason}`
      + ` (SAP ${fmt(order.TotalQuantity)}, pacchetti ${fmt(target.sumPackages)},`
      + ` target ${fmt(target.target)})`);
    return { ...base, status, reason: target.reason, segments };
  }

  const main = qtyRules.splitLots(num, read).main;
  base.jobId = main.jobId;

  const verdict = qtyRules.classifySync({
    target: target.target,
    currentQty: target.mainQty,
    sapDueDate,
    plexDueDate: main.dueDate
  });

  steps.push({
    step: 'Q2 calcolo quantita del lotto principale',
    request: {
      ManufacturingOrder: num,
      sapQty: order.TotalQuantity,
      sommaPacchetti: target.sumPackages,
      pacchettiVivi: target.packageCount,
      quantitaSuPlex: target.mainQty,
      target: target.target,
      // Le due DATE accanto ai due numeri: sono l'altra meta' del verdetto, e senza di esse una
      // riga «aggiornata» su quantita' invariata non e' spiegabile da nessun dato persistito.
      dataSap: sapDueDate || null,
      dataSuPlex: main.dueDate || null,
      esito: verdict.state
    },
    status: 200,
    response: verdict.state,
    aux: true
  });

  // ---- Allineato: nessuna chiamata di scrittura -------------------------------------------
  if (verdict.state === SYNC.IN_SYNC) {
    console.log(`>>> [ORDER-QTY-SYNC] ordine ${num}: gia' allineato (${fmt(target.target)}),`
      + ' nessuna chiamata verso Plex');
    // Il `reason` e' il SIMBOLO e non il letterale: il chiamante lo confronta per decidere se
    // scrivere la riga di storico, e due copie della stessa stringa in due file sono la forma in cui
    // quel confronto smette di agganciare senza che niente fallisca.
    return {
      ...base, status: 'S', reason: SYNC.IN_SYNC,
      segments: [logMsg.seg('logOrderQtyInSync', num, fmt(target.target))]
    };
  }

  // ---- Q3: PUT della testata, con la scala dei due corpi ----------------------------------
  // [JOB-FIELDS] La testata si eredita dal job letto ADESSO e non dall'ordine SAP: un lotto vivo
  // porta addosso cio' che qualcuno ha deciso su Plex, e un `PUT` e' il modello intero — cio' che
  // non si manda si azzera (DEC-77).
  const inherited = inheritedJobFields(main.job, { order, fallback: jobTypeFallback });
  const bodies = jobPutBodies(inherited, { dueDate: sapDueDate, quantity: target.target });

  let put = null;
  for (let i = 0; i < bodies.length; i += 1) {
    const { body, kind, cleared } = bodies[i];
    const isLast = i === bodies.length - 1;
    let r = null;
    let thrown = null;
    try {
      r = await deps.plex.put(`/scheduling/v1/jobs/${main.jobId}`, body);
    } catch (e) {
      thrown = e;
    }
    if (thrown) {
      // [ORDER-SORT-ON-WRITE] `noResponse` e non `status === 0`: la richiesta e' PARTITA e non
      // sappiamo se Plex l'abbia applicata, che e' il caso in cui l'ordinamento si chiama comunque.
      put = {
        ok: false, status: 0, body: null, request: body, error: thrown.message, cleared: [], noResponse: true
      };
      break;
    }
    if (r.ok) {
      put = { ok: true, status: r.status, body: r.body, request: body, error: '', cleared };
      break;
    }
    put = { ok: false, status: r.status, body: r.body, request: body, error: plexErrText(r), cleared: [] };
    // Il ritentativo e' SOLO sui `5xx`: un `4xx` e' un rifiuto conclusivo dello schema, e ripetere
    // con meno campi sarebbe sperare. Stessa regola di `putJobHeader` nello spacchettamento.
    if (isLast || r.status < 500) break;
    steps.push({
      step: 'Q3a Update Job (tentativo scartato)',
      request: body,
      status: r.status,
      response: r.body,
      // Il semaforo deve essere quello del tentativo che DECIDE, non del primo che cade.
      aux: true
    });
  }

  steps.push({
    step: 'Q3 Update Job',
    request: put.request,
    status: put.status,
    response: put.ok ? put.body : (put.body || put.error)
  });

  if (!put.ok) {
    console.error(`>>> [ORDER-QTY-SYNC] ordine ${num}: PUT rifiutato (${put.status}) — ${put.error}`);
    // [ORDER-SORT-ON-WRITE] Un rifiuto CON risposta non ha cambiato niente su Plex: nessun
    // ordinamento. Senza risposta non lo sappiamo, e l'ordinamento si chiama comunque — ricalcola la
    // sola sequenza, quindi chiamarlo per niente costa una richiesta, non chiamarlo lascia la lista
    // nell'ordine sbagliato.
    const sort = put.noResponse ? await sortAfterWrite(deps, steps, num) : null;
    return {
      ...base,
      sort,
      status: 'E',
      reason: 'PUT_FAILED',
      segments: [
        verdict.qtyChanged
          ? logMsg.seg('logOrderQtyPutFailed', num, fmt(verdict.from), fmt(verdict.to))
          : logMsg.seg('logOrderQtyDatePutFailed', num, dt(main.dueDate), dt(sapDueDate)),
        logMsg.technical(put.error)
      ]
    };
  }

  base.written = true;
  const cleared = put.cleared && put.cleared.length
    ? ` (corpo ridotto: ${put.cleared.join(', ')} azzerati su Plex)`
    : '';
  console.log(`>>> [ORDER-QTY-SYNC] ordine ${num}: quantita ${fmt(verdict.from)} -> ${fmt(verdict.to)},`
    + ` consegna ${dt(main.dueDate)} -> ${dt(sapDueDate)}${cleared}`);

  // ---- Q4: rischedulazione, passo ACCESSORIO ----------------------------------------------
  // Il contratto la richiede dopo un cambio di quantita' o data
  // (srv/external/PLEX_JOB_API_CONTRACT.md), e lo spacchettamento la fa gia' (P2). Ma un
  // riallineamento riuscito NON si degrada perche' la rischedulazione e' caduta: [SCHED-CONTINUE].
  const schedBody = { useFirstApprovedWorkcenter: USE_FIRST_APPROVED_WORKCENTER };
  let schedOk = false;
  let schedErr = '';
  try {
    const rs = await deps.plex.post(`/scheduling/v1/jobs/${main.jobId}/backwards-schedule`, schedBody);
    schedOk = rs.ok;
    schedErr = rs.ok ? '' : plexErrText(rs);
    steps.push({
      step: 'Q4 Backwards Schedule',
      request: schedBody,
      status: rs.status,
      response: rs.body,
      aux: true
    });
  } catch (e) {
    schedErr = e.message;
    steps.push({
      step: 'Q4 Backwards Schedule',
      request: schedBody,
      status: 0,
      response: `nessuna risposta: ${e.message}`,
      aux: true
    });
  }

  // ---- Il messaggio NOMINA IL CAMPO CHE E' CAMBIATO ---------------------------------------
  // Il `PUT` parte se diverge la quantita' OPPURE la data (`classifySync`), e con la sola chiave di
  // quantita' un riallineamento innescato dalla DATA si raccontava «aggiornata da 100 a 100»: un
  // controsenso, per giunta su una riga che dichiara una scrittura vera verso Plex.
  //
  // LA CHIAVE E' UNA SECONDA E NON UN'ARITA' CAMBIATA. `MessageJson` si rende ALLA LETTURA (DEC-92),
  // quindi aggiungere parametri a `logOrderQtyUpdated` farebbe stampare `undefined` a ogni riga gia'
  // scritta in produzione. Le due chiavi storiche restano intatte e servono il caso in cui la
  // quantita' e' cambiata davvero.
  //
  // QUANDO CAMBIANO ENTRAMBI il messaggio nomina la QUANTITA', ed e' un limite dichiarato: li' i due
  // numeri differiscono, quindi la riga non si contraddice e una terza chiave non si paga.
  const segments = [verdict.qtyChanged
    ? logMsg.seg('logOrderQtyUpdated', num, fmt(verdict.from), fmt(verdict.to))
    : logMsg.seg('logOrderQtyDateUpdated', num, dt(main.dueDate), dt(sapDueDate), fmt(verdict.to))];
  if (!schedOk) {
    segments.push(logMsg.seg('logOrderQtyScheduleFailed', num));
    segments.push(logMsg.technical(schedErr));
    console.warn(`>>> [ORDER-QTY-SYNC] ordine ${num}: quantita aggiornata, rischedulazione fallita — ${schedErr}`);
  }

  // [ORDER-SORT-ON-WRITE] Ultimo passo, dopo la rischedulazione e anche se questa e' caduta: il
  // valore su Plex e' cambiato comunque (e' la regola di «Ripristina» con R2 fallito, DEC-100).
  const sort = await sortAfterWrite(deps, steps, num);

  return {
    ...base,
    sort,
    status: schedOk ? 'S' : 'W',
    reason: 'UPDATED',
    segments,
    note: cleared.trim()
  };
}

module.exports = {
  syncOrderQuantity,
  readLotQuantities,
  lotsFromMapping,
  readSummary,
  REASON_KEY,
  REASON_STATUS,
  USE_FIRST_APPROVED_WORKCENTER
};

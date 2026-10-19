/**
 * [IS-CALL-LOG] REGOLE PURE DEL DUMP: quali letture si dichiarano su stdout, e come.
 * ============================================================================
 * `srv/lib/isCallLog.js` cattura per ogni lettura verso gli iFlow l'indirizzo completo, il `$top`,
 * il `$select`, lo stato HTTP REALE e il CORPO CRUDO (prima del purge OData di CAP). Ma l'anello è
 * per processo, e in un run batch nessuna rotta HTTP lo raggiunge: quelle informazioni esistevano e
 * morivano col processo. Qui stanno le regole con cui una voce esce su stdout, dove `cf logs` la
 * raccoglie — e i tre gettoni della riga M-07 (`readLineTokens`), che stanno qui per la stessa
 * ragione: perché siano collaudabili.
 *
 * PERCHE' PURO. Un modulo che non ha modo di fare rete non può innescare una chiamata: DEC-72 («una
 * sonda non si innesca da sola») diventa una proprietà della FORMA del modulo invece di una promessa
 * nei commenti. L'unico `require` è `./isEgress`, che a sua volta non ne ha nessuno — quindi il test
 * gira con `node test/isCallDumpRules.test.js`, senza runtime CAP e senza database.
 *
 * ============================================================================
 * IL CRITERIO E' DELLA VOCE, NON DEL RUN
 * ============================================================================
 * Le due forme che vengono in mente per prime cadono entrambe, e vale sapere perché:
 *
 *   - un dump A FINE RUN non può funzionare. L'anello tiene 200 voci (`IS_CALL_LOG_SIZE`) e un run
 *     di MAT_SYNC ne produce centinaia — una per `run()`, quindi una per pagina di `pagedRead`, una
 *     per chunk, una per candidato di classificazione. A fine run le PRIME non esistono più, e la
 *     prima è la lettura di perimetro: cioè esattamente quella dell'incidente del 02/09/2026. Un
 *     dump a fine run è strutturalmente incapace di mostrare il caso per cui lo si scrive. In più
 *     `process.exit()` su una pipe tronca un burst di corpi.
 *
 *   - un dump LEGATO ALL'ESITO DEL RUN non c'è quando serve. Uno zero silenzioso chiude `S`: il
 *     02/09/2026 `PROD_ORDER` ha letto zero ordini e ha chiuso in verde. Un criterio che guarda
 *     l'esito tace proprio sul difetto che deve rendere visibile.
 *
 * Quindi ogni voce si giudica APPENA NASCE, adiacente alla sua riga M-07: non può essere sfrattata
 * dall'anello, non può essere perduta da un SIGKILL (su CF lo shutdown ha 8 secondi e su OOM-kill
 * nessun handler gira), e le scritture sono distribuite sui minuti del run invece che in un burst.
 *
 * ============================================================================
 * I TRE MOTIVI, E LE ESCLUSIONI CHE VALGONO QUANTO LORO
 * ============================================================================
 *   KO               esito KO, qualunque forma. Sempre.
 *   ZERO_COLLECTION  zero righe su una LISTA. E' il caso ambiguo per costruzione: DEC-49 (un `200`
 *                    con `results` vuoto perche' manca il plant nel criterio) e l'incidente del
 *                    02/09. Il corpo crudo e' l'unica cosa che distingue «vuoto ben formato» da
 *                    «dati che non riconosciamo».
 *   NOT_MEASURED     il tap sulla risposta non ha agganciato: NON sappiamo cosa e' arrivato. E' una
 *                    proprieta' del trasporto e non della lettura, quindi si dichiara UNA VOLTA per
 *                    processo — su un canale dove il tap non aggancia mai, ogni voce sarebbe
 *                    notevole e il log diventerebbe illeggibile.
 *
 * ZERO RIGHE SU UNA LETTURA PER CHIAVE NON E' NOTEVOLE, e questa esclusione è una difesa quanto i
 * tre motivi sono una dichiarazione: là l'assenza è una risposta legittima (un `404` su fan-out è
 * «elemento assente», già dichiarato nella nota `N elementi assenti`), e includerla darebbe 300 dump
 * su un run con 300 chiavi. Un log che nessuno legge più non protegge niente. Chi la vuole comunque
 * ha `IS_CALL_LOG_DUMP=all` per un run solo.
 *
 * Fuori sempre, anche con `all`:
 *   - l'area `plex`, che ha GIA' corpo inviato e ricevuto in `cf logs` via `plexCallTrace` — qui
 *     apparirebbero due volte;
 *   - le sonde (`form` = `sonda N`), che stampano il proprio gruppo con il proprio verdetto.
 *
 * Scartati DI PROPOSITO, e il perché è la parte che serve al prossimo lettore:
 *   - troncamento sospetto (`righe === $top`): le pagine di `pagedRead` sono PIENE per costruzione,
 *     quindi ogni pagina di MAT_SYNC sarebbe notevole. Ha già la sua `console.warn` in `runOne`.
 *   - righe prive di identità (`[IS-BLANK-ROWS]`): ha già la sua `console.warn`, e riconoscerla da
 *     qui richiederebbe di annusare il testo di `notes` — un criterio fragile.
 *
 * ============================================================================
 * GLI HEADER NON ESCONO MAI
 * ============================================================================
 * `isCallLog` maschera gli header con una DENYLIST (`SECRET_HEADER`), che copre i nomi noti e non
 * un nome nuovo — `x-sap-assertion`, `sap-passport`, quello che l'iFlow aggiungerà domani. Verso il
 * browser è un rischio accettato; `cf logs` è un canale conservato e inoltrabile, quindi qui il
 * campo `headers` è escluso IN BLOCCO, mascherato o no. E' DEC-96 («si persiste il corpo, non gli
 * header»), e il difetto che questa regola previene non produrrebbe nessun errore: solo un segreto
 * in un log, in modo irreversibile. `test/isCallDumpRules.test.js` lo sorveglia.
 */

'use strict';

// Il NOME del marcatore di run batch si importa, non si copia: un secondo letterale non darebbe
// errore, darebbe un dump che non parte in un job o che parte nel server web (stessa ragione di
// `runJob.js`, e `test/isEgress.test.js` sorveglia che quel nome viva in un posto solo).
const { IS_BATCH_ENV } = require('./isEgress');

/** La leva del dump, nella convenzione `on|off|valore dichiarato` che il progetto usa già. */
const DUMP_ENV = 'IS_CALL_LOG_DUMP';
/** Quanti CORPI completi per processo. Oltre, la voce notevole ha la sola testata. */
const MAX_ENV = 'IS_CALL_LOG_DUMP_MAX';
const DEFAULT_MAX = 20;

/** I motivi, come stringhe: finiscono nel log e nel censimento, quindi sono anche etichette. */
const DUMP_REASONS = Object.freeze({
  KO: 'KO',
  ZERO_COLLECTION: 'ZERO_COLLECTION',
  NOT_MEASURED: 'NOT_MEASURED',
  ALL: 'ALL'
});

/**
 * Le due forme che sono LISTE, cioè quelle su cui zero righe è ambiguo.
 *
 * I letterali sono quelli assegnati in `isRemoteSource.js` (`collection`, `collection + $filter`,
 * `fan-out per chiave`, `key predicate`) e sono gli stessi che il browser mostra. Le altre due —
 * le letture per chiave — sono fuori di proposito: vedi la testata.
 */
const COLLECTION_FORMS = Object.freeze(['collection', 'collection + $filter']);

/** Le sonde hanno il loro canale: `form` = `sonda 3`, `sonda V5`, … */
const PROBE_FORM = /^sonda\b/i;

/** Le chiamate Plex hanno già corpo inviato e ricevuto in `cf logs` (plexCallTrace). */
const PLEX_AREA = 'plex';

const s = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * Il cancello: se il dump è attivo in questo processo, e con quale ampiezza.
 *
 * L'AMBIENTE SI LEGGE AL MOMENTO DELL'USO, e non è un dettaglio di stile. `runJob()` scrive
 * `MARS_BATCH_JOB` nel proprio ambiente DOPO che il file del job ha già fatto i suoi `require` —
 * che tirano dentro `isCallLog`, e quindi questo modulo. Una costante calcolata al `require`
 * direbbe «server web» in OGNI job, senza dare nessun errore: è la trappola che DEC-98 nomina, e la
 * forma giusta è quella di `listMaxRows()` in `prodOrderSource.js`.
 *
 * Il default è «solo in un processo batch»: nel server web l'anello è già raggiungibile da
 * `window.isCalls()`, e 8000 caratteri per ogni lettura a zero righe del cockpit sarebbero rumore
 * nuovo in un log che oggi non ce l'ha.
 *
 * @param {object} env normalmente `process.env`, ma passato per parametro: è ciò che rende il
 *   cancello collaudabile senza toccare l'ambiente del processo di test.
 */
function resolveDumpGate(env = {}) {
  const raw = s(env[DUMP_ENV]).trim();
  const lever = raw.toLowerCase();
  const job = s(env[IS_BATCH_ENV]).trim();
  const max = dumpMax(env);

  if (lever === 'off') {
    return { on: false, all: false, max, batch: !!job, jobCode: job, why: `forzato da ${DUMP_ENV}=off` };
  }
  if (lever === 'on') {
    return { on: true, all: false, max, batch: !!job, jobCode: job, why: `forzato da ${DUMP_ENV}=on` };
  }
  if (lever === 'all') {
    return {
      on: true, all: true, max, batch: !!job, jobCode: job,
      why: `forzato da ${DUMP_ENV}=all — OGNI lettura, non solo le notevoli`
    };
  }

  // Un valore non riconosciuto si comporta come assente E LO DICHIARA: un `=false` battuto per
  // distrazione non deve somigliare a un `=off` che funziona.
  const unknown = raw ? ` — ${DUMP_ENV}=${raw} NON RICONOSCIUTO (ammessi: on|off|all)` : '';
  return job
    ? { on: true, all: false, max, batch: true, jobCode: job, why: `run batch ${job}${unknown}` }
    : {
      on: false, all: false, max, batch: false, jobCode: '',
      why: `server web (nessun ${IS_BATCH_ENV} nell'ambiente)${unknown}`
    };
}

/** Il tetto dei corpi. `0` = illimitato; un valore non numerico ricade sul default dichiarato. */
function dumpMax(env = {}) {
  const raw = s(env[MAX_ENV]).trim();
  if (!raw) return DEFAULT_MAX;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX;
  return n;
}

/** Questa forma è una lista? Solo qui zero righe è un'informazione ambigua. */
function isCollectionForm(form) {
  return COLLECTION_FORMS.includes(s(form).trim());
}

/**
 * Va dichiarata questa voce? E per quale motivo?
 *
 * @returns {{dump: boolean, reason: string, once: boolean}} `once` = motivo da dichiarare una volta
 *   sola per processo (è una proprietà del trasporto, non della singola lettura).
 */
function dumpVerdict(row = {}, opts = {}) {
  const form = s(row.form).trim();

  // Le due esclusioni assolute: hanno già il loro canale, e qui il corpo apparirebbe due volte.
  if (s(row.area).trim().toLowerCase() === PLEX_AREA) return { dump: false, reason: '', once: false };
  if (PROBE_FORM.test(form)) return { dump: false, reason: '', once: false };

  if (s(row.outcome).trim().toUpperCase() === 'KO') {
    return { dump: true, reason: DUMP_REASONS.KO, once: false };
  }

  // Zero righe su una LISTA. Su una lettura per chiave no: vedi la testata — è la difesa dal flood,
  // e togliere questo `isCollectionForm` non farebbe fallire nessun test funzionale, riempirebbe
  // `cf logs` di 300 dump su un run con 300 chiavi assenti.
  if ((Number(row.rows) || 0) === 0 && isCollectionForm(form)) {
    return { dump: true, reason: DUMP_REASONS.ZERO_COLLECTION, once: false };
  }

  // Il tap non ha agganciato: non sappiamo cosa è arrivato. `calls > 0` perché senza chiamate non
  // c'è niente da misurare.
  if (!row.rawSeen && (Number(row.calls) || 0) > 0) {
    return { dump: true, reason: DUMP_REASONS.NOT_MEASURED, once: true };
  }

  if (opts.all) return { dump: true, reason: DUMP_REASONS.ALL, once: false };

  return { dump: false, reason: '', once: false };
}

/**
 * La riga che NOMINA LA CAUSA invece di descrivere il sintomo.
 *
 * Si compone dai soli dati già nella voce — `rows`, `form`, `top`, `rawSeen`, `rawHasD`, lunghezza
 * del corpo — e ricalca il ramo `rows === 0` che il browser ha già in `util/IsCallLog.js`. La
 * duplicazione è accettata e dichiarata: UI5 non può fare `require` da `srv/`, e questo testo è
 * CONSULTIVO — nessun comportamento dipende da lui, mentre la classificazione (`ZERO_COLLECTION` e
 * compagnia) vive in un punto solo, qui sopra.
 *
 * `rawSeen: false` dice «NON MISURATO» e MAI «VUOTO»: vuoto non è ignoto, ed è la stessa distinzione
 * che il progetto fa in `jobScheduleProbe` e in `[PART-ALIVE]`.
 */
function zeroRowsAdvice(row = {}) {
  const body = s(row.rawBody);
  const top = Number(row.top) || 0;
  const topNote = isCollectionForm(row.form)
    ? (top
      ? ` Il $top C'ERA (${top}).`
      : ' E il $top NON C\'ERA: verso questi iFlow una lista senza tetto e\' un rischio dichiarato,'
        + ' e il sospetto di troncamento della sorgente si accende solo se il tetto c\'e\'.')
    : '';

  if (!row.rawSeen) {
    return 'NON MISURATO: il tap sulla risposta non ha agganciato questa chiamata, quindi non'
      + ' sappiamo cosa e\' arrivato. Non e\' «vuoto»: e\' ignoto.' + topNote;
  }
  if (!body) {
    return 'NESSUN CORPO nella risposta: non e\' un OData vuoto, e\' una risposta senza payload.'
      + topNote;
  }
  if (!row.rawHasD) {
    return 'Corpo con dati dentro ma SENZA involucro `d`: le righe ci sono e non le riconosciamo'
      + ' come OData V2 — il purge di CAP le butta.' + topNote;
  }
  return 'OData ben formato e VUOTO: la risposta e\' arrivata, la forma e\' giusta, le righe non ci'
    + ' sono. Quindi il problema e\' a monte (iFlow, RFC, autorizzazioni dell\'utenza del canale)'
    + ' oppure nei criteri.' + topNote;
}

/**
 * La voce resa in righe di testo. NON tocca `row.headers` — vedi la testata del file.
 *
 * Ogni riga porta tag, processo e `#seq` perché in `cf logs` lo stdout del figlio del fork è LO
 * STESSO del server web (`silent: false`), e il `seq` dell'anello è per processo: `#12` del job e
 * `#12` del cockpit convivono nello stesso flusso. Senza discriminante una riga non è attribuibile
 * proprio dove serve confrontare job e cockpit.
 */
function dumpLines(row = {}, opts = {}) {
  const who = `${opts.jobCode || 'web'}/pid ${opts.pid || 0} #${row.seq || 0}`;
  const p = (text) => `>>> [IS-CALL-LOG] DUMP ${who} | ${text}`;
  const label = `${s(row.area)}/${s(row.entity)} ${s(row.op)}`
    + (row.derivedOp && row.derivedOp !== row.op ? ` (derivata ${row.derivedOp})` : '');
  // Gli STESSI gettoni della riga M-07: due rese della stessa cosa divergerebbero, e chi confronta
  // la riga col dump si troverebbe due numeri diversi per lo stesso `$select`.
  const tok = readLineTokens(row);
  const cols = s(row.columns);
  const out = [];

  out.push(p(`${label} | ${s(row.outcome)} | righe ${Number(row.rows) || 0}`
    + ` | chiamate ${Number(row.calls) || 0} | ${Number(row.ms) || 0} ms | ${s(row.at)}`));
  out.push(p(`MOTIVO ${opts.reason || '?'} | canale ${s(row.mode)}`
    + ` | destination ${tok.destination} | forma ${s(row.form)}`));
  out.push(p(`root ${s(row.root)}`));
  out.push(p(`criteri: ${s(row.criteria) || '(nessuno)'}`
    + ` | ${tok.top} | ${tok.columns}: ${cols || '(nessuna)'}`));

  if (opts.bodyOmitted) {
    out.push(p(`CORPO OMESSO: tetto di ${opts.max} dump completi per processo raggiunto (${MAX_ENV})`));
    return out;
  }

  const urls = s(row.urls).split('\n').filter(Boolean);
  urls.forEach((u, i) => out.push(p(`URL ${i + 1}/${urls.length}: ${u}`)));
  if (!urls.length) out.push(p('URL: nessuno catturato dal tap'));

  out.push(p(`risposta: HTTP ${Number(row.rawStatus) || '(non dichiarato)'}`
    + ` | content-type ${s(row.responseContentType) || '(assente)'}`
    + ` | involucro \`d\` ${row.rawHasD ? 'SI\'' : 'NO'}`
    + ` | corpo ${s(row.rawBody).length} car.${row.rawSeen ? '' : ' | TAP NON AGGANCIATO'}`));
  if (s(row.rawBody)) out.push(p(`corpo CRUDO: ${s(row.rawBody)}`));
  if (s(row.notes)) out.push(p(`note: ${s(row.notes)}`));
  if (s(row.error)) {
    out.push(p(`errore: ${s(row.error)}`
      + (row.upstreamStatus ? ` [stato reale upstream: ${row.upstreamStatus}]` : '')));
    if (s(row.responseBody)) out.push(p(`corpo d'errore: ${s(row.responseBody)}`));
  }
  // Il campione dei dati serve SOLO dove il corpo crudo non c'è: altrimenti è un sottoinsieme di
  // quello, dopo il purge di CAP, cioè informazione peggiore già presente.
  if (!row.rawSeen && s(row.firstRow)) out.push(p(`campione (dopo il purge di CAP): ${s(row.firstRow)}`));

  if ((Number(row.rows) || 0) === 0 && s(row.outcome).toUpperCase() !== 'KO') {
    out.push(p(`=> ${zeroRowsAdvice(row)} Confronto: la stessa lettura dal cockpit, window.isCalls().`));
  }
  return out;
}

/**
 * I TRE GETTONI della riga M-07: canale, tetto chiesto, ampiezza del `$select`.
 *
 * Stanno qui e non inline in `isRemoteSource.run()` per una ragione sola: là non sono collaudabili
 * — `run()` vuole il runtime CAP e le destination — e questi tre gettoni esistono *proprio* perché
 * il 02/09/2026 sono mancati. Una difesa che non si può vedere fallire non è una difesa.
 *
 * `$top ASSENTE` è scritto e non omesso: è ciò che permette di escludere il tetto come causa invece
 * di dedurlo dal codice. `$select N col.` dice QUANTE e non QUALI — per quali serve il dump.
 */
function readLineTokens({ destination, top, columns } = {}) {
  const cols = s(columns);
  return {
    destination: s(destination) || '(non dichiarata)',
    top: Number(top) > 0 ? `$top ${Number(top)}` : '$top ASSENTE',
    columns: !cols
      ? '$select (nessuna)'
      : (cols === '(tutti)' ? '$select (tutti)' : `$select ${cols.split(',').length} col.`)
  };
}

/** La riga di attivazione, una per processo, alla prima voce (non al `require`: là non c'è il marcatore). */
function activationLine(gate = {}) {
  return '>>> [IS-CALL-LOG] DUMP attivo: ' + s(gate.why)
    + (gate.all
      ? ' — si dichiara OGNI lettura'
      : ' — si dichiarano le letture KO, quelle con ZERO righe su una lista e la prima non misurata dal tap')
    + `; tetto ${gate.max === 0 ? 'nessuno' : `${gate.max} corpi`}.`
    + ` Spegnimento: ${DUMP_ENV}=off; tutte: =all`;
}

/**
 * Il censimento di fine run: una riga sola.
 *
 * Serve a togliere un'ambiguità che costa quanto il difetto: un log SENZA dump non distingue
 * «nessuna lettura sospetta» da «il dump era spento o esaurito». Ed è abbastanza corta da
 * sopravvivere al `process.exit()` che segue.
 */
function censusLine(stats = {}) {
  if (stats.off) {
    return '[IS-CALL-LOG] traccia SPENTA (IS_CALL_LOG=off): nessuna voce registrata, nessun dump.'
      + ' NON significa che le letture siano andate bene.';
  }
  const entries = Number(stats.entries) || 0;
  const declared = Number(stats.declared) || 0;
  const byReason = stats.byReason || {};
  const detail = Object.keys(byReason).sort().map((k) => `${byReason[k]} ${k}`).join(', ');
  if (!stats.on) {
    return `[IS-CALL-LOG] letture verso SAP: ${entries} voci, dump non attivo (${s(stats.why)}).`;
  }
  return `[IS-CALL-LOG] letture verso SAP: ${entries} voci, `
    + (declared ? `${declared} dichiarate in dump (${detail})` : 'nessuna da dichiarare')
    + `, ${Number(stats.suppressed) || 0} corpi omessi per tetto.`;
}

module.exports = {
  DUMP_ENV,
  MAX_ENV,
  DEFAULT_MAX,
  DUMP_REASONS,
  COLLECTION_FORMS,
  resolveDumpGate,
  dumpMax,
  isCollectionForm,
  dumpVerdict,
  zeroRowsAdvice,
  readLineTokens,
  dumpLines,
  activationLine,
  censusLine
};

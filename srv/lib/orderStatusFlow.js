/**
 * ============================================================================
 * [ORDER-COMPLETE] [ORDER-SCHEDULED] Regole pure dei flussi «stato del job Plex -> stato utente
 * sull'ordine SAP» (feature 0045, generalizzate dalla 0046)
 * ============================================================================
 *
 * DUE FLUSSI, UNA LOGICA. Un job batch legge da Plex i job in un certo stato e lo dichiara
 * sull'ordine di produzione SAP collegato, chiamando un Function Import che su questo sistema
 * imposta uno STATO UTENTE informativo — non un cambio di stato di sistema:
 *
 *   COMPLETE   `Completed` -> `CloseOrder`       «il lotto e' finito»       (0045, gap W1-12)
 *   SCHEDULED  `Scheduled` -> `TechlyCmpltOrder` «il lotto e' pianificato»  (0046, gap W1-11)
 *
 * PERCHE' UN MODULO SOLO. I due flussi condividono circa l'85% delle regole: l'incrocio col
 * dizionario dei lotti, la classificazione dell'esito SAP, la macchina a stati, la prenotazione, la
 * quarantena, il recap. Una seconda copia e' il difetto che questo repo ha gia' pagato due volte —
 * la paginazione del perimetro materiali (0035/0040, chiusa da `pagedRead`) e l'auto-assegnazione —
 * e la forma della soluzione e' quella dichiarata in CLAUDE.md: un modulo puro condiviso che i
 * legami di flusso RI-ESPORTANO INVARIATO, come `compSourceRules.js` per
 * `routingCompSourceRules.js`.
 *
 * CIO' CHE DIFFERISCE STA TUTTO IN UN DESCRITTORE, e sono sette campi: `jobCode`, `sourceCode`,
 * `callKey`, `msg` (il prefisso delle chiavi i18n), `defaultStatuses`, `configEntity`,
 * `stateEntity`, `excLogOperation`. Le funzioni che ne hanno bisogno sono QUATTRO su quaranta, e
 * `bindFlow` le lega: tutte le altre non sanno che i flussi esistono, ed e' questa la misura di
 * quanto la generalizzazione era dovuta.
 *
 * IL FLUSSO E' UN ARGOMENTO OBBLIGATORIO, senza default. Un default — `flow = FLOW_COMPLETE` —
 * avrebbe reso una dimenticanza indistinguibile da una scelta: il flusso `SCHEDULED` avrebbe letto
 * il customizing del `COMPLETE` e scritto lo stato utente sbagliato, senza nessun errore. Chi
 * chiama passa da `bindFlow`, che il flusso ce l'ha.
 *
 * FUNZIONI PURE: nessuna rete, nessun orologio (`now` arriva da fuori). Le due funzioni che toccano
 * il database prendono `db` per argomento e stanno qui per la stessa ragione per cui ci stanno
 * `loadTecoConfig` e `resolveTecoScope`: sono la lettura del customizing, cioe' l'unica cosa che il
 * job deve poter fare prima di sapere se ha qualcosa da fare.
 *
 * ============================================================================
 * LE QUATTRO ASIMMETRIE DI QUESTO FLUSSO, E PERCHE' NON SI COPIANO DA `prodOrderTeco.js`
 * ============================================================================
 *
 * 1. IL CRITERIO E' UN NOME DI STATO PLEX, ed e' il PRIMO del progetto. DEC-70 §4 lo evitava di
 *    proposito — «i nomi di stato sono configurazione del tenant (DEC-65), e un criterio che cambia
 *    da cliente a cliente non e' un presidio» — e li' era vero, perche' li' il presidio contro il
 *    doppio invio era lo stato per lotto. Qui il nome di stato NON e' il presidio: e' il criterio di
 *    INGRESSO, cioe' la domanda «questo job e' finito?», e a quella domanda non risponde nient'altro.
 *    Conseguenze: sta in customizing per plant, il confronto e' TOLLERANTE (un lato lo digita una
 *    persona, DEC-51), e il caso «il criterio non aggancia niente» si DICHIARA nel recap con gli
 *    stati distinti visti — perche' altrimenti un refuso e un plant fermo darebbero lo stesso zero.
 *
 * 2. IL TETTO DEI TENTATIVI SI CONSUMA SOLO SUI RIFIUTI APPLICATIVI. L'unico esito misurato su
 *    quell'iFlow, il 13/08/2026, e' il GUSCIO DI MESSAGGIO VUOTO: la struttura del `BAPIRET2`
 *    arriva coi suoi campi e tutti i valori nulli, cioe' «non conclusivo». Con il tetto che lo
 *    consuma, il primo run porterebbe OGNI ordine in `'X'` terminale senza aver scritto niente, e in
 *    verde: il flusso archivierebbe l'intero arretrato. E' lo stesso principio di RB-12 della 0023
 *    (una chiamata che non parte non consuma un tentativo) esteso a una che non CONCLUDE.
 *
 * 3. LA POLARITA' DEL RITENTATIVO E' LA TERZA DEL PROGETTO. `classifyFailure` (documento materiale)
 *    e `classifyConfirmation` (conferma d'ordine) dichiarano PERMANENTE l'esito non conclusivo,
 *    perche' un movimento duplicato e' un danno e una conferma ripetuta e' quantita' in piu'. Uno
 *    stato utente informativo non ha quel rischio: impostarlo due volte lascia lo stesso stato,
 *    NON impostarlo lascia l'ordine muto per sempre. La premessa e' l'idempotenza della FM, ed e'
 *    dichiarata come tale: se cadesse, cambia solo `classifyOrderClose`.
 *
 * 4. UNA PRENOTAZIONE ORFANA SI RITENTA, che e' l'opposto di `ZProdOrderTecoState`. Per la stessa
 *    ragione del punto 3. Il ciclo pero' e' BOUNDED, e il meccanismo e' sottile: la prenotazione
 *    INCREMENTA `Attempts`, e `nextState` lo RIPORTA al valore precedente quando l'esito non
 *    consuma. Cosi' una morte del processo lascia il tentativo consumato — che e' cio' che impedisce
 *    a un guasto ciclico di girare per sempre — mentre un esito non conclusivo no.
 *    `nextState` riceve percio' `attempts` PRE-prenotazione, cioe' il valore che il job ha letto
 *    dalla riga all'inizio del giro: non quello che la prenotazione ha appena scritto.
 *
 * Perimetro completo: grep -rn "ORDER-COMPLETE"
 * Collaudo: test/prodOrderComplete.test.js
 */

'use strict';

// [LOG-MSG-I18N] I messaggi di questo modulo sono SEGMENTI (feature 0031): chiave i18n piu'
// parametri, non prosa. Il testo si rende dove si scrive — il job — perche' rendere qui vorrebbe
// dire leggere i bundle da disco, e questo modulo si collauda senza toccare niente.
const logMsg = require('./logMessage');
// Il plant delle righe la cui attribuzione non e' stata possibile. NON si ricopia il letterale.
const { PLANT_NA: PLANT_UNKNOWN } = require('./jobCodes');

/**
 * FQN come stringa e non `db.entities(NS)`: quello e' deprecato in CAP 9 e non e' invocabile in
 * contesto job standalone. Stessa scelta di prodOrderTeco.js e dei job.
 */
const NS = 'avvaleplm.marsplm.sap2plex';

/**
 * I DUE FLUSSI. E' l'unica cosa che li distingue, ed e' congelata: un descrittore mutato a runtime
 * farebbe scrivere a un flusso lo stato utente dell'altro.
 *
 * `sourceCode` e' la sorgente della finestra su `ZJobReadWatermark`, e vale `null` per il flusso
 * SCHEDULED: quel flusso NON ha un watermark, perche' `Scheduled` non ha un asse temporale su cui
 * costruirlo — `GET /scheduling/v1/jobs` non ha nessun filtro su una data di modifica o di cambio
 * stato. Il `null` non e' una dimenticanza: e' l'affermazione che quel flusso legge una
 * FOTOGRAFIA dello stato e non una finestra di eventi.
 */
const FLOW_COMPLETE = Object.freeze({
  key: 'COMPLETE',
  jobCode: 'ORDER_COMPLETE',
  sourceCode: 'JOB_COMPLETED',
  callKey: 'close',
  msg: 'logComplete',
  defaultStatuses: Object.freeze(['Completed']),
  configEntity: `${NS}.ZProdOrderCompleteConfig`,
  stateEntity: `${NS}.ZProdOrderCompleteState`,
  excLogOperation: 'COMPLETED'
});

const FLOW_SCHEDULED = Object.freeze({
  key: 'SCHEDULED',
  jobCode: 'ORDER_SCHEDULED',
  sourceCode: null,
  callKey: 'teco',
  msg: 'logScheduled',
  defaultStatuses: Object.freeze(['Scheduled']),
  configEntity: `${NS}.ZProdOrderScheduledConfig`,
  stateEntity: `${NS}.ZProdOrderScheduledState`,
  excLogOperation: 'SCHEDULED'
});

const FLOWS = Object.freeze({ COMPLETE: FLOW_COMPLETE, SCHEDULED: FLOW_SCHEDULED });

/** Stati di ZProdOrderCompleteState. La semantica per intero e' in db/schema.cds. */
const STATE = Object.freeze({
  DETECTED: 'D',
  QUARANTINE: 'Q',
  CLAIMED: 'P',
  APPLIED: 'A',
  FAILED: 'E',
  EXHAUSTED: 'X'
});

/**
 * Stati da cui una riga non torna candidata da sola.
 *
 * `'X'` e' qui, ma e' RI-ARMABILE con un'azione esplicita: e' la differenza con
 * `ZProdOrderTecoState`, dove un lotto esaurito resta aperto su Plex e dichiarato. Qui un elenco di
 * messaggi definitivi sbagliato archivierebbe ordini che sarebbero passati, e senza una via di
 * ritorno il rimedio sarebbe una UPDATE a mano sul database.
 */
const TERMINAL_STATES = Object.freeze([STATE.APPLIED, STATE.EXHAUSTED]);

/** Gli stati che il passo 0 ripesca dal database. `'P'` solo se stantia (vedi `staleCutoff`). */
const RESUMABLE_STATES = Object.freeze([STATE.DETECTED, STATE.FAILED, STATE.QUARANTINE]);

/** Esiti di un tentativo di scrittura, come li dichiara il job. */
const OUTCOME = Object.freeze({
  APPLIED: 'applied',      // SAP ha risposto senza errori
  PENDING: 'pending',      // un interruttore e' chiuso: non si e' chiamato niente
  QUARANTINE: 'quarantine',// nessun ordine SAP risolto
  REJECTED: 'rejected',    // rifiuto applicativo riconosciuto
  INCONCLUSIVE: 'inconclusive', // e' arrivato e non si sa cosa ha fatto
  FAILED: 'failed'         // guasto di trasporto: non e' arrivato
});

/** Le quattro profondita' di `depthOf` in srv/lib/prodOrderStatusPost.js. */
const DEPTH = Object.freeze({
  NONE: 'NESSUNA_RISPOSTA',
  IFLOW: 'IFLOW',
  FM: 'FM',
  DONE: 'ESEGUITO'
});

/** I tipi `BAPIRET2` che dicono «non fatto». `A` e' l'abort, ed e' un errore a tutti gli effetti. */
const ERROR_TYPES = Object.freeze(['E', 'A', 'X']);

/**
 * Gli stati Plex di default stanno nei DESCRITTORI qui sopra — `Completed` per il flusso COMPLETE,
 * `Scheduled` per SCHEDULED. Sono i valori OSSERVATI sul tenant, non convenzioni di progetto: sono
 * il default perche' cosi' un plant configurato con la sola casella accesa fa la cosa giusta, ma
 * restano sovrascrivibili perche' l'elenco degli stati e' della tabella di setup del tenant
 * (DEC-65).
 */

/**
 * Tetto della colonna `PlexStatuses`, che e' `String(600)` come TUTTE le liste di customizing del
 * progetto. Non e' un numero scelto qui: e' `LIST_MAX_LENGTH` di prodOrderStatusFilter.js, e la
 * ragione di tenerlo uguale e' DEC-40 — un solo limite e una sola validazione.
 */
const LIST_MAX_LENGTH = 600;

/** Il separatore, come in ogni altra lista di customizing. */
const SEP = ';';

// ---------------------------------------------------------------------------------------------
// Utilita'
// ---------------------------------------------------------------------------------------------

/**
 * Il flusso e' OBBLIGATORIO, e la sua assenza e' un difetto di programmazione.
 *
 * Non c'e' un default, e non e' pedanteria: con `flow = FLOW_COMPLETE` una dimenticanza sarebbe
 * indistinguibile da una scelta — il flusso SCHEDULED leggerebbe il customizing del COMPLETE e
 * scriverebbe lo stato utente sbagliato, senza nessun errore da nessuna parte. Meglio un'eccezione
 * al primo run in sviluppo.
 */
function requireFlow(flow, where) {
  if (!flow || !flow.key || !flow.msg || !flow.callKey) {
    throw new Error(`[ORDER-STATUS-FLOW] ${where}: il descrittore di flusso è obbligatorio. `
      + 'È un difetto di programmazione, non un dato mancante: si passa da `bindFlow`.');
  }
  return flow;
}

/** `trim` e nient'altro. */
function s(v) {
  return String(v ?? '').trim();
}

/** Troncamento per i campi String(n) dello stato: HANA impone i limiti, sqlite no. */
function cut(v, n) {
  return v === null || v === undefined ? null : String(v).slice(0, n);
}

/**
 * Un booleano che arriva dal database, in TRE forme.
 *
 * `1` non e' decorativo: SQLite non ha un tipo booleano e restituisce l'intero, HANA il booleano, e
 * un `PATCH` da UI puo' portare la stringa. Guardare il solo `=== true` fa apparire SPENTO in
 * sviluppo un interruttore che in produzione e' acceso — cioe' un difetto che si manifesta solo
 * nell'ambiente in cui non lo si collauda. Stessa lettura di `loadTecoConfig`.
 */
function isTrue(v) {
  return v === true || v === 1 || v === 'true' || v === 'X';
}

/**
 * Un intero da una variabile d'ambiente, col default su qualunque cosa non lo sia.
 *
 * `parseInt('abc')` e' `NaN` e `NaN > 0` e' falso: senza questo controllo un refuso TOGLIEREBBE il
 * tetto invece di ricadere sul default, che e' il modo silenzioso di rompere una leva di sicurezza.
 * Stessa funzione e stessa ragione di `intEnv` in srv/jobs/closeTecoPlexJobs.js — qui e' pura, e
 * quindi collaudata.
 */
function intEnv(env, name, def) {
  const raw = (env || {})[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return n;
}

/**
 * Il numero d'ordine in formato INTERNO, per l'EMISSIONE verso la function module.
 *
 * `AUFNR` e' `CHAR(12)` con conversion exit `ALPHA`: un ordine numerico va riempito a zeri a
 * sinistra. Leggerlo da SAP non basta, perche' sul canale Integration Suite arriva anche senza
 * riempimento — il riempimento e' dell'emissione, come `internalConfKeys` in prodOrderConfKey.js
 * (DEC-58/DEC-59), e non contraddice il divieto di normalizzare i valori LETTI: l'asse e'
 * leggere contro scrivere.
 *
 * SI RIEMPIE SOLO CIO' CHE E' TUTTO CIFRE. `ALPHA` non tocca un valore che contiene lettere, e
 * riempirlo lo trasformerebbe in una chiave diversa — che e' peggio di non riempirla, perche' un
 * ordine non trovato si vede e un ordine sbagliato no.
 */
function internalOrderNumber(order) {
  const v = s(order);
  if (!v) return '';
  if (!/^\d+$/.test(v)) return v;
  return v.length >= 12 ? v : v.padStart(12, '0');
}

// ---------------------------------------------------------------------------------------------
// Customizing
// ---------------------------------------------------------------------------------------------

/**
 * Gli stati Plex dichiarati da un plant. FUNZIONE PURA.
 *
 * NON c'e' un catalogo chiuso contro cui validare, ed e' la differenza con `parseList` dell'area
 * ordini: quelli sono nomi di campo del contratto OData di SAP, questi sono righe della tabella di
 * setup del TENANT Plex, e nessun endpoint della Job Scheduling API li elenca. Quindi si accetta
 * qualunque testo non vuoto e la difesa e' altrove: il recap dichiara gli stati DISTINTI VISTI
 * nella finestra, cosi' un refuso si legge invece di comparire come uno zero.
 *
 * La deduplica e' insensibile al maiuscolo perche' lo e' il confronto (`matchesStatus`): tenere
 * `Completed` e `completed` come due voci direbbe che sono due criteri, e non lo sono.
 *
 * @returns {{codes: string[], value: string, duplicates: number}} `codes` conserva la grafia
 *   digitata dalla persona: e' quella che finisce in schermata.
 */
function parseStatusList(raw) {
  const seen = new Set();
  const codes = [];
  let duplicates = 0;
  for (const token of String(raw ?? '').split(SEP)) {
    const t = s(token);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) { duplicates += 1; continue; }
    seen.add(k);
    codes.push(t);
  }
  return { codes, value: codes.join(SEP), duplicates };
}

/**
 * Validazione di una riga di customizing, per ENTRAMBI i flussi. FUNZIONE PURA e flow-free:
 * la forma della lista e la regola «acceso senza criteri si rifiuta» non dipendono dal flusso.
 *
 * Restituisce gli errori invece di sollevare, come `validateTecoConfig`: il chiamante e' un handler
 * `before` che deve poter emettere `req.error` con il `target` giusto.
 *
 * UNA RIGA CON L'INTERRUTTORE ACCESO E NESSUNO STATO VIENE RIFIUTATA. Senza criteri nessun job
 * scatterebbe mai, e la schermata mostrerebbe una configurazione «attiva» che non fa niente —
 * indistinguibile da un flusso rotto. E' la regola per cui una regola priva di criteri non diventa
 * un passa-tutto silenzioso (DEC-52), ed e' la stessa di `validateTecoConfig`.
 *
 * @param {{ IsEnabled?: boolean|string, PlexStatuses?: string }} row
 * @returns {{ errors: Array<{field: string, code: string}>, PlexStatuses: string,
 *             statuses: string[] }}
 */
function validateConfig(row) {
  const parsed = parseStatusList(row && row.PlexStatuses);
  const errors = [];

  if (parsed.value.length > LIST_MAX_LENGTH) {
    errors.push({ field: 'PlexStatuses', code: 'tooLong' });
  }

  if (isTrue(row && row.IsEnabled) && !parsed.codes.length) {
    errors.push({ field: 'PlexStatuses', code: 'requiredWhenEnabled' });
  }

  return { errors, PlexStatuses: parsed.value, statuses: parsed.codes };
}

/**
 * Il customizing di un plant, normalizzato. FUNZIONE PURA.
 *
 * IL RILEVAMENTO usa il default `Completed` quando il plant non dichiara nulla: e' il valore
 * osservato sul tenant, e serve a far comparire l'arretrato in `'D'` invece di lasciare la
 * schermata muta. LA SCRITTURA no: `enabled` diventa **falso** se gli stati non sono DICHIARATI,
 * anche con la casella accesa.
 *
 * I due comportamenti sono opposti di proposito, ed e' la regola generale del progetto applicata
 * qui: leggere qualcosa in piu' e' un fastidio che si vede, scrivere su SAP con un criterio che
 * nessuno ha scelto no (DEC-52, DEC-53). `validateConfig` rifiuta gia' quella combinazione
 * alla scrittura, quindi dall'applicazione la riga non nasce; ma una riga storica, o scritta a mano
 * sul database, non deve poter far partire una POST — e il caso si DICHIARA con
 * `enabledButNoStatuses`, perche' una casella accesa che non scrive, senza una riga che lo dica, e'
 * indistinguibile da un flusso rotto.
 */
function normalizeConfig(row, flow) {
  requireFlow(flow, 'normalizeConfig');
  const parsed = parseStatusList(row && row.PlexStatuses);
  const declared = parsed.codes.length > 0;
  const flagged = isTrue(row && row.IsEnabled);
  return {
    plant: s(row && row.Plant),
    enabled: flagged && declared,
    enabledButNoStatuses: flagged && !declared,
    statuses: declared ? parsed.codes : [...flow.defaultStatuses],
    statusesFromDefault: !declared
  };
}

/**
 * Legge il customizing dei plant utilizzabili e lo divide in configurati e non.
 *
 * PRENDE `db` PER ARGOMENTO, come `resolveTecoScope`: e' l'unica funzione di questo modulo che
 * tocca il database, e sta qui perche' il job deve poter sapere se ha qualcosa da fare prima di
 * aprire qualunque connessione verso l'esterno.
 *
 * FAIL-CLOSED: un plant utilizzabile ma senza riga finisce fra gli `unconfigured` e il job lo
 * DICHIARA. Questo customizing governa una scrittura verso un sistema esterno, quindi «nessuna
 * configurazione» significa «non fare niente» (DEC-52, DEC-53) — non «tutti gli stati».
 *
 * @param {object} db connessione CDS
 * @param {Set<string>|string[]} plants i plant attivi E licenziati
 * @returns {Promise<{configured: string[], unconfigured: string[],
 *                    byPlant: Map<string, object>}>}
 */
async function resolveScope(db, plants, flow) {
  requireFlow(flow, 'resolveScope');
  // `SELECT` e' il globale che `@sap/cds` installa nel processo: questo modulo NON lo importa, cosi'
  // il suo test gira senza runtime. Stessa scelta di `loadTecoConfig`.
  const wanted = [...(plants instanceof Set ? plants : new Set(plants || []))]
    .map(s).filter(Boolean);
  const byPlant = new Map();
  if (!wanted.length) return { configured: [], unconfigured: [], byPlant };

  const rows = await db.run(
    SELECT.from(flow.configEntity)
      .columns('Plant', 'IsEnabled', 'PlexStatuses')
      .where({ Plant: { in: wanted } })
  );

  for (const row of rows || []) {
    const cfg = normalizeConfig(row, flow);
    if (!cfg.plant) continue;
    byPlant.set(cfg.plant, cfg);
  }

  const configured = [...byPlant.keys()].sort();
  const unconfigured = wanted.filter((p) => !byPlant.has(p)).sort();
  return { configured, unconfigured, byPlant };
}

// ---------------------------------------------------------------------------------------------
// Lettura della finestra
// ---------------------------------------------------------------------------------------------

/**
 * Le righe di una risposta della Connect API. FUNZIONE PURA.
 *
 * FORMA IGNOTA != FINESTRA VUOTA, ed e' la disciplina di `readDsRows` in prodOrderTeco.js — ma NON
 * la sua funzione: quella riconosce le Data Source, che rispondono `{rows: […]}`, mentre la Connect
 * API risponde un array nudo o un involucro `data`/`results`/`value`. Riusare `readDsRows` qui
 * dichiarerebbe guasta una risposta valida, che e' lo stesso difetto al contrario.
 *
 * Perche' conta: con `'A'` terminale, una risposta di forma cambiata letta come «nessun job
 * completato» farebbe avanzare il watermark su una finestra che nessuno ha guardato, e quei
 * completamenti non tornerebbero mai piu'. `recognized: false` e' un GUASTO: il watermark non
 * avanza.
 *
 * @returns {{rows: object[], recognized: boolean, shape: string}}
 */
function readJobRows(body) {
  if (Array.isArray(body)) return { rows: body, recognized: true, shape: 'array' };
  if (body && typeof body === 'object') {
    for (const wrapper of ['data', 'results', 'value', 'rows']) {
      if (Array.isArray(body[wrapper])) {
        return { rows: body[wrapper], recognized: true, shape: wrapper };
      }
    }
  }
  return { rows: [], recognized: false, shape: '' };
}

/**
 * Il criterio: questo stato vale «finito»? FUNZIONE PURA.
 *
 * TOLLERANTE, e per la ragione di DEC-51: un lato del confronto e' un valore DIGITATO da una
 * persona nella schermata di configurazione, l'altro e' quello che Plex restituisce. Fra due chiavi
 * di due sistemi il confronto sarebbe stretto; qui il difetto di un maiuscolo sarebbe NOSTRO.
 *
 * Il criterio NON si spinge su Plex, ed e' un divieto e non una dimenticanza: vedi la testata del
 * job.
 */
function matchesStatus(jobStatus, statuses) {
  const v = s(jobStatus).toLowerCase();
  if (!v) return false;
  for (const st of statuses || []) {
    if (s(st).toLowerCase() === v) return true;
  }
  return false;
}

/**
 * Confronto esatto fra due numeri di job. FUNZIONE PURA.
 *
 * DUE VUOTI NON SONO UGUALI: e' la stessa regola di `isExactJobNumber` in splitRules.js, e serve
 * perche' `?jobNumber=` di Plex fa match per PREFISSO e il codice di un pacchetto INIZIA col numero
 * d'ordine. Qui il confronto non serve a filtrare una risposta ma a riconoscere il lotto padre, e
 * sbagliarlo significherebbe mettere lo stato utente per un pacchetto.
 */
function sameJobNumber(a, b) {
  const x = s(a);
  const y = s(b);
  return x !== '' && y !== '' && x === y;
}

/**
 * E' la riga del LOTTO PADRE? FUNZIONE PURA.
 *
 * `PlexJobNumber === ManufacturingOrder`, MAI `SplitSequence === 0` ne' `SplitState === 'M'`:
 * quelle due colonne sono valorizzate solo all'INSERT di una riga nuova, quindi le righe scritte
 * prima della 0012 e mai reinserite sono a `null` (RB-02 della 0012). Filtrarci sopra escluderebbe
 * in silenzio tutti gli ordini piu' vecchi.
 */
function isMainLot(row) {
  return !!row && sameJobNumber(row.PlexJobNumber, row.ManufacturingOrder);
}

/**
 * L'indice del dizionario dei lotti, per UUID e per numero. FUNZIONE PURA.
 *
 * Due indici e non uno: l'UUID e' la chiave PRIMARIA di ricerca (id-first, DEC-80) perche' e'
 * l'identita' che Plex stesso ci ha dato, e il numero e' il ripiego per le righe il cui `PlexJobId`
 * non e' mai stato scritto.
 */
function indexMapping(rows) {
  const byId = new Map();
  const byNumber = new Map();
  for (const r of rows || []) {
    const id = s(r && r.PlexJobId);
    const no = s(r && r.PlexJobNumber);
    if (id && !byId.has(id)) byId.set(id, r);
    if (no && !byNumber.has(no)) byNumber.set(no, r);
  }
  return { byId, byNumber };
}

/**
 * Da una riga di job Plex all'ordine SAP. FUNZIONE PURA.
 *
 * QUATTRO ESITI, e tutti e quattro si dichiarano:
 *   'main'          e' il lotto padre di un ordine: candidato
 *   'package'       e' un pacchetto di spacchettamento: nessuna scrittura, per scelta
 *   'quarantine'    Plex dice completato un job che non risolviamo: si persiste (DEC-59)
 *   'plantMismatch' la riga di mapping e' di un ALTRO plant: si rifiuta
 *
 * IL PLANT VIENE DAL TENANT LETTO, non dalla riga di mapping. Ogni plant ha il suo tenant Plex
 * (0020), quindi il plant e' noto per costruzione, e una riga di mapping con `Plant` vuoto o
 * `'#NA'` — che significa IGNOTO, mai «escludimi» — non va esclusa. `ZProdOrderPlexMapping.Plant`
 * serve solo come TERMINE DI VERIFICA: se e' noto e diverso, la riga si rifiuta, perche' quel
 * dizionario non ha il plant in chiave e un aggancio per NUMERO potrebbe cadere sull'ordine di un
 * altro plant («ambiguo si rifiuta», DEC-70/DEC-80). Con l'aggancio per UUID il caso non si pone,
 * ed e' una ragione in piu' per tenere l'id in testa.
 *
 * @param {object} job riga della Connect API
 * @param {{byId: Map, byNumber: Map}} index da `indexMapping`
 * @param {string} plant il plant del tenant su cui si e' letto
 * @returns {{kind: string, order: string, via: string, row: object|null,
 *            mappingPlant: string}}
 */
function resolveJob(job, index, plant) {
  const id = s(job && job.id);
  const number = s(job && job.jobNumber);
  const tenantPlant = s(plant);

  let row = id ? index.byId.get(id) : undefined;
  let via = row ? 'id' : '';
  if (!row && number) {
    row = index.byNumber.get(number);
    via = row ? 'number' : '';
  }

  if (!row) return { kind: 'quarantine', order: '', via: '', row: null, mappingPlant: '' };

  const mappingPlant = s(row.Plant);
  const known = mappingPlant !== '' && mappingPlant !== PLANT_UNKNOWN;
  if (known && tenantPlant && mappingPlant !== tenantPlant) {
    return { kind: 'plantMismatch', order: s(row.ManufacturingOrder), via, row, mappingPlant };
  }

  // L'ORDINE SI GUARDA PRIMA DEL PACCHETTO, e l'ordine dei due rami non e' indifferente. Una riga
  // di dizionario senza `ManufacturingOrder` non e' un pacchetto: e' una riga che non risolve, e
  // `isMainLot` la scarta comunque perche' due vuoti non sono uguali. Mettendo il ramo `package`
  // per primo, quella riga usciva etichettata «pacchetto, fuori perimetro per scelta» — cioe' un
  // dizionario rotto si nascondeva dietro la ragione di uno scarto VOLUTO, che nessuno va a
  // guardare. La quarantena invece la nomina e la ripresenta a ogni run.
  const order = s(row.ManufacturingOrder);
  if (!order) return { kind: 'quarantine', order: '', via, row, mappingPlant };

  if (!isMainLot(row)) return { kind: 'package', order, via, row, mappingPlant };

  return { kind: 'main', order, via, row, mappingPlant };
}

/**
 * La lettura e' sospetta di TRONCAMENTO? FUNZIONE PURA.
 *
 * `GET /scheduling/v1/jobs` NON pagina: non c'e' `$top`, non c'e' un cursore, non c'e' un header di
 * conteggio. Quindi una risposta troncata e' indistinguibile da una completa, e il watermark
 * avanzerebbe come se avesse letto tutto — che e' una perdita muta, la stessa contro cui esiste il
 * tetto della finestra della consuntivazione.
 *
 * Non essendoci un modo di SAPERLO, si usa una soglia: oltre `suspect` righe la finestra si dimezza
 * e si rilegge (lo stesso dimezzamento di plantRowsPaging.js), e se anche la meta' la supera la
 * lettura si dichiara DEGRADATA e il watermark non avanza. Un limite non onorato e' piu' pericoloso
 * di un limite assente, perche' il chiamante ci conta.
 */
function truncationVerdict(count, suspect) {
  const n = Number(count) || 0;
  const cap = Number(suspect) > 0 ? Number(suspect) : 0;
  if (!cap) return { suspect: false, count: n, cap: 0 };
  return { suspect: n >= cap, count: n, cap };
}

// ---------------------------------------------------------------------------------------------
// Prenotazione e scadenze
// ---------------------------------------------------------------------------------------------

/** L'istante oltre il quale una prenotazione e' orfana. FUNZIONE PURA. */
function staleCutoff(now, minutes) {
  const at = now instanceof Date ? now : new Date(now);
  const m = Number(minutes) > 0 ? Number(minutes) : 0;
  return new Date(at.getTime() - m * 60 * 1000);
}

/** L'istante oltre il quale una quarantena non si ri-risolve piu'. FUNZIONE PURA. */
function quarantineCutoff(now, days) {
  const at = now instanceof Date ? now : new Date(now);
  const d = Number(days) > 0 ? Number(days) : 0;
  return new Date(at.getTime() - d * 24 * 60 * 60 * 1000);
}

/**
 * Le righe che il passo 0 ripesca dal database. FUNZIONE PURA.
 *
 * E' IL PASSO CHE RENDE VERE LE PROMESSE DEGLI STATI NON TERMINALI. La finestra RILEVA; l'insieme
 * da inviare viene da qui. Senza, `'D'`, `'E'` e `'Q'` non tornerebbero mai candidati: la
 * sovrapposizione fra due finestre e' di due MINUTI, non di un run, e il seme dell'avvio a freddo
 * si sposta solo in avanti — quindi un arretrato accumulato a leva chiusa richiederebbe un backfill
 * a mano, che e' esattamente cio' che DEC-71 promette di non richiedere.
 *
 * @param {object[]} rows righe di ZProdOrderCompleteState non terminali
 * @param {object} o `{ now, staleMinutes, quarantineDays }`
 * @returns {{resume: object[], staleClaims: object[], expiredQuarantine: object[]}}
 */
function resumableRows(rows, { now, staleMinutes = 0, quarantineDays = 0 } = {}) {
  const staleAt = staleCutoff(now, staleMinutes).toISOString();
  const qAt = quarantineCutoff(now, quarantineDays).toISOString();
  const resume = [];
  const staleClaims = [];
  const expiredQuarantine = [];

  for (const r of rows || []) {
    const state = s(r && r.State);
    if (state === STATE.CLAIMED) {
      const at = s(r.ClaimedAt) || s(r.UpdatedAt);
      // Senza data la prenotazione e' di forma ignota: si tratta come orfana, perche' lasciarla
      // ferma sarebbe l'unico esito da cui non si esce.
      if (!at || at < staleAt) staleClaims.push(r);
      continue;
    }
    if (state === STATE.QUARANTINE) {
      const at = s(r.DetectedAt) || s(r.CreatedAt);
      if (quarantineDays > 0 && at && at < qAt) { expiredQuarantine.push(r); continue; }
      resume.push(r);
      continue;
    }
    if (RESUMABLE_STATES.includes(state)) resume.push(r);
  }

  return { resume, staleClaims, expiredQuarantine };
}

// ---------------------------------------------------------------------------------------------
// Classificazione dell'esito e transizioni
// ---------------------------------------------------------------------------------------------

/**
 * I messaggi SAP considerati DEFINITIVI, in forma `ID/NUMBER`. FUNZIONE PURA.
 *
 * PARTE VUOTO, E NON E' UNA DIMENTICANZA. Un rifiuto della FM puo' essere permanente («ordine non
 * esistente») o transitorio («ordine bloccato da un altro utente»): distinguerli richiede i
 * messaggi VERI di questo sistema, e nessuno di quelli che verrebbe da scrivere adesso e' stato
 * osservato qui — su questo indirizzo l'unico esito misurato e' un guscio vuoto. Un elenco
 * inventato farebbe il danno peggiore dei due: archiviare come permanente uno stato utente che
 * sarebbe passato al tentativo dopo.
 *
 * Si riempie dal campo, senza rilascio: `ORDER_CLOSE_PERMANENT_MESSAGES="CO/305,IW/041"`. E' lo
 * stesso disegno di `MATDOC_PERMANENT_MESSAGES` (confMatDoc.js).
 */
const PERMANENT_MESSAGES_DEFAULT = Object.freeze([]);

function readPermanentMessages(env) {
  const raw = (env || {}).ORDER_CLOSE_PERMANENT_MESSAGES;
  if (!raw || !String(raw).trim()) return new Set(PERMANENT_MESSAGES_DEFAULT);
  return new Set(
    String(raw).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
  );
}

/**
 * Come si legge l'esito di una POST di `CloseOrder`. FUNZIONE PURA.
 *
 * LE CINQUE RIGHE, e la terza e' quella che questa feature ha dovuto decidere:
 *
 *   messaggio di successo, nessun errore      -> APPLIED
 *   rifiuto in `ORDER_CLOSE_PERMANENT_MESSAGES` -> REJECTED permanente, 'X' subito
 *   rifiuto applicativo non riconosciuto      -> REJECTED transitorio, CONSUMA un tentativo
 *   esito non conclusivo                      -> INCONCLUSIVE, NON consuma
 *   guasto di trasporto                       -> FAILED, NON consuma
 *
 * IL 404 DI QUESTO INDIRIZZO SIGNIFICA CHE LA FM E' GIRATA, e va classificato come RIFIUTO e non
 * come guasto. Misurato dalla sonda il 14/08/2026: `404` con corpo `{"error":…}` e
 * `dataserviceversion`, con la RFC OSSERVATA girare in debug. Un errore OData ben formato non e' un
 * indirizzo assente: e' un servizio che ha ELABORATO la richiesta e l'ha rifiutata. Leggerlo come
 * «non partito» lo farebbe ritentare senza limite, e su una scrittura gia' eseguita.
 *
 * @param {object} r esito normalizzato: `{ depth, messageType, messageId, messageNumber,
 *   messageCount, emptyMessage, odataError, httpStatus, thrown }`
 * @param {Set<string>} [permanent] da `readPermanentMessages`
 * @returns {{kind: string, permanent: boolean, failureClass: 'T'|'P'|'',
 *            consumesAttempt: boolean, reason: string}}
 */
function classifyOrderClose(r, permanent = null) {
  const o = r || {};
  const set = permanent || new Set();
  const type = s(o.messageType).toUpperCase();
  const id = s(o.messageId).toUpperCase();
  const number = s(o.messageNumber);
  const rejected = ERROR_TYPES.includes(type);

  if (o.depth === DEPTH.DONE && !rejected) {
    return {
      kind: OUTCOME.APPLIED,
      permanent: false,
      failureClass: '',
      consumesAttempt: false,
      reason: 'la FM ha risposto senza errori: lo stato utente risulta impostato'
    };
  }

  if (rejected) {
    if (id && number && set.has(`${id}/${number}`)) {
      return {
        kind: OUTCOME.REJECTED,
        permanent: true,
        failureClass: 'P',
        consumesAttempt: false,
        reason: `rifiuto applicativo ${id} ${number} dichiarato definitivo `
          + '(ORDER_CLOSE_PERMANENT_MESSAGES)'
      };
    }
    return {
      kind: OUTCOME.REJECTED,
      permanent: false,
      failureClass: 'T',
      consumesAttempt: true,
      reason: `rifiuto applicativo ${type} ${id} ${number}`.trim()
        + ': non e\' fra i definitivi, si ritenta fino al tetto'
    };
  }

  // Un errore OData ben formato: la richiesta e' stata elaborata e rifiutata dallo strato OData o
  // dalla logica a valle. E' un rifiuto, e consuma il tentativo: ritentare non lo cambia.
  if (o.odataError) {
    return {
      kind: OUTCOME.REJECTED,
      permanent: false,
      failureClass: 'T',
      consumesAttempt: true,
      reason: `errore OData${o.httpStatus ? ` (HTTP ${o.httpStatus})` : ''}: il servizio ha `
        + 'elaborato la richiesta e l\'ha rifiutata — non e\' un indirizzo assente'
    };
  }

  // Arrivato e non concluso. NON consuma: vedi l'asimmetria 2 in testa al file.
  if (o.depth === DEPTH.IFLOW || o.depth === DEPTH.FM || o.emptyMessage) {
    return {
      kind: OUTCOME.INCONCLUSIVE,
      permanent: false,
      failureClass: 'T',
      consumesAttempt: false,
      reason: o.emptyMessage
        ? 'la struttura del messaggio C\'E\' e i valori sono tutti nulli: la FM e\' stata invocata e '
          + 'la risposta non e\' stata riempita. Non si sa se abbia scritto, quindi si ritenta — uno '
          + 'stato utente impostato due volte resta lo stesso stato'
        : 'nessun messaggio applicativo riconosciuto: arrivato, esito ignoto. Si ritenta senza '
          + 'consumare un tentativo'
    };
  }

  return {
    kind: OUTCOME.FAILED,
    permanent: false,
    failureClass: 'T',
    consumesAttempt: false,
    reason: o.httpStatus
      ? `nessuna risposta applicativa (HTTP ${o.httpStatus}): il messaggio non e' arrivato alla FM`
      : 'guasto di trasporto: il messaggio non e\' arrivato alla FM'
  };
}

/**
 * La transizione di stato. FUNZIONE PURA.
 *
 * `attempts` E' IL VALORE PRE-PRENOTAZIONE, cioe' quello che il job ha letto dalla riga all'inizio
 * del giro — non quello che la prenotazione ha appena scritto. La prenotazione incrementa
 * `Attempts` per bloccare un guasto ciclico (una morte del processo lascia il tentativo consumato),
 * e questa funzione lo RIPORTA indietro quando l'esito non consuma. Le due cose insieme sono
 * l'asimmetria 4 in testa al file: senza il ripristino, il guscio di messaggio vuoto misurato il
 * 13/08/2026 porterebbe ogni ordine in `'X'` in tre run.
 *
 * @param {{attempts?: number}} prev la riga come era PRIMA della prenotazione
 * @param {{kind: string, permanent?: boolean, consumesAttempt?: boolean, segments?: Array}} outcome
 * @param {number} [maxAttempts]
 * @returns {{State: string, Attempts: number, segments: Array}}
 */
function nextState(prev, outcome, maxAttempts = 3, flow) {
  requireFlow(flow, 'nextState');
  const attempts = Math.max(0, Number((prev && prev.attempts) || 0));
  const o = outcome || {};
  const kind = o.kind || OUTCOME.FAILED;
  const segments = logMsg.normalize(o.segments);
  const max = Number(maxAttempts) > 0 ? Number(maxAttempts) : 3;

  if (kind === OUTCOME.APPLIED) {
    return { State: STATE.APPLIED, Attempts: attempts + 1, segments };
  }
  // Una chiamata che NON PARTE non e' un tentativo: e' un'attesa (RB-12 della 0023).
  if (kind === OUTCOME.PENDING) {
    return { State: STATE.DETECTED, Attempts: attempts, segments };
  }
  if (kind === OUTCOME.QUARANTINE) {
    return { State: STATE.QUARANTINE, Attempts: attempts, segments };
  }
  if (o.permanent) {
    return { State: STATE.EXHAUSTED, Attempts: attempts, segments };
  }
  if (!o.consumesAttempt) {
    // Arrivato e non concluso, o non arrivato: si ritenta e il tetto non si muove.
    return { State: STATE.FAILED, Attempts: attempts, segments };
  }
  const used = attempts + 1;
  return {
    State: used >= max ? STATE.EXHAUSTED : STATE.FAILED,
    Attempts: used,
    segments: used >= max
      ? [...segments, logMsg.seg(`${flow.msg}AttemptsExhausted`, used, max)]
      : segments
  };
}

/**
 * Lo `status` della riga di run log per una riga di stato. FUNZIONE PURA.
 *
 * `'D'` e `'Q'` sono `'S'`: sono attese dichiarate, non anomalie — un plant a leva chiusa non deve
 * tingere di rosso il run (DEC-39). `'X'` e' `'X'`, che nel calcolo dell'esito alimenta
 * `TotalExhausted` e porta la testata in attenzione SENZA cambiare l'exit code.
 */
function stateRecordStatus(state) {
  if (state === STATE.APPLIED || state === STATE.DETECTED || state === STATE.QUARANTINE) return 'S';
  if (state === STATE.EXHAUSTED) return 'X';
  return 'E';
}

// ---------------------------------------------------------------------------------------------
// Recap
// ---------------------------------------------------------------------------------------------

function emptyStat() {
  return {
    windowRows: 0,        // righe tornate dalla finestra
    inCriteria: 0,        // di cui con uno stato in criterio
    statusesSeen: {},     // stato -> quante volte: e' cio' che rende diagnosticabile uno zero
    main: 0,              // agganciate al lotto padre
    packages: 0,          // pacchetti, fuori perimetro per scelta
    mismatch: 0,          // riga di mapping di un altro plant: rifiutata
    quarantineNew: 0,       // messe in quarantena da questa finestra
    quarantineWaiting: 0,   // ancora non risolvibili: restano in attesa
    quarantineRequeued: 0,  // risolte adesso, e rimesse in coda per l'invio
    quarantineExpired: 0,   // oltre il termine: non si ri-risolvono piu'
    applied: 0,
    pending: 0,
    failed: 0,
    exhausted: 0,
    staleClaims: 0,
    stale: 0,             // coda ferma: righe non terminali da troppo tempo
    staleSince: null,
    readOk: true,
    truncated: false,
    coldStart: false,
    // [ORDER-COMPLETE] Quante finestre ha percorso il giro, e se si e' fermato sul tetto per run.
    // Il numero e' del RUN e non della singola lettura: e' cio' che distingue «una finestra e
    // bastava» da «cinquanta e non erano finite».
    windows: 0,
    windowCapReached: false,
    // Arretrato RESIDUO alla fine del giro. Con il giro delle finestre e' zero a ogni run, quindi
    // un numero diverso da zero e' un'ANOMALIA e non piu' un'informazione: vedi `broken`.
    backlogMinutes: 0
  };
}

function statFor(stats, plant) {
  const key = s(plant) || PLANT_UNKNOWN;
  return (stats[key] || (stats[key] = emptyStat()));
}

/** Conta una riga letta dalla finestra, e lo STATO che portava. */
function addWindowRow(stats, plant, jobStatus, inCriteria) {
  const st = statFor(stats, plant);
  st.windowRows += 1;
  const key = s(jobStatus) || '(vuoto)';
  st.statusesSeen[key] = (st.statusesSeen[key] || 0) + 1;
  if (inCriteria) st.inCriteria += 1;
  return st;
}

/** Conta l'esito dell'incrocio di una riga in criterio. */
function addResolution(stats, plant, kind) {
  const st = statFor(stats, plant);
  if (kind === 'main') st.main += 1;
  else if (kind === 'package') st.packages += 1;
  else if (kind === 'plantMismatch') st.mismatch += 1;
  else st.quarantineNew += 1;
  return st;
}

/** Conta l'esito di un tentativo di scrittura. */
function addOutcome(stats, plant, state) {
  const st = statFor(stats, plant);
  if (state === STATE.APPLIED) st.applied += 1;
  else if (state === STATE.DETECTED) st.pending += 1;
  else if (state === STATE.QUARANTINE) st.quarantineWaiting += 1;
  else if (state === STATE.EXHAUSTED) st.exhausted += 1;
  else st.failed += 1;
  return st;
}

/**
 * Conta una riga della CODA FERMA, con la data piu' vecchia.
 *
 * «0 ordini trattati» e «il criterio configurato non aggancia quello che il plant fa davvero» sono
 * indistinguibili senza questo numero: e' la lezione RB-34 della 0023. Informativo e NON degradante
 * — un arretrato in attesa di una leva non e' un'anomalia — ma la data piu' vecchia e' cio' che
 * rende leggibile la differenza fra «ieri» e «da un anno».
 */
function addStale(stats, plant, since) {
  const st = statFor(stats, plant);
  st.stale += 1;
  const when = since ? String(since instanceof Date ? since.toISOString() : since) : null;
  if (when && (!st.staleSince || when < st.staleSince)) st.staleSince = when;
  return st;
}

/**
 * Conta una prenotazione orfana ripresa, o una quarantena scaduta.
 *
 * Sono due fatti che DEGRADANO il recap e che nessun altro contatore vede: una prenotazione orfana
 * dice che un run e' morto in mezzo, una quarantena scaduta che un job completato non verra' piu'
 * ricondotto a un ordine. Contarli separatamente e' cio' che distingue «tutto a posto» da «nessuno
 * se ne e' accorto».
 */
function addSweep(stats, plant, { staleClaims = 0, quarantineExpired = 0, requeued = 0 } = {}) {
  const st = statFor(stats, plant);
  if (staleClaims > 0) st.staleClaims += Number(staleClaims);
  if (quarantineExpired > 0) st.quarantineExpired += Number(quarantineExpired);
  if (requeued > 0) st.quarantineRequeued += Number(requeued);
  return st;
}

/**
 * Annota l'esito della lettura della finestra per il plant.
 *
 * [ORDER-COMPLETE] `backlogMinutes` SI ASSEGNA, non si accumula e non si filtra sul positivo: e' il
 * residuo alla FINE del giro delle finestre, e il chiamante lo dichiara una volta sola. Col filtro
 * `> 0` di prima, un giro che parte con arretrato e lo smaltisce lascerebbe in `st` il numero della
 * penultima finestra — un arretrato dichiarato su un run che aveva recuperato tutto, e da lì un
 * `degrade` a vuoto.
 */
function addWindowOutcome(stats, plant, {
  readOk, truncated, coldStart, backlogMinutes, windows, windowCapReached
} = {}) {
  const st = statFor(stats, plant);
  if (readOk === false) st.readOk = false;
  if (truncated) st.truncated = true;
  if (coldStart) st.coldStart = true;
  if (Number(windows) > 0) st.windows += Number(windows);
  if (windowCapReached) st.windowCapReached = true;
  if (backlogMinutes !== undefined) {
    const n = Number(backlogMinutes);
    st.backlogMinutes = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  return st;
}

/** Gli stati distinti visti, ordinati per frequenza: la riga che diagnostica uno zero. */
function seenStatusText(seen, max = 6) {
  const pairs = Object.entries(seen || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = pairs.slice(0, max).map(([k, n]) => `${k} (${n})`);
  if (pairs.length > max) shown.push(`+${pairs.length - max}`);
  return shown.join(', ');
}

/**
 * UNA voce di recap per plant, non una per oggetto.
 *
 * La cadenza per oggetto produrrebbe una riga di attenzione per ordine a ogni esecuzione e quindi
 * una mail ricorrente per sempre: e' il rischio R-03 della 0014, e la risposta e' la stessa.
 *
 * `degrade` e' true SOLO su cio' che merita attenzione: lettura fallita o troncata, righe fallite,
 * tentativi esauriti, prenotazioni orfane, quarantene scadute, righe rifiutate per plant sbagliato,
 * e dal 09/09/2026 l'ARRETRATO RESIDUO — il giro delle finestre non e' arrivato a `now`.
 * Un plant a leva chiusa, o che non ha niente da dichiarare, e' un'INFORMAZIONE (DEC-39).
 *
 * [LOG-MSG-I18N] Un segmento PER CAUSA e non una frase concatenata: quando il JSON sfora, `pack`
 * scarta segmenti interi dalla coda. L'ordine e' quello di importanza — cio' che non e' arrivato in
 * SAP viene prima di cio' che e' andato bene, e la diagnosi degli stati visti viene prima dei
 * conteggi di dettaglio, perche' e' quella che spiega uno zero.
 */
function recapEntries(stats, flow) {
  requireFlow(flow, 'recapEntries');
  const out = [];
  for (const plant of Object.keys(stats || {}).sort()) {
    const st = stats[plant] || emptyStat();
    // [ORDER-COMPLETE] `backlogMinutes` ENTRA in `broken`, e il segno e' cambiato il 09/09/2026.
    // Finche' il run consumava una finestra per volta, l'arretrato era la NORMA del recupero a rate
    // e restava un'informazione (DEC-39). Ora il giro delle finestre arriva a `now` a ogni run,
    // quindi un residuo significa che il giro si e' FERMATO prima — lettura caduta, troncamento o
    // tetto per run — e le tre cause hanno tre rimedi diversi. Un plant quattro giorni indietro
    // chiudeva `S` con `degrade: false`, cioe' verde e muto: e' il difetto del 09/09.
    const broken = st.failed + st.exhausted + st.mismatch + st.staleClaims
      + st.quarantineExpired + (st.readOk ? 0 : 1) + (st.truncated ? 1 : 0)
      + (st.backlogMinutes > 0 ? 1 : 0);

    const segments = [logMsg.seg(`${flow.msg}RecapHead`, st.windowRows, st.inCriteria, st.main)];

    if (!st.readOk) segments.push(logMsg.seg(`${flow.msg}RecapReadFailed`));
    if (st.truncated) segments.push(logMsg.seg(`${flow.msg}RecapTruncated`, st.windowRows));
    // [ORDER-COMPLETE] NOTE DI VERDETTO: stanno qui, davanti ai contatori, perche' la POSIZIONE di
    // una nota e' la sua priorita' — entrambi i tetti della testata scartano la CODA (`cut` sullo
    // snapshot, `pack` sui segmenti: addendum del 07/09/2026 a DEC-124). Il 09/09 l'arretrato era
    // PENULTIMO, cioe' fra i primi a essere scartato, e il residuo di 6385 minuti non e' mai
    // arrivato in nessuna schermata. La causa viene subito dopo il numero: il numero dice QUANTO,
    // la causa dice cosa fare.
    if (st.backlogMinutes > 0) {
      segments.push(logMsg.seg(`${flow.msg}RecapBacklog`, st.backlogMinutes));
    }
    if (st.windowCapReached) {
      segments.push(logMsg.seg(`${flow.msg}RecapWindowCap`, st.windows));
    }
    if (st.exhausted) segments.push(logMsg.seg(`${flow.msg}RecapExhausted`, st.exhausted));
    if (st.failed) segments.push(logMsg.seg(`${flow.msg}RecapFailed`, st.failed));
    if (st.staleClaims) segments.push(logMsg.seg(`${flow.msg}RecapStaleClaims`, st.staleClaims));
    if (st.mismatch) segments.push(logMsg.seg(`${flow.msg}RecapPlantMismatch`, st.mismatch));
    if (st.applied) segments.push(logMsg.seg(`${flow.msg}RecapApplied`, st.applied));
    if (st.pending) segments.push(logMsg.seg(`${flow.msg}RecapPending`, st.pending));
    // La diagnosi dello zero: quali stati Plex ha visto davvero questa finestra.
    if (st.windowRows && !st.inCriteria) {
      segments.push(logMsg.seg(`${flow.msg}RecapNoMatch`, seenStatusText(st.statusesSeen)));
    }
    if (st.packages) segments.push(logMsg.seg(`${flow.msg}RecapPackages`, st.packages));
    if (st.quarantineNew || st.quarantineWaiting || st.quarantineRequeued || st.quarantineExpired) {
      segments.push(logMsg.seg(
        `${flow.msg}RecapQuarantine`,
        st.quarantineNew, st.quarantineWaiting, st.quarantineRequeued, st.quarantineExpired
      ));
    }
    if (st.coldStart) segments.push(logMsg.seg(`${flow.msg}RecapColdStart`));
    if (st.stale) {
      segments.push(logMsg.seg(`${flow.msg}RecapStale`, st.stale, (st.staleSince || '').slice(0, 10)));
    }

    out.push({
      plant,
      status: broken > 0 ? 'W' : 'S',
      degrade: broken > 0,
      segments
    });
  }
  return out;
}

/**
 * Lega un flusso alle quattro funzioni che ne hanno bisogno, e lascia passare le altre.
 *
 * Il risultato e' cio' che i due moduli di legame — `prodOrderComplete.js` e
 * `prodOrderScheduled.js` — ri-esportano. Le quaranta funzioni flow-free arrivano invariate: non
 * sono avvolte, non sono copiate, sono LE STESSE, e questo e' cio' che rende impossibile che i due
 * flussi divergano su una regola che dovrebbe essere una.
 *
 * `FLOW` viaggia nel risultato perche' i job ne hanno bisogno — il `callKey` per la POST, la
 * `stateEntity` per le query, `excLogOperation` per lo storico — e leggerlo da la' e' l'unico modo
 * di NON riscrivere quelle costanti nel job.
 */
function bindFlow(flow) {
  requireFlow(flow, 'bindFlow');
  return {
    FLOW: flow,
    // costanti
    NS,
    STATE, TERMINAL_STATES, RESUMABLE_STATES, OUTCOME, DEPTH,
    LIST_MAX_LENGTH, PERMANENT_MESSAGES_DEFAULT,
    // utilita'
    s, cut, isTrue, intEnv, internalOrderNumber,
    // customizing
    parseStatusList,
    validateConfig,
    normalizeConfig: (row) => normalizeConfig(row, flow),
    resolveScope: (db, plants) => resolveScope(db, plants, flow),
    // finestra e incrocio
    readJobRows, matchesStatus, sameJobNumber, isMainLot, indexMapping, resolveJob,
    truncationVerdict,
    // prenotazione e ripresa
    staleCutoff, quarantineCutoff, resumableRows,
    // esito
    readPermanentMessages, classifyOrderClose, stateRecordStatus,
    nextState: (prev, outcome, maxAttempts) => nextState(prev, outcome, maxAttempts, flow),
    // recap
    emptyStat, addWindowRow, addResolution, addOutcome, addStale, addSweep, addWindowOutcome,
    seenStatusText,
    recapEntries: (stats) => recapEntries(stats, flow)
  };
}

module.exports = {
  // i flussi
  FLOWS, FLOW_COMPLETE, FLOW_SCHEDULED, bindFlow, requireFlow,
  // costanti
  NS,
  STATE, TERMINAL_STATES, RESUMABLE_STATES, OUTCOME, DEPTH,
  LIST_MAX_LENGTH, PERMANENT_MESSAGES_DEFAULT,
  // utilita'
  s, cut, isTrue, intEnv, internalOrderNumber,
  // customizing (le due che vogliono il flusso lo prendono per ULTIMO argomento)
  parseStatusList, validateConfig, normalizeConfig, resolveScope,
  // finestra e incrocio
  readJobRows, matchesStatus, sameJobNumber, isMainLot, indexMapping, resolveJob,
  truncationVerdict,
  // prenotazione e ripresa
  staleCutoff, quarantineCutoff, resumableRows,
  // esito
  readPermanentMessages, classifyOrderClose, nextState, stateRecordStatus,
  // recap
  emptyStat, addWindowRow, addResolution, addOutcome, addStale, addSweep, addWindowOutcome,
  seenStatusText, recapEntries
};

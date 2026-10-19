/**
 * [IS-SOURCE] Factory delle sorgenti dati SAP (feature 0013).
 *
 * PERCHE' ESISTE
 * Gli iFlow di SAP Integration Suite espongono un service root distinto per ogni coppia
 * (entity, operazione): non è possibile servirli con una sola istanza di servizio CAP,
 * perché `service.path` viene letto una volta in init() ed è statico per istanza
 * (remote/Service.js:216, DEC-18). Qui si tengono N istanze — una per service root — che
 * condividono lo STESSO modello CSN della entry base: `cds.connect.to(BASE, {credentials})`
 * restituisce un'istanza nuova e non cachata i cui oggetti entity sono gli STESSI della
 * entry base, quindi le query non vanno riscritte.
 *
 * Espone di proposito i soli membri che i chiamanti usano — `entities` e `run(query)` —
 * più la diagnostica: così le 43 letture esistenti non cambiano forma.
 *
 * COSA FA, IN UN PUNTO SOLO (TDD 0013 §3.2)
 *   1. pool memoizzato di istanze per service root                        (DEC-18)
 *   2. modalità (IS/ONPREM) e ORIGINE (predefinito/esplicito)             (FR-05, FR-06)
 *   3. assertPath su ogni path al bootstrap; path mancante -> throw       (anomalia A1)
 *   4. dispatch (entity, op) -> istanza, con throw rumoroso               (FR-02, TD-4)
 *   5. riscrittura in key predicate quando la rotta lo chiede
 *   6. chunking delle liste `in` a 15, in ENTRAMBE le modalità            (DEC-19)
 *   7. fan-out per chiave a concorrenza 8, senza tetto                    (FR-08)
 *   8. rilevazione del troncamento                                        (FR-12)
 *  8b. rilevazione delle righe prive di identità                          ([IS-BLANK-ROWS])
 *   9. una riga di log per lettura + riepilogo se più di una chiamata     (FR-16, M-07)
 *  10. describe(query) senza eseguire, e paths                            (isChannelDiag)
 *
 * NESSUNA NORMALIZZAZIONE DEI VALORI, IN NESSUN PUNTO (TD-10, FR-25).
 * Niente `padStart`, niente `trim` aggiunto, niente riformattazione di date, decimali o
 * booleani sui dati che arrivano dalla sorgente. Se un codice arriva senza zeri iniziali il
 * sistema NON lo aggiusta: la divergenza deve emergere dal confronto di collaudo e bloccare
 * l'attivazione dell'area (DEC-22). Un adattamento a runtime maschererebbe una divergenza di
 * contratto e la renderebbe scopribile mesi dopo, su dati già scritti.
 *
 * MODALITA'
 *   default (nessuna variabile impostata): IS, cioè gli iFlow.
 *   ONPREM è l'unico altro valore riconosciuto (insensibile a spazi e maiuscole); qualunque
 *   altro valore lascia attivo IS. In ONPREM le query restano quelle di sempre: il ramo IS
 *   delle modifiche di forma (§3.6.4) NON si applica (TD-5).
 *
 * ROLLBACK
 *   livello 1: <ENV_VAR>=ONPREM + restart, per area. Non richiede rilascio.
 *   livello 3: grep -rn "IS-ROUTING-LIST\|IS-SOURCE" -> perimetro completo delle due tranche.
 *
 * IN FONDO AL FILE C'E' `rawGet`, ed è ESERCIZIO: dalla feature 0019 è il trasporto con cui la
 * lettura dell'esplosione distinta base chiama un Function Import, forma che il CQN non sa
 * esprimere. Accanto a lei stava `rootOf`, diagnostico, rimosso il 03/09/2026 con le sonde di
 * lettura verso Integration Suite. Vedi il blocco di commento sopra la funzione.
 *
 * Vedi specs/0013-collegamento-path-is/ e srv/external/PRODUCTION_ROUTING_IS.md
 */

'use strict';

const cds = require('@sap/cds');
const Q = require('./isQueryShape');
// [IS-CALL-LOG] traccia delle letture leggibile dal browser: registra, non altera.
const Log = require('./isCallLog');
// [IS-CHANNEL] I tre gettoni della riga M-07 si compongono in un modulo puro, dove sono
// collaudabili: `run()` non lo e'.
const DumpRules = require('./isCallDumpRules');
// [IS-EGRESS] come esce una chiamata verso gli iFlow da questo processo: la destination vive in un
// punto solo.
const { resolveEgress, egressText } = require('./isEgress');

/** Soglia di spezzettamento delle liste `in` (DEC-19: 19 valori = 1021 caratteri, 20 = 1069). */
const DEFAULT_CHUNK_SIZE = 15;
/** Chiamate in volo del fan-out: ogni chiamata è un iFlow più una RFC su ECC. */
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_DESTINATION = 'MARS_SAP_CON';
const DEFAULT_CONFIG_KEY = 'isSource';

/**
 * Chiavi fallite riportate per una lettura tollerante. Servono a NOMINARE il difetto a chi
 * gestisce l'iFlow: dieci bastano, l'elenco completo di 300 renderebbe illeggibile la voce.
 */
const FAILED_KEYS_SHOWN = 10;

/**
 * Modalità e origine. L'origine serve a distinguere «qualcuno ha deciso IS per questo
 * ambiente» da «nessuno ha deciso e vale il default»: è ciò che rende un pin dimenticato
 * visibile guardando il log di avvio (TD-9, FR-06).
 */
function resolveMode(envVar, envAliases) {
  for (const name of [envVar, ...(envAliases || [])]) {
    if (!name) continue;
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') continue;
    const value = String(raw).trim();
    return {
      mode: value.toUpperCase() === 'ONPREM' ? 'ONPREM' : 'IS',
      origin: 'esplicito',
      originDetail: `${name}=${value}`
    };
  }
  return { mode: 'IS', origin: 'predefinito', originDetail: '(nessuna variabile impostata)' };
}

/**
 * Stato HTTP REALE del fallimento remoto. `e.statusCode` è 502 per QUALUNQUE fallimento:
 * lo normalizza CAP, non è lo stato restituito dall'Integration Suite. Quello vero è
 * annidato nella causa.
 */
function upstreamStatus(e) {
  return (e && ((e.reason && e.reason.response && e.reason.response.status) || (e.reason && e.reason.status))) || undefined;
}

/** Un 404 su una lettura per chiave è «elemento assente», non «non ho potuto leggere» (contratto §7). */
function isNotFound(e) {
  return upstreamStatus(e) === 404;
}

function errorText(e) {
  const up = upstreamStatus(e);
  return `${e && e.message}${up ? ` [stato reale upstream: ${up}]` : ''}`;
}

// ================================================================
// [IS-NO-USER] IL CONTESTO UTENTE DELLA LETTURA, DICHIARATO.
//
// PERCHE' ESISTE. Presso il cliente `MARS_SAP_CON` usa `OAuth2SAMLBearerAssertion`, che PRETENDE il
// JWT dell'utente: CAP lo prende da `cds.context.user.authInfo.token.jwt` e in fallback dall'header
// `Authorization` (remote/Service.js:283-287), il Cloud SDK lo scambia con un'asserzione SAML, e
// solo allora la chiamata parte (DEC-20, 0013 RB-43).
//
// [IS-EGRESS] VALE SOLO PER IL SERVER WEB, e da qui viene la ragione del canale batch: un run batch
// NON ha un utente, quindi su quella destination nessuna sua chiamata potrebbe funzionare. Dentro un
// job la destination e' `MARS_SAP_CON_BA`, con utenza tecnica, e questa nota non si emette affatto —
// sarebbe un falso allarme, ripetuto a ogni lettura (DEC-98).
//
// Il guasto del 19/08/2026 ha mostrato quanto quel presidio sia lontano dal suo sintomo, e la
// spiegazione che era scritta qui VALE SOLO DOVE I SERVIZI SONO APERTI — cioe' in sviluppo. Diceva:
// nessun service CDS ha `@requires`, quindi un JWT non piu' accettabile non produce un 401 pulito sul
// nostro endpoint, la richiesta viene servita come `anonymous`, da li' non c'e' piu' niente da
// scambiare e chi risponde `401` e' l'Integration Suite — tre livelli fra causa ed effetto.
//
// NEL PROFILO DI PRODUZIONE QUELLA CATENA NON PUO' AVVENIRE, verificato il 27/08/2026: CAP applica da
// se' `authenticated-user` a ogni servizio senza ruoli propri, quindi un token ASSENTE si fermerebbe
// a `http.js:62` e un token NON VALIDO a `jwt-auth.js:45-48`. In nessuno dei due casi la richiesta
// raggiunge un handler. Percio' un `401` dell'Integration Suite con utente identificato — quello del
// 27/08/2026 — NON e' questo meccanismo, e cercarlo li' costa tempo: la catena completa e le prove
// stanno nell'addendum del 27/08 a DEC-20 e nel blocco `@requires` di srv/cat-service.cds.
// Del guasto del 19/08 resta certo il SINTOMO (`401`, corpo vuoto, content-type non dichiarato); la
// sua spiegazione e' da riverificare, non da assumere.
//
// COSA FA E COSA NON FA. Dichiara, e nient'altro: una nota nella voce `[IS-CALL-LOG]` e una riga in
// `cf logs`. Non blocca la lettura, non cambia l'esito, non tocca i dati — stessa forma di
// `[IS-BLANK-ROWS]`. E il testo e' CONDIZIONALE di proposito: da qui non si vede come e' configurata
// la destination, e con `OAuth2ClientCredentials` (il piano originale D5, e possibilmente un
// ambiente interno) l'assenza di utente e' del tutto normale. Affermare «e' questo il difetto»
// sarebbe un falso allarme dove il difetto e' altrove.
//
// PURA: prende il contesto come parametro, quindi si collauda senza runtime CAP
// (test/isUserContext.test.js).
// ================================================================

/** Il JWT dell'utente, nelle forme in cui @sap/xssec lo espone. `null` se non ce n'e' uno. */
function userJwtOf(ctx) {
  const ai = ctx && ctx.user && ctx.user.authInfo;
  if (!ai) return null;
  const t = ai.token;
  if (typeof t === 'string' && t) return t;
  if (t && typeof t.jwt === 'string' && t.jwt) return t.jwt;
  if (typeof ai.getAppToken === 'function') {
    const v = ai.getAppToken();
    if (v) return v;
  }
  return null;
}

/**
 * [IS-NO-USER] Il token che CAP inoltrerebbe DAVVERO al Cloud SDK, header di ripiego compresi.
 *
 * PERCHE' NON BASTA `userJwtOf`. Le due funzioni rispondono a domande diverse, e confonderle e' ciò
 * che il 27/08/2026 ha reso la nota una prova inutilizzabile: `userJwtOf` dice «@sap/xssec espone un
 * token nella forma che conosciamo», questa dice «c'e' qualcosa da scambiare». CAP guarda
 * `cds.context.user.authInfo.token.jwt` e POI due header
 * (`remote/Service.js:283-287`), quindi un token che sta solo nell'header viene inoltrato lo stesso
 * — e dichiarare «manca il JWT» in quel caso sarebbe un falso allarme.
 *
 * Resta separata da `userJwtOf` di proposito: fondendole, il caso «anonimo CON Authorization» —
 * l'unico che nomina un descrittore xsuaa cambiato sotto una sessione aperta — troverebbe il token
 * nell'header e SMETTEREBBE di dichiararsi. Due domande, due funzioni.
 */
function forwardableJwtOf(ctx) {
  const own = userJwtOf(ctx);
  if (own) return own;
  const fromHeaders = (h) => {
    if (!h || typeof h !== 'object') return null;
    const v = h.authorization || h.Authorization;
    if (typeof v !== 'string') return null;
    const m = /^bearer\s+(.+)$/i.exec(v.trim());
    return m ? m[1] : null;
  };
  return fromHeaders(ctx && ctx.headers)
    || fromHeaders(ctx && ctx.http && ctx.http.req && ctx.http.req.headers)
    || null;
}

/**
 * [IS-NO-USER] Nota da allegare alla lettura, o stringa vuota se non c'e' niente da dichiarare.
 *
 * Le uscite non sono sfumature dello stesso caso, e la differenza e' tutto il valore diagnostico:
 *   - JWT presente                      -> '' (niente da dire);
 *   - nessun contesto di richiesta      -> lettura fuori da una richiesta HTTP, cioe' un processo
 *                                          pianificato (che per FR-24 non dovrebbe essere arrivato
 *                                          fin qui) o un bootstrap;
 *   - utente anonimo + `Authorization`  -> il token E' ARRIVATO e NON e' stato accettato. E' la
 *                                          firma di un descrittore xsuaa cambiato sotto una sessione
 *                                          aperta, ed e' il caso che nessun altro log nomina;
 *   - utente anonimo senza header       -> la richiesta e' arrivata nuda;
 *   - utente identificato, nessun JWT   -> non c'e' niente da inoltrare al Cloud SDK (la quinta
 *                                          uscita, aggiunta il 27/08/2026).
 *
 * DOVE OGNUNA PUO' USCIRE, e cambia come si legge questo presidio. Nel profilo di PRODUZIONE CAP
 * applica da se' `authenticated-user` a ogni servizio senza ruoli propri, quindi i due casi
 * `anonymous` sono IRRAGGIUNGIBILI dal server web — la richiesta si fermerebbe prima, a
 * `http.js:62` (token assente) o a `jwt-auth.js:45-48` (token non valido). «Nessun contesto» si vede
 * solo fuori da una richiesta HTTP, e dentro un job la nota e' soppressa (`[IS-EGRESS]`). Percio' in
 * esercizio l'unica uscita che puo' comparire nel server web e' la QUINTA. I due casi `anonymous`
 * restano perche' in SVILUPPO sono veri e utili: la' i servizi sono aperti.
 *
 * @param {object} ctx `cds.context`, o qualunque oggetto della stessa forma
 * @returns {string}
 */
function userContextNote(ctx) {
  const CONSEQUENCE =
    "se la destination usa OAuth2SAMLBearerAssertion (com'e' presso il cliente) lo scambio token non "
    + "puo' avvenire e il 401 che segue e' ATTESO; con OAuth2ClientCredentials e' ininfluente";

  if (userJwtOf(ctx)) return '';

  if (!ctx) {
    return `NESSUN CONTESTO DI RICHIESTA: lettura fuori da una richiesta HTTP, nessun JWT utente da inoltrare — ${CONSEQUENCE}`;
  }

  const uid = (ctx.user && ctx.user.id) || 'anonymous';
  // Un utente identificato senza JWT nella forma attesa non e' un difetto dimostrato: la shape del
  // token puo' cambiare fra versioni di @sap/xssec, e CAP ha comunque il fallback sull'header —
  // QUANDO quell'header c'e'. Se non c'e' nemmeno quello l'assenza e' DIMOSTRATA, e va detta: e' lo
  // stato che il 27/08/2026 ha prodotto un 401 identico a quello del 19/08 con questa nota muta,
  // cioe' con l'unica riga che avrebbe distinto le due cause assente da entrambi i casi.
  if (uid !== 'anonymous') {
    return forwardableJwtOf(ctx)
      ? ''
      : `UTENTE ${uid} IDENTIFICATO ma NESSUN JWT DA INOLTRARE: ne' in authInfo.token(.jwt) ne' `
        + `nell'header Authorization, cioe' in nessuna delle forme che CAP passa al Cloud SDK — `
        + `${CONSEQUENCE}`;
  }

  const headers = (ctx.http && ctx.http.req && ctx.http.req.headers) || {};
  const hadAuth = !!(headers.authorization || headers.Authorization);
  return hadAuth
    ? `UTENTE ANONIMO con header Authorization PRESENTE: il token e' arrivato e NON e' stato accettato ` +
      `(la richiesta e' stata servita comunque: succede dove i servizi sono APERTI, cioe' in sviluppo — ` +
      `nel profilo di produzione CAP l'avrebbe respinta prima con 401) — ${CONSEQUENCE}`
    : `UTENTE ANONIMO e nessun header Authorization: la richiesta e' arrivata senza token — ${CONSEQUENCE}`;
}

/**
 * [IS-SOURCE] Guardia dell'indirizzo INSERVIBILE, per le rotte tolleranti. Pura: si collauda
 * senza rete (test/fanOutPartial.test.js).
 *
 * Una rotta tollerante non esce al primo errore, altrimenti una chiave rotta azzererebbe le
 * altre. Ma se l'indirizzo è mal configurato TUTTE falliranno, e insistere per centinaia di
 * chiamate è solo tempo perso: si esce se la prima ondata piena è fallita al 100%.
 *
 * Due dettagli che sembrano cavilli e non lo sono:
 *  - i **404 contano come segno di vita**: un elemento assente dimostra che l'indirizzo risponde;
 *  - la guardia sta su `ok` (letture riuscite) e non sulle righe: una lettura che torna zero
 *    righe è un successo, non un fallimento.
 */
function fanOutHopeless({ ok, absent, failed, concurrency }) {
  return ok === 0 && absent === 0 && failed >= concurrency;
}

/**
 * [IS-SOURCE] Nota di log di una lettura tollerante: dichiara QUANTO è parziale e nomina le
 * chiavi che hanno fallito, che è ciò che serve a chi deve correggere l'indirizzo. Pura.
 * Stringa vuota quando non c'è niente da dichiarare.
 */
function partialNote({ rows, ok, calls, failed, failedKeys = [] }) {
  if (!failed) return '';
  const others = failed - failedKeys.length;
  return (
    `PARZIALE: ${rows} righe usabili da ${ok} letture riuscite su ${calls}, ${failed} fallite` +
    (failedKeys.length
      ? ` — chiavi: ${failedKeys.join(' ; ')}${others > 0 ? ` (+${others} altre)` : ''}`
      : '')
  );
}

/**
 * [IS-SOURCE] [CLFN-PARALLEL] La concorrenza chiesta dall'ambiente per un'area, o `0` se non c'è
 * (DEC-122).
 *
 * La leva prende il nome dalla leva d'area (`PRODUCT_SOURCE` -> `PRODUCT_SOURCE_CONCURRENCY`), così
 * chi sa commutare un'area sa anche regolarne il pool, senza un secondo vocabolario. Un valore non
 * numerico o non positivo NON e' un `0`: e' una leva scritta male, e si ignora dichiarandolo —
 * spegnere il fan-out per un errore di battitura fermerebbe ogni lettura dell'area.
 *
 * Pura, e con l'ambiente iniettabile per il test.
 *
 * @returns {number} la concorrenza chiesta, o `0` per «nessuna richiesta»
 */
function envConcurrency(envVar, env = process.env) {
  if (!envVar) return 0;
  const raw = env[`${envVar}_CONCURRENCY`];
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(`>>> [IS-SOURCE] ${envVar}_CONCURRENCY=${raw} NON VALIDA (serve un intero >= 1):`
      + ' si usa la concorrenza configurata');
    return 0;
  }
  return Math.floor(n);
}

/** Esegue `tasks` (funzioni async) con al massimo `limit` in volo, in ordine di partenza. */
async function withConcurrency(tasks, limit, shouldStop) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    for (;;) {
      if (shouldStop && shouldStop()) return;
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * @param {object}   spec
 * @param {string}   spec.base        entry cds.requires che porta il CSN condiviso (DEC-18)
 * @param {string}   [spec.configKey] sottochiave della entry con destination, timeout, soglie e paths
 * @param {string}   spec.envVar      leva di area: PRODUCT_SOURCE | PROD_ORDER_SOURCE | ROUTING_SOURCE
 * @param {string[]} [spec.envAliases] leve storiche ancora onorate (ROUTING_LIST_SOURCE, DEC-21)
 * @param {string}   spec.area        'materiali' | 'ordini' | 'cicli' (compare nei log)
 * @param {string}   [spec.tag]       tag grep-abile
 * @param {object}   spec.routes      { '<Entity>': { GET: {...}, QUERY: {...} } } — comportamenti, NON path
 * @returns {function(): Promise<object>} sorgente memoizzata
 */
function createRemoteSource({
  base,
  configKey = DEFAULT_CONFIG_KEY,
  envVar,
  envAliases = [],
  area,
  tag = '[IS-SOURCE]',
  routes
}) {
  let pending = null;

  async function build() {
    const baseSrv = await cds.connect.to(base);
    const { mode, origin, originDetail } = resolveMode(envVar, envAliases);
    const entryCfg = (cds.env.requires && cds.env.requires[base]) || {};
    const cfg = entryCfg[configKey] || {};
    const chunkSize = Number(cfg.chunkSize) > 0 ? Number(cfg.chunkSize) : DEFAULT_CHUNK_SIZE;
    // La concorrenza del fan-out, con una leva d'ambiente PER AREA che scavalca `package.json`:
    // `<envVar>_CONCURRENCY`, quindi `CLASSIFICATION_SOURCE_CONCURRENCY` e le sue sorelle. Serve a
    // calibrarla dove si misura — un valore in `package.json` si cambia solo con un rilascio, e la
    // via di ritorno da un pool troppo largo dev'essere piu' corta di così. Assente o non valida,
    // il comportamento e' quello di sempre: nessun default cambia.
    const concurrency = envConcurrency(envVar)
      || (Number(cfg.concurrency) > 0 ? Number(cfg.concurrency) : DEFAULT_CONCURRENCY);
    // [IS-EGRESS] Deciso QUI e non a caricamento del modulo: il marcatore di run batch lo scrive
    // `runJob()` a processo già partito. Una volta per area basta — un processo è server web *o* run
    // batch per tutta la vita — ed è ciò che rende onesta la riga di avvio qui sotto. Dentro un job
    // la destination è quella con utenza tecnica, perché là non c'è nessun utente da propagare
    // (vedi `[IS-NO-USER]` più sotto); fuori è quella configurata, verbatim.
    const eg = resolveEgress(process.env, { destination: cfg.destination || DEFAULT_DESTINATION });
    const destination = eg.destination;

    // ================================================================
    // [IS-CHANNEL] IL NOME DEL CANALE SU CUI LA LETTURA E' USCITA, IN UN'ESPRESSIONE SOLA.
    //
    // Serviva in tre punti — l'oggetto restituito, la voce dell'anello e la riga M-07 — e fino al
    // 02/09/2026 stava scritta in uno solo. Perche' non si usa `destination` grezza: in ONPREM le
    // chiamate NON escono da queste istanze ma da `baseSrv` con le credenziali della entry (DEC-34),
    // quindi dichiarare `MARS_SAP_CON_BA` su una lettura ONPREM sarebbe un log che MENTE su una cosa
    // che oggi nessuno afferma.
    //
    // PERCHE' IL CANALE VA SU OGNI RIGA DI LETTURA. Il 02/09/2026 la stessa lettura ordini — stesso
    // service root, stesso plant, stesso `$top`, `$select` sottoinsieme — ha reso 41 righe dal
    // cockpit e 0 righe da un run batch. Fra le due differivano TRE variabili (canale, `$top`,
    // `$select`) e la riga di lettura ne dichiarava ZERO: il canale stava solo sulla riga di avvio
    // M-08, stampata una volta per area. Sono serviti tre deploy per escluderne due per via
    // statica. Una riga di lettura deve portare le variabili che possono spiegarne il risultato.
    // ================================================================
    const channelDestination = mode === 'IS'
      ? destination
      : ((entryCfg.credentials || {}).destination || '(profilo locale)');

    const instances = new Map(); // 'Entity|OP' -> istanza remota
    const paths = {};            // 'Entity.OP'  -> path del service root
    // [IS-NO-USER] Una sola riga per AREA, non per processo: tre aree, al massimo tre righe, e ogni
    // area la scrive alla sua prima lettura senza utente.
    let warnedNoUser = false;

    if (mode === 'IS') {
      for (const [entity, byOp] of Object.entries(routes)) {
        for (const op of Object.keys(byOp)) {
          const key = `${entity}.${op}`;
          const path = (cfg.paths && cfg.paths[entity] && cfg.paths[entity][op]) || null;
          if (!path) {
            throw new Error(
              `${tag} area ${area}: canale IS attivo ma manca ` +
              `cds.requires.${base}.${configKey}.paths.${entity}.${op}`
            );
          }
          Q.assertPath(key, path);
          const inst = await cds.connect.to(base, {
            credentials: { destination, path, requestTimeout: cfg.requestTimeout }
          });
          // [IS-EGRESS] Su questa istanza NON si registra nessun gancio: fino al 28/08/2026 un
          // `before('*')` fondeva qui l'header applicativo, che ora non parte più da nessun canale.
          // Non è il posto in cui rimetterlo: queste istanze sono le stesse per il cockpit, le
          // azioni manuali e i cinque job — isolare per CHIAMANTE non si può — e un gancio
          // incondizionato rifarebbe il 26/08/2026, quando la lettura ordini della dashboard
          // rispondeva `500 INTERNAL_SERVER_ERROR` con l'header e `200` senza. L'unica cosa che il
          // canale batch cambia è la `destination` qui sopra, ed è per costruzione fuori dal ramo
          // ONPREM, che usa `baseSrv` (DEC-34).
          instances.set(`${entity}|${op}`, inst);
          paths[key] = path;
        }
      }
    } else {
      const creds = entryCfg.credentials || {};
      const onPrem = creds.path || creds.url || '(gateway on-premise)';
      for (const [entity, byOp] of Object.entries(routes)) {
        for (const op of Object.keys(byOp)) paths[`${entity}.${op}`] = onPrem;
      }
    }

    // ---- M-08: canale attivo, ORIGINE, destination e service root, all'avvio ----------
    if (mode === 'IS') {
      console.log(
        `>>> ${tag} area ${area}: canale IS (${origin}: ${originDetail}) — ` +
        `${instances.size} service root, chunk ${chunkSize}, concorrenza ${concurrency}, ` +
        `timeout ${cfg.requestTimeout || '(default CAP)'}, leva ${envVar}, ` +
        // [IS-EGRESS] Da dove esce, e perché da lì: la destination effettiva si legge a boot col
        // suo motivo, perché «non è un run batch» e «l'ha riportato indietro qualcuno con la leva»
        // non sono lo stesso fatto.
        egressText(eg)
      );
      for (const [key, path] of Object.entries(paths)) console.log(`>>> ${tag}   ${key} -> ${path}`);
    } else {
      console.log(
        `>>> ${tag} area ${area}: canale ONPREM (${origin}: ${originDetail}) — gateway on-premise ` +
        `${paths[Object.keys(paths)[0]]}, chunk ${chunkSize}, leva ${envVar}. ` +
        'Le modifiche di forma della 0013 sono INATTIVE: query identiche a prima del rilascio (TD-5)'
      );
    }

    // [IS-CALL-LOG] tap sul log delle richieste remote di CAP, per avere l'URL REALE nella
    // voce. Idempotente: la prima area che si inizializza lo installa per tutte.
    Log.installRemoteTap();
    // [IS-CALL-LOG] E il tap sulla RISPOSTA, che porta nella traccia lo scambio crudo: stato reale
    // anche sulle riuscite, content-type e corpo PRIMA che CAP tolga il wrapper `d`. Senza, la
    // forma di cio' che arriva dall'Integration Suite non e' osservabile da nessuna parte.
    Log.installResponseTap();

    /** Pianifica una lettura senza eseguirla: rotta, istanza, forma, query effettive. */
    function plan(query) {
      const entity = Q.entityNameOf(query);
      const derivedOp = Q.deriveOp(query);
      const route = Q.routeFor(routes, entity, derivedOp); // throw su entity/op ignota (FR-02)
      const target = mode === 'IS' ? instances.get(`${entity}|${route.op}`) : baseSrv;
      const notes = [];
      if (route.fallback) {
        notes.push(`rotta unica: operazione derivata ${derivedOp} instradata sul ${route.op}`);
      }

      let queries = [query];
      let form = 'collection';
      let fanOut = false;
      let predicateApplied = false;

      if (mode === 'IS') {
        // 1. fan-out per chiave: una lista su una rotta solo-GET DEVE diventare N letture
        if (route.fanOut) {
          const fan = Q.fanOutByKey(query, route.fanOut);
          if (fan.length > 1) {
            queries = fan;
            fanOut = true;
            form = 'fan-out per chiave';
            notes.push(`fan-out su ${route.fanOut}: ${fan.length} letture per chiave, concorrenza ${concurrency}, nessun tetto`);
          }
        }
        // 2. key predicate, se la rotta lo chiede e le chiavi ci sono
        if (route.keyPredicate) {
          let applied = 0;
          let missing = [];
          let droppedTop;
          queries = queries.map((q) => {
            const r = Q.toKeyPredicate(q, route.keyPredicate, {
              expectsList: !!route.expectsList,
              blanks: route.keyPredicateBlanks,
              blankValues: route.keyPredicateBlankValues
            });
            if (r.applied) { applied++; if (droppedTop === undefined) droppedTop = Q.topOf(q); }
            else missing = r.missing;
            return r.query;
          });
          if (applied === queries.length) {
            form = fanOut ? 'fan-out per chiave' : 'key predicate';
            predicateApplied = true;
            // [IS-FULL-KEY] l'indirizzo pretende il predicate completo: si dichiara quali
            // chiavi partono vuote, così la riga di log non le fa sembrare un difetto (DEC-41).
            // Dove il valore di riempimento NON è la stringa vuota lo si scrive per esteso: un `0`
            // (o uno spazio) in un URL non si distingue da una svista, e va detto che è voluto.
            // Su questi indirizzi il parametro dietro la chiave è NUMERICO: vuoto e spazio non
            // sono convertibili, `0` è l'iniziale ABAP (DEC-42).
            if (route.keyPredicateBlanks && route.keyPredicateBlanks.length) {
              const fills = route.keyPredicateBlankValues || {};
              const overridden = route.keyPredicateBlanks.filter(k => k in fills);
              const shown = route.keyPredicateBlanks
                .map(k => (k in fills ? `${k}='${fills[k]}'` : k));
              notes.push(
                'predicate completo: chiavi non note all\'applicazione inviate vuote ' +
                `(${shown.join(', ')})` +
                (overridden.length
                  ? ' — il valore fra apici è VOLUTO: il parametro dietro quella chiave è numerico, '
                    + 'e né vuoto né spazio sono convertibili'
                  : '')
              );
            }
            // [IS-FULL-KEY] il tetto scritto al call site sparisce, e non è una svista: va
            // dichiarato, perché da qui in poi il volume lo decide l'indirizzo (DEC-41)
            if (droppedTop) {
              notes.push(
                `$top ${droppedTop} rimosso: opzione di collection, una lettura per chiave la ` +
                'rifiuta con 400 — nessun tetto applicabile'
              );
            }
          } else {
            notes.push(
              `key predicate non applicabile (chiavi non risolvibili dal filtro: ${missing.join(', ')}): ` +
              'la lettura resta collection + $filter'
            );
          }
        }
        // 3. l'indirizzo è un _GET ma la chiave OData non è nota all'applicazione. Vale SOLO
        //    se nessun predicate è stato composto: altrimenti la forma è quella del predicate
        //    e sovrascriverla qui direbbe il falso nella riga di log (DEC-42).
        if (route.collectionFilter && !predicateApplied) {
          form = 'collection + $filter';
          notes.push(`chiave OData non nota all'applicazione: collection + $filter su ${route.collectionFilter}`);
        }
        // 4. l'indirizzo risponde con la lista dei figli: senza questo, il client remoto
        //    scarterebbe tutte le righe tranne la prima (remote/Service.js:306)
        if (route.expectsList) queries = queries.map(q => (q.SELECT && q.SELECT.one ? Q.withoutOne(q) : q));
      }

      // 5. chunking delle liste `in`: attivo in ENTRAMBE le modalità (DEC-19)
      const chunked = [];
      for (const q of queries) chunked.push(...Q.splitInList(q, chunkSize));
      if (chunked.length > queries.length) {
        notes.push(`liste in spezzate a ${chunkSize} valori: ${chunked.length} richieste`);
      }

      return {
        entity,
        derivedOp,
        op: route.op,
        route,
        target,
        path: paths[`${entity}.${route.op}`],
        form,
        fanOut,
        notes,
        queries: chunked,
        criteria: Q.describeWhere(chunked[0] || query)
      };
    }

    /** Una singola chiamata: righe, sospetto di troncamento, durata. */
    async function runOne(target, query, label) {
      const rows = await target.run(query);
      const n = Array.isArray(rows) ? rows.length : rows ? 1 : 0;
      const top = Q.topOf(query);
      if (Q.looksTruncated(rows, top)) {
        console.warn(
          `>>> ${tag} ${label}: ` +
          (rows && rows.$next != null
            ? 'risposta paginata (__next presente), CAP non la segue -> DATI TRONCATI'
            : `righe = $top (${top}), possibile troncamento -> verificare`)
        );
      }
      return { rows, n };
    }

    async function run(query) {
      const p = plan(query);
      const label = `${area}/${p.entity} ${p.op}`;

      // [IS-NO-USER] Il contesto utente si guarda PRIMA della chiamata, così la riga in `cf logs`
      // precede il 401 invece di seguirlo. Solo in IS: in ONPREM la destination non fa scambio
      // token e la nota sarebbe rumore. La `console.warn` è una sola per AREA — la nota nella voce
      // `[IS-CALL-LOG]` resta invece su OGNI lettura, ed è quella completa: un job con 300 letture
      // per chiave riempirebbe `cf logs` di una riga identica, che non aggiunge niente alla prima.
      // Il try non è decorativo: questo gira su OGNI lettura delle tre aree, e una diagnostica che
      // lancia fermerebbe il flusso che doveva solo descrivere.
      let noUserNote = '';
      try {
        // [IS-EGRESS] E NON su un canale batch: là la destination è quella con utenza tecnica, dove
        // nessun utente serve e nessun token va scambiato. Dichiarare «manca il JWT» in un run che
        // per costruzione non ne ha uno sarebbe il falso allarme che questo blocco vuole evitare —
        // e sarebbe una riga per ogni lettura del job.
        if (mode === 'IS' && !eg.batch) noUserNote = userContextNote(cds.context);
      } catch (e) {
        noUserNote = '';
      }
      if (noUserNote && !warnedNoUser) {
        warnedNoUser = true;
        console.warn(`>>> ${tag} ${label}: ${noUserNote}`);
      }

      const t0 = Date.now();
      const calls = p.queries.length;
      const collected = [];
      let rowCount = 0;
      let okCount = 0;
      let notFound = 0;
      let errCount = 0;
      let firstError = null;
      let single = null;
      const failedKeys = [];

      // [IS-SOURCE] Rotta TOLLERANTE: una chiave che manda l'indirizzo in errore non deve
      // azzerare le altre 303. Ha senso solo col fan-out, quindi in ONPREM è spenta per
      // costruzione: `fanOut` si imposta soltanto dentro il ramo `mode === 'IS'` di plan().
      const tolerant = p.fanOut && !!p.route.tolerant;

      const tasks = p.queries.map((q, i) => async () => {
        try {
          const r = await runOne(p.target, q, `${label} ${calls > 1 ? `(${i + 1}/${calls})` : ''}`.trim());
          rowCount += r.n;
          okCount++;
          if (calls === 1) single = r.rows;
          else if (Array.isArray(r.rows)) collected.push(...r.rows);
          else if (r.rows) collected.push(r.rows);
        } catch (e) {
          // 404 su una lettura per chiave = elemento assente, non lettura fallita.
          if (isNotFound(e) && (p.form === 'key predicate' || p.form === 'fan-out per chiave')) {
            notFound++;
            return;
          }
          errCount++;
          if (failedKeys.length < FAILED_KEYS_SHOWN) failedKeys.push(Q.describeWhere(q));
          if (!firstError) firstError = e;
        }
      });

      const shouldStop = tolerant
        ? () => fanOutHopeless({ ok: okCount, absent: notFound, failed: errCount, concurrency })
        : () => firstError !== null;

      // [IS-CALL-LOG] `within` apre il contesto della lettura: gli URL costruiti da CAP dentro
      // queste chiamate — fan-out concorrente compreso — si attribuiscono a questa voce.
      const rec = Log.begin();
      await Log.within(rec, async () => {
        if (p.fanOut) await withConcurrency(tasks, concurrency, shouldStop);
        else for (const t of tasks) { if (firstError) break; await t(); } // chunk sequenziali, come prima
      });

      const ms = Date.now() - t0;
      const notes = p.notes.slice();
      // [IS-NO-USER] In testa alle note: su un KO 401 è la prima cosa da leggere.
      if (noUserNote) notes.unshift(noUserNote);
      if (notFound) notes.push(`${notFound} elementi assenti (404 su lettura per chiave)`);
      if (tolerant) {
        const partial = partialNote({ rows: rowCount, ok: okCount, calls, failed: errCount, failedKeys });
        if (partial) notes.push(partial);
      }

      const shown = p.queries[0] || query;
      const columns = Log.columnsOf(shown);
      const top = Q.topOf(shown);

      // ================================================================
      // [IS-BLANK-ROWS] Righe prive di identità: si DICHIARANO, non si aggiustano.
      //
      // È il punto unico in cui passa ogni lettura delle tre aree, quindi è il punto in cui la
      // firma del difetto di E-13 (200 ben formato, valori tutti iniziali) diventa visibile
      // anche per i 4 job batch, che hanno solo `cf logs`. Qui NON si scarta nulla: la
      // selezione delle righe utilizzabili è una decisione del chiamante, e `run()` non tocca
      // i dati (TD-10, FR-25).
      //
      // Si contano solo i campi identità effettivamente CHIESTI: un campo fuori dal `$select`
      // non è vuoto, è non letto, e confonderli trasformerebbe letture sane in allarmi.
      // Le righe con identità RIPETUTA non si dichiarano qui: su alcune entity la ripetizione
      // è legittima (più assegnazioni materiale per ciclo) e conta solo dove la tupla è la
      // chiave OData esposta, cioè nei READ handler.
      // ================================================================
      const identity = (p.route.identity || [])
        .filter(f => columns === '(tutti)' || columns.split(',').includes(f));
      if (identity.length) {
        const idCheck = Q.identityCheck(calls === 1 ? single : collected, identity, { dedupe: false });
        if (idCheck.blank) {
          const note =
            `${idCheck.blank} righe su ${idCheck.total} PRIVE DI IDENTITA' ` +
            `(${identity.join(', ')} tutti vuoti): risposta strutturalmente valida e semanticamente ` +
            'vuota — difetto della sorgente, non del chiamante';
          notes.push(note);
          console.warn(`>>> ${tag} ${label}: ${note}`);
        }
      }

      // ---- [IS-CALL-LOG] la stessa lettura, in coda per il browser -------------------
      Log.push({
        rec, area, mode,
        // [IS-CHANNEL] Le due destination del progetto puntano allo STESSO host CPI, quindi negli
        // `urls` della voce sono indistinguibili: senza questo campo l'anello non sa dire su quale
        // canale una lettura e' uscita.
        destination: channelDestination,
        entity: p.entity, op: p.op, derivedOp: p.derivedOp,
        root: p.path, form: p.form, calls, rows: rowCount, ms,
        outcome: firstError ? 'KO' : 'OK',
        criteria: p.criteria, columns, top,
        request: Log.requestLine({ root: p.path, entity: p.entity, columns, criteria: p.criteria, top }),
        notes,
        error: firstError ? errorText(firstError) : '',
        upstreamStatus: firstError ? upstreamStatus(firstError) : 0,
        // Sul ramo d'errore CAP conserva l'URL assoluto della chiamata fallita: e' l'indirizzo
        // vero anche se il tap non ha catturato la riga di debug.
        fallbackUrl: firstError && firstError.reason && firstError.reason.request
          ? firstError.reason.request.url : '',
        responseBody: firstError && firstError.reason && firstError.reason.response
          ? firstError.reason.response.body : '',
        // Su lettura tollerante il campione si mostra ANCHE in KO: è la prova che le righe
        // dichiarate «usabili» nella nota PARZIALE sono dati veri, non un conteggio.
        firstRow: firstError && !tolerant ? '' : Log.sample(calls === 1 ? single : collected)
      });

      // ================================================================
      // ---- M-07: una riga per lettura, con l'indirizzo usato -------------------------
      //
      // [IS-CHANNEL] I TRE GETTONI che il 02/09/2026 mancavano: canale, tetto chiesto e ampiezza
      // del `$select`. Sono le tre variabili che possono spiegare il risultato di una lettura, e
      // questa riga e' l'unico posto in cui compaiono TUTTE E TRE SEMPRE: e' senza criterio e senza
      // tetto — c'e' su ogni lettura di ogni processo, i sette job compresi, e non dipende da
      // nessuna leva. Costa ~35 caratteri per riga.
      //
      // Limite da conoscere: `$select N col.` dice QUANTE, non QUALI. Un campo sbagliato fra
      // quattordici resta invisibile qui: per quello serve il dump della voce ([IS-CALL-LOG] DUMP)
      // o `window.isCalls()` dal browser.
      //
      // `$top ASSENTE` non e' un dettaglio di formattazione: verso questi iFlow un tetto assente e'
      // un rischio dichiarato (un limite non onorato e' piu' pericoloso di un limite assente), e
      // `looksTruncated` piu' sopra si accende solo se il tetto c'e'. Vederlo scritto e' cio' che
      // permette di escluderlo come causa invece di dedurlo dal codice.
      // ================================================================
      // I gettoni si compongono in un modulo PURO, non qui: `run()` non e' collaudabile (vuole il
      // runtime CAP e le destination) e questi tre esistono proprio perche' il 02/09/2026 sono
      // mancati — una difesa che non si puo' vedere fallire non e' una difesa.
      const tok = DumpRules.readLineTokens({ destination: channelDestination, top, columns });
      const head =
        `>>> ${tag} ${label} | ${mode} | ${tok.destination}` +
        ` | ${p.path || '(gateway on-premise)'} | criteri: ${p.criteria}` +
        ` | forma: ${p.form} | ${tok.top} | ${tok.columns}` +
        ` | chiamate ${calls} | righe ${rowCount} | ${ms} ms`;
      if (firstError) {
        // `isExtensible`: se un domani CAP rigettasse con un oggetto sigillato, l'annotazione
        // salta ma la lettura resta dichiarata dalla nota PARZIALE — non si trasforma in un
        // TypeError che nasconde l'errore vero.
        if (tolerant && Object.isExtensible(firstError)) {
          // [IS-SOURCE] La lettura resta KO: un fallimento non diventa MAI un OK silenzioso
          // (0013, flusso E). Ma le righe già arrivate non si buttano — chi sa cosa sta facendo
          // le prende da qui — e le chiavi fallite sono la prova da consegnare a chi gestisce
          // l'iFlow. Si annota sull'errore esistente invece di incapsularlo, così `status` e
          // `reason` restano quelli veri e isNotFound()/upstreamStatus() continuano a funzionare.
          firstError.partialRows = collected;
          firstError.partialRowCount = rowCount;
          firstError.failedCount = errCount;
          firstError.failedKeys = failedKeys;
        }
        console.error(`${head} | ESITO KO: ${errorText(firstError)}${notes.length ? ` | ${notes.join(' | ')}` : ''}`);
        throw firstError;
      }
      console.log(`${head} | ESITO OK${notes.length ? ` | ${notes.join(' | ')}` : ''}`);
      if (calls > 1) {
        console.log(`>>> ${tag} ${label}: riepilogo — ${calls} chiamate, ${rowCount} righe unite, ${notFound} assenti, ${ms} ms`);
      }

      // Una sola chiamata: si restituisce il risultato COSI' COM'E', perché una query
      // `SELECT.one` deve continuare a tornare un oggetto e non un array.
      return calls === 1 ? single : collected;
    }

    return {
      /** Definizioni CSN: sono gli stessi oggetti della entry base, condivisi da tutte le istanze. */
      entities: baseSrv.entities,
      area,
      base,
      mode,
      origin,
      originDetail,
      envVar,
      // [IS-CHANNEL] Un'espressione sola, tre lettori: qui, la voce dell'anello e la riga M-07.
      destination: channelDestination,
      chunkSize,
      concurrency,
      paths,

      /** Dove finirebbe questa query, e in che forma, senza eseguirla. */
      describe(query) {
        try {
          const p = plan(query);
          return {
            area, mode, origin, originDetail,
            entity: p.entity, op: p.op, derivedOp: p.derivedOp,
            path: mode === 'IS' ? p.path : undefined,
            form: p.form, calls: p.queries.length,
            criteria: p.criteria,
            notes: p.notes
          };
        } catch (e) {
          return { area, mode, origin, originDetail, entity: Q.entityNameOf(query), error: e.message };
        }
      },

      run,

      // ================================================================
      // [PHANTOM-EXPLODE] `rawGet` — TRASPORTO D'ESERCIZIO, NON DIAGNOSTICA
      //
      // COSA FA: manda una GET con la query string SCRITTA A MANO sullo stesso service
      // root che `run()` userebbe per quella coppia (entity, operazione) — stessa istanza,
      // stessa destination, stessa auth, stesso path. Non passa dal CQN, quindi può mandare
      // ciò che CAP non genera.
      //
      // PERCHE' NON SI RIMUOVE (feature 0019). L'esplosione della distinta base è un
      // FUNCTION IMPORT — `ExplodeBOM?Material='…'&Plant='…'&…` — e il CQN non sa
      // esprimerla: `plan()` produrrebbe un key predicate, cioè una richiesta con la query
      // string vuota, che muore sulla guardia `if (!query)` dell'iFlow. Questo è quindi
      // l'UNICO trasporto con cui l'esplosione è chiamabile, ed è un percorso di esercizio.
      //
      // NATA COME DIAGNOSTICA, e il tag di rimozione delle sonde è stato TOLTO da qui il
      // 03/09/2026, quando le quattro sonde di lettura verso Integration Suite sono sparite: erano
      // quattro dei cinque chiamanti, ma il quinto — srv/lib/bomExplode.js — è esercizio. Se il tag
      // fosse rimasto, la prima ricerca del perimetro avrebbe proposto di cancellare l'esplosione
      // dei fantasma. E' la conseguenza n.1 di DEC-57, avverata: un tag di rimozione su una
      // funzione che ha cambiato ruolo è una trappola armata.
      //
      // Chiamante unico: srv/lib/bomExplode.js (`readItemsViaExplode`).
      // ================================================================
      /**
       * @param {string} entity 'MaterialBOM' — sceglie l'ISTANZA, cioè il service root
       * @param {string} op     'QUERY' | 'GET' — idem
       * @param {string} suffix ciò che segue il service root, senza slash iniziale e già
       *                        percent-encoded: `ExplodeBOM?Material='…'` oppure `$metadata`
       * @param {string} [accept] forza l'header accept. Serve a `$metadata`, che vuole XML:
       *                          l'accept di default di CAP (application/json) prende 406.
       * @returns {Promise<any>} il corpo della risposta così com'è. LANCIA in caso di errore:
       *   è il chiamante a doverlo catturare, perché è lì che sta l'esito.
       */
      async rawGet(entity, op, suffix, accept) {
        if (mode !== 'IS') {
          throw new Error(`${tag} rawGet è utilizzabile solo in modalità IS (modalità attiva: ${mode})`);
        }
        const target = instances.get(`${entity}|${op}`);
        if (!target) {
          throw new Error(`${tag} nessun service root configurato per ${entity}.${op}`);
        }
        // Lo slash iniziale è OBBLIGATORIO: senza, _pathToRequestConfig (remote/utils/query.js:75-95)
        // rimaneggia il path con una regex. Con lo slash il path passa intatto e il service
        // root gli viene anteposto a query.js:190.
        return target.send({
          method: 'GET',
          path: `/${suffix}`,
          ...(accept ? { headers: { accept } } : {})
        });
      }
    };
  }

  function source() {
    if (!pending) {
      pending = build().catch((e) => { pending = null; throw e; });
    }
    return pending;
  }

  /** Solo per i test: azzera la memoizzazione. */
  source._reset = () => { pending = null; };
  source.routes = routes;
  source.envVar = envVar;
  source.area = area;
  return source;
}

module.exports = createRemoteSource;
module.exports.DEFAULT_CHUNK_SIZE = DEFAULT_CHUNK_SIZE;
module.exports.DEFAULT_CONCURRENCY = DEFAULT_CONCURRENCY;
module.exports.upstreamStatus = upstreamStatus;
module.exports.errorText = errorText;
// Esportate per test/fanOutPartial.test.js: lo scheduler del fan-out e le due regole pure
// della tolleranza, collaudabili senza rete e senza runtime CAP.
module.exports.withConcurrency = withConcurrency;
module.exports.envConcurrency = envConcurrency;
module.exports.fanOutHopeless = fanOutHopeless;
module.exports.partialNote = partialNote;
module.exports.FAILED_KEYS_SHOWN = FAILED_KEYS_SHOWN;
// [IS-NO-USER] Pure: prendono il contesto come parametro. test/isUserContext.test.js.
module.exports.userContextNote = userContextNote;
module.exports.userJwtOf = userJwtOf;
module.exports.forwardableJwtOf = forwardableJwtOf;

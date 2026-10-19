/**
 * Job BTP — Sincronizzazione DELTA dei cicli routing verso Plex.
 *
 * [ROUTING-BY-MATERIAL] L'UNITA' DI LAVORO E' (ciclo, MATERIALE), non il ciclo.
 * Su Plex il ciclo vive sulla part, quindi N materiali di testata sullo stesso ciclo SAP sono N
 * cicli indipendenti e N invii distinti. Prima il job prendeva il PRIMO materiale del ciclo e
 * inviava solo su quella part: gli altri materiali non ricevevano nulla, e il run chiudeva verde.
 * L'elenco del lavoro NON si costruisce piu' interrogando MAPL: sono i cicli SALVATI a portare il
 * proprio materiale (`ZPlexRoutingCycleOperation.HeaderMaterial`), quindi il job invia esattamente
 * cio' che qualcuno ha costruito. MAPL resta un RIPIEGO per le righe non ancora attribuite dal
 * backfill (srv/lib/routingMaterialBackfill.js).
 *
 * Invia a Plex i cicli di routing salvati localmente (part-operation + componenti
 * BOM + workcenter) applicando una logica di **delta su data di modifica**:
 *   - ciclo MAI inviato (nessuna riga in ZRoutingExcLogHDR)          -> invia
 *   - ultimo invio NON riuscito (Status != 'S'/'W')                  -> invia
 *   - ciclo salvato DOPO l'ultimo invio                              -> invia
 *   - altrimenti (già inviato e non modificato)                      -> salta
 *
 * "Data di salvataggio" del ciclo: le tabelle ZPlexRoutingCycle* sono `managed` e
 * saveRoutingPlexCycle le ricrea (DELETE+INSERT) ad ogni salvataggio, quindi la
 * data di salvataggio = MAX(modifiedAt) sulle righe di ZPlexRoutingCycleOperation.
 * "Data ultimo invio": ZRoutingExcLogHDR.SentDate + SentTime (UTC). Il confronto è
 * a granularità di secondo su stringhe ISO UTC.
 *
 * L'invio vero e proprio (part-operation + componenti + workcenter, idempotenza,
 * **customizing per-plant op-field**, scrittura log ZRoutingExcLogHDR/POS) è
 * delegato all'action CAP esistente ProductionRouting.syncRoutingPlexCycle
 * (srv/cat-service.js): il job non duplica quella logica, la invoca in-process.
 * Il customizing è quindi rispettato automaticamente.
 *
 * [ROUTING-COMP-SOURCE] DALLA FEATURE 0025 QUESTO JOB DECIDE ANCHE *QUALI* COMPONENTI INVIARE.
 * Con `AutoAssignBomOnSync` acceso sul plant, l'azione ricostruisce l'elenco dei componenti da
 * DUE letture di SAP — l'assegnazione componente-operazione del ciclo, come sempre, e la distinta
 * del materiale di testata alla data di riferimento configurata nella scheda «Distinta base» —
 * e li colloca con le regole dei gruppi oggetto. Due conseguenze da conoscere prima di leggere il
 * resto: un componente che le regole vogliono altrove viene SPOSTATO (prima restava dove era
 * stato messo la prima volta), e un ciclo con anche un solo componente senza operazione NON viene
 * inviato affatto e viene contato fra i FALLITI, con l'elenco dei componenti e dei motivi nel
 * recap e quindi nella mail. Il perimetro e' `grep -rn "ROUTING-COMP-SOURCE"`.
 *
 * [ROUTING-ORPHAN] IL JOB NON PARTE DA SAP, E QUINDI UNA ROUTING SENZA ALBERO NON ESISTE.
 * L'elenco del lavoro e' `enumerateSavedCycles()`: SAP viene letto DOPO, e solo per capire di CHI
 * sia ognuno dei cicli salvati. Una routing SAP per cui nessuno ha costruito un ciclo non e'
 * saltata e non e' un errore — non entra mai nel perimetro, e non lascia traccia da nessuna
 * parte. E' il disegno. Il caso OPPOSTO invece va dichiarato: un ciclo che qualcuno ha costruito
 * e la cui testata SAP non si risolve piu' non partira' MAI PIU', e finiva in un contatore muto
 * insieme ai plant non licenziati. I verdetti stanno in srv/lib/routingSyncSkipRules.js.
 *
 * [ROUTING-PLANT] MA IL PERIMETRO NON SI LEGGE PER GRUPPO: SI LEGGE PER PLANT.
 * Il plant di un ciclo salvato veniva da UNA lettura, le testate filtrate per
 * `ProductionRoutingGroup in (...)` senza plant — la forma che DEC-49 vieta. Un plant non risolto
 * usciva dal ramo `!plant` e finiva fra i «plant non attivo», cioe' nel contatore del gate di
 * licenza: un ciclo salvato di un plant LICENZIATO non veniva inviato e il run chiudeva verde.
 * Ora le due letture sono quelle della lista cicli — testate e assegnazioni, entrambe per
 * `Plant in (plant licenziati)` — e le righe si uniscono con lo stesso modulo puro,
 * `routingMaterialRules.joinRoutingRows`, cosi' plant e testata nascono dalla STESSA riga.
 * Il dettaglio sta in testa a `resolveRoutingContext`.
 *
 * Eseguito dal SAP BTP Job Scheduler tramite:
 *     node srv/jobs/syncRoutingsToPlex.js   (oppure `npm run job-sync-routings`).
 */

const cds = require('@sap/cds');
const { resolveActivePlants } = require('./lib/plexJobsClient');
// [IS-SOURCE] Sorgente dell'area cicli (feature 0013): canale scelto da ROUTING_SOURCE
// (alias storico ROUTING_LIST_SOURCE ancora onorato, DEC-21).
const routingSource = require('../lib/routingSource');
// [ROUTING-SCOPE] Perimetro dei cicli per stato/utilizzo (feature 0016): un ciclo fuori dalle
// regole del suo plant non esiste per noi, quindi non si invia.
const routingVisibility = require('../lib/routingVisibility');
// [ROUTING-ORPHAN] Il verdetto su un ciclo salvato — si invia, oppure no e perche'. Puro, con il
// suo test: node test/routingSyncSkipRules.test.js
const skipRules = require('../lib/routingSyncSkipRules');
// [ROUTING-PLANT] Il join della lista cicli: e' lo STESSO modulo puro, non una seconda copia.
// Una copia divergerebbe, e la divergenza fra la lista (che mostra un ciclo) e il job (che non lo
// invia) e' esattamente il difetto da cui nasce questo riuso. Test: node test/routingMaterialRules.test.js
const routingMaterialRules = require('../lib/routingMaterialRules');

// [LOG-MSG-I18N] I messaggi del recap sono segmenti (feature 0031): il testo si rende qui.
const logMsg = require('../lib/logMessage');
const i18nMessages = require('../lib/i18nMessages');

/** Il testo di una lista di segmenti, in italiano: e' cio' che va nelle colonne e nella mail. */
const renderMsg = (segments) => i18nMessages.render(
  logMsg.normalize(segments), i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE
);

const ROUTING_SERVICE = 'ProductionRouting';                           // servizio CAP locale (action)
const NS = 'avvaleplm.marsplm.sap2plex';
// In contesto job standalone `db.entities` non è invocabile: si usa il nome FQN.
const E_CYCLE_OP = `${NS}.ZPlexRoutingCycleOperation`;
const E_LOG_HDR = `${NS}.ZRoutingExcLogHDR`;

// Numero massimo di cicli inviati per esecuzione (0 = illimitato).
const MAX_ROUTINGS_PER_RUN = parseInt(process.env.PLEX_ROUTING_MAX_PER_RUN || '0', 10);

// [ROUTING-PLANT] Il tetto delle due letture di perimetro, lo stesso della lista cicli
// (`READ Routings`, Step 1 e 3). Non e' un'ottimizzazione: e' il limite oltre il quale il
// perimetro sarebbe tagliato in silenzio, e per questo il troncamento si DICHIARA nel recap.
const ROUTING_READ_LIMIT = 10000;

// [ROUTING-COMP-SOURCE] Ricalcolo dei componenti del ciclo prima dell'invio (feature 0025).
//
// Il flag non significa piu' «assegna i componenti che mancano»: significa «l'elenco dei
// componenti del ciclo lo costruisce il job». Con il flag acceso, a ogni esecuzione l'elenco
// desiderato viene rifatto dalle due letture SAP e le righe AUTOMATICHE vengono ricollocate
// secondo le regole dei gruppi oggetto — quindi un cambio nella scheda dei gruppi ha effetto
// anche sui cicli gia' costruiti, che prima non accadeva. Le righe collocate a mano nel cockpit
// restano dove sono. E se anche un solo componente non trova un'operazione, il ciclo NON viene
// inviato affatto.
//
// Deciso per-plant dal flag di customizing ZPlant.AutoAssignBomOnSync (default false = opt-in).
// La env var PLEX_ROUTING_AUTOASSIGN=false resta un kill-switch globale d'emergenza, e ora spegne
// anche il blocco: a flag spento il job invia il ciclo esattamente com'e' salvato.
const AUTO_ASSIGN_DISABLED_GLOBALLY = (process.env.PLEX_ROUTING_AUTOASSIGN || '').toLowerCase() === 'false';

// ================================================================
// [ROUTING-BOM-DRIFT] Il confronto con la distinta su Plex (feature 0047).
//
// Il delta guarda la data dell'ultimo SALVATAGGIO LOCALE, quindi non vede niente di cio' che cambia
// in SAP. I cicli che scarta passano ora da un secondo giro che CHIEDE a Plex cosa ha e reinvia solo
// se non combacia — perimetro: i plant con l'auto-assegnazione accesa, gli unici in cui l'elenco dei
// componenti lo costruisce il job dalle letture SAP e quindi esiste un termine di paragone.
//
// ACCESO PER DEFAULT, e la ragione e' la solita asimmetria: il difetto che si vuole chiudere e' una
// distinta vecchia su Plex che nessuno vede, e sta li' da mesi. `PLEX_ROUTING_BOM_VERIFY=off` spegne
// il giro senza un rilascio, e il run torna identico a prima.
//
// IL TETTO E' PER LA DURATA, non per la sicurezza: il confronto costa alcune letture SAP e una GET
// Plex per ciclo, e un plant con centinaia di cicli allunga il run. `0` = illimitato, come
// `PLEX_ROUTING_MAX_PER_RUN`. Attenzione, e va detto perche' e' una lacuna e non una scelta: con il
// tetto acceso l'ordine e' quello dell'enumerazione, quindi gli ULTIMI cicli non verrebbero
// confrontati mai — non c'e' un punto di ripresa persistito per ciclo. Chi accende il tetto lo
// accetta, e il recap dichiara quanti sono rimasti fuori.
// ================================================================
const VERIFY_ENABLED = (process.env.PLEX_ROUTING_BOM_VERIFY || '').toLowerCase() !== 'off';
const VERIFY_MAX_PER_RUN = parseInt(process.env.PLEX_ROUTING_VERIFY_MAX_PER_RUN || '0', 10);

// [ROUTING-PLANT] `trim` e nient'altro (0015 RB-05: mai `padStart`, allineare gli zeri
// significherebbe decidere il formato di SAP invece di riscontrarlo). Serve perche' i due lati
// del confronto hanno provenienze diverse: la chiave dei cicli SALVATI viene dal database
// locale, quella del perimetro dalle righe del join, che sono gia' passate da `keyPart`.
const key = (g, r) => `${String(g ?? '').trim()}|${String(r ?? '').trim()}`;
// [ROUTING-BY-MATERIAL] La chiave dell'unita' di lavoro: ciclo + materiale di testata.
const mkey = (g, r, m) => `${g}|${r}|${m || ''}`;

// ================================================================
// Enumerazione cicli salvati + data di salvataggio (MAX modifiedAt)
// ================================================================

/**
 * Raccoglie i cicli routing salvati localmente e, per ciascuno, la data di
 * salvataggio = MAX(modifiedAt) sulle righe operazione.
 *
 * [ROUTING-BY-MATERIAL] Un'entrata per (ciclo, MATERIALE): due materiali dello stesso ciclo SAP
 * sono due cicli Plex, con date di salvataggio proprie e delta indipendenti. Le righe scritte prima
 * della 0015 hanno `HeaderMaterial` vuoto e formano un'entrata a materiale vuoto, che il ciclo di
 * invio risolve col ripiego su MAPL.
 * @param {object} db
 * @returns {Promise<Map<string, {ProductionRoutingGroup, ProductionRouting, HeaderMaterial, SaveTs}>>}
 *          key = "group|routing|material"; SaveTs = ISO UTC troncato ai secondi.
 */
async function enumerateSavedCycles(db) {
  const rows = await db.run(
    SELECT.from(E_CYCLE_OP).columns(
      'ProductionRoutingGroup', 'ProductionRouting', 'HeaderMaterial', 'modifiedAt')
  );
  const map = new Map();
  for (const r of rows) {
    const material = String(r.HeaderMaterial ?? '').trim();
    const k = mkey(r.ProductionRoutingGroup, r.ProductionRouting, material);
    // modifiedAt ISO '2026-07-13T06:36:55.123Z' -> secondi 'YYYY-MM-DDTHH:MM:SS'
    const ts = r.modifiedAt ? String(r.modifiedAt).slice(0, 19) : '';
    const cur = map.get(k);
    if (!cur) {
      map.set(k, {
        ProductionRoutingGroup: r.ProductionRoutingGroup,
        ProductionRouting: r.ProductionRouting,
        HeaderMaterial: material,
        SaveTs: ts
      });
    } else if (ts > cur.SaveTs) {
      cur.SaveTs = ts;
    }
  }
  return map;
}

/**
 * Il contesto dei cicli in perimetro: PLANT, testata (stato e utilizzo) e materiale di RIPIEGO.
 *
 * [ROUTING-PLANT] IL PLANT DEL CICLO VIENE DALLE STESSE DUE LETTURE DELLA LISTA CICLI.
 *
 * Prima veniva da UNA lettura sola, le testate filtrate per `ProductionRoutingGroup in (...)`
 * senza plant — la forma che DEC-49 vieta, perche' nelle firme delle funzioni ABAP dietro gli
 * iFlow `SO_PLANT` e' OBBLIGATORIO e i criteri per gruppo sono opzionali: cio' che torna non e'
 * garantito, e una collection corta non si distingue da una completa. Il 02/09/2026 quella
 * lettura ha risposto `3` righe per 3 gruppi mentre la lista, nello stesso minuto e sullo stesso
 * tenant, ne leggeva 51 per plant (28 testate distinte). I cicli il cui plant non si risolveva
 * uscivano dal ramo `!plant` e finivano fra i «plant non attivo», cioe' nel contatore del gate di
 * licenza: un ciclo salvato di un plant licenziato non veniva inviato, e il run chiudeva verde.
 * DEC-49 nominava gia' questa funzione come portatrice dello «stesso difetto e stesso rimedio»;
 * il rimedio era stato applicato alla sola lettura MAPL.
 *
 * Ora entrambe le letture portano `Plant in (plant attivi e licenziati)` — che sono noti PRIMA di
 * qualunque lettura SAP, quindi la circolarita' di prima (i plant della lettura MAPL derivati
 * dalle testate) non serve piu' — e le righe si uniscono con lo stesso modulo puro della lista,
 * `routingMaterialRules.joinRoutingRows`. Non si aggiunge un criterio per gruppo nemmeno IN
 * AGGIUNTA: la lista non lo spinge, e DEC-49 conseguenza 3 dichiara non riscontrato se quel
 * criterio sia mappato del tutto.
 *
 * IL PREZZO SI DICHIARA. Leggendo solo i plant licenziati — obbligatorio, il gate di licenza e'
 * un choke-point (0001) e non si leggono dati di un plant fuori licenza per classificare un
 * ciclo — un ciclo salvato di un plant NON piu' licenziato non ha piu' una testata da cui
 * risolvere il plant, quindi esce `NO_HEADER` come un orfano vero. I due casi non sono
 * distinguibili senza leggere fuori licenza: e' il testo di `logRoutingNoHeader` a nominarli
 * entrambi, e la voce elenca le chiavi.
 *
 * [ROUTING-ORPHAN] RESTITUISCE ANCHE `headersOk`, ed e' il flag da cui dipende una voce del recap.
 * Se la lettura delle testate fallisce, `plantByRouting` resta VUOTA e ogni ciclo salvato appare
 * orfano: senza questo flag il recap direbbe «N cicli non esistono piu' in SAP», cioe'
 * indicherebbe come da ripulire l'intero archivio dei cicli, mentre la verita' e' «non l'ho
 * potuto sapere». Vuoto non e' ignoto. Lo stesso vale per l'insieme di plant vuoto: non si e'
 * letto niente, quindi non si dichiara niente.
 *
 * @param {object} s4r sorgente dell'area cicli (`srv/lib/routingSource.js`)
 * @param {Set<string>|Array<string>} activePlants plant attivi e licenziati
 * @param {object} [summary] collettore del riepilogo (srv/lib/jobSummary.js)
 * @returns {Promise<{plantByRouting: Map<string,string>, materialByRouting: Map<string,string>,
 *          headerByRouting: Map<string,object>, headersOk: boolean}>}
 */
async function resolveRoutingContext(s4r, activePlants, summary = null) {
  const plants = [...(activePlants || [])]
    .map((p) => String(p ?? '').trim()).filter(Boolean);
  if (plants.length === 0) {
    // Non si e' letto niente: `headersOk: false` per la stessa ragione di una lettura fallita.
    return {
      plantByRouting: new Map(), materialByRouting: new Map(),
      headerByRouting: new Map(), headersOk: false
    };
  }

  const { ProductionRoutingHeader, ProductionRoutingMatlAssgmt } = s4r.entities;
  let headers = [];
  let matlRows = [];
  let headersOk = true;

  // Le colonne sono le SEI che servono al job, non le dodici della lista: `$select` esplicito
  // (DEC-34) e nessun campo letto per abitudine. `IsMarkedForDeletion` c'e' perche' e' il join a
  // guardarlo — un ciclo cancellato in SAP non deve risolvere un plant.
  try {
    headers = await s4r.run(
      SELECT.from(ProductionRoutingHeader)
        .columns('ProductionRoutingGroup', 'ProductionRouting', 'Plant',
          'BillOfOperationsStatus', 'BillOfOperationsUsage', 'IsMarkedForDeletion')
        .where({ Plant: { in: plants } })
        .limit(ROUTING_READ_LIMIT)
    );
  } catch (error) {
    console.error(`>>> [SYNC-ROUTING] ERRORE lettura ProductionRoutingHeader: ${error.message}`);
    // PERCORSO DI FALLIMENTO TOTALE SILENZIOSO: senza gli header nessun ciclo risolve il plant,
    // quindi OGNI ciclo finisce fra i non inviati e il job logga "0 da inviare" ed esce 0.
    // Senza questa riga il recap direbbe "tutto ok, niente da fare".
    // [ROUTING-ORPHAN] E da qui in poi ogni ciclo appare ORFANO senza esserlo: e' la voce qui
    // sotto a dire la cosa giusta, e `headersOk` a impedire che ne esca una seconda che mente.
    headersOk = false;
    if (summary) {
      summary.scope({
        objectKey: 'ProductionRoutingHeader',
        status: 'E',
        segments: [logMsg.seg('logRoutingHeaderReadFailed'), logMsg.technical(error.message)]
      });
    }
  }

  // La spina del join. Non si legge `ValidityEndDate`: le assegnazioni scadute si CONTANO nella
  // lista (`assegnazioniScadute`), ma qui il materiale di MAPL serve al solo ripiego delle righe
  // pre-0015, che non vengono inviate comunque — pagare il campo per un contatore che nessuno
  // guarderebbe non si giustifica su una lettura notturna.
  try {
    matlRows = await s4r.run(
      SELECT.from(ProductionRoutingMatlAssgmt)
        .columns('ProductionRoutingGroup', 'ProductionRouting', 'Product', 'Plant')
        .where({ Plant: { in: plants } })
        .limit(ROUTING_READ_LIMIT)
    );
  } catch (error) {
    console.error(`>>> [SYNC-ROUTING] ERRORE lettura ProductionRoutingMatlAssgmt: ${error.message}`);
    // Non fatale: i cicli attribuiti hanno il proprio materiale e partono comunque. Restano
    // fermi i soli cicli non ancora attribuiti dal backfill.
    if (summary) {
      summary.scope({
        objectKey: 'ProductionRoutingMatlAssgmt',
        status: 'E',
        segments: [logMsg.seg('logRoutingMatlReadFailed'), logMsg.technical(error.message)]
      });
    }
  }

  // ================================================================
  // IL TRONCAMENTO SI DICHIARA NEL RECAP, non solo a log come nella lista: del notturno nessuno
  // guarda `cf logs`, e un perimetro tagliato al tetto farebbe uscire cicli VERI fra i «non
  // risolti» — cioe' la voce direbbe di andare a ripulire cicli che esistono benissimo.
  // `scope()` e non `record()`: non e' un oggetto trattato (DEC-39), ma il run chiude in
  // attenzione perche' l'elenco del lavoro e' incompleto.
  // ================================================================
  if (summary) {
    for (const [label, rows] of [['ProductionRoutingHeader', headers],
      ['ProductionRoutingMatlAssgmt', matlRows]]) {
      if ((rows || []).length < ROUTING_READ_LIMIT) continue;
      const msg = `lettura ${label} TRONCATA al tetto di ${ROUTING_READ_LIMIT} righe: il`
        + ' perimetro dei cicli e\' incompleto e alcuni cicli salvati risulteranno senza testata'
        + ' senza esserlo';
      console.warn(`>>> [ROUTING-PLANT] ${msg}`);
      summary.scope({
        objectKey: label, status: 'W', degrade: true,
        segments: [logMsg.verbatim(msg)]   // prosa del job, non ancora a segmenti: dichiarata
      });
    }
  }

  // ================================================================
  // Il join della lista cicli, invariato: spina MAPL, arricchimento dalla testata, unione delle
  // testate senza assegnazione. `plantsInScope` VALORIZZATO e non `null`: il gate e' stretto su
  // `MAPL-WERKS` E `PLKO-WERKS` (0015 RB-07) e questo e' un choke-point di licenza, dove la
  // scelta larga non e' difendibile. Non e' ridondante col `$filter` spinto qui sopra: se la
  // sorgente lo ignorasse, il gate deve valere comunque.
  // `keepUnassigned: true` perche' un ciclo senza assegnazioni deve comunque risolvere il proprio
  // plant: il suo verdetto e' `NO_MATERIAL`, che ha una voce sua, non «non esiste piu' in SAP».
  // `today: null`: nessun conteggio degli scaduti, vedi il commento sulle colonne di MAPL.
  // ================================================================
  const { rows, stats } = routingMaterialRules.joinRoutingRows({
    matlRows, headers, plantsInScope: plants, keepUnassigned: true, today: null
  });
  // Riga gemella di quella della lista cicli, cosi' le due si confrontano a occhio: quando il job
  // non invia e la lista mostra, la differenza sta in questi numeri.
  console.log('>>> [ROUTING-PLANT] join: ' + JSON.stringify(stats)
    + ` | plant ammessi=[${plants.join(', ')}]`);

  const { plantByRouting, headerByRouting, materialByRouting } =
    skipRules.indexJoinedRoutings(rows, key);
  return { plantByRouting, materialByRouting, headerByRouting, headersOk };
}

// ================================================================
// Logica delta
// ================================================================

/**
 * Decide se un ciclo va (re)inviato confrontando la data di salvataggio con
 * l'ultima data di invio riuscito.
 * @param {string} saveTs - ISO UTC 'YYYY-MM-DDTHH:MM:SS'
 * @param {{SentDate: string, SentTime: string, Status: string}|undefined} hdr
 * @returns {boolean}
 */
function needsSend(saveTs, hdr) {
  if (!hdr) return true;                                     // mai inviato
  if (hdr.Status !== 'S' && hdr.Status !== 'W') return true; // ultimo invio fallito
  if (!hdr.SentDate) return true;                            // riga senza data invio
  const sentTs = `${hdr.SentDate}T${hdr.SentTime || '00:00:00'}`; // UTC (SentTime uniformato UTC)
  // Reinvia se il ciclo è stato salvato DOPO l'ultimo invio.
  return String(saveTs) > String(sentTs);
}

// ================================================================
// Entry point
// ================================================================

/**
 * @param {object} [summary] collettore del riepilogo di fine job (srv/lib/jobSummary.js).
 *   Opzionale: se assente il job si comporta come prima.
 */
async function run(summary) {
  console.log(`>>> [JOB SyncRoutings] avvio (profilo: ${cds.env.profiles?.join(',') || 'default'})`);

  const db = await cds.connect.to('db');
  const routingSrv = await cds.connect.to(ROUTING_SERVICE); // servizio CAP locale, invariato
  const s4r = await routingSource();                        // [IS-SOURCE]
  // Il canale usato dall'esecuzione entra nel recap come nota (FR-06 punto 3).
  if (summary) summary.note([logMsg.seg('logRoutingSource', s4r.mode, s4r.originDetail)]);

  const activePlants = await resolveActivePlants(db);
  if (activePlants.size === 0) {
    console.log('>>> [JOB SyncRoutings] nessun plant attivo: niente da fare.');
    if (summary) summary.noScope({ active: 0, usable: 0 });
    return { failed: 0 };
  }

  // [PLEX-OP-TYPE] Dichiara i plant che non hanno mappato il campo `type` della part-operation.
  //
  // Serve perche' senza quella riga il ciclo NON PARTE affatto: `type` e' obbligatorio nel
  // contratto Plex e viene risolto per nome contro una tabella di setup del tenant, quindi ogni
  // POST risponde `400 FIELD_REFERENCE_NOT_FOUND` — e con le operazioni cadono anche distinta e
  // centri di lavoro, che dipendono dai loro id. Senza questa voce il recap direbbe solo «N cicli
  // falliti» e nessuno saprebbe che la causa e' una riga di customizing.
  //
  // `scope()` con `degrade: true` e non `record()`: non e' un oggetto trattato, e una
  // configurazione mancante di plant non deve alimentare l'exit code come se fossero cicli
  // falliti (DEC-39). Ma il run chiude in attenzione. Una riga per plant, non per ciclo.
  //
  // Lettura fallita => nessuna dichiarazione: non si trasforma un problema locale in un allarme
  // di configurazione. Stesso stampo di declareMissingTypeCodes in syncMaterialsToPlex.js.
  if (summary) {
    try {
      const typeRows = await db.run(
        SELECT.from('avvaleplm.marsplm.sap2plex.ZPlexOpFieldMap')
          .columns('Plant').where({ PlexField: 'type' })
      );
      const mapped = new Set((typeRows || []).map(r => r.Plant));
      for (const plant of activePlants) {
        if (mapped.has(plant)) continue;
        const msg = `plant ${plant}: il campo «type» della part-operation non e' mappato — le`
          + ' operazioni partono con il valore storico «Production», che un tenant Plex senza un'
          + ' tipo con quel nome rifiuta (400 FIELD_REFERENCE_NOT_FOUND), e con esse non nascono'
          + ' distinta e centri di lavoro (scheda «Mapping campi operazione»)';
        console.warn(`>>> [PLEX-OP-TYPE] ${msg}`);
        summary.scope({
          plant, objectKey: 'ZPlexOpFieldMap', status: 'W', degrade: true,
          segments: [logMsg.verbatim(msg)]   // prosa del job, non ancora a segmenti: dichiarata
        });
      }
    } catch (e) {
      console.warn(`>>> [PLEX-OP-TYPE] verifica del mapping «type» fallita: ${e.message}`);
    }
  }

  // ================================================================
  // [ROUTING-COMP-SOURCE] La seconda lettura della distinta, dichiarata UNA VOLTA per esecuzione.
  //
  // Serve a rendere visibile una differenza che sul singolo ciclo non si vede: sul canale storico
  // la data di riferimento NON e' esprimibile — le posizioni di distinta si leggono per chiave di
  // distinta e il parametro non esiste — quindi la data non viene inviata affatto, e cio' che
  // torna non e' la distinta a quella data. Senza questa riga, un plant configurato correttamente
  // e un canale che ignora la data producono lo stesso recap, e qualcuno concluderebbe che le
  // modifiche tecniche non introducono nulla.
  //
  // `scope()` e non `record()`: non e' un oggetto trattato (DEC-39). `degrade: true` perche' e' una
  // lacuna d'esercizio e non un'informazione — cio' che il cliente si aspetta di vedere in Plex non
  // ci arrivera'. Una riga per plant, non per ciclo.
  // ================================================================
  if (summary) {
    try {
      const bomSource = require('../lib/bomSource');
      const dateRows = await db.run(
        SELECT.from('avvaleplm.marsplm.sap2plex.ZPhantomExplodeConfig')
          .columns('Plant', 'RoutingBomKeyDate')
      );
      const configured = (dateRows || []).filter((r) =>
        activePlants.has(r.Plant) && String(r.RoutingBomKeyDate || '').trim());
      if (configured.length) {
        const bom = await bomSource();
        const label = configured.map((r) => `${r.Plant} -> ${String(r.RoutingBomKeyDate).slice(0, 10)}`).join(', ');
        console.log(`>>> [ROUTING-COMP-SOURCE] seconda lettura della distinta attiva: ${label}`
          + ` | canale distinta ${bom.mode}`);
        if (bom.mode !== 'IS') {
          for (const r of configured) {
            const msg = `plant ${r.Plant}: la data di riferimento della distinta`
              + ` (${String(r.RoutingBomKeyDate).slice(0, 10)}) NON e' esprimibile sul canale`
              + ` distinta attivo (${bom.mode}), dove le posizioni si leggono per chiave di`
              + ' distinta e il parametro non esiste: la data non viene inviata, quindi cio\' che'
              + ' la seconda lettura restituisce non e\' la distinta a quella data e i componenti'
              + ' che entrano piu\' avanti potrebbero non arrivare su Plex';
            console.warn(`>>> [ROUTING-COMP-SOURCE] ${msg}`);
            summary.scope({
              plant: r.Plant, objectKey: 'ZPhantomExplodeConfig', status: 'W',
              segments: [logMsg.verbatim(msg)], degrade: true
            });
          }
        }
      }
    } catch (e) {
      // Lettura fallita => nessuna dichiarazione: non si trasforma un problema locale in un
      // allarme di configurazione. Stesso stampo del blocco [PLEX-OP-TYPE] qui sopra.
      console.warn(`>>> [ROUTING-COMP-SOURCE] verifica della data di riferimento fallita: ${e.message}`);
    }
  }

  // Flag di customizing per-plant: eseguire l'auto-assign dei componenti all'invio?
  const plantFlagRows = await db.run(
    SELECT.from('avvaleplm.marsplm.sap2plex.ZPlant').columns('PlantCode', 'AutoAssignBomOnSync')
  );
  const autoAssignByPlant = new Map(plantFlagRows.map(p => [p.PlantCode, p.AutoAssignBomOnSync === true]));

  // 1) cicli salvati + data di salvataggio (MAX modifiedAt)
  const cycles = await enumerateSavedCycles(db);
  console.log(`>>> [SYNC-ROUTING] Cicli-materiale salvati localmente: ${cycles.size}`);
  if (cycles.size === 0) {
    if (summary) summary.note([logMsg.seg('logRoutingNoneSaved')]);
    return { failed: 0 };
  }

  // 2) ultimo invio per (ciclo, MATERIALE) — [ROUTING-BY-MATERIAL]: con la chiave di prima il
  //    delta di un materiale veniva deciso sull'ultimo invio di un altro.
  const hdrRows = await db.run(
    SELECT.from(E_LOG_HDR).columns(
      'ProductionRoutingGroup', 'ProductionRouting', 'Material', 'SentDate', 'SentTime', 'Status')
  );
  const hdrMap = new Map(hdrRows.map(h =>
    [mkey(h.ProductionRoutingGroup, h.ProductionRouting, String(h.Material ?? '').trim()), h]));

  // 3) Plant, testata e materiale di ripiego dei cicli in perimetro.
  // [ROUTING-PLANT] Il criterio sono i PLANT, non i gruppi dei cicli salvati: vedi il blocco in
  // testa a `resolveRoutingContext`. `activePlants` e' noto da prima di qualunque lettura SAP.
  const { plantByRouting, materialByRouting, headerByRouting, headersOk } =
    await resolveRoutingContext(s4r, activePlants, summary);

  // ================================================================
  // [ROUTING-SCOPE] Il perimetro dei cicli, letto UNA VOLTA per esecuzione.
  // Le regole sono per plant e la valutazione e' pura, quindi non serve una lettura per ciclo.
  // Come per il canale, tutte le decisioni di un'esecuzione devono essere spiegabili con UNA
  // configurazione: leggerla una volta e' anche la garanzia che non cambi a meta' run.
  // ================================================================
  const scopeRules = await routingVisibility.loadRoutingFilterConfig(db);
  const scopeActive = [...scopeRules.values()].some((r) => r && r.length);
  if (scopeActive) {
    console.log(`>>> [ROUTING-SCOPE] perimetro cicli in vigore -> ${routingVisibility.describeRules(scopeRules)}`);
  }

  // 4) filtro: plant attivo + perimetro cicli + materiale + delta
  //
  // [ROUTING-ORPHAN] IL VERDETTO SU UN CICLO SI PRENDE IN UN PUNTO SOLO, E STA IN UN MODULO PURO.
  // Prima le cause erano sparse fra qui e il ciclo di invio, e due di esse — «la testata SAP non
  // si risolve» e «il plant non e' licenziato» — condividevano lo stesso contatore muto.
  const candidates = [];
  // [ROUTING-BOM-DRIFT] I cicli che il delta scarta e che vanno confrontati con Plex.
  const toVerify = [];
  let skippedInactive = 0;
  let skippedNotDelta = 0;
  let skippedOutOfScope = 0;
  let skippedNoHeader = 0;
  let skippedNoMaterial = 0;
  let skippedNotAttributed = 0;
  const outOfScopeSeen = [];
  const noHeaderSeen = [];
  for (const c of cycles.values()) {
    const kr = key(c.ProductionRoutingGroup, c.ProductionRouting);
    const plant = plantByRouting.get(kr);
    const { verdict, material } = skipRules.classifySavedCycle({
      plant,
      activePlants,
      headerMaterial: c.HeaderMaterial,
      fallbackMaterial: materialByRouting.get(kr)
    });

    // La testata SAP non si risolve: il ciclo e' orfano e non partira' mai piu'. Si RACCOGLIE la
    // chiave, perche' la voce del recap deve nominarlo — un numero non basta per andarlo a togliere.
    if (verdict === skipRules.VERDICT.NO_HEADER) {
      skippedNoHeader++;
      if (noHeaderSeen.length < 20) noHeaderSeen.push(kr);
      continue;
    }
    // Il gate di licenza: normale, resta un contatore.
    if (verdict === skipRules.VERDICT.INACTIVE) { skippedInactive++; continue; }

    // [ROUTING-SCOPE] Un ciclo fuori dalle regole del suo plant non esiste per noi: non si invia,
    // e il suo ciclo Plex salvato resta dov'e'. La regola «testata mancante = fuori perimetro» non
    // ha piu' un caso: le due mappe si popolano insieme, quindi con un plant valorizzato la testata
    // c'e' per costruzione, e la testata assente esce prima come NO_HEADER — dove ha una voce che
    // la nomina invece di sparire fra i fuori perimetro. Il `|| {}` resta come rete.
    // STA PRIMA delle due voci sul materiale: dichiarare «manca il materiale» su un ciclo che il
    // perimetro esclude comunque manderebbe a sistemare una cosa che non serve.
    const hdr = headerByRouting.get(kr);
    if (!routingVisibility.routingPasses(hdr || {}, scopeRules.get(plant) || [])) {
      skippedOutOfScope++;
      if (outOfScopeSeen.length < 20) {
        outOfScopeSeen.push(`${kr} (${routingVisibility.describeRow(hdr || {})})`);
      }
      continue;
    }

    // ================================================================
    // [ROUTING-ORPHAN] Le due voci sul materiale, ora QUI e non piu' nel ciclo di invio.
    //
    // Sono `record()` e non contatori: il plant E' noto e sono difetti su cui una persona deve
    // agire, non statistiche. E non passano dal delta — un log di invio per queste due non esiste
    // e non puo' esistere (l'action rifiuta prima di scrivere), quindi il delta le lascerebbe
    // passare sempre: farle uscire di qui e' solo piu' onesto, e le sottrae al tetto per run.
    // ================================================================
    if (verdict === skipRules.VERDICT.NOT_ATTRIBUTED) {
      // Righe pre-0015 a `HeaderMaterial` vuoto. Il ripiego MAPL proporrebbe un materiale che
      // NON e' quello sotto cui le righe sono salvate, e l'action cerca l'albero per materiale:
      // partiva una chiamata che falliva sempre, senza lasciare log — quindi ritentata a ogni
      // esecuzione, per sempre, con un `400` che non nomina la causa. Il rimedio e' il backfill.
      skippedNotAttributed++;
      console.warn(`>>> [ROUTING-ORPHAN] ${kr}: righe di ciclo senza materiale di testata,`
        + ' non inviate (eseguire srv/lib/routingMaterialBackfill.js --apply)');
      if (summary) {
        summary.record({
          plant, objectType: 'ROUTING', objectKey: kr, status: 'W',
          segments: [logMsg.seg('logRoutingNotAttributed')],
          logRef: `ZRoutingExcLogPOS/${c.ProductionRoutingGroup}/${c.ProductionRouting}`
        });
      }
      continue;
    }
    if (verdict === skipRules.VERDICT.NO_MATERIAL) {
      skippedNoMaterial++;
      console.warn(`>>> [WARN] ${kr}: nessun materiale associato al routing, salto`);
      // Riga POS (non un semplice contatore): il plant È noto e questo è un difetto di
      // configurazione su cui un utente deve agire, non una statistica.
      if (summary) {
        summary.record({
          plant, objectType: 'ROUTING', objectKey: kr, status: 'W',
          segments: [logMsg.seg('logRoutingNoMaterial')],
          logRef: `ZRoutingExcLogPOS/${c.ProductionRoutingGroup}/${c.ProductionRouting}`
        });
      }
      continue;
    }

    const km = mkey(c.ProductionRoutingGroup, c.ProductionRouting, material);
    if (!needsSend(c.SaveTs, hdrMap.get(km))) {
      // ================================================================
      // [ROUTING-BOM-DRIFT] IL DELTA NON E' PIU' L'ULTIMA PAROLA (feature 0047).
      //
      // Il delta guarda la data dell'ultimo SALVATAGGIO LOCALE, quindi non vede niente di cio' che
      // cambia in SAP — un componente aggiunto, tolto, spostato, la sua quantita' — ne' un cambio
      // nelle regole dei gruppi oggetto. Quei cicli finivano qui, in un contatore, e il run
      // chiudeva verde con la distinta di ieri su Plex.
      //
      // Ora vanno al CONFRONTO, che e' l'action stessa con `SendOnlyIfDrift`: legge la distinta su
      // Plex e invia solo se non combacia. Il perimetro sono i plant con l'auto-assegnazione
      // accesa, e non e' una scorciatoia: e' l'unico caso in cui esiste un termine di paragone
      // «ciclo SAP» — con il flag spento l'elenco dei componenti lo decide una persona salvando, e
      // il suo salvataggio il delta lo vede gia'.
      // ================================================================
      const verifyThis = VERIFY_ENABLED && autoAssignByPlant.get(plant) === true;
      if (verifyThis) toVerify.push({ ...c, Material: material });
      else skippedNotDelta++;
      continue;
    }
    candidates.push({ ...c, Material: material });
  }
  console.log(`>>> [SYNC-ROUTING] Delta: ${candidates.length} cicli-materiale da inviare, ${skippedNotDelta} non modificati,`
    + ` ${toVerify.length} da confrontare con Plex,`
    + ` ${skippedInactive} plant non attivo, ${skippedNoHeader} senza testata SAP,`
    + ` ${skippedOutOfScope} fuori perimetro, ${skippedNotAttributed} senza materiale di testata,`
    + ` ${skippedNoMaterial} senza materiale`);
  // Il conteggio dei saltati. Tre dei quattro non sono anomalie: cicli non modificati, fuori dai
  // plant attivi, fuori perimetro.
  // [ROUTING-ORPHAN] Il quarto, `skippedNoHeader`, LO E' — ma non e' piu' muto: ha la sua voce
  // qui sotto, e il contatore resta perche' un ciclo orfano e' comunque un ciclo non trattato.
  // I due che hanno gia' una riga `record()` — non attribuiti e senza materiale — non entrano,
  // o sarebbero contati due volte.
  // [ROUTING-BOM-DRIFT] E il conteggio si emette ORA IN CODA, dopo il confronto: un ciclo che il
  // delta scarta puo' finire fra i TRATTATI (se non combacia si invia), e sommarlo qui lo conterebbe
  // due volte — una fra i saltati e una nella sua riga di recap.

  // ================================================================
  // [ROUTING-ORPHAN] I CICLI SENZA TESTATA SAP SI DICHIARANO, E SI NOMINANO.
  //
  // Ognuno di questi e' un ciclo che una persona ha costruito e che non partira' MAI PIU': la
  // routing in SAP non c'e' piu', quindi non c'e' nemmeno un delta che possa ripescarlo. Finiva
  // in `skippedInactive`, cioe' nello stesso numero dei plant non licenziati — che sono la
  // normalita' — e nessuno poteva accorgersene.
  //
  // `scope()` e non `record()`: non e' un oggetto TRATTATO e non deve alimentare l'exit code
  // (DEC-39). `degrade: false` per una ragione verificata e non per prudenza: `saveRoutingPlexCycle`
  // passa da `rejectIfRoutingNotUsable`, che senza testata SAP rifiuta con `routingNotFound` —
  // quindi un ciclo orfano NON e' ripulibile dal cockpit. Un'attenzione che si ripete ogni notte
  // senza un rimedio in applicazione insegna solo a ignorare l'attenzione. La voce li NOMINA:
  // e' quello che serve per andare a toglierli.
  //
  // La guardia `declaresOrphans` e' la parte che rompe in silenzio: vedi il suo commento.
  // ================================================================
  if (summary && skipRules.declaresOrphans({ headersOk, count: skippedNoHeader })) {
    summary.scope({
      // L'oggetto e' la TABELLA LOCALE da ripulire, non la lettura che non li ha trovati: la voce
      // di lettura fallita qui sopra usa gia' `ProductionRoutingHeader`, e due righe con la stessa
      // chiave nel recap si distinguerebbero solo dal testo.
      objectKey: 'ZPlexRoutingCycleOperation',
      status: 'W',
      degrade: false,
      segments: [logMsg.seg(
        'logRoutingNoHeader', skippedNoHeader, noHeaderSeen.slice(0, 5).join(', ')
      )]
    });
  }
  // ================================================================
  // [ROUTING-SCOPE] I cicli fuori perimetro meritano una VOCE, non un contatore muto: il job itera
  // i cicli SALVATI, quindi ognuno di questi e' qualcosa che una persona ha costruito e che non
  // verra' mai inviato finche' la configurazione resta questa.
  //
  // Passa da `scope()` e non da `record()`: `record()` e' per gli oggetti TRATTATI e alimenta
  // l'exit code, mentre questi sono stati esclusi da una configurazione che sta funzionando.
  // `degrade: false` perche' e' informativa: un'esecuzione riuscita non deve tingersi di
  // attenzione perche' il perimetro ha fatto il suo lavoro.
  // ================================================================
  if (summary && skippedOutOfScope > 0) {
    summary.scope({
      objectKey: 'ZRoutingFilterConfig',
      status: 'W',
      degrade: false,
      segments: [logMsg.seg(
        'logRoutingOutOfScope', skippedOutOfScope, outOfScopeSeen.slice(0, 5).join(', ')
      )]
    });
  }

  let toSend = candidates;
  if (MAX_ROUTINGS_PER_RUN > 0 && toSend.length > MAX_ROUTINGS_PER_RUN) {
    console.log(`>>> [SYNC-ROUTING] Limite per run: elaboro ${MAX_ROUTINGS_PER_RUN} di ${toSend.length} cicli (i restanti al prossimo run)`);
    if (summary) {
      summary.note([logMsg.seg('logRoutingDeferred', toSend.length - MAX_ROUTINGS_PER_RUN)]);
    }
    toSend = toSend.slice(0, MAX_ROUTINGS_PER_RUN);
  }

  // 5) invio via action CAP esistente (invio + componenti + customizing + log)
  let sent = 0;
  let warned = 0;
  let failed = 0;

  // [ROUTING-BOM-DRIFT] I numeri del confronto, PER PLANT e non per ciclo: una voce di recap per
  // plant con tre numeri e' la forma di [PART-ALIVE] (DEC-112), e per la stessa ragione — «0
  // reinviati» e «non ho confrontato niente» devono essere due righe diverse.
  const verifyByPlant = new Map();

  // [ROUTING-DEFAULT-OP] Da dove sono venuti i componenti, PER PLANT (feature 0051). Stessa forma
  // della mappa qui sopra e per la stessa ragione: un run tratta cicli di piu' plant, e
  // l'allocazione dichiarata e' un'impostazione del plant della routing. Una voce sola per il run
  // direbbe una cosa falsa su tutti i plant tranne uno.
  const compSourceByPlant = new Map();
  const verifyStats = (plant) => {
    const p = plant || '';
    if (!verifyByPlant.has(p)) {
      verifyByPlant.set(p, {
        checked: 0,    // cicli per cui il confronto ha girato
        aligned: 0,    // ...e combaciava: niente inviato
        resent: 0,     // ...e non combaciava: reinviato
        unknown: 0,    // ...e non si e' potuto concludere (lettura Plex o SAP incompleta)
        extra: 0,      // cicli con righe di troppo sulla distinta Plex
        extraSeen: []
      });
    }
    return verifyByPlant.get(p);
  };

  // ================================================================
  // [ROUTING-BOM-DRIFT] L'INVIO DI UN CICLO STA IN UNA FUNZIONE, E NON E' UN ABBELLIMENTO.
  //
  // I due giri — i candidati del delta e i cicli da confrontare — devono classificare l'esito
  // ESATTAMENTE allo stesso modo: sono gli stessi otto rami (bloccato, sei degradazioni, riuscito),
  // e due copie diverge­rebbero al primo ramo aggiunto. L'unica differenza fra i due e' il flag
  // `SendOnlyIfDrift`, che qui e' un parametro.
  //
  // @param {object} c        il ciclo-materiale
  // @param {boolean} verify  giro di confronto: l'action invia solo se non combacia
  // @returns {'sent'|'warned'|'failed'|'noop'}
  // ================================================================
  const sendOne = async (c, verify = false) => {
    const kr = key(c.ProductionRoutingGroup, c.ProductionRouting);
    // [ROUTING-BY-MATERIAL] Il materiale e' quello del ciclo salvato, risolto al passo 4.
    // [ROUTING-ORPHAN] E qui e' sempre valorizzato: i cicli senza materiale non arrivano piu' fin
    // qui, sono dichiarati al passo 4 insieme a tutte le altre ragioni di non invio.
    const Material = c.Material;
    // La chiave che finisce nel recap e nei log: identifica il ciclo DI QUEL materiale.
    const k = `${kr}|${Material}`;
    // Auto-assign attivo solo se il plant del routing ha il flag di customizing a true
    // (e non è stato disattivato globalmente via env kill-switch).
    const plant = plantByRouting.get(kr);
    const doAutoAssign = !AUTO_ASSIGN_DISABLED_GLOBALLY && (autoAssignByPlant.get(plant) === true);
    try {
      const result = await routingSrv.send('syncRoutingPlexCycle', {
        ProductionRoutingGroup: c.ProductionRoutingGroup,
        ProductionRouting: c.ProductionRouting,
        Material,
        AutoAssignMissing: doAutoAssign,
        SendOnlyIfDrift: verify
      });
      // [LOG-MSG-I18N] Il wrapper prende SEGMENTI (feature 0031).
      const rec = (status, segments) => {
        if (!summary) return;
        summary.record({
          plant, objectType: 'ROUTING', objectKey: k, objectKey2: Material,
          status, segments,
          logRef: `ZRoutingExcLogPOS/${c.ProductionRoutingGroup}/${c.ProductionRouting}/${Material}`
        });
      };
      // ================================================================
      // [ROUTING-COMP-SOURCE] IL CICLO BLOCCATO (feature 0025).
      //
      // Va guardato PRIMA di tutto il resto, e non e' una delle degradazioni qui sotto: quelle
      // dicono «il ciclo e' arrivato su Plex, ma con un difetto», questa dice che verso Plex non
      // e' partita NESSUNA chiamata perche' almeno un componente non ha trovato un'operazione.
      // Su Plex e' rimasto esattamente quello che c'era.
      //
      // SI CONTA FRA I FALLITI, e le due ragioni valgono insieme. La prima: e' un difetto di
      // configurazione su cui una persona deve agire — la scheda dei gruppi oggetto o quella
      // dell'auto-assegnazione — e l'exit code dato allo scheduler deve dirlo. La seconda:
      // l'azione ha scritto il log con stato di errore, quindi `needsSend()` ripeschera' questo
      // ciclo al prossimo run e appena la regola mancante viene configurata il ciclo parte da
      // se'. Contarlo fra le attenzioni lo renderebbe indistinguibile da un invio riuscito a
      // meta', che invece nessuno ripeschera' piu'.
      // ================================================================
      // ================================================================
      // [ROUTING-BOM-DRIFT] IL CICLO CHE COMBACIA (feature 0047).
      //
      // Va guardato per PRIMO, e non e' un esito fra gli altri: nessuna chiamata di scrittura e'
      // partita, l'action non ha scritto una riga di storico, e su Plex c'e' esattamente quello che
      // il ciclo SAP dice. Non e' un invio e non e' un fallimento: e' il caso NORMALE del giro di
      // confronto, e finisce nei tre numeri della voce di plant.
      //
      // NESSUNA RIGA DI RECAP PER CICLO: con qualche centinaio di cicli allineati per notte il
      // recap — che finisce in PDF e in mail — sarebbe illeggibile, e la riga che conta davvero si
      // perderebbe fra le altre. E' la stessa ragione per cui la voce di plant esiste (DEC-39:
      // `record()` e' per gli oggetti TRATTATI).
      // ================================================================
      if (verify && result && result.NoOp === true) {
        const st = verifyStats(plant);
        st.checked++;
        // `SecondReadFailed` qui non e' una degradazione dell'invio — non c'e' stato un invio — ma
        // dice che il confronto ha girato su un elenco SAP incompleto: «combacia» detto su meta'
        // dei componenti non e' un verdetto, quindi non si conta fra gli allineati.
        if (result.BomRemoteKnown !== true || result.SecondReadFailed === true) st.unknown++;
        else st.aligned++;
        if (Number(result.BomExtra) > 0) {
          st.extra++;
          if (st.extraSeen.length < 5) st.extraSeen.push(k);
        }
        console.log(`>>> [ROUTING-BOM-DRIFT] ${k}: ${result.VerifyReason || 'ALIGNED'}`
          + ` — niente da inviare${Number(result.BomExtra) > 0 ? ` (${result.BomExtra} righe in eccesso su Plex)` : ''}`);
        return 'noop';
      }

      if (result && result.Blocked === true) {
        failed++;
        // I segmenti vengono dall'action: sono la stessa verita' che ha scritto lo storico invii.
        const segs = logMsg.unpack(result.messageJson);
        const out = segs.length ? segs : [logMsg.seg('logRoutingBlockedGeneric')];
        console.error(`>>> [ERRORE] ${k}: ${renderMsg(out)}`);
        rec('E', out);
        if (verify) verifyStats(plant).checked++;
        return 'failed';
      }

      // ================================================================
      // I MODI IN CUI IL CICLO È PARTITO MA NON È QUELLO CHE SAP DICE.
      //
      // Nessuno di essi è un errore dell'invio — contarlo come tale renderebbe il job rosso su
      // qualcosa che il sistema considera concluso — e nessuno di essi è un successo:
      // `needsSend()` non ripescherà più questo ciclo, quindi se non li si dichiara QUI non li
      // vede più nessuno.
      //
      // [W1-05] SI RACCOLGONO INVECE DI INCATENARSI IN `else if`, ed è il terzo che ha reso
      // necessario cambiare forma: con la catena il primo che parlava zittiva gli altri, e un
      // ciclo con due difetti ne dichiarava uno solo — quello sbagliato, per giunta, perché
      // l'ordine dei rami era casuale rispetto alla gravità.
      // ================================================================
      const degraded = [];
      const phantomUnresolved = (result && Number(result.PhantomUnresolved)) || 0;
      const bomQtyUnresolved = (result && Number(result.BomQtyUnresolved)) || 0;
      const autodepleteUnverified = (result && Number(result.AutodepleteUnverified)) || 0;
      if (phantomUnresolved) {
        // [PHANTOM-EXPLODE] Feature 0019.
        degraded.push(logMsg.seg('logRoutingPhantomUnresolved', phantomUnresolved));
      }
      if (bomQtyUnresolved) {
        // [W1-05] La riga BOM su Plex c'è ed è plausibile: il numero sbagliato non si vede da
        // nessuna parte se non lo si dice qui.
        degraded.push(logMsg.seg('logRoutingBomQtyUnresolved', bomQtyUnresolved));
      }
      if (autodepleteUnverified) {
        // [BOM-AUTODEPLETE] W1-06. La riga BOM su Plex c'è e sembra a posto: se «autoDeplete» è
        // attivo, Plex consuma i componenti da sé e i movimenti 261 della 0021 li consumano una
        // seconda volta. Il dettaglio per causa è in `ResponseJson.autodeplete.counts`.
        degraded.push(logMsg.seg('logRoutingAutodepleteUnverified', autodepleteUnverified));
      }
      // [ROUTING-DEFAULT-OP] Feature 0051. La sorgente si RACCOGLIE per plant qui, dove passano
      // tutti i cicli inviati: `compSourceByPlant` alimenta la voce di recap in coda al run. Il
      // ripiego degrada anche la riga del SINGOLO ciclo — il plant ha chiesto la distinta e ha
      // ricevuto l'assegnazione di SAP, cioè i componenti inviati non sono quelli che il
      // customizing prometteva, e sul ciclo è l'unico posto dove il fatto si posa.
      const compSourceMode = (result && result.CompSourceMode) || 'ALLOC';
      const compSourceFellBack = !!(result && result.CompSourceFellBack);
      if (compSourceMode === 'BOM' || compSourceFellBack) {
        // `plant` e' quello risolto per QUESTO ciclo da `plantByRouting` ([ROUTING-PLANT]): il
        // customizing e' del plant della routing, e un run ne tratta piu' d'uno.
        const cs = compSourceByPlant.get(plant || '') || { bom: 0, fellBack: 0 };
        if (compSourceFellBack) cs.fellBack++; else cs.bom++;
        compSourceByPlant.set(plant || '', cs);
      }
      if (compSourceFellBack) {
        degraded.push(logMsg.seg('logRoutingCompSourceFellBack'));
      }
      const wcExcessNotRemoved = (result && Number(result.WcExcessNotRemoved)) || 0;
      if (wcExcessNotRemoved) {
        // [WC-SUBTRACT] Il ciclo è partito, ma su Plex restano approvati work center che l'albero
        // non ha più — e uno di essi può essere lo stesso centro approvato anche sull'operazione
        // nuova, cioè la doppia approvazione che la BBP §7.6.2 vieta. È accertato: la GET degli
        // approved workcenter li ha visti. Il dettaglio per causa è in `ResponseJson.approvedWc`.
        degraded.push(logMsg.seg('logRoutingWcExcess', wcExcessNotRemoved));
      }
      if (result && result.SecondReadFailed === true) {
        // [ROUTING-COMP-SOURCE] Il ciclo e' su Plex, ma con i soli componenti agganciati alle
        // operazioni in SAP: quelli che la distinta alla data di riferimento avrebbe aggiunto non
        // ci sono. `needsSend()` non ripeschera' questo ciclo finche' non lo si salva di nuovo,
        // quindi e' questa l'unica occasione di dirlo.
        degraded.push(logMsg.seg('logRoutingSecondReadFailed'));
      }
      if (result && result.ClassificationStatus === 'KO') {
        // Feature 0018.
        degraded.push(logMsg.seg('logRoutingNoClassification'));
      }

      // I segmenti dell'action: la testa del messaggio («N operazioni aggiornate, …») e' sua.
      const sentSegs = logMsg.unpack(result && result.messageJson);
      // [ROUTING-BOM-DRIFT] L'invio c'e' stato, e nel giro di confronto e' un REINVIO: si conta
      // nella voce di plant accanto agli allineati, o «0 reinviati» e «non ho confrontato niente»
      // si leggerebbero uguali.
      if (verify) {
        const st = verifyStats(plant);
        st.checked++;
        st.resent++;
        if (Number(result && result.BomExtra) > 0) {
          st.extra++;
          if (st.extraSeen.length < 5) st.extraSeen.push(k);
        }
      }
      if (result && result.success && !degraded.length) {
        sent++;
        const out = sentSegs.length ? sentSegs : [logMsg.seg('logRoutingSentGeneric')];
        console.log(`>>> [OK] ${k} -> ${renderMsg(out)}`);
        rec('S', out);
        return 'sent';
      } else if (result && result.success) {
        warned++;
        // [LOG-MSG-I18N] Le degradazioni sono un segmento PER CAUSA, non una frase concatenata:
        // `pack` scarta segmenti interi dalla coda e dichiara quanti, quindi con sei difetti si
        // perde l'ultimo e non mezza parola. Vale la stessa forma di `tecoRecapEntries`.
        const out = [logMsg.seg('logRoutingSentWithIssues'), ...sentSegs, ...degraded];
        console.warn(`>>> [WARN] ${k}: ${renderMsg(out)}`);
        rec('W', out);
        return 'warned';
      } else {
        // CAMBIO DI COMPORTAMENTO (era failed++ -> exit 1): un success=false SENZA eccezione
        // è un invio PARZIALE. L'action ha già scritto ZRoutingExcLogHDR.Status='S'|'W' e
        // ritorna success solo se tutte le operazioni sono passate, quindi needsSend() non
        // ripescherà più questo ciclo: contarlo come errore renderebbe il job rosso per
        // sempre su qualcosa che il sistema considera concluso.
        warned++;
        const out = sentSegs.length ? sentSegs : [logMsg.seg('logRoutingPartial')];
        console.warn(`>>> [WARN] ${k}: ${renderMsg(out)}`);
        rec('W', out);
        return 'warned';
      }
    } catch (error) {
      // Questo è l'errore vero: l'action fa req.error(500,...), che lancia.
      failed++;
      console.error(`>>> [ERRORE] ${k}: ${error.message}`);
      if (summary) {
        summary.record({
          plant, objectType: 'ROUTING', objectKey: k, objectKey2: Material,
          status: 'E', segments: [logMsg.technical(error.message)],
          logRef: `ZRoutingExcLogPOS/${c.ProductionRoutingGroup}/${c.ProductionRouting}/${Material}`
        });
      }
      if (verify) verifyStats(plant).checked++;
      return 'failed';
    }
  };

  for (const c of toSend) await sendOne(c, false);

  // ================================================================
  // [ROUTING-BOM-DRIFT] 6) IL GIRO DI CONFRONTO (feature 0047).
  //
  // Sta DOPO l'invio dei candidati, e l'ordine e' voluto: cio' che una persona ha salvato oggi ha la
  // precedenza su una verifica di manutenzione, e se il tetto per run taglia qualcosa deve tagliare
  // qui. Ogni ciclo passa dalla STESSA `sendOne` dei candidati, con il solo flag in piu': l'action
  // guarda, e invia solo se non combacia.
  // ================================================================
  let verifyList = toVerify;
  let verifyDeferred = 0;
  if (VERIFY_MAX_PER_RUN > 0 && verifyList.length > VERIFY_MAX_PER_RUN) {
    verifyDeferred = verifyList.length - VERIFY_MAX_PER_RUN;
    console.log(`>>> [ROUTING-BOM-DRIFT] tetto per run: confronto ${VERIFY_MAX_PER_RUN} di`
      + ` ${verifyList.length} cicli (${verifyDeferred} al prossimo run)`);
    if (summary) summary.note([logMsg.seg('logRoutingVerifyDeferred', verifyDeferred)]);
    verifyList = verifyList.slice(0, VERIFY_MAX_PER_RUN);
  }
  let verifyNoOp = 0;
  if (verifyList.length) {
    console.log(`>>> [ROUTING-BOM-DRIFT] confronto con la distinta Plex: ${verifyList.length} cicli`);
    for (const c of verifyList) {
      const outcome = await sendOne(c, true);
      if (outcome === 'noop') verifyNoOp++;
    }
  }

  // ================================================================
  // [ROUTING-BOM-DRIFT] UNA VOCE PER PLANT, con i numeri del confronto.
  //
  // `scope()` e non `record()`: non e' un oggetto trattato e non deve alimentare l'exit code
  // (DEC-39). `degrade` solo su cio' che nessun reinvio sistemera' — i cicli non conclusi e quelli
  // con righe di troppo su Plex: un plant in cui tutto combacia non deve tingere di giallo un run
  // sano, e un giallo che si ripete ogni notte senza rimedio insegna a ignorare il giallo
  // ([ROUTING-ORPHAN]). Qui il rimedio esiste ma e' a mano, sul tenant: per questo la voce NOMINA
  // i cicli invece di contarli soltanto.
  // ================================================================
  // ================================================================
  // [ROUTING-DEFAULT-OP] UNA VOCE PER PLANT sulla sorgente dei componenti (feature 0051).
  //
  // Si emette PRIMA di quella del confronto: la testata del run ha due tetti che scartano la CODA
  // (`cut(…, 255)` e `pack()`), e «da dove vengono i componenti» spiega un esito, mentre i numeri
  // del confronto lo descrivono. Le note di verdetto stanno davanti ai contatori.
  //
  // `scope()` e non `record()`: non e' un oggetto trattato e non deve alimentare l'exit code
  // (DEC-39). `degrade` SOLO sul ripiego — un plant che legge dalla distinta come configurato sta
  // funzionando, e tingere di giallo un run sano insegna a ignorare il giallo. Il ripiego invece
  // e' un plant che ha chiesto una cosa e ne ha ottenuta un'altra: resta giallo finche' non si
  // risolve, e il rimedio c'e' (la scheda, o il ciclo senza operazioni).
  // ================================================================
  if (summary) {
    for (const [plant, cs] of compSourceByPlant) {
      if (!cs.bom && !cs.fellBack) continue;
      summary.scope({
        plant,
        objectKey: 'ZPhantomExplodeConfig',
        status: cs.fellBack ? 'W' : 'S',
        degrade: cs.fellBack > 0,
        segments: [logMsg.seg('logRoutingCompSourceSummary',
          plant || '(assente)', cs.bom, cs.fellBack)]
      });
    }
  }

  if (summary) {
    for (const [plant, st] of verifyByPlant) {
      if (!st.checked) continue;
      summary.scope({
        plant,
        objectKey: 'ZPlexRoutingCycleComponent',
        status: (st.unknown || st.extra) ? 'W' : 'S',
        degrade: (st.unknown > 0 || st.extra > 0),
        segments: [logMsg.seg('logRoutingVerifySummary',
          plant || '(assente)', st.checked, st.aligned, st.resent, st.unknown, st.extra,
          st.extraSeen.join(', ') || '-')]
      });
    }
  }

  // [ROUTING-BOM-DRIFT] Il conteggio dei saltati si emette ADESSO, quando si sa quali cicli il
  // confronto ha trattato: i reinviati hanno la loro riga di recap e non sono saltati, gli
  // allineati, i non conclusi e i differiti si'.
  const skippedTotal = skippedNotDelta + skippedInactive + skippedOutOfScope + skippedNoHeader
    + verifyNoOp + verifyDeferred;
  if (summary && skippedTotal > 0) summary.skip(skippedTotal);

  console.log(
    `>>> [JOB SyncRoutings] completato — inviati: ${sent}, warning: ${warned}, falliti: ${failed}, ` +
    `saltati(no material): ${skippedNoMaterial}, non attribuiti: ${skippedNotAttributed}, ` +
    `fuori perimetro: ${skippedOutOfScope}, non modificati: ${skippedNotDelta}, ` +
    // [ROUTING-BOM-DRIFT] I due numeri del confronto: quanti cicli sono stati guardati e quanti di
    // quelli non hanno richiesto niente. «Confrontati 0» e «tutti allineati» sono due run diversi.
    `confrontati con Plex: ${verifyList.length} (allineati: ${verifyNoOp}, differiti: ${verifyDeferred}), ` +
    // [ROUTING-ORPHAN] Le due cause separate: «plant non licenziato» e' la normalita', «senza
    // testata SAP» e' un ciclo costruito che non partira' mai piu'.
    `plant non attivo: ${skippedInactive}, senza testata SAP: ${skippedNoHeader} ` +
    `(su ${cycles.size} cicli per materiale)`
  );
  return { failed };
}

module.exports = { run, enumerateSavedCycles, resolveRoutingContext, needsSend };

// Bootstrap condiviso (srv/jobs/lib/runJob.js): carica e linka il modello, crea il riepilogo di
// esecuzione, garantisce che venga chiuso e che il recap parta anche in caso di errore fatale,
// e calcola l'exit code. serveAll: true perché ProductionRouting non è in cds.requires e va
// servito (senza listen HTTP) prima di poterne invocare l'action.
if (require.main === module) {
  const { runJob } = require('./lib/runJob');
  runJob({ jobCode: 'ROUTING_SYNC', serveAll: true, main: (summary) => run(summary) });
}

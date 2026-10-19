sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
    "sap/ui/core/Messaging",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    // [COLUMN-SORT] Menu di colonna delle due liste editabili. E' il GEMELLO OData di quello della
    // dashboard: la meccanica e' la stessa, il confronto lo fa il database. Vedi DEC-102.
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/ColumnMenu",
    // [AA-DUPLICATE] La coppia (Materiale, Gruppo) ripetuta si ferma PRIMA dell'invio: dentro un
    // change set di $batch i controlli di unicita' del server girano in parallelo e non si vedono
    // fra loro, quindi due righe uguali nello stesso Salva arrivavano al vincolo di HANA.
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/autoAssignDuplicates",
    // [ROW-COPY] Quali campi passano da una riga alla sua copia. La domanda e' una sola e i gesti
    // di copia sono tre: tenerla nel controller darebbe tre risposte che divergono, e una copia a
    // cui manca un campo si salva senza un errore.
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/copyRows",
    // [ROW-CANCEL] Cancellare una riga transiente, o premere Annulla, fa RIFIUTARE la promessa
    // della POST che non era ancora partita. Nessuno la raccoglieva, e ogni gesto ordinario
    // stampava «Uncaught (in promise) Error: Request canceled» nella console, che qui e' la
    // superficie diagnostica.
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/rowCancel",
    // [ROW-UNSAVED] Quali righe non sono ancora sul server. «Non salvata» sono DUE cose — la riga
    // nuova e quella modificata — e UI5 le espone in due modi diversi: la prima come annotazione
    // legabile, la seconda solo come `hasPendingChanges()`, che va ricalcolato.
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/unsavedRows",
    // [APP-URL] Ogni URL verso il nostro backend porta davanti la base dell'app:
    // servita da Work Zone l'app sta sotto un prefisso, e un path assoluto non lo porta.
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/AppUrl",
    // [AA-GROUP-VH] Le voci della tendina «Gruppo» dell'assegnazione automatica. Il gruppo si
    // digitava a mano e a valle viene confrontato per stringa esatta: un refuso non da' nessun
    // errore, da' una riga di configurazione inerte.
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/groupValueHelp",
    // [AA-GROUP-VH] Il comparatore della tendina e' lo STESSO del menu di colonna, cioe' il
    // collatore unico del progetto (DEC-102): due elenchi ordinati in modo diverso nella stessa
    // schermata sono esattamente cio' che nessuno noterebbe.
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/columnSortRules"
], (Controller, MessageToast, MessageBox, Fragment, Messaging, JSONModel, Filter, FilterOperator,
    ColumnMenu, AutoAssignDuplicates, CopyRows, RowCancel, UnsavedRows, AppUrl,
    GroupValueHelp, ColumnSortRules) => {
    "use strict";

    // Reserved keys for the two default positions inside a cycle
    const FIRST_OP = "FIRST_OP";
    const LAST_OP = "LAST_OP";
    const AUTO_ASSIGN_GROUP = "autoAssignChanges";
    // [AA-DUPLICATE] Update group dei campi di ZPlant (interruttori della scheda Parametri globali).
    // Era `autoAssignChanges`, che e' anche il DEFAULT del modello: muovere un interruttore mandava
    // in flush le righe di auto-assegnazione ancora a meta', senza che nessuno avesse premuto il
    // Salva della tabella e senza mostrarne l'esito. Da li' la riga rifiutata restava pendente e
    // veniva rispedita al successivo submit, quale che fosse.
    const PLANT_FIELDS_GROUP = "plantChanges";
    const OBJ_GROUP_GROUP = "objGroupChanges";
    const PLEX_MAP_GROUP = "fieldMapChanges";
    const PLEX_OP_GROUP = "opFieldMapChanges";
    const MAT_CAT_GROUP = "matCategoryChanges";
    // [COMP-EXCL] Update group della scheda esclusione componenti d'ordine: regola e condizioni
    // vanno nello STESSO batch, che il server vede come una transazione sola.
    const COMP_EXCL_GROUP = "compExclChanges";
    const JOB_SORT_GROUP = "jobSortChanges";
    // [PLEX-CONN] feature 0020, blocco «Connessione Plex» della tab GlobalParams
    const PLEX_CONN_GROUP = "plexConnChanges";
    // [PLEX-SECRET] I cinque campi del blocco «Connessione Plex», nell'ordine della schermata, e i
    // due che portano un segreto. Servono per NEGARE al gestore password del browser di trattarli
    // come una credenziale: vedi _hardenPlexConnInputs() e DEC-79.
    const PLEX_CONN_INPUT_IDS = [
        "plexConnBaseUrl", "plexConnConsumerKey", "plexConnDsUrl", "plexConnDsUser", "plexConnDsPassword"
    ];
    const PLEX_SECRET_INPUT_IDS = ["plexConnConsumerKey", "plexConnDsPassword"];
    // [ROUTING-FILTER] feature 0016, tab "Routings"
    const ROUTING_FILTER_GROUP = "routingFilterChanges";
    // [ORDER-STATUS-FILTER] feature 0017, tab "Ordini di produzione"
    const PROD_ORDER_FILTER_GROUP = "prodOrderFilterChanges";
    // [ORDER-TECO] Feature 0023. Update group PROPRIO e non quello del blocco 0017, benche' le due
    // sezioni stiano nella stessa tab: submitBatch/hasPendingChanges/resetChanges sono group-scoped
    // e model-wide, quindi condividerlo manderebbe le righe pendenti dell'altra sezione nello
    // stesso changeset atomico — e un Annulla ne scarterebbe le modifiche.
    const PROD_ORDER_TECO_GROUP = "prodOrderTecoChanges";
    // [ORDER-COMPLETE] feature 0045. Update group PROPRIO, per la stessa ragione della riga qui
    // sopra: le due sezioni vivono nella stessa tab ma sono due entity, e un Annulla su una non
    // deve scartare le modifiche dell'altra.
    const PROD_ORDER_COMPLETE_GROUP = "prodOrderCompleteChanges";
    // [ORDER-SCHEDULED] feature 0046: gruppo SUO e non quello della gemella. Con un gruppo in
    // comune un Salva su una sezione manderebbe anche le modifiche non salvate dell'altra.
    const PROD_ORDER_SCHEDULED_GROUP = "prodOrderScheduledChanges";
    // [PHANTOM-EXPLODE] feature 0019. UN SOLO update group per TRE tab — "Distinta base",
    // "Routings" e "Ordini di produzione" — perche' la riga di configurazione e' UNA: i
    // parametri del motore stanno con la distinta, i due interruttori con l'oggetto che
    // governano, ma il record e' lo stesso. Group-scoped significa che un Salva da una
    // qualunque delle tre persiste anche le modifiche fatte nelle altre due: e' dichiarato
    // nella MessageStrip di ciascuna, non lasciato scoprire.
    const PHANTOM_GROUP = "phantomExplodeChanges";
    // [CONF-POSTING] Feature 0028: update group PROPRIO per la scheda «Consuntivazione». La riga e'
    // una sola e una sola scheda la edita, quindi non c'e' niente da condividere — ed e' meglio
    // cosi': questa configurazione decide MOVIMENTI DI MAGAZZINO, e un Salva condiviso manderebbe
    // in SAP modifiche che chi ha premuto il bottone non stava guardando.
    const CONF_POSTING_GROUP = "confPostingChanges";
    // [W1-03] feature dell'operazione di ricevimento, tab "Operazioni di ricevimento"
    const RECV_OP_GROUP = "recvOpChanges";
    // [PLEX-PART-CODES] Feature 0022: un solo update group per le DUE tabelle della scheda
    // «Codici Plex». Sono una configurazione sola — «con che tipologia e con che stato nasce una
    // part di questo plant» — e un solo Salva deve mandarle entrambe.
    const PLEX_PART_CODE_GROUP = "plexPartCodeChanges";
    // [PLEX-OP-TYPE-FILTER] Feature 0024: update group PROPRIO per la tabella dei filtri, benche'
    // stia nella stessa scheda del mapping campi. Non e' la stessa configurazione — una dice quali
    // operazioni si possono SCEGLIERE, l'altro come valorizzare i campi di quelle scelte — e un
    // Salva condiviso manderebbe a Plex modifiche che chi ha premuto il bottone non stava
    // guardando. E' l'opposto del caso «Codici Plex», dove le due tabelle sono una cosa sola.
    const OP_TYPE_FILTER_GROUP = "opTypeFilterChanges";
    // I due ambiti, nell'ordine in cui la tabella li mostra. Duplicati da
    // srv/lib/plexOpTypeFilter.js di proposito: qui servono a materializzare le due righe, la
    // validazione che decide e' quella del server.
    const OP_TYPE_SCOPES = ["RECV", "CYCLE"];
    // [ROW-COPY] Le colonne di una condizione di gruppo, e SOLO quelle. Servono al `$select` della
    // lettura delle condizioni da copiare: quel binding non ha controlli agganciati da cui
    // `autoExpandSelect` possa ricavarlo, e una colonna non chiesta uscirebbe dalla copia VUOTA,
    // senza errore. L'elenco e' lo stesso che copyRows.conditionRow porta nella copia.
    const GROUP_FIELD_PROPS = [
        "ConditionType", "FieldName", "FieldValue", "Class", "Characteristic", "CharcValue"
    ];
    // [ROW-COPY] Tetto della lettura delle condizioni di un gruppo da copiare. E' un RIFIUTO e non
    // un troncamento: una copia parziale risponde 200 ed e' indistinguibile da una completa, ed e'
    // la trappola di DEC-49. Un gruppo con piu' di cosi' non esiste — se esistesse, va saputo.
    const MAX_GROUP_FIELDS = 500;

    // [AA-GROUP-VH] Tetto della lettura dei gruppi che alimenta la tendina dell'assegnazione
    // automatica. Un troncamento qui NON si legge come un troncamento: si legge come «quel gruppo
    // non esiste», ed e' la trappola di DEC-49 nella sua forma peggiore, perche' la risposta
    // arriva `200` con meno righe. Per questo il tetto e' largo — i gruppi di un plant sono
    // decine — e il suo raggiungimento si DICHIARA invece di restare implicito.
    const MAX_GROUP_VH = 1000;

    // [COLUMN-SORT] Le due liste che hanno il menu di colonna, una riga per tabella, cosi' la
    // meccanica non si scrive due volte: id del controllo, chiave nel modello dei criteri attivi,
    // e il modello OData con l'update group su cui chiedere se ci sono modifiche aperte — perche'
    // un binding V4 con modifiche in sospeso RIFIUTA di essere ordinato o filtrato (DEC-102).
    //
    // Nota su `autoAssignChanges`: e' l'update group condiviso con i tre interruttori di «Parametri
    // globali» che scrivono su ZPlant (onSaveMaxRetry, onSaveAutoAssignFlag,
    // onSaveMatDocPostEnabled). Un interruttore mosso e non salvato blocca quindi anche
    // l'ordinamento dell'auto-assegnazione: E' vero — e' una modifica in sospeso su quel gruppo —
    // e il messaggio lo dice, invece di far sembrare rotto il menu.
    const COLUMN_MENU_TABLES = [
        { table: "autoAssignTable",   key: "autoAssign",   model: "catalog", group: AUTO_ASSIGN_GROUP },
        { table: "objectGroupsTable", key: "objectGroups", model: "objgrp",  group: OBJ_GROUP_GROUP }
    ];

    // [ROW-UNSAVED] Le tre tabelle editabili che portano il marcatore delle righe non salvate, col
    // modello da cui prendere i loro contesti. Le CONDIZIONI del gruppo aperto ci sono: la copia di
    // un gruppo ne crea di transienti, e senza il marcatore la scheda direbbe «non salvato» sulla
    // testata e niente sulle righe che la accompagnano.
    const UNSAVED_TABLES = [
        { table: "autoAssignTable",   model: "catalog" },
        { table: "objectGroupsTable", model: "objgrp" },
        { table: "groupFieldsTable",  model: "objgrp" }
    ];

    // Validazione client-side dell'indirizzo: type="Email" in UI5 NON valida nulla, cambia
    // solo la tastiera su mobile.
    const RX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    // ---- Feature 0014: ordinamento della lista di lavoro Plex ----
    // Valori noti suggeriti (M-11). Duplicati dal modulo puro server-side di proposito: qui
    // servono solo all'AVVISO non bloccante, la validazione che decide e' quella del server.
    const KNOWN_FROZEN_STATUSES = ["Production", "Scheduled", "Sequenced"];
    // Stessa regola di forma di srv/lib/plexJobSortRules.js (D-02). Se la si allarga la', va
    // allargata anche qui: e' l'unico punto di duplicazione consapevole del frontend.
    const RX_FROZEN_TOKEN = /^[A-Za-z]+(?: [A-Za-z]+)*$/;

    return Controller.extend("avvaleplm.marsplm.sap2plex.adminconfigplant.controller.PlantConfig", {

        onInit() {
            // Empty operations model so the ComboBox binding resolves before the API answers
            const oPlexOpsModel = new JSONModel({
                operations: [],       // ambito CYCLE, chiavate sul CODICE: tendina auto-assegnazione
                operationsById: [],   // ambito RECV, chiavate sull'ID: tendina del ricevimento
                // [PLEX-OP-TYPE] id (minuscolo) -> tipo dichiarato da Plex. Alimenta la colonna in
                // sola lettura della scheda ricevimento: il tipo non si digita piu'.
                typeById: {},
                // [PLEX-OP-TYPE] Marcatore di «l'elenco e' arrivato». Serve come seconda `part` dei
                // formatter che leggono `typeById`: un formatter legato al solo PlexOperationId non
                // si rivaluterebbe quando l'elenco arriva DOPO il rendering della tabella, e la
                // colonna resterebbe vuota fino al primo cambio di riga.
                loadedAt: 0,
                // [PLEX-OP-TYPE-FILTER] Esito della lettura per ambito: `readOk` distingue «filtrato
                // a zero» da «Plex non ha risposto», che a schermo sono la stessa tendina vuota.
                recv: null,
                cycle: null
            });
            // Il JSONModel materializza al massimo `iSizeLimit` contesti (default 100) per una
            // aggregation binding senza `length`: le due ComboBox delle operazioni Plex si
            // fermavano alla centesima e le altre — fra cui quelle di ricevimento, che sul tenant
            // stanno in coda — sparivano SENZA alcun errore, ne' un messaggio, ne' un troncamento
            // visibile: la lista finiva e basta, e non le agganciava nemmeno la digitazione.
            // Il limite sta QUI e non in _loadPlexOperations() perche' vale cosi' per entrambe le
            // liste (`operations` e `operationsById`) e anche per la setData del ramo di errore.
            oPlexOpsModel.setSizeLimit(5000);
            this.getView().setModel(oPlexOpsModel, "plexOps");
            // [PLEX-CONN] Plant per cui le operazioni Plex sono gia' state caricate. Era un
            // booleano: con un tenant per plant serve sapere QUALE plant, non SE.
            this._sOpsLoadedPlant = null;

            // [AA-GROUP-VH] I gruppi del plant, per la tendina «Gruppo» dell'assegnazione
            // automatica. DUE elenchi e non uno: `configured` e' cio' che la lettura ha portato,
            // `items` e' quello che la tendina mostra — i configurati piu' la coda dei codici in
            // uso che non vi compaiono. Tenerne uno solo vorrebbe dire ricostruire la coda a
            // partire da se stessa, cioe' accumularla (la tabella la ricalcola a ogni
            // `updateFinished`).
            const oGroupVHModel = new JSONModel({ configured: [], items: [] });
            // Stesso trabocchetto delle operazioni Plex qui sopra, e vale anche qui: il default di
            // `JSONModel` materializza 100 contesti, e la tendina si ferma alla centesima voce
            // SENZA un errore, senza un messaggio e senza un troncamento visibile — l'elenco
            // finisce e basta, e la digitazione non aggancia le voci mancanti.
            oGroupVHModel.setSizeLimit(5000);
            this.getView().setModel(oGroupVHModel, "groupVH");
            // Come `_sOpsLoadedPlant`: QUALE plant, non SE. I gruppi sono per plant, e un booleano
            // mostrerebbe sul plant B l'elenco del plant A.
            this._sGroupsLoadedPlant = null;

            // Ruolo utente: default fail-closed (le tab ADMIN ADMIN restano nascoste finche'
            // il check non conferma il ruolo 'admin'). Vedi visible="{= ...session>/isFullAdmin}".
            this.getView().setModel(new JSONModel({ isFullAdmin: false }), "session");

            // Feature 0013 / FR-18: avviso della tab «Categorie materiali». Default nessun
            // avviso: un avviso mancante e' preferibile a un avviso falso (su canale storico
            // le due informazioni ci sono, e l'avviso sarebbe rumore).
            this.getView().setModel(new JSONModel({
                hasFieldWarning: false,
                fieldWarningText: ""
            }), "matCatAvail");

            // [PLEX-OP-TYPE] Avvisi delle due schede che riguardano il campo `type` della
            // part-operation. Default «niente da dichiarare»: un avviso che compare prima che la
            // lettura abbia risposto sarebbe un falso, e questi avvisi servono proprio a
            // distinguere «configurato» da «non configurato».
            //
            // Dalla feature 0024 (DEC-84) il tipo NON e' piu' configurabile e i due avvisi hanno
            // cambiato oggetto: `hasMissingOpType` dice che l'operazione scelta non ha un tipo sul
            // tenant (o che il catalogo non e' leggibile), `hasInertTypeMapping` che in tabella c'e'
            // ancora una riga di mapping su `type` salvata prima della feature — inerte, e da
            // eliminare. Un customizing inerte e muto e' il difetto che questo progetto denuncia in
            // cinque punti: qui si dichiara.
            this.getView().setModel(new JSONModel({ hasMissingOpType: false, opTypeGapText: "" }), "recvOp");
            this.getView().setModel(new JSONModel({ hasInertTypeMapping: false }), "opFieldGap");

            // Feature 0014: stato del blocco «Ordinamento della lista di lavoro Plex». Modello
            // JSON e NON binding OData diretto sui controlli, perche' la riga di configurazione
            // puo' non esistere e aprire la schermata non deve crearla (FDD §7.3, FR-24).
            // `exists: true` all'avvio significa «niente da dichiarare»: M-12 non deve comparire
            // finche' la lettura non ha detto se la riga esiste.
            this.getView().setModel(new JSONModel(this._jobSortState(null, true)), "jobSort");

            // [PLEX-CONN] Feature 0020: stato del blocco «Connessione Plex». Stessa ragione del
            // modello 'jobSort' qui sopra — la riga puo' non esistere e aprire la schermata non
            // deve crearla — con una differenza che conta: qui «non configurato» significa che
            // per questo plant NESSUN flusso verso Plex parte, quindi l'avviso e' un Warning e
            // non una Information. `exists: true` all'avvio = «niente da dichiarare»: l'avviso
            // non deve comparire prima che la lettura abbia risposto.
            this.getView().setModel(new JSONModel(this._plexConnState(null, true)), "plexConn");

            // [PLEX-SECRET] Qui, e non piu' in basso: gli attributi vanno messi sui controlli PRIMA
            // del primo render, e il ripiego di mascheramento cambia il `type` di un Input.
            this._hardenPlexConnInputs();

            // [ORDER-STATUS-FILTER] Feature 0017: stato del blocco «Perimetro ordini per stato».
            // Stessa ragione del modello 'jobSort' qui sopra: la riga puo' non esistere e aprire
            // la schermata non deve crearla. `exists: true` all'avvio = «niente da dichiarare»,
            // cosi' l'avviso non lampeggia prima che la lettura abbia risposto.
            this.getView().setModel(new JSONModel(this._prodOrderFilterState(null, true)), "osf");

            // [ORDER-TECO] Feature 0023: stato del blocco «Chiusura tecnica riportata su Plex»,
            // nella stessa tab e con la stessa ragione — la riga puo' non esistere, e aprire la
            // schermata non deve crearla.
            this.getView().setModel(new JSONModel(this._prodOrderTecoState(null, true)), "tec");

            // [ORDER-COMPLETE] Feature 0045: stato del blocco «Job completato su Plex -> stato
            // utente in SAP», quarta sezione della stessa tab. Stessa ragione: la riga puo' non
            // esistere, e aprire la schermata non deve crearla.
            this.getView().setModel(
                new JSONModel(this._prodOrderCompleteState(null, true)), "cmp");

            // [ORDER-SCHEDULED] Feature 0046: stato del blocco «Job pianificato su Plex -> stato
            // utente in SAP», quinta sezione. Modello SUO e non quello della gemella: due sezioni
            // che condividessero un modello condividerebbero anche il flag `dirty`, quindi il
            // Salva di una si abiliterebbe sulle modifiche dell'altra.
            this.getView().setModel(
                new JSONModel(this._prodOrderScheduledState(null, true)), "sch");

            // [PHANTOM-EXPLODE] Feature 0019: stato del blocco «Esplosione dei componenti
            // fantasma», condiviso dalle tre tab che lo editano. Stessa ragione dei due modelli
            // qui sopra: la riga puo' non esistere e aprire la schermata non deve crearla.
            this.getView().setModel(new JSONModel(this._phantomState(null, true)), "phx");

            // [CONF-POSTING] Feature 0028: stato del blocco «Consuntivazione». Stessa ragione dei
            // modelli qui sopra: la riga puo' non esistere e aprire la schermata non deve crearla.
            this.getView().setModel(new JSONModel(this._confPostingState(null, true)), "cpc");

            // [COLUMN-SORT] I criteri attivi delle due liste editabili, per l'`infoToolbar` che li
            // dichiara. Default «niente da dichiarare»: la barra compare solo quando un criterio
            // c'e' davvero.
            this.getView().setModel(new JSONModel({
                autoAssign: { visible: false, text: "" },
                objectGroups: { visible: false, text: "" }
            }), "listCriteria");
            // Le due tabelle stanno in `<core:Fragment>` inline della vista, quindi esistono gia'
            // qui: nessun bisogno di aspettare `onAfterRendering`.
            this._installColumnMenus();
            this._installUnsavedMarks();

            this.getOwnerComponent().getRouter()
                .getRoute("plantConfig")
                .attachPatternMatched(this._onPlantMatched, this);
        },

        _onPlantMatched(oEvent) {
            const sPlantCode = oEvent.getParameter("arguments").plantCode;
            this._sPlantCode = sPlantCode;

            // Check del ruolo PRIMA di caricare/mostrare la config. Default fail-closed +
            // busy finche' il server non risponde. La mail e' ricavata server-side da req.user.
            const oPage = this.byId("plantConfigPage");
            this.getView().getModel("session").setProperty("/isFullAdmin", false);
            oPage.setBusy(true);

            // Il gestore di rigetto e' il SECONDO argomento di then(), non un .catch() in coda:
            // un .catch() intercetta anche cio' che lancia nel ramo positivo, ed e' cosi' che una
            // qualunque eccezione dei quindici caricatori usciva come «non hai i permessi» con
            // uscita dalla schermata — nessun problema di licenza, e nemmeno una riga in console.
            this._checkUserRole(sPlantCode).then((sRole) => {
                // Autorizzato: da qui in avanti NESSUNA eccezione e' un diniego di permessi.
                try {
                    if (sRole === "admin") {
                        // ADMIN ADMIN: vede tutto.
                        this.getView().getModel("session").setProperty("/isFullAdmin", true);
                    } else {
                        // admin-config (ADMIN FAKE): tab ADMIN ADMIN nascoste; la prima tab
                        // (globalParams) e' nascosta -> seleziona la prima tab visibile.
                        // [W1-23] Era "materials", scheda rimossa perche' interamente mock: la prima
                        // visibile per questo ruolo e' ora "fieldMapping". Un utente 'admin' non passa
                        // di qui e continua ad atterrare su globalParams, primo tab dell'IconTabBar.
                        this.getView().getModel("session").setProperty("/isFullAdmin", false);
                        this.byId("configTabBar").setSelectedKey("fieldMapping");
                    }
                    // Solo se autorizzato: bind + filtri per-plant + load Plex operations.
                    this._loadPlantConfig(sPlantCode);
                } catch (oError) {
                    // Il ruolo E' stato risolto: un caricamento che si interrompe non e' un
                    // problema di permessi, quindi nessun messaggio di diniego e nessuna uscita
                    // dalla schermata. Ma va DICHIARATO in console con lo stack: senza, un errore
                    // qui torna a essere invisibile, ed e' esattamente com'e' sopravvissuto.
                    console.error(">>> [PLANT-CONFIG] caricamento della configurazione del plant " +
                        sPlantCode + " interrotto da un errore: la schermata resta aperta e una " +
                        "parte dei blocchi puo' essere incompleta.", oError);
                }
            }, () => {
                // Nessun ruolo valido / non determinabile -> accesso negato: blocca e torna indietro.
                const oBundle = this.getView().getModel("i18n").getResourceBundle();
                MessageBox.error(oBundle.getText("msgRoleAccessDenied"), {
                    onClose: () => this.onNavBack()
                });
            }).finally(() => {
                oPage.setBusy(false);
            });
        },

        // Chiama la function CAP getUserRole (mail ricavata server-side da req.user).
        // Risolve con 'admin' | 'admin-config'; rigetta su accesso negato (403) o errore.
        _checkUserRole(sPlantCode) {
            const sUrl = AppUrl.url("/odata/v4/catalog/getUserRole(plant='") + encodeURIComponent(sPlantCode) + "')";
            return fetch(sUrl, { headers: { "Accept": "application/json" } }).then((res) => {
                if (!res.ok) {
                    throw new Error("HTTP " + res.status);
                }
                return res.json();
            }).then((oData) => {
                const sRole = oData && oData.value;
                if (sRole === "admin" || sRole === "admin-config") {
                    return sRole;
                }
                throw new Error("no role");
            });
        },

        // Carica i dati di configurazione del plant (eseguito solo per utenti autorizzati).
        _loadPlantConfig(sPlantCode) {
            // Header identity + status come from the persisted plant master (ZPlant, catalog model).
            this.getView().bindElement({
                path: "/ZPlant(PlantCode='" + sPlantCode + "')",
                model: "catalog"
            });

            // [W1-23] Qui stava il bind sul modello JSON 'plants' (= mockPlants.json): cercava il
            // plant per codice fra cinque plant tedeschi inventati e, non trovandolo, ricadeva su
            // /Plants/0 — cioe' mostrava i parametri di Hamburg spacciandoli per quelli del plant
            // aperto. Modello e schede finte sono spariti; l'unica scheda rimasta a leggere un JSON
            // locale ('fieldMap') usa un path ASSOLUTO e non vuole nessun element binding.

            // [COLUMN-SORT] Prima dei filtri plant: i criteri di colonna appartengono al perimetro
            // che stanno restringendo, e un criterio sopravvissuto a un cambio di plant
            // dichiarerebbe una restrizione riferita a righe che non ci sono piu'.
            this._resetColumnMenus();

            // Scope the plant-specific OData tables + load Plex operations (plantCode is known now).
            this._applyAutoAssignPlantFilter();
            this._applyObjectGroupsPlantFilter();
            // [AA-GROUP-VH] La tendina «Gruppo» dell'assegnazione automatica legge gli stessi
            // gruppi della scheda qui sopra. Fuori dal gate ADMIN come loro: le due schede si
            // vedono anche con il solo ruolo 'admin-config'.
            this._loadObjectGroupVH();
            this._applyPlexFieldMapPlantFilter();
            this._applyPlexOpFieldMapPlantFilter();
            // [PLEX-OP-TYPE-FILTER] Feature 0024: sta nella stessa scheda del mapping campi
            // operazione, quindi fuori dal gate ADMIN come lui.
            this._applyOpTypeFilterPlantFilter();
            this._applyMatCategoryPlantFilter();
            this._applyRoutingFilterPlantFilter();
            // ADMIN-only: un IconTabFilter invisibile viene comunque ISTANZIATO, quindi senza
            // questo gate (piu' suspended nel fragment) anche un 'admin-config' scaricherebbe
            // gli indirizzi e-mail. Con entrambi: ZERO richieste per i non-admin.
            if (this.getView().getModel("session").getProperty("/isFullAdmin")) {
                this._applyJobNotifyFilters();
                // Feature 0014: stessa ragione del gate qui sopra. Un 'admin-config' non vede la
                // tab dei parametri globali e non deve emettere NESSUNA richiesta su questa entity.
                this._loadJobSortConfig();
                // [ORDER-STATUS-FILTER] Feature 0017: idem, la tab "Ordini di produzione" e' ADMIN.
                this._loadProdOrderFilterConfig();
                // [ORDER-TECO] Feature 0023: stessa tab, stesso gate. Due letture e non una,
                // perche' sono due entity: il perimetro e l'evento di chiusura.
                this._loadProdOrderTecoConfig();
                // [ORDER-COMPLETE] Feature 0045: stessa tab, stesso gate. Terza lettura, terza
                // entity: il perimetro, l'evento di chiusura in SAP, e il completamento su Plex.
                this._loadProdOrderCompleteConfig();
                // [ORDER-SCHEDULED] Feature 0046: quarta lettura, l'altro estremo del ciclo.
                this._loadProdOrderScheduledConfig();
                // [COMP-EXCL] Stessa tab, stesso gate: le regole di esclusione componenti sono
                // ADMIN e non devono generare richieste per gli altri ruoli.
                this._applyCompExclPlantFilter();
                // [PHANTOM-EXPLODE] Feature 0019: idem. UNA lettura per tutte e tre le tab che
                // mostrano il blocco, perche' la riga e' una sola.
                this._loadPhantomConfig();
                // [PLEX-CONN] Feature 0020: stessa ragione, con un motivo in piu' per NON
                // emettere la richiesta fuori dal gate. Le altre entity di questo blocco
                // espongono configurazione; ZPlexConnConfig espone due SEGRETI, e infatti e'
                // l'unica del progetto protetta anche lato server: fuori dal gate la richiesta
                // partirebbe per prendersi un 403.
                this._loadPlexConnConfig();
                // [W1-03] Stessa ragione del gate: la tab «Operazioni di ricevimento» e' ADMIN,
                // e un IconTabFilter invisibile viene comunque istanziato.
                this._applyRecvOpPlantFilter();
                // [CONF-POSTING] Feature 0028: idem, la scheda «Consuntivazione» e' ADMIN.
                this._loadConfPostingConfig();
                // [PLEX-PART-CODES] Feature 0022: idem, la scheda «Codici Plex» e' ADMIN.
                this._applyPlexPartCodesPlantFilter();
                this._loadPlexTypeValues();
                this._loadPlexStatusOverride();
            }
            this._loadPlexOperations();
        },

        onNavBack() {
            this.getOwnerComponent().getRouter().navTo("plantDashboard");
        },

        formatPageTitle(sPattern, sCode, sName) {
            if (sPattern && sCode) {
                return sPattern.replace("{0}", sCode).replace("{1}", sName || "");
            }
            return sPattern || "";
        },

        /**
         * [CATCHALL-RENDER] Il predicato dei booleani, e i formatter che lo usano.
         *
         * ATTENZIONE, e' la ragione per cui questi formatter esistono: un `Edm.Boolean` di OData V4
         * NON arriva al formatter come booleano se la proprieta' di destinazione e' una STRINGA.
         * `sap.ui.model.odata.type.Boolean.formatValue` (UI5 1.142) fa questo:
         *
         *     case "any": case "boolean":  return bValue;            // il booleano
         *     case "string":               return getText(bValue);   // "Yes"/"No" LOCALIZZATO
         *     function getText(b) { return getMessage(b ? "YES" : "NO"); }   // bundle sap.ui.core
         *
         * Verso `text`, `state` (e' un enum, cioe' una stringa) e `placeholder` il targetType e'
         * 'string': al formatter arrivava «Si'»/«No» — sempre truthy, mai `true`. Ecco perche' le
         * espressioni rendevano il ramo vero su OGNI riga, e un confronto stretto lo rendeva falso
         * su ogni riga. Lo `Switch` era corretto perche' la sua `state` e' booleana.
         *
         * Percio' OGNI binding di un booleano qui porta `targetType: 'any'`, su ogni parte dei
         * binding compositi: e' il ramo che restituisce il valore grezzo. Senza, il confronto
         * dipenderebbe dalla LINGUA dell'utente.
         *
         * I due `Switch` NON hanno targetType e non devono averlo: la loro proprieta' e' booleana,
         * quindi ricevono gia' il valore vero.
         */
        _isCatchAll(vValue) {
            return vValue === true || vValue === 1 || vValue === "true" || vValue === "1";
        },

        _mcText(sKey) {
            return this.getView().getModel("i18n").getResourceBundle().getText(sKey);
        },

        /**
         * [PLEX-TYPE-LABEL] Etichetta localizzata di una tipologia part Plex.
         *
         * La sorgente delle tendine e' una colonna di database (`ZPlexPartTypeVH.Label`) o il
         * codice grezzo, e nessuna delle due sa in che lingua sta guardando l'utente: la
         * traduzione e' i18n, con la chiave costruita dal codice — lo stesso pattern degli stati
         * ordine (`osfSt` + codice, piu' sotto) e di `formatSplitStateText` nel cockpit.
         *
         * Il ripiego e' cio' che il server ha mandato: il `Label` del seed dove c'e', altrimenti
         * il codice. Non e' decorazione — DEC-62 prevede che `PlexValue` si cambi NEL SEED per
         * adattarsi al tenant, senza rilascio applicativo, quindi un codice rinominato deve
         * comparire in chiaro e non svuotare la tendina.
         *
         * Si traduce SOLO il testo. La chiave della voce resta il codice grezzo, ed e' quella che
         * si salva e che il server riconfronta stretta (0022 RB-19, DEC-51): niente di
         * localizzato entra mai in un confronto.
         */
        _plexPartTypeLabel(sCode, sFallback) {
            // Un codice vuoto esce vuoto, e NON e' una precauzione di stile: una categoria senza
            // part type e' ammessa (DEC-62 regola 2, e' un criterio di sola visibilita'), e senza
            // questa uscita la chiave costruita sarebbe `plexPartType` — che nel cockpit esiste
            // davvero, e' l'intestazione della colonna. La cella mostrerebbe «Plex Part Type».
            const sTrimmed = String(sCode || "").trim();
            if (!sTrimmed) {
                return "";
            }
            const sKey = "plexPartType" + sTrimmed.replace(/[^A-Za-z0-9]/g, "");
            const oBundle = this._i18n();
            return oBundle.hasText(sKey) ? oBundle.getText(sKey) : (sFallback || sTrimmed);
        },

        /**
         * Tendina e colonna della scheda «Categorie materiali». Con due parti il ripiego e' il
         * `Label` del seed; con una sola (la colonna della lista) e' il codice stesso.
         */
        formatPlexPartTypeLabel(sCode, sLabel) {
            return this._plexPartTypeLabel(sCode, sLabel);
        },

        /** Etichetta grigia sotto il nome, solo sul ripiego. */
        formatCatchAllTag(vCatchAll) {
            return this._isCatchAll(vCatchAll) ? this._mcText("mcCatchAllTag") : "";
        },

        /** Colonna «Catch-all»: risponde SI/NO, non attiva/non attiva. */
        formatCatchAllText(vCatchAll) {
            return this._isCatchAll(vCatchAll) ? this._mcText("mcCatchAllYes") : this._mcText("mcCatchAllNo");
        },

        formatCatchAllState(vCatchAll) {
            return this._isCatchAll(vCatchAll) ? "Warning" : "None";
        },

        /** Per gli `enabled`: sul ripiego sequenza e condizioni non si toccano. */
        formatNotCatchAll(vCatchAll) {
            return !this._isCatchAll(vCatchAll);
        },

        /**
         * Cella Sequence: sul ripiego un trattino, perche' la sua sequenza non viene mai letta —
         * e' valutato per ultimo per costruzione (DEC-61).
         */
        formatSequenceCell(vCatchAll, vSequence) {
            if (this._isCatchAll(vCatchAll)) {
                return "\u2014";
            }
            return (vSequence === null || vSequence === undefined) ? "" : String(vSequence);
        },

        formatSequencePlaceholder(vCatchAll) {
            return this._isCatchAll(vCatchAll) ? this._mcText("mcSequenceIgnoredHint") : "";
        },

        /** Testo accanto a «Condizioni»: sul ripiego dice che non ne accetta. */
        formatConditionsHint(vCatchAll) {
            return this._isCatchAll(vCatchAll)
                ? this._mcText("mcCatchAllNoConditions")
                : this._mcText("mcConditionsHint");
        },

        /**
         * [CATCHALL-RENDER] Stessa cura per `IsActive`, e non per simmetria: la colonna sembrava
         * corretta solo perche' TUTTE le righe del plant sono attive, quindi un'espressione sempre
         * vera e una lettura giusta danno lo stesso risultato. Con una categoria disattivata la
         * lista avrebbe continuato a dire «Attiva», ed e' esattamente il difetto che si sta
         * chiudendo, su un campo dove sbagliare e' peggio: una categoria spenta che sembra accesa
         * fa credere che un perimetro sia in vigore quando non lo e'.
         */
        _isActive(vValue) {
            return vValue === true || vValue === 1 || vValue === "true" || vValue === "1";
        },

        formatActiveText(vActive) {
            return this._isActive(vActive) ? this._mcText("mcActiveYes") : this._mcText("mcActiveNo");
        },

        formatActiveState(vActive) {
            return this._isActive(vActive) ? "Success" : "None";
        },

        formatStatusText(sStatus) {
            const oResourceBundle = this._i18n();
            if (sStatus === "Active") return oResourceBundle.getText("statusActive");
            if (sStatus === "InProgress") return oResourceBundle.getText("statusInProgress");
            if (sStatus === "Disabled") return oResourceBundle.getText("statusDisabled");
            return sStatus || "";
        },

        formatStatusState(sStatus) {
            if (sStatus === "Active") return "Success";
            if (sStatus === "InProgress") return "Warning";
            if (sStatus === "Disabled") return "None";
            return "None";
        },

        formatStatusIcon(sStatus) {
            if (sStatus === "Active") return "sap-icon://sys-enter-2";
            if (sStatus === "InProgress") return "sap-icon://pending";
            if (sStatus === "Disabled") return "sap-icon://decline";
            return "";
        },

        // [ORDER-STATUS-FILTER] `onAddStatusMapping` e `onDeleteStatusMapping` stavano qui: erano
        // gli unici due handler della tabella mock SAP_STATUS_MAP del tab "Ordini di produzione",
        // rimossa con la feature 0017. Nessun altro fragment li usava.

        // ============================================================
        // [COLUMN-SORT] MENU DI COLONNA delle due liste editabili (DEC-102)
        //
        // Ordinamento e filtro cliccando l'intestazione, sulle stesse tabelle su cui si continua a
        // modificare in linea, aggiungere ed eliminare righe. La meccanica sta in
        // util/ColumnMenu.js e le regole in util/columnSortRules.js, identico byte per byte a
        // quello della dashboard; qui c'e' solo il cablaggio.
        //
        // Il confronto lo fa il SERVER, perche' queste tabelle sono binding OData V4 in scrittura:
        // un `Filter` con `test` non verrebbe applicato affatto e un comparatore verrebbe ignorato.
        // Ed e' giusto cosi' — dietro c'e' una tabella del database, quindi `$filter` e `$orderby`
        // lavorano sull'insieme intero e non sulla pagina mostrata.
        // ============================================================

        _installColumnMenus() {
            // Il ripiego sul modello del Component non e' difensivo per abitudine: qui siamo in
            // `onInit`, e le tre etichette del menu si leggono UNA VOLTA alla costruzione. Se il
            // bundle mancasse, ColumnMenu ripiegherebbe sui suoi testi italiani cablati — cioe' un
            // menu in italiano a un utente inglese, senza che niente lo dica. Stessa forma di
            // `_i18n()` nel controller della dashboard.
            const oI18n = this.getView().getModel("i18n") || this.getOwnerComponent().getModel("i18n");
            const oBundle = oI18n.getResourceBundle();
            COLUMN_MENU_TABLES.forEach((oCfg) => {
                const oTable = this.byId(oCfg.table);
                if (!oTable) { return; }
                ColumnMenu.install(oTable, {
                    i18n: oBundle,
                    canApply: (sReason) => this._columnMenuCanApply(oCfg, sReason),
                    onChange: (oState) => this._onCriteriaChange(oCfg.key, oState)
                });
            });
        },

        /**
         * [ROW-UNSAVED] Gli inneschi del ricalcolo delle righe non salvate.
         *
         * SONO DUE SPECIE, e nessuna delle due copre l'altra:
         *
         *   `propertyChange` sui due modelli OData (evento pubblico dal 1.110) scatta quando una
         *   persona cambia un campo: e' la sola strada per la riga MODIFICATA, che nessuna
         *   annotazione dichiara.
         *
         *   `updateFinished` sulle tre tabelle scatta quando l'elenco viene ri-reso — aggiunta,
         *   copia, cancellazione, paginazione e «Mostra di piu'». Serve anche contro il RICICLO
         *   degli elementi: `GrowingEnablement` riusa i controlli riagganciandoli a un'altra riga,
         *   ed e' il punto in cui il cruscotto si e' gia' bruciato con le classi CSS
         *   (`ProdOrderDetail.controller.js`: «Clear stale highlight classes»). Qui il colore e'
         *   una proprieta' LEGATA, quindi UI5 la rivaluta da se' al ri-aggancio; questo innesco
         *   tiene allineata la mappa che quel binding legge.
         *
         * Il quarto innesco — il fondo di Salva e Annulla — sta nei loro handler: la' il ricalcolo
         * e' l'ultima cosa che succede, dopo che il modello ha finito di cambiare idea.
         */
        _installUnsavedMarks() {
            ["catalog", "objgrp"].forEach((sModel) => {
                const oModel = this.getView().getModel(sModel);
                if (oModel && typeof oModel.attachPropertyChange === "function") {
                    oModel.attachPropertyChange(this._markUnsavedRows, this);
                }
            });
            UNSAVED_TABLES.forEach((oCfg) => {
                const oTable = this.byId(oCfg.table);
                if (oTable) { oTable.attachUpdateFinished(this._markUnsavedRows, this); }
            });
            // [AA-GROUP-VH] Stesso innesco, altra domanda: quali codici di gruppo sono in uso sulle
            // righe. Serve perche' la tabella cresce a blocchi di 50 — le righe con un gruppo fuori
            // elenco possono arrivare molto dopo la lettura dei gruppi — e perche' ogni aggiunta e
            // ogni copia ne portano di nuovi. Solo su questa tabella: e' l'unica che ha la tendina.
            const oAutoAssign = this._getAutoAssignTable();
            if (oAutoAssign) { oAutoAssign.attachUpdateFinished(this._refreshAutoAssignGroupVH, this); }
        },

        /**
         * [ROW-UNSAVED] Rimette il colore su ogni riga visibile, chiedendolo al SUO contesto.
         *
         * SI CHIEDE AL CONTESTO, e non a un binding. La prima versione legava l'annotazione
         * `@$ui5.context.isTransient` piu' una mappa per `ID`, e non ha colorato niente — nemmeno
         * una riga aggiunta da zero, che e' transiente per costruzione. Quella forma poggiava su tre
         * premesse mai eseguite; questa sui due predicati che `onCopyObjectGroup` usa gia' e che
         * sullo schermo dell'utente hanno funzionato.
         *
         * IL PREZZO E' DICHIARATO. Una proprieta' LEGATA la rivaluta UI5 a ogni ri-aggancio, quindi
         * e' immune per costruzione al riciclo dei controlli; questa forma lo e' soltanto FINCHE'
         * gli inneschi ci sono tutti — e `updateFinished` e' quello che copre proprio il riciclo di
         * `GrowingEnablement`. E' la ragione per cui il test li conta uno per uno.
         *
         * Si passa da `getItems()` e non dai contesti del binding: `getItems()` da' i controlli, ed
         * e' su quelli che il colore si posa.
         */
        _markUnsavedRows() {
            UNSAVED_TABLES.forEach((oCfg) => {
                const oTable = this.byId(oCfg.table);
                if (!oTable) { return; }
                oTable.getItems().forEach((oItem) => {
                    oItem.setHighlight(UnsavedRows.highlightFor(oItem.getBindingContext(oCfg.model)));
                });
            });
        },

        /**
         * Il binding si puo' toccare adesso?
         *
         * `ODataListBinding#filter` e `#sort` LANCIANO se ci sono modifiche in sospeso, e una riga
         * appena aggiunta con `create()` e' una modifica in sospeso. Quindi si guarda prima, e su
         * un rifiuto non cambia niente: nessun criterio impostato ma non applicato, che direbbe una
         * restrizione che la lista non ha.
         *
         * Il messaggio esce SOLO se il rifiuto risponde a un click dell'utente. Su un cambio di
         * plant sarebbe un popup che nessuno ha chiesto.
         */
        _columnMenuCanApply(oCfg, sReason) {
            const oModel = this.getView().getModel(oCfg.model);
            if (!oModel || !oModel.hasPendingChanges(oCfg.group)) { return true; }
            if (sReason !== ColumnMenu.REASON_SCOPE) {
                MessageBox.warning(
                    this.getView().getModel("i18n").getResourceBundle().getText("colMenuPendingChanges")
                );
            }
            return false;
        },

        /** I criteri attivi, come testo, nell'`infoToolbar` della loro tabella. */
        _onCriteriaChange(sKey, oState) {
            const oModel = this.getView().getModel("listCriteria");
            if (!oModel) { return; }
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const aParts = [];

            if (oState.sort) {
                aParts.push(oBundle.getText(
                    oState.sort.descending ? "criteriaSortDesc" : "criteriaSortAsc",
                    [oState.sort.label || oState.sort.field]
                ));
            }
            for (const oCol of oState.columns) {
                aParts.push(oBundle.getText("criteriaFilter",
                    [oCol.label || oCol.field, oCol.query]));
            }

            oModel.setProperty("/" + sKey, {
                visible: aParts.length > 0,
                text: aParts.join("  ·  ")
            });
        },

        /**
         * Azzera i criteri di entrambe le liste: si chiama al cambio di PLANT.
         *
         * Un criterio sopravvissuto a un cambio di plant dichiarerebbe una restrizione riferita a
         * righe che non ci sono piu' — la stessa regola di DEC-82 sulla dashboard.
         */
        _resetColumnMenus() {
            COLUMN_MENU_TABLES.forEach((oCfg) => {
                const oTable = this.byId(oCfg.table);
                if (oTable) { ColumnMenu.reset(oTable, ColumnMenu.REASON_SCOPE); }
            });
        },

        onClearAutoAssignCriteria() {
            ColumnMenu.reset(this.byId("autoAssignTable"));
        },

        onClearObjectGroupsCriteria() {
            ColumnMenu.reset(this.byId("objectGroupsTable"));
        },

        // ============================================================
        // CYCLE AUTO-ASSIGNMENT TAB
        // ============================================================

        _getPlantCode() {
            return this._sPlantCode || "";
        },

        _getAutoAssignTable() {
            return this.byId("autoAssignTable");
        },

        _applyAutoAssignPlantFilter() {
            const oTable = this._getAutoAssignTable();
            const oBinding = oTable && oTable.getBinding("items");
            if (oBinding) {
                oBinding.filter(new Filter("Plant", FilterOperator.EQ, this._getPlantCode()));
            }
        },

        // Fetch the Plex operations once and expose them (with the First/Last defaults) to the ComboBox
        _loadPlexOperations() {
            // [PLEX-CONN] La memoria del «gia' caricato» e' PER PLANT (feature 0020): le
            // operazioni vengono dal tenant Plex del plant, e due plant hanno due elenchi. Con il
            // vecchio flag booleano, aprendo il plant B dopo il plant A si sarebbero viste le
            // operazioni di A — con nulla a dirlo.
            const sPlant = this._getPlantCode();
            if (!sPlant || this._sOpsLoadedPlant === sPlant) {
                return;
            }
            this._sOpsLoadedPlant = sPlant;

            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const aDefaults = [
                { key: FIRST_OP, text: oBundle.getText("opFirstOperation") },
                { key: LAST_OP, text: oBundle.getText("opLastOperation") }
            ];

            // [PLEX-OP-TYPE-FILTER] DUE letture, una per ambito, e non piu' una sola in due viste:
            // i due elenchi ora possono essere diversi — «Ricevere» per il ricevimento, «Produzione»
            // per il ciclo — quindi filtrarne uno e derivarne l'altro darebbe alla tendina
            // dell'auto-assegnazione il perimetro sbagliato. Il filtro lo applica il server: qui non
            // si ripete la regola, si dichiara il suo esito.
            Promise.all([
                this._fetchScopedOperations(sPlant, "RECV"),
                this._fetchScopedOperations(sPlant, "CYCLE")
            ]).then(([oRecv, oCycle]) => {
                // Lista dell'auto-assegnazione: ambito CYCLE, chiavata sul CODICE, coi due
                // pseudo-valori in testa. Il codice e' un contratto gia' in esercizio
                // (ZCycleAutoAssignConfig.PlexOperation) e non va toccato.
                const aMapped = (oCycle.operations || []).map((op) => {
                    const sKey = op.code || op.id || "";
                    const sName = op.name || op.description || "";
                    return { key: sKey, text: sName ? (sKey + " - " + sName) : sKey };
                });
                // [W1-03] Seconda lista, chiavata sull'ID e non sul codice, e senza i due
                // pseudo-valori FIRST_OP/LAST_OP, che qui non hanno senso: un materiale senza ciclo
                // non ha una «prima» ne' una «ultima» operazione. Non e' un doppione per pigrizia:
                // il POST /mdm/v1/part-operations vuole `operationId`. Le righe senza id non
                // entrano: sarebbero una scelta non salvabile.
                const aById = (oRecv.operations || []).filter((op) => !!op.id).map((op) => {
                    const sCode = op.code || "";
                    const sName = op.name || op.description || "";
                    const sLabel = [sCode, sName].filter(Boolean).join(" - ");
                    return { key: op.id, code: sCode, name: sName, type: op.type || "", text: sLabel || op.id };
                });

                // [PLEX-OP-TYPE] La mappa dei tipi e' l'UNIONE dei due ambiti: una riga di
                // ricevimento salvata prima che il filtro esistesse puo' puntare a un'operazione che
                // il filtro RECV esclude, e in quel caso il tipo lo conosce comunque l'altro elenco.
                // Cio' che resta fuori da entrambi si dichiara, non si finge.
                const oTypeById = {};
                [].concat(oRecv.operations || [], oCycle.operations || []).forEach((op) => {
                    if (op && op.id) oTypeById[String(op.id).toLowerCase()] = op.type || "";
                });

                this.getView().getModel("plexOps").setData({
                    operations: aDefaults.concat(aMapped),
                    operationsById: aById,
                    typeById: oTypeById,
                    loadedAt: Date.now(),
                    recv: oRecv,
                    cycle: oCycle
                });
                this._refreshRecvOpGap();

                // Una lettura fallita si DICHIARA una volta, e non due: i due ambiti leggono lo
                // stesso catalogo, quindi se cade cade per entrambi.
                const oFailed = !oRecv.readOk ? oRecv : (!oCycle.readOk ? oCycle : null);
                if (oFailed) {
                    MessageToast.show(oBundle.getText("aaOpsLoadError", [oFailed.message || ""]));
                }
            });
        },

        /**
         * [PLEX-OP-TYPE-FILTER] Una lettura del catalogo operazioni per un ambito.
         *
         * Non rifiuta mai: un guasto diventa una busta con `readOk: false` e il suo messaggio. E'
         * la stessa forma dell'action, e serve allo stesso scopo — «tendina vuota perche' filtrata»
         * e «tendina vuota perche' Plex non ha risposto» sono due schermate diverse.
         */
        _fetchScopedOperations(sPlant, sScope) {
            const oEmpty = (sMessage) => ({
                operations: [], readOk: false, message: sMessage || "",
                filterScope: sScope, filterTypes: "", filterConfigured: false,
                total: 0, kept: 0, droppedNoType: 0
            });

            return fetch(AppUrl.url("/plex/getPlexOperations"), {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ Plant: sPlant, Scope: sScope })
            }).then((res) => {
                // `res.ok` si guarda: senza, un 500 finiva in `.json()` e usciva come elenco vuoto
                // senza una parola — che con un filtro attivo e' indistinguibile da «nessuna
                // operazione di quel tipo».
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.json();
            }).then((oData) => (oData && Array.isArray(oData.operations))
                ? oData
                : oEmpty("risposta non riconosciuta")
            ).catch((err) => oEmpty(err.message));
        },

        /**
         * [AA-GROUP-VH] I gruppi configurati del plant, per la tendina «Gruppo».
         *
         * PERCHE' UN MODELLO JSON E NON UN BINDING ODATA NEL TEMPLATE. `ColumnListItem` viene
         * CLONATO per riga: un `items="{objgrp>/ObjectGroups"}` dentro la cella sarebbe una
         * `ODataListBinding` per riga sulla stessa entity, ognuna col suo filtro per plant da
         * rimettere. Qui basta UNA lettura per plant, condivisa da tutte le righe — ed e' la
         * stessa forma della tendina delle operazioni Plex che le sta a fianco.
         *
         * IL `$select` E' ESPLICITO E NON E' PLEONASTICO. Un `bindList` programmatico non ha
         * controlli agganciati da cui `autoExpandSelect` possa ricavare le colonne, quindi senza
         * quell'elenco `Description` torna `undefined`: la tendina mostrerebbe il solo codice, che
         * e' meta' di quello che la feature esiste per mostrare, e nessun errore da nessuna parte.
         * E' la stessa ragione di `GROUP_FIELD_PROPS` in testa a questo file.
         *
         * UNA LETTURA CADUTA NON SVUOTA LO SCHERMO. Sul rifiuto l'elenco configurato resta vuoto e
         * si dichiara, ma `_refreshAutoAssignGroupVH` rimette comunque in tendina i codici gia'
         * salvati sulle righe: una cella vuota si legge come «mai compilato», che e' l'affermazione
         * opposta a «non ho potuto leggere i gruppi».
         *
         * @param {boolean} [bForce] rilegge anche se il plant e' gia' stato caricato (dopo un Salva
         *        della scheda «Gruppi», dove creazioni, rinomine e cancellazioni passano insieme)
         */
        _loadObjectGroupVH(bForce) {
            const sPlant = this._getPlantCode();
            if (!sPlant || (!bForce && this._sGroupsLoadedPlant === sPlant)) {
                return;
            }
            const oModel = this.getView().getModel("objgrp");
            if (!oModel) {
                return;
            }
            this._sGroupsLoadedPlant = sPlant;

            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oBinding = oModel.bindList("/ObjectGroups", null, null,
                new Filter("Plant", FilterOperator.EQ, sPlant),
                { $select: "GroupId,Description" });

            oBinding.requestContexts(0, MAX_GROUP_VH).then((aContexts) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo: scrivere qui
                // l'elenco di quello precedente darebbe una tendina che appartiene a un'altra
                // schermata, e senza niente a dirlo.
                if (this._getPlantCode() !== sPlant) { return; }

                const aRows = aContexts.map((oCtx) => oCtx.getObject() || {});
                this.getView().getModel("groupVH").setData({
                    configured: GroupValueHelp.buildConfigured(aRows, this._groupVHComparator()),
                    items: []
                });
                this._refreshAutoAssignGroupVH();

                if (aRows.length >= MAX_GROUP_VH) {
                    MessageToast.show(oBundle.getText("aaGroupsTruncated", [String(MAX_GROUP_VH)]));
                }
            }).catch((err) => {
                if (this._getPlantCode() !== sPlant) { return; }
                // Il plant si DIMENTICA: senza, un guasto lascerebbe la tendina vuota fino al
                // cambio di plant, perche' la memoria direbbe «gia' caricato».
                this._sGroupsLoadedPlant = null;
                this.getView().getModel("groupVH").setData({ configured: [], items: [] });
                this._refreshAutoAssignGroupVH();
                MessageToast.show(oBundle.getText("aaGroupsLoadError", [(err && err.message) || ""]));
            });
        },

        /**
         * [AA-GROUP-VH] Il comparatore della tendina: quello del menu di colonna, non un secondo.
         *
         * E' il collatore unico del progetto — `numeric: true`, `sensitivity: 'base'` — lo stesso
         * di `srv/lib/naturalOrder.js` e della tendina delle operazioni Plex (DEC-102). Un `sort()`
         * scritto qui a mano darebbe `G10` prima di `G9` su codici a riempimento misto, cioe' un
         * elenco che a chi guarda sembra non ordinato.
         *
         * @returns {function(string, string): number} comparatore di due testi, crescente
         */
        _groupVHComparator() {
            return ColumnSortRules.comparatorFor(ColumnSortRules.TYPE_STRING, false);
        },

        /**
         * [AA-GROUP-VH] Rimette in tendina i codici in uso che non sono fra i gruppi configurati.
         *
         * TRE CASI ARRIVANO QUI, e nessuno dei tre e' un errore di programmazione: il refuso
         * storico (il gruppo si digitava a mano), il gruppo cancellato dopo che una riga lo
         * referenziava, e la lettura dei gruppi caduta — dove `configured` e' vuoto e questa coda
         * e' tutto cio' che tiene leggibile la scheda.
         *
         * SI RIFA' DA ZERO OGNI VOLTA. `mergeUnknown` ricostruisce la coda da `configured` e dai
         * codici passati, quindi due chiamate di fila danno lo stesso elenco: la tabella cresce a
         * blocchi di 50 e ogni crescita, aggiunta o copia rifa' questo giro.
         */
        _refreshAutoAssignGroupVH() {
            const oModel = this.getView().getModel("groupVH");
            if (!oModel) { return; }
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const aUsed = this._getAutoAssignRows().map((oRow) => oRow && oRow.ComponentGroup);

            oModel.setProperty("/items", GroupValueHelp.mergeUnknown(
                oModel.getProperty("/configured") || [],
                aUsed,
                (sCode) => oBundle.getText("aaGroupUnknown", [sCode])
            ));
        },

        onOperationChange(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            const oCtx = oEvent.getSource().getBindingContext("catalog");
            if (!oCtx) {
                return;
            }
            const sKey = oItem ? oItem.getKey() : "";
            // Cache a readable name only for concrete operations, not for the First/Last defaults
            const sName = (sKey === FIRST_OP || sKey === LAST_OP || !oItem) ? "" : oItem.getText();
            oCtx.setProperty("PlexOperationName", sName);
        },

        onAddAutoAssign() {
            const oBinding = this._getAutoAssignTable().getBinding("items");
            RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                Material: "",
                ComponentGroup: "",
                PlexOperation: ""
            }));
        },

        // ============================================================
        // [ROW-COPY] Copia riga sulle due schede di customizing
        //
        // Una riga copiata nasce TRANSIENTE, in TESTA all'elenco, e vive fino al Salva o
        // all'Annulla della sua scheda: e' il contratto di «Aggiungi», con i valori della riga
        // sorgente al posto dei campi vuoti. Quali campi passano lo decide `util/copyRows.js`.
        //
        // IN TESTA E NON IN CODA, e il difetto sarebbe MUTO. `ODataListBinding#create` lancia solo
        // se non conosce la lunghezza finale della collezione («Must know the final length to
        // create at the end»), e su queste tabelle `$count: true` c'e' — quindi `bAtEnd: true`
        // verrebbe ACCETTATO, la riga andrebbe in fondo alla collezione e `growingThreshold="50"`
        // renderebbe le prime 50. Con 121 righe la copia sarebbe invisibile, cioe' non
        // correggibile — mentre e' proprio da correggere: identica al suo originale non e'
        // salvabile per costruzione, perche' entrambe le entity hanno una chiave unica.
        //
        // CONSEGUENZA SULLA SELEZIONE MULTIPLA: ogni `create()` prende l'indice
        // `-iCreatedContexts` e si mette DAVANTI ai precedenti, quindi un `forEach` in avanti su
        // [A,B,C] renderebbe C',B',A'. E' lo stesso fatto che `_materializeOpTypeFilterRows`
        // dichiara dal verso opposto. Si itera la selezione a rovescio; `getSelectedContexts()` la
        // consegna nell'ordine dell'AGGREGAZIONE, cioe' quello che si vede a schermo.
        //
        // E il default va lasciato anche dov'e' obbligato: sul binding relativo delle condizioni
        // (`groupFieldsTable`, senza `$count`) `bAtEnd: true` lancerebbe. Attenzione al terzo
        // effetto, che vale per l'auto-assegnazione: `bFirstCreateAtEnd` e' appiccicoso PER
        // BINDING — «Cannot create at the start after creation at end» — quindi un
        // `create(..., true, true)` aggiunto domani su QUESTA tabella romperebbe la copia.
        //
        // Perimetro: grep -rn "ROW-COPY"
        // ============================================================

        /**
         * Copia le righe selezionate dell'auto-assegnazione.
         *
         * La copia e' un DOPPIONE per costruzione — la chiave e' (Plant, Material, ComponentGroup) —
         * e a rifiutarla sara' la guardia [AA-DUPLICATE], che blocca l'INTERA scheda e non la sola
         * riga. Quindi lo si dice qui, dove la correzione va fatta, invece di lasciarlo scoprire
         * premendo Salva: la guardia si rilegge dopo le copie e il messaggio nomina le coppie.
         */
        onCopyAutoAssign() {
            const oTable = this._getAutoAssignTable();
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(oBundle.getText("aaSelectRowToCopy"));
                return;
            }

            const oBinding = oTable.getBinding("items");
            const sPlant = this._getPlantCode();
            // A ROVESCIO: vedi il blocco [ROW-COPY] qui sopra.
            aContexts.slice().reverse().forEach((oCtx) => {
                const oData = CopyRows.autoAssignRow(oCtx.getObject(), sPlant);
                // Un contesto non ancora caricato non e' una riga: copiarlo darebbe una riga vuota
                // che sembra un errore di chi l'ha compilata.
                if (oData) { RowCancel.watchCreate(oBinding.create(oData)); }
            });
            oTable.removeSelections(true);

            const aDuplicates = AutoAssignDuplicates.findDuplicates(this._getAutoAssignRows());
            if (aDuplicates.length) {
                MessageToast.show(oBundle.getText("aaCopyEditPair",
                    [AutoAssignDuplicates.describe(aDuplicates)]));
            }
        },

        onDeleteAutoAssign() {
            const oTable = this._getAutoAssignTable();
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("aaSelectRowToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(AUTO_ASSIGN_GROUP)));
            oTable.removeSelections(true);
        },

        /**
         * [AA-DUPLICATE] Le righe attualmente in tabella, come oggetti semplici.
         *
         * Comprende i contesti TRANSIENTI creati da `onAddAutoAssign` e non ancora inviati: sono
         * proprio quelli che il controllo del server non riesce a confrontare fra loro.
         *
         * @returns {Array<Object>} righe con Plant, Material, ComponentGroup
         */
        _getAutoAssignRows() {
            const oBinding = this._getAutoAssignTable().getBinding("items");
            if (!oBinding || typeof oBinding.getAllCurrentContexts !== "function") { return []; }
            return oBinding.getAllCurrentContexts().map((oCtx) => oCtx.getObject() || {});
        },

        onSaveAutoAssign() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            // [AA-DUPLICATE] La guardia va PRIMA di submitBatch, e non e' un doppione del controllo
            // del server: quel controllo NON PUO' vedere due righe dello stesso change set, perche'
            // CAP ne lancia le sottorichieste in parallelo (`SELECT #1 → SELECT #2 → INSERT #1 →
            // INSERT #2`). Senza questa riga la coppia ripetuta arrivava al vincolo di HANA, e
            // siccome un salvataggio rifiutato lascia le modifiche PENDENTI, ogni Salva successivo
            // ripeteva lo stesso errore.
            const aDuplicates = AutoAssignDuplicates.findDuplicates(this._getAutoAssignRows());
            if (aDuplicates.length) {
                MessageBox.error(oBundle.getText("aaDuplicatePair", [AutoAssignDuplicates.describe(aDuplicates)]), {
                    title: oBundle.getText("saveRejectedTitle")
                });
                return;
            }

            // Il Salva si spegne finche' il batch e' in volo. Due click producono due `$batch`
            // CONCORRENTI, cioe' due transazioni che non si vedono: e' la stessa violazione, per la
            // strada che la guardia qui sopra non copre.
            this._setAutoAssignBusy(true);
            oModel.submitBatch(AUTO_ASSIGN_GROUP).then(() => {
                if (oModel.hasPendingChanges(AUTO_ASSIGN_GROUP)) {
                    // Server rejected part of the batch (e.g. validation/uniqueness); errors are
                    // surfaced by the model's message handling. Leave changes for correction.
                    this._reportSaveRejected(oBundle);
                    return;
                }
                MessageToast.show(oBundle.getText("aaSaveSuccess"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("aaSaveError", [err && err.message ? err.message : ""]));
            }).finally(() => {
                this._setAutoAssignBusy(false);
                this._markUnsavedRows();   // [ROW-UNSAVED] vale sul riuscito E sul rifiutato
            });
        },

        /**
         * Accende e spegne il pulsante Salva dell'auto-assegnazione.
         *
         * `byId` puo' non trovare il pulsante se il fragment non e' ancora reso: si esce in
         * silenzio invece di lanciare, perche' un errore qui nasconderebbe l'esito del salvataggio,
         * che e' l'informazione che conta.
         */
        _setAutoAssignBusy(bBusy) {
            const oBtn = this.byId("autoAssignSaveBtn");
            if (oBtn) { oBtn.setEnabled(!bBusy); }
        },

        onCancelAutoAssign() {
            this.getView().getModel("catalog").resetChanges(AUTO_ASSIGN_GROUP);
            this._markUnsavedRows();   // [ROW-UNSAVED]
        },

        // ----------------------------------------------------------------
        // [W1-03] Operazioni di ricevimento (BBP §7.3.4): unita' di misura -> operazione Plex.
        // Stessa meccanica dell'auto-assegnazione qui sopra — tabella piatta sul modello
        // 'catalog' con update group proprio — con UNA differenza che conta: qui si salva
        // l'ID dell'operazione, non il codice, perche' e' l'id che il POST verso Plex vuole.
        // ----------------------------------------------------------------

        _getRecvOpTable() {
            return this.byId("recvOpTable");
        },

        _applyRecvOpPlantFilter() {
            const oTable = this._getRecvOpTable();
            const oBinding = oTable && oTable.getBinding("items");
            if (oBinding) {
                oBinding.filter(new Filter("Plant", FilterOperator.EQ, this._getPlantCode()));
                // [PLEX-OP-TYPE] Una volta sola: il filtro si riapplica a ogni apertura della
                // schermata, e riagganciare l'handler a ogni giro accumulerebbe ascoltatori.
                if (!this._bRecvOpGapHooked) {
                    oBinding.attachDataReceived(this._refreshRecvOpGap, this);
                    this._bRecvOpGapHooked = true;
                }
            }
        },

        /**
         * [PLEX-OP-TYPE] Il tipo dell'operazione di una riga, per la colonna in sola lettura.
         *
         * Dalla feature 0024 (DEC-84) il tipo non si digita: e' quello che il catalogo Plex dichiara
         * per l'operazione scelta. Qui si LEGGE dal modello 'plexOps', quindi la colonna mostra
         * sempre la verita' del tenant e non una copia salvata mesi prima.
         *
         * `sLoadedAt` non si usa nel corpo ed e' obbligatorio: e' la seconda `part` che fa
         * rivalutare il formatter quando l'elenco arriva DOPO il rendering della tabella. Senza,
         * la colonna resta vuota fino al primo cambio di riga.
         */
        formatRecvOpType(sOperationId, sLoadedAt) {
            const oOps = this.getView().getModel("plexOps");
            if (!oOps || !sLoadedAt) return "";
            const sId = String(sOperationId || "").toLowerCase();
            if (!sId) return "";
            const oTypes = oOps.getProperty("/typeById") || {};
            if (!Object.prototype.hasOwnProperty.call(oTypes, sId)) {
                // L'operazione non e' in nessuno dei due elenchi: o il filtro la esclude, o non
                // esiste piu' sul tenant. Il MessageStrip lo spiega; qui basta non mentire.
                return this._i18n().getText("roOpTypeUnknown");
            }
            return oTypes[sId] || "";
        },

        // [PLEX-OP-TYPE] Che cosa c'e' da dichiarare sulle righe di ricevimento di questo plant?
        //
        // La domanda e' cambiata con la feature 0024 e la risposta ha tre rami, con rimedi diversi:
        // il catalogo Plex non e' leggibile (guasto o connessione), l'operazione scelta non ha un
        // tipo sul tenant (dato da sistemare su Plex), oppure l'operazione non compare nell'elenco
        // filtrato (filtro troppo stretto, o operazione rimossa da Plex). Prima il ramo era uno solo
        // — «non l'hai digitato» — e ora quel ramo non esiste piu'.
        //
        // Le righe disattivate non partecipano: non vengono usate.
        _refreshRecvOpGap() {
            const oRecvModel = this.getView().getModel("recvOp");
            const oOps = this.getView().getModel("plexOps");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const clear = () => {
                oRecvModel.setProperty("/hasMissingOpType", false);
                oRecvModel.setProperty("/opTypeGapText", "");
            };

            const oTable = this._getRecvOpTable();
            const oBinding = oTable && oTable.getBinding("items");
            const aItems = (oBinding && oBinding.getCurrentContexts()) || [];
            // Stessa regola di _refreshPlexPartCodesState: una posizione non ancora caricata non e'
            // una riga. Qui il falso sarebbe al contrario — un contesto `undefined` passerebbe per
            // «riga senza tipo» — quindi finche' la lettura non ha risposto non si dichiara niente.
            if (!oBinding || aItems.some((oCtx) => !oCtx)) return clear();
            // Nemmeno l'elenco delle operazioni e' arrivato: senza di quello non si sa NIENTE sui
            // tipi, e un avviso qui sarebbe un'invenzione.
            if (!oOps || !oOps.getProperty("/loadedAt")) return clear();

            const oRecv = oOps.getProperty("/recv") || {};
            if (oRecv.readOk === false) {
                oRecvModel.setProperty("/hasMissingOpType", true);
                oRecvModel.setProperty("/opTypeGapText",
                    oBundle.getText("roOpTypeCatalogUnreadable", [oRecv.message || ""]));
                return;
            }

            const oTypes = oOps.getProperty("/typeById") || {};
            const aNoType = [];      // c'e' nell'elenco, ma il tenant non le da' un tipo
            const aNotListed = [];   // non c'e' nell'elenco: filtro, o rimossa da Plex
            aItems.forEach((oCtx) => {
                const oRow = oCtx.getObject() || {};
                if (oRow.IsActive === false) return;
                const sId = String(oRow.PlexOperationId || "").toLowerCase();
                if (!sId) return;    // riga incompleta: la rifiuta la validazione, non questo avviso
                const sLabel = oRow.PlexOperationCode || oRow.BaseUnit || sId;
                if (!Object.prototype.hasOwnProperty.call(oTypes, sId)) aNotListed.push(sLabel);
                else if (!oTypes[sId]) aNoType.push(sLabel);
            });

            if (!aNoType.length && !aNotListed.length) return clear();
            // I due rami si dichiarano SEPARATI anche quando capitano insieme: hanno rimedi opposti,
            // e un messaggio unico li renderebbe indistinguibili — che e' il difetto che questo
            // avviso esiste per evitare.
            const aParts = [];
            if (aNoType.length) aParts.push(oBundle.getText("roOpTypeNoneOnPlex", [aNoType.join(", ")]));
            if (aNotListed.length) aParts.push(oBundle.getText("roOpTypeNotListed", [aNotListed.join(", ")]));
            oRecvModel.setProperty("/hasMissingOpType", true);
            oRecvModel.setProperty("/opTypeGapText", aParts.join(" "));
        },

        // Denormalizza codice e nome accanto all'id: l'id da solo e' un UUID, e una riga
        // salvata che mostra solo un UUID non e' leggibile da nessuno.
        //
        // [PLEX-OP-TYPE] Il TIPO non si scrive: non e' una colonna di questa tabella dalla feature
        // 0024 (DEC-84). La colonna a schermo lo legge dal catalogo (formatRecvOpType), quindi non
        // c'e' nessuna copia da mantenere allineata — e nessun modo di salvare un nome che il tenant
        // non ha.
        onRecvOpOperationChange(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            const oCtx = oEvent.getSource().getBindingContext("catalog");
            if (!oCtx) {
                return;
            }
            const oData = oItem ? oItem.getBindingContext("plexOps").getObject() : null;
            oCtx.setProperty("PlexOperationCode", (oData && oData.code) || "");
            oCtx.setProperty("PlexOperationName", (oData && oData.name) || "");
            // L'avviso si rinfresca subito: scegliendo un'operazione senza tipo, o dopo aver
            // corretto una riga, la schermata non deve restare su cio' che diceva prima.
            this._refreshRecvOpGap();
        },

        // Normalizza l'unita' di misura mentre si digita. Il server fa lo stesso, ma non puo'
        // salvare un valore con spazi: String(3) lo verifica la validazione di tipo di CAP, che
        // gira PRIMA di ogni before handler (DEC-40), quindi " kg " tornerebbe come errore
        // tecnico invece che normalizzato.
        onRecvOpUomChange(oEvent) {
            const oInput = oEvent.getSource();
            const sValue = (oEvent.getParameter("value") || "").trim().toUpperCase();
            oInput.setValue(sValue);
            const oCtx = oInput.getBindingContext("catalog");
            if (oCtx) {
                oCtx.setProperty("BaseUnit", sValue);
            }
        },

        onAddRecvOp() {
            const oBinding = this._getRecvOpTable().getBinding("items");
            RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                BaseUnit: "",
                PlexOperationId: "",
                PlexOperationCode: "",
                PlexOperationName: "",
                OperationNumber: 10,
                // [PLEX-OP-TYPE] Nessun tipo da inizializzare: dalla feature 0024 (DEC-84) non e'
                // un campo di questa tabella. Lo dichiara il catalogo Plex dell'operazione che si
                // scegliera' nella tendina, e la colonna a schermo lo mostra in sola lettura.
                Shippable: false,
                IsActive: true
            }));
        },

        onDeleteRecvOp() {
            const oTable = this._getRecvOpTable();
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("roSelectRowToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(RECV_OP_GROUP)));
            oTable.removeSelections(true);
        },

        onSaveRecvOp() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(RECV_OP_GROUP).then(() => {
                if (oModel.hasPendingChanges(RECV_OP_GROUP)) {
                    // Il server ha rifiutato parte del batch (obbligatorieta' o unicita'): gli
                    // errori li espone il message handling del modello, le modifiche restano
                    // pendenti per la correzione.
                    this._reportSaveRejected(oBundle);
                    return;
                }
                // [PLEX-OP-TYPE] Il salvataggio non ricarica la lista: senza questo l'avviso
                // resterebbe quello di prima della correzione.
                this._refreshRecvOpGap();
                MessageToast.show(oBundle.getText("roSaveSuccess"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("roSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelRecvOp() {
            this.getView().getModel("catalog").resetChanges(RECV_OP_GROUP);
        },

        // ----------------------------------------------------------------
        // [PLEX-PART-CODES] Codici del tenant Plex (feature 0022, DEC-65).
        //
        // E' l'UNICO punto dell'applicazione in cui una chiave numerica di Plex si vede e si
        // digita. Ogni altra schermata mostra l'etichetta: la classe su «Categorie materiali»,
        // lo stato per nome. Se un codice comparisse altrove sarebbe un difetto da correggere
        // la', non qui.
        //
        // Due tabelle, un solo update group e un solo Salva: sono la stessa configurazione.
        // ----------------------------------------------------------------

        _getPlexPartTypeCodeTable() {
            return this.byId("plexPartTypeCodeTable");
        },

        _getPlexPartStatusTable() {
            return this.byId("plexPartStatusTable");
        },

        _applyPlexPartCodesPlantFilter() {
            const oFilter = new Filter("Plant", FilterOperator.EQ, this._getPlantCode());
            [this._getPlexPartTypeCodeTable(), this._getPlexPartStatusTable()].forEach((oTable) => {
                const oBinding = oTable && oTable.getBinding("items");
                if (oBinding) {
                    oBinding.filter(oFilter);
                }
            });
            // L'avviso sulle tipologie scoperte si ricalcola quando le righe arrivano: prima di
            // allora la tabella e' vuota e direbbe che manca tutto.
            //
            // detach PRIMA di attach: questa funzione gira a ogni caricamento di un plant, e senza
            // il detach i gestori si accumulerebbero uno per navigazione — l'avviso verrebbe
            // ricalcolato N volte, con N che cresce finche' la pagina resta aperta.
            const oTypeBinding = this._getPlexPartTypeCodeTable() && this._getPlexPartTypeCodeTable().getBinding("items");
            if (oTypeBinding) {
                oTypeBinding.detachDataReceived(this._refreshPlexPartCodesState, this);
                oTypeBinding.attachDataReceived(this._refreshPlexPartCodesState, this);
            }
            this._refreshPlexPartCodesState();
        },

        /**
         * Le TIPOLOGIE Plex per la tendina, dedotte dalla value help delle classi.
         *
         * La tendina porta i PlexValue e non i PartType: le classi sono cinque, le tipologie
         * quattro, perche' un semilavorato esterno e' un componente per Plex e lo dice gia' il
         * seed (DEC-62). Configurare un codice per la classe darebbe due risposte alla stessa
         * domanda.
         *
         * [PLEX-TYPE-LABEL] L'etichetta e' localizzata, la CHIAVE resta il `PlexValue` grezzo.
         * Il nome che il tenant Plex usa non e' questa colonna: e' quella accanto, «Valore
         * mandato a Plex», che e' precisamente cio' che questa scheda serve a dichiarare. Qui si
         * sceglie la tipologia che MARS conosce, e va letta nella lingua di chi configura —
         * coerente con DEC-65, dove l'utente legge «Produzione» e non `6387`. Chi rimette il
         * `PlexValue` come testo riporta la tendina in inglese: e' il difetto, non la scelta.
         *
         * Tradotte, le quattro voci non sono piu' in ordine di chiave: si riordinano per
         * etichetta con `localeCompare`, perche' l'ordine che l'utente si aspetta e' quello
         * della lingua che sta leggendo.
         */
        _loadPlexTypeValues() {
            const oModel = this.getView().getModel("catalog");
            if (!oModel) {
                return;
            }
            const oState = this._getPlexPartCodesState();
            oModel.bindList("/ZPlexPartTypeVH").requestContexts(0, 100).then((aContexts) => {
                const mSeen = new Map();
                aContexts.forEach((oCtx) => {
                    const oRow = oCtx.getObject();
                    const sValue = ((oRow && oRow.PlexValue) || "").trim();
                    if (sValue && !mSeen.has(sValue)) {
                        mSeen.set(sValue, { key: sValue, text: this._plexPartTypeLabel(sValue, sValue) });
                    }
                });
                oState.setProperty("/typeValues", Array.from(mSeen.values())
                    .sort((a, b) => a.text.localeCompare(b.text)));
                this._refreshPlexPartCodesState();
            }).catch((err) => {
                // Fail-open, come ogni altro consumatore di questa value help: senza tendina la
                // scheda resta usabile e il server ricontrolla comunque cosa e' stato scritto.
                console.warn(">>> [0022] lettura delle tipologie Plex non riuscita: la tendina resta " +
                    "vuota, il server ricontrolla comunque cio' che viene scritto.", err);
            });
        },

        _getPlexPartCodesState() {
            let oState = this.getView().getModel("ppcState");
            if (!oState) {
                oState = new JSONModel({
                    typeValues: [],
                    hasMissingCodes: false,
                    missingCodesText: "",
                    hasStatusOverride: false
                });
                this.getView().setModel(oState, "ppcState");
            }
            return oState;
        },

        /**
         * Ricalcola i due avvisi della scheda.
         *
         * Il primo: quali tipologie della tendina non hanno ancora un codice ATTIVO. Serve
         * perche' la lacuna e' invisibile dall'esito di un invio — senza codice la part esce
         * lo stesso, con la stringa — e nessuno se ne accorge finche' non guarda in Plex.
         *
         * Il secondo: se il plant ha una riga di mapping esplicito su `status`, che vince su
         * quello configurato qui e viaggia anche in aggiornamento (0004 RB-17).
         */
        _refreshPlexPartCodesState() {
            const oState = this._getPlexPartCodesState();
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const aTypeValues = oState.getProperty("/typeValues") || [];
            const oTable = this._getPlexPartTypeCodeTable();
            const oBinding = oTable && oTable.getBinding("items");
            const aContexts = (oBinding && oBinding.getCurrentContexts()) || [];

            // getCurrentContexts() torna un array lungo come l'ultima richiesta, con `undefined`
            // nelle posizioni NON ANCORA CARICATE — e questa funzione e' chiamata anche subito
            // dopo filter(), con la lettura in volo. Alla PRIMA apertura di un plant le posizioni
            // sono tutte `undefined`: dereferenziarle lanciava un TypeError che il gestore di
            // rigetto di _onPlantMatched mostrava come «non hai i permessi», buttando fuori dalla
            // schermata un utente che i permessi ce li aveva (e portandosi dietro le tre letture
            // che vengono dopo, operazioni Plex comprese).
            //
            // Finche' la lettura non ha risposto non si afferma NIENTE: stato inerte, come il
            // `bUnknown` degli altri blocchi di questa schermata. Il ricalcolo vero arriva dal
            // dataReceived agganciato in _applyPlexPartCodesPlantFilter. Non un filter(Boolean):
            // con `typeValues` gia' popolato (riapertura, cambio plant) i contesti non caricati
            // conterebbero come «tipologia senza codice» e l'avviso lampeggerebbe falso.
            if (!oBinding || aContexts.some((oCtx) => !oCtx)) {
                oState.setProperty("/hasMissingCodes", false);
                oState.setProperty("/missingCodesText", "");
                return;
            }

            const oCovered = new Set();
            aContexts.forEach((oCtx) => {
                const oRow = oCtx.getObject();
                if (oRow && oRow.IsActive && String(oRow.PlexTypeCode || "").trim()) {
                    oCovered.add(String(oRow.PlexTypeValue || "").trim());
                }
            });

            // Il confronto e' sul CODICE, l'avviso nomina l'ETICHETTA: prende la stessa voce che
            // la tendina qui sopra mostra, cosi' i due non possono divergere e la frase italiana
            // non si porta dietro nomi inglesi.
            const aMissing = aTypeValues.filter((o) => !oCovered.has(o.key)).map((o) => o.text);
            oState.setProperty("/hasMissingCodes", aMissing.length > 0);
            oState.setProperty("/missingCodesText",
                aMissing.length ? oBundle.getText("ppcMissingCodesWarning", [aMissing.join(", ")]) : "");
        },

        /**
         * C'e' un mapping esplicito su `status` per questo plant?
         *
         * Lettura sul modello 'fieldmap', lo stesso della scheda «Plex Part Mapping»: nessuna
         * dataSource nuova. Fail-open — un errore qui toglie solo un avviso.
         */
        _loadPlexStatusOverride() {
            const oModel = this.getView().getModel("fieldmap");
            if (!oModel) {
                return;
            }
            const oState = this._getPlexPartCodesState();
            oModel.bindList("/ZPlexFieldMap", null, null, [
                new Filter("Plant", FilterOperator.EQ, this._getPlantCode()),
                new Filter("PlexField", FilterOperator.EQ, "status")
            ]).requestContexts(0, 1).then((aContexts) => {
                oState.setProperty("/hasStatusOverride", aContexts.length > 0);
            }).catch((err) => {
                console.warn(">>> [0022] verifica del mapping esplicito su `status` non riuscita " +
                    "per il plant " + this._getPlantCode() + ": l'avviso di override non compare.", err);
            });
        },

        // [PLEX-VALUE-PROBE] Taglia alla lunghezza della colonna mentre si digita, e NIENTE ALTRO.
        //
        // Prima qui c'era `.replace(/[^0-9]/g, "")`, perche' si credeva che Plex volesse la chiave
        // numerica. Plex ha rifiutato la chiave (`400 FIELD_REFERENCE_NOT_FOUND` su `Type: "34670"`)
        // e vuole quasi certamente il NOME della riga di setup: quel filtro cancellava «Materia
        // prima» lettera per lettera mentre l'utente la scriveva.
        //
        // Il taglio a 50 resta perche' e' l'unica difesa utile: la validazione di tipo di CAP gira
        // nella fase _initial, PRIMA di ogni before handler, quindi un valore piu' lungo della
        // colonna tornerebbe come errore tecnico che nessun handler puo' riscrivere (DEC-40).
        onPlexCodeLiveChange(oEvent) {
            const oInput = oEvent.getSource();
            const sValue = (oEvent.getParameter("value") || "").substring(0, 50);
            if (sValue !== oEvent.getParameter("value")) {
                oInput.setValue(sValue);
            }
            const oCtx = oInput.getBindingContext("catalog");
            if (oCtx) {
                const sProp = oInput.getBindingPath("value").replace(/^.*\//, "");
                oCtx.setProperty(sProp, sValue);
            }
        },

        onAddPlexPartTypeCode() {
            const oBinding = this._getPlexPartTypeCodeTable().getBinding("items");
            RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                PlexTypeValue: "",
                PlexTypeCode: "",
                IsActive: true
            }));
        },

        onDeletePlexPartTypeCode() {
            this._deletePlexPartCodeRows(this._getPlexPartTypeCodeTable());
        },

        onAddPlexPartStatus() {
            const oTable = this._getPlexPartStatusTable();
            const oBinding = oTable.getBinding("items");
            // UNA riga per plant (@assert.unique su Plant): il server rifiuterebbe la seconda,
            // ma farla creare e poi respingere e' un giro inutile che lascia una riga pendente.
            const aExisting = oBinding.getCurrentContexts() || [];
            if (aExisting.length > 0) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("ppcStatusAlreadyPresent"));
                return;
            }
            RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                PlexStatusCode: "",
                PlexStatusLabel: "",
                IsActive: true
            }));
        },

        onDeletePlexPartStatus() {
            this._deletePlexPartCodeRows(this._getPlexPartStatusTable());
        },

        _deletePlexPartCodeRows(oTable) {
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("ppcSelectRowToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(PLEX_PART_CODE_GROUP)));
            oTable.removeSelections(true);
        },

        onSavePlexPartCodes() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(PLEX_PART_CODE_GROUP).then(() => {
                if (oModel.hasPendingChanges(PLEX_PART_CODE_GROUP)) {
                    // Il server ha rifiutato parte del batch (forma del codice, tipologia
                    // sconosciuta, unicita'): gli errori li espone il message handling del
                    // modello, le modifiche restano pendenti per la correzione.
                    this._reportSaveRejected(oBundle);
                    return;
                }
                MessageToast.show(oBundle.getText("ppcSaveSuccess"));
                this._refreshPlexPartCodesState();
            }).catch((err) => {
                MessageBox.error(oBundle.getText("ppcSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelPlexPartCodes() {
            this.getView().getModel("catalog").resetChanges(PLEX_PART_CODE_GROUP);
            this._refreshPlexPartCodesState();
        },

        // Persiste il campo "Max retry attempts" (tab GlobalParams): PATCH su ZPlant
        // (modello 'catalog', update group PLANT_FIELDS_GROUP). Vuoto = nessun limite ai retry.
        onSaveMaxRetry() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(PLANT_FIELDS_GROUP).then(() => {
                if (oModel.hasPendingChanges(PLANT_FIELDS_GROUP)) {
                    return; // il modello espone eventuali errori di validazione
                }
                MessageToast.show(oBundle.getText("maxRetrySaved"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("maxRetrySaveError", [err && err.message ? err.message : ""]));
            });
        },

        // Persist the per-plant "auto-assign BOM components on Plex sync" flag (ZPlant via 'catalog').
        // NOME INGANNEVOLE: e' un campo di ZPlant, non una riga di ZCycleAutoAssignConfig — ed e'
        // proprio per questa somiglianza che condivideva il batch group della tabella.
        onSaveAutoAssignFlag() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(PLANT_FIELDS_GROUP).then(() => {
                if (oModel.hasPendingChanges(PLANT_FIELDS_GROUP)) {
                    return;
                }
                MessageToast.show(oBundle.getText("autoAssignBomSaved"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("autoAssignBomSaveError", [err && err.message ? err.message : ""]));
            });
        },

        // [MATDOC-POST] Abilitazione alla registrazione reale dei movimenti merci
        // (ZPlant.MatDocPostEnabled -> IV_TEST_RUN, in negativo). Stessa meccanica di
        // onSaveAutoAssignFlag: e' un campo dello stesso entity set (ZPlant), quindi condivide il
        // batch group PLANT_FIELDS_GROUP — che dalla [AA-DUPLICATE] non e' piu' quello della
        // tabella di auto-assegnazione.
        //
        // La conferma distingue i due stati invece di dire genericamente "salvato": SPUNTARLA
        // significa che da quel momento il plant registra documenti contabili in SAP, e chi lo fa
        // deve leggerlo mentre lo fa, non scoprirlo dopo.
        onSaveMatDocPostEnabled(oEvent) {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const bEnabled = oEvent.getParameter("selected");
            oModel.submitBatch(PLANT_FIELDS_GROUP).then(() => {
                if (oModel.hasPendingChanges(PLANT_FIELDS_GROUP)) {
                    return;
                }
                if (bEnabled) {
                    MessageBox.warning(oBundle.getText("matDocPostEnabledOn"));
                } else {
                    MessageToast.show(oBundle.getText("matDocPostEnabledOff"));
                }
            }).catch((err) => {
                MessageBox.error(oBundle.getText("matDocPostEnabledSaveError", [err && err.message ? err.message : ""]));
            });
        },

        // ---- Material search help (F4) ----

        onMaterialValueHelp(oEvent) {
            this._oActiveMaterialCtx = oEvent.getSource().getBindingContext("catalog");

            const oView = this.getView();
            const pDialog = this._pMaterialVHDialog || (this._pMaterialVHDialog = Fragment.load({
                id: oView.getId(),
                name: "avvaleplm.marsplm.sap2plex.adminconfigplant.view.fragment.MaterialValueHelp",
                controller: this
            }).then((oDialog) => {
                oView.addDependent(oDialog);
                return oDialog;
            }));

            pDialog.then((oDialog) => {
                this._filterMaterialValueHelp(oDialog, "");
                oDialog.open();
            });
        },

        _filterMaterialValueHelp(oDialog, sQuery) {
            // NOTE: the /products/Products READ handler forwards the incoming $filter to the
            // A_Product (product master) query, which has NO Plant field and exposes
            // ProductDescription only via navigation. Filtering on either returns empty.
            // So here we only search by Product (the key, valid on A_Product). Plant scoping
            // is already applied server-side by that handler. Once the handler supports a
            // proper per-plant / description filter, extend this accordingly.
            const aFilters = [];
            if (sQuery) {
                aFilters.push(new Filter("Product", FilterOperator.Contains, sQuery));
            }
            oDialog.getBinding("items").filter(aFilters);
        },

        onMaterialValueHelpSearch(oEvent) {
            const sValue = oEvent.getParameter("value") || oEvent.getParameter("newValue") || "";
            this._filterMaterialValueHelp(oEvent.getSource(), sValue);
        },

        onMaterialSelected(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            if (oItem && this._oActiveMaterialCtx) {
                const sProduct = oItem.getBindingContext("product").getProperty("Product");
                this._oActiveMaterialCtx.setProperty("Material", sProduct);
            }
            this._oActiveMaterialCtx = null;
        },

        onMaterialValueHelpClose() {
            this._oActiveMaterialCtx = null;
        },

        // ============================================================
        // OBJECT GROUPS TAB (embedded master-detail, plain OData CRUD)
        // ============================================================

        _applyObjectGroupsPlantFilter() {
            const oTable = this.byId("objectGroupsTable");
            const oBinding = oTable && oTable.getBinding("items");
            if (oBinding) {
                oBinding.filter(new Filter("Plant", FilterOperator.EQ, this._getPlantCode()));
            }
        },

        _showGroupDetail(oCtx) {
            const oDetailPage = this.byId("groupDetailPage");
            oDetailPage.setBindingContext(oCtx, "objgrp");
            this.byId("groupsNav").to(oDetailPage);
        },

        onGroupPress(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext("objgrp");
            if (oCtx) {
                this._showGroupDetail(oCtx);
            }
        },

        onGroupDetailBack() {
            this.byId("groupsNav").back();
        },

        onAddObjectGroup() {
            const oBinding = this.byId("objectGroupsTable").getBinding("items");
            const oCtx = RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                GroupId: "",
                Description: ""
            }));
            // Open the detail straight away so the user can fill in the group and its conditions
            this._showGroupDetail(oCtx);
        },

        /**
         * [ROW-COPY] Copia i gruppi selezionati — testata E condizioni — come modifiche pendenti.
         *
         * Vedi il blocco [ROW-COPY] sopra `onCopyAutoAssign` per la posizione della riga e per
         * l'iterazione a rovescio. Qui ci sono le due cose in piu' di questo livello.
         *
         * PRIMA: LA SORGENTE DEVE ESSERE FERMA. La testata la leggiamo dal contesto — cioe' cio'
         * che si vede, modifiche non salvate comprese — e le condizioni dal SERVER: su una sorgente
         * con modifiche aperte le due meta' della copia verrebbero da due momenti diversi, in
         * silenzio. Quindi una sorgente transiente (mai salvata, e le sue condizioni sul server non
         * esistono affatto) o con modifiche pendenti si RIFIUTA, nominandola. Il controllo e' per
         * CONTESTO e non sul modello: `hasPendingChanges` a livello di update group direbbe no alla
         * seconda copia di fila, perche' la prima ha gia' sporcato la scheda.
         *
         * SECONDA: UNA LETTURA FALLITA NON E' UN GRUPPO SENZA CONDIZIONI. Se la lettura non
         * risponde, o torna oltre il tetto, quel gruppo non si copia AFFATTO: la sola testata si
         * salverebbe senza un errore e sarebbe un gruppo che non aggancia niente. I gruppi non
         * copiati si nominano a schermo, e la ragione tecnica va in console col tag.
         */
        onCopyObjectGroup() {
            const oTable = this.byId("objectGroupsTable");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(oBundle.getText("ogSelectRowToCopy"));
                return;
            }

            const aDirty = [];
            const aSources = [];
            aContexts.forEach((oCtx) => {
                // `typeof` su `hasPendingChanges`: e' l'idioma di `_getAutoAssignRows` per un'API
                // che potrebbe non esserci. Se mancasse, il controllo non gira e resta quello
                // sulla riga transiente — e la misura a mano lo vede.
                const bDirty = oCtx.isTransient()
                    || (typeof oCtx.hasPendingChanges === "function" && oCtx.hasPendingChanges());
                if (bDirty) {
                    aDirty.push(oCtx.getProperty("GroupId") || "?");
                } else {
                    aSources.push(oCtx);
                }
            });
            if (aDirty.length) {
                MessageBox.warning(oBundle.getText("ogCopySourceNotSaved", [aDirty.join(", ")]));
            }
            if (!aSources.length) {
                oTable.removeSelections(true);
                return;
            }

            // Il velo sta sulla TABELLA e non sul pulsante: le letture sono in volo, e un secondo
            // click creerebbe una seconda serie di copie degli stessi gruppi.
            oTable.setBusy(true);
            const oModel = this.getView().getModel("objgrp");
            // A ROVESCIO: si crea in ordine inverso perche' `create()` mette in testa.
            const aPlan = aSources.slice().reverse().map((oCtx) => ({ source: oCtx }));
            Promise.all(aPlan.map((oPlan) => this._readGroupFields(oModel, oPlan.source).then(
                (aFields) => { oPlan.fields = aFields; },
                (oError) => { oPlan.error = oError; }
            ))).then(() => {
                const aOk = aPlan.filter((oPlan) => !oPlan.error);
                const aFailed = aPlan.filter((oPlan) => oPlan.error);
                // Cio' che e' stato creato DAVVERO, non cio' che si e' provato a creare: una riga
                // sorgente senza dati non produce una copia, e non se ne dichiara una.
                const aCreated = aOk
                    .map((oPlan) => this._createGroupCopy(oPlan))
                    .filter((oCtx) => !!oCtx);
                if (aFailed.length) {
                    const aNames = aFailed.map((oPlan) => oPlan.source.getProperty("GroupId") || "?");
                    console.warn(">>> [ROW-COPY] condizioni non lette, nessuna copia creata per "
                        + aNames.join(", "), aFailed.map((oPlan) => oPlan.error));
                    MessageBox.error(oBundle.getText("ogCopyFieldsReadFailed", [aNames.join(", ")]));
                }
                if (aCreated.length === 1) {
                    // Una copia sola: si apre il suo dettaglio, come fa «Aggiungi». Qui serve di
                    // piu' che la': il codice e' quello dell'originale e va cambiato subito. Con
                    // piu' copie non si naviga — la pagina di dettaglio e' UNA e ne mostrerebbe una
                    // arbitraria, quindi si dice quante sono e cosa cambiare.
                    this._showGroupDetail(aCreated[0]);
                } else if (aCreated.length > 1) {
                    MessageToast.show(oBundle.getText("ogCopyEditGroupId", [String(aCreated.length)]));
                }
            }).finally(() => {
                oTable.setBusy(false);
                oTable.removeSelections(true);
            });
        },

        /**
         * [ROW-COPY] Le condizioni di un gruppo, lette dal server.
         *
         * `$$ownRequest` NON e' decorativo. Col modello `autoExpandSelect` un binding relativo che
         * porti SOLO system query option non si fa una cache propria: chiede al binding padre — la
         * lista a schermo — di allargare le proprie query option. Un parametro `$$…` forza invece
         * la cache propria, cioe' una `GET ObjectGroups(<id>)/Fields` che non tocca l'elenco (che
         * porta `$count: true` e l'handler [NATURAL-ORDER], e non va disturbato per un gesto
         * occasionale). Si percorre la navigation della composizione, quindi non serve indovinare
         * il nome del campo chiave `group_ID`.
         *
         * Il `$select` e' DICHIARATO e non lasciato dedurre: questo binding non ha controlli
         * agganciati da cui `autoExpandSelect` possa ricavarlo.
         *
         * Il tetto e' un RIFIUTO e non un troncamento: vedi MAX_GROUP_FIELDS.
         *
         * @returns {Promise<Array<Object>>} le condizioni come dati iniziali della copia
         */
        _readGroupFields(oModel, oSourceCtx) {
            const oBinding = oModel.bindList("Fields", oSourceCtx, [], [], {
                $$ownRequest: true,
                $select: GROUP_FIELD_PROPS.join(",")
            });
            return oBinding.requestContexts(0, MAX_GROUP_FIELDS + 1).then((aContexts) => {
                if (aContexts.length > MAX_GROUP_FIELDS) {
                    throw new Error("piu' di " + MAX_GROUP_FIELDS + " condizioni: copia rifiutata");
                }
                return aContexts
                    .map((oCtx) => CopyRows.conditionRow(oCtx.getObject()))
                    .filter((oRow) => !!oRow);
            }).finally(() => {
                // Le righe sono gia' oggetti semplici: il binding di lettura non serve piu'.
                oBinding.destroy();
            });
        },

        /**
         * [ROW-COPY] Crea testata e condizioni di una copia, tutte TRANSIENTI, in un colpo solo.
         *
         * LE CONDIZIONI VIAGGIANO NEI DATI INIZIALI DELLA TESTATA, e non su un binding loro. E' la
         * regola che questo metodo ha gia' violato una volta, il 18/09/2026, e che SAP dichiara
         * nell'API doc di `ODataListBinding#create`:
         *
         *     Caution: Only a single list must be bound to the same collection-valued navigation
         *     property relative to a transient context. Created data cannot be shared between list
         *     bindings.
         *
         * Prima si creava un `bindList("Fields", oHeaderCtx)` su cui fare `create()` per riga. Ma
         * su quella stessa collezione insiste GIA' `groupFieldsTable`, la tabella che il dettaglio
         * mostra: aprendo la copia, il binding dichiarativo trovava righe possedute da un altro
         * binding e LANCIAVA («Cannot share created data between list bindings»,
         * `ODataListBinding#createContexts`). Il commento di allora affermava l'opposto — che i due
         * binding «vedono gli stessi figli» — ed era vero: e' proprio per questo che lancia.
         *
         * IL SINTOMO NON NOMINA LA CAUSA. L'eccezione sale dentro il giro di rendering di UI5, che
         * si interrompe a meta': la copia compariva senza condizioni e con i controlli non
         * editabili vuoti (titolo, `Plant`), «Aggiungi condizione» ripeteva l'errore, e tornando in
         * lista le spunte smettevano di rispondere. Tre sintomi lontani, una causa sola.
         *
         * PERCHE' I DATI INIZIALI FUNZIONANO: sotto un padre transiente
         * `ODataListBinding#prepareDeepCreate` «creates contexts for nested entities in the initial
         * data» — `_Cache#addTransientCollection` prende la collezione gia' presente sull'entita'
         * padre e ne fa i contesti del binding che si sta risolvendo, cioe' proprio
         * `groupFieldsTable`. Un binding solo, nessuna condivisione. Le due precondizioni ci sono:
         * `autoExpandSelect` sul modello `objgrp`, e `Fields` e' una `Composition of many`.
         *
         * SUL FILO NON CAMBIA NIENTE: le condizioni partivano gia' nel corpo della POST della loro
         * testata (`_Cache#create` clona i dati iniziali nel post body). Cambia solo chi possiede
         * le righe nel browser.
         *
         * E QUI NON SI ROVESCIA. L'iterazione a rovescio serve dove ogni `create()` si mette in
         * testa alla collezione; qui non si chiama `create()` per riga — l'array viene mappato nel
         * suo ordine — quindi le condizioni della copia si leggono nell'ordine dell'originale.
         *
         * @returns {Object|null} il contesto della testata creata, o `null` se la riga sorgente non
         *   portava dati — la' non si crea niente, cosi' nessuno dichiara una copia che non c'e'.
         */
        _createGroupCopy(oPlan) {
            const oData = CopyRows.objectGroupRow(oPlan.source.getObject(), this._getPlantCode());
            if (!oData) { return null; }

            // Solo se ce ne sono: su un gruppo senza condizioni il corpo della POST resta quello di
            // sempre, senza la navigation property. Un `Fields: []` sarebbe probabilmente
            // equivalente per CAP, ma «probabilmente» non e' una misura, e qui non serve saperlo.
            if (oPlan.fields.length) { oData.Fields = oPlan.fields; }
            return RowCancel.watchCreate(this.byId("objectGroupsTable").getBinding("items").create(oData));
        },

        onDeleteObjectGroup() {
            const oTable = this.byId("objectGroupsTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("ogSelectRowToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(OBJ_GROUP_GROUP)));
            oTable.removeSelections(true);
        },

        onAddGroupField() {
            const oBinding = this.byId("groupFieldsTable").getBinding("items");
            if (oBinding) {
                RowCancel.watchCreate(oBinding.create({ ConditionType: "FIELD", FieldName: "", FieldValue: "", Class: "", Characteristic: "", CharcValue: "" }));
            }
        },

        /**
         * [ROW-COPY] Copia le condizioni selezionate dentro il gruppo aperto.
         *
         * Il caso semplice, e per due ragioni. Non si legge NIENTE: le condizioni del gruppo aperto
         * sono gia' in memoria — le tiene il binding della tabella — e la copia e' un `create()`
         * sullo STESSO binding, cioe' la strada di «Aggiungi condizione». E non c'e' nessun vincolo
         * di unicita' su queste righe, quindi la copia e' salvabile com'e'.
         *
         * Vale anche con la testata TRANSIENTE: la condizione copiata entra nel corpo della sua
         * POST. Qui `bAtEnd` non e' una scelta ma un obbligo — questo binding e' relativo e non
         * porta `$count`, quindi `bAtEnd: true` lancerebbe.
         */
        onCopyGroupField() {
            const oTable = this.byId("groupFieldsTable");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(oBundle.getText("ogSelectFieldToCopy"));
                return;
            }
            const oBinding = oTable.getBinding("items");
            // A ROVESCIO: vedi il blocco [ROW-COPY] sopra `onCopyAutoAssign`.
            aContexts.slice().reverse().forEach((oCtx) => {
                const oData = CopyRows.conditionRow(oCtx.getObject());
                if (oData) { RowCancel.watchCreate(oBinding.create(oData)); }
            });
            oTable.removeSelections(true);
        },

        // Switching a condition's type clears the fields of the other mode, so a
        // saved row never carries stale values from the hidden inputs.
        onConditionTypeChange(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext("objgrp");
            if (!oCtx) return;
            if (oCtx.getProperty("ConditionType") === "CLASS") {
                oCtx.setProperty("FieldName", "");
                oCtx.setProperty("FieldValue", "");
            } else {
                oCtx.setProperty("Class", "");
                oCtx.setProperty("Characteristic", "");
                oCtx.setProperty("CharcValue", "");
            }
        },

        onDeleteGroupField() {
            const oTable = this.byId("groupFieldsTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("ogSelectFieldToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(OBJ_GROUP_GROUP)));
            oTable.removeSelections(true);
        },

        onSaveObjectGroups() {
            const oModel = this.getView().getModel("objgrp");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(OBJ_GROUP_GROUP).then(() => {
                if (oModel.hasPendingChanges(OBJ_GROUP_GROUP)) {
                    // Server rejected part of the batch (validation/uniqueness); errors surface
                    // via the model's message handling. Leave changes for correction.
                    // [ROW-COPY] Le testate transienti sopravvivono per essere corrette, e le loro
                    // condizioni con loro: stanno nella voce di cache della testata, non su un
                    // binding a parte che qualcuno debba tenere vivo.
                    this._reportSaveRejected(oBundle);
                    return;
                }
                MessageToast.show(oBundle.getText("ogSaveSuccess"));
                // [AA-GROUP-VH] Da questo batch escono insieme creazioni, rinomine e cancellazioni
                // di gruppi, quindi e' l'unico punto da cui la tendina dell'assegnazione
                // automatica puo' accorgersene. Forzata: la memoria per plant direbbe «gia'
                // caricato», e un gruppo appena creato non comparirebbe fino al cambio di plant.
                this._loadObjectGroupVH(true);
            }).catch((err) => {
                MessageBox.error(oBundle.getText("ogSaveError", [err && err.message ? err.message : ""]));
            }).finally(() => {
                this._markUnsavedRows();   // [ROW-UNSAVED] vale sul riuscito E sul rifiutato
            });
        },

        onCancelObjectGroups() {
            this.getView().getModel("objgrp").resetChanges(OBJ_GROUP_GROUP);
            this._markUnsavedRows();   // [ROW-UNSAVED]
            // A cancelled brand-new group is transient and disappears; return to the list
            const oNav = this.byId("groupsNav");
            if (oNav.getCurrentPage() === this.byId("groupDetailPage")) {
                oNav.back();
            }
        },

        // ============================================================
        // PLEX PART MAPPING TAB (per-plant, generic rule engine)
        // 3-level master-detail: field map -> rules -> conditions.
        // ============================================================

        _applyPlexFieldMapPlantFilter() {
            const oTable = this.byId("plexFieldMapTable");
            const oBinding = oTable && oTable.getBinding("items");
            if (oBinding) {
                oBinding.filter(new Filter("Plant", FilterOperator.EQ, this._getPlantCode()));
            }
        },

        // List-row summary of how a Plex field is filled (fixed value / SAP field / N rules).
        formatMappingSummary(sKind, sFixedValue, sSapField) {
            const oBundle = this._i18n();
            switch (sKind) {
                case "FIXED":
                    return sFixedValue || "";
                case "SAP_FIELD":
                    return sSapField || "";
                case "RULE":
                    return oBundle.getText("pfmSummaryRules");
                default:
                    return "";
            }
        },

        _showPlexFieldMapDetail(oCtx) {
            const oDetailPage = this.byId("plexMapDetailPage");
            oDetailPage.setBindingContext(oCtx, "fieldmap");
            this.byId("plexMapNav").to(oDetailPage);
        },

        onPlexFieldMapPress(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext("fieldmap");
            if (oCtx) {
                this._showPlexFieldMapDetail(oCtx);
            }
        },

        onPlexFieldMapBack() {
            this.byId("plexMapNav").back();
        },

        onAddPlexFieldMap() {
            const oBinding = this.byId("plexFieldMapTable").getBinding("items");
            const oCtx = RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                PlexField: "",
                MappingKind: "SAP_FIELD",
                FixedValue: "",
                SapField: ""
            }));
            this._showPlexFieldMapDetail(oCtx);
        },

        onDeletePlexFieldMap() {
            const oTable = this.byId("plexFieldMapTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("pfmSelectRowToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(PLEX_MAP_GROUP)));
            oTable.removeSelections(true);
        },

        onAddPlexMapRule() {
            const oBinding = this.byId("plexMapRulesTable").getBinding("items");
            if (oBinding) {
                RowCancel.watchCreate(oBinding.create({ Sequence: 10, OutputValue: "" }));
            }
        },

        onDeletePlexMapRule() {
            const oTable = this.byId("plexMapRulesTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("pfmSelectRuleToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(PLEX_MAP_GROUP)));
            oTable.removeSelections(true);
        },

        _showRuleDetail(oCtx) {
            const oRulePage = this.byId("plexMapRulePage");
            oRulePage.setBindingContext(oCtx, "fieldmap");
            this.byId("plexMapNav").to(oRulePage);
        },

        onRulePress(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext("fieldmap");
            if (oCtx) {
                this._showRuleDetail(oCtx);
            }
        },

        onRuleDetailBack() {
            this.byId("plexMapNav").back();
        },

        onAddPlexMapCondition() {
            const oBinding = this.byId("plexMapConditionsTable").getBinding("items");
            if (oBinding) {
                RowCancel.watchCreate(oBinding.create({ SapField: "", Operator: "EQ", Value: "" }));
            }
        },

        onDeletePlexMapCondition() {
            const oTable = this.byId("plexMapConditionsTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("pfmSelectCondToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(PLEX_MAP_GROUP)));
            oTable.removeSelections(true);
        },

        onSavePlexFieldMap() {
            const oModel = this.getView().getModel("fieldmap");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(PLEX_MAP_GROUP).then(() => {
                if (oModel.hasPendingChanges(PLEX_MAP_GROUP)) {
                    // Server rejected part of the batch (validation/uniqueness); errors surface
                    // via the model's message handling. Leave changes for correction.
                    this._reportSaveRejected(oBundle);
                    return;
                }
                MessageToast.show(oBundle.getText("pfmSaveSuccess"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("pfmSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelPlexFieldMap() {
            this.getView().getModel("fieldmap").resetChanges(PLEX_MAP_GROUP);
            // A cancelled brand-new row is transient and disappears; return to the list
            const oNav = this.byId("plexMapNav");
            if (oNav.getCurrentPage() !== this.byId("plexMapListPage")) {
                oNav.back();
            }
        },

        // ============================================================
        // MATERIAL CATEGORIES TAB (per-plant visibility + Plex part type)
        // Header (ZMatCategory) -> Conditions (ZMatCategoryCond) composition,
        // served by MatCategoryService (matcategory model). Same edit pattern as
        // the Plex Part Mapping tab.
        // ============================================================
        _applyMatCategoryPlantFilter() {
            const oTable = this.byId("matCategoryTable");
            const oBinding = oTable && oTable.getBinding("items");
            if (oBinding) {
                oBinding.filter(new Filter("Plant", FilterOperator.EQ, this._getPlantCode()));
            }
            this._loadMatCategoryFieldAvailability();
        },

        // Feature 0013 / FR-18 (M-01) - sul canale Integration Suite l'area materiali non
        // riceve ProcurementSubType (Special Procurement) e ProductionSupervisor: una
        // condizione che li usa non e' valutabile, la categoria non matcha e i materiali che
        // ne dipendono escono dal perimetro (non in dashboard, non inviati a Plex). La
        // function CAP incrocia le categorie ATTIVE del plant col canale attivo: elenco vuoto
        // = nessun avviso (canale storico, o nessuna condizione dipendente).
        // Errore di lettura => nessun avviso e nessun blocco: la tab resta configurabile,
        // perche' un avviso mancante e' preferibile a un avviso falso.
        _loadMatCategoryFieldAvailability() {
            const oModel = this.getView().getModel("matCatAvail");
            oModel.setProperty("/hasFieldWarning", false);
            oModel.setProperty("/fieldWarningText", "");

            const sPlantCode = this._getPlantCode();
            if (!sPlantCode) {
                return;
            }

            // Stessa convenzione di _checkUserRole: fetch diretta su una function del service
            // V4 (nessuna dataSource nuova nel manifest).
            const sUrl = AppUrl.url("/mat-category/matCategoryFieldAvailability(Plant='") +
                encodeURIComponent(sPlantCode) + "')";
            fetch(sUrl, { headers: { "Accept": "application/json" } }).then((res) => {
                if (!res.ok) {
                    throw new Error("HTTP " + res.status);
                }
                return res.json();
            }).then((oData) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo.
                if (this._getPlantCode() !== sPlantCode) {
                    return;
                }
                const aAffected = (oData && oData.affectedCategories) || [];
                if (aAffected.length === 0) {
                    return;
                }
                oModel.setProperty("/fieldWarningText", this._buildMatCategoryFieldWarning(aAffected));
                oModel.setProperty("/hasFieldWarning", true);
            }).catch((oError) => {
                console.warn(">>> [IS-SOURCE] matCategoryFieldAvailability non disponibile per il plant " +
                    sPlantCode + ": nessun avviso mostrato.", oError);
            });
        },

        // Compone M-01 dal bundle i18n sui dati strutturati della function: numero di
        // categorie, campi non disponibili usati da quelle categorie, nomi delle categorie.
        _buildMatCategoryFieldWarning(aAffected) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const aFields = [];
            const aNames = [];
            aAffected.forEach((oCategory) => {
                if (oCategory.CategoryName) {
                    aNames.push(oCategory.CategoryName);
                }
                (oCategory.Conditions || []).forEach((sField) => {
                    if (sField && aFields.indexOf(sField) < 0) {
                        aFields.push(sField);
                    }
                });
            });
            const aArgs = [String(aAffected.length), aFields.join(", "), aNames.join(", ")];
            return oBundle.getText(
                aAffected.length === 1 ? "mcFieldAvailWarningOne" : "mcFieldAvailWarning",
                aArgs
            );
        },

        _showMatCategoryDetail(oCtx) {
            const oDetailPage = this.byId("matCatDetailPage");
            oDetailPage.setBindingContext(oCtx, "matcategory");
            this.byId("matCatNav").to(oDetailPage);
        },

        onMatCategoryPress(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext("matcategory");
            if (oCtx) {
                this._showMatCategoryDetail(oCtx);
            }
        },

        onMatCategoryBack() {
            this.byId("matCatNav").back();
        },

        onAddMatCategory() {
            const oBinding = this.byId("matCategoryTable").getBinding("items");
            const oCtx = RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                CategoryName: "",
                PlexPartType: "",
                Sequence: 10,
                IsActive: true,
                // [W1-01] Va inizializzato esplicitamente: senza la proprieta' sul contesto
                // transient lo Switch del ripiego non ha nulla su cui legare in scrittura.
                IsCatchAll: false
            }));
            this._showMatCategoryDetail(oCtx);
        },

        onDeleteMatCategory() {
            const oTable = this.byId("matCategoryTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("mcSelectRowToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(MAT_CAT_GROUP)));
            oTable.removeSelections(true);
        },

        onAddMatCategoryCond() {
            const oBinding = this.byId("matCatConditionsTable").getBinding("items");
            if (oBinding) {
                RowCancel.watchCreate(oBinding.create({ SapField: "", Operator: "EQ", Value: "" }));
            }
        },

        onDeleteMatCategoryCond() {
            const oTable = this.byId("matCatConditionsTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("mcSelectCondToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(MAT_CAT_GROUP)));
            oTable.removeSelections(true);
        },

        onSaveMatCategory() {
            const oModel = this.getView().getModel("matcategory");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(MAT_CAT_GROUP).then(() => {
                if (oModel.hasPendingChanges(MAT_CAT_GROUP)) {
                    // Server rejected part of the batch (validation/uniqueness); leave for correction.
                    this._reportSaveRejected(oBundle);
                    return;
                }
                MessageToast.show(oBundle.getText("mcSaveSuccess"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("mcSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelMatCategory() {
            this.getView().getModel("matcategory").resetChanges(MAT_CAT_GROUP);
            const oNav = this.byId("matCatNav");
            if (oNav.getCurrentPage() !== this.byId("matCatListPage")) {
                oNav.back();
            }
        },

        // ============================================================
        // [COMP-EXCL] ESCLUSIONE COMPONENTI D'ORDINE (scheda "Ordini di produzione")
        // Regola (ZOrderCompExclRule) -> condizioni (ZOrderCompExclCond), servite da
        // OrderCompExclService (modello 'compexcl'). Stesso schema di modifica delle
        // "Categorie materiali", master/detail nella stessa scheda invece che a pagine.
        // ============================================================
        _applyCompExclPlantFilter() {
            const oTable = this.byId("compExclRulesTable");
            const oBinding = oTable && oTable.getBinding("items");
            if (oBinding) {
                oBinding.filter(new Filter("Plant", FilterOperator.EQ, this._getPlantCode()));
            }
            // Cambiando plant la regola selezionata non esiste piu': la tabella delle condizioni
            // resta legata a un contesto di un altro plant se non la si stacca.
            this._bindCompExclConditions(null);
        },

        // La tabella delle condizioni ha un binding RELATIVO ('Conditions'): senza un contesto non
        // mostra niente, ed e' lo stato giusto quando nessuna regola e' selezionata.
        _bindCompExclConditions(oCtx) {
            const oCondTable = this.byId("compExclCondTable");
            if (oCondTable) {
                oCondTable.setBindingContext(oCtx || null, "compexcl");
            }
        },

        onCompExclRuleSelect(oEvent) {
            const oItem = oEvent.getParameter("listItem") || oEvent.getSource().getSelectedItem();
            this._bindCompExclConditions(oItem && oItem.getBindingContext("compexcl"));
        },

        onAddCompExclRule() {
            const oBinding = this.byId("compExclRulesTable").getBinding("items");
            if (!oBinding) {
                return;
            }
            const oCtx = RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                RuleName: "",
                Sequence: 10,
                // Nasce SPENTA: una regola senza condizioni non esclude niente, e il server
                // rifiuta di attivarla a vuoto. L'ordine di lavoro e' «creo, aggiungo i criteri,
                // accendo».
                IsActive: false
            }));
            // La riga appena creata e' transient: se e' gia' renderizzata la si seleziona, cosi'
            // la tabella delle condizioni sotto e la selezione sopra parlano della stessa regola.
            // Se non lo e' ancora si lascia la selezione com'e': il binding delle condizioni e'
            // quello che conta, e lo si imposta comunque.
            const oTable = this.byId("compExclRulesTable");
            const oItem = oTable.getItems().find(
                (oRow) => oRow.getBindingContext("compexcl") === oCtx
            );
            if (oItem) {
                oTable.setSelectedItem(oItem);
            }
            this._bindCompExclConditions(oCtx);
        },

        onDeleteCompExclRule() {
            const oTable = this.byId("compExclRulesTable");
            const oCtx = oTable.getSelectedItem() && oTable.getSelectedItem().getBindingContext("compexcl");
            if (!oCtx) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("oceSelectRowToDelete"));
                return;
            }
            RowCancel.watchDelete(oCtx.delete(COMP_EXCL_GROUP));
            oTable.removeSelections(true);
            this._bindCompExclConditions(null);
        },

        onAddCompExclCond() {
            const oCondTable = this.byId("compExclCondTable");
            const oBinding = oCondTable && oCondTable.getBinding("items");
            if (!oBinding || !oCondTable.getBindingContext("compexcl")) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("oceSelectRuleFirst"));
                return;
            }
            RowCancel.watchCreate(oBinding.create({ SapField: "", Operator: "EQ", Value: "" }));
        },

        onDeleteCompExclCond() {
            const oTable = this.byId("compExclCondTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("oceSelectCondToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(COMP_EXCL_GROUP)));
            oTable.removeSelections(true);
        },

        onSaveCompExcl() {
            const oModel = this.getView().getModel("compexcl");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(COMP_EXCL_GROUP).then(() => {
                if (oModel.hasPendingChanges(COMP_EXCL_GROUP)) {
                    // Il server ha rifiutato parte del batch (nome mancante, campo fuori catalogo,
                    // attivazione a vuoto): si lascia tutto in modifica per la correzione.
                    this._reportSaveRejected(oBundle);
                    return;
                }
                MessageToast.show(oBundle.getText("oceSaveSuccess"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("oceSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelCompExcl() {
            this.getView().getModel("compexcl").resetChanges(COMP_EXCL_GROUP);
        },

        // ============================================================
        // PLEX PART-OPERATION MAPPING TAB (per-plant, generic rule engine)
        // 3-level master-detail: field map -> rules -> conditions.
        // ============================================================

        _applyPlexOpFieldMapPlantFilter() {
            const oTable = this.byId("plexOpFieldMapTable");
            const oBinding = oTable && oTable.getBinding("items");
            if (oBinding) {
                oBinding.filter(new Filter("Plant", FilterOperator.EQ, this._getPlantCode()));
                // [PLEX-OP-TYPE] Una volta sola, come su _applyRecvOpPlantFilter.
                if (!this._bOpFieldGapHooked) {
                    oBinding.attachDataReceived(this._refreshOpFieldGap, this);
                    this._bOpFieldGapHooked = true;
                }
            }
        },

        // [PLEX-OP-TYPE] C'e' ancora una riga di mapping sul campo `type`?
        //
        // L'avviso si e' INVERTITO con la feature 0024 (DEC-84): prima denunciava l'ASSENZA di
        // quella riga — senza, ogni operazione di ciclo partiva col nome inglese di ripiego e Plex
        // rispondeva 400 FIELD_REFERENCE_NOT_FOUND — ora ne denuncia la PRESENZA, perche' il tipo lo
        // dichiara il catalogo Plex e quella riga non viene piu' letta da nessuno.
        //
        // Una riga inerte e muta e' peggio di una riga sbagliata: chi l'ha scritta continua a
        // credere di governare il valore. Il runtime la scarta (DERIVED_FIELDS), la validazione ne
        // rifiuta di nuove, e questo avviso dice di eliminare quelle vecchie.
        _refreshOpFieldGap() {
            const oTable = this.byId("plexOpFieldMapTable");
            const oBinding = oTable && oTable.getBinding("items");
            const aItems = (oBinding && oBinding.getCurrentContexts()) || [];
            // Stessa regola di _refreshPlexPartCodesState: con le righe non ancora caricate non si
            // dichiara niente, in nessuno dei due sensi.
            if (!oBinding || aItems.some((oCtx) => !oCtx)) {
                this.getView().getModel("opFieldGap").setProperty("/hasInertTypeMapping", false);
                return;
            }
            const bHasType = aItems.some((oCtx) => (oCtx.getObject() || {}).PlexField === "type");
            this.getView().getModel("opFieldGap").setProperty("/hasInertTypeMapping", bHasType);
        },

        // ============================================================
        // [PLEX-OP-TYPE-FILTER] Filtro per TIPO delle operazioni Plex (feature 0024, DEC-85).
        //
        // Due righe FISSE — ambito RECV e ambito CYCLE — e nessun Aggiungi/Elimina: gli ambiti non
        // sono una scelta, e un bottone «Aggiungi» inviterebbe a creare una terza riga con un
        // ambito inventato, che non filtrerebbe niente restando indistinguibile da una
        // configurazione corretta.
        // ============================================================

        _getOpTypeFilterTable() {
            return this.byId("opTypeFilterTable");
        },

        _applyOpTypeFilterPlantFilter() {
            const oBinding = this._getOpTypeFilterTable() && this._getOpTypeFilterTable().getBinding("items");
            if (!oBinding) return;
            oBinding.filter(new Filter("Plant", FilterOperator.EQ, this._getPlantCode()));
            // Una volta sola, come su _applyRecvOpPlantFilter: riagganciare l'handler a ogni
            // apertura accumulerebbe ascoltatori.
            if (!this._bOpTypeFilterHooked) {
                oBinding.attachDataReceived(this._materializeOpTypeFilterRows, this);
                this._bOpTypeFilterHooked = true;
            }
        },

        /**
         * Materializza le righe mancanti dei due ambiti, DOPO che la lettura ha risposto.
         *
         * Le righe create restano TRANSITORIE fino al Salva: aprire una schermata non deve scrivere
         * customizing. E si creano solo dopo `dataReceived` — crearle prima significherebbe
         * duplicare quelle che stanno arrivando, e la riga doppia la rifiuterebbe il server con un
         * messaggio che nessuno ha chiesto.
         */
        _materializeOpTypeFilterRows() {
            const oBinding = this._getOpTypeFilterTable() && this._getOpTypeFilterTable().getBinding("items");
            if (!oBinding) return;
            const aItems = oBinding.getCurrentContexts() || [];
            // Un contesto non ancora caricato non e' una riga: se ce n'e' uno, la presenza dei due
            // ambiti non e' dimostrata e creare adesso vorrebbe dire creare un doppione.
            if (aItems.some((oCtx) => !oCtx)) return;

            const aPresent = aItems.map((oCtx) => String((oCtx.getObject() || {}).Scope || "").toUpperCase());
            OP_TYPE_SCOPES.forEach((sScope) => {
                if (aPresent.indexOf(sScope) !== -1) return;
                // `bAtEnd = true`: le righe transitorie vanno IN CODA, in ordine di creazione. Col
                // default andrebbero in testa, una davanti all'altra, e le due comparirebbero
                // nell'ordine inverso — il `sorter` non riordina i contesti transitori.
                RowCancel.watchCreate(oBinding.create({
                    Plant: this._getPlantCode(),
                    Scope: sScope,
                    // Vuoto, cioe' NESSUN filtro: e' il comportamento di prima della feature, e
                    // precompilare un tipo plausibile («Ricevere») lo farebbe salvare senza che
                    // nessuno verifichi che quel nome esista sul tenant.
                    OpTypes: ""
                }, true, true));
            });
        },

        // L'etichetta dell'ambito: la colonna mostra «Filtro ricevimento» / «Filtro ciclo», non
        // RECV / CYCLE. Il valore tecnico non compare in nessuna schermata, come i codici Plex
        // ovunque tranne la scheda che li possiede (DEC-65).
        formatOpTypeScope(sScope) {
            const oBundle = this._i18n();
            switch (String(sScope || "").toUpperCase()) {
                case "RECV": return oBundle.getText("potScopeRecv");
                case "CYCLE": return oBundle.getText("potScopeCycle");
                default: return sScope || "";
            }
        },

        onSaveOpTypeFilter() {
            const oModel = this.getView().getModel("opfieldmap");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(OP_TYPE_FILTER_GROUP).then(() => {
                if (oModel.hasPendingChanges(OP_TYPE_FILTER_GROUP)) {
                    this._reportSaveRejected(oBundle);
                    return;
                }
                MessageToast.show(oBundle.getText("potSaveSuccess"));
                // Le tendine si ricaricano col filtro appena salvato: senza, la scheda direbbe una
                // cosa e le tendine ne mostrerebbero un'altra fino al prossimo ingresso.
                this._sOpsLoadedPlant = null;
                this._loadPlexOperations();
            }).catch((err) => {
                MessageBox.error(oBundle.getText("potSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelOpTypeFilter() {
            this.getView().getModel("opfieldmap").resetChanges(OP_TYPE_FILTER_GROUP);
        },

        // List-row summary of how a part-operation field is filled (fixed value / SAP field / N rules).
        formatOpMappingSummary(sKind, sFixedValue, sSapField) {
            const oBundle = this._i18n();
            switch (sKind) {
                case "FIXED":
                    return sFixedValue || "";
                case "SAP_FIELD":
                    return sSapField || "";
                case "RULE":
                    return oBundle.getText("pofSummaryRules");
                default:
                    return "";
            }
        },

        _showPlexOpFieldMapDetail(oCtx) {
            const oDetailPage = this.byId("plexOpMapDetailPage");
            oDetailPage.setBindingContext(oCtx, "opfieldmap");
            this.byId("plexOpMapNav").to(oDetailPage);
        },

        onPlexOpFieldMapPress(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext("opfieldmap");
            if (oCtx) {
                this._showPlexOpFieldMapDetail(oCtx);
            }
        },

        onPlexOpFieldMapBack() {
            this.byId("plexOpMapNav").back();
        },

        onAddPlexOpFieldMap() {
            const oBinding = this.byId("plexOpFieldMapTable").getBinding("items");
            const oCtx = RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                PlexField: "",
                MappingKind: "FIXED",
                FixedValue: "",
                SapField: ""
            }));
            this._showPlexOpFieldMapDetail(oCtx);
        },

        onDeletePlexOpFieldMap() {
            const oTable = this.byId("plexOpFieldMapTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("pofSelectRowToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(PLEX_OP_GROUP)));
            oTable.removeSelections(true);
        },

        onAddPlexOpRule() {
            const oBinding = this.byId("plexOpMapRulesTable").getBinding("items");
            if (oBinding) {
                RowCancel.watchCreate(oBinding.create({ Sequence: 10, OutputValue: "" }));
            }
        },

        onDeletePlexOpRule() {
            const oTable = this.byId("plexOpMapRulesTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("pofSelectRuleToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(PLEX_OP_GROUP)));
            oTable.removeSelections(true);
        },

        _showPlexOpRuleDetail(oCtx) {
            const oRulePage = this.byId("plexOpMapRulePage");
            oRulePage.setBindingContext(oCtx, "opfieldmap");
            this.byId("plexOpMapNav").to(oRulePage);
        },

        onPlexOpRulePress(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext("opfieldmap");
            if (oCtx) {
                this._showPlexOpRuleDetail(oCtx);
            }
        },

        onPlexOpRuleDetailBack() {
            this.byId("plexOpMapNav").back();
        },

        onAddPlexOpCondition() {
            const oBinding = this.byId("plexOpMapConditionsTable").getBinding("items");
            if (oBinding) {
                RowCancel.watchCreate(oBinding.create({ SapField: "", Operator: "EQ", Value: "" }));
            }
        },

        onDeletePlexOpCondition() {
            const oTable = this.byId("plexOpMapConditionsTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("pofSelectCondToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(PLEX_OP_GROUP)));
            oTable.removeSelections(true);
        },

        onSavePlexOpFieldMap() {
            const oModel = this.getView().getModel("opfieldmap");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            oModel.submitBatch(PLEX_OP_GROUP).then(() => {
                if (oModel.hasPendingChanges(PLEX_OP_GROUP)) {
                    // Server rejected part of the batch (validation/uniqueness); errors surface
                    // via the model's message handling. Leave changes for correction.
                    this._reportSaveRejected(oBundle);
                    return;
                }
                // [PLEX-OP-TYPE] Come su onSaveRecvOp: senza, l'avviso resterebbe quello di
                // prima della correzione.
                this._refreshOpFieldGap();
                MessageToast.show(oBundle.getText("pofSaveSuccess"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("pofSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelPlexOpFieldMap() {
            this.getView().getModel("opfieldmap").resetChanges(PLEX_OP_GROUP);
            // A cancelled brand-new row is transient and disappears; return to the list
            const oNav = this.byId("plexOpMapNav");
            if (oNav.getCurrentPage() !== this.byId("plexOpMapListPage")) {
                oNav.back();
            }
        },

        // ============================================================
        // JOB NOTIFY TAB (destinatari del recap mail, per plant e per job)
        //
        // Una tabella per job sulla STESSA collection (catalog>/ZJobNotifyRecipient), partizionate
        // per JobCode, ognuna con il PROPRIO $$updateGroupId dichiarato nel fragment:
        // submitBatch/hasPendingChanges/resetChanges sono group-scoped e MODEL-WIDE, quindi un
        // group condiviso farebbe inviare a un Save le righe delle altre quattro sezioni (in un
        // changeset atomico: una riga rifiutata rollerebbe back anche quella buona) e farebbe
        // scartare a un Cancel le loro modifiche non salvate.
        //
        // [ORDER-TECO] La quinta sezione (PROD_TECO, feature 0023) non ha richiesto NESSUNA riga
        // qui: le tabelle si scoprono dai CustomData, non da un elenco di codici job. E' la
        // proprieta' che rende l'aggiunta di un job un fatto di fragment + i18n.
        //
        // Un solo set di handler serve tutte le sezioni: jobCode e updateGroup arrivano dai
        // CustomData del Table, non da costanti per-sezione.
        // ============================================================

        // Risale al Table dal bottone della headerToolbar e ne legge i CustomData.
        _jobNotifyCtx(oEvent) {
            let oTable = oEvent.getSource();
            while (oTable && !oTable.isA("sap.m.Table")) {
                oTable = oTable.getParent();
            }
            return { table: oTable, cfg: oTable ? oTable.data() : {} };
        },

        _getJobNotifyTables() {
            return this.byId("plantConfigPage").findAggregatedObjects(true, (o) =>
                o.isA("sap.m.Table") && !!(o.data() && o.data().jobCode));
        },

        _applyJobNotifyFilters() {
            const oModel = this.getView().getModel("catalog");
            this._getJobNotifyTables().forEach((oTable) => {
                const oBinding = oTable.getBinding("items");
                if (!oBinding) {
                    return;
                }
                const mCfg = oTable.data();
                // ODataListBinding#filter() MANTIENE i context transient (reset() con bDrop
                // undefined), quindi una riga non salvata conserverebbe il plant PRECEDENTE
                // nel payload della POST; un PATCH pendente farebbe invece lanciare
                // "Cannot filter due to pending changes". Si azzera prima.
                if (oModel.hasPendingChanges(mCfg.updateGroup)) {
                    oModel.resetChanges(mCfg.updateGroup);
                }
                oBinding.filter([
                    new Filter("Plant", FilterOperator.EQ, this._getPlantCode()),
                    new Filter("JobCode", FilterOperator.EQ, mCfg.jobCode)
                ]);
                // La tabella nasce suspended: senza il resume la prima GET partirebbe SENZA
                // filtro, caricando nel browser gli indirizzi e-mail di tutti i plant.
                if (oBinding.isSuspended()) {
                    oBinding.resume();
                }
            });
        },

        onAddJobNotify(oEvent) {
            const { table, cfg } = this._jobNotifyCtx(oEvent);
            // create(oInitialData, bSkipRefresh, bAtEnd, bInactive).
            // bInactive=true: la riga NON e' una pending change e NON viene POSTata finche'
            // l'utente non scrive qualcosa -> nessuna riga vuota salvata per distrazione, e
            // hasPendingChanges resta significativo.
            // bAtEnd resta falsy: true richiederebbe '$count': true nel binding, altrimenti
            // lancia "Must know the final length to create at the end".
            // Plant e JobCode preimpostati: senza di essi la riga sarebbe orfana di ogni
            // sezione e nessun job la leggerebbe mai.
            RowCancel.watchCreate(table.getBinding("items").create({
                Plant: this._getPlantCode(),
                JobCode: cfg.jobCode,
                Email: "",
                NotifyMode: "ALWAYS",
                IsActive: true
            }, false, false, true));
        },

        onDeleteJobNotify(oEvent) {
            const { table, cfg } = this._jobNotifyCtx(oEvent);
            const aContexts = table.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("jnSelectRowToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(cfg.updateGroup)));
            table.removeSelections(true);
        },

        onSaveJobNotify(oEvent) {
            const { table, cfg } = this._jobNotifyCtx(oEvent);
            const oModel = this.getView().getModel("catalog");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (!this._validateJobNotifyEmails(table)) {
                MessageToast.show(oBundle.getText("jnEmailInvalid"));
                return;
            }

            oModel.submitBatch(cfg.updateGroup).then(() => {
                if (oModel.hasPendingChanges(cfg.updateGroup)) {
                    // submitBatch() NON rigetta quando singole richieste del changeset vengono
                    // rifiutate (es. 400 di validazione): senza questo blocco l'utente non
                    // vedrebbe NULLA, ne' toast ne' errore. E' lo stesso difetto delle altre
                    // tab (cfr. onSaveAutoAssign): qui non lo si replica.
                    MessageBox.error(this._collectJobNotifyErrors() || oBundle.getText("jnSaveRejected"));
                    return;
                }
                MessageToast.show(oBundle.getText("jnSaveSuccess"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("jnSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelJobNotify(oEvent) {
            this.getView().getModel("catalog").resetChanges(this._jobNotifyCtx(oEvent).cfg.updateGroup);
        },

        onJobNotifyEmailChange(oEvent) {
            const oInput = oEvent.getSource();
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const bValid = RX_EMAIL.test((oInput.getValue() || "").trim());
            oInput.setValueState(bValid ? "None" : "Error");
            oInput.setValueStateText(bValid ? "" : oBundle.getText("jnEmailInvalid"));
        },

        _validateJobNotifyEmails(oTable) {
            return oTable.getItems().every((oItem) => {
                const oCtx = oItem.getBindingContext("catalog");
                // Una riga inattiva (create con bInactive) non verra' POSTata: non va validata.
                if (!oCtx || (oCtx.isInactive && oCtx.isInactive())) {
                    return true;
                }
                return RX_EMAIL.test(String(oCtx.getProperty("Email") || "").trim());
            });
        },

        /**
         * [SAVE-REJECT] I messaggi d'errore che il server ha appena mandato.
         *
         * L'app non ha un MessagePopover: un `req.error(400, ...)` del CAP finisce nel
         * MessageModel e li' resta. Ogni Salva di questa app faceva `submitBatch`, vedeva che le
         * modifiche erano ancora pendenti e RITORNAVA IN SILENZIO — l'utente vedeva la sua
         * modifica ancora a schermo e la credeva salvata, mentre il server l'aveva rifiutata.
         * E' cosi' che una categoria con «Catch-all» acceso E delle condizioni sembrava salvata
         * e continuava a leggersi `IsCatchAll: false` dall'OData.
         *
         * @returns {string} i messaggi, uno per riga; stringa vuota se non ce ne sono.
         */
        _collectSubmitErrors() {
            return (Messaging.getMessageModel().getData() || [])
                .filter((m) => m.type === "Error")
                .map((m) => m.message)
                .filter((t, i, a) => t && a.indexOf(t) === i)
                .join("\n");
        },

        /**
         * [SAVE-REJECT] Da chiamare quando dopo `submitBatch` le modifiche sono ancora pendenti:
         * il server ha rifiutato. Mostra il perche' invece di lasciare l'utente col dubbio.
         */
        _reportSaveRejected(oBundle) {
            const sErrors = this._collectSubmitErrors();
            MessageBox.error(sErrors || oBundle.getText("saveRejectedGeneric"), {
                title: oBundle.getText("saveRejectedTitle")
            });
        },

        // L'app non ha un MessagePopover: senza questo i req.error(400, ...) del CAP con
        // target non risolvibile sarebbero completamente invisibili all'utente.
        _collectJobNotifyErrors() {
            return (Messaging.getMessageModel().getData() || [])
                .filter((m) => m.type === "Error" && String(m.target || "").indexOf("ZJobNotifyRecipient") >= 0)
                .map((m) => m.message)
                .join("\n");
        },

        // ============================================================
        // [ROUTING-FILTER] REGOLE DI VISIBILITA' DEI CICLI (feature 0016) — tab "Routings"
        //
        // Un ciclo compare in lista se soddisfa ALMENO UNA regola attiva del suo plant; una
        // regola e' soddisfatta se tutti i suoi campi valorizzati coincidono, e un campo VUOTO
        // significa «qualunque valore». Nessuna regola => nessuna restrizione.
        // Semantica e confronto lato server: srv/lib/routingVisibility.js.
        // ============================================================

        _applyRoutingFilterPlantFilter() {
            const oTable = this.byId("routingFilterTable");
            const oBinding = oTable && oTable.getBinding("items");
            if (oBinding) {
                oBinding.filter(new Filter("Plant", FilterOperator.EQ, this._getPlantCode()));
            }
        },

        onAddRoutingFilter() {
            const oBinding = this.byId("routingFilterTable").getBinding("items");
            // I due codici nascono VUOTI: sono «qualunque valore», ed e' l'utente a restringere.
            // Il server rifiuta il salvataggio se restano entrambi vuoti (una regola senza
            // criteri aggancerebbe tutto, cioe' disattiverebbe il filtro in silenzio).
            RowCancel.watchCreate(oBinding.create({
                Plant: this._getPlantCode(),
                BillOfOperationsStatus: "",
                BillOfOperationsUsage: "",
                IsActive: true
            }));
        },

        onDeleteRoutingFilter() {
            const oTable = this.byId("routingFilterTable");
            const aContexts = oTable.getSelectedContexts();
            if (!aContexts.length) {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("rfSelectRowToDelete"));
                return;
            }
            aContexts.forEach((oCtx) => RowCancel.watchDelete(oCtx.delete(ROUTING_FILTER_GROUP)));
            oTable.removeSelections(true);
        },

        onSaveRoutingFilter() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            oModel.submitBatch(ROUTING_FILTER_GROUP).then(() => {
                if (oModel.hasPendingChanges(ROUTING_FILTER_GROUP)) {
                    // submitBatch() NON rigetta quando singole richieste del changeset vengono
                    // rifiutate (es. il 400 di «almeno un criterio»): senza questo blocco l'utente
                    // non vedrebbe NULLA. E' la variante di onSaveJobNotify, non il return
                    // silenzioso di onSaveMatCategory.
                    MessageBox.error(this._collectRoutingFilterErrors() || oBundle.getText("rfSaveRejected"));
                    return;
                }
                MessageToast.show(oBundle.getText("rfSaveSuccess"));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("rfSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelRoutingFilter() {
            this.getView().getModel("catalog").resetChanges(ROUTING_FILTER_GROUP);
        },

        // L'app non ha un MessagePopover: senza questo i req.error(400, ...) del CAP sarebbero
        // invisibili all'utente.
        _collectRoutingFilterErrors() {
            return (Messaging.getMessageModel().getData() || [])
                .filter((m) => m.type === "Error" && String(m.target || "").indexOf("ZRoutingFilterConfig") >= 0)
                .map((m) => m.message)
                .join("\n");
        },

        // ============================================================
        // [PLEX-CONN] CONNESSIONE A PLEX (feature 0020) — blocco della tab GlobalParams
        //
        // Persistenza per plant su ZPlexConnConfig (modello 'catalog', update group PROPRIO
        // 'plexConnChanges': submitBatch/hasPendingChanges/resetChanges sono group-scoped e
        // model-wide, quindi condividere il group di un'altra sezione farebbe inviare a un Save
        // anche le sue righe pendenti, in un changeset atomico).
        //
        // Stesso impianto del blocco «Ordinamento» piu' in basso: controlli legati al modello
        // JSON 'plexConn' e non al contesto OData, perche' la riga puo' NON esistere e aprire la
        // schermata non deve crearla; la riga nasce al PRIMO salvataggio.
        //
        // La VALIDAZIONE DI FORMA sta qui, lato client, e non e' un di piu' (DEC-40): la
        // validazione di tipo di CAP gira nella fase `_initial`, che precede OGNI before handler,
        // quindi un URL malformato tornerebbe con un messaggio tecnico che nessun handler puo'
        // riscrivere. Per questo lo schema NON porta assert.format sui due URL e il controllo
        // vive in due punti — qui e negli handler before CREATE/UPDATE — di proposito.
        // ============================================================

        // ------------------------------------------------------------
        // [PLEX-SECRET] Il gestore password del browser non deve agganciare i due segreti
        //
        // Chrome offriva di salvare in Google Password Manager la Consumer Key di Plex,
        // accoppiandola all'URL Connect come se il blocco fosse un form di login. La causa era il
        // `type="Password"` dei due campi: il password manager di Chromium — e quello di Firefox, e
        // i gestori di terze parti — si aggancia SOLO a un `<input type="password">` presente nel
        // DOM, prende come «username» il campo di testo che lo precede e propone il salvataggio. Lo
        // stesso aggancio abilita l'AUTO-COMPILAZIONE, che e' il danno peggiore dei due: una
        // credenziale salvata riscriverebbe in silenzio la Consumer Key all'apertura della
        // schermata, e la si scoprirebbe da un 401 di Plex.
        //
        // Nel fragment quindi non c'e' piu' alcun campo password e il mascheramento e' in CSS. Qui
        // si chiude il resto: `autocomplete` spento su TUTTI E CINQUE i campi (l'euristica di Chrome
        // accoppia «il testo prima della password», quindi non basta agire sui due segreti) e il
        // ripiego per i browser che non sanno mascherare in CSS. Vedi DEC-79.
        // ------------------------------------------------------------

        /**
         * Nega ai gestori password i cinque campi della connessione Plex e verifica che il
         * mascheramento CSS sia davvero disponibile.
         *
         * Idempotente e riapplicato a ogni render: `sap.m.Input` non espone `autocomplete`, quindi
         * l'attributo si mette sul DOM — e un re-render (basta un cambio di `valueState`) lo
         * perderebbe. Il delegate e' per controllo e non sulla view, perche' un Input si ri-renderizza
         * anche da solo.
         */
        _hardenPlexConnInputs() {
            // `-webkit-text-security` e' prefissato: dove non e' supportato la regola CSS non
            // maschera NIENTE e il segreto si leggerebbe in chiaro. La' si preferisce il
            // mascheramento alla soppressione del gestore password — un segreto in chiaro si vede
            // sempre, il prompt del gestore solo se qualcuno lo accetta — e si torna a
            // `type="Password"`, dichiarandolo in console. Su Chrome/Edge/Safari il detect passa e
            // nessun input password viene mai creato.
            const bCssMasks = typeof CSS !== "undefined" && typeof CSS.supports === "function" &&
                (CSS.supports("-webkit-text-security", "disc") || CSS.supports("text-security", "disc"));
            if (!bCssMasks) {
                console.warn(">>> [PLEX-SECRET] questo browser non maschera in CSS " +
                    "(-webkit-text-security): i due segreti Plex tornano a type=Password, quindi il " +
                    "gestore password potrebbe proporne il salvataggio.");
                PLEX_SECRET_INPUT_IDS.forEach((sId) => {
                    const oInput = this.byId(sId);
                    if (oInput) { oInput.setType("Password"); }
                });
            }

            // Un id che non risolve non e' un caso da ignorare: significa che per quel campo NIENTE
            // di tutto questo e' stato applicato, e senza dirlo sarebbe indistinguibile da un campo
            // protetto. Vale anche per il ripiego qui sopra, che scorre lo stesso elenco.
            const aMissing = [];

            PLEX_CONN_INPUT_IDS.forEach((sId) => {
                const oInput = this.byId(sId);
                if (!oInput) { aMissing.push(sId); return; }
                const fnApply = () => {
                    const oDom = oInput.getFocusDomRef();
                    if (!oDom) { return; }
                    // `off` da solo viene ignorato da Chrome sui campi che riconosce come parte di
                    // una credenziale: senza campo password non li riconosce piu', e `data-form-type`
                    // chiude 1Password e Dashlane, che hanno euristiche proprie.
                    oDom.setAttribute("autocomplete", "off");
                    oDom.setAttribute("autocorrect", "off");
                    oDom.setAttribute("autocapitalize", "off");
                    oDom.setAttribute("spellcheck", "false");
                    oDom.setAttribute("data-form-type", "other");
                };
                oInput.addEventDelegate({ onAfterRendering: fnApply });
                // Al primo giro il DOM non c'e' ancora (siamo prima del render) e `fnApply` esce
                // subito: serve per i giri successivi, dove il controllo e' gia' renderizzato.
                fnApply();
            });

            if (aMissing.length) {
                console.warn(">>> [PLEX-SECRET] questi campi della connessione Plex non sono stati " +
                    "trovati nella view, quindi il gestore password del browser NON e' stato negato " +
                    "su di essi: " + aMissing.join(", ") + ". Sono cambiati gli id nel fragment?");
            }
        },

        // Forma di un host Plex: `https://` e NESSUN path. Gli URL vengono concatenati con i path
        // delle API (`/mdm/v1/parts`, `/api/datasources/...`): una barra finale o un path incollato
        // produrrebbe un indirizzo doppio, che fallirebbe a runtime invece che qui.
        //
        // DUPLICAZIONE CONSAPEVOLE della RX_PLEX_HOST di srv/lib/plexConnRules.js, che ha i suoi
        // test in test/plexConnRules.test.js: il frontend non puo' richiedere un modulo del
        // server. Se la si allarga la', va allargata anche qui. E' l'unico punto di duplicazione
        // di questa feature, come RX_FROZEN_TOKEN lo e' per la 0014.
        _isPlexHost(sUrl) {
            return /^https:\/\/[^/]+$/.test(String(sUrl || "").trim());
        },

        // Stato del blocco. `oCtx` assente => campi vuoti.
        // `bUnknown` true => la riga non e' (ancora) nota: campi vuoti ma avviso NON dichiarato
        // (lettura in volo o non riuscita: non si afferma cio' che non si sa).
        _plexConnState(oCtx, bUnknown) {
            const sPlant = this._getPlantCode();
            const bExists = !!oCtx;
            const sTestedAt = bExists ? (oCtx.getProperty("LastTestedAt") || "") : "";
            const sTestStatus = bExists ? (oCtx.getProperty("LastTestStatus") || "") : "";
            const sTestMessage = bExists ? (oCtx.getProperty("LastTestMessage") || "") : "";
            return {
                plant: sPlant,
                exists: bExists || !!bUnknown,
                // Testo composto qui e non nella view: ha un segnaposto e, in italiano, un
                // apostrofo raddoppiato che solo getText() con argomenti risolve.
                notConfiguredText: (bExists || bUnknown) ? "" : this._i18n().getText("pconnNotConfigured", [sPlant]),
                BaseUrl: bExists ? (oCtx.getProperty("BaseUrl") || "") : "",
                ConsumerKey: bExists ? (oCtx.getProperty("ConsumerKey") || "") : "",
                DataSourceUrl: bExists ? (oCtx.getProperty("DataSourceUrl") || "") : "",
                DataSourceUser: bExists ? (oCtx.getProperty("DataSourceUser") || "") : "",
                DataSourcePassword: bExists ? (oCtx.getProperty("DataSourcePassword") || "") : "",
                LastTestedAt: sTestedAt,
                LastTestStatus: sTestStatus,
                lastTestText: sTestedAt
                    ? this._i18n().getText("pconnLastTestText", [
                        new Date(sTestedAt).toLocaleString(),
                        sTestMessage
                    ])
                    : "",
                dirty: false,
                // Esito PER CANALE dell'ultimo test fatto in questa sessione. `null` finché non se
                // ne fa uno: la schermata allora mostra il solo riepilogo persistito, invece di
                // ricostruire un dettaglio per canale che nessuno ha memorizzato (LastTest* è una
                // colonna sola). Ogni ricaricamento lo azzera, perché appartiene a quel test lì.
                liveTest: null,
                baseUrlState: "None", baseUrlStateText: "",
                consumerKeyState: "None", consumerKeyStateText: "",
                dsUrlState: "None", dsUrlStateText: "",
                dsUserState: "None", dsUserStateText: ""
            };
        },

        _setPlexConnModel(oCtx, bUnknown) {
            this.getView().getModel("plexConn").setData(this._plexConnState(oCtx, bUnknown));
        },

        // Legge la connessione del plant corrente: UNA riga al massimo. Il binding e' creato in
        // codice (non dichiarato nel fragment) proprio perche' deve partire solo dentro il gate
        // isFullAdmin di _loadPlantConfig.
        // Restituisce una promise perche' onTestPlexConn deve poter riapplicare il dettaglio per
        // canale DOPO la rilettura: la rilettura riscrive il modello da capo e cancellerebbe le due
        // righe di esito appena ottenute.
        _loadPlexConnConfig() {
            const oModel = this.getView().getModel("catalog");
            const sPlant = this._getPlantCode();
            if (!oModel || !sPlant) {
                return Promise.resolve();
            }

            // filter() su un binding con modifiche pendenti lancia "Cannot filter due to pending
            // changes", e un contesto transient conserverebbe il plant PRECEDENTE nel payload
            // della POST. Si azzera prima, come per le altre sezioni.
            if (oModel.hasPendingChanges(PLEX_CONN_GROUP)) {
                oModel.resetChanges(PLEX_CONN_GROUP);
            }
            this._oPlexConnCtx = null;
            this._bPlexConnCreated = false;
            this._setPlexConnModel(null, true);

            const oFilter = new Filter("Plant", FilterOperator.EQ, sPlant);
            if (!this._oPlexConnBinding) {
                this._oPlexConnBinding = oModel.bindList("/ZPlexConnConfig", null, [], [oFilter], {
                    $$updateGroupId: PLEX_CONN_GROUP
                });
            } else {
                this._oPlexConnBinding.filter(oFilter);
            }

            return this._oPlexConnBinding.requestContexts(0, 1).then((aContexts) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo.
                if (this._getPlantCode() !== sPlant) {
                    return;
                }
                this._oPlexConnCtx = (aContexts && aContexts[0]) || null;
                this._setPlexConnModel(this._oPlexConnCtx);
            }).catch((oError) => {
                // Lettura non riuscita: si resta sui campi vuoti SENZA dichiarare «non
                // configurato», che affermerebbe una cosa non verificata. Il caso tipico e' il
                // 403 del gate di ruolo, che qui non dovrebbe mai arrivare (siamo dentro il gate
                // isFullAdmin) ma che non deve comunque mentire all'utente.
                console.warn(">>> [0020] lettura ZPlexConnConfig non riuscita per il plant " +
                    sPlant + ": nessuna dichiarazione mostrata.", oError);
            });
        },

        // Nessun salvataggio implicito: digitare marca solo il blocco come modificato e azzera
        // l'eventuale errore precedente sul campo toccato.
        onPlexConnChange(oEvent) {
            const oPlexConn = this.getView().getModel("plexConn");
            oPlexConn.setProperty("/dirty", true);
            const sId = oEvent.getSource().getId();
            const mFieldByIdSuffix = {
                plexConnBaseUrl: "baseUrl",
                plexConnConsumerKey: "consumerKey",
                plexConnDsUrl: "dsUrl",
                plexConnDsUser: "dsUser"
            };
            Object.keys(mFieldByIdSuffix).forEach((sSuffix) => {
                if (sId.indexOf(sSuffix) >= 0) {
                    oPlexConn.setProperty("/" + mFieldByIdSuffix[sSuffix] + "State", "None");
                    oPlexConn.setProperty("/" + mFieldByIdSuffix[sSuffix] + "StateText", "");
                }
            });
        },

        // Validazione dei quattro campi obbligatori. Ritorna true se tutto e' a posto e marca a
        // video ogni campo che non lo e', invece di fermarsi al primo: chi compila cinque campi
        // deve poterli correggere in un giro solo.
        _validatePlexConn() {
            const oPlexConn = this.getView().getModel("plexConn");
            const oData = oPlexConn.getData();
            const oBundle = this._i18n();
            let bOk = true;

            const fail = (sField, sTextKey) => {
                oPlexConn.setProperty("/" + sField + "State", "Error");
                oPlexConn.setProperty("/" + sField + "StateText", oBundle.getText(sTextKey));
                bOk = false;
            };

            if (!this._isPlexHost(oData.BaseUrl)) fail("baseUrl", "pconnErrBaseUrl");
            if (!String(oData.ConsumerKey || "").trim()) fail("consumerKey", "pconnErrConsumerKey");
            if (!this._isPlexHost(oData.DataSourceUrl)) fail("dsUrl", "pconnErrDsUrl");
            if (!String(oData.DataSourceUser || "").trim()) fail("dsUser", "pconnErrDsUser");
            // DataSourcePassword resta facoltativa: una password vuota e' un valore legittimo per
            // un web-service account, ed e' l'unico dei cinque campi che lo schema non impone.
            return bOk;
        },

        onSavePlexConn() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this._i18n();
            const oPlexConn = this.getView().getModel("plexConn");
            const oData = oPlexConn.getData();
            const sPlant = this._getPlantCode();
            if (!this._oPlexConnBinding) {
                // Il binding nasce in _loadPlexConnConfig, dentro il gate isFullAdmin: senza di
                // esso non c'e' nulla da salvare, e nessun utente autorizzato puo' arrivarci.
                return;
            }
            if (!this._validatePlexConn()) {
                MessageBox.error(oBundle.getText("pconnErrInvalid"));
                return;
            }

            const oValues = {
                BaseUrl: String(oData.BaseUrl || "").trim(),
                ConsumerKey: String(oData.ConsumerKey || "").trim(),
                DataSourceUrl: String(oData.DataSourceUrl || "").trim(),
                DataSourceUser: String(oData.DataSourceUser || "").trim(),
                DataSourcePassword: String(oData.DataSourcePassword || "")
            };

            if (!this._oPlexConnCtx) {
                // Creazione LAZY: la riga nasce QUI, al primo salvataggio. Plant preimpostato
                // dalla shell, gia' nella forma ^[A-Z0-9]{1,4}$ richiesta dal servizio.
                this._oPlexConnCtx = RowCancel.watchCreate(this._oPlexConnBinding.create(
                    Object.assign({ Plant: sPlant }, oValues)
                ));
                this._bPlexConnCreated = true;
            } else {
                Object.keys(oValues).forEach((sKey) => {
                    this._oPlexConnCtx.setProperty(sKey, oValues[sKey]);
                });
            }

            oModel.submitBatch(PLEX_CONN_GROUP).then(() => {
                if (oModel.hasPendingChanges(PLEX_CONN_GROUP)) {
                    // submitBatch() NON rigetta quando il server rifiuta la singola richiesta
                    // (es. 400 di validazione o 403 del gate di ruolo): senza questo blocco
                    // l'utente non vedrebbe nulla. Le modifiche restano pendenti per la
                    // correzione.
                    MessageBox.error(oBundle.getText("pconnSaveRejected"));
                    return;
                }
                this._bPlexConnCreated = false;
                this._setPlexConnModel(this._oPlexConnCtx);
                // La conferma dichiara DA QUANDO la modifica ha effetto: la cache lato server e'
                // invalidata per questo plant al salvataggio, quindi dalla prossima chiamata.
                MessageToast.show(oBundle.getText("pconnSaved", [sPlant]));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("pconnSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelPlexConn() {
            this.getView().getModel("catalog").resetChanges(PLEX_CONN_GROUP);
            // Una riga mai salvata e' transient: scartarla la fa scomparire, e il contesto non
            // e' piu' utilizzabile. Il flag evita di interrogare un contesto distrutto.
            if (this._bPlexConnCreated) {
                this._oPlexConnCtx = null;
                this._bPlexConnCreated = false;
            }
            this._setPlexConnModel(this._oPlexConnCtx);
        },

        // Prova la connessione SALVATA (il pulsante e' disabilitato finche' ci sono modifiche
        // pendenti: provare valori non ancora in vigore direbbe poco).
        //
        // Il servizio prova ENTRAMBI i canali — Connect API e Data Source API — e restituisce un
        // esito per ciascuno: sono due host con due autenticazioni distinte, e sapere QUALE dei due
        // si e' rotto e' tutta l'informazione utile. L'esito riassunto viene persistito dal server
        // su LastTest*, quindi si rilegge la riga; il dettaglio per canale si tiene nel modello
        // (`liveTest`) e resta a video finche' non si cambia plant.
        onTestPlexConn() {
            const oBundle = this._i18n();
            const sPlant = this._getPlantCode();
            const oPage = this.byId("plantConfigPage");
            if (!sPlant) {
                return;
            }
            oPage.setBusy(true);
            // fetch diretta sulla action del service V4: stessa convenzione di _checkUserRole e
            // _loadPlexOperations, nessuna dataSource nuova nel manifest.
            fetch(AppUrl.url("/plex/testPlexConnection"), {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ Plant: sPlant })
            }).then((res) => {
                if (!res.ok) { throw new Error("HTTP " + res.status); }
                return res.json();
            }).then((oResult) => {
                const oOutcome = oResult || {};
                if (oOutcome.success) {
                    MessageToast.show(oBundle.getText("pconnTestOk", [String(oOutcome.partsCount || 0)]));
                } else {
                    // Un solo messaggio con TUTTI E DUE i canali: chi ha sbagliato entrambi li
                    // corregge in un giro solo, invece di scoprirne uno per volta.
                    MessageBox.error(oBundle.getText("pconnTestChannels", [
                        oOutcome.connectMessage || "",
                        oOutcome.dataSourceMessage || ""
                    ]));
                }
                // La rilettura riporta LastTest* dal server e riscrive il modello da capo: il
                // dettaglio per canale si riapplica DOPO che si è conclusa, altrimenti le due
                // righe comparirebbero e sparirebbero.
                return this._loadPlexConnConfig().then(() => {
                    this.getView().getModel("plexConn").setProperty("/liveTest", {
                        connectOk: !!oOutcome.connectOk,
                        connectMessage: oOutcome.connectMessage || "",
                        dataSourceOk: !!oOutcome.dataSourceOk,
                        dataSourceMessage: oOutcome.dataSourceMessage || ""
                    });
                });
            }).catch((oError) => {
                // La chiamata stessa non e' arrivata a destinazione: qui non c'e' un esito per
                // canale da mostrare, perche' nessuno dei due e' stato provato.
                MessageBox.error(oBundle.getText("pconnTestFailed", [oError.message || ""]));
            }).finally(() => {
                oPage.setBusy(false);
            });
        },

        // ============================================================
        // PLEX WORK LIST SORT ORDER (feature 0014) — blocco della tab GlobalParams
        //
        // Persistenza per plant su ZPlexJobSortConfig (modello 'catalog', update group PROPRIO
        // 'jobSortChanges': submitBatch/hasPendingChanges/resetChanges sono group-scoped e
        // model-wide, quindi condividere il group di auto-assign farebbe inviare a un Save le
        // righe pendenti dell'altra sezione, in un changeset atomico).
        //
        // I controlli sono legati al modello JSON 'jobSort' e non al contesto OData: la riga
        // puo' NON esistere e aprire la schermata non deve crearla (FDD §7.3). La riga nasce al
        // PRIMO salvataggio (creazione lazy). L'elenco degli stati e' NORMALIZZATO dal server:
        // dopo un salvataggio riuscito si rilegge dal contesto, cosi' l'amministratore vede il
        // valore che verra' trasmesso a Plex (FR-16).
        // ============================================================

        // Stato del blocco. `oCtx` assente => valori inerti (spento, no, elenco vuoto).
        // `bUnknown` true => la riga non e' (ancora) nota: valori inerti ma M-12 NON dichiarato
        // (lettura in volo o non riuscita: non si afferma cio' che non si sa).
        _jobSortState(oCtx, bUnknown) {
            const sPlant = this._getPlantCode();
            const bExists = !!oCtx;
            return {
                plant: sPlant,
                exists: bExists || !!bUnknown,
                // M-12 composto qui e non nella view: il testo ha un segnaposto e, in italiano,
                // un apostrofo raddoppiato che solo getText() con argomenti risolve.
                notConfiguredText: (bExists || bUnknown) ? "" : this._i18n().getText("jsortNotConfigured", [sPlant]),
                IsEnabled: bExists ? !!oCtx.getProperty("IsEnabled") : false,
                DueDateSort: bExists ? !!oCtx.getProperty("DueDateSort") : false,
                FrozenJobStatusList: bExists ? (oCtx.getProperty("FrozenJobStatusList") || "") : "",
                dirty: false,
                frozenValueState: "None",
                frozenValueStateText: ""
            };
        },

        // [I18N-EARLY] Il bundle si chiede al COMPONENTE quando la vista non ce l'ha ancora: i
        // formatter girano MENTRE la vista si costruisce, prima che i modelli del componente le
        // siano propagati. Senza il ripiego il `TypeError` sale dentro `Target._place` e la scheda
        // non si apre affatto. La catena completa sta in testa a `_getSplitBundle()` nel cockpit
        // (ProdOrderSplit.mixin.js). Rete: node test/i18nEarly.test.js
        _i18n() {
            const oModel = this.getView().getModel("i18n") || this.getOwnerComponent().getModel("i18n");
            return oModel.getResourceBundle();
        },

        _setJobSortModel(oCtx, bUnknown) {
            this.getView().getModel("jobSort").setData(this._jobSortState(oCtx, bUnknown));
        },

        // Legge la configurazione del plant corrente: UNA riga al massimo. Il binding e' creato
        // in codice (non dichiarato nel fragment) proprio perche' deve partire solo dentro il
        // gate isFullAdmin di _loadPlantConfig.
        _loadJobSortConfig() {
            const oModel = this.getView().getModel("catalog");
            const sPlant = this._getPlantCode();
            if (!oModel || !sPlant) {
                return;
            }

            // filter() su un binding con modifiche pendenti lancia "Cannot filter due to pending
            // changes", e un contesto transient conserverebbe il plant PRECEDENTE nel payload
            // della POST. Si azzera prima, come per le tabelle dei destinatari.
            if (oModel.hasPendingChanges(JOB_SORT_GROUP)) {
                oModel.resetChanges(JOB_SORT_GROUP);
            }
            this._oJobSortCtx = null;
            this._bJobSortCreated = false;
            this._setJobSortModel(null, true);

            const oFilter = new Filter("Plant", FilterOperator.EQ, sPlant);
            if (!this._oJobSortBinding) {
                this._oJobSortBinding = oModel.bindList("/ZPlexJobSortConfig", null, [], [oFilter], {
                    $$updateGroupId: JOB_SORT_GROUP
                });
            } else {
                this._oJobSortBinding.filter(oFilter);
            }

            this._oJobSortBinding.requestContexts(0, 1).then((aContexts) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo.
                if (this._getPlantCode() !== sPlant) {
                    return;
                }
                this._oJobSortCtx = (aContexts && aContexts[0]) || null;
                this._setJobSortModel(this._oJobSortCtx);
            }).catch((oError) => {
                // Lettura non riuscita: si resta sui valori inerti SENZA dichiarare M-12, che
                // affermerebbe una cosa non verificata («non ancora configurato»).
                console.warn(">>> [0014] lettura ZPlexJobSortConfig non riuscita per il plant " +
                    sPlant + ": nessuna dichiarazione mostrata.", oError);
            });
        },

        // Nessun salvataggio implicito: i due interruttori marcano solo il blocco come modificato.
        onJobSortDirty() {
            this.getView().getModel("jobSort").setProperty("/dirty", true);
        },

        onFrozenStatesChange(oEvent) {
            this.getView().getModel("jobSort").setProperty("/dirty", true);
            this._applyFrozenWarning(oEvent.getSource().getValue());
        },

        // Avviso NON bloccante M-11: un token che non coincide con un valore noto (o che non ha
        // la forma ammessa) non impedisce il salvataggio, perche' l'insieme degli stati e'
        // governato da Plex e puo' crescere senza preavviso. La validazione che BLOCCA e' quella
        // del server, e arriva accanto al campo dopo il Save.
        // Ricalcolato anche DOPO il salvataggio, perche' l'avviso riguarda il valore memorizzato
        // (e quindi trasmesso), non la digitazione.
        _applyFrozenWarning(sValue) {
            const oJobSort = this.getView().getModel("jobSort");
            const aTokens = String(sValue || "")
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            const sSuspect = aTokens.find((s) =>
                !RX_FROZEN_TOKEN.test(s) || KNOWN_FROZEN_STATUSES.indexOf(s) < 0);

            oJobSort.setProperty("/frozenValueState", sSuspect ? "Warning" : "None");
            oJobSort.setProperty("/frozenValueStateText", sSuspect
                ? this._i18n().getText("jsortUnknownState", [sSuspect, KNOWN_FROZEN_STATUSES.join(", ")])
                : "");
        },

        onSaveJobSort() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this._i18n();
            const oJobSort = this.getView().getModel("jobSort");
            const oData = oJobSort.getData();
            const sPlant = this._getPlantCode();
            if (!this._oJobSortBinding) {
                // Il binding nasce in _loadJobSortConfig, dentro il gate isFullAdmin: senza di
                // esso non c'e' nulla da salvare, e nessun utente autorizzato puo' arrivarci.
                return;
            }

            // Si azzera l'eventuale errore del salvataggio precedente: l'avviso M-11 viene
            // ricalcolato a fine salvataggio, l'errore del server dalla nuova risposta.
            if (oJobSort.getProperty("/frozenValueState") === "Error") {
                oJobSort.setProperty("/frozenValueState", "None");
                oJobSort.setProperty("/frozenValueStateText", "");
            }

            const sFrozen = String(oData.FrozenJobStatusList || "").trim();
            if (!this._oJobSortCtx) {
                // Creazione LAZY: la riga nasce QUI, al primo salvataggio. Plant preimpostato
                // dalla shell, gia' nella forma ^[A-Z0-9]{1,4}$ richiesta dal servizio (C-10).
                this._oJobSortCtx = RowCancel.watchCreate(this._oJobSortBinding.create({
                    Plant: sPlant,
                    IsEnabled: !!oData.IsEnabled,
                    DueDateSort: !!oData.DueDateSort,
                    FrozenJobStatusList: sFrozen
                }));
                this._bJobSortCreated = true;
            } else {
                this._oJobSortCtx.setProperty("IsEnabled", !!oData.IsEnabled);
                this._oJobSortCtx.setProperty("DueDateSort", !!oData.DueDateSort);
                this._oJobSortCtx.setProperty("FrozenJobStatusList", sFrozen);
            }

            oModel.submitBatch(JOB_SORT_GROUP).then(() => {
                if (oModel.hasPendingChanges(JOB_SORT_GROUP)) {
                    // submitBatch() NON rigetta quando il server rifiuta la singola richiesta
                    // (es. 400 di validazione): senza questo blocco l'utente non vedrebbe nulla.
                    // Le modifiche restano pendenti per la correzione.
                    this._showJobSortRejection();
                    return;
                }
                this._bJobSortCreated = false;
                // FR-16: il valore memorizzato e' quello NORMALIZZATO dal server, ed e' quello
                // che verra' trasmesso a Plex. Si rilegge dal contesto e si riscrive nel campo.
                this._setJobSortModel(this._oJobSortCtx);
                this._applyFrozenWarning(oJobSort.getProperty("/FrozenJobStatusList"));
                // M-14: la conferma dichiara DA QUANDO la modifica ha effetto.
                MessageToast.show(oBundle.getText("jsortSaved", [sPlant]));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("jsortSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelJobSort() {
            this.getView().getModel("catalog").resetChanges(JOB_SORT_GROUP);
            // Una riga mai salvata e' transient: scartarla la fa scomparire, e il contesto non
            // e' piu' utilizzabile. Il flag evita di interrogare un contesto distrutto.
            if (this._bJobSortCreated) {
                this._oJobSortCtx = null;
                this._bJobSortCreated = false;
            }
            this._setJobSortModel(this._oJobSortCtx);
        },

        // Errori di validazione del server (M-09/M-10 e unicita'). L'Input e' legato al modello
        // JSON, non al contesto OData: un messaggio con target NON si attacca da solo al
        // controllo, quindi lo si legge dal message model e lo si mostra accanto al campo. Vale
        // qui la stessa ragione di _collectJobNotifyErrors: l'app non ha un MessagePopover.
        _showJobSortRejection() {
            const aErrors = (Messaging.getMessageModel().getData() || []).filter((m) => {
                const sTarget = String(m.target || "");
                return m.type === "Error" && (
                    sTarget.indexOf("ZPlexJobSortConfig") >= 0 ||
                    sTarget.indexOf("FrozenJobStatusList") >= 0 ||
                    !sTarget
                );
            });
            const aOnField = aErrors.filter((m) =>
                String(m.target || "").indexOf("FrozenJobStatusList") >= 0);

            if (aOnField.length) {
                const oJobSort = this.getView().getModel("jobSort");
                oJobSort.setProperty("/frozenValueState", "Error");
                oJobSort.setProperty("/frozenValueStateText", aOnField.map((m) => m.message).join("\n"));
                return;
            }
            MessageBox.error(aErrors.map((m) => m.message).join("\n") ||
                this._i18n().getText("jsortSaveError", [""]));
        },

        // ============================================================
        // [ORDER-STATUS-FILTER] PERIMETRO ORDINI PER STATO (feature 0017) — tab "Ordini di
        // produzione".
        //
        // Due elenchi di nomi di flag: quelli che l'ordine deve avere impostati e quelli che non
        // deve avere. Governano la lista del cockpit, il job pianificato e le due azioni manuali.
        // FAIL-CLOSED: finche' la riga non esiste, il plant NON produce ordini — ed e' per questo
        // che l'avviso di «non configurato» qui e' un Warning e non un'Information come nel
        // blocco 0014, dove la mancanza di configurazione non ferma nulla.
        //
        // Persistenza su ZProdOrderFilterConfig (modello 'catalog', update group PROPRIO
        // 'prodOrderFilterChanges': submitBatch/hasPendingChanges/resetChanges sono group-scoped
        // e model-wide, quindi condividere il group di un'altra sezione manderebbe le sue righe
        // pendenti nello stesso changeset atomico).
        // Semantica lato server: srv/lib/prodOrderStatusFilter.js.
        // ============================================================

        /** Stato inerte del blocco. `bUnknown` = la lettura non ha ancora risposto. */
        _prodOrderFilterState(oCtx, bUnknown) {
            const sPlant = this._getPlantCode();
            const bExists = !!oCtx;
            const oCurrent = this.getView().getModel("osf");
            return {
                plant: sPlant,
                exists: bExists || !!bUnknown,
                // Composto qui e non nella view: ha un segnaposto e, in italiano, apostrofi
                // raddoppiati che solo getText() con argomenti risolve.
                notConfiguredText: (bExists || bUnknown) ? "" :
                    this._i18n().getText("osfNotConfigured", [sPlant]),
                required: bExists ? this._osfSplit(oCtx.getProperty("RequiredStatuses")) : [],
                excluded: bExists ? this._osfSplit(oCtx.getProperty("ExcludedStatuses")) : [],
                // [W1-09] I due criteri su valore. Stesso formato persistito, stessa split.
                orderTypes: bExists ? this._osfSplit(oCtx.getProperty("OrderTypes")) : [],
                supervisors: bExists ? this._osfSplit(oCtx.getProperty("ProductionSupervisors")) : [],
                // Il catalogo si carica UNA volta e sopravvive ai cambi di plant: e' lo stesso
                // per tutti, e ricaricarlo a ogni selezione sarebbe una richiesta per nulla.
                catalog: (oCurrent && oCurrent.getProperty("/catalog")) || [],
                dirty: false
            };
        },

        /** Da stringa persistita ad array di chiavi per i due MultiComboBox e i due MultiInput. */
        _osfSplit(sValue) {
            return String(sValue || "").split(";").map((s) => s.trim()).filter((s) => s.length > 0);
        },

        /**
         * [W1-09] Le due liste di codici, con la lunghezza DDIC del token.
         * Un elenco solo, perche' i punti che devono restare allineati sono tre — stato del
         * modello, salvataggio, difesa sulla lunghezza — e tre copie della stessa coppia sono
         * il modo naturale di dimenticarne una.
         */
        _osfCodeLists() {
            return [
                { prop: "orderTypes", field: "OrderTypes", maxLen: 4 },
                { prop: "supervisors", field: "ProductionSupervisors", maxLen: 3 }
            ];
        },

        _setProdOrderFilterModel(oCtx, bUnknown) {
            this.getView().getModel("osf").setData(this._prodOrderFilterState(oCtx, bUnknown));
        },

        /**
         * Catalogo dei nomi ammessi, dal server: la fonte di verita' e' il modulo puro contro cui
         * la validazione confronta, quindi la app NON tiene una propria copia dell'elenco.
         * Le etichette sono i18n per codice, con il codice stesso come fallback: uno stato
         * aggiunto al catalogo lato server compare subito, in chiaro, invece di sparire.
         */
        _loadProdOrderStatusCatalog() {
            if (this._pOsfCatalog) {
                return this._pOsfCatalog;
            }
            const oBundle = this._i18n();
            this._pOsfCatalog = fetch(AppUrl.url("/odata/v4/catalog/prodOrderStatusCatalog()"), {
                headers: { "Accept": "application/json" }
            }).then((res) => {
                if (!res.ok) { throw new Error("HTTP " + res.status); }
                return res.json();
            }).then((oData) => (oData && oData.value ? oData.value : []).map((o) => ({
                code: o.code,
                label: oBundle.hasText("osfSt" + o.code) ? oBundle.getText("osfSt" + o.code) : o.code,
                // I flag non ancora dichiarati nel contratto iFlow si possono scegliere, ma chi li
                // sceglie deve sapere che la loro presenza nella risposta va verificata: con il
                // fail-closed un campo che non arriva svuota la lista invece di allargarla.
                note: o.contracted ? "" : oBundle.getText("osfStUnverified")
            }))).catch((oError) => {
                console.warn(">>> [0017] catalogo degli stati non caricato: i due elenchi restano vuoti.", oError);
                this._pOsfCatalog = null;   // ritentabile alla prossima apertura
                return [];
            });
            return this._pOsfCatalog;
        },

        // Legge la configurazione del plant corrente: UNA riga al massimo. Binding creato in
        // codice, non nel fragment, perche' deve partire solo dentro il gate isFullAdmin.
        _loadProdOrderFilterConfig() {
            const oModel = this.getView().getModel("catalog");
            const sPlant = this._getPlantCode();
            if (!oModel || !sPlant) {
                return;
            }

            // filter() su un binding con modifiche pendenti lancia "Cannot filter due to pending
            // changes", e un contesto transient conserverebbe il plant PRECEDENTE nel payload
            // della POST. Si azzera prima, come nelle altre sezioni.
            if (oModel.hasPendingChanges(PROD_ORDER_FILTER_GROUP)) {
                oModel.resetChanges(PROD_ORDER_FILTER_GROUP);
            }
            this._oOsfCtx = null;
            this._bOsfCreated = false;
            this._setProdOrderFilterModel(null, true);

            this._loadProdOrderStatusCatalog().then((aCatalog) => {
                this.getView().getModel("osf").setProperty("/catalog", aCatalog);
            });

            const oFilter = new Filter("Plant", FilterOperator.EQ, sPlant);
            if (!this._oOsfBinding) {
                this._oOsfBinding = oModel.bindList("/ZProdOrderFilterConfig", null, [], [oFilter], {
                    $$updateGroupId: PROD_ORDER_FILTER_GROUP
                });
            } else {
                this._oOsfBinding.filter(oFilter);
            }

            this._oOsfBinding.requestContexts(0, 1).then((aContexts) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo.
                if (this._getPlantCode() !== sPlant) {
                    return;
                }
                this._oOsfCtx = (aContexts && aContexts[0]) || null;
                this._setProdOrderFilterModel(this._oOsfCtx);
            }).catch((oError) => {
                // Lettura non riuscita: si resta sui valori inerti SENZA dichiarare «non
                // configurato», che affermerebbe una cosa non verificata — e qui l'affermazione
                // sarebbe grave, perche' dice che il plant non sta leggendo ordini.
                console.warn(">>> [0017] lettura ZProdOrderFilterConfig non riuscita per il plant " +
                    sPlant + ": nessuna dichiarazione mostrata.", oError);
            });
        },

        // Nessun salvataggio implicito: la selezione marca solo il blocco come modificato.
        onProdOrderFilterDirty() {
            this.getView().getModel("osf").setProperty("/dirty", true);
        },

        /**
         * [W1-09] Il modello e' la fonte di verita' dei due elenchi di codici, non i token.
         *
         * L'aggregazione `tokens` e' legata a un array del modello JSON, e su un'aggregazione
         * legata le due strade non sono simmetriche: la lettura funziona, ma `addToken()` e la
         * rimozione da parte dell'utente NON tornano indietro nel modello. Quindi entrambi i
         * versi passano da qui, sull'array, e il binding si limita a mostrarlo.
         */
        _osfPropOf(oInput) {
            const oBinding = oInput.getBinding("tokens");
            const sPath = oBinding && oBinding.getPath ? String(oBinding.getPath()) : "";
            return sPath.replace(/^\//, "");
        },

        /**
         * [W1-09] Invio di un codice in uno dei due MultiInput.
         *
         * Il valore va MESSO IN MAIUSCOLO: AUART e FEVOR sono @sap.display.format:'UpperCase' e
         * SAP li tiene gia' cosi', quindi chi digita 'pp01' otterrebbe altrimenti un codice che
         * non aggancia niente. Il server normalizza comunque, ma vederlo cambiare dopo il Save
         * sembrerebbe un errore invece di una regola. Gli zeri iniziali NON si toccano: quelli li
         * normalizza il CONFRONTO lato server (DEC-51), ed e' proprio la tolleranza che rende
         * inoffensivo scrivere '1' dove SAP ha '001'.
         */
        onProdOrderCodeSubmit(oEvent) {
            const oInput = oEvent.getSource();
            const oOsf = this.getView().getModel("osf");
            const sProp = this._osfPropOf(oInput);
            const sValue = String(oEvent.getParameter("value") || "").trim().toUpperCase();
            oInput.setValue("");
            if (!sValue || !sProp) { return; }

            const oList = this._osfCodeLists().find((c) => c.prop === sProp);
            if (oList && sValue.length > oList.maxLen) {
                // Difesa client (DEC-40): oltre il limite di colonna il rifiuto arriverebbe da
                // CAP con un messaggio tecnico che non possiamo riscrivere. Qui invece si spiega.
                MessageBox.error(this._i18n().getText("osfCodeTooLong", [sValue, String(oList.maxLen)]));
                return;
            }

            const aCodes = (oOsf.getProperty("/" + sProp) || []).slice();
            if (aCodes.indexOf(sValue) < 0) {
                aCodes.push(sValue);
                oOsf.setProperty("/" + sProp, aCodes);
            }
            this.onProdOrderFilterDirty();
        },

        /** [W1-09] Rimozione di un token: si toglie dall'array, non solo dal controllo. */
        onProdOrderCodeTokenUpdate(oEvent) {
            const oInput = oEvent.getSource();
            const oOsf = this.getView().getModel("osf");
            const sProp = this._osfPropOf(oInput);
            if (!sProp) { return; }
            const aRemoved = (oEvent.getParameter("removedTokens") || []).map((t) => t.getKey());
            if (aRemoved.length) {
                const aCodes = (oOsf.getProperty("/" + sProp) || [])
                    .filter((c) => aRemoved.indexOf(c) < 0);
                oOsf.setProperty("/" + sProp, aCodes);
            }
            this.onProdOrderFilterDirty();
        },

        onSaveProdOrderFilter() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this._i18n();
            const oOsf = this.getView().getModel("osf");
            const oData = oOsf.getData();
            const sPlant = this._getPlantCode();
            if (!this._oOsfBinding) {
                // Il binding nasce in _loadProdOrderFilterConfig, dentro il gate isFullAdmin.
                return;
            }

            // Difesa client sulla contraddizione: uno stato richiesto ED escluso e' un criterio
            // che nessun ordine puo' soddisfare, cioe' un plant spento per errore. Il server lo
            // rifiuta comunque; dirlo qui evita all'utente il giro di andata e ritorno.
            const aBoth = (oData.required || []).filter((c) => (oData.excluded || []).indexOf(c) >= 0);
            if (aBoth.length) {
                MessageBox.error(oBundle.getText("osfContradiction", [aBoth.join(", ")]));
                return;
            }

            // [W1-09] Difesa client sulla lunghezza dei codici, per gli elenchi che potrebbero
            // arrivare da un salvataggio precedente o da una riga scritta a mano: il Submit la
            // controlla gia' token per token, questa e' la rete sull'insieme.
            const aTooLong = [];
            this._osfCodeLists().forEach((c) => {
                (oData[c.prop] || []).forEach((sCode) => {
                    if (String(sCode).length > c.maxLen) { aTooLong.push(sCode + " (max " + c.maxLen + ")"); }
                });
            });
            if (aTooLong.length) {
                MessageBox.error(oBundle.getText("osfCodeTooLong", [aTooLong.join(", "), ""]));
                return;
            }

            const sRequired = (oData.required || []).join(";");
            const sExcluded = (oData.excluded || []).join(";");
            const oPayload = {
                RequiredStatuses: sRequired,
                ExcludedStatuses: sExcluded
            };
            this._osfCodeLists().forEach((c) => { oPayload[c.field] = (oData[c.prop] || []).join(";"); });

            if (!this._oOsfCtx) {
                // Creazione LAZY: la riga nasce QUI, al primo salvataggio. E' anche il momento in
                // cui il plant entra in perimetro: prima di questo Save non leggeva ordini.
                this._oOsfCtx = RowCancel.watchCreate(this._oOsfBinding.create(Object.assign({ Plant: sPlant }, oPayload)));
                this._bOsfCreated = true;
            } else {
                Object.keys(oPayload).forEach((sKey) => this._oOsfCtx.setProperty(sKey, oPayload[sKey]));
            }

            oModel.submitBatch(PROD_ORDER_FILTER_GROUP).then(() => {
                if (oModel.hasPendingChanges(PROD_ORDER_FILTER_GROUP)) {
                    // submitBatch() NON rigetta quando il server rifiuta la singola richiesta:
                    // senza questo blocco l'utente non vedrebbe nulla. Le modifiche restano
                    // pendenti per la correzione.
                    MessageBox.error(this._collectProdOrderFilterErrors() ||
                        oBundle.getText("osfSaveError", [""]));
                    return;
                }
                this._bOsfCreated = false;
                // Si rilegge dal contesto: cio' che si vede e' il valore NORMALIZZATO dal server,
                // cioe' quello che verra' davvero valutato (stesso patto della 0014).
                this._setProdOrderFilterModel(this._oOsfCtx);
                // La conferma dichiara DA QUANDO ha effetto: gli ordini gia' inviati non vengono
                // rielaborati, e quelli che entrano ora entreranno alla prossima elaborazione.
                MessageToast.show(oBundle.getText("osfSaved", [sPlant]));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("osfSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelProdOrderFilter() {
            this.getView().getModel("catalog").resetChanges(PROD_ORDER_FILTER_GROUP);
            // Una riga mai salvata e' transient: scartarla la fa scomparire e il contesto non e'
            // piu' utilizzabile. Il flag evita di interrogare un contesto distrutto.
            if (this._bOsfCreated) {
                this._oOsfCtx = null;
                this._bOsfCreated = false;
            }
            this._setProdOrderFilterModel(this._oOsfCtx);
        },

        // L'app non ha un MessagePopover: senza questo i req.error(400, ...) del CAP sarebbero
        // invisibili. I controlli sono legati al modello JSON, quindi un messaggio con target non
        // si attacca da solo al campo e va mostrato in dialogo.
        _collectProdOrderFilterErrors() {
            return (Messaging.getMessageModel().getData() || [])
                .filter((m) => {
                    const sTarget = String(m.target || "");
                    return m.type === "Error" && (
                        sTarget.indexOf("ZProdOrderFilterConfig") >= 0 ||
                        sTarget.indexOf("RequiredStatuses") >= 0 ||
                        sTarget.indexOf("ExcludedStatuses") >= 0 ||
                        sTarget.indexOf("OrderTypes") >= 0 ||             // [W1-09]
                        sTarget.indexOf("ProductionSupervisors") >= 0 ||  // [W1-09]
                        !sTarget
                    );
                })
                .map((m) => m.message)
                .join("\n");
        },

        // ============================================================
        // [ORDER-TECO] LA CHIUSURA TECNICA RIPORTATA SU PLEX (feature 0023) — tab "Ordini di
        // produzione", terza sezione.
        //
        // PERCHE' ESISTE. Fino a qui `ZProdOrderTecoConfig` si scriveva SOLO con una POST OData a
        // mano: in esercizio nessuno poteva accendere la funzione, quindi il job `PROD_TECO`
        // girava e non chiudeva niente — chiudendo in verde, cioe' in modo indistinguibile da
        // «non c'era niente da fare». E' lo stesso schema di DEC-88.
        //
        // GEMELLA DEL BLOCCO 0017, CON LA SEMANTICA OPPOSTA: riusa lo STESSO catalogo di flag
        // (`osf>/catalog`, una fetch sola) ma li valuta in OR — «e' successa una di queste» —
        // mentre il perimetro li valuta in AND. Vedi srv/lib/prodOrderTeco.js.
        //
        // Persistenza su ZProdOrderTecoConfig (modello 'catalog', update group PROPRIO). La
        // validazione sta gia' sul server (`validateTecoConfig`), compreso il rifiuto della riga
        // accesa senza criteri: qui non si duplica, si dichiara.
        // ============================================================

        /** Stato inerte del blocco. `bUnknown` = la lettura non ha ancora risposto. */
        _prodOrderTecoState(oCtx, bUnknown) {
            const sPlant = this._getPlantCode();
            const bExists = !!oCtx;
            const oCurrent = this.getView().getModel("tec");
            return {
                plant: sPlant,
                exists: bExists || !!bUnknown,
                notConfiguredText: (bExists || bUnknown) ? "" :
                    this._i18n().getText("tecNotConfigured", [sPlant]),
                enabled: bExists ? !!oCtx.getProperty("IsEnabled") : false,
                triggers: bExists ? this._osfSplit(oCtx.getProperty("TriggerStatuses")) : [],
                // Il catalogo lo tiene il modello `osf`: e' lo stesso elenco, e una seconda copia
                // qui divergerebbe al primo flag aggiunto lato server.
                catalog: (oCurrent && oCurrent.getProperty("/catalog")) || [],
                dirty: false
            };
        },

        _setProdOrderTecoModel(oCtx, bUnknown) {
            this.getView().getModel("tec").setData(this._prodOrderTecoState(oCtx, bUnknown));
        },

        // Legge la configurazione TECO del plant corrente: UNA riga al massimo. Binding creato in
        // codice, come il gemello, perche' deve partire solo dentro il gate isFullAdmin.
        _loadProdOrderTecoConfig() {
            const oModel = this.getView().getModel("catalog");
            const sPlant = this._getPlantCode();
            if (!oModel || !sPlant) {
                return;
            }

            // filter() su un binding con modifiche pendenti lancia "Cannot filter due to pending
            // changes", e un contesto transient conserverebbe il plant PRECEDENTE nel payload
            // della POST. Si azzera prima, come nelle altre sezioni.
            if (oModel.hasPendingChanges(PROD_ORDER_TECO_GROUP)) {
                oModel.resetChanges(PROD_ORDER_TECO_GROUP);
            }
            this._oTecCtx = null;
            this._bTecCreated = false;
            this._setProdOrderTecoModel(null, true);

            // Il catalogo e' condiviso col blocco 0017 e la fetch e' memoizzata: qui si chiede
            // solo di travasarlo, cosi' la tendina si popola anche se l'altra sezione non e'
            // ancora arrivata.
            this._loadProdOrderStatusCatalog().then((aCatalog) => {
                this.getView().getModel("tec").setProperty("/catalog", aCatalog);
            });

            const oFilter = new Filter("Plant", FilterOperator.EQ, sPlant);
            if (!this._oTecBinding) {
                this._oTecBinding = oModel.bindList("/ZProdOrderTecoConfig", null, [], [oFilter], {
                    $$updateGroupId: PROD_ORDER_TECO_GROUP
                });
            } else {
                this._oTecBinding.filter(oFilter);
            }

            this._oTecBinding.requestContexts(0, 1).then((aContexts) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo.
                if (this._getPlantCode() !== sPlant) {
                    return;
                }
                this._oTecCtx = (aContexts && aContexts[0]) || null;
                this._setProdOrderTecoModel(this._oTecCtx);
            }).catch((oError) => {
                // Lettura non riuscita: si resta sui valori inerti SENZA dichiarare «non
                // configurato», che affermerebbe una cosa non verificata.
                console.warn(">>> [0023] lettura ZProdOrderTecoConfig non riuscita per il plant " +
                    sPlant + ": nessuna dichiarazione mostrata.", oError);
            });
        },

        // Nessun salvataggio implicito: la selezione marca solo il blocco come modificato.
        onProdOrderTecoDirty() {
            this.getView().getModel("tec").setProperty("/dirty", true);
        },

        onSaveProdOrderTeco() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this._i18n();
            const oTec = this.getView().getModel("tec");
            const oData = oTec.getData();
            const sPlant = this._getPlantCode();
            if (!this._oTecBinding) {
                // Il binding nasce in _loadProdOrderTecoConfig, dentro il gate isFullAdmin.
                return;
            }

            // Difesa client sulla riga «accesa e senza criteri»: il server la rifiuta comunque
            // (RB-19), ma una configurazione che sembra attiva e non chiude niente merita di
            // essere fermata prima del giro di andata e ritorno.
            if (oData.enabled && !(oData.triggers || []).length) {
                MessageBox.error(oBundle.getText("tecNoTriggers"));
                return;
            }

            const oPayload = {
                IsEnabled: !!oData.enabled,
                TriggerStatuses: (oData.triggers || []).join(";")
            };

            if (!this._oTecCtx) {
                // Creazione LAZY: la riga nasce QUI, al primo salvataggio.
                this._oTecCtx = RowCancel.watchCreate(this._oTecBinding.create(Object.assign({ Plant: sPlant }, oPayload)));
                this._bTecCreated = true;
            } else {
                Object.keys(oPayload).forEach((sKey) => this._oTecCtx.setProperty(sKey, oPayload[sKey]));
            }

            oModel.submitBatch(PROD_ORDER_TECO_GROUP).then(() => {
                if (oModel.hasPendingChanges(PROD_ORDER_TECO_GROUP)) {
                    // submitBatch() NON rigetta quando il server rifiuta la singola richiesta.
                    MessageBox.error(this._collectProdOrderTecoErrors() ||
                        oBundle.getText("tecSaveError", [""]));
                    return;
                }
                this._bTecCreated = false;
                // Si rilegge dal contesto: cio' che si vede e' l'elenco NORMALIZZATO dal server.
                this._setProdOrderTecoModel(this._oTecCtx);
                MessageToast.show(oBundle.getText("tecSaved", [sPlant]));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("tecSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelProdOrderTeco() {
            this.getView().getModel("catalog").resetChanges(PROD_ORDER_TECO_GROUP);
            // Una riga mai salvata e' transient: scartarla la fa scomparire e il contesto non e'
            // piu' utilizzabile. Il flag evita di interrogare un contesto distrutto.
            if (this._bTecCreated) {
                this._oTecCtx = null;
                this._bTecCreated = false;
            }
            this._setProdOrderTecoModel(this._oTecCtx);
        },

        _collectProdOrderTecoErrors() {
            return (Messaging.getMessageModel().getData() || [])
                .filter((m) => {
                    const sTarget = String(m.target || "");
                    return m.type === "Error" && (
                        sTarget.indexOf("ZProdOrderTecoConfig") >= 0 ||
                        sTarget.indexOf("TriggerStatuses") >= 0 ||
                        !sTarget
                    );
                })
                .map((m) => m.message)
                .join("\n");
        },

        // ============================================================
        // [ORDER-COMPLETE] IL JOB COMPLETATO SU PLEX -> STATO UTENTE IN SAP (feature 0045, gap
        // W1-12) — tab "Ordini di produzione", quarta sezione.
        //
        // GEMELLO DEL BLOCCO 0023 CON IL VERSO OPPOSTO, e con una differenza che cambia il
        // controllo a schermo: la' i criteri si SCELGONO da un catalogo chiuso (i campi di
        // A_ProductionOrder_2), qui si SCRIVONO, perche' gli stati di un job Plex sono una tabella
        // di setup del tenant e nessun endpoint della Job Scheduling API la elenca (DEC-65). Da
        // qui il `MultiInput` a token liberi invece del `SearchMultiComboBox`.
        //
        // Persistenza su ZProdOrderCompleteConfig (modello 'catalog', update group PROPRIO). La
        // validazione sta gia' sul server (`validateCompleteConfig`), compreso il rifiuto della
        // riga accesa senza stati: qui non si duplica, si dichiara.
        // ============================================================

        /**
         * L'elenco `;`-separato -> token del MultiInput. Vuoti e doppioni si scartano.
         *
         * CONDIVISA fra la quarta sezione (job completato, 0045) e la quinta (job pianificato,
         * 0046): e' l'unica LOGICA che i due blocchi hanno: tutto il resto e' cablaggio legato a
         * un modello e a un update group suoi. Due copie divergerebbero sul confronto dei
         * doppioni, che qui deve restare quello del server (insensibile al maiuscolo).
         */
        _statusTokens(sList) {
            const aSeen = [];
            return String(sList || "").split(";")
                .map((s) => String(s || "").trim())
                .filter((s) => {
                    if (!s) { return false; }
                    const sKey = s.toLowerCase();
                    if (aSeen.indexOf(sKey) >= 0) { return false; }
                    aSeen.push(sKey);
                    return true;
                })
                .map((s) => ({ key: s, text: s }));
        },

        /** Stato inerte del blocco. `bUnknown` = la lettura non ha ancora risposto. */
        _prodOrderCompleteState(oCtx, bUnknown) {
            const sPlant = this._getPlantCode();
            const bExists = !!oCtx;
            return {
                plant: sPlant,
                exists: bExists || !!bUnknown,
                notConfiguredText: (bExists || bUnknown) ? "" :
                    this._i18n().getText("cmpNotConfigured", [sPlant]),
                enabled: bExists ? !!oCtx.getProperty("IsEnabled") : false,
                statusTokens: bExists ? this._statusTokens(oCtx.getProperty("PlexStatuses")) : [],
                dirty: false
            };
        },

        _setProdOrderCompleteModel(oCtx, bUnknown) {
            this.getView().getModel("cmp").setData(this._prodOrderCompleteState(oCtx, bUnknown));
        },

        // Legge la configurazione del plant corrente: UNA riga al massimo. Binding creato in
        // codice, come il gemello, perche' deve partire solo dentro il gate isFullAdmin.
        _loadProdOrderCompleteConfig() {
            const oModel = this.getView().getModel("catalog");
            const sPlant = this._getPlantCode();
            if (!oModel || !sPlant) {
                return;
            }

            // filter() su un binding con modifiche pendenti lancia "Cannot filter due to pending
            // changes", e un contesto transient conserverebbe il plant PRECEDENTE nel payload
            // della POST. Si azzera prima, come nelle altre sezioni.
            if (oModel.hasPendingChanges(PROD_ORDER_COMPLETE_GROUP)) {
                oModel.resetChanges(PROD_ORDER_COMPLETE_GROUP);
            }
            this._oCmpCtx = null;
            this._bCmpCreated = false;
            this._setProdOrderCompleteModel(null, true);

            const oFilter = new Filter("Plant", FilterOperator.EQ, sPlant);
            if (!this._oCmpBinding) {
                this._oCmpBinding = oModel.bindList("/ZProdOrderCompleteConfig", null, [], [oFilter], {
                    $$updateGroupId: PROD_ORDER_COMPLETE_GROUP
                });
            } else {
                this._oCmpBinding.filter(oFilter);
            }

            this._oCmpBinding.requestContexts(0, 1).then((aContexts) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo.
                if (this._getPlantCode() !== sPlant) {
                    return;
                }
                this._oCmpCtx = (aContexts && aContexts[0]) || null;
                this._setProdOrderCompleteModel(this._oCmpCtx);
            }).catch((oError) => {
                // Lettura non riuscita: si resta sui valori inerti SENZA dichiarare «non
                // configurato», che affermerebbe una cosa non verificata.
                console.warn(">>> [0045] lettura ZProdOrderCompleteConfig non riuscita per il " +
                    "plant " + sPlant + ": nessuna dichiarazione mostrata.", oError);
            });
        },

        // Nessun salvataggio implicito: la modifica marca solo il blocco come modificato.
        onProdOrderCompleteDirty() {
            this.getView().getModel("cmp").setProperty("/dirty", true);
        },

        /**
         * Invio nel MultiInput: il testo digitato diventa un token.
         *
         * Senza questo handler l'Invio non farebbe NIENTE e il campo sembrerebbe rotto: un
         * `MultiInput` senza value help non crea token da se'. Il doppione si scarta in silenzio —
         * due grafie dello stesso stato non sono due criteri — e il confronto e' insensibile al
         * maiuscolo, come quello del server.
         */
        onProdOrderCompleteStatusSubmit(oEvent) {
            const oInput = oEvent.getSource();
            const sValue = String(oEvent.getParameter("value") || "").trim();
            oInput.setValue("");
            if (!sValue) {
                return;
            }
            const oCmp = this.getView().getModel("cmp");
            const aTokens = (oCmp.getProperty("/statusTokens") || []).slice();
            const sKey = sValue.toLowerCase();
            if (aTokens.some((t) => String(t.key || "").toLowerCase() === sKey)) {
                return;
            }
            aTokens.push({ key: sValue, text: sValue });
            oCmp.setProperty("/statusTokens", aTokens);
            oCmp.setProperty("/dirty", true);
        },

        /**
         * Rimozione di un token.
         *
         * Il modello va aggiornato A MANO: `tokenUpdate` con `Removed` non riscrive l'aggregazione
         * legata, quindi senza questo handler il token sparirebbe a schermo e riapparirebbe al
         * primo refresh del binding — cioe' l'utente crederebbe di averlo tolto.
         */
        onProdOrderCompleteTokenUpdate(oEvent) {
            if (oEvent.getParameter("type") !== "removed") {
                return;
            }
            const aRemoved = (oEvent.getParameter("removedTokens") || [])
                .map((t) => String(t.getKey() || t.getText() || "").toLowerCase());
            if (!aRemoved.length) {
                return;
            }
            const oCmp = this.getView().getModel("cmp");
            const aTokens = (oCmp.getProperty("/statusTokens") || [])
                .filter((t) => aRemoved.indexOf(String(t.key || "").toLowerCase()) < 0);
            oCmp.setProperty("/statusTokens", aTokens);
            oCmp.setProperty("/dirty", true);
        },

        onSaveProdOrderComplete() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this._i18n();
            const oCmp = this.getView().getModel("cmp");
            const oData = oCmp.getData();
            const sPlant = this._getPlantCode();
            if (!this._oCmpBinding) {
                // Il binding nasce in _loadProdOrderCompleteConfig, dentro il gate isFullAdmin.
                return;
            }

            const aStatuses = (oData.statusTokens || [])
                .map((t) => String(t.key || t.text || "").trim())
                .filter(Boolean);

            // Difesa client sulla riga «accesa e senza stati»: il server la rifiuta comunque, ma una
            // configurazione che sembra attiva e non scrive niente merita di essere fermata prima
            // del giro di andata e ritorno.
            if (oData.enabled && !aStatuses.length) {
                MessageBox.error(oBundle.getText("cmpNoStatuses"));
                return;
            }

            const oPayload = {
                IsEnabled: !!oData.enabled,
                PlexStatuses: aStatuses.join(";")
            };

            if (!this._oCmpCtx) {
                // Creazione LAZY: la riga nasce QUI, al primo salvataggio.
                this._oCmpCtx = RowCancel.watchCreate(this._oCmpBinding.create(Object.assign({ Plant: sPlant }, oPayload)));
                this._bCmpCreated = true;
            } else {
                Object.keys(oPayload).forEach((sKey) => this._oCmpCtx.setProperty(sKey, oPayload[sKey]));
            }

            oModel.submitBatch(PROD_ORDER_COMPLETE_GROUP).then(() => {
                if (oModel.hasPendingChanges(PROD_ORDER_COMPLETE_GROUP)) {
                    // submitBatch() NON rigetta quando il server rifiuta la singola richiesta.
                    MessageBox.error(this._collectProdOrderCompleteErrors() ||
                        oBundle.getText("cmpSaveError", [""]));
                    return;
                }
                this._bCmpCreated = false;
                // Si rilegge dal contesto: cio' che si vede e' l'elenco NORMALIZZATO dal server.
                this._setProdOrderCompleteModel(this._oCmpCtx);
                MessageToast.show(oBundle.getText("cmpSaved", [sPlant]));
            }).catch((err) => {
                MessageBox.error(
                    oBundle.getText("cmpSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelProdOrderComplete() {
            this.getView().getModel("catalog").resetChanges(PROD_ORDER_COMPLETE_GROUP);
            // Una riga mai salvata e' transient: scartarla la fa scomparire e il contesto non e'
            // piu' utilizzabile. Il flag evita di interrogare un contesto distrutto.
            if (this._bCmpCreated) {
                this._oCmpCtx = null;
                this._bCmpCreated = false;
            }
            this._setProdOrderCompleteModel(this._oCmpCtx);
        },

        _collectProdOrderCompleteErrors() {
            return (Messaging.getMessageModel().getData() || [])
                .filter((m) => {
                    const sTarget = String(m.target || "");
                    return m.type === "Error" && (
                        sTarget.indexOf("ZProdOrderCompleteConfig") >= 0 ||
                        sTarget.indexOf("PlexStatuses") >= 0 ||
                        !sTarget
                    );
                })
                .map((m) => m.message)
                .join("\n");
        },

        // ============================================================
        // [ORDER-SCHEDULED] IL JOB PIANIFICATO SU PLEX -> STATO UTENTE IN SAP (feature 0046, gap
        // W1-11) — tab "Ordini di produzione", quinta sezione.
        //
        // GEMELLO DEL BLOCCO QUI SOPRA, sull'altro estremo del ciclo. Il cablaggio e' lo stesso e
        // resta due volte di proposito: sono due modelli, due update group e due gruppi di chiavi
        // i18n, cioe' cio' che UI5 lega per NOME. L'unica LOGICA — la conversione dei token — sta
        // invece in una funzione sola (`_statusTokens`), perche' quella si puo' condividere e due
        // copie divergerebbero. Le REGOLE, quelle che decidono cosa il flusso fa, stanno tutte nel
        // server e in un modulo solo (srv/lib/orderStatusFlow.js): qui non se ne duplica nessuna.
        //
        // Persistenza su ZProdOrderScheduledConfig (modello 'catalog', update group PROPRIO). La
        // validazione sta gia' sul server (`validateScheduledConfig`), compreso il rifiuto della
        // riga accesa senza stati: qui non si duplica, si dichiara.
        // ============================================================

        /** Stato inerte del blocco. `bUnknown` = la lettura non ha ancora risposto. */
        _prodOrderScheduledState(oCtx, bUnknown) {
            const sPlant = this._getPlantCode();
            const bExists = !!oCtx;
            return {
                plant: sPlant,
                exists: bExists || !!bUnknown,
                notConfiguredText: (bExists || bUnknown) ? "" :
                    this._i18n().getText("schNotConfigured", [sPlant]),
                enabled: bExists ? !!oCtx.getProperty("IsEnabled") : false,
                statusTokens: bExists ? this._statusTokens(oCtx.getProperty("PlexStatuses")) : [],
                dirty: false
            };
        },

        _setProdOrderScheduledModel(oCtx, bUnknown) {
            this.getView().getModel("sch").setData(this._prodOrderScheduledState(oCtx, bUnknown));
        },

        // Legge la configurazione del plant corrente: UNA riga al massimo. Binding creato in
        // codice, come il gemello, perche' deve partire solo dentro il gate isFullAdmin.
        _loadProdOrderScheduledConfig() {
            const oModel = this.getView().getModel("catalog");
            const sPlant = this._getPlantCode();
            if (!oModel || !sPlant) {
                return;
            }

            // filter() su un binding con modifiche pendenti lancia "Cannot filter due to pending
            // changes", e un contesto transient conserverebbe il plant PRECEDENTE nel payload
            // della POST. Si azzera prima, come nelle altre sezioni.
            if (oModel.hasPendingChanges(PROD_ORDER_SCHEDULED_GROUP)) {
                oModel.resetChanges(PROD_ORDER_SCHEDULED_GROUP);
            }
            this._oSchCtx = null;
            this._bSchCreated = false;
            this._setProdOrderScheduledModel(null, true);

            const oFilter = new Filter("Plant", FilterOperator.EQ, sPlant);
            if (!this._oSchBinding) {
                this._oSchBinding = oModel.bindList("/ZProdOrderScheduledConfig", null, [], [oFilter], {
                    $$updateGroupId: PROD_ORDER_SCHEDULED_GROUP
                });
            } else {
                this._oSchBinding.filter(oFilter);
            }

            this._oSchBinding.requestContexts(0, 1).then((aContexts) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo.
                if (this._getPlantCode() !== sPlant) {
                    return;
                }
                this._oSchCtx = (aContexts && aContexts[0]) || null;
                this._setProdOrderScheduledModel(this._oSchCtx);
            }).catch((oError) => {
                // Lettura non riuscita: si resta sui valori inerti SENZA dichiarare «non
                // configurato», che affermerebbe una cosa non verificata.
                console.warn(">>> [0046] lettura ZProdOrderScheduledConfig non riuscita per il " +
                    "plant " + sPlant + ": nessuna dichiarazione mostrata.", oError);
            });
        },

        // Nessun salvataggio implicito: la modifica marca solo il blocco come modificato.
        onProdOrderScheduledDirty() {
            this.getView().getModel("sch").setProperty("/dirty", true);
        },

        /**
         * Invio nel MultiInput: il testo digitato diventa un token.
         *
         * Senza questo handler l'Invio non farebbe NIENTE e il campo sembrerebbe rotto: un
         * `MultiInput` senza value help non crea token da se'. Il doppione si scarta in silenzio —
         * due grafie dello stesso stato non sono due criteri — e il confronto e' insensibile al
         * maiuscolo, come quello del server.
         */
        onProdOrderScheduledStatusSubmit(oEvent) {
            const oInput = oEvent.getSource();
            const sValue = String(oEvent.getParameter("value") || "").trim();
            oInput.setValue("");
            if (!sValue) {
                return;
            }
            const oSch = this.getView().getModel("sch");
            const aTokens = (oSch.getProperty("/statusTokens") || []).slice();
            const sKey = sValue.toLowerCase();
            if (aTokens.some((t) => String(t.key || "").toLowerCase() === sKey)) {
                return;
            }
            aTokens.push({ key: sValue, text: sValue });
            oSch.setProperty("/statusTokens", aTokens);
            oSch.setProperty("/dirty", true);
        },

        /**
         * Rimozione di un token.
         *
         * Il modello va aggiornato A MANO: `tokenUpdate` con `Removed` non riscrive l'aggregazione
         * legata, quindi senza questo handler il token sparirebbe a schermo e riapparirebbe al
         * primo refresh del binding — cioe' l'utente crederebbe di averlo tolto.
         */
        onProdOrderScheduledTokenUpdate(oEvent) {
            if (oEvent.getParameter("type") !== "removed") {
                return;
            }
            const aRemoved = (oEvent.getParameter("removedTokens") || [])
                .map((t) => String(t.getKey() || t.getText() || "").toLowerCase());
            if (!aRemoved.length) {
                return;
            }
            const oSch = this.getView().getModel("sch");
            const aTokens = (oSch.getProperty("/statusTokens") || [])
                .filter((t) => aRemoved.indexOf(String(t.key || "").toLowerCase()) < 0);
            oSch.setProperty("/statusTokens", aTokens);
            oSch.setProperty("/dirty", true);
        },

        onSaveProdOrderScheduled() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this._i18n();
            const oSch = this.getView().getModel("sch");
            const oData = oSch.getData();
            const sPlant = this._getPlantCode();
            if (!this._oSchBinding) {
                // Il binding nasce in _loadProdOrderScheduledConfig, dentro il gate isFullAdmin.
                return;
            }

            const aStatuses = (oData.statusTokens || [])
                .map((t) => String(t.key || t.text || "").trim())
                .filter(Boolean);

            // Difesa client sulla riga «accesa e senza stati»: il server la rifiuta comunque, ma una
            // configurazione che sembra attiva e non scrive niente merita di essere fermata prima
            // del giro di andata e ritorno.
            if (oData.enabled && !aStatuses.length) {
                MessageBox.error(oBundle.getText("schNoStatuses"));
                return;
            }

            const oPayload = {
                IsEnabled: !!oData.enabled,
                PlexStatuses: aStatuses.join(";")
            };

            if (!this._oSchCtx) {
                // Creazione LAZY: la riga nasce QUI, al primo salvataggio.
                this._oSchCtx = RowCancel.watchCreate(this._oSchBinding.create(Object.assign({ Plant: sPlant }, oPayload)));
                this._bSchCreated = true;
            } else {
                Object.keys(oPayload).forEach((sKey) => this._oSchCtx.setProperty(sKey, oPayload[sKey]));
            }

            oModel.submitBatch(PROD_ORDER_SCHEDULED_GROUP).then(() => {
                if (oModel.hasPendingChanges(PROD_ORDER_SCHEDULED_GROUP)) {
                    // submitBatch() NON rigetta quando il server rifiuta la singola richiesta.
                    MessageBox.error(this._collectProdOrderScheduledErrors() ||
                        oBundle.getText("schSaveError", [""]));
                    return;
                }
                this._bSchCreated = false;
                // Si rilegge dal contesto: cio' che si vede e' l'elenco NORMALIZZATO dal server.
                this._setProdOrderScheduledModel(this._oSchCtx);
                MessageToast.show(oBundle.getText("schSaved", [sPlant]));
            }).catch((err) => {
                MessageBox.error(
                    oBundle.getText("schSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelProdOrderScheduled() {
            this.getView().getModel("catalog").resetChanges(PROD_ORDER_SCHEDULED_GROUP);
            // Una riga mai salvata e' transient: scartarla la fa scomparire e il contesto non e'
            // piu' utilizzabile. Il flag evita di interrogare un contesto distrutto.
            if (this._bSchCreated) {
                this._oSchCtx = null;
                this._bSchCreated = false;
            }
            this._setProdOrderScheduledModel(this._oSchCtx);
        },

        _collectProdOrderScheduledErrors() {
            return (Messaging.getMessageModel().getData() || [])
                .filter((m) => {
                    const sTarget = String(m.target || "");
                    return m.type === "Error" && (
                        sTarget.indexOf("ZProdOrderScheduledConfig") >= 0 ||
                        sTarget.indexOf("PlexStatuses") >= 0 ||
                        !sTarget
                    );
                })
                .map((m) => m.message)
                .join("\n");
        },

        // ============================================================
        // [PHANTOM-EXPLODE] ESPLOSIONE DEI COMPONENTI FANTASMA (feature 0019) — tab "Distinta
        // base" (parametri del motore), "Routings" e "Ordini di produzione" (i due interruttori).
        //
        // UNA RIGA, TRE TAB, UN MODELLO. La distinta di un materiale e' la stessa da qualunque
        // parte la si guardi: due profondita' diverse per lo stesso plant sarebbero solo un modo
        // di ottenere due alberi diversi dallo stesso dato. Gli INTERRUTTORI sono invece due e
        // indipendenti, perche' i due innesti hanno rischi diversi e vanno accesi uno alla volta.
        //
        // Riga assente = nessuna esplosione, cioe' il comportamento di prima della 0019: e' per
        // questo che l'avviso di «non configurato» qui e' un'Information e non un Warning come
        // nel blocco 0017, dove la mancanza di configurazione FERMA il plant.
        //
        // Persistenza su ZPhantomExplodeConfig (modello 'catalog', update group PHANTOM_GROUP).
        // Semantica lato server: srv/lib/bomExplodeRules.js e srv/lib/bomExplode.js.
        // ============================================================

        /** Stato inerte del blocco. `bUnknown` = la lettura non ha ancora risposto. */
        _phantomState(oCtx, bUnknown) {
            const sPlant = this._getPlantCode();
            const bExists = !!oCtx;
            return {
                plant: sPlant,
                exists: bExists || !!bUnknown,
                // Composto qui e non nella view: ha un segnaposto e, in italiano, apostrofi che
                // solo getText() con argomenti risolve.
                notConfiguredText: (bExists || bUnknown) ? "" :
                    this._i18n().getText("phxNotConfigured", [sPlant]),
                // I default coincidono con quelli dello schema: un blocco che mostrasse valori
                // diversi da quelli che nascerebbero al primo salvataggio mentirebbe.
                maxDepth: bExists ? String(oCtx.getProperty("MaxDepth")) : "5",
                bomUsage: bExists ? (oCtx.getProperty("BomUsage") || "") : "",
                bomVariant: bExists ? (oCtx.getProperty("BomVariant") || "") : "",
                dateMode: bExists ? (oCtx.getProperty("EffectivityDateMode") || "TODAY") : "TODAY",
                // [ROUTING-COMP-SOURCE] La data della seconda lettura del ramo cicli (feature
                // 0025). VUOTA di default, e vuota significa «seconda lettura spenta»: il
                // comportamento di prima. Il DatePicker lavora sulla stringa `yyyy-MM-dd`, che e'
                // esattamente la forma in cui CAP restituisce un campo Date — nessuna conversione
                // e nessun fuso orario di mezzo, che su una data di validita' sarebbe il modo di
                // spostarla di un giorno senza accorgersene.
                routingBomKeyDate: bExists ? (oCtx.getProperty("RoutingBomKeyDate") || "") : "",
                inRouting: bExists ? !!oCtx.getProperty("ExplodeInRouting") : false,
                inProdOrder: bExists ? !!oCtx.getProperty("ExplodeInProdOrder") : false,
                // [ROUTING-DEFAULT-OP] L'allocazione dichiarata (feature 0051). Spenta di default,
                // e spenta significa «component allocation, come sempre». Il bersaglio nasce su
                // FIRST_OP perche' la tendina deve mostrare qualcosa, ma non e' un default del
                // dato: a spunta spenta il salvataggio scrive quello che c'e' e nessuno lo legge;
                // ad accendere la spunta senza scegliere, il server rifiuta.
                compDefaultOp: bExists ? !!oCtx.getProperty("RoutingCompDefaultOp") : false,
                compDefaultOpTarget: bExists
                    ? (oCtx.getProperty("RoutingCompDefaultOpTarget") || FIRST_OP) : FIRST_OP,
                depthState: "None",
                depthStateText: "",
                keyDateState: "None",
                keyDateStateText: "",
                dirty: false
            };
        },

        _setPhantomModel(oCtx, bUnknown) {
            this.getView().getModel("phx").setData(this._phantomState(oCtx, bUnknown));
        },

        // Legge la configurazione del plant corrente: UNA riga al massimo. Binding creato in
        // codice, non nel fragment, perche' deve partire solo dentro il gate isFullAdmin.
        _loadPhantomConfig() {
            const oModel = this.getView().getModel("catalog");
            const sPlant = this._getPlantCode();
            if (!oModel || !sPlant) {
                return;
            }

            // filter() su un binding con modifiche pendenti lancia "Cannot filter due to pending
            // changes", e un contesto transient conserverebbe il plant PRECEDENTE nel payload
            // della POST. Si azzera prima, come nelle altre sezioni.
            if (oModel.hasPendingChanges(PHANTOM_GROUP)) {
                oModel.resetChanges(PHANTOM_GROUP);
            }
            this._oPhxCtx = null;
            this._bPhxCreated = false;
            this._setPhantomModel(null, true);

            const oFilter = new Filter("Plant", FilterOperator.EQ, sPlant);
            if (!this._oPhxBinding) {
                this._oPhxBinding = oModel.bindList("/ZPhantomExplodeConfig", null, [], [oFilter], {
                    $$updateGroupId: PHANTOM_GROUP
                });
            } else {
                this._oPhxBinding.filter(oFilter);
            }

            this._oPhxBinding.requestContexts(0, 1).then((aContexts) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo.
                if (this._getPlantCode() !== sPlant) {
                    return;
                }
                this._oPhxCtx = (aContexts && aContexts[0]) || null;
                this._setPhantomModel(this._oPhxCtx);
            }).catch((oError) => {
                // Lettura non riuscita: si resta sui valori inerti SENZA dichiarare «non
                // configurato», che affermerebbe una cosa non verificata.
                console.warn(">>> [0019] lettura ZPhantomExplodeConfig non riuscita per il plant " +
                    sPlant + ": nessuna dichiarazione mostrata.", oError);
            });
        },

        // Nessun salvataggio implicito: la modifica marca solo il blocco come modificato. La
        // profondita' si valida anche qui, ma solo come AVVISO: la decisione resta del server
        // (che la rifiuta con lo stesso messaggio), questo serve a non far fare il giro.
        onPhantomDirty() {
            const oPhx = this.getView().getModel("phx");
            oPhx.setProperty("/dirty", true);
            const sRaw = String(oPhx.getProperty("/maxDepth") || "").trim();
            const iDepth = Number(sRaw);
            const bBad = !sRaw || !Number.isInteger(iDepth) || iDepth < 1 || iDepth > 20;
            oPhx.setProperty("/depthState", bBad ? "Error" : "None");
            oPhx.setProperty("/depthStateText",
                bBad ? this._i18n().getText("phxDepthRange", [1, 20, sRaw || "(vuoto)"]) : "");
        },

        // [ROUTING-COMP-SOURCE] Il DatePicker segnala da se' una data non interpretabile
        // (`valid` a false quando l'utente digita a mano qualcosa che non e' una data): senza
        // questo, il campo resterebbe visivamente a posto e il rifiuto arriverebbe dal server.
        onPhantomKeyDateChange(oEvent) {
            const oPhx = this.getView().getModel("phx");
            oPhx.setProperty("/dirty", true);
            const bValid = oEvent.getParameter("valid") !== false;
            oPhx.setProperty("/keyDateState", bValid ? "None" : "Error");
            oPhx.setProperty("/keyDateStateText", bValid ? "" :
                this._i18n().getText("phxKeyDateInvalid", [oEvent.getParameter("value") || ""]));
        },

        onSavePhantomConfig() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this._i18n();
            const oPhx = this.getView().getModel("phx");
            const oData = oPhx.getData();
            const sPlant = this._getPlantCode();
            if (!this._oPhxBinding) {
                // Il binding nasce in _loadPhantomConfig, dentro il gate isFullAdmin.
                return;
            }

            // La profondita' e' l'unico campo che puo' essere fuori scala. Fermarsi qui evita
            // all'utente il giro di andata e ritorno; il server la rifiuta comunque.
            const iDepth = Number(String(oData.maxDepth || "").trim());
            if (!Number.isInteger(iDepth) || iDepth < 1 || iDepth > 20) {
                MessageBox.error(oBundle.getText("phxDepthRange", [1, 20, oData.maxDepth || "(vuoto)"]));
                return;
            }

            // [ROUTING-COMP-SOURCE] La data si valida qui come il resto: vuota e' legittima
            // (seconda lettura spenta), scritta male no — a runtime diventerebbe anch'essa
            // «spenta», cioe' un campo compilato che non fa niente. Il server la rifiuta comunque,
            // questo evita il giro di andata e ritorno.
            const sKeyDate = String(oData.routingBomKeyDate || "").trim();
            if (sKeyDate && !/^\d{4}-\d{2}-\d{2}$/.test(sKeyDate)) {
                MessageBox.error(oBundle.getText("phxKeyDateInvalid", [sKeyDate]));
                return;
            }

            // [ROUTING-DEFAULT-OP] Il bersaglio si pretende SOLO a spunta accesa: spegnere la
            // spunta senza svuotare la tendina non deve rendere la scheda non salvabile. Stessa
            // regola del server (`validateCompDefaultOp`), qui solo per evitare il giro.
            const bCompDefaultOp = !!oData.compDefaultOp;
            const sCompTarget = String(oData.compDefaultOpTarget || "").trim().toUpperCase();
            if (bCompDefaultOp && sCompTarget !== FIRST_OP && sCompTarget !== LAST_OP) {
                MessageBox.error(oBundle.getText("phxDefaultOpTargetMandatory"));
                return;
            }

            const oValues = {
                MaxDepth: iDepth,
                BomUsage: String(oData.bomUsage || "").trim().toUpperCase(),
                BomVariant: String(oData.bomVariant || "").trim().toUpperCase(),
                EffectivityDateMode: oData.dateMode || "TODAY",
                // `null` e non stringa vuota: su un campo Date la stringa vuota e' un valore non
                // convertibile, mentre `null` e' «non impostata», che e' quello che si intende.
                RoutingBomKeyDate: sKeyDate || null,
                ExplodeInRouting: !!oData.inRouting,
                ExplodeInProdOrder: !!oData.inProdOrder,
                RoutingCompDefaultOp: bCompDefaultOp,
                RoutingCompDefaultOpTarget: sCompTarget
            };

            if (!this._oPhxCtx) {
                // Creazione LAZY: la riga nasce QUI, al primo salvataggio.
                this._oPhxCtx = RowCancel.watchCreate(this._oPhxBinding.create(Object.assign({ Plant: sPlant }, oValues)));
                this._bPhxCreated = true;
            } else {
                Object.keys(oValues).forEach((k) => this._oPhxCtx.setProperty(k, oValues[k]));
            }

            oModel.submitBatch(PHANTOM_GROUP).then(() => {
                if (oModel.hasPendingChanges(PHANTOM_GROUP)) {
                    // submitBatch() NON rigetta quando il server rifiuta la singola richiesta:
                    // senza questo blocco l'utente non vedrebbe nulla.
                    MessageBox.error(this._collectPhantomErrors() ||
                        oBundle.getText("phxSaveError", [""]));
                    return;
                }
                this._bPhxCreated = false;
                // Si rilegge dal contesto: cio' che si vede e' il valore NORMALIZZATO dal server.
                this._setPhantomModel(this._oPhxCtx);
                // La conferma dichiara DA QUANDO ha effetto: i cicli e gli ordini gia' inviati non
                // vengono rielaborati.
                MessageToast.show(oBundle.getText("phxSaved", [sPlant]));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("phxSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelPhantomConfig() {
            this.getView().getModel("catalog").resetChanges(PHANTOM_GROUP);
            // Una riga mai salvata e' transient: scartarla la fa scomparire e il contesto non e'
            // piu' utilizzabile. Il flag evita di interrogare un contesto distrutto.
            if (this._bPhxCreated) {
                this._oPhxCtx = null;
                this._bPhxCreated = false;
            }
            this._setPhantomModel(this._oPhxCtx);
        },

        // ============================================================
        // [CONF-POSTING] Feature 0028 — Consumi e scarti della consuntivazione, per plant.
        //
        // Stessa meccanica del blocco dei fantasma e del perimetro ordini: una riga per plant che
        // puo' NON esistere, controlli legati a un modello JSON, creazione LAZY al primo
        // salvataggio, e un update group proprio.
        //
        // I DEFAULT MOSTRATI SONO QUELLI DELLO SCHEMA, e non e' un dettaglio: un blocco che
        // mostrasse valori diversi da quelli che nascerebbero al primo salvataggio mentirebbe, e qui
        // la bugia riguarderebbe movimenti di magazzino.
        // ============================================================

        _confPostingState(oCtx, bUnknown) {
            const bExists = !!oCtx;
            const sPlant = this._getPlantCode() || "";
            return {
                exists: bExists || !!bUnknown,
                notConfiguredText: (bExists || bUnknown) ? "" :
                    this._i18n().getText("cpcNotConfigured", [sPlant]),
                // [CONF-POSTING] Feature 0030: il canale e il suo interruttore. `=== true` e' la
                // lettura sicura di un flag che autorizza una scrittura contabile — una colonna
                // appena aggiunta e non retro-riempita legge `null`, e deve valere spento.
                prodPosting: bExists ? (oCtx.getProperty("ProdPosting") || "MATDOC") : "MATDOC",
                confPostEnabled: bExists ? oCtx.getProperty("ConfPostEnabled") === true : false,
                channelWarnText: "",
                consumeAt: bExists ? (oCtx.getProperty("ConsumeAt") || "LAST") : "LAST",
                scrapConsume: bExists ? (oCtx.getProperty("ScrapConsume") || "NONE") : "NONE",
                scrapMove: bExists ? (oCtx.getProperty("ScrapMove") || "ISSUE") : "ISSUE",
                scrapIssue: bExists ? (oCtx.getProperty("ScrapIssue") || "ALWAYS") : "ALWAYS",
                scrapNoOrder: bExists ? (oCtx.getProperty("ScrapNoOrder") || "OFF") : "OFF",
                scrapStorLoc: bExists ? (oCtx.getProperty("ScrapStorLoc") || "") : "",
                scrapReason: bExists ? (oCtx.getProperty("ScrapReason") || "") : "",
                scrapHeadTxt: bExists ? (oCtx.getProperty("ScrapHeadTxt") || "") : "",
                scrapLateTxt: bExists ? (oCtx.getProperty("ScrapLateTxt") || "") : "",
                warnText: "",
                dirty: false
            };
        },

        _setConfPostingModel(oCtx, bUnknown) {
            this.getView().getModel("cpc").setData(this._confPostingState(oCtx, bUnknown));
        },

        _loadConfPostingConfig() {
            const oModel = this.getView().getModel("catalog");
            const sPlant = this._getPlantCode();
            if (!oModel || !sPlant) {
                return;
            }

            // filter() su un binding con modifiche pendenti lancia "Cannot filter due to pending
            // changes", e un contesto transient conserverebbe il plant PRECEDENTE nel payload della
            // POST. Si azzera prima, come nelle altre sezioni.
            if (oModel.hasPendingChanges(CONF_POSTING_GROUP)) {
                oModel.resetChanges(CONF_POSTING_GROUP);
            }
            this._oCpcCtx = null;
            this._bCpcCreated = false;
            this._setConfPostingModel(null, true);

            const oFilter = new Filter("Plant", FilterOperator.EQ, sPlant);
            if (!this._oCpcBinding) {
                this._oCpcBinding = oModel.bindList("/ZProdConfPostingConfig", null, [], [oFilter], {
                    $$updateGroupId: CONF_POSTING_GROUP
                });
            } else {
                this._oCpcBinding.filter(oFilter);
            }

            this._oCpcBinding.requestContexts(0, 1).then((aContexts) => {
                // Il plant puo' essere cambiato mentre la lettura era in volo.
                if (this._getPlantCode() !== sPlant) {
                    return;
                }
                this._oCpcCtx = (aContexts && aContexts[0]) || null;
                this._setConfPostingModel(this._oCpcCtx);
            }).catch((oError) => {
                // Lettura non riuscita: si resta sui valori inerti SENZA dichiarare «non
                // configurato», che affermerebbe una cosa non verificata.
                console.warn(">>> [CONF-POSTING] lettura ZProdConfPostingConfig non riuscita per il " +
                    "plant " + sPlant + ": nessuna dichiarazione mostrata.", oError);
            });
        },

        // Nessun salvataggio implicito. Le due incoerenze che il server rifiuta si dichiarano QUI,
        // appena scelte: il rifiuto arriva comunque dal server, e questo evita il giro (DEC-40).
        onConfPostingDirty() {
            const oCpc = this.getView().getModel("cpc");
            oCpc.setProperty("/dirty", true);
            oCpc.setProperty("/warnText", this._confPostingWarning(oCpc.getData()));
            // [CONF-POSTING] Le incoerenze del CANALE si mostrano nel loro blocco, non in quello
            // dello scarto: un messaggio sotto la tendina sbagliata si legge come un altro problema.
            oCpc.setProperty("/channelWarnText", this._confChannelWarning(oCpc.getData()));
        },

        /** Il primo problema in una configurazione, o stringa vuota. Le regole sono del server. */
        _confPostingWarning(oData) {
            const oBundle = this._i18n();
            // Il doppio addebito: con il consumo a ogni operazione, un pezzo scartato ha GIA'
            // consumato quello che ha percorso.
            if (oData.consumeAt === "EACH_OP" && oData.scrapConsume !== "NONE") {
                return oBundle.getText("cpcDoubleCharge");
            }
            // Senza testata d'ordine il magazzino non e' derivabile da nessuna parte.
            if (oData.scrapNoOrder === "POST" && !String(oData.scrapStorLoc || "").trim()) {
                return oBundle.getText("cpcStorLocRequired");
            }
            // Un testo che non verra' mai usato e' un customizing che si salva e non fa niente.
            if (oData.scrapNoOrder === "OFF" && String(oData.scrapLateTxt || "").trim()) {
                return oBundle.getText("cpcLateTxtUnused");
            }
            return "";
        },

        /**
         * [CONF-POSTING] Le incoerenze del CANALE (feature 0030). Regole del server, dichiarate qui.
         */
        _confChannelWarning(oData) {
            const oBundle = this._i18n();
            // Con la conferma, `ConsumeAt` dice DOVE confermare: `EACH_OP` sarebbero N conferme
            // finali sullo stesso ordine, cioe' N volte la quantita' confermata.
            if (oData.prodPosting === "CONF" && oData.consumeAt === "EACH_OP") {
                return oBundle.getText("cpcEachOpNotWithConf");
            }
            // Un interruttore acceso su un canale che non lo usa e' customizing inerte, e qui e'
            // peggio: chi lo accende crede di aver acceso le conferme.
            if (oData.confPostEnabled === true && oData.prodPosting !== "CONF") {
                return oBundle.getText("cpcConfEnabledWithoutConf");
            }
            return "";
        },

        onSaveConfPosting() {
            const oModel = this.getView().getModel("catalog");
            const oBundle = this._i18n();
            const oCpc = this.getView().getModel("cpc");
            const oData = oCpc.getData();
            const sPlant = this._getPlantCode();
            if (!this._oCpcBinding) {
                // Il binding nasce in _loadConfPostingConfig, dentro il gate isFullAdmin.
                return;
            }

            const sWarn = this._confChannelWarning(oData) || this._confPostingWarning(oData);
            if (sWarn) {
                MessageBox.error(sWarn);
                return;
            }

            const oValues = {
                ProdPosting: oData.prodPosting || "MATDOC",
                ConfPostEnabled: oData.confPostEnabled === true,
                ConsumeAt: oData.consumeAt || "LAST",
                ScrapConsume: oData.scrapConsume || "NONE",
                ScrapMove: oData.scrapMove || "ISSUE",
                ScrapIssue: oData.scrapIssue || "ALWAYS",
                ScrapNoOrder: oData.scrapNoOrder || "OFF",
                ScrapStorLoc: String(oData.scrapStorLoc || "").trim().toUpperCase(),
                // La causale si manda come e' stata digitata: la normalizzazione a quattro cifre e'
                // del SERVER, e rifarla qui creerebbe un secondo posto dove la regola vive. Cio' che
                // torna a schermo dopo il salvataggio e' il valore normalizzato, letto dal contesto.
                ScrapReason: String(oData.scrapReason || "").trim(),
                ScrapHeadTxt: String(oData.scrapHeadTxt || ""),
                ScrapLateTxt: String(oData.scrapLateTxt || "")
            };

            if (!this._oCpcCtx) {
                // Creazione LAZY: la riga nasce QUI, al primo salvataggio.
                this._oCpcCtx = RowCancel.watchCreate(this._oCpcBinding.create(Object.assign({ Plant: sPlant }, oValues)));
                this._bCpcCreated = true;
            } else {
                Object.keys(oValues).forEach((k) => this._oCpcCtx.setProperty(k, oValues[k]));
            }

            oModel.submitBatch(CONF_POSTING_GROUP).then(() => {
                if (oModel.hasPendingChanges(CONF_POSTING_GROUP)) {
                    // submitBatch() NON rigetta quando il server rifiuta la singola richiesta:
                    // senza questo blocco l'utente non vedrebbe nulla.
                    MessageBox.error(this._collectConfPostingErrors() ||
                        oBundle.getText("cpcSaveError", [""]));
                    return;
                }
                this._bCpcCreated = false;
                // Si rilegge dal contesto: cio' che si vede e' il valore NORMALIZZATO dal server —
                // ed e' il solo modo di vedere `13` diventare `0013`.
                this._setConfPostingModel(this._oCpcCtx);
                MessageToast.show(oBundle.getText("cpcSaved", [sPlant]));
            }).catch((err) => {
                MessageBox.error(oBundle.getText("cpcSaveError", [err && err.message ? err.message : ""]));
            });
        },

        onCancelConfPosting() {
            this.getView().getModel("catalog").resetChanges(CONF_POSTING_GROUP);
            // Una riga mai salvata e' transient: scartarla la fa scomparire e il contesto non e'
            // piu' utilizzabile. Il flag evita di interrogare un contesto distrutto.
            if (this._bCpcCreated) {
                this._oCpcCtx = null;
                this._bCpcCreated = false;
            }
            this._setConfPostingModel(this._oCpcCtx);
        },

        _collectConfPostingErrors() {
            return (Messaging.getMessageModel().getData() || [])
                .filter((m) => {
                    const sTarget = String(m.target || "");
                    return m.type === "Error" && (
                        sTarget.indexOf("ZProdConfPostingConfig") >= 0 ||
                        sTarget.indexOf("ScrapConsume") >= 0 ||
                        sTarget.indexOf("ScrapStorLoc") >= 0 ||
                        sTarget.indexOf("ScrapLateTxt") >= 0 ||
                        sTarget.indexOf("ConsumeAt") >= 0
                    );
                })
                .map((m) => m.message)
                .join("\n");
        },

        // L'app non ha un MessagePopover: senza questo i req.error(400, ...) del CAP sarebbero
        // invisibili. I controlli sono legati al modello JSON, quindi un messaggio con target non
        // si attacca da solo al campo e va mostrato in dialogo.
        _collectPhantomErrors() {
            return (Messaging.getMessageModel().getData() || [])
                .filter((m) => {
                    const sTarget = String(m.target || "");
                    return m.type === "Error" && (
                        sTarget.indexOf("ZPhantomExplodeConfig") >= 0 ||
                        sTarget.indexOf("MaxDepth") >= 0 ||
                        sTarget.indexOf("EffectivityDateMode") >= 0
                    );
                })
                .map((m) => m.message)
                .join("\n");
        }
    });
});

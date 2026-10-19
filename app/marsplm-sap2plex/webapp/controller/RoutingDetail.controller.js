sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    // [IS-CALL-LOG] traccia delle chiamate verso SAP in console. Da rimuovere a migrazione conclusa.
    "avvaleplm/marsplm/sap2plex/main/util/IsCallLog",
    // [W1-08] un work center su una sola operazione: gemello client di srv/lib/approvedWcRules.js
    "avvaleplm/marsplm/sap2plex/main/util/ApprovedWcConflicts",
    // [MASS-IMPORT] La mappatura «righe del template -> operazioni del ciclo», condivisa con
    // l'import massivo della dashboard. Modulo puro: node test/massImportTemplate.test.js
    "avvaleplm/marsplm/sap2plex/main/util/templateImport",
    // [PLEX-OP-TYPE-FILTER] Lettura e interpretazione del catalogo operazioni Plex: le regole
    // stanno in un punto solo perche' i tre controller aprono lo STESSO dialog.
    "avvaleplm/marsplm/sap2plex/main/util/PlexOpsCatalog",
    // [LOG-MSG-I18N] La lingua con cui si chiede lo storico invii: dalla 0029 il testo della
    // colonna «Messaggio» lo rende il server, quindi la richiesta la lingua deve dirla.
    "avvaleplm/marsplm/sap2plex/main/util/LogLanguage",
    // [SESSION-401] L'albero del ciclo Plex vive in un JSONModel di VISTA, che la guardia non puo'
    // scoprire dal manifest: glielo si dichiara.
    "avvaleplm/marsplm/sap2plex/main/util/SessionGuard",
    // [COMP-SOURCE] «Questa riga l'ha messa una persona?» ha una definizione sola, gemella di
    // srv/lib/compSourceRules.js. Il dato c'era dalla 0025 e non era leggibile da nessuna parte:
    // dalla 0036 pilota l'icona di coda della riga componente.
    "avvaleplm/marsplm/sap2plex/main/util/CompSource",
    // [ROUTE-KEY] La rotta e' l'oggetto: la riga messa da parte dalla lista si usa solo se
    // corrisponde. Qui conta il doppio, perche' il PLANT non e' nella rotta e viene da questa
    // testata. Modulo puro: node test/routeStash.test.js
    "avvaleplm/marsplm/sap2plex/main/util/RouteStash",
    // [LOAD-GEN] Una risposta partita per il ciclo precedente non scrive sui modelli di questo.
    // Modulo puro: node test/loadGen.test.js
    "avvaleplm/marsplm/sap2plex/main/util/LoadGen",
    // [DETAIL-RESET] Il literal OData si costruisce raddoppiando gli apici: un materiale con un
    // apice rendeva malformato il filtro dello storico. Modulo puro: node test/matLogFilter.test.js
    "avvaleplm/marsplm/sap2plex/main/util/MatLogFilter",
    // [DETAIL-REREAD] La testata si chiede per CHIAVE e, se il server non consegna quella riga, si
    // rilegge una volta e si SCEGLIE per chiave. Test: node test/detailRead.test.js
    "avvaleplm/marsplm/sap2plex/main/util/DetailRead",
    // [AUTO-ASSIGN] Il dettaglio del riepilogo sta in un util perche' `_applyAutoAssignments` esiste
    // in due copie (ciclo e ordine): vedi la testa di util/AutoAssignReport.js.
    "avvaleplm/marsplm/sap2plex/main/util/AutoAssignReport",
    // [ACTION-RESULT] `r.json()` non dice se la action e' riuscita: senza `r.ok` un errore del
    // server entrava nel ramo riuscito e SVUOTAVA l'albero. Modulo puro: node test/actionResult.test.js
    "avvaleplm/marsplm/sap2plex/main/util/ActionResult",
    // [ACTION-RESULT] La frase per specie di esito, con le chiavi dell'operazione: la scaletta e'
    // la stessa per i quattro invii lenti, e quattro copie divergerebbero al primo ritocco.
    "avvaleplm/marsplm/sap2plex/main/util/ActionFailure",
    // [TREE-STATE] Ogni modifica risemina l'intero albero, e riaprirlo tutto riapriva anche i nodi
    // che l'utente aveva chiuso. Modulo puro: node test/treeState.test.js
    "avvaleplm/marsplm/sap2plex/main/util/TreeState",
    // [APP-URL] Ogni URL verso il nostro backend porta davanti la base dell'app:
    // servita da Work Zone l'app sta sotto un prefisso, e un path assoluto non lo porta.
    "avvaleplm/marsplm/sap2plex/main/util/AppUrl",
    // [LOG-TRACE] La lista dello storico non scarica la traccia: i due `LargeString` con richiesta
    // e risposta si leggono per la sola riga cliccata. Test: node test/logHistorySelect.test.js
    "avvaleplm/marsplm/sap2plex/main/util/LogTrace",
    // [LOG-PAGE] Lo storico si legge a pagine di 100 dal server, con la barra `1 2 3 … N` sotto
    // la tabella: un modulo e un fragment per le tre schede. Test: node test/logPagerRules.test.js
    "avvaleplm/marsplm/sap2plex/main/util/LogPager"
], (Controller, JSONModel, MessageToast, MessageBox, Fragment, Filter, FilterOperator, IsCallLog, ApprovedWcConflicts, TemplateImport, PlexOpsCatalog, LogLanguage, SessionGuard, CompSource, RouteStash, LoadGen, MatLogFilter, DetailRead, AutoAssignReport, ActionResult, ActionFailure, TreeState, AppUrl, LogTrace, LogPager) => {
    "use strict";

    return Controller.extend("avvaleplm.marsplm.sap2plex.main.controller.RoutingDetail", {

        onInit() {
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("routingDetail").attachPatternMatched(this._onPatternMatched, this);

            // [SESSION-401] Un albero `dirty` e' lavoro che non esiste da nessun'altra parte —
            // import, auto-assegnazione, trascinamenti, rimozioni — finche' non passa
            // `saveRoutingPlexCycle`. Dichiararlo qui e' cio' che impedisce a una sessione scaduta
            // di ricaricare la pagina e portarselo via.
            SessionGuard.registerDirtyCheck("RoutingDetail", () => {
                const oModel = this.getView().getModel("plexCycleModel");
                return !!(oModel && oModel.getProperty("/dirty"));
            });

            // Initialize detail model for routing header data
            const oDetailModel = new JSONModel(this._emptyDetail());
            this.getView().setModel(oDetailModel, "detailModel");

            // Initialize tree model for SAP routing operations & components
            const oTreeModel = new JSONModel({
                nodes: [],
                // [DETAIL-RESET] Un velo per AREA, non uno di pagina: la testata arriva subito
                // dalla riga cliccata, i due alberi e lo storico no.
                busy: false
            });
            this.getView().setModel(oTreeModel, "treeModel");

            // Initialize Plex cycle model
            const oPlexCycleModel = new JSONModel({
                nodes: [],
                busy: false,
                dirty: false,
                removeEnabled: false,
                moveUpEnabled: false,
                moveDownEnabled: false,
                selectedIndex: -1,
                // [ORDER-COMP-REMOVE] Indice del componente selezionato dentro la sua operazione:
                // `selectedIndex` porta quello dell'operazione PADRE, quindi da solo non basta a
                // sapere quale componente togliere.
                selectedCompIndex: -1
            });
            this.getView().setModel(oPlexCycleModel, "plexCycleModel");

            // OData v4 model on the RoutingTemplate service (/routing-templates/) — backs the
            // "Import from Template" dialog (template list, filtered by the routing's plant).
            this.getView().setModel(new sap.ui.model.odata.v4.ODataModel({
                serviceUrl: AppUrl.url("/routing-templates/"),
                operationMode: "Server",
                autoExpandSelect: true
            }), "templateModel");

            // Internal flat array for Plex operations (source of truth)
            this._aPlexOperations = [];

            // [TREE-STATE] I nodi che l'utente ha CHIUSO, per identita' e non per posizione: un
            // nodo che non e' qui dentro e' aperto, quindi un'operazione nuova nasce aperta.
            this._oCollapsedSap = new Set();
            this._oCollapsedPlex = new Set();

            // Sync log models
            this.getView().setModel(new JSONModel({ logs: [], busy: false }), "routingLogModel");
            // [LOG-PAGE] La barra delle pagine, e il tetto del modello allineato alla pagina.
            LogPager.attach(this.getView(), this.getView().getModel("routingLogModel"));
            this.getView().setModel(new JSONModel({
                visible: false,
                // [LOG-TRACE] La traccia si legge al clic, quindi il pannello ha un tempo di
                // attesa e un modo di fallire che prima non aveva.
                busy: false,
                error: "",
                Counter: null,
                SentDate: "",
                SentTime: "",
                RequestJsonFormatted: "",
                ResponseJsonFormatted: "",
                ResponseStatus: null,
                ResponseStatusText: ""
            }), "routingJsonDetailModel");
        },

        /**
         * [ROUTE-KEY] La forma VUOTA del modello, in un punto solo.
         *
         * `Material` e `Plant` sono ESPLICITI e non lo erano: il primo e' parte dell'identita' del
         * ciclo Plex, il secondo decide su quale tenant si legge (`_plexConnPlant`). Un modello
         * senza quei due campi non e' vuoto, e' ambiguo.
         */
        _emptyDetail() {
            return {
                ProductionRoutingGroup: null,
                ProductionRouting: null,
                Material: null,
                Plant: null,
                BillOfOperationsDesc: null,
                BillOfOperationsStatus: null,
                ResponsiblePlannerGroup: null,
                PlanningWorkCenter: null,
                LastChangeDate: null,
                busy: false
            };
        },

        /**
         * [DETAIL-RESET] Tutto cio' che appartiene al ciclo se ne va con lui (feature 0043).
         *
         * PERCHE'. Il router tiene UNA sola istanza di questa vista e la riusa per ogni ciclo
         * (target `type: "View"`, nessun `clearControlAggregation`): `onInit` gira una volta sola
         * nella vita dell'applicazione, quindi i modelli entrano nel ciclo nuovo pieni di quello
         * precedente. Qui il residuo non e' solo cosmetico: `plexCycleModel>/dirty` sopravvive,
         * quindi «Salva» resta abilitato e `SessionGuard` segnala lavoro sporco che appartiene a un
         * ALTRO ciclo — e un salvataggio e' un delete+insert sul materiale corrente.
         *
         * Va chiamata per PRIMA in `_onPatternMatched` e SENZA CONDIZIONI: l'azzeramento della 0041
         * sta sul ramo di rifiuto dello stash, che nel percorso normale non passa mai.
         */
        _resetForNewObject() {
            this._mLoadGen = this._mLoadGen || {};
            this._iLoadGen = LoadGen.next(this._mLoadGen, "detail");

            this.getView().getModel("detailModel").setData(this._emptyDetail());

            const oTreeModel = this.getView().getModel("treeModel");
            oTreeModel.setProperty("/nodes", []);
            // [ROUTING-DEFAULT-OP] Anche la dichiarazione della sorgente: e' un'affermazione SUL
            // ciclo, e lasciarla in piedi la farebbe leggere come riferita a quello nuovo. Si
            // azzera senza condizioni, come tutto il resto qui.
            oTreeModel.setProperty("/note", { visible: false, type: "Information", text: "" });
            oTreeModel.setProperty("/busy", true);

            const oPlexCycleModel = this.getView().getModel("plexCycleModel");
            oPlexCycleModel.setData({
                nodes: [], busy: true, dirty: false, removeEnabled: false,
                moveUpEnabled: false, moveDownEnabled: false,
                selectedIndex: -1, selectedCompIndex: -1
            });

            const oLogModel = this.getView().getModel("routingLogModel");
            oLogModel.setProperty("/logs", []);
            oLogModel.setProperty("/busy", true);
            // [LOG-TRACE] Il pannello della traccia si svuota, e la sua generazione avanza: una
            // lettura partita per una riga del ciclo precedente non deve scriverci sopra.
            LoadGen.next(this._mLoadGen, "trace");
            this.getView().getModel("routingJsonDetailModel").setData({
                visible: false, busy: false, error: "",
                Counter: null, SentDate: "", SentTime: "",
                RequestJsonFormatted: "", ResponseJsonFormatted: "",
                ResponseStatus: null, ResponseStatusText: ""
            });

            // Le fonti di verita' interne: gli alberi si ricostruiscono da queste, quindi lasciarle
            // piene rimetterebbe a schermo il ciclo precedente al primo `_rebuildPlexCycleTree`.
            this._aPlexOperations = [];
            this._aSapOperations = [];

            // [TREE-STATE] I nodi chiusi sono di QUESTO ciclo: `PlexOperationId` e' un id del
            // catalogo del tenant, quindi la stessa chiave puo' ricomparire sul ciclo dopo e un
            // residuo chiuderebbe un nodo che nessuno ha chiuso.
            this._oCollapsedSap.clear();
            this._oCollapsedPlex.clear();

            // La scheda torna la prima: restando su «Storico invii» si guarderebbero le righe di un
            // altro ciclo senza nessun segno che lo dica.
            const oTabs = this.byId("routingDetailTabs");
            if (oTabs) { oTabs.setSelectedKey("trees"); }
            const oLogTable = this.byId("routingLogTable");
            if (oLogTable) { oLogTable.removeSelections(true); }
        },

        _onPatternMatched(oEvent) {
            const oArgs = oEvent.getParameter("arguments");
            this._sRoutingGroup = oArgs.ProductionRoutingGroup;
            this._sRouting = oArgs.ProductionRouting;
            // [ROUTING-BY-MATERIAL] Il materiale di testata: identifica il ciclo Plex tanto quanto
            // gruppo e contatore, perche' su Plex il ciclo vive sulla part. Il segnaposto "-" della
            // route torna stringa vuota: e' il ciclo SAP senza assegnazione materiale, che si puo'
            // guardare ma non ha una part su cui costruire un ciclo.
            this._sMaterial = (oArgs.Material === "-" ? "" : (oArgs.Material || "")).trim();
            // [ROUTE-KEY] Le chiavi di rotta DOPO la traduzione del segnaposto, o il confronto
            // userebbe `-` al posto della stringa vuota. Il `Plant` non e' fra loro e non lo sara':
            // vedi il commento su `_requirePlexConnPlant`.
            this._oRouteKeys = {
                ProductionRoutingGroup: this._sRoutingGroup,
                ProductionRouting: this._sRouting,
                Material: this._sMaterial
            };

            // [DETAIL-RESET] Prima di qualunque lettura: la schermata si svuota, poi si riempie.
            this._resetForNewObject();

            this._loadRoutingData().then(() => {
                this._loadTreeData();
                this._loadPlexCycleData();
                this._loadRoutingSyncLogs();
                // [IS-CALL-LOG] come sono state fatte le letture verso SAP (testata, operazioni,
                // assegnazioni componenti), in console. Da rimuovere a migrazione conclusa.
                IsCallLog.dump("dettaglio ciclo " + this._sRoutingGroup + "/" + this._sRouting);
            });
        },

        // ================================================================
        // ROUTING DATA LOADING (HEADER)
        // ================================================================

        _loadRoutingData() {
            const oDetailModel = this.getView().getModel("detailModel");
            const oStash = this.getOwnerComponent()._selectedRouting;
            // [LOAD-GEN] La generazione al momento della partenza: al ritorno dice se nel frattempo
            // si e' navigato su un altro ciclo. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;

            // ================================================================
            // [ROUTE-KEY] La riga messa da parte si usa SOLO se e' questo ciclo. Qui il confronto
            // vale il doppio: da questa testata viene il PLANT (`_plexConnPlant`), che decide su
            // quale tenant Plex si legge il catalogo operazioni e i work center.
            // ================================================================
            const oCheck = RouteStash.check(oStash, this._oRouteKeys);
            if (oCheck.usable) {
                oDetailModel.setData({ ...oStash, ...this._oRouteKeys, busy: false });
                return Promise.resolve();
            }
            if (oCheck.reason !== RouteStash.REASON.NO_STASH) {
                console.warn(RouteStash.describe("dettaglio ciclo", oCheck));
            }
            oDetailModel.setData(this._emptyDetail());

            // Fallback: fetch from OData when component data is not available (e.g., after F5 refresh)
            console.log(">>> Fetching routing data from OData (after F5 refresh)");
            oDetailModel.setProperty("/busy", true);

            // ================================================================
            // [DETAIL-REREAD] SI CHIEDE PER CHIAVE, e la rilettura e' la rete che sta sotto.
            //
            // Prima qui c'era `Routings?$filter=<tre uguaglianze>&$top=1`, cioe' una COLLECTION, e
            // su quella forma il blocco d'identita' dell'handler NON girava — era vincolato a
            // `SELECT.one`. Restava solo la ricerca tollerante in OR, che tiene tutte le righe del
            // gruppo, e con lo spareggio `(Group, Routing, Material) asc` il `$top=1` serviva il
            // materiale piu' BASSO del ciclo: e' il difetto che faceva uscire `detailKeyMismatch`
            // dopo ogni F5 su un ciclo con piu' materiali. Le due correzioni vanno insieme, e
            // questa e' la prima: il gate lato server e' caduto (vedi [DETAIL-REREAD] in
            // cat-service.js), ma una lettura per chiave e' comunque la domanda giusta.
            //
            // [ROUTING-BY-MATERIAL] Il materiale E' parte della chiave, e `Material=''` e' una
            // chiave legittima: il ciclo SAP senza assegnazione materiale.
            //
            // Il literal si costruisce con `odataLiteral` (l'apice si RADDOPPIA) come sulle altre
            // due schede; nel `$filter` della rilettura si codifica l'espressione INTERA una volta
            // sola — `encodeURIComponent` dentro gli apici, com'era prima, produce `%27` dentro un
            // literal, cioe' un criterio che non aggancia.
            // ================================================================
            const sGroupLit = MatLogFilter.odataLiteral(this._sRoutingGroup);
            const sRoutingLit = MatLogFilter.odataLiteral(this._sRouting);
            const sMaterialLit = MatLogFilter.odataLiteral(this._sMaterial);
            const sKeyUrl = AppUrl.url("/production-routings/Routings(ProductionRoutingGroup=") + sGroupLit
                + ",ProductionRouting=" + sRoutingLit + ",Material=" + sMaterialLit + ")";
            const sRereadUrl = AppUrl.url("/production-routings/Routings?$filter=")
                + encodeURIComponent(`ProductionRoutingGroup eq ${sGroupLit}`
                    + ` and ProductionRouting eq ${sRoutingLit}`
                    + ` and Material eq ${sMaterialLit}`);

            return DetailRead.one({
                keyUrl: sKeyUrl,
                routeKeys: this._oRouteKeys,
                label: `dettaglio ciclo ${this._sRoutingGroup}/${this._sRouting}`,
                recover: () => DetailRead.rows(sRereadUrl)
            })
            .then(oRead => {
                // [LOAD-GEN] Risposta di un altro ciclo: si scarta senza scrivere.
                if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                const oBundle = this.getView().getModel("i18n").getResourceBundle();
                if (!oRead.row) {
                    // [ROUTE-KEY] Questo ramo era MUTO: `busy = false` e nient'altro. Il modello
                    // restava vuoto, `_plexConnPlant()` tornava stringa vuota, e le letture verso
                    // Plex partivano senza plant — cioe' una tendina vuota che si legge come «Plex
                    // non ha operazioni».
                    // [DETAIL-REREAD] «Non c'e'» e «non ho potuto leggere» sono DUE messaggi: il
                    // secondo non deve leggersi come «questo ciclo non esiste».
                    console.error(`>>> [DETAIL-REREAD] ciclo ${this._sRoutingGroup}/${this._sRouting}`
                        + ` materiale «${this._sMaterial}»: testata non ottenuta (${oRead.note})`);
                    MessageBox.warning(oRead.why === DetailRead.WHY.READ_FAILED
                        ? oBundle.getText("detailReadFailed", [oRead.note])
                        : oBundle.getText("routingMaterialNotFound",
                            [this._sRoutingGroup, this._sRouting, this._sMaterial || "-"]));
                    oDetailModel.setData(this._emptyDetail());
                    return;
                }
                // [ROUTE-KEY] Le chiavi del modello sono quelle della ROTTA: dopo il confronto non
                // e' una sostituzione, e' una grafia.
                oDetailModel.setData({ ...oRead.row, ...this._oRouteKeys, busy: false });
            });
        },

        // ================================================================
        // SAP TREE (LEFT) - Routing Operations & Component Allocations
        // ================================================================

        _loadTreeData() {
            const oTreeModel = this.getView().getModel("treeModel");
            const oDetailModel = this.getView().getModel("detailModel");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            // [LOAD-GEN] La generazione al momento della partenza. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            oTreeModel.setProperty("/busy", true);

            const sGroup = encodeURIComponent(this._sRoutingGroup);
            const sRouting = encodeURIComponent(this._sRouting);

            const sOpsUrl = AppUrl.url(`/production-routings/RoutingOperations?$filter=ProductionRoutingGroup eq '${sGroup}' and ProductionRouting eq '${sRouting}'`);
            // [ROUTING-BY-MATERIAL] `Material` seleziona la DISTINTA: in SAP l'assegnazione
            // componente-operazione punta alla posizione di una distinta specifica, e ogni
            // materiale ha la sua. Senza questo criterio l'albero mostra i componenti di tutte le
            // distinte di tutti i materiali del ciclo, fusi insieme.
            const sMaterialFilter = this._sMaterial
                ? ` and Material eq '${encodeURIComponent(this._sMaterial)}'`
                : "";
            const sCompUrl = AppUrl.url(`/production-routings/RoutingComponentAllocations?$filter=ProductionRoutingGroup eq '${sGroup}' and ProductionRouting eq '${sRouting}'${sMaterialFilter}`);
            // [ROUTING-DEFAULT-OP] Da dove vengono i componenti di questo ciclo. Nella STESSA onda
            // delle altre due: in serie sarebbe un round-trip in piu' su ogni apertura di ciclo.
            // Se fallisce non si ferma niente — `catch` a valore inerte — perche' una dichiarazione
            // che non arriva deve lasciare l'albero com'era, non impedire di aprirlo.
            const sSrcUrl = AppUrl.url(`/production-routings/routingCompSource(ProductionRoutingGroup='${sGroup}',ProductionRouting='${sRouting}',Material='${encodeURIComponent(this._sMaterial || "")}')`);

            Promise.all([
                fetch(sOpsUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sCompUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sSrcUrl, { headers: { "Accept": "application/json" } })
                    .then(r => r.ok ? r.json() : null).catch(() => null)
            ])
            .then(([opsData, compData, srcData]) => {
                const aOperations = opsData.value || [];
                const aComponents = compData.value || [];

                console.log(`>>> Routing tree: ${aOperations.length} operations, ${aComponents.length} component allocations`);

                // Group components by ProductionRoutingOpIntID (operation internal ID)
                const mCompsByOp = {};
                aComponents.forEach(comp => {
                    const sOpId = comp.ProductionRoutingOpIntID;
                    if (!mCompsByOp[sOpId]) {
                        mCompsByOp[sOpId] = [];
                    }
                    mCompsByOp[sOpId].push(comp);
                });

                // Build tree: Routing -> Operations -> Components
                const aOperationNodes = aOperations.map(op => {
                    const sOpCode = op.Operation;
                    const sOpText = oResourceBundle.getText("routingOperationNode", [sOpCode, op.OperationText || ""]);
                    const sOpDesc = oResourceBundle.getText("workCenter") + ": " + (op.WorkCenterInternalID || "-");

                    const aOpComps = mCompsByOp[op.ProductionRoutingOpIntID] || [];
                    const aComponentNodes = aOpComps.map(comp => {
                        const fQty = parseFloat(comp.BillOfMaterialItemQuantity) || 0;
                        const sUnit = comp.BillOfMaterialItemUnit || "";
                        // [W1-05] UNA QUANTITÀ CHE NON C'È SI DICHIARA. Prima la descrizione
                        // taceva — restava il solo "BOM: <nodo>" — e la riga era indistinguibile
                        // da una letta correttamente: adesso che la quantità arriva dalla distinta,
                        // il silenzio significherebbe "non l'ho risolta" e nessuno lo saprebbe.
                        // L'unità vuota accompagna il numero senza aggiungere spazi (`trim`): su
                        // ONPREM la distinta la porta sempre, sull'altro canale non è garantita.
                        const sQtyDesc = fQty
                            ? (fQty.toFixed(3) + " " + sUnit).trim()
                            : oResourceBundle.getText("bomQtyUnresolved");
                        let sDesc = sQtyDesc + " | BOM: " + (comp.BillOfMaterialItemNodeNumber || "-");
                        // [PHANTOM-EXPLODE] Un componente nato da un'esplosione DEVE dichiararlo:
                        // altrimenti e' indistinguibile da uno letto da SAP, e nessuno saprebbe
                        // perche' un materiale che nella distinta non c'e' compare nell'albero.
                        if (comp.PhantomSource) {
                            sDesc += " | " + oResourceBundle.getText("phantomFrom", [comp.PhantomSource]);
                        }
                        return {
                            text: comp.BillOfMaterialComponent || "",
                            description: sDesc,
                            icon: "sap-icon://product",
                            iconColor: comp.PhantomSource ? "#0a6ed1" : "#888888",
                            nodeType: "component",
                            cssClass: "treeNodeComponent",
                            iconClass: "treeIconComponent",
                            _srcMaterial: comp.BillOfMaterialComponent,
                            _srcBOMItemNodeNumber: comp.BillOfMaterialItemNodeNumber,
                            _srcRequiredQuantity: fQty,
                            _srcBaseUnit: sUnit,
                            _srcPhantomSource: comp.PhantomSource || ""
                        };
                    });

                    return {
                        text: sOpText,
                        description: sOpDesc,
                        icon: "sap-icon://workflow-tasks",
                        iconColor: "#0854A0",
                        nodeType: "operation",
                        cssClass: "treeNodeOperation",
                        iconClass: "treeIconOperation",
                        _sapOperationId: sOpCode,
                        _sapOpIntId: op.ProductionRoutingOpIntID || null,
                        hasLink: false,
                        nodes: aComponentNodes
                    };
                });

                // [LOAD-GEN] Risposta di un altro ciclo: si scarta. Il controllo sta PRIMA della
                // scrittura di `_aSapOperations`, che e' una fonte di verita' e non solo un modello.
                if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }

                // Store operations for linking popover
                this._aSapOperations = aOperations;

                const oRoutingData = oDetailModel.getData();
                const sDesc = oRoutingData.BillOfOperationsDesc || "";
                const sRootDesc = sDesc || "";

                const aTreeNodes = [{
                    text: this._sRoutingGroup || "",
                    description: sRootDesc,
                    icon: "sap-icon://workflow-tasks",
                    iconColor: "#107E3E",
                    nodeType: "routing",
                    cssClass: "treeNodeOrder",
                    iconClass: "treeIconOrder",
                    nodes: aOperationNodes
                }];

                oTreeModel.setProperty("/nodes", aTreeNodes);
                // [ROUTING-DEFAULT-OP] La dichiarazione, PRIMA di spegnere il velo: la striscia e
                // l'albero che descrive devono comparire insieme.
                oTreeModel.setProperty("/note", this._compSourceNote(srcData, oResourceBundle));
                oTreeModel.setProperty("/busy", false);

                setTimeout(() => {
                    // [TREE-STATE] Si riapre tutto TRANNE i nodi che l'utente ha chiuso.
                    TreeState.restore(this.byId("operationsTree"), this._oCollapsedSap, TreeState.sapKey, 3);
                }, 100);
            })
            .catch(oError => {
                if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                console.error(">>> Error loading routing tree data:", oError);
                oTreeModel.setProperty("/nodes", []);
                // [ROUTING-DEFAULT-OP] La nota si azzera anche qui: una striscia rimasta da un
                // ciclo precedente accanto a un albero vuoto direbbe una cosa su un altro oggetto.
                oTreeModel.setProperty("/note", this._compSourceNote(null, oResourceBundle));
                oTreeModel.setProperty("/busy", false);
            });
        },

        /**
         * [ROUTING-DEFAULT-OP] La striscia sopra l'albero SAP (feature 0051).
         *
         * Tre stati, e il terzo e' quello che vale la pena avere: `BOM` normale (l'albero non e'
         * quello di SAP, e lo si dice), `BOM` senza distinta (l'albero e' VUOTO, e vuoto senza
         * spiegazione si legge come «questo ciclo non ha componenti») e ripiego dichiarato (il
         * plant ha chiesto la distinta e ha ricevuto l'assegnazione di SAP: l'albero e' quello di
         * sempre, ma NON quello che il customizing prometteva).
         *
         * `ALLOC` non produce nessuna striscia: e' il comportamento di sempre, e dichiarare cio'
         * che e' normale abitua a non leggere le strisce.
         *
         * @param {object|null} oSrc la busta di `routingCompSource`, o `null` se non e' arrivata
         * @param {object} oBundle
         * @returns {{visible: boolean, type: string, text: string}}
         */
        _compSourceNote(oSrc, oBundle) {
            const oNone = { visible: false, type: "Information", text: "" };
            if (!oSrc || !oSrc.mode) { return oNone; }
            if (oSrc.fellBack === true) {
                return {
                    visible: true,
                    type: "Warning",
                    text: oBundle.getText("routingCompSourceFellBack", [oSrc.reason || ""])
                };
            }
            if (oSrc.mode !== "BOM") { return oNone; }
            if (oSrc.noBom === true) {
                return {
                    visible: true,
                    type: "Error",
                    text: oBundle.getText("routingCompSourceNoBom", [this._sMaterial || ""])
                };
            }
            return {
                visible: true,
                type: "Information",
                text: oBundle.getText("routingCompSourceFromBom", [oSrc.anchor || "", oSrc.plant || ""])
            };
        },

        onRefreshSapTree() {
            if (!this._sRoutingGroup) return;
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            this._loadTreeData();
            MessageToast.show(oResourceBundle.getText("dataRefreshed"));
        },

        // ================================================================
        // PLEX CYCLE TREE (RIGHT) - Load, Build, Select, Reorder, Save
        // ================================================================

        _loadPlexCycleData() {
            // [LOAD-GEN] La generazione al momento della partenza. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            this.getView().getModel("plexCycleModel").setProperty("/busy", true);
            const sGroup = encodeURIComponent(this._sRoutingGroup);
            const sRouting = encodeURIComponent(this._sRouting);
            // [ROUTING-BY-MATERIAL] Il ciclo salvato e' quello DI QUESTO materiale. Senza il
            // criterio si caricherebbero le operazioni di tutti i materiali del ciclo SAP mescolate,
            // e il salvataggio successivo — che è un delete+insert sullo stesso scope — le
            // riscriverebbe tutte sul materiale corrente.
            const sMat = ` and HeaderMaterial eq '${encodeURIComponent(this._sMaterial)}'`;
            const sOpsUrl = AppUrl.url(`/production-routings/PlexRoutingCycleOperations?$filter=ProductionRoutingGroup eq '${sGroup}' and ProductionRouting eq '${sRouting}'${sMat}&$orderby=OperationNumber asc`);
            const sCompUrl = AppUrl.url(`/production-routings/PlexRoutingCycleComponents?$filter=ProductionRoutingGroup eq '${sGroup}' and ProductionRouting eq '${sRouting}'${sMat}&$orderby=PlexOperationId asc,Sequence asc`);
            const sWcUrl = AppUrl.url(`/production-routings/PlexRoutingApprovedWorkcenters?$filter=ProductionRoutingGroup eq '${sGroup}' and ProductionRouting eq '${sRouting}'${sMat}`);

            Promise.all([
                fetch(sOpsUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sCompUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sWcUrl, { headers: { "Accept": "application/json" } }).then(r => r.json())
            ])
                .then(([opsData, compData, wcData]) => {
                    // [LOAD-GEN] Risposta di un altro ciclo: si scarta. Il controllo sta PRIMA di
                    // `_aPlexOperations`, che e' la fonte da cui l'albero si ricostruisce.
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    const aOps = opsData.value || [];
                    const aComps = compData.value || [];
                    const aWCs = wcData.value || [];
                    console.log(`>>> Routing Plex cycle: loaded ${aOps.length} operations, ${aComps.length} components, ${aWCs.length} workcenters`);

                    // Group components by PlexOperationId
                    const mCompsByOp = {};
                    aComps.forEach(comp => {
                        if (!mCompsByOp[comp.PlexOperationId]) {
                            mCompsByOp[comp.PlexOperationId] = [];
                        }
                        mCompsByOp[comp.PlexOperationId].push({
                            Material: comp.Material,
                            BOMItemNodeNumber: comp.BOMItemNodeNumber,
                            RequiredQuantity: comp.RequiredQuantity || 0,
                            BaseUnit: comp.BaseUnit || "",
                            Sequence: comp.Sequence,
                            // [PHANTOM-EXPLODE] persistita in ZPlexRoutingCycleComponent
                            PhantomSource: comp.PhantomSource || "",
                            // [ROUTING-COMP-SOURCE] Chi ha collocato il componente. Va riletta e
                            // rimandata indietro al salvataggio: il salvataggio ricrea le righe,
                            // quindi perderla qui significherebbe azzerarla a ogni salvataggio e
                            // rimettere il job in condizione di spostare anche le collocazioni
                            // fatte a mano. Assente = 'AUTO', governato dalle regole.
                            AssignmentSource: comp.AssignmentSource || "AUTO"
                        });
                    });

                    // Group workcenters by PlexOperationId
                    const mWCsByOp = {};
                    aWCs.forEach(wc => {
                        if (!mWCsByOp[wc.PlexOperationId]) {
                            mWCsByOp[wc.PlexOperationId] = [];
                        }
                        mWCsByOp[wc.PlexOperationId].push({
                            WorkcenterId: wc.WorkcenterId,
                            WorkcenterCode: wc.WorkcenterCode || "",
                            WorkcenterName: wc.WorkcenterName || ""
                        });
                    });

                    this._aPlexOperations = aOps.map(op => ({
                        PlexOperationId: op.PlexOperationId,
                        OperationCode: op.OperationCode,
                        OperationName: op.OperationName,
                        SAPOperationId: op.SAPOperationId || null,
                        ProductionRoutingOpIntID: op.ProductionRoutingOpIntID || null,
                        OperationNumber: op.OperationNumber || null,
                        OperationType: op.OperationType || null,
                        SubOperation: op.SubOperation || false,
                        Shippable: op.Shippable || false,
                        NetWeight: op.NetWeight || null,
                        StandardQuantity: op.StandardQuantity || null,
                        components: mCompsByOp[op.PlexOperationId] || [],
                        approvedWorkcenters: mWCsByOp[op.PlexOperationId] || []
                    }));

                    this._rebuildPlexCycleTree();
                    this.getView().getModel("plexCycleModel").setProperty("/dirty", false);
                    this.getView().getModel("plexCycleModel").setProperty("/busy", false);
                })
                .catch(err => {
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    console.error(">>> Error loading routing Plex cycle data:", err);
                    this._aPlexOperations = [];
                    this._rebuildPlexCycleTree();
                    this.getView().getModel("plexCycleModel").setProperty("/busy", false);
                });
        },

        _rebuildPlexCycleTree() {
            const oPlexCycleModel = this.getView().getModel("plexCycleModel");
            const oDetailModel = this.getView().getModel("detailModel");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // Build operation nodes (Level 2) with component children (Level 3)
            const aOperationNodes = this._aPlexOperations.map((op, index) => {
                const aComponentNodes = (op.components || []).map((comp, compIdx) => {
                    const fQty = parseFloat(comp.RequiredQuantity) || 0;
                    const sUnit = comp.BaseUnit || "";
                    const sQtyDesc = fQty ? (fQty.toFixed(3) + " " + sUnit).trim() : "";
                    let sDesc = sQtyDesc
                        ? sQtyDesc + " | BOM: " + (comp.BOMItemNodeNumber || "-")
                        : "BOM: " + (comp.BOMItemNodeNumber || "-");
                    // [PHANTOM-EXPLODE] come nell'albero SAP: la provenienza si dichiara.
                    if (comp.PhantomSource) {
                        sDesc += " | " + oResourceBundle.getText("phantomFrom", [comp.PhantomSource]);
                    }
                    return {
                        text: comp.Material,
                        description: sDesc,
                        icon: "sap-icon://product",
                        iconColor: "#888888",
                        nodeType: "plexComponent",
                        cssClass: "treeNodePlexComponent",
                        iconClass: "treeIconComponent",
                        // [COMP-SOURCE] Pilota l'icona di coda. Il dato e' in memoria dalla 0025 e
                        // non era leggibile da nessuna parte: il job non spostava quelle righe e a
                        // schermo nulla lo diceva. Tollerante come il server (feature 0036).
                        isManual: CompSource.isManual(comp.AssignmentSource),
                        _opIndex: index,
                        _compIndex: compIdx
                    };
                });

                const sSeqDesc = oResourceBundle.getText("plexCycleOpNum", [op.OperationNumber || ""]);
                let sDesc = op.SAPOperationId
                    ? sSeqDesc + " | \u2192 Op. " + op.SAPOperationId
                    : sSeqDesc;

                // Append workcenter info
                const aWC = op.approvedWorkcenters || [];
                if (aWC.length > 0) {
                    const sWcNames = aWC.map(wc => wc.WorkcenterCode || wc.WorkcenterName).join(", ");
                    sDesc += " | WC: " + sWcNames;
                }

                return {
                    text: op.OperationName ? (op.OperationCode + " - " + op.OperationName) : (op.OperationCode || ""),
                    description: sDesc,
                    icon: "sap-icon://settings",
                    iconColor: "#0854A0",
                    nodeType: "plexOperation",
                    cssClass: "treeNodePlexOperation",
                    iconClass: "treeIconPlexOperation",
                    // [TREE-STATE] L'IDENTITA' del nodo, con cui si ricorda se l'utente l'ha
                    // chiuso: `_index` e `OperationNumber` sono posizionali e il riordino li
                    // riscrive, quindi la chiusura resterebbe appiccicata alla POSIZIONE.
                    _key: op.PlexOperationId,
                    _index: index,
                    _sapOperationId: op.SAPOperationId || null,
                    hasLink: !!op.SAPOperationId,
                    hasWorkcenters: aWC.length > 0,
                    nodes: aComponentNodes
                };
            });

            // Root node
            const oRoutingData = oDetailModel.getData();
            const sDesc = oRoutingData.BillOfOperationsDesc || "";
            const sRootDesc = sDesc || "";

            const aTreeNodes = [{
                text: this._sRoutingGroup || "",
                description: sRootDesc,
                icon: "sap-icon://workflow-tasks",
                iconColor: "#107E3E",
                nodeType: "routing",
                cssClass: "treeNodeOrder",
                iconClass: "treeIconOrder",
                nodes: aOperationNodes
            }];

            oPlexCycleModel.setProperty("/nodes", aTreeNodes);

            // Expand all and clear stale selection
            setTimeout(() => {
                const oTree = this.byId("plexCycleTree");
                if (oTree) {
                    // [TREE-STATE] Si riapre tutto TRANNE i nodi che l'utente ha chiuso: la
                    // ricostruzione azzera lo stato del binding, riespanderlo senza condizioni
                    // riapriva anche quelli.
                    TreeState.restore(oTree, this._oCollapsedPlex, TreeState.plexKey, 3);
                    oTree.removeSelections(true);
                }
                this._reapplyHighlights();
            }, 100);

            // Reset selection state
            this._updatePlexCycleButtonStates(-1);

            // Update SAP tree link icon states
            this._updateSapTreeLinkStates();
        },

        // ----------------------------------------------------------------
        // Operation Linking - SAP tree link state + highlights
        // ----------------------------------------------------------------

        _updateSapTreeLinkStates() {
            const oTreeModel = this.getView().getModel("treeModel");
            const aRootNodes = oTreeModel.getProperty("/nodes");
            if (!aRootNodes?.[0]?.nodes) return;

            const aLinkedSapOps = new Set(
                this._aPlexOperations.filter(op => op.SAPOperationId).map(op => op.SAPOperationId)
            );

            aRootNodes[0].nodes.forEach((opNode, i) => {
                oTreeModel.setProperty("/nodes/0/nodes/" + i + "/hasLink", aLinkedSapOps.has(opNode._sapOperationId));
            });
        },

        _clearAllHighlights() {
            this._sHighlightedSapOpId = null;
            this._iHighlightedPlexOpIndex = null;
            const oSapTree = this.byId("operationsTree");
            if (oSapTree) {
                oSapTree.getItems().forEach(item => item.removeStyleClass("treeNodeHighlighted"));
            }
            const oPlexTree = this.byId("plexCycleTree");
            if (oPlexTree) {
                oPlexTree.getItems().forEach(item => item.removeStyleClass("treeNodeHighlighted"));
            }
        },

        onClearHighlights() {
            this._clearAllHighlights();
        },

        onHighlightLinkedPlexOps(oEvent) {
            const oContext = oEvent.getSource().getBindingContext("treeModel");
            if (!oContext) return;
            const sSapOpId = oContext.getProperty("_sapOperationId");
            if (!sSapOpId) return;

            this._clearAllHighlights();
            this._highlightBySapOpId(sSapOpId);
        },

        onHighlightLinkedSapOp(oEvent) {
            const oContext = oEvent.getSource().getBindingContext("plexCycleModel");
            if (!oContext) return;
            const sSapOpId = oContext.getProperty("_sapOperationId");

            this._clearAllHighlights();

            if (sSapOpId) {
                this._highlightBySapOpId(sSapOpId);
            } else {
                this._iHighlightedPlexOpIndex = oContext.getProperty("_index");
                this._applyPlexOpHighlight(this._iHighlightedPlexOpIndex);
            }
        },

        onLinkPlexOperation(oEvent) {
            const oSource = oEvent.getSource();
            const oContext = oSource.getBindingContext("plexCycleModel");
            if (!oContext) return;

            this._iLinkingPlexOpIndex = oContext.getProperty("_index");
            const sCurrentLink = this._aPlexOperations[this._iLinkingPlexOpIndex].SAPOperationId;

            // Build list of SAP operations from the left tree model
            const oTreeModel = this.getView().getModel("treeModel");
            const aRoot = oTreeModel.getProperty("/nodes");
            if (!aRoot?.[0]?.nodes) return;

            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const aSapOps = [
                { sapOperationId: null, text: oBundle.getText("noLink"), description: "", selected: !sCurrentLink }
            ];
            aRoot[0].nodes.forEach(node => {
                aSapOps.push({
                    sapOperationId: node._sapOperationId,
                    sapOpIntId: node._sapOpIntId,
                    text: node.text,
                    description: node.description,
                    selected: node._sapOperationId === sCurrentLink
                });
            });

            // Initialize linkModel (lazy)
            let oLinkModel = this.getView().getModel("linkModel");
            if (!oLinkModel) {
                oLinkModel = new JSONModel({});
                this.getView().setModel(oLinkModel, "linkModel");
            }
            oLinkModel.setProperty("/sapOperations", aSapOps);

            // Open popover (lazy load fragment)
            if (!this._pLinkPopover) {
                this._pLinkPopover = Fragment.load({
                    id: this.getView().getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.LinkOperationPopover",
                    controller: this
                }).then(oPopover => {
                    this.getView().addDependent(oPopover);
                    return oPopover;
                });
            }
            this._pLinkPopover.then(oPopover => oPopover.openBy(oSource));
        },

        onLinkSapOpSelected(oEvent) {
            const oItem = oEvent.getParameter("listItem");
            const oCtx = oItem.getBindingContext("linkModel");
            const sSapOpId = oCtx.getProperty("sapOperationId");
            const sSapOpIntId = oCtx.getProperty("sapOpIntId");

            this._aPlexOperations[this._iLinkingPlexOpIndex].SAPOperationId = sSapOpId;
            this._aPlexOperations[this._iLinkingPlexOpIndex].ProductionRoutingOpIntID = sSapOpIntId || null;

            this._rebuildPlexCycleTree();
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);
            this.byId("linkOperationPopover").close();

            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            MessageToast.show(sSapOpId
                ? oBundle.getText("linkCreated", [sSapOpId])
                : oBundle.getText("linkRemoved"));
        },

        // ----------------------------------------------------------------
        // Selection
        // ----------------------------------------------------------------

        // [TREE-STATE] L'unico punto in cui si scopre che l'utente ha chiuso o aperto un nodo: UI5
        // emette `toggleOpenState` solo sull'interazione (e sull'apertura automatica del nodo
        // sorvolato durante un trascinamento), mai su `expandToLevel`/`collapse` programmatici.
        onSapTreeToggle(oEvent) {
            TreeState.remember(this._oCollapsedSap, oEvent, TreeState.sapKey);
        },

        onPlexTreeToggle(oEvent) {
            TreeState.remember(this._oCollapsedPlex, oEvent, TreeState.plexKey);
        },

        onPlexTreeSelectionChange(oEvent) {
            const oItem = oEvent.getParameter("listItem");
            const oContext = oItem.getBindingContext("plexCycleModel");

            if (!oContext) return;

            const sNodeType = oContext.getProperty("nodeType");

            if (sNodeType === "plexOperation") {
                const iIndex = oContext.getProperty("_index");
                this._updatePlexCycleButtonStates(iIndex, "plexOperation");
            } else if (sNodeType === "plexComponent") {
                // [ORDER-COMP-REMOVE] Il componente porta DUE indici, e servono entrambi: quello
                // dell'operazione padre per trovare la riga, quello del componente per togliere
                // proprio lui. Prima ne viaggiava uno solo e «Rimuovi» restava spento.
                const iOpIndex = oContext.getProperty("_opIndex");
                const iCompIndex = oContext.getProperty("_compIndex");
                this._updatePlexCycleButtonStates(iOpIndex, "plexComponent", iCompIndex);
            } else {
                // Root node — deselect
                const oTree = this.byId("plexCycleTree");
                oTree.removeSelections(true);
                this._updatePlexCycleButtonStates(-1);
            }

            // Auto-highlight linked SAP operation
            this._clearAllHighlights();
            if (sNodeType === "plexOperation") {
                const iOpIdx = oContext.getProperty("_index");
                const sSapOpId = this._aPlexOperations[iOpIdx]?.SAPOperationId;
                if (sSapOpId) {
                    this._highlightBySapOpId(sSapOpId);
                }
            }
        },

        _highlightBySapOpId(sSapOpId) {
            this._sHighlightedSapOpId = sSapOpId;
            this._iHighlightedPlexOpIndex = null;
            this._applyHighlightStyles(sSapOpId);
        },

        _applyHighlightStyles(sSapOpId) {
            const oSapTree = this.byId("operationsTree");
            if (oSapTree) {
                oSapTree.getItems().forEach(item => {
                    const ctx = item.getBindingContext("treeModel");
                    if (ctx && ctx.getProperty("nodeType") === "operation" && ctx.getProperty("_sapOperationId") === sSapOpId) {
                        item.addStyleClass("treeNodeHighlighted");
                    }
                });
            }
            const oPlexTree = this.byId("plexCycleTree");
            if (oPlexTree) {
                oPlexTree.getItems().forEach(item => {
                    const ctx = item.getBindingContext("plexCycleModel");
                    if (ctx && ctx.getProperty("nodeType") === "plexOperation" && ctx.getProperty("_sapOperationId") === sSapOpId) {
                        item.addStyleClass("treeNodeHighlighted");
                    }
                });
            }
        },

        _applyPlexOpHighlight(iPlexOpIndex) {
            const oPlexTree = this.byId("plexCycleTree");
            if (oPlexTree) {
                oPlexTree.getItems().forEach(item => {
                    const ctx = item.getBindingContext("plexCycleModel");
                    if (ctx && ctx.getProperty("_index") === iPlexOpIndex && ctx.getProperty("nodeType") === "plexOperation") {
                        item.addStyleClass("treeNodeHighlighted");
                    }
                });
            }
        },

        _reapplyHighlights() {
            const oSapTree = this.byId("operationsTree");
            if (oSapTree) {
                oSapTree.getItems().forEach(item => item.removeStyleClass("treeNodeHighlighted"));
            }
            const oPlexTree = this.byId("plexCycleTree");
            if (oPlexTree) {
                oPlexTree.getItems().forEach(item => item.removeStyleClass("treeNodeHighlighted"));
            }
            if (this._sHighlightedSapOpId) {
                this._applyHighlightStyles(this._sHighlightedSapOpId);
            } else if (this._iHighlightedPlexOpIndex != null) {
                this._applyPlexOpHighlight(this._iHighlightedPlexOpIndex);
            }
        },

        _updatePlexCycleButtonStates(iSelectedIndex, sNodeType, iCompIndex) {
            const oModel = this.getView().getModel("plexCycleModel");
            const iCount = this._aPlexOperations.length;

            const bIsOperation = sNodeType === "plexOperation";
            // [ORDER-COMP-REMOVE] Anche un componente si rimuove, come nel dettaglio ordine.
            const bIsComponent = sNodeType === "plexComponent";

            oModel.setProperty("/selectedIndex", iSelectedIndex);
            oModel.setProperty("/selectedNodeType", sNodeType || "");
            oModel.setProperty("/selectedCompIndex", iCompIndex != null ? iCompIndex : -1);
            oModel.setProperty("/removeEnabled", bIsOperation || bIsComponent);
            // Su/giù restano delle sole operazioni: l'ordine dei componenti dentro un'operazione è
            // ricalcolato a passo 10 e non è una decisione dell'utente.
            oModel.setProperty("/moveUpEnabled", bIsOperation && iSelectedIndex > 0);
            oModel.setProperty("/moveDownEnabled", bIsOperation && iSelectedIndex >= 0 && iSelectedIndex < iCount - 1);
        },

        // ----------------------------------------------------------------
        // Add Operations Dialog
        // ----------------------------------------------------------------

        onAddPlexOperations() {
            const oView = this.getView();

            if (!this._pPlexOpsDialog) {
                this._pPlexOpsDialog = Fragment.load({
                    id: oView.getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.PlexOperationsDialog",
                    controller: this
                }).then(oDialog => {
                    oView.addDependent(oDialog);

                    const oPlexOpsModel = new JSONModel({
                        operations: [],
                        allOperations: [],
                        busy: false,
                        // [PLEX-OP-TYPE-FILTER] Cio' che il dialog DICHIARA: filtro attivo, elenco
                        // filtrato a zero, o lettura fallita. Vuoto = niente da dichiarare, ed e' lo
                        // stato iniziale: un avviso mostrato prima che la lettura risponda sarebbe
                        // un falso.
                        noticeText: "",
                        noticeType: "None"
                    });
                    // [PLEX-OPS-SELECT] Il tetto di `iSizeLimit` di JSONModel vale 100 e taglia
                    // l'elenco IN SILENZIO: oggi non morde, perche' il growing della tabella chiede
                    // al binding una lunghezza esplicita, ma basta spegnere il growing o legare
                    // questo modello a un ComboBox per riportare il taglio. Vale lo stesso limite
                    // del `growingThreshold` del fragment, cosi' i due numeri non divergono.
                    oPlexOpsModel.setSizeLimit(1000);
                    oView.setModel(oPlexOpsModel, "plexOpsModel");

                    return oDialog;
                });
            }

            this._pPlexOpsDialog.then(oDialog => {
                // [PLEX-OPS-SELECT] Il dialogo e' memorizzato e riaperto: `_fetchPlexOperations`
                // ricostruisce gli oggetti da zero (quindi nessuna spunta residua), ma la
                // SearchField conserverebbe il testo della volta prima su un elenco di nuovo
                // completo — schermata che dice il falso.
                const oSearch = this.byId("plexOpsSearchField");
                if (oSearch) oSearch.setValue("");
                this._fetchPlexOperations();
                oDialog.open();
            });
        },

        // [PLEX-CONN] Plant del ciclo aperto: decide su quale tenant Plex si legge (feature 0020).
        _plexConnPlant() {
            const oDetail = this.getView().getModel("detailModel");
            return (oDetail && oDetail.getProperty("/Plant")) || "";
        },

        /**
         * [ROUTE-KEY] Il plant, oppure una dichiarazione — non una stringa vuota passata a Plex.
         *
         * IL PLANT NON ENTRA NELLA ROTTA, ed e' una scelta. La chiave del ciclo e'
         * `(gruppo, contatore, materiale)` e `Plant` e' un attributo NON chiave: la rotta lo
         * determina gia'. Metterlo nel pattern creerebbe una seconda sorgente per un fatto
         * derivato, e un URL col gruppo giusto e il plant sbagliato sarebbe PIU' pericoloso di
         * oggi, perche' sembrerebbe autorevole — oltre a rompere i preferiti gia' pubblicati.
         *
         * Quindi il plant resta quello della TESTATA, e cio' che lo rende affidabile e' altro: la
         * testata e' confrontata con la rotta (`_loadRoutingData`), il ramo «zero righe» non e' piu'
         * muto, e qui un plant assente si DICHIARA. Senza, `loadPlexConnection` lato server lancia
         * e il chiamante mostra una tendina VUOTA — che si legge come «Plex non ha niente».
         *
         * @returns {string} il plant, oppure "" dopo aver avvisato
         */
        _requirePlexConnPlant() {
            const sPlant = this._plexConnPlant();
            if (!sPlant) {
                console.error("[ROUTE-KEY] plant del ciclo non noto: la lettura verso Plex NON parte"
                    + " (senza plant non si sa su quale tenant si andrebbe)");
                MessageBox.warning(this.getView().getModel("i18n").getResourceBundle()
                    .getText("plexPlantUnknown"));
            }
            return sPlant;
        },

        _fetchPlexOperations() {
            const oPlexOpsModel = this.getView().getModel("plexOpsModel");
            oPlexOpsModel.setProperty("/busy", true);
            // L'avviso della volta prima si azzera all'apertura: il dialog e' memorizzato e
            // riaperto, e un avviso residuo su un elenco di nuovo completo direbbe il falso — la
            // stessa ragione per cui si azzera la SearchField.
            oPlexOpsModel.setProperty("/noticeText", "");

            // [PLEX-CONN] Il plant decide da quale tenant Plex si leggono le operazioni
            // (feature 0020). [PLEX-OP-TYPE-FILTER] E l'ambito CYCLE decide QUALI tipi: il filtro
            // lo applica il server, qui si dichiara il suo esito — un elenco vuoto perche' filtrato
            // e un elenco vuoto perche' Plex non ha risposto sono la stessa schermata.
            const sOpsPlant = this._requirePlexConnPlant();
            if (!sOpsPlant) { oPlexOpsModel.setProperty("/busy", false); return; }
            PlexOpsCatalog.load(sOpsPlant, PlexOpsCatalog.CYCLE_SCOPE, AppUrl.url).then((oEnv) => {
                const aExistingIds = this._aPlexOperations.map(op => op.PlexOperationId);
                const aOps = oEnv.operations.map(op => ({
                    ...op,
                    alreadySelected: aExistingIds.includes(op.id)
                }));
                const oNotice = PlexOpsCatalog.noticeFor(oEnv,
                    (sKey, aArgs) => this.getView().getModel("i18n").getResourceBundle().getText(sKey, aArgs));

                console.log(">>> Plex operations received:", aOps.length,
                    "di", oEnv.total, oEnv.filterTypes ? `(filtro «${oEnv.filterTypes}»)` : "(nessun filtro)");

                oPlexOpsModel.setProperty("/operations", aOps);
                oPlexOpsModel.setProperty("/allOperations", aOps);
                oPlexOpsModel.setProperty("/noticeText", oNotice.text);
                oPlexOpsModel.setProperty("/noticeType", oNotice.type);
                oPlexOpsModel.setProperty("/busy", false);
                // Il MessageToast resta SOLO per il guasto: gli altri avvisi vivono nel dialog, che
                // e' dove serve leggerli mentre si cerca un'operazione.
                if (!oEnv.readOk) MessageToast.show(oNotice.text);
            });
        },

        onPlexOpsDialogConfirm() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            // [PLEX-OPS-SELECT] La selezione si legge da `/allOperations`, non dalla tabella:
            // `getSelectedItems()` vede solo le righe renderizzate — quindi non quelle escluse dal
            // filtro corrente ne' quelle oltre il `growingThreshold` — e, sotto filtro, quelle
            // sbagliate (la spunta era ricordata per indice). Vedi il commento nel fragment.
            const aSelected = (this.getView().getModel("plexOpsModel").getProperty("/allOperations") || [])
                .filter(op => op && op.selected);

            if (aSelected.length === 0) {
                MessageToast.show(oResourceBundle.getText("dlgNoSelectionMsg"));
                return;
            }

            let iAdded = 0;
            const iStartSeq = (this._aPlexOperations.length) * 10 + 10;

            aSelected.forEach((oData) => {
                if (this._aPlexOperations.some(op => op.PlexOperationId === oData.id)) {
                    return;
                }

                this._aPlexOperations.push({
                    PlexOperationId: oData.id,
                    OperationCode: oData.code,
                    OperationName: oData.name,
                    SAPOperationId: null,
                    OperationNumber: iStartSeq + (iAdded * 10),
                    OperationType: null,
                    SubOperation: false,
                    Shippable: false,
                    NetWeight: null,
                    StandardQuantity: null,
                    components: [],
                    approvedWorkcenters: []
                });
                iAdded++;
            });

            this._rebuildPlexCycleTree();
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);

            this.byId("plexOperationsDialog").close();
            MessageToast.show(oResourceBundle.getText("operationsAdded", [iAdded]));
        },

        onPlexOpsDialogCancel() {
            this.byId("plexOperationsDialog").close();
        },

        onPlexOpsSearch(oEvent) {
            const sQuery = oEvent.getParameter("newValue");
            const oPlexOpsModel = this.getView().getModel("plexOpsModel");
            const aAll = oPlexOpsModel.getProperty("/allOperations") || [];
            // [PLEX-OP-TYPE-FILTER] La ricerca aggancia anche il TIPO, che ora e' una colonna del
            // dialog: si cerca cio' che si vede. La regola sta nel modulo perche' e' la stessa nei
            // tre controller (PlexOpsCatalog.matchesQuery).
            oPlexOpsModel.setProperty("/operations",
                aAll.filter((op) => PlexOpsCatalog.matchesQuery(op, sQuery)));
        },

        // ----------------------------------------------------------------
        // Approved Workcenters
        // ----------------------------------------------------------------

        onManageWorkcenters(oEvent) {
            const oSource = oEvent.getSource();
            const oCtx = oSource.getBindingContext("plexCycleModel");
            if (!oCtx) return;

            const iOpIndex = oCtx.getProperty("_index");
            if (iOpIndex === undefined || iOpIndex === null) return;

            this._iWcOpIndex = iOpIndex;
            const oView = this.getView();

            if (!this._pWcPopover) {
                this._pWcPopover = Fragment.load({
                    id: oView.getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.WorkcentersPopover",
                    controller: this
                }).then(oPopover => {
                    oView.addDependent(oPopover);

                    const oWcModel = new JSONModel({
                        workcenters: [],
                        allWorkcenters: [],
                        busy: false
                    });
                    // [WC-POPOVER-WIDTH] Il tetto di `iSizeLimit` di JSONModel vale 100 e taglia
                    // l'elenco IN SILENZIO. Oggi non morde — il growing della lista chiede una
                    // lunghezza esplicita — ma il taglio tornerebbe spegnendo il growing o legando
                    // questo modello a un ComboBox. Stesso limite del `growingThreshold`.
                    oWcModel.setSizeLimit(1000);
                    oView.setModel(oWcModel, "wcModel");

                    return oPopover;
                });
            }

            this._pWcPopover.then(oPopover => {
                this._fetchAndShowWorkcenters(oPopover, oSource);
            });
        },

        _fetchAndShowWorkcenters(oPopover, oOpenBy) {
            const oWcModel = this.getView().getModel("wcModel");

            // [PLEX-CONN] La cache e' PER PLANT (feature 0020): i centri di lavoro vengono dal
            // tenant Plex del plant, e due plant hanno due elenchi. Con una cache unica, aprendo
            // un ciclo del plant B dopo uno del plant A si sarebbero visti quelli di A.
            const sPlant = this._requirePlexConnPlant();
            if (!sPlant) return;
            if (this._mPlexWorkcentersCache && this._mPlexWorkcentersCache[sPlant]) {
                this._prepareWcList(this._mPlexWorkcentersCache[sPlant]);
                oPopover.openBy(oOpenBy);
                return;
            }

            oWcModel.setProperty("/busy", true);

            fetch(AppUrl.url("/plex/getPlexWorkcenters"), {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ Plant: sPlant })
            })
            .then(r => r.json())
            .then(data => {
                // [ROUTE-KEY] Un errore di CAP non ha ne' forma array ne' `value`: senza questa
                // riga cadeva in `[]`, cioe' un popover VUOTO senza nessun messaggio — la tendina
                // vuota di DEC-81, che si legge come «Plex non ha centri di lavoro». Il `.catch`
                // qui sotto mostra gia' il messaggio: bastava non inghiottire l'errore.
                if (!Array.isArray(data) && data && data.error) {
                    throw new Error(data.error.message || "errore dal server");
                }
                const aRaw = Array.isArray(data) ? data : (data.value || []);
                console.log(">>> Plex workcenters received:", aRaw.length);
                this._mPlexWorkcentersCache = this._mPlexWorkcentersCache || {};
                this._mPlexWorkcentersCache[sPlant] = aRaw;
                this._prepareWcList(aRaw);
                oWcModel.setProperty("/busy", false);
                oPopover.openBy(oOpenBy);
            })
            .catch(err => {
                console.error(">>> Error fetching Plex workcenters:", err);
                oWcModel.setProperty("/busy", false);
                MessageToast.show(err.message);
            });
        },

        _prepareWcList(aAllWorkcenters) {
            const oWcModel = this.getView().getModel("wcModel");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const op = this._aPlexOperations[this._iWcOpIndex];
            const aCurrentIds = (op.approvedWorkcenters || []).map(wc => wc.WorkcenterId);

            // [W1-08] Chi tiene già quel work center fra le ALTRE operazioni del ciclo (BBP §7.6.2).
            // Si marca in lista invece di nascondere la voce: un work center che non compare più
            // sarebbe indistinguibile da un work center che Plex non ha, e la ragione — «è già
            // sull'operazione OP0020» — è esattamente quello che serve per decidere.
            const mHolders = ApprovedWcConflicts.holdersByWorkcenter(this._aPlexOperations, this._iWcOpIndex);

            const aWcList = aAllWorkcenters.map(wc => {
                const sHolder = mHolders[ApprovedWcConflicts.wcKey(wc.id)];
                return {
                    ...wc,
                    selected: aCurrentIds.includes(wc.id),
                    conflictOp: sHolder || "",
                    infoText: sHolder ? oResourceBundle.getText("wcAlreadyOnOp", [sHolder]) : (wc.workcenterType || ""),
                    infoState: sHolder ? "Warning" : "None"
                };
            });

            oWcModel.setProperty("/workcenters", aWcList);
            oWcModel.setProperty("/allWorkcenters", aWcList);
        },

        onWcSearch(oEvent) {
            const sQuery = oEvent.getParameter("newValue").toLowerCase();
            const oWcModel = this.getView().getModel("wcModel");
            const aAll = oWcModel.getProperty("/allWorkcenters") || [];

            if (!sQuery) {
                oWcModel.setProperty("/workcenters", aAll);
                return;
            }

            const aFiltered = aAll.filter(wc =>
                (wc.workcenterCode || "").toLowerCase().includes(sQuery) ||
                (wc.name || "").toLowerCase().includes(sQuery) ||
                (wc.workcenterType || "").toLowerCase().includes(sQuery)
            );
            oWcModel.setProperty("/workcenters", aFiltered);
        },

        onWcPopoverConfirm() {
            const oWcModel = this.getView().getModel("wcModel");
            const aAll = oWcModel.getProperty("/allWorkcenters") || [];
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // Collect selected workcenters from the full list (not just filtered)
            const aSelected = aAll.filter(wc => wc.selected).map(wc => ({
                WorkcenterId: wc.id,
                WorkcenterCode: wc.workcenterCode,
                WorkcenterName: wc.name
            }));

            // [W1-08] La selezione in conflitto NON si applica e il popover resta aperto: la
            // correzione è un clic, mentre applicarla e lasciar fallire il salvataggio farebbe
            // scoprire il problema a ciclo finito. Il server rifiuta comunque — è lì che la regola
            // non si scavalca — ma qui l'utente ha ancora davanti la scelta che l'ha causato.
            const aConflicts = ApprovedWcConflicts.conflictsOf(
                aSelected,
                ApprovedWcConflicts.holdersByWorkcenter(this._aPlexOperations, this._iWcOpIndex)
            );
            if (aConflicts.length > 0) {
                const sList = aConflicts
                    .map(c => oResourceBundle.getText("wcConflictLine", [c.wcLabel, c.holderLabel]))
                    .join("\n");
                MessageBox.error(oResourceBundle.getText("wcConflictOnConfirm", [sList]), {
                    title: oResourceBundle.getText("wcConflictTitle")
                });
                return;
            }

            this._aPlexOperations[this._iWcOpIndex].approvedWorkcenters = aSelected;
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);
            this._rebuildPlexCycleTree();

            this.byId("workcentersPopover").close();
            MessageToast.show(oResourceBundle.getText("wcUpdated", [aSelected.length]));
        },

        onWcPopoverCancel() {
            this.byId("workcentersPopover").close();
        },

        // ----------------------------------------------------------------
        // Remove Operation
        // ----------------------------------------------------------------

        onRemovePlexOperation() {
            const oModel = this.getView().getModel("plexCycleModel");
            const iIndex = oModel.getProperty("/selectedIndex");
            const sNodeType = oModel.getProperty("/selectedNodeType");
            const iCompIndex = oModel.getProperty("/selectedCompIndex");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // ------------------------------------------------------------
            // [ORDER-COMP-REMOVE] Un COMPONENTE dal ciclo (feature 0026).
            //
            // I componenti del ciclo nascono dalla distinta SAP, e da qui si toglie quello che su
            // Plex non deve stare. Il testo di conferma dichiara i due limiti, perché senza di essi
            // la rimozione sembrerebbe definitiva e non lo è: la riga già inviata a Plex NON viene
            // rimossa (il trasferimento del ciclo lavora solo in aggiunta, W1-33), e il job notturno
            // ricalcola le assegnazioni dalla distinta SAP, quindi può rimettere il componente.
            //
            // Il gemello dell'ORDINE è un'altra cosa e non va confuso: là la rimozione si persiste e
            // restringe ciò che viene inviato (DEC-87). Qui vale per l'invio manuale che segue.
            // ------------------------------------------------------------
            if (sNodeType === "plexComponent" && iIndex >= 0 && iCompIndex >= 0) {
                const oOp = this._aPlexOperations[iIndex];
                const oComp = oOp && oOp.components && oOp.components[iCompIndex];
                if (!oComp) return;

                MessageBox.confirm(
                    oResourceBundle.getText("confirmRemoveRoutingComponent", [oComp.Material]),
                    {
                        onClose: (sAction) => {
                            if (sAction !== MessageBox.Action.OK) return;
                            oOp.components.splice(iCompIndex, 1);
                            oOp.components.forEach((c, i) => { c.Sequence = (i + 1) * 10; });
                            this._rebuildPlexCycleTree();
                            oModel.setProperty("/dirty", true);
                            MessageToast.show(oResourceBundle.getText("componentRemoved"));
                        }
                    }
                );
                return;
            }

            if (sNodeType === "plexOperation" && iIndex >= 0 && iIndex < this._aPlexOperations.length) {
                const sOpName = this._aPlexOperations[iIndex].OperationName;

                MessageBox.confirm(
                    oResourceBundle.getText("confirmRemoveOperation", [sOpName]),
                    {
                        onClose: (sAction) => {
                            if (sAction === MessageBox.Action.OK) {
                                this._aPlexOperations.splice(iIndex, 1);
                                this._recalculateSequences();
                                this._rebuildPlexCycleTree();
                                oModel.setProperty("/dirty", true);
                            }
                        }
                    }
                );
            }
        },

        // ----------------------------------------------------------------
        // Move Up / Down
        // ----------------------------------------------------------------

        onMoveOperationUp() {
            const oModel = this.getView().getModel("plexCycleModel");
            const iIndex = oModel.getProperty("/selectedIndex");

            if (iIndex <= 0) return;

            const temp = this._aPlexOperations[iIndex];
            this._aPlexOperations[iIndex] = this._aPlexOperations[iIndex - 1];
            this._aPlexOperations[iIndex - 1] = temp;

            this._recalculateSequences();
            this._rebuildPlexCycleTree();
            oModel.setProperty("/dirty", true);

            setTimeout(() => {
                this._selectPlexTreeItem(iIndex - 1);
            }, 150);
        },

        onPlexTreeDrop(oEvent) {
            const oDraggedItem = oEvent.getParameter("draggedControl");
            const oDroppedItem = oEvent.getParameter("droppedControl");
            const sDropPosition = oEvent.getParameter("dropPosition");

            // Check if this is a cross-tree drag (from SAP tree)
            const oDragContext = oDraggedItem.getBindingContext("plexCycleModel");
            if (!oDragContext) {
                // Try SAP tree context
                const oSapDragContext = oDraggedItem.getBindingContext("treeModel");
                if (oSapDragContext) {
                    this._handleCrossTreeDrop(oSapDragContext, oDroppedItem, sDropPosition);
                }
                return;
            }

            const oDropContext = oDroppedItem.getBindingContext("plexCycleModel");
            if (!oDropContext) return;

            const sDragNodeType = oDragContext.getProperty("nodeType");

            // Component move between operations
            if (sDragNodeType === "plexComponent") {
                this._handleComponentMove(oDragContext, oDropContext);
                return;
            }

            // Operation-to-operation reorder
            if (sDragNodeType !== "plexOperation") return;
            if (oDropContext.getProperty("nodeType") !== "plexOperation") return;

            const iDragIndex = oDragContext.getProperty("_index");
            const iDropIndex = oDropContext.getProperty("_index");
            if (iDragIndex === iDropIndex) return;

            // Remove from old position
            const [oDraggedOp] = this._aPlexOperations.splice(iDragIndex, 1);

            // Calculate new insert position
            let iNewIndex = iDropIndex;
            if (sDropPosition === "After") {
                iNewIndex = iDragIndex < iDropIndex ? iDropIndex : iDropIndex + 1;
            } else {
                iNewIndex = iDragIndex < iDropIndex ? iDropIndex - 1 : iDropIndex;
            }

            this._aPlexOperations.splice(iNewIndex, 0, oDraggedOp);

            this._recalculateSequences();
            this._rebuildPlexCycleTree();
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);

            setTimeout(() => {
                this._selectPlexTreeItem(iNewIndex);
            }, 150);
        },

        onMoveOperationDown() {
            const oModel = this.getView().getModel("plexCycleModel");
            const iIndex = oModel.getProperty("/selectedIndex");

            if (iIndex < 0 || iIndex >= this._aPlexOperations.length - 1) return;

            const temp = this._aPlexOperations[iIndex];
            this._aPlexOperations[iIndex] = this._aPlexOperations[iIndex + 1];
            this._aPlexOperations[iIndex + 1] = temp;

            this._recalculateSequences();
            this._rebuildPlexCycleTree();
            oModel.setProperty("/dirty", true);

            setTimeout(() => {
                this._selectPlexTreeItem(iIndex + 1);
            }, 150);
        },

        // ----------------------------------------------------------------
        // Cross-tree drag: SAP component → Plex operation
        // ----------------------------------------------------------------

        _handleCrossTreeDrop(oDragContext, oDroppedItem, sDropPosition) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // Only allow component nodes to be dropped
            if (oDragContext.getProperty("nodeType") !== "component") return;

            const sMaterial = oDragContext.getProperty("_srcMaterial");
            const sBOMItemNode = oDragContext.getProperty("_srcBOMItemNodeNumber");
            const fRequiredQty = oDragContext.getProperty("_srcRequiredQuantity") || 0;
            const sBaseUnit = oDragContext.getProperty("_srcBaseUnit") || "";
            // [PHANTOM-EXPLODE] Trascinando un componente esploso, la provenienza lo segue: senza,
            // il salvataggio la perderebbe e la riga tornerebbe indistinguibile da una diretta.
            const sPhantomSource = oDragContext.getProperty("_srcPhantomSource") || "";
            if (!sMaterial) return;

            // Find the target Plex operation
            const oDropContext = oDroppedItem.getBindingContext("plexCycleModel");
            if (!oDropContext) return;

            const sDropNodeType = oDropContext.getProperty("nodeType");
            let iTargetOpIndex;

            if (sDropNodeType === "plexOperation") {
                iTargetOpIndex = oDropContext.getProperty("_index");
            } else if (sDropNodeType === "plexComponent") {
                iTargetOpIndex = oDropContext.getProperty("_opIndex");
            } else {
                return;
            }

            if (iTargetOpIndex < 0 || iTargetOpIndex >= this._aPlexOperations.length) return;

            const oTargetOp = this._aPlexOperations[iTargetOpIndex];
            if (!oTargetOp.components) oTargetOp.components = [];

            // Prevent duplicate material in the same operation
            if (oTargetOp.components.some(c => c.Material === sMaterial)) {
                MessageToast.show(oResourceBundle.getText("componentAlreadyExists", [sMaterial]));
                return;
            }

            oTargetOp.components.push({
                Material: sMaterial,
                BOMItemNodeNumber: sBOMItemNode || null,
                RequiredQuantity: fRequiredQty,
                BaseUnit: sBaseUnit,
                Sequence: (oTargetOp.components.length + 1) * 10,
                PhantomSource: sPhantomSource,
                // [ROUTING-COMP-SOURCE] Trascinato dall'albero SAP su un'operazione: e' una
                // persona che ha scelto dove metterlo, quindi la riga e' manuale come lo e' una
                // ricollocazione. Il job la lascera' dov'e'.
                AssignmentSource: "MANUAL"
            });

            // [TREE-STATE] L'operazione che RICEVE si apre, cosi' si vede dove e' finito il
            // componente. Solo lei: le altre restano come l'utente le ha lasciate.
            TreeState.forget(this._oCollapsedPlex, TreeState.opKey(oTargetOp.PlexOperationId));

            this._rebuildPlexCycleTree();
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);
            MessageToast.show(oResourceBundle.getText("componentCopied", [sMaterial]));
        },

        // ----------------------------------------------------------------
        // Component move between Plex operations
        // ----------------------------------------------------------------

        _handleComponentMove(oDragContext, oDropContext) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const sDropNodeType = oDropContext.getProperty("nodeType");

            const iSrcOpIndex = oDragContext.getProperty("_opIndex");
            const iCompIndex = oDragContext.getProperty("_compIndex");

            let iTargetOpIndex;
            if (sDropNodeType === "plexOperation") {
                iTargetOpIndex = oDropContext.getProperty("_index");
            } else if (sDropNodeType === "plexComponent") {
                iTargetOpIndex = oDropContext.getProperty("_opIndex");
            } else {
                return;
            }

            if (iSrcOpIndex === iTargetOpIndex) return;

            const oSrcOp = this._aPlexOperations[iSrcOpIndex];
            const oTargetOp = this._aPlexOperations[iTargetOpIndex];
            const oComp = oSrcOp.components[iCompIndex];
            if (!oComp) return;

            // Prevent duplicate material
            if (oTargetOp.components.some(c => c.Material === oComp.Material)) {
                MessageToast.show(oResourceBundle.getText("componentAlreadyExists", [oComp.Material]));
                return;
            }

            // Move: remove from source, add to target
            oSrcOp.components.splice(iCompIndex, 1);
            oSrcOp.components.forEach((c, i) => { c.Sequence = (i + 1) * 10; });

            if (!oTargetOp.components) oTargetOp.components = [];
            // [ROUTING-COMP-SOURCE] LA RICOLLOCAZIONE A MANO RENDE LA RIGA MANUALE, ed e' il solo
            // gesto che lo fa. Da qui in avanti il job non la sposta piu', nemmeno se le regole dei
            // gruppi dicono altro: quella collocazione l'ha decisa una persona guardando il ciclo.
            // Torna sotto le regole solo premendo «auto-assegna», che e' di nuovo una persona che
            // lo chiede esplicitamente.
            oTargetOp.components.push({
                ...oComp,
                Sequence: (oTargetOp.components.length + 1) * 10,
                AssignmentSource: "MANUAL"
            });

            // [TREE-STATE] L'operazione che RICEVE si apre, cosi' si vede dove e' finito il
            // componente. Solo lei: le altre restano come l'utente le ha lasciate.
            TreeState.forget(this._oCollapsedPlex, TreeState.opKey(oTargetOp.PlexOperationId));

            this._rebuildPlexCycleTree();
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);
            MessageToast.show(oResourceBundle.getText("componentMoved", [oComp.Material]));
        },

        // ----------------------------------------------------------------
        // Import from Routing Template (replaces the whole Plex cycle, in-memory)
        // ----------------------------------------------------------------

        onImportFromTemplate() {
            const oView = this.getView();

            if (!this._pImportTemplateDialog) {
                this._pImportTemplateDialog = Fragment.load({
                    id: oView.getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.ImportTemplateDialog",
                    controller: this
                }).then(oDialog => {
                    oView.addDependent(oDialog);
                    oView.setModel(new JSONModel({ canImport: false, selectedId: null }), "importTmpl");
                    return oDialog;
                });
            }

            this._pImportTemplateDialog.then(oDialog => {
                const oState = oView.getModel("importTmpl");
                oState.setData({ canImport: false, selectedId: null });

                // Filter the template list by the routing's plant and reset the selection
                // [ROUTE-KEY] Senza plant il filtro sarebbe VUOTO e la tendina mostrerebbe i
                // template di TUTTI i plant: importarne uno costruirebbe il ciclo con le operazioni
                // di un altro stabilimento. Si dichiara e non si apre.
                const sPlant = this._requirePlexConnPlant();
                if (!sPlant) { oDialog.close(); return; }
                const oBox = this.byId("importTemplateBox");
                if (oBox) {
                    oBox.setSelectedKey(null);
                    const oBinding = oBox.getBinding("items");
                    if (oBinding) {
                        oBinding.filter(sPlant ? new Filter("Plant", FilterOperator.EQ, sPlant) : []);
                        oBinding.refresh();
                    }
                }
                oView.getModel("templateModel").refresh();
                oDialog.open();
            });
        },

        onImportTemplateSelectChange(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            const oState = this.getView().getModel("importTmpl");
            oState.setProperty("/selectedId", oItem ? oItem.getKey() : null);
            oState.setProperty("/canImport", !!oItem);
        },

        onImportTemplateCancel() {
            this.byId("importTemplateDialog").close();
        },

        onImportTemplateConfirm() {
            const sTemplateId = this.getView().getModel("importTmpl").getProperty("/selectedId");
            if (!sTemplateId) return;

            const bHasOps = this._aPlexOperations && this._aPlexOperations.length > 0;
            if (bHasOps) {
                const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
                MessageBox.confirm(oResourceBundle.getText("confirmImportTemplate"), {
                    onClose: (sAction) => {
                        if (sAction === MessageBox.Action.OK) this._doImportTemplate(sTemplateId);
                    }
                });
            } else {
                this._doImportTemplate(sTemplateId);
            }
        },

        /**
         * [TEMPLATE-AUTOASSIGN] C'e' almeno un gruppo oggetti sull'albero in memoria?
         *
         * E' il cancello di tutta la feature, e sta in un metodo perche' lo chiedono in due: il
         * messaggio dell'import e — attraverso `_importedGroupOperations` — il corpo di
         * «Auto-Assegna». Esce al primo trovato.
         *
         * Vero solo dopo un import di template con gruppi: il caricamento di un ciclo salvato, il
         * dialog delle operazioni e l'auto-assegnazione non scrivono `objectGroups`, e infatti un
         * salvataggio ordinario non deve toccare la configurazione.
         *
         * @returns {boolean}
         */
        _hasImportedGroups() {
            return (this._aPlexOperations || []).some(op => (op && op.objectGroups || []).length > 0);
        },

        /**
         * [TEMPLATE-AUTOASSIGN] Le sole operazioni che portano gruppi, coi soli campi che servono.
         *
         * Il server ricava la terna (materiale, gruppo, operazione) da qui, con la STESSA funzione
         * pura che la persiste al salvataggio: e' cio' che fa combaciare l'anteprima di
         * «Auto-Assegna» con l'albero che si vedra' dopo il Salva. Per questo la derivazione non si
         * fa qui — sarebbe la seconda copia, e due copie divergono.
         *
         * Si manda il MINIMO: su un ciclo da quindici operazioni con tre gruppi partono tre oggetti
         * piccoli invece del tronco intero, che porterebbe componenti e centri di lavoro che
         * l'action non guarda. Nessun gruppo: array vuoto, e il server legge il database come
         * sempre.
         *
         * @returns {Array<Object>} operazioni con `ObjectGroups`, nella forma del payload
         */
        _importedGroupOperations() {
            return (this._aPlexOperations || [])
                .filter(op => (op && op.objectGroups || []).length > 0)
                .map(op => ({
                    PlexOperationId: op.PlexOperationId,
                    OperationCode: op.OperationCode,
                    OperationName: op.OperationName,
                    ObjectGroups: op.objectGroups.map(sGroupId => ({ GroupId: sGroupId }))
                }));
        },

        // Fetches the template operations + approved workcenters and REPLACES the entire
        // in-memory Plex cycle. Nothing is persisted until the user clicks Save.
        _doImportTemplate(sTemplateId) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const sId = encodeURIComponent(sTemplateId);
            const sOpsUrl = AppUrl.url(`/routing-templates/RoutingTemplateOperations?$filter=TemplateID eq ${sId}&$orderby=Sequence asc`);
            const sWcUrl = AppUrl.url(`/routing-templates/RoutingTemplateWorkcenters?$filter=TemplateID eq ${sId}`);
            // [TEMPLATE-AUTOASSIGN] I gruppi oggetti del template. Il `$filter` sul TemplateID non
            // e' solo un criterio, e' il gate: quella entity non ha la colonna Plant, quindi il
            // server RIFIUTA una lettura senza criteri (feature 0048).
            const sOgUrl = AppUrl.url(`/routing-templates/RoutingTemplateGroups?$filter=TemplateID eq ${sId}`);

            Promise.all([
                fetch(sOpsUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sWcUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sOgUrl, { headers: { "Accept": "application/json" } }).then(r => r.json())
            ])
            .then(([opsData, wcData, ogData]) => {
                // [MASS-IMPORT] REPLACE the whole cycle, con la mappatura CONDIVISA con l'import
                // massivo: i legami SAP si azzerano, i componenti nascono vuoti, i gruppi viaggiano
                // in memoria fino al salvataggio ([TEMPLATE-AUTOASSIGN]). Stava qui in linea, e
                // dall'import massivo i chiamanti sono DUE: due copie darebbero due alberi diversi
                // dagli stessi dati, e i due gesti non si confrontano mai.
                this._aPlexOperations = TemplateImport.operationsFromTemplate(
                    opsData.value,
                    TemplateImport.byOperation(wcData.value, wc => ({
                        WorkcenterId: wc.WorkcenterId,
                        WorkcenterCode: wc.WorkcenterCode || "",
                        WorkcenterName: wc.WorkcenterName || ""
                    })),
                    TemplateImport.byOperation(ogData.value, row => row.GroupId || null)
                );

                this._recalculateSequences();
                this._clearAllHighlights();
                this._rebuildPlexCycleTree();
                this.getView().getModel("plexCycleModel").setProperty("/dirty", true);

                this.byId("importTemplateDialog").close();

                // [TEMPLATE-AUTOASSIGN] IL MESSAGGIO DICE QUALE DEI DUE CASI E'. L'effetto sulla
                // configurazione di auto-assegnazione e' una scrittura vera e arriva al salvataggio:
                // un messaggio uguale nei due casi la lascerebbe scoprire dopo, su una tabella che
                // nessuno stava guardando. Col materiale vuoto — il ciclo SAP senza assegnazione —
                // non c'e' nessun materiale su cui scrivere, e vale il messaggio dell'altro caso.
                const bRewrites = this._hasImportedGroups() && !!this._sMaterial;
                MessageToast.show(oResourceBundle.getText(
                    bRewrites ? "templateImportedWithGroups" : "templateImportedNoGroups",
                    bRewrites
                        ? [this._aPlexOperations.length, this._sMaterial]
                        : [this._aPlexOperations.length]
                ));
            })
            .catch(err => {
                console.error(">>> Error importing template:", err);
                MessageToast.show(oResourceBundle.getText("templateImportError"));
            });
        },

        // ----------------------------------------------------------------
        // Save Routing Plex Cycle
        // ----------------------------------------------------------------

        onSaveRoutingPlexCycle() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oModel = this.getView().getModel("plexCycleModel");

            const oPayload = {
                ProductionRoutingGroup: this._sRoutingGroup,
                ProductionRouting: this._sRouting,
                // [ROUTING-BY-MATERIAL] Obbligatorio: e' lo scope del delete+insert lato server.
                Material: this._sMaterial,
                Operations: this._aPlexOperations.map(op => ({
                    PlexOperationId: op.PlexOperationId,
                    OperationCode: op.OperationCode,
                    OperationName: op.OperationName,
                    SAPOperationId: op.SAPOperationId || null,
                    ProductionRoutingOpIntID: op.ProductionRoutingOpIntID || null,
                    OperationNumber: op.OperationNumber || null,
                    OperationType: op.OperationType || null,
                    SubOperation: op.SubOperation || false,
                    Shippable: op.Shippable || false,
                    NetWeight: op.NetWeight || null,
                    StandardQuantity: op.StandardQuantity || null,
                    Components: (op.components || []).map(comp => ({
                        Material: comp.Material,
                        BOMItemNodeNumber: comp.BOMItemNodeNumber,
                        RequiredQuantity: comp.RequiredQuantity || 0,
                        BaseUnit: comp.BaseUnit || "",
                        PhantomSource: comp.PhantomSource || "",
                        // [ROUTING-COMP-SOURCE] La provenienza torna al server insieme al
                        // componente: senza, il DELETE + INSERT del salvataggio la perderebbe.
                        AssignmentSource: comp.AssignmentSource || "AUTO"
                    })),
                    ApprovedWorkcenters: (op.approvedWorkcenters || []).map(wc => ({
                        WorkcenterId: wc.WorkcenterId,
                        WorkcenterCode: wc.WorkcenterCode,
                        WorkcenterName: wc.WorkcenterName
                    })),
                    // [TEMPLATE-AUTOASSIGN] I gruppi arrivati con un import di template. Con almeno
                    // uno il server sostituisce la configurazione di auto-assegnazione del
                    // materiale; senza, non la tocca.
                    ObjectGroups: (op.objectGroups || []).map(sGroupId => ({ GroupId: sGroupId }))
                }))
            };

            fetch(AppUrl.url("/production-routings/saveRoutingPlexCycle"), {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(oPayload)
            })
            // [W1-08] IL MESSAGGIO DEL SERVER SI LEGGE. Prima ogni esito non riuscito diventava il
            // generico «Errore nel salvataggio del ciclo routing»: un 400 con la ragione dentro —
            // materiale mancante, work center su due operazioni — arrivava e veniva buttato via, e
            // l'utente non aveva modo di sapere cosa correggere. Stessa lettura di onSaveTemplate.
            .then(async r => {
                const body = await r.json().catch(() => ({}));
                if (!r.ok) {
                    throw new Error((body && body.error && body.error.message)
                        || oResourceBundle.getText("routingCycleSaveError"));
                }
                return body;
            })
            .then(result => {
                if (result.success) {
                    // [TEMPLATE-AUTOASSIGN] Se la configurazione di auto-assegnazione e' stata
                    // sostituita lo dice il messaggio, con quante regole: una scrittura su una
                    // tabella che nessuno stava guardando, taciuta, si scopre solo quando qualcosa
                    // non si colloca piu'.
                    MessageToast.show(result.autoAssignRewritten
                        ? oResourceBundle.getText("routingCycleSavedWithRules",
                            [result.count, result.autoAssignRows, this._sMaterial])
                        : oResourceBundle.getText("routingCycleSaved", [result.count]));
                    oModel.setProperty("/dirty", false);
                    // [TEMPLATE-AUTOASSIGN] I gruppi si CONSUMANO: l'import arma, il salvataggio
                    // esegue, una volta sola. Lasciarli in memoria farebbe riscrivere la
                    // configurazione a ogni salvataggio successivo della stessa scheda — e chi nel
                    // frattempo avesse corretto a mano una regola se la vedrebbe sparire di nuovo,
                    // senza aver importato niente.
                    this._aPlexOperations.forEach(op => { if (op) op.objectGroups = []; });
                } else {
                    MessageToast.show(oResourceBundle.getText("routingCycleSaveError"));
                }
            })
            .catch(err => {
                console.error(">>> Error saving routing Plex cycle:", err);
                MessageBox.error(err.message || oResourceBundle.getText("routingCycleSaveError"));
            });
        },

        // ----------------------------------------------------------------
        // Auto-Assign BOM components to Plex operations (via customizing groups)
        // ----------------------------------------------------------------

        onAutoAssignComponents() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            if (!this._aPlexOperations || this._aPlexOperations.length === 0) {
                MessageBox.warning(oResourceBundle.getText("autoAssignNoOperations"));
                return;
            }

            // [COMP-SOURCE] NESSUNA CONFERMA, perche' non c'e' piu' niente da perdere: dall'11/09/2026
            // le righe collocate a mano NON tornano sotto le regole — restano dove sono, e il
            // riepilogo le dichiara (vedi `_applyAutoAssignments`). Una conferma che chiede il
            // permesso per un danno che non avviene insegna solo a premere OK senza leggere.
            this._runAutoAssignComponents();
        },

        /** [COMP-SOURCE] La chiamata vera, separata dalla conferma: un solo punto d'invio. */
        _runAutoAssignComponents() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oDetailModel = this.getView().getModel("detailModel");
            // [LOAD-GEN] La generazione al momento della partenza. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            // Velo di PAGINA e non d'area, come `_executeSyncPlexCycle`: la risposta svuota TUTTE
            // le operazioni e ricolloca da zero, quindi qualunque gesto fatto nell'attesa — un
            // drag&drop sull'albero, un secondo clic sul pulsante — verrebbe buttato via senza che
            // nessuno lo dica. L'action legge da SAP i componenti e poi la classificazione, che su
            // Integration Suite e' una richiesta per materiale (DEC-122): l'attesa e' lunga, e
            // finora non era segnalata in nessun modo.
            oDetailModel.setProperty("/busy", true);

            // [ACTION-RESULT] Quanto e' durata: serve al messaggio del taglio per tempo, che senza
            // un numero non distingue «la rete e' caduta subito» da «ci ha messo troppo».
            const iStartedAt = Date.now();

            fetch(AppUrl.url("/production-routings/autoAssignPlexCycle"), {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({
                    ProductionRoutingGroup: this._sRoutingGroup,
                    ProductionRouting: this._sRouting,
                    // [ROUTING-BY-MATERIAL] Prima il server deduceva il primo materiale del ciclo,
                    // quindi l'auto-assegnazione girava sui componenti di un altro materiale.
                    Material: this._sMaterial,
                    // [TEMPLATE-AUTOASSIGN] Le regole del template importato e non ancora salvato,
                    // o il server userebbe quelle VECCHIE — che il Salva sta per sostituire.
                    // Vanno le SOLE operazioni che hanno almeno un gruppo, coi soli campi che
                    // servono a comporre la terna: l'albero intero porterebbe componenti e centri
                    // di lavoro che l'action non guarda.
                    Operations: this._importedGroupOperations()
                })
            })
            // [ACTION-RESULT] Si guarda `r.ok` PRIMA di applicare. `_applyAutoAssignments` svuota le
            // righe automatiche di tutte le operazioni e mette `/dirty`: su un esito che non e' un
            // esito non deve girare affatto. Il predicato di forma e' `assignments`, che e'
            // esattamente cio' che quella funzione legge.
            .then(r => ActionResult.read(r, b => Array.isArray(b && b.assignments)))
            .catch(err => ActionResult.fromNetworkError(err))
            .then(outcome => {
                if (ActionResult.isOk(outcome)) {
                    this._applyAutoAssignments(outcome.body);
                } else {
                    this._reportAutoAssignFailure(outcome, Date.now() - iStartedAt);
                }
                // [IS-CALL-LOG] l'auto-assegnazione legge la classificazione da SAP: in console
                // le chiamate come sono state fatte. Da rimuovere a migrazione conclusa.
                IsCallLog.dump("auto-assegnazione componenti ciclo " + this._sRoutingGroup + "/" + this._sRouting);
            })
            .catch(err => {
                // Ci arriva solo un'eccezione DENTRO `_applyAutoAssignments`: le specie di esito
                // sono gia' state trattate qui sopra e non lanciano.
                console.error(">>> Error auto-assigning components:", err);
                MessageBox.error(oResourceBundle.getText("autoAssignError"));
            })
            .finally(() => {
                // Un punto solo, e non lo spegnimento ripetuto nei due rami: i due non possono
                // divergere, e questo copre anche un'eccezione dentro `_applyAutoAssignments`.
                // [LOAD-GEN] Il velo non ferma il tasto «indietro» DEL BROWSER: se nel frattempo
                // si e' cambiato oggetto, il velo e' quello che il caricamento nuovo ha appena
                // acceso, e lo spegne lui.
                if (LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) {
                    oDetailModel.setProperty("/busy", false);
                }
            });
        },

        /**
         * [ACTION-RESULT] L'auto-assegnazione non e' riuscita: si dichiara COSA e' successo, e
         * l'albero resta dov'era.
         *
         * Il punto che questa funzione protegge non e' il testo: e' il `return` implicito. Prima non
         * esisteva un ramo di fallimento — un errore del server finiva in `_applyAutoAssignments`,
         * che svuota le righe automatiche di ogni operazione e mette `/dirty` a true. L'utente
         * leggeva «0 assegnati» in un dialogo INFORMATIVO, con l'albero gia' svuotato sotto.
         */
        _reportAutoAssignFailure(oOutcome, iElapsedMs) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            console.error(">>> [ACTION-RESULT] auto-assegnazione ciclo non riuscita:",
                oOutcome.kind, "HTTP", oOutcome.status, oOutcome.message || "", `${iElapsedMs} ms`);

            const oFail = AutoAssignReport.failure(oOutcome, iElapsedMs, oResourceBundle);
            // La sessione scaduta la annuncia SessionGuard, con il dialogo che sa anche cosa fare
            // delle modifiche aperte: qui si tace di proposito.
            if (oFail.silent) { return; }
            MessageBox.error(oFail.text);
        },

        // Replace semantics: clears the AUTOMATIC components from all operations, then inserts
        // each assignment into its resolved operation (FIRST_OP / LAST_OP / concrete code).
        //
        // [COMP-SOURCE] LE RIGHE COLLOCATE A MANO NON SI TOCCANO (11/09/2026).
        //
        // Fino a quel giorno questa funzione svuotava OGNI operazione e riscriveva l'intero albero
        // ad 'AUTO': era la conversione dichiarata dalla 0036 RB-08, con la sua conferma. Faceva
        // pero' l'opposto di tre cose che gia' esistevano — il tooltip della puntina («Collocato a
        // mano: l'auto-assegnazione non lo sposta»), `planCycleComponents` sull'invio del ciclo
        // («la collocazione fatta a mano vince, e non passa dalla regola») e `applyManualTargets`
        // sull'invio dell'ordine. Il cockpit era l'unico posto in cui la mano perdeva.
        //
        // Adesso: si svuota solo cio' che le regole governano, le righe manuali restano dove sono,
        // e i loro materiali sono ESCLUSI dal ricalcolo. Per rimettere una riga sotto le regole si
        // toglie dall'albero e si ri-assegna: non essendo piu' manuale, la regola la ricolloca.
        _applyAutoAssignments(result) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oModel = this.getView().getModel("plexCycleModel");
            const aAssignments = (result && result.assignments) || [];
            const aUnassigned = (result && result.unassigned) || [];

            // ------------------------------------------------------------
            // [COMP-SOURCE] LA FOTOGRAFIA SI PRENDE PRIMA DELLO SVUOTAMENTO. Calcolata dopo
            // sarebbe vuota, e «vuoto» qui vorrebbe dire «nessuna riga da proteggere»: il
            // comportamento di prima, senza nemmeno il dialogo che lo dichiarava.
            //
            // `null` come insieme SAP e non e' una dimenticanza: sul CICLO il browser non ha la
            // seconda lettura dei componenti che ha il server, e marcherebbe orfano cio' che non
            // lo e' (DEC-107). La potatura delle righe manuali senza piu' un componente dietro
            // resta dov'e', all'invio, coi due guardiani di `pruneOrphans`.
            // ------------------------------------------------------------
            const oKeep = CompSource.manualMaterials(this._aPlexOperations, null);

            // L'esito delle regole, per materiale: la mano decide DOVE, la sorgente decide QUANTO.
            // Sono le semantiche di `applyManualTargets` sull'ordine, non una terza.
            const mByMaterial = new Map();
            aAssignments.forEach(a => {
                const sKey = CompSource.matKey(a && a.Material);
                if (sKey && !mByMaterial.has(sKey)) mByMaterial.set(sKey, a);
            });

            const aKept = [];
            this._aPlexOperations.forEach(op => {
                op.components = (op.components || []).filter(c => {
                    // Solo le righe che una persona ha messo: la riga AUTOMATICA di un materiale
                    // manuale se ne va con le altre, ed e' la stessa scelta del server, dove
                    // finisce in `autoReplacedIds` e non viene ricreata.
                    if (!CompSource.isManual(c && c.AssignmentSource)) return false;
                    return oKeep.has(CompSource.matKey(c && c.Material));
                });
                op.components.forEach(c => {
                    const a = mByMaterial.get(CompSource.matKey(c.Material));
                    if (a) {
                        c.RequiredQuantity = a.RequiredQuantity || 0;
                        c.BaseUnit = a.BaseUnit || "";
                        c.BOMItemNodeNumber = a.BOMItemNodeNumber || null;
                        c.PhantomSource = a.PhantomSource || "";
                    }
                    aKept.push({
                        Material: c.Material,
                        TargetOperationName: op.OperationName || op.OperationCode || ""
                    });
                });
            });

            // Ordered operations (by OperationNumber) for FIRST/LAST resolution
            const aOrdered = this._aPlexOperations.slice()
                .sort((a, b) => (a.OperationNumber || 0) - (b.OperationNumber || 0));
            const oFirst = aOrdered[0];
            const oLast = aOrdered[aOrdered.length - 1];

            // [AUTO-ASSIGN] I saltati si RACCOLGONO, non si contano: un contatore dice quanti, e
            // per capire perche' un componente non c'e' serve sapere QUALE e verso quale operazione
            // puntava la sua regola. Contarli e basta e' costato due giri di log l'11/09/2026.
            let iAssigned = 0;
            const aSkipped = [];
            aAssignments.forEach(a => {
                // [COMP-SOURCE] La granularita' e' il MATERIALE e non la coppia (operazione,
                // materiale), come 0036 RB-05: senza questo salto lo stesso componente comparirebbe
                // due volte, dove l'ha messo la mano e dove dice la regola.
                if (oKeep.has(CompSource.matKey(a && a.Material))) return;
                let oTargetOp = null;
                if (a.TargetOperation === "FIRST_OP") {
                    oTargetOp = oFirst;
                } else if (a.TargetOperation === "LAST_OP") {
                    oTargetOp = oLast;
                } else {
                    oTargetOp = this._aPlexOperations.find(op =>
                        op.OperationCode === a.TargetOperation || op.PlexOperationId === a.TargetOperation);
                }
                if (!oTargetOp) { aSkipped.push(a); return; }
                if (oTargetOp.components.some(c => c.Material === a.Material)) { return; }
                oTargetOp.components.push({
                    Material: a.Material,
                    BOMItemNodeNumber: a.BOMItemNodeNumber || null,
                    RequiredQuantity: a.RequiredQuantity || 0,
                    BaseUnit: a.BaseUnit || "",
                    Sequence: (oTargetOp.components.length + 1) * 10,
                    PhantomSource: a.PhantomSource || "",
                    // [ROUTING-COMP-SOURCE] Collocato dalle regole: automatico. Le righe manuali
                    // non passano di qui — sono state escluse qui sopra.
                    AssignmentSource: "AUTO"
                });
                iAssigned++;
            });

            // Le righe conservate tenevano la sequenza della vita precedente: senza questo giro una
            // riga manuale con `Sequence` 30 resterebbe sotto una riga nuova numerata 20.
            this._aPlexOperations.forEach(op => {
                (op.components || []).forEach((c, i) => { c.Sequence = (i + 1) * 10; });
            });

            this._rebuildPlexCycleTree();
            oModel.setProperty("/dirty", true);

            // [COMP-SOURCE] Un materiale conservato non e' un materiale «non assegnato»: sta
            // nell'albero, e contarlo fra i mancanti direbbe il falso proprio sul numero che si
            // guarda per primo.
            const aOut = aUnassigned.filter(u => !oKeep.has(CompSource.matKey(u && u.Material)));

            // Feature 0018: la classificazione non letta NON e' un dettaglio del riepilogo. I
            // componenti con condizione CLASS risultano «non assegnati» esattamente come quelli
            // che nessuna regola aggancia: senza l'avviso, un risultato incompleto si legge come
            // un risultato completo.
            const sSummary = oResourceBundle.getText("autoAssignSummary", [iAssigned, aOut.length, aSkipped.length]);
            const sDetail = AutoAssignReport.detail(aOut, aSkipped, oResourceBundle);
            // Le conservate stanno FUORI dal dettaglio: non sono un problema, e se entrassero li'
            // trasformerebbero in avviso un'auto-assegnazione perfettamente riuscita.
            const sKept = AutoAssignReport.kept(aKept, oResourceBundle);
            const sText = [sSummary, sDetail, sKept].filter(Boolean).join("\n\n");
            if (result && result.ClassificationStatus === "KO") {
                MessageBox.warning(sText + "\n\n" + oResourceBundle.getText("autoAssignClfnUnavailable"));
            } else if (sDetail) {
                // [AUTO-ASSIGN] Un componente rimasto fuori non e' un esito riuscito: a schermo
                // resta una parte dell'albero non collocata, e l'invio poi si ferma. `information`
                // lo leggerebbe come «tutto a posto».
                MessageBox.warning(sText);
            } else {
                MessageBox.information(sText);
            }
        },


        // ----------------------------------------------------------------
        // Sync Plex Cycle to Plex MDM
        // ----------------------------------------------------------------

        onSyncPlexCycle() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oModel = this.getView().getModel("plexCycleModel");

            // Check operations exist
            if (!this._aPlexOperations || this._aPlexOperations.length === 0) {
                MessageBox.warning(oResourceBundle.getText("syncPlexNoOps"));
                return;
            }

            // Check unsaved changes
            if (oModel.getProperty("/dirty")) {
                MessageBox.warning(oResourceBundle.getText("syncPlexSaveFirst"));
                return;
            }

            // [ROUTING-BY-MATERIAL] Il materiale e' quello della riga di lista, uno solo. Prima
            // qui arrivava una stringa di materiali separati da virgola e si prendeva
            // `split(",")[0]`: il ciclo finiva SEMPRE sulla part del primo materiale del ciclo
            // SAP, e per gli altri materiali l'invio non avveniva mai — con esito «riuscito».
            const sMaterial = this._sMaterial;

            if (!sMaterial) {
                MessageBox.warning(oResourceBundle.getText("syncPlexNoMaterial"));
                return;
            }

            // Confirm
            const sMessage = oResourceBundle.getText("syncPlexConfirm", [this._aPlexOperations.length, sMaterial]);
            MessageBox.confirm(sMessage, {
                onClose: (sAction) => {
                    if (sAction === MessageBox.Action.OK) {
                        this._executeSyncPlexCycle(sMaterial);
                    }
                }
            });
        },

        _executeSyncPlexCycle(sMaterial) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oDetailModel = this.getView().getModel("detailModel");
            oDetailModel.setProperty("/busy", true);

            const oPayload = {
                ProductionRoutingGroup: this._sRoutingGroup,
                ProductionRouting: this._sRouting,
                Material: sMaterial
            };

            // [ACTION-RESULT] Quanto e' durata: il messaggio del taglio per tempo senza un numero
            // non distingue «la rete e' caduta subito» da «ci ha messo troppo».
            const iStartedAt = Date.now();

            fetch(AppUrl.url("/production-routings/syncRoutingPlexCycle"), {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(oPayload)
            })
            // [ACTION-RESULT] Si guarda `r.ok` PRIMA di leggere il corpo, e il caso che l'ha
            // imposto e' questo invio: il 14/09/2026 il ciclo 07NPE040/01/3201890 ha mostrato
            // «Unexpected token 'G', "Gateway Timeout" is not valid JSON» mentre su Plex RIUSCIVA
            // — 15 operazioni, 33 righe di distinta, 15 centri di lavoro, riga «Successo» nello
            // storico. Il corpo di un 504 dell'approuter e' TESTO, e `r.json()` ne faceva un
            // SyntaxError che finiva tale e quale dentro la MessageBox.
            //
            // Il predicato di forma e' `success`, che e' esattamente cio' che il ramo qui sotto
            // legge: l'action risponde `200` ANCHE quando dichiara un esito applicativo non
            // riuscito (0012 RB-15, `req.error` rollerebbe indietro le righe di log), e quel ramo
            // resta invariato.
            .then(r => ActionResult.read(r, b => b && typeof b.success === "boolean"))
            .catch(err => ActionResult.fromNetworkError(err))
            .then(outcome => {
                oDetailModel.setProperty("/busy", false);
                if (!ActionResult.isOk(outcome)) {
                    this._reportSyncPlexFailure(outcome, Date.now() - iStartedAt);
                    // [PLEX-CALL] Le chiamate verso Plex possono essere partite lo stesso: sono
                    // quelle da leggere, ed e' l'unico posto in cui si vedono.
                    IsCallLog.dump("sincronizzazione ciclo " + this._sRoutingGroup + "/" + this._sRouting);
                    return;
                }
                const result = outcome.body;
                this._loadRoutingSyncLogs();
                if (result.success) {
                    const sDone = oResourceBundle.getText("syncPlexSuccess", [result.deactivatedCount, result.createdCount]);
                    // [BOM-AUTODEPLETE] W1-06: il ciclo È arrivato su Plex, ma se «autoDeplete» non
                    // è verificato su qualche riga di distinta il riquadro verde direbbe il falso
                    // senza dirlo — e la cosa non si vede da nessun'altra parte in questa schermata,
                    // perché il messaggio dell'action qui non veniva mostrato affatto.
                    const iAdUnverified = Number(result.AutodepleteUnverified) || 0;
                    // [WC-SUBTRACT] Stessa ragione, e qui è ancora più stretta: chi ha appena TOLTO
                    // un work center dall'albero e vede il riquadro verde crede che su Plex sia stato
                    // tolto. Se non è stato rimosso va detto qui, perché `needsSend()` non ripescherà
                    // più questo ciclo e nessun altro glielo dirà.
                    const iWcExcess = Number(result.WcExcessNotRemoved) || 0;
                    const aWarn = [];
                    if (iAdUnverified > 0) {
                        aWarn.push(oResourceBundle.getText("syncPlexAutodepleteUnverified", [iAdUnverified]));
                    }
                    if (iWcExcess > 0) {
                        aWarn.push(oResourceBundle.getText("syncPlexWcExcessNotRemoved", [iWcExcess]));
                    }
                    if (aWarn.length) {
                        // Si raccolgono invece di incatenarsi in else-if: con la catena il primo che
                        // parlava zittiva l'altro, ed è lo stesso difetto già corretto nel recap del
                        // job (W1-05).
                        MessageBox.warning(sDone + "\n\n" + aWarn.join("\n\n"));
                    } else {
                        MessageBox.success(sDone);
                    }
                } else {
                    MessageBox.error(result.message || result.error?.message || oResourceBundle.getText("syncPlexFailed"));
                }
                // [IS-CALL-LOG] la sincronizzazione rilegge il ciclo da SAP prima di scrivere su
                // Plex: in console le letture come sono state fatte. Da rimuovere a migrazione conclusa.
                IsCallLog.dump("sincronizzazione ciclo " + this._sRoutingGroup + "/" + this._sRouting);
            })
            .catch(err => {
                // Ci arriva solo un'eccezione DENTRO il ramo riuscito: le specie di esito sono
                // gia' state trattate qui sopra e non lanciano.
                oDetailModel.setProperty("/busy", false);
                console.error(">>> Error syncing Plex cycle:", err);
                MessageBox.error(oResourceBundle.getText("syncPlexFailed"));
            });
        },

        /**
         * [ACTION-RESULT] L'invio del ciclo non e' riuscito — o non si sa se lo sia.
         *
         * IL PUNTO NON E' IL TESTO, E' LA DIFFERENZA FRA DUE FRASI. Un rifiuto del server e un
         * taglio del gateway si assomigliano solo da qui: nel primo caso su Plex non e' successo
         * niente, nel secondo la creazione puo' essere andata a termine — ed e' successo davvero,
         * il 14/09/2026, con l'utente che leggeva un errore su un ciclo creato per intero.
         * Chiamarlo «fallito» manda a ripetere un invio che ha gia' scritto.
         *
         * Per questo il taglio esce come AVVISO e non come errore, e lo storico si rilegge alla
         * CHIUSURA del dialogo: riletto subito rende zero righe — il server sta ancora lavorando —
         * e zero righe qui si leggono come «mai inviato». E' il divieto [DETAIL-RESET].
         */
        _reportSyncPlexFailure(oOutcome, iElapsedMs) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            console.error(">>> [ACTION-RESULT] invio ciclo a Plex non riuscito:",
                oOutcome.kind, "HTTP", oOutcome.status, oOutcome.message || "", `${iElapsedMs} ms`);

            const oFail = ActionFailure.text(oOutcome, iElapsedMs, oResourceBundle, {
                generic: "syncPlexFailed",
                interrupted: "syncPlexInterrupted"
            });
            // La sessione scaduta la annuncia SessionGuard, con il dialogo che sa anche cosa fare
            // delle modifiche aperte: qui si tace di proposito.
            if (oFail.silent) { return; }

            if (ActionFailure.isInconclusive(oOutcome)) {
                MessageBox.warning(oFail.text, {
                    onClose: () => this._loadRoutingSyncLogs()
                });
                return;
            }
            this._loadRoutingSyncLogs();
            MessageBox.error(oFail.text);
        },

        // ----------------------------------------------------------------
        // Sync Log History
        // ----------------------------------------------------------------

        /**
         * [ACTION-RESULT] Rilegge lo storico su richiesta.
         *
         * Serve dopo un invio interrotto dal gateway: alla chiusura dell'avviso la riga puo' non
         * esserci ancora — il server sta finendo di scriverla — e senza questo pulsante l'unico
         * modo di riguardare sarebbe uscire dalla scheda e rientrare. E' l'alternativa onesta al
         * polling: chi sa di aver appena inviato decide quando riprovare a leggere, e nessuno
         * promette un tempo del server che non conosciamo.
         */
        onRefreshRoutingSyncLogs() {
            this._loadRoutingSyncLogs();
        },

        _loadRoutingSyncLogs(iPage) {
            const oLogModel = this.getView().getModel("routingLogModel");
            // [LOAD-GEN] La generazione al momento della partenza. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            // [LOG-PAGE] Senza pagina (cambio ciclo, refresh, chiusura di un dialogo) si legge la
            // 1 — le righe piu' recenti — e la barra si azzera PRIMA della lettura.
            const oPager = LogPager.modelOf(this.getView());
            const iWanted = LogPager.begin(oPager, iPage);
            oLogModel.setProperty("/busy", true);

            // [ROUTING-BY-MATERIAL] La cronologia degli invii e' per materiale: mescolarla con
            // quella di un altro materiale dello stesso ciclo mostrerebbe esiti che non riguardano
            // la part che si sta guardando.
            //
            // [DETAIL-RESET] Il literal si costruisce con `MatLogFilter.odataLiteral`, non con
            // `'${encodeURIComponent(v)}'`: `encodeURIComponent` NON tocca l'apice, e in OData
            // l'apice si RADDOPPIA. Con un materiale che ne contiene uno il `$filter` era
            // malformato, il server rispondeva 400 e la lista restava quella del ciclo precedente.
            // E' la stessa correzione gia' fatta sul materiale nella 0039.
            const sFilter = "ProductionRoutingGroup eq " + MatLogFilter.odataLiteral(this._sRoutingGroup)
                + " and ProductionRouting eq " + MatLogFilter.odataLiteral(this._sRouting)
                + " and Material eq " + MatLogFilter.odataLiteral(this._sMaterial);
            // [LOG-TRACE] Le colonne si CHIEDONO: senza `$select` ogni riga porta anche
            // `RequestJson` e `ResponseJson`, i due `LargeString` con la traccia intera, che
            // questa tabella non mostra mai. `MessageJson` e' OBBLIGATORIO qui dentro — senza, il
            // server lascia lo snapshot italiano invece di rendere il messaggio nella lingua di
            // chi guarda (`localizeLogRows`, DEC-92).
            const sUrl = AppUrl.url("/odata/v4/log/ZRoutingExcLogPOS?$filter=") + encodeURIComponent(sFilter)
                + "&$select=" + LogTrace.listSelect([
                    "ProductionRoutingGroup", "ProductionRouting", "Material", "Counter",
                    "SentDate", "SentTime", "Status", "Message", "MessageJson", "ResponseStatus"
                ])
                + "&$orderby=Counter desc"
                // [LOG-PAGE] Una lettura per pagina: `$count=true&$top=100&$skip=N`.
                + LogPager.pageQuery(iWanted);

            // [LOG-MSG-I18N] `logHeaders` dichiara la lingua dell'applicazione. Senza, CAP ricade
            // sull'`Accept-Language` del browser: di solito e' la stessa, che e' proprio la ragione
            // per cui va dichiarata — il difetto si vedrebbe solo dall'utente che ha browser e
            // applicazione in due lingue diverse.
            fetch(sUrl, { headers: LogLanguage.logHeaders() })
                .then(r => {
                    // [DETAIL-RESET] Un rifiuto del server e' un ERRORE, non una lista vuota: senza
                    // questo controllo `r.json()` legge il corpo d'errore, `data.value` e'
                    // `undefined` e la tabella si popola con `[]` — «mai inviato» al posto di «non
                    // ho potuto leggere».
                    if (!r.ok) { throw new Error(`HTTP ${r.status}`); }
                    return r.json();
                })
                .then(data => {
                    // [LOAD-GEN] Risposta di un altro ciclo: si scarta.
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    const aLogs = (data.value || []).map(log => ({
                        ...log,
                        SentDate: log.SentDate || ""
                    }));
                    oLogModel.setProperty("/logs", aLogs);
                    oLogModel.setProperty("/busy", false);
                    LogPager.applyResponse(oPager, iWanted, data, "storico ciclo");
                    console.log(`>>> [LOG-PAGE] Routing sync logs: pagina ${oPager.getProperty("/page")}`
                        + ` di ${oPager.getProperty("/pageCount")}, ${aLogs.length} righe su ${oPager.getProperty("/total")}`);
                })
                .catch(err => {
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    // [DETAIL-RESET] Una lettura fallita SVUOTA: prima il `.catch` era muto, e le
                    // righe del ciclo precedente restavano a schermo per sempre.
                    console.error(">>> Error loading routing sync logs:", err);
                    oLogModel.setProperty("/logs", []);
                    LogPager.reset(oPager);
                    oLogModel.setProperty("/busy", false);
                });
        },

        /** [LOG-PAGE] Un evento della barra delle pagine: si ricava la pagina e si rilegge. */
        onLogPager(oEvent) {
            const iPage = LogPager.targetOf(oEvent, LogPager.modelOf(this.getView()));
            if (iPage) { this._loadRoutingSyncLogs(iPage); }
        },

        onRoutingLogRowSelect(oEvent) {
            const oItem = oEvent.getParameter("listItem");
            if (!oItem) return;

            const oCtx = oItem.getBindingContext("routingLogModel");
            if (!oCtx) return;

            const oLog = oCtx.getObject();
            const oModel = this.getView().getModel("routingJsonDetailModel");

            // [LOG-TRACE] La traccia non e' piu' nella riga: si chiede per questa riga sola.
            // [LOAD-GEN] Generazione PROPRIA del pannello: due clic rapidi sono due letture, e a
            // schermo deve restare la seconda.
            this._mLoadGen = this._mLoadGen || {};
            const iGen = LoadGen.next(this._mLoadGen, "trace");
            oModel.setData({
                visible: true,
                busy: true,
                error: "",
                Counter: oLog.Counter,
                SentDate: oLog.SentDate || "",
                SentTime: oLog.SentTime || "",
                RequestJsonFormatted: "",
                ResponseJsonFormatted: "",
                ResponseStatus: oLog.ResponseStatus || null,
                ResponseStatusText: oLog.ResponseStatus ? ("HTTP " + oLog.ResponseStatus) : ""
            });

            const sUrl = LogTrace.traceUrl("ZRoutingExcLogPOS", {
                ProductionRoutingGroup: oLog.ProductionRoutingGroup,
                ProductionRouting: oLog.ProductionRouting,
                Material: oLog.Material,
                Counter: oLog.Counter
            });
            LogTrace.fetchTrace(sUrl).then(oTrace => {
                if (!LoadGen.isCurrent(this._mLoadGen, "trace", iGen)) { return; }
                if (!oTrace.ok) {
                    // [DETAIL-RESET] Vuoto non e' ignoto: due riquadri vuoti direbbero «non e'
                    // stato mandato niente», che e' l'affermazione opposta a quella vera.
                    console.error(`>>> [LOG-TRACE] traccia non letta per ${oLog.ProductionRoutingGroup}/${oLog.ProductionRouting}/${oLog.Material}/${oLog.Counter}: ${oTrace.error}`);
                    oModel.setProperty("/busy", false);
                    oModel.setProperty("/error", this._i18n().getText("logTraceReadFailed"));
                    return;
                }
                const oOut = LogTrace.formatTrace(oTrace);
                oModel.setProperty("/busy", false);
                oModel.setProperty("/error", "");
                Object.keys(oOut).forEach(sKey => oModel.setProperty("/" + sKey, oOut[sKey]));
            });
        },

        onCloseRoutingJsonDetail() {
            this.getView().getModel("routingJsonDetailModel").setProperty("/visible", false);
        },

        // ----------------------------------------------------------------
        // Status Formatters
        // ----------------------------------------------------------------

        // [I18N-EARLY] Il bundle per i FORMATTER, che girano mentre la vista si costruisce e
        // quindi prima che i modelli del componente le siano propagati. La catena completa — e
        // perche' il sintomo (`duplicate id`) non nomina la causa — sta in testa a
        // `_getSplitBundle()` in ProdOrderSplit.mixin.js. Rete: node test/i18nEarly.test.js
        _i18n() {
            const oModel = this.getView().getModel("i18n") || this.getOwnerComponent().getModel("i18n");
            return oModel.getResourceBundle();
        },

        formatStatusText(sStatus) {
            const oResourceBundle = this._i18n();
            if (sStatus === "S") return oResourceBundle.getText("statusSuccess");
            if (sStatus === "E") return oResourceBundle.getText("statusError");
            if (sStatus === "W") return oResourceBundle.getText("statusWarning");
            return sStatus || "";
        },

        formatStatusState(sStatus) {
            if (sStatus === "S") return "Success";
            if (sStatus === "E") return "Error";
            if (sStatus === "W") return "Warning";
            return "None";
        },

        formatStatusIcon(sStatus) {
            if (sStatus === "S") return "sap-icon://sys-enter-2";
            if (sStatus === "E") return "sap-icon://error";
            if (sStatus === "W") return "sap-icon://alert";
            return "";
        },

        formatHttpStatusState(iStatus) {
            if (!iStatus) return "None";
            if (iStatus >= 200 && iStatus < 300) return "Success";
            if (iStatus >= 400) return "Error";
            return "Warning";
        },

        formatHttpStatusIcon(iStatus) {
            if (!iStatus) return "";
            if (iStatus >= 200 && iStatus < 300) return "sap-icon://sys-enter-2";
            if (iStatus >= 400) return "sap-icon://error";
            return "sap-icon://alert";
        },

        // ----------------------------------------------------------------
        // Helpers
        // ----------------------------------------------------------------

        _recalculateSequences() {
            this._aPlexOperations.forEach((op, i) => {
                op.OperationNumber = (i + 1) * 10;
            });
        },

        _selectPlexTreeItem(iOperationIndex) {
            const oTree = this.byId("plexCycleTree");
            if (!oTree) return;

            const aItems = oTree.getItems();
            // Find the item by checking binding context for the operation index
            for (let i = 0; i < aItems.length; i++) {
                const oCtx = aItems[i].getBindingContext("plexCycleModel");
                if (oCtx && oCtx.getProperty("nodeType") === "plexOperation" && oCtx.getProperty("_index") === iOperationIndex) {
                    oTree.setSelectedItem(aItems[i]);
                    this._updatePlexCycleButtonStates(iOperationIndex, "plexOperation");
                    return;
                }
            }
        },

        // ================================================================
        // NAVIGATION & FORMATTERS
        // ================================================================

        onBack() {
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.navTo("dashboardNavigation");
        },

        formatTitle(sPattern, sGroup, sDesc) {
            if (sPattern && sGroup) {
                return sPattern.replace("{0}", sGroup).replace("{1}", sDesc || "");
            }
            return sPattern || "";
        }
    });
});

sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/m/BusyDialog",
    "sap/ui/core/Fragment",
    "./ProdOrderSplit.mixin",
    // [IS-CALL-LOG] traccia delle chiamate verso SAP in console. Da rimuovere a migrazione conclusa.
    "avvaleplm/marsplm/sap2plex/main/util/IsCallLog",
    // [PLEX-OP-TYPE-FILTER] Vedi il commento gemello in RoutingDetail: le regole del catalogo
    // operazioni stanno in un punto solo.
    "avvaleplm/marsplm/sap2plex/main/util/PlexOpsCatalog",
    // [LOG-MSG-I18N] La lingua con cui si chiede lo storico invii: dalla 0029 il testo della
    // colonna «Messaggio» lo rende il server, quindi la richiesta la lingua deve dirla.
    "avvaleplm/marsplm/sap2plex/main/util/LogLanguage",
    // [SESSION-401] L'albero del ciclo Plex vive in un JSONModel di VISTA, che la guardia non puo'
    // scoprire dal manifest: glielo si dichiara.
    "avvaleplm/marsplm/sap2plex/main/util/SessionGuard",
    // [COMP-SOURCE] «Questa riga l'ha messa una persona?» ha una definizione sola, gemella di
    // srv/lib/compSourceRules.js: da quel valore dipendono l'icona E l'operazione su cui il
    // componente finisce su Plex (feature 0036).
    "avvaleplm/marsplm/sap2plex/main/util/CompSource",
    // [ROUTE-KEY] La rotta e' l'oggetto: la riga messa da parte dalla lista si usa solo se
    // corrisponde. Modulo puro: node test/routeStash.test.js
    "avvaleplm/marsplm/sap2plex/main/util/RouteStash",
    // [LOAD-GEN] Una risposta partita per l'ordine precedente non scrive sui modelli di questo.
    // Modulo puro: node test/loadGen.test.js
    "avvaleplm/marsplm/sap2plex/main/util/LoadGen",
    // [ROUTE-KEY] L'escaping OData: in un key predicate l'apice si RADDOPPIA, e
    // `encodeURIComponent` non lo tocca. Gia' usato dal dettaglio materiale.
    "avvaleplm/marsplm/sap2plex/main/util/MatLogFilter",
    // [DETAIL-REREAD] La testata si chiede per CHIAVE e, se il server non consegna quella riga, si
    // rilegge una volta e si SCEGLIE per chiave. Test: node test/detailRead.test.js
    "avvaleplm/marsplm/sap2plex/main/util/DetailRead",
    // [AUTO-ASSIGN] Stesso dettaglio del dettaglio ciclo, dallo stesso util: le due copie di
    // `_applyAutoAssignments` devono dire le stesse cose con le stesse parole.
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
], (Controller, JSONModel, MessageToast, MessageBox, BusyDialog, Fragment, ProdOrderSplitMixin, IsCallLog, PlexOpsCatalog, LogLanguage, SessionGuard, CompSource, RouteStash, LoadGen, MatLogFilter, DetailRead, AutoAssignReport, ActionResult, ActionFailure, TreeState, AppUrl, LogTrace, LogPager) => {
    "use strict";

    // Feature 0012 — the split handlers, formatters and model live in the mixin (TDD 0012 §4.4).
    // The mixin comes first so that any method of this controller always wins.
    return Controller.extend("avvaleplm.marsplm.sap2plex.main.controller.ProdOrderDetail", Object.assign({}, ProdOrderSplitMixin, {

        onInit() {
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("prodOrderDetail").attachPatternMatched(this._onPatternMatched, this);

            // [SESSION-401] Vale qui piu' che sul ciclo: su un ordine l'albero porta anche le
            // rimozioni manuali dei componenti (DEC-87), che prima dell'invio esistono solo qui.
            SessionGuard.registerDirtyCheck("ProdOrderDetail", () => {
                const oModel = this.getView().getModel("plexCycleModel");
                return !!(oModel && oModel.getProperty("/dirty"));
            });

            // Initialize local model for production order header data
            const oDetailModel = new JSONModel(this._emptyDetail());
            this.getView().setModel(oDetailModel, "detailModel");

            // Initialize tree model for SAP operations & components hierarchy
            const oTreeModel = new JSONModel({
                nodes: [],
                // [DETAIL-RESET] Un velo per AREA, non uno di pagina: la testata arriva subito
                // dalla riga cliccata, i due alberi, lo storico e i pacchetti no.
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
                selectedCompIndex: -1,
                // [ORDER-COMP-REMOVE] Stato della rimozione manuale (feature 0026).
                //   alreadySent   -> l'ordine è già uscito verso Plex: «Rimuovi» resta spento sui
                //                    componenti, perché le loro righe di distinta appartengono a un
                //                    lotto in produzione;
                //   removedCount  -> quante rimozioni sono in vigore, per la striscia sopra l'albero.
                alreadySent: false,
                removedCount: 0,
                removedText: ""
            });
            this.getView().setModel(oPlexCycleModel, "plexCycleModel");

            // Internal flat array for Plex operations (source of truth)
            this._aPlexOperations = [];

            // [TREE-STATE] I nodi che l'utente ha CHIUSO, per identita' e non per posizione: un
            // nodo che non e' qui dentro e' aperto, quindi un'operazione nuova nasce aperta.
            this._oCollapsedSap = new Set();
            this._oCollapsedPlex = new Set();

            // [ORDER-COMP-REMOVE] I materiali che una persona ha rimosso dall'albero dell'ordine.
            // Fonte di verità come `_aPlexOperations`: il modello ne porta solo il conteggio, e il
            // payload di `savePlexCycle` si costruisce da qui.
            this._aRemovedMaterials = [];

            // [ORDER-CYCLE-IMPORT] Striscia sopra l'albero Plex: dice l'esito dell'import del
            // ciclo del materiale, compreso il caso in cui non ha importato niente — che prima
            // finiva in un console.log e a schermo restava un albero vuoto senza motivo.
            this.getView().setModel(
                new JSONModel({ visible: false, type: "Information", text: "" }),
                "importInfoModel"
            );

            // Send-log models (Sync History tab)
            this.getView().setModel(new JSONModel({ logs: [], busy: false }), "prodOrderLogModel");
            // [LOG-PAGE] La barra delle pagine, e il tetto del modello allineato alla pagina.
            LogPager.attach(this.getView(), this.getView().getModel("prodOrderLogModel"));
            // [LOG-TRACE] `busy` e `error` nascono qui: la traccia si legge al clic, quindi il
            // pannello ha un tempo di attesa e un modo di fallire che prima non aveva.
            this.getView().setModel(new JSONModel({ visible: false, busy: false, error: "" }), "prodOrderJsonDetailModel");


            // Feature 0012: split model ("splitModel"), see ProdOrderSplit.mixin.js
            this._initSplitFeature();
        },

        /**
         * [ROUTE-KEY] La forma VUOTA del modello, in un punto solo.
         *
         * Serve al rifiuto dello stash: senza azzerare, resterebbe la testata dell'ordine
         * precedente sotto la rotta del nuovo — e con lei l'AUFPL e la prenotazione, che sono i
         * FILTRI delle letture di operazioni e componenti. L'albero mostrerebbe i figli di un
         * altro ordine.
         */
        _emptyDetail() {
            return {
                ManufacturingOrder: null,
                // [IS-FULL-KEY] Campi tecnici, non mostrati: l'AUFPL e la prenotazione (che l'iFlow
                // veicola in MasterProductionOrder). Arrivano con la riga della dashboard (o dalla
                // rilettura dopo F5) e vengono passati come chiavi nelle letture di operazioni e
                // componenti, vedi _loadTreeData.
                OrderInternalBillOfOperations: null,
                MasterProductionOrder: null,
                ManufacturingOrderType: null,
                Material: null,
                ProductionPlant: null,
                TotalQuantity: null,
                ProductionUnit: null,
                MfgOrderPlannedStartDate: null,
                MfgOrderPlannedEndDate: null,
                MfgOrderCreationDate: null,
                MfgOrderConfirmedYieldQty: null,
                ProductionSupervisor: null,
                ProductionVersion: null,
                SalesOrder: null,
                SalesOrderItem: null,
                OrderIsReleased: null,
                OrderIsConfirmed: null,
                OrderIsClosed: null,
                OrderIsDeleted: null,
                OrderLongText: null,
                busy: false
            };
        },

        /**
         * [DETAIL-RESET] Tutto cio' che appartiene all'ordine se ne va con lui (feature 0043).
         *
         * PERCHE'. Il router tiene UNA sola istanza di questa vista e la riusa per ogni ordine
         * (target `type: "View"`, nessun `clearControlAggregation`): `onInit` gira una volta sola
         * nella vita dell'applicazione, quindi i modelli entrano nell'ordine nuovo pieni di quello
         * precedente e ci restano finche' non arrivano le risposte — qui sono da quattro a otto
         * letture, in parte in CATENA.
         *
         * E il residuo non e' cosmetico. `alreadySent` e `removedCount` governano i pulsanti
         * «Rimuovi», `_oSapCompKeys` decide quali componenti dell'albero Plex sono marcati orfani, e
         * `splitModel` apre la finestra di spacchettamento: nella finestra transitoria erano tutti
         * quelli dell'ordine PRECEDENTE.
         *
         * Va chiamata per PRIMA in `_onPatternMatched` e SENZA CONDIZIONI: l'azzeramento della 0041
         * sta sul ramo di rifiuto dello stash, cioe' proprio il ramo che nel percorso normale —
         * click in lista — non passa mai.
         */
        _resetForNewObject() {
            this._mLoadGen = this._mLoadGen || {};
            this._iLoadGen = LoadGen.next(this._mLoadGen, "detail");

            this.getView().getModel("detailModel").setData(this._emptyDetail());

            const oTreeModel = this.getView().getModel("treeModel");
            oTreeModel.setProperty("/nodes", []);
            oTreeModel.setProperty("/busy", true);

            const oPlexCycleModel = this.getView().getModel("plexCycleModel");
            oPlexCycleModel.setData({
                nodes: [], busy: true, dirty: false, removeEnabled: false,
                moveUpEnabled: false, moveDownEnabled: false,
                selectedIndex: -1, selectedCompIndex: -1,
                alreadySent: false, removedCount: 0, removedText: ""
            });

            const oLogModel = this.getView().getModel("prodOrderLogModel");
            oLogModel.setProperty("/logs", []);
            oLogModel.setProperty("/busy", true);
            // [LOG-TRACE] Il pannello della traccia si svuota, e la sua generazione avanza: una
            // lettura partita per una riga dell'ordine precedente non deve scriverci sopra.
            LoadGen.next(this._mLoadGen, "trace");
            this.getView().getModel("prodOrderJsonDetailModel").setData({
                visible: false, busy: false, error: "",
                RequestJsonFormatted: "", ResponseJsonFormatted: "",
                ResponseStatus: null, ResponseStatusText: ""
            });

            // [ORDER-CYCLE-IMPORT] La striscia e' dell'ordine che si sta aprendo: l'esito
            // dell'import precedente non deve sopravvivere alla navigazione.
            this._setImportInfo(null, "");

            // Feature 0012: i pacchetti sono di QUESTO ordine.
            this._resetSplitFeature();

            // Le fonti di verita' interne: gli alberi e il payload di salvataggio si costruiscono
            // da queste, quindi lasciarle piene rimetterebbe a schermo l'ordine precedente.
            this._aPlexOperations = [];
            this._aRemovedMaterials = [];
            this._oSapCompKeys = null;

            // [TREE-STATE] I nodi chiusi sono di QUESTO ordine: `PlexOperationId` e' un id del
            // catalogo del tenant, quindi la stessa chiave puo' ricomparire sull'ordine dopo e un
            // residuo chiuderebbe un nodo che nessuno ha chiuso.
            this._oCollapsedSap.clear();
            this._oCollapsedPlex.clear();

            // La scheda torna la prima: restando su «Storico invii» si guarderebbero le righe di un
            // altro ordine senza nessun segno che lo dica.
            const oTabs = this.byId("prodOrderDetailTabs");
            if (oTabs) { oTabs.setSelectedKey("cycle"); }
            const oLogTable = this.byId("prodOrderLogTable");
            if (oLogTable) { oLogTable.removeSelections(true); }
        },

        _onPatternMatched(oEvent) {
            const oArgs = oEvent.getParameter("arguments");
            const sManufacturingOrder = oArgs.ManufacturingOrder;
            this._sManufacturingOrder = sManufacturingOrder;
            // [ROUTE-KEY] Le chiavi di rotta accanto a `oArgs`: un parametro aggiunto domani alla
            // rotta entra qui, o il test del perimetro lo dichiara.
            this._oRouteKeys = { ManufacturingOrder: sManufacturingOrder };

            // [DETAIL-RESET] Prima di qualunque lettura: la schermata si svuota, poi si riempie.
            this._resetForNewObject();

            // Load order data first, then SAP tree, then Plex cycle (sequential for auto-import)
            this._loadOrderData(sManufacturingOrder).then(() => {
                this._loadTreeData(sManufacturingOrder).then(() => {
                    this._loadPlexCycleData(sManufacturingOrder);
                    // [IS-CALL-LOG] come sono state fatte le letture verso SAP (testata, operazioni,
                    // componenti), in console. Da rimuovere a migrazione conclusa.
                    IsCallLog.dump("dettaglio ordine di produzione " + sManufacturingOrder);
                });
            });

            // Send-log history (Sync History tab)
            this._loadProdOrderLogs();

            // Split status: entry point, permanent strips and Packages tab (feature 0012)
            this._loadSplitInfo();

        },

        // ================================================================
        // ORDER DATA LOADING
        // ================================================================

        _loadOrderData(sManufacturingOrder) {
            const oDetailModel = this.getView().getModel("detailModel");
            const oStash = this.getOwnerComponent()._selectedProdOrder;
            // [LOAD-GEN] La generazione al momento della partenza: al ritorno dice se nel frattempo
            // si e' navigato su un altro ordine. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;

            // ================================================================
            // [ROUTE-KEY] La riga messa da parte dalla lista si usa SOLO se e' questo ordine.
            // Sul ramo accettato la chiave viene dalla rotta; sul ramo rifiutato il modello si
            // AZZERA prima di rileggere, perche' qui il modello stantio non e' solo cosmetico:
            // porta l'AUFPL e la prenotazione di un ALTRO ordine, che sono i filtri dell'albero.
            // ================================================================
            const oCheck = RouteStash.check(oStash, this._oRouteKeys);
            if (oCheck.usable) {
                oDetailModel.setData({ ...oStash, ...this._oRouteKeys, busy: false });
                return Promise.resolve();
            }
            if (oCheck.reason !== RouteStash.REASON.NO_STASH) {
                console.warn(RouteStash.describe("dettaglio ordine", oCheck));
            }
            oDetailModel.setData(this._emptyDetail());

            // Fallback: fetch from OData when component data is not available (e.g., after F5 refresh)
            console.log(">>> Fetching production order data from OData (after F5 refresh)");
            oDetailModel.setProperty("/busy", true);

            // ================================================================
            // [ROUTE-KEY] In un key predicate OData l'apice si RADDOPPIA; `encodeURIComponent` non
            // lo tocca. Su un numero d'ordine e' innocuo, ma questo ramo era quasi teorico e ora e'
            // la strada normale del rifiuto: la forma giusta si usa qui come sul materiale.
            //
            // [DETAIL-REREAD] La rilettura e' un `$filter` sul numero d'ordine, che l'handler
            // SPINGE verso la sorgente su entrambi i canali (`ManufacturingOrder` e' l'unica chiave
            // ed e' fra i campi spingibili): e' la forma affidabile qui. Serve soprattutto per il
            // `404`, che la rete [KEY-READ] lato server produce su una riga che ESISTE quando
            // l'handler non ha applicato il criterio di chiave.
            // ================================================================
            const sOrderLit = MatLogFilter.odataLiteral(sManufacturingOrder);
            const sKeyUrl = AppUrl.url("/production-orders/ProductionOrders(ManufacturingOrder=")
                + sOrderLit + ")";
            const sRereadUrl = AppUrl.url("/production-orders/ProductionOrders?$filter=")
                + encodeURIComponent(`ManufacturingOrder eq ${sOrderLit}`);

            return DetailRead.one({
                keyUrl: sKeyUrl,
                routeKeys: this._oRouteKeys,
                label: `dettaglio ordine ${sManufacturingOrder}`,
                recover: () => DetailRead.rows(sRereadUrl)
            })
            .then(oRead => {
                // [LOAD-GEN] Risposta di un altro ordine: si scarta senza scrivere.
                if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                const oBundle = this.getView().getModel("i18n").getResourceBundle();
                if (!oRead.row) {
                    // [ROUTE-KEY] Il modello resta VUOTO, quindi l'albero si legge senza le chiavi
                    // interne (AUFPL e prenotazione) e il server se le risolve da se' (DEC-42):
                    // l'albero esce piu' lento ma GIUSTO. Prima, con il modello stantio, usciva
                    // veloce e sbagliato. Si dichiara, o un albero lento non avrebbe una ragione
                    // visibile.
                    console.warn("[ROUTE-KEY] testata non letta: l'albero si legge senza le chiavi"
                        + " interne, il server le risolve da se' (DEC-42)");
                    // [DETAIL-REREAD] «Non c'e'» e «non ho potuto leggere» sono DUE messaggi.
                    MessageToast.show(oRead.why === DetailRead.WHY.READ_FAILED
                        ? oBundle.getText("detailReadFailed", [oRead.note])
                        : oBundle.getText("prodOrderNotFound", [sManufacturingOrder]));
                    oDetailModel.setData(this._emptyDetail());
                    return;
                }
                console.log(">>> Production order data loaded from OData:", oRead.row);
                // [ROUTE-KEY] Le chiavi del modello sono quelle della ROTTA.
                oDetailModel.setData({ ...oRead.row, ...this._oRouteKeys, busy: false });
            });
        },

        // ================================================================
        // SAP TREE (LEFT) - Operations & Components
        // ================================================================

        _loadTreeData(sManufacturingOrder) {
            const oTreeModel = this.getView().getModel("treeModel");
            const oDetailModel = this.getView().getModel("detailModel");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            // [LOAD-GEN] La generazione al momento della partenza. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            oTreeModel.setProperty("/busy", true);

            // [IS-FULL-KEY] Le due chiavi interne della testata (già letta: _loadOrderData gira
            // prima, vedi _onPatternMatched) viaggiano nei filtri dei figli: l'AUFPL per le
            // operazioni e la prenotazione — veicolata in MasterProductionOrder — per i componenti.
            // Il backend le usa come chiave della lettura verso SAP ed evita così di ri-leggere la
            // testata (DEC-42); se mancano, se le risolve da sé.
            const sAufpl = oDetailModel.getProperty("/OrderInternalBillOfOperations") || "";
            const sAufplFilter = sAufpl
                ? ` and OrderInternalBillOfOperations eq '${encodeURIComponent(sAufpl)}'`
                : "";
            const sReservation = oDetailModel.getProperty("/MasterProductionOrder") || "";
            const sReservationFilter = sReservation
                ? ` and Reservation eq '${encodeURIComponent(sReservation)}'`
                : "";

            // Fetch operations and components in parallel
            const sOpsUrl = AppUrl.url(`/production-orders/ProductionOrderOperations?$filter=ManufacturingOrder eq '${encodeURIComponent(sManufacturingOrder)}'${sAufplFilter}&$orderby=ManufacturingOrderOperation asc`);
            const sCompUrl = AppUrl.url(`/production-orders/ProductionOrderComponents?$filter=ManufacturingOrder eq '${encodeURIComponent(sManufacturingOrder)}'${sReservationFilter}&$orderby=ManufacturingOrderOperation asc`);

            return Promise.all([
                fetch(sOpsUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sCompUrl, { headers: { "Accept": "application/json" } }).then(r => r.json())
            ])
            .then(([opsData, compData]) => {
                // [LOAD-GEN] Risposta di un altro ordine: si scarta. Il controllo sta PRIMA di
                // `_oSapCompKeys`, che decide i marcatori orfano sull'albero Plex.
                if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                const aOperations = opsData.value || [];
                const aComponents = compData.value || [];

                console.log(`>>> Tree data: ${aOperations.length} operations, ${aComponents.length} components`);

                // ================================================================
                // [COMP-ORPHAN] I materiali che l'ORDINE ha, per marcare gli orfani nell'albero Plex
                // (feature 0037). Il confronto costa zero chiamate: i due alberi sono entrambi qui.
                //
                // Si TOLGONO i componenti rimossi a mano, ed e' la riga che allinea questo insieme a
                // quello che il server usa per potare (`order.components`, dove le rimozioni sono
                // l'ultimo strato). Senza, una riga rimossa a mano che fosse rimasta nell'albero non
                // verrebbe marcata e verrebbe potata: il marcatore direbbe una cosa e il server ne
                // farebbe un'altra.
                //
                // Insieme VUOTO — lettura non riuscita, o ordine senza componenti — significa
                // «niente da dichiarare»: i due guardiani stanno in `CompSource`, e nel dubbio si
                // tace, perche' un marcatore sbagliato e' peggio di un marcatore assente.
                // ================================================================
                this._oSapCompKeys = new Set(
                    aComponents
                        .filter(c => !this._isComponentRemoved(c.Material))
                        .map(c => CompSource.matKey(c.Material))
                        .filter(Boolean)
                );

                // Group components by ManufacturingOrderOperation
                const mComponentsByOp = {};
                aComponents.forEach(comp => {
                    const sOp = comp.ManufacturingOrderOperation;
                    if (!mComponentsByOp[sOp]) {
                        mComponentsByOp[sOp] = [];
                    }
                    mComponentsByOp[sOp].push(comp);
                });

                // Build tree: Order -> Operations -> Components
                const oOrderData = oDetailModel.getData();

                const aOperationNodes = aOperations.map(op => {
                    const sOpCode = op.ManufacturingOrderOperation;
                    const sOpText = oResourceBundle.getText("operationNode", [sOpCode, op.MfgOrderOperationText || ""]);
                    const sOpDesc = oResourceBundle.getText("workCenter") + ": " + (op.WorkCenter || "-");

                    const aOpComponents = mComponentsByOp[sOpCode] || [];
                    const aComponentNodes = aOpComponents.map(comp => {
                        const sCompText = comp.Material || "";
                        const sReq = oResourceBundle.getText("requiredQty", [
                            comp.RequiredQuantity != null ? Number(comp.RequiredQuantity).toFixed(3) : "0",
                            comp.BaseUnit || ""
                        ]);
                        const sWdr = oResourceBundle.getText("withdrawnQty", [
                            comp.WithdrawnQuantity != null ? Number(comp.WithdrawnQuantity).toFixed(3) : "0",
                            comp.BaseUnit || ""
                        ]);

                        // [PHANTOM-EXPLODE] Un componente nato da un'esplosione DEVE dichiararlo:
                        // altrimenti e' indistinguibile da uno letto da SAP, e nessuno saprebbe
                        // perche' un materiale che nell'ordine non c'e' compare nell'albero.
                        const sPhantom = comp.PhantomSource
                            ? " | " + oResourceBundle.getText("phantomFrom", [comp.PhantomSource])
                            : "";
                        // [ORDER-COMP-REMOVE] Un componente rimosso a mano resta in QUESTO albero,
                        // che è la verità di SAP ed è l'unico posto da cui trascinarlo per rimetterlo
                        // in gioco: nasconderlo renderebbe la rimozione irreversibile. Si marca.
                        const bRemoved = this._isComponentRemoved(comp.Material);
                        const sRemoved = bRemoved
                            ? " | " + oResourceBundle.getText("orderCompRemovedExcluded")
                            : "";
                        return {
                            text: sCompText,
                            description: sReq + " | " + sWdr + sPhantom + sRemoved,
                            icon: "sap-icon://product",
                            iconColor: bRemoved ? "#BB0000" : (comp.PhantomSource ? "#0a6ed1" : "#888888"),
                            nodeType: "component",
                            cssClass: bRemoved ? "treeNodeComponent treeNodeComponentRemoved" : "treeNodeComponent",
                            iconClass: bRemoved ? "treeIconComponentRemoved" : "treeIconComponent",
                            _srcMaterial: comp.Material,
                            _srcRequiredQuantity: comp.RequiredQuantity,
                            _srcBaseUnit: comp.BaseUnit,
                            _srcPhantomSource: comp.PhantomSource || "",
                            _removedFromOrder: bRemoved
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
                        hasLink: false,
                        nodes: aComponentNodes
                    };
                });

                const sMaterial = oOrderData.Material || "";
                const sPlant = oOrderData.ProductionPlant || "";
                const sOrderDesc = sMaterial + (sPlant ? " - " + sPlant : "");

                const aTreeNodes = [{
                    text: sManufacturingOrder,
                    description: sOrderDesc,
                    icon: "sap-icon://factory",
                    iconColor: "#107E3E",
                    nodeType: "order",
                    cssClass: "treeNodeOrder",
                    iconClass: "treeIconOrder",
                    nodes: aOperationNodes
                }];

                oTreeModel.setProperty("/nodes", aTreeNodes);
                oTreeModel.setProperty("/busy", false);

                // Expand all nodes after data is loaded
                setTimeout(() => {
                    // [TREE-STATE] Si riapre tutto TRANNE i nodi che l'utente ha chiuso.
                    TreeState.restore(this.byId("operationsTree"), this._oCollapsedSap, TreeState.sapKey, 3);
                }, 100);
            })
            .catch(oError => {
                if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                console.error(">>> Error loading tree data:", oError);
                oTreeModel.setProperty("/nodes", []);
                oTreeModel.setProperty("/busy", false);
            });
        },

        onRefreshSapTree() {
            if (!this._sManufacturingOrder) return;
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            this._loadTreeData(this._sManufacturingOrder);
            MessageToast.show(oResourceBundle.getText("dataRefreshed"));
        },

        // ================================================================
        // [ORDER-COMP-REMOVE] Rimozione manuale di un componente (feature 0026)
        //
        // COS'E'. Una persona dichiara che un componente non appartiene più a quest'ordine, perché
        // in SAP è stato tolto o sostituito e l'albero Plex — che l'ordine eredita dal ciclo del
        // materiale — se lo porta ancora dietro. La rimozione non è una regola d'invio: restringe
        // l'insieme dei componenti SAP su cui il server decide cosa aggiungere alla distinta del
        // lotto e cosa portare a `Active = 0`. L'effetto che la fabbrica vede è la disattivazione.
        //
        // LA VERITA' STA SUL SERVER, non qui. Questo elenco serve a due cose: marcare il componente
        // nell'albero SAP e costruire il payload di `savePlexCycle`. Chi sottrae davvero è
        // `loadOrderDetails` (srv/jobs/createPlexProductionOrders.js), che legge la tabella.
        //
        // IL CONFRONTO E' LO STESSO DEL SERVER: maiuscolo e potato, zeri iniziali NON allineati
        // (`matKey` in srv/lib/orderBomAddRules.js, DEC-51). Due normalizzazioni diverse sui due lati
        // darebbero un componente marcato a schermo e non sottratto all'invio.
        // ================================================================

        /** La chiave di confronto di un codice materiale. Gemella di `matKey` lato server. */
        _materialKey(sMaterial) {
            return (sMaterial === null || sMaterial === undefined ? "" : String(sMaterial))
                .trim().toUpperCase();
        },

        _isComponentRemoved(sMaterial) {
            const sKey = this._materialKey(sMaterial);
            if (!sKey) return false;
            return (this._aRemovedMaterials || []).some(m => this._materialKey(m) === sKey);
        },

        /** Aggiunge un materiale all'elenco dei rimossi. Idempotente. */
        _addRemovedMaterial(sMaterial) {
            if (this._isComponentRemoved(sMaterial)) return;
            this._aRemovedMaterials.push(sMaterial);
        },

        /**
         * Toglie un materiale dall'elenco dei rimossi: è l'inverso della rimozione, e l'unico modo
         * di annullarla. Lo chiama il trascinamento dall'albero SAP — rimettere il componente in
         * un'operazione E' la richiesta di rimetterlo in gioco.
         */
        _clearRemovedMaterial(sMaterial) {
            const sKey = this._materialKey(sMaterial);
            if (!sKey) return false;
            const iBefore = this._aRemovedMaterials.length;
            this._aRemovedMaterials = this._aRemovedMaterials
                .filter(m => this._materialKey(m) !== sKey);
            return this._aRemovedMaterials.length !== iBefore;
        },

        /** Conteggio e striscia sopra l'albero Plex. */
        _refreshRemovedState() {
            const oModel = this.getView().getModel("plexCycleModel");
            if (!oModel) return;
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const iCount = (this._aRemovedMaterials || []).length;
            oModel.setProperty("/removedCount", iCount);
            oModel.setProperty("/removedText", iCount
                ? oBundle.getText("orderCompRemovedStrip", [String(iCount)])
                : "");
        },

        /**
         * Rimarca i nodi componente dell'albero SAP già a schermo.
         *
         * SI CAMMINA SULL'ALBERO invece di richiamare `_loadTreeData`, e non è un dettaglio: quella
         * funzione fa DUE letture verso SAP (operazioni e componenti dell'ordine), e rifarle per
         * cambiare un colore sarebbe pagare a SAP il costo di una marcatura.
         *
         * MA I NODI SI RIASSEGNANO, non si aggiornano in posto: `cssClass` e `iconClass` sono legati
         * all'attributo `class` del template, che UI5 risolve alla COSTRUZIONE dell'elemento — un
         * `refresh()` aggiorna testi e colori (che sono proprietà) e lascerebbe la classe di prima,
         * cioè il barrato che non compare e, peggio, che non se ne va. Rimettere l'array in cima
         * ricrea gli item, quindi si ri-espande come fa il caricamento.
         */
        _rebuildSapTreeIfLoaded() {
            const oTreeModel = this.getView().getModel("treeModel");
            if (!oTreeModel) return;
            const aNodes = oTreeModel.getProperty("/nodes") || [];
            if (!aNodes.length) return;
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const sSuffix = " | " + oBundle.getText("orderCompRemovedExcluded");
            let bChanged = false;

            const markNode = (oNode) => {
                if (oNode.nodeType === "component") {
                    const bRemoved = this._isComponentRemoved(oNode._srcMaterial);
                    if (bRemoved !== !!oNode._removedFromOrder) {
                        bChanged = true;
                        oNode._removedFromOrder = bRemoved;
                        oNode.iconColor = bRemoved
                            ? "#BB0000"
                            : (oNode._srcPhantomSource ? "#0a6ed1" : "#888888");
                        oNode.cssClass = bRemoved
                            ? "treeNodeComponent treeNodeComponentRemoved"
                            : "treeNodeComponent";
                        oNode.iconClass = bRemoved ? "treeIconComponentRemoved" : "treeIconComponent";
                        oNode.description = bRemoved
                            ? oNode.description + sSuffix
                            : String(oNode.description || "").replace(sSuffix, "");
                    }
                }
                (oNode.nodes || []).forEach(markNode);
            };
            aNodes.forEach(markNode);
            if (!bChanged) return;

            oTreeModel.setProperty("/nodes", aNodes.slice());
            setTimeout(() => {
                // [TREE-STATE] Si riapre tutto TRANNE i nodi che l'utente ha chiuso.
                TreeState.restore(this.byId("operationsTree"), this._oCollapsedSap, TreeState.sapKey, 3);
            }, 100);
        },

        // ================================================================
        // PLEX CYCLE TREE (RIGHT) - Load, Build, Select, Reorder, Save
        // ================================================================

        _loadPlexCycleData(sManufacturingOrder) {
            // [LOAD-GEN] La generazione al momento della partenza. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            this.getView().getModel("plexCycleModel").setProperty("/busy", true);
            const sOpsUrl = AppUrl.url(`/production-orders/PlexCycleOperations?$filter=ManufacturingOrder eq '${encodeURIComponent(sManufacturingOrder)}'&$orderby=OperationNumber asc`);
            const sCompUrl = AppUrl.url(`/production-orders/PlexCycleComponents?$filter=ManufacturingOrder eq '${encodeURIComponent(sManufacturingOrder)}'&$orderby=PlexOperationId asc,Sequence asc`);
            // [ORDER-CYCLE-SEED] Terza lettura: i work center approvati copiati dal ciclo del
            // materiale, come fa il dettaglio del ciclo. Senza, l'albero dell'ordine mostrerebbe
            // operazioni senza centro di lavoro accanto a un ciclo che ce li ha.
            const sWcUrl = AppUrl.url(`/production-orders/PlexCycleApprovedWorkcenters?$filter=ManufacturingOrder eq '${encodeURIComponent(sManufacturingOrder)}'`);
            // [ORDER-COMP-REMOVE] Quarta lettura: i componenti che qualcuno ha rimosso a mano.
            // Non si ricavano dall'albero — «assente dall'albero» vuol dire anche «non ancora
            // assegnato», e le due cose hanno rimedi opposti (DEC-87).
            const sRemUrl = AppUrl.url(`/production-orders/PlexCycleRemovedComponents?$filter=ManufacturingOrder eq '${encodeURIComponent(sManufacturingOrder)}'`);
            // [ORDER-COMP-REMOVE] Quinta: l'ordine è già uscito verso Plex? Lo dice il nostro
            // dizionario dei job, non Plex (DEC-80), e da questo dipende se «Rimuovi» è concesso sui
            // componenti. Nessuna chiamata verso Plex per abilitare un pulsante.
            //
            // [ORDER-MAP-JOB] Si chiede `PlexJobId`, non `PlexJobNumber`, e SENZA `$top=1`. La
            // domanda non è «esiste una riga?» — quella riga nasceva su qualunque esito, anche
            // quando la sequenza usciva prima di una sola chiamata verso Plex — ma «esiste una riga
            // con un id di job?». `PlexJobNumber` è in chiave e c'è sempre, quindi non può
            // rispondere; e il `$top=1` su un ordine spacchettato potrebbe servire proprio la riga
            // senza id mentre un pacchetto ce l'ha, cioè «mai inviato» su un lotto vivo.
            const sMapUrl = AppUrl.url(`/odata/v4/log/ZProdOrderPlexMapping?$filter=ManufacturingOrder eq '${encodeURIComponent(sManufacturingOrder)}'&$select=PlexJobId`);

            Promise.all([
                fetch(sOpsUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sCompUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                // [ORDER-CYCLE-SEED] I work center sono un ARRICCHIMENTO dell'albero, non la sua
                // spina dorsale: se quella lettura non risponde — per esempio in un ambiente dove
                // la tabella non e' ancora stata deployata — l'albero deve comparire comunque.
                // Senza questo `catch` il rifiuto della terza fetch svuoterebbe il pannello.
                fetch(sWcUrl, { headers: { "Accept": "application/json" } })
                    .then(r => r.json())
                    .catch(err => {
                        console.warn(">>> Plex cycle: approved workcenters not available", err);
                        return { value: [] };
                    }),
                // [ORDER-COMP-REMOVE] Le due letture nuove NON devono poter svuotare il pannello,
                // per la stessa ragione dei work center. Ma i due ripieghi non sono simmetrici:
                // un elenco di rimossi non letto significa «non lo so», e la conseguenza è che il
                // marcatore nell'albero SAP non compare (il server sottrae comunque: l'elenco che
                // conta è il suo). Il dizionario non letto invece si tratta come «già inviato»:
                // negare una rimozione lascia un messaggio, concederla su un ordine uscito
                // disattiva una riga di distinta in produzione.
                fetch(sRemUrl, { headers: { "Accept": "application/json" } })
                    .then(r => r.json())
                    .catch(err => {
                        console.warn(">>> [ORDER-COMP-REMOVE] removed components not available", err);
                        return { value: [], _readFailed: true };
                    }),
                fetch(sMapUrl, { headers: { "Accept": "application/json" } })
                    .then(r => {
                        // [ORDER-MAP-JOB] LA GUARDIA CHE MANCAVA. Un errore del server con corpo
                        // JSON non fa rigettare `r.json()`: senza questa riga un 502 arrivava di
                        // sotto come una risposta valida, `mapData.value` era `undefined`, e il
                        // verdetto usciva «NON inviato» — cioè «Rimuovi» concesso su un ordine che
                        // su Plex c'è. È il verso pericoloso, ed è l'opposto di quello che il
                        // ripiego qui sotto dichiara di voler fare. È la stessa guardia che la
                        // lettura dello storico ha già.
                        if (!r.ok) { throw new Error(`HTTP ${r.status}`); }
                        return r.json();
                    })
                    .catch(err => {
                        console.warn(">>> [ORDER-COMP-REMOVE] job dictionary not available", err);
                        return { value: [], _readFailed: true };
                    })
            ])
                .then(([opsData, compData, wcData, remData, mapData]) => {
                    // [LOAD-GEN] Risposta di un altro ordine: si scarta. Il controllo sta PRIMA di
                    // `_aRemovedMaterials` e di `alreadySent`, che governano i pulsanti «Rimuovi».
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    const aOps = opsData.value || [];
                    const aComps = compData.value || [];
                    const aWCs = (wcData && wcData.value) || [];
                    console.log(`>>> Plex cycle: loaded ${aOps.length} operations, ${aComps.length} components, ${aWCs.length} approved workcenters`);

                    // [ORDER-COMP-REMOVE] Le rimozioni in vigore e il verdetto «già inviato».
                    this._aRemovedMaterials = ((remData && remData.value) || [])
                        .map(r => r.Material).filter(Boolean);
                    // [ORDER-MAP-JOB] «Già inviato» è «esiste un job», e a dire che un job c'è è
                    // il suo id (DEC-80). Una riga senza `PlexJobId` è il residuo di un tentativo
                    // fallito: su Plex non c'è niente da proteggere, e tenerla per buona spegneva
                    // «Rimuovi» su ordini mai usciti. Le righe storiche non si toccano — smettono
                    // di contare da sole, e al primo invio riuscito l'upsert le riporta coerenti.
                    //
                    // La lettura CADUTA resta «già inviato»: il dubbio qui chiude, perché negare
                    // una rimozione costa un messaggio e concederla disattiva una riga di distinta
                    // di un lotto in produzione.
                    const bAlreadySent = (mapData && mapData._readFailed)
                        ? true
                        : (((mapData && mapData.value) || []).some(r => !!(r && r.PlexJobId)));
                    const oCycleModel = this.getView().getModel("plexCycleModel");
                    oCycleModel.setProperty("/alreadySent", bAlreadySent);
                    this._refreshRemovedState();
                    // L'albero SAP è già a schermo quando questa lettura arriva: va ricostruito, o
                    // il marcatore «rimosso dall'ordine» comparirebbe solo dopo il refresh manuale.
                    if (this._aRemovedMaterials.length > 0) this._rebuildSapTreeIfLoaded();

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

                    // Group components by PlexOperationId
                    const mCompsByOp = {};
                    aComps.forEach(comp => {
                        if (!mCompsByOp[comp.PlexOperationId]) {
                            mCompsByOp[comp.PlexOperationId] = [];
                        }
                        mCompsByOp[comp.PlexOperationId].push({
                            Material: comp.Material,
                            RequiredQuantity: comp.RequiredQuantity,
                            BaseUnit: comp.BaseUnit,
                            Sequence: comp.Sequence,
                            // [PHANTOM-EXPLODE] persistita in ZPlexCycleComponent: senza rileggerla
                            // qui, la provenienza sparirebbe al primo ricaricamento della pagina.
                            PhantomSource: comp.PhantomSource || "",
                            // [COMP-SOURCE] Chi ha collocato la riga: va RILETTA e rimandata al
                            // salvataggio, che e' un delete+insert — senza il giro completo il primo
                            // Salva la riporterebbe ad "AUTO" e l'invio tornerebbe a decidere dalle
                            // regole, con l'icona che sparisce dall'albero (feature 0036).
                            AssignmentSource: comp.AssignmentSource || CompSource.ORIGIN.AUTO
                        });
                    });

                    this._aPlexOperations = aOps.map(op => ({
                        PlexOperationId: op.PlexOperationId,
                        OperationCode: op.OperationCode,
                        OperationName: op.OperationName,
                        SAPOperationId: op.SAPOperationId || null,
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

                    // If no saved operations, trigger auto-import from template routing associations
                    if (aOps.length === 0) {
                        console.log(">>> No saved Plex cycle — triggering auto-import");
                        this._autoImportPlexCycle();
                    }
                })
                .catch(err => {
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    console.error(">>> Error loading Plex cycle data:", err);
                    this._aPlexOperations = [];
                    this._rebuildPlexCycleTree();
                    this.getView().getModel("plexCycleModel").setProperty("/busy", false);
                });
        },

        // ----------------------------------------------------------------
        // [ORDER-CYCLE-IMPORT] Import del ciclo salvato del materiale
        // ----------------------------------------------------------------

        /**
         * «Importa dal Ciclo»: rilancia l'import a richiesta, anche quando un ciclo e' GIA' stato
         * salvato sull'ordine — l'unico innesco era l'apertura pagina a ciclo vuoto, quindi un
         * ciclo corretto dopo il primo salvataggio non arrivava piu'. Sostituire un albero
         * esistente e' distruttivo, quindi si chiede conferma; il salvataggio resta a parte.
         */
        onImportFromRouting() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            if (!this._aPlexOperations || this._aPlexOperations.length === 0) {
                this._autoImportPlexCycle(true);
                return;
            }
            MessageBox.confirm(oResourceBundle.getText("dlgImportRoutingWarning"), {
                title: oResourceBundle.getText("dlgImportRoutingTitle"),
                onClose: (sAction) => {
                    if (sAction === MessageBox.Action.OK) this._autoImportPlexCycle(true);
                }
            });
        },

        /**
         * @param {boolean} [bManual] true = lanciato dal pulsante, false/assente = apertura pagina.
         *        Cambia due cose: quanto e' insistente il messaggio (il toast compare sull'azione
         *        manuale, la MessageStrip sempre) e — [ORDER-CYCLE-SEED] — se il ciclo importato
         *        viene SCRITTO subito sull'ordine. L'apertura pagina scrive, perche' la' l'albero
         *        e' vuoto e non c'e' niente da perdere; il pulsante no, perche' la' si sostituisce
         *        un albero che qualcuno ha salvato e il Salva resta l'atto esplicito.
         */
        _autoImportPlexCycle(bManual) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            fetch(AppUrl.url("/production-orders/autoImportPlexCycle"), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    ManufacturingOrder: this._sManufacturingOrder,
                    Persist: !bManual
                })
            })
            .then(r => r.json())
            .then(result => {
                if (result.operations && result.operations.length > 0) {
                    this._aPlexOperations = result.operations.map((op, i) => ({
                        PlexOperationId: op.PlexOperationId,
                        OperationCode: op.OperationCode,
                        OperationName: op.OperationName,
                        SAPOperationId: op.SAPOperationId || null,
                        OperationNumber: op.OperationNumber || (i + 1) * 10,
                        OperationType: op.OperationType || null,
                        SubOperation: op.SubOperation || false,
                        Shippable: op.Shippable || false,
                        NetWeight: op.NetWeight || null,
                        StandardQuantity: op.StandardQuantity || null,
                        // [ORDER-COMP-REMOVE] L'import porta i componenti del ciclo del MATERIALE,
                        // che è esattamente la sorgente da cui arriva il componente che qualcuno ha
                        // rimosso da quest'ordine: senza il filtro, «Importa dal Ciclo» lo
                        // rimetterebbe nell'albero mentre l'invio continua a sottrarlo — cioè la
                        // divergenza peggiore, quella in cui a schermo sembra tutto a posto.
                        components: (op.Components || [])
                            .filter(c => !this._isComponentRemoved(c.Material))
                            .map(c => ({
                                Material: c.Material,
                                RequiredQuantity: c.RequiredQuantity,
                                BaseUnit: c.BaseUnit,
                                // [PHANTOM-EXPLODE] la provenienza arriva dal ciclo del routing: senza
                                // ricopiarla qui sparirebbe dall'albero appena importato.
                                PhantomSource: c.PhantomSource || "",
                                // [COMP-SOURCE] L'EREDITA' CHE ARRIVA A SCHERMO: se sul ciclo del
                                // materiale qualcuno aveva collocato il componente a mano, la copia
                                // sull'ordine lo dichiara. Stessa ragione della riga sopra: senza
                                // ricopiarla qui, l'albero appena importato non la mostrerebbe.
                                AssignmentSource: c.AssignmentSource || CompSource.ORIGIN.AUTO
                            })),
                        // [ORDER-CYCLE-SEED] i work center approvati arrivano col modello
                        approvedWorkcenters: (op.ApprovedWorkcenters || []).map(wc => ({
                            WorkcenterId: wc.WorkcenterId,
                            WorkcenterCode: wc.WorkcenterCode || "",
                            WorkcenterName: wc.WorkcenterName || ""
                        }))
                    }));
                    this._rebuildPlexCycleTree();
                    // [ORDER-CYCLE-SEED] Se il server ha SCRITTO il ciclo sull'ordine non c'e'
                    // niente da salvare: marcare l'albero come modificato inviterebbe a un
                    // salvataggio che non cambia nulla, e farebbe credere che l'import sia da
                    // confermare per esistere.
                    this.getView().getModel("plexCycleModel").setProperty("/dirty", !result.persisted);
                    // Un import riuscito CON avvertenze non e' un import riuscito e basta: il
                    // messaggio del server le porta, e la striscia resta a schermo. Un modello che
                    // non e' il ciclo dell'ordine e' una di quelle avvertenze.
                    const bWarn = (result.unlinkedCount || 0) > 0
                        || (result.conflictCount || 0) > 0
                        || (result.missingOnPlexCount || 0) > 0
                        || (result.modelSource && result.modelSource !== "orderRouting");
                    this._setImportInfo(bWarn ? "Warning" : "Success", result.message);
                    MessageToast.show(oResourceBundle.getText("autoImportSuccessDetail", [
                        result.totalCount, result.linkedCount,
                        result.unlinkedCount || 0, result.conflictCount || 0
                    ]));
                } else {
                    // NON PIU' MUTO. Un albero vuoto senza spiegazione era indistinguibile da un
                    // customizing mancante: il server dice quale dei cinque casi e', e lo si mostra.
                    const sMessage = result.message || oResourceBundle.getText("autoImportEmpty");
                    console.log(`>>> [ORDER-CYCLE-IMPORT] nessuna operazione importata`
                        + ` (${result.reason || "?"}): ${sMessage}`);
                    this._setImportInfo("Warning", sMessage);
                    if (bManual) MessageToast.show(sMessage);
                }
                // [IS-CALL-LOG] l'auto-import costruisce il ciclo leggendo ordine e routing da SAP.
                // Da rimuovere a migrazione conclusa.
                IsCallLog.dump("auto-import ciclo Plex ordine " + this._sManufacturingOrder);
            })
            .catch(err => {
                console.error(">>> Error in auto-import:", err);
                this._setImportInfo("Error", oResourceBundle.getText("autoImportEmpty"));
            });
        },

        /** La striscia sopra l'albero Plex: testo del server, tipo dall'esito. */
        _setImportInfo(sType, sText) {
            const oModel = this.getView().getModel("importInfoModel");
            if (!oModel) return;
            oModel.setData({ visible: !!sText, type: sType || "Information", text: sText || "" });
        },

        onCloseImportInfo() {
            this._setImportInfo(null, "");
        },

        _rebuildPlexCycleTree() {
            const oPlexCycleModel = this.getView().getModel("plexCycleModel");
            const oDetailModel = this.getView().getModel("detailModel");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // Build operation nodes (Level 2) with component children (Level 3)
            const aOperationNodes = this._aPlexOperations.map((op, index) => {
                const aComponentNodes = (op.components || []).map((comp, compIdx) => ({
                    text: comp.Material,
                    // [PHANTOM-EXPLODE] come nell'albero SAP: la provenienza si dichiara.
                    description: Number(comp.RequiredQuantity || 0).toFixed(3) + " " + (comp.BaseUnit || "")
                        + (comp.PhantomSource
                            ? " | " + oResourceBundle.getText("phantomFrom", [comp.PhantomSource])
                            : ""),
                    icon: "sap-icon://product",
                    iconColor: comp.PhantomSource ? "#0a6ed1" : "#888888",
                    nodeType: "plexComponent",
                    // [COMP-ORPHAN] Un componente che SAP non ha piu' si vede BARRATO, e il tooltip
                    // dice cosa succedera' — sara' tolto al prossimo invio. Senza il marcatore
                    // appariva come un componente normale, con la quantita' congelata all'ultimo
                    // Salva, mentre in fabbrica la sua riga di distinta era gia' spenta dal 7.2:
                    // divergenza stabile e silenziosa fra le due schermate e il lotto (0037).
                    cssClass: CompSource.isOrphan(comp.Material, this._oSapCompKeys)
                        ? "treeNodePlexComponent treeNodeCompOrphan"
                        : "treeNodePlexComponent",
                    iconClass: "treeIconComponent",
                    isOrphan: CompSource.isOrphan(comp.Material, this._oSapCompKeys),
                    // [COMP-SOURCE] Pilota l'icona di coda. Tollerante come il server: tutto cio'
                    // che non e' "MANUAL" e' automatico, quindi una riga senza provenienza non
                    // mostra niente — cioe' il comportamento di prima (feature 0036).
                    isManual: CompSource.isManual(comp.AssignmentSource),
                    _opIndex: index,
                    _compIndex: compIdx
                }));

                const sSeqDesc = oResourceBundle.getText("plexCycleOpNum", [op.OperationNumber || ""]);
                let sDesc = op.SAPOperationId
                    ? sSeqDesc + " | \u2192 Op. " + op.SAPOperationId
                    : sSeqDesc;

                // [ORDER-CYCLE-SEED] I centri di lavoro approvati, come nell'albero del ciclo di
                // lavorazione: sull'ordine sono in sola lettura (si gestiscono dalla tab Cicli),
                // ma devono VEDERSI \u2014 altrimenti la copia sembrerebbe incompleta.
                const aWC = op.approvedWorkcenters || [];
                if (aWC.length > 0) {
                    sDesc += " | WC: " + aWC.map(wc => wc.WorkcenterCode || wc.WorkcenterName).join(", ");
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
                    nodes: aComponentNodes
                };
            });

            // Root node: same material/order as left tree
            const oOrderData = oDetailModel.getData();
            const sMaterial = oOrderData.Material || "";
            const sPlant = oOrderData.ProductionPlant || "";
            const sOrderDesc = sMaterial + (sPlant ? " - " + sPlant : "");

            const aTreeNodes = [{
                text: this._sManufacturingOrder || "",
                description: sOrderDesc,
                icon: "sap-icon://factory",
                iconColor: "#107E3E",
                nodeType: "order",
                cssClass: "treeNodeOrder",
                iconClass: "treeIconOrder",
                nodes: aOperationNodes
            }];

            oPlexCycleModel.setProperty("/nodes", aTreeNodes);

            // Expand all (3 levels: root, operations, components) and clear stale selection
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
                // No link — highlight only this Plex operation
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
            const sSapOpId = oItem.getBindingContext("linkModel").getProperty("sapOperationId");

            this._aPlexOperations[this._iLinkingPlexOpIndex].SAPOperationId = sSapOpId;

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
                const iOpIndex = oContext.getProperty("_opIndex");
                const iCompIndex = oContext.getProperty("_compIndex");
                this._updatePlexCycleButtonStates(iOpIndex, "plexComponent", iCompIndex);
            } else {
                // Root node - deselect
                const oTree = this.byId("plexCycleTree");
                oTree.removeSelections(true);
                this._updatePlexCycleButtonStates(-1);
            }

            // Auto-highlight linked SAP operation when selecting a Plex op/component
            this._clearAllHighlights();
            if (sNodeType === "plexOperation" || sNodeType === "plexComponent") {
                const iOpIdx = sNodeType === "plexOperation"
                    ? oContext.getProperty("_index")
                    : oContext.getProperty("_opIndex");
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
            // Clear stale highlight classes (UI5 recycles DOM elements)
            const oSapTree = this.byId("operationsTree");
            if (oSapTree) {
                oSapTree.getItems().forEach(item => item.removeStyleClass("treeNodeHighlighted"));
            }
            const oPlexTree = this.byId("plexCycleTree");
            if (oPlexTree) {
                oPlexTree.getItems().forEach(item => item.removeStyleClass("treeNodeHighlighted"));
            }
            // Reapply to correct nodes only
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
            const bIsComponent = sNodeType === "plexComponent";

            oModel.setProperty("/selectedIndex", iSelectedIndex);
            oModel.setProperty("/selectedNodeType", sNodeType || "");
            oModel.setProperty("/selectedCompIndex", iCompIndex != null ? iCompIndex : -1);
            // [ORDER-COMP-REMOVE] Su un ordine GIA' INVIATO il componente non si rimuove più: la sua
            // riga di distinta appartiene a un lotto in produzione. Le OPERAZIONI restano
            // rimovibili come prima — la loro rimozione non cambia ciò che si invia, e limitarla
            // sarebbe una restrizione nuova che nessuno ha chiesto.
            const bComponentRemovable = bIsComponent && !oModel.getProperty("/alreadySent");
            oModel.setProperty("/removeEnabled", bIsOperation || bComponentRemovable);
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
                        // [PLEX-OP-TYPE-FILTER] Vedi il gemello in RoutingDetail: vuoto = niente da
                        // dichiarare, ed e' lo stato iniziale.
                        noticeText: "",
                        noticeType: "None"
                    });
                    // [PLEX-OPS-SELECT] Il tetto di `iSizeLimit` di JSONModel vale 100 e taglia
                    // l'elenco IN SILENZIO: oggi non morde grazie al growing della tabella, che
                    // chiede una lunghezza esplicita. Stesso limite del `growingThreshold`.
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

        _fetchPlexOperations() {
            const oPlexOpsModel = this.getView().getModel("plexOpsModel");
            oPlexOpsModel.setProperty("/busy", true);
            // L'avviso della volta prima si azzera all'apertura: il dialog e' memorizzato e
            // riaperto, e un avviso residuo su un elenco di nuovo completo direbbe il falso — la
            // stessa ragione per cui si azzera la SearchField.
            oPlexOpsModel.setProperty("/noticeText", "");

            // [PLEX-CONN] Il plant decide da quale tenant Plex si leggono le operazioni
            // (feature 0020): e' quello dell'ordine aperto. [PLEX-OP-TYPE-FILTER] E l'ambito CYCLE
            // decide QUALI tipi: il filtro lo applica il server, qui si dichiara il suo esito — un
            // elenco vuoto perche' filtrato e un elenco vuoto perche' Plex non ha risposto sono la
            // stessa schermata.
            const oDetail = this.getView().getModel("detailModel");
            const sPlant = (oDetail && oDetail.getProperty("/ProductionPlant")) || "";
            PlexOpsCatalog.load(sPlant, PlexOpsCatalog.CYCLE_SCOPE, AppUrl.url).then((oEnv) => {
                // Mark already-selected operations
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
                // Skip if already in cycle
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
                    components: []
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
        // Remove Operation
        // ----------------------------------------------------------------

        onRemovePlexOperation() {
            const oModel = this.getView().getModel("plexCycleModel");
            const iIndex = oModel.getProperty("/selectedIndex");
            const sNodeType = oModel.getProperty("/selectedNodeType");
            const iCompIndex = oModel.getProperty("/selectedCompIndex");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            if (sNodeType === "plexComponent" && iIndex >= 0 && iCompIndex >= 0) {
                // Remove a component from an operation
                const op = this._aPlexOperations[iIndex];
                const comp = op.components[iCompIndex];
                if (!comp) return;

                // ----------------------------------------------------------------
                // [ORDER-COMP-REMOVE] Il guardiano, anche qui (feature 0026).
                //
                // Il pulsante è già disabilitato su un ordine inviato; questo ramo esiste perché lo
                // stato del modello e la selezione possono divergere — e perché la regola va detta
                // dove la si applica, non solo dove si accende il pulsante. La regola vera sta sul
                // server, in `savePlexCycle`.
                //
                // Prima la rimozione era SOLO sull'albero locale: il componente spariva dalla
                // schermata e continuava ad andare su Plex, perché l'invio legge i componenti da
                // SAP e l'albero non è un canale. Ora si registra e restringe ciò che si invia.
                // ----------------------------------------------------------------
                if (oModel.getProperty("/alreadySent")) {
                    MessageBox.information(oResourceBundle.getText("orderCompRemoveBlocked"));
                    return;
                }

                MessageBox.confirm(
                    oResourceBundle.getText("confirmRemoveOrderComponent", [comp.Material]),
                    {
                        onClose: (sAction) => {
                            if (sAction === MessageBox.Action.OK) {
                                op.components.splice(iCompIndex, 1);
                                op.components.forEach((c, i) => { c.Sequence = (i + 1) * 10; });
                                // La rimozione si REGISTRA: è quello che la rende effettiva
                                // all'invio, al successivo «Salva Ciclo».
                                this._addRemovedMaterial(comp.Material);
                                this._refreshRemovedState();
                                this._rebuildSapTreeIfLoaded();
                                this._rebuildPlexCycleTree();
                                oModel.setProperty("/dirty", true);
                                MessageToast.show(oResourceBundle.getText("orderComponentRemoved"));
                            }
                        }
                    }
                );
            } else if (sNodeType === "plexOperation" && iIndex >= 0 && iIndex < this._aPlexOperations.length) {
                // Remove an entire operation (and its components)
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

            // Swap with previous
            const temp = this._aPlexOperations[iIndex];
            this._aPlexOperations[iIndex] = this._aPlexOperations[iIndex - 1];
            this._aPlexOperations[iIndex - 1] = temp;

            this._recalculateSequences();
            this._rebuildPlexCycleTree();
            oModel.setProperty("/dirty", true);

            // Re-select the moved item
            setTimeout(() => {
                this._selectPlexTreeItem(iIndex - 1);
            }, 150);
        },

        onMoveOperationDown() {
            const oModel = this.getView().getModel("plexCycleModel");
            const iIndex = oModel.getProperty("/selectedIndex");

            if (iIndex < 0 || iIndex >= this._aPlexOperations.length - 1) return;

            // Swap with next
            const temp = this._aPlexOperations[iIndex];
            this._aPlexOperations[iIndex] = this._aPlexOperations[iIndex + 1];
            this._aPlexOperations[iIndex + 1] = temp;

            this._recalculateSequences();
            this._rebuildPlexCycleTree();
            oModel.setProperty("/dirty", true);

            // Re-select the moved item
            setTimeout(() => {
                this._selectPlexTreeItem(iIndex + 1);
            }, 150);
        },

        // ----------------------------------------------------------------
        // Drag and Drop
        // ----------------------------------------------------------------

        onPlexTreeDrop(oEvent) {
            const oDraggedItem = oEvent.getParameter("draggedControl");
            const oDroppedItem = oEvent.getParameter("droppedControl");
            const sDropPosition = oEvent.getParameter("dropPosition");

            // Detect cross-tree drop (from SAP tree) vs same-tree reorder
            const oDragContextTree = oDraggedItem.getBindingContext("treeModel");
            const oDragContextPlex = oDraggedItem.getBindingContext("plexCycleModel");

            if (oDragContextTree) {
                this._handleCrossTreeDrop(oDragContextTree, oDroppedItem, sDropPosition);
            } else if (oDragContextPlex) {
                this._handlePlexReorder(oDragContextPlex, oDroppedItem, sDropPosition);
            }
        },

        /**
         * Cross-tree drop: copy a component from SAP tree onto a Plex operation
         */
        _handleCrossTreeDrop(oDragContext, oDroppedItem, sDropPosition) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // Only allow component nodes to be dropped
            if (oDragContext.getProperty("nodeType") !== "component") return;

            const oSourceData = {
                Material: oDragContext.getProperty("_srcMaterial"),
                RequiredQuantity: oDragContext.getProperty("_srcRequiredQuantity"),
                BaseUnit: oDragContext.getProperty("_srcBaseUnit"),
                // [PHANTOM-EXPLODE] La provenienza segue il componente: senza, il salvataggio la
                // perderebbe e la riga tornerebbe indistinguibile da una diretta.
                PhantomSource: oDragContext.getProperty("_srcPhantomSource") || ""
            };
            if (!oSourceData.Material) return;

            // Find the target Plex operation
            const oDropContext = oDroppedItem.getBindingContext("plexCycleModel");
            if (!oDropContext) return;

            const sDropNodeType = oDropContext.getProperty("nodeType");
            let iTargetOpIndex;

            if (sDropNodeType === "plexOperation") {
                iTargetOpIndex = oDropContext.getProperty("_index");
            } else if (sDropNodeType === "plexComponent") {
                // Dropped on a component — use its parent operation
                iTargetOpIndex = oDropContext.getProperty("_opIndex");
            } else {
                return; // Dropped on root — ignore
            }

            if (iTargetOpIndex < 0 || iTargetOpIndex >= this._aPlexOperations.length) return;

            const oTargetOp = this._aPlexOperations[iTargetOpIndex];
            if (!oTargetOp.components) oTargetOp.components = [];

            // Prevent duplicate material in the same operation
            if (oTargetOp.components.some(c => c.Material === oSourceData.Material)) {
                MessageToast.show(oResourceBundle.getText("componentAlreadyExists", [oSourceData.Material]));
                return;
            }

            // Copy the component into the operation
            oTargetOp.components.push({
                Material: oSourceData.Material,
                RequiredQuantity: oSourceData.RequiredQuantity,
                BaseUnit: oSourceData.BaseUnit,
                Sequence: (oTargetOp.components.length + 1) * 10,
                PhantomSource: oSourceData.PhantomSource,
                // [COMP-SOURCE] Trascinato dall'albero SAP su un'operazione: e' una persona che ha
                // scelto dove metterlo, e da questa feature quella scelta ARRIVA in fabbrica — il
                // passo 2bis dell'invio la rispetta invece di interrogare le regole (0036).
                AssignmentSource: CompSource.ORIGIN.MANUAL
            });

            // [ORDER-COMP-REMOVE] Il trascinamento è l'INVERSO della rimozione, e l'unico modo di
            // annullarla: rimettere il componente su un'operazione è la richiesta di rimetterlo in
            // gioco. Senza questa riga il componente ricomparirebbe nell'albero e resterebbe
            // sottratto all'invio — la peggiore delle due divergenze, perché a schermo sembrerebbe
            // tutto a posto.
            if (this._clearRemovedMaterial(oSourceData.Material)) {
                this._refreshRemovedState();
                this._rebuildSapTreeIfLoaded();
            }

            // [TREE-STATE] L'operazione che RICEVE si apre, cosi' si vede dove e' finito il
            // componente. Solo lei: le altre restano come l'utente le ha lasciate.
            TreeState.forget(this._oCollapsedPlex, TreeState.opKey(oTargetOp.PlexOperationId));

            this._rebuildPlexCycleTree();
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);
            MessageToast.show(oResourceBundle.getText("componentCopied", [oSourceData.Material]));
        },

        /**
         * Same-tree reorder/move: operations or components
         */
        _handlePlexReorder(oDragContext, oDroppedItem, sDropPosition) {
            const oDropContext = oDroppedItem.getBindingContext("plexCycleModel");
            if (!oDropContext) return;

            const sDragNodeType = oDragContext.getProperty("nodeType");
            const sDropNodeType = oDropContext.getProperty("nodeType");

            if (sDragNodeType === "plexOperation" && sDropNodeType === "plexOperation") {
                // Reorder operations
                const iDragIndex = oDragContext.getProperty("_index");
                const iDropIndex = oDropContext.getProperty("_index");

                if (iDragIndex === iDropIndex) return;

                const [oDraggedOp] = this._aPlexOperations.splice(iDragIndex, 1);

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
            } else if (sDragNodeType === "plexComponent") {
                // Move component between operations
                this._handleComponentMove(oDragContext, oDropContext);
            }
        },

        /**
         * Move a component from one Plex operation to another
         */
        _handleComponentMove(oDragContext, oDropContext) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const sDropNodeType = oDropContext.getProperty("nodeType");

            const iSrcOpIndex = oDragContext.getProperty("_opIndex");
            const iCompIndex = oDragContext.getProperty("_compIndex");

            // Determine target operation
            let iTargetOpIndex;
            if (sDropNodeType === "plexOperation") {
                iTargetOpIndex = oDropContext.getProperty("_index");
            } else if (sDropNodeType === "plexComponent") {
                iTargetOpIndex = oDropContext.getProperty("_opIndex");
            } else {
                return;
            }

            // Same operation — ignore
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

            // [COMP-SOURCE] LA RICOLLOCAZIONE A MANO RENDE LA RIGA MANUALE, come sul ciclo: da qui
            // in avanti la collocazione l'ha decisa una persona guardando l'albero, e l'invio la
            // rispetta. Torna sotto le regole solo premendo «Auto-Assegna», che e' di nuovo una
            // persona che lo chiede — e che da questa feature lo dichiara prima di farlo (0036).
            oTargetOp.components.push({
                ...oComp,
                Sequence: (oTargetOp.components.length + 1) * 10,
                AssignmentSource: CompSource.ORIGIN.MANUAL
            });

            // [TREE-STATE] L'operazione che RICEVE si apre, cosi' si vede dove e' finito il
            // componente. Solo lei: le altre restano come l'utente le ha lasciate.
            TreeState.forget(this._oCollapsedPlex, TreeState.opKey(oTargetOp.PlexOperationId));

            this._rebuildPlexCycleTree();
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);
            MessageToast.show(oResourceBundle.getText("componentMoved", [oComp.Material]));
        },

        // ----------------------------------------------------------------
        // Save Cycle
        // ----------------------------------------------------------------

        onSavePlexCycle() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oModel = this.getView().getModel("plexCycleModel");

            const oPayload = {
                ManufacturingOrder: this._sManufacturingOrder,
                Operations: this._aPlexOperations.map(op => ({
                    PlexOperationId: op.PlexOperationId,
                    OperationCode: op.OperationCode,
                    OperationName: op.OperationName,
                    SAPOperationId: op.SAPOperationId || null,
                    OperationNumber: op.OperationNumber || null,
                    OperationType: op.OperationType || null,
                    SubOperation: op.SubOperation || false,
                    Shippable: op.Shippable || false,
                    NetWeight: op.NetWeight || null,
                    StandardQuantity: op.StandardQuantity || null,
                    Components: (op.components || []).map(comp => ({
                        Material: comp.Material,
                        RequiredQuantity: comp.RequiredQuantity,
                        BaseUnit: comp.BaseUnit,
                        PhantomSource: comp.PhantomSource || "",
                        // [COMP-SOURCE] Si RIMANDA, per la stessa ragione dei work center qui sotto
                        // e di `PhantomSource` qui sopra: il salvataggio e' un delete-and-insert, e
                        // un payload che non la porta riporterebbe ogni riga sotto le regole senza
                        // che nessuno lo abbia chiesto (feature 0036).
                        AssignmentSource: comp.AssignmentSource || CompSource.ORIGIN.AUTO
                    })),
                    // [ORDER-CYCLE-SEED] I work center si RIMANDANO: il salvataggio dell'ordine e'
                    // un delete-and-insert, e un payload che non li porta li lascerebbe indietro.
                    // Sull'ordine non si modificano (si gestiscono dalla tab Cicli), ma sopravvivono
                    // a ogni salvataggio dell'albero.
                    ApprovedWorkcenters: (op.approvedWorkcenters || []).map(wc => ({
                        WorkcenterId: wc.WorkcenterId,
                        WorkcenterCode: wc.WorkcenterCode || "",
                        WorkcenterName: wc.WorkcenterName || ""
                    }))
                })),
                // [ORDER-COMP-REMOVE] Le rimozioni si mandano SEMPRE, anche vuote: il campo assente
                // vuol dire «non è affare mio» e il server conserva quel che ha (come i work center),
                // quindi senza questa riga l'ultima rimozione non si potrebbe più annullare.
                RemovedComponents: (this._aRemovedMaterials || []).map(m => ({ Material: m }))
            };

            fetch(AppUrl.url("/production-orders/savePlexCycle"), {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(oPayload)
            })
            .then(r => r.json())
            .then(result => {
                if (result.success) {
                    MessageToast.show(oResourceBundle.getText("cycleSavedSuccess", [result.count]));
                    oModel.setProperty("/dirty", false);
                    return;
                }
                // [ORDER-COMP-REMOVE] Il rifiuto del guardiano è un messaggio che va LETTO — nomina
                // i materiali e dice perché — mentre il toast generico lo nascondeva. Vale per
                // qualunque errore del server, non solo per questo.
                const sServerMsg = result && result.error && result.error.message;
                if (sServerMsg) {
                    MessageBox.error(sServerMsg);
                } else {
                    MessageToast.show(oResourceBundle.getText("cycleSaveError"));
                }
            })
            .catch(err => {
                console.error(">>> Error saving Plex cycle:", err);
                MessageToast.show(oResourceBundle.getText("cycleSaveError"));
            });
        },

        // ----------------------------------------------------------------
        // Create Job in Plex (manual) for the current production order
        // ----------------------------------------------------------------

        onCreateJobInPlex() {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const sOrder = this._sManufacturingOrder;
            if (!sOrder) {
                MessageToast.show(oBundle.getText("createJobError", [""]));
                return;
            }

            // ----------------------------------------------------------------
            // [ORDER-CYCLE-REQUIRED] Un ordine senza operazioni nel ciclo non si crea su Plex
            // (feature 0026). Il gate vero è sul server, dentro `processOrder`, ed è quello che
            // vale anche per il job pianificato; questo è solo il modo di non far partire una
            // chiamata di cui si conosce già l'esito, e di dire subito dove sta il rimedio.
            //
            // Solo in CREAZIONE, come il gate del server. [JOB-HEADER-ONLY] Questa frase è stata
            // FALSA per un periodo: DEC-99 aveva esteso il gate del server a entrambi i rami, e
            // questo gate client era rimasto indietro. Dalla 0038 è di nuovo vera, e per una ragione
            // migliore di prima: su un job che esiste si aggiorna la sola testata, quindi l'albero
            // del ciclo non viene nemmeno guardato e bloccare quell'aggiornamento non proteggerebbe
            // da niente.
            // ----------------------------------------------------------------
            const oCycleModel = this.getView().getModel("plexCycleModel");
            if (!oCycleModel.getProperty("/alreadySent") && this._aPlexOperations.length === 0) {
                const oDetail = this.getView().getModel("detailModel");
                MessageBox.error(oBundle.getText("orderCycleEmptyOnSend", [
                    oDetail.getProperty("/Material") || "",
                    oDetail.getProperty("/ProductionPlant") || ""
                ]));
                return;
            }

            const oBusy = new BusyDialog({
                title: oBundle.getText("btnCreateJob"),
                text: oBundle.getText("createJobSending")
            });
            oBusy.open();

            // [ACTION-RESULT] Quanto e' durata: il messaggio del taglio per tempo senza un numero
            // non distingue «la rete e' caduta subito» da «ci ha messo troppo».
            const iStartedAt = Date.now();

            fetch(AppUrl.url("/plex/createJobInPlex"), {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ ManufacturingOrder: sOrder })
            })
            // [ACTION-RESULT] Si guarda `r.ok` PRIMA di leggere il corpo. E' l'invio che dura di
            // piu' di tutti — crea il job, allinea operazioni e distinta, ordina la lista di
            // lavoro — quindi e' il primo candidato al taglio per tempo dell'approuter, che
            // risponde `504` con un corpo di TESTO: dato a `r.json()` diventa un SyntaxError, e
            // il messaggio del parser finiva interpolato dentro `createJobError`.
            // Il predicato di forma e' `status`, che e' cio' che il ramo qui sotto smista.
            .then(r => ActionResult.read(r, b => b && typeof b.status === "string"))
            .catch(err => ActionResult.fromNetworkError(err))
            .then(outcome => {
                oBusy.close();
                if (!ActionResult.isOk(outcome)) {
                    this._reportCreateJobFailure(outcome, Date.now() - iStartedAt, sOrder);
                    return;
                }
                const result = outcome.body;
                const sStatus = result && result.status;
                const sMsg = (result && (result.message || (result.error && result.error.message))) || "";
                // Feature 0014 / FR-22: the sort order note is APPENDED to the message of the job
                // transfer and never changes its type — an order sent correctly but sorted badly
                // shows a SUCCESS with a note, not a warning (FR-20). `sortNote` is already
                // localized by the server and is empty when the sort step succeeded, was not
                // foreseen (plant not enabled) or was not executed: no case to tell apart here.
                const sSortNote = (result && result.sortNote) || "";
                const withNote = (sText) => sSortNote ? (sText + "\n\n" + sSortNote) : sText;
                // [ORDER-QTY-SYNC] Ordine SPACCHETTATO: non è stato inviato un job, è stata
                // riallineata la QUANTITÀ del lotto principale (feature 0033). Il ramo sta PRIMA
                // del dispatch generico perché il messaggio da mostrare è quello del server — dice
                // quantità SAP, somma dei pacchetti e differenza — mentre `createJobSuccess`
                // direbbe «Job inviato a Plex», che qui non è successo. Il TIPO del MessageBox
                // continua a dipendere solo da `status`, come per l'invio (docs/API.md).
                if (result && result.messageCode === "orderQtySync") {
                    const sQtyTitle = oBundle.getText("orderQtySyncTitle");
                    // [ORDER-SORT-ON-WRITE] A realignment that wrote to Plex is followed by the work
                    // list sort, like a job transfer: a failed sort appends its note here too.
                    if (sStatus === "S") {
                        MessageBox.success(withNote(sMsg), { title: sQtyTitle });
                    } else if (sStatus === "W") {
                        MessageBox.warning(withNote(sMsg), { title: sQtyTitle });
                    } else {
                        MessageBox.error(withNote(sMsg), { title: sQtyTitle });
                    }
                } else if (sStatus === "S") {
                    MessageBox.success(withNote(oBundle.getText("createJobSuccess", [result.jobNumber || sOrder])));
                } else if (this._isSplitResyncRejection(result)) {
                    // Feature 0012 (contract §4.4, FR-32): a split order is not re-synchronised,
                    // nothing was touched in Plex. It is a warning, not a created job.
                    // No sort step runs on this branch, so no note can be appended here.
                    // [ORDER-QTY-SYNC] Il server non emette più questo esito: il ramo resta perché
                    // `splitResyncDisabled` è ancora nel catalogo dei messaggi (M-14).
                    MessageBox.warning(this._splitResyncMessage(result, sOrder), {
                        title: oBundle.getText("splitResultWarningTitle")
                    });
                } else if (sStatus === "W") {
                    // The job WAS created, with a warning: op/BOM alignment incomplete, or —
                    // [ORDER-BOM-ADD] — components of the order that could not be placed on the
                    // lot's BOM. The latter does not block a manual send: the user pressing the
                    // button decides, and the server declares what was left out (DEC-86).
                    MessageBox.warning(withNote(oBundle.getText("createJobWarning", [result.jobNumber || sOrder, sMsg])));
                } else {
                    MessageBox.error(withNote(oBundle.getText("createJobError", [sMsg])));
                }
                // [PLEX-CALL] Il tracciato INTEGRALE delle chiamate appena fatte verso Plex —
                // fra cui il backwards-schedule del passo 5, che su questo tenant risponde
                // `500 Data is Null`: indirizzo, corpo inviato, stato, corpo ricevuto. Non fa
                // partire nessuna chiamata: stampa quelle che il server ha appena eseguito.
                IsCallLog.dumpPlex("crea job in Plex " + sOrder);
                // [ORDER-COMP-REMOVE] L'ordine è appena uscito: da adesso i componenti non si
                // rimuovono più, e il pulsante deve spegnersi SENZA aspettare un ricaricamento
                // della pagina. Vale su `S` e su `W`: in entrambi i casi il job su Plex esiste —
                // ed è per questo che il dizionario viene scritto anche sugli esiti `W` (DEC-80).
                if (sStatus === "S" || sStatus === "W") {
                    oCycleModel.setProperty("/alreadySent", true);
                    this._updatePlexCycleButtonStates(-1);
                }
                // Refresh the Sync History tab so the just-written log entry appears
                this._loadProdOrderLogs();
                // The order may have just been shared: the split entry point depends on it
                this._loadSplitInfo();
            })
            .catch(err => {
                // Ci arriva solo un'eccezione DENTRO il ramo riuscito: le specie di esito sono
                // gia' state trattate qui sopra e non lanciano.
                oBusy.close();
                console.error(">>> Error creating Plex job:", err);
                MessageBox.error(oBundle.getText("createJobFailed"));
            });
        },

        /**
         * [ACTION-RESULT] L'invio del job non e' riuscito — o non si sa se lo sia.
         *
         * Il taglio per tempo qui e' il caso peggiore del progetto: la sequenza crea il job su
         * Plex, allinea operazioni e distinta e ordina la lista di lavoro, e un `504` arriva al
         * browser mentre tutto questo sta ancora avvenendo. Dire «fallito» manderebbe a premere
         * di nuovo «Crea Job» su un lotto che in fabbrica esiste gia'.
         *
         * Lo storico e le informazioni di spacchettamento si rileggono alla CHIUSURA del dialogo:
         * lette adesso, direbbero «mai inviato» per la sola ragione che il server non ha finito.
         */
        _reportCreateJobFailure(oOutcome, iElapsedMs, sOrder) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            console.error(">>> [ACTION-RESULT] invio job a Plex non riuscito:",
                oOutcome.kind, "HTTP", oOutcome.status, oOutcome.message || "", `${iElapsedMs} ms`);
            // [PLEX-CALL] Anche — e soprattutto — qui: se l'esito non e' arrivato al browser, le
            // chiamate verso Plex possono essere partite comunque, e sono quelle da leggere.
            IsCallLog.dumpPlex("crea job in Plex " + sOrder + " (esito non arrivato)");

            const oFail = ActionFailure.text(oOutcome, iElapsedMs, oBundle, {
                generic: "createJobFailed",
                interrupted: "createJobInterrupted"
            });
            // La sessione scaduta la annuncia SessionGuard: qui si tace di proposito.
            if (oFail.silent) { return; }

            if (ActionFailure.isInconclusive(oOutcome)) {
                MessageBox.warning(oFail.text, {
                    onClose: () => {
                        this._loadProdOrderLogs();
                        this._loadSplitInfo();
                    }
                });
                return;
            }
            this._loadProdOrderLogs();
            MessageBox.error(oFail.text);
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

            // [COMP-SOURCE] La conferma sulle righe manuali e' USCITA (11/09/2026): non tornano piu'
            // sotto le regole, quindi non c'e' niente da perdere e niente da confermare — restano
            // dove sono e il riepilogo le dichiara (vedi `_applyAutoAssignments`).
            // [COMP-ORPHAN] Questa invece RESTA, perche' e' distruttiva davvero: un componente che
            // l'ordine SAP non ha piu' sparisce dall'albero, riga manuale compresa. E' la regola
            // della 0037 — una collocazione a mano vale finche' il componente esiste in SAP — ed e'
            // anche il motivo per cui la conservazione qui sotto passa per `_oSapCompKeys`.
            const iOrphan = CompSource.countOrphans(this._aPlexOperations, this._oSapCompKeys);
            if (iOrphan > 0) {
                MessageBox.confirm(oResourceBundle.getText("autoAssignConfirmOrphans", [iOrphan]), {
                    onClose: (sAction) => {
                        if (sAction === MessageBox.Action.OK) this._runAutoAssignComponents();
                    }
                });
                return;
            }
            this._runAutoAssignComponents();
        },

        /** [COMP-SOURCE] La chiamata vera, separata dalla conferma: un solo punto d'invio. */
        _runAutoAssignComponents() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oDetailModel = this.getView().getModel("detailModel");
            // [LOAD-GEN] La generazione al momento della partenza. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            // Velo di PAGINA e non d'area, come `_executeSyncPlexCycle` sul ciclo: la risposta
            // svuota TUTTE le operazioni e ricolloca da zero, quindi qualunque gesto fatto
            // nell'attesa — un drag&drop sull'albero, un secondo clic sul pulsante — verrebbe
            // buttato via senza che nessuno lo dica. L'action legge da SAP i componenti e poi la
            // classificazione, che su Integration Suite e' una richiesta per materiale (DEC-122):
            // l'attesa e' lunga, e finora non era segnalata in nessun modo.
            oDetailModel.setProperty("/busy", true);

            // [ACTION-RESULT] Quanto e' durata: serve al messaggio del taglio per tempo. Vedi la
            // gemella in RoutingDetail.controller.js e la testata di util/ActionResult.js.
            const iStartedAt = Date.now();

            fetch(AppUrl.url("/production-orders/autoAssignPlexCycle"), {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({ ManufacturingOrder: this._sManufacturingOrder })
            })
            // [ACTION-RESULT] Si guarda `r.ok` PRIMA di applicare: `_applyAutoAssignments` svuota le
            // righe automatiche di tutte le operazioni e mette `/dirty`.
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
                IsCallLog.dump("auto-assegnazione componenti ordine " + this._sManufacturingOrder);
            })
            .catch(err => {
                // Ci arriva solo un'eccezione DENTRO `_applyAutoAssignments`.
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
         * [ACTION-RESULT] Gemella di `_reportAutoAssignFailure` sul ciclo: il testo lo sceglie
         * `AutoAssignReport.failure`, cosi' i due rami non divergono al primo ritocco. La sessione
         * scaduta resta muta — la annuncia SessionGuard.
         */
        _reportAutoAssignFailure(oOutcome, iElapsedMs) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            console.error(">>> [ACTION-RESULT] auto-assegnazione ordine non riuscita:",
                oOutcome.kind, "HTTP", oOutcome.status, oOutcome.message || "", `${iElapsedMs} ms`);

            const oFail = AutoAssignReport.failure(oOutcome, iElapsedMs, oResourceBundle);
            if (oFail.silent) { return; }
            MessageBox.error(oFail.text);
        },

        // Replace semantics: clears the AUTOMATIC components from all operations, then inserts
        // each assignment into its resolved operation (FIRST_OP / LAST_OP / concrete code).
        //
        // [COMP-SOURCE] LE RIGHE COLLOCATE A MANO NON SI TOCCANO (11/09/2026).
        //
        // E il marcatore si EREDITA: cio' che sul ciclo del materiale era manuale resta manuale
        // sull'ordine, cio' che era automatico arriva automatico — `buildImportedOps` copia il
        // valore con `normalizeOrigin`, non ne inventa uno. Ereditare NON rende manuale niente:
        // l'albero di un ordine appena importato e' fatto quasi tutto di righe `AUTO`, che le
        // regole governano come sempre. Quelle poche con la puntina vengono da una decisione presa
        // sul ciclo, e qui valgono quanto una presa su questa schermata.
        //
        // Il gemello di questa funzione sta in RoutingDetail.controller.js e ha in testa il
        // racconto completo.
        _applyAutoAssignments(result) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oModel = this.getView().getModel("plexCycleModel");
            const aAssignments = (result && result.assignments) || [];
            const aUnassigned = (result && result.unassigned) || [];

            // ------------------------------------------------------------
            // [COMP-SOURCE] LA FOTOGRAFIA SI PRENDE PRIMA DELLO SVUOTAMENTO: calcolata dopo sarebbe
            // vuota, cioe' «nessuna riga da proteggere», che e' il comportamento di prima.
            //
            // [COMP-ORPHAN] E passa per `_oSapCompKeys`: una riga manuale il cui materiale l'ordine
            // SAP non ha piu' NON si conserva. Senza questo insieme «la mano vince» diventerebbe
            // «la mano vince anche su SAP», e il componente resterebbe nell'albero — mentre su Plex
            // il passo 7.2 lo disattiva perche' non e' fra i componenti dell'ordine. I due
            // guardiani (insieme assente, insieme vuoto) stanno dentro `manualMaterials`: con i
            // componenti non letti non si toglie niente, perche' vuoto non e' ignoto.
            // ------------------------------------------------------------
            const oKeep = CompSource.manualMaterials(this._aPlexOperations, this._oSapCompKeys);

            // L'esito delle regole per materiale: la mano decide DOVE, la sorgente decide QUANTO —
            // le stesse semantiche di `applyManualTargets`, che e' cio' che l'invio applica al 2bis.
            const mByMaterial = new Map();
            aAssignments.forEach(a => {
                const sKey = CompSource.matKey(a && a.Material);
                if (sKey && !mByMaterial.has(sKey)) mByMaterial.set(sKey, a);
            });

            const aKept = [];
            this._aPlexOperations.forEach(op => {
                op.components = (op.components || []).filter(c => {
                    if (!CompSource.isManual(c && c.AssignmentSource)) return false;
                    return oKeep.has(CompSource.matKey(c && c.Material));
                });
                op.components.forEach(c => {
                    const a = mByMaterial.get(CompSource.matKey(c.Material));
                    if (a) {
                        c.RequiredQuantity = a.RequiredQuantity || 0;
                        c.BaseUnit = a.BaseUnit || "";
                        c.PhantomSource = a.PhantomSource || "";
                    }
                    aKept.push({
                        Material: c.Material,
                        TargetOperationName: op.OperationName || op.OperationCode || ""
                    });
                });
            });

            const aOrdered = this._aPlexOperations.slice()
                .sort((a, b) => (a.OperationNumber || 0) - (b.OperationNumber || 0));
            const oFirst = aOrdered[0];
            const oLast = aOrdered[aOrdered.length - 1];

            // [AUTO-ASSIGN] I saltati si RACCOLGONO, non si contano: per capire perche' un
            // componente non c'e' serve QUALE e verso quale operazione puntava la sua regola.
            let iAssigned = 0;
            const aSkipped = [];
            aAssignments.forEach(a => {
                // [COMP-SOURCE] Granularita' MATERIALE (0036 RB-05): senza il salto lo stesso
                // componente comparirebbe due volte, dove l'ha messo la mano e dove dice la regola.
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
                    RequiredQuantity: a.RequiredQuantity || 0,
                    BaseUnit: a.BaseUnit || "",
                    Sequence: (oTargetOp.components.length + 1) * 10,
                    PhantomSource: a.PhantomSource || "",
                    // [COMP-SOURCE] Collocato dalle regole: automatico. Le righe manuali non passano
                    // di qui — sono state escluse qui sopra.
                    AssignmentSource: CompSource.ORIGIN.AUTO
                });
                iAssigned++;
            });

            // Le conservate tenevano la sequenza della vita precedente: senza questo giro una riga
            // manuale con `Sequence` 30 resterebbe sotto una riga nuova numerata 20.
            this._aPlexOperations.forEach(op => {
                (op.components || []).forEach((c, i) => { c.Sequence = (i + 1) * 10; });
            });

            this._rebuildPlexCycleTree();
            oModel.setProperty("/dirty", true);

            // [COMP-SOURCE] Un materiale conservato non e' «non assegnato»: sta nell'albero.
            const aOut = aUnassigned.filter(u => !oKeep.has(CompSource.matKey(u && u.Material)));

            // Feature 0018: la classificazione non letta NON e' un dettaglio del riepilogo. I
            // componenti con condizione CLASS risultano «non assegnati» esattamente come quelli
            // che nessuna regola aggancia: senza l'avviso, un risultato incompleto si legge come
            // un risultato completo.
            const sSummary = oResourceBundle.getText("autoAssignSummary", [iAssigned, aOut.length, aSkipped.length]);
            const sDetail = AutoAssignReport.detail(aOut, aSkipped, oResourceBundle);
            // Fuori dal dettaglio: le conservate non sono un problema, e li' dentro renderebbero un
            // avviso un'auto-assegnazione riuscita.
            const sKept = AutoAssignReport.kept(aKept, oResourceBundle);
            const sText = [sSummary, sDetail, sKept].filter(Boolean).join("\n\n");
            if (result && result.ClassificationStatus === "KO") {
                MessageBox.warning(sText + "\n\n" + oResourceBundle.getText("autoAssignClfnUnavailable"));
            } else if (sDetail) {
                // [AUTO-ASSIGN] Un componente rimasto fuori non e' un esito riuscito: `information`
                // lo leggerebbe come «tutto a posto».
                MessageBox.warning(sText);
            } else {
                MessageBox.information(sText);
            }
        },

        // ----------------------------------------------------------------
        // Helpers
        // ----------------------------------------------------------------

        _recalculateSequences() {
            this._aPlexOperations.forEach((op, i) => {
                op.OperationNumber = (i + 1) * 10;
            });
        },

        // [TREE-STATE] Si cerca la riga per CONTESTO, come gli altri due controller. Prima l'indice
        // era calcolato — root(1) + per ogni operazione precedente 1 + i suoi componenti — e quel
        // conto presuppone ogni nodo APERTO: con un'operazione chiusa sopra, dopo uno spostamento
        // si sarebbe selezionata una riga qualsiasi, senza nessun errore.
        _selectPlexTreeItem(iOperationIndex) {
            const oTree = this.byId("plexCycleTree");
            if (!oTree) return;

            const aItems = oTree.getItems();
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

        formatTitle(sPattern, sOrder) {
            if (sPattern && sOrder) {
                return sPattern.replace("{0}", sOrder);
            }
            return sPattern || "";
        },

        // [I18N-EARLY] Il bundle per i FORMATTER, che girano mentre la vista si costruisce e
        // quindi prima che i modelli del componente le siano propagati. La catena completa — e
        // perche' il sintomo (`duplicate id`) non nomina la causa — sta in testa a
        // `_getSplitBundle()` in ProdOrderSplit.mixin.js. Rete: node test/i18nEarly.test.js
        _i18n() {
            const oModel = this.getView().getModel("i18n") || this.getOwnerComponent().getModel("i18n");
            return oModel.getResourceBundle();
        },

        formatProdOrderStatus(sReleased) {
            // Il ripiego cablato che c'era qui ("Released" in inglese, fuori dai bundle) era una
            // toppa allo stesso difetto: con `_i18n()` il bundle si trova sempre, e il testo esce
            // nella lingua giusta invece che in una lingua sola.
            const oResourceBundle = this._i18n();
            if (sReleased === 'X') {
                return oResourceBundle.getText("prodOrderReleased");
            }
            return oResourceBundle.getText("prodOrderNotReleased");
        },

        formatProdOrderState(sReleased) {
            if (sReleased === 'X') {
                return 'Success';
            }
            return 'Warning';
        },

        // ----------------------------------------------------------------
        // Send Log History (Sync History tab) — mirrors RoutingDetail
        // ----------------------------------------------------------------

        _loadProdOrderLogs(iPage) {
            if (!this._sManufacturingOrder) return;
            const oLogModel = this.getView().getModel("prodOrderLogModel");
            // [LOAD-GEN] La generazione al momento della partenza. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            // [LOG-PAGE] Senza pagina (cambio ordine, refresh, chiusura di un dialogo) si legge la
            // 1 — le righe piu' recenti — e la barra si azzera PRIMA della lettura.
            const oPager = LogPager.modelOf(this.getView());
            const iWanted = LogPager.begin(oPager, iPage);
            oLogModel.setProperty("/busy", true);

            // [DETAIL-RESET] Il literal si costruisce con `MatLogFilter.odataLiteral`, non con
            // `'${encodeURIComponent(v)}'`: `encodeURIComponent` NON tocca l'apice, e in OData
            // l'apice si RADDOPPIA. E' la stessa correzione gia' fatta sul materiale nella 0039, e
            // qui il key predicate della testata la usa gia' — lo storico era rimasto indietro.
            const sFilter = "ManufacturingOrder eq "
                + MatLogFilter.odataLiteral(this._sManufacturingOrder);
            // [LOG-TRACE] Le colonne si CHIEDONO. Senza `$select` ogni riga porta anche
            // `RequestJson` e `ResponseJson`, i due `LargeString` con la traccia intera, che questa
            // tabella non mostra mai: su un ordine con molti tentativi falliti la risposta cresce
            // fino a far uccidere il processo per memoria esaurita, e con `instances: 1` il
            // cockpit cade per tutti. `MessageJson` e' OBBLIGATORIO qui dentro — senza, il server
            // lascia lo snapshot italiano invece di rendere il messaggio nella lingua di chi
            // guarda (vedi `localizeLogRows` e DEC-92).
            const sUrl = AppUrl.url("/odata/v4/log/ZProdOrderExcLogPOS?$filter=") + encodeURIComponent(sFilter)
                + "&$select=" + LogTrace.listSelect([
                    "ManufacturingOrder", "Counter", "Operation", "SentDate", "SentTime",
                    "Status", "Message", "MessageJson", "ResponseStatus"
                ])
                + "&$orderby=Counter desc"
                // [LOG-PAGE] Una lettura per pagina: `$count=true&$top=100&$skip=N`.
                + LogPager.pageQuery(iWanted);

            // [LOG-MSG-I18N] Vedi il commento gemello in RoutingDetail: la lingua si dichiara.
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
                    // [LOAD-GEN] Risposta di un altro ordine: si scarta.
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    const aLogs = (data.value || []).map(log => ({
                        ...log,
                        SentDate: log.SentDate || ""
                    }));
                    oLogModel.setProperty("/logs", aLogs);
                    oLogModel.setProperty("/busy", false);
                    LogPager.applyResponse(oPager, iWanted, data, "storico ordine");
                    console.log(`>>> [LOG-PAGE] Prod order sync logs: pagina ${oPager.getProperty("/page")}`
                        + ` di ${oPager.getProperty("/pageCount")}, ${aLogs.length} righe su ${oPager.getProperty("/total")}`);
                })
                .catch(err => {
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    // [DETAIL-RESET] Una lettura fallita SVUOTA: prima il `.catch` era muto, e le
                    // righe dell'ordine precedente restavano a schermo per sempre.
                    console.error(">>> Error loading prod order sync logs:", err);
                    oLogModel.setProperty("/logs", []);
                    LogPager.reset(oPager);
                    oLogModel.setProperty("/busy", false);
                });
        },

        /** [LOG-PAGE] Un evento della barra delle pagine: si ricava la pagina e si rilegge. */
        onLogPager(oEvent) {
            const iPage = LogPager.targetOf(oEvent, LogPager.modelOf(this.getView()));
            if (iPage) { this._loadProdOrderLogs(iPage); }
        },

        onProdOrderLogRowSelect(oEvent) {
            const oItem = oEvent.getParameter("listItem");
            if (!oItem) return;

            const oCtx = oItem.getBindingContext("prodOrderLogModel");
            if (!oCtx) return;

            const oLog = oCtx.getObject();
            const oModel = this.getView().getModel("prodOrderJsonDetailModel");

            // [LOG-TRACE] La traccia non e' piu' nella riga: si chiede per questa riga sola.
            // [LOAD-GEN] Generazione PROPRIA del pannello, non quella della schermata: due clic
            // rapidi su due righe sono due letture, e a schermo deve restare la seconda. La
            // chiave si azzera anche cambiando ordine, cosi' una traccia partita per l'ordine
            // precedente non scrive su questo.
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

            const sUrl = LogTrace.traceUrl("ZProdOrderExcLogPOS", {
                ManufacturingOrder: oLog.ManufacturingOrder,
                Counter: oLog.Counter
            });
            LogTrace.fetchTrace(sUrl).then(oTrace => {
                if (!LoadGen.isCurrent(this._mLoadGen, "trace", iGen)) { return; }
                if (!oTrace.ok) {
                    // [DETAIL-RESET] Vuoto non e' ignoto: due riquadri vuoti direbbero «non e'
                    // stato mandato niente», che e' l'affermazione opposta a quella vera.
                    console.error(`>>> [LOG-TRACE] traccia non letta per ${oLog.ManufacturingOrder}/${oLog.Counter}: ${oTrace.error}`);
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

        onCloseProdOrderJsonDetail() {
            this.getView().getModel("prodOrderJsonDetailModel").setProperty("/visible", false);
        },

        // ----------------------------------------------------------------
        // Status Formatters (log rows + HTTP status)
        // ----------------------------------------------------------------

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

        /**
         * [ORDER-LOG-OP] L'etichetta dell'operazione di una riga di storico (feature 0031).
         *
         * VUOTO SIGNIFICA «INVIO JOB», e non e' un ripiego: e' la verita' delle righe scritte prima
         * della 0031, quando in questa tabella scriveva soltanto l'invio del job. Mostrarle senza
         * etichetta le farebbe sembrare di natura ignota.
         */
        formatOrderOperation(sOperation) {
            const sKey = "orderOp" + (sOperation || "JOB");
            const sText = this._i18n().getText(sKey);
            // ResourceBundle rende la CHIAVE quando non la trova: un'operazione aggiunta domani
            // mostra il suo codice, che e' meglio di `orderOpXXX` a schermo.
            return sText === sKey ? (sOperation || "") : sText;
        },

        formatHttpStatusIcon(iStatus) {
            if (!iStatus) return "";
            if (iStatus >= 200 && iStatus < 300) return "sap-icon://sys-enter-2";
            if (iStatus >= 400) return "sap-icon://error";
            return "sap-icon://alert";
        }
    }));
});

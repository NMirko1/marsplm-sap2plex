sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    // [W1-08] un work center su una sola operazione: gemello client di srv/lib/approvedWcRules.js
    "avvaleplm/marsplm/sap2plex/main/util/ApprovedWcConflicts",
    // [TEMPLATE-GROUP] un gruppo oggetti su una sola operazione, piu' la costruzione dell'elenco del
    // popover: gemello client di srv/lib/templateGroupRules.js
    "avvaleplm/marsplm/sap2plex/main/util/TemplateGroupConflicts",
    // [PLEX-OP-TYPE-FILTER] Vedi il commento gemello in RoutingDetail: le regole del catalogo
    // operazioni stanno in un punto solo.
    "avvaleplm/marsplm/sap2plex/main/util/PlexOpsCatalog",
    // [SESSION-401] L'albero del template vive in un JSONModel di VISTA, che la guardia non puo'
    // scoprire dal manifest: glielo si dichiara.
    "avvaleplm/marsplm/sap2plex/main/util/SessionGuard",
    // [TREE-STATE] Ogni modifica risemina l'intero albero, e riaprirlo tutto riapriva anche i nodi
    // che l'utente aveva chiuso. Modulo puro: node test/treeState.test.js
    "avvaleplm/marsplm/sap2plex/main/util/TreeState",
    // [APP-URL] Ogni URL verso il nostro backend porta davanti la base dell'app:
    // servita da Work Zone l'app sta sotto un prefisso, e un path assoluto non lo porta.
    "avvaleplm/marsplm/sap2plex/main/util/AppUrl"
], (Controller, JSONModel, MessageToast, MessageBox, Fragment, Filter, FilterOperator, ApprovedWcConflicts, TemplateGroupConflicts, PlexOpsCatalog, SessionGuard, TreeState, AppUrl) => {
    "use strict";

    return Controller.extend("avvaleplm.marsplm.sap2plex.main.controller.RoutingTemplateDetail", {

        onInit() {
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("routingTemplateDetail").attachPatternMatched(this._onPatternMatched, this);

            // [SESSION-401] Un template `dirty` e' un albero costruito a mano e non ancora salvato:
            // stessa ragione di RoutingDetail.
            SessionGuard.registerDirtyCheck("RoutingTemplateDetail", () => {
                const oModel = this.getView().getModel("plexCycleModel");
                return !!(oModel && oModel.getProperty("/dirty"));
            });

            // Template header model
            this.getView().setModel(new JSONModel({
                ID: null,
                Plant: null,
                TemplateCode: null,
                Description: null,
                busy: false
            }), "detailModel");

            // Tree model (root template node + operation children)
            const oPlexCycleModel = new JSONModel({
                nodes: [],
                dirty: false,
                removeEnabled: false,
                moveUpEnabled: false,
                moveDownEnabled: false,
                selectedIndex: -1,
                selectedNodeType: ""
            });
            this.getView().setModel(oPlexCycleModel, "plexCycleModel");

            // OData v4 model on the RoutingTemplate service (/routing-templates/) — backs the
            // "Copy from Template" dialog (template list, filtered by plant).
            this.getView().setModel(new sap.ui.model.odata.v4.ODataModel({
                serviceUrl: AppUrl.url("/routing-templates/"),
                operationMode: "Server",
                autoExpandSelect: true
            }), "templateModel");

            // Internal flat array of template operations (source of truth)
            this._aPlexOperations = [];

            // [TREE-STATE] I nodi che l'utente ha CHIUSO, per identita' e non per posizione: un
            // nodo che non e' qui dentro e' aperto, quindi un'operazione nuova nasce aperta.
            this._oCollapsedPlex = new Set();
        },

        _onPatternMatched(oEvent) {
            const oArgs = oEvent.getParameter("arguments");
            this._sPlant = oArgs.Plant;
            this._sTemplateID = (oArgs.TemplateID && oArgs.TemplateID !== "new") ? oArgs.TemplateID : null;

            const oDetailModel = this.getView().getModel("detailModel");
            this._aPlexOperations = [];
            // [TREE-STATE] I nodi chiusi sono di QUESTO template: la vista e' una sola e riusata.
            this._oCollapsedPlex.clear();

            if (this._sTemplateID) {
                // EDIT: load header + operations + workcenters
                oDetailModel.setData({ ID: this._sTemplateID, Plant: this._sPlant, TemplateCode: null, Description: null, busy: true });
                this._loadTemplate();
            } else {
                // CREATE: prefill a numeric code for this plant
                oDetailModel.setData({ ID: null, Plant: this._sPlant, TemplateCode: null, Description: null, busy: false });
                this._prefillTemplateCode();
                this._rebuildPlexCycleTree();
                this.getView().getModel("plexCycleModel").setProperty("/dirty", false);
            }
        },

        _prefillTemplateCode() {
            fetch(AppUrl.url("/routing-templates/getNextTemplateCode"), {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({ Plant: this._sPlant })
            })
            .then(r => r.json())
            .then(data => {
                if (data && data.code) {
                    this.getView().getModel("detailModel").setProperty("/TemplateCode", data.code);
                }
            })
            .catch(err => console.error(">>> Error getting next template code:", err));
        },

        _loadTemplate() {
            const oDetailModel = this.getView().getModel("detailModel");
            const sId = encodeURIComponent(this._sTemplateID);
            const sHdrUrl = AppUrl.url(`/routing-templates/RoutingTemplates(${sId})`);
            const sOpsUrl = AppUrl.url(`/routing-templates/RoutingTemplateOperations?$filter=TemplateID eq ${sId}&$orderby=Sequence asc`);
            const sWcUrl = AppUrl.url(`/routing-templates/RoutingTemplateWorkcenters?$filter=TemplateID eq ${sId}`);
            // [TEMPLATE-GROUP] Quarta lettura. Il `$filter` sul TemplateID non e' solo un criterio:
            // e' il gate — il server RIFIUTA una lettura di questa entity senza criteri, perche'
            // non ha la colonna Plant su cui filtrare il perimetro (feature 0048).
            const sOgUrl = AppUrl.url(`/routing-templates/RoutingTemplateGroups?$filter=TemplateID eq ${sId}`);

            Promise.all([
                fetch(sHdrUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sOpsUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sWcUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sOgUrl, { headers: { "Accept": "application/json" } }).then(r => r.json())
            ])
            .then(([hdr, opsData, wcData, ogData]) => {
                const aOps = opsData.value || [];
                const aWCs = wcData.value || [];
                const aOGs = ogData.value || [];
                console.log(`>>> Template loaded: ${aOps.length} operations, ${aWCs.length} workcenters, ${aOGs.length} object groups`);

                oDetailModel.setData({
                    ID: hdr.ID || this._sTemplateID,
                    Plant: hdr.Plant || this._sPlant,
                    TemplateCode: hdr.TemplateCode || null,
                    Description: hdr.Description || null,
                    busy: false
                });

                // Group workcenters by PlexOperationId
                const mWCsByOp = {};
                aWCs.forEach(wc => {
                    if (!mWCsByOp[wc.PlexOperationId]) mWCsByOp[wc.PlexOperationId] = [];
                    mWCsByOp[wc.PlexOperationId].push({
                        WorkcenterId: wc.WorkcenterId,
                        WorkcenterCode: wc.WorkcenterCode || "",
                        WorkcenterName: wc.WorkcenterName || ""
                    });
                });
                const mOGsByOp = this._groupsByOperation(aOGs);

                this._aPlexOperations = aOps.map(op => ({
                    PlexOperationId: op.PlexOperationId,
                    OperationCode: op.OperationCode,
                    OperationName: op.OperationName,
                    OperationNumber: op.OperationNumber || null,
                    OperationType: op.OperationType || null,
                    SubOperation: op.SubOperation || false,
                    Shippable: op.Shippable || false,
                    NetWeight: op.NetWeight || null,
                    StandardQuantity: op.StandardQuantity || null,
                    approvedWorkcenters: mWCsByOp[op.PlexOperationId] || [],
                    objectGroups: mOGsByOp[op.PlexOperationId] || []
                }));

                this._rebuildPlexCycleTree();
                this.getView().getModel("plexCycleModel").setProperty("/dirty", false);
            })
            .catch(err => {
                console.error(">>> Error loading template:", err);
                oDetailModel.setProperty("/busy", false);
                this._aPlexOperations = [];
                this._rebuildPlexCycleTree();
            });
        },

        // ----------------------------------------------------------------
        // Tree build
        // ----------------------------------------------------------------

        _rebuildPlexCycleTree() {
            const oPlexCycleModel = this.getView().getModel("plexCycleModel");
            const oDetailModel = this.getView().getModel("detailModel");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            const aOperationNodes = this._aPlexOperations.map((op, index) => {
                let sDesc = oResourceBundle.getText("plexCycleOpNum", [op.OperationNumber || ""]);
                const aWC = op.approvedWorkcenters || [];
                if (aWC.length > 0) {
                    const sWcNames = aWC.map(wc => wc.WorkcenterCode || wc.WorkcenterName).join(", ");
                    sDesc += " | WC: " + sWcNames;
                }
                // [TEMPLATE-GROUP] I soli CODICI, come i work center qui sopra: e' cio' che si
                // memorizza, e comporre qui «codice - descrizione» obbligherebbe a rileggere i
                // gruppi del plant a ogni apertura del template solo per una riga di testo.
                const aOG = op.objectGroups || [];
                if (aOG.length > 0) {
                    sDesc += " | GRP: " + aOG.join(", ");
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
                    // chiuso: `_index` e' posizionale e il riordino lo riscrive.
                    _key: op.PlexOperationId,
                    _index: index,
                    hasWorkcenters: aWC.length > 0,
                    hasObjectGroups: aOG.length > 0
                };
            });

            const oData = oDetailModel.getData();
            const aTreeNodes = [{
                text: oData.TemplateCode || oResourceBundle.getText("templateNewRootText"),
                description: oData.Description || "",
                icon: "sap-icon://course-book",
                iconColor: "#107E3E",
                nodeType: "template",
                cssClass: "treeNodeOrder",
                iconClass: "treeIconOrder",
                nodes: aOperationNodes
            }];

            oPlexCycleModel.setProperty("/nodes", aTreeNodes);

            setTimeout(() => {
                const oTree = this.byId("templateTree");
                if (oTree) {
                    // [TREE-STATE] Si riapre tutto TRANNE i nodi che l'utente ha chiuso.
                    TreeState.restore(oTree, this._oCollapsedPlex, TreeState.plexKey, 2);
                    oTree.removeSelections(true);
                }
            }, 100);

            this._updatePlexCycleButtonStates(-1);
        },

        _updatePlexCycleButtonStates(iSelectedIndex, sNodeType) {
            const oModel = this.getView().getModel("plexCycleModel");
            const iCount = this._aPlexOperations.length;
            const bIsOperation = sNodeType === "plexOperation";

            oModel.setProperty("/selectedIndex", iSelectedIndex);
            oModel.setProperty("/selectedNodeType", sNodeType || "");
            oModel.setProperty("/removeEnabled", bIsOperation);
            oModel.setProperty("/moveUpEnabled", bIsOperation && iSelectedIndex > 0);
            oModel.setProperty("/moveDownEnabled", bIsOperation && iSelectedIndex >= 0 && iSelectedIndex < iCount - 1);
        },

        // [TREE-STATE] L'unico punto in cui si scopre che l'utente ha chiuso o aperto un nodo: UI5
        // emette `toggleOpenState` solo sull'interazione (e sull'apertura automatica del nodo
        // sorvolato durante un trascinamento), mai su `expandToLevel`/`collapse` programmatici.
        onPlexTreeToggle(oEvent) {
            TreeState.remember(this._oCollapsedPlex, oEvent, TreeState.plexKey);
        },

        onPlexTreeSelectionChange(oEvent) {
            const oItem = oEvent.getParameter("listItem");
            const oContext = oItem.getBindingContext("plexCycleModel");
            if (!oContext) return;

            const sNodeType = oContext.getProperty("nodeType");
            if (sNodeType === "plexOperation") {
                this._updatePlexCycleButtonStates(oContext.getProperty("_index"), "plexOperation");
            } else {
                const oTree = this.byId("templateTree");
                oTree.removeSelections(true);
                this._updatePlexCycleButtonStates(-1);
            }
        },

        // ----------------------------------------------------------------
        // Header change -> mark dirty (and reflect code/description in root node)
        // ----------------------------------------------------------------

        onHeaderChange() {
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);
            this._rebuildPlexCycleTree();
        },

        // ----------------------------------------------------------------
        // Add Operations Dialog (reuses fragments/PlexOperationsDialog)
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
                    // [PLEX-OP-TYPE-FILTER] `noticeText`/`noticeType`: vedi il gemello in
                    // RoutingDetail. Vuoto = niente da dichiarare, ed e' lo stato iniziale.
                    const oPlexOpsModel = new JSONModel({
                        operations: [], allOperations: [], busy: false, noticeText: "", noticeType: "None"
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
            // (feature 0020). [PLEX-OP-TYPE-FILTER] E l'ambito CYCLE decide QUALI tipi: il filtro
            // lo applica il server, qui si dichiara il suo esito — un elenco vuoto perche' filtrato
            // e un elenco vuoto perche' Plex non ha risposto sono la stessa schermata.
            PlexOpsCatalog.load(this._sPlant, PlexOpsCatalog.CYCLE_SCOPE, AppUrl.url).then((oEnv) => {
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
                if (this._aPlexOperations.some(op => op.PlexOperationId === oData.id)) return;

                this._aPlexOperations.push({
                    PlexOperationId: oData.id,
                    OperationCode: oData.code,
                    OperationName: oData.name,
                    OperationNumber: iStartSeq + (iAdded * 10),
                    OperationType: null,
                    SubOperation: false,
                    Shippable: false,
                    NetWeight: null,
                    StandardQuantity: null,
                    approvedWorkcenters: [],
                    // [TEMPLATE-GROUP] Un'operazione nuova nasce senza gruppi. La riga c'e' e non e'
                    // pleonastica: senza, `objectGroups` sarebbe `undefined` e il payload non
                    // dichiarerebbe la chiave — che per l'handler significa «non toccare i gruppi».
                    objectGroups: []
                });
                iAdded++;
            });

            this._recalculateSequences();
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
        // Approved Workcenters (reuses fragments/WorkcentersPopover)
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
                    const oWcModel = new JSONModel({ workcenters: [], allWorkcenters: [], busy: false });
                    // [WC-POPOVER-WIDTH] Il tetto di `iSizeLimit` di JSONModel vale 100 e taglia
                    // l'elenco IN SILENZIO: oggi non morde grazie al growing della lista, che chiede
                    // una lunghezza esplicita. Stesso limite del `growingThreshold`.
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
            // un template del plant B dopo uno del plant A si sarebbero visti quelli di A.
            if (this._mPlexWorkcentersCache && this._mPlexWorkcentersCache[this._sPlant]) {
                this._prepareWcList(this._mPlexWorkcentersCache[this._sPlant]);
                oPopover.openBy(oOpenBy);
                return;
            }

            oWcModel.setProperty("/busy", true);
            fetch(AppUrl.url("/plex/getPlexWorkcenters"), {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({ Plant: this._sPlant })
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
                this._mPlexWorkcentersCache = this._mPlexWorkcentersCache || {};
                this._mPlexWorkcentersCache[this._sPlant] = aRaw;
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
            // [W1-08] Come nel ciclo (RoutingDetail): il work center già approvato su un'altra
            // operazione DI QUESTO TEMPLATE si vede marcato, non sparisce dalla lista.
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

            const aSelected = aAll.filter(wc => wc.selected).map(wc => ({
                WorkcenterId: wc.id,
                WorkcenterCode: wc.workcenterCode,
                WorkcenterName: wc.name
            }));

            // [W1-08] Come nel ciclo: la selezione in conflitto non si applica e il popover resta
            // aperto. Qui vale anche perché il template è la sorgente di «Import from Template»: un
            // conflitto lasciato passare qui si moltiplicherebbe su ogni ciclo che lo importa.
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
        // [TEMPLATE-GROUP] Gruppi oggetti dell'operazione
        //
        // Stesso gesto dei work center approvati qui sopra, e la somiglianza e' voluta: chi ha
        // imparato uno dei due sa gia' usare l'altro. Tre differenze, tutte con una ragione:
        //
        //   - la sorgente e' NOSTRA (`ObjectGroupVH` sul service dei template) e non Plex, quindi
        //     non c'e' nessuna action da chiamare, solo una lettura OData filtrata per plant;
        //   - cio' che si tiene in memoria e' un array di CODICI e non di oggetti: la descrizione
        //     non si persiste, e tenerla accanto al codice sarebbe una copia che invecchia
        //     (db/schema.cds);
        //   - l'elenco del popover porta in coda i codici gia' assegnati che nel customizing non
        //     ci sono piu': senza, la conferma li cancellerebbe in silenzio.
        // ----------------------------------------------------------------

        /**
         * [TEMPLATE-GROUP] Le righe di gruppo raggruppate per operazione, come mappa di CODICI.
         *
         * Vive in un metodo e non in linea perche' la chiamano in due — il caricamento e la copia da
         * un altro template — e due copie di un raggruppamento divergono senza dare errore: darebbero
         * un albero a schermo diverso da quello che viene salvato.
         *
         * @param {Array} aRows righe di RoutingTemplateGroups
         * @returns {Object} mappa PlexOperationId -> [codici]
         */
        _groupsByOperation(aRows) {
            const mByOp = {};
            (aRows || []).forEach(row => {
                if (!row || !row.GroupId) return;
                if (!mByOp[row.PlexOperationId]) mByOp[row.PlexOperationId] = [];
                mByOp[row.PlexOperationId].push(row.GroupId);
            });
            return mByOp;
        },

        onManageObjectGroups(oEvent) {
            const oSource = oEvent.getSource();
            const oCtx = oSource.getBindingContext("plexCycleModel");
            if (!oCtx) return;

            const iOpIndex = oCtx.getProperty("_index");
            if (iOpIndex === undefined || iOpIndex === null) return;

            this._iOgOpIndex = iOpIndex;
            const oView = this.getView();

            if (!this._pOgPopover) {
                this._pOgPopover = Fragment.load({
                    id: oView.getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.ObjectGroupsPopover",
                    controller: this
                }).then(oPopover => {
                    oView.addDependent(oPopover);
                    const oOgModel = new JSONModel({ groups: [], allGroups: [], busy: false });
                    // Il tetto di `JSONModel` e' 100: oltre la centesima voce la lista finisce e
                    // basta, senza errore ne' contatore. Seconda difesa accanto al `growing` del
                    // fragment, cosi' nessuna delle due dipende dall'altra.
                    oOgModel.setSizeLimit(1000);
                    oView.setModel(oOgModel, "ogModel");
                    return oPopover;
                });
            }

            this._pOgPopover.then(oPopover => {
                this._fetchAndShowObjectGroups(oPopover, oSource);
            });
        },

        /**
         * [TEMPLATE-GROUP] I gruppi del plant, in cache per plant come quella dei work center.
         *
         * La cache e' PER PLANT e non booleana: i gruppi sono per plant, e la vista e' una sola e
         * riusata fra un template e l'altro.
         */
        _fetchAndShowObjectGroups(oPopover, oOpenBy) {
            const oOgModel = this.getView().getModel("ogModel");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            if (this._mObjectGroupsCache && this._mObjectGroupsCache[this._sPlant]) {
                this._prepareOgList(this._mObjectGroupsCache[this._sPlant]);
                oPopover.openBy(oOpenBy);
                return;
            }

            oOgModel.setProperty("/busy", true);
            const sUrl = AppUrl.url("/routing-templates/ObjectGroupVH"
                + `?$filter=Plant eq '${encodeURIComponent(this._sPlant)}'`
                + "&$select=GroupId,Description&$top=1000");

            fetch(sUrl, { headers: { "Accept": "application/json" } })
                .then(r => r.json())
                .then(data => {
                    // Un errore di CAP non e' ne' un array ne' `{value}`: senza questa riga uscirebbe
                    // un popover vuoto e muto, che si legge come «questo plant non ha gruppi».
                    if (!Array.isArray(data) && data && data.error) {
                        throw new Error(data.error.message || "errore dal server");
                    }
                    const aRaw = Array.isArray(data) ? data : (data.value || []);
                    this._mObjectGroupsCache = this._mObjectGroupsCache || {};
                    this._mObjectGroupsCache[this._sPlant] = aRaw;
                    this._prepareOgList(aRaw);
                    oOgModel.setProperty("/busy", false);
                    oPopover.openBy(oOpenBy);
                })
                .catch(err => {
                    console.error(">>> [TEMPLATE-GROUP] Error fetching object groups:", err);
                    oOgModel.setProperty("/busy", false);
                    // L'elenco si apre lo stesso, con i soli codici gia' assegnati: cosi' quello che
                    // c'e' sull'operazione resta visibile e la conferma non lo perde.
                    this._prepareOgList([]);
                    oPopover.openBy(oOpenBy);
                    MessageToast.show(oResourceBundle.getText("ogLoadError", [err.message || ""]));
                });
        },

        _prepareOgList(aAllGroups) {
            const oOgModel = this.getView().getModel("ogModel");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const op = this._aPlexOperations[this._iOgOpIndex] || {};

            const mHolders = TemplateGroupConflicts.holdersByGroup(this._aPlexOperations, this._iOgOpIndex);
            const aList = TemplateGroupConflicts.buildList(
                aAllGroups,
                op.objectGroups || [],
                mHolders,
                // Senza parametro: il codice sta gia' nel titolo della riga, e ripeterlo nella
                // descrizione lo direbbe due volte sulla stessa riga.
                () => oResourceBundle.getText("ogNotConfigured"),
                (sHolder) => oResourceBundle.getText("ogAlreadyOnOp", [sHolder])
            );

            oOgModel.setProperty("/groups", aList);
            oOgModel.setProperty("/allGroups", aList);
        },

        onOgSearch(oEvent) {
            const oOgModel = this.getView().getModel("ogModel");
            const aAll = oOgModel.getProperty("/allGroups") || [];
            const sQuery = (oEvent.getParameter("newValue") || "").trim().toLowerCase();
            if (!sQuery) {
                oOgModel.setProperty("/groups", aAll);
                return;
            }
            oOgModel.setProperty("/groups", aAll.filter(g =>
                (g.groupId || "").toLowerCase().includes(sQuery) ||
                (g.description || "").toLowerCase().includes(sQuery)
            ));
        },

        onOgPopoverConfirm() {
            const oOgModel = this.getView().getModel("ogModel");
            // Si legge da `allGroups` e non dalla lista a schermo: `groups` e' il filtrato, e
            // confermare dopo aver cercato perderebbe le spunte messe prima di digitare.
            const aAll = oOgModel.getProperty("/allGroups") || [];
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            const aSelected = aAll.filter(g => g.selected).map(g => g.groupId);

            // Lo stesso gruppo su due operazioni non si applica e il popover resta aperto: il server
            // rifiuterebbe comunque il salvataggio, ma la' l'errore uscirebbe a template costruito.
            const aConflicts = TemplateGroupConflicts.conflictsOf(
                aSelected,
                TemplateGroupConflicts.holdersByGroup(this._aPlexOperations, this._iOgOpIndex)
            );
            if (aConflicts.length > 0) {
                const sList = aConflicts
                    .map(c => oResourceBundle.getText("ogConflictLine", [c.groupLabel, c.holderLabel]))
                    .join("\n");
                MessageBox.error(oResourceBundle.getText("ogConflictOnConfirm", [sList]), {
                    title: oResourceBundle.getText("ogConflictTitle")
                });
                return;
            }

            this._aPlexOperations[this._iOgOpIndex].objectGroups = aSelected;
            this.getView().getModel("plexCycleModel").setProperty("/dirty", true);
            this._rebuildPlexCycleTree();

            this.byId("objectGroupsPopover").close();
            MessageToast.show(oResourceBundle.getText("ogUpdated", [aSelected.length]));
        },

        onOgPopoverCancel() {
            this.byId("objectGroupsPopover").close();
        },

        // ----------------------------------------------------------------
        // Remove / Move / Reorder
        // ----------------------------------------------------------------

        onRemovePlexOperation() {
            const oModel = this.getView().getModel("plexCycleModel");
            const iIndex = oModel.getProperty("/selectedIndex");
            const sNodeType = oModel.getProperty("/selectedNodeType");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

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
            setTimeout(() => this._selectPlexTreeItem(iIndex - 1), 150);
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
            setTimeout(() => this._selectPlexTreeItem(iIndex + 1), 150);
        },

        onPlexTreeDrop(oEvent) {
            const oDraggedItem = oEvent.getParameter("draggedControl");
            const oDroppedItem = oEvent.getParameter("droppedControl");
            const sDropPosition = oEvent.getParameter("dropPosition");

            const oDragContext = oDraggedItem.getBindingContext("plexCycleModel");
            const oDropContext = oDroppedItem.getBindingContext("plexCycleModel");
            if (!oDragContext || !oDropContext) return;

            if (oDragContext.getProperty("nodeType") !== "plexOperation") return;
            if (oDropContext.getProperty("nodeType") !== "plexOperation") return;

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
        },

        _recalculateSequences() {
            this._aPlexOperations.forEach((op, i) => {
                op.OperationNumber = (i + 1) * 10;
            });
        },

        _selectPlexTreeItem(iOperationIndex) {
            const oTree = this.byId("templateTree");
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

        // ----------------------------------------------------------------
        // Copy from another template (replaces operations in-memory, header untouched)
        // ----------------------------------------------------------------

        onCopyFromTemplate() {
            const oView = this.getView();

            if (!this._pCopyTemplateDialog) {
                this._pCopyTemplateDialog = Fragment.load({
                    id: oView.getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.CopyTemplateDialog",
                    controller: this
                }).then(oDialog => {
                    oView.addDependent(oDialog);
                    oView.setModel(new JSONModel({ canImport: false, selectedId: null }), "copyTmpl");
                    return oDialog;
                });
            }

            this._pCopyTemplateDialog.then(oDialog => {
                const oState = oView.getModel("copyTmpl");
                oState.setData({ canImport: false, selectedId: null });

                // Templates of the same plant, excluding the one currently being edited
                const oBox = this.byId("copyTemplateBox");
                if (oBox) {
                    oBox.setSelectedKey(null);
                    const oBinding = oBox.getBinding("items");
                    if (oBinding) {
                        const aFilters = [];
                        if (this._sPlant) aFilters.push(new Filter("Plant", FilterOperator.EQ, this._sPlant));
                        if (this._sTemplateID) aFilters.push(new Filter("ID", FilterOperator.NE, this._sTemplateID));
                        oBinding.filter(aFilters);
                        oBinding.refresh();
                    }
                }
                oView.getModel("templateModel").refresh();
                oDialog.open();
            });
        },

        onCopyTemplateSelectChange(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            const oState = this.getView().getModel("copyTmpl");
            oState.setProperty("/selectedId", oItem ? oItem.getKey() : null);
            oState.setProperty("/canImport", !!oItem);
        },

        onCopyTemplateCancel() {
            this.byId("copyTemplateDialog").close();
        },

        onCopyTemplateConfirm() {
            const sSourceId = this.getView().getModel("copyTmpl").getProperty("/selectedId");
            if (!sSourceId) return;

            if (this._aPlexOperations && this._aPlexOperations.length > 0) {
                const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
                MessageBox.confirm(oResourceBundle.getText("confirmCopyTemplate"), {
                    onClose: (sAction) => {
                        if (sAction === MessageBox.Action.OK) this._doCopyTemplate(sSourceId);
                    }
                });
            } else {
                this._doCopyTemplate(sSourceId);
            }
        },

        // Fetches the source template operations + approved workcenters and REPLACES the
        // in-memory operation list. Header (code/description) is left untouched, so on Save
        // this becomes a brand-new template. Nothing is persisted until the user saves.
        _doCopyTemplate(sSourceId) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const sId = encodeURIComponent(sSourceId);
            const sOpsUrl = AppUrl.url(`/routing-templates/RoutingTemplateOperations?$filter=TemplateID eq ${sId}&$orderby=Sequence asc`);
            const sWcUrl = AppUrl.url(`/routing-templates/RoutingTemplateWorkcenters?$filter=TemplateID eq ${sId}`);
            // [TEMPLATE-GROUP] Anche la COPIA porta i gruppi. Senza questa lettura copiare un
            // template li perderebbe in silenzio — e il difetto si scoprirebbe solo dopo il Salva,
            // quando i gruppi dell'originale non ci sono piu' sulla copia e nessuno ha detto niente.
            const sOgUrl = AppUrl.url(`/routing-templates/RoutingTemplateGroups?$filter=TemplateID eq ${sId}`);

            Promise.all([
                fetch(sOpsUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sWcUrl, { headers: { "Accept": "application/json" } }).then(r => r.json()),
                fetch(sOgUrl, { headers: { "Accept": "application/json" } }).then(r => r.json())
            ])
            .then(([opsData, wcData, ogData]) => {
                const aOps = opsData.value || [];
                const aWCs = wcData.value || [];
                const mOGsByOp = this._groupsByOperation(ogData.value || []);

                const mWCsByOp = {};
                aWCs.forEach(wc => {
                    if (!mWCsByOp[wc.PlexOperationId]) mWCsByOp[wc.PlexOperationId] = [];
                    mWCsByOp[wc.PlexOperationId].push({
                        WorkcenterId: wc.WorkcenterId,
                        WorkcenterCode: wc.WorkcenterCode || "",
                        WorkcenterName: wc.WorkcenterName || ""
                    });
                });

                // Replace the whole operation list from the source template
                this._aPlexOperations = aOps.map((op, index) => ({
                    PlexOperationId: op.PlexOperationId,
                    OperationCode: op.OperationCode,
                    OperationName: op.OperationName,
                    OperationNumber: op.OperationNumber || (index + 1) * 10,
                    OperationType: op.OperationType || null,
                    SubOperation: op.SubOperation || false,
                    Shippable: op.Shippable || false,
                    NetWeight: op.NetWeight || null,
                    StandardQuantity: op.StandardQuantity || null,
                    approvedWorkcenters: mWCsByOp[op.PlexOperationId] || [],
                    objectGroups: mOGsByOp[op.PlexOperationId] || []
                }));

                this._recalculateSequences();
                this._rebuildPlexCycleTree();
                this.getView().getModel("plexCycleModel").setProperty("/dirty", true);

                this.byId("copyTemplateDialog").close();
                MessageToast.show(oResourceBundle.getText("templateCopied", [this._aPlexOperations.length]));
            })
            .catch(err => {
                console.error(">>> Error copying template:", err);
                MessageToast.show(oResourceBundle.getText("templateCopyError"));
            });
        },

        // ----------------------------------------------------------------
        // Save
        // ----------------------------------------------------------------

        onSaveTemplate() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oDetailModel = this.getView().getModel("detailModel");
            const oData = oDetailModel.getData();

            if (!oData.TemplateCode || String(oData.TemplateCode).trim() === "") {
                MessageBox.warning(oResourceBundle.getText("templateCodeMandatory"));
                return;
            }

            const oPayload = {
                ID: oData.ID || null,
                Plant: oData.Plant,
                TemplateCode: oData.TemplateCode,
                Description: oData.Description || null,
                Operations: this._aPlexOperations.map(op => ({
                    PlexOperationId: op.PlexOperationId,
                    OperationCode: op.OperationCode,
                    OperationName: op.OperationName,
                    Sequence: op.OperationNumber || null,
                    OperationNumber: op.OperationNumber || null,
                    OperationType: op.OperationType || null,
                    SubOperation: op.SubOperation || false,
                    Shippable: op.Shippable || false,
                    NetWeight: op.NetWeight || null,
                    StandardQuantity: op.StandardQuantity || null,
                    ApprovedWorkcenters: (op.approvedWorkcenters || []).map(wc => ({
                        WorkcenterId: wc.WorkcenterId,
                        WorkcenterCode: wc.WorkcenterCode,
                        WorkcenterName: wc.WorkcenterName
                    })),
                    // [TEMPLATE-GROUP] La chiave si manda SEMPRE, anche vuota: per l'handler una
                    // chiave assente significa «non lo so, lascia i gruppi come stanno», e un
                    // template non si potrebbe piu' svuotare.
                    ObjectGroups: (op.objectGroups || []).map(sGroupId => ({ GroupId: sGroupId }))
                }))
            };

            oDetailModel.setProperty("/busy", true);

            fetch(AppUrl.url("/routing-templates/saveRoutingTemplate"), {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: JSON.stringify(oPayload)
            })
            .then(async r => {
                const body = await r.json().catch(() => ({}));
                if (!r.ok) {
                    const sMsg = (body && body.error && body.error.message) || oResourceBundle.getText("templateSaveError");
                    throw new Error(sMsg);
                }
                return body;
            })
            .then(result => {
                oDetailModel.setProperty("/busy", false);
                if (result && result.success) {
                    // Reflect server-assigned ID / code (create case)
                    this._sTemplateID = result.ID;
                    oDetailModel.setProperty("/ID", result.ID);
                    if (result.TemplateCode) oDetailModel.setProperty("/TemplateCode", result.TemplateCode);
                    this.getView().getModel("plexCycleModel").setProperty("/dirty", false);
                    this._rebuildPlexCycleTree();
                    MessageToast.show(oResourceBundle.getText("templateSaved", [result.count]));
                } else {
                    MessageToast.show(oResourceBundle.getText("templateSaveError"));
                }
            })
            .catch(err => {
                console.error(">>> Error saving template:", err);
                oDetailModel.setProperty("/busy", false);
                MessageBox.error(err.message || oResourceBundle.getText("templateSaveError"));
            });
        },

        // ----------------------------------------------------------------
        // Navigation
        // ----------------------------------------------------------------

        onBack() {
            const oModel = this.getView().getModel("plexCycleModel");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const doNav = () => this.getOwnerComponent().getRouter().navTo("dashboardNavigation");

            if (oModel.getProperty("/dirty")) {
                MessageBox.confirm(oResourceBundle.getText("templateDiscardChanges"), {
                    onClose: (sAction) => { if (sAction === MessageBox.Action.OK) doNav(); }
                });
            } else {
                doNav();
            }
        }
    });
});

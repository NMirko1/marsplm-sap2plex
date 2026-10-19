/**
 * Feature 0012 — Production order split into Plex work packages (UI part).
 *
 * Mixed into ProdOrderDetail.controller.js with Object.assign (TDD 0012 §4.4): the detail
 * controller is already large and this feature owns a self-contained set of handlers,
 * formatters and one JSON model ("splitModel", TDD §4.5).
 *
 * Contract: specs/0012-spacchettamento-ordini/04-contracts.md
 *   POST /plex/getProdOrderSplitInfo  { ManufacturingOrder }
 *   POST /plex/splitProdOrderJob      { ManufacturingOrder, Mode, Quantity?, PackageJobNumber? }
 * Both actions are invoked with a plain fetch POST — the convention of this app; no
 * bindContext/invoke is used here.
 *
 * Two rules that are easy to break and expensive to get wrong:
 *  - an HTTP 200 does not mean success: the applicative outcome is in `status` (S/W/E) and
 *    the matrix row is in `row` (contract §6.1);
 *  - the split action is NOT idempotent in SPLIT mode: never retry automatically, not even
 *    on timeout (contract §8). After an unknown outcome only getProdOrderSplitInfo is called.
 */
sap.ui.define([
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/Fragment",
    "sap/m/MessageBox",
    "sap/ui/core/format/DateFormat",
    "sap/ui/core/format/NumberFormat",
    // [PLEX-CALL] Il tracciato delle chiamate verso Plex: la risposta dell'action porta i passi in
    // forma COMPATTA, senza payload (DEC-10, C-3), quindi il `PUT` del job non si vede da nessuna
    // parte lato browser. `dumpPlex` lo stampa per intero leggendo l'anello del server.
    "avvaleplm/marsplm/sap2plex/main/util/IsCallLog",
    // [LOAD-GEN] Una risposta partita per l'ordine precedente non scrive su questo modello: la
    // scheda Pacchetti apre la finestra di spacchettamento, e i lotti sono di un ordine solo.
    // Modulo puro: node test/loadGen.test.js
    "avvaleplm/marsplm/sap2plex/main/util/LoadGen",
    // [APP-URL] Ogni URL verso il nostro backend porta davanti la base dell'app:
    // servita da Work Zone l'app sta sotto un prefisso, e un path assoluto non lo porta.
    "avvaleplm/marsplm/sap2plex/main/util/AppUrl"
], (JSONModel, Fragment, MessageBox, DateFormat, NumberFormat, IsCallLog, LoadGen, AppUrl) => {
    "use strict";

    const SPLIT_INFO_URL = AppUrl.url("/plex/getProdOrderSplitInfo");
    const SPLIT_ACTION_URL = AppUrl.url("/plex/splitProdOrderJob");

    const JSON_HEADERS = {
        "Accept": "application/json",
        "Content-Type": "application/json"
    };

    // Initial (and reset) state of the feature model — TDD §4.5.
    // No produced-quantity property exists on purpose: the produced quantity is never read
    // (G3-1 / TD-9), the only upper limit of the validation is mainQuantity.
    function initialSplitState() {
        return {
            // [DETAIL-RESET] Il velo della SCHEDA Pacchetti, e non e' `/busy`: quello piu' sotto e'
            // della FINESTRA di spacchettamento, che `_loadSplitInfo` incrocia — la lettura viene
            // rifatta dopo ogni scrittura, a finestra aperta (contract §3). Con un flag solo lo
            // spegnimento di questa lettura toglierebbe il velo alla finestra mentre la sua
            // operazione e' ancora in corso.
            tabBusy: false,
            // entry point
            canOpen: false,
            openTooltip: "",
            // order and main job
            manufacturingOrder: "",
            material: "",
            materialDescription: "",
            materialText: "",
            plant: "",
            unit: "",
            quantityDecimals: 3,
            sapOrderQuantity: null,
            mainJobFound: false,
            mainJobNumber: "",
            mainQuantity: null,
            mainDueDate: "",
            referenceQuantity: null,
            lotSum: null,
            // split status of the order
            isSplit: false,
            packageCount: 0,
            packageCountText: "",
            splitStripText: "",
            mismatch: false,
            mismatchText: "",
            nextPackageCode: "",
            canSplit: false,
            offeredCommand: "NONE",
            // open residual case (FR-26)
            residualJobNumber: "",
            residualQuantity: null,
            residualState: "",
            residualMessage: "",
            residualMessageType: "Information",
            // packages
            packages: [],
            hasPackages: false,
            // window state
            isSplitMode: false,
            quantity: "",
            quantityValid: false,
            acknowledged: false,
            previewText: "",
            previewVisible: false,
            canConfirm: false,
            busy: false,
            executing: false
        };
    }

    return {

        // ================================================================
        // MODEL / LOADING
        // ================================================================

        // Called from onInit of the detail controller
        _initSplitFeature() {
            this.getView().setModel(new JSONModel(initialSplitState()), "splitModel");
        },

        /**
         * [DETAIL-RESET] Lo stato di spacchettamento e' DELL'ORDINE (feature 0043).
         *
         * Chiamata da `_resetForNewObject` a ogni ingresso di rotta. Il router riusa una sola
         * istanza della vista, quindi senza questo passo l'ordine nuovo ereditava dal precedente il
         * numero di pacchetti, la striscia, `canSplit` e il comando offerto — cioe' la finestra di
         * spacchettamento si apriva con i lotti di un ALTRO ordine finche' `_loadSplitInfo` non
         * rispondeva.
         *
         * Riusa `initialSplitState()`, che resta privata del mixin: la forma vuota e' una sola, come
         * `_emptyDetail()` per la testata.
         */
        _resetSplitFeature() {
            const oModel = this._getSplitModel();
            if (oModel) {
                oModel.setData(initialSplitState());
                oModel.setProperty("/tabBusy", true);
            }
        },

        _getSplitModel() {
            return this.getView().getModel("splitModel");
        },

        // ================================================================
        // [I18N-EARLY] Il bundle si chiede al COMPONENTE quando la vista non ce l'ha ancora.
        //
        // QUESTA RIGA HA UCCISO LA SCHEDA ORDINE IN WORK ZONE, il 18/09/2026. Prima era il solo
        // `this.getView().getModel("i18n").getResourceBundle()`. Una vista instradata non e' ancora
        // nell'albero dei controlli mentre la si costruisce — il router la crea (`Target._load`) e
        // la inserisce nell'aggregazione `pages` solo dopo (`Target._place`) — quindi i modelli del
        // componente non le sono ancora propagati e `getModel("i18n")` risponde `undefined`.
        //
        // QUI FA PIU' DANNO CHE ALTROVE, ed e' per CHI chiama: fra i dieci chiamanti ci sono
        // `formatSplitRemedyText` e `formatSplitStateText`, che la vista LEGA nel suo XML. Un
        // formatter non gira dopo l'apertura, gira DURANTE la costruzione — quindi il `TypeError`
        // sale dentro `Target._place`, che lo intercetta, e la vista non viene MAI inserita.
        //
        // E IL SINTOMO NON NOMINA LA CAUSA, che e' la parte cara: i controlli gia' creati restano
        // registrati, quindi ogni tentativo successivo muore su «adding element with duplicate id
        // '…prodOrderDetail--btnSplitJob'» — e `btnSplitJob` non c'entra niente, e' solo il primo
        // `id=` esplicito del file, cioe' il primo a collidere. Cercando la' si finisce sul routing
        // e si perde mezza giornata.
        //
        // NON E' UN DIFETTO NUOVO: il gemello di questa riga era gia' stato diagnosticato in
        // `DashboardNavigation.controller.js` (`_i18n()`, stesso tag). La dashboard fu corretta, il
        // mixin no, e niente se ne accorse — sotto l'approuter i modelli arrivavano in tempo e il
        // ramo non veniva mai percorso. La rete che chiude il giro e' `test/i18nEarly.test.js`, che
        // spazza i formatter LEGATI NELLE VISTE e rifiuta quelli senza questo ripiego.
        // ================================================================
        _getSplitBundle() {
            const oModel = this.getView().getModel("i18n") || this.getOwnerComponent().getModel("i18n");
            return oModel.getResourceBundle();
        },

        // Reads the split status of the order. Called on route match, when the window is
        // opened and after EVERY write, whatever its outcome (contract §3, FDD §3.5).
        _loadSplitInfo() {
            const oModel = this._getSplitModel();
            const sOrder = this._sManufacturingOrder;
            if (!oModel || !sOrder) {
                return Promise.resolve(null);
            }

            // [LOAD-GEN] La generazione al momento della partenza: al ritorno dice se nel frattempo
            // si e' navigato su un altro ordine. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            oModel.setProperty("/tabBusy", true);

            // While the status is unknown the entry point says why it is disabled
            if (!oModel.getProperty("/openTooltip")) {
                oModel.setProperty("/openTooltip", this._getSplitBundle().getText("splitInfoLoading"));
            }

            return fetch(SPLIT_INFO_URL, {
                method: "POST",
                headers: JSON_HEADERS,
                body: JSON.stringify({ ManufacturingOrder: sOrder })
            })
            .then(oResponse => this._parseSplitResponse(oResponse))
            .then(oRes => {
                // [LOAD-GEN] Risposta di un altro ordine: si scarta senza scrivere. Qui conta il
                // doppio, perche' da questo modello nasce la finestra di spacchettamento.
                if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return null; }
                oModel.setProperty("/tabBusy", false);
                if (!oRes.ok) {
                    this._applySplitInfoError(this._splitHttpErrorText(oRes));
                    return null;
                }
                this._applySplitInfo(oRes.body);
                return oRes.body;
            })
            .catch(oError => {
                if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return null; }
                oModel.setProperty("/tabBusy", false);
                console.error(">>> Error reading production order split info:", oError);
                this._applySplitInfoError(oError && oError.message);
                return null;
            });
        },

        // Response reader shared by both actions: keeps HTTP status and parsed body together,
        // because a 4xx carries the OData error envelope and a 200 the applicative outcome.
        _parseSplitResponse(oResponse) {
            return oResponse.json()
                .then(oBody => ({ ok: oResponse.ok, httpStatus: oResponse.status, body: oBody || {} }))
                .catch(() => ({ ok: oResponse.ok, httpStatus: oResponse.status, body: {} }));
        },

        _splitHttpErrorText(oRes) {
            const oBody = (oRes && oRes.body) || {};
            if (oBody.error && oBody.error.message) {
                return oBody.error.message;
            }
            return "HTTP " + ((oRes && oRes.httpStatus) || "");
        },

        _applySplitInfo(oInfo) {
            const oModel = this._getSplitModel();
            const oBundle = this._getSplitBundle();
            const oState = initialSplitState();
            const oInfoData = oInfo || {};

            const aPackages = Array.isArray(oInfoData.packages) ? oInfoData.packages : [];
            const sUnit = oInfoData.Unit || "";
            const sCommand = oInfoData.OfferedCommand || "NONE";

            oState.manufacturingOrder = oInfoData.ManufacturingOrder || this._sManufacturingOrder || "";
            oState.material = oInfoData.Material || "";
            oState.materialDescription = oInfoData.MaterialDescription || "";
            oState.materialText = oState.materialDescription
                ? oState.material + " - " + oState.materialDescription
                : oState.material;
            oState.plant = oInfoData.ProductionPlant || "";
            oState.unit = sUnit;
            oState.quantityDecimals = (oInfoData.QuantityDecimals === 0 || oInfoData.QuantityDecimals)
                ? Number(oInfoData.QuantityDecimals)
                : 3;
            oState.sapOrderQuantity = this._splitNumber(oInfoData.SapOrderQuantity);
            oState.mainJobFound = oInfoData.MainJobFound === true;
            oState.mainJobNumber = oInfoData.MainJobNumber || oState.manufacturingOrder;
            oState.mainQuantity = this._splitNumber(oInfoData.MainJobQuantity);
            oState.mainDueDate = oInfoData.MainJobDueDate || "";
            oState.referenceQuantity = this._splitNumber(oInfoData.ReferenceQuantity);
            oState.lotSum = this._splitNumber(oInfoData.LotSum);

            oState.isSplit = oInfoData.IsSplit === true;
            oState.packageCount = Number(oInfoData.PackageCount || 0);
            oState.packageCountText = oState.packageCount ? String(oState.packageCount) : "";
            oState.nextPackageCode = oInfoData.NextPackageCode || "";
            oState.canSplit = oInfoData.CanSplit === true;
            oState.offeredCommand = sCommand;
            oState.isSplitMode = oState.canSplit && sCommand === "SPLIT";

            oState.packages = aPackages;
            oState.hasPackages = aPackages.length > 0;

            // FR-29: permanent indication of a split order
            oState.splitStripText = oState.isSplit
                ? oBundle.getText("splitOrderIsSplitInfo", [String(oState.packageCount)])
                : "";

            // FR-30 / M-15: divergence between SAP order quantity and sum of the Plex jobs
            oState.mismatch = oInfoData.HasMismatch === true;
            oState.mismatchText = oState.mismatch
                ? oBundle.getText("splitQtyMismatch", [
                    this._formatSplitQty(oState.sapOrderQuantity),
                    sUnit,
                    this._formatSplitQty(oState.lotSum)
                ])
                : "";

            // Open residual case: same code and same quantity, not renegotiable (FR-26)
            oState.residualJobNumber = oInfoData.ResidualJobNumber || "";
            const oResidual = oState.residualJobNumber
                ? aPackages.find(p => p.PackageJobNumber === oState.residualJobNumber)
                : null;
            oState.residualState = oResidual ? (oResidual.SplitState || "") : "";
            oState.residualQuantity = oResidual ? this._splitNumber(oResidual.Quantity) : null;

            // Message on top of the window: residual case, or the reason why it is read only
            oState.residualMessage = this._splitResolveMessage(oInfoData, { silent: true });
            oState.residualMessageType = this._splitStripType(oInfoData);

            // FR-02 / M-01: the button stays visible and gets disabled only when there is
            // nothing to open at all, i.e. the order was never shared with Plex
            const bNotShared = oInfoData.messageCode === "splitOrderNotShared";
            oState.canOpen = !bNotShared;
            oState.openTooltip = bNotShared
                ? (oState.residualMessage || oBundle.getText("btnSplitJobTooltip"))
                : oBundle.getText("btnSplitJobTooltip");

            // Preserve what the user has typed while the window is open
            const bDialogOpen = this._isSplitDialogOpen();
            if (bDialogOpen) {
                oState.quantity = oModel.getProperty("/quantity") || "";
                oState.acknowledged = oModel.getProperty("/acknowledged") === true;
            }

            oModel.setData(oState);

            if (bDialogOpen && oState.isSplitMode && oState.quantity) {
                this._validateSplitQty(oState.quantity);
            } else {
                this._updateSplitCanConfirm();
            }
        },

        // The status of the order could not be read: the entry point stays disabled with the
        // reason readable in the tooltip, and nothing is invented in the model.
        _applySplitInfoError(sDetail) {
            const oModel = this._getSplitModel();
            const oBundle = this._getSplitBundle();
            const oState = initialSplitState();
            oState.manufacturingOrder = this._sManufacturingOrder || "";
            oState.canOpen = false;
            oState.openTooltip = oBundle.getText("splitInfoLoadError", [sDetail || ""]);
            oState.residualMessage = oState.openTooltip;
            oState.residualMessageType = "Error";
            oModel.setData(oState);
        },

        // ================================================================
        // DIALOG
        // ================================================================

        onOpenSplitDialog() {
            const oView = this.getView();

            if (!this._pSplitJobDialog) {
                this._pSplitJobDialog = Fragment.load({
                    id: oView.getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.SplitJobDialog",
                    controller: this
                }).then(oDialog => {
                    oView.addDependent(oDialog);
                    // Closing is not available while the split is running (FDD §3.5): set in
                    // code, because escapeHandler takes a function and not a binding
                    oDialog.setEscapeHandler(this.onSplitDialogEscape.bind(this));
                    return oDialog;
                });
            }

            this._pSplitJobDialog.then(oDialog => {
                const oModel = this._getSplitModel();

                // The window state is reset on every open (FDD §3.4: the acknowledgement
                // check box is never pre-ticked)
                oModel.setProperty("/quantity", "");
                oModel.setProperty("/acknowledged", false);
                oModel.setProperty("/quantityValid", false);
                oModel.setProperty("/previewText", "");
                oModel.setProperty("/previewVisible", false);
                oModel.setProperty("/canConfirm", false);
                oModel.setProperty("/executing", false);
                oModel.setProperty("/busy", true);
                this._resetSplitQtyInput();

                oDialog.open();

                // FR-05 / FR-14: the real state of the main job is re-read from Plex at every
                // open; on an uncertain state the server also repeats its own verification
                this._loadSplitInfo().then(() => {
                    oModel.setProperty("/busy", false);
                });
            });
        },

        onSplitCancel() {
            // During the execution the window cannot be closed (FDD §3.5)
            if (this._getSplitModel().getProperty("/executing")) {
                return;
            }
            this._closeSplitDialog();
        },

        onSplitDialogEscape(oPromise) {
            if (this._getSplitModel().getProperty("/executing")) {
                oPromise.reject();
                return;
            }
            oPromise.resolve();
        },

        _closeSplitDialog() {
            const oDialog = this.byId("splitJobDialog");
            if (oDialog && oDialog.isOpen()) {
                oDialog.close();
            }
        },

        _isSplitDialogOpen() {
            const oDialog = this.byId("splitJobDialog");
            return !!(oDialog && oDialog.isOpen());
        },

        _resetSplitQtyInput() {
            const oInput = this.byId("splitQtyInput");
            if (oInput) {
                oInput.setValue("");
                oInput.setValueState("None");
                oInput.setValueStateText("");
            }
        },

        // ================================================================
        // QUANTITY VALIDATION (on screen — the one that decides is the server, FR-14)
        // ================================================================

        onSplitQtyChange(oEvent) {
            const sValue = oEvent ? oEvent.getParameter("value") : "";
            this._validateSplitQty(sValue);
        },

        onSplitAckChange() {
            this._updateSplitCanConfirm();
        },

        // Three cases only (FDD §3.2 after the revocation of BR-12): not a positive number,
        // too many decimals, not lower than the remaining quantity of the main job.
        _validateSplitQty(sValue) {
            const oModel = this._getSplitModel();
            const oBundle = this._getSplitBundle();
            const oInput = this.byId("splitQtyInput");

            const sUnit = oModel.getProperty("/unit") || "";
            const iDecimals = Number(oModel.getProperty("/quantityDecimals"));
            const fResidual = Number(oModel.getProperty("/mainQuantity"));

            // The number input may hand over the locale decimal separator
            const sNormalized = String(sValue === null || sValue === undefined ? "" : sValue)
                .trim()
                .replace(",", ".");
            const fQty = Number(sNormalized);

            let sError = "";
            if (!sNormalized || !isFinite(fQty) || fQty <= 0) {
                sError = oBundle.getText("splitQtyPositive");                                   // M-04
            } else if (this._splitDecimalsOf(sNormalized) > iDecimals) {
                sError = oBundle.getText("splitQtyDecimals", [sUnit, String(iDecimals)]);       // M-08
            } else if (!isFinite(fResidual) || !(fQty < fResidual)) {
                sError = oBundle.getText("splitQtyBelowResidual", [                              // M-05
                    this._formatSplitQty(fResidual), sUnit
                ]);
            }

            if (oInput) {
                oInput.setValueState(sError ? "Error" : "None");
                oInput.setValueStateText(sError);
            }

            oModel.setProperty("/quantityValid", !sError);

            if (sError) {
                oModel.setProperty("/previewVisible", false);
                oModel.setProperty("/previewText", "");
            } else {
                // FR-08: expected effect, with the code declared as expected and not guaranteed
                oModel.setProperty("/previewText", oBundle.getText("splitPreview", [
                    this._formatSplitQty(fResidual),
                    sUnit,
                    this._formatSplitQty(fResidual - fQty),
                    oModel.getProperty("/nextPackageCode") || "",
                    this._formatSplitQty(fQty)
                ]));
                oModel.setProperty("/previewVisible", true);
            }

            this._updateSplitCanConfirm();
        },

        // The four conditions of FDD §3.4, all true together
        _updateSplitCanConfirm() {
            const oModel = this._getSplitModel();
            const bCan = oModel.getProperty("/canSplit") === true
                && oModel.getProperty("/mainJobFound") === true
                && oModel.getProperty("/quantityValid") === true
                && oModel.getProperty("/acknowledged") === true
                && oModel.getProperty("/executing") !== true;
            oModel.setProperty("/canConfirm", bCan);
        },

        _splitDecimalsOf(sNumber) {
            const iDot = String(sNumber).indexOf(".");
            return iDot < 0 ? 0 : String(sNumber).length - iDot - 1;
        },

        _splitNumber(vValue) {
            if (vValue === null || vValue === undefined || vValue === "") {
                return null;
            }
            const fValue = Number(vValue);
            return isFinite(fValue) ? fValue : null;
        },

        _formatSplitQty(vValue) {
            const fValue = this._splitNumber(vValue);
            if (fValue === null) {
                return "";
            }
            if (!this._oSplitQtyFormat) {
                this._oSplitQtyFormat = NumberFormat.getFloatInstance({
                    maxFractionDigits: 3,
                    groupingEnabled: true
                });
            }
            return this._oSplitQtyFormat.format(fValue);
        },

        // ================================================================
        // WRITE ACTIONS: split and the two settlements (FR-26)
        // ================================================================

        onSplitConfirm() {
            const oModel = this._getSplitModel();
            if (oModel.getProperty("/canConfirm") !== true) {
                return;
            }
            const fQty = Number(String(oModel.getProperty("/quantity")).trim().replace(",", "."));
            this._runSplitAction({
                ManufacturingOrder: this._sManufacturingOrder,
                Mode: "SPLIT",
                Quantity: fQty
            });
        },

        onSplitComplete() {
            this._runSettlement("COMPLETE");
        },

        onSplitRestore() {
            this._runSettlement("RESTORE");
        },

        _runSettlement(sMode) {
            const oModel = this._getSplitModel();
            if (oModel.getProperty("/executing") === true) {
                return;
            }
            const oPayload = {
                ManufacturingOrder: this._sManufacturingOrder,
                Mode: sMode
            };
            // Optimistic check (contract C-1): settle exactly the case the window has read
            const sPackage = oModel.getProperty("/residualJobNumber");
            if (sPackage) {
                oPayload.PackageJobNumber = sPackage;
            }
            this._runSplitAction(oPayload);
        },

        // Single write path: the window locks itself, the server holds the real exclusive
        // lock (FR-15). No automatic retry is ever performed (contract §8).
        _runSplitAction(oPayload) {
            const oModel = this._getSplitModel();

            oModel.setProperty("/executing", true);
            oModel.setProperty("/busy", true);
            this._updateSplitCanConfirm();

            return fetch(SPLIT_ACTION_URL, {
                method: "POST",
                headers: JSON_HEADERS,
                body: JSON.stringify(oPayload)
            })
            .then(oResponse => this._parseSplitResponse(oResponse))
            .then((oRes) => {
                this._applySplitResult(oRes);
                // [PLEX-CALL] Le chiamate verso Plex della sequenza appena eseguita, PER INTERO:
                // fra loro il `PUT /scheduling/v1/jobs/{id}` di P1 (e di R1, se c'e' stato un
                // ripristino), con i corpi tentati e le risposte. La risposta dell'action non li
                // porta di proposito (DEC-10, C-3); qui si leggono dall'anello del server.
                IsCallLog.dumpPlex("split ordine " + (oPayload && oPayload.ManufacturingOrder) +
                    " (" + (oPayload && oPayload.Mode) + ")");
            })
            .catch(oError => {
                // The outcome did not reach the client (matrix row I): never repeat blindly,
                // just read the real state back
                console.error(">>> Error running production order split:", oError);
                this._applySplitResult({
                    ok: false,
                    httpStatus: 0,
                    body: { error: { message: (oError && oError.message) || "" } }
                });
                // [PLEX-CALL] Riga I della matrice: l'esito non e' arrivato al browser, ma le
                // chiamate verso Plex possono essere partite. Sono l'unico modo di sapere COSA e'
                // stato fatto — e la ragione per cui non si ritenta mai alla cieca.
                IsCallLog.dumpPlex("split ordine " + (oPayload && oPayload.ManufacturingOrder) +
                    " (esito non arrivato)");
            });
        },

        // Presentation of every row of the outcome matrix (FDD §6, contract §5)
        _applySplitResult(oRes) {
            const oModel = this._getSplitModel();
            const oBundle = this._getSplitBundle();
            const oBody = (oRes && oRes.body) || {};

            oModel.setProperty("/executing", false);
            oModel.setProperty("/busy", false);
            this._closeSplitDialog();

            if (!oRes || !oRes.ok) {
                // 4xx or transport failure: nothing was left behind (contract §6.1 point 2).
                // The technical text of the OData envelope is carried as the detail of M-23
                MessageBox.error(oBundle.getText("splitUnexpectedError", [this._splitHttpErrorText(oRes)]), {
                    title: oBundle.getText("splitResultErrorTitle")
                });
            } else {
                const sStatus = oBody.status;
                const sRow = oBody.row || "";
                const sText = this._splitResolveMessage(oBody);

                if (sStatus === "S") {
                    MessageBox.success(sText, { title: oBundle.getText("splitResultSuccessTitle") });
                } else if (sStatus === "W") {
                    // Row H — package not linked to the SAP order — is the highest priority
                    // anomaly of the matrix and gets its own title
                    MessageBox.warning(sText, {
                        title: oBundle.getText(sRow === "H"
                            ? "splitResultActionRequiredTitle"
                            : "splitResultWarningTitle")
                    });
                } else {
                    // Rows E3 and E4 are severe: quantity subtracted and either not restored
                    // or of unknown fate
                    MessageBox.error(sText, {
                        title: oBundle.getText((sRow === "E3" || sRow === "E4")
                            ? "splitResultSevereTitle"
                            : "splitResultErrorTitle")
                    });
                }
            }

            // FDD §3.5: the detail is refreshed whatever the outcome — above all on error
            this._loadProdOrderLogs();
            return this._loadSplitInfo().then(() => {
                // An open residual case must be evident, not buried: bring the user on the
                // packages tab, where the row is highlighted and carries its command (FR-28)
                if (oBody.ResidualOpen === true) {
                    const oTabBar = this.byId("prodOrderDetailTabs");
                    if (oTabBar) {
                        oTabBar.setSelectedKey("packages");
                    }
                }
            });
        },

        // Text of an outcome: composed from messageCode + messageParams on the local bundle
        // (TD-7), with the server-side `message` as fallback. Composing locally keeps the
        // window correct even when the backend cannot read the properties file (DEC-07).
        _splitResolveMessage(oBody, oOptions) {
            const oBundle = this._getSplitBundle();
            const bSilent = !!(oOptions && oOptions.silent);
            const sCode = oBody && oBody.messageCode;
            const aParams = (oBody && Array.isArray(oBody.messageParams)) ? oBody.messageParams : [];

            let sText = "";
            if (sCode) {
                const sLocal = oBundle.getText(sCode, aParams.length ? aParams : undefined);
                if (sLocal && sLocal !== sCode) {
                    sText = sLocal;
                }
            }
            if (!sText) {
                sText = (oBody && oBody.message) || "";
            }

            // Row C2: the note on the code taken in Plex is part of the outcome text (M-13)
            if (sText && oBody && oBody.CodeChanged === true) {
                const sNote = oBundle.getText("splitCodeTaken", [
                    oBody.PlannedPackageJobNumber || "",
                    oBody.PackageJobNumber || ""
                ]);
                if (sNote && sText.indexOf(sNote) === -1) {
                    sText += " " + sNote;
                }
            }

            // M-24 tail: only when no package is left on the order (IsSplit is authoritative)
            if (sText && sCode === "splitRestoreDone" && oBody.IsSplit === false) {
                const sTail = oBundle.getText("splitRestoreNoLongerSplit");
                if (sText.indexOf(sTail) === -1) {
                    sText += " " + sTail;
                }
            }

            // [JOB-SORT-SPLIT] Work list sort order (step P7, feature 0014): the note comes ALREADY
            // LOCALISED from the backend, like the twin of the «Create Job in Plex» button - the six
            // reasons live in the sort order rules, and composing them here would be a second copy
            // of that vocabulary. It is appended and nothing else: `_splitStripType` is not touched,
            // so a failed sort order never turns a successful split yellow (FR-20 of 0014).
            if (sText && oBody && oBody.sortStatus === "E" && oBody.sortNote) {
                if (sText.indexOf(oBody.sortNote) === -1) {
                    sText += " " + oBody.sortNote;
                }
            }

            if (!sText && !bSilent) {
                sText = oBundle.getText("splitUnexpectedError", [""]);
            }
            return sText;
        },

        // ================================================================
        // EFFECT OF THE FEATURE ON createJobInPlex (contract §4.4, FR-32)
        // ================================================================

        // [ORDER-QTY-SYNC] IL SERVER NON EMETTE PIU' QUESTO RIFIUTO (feature 0033).
        //
        // Fino alla 0032 un ordine spacchettato veniva SALTATO dalla ri-sincronizzazione manuale:
        // HTTP 200, status 'W', nessun numero di job e nessuna chiamata a Plex. Ora quel ramo
        // riallinea la quantita' del lotto principale e restituisce `messageCode: 'orderQtySync'`
        // con il numero d'ordine valorizzato.
        //
        // IL RIPIEGO PER ESCLUSIONE E' STATO RIMOSSO, ed e' la parte che conta. Riconosceva il
        // rifiuto da «status W + nessun jobNumber + ordine spacchettato»: con il nuovo ramo un
        // riallineamento che chiude in attenzione — un lotto non leggibile, per esempio — sarebbe
        // stato mostrato con il testo del vecchio gate, cioe' «nessuna modifica su Plex» su
        // un'operazione che invece a Plex ci ha parlato. Il riconoscimento e' ora solo esplicito.
        //
        // La funzione resta perche' `splitResyncDisabled` e' ancora nel catalogo dei messaggi
        // (M-14 in srv/lib/splitRules.js): se un domani un altro flusso lo emettesse, il cockpit
        // continuerebbe a renderlo con il suo testo invece che con quello generico.
        _isSplitResyncRejection(oResult) {
            return !!oResult && oResult.status === "W" && oResult.messageCode === "splitResyncDisabled";
        },

        _splitResyncMessage(oResult, sOrder) {
            const oBundle = this._getSplitBundle();
            const aParams = (oResult && Array.isArray(oResult.messageParams)) ? oResult.messageParams : [];
            if (aParams.length) {
                return this._splitResolveMessage(oResult);
            }
            const iCount = this._getSplitModel().getProperty("/packageCount") || 0;
            return oBundle.getText("splitResyncDisabled", [
                sOrder || this._sManufacturingOrder || "",
                String(iCount)
            ]) || (oResult && oResult.message) || "";
        },

        _splitStripType(oInfoData) {
            const sStatus = oInfoData && oInfoData.status;
            const sCode = oInfoData && oInfoData.messageCode;
            if (sStatus === "W") {
                return "Warning";
            }
            if (sStatus === "E") {
                // M-09 is informative: the job simply cannot be split any further
                return sCode === "splitNothingToSplit" ? "Information" : "Error";
            }
            return "Information";
        },

        // ================================================================
        // PACKAGES TAB
        // ================================================================

        onSplitRefresh() {
            this._loadSplitInfo();
        },

        // The remedy command of an anomalous row opens the window, which re-reads the state
        // and offers the command resolved by the server (FR-26, contract §3.5)
        onSplitFixPackage() {
            this.onOpenSplitDialog();
        },

        // ================================================================
        // FORMATTERS
        // ================================================================

        formatSplitStateText(sState) {
            if (!sState) {
                return "";
            }
            const oBundle = this._getSplitBundle();
            const sKey = "splitState" + sState;
            const sText = oBundle.getText(sKey);
            return (sText && sText !== sKey) ? sText : oBundle.getText("splitStateUnknown");
        },

        formatSplitStateState(sState) {
            switch (sState) {
                case "A": return "Success";
                case "I": return "Warning";
                case "L": return "Error";   // package to be linked: highest priority anomaly
                case "R": return "Error";   // quantity subtracted, no package
                case "U":
                case "P": return "Warning"; // uncertain outcome, to be verified
                default: return "None";     // 'X' closed, or unknown
            }
        },

        formatSplitStateIcon(sState) {
            switch (sState) {
                case "A": return "sap-icon://accept";
                case "I":
                case "L":
                case "R": return "sap-icon://alert";
                case "U":
                case "P": return "sap-icon://question-mark";
                case "X": return "sap-icon://decline";
                default: return "";
            }
        },

        formatSplitRemedyVisible(sState) {
            return sState === "L" || sState === "R" || sState === "U" || sState === "P";
        },

        formatSplitRemedyText(sState) {
            const oBundle = this._getSplitBundle();
            if (sState === "L") return oBundle.getText("dlgBtnSplitComplete");
            if (sState === "R") return oBundle.getText("dlgBtnSplitRestore");
            if (sState === "U" || sState === "P") return oBundle.getText("btnSplitVerify");
            return "";
        },

        formatSplitDateTime(vValue) {
            if (!vValue) {
                return "";
            }
            const oDate = vValue instanceof Date ? vValue : new Date(vValue);
            if (isNaN(oDate.getTime())) {
                return String(vValue);
            }
            if (!this._oSplitDateTimeFormat) {
                this._oSplitDateTimeFormat = DateFormat.getDateTimeInstance({
                    pattern: "dd MMM yyyy, HH:mm:ss"
                });
            }
            return this._oSplitDateTimeFormat.format(oDate);
        },

        // The due date comes from Plex as an ISO 8601 string (contract C-5): no time is
        // shown, because the due date does not carry one
        formatSplitDate(vValue) {
            if (!vValue) {
                return "";
            }
            const oDate = vValue instanceof Date ? vValue : new Date(vValue);
            if (isNaN(oDate.getTime())) {
                return String(vValue);
            }
            if (!this._oSplitDateFormat) {
                this._oSplitDateFormat = DateFormat.getDateInstance({ pattern: "dd MMM yyyy" });
            }
            return this._oSplitDateFormat.format(oDate);
        }
    };
});

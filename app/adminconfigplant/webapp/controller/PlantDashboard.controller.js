sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/Label",
    "sap/m/Input",
    "sap/m/Select",
    "sap/m/VBox",
    "sap/m/ColumnListItem",
    "sap/ui/core/Item"
], (Controller, MessageToast, MessageBox, Dialog, Button, Label, Input, Select, VBox, ColumnListItem, Item) => {
    "use strict";

    // [W1-23] Qui stava DEFAULT_PLANT_CONFIG, il template dei parametri di un plant appena creato
    // sul modello JSON 'plants' (= mockPlants.json). Era CODICE MORTO — dichiarato e mai letto — e
    // descriveva solo campi dimostrativi, spariti insieme alle schede che li mostravano. Il
    // customizing vero di un plant nasce VUOTO per scelta, una tabella alla volta: vedi
    // docs/CHECKLIST-CUSTOMIZING-PLANT.md per l'effetto dell'assenza di ognuna.

    return Controller.extend("avvaleplm.marsplm.sap2plex.adminconfigplant.controller.PlantDashboard", {

        onInit() {},

        onPlantTilePress(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext("catalog");
            const sPlantCode = oCtx.getProperty("PlantCode");

            this.getOwnerComponent().getRouter().navTo("plantConfig", {
                plantCode: sPlantCode
            });
        },

        onAddPlant() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            const oCodeInput = new Input({ placeholder: "e.g. 2010" });
            const oNameInput = new Input({ placeholder: "e.g. Dresden Plant" });

            const oDialog = new Dialog({
                title: oResourceBundle.getText("dlgAddPlantTitle"),
                contentWidth: "400px",
                content: [
                    new VBox({
                        class: "sapUiSmallMargin",
                        items: [
                            new Label({ text: oResourceBundle.getText("lblPlantCode"), required: true }),
                            oCodeInput,
                            new Label({ text: oResourceBundle.getText("lblPlantName"), required: true, class: "sapUiSmallMarginTop" }),
                            oNameInput
                        ]
                    })
                ],
                beginButton: new Button({
                    text: oResourceBundle.getText("btnCreate"),
                    type: "Emphasized",
                    press: () => {
                        const sCode = oCodeInput.getValue().trim().toUpperCase();
                        const sName = oNameInput.getValue().trim();

                        if (!sCode || !sName) {
                            MessageToast.show(oResourceBundle.getText("msgPlantFieldsRequired"));
                            return;
                        }
                        if (!/^[A-Z0-9]{1,4}$/.test(sCode)) {
                            MessageToast.show(oResourceBundle.getText("msgPlantCodeInvalid"));
                            return;
                        }

                        // New plants are created as InProgress; activation to 'Active' is a
                        // separate, license-gated step done from the Edit Status dialog.
                        const oListBinding = this.getView().getModel("catalog")
                            .bindList("/ZPlant", undefined, undefined, undefined, { $$updateGroupId: "$auto" });
                        const oCtx = oListBinding.create({
                            PlantCode: sCode,
                            PlantName: sName,
                            Status: "InProgress"
                        });
                        oCtx.created().then(() => {
                            MessageToast.show(oResourceBundle.getText("msgPlantCreated", [sCode]));
                            this._refreshTiles();
                            oDialog.close();
                        }).catch((err) => {
                            MessageBox.error((err && err.message) || oResourceBundle.getText("msgPlantCreateError"));
                        });
                    }
                }),
                endButton: new Button({
                    text: oResourceBundle.getText("btnCancel"),
                    press: () => {
                        oDialog.close();
                    }
                }),
                afterClose: () => {
                    oDialog.destroy();
                }
            });

            oDialog.open();
        },

        onEditStatus() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // Editable table bound to the ZPlant OData entity; status changes persist via $auto.
            const oTable = new sap.m.Table({
                items: {
                    path: "catalog>/ZPlant",
                    parameters: { $$updateGroupId: "$auto" },
                    template: new ColumnListItem({
                        cells: [
                            new Label({ text: "{catalog>PlantCode} - {catalog>PlantName}" }),
                            new Select({
                                // OneWay so the write happens only through onPlantStatusChange,
                                // whose setProperty promise lets us catch the license-gate 400.
                                selectedKey: "{ path: 'catalog>Status', mode: 'OneWay' }",
                                change: this.onPlantStatusChange.bind(this),
                                items: [
                                    new Item({ key: "Active", text: oResourceBundle.getText("statusActive") }),
                                    new Item({ key: "InProgress", text: oResourceBundle.getText("statusInProgress") }),
                                    new Item({ key: "Disabled", text: oResourceBundle.getText("statusDisabled") })
                                ]
                            })
                        ]
                    })
                },
                columns: [
                    new sap.m.Column({ header: new Label({ text: oResourceBundle.getText("lblPlantName") }) }),
                    new sap.m.Column({ header: new Label({ text: oResourceBundle.getText("lblStatus") }), width: "180px" })
                ]
            });

            const oDialog = new Dialog({
                title: oResourceBundle.getText("dlgEditStatusTitle"),
                contentWidth: "500px",
                content: [oTable],
                endButton: new Button({
                    text: oResourceBundle.getText("btnSave"),
                    press: () => {
                        oDialog.close();
                    }
                }),
                afterClose: () => {
                    this._refreshTiles();
                    oDialog.destroy();
                }
            });

            this.getView().addDependent(oDialog);
            oDialog.open();
        },

        // Persists a single plant status change immediately and surfaces the outcome.
        // When the server's license gate rejects the activation (Status -> 'Active' without a
        // valid license), the PATCH fails with 400: we show that message as a toast and revert
        // the dropdown to the previously persisted value.
        onPlantStatusChange(oEvent) {
            const oSelect = oEvent.getSource();
            const oCtx = oSelect.getBindingContext("catalog");
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const sPlant = oCtx.getProperty("PlantCode");
            const sOldStatus = oCtx.getProperty("Status");   // OneWay binding: model still holds the old value
            const sNewStatus = oSelect.getSelectedKey();

            if (sNewStatus === sOldStatus) {
                return;
            }

            oCtx.setProperty("Status", sNewStatus).then(() => {
                MessageToast.show(oResourceBundle.getText("msgStatusUpdated", [sPlant, this.formatStatusText(sNewStatus)]));
            }).catch((err) => {
                // In OData V4 a failed PATCH stays as a pending change (not auto-reverted),
                // so discard it to re-sync the model (and the tiles) to the persisted value.
                const oBinding = oCtx.getBinding();
                if (oBinding && oBinding.hasPendingChanges()) {
                    oBinding.resetChanges();
                }
                oSelect.setSelectedKey(sOldStatus);

                // Prefer the server message. If it arrives as a bare i18n key (a stale
                // server-side message cache can fail to resolve it), translate it locally
                // via the app's own bundle so the user never sees a raw key.
                let sMsg = err && err.message;
                if (sMsg && !/\s/.test(sMsg)) {
                    sMsg = oResourceBundle.getText(sMsg, [sPlant]);
                }
                MessageToast.show(sMsg || oResourceBundle.getText("msgStatusError", [sPlant]));
            });
        },

        onDeletePlant() {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // Step 0: pick which plant to delete (this dialog is NOT one of the confirmations).
            const oPlantSelect = new Select({ width: "100%", forceSelection: false });
            oPlantSelect.bindItems({
                path: "catalog>/ZPlant",
                template: new Item({
                    key: "{catalog>PlantCode}",
                    text: "{catalog>PlantCode} - {catalog>PlantName}"
                })
            });

            const oDialog = new Dialog({
                title: oResourceBundle.getText("dlgDeletePlantTitle"),
                contentWidth: "400px",
                content: [
                    new VBox({
                        class: "sapUiSmallMargin",
                        items: [
                            new Label({ text: oResourceBundle.getText("lblSelectPlantToDelete") }),
                            oPlantSelect
                        ]
                    })
                ],
                beginButton: new Button({
                    text: oResourceBundle.getText("btnContinue"),
                    type: "Reject",
                    press: () => {
                        const sPlant = oPlantSelect.getSelectedKey();
                        if (!sPlant) {
                            MessageToast.show(oResourceBundle.getText("msgNoPlantSelected"));
                            return;
                        }
                        oDialog.close();
                        this._confirmDeletePlant(sPlant);
                    }
                }),
                endButton: new Button({
                    text: oResourceBundle.getText("btnCancel"),
                    press: () => oDialog.close()
                }),
                afterClose: () => oDialog.destroy()
            });

            this.getView().addDependent(oDialog);
            oDialog.open();
        },

        // Confirmations 1 and 2: same question twice, but with the OK button in a
        // DIFFERENT position each time (left first, then right) to force a deliberate click.
        _confirmDeletePlant(sPlant) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // Confirmation 1 - OK on the LEFT (first action), and emphasized.
            MessageBox.warning(oResourceBundle.getText("msgDeleteConfirm1", [sPlant]), {
                title: oResourceBundle.getText("dlgDeletePlantTitle"),
                actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.OK,
                onClose: (sAction1) => {
                    if (sAction1 !== MessageBox.Action.OK) {
                        return;
                    }
                    // Confirmation 2 - OK on the RIGHT (last action); CANCEL is the default.
                    MessageBox.warning(oResourceBundle.getText("msgDeleteConfirm2", [sPlant]), {
                        title: oResourceBundle.getText("dlgDeletePlantTitle"),
                        actions: [MessageBox.Action.CANCEL, MessageBox.Action.OK],
                        emphasizedAction: MessageBox.Action.CANCEL,
                        onClose: (sAction2) => {
                            if (sAction2 !== MessageBox.Action.OK) {
                                return;
                            }
                            this._confirmDeleteByTyping(sPlant);
                        }
                    });
                }
            });
        },

        // Confirmation 3: the user must type DELETE to enable the final button.
        _confirmDeleteByTyping(sPlant) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const sKeyword = "DELETE";

            const oConfirmButton = new Button({
                text: oResourceBundle.getText("btnDelete"),
                type: "Reject",
                enabled: false,
                press: () => {
                    oTypeDialog.close();
                    this._executeDeletePlant(sPlant);
                }
            });

            const oInput = new Input({
                placeholder: sKeyword,
                liveChange: (oEvt) => {
                    oConfirmButton.setEnabled(oEvt.getParameter("value").trim() === sKeyword);
                }
            });

            const oTypeDialog = new Dialog({
                title: oResourceBundle.getText("dlgDeleteTypeTitle"),
                state: "Error",
                contentWidth: "440px",
                content: [
                    new VBox({
                        class: "sapUiSmallMargin",
                        items: [
                            new Label({ text: oResourceBundle.getText("lblTypeDeleteToConfirm", [sPlant]) }),
                            oInput
                        ]
                    })
                ],
                beginButton: oConfirmButton,
                endButton: new Button({
                    text: oResourceBundle.getText("btnCancel"),
                    press: () => oTypeDialog.close()
                }),
                afterClose: () => oTypeDialog.destroy()
            });

            this.getView().addDependent(oTypeDialog);
            oTypeDialog.open();
        },

        // Calls the backend deletePlant action, which cascades the delete across every
        // per-plant table in one transaction and returns the number of rows removed.
        _executeDeletePlant(sPlant) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            const oModel = this.getView().getModel("catalog");
            const oAction = oModel.bindContext("/deletePlant(...)", undefined, { $$groupId: "$auto" });
            oAction.setParameter("PlantCode", sPlant);

            oAction.execute().then(() => {
                const oResult = oAction.getBoundContext().getObject();
                const iDeleted = (oResult && oResult.deleted) || 0;
                MessageToast.show(oResourceBundle.getText("msgPlantDeleted", [sPlant, iDeleted]));
                this._refreshTiles();
            }).catch((err) => {
                MessageBox.error((err && err.message) || oResourceBundle.getText("msgDeleteError"));
            });
        },

        _refreshTiles() {
            const oTiles = this.byId("tilesContainer");
            const oBinding = oTiles && oTiles.getBinding("items");
            if (oBinding) {
                oBinding.refresh();
            }
        },

        formatTileState(sStatus) {
            if (sStatus === "Active") return "Loaded";
            if (sStatus === "InProgress") return "Loaded";
            if (sStatus === "Disabled") return "Loaded";
            return "Loaded";
        },

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

        formatIconColor(sStatus) {
            if (sStatus === "Active") return "#107E3E";
            if (sStatus === "InProgress") return "#E9730C";
            if (sStatus === "Disabled") return "#89919A";
            return "#89919A";
        }
    });
});

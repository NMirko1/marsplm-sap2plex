sap.ui.define([
    "sap/ui/core/mvc/Controller"
], (Controller) => {
    "use strict";

    return Controller.extend("avvaleplm.marsplm.sap2plex.main.controller.App", {
        onInit() {
            const oI18nModel = this.getOwnerComponent().getModel("i18n");
            const vBundle = oI18nModel.getResourceBundle();
            if (vBundle instanceof Promise) {
                vBundle.then((oBundle) => {
                    document.title = oBundle.getText("appTitle");
                });
            } else {
                document.title = vBundle.getText("appTitle");
            }
        }
    });
});
sap.ui.define([
    "sap/ui/core/UIComponent",
    "avvaleplm/marsplm/sap2plex/adminconfigplant/model/models",
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/SessionGuard",
    // [APP-URL] La base dell'app: serve al ping del keep-alive, che da Work Zone senza prefisso
    // arriva alla radice del launchpad e non tocca nessuna sessione.
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/AppUrl"
], (UIComponent, models, SessionGuard, AppUrl) => {
    "use strict";

    return UIComponent.extend("avvaleplm.marsplm.sap2plex.adminconfigplant.Component", {
        metadata: {
            manifest: "json",
            interfaces: [
                "sap.ui.core.IAsyncContentCreation"
            ]
        },

        init() {
            UIComponent.prototype.init.apply(this, arguments);

            // [SESSION-401] Qui la guardia conta piu' che altrove: le tabelle di questa app sono
            // binding OData V4 in scrittura, e finche' `submitBatch` non passa le righe stanno SOLO
            // nel modello. Un reload su `401` le porterebbe via — e il `401` arriva proprio sul
            // Salva, che e' la prima chiamata dopo la finestra di inattivita'.
            SessionGuard.install({
                component: this,
                bundle: this.getModel("i18n").getResourceBundle(),
                // [APP-URL] Questa app si apre da Work Zone, dove il ping deve portare il prefisso.
                urlOf: AppUrl.url
            });

            this.setModel(models.createDeviceModel(), "device");
            this.getRouter().initialize();
        }
    });
});

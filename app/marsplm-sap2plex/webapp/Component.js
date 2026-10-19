sap.ui.define([
    "sap/ui/core/UIComponent",
    "avvaleplm/marsplm/sap2plex/main/model/models",
    "avvaleplm/marsplm/sap2plex/main/util/SessionGuard",
    // [APP-URL] La base dell'app: serve al ping del keep-alive, che da Work Zone senza prefisso
    // arriva alla radice del launchpad e non tocca nessuna sessione.
    "avvaleplm/marsplm/sap2plex/main/util/AppUrl"
], (UIComponent, models, SessionGuard, AppUrl) => {
    "use strict";

    return UIComponent.extend("avvaleplm.marsplm.sap2plex.main.Component", {
        metadata: {
            manifest: "json",
            interfaces: [
                "sap.ui.core.IAsyncContentCreation"
            ]
        },

        init() {
            // call the base component's init function
            UIComponent.prototype.init.apply(this, arguments);

            // [SESSION-401] La sessione dell'approuter scade per inattivita' (default 15 minuti) e
            // da li' in poi ogni chiamata risponde `401`. Senza questa guardia l'utente vedeva un
            // errore tecnico; con essa la scadenza si dichiara, il lavoro non salvato non si perde,
            // e finche' sta lavorando la sessione non scade affatto. Va PRIMA di `initialize()`,
            // perche' il router fa partire subito le prime letture.
            SessionGuard.install({
                component: this,
                bundle: this.getModel("i18n").getResourceBundle(),
                // [APP-URL] Questa app si apre da Work Zone, dove il ping deve portare il prefisso.
                urlOf: AppUrl.url
            });

            // set the device model
            this.setModel(models.createDeviceModel(), "device");

            // enable routing
            this.getRouter().initialize();
        }
    });
});

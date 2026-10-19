sap.ui.define(
    [
        "sap/fe/core/AppComponent",
        "avvaleplm/marsplm/sap2plex/adminconfigmatfil/util/SessionGuard"
    ],
    function (Component, SessionGuard) {
        "use strict";

        return Component.extend("avvaleplm.marsplm.sap2plex.adminconfigmatfil.Component", {
            metadata: {
                manifest: "json"
            },

            init: function () {
                Component.prototype.init.apply(this, arguments);

                // [SESSION-401] La sessione dell'approuter scade per inattivita' (default 15
                // minuti) e da li' in poi ogni chiamata risponde `401`. La guardia lo dichiara
                // invece di lasciare l'errore tecnico, non ricarica mai con modifiche pendenti nel
                // modello, e finche' l'utente lavora tiene viva la sessione.
                SessionGuard.install({ component: this });
            }
        });
    }
);

sap.ui.define([
    "sap/m/ComboBox",
    "sap/m/ComboBoxRenderer",
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/comboBoxContains"
], (ComboBox, ComboBoxRenderer, containsFilter) => {
    "use strict";

    /**
     * [COMBO-CONTAINS] `sap.m.ComboBox` che cerca per SOTTOSTRINGA invece che per prefisso.
     *
     * Perche' un controllo e non un `setFilterFunction` dal controller: sette degli undici
     * ComboBox di questa schermata stanno dentro un `ColumnListItem`, che UI5 CLONA per ogni
     * riga. Quei cloni non hanno `id`, nascono e muoiono mentre la tabella cresce, e un
     * aggancio dal controller andrebbe rifatto a ogni `updateFinished` e per indice di cella.
     * Nel costruttore invece vale per ogni istanza, presente e futura, e nel fragment la
     * modifica e' il nome del tag.
     *
     * Cambia SOLO il filtro dei suggerimenti: nessuna proprieta', nessun evento, nessuna
     * differenza di rendering. Chi lo usa vede l'API di `sap.m.ComboBox`.
     */
    return ComboBox.extend("avvaleplm.marsplm.sap2plex.adminconfigplant.control.SearchComboBox", {

        // Si disegna esattamente come un `sap.m.ComboBox`: il renderer del padre, delegato per
        // esteso invece che ereditato in silenzio, cosi' un `apiVersion` disallineato si vede qui.
        renderer: {
            apiVersion: 2,
            render(oRm, oControl) {
                ComboBoxRenderer.render(oRm, oControl);
            }
        },

        init(...aArgs) {
            ComboBox.prototype.init.apply(this, aArgs);
            this.setFilterFunction(containsFilter);
        }
    });
});

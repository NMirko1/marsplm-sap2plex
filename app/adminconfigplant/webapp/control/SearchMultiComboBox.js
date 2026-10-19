sap.ui.define([
    "sap/m/MultiComboBox",
    "sap/m/MultiComboBoxRenderer",
    "avvaleplm/marsplm/sap2plex/adminconfigplant/util/comboBoxContains"
], (MultiComboBox, MultiComboBoxRenderer, containsFilter) => {
    "use strict";

    /**
     * [COMBO-CONTAINS] Gemello di `SearchComboBox` per la selezione multipla.
     *
     * `setFilterFunction` sta su `sap.m.ComboBoxBase`, quindi la stessa regola vale per
     * entrambi; sono due classi e non una perche' le gerarchie di UI5 divergono qui sotto.
     * Le due voci in esercizio (stati d'ordine richiesti ed esclusi) hanno
     * `showSecondaryValues="true"`, quindi la nota accanto allo stato e' testo visibile ed e'
     * cercabile — vedi il commento in `util/comboBoxContains.js`.
     */
    return MultiComboBox.extend("avvaleplm.marsplm.sap2plex.adminconfigplant.control.SearchMultiComboBox", {

        renderer: {
            apiVersion: 2,
            render(oRm, oControl) {
                MultiComboBoxRenderer.render(oRm, oControl);
            }
        },

        init(...aArgs) {
            MultiComboBox.prototype.init.apply(this, aArgs);
            this.setFilterFunction(containsFilter);
        }
    });
});

sap.ui.define([], () => {
    "use strict";

    /**
     * [COMBO-CONTAINS] Filtro dei suggerimenti di un ComboBox: la stringa digitata ovunque
     * nella voce, non solo in testa.
     *
     * UI5 filtra i suggerimenti con `ComboBoxBase.DEFAULT_TEXT_FILTER`, che e' un match sul
     * PREFISSO del testo. Su un elenco dove la parte riconoscibile e' il nome e non il codice —
     * le operazioni Plex sono «CODICE - Nome», e chi cerca ricorda `Sacco`, non `L100` —
     * quel filtro non trova niente: `V09` trovava `V090-Sgrassaggio+Veniciatura`, `90` no.
     *
     * Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, cosi' la regola si
     * collauda da node (`node test/comboBoxContains.test.js`) come i moduli puri di `srv/lib/`.
     *
     * @param {string} sValue testo digitato dall'utente
     * @param {sap.ui.core.Item} oItem voce dell'elenco
     * @returns {boolean} `true` se la voce va mostrata
     */
    return function containsFilter(sValue, oItem) {
        const sQuery = String(sValue || "").trim().toLowerCase();
        if (!sQuery) {
            // Niente digitato: l'elenco resta intero. UI5 non chiama il filtro a valore vuoto,
            // ma un filtro che rispondesse `false` qui svuoterebbe la tenda a ogni apertura.
            return true;
        }
        if (!oItem || typeof oItem.getText !== "function") {
            return false;
        }
        const sText = String(oItem.getText() || "").toLowerCase();
        if (sText.indexOf(sQuery) !== -1) {
            return true;
        }
        // Il testo secondario si cerca SOLO dove esiste. In quest'app ogni `core:ListItem` con
        // `additionalText` sta su un controllo con `showSecondaryValues="true"`, quindi e' testo
        // che l'utente VEDE: cercare in cio' che non si vede farebbe comparire voci senza una
        // ragione visibile. Le `core:Item` non hanno il getter e non entrano da questa parte.
        if (typeof oItem.getAdditionalText !== "function") {
            return false;
        }
        const sAdditional = String(oItem.getAdditionalText() || "").toLowerCase();
        return !!sAdditional && sAdditional.indexOf(sQuery) !== -1;
    };
});

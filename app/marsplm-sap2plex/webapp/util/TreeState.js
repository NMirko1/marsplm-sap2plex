sap.ui.define([], function () {
    "use strict";

    /**
     * [TREE-STATE] L'albero ricorda i nodi che l'utente ha CHIUSO, per identita'.
     *
     * Ogni modifica dell'albero riscrive l'INTERO array `/nodes` del JSONModel — e deve farlo:
     * `cssClass`/`iconClass` sono legati all'attributo `class` del template, che UI5 risolve alla
     * COSTRUZIONE dell'elemento, quindi un aggiornamento in posto lascerebbe il barrato
     * dell'orfano e la puntina della collocazione manuale come stavano. Riseminare l'array
     * azzera pero' anche lo stato di espansione, e il rimedio era un `expandToLevel(n)` senza
     * condizioni: chi aveva chiuso dei nodi se li vedeva riaprire tutti a ogni gesto.
     *
     * Qui lo stato e' un INSIEME DI CHIAVI dei nodi che l'utente ha chiuso. Un nodo che non e' nel
     * set e' aperto — quindi un'operazione nuova nasce aperta e un nodo sparito non lascia
     * residui. La chiave e' l'IDENTITA' del nodo e non la sua posizione: dopo un riordino la
     * chiusura segue l'operazione che si e' spostata.
     *
     * Lo stato si raccoglie dall'evento `toggleOpenState` di `sap.m.Tree`, che UI5 emette SOLO
     * sull'interazione dell'utente (`onItemExpanderPressed`) e sull'apertura automatica del nodo
     * sorvolato durante un trascinamento (`onItemLongDragOver`): `expandToLevel` e `collapse`
     * programmatici NON lo emettono, quindi il ripristino non inquina il set.
     *
     * Nessuna dipendenza, di proposito: e' l'unica forma di modulo UI5 che `test/treeState.test.js`
     * puo' eseguire da node senza simulare il loader.
     */

    /** Nodi che nessuna chiave identifica: restano sempre aperti, cioe' il comportamento di prima. */
    var ROOT_KEY = "#root";

    /**
     * La chiave di un'operazione. LA COMPOSIZIONE VIVE QUI E BASTA: se il punto che ricorda e
     * quello che ripristina la componessero da soli, potrebbero divergere in silenzio e la
     * chiusura resterebbe appiccicata al nodo sbagliato. Per questo gli estrattori qui sotto
     * passano da questa funzione invece di concatenare da se'.
     *
     * @param {string} sId identificativo dell'operazione
     * @returns {string|null} chiave, oppure `null` se l'id non c'e'
     */
    function opKey(sId) {
        return sId ? ("op:" + sId) : null;
    }

    function nodeOf(oItem, sModel) {
        var oCtx = oItem && oItem.getBindingContext(sModel);
        return oCtx ? oCtx.getObject() : null;
    }

    return {

        ROOT_KEY: ROOT_KEY,

        opKey: opKey,

        /**
         * Chiave di un nodo dell'albero PLEX. I componenti sono foglie: non si chiudono, quindi
         * non hanno chiave.
         */
        plexKey: function (oNode) {
            if (!oNode) { return null; }
            if (oNode.nodeType === "plexOperation") {
                return opKey(oNode._key);
            }
            return oNode.nodes ? ROOT_KEY : null;
        },

        /**
         * Chiave di un nodo dell'albero SAP. `_sapOperationId` e' gia' l'identita' con cui il
         * collegamento operazioni riconosce la riga (`_updateSapTreeLinkStates`).
         */
        sapKey: function (oNode) {
            if (!oNode) { return null; }
            if (oNode.nodeType === "operation") {
                return opKey(oNode._sapOperationId);
            }
            return oNode.nodes ? ROOT_KEY : null;
        },

        /**
         * Registra l'apertura o la chiusura fatta dall'utente.
         *
         * @param {Set} oSet insieme delle chiavi chiuse
         * @param {sap.ui.base.Event} oEvent evento `toggleOpenState`
         * @param {function} fnKey estrattore di chiave (`plexKey` / `sapKey`)
         */
        remember: function (oSet, oEvent, fnKey) {
            if (!oSet || !oEvent) { return; }
            var oCtx = oEvent.getParameter("itemContext");
            if (!oCtx) { return; }
            var sKey = fnKey(oCtx.getObject());
            if (!sKey) { return; }
            if (oEvent.getParameter("expanded")) {
                oSet.delete(sKey);
            } else {
                oSet.add(sKey);
            }
        },

        /** Dimentica una chiusura: il nodo tornera' aperto al prossimo ripristino. */
        forget: function (oSet, sKey) {
            if (oSet && sKey) { oSet.delete(sKey); }
        },

        /**
         * Riapre l'albero fino al livello chiesto e RICHIUDE i soli nodi che l'utente aveva chiuso.
         *
         * `expandToLevel` azzera lo stato manuale del binding, quindi il punto di partenza e'
         * sempre lo stesso: da li' si richiude per chiave. `collapse` accetta un array, scarta gli
         * indici non validi e le foglie e collassa dall'indice piu' alto al piu' basso
         * sopprimendo gli eventi intermedi — una sola chiamata, un solo ridisegno.
         *
         * Con l'insieme vuoto il comportamento e' identico a quello di prima.
         *
         * @param {sap.m.Tree} oTree albero
         * @param {Set} oSet insieme delle chiavi chiuse
         * @param {function} fnKey estrattore di chiave
         * @param {int} iLevel livello fino a cui riaprire
         */
        restore: function (oTree, oSet, fnKey, iLevel) {
            if (!oTree) { return; }
            oTree.expandToLevel(iLevel);
            if (!oSet || !oSet.size) { return; }

            var oInfo = oTree.getBindingInfo("items");
            var sModel = oInfo && oInfo.model;
            var aItems = oTree.getItems() || [];
            var aIndices = [];
            for (var i = 0; i < aItems.length; i++) {
                var sKey = fnKey(nodeOf(aItems[i], sModel));
                if (sKey && oSet.has(sKey)) { aIndices.push(i); }
            }
            if (aIndices.length) { oTree.collapse(aIndices); }
        }
    };
});

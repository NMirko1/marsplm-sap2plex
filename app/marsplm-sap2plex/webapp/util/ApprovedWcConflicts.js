/**
 * [W1-08] Un work center su una sola operazione — lato client (BBP §7.6.2).
 *
 * Gemello di srv/lib/approvedWcRules.js, condiviso dai due editor che assegnano work center
 * approvati: RoutingDetail (il ciclo di una part) e RoutingTemplateDetail (il template). Il
 * popover dei work center e' lo stesso fragment per entrambi, e la regola da applicare e' la
 * stessa: quello che cambia e' solo l'insieme di operazioni da guardare.
 *
 * L'AUTORITA' RESTA IL SERVER. Qui si evita che il conflitto si scopra al salvataggio, dopo che
 * l'utente ha costruito il ciclo — non si sostituisce la validazione: `saveRoutingPlexCycle` e
 * `saveRoutingTemplate` rifiutano comunque, e sono l'unico punto che una POST OData non puo'
 * scavalcare (le due proiezioni dei work center sono `@readonly` per questo). Se le due parti
 * dovessero divergere, quella giusta e' il server.
 *
 * Nessuna dipendenza UI5: e' aritmetica su array.
 */
sap.ui.define([], function () {
    "use strict";

    /**
     * Chiave di CONFRONTO di un work center: trim e maiuscolo, come `wcKey` del modulo server.
     * Normalizza solo per confrontare — il valore che si salva non viene toccato.
     */
    function wcKey(sValue) {
        if (sValue === null || sValue === undefined) return "";
        return String(sValue).trim().toUpperCase();
    }

    /**
     * Etichetta leggibile di un'operazione: codice, nome, numero, id — in questo ordine. Qualcosa
     * esce sempre, perche' un messaggio che non dice QUALE operazione tiene il work center non e'
     * azionabile. Stessi ripieghi di `operationLabel` del modulo server.
     */
    function operationLabel(oOp) {
        if (!oOp) return "";
        var sCode = String(oOp.OperationCode || "").trim();
        if (sCode) return sCode;
        var sName = String(oOp.OperationName || "").trim();
        if (sName) return sName;
        if (oOp.OperationNumber !== null && oOp.OperationNumber !== undefined && oOp.OperationNumber !== "") {
            return "#" + oOp.OperationNumber;
        }
        return String(oOp.PlexOperationId || "").trim();
    }

    /**
     * Mappa «work center -> etichetta dell'operazione che lo tiene» costruita sulle operazioni
     * DIVERSE da quella che si sta modificando.
     *
     * L'esclusione per INDICE e non per PlexOperationId: l'indice e' cio' che il popover conosce
     * (`this._iWcOpIndex`), ed e' l'unico riferimento affidabile — la stessa operazione Plex non
     * puo' comparire due volte nell'albero, ma non e' questo modulo a garantirlo.
     *
     * @param {Array} aOperations `this._aPlexOperations` del controller
     * @param {int} iExcludeIndex indice dell'operazione in modifica
     * @returns {Object} mappa chiave work center -> etichetta operazione
     */
    function holdersByWorkcenter(aOperations, iExcludeIndex) {
        var mHolders = {};
        (aOperations || []).forEach(function (oOp, i) {
            if (!oOp || i === iExcludeIndex) return;
            var sLabel = operationLabel(oOp);
            (oOp.approvedWorkcenters || []).forEach(function (oWc) {
                if (!oWc) return;
                var sKey = wcKey(oWc.WorkcenterId);
                // Vince la prima: e' l'operazione che il messaggio nominera', ed e' la stessa
                // scelta del modulo server, quindi i due lati raccontano la stessa cosa.
                if (sKey && !mHolders[sKey]) mHolders[sKey] = sLabel;
            });
        });
        return mHolders;
    }

    /**
     * I work center in conflitto fra quelli selezionati nel popover.
     *
     * @param {Array} aSelected work center selezionati, [{WorkcenterId, WorkcenterCode, ...}]
     * @param {Object} mHolders mappa da `holdersByWorkcenter`
     * @returns {Array} [{ wcLabel, holderLabel }] — [] quando la selezione e' valida
     */
    function conflictsOf(aSelected, mHolders) {
        return (aSelected || []).reduce(function (aOut, oWc) {
            if (!oWc) return aOut;
            var sHolder = mHolders[wcKey(oWc.WorkcenterId)];
            if (sHolder) {
                aOut.push({
                    wcLabel: String(oWc.WorkcenterCode || oWc.WorkcenterName || oWc.WorkcenterId || "").trim(),
                    holderLabel: sHolder
                });
            }
            return aOut;
        }, []);
    }

    return {
        wcKey: wcKey,
        operationLabel: operationLabel,
        holdersByWorkcenter: holdersByWorkcenter,
        conflictsOf: conflictsOf
    };
});

/**
 * [TEMPLATE-GROUP] Un gruppo oggetti su una sola operazione del template — lato client.
 *
 * Gemello di srv/lib/templateGroupRules.js, e gemello di struttura di util/ApprovedWcConflicts.js,
 * che risolve lo stesso problema per i work center. Serve al popover dei gruppi dell'editor dei
 * template: marcare il conflitto PRIMA di scegliere, invece di farlo uscire al salvataggio quando
 * l'albero e' gia' stato costruito.
 *
 * L'AUTORITA' RESTA IL SERVER. `saveRoutingTemplate` rifiuta comunque, ed e' l'unico punto che una
 * POST OData non puo' scavalcare (la proiezione dei gruppi e' `@readonly` per questo). Se le due
 * parti divergessero, quella giusta e' il server.
 *
 * LA CHIAVE DI CONFRONTO E' STRETTA, e qui `ApprovedWcConflicts` NON si imita: la' si piega il
 * caso perche' i due lati sono GUID scritti da Plex; qui sono codici nostri, e `g1` e `G1` possono
 * essere due righe diverse di `ZObjectGroup`. Piegare il caso fonderebbe due gruppi distinti, cioe'
 * marcherebbe come conflitto una configurazione corretta. La stessa riga sta nel modulo server, e
 * le due devono restare d'accordo.
 *
 * TERZA FUNZIONE CHE IL GEMELLO DEI WORK CENTER NON HA: `buildList`. L'elenco del popover non e'
 * solo «i gruppi del plant»: e' quello PIU' i codici gia' salvati su questo template che nel
 * customizing non ci sono piu'. Senza, aprire il popover su un'operazione che ne porta uno e
 * premere Conferma lo perderebbe in silenzio, perche' la conferma riscrive la collezione da cio'
 * che e' selezionato nell'elenco. E' la regola di DEC-132: vuoto non e' ignoto.
 *
 * Nessuna dipendenza UI5: e' aritmetica su array.
 */
sap.ui.define([], function () {
    "use strict";

    /**
     * Chiave di CONFRONTO di un gruppo: il solo trim. Il caso NON si piega — vedi l'intestazione.
     * Normalizza solo per confrontare: il valore che si salva non passa da qui.
     */
    function groupKey(sValue) {
        if (sValue === null || sValue === undefined) return "";
        return String(sValue).trim();
    }

    /**
     * Etichetta leggibile di un'operazione: codice, nome, numero, id — in questo ordine. Qualcosa
     * esce sempre, perche' un messaggio che non dice QUALE operazione tiene il gruppo non e'
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
     * Mappa «gruppo -> etichetta dell'operazione che lo tiene», costruita sulle operazioni DIVERSE
     * da quella che si sta modificando.
     *
     * L'esclusione e' per INDICE e non per `PlexOperationId`: l'indice e' cio' che il popover
     * conosce, ed e' l'unico riferimento affidabile.
     *
     * @param {Array} aOperations `this._aPlexOperations` del controller
     * @param {int} iExcludeIndex indice dell'operazione in modifica
     * @returns {Object} mappa codice gruppo -> etichetta operazione
     */
    function holdersByGroup(aOperations, iExcludeIndex) {
        var mHolders = {};
        (aOperations || []).forEach(function (oOp, i) {
            if (!oOp || i === iExcludeIndex) return;
            var sLabel = operationLabel(oOp);
            (oOp.objectGroups || []).forEach(function (sGroupId) {
                var sKey = groupKey(sGroupId);
                // Vince la prima: e' l'operazione che il messaggio nominera', ed e' la stessa
                // scelta del modulo server, quindi i due lati raccontano la stessa cosa.
                if (sKey && !mHolders[sKey]) mHolders[sKey] = sLabel;
            });
        });
        return mHolders;
    }

    /**
     * I gruppi in conflitto fra quelli selezionati nel popover.
     *
     * @param {Array} aSelected codici selezionati
     * @param {Object} mHolders mappa da `holdersByGroup`
     * @returns {Array} [{ groupLabel, holderLabel }] — [] quando la selezione e' valida
     */
    function conflictsOf(aSelected, mHolders) {
        return (aSelected || []).reduce(function (aOut, sGroupId) {
            var sKey = groupKey(sGroupId);
            var sHolder = sKey && mHolders[sKey];
            if (sHolder) {
                aOut.push({ groupLabel: sKey, holderLabel: sHolder });
            }
            return aOut;
        }, []);
    }

    /**
     * L'elenco del popover: i gruppi configurati del plant, piu' in CODA i codici gia' salvati su
     * questa operazione che fra quelli non compaiono.
     *
     * La coda si ricostruisce da zero a ogni chiamata — il popover si riapre su ogni operazione — e
     * i codici vuoti non entrano. Le voci in coda NON portano descrizione: non c'e' nessuno da cui
     * leggerla, ed e' proprio l'informazione che l'etichetta di «non configurato» sostituisce.
     *
     * @param {Array} aAllGroups gruppi del plant, [{GroupId, Description}]
     * @param {Array} aCurrentCodes codici gia' assegnati a questa operazione
     * @param {Object} mHolders mappa da `holdersByGroup`
     * @param {function} fnUnknownText da un codice al suo testo di «non configurato»
     * @param {function} fnHolderText da un'etichetta di operazione al testo «gia' su ...»
     * @returns {Array} voci per la lista del popover
     */
    function buildList(aAllGroups, aCurrentCodes, mHolders, fnUnknownText, fnHolderText) {
        var aCurrent = (aCurrentCodes || []).map(groupKey).filter(Boolean);
        var oKnown = {};
        var aOut = [];

        (aAllGroups || []).forEach(function (oGroup) {
            if (!oGroup) return;
            var sKey = groupKey(oGroup.GroupId);
            if (!sKey || oKnown[sKey]) return;
            oKnown[sKey] = true;
            var sHolder = mHolders && mHolders[sKey];
            aOut.push({
                groupId: sKey,
                description: String(oGroup.Description || "").trim(),
                selected: aCurrent.indexOf(sKey) !== -1,
                unknown: false,
                infoText: sHolder && fnHolderText ? fnHolderText(sHolder) : "",
                infoState: sHolder ? "Warning" : "None"
            });
        });

        aCurrent.forEach(function (sKey) {
            if (oKnown[sKey]) return;
            oKnown[sKey] = true;
            aOut.push({
                groupId: sKey,
                description: fnUnknownText ? fnUnknownText(sKey) : "",
                // Selezionata: e' assegnata a questa operazione, e deselezionarla deve essere un
                // gesto, non l'effetto di averla aperta.
                selected: true,
                unknown: true,
                infoText: "",
                infoState: "None"
            });
        });

        return aOut;
    }

    return {
        groupKey: groupKey,
        operationLabel: operationLabel,
        holdersByGroup: holdersByGroup,
        conflictsOf: conflictsOf,
        buildList: buildList
    };
});

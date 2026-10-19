sap.ui.define([], function () {
    "use strict";

    // ================================================================
    // [ROUTE-KEY] La ROTTA e' l'oggetto; il modello e' una cache da validare (feature 0041).
    //
    // PERCHE' ESISTE. Le tre schermate di dettaglio del cockpit riempiono il proprio modello con la
    // riga cliccata in lista, messa da parte sul Component (`_selectedProduct`, `_selectedProdOrder`,
    // `_selectedRouting`), e NON la confrontavano mai con i parametri di rotta. Nel percorso normale
    // i due coincidono, perche' il click scrive la riga un istante prima di navigare. Ma il Component
    // non azzera niente e nessuno verifica niente: bastava che la rotta cambiasse senza passare da un
    // click — un link, un segnalibro, la cronologia — perche' la schermata mostrasse un oggetto e le
    // sue azioni ne scrivessero un altro.
    //
    // Sul dettaglio materiale il danno era concreto: «Invia a Plex» prendeva materiale e plant dal
    // MODELLO, e il plant sceglie il TENANT Plex su cui si scrive (una connessione per plant).
    // Scrivere sulla part di un altro stabilimento non produce nessun errore: Plex risponde 200.
    //
    // IL CONFRONTO E' QUELLO DI `CompSource.matKey`, e non e' una coincidenza: tollerante su spazi e
    // grafia, STRETTO sugli zeri iniziali. Entrambi i lati vengono da SAP — l'URL porta la chiave che
    // una nostra lista ha emesso — quindi allineare `0001` e `1` maschererebbe un difetto a monte
    // (DEC-51). Un test verifica la parita' fra le due funzioni: due definizioni di «stesso codice
    // SAP» che divergono sono il difetto.
    //
    // [DETAIL-REREAD] E POI SI RILEGGE. `check` dice se una riga e' l'oggetto chiesto; `pick` dice
    // QUALE, fra le righe di una rilettura, lo e' — perche' dichiarare «non e' quella» e fermarsi
    // lascia a schermo il vuoto, che non e' una risposta. Le due funzioni stanno insieme perche'
    // condividono il confronto: allinearne una sola sarebbe il difetto.
    //
    // Nessuna dipendenza: `sap.ui.define([])`, come `util/MatLogFilter.js` e `util/LogLanguage.js`.
    // E' anche l'unica forma che i test di questo repo sanno eseguire.
    // Test: `node test/routeStash.test.js`.
    // ================================================================

    /** Perche' lo stash non e' utilizzabile. Sono quattro cose diverse, con rimedi diversi. */
    var REASON = {
        OK: "OK",
        NO_KEYS: "NO_KEYS",     // il chiamante non ha passato le chiavi di rotta: difetto di codice
        NO_STASH: "NO_STASH",   // non c'e' niente da parte: e' il caso NORMALE dopo un F5
        MISSING: "MISSING",     // la riga non porta un campo chiave: non VERIFICABILE
        MISMATCH: "MISMATCH"    // la riga e' di un ALTRO oggetto: prova positiva
    };

    /** Chiave di confronto fra due valori SAP: `trim` e maiuscole, MAI un allineamento di zeri. */
    function keyPart(vValue) {
        if (vValue === null || vValue === undefined) return "";
        return String(vValue).trim().toUpperCase();
    }

    /**
     * La riga messa da parte e' davvero l'oggetto che la rotta nomina?
     *
     * L'ORDINE DEI CONTROLLI CONTA. `NO_KEYS` si valuta per PRIMO, anche quando lo stash c'e': un
     * chiamante che dimentica le chiavi otterrebbe altrimenti un «si'» senza aver confrontato
     * niente, ed e' l'unico modo in cui questa guardia puo' evaporare in silenzio su tutte e tre le
     * schermate senza che cambi nulla di visibile.
     *
     * `MISSING` e `MISMATCH` restano DISTINTI perche' hanno rimedi diversi: il primo e' assenza di
     * prova (una proiezione che non espone quel campo), il secondo e' la prova che la riga e' di un
     * altro oggetto. Chi chiama puo' decidere di bloccare solo sul secondo.
     *
     * `expected` e `actual` portano i valori GREZZI, non normalizzati: un messaggio che dicesse
     * `1` contro `1` mentre i valori sono `0001` e `1` nasconderebbe proprio la differenza che sta
     * segnalando.
     *
     * @param {object} oRow riga stashata, oppure riga riletta dal server
     * @param {object} oRouteKeys `{ NomeCampo: valoreDallaRotta, … }`
     * @returns {{usable: boolean, reason: string, field: string, expected: string, actual: string}}
     */
    function check(oRow, oRouteKeys) {
        var oOut = { usable: false, reason: REASON.NO_KEYS, field: "", expected: "", actual: "" };

        var aFields = (oRouteKeys && typeof oRouteKeys === "object") ? Object.keys(oRouteKeys) : [];
        if (!aFields.length) return oOut;

        if (!oRow || typeof oRow !== "object" || Array.isArray(oRow)) {
            oOut.reason = REASON.NO_STASH;
            return oOut;
        }

        for (var i = 0; i < aFields.length; i++) {
            var sField = aFields[i];
            var vActual = oRow[sField];
            if (vActual === undefined || vActual === null) {
                oOut.reason = REASON.MISSING;
                oOut.field = sField;
                oOut.expected = String(oRouteKeys[sField] === undefined ? "" : oRouteKeys[sField]);
                return oOut;
            }
            if (keyPart(vActual) !== keyPart(oRouteKeys[sField])) {
                oOut.reason = REASON.MISMATCH;
                oOut.field = sField;
                oOut.expected = String(oRouteKeys[sField] === undefined ? "" : oRouteKeys[sField]);
                oOut.actual = String(vActual);
                return oOut;
            }
        }

        oOut.usable = true;
        oOut.reason = REASON.OK;
        return oOut;
    }

    /**
     * [DETAIL-REREAD] La riga chiesta, fra quelle di una lettura di COLLECTION — MAI per posizione.
     *
     * PERCHE' ESISTE. Il ripiego di una scheda di dettaglio non puo' prendere `rows[0]`: e' quello
     * che faceva il dettaglio ciclo con `$filter` + `$top=1`, e su un handler che tratta le
     * uguaglianze come una ricerca tollerante quella prima riga e' un ALTRO materiale dello stesso
     * gruppo — «riga giusta» e «riga sbagliata» hanno esattamente lo stesso aspetto. Chi rilegge
     * SCEGLIE, e il criterio della scelta e' la chiave.
     *
     * E' la gemella lato client di `pickOrderHeader` (srv/lib/prodOrderSource.js), che lato server
     * fa la stessa cosa dopo lo stesso ripiego di forma.
     *
     * `near` SONO LE RIGHE CHE COMBACEREBBERO SENZA GLI ZERI INIZIALI, e si contano invece di
     * accettarle: fra due chiavi scritte da SAP il confronto e' stretto (DEC-51), ma un
     * disallineamento di riempimento e' un difetto a monte da VEDERE — e senza questo conteggio
     * uscirebbe come «riga non trovata», cioe' nel posto sbagliato.
     *
     * SENZA CHIAVI NON SI SCEGLIE NIENTE, come in `check` e per la stessa ragione: rendere la prima
     * riga a chi non ha passato le chiavi sarebbe il difetto che questo modulo esiste per chiudere.
     *
     * @param {Array<object>|object|null} aRows le righe della lettura
     * @param {object} oRouteKeys `{ NomeCampo: valoreDallaRotta, … }`
     * @returns {{row: object|null, matched: number, near: number, scanned: number}}
     */
    function pick(aRows, oRouteKeys) {
        var aList = Array.isArray(aRows)
            ? aRows
            : ((aRows && typeof aRows === "object") ? [aRows] : []);
        var oOut = { row: null, matched: 0, near: 0, scanned: aList.length };

        var aFields = (oRouteKeys && typeof oRouteKeys === "object") ? Object.keys(oRouteKeys) : [];
        if (!aFields.length) return oOut;

        for (var i = 0; i < aList.length; i++) {
            var oCheck = check(aList[i], oRouteKeys);
            if (oCheck.usable) {
                oOut.matched++;
                if (!oOut.row) oOut.row = aList[i];
            } else if (oCheck.reason === REASON.MISMATCH && sameLoose(aList[i], oRouteKeys, aFields)) {
                oOut.near++;
            }
        }
        return oOut;
    }

    /** Combacerebbe se gli zeri iniziali fossero allineati? Serve solo a `pick.near`. */
    function sameLoose(oRow, oRouteKeys, aFields) {
        for (var i = 0; i < aFields.length; i++) {
            var sField = aFields[i];
            if (keyPart(oRow[sField]).replace(/^0+/, "")
                !== keyPart(oRouteKeys[sField]).replace(/^0+/, "")) return false;
        }
        return true;
    }

    /**
     * [DETAIL-REREAD] La frase per la console di una rilettura che non ha trovato la riga.
     * Come `describe`: la diagnosi fa parte della regola.
     * @param {string} sWhere la schermata
     * @param {object} oPick l'esito di `pick`
     * @param {object} oRouteKeys le chiavi chieste
     * @returns {string} vuoto quando la riga e' stata trovata
     */
    function describePick(sWhere, oPick, oRouteKeys) {
        if (!oPick || oPick.row) return "";
        var sChiesta = Object.keys(oRouteKeys || {})
            .map(function (f) { return f + "=«" + oRouteKeys[f] + "»"; }).join(" ");
        return "[DETAIL-REREAD] " + sWhere + ": nessuna delle " + oPick.scanned
            + " righe rilette corrisponde a " + sChiesta + "."
            + (oPick.near
                ? " " + oPick.near + " combacerebbero senza gli zeri iniziali: il riempimento delle"
                    + " chiavi non e' allineato, ed e' un difetto a monte (DEC-51)."
                : "");
    }

    /**
     * La frase per la console. La diagnosi fa parte della regola: un rifiuto muto lascerebbe chi
     * guarda davanti a una schermata vuota senza sapere perche'.
     * @param {string} sWhere la schermata
     * @param {object} oCheck l'esito di `check`
     * @returns {string} vuoto quando lo stash e' utilizzabile
     */
    function describe(sWhere, oCheck) {
        if (!oCheck || oCheck.usable) return "";
        switch (oCheck.reason) {
            case REASON.NO_KEYS:
                return "[ROUTE-KEY] " + sWhere + ": nessuna chiave di rotta da confrontare — la"
                    + " verifica non e' stata fatta. E' un difetto di codice, non un caso d'uso.";
            case REASON.NO_STASH:
                return "[ROUTE-KEY] " + sWhere + ": niente in memoria (F5, segnalibro o link"
                    + " incollato), si rilegge dal server.";
            case REASON.MISSING:
                return "[ROUTE-KEY] " + sWhere + ": la riga non porta il campo «" + oCheck.field
                    + "» (atteso «" + oCheck.expected + "»): non e' verificabile, si rilegge.";
            default:
                return "[ROUTE-KEY] " + sWhere + ": la riga in memoria e' di un ALTRO oggetto — «"
                    + oCheck.field + "» vale «" + oCheck.actual + "» e la rotta chiede «"
                    + oCheck.expected + "». Si scarta.";
        }
    }

    return {
        REASON: REASON,
        keyPart: keyPart,
        check: check,
        describe: describe,
        pick: pick,
        describePick: describePick
    };
});

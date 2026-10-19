sap.ui.define(["sap/ui/model/json/JSONModel", "./logPagerRules"], (JSONModel, rules) => {
    "use strict";

    // ================================================================
    // [LOG-PAGE] La barra delle pagine dello storico invii: un modello, un fragment, tre schede.
    //
    // Le tre schede di dettaglio — ordine, materiale, ciclo — leggono lo storico con una `fetch`
    // ciascuna, e ciascuna ha il SUO modello delle righe con il suo nome. La barra invece e' una
    // sola: il fragment `view/fragments/LogPager.fragment.xml` legge dal modello `logPager`, che
    // questo modulo crea su ogni view con `attach`, e manda ogni evento a `.onLogPager` del
    // controller, che chiede a `targetOf` quale pagina si vuole e rilancia il proprio loader.
    // Le regole — quante pagine, quale `$skip`, quali numeri nella barra — sono in
    // logPagerRules.js, puro; qui sta l'orchestrazione.
    //
    // [DETAIL-RESET] Cambiando oggetto la barra dell'oggetto precedente non deve restare a
    // schermo: `begin` senza pagina la AZZERA prima della lettura, e `reset` la azzera sul ramo
    // di errore della `fetch`, dove la tabella si svuota gia'. Vuoto non e' ignoto: una risposta
    // SENZA `@odata.count` lascia `total: null`, che nasconde la barra e lo dichiara in console,
    // invece di mostrare «di 0».
    //
    // IL TETTO DEL MODELLO SI DICHIARA. `attach` fa `setSizeLimit(PAGE_SIZE)` sul modello delle
    // righe: era il default di 100 di `JSONModel` a nascondere le righe oltre la centesima, e
    // deve restare lo stesso numero del `$top` — e' la ragione per cui `PAGE_SIZE` vive solo
    // nel modulo delle regole.
    // ================================================================

    /** Il nome del modello della barra, lo stesso su tutte le view che includono il fragment. */
    const MODEL = "logPager";

    function blank() {
        return {
            total: null, page: 1, pageCount: 0, items: [],
            from: 0, to: 0, input: "", hasPrev: false, hasNext: false
        };
    }

    /**
     * Crea il modello della barra sulla view e allinea il tetto del modello delle righe alla
     * pagina. Da chiamare in `onInit`, dopo aver creato il modello delle righe.
     * @param {sap.ui.core.mvc.View} oView
     * @param {sap.ui.model.json.JSONModel} oLogModel il modello delle righe della tabella
     * @returns {sap.ui.model.json.JSONModel} il modello della barra
     */
    function attach(oView, oLogModel) {
        const oPager = new JSONModel(blank());
        oView.setModel(oPager, MODEL);
        if (oLogModel && typeof oLogModel.setSizeLimit === "function") {
            oLogModel.setSizeLimit(rules.PAGE_SIZE);
        }
        return oPager;
    }

    /** Il modello della barra di una view. */
    function modelOf(oView) {
        return oView.getModel(MODEL);
    }

    /** Azzera la barra: nessun totale, nessuna pagina. */
    function reset(oPager) {
        if (oPager) { oPager.setData(blank()); }
    }

    /**
     * La pagina da leggere. Senza pagina — cambio oggetto, refresh, chiusura di un dialogo — e'
     * la 1, cioe' le righe piu' recenti, e la barra si azzera PRIMA della lettura. Con una pagina
     * la si riporta dentro il conteggio noto.
     * @param {sap.ui.model.json.JSONModel} oPager
     * @param {number} [iPage]
     * @returns {number}
     */
    function begin(oPager, iPage) {
        if (iPage === undefined || iPage === null) {
            reset(oPager);
            return 1;
        }
        const n = (oPager && oPager.getProperty("/pageCount")) || 0;
        return rules.clampPage(iPage, n);
    }

    /**
     * Aggiorna la barra con la risposta della pagina letta.
     * @param {sap.ui.model.json.JSONModel} oPager
     * @param {number} iPage la pagina chiesta
     * @param {object} oData il corpo della risposta OData (`@odata.count`, `value`)
     * @param {string} [sLabel] per la riga di console
     */
    function applyResponse(oPager, iPage, oData, sLabel) {
        const vRaw = oData ? oData["@odata.count"] : undefined;
        const iTotal = (vRaw === undefined || vRaw === null) ? NaN : Number(vRaw);
        if (!Number.isFinite(iTotal)) {
            console.warn(`>>> [LOG-PAGE] ${sLabel || "storico"}: la risposta non porta @odata.count,`
                + " la barra delle pagine resta nascosta");
            reset(oPager);
            return;
        }
        const n = rules.pageCount(iTotal);
        const p = rules.clampPage(iPage, n);
        const oRange = rules.rangeOf(p, iTotal);
        oPager.setData({
            total: iTotal,
            page: p,
            pageCount: n,
            items: rules.pageItems(p, n),
            from: oRange.from,
            to: oRange.to,
            input: n ? String(p) : "",
            hasPrev: p > 1,
            hasNext: p < n
        });
    }

    /**
     * La pagina chiesta da un evento del fragment, o `null` se non c'e' nulla da fare.
     *
     * Tre sorgenti: un bottone della barra numerica (porta il contesto `logPager>page`), un
     * bottone di navigazione (custom data `go` = `first|prev|next|last|go`), e il `submit`
     * dell'`Input` «Pagina». Un numero non leggibile rimette nel campo la pagina corrente.
     *
     * @param {sap.ui.base.Event} oEvent
     * @param {sap.ui.model.json.JSONModel} oPager
     * @returns {?number}
     */
    function targetOf(oEvent, oPager) {
        const oSource = oEvent && typeof oEvent.getSource === "function" ? oEvent.getSource() : null;
        if (!oSource || !oPager) { return null; }
        const n = oPager.getProperty("/pageCount") || 0;
        const iCur = oPager.getProperty("/page") || 1;

        const oCtx = typeof oSource.getBindingContext === "function" ? oSource.getBindingContext(MODEL) : null;
        if (oCtx) {
            const oItem = oCtx.getObject();
            return oItem && oItem.page ? rules.clampPage(oItem.page, n) : null;
        }

        const sGo = typeof oSource.data === "function" ? oSource.data("go") : null;
        switch (sGo) {
            case "first": return 1;
            case "prev": return rules.clampPage(iCur - 1, n);
            case "next": return rules.clampPage(iCur + 1, n);
            case "last": return n || 1;
            default: break;
        }

        // «Vai» o il submit dell'Input: il valore e' nel modello (binding a due vie) e, sul
        // submit, anche nel parametro dell'evento.
        const vParam = typeof oEvent.getParameter === "function" ? oEvent.getParameter("value") : undefined;
        const vText = (vParam !== undefined && vParam !== null) ? vParam : oPager.getProperty("/input");
        const iParsed = rules.parsePageInput(vText, n);
        if (iParsed === null) {
            oPager.setProperty("/input", n ? String(iCur) : "");
        }
        return iParsed;
    }

    return { MODEL, attach, modelOf, reset, begin, applyResponse, targetOf, pageQuery: rules.pageQuery };
});

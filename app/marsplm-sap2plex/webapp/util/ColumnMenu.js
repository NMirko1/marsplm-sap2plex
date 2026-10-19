sap.ui.define([
    "sap/ui/model/Sorter",
    "sap/ui/model/Filter",
    "sap/m/table/columnmenu/Menu",
    "sap/m/table/columnmenu/QuickAction",
    "sap/m/table/columnmenu/QuickSort",
    "sap/m/table/columnmenu/QuickSortItem",
    "sap/m/Input",
    "sap/m/Button",
    "./columnSortRules"
], (Sorter, Filter, Menu, QuickAction, QuickSort, QuickSortItem, Input, Button, Rules) => {
    "use strict";

    // ================================================================
    // [COLUMN-SORT] Menu di colonna delle tabelle della dashboard: ordina e filtra cliccando
    // sull'intestazione, senza nessuna chiamata al server.
    //
    // PERCHE' TUTTO NEL BROWSER. Le tre liste del cockpit caricano l'insieme INTERO in un
    // `JSONModel` (una lettura per scheda, vedi `_loadTab` in DashboardNavigation.controller.js):
    // da li' `Sorter` e `Filter` sono client-side per costruzione. Mandare i criteri al server
    // sarebbe peggio, non solo piu' lento: in modalita' IS `classifyClientFilter` fonde ogni
    // criterio in un unico OR tollerante, quindi DUE filtri di colonna in AND allargherebbero il
    // risultato invece di restringerlo, in silenzio.
    //
    // QUESTO E' L'UNICO MODO DI CERCARE NELLE TRE LISTE. I `SearchField` che stavano nelle
    // toolbar sono stati rimossi quando il menu di colonna e' entrato in esercizio: erano un
    // secondo meccanismo, con semantica OPPOSTA (un OR su campi fissi contro un AND per colonna),
    // sulla stessa tabella. Chi volesse rimetterne uno rimetta anche il ramo OR di
    // `criteriaTree`, che e' stato tolto con loro.
    //
    // PERCHE' UN CONTROLLO E NON UN CONTROLLER. Le tre tabelle stanno in tre fragment diversi e
    // hanno colonne diverse; la meccanica e' identica. Qui sta la meccanica, nei fragment stanno
    // le colonne, e in `columnSortRules.js` — puro, senza dipendenze, con il suo test node — le
    // regole di confronto e la forma dell'albero dei criteri.
    //
    // QUESTO MODULO NON DECIDE NIENTE SUL MERITO: costruisce l'albero chiamando
    // `Rules.criteriaTree` e lo traduce in `sap.ui.model.Filter` con una mappatura meccanica.
    // Se un giorno la semantica dei criteri dovesse cambiare, il posto e' il modulo puro.
    //
    // Perimetro: grep -rn "COLUMN-SORT"
    // ================================================================

    /** Chiavi delle `CustomData` che descrivono una colonna ordinabile. */
    const DATA_FIELD = "field";
    const DATA_TYPE = "type";

    // I valori di `sap.ui.core.SortOrder` arrivano dal modulo puro, che e' anche l'unico posto in
    // cui vengono CONFRONTATI (`sortFromChangeEvent`): tenerne una seconda copia qui vorrebbe dire
    // poterle disallineare.
    const SORT_NONE = Rules.SORT_NONE;
    const SORT_ASC = Rules.SORT_ASC;
    const SORT_DESC = Rules.SORT_DESC;

    // Testi di ripiego: se il bundle non ha la chiave si vede una parola, non la chiave grezza.
    // Le etichette dei tre pulsanti di ORDINAMENTO non sono qui e non sono nostre: le mette
    // `QuickSort` dal bundle di `sap.m` (`table.COLUMNMENU_SORT_*`), gia' tradotte.
    const FALLBACK = {
        colMenuFilter: "Filtra",
        colMenuFilterPlaceholder: "Contiene…",
        colMenuApply: "Applica",
        colMenuClear: "Azzera"
    };

    /** Lo stato dei criteri vive sull'istanza della tabella: una tabella, un insieme di criteri. */
    function stateOf(oTable) {
        return oTable && oTable.__marsColumnMenu;
    }

    function textOf(oState, sKey) {
        const oBundle = oState.i18n;
        if (oBundle && typeof oBundle.getText === "function") {
            const sText = oBundle.getText(sKey);
            // `getText` rende la CHIAVE quando manca: si preferisce il ripiego leggibile.
            if (sText && sText !== sKey) { return sText; }
        }
        return FALLBACK[sKey] || sKey;
    }

    /**
     * La colonna a cui appartiene il menu appena aperto.
     *
     * `beforeOpen` consegna in `openBy` «l'elemento per cui il menu e' stato aperto», che per
     * `sap.m.Table` e' la colonna — ma la documentazione ammette anche il controllo piu' vicino a
     * un nodo del DOM. Si risale finche' non si trova chi porta la `CustomData` `field`: se un
     * giorno UI5 consegnasse la cella di intestazione invece della colonna, il menu continuerebbe
     * a sapere su quale campo sta lavorando invece di aprirsi vuoto.
     */
    function resolveColumn(vOpenBy) {
        let oCtrl = vOpenBy;
        while (oCtrl && typeof oCtrl.data === "function") {
            if (oCtrl.data(DATA_FIELD)) { return oCtrl; }
            oCtrl = typeof oCtrl.getParent === "function" ? oCtrl.getParent() : null;
        }
        return null;
    }

    /** L'etichetta visibile di una colonna, che e' anche il nome del criterio dichiarato. */
    function labelOf(oColumn) {
        const oHeader = oColumn && oColumn.getHeader && oColumn.getHeader();
        if (oHeader && typeof oHeader.getText === "function") {
            return oHeader.getText() || "";
        }
        return "";
    }

    /**
     * Da albero dei criteri a `sap.ui.model.Filter`. Mappatura meccanica, nessuna logica: la forma
     * l'ha gia' decisa `Rules.criteriaTree`, che mette tutto in AND.
     *
     * Le foglie usano `test`, che UI5 valuta SOLO sui modelli client — ed e' esattamente il caso
     * qui. Con un binding OData `operationMode: "Server"` un filtro con `test` non verrebbe
     * applicato affatto: e' l'altra ragione per cui le tabelle stanno su un `JSONModel`.
     */
    function toFilter(oNode) {
        if (oNode.filters) {
            return new Filter({ filters: oNode.filters.map(toFilter), and: true });
        }
        const sQuery = oNode.query;
        return new Filter({
            path: oNode.field,
            test: (vValue) => Rules.matchesCriterion(vValue, sQuery)
        });
    }

    /** I criteri di colonna attivi, in ordine di inserimento, come lista. */
    function columnCriteria(oState) {
        const aOut = [];
        oState.columns.forEach((oCrit, sField) => {
            aOut.push({ field: sField, query: oCrit.query, label: oCrit.label });
        });
        return aOut;
    }

    /**
     * Applica al binding lo stato corrente: filtri, ordinamento, frecce sulle intestazioni.
     * E' l'unico punto che tocca il binding — ogni cambio di criterio passa di qui.
     */
    function apply(oTable) {
        const oState = stateOf(oTable);
        if (!oState) { return; }
        const oBinding = oTable.getBinding("items");

        if (oBinding) {
            const oTree = Rules.criteriaTree({ columns: columnCriteria(oState) });
            oBinding.filter(oTree ? [toFilter(oTree)] : []);

            if (oState.sort) {
                // `bDescending` sempre falso e direzione dentro il comparatore: e' la sola forma
                // in cui i valori vuoti restano in CODA anche in discesa (vedi columnSortRules).
                oBinding.sort([new Sorter(
                    oState.sort.field, false, false,
                    Rules.comparatorFor(oState.sort.type, oState.sort.descending)
                )]);
            } else {
                oBinding.sort([]);
            }
        }

        // La freccia sull'intestazione: sulla colonna ordinata la direzione, su tutte le altre
        // niente. Senza l'azzeramento resterebbero due frecce e nessuna delle due sarebbe vera.
        oTable.getColumns().forEach((oColumn) => {
            if (typeof oColumn.setSortIndicator !== "function") { return; }
            const sField = oColumn.data(DATA_FIELD);
            const bSorted = !!(oState.sort && sField && sField === oState.sort.field);
            oColumn.setSortIndicator(
                bSorted ? (oState.sort.descending ? SORT_DESC : SORT_ASC) : SORT_NONE
            );
        });

        if (typeof oState.onChange === "function") {
            oState.onChange(getState(oTable));
        }
    }

    /** Costruisce il menu condiviso da tutte le colonne della tabella. */
    function buildMenu(oTable, oState) {
        const oSortItem = new QuickSortItem({ key: "", label: "", sortOrder: SORT_NONE });

        const oQuickSort = new QuickSort({
            items: [oSortItem],
            // ============================================================
            // I TRE PARAMETRI SI PASSANO TUTTI, e la scelta la fa la regola pura.
            //
            // I metadati di QuickSort dichiarano `change: {key, sortOrder}`, ma la sua
            // implementazione fa `fireChange({item: e})`: leggere i parametri dichiarati rende
            // `undefined`, e il difetto e' muto — `onChange` chiude comunque il popover, quindi
            // sembra che il click sia stato raccolto e semplicemente non ordini. E' successo.
            //
            // Il perche' della doppia lettura, e la lezione (il contratto di un evento si legge
            // sulla chiamata `fire*`, non sui metadati), stanno in `sortFromChangeEvent`.
            // ============================================================
            change: (oEvent) => {
                const oSort = Rules.sortFromChangeEvent({
                    key: oEvent.getParameter("key"),
                    sortOrder: oEvent.getParameter("sortOrder"),
                    item: oEvent.getParameter("item")
                });
                oState.sort = oSort
                    ? {
                        field: oSort.field,
                        type: oState.types[oSort.field] || Rules.TYPE_STRING,
                        descending: oSort.descending
                    }
                    : null;
                apply(oTable);
            }
        });

        const oFilterInput = new Input({
            placeholder: textOf(oState, "colMenuFilterPlaceholder"),
            submit: () => applyFilterFromMenu(oTable)
        });

        const oQuickFilter = new QuickAction({
            label: textOf(oState, "colMenuFilter"),
            content: [
                oFilterInput,
                new Button({
                    text: textOf(oState, "colMenuApply"),
                    type: "Emphasized",
                    press: () => applyFilterFromMenu(oTable)
                }),
                new Button({
                    text: textOf(oState, "colMenuClear"),
                    press: () => {
                        oFilterInput.setValue("");
                        applyFilterFromMenu(oTable);
                    }
                })
            ]
        });

        const oMenu = new Menu({
            quickActions: [oQuickSort, oQuickFilter],
            beforeOpen: (oEvent) => {
                const oColumn = resolveColumn(oEvent.getParameter("openBy"));
                oState.openColumn = oColumn;
                if (!oColumn) { return; }
                const sField = oColumn.data(DATA_FIELD);
                oSortItem.setKey(sField);
                oSortItem.setLabel(labelOf(oColumn));
                oSortItem.setSortOrder(
                    oState.sort && oState.sort.field === sField
                        ? (oState.sort.descending ? SORT_DESC : SORT_ASC)
                        : SORT_NONE
                );
                const oCrit = oState.columns.get(sField);
                oFilterInput.setValue(oCrit ? oCrit.query : "");
            }
        });

        oState.menu = oMenu;
        oState.filterInput = oFilterInput;
        oTable.addDependent(oMenu);
        return oMenu;
    }

    /** Legge il campo di filtro del menu e aggiorna il criterio della colonna aperta. */
    function applyFilterFromMenu(oTable) {
        const oState = stateOf(oTable);
        if (!oState || !oState.openColumn) { return; }
        const sField = oState.openColumn.data(DATA_FIELD);
        const sQuery = String(oState.filterInput.getValue() || "").trim();
        if (sQuery) {
            oState.columns.set(sField, { query: sQuery, label: labelOf(oState.openColumn) });
        } else {
            oState.columns.delete(sField);
        }
        if (oState.menu) { oState.menu.close(); }
        apply(oTable);
    }

    // ================================================================
    // API pubblica
    // ================================================================

    /**
     * Rende cliccabili le intestazioni di una tabella.
     *
     * Ogni `<Column>` che porta la `CustomData` `field` riceve l'associazione `headerMenu`; le
     * altre restano com'erano. E' cosi' che una colonna calcolata o non ordinabile si tiene
     * fuori: non aggiungendole la `CustomData`, non togliendo il menu dopo.
     *
     * @param {sap.m.Table} oTable
     * @param {object}   mOptions
     * @param {object}   [mOptions.i18n]     ResourceBundle per le etichette del menu
     * @param {function} [mOptions.onChange] invocata a ogni cambio di criterio, con lo stato
     */
    function install(oTable, mOptions) {
        if (!oTable || stateOf(oTable)) { return; }
        const mOpts = mOptions || {};
        const oState = {
            sort: null,
            columns: new Map(),      // campo -> { query, label }
            types: {},               // campo -> tipo, letto una volta dalle CustomData
            i18n: mOpts.i18n || null,
            onChange: mOpts.onChange || null,
            menu: null,
            filterInput: null,
            openColumn: null
        };
        oTable.__marsColumnMenu = oState;

        const oMenu = buildMenu(oTable, oState);
        oTable.getColumns().forEach((oColumn) => {
            const sField = oColumn.data(DATA_FIELD);
            if (!sField) { return; }
            oState.types[sField] = oColumn.data(DATA_TYPE) || Rules.TYPE_STRING;
            oColumn.setHeaderMenu(oMenu.getId());
            if (typeof oColumn.setSortIndicator === "function") {
                oColumn.setSortIndicator(SORT_NONE);
            }
        });
    }

    /** Toglie un singolo criterio di colonna (la X dell'elenco dei criteri attivi). */
    function removeColumnCriterion(oTable, sField) {
        const oState = stateOf(oTable);
        if (!oState) { return; }
        oState.columns.delete(sField);
        apply(oTable);
    }

    /**
     * Azzera TUTTO: ordinamento e filtri di colonna.
     *
     * Si chiama quando cambia il PERIMETRO — selettore plant, Aggiorna — perche' un criterio
     * sopravvissuto a una rilettura dichiarerebbe un filtro riferito a righe che non ci sono
     * piu'. Non si chiama sui cambi di vista.
     */
    function reset(oTable) {
        const oState = stateOf(oTable);
        if (!oState) { return; }
        oState.sort = null;
        oState.columns.clear();
        apply(oTable);
    }

    /** Lo stato dichiarabile: cosa mostrare nell'elenco dei criteri attivi. */
    function getState(oTable) {
        const oState = stateOf(oTable);
        if (!oState) { return { sort: null, columns: [] }; }
        return {
            sort: oState.sort ? Object.assign({}, oState.sort) : null,
            columns: columnCriteria(oState)
        };
    }

    /** Ri-applica i criteri correnti: serve dopo una rilettura che sostituisce le righe. */
    function refresh(oTable) {
        if (stateOf(oTable)) { apply(oTable); }
    }

    return {
        install,
        removeColumnCriterion,
        reset,
        getState,
        refresh
    };
});

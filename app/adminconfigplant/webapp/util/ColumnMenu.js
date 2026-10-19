sap.ui.define([
    "sap/ui/model/Sorter",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/FilterType",
    "sap/m/table/columnmenu/Menu",
    "sap/m/table/columnmenu/QuickAction",
    "sap/m/table/columnmenu/QuickSort",
    "sap/m/table/columnmenu/QuickSortItem",
    "sap/m/Input",
    "sap/m/Button",
    "./columnSortRules",
    "./codedValues"
], (Sorter, Filter, FilterOperator, FilterType, Menu, QuickAction, QuickSort, QuickSortItem,
    Input, Button, Rules, Coded) => {
    "use strict";

    // ================================================================
    // [COLUMN-SORT] Menu di colonna delle tabelle della configurazione plant: ordina e filtra
    // cliccando sull'intestazione, senza togliere niente alla modifica in linea.
    //
    // E' IL GEMELLO di `marsplm-sap2plex/webapp/util/ColumnMenu.js`, non la sua copia. La
    // meccanica e' la stessa — un `Menu` per tabella, un `QuickSort` ripuntato in `beforeOpen`,
    // una `QuickAction` col campo di ricerca, la `CustomData` `field` come interruttore per
    // colonna — e le REGOLE sono letteralmente le stesse: `./columnSortRules.js` e' identico byte
    // per byte in tutte e due le app, e un test lo sorveglia.
    //
    // CIO' CHE CAMBIA E' CHI FA IL CONFRONTO, e cambia una funzione sola: `apply()`.
    //
    // Le tabelle della dashboard sono di sola lettura su un `JSONModel`, quindi la' `Filter` usa
    // `test` e `Sorter` un comparatore, valutati nel browser. Qui le tabelle sono binding
    // **OData V4 in scrittura** (`operationMode: "Server"`), e su quelli:
    //
    //   - un `Filter` con `test` NON VIENE APPLICATO AFFATTO — il filtro non filtra, in silenzio;
    //   - un comparatore passato a `Sorter` viene IGNORATO — l'ordinamento lo fa `$orderby`.
    //
    // Quindi il confronto lo fa il database, ed e' giusto che lo faccia: dietro c'e' una tabella
    // vera con gli handler generici di CAP, percio' `$filter` e `$orderby` lavorano sull'insieme
    // INTERO e non sulla pagina mostrata — che e' la proprieta' su cui DEC-82 sta o cade.
    //
    // TRE COSE DA NON PERDERE, e ognuna e' un difetto evitato:
    //
    // 1. I criteri di colonna escono con `FilterType.Control`, MAI `Application`. Il filtro per
    //    plant di PlantConfig.controller.js e' un `filter(...)` senza tipo, cioe' `Application`:
    //    V4 tiene i due insiemi separati e li mette in AND. Scrivere i criteri in `Application`
    //    cancellerebbe il filtro plant — e su queste entity il plant NON e' filtrato dal server,
    //    quindi comparirebbero le righe degli altri plant.
    // 2. `ODataListBinding#filter` e `#sort` LANCIANO se il binding ha modifiche in sospeso, e una
    //    riga appena aggiunta con `create()` e' una modifica in sospeso. Da qui il guardiano
    //    `canApply()`, chiamato PRIMA di mutare lo stato: se dice di no non si tocca niente, e non
    //    resta nessuno stato a meta' da annullare. Il messaggio lo da' il chiamante, che e' l'unico
    //    a sapere quale modello e quale update group ha le modifiche aperte.
    // 3. Non c'e' `refresh()`. Sulla dashboard serve perche' l'array di righe sotto al binding
    //    viene sostituito; qui i criteri stanno SUL binding e sopravvivono a una rilettura:
    //    ri-applicarli costerebbe una richiesta per niente.
    //
    // Vedi DEC-102. Perimetro: grep -rn "COLUMN-SORT"
    // ================================================================

    /** Chiave della `CustomData` che rende una colonna ordinabile e filtrabile. */
    const DATA_FIELD = "field";

    // Nessuna `CustomData` `type` qui, e non e' una dimenticanza: il tipo di una colonna serve a
    // scegliere il comparatore, e qui a ordinare e' il database, che il tipo delle sue colonne lo
    // sa da se'. Un `type` copiato dai fragment della dashboard verrebbe semplicemente ignorato.

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

    /** I due motivi per cui si tocca il binding, e li distingue solo chi deve DIRLO all'utente. */
    const REASON_CRITERIA = "criteria";   // l'utente ha chiesto un criterio, o di azzerarli
    const REASON_SCOPE = "scope";         // e' cambiato il perimetro (un altro plant)

    /**
     * Il guardiano delle modifiche aperte.
     *
     * Risponde `true` quando il binding si puo' toccare. Chiamato PRIMA di ogni mutazione dello
     * stato, cosi' un rifiuto non lascia un criterio impostato ma non applicato — che sarebbe
     * peggio del rifiuto: la barra dei criteri direbbe una restrizione che la lista non ha.
     *
     * Il MOTIVO viaggia fino al chiamante perche' solo lui sa se vale la pena dirlo: un rifiuto su
     * un click dell'utente va spiegato, uno sull'apertura di un altro plant sarebbe un popup che
     * nessuno ha chiesto.
     */
    function canApply(oState, sReason) {
        if (typeof oState.canApply !== "function") { return true; }
        return oState.canApply(sReason || REASON_CRITERIA) !== false;
    }

    /**
     * La colonna a cui appartiene il menu appena aperto.
     *
     * `beforeOpen` consegna in `openBy` «l'elemento per cui il menu e' stato aperto», che per
     * `sap.m.Table` e' la colonna — ma la documentazione ammette anche il controllo piu' vicino a
     * un nodo del DOM. Si risale finche' non si trova chi porta la `CustomData` `field`.
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
     * L'etichetta si risolve al momento in cui serve, scandendo le colonne.
     *
     * Non si memorizza all'installazione perche' e' un testo i18n legato a un binding: leggerlo
     * una volta sola vorrebbe dire congelare la lingua del primo istante.
     */
    function labelForField(oTable, sField) {
        const aColumns = (oTable && oTable.getColumns && oTable.getColumns()) || [];
        for (const oColumn of aColumns) {
            if (oColumn.data(DATA_FIELD) === sField) { return labelOf(oColumn); }
        }
        return "";
    }

    /**
     * Una foglia dell'albero dei criteri come `sap.ui.model.Filter` OData.
     *
     * `caseSensitive: false` e' cio' che V4 traduce in `tolower(...)`: e' il confronto tollerante
     * di `matchesCriterion` detto in `$filter`. Gli aghi sono uno o due — il secondo e' il criterio
     * senza zeri iniziali, e i due vanno in OR: la regola sta in `Rules.criterionNeedles`, qui c'e'
     * solo la traduzione.
     *
     * NESSUNA FOGLIA CON `test`: su un binding `operationMode: "Server"` non verrebbe applicata, e
     * il filtro non filtrerebbe senza che niente lo dica.
     */
    function leafFilter(oState, oLeaf) {
        const aNeedles = Rules.criterionNeedles(oLeaf.query);
        const aFilters = aNeedles.map((sNeedle) => new Filter({
            path: oLeaf.field,
            operator: FilterOperator.Contains,
            value1: sNeedle,
            caseSensitive: false
        }));
        aFilters.push(...codedFilters(oState, oLeaf));
        return aFilters.length === 1 ? aFilters[0] : new Filter({ filters: aFilters, and: false });
    }

    /**
     * [CODED-VALUES] Il criterio si TRADUCE, il dato no.
     *
     * Su una colonna il cui valore memorizzato non e' quello che si legge — «Operazione», dove
     * «Prima operazione» e «Ultima operazione» sono etichette tradotte e in `PlexOperationName`
     * non c'e' niente — un `contains` sul campo non aggancerebbe mai quelle righe: nel database
     * quel testo NON ESISTE, e non deve esistere (DEC-92, una traduzione non si persiste).
     *
     * Allora si gira la domanda: invece di cercare l'etichetta nel dato, si guarda se il criterio
     * digitato aggancia l'etichetta — risolta ORA, dal bundle, nella lingua di chi guarda — e in
     * quel caso si mette in OR un'uguaglianza sul CODICE, che nel database c'e' davvero.
     *
     *     digiti «prima» →  contains(tolower(PlexOperationName),'prima')
     *                       or (PlexOperation eq 'FIRST_OP')
     *
     * Il confronto e' `Rules.matchesCriterion`, la stessa regola tollerante del modulo puro
     * condiviso: sottostringa, insensibile a maiuscole e spazi ai bordi. Cosi' «prim», «Prima» e
     * « operazione » agganciano tutte.
     *
     * INDIPENDENTE DALLE LINGUE INSTALLATE: qui non c'e' nessun testo, solo chiavi i18n
     * (`./codedValues`), e l'etichetta si rilegge dal bundle a ogni criterio. Una lingua nuova e'
     * un file `.properties` in piu' — nessuna riga di codice da toccare.
     *
     * Senza bundle non si tira a indovinare: si rende nessun filtro aggiuntivo. Meglio una riga
     * non trovata che una riga agganciata dall'etichetta sbagliata.
     */
    function codedFilters(oState, oLeaf) {
        const oColumn = Coded.codedColumn(oLeaf.field);
        if (!oColumn) { return []; }
        const oBundle = oState.i18n;
        if (!oBundle || typeof oBundle.getText !== "function") { return []; }

        const aOut = [];
        Object.keys(oColumn.labels).forEach((sCode) => {
            const sKey = oColumn.labels[sCode];
            const sLabel = oBundle.getText(sKey);
            // `getText` rende la CHIAVE quando manca: confrontarci il criterio aggancerebbe righe
            // per il nome tecnico della traduzione, che nessuno ha digitato apposta.
            if (!sLabel || sLabel === sKey) { return; }
            if (Rules.matchesCriterion(sLabel, oLeaf.query)) {
                aOut.push(new Filter({
                    path: oColumn.path,
                    operator: FilterOperator.EQ,
                    value1: sCode
                }));
            }
        });
        return aOut;
    }

    /**
     * Da albero dei criteri a `sap.ui.model.Filter`. Mappatura meccanica, nessuna logica: la forma
     * l'ha gia' decisa `Rules.criteriaTree`, che mette tutto in AND.
     */
    function toFilter(oState, oNode) {
        if (oNode.filters) {
            return new Filter({
                filters: oNode.filters.map((oChild) => toFilter(oState, oChild)),
                and: true
            });
        }
        return leafFilter(oState, oNode);
    }

    /** I criteri di colonna attivi, in ordine di inserimento, come lista. */
    function columnCriteria(oState) {
        const aOut = [];
        oState.columns.forEach((sQuery, sField) => {
            aOut.push({ field: sField, query: sQuery });
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
            // `FilterType.Control`: il filtro per PLANT vive in `Application` e deve sopravvivere.
            oBinding.filter(oTree ? [toFilter(oState, oTree)] : [], FilterType.Control);

            // `Sorter` nudo, senza comparatore: V4 lo tradurrebbe comunque in `$orderby` e il
            // comparatore lo ignorerebbe. Passarlo darebbe l'illusione di aver portato con se' la
            // regola dei vuoti in coda, che qui NON vale: in SQL il vuoto precede.
            oBinding.sort(oState.sort
                ? [new Sorter(oState.sort.field, oState.sort.descending)]
                : []);
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
            // Il perche' della doppia lettura sta in `sortFromChangeEvent`.
            // ============================================================
            change: (oEvent) => {
                if (!canApply(oState, REASON_CRITERIA)) {
                    if (oState.menu) { oState.menu.close(); }
                    return;
                }
                const oSort = Rules.sortFromChangeEvent({
                    key: oEvent.getParameter("key"),
                    sortOrder: oEvent.getParameter("sortOrder"),
                    item: oEvent.getParameter("item")
                });
                oState.sort = oSort
                    ? { field: oSort.field, descending: oSort.descending }
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
                oFilterInput.setValue(oState.columns.get(sField) || "");
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
        if (!canApply(oState, REASON_CRITERIA)) {
            if (oState.menu) { oState.menu.close(); }
            return;
        }
        const sField = oState.openColumn.data(DATA_FIELD);
        const sQuery = String(oState.filterInput.getValue() || "").trim();
        if (sQuery) {
            oState.columns.set(sField, sQuery);
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
     * altre restano com'erano. E' cosi' che una colonna si tiene fuori: non aggiungendole la
     * `CustomData`, non togliendo il menu dopo.
     *
     * @param {sap.m.Table} oTable
     * @param {object}   mOptions
     * @param {object}   [mOptions.i18n]     ResourceBundle per le etichette del menu
     * @param {function} [mOptions.onChange] invocata a ogni cambio di criterio, con lo stato
     * @param {function} [mOptions.canApply] `canApply(sReason)` → `false` = il binding non si puo'
     *                                       toccare ora (modifiche aperte): il criterio non viene
     *                                       applicato e nulla cambia. Il messaggio all'utente lo
     *                                       da' il chiamante, che e' l'unico a sapere quale update
     *                                       group ha le modifiche aperte — e che con `sReason`
     *                                       `"scope"` puo' decidere di tacere.
     */
    function install(oTable, mOptions) {
        if (!oTable || stateOf(oTable)) { return; }
        const mOpts = mOptions || {};
        const oState = {
            sort: null,
            columns: new Map(),      // campo -> testo digitato
            i18n: mOpts.i18n || null,
            onChange: mOpts.onChange || null,
            canApply: mOpts.canApply || null,
            menu: null,
            filterInput: null,
            openColumn: null
        };
        oTable.__marsColumnMenu = oState;

        const oMenu = buildMenu(oTable, oState);
        oTable.getColumns().forEach((oColumn) => {
            if (!oColumn.data(DATA_FIELD)) { return; }
            oColumn.setHeaderMenu(oMenu.getId());
            if (typeof oColumn.setSortIndicator === "function") {
                oColumn.setSortIndicator(SORT_NONE);
            }
        });
    }

    /**
     * Azzera TUTTO: ordinamento e filtri di colonna.
     *
     * Si chiama quando cambia il PERIMETRO — l'apertura di un altro plant — e dal pulsante «Azzera
     * criteri»: un criterio sopravvissuto a un cambio di plant dichiarerebbe una restrizione
     * riferita a righe che non ci sono piu'.
     *
     * Passa dal guardiano come tutto il resto, perche' anche azzerare TOCCA il binding.
     *
     * @param {sap.m.Table} oTable
     * @param {string} [sReason] `"criteria"` (default) o `"scope"`: arriva a `canApply` e decide
     *                           se un rifiuto va spiegato all'utente o passato sotto silenzio
     * @returns {boolean} `false` se il guardiano ha rifiutato e i criteri sono rimasti quelli
     */
    function reset(oTable, sReason) {
        const oState = stateOf(oTable);
        if (!oState) { return true; }
        // Niente da azzerare: si esce PRIMA di toccare il binding. Non e' un'ottimizzazione — al
        // primo caricamento `reset()` arriva subito prima del filtro per plant, e un `filter()`
        // inutile la' in mezzo e' una scrittura sul binding fatta mentre il perimetro non c'e'
        // ancora. E' anche la ragione per cui qui il guardiano non serve: senza criteri non si
        // chiede niente, quindi non si nega niente.
        if (!oState.sort && oState.columns.size === 0) { return true; }
        if (!canApply(oState, sReason)) { return false; }
        oState.sort = null;
        oState.columns.clear();
        apply(oTable);
        return true;
    }

    /** Lo stato dichiarabile: cosa mostrare nell'elenco dei criteri attivi. */
    function getState(oTable) {
        const oState = stateOf(oTable);
        if (!oState) { return { sort: null, columns: [] }; }
        return {
            sort: oState.sort
                ? {
                    field: oState.sort.field,
                    descending: oState.sort.descending,
                    label: labelForField(oTable, oState.sort.field)
                }
                : null,
            columns: columnCriteria(oState).map((oCrit) => ({
                field: oCrit.field,
                query: oCrit.query,
                label: labelForField(oTable, oCrit.field)
            }))
        };
    }

    return {
        REASON_CRITERIA,
        REASON_SCOPE,
        install,
        reset,
        getState
    };
});

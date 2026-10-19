sap.ui.define([], () => {
    "use strict";

    // ================================================================
    // [MAT-PLANT-PAIR] Il filtro dello storico invii di un materiale (feature 0039).
    //
    // PERCHE' ESISTE. Lo storico di un materiale si legge con una `fetch` grezza su
    // `/odata/v4/log/ZMatExcLogPOS`, e fino alla 0039 il filtro era sul solo `Product`. Ma la
    // chiave di quella tabella e' `(Product, Plant, Counter)` dalla 0031, e il `Counter` riparte da
    // 1 PER PLANT: la scheda di un materiale in perimetro su due plant mostrava le righe di
    // entrambi, con numeri duplicati, ordinate per un contatore che non e' cronologico fra plant.
    // Dalla 0039 le righe raddoppiano e il difetto diventa evidente.
    //
    // E L'ESCAPING NON E' UNA FORMALITA'. Il codice di prima faceva `encodeURIComponent` DENTRO un
    // literal fra apici: due errori sovrapposti. `encodeURIComponent` non tocca l'apice, e l'escape
    // di un apice in OData e' il RADDOPPIO (`O'BRIEN` -> `'O''BRIEN'`). Un codice materiale con un
    // apice produceva un `$filter` malformato, il server rispondeva 400, il `.catch` metteva la
    // lista a vuoto: STORICO VUOTO, indistinguibile da «mai inviato». Qui il literal si costruisce
    // raddoppiando, e si codifica il filtro INTERO una volta sola.
    //
    // Nessuna dipendenza: `sap.ui.define([])`, come `util/LogLanguage.js` e `util/columnSortRules.js`.
    // Test: `node test/matLogFilter.test.js`.
    // ================================================================

    /**
     * Un literal stringa OData: apici raddoppiati, mai codificati.
     * @param {*} vValue
     * @returns {string} p.es. `'O''BRIEN'`
     */
    function odataLiteral(vValue) {
        const sValue = (vValue === null || vValue === undefined) ? "" : String(vValue);
        return "'" + sValue.replace(/'/g, "''") + "'";
    }

    /**
     * L'espressione `$filter` dello storico di una coppia (materiale, plant).
     *
     * PLANT ASSENTE: la clausola si OMETTE, e il chiamante lo dichiara in console. Costruirla su un
     * valore vuoto darebbe `Plant eq ''`, che aggancia solo le righe storiche pre-0031, cioe' una
     * lista vuota — e una lista vuota si legge come «mai inviato». Meglio uno storico ambiguo
     * dichiarato che uno vuoto muto.
     *
     * NON si aggiunge `or Plant eq ''` per «recuperare» le righe storiche: mostrerebbe le stesse
     * righe su ogni plant, ricreando l'ambiguita' che la 0031 ha tolto.
     *
     * @param {string} sProduct
     * @param {string} [sPlant]
     * @returns {string}
     */
    function matLogFilter(sProduct, sPlant) {
        const sPlantKey = (sPlant === null || sPlant === undefined) ? "" : String(sPlant).trim();
        const sBase = "Product eq " + odataLiteral(sProduct);
        return sPlantKey ? sBase + " and Plant eq " + odataLiteral(sPlantKey) : sBase;
    }

    /**
     * L'URL completo dello storico, con il filtro codificato UNA volta sola.
     *
     * [LOG-TRACE] `sSelect` non e' un'ottimizzazione facoltativa: senza, la lista scarica anche
     * `RequestJson` e `ResponseJson`, i due `LargeString` con la traccia intera, per ogni riga e
     * senza mostrarli mai. Il valore lo compone `util/LogTrace.js`, che e' il punto unico in cui
     * si decide quali colonne servono a una lista di storico. Si compone QUI e non nel chiamante
     * perche' il `$select` deve stare nello stesso file che compone l'URL: la rete di
     * `test/logHistorySelect.test.js` guarda li'.
     *
     * @param {string} sProduct
     * @param {string} [sPlant]
     * @param {string} [sSelect] il valore di `$select`, da `LogTrace.listSelect`
     * @returns {string}
     */
    function matLogUrl(sProduct, sPlant, sSelect) {
        return "/odata/v4/log/ZMatExcLogPOS?$filter="
            + encodeURIComponent(matLogFilter(sProduct, sPlant))
            + (sSelect ? "&$select=" + sSelect : "")
            + "&$orderby=Counter desc";
    }

    return { odataLiteral, matLogFilter, matLogUrl };
});

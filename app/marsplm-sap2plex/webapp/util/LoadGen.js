sap.ui.define([], () => {
    "use strict";

    // ================================================================
    // [LOAD-GEN] «Questa risposta e' ancora quella che ho chiesto io?» (feature 0043).
    //
    // PERCHE' ESISTE. Le tre schermate di dettaglio riempiono i propri modelli con quattro-otto
    // `fetch` che partono insieme e tornano quando vogliono. Nessuna di loro, al ritorno, si
    // chiedeva se la rotta fosse ancora quella per cui era partita: bastava aprire un ordine,
    // tornare indietro e aprirne un altro perche' la risposta lenta del PRIMO sovrascrivesse i
    // modelli del secondo. Non e' un difetto transitorio — resta a schermo finche' non si
    // rinavigata — e non da' nessun errore: i dati sono coerenti fra loro, sono solo di un altro
    // oggetto.
    //
    // La regola era gia' scritta nel progetto, ma in un posto solo e a mano: la dashboard tiene un
    // contatore per scheda (`_mLoadGen` in `DashboardNavigation.controller.js`) e spegne il busy
    // solo se la generazione e' ancora la sua. Qui quella regola diventa un modulo, perche' i punti
    // che la applicano sono passati da uno a molti e tre copie a mano divergono.
    //
    // PERCHE' UN CONTATORE E NON `RouteStash.check` SULLA RISPOSTA. Il confronto per chiave della
    // 0041 funziona dove la risposta PORTA la chiave: la testata la porta, i nodi del ciclo Plex e
    // lo stato di spacchettamento no. Il contatore non chiede niente al payload, quindi copre
    // anche quelle letture. Le due guardie non si sostituiscono: `RouteStash` risponde «di chi sono
    // questi dati», `LoadGen` risponde «li ho chiesti ancora io».
    //
    // LA DIREZIONE DELL'ERRORE E' SCELTA. Una generazione che non combacia fa SCARTARE la
    // risposta: si preferisce un'area vuota a un'area che mostra un altro oggetto. Per questo
    // `isCurrent` esige un contatore registrato e un intero: un chiamante che passa qualcosa che
    // non viene da `next` ottiene «no», cioe' un'area che resta vuota — un difetto che si VEDE,
    // invece di una guardia che dice sempre si'. E' la stessa scelta di `RouteStash.NO_KEYS`.
    //
    // Nessuna dipendenza: `sap.ui.define([])`, come `util/RouteStash.js` e `util/MatLogFilter.js`.
    // Test: `node test/loadGen.test.js`.
    // ================================================================

    /**
     * Apre una nuova generazione per `sKey` e la restituisce.
     *
     * Va chiamata UNA volta per ingresso di rotta, prima di far partire qualunque lettura: da quel
     * momento tutte le risposte delle letture precedenti sono vecchie per costruzione.
     *
     * @param {object} mMap il contenitore delle generazioni, di proprieta' del chiamante
     * @param {string} sKey l'area (le tre schermate ne usano una sola; la dashboard una per scheda)
     * @returns {number} la generazione appena aperta, da confrontare al ritorno di ogni lettura
     */
    function next(mMap, sKey) {
        if (!mMap || typeof mMap !== "object") return 0;
        const iPrev = typeof mMap[sKey] === "number" ? mMap[sKey] : 0;
        mMap[sKey] = iPrev + 1;
        return mMap[sKey];
    }

    /**
     * La generazione `iGen` e' ancora quella corrente per `sKey`?
     *
     * `false` significa «e' partita un'altra navigazione»: chi chiama deve SCARTARE la risposta
     * senza scrivere niente e senza toccare il proprio `busy` — lo spegnera' la lettura piu'
     * recente, che e' ancora in volo.
     *
     * @param {object} mMap
     * @param {string} sKey
     * @param {number} iGen la generazione catturata quando la lettura e' partita
     * @returns {boolean}
     */
    function isCurrent(mMap, sKey, iGen) {
        if (!mMap || typeof mMap !== "object") return false;
        if (typeof iGen !== "number" || !isFinite(iGen) || iGen <= 0) return false;
        return mMap[sKey] === iGen;
    }

    return { next, isCurrent };
});

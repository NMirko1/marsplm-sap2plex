sap.ui.define([], () => {
    "use strict";

    // ================================================================
    // [LOG-PAGE] Le regole della paginazione dello storico invii.
    //
    // PERCHE' ESISTE. Le tre tabelle «Storico Invii» — ordine, materiale, ciclo — mostravano al
    // piu' 100 righe, e nessuno aveva deciso quel numero. Erano DUE tetti silenziosi uno sopra
    // l'altro: il server CAP consegna al piu' 1000 righe a chi non chiede `$top` (il default di
    // `cds.env.query.limit.max`), e un `JSONModel` ha `sizeLimit` 100 di default, quindi le righe
    // dalla 101 alla 1000 arrivavano nel browser e non si vedevano. Su un ordine che SAP rifiuta
    // da giorni — una riga di storico per registrazione per run, ogni quarto d'ora — la storia
    // utile era irraggiungibile, e la pagina diceva «100» senza dire che ce n'erano altre.
    //
    // LA PAGINA E' DEL SERVER. Ogni pagina e' UNA lettura con `$top=100&$skip=N&$count=true`:
    // arrivano le 100 righe di quella pagina e il conteggio totale, nient'altro. Il `$select`
    // resta quello di [LOG-TRACE] — senza `RequestJson` e `ResponseJson`, che si leggono al clic
    // sulla riga — e l'ordine resta `Counter desc`, quindi la pagina 1 sono le righe piu' recenti.
    //
    // COSA C'E' QUI E COSA NO. Qui stanno le sole regole: quante pagine, quale `$skip`, quali
    // numeri mostrare nella barra `1 2 3 … N`, come leggere il numero scritto a mano. Nessuna
    // dipendenza, `sap.ui.define([])`: e' cio' che rende il modulo eseguibile da node
    // (`node test/logPagerRules.test.js`), come columnSortRules.js. L'orchestrazione — il modello
    // della barra, gli eventi del fragment — sta in LogPager.js.
    //
    // `PAGE_SIZE` VIVE SOLO QUI. Il `$top` della lettura e il `sizeLimit` del modello devono
    // essere lo stesso numero: se divergessero tornerebbe il difetto di partenza, righe lette e
    // non mostrate, senza nessun errore.
    // ================================================================

    /** Righe per pagina: il `$top` della lettura e il `sizeLimit` del modello delle righe. */
    const PAGE_SIZE = 100;

    /** Pagine vicine alla corrente mostrate per lato nella barra. */
    const WINDOW = 2;

    /** Fino a questo numero di pagine la barra le mostra tutte, senza salti. */
    const ALL_UP_TO = 7;

    /** L'etichetta del salto nella barra. */
    const ELLIPSIS = "…";

    /**
     * Quante pagine servono per `iTotal` righe. Zero righe, o un totale non numerico, danno 0:
     * «nessuna pagina» e' diverso da «una pagina vuota», e la barra con 0 pagine non si mostra.
     * @param {number} iTotal
     * @returns {number}
     */
    function pageCount(iTotal) {
        const n = Number(iTotal);
        if (!Number.isFinite(n) || n <= 0) { return 0; }
        return Math.ceil(n / PAGE_SIZE);
    }

    /**
     * Riporta una pagina dentro `[1, iPageCount]`. Con `iPageCount` 0 (conteggio ignoto) il
     * tetto non si applica: resta il solo pavimento a 1.
     * @param {number} iPage
     * @param {number} iPageCount
     * @returns {number}
     */
    function clampPage(iPage, iPageCount) {
        const p = Math.trunc(Number(iPage));
        if (!Number.isFinite(p) || p < 1) { return 1; }
        const n = Number(iPageCount) || 0;
        if (n > 0 && p > n) { return n; }
        return p;
    }

    /**
     * Il `$skip` della pagina.
     * @param {number} iPage
     * @returns {number}
     */
    function skipOf(iPage) {
        return (clampPage(iPage, 0) - 1) * PAGE_SIZE;
    }

    /**
     * Le tre query option della pagina, da appendere DOPO `$orderby`: `$count=true` perche' la
     * barra ha bisogno del totale, `$top` e `$skip` perche' la pagina e' del server.
     * @param {number} iPage
     * @returns {string}
     */
    function pageQuery(iPage) {
        return "&$count=true&$top=" + PAGE_SIZE + "&$skip=" + skipOf(iPage);
    }

    /**
     * Le righe (1-based) mostrate dalla pagina: «Righe 101–150 di 150».
     * @param {number} iPage
     * @param {number} iTotal
     * @returns {{from: number, to: number}}
     */
    function rangeOf(iPage, iTotal) {
        const n = Number(iTotal);
        if (!Number.isFinite(n) || n <= 0) { return { from: 0, to: 0 }; }
        const p = clampPage(iPage, pageCount(n));
        return { from: (p - 1) * PAGE_SIZE + 1, to: Math.min(p * PAGE_SIZE, n) };
    }

    /**
     * La barra `1 2 3 … N`: sempre la prima e l'ultima pagina, la corrente con `WINDOW` vicine
     * per lato, e un salto dove mancano DUE o piu' pagine — un salto di una pagina sola si
     * mostra col suo numero, perche' tre puntini al posto di un numero non accorciano niente.
     * Fino a `ALL_UP_TO` pagine si mostrano tutte.
     *
     * Ogni voce porta `page` (null sul salto), `label`, `current` e `enabled` (false sul salto).
     * La voce corrente resta `enabled`: premerla rilegge la stessa pagina, che e' un refresh.
     *
     * @param {number} iCurrent
     * @param {number} iPageCount
     * @returns {Array<{page: ?number, label: string, current: boolean, enabled: boolean}>}
     */
    function pageItems(iCurrent, iPageCount) {
        const n = Number(iPageCount) || 0;
        if (n <= 0) { return []; }
        const iCur = clampPage(iCurrent, n);
        const item = (p) => ({ page: p, label: String(p), current: p === iCur, enabled: true });
        const gap = () => ({ page: null, label: ELLIPSIS, current: false, enabled: false });

        const aPages = [];
        if (n <= ALL_UP_TO) {
            for (let p = 1; p <= n; p++) { aPages.push(p); }
        } else {
            const oSet = new Set([1, n]);
            for (let p = iCur - WINDOW; p <= iCur + WINDOW; p++) {
                if (p >= 1 && p <= n) { oSet.add(p); }
            }
            aPages.push(...[...oSet].sort((a, b) => a - b));
        }

        const aOut = [];
        let iPrev = 0;
        for (const p of aPages) {
            if (iPrev && p - iPrev === 2) { aOut.push(item(p - 1)); }
            else if (iPrev && p - iPrev > 2) { aOut.push(gap()); }
            aOut.push(item(p));
            iPrev = p;
        }
        return aOut;
    }

    /**
     * Il numero scritto nel campo «Pagina». Solo cifre, dopo il trim; `0`, vuoto e testo danno
     * `null` — chi chiama rimette nel campo la pagina corrente. Un numero oltre l'ultima pagina
     * porta all'ULTIMA: e' un errore di battitura innocuo, e l'ultima pagina e' la risposta che
     * chi scrive «99» su 5 pagine sta cercando. Con 0 pagine non c'e' nulla a cui andare.
     *
     * @param {string|number} vText
     * @param {number} iPageCount
     * @returns {?number}
     */
    function parsePageInput(vText, iPageCount) {
        const s = String(vText === null || vText === undefined ? "" : vText).trim();
        if (!/^\d+$/.test(s)) { return null; }
        const p = Number(s);
        if (p < 1) { return null; }
        const n = Number(iPageCount) || 0;
        if (n <= 0) { return null; }
        return p > n ? n : p;
    }

    return {
        PAGE_SIZE, WINDOW, ALL_UP_TO, ELLIPSIS,
        pageCount, clampPage, skipOf, pageQuery, rangeOf, pageItems, parsePageInput
    };
});

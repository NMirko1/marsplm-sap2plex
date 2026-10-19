sap.ui.define([], function () {
    "use strict";

    // ================================================================
    // [APP-URL] Ogni URL verso il NOSTRO backend nasce qui, e nasce con la base dell'app davanti.
    //
    // IL PERCHE'. Servita dal repository HTML5 — Work Zone, o il runtime gestito — l'app e'
    // pubblicata sotto un PREFISSO di path, e le rotte del suo `xs-app.json` vengono valutate su
    // cio' che resta DOPO quel prefisso. Un URL che comincia con `/` quel prefisso non ce l'ha,
    // quindi non raggiunge nessuna di quelle rotte: arriva alla radice del launchpad, dove non
    // c'e' niente. A schermo si legge come «non trova tabelle e servizi» — liste vuote e ogni
    // azione fallita — e non come un errore di rotta.
    //
    // Fino a oggi funzionava lo stesso perche' il link diretto passa dall'approuter standalone
    // (app/router/xs-app.json), la cui rotta catch-all `^/(.*)$` manda tutto a `srv-api`: i
    // `xs-app.json` DELLE APP, che pure esistono da sempre e portano gia' le rotte giuste scritte
    // con `^/?` (barra iniziale opzionale), non li raggiungeva nessuna richiesta.
    //
    // LA BASE SI ESPLICITA, non si lascia al browser. Un URL relativo nudo (`"products/..."`) in
    // una `fetch` si risolve su `document.baseURI`, che in Work Zone e' la shell del launchpad e
    // NON l'app: si tornerebbe a sbagliare bersaglio, con un difetto piu' difficile da vedere.
    // Solo `sap.ui.require.toUrl` del namespace del componente da' la base giusta nei tre mondi
    // (Work Zone, approuter, `cds watch`).
    //
    // NESSUN ORDINE DI CARICAMENTO DA RISPETTARE: `sap.ui.require.toUrl` funziona appena il loader
    // e' configurato, cioe' prima che qualunque modulo venga valutato. Per questo le costanti di
    // modulo che tengono un URL (`SPLIT_INFO_URL`, `RESET_ENDPOINT`, ...) possono restare `const`
    // risolte al caricamento, e non serve nessun `init()` da `Component.js`.
    //
    // La rete e' `test/appUrlSurface.test.js`, che spazza la cartella `webapp` e RIFIUTA un
    // `serviceUrl`, una `fetch` o un `dataSources.uri` che cominci con `/` seguito da una radice
    // di servizio nota — compreso quello aggiunto domani.
    // ================================================================

    /**
     * Il namespace del componente di QUESTA app.
     *
     * E' l'unica riga che cambia fra le due copie di questo file (cockpit e configurazione
     * plant), e `test/appUrl.test.js` sorveglia che sia davvero l'unica.
     */
    const NAMESPACE = "avvaleplm/marsplm/sap2plex/adminconfigplant";

    /** Calcolata una volta sola: dentro una pagina la base dell'app non cambia. */
    let sBase = null;

    /**
     * Da quello che risponde `toUrl` alla base usabile — oppure `null`.
     *
     * TRE FORME NON SONO UNA BASE, e nessuna delle tre da' errore da se':
     *
     *   1. VUOTA o `/`. Il risultato sarebbe `/products/...`, cioe' di nuovo un URL assoluto: il
     *      difetto che tutta questa feature esiste per togliere, tornato per la porta di servizio.
     *      In Work Zone quell'indirizzo arriva alla radice del launchpad e da' `404`.
     *
     *   2. IL RIPIEGO DEL LOADER UI5, cioe' `<base UI5>/resources/<namespace>`. E' quello che
     *      `sap.ui.require.toUrl` restituisce quando il namespace NON e' registrato, ed e' una
     *      forma misurata, non ipotizzata: il 18/09/2026, da Work Zone, per entrambe le app —
     *      `https://sapui5.hana.ondemand.com/1.152.0/resources/avvaleplm/marsplm/sap2plex/main`.
     *      Presa per buona comporrebbe richieste verso il CDN di SAP, che falliscono in un modo che
     *      non assomiglia per niente a un problema di rotte, e manderebbero la diagnosi altrove.
     *
     * Il riconoscimento e' ESATTO — la coda dev'essere `/resources/` piu' il namespace — e non un
     * generico «contiene resources»: un'app servita sotto un path che contiene quella parola non
     * va scartata.
     *
     * @param {string} sRaw quello che ha risposto `toUrl`
     * @param {string} sNamespace il namespace chiesto, per riconoscere il ripiego
     * @returns {string|null} la base con la barra finale, o `null` se non e' usabile
     */
    function normalizeBase(sRaw, sNamespace) {
        const sClean = String(sRaw == null ? "" : sRaw).trim().replace(/\/+$/, "");
        if (!sClean) { return null; }
        if (sClean.endsWith("/resources/" + sNamespace)) { return null; }
        return sClean + "/";
    }

    /**
     * La base dell'app, sempre con la barra finale.
     *
     * `toUrl` la restituisce con o senza barra a seconda di come e' registrato il resource root,
     * quindi si normalizza qui: senza, si otterrebbe `...mainproducts/`.
     *
     * QUANDO NON E' USABILE SI RIPIEGA SULL'ASSOLUTO, E LO SI DICE. Non si lancia: l'assoluto e' il
     * comportamento storico e funziona sull'approuter e sotto `cds watch`, quindi fermare l'app
     * farebbe piu' danno del difetto. In Work Zone fallira' comunque — ma con una riga che nomina
     * il valore ottenuto, invece di un `404` muto su cui si perde un pomeriggio.
     *
     * @returns {string} es. `/avvaleplm.marsplm.sap2plex.main/`
     */
    function base() {
        if (sBase === null) {
            const sRaw = sap.ui.require.toUrl(NAMESPACE);
            const sOk = normalizeBase(sRaw, NAMESPACE);
            if (sOk === null) {
                console.error(">>> [APP-URL] base dell'app non determinabile: toUrl(\"" + NAMESPACE
                    + "\") ha risposto \"" + sRaw + "\". Il namespace non risulta registrato, quindi"
                    + " gli indirizzi partiranno dalla radice: in Work Zone risponde 404.");
            }
            sBase = sOk === null ? "/" : sOk;
        }
        return sBase;
    }

    return {

        base,
        normalizeBase,

        /**
         * Da un path del backend all'URL da chiamare.
         *
         * Il path si continua a scrivere com'e' sempre stato, con la barra iniziale: qui viene
         * tolta e sostituita dalla base dell'app.
         *
         * @param {string} sPath es. `/products/Products(Product='X')` oppure `/plex/createJobInPlex`
         * @returns {string} lo stesso path con la base dell'app davanti
         */
        url(sPath) {
            return base() + String(sPath == null ? "" : sPath).replace(/^\/+/, "");
        },

        /**
         * L'URL di un'ALTRA app dello stesso pacchetto, accanto a questa — oppure `null`.
         *
         * E' il RIPIEGO della navigazione fra app, non la sua strada principale: dentro una shell
         * (Work Zone, FLP) si naviga per INTENT, perche' e' la shell a sapere dove sta l'altra app
         * e con che parametri aprirla. Questo serve dove la shell non c'e' — l'approuter e
         * `cds watch` — dove le app stanno l'una accanto all'altra sotto lo stesso genitore.
         *
         * Si ricava dalla base di QUESTA app invece che da `window.location.origin`: l'origine e'
         * la radice dell'host, che dentro una shell e' il launchpad e non il posto dove stanno le
         * app.
         *
         * LA GRAFIA DELL'ID SI RICAVA, NON SI SCRIVE, ed e' tutto il lavoro di questa funzione.
         * La stessa app ha due nomi di cartella in due mondi, misurati il 18/09/2026:
         *
         *   approuter   /avvaleplmmarsplmsap2plexmain/        (senza punti)
         *   cds watch   /avvaleplm.marsplm.sap2plex.main/     (con i punti)
         *
         * Un id cablato e' quindi giusto in un mondo e sbagliato nell'altro — ed e' il difetto che
         * `window.location.origin + "/avvaleplm.marsplm.sap2plex.adminconfobjgrp/index.html"`
         * aveva da prima di questa feature. Si confronta allora l'ultimo segmento della PROPRIA
         * base con il proprio id nelle due grafie, e all'altra app si applica quella che combacia.
         *
         * E SE NON COMBACIA NESSUNA, non si indovina: si restituisce `null`. Una terza grafia —
         * Work Zone ne usa una sua — darebbe un indirizzo plausibile e sbagliato, cioe' una scheda
         * aperta su una pagina che non c'e', che e' peggio di un messaggio. Chi chiama lo dichiara.
         *
         * @param {string} sAppId id dell'altra app, es. `avvaleplm.marsplm.sap2plex.adminconfigplant`
         * @param {string} sPath path dentro quell'app, es. `index.html`
         * @returns {string|null} `null` se la grafia non e' ricavabile
         */
        sibling(sAppId, sPath) {
            const sBase = base();
            const sMine = NAMESPACE.replace(/\//g, ".");
            const sLast = sBase.replace(/\/$/, "").split("/").pop();

            let sId = null;
            if (sLast === sMine) { sId = String(sAppId); }
            else if (sLast === sMine.replace(/\./g, "")) { sId = String(sAppId).replace(/\./g, ""); }
            if (sId === null) { return null; }

            const sParent = sBase.replace(/[^/]+\/$/, "");
            return sParent + sId + "/" + String(sPath == null ? "" : sPath).replace(/^\/+/, "");
        }
    };
});

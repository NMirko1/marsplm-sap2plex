sap.ui.define([], () => {
    "use strict";

    /**
     * [SESSION-401] Regole pure della sessione scaduta: cosa e' una scadenza, e cosa si fa.
     *
     * PERCHE' QUESTA FEATURE ESISTE. La sessione dell'approuter scade dopo un periodo di
     * inattivita' (default di `@sap/approuter`: 15 minuti; `app/router/xs-app.json` non dichiara
     * `sessionTimeout` e il modulo in `mta.yaml` non ha `env`). Scaduta la sessione l'approuter non
     * ha piu' il token da inoltrare (`forwardAuthToken: true`) e a una XHR risponde `401`: su una
     * chiamata AJAX non puo' fare il redirect all'IdP. I token XSUAA non c'entrano — `token-validity`
     * vale 12h di default, un ordine di grandezza piu' della finestra dell'approuter.
     *
     * IL PUNTO CHE DECIDE TUTTO IL DISEGNO: il `401` arriva SUL SALVA. L'utente compila per venti
     * minuti senza toccare la rete, la sessione scade in silenzio, e la prima richiesta dopo la
     * finestra e' proprio il salvataggio. Un interceptor che ricarichi la pagina su `401`
     * distruggerebbe esattamente il lavoro che era a un click dall'essere salvato: sarebbe un
     * difetto peggiore di quello che ripara. Da qui la regola non negoziabile di `decide()` —
     * con qualcosa di non salvato non si ricarica MAI.
     *
     * C'e' anche un precedente in casa che lo vieta: `[SAVE-REJECT]` ha gia' deciso che un
     * salvataggio rifiutato LASCIA le modifiche a schermo («Your changes are still on screen and
     * NOT stored»). Una sessione scaduta che ricarica contraddirebbe quella decisione.
     *
     * Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, cosi' le regole si collaudano
     * da node (`node test/sessionGuard.test.js`) come i moduli puri di `srv/lib/`. Il cablaggio —
     * patch di `fetch` e `XMLHttpRequest`, dialogo, popup, keep-alive — sta in `SessionGuard.js`,
     * che di suo non decide niente sul merito.
     *
     * Perimetro: `grep -rn "SESSION-401"`.
     */

    /**
     * Ogni quanto, al massimo, il keep-alive tocca la sessione.
     *
     * Due minuti contro i quindici della finestra: chi sta lavorando non ci arriva mai vicino, e
     * chi smette di lavorare smette di pingare — la sessione scade come oggi. E' la differenza fra
     * «tengo viva la sessione finche' c'e' un umano» e «la tengo viva per sempre», che su un
     * cockpit da cui parte `PROD_CONF` non e' un dettaglio.
     *
     * Il margine e' volutamente largo: il ping costa poche decine di byte (`/user-api/currentUser`)
     * e quello che compra e' che una sessione non muoia mentre qualcuno la sta usando. Stringerlo
     * non farebbe risparmiare niente di misurabile e riavvicinerebbe il ping alla scadenza.
     */
    const PING_INTERVAL_MS = 2 * 60 * 1000;

    /**
     * Quanto a lungo un reload appena fatto vieta il successivo.
     *
     * Senza questa guardia un `401` che NON viene dalla sessione — un ruolo revocato, un difetto
     * lato server — darebbe un ciclo di ricariche: la pagina si ricarica, riceve un altro `401`, si
     * ricarica ancora. Passata la finestra si mostra il dialogo, che almeno si puo' leggere.
     */
    const RELOAD_GUARD_MS = 60 * 1000;

    /** Dove il marcatore anti-ciclo vive: `sessionStorage`, perche' deve sopravvivere al reload. */
    const RELOAD_STAMP_KEY = "marsplm.sessionGuard.reloadedAt";

    /**
     * Bersaglio del keep-alive: una function che non fa niente, servita da CatalogService.
     *
     * ERA `/user-api/currentUser`, ED ERA INERTE DOVE SERVIVA DI PIU'. Quello e' un indirizzo
     * dell'APPROUTER, e il commento di prima diceva che qualunque esito diverso da `401` va bene,
     * «un `404` compreso» — vero per non *sbagliare*, ma non basta per *funzionare*: da Work Zone
     * la richiesta arriva alla radice del launchpad, risponde `404` e non tocca NESSUNA sessione.
     * Visto in console il 18/09/2026. Il keep-alive c'era e non teneva vivo niente, che e' peggio
     * di non averlo, perche' nessuno va a cercarlo.
     *
     * `ping()` invece passa da `srv-api`, quindi attraversa l'approuter davvero, e a sessione
     * scaduta risponde `401` — che e' il segnale su cui questa guardia esiste. Lato server non fa
     * nessuna lettura e nessun giro al license server: vedi il commento in `srv/cat-service.cds`.
     *
     * DA WORK ZONE VA CHIESTO COL PREFISSO DELL'APP, altrimenti si ripete il difetto che questa
     * riga corregge. Non e' scritto qui perche' questo file e' identico in sei app e quattro di
     * esse non hanno `AppUrl`: la base la mette `SessionGuard.install`, se chi installa gliela
     * passa. Vedi `[APP-URL]`.
     */
    const PING_URL = "/odata/v4/catalog/ping()";

    /** Le tre decisioni possibili davanti a un `401`. */
    const IGNORE = "IGNORE";
    const RELOAD = "RELOAD";
    const PROMPT = "PROMPT";

    return {

        PING_INTERVAL_MS,
        RELOAD_GUARD_MS,
        RELOAD_STAMP_KEY,
        PING_URL,
        IGNORE,
        RELOAD,
        PROMPT,

        /**
         * E' una scadenza di sessione?
         *
         * SOLO `401`. Un `403` e' «non hai il ruolo» o «il plant non e' coperto da licenza»
         * (srv/license.js): trattarlo come sessione scaduta manderebbe l'utente a riautenticarsi
         * per un problema che la riautenticazione non risolve, cioe' in un ciclo.
         *
         * @param {number} iStatus stato HTTP della risposta
         * @returns {boolean}
         */
        isSessionExpiry(iStatus) {
            return iStatus === 401;
        },

        /**
         * L'URL punta alla nostra origine?
         *
         * Si reagisce solo alle chiamate che passano dall'approuter. Un URL che non si riesce a
         * interpretare torna `false`: un dialogo mancato lascia il comportamento di oggi, un
         * dialogo di troppo interromperebbe l'utente per una chiamata che non c'entra.
         *
         * @param {string} sUrl URL assoluto o relativo
         * @param {string} sOrigin origine della pagina (`window.location.origin`)
         * @returns {boolean}
         */
        isSameOrigin(sUrl, sOrigin) {
            if (typeof sUrl !== "string" || !sUrl || typeof sOrigin !== "string" || !sOrigin) {
                return false;
            }
            try {
                return new URL(sUrl, sOrigin).origin === sOrigin;
            } catch (oErr) {
                return false;
            }
        },

        /**
         * L'URL e' quello del keep-alive?
         *
         * Il ping e' escluso dall'interceptor generico e gestito a parte: il suo `401` dichiara la
         * scadenza SUBITO — mentre le modifiche sono ancora tutte a schermo, che e' il momento
         * migliore per dirlo — invece di aspettare il Salva.
         *
         * @param {string} sUrl URL assoluto o relativo
         * @param {string} sOrigin origine della pagina
         * @returns {boolean}
         */
        isPingUrl(sUrl, sOrigin) {
            if (typeof sUrl !== "string" || !sUrl) { return false; }
            try {
                // SI CONFRONTA LA CODA, NON TUTTO IL PATH. Da Work Zone il ping esce col prefisso
                // dell'app davanti (`/<prefisso>/odata/v4/catalog/ping()`), quindi un confronto
                // secco non combacerebbe piu': il ping smetterebbe di essere escluso
                // dall'interceptor generico e il suo `401` aprirebbe il dialogo per una strada
                // diversa da quella pensata — due volte, e con il messaggio sbagliato.
                const sPath = new URL(sUrl, sOrigin || "http://localhost").pathname;
                return sPath === PING_URL || sPath.endsWith("/" + PING_URL.replace(/^\/+/, ""));
            } catch (oErr) {
                return false;
            }
        },

        /**
         * E' ora di toccare la sessione?
         *
         * Il ping non parte a orologio ma ad ATTIVITA': questa funzione dice solo se dall'ultimo e'
         * passato abbastanza tempo. Chi lascia il tab aperto e non lo tocca non genera attivita' e
         * quindi non arriva mai qui.
         *
         * @param {number} iNow adesso, in millisecondi
         * @param {number} iLastPing millisecondi dell'ultimo ping (0 se non e' mai partito)
         * @returns {boolean}
         */
        shouldPing(iNow, iLastPing) {
            if (typeof iNow !== "number" || !isFinite(iNow)) { return false; }
            if (typeof iLastPing !== "number" || !isFinite(iLastPing) || iLastPing <= 0) {
                return true;
            }
            return (iNow - iLastPing) >= PING_INTERVAL_MS;
        },

        /**
         * C'e' qualcosa di non salvato?
         *
         * NEL DUBBIO SI CONSIDERA SPORCO. Un check che lancia — un modello distrutto, un controller
         * gia' uscito — torna `true`, non `false`: la conseguenza di un falso positivo e' il
         * dialogo al posto del reload, cioe' un fastidio; quella di un falso negativo e' il reload
         * che porta via il lavoro, cioe' il difetto che questa feature esiste per evitare.
         *
         * @param {Array<Function>} aChecks funzioni che tornano `true` se hanno modifiche pendenti
         * @returns {boolean}
         */
        anyDirty(aChecks) {
            const aList = Array.isArray(aChecks) ? aChecks : [];
            return aList.some((fnCheck) => {
                if (typeof fnCheck !== "function") { return false; }
                try {
                    return !!fnCheck();
                } catch (oErr) {
                    return true;
                }
            });
        },

        /**
         * Cosa si fa davanti a un `401`.
         *
         *   | situazione                                   | esito    |
         *   |----------------------------------------------|----------|
         *   | un dialogo e' gia' aperto                     | `IGNORE` |
         *   | c'e' qualcosa di non salvato                  | `PROMPT` |
         *   | niente di non salvato, reload recente         | `PROMPT` |
         *   | niente di non salvato, nessun reload recente  | `RELOAD` |
         *
         * L'`IGNORE` non e' un dettaglio: un `$batch` o un caricamento di pagina produce N risposte
         * `401` insieme, e senza deduplicazione darebbero N dialoghi sovrapposti.
         *
         * @param {Object} o
         * @param {boolean} o.handling un dialogo e' gia' aperto
         * @param {boolean} o.dirty c'e' qualcosa di non salvato
         * @param {number} o.now adesso, in millisecondi
         * @param {number} o.reloadedAt millisecondi dell'ultimo reload fatto da qui (0 se nessuno)
         * @returns {string} `IGNORE` | `RELOAD` | `PROMPT`
         */
        decide(o) {
            const oIn = o || {};
            if (oIn.handling) { return IGNORE; }
            if (oIn.dirty) { return PROMPT; }

            const iNow = typeof oIn.now === "number" && isFinite(oIn.now) ? oIn.now : 0;
            const iStamp = typeof oIn.reloadedAt === "number" && isFinite(oIn.reloadedAt)
                ? oIn.reloadedAt : 0;
            if (iStamp > 0 && (iNow - iStamp) < RELOAD_GUARD_MS) { return PROMPT; }

            return RELOAD;
        },

        /**
         * Il popup di riautenticazione e' tornato a casa?
         *
         * Si riconosce il rientro dal fatto che il suo indirizzo e' di nuovo della NOSTRA origine:
         * finche' e' sull'IdP la lettura di `location.href` lancia (cross-origin), ed e' il
         * chiamante a intercettarlo. Qui si decide solo sul valore letto.
         *
         * @param {string} sHref indirizzo corrente del popup
         * @param {string} sOrigin origine della pagina
         * @returns {boolean}
         */
        isBackHome(sHref, sOrigin) {
            if (typeof sHref !== "string" || !sHref || sHref === "about:blank") { return false; }
            try {
                return new URL(sHref).origin === sOrigin;
            } catch (oErr) {
                return false;
            }
        }
    };
});

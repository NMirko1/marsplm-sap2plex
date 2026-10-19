sap.ui.define([
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "./sessionGuardRules"
], (MessageBox, MessageToast, Rules) => {
    "use strict";

    // ================================================================
    // [SESSION-401] La sessione scaduta si dichiara, e non porta via il lavoro.
    //
    // COSA FA. Intercetta i `401` che arrivano dall'approuter quando la sessione e' scaduta, e
    // invece dell'errore tecnico di oggi mostra un dialogo da cui si riprende la sessione senza
    // perdere quello che si stava facendo. In piu' tiene viva la sessione finche' l'utente sta
    // effettivamente lavorando, cosi' il dialogo si vede molto di rado.
    //
    // QUESTO MODULO NON DECIDE NIENTE SUL MERITO: le regole — cosa e' una scadenza, quando si
    // ricarica e quando no, quando ripingare — stanno in `sessionGuardRules.js`, puro e con il suo
    // test node. Qui c'e' solo il cablaggio: le due patch, il dialogo, il popup, gli ascolti.
    //
    // PERCHE' SI PATCHANO DUE CANALI E NON UNO. Le ~70 `fetch` grezze del progetto passano da
    // `window.fetch`; i modelli OData di UI5 no, vanno su `XMLHttpRequest`. Patchando solo la
    // prima il `401` dei binding NON si vedrebbe — ed e' il difetto silenzioso da evitare, perche'
    // una lista che non si popola si legge come «non ci sono dati».
    //
    // LA PATCH NON CAMBIA NIENTE A VALLE. La risposta si restituisce INTATTA: nessun `catch`,
    // nessun `r.ok`, nessun handler di errore esistente cambia comportamento. Questo modulo
    // osserva e basta.
    //
    // PERCHE' UNA COPIA IN OGNI APP. Le sei app sono artefatti deployati separatamente e non
    // possono richiedersi moduli a vicenda: la condivisione e' una copia, e una copia si sorveglia
    // — `test/sessionGuard.test.js` verifica che le sei siano identiche byte per byte, come gia'
    // fa `test/adminColumnMenu.test.js` per `columnSortRules.js` (DEC-102).
    //
    // Perimetro: grep -rn "SESSION-401"
    // ================================================================

    /** Marcatore di installazione: `install()` e' idempotente, le patch si mettono UNA volta. */
    const INSTALLED_FLAG = "__marsplmSessionGuardInstalled";

    /**
     * Dove porta il popup di riautenticazione.
     *
     * La radice basta: qualunque navigazione del browser verso l'approuter senza sessione fa
     * scattare il redirect OAuth, e di norma la sessione IdP e' ancora viva, quindi il giro si
     * chiude da solo e il popup atterra su una pagina della NOSTRA origine — che e' il segnale di
     * rientro.
     */
    const REAUTH_URL = "/";

    /** Ogni quanto si guarda se il popup e' rientrato, e per quanto al massimo lo si aspetta. */
    const REAUTH_POLL_MS = 500;
    const REAUTH_TIMEOUT_MS = 3 * 60 * 1000;

    /** Eventi che contano come «c'e' un umano che sta lavorando». */
    const ACTIVITY_EVENTS = ["keydown", "mousedown", "touchstart"];

    /** Stato del modulo. Vive quanto la pagina. */
    const oState = {
        bundle: null,
        component: null,
        /** Nome → funzione che dice se ci sono modifiche non salvate. */
        dirtyChecks: new Map(),
        /** Un dialogo e' aperto: i `401` che arrivano nel frattempo non ne aprono altri. */
        handling: false,
        lastPing: 0,
        /** `fetch` originale, tenuta per il ping: il ping non deve passare dalla patch. */
        rawFetch: null,
        /**
         * [APP-URL] Come si mette la base dell'app davanti al path del ping.
         *
         * E' UN PARAMETRO E NON UNA COSTANTE perche' questo file e' identico byte per byte in sei
         * app, e solo due di esse — quelle che si aprono da Work Zone — hanno `AppUrl`. Le altre
         * quattro vivono sul link diretto, dove l'assoluto e' l'indirizzo giusto: non passano
         * niente e prendono il ripiego qui sotto.
         */
        urlOf: (s) => s
    };

    /**
     * Accoglie il bundle, che puo' arrivare gia' pronto o come promessa.
     *
     * `getResourceBundle()` restituisce una PROMESSA quando il modello di risorse e' asincrono, e
     * le sei app dichiarano `IAsyncContentCreation`. Una promessa messa in `oState.bundle` non
     * lancerebbe: `text()` la intercetterebbe e mostrerebbe la CHIAVE al posto della frase, in
     * silenzio — cioe' un dialogo intitolato `sessionExpiredTitle`. Si distingue qui, una volta.
     */
    function acceptBundle(vBundle) {
        if (!vBundle) { return; }
        if (typeof vBundle.then === "function") {
            vBundle.then((oBundle) => { oState.bundle = oBundle; }).catch(() => { /* resta la chiave */ });
            return;
        }
        oState.bundle = vBundle;
    }

    /**
     * Testo i18n, tollerante: senza bundle si mostra la chiave invece di lanciare.
     *
     * Il bundle si cerca PIGRAMENTE sul componente se non e' stato passato: i testi servono solo
     * quando si apre il dialogo, cioe' molto dopo l'`init()`, e cosi' non c'e' nessuna domanda su
     * quando il modello di risorse sia pronto. Cercarlo all'installazione e trovarlo assente
     * avrebbe dato un dialogo intitolato `sessionExpiredTitle`, senza errori.
     */
    function text(sKey, aArgs) {
        try {
            if (!oState.bundle && oState.component) {
                const oI18n = oState.component.getModel("i18n");
                acceptBundle(oI18n && oI18n.getResourceBundle());
            }
            return oState.bundle ? oState.bundle.getText(sKey, aArgs) : sKey;
        } catch (oErr) {
            return sKey;
        }
    }

    /** `sessionStorage` puo' lanciare (private browsing, cookie di sito bloccati): mai propagare. */
    function readReloadStamp() {
        try {
            const sValue = window.sessionStorage.getItem(Rules.RELOAD_STAMP_KEY);
            const iValue = parseInt(sValue, 10);
            return isFinite(iValue) ? iValue : 0;
        } catch (oErr) {
            return 0;
        }
    }

    function writeReloadStamp(iNow) {
        try {
            window.sessionStorage.setItem(Rules.RELOAD_STAMP_KEY, String(iNow));
        } catch (oErr) {
            // Senza marcatore si perde solo la guardia anti-ciclo: non e' una ragione per fermarsi.
        }
    }

    /**
     * Le modifiche non salvate dei modelli DICHIARATI NEL MANIFEST.
     *
     * Si passa dal manifest e non da un elenco scritto a mano perche' un elenco a mano si dimentica
     * di aggiornarlo: cosi' un modello aggiunto domani e' coperto da solo. I `JSONModel` non hanno
     * `hasPendingChanges` e vengono saltati — per loro c'e' `registerDirtyCheck`.
     *
     * Copre da sola le quattro app Fiori Elements e la configurazione plant.
     */
    function componentDirty() {
        const oComponent = oState.component;
        if (!oComponent || typeof oComponent.getManifestEntry !== "function") { return false; }

        const oUi5 = oComponent.getManifestEntry("sap.ui5") || {};
        const oModels = oUi5.models || {};

        return Object.keys(oModels).some((sName) => {
            // Il modello di default e' dichiarato col nome vuoto, ma si chiede senza nome.
            const oModel = oComponent.getModel(sName === "" ? undefined : sName);
            return !!(oModel
                && typeof oModel.hasPendingChanges === "function"
                && oModel.hasPendingChanges());
        });
    }

    /** Tutti i check, generico e registrati. `Rules.anyDirty` tratta un check che lancia come sporco. */
    function isDirty() {
        const aChecks = [componentDirty].concat(Array.from(oState.dirtyChecks.values()));
        return Rules.anyDirty(aChecks);
    }

    // ----------------------------------------------------------------
    // Riautenticazione
    // ----------------------------------------------------------------

    /**
     * Riapre il login in un popup e aspetta che rientri.
     *
     * PERCHE' UN POPUP E NON UN IFRAME NASCOSTO. Un iframe sarebbe silenzioso ma non e'
     * affidabile: gli IdP mandano `X-Frame-Options` e il giro si fermerebbe senza dire niente. Il
     * popup nasce da un click dell'utente, quindi non viene bloccato, e se il browser lo blocca
     * comunque lo si dichiara invece di restare in attesa.
     *
     * NON SI RITENTA LA RICHIESTA FALLITA. Le modifiche V4 restano pendenti e il `/dirty` degli
     * alberi del cockpit pure: la strada onesta e' che l'utente ripremia Salva, non che il modulo
     * provi a ricostruire una richiesta che non conosce.
     */
    function reauthenticate(fnDone) {
        let oPopup = null;
        try {
            oPopup = window.open(REAUTH_URL, "marsplmReauth", "width=520,height=680");
        } catch (oErr) {
            oPopup = null;
        }

        if (!oPopup) {
            MessageBox.warning(text("sessionPopupBlocked"), { title: text("sessionExpiredTitle") });
            fnDone(false);
            return;
        }

        const iStarted = Date.now();
        const iTimer = window.setInterval(() => {
            let bBack = false;
            try {
                // Finche' il popup e' sull'IdP questa lettura LANCIA: e' cross-origin, ed e' il
                // modo in cui si sa che il giro non e' ancora finito.
                bBack = Rules.isBackHome(oPopup.location.href, window.location.origin);
            } catch (oErr) {
                bBack = false;
            }

            if (oPopup.closed) {
                window.clearInterval(iTimer);
                fnDone(false);
                return;
            }
            if (bBack) {
                window.clearInterval(iTimer);
                try { oPopup.close(); } catch (oErr) { /* gia' chiuso */ }
                fnDone(true);
                return;
            }
            if ((Date.now() - iStarted) > REAUTH_TIMEOUT_MS) {
                window.clearInterval(iTimer);
                fnDone(false);
            }
        }, REAUTH_POLL_MS);
    }

    /** Ricarica, lasciando il marcatore che vieta un secondo reload immediato. */
    function reload() {
        writeReloadStamp(Date.now());
        window.location.reload();
    }

    /**
     * Il dialogo.
     *
     * Il testo cambia con lo stato non salvato perche' l'informazione che conta e' diversa: con
     * modifiche a schermo la cosa da dire e' che NON sono state salvate e che sono ancora li'.
     * «Ricarica» compare solo quando non c'e' niente da perdere: offrirla con modifiche aperte
     * sarebbe mettere il pulsante che cancella il lavoro accanto a quello che lo salva.
     */
    function prompt(bDirty) {
        const sReconnect = text("sessionReconnect");
        const sReload = text("sessionReload");
        const aActions = bDirty
            ? [sReconnect, MessageBox.Action.CANCEL]
            : [sReconnect, sReload, MessageBox.Action.CANCEL];

        MessageBox.warning(text(bDirty ? "sessionExpiredDirty" : "sessionExpiredClean"), {
            title: text("sessionExpiredTitle"),
            actions: aActions,
            emphasizedAction: sReconnect,
            onClose(sAction) {
                if (sAction === sReload) {
                    reload();
                    return;
                }
                if (sAction !== sReconnect) {
                    // Chiuso senza scegliere: si riarma, cosi' il prossimo `401` ridice le cose.
                    oState.handling = false;
                    return;
                }
                reauthenticate((bOk) => {
                    oState.handling = false;
                    if (!bOk) { return; }
                    if (bDirty) {
                        MessageToast.show(text("sessionRestored"));
                    } else {
                        reload();
                    }
                });
            }
        });
    }

    /**
     * Il punto unico in cui una scadenza produce un effetto.
     *
     * Tutto quello che decide sta in `Rules.decide`: qui si eseguono i tre esiti.
     */
    function onUnauthorized() {
        // Si legge UNA volta: `decide` e il dialogo devono guardare lo stesso stato, o il primo
        // potrebbe autorizzare il reload e il secondo mostrare il testo delle modifiche aperte.
        const bDirty = isDirty();

        const sDecision = Rules.decide({
            handling: oState.handling,
            dirty: bDirty,
            now: Date.now(),
            reloadedAt: readReloadStamp()
        });

        if (sDecision === Rules.IGNORE) { return; }

        oState.handling = true;

        if (sDecision === Rules.RELOAD) {
            reload();
            return;
        }
        prompt(bDirty);
    }

    /** Una risposta osservata: si reagisce solo a un `401` same-origin che non sia il ping. */
    function observe(sUrl, iStatus) {
        const sOrigin = window.location.origin;
        if (!Rules.isSessionExpiry(iStatus)) { return; }
        if (!Rules.isSameOrigin(sUrl, sOrigin)) { return; }
        if (Rules.isPingUrl(sUrl, sOrigin)) { return; }
        onUnauthorized();
    }

    // ----------------------------------------------------------------
    // Le due patch
    // ----------------------------------------------------------------

    function urlOf(vInput) {
        if (typeof vInput === "string") { return vInput; }
        if (vInput && typeof vInput.url === "string") { return vInput.url; }
        return "";
    }

    function patchFetch() {
        const fnFetch = window.fetch;
        if (typeof fnFetch !== "function") { return; }
        oState.rawFetch = fnFetch.bind(window);

        window.fetch = function (vInput) {
            const sUrl = urlOf(vInput);
            return fnFetch.apply(this, arguments).then((oResponse) => {
                try {
                    observe(sUrl, oResponse && oResponse.status);
                } catch (oErr) {
                    // Un difetto qui dentro non deve mai rompere la richiesta di chi ci passa.
                }
                return oResponse;
            });
        };
    }

    function patchXhr() {
        const oProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (!oProto) { return; }

        const fnOpen = oProto.open;
        const fnSend = oProto.send;

        oProto.open = function (sMethod, sUrl) {
            this.__marsplmUrl = sUrl;
            return fnOpen.apply(this, arguments);
        };

        oProto.send = function () {
            this.addEventListener("load", function () {
                try {
                    observe(this.__marsplmUrl, this.status);
                } catch (oErr) {
                    // idem: mai propagare.
                }
            });
            return fnSend.apply(this, arguments);
        };
    }

    // ----------------------------------------------------------------
    // Keep-alive legato all'attivita'
    // ----------------------------------------------------------------

    /**
     * Tocca la sessione, al massimo una volta ogni `PING_INTERVAL_MS`, e SOLO su attivita' reale.
     *
     * Il ping usa la `fetch` ORIGINALE e non quella patchata: il suo `401` si gestisce qui, perche'
     * dichiara la scadenza SUBITO — mentre le modifiche sono ancora tutte a schermo, che e' il
     * momento migliore per dirlo — invece di aspettare il Salva.
     */
    function onActivity() {
        const iNow = Date.now();
        if (!Rules.shouldPing(iNow, oState.lastPing)) { return; }
        oState.lastPing = iNow;

        const fnFetch = oState.rawFetch || window.fetch;
        try {
            fnFetch(oState.urlOf(Rules.PING_URL), { method: "GET", cache: "no-store" }).then((oResponse) => {
                if (oResponse && Rules.isSessionExpiry(oResponse.status)) { onUnauthorized(); }
            }).catch(() => {
                // Rete assente o giu': non e' una scadenza di sessione e non si dichiara niente.
            });
        } catch (oErr) {
            // idem.
        }
    }

    function installKeepAlive() {
        ACTIVITY_EVENTS.forEach((sEvent) => {
            document.addEventListener(sEvent, onActivity, { capture: true, passive: true });
        });
    }

    return {

        /**
         * Installa la guardia. Idempotente: chiamarla due volte non raddoppia le patch.
         *
         * @param {Object} o
         * @param {sap.ui.core.Component} o.component il componente dell'app, per i modelli del manifest
         * @param {sap.base.i18n.ResourceBundle|Promise} o.bundle il bundle i18n dell'app, o la sua promessa
         * @param {function(string):string} [o.urlOf] [APP-URL] `AppUrl.url` nelle app che si aprono
         *        da Work Zone, dove il ping deve portare il prefisso dell'app o non tocca nessuna
         *        sessione. Omesso nelle app da link diretto, dove l'assoluto e' l'indirizzo giusto.
         */
        install(o) {
            const oIn = o || {};
            oState.component = oIn.component || oState.component;
            if (typeof oIn.urlOf === "function") { oState.urlOf = oIn.urlOf; }
            acceptBundle(oIn.bundle);

            if (window[INSTALLED_FLAG]) { return; }
            window[INSTALLED_FLAG] = true;

            patchFetch();
            patchXhr();
            installKeepAlive();

            // Simulazione per il collaudo a mano: entra nel ramo di scadenza SENZA emettere
            // nessuna richiesta. Non e' una sonda (DEC-72): non parte niente da sola e non c'e'
            // nessun sistema esterno da interrogare.
            window.sessionGuardSimulate = onUnauthorized;
        },

        /**
         * Dichiara un controllo di modifiche non salvate che il manifest non puo' vedere.
         *
         * Serve ai `JSONModel` di vista — gli alberi del ciclo Plex del cockpit, che tengono il
         * loro stato in `/dirty`. La registrazione e' PER NOME, cosi' una seconda registrazione
         * dello stesso controller sostituisce la prima invece di accumulare check su modelli
         * ormai distrutti.
         *
         * @param {string} sName nome stabile del controllo
         * @param {Function} fnCheck torna `true` se ci sono modifiche non salvate
         */
        registerDirtyCheck(sName, fnCheck) {
            if (!sName || typeof fnCheck !== "function") { return; }
            oState.dirtyChecks.set(sName, fnCheck);
        },

        /** Toglie un controllo registrato. */
        unregisterDirtyCheck(sName) {
            oState.dirtyChecks.delete(sName);
        }
    };
});

sap.ui.define([], () => {
    "use strict";

    // ================================================================
    // [LOG-MSG-I18N] La lingua con cui si chiedono gli storici invii (feature 0029).
    //
    // I tre storici — dettaglio materiale, dettaglio ciclo, dettaglio ordine — si leggono con una
    // `fetch` grezza su `/odata/v4/log/...`, e dalla 0029 il testo della colonna «Messaggio» viene
    // RESO DAL SERVER nella lingua della richiesta. Quindi la richiesta la lingua deve dirla.
    //
    // PERCHE' NON BASTAVA LASCIAR FARE AL BROWSER, ED E' IL PUNTO. Senza intestazione CAP ricade
    // sull'`Accept-Language` che il browser manda da solo, che DI SOLITO coincide con la lingua di
    // UI5 — ed e' esattamente per questo che va dichiarata: su una macchina dove le due coincidono
    // il difetto non si vede, e si presenterebbe solo dall'utente che ha il browser in una lingua e
    // l'applicazione in un'altra. Un caso che nessuno riesce a riprodurre.
    //
    // PERCHE' L'INTESTAZIONE E NON `sap-language` NELL'URL. `Accept-Language` e' il canale HTTP
    // standard, quello che CAP guarda per primo quando non c'e' un'esplicita richiesta di lingua
    // SAP, e non chiede di tradurre un codice: `sap-language` vuole i codici lingua SAP a una o due
    // lettere, che sono un'altra tabella e un'altra occasione di sbagliare. Il lato server tollera
    // comunque la regione (`it-IT` → `it`, vedi `localeChain` in srv/lib/i18nMessages.js), perche'
    // quello che UI5 restituisce dipende dal browser.
    //
    // Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, come `util/columnSortRules.js`
    // e `util/ApprovedWcConflicts.js`. Test: `node test/logLanguage.test.js`.
    // ================================================================

    /**
     * La lingua dell'applicazione UI5, o '' se non si riesce a determinarla.
     *
     * Due strade, perche' l'API e' cambiata: `sap/base/i18n/Localization` e' quella corrente e
     * `Configuration.getLanguage()` quella storica. Entrambe in try/catch e con un ritorno vuoto
     * come ultima uscita: una lingua che non si sa e' un problema minore — il server ricade
     * sull'`Accept-Language` del browser, cioe' sul comportamento di prima — mentre un'eccezione qui
     * impedirebbe di caricare lo storico, che e' la ragione per cui la schermata e' aperta.
     *
     * @returns {string} p.es. 'it', 'it-IT', 'en'
     */
    function uiLanguage() {
        try {
            const Localization = sap.ui.require("sap/base/i18n/Localization");
            if (Localization && typeof Localization.getLanguage === "function") {
                return Localization.getLanguage() || "";
            }
        } catch (e) {
            // si prova la strada storica
        }
        try {
            return sap.ui.getCore().getConfiguration().getLanguage() || "";
        } catch (e) {
            return "";
        }
    }

    /**
     * Le intestazioni per una lettura degli storici invii.
     *
     * `Accept-Language` si omette quando la lingua non si conosce: mandarla vuota direbbe al server
     * «nessuna preferenza», che non e' la stessa cosa di «non l'ho chiesta» — nel secondo caso
     * l'`Accept-Language` del browser resta valido, nel primo lo sovrascriveremmo con niente.
     *
     * @param {string} [sLanguage] se assente, la lingua dell'applicazione
     * @returns {Object} intestazioni da passare a `fetch`
     */
    function logHeaders(sLanguage) {
        const sLang = (sLanguage === undefined ? uiLanguage() : sLanguage) || "";
        const oHeaders = { "Accept": "application/json" };
        if (sLang) oHeaders["Accept-Language"] = sLang;
        return oHeaders;
    }

    return { uiLanguage, logHeaders };
});

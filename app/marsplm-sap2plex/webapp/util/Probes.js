/**
 * [PROBE] Le sonde di diagnosi verso SAP Integration Suite, e il loro innesco A MANO.
 *
 * QUESTO MODULO NON FA NESSUNA CHIAMATA QUANDO VIENE CARICATO. `install()` registra soltanto i
 * comandi di console e stampa una riga: da li' in avanti ogni sonda parte quando qualcuno la
 * chiama, e mai perche' una schermata si e' aperta.
 *
 * PERCHE' STANNO QUI E NON PIU' NELLA onInit DELLA DASHBOARD (W1-20, docs/GAP-WAVE1-BBP.md).
 * Fino a oggi cinque sonde partivano all'apertura del cockpit — e quindi anche a ogni refresh, a
 * ogni riapertura della scheda, a ogni utente che apriva l'app. Tre di quelle cinque SCRIVONO in
 * SAP: un movimento merci col payload MOCK, sei varianti di time ticket VERO sull'ordine
 * 700000080 (storno manuale in CO13, non esiste un IV_TEST_RUN), e le due FM di chiusura ordine,
 * che su un ordine vero lo chiuderebbero davvero. Le altre due leggono, ma sono 8-10 letture
 * verso l'Integration Suite a ogni apertura, cioe' altrettante voci nel monitor di CPI.
 *
 * LE SONDE NON SI CANCELLANO. Il loro valore sta nel poterle rilanciare il giorno in cui un
 * indirizzo smette di rispondere: ognuna porta con se' il caso di prova concordato, la lettura
 * dell'esito e il verdetto da girare al team Integration. Toglierle significherebbe riscriverle
 * da capo alla prossima domanda. Quindi restano intere, qui, dietro un comando esplicito.
 *
 * PERCHE' E' SICURO ESPORRE ANCHE LE DUE CHE SCRIVONO. Il browser non sceglie NIENTE di cio' che
 * viene mandato: l'ordine lo decide il server, il payload del movimento merci e' la costante `MOCK`
 * passata dall'handler dell'action (srv/lib/materialDocPost.js), e da qui non si puo' puntare una
 * sonda su un oggetto vero. `orderStatusPost` scrive su un ordine INESISTENTE e in PRODUZIONE e'
 * comunque inerte: `ORDER_STATUS_POST=off` e' impostata sul modulo srv in mta.yaml, quindi risponde
 * `OFF` senza mandare niente. In locale resta accesa, ed e' li' che la sonda serve. `MATDOC_POST`
 * invece e' ACCESA di proposito: dalla 0021 quel modulo e' il flusso vero dei documenti materiale
 * del job PROD_CONF, e spegnerla fermerebbe l'esercizio, non una sonda (DEC-72).
 *
 * ERANO TRE, ED E' USCITA LA CONFERMA D'ORDINE. La sonda `prodOrderConfPost` mandava la stessa
 * conferma in sei forme su un ordine VERO — nessun `IV_TEST_RUN`, storno solo in CO13 — e la
 * domanda che le aveva dato origine («quale forma vuole questo endpoint?») ha una risposta dal
 * 02/09/2026, scritta in DEC-119. Per DEC-123 una sonda si toglie allora, e con lei e' uscita
 * `PRODCONF_POST`: quella leva non era piu' solo la sua, perche' la 0030 l'aveva messa anche sopra
 * il flusso vero delle conferme.
 *
 * Uso dai controller:
 *   Probes.install();   // una volta, nella onInit della dashboard. NON chiama nessuna sonda.
 *
 * e poi, dalla console del browser:
 *   window.splitJobProbe('<ordine>')                      legge un job su PLEX: dove si rompe
 *                                                         GET /scheduling/v1/jobs?jobNumber=
 *   window.jobSchedProbe('<ordine>')                      legge le precondizioni del passo 5:
 *                                                         QUALE campo e' nullo nel 500 del
 *                                                         backwards-schedule
 *   window.plexHistoryProbe()                             legge da PLEX registrazioni di
 *                                                         produzione e scarti degli ultimi 15
 *                                                         minuti: cosa torna, crudo
 *   window.orderStatusPost() / window.orderStatusPost(true)   SCRIVONO (chiusura + TECO)
 *   window.matDocPost()                                       SCRIVE (movimento merci)
 *
 * Il 03/09/2026 sono sparite di qui le due sonde di lettura verso Integration Suite
 * (classificazione e distinta base) e quella del canale ordini: le prime due perche' i contratti
 * che misuravano sono confermati, la terza perche' aveva risposto (DEC-123). Con loro se ne sono
 * andati `window.probeVerbose` e le varianti `...Full()`. Con lo stesso criterio e' poi uscita
 * `window.prodOrderConfPost()`, la batteria della conferma d'ordine: vedi il blocco qui sotto.
 *
 * Nessuna sonda mostra niente all'utente e nessuna fa mai fallire una schermata: l'esito finisce
 * tutto in console, e le letture anche in window.isCalls() ([IS-CALL-LOG]).
 * Perimetro: grep -rn "PROBE".
 */
sap.ui.define([
    // [APP-URL] Ogni URL verso il nostro backend porta davanti la base dell'app:
    // servita da Work Zone l'app sta sotto un prefisso, e un path assoluto non lo porta.
    "avvaleplm/marsplm/sap2plex/main/util/AppUrl"
], (AppUrl) => {
    "use strict";

    let bInstalled = false;

    /**
     * [PROBE-LOG] Il VERDETTO di una sonda, che arriva come blocco a righe:
     *
     *   ESITO  <cosa e' successo>
     *   MOSSA  <cosa fare adesso>
     *   CASO   <i valori usati>
     *     · <fatto>
     *
     * Stamparlo come stringa unica lo rendeva un paragrafo di quindici righe in cui la
     * conclusione stava alla pari di una nota di dettaglio. Le prime due righe sono quelle
     * che vanno lette: in grassetto, e la MOSSA in blu perche' e' l'unica azionabile.
     */
    function _printVerdetto(sWhat) {
        const aRighe = String(sWhat || "").split("\n");
        aRighe.forEach((s) => {
            if (s.indexOf("ESITO ") === 0) {
                console.log("%c" + s, "font-weight:bold");
            } else if (s.indexOf("MOSSA ") === 0) {
                console.log("%c" + s, "color:#0a58ca;font-weight:bold");
            } else {
                console.log(s);
            }
        });
    }

    // ================================================================
    // [MATDOC-POST] Registrazione movimento merci verso l'iFlow IS. SONDA CHE SCRIVE.
    // Endpoint: POST /products/postMaterialDoc  (action, non function: scrive verso SAP,
    // quindi non deve poter essere aperta in una tab ne' riemessa da un refresh).
    // Verso il NOSTRO backend non serve token CSRF: la rotta srv-api dell'approuter ha
    // "csrfProtection": false (app/router/xs-app.json), come gia' per onSendToPlex. Il
    // CSRF verso Cloud Integration e' tutt'altra cosa e lo gestisce il server.
    //
    // COSA MANDA: il payload lo decide il SERVER, non questo modulo — e' la costante `MOCK` che
    // l'handler dell'action passa esplicitamente a postMaterialDoc(), con materiali MOCK-COMP-*.
    // Da qui non si puo' mandare un movimento vero. E finche' ZPlant.MatDocPostEnabled non e'
    // `true` sul plant delle righe, IV_TEST_RUN vale 'X': SAP valida senza registrare.
    // Leve lato server: MATDOC_POST=off, MATDOC_POST_CSRF=off, MATDOC_POST_TESTRUN=off.
    // Contratto: srv/external/ZMARS_MATDOC_POST_CONTRACT.md
    // ================================================================
    function _postMaterialDoc() {
        fetch(AppUrl.url("/products/postMaterialDoc"), {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: "{}"
        })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then(d => {
                console.group("%c[MATDOC-POST] POST movimento merci -> SAP Integration Suite", "font-weight:bold");
                if (!d.enabled) {
                    console.warn("chiamata SPENTA (MATDOC_POST=off): niente e' stato inviato");
                    console.groupEnd();
                    return;
                }
                console.log("URL chiamato       :", d.url);
                console.log("destination        :", d.destination);
                console.log("righe inviate      :", d.itemCount, "(in UN'UNICA chiamata)");
                console.log("IV_TEST_RUN        :", d.testRun === "X"
                    ? '"X" — valida SENZA registrare'
                    : '"" — REGISTRA DAVVERO in SAP');
                console.log("deciso da          :", d.testRunSource,
                    d.plants ? "| plant nelle righe: " + d.plants : "");
                console.log("csrf               :", d.csrf
                    ? "fetch attivo, token ottenuto: " + (d.csrfTokenObtained ? "SI" : "NO")
                    : "disattivato (MATDOC_POST_CSRF=off)");
                console.log("x-correlation-id   :", d.correlationId || "(assente)");
                console.log("durata             :", d.ms, "ms");
                // Oggetto navigabile, non stringa: e' il body da mostrare al team Integration.
                try {
                    console.log("BODY INVIATO       :", JSON.parse(d.requestBody));
                } catch (e) {
                    console.log("BODY INVIATO       :", d.requestBody);
                }
                if (d.outcome === "OK") {
                    console.log("%cESITO OK" + (d.warn ? " CON AVVISO" : ""),
                        "color:green;font-weight:bold");
                    console.log("documento creato   :", d.materialDocument + "/" + d.materialDocumentYear);
                    if (d.message) {
                        console.log("messaggio          :", d.messageType,
                            (d.messageRow ? "riga " + d.messageRow + ": " : "") + d.message);
                    }
                } else {
                    console.error("ESITO KO" + (d.httpStatus ? " - HTTP " + d.httpStatus : ""));
                    if (d.mplId) {
                        console.error("%cMPL ID             : " + d.mplId,
                            "font-weight:bold",
                            "<- con questo il team Integration apre l'esecuzione fallita nel monitor CPI");
                    }
                    if (d.reason) console.error("motivo             :", d.reason);
                    if (d.message) {
                        console.error("SAP dice           :", d.messageType,
                            (d.messageRow ? "riga " + d.messageRow + ": " : "") + d.message);
                    }
                    if (d.error) console.error("errore             :", d.error);
                    console.error("header inviati     :", d.requestHeaders || "(nessuno)");
                    console.error("header ricevuti    :", d.responseHeaders || "(nessuno)");
                    console.error("body ricevuto      :", d.responseBody || "(vuoto)");
                    if (d.httpStatus === 403) {
                        // Su Cloud Integration il 403 ha due cause opposte e il discriminante
                        // e' se il token CSRF e' stato davvero ottenuto.
                        if (!d.csrf) {
                            console.warn("=> fetch CSRF disattivato. Il runtime CPI protegge l'adapter HTTPS "
                                + "sender per default: con MATDOC_POST_CSRF=off questo 403 e' atteso.");
                        } else if (d.csrfTokenObtained) {
                            console.warn("=> Token CSRF ottenuto e 403 lo stesso: NON e' CSRF. E' autorizzazione, "
                                + "tipicamente il ruolo ESBMessaging.send mancante sul client della destination.");
                        } else {
                            console.warn("=> Token CSRF NON ottenuto: respinta anche la richiesta di fetch. "
                                + "Guardare l'autorizzazione del client (ESBMessaging.send) prima del payload. "
                                + "Se 'header ricevuti' mostra x-csrf-token: Required, e' il CsrfPreventionFilter.");
                        }
                    } else if (d.messageType) {
                        // C'e' un messaggio applicativo: il messaggio ha attraversato l'iFlow ed
                        // e' arrivato al BAPI. Con dati MOCK-* e' l'esito che ci aspettiamo.
                        console.warn("=> Il messaggio e' ARRIVATO AL BAPI: l'integrazione funziona. "
                            + "Con materiali MOCK-* un errore applicativo e' normale — mancano i dati veri.");
                    } else if (d.httpStatus === 404) {
                        console.warn("=> L'indirizzo non risponde: verificare che l'iFlow sia deployato e che "
                            + "il path sia ancora " + d.path);
                    } else if (d.mplId) {
                        // Un MPL esiste solo per messaggi che il runtime ha accettato: siamo dentro.
                        console.warn("=> Il messaggio e' stato ACCETTATO ed elaborato: l'MPL esiste solo per i "
                            + "messaggi presi in carico. Il punto di rottura e' dentro l'iFlow o a valle. "
                            + "Da girare a IS: MPL ID, correlation id e il body inviato qui sopra.");
                    } else {
                        console.warn("=> Nessun messaggio applicativo e nessun MPL ID: il messaggio non e' stato "
                            + "preso in carico. Si gira loro il body inviato qui sopra col correlation id.");
                    }
                    console.warn("Il body inviato qui sopra e' esattamente cio' che riceve IS: cercalo nel loro "
                        + "monitor col correlation id.");
                }
                console.groupEnd();
            })
            .catch(e => console.error("[MATDOC-POST] chiamata non eseguita:", e.message));
    }
    // ================================================================
    // [MATDOC-POST] fine
    // ================================================================

    // ================================================================
    // [ORDER-STATUS-POST] Chiusura ordine e chiusura tecnica verso i due iFlow IS. SONDA CHE
    // SCRIVE, su un ordine INESISTENTE.
    // Endpoint: POST /production-orders/postProdOrderStatus  (action, non function:
    // scrive verso SAP, quindi non deve poter essere aperta in una tab ne' riemessa da
    // un refresh). Verso il NOSTRO backend non serve token CSRF: la rotta srv-api
    // dell'approuter ha "csrfProtection": false (app/router/xs-app.json). Il CSRF verso
    // Cloud Integration e' tutt'altra cosa e lo gestisce il server.
    //
    // I due indirizzi sono pubblicati da tempo (EndpointFlussiMARS_V1.xlsx, righe N.20 e N.21):
    // la sonda dice se rispondono e se il messaggio arriva alla function module in ECC. L'ordine
    // lo decide il SERVER ed e' inesistente — le due FM non hanno un IV_TEST_RUN, e su un ordine
    // vero CloseOrder lo CHIUDE e TechlyCmpltOrder lo mette in TECO. In produzione la leva sta a
    // `off` (mta.yaml).
    //
    // `Full` aggiunge i CONTROLLI (apici, corpo, $metadata): window.orderStatusPost(true).
    // Leve lato server: ORDER_STATUS_POST=off, _SHAPE, _CSRF=off, _METADATA=off,
    // _CLOSE_PATH, _TECO_PATH, _CLOSE_FI, _TECO_FI, _ORDER (emergenza).
    // Contratto: srv/external/PROD_ORDER_STATUS_POST_IS.md
    // ================================================================
    function _postProdOrderStatus(bFull) {
        fetch(AppUrl.url("/production-orders/postProdOrderStatus"), {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ Full: bFull === true })
        })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then(d => {
                // Una action che ritorna `array of` arriva dentro `value`.
                const aRighe = (d && d.value) || [];
                const oTesta = aRighe[0] || {};
                console.group("%c[ORDER-STATUS-POST] POST chiusura + TECO -> SAP Integration Suite",
                    "font-weight:bold");
                if (oTesta.id === "OFF" || oTesta.enabled === false) {
                    console.warn("sonda SPENTA (ORDER_STATUS_POST=off): niente e' stato inviato");
                    console.groupEnd();
                    return;
                }
                // Il verdetto arriva come blocco a righe: ESITO / MOSSA / CASO / · fatti.
                _printVerdetto(oTesta.what);
                console.log("ordine             :", oTesta.orderId, "-", oTesta.orderSource);
                if (oTesta.orderForced) {
                    console.warn("%cORDER_STATUS_POST_ORDER e' impostata: se quell'ordine ESISTE, questa "
                        + "chiamata lo CHIUDE davvero in SAP.", "color:red;font-weight:bold");
                }
                console.log("forma / scala      :", oTesta.shape,
                    oTesta.full ? "| scala completa" : "| giro normale (2 chiamate)");
                console.log("csrf               :", oTesta.csrf ? "fetch attivo" : "disattivato");
                console.log("x-correlation-id   :", oTesta.correlationId || "(assente)");

                // Tutte le righe, non solo le KO: qui ce ne sono due, e la principale che
                // RIESCE e' il risultato dell'esercizio, non rumore da comprimere.
                aRighe.slice(1).forEach(r => {
                    const sCapo = r.id + "  [" + (r.depth || "-") + "]  " + r.method + " " + r.request;
                    if (r.alarm) {
                        console.error("%c" + sCapo, "color:red;font-weight:bold");
                    } else if (r.ok) {
                        console.log("%c" + sCapo, "color:green;font-weight:bold");
                    } else {
                        console.warn(sCapo + (r.httpStatus ? "  HTTP " + r.httpStatus : ""));
                    }
                    console.log("    cosa isola     :", r.what);
                    if (r.messageCount) {
                        console.log("    messaggio      :", r.messageType, r.messageId, r.messageNumber,
                            "«" + (r.messageText || "senza testo") + "»",
                            "| trovato in", r.responseShape, "| n.", r.messageCount);
                    }
                    if (r.functionImports) {
                        console.log("    $metadata      : Function Import", r.functionImports,
                            "| parametri", r.params);
                    }
                    if (r.reason) console.log("    motivo         :", r.reason);
                    if (r.mplId) {
                        console.log("%c    MPL ID         : " + r.mplId, "font-weight:bold",
                            "<- con questo il team Integration apre l'esecuzione nel monitor CPI");
                    }
                    if (r.requestBody) {
                        try {
                            console.log("    body inviato   :", JSON.parse(r.requestBody));
                        } catch (e) {
                            console.log("    body inviato   :", r.requestBody);
                        }
                    }
                    // LO SCAMBIO CRUDO, SEMPRE — riuscita o no. Tutto il resto di questa riga e'
                    // passato dal purge OData di CAP, che toglie il wrapper `d` quando c'e':
                    // solo questi campi dicono in che forma ha risposto l'Integration Suite, ed
                    // e' la domanda aperta su questi due Function Import.
                    if (r.rawSeen) {
                        console.log("    stato reale    : HTTP " + r.rawStatus
                            + "  ·  content-type: " + (r.responseContentType || "(non dichiarato)")
                            + "  ·  wrapper OData `d`: " + (r.rawHasD ? "SI'" : "NO"));
                        console.log("    corpo CRUDO    :",
                            r.rawBody === "" ? "(VUOTO: nessun corpo nella risposta)" : r.rawBody);
                        if (r.rawBody) {
                            // Anche come oggetto: nei devtools si apre ad albero, ed e' l'unico
                            // modo civile di guardare una struttura annidata.
                            try { console.log("    corpo (albero) :", JSON.parse(r.rawBody)); } catch (e) { /* non JSON: basta il testo */ }
                        }
                    } else {
                        console.log("    stato reale    : (tap sulla risposta non agganciato: "
                            + "il corpo crudo NON e' stato misurato)");
                    }
                    if (!r.ok) {
                        if (r.error) console.warn("    errore         :", r.error);
                        console.log("    header inviati :", r.requestHeaders || "(nessuno)");
                        console.log("    header ricevuti:", r.responseHeaders || "(nessuno)");
                        console.log("    body (post-CAP):", r.responseBody || "(vuoto)");
                    }
                    console.log("    durata         :", r.ms, "ms");
                });

                if (aRighe.some(r => r.alarm)) {
                    console.error("%c=> ALLARME: una delle due chiamate ha risposto SENZA ERRORI su un "
                        + "ordine che doveva essere inesistente. Verificare SUBITO lo stato dell'ordine "
                        + oTesta.orderId + " in SAP e spegnere la sonda con ORDER_STATUS_POST=off.",
                        "color:red;font-weight:bold");
                } else if (aRighe.some(r => r.depth === "FM")) {
                    // Un messaggio applicativo esiste solo se la FM e' stata eseguita.
                    console.log("%c=> Il messaggio e' ARRIVATO ALLA FM: l'integrazione FUNZIONA. Su un "
                        + "ordine inesistente un errore applicativo e' l'esito atteso — e' la prova "
                        + "che cercavamo.", "color:green;font-weight:bold");
                } else if (!bFull) {
                    console.warn("=> Nessuna delle due chiamate arriva alla FM. window.orderStatusPost(true) "
                        + "aggiunge i controlli: apici nel valore, parametro nel corpo, $metadata del root.");
                }
                console.groupEnd();
            })
            .catch(e => console.error("[ORDER-STATUS-POST] chiamata non eseguita:", e.message));
    }
    // ================================================================
    // [ORDER-STATUS-POST] fine
    // ================================================================

    // ================================================================
    // [SPLIT-TRACE] Sonda: dove si rompe la lettura di un job su PLEX (non SAP).
    // Endpoint: GET /plex/splitJobReadProbe(ManufacturingOrder='...')  (function: legge, non
    // scrive, quindi e' apribile anche in una tab).
    //
    // CASO CHIUSO, e la causa era NOSTRA: GET /scheduling/v1/jobs?jobNumber=<ordine> rispondeva
    // 500 REQUEST_PROCESSING_ERROR («Data is Null...») su job che su Plex si vedevano sani, ma
    // chiedevamo per NUMERO un job di cui avevamo gia' l'id — il rimedio e' la lettura id-first
    // (DEC-80). Non era il difetto Plex del backwards-schedule / PUT, corretto il 27/08/2026.
    // La sonda resta perche' la domanda che risolve e' utile a prescindere: ripete la lettura
    // d'esercizio e la confronta con `get-job` per id, con la lista per partId e con il filtro
    // externalJobCode: le tre prove isolano se cede il FILTRO, la LISTA o la RIGA.
    //
    // L'ordine e' OBBLIGATORIO: qui non c'e' un caso di prova concordato come nelle altre
    // sonde, e puntarla su un ordine a caso non direbbe niente.
    // Si lancia con window.splitJobProbe('000700000000').
    // ================================================================
    function _splitJobProbe(sOrder) {
        const sOrdine = String(sOrder || "").trim();
        if (!sOrdine) {
            console.warn("[SPLIT-TRACE] serve il numero d'ordine: window.splitJobProbe('000700000000')");
            return;
        }
        const sUrl = AppUrl.url("/plex/splitJobReadProbe(ManufacturingOrder='") + encodeURIComponent(sOrdine) + "')";

        fetch(sUrl, { headers: { "Accept": "application/json" } })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then((d) => {
                const aRows = (d && d.value) || [];
                console.group("%c[SPLIT-TRACE] lettura del job " + sOrdine + " -> Plex Job Scheduling API",
                    "font-weight:bold");
                if (!aRows.length) {
                    console.warn("nessuna riga: la sonda non ha restituito nulla");
                    console.groupEnd();
                    return;
                }
                const oTesta = aRows[0];
                if (oTesta.id === "VERDETTO") {
                    _printVerdetto(oTesta.what);
                } else {
                    // 'OFF' (SPLIT_JOB_PROBE=off) o lettura SAP fallita: non e' un errore della sonda.
                    console.warn(oTesta.id + ": " + oTesta.what);
                    console.groupEnd();
                    return;
                }
                console.log("richiesta:", sUrl);
                aRows.slice(1).forEach((r) => { _printSplitJobRow(r); });
                console.log("le stesse letture sono nell'anello: window.isCallsProbes()");
                console.groupEnd();
            })
            .catch(e => console.error("[SPLIT-TRACE] chiamata non eseguita:", e.message));
    }

    /**
     * Una prova. L'intestazione porta l'esito e il numero di righe, perche' e' l'unica riga
     * visibile senza aprire il gruppo; il corpo dell'errore Plex sta dentro, ed e' il dato con cui
     * si istruisce un caso. Le KO restano APERTE: sono la ragione per cui la sonda esiste.
     */
    function _printSplitJobRow(r) {
        const bEseguita = !!r.request;
        const sEsito = bEseguita
            ? (r.ok ? "OK " + r.rows + " righe" : "KO " + (r.httpStatus || "-"))
            : (r.id === "MAPPING" ? "DATI" : "NON ESEGUITA");
        const fnGroup = (bEseguita && r.ok) ? console.groupCollapsed : console.group;
        fnGroup("%c" + sEsito + "%c " + r.id
            + (bEseguita ? "  ·  " + r.ms + " ms" : "")
            + (r.exactMatch ? "  ·  numero di job CORRISPONDENTE" : ""),
            (bEseguita && r.ok) ? "color:#fff;background:#256f3a;padding:0 4px;font-weight:bold"
                : "color:#fff;background:#bb0000;padding:0 4px;font-weight:bold", "");
        console.log("cosa isola :", r.what);
        if (r.request) { console.log("richiesta  :", r.request); }
        if (r.jobNumbers) { console.log("job trovati:", r.jobNumbers); }
        if (r.error) { console.warn("errore     :", r.error); }
        if (r.responseBody) { console.warn("corpo      :", r.responseBody); }
        if (r.firstRow) { console.log("prima riga :", r.firstRow); }
        if (r.rowsJson) {
            try {
                console.log("righe      :", JSON.parse(r.rowsJson));
            } catch (e) {
                console.log("righe      :", r.rowsJson);
            }
        }
        console.groupEnd();
    }
    // ================================================================
    // [SPLIT-TRACE] fine
    // ================================================================

    // ================================================================
    // [JOB-SCHED-PROBE] Sonda: QUALE campo e' nullo nel backwards-schedule del passo 5.
    // Endpoint: GET /plex/jobScheduleProbe(ManufacturingOrder='...')  (function: legge)
    //
    // CASO CHIUSO il 27/08/2026: il passo 5 rispondeva 500 REQUEST_PROCESSING_ERROR («Data is
    // Null...»), che non e' fra le risposte documentate dal contratto — un null non gestito dentro
    // Plex. Era un difetto loro, corretto da Rockwell e verificato sul tenant; la sonda ha
    // dimostrato che nessuna delle sei precondizioni era la causa, ed e' cio' che ha permesso di
    // girarlo come difetto loro. Resta come strumento per il prossimo 500 non documentato.
    // Legge le sei precondizioni che quel servizio usa — operazioni della part, operazioni del job,
    // work center approvati, i loro rate, il building del job, l'ampiezza della finestra fra le due
    // date — e le dichiara [OK] / [VUOTO] / [IGNOTO], con la prima mossa da fare.
    //
    // L'ordine e' OBBLIGATORIO e da lui il server deriva materiale, plant e connessione: da qui
    // non si punta la sonda su un bersaglio scelto dal browser.
    // Si lancia con window.jobSchedProbe('000700000163').
    // ================================================================
    function _jobSchedProbe(sOrder) {
        const sOrdine = String(sOrder || "").trim();
        if (!sOrdine) {
            console.warn("[JOB-SCHED-PROBE] serve il numero d'ordine: window.jobSchedProbe('000700000163')");
            return;
        }
        const sUrl = AppUrl.url("/plex/jobScheduleProbe(ManufacturingOrder='") + encodeURIComponent(sOrdine) + "')";

        fetch(sUrl, { headers: { "Accept": "application/json" } })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then((d) => {
                const aRows = (d && d.value) || [];
                console.group("%c[JOB-SCHED-PROBE] precondizioni del backwards-schedule — ordine " + sOrdine,
                    "font-weight:bold");
                if (!aRows.length) {
                    console.warn("nessuna riga: la sonda non ha restituito nulla");
                    console.groupEnd();
                    return;
                }
                const oTesta = aRows[0];
                if (oTesta.id === "VERDETTO") {
                    _printVerdetto(oTesta.what);
                } else {
                    // 'OFF' (JOB_SCHED_PROBE=off) o lettura SAP fallita: non e' un errore della sonda.
                    console.warn(oTesta.id + ": " + oTesta.what);
                    console.groupEnd();
                    return;
                }
                console.log("richiesta:", sUrl);
                aRows.slice(1).forEach((r) => { _printJobSchedRow(r); });
                console.log("le stesse letture sono nell'anello: window.isCallsProbes()");
                console.groupEnd();
            })
            .catch(e => console.error("[JOB-SCHED-PROBE] chiamata non eseguita:", e.message));
    }

    /**
     * Una precondizione. `findings` e' la colonna da leggere dopo il verdetto — porta i rate per
     * work center, il buildingId e le due date del job — quindi sta nell'intestazione del gruppo
     * quando c'e'. Le KO restano APERTE: sono la ragione per cui la sonda esiste.
     */
    function _printJobSchedRow(r) {
        const bEseguita = !!r.request;
        const sEsito = bEseguita
            ? (r.ok ? "OK " + r.rows + " righe" : "KO " + (r.httpStatus || "-"))
            : (r.id === "CONTESTO" ? "DATI" : "NON ESEGUITA");
        const fnGroup = (bEseguita && r.ok) ? console.groupCollapsed : console.group;
        fnGroup("%c" + sEsito + "%c " + r.id
            + (bEseguita ? "  ·  " + r.ms + " ms" : ""),
            (bEseguita && r.ok) ? "color:#fff;background:#256f3a;padding:0 4px;font-weight:bold"
                : "color:#fff;background:#bb0000;padding:0 4px;font-weight:bold", "");
        console.log("cosa isola :", r.what);
        if (r.request) { console.log("richiesta  :", r.request); }
        if (r.findings) { console.log("dato       :", r.findings); }
        if (r.error) { console.warn("errore     :", r.error); }
        if (r.responseBody) { console.warn("corpo      :", r.responseBody); }
        if (r.firstRow) { console.log("prima riga :", r.firstRow); }
        if (r.rowsJson) {
            try {
                console.log("righe      :", JSON.parse(r.rowsJson));
            } catch (e) {
                console.log("righe      :", r.rowsJson);
            }
        }
        console.groupEnd();
    }
    // ================================================================
    // [JOB-SCHED-PROBE] fine
    // ================================================================

    // ================================================================
    // [PLEX-HISTORY-PROBE] Sonda: COSA RISPONDONO OGGI le due letture di storico produzione.
    // Endpoint: GET /plex/plexHistoryProbe(...)  (function: legge, quindi si apre anche in una tab)
    //
    // Le due letture del flusso di consuntivazione — production-entries (il prodotto buono) e
    // scrap-entries (lo scarto) — vivono solo dentro il job PROD_CONF, e la loro finestra e'
    // guidata dal watermark: dipende dallo stato del job e non da quando la si lancia. Questa
    // sonda le chiama su una finestra di QUINDICI MINUTI che finisce nell'istante
    // dell'invocazione, e stampa la risposta CRUDA.
    //
    // Il plant NON e' obbligatorio, ed e' la differenza con le altre due sonde verso Plex: senza
    // argomento la sonda gira su tutti i plant utilizzabili, perche' la connessione Plex e' per
    // plant (0020) — non perche' il plant sia il bersaglio. La finestra la calcola il SERVER, per
    // cui c'e' un orologio solo.
    // Si lancia con window.plexHistoryProbe() oppure window.plexHistoryProbe('1010').
    // ================================================================
    function _plexHistoryProbe(sPlant) {
        const sCodice = String(sPlant || "").trim();
        const sUrl = AppUrl.url("/plex/plexHistoryProbe(")
            + (sCodice ? "Plant='" + encodeURIComponent(sCodice) + "'" : "") + ")";

        fetch(sUrl, { headers: { "Accept": "application/json" } })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then((d) => {
                const aRows = (d && d.value) || [];
                console.group("%c[PLEX-HISTORY-PROBE] registrazioni e scarti su PLEX — ultimi 15 minuti"
                    + (sCodice ? " — plant " + sCodice : " — tutti i plant utilizzabili"),
                    "font-weight:bold");
                if (!aRows.length) {
                    console.warn("nessuna riga: la sonda non ha restituito nulla");
                    console.groupEnd();
                    return;
                }
                const oTesta = aRows[0];
                if (oTesta.id === "VERDETTO") {
                    _printVerdetto(oTesta.what);
                } else {
                    // 'OFF' (PLEX_HISTORY_PROBE=off, o nessun plant utilizzabile): non e' un errore.
                    console.warn(oTesta.id + ": " + oTesta.what);
                    console.groupEnd();
                    return;
                }
                console.log("richiesta:", sUrl);
                aRows.slice(1).forEach((r) => { _printPlexHistoryRow(r); });
                console.log("le stesse letture sono nell'anello: window.isCallsProbes()");
                console.groupEnd();
            })
            .catch(e => console.error("[PLEX-HISTORY-PROBE] chiamata non eseguita:", e.message));
    }

    /**
     * Una lettura. `windowUtc` sta nell'INTESTAZIONE perche' e' l'oggetto della sonda: quale
     * finestra e' stata chiesta va visto senza aprire il gruppo. Le KO restano APERTE, e su queste
     * due letture il corpo della risposta e' l'unica informazione utile — il contratto dichiara
     * soltanto il 200.
     */
    function _printPlexHistoryRow(r) {
        const bEseguita = !!r.request;
        const sEsito = bEseguita
            ? (r.ok ? "OK " + r.rows + " righe" : "KO " + (r.httpStatus || "-"))
            : "NON ESEGUITA";
        const fnGroup = (bEseguita && r.ok) ? console.groupCollapsed : console.group;
        fnGroup("%c" + sEsito + "%c " + r.id
            + (r.windowUtc ? "  ·  " + r.windowUtc : "")
            + (bEseguita ? "  ·  " + r.ms + " ms" : ""),
            (bEseguita && r.ok) ? "color:#fff;background:#256f3a;padding:0 4px;font-weight:bold"
                : "color:#fff;background:#bb0000;padding:0 4px;font-weight:bold", "");
        console.log("cosa legge :", r.what);
        if (r.request) { console.log("richiesta  :", r.request); }
        if (r.error) { console.warn("errore     :", r.error); }
        if (r.responseBody) { console.warn("corpo      :", r.responseBody); }
        if (r.firstRow) { console.log("prima riga :", r.firstRow); }
        if (r.rowsJson) {
            try {
                console.log("righe      :", JSON.parse(r.rowsJson));
            } catch (e) {
                // Il JSON e' tagliato al tetto di colonna: `what` lo dichiara, e la stringa cruda
                // vale piu' di niente.
                console.log("righe      :", r.rowsJson);
            }
        }
        console.groupEnd();
    }
    // ================================================================
    // [PLEX-HISTORY-PROBE] fine
    // ================================================================

    return {

        /**
         * Registra i comandi manuali. NON LANCIA NESSUNA SONDA.
         *
         * E' l'intero contenuto di questo modulo che gira all'apertura della dashboard: sei
         * assegnazioni a `window` e una riga in console. Nessun fetch, nessuna chiamata verso
         * SAP, niente da spegnere. Se un giorno qui dentro compare un lancio, e' tornata la
         * W1-20.
         *
         * L'elenco stampato e' l'unico posto in cui un collega scopre che le sonde esistono: se
         * ne aggiungi una, aggiungila anche a quel testo — e marcala [SCRIVE] se scrive.
         */
        install() {
            if (bInstalled) { return; }
            bInstalled = true;

            // --- letture: nessun effetto in SAP, si lanciano a cuor leggero ---
            // [SPLIT-TRACE] Sonda verso PLEX: l'ordine e' obbligatorio, non c'e' un caso di prova
            // di default.
            window.splitJobProbe = (sOrder) => _splitJobProbe(sOrder);
            // [JOB-SCHED-PROBE] L'altra sonda verso PLEX: le precondizioni del passo 5. Legge — la
            // sua unica prova che scrive (RETRY-FALSE) e' spenta lato server, non da qui.
            window.jobSchedProbe = (sOrder) => _jobSchedProbe(sOrder);
            // [PLEX-HISTORY-PROBE] La terza verso PLEX: registrazioni di produzione e scarti degli
            // ultimi 15 minuti, risposta cruda. Il plant e' OPZIONALE (senza, tutti quelli
            // utilizzabili): non e' un bersaglio, e' il modo in cui si risolve la connessione.
            window.plexHistoryProbe = (sPlant) => _plexHistoryProbe(sPlant);

            // --- scritture: partono SOLO da qui, e in produzione le leve le rendono inerti ---
            window.orderStatusPost = (bFull) => _postProdOrderStatus(bFull === true);
            window.matDocPost = () => _postMaterialDoc();

            console.log("%c[PROBE]%c sonde di diagnosi pronte. NESSUNA parte da sola: si lanciano da qui.\n"
                + "  window.splitJobProbe('<ordine>')                      job su PLEX — legge\n"
                + "  window.jobSchedProbe('<ordine>')                      precondizioni del passo 5 — legge\n"
                + "  window.plexHistoryProbe([plant])                     registrazioni e scarti su PLEX,\n"
                + "                                                       ultimi 15 min — legge\n"
                + "  window.orderStatusPost()                             chiusura + TECO — %cSCRIVE%c\n"
                + "  window.matDocPost()                                  movimento merci MOCK — %cSCRIVE%c\n"
                + "In produzione ORDER_STATUS_POST e' spenta: risponde OFF. MATDOC_POST e' accesa di\n"
                + "proposito — quel modulo e' il flusso vero del job PROD_CONF, non una sonda.",
                "font-weight:bold", "",
                "color:#c00;font-weight:bold", "",
                "color:#c00;font-weight:bold", "");
        }
    };
});

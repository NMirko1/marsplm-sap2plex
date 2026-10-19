sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/BusyDialog",
    // [IS-CALL-LOG] traccia delle chiamate verso SAP in console. Da rimuovere a migrazione conclusa.
    "avvaleplm/marsplm/sap2plex/main/util/IsCallLog",
    // [PLEX-VALUE-PROBE] controlli del dialogo degli esiti della sonda. Da rimuovere con lei:
    // grep -rn "PLEX-VALUE-PROBE".
    "sap/m/MessageBox",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/VBox",
    "sap/m/Table",
    "sap/m/Column",
    "sap/m/ColumnListItem",
    "sap/m/Text",
    "sap/m/ObjectStatus",
    "sap/m/FormattedText",
    "sap/ui/codeeditor/CodeEditor",
    // [LOG-MSG-I18N] La lingua con cui si chiede lo storico invii: dalla 0029 il testo della
    // colonna «Messaggio» lo rende il server, quindi la richiesta la lingua deve dirla.
    "avvaleplm/marsplm/sap2plex/main/util/LogLanguage",
    // [MAT-PLANT-PAIR] Il filtro dello storico e' per (materiale, PLANT), e il literal OData si
    // costruisce raddoppiando gli apici. Modulo puro: node test/matLogFilter.test.js
    "avvaleplm/marsplm/sap2plex/main/util/MatLogFilter",
    // [ROUTE-KEY] La rotta e' l'oggetto: la riga messa da parte dalla lista si usa solo se
    // corrisponde. Modulo puro: node test/routeStash.test.js
    "avvaleplm/marsplm/sap2plex/main/util/RouteStash",
    // [LOAD-GEN] Una risposta partita per l'oggetto precedente non scrive sui modelli di questo.
    // Modulo puro: node test/loadGen.test.js
    "avvaleplm/marsplm/sap2plex/main/util/LoadGen",
    // [DETAIL-REREAD] La riga si chiede per CHIAVE e, se il server non consegna quella, si rilegge
    // una volta e si SCEGLIE per chiave. Test: node test/detailRead.test.js
    "avvaleplm/marsplm/sap2plex/main/util/DetailRead",
    // [ACTION-RESULT] `r.json()` non dice se la action e' riuscita: senza `r.ok` il corpo di testo
    // di un 504 diventa un SyntaxError mostrato all'utente. Test: node test/actionResult.test.js
    "avvaleplm/marsplm/sap2plex/main/util/ActionResult",
    // [ACTION-RESULT] La frase per specie di esito, con le chiavi dell'operazione.
    "avvaleplm/marsplm/sap2plex/main/util/ActionFailure",
    // [APP-URL] Ogni URL verso il nostro backend porta davanti la base dell'app:
    // servita da Work Zone l'app sta sotto un prefisso, e un path assoluto non lo porta.
    "avvaleplm/marsplm/sap2plex/main/util/AppUrl",
    // [LOG-TRACE] La lista dello storico non scarica la traccia: i due `LargeString` con richiesta
    // e risposta si leggono per la sola riga cliccata. Test: node test/logHistorySelect.test.js
    "avvaleplm/marsplm/sap2plex/main/util/LogTrace",
    // [LOG-PAGE] Lo storico si legge a pagine di 100 dal server, con la barra `1 2 3 … N` sotto
    // la tabella: un modulo e un fragment per le tre schede. Test: node test/logPagerRules.test.js
    "avvaleplm/marsplm/sap2plex/main/util/LogPager"
], (Controller, JSONModel, MessageToast, BusyDialog, IsCallLog,
    MessageBox, Dialog, Button, VBox, Table, Column, ColumnListItem, Text, ObjectStatus,
    FormattedText, CodeEditor, LogLanguage, MatLogFilter, RouteStash, LoadGen, DetailRead,
    ActionResult, ActionFailure, AppUrl, LogTrace, LogPager) => {
    "use strict";

    return Controller.extend("avvaleplm.marsplm.sap2plex.main.controller.DetailNavigation", {

        onInit() {
            // Get router and attach pattern matched handler
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("detailNavigation").attachPatternMatched(this._onPatternMatched, this);

            // Initialize local model for product data
            this.getView().setModel(new JSONModel(this._emptyDetail()), "detailModel");

            // Initialize log model for ZMatExcLogPOS table
            const oLogModel = new JSONModel({
                logs: [],
                // [DETAIL-RESET] Il velo dello storico e' SUO: la testata arriva subito dalla riga
                // cliccata, questa lettura no. Un solo velo di pagina nasconderebbe anche la
                // testata, che invece e' gia' pronta.
                busy: false
            });
            this.getView().setModel(oLogModel, "logModel");
            // [LOG-PAGE] La barra delle pagine, e il tetto del modello allineato alla pagina.
            LogPager.attach(this.getView(), oLogModel);

            // Initialize JSON Detail Panel Model (hidden by default)
            const oJsonDetailModel = new JSONModel({
                visible: false,
                // [LOG-TRACE] La traccia si legge al clic, quindi il pannello ha un tempo di
                // attesa e un modo di fallire che prima non aveva.
                busy: false,
                error: "",
                Product: "",
                Counter: 0,
                SentDate: "",
                SentTime: "",
                ResponseStatus: null,
                ResponseStatusText: "",
                RequestJsonFormatted: "",
                ResponseJsonFormatted: ""
            });
            this.getView().setModel(oJsonDetailModel, "jsonDetailModel");
        },

        /**
         * [ROUTE-KEY] La forma VUOTA del modello, in un punto solo.
         *
         * Serve perche' il rifiuto dello stash deve poter AZZERARE la schermata: senza, navigando
         * da un materiale all'altro senza passare da un click resterebbe la testata del precedente
         * sotto la rotta del nuovo — e le azioni scriverebbero quella.
         */
        _emptyDetail() {
            return {
                Product: null, Plant: null, ProductDescription: null, ProductType: null,
                CrossPlantStatus: null, IsMarkedForDeletion: null, ProductGroup: null,
                ProductHierarchy: null, Division: null, BaseUnit: null, GrossWeight: null,
                WeightUnit: null, NetWeight: null, CreationDate: null, busy: false
            };
        },

        /**
         * [DETAIL-RESET] Tutto cio' che appartiene all'oggetto se ne va con lui (feature 0043).
         *
         * PERCHE'. Il router tiene UNA sola istanza di questa vista e la riusa per ogni materiale
         * (target `type: "View"`, nessun `clearControlAggregation`): `onInit` gira una volta sola
         * nella vita dell'applicazione, quindi i modelli entrano nel materiale nuovo pieni di
         * quello precedente e ci restano finche' non arrivano le risposte.
         *
         * Va chiamata per PRIMA in `_onPatternMatched` e SENZA CONDIZIONI. L'azzeramento gia'
         * presente nella 0041 sta sul ramo di RIFIUTO dello stash, cioe' proprio il ramo che nel
         * percorso normale — click in lista — non passa mai: la' lo stash combacia e si esce
         * subito. Un azzeramento che dipende da un ramo non e' un azzeramento.
         *
         * Apre anche la nuova generazione: da qui in poi ogni risposta partita prima e' vecchia.
         */
        _resetForNewObject() {
            this._mLoadGen = this._mLoadGen || {};
            this._iLoadGen = LoadGen.next(this._mLoadGen, "detail");

            this.getView().getModel("detailModel").setData(this._emptyDetail());

            const oLogModel = this.getView().getModel("logModel");
            oLogModel.setProperty("/logs", []);
            oLogModel.setProperty("/busy", true);

            // Il pannello sotto la tabella porta il JSON di una riga di log: lasciarlo aperto
            // mostrerebbe la richiesta e la risposta di un invio di un ALTRO materiale.
            this._hideJsonDetailPanel();
            const oTable = this.byId("logHistoryTable");
            if (oTable) { oTable.removeSelections(true); }
        },

        _onPatternMatched(oEvent) {
            const oArgs = oEvent.getParameter("arguments");
            const sProduct = oArgs.Product;
            const sPlant = oArgs.Plant;

            // [ROUTE-KEY] La ROTTA e' l'oggetto che si sta guardando, e vale per TUTTE le chiavi e
            // per tutti gli usi — non piu' solo per il ricarico dello storico, come diceva il
            // commento [MAT-PLANT-PAIR] che stava qui. `_oRouteKeys` si costruisce accanto a
            // `oArgs`: un parametro aggiunto domani alla rotta entra qui, o un test lo dichiara.
            this._sProduct = sProduct;
            this._sPlant = sPlant;
            this._oRouteKeys = { Product: sProduct, Plant: sPlant };

            // [DETAIL-RESET] Prima di qualunque lettura: la schermata si svuota, poi si riempie.
            this._resetForNewObject();

            // Load product data from component and log history from API
            this._loadProductData(sProduct, sPlant);
            this._loadLogHistory(sProduct, sPlant);
        },

        _loadProductData(sProduct, sPlant) {
            const oViewModel = this.getView().getModel("detailModel");
            const oStash = this.getOwnerComponent()._selectedProduct;
            // [LOAD-GEN] La generazione si cattura QUI, quando la lettura parte: al ritorno dice
            // se nel frattempo si e' navigato altrove. Vedi il commento in util/LoadGen.js.
            const iGen = this._iLoadGen;

            // ================================================================
            // [ROUTE-KEY] La riga messa da parte dalla lista si usa SOLO se e' questo oggetto.
            //
            // Sul ramo accettato le chiavi vengono sovrascritte con quelle della rotta: dopo il
            // confronto non e' una sostituzione, e' una grafia — e da li' in poi «le chiavi del
            // modello sono le chiavi della rotta» e' un invariante, non una speranza.
            //
            // Sul ramo rifiutato il modello si AZZERA prima di rileggere: senza, resterebbe la
            // testata dell'oggetto precedente sotto la rotta del nuovo.
            // ================================================================
            const oCheck = RouteStash.check(oStash, this._oRouteKeys);
            if (oCheck.usable) {
                oViewModel.setData({ ...oStash, ...this._oRouteKeys, busy: false });
                return;
            }
            if (oCheck.reason !== RouteStash.REASON.NO_STASH) {
                console.warn(RouteStash.describe("dettaglio materiale", oCheck));
            }
            oViewModel.setData(this._emptyDetail());

            {
                // Fallback: fetch product data when component data is not available (e.g., after F5 refresh)
                console.log(">>> Fetching product data from OData (after F5 refresh)");
                oViewModel.setProperty("/busy", true);

                // ================================================================
                // [MAT-PLANT-PAIR] Stessa correzione del filtro dello storico: in un key predicate
                // OData l'apice si RADDOPPIA, `encodeURIComponent` non lo tocca. Con un codice
                // materiale che contiene un apice l'URL era malformato e il dettaglio non caricava.
                //
                // [DETAIL-REREAD] La rilettura passa dall'action `productDetails`, ed e' una
                // scelta: rende una riga per (Product, Plant) con ESATTAMENTE i campi di questa
                // scheda, passa dallo stesso gate di licenza ed e' lo stesso canale con cui la
                // dashboard riempie le righe. Un `Products?$filter=… and Plant eq …` NON e'
                // utilizzabile qui: in ONPREM il `$filter` del client viene spinto su `A_Product`,
                // che non ha l'elemento `Plant` (l'eccezione e' dichiarata in
                // test/keyReadGuarded.test.js).
                //
                // Serve soprattutto per il `404`: la rete [KEY-READ] lato server trasforma «riga
                // sbagliata» in «riga assente», quindi un 404 qui non prova che il materiale non
                // esista — e prima di questa feature quel caso usciva come errore generico con la
                // scheda vuota.
                // ================================================================
                const sUrl = AppUrl.url("/products/Products(Product=") + MatLogFilter.odataLiteral(sProduct)
                    + ",Plant=" + MatLogFilter.odataLiteral(sPlant) + ")";

                DetailRead.one({
                    keyUrl: sUrl,
                    routeKeys: this._oRouteKeys,
                    label: `dettaglio materiale ${sProduct}/${sPlant}`,
                    recover: () => DetailRead.rowsPost(AppUrl.url("/products/productDetails"),
                        { products: [sProduct] })
                })
                .then(oRead => {
                    // [LOAD-GEN] Se si e' gia' navigati altrove, questa risposta e' di un altro
                    // materiale: si scarta senza scrivere e senza toccare il busy — lo spegnera'
                    // la lettura piu' recente, che e' ancora in volo.
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    const oBundle = this.getView().getModel("i18n").getResourceBundle();
                    if (!oRead.row) {
                        // [DETAIL-REREAD] «Non c'e'» e «non ho potuto leggere» sono DUE messaggi:
                        // il secondo non deve leggersi come «questo materiale non esiste».
                        console.error(">>> [DETAIL-REREAD] dettaglio materiale non ottenuto:",
                            oRead.note);
                        MessageToast.show(oRead.why === DetailRead.WHY.READ_FAILED
                            ? oBundle.getText("detailReadFailed", [oRead.note])
                            : oBundle.getText("productNotFound", [sProduct, sPlant || "-"]));
                        oViewModel.setData(this._emptyDetail());
                        return;
                    }
                    console.log(">>> Product data loaded from OData:", oRead.row);
                    // [ROUTE-KEY] Le chiavi del modello sono quelle della ROTTA: e' l'invariante da
                    // cui `onSendToPlex` prende materiale e plant, e il plant sceglie il TENANT.
                    oViewModel.setData({ ...oRead.row, ...this._oRouteKeys, busy: false });
                    // [IS-CALL-LOG] come e' stata fatta la lettura verso SAP, in console.
                    IsCallLog.dump("dettaglio materiale");
                });
            }
        },

        _loadLogHistory(sProduct, sPlant, iPage) {
            const oLogModel = this.getView().getModel("logModel");
            const oDateFormat = sap.ui.core.format.DateFormat.getDateInstance({ style: "medium" });
            // [LOAD-GEN] La generazione al momento della partenza. Vedi util/LoadGen.js.
            const iGen = this._iLoadGen;
            // [LOG-PAGE] Senza pagina (cambio materiale, dopo un invio) si legge la 1 — le righe
            // piu' recenti — e la barra si azzera PRIMA della lettura.
            const oPager = LogPager.modelOf(this.getView());
            const iWanted = LogPager.begin(oPager, iPage);

            // ================================================================
            // [MAT-PLANT-PAIR] Lo storico e' quello di QUESTA coppia (feature 0039).
            //
            // La chiave di ZMatExcLogPOS e' (Product, Plant, Counter) dalla 0031 e il contatore
            // riparte da 1 per plant: senza il plant nel filtro la scheda mostrava le righe di
            // ogni plant licenziato, con numeri duplicati. Il gate [LOG-PLANT-GATE] lato server
            // non aiuta — filtra sui plant dell'UTENTE, non su quello della schermata.
            //
            // Plant assente: si chiede il solo materiale e LO SI DICE. Un `Plant eq ''` darebbe una
            // lista vuota, che si legge come «mai inviato».
            // ================================================================
            if (!sPlant) {
                console.warn(">>> [MAT-PLANT-PAIR] storico invii chiesto senza plant:"
                    + " la lista puo' contenere righe di piu' plant");
            }
            // [APP-URL] La base la mette IL CHIAMANTE, non `matLogUrl`: `MatLogFilter.js` e' un
            // `sap.ui.define([])` e `test/matLogFilter.test.js` pretende che lo resti — e' cio' che
            // lo rende eseguibile dallo shim del test. Il modulo costruisce il PATH, qui gli si
            // mette davanti la base dell'app.
            // [LOG-TRACE] Le colonne si CHIEDONO. Senza `$select` ogni riga porta anche
            // `RequestJson` e `ResponseJson`, i due `LargeString` con la traccia intera, che questa
            // tabella non mostra mai: si leggono al clic, per la riga cliccata. `Plant` ci sta
            // perche' e' in CHIAVE e serve proprio a quella rilettura, benche' a schermo non
            // compaia; `MessageJson` e' OBBLIGATORIO, o il server lascia lo snapshot italiano
            // invece di rendere il messaggio nella lingua di chi guarda (DEC-92).
            // [LOG-PAGE] Una lettura per pagina: `$count=true&$top=100&$skip=N` in coda all'URL
            // di `matLogUrl`, che non cambia (il suo test ne fissa l'output).
            const sUrl = AppUrl.url(MatLogFilter.matLogUrl(sProduct, sPlant, LogTrace.listSelect([
                "Product", "Plant", "Counter", "SentDate", "SentTime",
                "Status", "Message", "MessageJson", "ResponseStatus"
            ]))) + LogPager.pageQuery(iWanted);

            // [LOG-MSG-I18N] Vedi il commento gemello in RoutingDetail: la lingua si dichiara.
            fetch(sUrl, { headers: LogLanguage.logHeaders() })
                .then(response => {
                    // [DETAIL-RESET] Un rifiuto del server e' un ERRORE, non una lista vuota: senza
                    // questo controllo `r.json()` legge il corpo d'errore, `oData.value` e'
                    // `undefined` e la tabella si popola con `[]` — «mai inviato» al posto di «non
                    // ho potuto leggere».
                    if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
                    return response.json();
                })
                .then(oData => {
                    // [LOAD-GEN] Risposta di un altro materiale: si scarta.
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    const aLogs = (oData.value || []).map(log => ({
                        ...log,
                        SentDate: log.SentDate ? oDateFormat.format(new Date(log.SentDate)) : ""
                    }));
                    oLogModel.setProperty("/logs", aLogs);
                    oLogModel.setProperty("/busy", false);
                    LogPager.applyResponse(oPager, iWanted, oData, "storico materiale");
                    console.log(`>>> [LOG-PAGE] Material send logs: pagina ${oPager.getProperty("/page")}`
                        + ` di ${oPager.getProperty("/pageCount")}, ${aLogs.length} righe su ${oPager.getProperty("/total")}`);
                })
                .catch(oError => {
                    if (!LoadGen.isCurrent(this._mLoadGen, "detail", iGen)) { return; }
                    console.error("Error loading log history:", oError);
                    oLogModel.setProperty("/logs", []);
                    LogPager.reset(oPager);
                    oLogModel.setProperty("/busy", false);
                });
        },

        /** [LOG-PAGE] Un evento della barra delle pagine: si ricava la pagina e si rilegge. */
        onLogPager(oEvent) {
            const iPage = LogPager.targetOf(oEvent, LogPager.modelOf(this.getView()));
            if (iPage) { this._loadLogHistory(this._sProduct, this._sPlant, iPage); }
        },

        formatTitle(sPattern, sProduct) {
            if (sPattern && sProduct) {
                return sPattern.replace("{0}", sProduct);
            }
            return sPattern || "";
        },

        onBack() {
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.navTo("dashboardNavigation");
        },

        onSendToPlex() {
            const oViewModel = this.getView().getModel("detailModel");
            const oData = oViewModel.getData();
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();

            // ================================================================
            // [ROUTE-KEY] LE CHIAVI VENGONO DALLA ROTTA, non dal modello.
            //
            // Il `Plant` sceglie il TENANT Plex su cui si scrive — una connessione per plant — e
            // con il plant del modello si scriveva sulla part di un altro stabilimento. Plex
            // risponde 200: nessun errore, da nessuna parte.
            // ================================================================
            const sProduct = this._sProduct;
            const sPlant = this._sPlant;
            if (!sProduct || !sPlant) {
                MessageToast.show(oResourceBundle.getText("sendToPlexNoProduct"));
                return;
            }

            // La DESCRIZIONE viene dal modello, ma solo se il modello e' ancora QUESTO oggetto:
            // diventa il `name` della part su Plex. Da un modello stantio la part prenderebbe il
            // nome di un altro materiale; da un modello vuoto la PUT scriverebbe `name: null`,
            // cioe' CANCELLEREBBE il nome. Nessuno dei due da' errore.
            // Rileggerla non risolverebbe: manderebbe a Plex un valore diverso da quello che
            // l'utente ha appena letto sulla scheda.
            const oCheck = RouteStash.check(oData, this._oRouteKeys);
            if (!oCheck.usable) {
                console.error(RouteStash.describe("invio a Plex", oCheck));
                MessageBox.error(oResourceBundle.getText("sendToPlexStaleDetail", [sProduct, sPlant]));
                return;
            }
            if (!oData.ProductDescription) {
                console.warn(`[ROUTE-KEY] ${sProduct}/${sPlant}: descrizione vuota, la part esce senza nome`);
            }

            console.log(`>>> Sending Product ${sProduct}/${sPlant} to Plex...`);

            // Create and open BusyDialog
            const oBusyDialog = new BusyDialog({
                title: oResourceBundle.getText("sendToPlexTitle"),
                text: oResourceBundle.getText("sendToPlexSending", [sProduct]),
                showCancelButton: false
            });
            oBusyDialog.open();

            // [ACTION-RESULT] Quanto e' durata: il messaggio del taglio per tempo senza un numero
            // non distingue «la rete e' caduta subito» da «ci ha messo troppo».
            const iStartedAt = Date.now();

            fetch(AppUrl.url("/plex/sendProductToPlex"), {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    Product: sProduct,
                    ProductDescription: oData.ProductDescription,
                    Plant: sPlant
                })
            })
            // [ACTION-RESULT] Si guarda `r.ok` PRIMA di leggere il corpo: il corpo di un `504`
            // dell'approuter e' TESTO, e dato a `json()` diventa un SyntaxError il cui messaggio
            // finiva interpolato dentro `sendToPlexError` — su una part che su Plex puo' essere
            // stata creata. Il predicato di forma e' `success`, cio' che il ramo qui sotto legge.
            .then(r => ActionResult.read(r, b => b && typeof b.success === "boolean"))
            .catch(err => ActionResult.fromNetworkError(err))
            .then(outcome => {
                if (!ActionResult.isOk(outcome)) {
                    // Il velo si chiude SUBITO e la frase va in un dialogo: un paragrafo che
                    // l'utente deve leggere non sta in un riquadro che sparisce da solo dopo 2 s.
                    oBusyDialog.close();
                    this._reportSendToPlexFailure(outcome, Date.now() - iStartedAt, sProduct, sPlant);
                    return;
                }
                const result = outcome.body;
                console.log(">>> Plex send result:", result);

                if (result.success) {
                    // Update BusyDialog with success message
                    oBusyDialog.setText(
                        oResourceBundle.getText("sendToPlexSuccess", [result.operation, result.plexId])
                    );

                    // Reload log history to show new entry
                    // [ROUTE-KEY] Dalla rotta, come l'invio: il ripiego sul modello e' sparito.
                    this._loadLogHistory(sProduct, sPlant);
                } else {
                    // Update BusyDialog with error message
                    oBusyDialog.setText(
                        oResourceBundle.getText("sendToPlexError", [result.message])
                    );
                }

                // Close BusyDialog after 2 seconds
                setTimeout(() => {
                    oBusyDialog.close();
                }, 2000);
            })
            .catch(error => {
                // Ci arriva solo un'eccezione DENTRO il ramo riuscito: le specie di esito sono
                // gia' state trattate qui sopra e non lanciano.
                console.error(">>> Plex send error:", error);
                oBusyDialog.close();
                MessageBox.error(oResourceBundle.getText("sendToPlexFailed"));
            });
        },

        /**
         * [ACTION-RESULT] L'invio del materiale non e' riuscito — o non si sa se lo sia.
         *
         * Lo storico del materiale si rilegge alla CHIUSURA del dialogo: letto adesso direbbe
         * «mai inviato» per la sola ragione che il server non ha ancora finito di scrivere.
         */
        _reportSendToPlexFailure(oOutcome, iElapsedMs, sProduct, sPlant) {
            const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            console.error(">>> [ACTION-RESULT] invio materiale a Plex non riuscito:",
                oOutcome.kind, "HTTP", oOutcome.status, oOutcome.message || "", `${iElapsedMs} ms`);

            const oFail = ActionFailure.text(oOutcome, iElapsedMs, oResourceBundle, {
                generic: "sendToPlexFailed",
                interrupted: "sendToPlexInterrupted"
            });
            // La sessione scaduta la annuncia SessionGuard: qui si tace di proposito.
            if (oFail.silent) { return; }

            if (ActionFailure.isInconclusive(oOutcome)) {
                MessageBox.warning(oFail.text, {
                    onClose: () => this._loadLogHistory(sProduct, sPlant)
                });
                return;
            }
            this._loadLogHistory(sProduct, sPlant);
            MessageBox.error(oFail.text);
        },

        // ----------------------------------------------------------------
        // [PLEX-VALUE-PROBE] SONDA TEMPORANEA DI DIAGNOSI — DA RIMUOVERE
        // ----------------------------------------------------------------
        // Stabilisce quale valore il tenant Plex accetta in `type` e `status`: la chiave numerica
        // e' stata rifiutata con FIELD_REFERENCE_NOT_FOUND, e il valore atteso e' quasi certamente
        // il nome della riga di setup («Materia prima»).
        //
        // Chiede CONFERMA prima di partire, nominando la part di prova: i giri di scoperta non
        // creano nulla, ma la conferma finale crea una part usa e getta sul tenant, e chi clicca
        // deve saperlo prima e non dopo.
        //
        // Perimetro completo: grep -rn "PLEX-VALUE-PROBE".
        onProbePlexValues() {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            // [ROUTE-KEY] Le chiavi dalla ROTTA come ovunque in questa schermata. Questo handler e'
            // ORFANO — nessun `press=` lo referenzia in nessuna vista — e la sua rimozione e' un
            // commit a se' (`grep -rn "PLEX-VALUE-PROBE"`). Finche' esiste pero' CREA una part usa e
            // getta sul tenant scelto da quel plant: lasciarlo prendere le chiavi dal modello
            // sarebbe l'unico punto del file in cui una scrittura puo' finire sul tenant sbagliato.
            // `oKeys` e non `oData`: il nome dice che sono le chiavi di ROTTA, e non un pezzo del
            // modello. Il test del perimetro legge questo file letteralmente.
            const oKeys = { Product: this._sProduct, Plant: this._sPlant };

            if (!oKeys.Product || !oKeys.Plant) {
                MessageToast.show(oBundle.getText("sendToPlexNoProduct"));
                return;
            }

            MessageBox.confirm(oBundle.getText("probePlexConfirm", ["PRBnn-" + oKeys.Product]), {
                title: oBundle.getText("probePlexTitle"),
                onClose: (sAction) => {
                    if (sAction === MessageBox.Action.OK) {
                        this._runPlexValueProbe(oKeys);
                    }
                }
            });
        },

        _runPlexValueProbe(oKeys) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oBusy = new BusyDialog({
                title: oBundle.getText("probePlexTitle"),
                text: oBundle.getText("probePlexRunning", [oKeys.Product]),
                showCancelButton: false
            });
            oBusy.open();

            fetch(AppUrl.url("/plex/probePlexPartValues"), {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({ Product: oKeys.Product, Plant: oKeys.Plant })
            })
                .then((res) => res.json())
                .then((result) => {
                    oBusy.close();
                    // Il payload dell'action e' `value` su una collection; un errore CAP e' `error`.
                    const aRows = Array.isArray(result) ? result : (result.value || []);
                    if (!aRows.length) {
                        MessageBox.error(oBundle.getText("probePlexError", [
                            (result.error && result.error.message) || JSON.stringify(result)
                        ]));
                        return;
                    }
                    console.log(">>> [PLEX-VALUE-PROBE] esito:", aRows);
                    this._showPlexValueProbeResult(aRows);
                })
                .catch((err) => {
                    oBusy.close();
                    MessageBox.error(oBundle.getText("probePlexError", [err.message]));
                });
        },

        /**
         * Il dialogo degli esiti: la tabella per leggere, il JSON per COPIARE.
         * Il JSON serve piu' della tabella — l'esito va incollato in una conversazione, non
         * guardato e riassunto a memoria.
         */
        _showPlexValueProbeResult(aRows) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oVerdetto = aRows.find((r) => r.id === "VERDETTO") || aRows[0];
            const aDettaglio = aRows.filter((r) => r !== oVerdetto);

            const oDialog = new Dialog({
                title: oBundle.getText("probePlexTitle"),
                contentWidth: "56rem",
                contentHeight: "40rem",
                resizable: true,
                content: [
                    new VBox({
                        items: [
                            new FormattedText({
                                htmlText: "<pre style='white-space:pre-wrap;margin:0'>"
                                    + this._escapeHtml(oVerdetto && oVerdetto.what) + "</pre>"
                            }).addStyleClass("sapUiSmallMargin"),
                            new Table({
                                inset: false,
                                columns: [
                                    new Column({ width: "5rem", header: new Text({ text: "ID" }) }),
                                    new Column({ width: "5rem", header: new Text({ text: oBundle.getText("probePlexColField") }) }),
                                    new Column({ header: new Text({ text: oBundle.getText("probePlexColCandidate") }) }),
                                    new Column({ width: "5rem", hAlign: "End", header: new Text({ text: "HTTP" }) }),
                                    new Column({ width: "7rem", hAlign: "Center", header: new Text({ text: oBundle.getText("probePlexColAccepted") }) }),
                                    new Column({ header: new Text({ text: oBundle.getText("probePlexColRejected") }) })
                                ],
                                items: aDettaglio.map((r) => new ColumnListItem({
                                    cells: [
                                        new Text({ text: r.id }),
                                        new Text({ text: r.field }),
                                        new Text({ text: r.candidate + (r.isControl ? " (controllo)" : "") }),
                                        new Text({ text: String(r.httpStatus) }),
                                        new ObjectStatus({
                                            text: r.accepted ? oBundle.getText("probePlexYes") : oBundle.getText("probePlexNo"),
                                            state: r.accepted ? "Success" : "None"
                                        }),
                                        new Text({ text: r.rejectedFields || r.error || "" })
                                    ]
                                }))
                            }),
                            new CodeEditor({
                                type: "json",
                                editable: false,
                                height: "14rem",
                                value: JSON.stringify(aRows, null, 2)
                            }).addStyleClass("sapUiSmallMarginTop")
                        ]
                    })
                ],
                endButton: new Button({
                    text: oBundle.getText("probePlexClose"),
                    press: () => oDialog.close()
                }),
                afterClose: () => oDialog.destroy()
            });
            this.getView().addDependent(oDialog);
            oDialog.open();
        },

        _escapeHtml(sText) {
            return String(sText || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
        },

        // Formatters for status display
        // [I18N-EARLY] Il bundle per i FORMATTER, che girano mentre la vista si costruisce e
        // quindi prima che i modelli del componente le siano propagati. La catena completa — e
        // perche' il sintomo (`duplicate id`) non nomina la causa — sta in testa a
        // `_getSplitBundle()` in ProdOrderSplit.mixin.js. Rete: node test/i18nEarly.test.js
        _i18n() {
            const oModel = this.getView().getModel("i18n") || this.getOwnerComponent().getModel("i18n");
            return oModel.getResourceBundle();
        },

        formatStatusText(sStatus) {
            const oResourceBundle = this._i18n();
            switch (sStatus) {
                case 'S':
                    return oResourceBundle.getText("statusSuccess");
                case 'E':
                    return oResourceBundle.getText("statusError");
                case 'W':
                    return oResourceBundle.getText("statusWarning");
                default:
                    return "";
            }
        },

        formatStatusState(sStatus) {
            switch (sStatus) {
                case 'S':
                    return 'Success';
                case 'E':
                    return 'Error';
                case 'W':
                    return 'Warning';
                default:
                    return 'None';
            }
        },

        formatStatusIcon(sStatus) {
            switch (sStatus) {
                case 'S':
                    return 'sap-icon://sys-enter-2';
                case 'E':
                    return 'sap-icon://error';
                case 'W':
                    return 'sap-icon://alert';
                default:
                    return '';
            }
        },

        /**
         * Handles log row selection - shows JSON detail panel
         * @param {sap.ui.base.Event} oEvent - Selection change event
         */
        onLogRowSelect(oEvent) {
            const oTable = oEvent.getSource();
            const oSelectedItem = oEvent.getParameter("listItem");

            if (!oSelectedItem) {
                // Deselection - hide panel
                this._hideJsonDetailPanel();
                return;
            }

            // Get selected log entry data
            const oContext = oSelectedItem.getBindingContext("logModel");
            const oLogData = oContext.getObject();

            // [LOG-TRACE] La traccia non e' piu' nella riga: si chiede per questa riga sola.
            // [LOAD-GEN] Generazione PROPRIA del pannello: due clic rapidi sono due letture, e a
            // schermo deve restare la seconda.
            this._mLoadGen = this._mLoadGen || {};
            const iGen = LoadGen.next(this._mLoadGen, "trace");
            const oJsonDetailModel = this.getView().getModel("jsonDetailModel");
            oJsonDetailModel.setData({
                visible: true,
                busy: true,
                error: "",
                Product: oLogData.Product,
                Counter: oLogData.Counter,
                SentDate: oLogData.SentDate,
                SentTime: oLogData.SentTime,
                ResponseStatus: oLogData.ResponseStatus || null,
                ResponseStatusText: this._formatStatusCode(oLogData.ResponseStatus || null),
                RequestJsonFormatted: "",
                ResponseJsonFormatted: ""
            });

            const sUrl = LogTrace.traceUrl("ZMatExcLogPOS", {
                Product: oLogData.Product,
                Plant: oLogData.Plant,
                Counter: oLogData.Counter
            });
            LogTrace.fetchTrace(sUrl).then(oTrace => {
                if (!LoadGen.isCurrent(this._mLoadGen, "trace", iGen)) { return; }
                if (!oTrace.ok) {
                    // [DETAIL-RESET] Vuoto non e' ignoto: due riquadri vuoti direbbero «non e'
                    // stato mandato niente», che e' l'affermazione opposta a quella vera.
                    console.error(`>>> [LOG-TRACE] traccia non letta per ${oLogData.Product}/${oLogData.Plant}/${oLogData.Counter}: ${oTrace.error}`);
                    oJsonDetailModel.setProperty("/busy", false);
                    oJsonDetailModel.setProperty("/error", this._i18n().getText("logTraceReadFailed"));
                    return;
                }
                const oOut = LogTrace.formatTrace(oTrace);
                oJsonDetailModel.setProperty("/busy", false);
                oJsonDetailModel.setProperty("/error", "");
                oJsonDetailModel.setProperty("/RequestJsonFormatted", oOut.RequestJsonFormatted);
                oJsonDetailModel.setProperty("/ResponseJsonFormatted", oOut.ResponseJsonFormatted);
                oJsonDetailModel.setProperty("/ResponseStatus", oOut.ResponseStatus);
                // Qui il testo dello stato NON e' «HTTP nnn»: questa scheda ha da sempre la sua
                // descrizione estesa, e allinearla sarebbe un cambio di interfaccia non chiesto.
                oJsonDetailModel.setProperty("/ResponseStatusText", this._formatStatusCode(oOut.ResponseStatus));
            });
        },

        /**
         * Closes the JSON detail panel
         */
        onCloseJsonDetail() {
            this._hideJsonDetailPanel();

            // Deselect table row
            const oTable = this.byId("logHistoryTable");
            oTable.removeSelections(true);
        },

        /**
         * Hides the JSON detail panel (internal)
         * @private
         */
        _hideJsonDetailPanel() {
            const oJsonDetailModel = this.getView().getModel("jsonDetailModel");
            oJsonDetailModel.setProperty("/visible", false);
            // [LOG-TRACE] Il velo e l'avviso non sopravvivono alla chiusura, e la generazione
            // avanza: una lettura ancora in volo non deve riaprire il pannello scrivendoci dentro.
            oJsonDetailModel.setProperty("/busy", false);
            oJsonDetailModel.setProperty("/error", "");
            oJsonDetailModel.setProperty("/RequestJsonFormatted", "");
            oJsonDetailModel.setProperty("/ResponseJsonFormatted", "");
            this._mLoadGen = this._mLoadGen || {};
            LoadGen.next(this._mLoadGen, "trace");
        },

        /**
         * Formats HTTP status code with description
         * @param {number} statusCode - HTTP status code
         * @returns {string} Formatted status text
         * @private
         */
        _formatStatusCode(statusCode) {
            if (statusCode === null || statusCode === undefined) {
                return "N/A";
            }

            const statusDescriptions = {
                200: "OK",
                201: "Created",
                204: "No Content",
                400: "Bad Request",
                401: "Unauthorized",
                403: "Forbidden",
                404: "Not Found",
                500: "Internal Server Error",
                502: "Bad Gateway",
                503: "Service Unavailable",
                0: "Network Error"
            };

            const description = statusDescriptions[statusCode] || "Unknown";
            return `${statusCode} ${description}`;
        },

        /**
         * Formatter for HTTP status code state (for ObjectStatus)
         * @param {number} statusCode - HTTP status code
         * @returns {string} SAP UI5 state
         */
        formatHttpStatusState(statusCode) {
            if (!statusCode) return 'None';
            if (statusCode >= 200 && statusCode < 300) return 'Success';
            if (statusCode >= 400) return 'Error';
            if (statusCode === 0) return 'Error';
            return 'Warning';
        },

        /**
         * Formatter for HTTP status code icon (for ObjectStatus)
         * @param {number} statusCode - HTTP status code
         * @returns {string} Icon name
         */
        formatHttpStatusIcon(statusCode) {
            if (!statusCode) return '';
            if (statusCode >= 200 && statusCode < 300) return 'sap-icon://sys-enter-2';
            if (statusCode >= 400) return 'sap-icon://error';
            if (statusCode === 0) return 'sap-icon://error';
            return 'sap-icon://alert';
        }

    });
});

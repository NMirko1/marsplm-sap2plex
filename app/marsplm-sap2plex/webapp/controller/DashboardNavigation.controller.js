sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/m/BusyDialog",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    // [IS-CALL-LOG] traccia delle chiamate verso SAP in console. Da rimuovere a migrazione conclusa.
    "avvaleplm/marsplm/sap2plex/main/util/IsCallLog",
    // [PROBE] le sonde di diagnosi verso SAP. Caricarle NON ne lancia nessuna: vedi W1-20.
    "avvaleplm/marsplm/sap2plex/main/util/Probes",
    // [COLUMN-SORT] menu di colonna: ordina e filtra nel browser, senza chiamate al server.
    "avvaleplm/marsplm/sap2plex/main/util/ColumnMenu",
    // [ACTION-RESULT] `r.json()` non dice se la action e' riuscita: senza `r.ok` un blocco tagliato
    // dal gateway veniva contato fra gli ERRORI. Test: node test/actionResult.test.js
    "avvaleplm/marsplm/sap2plex/main/util/ActionResult",
    // [ACTION-RESULT] La specie di esito su cui il giro si ferma invece di proseguire.
    "avvaleplm/marsplm/sap2plex/main/util/ActionFailure",
    // [MASS-IMPORT] Le regole pure dell'import di un template: la soglia di ruolo, la mappatura
    // «righe del template -> operazioni» condivisa con l'import singolo, e i verdetti del dialog.
    // Modulo puro: node test/massImportTemplate.test.js
    "avvaleplm/marsplm/sap2plex/main/util/templateImport",
    // [APP-URL] Ogni URL verso il nostro backend porta davanti la base dell'app:
    // servita da Work Zone l'app sta sotto un prefisso, e un path assoluto non lo porta.
    "avvaleplm/marsplm/sap2plex/main/util/AppUrl"
], (Controller, Filter, FilterOperator, MessageToast, MessageBox, BusyDialog, Fragment, JSONModel,
    IsCallLog, Probes, ColumnMenu, ActionResult, ActionFailure, TemplateImport, AppUrl) => {
    "use strict";

    // [FAST-LIST] (0013, RB-16c) Codici materiale per chiamata a `productDetails`.
    // 25 chiavi = 50 letture per chiave verso SAP: qualche secondo per blocco, cioe' un
    // riempimento che si VEDE progredire. Alzarlo allunga il primo blocco, abbassarlo aumenta
    // il numero di richieste. Il server tronca comunque a 100 per blocco.
    const DETAILS_BLOCK = 25;

    // [DETAILS-PREFETCH] Blocco del PRECARICAMENTO, quello che gira in sottofondo sul resto del
    // perimetro. 100 e' il tetto che il server accetta (DETAILS_MAX_PER_BLOCK in cat-service.js):
    // un quarto dei round-trip rispetto a 25, e qui non c'e' nessuno che guarda quelle righe
    // riempirsi. Le righe a schermo restano a DETAILS_BLOCK, dove il progredire si vede.
    const PREFETCH_BLOCK = 100;

    // ================================================================
    // [LIST-WHOLE-SET] Le tre liste caricano l'INSIEME INTERO in una lettura sola.
    //
    // PERCHE'. Ordinamento e filtro per colonna girano nel browser (vedi util/ColumnMenu.js), e
    // criteri applicati su una pagina sola darebbero un risultato plausibile e sbagliato: chi
    // ordina per quantita' vedrebbe la piu' grande delle prime cento righe, non la piu' grande.
    //
    // PERCHE' UNA LETTURA E NON N PAGINE. Nessuna delle tre liste pagina verso SAP: il server
    // legge il perimetro intero e affetta in memoria (le RFC dietro gli iFlow non hanno
    // paginazione, ed e' il motivo per cui nemmeno gli ordini spingono piu' $top/$skip). Chiedere
    // N pagine significherebbe quindi rileggere N volte lo stesso perimetro da ECC per buttarne
    // via ogni volta quasi tutto.
    //
    // QUESTO NUMERO NON E' UN TETTO NOSTRO. I tetti veri sono a monte, per area, e si dichiarano
    // gia' da soli (IS_PROD_ORDER_MAX_ROWS, PLANT_ROWS_MAX_PAGES x PLANT_ROWS_PAGE). Qui si chiede
    // semplicemente «tutto»: il valore combacia con LIST_MAX_TOP di readPaging.
    //
    // E QUANDO I DUE HANNO DIVERSO, IL DISALLINEAMENTO E' RESTATO NASCOSTO LO STESSO — qui c'era
    // scritto il contrario, e la frase e' costata mesi. Fra questo numero e `readPaging` c'e' un
    // TERZO tetto che nessuno dei due dichiara: `paging.js` di CAP gira nella fase `_initial` e
    // taglia il `$top` a `cds.env.query.limit.max`, 1000 di default. Il rilevamento qui sotto
    // c'era ed e' scattato — `_loadTab` confronta le righe ricevute con `$count` — ma il testo
    // che alza (`listTruncated`) nomina LA SORGENTE, quindi per mesi la dashboard ha mostrato
    // 1000 righe di 4761 dicendo che era SAP a non darne di piu' e mandando a restringere il
    // perimetro col selettore plant. Un rilevamento che non nomina QUALE tetto ha morso non
    // dichiara: attribuisce. Il tetto di CAP e' ora dichiarato con `@cds.query.limit.max: 0`
    // sulle tre entity di lista (cat-service.cds), e da li' `listTruncated` puo' scattare solo
    // sui tetti veri di area — dove il consiglio del selettore plant e' quello giusto.
    const LIST_MAX_ROWS = 20000;

    // ================================================================
    // [COLUMN-SORT] I campi che sulla scheda Materiali NON arrivano con la lista.
    //
    // In via veloce il server li rende `null` e li riempie il browser, a blocchi ([FAST-LIST],
    // DEC-75). Ordinare o filtrare su uno di questi mentre il riempimento e' in corso lavora su
    // cio' che e' arrivato finora: si fa lo stesso — l'utente non deve aspettare — ma si
    // DICHIARA, o un elenco ordinato a meta' sembra un elenco ordinato.
    //
    // E' il gemello client di PRODUCT_DETAIL_FIELDS in srv/cat-service.js. Qui bastano i campi
    // che hanno una COLONNA: gli altri non sono ne' ordinabili ne' filtrabili, quindi non possono
    // far scattare l'avviso.
    const PRODUCT_DETAIL_COLUMNS = ["ProductDescription", "ProductType", "BaseUnit"];

    // ================================================================
    // [LIST-WHOLE-SET] Le tre schede, in forma di dato: la stessa meccanica di caricamento vale
    // per tutte e tre, e cio' che cambia sta qui invece che in tre funzioni gemelle.
    const TABS = {
        products: {
            table: "productsTable",
            model: "productModel",           // JSONModel della scheda (l'OData sta su _oSrv)
            srv: "_oProductSrv",
            entity: "/Products",
            label: "materiali",
            emptyText: "noProductsFound"
        },
        routings: {
            table: "routingsTable",
            model: "routingModel",
            srv: "_oRoutingSrv",
            entity: "/Routings",
            label: "cicli",
            emptyText: "noRoutingsFound"
        },
        prodOrders: {
            table: "productionOrdersTable",
            model: "prodOrderModel",
            srv: "_oProdOrderSrv",
            entity: "/ProductionOrders",
            label: "ordini di produzione",
            // Il messaggio resta quello di prima. [ORDER-STATUS-FILTER] Non sostituisce il
            // `noDataText` della tabella, che dalla 0017 spiega se il plant e' fuori perimetro:
            // quello e' scritto nella schermata e resta, questo passa e basta.
            emptyText: "noProductionOrdersFound"
        }
    };

    /** Lo stato iniziale del JSONModel di una scheda: righe, nota dichiarata, criteri attivi. */
    function emptyTabModel() {
        return {
            rows: [],
            count: 0,
            note: { visible: false, text: "", type: "Information" },
            criteria: { visible: false, text: "" }
        };
    }

    return Controller.extend("avvaleplm.marsplm.sap2plex.main.controller.DashboardNavigation", {

        // ================================================================
        // [APP-URL] Apre la configurazione plant. DUE STRADE, e la prima e' l'intent.
        //
        // Dentro una shell (Work Zone, FLP) e' la shell a sapere dove sta l'altra app e con che
        // parametri aprirla: si chiede `marsplm-admin`, l'inbound che `adminconfigplant` dichiara
        // nel suo manifest. Un URL costruito a mano la' non puo' funzionare, perche' l'origine e'
        // il launchpad e non il posto dove stanno le app.
        //
        // Fuori dalla shell — approuter e `cds watch` — si ripiega sull'app accanto.
        // `../adminconfigplant/webapp/index.html`, che c'era prima, presuppone il layout di
        // `cds watch` (`/<cartella>/webapp/`): la' risponde `200`, misurato, ma nel repository
        // HTML5 `index.html` sta alla RADICE dell'app e non sotto `webapp/`, quindi in produzione
        // quel path non dovrebbe esistere. Non l'ho misurato in cloud: `AppUrl.sibling` funziona
        // in entrambi i layout, quindi la domanda non si pone piu'.
        // ================================================================
        onOpenPlantConfig() {
            const oContainer = window.sap && window.sap.ushell && window.sap.ushell.Container;
            if (oContainer && typeof oContainer.getServiceAsync === "function") {
                oContainer.getServiceAsync("CrossApplicationNavigation")
                    .then((oNav) => oNav.toExternal({
                        target: { semanticObject: "marsplm", action: "admin" }
                    }))
                    .catch((oErr) => {
                        console.warn(">>> [APP-URL] navigazione per intent non riuscita,"
                            + " ripiego sull'app accanto:", oErr);
                        this._openPlantConfigBeside();
                    });
                return;
            }
            this._openPlantConfigBeside();
        },

        /**
         * [APP-URL] Il ripiego: l'app accanto, sotto lo stesso genitore.
         *
         * `sibling` rende `null` quando la grafia del nome cartella non e' ricavabile — la stessa
         * app si chiama `avvaleplmmarsplmsap2plexadminconfigplant` sull'approuter e
         * `avvaleplm.marsplm.sap2plex.adminconfigplant` sotto `cds watch`, e una terza grafia non
         * si indovina. Là si DICHIARA: aprire una scheda su una pagina che non c'e' e' peggio di
         * un messaggio, perche' sembra un guasto dell'altra app.
         */
        _openPlantConfigBeside() {
            const sUrl = AppUrl.sibling("avvaleplm.marsplm.sap2plex.adminconfigplant", "index.html");
            if (!sUrl) {
                MessageBox.information(this._i18n().getText("openPlantConfigFromLauncher"));
                return;
            }
            window.open(sUrl, "_blank");
        },

        // [I18N-EARLY] Il bundle si chiede al COMPONENTE quando la vista non ce l'ha ancora.
        // In `onInit` una vista instradata non e' ancora nell'albero dei controlli — il router la
        // crea (`Target._load`) e la inserisce nell'aggregazione `pages` solo dopo
        // (`Target._place`) — quindi i modelli del componente non le sono ancora propagati e
        // `getView().getModel("i18n")` risponde `undefined`. E' lo stesso motivo per cui
        // App.controller.js legge il modello da `getOwnerComponent()`.
        //
        // Non e' un dettaglio di stile: un `getResourceBundle()` su `undefined` dentro `onInit`
        // interrompe il metodo, `Target._place` intercetta e la vista non viene MAI inserita —
        // schermata vuota, e poi un errore per ogni riga di tabella perche' da li' in avanti
        // nemmeno i formatter vedono l'i18n.
        _i18n() {
            const oModel = this.getView().getModel("i18n") || this.getOwnerComponent().getModel("i18n");
            return oModel.getResourceBundle();
        },

        onInit() {
            console.log(">>> DashboardNavigation controller loaded!");

            // [IS-CALL-LOG] Registra window.isCalls() / window.isCallsAll(): da qui in avanti la
            // traccia delle chiamate verso SAP e' interrogabile da qualunque schermata.
            IsCallLog.install();

            // [DETAILS-PREFETCH] Stato del riempimento dettagli: i dettagli gia' ottenuti
            // (materiale -> righe del server) e la generazione del perimetro, che invalida cache
            // e precaricamento in corso quando l'utente cambia plant o preme Aggiorna.
            this._mDetails = new Map();
            this._iScopeGen = 0;
            this._iPrefetchedGen = -1;

            // Create OData v4 model pointing to the Product service (/products/)
            // The Product service (cat-service.cds) serves OData v4 and delegates
            // READ requests to the external API_PRODUCT_SRV (OData v2) via cat-service.js
            //
            // I MODELLI ODATA SI COSTRUISCONO QUI, NON NEL MANIFEST, e non e' una preferenza di
            // stile. Il manifest dichiarava un "productModel" di tipo sap.ui.model.odata.v2 su
            // /products/ con preload: true — cioe' una lettura di $metadata interpretata come V2 su
            // un endpoint che e' V4, fatta a ogni apertura dell'app e poi sovrascritta da queste
            // righe. Tutti gli 11 service CAP del progetto sono OData V4 (nessun @protocol nel
            // progetto), quindi quella dichiarazione era rumore che non poteva funzionare: e' stata
            // rimossa insieme alla dataSource /odata/v4/processor/, per cui nessun service esiste.
            // Residui di @sap/generator-fiori. Chi rimette un modello OData nel manifest si porta
            // dietro anche il preload, che parte prima di onInit.
            //
            // [LIST-WHOLE-SET] I TRE MODELLI ODATA NON SONO PIU' MODELLI DELLA VISTA. Nessuna
            // tabella si lega piu' a loro: le tre schede stanno su altrettanti JSONModel che
            // portano l'insieme intero, e questi servono solo a `_loadTab` per fare la lettura.
            // Tenerli sul controller e non sulla vista non e' cosmetica — cosi' i nomi
            // `productModel` / `prodOrderModel` / `routingModel` restano ai JSONModel e le CELLE
            // dei tre fragment non cambiano di una riga.
            //
            // `autoExpandSelect: false` E' OBBLIGATORIO, e va insieme al resto. Con `true` UI5
            // deriva il `$select` dai controlli legati al binding: qui al binding non e' legato
            // nessun controllo — le righe finiscono in un JSONModel — quindi chiederebbe le SOLE
            // chiavi e ogni colonna arriverebbe vuota. Senza `$select` la risposta porta tutti i
            // campi, che e' esattamente quello che serve (e rende superfluo il `$select`
            // esplicito che ProductionOrdersTab teneva per le due chiavi interne, [IS-FULL-KEY]).
            this._oProductSrv = new sap.ui.model.odata.v4.ODataModel({
                serviceUrl: AppUrl.url("/products/"),
                operationMode: "Server",
                autoExpandSelect: false,
                earlyRequests: true
            });


            //inizio Mirko
            //const sComponentPath = sap.ui.require.toUrl(this.getOwnerComponent().getMetadata().getComponentName().replace(/\./g, "/")) + "/";


            //this._oProductSrv = new sap.ui.model.odata.v4.ODataModel({ serviceUrl: sComponentPath + "products/", operationMode: "Server", autoExpandSelect: false, earlyRequests: true });
            //fine Mirko
            this._oProdOrderSrv = new sap.ui.model.odata.v4.ODataModel({
                serviceUrl: AppUrl.url("/production-orders/"),
                operationMode: "Server",
                autoExpandSelect: false,
                earlyRequests: true
            });
            this._oRoutingSrv = new sap.ui.model.odata.v4.ODataModel({
                serviceUrl: AppUrl.url("/production-routings/"),
                operationMode: "Server",
                autoExpandSelect: false,
                earlyRequests: true
            });

            // [LIST-WHOLE-SET] Un JSONModel per scheda: righe, conteggio, nota dichiarata e
            // criteri attivi. I nomi sono quelli di prima, quindi le celle dei fragment restano.
            Object.keys(TABS).forEach((sTab) => {
                this.getView().setModel(new JSONModel(emptyTabModel()), TABS[sTab].model);
            });

            // [ORDER-STATUS-FILTER] Motivo di una lista ordini vuota (feature 0017). Il perimetro
            // per stato e' fail-closed: un plant senza configurazione non viene letto, e la
            // tabella resterebbe vuota senza dire perche'. Il testo parte dal generico e diventa
            // specifico quando prodOrderScope() risponde.
            this.getView().setModel(new JSONModel({
                noDataText: this._i18n().getText("osfNoOrders")
            }), "prodOrderScope");
            this._refreshProdOrderScope();

            // ================================================================
            // [PLANT-ACCESS] Il perimetro dell'utente (feature 0048): popola il selettore plant e
            // dichiara in testata perche' un plant non c'e'.
            //
            // NON SI ATTENDE, e non serve un velo. Le tre letture qui sotto partono senza sapere il
            // perimetro, ma sono GIA' filtrate dal server: a selettore vuoto `_loadTab` non manda
            // nessun `?plants=`, e il server usa il perimetro dell'utente per intero. Quindi nessuna
            // riga fuori perimetro compare per poi sparire — non c'e' niente da coordinare.
            //
            // LA NOTA STA IN TESTATA, non nei tre MessageStrip delle schede, e per due ragioni che
            // valgono insieme: il perimetro e' UNO e non tre, e `_loadTab` azzera la nota di scheda
            // a ogni lettura (piu' sotto), quindi la dichiarazione sparirebbe al primo Aggiorna.
            // ================================================================
            this.getView().setModel(new JSONModel({
                plants: [],
                note: { visible: false, text: "", type: "Information" },
                // [MASS-IMPORT] L'utente ha un ruolo di CONFIGURAZIONE (admin o admin-config) su
                // almeno un plant? Nasce `false` ed e' FAIL-CLOSED: finche' `usablePlants()` non ha
                // risposto, e su un errore di lettura, resta `false`. Un pulsante che compare per
                // un attimo e poi sparisce e' peggio di uno che compare tardi.
                canConfigure: false,
                // I plant su cui puo' configurare: e' il perimetro della tendina dei template.
                configurablePlants: []
            }), "plantScope");
            this._loadUsablePlants();

            // [PLANT-ACCESS] Il modello OData su CatalogService E' STATO RIMOSSO (feature 0048).
            // Serviva a UNA cosa: popolare il selettore plant leggendo `ZPlant`. Ora quell'elenco
            // arriva da `usablePlants()` con una `fetch`, e i suoi due soli consumatori — il
            // selettore e il Select del dialogo template — sono passati al modello `plantScope`.
            // Tenerlo avrebbe significato scaricare a ogni apertura il `$metadata` di un service
            // da oltre cento entity per non usarlo.

            // OData v4 model on the RoutingTemplate service (/routing-templates/) — backs the
            // "Manage Templates" dialog (template list, filtered per plant).
            var oTemplateModel = new sap.ui.model.odata.v4.ODataModel({
                serviceUrl: AppUrl.url("/routing-templates/"),
                operationMode: "Server",
                autoExpandSelect: true
            });
            this.getView().setModel(oTemplateModel, "templateModel");

            // ================================================================
            // [COLUMN-SORT] Le intestazioni diventano cliccabili.
            //
            // I tre blocchi `addEventDelegate` che stavano qui — busy, IsCallLog.dump() e
            // innesco del riempimento dettagli, agganciati a `dataRequested`/`dataReceived` del
            // binding OData — non servono piu': quei tre passi sono ora espliciti dentro
            // `_loadTab`, che e' l'unico posto da cui parte una lettura. Erano agganciati in
            // `onAfterRendering` perche' il binding a `onInit` non esisteva ancora; con un
            // JSONModel il problema non si pone.
            // ================================================================
            Object.keys(TABS).forEach((sTab) => {
                const oCfg = TABS[sTab];
                const oTab = this.byId(oCfg.table);
                if (!oTab) { return; }
                ColumnMenu.install(oTab, {
                    i18n: this._i18n(),
                    onChange: (oState) => this._onCriteriaChange(sTab, oState)
                });
            });

            // [LIST-WHOLE-SET] Le tre letture partono qui, una per scheda. Non si aspettano fra
            // loro: ognuna riempie la sua tabella appena arriva.
            Object.keys(TABS).forEach((sTab) => { this._loadTab(sTab); });

            // ========================================================
            // [PROBE] Le sonde di diagnosi verso SAP NON partono piu' da qui (W1-20).
            //
            // Fino a oggi l'apertura di questa dashboard — e quindi ogni refresh, ogni
            // riapertura della scheda, ogni utente — lanciava cinque sonde, tre delle quali
            // SCRIVONO in SAP: un movimento merci, sei varianti di conferma su un ordine VERO
            // (storno manuale in CO13) e le due FM di chiusura ordine, che non hanno test run.
            //
            // `install()` non chiama niente: registra i comandi di console e stampa l'elenco.
            // Le sonde restano intere e si lanciano a mano — window.splitJobProbe(),
            // window.jobSchedProbe(), window.plexHistoryProbe(), window.orderStatusPost(),
            // window.matDocPost(). Il perche' e i limiti sono in testa a util/Probes.js.
            //
            // Il 03/09/2026 l'eccezione e' rientrata: la sonda del canale ordini, l'unica che
            // partisse da sola proprio da qui, ha risposto (DEC-123) ed e' stata rimossa. Non
            // parte piu' NIENTE da questa onInit, come vuole DEC-72.
            //
            // E LE SONDE CHE SCRIVONO SONO DUE, non tre: con lo stesso criterio e' poi uscita la
            // batteria delle sei conferme su un ordine vero, la piu' costosa di tutte — storno
            // solo in CO13. Vedi util/Probes.js.
            // Perimetro: grep -rn "PROBE".
            // ========================================================
            Probes.install();
        },

        /**
         * [LIST-WHOLE-SET] I tre modelli OData vanno distrutti a mano.
         *
         * Finche' erano modelli della VISTA li distruggeva UI5 insieme a lei. Ora vivono sul
         * controller — perche' i loro nomi sono passati ai JSONModel delle schede — e senza
         * questo `onExit` resterebbero in piedi con la loro cache di `$metadata` a ogni uscita
         * dalla dashboard.
         */
        onExit() {
            // Prima si fanno scadere le letture e i riempimenti in volo, poi si distrugge: una
            // risposta che arrivasse dopo scriverebbe su modelli che non ci sono piu'.
            this._iScopeGen = (this._iScopeGen || 0) + 1;
            this._mLoadGen = this._mLoadGen || {};
            Object.keys(TABS).forEach((sTab) => {
                this._mLoadGen[sTab] = (this._mLoadGen[sTab] || 0) + 1;
                const oSrv = this[TABS[sTab].srv];
                if (oSrv && typeof oSrv.destroy === "function") { oSrv.destroy(); }
                this[TABS[sTab].srv] = null;
            });
        },

        // ================================================================
        // [LIST-WHOLE-SET] LA LETTURA DI UNA SCHEDA.
        //
        // Una richiesta, l'insieme intero, e da li' in poi ordinamento, filtro e ricerca vivono
        // nel browser. E' l'unico punto da cui parte una lettura di lista: `onInit`, Aggiorna e
        // il selettore plant passano tutti di qui.
        //
        // I TRE PASSI CHE PRIMA ERANO EVENTI DEL BINDING sono ora espliciti e in ordine: busy,
        // `IsCallLog.dump()` (com'e' stata fatta la lettura verso SAP) e, sui materiali,
        // l'innesco del riempimento dettagli.
        //
        // UN ERRORE NON DIVENTA UNA LISTA VUOTA. Il server respinge di proposito invece di
        // rispondere `[]` — `502` della guardia [IS-BLANK-ROWS], `502` dei campi di perimetro non
        // valutabili ([ORDER-STATUS-FILTER]), `400` di un criterio non riproducibile: sono
        // DICHIARAZIONI, e mostrarle come «nessun dato» e' il caso peggiore del contratto (C-6).
        // Qui il rifiuto arriva come promessa rigettata e diventa la nota rossa della scheda.
        // ================================================================
        async _loadTab(sTab, mOpts) {
            const oCfg = TABS[sTab];
            const oTable = this.byId(oCfg.table);
            const oModel = this.getView().getModel(oCfg.model);
            const oSrv = this[oCfg.srv];
            if (!oCfg || !oModel || !oSrv) { return; }

            // ================================================================
            // OGNI SCHEDA HA LA SUA GENERAZIONE DI LETTURA, e non e' la generazione del
            // PERIMETRO (`_iScopeGen`, che governa la cache dei dettagli materiale).
            //
            // Le due cose sembrano la stessa e non lo sono: «Aggiorna» sui Materiali incrementa
            // il perimetro, e con un contatore unico avrebbe fatto scartare una lettura dei Cicli
            // ancora in volo — che nessuno avrebbe poi ritentato, lasciando quella scheda vuota
            // senza dire perche'. Il contatore per scheda risponde alla sola domanda che serve
            // qui: «questa risposta e' ancora quella che ho chiesto io?».
            // ================================================================
            this._mLoadGen = this._mLoadGen || {};
            const iGen = (this._mLoadGen[sTab] || 0) + 1;
            this._mLoadGen[sTab] = iGen;

            if (oTable) { oTable.setBusy(true); }
            this._setTabNote(sTab, null);

            const aPlants = this._selectedPlants();
            const mParameters = { $count: true };
            // Il selettore plant NON e' un filtro di vista: cambia il PERIMETRO che il server
            // legge, quindi viaggia come opzione di query e obbliga a rileggere.
            if (aPlants.length) { mParameters.plants = aPlants.join(","); }
            // [PLANT-ROWS] «Aggiorna» viaggia sullo stesso canale, e per la stessa ragione: il
            // server tiene il perimetro materiali in cache per cinque minuti, e senza questa
            // opzione il tasto ridisegnerebbe le righe di prima senza dirlo. Il server la legge
            // solo sui Materiali; sulle altre schede e' inerte, e va bene cosi': una sola strada.
            if (mOpts && mOpts.fresh) { mParameters.refresh = "1"; }

            // Il binding e' usa-e-getta: serve solo a fare la lettura, le righe finiscono nel
            // JSONModel e nessun controllo resta legato a lui. Va distrutto nel `finally`, o a
            // ogni Aggiorna e a ogni cambio plant se ne accumulerebbe uno nel modello OData.
            let oBinding = null;
            try {
                oBinding = oSrv.bindList(oCfg.entity, null, null, null, mParameters);
                const aContexts = await oBinding.requestContexts(0, LIST_MAX_ROWS);
                // Una lettura piu' recente della stessa scheda e' gia' partita: questa risposta
                // appartiene al perimetro di prima, e scriverla mostrerebbe righe di un plant che
                // non e' piu' selezionato.
                if (iGen !== this._mLoadGen[sTab]) {
                    console.log(`>>> [LIST-WHOLE-SET] lettura ${oCfg.label} scartata: perimetro cambiato`);
                    return;
                }
                const aRows = aContexts.map(oCtx => oCtx.getObject());

                // Il totale dichiarato dal server: se supera le righe arrivate, la sorgente ha
                // raggiunto un tetto e l'insieme NON e' completo. Va detto, o ordinamento e
                // filtro lavorerebbero su una parte spacciata per il tutto.
                let iCount = aRows.length;
                try {
                    const iDeclared = await oBinding.getHeaderContext().requestProperty("$count");
                    if (Number.isFinite(Number(iDeclared))) { iCount = Number(iDeclared); }
                } catch (oCountError) {
                    console.warn(`[LIST-WHOLE-SET] conteggio non dichiarato per ${oCfg.label}:`,
                        oCountError.message);
                }

                oModel.setProperty("/rows", aRows);
                oModel.setProperty("/count", iCount);
                console.log(`>>> [LIST-WHOLE-SET] ${oCfg.label}: ${aRows.length} righe caricate`
                    + ` (conteggio dichiarato ${iCount})`);
                // [IS-CALL-LOG] come e' stata fatta la lettura verso SAP, in console.
                IsCallLog.dump("lista " + oCfg.label);

                if (iCount > aRows.length) {
                    this._setTabNote(sTab, {
                        type: "Warning",
                        text: this._i18n().getText("listTruncated", [String(aRows.length), String(iCount)])
                    });
                }

                // I criteri attivi vanno ri-applicati alle righe nuove: il binding e' lo stesso,
                // ma l'array sotto e' stato sostituito.
                if (oTable) { ColumnMenu.refresh(oTable); }

                if (!aRows.length) { this._onEmptyTab(sTab); }
                if (sTab === "products") {
                    this._fillProductDetails();
                    // [PLANT-ROWS] La lista e' a schermo: ora si chiede se e' TUTTO il perimetro.
                    // Non si aspetta — la nota puo' arrivare un istante dopo le righe — e non
                    // costa nessuna lettura verso SAP: il server rende il verdetto che ha gia'.
                    this._declareProductScope(iGen);
                }
            } catch (oError) {
                if (iGen !== this._mLoadGen[sTab]) { return; }
                const sMessage = this._httpMessageOf(oError);
                console.error(`>>> [LIST-WHOLE-SET] lettura ${oCfg.label} NON riuscita:`, sMessage);
                oModel.setProperty("/rows", []);
                oModel.setProperty("/count", 0);
                this._setTabNote(sTab, {
                    type: "Error",
                    text: this._i18n().getText("listLoadFailed", [sMessage])
                });
            } finally {
                if (oBinding && typeof oBinding.destroy === "function") { oBinding.destroy(); }
                // Se una lettura piu' recente e' in corso, il busy lo toglie lei: toglierlo qui
                // mostrerebbe come pronta una tabella che sta ancora caricando.
                if (oTable && iGen === this._mLoadGen[sTab]) { oTable.setBusy(false); }
            }
        },

        /**
         * Il messaggio di un rifiuto del server, non il suo involucro.
         *
         * Un `req.reject(502, '…')` di CAP arriva al client con il testo dentro `error.message`
         * dell'oggetto OData; UI5 lo espone in modi diversi a seconda di dove si rompe. Si prende
         * il primo testo utile disponibile: senza, la nota direbbe «Request intercepted by
         * ...», che non aiuta nessuno.
         */
        _httpMessageOf(oError) {
            if (!oError) { return "errore sconosciuto"; }
            const oCause = oError.error || (oError.cause && oError.cause.error);
            if (oCause && oCause.message) { return String(oCause.message); }
            return String(oError.message || oError);
        },

        // ================================================================
        // [PLANT-ROWS] La lista mostrata e' TUTTO il perimetro? (feature 0035)
        //
        // Un perimetro tagliato — una pagina che l'iFlow rifiuta a qualunque dimensione, la
        // scadenza di lettura, uno `$skip` che la sorgente non onora — produce una lista piu'
        // corta e per il resto identica: nessun errore, nessun conteggio che non torna (il
        // `$count` lo calcola il server sulle righe che ha). Senza questa nota, «mancano dei
        // materiali» e «quei materiali non ci sono» sono la stessa schermata.
        //
        // Tre proprieta' di questa chiamata. Non legge niente da SAP: `productScope` rende il
        // verdetto che il lettore ha conservato per ogni plant. Non tocca la nota se la lettura
        // e' andata bene — o se e' gia' stata dichiarata un'altra causa, che sara' piu' precisa
        // di questa. E se fallisce, tace: non riuscire a spiegare una lista non e' un motivo per
        // sostituirla con un errore.
        // ================================================================
        _declareProductScope(iGen) {
            const aKeys = this._selectedPlants();
            const sUrl = AppUrl.url("/products/productScope()")
                + (aKeys.length ? "?plants=" + encodeURIComponent(aKeys.join(",")) : "");
            fetch(sUrl, { headers: { "Accept": "application/json" } }).then((res) => {
                if (!res.ok) { throw new Error("HTTP " + res.status); }
                return res.json();
            }).then((oData) => {
                // La risposta appartiene a una lettura superata: la nota parlerebbe di un
                // perimetro che non e' piu' quello a schermo.
                if (iGen !== this._mLoadGen.products) { return; }
                if (!oData) { return; }
                if (this._mBaseNote && this._mBaseNote.products) { return; }

                // ================================================================
                // [MAT-SCOPE] DUE NOTIZIE DIVERSE, E L'INCOMPLETEZZA VIENE PRIMA (feature 0050).
                //
                // «Non ho potuto leggere tutto» e «questi materiali non hanno una categoria» sono
                // due cose con rimedi opposti — la prima si riprova, la seconda si configura — e
                // la prima e' piu' grave, perche' rende incerto anche il conteggio della seconda:
                // su un perimetro letto a meta' non si sa quanti materiali siano stati potati.
                // Quindi si dichiara quella, e sola.
                //
                // La potatura NON e' un `Warning`: e' il customizing che fa il suo lavoro. Un
                // avviso giallo su una configurazione corretta insegna a ignorare il giallo, e la
                // striscia serve solo a impedire che una tabella vuota — o accorciata — si legga
                // come «questi materiali non ci sono».
                // ================================================================
                if (oData.Complete === false) {
                    console.warn(">>> [PLANT-ROWS] perimetro materiali incompleto:", oData.Reason);
                    this._setTabNote("products", {
                        type: "Warning",
                        text: this._i18n().getText("productScopeIncomplete", [oData.Reason || "?"])
                    });
                    return;
                }
                if (oData.Excluded > 0) {
                    console.log(">>> [MAT-SCOPE] materiali esclusi dal perimetro:",
                        oData.Excluded, oData.ExcludedReason);
                    this._setTabNote("products", {
                        type: "Information",
                        text: this._i18n().getText("productScopeExcluded",
                            [oData.Excluded, oData.ExcludedReason || "?"])
                    });
                }
            }).catch((oError) => {
                console.warn(">>> [PLANT-ROWS] verdetto del perimetro non disponibile:", oError.message);
            });
        },

        // ================================================================
        // [PLANT-ACCESS] Il perimetro dell'utente: la tendina e la nota (feature 0048).
        //
        // Una chiamata, all'apertura. Non legge il selettore — e' la function che lo POPOLA — e non
        // legge niente verso SAP: il perimetro e' plant attivi ∩ licenziati ∩ ruolo dell'utente.
        //
        // SE FALLISCE, LA TENDINA RESTA VUOTA E LO DICE. E' la direzione opposta a
        // `_declareProductScope`, che su errore tace: la' la nota e' una spiegazione in piu' su una
        // lista che c'e', qui e' l'elenco stesso dei plant. Una tendina vuota in silenzio si legge
        // come «non ci sono plant», che e' la sparizione che questa feature esiste per evitare.
        //
        // LE QUATTRO CAUSE SI DICHIARANO SEPARATE perche' hanno rimedi diversi: nessun ruolo (si
        // chiede l'abilitazione), license server muto (si riprova), e la leva di sviluppo accesa
        // (che scavalca il perimetro e va spenta). L'ordine e' per gravita': una leva che rende le
        // liste piu' larghe del perimetro viene prima di tutto, perche' rende la nota stessa falsa.
        // ================================================================
        _loadUsablePlants() {
            const oBundle = this._i18n();
            const oModel = this.getView().getModel("plantScope");
            if (!oModel) { return; }
            const setNote = (sText, sType) => {
                oModel.setProperty("/note", { visible: !!sText, text: sText || "", type: sType || "Information" });
            };

            fetch(AppUrl.url("/odata/v4/catalog/usablePlants()"), { headers: { "Accept": "application/json" } })
                .then((res) => {
                    if (!res.ok) { throw new Error("HTTP " + res.status); }
                    return res.json();
                })
                .then((oData) => {
                    const aPlants = (oData && oData.Plants) || [];
                    const iTotal = Number(oData && oData.Total) || 0;
                    const aExcluded = (oData && oData.Excluded) || [];
                    oModel.setProperty("/plants", aPlants);

                    // [MASS-IMPORT] La soglia della CONFIGURAZIONE, che e' piu' alta di quella con
                    // cui si apre la dashboard: `usablePlants()` rende i plant concessi — dove
                    // l'utente ha UN ruolo qualsiasi — e qui si tengono solo quelli dove quel ruolo
                    // e' `admin` o `admin-config`. Le due soglie non si fondono (CLAUDE.md).
                    const aConfigurable = TemplateImport.configurablePlants(aPlants);
                    oModel.setProperty("/configurablePlants", aConfigurable);
                    oModel.setProperty("/canConfigure", aConfigurable.length > 0);

                    const sGates = (oData && oData.Gates) || "";
                    const iUnknown = aExcluded.filter((p) => p.RoleKnown === false).length;
                    if (sGates) {
                        setNote(oBundle.getText("psScopeGates", [sGates]), "Warning");
                    } else if (!aPlants.length) {
                        setNote(oBundle.getText("psScopeEmpty"), "Warning");
                    } else if (iUnknown) {
                        setNote(oBundle.getText("psScopeUnknown", [String(iUnknown)]), "Warning");
                    } else if (iTotal > aPlants.length) {
                        setNote(oBundle.getText("psScopePartial",
                            [String(aPlants.length), String(iTotal)]), "Information");
                    } else {
                        setNote(null);
                    }
                    console.log(">>> [PLANT-ACCESS] perimetro utente: " + aPlants.length + "/" + iTotal
                        + " plant" + (sGates ? " — LEVE: " + sGates : ""));
                    // [LICENSE-BODY] Le chiamate che hanno prodotto quel numero, per intero. Girano
                    // DENTRO la fetch qui sopra, che e' gia' attesa: quando si arriva qui le voci
                    // sono nell'anello.
                    //
                    // CON PERIMETRO VUOTO SI DICHIARA, e non e' un dettaglio: la function che serve
                    // la traccia si ferma su «hai almeno un plant?», quindi proprio nel caso in cui
                    // servirebbe non tornerebbe nulla. Il silenzio si legge come «non c'e' nessun
                    // check di licenza» — l'equivoco che ha innescato tutto questo — e qui il numero
                    // di plant e' in mano, quindi la causa si nomina invece di lasciare il vuoto.
                    if (!aPlants.length) {
                        console.warn("[LICENSE-CALL] perimetro vuoto: la traccia delle chiamate di " +
                            "licenza NON viene servita (serve almeno un plant nel proprio perimetro). " +
                            "Il verdetto per ogni plant e' nei log del server: cf logs " +
                            "marsplm-sap2plex-srv --recent | grep '\\[LICENSE\\]'");
                        this._declareNoPlantAccess(oBundle);
                    } else {
                        IsCallLog.dumpLicense("perimetro utente");
                    }
                })
                .catch((oError) => {
                    console.error(">>> [PLANT-ACCESS] perimetro non determinato:", oError.message);
                    oModel.setProperty("/plants", []);
                    setNote(oBundle.getText("psScopeUnknown", ["?"]), "Error");
                });
        },

        // ================================================================
        // [PLANT-ACCESS] Perimetro vuoto: si DICE, e non solo in testata (feature 0048).
        //
        // La striscia in testata c'e' da sempre, ma e' passiva: su una dashboard che si apre vuota
        // si legge come «non ci sono dati», che e' proprio l'equivoco da cui questa feature nasce.
        // Un utente non abilitato deve sapere che il rimedio non e' suo — va chiesta
        // un'abilitazione — e deve saperlo senza cercarlo.
        //
        // UN TESTO SOLO, ED E' QUELLO DELLA STRISCIA. Le cause di un perimetro vuoto sono tre
        // (non abilitato, plant non licenziato, license server muto) e la striscia le distingue,
        // ma il popup dice una frase sola: due messaggi diversi sulla stessa schermata si
        // contraddirebbero, e il testo riusato non puo' divergere dalla sua traduzione.
        //
        // UNA VOLTA SOLA. Il perimetro puo' essere ricaricato, e un popup che si ripresenta a ogni
        // lettura e' un popup che si impara a chiudere senza leggere. E' la forma del flag
        // `handling` di SessionGuard, dove un `$batch` produce N 401 e quindi N dialoghi.
        //
        // NON LO APRE IL RAMO DI ERRORE della fetch qui sopra: la' `usablePlants()` non ha
        // risposto, quindi non sappiamo se l'utente abbia dei plant — e dire «non sei abilitato»
        // su un guasto nostro manda a chiedere il rimedio sbagliato. La striscia diventa rossa.
        // ================================================================
        _declareNoPlantAccess(oBundle) {
            if (this._bNoPlantPopupShown) { return; }
            this._bNoPlantPopupShown = true;
            MessageBox.information(oBundle.getText("psScopeEmpty"), {
                title: oBundle.getText("psScopeEmptyTitle")
            });
        },

        /** I plant scelti nel selettore. Vuoto = tutti quelli attivi, come da sempre. */
        _selectedPlants() {
            const oPlantFilter = this.byId("plantFilter");
            return (oPlantFilter && oPlantFilter.getSelectedKeys()) || [];
        },

        // ================================================================
        // La nota dichiarata sopra la tabella, in DUE STRATI.
        //
        // Ce ne sono due tipi e non si escludono: quella della LETTURA (troncamento del perimetro,
        // errore del server) dura quanto le righe, quella TRANSITORIA («dettagli in caricamento»)
        // dura quanto il riempimento. Con un solo strato la seconda cancellava la prima, e un
        // perimetro troncato smetteva di essere dichiarato appena l'utente ordinava per
        // Descrizione — cioe' proprio nel momento in cui contava di piu'.
        //
        // Vince la transitoria finche' c'e'; quando sparisce riemerge quella della lettura.
        // ================================================================
        _setTabNote(sTab, oNote) {
            this._mBaseNote = this._mBaseNote || {};
            this._mBaseNote[sTab] = oNote || null;
            this._renderTabNote(sTab);
        },

        _setTransientNote(sTab, oNote) {
            this._mTransientNote = this._mTransientNote || {};
            this._mTransientNote[sTab] = oNote || null;
            this._renderTabNote(sTab);
        },

        _renderTabNote(sTab) {
            const oModel = this.getView().getModel(TABS[sTab].model);
            if (!oModel) { return; }
            const oNote = (this._mTransientNote && this._mTransientNote[sTab])
                || (this._mBaseNote && this._mBaseNote[sTab])
                || null;
            oModel.setProperty("/note", oNote
                ? { visible: true, text: oNote.text, type: oNote.type || "Information" }
                : { visible: false, text: "", type: "Information" });
        },

        /** Lista vuota: ogni scheda ha il suo modo di dirlo, e due lo dicono da prima. */
        _onEmptyTab(sTab) {
            const oCfg = TABS[sTab];
            if (oCfg.emptyText) {
                MessageToast.show(this._i18n().getText(oCfg.emptyText));
            }
            if (sTab === "routings") {
                // [IS-ROUTING-LIST] Diagnostica in console del BROWSER: con lista vuota si vede
                // subito quale dei tre casi e'. Da rimuovere a migrazione conclusa.
                this._logRoutingListDiag();
            }
        },

        // ================================================================
        // [COLUMN-SORT] I CRITERI ATTIVI SI DICHIARANO.
        //
        // Un elenco filtrato che non dice come e' filtrato si legge come un elenco corto: e' lo
        // stesso motivo per cui la lista ordini non lascia muta una schermata vuota (0017).
        // La riga compare nella `infoToolbar` della tabella, con il pulsante per azzerare.
        //
        // Sui MATERIALI c'e' un secondo avviso, e vale solo mentre i dettagli stanno arrivando:
        // Descrizione, Tipo materiale e UM base non vengono con la lista ma a blocchi ([FAST-LIST],
        // DEC-75), quindi un criterio su una di quelle colonne lavora su cio' che e' arrivato
        // finora. Si applica lo stesso — nessuno deve aspettare — ma si dice. A riempimento
        // concluso l'avviso non compare: si fa e basta.
        // ================================================================
        _onCriteriaChange(sTab, oState) {
            const oModel = this.getView().getModel(TABS[sTab].model);
            if (!oModel) { return; }
            const oBundle = this._i18n();
            const aParts = [];

            if (oState.sort) {
                const sLabel = this._columnLabel(sTab, oState.sort.field) || oState.sort.field;
                aParts.push(oBundle.getText(
                    oState.sort.descending ? "criteriaSortDesc" : "criteriaSortAsc", [sLabel]
                ));
            }
            for (const oCol of oState.columns) {
                aParts.push(oBundle.getText("criteriaFilter",
                    [oCol.label || oCol.field, oCol.query]));
            }
            oModel.setProperty("/criteria", {
                visible: aParts.length > 0,
                text: aParts.join("  ·  ")
            });

            if (sTab === "products") { this._warnIfDetailsPending(oState); }
        },

        /** L'etichetta visibile di una colonna, per nominarla nell'elenco dei criteri attivi. */
        _columnLabel(sTab, sField) {
            const oTable = this.byId(TABS[sTab].table);
            if (!oTable) { return ""; }
            for (const oColumn of oTable.getColumns()) {
                if (oColumn.data("field") !== sField) { continue; }
                const oHeader = oColumn.getHeader && oColumn.getHeader();
                return (oHeader && oHeader.getText && oHeader.getText()) || "";
            }
            return "";
        },

        /** Criterio su una colonna di dettaglio mentre il riempimento e' ancora in corso. */
        _warnIfDetailsPending(oState) {
            const bDone = this._iPrefetchedGen === this._iScopeGen;
            const aFields = oState.columns.map(o => o.field);
            if (oState.sort) { aFields.push(oState.sort.field); }
            const bTouchesDetails = aFields.some(s => PRODUCT_DETAIL_COLUMNS.indexOf(s) !== -1);
            if (!bTouchesDetails || bDone) {
                this._setTransientNote("products", null);
                return;
            }
            const aRows = this.getView().getModel("productModel").getProperty("/rows") || [];
            const iReady = aRows.filter(o => o && o.ProductDescription !== null
                && o.ProductDescription !== undefined).length;
            this._setTransientNote("products", {
                type: "Information",
                text: this._i18n().getText("detailsStillLoading",
                    [String(iReady), String(aRows.length)])
            });
        },

        /** Azzera i criteri di una scheda (il pulsante della `infoToolbar`). */
        _clearCriteria(sTab) {
            const oTable = this.byId(TABS[sTab].table);
            if (oTable) { ColumnMenu.reset(oTable); }
        },

        onClearProductCriteria() { this._clearCriteria("products"); },
        onClearRoutingCriteria() { this._clearCriteria("routings"); },
        onClearProdOrderCriteria() { this._clearCriteria("prodOrders"); },

        // ================================================================
        // [IS-ROUTING-LIST] Diagnostica della sorgente della lista routing,
        // stampata nella console del BROWSER. I console.log del backend finiscono
        // in `cf logs`; questa chiamata porta gli stessi dati qui.
        // Endpoint: GET /production-routings/routingListDiag()
        // Apribile anche a mano in una tab, senza passare dalla dashboard.
        // Da rimuovere a migrazione conclusa.
        // ================================================================
        _logRoutingListDiag() {
            fetch(AppUrl.url("/production-routings/routingListDiag()"), { headers: { "Accept": "application/json" } })
                .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
                .then(d => {
                    console.group("%c[IS-ROUTING-LIST] diagnostica lista routing", "font-weight:bold");
                    console.log("modalita'            :", d.mode);
                    console.log("service root         :", d.paths);
                    console.log("USE_TEST_DATA_FILTER :", d.testDataFilter);
                    console.log("$filter inviato      :", d.filterSent);
                    console.log("righe header da SAP  :", d.headerRows);
                    if (d.error) { console.error("chiamata FALLITA     :", d.error); }
                    if (d.firstRow) { console.log("prima riga grezza    :", d.firstRow); }
                    console.log("plant ammessi        :", d.plantsAllowed);
                    console.log("plant nei dati       :", d.plantsInData);
                    if (d.error) {
                        console.warn("=> IS non raggiunto. Il codice HTTP nel messaggio dice cosa: 400 campo non esposto, 404 entity set, 401/403 auth, 503 routing.");
                    } else if (d.headerRows === 0) {
                        console.warn("=> IS raggiunto ma ha risposto 200 con zero righe: il problema e' a monte, iFlow o RFC.");
                    } else {
                        console.warn("=> Le righe SONO arrivate da SAP e sono state scartate dopo: confronta 'plant ammessi' con 'plant nei dati'.");
                    }
                    console.groupEnd();
                })
                .catch(e => console.error("[IS-ROUTING-LIST] diagnostica non disponibile:", e.message));
        },
        // ================================================================
        // [IS-ROUTING-LIST] fine
        // ================================================================

        // Navigation handler to Detail page
        onNavToDetail() {
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.navTo("detailNavigation");
        },

        // Item press handler - navigate to detail with product context
        onItemPress(oEvent) {
            const oItem = oEvent.getParameter("listItem");
            const oContext = oItem.getBindingContext("productModel");

            if (!oContext) {
                console.error(">>> No binding context found!");
                return;
            }

            // Store selected product data on the component for DetailNavigation
            const oData = oContext.getObject();
            this.getOwnerComponent()._selectedProduct = oData;

            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.navTo("detailNavigation", {
                Product: oData.Product,
                Plant: oData.Plant
            });
        },

        // ================================================================
        // [FAST-LIST] (0013, RB-16c) Riempimento a blocchi dei dettagli materiale.
        //
        // PERCHE': l'elenco si apre con UNA lettura di A_ProductPlant, quindi arriva senza i
        // campi che vengono da A_Product e dalle descrizioni. Prima li leggeva il server tutti
        // insieme, dentro la stessa richiesta: 609 chiamate verso SAP con il browser in attesa,
        // ripetute a ogni pagina di `growing`, fino al 504.
        //
        // COME: si prendono dalle righe i codici con i dettagli ancora vuoti, si chiedono a
        // blocchi e si scrivono nelle righe man mano. Il marcatore di «riga da riempire» e'
        // `ProductDescription === null`: la via lenta del server restituisce sempre una stringa
        // (vuota al massimo), mai null.
        //
        // [DETAILS-PREFETCH] I dettagli ottenuti si CONSERVANO (`this._mDetails`) e ogni giro
        // patcha PRIMA da li', senza toccare la rete. Il divieto della 0013 non era «non leggere
        // tutto»: era non BLOCCARE la richiesta di lista con 1+2N letture sincrone. Qui non si
        // blocca niente — la tabella e' gia' a schermo.
        //
        // [LIST-WHOLE-SET] TRE COSE SONO CAMBIATE, e vanno insieme.
        //
        // 1. Le righe sono TUTTE nel browser, quindi il perimetro e' gia' noto: la chiamata a
        //    `productScope()` che serviva a scoprire i materiali oltre la pagina caricata NON
        //    SERVE PIU' ed e' stata tolta, insieme a `_prefetchAllDetails`. Un giro solo copre
        //    cio' che prima erano due funzioni con due criteri di arresto diversi.
        // 2. Si riempiono TUTTE le righe, non le sole visibili — senza, ordinare per Descrizione
        //    ordinerebbe su valori assenti. La PRECEDENZA alle righe a schermo resta, ed e' la
        //    proprieta' che DEC-75 chiede: le prime `growingThreshold` righe si chiedono in
        //    blocchi piccoli (si vedono progredire), il resto in blocchi grandi.
        // 3. Il riempimento scrive negli oggetti del JSONModel, non nei context OData.
        //
        // La GENERAZIONE del perimetro (`_iScopeGen`) resta il criterio di arresto: cambio plant
        // e Aggiorna la incrementano e svuotano la cache, cosi' un giro in volo si ferma da se'
        // invece di continuare a riempire righe di un perimetro che non c'e' piu'. Una ricerca
        // NON la incrementa: la ricerca restringe la vista, non il perimetro.
        //
        // [MAT-SCOPE] DALLA 0050 QUESTO GIRO NON FA PIU' NESSUNA CHIAMATA, e non e' un difetto:
        // e' la conseguenza di una decisione presa lato server. La lista si produce ora solo DOPO
        // il join con l'anagrafica — un materiale entra in perimetro solo se ha una categoria, e
        // quella risposta esiste solo unendo le due letture — quindi le righe arrivano gia'
        // complete e `_pendingDetailRows` esce VUOTA: il ciclo esce al primo `break`, `bBroken`
        // resta falso e `_iPrefetchedGen` viene marcato, che e' l'esito giusto (i valori ci sono
        // tutti, ordinare su una colonna di dettaglio non deve avvisare).
        //
        // Il codice RESTA, e per due ragioni. La prima e' che `productDetails` e' ancora il
        // ripiego della SCHEDA dopo un F5 (`DetailRead.recover` in DetailNavigation), quindi
        // l'action non e' morta. La seconda e' che il ramo ONPREM non e' mai passato da qui e non
        // cambia. Chi un giorno rimettesse una via veloce lato server ritroverebbe questo giro
        // funzionante: toglierlo ora sarebbe togliere la rete insieme al trapezio.
        // ================================================================
        async _fillProductDetails() {
            if (this._bFillRunning) { this._bFillPending = true; return; }   // ci pensa il giro in corso
            this._bFillRunning = true;
            const iGen = this._iScopeGen;
            let bBroken = false;     // un blocco non arrivato: il precaricamento non si dichiara concluso
            try {
                do {
                    this._bFillPending = false;
                    const mByProduct = this._pendingDetailRows();
                    if (!mByProduct.size) { break; }

                    // [DETAILS-PREFETCH] Prima la cache: cio' che e' gia' stato portato finisce
                    // nelle righe subito, senza una richiesta.
                    const aMissing = this._applyCachedDetails(mByProduct);
                    if (!aMissing.length) { continue; }

                    // La precedenza alle righe a schermo: quelle che `growing` sta gia' mostrando
                    // si chiedono in blocchi piccoli, il resto del perimetro in blocchi grandi.
                    const aOnScreen = this._onScreenProducts();
                    const aPrime = aMissing.filter(s => aOnScreen.has(s));
                    const aRest = aMissing.filter(s => !aOnScreen.has(s));
                    console.log(`>>> [FAST-LIST] dettagli da riempire: ${aPrime.length} a schermo`
                        + ` (blocchi da ${DETAILS_BLOCK}), ${aRest.length} nel resto del perimetro`
                        + ` (blocchi da ${PREFETCH_BLOCK})`);

                    const fnConsume = (aRows) => {
                        this._cacheDetailRows(aRows);
                        this._applyDetailRows(mByProduct, aRows);
                    };

                    // Sulle righe a schermo un blocco perso ferma il giro: l'utente ha davanti una
                    // lista che si sta riempiendo e il perche' va visto subito. Sul resto si
                    // prosegue, perche' morire su un blocco lascerebbe non riempito tutto il resto.
                    const oPrime = await this._requestDetailBlocks(aPrime, DETAILS_BLOCK, iGen,
                        fnConsume, { stopOnError: true, label: "[FAST-LIST]" });
                    if (oPrime.aborted) { break; }
                    if (oPrime.failedBlocks) { bBroken = true; break; }

                    const oRest = await this._requestDetailBlocks(aRest, PREFETCH_BLOCK, iGen,
                        fnConsume, { stopOnError: false, label: "[DETAILS-PREFETCH]" });
                    if (oRest.aborted) { break; }
                    if (oRest.failedBlocks) { bBroken = true; }
                } while (this._bFillPending && iGen === this._iScopeGen);
            } finally {
                this._bFillRunning = false;
            }

            // Il perimetro e' cambiato mentre riempivamo: la richiesta arrivata nel frattempo
            // appartiene a QUELLO NUOVO e va servita, non persa insieme al giro interrotto.
            if (this._bFillPending && iGen !== this._iScopeGen) {
                this._bFillPending = false;
                this._fillProductDetails();
                return;
            }

            if (iGen !== this._iScopeGen) { return; }
            if (bBroken) {
                console.warn("[DETAILS-PREFETCH] riempimento incompleto: qualche blocco non e' arrivato");
                return;
            }
            // [COLUMN-SORT] Da qui in poi ordinare o filtrare su una colonna di dettaglio non
            // avvisa piu': i valori ci sono tutti. E' l'unico consumatore di questo marcatore.
            this._iPrefetchedGen = iGen;
            console.log(`>>> [DETAILS-PREFETCH] concluso: ${this._mDetails.size} materiali in cache`);
            this._refreshProductRows();
            this._onCriteriaChange("products", ColumnMenu.getState(this.byId("productsTable")));
        },

        /**
         * Le righe che aspettano ancora i dettagli, raggruppate per codice materiale.
         *
         * [LIST-WHOLE-SET] Sono TUTTE le righe del modello, non le sole visibili: un criterio di
         * ordinamento o di filtro su una colonna di dettaglio deve poter vedere ogni valore.
         */
        _pendingDetailRows() {
            const mByProduct = new Map();
            const aRows = this.getView().getModel("productModel").getProperty("/rows") || [];
            for (const oRow of aRows) {
                if (!oRow || oRow.ProductDescription !== null) { continue; }   // riga completa
                if (!oRow.Product) { continue; }
                if (!mByProduct.has(oRow.Product)) { mByProduct.set(oRow.Product, []); }
                mByProduct.get(oRow.Product).push(oRow);   // lo stesso materiale puo' avere piu' plant
            }
            return mByProduct;
        },

        /**
         * I codici materiale che la tabella sta mostrando, per dare loro la precedenza.
         *
         * IL RIPIEGO NON E' DIFENSIVO, E' IL CASO NORMALE DEL PRIMO GIRO. `_fillProductDetails`
         * parte appena `_loadTab` ha scritto le righe, e a quel punto la tabella non ha ancora
         * disegnato niente: `getItems()` risponde vuoto. Senza ripiego l'intero perimetro
         * finirebbe nei blocchi grandi e le righe sotto gli occhi dell'utente si riempirebbero
         * per ultime — cioe' si perderebbe proprio la precedenza che DEC-75 chiede. Le prime
         * `growingThreshold` righe sono quelle che `growing` mostrera'.
         */
        _onScreenProducts() {
            const oTable = this.byId("productsTable");
            const oSet = new Set();
            const aItems = (oTable && oTable.getItems && oTable.getItems()) || [];
            for (const oItem of aItems) {
                const oCtx = oItem.getBindingContext("productModel");
                const oRow = oCtx && oCtx.getObject();
                if (oRow && oRow.Product) { oSet.add(oRow.Product); }
            }
            if (oSet.size) { return oSet; }

            const iThreshold = (oTable && oTable.getGrowingThreshold && oTable.getGrowingThreshold())
                || DETAILS_BLOCK;
            const aRows = this.getView().getModel("productModel").getProperty("/rows") || [];
            for (const oRow of aRows.slice(0, iThreshold)) {
                if (oRow && oRow.Product) { oSet.add(oRow.Product); }
            }
            return oSet;
        },

        /**
         * Chiede i dettagli di un elenco di materiali, a blocchi, consegnandoli al chiamante blocco
         * per blocco. Prima di ogni blocco controlla la generazione: un cambio di perimetro ferma
         * il ciclo invece di lasciare in volo decine di richieste che non servono piu'.
         *
         * `stopOnError` e' la differenza fra i due chiamanti, ed e' voluta: sulle righe a schermo
         * un blocco perso ferma il giro (l'utente ha davanti una lista che si sta riempiendo, e il
         * perche' va visto subito); nel precaricamento si prosegue, perche' morire su un blocco
         * lascerebbe non precaricato tutto il resto per niente.
         */
        async _requestDetailBlocks(aProducts, iBlockSize, iGen, fnOnRows, { stopOnError, label }) {
            let iFailedBlocks = 0;
            for (let i = 0; i < aProducts.length; i += iBlockSize) {
                if (iGen !== this._iScopeGen) {
                    console.log(`>>> ${label} interrotto: il perimetro e' cambiato`);
                    return { aborted: true, failedBlocks: iFailedBlocks };
                }
                const aBlock = aProducts.slice(i, i + iBlockSize);
                let aRows;
                try {
                    aRows = await this._requestProductDetails(aBlock);
                } catch (oError) {
                    // Un blocco che non arriva lascia quelle celle vuote: la lista che l'utente ha
                    // davanti resta usabile, e il perche' e' in console.
                    iFailedBlocks++;
                    console.error(`${label} blocco dettagli non arrivato:`, oError.message, aBlock);
                    if (stopOnError) { return { aborted: false, failedBlocks: iFailedBlocks }; }
                    continue;
                }
                fnOnRows(aRows);
            }
            return { aborted: false, failedBlocks: iFailedBlocks };
        },

        /**
         * Scrive nelle righe i dettagli gia' in cache e restituisce i materiali che mancano ancora.
         */
        _applyCachedDetails(mByProduct) {
            const aMissing = [];
            for (const sProduct of mByProduct.keys()) {
                const aRows = this._mDetails.get(sProduct);
                if (!aRows) { aMissing.push(sProduct); continue; }
                this._applyDetailRows(mByProduct, aRows);
            }
            return aMissing;
        },

        /** Le righe di risposta finiscono sulla riga del materiale giusto, e del plant giusto. */
        _applyDetailRows(mByProduct, aRows) {
            let bTouched = false;
            for (const oRow of aRows) {
                for (const oTarget of (mByProduct.get(oRow.Product) || [])) {
                    // [POST-GET-CLASSIFY] La risposta porta UNA riga per (materiale, plant), perche'
                    // la tipologia dipende dalle categorie del plant e lo stesso materiale puo'
                    // stare in piu' plant. Senza questo controllo la tipologia di un plant finirebbe
                    // sulle righe di un altro. `Plant` assente = riga senza tipologia: si applica a
                    // tutte, com'era prima.
                    if (oRow.Plant && oTarget.Plant !== oRow.Plant) { continue; }
                    this._patchDetailRow(oTarget, oRow);
                    bTouched = true;
                }
            }
            // [LIST-WHOLE-SET] Si scrive DENTRO gli oggetti dell'array, quindi il JSONModel non se
            // ne accorge da solo: senza questo `refresh` le celle resterebbero vuote fino al
            // prossimo evento che ridisegna la tabella.
            if (bTouched) { this._refreshProductRows(); }
        },

        /**
         * Dice al JSONModel dei materiali che le righe sono cambiate.
         *
         * `refresh(true)` e non `setProperty("/rows", …)`: sostituire l'array farebbe ricreare
         * ogni `ColumnListItem` e la tabella perderebbe la posizione di scorrimento a ogni blocco
         * di dettagli che arriva — cioe' decine di volte durante il riempimento.
         */
        _refreshProductRows() {
            const oModel = this.getView().getModel("productModel");
            if (oModel) { oModel.refresh(true); }
        },

        /**
         * Mette in cache le righe arrivate, RAGGRUPPATE per materiale.
         *
         * Una riga con `ProductDescription` nullo NON e' un dettaglio: e' il modo in cui il server
         * dice «questo materiale non l'ho letto» (lettura fallita, o materiale che in SAP non
         * c'e'). Metterla in cache la renderebbe definitiva — la riga resterebbe vuota fino al
         * refresh — mentre lasciandola fuori viene richiesta di nuovo al giro dopo. Una descrizione
         * VUOTA invece e' un dato vero e si tiene: e' quello che il canale IS restituisce per un
         * materiale privo di descrizione nella lingua chiesta.
         */
        _cacheDetailRows(aRows) {
            const mFresh = new Map();
            for (const oRow of aRows) {
                if (oRow.ProductDescription === null || oRow.ProductDescription === undefined) { continue; }
                if (!mFresh.has(oRow.Product)) { mFresh.set(oRow.Product, []); }
                mFresh.get(oRow.Product).push(oRow);
            }
            for (const [sProduct, aProductRows] of mFresh) { this._mDetails.set(sProduct, aProductRows); }
        },

        /**
         * Azzera cache e precaricamento: da qui in poi si parla di un perimetro diverso.
         * La generazione incrementata ferma anche i cicli gia' in volo, che la controllano prima
         * di ogni blocco.
         */
        _resetDetailCache() {
            this._iScopeGen = (this._iScopeGen || 0) + 1;
            this._mDetails = new Map();
        },

        // [LIST-WHOLE-SET] `_requestProductScope()` NON C'E' PIU', e non e' una dimenticanza.
        // Chiedeva a `productScope()` i codici del perimetro perche' il browser conosceva solo le
        // righe della pagina caricata e il precaricamento doveva sapere cosa c'era oltre. Ora le
        // righe ci sono tutte: il perimetro e' `/rows`, e una chiamata al server e' sparita.
        // L'endpoint `productScope()` resta esposto dal servizio — nessun altro lo usa.

        /** Un blocco di dettagli dal server. POST perche' i codici stanno nel body, non nell'URL. */
        _requestProductDetails(aProducts) {
            return fetch(AppUrl.url("/products/productDetails"), {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ products: aProducts })
            })
                .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
                .then(d => (d && d.value) || []);
        },

        /**
         * Scrive i dettagli dentro una riga del modello.
         *
         * [LIST-WHOLE-SET] Era una `Context#setProperty(…, null)` su un context OData V4, dove il
         * terzo argomento `null` serviva a impedire la PATCH verso un'entity di sola lettura. Con
         * un JSONModel il problema non esiste: si assegna, e nessuna richiesta parte.
         *
         * I campi li decide il server: si scrive quello che arriva, meno la chiave e le
         * annotazioni OData, cosi' aggiungere un campo alla lista non richiede di toccare qui.
         */
        _patchDetailRow(oTarget, oRow) {
            for (const sField of Object.keys(oRow)) {
                // [POST-GET-CLASSIFY] `Plant` serve ad accoppiare la riga di risposta a quella
                // giusta, non e' un dettaglio da riscrivere: e' gia' quello della riga.
                if (sField === "Product" || sField === "Plant" || sField.charAt(0) === "@") { continue; }
                oTarget[sField] = oRow[sField] === undefined ? null : oRow[sField];
            }
        },

        // ================================================================
        // ================================================================
        // [COLUMN-SORT] LA RICERCA IN TOOLBAR NON C'E' PIU'.
        //
        // I tre `SearchField` e i loro handler — `onSearch`, `onSearchProdOrders`,
        // `onSearchRoutings`, piu' `_searchQueryOf` — sono stati rimossi quando il menu di
        // colonna e' entrato in esercizio. Erano un secondo modo di cercare, con semantica
        // OPPOSTA: un OR su un insieme fisso di campi contro un AND per colonna. Due meccanismi
        // cosi' sulla stessa tabella sono una sorpresa che aspetta di succedere.
        //
        // COSA SI E' PERSO, dichiarato: sulla scheda Materiali la ricerca copriva anche
        // `ProductGroup` e `ProductHierarchy`, che NON hanno una colonna — quindi da qui in poi
        // non si cerca piu' per gruppo prodotto ne' per gerarchia. I due campi restano nei dati
        // (sono campi di dettaglio) e nell'entity `Products`: per riaverli bastano due `<Column>`
        // con le loro `CustomData`, e le etichette `productGroup` / `productHierarchy` esistono
        // gia'. Su Cicli e Ordini non si e' perso niente: ogni campo cercabile era gia' una
        // colonna. Vedi DEC-82.
        // ================================================================

        // Aggiorna: rilegge dal server. E' un cambio di PERIMETRO, non di vista.
        onRefresh() {
            // [DETAILS-PREFETCH] Aggiorna vuol dire «rileggi»: la cache di riga e il
            // precaricamento in volo appartengono al giro precedente.
            // Conseguenza dichiarata: il perimetro, le righe plant e lo STATO DI INVIO
            // (ZMatExcLogHDR) tornano da SAP e dal database; l'anagrafica materiale — descrizione,
            // tipo, UM, pesi — puo' arrivare dalla cache di processo del server, che vive 5 minuti
            // (PRODUCT_DETAIL_TTL_MS). E' anagrafica che cambia di rado: se un giorno servisse un
            // refresh duro, la strada e' un parametro su `productDetails`, non un TTL piu' corto.
            this._resetDetailCache();
            // [COLUMN-SORT] I criteri si azzerano insieme alle righe: un filtro sopravvissuto a
            // una rilettura dichiarerebbe una restrizione riferita a righe che non ci sono piu'.
            this._clearCriteria("products");
            // [PLANT-ROWS] `fresh`: il perimetro materiali sta in cache sul server per cinque
            // minuti, quindi senza questa opzione «Aggiorna» rileggerebbe la cache — un tasto
            // che non fa quello che dice.
            this._loadTab("products", { fresh: true });
            MessageToast.show(this._i18n().getText("dataRefreshed"));
        },

        // Production order item press - navigate to detail
        onProdOrderItemPress(oEvent) {
            const oItem = oEvent.getSource();
            const oContext = oItem.getBindingContext("prodOrderModel");

            if (!oContext) {
                console.error(">>> No binding context found!");
                return;
            }

            const oData = oContext.getObject();
            this.getOwnerComponent()._selectedProdOrder = oData;

            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.navTo("prodOrderDetail", {
                ManufacturingOrder: oData.ManufacturingOrder
            });
        },

        // Routing item press - navigate to routing detail
        onRoutingItemPress(oEvent) {
            const oItem = oEvent.getSource();
            const oContext = oItem.getBindingContext("routingModel");

            if (!oContext) {
                console.error(">>> No binding context found!");
                return;
            }

            const oData = oContext.getObject();
            this.getOwnerComponent()._selectedRouting = oData;

            // [ROUTING-BY-MATERIAL] Il materiale fa parte dell'identita' della riga, quindi entra
            // nella route: due righe dello stesso ciclo aprono due dettagli diversi.
            // Un materiale vuoto (ciclo SAP senza assegnazione) diventa il segnaposto "-", perche'
            // un segmento di pattern vuoto non farebbe combaciare la route e il dettaglio non si
            // aprirebbe affatto. Il dettaglio lo ritraduce in stringa vuota.
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.navTo("routingDetail", {
                ProductionRoutingGroup: oData.ProductionRoutingGroup,
                ProductionRouting: oData.ProductionRouting,
                Material: (oData.Material || "").trim() || "-"
            });
        },

        // ----------------------------------------------------------------
        // Routing Templates - Manage Templates dialog
        // ----------------------------------------------------------------

        onManageTemplates() {
            const oView = this.getView();

            if (!this._pManageTemplatesDialog) {
                this._pManageTemplatesDialog = Fragment.load({
                    id: oView.getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.ManageTemplatesDialog",
                    controller: this
                }).then(oDialog => {
                    oView.addDependent(oDialog);
                    oView.setModel(new JSONModel({
                        plantSelected: false,
                        templateSelected: false,
                        selectedPlant: null,
                        selectedTemplateId: null
                    }), "tmplDlg");
                    return oDialog;
                });
            }

            this._pManageTemplatesDialog.then(oDialog => {
                // Reset selection state each time the dialog is opened
                const oState = oView.getModel("tmplDlg");
                oState.setData({
                    plantSelected: false,
                    templateSelected: false,
                    selectedPlant: null,
                    selectedTemplateId: null
                });
                const oPlantSelect = this.byId("templatePlantSelect");
                if (oPlantSelect) oPlantSelect.setSelectedKey(null);
                const oTemplateBox = this.byId("templateSelectBox");
                if (oTemplateBox) {
                    oTemplateBox.setSelectedKey(null);
                    // Clear any stale filter from a previous session and drop cached data so
                    // templates created/edited in the meantime show up on the next selection.
                    const oBinding = oTemplateBox.getBinding("items");
                    if (oBinding) oBinding.filter([]);
                }
                // Refresh the OData model so a freshly saved template is fetched from the server
                oView.getModel("templateModel").refresh();
                oDialog.open();
            });
        },

        // Plant chosen: enable + (re)filter the template dropdown for that plant
        onTemplatePlantChange(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            const sPlant = oItem ? oItem.getKey() : null;
            const oState = this.getView().getModel("tmplDlg");

            oState.setProperty("/selectedPlant", sPlant);
            oState.setProperty("/plantSelected", !!sPlant);
            oState.setProperty("/templateSelected", false);
            oState.setProperty("/selectedTemplateId", null);

            const oTemplateBox = this.byId("templateSelectBox");
            oTemplateBox.setSelectedKey(null);
            const oBinding = oTemplateBox.getBinding("items");
            if (oBinding) {
                oBinding.filter(sPlant ? new Filter("Plant", FilterOperator.EQ, sPlant) : []);
                // Force a re-request even when the same plant is re-selected (V4 skips the
                // fetch if the filter is unchanged, which would show stale/empty data).
                oBinding.refresh();
            }
        },

        onTemplateSelectChange(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            const oState = this.getView().getModel("tmplDlg");
            if (oItem) {
                oState.setProperty("/selectedTemplateId", oItem.getKey());
                oState.setProperty("/templateSelected", true);
            } else {
                oState.setProperty("/selectedTemplateId", null);
                oState.setProperty("/templateSelected", false);
            }
        },

        // Open the editor in create mode for the selected plant
        onTemplateDialogNew() {
            const oState = this.getView().getModel("tmplDlg");
            const sPlant = oState.getProperty("/selectedPlant");
            if (!sPlant) return;
            this.byId("manageTemplatesDialog").close();
            this.getOwnerComponent().getRouter().navTo("routingTemplateDetail", {
                Plant: sPlant,
                TemplateID: "new"
            });
        },

        // Open the editor in edit mode for the selected template
        onTemplateDialogOpen() {
            const oState = this.getView().getModel("tmplDlg");
            const sPlant = oState.getProperty("/selectedPlant");
            const sTemplateId = oState.getProperty("/selectedTemplateId");
            if (!sPlant || !sTemplateId) return;
            this.byId("manageTemplatesDialog").close();
            this.getOwnerComponent().getRouter().navTo("routingTemplateDetail", {
                Plant: sPlant,
                TemplateID: sTemplateId
            });
        },

        onTemplateDialogCancel() {
            this.byId("manageTemplatesDialog").close();
        },

        // ================================================================
        // [MASS-IMPORT] IMPORT MASSIVO DI UN TEMPLATE SU N BERSAGLI
        //
        // Il bersaglio e' la terna (gruppo, contatore, materiale) e non il materiale: un ciclo Plex
        // salvato e' identificato cosi', e lo stesso materiale puo' stare su piu' cicli SAP
        // alternativi (DEC-66). Si scelgono quindi righe della LISTA CICLI, che sono gia' la terna.
        //
        // Il gesto ha due dialog: questo, dove si sceglie il template e si compone l'elenco dei
        // bersagli, e quello dei candidati che «Aggiungi» apre. Lo stato di entrambi vive nel
        // modello `massImport`, creato pigramente e AZZERATO sia in apertura sia su Annulla —
        // Annulla non e' l'unico modo di chiudere un dialog.
        // ================================================================

        /** [MASS-IMPORT] Lo stato dei due dialog, creato alla prima apertura. */
        _massImportState() {
            let oModel = this.getView().getModel("massImport");
            if (!oModel) {
                oModel = new JSONModel();
                // Il tetto di `JSONModel` e' 100 contesti: oltre, le righe spariscono senza errore
                // ne' contatore. Seconda difesa accanto al `growing` dei due fragment.
                oModel.setSizeLimit(5000);
                this.getView().setModel(oModel, "massImport");
            }
            return oModel;
        },

        /** [MASS-IMPORT] Lo stato pulito: una funzione sola, chiamata in apertura e su Annulla. */
        _massImportReset() {
            this._massImportState().setData({
                templateId: null,
                templatePlant: "",
                templateSelected: false,
                canApply: false,
                targets: [],
                candidates: [],
                candidatesBusy: false
            });
            // Le righe dei cicli lette per plant: si tengono finche' il dialog vive, cosi'
            // riaprire «Aggiungi» non rilegge. La cache muore col reset, non con la chiusura di
            // «Aggiungi»: e' del gesto, non del dialog.
            this._mMassImportRows = {};
        },

        onMassImportTemplate() {
            const oView = this.getView();

            if (!this._pMassImportDialog) {
                this._pMassImportDialog = Fragment.load({
                    id: oView.getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.MassImportTemplateDialog",
                    controller: this
                }).then((oDialog) => {
                    oView.addDependent(oDialog);
                    return oDialog;
                });
            }

            this._pMassImportDialog.then((oDialog) => {
                this._massImportReset();

                // [MASS-IMPORT] La tendina mostra i template dei SOLI plant su cui l'utente puo'
                // configurare. Il filtro sta qui e non nel fragment perche' l'elenco si sa solo
                // dopo `usablePlants()`; e se quell'elenco e' vuoto si filtra su un plant
                // impossibile invece di lasciare la tendina aperta a tutto — il pulsante non
                // dovrebbe nemmeno vedersi, ma un `visible` non e' una difesa.
                const aPlants = this.getView().getModel("plantScope")
                    .getProperty("/configurablePlants") || [];
                const oBox = this.byId("massImportTemplateBox");
                if (oBox) {
                    oBox.setSelectedKey(null);
                    const oBinding = oBox.getBinding("items");
                    if (oBinding) {
                        oBinding.filter(aPlants.length
                            ? new Filter({
                                filters: aPlants.map((p) => new Filter("Plant", FilterOperator.EQ, p)),
                                and: false
                            })
                            : new Filter("Plant", FilterOperator.EQ, "#NONE"));
                        // QUI NON SI FA UN REFRESH: lo fa il model, due righe piu' sotto.
                        // V4 salta la richiesta se il filtro non e' cambiato, ed e' per quello che
                        // un refresh serve — ma il refresh del MODEL scarta la cache di tutti i
                        // suoi binding, questo compreso, quindi ne bastava uno. Con due, il secondo
                        // arriva mentre il primo ha appena installato una cache ancora pendente
                        // (`filter()` la apre, `refreshInternal` la rimpiazza) e `fetchCache` lancia
                        // `Unsupported bKeepQueryOptions while oCachePromise is pending`. Lancia
                        // dentro una callback asincrona del model, quindi finisce in console e il
                        // dialog si apre lo stesso: e' rumore che copre gli errori veri.
                    }
                }
                oView.getModel("templateModel").refresh();
                oDialog.open();
            });
        },

        onMassImportTemplateChange(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            const oState = this._massImportState();
            const sPrevPlant = oState.getProperty("/templatePlant") || "";
            const oCtx = oItem && oItem.getBindingContext("templateModel");
            const sPlant = (oCtx && oCtx.getProperty("Plant")) || "";

            // [MASS-IMPORT] CAMBIANDO PLANT I BERSAGLI SI SVUOTANO, ed e' l'unica scelta corretta:
            // un ciclo di un altro plant non e' importabile da questo template, e tenerlo vorrebbe
            // dire mandare al server bersagli che rifiutera' uno per uno. Il gesto si DICHIARA: far
            // sparire righe in silenzio e' peggio che non farle sparire.
            if (TemplateImport.targetsMustReset(sPrevPlant, sPlant)) {
                const iLost = (oState.getProperty("/targets") || []).length;
                oState.setProperty("/targets", []);
                this._mMassImportRows = {};
                if (iLost > 0) {
                    MessageToast.show(this._i18n().getText("massImportPlantChanged", [iLost, sPlant]));
                }
            }

            oState.setProperty("/templateId", oItem ? oItem.getKey() : null);
            oState.setProperty("/templatePlant", sPlant);
            oState.setProperty("/templateSelected", !!oItem);
            this._massImportRefreshApply();
        },

        /** [MASS-IMPORT] «OK» si accende solo con un template E almeno un bersaglio. */
        _massImportRefreshApply() {
            const oState = this._massImportState();
            oState.setProperty("/canApply",
                !!oState.getProperty("/templateSelected")
                && (oState.getProperty("/targets") || []).length > 0);
        },

        onMassImportAddTargets() {
            const oView = this.getView();
            if (!this._pMassImportTargetsDialog) {
                this._pMassImportTargetsDialog = Fragment.load({
                    id: oView.getId(),
                    name: "avvaleplm.marsplm.sap2plex.main.view.fragments.MassImportTargetsDialog",
                    controller: this
                }).then((oDialog) => {
                    oView.addDependent(oDialog);
                    return oDialog;
                });
            }
            this._pMassImportTargetsDialog.then((oDialog) => {
                const oSearch = this.byId("massImportTargetSearch");
                if (oSearch) { oSearch.setValue(""); }
                this._massImportLoadCandidates();
                oDialog.open();
            });
        },

        /**
         * [MASS-IMPORT] I cicli del plant del template, dallo stesso endpoint della dashboard.
         *
         * NON SI RICICLANO le righe gia' in memoria: `_loadTab` legge i soli plant scelti nel
         * selettore in testata, quindi se il template e' di un altro plant la lista uscirebbe
         * corta o vuota — e una lista corta qui si legge come «questo plant non ha cicli», che e'
         * il difetto opposto a quello che un import massivo deve evitare.
         *
         * Si legge UNA volta per plant e si tiene finche' il gesto vive.
         */
        _massImportLoadCandidates() {
            const oState = this._massImportState();
            const sPlant = oState.getProperty("/templatePlant") || "";
            if (!sPlant) { return; }

            const apply = (aRows) => {
                oState.setProperty("/candidates", TemplateImport.selectableTargets(
                    aRows, oState.getProperty("/targets") || []
                ).map((r) => ({ ...r, selected: false })));
                oState.setProperty("/candidatesBusy", false);
            };

            this._mMassImportRows = this._mMassImportRows || {};
            if (this._mMassImportRows[sPlant]) {
                apply(this._mMassImportRows[sPlant]);
                return;
            }

            oState.setProperty("/candidatesBusy", true);
            const oBinding = this._oRoutingSrv.bindList("/Routings", null, null, null,
                { $count: false, plants: sPlant });
            oBinding.requestContexts(0, LIST_MAX_ROWS).then((aContexts) => {
                const aRows = aContexts.map((oCtx) => oCtx.getObject());
                this._mMassImportRows[sPlant] = aRows;
                apply(aRows);
            }).catch((err) => {
                console.error(">>> [MASS-IMPORT] lettura dei cicli fallita:", err);
                oState.setProperty("/candidatesBusy", false);
                // Elenco vuoto E una parola: senza, «nessun candidato» si leggerebbe come «questo
                // plant non ha cicli», che e' un'altra cosa.
                oState.setProperty("/candidates", []);
                MessageToast.show(this._i18n().getText("massImportCandidatesError", [err.message || ""]));
            }).finally(() => {
                oBinding.destroy();
            });
        },

        onMassImportTargetSearch(oEvent) {
            const sQuery = (oEvent.getParameter("newValue") || "").trim().toLowerCase();
            const oState = this._massImportState();
            const sPlant = oState.getProperty("/templatePlant") || "";
            const aAll = TemplateImport.selectableTargets(
                (this._mMassImportRows || {})[sPlant] || [], oState.getProperty("/targets") || []
            );
            // La spunta gia' messa si conserva attraverso il filtro: si rilegge dallo stato
            // corrente invece di ricostruire le righe a `false`.
            const oSelected = {};
            (oState.getProperty("/candidates") || []).forEach((c) => {
                if (c.selected) { oSelected[TemplateImport.targetKey(c)] = true; }
            });
            const aRows = aAll
                .filter((r) => !sQuery
                    || `${r.ProductionRoutingGroup}/${r.ProductionRouting}`.toLowerCase().includes(sQuery)
                    || (r.BillOfOperationsDesc || "").toLowerCase().includes(sQuery)
                    || (r.Material || "").toLowerCase().includes(sQuery))
                .map((r) => ({ ...r, selected: !!oSelected[TemplateImport.targetKey(r)] }));
            oState.setProperty("/candidates", aRows);
        },

        onMassImportTargetsConfirm() {
            const oState = this._massImportState();
            // Si legge dallo stato e non da `getSelectedItems()`: quello rende le sole righe
            // RENDERIZZATE, quindi una spunta messa prima di digitare nella ricerca sparirebbe.
            const aChosen = (oState.getProperty("/candidates") || []).filter((c) => c.selected);
            const aTargets = (oState.getProperty("/targets") || []).concat(
                aChosen.map((c) => ({
                    ProductionRoutingGroup: c.ProductionRoutingGroup,
                    ProductionRouting: c.ProductionRouting,
                    Material: c.Material,
                    BillOfOperationsDesc: c.BillOfOperationsDesc || "",
                    selected: false
                }))
            );
            oState.setProperty("/targets", aTargets);
            this._massImportRefreshApply();
            this.byId("massImportTargetsDialog").close();
        },

        onMassImportTargetsCancel() {
            this.byId("massImportTargetsDialog").close();
        },

        onMassImportRemoveTargets() {
            const oState = this._massImportState();
            const aTargets = oState.getProperty("/targets") || [];
            const aKept = aTargets.filter((t) => !t.selected);
            if (aKept.length === aTargets.length) {
                MessageToast.show(this._i18n().getText("massImportNothingToRemove"));
                return;
            }
            oState.setProperty("/targets", aKept);
            this._massImportRefreshApply();
        },

        onMassImportCancel() {
            this._massImportReset();
            this.byId("massImportDialog").close();
        },

        /**
         * [MASS-IMPORT] OK: si legge il template, si dichiara cosa sta per succedere, si applica.
         *
         * Il messaggio della conferma cambia a seconda che il template abbia o no almeno un gruppo
         * oggetti, con la stessa regola dell'import singolo: con i gruppi il salvataggio
         * SOSTITUISCE le regole di auto-assegnazione dei materiali coinvolti, senza non le tocca.
         * E' l'unica occasione in cui l'utente puo' saperlo prima che la scrittura avvenga.
         */
        onMassImportConfirm() {
            const oState = this._massImportState();
            const sTemplateId = oState.getProperty("/templateId");
            const aTargets = oState.getProperty("/targets") || [];
            if (!sTemplateId || !aTargets.length) { return; }

            const oBundle = this._i18n();
            const sId = encodeURIComponent(sTemplateId);
            // [APP-URL] `AppUrl.url(` e il literal sulla STESSA riga: la guardia di
            // test/appUrlSurface.test.js legge per riga, e un indirizzo andato a capo dopo
            // l'involucro le sembra nudo — che e' esattamente il difetto che sorveglia.
            // [TEMPLATE-AUTOASSIGN] Il `$filter` sul TemplateID e' anche il gate: le tre figlie non
            // hanno la colonna Plant, e il server rifiuta una loro lettura senza criteri.
            const sOpsUrl = AppUrl.url(`/routing-templates/RoutingTemplateOperations?$filter=TemplateID eq ${sId}&$orderby=Sequence asc`);
            const sWcUrl = AppUrl.url(`/routing-templates/RoutingTemplateWorkcenters?$filter=TemplateID eq ${sId}`);
            const sOgUrl = AppUrl.url(`/routing-templates/RoutingTemplateGroups?$filter=TemplateID eq ${sId}`);
            const readJson = (sUrl) => fetch(sUrl, { headers: { "Accept": "application/json" } })
                .then((r) => r.json());

            Promise.all([readJson(sOpsUrl), readJson(sWcUrl), readJson(sOgUrl)]).then(([opsData, wcData, ogData]) => {
                // La MAPPATURA E' QUELLA DELL'IMPORT SINGOLO, dallo stesso modulo: due copie
                // costruirebbero due alberi diversi dagli stessi dati.
                const aOperations = TemplateImport.operationsFromTemplate(
                    opsData.value,
                    TemplateImport.byOperation(wcData.value, (wc) => ({
                        WorkcenterId: wc.WorkcenterId,
                        WorkcenterCode: wc.WorkcenterCode || "",
                        WorkcenterName: wc.WorkcenterName || ""
                    })),
                    TemplateImport.byOperation(ogData.value, (row) => row.GroupId || null)
                );
                if (!aOperations.length) {
                    MessageBox.warning(oBundle.getText("massImportTemplateEmpty"));
                    return;
                }

                const bGroups = TemplateImport.hasAnyGroup(aOperations);
                MessageBox.confirm(
                    oBundle.getText(bGroups ? "massImportConfirmWithGroups" : "massImportConfirmNoGroups",
                        [aTargets.length, aOperations.length]),
                    {
                        title: oBundle.getText("massImportConfirmTitle"),
                        onClose: (sAction) => {
                            if (sAction === MessageBox.Action.OK) {
                                this._massImportApply(aOperations, aTargets);
                            }
                        }
                    }
                );
            }).catch((err) => {
                console.error(">>> [MASS-IMPORT] lettura del template fallita:", err);
                MessageBox.error(oBundle.getText("massImportTemplateReadError", [err.message || ""]));
            });
        },

        /**
         * [MASS-IMPORT] Il giro a blocchi.
         *
         * A BLOCCHI E NON IN UNA RICHIESTA SOLA: duecento bersagli supererebbero il `timeout`
         * dell'approuter, e un taglio per tempo su una scrittura non e' un rifiuto (DEC-131). E'
         * lo schema dell'invio massivo materiali, coi suoi quattro esiti — riusciti, falliti,
         * ignoti e restanti — e la stessa regola: su un esito IGNOTO il giro si FERMA, perche' i
         * bersagli di quel blocco possono essere stati scritti.
         */
        _massImportApply(aOperations, aTargets) {
            const oBundle = this._i18n();
            const sPlant = this._massImportState().getProperty("/templatePlant");
            const CHUNK = 25;
            const aFailed = [];
            let iSuccess = 0;
            let iErrors = 0;
            let iUnknown = 0;
            let iDone = 0;

            const oBusy = new BusyDialog({ title: oBundle.getText("massImportConfirmTitle") });
            const update = () => oBusy.setText(
                oBundle.getText("massImportProgress", [iDone, aTargets.length, iSuccess, iErrors]));
            update();
            oBusy.open();

            const finish = () => {
                oBusy.close();
                this.byId("massImportDialog").close();
                this._massImportReset();
                // La lista si rilegge: i cicli toccati hanno un albero nuovo, e le colonne di stato
                // sono l'unico posto in cui si vede.
                this._clearCriteria("routings");
                this._loadTab("routings");
                // Il riepilogo NOMINA i falliti: «3 falliti» senza i nomi manda a cercarli a mano.
                const sHead = oBundle.getText("massImportDone", [iSuccess, iErrors])
                    + (iUnknown > 0 ? " " + oBundle.getText("massImportUnknown", [iUnknown]) : "");
                if (aFailed.length) {
                    MessageBox.warning(sHead + "\n\n" + aFailed.slice(0, 20).join("\n")
                        + (aFailed.length > 20 ? "\n…" : ""));
                } else {
                    MessageToast.show(sHead);
                }
            };

            const sendChunk = (index) => {
                if (index >= aTargets.length) { finish(); return; }
                const aChunk = aTargets.slice(index, index + CHUNK);
                const iStartedAt = Date.now();

                fetch(AppUrl.url("/production-routings/massImportTemplateChunk"), {
                    method: "POST",
                    headers: { "Accept": "application/json", "Content-Type": "application/json" },
                    body: JSON.stringify({
                        Plant: sPlant,
                        Operations: TemplateImport.operationsPayload(aOperations),
                        Targets: aChunk.map((t) => ({
                            ProductionRoutingGroup: t.ProductionRoutingGroup,
                            ProductionRouting: t.ProductionRouting,
                            Material: t.Material
                        }))
                    })
                })
                    // Il predicato di forma e' `results`: un corpo d'altra forma letto coi `|| 0`
                    // direbbe «zero riusciti», in silenzio.
                    .then((r) => ActionResult.read(r, (b) => Array.isArray(b && b.results)))
                    .catch((err) => ActionResult.fromNetworkError(err))
                    .then((outcome) => {
                        if (!ActionResult.isOk(outcome)) {
                            console.error(">>> [MASS-IMPORT] blocco non riuscito:",
                                outcome.kind, "HTTP", outcome.status, outcome.message || "");
                            if (ActionFailure.isInconclusive(outcome) || outcome.kind === "AUTH") {
                                // IL GIRO SI FERMA. I bersagli in volo non sono errori: il loro
                                // esito e' IGNOTO — il server puo' averli scritti.
                                iUnknown += aChunk.length;
                                iDone += aChunk.length;
                                oBusy.close();
                                this.byId("massImportDialog").close();
                                this._massImportReset();
                                this._clearCriteria("routings");
                                this._loadTab("routings");
                                if (outcome.kind !== "AUTH") {
                                    MessageBox.warning(oBundle.getText("massImportInterrupted", [
                                        Math.max(1, Math.round((Date.now() - iStartedAt) / 1000)),
                                        iUnknown,
                                        Math.max(0, aTargets.length - iDone),
                                        iSuccess
                                    ]));
                                }
                                return;
                            }
                            // Rifiuto dichiarato: il blocco e' perduto e il giro prosegue.
                            iErrors += aChunk.length;
                            iDone += aChunk.length;
                            aChunk.forEach((t) => aFailed.push(
                                `${t.ProductionRoutingGroup}/${t.ProductionRouting} · ${t.Material}: `
                                + (outcome.message || "")));
                            update();
                            sendChunk(index + CHUNK);
                            return;
                        }
                        (outcome.body.results || []).forEach((r) => {
                            if (r.ok) { iSuccess++; return; }
                            iErrors++;
                            aFailed.push(`${r.ProductionRoutingGroup}/${r.ProductionRouting} · `
                                + `${r.Material}: ${r.message || ""}`);
                        });
                        iDone += aChunk.length;
                        update();
                        sendChunk(index + CHUNK);
                    });
            };

            sendChunk(0);
        },

        // Refresh handler for Routings table
        onRefreshRoutings() {
            this._clearCriteria("routings");
            this._loadTab("routings");
            MessageToast.show(this._i18n().getText("dataRefreshed"));
        },

        // Refresh handler for Production Orders table
        onRefreshProdOrders() {
            this._clearCriteria("prodOrders");
            this._loadTab("prodOrders");
            // [ORDER-STATUS-FILTER] Il perimetro puo' essere cambiato nell'app di configurazione
            // mentre il cockpit era aperto: un refresh che aggiorna le righe ma non il motivo
            // della lista vuota mostrerebbe una spiegazione scaduta.
            this._refreshProdOrderScope();
            MessageToast.show(this._i18n().getText("dataRefreshed"));
        },

        // ================================================================
        // [ORDER-STATUS-FILTER] Perche' la lista degli ordini e' vuota (feature 0017).
        //
        // Il perimetro per stato e' customizing per plant ed e' FAIL-CLOSED: un plant senza
        // configurazione non produce ordini. Senza questo testo la tabella direbbe soltanto
        // «nessun dato», e l'utente cercherebbe la causa in SAP invece che nel customizing.
        //
        // Best-effort: se la chiamata non riesce si resta sul testo generico. Non e' un errore
        // da mostrare — e' una spiegazione che non siamo riusciti a dare.
        // ================================================================
        _refreshProdOrderScope() {
            const oBundle = this._i18n();
            const oModel = this.getView().getModel("prodOrderScope");
            if (!oModel) {
                return;
            }
            // Stesso perimetro utente della lista: senza il selettore, la spiegazione parlerebbe
            // di plant che l'utente non sta guardando.
            const oSelector = this.byId("plantFilter");
            const aKeys = (oSelector && oSelector.getSelectedKeys()) || [];
            const sUrl = AppUrl.url("/production-orders/prodOrderScope()") +
                (aKeys.length ? "?plants=" + encodeURIComponent(aKeys.join(",")) : "");

            fetch(sUrl, { headers: { "Accept": "application/json" } }).then((res) => {
                if (!res.ok) { throw new Error("HTTP " + res.status); }
                return res.json();
            }).then((oData) => {
                const aUnconfigured = (oData && oData.unconfigured) || [];
                const aConfigured = (oData && oData.configured) || [];
                let sText;
                if (!aConfigured.length && !aUnconfigured.length) {
                    // [PLANT-ACCESS] PERIMETRO VUOTO, e va prima degli altri rami (feature 0048).
                    //
                    // Entrambi gli insiemi vuoti significa che non c'e' nessun plant da leggere: da
                    // quando il perimetro e' per utente, la causa normale e' «non hai un ruolo su
                    // nessun plant», non «nessun plant e' configurato». Prima questo caso cadeva
                    // nell'`else` e scriveva «Nessun ordine di produzione trovato» — cioe' mandava
                    // a cercare in SAP una causa che sta nelle abilitazioni. Il server la frase
                    // giusta la ha sempre avuta, in `rules`, ma quel campo e' dichiarato non-UI e
                    // nessuno lo legge.
                    sText = oBundle.getText("psOrdersNoScope");
                } else if (!aConfigured.length && aUnconfigured.length) {
                    // Nessun plant in perimetro: e' il caso del primo rilascio, e va detto per
                    // intero, con i plant e con dove si rimedia.
                    sText = oBundle.getText("osfNoPlantConfigured", [aUnconfigured.join(", ")]);
                } else if (aUnconfigured.length) {
                    // Perimetro PARZIALE. Questo testo compare solo a lista vuota (e' cio' che
                    // `noDataText` significa), quindi la causa puo' essere un'altra — ma i plant
                    // fuori perimetro vanno nominati lo stesso: sono la prima cosa da guardare.
                    sText = oBundle.getText("osfSomePlantsUnconfigured", [aUnconfigured.join(", ")]);
                } else {
                    sText = oBundle.getText("osfNoOrders");
                }
                oModel.setProperty("/noDataText", sText);
            }).catch((oError) => {
                console.warn(">>> [0017] perimetro ordini non determinato: resta il testo generico.", oError);
            });
        },

        // ================================================================
        // Selettore plant (facoltativo, multi-scelta): restringe tutte e tre le schede ai plant
        // attivi scelti. Nessuna scelta = tutti quelli attivi. Viaggia verso il server come
        // opzione di query `plants`, perche' cambia il PERIMETRO che il server legge — non e' un
        // filtro di vista, e per questo obbliga a rileggere.
        // ================================================================
        onPlantFilterChange() {
            // [DETAILS-PREFETCH] Il perimetro materiali cambia: la cache di riga e il
            // riempimento in volo sono di quello di prima, e la tipologia Plex dipende dal
            // plant. La generazione incrementata ferma il ciclo in sottofondo al primo blocco —
            // e fa scartare le letture gia' partite, che appartengono al perimetro vecchio.
            this._resetDetailCache();
            // [COLUMN-SORT] I criteri di colonna sono riferiti alle righe di prima: si azzerano
            // insieme a loro, o l'utente si troverebbe un filtro dichiarato su un altro insieme.
            Object.keys(TABS).forEach((sTab) => { this._clearCriteria(sTab); });
            Object.keys(TABS).forEach((sTab) => { this._loadTab(sTab); });
            // [ORDER-STATUS-FILTER] La spiegazione della lista vuota dipende dai plant scelti:
            // va ricalcolata insieme al filtro, o parlerebbe della selezione precedente.
            this._refreshProdOrderScope();
        },

        // [PLEX-CONN] `onTestPlexAPI` e' stato RIMOSSO con la feature 0020. Il suo pulsante era
        // gia' `visible="false"` e stava sulla scheda Prodotti, che e' CROSS-PLANT: da li' non
        // esiste un plant selezionato, e con una connessione per plant non c'e' piu' una
        // connessione «di default» da provare. Il test vive ora nel blocco «Connessione Plex»
        // della configurazione plant, dove il plant e' quello della schermata.

        // Send ALL configured products to Plex — covers the full configured set (all materials
        // for the selected plants + filters), not just the rows loaded in the table.
        // The list is fetched once from the server, then sent server-side in chunks so the
        // dialog can show live progress.
        //
        // ================================================================
        // [MAT-PLANT-PAIR] DUE CAMBI, feature 0039.
        //
        // 1. Si passa `?plants=` come fanno gia' la READ della lista e `productScope`: l'invio
        //    copre i plant SELEZIONATI, non tutti quelli attivi. Con un tenant Plex per plant,
        //    ignorare il selettore significa scrivere su MES che l'utente non ha davanti.
        // 2. Si CHIEDE CONFERMA nominando i numeri. Il caso che sorprende e' il selettore VUOTO,
        //    che vale «tutti i plant attivi»: e' il momento in cui l'utente crede di mandare
        //    quello che vede e sta per mandare l'intero perimetro. La conferma sta DOPO la
        //    lettura dell'elenco, perche' i numeri veri li sa solo il server.
        // ================================================================
        onSendAllToPlex() {
            const oResourceBundle = this._i18n();

            const CHUNK = 50;
            let successCount = 0;
            let errorCount = 0;
            let skippedCount = 0;
            // [ACTION-RESULT] Il terzo contatore, separato dagli errori di proposito: un blocco
            // tagliato dal gateway non e' un blocco rifiutato. Fonderli direbbe «50 errori» su
            // materiali che su Plex possono essere arrivati, e manderebbe a rilanciare tutto.
            let unknownCount = 0;
            let completedCount = 0;
            let oBusyDialog = null;

            const updateDialog = (total) => {
                if (!oBusyDialog) { return; }
                const percentage = total ? Math.round((completedCount / total) * 100) : 0;
                oBusyDialog.setText(
                    oResourceBundle.getText("sendAllToPlexProcessing", [completedCount, total, percentage]) + "\n" +
                    oResourceBundle.getText("sendAllToPlexSuccessErrors", [successCount, errorCount])
                );
            };

            // Send one chunk server-side, then recurse to the next
            const sendChunk = (items, index, total) => {
                if (index >= items.length) {
                    if (oBusyDialog) { oBusyDialog.close(); }
                    // Lo stato d'invio e' cambiato per ogni materiale toccato: si rilegge la
                    // scheda, che e' l'unico modo di riportare le colonne di log allineate.
                    // [DETAILS-PREFETCH] La cache dei dettagli NON si azzera: l'anagrafica non e'
                    // cambiata, e' cambiato il log — rileggerla sarebbe 2N chiamate per niente.
                    this._clearCriteria("products");
                    this._loadTab("products");
                    MessageToast.show(
                        oResourceBundle.getText("sendAllToPlexCompleted", [successCount, errorCount])
                        + (skippedCount > 0
                            ? " " + oResourceBundle.getText("sendAllToPlexSkipped", [skippedCount])
                            : "")
                    );
                    return;
                }
                const chunk = items.slice(index, index + CHUNK);
                const iStartedAt = Date.now();
                fetch(AppUrl.url("/plex/sendProductsChunkToPlex"), {
                    method: "POST",
                    headers: { "Accept": "application/json", "Content-Type": "application/json" },
                    body: JSON.stringify({ products: chunk })
                })
                    // [ACTION-RESULT] Si guarda `r.ok` PRIMA di leggere i contatori. Il predicato
                    // di forma e' `success`, che qui e' un NUMERO — se arrivasse un corpo d'altra
                    // forma i tre `|| 0` lo leggerebbero come «zero riusciti», in silenzio.
                    .then(r => ActionResult.read(r, b => b && typeof b.success === "number"))
                    .catch(err => ActionResult.fromNetworkError(err))
                    .then(outcome => {
                        if (!ActionResult.isOk(outcome)) {
                            console.error(">>> [ACTION-RESULT] invio massivo, blocco non riuscito:",
                                outcome.kind, "HTTP", outcome.status, outcome.message || "");

                            if (ActionFailure.isInconclusive(outcome) || outcome.kind === "AUTH") {
                                // IL GIRO SI FERMA, e i materiali del blocco in volo NON sono
                                // errori: il loro esito e' IGNOTO — su Plex possono essere
                                // arrivati. Contarli fra gli errori, come si faceva, e' «non lo
                                // so» trasformato in «non c'e'», e su un invio ri-eseguibile
                                // porta a rilanciare tutto senza sapere cosa manca davvero.
                                // Si ferma anche perche' continuare a sparare blocchi da 50
                                // contro un backend che non risponde in tempo peggiora la cosa.
                                unknownCount += chunk.length;
                                completedCount += chunk.length;
                                if (oBusyDialog) { oBusyDialog.close(); }
                                // La lista si rilegge comunque: e' l'unico modo di vedere quali
                                // materiali hanno davvero cambiato stato.
                                this._clearCriteria("products");
                                this._loadTab("products");
                                // La sessione scaduta la annuncia SessionGuard, col dialogo che sa
                                // anche cosa fare: qui si tace di proposito.
                                if (outcome.kind !== "AUTH") {
                                    MessageBox.warning(oResourceBundle.getText("sendAllToPlexInterrupted", [
                                        Math.max(1, Math.round((Date.now() - iStartedAt) / 1000)),
                                        unknownCount,
                                        Math.max(0, total - completedCount),
                                        successCount
                                    ]));
                                }
                                return;
                            }

                            // Rifiuto applicativo o forma inattesa: il server ha risposto, il
                            // blocco e' perduto e il giro prosegue — e' il comportamento di
                            // sempre, ed e' quello giusto per un no dichiarato.
                            errorCount += chunk.length;
                            completedCount += chunk.length;
                            updateDialog(total);
                            sendChunk(items, index + CHUNK, total);
                            return;
                        }
                        const result = outcome.body;
                        successCount += result.success || 0;
                        errorCount += result.errors || 0;
                        // [MAT-PLANT-PAIR] Le coppie fuori perimetro che il server ha scartato: si
                        // contano e si dicono a fine giro, invece di sparire nel conteggio dei completati.
                        skippedCount += result.skipped || 0;
                        completedCount += chunk.length;
                        updateDialog(total);
                        sendChunk(items, index + CHUNK, total);
                    })
                    .catch(error => {
                        // Ci arriva solo un'eccezione DENTRO il ramo riuscito: le specie di esito
                        // sono gia' state trattate qui sopra e non lanciano.
                        console.error(">>> sendProductsChunkToPlex error:", error);
                        errorCount += chunk.length;
                        completedCount += chunk.length;
                        updateDialog(total);
                        sendChunk(items, index + CHUNK, total);
                    });
            };

            // Step 1: fetch the FULL configured list via a backend action — one row per
            // (Product, Plant), limited to the selected plants. Not the paginated /products READ,
            // whose page size is clamped (maxTop) — that would cap the list.
            // [MAT-PLANT-PAIR] `?plants=` e' lo stesso canale di `_loadTab` e `productScope`: il
            // server interseca comunque con i plant attivi e licenziati, quindi puo' solo restringere.
            const aPlants = this._selectedPlants();
            const sUrl = AppUrl.url("/plex/getConfiguredProducts")
                + (aPlants.length ? "?plants=" + encodeURIComponent(aPlants.join(",")) : "");
            fetch(sUrl, {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: "{}"
            })
                .then(r => r.json())
                .then(data => {
                    const items = (data && data.value) ? data.value : (Array.isArray(data) ? data : []);
                    if (items.length === 0) {
                        MessageToast.show(oResourceBundle.getText("sendAllToPlexNoProducts"));
                        return;
                    }
                    // [MAT-PLANT-PAIR] I numeri veri, dall'elenco appena letto: quante coppie, quanti
                    // materiali, su quali plant. Il testo dice anche che l'invio copre l'INTERO
                    // perimetro e non le righe a schermo — la tabella e' tagliata, l'action no.
                    const iMaterials = new Set(items.map(i => i.Product)).size;
                    const aPlantList = [...new Set(items.map(i => i.Plant))].sort();
                    MessageBox.confirm(
                        oResourceBundle.getText("sendAllToPlexConfirmText",
                            [items.length, iMaterials, aPlantList.length, aPlantList.join(", ")]),
                        {
                            title: oResourceBundle.getText("sendAllToPlexConfirmTitle"),
                            onClose: (sAction) => {
                                if (sAction !== MessageBox.Action.OK) { return; }
                                oBusyDialog = new BusyDialog({
                                    title: oResourceBundle.getText("sendAllToPlexTitle"),
                                    text: oResourceBundle.getText("sendAllToPlexPreparing") + "\n" +
                                        oResourceBundle.getText("sendAllToPlexSuccessErrors", [0, 0]),
                                    showCancelButton: false
                                });
                                oBusyDialog.open();
                                updateDialog(items.length);
                                sendChunk(items, 0, items.length);
                            }
                        }
                    );
                })
                .catch(error => {
                    console.error(">>> sendAllToPlex: failed to load product list:", error);
                    MessageToast.show(oResourceBundle.getText("sendAllToPlexNoProducts"));
                });
        },

        // Formatters for status display
        // [ROUTING-BY-MATERIAL] Il materiale della riga di lista. Vuoto significa una cosa
        // precisa — il ciclo esiste in SAP ma non ha alcuna assegnazione materiale — e una cella
        // vuota non la direbbe: sembrerebbe un dato mancante, che e' proprio l'ambiguita' da cui
        // veniamo. Il testo la dichiara.
        formatRoutingMaterial(sMaterial) {
            const s = (sMaterial || "").trim();
            if (s) { return s; }
            return this._i18n().getText("routingNoMaterial");
        },

        // [PLEX-TYPE-LABEL] La tipologia part Plex della riga, nella lingua dell'utente. La
        // colonna mostrava il codice del seed, cioe' inglese anche a un utente italiano — e la
        // stessa tipologia si configura tradotta nella scheda «Categorie materiali», quindi le
        // due schermate dicevano la stessa cosa in due lingue.
        //
        // Chiave i18n = `plexPartType` + il codice senza separatori, ripiego sul codice grezzo:
        // gemello di `_plexPartTypeLabel` in adminconfigplant (PlantConfig.controller.js). Le due
        // app UI5 sono progetti separati e non condividono moduli, percio' e' duplicato; le
        // quattro copie dei bundle sono tenute allineate da test/plexPartTypeLabels.test.js.
        //
        // Sola visualizzazione: qui la tipologia non si sceglie e non si confronta.
        formatPlexPartTypeLabel(sCode) {
            // Un materiale senza part type esce vuoto. Senza questa uscita la chiave sarebbe
            // `plexPartType`, che in QUESTI bundle esiste — e' l'intestazione della colonna qui
            // accanto — e la cella mostrerebbe «Plex Part Type» al posto del vuoto.
            const sTrimmed = String(sCode || "").trim();
            if (!sTrimmed) {
                return "";
            }
            const sKey = "plexPartType" + sTrimmed.replace(/[^A-Za-z0-9]/g, "");
            const oBundle = this._i18n();
            return oBundle.hasText(sKey) ? oBundle.getText(sKey) : sTrimmed;
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

        // Formatters for production order status display
        formatProdOrderStatus(sReleased) {
            const oResourceBundle = this._i18n();
            if (sReleased === 'X') {
                return oResourceBundle.getText("prodOrderReleased");
            }
            return oResourceBundle.getText("prodOrderNotReleased");
        },

        formatProdOrderState(sReleased) {
            if (sReleased === 'X') {
                return 'Success';
            }
            return 'Warning';
        }
    });
});
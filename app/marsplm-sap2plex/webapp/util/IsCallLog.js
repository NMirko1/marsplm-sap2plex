/**
 * [IS-CALL-LOG] Traccia delle letture verso SAP, stampata nella console del BROWSER.
 *
 * I console.log del backend finiscono in `cf logs`: questo modulo porta le stesse letture
 * qui, con l'URL COMPLETO realmente inviato, i criteri, il $select, la forma, le righe, la
 * durata, l'esito e un campione della risposta. Serve a rispondere dal browser alla domanda
 * «come e' stata fatta questa chiamata, e con che dati?» — soprattutto quando la lista e'
 * vuota perche' il path /gw/odata non esiste sulla destination (0013, flusso E).
 *
 * Endpoint: GET /odata/v4/catalog/isCallLog(sinceSeq=<n>,limit=50)
 *   - `sinceSeq` avanza da solo: ogni dump stampa solo le letture nuove, e se ne restano altre
 *     le pagine successive arrivano da sole (fino a MAX_PAGES).
 *   - apribile anche a mano in una tab del browser.
 *   - nessun token CSRF: la rotta srv-api dell'approuter ha "csrfProtection": false.
 *
 * LE LETTURE DELLE SONDE NON COMPAIONO QUI. Ogni sonda stampa il proprio gruppo in console, con la
 * sua tabella, i suoi URL e i suoi MPL ID: ripeterle nel dump d'esercizio le sparpagliava fra le
 * letture delle liste, allungando un dump gia' difficile da leggere. Restano nell'anello e si
 * rivedono con window.isCallsProbes(). Dal 03/09/2026 a scrivere voci di sonda sono le sole sonde
 * verso Plex: quelle verso Integration Suite sono state rimosse.
 *
 * LA TRACCIA SI AZZERA A OGNI CARICAMENTO PAGINA (POST isCallLogReset, dentro install()).
 * L'anello vive nel processo del server e sopravvive ai refresh del browser: senza azzerarlo, le
 * letture appena fatte — quelle con l'MPL ID da girare al team Integration — restano sepolte
 * sotto quelle delle sessioni precedenti. Conseguenza da conoscere: l'anello e' unico per
 * processo, quindi il reset vale per chiunque abbia il cockpit aperto.
 *
 * [PLEX-CALL] LE CHIAMATE VERSO PLEX HANNO IL LORO DUMP. Anche quelle passano da questo anello
 * (`area: 'plex'`, ce le mette srv/lib/plexCallTrace.js), ma non sono letture OData verso SAP: si
 * stampano con `dumpPlex` / window.plexCalls(), che mostra indirizzo, CORPO INVIATO, stato e CORPO
 * RICEVUTO. Il cockpit lo chiama da solo subito dopo «Invia Job a Plex» e dopo uno spacchettamento.
 * Nacque per due chiamate che rispondevano `500 Data is Null` — il backwards-schedule del passo 5 e
 * il `PUT` del job, difetto Plex corretto da Rockwell il 27/08/2026 — ma non era uno strumento per
 * quel caso: serve a leggere per intero QUALUNQUE risposta senza aprire `cf logs`, e su un errore non
 * documentato dal contratto il corpo e' l'unico indizio. Nessuna chiamata in piu' verso Plex: si
 * stampa quella appena fatta.
 *
 * Uso dai controller:
 *   IsCallLog.install();                 // una volta, nella onInit della dashboard
 *   IsCallLog.dump("lista materiali");   // dopo un caricamento che legge da SAP
 *   IsCallLog.dumpPlex("crea job 000700000163");   // dopo un'operazione che scrive su Plex
 * e in qualunque momento, dalla console: window.isCalls() / window.isCallsAll() /
 * window.plexCalls() / window.isCallsReset().
 *
 * Non mostra NIENTE all'utente e non fa mai fallire una schermata: in caso di errore scrive
 * una riga in console e tace. I job batch non compaiono QUI (girano in processi separati che
 * nessuna rotta HTTP raggiunge): le loro letture notevoli si dichiarano in `cf logs`, cercare
 * `[IS-CALL-LOG] DUMP`.
 * Da rimuovere a migrazione conclusa: grep -rn "IS-CALL-LOG".
 */
sap.ui.define([
    // [APP-URL] Ogni URL verso il nostro backend porta davanti la base dell'app:
    // servita da Work Zone l'app sta sotto un prefisso, e un path assoluto non lo porta.
    "avvaleplm/marsplm/sap2plex/main/util/AppUrl"
], (AppUrl) => {
    "use strict";

    const ENDPOINT = AppUrl.url("/odata/v4/catalog/isCallLog");
    const RESET_ENDPOINT = AppUrl.url("/odata/v4/catalog/isCallLogReset");
    const LIMIT = 50;
    /**
     * Giri di auto-paginazione per dump. L'anello lato server ne tiene 200: quattro pagine da 50
     * lo esauriscono. Serve perche' una sola scala completa di sonda produce piu' di 50 voci, e
     * senza questo si dovrebbe chiamare window.isCalls() a mano per vedere il resto — che e'
     * esattamente il modo in cui le letture nuove sparivano dalla vista.
     */
    const MAX_PAGES = 4;
    // Le tre liste della dashboard si caricano insieme: si coalizzano in una fetch sola.
    const DEBOUNCE_MS = 300;
    const OK_STYLE = "color:#fff;background:#256f3a;padding:0 4px;font-weight:bold";
    const KO_STYLE = "color:#fff;background:#bb0000;padding:0 4px;font-weight:bold";
    // [IS-FULL-KEY] Una lettura NON ESEGUITA non e' ne' riuscita ne' fallita a valle: manca una
    // chiave che doveva arrivare dalla testata, e nessuna richiesta e' partita (DEC-42).
    const SKIP_STYLE = "color:#000;background:#ffd700;padding:0 4px;font-weight:bold";
    const SKIPPED_FORM = "non eseguita";
    /**
     * Le letture delle SONDE si riconoscono dalla forma: `sonda <id>` — la scrivono le tre sonde
     * verso Plex (`PROBE_FORM` in splitJobReadProbe.js, jobScheduleProbe.js, plexHistoryProbe.js).
     * Stessa regola lato server, in srv/lib/isCallDumpRules.js.
     *
     * NON vanno stampate nel dump generico. Ogni sonda ha il suo gruppo in console, con la sua
     * tabella, i suoi URL e i suoi MPL ID: ripeterle qui le sparpaglia in mezzo alle letture
     * d'esercizio — «distinta base/ExplodeBOM» dentro il gruppo «lista materiali» — e allunga un
     * dump che nessuno riesce piu' a leggere. Restano nell'anello: window.isCallsProbes().
     */
    const PROBE_FORM = /^sonda /;

    /**
     * [PLEX-CALL] Le chiamate verso PLEX (`area: 'plex'`, da srv/lib/plexCallTrace.js) hanno il
     * loro dump, `dumpPlex` / window.plexCalls().
     *
     * PERCHE' NON NEL DUMP GENERICO. Quello e' scritto per le letture OData verso SAP: stampa
     * `$select`, il wrapper `d` e i consigli su 503/ICMENOSYSTEMFOUND. Su una REST verso Plex quei
     * campi non esistono e quei consigli sono falsi — `columns` vale «(nessuno: API REST)» — quindi
     * mischiarle rende illeggibili entrambe. E' la stessa separazione che si applica alle sonde: la
     * voce resta nell'anello, cambia solo chi la stampa.
     *
     * PERCHE' UN CURSORE PROPRIO. Il dump SAP e questo avanzano indipendentemente: con un cursore
     * solo, il primo dei due si porterebbe via le voci dell'altro — e dopo uno split le due cose
     * succedono insieme (la finestra si richiude e la lista dei log si ricarica, che sono letture
     * SAP).
     */
    const PLEX_AREA = "plex";
    /** Il prefisso con cui `plexCallTrace` mette il corpo inviato nelle note della voce. */
    const SENT_PREFIX = "corpo inviato: ";

    /**
     * [LICENSE-BODY] Le chiamate al LICENSE SERVER: la terza area dell'anello, con la stessa forma
     * delle altre due e un cursore proprio, per le ragioni scritte sopra per Plex.
     *
     * PERCHE' SERVE. Il perimetro plant della dashboard nasce da due domande al license server — «il
     * plant e' licenziato?» e «questo utente ha un ruolo su questo plant?» — e il loro esito decide
     * se a schermo compaiono dei dati oppure niente. Quelle chiamate lasciavano una riga solo su
     * `cf logs`, dove nessuno guarda mentre usa l'applicazione: il 09/09/2026 una dashboard piena e
     * una configurazione in 403 sullo stesso plant si sono lette come un difetto del nostro codice,
     * mentre erano il ruolo `user` che il server aveva risposto. Il dato che chiudeva la questione
     * c'era, ma non dove serviva.
     *
     * LE VOCI «SKIP» SONO LA META' CHE CONTA. Il verdetto positivo sta in cache 24 h: nel caso
     * normale non parte nessuna chiamata, e un dump vuoto si legge come «non c'e' nessun check».
     * Una voce SKIP dichiara la PROVENIENZA del verdetto — live, cache, grace — e quella distinzione
     * e' l'unica difesa contro il rifare la stessa diagnosi sbagliata.
     */
    const LICENSE_AREA = "license";

    let iSince = 0;
    let iTimer = null;
    let sPendingContext = "";
    let bInstalled = false;
    let iSincePlex = 0;
    let iTimerPlex = null;
    let sPendingContextPlex = "";
    let iSinceLicense = 0;
    let iTimerLicense = null;
    let sPendingContextLicense = "";

    /**
     * L'ora della voce, `HH:MM:SS` nel fuso di chi guarda. Va nell'INTESTAZIONE del gruppo: sui
     * gruppi riusciti, che sono richiusi, e' l'unica riga visibile senza aprirli, ed e' il dato
     * che dice se stai guardando una chiamata di adesso o di mezz'ora fa. L'ISO completo resta
     * nella riga di coda, perche' e' quello che si correla con `cf logs` e col Message Monitoring.
     */
    function _ora(sIso) {
        const d = new Date(sIso);
        return isNaN(d.getTime())
            ? (sIso || "")
            : String(d.getHours()).padStart(2, "0") + ":"
                + String(d.getMinutes()).padStart(2, "0") + ":"
                + String(d.getSeconds()).padStart(2, "0");
    }

    function _print(r) {
        const bSkipped = r.form === SKIPPED_FORM;
        const bKo = r.outcome === "KO" && !bSkipped;
        const fnGroup = (bKo || bSkipped) ? console.group : console.groupCollapsed;
        fnGroup(
            "%c" + (bSkipped ? "NON ESEGUITA" : (bKo ? "KO" : "OK")) + "%c " +
            _ora(r.at) + "  " + r.area + "/" + r.entity + " " + r.op +
            (bSkipped ? "" : " — " + r.rows + " righe, " + r.calls + " chiamate, " + r.ms + " ms") +
            "  [" + r.mode + "]" +
            // Zero righe: lo stato reale e la forma della risposta si vedono senza aprire il gruppo.
            (!bSkipped && r.rows === 0 && r.rawSeen
                ? "  · HTTP " + r.rawStatus + " · `d` " + (r.rawHasD ? "SI'" : "NO") +
                  " · corpo " + (r.rawBody ? r.rawBody.length + " car." : "VUOTO")
                : ""),
            bSkipped ? SKIP_STYLE : (bKo ? KO_STYLE : OK_STYLE), ""
        );

        // Il path COMPLETO della chiamata: e' il dato per cui esiste questa traccia.
        if (r.urls) {
            const aUrls = r.urls.split("\n");
            aUrls.forEach((s, i) => {
                console.log("URL" + (aUrls.length > 1 ? " " + (i + 1) : "  ") + "         :", s);
            });
        } else {
            console.log("URL           : (non catturato dal tap)");
            console.log("richiesta ric.:", r.request);
        }
        // LO SCAMBIO CRUDO. Tutto il resto di questa voce e' passato dal purge OData di CAP, che
        // toglie il wrapper `d` quando c'e': solo questi campi dicono in che forma ha risposto
        // l'Integration Suite. `rawSeen` false significa NON MISURATO, non «vuoto».
        if (r.rawSeen) {
            console.log("stato reale   : HTTP " + r.rawStatus +
                "  ·  content-type: " + (r.responseContentType || "(non dichiarato)") +
                "  ·  wrapper OData `d`: " + (r.rawHasD ? "SI'" : "NO"));
            if (r.rawBody || r.rows === 0) {
                console.log("corpo CRUDO   :", r.rawBody === "" ? "(VUOTO: nessun corpo nella risposta)" : r.rawBody);
            }
        } else {
            console.log("stato reale   : (tap sulla risposta non agganciato su questa chiamata: " +
                "il corpo crudo non e' stato misurato)");
        }
        // [IS-CHANNEL] «Dove e' andata» e «su quale canale» sono la stessa domanda e si leggono
        // vicine. Il canale NON e' ricavabile dall'URL: le due destination del progetto puntano
        // allo stesso host CPI, e il 02/09/2026 era una delle tre variabili di una diagnosi
        // costata tre deploy.
        console.log("destination   :", r.destination || "(non dichiarata)");
        console.log("service root  :", r.root);
        console.log("criteri       :", r.criteria || "(nessuno)");
        console.log("$select       :", r.columns);
        if (r.top) { console.log("$top          :", r.top); }
        console.log("forma         :", r.form +
            (r.derivedOp && r.derivedOp !== r.op ? "  (operazione derivata " + r.derivedOp + " -> " + r.op + ")" : ""));
        if (r.headers) { console.log("header inviati:", r.headers); }
        if (r.notes) { console.log("note          :", r.notes); }
        if (r.firstRow) { console.log("prima riga    :", r.firstRow); }

        if (bSkipped) {
            // Nessuna richiesta e' partita: il perche' e' tutto qui.
            console.warn("motivo        :", r.error || r.notes);
            console.warn("=> Nessuna richiesta inviata: senza quella chiave questo service root non e' " +
                "interrogabile (la collection non e' esposta). In quale campo l'iFlow mandi le " +
                "chiavi si vede dal corpo crudo della lettura di testata, qui sopra nell'anello.");
        } else if (bKo) {
            console.error("errore        :", r.error);
            if (r.upstreamStatus) {
                console.error("stato REALE   : HTTP " + r.upstreamStatus +
                    " (il 502 nel messaggio e' normalizzato da CAP, ignoralo)");
            }
            if (r.responseBody) { console.error("body ricevuto :", r.responseBody); }
            console.warn("=> Il codice HTTP dice cosa: 503 con sap-err-id ICMENOSYSTEMFOUND vuol dire che la " +
                "destination punta al gateway on-premise, dove i path /gw/odata non esistono (ambienti interni, " +
                "0013 flusso E); 404 il service root non esiste sul tenant IS; 400 un campo del $select o del " +
                "$filter non e' esposto dall'iFlow; 401/403 auth (vedi qui sotto).");
            // [IS-NO-USER] Il 401 aveva UNA riga («401/403 auth.») e il progetto lo ha pagato due
            // volte: il 19/08/2026 e il 27/08/2026, con la stessa firma e due cause diverse. Le
            // cause sono tre e si distinguono in trenta secondi: qui c'e' come.
            // `Number(...)`: la colonna e' un Integer OData, ma un confronto stretto su un valore
            // che arrivasse come stringa salterebbe il consiglio IN SILENZIO — cioe' proprio la
            // classe di difetto che questo file esiste per rendere visibile.
            var iUp = Number(r.upstreamStatus);
            if (iUp === 401 || iUp === 403) {
                console.warn("=> Un " + iUp + " a CORPO VUOTO e senza content-type lo manda " +
                    "l'Integration Suite, e ha TRE cause. Come distinguerle:\n" +
                    "   1. LA RIGA `note` QUI SOPRA. Se dice NESSUN JWT DA INOLTRARE, al Cloud SDK non e' " +
                    "arrivato nessun token da scambiare: la causa e' di qua, e si guarda dove CAP cerca il " +
                    "JWT. Se `note` NON c'e', il token c'era e l'utente era identificato: la causa e' una " +
                    "delle altre due. (Le due note che parlano di utente ANONIMO non possono comparire in " +
                    "esercizio: in produzione CAP respinge prima con 401 — si vedono solo in sviluppo, dove " +
                    "i servizi sono aperti.)\n" +
                    "   2. LOGIN DA ZERO IN UNA FINESTRA IN INCOGNITO. Se le liste si popolano era lo " +
                    "stato della sessione; se il 401 resta identico, la sessione non c'entra ed e' il " +
                    "canale (e' quello che e' successo il 27/08/2026).\n" +
                    "   3. LA DESTINATION. Cockpit BTP -> Connectivity -> Destinations -> Check " +
                    "Connection. Con OAuth2SAMLBearerAssertion l'utente del login deve esistere sul lato " +
                    "SAP e il principal deve avere ESBMessaging.send sul tenant; con Basic o " +
                    "ClientCredentials un 401 e' una credenziale rifiutata (password scaduta, segreto " +
                    "ruotato).\n" +
                    "   Sul server la riga corrispondente e': cf logs marsplm-sap2plex-srv --recent | " +
                    "grep -E \"UTENTE ANONIMO|NESSUN JWT DA INOLTRARE|NESSUN CONTESTO\"");
            }
        } else if (r.rows === 0) {
            // Il corpo CRUDO e' gia' stampato sopra: qui si dice come leggerlo, perche' su una
            // lettura riuscita e vuota e' l'unica cosa che distingue chi ha il difetto.
            console.warn("=> Chiamata riuscita con ZERO righe. Il corpo CRUDO qui sopra dice quale caso e': " +
                "un OData ben formato ma vuoto ({\"d\":{\"results\":[]}}) -> il problema e' a monte (iFlow o " +
                "RFC) o nei criteri; nessun corpo -> la risposta esce senza payload; un corpo con i dati " +
                "dentro ma senza `d` -> le righe ci sono e non le riconosciamo come OData.");
        }

        console.log("seq " + r.seq + " · " + r.at + (r.instance ? " · istanza " + r.instance : ""));
        console.groupEnd();
    }

    /**
     * Una pagina di letture. Se il server ne restituisce `LIMIT` piene ce ne sono altre, e si
     * prosegue DA SOLI fino a `MAX_PAGES`: una scala completa di sonda supera abbondantemente le
     * 50 voci, e chiedere all'utente di paginare a mano e' il modo in cui le letture nuove
     * finivano per non essere mai lette. Il tetto, quando si raggiunge, si DICHIARA: un
     * troncamento silenzioso qui direbbe «non c'e' altro», che e' peggio del troncamento.
     *
     * @param {string} sContext etichetta del dump, mostrata in intestazione
     * @param {int}    iPage    giro corrente (1 = primo)
     */
    function _fetch(sContext, iPage) {
        const iGiro = iPage || 1;
        fetch(ENDPOINT + "(sinceSeq=" + iSince + ",limit=" + LIMIT + ")", { headers: { "Accept": "application/json" } })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then((d) => {
                const aRows = (d && d.value) || [];
                // Il cursore avanza su TUTTO cio' che e' arrivato, anche sulle voci di sonda che
                // non si stampano: restano nell'anello, non nel dump d'esercizio.
                aRows.forEach((r) => { if (r.seq > iSince) { iSince = r.seq; } });
                const aSonde = aRows.filter(r => PROBE_FORM.test(r.form || ""));
                // [PLEX-CALL] Le chiamate verso Plex hanno il loro dump: qui si dichiarano e non si
                // stampano (vedi PLEX_AREA in testa).
                const aPlex = aRows.filter(r => !PROBE_FORM.test(r.form || "") && r.area === PLEX_AREA);
                // [LICENSE-BODY] Come Plex: si dichiarano e non si stampano, hanno il dump loro.
                const aLic = aRows.filter(r => r.area === LICENSE_AREA);
                const aEsercizio = aRows.filter(r => !PROBE_FORM.test(r.form || "") &&
                    r.area !== PLEX_AREA && r.area !== LICENSE_AREA);

                if (!aEsercizio.length) {
                    if (aPlex.length) {
                        console.log("[IS-CALL-LOG] " + aPlex.length + " chiamate verso Plex: " +
                            "window.plexCalls() per vederle per intero.");
                    }
                    if (aLic.length) {
                        console.log("[LICENSE-CALL] " + aLic.length + " chiamate al license server: " +
                            "window.licenseCalls() per vederle per intero.");
                    }
                    if (aSonde.length) {
                        console.log("[IS-CALL-LOG] " + aSonde.length + " letture di sonda: sono nel gruppo " +
                            "della loro sonda. window.isCallsProbes() per rivederle qui.");
                    } else if (!aPlex.length && sContext === "manuale") {
                        console.log("[IS-CALL-LOG] nessuna lettura nuova verso SAP. window.isCallsAll() rilegge tutto l'anello.");
                    }
                    if (aRows.length < LIMIT) { return; }
                    if (iGiro < MAX_PAGES) { _fetch(sContext, iGiro + 1); }
                    return;
                }

                console.group("%c[IS-CALL-LOG]%c " + _ora(new Date().toISOString()) + " · " +
                    aEsercizio.length + " letture verso SAP" +
                    (sContext ? " — " + sContext : "") +
                    (iGiro > 1 ? "  (pagina " + iGiro + ")" : ""), "font-weight:bold", "");
                aEsercizio.forEach(_print);
                if (aPlex.length) {
                    console.log("+ " + aPlex.length + " chiamate verso Plex (window.plexCalls() " +
                        "per vederle per intero: indirizzo, corpo inviato, corpo ricevuto)");
                }
                if (aLic.length) {
                    console.log("+ " + aLic.length + " chiamate al license server (window.licenseCalls() " +
                        "per vederle per intero: indirizzo, verdetto, corpo crudo)");
                }
                if (aSonde.length) {
                    console.log("+ " + aSonde.length + " letture di sonda, nel gruppo della loro sonda " +
                        "(window.isCallsProbes() per rivederle qui)");
                }
                console.groupEnd();

                if (aRows.length < LIMIT) { return; }
                if (iGiro >= MAX_PAGES) {
                    console.warn("[IS-CALL-LOG] fermato dopo " + MAX_PAGES + " pagine da " + LIMIT +
                        " voci: ce ne sono ancora. window.isCalls() per le successive.");
                    return;
                }
                _fetch(sContext, iGiro + 1);
            })
            .catch(e => console.error("[IS-CALL-LOG] traccia non disponibile:", e.message));
    }

    /**
     * Azzera l'anello lato server. Lo si fa all'apertura del cockpit, perche' la traccia vive nel
     * processo del server e sopravvive ai refresh del browser: dopo qualche apertura le letture
     * appena fatte finiscono sepolte sotto quelle delle sessioni precedenti.
     *
     * Fire-and-forget: e' una POST locale e velocissima, mentre le prime letture verso SAP nascono
     * secondi dopo, quindi in pratica non c'e' corsa. Se una voce nascesse in quei millisecondi
     * andrebbe persa — e' il prezzo, dichiarato, di una console che riparte pulita.
     *
     * L'anello e' unico per processo: questo reset vale per chiunque abbia il cockpit aperto.
     */
    /**
     * Le sole letture di SONDA presenti nell'anello, rilette dall'inizio. Non tocca il cursore dei
     * dump d'esercizio: e' una vista a parte, per quando serve confrontare l'anello con quello che
     * la sonda ha stampato nel suo gruppo.
     */
    function _fetchProbes() {
        fetch(ENDPOINT + "(sinceSeq=0,limit=200)", { headers: { "Accept": "application/json" } })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then((d) => {
                const aRows = ((d && d.value) || []).filter(r => PROBE_FORM.test(r.form || ""));
                if (!aRows.length) {
                    console.log("[IS-CALL-LOG] nessuna lettura di sonda nell'anello.");
                    return;
                }
                console.group("%c[IS-CALL-LOG]%c " + aRows.length + " letture di SONDA", "font-weight:bold", "");
                aRows.forEach(_print);
                console.groupEnd();
            })
            .catch(e => console.error("[IS-CALL-LOG] traccia non disponibile:", e.message));
    }

    /**
     * [PLEX-CALL] Una chiamata verso Plex, PER INTERO: indirizzo, corpo inviato, stato, corpo
     * ricevuto. E' il log che serve a girare un difetto a Rockwell — e a vedere, mentre si lavora,
     * cosa e' stato davvero mandato — senza aprire `cf logs`.
     *
     * I gruppi KO restano APERTI: sono quelli per cui si guarda la console. Le riuscite si aprono
     * con un clic, perche' «cosa ho mandato» e' una domanda che si pone anche su una chiamata andata
     * bene (una part-operation valorizzata a sproposito risponde 200).
     *
     * IL CORPO RICEVUTO SI STAMPA SEMPRE, anche sulle riuscite: `rawBody` e' il corpo cosi' com'e'
     * arrivato. Se e' vuoto lo si dichiara, perche' «nessun corpo» e «non l'ho guardato» sono due
     * cose diverse (`rawSeen`).
     */
    function _printPlex(r) {
        const bKo = r.outcome === "KO";
        const fnGroup = bKo ? console.group : console.groupCollapsed;
        const iStato = r.upstreamStatus || r.rawStatus || 0;
        fnGroup(
            "%c" + (bKo ? "KO" : "OK") + "%c " + _ora(r.at) + "  " + r.op + " " + r.entity +
            "  —  " + (iStato ? "HTTP " + iStato : "nessuna risposta") + " in " + r.ms + " ms",
            bKo ? KO_STYLE : OK_STYLE, ""
        );

        // L'indirizzo COMPLETO: `request` e' gia' `<METODO> <url assoluto>`, composto dal tracciato
        // col baseUrl del tenant quando la risposta non lo rimanda.
        console.log("indirizzo     :", r.request || "(non registrato)");
        const sInviato = (r.notes || "").indexOf(SENT_PREFIX) === 0
            ? r.notes.slice(SENT_PREFIX.length)
            : r.notes;
        console.log("corpo inviato :", sInviato || "(nessuno: la chiamata non porta un corpo)");
        console.log("stato         :", iStato ? "HTTP " + iStato : "(nessuna risposta: vedi errore)");
        const sRicevuto = r.rawBody || r.responseBody;
        const fnCorpo = bKo ? console.warn : console.log;
        fnCorpo("corpo ricevuto:", sRicevuto ||
            (r.rawSeen ? "(VUOTO: nessun corpo nella risposta)" : "(non misurato: la chiamata e' morta prima)"));
        if (r.error) { console.error("errore        :", r.error); }
        if (r.criteria) { console.log("criteri       :", r.criteria); }
        console.log("seq " + r.seq + " · " + r.at + " · " + r.form +
            (r.instance ? " · istanza " + r.instance : ""));
        console.groupEnd();
    }

    /**
     * [PLEX-CALL] Le chiamate Plex nuove dall'ultimo dump. Cursore proprio, nessuna paginazione:
     * l'anello ne tiene 200 e una sequenza di creazione job o di split ne fa meno di dieci.
     */
    function _fetchPlex(sContext) {
        fetch(ENDPOINT + "(sinceSeq=" + iSincePlex + ",limit=200)", { headers: { "Accept": "application/json" } })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then((d) => {
                const aRows = (d && d.value) || [];
                aRows.forEach((r) => { if (r.seq > iSincePlex) { iSincePlex = r.seq; } });
                // Anche le SONDE verso Plex passano da questo anello (`form: 'sonda <id>'`), ma
                // stampano gia' il proprio gruppo con il proprio verdetto: ripeterle qui vorrebbe
                // dire vedere due volte le stesse quattro letture. Restano nell'anello, e la vista
                // che le mostra e' window.isCallsProbes(). Cosi' i due dump si dividono l'anello
                // per intero e nessuna voce e' contata due volte.
                const aPlex = aRows.filter(r => r.area === PLEX_AREA && !PROBE_FORM.test(r.form || ""));
                if (!aPlex.length) {
                    const iSonde = aRows.filter(r => r.area === PLEX_AREA && PROBE_FORM.test(r.form || "")).length;
                    console.log("[PLEX-CALL] nessuna chiamata verso Plex" +
                        (sContext ? " — " + sContext : "") +
                        ". Se l'operazione non e' arrivata a Plex, il perche' e' nel messaggio a schermo." +
                        (iSonde ? " (" + iSonde + " letture di sonda: window.isCallsProbes())" : ""));
                    return;
                }
                const iKo = aPlex.filter(r => r.outcome === "KO").length;
                console.group("%c[PLEX-CALL]%c " + _ora(new Date().toISOString()) + " · " +
                    aPlex.length + " chiamate verso Plex" + (sContext ? " — " + sContext : "") +
                    (iKo ? "  ·  " + iKo + " KO" : ""), "font-weight:bold", "");
                aPlex.forEach(_printPlex);
                console.groupEnd();
            })
            .catch(e => console.error("[PLEX-CALL] traccia non disponibile:", e.message));
    }

    /**
     * [LICENSE-BODY] Una chiamata al license server, per intero.
     *
     * STAMPATORE SUO E NON `_print`. Quello e' scritto per le letture verso SAP e in coda aggiunge i
     * consigli diagnostici su una lista — «il $top NON C'ERA», «troncamento della sorgente» — che su
     * una risposta di licenza sono semplicemente falsi: `/LicenseStatus` non e' una collection e non
     * ha un tetto da spingere. Un consiglio sbagliato in una console e' peggio di nessun consiglio,
     * perche' viene seguito.
     *
     * LE TRE RIGHE CHE DECIDONO. `wrapper OData 'd'` distingue una forma cambiata da un ruolo
     * assente (senza involucro `d` il lettore non trova niente e l'esito sarebbe «nessun ruolo», che
     * e' il difetto piu' grave che questo canale puo' avere); `verdetto` dice cosa ne abbiamo fatto;
     * `corpo CRUDO` dice cosa e' arrivato. Le tre insieme sono la differenza fra «il nostro codice
     * sbaglia» e «il server risponde questo».
     *
     * I gruppi KO restano APERTI, le riuscite e le SKIP si aprono con un clic: nel caso normale
     * queste voci sono rumore, e diventano interessanti quando la dashboard e' vuota.
     */
    function _printLicense(r) {
        const bKo = r.outcome === "KO";
        const bSkip = r.outcome === "SKIP";
        const fnGroup = bKo ? console.group : console.groupCollapsed;
        const iStato = r.rawStatus || r.upstreamStatus || 0;
        fnGroup(
            "%c" + (bKo ? "KO" : (bSkip ? "SKIP" : "OK")) + "%c " + _ora(r.at) + "  " +
            r.op + " " + r.entity + "  —  " +
            (bSkip ? "nessuna chiamata" : (iStato ? "HTTP " + iStato + " in " + r.ms + " ms" : "nessuna risposta")),
            bKo ? KO_STYLE : (bSkip ? SKIP_STYLE : OK_STYLE), ""
        );

        // Su una voce SKIP non c'e' nessun indirizzo da mostrare: la chiamata non e' partita, e
        // stampare un URL mai chiamato la farebbe leggere come una chiamata avvenuta.
        console.log("URL           :", r.request || (bSkip
            ? "(nessuna: il verdetto non viene dal server — vedi provenienza)"
            : "(non registrato)"));
        console.log("criteri       :", r.criteria || "(nessuno)");
        console.log("canale        :", r.destination || "(non dichiarato)");
        if (r.notes) { console.log("verdetto      :", r.notes); }
        if (!bSkip) {
            console.log("stato reale   :", (iStato ? "HTTP " + iStato : "(nessuna risposta)") +
                "  ·  content-type: " + (r.responseContentType || "(assente)") +
                "  ·  wrapper OData `d`: " + (r.rawHasD ? "SI'" : "NO"));
            const sCorpo = r.rawBody || r.responseBody;
            (bKo ? console.warn : console.log)("corpo CRUDO   :", sCorpo ||
                (r.rawSeen ? "(VUOTO: nessun corpo nella risposta)" : "(non misurato: nessuna risposta arrivata)"));
        }
        if (r.error) { console.error("errore        :", r.error); }
        console.log("seq " + r.seq + " · " + r.at + (r.instance ? " · istanza " + r.instance : ""));
        console.groupEnd();
    }

    /**
     * [LICENSE-BODY] Le chiamate di licenza nuove dall'ultimo dump. Cursore proprio, nessuna
     * paginazione: una risoluzione di perimetro ne fa due per plant, e l'anello ne tiene 200.
     */
    function _fetchLicense(sContext) {
        fetch(ENDPOINT + "(sinceSeq=" + iSinceLicense + ",limit=200)", { headers: { "Accept": "application/json" } })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then((d) => {
                const aRows = (d && d.value) || [];
                aRows.forEach((r) => { if (r.seq > iSinceLicense) { iSinceLicense = r.seq; } });
                const aLic = aRows.filter(r => r.area === LICENSE_AREA);
                if (!aLic.length) {
                    // Non e' «nessun check»: con il perimetro vuoto la traccia non viene servita
                    // affatto (il gate della function sta in srv/cat-service.js), e questa e' la
                    // sola riga che distingue le due cose. La dashboard lo dichiara anche prima,
                    // dove sa quanti plant ha in mano.
                    console.log("[LICENSE-CALL] nessuna chiamata di licenza nell'anello" +
                        (sContext ? " — " + sContext : "") +
                        ". Se il tuo perimetro e' vuoto la traccia non viene servita: la diagnosi e' in cf logs.");
                    return;
                }
                const iKo = aLic.filter(r => r.outcome === "KO").length;
                const iSkip = aLic.filter(r => r.outcome === "SKIP").length;
                console.group("%c[LICENSE-CALL]%c " + _ora(new Date().toISOString()) + " · " +
                    aLic.length + " chiamate al license server" + (sContext ? " — " + sContext : "") +
                    (iKo ? "  ·  " + iKo + " KO" : "") +
                    (iSkip ? "  ·  " + iSkip + " dalla cache" : ""), "font-weight:bold", "");
                aLic.forEach(_printLicense);
                console.groupEnd();
            })
            .catch(e => console.error("[LICENSE-CALL] traccia non disponibile:", e.message));
    }

    function _reset(bVerbose) {
        iSince = 0;
        iSincePlex = 0;
        iSinceLicense = 0;
        return fetch(RESET_ENDPOINT, {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: "{}"
        })
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .then((d) => {
                if (bVerbose) { console.log("[IS-CALL-LOG] " + ((d && d.message) || "anello azzerato")); }
            })
            .catch(e => console.warn("[IS-CALL-LOG] anello non azzerato (" + e.message +
                "): la traccia mostrera' anche le letture delle sessioni precedenti"));
    }

    return {
        /** Stampa le letture nuove. Chiamate ravvicinate si coalizzano in una fetch sola. */
        dump(sContext) {
            sPendingContext = sContext || sPendingContext;
            if (iTimer) { return; }
            iTimer = setTimeout(() => {
                iTimer = null;
                const sCtx = sPendingContext;
                sPendingContext = "";
                _fetch(sCtx);
            }, DEBOUNCE_MS);
        },

        /**
         * [PLEX-CALL] Stampa PER INTERO le chiamate verso Plex nuove dall'ultimo dump: indirizzo,
         * corpo inviato, stato, corpo ricevuto.
         *
         * Si chiama subito dopo l'operazione che le ha fatte partire — «Crea Job in Plex» e lo
         * spacchettamento — nei DUE rami, riuscito e fallito: una chiamata morta e' proprio quella
         * da leggere. Non fa partire nessuna chiamata verso Plex: stampa quelle che sono appena
         * state fatte.
         *
         * Debounce PROPRIO, non quello di `dump`: dopo uno split partono entrambi (la finestra
         * ricarica i log dell'ordine, che sono letture SAP) e un timer condiviso ne perderebbe uno.
         */
        dumpPlex(sContext) {
            sPendingContextPlex = sContext || sPendingContextPlex;
            if (iTimerPlex) { return; }
            iTimerPlex = setTimeout(() => {
                iTimerPlex = null;
                const sCtx = sPendingContextPlex;
                sPendingContextPlex = "";
                _fetchPlex(sCtx);
            }, DEBOUNCE_MS);
        },

        /**
         * [LICENSE-BODY] Le chiamate di licenza. Debounce PROPRIO: la risoluzione del perimetro e le
         * tre liste partono insieme all'apertura, e senza coalizione questo dump girerebbe piu'
         * volte sullo stesso insieme di voci.
         */
        dumpLicense(sContext) {
            sPendingContextLicense = sContext || sPendingContextLicense;
            if (iTimerLicense) { return; }
            iTimerLicense = setTimeout(() => {
                iTimerLicense = null;
                const sCtx = sPendingContextLicense;
                sPendingContextLicense = "";
                _fetchLicense(sCtx);
            }, DEBOUNCE_MS);
        },

        /**
         * Registra i comandi manuali e AZZERA la traccia.
         *
         * Il reset qui e' voluto: `bInstalled` fa girare questo blocco una volta per caricamento
         * pagina, quindi a ogni refresh la console riparte pulita e mostra la sola sessione
         * corrente. E' la prima riga della onInit della dashboard, prima delle sonde e delle
         * liste, cosi' le loro letture nascono dopo l'azzeramento.
         */
        install() {
            if (bInstalled) { return; }
            bInstalled = true;
            window.isCalls = () => { _fetch("manuale"); };
            window.isCallsAll = () => { iSince = 0; _fetch("dall'inizio dell'anello"); };
            window.isCallsProbes = () => { _fetchProbes(); };
            // [PLEX-CALL] Le chiamate verso Plex, per intero. `plexCallsAll` rilegge l'anello dal
            // principio: serve quando il dump automatico e' scorso via nella console.
            window.plexCalls = () => { _fetchPlex("manuale"); };
            window.plexCallsAll = () => { iSincePlex = 0; _fetchPlex("dall'inizio dell'anello"); };
            // [LICENSE-BODY] Le chiamate al license server: si stampano da sole alla risoluzione del
            // perimetro, e `licenseCallsAll` le rilegge quando il dump e' scorso via.
            window.licenseCalls = () => { _fetchLicense("manuale"); };
            window.licenseCallsAll = () => { iSinceLicense = 0; _fetchLicense("dall'inizio dell'anello"); };
            window.isCallsReset = () => _reset(true);
            _reset(false);
            console.log("%c[IS-CALL-LOG]%c traccia delle chiamate verso SAP attiva, e azzerata per " +
                "questa sessione. window.isCalls() = letture nuove d'esercizio, " +
                "window.isCallsProbes() = quelle delle sonde, window.isCallsAll() = tutto l'anello, " +
                "window.isCallsReset() = svuota la traccia.",
                "font-weight:bold", "");
            console.log("%c[PLEX-CALL]%c chiamate verso Plex: si stampano da sole dopo «Crea Job in " +
                "Plex» e dopo uno spacchettamento, con indirizzo, corpo inviato e corpo ricevuto. " +
                "window.plexCalls() = le nuove, window.plexCallsAll() = tutte quelle nell'anello.",
                "font-weight:bold", "");
            console.log("%c[LICENSE-CALL]%c chiamate al license server (licenza del plant e ruolo " +
                "dell'utente): si stampano da sole alla risoluzione del perimetro, con indirizzo, " +
                "verdetto e corpo crudo. Una voce SKIP = nessuna chiamata, verdetto dalla cache. " +
                "window.licenseCalls() = le nuove, window.licenseCallsAll() = tutte quelle nell'anello.",
                "font-weight:bold", "");
        }
    };
});

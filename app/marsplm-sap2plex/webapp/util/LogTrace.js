sap.ui.define(["./AppUrl", "./MatLogFilter"], (AppUrl, MatLogFilter) => {
    "use strict";

    // ================================================================
    // [LOG-TRACE] Lo storico invii si LEGGE SENZA LA TRACCIA, e la traccia si chiede al clic.
    //
    // PERCHE' ESISTE. Le tre schede di dettaglio — ordine, materiale, ciclo — leggono lo storico
    // con una `fetch` grezza e SENZA `$select`, quindi ogni riga porta anche `RequestJson` e
    // `ResponseJson`: i due `LargeString` con il corpo mandato a Plex e la risposta ricevuta, che
    // in scrittura non hanno nessun tetto (il passo 1 della creazione job salva la risposta di
    // `/mdm/v1/parts`, che su un tenant che ignora il query parameter e' l'INTERO CATALOGO PARTI).
    // Le tabelle a schermo mostrano cinque o sei colonne, e nessuna delle due e' fra queste: i due
    // corpi servono soltanto al pannello che si apre cliccando una riga.
    //
    // Il 21/09/2026, sull'ordine `000700000069`, l'apertura di quella tab ha prodotto
    // `502 endpoint_failure (EOF)` e, nei log della piattaforma, `Killed` / `Exit status 137 (out
    // of memory)` / `Process has crashed`. Con `instances: 1` (mta.yaml) il processo ucciso NON
    // svuota una tabella: porta giu' il cockpit per tutti, e si ripete a ogni apertura. Perche'
    // solo gli ordini falliti: uno riuscito ha una riga, uno fallito ne ha una per tentativo.
    //
    // ATTENZIONE, e' dichiarato: che il processo muoia su QUELLA lettura e' misurato; che a
    // riempire la memoria siano proprio i due `LargeString` e non altro nella stessa riga e'
    // dedotto. La correzione vale comunque a se' — la lista scarica per ogni riga due colonne
    // senza tetto che non mostra mai — ma se dopo il rilascio il processo muore ancora li', la
    // causa e' un'altra e va indagata da capo.
    //
    // NESSUN TETTO IN SCRITTURA. La traccia resta INTERA in banca dati e intera si mostra al clic:
    // quelle righe sono la prova di cosa e' stato mandato e di cosa Plex ha risposto (DEC-96).
    // Qui cambia soltanto chi la scarica, e quando.
    //
    // UN MODULO E NON TRE COPIE. Le tre schermate avevano gia' tre copie della stessa lettura, ed
    // e' la ragione per cui lo stesso difetto stava in tre posti.
    //
    // [APP-URL] Questo modulo l'indirizzo se lo AVVOLGE da se'. La deroga di `MatLogFilter.js` e
    // `PlexOpsCatalog.js` — costruiscono il path e la base la mette il chiamante — esiste perche' i
    // LORO test pretendono che restino `sap.ui.define([])`; qui quella ragione non c'e', e
    // `test/appUrlSurface.test.js` dichiara cosa fare quando cade: «gli si dia AppUrl».
    //
    // Test: `node test/logHistorySelect.test.js`.
    // ================================================================

    /**
     * Le tre colonne che NON stanno nella lista e che si leggono per la sola riga selezionata.
     * `ResponseStatus` e' un Integer e viaggia anche nella lista: qui si rilegge perche' il
     * pannello deve poterlo mostrare anche su una riga vecchia, dove e' nullo e si ricava dal
     * corpo della risposta.
     */
    const TRACE_COLUMNS = ["RequestJson", "ResponseJson", "ResponseStatus"];

    /**
     * Le chiavi NUMERICHE delle tre entity di storico. Il tipo non si indovina dal valore: un
     * `Counter` che arrivasse dal modello come stringa darebbe `Counter eq '3'`, cioe' un 400 —
     * e un 400 su questa lettura si legge a schermo come «traccia vuota», che e' l'affermazione
     * opposta a quella vera. Su tutte e tre le entity l'unica chiave numerica e' `Counter`.
     */
    const NUMERIC_KEYS = ["Counter"];

    /**
     * Il valore di `$select` di una lista di storico.
     *
     * Ci vanno le CHIAVI dell'entity (servono a rileggere la traccia), le colonne che la tabella
     * rende, `ResponseStatus`, e `MessageJson`.
     *
     * `MessageJson` E' OBBLIGATORIO. `localizeLogRows` lato server salta la riga con
     * `if (!(jsonField in row)) continue`: una colonna non chiesta e' ASSENTE, non `null`, e la
     * distinzione e' voluta — «non ci sono segmenti» e «non lo sappiamo» hanno esiti opposti.
     * Senza, il messaggio resterebbe lo snapshot italiano per chiunque, che e' esattamente il
     * difetto che DEC-92 esiste per evitare.
     *
     * @param {Array<string>} aColumns
     * @returns {string}
     */
    function listSelect(aColumns) {
        return (aColumns || []).join(",");
    }

    /**
     * Il path della lettura della traccia di UNA riga.
     *
     * LA FORMA E' UNA COLLECTION CON TUTTE LE UGUAGLIANZE DI CHIAVE, non il key predicate
     * `Entity(k1='a',k2=3)`. E' la stessa forma della lista, quindi passa per costruzione dagli
     * stessi gate del server: il rifiuto di una lettura senza criteri su `ZProdOrderExcLog*` e
     * `ZRoutingExcLog*`, e il gate per plant su `ZMatExcLogPOS`. Col key predicate resterebbe da
     * dimostrare che quel gate — che aggiunge una `where` — si componga con un predicato che
     * DEC-111 dice vivere in `SELECT.from.ref[...].where`: una dimostrazione che non serve fare
     * se si sceglie la forma che non la richiede.
     *
     * Le uguaglianze sono TUTTE quelle della chiave, quindi `$top=1` non sceglie niente — non e'
     * il `$top=1` su una collection parziale che DEC-121 ha dovuto correggere, dove a scegliere
     * la riga era la posizione.
     *
     * @param {string} sEntity nome dell'entity, p.es. `ZProdOrderExcLogPOS`
     * @param {object} oKeys tutte le chiavi della riga, p.es. `{ ManufacturingOrder, Counter }`
     * @returns {string} l'URL completo, con davanti la base dell'app
     */
    function traceUrl(sEntity, oKeys) {
        const aTerms = Object.keys(oKeys || {}).map((sKey) => {
            const vValue = oKeys[sKey];
            const sLiteral = NUMERIC_KEYS.indexOf(sKey) >= 0
                ? String(Number(vValue))
                : MatLogFilter.odataLiteral(vValue);
            return sKey + " eq " + sLiteral;
        });
        return AppUrl.url("/odata/v4/log/") + sEntity + "?$filter="
            + encodeURIComponent(aTerms.join(" and "))
            + "&$select=" + TRACE_COLUMNS.join(",")
            + "&$top=1";
    }

    /**
     * Legge la traccia e ne restituisce l'esito, senza mai lanciare.
     *
     * VUOTO NON E' IGNOTO. Una lettura caduta e una riga che non c'e' sono due cose diverse, e
     * nessuna delle due e' «la traccia e' vuota»: chi chiama deve poter dire all'utente che non
     * ha potuto leggere, invece di mostrargli due riquadri vuoti (DEC-121, `[DETAIL-RESET]`).
     *
     * @param {string} sUrl l'URL completo, da `traceUrl`
     * @returns {Promise<{ok: boolean, request: string, response: string, status: ?number, error: string}>}
     */
    function fetchTrace(sUrl) {
        const oEmpty = { ok: false, request: "", response: "", status: null };
        return fetch(sUrl, { headers: { "Accept": "application/json" } })
            .then((oResponse) => {
                // La guardia che alla lettura del dizionario dei job mancava: un errore con corpo
                // JSON non fa rigettare `.json()`, quindi senza questa riga un 502 arriverebbe di
                // sotto come una risposta valida e vuota.
                if (!oResponse.ok) { throw new Error("HTTP " + oResponse.status); }
                return oResponse.json();
            })
            .then((oData) => {
                const aRows = (oData && oData.value) || [];
                if (!aRows.length) {
                    return Object.assign({}, oEmpty, { error: "NOT_FOUND" });
                }
                const oRow = aRows[0];
                return {
                    ok: true,
                    request: oRow.RequestJson || "",
                    response: oRow.ResponseJson || "",
                    status: (oRow.ResponseStatus === null || oRow.ResponseStatus === undefined)
                        ? null : oRow.ResponseStatus,
                    error: ""
                };
            })
            .catch((oError) => Object.assign({}, oEmpty, {
                error: (oError && oError.message) || String(oError)
            }));
    }

    /**
     * I quattro campi del pannello JSON, a partire dall'esito di `fetchTrace`.
     *
     * E' il rendering che le tre schermate facevano ciascuna per conto suo, parola per parola:
     * `JSON.parse` in `try`, ripiego sul testo grezzo quando non e' JSON, e lo stato ricavato dal
     * corpo della risposta quando la colonna e' nulla — che e' il caso delle righe piu' vecchie di
     * `ResponseStatus`.
     *
     * @param {{request: string, response: string, status: ?number}} oTrace
     * @returns {{RequestJsonFormatted: string, ResponseJsonFormatted: string, ResponseStatus: ?number, ResponseStatusText: string}}
     */
    function formatTrace(oTrace) {
        const pretty = (vRaw) => {
            if (!vRaw) { return { text: "", parsed: null }; }
            try {
                const vParsed = typeof vRaw === "string" ? JSON.parse(vRaw) : vRaw;
                return { text: JSON.stringify(vParsed, null, 2), parsed: vParsed };
            } catch (e) {
                // Non e' JSON: si mostra com'e'. Un corpo non parsabile e' spesso proprio quello
                // che spiega il guasto (una pagina d'errore, un testo del gateway).
                return { text: String(vRaw), parsed: null };
            }
        };
        const oRequest = pretty(oTrace && oTrace.request);
        const oResponse = pretty(oTrace && oTrace.response);
        let iStatus = (oTrace && oTrace.status) || null;
        if (!iStatus && oResponse.parsed && oResponse.parsed.status) {
            iStatus = oResponse.parsed.status;
        }
        return {
            RequestJsonFormatted: oRequest.text,
            ResponseJsonFormatted: oResponse.text,
            ResponseStatus: iStatus,
            ResponseStatusText: iStatus ? ("HTTP " + iStatus) : ""
        };
    }

    return { listSelect, traceUrl, fetchTrace, formatTrace, TRACE_COLUMNS, NUMERIC_KEYS };
});

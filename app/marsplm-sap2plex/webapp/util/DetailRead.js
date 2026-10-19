sap.ui.define([
    // [DETAIL-REREAD] Il confronto e la scelta della riga stanno nel modulo puro: qui c'e' solo
    // l'orchestrazione delle due letture. Modulo puro: node test/routeStash.test.js
    "./RouteStash"
], (RouteStash) => {
    "use strict";

    // ================================================================
    // [DETAIL-REREAD] Se il server non consegna la riga chiesta, la si RILEGGE e la si SCEGLIE.
    //
    // DA DOVE VIENE. Dalla 0041 le tre schede di dettaglio confrontano con la rotta la riga che il
    // server ha servito, e su una prova di disaccordo (`MISMATCH`) rinunciavano: un toast e la
    // scheda vuota. Non mostrare l'oggetto sbagliato e' giusto — da quel modello escono le azioni
    // verso Plex, e il plant sceglie il TENANT su cui si scrive — ma fermarsi la' non e': il vuoto
    // non e' una risposta, e la riga chiesta di solito e' ottenibile con una seconda lettura.
    //
    // IL DIFETTO CHE HA FATTO USCIRE IL MESSAGGIO. Il ripiego del dettaglio ciclo leggeva
    // `Routings?$filter=<tre uguaglianze>&$top=1`, cioe' una COLLECTION: quell'handler applica
    // l'identita' solo su una lettura per chiave, e su una collection l'unico criterio che gira e'
    // una ricerca tollerante in OR («tieni la riga se QUALSIASI campo contiene QUALSIASI termine»),
    // che tiene tutte le righe del gruppo. Con lo spareggio `(Group, Routing, Material) asc`,
    // `$top=1` serviva il materiale piu' BASSO del ciclo. Ora la prima lettura e' per chiave e
    // questo modulo e' la rete che sta sotto.
    //
    // LE TRE REGOLE, che valgono ognuna da sola:
    //
    //  1. UNA RIGA CHE NON CORRISPONDE NON SI MOSTRA MAI. La rilettura serve a trovare quella
    //     giusta, non a rendere accettabile quella sbagliata.
    //  2. LA RILETTURA E' UNA. Si guarda, non si insiste: un ritentativo a ciclo su un server che
    //     risponde male e' rumore che nasconde il difetto invece di dichiararlo.
    //  3. UNA LETTURA FALLITA NON E' UN'ASSENZA. `NOT_FOUND` («ho guardato e non c'e'») e
    //     `READ_FAILED` («non ho potuto guardare») escono distinti, perche' hanno rimedi opposti e
    //     il secondo NON deve leggersi come «questo oggetto non esiste».
    //
    // CHI CHIAMA FORNISCE LA RILETTURA (`recover`), e non e' un dettaglio di stile: la forma
    // affidabile e' diversa per schermata — una collection filtrata sul ciclo e sull'ordine, la
    // action `productDetails` sul materiale, perche' in ONPREM un `$filter` con `Plant` viene
    // spinto su `A_Product`, che non ha quell'elemento (l'eccezione e' dichiarata in
    // test/keyReadGuarded.test.js).
    //
    // Il `console.error` di un disaccordo dice che il difetto e' dell'HANDLER, come fa la rete
    // [KEY-READ] lato server: una rilettura muta trasformerebbe un difetto del server in una
    // lentezza del client.
    //
    // Test: node test/detailRead.test.js
    // ================================================================

    /** Con quale forma la riga e' stata ottenuta. */
    const SHAPE = {
        KEY: "key",                 // la lettura per chiave ha consegnato la riga giusta
        REREAD: "reread",           // la rilettura l'ha trovata e SCELTA
        NONE: "none"                // non c'e' riga: guardare `why`
    };

    /** Perche' non c'e' riga. Sono due cose diverse, con rimedi diversi. */
    const WHY = {
        OK: "OK",
        NOT_FOUND: "NOT_FOUND",     // letto, e la riga chiesta non c'era
        READ_FAILED: "READ_FAILED"  // non si e' potuto guardare: NON e' un'assenza
    };

    // [X-DETAIL-SCOPE] soffitto: un oggetto di un plant FUORI DAL PERIMETRO dell'utente si
    //                  presenta come `NOT_FOUND`, cioe' «questo oggetto non esiste», per un
    //                  oggetto che esiste. Succede solo entrando da un URL digitato o da un
    //                  segnalibro vecchio: dalle liste si aprono solo oggetti in perimetro.
    //                  Il gate FUNZIONA — il dato non esce (feature 0048) — e' la spiegazione a
    //                  essere imprecisa.
    //                  perche' non e' un quarto esito qui: il fuori-perimetro non arriva come un
    //                  rifiuto da riconoscere. La riga semplicemente non c'e' nel risultato, e il
    //                  plant sta nella rotta SOLO per il materiale
    //                  (`detailNavigation/{Product}/{Plant}`): per ordine e ciclo lo si saprebbe
    //                  solo leggendo l'oggetto, che e' cio' che il gate impedisce. Una soluzione
    //                  uniforme non esiste senza portare il perimetro dentro ogni view.
    //                  scade quando: il perimetro dell'utente e' disponibile fuori dalla
    //                  dashboard (un modello condiviso, o `usablePlants()` chiamata dal
    //                  dettaglio), oppure il server comincia a rifiutare le letture per chiave
    //                  fuori perimetro con un codice riconoscibile invece di rendere zero righe.

    /**
     * Una lettura JSON. Un rifiuto e' un ERRORE, non un corpo vuoto: senza questo controllo
     * `r.json()` legge il corpo d'errore e il chiamante lo interpreta come dato.
     * @param {string} sUrl
     * @param {object} [oInit] init di `fetch`
     * @returns {Promise<{ok: boolean, status: number, body: *}>}
     */
    function request(sUrl, oInit) {
        return fetch(sUrl, oInit || { headers: { "Accept": "application/json" } })
            .then((oResponse) => oResponse.json()
                .catch(() => null)
                .then((vBody) => ({ ok: oResponse.ok, status: oResponse.status, body: vBody })))
            .catch((oError) => ({ ok: false, status: 0, body: null, error: oError }));
    }

    /**
     * Le righe di una lettura di collection (o di una action che rende un array).
     * LANCIA su un rifiuto: chi rilegge deve poter distinguere «non c'e'» da «non ho letto».
     * @param {string} sUrl
     * @param {object} [oInit]
     * @returns {Promise<Array<object>>}
     */
    function rows(sUrl, oInit) {
        return request(sUrl, oInit).then((oRead) => {
            if (!oRead.ok) throw new Error("HTTP " + (oRead.status || "?"));
            const vBody = oRead.body;
            if (Array.isArray(vBody)) return vBody;
            if (vBody && Array.isArray(vBody.value)) return vBody.value;
            // Una forma di risposta non riconosciuta NON e' un insieme vuoto: un insieme vuoto
            // direbbe «la riga non esiste», che e' l'affermazione che qui non si puo' fare.
            throw new Error("forma di risposta non riconosciuta");
        });
    }

    /** Le righe di una action POST che rende `{ value: [...] }`. */
    function rowsPost(sUrl, oBody) {
        return rows(sUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify(oBody || {})
        });
    }

    /**
     * La riga di una scheda di dettaglio: per chiave e, se quella non e' la riga chiesta, rileggendo
     * una volta e SCEGLIENDO per chiave.
     *
     * @param {object} oOpts
     * @param {string} oOpts.keyUrl la lettura PER CHIAVE (la strada normale)
     * @param {object} oOpts.routeKeys le chiavi della rotta, cioe' l'identita' dell'oggetto
     * @param {function(): Promise<Array<object>>} [oOpts.recover] la rilettura. Senza di lei non
     *        c'e' rete: l'esito e' `NONE` con il motivo, come prima di questa feature
     * @param {string} [oOpts.label] la schermata, per le righe di console
     * @param {object} [oOpts.init] init di `fetch` per la lettura per chiave (header di lingua)
     * @returns {Promise<{row: object|null, shape: string, why: string, note: string,
     *                    notes: Array<string>}>}
     */
    function one(oOpts) {
        const sLabel = (oOpts && oOpts.label) || "dettaglio";
        const oRouteKeys = (oOpts && oOpts.routeKeys) || {};
        const aNotes = [];
        const done = (oRow, sShape, sWhy) => ({
            row: oRow || null,
            shape: sShape,
            why: sWhy,
            notes: aNotes,
            note: aNotes.join(" | ")
        });

        return request(oOpts.keyUrl, oOpts.init).then((oRead) => {
            if (oRead.ok) {
                const oCheck = RouteStash.check(oRead.body, oRouteKeys);
                if (oCheck.usable) return done(oRead.body, SHAPE.KEY, WHY.OK);
                if (oCheck.reason === RouteStash.REASON.MISSING) {
                    // Assenza di PROVA, non prova di un altro oggetto: una proiezione che non
                    // espone quel campo. Si serve e si dichiara — bloccare su un'assenza
                    // trasformerebbe un cambio di colonne in una schermata bianca.
                    console.warn(RouteStash.describe(sLabel + " (lettura per chiave)", oCheck));
                    return done(oRead.body, SHAPE.KEY, WHY.OK);
                }
                if (oCheck.reason === RouteStash.REASON.MISMATCH) {
                    console.error(RouteStash.describe(sLabel + " (lettura per chiave)", oCheck)
                        + " Il criterio di chiave NON e' stato applicato dall'handler: e' un difetto"
                        + " del server, non un dato assente. Si rilegge e si sceglie la riga.");
                    aNotes.push("la lettura per chiave ha servito la riga di un altro oggetto ("
                        + oCheck.field + "=" + oCheck.actual + ")");
                } else {
                    // NO_KEYS (difetto di codice) oppure un corpo che non e' una riga.
                    console.error(RouteStash.describe(sLabel + " (lettura per chiave)", oCheck));
                    aNotes.push("la lettura per chiave non ha reso una riga");
                }
            } else {
                // Un `404` qui non prova un'assenza: la rete [KEY-READ] lato server trasforma
                // «riga sbagliata» in «riga assente», ed e' proprio il caso in cui rileggere serve.
                aNotes.push("lettura per chiave: HTTP " + (oRead.status || "?"));
                console.warn("[DETAIL-REREAD] " + sLabel + ": la lettura per chiave non ha"
                    + " consegnato la riga (HTTP " + (oRead.status || "?") + "), si rilegge.");
            }

            if (typeof oOpts.recover !== "function") {
                return done(null, SHAPE.NONE, WHY.READ_FAILED);
            }

            // `Promise.resolve().then` e non `oOpts.recover()` diretto: un'eccezione SINCRONA del
            // chiamante uscirebbe da questo `then` e la promessa tornerebbe rifiutata, cioe' il
            // velo della scheda resterebbe acceso per sempre — «non mostra niente» in un'altra
            // forma. Qui ogni strada finisce in un esito dichiarato.
            return Promise.resolve().then(() => oOpts.recover()).then((aRows) => {
                const oPick = RouteStash.pick(aRows, oRouteKeys);
                if (oPick.row) {
                    console.warn("[DETAIL-REREAD] " + sLabel + ": riga ottenuta rileggendo e"
                        + " scegliendo per chiave (" + oPick.matched + " corrispondenti su "
                        + oPick.scanned + ").");
                    aNotes.push("riga ottenuta con la rilettura");
                    return done(oPick.row, SHAPE.REREAD, WHY.OK);
                }
                console.error(RouteStash.describePick(sLabel, oPick, oRouteKeys));
                aNotes.push("rilettura: nessuna delle " + oPick.scanned + " righe corrisponde"
                    + (oPick.near ? " (" + oPick.near + " senza gli zeri iniziali)" : ""));
                return done(null, SHAPE.NONE, WHY.NOT_FOUND);
            }).catch((oError) => {
                console.error("[DETAIL-REREAD] " + sLabel + ": rilettura non riuscita:",
                    oError && oError.message);
                aNotes.push("rilettura non riuscita: " + ((oError && oError.message) || "?"));
                return done(null, SHAPE.NONE, WHY.READ_FAILED);
            });
        });
    }

    return { SHAPE: SHAPE, WHY: WHY, request: request, rows: rows, rowsPost: rowsPost, one: one };
});

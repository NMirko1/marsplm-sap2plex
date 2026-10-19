sap.ui.define([], function () {
    "use strict";

    /**
     * [ACTION-RESULT] L'esito di una action non e' «quello che torna da `r.json()`».
     *
     * PERCHE' ESISTE. Le action del cockpit erano chiamate cosi':
     *
     *     fetch(...).then(r => r.json()).then(result => applica(result)).catch(() => toast("Riprova"))
     *
     * Manca `r.ok`, e da quella mancanza nascono DUE difetti opposti che si mascherano a vicenda:
     *
     *   1. un errore APPLICATIVO non arriva mai nel `.catch`. CAP risponde `400`/`500` con un corpo
     *      JSON `{"error":{"code","message"}}`: `r.json()` risolve, il flusso va nel ramo RIUSCITO, e
     *      `applica()` riceve un oggetto senza `assignments`. Su `_applyAutoAssignments` questo
     *      significava svuotare le righe automatiche di TUTTE le operazioni, mettere `/dirty` a true
     *      e dichiarare «0 assegnati» con un `MessageBox.information`: un errore che si presenta come
     *      esito riuscito, con l'albero gia' pronto da salvare. Il messaggio del server — che dice
     *      cosa correggere — veniva buttato via.
     *
     *   2. nel `.catch` ci finisce SOLO cio' che non e' JSON, cioe' un guasto di trasporto o un
     *      `401` con corpo HTML. Sono due cose diverse con rimedi diversi, e l'utente leggeva la
     *      stessa frase per entrambe: «Auto-Assegna non riuscito. Riprova.».
     *
     * IL CASO CHE HA MOTIVATO IL MODULO (14/09/2026, plant 07, ciclo 07NPE079/01). La destination
     * `srv-api` del modulo approuter non dichiarava `timeout`, quindi valeva il default della
     * libreria: 30 s, poi `504`. L'auto-assegnazione costa ~20 s a freddo; con un secondo utente che
     * inviava un ciclo a Plex sulla stessa istanza la classificazione e' passata da 2,9 s a 43,5 s,
     * l'approuter ha tagliato a 30 s e l'utente ha letto «Riprova.» — mentre il server e' andato
     * avanti e ha prodotto l'esito GIUSTO (34/34) per nessuno. La frase non diceva ne' che era un
     * taglio di tempo, ne' che l'albero era rimasto intatto, ne' quanto era durato.
     *
     * COSA DECIDE QUESTO MODULO, E COSA NO. Decide di che SPECIE e' l'esito; non sceglie i testi e
     * non tocca nessun modello. La mappa specie -> chiave i18n sta nel controller, perche' e' la
     * frase che cambia da action a action mentre la classificazione no.
     *
     * IL `401` NON SI ANNUNCIA DA QUI. `SessionGuard` (feature 0034) patcha `fetch` e intercetta
     * GIA' ogni `401` same-origin, aprendo il suo dialogo — che con modifiche aperte non ricarica e
     * offre di riconnettersi. Un secondo messaggio nostro sopra quello direbbe la stessa cosa con
     * parole peggiori e coprirebbe l'unico dialogo che sa cosa fare. Qui il `401` si riconosce solo
     * per NON toccare l'albero e per non mostrare niente: `AUTH` e' una specie muta.
     *
     * Nessuna dipendenza UI5 (`sap.ui.define([])`), come CompSource.js e columnSortRules.js: cosi'
     * `classify` si carica da node e si collauda (`node test/actionResult.test.js`). `read` e' la
     * sola parte impura — legge il corpo della risposta — ed e' tre righe attorno a `classify`.
     *
     * Perimetro: grep -rn "ACTION-RESULT"
     */

    /**
     * Le specie di esito. Sono quattro perche' quattro sono i rimedi:
     *
     *   OK        -> il server ha risposto con un risultato utilizzabile. L'unica su cui si applica.
     *   APP       -> il server ha detto di no, e ha detto PERCHE'. Si mostra il suo messaggio.
     *   AUTH      -> sessione scaduta o accesso negato. Muta: ci pensa SessionGuard.
     *   TRANSPORT -> la risposta non e' arrivata (rete caduta, taglio per tempo, corpo non JSON).
     *                Il server puo' aver lavorato lo stesso: non si sa, e si dichiara cosi'.
     *   SHAPE     -> `200` con un corpo che non e' l'esito atteso. Non si applica, si dichiara.
     */
    var KIND = {
        OK: "OK",
        APP: "APP",
        AUTH: "AUTH",
        TRANSPORT: "TRANSPORT",
        SHAPE: "SHAPE"
    };

    /** Stringa spogliata; `null`/`undefined` diventano stringa vuota, mai "null". */
    function str(vValue) {
        if (vValue === null || vValue === undefined) return "";
        return String(vValue).trim();
    }

    /**
     * Il messaggio che il server ha messo nel corpo, nelle due forme che CAP produce.
     *
     * `{"error":{"message":"..."}}` e' la forma OData V4 di ogni errore CAP. La seconda forma —
     * `message` in testa — non e' teorica: e' quella che esce da un errore serializzato a mano, e
     * accettarne una sola vorrebbe dire buttare via il messaggio proprio quando c'e'.
     */
    function serverMessage(oBody) {
        if (!oBody || typeof oBody !== "object") return "";
        if (oBody.error && str(oBody.error.message)) return str(oBody.error.message);
        if (str(oBody.message)) return str(oBody.message);
        return "";
    }

    /**
     * La specie di un esito, da fatti gia' osservati. Pura: nessuna `Response`, nessuna rete.
     *
     * @param {object} o
     * @param {boolean} o.ok        `Response.ok`
     * @param {number}  o.status    codice HTTP (0 se la richiesta non e' mai partita)
     * @param {*}       o.body      il corpo gia' letto (oggetto se JSON, altrimenti `null`)
     * @param {boolean} o.parsed    `true` se il corpo era JSON valido
     * @param {function} [o.isResult] predicato di forma sul corpo; assente = «qualunque oggetto va»
     * @returns {{kind: string, status: number, message: string, body: *}}
     */
    function classify(o) {
        var oArgs = o || {};
        var iStatus = Number(oArgs.status) || 0;
        var oBody = oArgs.body;
        var bParsed = oArgs.parsed === true;

        // L'autenticazione viene PRIMA della forma del corpo: un `401` puo' arrivare come HTML
        // (l'approuter non fa il redirect su una XHR) o come JSON, e in entrambi i casi la specie
        // e' la stessa. Fondendolo con TRANSPORT si perderebbe l'unico caso che deve restare muto.
        if (iStatus === 401 || iStatus === 403) {
            return { kind: KIND.AUTH, status: iStatus, message: serverMessage(oBody), body: oBody };
        }

        if (!bParsed) {
            // Corpo illeggibile. Se lo stato e' buono e' una forma ignota; se e' cattivo — o se non
            // c'e' proprio (status 0: la `fetch` non e' mai arrivata a una risposta) — il messaggio
            // e' andato perso per strada, ed e' un guasto di trasporto.
            // Il `504` dell'approuter per scadenza cade QUI: corpo non JSON, stato cattivo.
            if (oArgs.ok === true && iStatus) {
                return { kind: KIND.SHAPE, status: iStatus, message: "", body: oBody };
            }
            return { kind: KIND.TRANSPORT, status: iStatus, message: "", body: oBody };
        }

        if (oArgs.ok !== true) {
            return { kind: KIND.APP, status: iStatus, message: serverMessage(oBody), body: oBody };
        }

        // `200` con corpo JSON: resta da guardare se e' l'esito che il chiamante sa applicare. Un
        // `{"error":{...}}` con stato 200 non esiste in CAP, ma se esistesse non sarebbe un esito:
        // per questo il controllo di forma viene comunque fatto, e non si guarda solo `ok`.
        var fnIsResult = typeof oArgs.isResult === "function" ? oArgs.isResult : null;
        if (fnIsResult ? !fnIsResult(oBody) : !(oBody && typeof oBody === "object")) {
            return { kind: KIND.SHAPE, status: iStatus, message: serverMessage(oBody), body: oBody };
        }

        return { kind: KIND.OK, status: iStatus, message: "", body: oBody };
    }

    /**
     * Legge una `Response` e ne rende la specie. Non lancia MAI su uno stato HTTP: chi chiama
     * decide cosa fare, e un `throw` qui rimetterebbe tutto dentro un `.catch` unico — cioe' il
     * difetto che questo modulo esiste per togliere.
     *
     * @param {Response} oResponse
     * @param {function} [fnIsResult] predicato di forma sul corpo
     */
    function read(oResponse, fnIsResult) {
        var bParsed = false;
        return oResponse.json()
            .then(function (oBody) { bParsed = true; return oBody; })
            .catch(function () { return null; })
            .then(function (oBody) {
                return classify({
                    ok: oResponse.ok,
                    status: oResponse.status,
                    body: oBody,
                    parsed: bParsed,
                    isResult: fnIsResult
                });
            });
    }

    /**
     * La specie di una `fetch` che ha RIGETTATO: rete caduta, CORS, connessione chiusa. Non c'e'
     * nessuna risposta da guardare, quindi `status` e' 0.
     */
    function fromNetworkError(oError) {
        return {
            kind: KIND.TRANSPORT,
            status: 0,
            message: str(oError && oError.message),
            body: null
        };
    }

    /** Vero solo sulla specie su cui si puo' applicare il risultato. */
    function isOk(oOutcome) {
        return !!oOutcome && oOutcome.kind === KIND.OK;
    }

    return {
        KIND: KIND,
        classify: classify,
        read: read,
        fromNetworkError: fromNetworkError,
        isOk: isOk,
        serverMessage: serverMessage
    };
});

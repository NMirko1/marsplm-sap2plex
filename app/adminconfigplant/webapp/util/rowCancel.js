sap.ui.define([], () => {
    "use strict";

    /**
     * [ROW-CANCEL] Il rifiuto che arriva quando una riga transiente viene cancellata prima di
     * partire.
     *
     * PERCHE' QUESTO MODULO ESISTE. Cancellare una riga appena aggiunta, o premere Annulla, fa
     * annullare a UI5 la `POST` che non e' ancora partita — e l'annullamento non e' silenzioso: e'
     * un RIFIUTO su una promessa. Se nessuno la raccoglie il browser stampa
     *
     *   Uncaught (in promise) Error: Request canceled: POST ObjectGroups; group: objGroupChanges
     *
     * Non si rompe niente: la riga sparisce, l'Annulla annulla, il Salva salva. Ma e' rumore nella
     * CONSOLE, che in questo progetto e' la superficie diagnostica — `window.isCalls()`,
     * `window.plexCalls()`, `[IS-CALL-LOG]`. Un gesto ordinario che stampa un errore rosso insegna
     * a ignorare il rosso, ed e' il modo in cui il difetto vero, il giorno dopo, passa inosservato.
     *
     * IL RIFIUTO E' PREVISTO, E LO DICHIARA SAP. In `_Requestor#cancelChangesByFilter` UI5 ci mette
     * sopra un marcatore:
     *
     *     oError = new Error("Request canceled: " + method + " " + url + "; group: " + groupId);
     *     oError.canceled = true;
     *
     * e il JSDoc di `Context#created()` lo mette per iscritto: «It is rejected with an Error
     * instance where `oError.canceled === true` if the transient entity is deleted before it is
     * created in the back end, for example via #delete, ODataListBinding#resetChanges or
     * ODataModel#resetChanges». Raccoglierlo e' a carico del chiamante — cioe' nostro.
     *
     * LE PROMESSE SONO DUE, e vanno coperte entrambe: `oContext.created()` sul gesto di aggiunta, e
     * quella resa da `oContext.delete(gruppo)` sul gesto di cancellazione. I `resetChanges()` non
     * si toccano: non restituiscono niente, e il rifiuto che provocano arriva sulle `created()`.
     *
     * TRE DECISIONI, e ognuna ha un modo silenzioso di andare storta:
     *
     *   1. `=== true` E NON «TRUTHY». E' il marcatore che UI5 mette, e solo quello. Un confronto
     *      lasco ingoierebbe un errore estraneo che si portasse dietro un `canceled` truthy — cioe'
     *      proprio la classe di difetti che questo modulo esiste per non creare.
     *
     *   2. SI ASSORBE SOLO IL `canceled`. Tutto il resto esce in console col tag: una cancellazione
     *      che fallisce DAVVERO (riga gia' salvata, il server rifiuta) oggi e' muta lo stesso — una
     *      riga rossa e nient'altro — quindi non si perde niente, ma smette di essere
     *      indistinguibile dal rumore. Limite dichiarato: resta senza messaggio a schermo, ed e'
     *      una decisione presa e non una dimenticanza.
     *
     *   3. NON SI AVVOLGE `create()`. E' la trappola vera. `ODataListBinding#create` prende fino a
     *      quattro argomenti, e la scheda notifiche job si appoggia al quarto:
     *      `create({…}, false, false, true)`, dove `bInactive: true` fa si' che la riga NON sia una
     *      pending change finche' qualcuno non ci scrive — senza, quella scheda salverebbe righe
     *      vuote per distrazione. Un wrapper `create(oBinding, oData)` lascerebbe cadere quel
     *      quarto argomento in SILENZIO. Quindi la chiamata nativa resta intatta e il wrapper le
     *      sta INTORNO:
     *
     *          RowCancel.watchCreate(oBinding.create({ … }, false, false, true));
     *
     * Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, cosi' la regola si collauda
     * da node (`node test/rowCancel.test.js`) come i moduli puri di `srv/lib/`.
     *
     * Perimetro: `grep -rn "ROW-CANCEL"`.
     */

    const TAG = ">>> [ROW-CANCEL]";

    /**
     * L'errore e' l'annullamento di una richiesta che non era ancora partita?
     *
     * @param {Error} [oError] l'errore con cui la promessa e' stata rifiutata
     * @returns {boolean} vero solo sul marcatore che UI5 dichiara
     */
    function isCanceled(oError) {
        return !!oError && oError.canceled === true;
    }

    /**
     * Aggancia un raccoglitore alla promessa, e la restituisce invariata.
     *
     * `sWhat` finisce nella riga di console: senza, un errore che passa di qui non direbbe da quale
     * dei due gesti viene.
     */
    function absorb(oPromise, sWhat) {
        if (!oPromise || typeof oPromise.catch !== "function") { return oPromise; }
        oPromise.catch((oError) => {
            if (isCanceled(oError)) { return; }
            console.error(TAG + " " + sWhat + " fallita", oError);
        });
        return oPromise;
    }

    return {

        isCanceled,

        /**
         * Il contesto di una riga appena creata, con la sua `created()` raccolta.
         *
         * Restituisce IL CONTESTO e non la promessa, perche' meta' dei call site lo usano — per
         * aprire il dettaglio, o per tenerlo in uno stato del controller.
         *
         * @param {Object} [oContext] quello che `ODataListBinding#create` ha appena reso
         * @returns {Object} lo stesso contesto, invariato
         */
        watchCreate(oContext) {
            if (oContext && typeof oContext.created === "function") {
                absorb(oContext.created(), "creazione riga");
            }
            return oContext;
        },

        /**
         * La promessa di una cancellazione, raccolta e restituita.
         *
         * @param {Promise} [oPromise] quella che `Context#delete` ha appena reso
         * @returns {Promise} la stessa promessa, invariata
         */
        watchDelete(oPromise) {
            return absorb(oPromise, "cancellazione riga");
        }
    };
});

sap.ui.define([], () => {
    "use strict";

    /**
     * [ROW-UNSAVED] Quali righe di una tabella editabile non sono ancora salvate, e di che colore.
     *
     * PERCHE' QUESTO MODULO ESISTE. Nelle schede Gruppi e Auto-assegnazione una riga aggiunta,
     * copiata o modificata era indistinguibile da una gia' salvata: la si riconosceva solo
     * ricordandosi cosa si era toccato. Su una copia di gruppo — che nasce in testa all'elenco con
     * un `GroupId` duplicato da rinominare — non c'era niente a schermo che lo dicesse.
     *
     * «NON SALVATA» E' UNA PAROLA SOLA PER DUE COSE, e la domanda si fa AL CONTESTO della riga:
     * transiente (nuova, mai inviata) OPPURE con modifiche pendenti (gia' sul server, ma toccata).
     *
     * PERCHE' AL CONTESTO E NON A UN BINDING. La prima versione di questa feature legava
     * l'annotazione `@$ui5.context.isTransient` dentro un binding composito, piu' una mappa delle
     * righe sporche indicizzata per `ID`. Non ha colorato NIENTE — nemmeno una riga aggiunta da
     * zero, che e' transiente per costruzione. Quella strada poggiava su tre premesse che non
     * avevo mai eseguito: che l'annotazione rendesse un valore dentro una PARTE di binding, che
     * l'`ID` fosse disponibile su ogni riga, e che la mappa arrivasse al formatter.
     *
     * Questi due predicati invece sono MISURATI: `onCopyObjectGroup` li usa gia' — la stessa coppia,
     * sugli stessi contesti — e sullo schermo dell'utente ha rifiutato di copiare una riga
     * dichiarandola «con modifiche non salvate». Cio' che e' gia' provato batte cio' che e' solo
     * dedotto.
     *
     * DUE DECISIONI, e ognuna ha un modo silenzioso di andare storta:
     *
     *   1. `highlightFor` RENDE SOLO 'Warning' O 'None'. `ListItemBase#setHighlight` LANCIA su un
     *      valore che non sia dell'enum («"x" is not a value of the enums …»), quindi rendere `''`
     *      o `'warning'` minuscolo non darebbe una riga scolorita: abbatterebbe la tabella. `null`
     *      e `undefined` li tollera invece (li porta a `None`), e questo rende il difetto
     *      INTERMITTENTE — si vedrebbe solo sulla combinazione che rende la stringa sbagliata. Per
     *      questo il valore si dichiara qui e lo fissa un test.
     *
     *   2. I `typeof` SULLE API DEL CONTESTO, come gia' fanno `onCopyObjectGroup` e
     *      `_getAutoAssignRows`: e' l'idioma del repo per un'API che potrebbe non esserci. Senza,
     *      un contesto non ancora caricato farebbe cadere la marcatura dell'INTERA tabella, cioe'
     *      spegnerebbe il colore su tutte le righe invece che su una.
     *
     * Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, cosi' la regola si collauda da
     * node (`node test/unsavedRows.test.js`) come i moduli puri di `srv/lib/`.
     *
     * Perimetro: `grep -rn "ROW-UNSAVED"`.
     */

    /** I due soli valori che `ListItemBase#setHighlight` accetta da noi. */
    const MARKED = "Warning";
    const CLEAN = "None";

    function can(oContext, sMethod) {
        return !!oContext && typeof oContext[sMethod] === "function";
    }

    return {

        MARKED,
        CLEAN,

        /**
         * La riga di questo contesto non e' ancora sul server?
         *
         * Le due meta' sono in OR e non si fondono: una riga transiente non ha modifiche pendenti
         * *in quanto* modifiche — e' tutta quanta una modifica pendente — e una riga sporca non e'
         * transiente. Chiedere una sola delle due lascerebbe meta' delle righe senza colore.
         *
         * @param {Object} [oContext] un `sap.ui.model.odata.v4.Context`
         * @returns {boolean} vero se la riga e' nuova OPPURE modificata e non salvata
         */
        isUnsaved(oContext) {
            if (can(oContext, "isTransient") && oContext.isTransient() === true) { return true; }
            return can(oContext, "hasPendingChanges") && oContext.hasPendingChanges() === true;
        },

        /**
         * Il valore della proprieta' `highlight` della riga di questo contesto.
         *
         * Rende SEMPRE una delle due costanti: `setHighlight` lancia su qualunque altra stringa, e
         * un `undefined` di ritorno diventerebbe `None` in silenzio — cioe' una riga che dovrebbe
         * essere colorata e non lo e', senza niente che lo segnali.
         *
         * @param {Object} [oContext] un `sap.ui.model.odata.v4.Context`
         * @returns {string} `'Warning'` o `'None'`, mai altro
         */
        highlightFor(oContext) {
            return this.isUnsaved(oContext) ? MARKED : CLEAN;
        }
    };
});

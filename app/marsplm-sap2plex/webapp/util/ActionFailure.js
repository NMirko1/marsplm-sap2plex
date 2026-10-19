sap.ui.define([], () => {
    "use strict";

    // ================================================================
    // [ACTION-RESULT] Un INVIO che non e' riuscito: quale frase, e quando tacere.
    //
    // PERCHE' ESISTE, ACCANTO AD ActionResult. Quel modulo dice di che SPECIE e' l'esito; questo
    // dice cosa se ne mostra. Sono due cose separate perche' la specie e' la stessa per tutti,
    // mentre la frase cambia con l'operazione: dopo un taglio per tempo l'auto-assegnazione deve
    // dire «l'albero non e' stato modificato», un invio a Plex deve dire «puo' essere riuscito lo
    // stesso, guarda lo storico». Le chiavi arrivano quindi da fuori.
    //
    // PERCHE' NON E' UNA FUNZIONE PRIVATA DEI CONTROLLER. Gli invii lenti sono QUATTRO, in quattro
    // file diversi (ciclo, job dell'ordine, materiale singolo, invio massivo). Quattro copie di
    // questa scaletta divergono al primo ritocco, ed e' esattamente il modo in cui il difetto e'
    // tornato due volte nello stesso giorno.
    //
    // LA SCALETTA, e ogni riga e' una decisione:
    //
    //   AUTH      -> MUTA. La sessione scaduta la annuncia SessionGuard (feature 0034), col dialogo
    //                che sa anche cosa fare delle modifiche aperte. Un secondo messaggio sopra
    //                direbbe la stessa cosa con parole peggiori e coprirebbe quello giusto.
    //   APP       -> il messaggio DEL SERVER. E' l'unico testo che dice cosa correggere, e finora
    //                era quello che veniva buttato via.
    //   TRANSPORT -> «non lo so», coi secondi. NON e' un fallimento: la richiesta e' stata tagliata
    //                dal gateway, non rifiutata dal server, e cio' che il server stava facendo — su
    //                Plex, una scrittura — puo' essere andato a termine. Il testo deve dirlo e NON
    //                deve invitare a ripetere: un reinvio cieco duplica.
    //   SHAPE e   -> la frase generica. Non si inventa una diagnosi che non si ha, e non si TACE:
    //   ignoto       il silenzio su un esito non riuscito e' il difetto peggiore, perche' l'utente
    //                vede solo il velo spegnersi.
    //
    // `isInconclusive` e' separata dal testo perche' decide un'altra cosa: se lo storico si puo'
    // rileggere subito. Su un taglio per tempo no — il server sta ancora lavorando, e una lettura
    // fatta adesso rende zero righe, che si legge come «mai inviato». E' il divieto [DETAIL-RESET]:
    // vuoto non e' ignoto.
    //
    // Nessuna dipendenza UI5: si carica da node e si collauda con node test/actionResult.test.js.
    // Perimetro: grep -rn "ACTION-RESULT"
    // ================================================================

    /**
     * La frase da mostrare per un esito non riuscito.
     *
     * @param {{kind: string, status: number, message: string}} oOutcome  da ActionResult
     * @param {number} iElapsedMs  quanto e' durata la richiesta: senza un numero «interrotto» non
     *                             distingue «la rete e' caduta subito» da «ci ha messo troppo»
     * @param {object} oBundle     il ResourceBundle di chi chiama
     * @param {{generic: string, interrupted: string}} mKeys  le due chiavi i18n dell'operazione
     * @returns {{silent: boolean, text: string}}
     */
    function text(oOutcome, iElapsedMs, oBundle, mKeys) {
        const sKind = (oOutcome && oOutcome.kind) || "";
        const sServer = (oOutcome && oOutcome.message) || "";
        const mK = mKeys || {};

        if (sKind === "AUTH") { return { silent: true, text: "" }; }

        if (sKind === "APP") {
            return { silent: false, text: sServer || oBundle.getText(mK.generic) };
        }

        if (sKind === "TRANSPORT") {
            // Almeno un secondo: «interrotto dopo 0 secondi» si legge come un difetto del
            // messaggio, non come un guasto.
            const iSec = Math.max(1, Math.round((Number(iElapsedMs) || 0) / 1000));
            return { silent: false, text: oBundle.getText(mK.interrupted, [iSec]) };
        }

        return { silent: false, text: oBundle.getText(mK.generic) };
    }

    /**
     * Vero quando l'esito NON dice cosa sia successo sul sistema esterno.
     * Chi chiama lo usa per NON rileggere subito lo storico dell'oggetto: il server puo' essere
     * ancora al lavoro, e zero righe lette adesso si leggono come «mai inviato».
     * @param {{kind: string}} oOutcome
     * @returns {boolean}
     */
    function isInconclusive(oOutcome) {
        return !!oOutcome && oOutcome.kind === "TRANSPORT";
    }

    return { text, isInconclusive };
});

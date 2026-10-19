sap.ui.define([], () => {
    "use strict";

    /**
     * [AA-GROUP-VH] Le voci della tendina «Gruppo» dell'assegnazione automatica.
     *
     * PERCHE' QUESTO MODULO ESISTE. Il gruppo di una riga di `ZCycleAutoAssignConfig` si digitava a
     * mano, e a valle viene confrontato per STRINGA ESATTA (`configKey` in
     * `srv/lib/autoAssignRules.js`: nessun trim, nessun case folding). Un refuso non da' un errore
     * ne' alla scrittura ne' al run: da' una riga di configurazione INERTE — il componente
     * semplicemente non viene collocato, e la riga a schermo sembra a posto. La tendina chiude
     * quella strada, e la regola di COSA mostrare sta qui invece che nel controller perche' e'
     * l'unica meta' della feature che si puo' collaudare senza un browser.
     *
     * LE DUE DECISIONI CHE QUESTO MODULO CODIFICA, e che il controller si limita a eseguire:
     *
     *   1. la voce e' «CODICE - Descrizione», cioe' la stessa forma della tendina delle operazioni
     *      Plex che le sta a fianco (`_loadPlexOperations`), mentre cio' che si salva e' il SOLO
     *      codice. Da qui discende che il filtro per sottostringa di `comboBoxContains` cerca anche
     *      nella descrizione senza che nessuno debba dichiararlo;
     *
     *   2. un codice IN USO su una riga ma non fra i gruppi configurati del plant entra comunque
     *      nell'elenco, in CODA e marcato. Sono due i casi che ci arrivano — il refuso storico e il
     *      gruppo cancellato dopo — piu' un terzo che non e' un dato ma un guasto: la lettura dei
     *      gruppi caduta, dove `configured` e' vuoto e la coda e' tutto cio' che resta. In tutti e
     *      tre la cella mostra il codice che c'e' scritto: una cella VUOTA si legge come «mai
     *      compilato», che e' l'affermazione opposta.
     *
     * Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, come
     * `util/comboBoxContains.js`. E' cio' che permette a `node test/groupValueHelp.test.js` di
     * eseguirlo con un `sap.ui.define` finto invece di simulare il loader di UI5. Per la stessa
     * ragione comparatore ed etichetta dei fuori elenco ARRIVANO COME ARGOMENTI: il primo vive in
     * `columnSortRules.js` (un modulo), la seconda nel bundle i18n (una risorsa del browser).
     */

    /** Il separatore fra codice e descrizione, lo stesso della tendina delle operazioni Plex. */
    const SEP = " - ";

    /** Testo ripulito, o stringa vuota: `null` e `undefined` non devono finire nell'etichetta. */
    function text(vValue) {
        return String(vValue === null || vValue === undefined ? "" : vValue).trim();
    }

    /**
     * Una riga `ObjectGroups` diventa una voce della tendina.
     *
     * La descrizione e' facoltativa sullo schema (`Description` non e' `not null`), quindi senza
     * descrizione il testo e' il SOLO codice: un `«ABC - »` con la coda vuota si legge come un dato
     * troncato.
     *
     * @param {{GroupId: string, Description: string}} oRow riga letta da `/ObjectGroups`
     * @returns {{key: string, text: string}|null} la voce, oppure `null` se la riga non ha codice
     */
    function entryFor(oRow) {
        const sKey = text(oRow && oRow.GroupId);
        if (!sKey) {
            // Un gruppo senza codice non e' scegliibile: `selectedKey` vuoto e' gia' il valore
            // «nessuna scelta», quindi una voce cosi' sarebbe una riga che non si puo' selezionare.
            return null;
        }
        const sDescription = text(oRow && oRow.Description);
        return { key: sKey, text: sDescription ? (sKey + SEP + sDescription) : sKey };
    }

    /**
     * Le voci dei gruppi CONFIGURATI del plant, ordinate.
     *
     * Deduplica sul codice benche' `@assert.unique.plantGroup` lo garantisca gia': la lettura e'
     * filtrata per plant da un chiamante, e un filtro dimenticato porterebbe qui i gruppi di piu'
     * plant — due voci con lo stesso codice e descrizioni diverse, fra cui l'utente non puo'
     * scegliere. Vince la PRIMA, perche' l'ordine di arrivo e' quello del server.
     *
     * @param {Array<Object>} aRows righe lette da `/ObjectGroups`
     * @param {function(string, string): number} fnCompare comparatore di due TESTI (da
     *        `columnSortRules.comparatorFor`: e' il collatore unico del progetto, DEC-102)
     * @returns {Array<{key: string, text: string}>} voci ordinate sul testo che l'utente legge
     */
    function buildConfigured(aRows, fnCompare) {
        const mSeen = new Map();

        (Array.isArray(aRows) ? aRows : []).forEach((oRow) => {
            const oEntry = entryFor(oRow);
            if (oEntry && !mSeen.has(oEntry.key)) {
                mSeen.set(oEntry.key, oEntry);
            }
        });

        const aEntries = Array.from(mSeen.values());
        // Si ordina sul TESTO e non sul codice: e' il criterio di `plexOpSortKey` — la chiave di
        // ordinamento e' l'etichetta che l'utente legge — e qui le due cose coincidono quasi
        // sempre, perche' il testo comincia col codice. «Quasi»: due gruppi con lo stesso codice
        // non esistono, quindi la descrizione non arriva mai a decidere.
        if (typeof fnCompare === "function") {
            aEntries.sort((a, b) => fnCompare(a.text, b.text));
        }
        return aEntries;
    }

    /**
     * L'elenco completo: i gruppi configurati, piu' in CODA i codici in uso che non vi compaiono.
     *
     * IDEMPOTENTE PER COSTRUZIONE: la coda si ricostruisce ogni volta da `aConfigured` e dai codici
     * passati, non si appende a un elenco precedente. Il chiamante la rifa' a ogni `updateFinished`
     * della tabella — che scatta a ogni crescita, aggiunta, copia e riordino — quindi un accumulo
     * darebbe una tendina che si allunga da sola, con la stessa voce ripetuta.
     *
     * La coda sta IN FONDO e non al suo posto alfabetico: e' un'anomalia, e un'anomalia mescolata
     * alle voci buone non si distingue da una voce buona.
     *
     * @param {Array<{key: string, text: string}>} aConfigured le voci dei gruppi configurati
     * @param {Array<string>} aUsedCodes i codici `ComponentGroup` presenti sulle righe a schermo
     * @param {function(string): string} fnUnknownText da un codice al suo testo di fuori elenco
     * @returns {Array<{key: string, text: string, unknown?: boolean}>} l'elenco per la tendina
     */
    function mergeUnknown(aConfigured, aUsedCodes, fnUnknownText) {
        const aBase = Array.isArray(aConfigured) ? aConfigured : [];
        const oKnown = new Set(aBase.map((oEntry) => oEntry && oEntry.key));

        const mTail = new Map();
        (Array.isArray(aUsedCodes) ? aUsedCodes : []).forEach((vCode) => {
            const sCode = text(vCode);
            // Il codice vuoto NON entra: una riga appena aggiunta nasce con `ComponentGroup: ''`, e
            // una voce a chiave vuota renderebbe la tendina «gia' compilata» su ogni riga nuova.
            if (sCode && !oKnown.has(sCode) && !mTail.has(sCode)) {
                mTail.set(sCode, {
                    key: sCode,
                    text: typeof fnUnknownText === "function" ? fnUnknownText(sCode) : sCode,
                    unknown: true
                });
            }
        });

        return aBase.concat(Array.from(mTail.values()));
    }

    return { entryFor, buildConfigured, mergeUnknown };
});

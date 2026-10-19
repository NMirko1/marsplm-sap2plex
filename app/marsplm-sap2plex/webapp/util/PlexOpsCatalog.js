sap.ui.define([], () => {
    "use strict";

    /**
     * [PLEX-OP-TYPE-FILTER] Il catalogo operazioni Plex per i tre dialoghi «Aggiungi Operazioni».
     *
     * PERCHE' UN MODULO. Il dialog e' lo stesso fragment aperto da tre controller — dettaglio
     * ciclo, dettaglio ordine, template ciclo — e `_fetchPlexOperations` era copiato identico in
     * tutti e tre. Finche' era «fetch, prendi `data.value`, mettilo nel modello» la copia costava
     * poco; ora che l'action risponde con una BUSTA da interpretare (feature 0024) sarebbero tre
     * punti da riallineare a mano, e il prossimo consumatore si dimenticherebbe di uno — che e'
     * esattamente la ragione per cui l'ordinamento e il filtro stanno in un punto solo lato server.
     *
     * COSA C'E' DA INTERPRETARE. Un elenco vuoto ha ora DUE cause con rimedi opposti — il filtro
     * per tipo del plant non aggancia niente, oppure Plex non ha risposto — e a schermo sono la
     * stessa tendina vuota. Distinguerle e' tutto il lavoro di `noticeFor`: senza, si ripete il
     * difetto della tenda vuota di DEC-81, dove un elenco vuoto si legge come «questa operazione
     * non esiste».
     *
     * Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, cosi' le regole si collaudano
     * da node (`node test/plexOpsCatalog.test.js`) come i moduli puri di `srv/lib/`. Se un giorno gli
     * si aggiungesse una dipendenza UI5, quel test smetterebbe di poter caricare il modulo: e' il
     * segnale che le regole non sono piu' pure.
     */

    /** La busta vuota, nella forma dell'action. Un guasto non e' un elenco vuoto: e' `readOk: false`. */
    function emptyEnvelope(sMessage) {
        return {
            operations: [],
            readOk: false,
            message: sMessage || "",
            filterScope: "",
            filterTypes: "",
            filterConfigured: false,
            total: 0,
            kept: 0,
            droppedNoType: 0
        };
    }

    /**
     * Normalizza la risposta dell'action.
     *
     * Riconosce SOLO la busta: una risposta di forma diversa e' un guasto dichiarato, non un elenco
     * vuoto. Il ripiego «prendi `data.value` se non c'e' `operations`» sarebbe comodo e sbagliato —
     * `value` era la forma di prima della feature, e accettarla vorrebbe dire mostrare un elenco NON
     * filtrato credendolo filtrato.
     */
    function parseEnvelope(oData) {
        if (!oData || !Array.isArray(oData.operations)) {
            return emptyEnvelope("risposta non riconosciuta");
        }
        return Object.assign(emptyEnvelope(""), oData, { readOk: oData.readOk !== false });
    }

    /**
     * Che cosa la schermata deve DICHIARARE, dato l'esito della lettura.
     *
     * @param {object} oEnv busta normalizzata
     * @param {function(string, Array=):string} fnText accesso al resource bundle (chiave, argomenti)
     * @returns {{text: string, type: string}} testo vuoto = niente da dichiarare
     */
    function noticeFor(oEnv, fnText) {
        const oEnvelope = oEnv || emptyEnvelope("");
        const text = (sKey, aArgs) => (typeof fnText === "function" ? fnText(sKey, aArgs) : sKey);

        // 1. Lettura fallita. Ha la precedenza su tutto: qualunque cosa dicesse il filtro, di questo
        //    elenco non si sa niente. E' il ramo che rende «vuoto» leggibile.
        if (!oEnvelope.readOk) {
            return { text: text("dlgOpsReadFailed", [oEnvelope.message || ""]), type: "Error" };
        }

        const bFiltered = !!oEnvelope.filterTypes;

        // 2. Filtro attivo che non aggancia NIENTE. Il caso peggiore, perche' la schermata sembra
        //    dire «sul tenant non ci sono operazioni»: quasi sempre e' un tipo scritto male.
        if (bFiltered && oEnvelope.kept === 0) {
            return {
                text: text("dlgOpsFilteredToZero", [oEnvelope.filterTypes, String(oEnvelope.total)]),
                type: "Warning"
            };
        }

        // 3. Elenco vuoto SENZA filtro: non c'e' niente da spiegare col customizing, il catalogo del
        //    tenant e' vuoto. Si dice comunque, o si legge come un guasto.
        if (!bFiltered && oEnvelope.total === 0) {
            return { text: text("dlgOpsEmptyCatalog"), type: "Warning" };
        }

        // 4. Filtro attivo che aggancia: si dichiara il criterio e quanto ha tolto, cosi' «l'operazione
        //    che cerco non c'e'» ha una risposta senza aprire la configurazione.
        if (bFiltered) {
            const sBase = text("dlgOpsFiltered",
                [oEnvelope.filterTypes, String(oEnvelope.kept), String(oEnvelope.total)]);
            // Le operazioni PRIVE di tipo sono l'unico scarto che chi configura non si aspetta: il
            // filtro non le esclude per il tipo che hanno, le esclude perche' non ne hanno uno.
            const sExtra = oEnvelope.droppedNoType
                ? " " + text("dlgOpsDroppedNoType", [String(oEnvelope.droppedNoType)])
                : "";
            return { text: sBase + sExtra, type: "Information" };
        }

        return { text: "", type: "None" };
    }

    /**
     * La riga aggancia il testo cercato?
     *
     * Si cerca su cio' che si VEDE — codice e tipo, le due colonne del dialog — piu' `name` e
     * `description`, che il contratto Plex non dichiara ma che restano nel payload: cercarli non
     * costa niente e non trovarli non e' un difetto. Sottostringa insensibile a maiuscole e
     * minuscole, come il filtro dei ComboBox della configurazione plant (DEC-81).
     */
    function matchesQuery(oOp, sQuery) {
        const sNeedle = String(sQuery || "").trim().toLowerCase();
        if (!sNeedle) return true;
        if (!oOp || typeof oOp !== "object") return false;
        return ["code", "type", "name", "description"].some((sField) =>
            String(oOp[sField] || "").toLowerCase().indexOf(sNeedle) !== -1);
    }

    /**
     * [APP-URL] Il path dell'action. Sta QUI e non nei tre controller: era la ragione per cui questo
     * modulo esiste, e tre copie divergerebbero.
     */
    const PATH = "/plex/getPlexOperations";

    /**
     * Legge il catalogo per un ambito. Non rifiuta mai: un guasto e' una busta con `readOk: false`.
     *
     * [APP-URL] LA BASE DELL'APP LA PASSA IL CHIAMANTE, come funzione. Servita da Work Zone l'app
     * sta sotto un prefisso di path e un URL assoluto non lo porta, quindi non raggiunge nessuna
     * rotta: il risultato sarebbe una tendina vuota, cioe' esattamente il difetto che `noticeFor`
     * esiste per distinguere. Ma questo modulo NON puo' dipendere da `AppUrl`: e' un
     * `sap.ui.define([])` e `test/plexOpsCatalog.test.js` pretende che lo resti, perche' e' cio'
     * che lo rende eseguibile dallo shim. Quindi il path resta qui, uno solo, e chi chiama
     * consegna `AppUrl.url`.
     *
     * NESSUN RIPIEGO se manca: un default sul path assoluto rimetterebbe il difetto in silenzio nel
     * giorno in cui un quarto chiamante si dimentica il parametro. Si dichiara nella busta.
     *
     * @param {string} sPlant plant di contesto: decide da quale tenant Plex si legge (feature 0020)
     * @param {string} sScope ambito del filtro; qui e' sempre 'CYCLE'
     * @param {function(string):string} fnUrl `AppUrl.url`: da un path all'URL con la base davanti
     * @returns {Promise<object>} busta normalizzata
     */
    function load(sPlant, sScope, fnUrl) {
        if (typeof fnUrl !== "function") {
            return Promise.resolve(emptyEnvelope(
                "[APP-URL] load() richiede AppUrl.url come terzo parametro"));
        }
        return fetch(fnUrl(PATH), {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ Plant: sPlant || "", Scope: sScope || "CYCLE" })
        }).then((res) => {
            // `res.ok` si guarda. Prima non lo guardava nessuno dei tre controller: un 500 finiva
            // dritto in `.json()` e usciva come elenco vuoto senza una parola.
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        }).then(parseEnvelope).catch((err) => emptyEnvelope(err && err.message ? err.message : String(err)));
    }

    return { emptyEnvelope, parseEnvelope, noticeFor, matchesQuery, load, CYCLE_SCOPE: "CYCLE" };
});

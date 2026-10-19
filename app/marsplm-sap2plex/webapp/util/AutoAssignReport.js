sap.ui.define([], () => {
    "use strict";

    // ================================================================
    // [AUTO-ASSIGN] I componenti rimasti fuori, NOMINATI col loro motivo.
    //
    // PERCHE' ESISTE. Il server calcola gia' tutto — `unassigned[].Reason`, i gruppi che avevano
    // agganciato, e per ogni assegnazione l'operazione che la regola indica — e fino all'11/09/2026
    // i due dialoghi di «Auto-Assegna» ne mostravano TRE NUMERI: «3 assegnati, 1 non assegnati, 1
    // saltati». Capire quale componente e perche' e' costato due giri di `cf logs`, e il motivo era
    // in una riga di customizing che nessuno poteva vedere da li'.
    //
    // Il job, sullo stesso identico caso, scrive per esteso «l'operazione indicata dalla regola non
    // esiste nel ciclo — la regola di X punta a Y». Qui si usano LE STESSE CHIAVI i18n: due
    // vocabolari per la stessa causa costringono chi legge a tradurre fra cockpit e recap.
    //
    // PERCHE' STA IN UN UTIL E NON IN UN CONTROLLER. `_applyAutoAssignments` esiste in DUE copie —
    // dettaglio ciclo e dettaglio ordine — e le due usano lo stesso `autoAssignSummary`. Mettere il
    // dettaglio in una delle due e lasciare l'altra muta vuol dire che la prossima diagnosi sul
    // ramo ordini ricomincia da capo; copiarlo in entrambe vuol dire due testi che divergono al
    // primo ritocco. Sta qui una volta sola.
    // ================================================================

    // Lo stesso tetto del recap del job: un elenco che non entra a schermo non si legge, e il
    // numero nella testata dice comunque quanti sono.
    const MAX = 10;

    // I motivi li nomina il job da mesi: si riusano le sue chiavi, non se ne inventano di nuove.
    const REASON_KEY = {
        NO_GROUP: "logRoutingBlockedNoGroup",
        NO_MAPPING: "logRoutingBlockedNoMapping",
        NO_CLFN: "logRoutingBlockedNoClfn",
        NO_PLANT_DATA: "logRoutingBlockedNoPlantData"
    };

    function bullets(aItems, iTotal, oBundle) {
        if (iTotal > MAX) { aItems.push(oBundle.getText("logRoutingBlockedMore", [iTotal - MAX])); }
        return "• " + aItems.join("\n• ");
    }

    /**
     * Il dettaglio da appendere al riepilogo.
     *
     * @param {Array<object>} aUnassigned `{Material, Reason, Groups?}` come li rende il server
     * @param {Array<object>} aSkipped le assegnazioni il cui bersaglio non esiste nel ciclo
     * @param {object} oBundle il resource bundle
     * @returns {string} vuoto quando non c'e' niente da dichiarare — e allora il dialogo resta
     *                   un'informazione invece di un avviso
     */
    function detail(aUnassigned, aSkipped, oBundle) {
        const aOut = (aUnassigned || []).slice();
        const aSkip = (aSkipped || []).slice();
        const aBlocks = [];

        if (aOut.length) {
            const aItems = aOut.slice(0, MAX).map((u) => {
                const sKey = REASON_KEY[u.Reason];
                const sTxt = sKey
                    ? oBundle.getText(sKey, [u.Material])
                    : oBundle.getText("logRoutingBlockedUnknown", [u.Material, u.Reason || ""]);
                // I gruppi che avevano agganciato: senza, «nessuna mappatura» non dice QUALE riga di
                // customizing manca, e si finisce a cercarla fra tutti i gruppi del plant.
                return (u.Groups && u.Groups.length) ? sTxt + " (" + u.Groups.join(", ") + ")" : sTxt;
            });
            aBlocks.push(oBundle.getText("autoAssignUnassignedHead") + "\n" + bullets(aItems, aOut.length, oBundle));
        }

        if (aSkip.length) {
            const aItems = aSkip.slice(0, MAX).map((a) => {
                // Il bersaglio si NOMINA: e' l'unico dato che porta dritti alla riga di customizing
                // da correggere.
                const sTarget = a.TargetOperationName || a.TargetOperation || "";
                return oBundle.getText("logRoutingBlockedNoOperation", [a.Material])
                    + " — " + oBundle.getText("logRoutingBlockedRuleTarget", [a.Material, sTarget]);
            });
            aBlocks.push(oBundle.getText("autoAssignSkippedHead") + "\n" + bullets(aItems, aSkip.length, oBundle));
        }

        return aBlocks.join("\n\n");
    }

    /**
     * [COMP-SOURCE] Le collocazioni a mano che il ricalcolo ha RISPETTATO.
     *
     * PERCHE' NON STA DENTRO `detail`. Quello e' l'elenco di cio' che non e' andato, ed e' il
     * criterio con cui i due dialoghi scelgono fra «avviso» e «informazione»: una riga conservata
     * non e' un problema, e infilata li' dentro trasformerebbe in avviso un'auto-assegnazione
     * perfettamente riuscita. Sono due notizie diverse, quindi due funzioni.
     *
     * Si dichiara comunque, e per esteso: fino all'11/09/2026 il pulsante riportava tutto sotto le
     * regole dopo una conferma, adesso non tocca quelle righe — e un comportamento che cambia senza
     * che nessuno lo dica si legge come un difetto. Il testo porta anche la via per liberarne una,
     * che e' l'unica rimasta.
     *
     * @param {Array<object>} aKept `{Material, TargetOperationName}` delle righe lasciate dov'erano
     * @param {object} oBundle il resource bundle
     * @returns {string} vuoto quando non c'e' niente da dichiarare
     */
    function kept(aKept, oBundle) {
        const aRows = (aKept || []).slice();
        if (!aRows.length) { return ""; }
        const aItems = aRows.slice(0, MAX).map((k) =>
            oBundle.getText("autoAssignKeptRow", [k.Material, k.TargetOperationName || ""]));
        return oBundle.getText("autoAssignKeptHead", [aRows.length])
            + "\n" + bullets(aItems, aRows.length, oBundle);
    }

    /**
     * [ACTION-RESULT] Il messaggio di un'auto-assegnazione NON riuscita, per specie di guasto.
     *
     * Sta qui per la stessa ragione di `detail` e `kept`: la chiamata esiste in due copie — ciclo e
     * ordine — e finora entrambe dicevano la stessa frase per guasti diversi («Auto-Assegna non
     * riuscito. Riprova.»), che e' il modo piu' rapido per far ripartire da capo la diagnosi
     * successiva. Il 14/09/2026 quella frase copriva un `504` per scadenza dell'approuter mentre il
     * server aveva prodotto l'esito giusto: nessuno poteva saperlo dal messaggio.
     *
     * DUE COSE CHE IL TESTO DEVE DIRE E PRIMA NON DICEVA: che l'albero NON e' stato toccato (senza,
     * chi legge non sa se puo' salvare), e QUANTO e' durato sul ramo del taglio — un'interruzione a
     * 30 secondi e una a mezzo secondo hanno rimedi opposti.
     *
     * `silent: true` e' il ramo della sessione scaduta: `SessionGuard` ha gia' aperto il suo dialogo
     * e un secondo messaggio sopra il suo lo coprirebbe. Vedi la testata di util/ActionResult.js.
     *
     * @param {{kind: string, status: number, message: string}} oOutcome da ActionResult
     * @param {number} iElapsedMs durata della chiamata, in millisecondi
     * @param {object} oBundle il ResourceBundle
     * @returns {{silent: boolean, text: string}}
     */
    function failure(oOutcome, iElapsedMs, oBundle) {
        const sKind = (oOutcome && oOutcome.kind) || "";
        const sServer = (oOutcome && oOutcome.message) || "";

        if (sKind === "AUTH") { return { silent: true, text: "" }; }

        if (sKind === "APP") {
            // Il messaggio del server dice cosa correggere: e' il piu' informativo che esista, e
            // finora era l'unico che veniva buttato via.
            return {
                silent: false,
                text: sServer || oBundle.getText("autoAssignError")
            };
        }

        if (sKind === "TRANSPORT") {
            const iSec = Math.max(1, Math.round((Number(iElapsedMs) || 0) / 1000));
            return { silent: false, text: oBundle.getText("autoAssignErrorInterrupted", [iSec]) };
        }

        // SHAPE, o una specie che non conosciamo: non si inventa una diagnosi che non si ha.
        return { silent: false, text: oBundle.getText("autoAssignError") };
    }

    return { detail, kept, failure };
});

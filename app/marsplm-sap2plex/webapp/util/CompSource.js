/**
 * [COMP-SOURCE] Chi ha collocato un componente — lato client (feature 0036).
 *
 * Gemello di srv/lib/compSourceRules.js, condiviso dai due editor che collocano componenti sulle
 * operazioni Plex: RoutingDetail (il ciclo di una part) e ProdOrderDetail (l'albero di un ordine).
 * La domanda e' una — «questa riga l'ha messa una persona?» — e la risposta deve essere la stessa
 * del server: da quel valore dipendono l'icona che l'utente vede E, sull'ordine, l'operazione su cui
 * il componente finisce davvero su Plex (srv/lib/orderBomAdd.js, passo 2bis).
 *
 * PERCHE' UN MODULO E NON TRE CONFRONTI. `AssignmentSource === "MANUAL"` scritto a mano nei punti
 * dove serve sarebbe corretto quasi sempre e sbagliato dove conta: il server normalizza con
 * `trim().toUpperCase()`, quindi `" manual "` e `"Manual"` sono manuali per lui e non per un
 * confronto stretto — e l'icona mancherebbe su una riga che il job invece rispetta.
 *
 * L'AUTORITA' RESTA IL SERVER: qui si decide cosa MOSTRARE e cosa mandare nel payload, mentre chi
 * decide il valore persistito e' `normalizeOrigin` dentro `savePlexCycle`. Se le due parti
 * divergessero, quella giusta e' il server. test/compSourceRules.test.js le confronta sulla stessa
 * tabella di casi.
 *
 * Nessuna dipendenza UI5: e' una normalizzazione di stringa e un conteggio su array — ed e' scritto
 * cosi' apposta, perche' un `sap.ui.define([])` senza dipendenze si carica da node e quindi si
 * collauda (stessa forma di util/columnSortRules.js e di adminconfigplant/util/autoAssignDuplicates.js).
 */
sap.ui.define([], function () {
    "use strict";

    /**
     * I due valori di `AssignmentSource`, su entrambi gli alberi.
     *
     *   "AUTO"   -> l'auto-assegnazione. Le regole possono spostare la riga quando cambiano idea.
     *   "MANUAL" -> una persona, nel cockpit. Le regole non la spostano.
     */
    var ORIGIN = { AUTO: "AUTO", MANUAL: "MANUAL" };

    /** Stringa spogliata: `null`/`undefined` diventano stringa vuota, mai "null". */
    function str(vValue) {
        if (vValue === null || vValue === undefined) return "";
        return String(vValue).trim();
    }

    /**
     * La provenienza di una riga.
     *
     * VUOTO = "AUTO", come sul server: una riga senza provenienza dichiarata e' governata dalle
     * regole. E' anche cio' che fa comportare come prima le righe scritte prima di questa feature.
     */
    function normalizeOrigin(vValue) {
        return str(vValue).toUpperCase() === ORIGIN.MANUAL ? ORIGIN.MANUAL : ORIGIN.AUTO;
    }

    /** `true` se la riga e' stata collocata da una persona. Pilota l'icona di coda dell'albero. */
    function isManual(vValue) {
        return normalizeOrigin(vValue) === ORIGIN.MANUAL;
    }

    // [COMP-SOURCE] `countManualRows` e' USCITO l'11/09/2026 col suo unico chiamante: la conferma
    // «{0} componenti collocati a mano torneranno sotto le regole», caduta quando «Auto-Assegna» ha
    // smesso di riportarli sotto le regole. Il gemello lato server e' uscito nello stesso momento —
    // le due meta' di una coppia si tolgono insieme, o il test di parita' sorveglia un simbolo che
    // esiste da una parte sola. Chi conta le righe conservate oggi e' `_applyAutoAssignments`.

    /**
     * [COMP-ORPHAN] Chiave di confronto di un codice materiale (feature 0037).
     *
     * La stessa di `matKey` in srv/lib/compSourceRules.js, che e' quella con cui il server pota e
     * con cui il passo 7.2 decide se un componente e' dell'ordine. Insensibile alla grafia e NON
     * agli zeri iniziali: entrambi i lati vengono da SAP, quindi il confronto e' stretto (DEC-51).
     */
    function matKey(vValue) {
        return str(vValue).toUpperCase();
    }

    /**
     * [COMP-ORPHAN] Quante righe dell'albero hanno un materiale che SAP non ha piu'.
     *
     * DUE GUARDIANI, gli stessi del server: insieme assente o VUOTO = nessun orfano. Marcare su una
     * lettura non riuscita direbbe a chi guarda che quel componente sta per sparire quando non e'
     * vero — e questa e' una funzione che serve solo a DIRE, quindi il falso positivo e' tutto il
     * danno che potrebbe fare.
     *
     * @param {Array} aOperations operazioni con `components`
     * @param {Set} oSapKeys chiavi `matKey` dei materiali che SAP ha
     * @returns {int}
     */
    function countOrphans(aOperations, oSapKeys) {
        if (!(oSapKeys instanceof Set) || oSapKeys.size === 0) return 0;
        var iCount = 0;
        (Array.isArray(aOperations) ? aOperations : []).forEach(function (oOp) {
            ((oOp && oOp.components) || []).forEach(function (oComp) {
                var sKey = matKey(oComp && oComp.Material);
                if (sKey && !oSapKeys.has(sKey)) iCount++;
            });
        });
        return iCount;
    }

    /**
     * [COMP-ORPHAN] Questo materiale esiste ancora fra i componenti SAP?
     *
     * Rende `false` — cioe' «non e' un orfano» — quando l'insieme non e' utilizzabile: nel dubbio si
     * tace, perche' un marcatore sbagliato e' peggio di un marcatore assente.
     */
    function isOrphan(vMaterial, oSapKeys) {
        if (!(oSapKeys instanceof Set) || oSapKeys.size === 0) return false;
        var sKey = matKey(vMaterial);
        return !!sKey && !oSapKeys.has(sKey);
    }

    /**
     * I materiali che l'auto-assegnazione NON ricolloca, perche' una persona li ha gia' messi.
     *
     * E' LA REGOLA DEL PULSANTE «AUTO-ASSEGNA» (11/09/2026). Fino a quel giorno il pulsante
     * svuotava l'albero e riscriveva ogni riga `AUTO`, chiedendo conferma: cioe' faceva l'opposto
     * di quello che il tooltip della puntina promette («l'auto-assegnazione non lo sposta») e
     * l'opposto di quello che fanno i DUE invii — `planCycleComponents` sul ciclo («la collocazione
     * fatta a mano vince, e non passa dalla regola») e `applyManualTargets` sull'ordine. Il cockpit
     * era l'unico posto che la conversione la faceva davvero.
     *
     * GEMELLA di `compSourceRules.manualMaterials` — stessa domanda, altro contenitore: la' righe
     * piatte lette dal database, qui l'albero a schermo, dove la stessa riga vive dentro la sua
     * operazione. Con dentro `orphanKeys`: un materiale che SAP non ha piu' NON si conserva, o «la
     * mano vince» diventerebbe «la mano vince anche su SAP», che e' il difetto che la 0037 esiste
     * per chiudere. I due guardiani sono i suoi: insieme assente o VUOTO non toglie niente —
     * «vuoto» non e' «ignoto», e su una lettura caduta si cancellerebbe una decisione umana.
     *
     * LA GRANULARITA' E' IL MATERIALE, non la coppia (operazione, materiale): e' quella di
     * `compSourceRules.manualMaterials` e di 0036 RB-05, e un materiale appeso a due operazioni,
     * una a mano e una dalle regole, e' manuale per entrambe. Con la granularita' della coppia lo
     * stesso componente comparirebbe due volte, su due operazioni.
     *
     * @param {Array} aOperations operazioni con `components`
     * @param {Set} [oSapKeys] chiavi `matKey` dei materiali che SAP ha davvero. Sull'ordine il
     *   browser ce l'ha (`_oSapCompKeys`); sul ciclo no, e li' si passa `null`: non e' una
     *   dimenticanza, il client non ha la seconda lettura del server e marcherebbe orfano cio' che
     *   non lo e' (DEC-107). Sul ciclo la potatura resta all'invio, coi guardiani del server.
     * @returns {Set} chiavi `matKey` dei materiali da lasciare dove sono
     */
    function manualMaterials(aOperations, oSapKeys) {
        var oOut = new Set();
        (Array.isArray(aOperations) ? aOperations : []).forEach(function (oOp) {
            ((oOp && oOp.components) || []).forEach(function (oComp) {
                if (!isManual(oComp && oComp.AssignmentSource)) return;
                var sKey = matKey(oComp && oComp.Material);
                if (!sKey) return;
                // `isOrphan` porta con se' i due guardiani: senza un insieme utilizzabile rende
                // sempre `false`, quindi si conserva tutto.
                if (isOrphan(sKey, oSapKeys)) return;
                oOut.add(sKey);
            });
        });
        return oOut;
    }

    return {
        ORIGIN: ORIGIN,
        str: str,
        matKey: matKey,
        normalizeOrigin: normalizeOrigin,
        isManual: isManual,
        countOrphans: countOrphans,
        isOrphan: isOrphan,
        manualMaterials: manualMaterials
    };
});

/**
 * [MASS-IMPORT] Le regole pure dell'import di un template, singolo e massivo.
 *
 * PERCHE' ESISTE. L'import di un template dentro un ciclo viveva in un punto solo — il dettaglio
 * ciclo — e la mappatura «righe del template -> operazioni del ciclo» stava dentro il suo handler.
 * Dall'import massivo i chiamanti sono DUE, e quella mappatura decide cosa viene scritto: due copie
 * darebbero un import massivo che costruisce un albero diverso da quello singolo, sugli stessi
 * dati, senza che niente lo dica. I due gesti non si confrontano mai, quindi la divergenza si
 * scoprirebbe solo da un ciclo «venuto male» mesi dopo.
 *
 * QUI STA SOLO CIO' CHE SI PUO' DECIDERE SENZA RETE E SENZA UI5. Le letture — operazioni, work
 * center e gruppi del template — restano nei controller, che sanno comporre gli URL e hanno il
 * `fetch`; qui arrivano gia' come array.
 *
 * Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, come `util/ApprovedWcConflicts.js`
 * e `util/TemplateGroupConflicts.js`. E' cio' che permette a `node test/massImportTemplate.test.js`
 * di eseguirlo con un `sap.ui.define` finto invece di simulare il loader.
 *
 * Nessuna funzione muta l'input.
 */
sap.ui.define([], function () {
    "use strict";

    /**
     * I due ruoli che abilitano la CONFIGURAZIONE, e non sono i ruoli del cockpit.
     *
     * Sono la copia client di `plantAccessRules.enablesPlantConfig`, che e' l'unica definizione:
     * `test/massImportTemplate.test.js` confronta questo elenco con quello del modulo server, o le
     * due soglie divergono in silenzio. Le soglie del progetto sono TRE e non si fondono — il
     * cockpit si apre con QUALSIASI ruolo, la configurazione con questi due, i segreti col solo
     * `admin` — e confonderle non da' un errore: da' un permesso di troppo, o un pulsante che non
     * compare a chi ne ha diritto.
     */
    var PLANT_CONFIG_ROLES = ["admin", "admin-config"];

    /** Testo ripulito, o stringa vuota: `null` e `undefined` non devono finire in un confronto. */
    function text(vValue) {
        return String(vValue === null || vValue === undefined ? "" : vValue).trim();
    }

    /**
     * Questo ruolo abilita la configurazione?
     *
     * Confronto in minuscolo: il ruolo arriva gia' normalizzato dal server, ma un `Admin` che
     * passasse spegnerebbe il pulsante a chi ne ha diritto — e sarebbe muto.
     *
     * @param {string} sRole il ruolo sul plant
     * @returns {boolean}
     */
    function enablesPlantConfig(sRole) {
        return PLANT_CONFIG_ROLES.indexOf(text(sRole).toLowerCase()) !== -1;
    }

    /**
     * I plant su cui l'utente puo' configurare: quelli concessi il cui ruolo supera la soglia.
     *
     * Si parte dalle righe di `usablePlants()`, che sono gia' i soli plant CONCESSI (attivi,
     * licenziati, con un ruolo). Qui si restringe alla soglia piu' alta.
     *
     * @param {Array} aPlants righe `UsablePlant` ({Plant, Name, Verdict, RoleKnown, Role})
     * @returns {Array<string>} i codici plant, nell'ordine ricevuto
     */
    function configurablePlants(aPlants) {
        return (aPlants || []).reduce(function (aOut, oPlant) {
            var sCode = text(oPlant && oPlant.Plant);
            if (sCode && enablesPlantConfig(oPlant && oPlant.Role)) { aOut.push(sCode); }
            return aOut;
        }, []);
    }

    /**
     * Le operazioni del ciclo, a partire dalle righe del template.
     *
     * E' LA FUNZIONE CONDIVISA fra l'import singolo e quello massivo. Tre cose che decide, e che
     * erano dentro l'handler del dettaglio ciclo:
     *
     *   - i LEGAMI CON SAP si azzerano (`SAPOperationId`, `ProductionRoutingOpIntID`): il template
     *     non sa niente delle operazioni SAP del ciclo su cui atterra, e portarsi dietro quelli
     *     dell'albero precedente aggancerebbe un'operazione del template a un'operazione SAP che
     *     non le corrisponde;
     *   - i COMPONENTI nascono vuoti: il template non ne ha, e l'albero si ricostruisce da zero;
     *   - il NUMERO e' posizionale (`(indice + 1) * 10`) quando il template non lo porta, ed e' lo
     *     stesso ripiego del server.
     *
     * @param {Array} aOps righe `RoutingTemplateOperations`, gia' ordinate per `Sequence`
     * @param {Object} mWcByOp mappa `PlexOperationId` -> array di work center
     * @param {Object} mGroupsByOp mappa `PlexOperationId` -> array di codici gruppo
     * @returns {Array<Object>} le operazioni in memoria del ciclo
     */
    function operationsFromTemplate(aOps, mWcByOp, mGroupsByOp) {
        var mWc = mWcByOp || {};
        var mGroups = mGroupsByOp || {};
        return (aOps || []).map(function (op, index) {
            return {
                PlexOperationId: op.PlexOperationId,
                OperationCode: op.OperationCode,
                OperationName: op.OperationName,
                SAPOperationId: null,
                ProductionRoutingOpIntID: null,
                OperationNumber: op.OperationNumber || (index + 1) * 10,
                OperationType: op.OperationType || null,
                SubOperation: op.SubOperation || false,
                Shippable: op.Shippable || false,
                NetWeight: op.NetWeight || null,
                StandardQuantity: op.StandardQuantity || null,
                components: [],
                approvedWorkcenters: mWc[op.PlexOperationId] || [],
                objectGroups: mGroups[op.PlexOperationId] || []
            };
        });
    }

    /**
     * Le righe figlie di un template, raggruppate per operazione.
     *
     * Una funzione per due raggruppamenti che hanno la stessa forma e chiavi diverse: il valore da
     * accumulare lo decide il chiamante. Scriverli a mano in ogni punto che legge un template e'
     * ciò che ha gia' fatto divergere copia e import.
     *
     * @param {Array} aRows le righe, ognuna con `PlexOperationId`
     * @param {function} fnValue da riga a valore accumulato; `null` scarta la riga
     * @returns {Object} mappa `PlexOperationId` -> array di valori
     */
    function byOperation(aRows, fnValue) {
        var mOut = {};
        (aRows || []).forEach(function (row) {
            if (!row || !row.PlexOperationId) { return; }
            var vValue = fnValue ? fnValue(row) : row;
            if (vValue === null || vValue === undefined) { return; }
            if (!mOut[row.PlexOperationId]) { mOut[row.PlexOperationId] = []; }
            mOut[row.PlexOperationId].push(vValue);
        });
        return mOut;
    }

    /**
     * Il payload di `saveRoutingPlexCycle`, a partire dalle operazioni in memoria.
     *
     * Nell'import massivo viaggia UGUALE per ogni bersaglio — cambiano solo gruppo, contatore e
     * materiale — quindi si compone una volta sola. `Components` non c'e': un ciclo importato da
     * un template nasce senza componenti, e mandarne una lista vuota o non mandarla e' lo stesso
     * per l'handler.
     *
     * @param {Array} aOperations le operazioni da `operationsFromTemplate`
     * @returns {Array<Object>} le operazioni nella forma dell'action
     */
    function operationsPayload(aOperations) {
        return (aOperations || []).map(function (op) {
            return {
                PlexOperationId: op.PlexOperationId,
                OperationCode: op.OperationCode,
                OperationName: op.OperationName,
                OperationNumber: op.OperationNumber,
                OperationType: op.OperationType || null,
                SubOperation: op.SubOperation || false,
                Shippable: op.Shippable || false,
                NetWeight: op.NetWeight || null,
                StandardQuantity: op.StandardQuantity || null,
                ApprovedWorkcenters: (op.approvedWorkcenters || []).map(function (wc) {
                    return {
                        WorkcenterId: wc.WorkcenterId,
                        WorkcenterCode: wc.WorkcenterCode,
                        WorkcenterName: wc.WorkcenterName
                    };
                }),
                ObjectGroups: (op.objectGroups || []).map(function (sGroupId) {
                    return { GroupId: sGroupId };
                })
            };
        });
    }

    /**
     * Il template porta almeno un gruppo oggetti?
     *
     * E' il cancello che decide se l'import sostituira' le regole di auto-assegnazione, e quindi
     * anche QUALE dei due messaggi si mostra. Gemello client di `templateGroupRules.hasAnyGroup`.
     *
     * @param {Array} aOperations le operazioni in memoria
     * @returns {boolean}
     */
    function hasAnyGroup(aOperations) {
        return (aOperations || []).some(function (op) {
            return ((op && op.objectGroups) || []).some(function (sCode) { return !!text(sCode); });
        });
    }

    /** La chiave di un bersaglio: gruppo, contatore e materiale insieme identificano un ciclo. */
    function targetKey(oTarget) {
        if (!oTarget) { return ""; }
        return [
            text(oTarget.ProductionRoutingGroup),
            text(oTarget.ProductionRouting),
            text(oTarget.Material)
        ].join("|");
    }

    /**
     * I bersagli selezionabili: le righe di ciclo del plant, meno quelle gia' scelte.
     *
     * Due esclusioni, ognuna con la sua ragione:
     *
     *   - MATERIALE VUOTO. E' il ciclo SAP senza alcuna assegnazione materiale, e
     *     `saveRoutingPlexCycle` lo rifiuta con `routingCycleMaterialRequired`. Offrirlo vorrebbe
     *     dire offrire un bersaglio che fallira' sempre, e farlo scoprire dal riepilogo.
     *   - GIA' SCELTO. Due righe uguali riscriverebbero due volte lo stesso ciclo: la seconda non
     *     fa danno, ma il conteggio direbbe due dove l'utente ne vede uno.
     *
     * Il filtro per plant NON e' qui: le righe arrivano gia' lette per il plant del template, e
     * rifiltrarle darebbe due punti in cui quel perimetro si decide.
     *
     * @param {Array} aRows righe di `Routings` ({ProductionRoutingGroup, ProductionRouting, Material, ...})
     * @param {Array} aChosen i bersagli gia' in tabella
     * @returns {Array} le righe offribili, nell'ordine ricevuto
     */
    function selectableTargets(aRows, aChosen) {
        var oTaken = {};
        (aChosen || []).forEach(function (t) { oTaken[targetKey(t)] = true; });
        return (aRows || []).filter(function (row) {
            if (!row || !text(row.Material)) { return false; }
            return !oTaken[targetKey(row)];
        });
    }

    /**
     * Cambiando template, i bersagli gia' scelti restano validi?
     *
     * NO appena cambia il PLANT: un ciclo di un altro plant non e' importabile da questo template,
     * e tenerlo vorrebbe dire mandare al server bersagli che rifiutera' uno per uno. Il plant
     * uguale invece conserva la scelta — riselezionare un template dello stesso plant e' un gesto
     * ordinario, e svuotare la tabella a ogni tocco della tendina sarebbe una trappola.
     *
     * @param {string} sPrevPlant il plant del template di prima ('' se non ce n'era)
     * @param {string} sNextPlant il plant del template scelto ora
     * @returns {boolean} `true` se i bersagli vanno svuotati
     */
    function targetsMustReset(sPrevPlant, sNextPlant) {
        var sPrev = text(sPrevPlant);
        var sNext = text(sNextPlant);
        if (!sPrev) { return false; }
        return sPrev !== sNext;
    }

    return {
        PLANT_CONFIG_ROLES: PLANT_CONFIG_ROLES,
        enablesPlantConfig: enablesPlantConfig,
        configurablePlants: configurablePlants,
        operationsFromTemplate: operationsFromTemplate,
        byOperation: byOperation,
        operationsPayload: operationsPayload,
        hasAnyGroup: hasAnyGroup,
        targetKey: targetKey,
        selectableTargets: selectableTargets,
        targetsMustReset: targetsMustReset
    };
});

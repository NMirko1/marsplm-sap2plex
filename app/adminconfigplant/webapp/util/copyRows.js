sap.ui.define([], () => {
    "use strict";

    /**
     * [ROW-COPY] I dati iniziali della copia di una riga di customizing.
     *
     * PERCHE' QUESTO MODULO ESISTE. «Copia» e' un `create()` con i valori di una riga che c'e' al
     * posto dei campi vuoti, e la domanda che decide se la copia e' giusta e' UNA: quali campi
     * passano e quali no. Tenerla in tre punti del controller significherebbe tre risposte che
     * divergono, e nessuna di quelle divergenze da' un errore — una copia a cui manca un campo si
     * salva.
     *
     * TRE REGOLE, e nessuna delle tre e' visibile leggendo il chiamante:
     *
     *   1. `ID` e `group_ID` NON passano. La chiave la assegna CAP all'inserimento; un `ID` copiato
     *      nei dati iniziali sarebbe una riga nuova che pretende di essere quella sorgente. Per la
     *      stessa ragione restano fuori i campi di `managed` (createdAt/By, modifiedAt/By): sono
     *      della riga sorgente, e chi li scrive e' il server.
     *
     *   2. Un campo assente diventa `''` e non `undefined`. Nei dati iniziali di
     *      `ODataListBinding#create` un `undefined` non e' «campo vuoto»: e' un campo NON
     *      DICHIARATO, che quindi non entra nel corpo della POST — e su una colonna `not null` del
     *      modello il difetto si vede solo al Salva, lontano dal gesto.
     *
     *   3. Una riga sorgente che non c'e' rende `null`, e il chiamante la salta. Un contesto di un
     *      binding V4 non ancora caricato risponde `undefined` a `getObject()`: copiarlo
     *      produrrebbe una riga vuota che sembra un errore dell'utente. E' lo stesso criterio di
     *      `_materializeOpTypeFilterRows` — «un contesto non ancora caricato non e' una riga».
     *
     * Il `Plant` arriva da FUORI e non dalla riga sorgente, sui due livelli che lo portano: e' il
     * primo membro della chiave unica di entrambe le entity ed e' il gate del perimetro, e la
     * scheda dichiara un plant solo. Prenderlo dalla riga darebbe una copia fuori dal plant a
     * schermo il giorno in cui quel filtro cambiasse. E' la scelta che fanno gia' `onAddAutoAssign`
     * e `onAddObjectGroup`.
     *
     * Nessuna dipendenza: `sap.ui.define([])` senza moduli richiesti, cosi' la regola si collauda da
     * node (`node test/copyRows.test.js`) come i moduli puri di `srv/lib/`.
     *
     * Perimetro: `grep -rn "ROW-COPY"`.
     */

    /**
     * Il valore come testo, con l'assente reso `''`. Vedi la regola 2 in testa al file.
     */
    function text(vValue) {
        return String(vValue === null || vValue === undefined ? "" : vValue);
    }

    return {

        /**
         * I dati iniziali della copia di una riga di auto-assegnazione.
         *
         * `PlexOperationName` VIAGGIA, e non e' un doppione di `PlexOperation`: quel campo lo
         * denormalizza soltanto `onOperationChange`, che su una copia non passa. Senza, la copia
         * avrebbe l'operazione giusta e la colonna «Operazione» vuota — che e' la colonna su cui la
         * scheda ordina e filtra ([CODED-VALUES]) — senza un errore da nessuna parte.
         *
         * I valori NON si normalizzano e NON si svuotano: la copia e' identica al suo originale,
         * quindi e' un doppione della chiave `(Plant, Material, ComponentGroup)` e a rifiutarla
         * sara' la guardia [AA-DUPLICATE] del Salva. Svuotare `ComponentGroup` per «aiutare»
         * sposterebbe il difetto: `findDuplicates` salta le righe incomplete, quindi due copie cosi'
         * passerebbero il client e le fermerebbe il server con `aaGroupMandatory`, cioe' un change
         * set annullato invece di un messaggio che NOMINA la coppia.
         *
         * @param {Object} oRow la riga sorgente, come la rende `Context#getObject()`
         * @param {string} sPlant il plant della schermata
         * @returns {Object|null} i dati iniziali, o `null` se la riga sorgente non c'e'
         */
        autoAssignRow(oRow, sPlant) {
            if (!oRow) { return null; }
            return {
                Plant: text(sPlant),
                Material: text(oRow.Material),
                ComponentGroup: text(oRow.ComponentGroup),
                PlexOperation: text(oRow.PlexOperation),
                PlexOperationName: text(oRow.PlexOperationName)
            };
        },

        /**
         * I dati iniziali della copia della TESTATA di un gruppo oggetti.
         *
         * Il `GroupId` si copia IDENTICO, e non e' una dimenticanza: `@assert.unique.plantGroup` lo
         * rende unico per plant, quindi la copia non e' salvabile finche' una persona non le da' un
         * codice suo. E' la decisione presa: un suffisso automatico («-COPY») sarebbe un valore
         * INVENTATO da noi, che finisce nel database e che va comunque rinominato quasi sempre — e
         * se fosse tradotto («-COPIA») metterebbe nel dato la lingua di chi ha salvato (DEC-92).
         * Il rifiuto arriva dal server con `ogGroupAlreadyExists`, che e' tradotto anche nel caso di
         * corsa dentro il change set (wrapper [UNIQUE-VIOLATION] in testa a cat-service.js).
         *
         * La `Description` si copia com'e': cambia il CODICE, che e' la chiave, non cio' che il
         * gruppo dice di se'.
         *
         * @param {Object} oRow la riga sorgente
         * @param {string} sPlant il plant della schermata
         * @returns {Object|null} i dati iniziali, o `null` se la riga sorgente non c'e'
         */
        objectGroupRow(oRow, sPlant) {
            if (!oRow) { return null; }
            return {
                Plant: text(sPlant),
                GroupId: text(oRow.GroupId),
                Description: text(oRow.Description)
            };
        },

        /**
         * I dati iniziali della copia di una CONDIZIONE di gruppo.
         *
         * SI COPIANO TUTTI E SEI I CAMPI, compresi i tre che la modalita' corrente NASCONDE. Le due
         * meta' della riga — `FieldName`/`FieldValue` per il ramo FIELD, `Class`/`Characteristic`/
         * `CharcValue` per il ramo CLASS — le tiene pulite `onConditionTypeChange`, che azzera
         * l'altra solo quando il tipo lo cambia una persona. Copiare la sola meta' visibile
         * cambierebbe in silenzio il significato della riga il giorno in cui una sorgente porta
         * ancora valori dell'altro ramo, e nessuna schermata lo mostrerebbe.
         *
         * `ConditionType` non diventa mai `''`: e' un enum del modello, e il suo ripiego e' quello
         * di `onAddGroupField`.
         *
         * @param {Object} oRow la riga sorgente
         * @returns {Object|null} i dati iniziali, o `null` se la riga sorgente non c'e'
         */
        conditionRow(oRow) {
            if (!oRow) { return null; }
            return {
                ConditionType: text(oRow.ConditionType) || "FIELD",
                FieldName: text(oRow.FieldName),
                FieldValue: text(oRow.FieldValue),
                Class: text(oRow.Class),
                Characteristic: text(oRow.Characteristic),
                CharcValue: text(oRow.CharcValue)
            };
        }
    };
});

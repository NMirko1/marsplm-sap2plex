/**
 * Identificativi delle Plex Data Source — elenco unico.
 *
 * Una Data Source è SQL scritto dentro Plex e si invoca per NUMERO:
 *   POST {dataSourceUrl}/api/datasources/{id}/execute
 * Questo modulo tiene i dodici numeri in esercizio, ciascuno con la sua variabile d'ambiente e il
 * suo default.
 *
 * SONO PARAMETRI DI RILASCIO, NON CUSTOMIZING. Non compaiono in nessuna schermata e non sono per
 * plant: gli id sono gli stessi su tutti i tenant, quindi metterli fra i dati configurabili darebbe
 * all'amministratore una leva che non gli serve e che può solo rompere. È la stessa posizione già
 * dichiarata dalla feature 0014 per la 239905 (FR-11) e dalla 0009 per le altre cinque (RB-06).
 * Si impostano su Cloud Foundry, e vanno impostate SIA sul modulo `srv` SIA sui task del Job
 * Scheduler — i job girano come processi separati e non vedono l'ambiente del server web.
 *
 * PERCHÉ UN MODULO E NON TRE DICHIARAZIONI. Prima stavano in tre punti: cinque in
 * srv/jobs/createPlexProductionOrders.js, la 239905 in srv/lib/plexJobSort.js — che il job
 * importava proprio per non farle divergere — e la 20793 come numero LETTERALE dentro la chiamata
 * in srv/cat-service.js, senza nemmeno una variabile. Il test di connessione ne ha aggiunto un
 * quarto punto d'uso: con un elenco solo, chi cerca «quale Data Source stiamo chiamando» trova
 * tutto qui, e nessun file dichiara un numero per conto suo.
 *
 * Un id sbagliato NON si manifesta come credenziale sbagliata: l'host risponde 404. È la
 * distinzione che il test di connessione mostra all'amministratore (feature 0020).
 *
 * La provenienza dei numeri: i cinque del flusso ordini vengono dallo «sheet Jobs Creation»
 * (non versionato); la 239905 dai due PDF Rockwell del caso 00544718 / TS-5532, di cui
 * specs/0014-ordinamento-ordini-plex/04-contracts.md è la traccia versionata.
 */

'use strict';

/** 6.1 — da `Job_No` a `Job_Key`. LETTURA: è anche la sonda del test di connessione. */
const DS_GET_JOB_KEY = Number(process.env.PLEX_DS_JOB_KEY || 4216);

/** 6.2 — operazioni del job, da `Job_Key`. Lettura. */
const DS_GET_JOB_OPS = Number(process.env.PLEX_DS_JOB_OPS || 4701);

/** 6.3 — porta un'operazione a «NOT Required». SCRITTURA. */
const DS_UPDATE_JOB_OP_STATUS = Number(process.env.PLEX_DS_JOB_OP_STATUS || 20051);

/** 7.1 — righe BOM di un'operazione del job. Lettura. */
const DS_GET_JOB_BOM = Number(process.env.PLEX_DS_JOB_BOM || 10603);

/** 7.2 — disattiva una riga BOM (`Active = 0`). SCRITTURA. */
const DS_UPDATE_JOB_BOM = Number(process.env.PLEX_DS_UPDATE_JOB_BOM || 4858);

/**
 * 8 — `sproc295347_Job_Sort_Order_Update`, ricalcolo della sequenza della lista di lavoro
 * (feature 0014). SCRITTURA. È l'unica invocata con la forma ANNIDATA del corpo e senza
 * `?format=2`: vedi DEC-37, le due forme non sono equivalenti e non vanno unificate.
 */
const DS_JOB_SORT_ORDER = Number(process.env.PLEX_DS_JOB_SORT_ORDER || 239905);

/**
 * [ORDER-TECO] Porta un job Plex allo stato di chiusura. SCRITTURA (feature 0023, W1-13).
 *
 * E' la transizione con cui la chiusura tecnica fatta in SAP viene tracciata su Plex. `Job_Key` e' la
 * chiave INTERNA del job, cioe' esattamente quello che la 4216 qui sopra restituisce da `Job_No`: le
 * due si usano in catena, e non c'e' nessun UUID di mezzo.
 *
 * SOSTITUISCE LA 19529 `Job_Complete` dal 03/09/2026 (addendum a DEC-70). La catena non e' cambiata —
 * la `Job_Key` la leggevamo gia' — ed e' cambiato solo il secondo anello.
 *
 * Provenienza: foglio *TBD-Status Update - Closed job* di `Ariston - API List_FinalVersion.xlsx`, che
 * dichiara anche l'indirizzo della schermata,
 * `Platform/CustomerDataSourceManager/Form?DataSourceKey=23101`.
 *
 * QUELLO CHE SAPPIAMO, E SOLO QUELLO. A differenza della 19529 NON abbiamo la schermata della Data
 * Source: il nome della stored procedure, i tipi e l'obbligatorieta' dei parametri non sono
 * confermati. Dal foglio:
 *   input   `Job_Key` (int) e `Job_Status` (string, `"TECO"`, dichiarato hardcode)
 *   output  `outputs.Result_Code` / `outputs.Result_Message` (osservati: `1` / `"Success"`),
 *           piu' `rows: []`, `rowLimitExceeded`, `transactionNo`
 * La forma del corpo la costruisce `buildTecoInputs` in srv/lib/prodOrderTeco.js, unico punto.
 *
 * E' LA PRIMA DATA SOURCE `?format=2` IN ESERCIZIO CHE DICHIARA `outputs`. La forma piatta con
 * `?format=2` non esclude `outputs`: il commento di executeDataSourceOutputs in
 * srv/jobs/lib/plexJobsClient.js resta valido su cio' che afferma — le due forme del CORPO non si
 * unificano — ma non va letto come «`format=2` ⇒ solo `rows`».
 *
 * `0` SPEGNE LA SCRITTURA e non il rilevamento (DEC-71). Il nome della variabile e'
 * `PLEX_DS_JOB_STATUS_UPDATE` e non `PLEX_DS_JOB_STATUS`, per non confondersi con
 * `PLEX_DS_JOB_OP_STATUS` qui sopra, che e' lo stato di un'OPERAZIONE del job.
 */
const DS_JOB_STATUS_UPDATE = Number(process.env.PLEX_DS_JOB_STATUS_UPDATE || 23101);

/**
 * [WC-SUBTRACT] Le tre LETTURE che traducono un UUID Plex nella sua chiave INTERA, e la SCRITTURA
 * che rimuove un work center approvato da una part-operation (feature 0024).
 *
 * PERCHE' UNA DATA SOURCE E NON LA CONNECT API. Sugli approved workcenter la Connect API espone
 * SOLO `GET` (lista) e `POST` (crea): nessun `DELETE`, `PUT`, `PATCH` ne' `/deactivate` — verificato
 * il 19/08/2026 sull'API di documentazione senza autenticazione di developers.plex.com, la stessa da
 * cui viene srv/external/PLEX_BOM_API_CONTRACT.md. La riga non ha nemmeno un id proprio ne' un flag
 * `active`: la sua identita' E' la tripla (partId, partOperationId, workcenterId). Quindi la
 * rimozione non e' esprimibile sulla Connect API, e passa da qui — che e' anche il canale del solo
 * altro caso di disattivazione del progetto, la 4858 (DEC-74). Nessuna `plexDelete` riusabile sulla
 * Connect API: la dichiarazione in testa a `plexConnectDelete` in cat-service.js resta valida.
 *
 * PERCHE' TRE LETTURE. La 755 pretende tre `int` e la Connect API non restituisce NESSUN intero —
 * `parts`, `part-operations`, `workcenters` e `approved-workcenters` sono tutti UUID. Le tre letture
 * sono il ponte fra i due canali, e i loro input (`Part_No`, `Revision`, `Operation_Code`,
 * `Workcenter_Code`) stanno tutti nella riga che la GET degli approved workcenter restituisce: cio'
 * che si cancella e' identificato da CIO' CHE PLEX HA DETTO. E' la catena 4216 -> 23101 della 0023,
 * con un anello in piu'.
 *
 * Provenienza: schermate Data Source del tenant *Ariston Albacina* fornite dal cliente il
 * 19/08/2026, database `Part`.
 */

/** Da `Part_No` (+ `Revision` opzionale) a `Part_Key`. Lettura. Engineering -> Part List. */
const DS_PART_KEY = Number(process.env.PLEX_DS_PART_KEY || 1786);

/**
 * Da (`Operation_Code`, `Part_Key`) a `Part_Operation_Key`. Lettura. Engineering -> Process Routings.
 * Restituisce DUE colonne, `Operation_Key` e `Part_Operation_Key`: serve la seconda.
 *
 * NON confondere `Part_Operation_Key` con `Job_Op_Key` della 24127: quella e' l'operazione di un JOB
 * schedulato (Production Tracking -> Job Tracking System), questa e' l'operazione della DEFINIZIONE
 * di ciclo, che e' l'oggetto su cui la 755 lavora.
 */
const DS_PART_OPERATION_KEY = Number(process.env.PLEX_DS_PART_OPERATION_KEY || 29200);

/**
 * Da `Workcenter_Code` a `Workcenter_Key`. Lettura. Production Tracking -> Workcenter List.
 *
 * ATTENZIONE: `Workcenter_Code` NON e' dichiarato obbligatorio. Invocata in bianco restituisce
 * l'elenco (Read Row Limit 1000), e prendere la prima riga vorrebbe dire cancellare l'approvazione
 * di uno sconosciuto. Il codice vuoto si ferma nel chiamante, prima della chiamata.
 */
const DS_WORKCENTER_KEY = Number(process.env.PLEX_DS_WORKCENTER_KEY || 11835);

/**
 * [WC-SUBTRACT] `Approved_Workcenter_Delete` — toglie un work center approvato da una part-operation.
 * SCRITTURA. Engineering -> Process Routings, stored procedure `Approved_Workcenter_Delete`.
 *
 * Input dichiarati dalla schermata: `Part_Key`, `Part_Operation_Key`, `Workcenter_Key`, tutti `int` e
 * tutti OBBLIGATORI. Output: `Return` varchar, nullable — non documentato, quindi un `200` che non ha
 * fatto niente e' indistinguibile da un `200` che ha rimosso. L'oracolo e' la GET dell'invio
 * SUCCESSIVO, come per «autoDeplete» (0008 RB-55): nessuna sonda dedicata.
 *
 * La forma del corpo la costruisce `buildApprovedWcDeleteInputs` in srv/lib/approvedWcRules.js,
 * unico punto — e rifiuta una chiave che non sia un intero positivo, perche' `Number(null)` e' `0`,
 * che e' un intero, e una cancellazione con la chiave sbagliata colpisce l'oggetto di un altro.
 *
 * `0` SPEGNE LA SCRITTURA e non il rilevamento: l'eccesso viene misurato e dichiarato comunque
 * (DEC-71). E' il kill-switch, non il default.
 */
const DS_APPROVED_WC_DELETE = Number(process.env.PLEX_DS_APPROVED_WC_DELETE || 755);

/**
 * `Part_Attribute_Upload` — carica un attributo su una part. SCRITTURA.
 * Usata dalla action `uploadPartAttribute`, dichiarata prova temporanea e senza chiamanti nella UI.
 */
const DS_PART_ATTRIBUTE = Number(process.env.PLEX_DS_PART_ATTRIBUTE || 20793);

/**
 * Le sole Data Source che si possono invocare senza conseguenze sul tenant. Serve al test di
 * connessione, che deve dimostrare l'autenticazione e non lasciare tracce: la sonda si sceglie da
 * qui, mai fra le cinque che scrivono.
 */
const READ_ONLY = Object.freeze([
  DS_GET_JOB_KEY, DS_GET_JOB_OPS, DS_GET_JOB_BOM,
  DS_PART_KEY, DS_PART_OPERATION_KEY, DS_WORKCENTER_KEY
]);

module.exports = {
  DS_GET_JOB_KEY,
  DS_GET_JOB_OPS,
  DS_UPDATE_JOB_OP_STATUS,
  DS_GET_JOB_BOM,
  DS_UPDATE_JOB_BOM,
  DS_JOB_SORT_ORDER,
  DS_JOB_STATUS_UPDATE,
  DS_PART_ATTRIBUTE,
  // [WC-SUBTRACT]
  DS_PART_KEY,
  DS_PART_OPERATION_KEY,
  DS_WORKCENTER_KEY,
  DS_APPROVED_WC_DELETE,
  READ_ONLY
};

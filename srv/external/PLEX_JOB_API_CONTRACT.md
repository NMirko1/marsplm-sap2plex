# Contratto della Job Scheduling API di Plex (`/scheduling/v1/jobs`)

Recuperato il **19/08/2026** dal portale sviluppatori di Plex, versione `v1` (alcune operazioni sono
solo `v1-beta1`; ultima modifica lato Plex 13/08/2026). È il **secondo contratto Plex versionato in
questo repo**, dopo [PLEX_BOM_API_CONTRACT.md](PLEX_BOM_API_CONTRACT.md).

**Aggiornato il 23/08/2026** con `JobBomComponentCommand` e `JobOperationDTO`, i due schemi che la
0025 ha reso necessari. Sono anche una lezione su questo documento: entrambe le operazioni erano
elencate qui sotto come «non usate», e la seconda con la motivazione sbagliata — «si passa dalla Data
Source», che non poteva funzionare perché la `4701` restituisce un intero e il body ne vuole un UUID.
Un contratto versionato serve a questo: la 0025 stava per essere disegnata sul presupposto che una
distinta di job non fosse scrivibile, e la riga che smentiva il presupposto era già in questo file.

Serve a chiudere una lacuna che è costata un errore in esercizio. Fino a oggi il contratto dei job
non esisteva da nessuna parte: le tabelle di [docs/0009](../../docs/0009-job-plex-e-consuntivazioni.md)
e di [specs/0012/04-contracts.md](../../specs/0012-spacchettamento-ordini/04-contracts.md) elencano i
campi **ricavati dal codice funzionante**, cioè quelli che il progetto manda — non quelli che Plex
pretende. La differenza si è vista il 19/08/2026, quando il passo P1 dello spacchettamento ha risposto:

```json
{ "code": "REQUEST_VALIDATION_FAILED",
  "errors": [ { "code": "ARGUMENT_INVALID",
                "metadata": { "argument": "JobType",
                              "explanation": "The JobType field is required." } } ] }
```

`jobType` era stato collegato dalla [W1-25](../../docs/GAP-WAVE1-BBP.md) al solo `POST`, dove il
contratto lo dichiara **opzionale**. Nel `PUT` è **obbligatorio**. Vedi
[DEC-77](../../docs/DECISIONI.md).

## Come rileggerlo

Il portale `developers.plex.com` è una single-page app: un `curl` sulla pagina restituisce
`Loading...`. Dietro c'è un'API di documentazione interrogabile **senza autenticazione**:

```bash
# il catalogo completo: 71 API, ognuna con le sue operazioni, path e verbi
curl -s https://developers.plex.com/api/documentation/info | jq '.[] | select(.Id=="job-scheduling-api")'

# lo schema di una singola operazione (Versions[0].Document.RequestBody / .Responses)
curl -s https://developers.plex.com/api/documentation/job-scheduling-api/add-job
curl -s https://developers.plex.com/api/documentation/job-scheduling-api/update-job
curl -s https://developers.plex.com/api/documentation/job-scheduling-api/list-jobs
curl -s https://developers.plex.com/api/documentation/job-scheduling-api/get-job
curl -s https://developers.plex.com/api/documentation/job-scheduling-api/list-job-types
```

## Le quindici operazioni

| Verbo | Path | Operazione | Usata dal progetto |
|---|---|---|---|
| `POST` | `/scheduling/v1/jobs` | `add-job` | **sì** — passo 4 del job batch, P3d dello spacchettamento |
| `PUT` | `/scheduling/v1/jobs/{id}` | `update-job` | **sì** — passo 3 del job batch, P1 e R1 dello spacchettamento |
| `GET` | `/scheduling/v1/jobs` | `list-jobs` | **sì** — `?jobNumber=`, ma come **autorità sull'assenza**: P3b (codice libero), R0 dopo una POST non conclusiva, ripiego quando l'UUID non c'è, job TECO |
| `GET` | `/scheduling/v1/jobs/{id}` | `get-job` | **sì** — lettura **primaria** di un lotto che esiste già, dall'UUID salvato in `ZProdOrderPlexMapping.PlexJobId`: A6, sanatorie, passo 2 di «Crea Job in Plex» ([DEC-80](../../docs/DECISIONI.md)) |
| `POST` | `/scheduling/v1/jobs/{id}/backwards-schedule` | `backwards-schedule` | **sì** — passo 5, P2 / P4 / R2 |
| `POST` | `/scheduling/v1/jobs/{id}/bom-components` | `add-update-job-bom` | **sì** — passo 4bis: i componenti che l'ODP ha in più rispetto al ciclo standard ([DEC-86](../../docs/DECISIONI.md)) |
| `POST` | `/scheduling/v1/jobs/{id}/cancel` | `cancel-job` | no — vedi «Cosa non usiamo» |
| `GET` | `/scheduling/v1/jobs/{id}/operations` | `list-job-operations` | **sì** — passo 4bis, per l'UUID della job operation, che la Data Source `4701` **non** restituisce |
| `POST` | `/scheduling/v1/jobs/{id}/operations-schedule` | `schedule-job-operations` | no |
| `GET` | `/scheduling/v1/job-definitions/types` | `list-job-types` | **no** — vedi «Cosa non usiamo» |
| `POST` | `/scheduling/v1-beta1/jobs/{id}/hold` | `hold-job` | no (beta) |
| `POST` | `/scheduling/v1-beta1/jobs/{id}/release-hold` | `release-job-hold` | no (beta) |
| `GET` | `/scheduling/v1-beta1/jobs/{id}/operations/{jobOperationId}` | `get-job-operation` | no (beta) |
| `GET` | `/scheduling/v1-beta1/jobs/{id}/operations/{jobOperationId}/batches` | `list-job-operation-batches` | no (beta) |
| `GET` | `/scheduling/v1-beta1/jobs/{id}/operations/{jobOperationId}/batches/{batchId}` | `get-job-operation-batch` | no (beta) |

## Le due asimmetrie che contano

**1. `jobType` è opzionale in creazione e obbligatorio in aggiornamento.** È l'unica differenza di
obbligatorietà fra i due schemi, ed è quella che ha fatto fallire P1. In `AddJobInput` la descrizione
dice «If no value submitted, the Job Type configured as "default" is assigned to the job»; in
`UpdateJob` quella frase non c'è e il campo è `Required`. Un `PUT` non è una patch: è il modello
intero.

**2. La lettura restituisce esattamente i campi che l'aggiornamento pretende, con gli stessi nomi.**
`jobType`, `buildingId`, `priority`, `earliestStartDateTime`, `dueDate` e `quantity` tornano da
`GET /scheduling/v1/jobs` nella forma in cui il `PUT` li vuole. È il motivo per cui l'eredità della
testata di [DEC-77](../../docs/DECISIONI.md) è una **copia** e non una conversione, e per cui non
serve nessuna lettura in più: quella di A6 c'era già.

## `AddJobInput` — body del `POST /scheduling/v1/jobs`

Risposte: `201 Created`, `400 A validation error has occurred.`

| Campo | Tipo | Obbl. | Descrizione (dal contratto) | Inviato |
|---|---|---|---|---|
| `partId` | string/uuid | **sì** | Identificativo univoco della part | sì |
| `dueDate` | string/date-time | **sì** | Data entro cui l'intera quantità del job va completata | sì |
| `quantity` | number/double | **sì** | Quantità da produrre per completare il job | sì |
| `jobType` | string | no | Job type del job. Setup table «Job Type» (`part.dbo.Job_Type`). Se non inviato, viene assegnato quello di default | sì — AUART, o eredità dal padre nello spacchettamento |
| `externalJobCode` | string | no | Codice del job nel sistema di schedulazione esterno. **Deve essere univoco** | sì — numero ordine SAP, o codice pacchetto |
| `jobNumber` | string | no | Numero che identifica il job | sì — idem |
| `buildingId` | string/uuid | no | Edificio in cui il job viene completato | solo se `PLEX_BUILDING_ID`, o per eredità |
| `priority` | string | no | Priorità. Setup table «Priority (Part)» (`part.dbo.Priority`). Se non inviata, si usa il default | solo se `PLEX_JOB_PRIORITY`, o per eredità |
| `earliestStartDateTime` | string/date-time | no | Prima data di inizio schedulabile | sì — data inizio pianificata SAP, o eredità |
| `jobNumberPrefix` | string | no | Prefisso da anteporre al numero job | solo se `PLEX_JOB_NUMBER_PREFIX` |
| `jobNumberSuffix` | string | no | Suffisso da posporre al numero job | solo se `PLEX_JOB_NUMBER_SUFFIX` |

Nota del contratto sull'operazione: *«Both the job header and job operations are created, but job
operations are not scheduled … Scheduling job operations requires a subsequent API call with the
Backwards Schedule endpoint. Job Status and Job Priority configured as the "default" are assigned to
the job.»* È il fondamento del passo 5 / P2 / P4.

## `UpdateJob` — body del `PUT /scheduling/v1/jobs/{id}`

Risposte: `200 Success`, `400 A validation error has occurred.`, `404 The resource does not exist.`

| Campo | Tipo | Obbl. | Descrizione (dal contratto) | Inviato |
|---|---|---|---|---|
| `dueDate` | string/date-time | **sì** | Data entro cui l'intera quantità dell'operazione va completata | sì — **letta dal job**, TD-8 |
| `quantity` | number/double | **sì** | Quantità da produrre per completare l'operazione | sì |
| `jobType` | string | **sì** | Job type del job. Setup table «Job Type» | **da DEC-77** nello spacchettamento; **NO** al passo 3 del job batch |
| `buildingId` | string/uuid | no | Edificio in cui il job viene completato | per eredità (spacchettamento) |
| `priority` | string | no | Priorità. Setup table «Priority (Part)» | per eredità (spacchettamento) |
| `earliestStartDateTime` | string/date-time | no | Prima data di inizio schedulabile | per eredità (spacchettamento) |

Nota del contratto: *«If the job due date or quantity was changed, requires that job operations are
also updated with a subsequent API call to the Backwards Schedule endpoint.»* È la regola FR-21 dello
spacchettamento, che rischedula dopo ogni variazione di quantità.

> **~~Difetto noto e aperto~~ — CHIUSO.** Fino al 26/08/2026 il passo 3 «Update Job» di
> [srv/jobs/createPlexProductionOrders.js](../jobs/createPlexProductionOrders.js) mandava
> `{ dueDate, quantity }` senza `jobType`, e ogni ri-sincronizzazione di un ordine già presente su
> Plex rispondeva `400`. Oggi il corpo si eredita dal job letto al passo 2 (`inheritedJobFields`),
> quindi porta `jobType`, `buildingId`, `priority` ed `earliestStartDateTime`.
>
> **[ORDER-QTY-SYNC]** Dalla feature 0033 quel `PUT` **parte solo se qualcosa è davvero cambiato** —
> quantità o data di consegna — e la quantità che manda è quella dell'ordine SAP **meno la somma dei
> pacchetti dello spacchettamento**, non `TotalQuantity` intera. Vedi
> [docs/0033](../../docs/0033-riallineamento-quantita-ordine.md) e [DEC-101](../../docs/DECISIONI.md).
>
> **✅ Anche il `500 "Data is Null"` è chiuso, dal 27/08/2026**: Rockwell ha corretto il difetto e la
> correzione è stata verificata sul tenant. L'operazione risponde. Il dossier
> [PLEX_ISSUE_JOB_QUANTITY_UPDATE_500](PLEX_ISSUE_JOB_QUANTITY_UPDATE_500.it.md) resta come traccia
> del caso, con la sua sezione di chiusura.
>
> Attenzione a non leggerlo come «il `PUT` ora parte sempre»: la regola della 0033 **non era un
> aggiramento del difetto**, era un risparmio di chiamate, e resta in vigore. Su un ordine non
> variato quel `PUT` continua a non partire.

## `BackwardSchedule` — body del `POST /scheduling/v1/jobs/{id}/backwards-schedule`

Risposte documentate: `200` (array di `JobOperation`), `400 A validation error has occurred.`,
`404 The resource does not exist.`

| Campo | Tipo | Obbl. | Descrizione (dal contratto) | Inviato |
|---|---|---|---|---|
| `useFirstApprovedWorkcenter` | boolean | no | «Indicates whether operations will be scheduled to first approved workcenter (True) or to all scheduled workcenters (False)». **Esempio del contratto: `false`** | **`false` dal 20/08/2026**, default cablato in `USE_FIRST_APPROVED_WORKCENTER`; era `true`. `PLEX_USE_FIRST_APPROVED_WC=true` riporta al valore precedente |

Descrizione dell'operazione: *«Schedule job operations or reschedule job operations after quantity or
due date on the job have been changed. Job Operation due dates are backwards scheduled based on
**rates** specified in process routing.»*

La riga `JobOperation` che torna con il `200` dichiara i campi su cui il calcolo si appoggia:
`workcenterId`, `workcenterCode`, `setupTime`, **`rate`**, `unitOfMeasure`, `runTime`,
`scheduledStartDate`, `dueDate`, oltre a `jobOperationId` / `jobOperationNumber` / `operationCode`.

> **✅ Il `500` su questa operazione è CHIUSO dal 27/08/2026.** Rockwell ha corretto il difetto e la
> correzione è stata verificata sul tenant: l'operazione risponde. Quel che segue è il racconto del
> caso, e va letto al passato — è la ragione per cui esistono
> [srv/lib/jobScheduleProbe.js](../lib/jobScheduleProbe.js) e il dossier
> [PLEX_ISSUE_BACKWARDS_SCHEDULE_500](PLEX_ISSUE_BACKWARDS_SCHEDULE_500.it.md).
>
> **Il `500` non era nel contratto, e non era un guasto di rete** *(19/08/2026)*. Su un ordine vero
> l'operazione aveva risposto:
>
> ```json
> { "code": "REQUEST_PROCESSING_ERROR",
>   "message": "An unexpected error occurred while processing the request.",
>   "metadata": { "internalMessage": "Data is Null. This method or property cannot be called on Null values." } }
> ```
>
> Gli esiti dichiarati sono tre — `200`, `400`, `404` — quindi un `500` così era un **null non gestito
> dentro Plex**, su un dato che si aspettava di trovare. «Data is Null» è l'involucro **generico** del
> null-deref: dice *che* c'è un null, non *dove*. Ed è la ragione per cui il caso è costato due
> dossier: lo stesso messaggio era comparso anche su `GET /scheduling/v1/jobs?jobNumber=`, e lì la
> causa era **nostra** — cercavamo un job per numero dove andava cercato per id ([DEC-80](../../docs/DECISIONI.md)).
> Un errore generico fa sembrare una sola cosa due problemi che non c'entrano nulla fra loro.
>
> Le sei precondizioni che allora andavano verificate prima di girare il caso — operazioni della part,
> operazioni del job, work center approvati, i loro rate, il building del job, l'ampiezza della
> finestra fra `dueDate` ed `earliestStartDateTime` — restano in
> [srv/lib/jobScheduleProbe.js](../lib/jobScheduleProbe.js) e in
> [docs/0009](../../docs/0009-job-plex-e-consuntivazioni.md) RB-06c. Nessuna di esse era la causa.
>
> Due cose che il progetto **non** manda e che quel calcolo pretende: nessun **rate** (il `POST`
> `approved-workcenters` invia i soli tre id obbligatori, vedi
> [PLEX_APPROVED_WC_API_CONTRACT.md](PLEX_APPROVED_WC_API_CONTRACT.md)) e — fino alla catena
> `plexBuildings` — nessun **`buildingId`** sul job.
>
> E l'API List del cliente annota su questa riga: *«Operator will change the Job Status to Schedule. We
> can ignore this step in Integration»* — cioè il passo 5 è dichiarato **ignorabile** dal documento che lo
> ha richiesto.

## `JobBomComponentCommand` — body del `POST /scheduling/v1/jobs/{id}/bom-components`

Recuperato il **23/08/2026**. Il body è un **array** di `JobBomComponentCommand`: N componenti sono
una chiamata sola. Risposte `200` / `400` / `404`.

L'operazione si chiama **`add-update-job-bom`**, e il nome è la sua garanzia più utile: ripassarci
sopra **aggiorna** invece di duplicare. È ciò che rende sicuro ripetere la chiamata al run
successivo quando la prima non è riuscita ([DEC-86](../../docs/DECISIONI.md)).

| Campo | Tipo | Obbl. | Descrizione (dal contratto) | Inviato |
|---|---|---|---|---|
| **`jobOpId`** | string/uuid | **sì** | «The ID of the Job Operation» | sì — dal `GET /jobs/{id}/operations` |
| **`quantity`** | number/double | **sì** | «Required quantity of the component to produce the end product» | sì |
| `componentPartId` | string/uuid | no | ID della part usata come componente | sì |
| `purchasingItemId` | string/uuid | no | ID del supply item usato come componente | no |
| `minimumQuantity` / `maximumQuantity` / `quantityFixed` | | no | distinte variabili | no |
| **`depletionUnitOfMeasure`** | string | no | unità di consumo, per leggibilità | sì, `STPO-MEINS` |
| **`depletionConversionFact`** | number/double | no | fattore di conversione | sì, `1` |
| `sortOrder` / `position` / `side` / `scaling` / `transferHeat` / `note` | | no | | no |
| **`validate`** | boolean | no | richiede la presenza del materiale prima di produrre | sì, `false` |
| **`autoDeplete`** | boolean | no | consumo automatico alla registrazione | sì, `false` |

**TRE NOMI CAMBIANO RISPETTO ALLA BOM DELLA PART, e valgono un errore a testa.**

| [BOM API](PLEX_BOM_API_CONTRACT.md) (part) | qui (job) |
|---|---|
| `partOperationId` | **`jobOpId`** — e non è lo stesso oggetto: là è la part-operation, qui l'operazione del job |
| `componentId` (in scrittura) | **`componentPartId`** — che sulla part è il nome in *lettura* ([DEC-28](../../docs/DECISIONI.md)) |
| `depletionConversionFactor` | **`depletionConversionFact`**, senza `or` finale |

È il corollario di DEC-28 nella sua forma più pura: il nome di un campo non si deriva **mai** da un
altro contratto, nemmeno quando i due descrivono la stessa cosa. Per questo il progetto ha
`buildJobBomBody` in [srv/lib/orderBomAddRules.js](../lib/orderBomAddRules.js) e non riusa
`plexBomRules.buildCreateBody`; i **valori** invece arrivano da lì, perché quelli sono gli stessi.

`quantity` ha la **stessa dicitura** della `quantity` della BOM della part — «per produrre il
prodotto finito» — quindi è per **unità** e non per lotto. Vale la stessa lacuna dichiarata in
[DEC-68](../../docs/DECISIONI.md): in quale unità Plex la legga resta la domanda aperta.

## `JobOperationDTO` — risposta di `GET /scheduling/v1/jobs/{id}/operations`

Recuperato il **23/08/2026**. Query opzionali: `partOperationType`, `jobOperationStatus`,
`operationCode`, `jobOperationId`, `workcenterId`, `beginScheduledStartDate`,
`endScheduledStartDate`. Risposte `200` / `400` / `404`.

```
jobId · jobNumber · partId · partNumber · partRevision · partNumberRevision ·
jobOperationId · jobOperationNumber · operationCode · workcenterId · workcenterCode ·
quantity · quantityCompleted · dueDate · scheduledStartDate · completedDate ·
jobOperationStatus · setupTime · rate · unitOfMeasure · runTime · batchCriteria ·
partOperationType · batchOperation · preProcessOperation
```

**Perché è servita, dopo essere stata a lungo «non usata».** `jobOpId` del body qui sopra è un
**UUID**, e la Data Source `4701` — da cui il progetto legge le operazioni di un job dai passi 6-7 —
restituisce `Job_Op_Key`, che è un **intero**. I due canali non si parlano: l'unico modo per avere
l'UUID è questo endpoint.

**Il ponte con la part-operation è il NUMERO.** `JobOperationDTO` porta `operationCode` ma **non**
l'`operationId` di catalogo; `PartOperationDTO` porta l'`operationId` ma **non** il codice. Il numero
(`jobOperationNumber` ↔ `operationNumber`) è l'unico campo che i due DTO condividono, ed è per questo
che il piano del passo 2bis viaggia con il numero e non con un id.

## `GET /scheduling/v1/jobs` — lettura per numero

Nessun parametro è obbligatorio. Quelli disponibili: `partId`, `externalJobCode`, `jobNumber`,
`jobStatuses` (ripetibile), `dueDateBegin` / `dueDateEnd`, `buildingId`,
`completedDateBegin` / `completedDateEnd`, `beginEarliestStartDateTime` / `endEarliestStartDateTime`,
`priority`.

**Non esiste un filtro per `jobType`**: chi volesse selezionare per tipo deve filtrare a valle.

Forma della riga (identica per `get-job`):

```json
{ "id": "…", "externalJobCode": "…", "jobNumber": "…", "createdDate": "…",
  "partId": "…", "partNumber": "…", "partRevision": "…", "partNumberRevision": "…",
  "dueDate": "…", "completedDate": "…", "quantity": 0.1, "quantityCompleted": 0.1,
  "jobStatus": "…", "buildingId": "…", "buildingCode": "…", "jobType": "…",
  "earliestStartDateTime": "…", "priority": "…" }
```

`jobNumber` è documentato come «Job number, **including prefix and suffix**»: conferma che il match
per prefisso osservato lato server è nella natura del campo, e che la verifica esatta lato client di
`findJobByExactNumber` ([srv/lib/plexJobSplit.js](../lib/plexJobSplit.js)) non è ridondante.

**La riga è la stessa, l'indirizzo no.** Che `get-job` restituisca la stessa forma è ciò che rende la
lettura per UUID sostituibile a quella per numero *senza* toccare i consumatori: la testata che il
`PUT` di P1 rimanda intera ([DEC-77](../../docs/DECISIONI.md)) viene da lì. Attenzione però a non
leggerlo come «i due indirizzi sono equivalenti»: `?jobNumber=` fa match **per prefisso** e può
servire righe che non sono quella cercata, mentre `/{id}` ne serve una sola e va comunque
**identificata** — se il `jobNumber` che torna non è quello atteso, l'UUID del dizionario punta a un
altro lotto e quella riga si scarta ([DEC-80](../../docs/DECISIONI.md)).

## ✅ CHIUSO — `500 Data is Null`, il caso del 19-20/08/2026

> **Nessuna delle operazioni qui sotto risponde più `500`.** Due erano un difetto di Plex, corretto
> da Rockwell e **verificato sul tenant il 27/08/2026**; la terza **non era un difetto di Plex** —
> era una nostra chiamata sbagliata, corretta prima ([DEC-80](../../docs/DECISIONI.md)). La sezione
> resta perché il caso è istruito e le prove servono a chi ne incontrerà uno simile: si legge al
> passato. I due dossier consegnati sono
> [PLEX_ISSUE_BACKWARDS_SCHEDULE_500](PLEX_ISSUE_BACKWARDS_SCHEDULE_500.it.md) e
> [PLEX_ISSUE_JOB_QUANTITY_UPDATE_500](PLEX_ISSUE_JOB_QUANTITY_UPDATE_500.it.md), entrambi con la
> loro sezione di chiusura.
>
> **La lezione che resta.** «Data is Null» è un involucro generico, e per settimane ha fatto sembrare
> **un solo fenomeno** tre cose di cui una non c'entrava niente con le altre due. Che il messaggio
> fosse identico non era una prova: era un'assenza di informazione, e l'abbiamo trattata come un
> indizio. Da qui il §8 dei due dossier — un `400` che *nomina il campo* è utilizzabile, un `500`
> generico no.

Tre operazioni della Job Scheduling API rispondevano `500` su questo tenant, con lo **stesso** corpo:

```json
{ "code": "REQUEST_PROCESSING_ERROR",
  "message": "An unexpected error occurred while processing the request.",
  "metadata": { "internalMessage": "Data is Null. This method or property cannot be called on Null values." } }
```

| Operazione | Esito il 19-20/08/2026 | Oggi |
|---|---|---|
| `PUT /scheduling/v1/jobs/{id}` | **500** — con il modello intero (6 campi) e con i soli 3 obbligatori | ✅ risponde — difetto Plex corretto |
| `POST /scheduling/v1/jobs/{id}/backwards-schedule` | **500** — body `{"useFirstApprovedWorkcenter": true}` | ✅ risponde — difetto Plex corretto |
| `GET /scheduling/v1/jobs?jobNumber=` · `?partId=` · `?externalJobCode=` | **500** quando esiste una riga da servire; **200** con zero righe | ⚠️ **non era Plex**: la chiamata era nostra e sbagliata, il job si legge per **id** |
| `POST /scheduling/v1/jobs` | **201** | invariato |
| `GET /scheduling/v1/jobs/{id}` | **200** | invariato |
| Data Source `4216`, `4701`, `20051`, `10603`, `239905` sullo stesso job | **200** tutte | invariato |

**Cosa è stato escluso**, un esperimento a variabile singola per volta, su tre job diversi (uno
creato senza building, uno creato dopo la correzione del building, uno creato su tenant e stato
locale **azzerati** il 20/08):

| Variabile | Valori provati | Esito |
|---|---|---|
| `buildingId` | assente · valido (`8b32a82e-2b93-4f70-b9ab-9342e4a61e93`, `Albacina`, unico attivo del tenant) | `500` in entrambi |
| `earliestStartDateTime` | uguale a `dueDate` · **assente** (`null` sul job) | `500` in entrambi |
| Corpo del `PUT` | 6 campi nell'ordine del sample · soli `dueDate` + `quantity` + `jobType` | `500` in entrambi |
| Record del job | preesistente · **creato pochi minuti prima** con building valido | `500` in entrambi |
| `quantity` | stringa `"100.0"` (OData V2) · **numero** `10` come dichiara il contratto | `500` in entrambi |
| `dueDate` | passata / il giorno stesso · **futura** (`2026-08-25`, creato il `2026-08-20`) | `500` in entrambi |
| `priority` | assente · **`"Medium"`**, assegnata dal default del tenant | `500` in entrambi |
| Tenant e stato locale | job preesistenti · **tutto cancellato a mano su Plex e azzerato di qua** | `500` in entrambi |

### Il run del 20/08 su lavagna pulita — ordine `000700000162`, part `3201816`

Cancellati a mano tutti i job sul tenant e azzerato lo stato locale, la sequenza è ripartita da zero.
`POST /scheduling/v1/jobs` con un corpo interamente conforme al contratto:

```json
{"partId":"f88d3fb9-0249-4dcb-ac64-3e16bce7b495","dueDate":"2026-08-25T00:00:00.000Z",
 "quantity":10,"jobNumber":"000700000162","externalJobCode":"000700000162",
 "jobType":"ZP07","buildingId":"8b32a82e-2b93-4f70-b9ab-9342e4a61e93"}
```

`201`, e la riga restituita è quella di un record **sano**: `jobStatus: "New"`,
`buildingCode: "Albacina"`, `jobType: "ZP07"` (il valore inviato, memorizzato tale e quale),
`priority: "Medium"` dal default del tenant, `unit: "pcs"`, `quantity: 10`. Le **quattro** operazioni
del ciclo sono state create e si leggono tutte dalla Data Source `4701` (`Job_Key 5030152`,
`Job_Op_Key 16077979`…`16077982`, op `10`/`20`/`30`/`40`), la `10603` restituisce le righe BOM di
ognuna e la `239905` chiude con *«Job Sort Order Updated Successfully»*.

Su quel job, nello stesso minuto:

```
POST /scheduling/v1/jobs/04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f/backwards-schedule
{"useFirstApprovedWorkcenter":true}                                      -> 500 Data is Null

PUT  /scheduling/v1/jobs/04e6a16b-…
{"dueDate":"2026-08-25T00:00:00Z","quantity":5,"buildingId":"8b32a82e-…",
 "jobType":"ZP07","priority":"Medium"}                                   -> 500 Data is Null
PUT  /scheduling/v1/jobs/04e6a16b-…
{"dueDate":"2026-08-25T00:00:00Z","quantity":5,"jobType":"ZP07"}         -> 500 Data is Null
```

Il secondo `PUT` porta **esattamente i tre campi obbligatori** di `UpdateJob`, tutti valorizzati e
tutti coerenti con la riga che la `GET` per id restituisce, su un job che Plex ha creato pochi minuti
prima rispondendo `201`. Non resta nessuna variabile lato chiamante.

### Le sei precondizioni lette sul job che ha fallito — `jobScheduleProbe`, 20/08/2026

`window.jobSchedProbe('000700000162')` sullo stesso job, subito dopo il `500`. **Una sola
precondizione vuota su sei**, e una non verificabile:

| Precondizione | Esito | Misura |
|---|---|---|
| `PART-OPS` | `[OK]` | la part ha 4 operazioni di ciclo |
| `JOB-OPS` | `[OK]` | il job ha 4 operazioni |
| `APPROVED-WC` | `[OK]` | **4 righe approvate**, una per operazione |
| `RATE` | `[VUOTO]` → **`[OK]` dopo la prova** | prima: nessuna delle 4 righe portava un rate. Riempiti a mano sul tenant (vedi sotto), la sonda legge **4/4 con rate** e il `backwards-schedule` risponde **ancora `500`** |
| `BUILDING` | `[OK]` | `Albacina` |
| `FINESTRA` | `[IGNOTO]` | non misurabile: `earliestStartDateTime` è `null` sul job perché il campo — **opzionale** nel contratto — non è stato inviato, e in SAP `MfgOrderPlannedStartDate` = `MfgOrderPlannedEndDate` = `2026-08-25`, cioè ampiezza zero all'origine |

I work center approvati **esistono**: quel ramo non era vuoto, era privo di rate. Il progetto non ne
scrive nessuno — al `POST approved-workcenters` manda i soli tre id obbligatori — e
`standardProductionRate` / `setupTime` sono campi **facoltativi** di quel `POST`, presenti alla riga 7
del foglio `Part Operation` dell'API List e oggi non inviati.

### Il rate è stato riempito a mano, e non era la causa — ordine `000700000163`, 20/08/2026

Sul tenant, schermata `Engineering / ApprovedWorkcenter` (`PartKey=5097153`, un
`PartOperationKey` per operazione: `29632992`, `29632993`, `29632994`, `29632995`), riempiti
`Setup (hrs)`, `Standard Rate`, `Ideal Rate`, `Target Rate` e `Crew` a `1` su **tutte e quattro** le
righe, con `Schedule` spuntato. La `GET /production/v1/production-definitions/approved-workcenters?partId=f88d3fb9-…`
ora restituisce:

```
op10/LFE10  : standardProductionRate=1, idealRate=1, targetRate=1, setupTime=1, crewSize=1, sequenceRate=null
op20/LFE60  : idem        op30/LFE220 : idem        op40/LFE160 : idem
```

`window.jobSchedProbe('000700000163')` dichiara `RATE [OK] — 4/4 con rate` e **nessuna precondizione
dimostrata vuota**. Il `POST …/backwards-schedule` su un job nuovo, creato dopo la modifica, risponde
**ancora `500 Data is Null`**. Il rate è quindi **escluso**, e con esso l'ultima delle sei
precondizioni che il progetto poteva influenzare.

`sequenceRate` resta l'unico campo rate `null`, e la schermata di Plex **non lo espone**: non c'è modo
di valorizzarlo dalla UI del tenant.

**Cosa resta non provato, in tutto il dossier**: un `earliestStartDateTime` **strettamente precedente**
alla consegna. Sono stati provati «uguale a `dueDate`» e «assente», entrambi `500`; una finestra di
ampiezza **positiva** mai, perché su questi ordini SAP consegna inizio e fine coincidenti — e il
progetto, correttamente, non manda un vincolo di ampiezza zero. E il ramo
`useFirstApprovedWorkcenter: false`, che l'API List del cliente suggerisce e che il progetto non ha
mai esercitato.

**Un valore di quella variabile resta non provato**: una finestra **vera** (`earliestStartDateTime`
strettamente precedente a `dueDate`). Il 19/08 sono stati provati «uguale a `dueDate`» e «assente»,
entrambi `500`; una finestra di ampiezza positiva no, perché su questi ordini SAP consegna inizio e
fine coincidenti. Resta comunque che il contratto dichiara il campo opzionale e la schedulazione a
rovescio dalla sola consegna come comportamento previsto, quindi un `500` su un opzionale assente è
un difetto a prescindere.

Nella stessa zona restano gli altri nulli che il progetto non popola e non può popolare dal payload:
`quantityCompleted: null` e `bomSubstitutionAllow: null` sulla riga del job, e — nuovo il 20/08 — le
righe BOM dell'operazione `10` con `Child_Unit: "m"` e quantità `0.225` / `0.074` su una part in
`pc`, con `Unit_Conversion_Key: null`, cioè una conversione di unità di misura assente proprio dove
il `backwards-schedule` dichiara di restituire un `unitOfMeasure`.

Esempio completo, job `530300a8-6f39-4a75-91a9-ce1c26bbf1cf` (`jobNumber` `000700000201`), creato con
`201` e letto con `200`:

```
PUT /scheduling/v1/jobs/530300a8-…
{"dueDate":"2026-08-19T00:00:00Z","quantity":90,"jobType":"ZP07"}        -> 500 Data is Null
GET /scheduling/v1/jobs/530300a8-…                                       -> 200
```

La riga restituita dalla `GET` porta due valori nulli dove un `0` sarebbe la risposta attesa —
`"quantityCompleted": null` su un job `New` senza produzione, e `"bomSubstitutionAllow": null` mentre
la scheda del job sul portale mostra **BOM Substitution Allowed spuntato**: l'API restituisce `null`
dove la UI ha un valore. Ed è nulla anche l'unica precondizione della schedulazione che il progetto
non popola: **nessuna** delle 16 righe di `approved-workcenters` della part porta `rate`, `setupTime`,
`idealRate`, `targetRate` o `sequenceRate`, mentre la descrizione del `backwards-schedule` dichiara
che le date si calcolano «based on **rates** specified in process routing».

Le tre operazioni che cadevano erano quelle che leggono o ricalcolano la **schedulazione**; la
creazione, la lettura per id e le cinque Data Source sullo stesso job lavoravano. Sembrava un indizio,
ed era una coincidenza: le due di scrittura erano un difetto di Plex, la `GET` con filtro no. Un `GET`
che risponde `500` non è comunque un esito previsto dal contratto, che su `list-jobs` dichiara
`200`/`400`.

Perimetro della raccolta: `grep -rn "SPLIT-TRACE\|JOB-SCHED-PROBE"`. Le due sonde che l'hanno prodotta
sono `window.splitJobProbe('<ordine>')` ([srv/lib/splitJobReadProbe.js](../lib/splitJobReadProbe.js))
e `window.jobSchedProbe('<ordine>')` ([srv/lib/jobScheduleProbe.js](../lib/jobScheduleProbe.js)).

## Cosa non usiamo, e che risponde a domande aperte

- **`GET /scheduling/v1/job-definitions/types`** — l'elenco dei job type **censiti sul tenant**. Ogni
  voce porta `type` (il nome), `default` (booleano: qual è quello assegnato quando non si manda
  niente) e i flag di comportamento (`reworkType`, `scrapType`, `subcontract`, `includeInMRP`, …),
  più `jobNumberPrefix` / `jobNumberSuffix` propri del tipo. È la risposta diretta al punto ancora
  aperto della W1-25 — *quali AUART Plex accetta davvero* — e la stessa forma di problema di
  [DEC-76](../../docs/DECISIONI.md): l'elenco è del **tenant**, non del contratto. Una `curl` con le
  credenziali del plant dice in un colpo se i tipi ordine SAP di Albacina esistono su Plex o se il
  progetto sta mandando nomi che Plex non conosce.
- **`POST /scheduling/v1/jobs/{id}/cancel`** e le due beta `hold` / `release-hold` — la chiusura
  tecnica passa dalla Data Source `23101` «Update Job Status» ([0023](../../docs/0023-teco-verso-plex.md)),
  non da `cancel`: sono cose diverse, e `cancel` non è stato valutato. La 0025 l'ha considerato come
  rollback compensativo del passo 4bis e l'ha **scartato**: mai provato su questo tenant, e un
  annullamento fallito lascerebbe uno stato peggiore di quello che vuole correggere
  ([DEC-86](../../docs/DECISIONI.md)).

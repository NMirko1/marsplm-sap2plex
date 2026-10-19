# Contratto — Approved Workcenter API di Plex

Recuperato il **19/08/2026** dal portale sviluppatori di Rockwell. Gemello di
[PLEX_BOM_API_CONTRACT.md](PLEX_BOM_API_CONTRACT.md); tutti gli altri documenti di `srv/external/`
sono contratti SAP.

Serve a rispondere una volta per tutte alla domanda che ha generato la
[DEC-78](../../docs/DECISIONI.md): **come si toglie un work center approvato da una part-operation?**
La risposta è che sulla Connect API **non si può**, e va scritta qui perché non è deducibile — le
altre due aree già consumate (distinta, part-operation) hanno tutte un verbo di aggiornamento, e
l'assenza qui sembra una dimenticanza di chi ha scritto il codice invece che una proprietà dell'API.

## Come rileggerlo

`developers.plex.com` è una SPA che un `curl` non rende, ma dietro ha un'API di documentazione
**senza autenticazione**:

```bash
# il catalogo delle 71 API, con path e verbi di ogni operazione
curl -s https://developers.plex.com/api/documentation/info | jq '.[] | select(.Id=="production-operations-management-api")'

# lo schema di una singola operazione, campo per campo
curl -s https://developers.plex.com/api/documentation/production-operations-management-api/list-approved-workcenters
curl -s https://developers.plex.com/api/documentation/production-operations-management-api/create-approved-workcenter
```

Per verificare che non esista un verbo di rimozione **non** basta cercare nella pagina dell'API: va
cercato in tutto il catalogo, perché un `DELETE` potrebbe stare sotto un'altra area.

```bash
# tutte le operazioni che toccano gli approved workcenter, in tutto il catalogo
curl -s https://developers.plex.com/api/documentation/info \
  | jq -r '.[] | .Id as $a | .Operations[] | select(.Path|test("approved-workcenters")) | "\($a) \(.OperationType) \(.Path)"'

# tutti i DELETE del catalogo, per convincersi che nessuno riguarda questa risorsa
curl -s https://developers.plex.com/api/documentation/info \
  | jq -r '.[].Operations[] | select(.OperationType=="DELETE") | .Path'
```

## Le operazioni, e sono due

API `production-operations-management-api`, base `https://connect.plex.com/production/v1`.

| Operazione | Verbo e path | Usata dal progetto |
|---|---|---|
| `list-approved-workcenters` | `GET /production-definitions/approved-workcenters` | **sì** — passo 8 di `syncRoutingPlexCycle`, per il confronto (DEC-78) |
| `create-approved-workcenter` | `POST /production-definitions/approved-workcenters` | **sì** — stesso passo, per le creazioni |

**Non esiste nient'altro.** Nessun `DELETE`, nessun `PUT`, nessun `PATCH`, nessun `/deactivate`
sulla risorsa — verificato sull'intero catalogo, non solo su questa API. Per confronto: la distinta
ha `POST /engineering/v1/boms/{id}/deactivate` e le part-operation hanno
`PUT /mdm/v1/part-operations/{id}/deactivate`. Qui no.

## Perché la rimozione non è esprimibile

Due proprietà della risorsa, entrambe dallo schema:

1. **La riga non ha un id proprio.** La risposta di `list` non contiene nessun campo identificativo
   della riga: la sua identità **è** la tripla `(partId, partOperationId, workcenterId)`. Non c'è
   quindi un `{id}` da mettere in un path.
2. **Non c'è nessun flag di stato.** Nessun `active`, nessun `status`: non esiste nemmeno la
   disattivazione logica che la distinta e le part-operation hanno.

Da qui la scelta della DEC-78: la rimozione passa dalla **Data Source 755**
`Approved_Workcenter_Delete`, che è anche il canale del solo altro caso di disattivazione del
progetto (DS 4858, DEC-74).

### `GET /production-definitions/approved-workcenters`

Query param, tutti opzionali: `workcenterId`, `partId`, `partOperationId` (uuid).

Risposta `200`: array di `ApprovedWorkcenter`.

| Campo | Tipo | Nota |
|---|---|---|
| `workcenterId` | uuid | |
| `workcenterCode` | string | **input della DS 11835** `Workcenter_Key_Get` |
| `workcenterName` | string | |
| `partId` | uuid | |
| `partNo` | string | **input della DS 1786** `Part_Key_Get_2` |
| `partRevision` | string | **input della DS 1786**, opzionale |
| `partNoRevision` | string | |
| `partOperationId` | uuid | |
| `operationId` | uuid | |
| `operationNo` | int32 | |
| `operationCode` | string | **input della DS 29200** `Part_Operation_Key_Get2` |
| `crewSize`, `standardProductionRate`, `note`, `setupTime`, `idealRate`, `targetRate`, `setupCrewSize`, `sequenceRate` | double / string | non usati |

**I quattro campi in grassetto sono la ragione per cui il progetto conserva la riga remota intera**
(`readApprovedWcRow` in `srv/lib/approvedWcRules.js`): sono gli input delle tre letture che ricavano
le chiavi interne pretese dalla 755. Ciò che si cancella è identificato da **ciò che Plex ha detto**,
non dalla riga locale.

### `POST /production-definitions/approved-workcenters`

| Campo | Obbligatorio | Tipo |
|---|---|---|
| `partId` | **sì** | uuid |
| `partOperationId` | **sì** | uuid |
| `workcenterId` | **sì** | uuid |
| `crewSize`, `standardProductionRate`, `note`, `setupTime`, `idealRate`, `targetRate`, `setupCrewSize`, `sequenceRate` | no | double / string |

Il progetto manda i soli tre obbligatori.

Nota dalla descrizione dell'operazione, che vale la pena conoscere se un giorno si mandassero i
facoltativi: *«Does not follow Rate Display Setting. The standardProductionRate is overwritten to
Operation.Standard_Rate / Part_Operation.Repetitions when Standard Rate Form Display is on and the
Standard Rate is > 0»* — cioè `standardProductionRate` può essere **riscritto dal tenant**, e mandarlo
non garantisce che resti quello.

**Idempotenza**: risponde `400` con un messaggio contenente `already exist` sulla **tripla identica**.
Il progetto lo tratta come skip (`SKIPPED_EXISTS`). Attenzione: due operazioni **diverse** della
stessa part vengono accettate senza un fiato — è la ragione per cui la doppia approvazione vietata
dalla BBP §7.6.2 non si manifestava come errore (DEC-66) e per cui il difetto della DEC-78 restava
invisibile.

## Le chiavi interne: nessun intero sulla Connect API

La DS 755 pretende `Part_Key`, `Part_Operation_Key`, `Workcenter_Key`, tutti `int`. Verificato campo
per campo che la Connect API **non ne restituisce nessuno**:

| Operazione | Campi identificativi |
|---|---|
| `GET /mdm/v1/part-operations` | `id`, `partId`, `operationId` — tutti **uuid** |
| `GET /production/v1/production-definitions/workcenters` | `workcenterId`, `buildingId`, `productionLineId` — tutti **uuid** |
| `GET /inventory/v1/inventory-definitions/parts` | `partId` — **uuid** |
| `GET /mdm/v2/parts/{id}` | `id` — **uuid** |

Per questo la catena della DEC-78 passa da tre Data Source di lettura. Le loro schermate sono la
fonte del contratto — un Data Source non è documentato sul portale — e i loro id stanno in
`srv/lib/plexDataSources.js` con la loro provenienza.

## Cosa non usiamo

- **I campi facoltativi del `POST`** (`crewSize`, `setupTime`, i quattro rate…). Non sono nel field
  mapping e nessuno li ha chiesti; `standardProductionRate` in particolare può essere riscritto dal
  tenant, quindi mandarlo darebbe l'illusione di controllarlo.
- **Il filtro `partOperationId` della `GET`.** Il progetto legge per `partId` — una chiamata per invio
  — e restringe al perimetro del ciclo in memoria: la funzione pura deve **vedere** anche le righe
  fuori perimetro per poterle contare, ed è quel conteggio la prova che il perimetro di DEC-66 ha
  lavorato. Filtrare per part-operation costerebbe una chiamata per operazione e perderebbe quel dato.

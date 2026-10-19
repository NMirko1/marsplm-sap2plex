# Contratto — Process Routings API di Plex (part-operation)

Recuperato il **21/08/2026** dal portale sviluppatori di Rockwell. Terzo della serie, dopo
[PLEX_BOM_API_CONTRACT.md](PLEX_BOM_API_CONTRACT.md) e
[PLEX_APPROVED_WC_API_CONTRACT.md](PLEX_APPROVED_WC_API_CONTRACT.md); tutti gli altri documenti di
`srv/external/` sono contratti SAP.

È l'area che il progetto consuma da più tempo — `syncRoutingPlexCycle` ci scrive le operazioni di
ciclo, `recvOpStep` l'operazione di ricevimento della materia prima — e l'unica delle tre che era
rimasta **senza contratto versionato**. La lacuna è costata: il materiale `000000101600` di Albacina
ha ripetuto lo stesso `POST` rifiutato tre volte fra le 12:26 e le 12:54 del 20/08/2026, e per
diagnosticarlo servivano tre informazioni che stanno tutte qui — quali filtri accetta la lettura,
come si chiama l'id nella risposta, e cosa contiene il corpo di un rifiuto.

## Come rileggerlo

`developers.plex.com` è una SPA che un `curl` non rende, ma dietro ha un'API di documentazione
**senza autenticazione**:

```bash
# l'area, con i suoi 17 endpoint
curl -s https://developers.plex.com/api/documentation/info \
  | jq '.[] | select(.Id=="process-routings-api")'

# lo schema di una singola operazione, campo per campo
curl -s https://developers.plex.com/api/documentation/process-routings-api/list-part-operations
curl -s https://developers.plex.com/api/documentation/process-routings-api/create-part-operation
curl -s https://developers.plex.com/api/documentation/process-routings-api/update-part-operation
```

L'area si chiama **`process-routings-api`** («The Process Routings API is used to manage part
operations»), non «part-operations»: cercarla per il nome dell'oggetto non la trova.

## Gli endpoint dell'area

Base `https://connect.plex.com/mdm/v1`. In grassetto quelli che il progetto usa.

| Verbo | Path | Nel progetto |
|---|---|---|
| **GET** | **`/part-operations`** | `cat-service.js:5463`, `:5818`, `:6093`, `:3607`, `recvOpStep.js`, `jobScheduleProbe.js:466` |
| **POST** | **`/part-operations`** | `cat-service.js:5611` (ciclo), `recvOpStep.js` (ricevimento) |
| **PUT** | **`/part-operations/{id}`** | `cat-service.js:5540`, `:5571` (PASS 1 / PASS 2) |
| **GET** | **`/part-operations/{id}`** | `recvOpStep.js` (riallineamento, feature 0044) |
| **PUT** | **`/part-operations/{id}/deactivate`** | `recvOpStep.js` (ripiego del riallineamento, 0044) |
| GET/PUT | `/part-operations/{id}/description` | — |
| GET/PUT | `/part-operations/{id}/notes` | — |
| GET/PUT | `/part-operations/{id}/production-details` | — |
| GET/PUT | `/part-operations/{id}/scheduling-details` | — |
| GET/PUT | `/part-operations/{id}/storage-details` | — |
| GET | `/operations`, `/operations/{id}` | `getPlexOperations`, `cat-service.js:7566` |

**Non esiste un `DELETE`**, e **non esiste un `PATCH`**. Il `PATCH` di
[DEC-67](../../docs/DECISIONI.md) è della distinta (`/engineering/v1/boms/{id}`), non di quest'area:
sono due contratti diversi e le due forme non si assomigliano.

## `GET /part-operations` — List Part Operations

«List part operations by query parameters.» Tutti i parametri sono **opzionali** e in query:

| Parametro | Tipo |
|---|---|
| `partId` | `string` (uuid) |
| **`operationId`** | `string` (uuid) |
| **`active`** | `boolean` |
| `subOperation` | `boolean` |
| `operationNumber` | `integer` (int32) |

Il filtro **`operationId` esiste**, e il progetto non lo usava: si chiedevano tutte le
part-operation della part e si cercava a mano. Ora la lettura del ricevimento è mirata
(`?partId=…&operationId=…`), e il confronto lato client resta come **conferma** di ciò che è
tornato — un filtro può essere ignorato in silenzio, e questo progetto ci è già cascato
([DEC-49](../../docs/DECISIONI.md)).

Risposta `200`: **array nudo** di `PartOperationDTO` (nessun involucro `value` / `results`).

### `PartOperationDTO`

| Campo | Tipo | Nota |
|---|---|---|
| **`id`** | uuid | **l'id della part-operation**. `partOperationId` **non esiste** nello schema |
| `partId` | uuid | |
| `operationId` | uuid | l'operazione di catalogo del tenant |
| `type` | string | nome del tipo nella tabella di setup del tenant ([DEC-76](../../docs/DECISIONI.md)) |
| `operationNumber` | int32 | **identità funzionale**, non un valore di comodo: vedi §«Il numero è un ponte» |
| **`active`** | boolean | |
| `subOperation` | boolean | |
| `shippable` | boolean | |
| `multiple` | int32 | |
| `netWeight` | number | |

## Il numero è un ponte, e regge perché lo mandiamo noi

`operationNumber` sembra un attributo qualunque della part-operation. Non lo è: è **l'unico** dato con
cui una registrazione di produzione o di scarto che torna da Plex ritrova l'operazione SAP
([DEC-88](../../docs/DECISIONI.md)). Le due letture dello storico lo espongono — osservato il
24 e il 25/08/2026,
[PLEX_PRODUCTION_HISTORY_API_CONTRACT.md](PLEX_PRODUCTION_HISTORY_API_CONTRACT.md) — e Plex restituisce
esattamente il numero che **noi** gli abbiamo scritto qui, prendendolo da
`ZPlexCycleOperation.OperationNumber`.

Quindi il ponte è una **premessa del nostro codice**, non una proprietà di Plex, ed è fragile in un
punto preciso: `operationNumber` è **mappabile** nella scheda «Mappatura Operazioni Plex»
(`ZPlexOpFieldMap`), e una riga di mapping sovrascrive ciò che parte
(`syncRoutingPlexCycle`: `operationNumber: m.operationNumber ?? finalNumber`). Se un plant lo mappa,
Plex conserva **quel** numero e la nostra tabella il proprio: il job `PROD_CONF` non aggancia più
niente e mette **ogni** registrazione in quarantena — il flusso con effetti contabili smette di
registrare. Con `MappingKind = FIXED` il numero diventa lo stesso per tutte le operazioni, e il ponte
lo rifiuta come **ambiguo**.

La riga non viene rifiutata — renderla inerte cambierebbe cosa un plant già configurato manda a Plex —
ma l'allineamento del ciclo la **dichiara** (`OpNumberMapped` nell'esito, e un `console.warn`). La
forma giusta a regime è l'opposta: scrivere in `ZPlexCycleOperation.OperationNumber` il numero
effettivamente mandato, come già si fa per gli **id** ([DEC-70](../../docs/DECISIONI.md),
[DEC-77](../../docs/DECISIONI.md), [DEC-80](../../docs/DECISIONI.md) — l'identità di un oggetto esterno
si memorizza, non si ri-deriva). Non è ancora fatto.

## Due campi che il codice ignorava e che contano

**`id`.** La catena `partOperationId || id || Id` funziona per caduta, ma la grafia del contratto è
`id`: `partOperationId` è solo ciò che `syncRoutingPlexCycle` prova per primo da sempre.

**`active`.** Una part-operation **disattivata torna comunque nella lista** (a meno di filtrare
`active=true`), e finché non la si guardava veniva agganciata come se fosse buona: il dizionario si
scriveva, e il materiale restava senza un'operazione su cui ricevere — in silenzio, per sempre. Il
campo è dichiarato **non obbligatorio**, quindi «assente» va letto come **attiva**: un tenant che
non lo rende non deve far sparire un'operazione che c'è.

## `POST /part-operations` — Create Part Operation

| Campo | Obbligatorio | Tipo |
|---|---|---|
| `partId` | **sì** | string |
| `operationId` | **sì** | string |
| `type` | **sì** | string |
| `operationNumber` | **sì** | integer |
| `subOperation` | no | boolean |
| `shippable` | no | boolean |
| `netWeight` | no | number |
| `standardQuantity` | no | number |

Risposte: `201 Created`, `400 Bad Request`. **Nessun `409`, e nessun ripiego «already exist»**: al
contrario degli approved-workcenter, dove un duplicato è uno skip, qui è un rifiuto secco. È la
ragione per cui la lettura prima della scrittura non è un'ottimizzazione ma una precondizione
([DEC-63](../../docs/DECISIONI.md) punto 2).

Nota che `standardQuantity` è accettato in creazione ma **non compare nel DTO di lettura**: non è
un campo su cui si possa fare un confronto locale/remoto.

## `PUT /part-operations/{id}` — Update Part Operation

| Campo | Obbligatorio |
|---|---|
| `operationId` | **sì** |
| `operationNumber` | **sì** |
| `multiple` | **sì** |
| `type` | **sì** |
| `subOperation` | no |
| `shippable` | no |
| `netWeight` | no |

Il portale annota su `shippable`: «the part should have at least one shippable operation. If not, MRP
calculations are impacted» — una ragione in più perché il riallineamento lo **conservi** invece di
ricostruirlo.

Risposte: `200`, `400`, `404`.

Due assenze che decidono del comportamento del progetto.

**`partId` non c'è**: la part la determina l'`{id}` nel path. Coerente con
[DEC-77](../../docs/DECISIONI.md) — un `PUT` è il modello intero, e l'identità dell'oggetto non entra
nel corpo.

**`operationId` invece C'È, ed è obbligatorio** — riletto dal portale il 01/09/2026,
`UpdatePartOperationDTO`. È la differenza che rende possibile **ripuntare** una part-operation
esistente su un'altra operazione di catalogo con **una sola chiamata**, senza crearne una seconda e
senza disattivare niente: è la strada primaria del riallineamento della
[0044](../../docs/0044-ricevimento-segue-il-customizing.md). Attenzione a cosa il contratto
**non** dice: `operationId` non è dichiarato immutabile, ma nemmeno mutabile. Che il tenant accetti
il ripuntamento è una **premessa**, non un fatto del contratto — il rifiuto plausibile è
`FIELD_REFERENCE_YIELDS_DUPLICATE` — e per questo la 0044 ha un ripiego («crea la nuova, poi
disattiva la vecchia») e **dichiara quale delle due strade ha funzionato**.

**`active` non c'è.** Una part-operation disattivata **non è riattivabile** dalla Connect API:
l'unico verbo di stato è `PUT /part-operations/{id}/deactivate` — **senza corpo**, e la risposta
documentata è **`202`**: accettata, non conclusa. Va in una direzione sola. È la
stessa forma della rimozione di un work center approvato ([DEC-78](../../docs/DECISIONI.md)), che per
quello è dovuta passare da una Data Source. Finché non si trova la Data Source corrispondente,
l'unica cosa onesta che il progetto può fare davanti a un'operazione disattivata è **dirlo** —
`RECV_STATE.EXISTS_INACTIVE`.

`multiple` è obbligatorio in aggiornamento e assente in creazione: `syncRoutingPlexCycle` oggi non
lo manda in nessuno dei due `PUT`, e il tenant finora non ha protestato. Va tenuto d'occhio, non
«corretto» al buio: mandarlo a `0` su un'operazione che ne ha un altro lo azzererebbe.

Dalla [0044](../../docs/0044-ricevimento-segue-il-customizing.md) il riallineamento del ricevimento
lo manda, e lo prende dalla **rilettura** — `GET /part-operations/{id}`, che rende il
`PartOperationDTO` completo. È un **read-modify-write** e non può essere altro: dalla lettura vengono
`multiple`, `netWeight`, `subOperation` e `shippable` invariati, dal customizing e dal catalogo i tre
soli campi che devono cambiare. Se la lettura non rende `multiple`, il `PUT` **non parte**: un corpo
costruito su un default cambierebbe un dato che funzionava, e Plex risponderebbe `200`.

## Il corpo di un rifiuto — `ValidationResponse`

```json
{
  "code": "REQUEST_VALIDATION_FAILED",
  "message": "The request contains data or semantics that fails one or more validation rule(s).",
  "errors": [ { "code": "…", "message": "…" } ]
}
```

`errors[]` ha **solo `code` e `message`**: non c'è un campo `field`. Quale campo Plex contesti sta
scritto **dentro il testo del messaggio** e in nessun altro posto — motivo per cui quel testo non si
può troncare senza perdere la diagnosi. Il `message` di testata è un **involucro fisso**, identico a
ogni rifiuto, e a 200 caratteri di JSON grezzo era l'unica cosa che restava.

Due codici visti su Albacina, e sono fratelli:

| Codice | Cosa significa |
|---|---|
| `FIELD_REFERENCE_NOT_FOUND` | un campo risolto **per nome** contro una tabella di setup del tenant non trova nulla — è il `type: 'Production'` di [DEC-76](../../docs/DECISIONI.md), che su Albacina non esiste |
| `FIELD_REFERENCE_YIELDS_DUPLICATE` | lo stesso tipo di risoluzione ne trova **più d'uno**, oppure la riga che si sta creando esiste già |

Il secondo è **ambiguo per costruzione** e il contratto non lo enumera: nel `POST` di un'operazione
di ricevimento i candidati sono il `type` (nome, risolto contro il tenant) e la coppia
`partId + operationId` (riga già presente). Sono due cause con due rimedi opposti — una si corregge
nel customizing del plant, l'altra non va corretta affatto — e distinguerle richiede di **leggere il
`message`**. Vedi `plexValidationText` in [../srv/lib/recvOpRules.js](../lib/recvOpRules.js).

## Cosa NON è nel contratto

- **L'elenco dei valori di `type`.** È `string` senza `enum`, perché l'elenco è del **tenant**, non
  dell'API: su Albacina `Produzione`, `Ricevere`, `Rework` ([DEC-76](../../docs/DECISIONI.md)).
- **Il comportamento di `active` di default nella lista.** Il parametro esiste; quale sia il default
  quando non lo si passa non è dichiarato. Il progetto **non lo passa** di proposito, perché deve
  vedere anche le disattivate.
- **La paginazione.** Nessun `$top`/`$skip`/cursore dichiarato su `GET /part-operations`.

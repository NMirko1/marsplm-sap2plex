# Contratto — Operation (catalogo operazioni) API di Plex

Recuperato il **21/08/2026** dal portale sviluppatori di Rockwell. Quinto contratto Plex versionato,
dopo [PLEX_JOB_API_CONTRACT.md](PLEX_JOB_API_CONTRACT.md),
[PLEX_BOM_API_CONTRACT.md](PLEX_BOM_API_CONTRACT.md),
[PLEX_APPROVED_WC_API_CONTRACT.md](PLEX_APPROVED_WC_API_CONTRACT.md) e
[PLEX_PART_OPERATION_API_CONTRACT.md](PLEX_PART_OPERATION_API_CONTRACT.md).

È il **catalogo** delle operazioni del tenant: l'elenco che alimenta le cinque tendine «operazione
Plex» del progetto. Non va confuso con la **part-operation**, che è l'istanza di un'operazione del
catalogo su una part: sono due risorse diverse, con due DTO diversi, e il contratto della seconda è
nel documento accanto.

Serve a rispondere a due domande su cui il progetto ha convissuto per mesi senza risposta:

1. **Il tipo di un'operazione lo sa Plex?** Sì: `OperationDTO.type`. Da qui la
   [DEC-84](../../docs/DECISIONI.md) — il `type` che viaggia verso Plex non lo digita e non lo
   configura più nessuno da questa parte.
2. **Perché le colonne «Nome» e «Descrizione» del dialog «Aggiungi Operazioni» sono vuote?** Perché
   `name` e `description` **non esistono nel DTO**. Non è un tenant che non li popola: non sono
   campi di questa risorsa. Il dubbio era già scritto in
   [srv/lib/plexOpSort.js](../lib/plexOpSort.js) («sul tenant Albacina `name` è vuoto su tutte le
   operazioni»), e la risposta non era deducibile da un tenant solo.

## Come rileggerlo

Stessa via degli altri quattro ([DEC-67](../../docs/DECISIONI.md)): `developers.plex.com` è una SPA che
un `curl` non rende, ma dietro ha un'API di documentazione **senza autenticazione**.

```bash
# il catalogo delle 71 API
curl -s https://developers.plex.com/api/documentation/info | jq '.[] | select(.Id=="process-routings-api")'

# lo schema delle due operazioni di questa risorsa, campo per campo
curl -s https://developers.plex.com/api/documentation/process-routings-api/list-operations
curl -s https://developers.plex.com/api/documentation/process-routings-api/get-operation

# per convincersi che non esista un verbo di scrittura: si cerca in TUTTO il catalogo,
# perché una POST potrebbe stare sotto un'altra area
curl -s https://developers.plex.com/api/documentation/info \
  | jq -r '.[] | .Id as $a | .Operations[] | select(.Path|test("/mdm/v1/operations")) | "\($a) \(.OperationType) \(.Path)"'
```

## Le operazioni, e sono due — entrambe in lettura

API `process-routings-api`, base `https://connect.plex.com/mdm/v1`.

| Operazione | Verbo e path | Usata dal progetto |
|---|---|---|
| List Operations | **GET** **`/operations`** | sì — `getPlexOperations` ([srv/cat-service.js](../cat-service.js)) e `loadOperationTypes` ([srv/lib/plexOperationCatalog.js](../lib/plexOperationCatalog.js)) |
| Get Operation | GET `/operations/{id}` | no — la lista intera basta e costa una chiamata sola |

**Non esiste nessun verbo di scrittura**: né `POST`, né `PUT`, né `PATCH`, né `DELETE`, né un
`deactivate` come quello delle part-operation. Cercato in tutto il catalogo delle 71 API, non solo in
questa. Quindi il progetto **non può creare un'operazione** e la scheda del ricevimento dice il vero
quando avvisa che «l'operazione Plex deve già esistere nel tenant Plex: MARS la istanzia sulla part,
non la crea».

## `GET /operations` — List Operations

Nessuna paginazione dichiarata: i quattro parametri sono tutti filtri, quindi il numero di righe che
torna è **l'elenco intero del tenant** (154 su Albacina). È la stessa lettura che
[srv/cat-service.js](../cat-service.js) conta nel log dopo lo scarto dell'involucro.

### Parametri di query — tutti opzionali

| Nome | Tipo | Note |
|---|---|---|
| `id` | string (uuid) | |
| `code` | string | |
| `type` | string | **un valore solo**: non è una lista |
| `inventoryType` | string | |

Il progetto **non spinge** `type` benché esista, e la ragione è una convenzione, non una pigrizia: il
confronto applicato dal filtro per plant è **tollerante** su spazi e maiuscole, mentre quello di Plex
è presumibilmente esatto, e un criterio più tollerante di quello della sorgente non si spinge
([DEC-51](../../docs/DECISIONI.md)). Con un elenco di tipi servirebbero inoltre N chiamate per N tipi,
contro l'unica che serve oggi.

### Risposta `200` — array di `OperationDTO`

**Quattro campi, e sono tutti.** Nessuno è dichiarato obbligatorio.

| Campo | Tipo | Note |
|---|---|---|
| `id` | string (uuid) | è ciò che `POST /part-operations` vuole in `operationId` |
| `code` | string | il codice leggibile: su Albacina `Ricevere kg`, `V090-Sgrassaggio+Verniciatura` |
| `type` | string | **il tipo dell'operazione**, nome risolto contro la tabella di setup del tenant |
| `inventoryType` | string | non consumato dal progetto |

```json
[ { "id": "00000000-0000-0000-0000-000000000000", "code": "string", "type": "string", "inventoryType": "string" } ]
```

### Quel che il DTO NON ha

- **`name`** e **`description`**. `getPlexOperations` li restituisce ancora, sempre `''`, per due
  ragioni dichiarate: la chiave d'ordinamento è `name || code` di proposito
  ([srv/lib/plexOpSort.js](../lib/plexOpSort.js)) e la tendina della configurazione plant compone
  l'etichetta come `code - name`. Nessuna schermata li **mostra** più in una colonna propria: due
  colonne vuote per costruzione si leggono come un dato mancante, non come un dato inesistente.
- **`active`**. A differenza della part-operation, un'operazione del catalogo non dichiara di essere
  attiva o disattivata: se compare nell'elenco è utilizzabile.

## Il collegamento con la part-operation

`type` è **obbligatorio** in `POST /part-operations` e in `PUT /part-operations/{id}`
([PLEX_PART_OPERATION_API_CONTRACT.md](PLEX_PART_OPERATION_API_CONTRACT.md)): non si può smettere di
mandarlo. Ma non è un valore da inventare — è quello che questa risorsa dichiara per l'operazione che
si sta istanziando. La precedenza con cui il progetto lo risolve è in
[DEC-84](../../docs/DECISIONI.md): `remoto → catalogo → ripiego 'Production'`.

Nulla dice che i due `type` siano risolti contro la **stessa** tabella di setup del tenant: il
contratto non lo dichiara né da una parte né dall'altra. È l'ipotesi su cui la DEC-84 poggia, ed è
per questo che il ripiego storico non viene rimosso e che l'origine del valore (`source`) si scrive
nel log — se l'ipotesi fosse falsa, il `400 FIELD_REFERENCE_NOT_FOUND` direbbe quale valore era
stato mandato e da dove veniva.

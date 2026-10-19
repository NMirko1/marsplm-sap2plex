# Contratto — Production History e Container Adjustments API di Plex

Recuperato il **24/08/2026** dal portale sviluppatori di Rockwell. Sesto contratto Plex versionato,
dopo [PLEX_JOB_API_CONTRACT.md](PLEX_JOB_API_CONTRACT.md),
[PLEX_BOM_API_CONTRACT.md](PLEX_BOM_API_CONTRACT.md),
[PLEX_APPROVED_WC_API_CONTRACT.md](PLEX_APPROVED_WC_API_CONTRACT.md),
[PLEX_PART_OPERATION_API_CONTRACT.md](PLEX_PART_OPERATION_API_CONTRACT.md) e
[PLEX_OPERATION_API_CONTRACT.md](PLEX_OPERATION_API_CONTRACT.md).

Sono le **tre letture** del job `PROD_CONF` ([0021](../../docs/0021-registrazioni-plex-documento-materiale.md)):
ciò che Plex ha prodotto, ciò che ha scartato, e le rettifiche di giacenza. Fino a qui l'elenco dei
loro campi era un **commento nel codice** ([srv/lib/plexConfSources.js](../lib/plexConfSources.js)) —
non uno dei contratti versionati — ed è la ragione per cui una domanda che decideva l'intero flusso è
rimasta senza risposta per mesi: vedi §«Il campo che ha fermato tutto».

**Tre e non due.** `container-adjustments` non produce movimenti — la BBP §8.6.2 dice che «non sono
previsti adjustment inventariali da Plex verso SAP» — ma **viene chiamata a ogni run**, con il suo
watermark. Documentarne due su tre lascerebbe scoperta proprio quella su cui non si è deciso niente.

## Come rileggerlo

Stessa via degli altri cinque ([DEC-67](../../docs/DECISIONI.md)): `developers.plex.com` è una SPA che un
`curl` non rende, ma dietro ha un'API di documentazione **senza autenticazione**.

```bash
# il catalogo delle 71 API
curl -s https://developers.plex.com/api/documentation/info

# i tre schemi di questo contratto, campo per campo
curl -s https://developers.plex.com/api/documentation/production-operations-management-api/list-production-entries
curl -s https://developers.plex.com/api/documentation/production-operations-management-api/list-scrap-entries
curl -s https://developers.plex.com/api/documentation/inventory-operations-management-api/list-container-adjustments
```

| Sorgente nostra | `api-id` / `operation-id` | Campi in risposta | Osservata sul tenant |
|---|---|---|---|
| `PROD_ENTRY` | `production-operations-management-api` / `list-production-entries` | 31 | **sì**, 24/08/2026 |
| `SCRAP_ENTRY` | `production-operations-management-api` / `list-scrap-entries` | **17** (il portale ne dichiara 16) | **sì**, 25/08/2026 |
| `CONT_ADJ` | `inventory-operations-management-api` / `list-container-adjustments` | 14 | **no** |

Tutte e tre: **`GET`**, host `https://connect.plex.com`, e nel contratto è documentato **solo il
`200`**.

## Cosa è OSSERVATO e cosa è solo dichiarato

Questo documento è nato leggendo il portale. Due delle tre letture hanno poi risposto per davvero —
`window.plexHistoryProbe()` sul tenant di Albacina, plant 07 — e la differenza fra «il portale dice» e
«l'ho visto» va scritta dove si legge il contratto, perché è la differenza fra una premessa e un fatto.

**Le risposte vere hanno confermato il portale campo per campo**, con **una** correzione: sullo scarto
il numero lotto si chiama **`jobNumber`**, non `jobNo`. Il codice non lo legge — il numero lotto viene
dal *nostro* `ZProdOrderPlexMapping`, che per un pacchetto dello spacchettamento è l'unico a conoscere
il suffisso — ma un contratto che sbaglia un nome è quello che fa perdere un giorno a chi lo usa.

I valori che valgono come prova, perché ognuno chiude una domanda che era aperta:

| Osservato | Cosa dimostra |
|---|---|
| `unit: "pcs"` (produzione) | **non è un'unità di misura SAP**: `MEINS` è `CHAR(3)` maiuscolo. Togliere il ripiego su `ConfirmationUnit` era giusto per ipotesi, e ora lo è per osservazione |
| `lotNo: null` (produzione), assente (scarto) | il `Batch` di 101 e 551 è **vuoto** su questo tenant. Su un materiale a lotti obbligatori SAP rifiuterebbe il movimento: vedi §«Non c'è `lotNo`» e W1-39 in [GAP-WAVE1-BBP.md](../../docs/GAP-WAVE1-BBP.md) |
| `transactionType: "Control Panel Scrap"` | uno dei due valori dichiarati, su uno scarto **con** lotto. Corrobora [DEC-91](../../docs/DECISIONI.md): il discriminante dello scarto post-produzione resta l'assenza di `jobId`, e `"Scrap"` è il valore che ci si aspetta là — non ancora visto |
| `jobCode`: `"000500183460"` (scarto) vs `"500183471"` (produzione) | il numero lotto Plex **non ha un riempimento garantito**: su un job è il numero d'ordine SAP a 12 cifre, su un altro a 9. È la ragione per cui l'ordine si risolve per **UUID** (`jobId`) e non per numero — e chi fosse tentato di confrontarli qui trova scritto perché no |
| `partNumber`: `"3201816"`, `"3201831"` | senza zeri iniziali, mentre il materiale SAP è quello che è. È la ragione per cui il dizionario dei materiali si legge per **UUID** ([DEC-91](../../docs/DECISIONI.md)) |
| `operationNumber: 10` con `operationCode` `"L100-Sacco+Tampone"` e `"V080-Riappensione prodotto"` | il numero **non** sta dentro il codice operazione: sono due campi e due cose. Il ponte verso SAP è il **numero** ([DEC-88](../../docs/DECISIONI.md)), e c'è su **entrambe** le letture — è ciò che rende valutabile la regola «dall'operazione Plex presente alla prima» ([DEC-90](../../docs/DECISIONI.md)) |
| chiavi di deduplica di 106 (produzione) e 108 (scarto) caratteri | i 150 della colonna stanno larghi, e il calcolo del §«La chiave» non era ottimista |

**Il ponte regge perché il numero lo mandiamo NOI.** `operationNumber` è ciò che
`syncRoutingPlexCycle` scrive sulla part-operation (`POST`/`PUT /mdm/v1/part-operations`) prendendolo
da `ZPlexCycleOperation.OperationNumber`, e Plex lo restituisce identico nelle registrazioni. È una
**premessa**, non una proprietà di Plex: vedi la nota in
[PLEX_PART_OPERATION_API_CONTRACT.md](PLEX_PART_OPERATION_API_CONTRACT.md) su cosa succede se un plant
lo mappa.

## Il campo che ha fermato tutto

`partOperationId` è, su tutte e tre le risorse, **l'id della part-operation** — non l'id
dell'operazione nel catalogo del tenant. Lo schema di risposta lo dice così: «*The ID of the part
operation*», e il parametro di query «*UUID of the part operation that was produced*» / «*…that was
scrapped*».

Il job lo confrontava con `ZPlexCycleOperation.PlexOperationId`, che è l'id di **catalogo**: due specie
di UUID che non agganciano mai. Ogni registrazione finiva in quarantena e il flusso con effetti
contabili **non registrava niente in SAP**. Il ponte è il **numero** d'operazione
([DEC-88](../../docs/DECISIONI.md)), che tutte e tre le risorse espongono come `operationNumber`.

È l'esempio che giustifica questo documento: la domanda era di una riga, la risposta stava nello
schema, e per mesi nessuno l'ha letta perché lo schema non era in repo.

---

## `GET /production/v1/production-history/production-entries`

### Parametri di query

| Nome | Tipo | Obbl. | Descrizione |
|---|---|---|---|
| `beginDate` | date-time | **sì** | inizio della finestra temporale |
| `endDate` | date-time | **sì** | fine della finestra temporale |
| `workcenterId` | uuid | no | centro di lavoro dove la transazione è stata registrata |
| `jobId` | uuid | no | lotto di produzione. «*Note that a production job is not necessary to record production. Another scheduling method such as Kanban may have been used.*» |
| `partId` | uuid | no | part prodotta |
| `partOperationId` | uuid | no | part-operation prodotta |

### Risposta `200` — array di `ProductionHistory`

| Campo | Tipo | Max | Mappato in | Note |
|---|---|---|---|---|
| `transactionDate` | date-time | — | `EntryDate` | è l'asse della finestra e del watermark |
| `quantity` | double | — | `YieldQuantity` | |
| `jobId` | uuid | — | `JobId` | **opzionale**: vedi §«jobId non è garantito» |
| `jobCode` | string | 20 | `PlexJobNumber` (via risoluzione) | numero lotto con prefisso e suffisso |
| `jobNo` | string | 20 | — | numero lotto nudo |
| `partOperationId` | uuid | — | `PartOperationId` | **non** è l'operazione di catalogo |
| `operationNumber` | int32 | — | `OperationNumber` | **è il ponte verso l'operazione SAP** |
| `operationCode` | string | 30 | `OperationCode` | |
| `workcenterId` | uuid | — | `WorkcenterId` | |
| `workcenterCode` | string | 50 | — | |
| `serialNo` | string | **25** | `SerialNo` | parte della chiave di deduplica |
| `partId` | uuid | — | — | **serve al Passo 4**: è la chiave del dizionario `ZMatPlexMapping` |
| `partNumber` | string | *non dichiarato* | `PartNumber` | vedi §larghezze |
| `revision`, `partNumberRevision` | string | — | — | |
| `lotNo` | string | 25 | `LotNo` | → `Batch` del documento materiale |
| `lotId` | uuid | — | — | |
| `heatNo` | string | 30 | `HeatNo` | |
| `heatCode` | string | 50 | — | |
| `heatId` | uuid | — | — | |
| `unit` | string | **20** | **non mappato** | **non è un'unità SAP**: il ripiego è stato tolto, vedi §larghezze |
| `trackingNo` | string | **50** | `TrackingNo` | vedi §larghezze |
| `shelfDateTime` | date-time | — | `ShelfDateTime` | → `ShelfLifeExpirationDate` |
| `manufacturedDateTime` | date-time | — | `ManufacturedDateTime` | → `ManufactureDate` |
| `bestByDateTime`, `useByDateTime`, `sellByDateTime` | date-time | — | — | |
| `masterUnitNo` | string | 10 | — | |
| `masterUnitId` | uuid | — | — | |
| `employeeId` | uuid | — | — | vedi §«quel che non mappiamo» |
| `employeeName` | string | — | — | idem |

**Non c'è un identificativo di riga.** È la ragione per cui la chiave di deduplica si **costruisce**
(`jobId|partOperationId|serialNo|transactionDate`) invece di essere letta.

**Non c'è un flag di fine ciclo.** È la ragione per cui «l'ultima operazione» si chiede a SAP e non a
Plex ([0021](../../docs/0021-registrazioni-plex-documento-materiale.md), RB-07).

**Non c'è la rilavorazione.** `ReworkQuantity` è dato morto: nessuna delle tre risorse la espone.

---

## `GET /production/v1/production-history/scrap-entries`

### Parametri di query

| Nome | Tipo | Obbl. | Descrizione |
|---|---|---|---|
| `beginDate` / `endDate` | date-time | **sì** | la finestra |
| `scrapReason` | string | no | «*Setup table "Scrap Reason" (part.dbo.scrap_reason). The reason code which indicates why the material or part was scrapped. 50 characters max.*» |
| `workcenterId`, `jobId`, `partId`, `partOperationId` | uuid | no | come sopra; `jobId`: «*a production job is not necessary to record scrap*» |

### Risposta `200` — 17 campi, OSSERVATI

Il portale ne dichiara 16 e la risposta vera ne porta 17: quello in più è **`jobNumber`**, che sulla
produzione si chiama `jobNo`. L'elenco qui sotto è quello **osservato** il 25/08/2026, in ordine di
comparsa nella risposta:

| Campo | Tipo | Max | Mappato in | Note |
|---|---|---|---|---|
| `transactionDate` | date-time | — | `EntryDate` | l'asse della finestra e del watermark |
| `scrapReason` | string | 50 | `ScrapReason` | **codice della tabella di setup del tenant**, non testo libero — osservato `"RDF_Operatore"`. Non è un `GoodsMovementReasonCode` SAP e non gli viene fatto corrispondere: viaggia nel testo riga |
| `transactionType` | string | (enum, max 19) | `TransactionType` | **due valori documentati**: `Control Panel Scrap` — osservato — oppure `Scrap` |
| `quantity` | double | — | **`ScrapQuantity`** | è l'inversione rispetto alla produzione: qui la quantità è lo scarto, e `YieldQuantity` è forzato a `0` |
| `workcenterId`, `workcenterCode` | uuid / string | 50 | `WorkcenterId` / — | |
| `jobId` | uuid | — | `JobId` | **opzionale**: la sua assenza è il discriminante dello scarto post-produzione ([DEC-91](../../docs/DECISIONI.md)) |
| `jobCode` | string | 20 | — | osservato `"000500183460"`, cioè l'ordine SAP a 12 cifre. Non si usa: vedi la tabella delle prove |
| **`jobNumber`** | string | 20 | — | **si chiama così, non `jobNo`.** Non si legge: il numero lotto viene da `ZProdOrderPlexMapping` |
| `partId` | uuid | — | `PlexPartId` | la chiave del dizionario `ZMatPlexMapping` letto al contrario |
| `partNumber`, `partNumberRevision`, `revision` | string | — | `PartNumber` / — / — | |
| `partOperationId` | uuid | — | `PartOperationId` | **non** è l'operazione di catalogo |
| `operationNumber` | int32 | — | `OperationNumber` | **è il ponte verso l'operazione SAP**, e l'asse del perimetro componenti |
| `operationCode` | string | 30 | `OperationCode` | osservato `"V080-Riappensione prodotto"` |
| `serialNo` | string | 25 | `SerialNo` | la chiave prende il prefisso `S|` |

**Non c'è `unit`**, e ora è osservato. L'unità dello scarto viene dall'ordine SAP, non da Plex — e non
è una scelta di comodo: non esiste un campo da cui prenderla.

**Non c'è `lotNo`**, e ora è osservato — sulla produzione il campo c'è ed è arrivato `null`. Il `Batch`
di 551 e 101 è quindi **vuoto**: un materiale a lotti obbligatori li farebbe rifiutare. È **W1-39** in
[GAP-WAVE1-BBP.md](../../docs/GAP-WAVE1-BBP.md), dove prima non era registrato. Nota per chi lo
affronterà: la strada esiste e non è una lettura nuova — lo scarto porta il `serialNo`, e la
registrazione di produzione dello **stesso** contenitore è già in `ZProdConfPlexEntry` col suo `LotNo`.
Oggi non serve, perché su questo tenant quel campo è nullo anche in produzione.

**Non ci sono** `heatNo`, `heatCode`, `heatId`, `lotId`, `trackingNo`, `masterUnit*`, `employee*` né le
cinque date di shelf life: confermato dalla risposta vera, e i mapper li lasciano vuoti.

---

## `GET /inventory/v1/inventory-history/container-adjustments`

### Parametri di query

| Nome | Tipo | Obbl. | Descrizione |
|---|---|---|---|
| `beginDate` / `endDate` | date-time | **sì** | la finestra |
| `serialNo` | string | no | 25 caratteri, il contenitore rettificato |
| `partId`, `partOperationId`, `locationId` | uuid | no | |
| `adjustmentCode` | string | no | «*Setup table 'Adjustment Reason' (part.dbo.adjustment_reason)*», 50 caratteri |

### Risposta `200` — 14 campi

| Campo | Tipo | Max | Mappato in | Note |
|---|---|---|---|---|
| `adjustmentDate` | date-time | — | `EntryDate` | **non** `transactionDate`: l'asse della finestra ha un altro nome qui |
| `quantity` | double | — | `adjustmentQuantity` | **delta con SEGNO**, positivo o negativo. Vedi sotto |
| `netWeight` | double | — | `NetWeight` | idem, delta con segno |
| `adjustmentCode` | string | **50** | `AdjustmentCode` | codice della tabella di setup; vedi §larghezze |
| `location` | string | 50 | `PlexLocation` | codice della posizione |
| `locationId` | uuid | — | — | |
| `serialNo` | string | 25 | `SerialNo` | la chiave prende il prefisso `A|` |
| `partId` | uuid | — | — | |
| `partNumber` | string | **100** | `PartNumber` | vedi §larghezze |
| `revision` | string | 8 | — | |
| `partNumberRevision` | string | — | — | |
| `partOperationId` | uuid | — | `PartOperationId` | |
| `operationCode` | string | 10 | `OperationCode` | |
| `operationNumber` | int32 | — | `OperationNumber` | il contratto dice «*30 characters max*» su un `int32`: è una svista del portale, il tipo resta intero |

**`jobId` non c'è affatto**, quindi una rettifica non è traducibile in un movimento d'ordine. Si legge,
si persiste con stato `'I'`, e non genera documenti: la BBP §8.6.2 lo esclude e questo chiude il primo
punto aperto della 0021.

**Il delta con segno non ha una colonna.** `mapAdjustment` lo espone come `adjustmentQuantity` e la
INSERT di fase A **non lo scrive**: sopravvive solo dentro `RawJson`. Finché il flusso non produce
movimenti è senza conseguenze, ma è da sapere se un giorno lo si dovesse riprendere — il valore non è
interrogabile senza fare il parsing del JSON.

---

## `jobId` non è garantito, e vale anche per la produzione

Il contratto lo dice sia sulla produzione sia sullo scarto: «*a production job is not necessary to
record production/scrap. Another scheduling method such as Kanban may have been used.*»

Nel nostro flusso una registrazione **senza `jobId`** non risale a un ordine SAP. Oggi il job la scarta
come «record senza identificativo univoco» se il campo è **assente** (la chiave costruita contiene la
stringa `undefined`), e la mette in quarantena se è **`null`**. In entrambi i casi SAP non ne sa nulla.

Per gli **scarti** questo è il discriminante dello scarto **post-produzione** — un pezzo già versato che
viene scartato dopo non ha lotto di lavoro — e su quello si costruisce il Passo 4 della
[0027](../../docs/0027-consuntivazione-registra-una-volta-sola.md). Per le **produzioni** invece è un caso
che il progetto non ha ancora affrontato: se ad Albacina esistessero registrazioni di produzione senza
job, oggi sparirebbero in silenzio.

## Le larghezze: quattro campi nostri sono più stretti del contratto

Confronto fra questo contratto e `ZProdConfPlexEntry` in [db/schema.cds](../../db/schema.cds).

| Campo Plex | Max Plex | Colonna nostra | Esito |
|---|---|---|---|
| `trackingNo` | 50 | `TrackingNo String(50)` | **allargata** (era 40) |
| `adjustmentCode` | 50 | `AdjustmentCode String(50)` | **allargata** (era 40) |
| `partNumber` | 100 | `PartNumber String(100)` | **allargata** (era 50) |
| `unit` | 20 | `ConfirmationUnit String(3)` | **resta 3**, e il ripiego è stato tolto |
| `serialNo` | 25 | `String(40)` | ok, larga |
| `lotNo` | 25 | `String(40)` | ok |
| `heatNo` | 30 | `String(40)` | ok |
| `operationCode` | 30 / 10 | `String(50)` | ok |
| `scrapReason` | 50 | `String(100)` | ok |
| `transactionType` | (enum, max 19) | `String(40)` | ok |
| `location` | 50 | `PlexLocation String(50)` | esatta |
| `jobCode` | 20 | `PlexJobNumber String(40)` | ok |

**Perché contava.** Nessun campo di origine Plex veniva troncato in scrittura, e
[srv/lib/jobSummary.js](../lib/jobSummary.js) dice già perché il difetto non si vedeva in collaudo:
«**sqlite ignora NVARCHAR(n), HANA lo impone**». Su HANA l'INSERT fallito fa cadere l'ingest di quel
plant, il watermark **non avanza**, e la stessa finestra viene riletta e rifallisce a ogni run: una
pillola avvelenata.

**`ConfirmationUnit` non si allarga**, ed è la differenza che conta: è un'unità di misura **SAP**
(`MEINS` è `CHAR(3)`), e il `unit` di Plex non è un'unità SAP. Usarlo come ripiego lo portava nel
documento materiale come `EntryUnit`, dove SAP lo rifiuterebbe. L'unità della consuntivazione è quella
dell'**ordine**; se l'ordine non ce l'ha, il fatto si dichiara.

**E c'è una cintura**: le stringhe di origine Plex vengono troncate alla larghezza di colonna in
scrittura, così un cambio di contratto domani degrada un valore invece di avvelenare la finestra —
tranne `PlexEntryId`, che è la **chiave di deduplica** e non si tronca mai: troncarla fonderebbe due
registrazioni distinte, cioè perderebbe un movimento.

**Il budget della chiave era calcolato su un dato sbagliato.** Il commento nel codice assumeva
`serialNo` a 40 caratteri e stimava il caso peggiore a 139 su 150. Con i 25 del contratto il caso
peggiore è `S|` + 36 + 36 + 25 + 24 + 3 separatori = **124**: la chiave ha più margine di quanto si
credesse.

## Quel che non mappiamo, e non è una dimenticanza

`employeeId` ed `employeeName` esistono sulle production entries e restano fuori: sono **dati
personali**, e [DEC-10](../../docs/DECISIONI.md) li tiene fuori da log e allegati. Se un giorno servissero
per la conferma d'ordine (§11.5 li elenca fra i dati della conferma) è una decisione da prendere, non
un campo da aggiungere.

`workcenterCode`, `partId`, `revision`, `partNumberRevision`, `masterUnit*`, `lotId`, `heatCode`,
`heatId`, `bestByDateTime`, `useByDateTime`, `sellByDateTime`, `locationId` non sono mappati perché non
alimentano nessun campo del documento materiale. **`partId` è l'eccezione da tenere d'occhio**: serve al
Passo 4 della 0027, quindi diventerà mappato.

## I parametri che NON mandiamo, di proposito

`requestPath` invia **solo** `beginDate` e `endDate`. Tutti gli altri filtri — `workcenterId`, `jobId`,
`partId`, `partOperationId`, `scrapReason`, `adjustmentCode`, `locationId` — restano fuori, e non per
pigrizia: un filtro lato Plex farebbe **mentire il watermark**. La finestra risulterebbe letta anche per
i record che il filtro ha escluso, e quelli non tornerebbero mai più — che è esattamente la perdita che
il watermark esiste per prevenire ([DEC-58](../../docs/DECISIONI.md)).

È la prima «ottimizzazione» che viene in mente guardando questi endpoint. Non si fa.

## Quel che il contratto NON dice

- **Nessuna paginazione.** Non c'è `$top`, non c'è un cursore, non c'è un header di conteggio. Quindi
  non c'è modo di sapere se una risposta è **troncata**, e il watermark avanza dopo qualunque `2xx`: se
  Plex applicasse un tetto lato server, il punto di ripresa scavalcherebbe record mai ricevuti. È il
  motivo per cui la finestra ha un'ampiezza massima (`PLEX_CONF_WINDOW_MAX_HOURS`, 24), che è una
  mitigazione e non una soluzione. **Da chiedere a Rockwell.**
- **Nessun codice di errore oltre il `200`.** Cosa risponda una finestra malformata, o troppo ampia, non
  è documentato.
- **Nessun fuso.** `beginDate` ed `endDate` sono `date-time` senza dire in quale fuso il tenant li
  interpreta. Le mandiamo in ISO 8601 UTC.

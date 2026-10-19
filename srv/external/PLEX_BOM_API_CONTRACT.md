# Contratto della BOM API di Plex (`/engineering/v1/boms`)

Recuperato il **18/08/2026** dal portale sviluppatori di Plex, versione `v1` (le operazioni dichiarano
anche `v1-beta1`; ultima modifica lato Plex 13/08/2026). È il **primo contratto Plex versionato in
questo repo**: tutti gli altri documenti di `srv/external/` sono contratti SAP.

Serve a due cose. La prima è smettere di indovinare: fino a W1-06 l'unico contratto noto della distinta
Plex erano i tre campi che il codice mandava, ricavati per osservazione, e in
[cat-service.js](../cat-service.js) vivevano tre commenti «DISCOVERY» che loggavano le risposte per
scoprirne la forma ([DEC-28](../../docs/DECISIONI.md) diceva, correttamente per allora, che «lo schema
della risposta GET non è documentato lato Plex»). La seconda è avere sotto gli occhi, quando si tocca
questa area, i campi che **esistono e non usiamo**: sono le risposte già disponibili per i gap ancora
aperti.

## Come rileggerlo

Il portale `developers.plex.com` è una single-page app: un `curl` sulla pagina restituisce
`Loading...`. Dietro però c'è un'API di documentazione interrogabile **senza autenticazione**, che è
quella che la pagina stessa consuma:

```bash
# il catalogo completo: 71 API, ognuna con le sue operazioni, path e verbi
curl -s https://developers.plex.com/api/documentation/info | jq '.[] | select(.Id=="bom-api")'

# lo schema di una singola operazione (Versions[0].Document.RequestBody / .Responses)
curl -s https://developers.plex.com/api/documentation/bom-api/create-bom-component
curl -s https://developers.plex.com/api/documentation/bom-api/patch-bom-component
curl -s https://developers.plex.com/api/documentation/bom-api/list-bom-components
curl -s https://developers.plex.com/api/documentation/bom-api/get-bom-component
curl -s https://developers.plex.com/api/documentation/bom-api/deactivate-bom-component
```

Lo stesso vale per le altre aree già consumate dal progetto: `process-routings-api`
(`/mdm/v1/part-operations`), `job-scheduling-api` (`/scheduling/v1/jobs*`),
`inventory-operations-management-api` (`/inventory/v1/...`).

## Le cinque operazioni

| Verbo | Path | Operazione | Usata dal progetto |
|---|---|---|---|
| `POST` | `/engineering/v1/boms` | `create-bom-component` | **sì** — creazione di una riga di distinta |
| `PATCH` | `/engineering/v1/boms/{id}` | `patch-bom-component` | **sì** — aggiornamento quantità e flag |
| `GET` | `/engineering/v1/boms` | `list-bom-components` | **sì** — invio idempotente (`partId` obbligatorio, `partOperationId` opzionale) |
| `GET` | `/engineering/v1/boms/{id}` | `get-bom-component` | no |
| `POST` | `/engineering/v1/boms/{id}/deactivate` | `deactivate-bom-component` | **no** — vedi «Cosa non usiamo» |

**Non esiste `PUT`.** Fino a W1-06 il ramo di aggiornamento della quantità mandava
`PUT /engineering/v1/boms/{id}` con un body che portava `partOperationId` e `componentId`: verbo non
previsto e campi che `UpdateBomComponentDto` non ha. Sono i due motivi per cui, con ogni probabilità,
quel ramo non ha mai funzionato — e il ramo era proprio quello su cui W1-05 contava per propagare da
sé la correzione delle quantità alla prima risincronizzazione.

## `AddBomComponentDto` — body del `POST`

| Campo | Tipo | Obbl. | Descrizione (dal contratto) | Inviato |
|---|---|---|---|---|
| `partOperationId` | string/uuid | **sì** | ID della part-operation per cui si crea la riga | sì |
| `componentId` | string/uuid | **sì** | ID della part o del supply item usato come componente | sì |
| `quantity` | number/double | **sì** | Quantità richiesta del componente per produrre il prodotto finito | sì |
| `minimumQuantity` | number/double | no | Quantità minima (distinte variabili) | no |
| `maximumQuantity` | number/double | no | Quantità massima (distinte variabili) | no |
| `quantityFixed` | boolean | no | La quantità è fissa a prescindere da quanto si produce | no |
| **`depletionUnitOfMeasure`** | **string** | no | **Unità di consumo della riga, per leggibilità** | **sì, `STPO-MEINS`** (W1-05) |
| **`depletionConversionFactor`** | **number/double** | no¹ | **Fattore di conversione, se `depletionUnitOfMeasure` è valorizzato** | **sì, sempre `1`** (19/08/2026) |
| `sortOrder` | number/double | no | Ordine di visualizzazione delle righe | no |
| `position` | string | no | Posizione fisica del componente al centro di lavoro | no |
| `side` | string | no | Lato, per le relazioni con le part multi-out | no |
| `scaling` | boolean | no | La quantità scala con la quantità prodotta | no |
| **`validate`** | **boolean** | no | **Richiede la presenza del materiale prima di poter produrre** | **sì, sempre `false`** (W1-05; era `true` fino al 19/08/2026, vedi [DEC-68](../../docs/DECISIONI.md)) |
| **`autoDeplete`** | **boolean** | no | **«Boolean flag to determine if the BOM material should be auto depleted as production is recorded»** | **sì, sempre `false`** (W1-06) |
| `transferHeat` | boolean | no | Trasferisce il numero di colata al contenitore in uscita | no |
| `note` | string | no | Nota libera sulla riga | no |

Il contratto **non dichiara un default** per `autoDeplete` (`Default: null`): non inviarlo significa
lasciare valere il default del tenant, che nessuno ha verificato. È esattamente il gap W1-06, e la
risposta è mandarlo esplicito.

## `UpdateBomComponentDto` — body del `PATCH`

Gli stessi campi del `POST` **meno i tre d'identità**: `partOperationId`, `componentId` e `quantity`
obbligatoria non ci sono. Ogni campo è opzionale, quindi il body porta i soli campi da cambiare:

```
quantity · minimumQuantity · maximumQuantity · quantityFixed · depletionUnitOfMeasure ·
depletionConversionFactor · sortOrder · position · side · scaling · validate · autoDeplete ·
transferHeat · note
```

Il progetto manda `{ quantity, depletionUnitOfMeasure, validate, autoDeplete }` — gli stessi quattro
campi in scope del `POST`, meno l'identità. Aggiungerne altri «per completezza» riscriverebbe valori
che su Plex qualcuno può aver messo a mano.

**L'unità viaggia col `PATCH` ma non lo innesca.** L'azione la decide la sola quantità (perimetro di
W1-06, «le righe già su Plex non si riscrivono»): quando il `PATCH` parte comunque, correggere anche
l'unità costa zero. Conseguenza dichiarata: le righe già su Plex con quantità invariata restano senza
unità di consumo, e vengono **contate** (`UOM_STATE.STALE`) invece di essere date per allineate.

## `BomComponentDto` — risposta di `GET` (lista e per id) e di `POST`/`PATCH`

```
id · partId · partNumber · partRevision · partNumberRevision ·
partOperationId · partOperationCode · partOperationNumber · partOperationType ·
componentPartId · componentPartNumber · componentPartRevision · componentPartNumberRevision ·
componentSupplyItemId · componentSupplyItemNumber · componentUnitOfMeasure ·
quantity · minimumQuantity · maximumQuantity · quantityFixed ·
depletionUnitOfMeasure · depletionConversionFactor · sortOrder · active ·
position · side · scaling · validate · autoDeplete · transferHeat · note
```

Tre cose da notare, tutte già costate qualcosa al progetto:

1. **il componente si chiama `componentPartId` in lettura e `componentId` in scrittura** — stesso
   valore, nome diverso: è [DEC-28](../../docs/DECISIONI.md), e il contratto la conferma. Il corollario
   vale in generale: il nome di un campo in scrittura non si deriva mai da quello trovato in lettura;
2. **`autoDeplete` viene restituito**, quindi il valore di una riga già su Plex è osservabile e la
   verifica di W1-06 non richiede una sonda: la GET che l'invio idempotente fa già è l'oracolo;
3. `componentUnitOfMeasure` è **di sola lettura** e viene dalla part. In scrittura l'unica unità è
   `depletionUnitOfMeasure`, che è l'unità di **consumo**.

   **`depletionUnitOfMeasure` È IL CAMPO IN CUI VA `STPO-MEINS`, e questo contratto da solo non
   basta a saperlo.** Leggendo la sola semantica si conclude il contrario — `componentUnitOfMeasure`
   è l'unità in cui Plex legge `quantity`, quindi valorizzare l'unità di *consumo* non corregge il
   numero — ed è una conclusione che è stata scritta qui prima di essere corretta. A deciderlo è il
   **field mapping concordato**: foglio `3.BOM` di `Ariston_Integration Field Mapping Details`,
   `depletionUnitOfMeasure ← STPO-MEINS`, `In Scope = 1`. Il contratto dice cosa un campo
   *significa*; il field mapping dice cosa ci si *mette*. Vedi [DEC-68](../../docs/DECISIONI.md).

   **Il campo accetta TESTO LIBERO, e non è una deduzione.** Nel foglio `BOM Component` dell'API
   List, lo step `POST Create BOM Component` riporta una risposta realmente catturata (part
   `PILOT_SAMPLE_01`, UUID veri, `componentUnitOfMeasure: "pcs"`, `quantity: 0.10000000`) in cui
   `depletionUnitOfMeasure` torna col segnaposto letterale `"string"` mandato nella richiesta. Plex
   l'ha accettato: il valore non è validato contro l'anagrafica unità del tenant. È la ragione per
   cui una tabella di dizionario UoM SAP → Plex **non serve** e non è stata fatta.

   `depletionConversionFactor` **si manda, e vale `1`** — dal 19/08/2026, e la correzione contiene
   una lezione sul contratto stesso.

   ¹ **Il contratto lo dichiara `Required: false`, il runtime lo impone in coppia.** Un `POST` con la
   sola unità risponde:

   ```
   400 ARGUMENT_INVALID { argument: "DepletionConversionFactor",
     explanation: "DepletionConversionFactor is a required field if value of
                   DepletionUnitOfMeasure is provided." }
   ```

   Quindi il campo `Required` dello schema dice se il campo è obbligatorio *sempre*, non se lo è
   *mai*: le regole **condizionali** non stanno nello schema e si scoprono solo dal runtime. È il
   complemento di [DEC-67](../../docs/DECISIONI.md) — il contratto si legge invece di indovinarlo,
   ma non risponde a tutto, e la parte a cui non risponde la dice Plex per esteso quando rifiuta.

   Fino a quel giorno il progetto mandava l'unità **senza** il fattore, con una motivazione
   scritta e corretta in sé (il fattore vero sta in `MARM`, il foglio lo dà `In Scope = 0`, un `1`
   fisso sarebbe una bugia con le unità alternative). Ma la scelta reale non era fra «fattore
   onesto» e «fattore inventato»: era fra **distinta con fattore `1`** e **nessuna distinta**. Le
   righe non nascevano affatto.

   `1` è l'identità rispetto alla coppia che parte, perché `quantity ← STPO-MENGE` e
   `depletionUnitOfMeasure ← STPO-MEINS` vengono dalla **stessa riga di distinta**. Ciò che resta
   assunto — in quale unità Plex legga `quantity`, cioè **la UOM delle part sul tenant, che nessuno
   ha verificato** e che MARS non imposta — era assunto identico anche prima, per *ogni* componente
   e non solo per quelli in unità alternativa: è la lacuna già dichiarata nel blocco `bomQtyUom`
   del log del ciclo. Vedi [DEC-68](../../docs/DECISIONI.md).

## Cosa non usiamo, e perché vale la pena saperlo

- **`POST /engineering/v1/boms/{id}/deactivate`** — il progetto non lo chiama: un componente **tolto**
  dal ciclo SAP resta sulla distinta Plex per sempre. L'allineamento è additivo, non differenziale.
  È un gap, e questo contratto dice che l'indirizzo per chiuderlo esiste.
- **`POST /scheduling/v1/jobs/{id}/bom-components`** (`JobBomComponentCommand`, Job Scheduling API) —
  ha gli stessi campi della riga di distinta, `autoDeplete` compreso. Il progetto non lo usa perché
  Plex deriva il Job BOM dalla part BOM: conseguenza da tenere presente, il flag corretto vale per i
  job generati **dopo**, non per quelli già a sistema.
- `minimumQuantity` / `maximumQuantity` / `quantityFixed` / `scaling` sono i campi delle **distinte
  variabili**: se il perimetro Ariston le introdurrà, la risposta è qui e non va chiesta a Rockwell.

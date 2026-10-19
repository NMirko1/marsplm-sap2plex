# SAP — Confirmation & Goods Movement: API / Entity / chiamate

Riferimento per il flusso di consuntivazione ordine + movimenti merci (261/551) verso SAP S/4.

> **Vincoli**: il **deep-insert OData non è utilizzabile** → i movimenti vanno come POST con item **piatti** (via FM custom / Integration Suite). Le letture sono **GET query** separate (nessun `$expand`).

## Quadro chiamate

| Fase | API / Servizio | Entity | Chiamata | Campi principali |
|---|---|---|---|---|
| Leggi testata ordine | `OP_API_PRODUCTION_ORDER_2_SRV_0001` | `A_ProductionOrder_2` | GET query (`$filter=ManufacturingOrder eq '…'`) | ← `TotalQuantity`, `ProductionUnit`, `OrderInternalBillOfOperations` |
| Leggi operazioni (ultima op) | idem | `A_ProductionOrderOperation_2` | GET query (`$filter=ManufacturingOrder eq '…'`) | ← `ManufacturingOrderOperation`, `ManufacturingOrderSequence` |
| Leggi componenti | idem | `A_ProductionOrderComponent_2` | GET query (`$filter=ManufacturingOrder eq '…'`) | ← `Reservation`, `ReservationItem`, `Material`, `RequiredQuantity`, `BaseUnit`, `ManufacturingOrderOperation` |
| Movimento (testata) | `API_MATERIAL_DOCUMENT_SRV` / FM-IS | `A_MaterialDocumentHeader` | POST | → `GoodsMovementCode='03'`, `PostingDate`, `DocumentDate`, `MaterialDocumentHeaderText` |
| **Movimento 261** (consumo) | idem | `A_MaterialDocumentItem` | POST (item piatto) | → `GoodsMovementType='261'`, `Material`, `Plant`, `StorageLocation`, `QuantityInEntryUnit`, `EntryUnit`, `ManufacturingOrder`, `Reservation`, `ReservationItem` |
| **Movimento 551** (scarto) | idem | `A_MaterialDocumentItem` | POST (item piatto) | → `GoodsMovementType='551'`, `Material`, `Plant`, `StorageLocation`, `QuantityInEntryUnit`, `EntryUnit`, `CostCenter`, `GoodsMovementReasonCode` |
| Storno movimento | `API_MATERIAL_DOCUMENT_SRV` | `Cancel` / `CancelItem` | POST (function import) | → `MaterialDocument`, `MaterialDocumentYear`, `PostingDate` |
| **Conferma testata** | `API_PROD_ORDER_CONFIRMATION_2_SRV` | `ProdnOrdConf2` | POST (piatta) | → `OrderID`, `IsFinalConfirmation=true`, `ConfirmationYieldQuantity`, `ConfirmationUnit` |
| Storno conferma | idem | `CancelProdnOrdConf` | POST (action) | → `ConfirmationGroup`, `ConfirmationCount` |

## Payload — Movimento 261 (consumo componente)

Testata: `GoodsMovementCode='03'`, `PostingDate`, `DocumentDate`, `MaterialDocumentHeaderText`.

Item (uno per componente con operazione di riferimento ≤ operazione inviata):

| Campo | Valore |
|---|---|
| `GoodsMovementType` | `261` |
| `Material` | componente (`A_ProductionOrderComponent_2.Material`) |
| `Plant` | plant |
| `StorageLocation` | `lgort_from` (config scarto) |
| `QuantityInEntryUnit` | `scrapQty * RequiredQuantity / TotalQuantity` |
| `EntryUnit` | `BaseUnit` del componente |
| `ManufacturingOrder` | ordine |
| `Reservation` / `ReservationItem` | dal componente |

## Payload — Movimento 551 (scarto)

Testata: come sopra (`MaterialDocumentHeaderText` = scrap_reason).

Item:

| Campo | Valore |
|---|---|
| `GoodsMovementType` | `551` |
| `Material` | part_number |
| `Plant` | plant |
| `StorageLocation` | `lgort_from` (config) |
| `QuantityInEntryUnit` | quantity |
| `EntryUnit` | `meins` (da MARA) |
| `CostCenter` | `kostl` (config) |
| `GoodsMovementReasonCode` | `move_reas` (config) |
| `MaterialDocumentItemText` | testo + job_code |

> **[CONF-POSTING] Le tre voci «(config)» di questa tabella hanno un nome e un valore, e sono in
> esercizio dalla feature 0028.** Erano tre colonne della tabella di customizing `ZMEST_LOCATION` della
> soluzione ABAP preesistente dello stesso cliente, riga `TYPE_FLOW = 'SCRAP'` — questo documento fu
> scritto guardandola, quindi non erano segnaposto vaghi ma un riferimento preciso che
> l'implementazione non aveva mai raccolto:
>
> | Voce | Colonna | Valore reale | Dove sta ora |
> |---|---|---|---|
> | `lgort_from` | `LGORT_FROM` | `PROD` | `ZProdConfPostingConfig.ScrapStorLoc` |
> | `move_reas` | `MOVE_REAS` | `0013` | `ZProdConfPostingConfig.ScrapReason` |
> | `kostl` | `KOSTL` | **vuoto su tutte le righe** | **non si configura** |
>
> Il centro di costo **non** è diventato un campo, e non è una dimenticanza: la colonna esiste nel
> precursore e non è valorizzata. Quando si scarica con il riferimento all'ordine la parte ABAP di
> `ZMARS_MATERIAL_DOC_POST` compila i campi mancanti derivandoli dall'ordine e dalle operazioni.
> Il precursore ha anche `HEADER_TXT` (`PLEX Scrap`) e `LATE_SCRAP_TXT` (`Scarto post produzione`),
> che sono gli altri due campi del customizing. Vedi
> [DEC-90](../../docs/DECISIONI.md) e [DEC-91](../../docs/DECISIONI.md), feature
> [0028](../../docs/0028-consumi-e-scarti-configurabili.md).

## Payload — Conferma testata (`ProdnOrdConf2`)

POST piatta, nessun figlio:

| Campo | Valore |
|---|---|
| `OrderID` | ordine |
| `IsFinalConfirmation` | `true` |
| `ConfirmationYieldQuantity` | yield |
| `ConfirmationUnit` | unità |

## Note

- **`GoodsMovementType`** vive sull'entity **item** (`A_MaterialDocumentItem`); l'insert avviene con l'header (`A_MaterialDocumentHeader`), gli item passati piatti (via FM custom/IS — non deep-insert OData).
- **`GoodsMovementCode='03'`** = goods issue (vale sia per 261 sia per 551).
- **Conferma header** (`ProdnOrdConf2` senza `OrderOperation`) = equivalente di `BAPI_PRODORDCONF_CREATE_HDR`; comportamento header da verificare sul sistema.
- Mapping origine ABAP: 261 ← `ZMES_WIP_COMPONENT_GOODSMVT`, 551 ← `ZMES_SCRAP_ORDER_GOODSMVT`/`ZMES_SCRAP_MATERIAL`, conferma ← `ZMES_ORDER_CONFIRM_SCRAP` (tutti `BAPI_GOODSMVT_CREATE` / `BAPI_PRODORDCONF_CREATE_HDR`).

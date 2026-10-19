# BAPI_PRODORD_GET_LIST ↔ A_ProductionOrder_2 — mapping campi testata

Riferimento per chi estrae gli ordini di produzione da S/4 via **RFC** (`BAPI_PRODORD_GET_LIST`,
testata `BAPI_ORDER_HEADER1`, 50 campi) e deve confrontarli con la lettura **OData** già usata dal
job [createPlexProductionOrders.js](../jobs/createPlexProductionOrders.js)
(`OP_API_PRODUCTION_ORDER_2_SRV_0001` → `A_ProductionOrder_2`, 78 campi).

> **Su ECC** il servizio OData non esiste e il BAPI copre solo 27 dei 78 campi dell'entity: per i
> restanti 51 (tabelle sorgente, flag di stato da JEST, FM RFC) vedi
> [ECC_ProductionOrder_Sourcing.md](./ECC_ProductionOrder_Sourcing.md).

> **Come leggere questo documento**: la colonna _Data element_ del lato BAPI è **verificata** (SE11
> su `BAPI_ORDER_HEADER1`). La colonna _Campo DDIC_ del lato OData è **dedotta** da label/quickinfo
> e dai data element proposti in
> [Endpoint_OData_Integration-20260728 (1).md](<./Endpoint_OData_Integration-20260728 (1).md>)
> (§ "Struttura `ZMARS_PROD_ORDER_T_ORDER`", 78 campi) — quel documento la dichiara già come
> **proposta da confermare su CDS/DDIC** e qui manteniamo la stessa cautela. I punti aperti sono
> raccolti in [Checklist di verifica](#checklist-di-verifica-sul-sistema).

## Riepilogo

| Esito | Campi BAPI | Sezione |
|---|:--:|---|
| Corrispondenza diretta (stesso campo DDIC, stesso significato) | 27 | [A](#a-corrispondenza-diretta-27-campi) |
| Corrispondenza con riserva (stesso significato, rappresentazione diversa) | 4 | [B](#b-corrispondenza-con-riserva-4-campi) |
| Non in testata, disponibile su altra entità | 9 | [C](#c-disponibili-su-altre-entità-9-campi) |
| Nessun corrispondente | 10 | [D](#d-nessun-corrispondente-10-campi) |
| **Totale struttura `BAPI_ORDER_HEADER1`** | **50** | |

Fonte dei 78 campi OData: [OP_API_PRODUCTION_ORDER_2_SRV_0001.cds](./OP_API_PRODUCTION_ORDER_2_SRV_0001.cds)
(entity `A_ProductionOrder_2`) — 78 proprietà, allineate 1:1 con l'EDMX.

## A. Corrispondenza diretta (27 campi)

Stesso campo DDIC sottostante e stesso significato funzionale: utilizzabili in modo interscambiabile,
con le sole accortezze di formato indicate.

| # | BAPI_ORDER_HEADER1 | Data element | A_ProductionOrder_2 | Campo DDIC | Note |
|---|---|---|---|---|---|
| 1 | `ORDER_NUMBER` | AUFNR | `ManufacturingOrder` | AUFK/AFKO-AUFNR | chiave; CHAR12 = String(12) |
| 2 | `ORDER_TYPE` | AUFART | `ManufacturingOrderType` | AUFK-AUART | CHAR4 |
| 3 | `PRODUCTION_PLANT` | WERKS_D | `ProductionPlant` | dominio WERKS | vedi [trappola 2](#2-plant-non-è-il-plant-di-produzione) |
| 4 | `PLAN_PLANT` | PLWRK | `Plant` | dominio WERKS | label OData = "Planning Plant" |
| 5 | `MRP_CONTROLLER` | CO_DISPO | `MRPController` | AFKO-DISPO | CHAR3 |
| 6 | `PRODUCTION_SCHEDULER` | FEVOR | `ProductionSupervisor` | AFKO-FEVOR | rinominato in S/4: scheduler → supervisor |
| 7 | `MATERIAL` | MATNR | `Material` | AFPO-MATNR | vedi [trappola 4](#4-lunghezza-di-material) |
| 8 | `ROUTING_NO` | CO_AUFPL | `OrderInternalBillOfOperations` | AFKO-AUFPL | NUMC10 → String(10), zeri a sinistra |
| 9 | `ENTER_DATE` | AUFERFDAT | `MfgOrderCreationDate` | AUFK-ERDAT | |
| 10 | `START_DATE` | CO_GSTRP | `MfgOrderPlannedStartDate` | AFKO-GSTRP | basic start = "planned start" |
| 11 | `START_TIME` | CO_GSUZP | `MfgOrderPlannedStartTime` | AFKO-GSUZP | |
| 12 | `FINISH_DATE` | CO_GLTRP | `MfgOrderPlannedEndDate` | AFKO-GLTRP | basic finish = "planned end" |
| 13 | `FINISH_TIME` | CO_GLUZP | `MfgOrderPlannedEndTime` | AFKO-GLUZP | |
| 14 | `PRODUCTION_START_DATE` | CO_GSTRS | `MfgOrderScheduledStartDate` | AFKO-GSTRS | |
| 15 | `SCHED_START_TIME` | CO_GSUZS | `MfgOrderScheduledStartTime` | AFKO-GSUZS | |
| 16 | `PRODUCTION_FINISH_DATE` | CO_GLTRS | `MfgOrderScheduledEndDate` | AFKO-GLTRS | |
| 17 | `SCHED_FIN_TIME` | CO_GLUZS | `MfgOrderScheduledEndTime` | AFKO-GLUZS | |
| 18 | `ACTUAL_RELEASE_DATE` | CO_FTRMI | `MfgOrderActualReleaseDate` | AFKO-FTRMI | unica data *actual* presente in testata OData |
| 19 | `TARGET_QUANTITY` | GAMNG | `TotalQuantity` | AFKO-GAMNG | QUAN 13,3 = Decimal(13,3) |
| 20 | `SCRAP` | GASMG | `MfgOrderPlannedScrapQty` | AFKO-GASMG | QUAN 13,3 = Decimal(13,3) |
| 21 | `UNIT` | CO_GMEIN | `ProductionUnitSAPCode` | AFKO-GMEIN (MEINS) | **non** `ProductionUnit`: vedi [trappola 3](#3-unità-di-misura-3-campi-odata-per-2-campi-bapi) |
| 22 | `UNIT_ISO` | ISOCD_UNIT | `ProductionUnitISOCode` | ISOCD_UNIT | |
| 23 | `SALES_ORDER` | KDAUF | `SalesOrder` | AFPO-KDAUF | CHAR10 |
| 24 | `SALES_ORDER_ITEM` | KDPOS | `SalesOrderItem` | AFPO-KDPOS | NUMC6 → String(6) |
| 25 | `INT_OBJ_NO` | CUOBJ | `ProductConfiguration` | AFPO-CUOBJ | NUMC18 → String(18) |
| 26 | `ORDER_SEQ_NO` | CY_SEQNR | `OrderSequenceNumber` | seq. number order | NUMC14 → String(14) |
| 27 | `LEADING_ORDER` | CO_LAUFNR | `LeadingOrder` | leading order | CHAR12 |

## B. Corrispondenza con riserva (4 campi)

Il significato coincide, ma **la rappresentazione del dato è diversa**: non confrontabili senza
conversione o senza una conferma su dato reale.

| BAPI_ORDER_HEADER1 | A_ProductionOrder_2 | Perché non è 1:1 | Azione |
|---|---|---|---|
| `PRIORITY` (CO_APRIO, CHAR1) | `ManufacturingOrderImportance` (String(1), quickinfo "Order Importance Code") | terminologia S/4 diversa (*priority* → *importance*); il documento interno riporta data element `n/d` | confermare su un ordine con priorità valorizzata |
| `DELETION_FLAG` (AUFLOEKZ = AUFK-LOEKZ) | `OrderIsMarkedForDeletion` | il BAPI espone il **campo** LOEKZ, l'OData un **flag derivato dallo stato** (DLFL). `OrderIsDeleted` è un altro stato, non LOEKZ | usare `OrderIsMarkedForDeletion`; verificare su un ordine con deletion flag attivo |
| `WBS_ELEMENT` (PS_PSP_PNR, NUMC8 — PSPNR **interno**) | `WBSElementExternalID` (String(24) — POSID **esterno**) | stesso oggetto, chiavi non confrontabili | convertire via `PRPS` (PSPNR → POSID) o conversion exit ABPSP |
| `MATERIAL_EXTERN` (MGV_MATERIAL_EXTERNAL, CHAR40) | `Material` (String(40)) | campo legacy della soluzione *long material number* (MGV/LAMA): popolato solo se attiva; in S/4 il numero a 40 caratteri sta già in `MATERIAL` | ignorare `MATERIAL_EXTERN`, usare `MATERIAL` |

## C. Disponibili su altre entità (9 campi)

Non presenti in `A_ProductionOrder_2`, ma recuperabili — richiedono una lettura aggiuntiva.

| BAPI_ORDER_HEADER1 | Servizio | Entity / campo |
|---|---|---|
| `RESERVATION_NUMBER` (RSNUM) | stesso | `A_ProductionOrderComponent_2.Reservation` (chiave; identico per tutti i componenti dell'ordine) |
| `BATCH` (CHARG_D) | stesso | `A_ProductionOrderItem_2.Batch` (String(10)) — nel BAPI è un campo di posizione appiattito in testata |
| `SYSTEM_STATUS` (CO_STTXT, testo concatenato 40 char) | stesso | `A_ProductionOrderStatus_2` (`StatusCode`, `StatusShortName`, `StatusName`, `IsUserStatus`) via `to_ProductionOrderStatus`; in alternativa i 20 flag `OrderIs*` / `SettlementRule*` di testata |
| `ACTUAL_START_DATE` (CO_GSTRI) | stesso | `A_ProductionOrderOperation_2.OpActualExecutionStartDate` — **approssimazione**: min sulle operazioni |
| `ACTUAL_START_TIME` (CO_GSUZI) | stesso | `A_ProductionOrderOperation_2.OpActualExecutionStartTime` — idem |
| `ACTUAL_FINISH_DATE` (CO_GLTRI) | stesso | `A_ProductionOrderOperation_2.OpActualExecutionEndDate` (max) oppure `A_ProductionOrderItem_2.MfgOrderItemActualDeliveryDate` |
| `CONF_NO` (CO_RUECK) | `OP_API_PROD_ORDER_CONFIRMATIO_2_SRV_0001` | `ConfirmationGroup` |
| `CONF_CNT` (CIM_COUNT) | `OP_API_PROD_ORDER_CONFIRMATIO_2_SRV_0001` | `ConfirmationCount` |
| `MATERIAL_TEXT` (CO_MATXT) | `OP_API_PRODUCT_SRV_0001` / `OP_API_CLFN_PRODUCT_SRV` | `A_ProductDescription` |

Le date *actual* di testata (GSTRI/GLTRI/GSUZI) **non** sono esposte come tali: ricostruirle dalle
operazioni è un'approssimazione, non un'equivalenza.

## D. Nessun corrispondente (10 campi)

| BAPI_ORDER_HEADER1 | Data element | Nota |
|---|---|---|
| `EXPL_DATE` | CO_AUFLD | data esplosione distinta / trasferimento ciclo: non esposta |
| `SCHED_RELEASE_DATE` | CO_FTRMS | l'OData espone solo il rilascio **effettivo** (`MfgOrderActualReleaseDate`, FTRMI) |
| `ENTERED_BY` | AUFERFNAM | l'entity **non ha** `CreatedByUser` (verificato: nessuna delle 78 proprietà) |
| `COLLECTIVE_ORDER` | CO_PRODNET | nessun flag equivalente; **derivabile** da `MfgOrderSuperiorMfgOrder` / `MasterProductionOrder` valorizzati |
| `PROD_SCHED_PROFILE` | CO_PRODPRF | non esposto |
| `CONFIRMED_QUANTITY` | CO_VFMNG | ⚠️ **non** è `MfgOrderConfirmedYieldQty`: vedi [trappola 1](#1-confirmed_quantity-non-è-mfgorderconfirmedyieldqty) |
| `MATERIAL_GUID` | MGV_MATERIAL_GUID | legacy MGV/LAMA |
| `MATERIAL_VERSION` | MGV_MATERIAL_VERSION | legacy MGV/LAMA |
| `DATE_OF_EXPIRY` | CFB_BBD_PPPI | non esposta, né in testata né in `A_ProductionOrderItem_2` |
| `DATE_OF_MANUFACTURE` | CFB_DATOFM | idem |

## Campi OData senza controparte nel BAPI

Utile nella direzione opposta: informazioni che si perdono passando da OData a `BAPI_ORDER_HEADER1`.

`ManufacturingOrderCategory`, `ProductionVersion`, `PlannedOrder`, `MRPArea`, `ManufacturingObject`
(OBJNR), `MfgOrderSuperiorMfgOrder`, `MasterProductionOrder`, `CompanyCode`, `ProfitCenter`,
`BusinessArea`, `FunctionalArea`, `ResponsiblePlannerGroup`, `ActualCostsCostingVariant`,
`PlannedCostsCostingVariant`, `BasicSchedulingType`, `MfgOrderConfirmedYieldQty`, `CustomerName`,
`OrderLongText`, `StorageLocation`, `GoodsRecipientName`, `UnloadingPointName`,
`InventoryUsabilityCode`, `MaterialGoodsReceiptDuration`, `QuantityDistributionKey`, `StockSegment`,
`ProdnProcgIsFlexible`, `LastChangeDateTime`, `MfgOrderCreationTime`, più i 20 flag di stato
(`OrderIsCreated` … `MaterialAvailyIsNotChecked`).

## Trappole

### 1. `CONFIRMED_QUANTITY` non è `MfgOrderConfirmedYieldQty`

Il nome inganna in entrambe le lingue. Il BAPI espone `CO_VFMNG` = *quantità impegnata secondo il
controllo disponibilità (ATP) dei componenti*. L'OData `MfgOrderConfirmedYieldQty` è `IGMNG` =
*quantità buona confermata dalle conferme di produzione*. Sono due grandezze diverse, entrambe
QUAN 13,3: associarle non genera errori tecnici, genera **dati sbagliati e silenziosi**.
Nessuna delle due ha controparte nell'altra fonte.

### 2. `Plant` non è il plant di produzione

In `A_ProductionOrder_2`: `ProductionPlant` = plant di produzione (= `PRODUCTION_PLANT`),
`Plant` = **planning plant** (= `PLAN_PLANT`, PLWRK). Il job attuale filtra correttamente su
`ProductionPlant` ([createPlexProductionOrders.js:124](../jobs/createPlexProductionOrders.js#L124)).
Nei setup mono-plant i due valori coincidono, quindi lo scambio non emerge in test.

### 3. Unità di misura: 3 campi OData per 2 campi BAPI

| Campo OData | Contenuto |
|---|---|
| `ProductionUnit` | formato **esterno**, conversion exit CUNIT applicata (dipendente dalla lingua: interno `ST` → esterno `PC` in EN) |
| `ProductionUnitSAPCode` | codice **interno** grezzo, senza conversione |
| `ProductionUnitISOCode` | codice **ISO** |

Il BAPI `UNIT` (CO_GMEIN) è il codice interno → confrontare con `ProductionUnitSAPCode`;
`UNIT_ISO` con `ProductionUnitISOCode`. Il job legge `ProductionUnit`
([createPlexProductionOrders.js:134](../jobs/createPlexProductionOrders.js#L134)): corretto solo se
PLEX attende il formato esterno.

### 4. Lunghezza di `MATERIAL`

Su S/4 il data element `MATNR` è CHAR40, quindi `BAPI_ORDER_HEADER1-MATERIAL` risulta 40 e coincide
esattamente con `Material` String(40). Se in SE11 la struttura mostra `MATNR` CHAR**18**, si sta
guardando un sistema/reference ECC: da riverificare **sul sistema S/4 target**, altrimenti si
rischia il troncamento sui materiali oltre 18 caratteri.

### 5. NUMC con zeri a sinistra

`ROUTING_NO`, `INT_OBJ_NO`, `ORDER_SEQ_NO`, `SALES_ORDER_ITEM`, `RESERVATION_NUMBER` sono NUMC nel
BAPI e String nell'OData. Confrontare normalizzando (padding o `parseInt`), mai con `===` sulle
stringhe grezze.

### 6. Copertura effettiva del BAPI

`BAPI_PRODORD_GET_LIST` è una lettura di **lista**: non è garantito che valorizzi tutti i 50 campi
della struttura. I campi di posizione appiattiti in testata (`BATCH`, `DATE_OF_EXPIRY`,
`DATE_OF_MANUFACTURE`) e i legacy MGV (`MATERIAL_EXTERN`, `MATERIAL_GUID`, `MATERIAL_VERSION`) sono
tipicamente vuoti. Misurare empiricamente prima di dipenderne.

## Checklist di verifica sul sistema

Punti **non verificabili dai metadati in repo**, da chiudere in SE11 / su dato reale:

- [ ] Lunghezza di `BAPI_ORDER_HEADER1-MATERIAL` sul sistema S/4 target (trappola 4).
- [ ] `PRIORITY` (CO_APRIO) ↔ `ManufacturingOrderImportance`: stessi valori su un ordine con priorità.
- [ ] `DELETION_FLAG` (AUFK-LOEKZ) ↔ `OrderIsMarkedForDeletion`, e cosa valorizza invece `OrderIsDeleted`.
- [ ] Campo DDIC effettivo dietro `ProductionPlant` e `Plant` (AUFK-WERKS vs campo di posizione):
      confermare su un ordine con planning plant ≠ production plant.
- [ ] Quali dei 50 campi `BAPI_PRODORD_GET_LIST` valorizza realmente (trappola 6).
- [ ] Valore del flag `OrderIsReleased`: il job assume `'X'` e la nota nel codice lo segnala come
      da confermare ([createPlexProductionOrders.js:115-118](../jobs/createPlexProductionOrders.js#L115-L118)).

Metodo suggerito: estrarre 5–10 ordini rappresentativi (uno rilasciato, uno con deletion flag, uno
con WBS, uno collective order, uno con materiale > 18 caratteri) dalle due fonti e confrontare i 27
mapping della sezione A normalizzando i NUMC.

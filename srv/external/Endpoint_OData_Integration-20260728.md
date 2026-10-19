# Endpoint OData V2 utilizzati – Integrazione SAP ↔ Mars PLM

**Progetto:** M0005 – Mars PLM SAP-Plex Genga (Ariston)
**Contesto:** Cambio Architettura Integration Suite – Private Cloud OData V2
**Data:** 2026-07-16

## Scopo

Documento di riferimento per il team Integration con l'elenco degli endpoint OData V2
effettivamente consumati, i servizi SAP di appartenenza, le chiavi delle entità e le
operazioni utilizzate.

## Legenda operazioni

- **GET** = lettura della singola entità per chiave → `GET /EntitySet(<chiave>)`
- **QUERY** = lettura della collezione (con `$filter`, `$top`, `$skip`, ecc.) → `GET /EntitySet?$filter=...`
- **POST** = creazione/registrazione di una nuova entità → `POST /EntitySet` con payload
- **FUNZIONE** = Function Import / azione OData V2 → `GET`/`POST /NomeFunzione?param='...'`

La maggior parte degli endpoint è usata in **sola lettura** (GET/QUERY). Fanno eccezione le
operazioni di **scrittura** (POST) e le **azioni** (Function Import) dei servizi Material Document,
Production Order Confirmation e Production Order (chiusura / chiusura tecnica), elencate nelle
sezioni dedicate. I flag SAP indicati sotto confermano i vincoli lato servizio
(`creatable`/`updatable`/`deletable`).

---

## 1. Servizio API_PRODUCT_SRV

**File metadati:** `OP_API_PRODUCT_SRV_0001.edmx`
**Namespace / Container:** `API_PRODUCT_SRV` / `API_PRODUCT_SRV_Entities`
**Path servizio:** `/sap/opu/odata/sap/API_PRODUCT_SRV`

| Entity Set             | Operazioni | Chiave                | N. campi | Vincoli servizio                     |
| ---------------------- | ---------- | --------------------- | -------- | ------------------------------------ |
| `A_Product`            | GET, QUERY | `Product`             | 69       | non cancellabile (`deletable=false`) — la QUERY e' `ZMARS_PRODUCT_QUERYGET`, modello a parte `ZMARS_PRODUCT_SRV.edmx`, criterio `SO_PLANT` (vedi PRODUCT_QUERY_IS.md) |
| `A_ProductDescription` | GET        | `Product`, `Language` | 3        | —                                    |
| `A_ProductPlant`       | GET, QUERY | `Product`, `Plant`    | 48       | non cancellabile (`deletable=false`) |

Esempi:

- `GET /sap/opu/odata/sap/API_PRODUCT_SRV/A_Product('MAT001')`
- `GET /sap/opu/odata/sap/API_PRODUCT_SRV/A_ProductDescription(Product='MAT001',Language='IT')`
- `GET /sap/opu/odata/sap/API_PRODUCT_SRV/A_ProductPlant(Product='MAT001',Plant='1000')`

---

## 2. Servizio API_PRODUCTION_ORDER_2_SRV

**File metadati:** `OP_API_PRODUCTION_ORDER_2_SRV_0001.edmx`
**Namespace / Container:** `API_PRODUCTION_ORDER_2_SRV` / `API_PRODUCTION_ORDER_2_SRV_Entities`
**Path servizio:** `/sap/opu/odata/sap/API_PRODUCTION_ORDER_2_SRV`

| Entity Set                     | Operazioni | Chiave                                                          | N. campi | Vincoli servizio                                      |
| ------------------------------ | ---------- | --------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| `A_ProductionOrder_2`          | GET, QUERY | `ManufacturingOrder`                                            | 78       | non cancellabile                                      |
| `A_ProductionOrderOperation_2` | GET        | `OrderInternalBillOfOperations`, `OrderIntBillOfOperationsItem` | 86       | non creabile, non cancellabile                        |
| `A_ProductionOrderComponent_2` | GET        | `Reservation`, `ReservationItem`                                | 59       | sola lettura (non creabile/aggiornabile/cancellabile) |

Esempi:

- `GET /sap/opu/odata/sap/API_PRODUCTION_ORDER_2_SRV/A_ProductionOrder_2('1000001')`
- `GET /sap/opu/odata/sap/API_PRODUCTION_ORDER_2_SRV/A_ProductionOrder_2?$filter=...`
- `GET .../A_ProductionOrderOperation_2(OrderInternalBillOfOperations='...',OrderIntBillOfOperationsItem='...')`
- `GET .../A_ProductionOrderComponent_2(Reservation='...',ReservationItem='...')`

**Function Import (azioni sull'ordine di produzione):**

| Function Import    | Metodo | Parametri (In)                      | Ritorno           | Descrizione                         |
| ------------------ | ------ | ----------------------------------- | ----------------- | ----------------------------------- |
| `CloseOrder`       | POST   | `ManufacturingOrder` (String ML=12) | `FunctionMessage` | Chiusura ordine (business close)    |
| `TechlyCmpltOrder` | POST   | `ManufacturingOrder` (String ML=12) | `FunctionMessage` | Chiusura tecnica dell'ordine (TECO) |

Esempi (azioni):

- `POST /sap/opu/odata/sap/API_PRODUCTION_ORDER_2_SRV/CloseOrder?ManufacturingOrder='1000001'`
- `POST /sap/opu/odata/sap/API_PRODUCTION_ORDER_2_SRV/TechlyCmpltOrder?ManufacturingOrder='1000001'`

---

## 3. Servizio API_PRODUCTION_ROUTING (CDS v3)

**File metadati:** `sap-s4-OP_API_PRODUCTION_ROUTING_0003-v3.edmx`
**Namespace / Container:** `cds_api_productionrouting_3` / `cds_api_productionrouting_3_Entities`
**Path servizio:** `/sap/opu/odata/sap/API_PRODUCTION_ROUTING`

| Entity Set                    | Operazioni | Chiave                                                                                                                                                               | N. campi | Vincoli servizio               |
| ----------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------ |
| `ProductionRouting`           | GET        | `ProductionRoutingGroup`, `ProductionRouting`                                                                                                                        | 15       | non creabile (da confermare)   |
| `ProductionRoutingHeader`     | GET        | `ProductionRoutingGroup`, `ProductionRouting`, `ProductionRoutingInternalVers`                                                                                       | 24       | non creabile                   |
| `ProductionRoutingMatlAssgmt` | GET, QUERY | `Product`, `Plant`, `ProductionRoutingGroup`, `ProductionRouting`, `ProductionRoutingMatlAssgmt`, `ProductionRtgMatlAssgmtIntVers`                                   | 17       | non creabile, non aggiornabile |
| `ProductionRoutingCompAlloc`  | GET        | `ProductionRoutingGroup`, `ProductionRouting`, `ProductionRoutingSequence`, `ProductionRoutingOpIntID`, `ProdnRtgOpBOMItemInternalID`, `ProdnRtgOpBOMItemIntVersion` | 20       | non creabile                   |
| `ProductionRoutingOperation`  | GET        | `ProductionRoutingGroup`, `ProductionRouting`, `ProductionRoutingSequence`, `ProductionRoutingOpIntID`, `ProductionRoutingOpIntVersion`                              | 119      | non creabile                   |

Esempi:

- `GET /sap/opu/odata/sap/API_PRODUCTION_ROUTING/ProductionRouting(ProductionRoutingGroup='...',ProductionRouting='...')`
- `GET /sap/opu/odata/sap/API_PRODUCTION_ROUTING/ProductionRoutingHeader?$filter=...`
- `GET .../ProductionRoutingMatlAssgmt(Product='...',Plant='...',ProductionRoutingGroup='...',ProductionRouting='...',ProductionRoutingMatlAssgmt='...',ProductionRtgMatlAssgmtIntVers='...')`

---

## 4. Servizio API_CLFN_PRODUCT_SRV (Classificazione prodotto)

**File metadati:** `OP_API_CLFN_PRODUCT_SRV.edmx`
**Namespace / Container:** `API_CLFN_PRODUCT_SRV` / `API_CLFN_PRODUCT_SRV_Entities`
**Path servizio:** `/sap/opu/odata/sap/API_CLFN_PRODUCT_SRV`

| Entity Set              | Operazioni | Chiave                                                                | N. campi | Vincoli servizio                                      |
| ----------------------- | ---------- | --------------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| `A_ProductClass`        | GET, QUERY | `Product`, `ClassInternalID`                                          | 5        | sola lettura (non creabile/aggiornabile/cancellabile) |
| `A_ClfnClassForKeyDate` | GET        | `ClassInternalID`                                                     | 29       | sola lettura (non creabile/aggiornabile/cancellabile) |
| `A_ProductClassCharc`   | GET        | `Product`, `ClassInternalID`, `CharcInternalID`                       | 6        | sola lettura (non creabile/aggiornabile/cancellabile) |
| `A_ProductCharcValue`   | GET        | `Product`, `ClassType`, `CharcInternalID`, `CharcValuePositionNumber` | 23       | sola lettura (non creabile/aggiornabile/cancellabile) |

Esempi:

- `GET /sap/opu/odata/sap/API_CLFN_PRODUCT_SRV/A_ProductClass?$filter=Product eq 'MAT001'`
- `GET /sap/opu/odata/sap/API_CLFN_PRODUCT_SRV/A_ProductClass(Product='MAT001',ClassInternalID='0000001234')`
- `GET /sap/opu/odata/sap/API_CLFN_PRODUCT_SRV/A_ClfnClassForKeyDate('0000001234')`
- `GET /sap/opu/odata/sap/API_CLFN_PRODUCT_SRV/A_ProductClassCharc(Product='MAT001',ClassInternalID='0000001234',CharcInternalID='0000005678')`
- `GET /sap/opu/odata/sap/API_CLFN_PRODUCT_SRV/A_ProductCharcValue(Product='MAT001',ClassType='001',CharcInternalID='0000005678',CharcValuePositionNumber='1')`

---

## 5. Servizio API_CLFN_CHARACTERISTIC_SRV (Caratteristiche)

**File metadati:** `OP_API_CLFN_CHARACTERISTIC_SRV.edmx`
**Namespace / Container:** `API_CLFN_CHARACTERISTIC_SRV` / `API_CLFN_CHARACTERISTIC_SRV_Entities`
**Path servizio:** `/sap/opu/odata/sap/API_CLFN_CHARACTERISTIC_SRV`

| Entity Set                       | Operazioni | Chiave            | N. campi | Vincoli servizio                                                                              |
| -------------------------------- | ---------- | ----------------- | -------- | --------------------------------------------------------------------------------------------- |
| `A_ClfnCharacteristicForKeyDate` | GET, QUERY | `CharcInternalID` | 45       | aggiornabilità/cancellabilità condizionate (`Update_mc` / `Delete_mc`); usato in sola lettura |

Esempi:

- `GET /sap/opu/odata/sap/API_CLFN_CHARACTERISTIC_SRV/A_ClfnCharacteristicForKeyDate?$filter=...`
- `GET /sap/opu/odata/sap/API_CLFN_CHARACTERISTIC_SRV/A_ClfnCharacteristicForKeyDate('0000005678')`

---

## 6. Servizio API_BILL_OF_MATERIAL_SRV (Distinta base)

**File metadati:** `OP_API_BILL_OF_MATERIAL_SRV_0002.edmx`
**Namespace / Container:** `API_BILL_OF_MATERIAL_SRV` / `API_BILL_OF_MATERIAL_SRV_Entities`
**Path servizio:** `/sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV`

| Entity Set    | Operazioni | Chiave                                                                                                                                         | N. campi | Vincoli servizio                                                                            |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `MaterialBOM` | GET, QUERY | `Material`, `Plant`, `BillOfMaterialCategory`, `BillOfMaterialVariant`, `BillOfMaterialVersion`, `EngineeringChangeDocument`, `BillOfMaterial` | 46       | aggiornabile/cancellabile condizionati (`Update_mc`/`Delete_mc`); qui usato in sola lettura |

**Function Import:**

| Function Import | Metodo         | Ritorno                                 | Descrizione                                                  |
| --------------- | -------------- | --------------------------------------- | ------------------------------------------------------------ |
| `ExplodeBOM`    | GET (funzione) | `Collection(DBomheaderforexplosionOut)` | Esplosione della distinta base per assieme / quantità / data |

Parametri `ExplodeBOM` (i primi 7, obbligatori, coincidono con la chiave di `MaterialBOM`):

| Parametro                     | Edm Type       | Obbl. |
| ----------------------------- | -------------- | :---: |
| `BillOfMaterial`              | String ML=8    |   ✓   |
| `BillOfMaterialCategory`      | String ML=1    |   ✓   |
| `BillOfMaterialVariant`       | String ML=2    |   ✓   |
| `BillOfMaterialVersion`       | String ML=4    |   ✓   |
| `EngineeringChangeDocument`   | String ML=12   |   ✓   |
| `Material`                    | String ML=40   |   ✓   |
| `Plant`                       | String ML=4    |   ✓   |
| `BOMExplosionApplication`     | String ML=4    |       |
| `RequiredQuantity`            | Decimal (13,3) |       |
| `BOMExplosionIsLimited`       | Boolean        |       |
| `BOMItmQtyIsScrapRelevant`    | String ML=1    |       |
| `BillOfMaterialItemCategory`  | String ML=1    |       |
| `BOMExplosionAssembly`        | String ML=40   |       |
| `BOMExplosionDate`            | DateTime       |       |
| `BOMExplosionLevel`           | Decimal (3,0)  |       |
| `BOMExplosionIsMultilevel`    | Boolean        |       |
| `MaterialProvisionFltrType`   | String ML=1    |       |
| `SparePartFltrType`           | String ML=1    |       |
| `BOMHeaderBaseUnit`           | String ML=3    |       |
| `FinalPriceIndicator`         | Boolean        |       |
| `BOMExplosionIsAlternatePrio` | Boolean        |       |

Esempi:

- `GET /sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV/MaterialBOM?$filter=Material eq 'MAT001' and Plant eq '1000'`
- `GET .../MaterialBOM(Material='MAT001',Plant='1000',BillOfMaterialCategory='M',BillOfMaterialVariant='01',BillOfMaterialVersion='',EngineeringChangeDocument='',BillOfMaterial='00012345')`
- `GET .../ExplodeBOM?Material='MAT001'&Plant='1000'&BillOfMaterialCategory='M'&BillOfMaterialVariant='01'&BillOfMaterialVersion=''&EngineeringChangeDocument=''&BillOfMaterial='00012345'&RequiredQuantity=1&BOMExplosionDate=datetime'2026-07-28T00:00:00'`

Campi `MaterialBOM` (46, esclusi i control field dinamici `_ac`/`_mc`/`_oc`):

| #   | Campo (OData)                    | Edm Type       | Chiave | Descrizione          |
| --- | -------------------------------- | -------------- | :----: | -------------------- |
| 1   | `BillOfMaterial`                 | String ML=8    |   ✓    | Bill of Material     |
| 2   | `BillOfMaterialCategory`         | String ML=1    |   ✓    | BOM category         |
| 3   | `BillOfMaterialVariant`          | String ML=2    |   ✓    | Alternative BOM      |
| 4   | `BillOfMaterialVersion`          | String ML=4    |   ✓    | BOM Version          |
| 5   | `EngineeringChangeDocument`      | String ML=12   |   ✓    | Change Number        |
| 6   | `Material`                       | String ML=40   |   ✓    | Material             |
| 7   | `Plant`                          | String ML=4    |   ✓    | Plant                |
| 8   | `BillOfMaterialHeaderUUID`       | Guid           |        | ID hdr chge status   |
| 9   | `BillOfMaterialVariantUsage`     | String ML=1    |        | BOM Usage            |
| 10  | `EngineeringChangeDocForEdit`    | String ML=12   |        | Change Number        |
| 11  | `IsMultipleBOMAlt`               | Boolean        |        | Alt.det. mult. BOM   |
| 12  | `BOMHeaderInternalChangeCount`   | String ML=8    |        | Counter              |
| 13  | `BOMUsagePriority`               | String ML=2    |        | Selection priority   |
| 14  | `BillOfMaterialAuthsnGrp`        | String ML=4    |        | Authorization group  |
| 15  | `BOMVersionStatus`               | String ML=2    |        | BOM Version Status   |
| 16  | `IsVersionBillOfMaterial`        | Boolean        |        | Versioning Relevant  |
| 17  | `IsLatestBOMVersion`             | Boolean        |        | Latest Rel Version   |
| 18  | `IsConfiguredMaterial`           | Boolean        |        | Configurable BOM     |
| 19  | `BOMTechnicalType`               | String ML=1    |        | Technical type       |
| 20  | `BOMGroup`                       | String ML=18   |        | BOM group            |
| 21  | `BOMHeaderText`                  | String ML=40   |        | BOM Description      |
| 22  | `BOMAlternativeText`             | String ML=40   |        | Alternative Text     |
| 23  | `BillOfMaterialStatus`           | String ML=2    |        | BOM Status           |
| 24  | `HeaderValidityStartDate`        | DateTime       |        | Valid From           |
| 25  | `HeaderValidityEndDate`          | DateTime       |        | Valid to             |
| 26  | `ChgToEngineeringChgDocument`    | String ML=12   |        | Change Number To     |
| 27  | `IsMarkedForDeletion`            | Boolean        |        | Deletion Indicator   |
| 28  | `BOMIsArchivedForDeletion`       | Boolean        |        | Deletion Flag        |
| 29  | `IsALE`                          | Boolean        |        | ALE indicator        |
| 30  | `MatFromLotSizeQuantity`         | Decimal (13,3) |        | From Lot Size        |
| 31  | `MaterialToLotSizeQuantity`      | Decimal (13,3) |        | To Lot Size          |
| 32  | `BOMHeaderBaseUnit`              | String ML=3    |        | Base Unit of Measure |
| 33  | `BOMHeaderQuantityInBaseUnit`    | Decimal (13,3) |        | Base quantity        |
| 34  | `RecordCreationDate`             | DateTime       |        | Created On           |
| 35  | `LastChangeDate`                 | DateTime       |        | Changed On           |
| 36  | `CreatedByUser`                  | String ML=12   |        | Created by           |
| 37  | `LastChangedByUser`              | String ML=12   |        | Changed By           |
| 38  | `BOMIsToBeDeleted`               | String ML=1    |        | Handling Del. Flag   |
| 39  | `DocumentIsCreatedByCAD`         | Boolean        |        | CAD Indicator        |
| 40  | `LaboratoryOrDesignOffice`       | String ML=3    |        | Lab/Office           |
| 41  | `LastChangeDateTime`             | DateTimeOffset |        | Time Stamp           |
| 42  | `ProductDescription`             | String ML=40   |        | Product Description  |
| 43  | `PlantName`                      | String ML=30   |        | Plant Name           |
| 44  | `BillOfMaterialHdrDetailsText`   | String ML=255  |        |                      |
| 45  | `BillOfMaterialVariantUsageDesc` | String ML=30   |        | Usage text           |
| 46  | `SelectedBillOfMaterialVersion`  | String ML=4    |        |                      |

---

## 7. Servizio API_MATERIAL_DOCUMENT_SRV (Documenti materiale / movimenti merce)

**File metadati:** `OP_API_MATERIAL_DOCUMENT_SRV.edmx`
**Namespace / Container:** `API_MATERIAL_DOCUMENT_SRV` / `API_MATERIAL_DOCUMENT_SRV_Entities`
**Path servizio:** `/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV`

| Entity Set                 | Operazioni              | Chiave                                                             | N. campi | Vincoli servizio                                                    |
| -------------------------- | ----------------------- | ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------- |
| `A_MaterialDocumentHeader` | POST                    | `MaterialDocumentYear`, `MaterialDocument`                         | 14       | creabile; non aggiornabile, non cancellabile                        |
| `A_MaterialDocumentItem`   | POST (solo deep insert) | `MaterialDocumentYear`, `MaterialDocument`, `MaterialDocumentItem` | 94       | `creatable=false` come set autonomo (non aggiornabile/cancellabile) |

> **Vincolo Integration Suite.** Da standard la registrazione di un movimento merci è un
> **deep insert**: si esegue `POST A_MaterialDocumentHeader` con le righe annidate nella
> navigazione `to_MaterialDocumentItem` (le righe **non** sono creabili come entity set
> autonomo: `A_MaterialDocumentItem` ha `creatable=false`). **Il deep insert non è fattibile su
> Integration Suite (IS)**: va previsto un **wrapper RFC/BAPI** lato SAP (es.
> `BAPI_GOODSMVT_CREATE`) esposto come servizio piatto (header + tabella righe).

Esempi:

- `POST /sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader` (payload header + `to_MaterialDocumentItem` con le righe)

Campi `A_MaterialDocumentHeader` (14):

| #   | Campo (OData)                 | Edm Type     | Chiave | Descrizione            |
| --- | ----------------------------- | ------------ | :----: | ---------------------- |
| 1   | `MaterialDocumentYear`        | String ML=4  |   ✓    | Material Document Year |
| 2   | `MaterialDocument`            | String ML=10 |   ✓    | Material Document      |
| 3   | `InventoryTransactionType`    | String ML=2  |        | Transaction/Event Type |
| 4   | `DocumentDate`                | DateTime     |        | Document Date          |
| 5   | `PostingDate`                 | DateTime     |        | Posting Date           |
| 6   | `CreationDate`                | DateTime     |        | Entry Date             |
| 7   | `CreationTime`                | Time         |        | Time of Entry          |
| 8   | `CreatedByUser`               | String ML=12 |        | User Name              |
| 9   | `MaterialDocumentHeaderText`  | String ML=25 |        | Document Header Text   |
| 10  | `ReferenceDocument`           | String ML=16 |        | Reference              |
| 11  | `VersionForPrintingSlip`      | String ML=1  |        | Print Version          |
| 12  | `ManualPrintIsTriggered`      | String ML=1  |        | Print Active           |
| 13  | `CtrlPostgForExtWhseMgmtSyst` | String ML=1  |        | External WMS Control   |
| 14  | `GoodsMovementCode`           | String ML=2  |        | Goods Movement Code    |

Campi `A_MaterialDocumentItem` (94):

| #   | Campo (OData)                    | Edm Type       | Chiave | Descrizione                            |
| --- | -------------------------------- | -------------- | :----: | -------------------------------------- |
| 1   | `MaterialDocumentYear`           | String ML=4    |   ✓    | Material Document Year                 |
| 2   | `MaterialDocument`               | String ML=10   |   ✓    | Material Document                      |
| 3   | `MaterialDocumentItem`           | String ML=4    |   ✓    | Material Document Item                 |
| 4   | `Material`                       | String ML=40   |        | Material                               |
| 5   | `Plant`                          | String ML=4    |        | Plant                                  |
| 6   | `StorageLocation`                | String ML=4    |        | Storage Location                       |
| 7   | `Batch`                          | String ML=10   |        | Batch                                  |
| 8   | `BatchBySupplier`                | String ML=15   |        | Supplier Batch                         |
| 9   | `GoodsMovementType`              | String ML=3    |        | Movement Type                          |
| 10  | `InventoryStockType`             | String ML=2    |        | Stock Type                             |
| 11  | `InventoryValuationType`         | String ML=10   |        | Valuation Type                         |
| 12  | `InventorySpecialStockType`      | String ML=1    |        | Special Stock Type                     |
| 13  | `Supplier`                       | String ML=10   |        | Supplier                               |
| 14  | `Customer`                       | String ML=10   |        | Customer                               |
| 15  | `SalesOrder`                     | String ML=10   |        | Sales Order                            |
| 16  | `SalesOrderItem`                 | String ML=6    |        | Sales Order Item                       |
| 17  | `SalesOrderScheduleLine`         | String ML=4    |        | Sales Order Schedule                   |
| 18  | `PurchaseOrder`                  | String ML=10   |        | Purchase Order                         |
| 19  | `PurchaseOrderItem`              | String ML=5    |        | Purchase Order Item                    |
| 20  | `WBSElement`                     | String ML=24   |        | WBS Element                            |
| 21  | `ManufacturingOrder`             | String ML=12   |        | Manufacturing Order                    |
| 22  | `ManufacturingOrderItem`         | String ML=4    |        | Manufacturing Order Item               |
| 23  | `GoodsMovementRefDocType`        | String ML=1    |        | Reference Document Type                |
| 24  | `GoodsMovementReasonCode`        | String ML=4    |        | Reason for Movement                    |
| 25  | `Delivery`                       | String ML=10   |        | Delivery                               |
| 26  | `DeliveryItem`                   | String ML=6    |        | Delivery Item                          |
| 27  | `AccountAssignmentCategory`      | String ML=1    |        | Account Assignment Category            |
| 28  | `CostCenter`                     | String ML=10   |        | Cost Center                            |
| 29  | `ControllingArea`                | String ML=4    |        | Controlling Area                       |
| 30  | `CostObject`                     | String ML=12   |        | Cost Object                            |
| 31  | `GLAccount`                      | String ML=10   |        | G/L Account                            |
| 32  | `FunctionalArea`                 | String ML=16   |        | Functional Area                        |
| 33  | `ProfitabilitySegment`           | String ML=10   |        | Profitability Segment                  |
| 34  | `ProfitCenter`                   | String ML=10   |        | Profit Center                          |
| 35  | `MasterFixedAsset`               | String ML=12   |        | Asset                                  |
| 36  | `FixedAsset`                     | String ML=4    |        | Asset Subnumber                        |
| 37  | `MaterialBaseUnit`               | String ML=3    |        | Base Unit of Measure                   |
| 38  | `QuantityInBaseUnit`             | Decimal (13,3) |        | Quantity                               |
| 39  | `EntryUnit`                      | String ML=3    |        | Unit of Entry                          |
| 40  | `QuantityInEntryUnit`            | Decimal (13,3) |        | Quantity in Entry Unit                 |
| 41  | `CompanyCodeCurrency`            | String ML=5    |        | Company Code Currency                  |
| 42  | `GdsMvtExtAmtInCoCodeCrcy`       | Decimal (14,3) |        | External Amount in LC                  |
| 43  | `SlsPrcAmtInclVATInCoCodeCrcy`   | Decimal (14,3) |        | Sales Value Including VAT              |
| 44  | `FiscalYear`                     | String ML=4    |        | Fiscal Year                            |
| 45  | `FiscalYearPeriod`               | String ML=7    |        | Fiscal Year & Period from Posting date |
| 46  | `FiscalYearVariant`              | String ML=2    |        | Fiscal Year Variant                    |
| 47  | `IssgOrRcvgMaterial`             | String ML=40   |        | Transfer Material                      |
| 48  | `IssgOrRcvgBatch`                | String ML=10   |        | Transfer Batch                         |
| 49  | `IssuingOrReceivingPlant`        | String ML=4    |        | Rec/Iss Plant                          |
| 50  | `IssuingOrReceivingStorageLoc`   | String ML=4    |        | Storage Location                       |
| 51  | `IssuingOrReceivingStockType`    | String ML=2    |        | Transfer Stock Type                    |
| 52  | `IssgOrRcvgSpclStockInd`         | String ML=1    |        | Transfer Special Stock Type            |
| 53  | `IssuingOrReceivingValType`      | String ML=10   |        | Transfer Batch (Valuation Type)        |
| 54  | `IsCompletelyDelivered`          | Boolean        |        | Delivery Completed                     |
| 55  | `MaterialDocumentItemText`       | String ML=50   |        | Text                                   |
| 56  | `GoodsRecipientName`             | String ML=12   |        | Goods Recipient                        |
| 57  | `UnloadingPointName`             | String ML=25   |        | Unloading Point                        |
| 58  | `ShelfLifeExpirationDate`        | DateTime       |        | SLED/BBD                               |
| 59  | `ManufactureDate`                | DateTime       |        | Date of Manufacture                    |
| 60  | `SerialNumbersAreCreatedAutomly` | Boolean        |        | Create Serial Number Automatically     |
| 61  | `Reservation`                    | String ML=10   |        | Reservation                            |
| 62  | `ReservationItem`                | String ML=4    |        | Reservation Item                       |
| 63  | `ReservationItemRecordType`      | String ML=1    |        | Reservation Record Type                |
| 64  | `ReservationIsFinallyIssued`     | Boolean        |        | Final-Issue Reservation                |
| 65  | `SpecialStockIdfgSalesOrder`     | String ML=10   |        | Sales Order                            |
| 66  | `SpecialStockIdfgSalesOrderItem` | String ML=6    |        | Sales Order Item                       |
| 67  | `SpecialStockIdfgWBSElement`     | String ML=24   |        | WBS Element                            |
| 68  | `IsAutomaticallyCreated`         | String ML=1    |        | Automatically Created                  |
| 69  | `MaterialDocumentLine`           | String ML=6    |        | Line ID                                |
| 70  | `MaterialDocumentParentLine`     | String ML=6    |        | Parent line ID                         |
| 71  | `HierarchyNodeLevel`             | String ML=2    |        | Hierarchy Level                        |
| 72  | `GoodsMovementIsCancelled`       | Boolean        |        | Is Item Cancelled                      |
| 73  | `ReversedMaterialDocumentYear`   | String ML=4    |        | Reversed Document Year                 |
| 74  | `ReversedMaterialDocument`       | String ML=10   |        | Reversed Material Document             |
| 75  | `ReversedMaterialDocumentItem`   | String ML=4    |        | Reversed Document Item                 |
| 76  | `ReferenceDocumentFiscalYear`    | String ML=4    |        | Fiscal Year (Reference Document)       |
| 77  | `InvtryMgmtRefDocumentItem`      | String ML=4    |        | Reference Document Item                |
| 78  | `InvtryMgmtReferenceDocument`    | String ML=10   |        | Reference Document                     |
| 79  | `MaterialDocumentPostingType`    | String ML=1    |        | Type of Posting                        |
| 80  | `InventoryUsabilityCode`         | String ML=1    |        | Posting Control Stock Type             |
| 81  | `EWMWarehouse`                   | String ML=4    |        | Warehouse Number                       |
| 82  | `EWMStorageBin`                  | String ML=18   |        | Storage Bin                            |
| 83  | `HandlingUnitExternalID`         | String ML=20   |        | Handling Unit                          |
| 84  | `DebitCreditCode`                | String ML=1    |        | Debit/Credit Indicator                 |
| 85  | `CrossPlantConfigurableProduct`  | String ML=40   |        | Cross-plant CM                         |
| 86  | `ProductCharacteristic1`         | String ML=18   |        | Color                                  |
| 87  | `ProductCharacteristic2`         | String ML=18   |        | Main Size                              |
| 88  | `ProductCharacteristic3`         | String ML=18   |        | Second Size                            |
| 89  | `ProductSeasonYear`              | String ML=4    |        | Season Year                            |
| 90  | `ProductSeason`                  | String ML=10   |        | Season                                 |
| 91  | `ProductCollection`              | String ML=10   |        | Collection                             |
| 92  | `ProductTheme`                   | String ML=10   |        | Theme                                  |
| 93  | `StockSegment`                   | String ML=40   |        | Stock Segment                          |
| 94  | `IssgOrRcvgStockSegment`         | String ML=40   |        | Rec. Stock Segment                     |

---

## 8. Servizio API_PROD_ORDER_CONFIRMATION_2_SRV (Conferme ordine di produzione)

**File metadati:** `OP_API_PROD_ORDER_CONFIRMATIO_2_SRV_0001.edmx`
**Namespace / Container:** `API_PROD_ORDER_CONFIRMATION_2_SRV` / `API_PROD_ORDER_CONFIRMATION_2_SRV_Entities`
**Path servizio:** `/sap/opu/odata/sap/API_PROD_ORDER_CONFIRMATION_2_SRV`

| Entity Set      | Operazioni | Chiave                                   | N. campi | Vincoli servizio                             |
| --------------- | ---------- | ---------------------------------------- | -------- | -------------------------------------------- |
| `ProdnOrdConf2` | POST       | `ConfirmationGroup`, `ConfirmationCount` | 107      | creabile; non aggiornabile, non cancellabile |

> Le chiavi `ConfirmationGroup` / `ConfirmationCount` sono **assegnate da SAP** in risposta alla
> creazione: in POST si inviano i campi funzionali (ordine `OrderID`, sequenza/operazione,
> quantità `ConfirmationYieldQuantity` / `ConfirmationScrapQuantity`, unità, date, flag
> `IsFinalConfirmation`). Function Import correlate: `CancelProdnOrdConf` (POST, storno),
> `GetConfProposal` e `GetGdsMvtProposal` (POST, proposte di conferma / movimento merci).

Esempi:

- `POST /sap/opu/odata/sap/API_PROD_ORDER_CONFIRMATION_2_SRV/ProdnOrdConf2` (payload conferma)
- `POST .../CancelProdnOrdConf?ConfirmationGroup='...'&ConfirmationCount='...'`

Campi `ProdnOrdConf2` (107):

| #   | Campo (OData)                    | Edm Type       | Chiave | Descrizione                           |
| --- | -------------------------------- | -------------- | :----: | ------------------------------------- |
| 1   | `ConfirmationGroup`              | String ML=10   |   ✓    | Confirmation Group                    |
| 2   | `ConfirmationCount`              | String ML=8    |   ✓    | Order Confirmation                    |
| 3   | `OrderID`                        | String ML=12   |        | Manufacturing Order                   |
| 4   | `Sequence`                       | String ML=6    |        | Sequence                              |
| 5   | `OrderOperation`                 | String ML=4    |        | Operation                             |
| 6   | `OrderSuboperation`              | String ML=4    |        | Suboperation                          |
| 7   | `OrderType`                      | String ML=4    |        | Order Type                            |
| 8   | `OrderOperationInternalID`       | String ML=8    |        | Operation Internal ID                 |
| 9   | `ConfirmationText`               | String ML=40   |        | Confirmation Text                     |
| 10  | `Language`                       | String ML=2    |        | Language Key                          |
| 11  | `Material`                       | String ML=40   |        | Material                              |
| 12  | `OrderPlannedTotalQty`           | Decimal (13,3) |        | Total Quantity                        |
| 13  | `ProductionUnit`                 | String ML=3    |        | Production Unit                       |
| 14  | `FinalConfirmationType`          | String ML=1    |        | Final Confirmation Type               |
| 15  | `IsFinalConfirmation`            | Boolean        |        | Final Confirmation                    |
| 16  | `OpenReservationsIsCleared`      | Boolean        |        | Clear Open Reservs.                   |
| 17  | `IsReversed`                     | Boolean        |        | Reversed                              |
| 18  | `IsReversal`                     | Boolean        |        | Is a Cancellation                     |
| 19  | `APIConfHasNoGoodsMovements`     | Boolean        |        | No Goods Movement                     |
| 20  | `OrderConfirmationRecordType`    | String ML=3    |        | Record Type                           |
| 21  | `OrderConfirmationType`          | String ML=1    |        | Type of Confirmation                  |
| 22  | `ConfirmationEntryDate`          | DateTime       |        | Entry Date                            |
| 23  | `ConfirmationEntryTime`          | Time           |        | Entry Time                            |
| 24  | `EnteredByUser`                  | String ML=12   |        | Entered by User                       |
| 25  | `LastChangeDate`                 | DateTime       |        | Last Change                           |
| 26  | `LastChangedByUser`              | String ML=12   |        | Changed By                            |
| 27  | `ConfirmationExternalEntryDate`  | DateTime       |        | Created on                            |
| 28  | `ConfirmationExternalEntryTime`  | Time           |        | Time                                  |
| 29  | `EnteredByExternalUser`          | String ML=12   |        | Created by                            |
| 30  | `ExternalSystemConfirmation`     | Guid           |        | External Key                          |
| 31  | `Plant`                          | String ML=4    |        | Plant                                 |
| 32  | `WorkCenterTypeCode`             | String ML=2    |        | Resource Object Type                  |
| 33  | `WorkCenter`                     | String ML=8    |        | Work Center                           |
| 34  | `CapacityCategoryCode`           | String ML=3    |        | Capacity Category                     |
| 35  | `CapacityRequirementSplit`       | Byte           |        | Split Number                          |
| 36  | `ShiftGrouping`                  | String ML=2    |        | Shift Grouping                        |
| 37  | `ShiftDefinition`                | String ML=4    |        | Shift Definition                      |
| 38  | `OriginalBatch`                  | String ML=10   |        | Original Batch                        |
| 39  | `SenderCostCenter`               | String ML=10   |        | Sender Cost Center                    |
| 40  | `Personnel`                      | String ML=8    |        | Personnel                             |
| 41  | `TimeRecording`                  | String ML=8    |        | Time Recording                        |
| 42  | `EmployeeWageType`               | String ML=4    |        | Employee Wage Type                    |
| 43  | `EmployeeWageGroup`              | String ML=3    |        | Employee Wage Group                   |
| 44  | `BreakDurationUnit`              | String ML=3    |        | Break Time Unit                       |
| 45  | `BreakDurationUnitISOCode`       | String ML=3    |        | ISO Code                              |
| 46  | `BreakDurationUnitSAPCode`       | String ML=3    |        | Internal SAP Code                     |
| 47  | `ConfirmedBreakDuration`         | Decimal (9,3)  |        | Confirmed Break Time                  |
| 48  | `EmployeeSuitability`            | String ML=2    |        | Employee Suitability                  |
| 49  | `NumberOfEmployees`              | Decimal (5,2)  |        | Number of Employees                   |
| 50  | `PostingDate`                    | DateTime       |        | Posting Date                          |
| 51  | `ConfirmedExecutionStartDate`    | DateTime       |        | Confirmed Execution Start Date        |
| 52  | `ConfirmedExecutionStartTime`    | Time           |        | Confirmed Execution Start Time        |
| 53  | `ConfirmedSetupEndDate`          | DateTime       |        | Confirmed Setup End Date              |
| 54  | `ConfirmedSetupEndTime`          | Time           |        | Confirmed Setup End Time              |
| 55  | `ConfirmedProcessingStartDate`   | DateTime       |        | Confirmed Processing Start Date       |
| 56  | `ConfirmedProcessingStartTime`   | Time           |        | Confirmed Processing Start Time       |
| 57  | `ConfirmedProcessingEndDate`     | DateTime       |        | Confirmed Processing End Date         |
| 58  | `ConfirmedProcessingEndTime`     | Time           |        | Confirmed Processing End Time         |
| 59  | `ConfirmedTeardownStartDate`     | DateTime       |        | Confirmed Teardown Start Date         |
| 60  | `ConfirmedTeardownStartTime`     | Time           |        | Confirmed Teardown Start Time         |
| 61  | `ConfirmedExecutionEndDate`      | DateTime       |        | Confirmed Execution End Date          |
| 62  | `ConfirmedExecutionEndTime`      | Time           |        | Confirmed Execution End Time          |
| 63  | `ConfirmationUnit`               | String ML=3    |        | Confirmation Unit                     |
| 64  | `ConfirmationUnitISOCode`        | String ML=3    |        | ISO Code                              |
| 65  | `ConfirmationUnitSAPCode`        | String ML=3    |        | Internal SAP Code                     |
| 66  | `ConfirmationYieldQuantity`      | Decimal (13,3) |        | Yield Quantity                        |
| 67  | `ConfirmationScrapQuantity`      | Decimal (13,3) |        | Scrap Quantity                        |
| 68  | `ConfirmationReworkQuantity`     | Decimal (13,3) |        | Rework Quantity                       |
| 69  | `VarianceReasonCode`             | String ML=4    |        | Variance Reason                       |
| 70  | `OperationUnit`                  | String ML=3    |        | Operation Unit                        |
| 71  | `OpPlannedTotalQuantity`         | Decimal (13,3) |        | Operation Quantity                    |
| 72  | `ConfYieldQtyInProductionUnit`   | Decimal (13,3) |        | Confd Yield Quantity                  |
| 73  | `OpWorkQuantityUnit1`            | String ML=3    |        | Confirmed Work Quantity Unit 1        |
| 74  | `WorkQuantityUnit1ISOCode`       | String ML=3    |        | ISO Code                              |
| 75  | `WorkQuantityUnit1SAPCode`       | String ML=3    |        | Internal SAP Code                     |
| 76  | `OpConfirmedWorkQuantity1`       | Decimal (13,3) |        | Confirmed Work Quantity 1             |
| 77  | `NoFurtherOpWorkQuantity1IsExpd` | Boolean        |        | No Remaining Work Quantity 1 Expected |
| 78  | `OpWorkQuantityUnit2`            | String ML=3    |        | Confirmed Work Quantity Unit 2        |
| 79  | `WorkQuantityUnit2ISOCode`       | String ML=3    |        | ISO Code                              |
| 80  | `WorkQuantityUnit2SAPCode`       | String ML=3    |        | Internal SAP Code                     |
| 81  | `OpConfirmedWorkQuantity2`       | Decimal (13,3) |        | Confirmed Work Quantity 2             |
| 82  | `NoFurtherOpWorkQuantity2IsExpd` | Boolean        |        | No Remaining Work Quantity 2 Expected |
| 83  | `OpWorkQuantityUnit3`            | String ML=3    |        | Confirmed Work Quantity Unit 3        |
| 84  | `WorkQuantityUnit3ISOCode`       | String ML=3    |        | ISO Code                              |
| 85  | `WorkQuantityUnit3SAPCode`       | String ML=3    |        | Internal SAP Code                     |
| 86  | `OpConfirmedWorkQuantity3`       | Decimal (13,3) |        | Confirmed Work Quantity 3             |
| 87  | `NoFurtherOpWorkQuantity3IsExpd` | Boolean        |        | No Remaining Work Quantity 3 Expected |
| 88  | `OpWorkQuantityUnit4`            | String ML=3    |        | Confirmed Work Quantity Unit 4        |
| 89  | `WorkQuantityUnit4ISOCode`       | String ML=3    |        | ISO Code                              |
| 90  | `WorkQuantityUnit4SAPCode`       | String ML=3    |        | Internal SAP Code                     |
| 91  | `OpConfirmedWorkQuantity4`       | Decimal (13,3) |        | Confirmed Work Quantity 4             |
| 92  | `NoFurtherOpWorkQuantity4IsExpd` | Boolean        |        | No Remaining Work Quantity 4 Expected |
| 93  | `OpWorkQuantityUnit5`            | String ML=3    |        | Confirmed Work Quantity Unit 5        |
| 94  | `WorkQuantityUnit5ISOCode`       | String ML=3    |        | ISO Code                              |
| 95  | `WorkQuantityUnit5SAPCode`       | String ML=3    |        | Internal SAP Code                     |
| 96  | `OpConfirmedWorkQuantity5`       | Decimal (13,3) |        | Confirmed Work Quantity 5             |
| 97  | `NoFurtherOpWorkQuantity5IsExpd` | Boolean        |        | No Remaining Work Quantity 5 Expected |
| 98  | `OpWorkQuantityUnit6`            | String ML=3    |        | Confirmed Work Quantity Unit 6        |
| 99  | `WorkQuantityUnit6ISOCode`       | String ML=3    |        | ISO Code                              |
| 100 | `WorkQuantityUnit6SAPCode`       | String ML=3    |        | Internal SAP Code                     |
| 101 | `OpConfirmedWorkQuantity6`       | Decimal (13,3) |        | Confirmed Work Quantity 6             |
| 102 | `NoFurtherOpWorkQuantity6IsExpd` | Boolean        |        | No Remaining Work Quantity 6 Expected |
| 103 | `BusinessProcessEntryUnit`       | String ML=3    |        | Process Unit                          |
| 104 | `BusProcessEntrUnitISOCode`      | String ML=3    |        | ISO Code                              |
| 105 | `BusProcessEntryUnitSAPCode`     | String ML=3    |        | Internal SAP Code                     |
| 106 | `BusinessProcessConfirmedQty`    | Decimal (13,3) |        | Process Quantity                      |
| 107 | `NoFurtherBusinessProcQtyIsExpd` | Boolean        |        | No Remaining Act.                     |

---

## Riepilogo endpoint

| #   | Servizio                          | Entity Set / Azione            | GET | QUERY | POST | FUNZ. |
| --- | --------------------------------- | ------------------------------ | :-: | :---: | :--: | :---: |
| 1   | API_PRODUCT_SRV                   | A_Product                      |  ✓  |       |      |       |
| 2   | API_PRODUCT_SRV                   | A_ProductDescription           |  ✓  |       |      |       |
| 3   | API_PRODUCT_SRV                   | A_ProductPlant                 |  ✓  |   ✓   |      |       |
| 4   | API_PRODUCTION_ORDER_2_SRV        | A_ProductionOrder_2            |  ✓  |   ✓   |      |       |
| 5   | API_PRODUCTION_ORDER_2_SRV        | A_ProductionOrderOperation_2   |  ✓  |       |      |       |
| 6   | API_PRODUCTION_ORDER_2_SRV        | A_ProductionOrderComponent_2   |  ✓  |       |      |       |
| 7   | API_PRODUCTION_ORDER_2_SRV        | CloseOrder (azione)            |     |       |      |   ✓   |
| 8   | API_PRODUCTION_ORDER_2_SRV        | TechlyCmpltOrder (azione)      |     |       |      |   ✓   |
| 9   | API_PRODUCTION_ROUTING            | ProductionRouting              |  ✓  |       |      |       |
| 10  | API_PRODUCTION_ROUTING            | ProductionRoutingHeader        |  ✓  |   ✓   |      |       |
| 11  | API_PRODUCTION_ROUTING            | ProductionRoutingMatlAssgmt    |  ✓  |   ✓   |      |       |
| 12  | API_PRODUCTION_ROUTING            | ProductionRoutingCompAlloc     |  ✓  |       |      |       |
| 13  | API_PRODUCTION_ROUTING            | ProductionRoutingOperation     |  ✓  |       |      |       |
| 14  | API_CLFN_PRODUCT_SRV              | A_ProductClass                 |  ✓  |   ✓   |      |       |
| 15  | API_CLFN_PRODUCT_SRV              | A_ClfnClassForKeyDate          |  ✓  |       |      |       |
| 16  | API_CLFN_PRODUCT_SRV              | A_ProductClassCharc            |  ✓  |       |      |       |
| 17  | API_CLFN_PRODUCT_SRV              | A_ProductCharcValue            |  ✓  |       |      |       |
| 18  | API_CLFN_CHARACTERISTIC_SRV       | A_ClfnCharacteristicForKeyDate |  ✓  |   ✓   |      |       |
| 19  | API_BILL_OF_MATERIAL_SRV          | MaterialBOM                    |  ✓  |   ✓   |      |       |
| 20  | API_BILL_OF_MATERIAL_SRV          | ExplodeBOM (azione)            |     |       |      |   ✓   |
| 21  | API_MATERIAL_DOCUMENT_SRV         | A_MaterialDocumentHeader       |     |       |  ✓   |       |
| 22  | API_MATERIAL_DOCUMENT_SRV         | A_MaterialDocumentItem         |     |       | (✓)  |       |
| 23  | API_PROD_ORDER_CONFIRMATION_2_SRV | ProdnOrdConf2                  |     |       |  ✓   |       |

> Riga 22: `A_MaterialDocumentItem` creabile **solo** come deep insert dell'header
> (`to_MaterialDocumentItem`), operazione **non fattibile su Integration Suite** — vedi § 7.

## Note per il team Integration

- Le chiavi composte vanno passate in formato OData V2 (`(Key1='...',Key2='...')`); le chiavi
  singole ammettono anche `(...)` diretto.
- Gli accessi sono in prevalenza in **lettura** (GET/QUERY). Fanno eccezione le operazioni di
  **scrittura/azione**: `A_MaterialDocumentHeader` (POST, § 7), `ProdnOrdConf2` (POST, § 8) e le
  Function Import `CloseOrder` / `TechlyCmpltOrder` (§ 2) e `ExplodeBOM` (§ 6).
- **Registrazione movimento merci** (`A_MaterialDocumentHeader`): da standard è un **deep insert**
  header + `to_MaterialDocumentItem`, **non supportato su Integration Suite**. Va previsto un
  **wrapper RFC/BAPI** lato SAP (es. `BAPI_GOODSMVT_CREATE`) esposto come servizio piatto.
- Le **azioni/Function Import** (`CloseOrder`, `TechlyCmpltOrder`, `ExplodeBOM`, `CancelProdnOrdConf`)
  richiedono token **CSRF** e i parametri passati in query string; verificare il supporto lato IS.
- Le **FM RFC `ZMARS_`** per le nuove scritture/azioni sono **proposte** nel § "Riepilogo Function
  Module" (righe 17–22: `ZMARS_BOM_GET`/`ZMARS_BOM_EXPLODE_GET`, `ZMARS_MATERIAL_DOC_POST`,
  `ZMARS_PROD_ORDER_CONF_POST`, `ZMARS_PROD_ORDER_CLOSE`/`_TECO`): nomi, data element e table type
  sono **da confermare/creare** con lo sviluppo ABAP.
- I path servizio riportano la convenzione standard S/4HANA
  (`/sap/opu/odata/sap/<SERVICE>`): **da confermare** con l'host/prefisso effettivo del
  Private Cloud in uso.

---

# Funzioni ABAP RFC (`ZMARS_`)

Lato SAP gli endpoint sono serviti da **Function Module RFC-enabled** con prefisso `ZMARS_`,
organizzati in **Function Group**. I nomi qui sotto sono quelli **effettivi** presenti a sistema.

Convenzioni **osservate a sistema** (rif. `ZMARS_PRODUCT_GET`, `ZMARS_PRODUCT_PLANT_GET`):

- Le FM sono tutte con suffisso **`_GET`**: non esistono FM `_QUERY` separate. Lettura per
  chiave e filtri sono serviti dallo **stesso FM** dell'entità.
- **IMPORT** = due tipi di parametro, quasi tutti **Optional** e con _Pass Value_. Convivono due prefissi:
  - `SO_...` = filtro su un campo tramite **select-options / range**: `Typing = TYPE`
    tipizzato sul table type **`TT_RSDSSELOPT`** (tabella di righe `RSDSSELOPT` con
    `SIGN`/`OPTION`/`LOW`/`HIGH`), es. `SO_PLANT TYPE TT_RSDSSELOPT`;
  - `IV_...` = chiave o filtro puntuale **scalare** (`Typing = TYPE` su data element,
    es. `IV_PRODUCT`, `IV_CREATION_DATE_FROM`).
- **Paginazione / ordinamento** (opzionali, dove presenti): `IV_TOP` / `IV_SKIP` (`TYPE INT4`,
  ≈ `$top` / `$skip`) e `IV_ORDER_BY` (`TYPE ZMARS_ROUTING_T_ORDER_BY`, ≈ `$orderby`).
- **EXPORT** = un parametro **tabella** `ET_<entità> TYPE ZMARS_T_<entità>` (table type
  dedicato, _Pass Value_). L'FM restituisce quindi sempre una **tabella** di righe.
- `ET_RETURN`/`EV_COUNT` non risultano nelle schede Export finora acquisite: **da confermare**.
- Parametri obbligatori/opzionali indicati nelle singole schede seguono la colonna _Optional_
  delle transazioni SE37 (deselezionato = obbligatorio).

## Riepilogo Function Module

| #    | Function Group             | Function Module RFC             | Entity Set servito                     | Operazioni    |
| ---- | -------------------------- | ------------------------------- | -------------------------------------- | ------------- |
| 1    | ZMARS_FG_PRODUCT           | `ZMARS_PRODUCT_GET`             | `A_Product`                            | GET           |
| 2    | ZMARS_FG_PRODUCT           | `ZMARS_PRODUCT_DESC_GET`        | `A_ProductDescription`                 | GET           |
| 3    | ZMARS_FG_PRODUCT           | `ZMARS_PRODUCT_PLANT_GET`       | `A_ProductPlant`                       | GET + QUERY   |
| 4    | ZMARS_FG_ROUTING           | `ZMARS_ROUTING_GET`             | `ProductionRouting`                    | GET           |
| 5    | ZMARS_FG_ROUTING           | `ZMARS_ROUTING_HEADER_GET`      | `ProductionRoutingHeader`              | GET + QUERY   |
| 6    | ZMARS_FG_ROUTING           | `ZMARS_ROUTING_MATL_ASSGMT_GET` | `ProductionRoutingMatlAssgmt`          | GET + QUERY   |
| 7    | ZMARS_FG_ROUTING           | `ZMARS_ROUTING_COMP_ALLOC_GET`  | `ProductionRoutingCompAlloc`           | GET           |
| 8    | ZMARS_FG_ROUTING           | `ZMARS_ROUTING_OPERATION_GET`   | `ProductionRoutingOperation`           | GET           |
| 9    | ZMARS_FG_PROD_ORDER        | `ZMARS_PROD_ORDER_GET`          | `A_ProductionOrder_2`                  | GET + QUERY   |
| 10   | ZMARS_FG_PROD_ORDER        | `ZMARS_PROD_ORDER_OPER_GET`     | `A_ProductionOrderOperation_2`         | GET           |
| 11   | ZMARS_FG_PROD_ORDER        | `ZMARS_PROD_ORDER_COMP_GET`     | `A_ProductionOrderComponent_2`         | GET           |
| 12   | ZMARS_FG_CLASSIFICATION    | `ZMARS_PRODUCT_CLASS_GET`       | `A_ProductClass`                       | GET + QUERY   |
| 13   | ZMARS_FG_CLASSIFICATION    | `ZMARS_CLFN_CLASS_GET`          | `A_ClfnClassForKeyDate`                | GET           |
| 14   | ZMARS_FG_CLASSIFICATION    | `ZMARS_PRODUCT_CLASS_CHARC_GET` | `A_ProductClassCharc`                  | GET           |
| 15   | ZMARS_FG_CLASSIFICATION    | `ZMARS_PRODUCT_CHARC_VALUE_GET` | `A_ProductCharcValue`                  | GET           |
| 16   | ZMARS_FG_CLASSIFICATION    | `ZMARS_CHARACTERISTIC_GET`      | `A_ClfnCharacteristicForKeyDate`       | GET + QUERY   |
| 17   | ZMARS_FG_MATERIAL_BOM      | `ZMARS_BOM_GET`                 | `MaterialBOM`                          | GET + QUERY   |
| 18   | ZMARS_FG_MATERIAL_BOM      | `ZMARS_BOM_EXPLODE_GET`         | `ExplodeBOM`                           | GET           |
| 19   | ZMARS_FG_MATERIAL_DOC      | `ZMARS_MATERIAL_DOC_POST`       | `A_MaterialDocumentHeader` (+ righe)   | POST          |
| 20   | ZMARS_FG_PROD_ORDER_CONF   | `ZMARS_PROD_ORDER_CONF_POST`    | `ProdnOrdConf2`                        | POST          |
| 21   | ZMARS_FG_PROD_ORDER        | `ZMARS_PROD_ORDER_CLOSE`        | `CloseOrder` (azione)                  | POST          |
| 22   | ZMARS_FG_PROD_ORDER        | `ZMARS_PROD_ORDER_TECO`         | `TechlyCmpltOrder` (azione)            | POST          |

> Le FM dei function group **`ZMARS_FG_PROD_ORDER`** (Production Order) e
> **`ZMARS_FG_CLASSIFICATION`** (Classificazione prodotto/Caratteristiche) sono una **proposta di
> specifica** (non ancora a sistema): nomi FM, data element e table type sono da confermare/creare
> con lo sviluppo ABAP. Dettaglio in fondo al documento.
>
> Le righe **17–22** (`ZMARS_FG_MATERIAL_BOM`, `ZMARS_FG_MATERIAL_DOC`,
> `ZMARS_FG_PROD_ORDER_CONF` e le azioni Close/TECO in `ZMARS_FG_PROD_ORDER`) sono **anch'esse
> proposte** e riguardano operazioni di **scrittura/azione**: rompono la convenzione sola lettura
> `_GET` / `ET_<entità>`. Convenzione proposta per queste FM:
>
> - **POST** (`ZMARS_*_POST`): IMPORT = struttura header + tabella righe da registrare (`IS_`/`IT_`);
>   EXPORT = chiavi del documento creato (`EV_`) + `ET_RETURN` (`BAPIRET2`).
> - **Azioni POST** (`ZMARS_PROD_ORDER_CLOSE`/`_TECO`): IMPORT = parametri scalari `IV_`
>   (es. `IV_MANUFACTURING_ORDER`); EXPORT = `ET_RETURN`.
> - **`ZMARS_BOM_EXPLODE_GET`**: pur essendo un Function Import OData, è invocato in **GET**
>   (lettura) → resta uno `_GET`: IMPORT = chiave BOM + filtri scalari `IV_`; EXPORT = tabella
>   risultato dell'esplosione.
>
> Il campo `A_MaterialDocumentItem` è registrabile solo via **deep insert** lato OData standard
> (non fattibile su IS): la FM `ZMARS_MATERIAL_DOC_POST` è quindi il **wrapper piatto** header+righe
> (es. su `BAPI_GOODSMVT_CREATE`) — vedi § 7.

---

## Function Group `ZMARS_FG_PRODUCT`

### `ZMARS_PRODUCT_GET` — A_Product

Firma **letta a sistema** (FM attiva). Import = parametri scalari opzionali; Export = tabella.

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro               | Data element | Opz. | Short text      | OData               |
| ----------------------- | ------------ | :--: | --------------- | ------------------- |
| `IV_PRODUCT`            | MATNR        |  ✓   | Material code   | `Product`           |
| `IV_CREATION_DATE_FROM` | DATS         |  ✓   | Field type DATS | `CreationDate` (da) |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro    | Tipo (table type) | Short text               | Note                                                      |
| ------------ | ----------------- | ------------------------ | --------------------------------------------------------- |
| `ET_PRODUCT` | `ZMARS_T_PRODUCT` | Table type ZMARS_PRODUCT | tabella di righe`ZMARS_PRODUCT` (A_ProductType, 69 campi) |

### `ZMARS_PRODUCT_DESC_GET` — A_ProductDescription

**IMPORTING** _(scheda Import non ancora acquisita — presunti in base alla chiave)_

| Parametro     | Data element | OData      | Note |
| ------------- | ------------ | ---------- | ---- |
| `IV_PRODUCT`  | MATNR        | `Product`  |      |
| `IV_LANGUAGE` | SPRAS        | `Language` |      |

**EXPORTING** (`TYPE`, _Pass Value_) — letto a sistema

| Parametro         | Tipo (table type)      | Short text                    | Note                                                                     |
| ----------------- | ---------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `ET_PRODUCT_DESC` | `ZMARS_T_PRODUCT_DESC` | Table type ZMARS_PRODUCT_DESC | tabella di righe`ZMARS_PRODUCT_DESC` (A_ProductDescriptionType, 3 campi) |

### `ZMARS_PRODUCT_PLANT_GET` — A_ProductPlant

Firma **letta a sistema** (FM attiva). I parametri `SO_` sono **select-options / range**
(`TYPE TT_RSDSSELOPT`).

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro             | Data element               | Opz. | Short text                        | OData / uso                          |
| --------------------- | -------------------------- | :--: | --------------------------------- | ------------------------------------ |
| `SO_PLANT`            | TT_RSDSSELOPT              |      | Plant                             | `Plant` — **obbligatorio**           |
| `SO_PRODUCT`          | TT_RSDSSELOPT              |  ✓   | Material code                     | `Product`                            |
| `SO_PROFIT_CENTER`    | TT_RSDSSELOPT              |  ✓   | Profit Center                     | `ProfitCenter`                       |
| `SO_MRP_TYPE`         | TT_RSDSSELOPT              |  ✓   | MRP characteristic                | `MRPType`                            |
| `SO_PROCUREMENT_TYPE` | TT_RSDSSELOPT              |  ✓   | Procurement type                  | `ProcurementType`                    |
| `SO_PURCHASING_GROUP` | TT_RSDSSELOPT              |  ✓   | Purchasing Group                  | `PurchasingGroup`                    |
| `IV_TOP`              | INT4                       |  ✓   | Natural Number                    | ≈`$top`                              |
| `IV_SKIP`             | INT4                       |  ✓   | Natural Number                    | ≈`$skip`                             |
| `IV_ORDER_BY`         | `ZMARS_ROUTING_T_ORDER_BY` |  ✓   | Table type ZMARS_ROUTING_ORDER_BY | ≈`$orderby` (table type ordinamento) |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro          | Tipo (table type)       | Short text                     | Note                                                                 |
| ------------------ | ----------------------- | ------------------------------ | -------------------------------------------------------------------- |
| `ET_PRODUCT_PLANT` | `ZMARS_T_PRODUCT_PLANT` | Table Type ZMARS_PRODUCT_PLANT | tabella di righe`ZMARS_PRODUCT_PLANT` (A_ProductPlantType, 48 campi) |

---

## Function Group `ZMARS_FG_ROUTING`

### `ZMARS_ROUTING_GET` — ProductionRouting (lettura per chiave)

Firma **letta a sistema** (FM attiva). Import = solo le due **chiavi** (`IV_`, obbligatorie,
_Pass Value_); non sono presenti filtri `SO_` né paginazione → lettura **per chiave** (GET).
Export = tabella con line type `ZMARS_ROUTING_PRODUCTION`.

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro                     | Data element | Opz. | Short text              | OData                    |
| ----------------------------- | ------------ | :--: | ----------------------- | ------------------------ |
| `IV_PRODUCTION_ROUTING_GROUP` | PLNNR        |      | Key for Task List Group | `ProductionRoutingGroup` |
| `IV_PRODUCTION_ROUTING`       | PLNAL        |      | Group Counter           | `ProductionRouting`      |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro               | Tipo (table type)            | Short text                         | Note                                                  |
| ----------------------- | ---------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `ET_PRODUCTION_ROUTING` | `ZMARS_ROUTING_T_PRODUCTION` | Table type ZPLM_PRODUCTION_ROUTING | tabella di righe`ZMARS_ROUTING_PRODUCTION` (15 campi) |

**Struttura di riga `ZMARS_ROUTING_PRODUCTION`** (line type del table type `ZMARS_ROUTING_T_PRODUCTION`, 15 campi)

| #   | Componente                       | Data element / tipo | Tipo | Lung. | Dec. | Short text                                        |
| --- | -------------------------------- | ------------------- | ---- | ----- | ---- | ------------------------------------------------- |
| 1   | `PRODUCTION_ROUTING_GROUP`       | PLNNR               | CHAR | 8     | 0    | Key for Task List Group                           |
| 2   | `PRODUCTION_ROUTING`             | PLNAL               | CHAR | 2     | 0    | Group Counter                                     |
| 3   | `BILL_OF_OPERATION_VERSION_TYPE` | ZMARS_PROFIDNETW    | CHAR | 1     | 0    | BILL OF OPERATIONS VERSION TYPE                   |
| 4   | `BILL_OF_OPERATION_SUBTYPE`      | ZMARS_BOOSUBTYPE    | CHAR | 1     | 0    | BILL OF OPERATIONS SUBTYPE                        |
| 5   | `LAST_USAGE_DATE`                | ABRUFDAT            | DATS | 8     | 0    | Date of the last call                             |
| 6   | `NUMBER_OF_USAGES`               | ABRUFANZ            | DEC  | 4     | 0    | Number of calls                                   |
| 7   | `HAS_CHANGE_NUMBER`              | XFELD               | CHAR | 1     | 0    | Checkbox                                          |
| 8   | `HAS_PARAMETER_EFFECTIVITY`      | XFELD               | CHAR | 1     | 0    | Checkbox                                          |
| 9   | `LAST_CHANGE_DATE`               | CIM_AEDAT           | DATS | 8     | 0    | Change date for which no change record is created |
| 10  | `LAST_CHANGE_TIME`               | AEZET               | TIMS | 6     | 0    | Time last change was made                         |
| 11  | `LAST_CHANGED_BY_USER`           | AENAM               | CHAR | 12    | 0    | Name of Person Who Changed Object                 |
| 12  | `IS_MARKED_FOR_DELETION`         | XFELD               | CHAR | 1     | 0    | Checkbox                                          |
| 13  | `ROUTING_IS_REWORK_ROUTING`      | XFELD               | CHAR | 1     | 0    | Checkbox                                          |
| 14  | `PRODN_PROCG_IS_FLEXIBLE`        | XFELD               | CHAR | 1     | 0    | Checkbox                                          |
| 15  | `CHANGED_DATE_TIME`              | TZNTSTMPS           | DEC  | 15    | 0    | UTC Time Stamp in Short Form (YYYYMMDDhhmmss)     |

> Nomi componente e parametro **verificati a sistema** (struttura `ZMARS_ROUTING_PRODUCTION`).
> Mapping OData dei campi non-chiave: **da confermare**.

### `ZMARS_ROUTING_HEADER_GET` — ProductionRoutingHeader (lettura per chiave + query)

Firma **letta a sistema** (FM attiva). L'FM combina **chiavi** (`IV_`) e **filtri** (`SO_`):
serve sia la lettura per chiave sia la query.

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro                     | Data element  | Opz. | Short text              | OData                           |
| ----------------------------- | ------------- | :--: | ----------------------- | ------------------------------- |
| `IV_PRODUCTION_ROUTING_GROUP` | PLNNR         |      | Key for Task List Group | `ProductionRoutingGroup`        |
| `IV_PRODUCTION_ROUTING`       | PLNAL         |      | Group Counter           | `ProductionRouting`             |
| `IV_PROD_RTG_INTERNAL_VERS`   | CIM_COUNT     |  ✓   | Internal counter        | `ProductionRoutingInternalVers` |
| `SO_PRODUCT`                  | TT_RSDSSELOPT |  ✓   | Material code           | `Product`                       |
| `SO_PLANT`                    | TT_RSDSSELOPT |  ✓   | Plant                   | `Plant`                         |
| `SO_BOO_USAGE`                | TT_RSDSSELOPT |  ✓   | Bill of Operation Usage | `BillOfOperationsUsage`         |
| `SO_BOO_STATUS`               | TT_RSDSSELOPT |  ✓   | Status                  | `BillOfOperationsStatus`        |
| `SO_CREATION_DATE`            | TT_RSDSSELOPT |  ✓   | Date record created on  | `CreationDate`                  |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro   | Tipo (table type)        | Short text             | Note                                             |
| ----------- | ------------------------ | ---------------------- | ------------------------------------------------ |
| `ET_HEADER` | `ZMARS_ROUTING_T_HEADER` | Table type ZPLM_HEADER | tabella (ProductionRoutingHeader_Type, 24 campi) |

### `ZMARS_ROUTING_MATL_ASSGMT_GET` — ProductionRoutingMatlAssgmt (lettura per chiave + query)

Firma **letta a sistema** (FM attiva). `SO_PRODUCT` e `SO_PLANT` **obbligatori**.

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro                      | Data element               | Opz. | Short text                      | OData                            |
| ------------------------------ | -------------------------- | :--: | ------------------------------- | -------------------------------- |
| `SO_PRODUCT`                   | TT_RSDSSELOPT              |      | Material code                   | `Product` — **obbligatorio**     |
| `SO_PLANT`                     | TT_RSDSSELOPT              |      | Plant                           | `Plant` — **obbligatorio**       |
| `SO_PRODUCTION_ROUTING_GROUP`  | TT_RSDSSELOPT              |  ✓   | Key for Task List Group         | `ProductionRoutingGroup`         |
| `SO_PRODUCTION_ROUTING`        | TT_RSDSSELOPT              |  ✓   | Group Counter                   | `ProductionRouting`              |
| `IV_PROD_RTG_MATL_ASSGMT`      | DZKRIZ                     |  ✓   | Counter for additional criteria | `ProductionRoutingMatlAssgmt`    |
| `IV_PROD_RTG_MATL_ASS_INTVERS` | CIM_COUNT                  |  ✓   | Internal counter                | `ProductionRtgMatlAssgmtIntVers` |
| `IV_TOP`                       | INT4                       |  ✓   | Natural Number                  | ≈`$top`                          |
| `IV_SKIP`                      | INT4                       |  ✓   | Natural Number                  | ≈`$skip`                         |
| `IV_ORDER_BY`                  | `ZMARS_ROUTING_T_ORDER_BY` |  ✓   | Table type ZPLM_ORDER_BY        | ≈`$orderby`                      |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro        | Tipo (table type)             | Short text                  | Note                                                 |
| ---------------- | ----------------------------- | --------------------------- | ---------------------------------------------------- |
| `ET_MATL_ASSGMT` | `ZMARS_ROUTING_T_MATL_ASSGMT` | Table Type ZPLM_MATL_ASSGMT | tabella (ProductionRoutingMatlAssgmt_Type, 17 campi) |

### `ZMARS_ROUTING_COMP_ALLOC_GET` — ProductionRoutingCompAlloc

Firma **letta a sistema** (FM attiva).

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro                      | Data element | Opz. | Short text                   | OData                         |
| ------------------------------ | ------------ | :--: | ---------------------------- | ----------------------------- |
| `IV_PRODUCTION_ROUTING_GROUP`  | PLNNR        |      | Key for Task List Group      | `ProductionRoutingGroup`      |
| `IV_PRODUCTION_ROUTING`        | PLNAL        |      | Group Counter                | `ProductionRouting`           |
| `IV_PRODUCTION_ROUTING_SEQ`    | PLNFOLGE     |  ✓   | Sequence                     | `ProductionRoutingSequence`   |
| `IV_PRODUCTION_ROUTING_OP_IN…` | PLNKN        |  ✓   | Number of the task list node | `ProductionRoutingOpIntID`    |
| `IV_RTG_OP_BOM_ITEM_INT_ID`    | STLKN        |  ✓   | BOM item node number         | `ProdnRtgOpBOMItemInternalID` |
| `IV_RTG_OP_BOM_ITEM_INT_VERS`  | CIM_COUNT    |  ✓   | Internal counter             | `ProdnRtgOpBOMItemIntVersion` |

> Nome completo del 4° parametro tagliato a video (`IV_PRODUCTION_ROUTING_OP_IN…`,
> probabile `IV_PRODUCTION_ROUTING_OP_INT_ID`): **da confermare**.

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro       | Tipo (table type)            | Short text                 | Note                                                |
| --------------- | ---------------------------- | -------------------------- | --------------------------------------------------- |
| `ET_COMP_ALLOC` | `ZMARS_ROUTING_T_COMP_ALLOC` | Table type ZPLM_COMP_ALLOC | tabella (ProductionRoutingCompAlloc_Type, 20 campi) |

### `ZMARS_ROUTING_OPERATION_GET` — ProductionRoutingOperation

Firma **letta a sistema** (FM attiva).

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro                      | Data element | Opz. | Short text                   | OData                           |
| ------------------------------ | ------------ | :--: | ---------------------------- | ------------------------------- |
| `IV_PRODUCTION_ROUTING_GROUP`  | PLNNR        |      | Key for Task List Group      | `ProductionRoutingGroup`        |
| `IV_PRODUCTION_ROUTING`        | PLNAL        |      | Group Counter                | `ProductionRouting`             |
| `IV_PRODUCTION_ROUTING_SEQ`    | PLNFOLGE     |  ✓   | Sequence                     | `ProductionRoutingSequence`     |
| `IV_PRODUCTION_ROUTING_OP_IN…` | PLNKN        |  ✓   | Number of the task list node | `ProductionRoutingOpIntID`      |
| `IV_PROD_RTG_OP_INT_VERSION`   | CIM_COUNT    |  ✓   | Internal counter             | `ProductionRoutingOpIntVersion` |

> Nome completo del 4° parametro tagliato a video (`IV_PRODUCTION_ROUTING_OP_IN…`,
> probabile `IV_PRODUCTION_ROUTING_OP_INT_ID`): **da confermare**.

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro      | Tipo (table type)           | Short text                | Note                                                 |
| -------------- | --------------------------- | ------------------------- | ---------------------------------------------------- |
| `ET_OPERATION` | `ZMARS_ROUTING_T_OPERATION` | Table type ZPLM_OPERATION | tabella (ProductionRoutingOperation_Type, 119 campi) |

---

## Function Group `ZMARS_FG_PROD_ORDER` — **proposta di specifica**

> Le FM del servizio `API_PRODUCTION_ORDER_2_SRV` **non sono ancora a sistema**. La specifica
> seguente è una **proposta** che replica le convenzioni consolidate delle FG Product/Routing:
> IMPORT = `IV_` chiavi scalari / `SO_` filtri select-options (`TYPE TT_RSDSSELOPT`), tutti _Pass Value_; EXPORT = table type
> `ET_<entità>`. Nomi FM (≤30 caratteri), data element e table type sono **da confermare/creare**.
> Campi e chiavi derivano dai metadati EDMX (`OP_API_PRODUCTION_ORDER_2_SRV_0001.edmx`).

### `ZMARS_PROD_ORDER_GET` — A_ProductionOrder_2 (lettura per chiave + query)

Serve sia il GET per chiave (`IV_MANUFACTURING_ORDER`) sia la QUERY (filtri `SO_`).

**IMPORTING** (`TYPE`, _Pass Value_ — tutti opzionali)

| Parametro                  | Data element               | Short text            | OData                             |
| -------------------------- | -------------------------- | --------------------- | --------------------------------- |
| `SO_MANUFACTURING_ORDER`   | TT_RSDSSELOPT              | Production Order      | `ManufacturingOrder` (chiave GET) |
| `SO_MATERIAL`              | TT_RSDSSELOPT              | Material              | `Material`                        |
| `SO_PRODUCTION_PLANT`      | TT_RSDSSELOPT              | Production Plant      | `ProductionPlant`                 |
| `SO_ORDER_TYPE`            | TT_RSDSSELOPT              | Order Type            | `ManufacturingOrderType`          |
| `SO_MRP_CONTROLLER`        | TT_RSDSSELOPT              | MRP Controller        | `MRPController`                   |
| `SO_PRODUCTION_SUPERVISOR` | TT_RSDSSELOPT              | Production Supervisor | `ProductionSupervisor`            |
| `SO_PROFIT_CENTER`         | TT_RSDSSELOPT              | Profit Center         | `ProfitCenter`                    |
| `SO_ORDER_CREATION_DATE`   | TT_RSDSSELOPT              | Order Creation Date   | `MfgOrderCreationDate`            |
| `IV_TOP`                   | INT4                       | Natural Number        | ≈`$top`                           |
| `IV_SKIP`                  | INT4                       | Natural Number        | ≈`$skip`                          |
| `IV_ORDER_BY`              | `ZMARS_ROUTING_T_ORDER_BY` | Order by              | ≈`$orderby`                       |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro  | Tipo (table type)          | Note                                        |
| ---------- | -------------------------- | ------------------------------------------- |
| `ET_ORDER` | `ZMARS_PROD_ORDER_T_ORDER` | tabella (A_ProductionOrder_2Type, 78 campi) |

### `ZMARS_PROD_ORDER_OPER_GET` — A_ProductionOrderOperation_2 (GET)

Chiave OData = ID interni (`AUFPL`/`APLZL`). Poiché tali ID non sono noti al chiamante esterno,
si prevede il filtro pratico per `IV_MANUFACTURING_ORDER` (numero ordine).

**IMPORTING** (`TYPE`, _Pass Value_ — tutti opzionali)

| Parametro                  | Data element | Short text            | OData                                      |
| -------------------------- | ------------ | --------------------- | ------------------------------------------ |
| `IV_MANUFACTURING_ORDER`   | AUFNR        | Production Order      | `ManufacturingOrder` (filtro)              |
| `IV_ORDER_INT_BILL_OF_OPS` | AUFPL        | Order Internal ID     | `OrderInternalBillOfOperations` (chiave 1) |
| `IV_ORDER_INT_BOO_ITEM`    | APLZL        | Operation Internal ID | `OrderIntBillOfOperationsItem` (chiave 2)  |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro      | Tipo (table type)              | Note                                                 |
| -------------- | ------------------------------ | ---------------------------------------------------- |
| `ET_OPERATION` | `ZMARS_PROD_ORDER_T_OPERATION` | tabella (A_ProductionOrderOperation_2Type, 86 campi) |

### `ZMARS_PROD_ORDER_COMP_GET` — A_ProductionOrderComponent_2 (GET)

Chiave OData = `Reservation`/`ReservationItem`. Previsto filtro pratico per `IV_MANUFACTURING_ORDER`.

**IMPORTING** (`TYPE`, _Pass Value_ — tutti opzionali)

| Parametro                | Data element | Short text       | OData                         |
| ------------------------ | ------------ | ---------------- | ----------------------------- |
| `IV_RESERVATION`         | RSNUM        | Reservation      | `Reservation` (chiave 1)      |
| `IV_RESERVATION_ITEM`    | RSPOS        | Reservation Item | `ReservationItem` (chiave 2)  |
| `IV_MANUFACTURING_ORDER` | AUFNR        | Production Order | `ManufacturingOrder` (filtro) |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro      | Tipo (table type)              | Note                                                 |
| -------------- | ------------------------------ | ---------------------------------------------------- |
| `ET_COMPONENT` | `ZMARS_PROD_ORDER_T_COMPONENT` | tabella (A_ProductionOrderComponent_2Type, 59 campi) |

### `ZMARS_PROD_ORDER_CLOSE` — CloseOrder (azione, POST)

Wrapper dell'azione OData `CloseOrder` (chiusura "business" dell'ordine). Non restituisce tabelle
dati: solo l'esito nei messaggi di ritorno (equivalente del tipo `FunctionMessage` OData).

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro                | Data element | Opz. | Short text       | OData                         |
| ------------------------ | ------------ | :--: | ---------------- | ----------------------------- |
| `IV_MANUFACTURING_ORDER` | AUFNR        |      | Production Order | `ManufacturingOrder` (chiave) |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro   | Tipo (table type)  | Note                                              |
| ----------- | ------------------ | ------------------------------------------------- |
| `ET_RETURN` | `BAPIRET2` (tabella) | messaggi di esito (mappa il `FunctionMessage`)   |

### `ZMARS_PROD_ORDER_TECO` — TechlyCmpltOrder (azione, POST)

Wrapper dell'azione OData `TechlyCmpltOrder` (chiusura tecnica dell'ordine, TECO).

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro                | Data element | Opz. | Short text       | OData                         |
| ------------------------ | ------------ | :--: | ---------------- | ----------------------------- |
| `IV_MANUFACTURING_ORDER` | AUFNR        |      | Production Order | `ManufacturingOrder` (chiave) |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro   | Tipo (table type)    | Note                                            |
| ----------- | -------------------- | ----------------------------------------------- |
| `ET_RETURN` | `BAPIRET2` (tabella) | messaggi di esito (mappa il `FunctionMessage`)  |

**Da confermare per il FG `ZMARS_FG_PROD_ORDER`:**

- Nome definitivo di function group e FM (proposta `ZMARS_FG_PROD_ORDER` / `ZMARS_PROD_ORDER_*`).
- Creazione dei **table type** `ZMARS_PROD_ORDER_T_*` e delle relative strutture di riga.
- Range su date: `SO_ORDER_CREATION_DATE` è `TYPE TT_RSDSSELOPT` (LOW/HIGH `DATS`); `MfgOrderCreationDate` è `Edm.DateTime`.
- Set definitivo dei **filtri** ammessi per ciascuna FM (qui un set operativo di base).
- Se per Operation/Component serve anche la modalità QUERY (attualmente marcate GET).

---

## Strutture di riga dei table type Production Order

Dettaglio dei campi delle strutture di riga (line type) dei table type esportati dalle FM
`ZMARS_FG_PROD_ORDER`. I campi derivano **1:1 dagli entity type EDMX**. Nome proposto della
struttura di riga: `ZMARS_PROD_ORDER_S_<ENTITÀ>` (il table type `..._T_<ENTITÀ>` è
`STANDARD TABLE OF` di tale struttura).

> **Data element SAP**: sono **proposte** basate sui campi standard delle tabelle sottostanti
> (AUFK/AFKO/AFPO/RESB/AFVC…). Vanno **verificati sul CDS/DDIC** in fase di creazione. `n/d`
> indica campi **derivati/di stato** (es. flag di stato sistema, testi lunghi, timestamp,
> ID interni) privi di un data element classico univoco: da tipizzare inline o su DE tecnico.

### Struttura `ZMARS_PROD_ORDER_T_ORDER` — A_ProductionOrder_2 (78 campi)

Riga della tabella (line type). Campi dall'entity type `A_ProductionOrder_2Type`.

| #   | Campo (OData)                   | Edm Type       | Data element SAP (proposto) | Chiave | Descrizione             |
| --- | ------------------------------- | -------------- | --------------------------- | :----: | ----------------------- |
| 1   | `ManufacturingOrder`            | String ML=12   | AUFNR                       |   ✓    | Production Order        |
| 2   | `ManufacturingOrderCategory`    | String ML=2    | AUTYP                       |        | Order Category          |
| 3   | `ManufacturingOrderType`        | String ML=4    | AUFART                      |        | Order Type              |
| 4   | `OrderLongText`                 | String         | n/d (testo)                 |        | Long Text               |
| 5   | `ManufacturingOrderImportance`  | String ML=1    | n/d                         |        | Order Importance        |
| 6   | `ProdnProcgIsFlexible`          | Boolean        | n/d (flag)                  |        | Flexible Processing     |
| 7   | `OrderIsCreated`                | String ML=1    | n/d (stato)                 |        |                         |
| 8   | `OrderIsReleased`               | String ML=1    | n/d (stato)                 |        |                         |
| 9   | `OrderIsPrinted`                | String ML=1    | n/d (stato)                 |        |                         |
| 10  | `OrderIsConfirmed`              | String ML=1    | n/d (stato)                 |        |                         |
| 11  | `OrderIsPartiallyConfirmed`     | String ML=1    | n/d (stato)                 |        |                         |
| 12  | `OrderIsDelivered`              | String ML=1    | n/d (stato)                 |        |                         |
| 13  | `OrderIsDeleted`                | String ML=1    | n/d (stato)                 |        |                         |
| 14  | `OrderIsPreCosted`              | String ML=1    | n/d (stato)                 |        |                         |
| 15  | `SettlementRuleIsCreated`       | String ML=1    | n/d (stato)                 |        |                         |
| 16  | `OrderIsPartiallyReleased`      | String ML=1    | n/d (stato)                 |        |                         |
| 17  | `OrderIsLocked`                 | String ML=1    | n/d (stato)                 |        |                         |
| 18  | `OrderIsTechnicallyCompleted`   | String ML=1    | n/d (stato)                 |        |                         |
| 19  | `OrderIsClosed`                 | String ML=1    | n/d (stato)                 |        |                         |
| 20  | `OrderIsPartiallyDelivered`     | String ML=1    | n/d (stato)                 |        |                         |
| 21  | `OrderIsMarkedForDeletion`      | String ML=1    | n/d (stato)                 |        |                         |
| 22  | `SettlementRuleIsCrtedManually` | String ML=1    | n/d (stato)                 |        |                         |
| 23  | `OrderIsScheduled`              | String ML=1    | n/d (stato)                 |        |                         |
| 24  | `OrderHasGeneratedOperations`   | String ML=1    | n/d (stato)                 |        |                         |
| 25  | `OrderIsToBeHandledInBatches`   | String ML=1    | n/d (stato)                 |        |                         |
| 26  | `MaterialAvailyIsNotChecked`    | String ML=1    | n/d (stato)                 |        |                         |
| 27  | `MfgOrderCreationDate`          | DateTime       | ERDAT                       |        | Order Creation Date     |
| 28  | `MfgOrderCreationTime`          | Time           | ERZET                       |        | Order Creation Time     |
| 29  | `LastChangeDateTime`            | String ML=14   | n/d (timestamp)             |        |                         |
| 30  | `Material`                      | String ML=40   | MATNR                       |        | Material                |
| 31  | `StorageLocation`               | String ML=4    | LGORT_D                     |        | Storage Location        |
| 32  | `GoodsRecipientName`            | String ML=12   | WEMPF                       |        | Goods Recipient         |
| 33  | `UnloadingPointName`            | String ML=25   | ABLAD                       |        | Unloading Point         |
| 34  | `InventoryUsabilityCode`        | String ML=1    | n/d                         |        | Inventory Usability     |
| 35  | `MaterialGoodsReceiptDuration`  | Decimal (3,0)  | WEBAZ                       |        | GR Processing Time      |
| 36  | `QuantityDistributionKey`       | String ML=4    | VSNKZ                       |        | Distribution Key        |
| 37  | `StockSegment`                  | String ML=40   | SGT_SCAT                    |        | Stock Segment           |
| 38  | `OrderInternalBillOfOperations` | String ML=10   | AUFPL                       |        | Order Internal ID       |
| 39  | `ProductionPlant`               | String ML=4    | WERKS_D                     |        | Production Plant        |
| 40  | `Plant`                         | String ML=4    | WERKS_D                     |        | Planning Plant          |
| 41  | `MRPArea`                       | String ML=10   | BERID                       |        | MRP Area                |
| 42  | `MRPController`                 | String ML=3    | DISPO                       |        | MRP Controller          |
| 43  | `ProductionSupervisor`          | String ML=3    | FEVOR                       |        | Production Supervisor   |
| 44  | `ProductionVersion`             | String ML=4    | VERID                       |        | Production Version      |
| 45  | `PlannedOrder`                  | String ML=10   | PLNUM                       |        | Planned Order           |
| 46  | `SalesOrder`                    | String ML=10   | KDAUF                       |        | Sales Order             |
| 47  | `SalesOrderItem`                | String ML=6    | KDPOS                       |        | Sales Order Item        |
| 48  | `BasicSchedulingType`           | String ML=1    | TERKZ                       |        | Basic Scheduling Type   |
| 49  | `ManufacturingObject`           | String ML=22   | OBJNR                       |        | Object Number           |
| 50  | `ProductConfiguration`          | String ML=18   | CUOBJ                       |        | Prod. Configuration     |
| 51  | `OrderSequenceNumber`           | String ML=14   | n/d                         |        | Sequence Number         |
| 52  | `MfgOrderSuperiorMfgOrder`      | String ML=12   | MAUFNR                      |        | Superior Order          |
| 53  | `LeadingOrder`                  | String ML=12   | n/d                         |        | Leading Order           |
| 54  | `ResponsiblePlannerGroup`       | String ML=3    | VAGRP                       |        | Planner Group           |
| 55  | `BusinessArea`                  | String ML=4    | GSBER                       |        | Business Area           |
| 56  | `CompanyCode`                   | String ML=4    | BUKRS                       |        | Company Code            |
| 57  | `ProfitCenter`                  | String ML=10   | PRCTR                       |        | Profit Center           |
| 58  | `ActualCostsCostingVariant`     | String ML=4    | KLVARI                      |        | Actual Costing Variant  |
| 59  | `PlannedCostsCostingVariant`    | String ML=4    | KLVARP                      |        | Planned Costing Variant |
| 60  | `FunctionalArea`                | String ML=16   | FKBER                       |        | Functional Area         |
| 61  | `MfgOrderPlannedStartDate`      | DateTime       | GSTRP                       |        | Planned Start Date      |
| 62  | `MfgOrderPlannedStartTime`      | Time           | GSUZP                       |        | Planned Start Time      |
| 63  | `MfgOrderPlannedEndDate`        | DateTime       | GLTRP                       |        | Planned End Date        |
| 64  | `MfgOrderPlannedEndTime`        | Time           | GLUZP                       |        | Planned End Time        |
| 65  | `MfgOrderScheduledStartDate`    | DateTime       | GSTRS                       |        | Scheduled Start Date    |
| 66  | `MfgOrderScheduledStartTime`    | Time           | GSUZS                       |        | Scheduled Start Time    |
| 67  | `MfgOrderScheduledEndDate`      | DateTime       | GLTRS                       |        | Scheduled End Date      |
| 68  | `MfgOrderScheduledEndTime`      | Time           | GLUZS                       |        | Scheduled End Time      |
| 69  | `MfgOrderActualReleaseDate`     | DateTime       | FTRMI                       |        | Actual Release Date     |
| 70  | `ProductionUnit`                | String ML=3    | MEINS                       |        | Production Unit         |
| 71  | `ProductionUnitISOCode`         | String ML=3    | ISOCD_UNIT                  |        | ISO Code                |
| 72  | `ProductionUnitSAPCode`         | String ML=3    | MEINS                       |        | Internal SAP Code       |
| 73  | `TotalQuantity`                 | Decimal (13,3) | GAMNG                       |        | Total Quantity          |
| 74  | `MfgOrderPlannedScrapQty`       | Decimal (13,3) | GASMG                       |        | Scrap Quantity          |
| 75  | `MfgOrderConfirmedYieldQty`     | Decimal (13,3) | IGMNG                       |        | Confirmed Yield         |
| 76  | `CustomerName`                  | String ML=80   | NAME1_GP                    |        | Name of Customer        |
| 77  | `WBSElementExternalID`          | String ML=24   | PS_POSID                    |        | WBS Element             |
| 78  | `MasterProductionOrder`         | String ML=12   | MAUFNR                      |        | Master Prod. Ord.       |

### Struttura `ZMARS_PROD_ORDER_T_OPERATION` — A_ProductionOrderOperation_2 (86 campi)

Riga della tabella (line type). Campi dall'entity type `A_ProductionOrderOperation_2Type`.

| #   | Campo (OData)                    | Edm Type       | Data element SAP (proposto) | Chiave | Descrizione                    |
| --- | -------------------------------- | -------------- | --------------------------- | :----: | ------------------------------ |
| 1   | `OrderInternalBillOfOperations`  | String ML=10   | AUFPL                       |   ✓    | Order Internal ID              |
| 2   | `OrderIntBillOfOperationsItem`   | String ML=8    | APLZL                       |   ✓    | Operation Internal ID          |
| 3   | `ManufacturingOrder`             | String ML=12   | AUFNR                       |        | Production Order               |
| 4   | `ManufacturingOrderSequence`     | String ML=6    | PLNFL                       |        | Sequence                       |
| 5   | `MfgOrderSequenceText`           | String ML=40   | n/d                         |        | Sequence Text                  |
| 6   | `ManufacturingOrderOperation`    | String ML=4    | VORNR                       |        | Operation                      |
| 7   | `ManufacturingOrderSubOperation` | String ML=4    | UVORN                       |        | Suboperation                   |
| 8   | `ManufacturingOrderCategory`     | String ML=2    | AUTYP                       |        | Order Category                 |
| 9   | `ManufacturingOrderType`         | String ML=4    | AUFART                      |        | Order Type                     |
| 10  | `MfgOrderOperationText`          | String ML=40   | LTXA1                       |        | Operation Text                 |
| 11  | `OrderOperationLongText`         | String         | n/d (testo)                 |        | Long Text                      |
| 12  | `OrderSequenceLongText`          | String         | n/d (testo)                 |        | Long Text                      |
| 13  | `ObjectInternalID`               | String ML=22   | OBJNR                       |        | Object Number                  |
| 14  | `OperationIsCreated`             | String ML=1    | n/d (stato)                 |        |                                |
| 15  | `OperationIsReleased`            | String ML=1    | n/d (stato)                 |        |                                |
| 16  | `OperationIsPrinted`             | String ML=1    | n/d (stato)                 |        |                                |
| 17  | `OperationIsConfirmed`           | String ML=1    | n/d (stato)                 |        |                                |
| 18  | `OperationIsPartiallyConfirmed`  | String ML=1    | n/d (stato)                 |        |                                |
| 19  | `OperationIsDeleted`             | String ML=1    | n/d (stato)                 |        |                                |
| 20  | `OperationIsTechlyCompleted`     | String ML=1    | n/d (stato)                 |        |                                |
| 21  | `OperationIsClosed`              | String ML=1    | n/d (stato)                 |        |                                |
| 22  | `OperationIsScheduled`           | String ML=1    | n/d (stato)                 |        |                                |
| 23  | `OperationIsPartiallyDelivered`  | String ML=1    | n/d (stato)                 |        |                                |
| 24  | `OperationIsDelivered`           | String ML=1    | n/d (stato)                 |        |                                |
| 25  | `ProductionPlant`                | String ML=4    | WERKS_D                     |        | Production Plant               |
| 26  | `WorkCenterInternalID`           | String ML=8    | CR_OBJID                    |        | Work Center Internal           |
| 27  | `WorkCenterTypeCode`             | String ML=1    | CR_OBTYP                    |        | Work Center Type Code          |
| 28  | `WorkCenter`                     | String ML=8    | ARBPL                       |        | Work Center                    |
| 29  | `OperationControlProfile`        | String ML=4    | STEUS                       |        | Control Profile                |
| 30  | `BOOOperationInternalID`         | String ML=8    | PLNKN                       |        | Task List Node                 |
| 31  | `OpExternalProcessingPriceUnit`  | Decimal (5,0)  | PEINH                       |        | Price unit                     |
| 32  | `OpErlstSchedldExecStrtDte`      | DateTime       | FSAVD                       |        | Execution Start Date           |
| 33  | `OpErlstSchedldExecStrtTme`      | Time           | FSAVZ                       |        | Execution Start Time           |
| 34  | `OpErlstSchedldExecEndDte`       | DateTime       | FSEDD                       |        | Execution End Date             |
| 35  | `OpErlstSchedldExecEndTme`       | Time           | FSEDZ                       |        | Execution End Time             |
| 36  | `OpActualExecutionStartDate`     | DateTime       | ISDD                        |        | Confirmed Execution Start Date |
| 37  | `OpActualExecutionStartTime`     | Time           | ISDZ                        |        | Confirmed Execution Start Time |
| 38  | `OpActualExecutionEndDate`       | DateTime       | IEDD                        |        | Confirmed Execution End Date   |
| 39  | `OpActualExecutionEndTime`       | Time           | IEDZ                        |        | Confirmed Execution End Time   |
| 40  | `OpErlstSchedldProcgStrtDte`     | DateTime       | FSSAD                       |        | Processing Start Dte           |
| 41  | `OpErlstSchedldProcgStrtTme`     | Time           | FSSAZ                       |        | Processing Start Tme           |
| 42  | `OpErlstSchedldTrdwnStrtDte`     | DateTime       | n/d                         |        | Teardown Start Date            |
| 43  | `OpErlstSchedldTrdwnStrtTme`     | Time           | n/d                         |        | Teardown Start Time            |
| 44  | `ErlstSchedldExecDurnInWorkdays` | Int32          | n/d                         |        | Scheduled Execution Duration   |
| 45  | `OpActualExecutionDays`          | Int32          | n/d                         |        | Actual Execution Duration      |
| 46  | `MinimumProcessingDuration`      | Decimal (9,3)  | BEARZ                       |        | Min. Processing Time           |
| 47  | `MinimumProcessingDurationUnit`  | String ML=3    | n/d                         |        | Processing Time Unit           |
| 48  | `ForecastProcessingDuration`     | Double         | n/d                         |        | Processing time                |
| 49  | `ForecastProcessingDurationUnit` | String ML=3    | n/d                         |        | Processing time unit           |
| 50  | `OperationUnit`                  | String ML=3    | MEINH                       |        | Operation Unit                 |
| 51  | `OperationUnitISOCode`           | String ML=3    | ISOCD_UNIT                  |        | ISO Code                       |
| 52  | `OperationUnitSAPCode`           | String ML=3    | MEINH                       |        | Internal SAP Code              |
| 53  | `OpPlannedTotalQuantity`         | Decimal (13,3) | MGVRG                       |        | Operation Quantity             |
| 54  | `OpTotalConfirmedYieldQty`       | Decimal (13,3) | LMNGA                       |        | Confirmed Yield                |
| 55  | `WorkCenterStandardWorkQtyUnit1` | String ML=3    | VGE01                       |        | Work Quantity Unit 1           |
| 56  | `StdWrkQtyUnit1ISOCode`          | String ML=3    | ISOCD_UNIT                  |        | ISO Code                       |
| 57  | `StdWrkQtyUnit1SAPCode`          | String ML=3    | VGE01                       |        | Internal SAP Code              |
| 58  | `WorkCenterStandardWorkQty1`     | Decimal (9,3)  | VGW01                       |        | Standard Value                 |
| 59  | `WorkCenterStandardWorkQtyUnit2` | String ML=3    | VGE02                       |        | Work Quantity Unit 2           |
| 60  | `StdWrkQtyUnit2ISOCode`          | String ML=3    | ISOCD_UNIT                  |        | ISO Code                       |
| 61  | `StdWrkQtyUnit2SAPCode`          | String ML=3    | VGE02                       |        | Internal SAP Code              |
| 62  | `WorkCenterStandardWorkQty2`     | Decimal (9,3)  | VGW02                       |        | Standard Value                 |
| 63  | `WorkCenterStandardWorkQtyUnit3` | String ML=3    | VGE03                       |        | Work Quantity Unit 3           |
| 64  | `StdWrkQtyUnit3ISOCode`          | String ML=3    | ISOCD_UNIT                  |        | ISO Code                       |
| 65  | `StdWrkQtyUnit3SAPCode`          | String ML=3    | VGE03                       |        | Internal SAP Code              |
| 66  | `WorkCenterStandardWorkQty3`     | Decimal (9,3)  | VGW03                       |        | Standard Value                 |
| 67  | `WorkCenterStandardWorkQtyUnit4` | String ML=3    | VGE04                       |        | Work Quantity Unit 4           |
| 68  | `StdWrkQtyUnit4ISOCode`          | String ML=3    | ISOCD_UNIT                  |        | ISO Code                       |
| 69  | `StdWrkQtyUnit4SAPCode`          | String ML=3    | VGE04                       |        | Internal SAP Code              |
| 70  | `WorkCenterStandardWorkQty4`     | Decimal (9,3)  | VGW04                       |        | Standard Value                 |
| 71  | `WorkCenterStandardWorkQtyUnit5` | String ML=3    | VGE05                       |        | Work Quantity Unit 5           |
| 72  | `StdWrkQtyUnit5ISOCode`          | String ML=3    | ISOCD_UNIT                  |        | ISO Code                       |
| 73  | `StdWrkQtyUnit5SAPCode`          | String ML=3    | VGE05                       |        | Internal SAP Code              |
| 74  | `WorkCenterStandardWorkQty5`     | Decimal (9,3)  | VGW05                       |        | Standard Value                 |
| 75  | `WorkCenterStandardWorkQtyUnit6` | String ML=3    | VGE06                       |        | Work Quantity Unit 6           |
| 76  | `StdWrkQtyUnit6ISOCode`          | String ML=3    | ISOCD_UNIT                  |        | ISO Code                       |
| 77  | `StdWrkQtyUnit6SAPCode`          | String ML=3    | VGE06                       |        | Internal SAP Code              |
| 78  | `WorkCenterStandardWorkQty6`     | Decimal (9,3)  | VGW06                       |        | Standard Value                 |
| 79  | `OpTotalConfirmedScrapQty`       | Decimal (13,3) | XMNGA                       |        | Confirmed Scrap                |
| 80  | `OpPlannedScrapQuantity`         | Decimal (13,3) | n/d                         |        | Planned Scrap                  |
| 81  | `OperationReferenceQuantity`     | Decimal (13,3) | BMSCH                       |        | Base Quantity                  |
| 82  | `LastChangeDateTime`             | String ML=14   | n/d (timestamp)             |        |                                |
| 83  | `CompletionConfirmationCode`     | String ML=1    | n/d                         |        | Confirmations                  |
| 84  | `OperationIsNotMESRelevant`      | Boolean        | n/d (flag)                  |        | Not Relevant for MES           |
| 85  | `MESOperation`                   | String ML=36   | n/d                         |        | Operation                      |
| 86  | `MESObjectVersion`               | String ML=4    | n/d                         |        | Version (SAP ME)               |

### Struttura `ZMARS_PROD_ORDER_T_COMPONENT` — A_ProductionOrderComponent_2 (59 campi)

Riga della tabella (line type). Campi dall'entity type `A_ProductionOrderComponent_2Type`.

| #   | Campo (OData)                    | Edm Type       | Data element SAP (proposto) | Chiave | Descrizione               |
| --- | -------------------------------- | -------------- | --------------------------- | :----: | ------------------------- |
| 1   | `Reservation`                    | String ML=10   | RSNUM                       |   ✓    | Reservation               |
| 2   | `ReservationItem`                | String ML=4    | RSPOS                       |   ✓    | Reservation Item          |
| 3   | `MaterialGroup`                  | String ML=9    | MATKL                       |        | Material Group            |
| 4   | `Material`                       | String ML=40   | MATNR                       |        | Material                  |
| 5   | `Plant`                          | String ML=4    | WERKS_D                     |        | Plant                     |
| 6   | `ManufacturingOrderCategory`     | String ML=2    | AUTYP                       |        | Order Category            |
| 7   | `ManufacturingOrderType`         | String ML=4    | AUFART                      |        | Order Type                |
| 8   | `ManufacturingOrder`             | String ML=12   | AUFNR                       |        | Production Order          |
| 9   | `ManufacturingOrderSequence`     | String ML=6    | PLNFL                       |        | Sequence                  |
| 10  | `ManufacturingOrderOperation`    | String ML=4    | VORNR                       |        | Operation                 |
| 11  | `ProductionPlant`                | String ML=4    | WERKS_D                     |        | Production Plant          |
| 12  | `OrderInternalBillOfOperations`  | String ML=10   | AUFPL                       |        | Order Internal ID         |
| 13  | `MatlCompRequirementDate`        | DateTime       | BDTER                       |        | Requirement Date          |
| 14  | `MatlCompRequirementTime`        | Time           | n/d                         |        | Requirement Time          |
| 15  | `ReservationIsFinallyIssued`     | Boolean        | KZEAR                       |        | Final Issue               |
| 16  | `MatlCompIsMarkedForDeletion`    | Boolean        | XLOEK                       |        | Marked for Deletion       |
| 17  | `IsBulkMaterialComponent`        | Boolean        | SCHGT                       |        | Bulk material             |
| 18  | `MatlCompIsMarkedForBackflush`   | Boolean        | RGEKZ                       |        | Backflush                 |
| 19  | `MaterialCompIsCostRelevant`     | String ML=1    | SANKA                       |        | CostingRelevncy           |
| 20  | `OrderComponentLongText`         | String         | n/d (testo)                 |        | Long Text                 |
| 21  | `SalesOrder`                     | String ML=10   | KDAUF                       |        | Sales Order               |
| 22  | `SalesOrderItem`                 | String ML=6    | KDPOS                       |        | Sales Order Item          |
| 23  | `SortField`                      | String ML=10   | SORTF                       |        | Sort String               |
| 24  | `BillOfMaterialCategory`         | String ML=1    | STLTY                       |        | BOM Category              |
| 25  | `BOMItem`                        | String ML=8    | STPOZ                       |        | BOM Item                  |
| 26  | `BOMItemCategory`                | String ML=1    | POSTP                       |        | BOM Item Category         |
| 27  | `BillOfMaterialItemNumber`       | String ML=4    | POSNR                       |        | BOM Item                  |
| 28  | `BOMItemDescription`             | String ML=40   | POTX1                       |        | BOM Item Text             |
| 29  | `StorageLocation`                | String ML=4    | LGORT_D                     |        | Storage Location          |
| 30  | `Batch`                          | String ML=10   | CHARG_D                     |        | Batch                     |
| 31  | `BatchSplitType`                 | String ML=1    | n/d                         |        |                           |
| 32  | `GoodsMovementType`              | String ML=3    | BWART                       |        | Movement Type             |
| 33  | `SupplyArea`                     | String ML=10   | PRVBE                       |        | Production Supply Area    |
| 34  | `GoodsRecipientName`             | String ML=12   | WEMPF                       |        | Goods Recipient           |
| 35  | `UnloadingPointName`             | String ML=25   | ABLAD                       |        | Unloading Point           |
| 36  | `MaterialCompIsAlternativeItem`  | Boolean        | n/d (flag)                  |        | Alternative Item          |
| 37  | `AlternativeItemGroup`           | String ML=2    | ALPGR                       |        | Alternative Item Group    |
| 38  | `AlternativeItemStrategy`        | String ML=1    | ALPST                       |        | Alternative Item Strategy |
| 39  | `AlternativeItemPriority`        | String ML=2    | ALPRF                       |        | Alternative Item Priority |
| 40  | `UsageProbabilityPercent`        | Decimal (3,0)  | EWAHR                       |        | Usage Probability         |
| 41  | `MaterialComponentIsPhantomItem` | Boolean        | n/d (flag)                  |        | Phantom Item              |
| 42  | `LeadTimeOffset`                 | Decimal (3,0)  | NLFZT                       |        | Lead-Time Offset          |
| 43  | `QuantityIsFixed`                | Boolean        | FMENG                       |        | Quantity is fixed         |
| 44  | `IsNetScrap`                     | Boolean        | NETAU                       |        | Net Scrap Indicator       |
| 45  | `ComponentScrapInPercent`        | Decimal (5,2)  | AUSCH                       |        | Component Scrap (%)       |
| 46  | `OperationScrapInPercent`        | Decimal (5,2)  | AVOAU                       |        | Operation Scrap in %      |
| 47  | `BaseUnit`                       | String ML=3    | MEINS                       |        | Base Unit of Measure      |
| 48  | `BaseUnitISOCode`                | String ML=3    | ISOCD_UNIT                  |        | ISO Code                  |
| 49  | `BaseUnitSAPCode`                | String ML=3    | MEINS                       |        | Internal SAP Code         |
| 50  | `RequiredQuantity`               | Decimal (13,3) | BDMNG                       |        | Requirement Quantity      |
| 51  | `WithdrawnQuantity`              | Decimal (13,3) | ENMNG                       |        | Withdrawn Quantity        |
| 52  | `ConfirmedAvailableQuantity`     | Decimal (15,3) | n/d                         |        | Available Quantity        |
| 53  | `MaterialCompOriginalQuantity`   | Decimal (13,3) | n/d                         |        | Original Quantity         |
| 54  | `EntryUnit`                      | String ML=3    | ERFME                       |        | Unit of Entry             |
| 55  | `EntryUnitISOCode`               | String ML=3    | ISOCD_UNIT                  |        | ISO Code                  |
| 56  | `EntryUnitSAPCode`               | String ML=3    | ERFME                       |        | Internal SAP Code         |
| 57  | `GoodsMovementEntryQty`          | Decimal (13,3) | ERFMG                       |        | Quantity in Unit of Entry |
| 58  | `Currency`                       | String ML=5    | WAERS                       |        | Currency                  |
| 59  | `WithdrawnQuantityAmount`        | Decimal (14,3) | n/d                         |        | Value Withdrawn           |

---

## Function Group `ZMARS_FG_CLASSIFICATION` — **proposta di specifica**

> Le FM dei servizi `API_CLFN_PRODUCT_SRV` e `API_CLFN_CHARACTERISTIC_SRV` **non sono ancora a
> sistema**. La specifica seguente è una **proposta** che replica le convenzioni consolidate delle
> FG Product/Routing: IMPORT = `IV_` chiavi scalari / `SO_` filtri select-options
> (`TYPE TT_RSDSSELOPT`), tutti _Pass Value_; EXPORT = table type `ET_<entità>`. Nomi FM
> (≤30 caratteri), data element e table type sono **da confermare/creare**. Campi e chiavi derivano
> dai metadati EDMX (`OP_API_CLFN_PRODUCT_SRV.edmx`, `OP_API_CLFN_CHARACTERISTIC_SRV.edmx`).
>
> Le API di classificazione sono **key-date dependent**: dove l'entità espone il campo `KeyDate`
> si prevede il parametro `IV_KEY_DATE` (`TYPE DATS`, default = data odierna) che valorizza il
> parametro OData `KeyDate`.

### `ZMARS_PRODUCT_CLASS_GET` — A_ProductClass (lettura per chiave + query)

Serve sia il GET per chiave (`Product` + `ClassInternalID`) sia la QUERY (filtri `SO_`).

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro              | Data element               | Opz. | Short text        | OData / uso                  |
| ---------------------- | -------------------------- | :--: | ----------------- | ---------------------------- |
| `SO_PRODUCT`           | TT_RSDSSELOPT              |      | Object / Prodotto | `Product` — **obbligatorio** |
| `SO_CLASS_INTERNAL_ID` | TT_RSDSSELOPT              |  ✓   | Int. Class No.    | `ClassInternalID`            |
| `SO_CLASS_TYPE`        | TT_RSDSSELOPT              |  ✓   | Class Type        | `ClassType`                  |
| `IV_KEY_DATE`          | DATS                       |  ✓   | Key date          | `KeyDate`                    |
| `IV_CHANGE_NUMBER`     | AENNR                      |  ✓   | Change Number     | `ChangeNumber`               |
| `IV_TOP`               | INT4                       |  ✓   | Natural Number    | ≈`$top`                      |
| `IV_SKIP`              | INT4                       |  ✓   | Natural Number    | ≈`$skip`                     |
| `IV_ORDER_BY`          | `ZMARS_ROUTING_T_ORDER_BY` |  ✓   | Order by          | ≈`$orderby`                  |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro          | Tipo (table type)            | Note                                  |
| ------------------ | ---------------------------- | ------------------------------------- |
| `ET_PRODUCT_CLASS` | `ZMARS_CLFN_T_PRODUCT_CLASS` | tabella (A_ProductClassType, 5 campi) |

### `ZMARS_CLFN_CLASS_GET` — A_ClfnClassForKeyDate (lettura per chiave)

Chiave = `ClassInternalID`; lettura per chiave (GET).

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro              | Data element | Opz. | Short text     | OData             |
| ---------------------- | ------------ | :--: | -------------- | ----------------- |
| `IV_CLASS_INTERNAL_ID` | CLINT        |      | Int. Class No. | `ClassInternalID` |
| `IV_KEY_DATE`          | DATS         |  ✓   | Key date       | `KeyDate`         |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro  | Tipo (table type)    | Note                                          |
| ---------- | -------------------- | --------------------------------------------- |
| `ET_CLASS` | `ZMARS_CLFN_T_CLASS` | tabella (A_ClfnClassForKeyDateType, 29 campi) |

### `ZMARS_PRODUCT_CLASS_CHARC_GET` — A_ProductClassCharc (lettura per chiave)

Chiave = `Product` + `ClassInternalID` + `CharcInternalID`.

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro              | Data element | Opz. | Short text                 | OData             |
| ---------------------- | ------------ | :--: | -------------------------- | ----------------- |
| `IV_PRODUCT`           | MATNR        |      | Object / Prodotto          | `Product`         |
| `IV_CLASS_INTERNAL_ID` | CLINT        |      | Int. Class No.             | `ClassInternalID` |
| `IV_CHARC_INTERNAL_ID` | ATINN        |      | Characteristic Internal ID | `CharcInternalID` |
| `IV_KEY_DATE`          | DATS         |  ✓   | Key date                   | `KeyDate`         |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro                | Tipo (table type)               | Note                                       |
| ------------------------ | ------------------------------- | ------------------------------------------ |
| `ET_PRODUCT_CLASS_CHARC` | `ZMARS_CLFN_T_PROD_CLASS_CHARC` | tabella (A_ProductClassCharcType, 6 campi) |

### `ZMARS_PRODUCT_CHARC_VALUE_GET` — A_ProductCharcValue (lettura per chiave)

Chiave = `Product` + `ClassType` + `CharcInternalID` + `CharcValuePositionNumber`.

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro                 | Data element | Opz. | Short text                 | OData                      |
| ------------------------- | ------------ | :--: | -------------------------- | -------------------------- |
| `IV_PRODUCT`              | MATNR        |      | Object / Prodotto          | `Product`                  |
| `IV_CLASS_TYPE`           | KLART        |      | Class Type                 | `ClassType`                |
| `IV_CHARC_INTERNAL_ID`    | ATINN        |      | Characteristic Internal ID | `CharcInternalID`          |
| `IV_CHARC_VALUE_POSITION` | ATZHL        |      | Counter                    | `CharcValuePositionNumber` |
| `IV_KEY_DATE`             | DATS         |  ✓   | Key date                   | `KeyDate`                  |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro                | Tipo (table type)               | Note                                        |
| ------------------------ | ------------------------------- | ------------------------------------------- |
| `ET_PRODUCT_CHARC_VALUE` | `ZMARS_CLFN_T_PROD_CHARC_VALUE` | tabella (A_ProductCharcValueType, 23 campi) |

### `ZMARS_CHARACTERISTIC_GET` — A_ClfnCharacteristicForKeyDate (lettura per chiave + query)

Serve sia il GET per chiave (`CharcInternalID`) sia la QUERY (filtri `SO_`).

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro              | Data element               | Opz. | Short text                 | OData / uso                    |
| ---------------------- | -------------------------- | :--: | -------------------------- | ------------------------------ |
| `IV_CHARC_INTERNAL_ID` | ATINN                      |  ✓   | Characteristic Internal ID | `CharcInternalID` (chiave GET) |
| `SO_CHARACTERISTIC`    | TT_RSDSSELOPT              |  ✓   | Characteristic Name        | `Characteristic`               |
| `SO_CHARC_GROUP`       | TT_RSDSSELOPT              |  ✓   | Characteristic Group       | `CharcGroup`                   |
| `SO_CHARC_STATUS`      | TT_RSDSSELOPT              |  ✓   | Status                     | `CharcStatus`                  |
| `IV_KEY_DATE`          | DATS                       |  ✓   | Key date                   | `KeyDate`                      |
| `IV_TOP`               | INT4                       |  ✓   | Natural Number             | ≈`$top`                        |
| `IV_SKIP`              | INT4                       |  ✓   | Natural Number             | ≈`$skip`                       |
| `IV_ORDER_BY`          | `ZMARS_ROUTING_T_ORDER_BY` |  ✓   | Order by                   | ≈`$orderby`                    |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro           | Tipo (table type)             | Note                                                        |
| ------------------- | ----------------------------- | ----------------------------------------------------------- |
| `ET_CHARACTERISTIC` | `ZMARS_CLFN_T_CHARACTERISTIC` | tabella (A_ClfnCharacteristicForKeyDateType, 45 campi EDMX) |

**Da confermare per il FG `ZMARS_FG_CLASSIFICATION`:**

- Nome definitivo di function group e FM (proposta `ZMARS_FG_CLASSIFICATION` / `ZMARS_*_GET`).
- Creazione dei **table type** `ZMARS_CLFN_T_*` e delle relative strutture di riga `ZMARS_CLFN_S_*`.
- Data element delle chiavi/campi (proposte standard classificazione: `MATNR`, `CLINT`, `KLART`,
  `ATINN`, `ATNAM`, `ATWRT`, `ATZHL`): **da verificare sul DDIC**.
- Gestione del parametro **`IV_KEY_DATE`** (default = data odierna) per le entità `...ForKeyDate`.
- Nel service `API_CLFN_CHARACTERISTIC_SRV` i campi `Delete_mc`, `Update_mc` e `to_*_oc` sono
  **campi tecnici di controllo OData** (method/navigation control): **esclusi** dalla struttura di
  riga ABAP (39 campi dati sui 45 esposti dall'entity type).

---

## Strutture di riga dei table type Classification

Dettaglio dei campi delle strutture di riga (line type) dei table type esportati dalle FM
`ZMARS_FG_CLASSIFICATION`. I campi derivano **1:1 dagli entity type EDMX**. Nome proposto della
struttura di riga: `ZMARS_CLFN_S_<ENTITÀ>` (il table type `ZMARS_CLFN_T_<ENTITÀ>` è
`STANDARD TABLE OF` di tale struttura).

> **Data element SAP**: sono **proposte** basate sui campi standard della classificazione
> (KLAH/KSSK/AUSP/CABN/CAWN…). Vanno **verificati sul CDS/DDIC** in fase di creazione. `n/d`
> indica campi derivati/di stato privi di un data element classico univoco.

### Struttura `ZMARS_CLFN_T_PRODUCT_CLASS` — A_ProductClass (5 campi)

| #   | Campo (OData)     | Edm Type     | Data element SAP (proposto) | Chiave | Descrizione       |
| --- | ----------------- | ------------ | --------------------------- | :----: | ----------------- |
| 1   | `Product`         | String ML=90 | MATNR                       |   ✓    | Object / Prodotto |
| 2   | `ClassInternalID` | String ML=10 | CLINT                       |   ✓    | Int. Class No.    |
| 3   | `KeyDate`         | DateTime     | SYDATUM                     |        | Key date          |
| 4   | `ChangeNumber`    | String ML=12 | AENNR                       |        | Change Number     |
| 5   | `ClassType`       | String ML=3  | KLART                       |        | Class Type        |

### Struttura `ZMARS_CLFN_T_CLASS` — A_ClfnClassForKeyDate (29 campi)

| #   | Campo (OData)                   | Edm Type       | Data element SAP (proposto) | Chiave | Descrizione       |
| --- | ------------------------------- | -------------- | --------------------------- | :----: | ----------------- |
| 1   | `ClassInternalID`               | String ML=10   | CLINT                       |   ✓    | Int. Class No.    |
| 2   | `ClassType`                     | String ML=3    | KLART                       |        | Class Type        |
| 3   | `ClassTypeName`                 | String ML=40   | n/d (testo)                 |        | Description       |
| 4   | `Class`                         | String ML=18   | KLASSE                      |        | Class             |
| 5   | `ClassStatus`                   | String ML=1    | n/d (stato)                 |        | Status            |
| 6   | `ClassStatusName`               | String ML=40   | n/d (testo)                 |        | Text              |
| 7   | `ClassGroup`                    | String ML=10   | n/d                         |        | Class group       |
| 8   | `ClassGroupName`                | String ML=40   | n/d (testo)                 |        | Class Group       |
| 9   | `ClassSearchAuthGrp`            | String ML=3    | n/d                         |        | Find Objects      |
| 10  | `ClassClassfctnAuthGrp`         | String ML=3    | n/d                         |        | Classification    |
| 11  | `ClassMaintAuthGrp`             | String ML=3    | n/d                         |        | Class Maintenance |
| 12  | `DocNumber`                     | String ML=25   | DOKNR                       |        | Document          |
| 13  | `DocumentType`                  | String ML=3    | DOKAR                       |        | Document Type     |
| 14  | `DocumentPart`                  | String ML=3    | DOKTL                       |        | Document Part     |
| 15  | `DocumentVersion`               | String ML=2    | DOKVR                       |        | Document Version  |
| 16  | `SameClassfctnReaction`         | String ML=1    | n/d (flag)                  |        | Single-Char Flag  |
| 17  | `ClassStandardOrgName`          | String ML=10   | n/d                         |        | Standard          |
| 18  | `ClassStandardNumber`           | String ML=20   | n/d                         |        | Standard number   |
| 19  | `ClassStandardStartDate`        | DateTime       | DATS                        |        | Issue date        |
| 20  | `ClassStandardVersionStartDate` | DateTime       | DATS                        |        | Version date      |
| 21  | `ClassStandardVersion`          | String ML=2    | n/d                         |        | Version Number    |
| 22  | `ClassStandardCharcTable`       | String ML=20   | n/d                         |        | Chars table       |
| 23  | `CreationDate`                  | DateTime       | ERSDA                       |        | Created On        |
| 24  | `LastChangeDate`                | DateTime       | AEDAT                       |        | Changed On        |
| 25  | `ClassIsLocal`                  | Boolean        | n/d (flag)                  |        | Local class       |
| 26  | `ValidityStartDate`             | DateTime       | DATUV                       |        | Valid From        |
| 27  | `ValidityEndDate`               | DateTime       | DATUB                       |        | Valid to          |
| 28  | `ClassLastChangedDateTime`      | DateTimeOffset | TZNTSTMPS                   |        | Time Stamp        |
| 29  | `KeyDate`                       | DateTime       | SYDATUM                     |        | Key date          |

### Struttura `ZMARS_CLFN_T_PROD_CLASS_CHARC` — A_ProductClassCharc (6 campi)

| #   | Campo (OData)     | Edm Type     | Data element SAP (proposto) | Chiave | Descrizione                |
| --- | ----------------- | ------------ | --------------------------- | :----: | -------------------------- |
| 1   | `Product`         | String ML=90 | MATNR                       |   ✓    | Object / Prodotto          |
| 2   | `ClassInternalID` | String ML=10 | CLINT                       |   ✓    | Int. Class No.             |
| 3   | `CharcInternalID` | String ML=10 | ATINN                       |   ✓    | Characteristic Internal ID |
| 4   | `KeyDate`         | DateTime     | SYDATUM                     |        | Key date                   |
| 5   | `ChangeNumber`    | String ML=12 | AENNR                       |        | Change Number              |
| 6   | `ClassType`       | String ML=3  | KLART                       |        | Class Type                 |

### Struttura `ZMARS_CLFN_T_PROD_CHARC_VALUE` — A_ProductCharcValue (23 campi)

| #   | Campo (OData)               | Edm Type        | Data element SAP (proposto) | Chiave | Descrizione                |
| --- | --------------------------- | --------------- | --------------------------- | :----: | -------------------------- |
| 1   | `Product`                   | String ML=90    | MATNR                       |   ✓    | Object / Prodotto          |
| 2   | `ClassType`                 | String ML=3     | KLART                       |   ✓    | Class Type                 |
| 3   | `CharcInternalID`           | String ML=10    | ATINN                       |   ✓    | Characteristic Internal ID |
| 4   | `CharcValuePositionNumber`  | String ML=3     | ATZHL                       |   ✓    | Counter                    |
| 5   | `KeyDate`                   | DateTime        | SYDATUM                     |        | Key date                   |
| 6   | `ChangeNumber`              | String ML=12    | AENNR                       |        | Change Number              |
| 7   | `CharcValueDependency`      | String ML=1     | n/d (code)                  |        | Code                       |
| 8   | `CharcValue`                | String ML=70    | ATWRT                       |        | Characteristic Value       |
| 9   | `CharcFromNumericValue`     | Double          | ATFLV                       |        | Value from                 |
| 10  | `CharcFromNumericValueUnit` | String ML=3     | MSEHI                       |        | Internal UoM               |
| 11  | `CharcToNumericValue`       | Double          | ATFLB                       |        | Value to                   |
| 12  | `CharcToNumericValueUnit`   | String ML=3     | MSEHI                       |        | Internal UoM               |
| 13  | `CharcFromDecimalValue`     | Decimal (31,14) | n/d                         |        | LowrBndry Nmrc             |
| 14  | `CharcToDecimalValue`       | Decimal (31,14) | n/d                         |        | UprBndry Nmrc              |
| 15  | `CharcFromAmount`           | Decimal (24,3)  | n/d                         |        | LowrBndry Crcy             |
| 16  | `CharcToAmount`             | Decimal (24,3)  | n/d                         |        | UprBndry Crcy              |
| 17  | `Currency`                  | String ML=5     | WAERS                       |        | Currency                   |
| 18  | `CharcFromDate`             | DateTime        | DATS                        |        | LowrBndry Date             |
| 19  | `CharcToDate`               | DateTime        | DATS                        |        | UprBndry Date              |
| 20  | `CharcFromTime`             | Time            | TIMS                        |        | LowrBndry Time             |
| 21  | `CharcToTime`               | Time            | TIMS                        |        | UprBndry Time              |
| 22  | `CharacteristicAuthor`      | String ML=1     | n/d                         |        | Author                     |
| 23  | `CharcMaintAuthGrp`         | String ML=3     | n/d                         |        | Authorization Group        |

### Struttura `ZMARS_CLFN_T_CHARACTERISTIC` — A_ClfnCharacteristicForKeyDate (45 campi EDMX)

> I campi 1–6 (`Delete_mc`, `Update_mc`, `to_*_oc`) sono **campi di controllo OData**
> (method/navigation control): **da escludere** dalla struttura di riga ABAP. La struttura utile
> è quindi di **39 campi dati** (dal #7 in poi).

| #   | Campo (OData)                     | Edm Type       | Data element SAP (proposto) | Chiave | Descrizione                     |
| --- | --------------------------------- | -------------- | --------------------------- | :----: | ------------------------------- |
| 1   | `Delete_mc`                       | Boolean        | — (controllo OData)         |        | Dyn. Method Control (escluso)   |
| 2   | `Update_mc`                       | Boolean        | — (controllo OData)         |        | Dyn. Method Control (escluso)   |
| 3   | `to_CharacteristicDesc_oc`        | Boolean        | — (controllo navigazione)   |        | Dynamic CbA-Control (escluso)   |
| 4   | `to_CharacteristicReference_oc`   | Boolean        | — (controllo navigazione)   |        | Dynamic CbA-Control (escluso)   |
| 5   | `to_CharacteristicRestriction_oc` | Boolean        | — (controllo navigazione)   |        | Dynamic CbA-Control (escluso)   |
| 6   | `to_CharacteristicValue_oc`       | Boolean        | — (controllo navigazione)   |        | Dynamic CbA-Control (escluso)   |
| 7   | `CharcInternalID`                 | String ML=10   | ATINN                       |   ✓    | Characteristic Internal ID      |
| 8   | `Characteristic`                  | String ML=30   | ATNAM                       |        | Characteristic Name             |
| 9   | `CharcStatus`                     | String ML=1    | n/d (stato)                 |        | Status                          |
| 10  | `CharcStatusName`                 | String ML=20   | n/d (testo)                 |        | Char. Status                    |
| 11  | `CharcDataType`                   | String ML=4    | ATFOR                       |        | Format                          |
| 12  | `CharcLength`                     | Int16          | ATANZ                       |        | Number of Characters            |
| 13  | `CharcDecimals`                   | Int16          | ATDEZ                       |        | Decimal Places                  |
| 14  | `CharcTemplate`                   | String ML=70   | n/d                         |        | Template                        |
| 15  | `ValueIsCaseSensitive`            | Boolean        | n/d (flag)                  |        | Case Sensitive                  |
| 16  | `CharcGroup`                      | String ML=10   | n/d                         |        | Characteristic Group            |
| 17  | `CharcGroupName`                  | String ML=40   | n/d (testo)                 |        | Char. Group                     |
| 18  | `EntryIsRequired`                 | Boolean        | n/d (flag)                  |        | Entry Required                  |
| 19  | `MultipleValuesAreAllowed`        | Boolean        | n/d (flag)                  |        | Multiple Values Allowed         |
| 20  | `CharcValueUnit`                  | String ML=3    | MSEHI                       |        | Internal UoM                    |
| 21  | `UnitOfMeasureISOCode`            | String ML=3    | ISOCD_UNIT                  |        | ISO Code                        |
| 22  | `Currency`                        | String ML=5    | WAERS                       |        | Currency                        |
| 23  | `CurrencyISOCode`                 | String ML=3    | ISOCD_UNIT                  |        | ISO Code                        |
| 24  | `CharcExponentValue`              | Int16          | n/d                         |        | Exponent                        |
| 25  | `ValueIntervalIsAllowed`          | Boolean        | n/d (flag)                  |        | Interval Values Allowed         |
| 26  | `AdditionalValueIsAllowed`        | Boolean        | n/d (flag)                  |        | Additional Values               |
| 27  | `NegativeValueIsAllowed`          | Boolean        | n/d (flag)                  |        | +/- Sign                        |
| 28  | `ValidityStartDate`               | DateTime       | DATUV                       |        | Valid From                      |
| 29  | `ValidityEndDate`                 | DateTime       | DATUB                       |        | Valid to                        |
| 30  | `ChangeNumber`                    | String ML=12   | AENNR                       |        | Change Number                   |
| 31  | `DocumentType`                    | String ML=3    | DOKAR                       |        | Document Type                   |
| 32  | `DocNumber`                       | String ML=25   | DOKNR                       |        | Document                        |
| 33  | `DocumentVersion`                 | String ML=2    | DOKVR                       |        | Document Version                |
| 34  | `DocumentPart`                    | String ML=3    | DOKTL                       |        | Document Part                   |
| 35  | `CharcMaintAuthGrp`               | String ML=3    | n/d                         |        | Authorization Group             |
| 36  | `CharcIsReadOnly`                 | Boolean        | n/d (flag)                  |        | No Entry Allowed for Charc.     |
| 37  | `CharcIsHidden`                   | Boolean        | n/d (flag)                  |        | Charc. Not To Be Displayed      |
| 38  | `CharcIsRestrictable`             | String ML=1    | n/d (flag)                  |        | Restrictable                    |
| 39  | `CharcExponentFormat`             | String ML=1    | n/d                         |        | Exponent Display                |
| 40  | `CharcEntryIsNotFormatCtrld`      | Boolean        | n/d (flag)                  |        | Unformatted Entry Control       |
| 41  | `CharcTemplateIsDisplayed`        | Boolean        | n/d (flag)                  |        | Display Template When Assigning |
| 42  | `CreationDate`                    | DateTime       | ERSDA                       |        | Created On                      |
| 43  | `LastChangeDate`                  | DateTime       | AEDAT                       |        | Changed On                      |
| 44  | `CharcLastChangedDateTime`        | DateTimeOffset | TZNTSTMPS                   |        | Time Stamp                      |
| 45  | `KeyDate`                         | DateTime       | SYDATUM                     |        | Key date                        |

---

## Function Group `ZMARS_FG_MATERIAL_BOM` — **proposta di specifica**

> Servizio OData `API_BILL_OF_MATERIAL_SRV` (§ 6). FM di **sola lettura** (GET/QUERY più
> l'esplosione). Nomi, data element e table type sono **da confermare/creare**.

### `ZMARS_BOM_GET` — MaterialBOM (lettura per chiave + query)

Serve la lettura per chiave (7 campi chiave BOM) e la query per `Material`/`Plant`.

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro           | Data element / tipo | Opz. | Short text              | OData                       |
| ------------------- | ------------------- | :--: | ----------------------- | --------------------------- |
| `SO_MATERIAL`       | TT_RSDSSELOPT       |      | Material                | `Material` — **obbligatorio** |
| `SO_PLANT`          | TT_RSDSSELOPT       |      | Plant                   | `Plant` — **obbligatorio**  |
| `IV_BILL_OF_MATERIAL` | STLNR             |  ✓   | Bill of Material        | `BillOfMaterial`            |
| `IV_BOM_CATEGORY`   | STLTY               |  ✓   | BOM category            | `BillOfMaterialCategory`    |
| `IV_BOM_VARIANT`    | STLAL               |  ✓   | Alternative BOM         | `BillOfMaterialVariant`     |
| `IV_BOM_VERSION`    | n/d (ML4)           |  ✓   | BOM Version             | `BillOfMaterialVersion`     |
| `IV_CHANGE_NUMBER`  | AENNR               |  ✓   | Change Number           | `EngineeringChangeDocument` |
| `SO_BOM_USAGE`      | TT_RSDSSELOPT       |  ✓   | BOM Usage               | `BillOfMaterialVariantUsage` |
| `IV_TOP`            | INT4                |  ✓   | Natural Number          | ≈`$top`                     |
| `IV_SKIP`           | INT4                |  ✓   | Natural Number          | ≈`$skip`                    |
| `IV_ORDER_BY`       | `ZMARS_ROUTING_T_ORDER_BY` | ✓ | Order by             | ≈`$orderby`                 |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro | Tipo (table type)     | Note                                                    |
| --------- | --------------------- | ------------------------------------------------------- |
| `ET_BOM`  | `ZMARS_BOM_T_HEADER`  | tabella (MaterialBOMType, 46 campi — struttura di riga = § 6) |

### `ZMARS_BOM_EXPLODE_GET` — ExplodeBOM (lettura / esplosione)

Wrapper del Function Import OData `ExplodeBOM` (metodo GET). I 7 parametri chiave sono
obbligatori; i restanti sono filtri opzionali dell'esplosione (rif. § 6 per l'elenco completo).

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro                | Data element / tipo | Opz. | Short text                | OData                       |
| ------------------------ | ------------------- | :--: | ------------------------- | --------------------------- |
| `IV_BILL_OF_MATERIAL`    | STLNR               |      | Bill of Material          | `BillOfMaterial`            |
| `IV_BOM_CATEGORY`        | STLTY               |      | BOM category              | `BillOfMaterialCategory`    |
| `IV_BOM_VARIANT`         | STLAL               |      | Alternative BOM           | `BillOfMaterialVariant`     |
| `IV_BOM_VERSION`         | n/d (ML4)           |      | BOM Version               | `BillOfMaterialVersion`     |
| `IV_CHANGE_NUMBER`       | AENNR               |      | Change Number             | `EngineeringChangeDocument` |
| `IV_MATERIAL`            | MATNR               |      | Material                  | `Material`                  |
| `IV_PLANT`               | WERKS_D             |      | Plant                     | `Plant`                     |
| `IV_REQUIRED_QUANTITY`   | MENGE_D             |  ✓   | Required Quantity         | `RequiredQuantity`          |
| `IV_EXPLOSION_DATE`      | DATS                |  ✓   | Explosion Date            | `BOMExplosionDate`          |
| `IV_EXPLOSION_APPL`      | CSAP_APPL (ML4)     |  ✓   | Application               | `BOMExplosionApplication`   |
| `IV_EXPLOSION_MULTILEVEL` | XFELD              |  ✓   | Multilevel                | `BOMExplosionIsMultilevel`  |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro          | Tipo (table type)      | Note                                                        |
| ------------------ | ---------------------- | ----------------------------------------------------------- |
| `ET_BOM_EXPLOSION` | `ZMARS_BOM_T_EXPLOSION` | tabella risultato dell'esplosione (`DBomheaderforexplosionOut`, struttura di riga **da definire** sul complex type EDMX) |

**Da confermare per il FG `ZMARS_FG_MATERIAL_BOM`:**

- Data element per `BillOfMaterial` (`STLNR` vs `STNUM`) e `BillOfMaterialVersion` (nessun DE standard evidente).
- Struttura di riga del risultato `ExplodeBOM` (complex type `DBomheaderforexplosionOut` + eventuali item annidati).
- Se serve QUERY su `MaterialBOM` con filtri aggiuntivi oltre `Material`/`Plant`.

---

## Function Group `ZMARS_FG_MATERIAL_DOC` — **proposta di specifica**

> Servizio OData `API_MATERIAL_DOCUMENT_SRV` (§ 7). FM di **scrittura** (registrazione movimento
> merci). Sostituisce il deep insert OData (non fattibile su IS) con un wrapper **piatto**
> header + righe, tipicamente su `BAPI_GOODSMVT_CREATE`.

### `ZMARS_MATERIAL_DOC_POST` — A_MaterialDocumentHeader (+ righe) (POST)

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro               | Tipo                     | Opz. | Note                                                             |
| ----------------------- | ------------------------ | :--: | ---------------------------------------------------------------- |
| `IS_HEADER`             | `ZMARS_MATDOC_S_HEADER`  |      | struttura header (A_MaterialDocumentHeaderType, 14 campi — § 7)  |
| `IT_ITEM`               | `ZMARS_MATDOC_T_ITEM`    |      | tabella righe (A_MaterialDocumentItemType, 94 campi — § 7)       |
| `IV_GOODS_MOVEMENT_CODE` | GM_CODE                 |  ✓   | codice operazione movimento (`GoodsMovementCode`)                |
| `IV_TEST_RUN`           | XFELD                    |  ✓   | esecuzione di test (nessuna registrazione effettiva)             |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro             | Tipo                 | Note                                     |
| --------------------- | -------------------- | ---------------------------------------- |
| `EV_MATERIAL_DOCUMENT` | MBLNR               | numero documento materiale creato        |
| `EV_MATERIAL_DOC_YEAR` | MJAHR               | anno del documento materiale             |
| `ET_RETURN`           | `BAPIRET2` (tabella) | messaggi di esito (errori/warning)       |

**Da confermare per il FG `ZMARS_FG_MATERIAL_DOC`:**

- BAPI/logica sottostante (`BAPI_GOODSMVT_CREATE`) e mapping `GoodsMovementCode`.
- Gestione **COMMIT WORK** / rollback e ritorno del documento creato.
- Sottoinsieme dei 94 campi riga effettivamente richiesti per i movimenti previsti.

---

## Function Group `ZMARS_FG_PROD_ORDER_CONF` — **proposta di specifica**

> Servizio OData `API_PROD_ORDER_CONFIRMATION_2_SRV` (§ 8). FM di **scrittura** (conferma ordine
> di produzione), tipicamente su `BAPI_PRODORDCONF_CREATE_TT`.

### `ZMARS_PROD_ORDER_CONF_POST` — ProdnOrdConf2 (POST)

Le chiavi `ConfirmationGroup`/`ConfirmationCount` sono **assegnate da SAP** e restituite in export.

**IMPORTING** (`TYPE`, _Pass Value_)

| Parametro          | Tipo                       | Opz. | Note                                                            |
| ------------------ | -------------------------- | :--: | --------------------------------------------------------------- |
| `IS_CONFIRMATION`  | `ZMARS_PRODCONF_S_CONF`    |      | struttura conferma (campi funzionali di `ProdnOrdConf2` — § 8)  |
| `IV_POST_ERRORS`   | XFELD                      |  ✓   | registra anche conferme con errori risolvibili                  |

**EXPORTING** (`TYPE`, _Pass Value_)

| Parametro               | Tipo                 | Note                             |
| ----------------------- | -------------------- | -------------------------------- |
| `EV_CONFIRMATION_GROUP` | CO_RUECK             | `ConfirmationGroup` assegnato    |
| `EV_CONFIRMATION_COUNT` | CO_RMZHL             | `ConfirmationCount` assegnato    |
| `ET_RETURN`             | `BAPIRET2` (tabella) | messaggi di esito                |

**Da confermare per il FG `ZMARS_FG_PROD_ORDER_CONF`:**

- Campi realmente obbligatori in `IS_CONFIRMATION` (ordine/operazione, quantità, unità, date).
- Uso di `CancelProdnOrdConf` (storno) → eventuale FM `ZMARS_PROD_ORDER_CONF_CANC`.
- Gestione **COMMIT WORK** e ritorno delle chiavi conferma.

---

## Note tecniche RFC

- Le FM di **lettura** (`_GET`) sono **RFC-enabled** e in sola lettura; le FM di **scrittura/azione**
  (`_POST`, `ZMARS_PROD_ORDER_CLOSE`/`_TECO`) eseguono registrazioni/aggiornamenti e richiedono
  **COMMIT WORK** lato SAP.
- IMPORT (`Typing = TYPE`): `IV_` per chiavi/filtri puntuali **scalari** (su data element);
  `SO_` per filtri su campo tramite **select-options / range**, tipizzati sul table type
  **`TT_RSDSSELOPT`** (righe `RSDSSELOPT`: `SIGN`/`OPTION`/`LOW`/`HIGH`).
- I data element indicati sono quelli standard SAP dove noti; i campi chiave "interni"
  (routing e ordine: op. interno / versioni / `AUFPL` / `APLZL`) sono **da confermare** con il
  dizionario del sistema.
- Le strutture di riga e i **table type** `ZMARS_*_T_*` vanno generati dai rispettivi entity
  type EDMX (allineare tipi/lunghezze a `Type`/`MaxLength`/`Precision`/`Scale` dei metadati).

# `A_Product` — indirizzo query su Integration Suite

**Function module** `ZMARS_PRODUCT_QUERYGET` · **EDMX** `ZMARS_PRODUCT_SRV.edmx` (allegato)

> **Stato: IN ESERCIZIO dal 01/09/2026.** Non è più una richiesta: l'indirizzo è pubblicato
> (riga 34 di `EndpointFlussiMARS_V1`) e l'applicazione lo usa. Path
> `/gw/odata/SAP/F0491.87_OPERATIONS_SAPECC_SAPBTPMARS_PRODUCT_QUERYGET;v=1`, configurato in
> `package.json > cds.requires.ZMARS_PRODUCT_SRV.isSource.paths`. Da qui passano la lista materiali
> della dashboard e il job `MAT_SYNC`; le letture emesse sono quelle del §4, più `$orderby=Product`
> (`IV_ORDER_BY`), che serve a rendere stabile la paginazione. La lettura per chiave `A_Product` e
> quella di `A_ProductDescription` restano in uso per l'esclusione componenti degli ordini.
> Feature [0040](../../docs/0040-anagrafica-materiali-per-plant.md), [DEC-110](../../docs/DECISIONI.md).

## 1. Entity

`A_Product`, chiave `Product`, sola lettura. Nessuna navigazione, nessun `$expand`.

## 2. Campi da mappare

Tutti e 71.

| Proprietà OData | Tipo | Componente |
|---|---|---|
| `Product` | `Edm.String(40)` | `PRODUCT` |
| `ProductType` | `Edm.String(4)` | `PRODUCT_TYPE` |
| `CrossPlantStatus` | `Edm.String(2)` | `CROSS_PLANT_STATUS` |
| `CrossPlantStatusValidityDate` | `Edm.DateTime` | `CROSS_PLANT_STATUS_VLDTY_DATE` |
| `CreationDate` | `Edm.DateTime` | `CREATION_DATE` |
| `CreatedByUser` | `Edm.String(12)` | `CREATED_BY_USER` |
| `LastChangeDate` | `Edm.DateTime` | `LAST_CHANGE_DATE` |
| `LastChangedByUser` | `Edm.String(12)` | `LAST_CHANGED_BY_USER` |
| `LastChangeDateTime` | `Edm.DateTimeOffset` | `LAST_CHANGE_DATE_TIME` |
| `IsMarkedForDeletion` | `Edm.Boolean` | `IS_MARKED_FOR_DELETION` |
| `ProductOldID` | `Edm.String(40)` | `PRODUCT_OLD_ID` |
| `GrossWeight` | `Edm.Decimal(13,3)` | `GROSS_WEIGHT` |
| `PurchaseOrderQuantityUnit` | `Edm.String(3)` | `PURCHASE_ORDER_QUANTITY_UNIT` |
| `SourceOfSupply` | `Edm.String(1)` | `SOURCE_OF_SUPPLY` |
| `WeightUnit` | `Edm.String(3)` | `WEIGHT_UNIT` |
| `NetWeight` | `Edm.Decimal(13,3)` | `NET_WEIGHT` |
| `CountryOfOrigin` | `Edm.String(3)` | `COUNTRY_OF_ORIGIN` |
| `CompetitorID` | `Edm.String(10)` | `COMPETITOR_ID` |
| `ProductGroup` | `Edm.String(9)` | `PRODUCT_GROUP` |
| `BaseUnit` | `Edm.String(3)` | `BASE_UNIT` |
| `ItemCategoryGroup` | `Edm.String(4)` | `ITEM_CATEGORY_GROUP` |
| `ProductHierarchy` | `Edm.String(18)` | `PRODUCT_HIERARCHY` |
| `Division` | `Edm.String(2)` | `DIVISION` |
| `VarblPurOrdUnitIsActive` | `Edm.String(1)` | `VARBL_PUR_ORD_UNIT_IS_ACTIVE` |
| `VolumeUnit` | `Edm.String(3)` | `VOLUME_UNIT` |
| `MaterialVolume` | `Edm.Decimal(13,3)` | `MATERIAL_VOLUME` |
| `ANPCode` | `Edm.String(9)` | `ANP_CODE` |
| `Brand` | `Edm.String(4)` | `BRAND` |
| `ProcurementRule` | `Edm.String(1)` | `PROCUREMENT_RULE` |
| `ValidityStartDate` | `Edm.DateTime` | `VALIDITY_START_DATE` |
| `LowLevelCode` | `Edm.String(3)` | `LOW_LEVEL_CODE` |
| `ProdNoInGenProdInPrepackProd` | `Edm.String(40)` | `PROD_NO_GEN_PROD_PREPACK` |
| `SerialIdentifierAssgmtProfile` | `Edm.String(4)` | `SERIAL_IDENT_ASSGMT_PROFILE` |
| `SizeOrDimensionText` | `Edm.String(32)` | `SIZE_OR_DIMENSION_TEXT` |
| `IndustryStandardName` | `Edm.String(18)` | `INDUSTRY_STANDARD_NAME` |
| `ProductStandardID` | `Edm.String(18)` | `PRODUCT_STANDARD_ID` |
| `InternationalArticleNumberCat` | `Edm.String(2)` | `INTL_ARTICLE_NUMBER_CAT` |
| `ProductIsConfigurable` | `Edm.Boolean` | `PRODUCT_IS_CONFIGURABLE` |
| `IsBatchManagementRequired` | `Edm.Boolean` | `IS_BATCH_MANAGEMENT_REQUIRED` |
| `ExternalProductGroup` | `Edm.String(18)` | `EXTERNAL_PRODUCT_GROUP` |
| `CrossPlantConfigurableProduct` | `Edm.String(40)` | `CROSS_PLANT_CONFIG_PRODUCT` |
| `SerialNoExplicitnessLevel` | `Edm.String(1)` | `SERIAL_NO_EXPLICITNESS_LEVEL` |
| `ProductManufacturerNumber` | `Edm.String(40)` | `PRODUCT_MANUFACTURER_NUMBER` |
| `ManufacturerNumber` | `Edm.String(10)` | `MANUFACTURER_NUMBER` |
| `ManufacturerPartProfile` | `Edm.String(4)` | `MANUFACTURER_PART_PROFILE` |
| `QltyMgmtInProcmtIsActive` | `Edm.Boolean` | `QLTY_MGMT_IN_PROCMT_IS_ACTIVE` |
| `IndustrySector` | `Edm.String(1)` | `INDUSTRY_SECTOR` |
| `ChangeNumber` | `Edm.String(12)` | `CHANGE_NUMBER` |
| `MaterialRevisionLevel` | `Edm.String(2)` | `MATERIAL_REVISION_LEVEL` |
| `HandlingIndicator` | `Edm.String(4)` | `HANDLING_INDICATOR` |
| `WarehouseProductGroup` | `Edm.String(4)` | `WAREHOUSE_PRODUCT_GROUP` |
| `WarehouseStorageCondition` | `Edm.String(2)` | `WAREHOUSE_STORAGE_CONDITION` |
| `StandardHandlingUnitType` | `Edm.String(4)` | `STANDARD_HANDLING_UNIT_TYPE` |
| `SerialNumberProfile` | `Edm.String(4)` | `SERIAL_NUMBER_PROFILE` |
| `AdjustmentProfile` | `Edm.String(3)` | `ADJUSTMENT_PROFILE` |
| `PreferredUnitOfMeasure` | `Edm.String(3)` | `PREFERRED_UNIT_OF_MEASURE` |
| `IsPilferable` | `Edm.Boolean` | `IS_PILFERABLE` |
| `IsRelevantForHzdsSubstances` | `Edm.Boolean` | `IS_RELEVANT_FOR_HZDS_SUBST` |
| `QuarantinePeriod` | `Edm.Decimal(3,0)` | `QUARANTINE_PERIOD` |
| `TimeUnitForQuarantinePeriod` | `Edm.String(3)` | `TIME_UNIT_QUARANTINE_PERIOD` |
| `QualityInspectionGroup` | `Edm.String(4)` | `QUALITY_INSPECTION_GROUP` |
| `AuthorizationGroup` | `Edm.String(4)` | `AUTHORIZATION_GROUP` |
| `DocumentIsCreatedByCAD` | `Edm.Boolean` | `DOCUMENT_IS_CREATED_BY_CAD` |
| `HandlingUnitType` | `Edm.String(4)` | `HANDLING_UNIT_TYPE` |
| `HasVariableTareWeight` | `Edm.Boolean` | `HAS_VARIABLE_TARE_WEIGHT` |
| `MaximumPackagingLength` | `Edm.Decimal(15,3)` | `MAXIMUM_PACKAGING_LENGTH` |
| `MaximumPackagingWidth` | `Edm.Decimal(15,3)` | `MAXIMUM_PACKAGING_WIDTH` |
| `MaximumPackagingHeight` | `Edm.Decimal(15,3)` | `MAXIMUM_PACKAGING_HEIGHT` |
| `UnitForMaxPackagingDimensions` | `Edm.String(3)` | `UNIT_MAX_PACKAGING_DIMENSIONS` |
| `Plant` | `Edm.String(4)` | `PLANT` |
| `ProductDescription` | `Edm.String(40)` | `PRODUCT_DESCRIPTION` |

## 3. Parametri della funzione

```
IMPORTING
  SO_PLANT              TYPE TT_RSDSSELOPT             OPTIONAL
  IV_LAST_CHANGE_DATE   TYPE DATS                      OPTIONAL
  IV_ORDER_BY           TYPE ZMARS_ROUTING_T_ORDER_BY  OPTIONAL
  IV_TOP                TYPE INT4                      OPTIONAL
  IV_SKIP               TYPE INT4                      OPTIONAL
EXPORTING
  ET_PRODUCT            TYPE ZMARS_T_PRODUCT_QUERY
```

| Opzione OData | Parametro | Nota |
|---|---|---|
| `$filter` su `Plant` | `SO_PLANT` | una riga con `SIGN='I'`, `OPTION='EQ'`, `LOW=<valore>` |
| `$filter` su `LastChangeDate` | `IV_LAST_CHANGE_DATE` | `DATS`, confronto `>=` |
| `$top` | `IV_TOP` | |
| `$skip` | `IV_SKIP` | |
| `$orderby` | `IV_ORDER_BY` | |
| `$select` | — | proiezione dei campi restituiti |

## 4. Richieste emesse dall'applicazione

Perimetro di uno stabilimento, senza paginazione:

```
A_Product?$select=Product,ProductDescription,ProductType,ProductGroup,BaseUnit,CrossPlantStatus,Division,ProductHierarchy,IsMarkedForDeletion,GrossWeight,NetWeight,WeightUnit,CreationDate,LastChangeDate&$filter=Plant%20eq%20'1710'
```

Perimetro paginato — prima pagina, poi le successive:

```
A_Product?$select=Product,ProductDescription,ProductType,ProductGroup,BaseUnit,CrossPlantStatus,Division,ProductHierarchy,IsMarkedForDeletion,GrossWeight,NetWeight,WeightUnit,CreationDate,LastChangeDate&$filter=Plant%20eq%20'1710'&$top=1000

A_Product?$select=Product,ProductDescription,ProductType,ProductGroup,BaseUnit,CrossPlantStatus,Division,ProductHierarchy,IsMarkedForDeletion,GrossWeight,NetWeight,WeightUnit,CreationDate,LastChangeDate&$filter=Plant%20eq%20'1710'&$top=1000&$skip=1000
```

Con il filtro sulla data di ultima modifica:

```
A_Product?$select=Product,ProductDescription,ProductType,ProductGroup,BaseUnit,CrossPlantStatus,Division,ProductHierarchy,IsMarkedForDeletion,GrossWeight,NetWeight,WeightUnit,CreationDate,LastChangeDate&$filter=Plant%20eq%20'1710'%20and%20LastChangeDate%20ge%20datetime'2026-08-01T00%3A00%3A00'
```

- Sulla prima pagina `$skip` non viene emesso: arriva `$top=1000` da solo.
- Un solo stabilimento per chiamata.

## 5. Risposta

Involucro `{"d":{"results":[ … ]}}`. Per i formati dei valori valgono le convenzioni concordate
(§4 di `Endpoint_OData_Integration`).

@cds.external : true
@m.IsDefaultEntityContainer : 'true'
@sap.message.scope.supported : 'true'
@sap.supported.formats : 'atom json xlsx'
service OP_API_CLFN_PRODUCT_SRV {
  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Procurement Data'
  entity A_ProductPlantProcurement {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product'
    @sap.quickinfo : 'Product Number'
    key Product : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    key Plant : String(4) not null;
    @sap.label : 'Automatic PO'
    @sap.quickinfo : 'Indicator: &quot;automatic purchase order allowed&quot;'
    IsAutoPurOrdCreationAllowed : Boolean;
    @sap.label : 'Source list'
    @sap.quickinfo : 'Indicator: Source list requirement'
    IsSourceListRequired : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Source of supply'
    @sap.quickinfo : 'Source of Supply'
    SourceOfSupplyCategory : String(1);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Storage Location Data'
  entity A_ProductStorageLocation {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material'
    @sap.quickinfo : 'Material Number'
    key Product : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    key Plant : String(4) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Storage Location'
    key StorageLocation : String(4) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Storage Bin'
    WarehouseStorageBin : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Maintenance Status'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    MaintenanceStatus : String(15);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Phys. Inv. Block'
    @sap.quickinfo : 'Physical Inventory Blocking Indicator'
    PhysicalInventoryBlockInd : String(1);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.label : 'DF stor. loc. level'
    @sap.quickinfo : 'Flag Material for Deletion at Storage Location Level'
    IsMarkedForDeletion : Boolean;
    @sap.display.format : 'Date'
    @sap.label : 'Date of Last Count'
    @sap.quickinfo : 'Date of Last Posted Count'
    DateOfLastPostedCntUnRstrcdStk : Date;
    @sap.label : 'Invent. corr. factor'
    @sap.quickinfo : 'Inventory Correction Factor'
    InventoryCorrectionFactor : Double;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Restricted-use stock'
    @sap.quickinfo : 'Physical inventory indicator for restricted-use stock'
    InvtryRestrictedUseStockInd : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Warehouse stock CY'
    @sap.quickinfo : 'Physical inventory indicator for whse stock in current year'
    InvtryCurrentYearStockInd : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Qual. insp. stock CY'
    @sap.quickinfo : 'Phys. inventory ind. f. stock in qual. insp. in current year'
    InvtryQualInspCurrentYrStkInd : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Blocked stock'
    @sap.quickinfo : 'Physical inventory indicator for blocked stock'
    InventoryBlockStockInd : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Restricted use, PP'
    @sap.quickinfo : 'Physical inventory ind. for restricted-use stock, prev.pd'
    InvtryRestStockPrevPeriodInd : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Warehouse stock PY'
    @sap.quickinfo : 'Physical inventory indicator for stock in previous year'
    InventoryStockPrevPeriod : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'QualInspStock prv.pd'
    @sap.quickinfo : 'Phys. inventory ind. f. stock in qual. insp. in prev. period'
    InvtryStockQltyInspPrevPeriod : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Blcked stock prev.pd'
    @sap.quickinfo : 'Phys. inventory indicator for blocked stock in prev. period'
    HasInvtryBlockStockPrevPeriod : String(3);
    @sap.display.format : 'NonNegative'
    FiscalYearCurrentPeriod : String(4);
    @sap.display.format : 'NonNegative'
    FiscalMonthCurrentPeriod : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Fiscal year of current physical inventory indicator'
    @sap.heading : ''
    FiscalYearCurrentInvtryPeriod : String(4);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Supply Planning Data'
  entity A_ProductSupplyPlanning {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product'
    @sap.quickinfo : 'Product Number'
    key Product : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    key Plant : String(4) not null;
    @sap.unit : 'BaseUnit'
    @sap.label : 'Fixed lot size'
    FixedLotSizeQuantity : Decimal(13, 3);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Maximum Lot Size'
    MaximumLotSizeQuantity : Decimal(13, 3);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Minimum Lot Size'
    MinimumLotSizeQuantity : Decimal(13, 3);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Rounding value'
    @sap.quickinfo : 'Rounding value for purchase order quantity'
    LotSizeRoundingQuantity : Decimal(13, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Lot Sizing Procedure'
    @sap.quickinfo : 'Lot Sizing Procedure in Materials Planning'
    LotSizingProcedure : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'MRP Type'
    MRPType : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'MRP Controller'
    MRPResponsible : String(3);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Safety Stock'
    SafetyStockQuantity : Decimal(13, 3);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Min. Saf. Stock'
    @sap.quickinfo : 'Minimum Safety Stock'
    MinimumSafetyStockQuantity : Decimal(13, 3);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Planning time fence'
    PlanningTimeFence : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'ABC Indicator'
    ABCIndicator : String(1);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Maximum Stock Level'
    MaximumStockQuantity : Decimal(13, 3);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Reorder Point'
    ReorderThresholdQuantity : Decimal(13, 3);
    @sap.label : 'Planned Deliv. Time'
    @sap.quickinfo : 'Planned Delivery Time in Days'
    PlannedDeliveryDurationInDays : Decimal(3, 0);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Safety Time'
    @sap.quickinfo : 'Safety Time (in Workdays)'
    SafetyDuration : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Strategy Group'
    @sap.quickinfo : 'Planning Strategy Group'
    PlanningStrategyGroup : String(2);
    @sap.label : 'Tot. repl. lead time'
    @sap.quickinfo : 'Total replenishment lead time (in workdays)'
    TotalReplenishmentLeadTime : Decimal(3, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Procurement Type'
    ProcurementType : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Special Procurement'
    @sap.quickinfo : 'Special Procurement Type'
    ProcurementSubType : String(2);
    @sap.label : 'Assembly scrap (%)'
    @sap.quickinfo : 'Assembly scrap in percent'
    AssemblyScrapPercent : Decimal(5, 2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Availability check'
    @sap.quickinfo : 'Checking Group for Availability Check'
    AvailabilityCheckType : String(2);
    @sap.label : 'GR processing time'
    @sap.quickinfo : 'Goods receipt processing time in days'
    GoodsReceiptDuration : Decimal(3, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'MRP Group'
    MRPGroup : String(4);
    @sap.label : 'Base Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    BaseUnit : String(3);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Product'
  entity A_ClfnProduct {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product'
    @sap.quickinfo : 'Product Number'
    key Product : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Type'
    ProductType : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'CrossPlantProdStatus'
    @sap.quickinfo : 'Cross-Plant Product Status'
    CrossPlantStatus : String(2);
    @sap.display.format : 'Date'
    @sap.label : 'Valid from'
    @sap.quickinfo : 'Date from which the cross-plant material status is valid'
    CrossPlantStatusValidityDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Name of Person Responsible for Creating the Object'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Last Change'
    @sap.quickinfo : 'Date of Last Change'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Name of Person Who Changed Object'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @sap.label : 'Marked for Deletion'
    @sap.quickinfo : 'Deletion Indicator'
    IsMarkedForDeletion : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Old Product Number'
    ProductOldID : String(40);
    @sap.unit : 'WeightUnit'
    @sap.label : 'Gross Weight'
    GrossWeight : Decimal(13, 3);
    @sap.label : 'Order Unit'
    @sap.quickinfo : 'Purchase Order Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    PurchaseOrderQuantityUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Source of supply'
    @sap.quickinfo : 'Source of Supply'
    SourceOfSupply : String(1);
    @sap.label : 'Unit of Weight'
    @sap.semantics : 'unit-of-measure'
    WeightUnit : String(3);
    @sap.unit : 'WeightUnit'
    @sap.label : 'Net Weight'
    NetWeight : Decimal(13, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cntry/Reg of Origin'
    @sap.quickinfo : 'Country/Region of Origin of Material (Non-Preferential Ori.)'
    CountryOfOrigin : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Competitor'
    CompetitorID : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Group'
    ProductGroup : String(9);
    @sap.label : 'Base Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    BaseUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Gen. item cat. grp'
    @sap.quickinfo : 'General item category group'
    ItemCategoryGroup : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Hierarchy'
    ProductHierarchy : String(18);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Division'
    Division : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Var. Order Unit'
    @sap.quickinfo : 'Variable Purchase Order Unit Active'
    VarblPurOrdUnitIsActive : String(1);
    @sap.label : 'Volume Unit'
    @sap.semantics : 'unit-of-measure'
    VolumeUnit : String(3);
    @sap.unit : 'VolumeUnit'
    @sap.label : 'Volume'
    MaterialVolume : Decimal(13, 3);
    @sap.display.format : 'NonNegative'
    @sap.label : 'ANP Code'
    ANPCode : String(9);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Brand'
    Brand : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Procurement rule'
    ProcurementRule : String(1);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Low-Level Code'
    LowLevelCode : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Generic Material'
    @sap.quickinfo : 'Material Number of the Generic Material in Prepack Materials'
    ProdNoInGenProdInPrepackProd : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Serial No. Profile'
    @sap.quickinfo : 'Serial Number Profile'
    SerialIdentifierAssgmtProfile : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Size/dimensions'
    SizeOrDimensionText : String(32);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Industry Std Desc.'
    @sap.quickinfo : 'Industry Standard Description (such as ANSI or ISO)'
    IndustryStandardName : String(18);
    @sap.display.format : 'UpperCase'
    @sap.label : 'GTIN'
    @sap.quickinfo : 'Global Trade Item Number (EAN/UPC/GTIN)'
    ProductStandardID : String(18);
    @sap.display.format : 'UpperCase'
    @sap.label : 'EAN category'
    @sap.quickinfo : 'Category of International Article Number (EAN)'
    InternationalArticleNumberCat : String(2);
    @sap.label : 'Configurable'
    @sap.quickinfo : 'Product is Configurable'
    ProductIsConfigurable : Boolean;
    @sap.label : 'Batch Management'
    @sap.quickinfo : 'Batch Management Requirement Indicator'
    IsBatchManagementRequired : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Ext. Product Group'
    @sap.quickinfo : 'External Product Group'
    ExternalProductGroup : String(18);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cross-plant CP'
    @sap.quickinfo : 'Cross-Plant Configurable Product'
    CrossPlantConfigurableProduct : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Serialization level'
    @sap.quickinfo : 'Level of Explicitness for Serial Number'
    SerialNoExplicitnessLevel : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Mfr Part Number'
    @sap.quickinfo : 'Manufacturer Part Number'
    ProductManufacturerNumber : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Mfr Part Profile'
    ManufacturerPartProfile : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Revision Level'
    MaterialRevisionLevel : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Handling Indicator'
    HandlingIndicator : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'WH Material Group'
    @sap.quickinfo : 'Warehouse Material Group'
    WarehouseProductGroup : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Whse Stor. Condition'
    @sap.quickinfo : 'Warehouse Storage Condition'
    WarehouseStorageCondition : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Standard HU Type'
    StandardHandlingUnitType : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Serial No. Profile'
    @sap.quickinfo : 'Serial Number Profile'
    SerialNumberProfile : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Adjust. Profile'
    @sap.quickinfo : 'Adjustment Profile'
    AdjustmentProfile : String(3);
    @sap.label : 'Preferred UoM'
    @sap.quickinfo : 'Preferred Alternative UoM for Warehouse Operations'
    @sap.semantics : 'unit-of-measure'
    PreferredUnitOfMeasure : String(3);
    @sap.label : 'Pilferable'
    IsPilferable : Boolean;
    @sap.label : 'Relevant for HS'
    @sap.quickinfo : 'Relevant for Hazardous Substances'
    IsRelevantForHzdsSubstances : Boolean;
    @sap.label : 'Quarant. Per.'
    @sap.quickinfo : 'Quarantine Period'
    QuarantinePeriod : Decimal(3, 0);
    @sap.label : 'Time Unit'
    @sap.quickinfo : 'Time Unit for Quarantine Period'
    @sap.semantics : 'unit-of-measure'
    TimeUnitForQuarantinePeriod : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Quality Inspec. Grp'
    @sap.quickinfo : 'Quality Inspection Group'
    QualityInspectionGroup : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Authorization Group'
    AuthorizationGroup : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Handling Unit Type'
    HandlingUnitType : String(4);
    @sap.label : 'Varb. Tare Weight'
    @sap.quickinfo : 'Variable Tare Weight'
    HasVariableTareWeight : Boolean;
    @sap.unit : 'UnitForMaxPackagingDimensions'
    @sap.label : 'Max. Pack. Length'
    @sap.quickinfo : 'Maximum Packing Length of Packaging Material'
    MaximumPackagingLength : Decimal(15, 3);
    @sap.unit : 'UnitForMaxPackagingDimensions'
    @sap.label : 'Max. Pack. Width'
    @sap.quickinfo : 'Maximum Packing Width of Packaging Material'
    MaximumPackagingWidth : Decimal(15, 3);
    @sap.unit : 'UnitForMaxPackagingDimensions'
    @sap.label : 'Max. Pack. Height'
    @sap.quickinfo : 'Maximum Packing Height of Packaging Material'
    MaximumPackagingHeight : Decimal(15, 3);
    @sap.label : 'Unit of Measurement'
    @sap.quickinfo : 'Unit of Measure for Maximum Packing Length/Width/Height'
    @sap.semantics : 'unit-of-measure'
    UnitForMaxPackagingDimensions : String(3);
    to_Description : Association to many A_ProductDescription {  };
    to_Plant : Association to many A_ProductPlant {  };
    to_ProductCharc : Association to many A_ProductCharc {  };
    to_ProductClass : Association to many A_ProductClass {  };
    to_ProductSalesTax : Association to many A_ProductSalesTax {  };
    to_SalesDelivery : Association to many A_ProductSalesDelivery {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Class Header Data'
  entity A_ClfnClassForKeyDate {
    @sap.display.format : 'NonNegative'
    @sap.label : 'Int. Class No.'
    @sap.quickinfo : 'Internal Class Number'
    key ClassInternalID : String(10) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class Type'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ClassType : String(3);
    @sap.label : 'Description'
    @sap.quickinfo : 'Text describing class type'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ClassTypeName : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class'
    @sap.quickinfo : 'Class number'
    Class : String(18);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Status'
    @sap.quickinfo : 'Class status'
    ClassStatus : String(1);
    @sap.label : 'Text'
    @sap.quickinfo : 'Text for a table entry'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ClassStatusName : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class group'
    @sap.quickinfo : 'Class Group'
    ClassGroup : String(10);
    @sap.label : 'Class Group'
    @sap.quickinfo : 'Class Group Description'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ClassGroupName : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Find Objects'
    @sap.quickinfo : 'Authorization Group for Finding Objects'
    ClassSearchAuthGrp : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Classification'
    @sap.quickinfo : 'Classification Authorization Group'
    ClassClassfctnAuthGrp : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class Maintenance'
    @sap.quickinfo : 'Class Authorization Group'
    ClassMaintAuthGrp : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document'
    @sap.quickinfo : 'Document number'
    DocNumber : String(25);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Type'
    DocumentType : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Part'
    DocumentPart : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Version'
    DocumentVersion : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Single-Character Flag'
    @sap.heading : ''
    SameClassfctnReaction : String(1);
    @sap.label : 'Standard'
    @sap.quickinfo : 'Name of standards organization'
    ClassStandardOrgName : String(10);
    @sap.label : 'Standard number'
    @sap.quickinfo : 'Standard Number'
    ClassStandardNumber : String(20);
    @sap.display.format : 'Date'
    @sap.label : 'Issue date'
    ClassStandardStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Version date'
    ClassStandardVersionStartDate : Date;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Version Number'
    ClassStandardVersion : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Chars table'
    @sap.quickinfo : 'Characteristics table'
    ClassStandardCharcTable : String(20);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.label : 'Local class'
    ClassIsLocal : Boolean;
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    @sap.quickinfo : 'Valid-to date'
    ValidityEndDate : Date;
    @odata.Type : 'Edm.DateTimeOffset'
    @odata.Precision : 7
    @sap.label : 'Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ClassLastChangedDateTime : Timestamp;
    @sap.display.format : 'Date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    KeyDate : Date;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Product Description'
  entity A_ProductDescription {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product'
    @sap.quickinfo : 'Product Number'
    key Product : String(40) not null;
    @sap.label : 'Language Key'
    key Language : String(2) not null;
    @sap.label : 'Product Description'
    ProductDescription : String(40);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Plant Data'
  entity A_ProductPlant {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material'
    @sap.quickinfo : 'Material Number'
    key Product : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    key Plant : String(4) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purchasing Group'
    PurchasingGroup : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cntry/Reg of Origin'
    @sap.quickinfo : 'Country/Region of Origin of Material (Non-Preferential Ori.)'
    CountryOfOrigin : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Region of Origin'
    @sap.quickinfo : 'Region of Origin of Material (Non-Preferential Origin)'
    RegionOfOrigin : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Prod. Stor. Loc.'
    @sap.quickinfo : 'Storage Location'
    ProductionInvtryManagedLoc : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'P-S Mat. Status'
    @sap.quickinfo : 'Plant-Specific Material Status'
    ProfileCode : String(2);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Date from Which the Plant-Specific Material Status Is Valid'
    ProfileValidityStartDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Availability check'
    @sap.quickinfo : 'Checking Group for Availability Check'
    AvailabilityCheckType : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Fiscal Year Variant'
    FiscalYearVariant : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Period Indicator'
    PeriodType : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Profit Center'
    ProfitCenter : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Commodity Code'
    Commodity : String(17);
    @sap.label : 'GR processing time'
    @sap.quickinfo : 'Goods receipt processing time in days'
    GoodsReceiptDuration : Decimal(3, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Maintenance Status'
    MaintenanceStatusName : String(15);
    @sap.label : 'DF at plant level'
    @sap.quickinfo : 'Flag Material for Deletion at Plant Level'
    IsMarkedForDeletion : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'MRP Type'
    MRPType : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'MRP Controller'
    MRPResponsible : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'ABC Indicator'
    ABCIndicator : String(1);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Minimum Lot Size'
    MinimumLotSizeQuantity : Decimal(13, 3);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Maximum Lot Size'
    MaximumLotSizeQuantity : Decimal(13, 3);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Fixed lot size'
    FixedLotSizeQuantity : Decimal(13, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Control Code'
    @sap.quickinfo : 'Control code for consumption taxes in foreign trade'
    ConsumptionTaxCtrlCode : String(16);
    @sap.label : 'Co-Product'
    IsCoProduct : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'ConfigurableProduct'
    @sap.quickinfo : 'Configurable Product'
    ProductIsConfigurable : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Stock Determ. Group'
    @sap.quickinfo : 'Stock determination group'
    StockDeterminationGroup : String(4);
    @sap.unit : 'BaseUnit'
    StockInTransferQuantity : Decimal(13, 3);
    @sap.unit : 'BaseUnit'
    StockInTransitQuantity : Decimal(13, 3);
    @sap.label : 'Post to insp. stock'
    @sap.quickinfo : 'Has Post to Inspection Stock'
    HasPostToInspectionStock : Boolean;
    @sap.label : 'Batch Mgmt Rqt(Plnt)'
    @sap.quickinfo : 'Batch Management Requirement Indicator for Plant'
    IsBatchManagementRequired : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Serial No. Profile'
    @sap.quickinfo : 'Serial Number Profile'
    SerialNumberProfile : String(4);
    @sap.label : 'Neg. Stocks In Plant'
    @sap.quickinfo : 'Negative stocks allowed in plant'
    IsNegativeStockAllowed : Boolean;
    @sap.unit : 'BaseUnit'
    GoodsReceiptBlockedStockQty : Decimal(13, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Consign.Control'
    @sap.quickinfo : 'Consignment Control'
    HasConsignmentCtrl : String(1);
    @sap.display.format : 'NonNegative'
    FiscalYearCurrentPeriod : String(4);
    @sap.display.format : 'NonNegative'
    FiscalMonthCurrentPeriod : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Procurement Type'
    ProcurementType : String(1);
    @sap.label : 'Batch Management'
    @sap.quickinfo : 'Batch management indicator (internal)'
    IsInternalBatchManaged : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Matl. CFOP Category'
    @sap.quickinfo : 'Material CFOP Category'
    ProductCFOPCategory : String(2);
    @sap.label : 'Is Excise Tax Relevant'
    @sap.quickinfo : 'Excise Tax Relevance Indicator'
    ProductIsExciseTaxRelevant : Boolean;
    @sap.label : 'Base Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    BaseUnit : String(3);
    to_ProductPlantProcurement : Association to A_ProductPlantProcurement {  };
    to_ProductSupplyPlanning : Association to A_ProductSupplyPlanning {  };
    to_ProductWorkScheduling : Association to A_ProductWorkScheduling {  };
    to_StorageLocation : Association to many A_ProductStorageLocation {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Sales Organization Data'
  entity A_ProductSalesDelivery {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product'
    @sap.quickinfo : 'Product Number'
    key Product : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sales Organization'
    key ProductSalesOrg : String(4) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Distribution Channel'
    key ProductDistributionChnl : String(2) not null;
    @sap.unit : 'BaseUnit'
    @sap.label : 'Minimum order qty'
    @sap.quickinfo : 'Minimum order quantity in base unit of measure'
    MinimumOrderQuantity : Decimal(13, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Delivering Plant'
    @sap.quickinfo : 'Delivering Plant (Own or External)'
    SupplyingPlant : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Price Group'
    @sap.quickinfo : 'Product Pricing Group'
    PriceSpecificationProductGroup : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Acct Assmt Grp Mat.'
    @sap.quickinfo : 'Account Assignment Group for Material'
    AccountDetnProductGroup : String(2);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Minimum Delivery Qty'
    @sap.quickinfo : 'Minimum Delivery Quantity in Delivery Note Processing'
    DeliveryNoteProcMinDelivQty : Decimal(13, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Item Category Group'
    @sap.quickinfo : 'Item Category Group from Material Master'
    ItemCategoryGroup : String(4);
    @sap.label : 'Unit Of Measure'
    @sap.quickinfo : 'Unit Of Measure Of Delivery Unit'
    @sap.semantics : 'unit-of-measure'
    DeliveryQuantityUnit : String(3);
    @sap.unit : 'DeliveryQuantityUnit'
    @sap.label : 'Delivery unit'
    DeliveryQuantity : Decimal(13, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'DChain-spec. status'
    @sap.quickinfo : 'Distribution-chain-specific material status'
    ProductSalesStatus : String(2);
    @sap.display.format : 'Date'
    @sap.label : 'Valid from'
    @sap.quickinfo : 'Date from which distr.-chain-spec. material status is valid'
    ProductSalesStatusValidityDate : Date;
    @sap.label : 'Sales Unit'
    @sap.semantics : 'unit-of-measure'
    SalesMeasureUnit : String(3);
    @sap.label : 'DF distr. chain lvl'
    @sap.quickinfo : 'Ind.: Flag material for deletion at distribution chain level'
    IsMarkedForDeletion : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Hierarchy'
    ProductHierarchy : String(18);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Group 1'
    FirstSalesSpecProductGroup : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Group 2'
    SecondSalesSpecProductGroup : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Group 3'
    ThirdSalesSpecProductGroup : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Group 4'
    FourthSalesSpecProductGroup : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product Group 5'
    FifthSalesSpecProductGroup : String(3);
    @sap.unit : 'BaseUnit'
    @sap.label : 'Min. MtO quantity'
    @sap.quickinfo : 'Minimum make-to-order quantity'
    MinimumMakeToOrderOrderQty : Decimal(13, 3);
    @sap.label : 'Base Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    BaseUnit : String(3);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Sales Tax Data'
  entity A_ProductSalesTax {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product'
    @sap.quickinfo : 'Product Number'
    key Product : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Departure Ctry/Reg.'
    @sap.quickinfo : 'Departure Country/Region (from which the goods are sent)'
    key Country : String(3) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Tax Condition Type'
    @sap.quickinfo : 'Tax Condition Type (Sales Tax, Value-Added Tax,...)'
    key TaxCategory : String(4) not null;
    key TaxClassification : String(1) not null;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Work Scheduling Data'
  entity A_ProductWorkScheduling {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Product'
    @sap.quickinfo : 'Product Number'
    key Product : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    key Plant : String(4) not null;
    @sap.unit : 'BaseUnit'
    @sap.label : 'Base quantity'
    MaterialBaseQuantity : Decimal(13, 3);
    @sap.label : 'Unltd Overdelivery'
    @sap.quickinfo : 'Indicator: Unlimited Overdelivery Allowed'
    UnlimitedOverDelivIsAllowed : Boolean;
    @sap.label : 'Overdelivery Toler.'
    @sap.quickinfo : 'Overdelivery Tolerance Limit'
    OverDelivToleranceLimit : Decimal(3, 1);
    @sap.label : 'Underdelivery Toler.'
    @sap.quickinfo : 'Underdelivery Tolerance Limit'
    UnderDelivToleranceLimit : Decimal(3, 1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Prod. Stor. Loc.'
    @sap.quickinfo : 'Storage Location'
    ProductionInvtryManagedLoc : String(4);
    @sap.label : 'Base Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    BaseUnit : String(3);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Characteristics'
  entity A_ProductCharc {
    @sap.label : 'Object'
    @sap.quickinfo : 'Key of Object to be Classified'
    key Product : String(90) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Characteristic Internal ID'
    key CharcInternalID : String(10) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class Type'
    key ClassType : String(3) not null;
    @sap.display.format : 'Date'
    KeyDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    to_Valuation : Association to many A_ProductCharcValue {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Characteristic Valuations'
  entity A_ProductCharcValue {
    @sap.label : 'Object'
    @sap.quickinfo : 'Key of Object to be Classified'
    key Product : String(90) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class Type'
    key ClassType : String(3) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Characteristic Internal ID'
    key CharcInternalID : String(10) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Characteristic value counter'
    key CharcValuePositionNumber : String(3) not null;
    @sap.display.format : 'Date'
    KeyDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code'
    @sap.quickinfo : 'Code for value dependency'
    CharcValueDependency : String(1);
    @sap.label : 'Characteristic Value'
    CharcValue : String(70);
    @sap.label : 'Value from'
    @sap.quickinfo : 'Internal floating point from'
    CharcFromNumericValue : Double;
    @sap.label : 'Internal UoM'
    @sap.quickinfo : 'Unit of Measurement'
    @sap.semantics : 'unit-of-measure'
    CharcFromNumericValueUnit : String(3);
    @sap.label : 'Value to'
    @sap.quickinfo : 'Internal floating point value to'
    CharcToNumericValue : Double;
    @sap.label : 'Internal UoM'
    @sap.quickinfo : 'Unit of Measurement'
    @sap.semantics : 'unit-of-measure'
    CharcToNumericValueUnit : String(3);
    @sap.label : 'LowrBndry Nmrc'
    @sap.quickinfo : 'Lower Boundary for Numeric Field'
    CharcFromDecimalValue : Decimal(31, 14);
    @sap.label : 'UprBndry Nmrc'
    @sap.quickinfo : 'Upper Boundary for Numeric Field'
    CharcToDecimalValue : Decimal(31, 14);
    @sap.unit : 'Currency'
    @sap.label : 'LowrBndry Crcy'
    @sap.quickinfo : 'Lower Boundary for Currency Field'
    CharcFromAmount : Decimal(24, 3);
    @sap.unit : 'Currency'
    @sap.label : 'UprBndry Crcy'
    @sap.quickinfo : 'Upper Boundary for Currency Field'
    CharcToAmount : Decimal(24, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Currency'
    @sap.quickinfo : 'Currency Key'
    @sap.semantics : 'currency-code'
    Currency : String(5);
    @sap.display.format : 'Date'
    @sap.label : 'LowrBndry Date'
    @sap.quickinfo : 'Lower Boundary for Date-Interval'
    CharcFromDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'UprBndry Date'
    @sap.quickinfo : 'Upper Boundary for Date-Interval'
    CharcToDate : Date;
    @sap.label : 'LowrBndry Time'
    @sap.quickinfo : 'Lower Boundary for Time-Interval'
    CharcFromTime : Time;
    @sap.label : 'UprBndry Time'
    @sap.quickinfo : 'Upper Boundary for Time-Interval'
    CharcToTime : Time;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Author'
    @sap.quickinfo : 'Classification: Author'
    CharacteristicAuthor : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Authorization Group'
    @sap.quickinfo : 'Authorization Group for Characteristics Maintenance'
    CharcMaintAuthGrp : String(3);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Class Assignments'
  entity A_ProductClass {
    @sap.label : 'Object'
    @sap.quickinfo : 'Key of Object to be Classified'
    key Product : String(90) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Int. Class No.'
    @sap.quickinfo : 'Internal Class Number'
    key ClassInternalID : String(10) not null;
    @sap.display.format : 'Date'
    KeyDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class Type'
    ClassType : String(3);
    to_Characteristics : Association to many A_ProductClassCharc {  };
    to_ClassDetails : Association to A_ClfnClassForKeyDate {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '1'
  @sap.label : 'Class Characteristics'
  entity A_ProductClassCharc {
    @sap.label : 'Object'
    @sap.quickinfo : 'Key of Object to be Classified'
    key Product : String(90) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Int. Class No.'
    @sap.quickinfo : 'Internal Class Number'
    key ClassInternalID : String(10) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Characteristic Internal ID'
    key CharcInternalID : String(10) not null;
    @sap.display.format : 'Date'
    KeyDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class Type'
    ClassType : String(3);
    to_Valuation : Association to many A_ProductCharcValue {  };
  };
};


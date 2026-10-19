@cds.external : true
@m.IsDefaultEntityContainer : 'true'
@sap.message.scope.supported : 'true'
@sap.supported.formats : 'atom json xlsx'
service OP_API_BILL_OF_MATERIAL_SRV_0002 {
  @cds.external : true
  @cds.persistence.skip : true
  @sap.content.version : '2'
  @sap.deletable.path : 'Delete_mc'
  @sap.updatable.path : 'Update_mc'
  @sap.label : 'Item'
  entity MaterialBOMItem {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Bill of Material'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterial : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM category'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialCategory : String(1) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Alternative BOM'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialVariant : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM Version'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialVersion : String(4) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Item node'
    @sap.quickinfo : 'BOM item node number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialItemNodeNumber : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key HeaderChangeDocument : String(12) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material'
    @sap.quickinfo : 'Material Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key Material : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key Plant : String(4) not null;
    @sap.label : 'Dyn. Action Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    ConvertItem_ac : Boolean;
    @sap.label : 'Dyn. Action Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    DeleteBOMItemWithECN_ac : Boolean;
    @sap.label : 'Dyn. Action Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    UpdateBOMItemWithECN_ac : Boolean;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Delete_mc : Boolean;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Update_mc : Boolean;
    @sap.label : 'Dynamic CbA-Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    to_BOMItmObjDependencyAssignment_oc : Boolean;
    @sap.label : 'Dynamic CbA-Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    to_BOMSubItems_oc : Boolean;
    @sap.label : 'ID item chge status'
    @sap.quickinfo : 'Global identification of an item''s change status'
    BillOfMaterialItemUUID : UUID;
    @sap.label : 'ID hdr chge status'
    @sap.quickinfo : 'Global identification of a BOM header change status'
    BillOfMaterialHeaderUUID : UUID;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    BOMItemInternalChangeCount : String(8);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    @sap.quickinfo : 'Valid-to date'
    ValidityEndDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    EngineeringChangeDocForEdit : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    EngineeringChangeDocument : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number To'
    ChgToEngineeringChgDocument : String(12);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Item node'
    @sap.quickinfo : 'Inherited node number of BOM item'
    InheritedNodeNumberForBOMItem : String(8);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    BOMItemRecordCreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created by'
    @sap.quickinfo : 'User who created record'
    BOMItemCreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    BOMItemLastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Name of Person Who Changed Object'
    BOMItemLastChangedByUser : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Component'
    @sap.quickinfo : 'BOM component'
    BillOfMaterialComponent : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Item Category'
    @sap.quickinfo : 'Item category (bill of material)'
    BillOfMaterialItemCategory : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Item Number'
    @sap.quickinfo : 'BOM Item Number'
    BillOfMaterialItemNumber : String(4);
    @sap.label : 'Component UoM'
    @sap.quickinfo : 'Component Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    BillOfMaterialItemUnit : String(3);
    @sap.unit : 'BillOfMaterialItemUnit'
    @sap.label : 'Component Quantity'
    BillOfMaterialItemQuantity : Decimal(13, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Single-Character Flag'
    @sap.heading : ''
    IsAssembly : String(1);
    @sap.label : 'Sub-item indicator'
    @sap.quickinfo : 'Indicator: sub-items exist'
    IsSubItem : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sort String'
    BOMItemSorter : String(10);
    @sap.label : 'Fixed Quantity'
    FixedQuantity : Boolean;
    @sap.label : 'Fixed Quantity'
    BOMItemHasFixedQuantity : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purchasing Group'
    PurchasingGroup : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Currency'
    @sap.quickinfo : 'Currency Key'
    @sap.semantics : 'currency-code'
    Currency : String(5);
    @sap.unit : 'Currency'
    @sap.label : 'Price'
    MaterialComponentPrice : Decimal(12, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Item identification'
    @sap.quickinfo : 'External identification of an item'
    IdentifierBOMItem : String(8);
    @sap.unit : 'BillOfMaterialItemUnit'
    @sap.label : 'Price unit'
    MaterialPriceUnitQty : Decimal(5, 0);
    @sap.label : 'Component Scrap (%)'
    @sap.quickinfo : 'Component Scrap in Percent'
    ComponentScrapInPercent : Decimal(5, 2);
    @sap.label : 'Operation Scrap in %'
    @sap.quickinfo : 'Operation Scrap'
    OperationScrapInPercent : Decimal(5, 2);
    @sap.label : 'Net Scrap Indicator'
    IsNetScrap : Boolean;
    @sap.label : 'No. of VSI Required'
    @sap.quickinfo : 'Required Number of Variable-Size Items'
    NumberOfVariableSizeItem : Decimal(13, 3);
    @sap.unit : 'BillOfMaterialItemUnit'
    @sap.label : 'VSI Quantity per PC'
    @sap.quickinfo : 'Variable-Size Item Quantity per Piece (PC)'
    QuantityVariableSizeItem : Decimal(13, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'VSI Formula'
    @sap.quickinfo : 'Formula Key for Variable-Size Items'
    FormulaKey : String(2);
    @sap.label : 'Object description'
    @sap.quickinfo : 'Object description (item)'
    ComponentDescription : String(40);
    @sap.label : 'Item Text'
    @sap.quickinfo : 'BOM Item Text (Line 1)'
    BOMItemDescription : String(40);
    @sap.label : 'Item Text 2'
    @sap.quickinfo : 'BOM Item Text (Line 2)'
    BOMItemText2 : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material Group'
    MaterialGroup : String(9);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Type'
    DocumentType : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document'
    @sap.quickinfo : 'Document number'
    DocNumber : String(25);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Version'
    DocumentVersion : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Part'
    DocumentPart : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class'
    @sap.quickinfo : 'Class number'
    ClassNumber : String(18);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class Type'
    ClassType : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Res. item category'
    @sap.quickinfo : 'Resulting item category'
    ResultingItemCategory : String(1);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Assignment number'
    @sap.quickinfo : 'Number of Object with Assigned Dependencies'
    DependencyObjectNumber : String(18);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Object Type'
    @sap.quickinfo : 'Object type (BOM item)'
    ObjectType : String(1);
    @sap.label : 'as selection cond.'
    @sap.quickinfo : 'Indicator: classification as selection condition'
    IsClassificationRelevant : Boolean;
    @sap.label : 'Bulk material'
    @sap.quickinfo : 'Indicator: bulk material'
    IsBulkMaterial : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Spare Part Indicator'
    @sap.quickinfo : 'Indicator: Spare Part'
    BOMItemIsSparePart : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Relevant to sales'
    @sap.quickinfo : 'Indicator: item relevant to sales'
    BOMItemIsSalesRelevant : String(1);
    @sap.label : 'Production relevant'
    @sap.quickinfo : 'Indicator: item relevant to production'
    IsProductionRelevant : Boolean;
    @sap.label : 'Plant maintenance'
    @sap.quickinfo : 'Indicator: item relevant to plant maintenance'
    BOMItemIsPlantMaintRelevant : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Relevancy to costing'
    @sap.quickinfo : 'Indicator for relevancy to costing'
    BOMItemIsCostingRelevant : String(1);
    @sap.label : 'Engineering/design'
    @sap.quickinfo : 'Indicator: item relevant to engineering'
    IsEngineeringRelevant : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Special Procurement'
    @sap.quickinfo : 'Special Procurement Type for BOM Item'
    SpecialProcurementType : String(2);
    @sap.label : 'Recurs. allowed'
    @sap.quickinfo : 'Indicator: recursiveness allowed'
    IsBOMRecursiveAllowed : Boolean;
    @sap.label : 'Oper. LT offset'
    @sap.quickinfo : 'Lead-time offset for operation'
    OperationLeadTimeOffset : Decimal(3, 0);
    @sap.label : 'Operation LTO unit'
    @sap.quickinfo : 'Unit for lead-time offset for operation'
    @sap.semantics : 'unit-of-measure'
    OpsLeadTimeOffsetUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Mat. Provision Ind.'
    @sap.quickinfo : 'Material Provision Indicator'
    IsMaterialProvision : String(1);
    @sap.label : 'Recursive'
    @sap.quickinfo : 'Indicator: BOM is recursive'
    BOMIsRecursive : Boolean;
    @sap.label : 'CAD Indicator'
    DocumentIsCreatedByCAD : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Distribution key'
    @sap.quickinfo : 'Distribution key for component consumption'
    DistrKeyCompConsumption : String(4);
    @sap.label : 'Delivery time (days)'
    @sap.quickinfo : 'Delivery time in days'
    DeliveryDurationInDays : Decimal(3, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Supplier'
    @sap.quickinfo : 'Account Number of Supplier'
    Creditor : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost element'
    CostElement : String(10);
    @sap.unit : 'UnitOfMeasureForSize1To3'
    @sap.label : 'Size 1'
    Size1 : Decimal(13, 3);
    @sap.unit : 'UnitOfMeasureForSize1To3'
    @sap.label : 'Size 2'
    Size2 : Decimal(13, 3);
    @sap.unit : 'UnitOfMeasureForSize1To3'
    @sap.label : 'Size 3'
    Size3 : Decimal(13, 3);
    @sap.label : 'Size unit'
    @sap.quickinfo : 'Unit of measure for sizes 1 to 3'
    @sap.semantics : 'unit-of-measure'
    UnitOfMeasureForSize1To3 : String(3);
    @sap.label : 'GR processing time'
    @sap.quickinfo : 'Goods receipt processing time in days'
    GoodsReceiptDuration : Decimal(3, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purch. Organization'
    @sap.quickinfo : 'Purchasing Organization'
    PurchasingOrganization : String(4);
    @sap.label : 'Required Component'
    RequiredComponent : Boolean;
    @sap.label : 'Multiple Selection'
    @sap.quickinfo : 'Multiple Selection Allowed'
    MultipleSelectionAllowed : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Storage Location'
    @sap.quickinfo : 'Issue Location for Production Order'
    ProdOrderIssueLocation : String(4);
    @sap.label : 'Co-product'
    @sap.quickinfo : 'Indicator: co-product'
    MaterialIsCoProduct : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Explosion type'
    ExplosionType : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'AltItemGroup'
    @sap.quickinfo : 'Alternative item: group'
    AlternativeItemGroup : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Priority'
    @sap.quickinfo : 'Alternative item: ranking order'
    AlternativeItemPriority : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Strategy'
    @sap.quickinfo : 'Alternative item: strategy'
    AlternativeItemStrategy : String(1);
    @sap.label : 'Usage Probability'
    @sap.quickinfo : 'Usage Probability in % (Alternative Item)'
    UsageProbabilityPercent : Decimal(3, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Follow-up group'
    FollowUpGroup : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Discont. group'
    @sap.quickinfo : 'Discontinuation group'
    DiscontinuationGroup : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Selection indicator'
    @sap.quickinfo : 'Selection indicator for configurable BOMs'
    IsConfigurableBOM : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Reference point'
    @sap.quickinfo : 'Reference point for BOM transfer'
    ReferencePoint : String(20);
    @sap.label : 'Lead-time offset'
    LeadTimeOffset : Decimal(3, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Prodn Supply Area'
    @sap.quickinfo : 'Production Supply Area'
    ProductionSupplyArea : String(10);
    @sap.label : 'Deletion Indicator'
    IsDeleted : Boolean;
    @sap.label : 'ALE indicator'
    IsALE : Boolean;
    @odata.Type : 'Edm.DateTimeOffset'
    @odata.Precision : 7
    @sap.label : 'Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun)'
    LastChangeDateTime : Timestamp;
    @sap.label : 'Material Description'
    PreliminaryComponent : String(40);
    to_BOMItemCategory : Association to A_BOMItemCategory {  };
    to_BOMItmObjDependencyAssignment : Composition of many MBOMItmObjDpnAssignment {  };
    to_BOMSubItems : Composition of many MaterialBOMSubItem {  };
    to_BillOfMaterial : Association to MaterialBOM {  };
  } actions {
    action ConvertItem(
      @sap.label : 'Material'
      BillOfMaterialComponent : String(40),
      @sap.label : 'Item Category'
      BillOfMaterialItemCategory : String(1),
      @sap.label : 'Item Text'
      BOMItemDescription : String(40),
      @sap.label : 'Purchasing Group'
      PurchasingGroup : String(3),
      @sap.label : 'Material Group'
      MaterialGroup : String(9),
      @sap.label : 'Price unit'
      MaterialPriceUnitQty : Decimal(5, 0),
      @sap.label : 'Currency'
      Currency : String(5),
      @sap.label : 'Price'
      @sap.unit : 'Currency'
      MaterialComponentPrice : Decimal(12, 3)
    ) returns MaterialBOMItem;
    action DeleteBOMItemWithECN(
      @sap.label : 'Change Number'
      EngineeringChangeDocForEdit : String(12)
    ) returns DBomdelchangenooutparameter;
    action UpdateBOMItemWithECN(
      @sap.label : 'ID item chge status'
      BillOfMaterialItemUUID : UUID,
      @sap.label : 'Counter'
      BOMItemInternalChangeCount : String(8),
      @sap.label : 'Valid From'
      @sap.display.format : 'Date'
      ValidityStartDate : Date,
      @sap.label : 'Valid to'
      @sap.display.format : 'Date'
      ValidityEndDate : Date,
      @sap.label : 'Change Number'
      EngineeringChangeDocForEdit : String(12),
      @sap.label : 'Change Number'
      EngineeringChangeDocument : String(12),
      @sap.label : 'Change Number To'
      ChgToEngineeringChgDocument : String(12),
      @sap.label : 'Item node'
      InheritedNodeNumberForBOMItem : String(8),
      @sap.label : 'Created On'
      @sap.display.format : 'Date'
      BOMItemRecordCreationDate : Date,
      @sap.label : 'Created by'
      BOMItemCreatedByUser : String(12),
      @sap.label : 'Changed On'
      @sap.display.format : 'Date'
      BOMItemLastChangeDate : Date,
      @sap.label : 'Changed By'
      BOMItemLastChangedByUser : String(12),
      @sap.label : 'Component'
      BillOfMaterialComponent : String(40),
      @sap.label : 'Item Category'
      BillOfMaterialItemCategory : String(1),
      @sap.label : 'Item Number'
      BillOfMaterialItemNumber : String(4),
      @sap.label : 'Component UoM'
      BillOfMaterialItemUnit : String(3),
      @sap.label : 'Component Quantity'
      @sap.unit : 'BillOfMaterialItemUnit'
      BillOfMaterialItemQuantity : Decimal(13, 3),
      @sap.label : 'Single-Character Flag'
      IsAssembly : String(1),
      @sap.label : 'Sub-item indicator'
      IsSubItem : Boolean,
      @sap.label : 'Sort String'
      BOMItemSorter : String(10),
      @sap.label : 'Fixed Quantity'
      BOMItemHasFixedQuantity : Boolean,
      @sap.label : 'Purchasing Group'
      PurchasingGroup : String(3),
      @sap.label : 'Currency'
      Currency : String(5),
      @sap.label : 'Price'
      @sap.unit : 'Currency'
      MaterialComponentPrice : Decimal(12, 3),
      @sap.label : 'Item identification'
      IdentifierBOMItem : String(8),
      @sap.label : 'Price unit'
      MaterialPriceUnitQty : Decimal(5, 0),
      @sap.label : 'Component Scrap (%)'
      ComponentScrapInPercent : Decimal(5, 2),
      @sap.label : 'Operation Scrap in %'
      OperationScrapInPercent : Decimal(5, 2),
      @sap.label : 'Net Scrap Indicator'
      IsNetScrap : Boolean,
      @sap.label : 'No. of VSI Required'
      @sap.unit : 'VariableSizeCompUnitOfMeasure'
      VariableSizeItemQuantity : Decimal(13, 3),
      @sap.label : 'Var-size item unit'
      VariableSizeCompUnitOfMeasure : String(3),
      @sap.label : 'VSI Quantity per PC'
      @sap.unit : 'VariableSizeCompUnitOfMeasure'
      QuantityVariableSizeItem : Decimal(13, 3),
      @sap.label : 'VSI Formula'
      FormulaKey : String(2),
      @sap.label : 'Item Text'
      ComponentDescription : String(40),
      @sap.label : 'Item Text'
      BOMItemDescription : String(40),
      @sap.label : 'Item Text 2'
      BOMItemText2 : String(40),
      @sap.label : 'Material Group'
      MaterialGroup : String(9),
      @sap.label : 'Document Type'
      DocumentType : String(3),
      @sap.label : 'Document'
      DocNumber : String(25),
      @sap.label : 'Document Version'
      DocumentVersion : String(2),
      @sap.label : 'Document Part'
      DocumentPart : String(3),
      @sap.label : 'Class'
      ClassNumber : String(18),
      @sap.label : 'Class Type'
      ClassType : String(3),
      @sap.label : 'Res. item category'
      ResultingItemCategory : String(1),
      @sap.label : 'Assignment number'
      DependencyObjectNumber : String(18),
      @sap.label : 'Object Type'
      BillOfMaterialItemObjectType : String(1),
      @sap.label : 'as selection cond.'
      IsClassificationRelevant : Boolean,
      @sap.label : 'Bulk material'
      IsBulkMaterial : Boolean,
      @sap.label : 'Spare Part Indicator'
      BOMItemIsSparePart : String(1),
      @sap.label : 'Relevant to sales'
      BOMItemIsSalesRelevant : String(1),
      @sap.label : 'Production relevant'
      IsProductionRelevant : Boolean,
      @sap.label : 'Plant maintenance'
      BOMItemIsPlantMaintRelevant : Boolean,
      @sap.label : 'Relevancy to costing'
      BOMItemIsCostingRelevant : String(1),
      @sap.label : 'Engineering/design'
      IsEngineeringRelevant : Boolean,
      @sap.label : 'Special Procurement'
      SpecialProcurementType : String(2),
      @sap.label : 'Recurs. allowed'
      IsBOMRecursiveAllowed : Boolean,
      @sap.label : 'Oper. LT offset'
      OperationLeadTimeOffset : Decimal(3, 0),
      @sap.label : 'Operation LTO unit'
      OpsLeadTimeOffsetUnit : String(3),
      @sap.label : 'Mat. Provision Ind.'
      IsMaterialProvision : String(1),
      @sap.label : 'Recursive'
      BOMIsRecursive : Boolean,
      @sap.label : 'CAD Indicator'
      DocumentIsCreatedByCAD : Boolean,
      @sap.label : 'Distribution key'
      DistrKeyCompConsumption : String(4),
      @sap.label : 'Delivery time (days)'
      DeliveryDurationInDays : Decimal(3, 0),
      @sap.label : 'Supplier'
      Creditor : String(10),
      @sap.label : 'Cost element'
      CostElement : String(10),
      @sap.label : 'Size 1'
      @sap.unit : 'UnitOfMeasureForSize1To3'
      Size1 : Decimal(13, 3),
      @sap.label : 'Size 2'
      @sap.unit : 'UnitOfMeasureForSize1To3'
      Size2 : Decimal(13, 3),
      @sap.label : 'Size 3'
      @sap.unit : 'UnitOfMeasureForSize1To3'
      Size3 : Decimal(13, 3),
      @sap.label : 'Size unit'
      UnitOfMeasureForSize1To3 : String(3),
      @sap.label : 'GR processing time'
      GoodsReceiptDuration : Decimal(3, 0),
      @sap.label : 'Purch. Organization'
      PurchasingOrganization : String(4),
      @sap.label : 'Required Component'
      RequiredComponent : Boolean,
      @sap.label : 'Multiple Selection'
      MultipleSelectionAllowed : Boolean,
      @sap.label : 'Storage Location'
      ProdOrderIssueLocation : String(4),
      @sap.label : 'Co-product'
      MaterialIsCoProduct : Boolean,
      @sap.label : 'Explosion type'
      ExplosionType : String(2),
      @sap.label : 'AltItemGroup'
      AlternativeItemGroup : String(2),
      @sap.label : 'Priority'
      AlternativeItemPriority : String(2),
      @sap.label : 'Strategy'
      AlternativeItemStrategy : String(1),
      @sap.label : 'Usage Probability'
      UsageProbabilityPercent : Decimal(3, 0),
      @sap.label : 'Follow-up group'
      FollowUpGroup : String(2),
      @sap.label : 'Discont. group'
      DiscontinuationGroup : String(2),
      @sap.label : 'Selection indicator'
      IsConfigurableBOM : String(1),
      @sap.label : 'Reference point'
      ReferencePoint : String(20),
      @sap.label : 'Lead-time offset'
      LeadTimeOffset : Decimal(3, 0),
      @sap.label : 'Prodn Supply Area'
      ProductionSupplyArea : String(10),
      @sap.label : 'Deletion Indicator'
      IsDeleted : Boolean,
      @sap.label : 'ALE indicator'
      IsALE : Boolean,
      @odata.Type : 'Edm.DateTimeOffset'
      @odata.Precision : 7
      @sap.label : 'Time Stamp'
      LastChangeDateTime : Timestamp,
      @sap.label : 'Material Description'
      PreliminaryComponent : String(40)
    ) returns MaterialBOMItem;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.content.version : '2'
  @sap.deletable.path : 'Delete_mc'
  @sap.updatable.path : 'Update_mc'
  @sap.label : 'Bill of Material Subitem'
  entity MaterialBOMSubItem {
    @sap.display.format : 'UpperCase'
    @sap.label : 'char8'
    @sap.quickinfo : 'Character field, 8 characters long'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterial : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM category'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialCategory : String(1) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Alternative BOM'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialVariant : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM Version'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialVersion : String(4) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Item node'
    @sap.quickinfo : 'BOM item node number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialItemNodeNumber : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key HeaderChangeDocument : String(12) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material'
    @sap.quickinfo : 'Material Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key Material : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key Plant : String(4) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BOMItemInternalChangeCount : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Undefined range (can be used for patch levels)'
    @sap.heading : ''
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BOMSubItemNumberValue : String(4) not null;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Delete_mc : Boolean;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Update_mc : Boolean;
    @sap.label : 'Component UoM'
    @sap.quickinfo : 'Component Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    BillOfMaterialItemUnit : String(3);
    @sap.unit : 'BillOfMaterialItemUnit'
    @sap.label : 'Sub-item quantity'
    BillOfMaterialSubItemQuantity : Decimal(13, 3);
    @sap.label : 'Installation Point'
    @sap.quickinfo : 'Installation Point for Subitem'
    BOMSubItemInstallationPoint : String(20);
    @sap.label : 'Subitem Text'
    @sap.quickinfo : 'BOM sub-item text'
    BillOfMaterialSubItemText : String(40);
    to_BillOfMaterialItem : Association to MaterialBOMItem {  };
    to_BillOfMaterial : Association to MaterialBOM {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '2'
  @sap.label : 'Usage'
  entity A_BillOfMaterialUsage {
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM Usage'
    key BillOfMaterialVariantUsage : String(1) not null;
    @sap.label : 'Usage text'
    @sap.quickinfo : 'BOM usage text'
    BillOfMaterialVariantUsageDesc : String(30);
    to_BillOfMaterialUsageText : Association to A_BillOfMaterialUsageText {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '2'
  @sap.label : 'Usage Description'
  entity A_BillOfMaterialUsageText {
    @sap.label : 'Language Key'
    key Language : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM Usage'
    key BillOfMaterialVariantUsage : String(1) not null;
    @sap.label : 'Usage text'
    @sap.quickinfo : 'BOM usage text'
    BillOfMaterialVariantUsageDesc : String(30);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.content.version : '2'
  @sap.deletable.path : 'Delete_mc'
  @sap.updatable.path : 'Update_mc'
  @sap.label : 'Bill of Material'
  entity MaterialBOM {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Bill of Material'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterial : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM category'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialCategory : String(1) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Alternative BOM'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialVariant : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM Version'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialVersion : String(4) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key EngineeringChangeDocument : String(12) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material'
    @sap.quickinfo : 'Material Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key Material : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key Plant : String(4) not null;
    @sap.label : 'Dyn. Action Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    DeleteBOMHeaderWithECN_ac : Boolean;
    @sap.label : 'Dyn. Action Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    ReleaseVersionBOM_ac : Boolean;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Delete_mc : Boolean;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Update_mc : Boolean;
    @sap.label : 'Dynamic CbA-Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    to_BillOfMaterialItem_oc : Boolean;
    @sap.label : 'ID hdr chge status'
    @sap.quickinfo : 'Global identification of a BOM header change status'
    BillOfMaterialHeaderUUID : UUID;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM Usage'
    BillOfMaterialVariantUsage : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    EngineeringChangeDocForEdit : String(12);
    @sap.label : 'Alt.det. mult. BOM'
    @sap.quickinfo : 'Indicator: alternative determination for multiple BOMs'
    IsMultipleBOMAlt : Boolean;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    BOMHeaderInternalChangeCount : String(8);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Selection priority'
    @sap.quickinfo : 'CIM priority for selection ID'
    BOMUsagePriority : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Authorization group'
    @sap.quickinfo : 'Authorization group for bills of material'
    BillOfMaterialAuthsnGrp : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM Version Status'
    BOMVersionStatus : String(2);
    @sap.label : 'Versioning Relevant'
    @sap.quickinfo : 'Indicator: Relevant for Versioning'
    IsVersionBillOfMaterial : Boolean;
    @sap.label : 'Latest Rel Version'
    @sap.quickinfo : 'Indicator: Latest Released BOM Version'
    IsLatestBOMVersion : Boolean;
    @sap.label : 'Configurable BOM'
    @sap.quickinfo : 'Indicator: configurable BOM'
    IsConfiguredMaterial : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Technical type'
    BOMTechnicalType : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM group'
    BOMGroup : String(18);
    @sap.label : 'BOM Description'
    BOMHeaderText : String(40);
    @sap.label : 'Alternative Text'
    @sap.quickinfo : 'Alternative BOM Text'
    BOMAlternativeText : String(40);
    @sap.display.format : 'NonNegative'
    @sap.label : 'BOM Status'
    @sap.quickinfo : 'Bill of Material Status'
    BillOfMaterialStatus : String(2);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    HeaderValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    @sap.quickinfo : 'Valid-to date'
    HeaderValidityEndDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number To'
    ChgToEngineeringChgDocument : String(12);
    @sap.label : 'Deletion Indicator'
    IsMarkedForDeletion : Boolean;
    @sap.label : 'Deletion Flag'
    @sap.quickinfo : 'Deletion flag for BOMs'
    BOMIsArchivedForDeletion : Boolean;
    @sap.label : 'ALE indicator'
    IsALE : Boolean;
    @sap.unit : 'BOMHeaderBaseUnit'
    @sap.label : 'From Lot Size'
    MatFromLotSizeQuantity : Decimal(13, 3);
    @sap.unit : 'BOMHeaderBaseUnit'
    @sap.label : 'To Lot Size'
    MaterialToLotSizeQuantity : Decimal(13, 3);
    @sap.label : 'Base Unit of Measure'
    @sap.quickinfo : 'Base Unit of Measure for BOM'
    @sap.semantics : 'unit-of-measure'
    BOMHeaderBaseUnit : String(3);
    @sap.unit : 'BOMHeaderBaseUnit'
    @sap.label : 'Base quantity'
    BOMHeaderQuantityInBaseUnit : Decimal(13, 3);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    RecordCreationDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created by'
    @sap.quickinfo : 'User who created record'
    CreatedByUser : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Name of Person Who Changed Object'
    LastChangedByUser : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Handling Del. Flag'
    @sap.quickinfo : 'Handling Deletion Flag During BOM Explosion'
    BOMIsToBeDeleted : String(1);
    @sap.label : 'CAD Indicator'
    DocumentIsCreatedByCAD : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Lab/Office'
    @sap.quickinfo : 'Laboratory/Design Office'
    LaboratoryOrDesignOffice : String(3);
    @odata.Type : 'Edm.DateTimeOffset'
    @odata.Precision : 7
    @sap.label : 'Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun)'
    LastChangeDateTime : Timestamp;
    @sap.label : 'Product Description'
    ProductDescription : String(40);
    @sap.label : 'Plant Name'
    PlantName : String(30);
    BillOfMaterialHdrDetailsText : String(255);
    @sap.label : 'Usage text'
    @sap.quickinfo : 'BOM usage text'
    BillOfMaterialVariantUsageDesc : String(30);
    SelectedBillOfMaterialVersion : String(4);
    to_BillOfMaterialItem : Composition of many MaterialBOMItem {  };
    to_BillOfMaterialUsage : Association to A_BillOfMaterialUsage {  };
  } actions {
    action DeleteBOMHeaderWithECN(
      @sap.label : 'Change Number'
      EngineeringChangeDocForEdit : String(12)
    ) returns DBomdelchangenooutparameter;
    function ExplodeBOM(
      @sap.label : 'BOM Application'
      BOMExplosionApplication : String(4),
      @sap.label : 'Component Quantity'
      @sap.unit : 'BOMHeaderBaseUnit'
      RequiredQuantity : Decimal(13, 3),
      @sap.label : 'Limited Explosion'
      BOMExplosionIsLimited : Boolean,
      @sap.label : 'Exceptions'
      BOMItmQtyIsScrapRelevant : String(1),
      @sap.label : 'Item Category'
      BillOfMaterialItemCategory : String(1),
      @sap.label : 'Material'
      BOMExplosionAssembly : String(40),
      @sap.label : 'Valid From'
      @sap.display.format : 'Date'
      BOMExplosionDate : Date,
      @sap.label : 'Explosion level'
      BOMExplosionLevel : Decimal(3, 0),
      @sap.label : 'Multi-lev.'
      BOMExplosionIsMultilevel : Boolean,
      @sap.label : 'Mat. Provision Ind.'
      MaterialProvisionFltrType : String(1),
      @sap.label : 'Spare Part Indicator'
      SparePartFltrType : String(1),
      @sap.label : 'Base Unit of Measure'
      BOMHeaderBaseUnit : String(3),
      @sap.label : 'Display Price Data'
      FinalPriceIndicator : Boolean,
      @sap.label : 'Alternative priority'
      BOMExplosionIsAlternatePrio : Boolean
    ) returns many DBomheaderforexplosionOut;
    action ReleaseVersionBOM() returns MaterialBOM;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '2'
  @sap.label : 'Item Category'
  entity A_BOMItemCategory {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Item Category'
    @sap.quickinfo : 'Item category (bill of material)'
    key BillOfMaterialItemCategory : String(1) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Item Category'
    @sap.quickinfo : 'Item category (bill of material)'
    FixedItemCategory : String(1);
    @sap.label : 'Item Category'
    @sap.quickinfo : 'Item Category Description'
    BillOfMaterialItemCategoryDesc : String(30);
    to_BOMItemCategoryText : Association to A_BOMItemCategoryText {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '2'
  @sap.label : 'Item Category Description'
  entity A_BOMItemCategoryText {
    @sap.label : 'Language Key'
    key Language : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Item Category'
    @sap.quickinfo : 'Item category (bill of material)'
    key BillOfMaterialItemCategory : String(1) not null;
    @sap.label : 'Item Category'
    @sap.quickinfo : 'Item Category Description'
    BillOfMaterialItemCategoryDesc : String(30);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '2'
  @sap.deletable.path : 'Delete_mc'
  @sap.updatable.path : 'Update_mc'
  @sap.label : 'BOM Item Object Dependency Assignment'
  entity MBOMItmObjDpnAssignment {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Bill of Material'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterial : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM category'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialCategory : String(1) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Alternative BOM'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialVariant : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM Version'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialVersion : String(4) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key HeaderChangeDocument : String(12) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material'
    @sap.quickinfo : 'Material Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key Material : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key Plant : String(4) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Item node'
    @sap.quickinfo : 'BOM item node number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BillOfMaterialItemNodeNumber : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Dependency'
    @sap.quickinfo : 'Name of Dependency'
    @sap.updatable : 'false'
    key ObjectDependencyName : String(30) not null;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Delete_mc : Boolean;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Update_mc : Boolean;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Sort counter'
    @sap.quickinfo : 'Counter for sorting object allocations'
    ObjDpnProcessingSequenceValue : String(4);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    @sap.quickinfo : 'Valid-to date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    to_BillOfMaterialItem : Association to MaterialBOMItem {  };
    to_BillOfMaterial : Association to MaterialBOM {  };
  };

  @cds.external : true
  type DBomdelchangenooutparameter {
    @sap.label : 'Boolean Variable (X = True, - = False, Space = Unknown)'
    BOMIsSuccessfulDeleted : Boolean;
  };

  @cds.external : true
  type DBomheaderforexplosionOut {
    @sap.label : 'Alternative item'
    alternative_item : Boolean;
    @sap.label : 'AltItemGroup'
    alt_item_group : String(2);
    @sap.label : 'Altrntvs (Nxt Level)'
    alt_nxt_lvl : Boolean;
    @sap.label : 'PM assembly'
    assembly_indicator : Boolean;
    @sap.label : 'Assign effect. vals'
    assign_effect_vals : Boolean;
    @sap.label : 'AssyScrap (ItemMat)'
    assy_scrap_itm_mat : Decimal(5, 2);
    @sap.label : 'as selection cond.'
    as_selection_cond : Boolean;
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'BasQty (Next Level)'
    base_qty_nxt_lvl : Decimal(13, 3);
    @sap.label : 'BasUnit (Next Level)'
    @sap.semantics : 'unit-of-measure'
    base_unit_nxt_lvl : String(3);
    @sap.label : 'Base Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    base_uom : String(3);
    @sap.label : 'Batch entry'
    batch_entry : String(1);
    @sap.label : 'Batch Management'
    batch_mgmt : Boolean;
    @sap.label : 'Bill of Material'
    bill_of_material : String(8);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'Comp. Qty (BUn)'
    bill_of_material_base_quant : Decimal(13, 3);
    @sap.label : 'Component'
    bill_of_material_component : String(40);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'Comp. Qty (CUn)'
    bill_of_material_comp_quant : Decimal(13, 3);
    @sap.label : 'Item Category'
    bill_of_material_item_category : String(1);
    @sap.label : 'Item Number'
    bill_of_material_item_number : String(4);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'Component Quantity'
    bill_of_material_item_quantity : Decimal(13, 3);
    @sap.label : 'Base Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    bill_of_material_item_unit : String(3);
    @sap.label : 'Bill of Material'
    Bill_Of_Material_Root : String(8);
    @sap.label : 'Alternative BOM'
    bill_of_material_root_variant : String(2);
    @sap.label : 'Alternative BOM'
    bill_of_material_variant : String(2);
    @sap.label : 'BOM usage'
    bill_of_material_variant_usage : String(1);
    @sap.label : 'Change Number'
    bom_change_number : String(12);
    @sap.label : 'Bulk material'
    bulk_material : Boolean;
    @sap.label : 'Alternative Text'
    b_o_m_alternative_text : String(40);
    @sap.label : 'BOM Alt (Next Level)'
    b_o_m_alt_nxt_lvl : String(2);
    @sap.label : 'BOM category'
    b_o_m_category : String(1);
    @sap.label : 'BOM Cat (Next Level)'
    b_o_m_cat_nxt_lvl : String(1);
    @sap.label : 'Object description'
    b_o_m_component_description : String(40);
    @sap.label : 'Level'
    b_o_m_explosion_level : Decimal(2, 0);
    @sap.label : 'Material'
    b_o_m_hdr_matl_hier_node : String(40);
    @sap.label : 'Material'
    B_O_M_Hdr_Root_Matl_Hier_Node : String(40);
    @sap.label : 'Base Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    b_o_m_header_base_unit : String(3);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'Base quantity'
    b_o_m_header_quantity_primary : Decimal(13, 3);
    @sap.label : 'Item Text'
    b_o_m_item_description : String(40);
    @sap.label : 'Discontinuation ind.'
    b_o_m_item_is_discontinued : String(1);
    @sap.label : 'BOM No. (Next Level)'
    b_o_m_no_nxt_lvl : String(8);
    @sap.label : 'BOM Usage (Next Lvl)'
    b_o_m_usage_nxt_lvl : String(1);
    @sap.label : 'BOM Version'
    b_o_m_version : String(4);
    @sap.label : 'BOM Version Status'
    b_o_m_version_status : String(2);
    @sap.label : 'Short text'
    b_o_m_vers_status_description : String(60);
    @sap.label : 'Change Number'
    change_number : String(12);
    @sap.label : 'Change Number To'
    chg_to_eng_chg_number : String(12);
    @sap.label : 'Class'
    class : String(18);
    @sap.label : 'Classification'
    classification : String(8);
    @sap.label : 'Class Type'
    class_type : String(3);
    @sap.label : 'Commodity Code'
    commodity_code : String(17);
    @sap.label : 'Compl. maint. status'
    comp_maint_status : String(15);
    @sap.label : 'CmpScrap (Item)'
    comp_scrap_itm : Decimal(5, 2);
    @sap.label : 'Comp.Scrap (ItemMat)'
    comp_scrap_itm_mat : Decimal(5, 2);
    @sap.label : 'Config. (MatVar)'
    config_mat_var : String(18);
    @sap.label : 'Configd multi'
    config_multi_level : Boolean;
    @sap.label : 'Conf BOM (Nxt Level)'
    conf_bom_nxt_lvl : Boolean;
    @sap.label : 'Cost element'
    cost_element : String(10);
    @sap.label : 'Counter'
    counter : String(8);
    @sap.label : 'Co-product'
    co_product : Boolean;
    @sap.label : 'Created by'
    created_by_user : String(12);
    @sap.label : 'Currency'
    @sap.semantics : 'currency-code'
    currency : String(5);
    @sap.label : 'Customs Preference'
    customs_preference : String(1);
    @sap.label : 'DatHist (Next Level)'
    dat_hist_nxt_lvl : Boolean;
    @sap.label : 'Dln Indicator(Head)'
    deletion_indicator : Boolean;
    @sap.label : 'Delivery time (days)'
    delivery_time_in_days : Decimal(3, 0);
    @sap.label : 'DlInd (Next Level)'
    del_Ind_nxt_lvl : Boolean;
    @sap.label : 'Denominator'
    denominator : Decimal(5, 0);
    @sap.label : 'Discont. group'
    discont_group : String(2);
    @sap.label : 'Distribution key'
    distribution_key : String(4);
    @sap.label : 'Document'
    doc : String(22);
    @sap.label : 'Document Part'
    document_part : String(3);
    @sap.label : 'Document Type'
    document_type : String(3);
    @sap.label : 'Document Version'
    document_version : String(2);
    @sap.label : 'Document'
    doc_number : String(25);
    @sap.label : 'Documentation reqd'
    doc_reqd : Boolean;
    @sap.label : 'Document Status'
    doc_status : String(2);
    @sap.label : 'Document Type'
    doc_type : String(3);
    @sap.label : 'Document Version'
    doc_version : String(2);
    @sap.display.format : 'Date'
    @sap.label : 'Effective-Out Date'
    effective_out_date : Date;
    @sap.label : 'Engineering/design'
    engineering_design : Boolean;
    @sap.label : 'Exception'
    exception_bom : String(4);
    @sap.label : 'Explosion type'
    explosion_type : String(2);
    @sap.label : 'Fixed-Price Co-Prod.'
    fixed_price_co_prod : Boolean;
    @sap.label : 'Fixed Quantity'
    fixed_quantity : Boolean;
    @sap.label : 'Follow-up group'
    follow_up_grp : String(2);
    @sap.label : 'Follow-Up Item'
    follow_up_item : Boolean;
    @sap.label : 'Follow-Up Material'
    follow_up_product : String(40);
    @sap.label : 'VSI Formula'
    formula_key : String(2);
    @sap.label : 'GR processing time'
    goods_receipt_duration_in_days : Decimal(3, 0);
    @sap.label : 'Goods Recipient'
    goods_recipient : String(12);
    @sap.label : 'Header record ID'
    header_record_id : String(1);
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    header_validity_end_date : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    header_validity_start_date : Date;
    @sap.label : 'HL configuration'
    hl_configuration : Boolean;
    @sap.label : 'Indiv./ Coll.'
    individual_coll : String(1);
    @sap.label : 'Internal Object No.'
    internal_obj_no : String(18);
    @sap.label : 'Intra Material'
    intra_material : String(40);
    @sap.label : 'Issuing Plant'
    issuing_plant : String(4);
    @sap.label : 'Spare Part Indicator'
    is_b_o_m_item_spare_part : String(1);
    @sap.label : 'CAD Indicator'
    is_c_a_d : Boolean;
    @sap.label : 'Mat. Provision Ind.'
    is_material_provision : String(1);
    @sap.label : 'Phantom item'
    is_phantom_item : Boolean;
    @sap.label : 'Software component'
    is_software_component : Boolean;
    @sap.label : 'Item Text 2'
    item_description_line_2 : String(40);
    @sap.label : 'Item identification'
    item_identification : String(8);
    @sap.label : 'Table Row'
    item_index : Integer;
    @sap.label : 'Item node'
    item_node : String(8);
    @sap.label : '+/- sign'
    item_sign : Boolean;
    @sap.label : 'Changed By'
    last_changed_by_user : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    last_change_date : Date;
    @sap.label : 'Lead-time offset'
    lead_time_offset : Decimal(3, 0);
    @sap.label : 'Long Text Language'
    long_text_lang : String(2);
    @sap.label : 'Low-Level Code'
    low_level_code : String(3);
    @sap.label : 'Maintenance Status'
    maintenance_status : String(15);
    @sap.label : 'Price'
    material_component_price : Decimal(12, 3);
    @sap.label : 'Material Group'
    material_group : String(9);
    @sap.label : 'Configrable Material'
    material_is_configurable : Boolean;
    @sap.label : 'Material Description'
    Material_Name : String(40);
    @sap.label : 'Material Type'
    material_type : String(4);
    @sap.label : 'Mat. purity in %'
    mat_purity_in_perc : Decimal(5, 2);
    @sap.label : 'Moving price'
    moving_price : Decimal(12, 3);
    @sap.label : 'Multiple Selection'
    multiple_sel : Boolean;
    @sap.label : 'MRP Type'
    m_r_p_type : String(2);
    @sap.label : 'Net Scrap Indicator'
    net_scrap_indicator : Boolean;
    @sap.label : 'NoCUInstances'
    no_cu_instances : String(6);
    @sap.label : 'Number Of Sheets'
    no_of_sheets : String(3);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'No. of VSI Required'
    no_var_size_items : Decimal(13, 3);
    @sap.label : 'Numerator'
    numerator : Decimal(5, 0);
    @sap.label : 'Object description'
    object_description : String(40);
    @sap.label : 'Object Type'
    object_type : String(1);
    @sap.label : 'Assignment number'
    obj_dep_assgt_no : String(18);
    @sap.label : 'Operation Scrap in %'
    operation_scrap_perc : Decimal(5, 2);
    @sap.label : 'Operation LTO unit'
    @sap.semantics : 'unit-of-measure'
    oper_lto_unit : String(3);
    @sap.label : 'Oper. LT offset'
    oper_lt_offset : Decimal(3, 0);
    @sap.label : 'Organizational area'
    org_area : String(10);
    @sap.label : 'Page Format'
    page_format : String(4);
    @sap.label : 'Page Number'
    page_number : String(3);
    @sap.label : 'Path'
    path : Decimal(4, 0);
    @sap.label : 'Path (Predecessor)'
    path_predecessor : Decimal(4, 0);
    @sap.label : 'Plant'
    plant : String(4);
    @sap.label : 'Name 1'
    plantName : String(30);
    @sap.label : 'Plant maintenance'
    plant_maintenance : Boolean;
    @sap.label : 'P-S Mat. Status'
    plant_sp_matl_status : String(2);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    plt_sp_status_valid_from : Date;
    @sap.label : 'Price control'
    price_control : String(1);
    @sap.label : 'Price Unit (ItemMat)'
    price_unit : Decimal(5, 0);
    @sap.label : 'Priority'
    priority : String(2);
    @sap.label : 'Procured externally'
    procured_externally : Boolean;
    @sap.label : 'Prodn Supply Area'
    prodn_supply_area : String(10);
    @sap.label : 'Production relevant'
    production_relevant : Boolean;
    @sap.label : 'Production Version'
    production_version : String(4);
    @sap.label : 'Prod. Stor. Loc.'
    prod_order_issue_location : String(4);
    @sap.label : 'Profit Center'
    profit_center : String(10);
    @sap.label : 'Purchasing Group'
    purchasing_group : String(3);
    @sap.label : 'Purch. Organization'
    purchasing_organisation : String(4);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'VSI Quantity per PC'
    qty_var_size_item : Decimal(13, 3);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    record_creation_date : Date;
    @sap.label : 'Recursive'
    recurisve : Boolean;
    @sap.label : 'Recurs. allowed'
    recurs_allowed : Boolean;
    @sap.label : 'Reference point'
    reference_point : String(20);
    @sap.label : 'CostingRelevncy'
    relevancy_to_costing : String(1);
    @sap.label : 'Relevant to sales'
    relevant_to_sales : String(1);
    @sap.label : 'Required Component'
    required_component : Boolean;
    @sap.label : 'Requirement Segment'
    requirement_segment : String(40);
    @sap.label : 'Revision Level'
    revision_level : String(2);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'Scrap Qty (BUn)'
    scrap_qty_bun : Decimal(13, 3);
    @sap.label : 'Serial No. Profile'
    serial_no_profile : String(4);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'Size 1'
    size1 : Decimal(13, 3);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'Size 2'
    size2 : Decimal(13, 3);
    @sap.unit : 'bill_of_material_item_unit'
    @sap.label : 'Size 3'
    size3 : Decimal(13, 3);
    @sap.label : 'Size unit'
    @sap.semantics : 'unit-of-measure'
    size_unit : String(3);
    @sap.label : 'Sort String'
    sort_string : String(10);
    @sap.label : 'Special Procurement'
    special_procurement_type : String(2);
    @sap.label : 'Special Procurement'
    special_proc_typ_itm : String(2);
    @sap.label : 'Special procurement'
    special_proc_typ_mastr : String(2);
    @sap.label : 'SpecProcurem Costing'
    spec_proc_costing : String(2);
    @sap.label : 'Standard price'
    standard_price : Decimal(12, 3);
    @sap.label : 'Status Text'
    status_text : String(16);
    @sap.label : 'Stock Segment'
    stock_segment : String(40);
    @sap.label : 'Storage Location'
    storage_location : String(4);
    @sap.label : 'Strategy'
    strategy : String(1);
    @sap.label : 'Sub-item indicator'
    sub_item_indicator : Boolean;
    @sap.label : 'Supplier'
    supplier : String(10);
    @sap.label : 'Table Row'
    table_row : Integer;
    @sap.label : 'Tech status from'
    tech_status_from : String(12);
    @sap.label : 'TeStHist (Next Lvl)'
    test_hist_nxt_lvl : Boolean;
    @sap.label : 'Totals record ID'
    totals_record_id : String(1);
    @sap.label : 'Component UoM'
    @sap.semantics : 'unit-of-measure'
    unit_of_measure : String(3);
    @sap.label : 'Unloading Point'
    unloading_point : String(25);
    @sap.label : 'Units of meas. usage'
    uom_usage : String(1);
    @sap.label : 'Usage Probability'
    usage_probability : Decimal(3, 0);
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    validity_end_date : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    validity_start_date : Date;
    @sap.label : 'Valuation Category'
    valuation_category : String(1);
    @sap.label : 'Variants(Next Level)'
    variants_nxt_lvl : Boolean;
    @sap.label : 'X-Plant Status'
    x_plant_material_status : String(2);
    @sap.display.format : 'Date'
    @sap.label : 'Valid from'
    x_plt_status_valid_from : Date;
  };
};


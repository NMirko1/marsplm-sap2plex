@cds.external : true
@m.IsDefaultEntityContainer : 'true'
@sap.message.scope.supported : 'true'
@sap.supported.formats : 'atom json xlsx'
service sap_s4_OP_API_PRODUCTION_ROUTING_0003_v3 {
  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Material Assignment'
  entity ProductionRoutingMatlAssgmt {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material'
    @sap.quickinfo : 'Material Number'
    @sap.updatable : 'false'
    key Product : String(40) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.updatable : 'false'
    key Plant : String(4) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Addit. Crit. Cntr'
    @sap.quickinfo : 'Counter for Additional Criteria'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingMatlAssgmt : String(7) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRtgMatlAssgmtIntVers : String(8) not null;
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid-To Date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.updatable : 'false'
    ChangeNumber : String(12);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ChangedDateTime : DateTime;
    @sap.label : 'Material Description'
    ProductName : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sales Document'
    SalesOrder : String(10);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Sales Document Item'
    SalesOrderItem : String(6);
    to_Header : Association to many ProductionRoutingHeader {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DeleteMatlAssgmtViaChangeNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Component Allocation'
  entity ProductionRoutingCompAlloc {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingSequence : String(6) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Task list node'
    @sap.quickinfo : 'Task list node number for operation'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingOpIntID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Allocation no.'
    @sap.quickinfo : 'No. for material comp. allocation to task list'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProdnRtgOpBOMItemInternalID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProdnRtgOpBOMItemIntVersion : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOM category'
    @sap.updatable : 'false'
    BillOfMaterialCategory : String(1) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Bill Of Material'
    BillOfMaterial : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Component'
    @sap.quickinfo : 'BOM component'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BillOfMaterialComponent : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Alternative BOM'
    BillOfMaterialVariant : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Nodes'
    @sap.quickinfo : 'Node Number'
    BillOfMaterialItemNodeNumber : String(8);
    @sap.label : 'Backflush'
    @sap.quickinfo : 'Indicator: Backflush'
    MatlCompIsMarkedForBackflush : Boolean;
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed on'
    @sap.quickinfo : 'Change Date Without Document Update'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid-To Date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ChangedDateTime : DateTime;
    to_Header : Association to many ProductionRoutingHeader {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DeleteCompAllocViaChangeNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Production Routing Operation'
  entity ProductionRoutingOperation {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingSequence : String(6) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Task List Node'
    @sap.quickinfo : 'Number of the Task List Node'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingOpIntID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingOpIntVersion : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.text : 'OperationText'
    @sap.label : 'Operation or Phase'
    @sap.quickinfo : 'Operation / Phase Number'
    Operation : String(4);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid-To Date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.label : 'Deletion Indicator'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    IsDeleted : Boolean;
    @sap.label : 'Deletion Indicator'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    IsImplicitlyDeleted : Boolean;
    @sap.label : 'Operation Short Text'
    OperationText : String(40);
    @sap.label : 'Language Key'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LongTextLanguageCode : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    Plant : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Control Key'
    OperationControlProfile : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Standard Text Key'
    OperationStandardTextCode : String(7);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Object Type'
    @sap.quickinfo : 'Object types of the CIM resource'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    WorkCenterTypeCode : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Object ID'
    WorkCenterInternalID : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Capacity category'
    CapacityCategoryCode : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Element'
    CostElement : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Operation Costing Relevancy Type'
    OperationCostingRelevancyType : String(1);
    @sap.label : 'No. of Time Tickets'
    @sap.quickinfo : 'Number of Time Tickets'
    NumberOfTimeTickets : Decimal(3, 0);
    @sap.display.format : 'NonNegative'
    @sap.label : 'No. of Conf. Slips'
    @sap.quickinfo : 'Number of Confirmation Slips'
    NumberOfConfirmationSlips : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Suitability'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    EmployeeSuitability : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Ref TList type'
    @sap.quickinfo : 'Type of the referenced task list'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BillOfOperationsRefType : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Referenced BOO Group'
    @sap.quickinfo : 'Referenced Bill of Operations Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BillOfOperationsRefGroup : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Referenced BOO Variant'
    @sap.quickinfo : 'Referenced Bill of Operations Variant'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BillOfOperationsRefVariant : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Line Segment Takt'
    @sap.quickinfo : 'Takt within a Line Segment'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LineSegmentTakt : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Grouping Category'
    @sap.quickinfo : 'Operation: Standard Work Quantity Grouping Category'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    OperationStdWorkQtyGrpgCat : String(1);
    @sap.label : 'No Suboperations'
    @sap.quickinfo : 'Suboperations Do Not Apply to Order'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    OrderHasNoSubOperations : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Setup Type Key'
    OperationSetupType : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Setup group category'
    OperationSetupGroupCategory : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Setup group key'
    OperationSetupGroup : String(10);
    @sap.label : 'Indicator: Phase'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BOOOperationIsPhase : Boolean;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Task List Node'
    @sap.quickinfo : 'Number of the Task List Node'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BOOPhaseSuperiorOpInternalID : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Ctrl Rec.Destination'
    @sap.quickinfo : 'Control Recipe Destination'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ControlRecipeDestination : String(2);
    @sap.label : 'Subcontracting'
    @sap.quickinfo : 'Indicator: External Processing Operation with Subcontracting'
    OpIsExtlyProcdWithSubcontrg : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purchasing info rec.'
    @sap.quickinfo : 'Number of purchasing info record'
    PurchasingInfoRecord : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purch. Organization'
    @sap.quickinfo : 'Purchasing Organization'
    PurchasingOrganization : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purchasing Document'
    @sap.quickinfo : 'Purchasing Document Number'
    PurchaseContract : String(10);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Item'
    @sap.quickinfo : 'Item Number of Purchasing Document'
    PurchaseContractItem : String(5);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sort Term'
    @sap.quickinfo : 'Sort Term for Non-Stock Info Records'
    PurchasingInfoRecdAddlGrpgName : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material Group'
    MaterialGroup : String(9);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purchasing Group'
    @sap.quickinfo : 'Purchasing Group for External Processing Activity'
    PurchasingGroup : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Supplier'
    @sap.quickinfo : 'Account Number of Supplier'
    Supplier : String(10);
    @sap.label : 'Planned Deliv. Time'
    @sap.quickinfo : 'Planned Delivery Time in Days'
    PlannedDeliveryDuration : Decimal(3, 0);
    @sap.label : 'Price unit'
    NumberOfOperationPriceUnits : Decimal(5, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Currency'
    @sap.quickinfo : 'Currency Key'
    @sap.semantics : 'currency-code'
    OpExternalProcessingCurrency : String(5);
    @sap.unit : 'OpExternalProcessingCurrency'
    @sap.variable.scale : 'true'
    @sap.label : 'Net Price'
    @sap.quickinfo : 'Net Price in Purchasing Info Record'
    OpExternalProcessingPrice : Decimal(11, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Inspection Type'
    InspectionLotType : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Recording View'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    InspResultRecordingView : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Insp.pointCompletion'
    @sap.quickinfo : 'Flow Variants for Inspection Point Completion'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    InspSbstCompletionConfirmation : String(1);
    @sap.label : 'No Reference'
    @sap.quickinfo : 'Interval Without Reference to Time or Quantity'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    InspSbstHasNoTimeOrQuantity : Boolean;
    @sap.unit : 'OperationUnit'
    @sap.label : 'Base Quantity'
    OperationReferenceQuantity : Decimal(13, 3);
    @sap.label : 'Operation unit'
    @sap.quickinfo : 'Unit of measure for activity'
    @sap.semantics : 'unit-of-measure'
    OperationUnit : String(3);
    @sap.label : 'Scrap'
    @sap.quickinfo : 'Scrap factor'
    OperationScrapPercent : Decimal(5, 3);
    @sap.label : 'Numerator'
    @sap.quickinfo : 'Numerator for Converting Routing and Operation UoM'
    OpQtyToBaseQtyNmrtr : Decimal(5, 0);
    @sap.label : 'Denominator'
    @sap.quickinfo : 'Denominator for Converting Routing and Operation UoM'
    OpQtyToBaseQtyDnmntr : Decimal(5, 0);
    @sap.unit : 'StandardWorkQuantityUnit1'
    @sap.label : 'Standard Work Quantity 1'
    StandardWorkQuantity1 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 1'
    @sap.quickinfo : 'Standard Work Quantity Unit 1'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit1 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 1'
    CostCtrActivityType1 : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Efficiency rate'
    @sap.quickinfo : 'Key for performance efficiency rate'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    PerfEfficiencyRatioCode1 : String(3);
    @sap.unit : 'StandardWorkQuantityUnit2'
    @sap.label : 'Standard Work Quantity 2'
    StandardWorkQuantity2 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 2'
    @sap.quickinfo : 'Standard Work Quantity Unit 2'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit2 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 2'
    CostCtrActivityType2 : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Efficiency rate'
    @sap.quickinfo : 'Key for performance efficiency rate'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    PerfEfficiencyRatioCode2 : String(3);
    @sap.unit : 'StandardWorkQuantityUnit3'
    @sap.label : 'Standard Work Quantity 3'
    StandardWorkQuantity3 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 3'
    @sap.quickinfo : 'Standard Work Quantity Unit 3'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit3 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 3'
    CostCtrActivityType3 : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Efficiency rate'
    @sap.quickinfo : 'Key for performance efficiency rate'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    PerfEfficiencyRatioCode3 : String(3);
    @sap.unit : 'StandardWorkQuantityUnit4'
    @sap.label : 'Standard Work Quantity 4'
    StandardWorkQuantity4 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 4'
    @sap.quickinfo : 'Standard Work Quantity Unit 4'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit4 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 4'
    CostCtrActivityType4 : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Efficiency rate'
    @sap.quickinfo : 'Key for performance efficiency rate'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    PerfEfficiencyRatioCode4 : String(3);
    @sap.unit : 'StandardWorkQuantityUnit5'
    @sap.label : 'Standard Work Quantity 5'
    StandardWorkQuantity5 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 5'
    @sap.quickinfo : 'Standard Work Quantity Unit 5'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit5 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 5'
    CostCtrActivityType5 : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Efficiency rate'
    @sap.quickinfo : 'Key for performance efficiency rate'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    PerfEfficiencyRatioCode5 : String(3);
    @sap.unit : 'StandardWorkQuantityUnit6'
    @sap.label : 'Standard Work Quantity 6'
    StandardWorkQuantity6 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 6'
    @sap.quickinfo : 'Standard Work Quantity Unit 6'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit6 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 6'
    CostCtrActivityType6 : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Efficiency rate'
    @sap.quickinfo : 'Key for performance efficiency rate'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    PerfEfficiencyRatioCode6 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Business Process'
    BusinessProcess : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Reduction Strategy'
    @sap.quickinfo : 'Reduction Strategy per Operation'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LeadTimeReductionStrategy : String(2);
    @sap.label : 'Teardown/Wait Par.'
    @sap.quickinfo : 'Teardown and Wait Occur in Parallel'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    TeardownAndWaitIsParallel : Boolean;
    @sap.unit : 'BreakDurationUnit'
    @sap.label : 'Break Time'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BillOfOperationsBreakDuration : Decimal(9, 3);
    @sap.label : 'Break Time Unit'
    @sap.quickinfo : 'Unit for a Break Time'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.semantics : 'unit-of-measure'
    BreakDurationUnit : String(3);
    @sap.unit : 'MaximumWaitDurationUnit'
    @sap.label : 'Maximum Wait Time'
    MaximumWaitDuration : Decimal(9, 3);
    @sap.label : 'Max. Wait Time Unit'
    @sap.quickinfo : 'Unit for the Maximum Wait Time'
    @sap.semantics : 'unit-of-measure'
    MaximumWaitDurationUnit : String(3);
    @sap.unit : 'MinimumWaitDurationUnit'
    @sap.label : 'Minimum Wait Time'
    MinimumWaitDuration : Decimal(9, 3);
    @sap.label : 'Req. Wait Time Unit'
    @sap.quickinfo : 'Unit for the Required Wait Time'
    @sap.semantics : 'unit-of-measure'
    MinimumWaitDurationUnit : String(3);
    @sap.unit : 'StandardQueueDurationUnit'
    @sap.label : 'Standard Queue Time'
    StandardQueueDuration : Decimal(9, 3);
    @sap.label : 'Std Queue Time Unit'
    @sap.quickinfo : 'Unit for the Standard Queue Time'
    @sap.semantics : 'unit-of-measure'
    StandardQueueDurationUnit : String(3);
    @sap.unit : 'MinimumQueueDurationUnit'
    @sap.label : 'Minimum Queue Time'
    MinimumQueueDuration : Decimal(9, 3);
    @sap.label : 'Min. Queue Time Unit'
    @sap.quickinfo : 'Unit for the Minimum Queue Time'
    @sap.semantics : 'unit-of-measure'
    MinimumQueueDurationUnit : String(3);
    @sap.unit : 'StandardMoveDurationUnit'
    @sap.label : 'Standard Move Time'
    StandardMoveDuration : Decimal(9, 3);
    @sap.label : 'Un.for StdMoveTime'
    @sap.quickinfo : 'Unit for the standard move time'
    @sap.semantics : 'unit-of-measure'
    StandardMoveDurationUnit : String(3);
    @sap.unit : 'MinimumMoveDurationUnit'
    @sap.label : 'Minimum Move Time'
    MinimumMoveDuration : Decimal(9, 3);
    @sap.label : 'Un.for MinMoveTime'
    @sap.quickinfo : 'Unit for the minimum move time'
    @sap.semantics : 'unit-of-measure'
    MinimumMoveDurationUnit : String(3);
    @sap.label : 'Splitting Required'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    OperationSplitIsRequired : Boolean;
    @sap.label : 'Maximum Splits'
    @sap.quickinfo : 'Maximum Number of Splits'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    MaximumNumberOfSplits : Decimal(3, 0);
    @sap.unit : 'MinProcessingDurnPerSplitUnit'
    @sap.label : 'Min. Processing Time'
    @sap.quickinfo : 'Minimum Processing Time'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    MinProcessingDurationPerSplit : Decimal(9, 3);
    @sap.label : 'Processing Time Unit'
    @sap.quickinfo : 'Unit for the Minimum Processing Time'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.semantics : 'unit-of-measure'
    MinProcessingDurnPerSplitUnit : String(3);
    @sap.label : 'Operation Overlapping is Required'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    OperationOverlappingIsRequired : Boolean;
    @sap.label : 'Operation Overlapping is Allowed'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    OperationOverlappingIsPossible : Boolean;
    @sap.label : 'Flow Manufacturing'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    OperationsIsAlwaysOverlapping : Boolean;
    @sap.label : 'No Overlapping'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    OperationHasNoOverlapping : Boolean;
    @sap.unit : 'OverlapMinimumDurationUnit'
    @sap.label : 'Minimum Overlap Time'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    OverlapMinimumDuration : Decimal(9, 3);
    @sap.label : 'Min. Overlap Time'
    @sap.quickinfo : 'Unit for the Minimum Overlap Time'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.semantics : 'unit-of-measure'
    OverlapMinimumDurationUnit : String(3);
    @sap.unit : 'OverlapMinimumTransferQtyUnit'
    @sap.label : 'Min. Send-Ahead Qty'
    @sap.quickinfo : 'Minimum Send-Ahead Quantity'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    OverlapMinimumTransferQty : Decimal(13, 3);
    @sap.label : 'Operation unit'
    @sap.quickinfo : 'Unit of measure for activity'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.semantics : 'unit-of-measure'
    OverlapMinimumTransferQtyUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Factory Calendar ID'
    @sap.quickinfo : 'Factory Calendar'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    FactoryCalendar : String(2);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ChangedDateTime : DateTime;
    @sap.label : 'Long Text'
    PlainLongText : String;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Work Center'
    WorkCenter : String(8);
    to_Header : Association to many ProductionRoutingHeader {  };
    to_OpCompAlloc : Association to many ProductionRoutingCompAlloc {  };
    to_OpDocPRTAssgmt : Association to many ProductionRoutingDocPRTAssgmt {  };
    to_OpEquipPRTAssgmt : Association to many ProductionRtgEquipPRTAssgmt {  };
    to_OpInspCharcsAssgmt : Association to many ProdnRtgInspCharcsAssgmt {  };
    to_OpMatlPRTAssgmt : Association to many ProductionRoutingMatlPRTAssgmt {  };
    to_OpMiscPRTAssgmt : Association to many ProductionRoutingMiscPRTAssgmt {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
    to_SubOp : Association to many ProductionRoutingSubordOp {  };
  } actions {
    action DeleteOperationViaChangeNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Production Routing Sequence'
  entity ProductionRoutingSequence {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingSequence : String(6) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingSqncIntVers : String(8) not null;
    @sap.label : 'Deletion Indicator'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    IsDeleted : Boolean;
    @sap.label : 'Deletion Indicator'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    IsImplicitlyDeleted : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid-To Date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence Category'
    SequenceCategory : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Reference Sequence'
    BillOfOperationsRefSequence : String(6);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Ref.oper.set from'
    @sap.quickinfo : 'Reference node for start of a sequence'
    BOOSqncBranchOpInternalID : String(8);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Ref.operation to'
    @sap.quickinfo : 'Finish reference node of a sequence'
    BOOSqncReturnOpInternalID : String(8);
    @sap.unit : 'BillOfOperationsUnit'
    @sap.label : 'Lot Size From'
    @sap.quickinfo : 'Minimum Lot Size'
    MinimumLotSizeQuantity : Decimal(13, 3);
    @sap.unit : 'BillOfOperationsUnit'
    @sap.label : 'Lot Size To'
    @sap.quickinfo : 'Maximum Lot Size'
    MaximumLotSizeQuantity : Decimal(13, 3);
    @sap.label : 'Task List Unit'
    @sap.quickinfo : 'Task List Unit of Measure'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.semantics : 'unit-of-measure'
    BillOfOperationsUnit : String(3);
    @sap.label : 'Sequence Description'
    SequenceText : String(40);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    ChangedDateTime : DateTime;
    to_Header : Association to many ProductionRoutingHeader {  };
    to_Operation : Association to many ProductionRoutingOperation {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DeleteSequenceViaChangeNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Inspection Characteristics Assignment'
  entity ProdnRtgInspCharcsAssgmt {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingSequence : String(6) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Task List Node'
    @sap.quickinfo : 'Number of the Task List Node'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingOpIntID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Insp. Characteristic'
    @sap.quickinfo : 'Inspection Characteristic Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BOOCharacteristic : String(4) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key BOOCharacteristicVersion : String(8) not null;
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    @sap.updatable : 'false'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    @sap.quickinfo : 'Valid-to date'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.label : 'Deletion Indicator'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    IsDeleted : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Insp. Method Plant'
    @sap.quickinfo : 'Plant for Inspection Method'
    InspectionMethodPlant : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Inspection Method'
    InspectionMethod : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Version'
    @sap.quickinfo : 'Version Number of Inspection Method'
    InspectionMethodVersion : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Weighting of Charc'
    @sap.quickinfo : 'Weighting of Characteristic'
    InspSpecImportanceCode : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Inspector Qualific.'
    @sap.quickinfo : 'Inspector Qualification'
    InspectorQualification : String(5);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Test equipment'
    @sap.quickinfo : 'Assigned Test Equipment'
    BOOOperationPRTInternalID : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.quickinfo : 'Plant for Master Inspection Characteristic'
    InspectionSpecificationPlant : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Master Insp. Charac.'
    @sap.quickinfo : 'Master Inspection Characteristic'
    InspectionSpecification : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Version'
    @sap.quickinfo : 'Version Number of Master Inspection Characteristic'
    InspectionSpecificationVersion : String(6);
    @sap.label : 'Ref. to charact.'
    @sap.quickinfo : 'Reference to Master Insp. Characteristic in Task List'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BOOCharcHasInspSpecReference : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Char. control ind.'
    @sap.quickinfo : 'Cntrl Indicator String for Insp. Char./Master Insp. Char.'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    InspSpecControlIndicators : String(30);
    @sap.label : 'Is Quantitative Characteristic'
    InspSpecIsQuantitative : Boolean;
    @sap.label : 'Is Quantitative Characteristic'
    InspSpecIsQualitative : Boolean;
    @sap.label : 'Record Measured Vals'
    @sap.quickinfo : 'Measured Values Must Be Recorded'
    InspSpecIsMeasuredValueRqd : Boolean;
    @sap.label : 'Charc Attribute'
    @sap.quickinfo : 'Reference to Characteristic Attribute Required'
    InspSpecIsSelectedSetRequired : Boolean;
    @sap.label : 'Upper Specif. Limit'
    @sap.quickinfo : 'Upper Specification Limit'
    InspSpecIsUpperLimitRequired : Boolean;
    @sap.label : 'Lower Specif. Limit'
    @sap.quickinfo : 'Lower Specification Limit'
    InspSpecIsLowerLimitRequired : Boolean;
    @sap.label : 'Check Target Value'
    InspSpecIsTargetValueInLimit : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Inspection Scope'
    InspectionScope : String(1);
    @sap.label : 'Long-Term Inspection'
    InspSpecIsLongTermInspection : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Recording Type'
    InspSpecRecordingType : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Inspection Result'
    @sap.quickinfo : 'Documentation Required for Inspection Result'
    InspResultIsDocumentationRqd : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Characteristic Category'
    InspSpecCharcCategory : String(1);
    @sap.label : 'Additive Sample'
    @sap.quickinfo : 'Inspection Sample Quantity Is Added'
    InspSpecIsSampleQtyAdditive : Boolean;
    @sap.label : 'Destructive Insp.'
    @sap.quickinfo : 'Destructive Inspection'
    InspSpecIsDestructive : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Characteristic Result Calculation'
    InspSpecResultCalculation : String(1);
    @sap.label : 'No Formula'
    @sap.quickinfo : 'Inspection Characteristic Does Not Contain a Formula'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    InspSpecHasNoFormula : Boolean;
    @sap.label : 'Sampling Procedure'
    @sap.quickinfo : 'Sampling Procedure Is Required'
    InspSpecIsSamplingProcedRqd : Boolean;
    @sap.label : 'Scrap Share/Q-Score'
    @sap.quickinfo : 'Characteristic Relevant for Quality Score and Scrap Share'
    InspSpecIsScrapRelevant : Boolean;
    @sap.label : 'Fixed Indicators'
    @sap.quickinfo : 'Default Control Indicators Cannot Be Changed'
    InspSpecHasFixedCtrlIndicators : Boolean;
    @sap.label : 'Record No. of Defs'
    @sap.quickinfo : 'Recording the Number of Defects'
    InspSpecIsDefectRecordingRqd : Boolean;
    @sap.label : 'Test Equip. Assignmt'
    @sap.quickinfo : 'Assignment of Test Equipment Required'
    InspSpecIsTestEquipmentRqd : Boolean;
    @sap.label : 'Defects Recording'
    @sap.quickinfo : 'Defects Recording Automatically Called Up'
    InspSpecIsDefectsRecgAutomatic : Boolean;
    @sap.label : 'RR Change Docs'
    @sap.quickinfo : 'Create Change Documents During Results Recording'
    InspSpecIsChgDocRequired : Boolean;
    @sap.label : 'SPC Characteristic'
    InspSpecIsControlChartUsed : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Inspection Print Control'
    InspSpecPrintControl : String(1);
    @sap.label : 'Tolerance Key'
    InspToleranceSpecification : String(4);
    @odata.Type : 'Edm.Byte'
    @sap.label : 'Decimal Places'
    @sap.quickinfo : 'Number of Places to the Right of a Decimal Point (Accuracy)'
    InspSpecDecimalPlaces : Integer;
    @sap.label : 'Unit of Measurement'
    @sap.quickinfo : 'Unit of Measurement in Which Quantitative Data Is Stored'
    @sap.semantics : 'unit-of-measure'
    InspectionSpecificationUnit : String(3);
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : 'Target Value'
    @sap.quickinfo : 'Target Value for a Quantitative Characteristic'
    InspSpecTargetValue : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasTargetValue : Boolean;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : 'Upper Specif. Limit'
    @sap.quickinfo : 'Upper Specification Limit'
    InspSpecUpperLimit : Double;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : 'Lower Specif. Limit'
    @sap.quickinfo : 'Lower Specification Limit'
    InspSpecLowerLimit : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasUpperLimit : Boolean;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasLowerLimit : Boolean;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : 'Upper Plausib. Limit'
    @sap.quickinfo : 'Upper Plausibility Limit'
    InspSpecUpperPlausibilityLimit : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasUprPlausibilityLmt : Boolean;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : 'Lower Plausib. Limit'
    @sap.quickinfo : 'Lower Plausibility Limit'
    InspSpecLowerPlausibilityLimit : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasLowrPlausibilityLmt : Boolean;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : '1st Upper Limit'
    @sap.quickinfo : 'First Upper Specification Limit'
    InspSpecFirstUpperSpecLimit : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasFirstUpperSpecLimit : Boolean;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : '1st Lower Limit'
    @sap.quickinfo : 'First Lower Specification Limit'
    InspSpecFirstLowerSpecLimit : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasFirstLowerSpecLimit : Boolean;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : '2nd Upper Limit'
    @sap.quickinfo : 'Second Upper Specification Limit'
    InspSpecSecondUpperSpecLimit : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasSecondUprSpecLimit : Boolean;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : '2nd Lower Limit'
    @sap.quickinfo : 'Second Lower Specification Limit'
    InspSpecSecondLowerSpecLimit : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasSecondLowrSpecLimit : Boolean;
    @sap.display.format : 'Date'
    @sap.label : 'Tolerance Valid From'
    @sap.quickinfo : 'Date from Which the Tolerance Change Is Valid'
    InspSpecToleranceChgValidFrom : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Tolerance Valid To'
    @sap.quickinfo : 'Date Until Which the Tolerance Change Is Valid'
    InspSpecToleranceChgValidTo : Date;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : 'Change to Upper Specification Limit'
    InspSpecUpperSpecLimitChange : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasUprSpecLimitChange : Boolean;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : 'Change to Lower Specification Limit'
    InspSpecLowerSpecLimitChange : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasLowrSpecLimitChange : Boolean;
    @odata.Type : 'Edm.Byte'
    @sap.label : 'Number of Classes'
    @sap.quickinfo : 'Number of Value Classes for Inspection Results'
    InspSpecNumberOfClasses : Integer;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : 'Class Width'
    InspSpecClassWidthQty : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasClassWidth : Boolean;
    @sap.unit : 'InspectionSpecificationUnit'
    @sap.label : 'Class Midpoint'
    InspSpecClassMidpointQty : Double;
    @sap.label : 'Not Initial'
    @sap.quickinfo : 'Value Not Initial If Set'
    InspSpecHasClassMidpoint : Boolean;
    @sap.label : 'Calculate Formula'
    @sap.quickinfo : 'Check and Calculate Formula in QM'
    InspSpecHasFormula : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Formula'
    @sap.quickinfo : 'Formula Field'
    InspSpecFormula1 : String(60);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Formula'
    @sap.quickinfo : 'Formula Field'
    InspSpecFormula2 : String(60);
    @sap.display.format : 'UpperCase'
    @sap.label : 'DefCodeGrp Rej.'
    @sap.quickinfo : 'Defect Code Group for General Rejection'
    InspSpecDefectCodeGrpRejection : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Defect Cde: General'
    @sap.quickinfo : 'Defect Code for Rejection: General'
    InspSpecDefectCodeRejection : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'UpLim defect group'
    @sap.quickinfo : 'Defect Code Group for Rejection at Upper Tolerance'
    InspSpecDefectCodeGrpRjcnUpper : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'At upper spec. limit'
    @sap.quickinfo : 'Defect Code for Rejection at Upper Specification Limit'
    InspSpecDefectCodeRjcnUpper : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Low. lim. DefCodeGrp'
    @sap.quickinfo : 'Defect Code Group for Rejection at Lower Tolerance'
    InspSpecDefectCodeGrpRjcnLower : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'At lower spec. limit'
    @sap.quickinfo : 'Defect Code for Rejection at Lower Specification Limit'
    InspSpecDefectCodeRjcnLower : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code group/sel. set'
    @sap.quickinfo : 'Assigned Code Group or Selected Set'
    SelectedCodeSet : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.quickinfo : 'Plant of the Assigned Selected Set'
    SelectedCodeSetPlant : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Catalog Type'
    @sap.quickinfo : 'Catalog Type of Assigned Code Group or Selected Set'
    InspSpecAdditionalCatalog2 : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code group/sel. set'
    @sap.quickinfo : 'Assigned Code Group or Selected Set'
    InspSpecAdditionalSelectedSet2 : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code group/sel. set'
    @sap.quickinfo : 'Assigned Code Group or Selected Set'
    InspSpecAdditionalCodeGroup2 : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.quickinfo : 'Plant of the Assigned Selected Set'
    InspSpecAddlSeldCodeSetPlant2 : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Catalog Type'
    @sap.quickinfo : 'Catalog Type of Assigned Code Group or Selected Set'
    InspSpecAdditionalCatalog3 : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code group/sel. set'
    @sap.quickinfo : 'Assigned Code Group or Selected Set'
    InspSpecAdditionalSelectedSet3 : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code group/sel. set'
    @sap.quickinfo : 'Assigned Code Group or Selected Set'
    InspSpecAdditionalCodeGroup3 : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.quickinfo : 'Plant of the Assigned Selected Set'
    InspSpecAddlSeldCodeSetPlant3 : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Catalog Type'
    @sap.quickinfo : 'Catalog Type of Assigned Code Group or Selected Set'
    InspSpecAdditionalCatalog4 : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code group/sel. set'
    @sap.quickinfo : 'Assigned Code Group or Selected Set'
    InspSpecAdditionalSelectedSet4 : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code group/sel. set'
    @sap.quickinfo : 'Assigned Code Group or Selected Set'
    InspSpecAdditionalCodeGroup4 : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.quickinfo : 'Plant of the Assigned Selected Set'
    InspSpecAddlSeldCodeSetPlant4 : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Catalog Type'
    @sap.quickinfo : 'Catalog Type of Assigned Code Group or Selected Set'
    InspSpecAdditionalCatalog5 : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code group/sel. set'
    @sap.quickinfo : 'Assigned Code Group or Selected Set'
    InspSpecAdditionalSelectedSet5 : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code group/sel. set'
    @sap.quickinfo : 'Assigned Code Group or Selected Set'
    InspSpecAdditionalCodeGroup5 : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.quickinfo : 'Plant of the Assigned Selected Set'
    InspSpecAddlSeldCodeSetPlant5 : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sampling Procedure'
    @sap.quickinfo : 'Sampling Procedure in Inspection Characteristic'
    SamplingProcedure : String(8);
    @sap.label : 'Sample Unit of Meas.'
    @sap.quickinfo : 'Sample Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    InspCharacteristicSampleUnit : String(3);
    @sap.unit : 'InspCharacteristicSampleUnit'
    @sap.label : 'Base Sample Quantity'
    @sap.quickinfo : 'Sample Quantity Factor for Sample(Mult. Sample Unit of Msr.)'
    BOOCharcSampleQuantity : Decimal(5, 2);
    @sap.label : 'Info Field 1'
    @sap.quickinfo : 'Text Line for Additional Information'
    InspSpecInformationField1 : String(10);
    @sap.label : 'Info Field 2'
    @sap.quickinfo : 'Text Line for Additional Information'
    InspSpecInformationField2 : String(20);
    @sap.label : 'Info Field 3'
    @sap.quickinfo : 'Text Line for Additional Information'
    InspSpecInformationField3 : String(40);
    @sap.label : 'Short Text Charc'
    @sap.quickinfo : 'Short Text for Inspection Characteristic'
    InspectionSpecificationText : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created by'
    @sap.quickinfo : 'User who created record'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'System Date on Which Data Record Was Created'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Name of User Who Last Changed Data Record'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'System Date on Which Data Record Was Changed'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.label : 'Material'
    @sap.quickinfo : 'Material Considered for Dynamic Modification'
    MatlIsConsideredForDynModif : Boolean;
    @sap.label : 'Supplier'
    @sap.quickinfo : 'Supplier Considered for Dynamic Modification'
    SuplrIsConsideredForDynModif : Boolean;
    @sap.label : 'Manufacturer'
    @sap.quickinfo : 'Manufacturer Considered for Dynamic Modification'
    MfrIsConsideredForDynModif : Boolean;
    @sap.label : 'Customer'
    @sap.quickinfo : 'Customer Considered for Dynamic Modification'
    CustIsConsideredForDynModif : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Modification Rule'
    @sap.quickinfo : 'Dynamic Modification Rule'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    InspLotDynamicRule : String(3);
    @sap.display.format : 'NonNegative'
    @sap.label : 'DynMod. as for char.'
    @sap.quickinfo : 'Characteristic (in Plan) whose Q-Level Will Be Copied'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    InspCharcDynModifRef : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'SPC Criterion'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    QltyCtrlChartAggrgnCriterion : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Input Processing'
    @sap.quickinfo : 'Parameters for Input Processing in QM Results Recording'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    InspSpecInputProcedure : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Characteristic Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BOOCharcGroup : String(10);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Source Charc'
    @sap.quickinfo : 'Source Characteristic of Characteristic Group Division'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BOOCharcSourceCharc : String(4);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Internal Division ID'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    BOOCharcGroupDivision : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Routing Version'
    BillOfOperationsVersion : String(4);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ChangedDateTime : DateTime;
    to_Header : Association to many ProductionRoutingHeader {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DelInspCharcsAssgmtViaChgNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Operation Control Profile - Text'
  entity ProductionRoutingOpCtrlPrflTxt {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Control Profile'
    @sap.quickinfo : 'Operation Control Profile'
    key OperationControlProfile : String(4) not null;
    @sap.label : 'Language Key'
    key Language : String(2) not null;
    @sap.label : 'Control Profile Name'
    @sap.quickinfo : 'Operation Control Profile Name'
    OperationControlProfileName : String(40);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Operation Control Profile'
  entity ProductionRoutingOpCtrlPrfl {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Control Profile'
    @sap.quickinfo : 'Operation Control Profile'
    key OperationControlProfile : String(4) not null;
    @sap.label : 'Control Profile Name'
    @sap.quickinfo : 'Operation Control Profile Name'
    OperationControlProfileName : String(40);
    to_Text : Association to many ProductionRoutingOpCtrlPrflTxt {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Document PRT Assignment'
  entity ProductionRoutingDocPRTAssgmt {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence'
    @sap.updatable : 'false'
    key ProductionRoutingSequence : String(6) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Task List Node'
    @sap.quickinfo : 'Number of the Task List Node'
    @sap.updatable : 'false'
    key ProductionRoutingOpIntID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'PRT Item Counter'
    @sap.quickinfo : 'Item Counter for Production Resources/Tools'
    @sap.updatable : 'false'
    key BOOOperationPRTInternalID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.updatable : 'false'
    key BOOOperationPRTIntVersCounter : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Object Type'
    @sap.quickinfo : 'Object types of the CIM resource'
    ProductionResourceType : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Object ID'
    @sap.quickinfo : 'Object ID of the resource'
    ProductionResourceInternalID : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Type'
    @sap.updatable : 'false'
    DocumentType : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document'
    @sap.quickinfo : 'Document number'
    @sap.updatable : 'false'
    DocumentInfoRecord : String(25);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Version'
    @sap.updatable : 'false'
    DocumentVersion : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Part'
    @sap.updatable : 'false'
    DocumentPart : String(3);
    @sap.display.format : 'NonNegative'
    @sap.label : 'PRT Item Number'
    @sap.quickinfo : 'Item Number for Production Resource/Tool'
    ProdnRsceToolItemNumber : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Standard Text Key'
    @sap.quickinfo : 'Standard Text Key for Production Resources/Tools'
    ProdnRsceToolStandardTextCode : String(7);
    @sap.label : 'Text for PRT'
    @sap.quickinfo : 'First Line of Text for Production Resources/Tools'
    ProdnRsceToolText : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'PRT Control Profile'
    @sap.quickinfo : 'Control Profile for Management of Production Resources/Tools'
    ProdnRsceToolControlProfile : String(4);
    @sap.unit : 'ProdnRsceToolStdWorkQtyUnit'
    @sap.label : 'Quantity'
    @sap.quickinfo : 'Standard Value for Quantity of Production Resources/Tools'
    ProdnRsceToolStandardWorkQty : Decimal(9, 3);
    @sap.label : 'Unit for Quantity'
    @sap.quickinfo : 'Unit for Quantity of Production Resources/Tools'
    @sap.semantics : 'unit-of-measure'
    ProdnRsceToolStdWorkQtyUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Quantity Formula'
    @sap.quickinfo : 'Formula for Calculating the Total Quantity of PRT'
    ProdnRsceToolTotQtyCalcFormula : String(6);
    @sap.unit : 'ProdnRsceToolUsageQuantityUnit'
    @sap.label : 'Standard Usage Value'
    @sap.quickinfo : 'Standard Usage Value for Production Resources/Tools'
    ProdnRsceToolUsageQuantity : Decimal(9, 3);
    @sap.label : 'Usage Value Unit'
    @sap.quickinfo : 'Usage Value Unit of the Production Resource/Tool'
    @sap.semantics : 'unit-of-measure'
    ProdnRsceToolUsageQuantityUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Usage Value Formula'
    @sap.quickinfo : 'Formula for Calculating the Total Usage Value of PRT'
    ProdnRsceToolUsageQtyCalcFmla : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    @sap.quickinfo : 'Valid-to date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    ChangedDateTime : DateTime;
    to_Header : Association to many ProductionRoutingHeader {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DeleteDocPRTAssgmtViaChgNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Equipment PRT Assignment'
  entity ProductionRtgEquipPRTAssgmt {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence'
    @sap.updatable : 'false'
    key ProductionRoutingSequence : String(6) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Task List Node'
    @sap.quickinfo : 'Number of the Task List Node'
    @sap.updatable : 'false'
    key ProductionRoutingOpIntID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'PRT Item Counter'
    @sap.quickinfo : 'Item Counter for Production Resources/Tools'
    @sap.updatable : 'false'
    key BOOOperationPRTInternalID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.updatable : 'false'
    key BOOOperationPRTIntVersCounter : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Object Type'
    @sap.quickinfo : 'Object types of the CIM resource'
    ProductionResourceType : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Object ID'
    @sap.quickinfo : 'Object ID of the resource'
    ProductionResourceInternalID : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Equipment'
    @sap.quickinfo : 'Equipment Number'
    @sap.updatable : 'false'
    Equipment : String(18);
    @sap.display.format : 'NonNegative'
    @sap.label : 'PRT Item Number'
    @sap.quickinfo : 'Item Number for Production Resource/Tool'
    ProdnRsceToolItemNumber : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Standard Text Key'
    @sap.quickinfo : 'Standard Text Key for Production Resources/Tools'
    ProdnRsceToolStandardTextCode : String(7);
    @sap.label : 'Text for PRT'
    @sap.quickinfo : 'First Line of Text for Production Resources/Tools'
    ProdnRsceToolText : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'PRT Control Profile'
    @sap.quickinfo : 'Control Profile for Management of Production Resources/Tools'
    ProdnRsceToolControlProfile : String(4);
    @sap.unit : 'ProdnRsceToolStdWorkQtyUnit'
    @sap.label : 'Quantity'
    @sap.quickinfo : 'Standard Value for Quantity of Production Resources/Tools'
    ProdnRsceToolStandardWorkQty : Decimal(9, 3);
    @sap.label : 'Unit for Quantity'
    @sap.quickinfo : 'Unit for Quantity of Production Resources/Tools'
    @sap.semantics : 'unit-of-measure'
    ProdnRsceToolStdWorkQtyUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Quantity Formula'
    @sap.quickinfo : 'Formula for Calculating the Total Quantity of PRT'
    ProdnRsceToolTotQtyCalcFormula : String(6);
    @sap.unit : 'ProdnRsceToolUsageQuantityUnit'
    @sap.label : 'Standard Usage Value'
    @sap.quickinfo : 'Standard Usage Value for Production Resources/Tools'
    ProdnRsceToolUsageQuantity : Decimal(9, 3);
    @sap.label : 'Usage Value Unit'
    @sap.quickinfo : 'Usage Value Unit of the Production Resource/Tool'
    @sap.semantics : 'unit-of-measure'
    ProdnRsceToolUsageQuantityUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Usage Value Formula'
    @sap.quickinfo : 'Formula for Calculating the Total Usage Value of PRT'
    ProdnRsceToolUsageQtyCalcFmla : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    @sap.quickinfo : 'Valid-to date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    ChangedDateTime : DateTime;
    to_Header : Association to many ProductionRoutingHeader {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DeleteEquipPRTAssgmtViaChgNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Material PRT Assignment'
  entity ProductionRoutingMatlPRTAssgmt {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence'
    @sap.updatable : 'false'
    key ProductionRoutingSequence : String(6) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Task List Node'
    @sap.quickinfo : 'Number of the Task List Node'
    @sap.updatable : 'false'
    key ProductionRoutingOpIntID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'PRT Item Counter'
    @sap.quickinfo : 'Item Counter for Production Resources/Tools'
    @sap.updatable : 'false'
    key BOOOperationPRTInternalID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.updatable : 'false'
    key BOOOperationPRTIntVersCounter : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Object Type'
    @sap.quickinfo : 'Object types of the CIM resource'
    ProductionResourceType : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Object ID'
    @sap.quickinfo : 'Object ID of the resource'
    ProductionResourceInternalID : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material'
    @sap.quickinfo : 'Material Number'
    @sap.updatable : 'false'
    Material : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    @sap.updatable : 'false'
    Plant : String(4);
    @sap.display.format : 'NonNegative'
    @sap.label : 'PRT Item Number'
    @sap.quickinfo : 'Item Number for Production Resource/Tool'
    ProdnRsceToolItemNumber : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Standard Text Key'
    @sap.quickinfo : 'Standard Text Key for Production Resources/Tools'
    ProdnRsceToolStandardTextCode : String(7);
    @sap.label : 'Text for PRT'
    @sap.quickinfo : 'First Line of Text for Production Resources/Tools'
    ProdnRsceToolText : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'PRT Control Profile'
    @sap.quickinfo : 'Control Profile for Management of Production Resources/Tools'
    ProdnRsceToolControlProfile : String(4);
    @sap.unit : 'ProdnRsceToolStdWorkQtyUnit'
    @sap.label : 'Quantity'
    @sap.quickinfo : 'Standard Value for Quantity of Production Resources/Tools'
    ProdnRsceToolStandardWorkQty : Decimal(9, 3);
    @sap.label : 'Unit for Quantity'
    @sap.quickinfo : 'Unit for Quantity of Production Resources/Tools'
    @sap.semantics : 'unit-of-measure'
    ProdnRsceToolStdWorkQtyUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Quantity Formula'
    @sap.quickinfo : 'Formula for Calculating the Total Quantity of PRT'
    ProdnRsceToolTotQtyCalcFormula : String(6);
    @sap.unit : 'ProdnRsceToolUsageQuantityUnit'
    @sap.label : 'Standard Usage Value'
    @sap.quickinfo : 'Standard Usage Value for Production Resources/Tools'
    ProdnRsceToolUsageQuantity : Decimal(9, 3);
    @sap.label : 'Usage Value Unit'
    @sap.quickinfo : 'Usage Value Unit of the Production Resource/Tool'
    @sap.semantics : 'unit-of-measure'
    ProdnRsceToolUsageQuantityUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Usage Value Formula'
    @sap.quickinfo : 'Formula for Calculating the Total Usage Value of PRT'
    ProdnRsceToolUsageQtyCalcFmla : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    @sap.quickinfo : 'Valid-to date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    ChangedDateTime : DateTime;
    to_Header : Association to many ProductionRoutingHeader {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DeleteMatlPRTAssgmtViaChgNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Miscellaneous PRT Assignment'
  entity ProductionRoutingMiscPRTAssgmt {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence'
    @sap.updatable : 'false'
    key ProductionRoutingSequence : String(6) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Task List Node'
    @sap.quickinfo : 'Number of the Task List Node'
    @sap.updatable : 'false'
    key ProductionRoutingOpIntID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'PRT Item Counter'
    @sap.quickinfo : 'Item Counter for Production Resources/Tools'
    @sap.updatable : 'false'
    key BOOOperationPRTInternalID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.updatable : 'false'
    key BOOOperationPRTIntVersCounter : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Object Type'
    @sap.quickinfo : 'Object types of the CIM resource'
    ProductionResourceType : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Object ID'
    @sap.quickinfo : 'Object ID of the resource'
    ProductionResourceInternalID : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Miscellaneous PRT'
    @sap.quickinfo : 'Miscellaneous Production Resources and Tools'
    MiscProductionResourceTool : String(18);
    @sap.display.format : 'NonNegative'
    @sap.label : 'PRT Item Number'
    @sap.quickinfo : 'Item Number for Production Resource/Tool'
    ProdnRsceToolItemNumber : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Standard Text Key'
    @sap.quickinfo : 'Standard Text Key for Production Resources/Tools'
    ProdnRsceToolStandardTextCode : String(7);
    @sap.label : 'Text for PRT'
    @sap.quickinfo : 'First Line of Text for Production Resources/Tools'
    ProdnRsceToolText : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'PRT Control Profile'
    @sap.quickinfo : 'Control Profile for Management of Production Resources/Tools'
    ProdnRsceToolControlProfile : String(4);
    @sap.unit : 'ProdnRsceToolStdWorkQtyUnit'
    @sap.label : 'Quantity'
    @sap.quickinfo : 'Standard Value for Quantity of Production Resources/Tools'
    ProdnRsceToolStandardWorkQty : Decimal(9, 3);
    @sap.label : 'Unit for Quantity'
    @sap.quickinfo : 'Unit for Quantity of Production Resources/Tools'
    @sap.semantics : 'unit-of-measure'
    ProdnRsceToolStdWorkQtyUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Quantity Formula'
    @sap.quickinfo : 'Formula for Calculating the Total Quantity of PRT'
    ProdnRsceToolTotQtyCalcFormula : String(6);
    @sap.unit : 'ProdnRsceToolUsageQuantityUnit'
    @sap.label : 'Standard Usage Value'
    @sap.quickinfo : 'Standard Usage Value for Production Resources/Tools'
    ProdnRsceToolUsageQuantity : Decimal(9, 3);
    @sap.label : 'Usage Value Unit'
    @sap.quickinfo : 'Usage Value Unit of the Production Resource/Tool'
    @sap.semantics : 'unit-of-measure'
    ProdnRsceToolUsageQuantityUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Usage Value Formula'
    @sap.quickinfo : 'Formula for Calculating the Total Usage Value of PRT'
    ProdnRsceToolUsageQtyCalcFmla : String(6);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid From'
    @sap.quickinfo : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid to'
    @sap.quickinfo : 'Valid-to date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    ChangedDateTime : DateTime;
    to_Header : Association to many ProductionRoutingHeader {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DeleteMiscPRTAssgmtViaChgNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Production Routing Header'
  entity ProductionRoutingHeader {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingInternalVers : String(8) not null;
    @sap.label : 'Deletion Flag'
    @sap.quickinfo : 'Indicator: Delete completely in reorganization run'
    IsMarkedForDeletion : Boolean;
    @sap.label : 'Description'
    @sap.quickinfo : 'Routing Description'
    BillOfOperationsDesc : String(40);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    Plant : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Usage'
    @sap.quickinfo : 'Task List Usage'
    BillOfOperationsUsage : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Overall Status'
    @sap.quickinfo : 'Status'
    BillOfOperationsStatus : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Planner Group'
    @sap.quickinfo : 'Responsible Planner Group or Department'
    ResponsiblePlannerGroup : String(3);
    @sap.unit : 'BillOfOperationsUnit'
    @sap.label : 'Lot Size From'
    @sap.quickinfo : 'Minimum Lot Size'
    MinimumLotSizeQuantity : Decimal(13, 3);
    @sap.unit : 'BillOfOperationsUnit'
    @sap.label : 'Lot Size To'
    @sap.quickinfo : 'Maximum Lot Size'
    MaximumLotSizeQuantity : Decimal(13, 3);
    @sap.label : 'Task List Unit'
    @sap.quickinfo : 'Task List Unit of Measure'
    @sap.semantics : 'unit-of-measure'
    BillOfOperationsUnit : String(3);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid-To Date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.updatable : 'false'
    ChangeNumber : String(12);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    ChangedDateTime : DateTime;
    @sap.label : 'Long Text'
    PlainLongText : String;
    @sap.label : 'Plant Name'
    PlantName : String(30);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Work Center'
    PlanningWorkCenter : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Old Task List No.'
    @sap.quickinfo : 'Old Number'
    ReplacedBillOfOperations : String(20);
    to_MatlAssgmt : Association to many ProductionRoutingMatlAssgmt {  };
    to_Sequence : Association to many ProductionRoutingSequence {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DeleteHeaderViaChangeNumber(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Status'
  entity ProductionRoutingStatus {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Overall Status'
    @sap.quickinfo : 'Status'
    key BillOfOperationsStatus : String(3) not null;
    @sap.label : 'Status Description'
    @sap.quickinfo : 'Description of the Status'
    BillOfOperationsStatusDesc : String(40);
    to_Text : Association to many ProductionRoutingStatusText {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Status Text'
  entity ProductionRoutingStatusText {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Overall Status'
    @sap.quickinfo : 'Status'
    key BillOfOperationsStatus : String(3) not null;
    @sap.label : 'Language Key'
    key Language : String(2) not null;
    @sap.label : 'Status Description'
    @sap.quickinfo : 'Description of the Status'
    BillOfOperationsStatusDesc : String(40);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Production Routing Sub Operation'
  entity ProductionRoutingSubordOp {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sequence'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingSequence : String(6) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Task List Node'
    @sap.quickinfo : 'Number of the Task List Node'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProductionRoutingOpIntID : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Counter'
    @sap.quickinfo : 'Internal counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key ProdnRtgSubOpIntVersion : String(8) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Superior Op. Node'
    @sap.quickinfo : 'Node Number of the Superior Operation'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    SuperiorOperationInternalID : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Operation or Phase'
    @sap.quickinfo : 'Operation / Phase Number'
    Operation : String(4);
    @sap.label : 'Operation Short Text'
    OperationText : String(40);
    @sap.label : 'Language Key'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LongTextLanguageCode : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Object Type'
    @sap.quickinfo : 'Object types of the CIM resource'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    WorkCenterTypeCode : String(2);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Object ID'
    WorkCenterInternalID : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Plant'
    Plant : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Control Key'
    OperationControlProfile : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Standard Text Key'
    OperationStandardTextCode : String(7);
    @sap.unit : 'OperationUnit'
    @sap.label : 'Base Quantity'
    OperationReferenceQuantity : Decimal(13, 3);
    @sap.label : 'Operation unit'
    @sap.quickinfo : 'Unit of measure for activity'
    @sap.semantics : 'unit-of-measure'
    OperationUnit : String(3);
    @sap.label : 'Numerator'
    @sap.quickinfo : 'Numerator for Converting Routing and Operation UoM'
    OpQtyToBaseQtyNmrtr : Decimal(5, 0);
    @sap.label : 'Denominator'
    @sap.quickinfo : 'Denominator for Converting Routing and Operation UoM'
    OpQtyToBaseQtyDnmntr : Decimal(5, 0);
    @sap.unit : 'StandardWorkQuantityUnit1'
    @sap.label : 'Standard Work Quantity 1'
    StandardWorkQuantity1 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 1'
    @sap.quickinfo : 'Standard Work Quantity Unit 1'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit1 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 1'
    CostCtrActivityType1 : String(6);
    @sap.unit : 'StandardWorkQuantityUnit2'
    @sap.label : 'Standard Work Quantity 2'
    StandardWorkQuantity2 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 2'
    @sap.quickinfo : 'Standard Work Quantity Unit 2'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit2 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 2'
    CostCtrActivityType2 : String(6);
    @sap.unit : 'StandardWorkQuantityUnit3'
    @sap.label : 'Standard Work Quantity 3'
    StandardWorkQuantity3 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 3'
    @sap.quickinfo : 'Standard Work Quantity Unit 3'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit3 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 3'
    CostCtrActivityType3 : String(6);
    @sap.unit : 'StandardWorkQuantityUnit4'
    @sap.label : 'Standard Work Quantity 4'
    StandardWorkQuantity4 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 4'
    @sap.quickinfo : 'Standard Work Quantity Unit 4'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit4 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 4'
    CostCtrActivityType4 : String(6);
    @sap.unit : 'StandardWorkQuantityUnit5'
    @sap.label : 'Standard Work Quantity 5'
    StandardWorkQuantity5 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 5'
    @sap.quickinfo : 'Standard Work Quantity Unit 5'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit5 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 5'
    CostCtrActivityType5 : String(6);
    @sap.unit : 'StandardWorkQuantityUnit6'
    @sap.label : 'Standard Work Quantity 6'
    StandardWorkQuantity6 : Decimal(9, 3);
    @sap.label : 'Work Quantity Unit 6'
    @sap.quickinfo : 'Standard Work Quantity Unit 6'
    @sap.semantics : 'unit-of-measure'
    StandardWorkQuantityUnit6 : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Center Activity Type 6'
    CostCtrActivityType6 : String(6);
    @sap.label : 'No. of Time Tickets'
    @sap.quickinfo : 'Number of Time Tickets'
    NumberOfTimeTickets : Decimal(3, 0);
    @sap.display.format : 'NonNegative'
    @sap.label : 'No. of Conf. Slips'
    @sap.quickinfo : 'Number of Confirmation Slips'
    NumberOfConfirmationSlips : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Operation Costing Relevancy Type'
    OperationCostingRelevancyType : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Business Process'
    BusinessProcess : String(12);
    @sap.label : 'Subcontracting'
    @sap.quickinfo : 'Indicator: External Processing Operation with Subcontracting'
    OpIsExtlyProcdWithSubcontrg : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Inspection Type'
    InspectionLotType : String(8);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purchasing info rec.'
    @sap.quickinfo : 'Number of purchasing info record'
    PurchasingInfoRecord : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purch. Organization'
    @sap.quickinfo : 'Purchasing Organization'
    PurchasingOrganization : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purchasing Document'
    @sap.quickinfo : 'Purchasing Document Number'
    PurchaseContract : String(10);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Item'
    @sap.quickinfo : 'Item Number of Purchasing Document'
    PurchaseContractItem : String(5);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Sort Term'
    @sap.quickinfo : 'Sort Term for Non-Stock Info Records'
    PurchasingInfoRecdAddlGrpgName : String(10);
    @sap.label : 'Planned Deliv. Time'
    @sap.quickinfo : 'Planned Delivery Time in Days'
    PlannedDeliveryDuration : Decimal(3, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Material Group'
    MaterialGroup : String(9);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Purchasing Group'
    @sap.quickinfo : 'Purchasing Group for External Processing Activity'
    PurchasingGroup : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Supplier'
    @sap.quickinfo : 'Account Number of Supplier'
    Supplier : String(10);
    @sap.label : 'Price unit'
    NumberOfOperationPriceUnits : Decimal(5, 0);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Cost Element'
    CostElement : String(10);
    @sap.unit : 'OpExternalProcessingCurrency'
    @sap.variable.scale : 'true'
    @sap.label : 'Net Price'
    @sap.quickinfo : 'Net Price in Purchasing Info Record'
    OpExternalProcessingPrice : Decimal(11, 3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Currency'
    @sap.quickinfo : 'Currency Key'
    @sap.semantics : 'currency-code'
    OpExternalProcessingCurrency : String(5);
    @sap.display.format : 'Date'
    @sap.label : 'Created On'
    @sap.quickinfo : 'Date Record Created On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreationDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Created By'
    @sap.quickinfo : 'Created By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CreatedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Changed On'
    @sap.quickinfo : 'Last Changed On'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangeDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LastChangedByUser : String(12);
    @sap.display.format : 'Date'
    @sap.label : 'Valid-From Date'
    ValidityStartDate : Date;
    @sap.display.format : 'Date'
    @sap.label : 'Valid-To Date'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ValidityEndDate : Date;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    ChangeNumber : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Setup Type Key'
    OperationSetupType : String(2);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Setup group category'
    OperationSetupGroupCategory : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Setup group key'
    OperationSetupGroup : String(10);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Capacity Category'
    CapacityCategoryCode : String(3);
    @sap.label : 'Scrap'
    @sap.quickinfo : 'Scrap factor'
    OperationScrapPercent : Decimal(5, 3);
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ChangedDateTime : DateTime;
    @sap.label : 'Long Text'
    PlainLongText : String;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Work Center'
    WorkCenter : String(8);
    to_Header : Association to many ProductionRoutingHeader {  };
    to_Operation : Association to ProductionRoutingOperation {  };
    to_ProdnRtgTP : Association to ProductionRouting {  };
  } actions {
    action DeleteSubordOpViaChangeNmbr(
      @sap.label : 'Change Number'
      @sap.quickinfo : 'Change Number'
      ChangeNumber : String(12)
    ) returns DummyFunctionImportResult;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Usage'
  entity ProductionRoutingUsage {
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOO Usage'
    @sap.quickinfo : 'Bill of Operations Usage'
    key BillOfOperationsUsage : String(3) not null;
    @sap.label : 'Description'
    BillOfOperationsUsageDesc : String(20);
    to_Text : Association to many ProductionRoutingUsageText {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.creatable : 'false'
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Usage Text'
  entity ProductionRoutingUsageText {
    @sap.display.format : 'UpperCase'
    @sap.label : 'BOO Usage'
    @sap.quickinfo : 'Bill of Operations Usage'
    key BillOfOperationsUsage : String(3) not null;
    @sap.label : 'Language Key'
    key Language : String(2) not null;
    @sap.label : 'Description'
    BillOfOperationsUsageDesc : String(20);
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.updatable : 'false'
  @sap.deletable : 'false'
  @sap.content.version : '3'
  @sap.label : 'Production Routing'
  entity ProductionRouting {
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group'
    @sap.quickinfo : 'Key for Task List Group'
    @sap.updatable : 'false'
    key ProductionRoutingGroup : String(8) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Group Counter'
    @sap.updatable : 'false'
    key ProductionRouting : String(2) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Version Profile'
    BillOfOperationsVersionType : String(1);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Version Profile'
    BillOfOperationsSubtype : String(1);
    @sap.display.format : 'Date'
    @sap.label : 'Last Call'
    @sap.quickinfo : 'Date of the Last Call'
    LastUsageDate : Date;
    @sap.label : 'Number of Calls'
    NumberOfUsages : Decimal(4, 0);
    @sap.label : 'Change no. indicator'
    @sap.quickinfo : 'Task list with change number'
    HasChangeNumber : Boolean;
    @sap.label : 'Param. effect. ind.'
    @sap.quickinfo : 'Task list with parameter effectivity'
    HasParameterEffectivity : Boolean;
    @sap.display.format : 'Date'
    @sap.label : 'Changed on'
    @sap.quickinfo : 'Date of the last change made to the task list'
    LastChangeDate : Date;
    @sap.label : 'Changed at'
    @sap.quickinfo : 'Time of last change made to the task list'
    LastChangeTime : Time;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Changed By'
    @sap.quickinfo : 'Last Changed By User'
    LastChangedByUser : String(12);
    @sap.label : 'Deletion Flag'
    @sap.quickinfo : 'Indicator: Delete completely in reorganization run'
    IsMarkedForDeletion : Boolean;
    @sap.label : 'Rework Routing'
    RoutingIsReworkRouting : Boolean;
    @sap.label : 'Flexible Processing'
    ProdnProcgIsFlexible : Boolean;
    @odata.Type : 'Edm.DateTimeOffset'
    @sap.label : 'Short Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Short Form (YYYYMMDDhhmmss)'
    ChangedDateTime : DateTime;
    to_Header : Composition of many ProductionRoutingHeader {  };
    to_MatlAssgmt : Composition of many ProductionRoutingMatlAssgmt {  };
  };

  @cds.external : true
  type DummyFunctionImportResult {
    @sap.label : 'TRUE'
    IsInvalid : Boolean;
  };

  @cds.external : true
  action SplitCompAllocWithChangeNumber(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Sequence'
    ProductionRoutingSequence : String(6),
    @sap.label : 'Task list node'
    ProductionRoutingOpIntID : String(8),
    @sap.label : 'Allocation no.'
    ProdnRtgOpBOMItemInternalID : String(8),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProductionRoutingCompAlloc;

  @cds.external : true
  action SplitOpWithChangeNumber(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Sequence'
    ProductionRoutingSequence : String(6),
    @sap.label : 'Task List Node'
    ProductionRoutingOpIntID : String(8),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProductionRoutingOperation;

  @cds.external : true
  action SplitSequenceWithChangeNumber(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Sequence'
    ProductionRoutingSequence : String(6),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProductionRoutingSequence;

  @cds.external : true
  action SpltInspCharcsAssgmtWthChgNmbr(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Sequence'
    ProductionRoutingSequence : String(6),
    @sap.label : 'Task List Node'
    ProductionRoutingOpIntID : String(8),
    @sap.label : 'Insp. Characteristic'
    BOOCharacteristic : String(4),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProdnRtgInspCharcsAssgmt;

  @cds.external : true
  action SplitDocPRTAssgmtWthChgNmbr(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Sequence'
    ProductionRoutingSequence : String(6),
    @sap.label : 'Task List Node'
    ProductionRoutingOpIntID : String(8),
    @sap.label : 'PRT Item Counter'
    BOOOperationPRTInternalID : String(8),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProductionRoutingDocPRTAssgmt;

  @cds.external : true
  action SplitEquipPRTAssgmtWthChgNmbr(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Sequence'
    ProductionRoutingSequence : String(6),
    @sap.label : 'Task List Node'
    ProductionRoutingOpIntID : String(8),
    @sap.label : 'PRT Item Counter'
    BOOOperationPRTInternalID : String(8),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProductionRtgEquipPRTAssgmt;

  @cds.external : true
  action SplitMatlPRTAssgmtWthChgNmbr(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Sequence'
    ProductionRoutingSequence : String(6),
    @sap.label : 'Task List Node'
    ProductionRoutingOpIntID : String(8),
    @sap.label : 'PRT Item Counter'
    BOOOperationPRTInternalID : String(8),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProductionRoutingMatlPRTAssgmt;

  @cds.external : true
  action SplitMiscPRTAssgmtWthChgNmbr(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Sequence'
    ProductionRoutingSequence : String(6),
    @sap.label : 'Task List Node'
    ProductionRoutingOpIntID : String(8),
    @sap.label : 'PRT Item Counter'
    BOOOperationPRTInternalID : String(8),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProductionRoutingMiscPRTAssgmt;

  @cds.external : true
  action SplitHeaderWithChangeNumber(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProductionRoutingHeader;

  @cds.external : true
  action SplitSubordOpWithChangeNumber(
    @sap.label : 'Group'
    ProductionRoutingGroup : String(8),
    @sap.label : 'Group Counter'
    ProductionRouting : String(2),
    @sap.label : 'Sequence'
    ProductionRoutingSequence : String(6),
    @sap.label : 'Task List Node'
    ProductionRoutingOpIntID : String(8),
    @sap.label : 'Change Number'
    ChangeNumber : String(12)
  ) returns ProductionRoutingSubordOp;
};


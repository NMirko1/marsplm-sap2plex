using { avvaleplm.marsplm.sap2plex as db } from '../db/schema';

@path : '/products'
service Product {
  @cds.query.limit.max : 0
  entity Products {
    key Product : String(40);
    key Plant : String(4);
    ProductDescription : String(255);
    ProductType : String(4);
    CrossPlantStatus : String(2);
    IsMarkedForDeletion : Boolean;
    ProductGroup : String(9);
    ProductHierarchy : String(18);
    Division : String(2);
    BaseUnit : String(3);
    GrossWeight : Decimal(13, 3);
    WeightUnit : String(3);
    NetWeight : Decimal(13, 3);
    CreationDate : Date;
    PlexPartType : String(30);
    LastSendCounter : Integer;
    LastSendDate : Date;
    LastSendTime : Time;
    LastSendStatus : String(1);
    LastSendMessage : String(255);
  };

  action productDetails(
    products : many String
  ) returns many {
    Product : String(40);
    Plant : String(4);
    PlexPartType : String(30);
    ProductDescription : String(255);
    ProductType : String(4);
    CrossPlantStatus : String(2);
    IsMarkedForDeletion : Boolean;
    ProductGroup : String(9);
    ProductHierarchy : String(18);
    Division : String(2);
    BaseUnit : String(3);
    GrossWeight : Decimal(13, 3);
    WeightUnit : String(3);
    NetWeight : Decimal(13, 3);
    CreationDate : Date;
  };

  type PlantScopeStatus {
    Plant : String(4);
    ReadOk : Boolean;
    Complete : Boolean;
    Reason : String(500);
    Materials : Integer;
    Pages : Integer;
    Ms : Integer;
    Known : Boolean;
    Excluded : Integer;
    ExcludedReason : String(2000);
  };

  function productScope() returns {
    Complete : Boolean;
    Reason : String(2000);
    Excluded : Integer;
    ExcludedReason : String(2000);
    Plants : many PlantScopeStatus;
  };

  action postMaterialDoc() returns {
    enabled : Boolean;
    outcome : String(3);
    warn : Boolean;
    testRun : String(1);
    testRunSource : String(200);
    plants : String(100);
    csrf : Boolean;
    csrfTokenObtained : Boolean;
    destination : String(30);
    path : String(200);
    url : String(300);
    correlationId : String(60);
    itemCount : Integer;
    requestBody : LargeString;
    requestHeaders : LargeString;
    httpStatus : Integer;
    responseHeaders : LargeString;
    responseBody : LargeString;
    materialDocument : String(10);
    materialDocumentYear : String(4);
    messageType : String(1);
    message : String(220);
    messageRow : String(10);
    mplId : String(60);
    reason : String(500);
    error : String(2000);
    ms : Integer;
    sentAt : String(30);
  };
};

@path : '/production-orders'
service ProductionOrder {
  @cds.query.limit.max : 0
  entity ProductionOrders {
    key ManufacturingOrder : String(12);
    OrderInternalBillOfOperations : String(10);
    MasterProductionOrder : String(12);
    ManufacturingOrderType : String(4);
    Material : String(40);
    ProductionPlant : String(4);
    TotalQuantity : Decimal(13, 3);
    ProductionUnit : String(3);
    MfgOrderPlannedStartDate : Date;
    MfgOrderPlannedEndDate : Date;
    MfgOrderCreationDate : Date;
    MfgOrderConfirmedYieldQty : Decimal(13, 3);
    ProductionSupervisor : String(3);
    ProductionVersion : String(4);
    SalesOrder : String(10);
    SalesOrderItem : String(6);
    OrderIsReleased : String(1);
    OrderIsConfirmed : String(1);
    OrderIsClosed : String(1);
    OrderIsDeleted : String(1);
    OrderLongText : String;
    LastSendStatus : String(1);
    LastSendMessage : String(255);
  };

  entity ProductionOrderOperations {
    key OrderInternalBillOfOperations : String(10);
    key OrderIntBillOfOperationsItem : String(8);
    ManufacturingOrder : String(12);
    ManufacturingOrderOperation : String(4);
    ManufacturingOrderSubOperation : String(4);
    MfgOrderOperationText : String(40);
    WorkCenter : String(8);
    ProductionPlant : String(4);
    OpPlannedTotalQuantity : Decimal(13, 3);
    OpTotalConfirmedYieldQty : Decimal(13, 3);
    OperationUnit : String(3);
    OperationIsReleased : String(1);
    OperationIsConfirmed : String(1);
    OperationIsClosed : String(1);
    OperationIsDeleted : String(1);
  };

  entity ProductionOrderComponents {
    key Reservation : String(10);
    key ReservationItem : String(10);
    ManufacturingOrder : String(12);
    ManufacturingOrderOperation : String(4);
    Material : String(40);
    BOMItemDescription : String(40);
    RequiredQuantity : Decimal(13, 3);
    WithdrawnQuantity : Decimal(13, 3);
    BaseUnit : String(3);
    Plant : String(4);
    StorageLocation : String(4);
    Batch : String(10);
    ReservationIsFinallyIssued : Boolean;
    PhantomSource : String(40);
    PhantomPath : String(200);
  };

  entity PlexCycleOperations as projection on db.ZPlexCycleOperation;
  annotate PlexCycleOperations {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Manufacturing Order'
    ManufacturingOrder;
    @title : 'Plex Operation ID'
    PlexOperationId;
    @title : 'Operation Code'
    OperationCode;
    @title : 'Operation Name'
    OperationName;
    @title : 'Sequence Number'
    Sequence;
    @title : 'Linked SAP Operation'
    SAPOperationId;
    @title : 'Plex Operation Number'
    OperationNumber;
    @title : 'Part Operation Type'
    OperationType;
    @title : 'Sub Operation'
    SubOperation;
    @title : 'Shippable'
    Shippable;
    @title : 'Net Weight'
    NetWeight;
    @title : 'Standard Quantity'
    StandardQuantity;
  };

  entity PlexCycleComponents as projection on db.ZPlexCycleComponent;
  annotate PlexCycleComponents {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Manufacturing Order'
    ManufacturingOrder;
    @title : 'Plex Operation ID'
    PlexOperationId;
    @title : 'Material'
    Material;
    @title : 'Required Quantity'
    RequiredQuantity;
    @title : 'Base Unit'
    BaseUnit;
    @title : 'Sequence Number'
    Sequence;
    @title : 'Exploded From Phantom'
    PhantomSource;
    @title : 'Assignment Source'
    AssignmentSource;
  };

  @readonly : true
  entity PlexCycleApprovedWorkcenters as projection on db.ZPlexCycleApprovedWorkcenter;
  annotate PlexCycleApprovedWorkcenters {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Manufacturing Order'
    ManufacturingOrder;
    @title : 'Plex Operation ID'
    PlexOperationId;
    @title : 'Workcenter ID'
    WorkcenterId;
    @title : 'Workcenter Code'
    WorkcenterCode;
    @title : 'Workcenter Name'
    WorkcenterName;
  };

  @readonly : true
  entity PlexCycleRemovedComponents as projection on db.ZProdOrderCompRemoved;
  annotate PlexCycleRemovedComponents {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Manufacturing Order'
    ManufacturingOrder;
    @title : 'Component Material'
    Material;
  };

  action savePlexCycle(
    ManufacturingOrder : String(12),
    Operations : many {
      PlexOperationId : String(36);
      OperationCode : String(30);
      OperationName : String(100);
      SAPOperationId : String(4);
      OperationNumber : Integer;
      OperationType : String(50);
      SubOperation : Boolean;
      Shippable : Boolean;
      NetWeight : Decimal(13, 3);
      StandardQuantity : Decimal(13, 3);
      Components : many {
        Material : String(40);
        RequiredQuantity : Decimal(13, 3);
        BaseUnit : String(3);
        PhantomSource : String(40);
        AssignmentSource : String(10);
      };
      ApprovedWorkcenters : many {
        WorkcenterId : String(36);
        WorkcenterCode : String(50);
        WorkcenterName : String(100);
      };
    },
    RemovedComponents : many {
      Material : String(40);
    }
  ) returns {
    success : Boolean;
    count : Integer;
    removedCount : Integer;
  };

  action autoImportPlexCycle(
    ManufacturingOrder : String(12),
    Persist : Boolean
  ) returns {
    plexRoutingExists : Boolean;
    operations : many {
      PlexOperationId : String(36);
      OperationCode : String(30);
      OperationName : String(100);
      SAPOperationId : String(4);
      OperationNumber : Integer;
      OperationType : String(50);
      SubOperation : Boolean;
      Shippable : Boolean;
      NetWeight : Decimal(13, 3);
      StandardQuantity : Decimal(13, 3);
      Components : many {
        Material : String(40);
        RequiredQuantity : Decimal(13, 3);
        BaseUnit : String(3);
        PhantomSource : String(40);
        AssignmentSource : String(10);
      };
      ApprovedWorkcenters : many {
        WorkcenterId : String(36);
        WorkcenterCode : String(50);
        WorkcenterName : String(100);
      };
    };
    totalCount : Integer;
    linkedCount : Integer;
    unlinkedCount : Integer;
    conflictCount : Integer;
    plexOnlyCount : Integer;
    missingOnPlexCount : Integer;
    reason : String(40);
    message : String;
    modelSource : String(30);
    modelRouting : String(20);
    persisted : Boolean;
    workcenterCount : Integer;
  };

  action autoAssignPlexCycle(
    ManufacturingOrder : String(12)
  ) returns {
    Plant : String(4);
    HeaderMaterial : String(40);
    assignments : many {
      Material : String(40);
      RequiredQuantity : Decimal(13, 3);
      BaseUnit : String(3);
      BOMItemNodeNumber : String(8);
      PhantomSource : String(40);
      ComponentGroup : String(40);
      TargetOperation : String(60);
      TargetOperationName : String(120);
      Source : String(10);
    };
    unassigned : many {
      Material : String(40);
      Reason : String(20);
    };
    counts : {
      total : Integer;
      assigned : Integer;
      unassigned : Integer;
    };
    ClassificationStatus : String(2);
    ClassificationDetail : String(500);
  };

  function prodOrderScope() returns {
    configured : many String(4);
    unconfigured : many String(4);
    rules : String(2000);
  };

  action postProdOrderStatus(
    Full : Boolean
  ) returns many {
    id : String(14);
    what : String(4000);
    call : String(20);
    fm : String(30);
    sheet : String(6);
    method : String(6);
    request : String(900);
    url : String(600);
    requestBody : LargeString;
    requestHeaders : LargeString;
    httpStatus : Integer;
    httpOk : Boolean;
    depth : String(24);
    ok : Boolean;
    alarm : Boolean;
    messageType : String(1);
    messageId : String(20);
    messageNumber : String(3);
    messageText : String(600);
    messageCount : Integer;
    responseShape : String(200);
    functionImports : String(500);
    params : String(500);
    correlationId : String(60);
    mplId : String(60);
    csrf : Boolean;
    csrfTokenObtained : Boolean;
    responseHeaders : LargeString;
    responseBody : LargeString;
    rawSeen : Boolean;
    rawStatus : Integer;
    responseContentType : String(100);
    rawHasD : Boolean;
    rawBody : LargeString;
    reason : String(900);
    error : String(2000);
    ms : Integer;
    enabled : Boolean;
    orderId : String(12);
    orderForced : Boolean;
    orderSource : String(200);
    shape : String(6);
    full : Boolean;
    destination : String(30);
    sentAt : String(30);
  };
};

@path : '/production-routings'
service ProductionRouting {
  @cds.query.limit.max : 0
  entity Routings {
    key ProductionRoutingGroup : String(8);
    key ProductionRouting : String(2);
    key Material : String(40);
    LastChangeDate : Date;
    BillOfOperationsDesc : String(40);
    BillOfOperationsStatus : String(3);
    BillOfOperationsUsage : String(3);
    ResponsiblePlannerGroup : String(3);
    PlanningWorkCenter : String(8);
    Plant : String(4);
    LastSendStatus : String(1);
    LastSendMessage : String(255);
  };

  entity RoutingOperations {
    key ProductionRoutingGroup : String(8);
    key ProductionRoutingSequence : String(6);
    key ProductionRoutingOpIntID : String(8);
    ProductionRouting : String(2);
    Operation : String(4);
    OperationText : String(40);
    Plant : String(4);
    WorkCenterInternalID : String(8);
    OperationControlProfile : String(4);
  };

  entity RoutingComponentAllocations {
    key ProductionRoutingGroup : String(8);
    key ProductionRoutingOpIntID : String(8);
    key ProdnRtgOpBOMItemInternalID : String(20);
    ProductionRouting : String(2);
    ProductionRoutingSequence : String(6);
    BillOfMaterialComponent : String(40);
    BillOfMaterialItemNodeNumber : String(8);
    MatlCompIsMarkedForBackflush : Boolean;
    BillOfMaterialItemQuantity : Decimal(13, 3);
    BillOfMaterialItemUnit : String(3);
    BillOfMaterial : String(8);
    BillOfMaterialCategory : String(1);
    BillOfMaterialVariant : String(2);
    Material : String(40);
    PhantomSource : String(40);
    PhantomPath : String(200);
  };

  entity PlexRoutingCycleOperations as projection on db.ZPlexRoutingCycleOperation;
  annotate PlexRoutingCycleOperations {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Routing Group'
    ProductionRoutingGroup;
    @title : 'Routing Counter'
    ProductionRouting;
    @title : 'Header Material'
    HeaderMaterial;
    @title : 'Plex Operation ID'
    PlexOperationId;
    @title : 'Operation Code'
    OperationCode;
    @title : 'Operation Name'
    OperationName;
    @title : 'Sequence Number'
    Sequence;
    @title : 'Linked SAP Routing Operation'
    SAPOperationId;
    @title : 'SAP Routing Op Internal ID (PLNKN)'
    ProductionRoutingOpIntID;
    @title : 'Plex Operation Number'
    OperationNumber;
    @title : 'Part Operation Type'
    OperationType;
    @title : 'Sub Operation'
    SubOperation;
    @title : 'Shippable'
    Shippable;
    @title : 'Net Weight'
    NetWeight;
    @title : 'Standard Quantity'
    StandardQuantity;
  };

  entity PlexRoutingCycleComponents as projection on db.ZPlexRoutingCycleComponent;
  annotate PlexRoutingCycleComponents {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Routing Group'
    ProductionRoutingGroup;
    @title : 'Routing Counter'
    ProductionRouting;
    @title : 'Header Material'
    HeaderMaterial;
    @title : 'Plex Operation ID'
    PlexOperationId;
    @title : 'Component Material'
    Material;
    @title : 'BOM Item Node Number'
    BOMItemNodeNumber;
    @title : 'Required Quantity'
    RequiredQuantity;
    @title : 'Base Unit'
    BaseUnit;
    @title : 'Sequence Number'
    Sequence;
    @title : 'Exploded From Phantom'
    PhantomSource;
    @title : 'Assignment Source'
    AssignmentSource;
  };

  @readonly : true
  entity PlexRoutingApprovedWorkcenters as projection on db.ZPlexRoutingApprovedWorkcenter;
  annotate PlexRoutingApprovedWorkcenters {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Routing Group'
    ProductionRoutingGroup;
    @title : 'Routing Counter'
    ProductionRouting;
    @title : 'Header Material'
    HeaderMaterial;
    @title : 'Plex Operation ID'
    PlexOperationId;
    @title : 'Workcenter ID'
    WorkcenterId;
    @title : 'Workcenter Code'
    WorkcenterCode;
    @title : 'Workcenter Name'
    WorkcenterName;
  };

  action autoAssignPlexCycle(
    ProductionRoutingGroup : String(8),
    ProductionRouting : String(2),
    Material : String(40),
    Operations : many {
      PlexOperationId : String(36);
      OperationCode : String(30);
      OperationName : String(100);
      ObjectGroups : many {
        GroupId : String(40);
      };
    }
  ) returns {
    Plant : String(4);
    HeaderMaterial : String(40);
    assignments : many {
      Material : String(40);
      RequiredQuantity : Decimal(13, 3);
      BaseUnit : String(3);
      BOMItemNodeNumber : String(8);
      PhantomSource : String(40);
      ComponentGroup : String(40);
      TargetOperation : String(60);
      TargetOperationName : String(120);
      Source : String(10);
    };
    unassigned : many {
      Material : String(40);
      Reason : String(20);
    };
    counts : {
      total : Integer;
      assigned : Integer;
      unassigned : Integer;
    };
    ClassificationStatus : String(2);
    ClassificationDetail : String(500);
  };

  action saveRoutingPlexCycle(
    ProductionRoutingGroup : String(8),
    ProductionRouting : String(2),
    Material : String(40),
    Operations : many {
      PlexOperationId : String(36);
      OperationCode : String(30);
      OperationName : String(100);
      SAPOperationId : String(4);
      ProductionRoutingOpIntID : String(8);
      OperationNumber : Integer;
      OperationType : String(50);
      SubOperation : Boolean;
      Shippable : Boolean;
      NetWeight : Decimal(13, 3);
      StandardQuantity : Decimal(13, 3);
      Components : many {
        Material : String(40);
        BOMItemNodeNumber : String(8);
        RequiredQuantity : Decimal(13, 3);
        BaseUnit : String(3);
        PhantomSource : String(40);
        AssignmentSource : String(10);
      };
      ApprovedWorkcenters : many {
        WorkcenterId : String(36);
        WorkcenterCode : String(50);
        WorkcenterName : String(100);
      };
      ObjectGroups : many {
        GroupId : String(40);
      };
    }
  ) returns {
    success : Boolean;
    count : Integer;
    autoAssignRewritten : Boolean;
    autoAssignRows : Integer;
  };

  action massImportTemplateChunk(
    Plant : String(4),
    Operations : many {
      PlexOperationId : String(36);
      OperationCode : String(30);
      OperationName : String(100);
      OperationNumber : Integer;
      OperationType : String(50);
      SubOperation : Boolean;
      Shippable : Boolean;
      NetWeight : Decimal(13, 3);
      StandardQuantity : Decimal(13, 3);
      ApprovedWorkcenters : many {
        WorkcenterId : String(36);
        WorkcenterCode : String(50);
        WorkcenterName : String(100);
      };
      ObjectGroups : many {
        GroupId : String(40);
      };
    },
    Targets : many {
      ProductionRoutingGroup : String(8);
      ProductionRouting : String(2);
      Material : String(40);
    }
  ) returns {
    results : many {
      ProductionRoutingGroup : String(8);
      ProductionRouting : String(2);
      Material : String(40);
      ok : Boolean;
      message : String(500);
      autoAssignRows : Integer;
    };
    success : Integer;
    errors : Integer;
  };

  action syncRoutingPlexCycle(
    ProductionRoutingGroup : String(8),
    ProductionRouting : String(2),
    Material : String(40),
    AutoAssignMissing : Boolean,
    SendOnlyIfDrift : Boolean
  ) returns {
    success : Boolean;
    deactivatedCount : Integer;
    createdCount : Integer;
    message : String;
    ClassificationStatus : String(2);
    PhantomUnresolved : Integer;
    BomQtyUnresolved : Integer;
    CompSourceMode : String(10);
    CompSourceFellBack : Boolean;
    OpTypeDefaulted : Integer;
    AutodepleteUnverified : Integer;
    WcExcessNotRemoved : Integer;
    WcRemoved : Integer;
    Blocked : Boolean;
    BlockedCount : Integer;
    SecondReadFailed : Boolean;
    NoOp : Boolean;
    VerifyReason : String(20);
    BomMissing : Integer;
    BomQtyDiff : Integer;
    BomExtra : Integer;
    BomRemoteKnown : Boolean;
    messageJson : String;
  };

  action findRoutingTestData() returns many {
    Material : String(40);
    Plant : String(4);
    ManufacturingOrder : String(12);
    ProductionVersion : String(4);
    ProductionRoutingGroup : String(8);
    ProductionRouting : String(2);
    RoutingDescription : String(40);
  };

  function routingListDiag() returns {
    mode : String;
    paths : String;
    headerRows : Integer;
    error : String;
    firstRow : String;
    filterSent : String;
    plantsAllowed : String;
    plantsInData : String;
    testDataFilter : String;
    matlRows : Integer;
    matlError : String;
    matlFirstRow : String;
    matlFilterSent : String;
    matlPlantsInData : String;
    joinStats : String;
    listRows : Integer;
    routingFilterRules : String;
    routingFilterExcluded : String;
  };

  function routingCompSource(
    ProductionRoutingGroup : String(8),
    ProductionRouting : String(2),
    Material : String(40)
  ) returns {
    mode : String;
    plant : String;
    anchor : String;
    target : String;
    fellBack : Boolean;
    reason : String;
    noBom : Boolean;
  };
};

service CatalogService {
  @odata.draft.enabled : true
  @UI.LineItem : [
    { $Type: 'UI.DataField', Label: 'Plant', Value: Plant },
    { $Type: 'UI.DataField', Label: 'Profit Center', Value: ProfitCenter },
    { $Type: 'UI.DataField', Label: 'MRP Type', Value: MRPType },
    {
      $Type: 'UI.DataField',
      Label: 'Procurement Type',
      Value: ProcurementType
    },
    {
      $Type: 'UI.DataField',
      Label: 'Purchasing Group',
      Value: PurchasingGroup
    }
  ]
  @UI.SelectionFields : [ Plant, ProfitCenter, MRPType ]
  @UI.HeaderInfo.TypeName : 'Material Filter Configuration'
  @UI.HeaderInfo.TypeNamePlural : 'Material Filter Configurations'
  @UI.HeaderInfo.Title.Value : Plant
  @UI.HeaderInfo.Description.Value : ProfitCenter
  @UI.FieldGroup#GeneralInfo.$Type : 'UI.FieldGroupType'
  @UI.FieldGroup#GeneralInfo.Label : 'General Information'
  @UI.FieldGroup#GeneralInfo.Data : [
    { $Type: 'UI.DataField', Label: 'Plant', Value: Plant },
    { $Type: 'UI.DataField', Label: 'Profit Center', Value: ProfitCenter },
    { $Type: 'UI.DataField', Label: 'MRP Type', Value: MRPType },
    {
      $Type: 'UI.DataField',
      Label: 'Procurement Type',
      Value: ProcurementType
    },
    {
      $Type: 'UI.DataField',
      Label: 'Purchasing Group',
      Value: PurchasingGroup
    }
  ]
  @UI.FieldGroup#AdminData.$Type : 'UI.FieldGroupType'
  @UI.FieldGroup#AdminData.Label : 'Administrative Data'
  @UI.FieldGroup#AdminData.Data : [
    { $Type: 'UI.DataField', Label: 'Created By', Value: createdBy },
    { $Type: 'UI.DataField', Label: 'Created At', Value: createdAt },
    { $Type: 'UI.DataField', Label: 'Modified By', Value: modifiedBy },
    { $Type: 'UI.DataField', Label: 'Modified At', Value: modifiedAt }
  ]
  @UI.Facets : [
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'GeneralInfoFacet',
      Label: 'General Information',
      Target: '@UI.FieldGroup#GeneralInfo'
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'AdminDataFacet',
      Label: 'Administrative Data',
      Target: '@UI.FieldGroup#AdminData'
    }
  ]
  entity ZMatFilterConfig as projection on db.ZMatFilterConfig;
  annotate ZMatFilterConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @UI.Hidden : true
    @Common.Label : 'ID'
    ID;
    @Common.Label : 'Plant'
    @Common.FieldControl : #Mandatory
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @Common.Label : 'Profit Center'
    @Common.FieldControl : #Optional
    @title : 'Profit Center'
    ProfitCenter;
    @Common.Label : 'MRP Type'
    @Common.FieldControl : #Optional
    @title : 'MRP Type'
    @assert.format : '^[A-Z0-9]{0,2}$'
    MRPType;
    @Common.Label : 'Procurement Type'
    @Common.FieldControl : #Optional
    @title : 'Procurement Type'
    @assert.format : '^[A-Z0-9]?$'
    ProcurementType;
    @Common.Label : 'Purchasing Group'
    @Common.FieldControl : #Optional
    @title : 'Purchasing Group'
    @assert.format : '^[A-Z0-9]{0,3}$'
    PurchasingGroup;
  };

  @odata.draft.enabled : true
  @UI.LineItem : [
    { $Type: 'UI.DataField', Label: 'Plex Part Type', Value: PlexPartType },
    {
      $Type: 'UI.DataField',
      Label: 'Material Type (MTART)',
      Value: MaterialType
    },
    {
      $Type: 'UI.DataField',
      Label: 'Procurement Type (BESKZ)',
      Value: ProcurementType
    },
    {
      $Type: 'UI.DataField',
      Label: 'Special Procurement (SOBSL)',
      Value: SpecialProcurement
    },
    {
      $Type: 'UI.DataField',
      Label: 'Production Supervisor (FEVOR)',
      Value: ProductionSupervisor
    }
  ]
  @UI.SelectionFields : [ PlexPartType, MaterialType, ProcurementType ]
  @UI.HeaderInfo.TypeName : 'Product Type Configuration'
  @UI.HeaderInfo.TypeNamePlural : 'Product Type Configurations'
  @UI.HeaderInfo.Title.Value : PlexPartType
  @UI.HeaderInfo.Description.Value : MaterialType
  @UI.FieldGroup#GeneralInfo.$Type : 'UI.FieldGroupType'
  @UI.FieldGroup#GeneralInfo.Label : 'General Information'
  @UI.FieldGroup#GeneralInfo.Data : [
    { $Type: 'UI.DataField', Label: 'Plex Part Type', Value: PlexPartType },
    {
      $Type: 'UI.DataField',
      Label: 'Material Type (MTART)',
      Value: MaterialType
    },
    {
      $Type: 'UI.DataField',
      Label: 'Procurement Type (BESKZ)',
      Value: ProcurementType
    },
    {
      $Type: 'UI.DataField',
      Label: 'Special Procurement (SOBSL)',
      Value: SpecialProcurement
    },
    {
      $Type: 'UI.DataField',
      Label: 'Production Supervisor (FEVOR)',
      Value: ProductionSupervisor
    }
  ]
  @UI.FieldGroup#AdminData.$Type : 'UI.FieldGroupType'
  @UI.FieldGroup#AdminData.Label : 'Administrative Data'
  @UI.FieldGroup#AdminData.Data : [
    { $Type: 'UI.DataField', Label: 'Created By', Value: createdBy },
    { $Type: 'UI.DataField', Label: 'Created At', Value: createdAt },
    { $Type: 'UI.DataField', Label: 'Modified By', Value: modifiedBy },
    { $Type: 'UI.DataField', Label: 'Modified At', Value: modifiedAt }
  ]
  @UI.Facets : [
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'GeneralInfoFacet',
      Label: 'General Information',
      Target: '@UI.FieldGroup#GeneralInfo'
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'AdminDataFacet',
      Label: 'Administrative Data',
      Target: '@UI.FieldGroup#AdminData'
    }
  ]
  entity ZProdTypeConfig as projection on db.ZProdTypeConfig;
  annotate ZProdTypeConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @UI.Hidden : true
    @Common.Label : 'ID'
    ID;
    @Common.Label : 'Plex Part Type'
    @Common.FieldControl : #Mandatory
    @title : 'Plex Part Type'
    PlexPartType;
    @Common.Label : 'Material Type (MTART)'
    @Common.FieldControl : #Optional
    @title : 'Material Type (MTART)'
    MaterialType;
    @Common.Label : 'Procurement Type (BESKZ)'
    @Common.FieldControl : #Optional
    @title : 'Procurement Type (BESKZ)'
    ProcurementType;
    @Common.Label : 'Special Procurement (SOBSL)'
    @Common.FieldControl : #Optional
    @title : 'Special Procurement (SOBSL)'
    SpecialProcurement;
    @Common.Label : 'Production Supervisor (FEVOR)'
    @Common.FieldControl : #Optional
    @title : 'Production Supervisor (FEVOR)'
    ProductionSupervisor;
  };

  @assert.unique.plant : [ Plant ]
  entity ZPlexConnConfig as projection on db.ZPlexConnConfig;
  annotate ZPlexConnConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Plex Connect Base URL'
    BaseUrl;
    @title : 'Consumer Key'
    @PersonalData.IsPotentiallySecret : true
    ConsumerKey;
    @title : 'Plex Data Source Base URL'
    DataSourceUrl;
    @title : 'Data Source User'
    DataSourceUser;
    @title : 'Data Source Password'
    @PersonalData.IsPotentiallySecret : true
    DataSourcePassword;
    @title : 'Last Tested'
    LastTestedAt;
    @title : 'Last Test Status'
    LastTestStatus;
    @title : 'Last Test Message'
    LastTestMessage;
  };

  @odata.draft.enabled : true
  @UI.LineItem : [
    { $Type: 'UI.DataField', Label: 'Plant', Value: Plant },
    { $Type: 'UI.DataField', Label: 'Group ID', Value: GroupId },
    { $Type: 'UI.DataField', Label: 'Description', Value: Description }
  ]
  @UI.SelectionFields : [ Plant, GroupId ]
  @UI.HeaderInfo.TypeName : 'Object Group'
  @UI.HeaderInfo.TypeNamePlural : 'Object Groups'
  @UI.HeaderInfo.Title.Value : GroupId
  @UI.HeaderInfo.Description.Value : Plant
  @UI.FieldGroup#GeneralInfo.$Type : 'UI.FieldGroupType'
  @UI.FieldGroup#GeneralInfo.Label : 'General Information'
  @UI.FieldGroup#GeneralInfo.Data : [
    { $Type: 'UI.DataField', Label: 'Plant', Value: Plant },
    { $Type: 'UI.DataField', Label: 'Group ID', Value: GroupId },
    { $Type: 'UI.DataField', Label: 'Description', Value: Description }
  ]
  @UI.Facets : [
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'GeneralInfoFacet',
      Label: 'General Information',
      Target: '@UI.FieldGroup#GeneralInfo'
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'FieldsFacet',
      Label: 'Field Conditions',
      Target: 'Fields/@UI.LineItem'
    }
  ]
  @assert.unique.plantGroup : [ Plant, GroupId ]
  entity ZObjectGroup as projection on db.ZObjectGroup;
  annotate ZObjectGroup {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @UI.Hidden : true
    @Common.Label : 'ID'
    ID;
    @Common.Label : 'Plant'
    @Common.FieldControl : #Mandatory
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @Common.Label : 'Group ID'
    @Common.FieldControl : #Mandatory
    @title : 'Group ID'
    GroupId;
    @Common.Label : 'Description'
    @Common.FieldControl : #Optional
    @title : 'Description'
    Description;
  };

  @readonly : true
  entity ZMatPlantFieldVH as projection on db.ZMatPlantFieldVH;
  annotate ZMatPlantFieldVH {
    @Common.Text : Label
    @Common.TextArrangement : #TextFirst
    @title : 'Field Name'
    FieldName;
    @title : 'Label'
    Label;
  };

  @assert.unique.matGroup : [ Plant, Material, ComponentGroup ]
  entity ZCycleAutoAssignConfig as projection on db.ZCycleAutoAssignConfig;
  annotate ZCycleAutoAssignConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Material'
    Material;
    @title : 'Group'
    ComponentGroup;
    @title : 'Plex Operation'
    PlexOperation;
    @title : 'Plex Operation Name'
    PlexOperationName;
  };

  @assert.unique.plantUom : [ Plant, BaseUnit ]
  entity ZMatRecvOpConfig as projection on db.ZMatRecvOpConfig;
  annotate ZMatRecvOpConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Base Unit (MEINS)'
    BaseUnit;
    @title : 'Plex Operation Id'
    PlexOperationId;
    @title : 'Plex Operation Code'
    PlexOperationCode;
    @title : 'Plex Operation Name'
    PlexOperationName;
    @title : 'Operation Number'
    OperationNumber;
    @title : 'Shippable'
    Shippable;
    @title : 'Active'
    IsActive;
  };

  @assert.unique.plantType : [ Plant, PlexTypeValue ]
  entity ZPlexPartTypeCode as projection on db.ZPlexPartTypeCode;
  annotate ZPlexPartTypeCode {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Plex Type Value'
    PlexTypeValue;
    @title : 'Plex Type Code'
    PlexTypeCode;
    @title : 'Active'
    IsActive;
  };

  @assert.unique.plant : [ Plant ]
  entity ZPlexPartStatusConfig as projection on db.ZPlexPartStatusConfig;
  annotate ZPlexPartStatusConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Plex Status Code'
    PlexStatusCode;
    @title : 'Plex Status Label'
    PlexStatusLabel;
    @title : 'Active'
    IsActive;
  };

  @readonly : true
  entity ZPlexPartTypeVH as projection on db.ZPlexPartTypeVH;
  annotate ZPlexPartTypeVH {
    @title : 'Plex Part Type'
    PartType;
    @title : 'Label'
    Label;
    @title : 'Plex Type Value'
    PlexValue;
    @title : 'Semifinished'
    IsSemifinished;
    @title : 'Produced in Plex'
    IsProducedInPlex;
    @title : 'Requires Receiving Operation'
    RequiresReceivingOp;
  };

  entity ZPlant as projection on db.ZPlant;
  annotate ZPlant {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    PlantCode;
    @title : 'Plant Name'
    PlantName;
    @title : 'Status'
    Status;
    @title : 'Max Confirmation Retry (empty = unlimited)'
    MaxRetryAttempts;
    @title : 'Auto-assign BOM components on Plex sync'
    AutoAssignBomOnSync;
    @title : 'Enable real goods movement posting (unticked = test run)'
    MatDocPostEnabled;
  };

  @assert.unique.plant : [ Plant ]
  entity ZPlexJobSortConfig as projection on db.ZPlexJobSortConfig;
  annotate ZPlexJobSortConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Job Sort Enabled'
    IsEnabled;
    @title : 'Sort By SAP Due Date'
    DueDateSort;
    @title : 'Frozen Job Statuses (comma separated)'
    FrozenJobStatusList;
  };

  @assert.unique.plantRule : [ Plant, BillOfOperationsStatus, BillOfOperationsUsage ]
  entity ZRoutingFilterConfig as projection on db.ZRoutingFilterConfig;
  annotate ZRoutingFilterConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Routing Status'
    BillOfOperationsStatus;
    @title : 'Routing Usage'
    BillOfOperationsUsage;
    @title : 'Active'
    IsActive;
  };

  @assert.unique.plant : [ Plant ]
  entity ZProdOrderFilterConfig as projection on db.ZProdOrderFilterConfig;
  annotate ZProdOrderFilterConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Required Statuses (semicolon separated)'
    RequiredStatuses;
    @title : 'Excluded Statuses (semicolon separated)'
    ExcludedStatuses;
    @title : 'Order Types (semicolon separated)'
    OrderTypes;
    @title : 'Production Supervisors (semicolon separated)'
    ProductionSupervisors;
  };

  @assert.unique.plant : [ Plant ]
  entity ZProdOrderTecoConfig as projection on db.ZProdOrderTecoConfig;
  annotate ZProdOrderTecoConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Close Plex Job On TECO'
    IsEnabled;
    @title : 'TECO Trigger Statuses (semicolon separated)'
    TriggerStatuses;
  };

  @assert.unique.plant : [ Plant ]
  entity ZProdOrderCompleteConfig as projection on db.ZProdOrderCompleteConfig;
  annotate ZProdOrderCompleteConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Set SAP User Status On Plex Complete'
    IsEnabled;
    @title : 'Plex Job Statuses That Mean Complete (semicolon separated)'
    PlexStatuses;
  };

  @assert.unique.plant : [ Plant ]
  entity ZProdOrderScheduledConfig as projection on db.ZProdOrderScheduledConfig;
  annotate ZProdOrderScheduledConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Set SAP User Status On Plex Scheduled'
    IsEnabled;
    @title : 'Plex Job Statuses That Mean Scheduled (semicolon separated)'
    PlexStatuses;
  };

  @assert.unique.plant : [ Plant ]
  entity ZPhantomExplodeConfig as projection on db.ZPhantomExplodeConfig;
  annotate ZPhantomExplodeConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Max Explosion Depth'
    MaxDepth;
    @title : 'BOM Usage (STLAN)'
    BomUsage;
    @title : 'BOM Alternative (STLAL)'
    BomVariant;
    @title : 'Effectivity Date Mode'
    EffectivityDateMode;
    @title : 'Routing BOM Key Date'
    RoutingBomKeyDate;
    @title : 'Explode In Routing Components'
    ExplodeInRouting;
    @title : 'Explode In Prod Order Components'
    ExplodeInProdOrder;
    @title : 'Routing Components From BOM'
    RoutingCompDefaultOp;
    @title : 'Default Routing Operation'
    RoutingCompDefaultOpTarget;
  };

  @assert.unique.plant : [ Plant ]
  entity ZProdConfPostingConfig as projection on db.ZProdConfPostingConfig;
  annotate ZProdConfPostingConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Production Posting Channel'
    ProdPosting;
    @title : 'Order Confirmation Posting Enabled'
    ConfPostEnabled;
    @title : 'Component Consumption Point'
    ConsumeAt;
    @title : 'Scrap Component Consumption'
    ScrapConsume;
    @title : 'Scrap Component Movement'
    ScrapMove;
    @title : 'Scrap Goods Issue'
    ScrapIssue;
    @title : 'Scrap Without Job'
    ScrapNoOrder;
    @title : 'Scrap Storage Location (LGORT_FROM)'
    ScrapStorLoc;
    @title : 'Goods Movement Reason (MOVE_REAS)'
    ScrapReason;
    @title : 'Material Document Header Text'
    ScrapHeadTxt;
    @title : 'Item Text for Scrap Without Job'
    ScrapLateTxt;
  };

  function prodOrderStatusCatalog() returns many {
    code : String(40);
    contracted : Boolean;
  };

  @assert.unique.plantJobEmail : [ Plant, JobCode, Email ]
  entity ZJobNotifyRecipient as projection on db.ZJobNotifyRecipient;
  annotate ZJobNotifyRecipient {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Job'
    JobCode;
    @title : 'Email'
    @PersonalData.IsPotentiallyPersonal : true
    Email;
    @title : 'When To Notify'
    NotifyMode;
    @title : 'Active'
    IsActive;
  };

  action deletePlant(
    PlantCode : String(4)
  ) returns {
    success : Boolean;
    deleted : Integer;
  };

  @odata.draft.enabled : true
  @UI.LineItem : [ { $Type: 'UI.DataField', Label: 'API Key', Value: ApiKey } ]
  @UI.HeaderInfo.TypeName : 'License'
  @UI.HeaderInfo.TypeNamePlural : 'Licenses'
  @UI.HeaderInfo.Title.Value : ApiKey
  @UI.FieldGroup#GeneralInfo.$Type : 'UI.FieldGroupType'
  @UI.FieldGroup#GeneralInfo.Label : 'License'
  @UI.FieldGroup#GeneralInfo.Data : [ { $Type: 'UI.DataField', Label: 'API Key', Value: ApiKey } ]
  @UI.FieldGroup#AdminData.$Type : 'UI.FieldGroupType'
  @UI.FieldGroup#AdminData.Label : 'Administrative Data'
  @UI.FieldGroup#AdminData.Data : [
    { $Type: 'UI.DataField', Label: 'Created By', Value: createdBy },
    { $Type: 'UI.DataField', Label: 'Created At', Value: createdAt },
    { $Type: 'UI.DataField', Label: 'Modified By', Value: modifiedBy },
    { $Type: 'UI.DataField', Label: 'Modified At', Value: modifiedAt }
  ]
  @UI.Facets : [
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'GeneralInfoFacet',
      Label: 'License',
      Target: '@UI.FieldGroup#GeneralInfo'
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'AdminDataFacet',
      Label: 'Administrative Data',
      Target: '@UI.FieldGroup#AdminData'
    }
  ]
  entity ZLicenseConfig as projection on db.ZLicenseConfig;
  annotate ZLicenseConfig {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @UI.Hidden : true
    @Common.Label : 'ID'
    ID;
    @Common.Label : 'API Key'
    @Common.FieldControl : #Mandatory
    @UI.MultiLineText : true
    @title : 'API Key'
    @PersonalData.IsPotentiallySecret : true
    ApiKey;
  };

  function getUserRole(
    plant : String(4)
  ) returns String;

  function ping() returns String;

  type UsablePlant {
    Plant : String(4);
    Name : String(100);
    Verdict : String(20);
    RoleKnown : Boolean;
    Role : String(20);
  };

  function usablePlants() returns {
    Plants : many UsablePlant;
    Total : Integer;
    Granted : Integer;
    RoleReadOk : Boolean;
    Reason : String(2000);
    Gates : String(200);
    Excluded : many UsablePlant;
  };

  function isChannelDiag() returns many {
    area : String(10);
    mode : String(10);
    origin : String(20);
    originDetail : String(60);
    envVar : String(30);
    destination : String(30);
    roots : String(2000);
    probeEntity : String(60);
    probeRows : Integer;
    probeDropped : Integer;
    probeMs : Integer;
    error : String(500);
  };

  function isCallLog(
    sinceSeq : Integer,
    limit : Integer
  ) returns many {
    seq : Integer;
    at : String(30);
    instance : String(5);
    area : String(10);
    entity : String(60);
    op : String(10);
    derivedOp : String(10);
    mode : String(10);
    destination : String(30);
    root : String(300);
    form : String(40);
    calls : Integer;
    rows : Integer;
    ms : Integer;
    outcome : String(2);
    criteria : String(500);
    columns : String(1000);
    top : Integer;
    urls : String(6000);
    request : String(1000);
    headers : String(1000);
    notes : String(1000);
    error : String(1000);
    upstreamStatus : Integer;
    responseBody : String(2000);
    firstRow : String(500);
    rawSeen : Boolean;
    rawStatus : Integer;
    responseContentType : String(100);
    rawHasD : Boolean;
    rawBody : String(8000);
  };

  action isCallLogReset() returns {
    cleared : Boolean;
    message : String(200);
  };

  @cds.autoexposed : true
  @UI.LineItem : [
    { $Type: 'UI.DataField', Label: 'Condition Type', Value: ConditionType },
    { $Type: 'UI.DataField', Label: 'Field Name', Value: FieldName },
    { $Type: 'UI.DataField', Label: 'Field Value', Value: FieldValue },
    { $Type: 'UI.DataField', Label: 'Class', Value: Class },
    { $Type: 'UI.DataField', Label: 'Characteristic', Value: Characteristic },
    {
      $Type: 'UI.DataField',
      Label: 'Characteristic Value',
      Value: CharcValue
    }
  ]
  entity ZObjectGroupField as projection on db.ZObjectGroupField;
  annotate ZObjectGroupField {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @UI.Hidden : true
    @Common.Label : 'ID'
    ID;
    @Common.Label : 'Condition Type'
    @title : 'Condition Type'
    ConditionType;
    @Common.Label : 'Field Name'
    @Common.FieldControl.$edmJson.$If : [ { $Eq: [ { $Path: 'ConditionType' }, 'CLASS' ] }, 0, 7 ]
    @Common.ValueListWithFixedValues : true
    @Common.ValueList.$Type : 'Common.ValueListType'
    @Common.ValueList.CollectionPath : 'ZMatPlantFieldVH'
    @Common.ValueList.Parameters : [
      {
        $Type: 'Common.ValueListParameterInOut',
        LocalDataProperty: FieldName,
        ValueListProperty: 'FieldName'
      },
      {
        $Type: 'Common.ValueListParameterDisplayOnly',
        ValueListProperty: 'Label'
      }
    ]
    @title : 'Field Name'
    FieldName;
    @Common.Label : 'Field Value'
    @Common.FieldControl.$edmJson.$If : [ { $Eq: [ { $Path: 'ConditionType' }, 'CLASS' ] }, 0, 3 ]
    @title : 'Field Value'
    FieldValue;
    @Common.Label : 'Class'
    @Common.FieldControl.$edmJson.$If : [ { $Eq: [ { $Path: 'ConditionType' }, 'CLASS' ] }, 3, 0 ]
    @title : 'Class'
    Class;
    @Common.Label : 'Characteristic'
    @Common.FieldControl.$edmJson.$If : [ { $Eq: [ { $Path: 'ConditionType' }, 'CLASS' ] }, 3, 0 ]
    @title : 'Characteristic'
    Characteristic;
    @Common.Label : 'Characteristic Value'
    @Common.FieldControl.$edmJson.$If : [ { $Eq: [ { $Path: 'ConditionType' }, 'CLASS' ] }, 3, 0 ]
    @title : 'Characteristic Value'
    CharcValue;
  };
};

@path : '/objgroup-edit'
service ObjGroupEditService {
  @assert.unique.plantGroup : [ Plant, GroupId ]
  entity ObjectGroups as projection on db.ZObjectGroup;
  annotate ObjectGroups {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Group ID'
    GroupId;
    @title : 'Description'
    Description;
  };

  entity ObjectGroupFields as projection on db.ZObjectGroupField;
  annotate ObjectGroupFields {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Condition Type'
    ConditionType;
    @title : 'Field Name'
    FieldName;
    @title : 'Field Value'
    FieldValue;
    @title : 'Class'
    Class;
    @title : 'Characteristic'
    Characteristic;
    @title : 'Characteristic Value'
    CharcValue;
  };

  @readonly : true
  entity MatPlantFieldVH as projection on db.ZMatPlantFieldVH;
  annotate MatPlantFieldVH {
    @title : 'Field Name'
    FieldName;
    @title : 'Label'
    Label;
  };
};

@path : '/plex-fieldmap'
service PlexFieldMapService {
  @assert.unique.plantField : [ Plant, PlexField ]
  entity ZPlexFieldMap as projection on db.ZPlexFieldMap;
  annotate ZPlexFieldMap {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Plex Field'
    PlexField;
    @title : 'Mapping Kind'
    MappingKind;
    @title : 'Fixed Value'
    FixedValue;
    @title : 'SAP Field'
    SapField;
  };

  entity ZPlexFieldMapRule as projection on db.ZPlexFieldMapRule;
  annotate ZPlexFieldMapRule {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Sequence'
    Sequence;
    @title : 'Output Value'
    OutputValue;
  };

  entity ZPlexFieldMapRuleCond as projection on db.ZPlexFieldMapRuleCond;
  annotate ZPlexFieldMapRuleCond {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'SAP Field'
    SapField;
    @title : 'Operator'
    Operator;
    @title : 'Value'
    Value;
  };

  @readonly : true
  entity MatFieldVH as projection on db.ZMatFieldVH;
  annotate MatFieldVH {
    @title : 'Field Name'
    FieldName;
    @title : 'Label'
    Label;
  };
};

@path : '/plex-opfieldmap'
service PlexOpFieldMapService {
  @assert.unique.plantField : [ Plant, PlexField ]
  entity ZPlexOpFieldMap as projection on db.ZPlexOpFieldMap;
  annotate ZPlexOpFieldMap {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Plex Field'
    PlexField;
    @title : 'Mapping Kind'
    MappingKind;
    @title : 'Fixed Value'
    FixedValue;
    @title : 'SAP Field'
    SapField;
  };

  entity ZPlexOpFieldMapRule as projection on db.ZPlexOpFieldMapRule;
  annotate ZPlexOpFieldMapRule {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Sequence'
    Sequence;
    @title : 'Output Value'
    OutputValue;
  };

  entity ZPlexOpFieldMapRuleCond as projection on db.ZPlexOpFieldMapRuleCond;
  annotate ZPlexOpFieldMapRuleCond {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'SAP Field'
    SapField;
    @title : 'Operator'
    Operator;
    @title : 'Value'
    Value;
  };

  @assert.unique.plantScope : [ Plant, Scope ]
  entity ZPlexOpTypeFilter as projection on db.ZPlexOpTypeFilter;
  annotate ZPlexOpTypeFilter {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Scope'
    Scope;
    @title : 'Plex Operation Types (comma separated)'
    OpTypes;
  };

  @readonly : true
  entity OpFieldVH as projection on db.ZOpFieldVH;
  annotate OpFieldVH {
    @title : 'Field Name'
    FieldName;
    @title : 'Label'
    Label;
  };
};

@path : '/mat-category'
service MatCategoryService {
  @assert.unique.plantCat : [ Plant, CategoryName ]
  entity MaterialCategories as projection on db.ZMatCategory;
  annotate MaterialCategories {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Category Name'
    CategoryName;
    @title : 'Plex Part Type'
    PlexPartType;
    @title : 'Sequence'
    Sequence;
    @title : 'Active'
    IsActive;
    @title : 'Catch-all (all remaining materials)'
    IsCatchAll;
  };

  entity CategoryConditions as projection on db.ZMatCategoryCond;
  annotate CategoryConditions {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'SAP Field'
    SapField;
    @title : 'Operator'
    Operator;
    @title : 'Value'
    Value;
  };

  @readonly : true
  entity MatFieldVH as projection on db.ZMatFieldVH;
  annotate MatFieldVH {
    @title : 'Field Name'
    FieldName;
    @title : 'Label'
    Label;
  };

  @readonly : true
  entity PlexPartTypeVH as projection on db.ZPlexPartTypeVH;
  annotate PlexPartTypeVH {
    @title : 'Plex Part Type'
    PartType;
    @title : 'Label'
    Label;
    @title : 'Plex Type Value'
    PlexValue;
    @title : 'Semifinished'
    IsSemifinished;
    @title : 'Produced in Plex'
    IsProducedInPlex;
    @title : 'Requires Receiving Operation'
    RequiresReceivingOp;
  };

  function matCategoryFieldAvailability(
    Plant : String(4)
  ) returns {
    channel : String(10);
    unavailableFields : many String;
    affectedCategories : many {
      CategoryName : String(60);
      Conditions : many String;
    };
  };
};

@path : '/ordercomp-excl'
service OrderCompExclService {
  @assert.unique.plantRule : [ Plant, RuleName ]
  entity CompExclRules as projection on db.ZOrderCompExclRule;
  annotate CompExclRules {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Rule Name'
    RuleName;
    @title : 'Sequence'
    Sequence;
    @title : 'Active'
    IsActive;
  };

  entity CompExclConditions as projection on db.ZOrderCompExclCond;
  annotate CompExclConditions {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'SAP Field'
    SapField;
    @title : 'Operator'
    Operator;
    @title : 'Value'
    Value;
  };

  @readonly : true
  entity CompFieldVH as projection on db.ZOrderCompFieldVH;
  annotate CompFieldVH {
    @title : 'Field Name'
    FieldName;
    @title : 'Label'
    Label;
    @title : 'Source'
    Source;
  };
};

@path : '/routing-templates'
service RoutingTemplate {
  @assert.unique.plantCode : [ Plant, TemplateCode ]
  entity RoutingTemplates as projection on db.ZPlexRoutingTemplate;
  annotate RoutingTemplates {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Plant'
    Plant;
    @title : 'Template Code'
    TemplateCode;
    @title : 'Description'
    Description;
  };

  entity RoutingTemplateOperations as projection on db.ZPlexRoutingTemplateOperation;
  annotate RoutingTemplateOperations {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Template ID'
    TemplateID;
    @title : 'Plex Operation ID'
    PlexOperationId;
    @title : 'Operation Code'
    OperationCode;
    @title : 'Operation Name'
    OperationName;
    @title : 'Sequence Number'
    Sequence;
    @title : 'Plex Operation Number'
    OperationNumber;
    @title : 'Part Operation Type'
    OperationType;
    @title : 'Sub Operation'
    SubOperation;
    @title : 'Shippable'
    Shippable;
    @title : 'Net Weight'
    NetWeight;
    @title : 'Standard Quantity'
    StandardQuantity;
  };

  @readonly : true
  entity RoutingTemplateWorkcenters as projection on db.ZPlexRoutingTemplateWorkcenter;
  annotate RoutingTemplateWorkcenters {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Template ID'
    TemplateID;
    @title : 'Plex Operation ID'
    PlexOperationId;
    @title : 'Workcenter ID'
    WorkcenterId;
    @title : 'Workcenter Code'
    WorkcenterCode;
    @title : 'Workcenter Name'
    WorkcenterName;
  };

  @readonly : true
  entity RoutingTemplateGroups as projection on db.ZPlexRoutingTemplateGroup;
  annotate RoutingTemplateGroups {
    @cds.on.insert : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedAt}'
    @readonly : true
    createdAt;
    @cds.on.insert : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @Core.Immutable : true
    @title : '{i18n>CreatedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    createdBy;
    @cds.on.insert : $now
    @cds.on.update : $now
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedAt}'
    @readonly : true
    modifiedAt;
    @cds.on.insert : $user
    @cds.on.update : $user
    @UI.HiddenFilter : true
    @UI.ExcludeFromNavigationContext : true
    @title : '{i18n>ChangedBy}'
    @readonly : true
    @description : '{i18n>UserID.Description}'
    modifiedBy;
    @title : 'Template ID'
    TemplateID;
    @title : 'Plex Operation ID'
    PlexOperationId;
    @title : 'Object Group ID'
    GroupId;
  };

  @readonly : true
  @assert.unique.plantGroup : [ Plant, GroupId ]
  entity ObjectGroupVH as projection on db.ZObjectGroup {
    ID,
    Plant,
    GroupId,
    Description
  };
  annotate ObjectGroupVH {
    @title : 'Plant'
    @assert.format : '^[A-Z0-9]{1,4}$'
    Plant;
    @title : 'Group ID'
    GroupId;
    @title : 'Description'
    Description;
  };

  action getNextTemplateCode(
    Plant : String(4)
  ) returns {
    code : String(20);
  };

  action saveRoutingTemplate(
    ID : UUID,
    Plant : String(4),
    TemplateCode : String(20),
    Description : String(255),
    Operations : many {
      PlexOperationId : String(36);
      OperationCode : String(30);
      OperationName : String(100);
      Sequence : Integer;
      OperationNumber : Integer;
      OperationType : String(50);
      SubOperation : Boolean;
      Shippable : Boolean;
      NetWeight : Decimal(13, 3);
      StandardQuantity : Decimal(13, 3);
      ApprovedWorkcenters : many {
        WorkcenterId : String(36);
        WorkcenterCode : String(50);
        WorkcenterName : String(100);
      };
      ObjectGroups : many {
        GroupId : String(40);
      };
    }
  ) returns {
    success : Boolean;
    ID : UUID;
    TemplateCode : String(20);
    count : Integer;
  };

  action deleteRoutingTemplate(
    ID : UUID
  ) returns {
    success : Boolean;
  };
};

service LogService {
  @readonly : true
  entity ZMatExcLogHDR as projection on db.ZMatExcLogHDR;
  annotate ZMatExcLogHDR {
    @title : 'Product Number'
    Product;
    @title : 'Production Plant'
    Plant;
    @title : 'Send Counter'
    Counter;
    @title : 'Send Date'
    SentDate;
    @title : 'Send Time'
    SentTime;
    @title : 'Status'
    @assert.enum : true
    @assert.values : [ 'S', 'E', 'W' ]
    Status;
    @title : 'Status Message'
    Message;
    @title : 'Structured Message (i18n codes)'
    MessageJson;
  };

  @readonly : true
  entity ZMatExcLogPOS as projection on db.ZMatExcLogPOS;
  annotate ZMatExcLogPOS {
    @title : 'Product Number'
    Product;
    @title : 'Production Plant'
    Plant;
    @title : 'Send Counter'
    Counter;
    @title : 'Send Date'
    SentDate;
    @title : 'Send Time'
    SentTime;
    @title : 'Status'
    @assert.enum : true
    @assert.values : [ 'S', 'E', 'W' ]
    Status;
    @title : 'Status Message'
    Message;
    @title : 'Structured Message (i18n codes)'
    MessageJson;
    @title : 'Request JSON Sent to Plex'
    RequestJson;
    @title : 'Response JSON from Plex'
    ResponseJson;
    @title : 'HTTP Response Status Code'
    ResponseStatus;
  };

  @readonly : true
  entity ZRoutingExcLogHDR as projection on db.ZRoutingExcLogHDR;
  annotate ZRoutingExcLogHDR {
    @title : 'Routing Group'
    ProductionRoutingGroup;
    @title : 'Routing Counter'
    ProductionRouting;
    @title : 'Header Material'
    Material;
    @title : 'Send Counter'
    Counter;
    @title : 'Send Date'
    SentDate;
    @title : 'Send Time'
    SentTime;
    @title : 'Status'
    Status;
    @title : 'Status Message'
    Message;
    @title : 'Structured Message (i18n codes)'
    MessageJson;
  };

  @readonly : true
  entity ZRoutingExcLogPOS as projection on db.ZRoutingExcLogPOS;
  annotate ZRoutingExcLogPOS {
    @title : 'Routing Group'
    ProductionRoutingGroup;
    @title : 'Routing Counter'
    ProductionRouting;
    @title : 'Header Material'
    Material;
    @title : 'Send Counter'
    Counter;
    @title : 'Send Date'
    SentDate;
    @title : 'Send Time'
    SentTime;
    @title : 'Status'
    Status;
    @title : 'Status Message'
    Message;
    @title : 'Structured Message (i18n codes)'
    MessageJson;
    @title : 'Request JSON'
    RequestJson;
    @title : 'Response JSON'
    ResponseJson;
    @title : 'HTTP Response Status Code'
    ResponseStatus;
  };

  @readonly : true
  entity ZProdOrderExcLogHDR as projection on db.ZProdOrderExcLogHDR;
  annotate ZProdOrderExcLogHDR {
    @title : 'SAP Production Order'
    ManufacturingOrder;
    @title : 'Send Counter'
    Counter;
    @title : 'Send Date'
    SentDate;
    @title : 'Send Time'
    SentTime;
    @title : 'Status'
    @assert.enum : true
    @assert.values : [ 'S', 'E', 'W' ]
    Status;
    @title : 'Status Message'
    Message;
    @title : 'Structured Message (i18n codes)'
    MessageJson;
  };

  @readonly : true
  entity ZProdOrderExcLogPOS as projection on db.ZProdOrderExcLogPOS;
  annotate ZProdOrderExcLogPOS {
    @title : 'SAP Production Order'
    ManufacturingOrder;
    @title : 'Send Counter'
    Counter;
    @title : 'Operation'
    Operation;
    @title : 'Send Date'
    SentDate;
    @title : 'Send Time'
    SentTime;
    @title : 'Status'
    @assert.enum : true
    @assert.values : [ 'S', 'E', 'W' ]
    Status;
    @title : 'Status Message'
    Message;
    @title : 'Structured Message (i18n codes)'
    MessageJson;
    @title : 'Request JSON Sent to Plex'
    RequestJson;
    @title : 'Response JSON from Plex'
    ResponseJson;
    @title : 'HTTP Response Status Code'
    ResponseStatus;
  };

  @readonly : true
  entity ZProdOrderPlexMapping as projection on db.ZProdOrderPlexMapping;
  annotate ZProdOrderPlexMapping {
    @title : 'SAP Production Order'
    ManufacturingOrder;
    @title : 'Plex Job Number'
    PlexJobNumber;
    @title : 'Production Plant'
    Plant;
    @title : 'Plex Job ID (UUID)'
    PlexJobId;
    @title : 'Plex Part ID (UUID)'
    PlexPartId;
    @title : 'External Job Code'
    ExternalJobCode;
    @title : 'Split Package Sequence'
    SplitSequence;
    @title : 'Split Lot State'
    SplitState;
    @title : 'Job Quantity'
    Quantity;
    @title : 'Main Lot Quantity Before Split'
    MainQtyBefore;
    @title : 'Last Status'
    @assert.enum : true
    @assert.values : [ 'S', 'E', 'W' ]
    Status;
    @title : 'Last Status Message'
    LastMessage;
    @title : 'Structured Last Message (i18n codes)'
    LastMessageJson;
    @title : 'Created At'
    CreatedAt;
    @title : 'Updated At'
    UpdatedAt;
  };

  @readonly : true
  entity ZProdOrderSplit as projection on db.ZProdOrderSplit;
  annotate ZProdOrderSplit {
    @title : 'SAP Production Order'
    ManufacturingOrder;
    @title : 'Production Plant'
    Plant;
    @title : 'Order Is Split'
    IsSplit;
    @title : 'Last Package Sequence Assigned'
    LastSequence;
    @title : 'Reference Quantity'
    ReferenceQuantity;
    @title : 'Reference Unit'
    ReferenceUnit;
    @title : 'Execution Lock Token'
    LockToken;
    @title : 'Lock Acquired At'
    LockedAt;
    @title : 'Lock Owner'
    @PersonalData.IsPotentiallyPersonal : true
    LockedBy;
    @title : 'Last Attempt At'
    LastAttemptAt;
    @title : 'Last Attempt User'
    @PersonalData.IsPotentiallyPersonal : true
    LastAttemptBy;
    @title : 'Created At'
    CreatedAt;
    @title : 'Updated At'
    UpdatedAt;
  };

  @readonly : true
  entity ZProdOrderTecoState as projection on db.ZProdOrderTecoState;
  annotate ZProdOrderTecoState {
    @title : 'SAP Production Order'
    ManufacturingOrder;
    @title : 'Plex Job Number'
    PlexJobNumber;
    @title : 'Production Plant'
    Plant;
    @title : 'Trigger Status Field'
    TriggerStatus;
    @title : 'TECO State'
    State;
    @title : 'Write Attempts'
    Attempts;
    @title : 'Plex Job ID (UUID)'
    PlexJobId;
    @title : 'Plex Job Key'
    PlexJobKey;
    @title : 'Plex Job Status Before'
    PlexStatusBefore;
    @title : 'Data Source HTTP Status'
    DsHttpStatus;
    @title : 'Last Message'
    LastMessage;
    @title : 'Structured Last Message (i18n codes)'
    LastMessageJson;
    @title : 'TECO Detected At'
    DetectedAt;
    @title : 'Closed On Plex At'
    AppliedAt;
    @title : 'Created At'
    CreatedAt;
    @title : 'Updated At'
    UpdatedAt;
  };

  @readonly : true
  entity ZProdOrderCompleteState as projection on db.ZProdOrderCompleteState;
  annotate ZProdOrderCompleteState {
    @title : 'Plex Job ID (UUID)'
    PlexJobId;
    @title : 'Production Plant'
    Plant;
    @title : 'Plex Job Number'
    PlexJobNumber;
    @title : 'Plex Job Status'
    PlexStatus;
    @title : 'Plex Completed At'
    PlexCompletedAt;
    @title : 'Job Quantity'
    Quantity;
    @title : 'Job Quantity Completed'
    QuantityCompleted;
    @title : 'SAP Production Order'
    ManufacturingOrder;
    @title : 'Status State'
    State;
    @title : 'Write Attempts'
    Attempts;
    @title : 'SAP Message Type'
    SapMessageType;
    @title : 'SAP Message Id'
    SapMessageId;
    @title : 'SAP Message Number'
    SapMessageNumber;
    @title : 'HTTP Status'
    HttpStatus;
    @title : 'Call Depth'
    SapDepth;
    @title : 'Last Message'
    LastMessage;
    @title : 'Structured Last Message (i18n codes)'
    LastMessageJson;
    @title : 'Detected On Plex At'
    DetectedAt;
    @title : 'Claimed At'
    ClaimedAt;
    @title : 'User Status Set In SAP At'
    AppliedAt;
    @title : 'Created At'
    CreatedAt;
    @title : 'Updated At'
    UpdatedAt;
  };

  @readonly : true
  entity ZProdOrderScheduledState as projection on db.ZProdOrderScheduledState;
  annotate ZProdOrderScheduledState {
    @title : 'Plex Job ID (UUID)'
    PlexJobId;
    @title : 'Production Plant'
    Plant;
    @title : 'Plex Job Number'
    PlexJobNumber;
    @title : 'Plex Job Status'
    PlexStatus;
    @title : 'Plex Completed At (unused here)'
    PlexCompletedAt;
    @title : 'Job Quantity Completed (unused here)'
    QuantityCompleted;
    @title : 'Job Quantity'
    Quantity;
    @title : 'SAP Production Order'
    ManufacturingOrder;
    @title : 'Status State'
    State;
    @title : 'Write Attempts'
    Attempts;
    @title : 'SAP Message Type'
    SapMessageType;
    @title : 'SAP Message Id'
    SapMessageId;
    @title : 'SAP Message Number'
    SapMessageNumber;
    @title : 'HTTP Status'
    HttpStatus;
    @title : 'Call Depth'
    SapDepth;
    @title : 'Last Message'
    LastMessage;
    @title : 'Structured Last Message (i18n codes)'
    LastMessageJson;
    @title : 'Detected On Plex At'
    DetectedAt;
    @title : 'Claimed At'
    ClaimedAt;
    @title : 'User Status Set In SAP At'
    AppliedAt;
    @title : 'Created At'
    CreatedAt;
    @title : 'Updated At'
    UpdatedAt;
  };

  @readonly : true
  entity ZProdConfPlexEntry as projection on db.ZProdConfPlexEntry;
  annotate ZProdConfPlexEntry {
    @title : 'Plex Production Entry Key'
    PlexEntryId;
    @title : 'Plex Source'
    SourceType;
    @title : 'Plex Job ID'
    JobId;
    @title : 'Plex Job Number'
    PlexJobNumber;
    @title : 'Plex Part Operation ID'
    PartOperationId;
    @title : 'Plex Workcenter ID'
    WorkcenterId;
    @title : 'SAP Production Order'
    ManufacturingOrder;
    @title : 'SAP Operation'
    OrderOperation;
    @title : 'Plant'
    Plant;
    @title : 'Yield Quantity'
    YieldQuantity;
    @title : 'Scrap Quantity'
    ScrapQuantity;
    @title : 'Rework Quantity'
    ReworkQuantity;
    @title : 'Confirmation Unit'
    ConfirmationUnit;
    @title : 'Is Final Confirmation'
    IsFinalConfirmation;
    @title : 'Execution Start'
    ExecutionStart;
    @title : 'Execution End'
    ExecutionEnd;
    @title : 'Plex Entry Date'
    EntryDate;
    @title : 'Plex Serial No'
    SerialNo;
    @title : 'Plex Part Number'
    PartNumber;
    @title : 'Plex Part ID'
    PlexPartId;
    @title : 'Plex Operation Number'
    OperationNumber;
    @title : 'Plex Operation Code'
    OperationCode;
    @title : 'Plex Lot No'
    LotNo;
    @title : 'Plex Heat No'
    HeatNo;
    @title : 'Plex Tracking No'
    TrackingNo;
    @title : 'Shelf Life Expiration (Plex)'
    ShelfDateTime;
    @title : 'Manufacture Date (Plex)'
    ManufacturedDateTime;
    @title : 'Plex Scrap Reason'
    ScrapReason;
    @title : 'Plex Transaction Type'
    TransactionType;
    @title : 'Plex Adjustment Code'
    AdjustmentCode;
    @title : 'Plex Location'
    PlexLocation;
    @title : 'Net Weight (Plex)'
    NetWeight;
    @title : 'Status'
    @assert.enum : true
    @assert.values : [ 'S', 'E', 'X', 'Q', 'I' ]
    Status;
    @title : 'Status Message'
    Message;
    @title : 'Structured Message (i18n codes)'
    MessageJson;
    @title : 'Retry Count'
    RetryCount;
    @title : 'SAP Material Document'
    MaterialDocument;
    @title : 'SAP Material Document Year'
    MaterialDocumentYear;
    @title : 'SAP Confirmation Group'
    ConfirmationGroup;
    @title : 'SAP Confirmation Count'
    ConfirmationCount;
    @title : 'Raw Plex Entry JSON'
    RawJson;
    @title : 'Created At'
    CreatedAt;
    @title : 'Updated At'
    UpdatedAt;
  };

  @readonly : true
  entity ZProdConfMatDoc as projection on db.ZProdConfMatDoc;
  annotate ZProdConfMatDoc {
    @title : 'Plex Production Entry Key'
    PlexEntryId;
    @title : 'Document Sequence'
    DocSeq;
    @title : 'Goods Movement Code'
    GoodsMovementCode;
    @title : 'Plant'
    Plant;
    @title : 'SAP Production Order'
    ManufacturingOrder;
    @title : 'Item Count'
    ItemCount;
    @title : 'Status'
    @assert.enum : true
    @assert.values : [ 'E', 'P', 'S', 'X' ]
    Status;
    @title : 'Failure Class'
    FailureClass;
    @title : 'Retry Count'
    RetryCount;
    @title : 'Claimed At'
    InFlightAt;
    @title : 'Claimed By Run'
    InFlightRun;
    @title : 'Test Run (validated, not posted)'
    TestRun;
    @title : 'SAP Material Document'
    MaterialDocument;
    @title : 'SAP Material Document Year'
    MaterialDocumentYear;
    @title : 'SAP Confirmation Group'
    ConfirmationGroup;
    @title : 'SAP Confirmation Count'
    ConfirmationCount;
    @title : 'SAP Message Type'
    MessageType;
    @title : 'SAP Message'
    MessageText;
    @title : 'Structured Message (i18n codes)'
    MessageTextJson;
    @title : 'Request JSON'
    RequestJson;
    @title : 'Response JSON'
    ResponseJson;
    @title : 'Created At'
    CreatedAt;
    @title : 'Updated At'
    UpdatedAt;
  };

  @readonly : true
  entity ZJobReadWatermark as projection on db.ZJobReadWatermark;
  annotate ZJobReadWatermark {
    @title : 'Job'
    JobCode;
    @title : 'Source'
    SourceCode;
    @title : 'Plant'
    Plant;
    @title : 'Last Successful Window End'
    WindowEnd;
    @title : 'Last Attempt'
    LastAttemptAt;
    @title : 'Last Success'
    LastSuccessAt;
    @title : 'Consecutive Read Failures'
    FailureCount;
    @title : 'Last Message'
    LastMessage;
    @title : 'Updated At'
    UpdatedAt;
  };

  @readonly : true
  entity ZJobRunHDR as projection on db.ZJobRunHDR;
  annotate ZJobRunHDR {
    @title : 'Run ID'
    RunId;
    @title : 'Job'
    JobCode;
    @title : 'Started At'
    StartedAt;
    @title : 'Finished At'
    FinishedAt;
    @title : 'Status'
    Status;
    @title : 'Processed'
    TotalProcessed;
    @title : 'Ok'
    TotalOk;
    @title : 'Warning'
    TotalWarning;
    @title : 'Failed'
    TotalFailed;
    @title : 'Permanently Failed'
    TotalExhausted;
    @title : 'Skipped'
    TotalSkipped;
    @title : 'Run Message'
    Message;
    @title : 'Fatal Error'
    FatalMessage;
    @title : 'Structured Run Message (i18n codes)'
    MessageJson;
    @title : 'Structured Fatal Error (i18n codes)'
    FatalMessageJson;
    @title : 'Mail Status'
    MailStatus;
    @title : 'Mail Message'
    MailMessage;
  };

  @readonly : true
  entity ZJobRunPOS as projection on db.ZJobRunPOS;
  annotate ZJobRunPOS {
    @title : 'Run ID'
    RunId;
    @title : 'Record Counter'
    Counter;
    @title : 'Plant'
    Plant;
    @title : 'Object Type'
    ObjectType;
    @title : 'Object Key'
    ObjectKey;
    @title : 'Object Key 2'
    ObjectKey2;
    @title : 'Status'
    Status;
    @title : 'Status Message'
    Message;
    @title : 'Structured Message (i18n codes)'
    MessageJson;
    @title : 'Detail Log Reference'
    LogRef;
  };

  @readonly : true
  entity ZJobRunMail as projection on db.ZJobRunMail;
  annotate ZJobRunMail {
    @title : 'Run ID'
    RunId;
    @title : 'Recipient'
    Email;
    @title : 'Plants Covered'
    Plants;
    @title : 'Notify Mode'
    NotifyMode;
    @title : 'Sent At'
    SentAt;
    @title : 'Status'
    Status;
    @title : 'Status Message'
    Message;
    @title : 'Structured Message (i18n codes)'
    MessageJson;
    @title : 'Attachments'
    AttachCount;
    @title : 'Attachment Bytes (raw)'
    AttachBytes;
  };
};

@path : '/plex'
service PlexService {
  action testPlexConnection(
    Plant : String(4)
  ) returns {
    success : Boolean;
    connectOk : Boolean;
    connectStatus : Integer;
    connectMessage : String;
    partsCount : Integer;
    dataSourceOk : Boolean;
    dataSourceStatus : Integer;
    dataSourceMessage : String;
  };

  action sendProductToPlex(
    Product : String(40),
    ProductDescription : String,
    Plant : String(4)
  ) returns {
    success : Boolean;
    operation : String;
    plexId : String;
    message : String;
    receivingOperation : String;
    receivingRealignWay : String;
    messageJson : String;
  };

  action probePlexPartValues(
    Product : String(40),
    Plant : String(4)
  ) returns many {
    id : String(12);
    what : String(4000);
    field : String(10);
    candidate : String(60);
    sentAs : String(10);
    isControl : Boolean;
    partNumber : String(100);
    httpStatus : Integer;
    accepted : Boolean;
    created : Boolean;
    plexId : String(60);
    deleted : Boolean;
    rejectedFields : String(200);
    responseBody : String(2000);
    error : String(2000);
    ms : Integer;
  };

  action getConfiguredProducts() returns many {
    Product : String(40);
    ProductDescription : String;
    Plant : String(4);
  };

  action sendProductsChunkToPlex(
    products : many {
      Product : String(40);
      ProductDescription : String;
      Plant : String(4);
    }
  ) returns {
    success : Integer;
    errors : Integer;
    skipped : Integer;
  };

  action uploadPartAttribute(
    Product : String(40),
    Plant : String(4)
  ) returns {
    success : Boolean;
    status : Integer;
    response : String;
    message : String;
  };

  action getPlexOperations(
    Plant : String(4),
    Scope : String(10)
  ) returns {
    operations : many {
      id : String;
      code : String;
      name : String;
      description : String;
      type : String;
    };
    readOk : Boolean;
    message : String;
    filterScope : String;
    filterTypes : String;
    filterConfigured : Boolean;
    total : Integer;
    kept : Integer;
    droppedNoType : Integer;
  };

  action getPlexWorkcenters(
    Plant : String(4)
  ) returns many {
    id : String;
    workcenterCode : String;
    name : String;
    workcenterType : String;
    workcenterGroup : String;
  };

  action createJobInPlex(
    ManufacturingOrder : String(12)
  ) returns {
    success : Boolean;
    status : String;
    jobId : String;
    jobNumber : String;
    message : String;
    messageCode : String(60);
    sortStatus : String(1);
    sortNote : String;
  };

  action getProdOrderSplitInfo(
    ManufacturingOrder : String(12)
  ) returns {
    status : String(1);
    row : String(2);
    messageCode : String(60);
    messageParams : many String;
    message : String(500);
    ManufacturingOrder : String(12);
    Material : String(40);
    MaterialDescription : String(40);
    ProductionPlant : String(4);
    Unit : String(3);
    SapOrderQuantity : Decimal(13, 3);
    QuantityDecimals : Integer;
    MainJobFound : Boolean;
    MainJobNumber : String(40);
    MainJobId : String(36);
    MainJobQuantity : Decimal(13, 3);
    MainJobDueDate : String(30);
    ReferenceQuantity : Decimal(13, 3);
    LotSum : Decimal(13, 3);
    HasMismatch : Boolean;
    IsSplit : Boolean;
    PackageCount : Integer;
    NextPackageCode : String(40);
    CanSplit : Boolean;
    OfferedCommand : String(10);
    ResidualJobNumber : String(40);
    packages : many {
      PackageJobNumber : String(40);
      PackageJobId : String(36);
      SplitSequence : Integer;
      Quantity : Decimal(13, 3);
      MainQtyBefore : Decimal(13, 3);
      SplitState : String(1);
      CreatedAt : Timestamp;
      UpdatedAt : Timestamp;
      LastMessage : String(255);
    };
  };

  action splitProdOrderJob(
    ManufacturingOrder : String(12),
    Mode : String(10),
    Quantity : Decimal(13, 3),
    PackageJobNumber : String(40)
  ) returns {
    status : String(1);
    row : String(2);
    messageCode : String(60);
    messageParams : many String;
    message : String(500);
    ManufacturingOrder : String(12);
    Unit : String(3);
    MainJobNumber : String(40);
    MainJobQuantity : Decimal(13, 3);
    MainQtyBefore : Decimal(13, 3);
    PackageJobNumber : String(40);
    PlannedPackageJobNumber : String(40);
    CodeChanged : Boolean;
    PackageJobId : String(36);
    PackageQuantity : Decimal(13, 3);
    PackageState : String(1);
    IsSplit : Boolean;
    PackageCount : Integer;
    ResidualOpen : Boolean;
    OfferedCommand : String(10);
    sortStatus : String(1);
    sortNote : String;
    steps : many {
      seq : Integer;
      step : String(40);
      status : String(1);
      httpStatus : Integer;
      verdict : String(12);
      message : String(255);
    };
  };

  function splitJobReadProbe(
    ManufacturingOrder : String(12)
  ) returns many {
    id : String(16);
    what : String(2000);
    request : String(600);
    httpStatus : Integer;
    ok : Boolean;
    rows : Integer;
    exactMatch : Boolean;
    jobNumbers : String(200);
    error : String(2000);
    responseBody : String(2000);
    firstRow : String(500);
    rowsJson : String(20000);
    ms : Integer;
  };

  function jobScheduleProbe(
    ManufacturingOrder : String(12)
  ) returns many {
    id : String(16);
    what : String(6000);
    request : String(600);
    httpStatus : Integer;
    ok : Boolean;
    rows : Integer;
    findings : String(2000);
    error : String(2000);
    responseBody : String(2000);
    firstRow : String(500);
    rowsJson : String(20000);
    ms : Integer;
  };

  function plexHistoryProbe(
    Plant : String(4)
  ) returns many {
    id : String(16);
    what : String(4000);
    plant : String(4);
    request : String(600);
    windowUtc : String(60);
    httpStatus : Integer;
    ok : Boolean;
    rows : Integer;
    error : String(2000);
    responseBody : String(2000);
    firstRow : String(500);
    rowsJson : String(20000);
    ms : Integer;
  };
};

@requires : 'JOBSCHEDULER'
@path : '/job-run'
service JobRunService {
  type JobRunTrigger {
    accepted : Boolean;
    jobCode : String(20);
    runId : String(36);
    message : String(1000);
  };

  action runMatSync() returns JobRunTrigger;

  action runRoutingSync() returns JobRunTrigger;

  action runProdOrder() returns JobRunTrigger;

  action runProdConf() returns JobRunTrigger;

  action runProdTeco() returns JobRunTrigger;

  action runOrderComplete() returns JobRunTrigger;

  action runOrderScheduled() returns JobRunTrigger;
};


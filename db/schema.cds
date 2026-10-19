namespace avvaleplm.marsplm.sap2plex;

using { managed } from '@sap/cds/common';

entity ZPlant : managed {
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  key PlantCode : String(4);
  @title : 'Plant Name'
  PlantName : String(100);
  @title : 'Status'
  Status : String(20) default 'Active';
  @title : 'Max Confirmation Retry (empty = unlimited)'
  MaxRetryAttempts : Integer;
  @title : 'Auto-assign BOM components on Plex sync'
  AutoAssignBomOnSync : Boolean default false;
  @title : 'Enable real goods movement posting (unticked = test run)'
  MatDocPostEnabled : Boolean default false;
};

entity ZLicenseConfig : managed {
  key ID : UUID;
  @title : 'API Key'
  @PersonalData.IsPotentiallySecret : true
  ApiKey : String(255) not null;
};

entity ZMatFilterConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Profit Center'
  ProfitCenter : String(10);
  @title : 'MRP Type'
  @assert.format : '^[A-Z0-9]{0,2}$'
  MRPType : String(2);
  @title : 'Procurement Type'
  @assert.format : '^[A-Z0-9]?$'
  ProcurementType : String(1);
  @title : 'Purchasing Group'
  @assert.format : '^[A-Z0-9]{0,3}$'
  PurchasingGroup : String(3);
};

@assert.unique.plant : [ Plant ]
entity ZPlexConnConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Plex Connect Base URL'
  BaseUrl : String(255) not null;
  @title : 'Consumer Key'
  @PersonalData.IsPotentiallySecret : true
  ConsumerKey : String(255) not null;
  @title : 'Plex Data Source Base URL'
  DataSourceUrl : String(255) not null;
  @title : 'Data Source User'
  DataSourceUser : String(255) not null;
  @title : 'Data Source Password'
  @PersonalData.IsPotentiallySecret : true
  DataSourcePassword : String(255);
  @title : 'Last Tested'
  LastTestedAt : Timestamp;
  @title : 'Last Test Status'
  LastTestStatus : String(1);
  @title : 'Last Test Message'
  LastTestMessage : String(255);
};

entity ZProdTypeConfig : managed {
  key ID : UUID;
  @title : 'Plex Part Type'
  PlexPartType : String(30) not null;
  @title : 'Material Type (MTART)'
  MaterialType : String(4);
  @title : 'Procurement Type (BESKZ)'
  ProcurementType : String(1);
  @title : 'Special Procurement (SOBSL)'
  SpecialProcurement : String(2);
  @title : 'Production Supervisor (FEVOR)'
  ProductionSupervisor : String(3);
};

@assert.unique.matGroup : [ Plant, Material, ComponentGroup ]
entity ZCycleAutoAssignConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Material'
  Material : String(40) not null;
  @title : 'Group'
  ComponentGroup : String(40) not null;
  @title : 'Plex Operation'
  PlexOperation : String(60) not null;
  @title : 'Plex Operation Name'
  PlexOperationName : String(120);
};

@assert.unique.plantUom : [ Plant, BaseUnit ]
entity ZMatRecvOpConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Base Unit (MEINS)'
  BaseUnit : String(3) not null;
  @title : 'Plex Operation Id'
  PlexOperationId : String(36) not null;
  @title : 'Plex Operation Code'
  PlexOperationCode : String(60);
  @title : 'Plex Operation Name'
  PlexOperationName : String(120);
  @title : 'Operation Number'
  OperationNumber : Integer default 10;
  @title : 'Shippable'
  Shippable : Boolean default false;
  @title : 'Active'
  IsActive : Boolean default true;
};

@assert.unique.plantType : [ Plant, PlexTypeValue ]
entity ZPlexPartTypeCode : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Plex Type Value'
  PlexTypeValue : String(30) not null;
  @title : 'Plex Type Code'
  PlexTypeCode : String(50) not null;
  @title : 'Active'
  IsActive : Boolean default true;
};

@assert.unique.plant : [ Plant ]
entity ZPlexPartStatusConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Plex Status Code'
  PlexStatusCode : String(50) not null;
  @title : 'Plex Status Label'
  PlexStatusLabel : String(100) not null;
  @title : 'Active'
  IsActive : Boolean default true;
};

@assert.unique.plant : [ Plant ]
entity ZPlexJobSortConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Job Sort Enabled'
  IsEnabled : Boolean not null default false;
  @title : 'Sort By SAP Due Date'
  DueDateSort : Boolean not null default false;
  @title : 'Frozen Job Statuses (comma separated)'
  FrozenJobStatusList : String(200);
};

@assert.unique.plantRule : [ Plant, BillOfOperationsStatus, BillOfOperationsUsage ]
entity ZRoutingFilterConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Routing Status'
  BillOfOperationsStatus : String(3) default '';
  @title : 'Routing Usage'
  BillOfOperationsUsage : String(3) default '';
  @title : 'Active'
  IsActive : Boolean default true;
};

@assert.unique.plant : [ Plant ]
entity ZProdOrderFilterConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Required Statuses (semicolon separated)'
  RequiredStatuses : String(600);
  @title : 'Excluded Statuses (semicolon separated)'
  ExcludedStatuses : String(600);
  @title : 'Order Types (semicolon separated)'
  OrderTypes : String(600);
  @title : 'Production Supervisors (semicolon separated)'
  ProductionSupervisors : String(600);
};

@assert.unique.plant : [ Plant ]
entity ZProdOrderTecoConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Close Plex Job On TECO'
  IsEnabled : Boolean not null default false;
  @title : 'TECO Trigger Statuses (semicolon separated)'
  TriggerStatuses : String(600);
};

@assert.unique.plant : [ Plant ]
entity ZProdOrderCompleteConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Set SAP User Status On Plex Complete'
  IsEnabled : Boolean not null default false;
  @title : 'Plex Job Statuses That Mean Complete (semicolon separated)'
  PlexStatuses : String(600);
};

@assert.unique.plant : [ Plant ]
entity ZProdOrderScheduledConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Set SAP User Status On Plex Scheduled'
  IsEnabled : Boolean not null default false;
  @title : 'Plex Job Statuses That Mean Scheduled (semicolon separated)'
  PlexStatuses : String(600);
};

@assert.unique.plant : [ Plant ]
entity ZProdConfPostingConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Production Posting Channel'
  ProdPosting : String(10) not null default 'MATDOC';
  @title : 'Order Confirmation Posting Enabled'
  ConfPostEnabled : Boolean not null default false;
  @title : 'Component Consumption Point'
  ConsumeAt : String(10) not null default 'LAST';
  @title : 'Scrap Component Consumption'
  ScrapConsume : String(10) not null default 'NONE';
  @title : 'Scrap Component Movement'
  ScrapMove : String(10) not null default 'ISSUE';
  @title : 'Scrap Goods Issue'
  ScrapIssue : String(20) not null default 'ALWAYS';
  @title : 'Scrap Without Job'
  ScrapNoOrder : String(10) not null default 'OFF';
  @title : 'Scrap Storage Location (LGORT_FROM)'
  ScrapStorLoc : String(4) default '';
  @title : 'Goods Movement Reason (MOVE_REAS)'
  ScrapReason : String(4) default '';
  @title : 'Material Document Header Text'
  ScrapHeadTxt : String(25) default '';
  @title : 'Item Text for Scrap Without Job'
  ScrapLateTxt : String(50) default '';
};

@assert.unique.plant : [ Plant ]
entity ZPhantomExplodeConfig : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Max Explosion Depth'
  MaxDepth : Integer not null default 5;
  @title : 'BOM Usage (STLAN)'
  BomUsage : String(1) default '';
  @title : 'BOM Alternative (STLAL)'
  BomVariant : String(2) default '';
  @title : 'Effectivity Date Mode'
  EffectivityDateMode : String(20) not null default 'TODAY';
  @title : 'Routing BOM Key Date'
  RoutingBomKeyDate : Date;
  @title : 'Explode In Routing Components'
  ExplodeInRouting : Boolean not null default false;
  @title : 'Explode In Prod Order Components'
  ExplodeInProdOrder : Boolean not null default false;
  @title : 'Routing Components From BOM'
  RoutingCompDefaultOp : Boolean default false;
  @title : 'Default Routing Operation'
  RoutingCompDefaultOpTarget : String(10) default '';
};

@assert.unique.plantRule : [ Plant, RuleName ]
entity ZOrderCompExclRule : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Rule Name'
  RuleName : String(60) not null;
  @title : 'Sequence'
  Sequence : Integer default 10;
  @title : 'Active'
  IsActive : Boolean default false;
  Conditions : Composition of many ZOrderCompExclCond on Conditions.rule = $self;
};

entity ZOrderCompExclCond : managed {
  key ID : UUID;
  rule : Association to ZOrderCompExclRule;
  @title : 'SAP Field'
  SapField : String(60) not null;
  @title : 'Operator'
  Operator : String(10) not null default 'EQ';
  @title : 'Value'
  Value : String(255);
};

entity ZOrderCompFieldVH {
  @title : 'Field Name'
  key FieldName : String(60);
  @title : 'Label'
  Label : String(100);
  @title : 'Source'
  Source : String(10);
};

entity ZMatExcLogHDR {
  @title : 'Product Number'
  key Product : String(40);
  @title : 'Production Plant'
  key Plant : String(4) default '';
  @title : 'Send Counter'
  Counter : Integer;
  @title : 'Send Date'
  SentDate : Date;
  @title : 'Send Time'
  SentTime : Time;
  @title : 'Status'
  @assert.enum : true
  @assert.values : [ 'S', 'E', 'W' ]
  Status : String(1);
  @title : 'Status Message'
  Message : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageJson : String(1000);
};

entity ZMatExcLogPOS {
  @title : 'Product Number'
  key Product : String(40);
  @title : 'Production Plant'
  key Plant : String(4) default '';
  @title : 'Send Counter'
  key Counter : Integer;
  @title : 'Send Date'
  SentDate : Date;
  @title : 'Send Time'
  SentTime : Time;
  @title : 'Status'
  @assert.enum : true
  @assert.values : [ 'S', 'E', 'W' ]
  Status : String(1);
  @title : 'Status Message'
  Message : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageJson : String(1000);
  @title : 'Request JSON Sent to Plex'
  RequestJson : LargeString;
  @title : 'Response JSON from Plex'
  ResponseJson : LargeString;
  @title : 'HTTP Response Status Code'
  ResponseStatus : Integer;
};

entity ZMatPlexMapping {
  @title : 'Product Number'
  key Product : String(40);
  @title : 'Production Plant'
  key Plant : String(4) default '';
  @title : 'Plex Part ID (UUID)'
  PlexId : String(36);
  @title : 'Created At'
  CreatedAt : Timestamp;
  @title : 'Updated At'
  UpdatedAt : Timestamp;
};

entity ZMatRecvOpMapping {
  @title : 'Product Number'
  key Product : String(40);
  @title : 'Production Plant'
  key Plant : String(4) default '';
  @title : 'Plex Part-Operation Id'
  PartOperationId : String(36);
  @title : 'Plex Operation Id'
  PlexOperationId : String(36);
  @title : 'Base Unit at creation'
  BaseUnit : String(3);
  @title : 'Created At'
  CreatedAt : Timestamp;
};

entity ZProdOrderPlexMapping {
  @title : 'SAP Production Order'
  key ManufacturingOrder : String(12);
  @title : 'Plex Job Number'
  key PlexJobNumber : String(40);
  @title : 'Production Plant'
  Plant : String(4);
  @title : 'Plex Job ID (UUID)'
  PlexJobId : String(36);
  @title : 'Plex Part ID (UUID)'
  PlexPartId : String(36);
  @title : 'External Job Code'
  ExternalJobCode : String(40);
  @title : 'Split Package Sequence'
  SplitSequence : Integer default 0;
  @title : 'Split Lot State'
  SplitState : String(1);
  @title : 'Job Quantity'
  Quantity : Decimal(13, 3);
  @title : 'Main Lot Quantity Before Split'
  MainQtyBefore : Decimal(13, 3);
  @title : 'Last Status'
  @assert.enum : true
  @assert.values : [ 'S', 'E', 'W' ]
  Status : String(1);
  @title : 'Last Status Message'
  LastMessage : String(255);
  @title : 'Structured Last Message (i18n codes)'
  LastMessageJson : String(1000);
  @title : 'Created At'
  CreatedAt : Timestamp;
  @title : 'Updated At'
  UpdatedAt : Timestamp;
};

entity ZProdOrderSplit {
  @title : 'SAP Production Order'
  key ManufacturingOrder : String(12);
  @title : 'Production Plant'
  Plant : String(4);
  @title : 'Order Is Split'
  IsSplit : Boolean default false;
  @title : 'Last Package Sequence Assigned'
  LastSequence : Integer default 0;
  @title : 'Reference Quantity'
  ReferenceQuantity : Decimal(13, 3);
  @title : 'Reference Unit'
  ReferenceUnit : String(3);
  @title : 'Execution Lock Token'
  LockToken : String(36);
  @title : 'Lock Acquired At'
  LockedAt : Timestamp;
  @title : 'Lock Owner'
  @PersonalData.IsPotentiallyPersonal : true
  LockedBy : String(120);
  @title : 'Last Attempt At'
  LastAttemptAt : Timestamp;
  @title : 'Last Attempt User'
  @PersonalData.IsPotentiallyPersonal : true
  LastAttemptBy : String(120);
  @title : 'Created At'
  CreatedAt : Timestamp;
  @title : 'Updated At'
  UpdatedAt : Timestamp;
};

entity ZProdOrderTecoState {
  @title : 'SAP Production Order'
  key ManufacturingOrder : String(12);
  @title : 'Plex Job Number'
  key PlexJobNumber : String(40);
  @title : 'Production Plant'
  Plant : String(4);
  @title : 'Trigger Status Field'
  TriggerStatus : String(40);
  @title : 'TECO State'
  State : String(1);
  @title : 'Write Attempts'
  Attempts : Integer default 0;
  @title : 'Plex Job ID (UUID)'
  PlexJobId : String(36);
  @title : 'Plex Job Key'
  PlexJobKey : Integer;
  @title : 'Plex Job Status Before'
  PlexStatusBefore : String(40);
  @title : 'Data Source HTTP Status'
  DsHttpStatus : Integer;
  @title : 'Last Message'
  LastMessage : String(255);
  @title : 'Structured Last Message (i18n codes)'
  LastMessageJson : String(1000);
  @title : 'TECO Detected At'
  DetectedAt : Timestamp;
  @title : 'Closed On Plex At'
  AppliedAt : Timestamp;
  @title : 'Created At'
  CreatedAt : Timestamp;
  @title : 'Updated At'
  UpdatedAt : Timestamp;
};

entity ZProdOrderCompleteState {
  @title : 'Plex Job ID (UUID)'
  key PlexJobId : String(36);
  @title : 'Production Plant'
  Plant : String(4);
  @title : 'Plex Job Number'
  PlexJobNumber : String(40);
  @title : 'Plex Job Status'
  PlexStatus : String(40);
  @title : 'Plex Completed At'
  PlexCompletedAt : Timestamp;
  @title : 'Job Quantity'
  Quantity : Decimal(13, 3);
  @title : 'Job Quantity Completed'
  QuantityCompleted : Decimal(13, 3);
  @title : 'SAP Production Order'
  ManufacturingOrder : String(12);
  @title : 'Status State'
  State : String(1);
  @title : 'Write Attempts'
  Attempts : Integer default 0;
  @title : 'SAP Message Type'
  SapMessageType : String(1);
  @title : 'SAP Message Id'
  SapMessageId : String(20);
  @title : 'SAP Message Number'
  SapMessageNumber : String(3);
  @title : 'HTTP Status'
  HttpStatus : Integer;
  @title : 'Call Depth'
  SapDepth : String(20);
  @title : 'Last Message'
  LastMessage : String(255);
  @title : 'Structured Last Message (i18n codes)'
  LastMessageJson : String(1000);
  @title : 'Detected On Plex At'
  DetectedAt : Timestamp;
  @title : 'Claimed At'
  ClaimedAt : Timestamp;
  @title : 'User Status Set In SAP At'
  AppliedAt : Timestamp;
  @title : 'Created At'
  CreatedAt : Timestamp;
  @title : 'Updated At'
  UpdatedAt : Timestamp;
};

entity ZProdOrderScheduledState {
  @title : 'Plex Job ID (UUID)'
  key PlexJobId : String(36);
  @title : 'Production Plant'
  Plant : String(4);
  @title : 'Plex Job Number'
  PlexJobNumber : String(40);
  @title : 'Plex Job Status'
  PlexStatus : String(40);
  @title : 'Plex Completed At (unused here)'
  PlexCompletedAt : Timestamp;
  @title : 'Job Quantity Completed (unused here)'
  QuantityCompleted : Decimal(13, 3);
  @title : 'Job Quantity'
  Quantity : Decimal(13, 3);
  @title : 'SAP Production Order'
  ManufacturingOrder : String(12);
  @title : 'Status State'
  State : String(1);
  @title : 'Write Attempts'
  Attempts : Integer default 0;
  @title : 'SAP Message Type'
  SapMessageType : String(1);
  @title : 'SAP Message Id'
  SapMessageId : String(20);
  @title : 'SAP Message Number'
  SapMessageNumber : String(3);
  @title : 'HTTP Status'
  HttpStatus : Integer;
  @title : 'Call Depth'
  SapDepth : String(20);
  @title : 'Last Message'
  LastMessage : String(255);
  @title : 'Structured Last Message (i18n codes)'
  LastMessageJson : String(1000);
  @title : 'Detected On Plex At'
  DetectedAt : Timestamp;
  @title : 'Claimed At'
  ClaimedAt : Timestamp;
  @title : 'User Status Set In SAP At'
  AppliedAt : Timestamp;
  @title : 'Created At'
  CreatedAt : Timestamp;
  @title : 'Updated At'
  UpdatedAt : Timestamp;
};

entity ZProdOrderExcLogHDR {
  @title : 'SAP Production Order'
  key ManufacturingOrder : String(12);
  @title : 'Send Counter'
  Counter : Integer;
  @title : 'Send Date'
  SentDate : Date;
  @title : 'Send Time'
  SentTime : Time;
  @title : 'Status'
  @assert.enum : true
  @assert.values : [ 'S', 'E', 'W' ]
  Status : String(1);
  @title : 'Status Message'
  Message : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageJson : String(1000);
};

entity ZProdOrderExcLogPOS {
  @title : 'SAP Production Order'
  key ManufacturingOrder : String(12);
  @title : 'Send Counter'
  key Counter : Integer;
  @title : 'Operation'
  Operation : String(20);
  @title : 'Send Date'
  SentDate : Date;
  @title : 'Send Time'
  SentTime : Time;
  @title : 'Status'
  @assert.enum : true
  @assert.values : [ 'S', 'E', 'W' ]
  Status : String(1);
  @title : 'Status Message'
  Message : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageJson : String(1000);
  @title : 'Request JSON Sent to Plex'
  RequestJson : LargeString;
  @title : 'Response JSON from Plex'
  ResponseJson : LargeString;
  @title : 'HTTP Response Status Code'
  ResponseStatus : Integer;
};

// Ricostruita dallo schema HANA deployato (tabella AVVALEPLM_MARSPLM_SAP2PLEX_ZPRODORDERTECOLOGPOS):
// non c'e' nel CSN del deploy ma la tabella contiene dati, quindi va mantenuta nel modello.
// Annotazioni (@title ecc.) non ricavabili dal DB.
entity ZProdOrderTecoLogPOS {
  key ManufacturingOrder : String(12);
  key PlexJobNumber      : String(40);
  key Counter            : Integer;
  Plant                  : String(4);
  SentDate               : Date;
  SentTime               : Time;
  Status                 : String(1);
  Message                : String(255);
  MessageJson            : String(1000);
  RequestJson            : LargeString;
  ResponseJson           : LargeString;
  ResponseStatus         : Integer;
};

entity ZProdConfPlexEntry {
  @title : 'Plex Production Entry Key'
  key PlexEntryId : String(150);
  @title : 'Plex Source'
  SourceType : String(1) default 'P';
  @title : 'Plex Job ID'
  JobId : String(36);
  @title : 'Plex Job Number'
  PlexJobNumber : String(40);
  @title : 'Plex Part Operation ID'
  PartOperationId : String(36);
  @title : 'Plex Workcenter ID'
  WorkcenterId : String(36);
  @title : 'SAP Production Order'
  ManufacturingOrder : String(12);
  @title : 'SAP Operation'
  OrderOperation : String(4);
  @title : 'Plant'
  Plant : String(4);
  @title : 'Yield Quantity'
  YieldQuantity : Decimal(13, 3);
  @title : 'Scrap Quantity'
  ScrapQuantity : Decimal(13, 3);
  @title : 'Rework Quantity'
  ReworkQuantity : Decimal(13, 3);
  @title : 'Confirmation Unit'
  ConfirmationUnit : String(3);
  @title : 'Is Final Confirmation'
  IsFinalConfirmation : Boolean;
  @title : 'Execution Start'
  ExecutionStart : Timestamp;
  @title : 'Execution End'
  ExecutionEnd : Timestamp;
  @title : 'Plex Entry Date'
  EntryDate : Timestamp;
  @title : 'Plex Serial No'
  SerialNo : String(40);
  @title : 'Plex Part Number'
  PartNumber : String(100);
  @title : 'Plex Part ID'
  PlexPartId : String(36);
  @title : 'Plex Operation Number'
  OperationNumber : Integer;
  @title : 'Plex Operation Code'
  OperationCode : String(50);
  @title : 'Plex Lot No'
  LotNo : String(40);
  @title : 'Plex Heat No'
  HeatNo : String(40);
  @title : 'Plex Tracking No'
  TrackingNo : String(50);
  @title : 'Shelf Life Expiration (Plex)'
  ShelfDateTime : Timestamp;
  @title : 'Manufacture Date (Plex)'
  ManufacturedDateTime : Timestamp;
  @title : 'Plex Scrap Reason'
  ScrapReason : String(100);
  @title : 'Plex Transaction Type'
  TransactionType : String(40);
  @title : 'Plex Adjustment Code'
  AdjustmentCode : String(50);
  @title : 'Plex Location'
  PlexLocation : String(50);
  @title : 'Net Weight (Plex)'
  NetWeight : Decimal(13, 3);
  @title : 'Status'
  @assert.enum : true
  @assert.values : [ 'S', 'E', 'X', 'Q', 'I' ]
  Status : String(1);
  @title : 'Status Message'
  Message : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageJson : String(1000);
  @title : 'Retry Count'
  RetryCount : Integer;
  @title : 'SAP Material Document'
  MaterialDocument : String(10);
  @title : 'SAP Material Document Year'
  MaterialDocumentYear : String(4);
  @title : 'SAP Confirmation Group'
  ConfirmationGroup : String(12);
  @title : 'SAP Confirmation Count'
  ConfirmationCount : String(8);
  @title : 'Raw Plex Entry JSON'
  RawJson : LargeString;
  @title : 'Created At'
  CreatedAt : Timestamp;
  @title : 'Updated At'
  UpdatedAt : Timestamp;
};

entity ZProdConfMatDoc {
  @title : 'Plex Production Entry Key'
  key PlexEntryId : String(150);
  @title : 'Document Sequence'
  key DocSeq : Integer;
  @title : 'Goods Movement Code'
  GoodsMovementCode : String(2);
  @title : 'Plant'
  Plant : String(4);
  @title : 'SAP Production Order'
  ManufacturingOrder : String(12);
  @title : 'Item Count'
  ItemCount : Integer;
  @title : 'Status'
  @assert.enum : true
  @assert.values : [ 'E', 'P', 'S', 'X' ]
  Status : String(1);
  @title : 'Failure Class'
  FailureClass : String(1);
  @title : 'Retry Count'
  RetryCount : Integer;
  @title : 'Claimed At'
  InFlightAt : Timestamp;
  @title : 'Claimed By Run'
  InFlightRun : String(36);
  @title : 'Test Run (validated, not posted)'
  TestRun : Boolean default false;
  @title : 'SAP Material Document'
  MaterialDocument : String(10);
  @title : 'SAP Material Document Year'
  MaterialDocumentYear : String(4);
  @title : 'SAP Confirmation Group'
  ConfirmationGroup : String(12);
  @title : 'SAP Confirmation Count'
  ConfirmationCount : String(8);
  @title : 'SAP Message Type'
  MessageType : String(1);
  @title : 'SAP Message'
  MessageText : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageTextJson : String(1000);
  @title : 'Request JSON'
  RequestJson : LargeString;
  @title : 'Response JSON'
  ResponseJson : LargeString;
  @title : 'Created At'
  CreatedAt : Timestamp;
  @title : 'Updated At'
  UpdatedAt : Timestamp;
};

entity ZJobReadWatermark {
  @title : 'Job'
  key JobCode : String(20);
  @title : 'Source'
  key SourceCode : String(20);
  @title : 'Plant'
  key Plant : String(4);
  @title : 'Last Successful Window End'
  WindowEnd : Timestamp;
  @title : 'Last Attempt'
  LastAttemptAt : Timestamp;
  @title : 'Last Success'
  LastSuccessAt : Timestamp;
  @title : 'Consecutive Read Failures'
  FailureCount : Integer default 0;
  @title : 'Last Message'
  LastMessage : String(255);
  @title : 'Updated At'
  UpdatedAt : Timestamp;
};

entity ZPlexCycleOperation : managed {
  key ID : UUID;
  @title : 'Manufacturing Order'
  ManufacturingOrder : String(12) not null;
  @title : 'Plex Operation ID'
  PlexOperationId : String(36) not null;
  @title : 'Operation Code'
  OperationCode : String(30);
  @title : 'Operation Name'
  OperationName : String(100);
  @title : 'Sequence Number'
  Sequence : Integer;
  @title : 'Linked SAP Operation'
  SAPOperationId : String(4);
  @title : 'Plex Operation Number'
  OperationNumber : Integer not null;
  @title : 'Part Operation Type'
  OperationType : String(50);
  @title : 'Sub Operation'
  SubOperation : Boolean default false;
  @title : 'Shippable'
  Shippable : Boolean default false;
  @title : 'Net Weight'
  NetWeight : Decimal(13, 3);
  @title : 'Standard Quantity'
  StandardQuantity : Decimal(13, 3);
};

entity ZPlexCycleComponent : managed {
  key ID : UUID;
  @title : 'Manufacturing Order'
  ManufacturingOrder : String(12) not null;
  @title : 'Plex Operation ID'
  PlexOperationId : String(36) not null;
  @title : 'Material'
  Material : String(40) not null;
  @title : 'Required Quantity'
  RequiredQuantity : Decimal(13, 3);
  @title : 'Base Unit'
  BaseUnit : String(3);
  @title : 'Sequence Number'
  Sequence : Integer not null;
  @title : 'Exploded From Phantom'
  PhantomSource : String(40) default '';
  @title : 'Assignment Source'
  AssignmentSource : String(10) not null default 'AUTO';
};

entity ZProdOrderCompRemoved : managed {
  @title : 'Manufacturing Order'
  key ManufacturingOrder : String(12);
  @title : 'Component Material'
  key Material : String(40);
};

entity ZPlexCycleApprovedWorkcenter : managed {
  key ID : UUID;
  @title : 'Manufacturing Order'
  ManufacturingOrder : String(12) not null;
  @title : 'Plex Operation ID'
  PlexOperationId : String(36) not null;
  @title : 'Workcenter ID'
  WorkcenterId : String(36) not null;
  @title : 'Workcenter Code'
  WorkcenterCode : String(50);
  @title : 'Workcenter Name'
  WorkcenterName : String(100);
};

entity ZPlexRoutingCycleOperation : managed {
  key ID : UUID;
  @title : 'Routing Group'
  ProductionRoutingGroup : String(8) not null;
  @title : 'Routing Counter'
  ProductionRouting : String(2) not null;
  @title : 'Header Material'
  HeaderMaterial : String(40) not null default '';
  @title : 'Plex Operation ID'
  PlexOperationId : String(36) not null;
  @title : 'Operation Code'
  OperationCode : String(30);
  @title : 'Operation Name'
  OperationName : String(100);
  @title : 'Sequence Number'
  Sequence : Integer;
  @title : 'Linked SAP Routing Operation'
  SAPOperationId : String(4);
  @title : 'SAP Routing Op Internal ID (PLNKN)'
  ProductionRoutingOpIntID : String(8);
  @title : 'Plex Operation Number'
  OperationNumber : Integer not null;
  @title : 'Part Operation Type'
  OperationType : String(50);
  @title : 'Sub Operation'
  SubOperation : Boolean default false;
  @title : 'Shippable'
  Shippable : Boolean default false;
  @title : 'Net Weight'
  NetWeight : Decimal(13, 3);
  @title : 'Standard Quantity'
  StandardQuantity : Decimal(13, 3);
};

entity ZPlexRoutingCycleComponent : managed {
  key ID : UUID;
  @title : 'Routing Group'
  ProductionRoutingGroup : String(8) not null;
  @title : 'Routing Counter'
  ProductionRouting : String(2) not null;
  @title : 'Header Material'
  HeaderMaterial : String(40) not null default '';
  @title : 'Plex Operation ID'
  PlexOperationId : String(36) not null;
  @title : 'Component Material'
  Material : String(40) not null;
  @title : 'BOM Item Node Number'
  BOMItemNodeNumber : String(8);
  @title : 'Required Quantity'
  RequiredQuantity : Decimal(13, 3);
  @title : 'Base Unit'
  BaseUnit : String(3);
  @title : 'Sequence Number'
  Sequence : Integer not null;
  @title : 'Exploded From Phantom'
  PhantomSource : String(40) default '';
  @title : 'Assignment Source'
  AssignmentSource : String(10) not null default 'AUTO';
};

entity ZPlexRoutingApprovedWorkcenter : managed {
  key ID : UUID;
  @title : 'Routing Group'
  ProductionRoutingGroup : String(8) not null;
  @title : 'Routing Counter'
  ProductionRouting : String(2) not null;
  @title : 'Header Material'
  HeaderMaterial : String(40) not null default '';
  @title : 'Plex Operation ID'
  PlexOperationId : String(36) not null;
  @title : 'Workcenter ID'
  WorkcenterId : String(36) not null;
  @title : 'Workcenter Code'
  WorkcenterCode : String(50);
  @title : 'Workcenter Name'
  WorkcenterName : String(100);
};

@assert.unique.plantCode : [ Plant, TemplateCode ]
entity ZPlexRoutingTemplate : managed {
  key ID : UUID;
  @title : 'Plant'
  Plant : String(4) not null;
  @title : 'Template Code'
  TemplateCode : String(20) not null;
  @title : 'Description'
  Description : String(255);
};

entity ZPlexRoutingTemplateOperation : managed {
  key ID : UUID;
  @title : 'Template ID'
  TemplateID : UUID not null;
  @title : 'Plex Operation ID'
  PlexOperationId : String(36) not null;
  @title : 'Operation Code'
  OperationCode : String(30);
  @title : 'Operation Name'
  OperationName : String(100);
  @title : 'Sequence Number'
  Sequence : Integer;
  @title : 'Plex Operation Number'
  OperationNumber : Integer;
  @title : 'Part Operation Type'
  OperationType : String(50);
  @title : 'Sub Operation'
  SubOperation : Boolean default false;
  @title : 'Shippable'
  Shippable : Boolean default false;
  @title : 'Net Weight'
  NetWeight : Decimal(13, 3);
  @title : 'Standard Quantity'
  StandardQuantity : Decimal(13, 3);
};

entity ZPlexRoutingTemplateWorkcenter : managed {
  key ID : UUID;
  @title : 'Template ID'
  TemplateID : UUID not null;
  @title : 'Plex Operation ID'
  PlexOperationId : String(36) not null;
  @title : 'Workcenter ID'
  WorkcenterId : String(36) not null;
  @title : 'Workcenter Code'
  WorkcenterCode : String(50);
  @title : 'Workcenter Name'
  WorkcenterName : String(100);
};

entity ZPlexRoutingTemplateGroup : managed {
  key ID : UUID;
  @title : 'Template ID'
  TemplateID : UUID not null;
  @title : 'Plex Operation ID'
  PlexOperationId : String(36) not null;
  @title : 'Object Group ID'
  GroupId : String(40) not null;
};

entity ZRoutingExcLogHDR {
  @title : 'Routing Group'
  key ProductionRoutingGroup : String(8);
  @title : 'Routing Counter'
  key ProductionRouting : String(2);
  @title : 'Header Material'
  key Material : String(40) default '';
  @title : 'Send Counter'
  Counter : Integer;
  @title : 'Send Date'
  SentDate : Date;
  @title : 'Send Time'
  SentTime : Time;
  @title : 'Status'
  Status : String(1);
  @title : 'Status Message'
  Message : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageJson : String(1000);
};

entity ZRoutingExcLogPOS {
  @title : 'Routing Group'
  key ProductionRoutingGroup : String(8);
  @title : 'Routing Counter'
  key ProductionRouting : String(2);
  @title : 'Header Material'
  key Material : String(40) default '';
  @title : 'Send Counter'
  key Counter : Integer;
  @title : 'Send Date'
  SentDate : Date;
  @title : 'Send Time'
  SentTime : Time;
  @title : 'Status'
  Status : String(1);
  @title : 'Status Message'
  Message : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageJson : String(1000);
  @title : 'Request JSON'
  RequestJson : LargeString;
  @title : 'Response JSON'
  ResponseJson : LargeString;
  @title : 'HTTP Response Status Code'
  ResponseStatus : Integer;
};

@assert.unique.plantGroup : [ Plant, GroupId ]
entity ZObjectGroup : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Group ID'
  GroupId : String(40) not null;
  @title : 'Description'
  Description : String(255);
  Fields : Composition of many ZObjectGroupField on Fields.group = $self;
};

entity ZObjectGroupField : managed {
  key ID : UUID;
  group : Association to ZObjectGroup;
  @title : 'Condition Type'
  ConditionType : String enum {
    FIELD;
    CLASS;
  } default 'FIELD';
  @title : 'Field Name'
  FieldName : String(60);
  @title : 'Field Value'
  FieldValue : String(255);
  @title : 'Class'
  Class : String(18);
  @title : 'Characteristic'
  Characteristic : String(30);
  @title : 'Characteristic Value'
  CharcValue : String(70);
};

entity ZMatPlantFieldVH {
  @title : 'Field Name'
  key FieldName : String(60);
  @title : 'Label'
  Label : String(100);
};

@assert.unique.plantField : [ Plant, PlexField ]
entity ZPlexFieldMap : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Plex Field'
  PlexField : String(40) not null;
  @title : 'Mapping Kind'
  MappingKind : String(10) not null default 'SAP_FIELD';
  @title : 'Fixed Value'
  FixedValue : String(255);
  @title : 'SAP Field'
  SapField : String(60);
  Rules : Composition of many ZPlexFieldMapRule on Rules.map = $self;
};

entity ZPlexFieldMapRule : managed {
  key ID : UUID;
  map : Association to ZPlexFieldMap;
  @title : 'Sequence'
  Sequence : Integer default 10;
  @title : 'Output Value'
  OutputValue : String(255) not null;
  Conditions : Composition of many ZPlexFieldMapRuleCond on Conditions.rule = $self;
};

entity ZPlexFieldMapRuleCond : managed {
  key ID : UUID;
  rule : Association to ZPlexFieldMapRule;
  @title : 'SAP Field'
  SapField : String(60) not null;
  @title : 'Operator'
  Operator : String(10) not null default 'EQ';
  @title : 'Value'
  Value : String(255);
};

entity ZMatFieldVH {
  @title : 'Field Name'
  key FieldName : String(60);
  @title : 'Label'
  Label : String(100);
};

@assert.unique.plantField : [ Plant, PlexField ]
entity ZPlexOpFieldMap : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Plex Field'
  PlexField : String(40) not null;
  @title : 'Mapping Kind'
  MappingKind : String(10) not null default 'FIXED';
  @title : 'Fixed Value'
  FixedValue : String(255);
  @title : 'SAP Field'
  SapField : String(60);
  Rules : Composition of many ZPlexOpFieldMapRule on Rules.map = $self;
};

entity ZPlexOpFieldMapRule : managed {
  key ID : UUID;
  map : Association to ZPlexOpFieldMap;
  @title : 'Sequence'
  Sequence : Integer default 10;
  @title : 'Output Value'
  OutputValue : String(255) not null;
  Conditions : Composition of many ZPlexOpFieldMapRuleCond on Conditions.rule = $self;
};

entity ZPlexOpFieldMapRuleCond : managed {
  key ID : UUID;
  rule : Association to ZPlexOpFieldMapRule;
  @title : 'SAP Field'
  SapField : String(60) not null;
  @title : 'Operator'
  Operator : String(10) not null default 'EQ';
  @title : 'Value'
  Value : String(255);
};

entity ZOpFieldVH {
  @title : 'Field Name'
  key FieldName : String(60);
  @title : 'Label'
  Label : String(100);
};

@assert.unique.plantScope : [ Plant, Scope ]
entity ZPlexOpTypeFilter : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Scope'
  Scope : String(10) not null;
  @title : 'Plex Operation Types (comma separated)'
  OpTypes : String(255);
};

@assert.unique.plantCat : [ Plant, CategoryName ]
entity ZMatCategory : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Category Name'
  CategoryName : String(60) not null;
  @title : 'Plex Part Type'
  PlexPartType : String(30);
  @title : 'Sequence'
  Sequence : Integer default 10;
  @title : 'Active'
  IsActive : Boolean default true;
  @title : 'Catch-all (all remaining materials)'
  IsCatchAll : Boolean default false;
  Conditions : Composition of many ZMatCategoryCond on Conditions.category = $self;
};

entity ZMatCategoryCond : managed {
  key ID : UUID;
  category : Association to ZMatCategory;
  @title : 'SAP Field'
  SapField : String(60) not null;
  @title : 'Operator'
  Operator : String(10) not null default 'EQ';
  @title : 'Value'
  Value : String(255);
};

entity ZPlexPartTypeVH {
  @title : 'Plex Part Type'
  key PartType : String(30);
  @title : 'Label'
  Label : String(100);
  @title : 'Plex Type Value'
  PlexValue : String(30);
  @title : 'Semifinished'
  IsSemifinished : Boolean default false;
  @title : 'Produced in Plex'
  IsProducedInPlex : Boolean default false;
  @title : 'Requires Receiving Operation'
  RequiresReceivingOp : Boolean default false;
};

@assert.unique.plantJobEmail : [ Plant, JobCode, Email ]
entity ZJobNotifyRecipient : managed {
  key ID : UUID;
  @title : 'Plant'
  @assert.format : '^[A-Z0-9]{1,4}$'
  Plant : String(4) not null;
  @title : 'Job'
  JobCode : String(20) not null;
  @title : 'Email'
  @PersonalData.IsPotentiallyPersonal : true
  Email : String(255) not null;
  @title : 'When To Notify'
  NotifyMode : String(10) not null default 'ALWAYS';
  @title : 'Active'
  IsActive : Boolean not null default true;
};

entity ZJobRunHDR {
  @title : 'Run ID'
  key RunId : String(36);
  @title : 'Job'
  JobCode : String(20);
  @title : 'Started At'
  StartedAt : Timestamp;
  @title : 'Finished At'
  FinishedAt : Timestamp;
  @title : 'Status'
  Status : String(1);
  @title : 'Processed'
  TotalProcessed : Integer;
  @title : 'Ok'
  TotalOk : Integer;
  @title : 'Warning'
  TotalWarning : Integer;
  @title : 'Failed'
  TotalFailed : Integer;
  @title : 'Permanently Failed'
  TotalExhausted : Integer;
  @title : 'Skipped'
  TotalSkipped : Integer;
  @title : 'Run Message'
  Message : String(255);
  @title : 'Fatal Error'
  FatalMessage : String(255);
  @title : 'Structured Run Message (i18n codes)'
  MessageJson : String(1000);
  @title : 'Structured Fatal Error (i18n codes)'
  FatalMessageJson : String(1000);
  @title : 'Mail Status'
  MailStatus : String(1);
  @title : 'Mail Message'
  MailMessage : String(255);
};

entity ZJobRunPOS {
  @title : 'Run ID'
  key RunId : String(36);
  @title : 'Record Counter'
  key Counter : Integer;
  @title : 'Plant'
  Plant : String(4);
  @title : 'Object Type'
  ObjectType : String(20);
  @title : 'Object Key'
  ObjectKey : String(150);
  @title : 'Object Key 2'
  ObjectKey2 : String(150);
  @title : 'Status'
  Status : String(1);
  @title : 'Status Message'
  Message : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageJson : String(1000);
  @title : 'Detail Log Reference'
  LogRef : String(120);
};

entity ZJobRunMail {
  @title : 'Run ID'
  key RunId : String(36);
  @title : 'Recipient'
  key Email : String(255);
  @title : 'Plants Covered'
  Plants : String(200);
  @title : 'Notify Mode'
  NotifyMode : String(10);
  @title : 'Sent At'
  SentAt : Timestamp;
  @title : 'Status'
  Status : String(1);
  @title : 'Status Message'
  Message : String(255);
  @title : 'Structured Message (i18n codes)'
  MessageJson : String(1000);
  @title : 'Attachments'
  AttachCount : Integer;
  @title : 'Attachment Bytes (raw)'
  AttachBytes : Integer;
};


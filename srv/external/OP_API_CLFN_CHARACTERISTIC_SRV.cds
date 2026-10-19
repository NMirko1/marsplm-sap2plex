@cds.external : true
@m.IsDefaultEntityContainer : 'true'
@sap.message.scope.supported : 'true'
@sap.supported.formats : 'atom json xlsx'
service OP_API_CLFN_CHARACTERISTIC_SRV {
  @cds.external : true
  @cds.persistence.skip : true
  @sap.content.version : '1'
  @sap.deletable.path : 'Delete_mc'
  @sap.updatable.path : 'Update_mc'
  @sap.label : 'Characteristic Header Data'
  entity A_ClfnCharacteristicForKeyDate {
    @sap.display.format : 'NonNegative'
    @sap.label : 'Characteristic Internal ID'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key CharcInternalID : String(10) not null;
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
    to_CharacteristicDesc_oc : Boolean;
    @sap.label : 'Dynamic CbA-Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    to_CharacteristicReference_oc : Boolean;
    @sap.label : 'Dynamic CbA-Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    to_CharacteristicRestriction_oc : Boolean;
    @sap.label : 'Dynamic CbA-Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    to_CharacteristicValue_oc : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Characteristic Name'
    Characteristic : String(30);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Status'
    @sap.quickinfo : 'Status of a characteristic'
    CharcStatus : String(1);
    @sap.label : 'Char. Status'
    @sap.quickinfo : 'Characteristic Status'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CharcStatusName : String(20);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Format'
    @sap.quickinfo : 'Data type of characteristic'
    CharcDataType : String(4);
    @sap.label : 'Number of Characters'
    CharcLength : Integer;
    @sap.label : 'Decimal Places'
    @sap.quickinfo : 'Number of Decimal Places'
    CharcDecimals : Integer;
    @sap.label : 'Template'
    @sap.quickinfo : 'Value with template'
    CharcTemplate : String(70);
    @sap.label : 'Case Sensitive'
    ValueIsCaseSensitive : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Characteristic Group'
    CharcGroup : String(10);
    @sap.label : 'Char. Group'
    @sap.quickinfo : 'Description of Characteristics Group'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CharcGroupName : String(40);
    @sap.label : 'Entry Required'
    EntryIsRequired : Boolean;
    @sap.label : 'Multiple Values Allowed'
    @sap.quickinfo : 'Multiple Values Are Allowed'
    MultipleValuesAreAllowed : Boolean;
    @sap.label : 'Internal UoM'
    @sap.quickinfo : 'Unit of Measurement'
    @sap.semantics : 'unit-of-measure'
    CharcValueUnit : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'ISO Code'
    @sap.quickinfo : 'ISO Code for Unit of Measurement'
    UnitOfMeasureISOCode : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Currency'
    @sap.quickinfo : 'Currency Key'
    @sap.semantics : 'currency-code'
    Currency : String(5);
    @sap.display.format : 'UpperCase'
    @sap.label : 'ISO Code'
    @sap.quickinfo : 'ISO Currency Code'
    CurrencyISOCode : String(3);
    @sap.label : 'Exponent'
    @sap.quickinfo : 'Exponent display'
    CharcExponentValue : Integer;
    @sap.label : 'Interval Values Allowed'
    ValueIntervalIsAllowed : Boolean;
    @sap.label : 'Additional Values'
    @sap.quickinfo : 'Indicator: Additional Values'
    AdditionalValueIsAllowed : Boolean;
    @sap.label : '+/- Sign'
    @sap.quickinfo : 'Value with Plus or Minus Sign'
    NegativeValueIsAllowed : Boolean;
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
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ChangeNumber : String(12);
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
    @sap.label : 'Authorization Group'
    @sap.quickinfo : 'Authorization Group for Characteristics Maintenance'
    CharcMaintAuthGrp : String(3);
    @sap.label : 'No Entry Allowed for Charc.'
    @sap.quickinfo : 'No Entry Allowed for Characteristic'
    CharcIsReadOnly : Boolean;
    @sap.label : 'Charc. Not To Be Displayed'
    @sap.quickinfo : 'Characteristic Not To Be Displayed'
    CharcIsHidden : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Restrictable'
    @sap.quickinfo : 'Indicator: restrictable characteristic'
    CharcIsRestrictable : String(1);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Exponent Display'
    @sap.quickinfo : 'Exponent Display Format'
    CharcExponentFormat : String(1);
    @sap.label : 'Unformatted Entry Control'
    CharcEntryIsNotFormatCtrld : Boolean;
    @sap.label : 'Display Template When Assigning Values'
    @sap.quickinfo : 'Indicator: Display Template When Assigning Values'
    CharcTemplateIsDisplayed : Boolean;
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
    @odata.Type : 'Edm.DateTimeOffset'
    @odata.Precision : 7
    @sap.label : 'Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CharcLastChangedDateTime : Timestamp;
    @sap.display.format : 'Date'
    @sap.label : 'Date data element for SYST'
    @sap.heading : ''
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    KeyDate : Date;
    to_CharacteristicDesc : Composition of many A_ClfnCharcDescForKeyDate {  };
    to_CharacteristicReference : Composition of many A_ClfnCharcRefForKeyDate {  };
    to_CharacteristicRestriction : Composition of many A_ClfnCharcRstrcnForKeyDate {  };
    to_CharacteristicValue : Composition of many A_ClfnCharcValueForKeyDate {  };
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.content.version : '1'
  @sap.deletable.path : 'Delete_mc'
  @sap.updatable.path : 'Update_mc'
  @sap.label : 'Characteristic Descriptions'
  entity A_ClfnCharcDescForKeyDate {
    @sap.display.format : 'NonNegative'
    @sap.label : 'Characteristic Internal ID'
    @sap.updatable : 'false'
    key CharcInternalID : String(10) not null;
    @sap.label : 'Language Key'
    @sap.updatable : 'false'
    key Language : String(2) not null;
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
    @sap.label : 'Characteristic Description'
    CharcDescription : String(30);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ChangeNumber : String(12);
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
    @sap.display.format : 'Date'
    @sap.label : 'Date data element for SYST'
    @sap.heading : ''
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    KeyDate : Date;
    @odata.Type : 'Edm.DateTimeOffset'
    @odata.Precision : 7
    @sap.label : 'Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CharcLastChangedDateTime : Timestamp;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.updatable : 'false'
  @sap.content.version : '1'
  @sap.deletable.path : 'Delete_mc'
  @sap.label : 'Characteristic References'
  entity A_ClfnCharcRefForKeyDate {
    @sap.display.format : 'NonNegative'
    @sap.label : 'Characteristic Internal ID'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key CharcInternalID : String(10) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Table Name'
    @sap.updatable : 'false'
    key CharcReferenceTable : String(30) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Field Name'
    @sap.updatable : 'false'
    key CharcReferenceTableField : String(30) not null;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Delete_mc : Boolean;
    @sap.display.format : 'Date'
    @sap.label : 'Date data element for SYST'
    @sap.heading : ''
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    KeyDate : Date;
    @odata.Type : 'Edm.DateTimeOffset'
    @odata.Precision : 7
    @sap.label : 'Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CharcLastChangedDateTime : Timestamp;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.updatable : 'false'
  @sap.content.version : '1'
  @sap.deletable.path : 'Delete_mc'
  @sap.label : 'Characteristic Restrictions'
  entity A_ClfnCharcRstrcnForKeyDate {
    @sap.display.format : 'NonNegative'
    @sap.label : 'Characteristic Internal ID'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key CharcInternalID : String(10) not null;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Class Type'
    @sap.updatable : 'false'
    key ClassType : String(3) not null;
    @sap.label : 'Dyn. Method Control'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    @sap.sortable : 'false'
    @sap.filterable : 'false'
    Delete_mc : Boolean;
    @sap.display.format : 'Date'
    @sap.label : 'Date data element for SYST'
    @sap.heading : ''
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    KeyDate : Date;
    @odata.Type : 'Edm.DateTimeOffset'
    @odata.Precision : 7
    @sap.label : 'Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CharcLastChangedDateTime : Timestamp;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.content.version : '1'
  @sap.deletable.path : 'Delete_mc'
  @sap.updatable.path : 'Update_mc'
  @sap.label : 'Characteristic Value Descriptions'
  entity A_ClfnCharcValueDescForKeyDate {
    @sap.display.format : 'NonNegative'
    @sap.label : 'Characteristic Internal ID'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key CharcInternalID : String(10) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Int counter values'
    @sap.quickinfo : 'Int counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key CharcValuePositionNumber : String(4) not null;
    @sap.label : 'Language Key'
    @sap.updatable : 'false'
    key Language : String(2) not null;
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
    @sap.label : 'Value description'
    @sap.quickinfo : 'Characteristic value description'
    CharcValueDescription : String(70);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ChangeNumber : String(12);
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
    @sap.display.format : 'Date'
    @sap.label : 'Date data element for SYST'
    @sap.heading : ''
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    KeyDate : Date;
    @odata.Type : 'Edm.DateTimeOffset'
    @odata.Precision : 7
    @sap.label : 'Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CharcLastChangedDateTime : Timestamp;
  };

  @cds.external : true
  @cds.persistence.skip : true
  @sap.content.version : '1'
  @sap.deletable.path : 'Delete_mc'
  @sap.updatable.path : 'Update_mc'
  @sap.label : 'Characteristic Values'
  entity A_ClfnCharcValueForKeyDate {
    @sap.display.format : 'NonNegative'
    @sap.label : 'Characteristic Internal ID'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key CharcInternalID : String(10) not null;
    @sap.display.format : 'NonNegative'
    @sap.label : 'Int counter values'
    @sap.quickinfo : 'Int counter'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    key CharcValuePositionNumber : String(4) not null;
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
    to_CharcValueDesc_oc : Boolean;
    @sap.display.format : 'UpperCase'
    @sap.label : 'Code'
    @sap.quickinfo : 'Code for value dependency'
    CharcValueDependency : String(1);
    @sap.label : 'Characteristic Value'
    CharcValue : String(70);
    @sap.label : 'Value from'
    @sap.quickinfo : 'Internal floating point from'
    CharcFromNumericValue : Double;
    @sap.label : 'Value to'
    @sap.quickinfo : 'Internal floating point value to'
    CharcToNumericValue : Double;
    @sap.label : 'Default'
    @sap.quickinfo : 'Default value'
    IsDefaultValue : Boolean;
    @sap.label : 'Internal UoM'
    @sap.quickinfo : 'Unit of Measurement'
    @sap.semantics : 'unit-of-measure'
    CharcFromNumericValueUnit : String(3);
    @sap.label : 'Internal UoM'
    @sap.quickinfo : 'Unit of Measurement'
    @sap.semantics : 'unit-of-measure'
    CharcToNumericValueUnit : String(3);
    @sap.display.format : 'NonNegative'
    @sap.label : 'Text number'
    @sap.quickinfo : 'Number of Related Text'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    LongTextID : String(4);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Change Number'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    ChangeNumber : String(12);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Type'
    DocumentType : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document'
    @sap.quickinfo : 'Document number'
    DocNumber : String(25);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Part'
    DocumentPart : String(3);
    @sap.display.format : 'UpperCase'
    @sap.label : 'Document Version'
    DocumentVersion : String(2);
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
    @sap.display.format : 'Date'
    @sap.label : 'Date data element for SYST'
    @sap.heading : ''
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    KeyDate : Date;
    @odata.Type : 'Edm.DateTimeOffset'
    @odata.Precision : 7
    @sap.label : 'Time Stamp'
    @sap.quickinfo : 'UTC Time Stamp in Long Form (YYYYMMDDhhmmssmmmuuun)'
    @sap.creatable : 'false'
    @sap.updatable : 'false'
    CharcLastChangedDateTime : Timestamp;
    to_CharcValueDesc : Composition of many A_ClfnCharcValueDescForKeyDate {  };
  };
};


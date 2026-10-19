/**
 * [MATDOC-POST] Generatore del contratto «registrazione movimento merci» verso il team Integration.
 *
 * STRUMENTO DI DESIGN TIME, NON CODICE DI RUNTIME. Sta in srv/external/ perché è lì che vive il
 * materiale di contratto verso il team Integration, e perché quella cartella NON è caricata da CAP:
 * `cds.resolve('*')` prende solo i modelli nominati da un `model:` in cds.requires, e le cartelle
 * di `cds env get folders` non sono attraversate ricorsivamente. Nessuno di questi file finisce nel
 * modello servito. Stesso posto e stesso metodo di ZMARS_BOM_EXPLOSION_SRV.edmx.
 *
 * PERCHE' UN GENERATORE
 * Il contratto copre tutti i 108 campi del documento materiale (14 testata + 94 riga) in TRE rese
 * diverse. Riprodurli a mano tre volte — tipo, MaxLength, Precision/Scale, Nullable, label — è
 * garanzia di divergenze silenziose fra le tre. Qui c'è UNA fonte, OP_API_MATERIAL_DOCUMENT_SRV.edmx,
 * cioè il servizio SAP standard, e tre emettitori: le tre rese non possono divergere per costruzione.
 *
 * COSA PRODUCE  (node srv/external/generate-matdoc-contract.js)
 *   ZMARS_MATDOC_POST_SRV.cds       sorgente del contratto OData V4 (tipi nominati + una action)
 *   ZMARS_MATDOC_POST_SRV.edmx      contratto OData V4, compilato dal .cds
 *   ZMARS_MATDOC_POST_V2_SRV.edmx   contratto OData V2 con deep insert
 *   ZMARS_MATDOC_POST.schema.json   contratto JSON puro, per un HTTPS sender senza OData
 *
 * L'EDMX V4 non è emesso da qui ma delegato a `cds compile --to edmx-v4`: il compilatore CAP è più
 * affidabile di qualunque emettitore XML scritto a mano. L'EDMX V2 invece va emesso qui, perché
 * `--to edmx-v2` su un `array of` NON rifiuta: emette un warning e produce `Collection(...)` dentro
 * un `<FunctionImport>`, XML che OData V2 non ammette e che nessun client V2 consuma.
 *
 * ATTENZIONE: i file prodotti NON vanno modificati a mano. Si cambia questo generatore e si rilancia.
 *
 * Spiegazione delle tre rese, per chi le riceve: ZMARS_MATDOC_POST_CONTRACT.md
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const SOURCE = path.join(HERE, 'OP_API_MATERIAL_DOCUMENT_SRV.edmx');
const NS = 'ZMARS_MATDOC_POST_SRV';

/** I 18 campi che l'applicazione valorizza DAVVERO oggi (srv/lib/materialDocPost.js, blocco MOCK). */
const SENT = {
  header: ['GoodsMovementCode', 'PostingDate', 'DocumentDate', 'CreationTime',
    'MaterialDocumentHeaderText', 'ReferenceDocument'],
  item: ['GoodsMovementType', 'Material', 'Plant', 'StorageLocation', 'QuantityInEntryUnit', 'EntryUnit',
    'ManufacturingOrder', 'Reservation', 'ReservationItem', 'CostCenter', 'GoodsMovementReasonCode',
    'MaterialDocumentItemText',
    // valorizzati solo sulla riga di copertura dei tipi, per collaudare dats e xfeld di riga
    'QuantityInBaseUnit', 'MaterialBaseUnit', 'ShelfLifeExpirationDate', 'ManufactureDate',
    'IsCompletelyDelivered']
};

/**
 * Le chiavi del documento le assegna SAP: non hanno senso in ingresso e vanno TOLTE dalla testata e
 * dalla riga del contratto. Lasciarle inviterebbe a valorizzarle, e un client che le manda si vede
 * rifiutare la registrazione o, peggio, la vede accettata e ignorata.
 */
const ASSIGNED_BY_SAP = ['MaterialDocumentYear', 'MaterialDocument', 'MaterialDocumentItem'];

/**
 * I campi davvero OBBLIGATORI, cioe' senza i quali il movimento non esiste. Sono meno di quelli che
 * inviamo: `CostCenter` e `GoodsMovementReasonCode` valgono solo per il 551, `ManufacturingOrder` e
 * la prenotazione solo per il 261. Derivarli da `sent` sarebbe sbagliato — `sent` marca i campi che
 * QUALCHE riga valorizza, e renderebbe lo schema piu' severo del contratto.
 */
const REQUIRED = {
  header: ['GoodsMovementCode', 'PostingDate', 'DocumentDate'],
  item: ['GoodsMovementType', 'Material', 'Plant', 'EntryUnit', 'QuantityInEntryUnit']
};

/**
 * BAPIRET2, la struttura di messaggio standard di SAP: non sta nell'EDMX sorgente, si dichiara qui.
 * I nomi sono quelli REALI confermati dalla risposta di esempio dell'iFlow, con gli underscore
 * (`LOG_NO`, `MESSAGE_V1`): e' una struttura ABAP standard, a differenza dei campi del documento che
 * derivano dall'entity type OData e infatti ne sono privi.
 */
const BAPIRET2 = [
  { name: 'TYPE', len: 1, label: 'Tipo messaggio: S riuscito, W avviso, E errore, X interruzione (anche I, A)' },
  { name: 'ID', len: 20, label: 'Classe messaggio' },
  { name: 'NUMBER', len: 3, label: 'Numero messaggio' },
  { name: 'MESSAGE', len: 220, label: 'Testo del messaggio' },
  { name: 'LOG_NO', len: 20, label: 'Numero di log' },
  { name: 'LOG_MSG_NO', len: 6, label: 'Numero messaggio nel log' },
  { name: 'MESSAGE_V1', len: 50, label: 'Variabile 1 del messaggio' },
  { name: 'MESSAGE_V2', len: 50, label: 'Variabile 2 del messaggio' },
  { name: 'MESSAGE_V3', len: 50, label: 'Variabile 3 del messaggio' },
  { name: 'MESSAGE_V4', len: 50, label: 'Variabile 4 del messaggio' },
  { name: 'PARAMETER', len: 32, label: 'Nome del parametro' },
  { name: 'ROW', len: 10, label: 'Riga nel parametro: dice a quale riga di IT_ITEM si riferisce' },
  { name: 'FIELD', len: 30, label: 'Campo nel parametro' },
  { name: 'SYSTEM', len: 10, label: 'Sistema logico mittente' }
];

/** Esito dichiarato da ET_RETURN.TYPE. Per insiemi, perche' BAPIRET2 ammette piu' valori di quelli abituali. */
const TYPE_OK = ['S'];
const TYPE_WARN = ['W', 'I'];
const TYPE_KO = ['E', 'A', 'X'];

// ---------------------------------------------------------------------------------------------
// LETTURA DELLA FONTE
// Parser XML minimale a espressioni regolari: la fonte e' un file fisso, versionato e generato da
// SAP, non input arbitrario. Evita una dipendenza per un uso solo.
// ---------------------------------------------------------------------------------------------

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1].replace(/^sap:/, '')] = m[2];
  return out;
}

function readEntityType(xml, name, source = SOURCE) {
  const re = new RegExp(`<EntityType Name="${name}"[\\s\\S]*?</EntityType>`);
  const block = xml.match(re);
  if (!block) throw new Error(`EntityType ${name} non trovato in ${source}`);
  return [...block[0].matchAll(/<Property\s[^>]*?\/>/g)].map((m) => attrs(m[0]));
}

/** Campo -> tipo CDS. La mappatura e' esplicita perche' e' il punto in cui V2 e V4 divergono. */
function cdsType(p) {
  switch (p.Type) {
    case 'Edm.String': return `String(${p.MaxLength || 255})`;
    // Precision="0" + sap:display-format="Date" = una data senza ora. In OData V4 `Edm.DateTime`
    // non esiste piu': diventa Edm.Date, cioe' il letterale ISO 'YYYY-MM-DD'.
    case 'Edm.DateTime': return p['display-format'] === 'Date' ? 'Date' : 'DateTime';
    case 'Edm.Time': return 'Time';
    case 'Edm.Decimal': return `Decimal(${p.Precision}, ${p.Scale || 0})`;
    case 'Edm.Boolean': return 'Boolean';
    default: throw new Error(`tipo EDM non mappato: ${p.Type} (${p.Name})`);
  }
}

/**
 * Campo -> tipo ABAP. E' la mappatura che governa la CODIFICA DEI VALORI, e quindi il payload che
 * parte davvero: il tipo decide il letterale XSD (vedi jsonType) perche' a valle la FM e' esposta
 * come web service e Simple Transformation valida contro i tipi dei data element.
 *
 * L'unica deduzione non ovvia: `sap:display-format="NonNegative"` su un Edm.String marca un campo
 * NUMC, cioe' numerico riempito a zeri fino alla sua lunghezza. Sono 21 campi su 108, e trattarli
 * come CHAR significherebbe mandare "1" dove SAP si aspetta "0001".
 *
 * ATTENZIONE, LIMITE NOTO: i tipi sono dedotti dall'EDMX standard S/4, mentre ST valida contro la
 * struttura Z. Tre divergenze verificate nella colonna «Tipo DDIC» dei due .xlsx qui accanto:
 * ProfitabilitySegment e' NUMC 10 e finisce `char`; GdsMvtExtAmtInCoCodeCrcy e
 * SlsPrcAmtInclVATInCoCodeCrcy sono CURR 13,2 e finiscono Decimal(14,3). Oggi non mordono perche'
 * sono campi che non valorizziamo e quindi vengono omessi; se un giorno andranno valorizzati, la
 * fonte dei tipi va spostata sugli .xlsx.
 *
 * Serve anche a generate-prodconf-fields.js, che copre l'entity della conferma d'ordine: e' la
 * ragione per cui questo file esporta i propri deduttori invece di tenerseli. UNA sola deduzione
 * EDMX -> tipo ABAP per tutto il progetto.
 */
function abapKind(p) {
  switch (p.Type) {
    case 'Edm.String': return p['display-format'] === 'NonNegative' ? 'numc' : 'char';
    case 'Edm.DateTime': return 'dats';
    case 'Edm.Time': return 'tims';
    case 'Edm.Decimal': return 'dec';
    case 'Edm.Boolean': return 'xfeld'; // CHAR1 in ABAP: "X" oppure "", mai true/false
    // I due seguenti non compaiono nel documento materiale ma nella conferma d'ordine si'.
    case 'Edm.Byte': return 'int';      // INT1: numerico SENZA riempimento a zeri, a differenza del NUMC
    case 'Edm.Guid': return 'char';     // RAW16 reso come testo: nessuna formattazione da applicare
    default: throw new Error(`tipo EDM non mappato: ${p.Type} (${p.Name})`);
  }
}

/** Voce dell'inventario: quanto basta a formattare il valore e a costruirne l'iniziale. */
function fieldEntry(p, sent) {
  const kind = abapKind(p);
  const e = { name: p.Name, abap: p.Name.toUpperCase(), kind, sent: sent.includes(p.Name) };
  if (kind === 'char' || kind === 'numc') e.length = Number(p.MaxLength || 255);
  if (kind === 'dec') { e.precision = Number(p.Precision); e.scale = Number(p.Scale || 0); }
  e.label = p.label || '';
  return e;
}

/**
 * Campo -> schema JSON. I valori sono STRINGHE con letterali XSD: il servizio a valle e' un web
 * service ABAP e i valori passano da Simple Transformation, che valida contro i tipi XSD dei data
 * element. Non e' il formato interno ABAP — quello (YYYYMMDD) e' proprio cio' che ST rifiuta.
 */
function jsonType(e) {
  const s = { type: 'string' };
  // `^(...)?$` e non `^(...)$`: ogni campo dev'essere PRESENTE nella request, e quelli senza valore
  // valgono stringa vuota. Il pattern deve quindi ammettere sia il letterale sia il vuoto.
  switch (e.kind) {
    case 'numc': s.pattern = `^([0-9]{${e.length}})?$`; break;
    case 'dats': s.pattern = '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$'; break;  // xsd:date, o vuoto
    case 'tims': s.pattern = '^([0-9]{2}:[0-9]{2}:[0-9]{2})?$'; break;  // xsd:time, o vuoto
    case 'dec': s.pattern = '^(-?[0-9]+(\\.[0-9]+)?)?$'; break;         // xsd:decimal, o vuoto
    case 'xfeld': s.enum = ['X', '']; break;
    default: s.maxLength = e.length;
  }
  return s;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const note = (p, sent) => {
  const bits = [p.label || ''];
  if (p.quickinfo && p.quickinfo !== p.label) bits.push(p.quickinfo);
  return `${sent.includes(p.Name) ? '[INVIATO] ' : ''}${bits.filter(Boolean).join(' - ')}`;
};

// ---------------------------------------------------------------------------------------------
// RESA 1 — CDS, sorgente del contratto OData V4
// ---------------------------------------------------------------------------------------------

function emitCds(header, item) {
  const line = (p, sent) => `      ${p.Name} : ${cdsType(p)}; // ${note(p, sent)}`;
  return `/**
 * [MATDOC-POST] CONTRATTO — Registrazione movimento merci, forma OData V4.
 *
 * GENERATO da srv/external/generate-matdoc-contract.js a partire da
 * OP_API_MATERIAL_DOCUMENT_SRV.edmx (il servizio SAP standard). NON MODIFICARE A MANO.
 *
 * A COSA SERVE. E' la proposta di contratto per l'endpoint che il team Integration deve realizzare.
 * NON e' un servizio che questa applicazione espone, ne' uno che consuma: srv/external/ non e'
 * caricata da CAP e nessuna entry di cds.requires lo nomina. E' un documento eseguibile.
 *
 * PERCHE' UNA ACTION E NON UN ENTITY SET. Il vincolo e' che testata e N righe arrivino in UNA sola
 * chiamata, perche' a valle BAPI_GOODSMVT_CREATE va invocata una volta con IS_HEADER + IT_ITEM: un
 * documento materiale e' atomico. Su un entity set OData quella forma sarebbe un deep insert, che il
 * team Integration ha dichiarato di non poter gestire. Un'Action non ha entity: ha parametri, e in
 * OData V4 un parametro puo' essere Collection(ComplexType). Quindi: un endpoint, una POST, N righe,
 * e nessun deep insert da nessuna parte.
 *
 * PERCHE' TIPI NOMINATI. Con strutture anonime CAP pubblica ComplexType dal nome sintetico
 * (ap_<Servizio>_<action>_<parametro>), che cambia se si rinomina il parametro. Un contratto non puo'
 * avere nomi instabili.
 *
 * EDMX:  npx cds compile srv/external/ZMARS_MATDOC_POST_SRV.cds --to edmx-v4
 * Le altre due forme e il confronto: ZMARS_MATDOC_POST_CONTRACT.md
 */

service ${NS} {

  // Testata del documento (${header.length} campi). MaterialDocument e MaterialDocumentYear non ci sono:
  // sono le chiavi assegnate da SAP e tornano nella risposta.
  type MatDocHeader {
${header.map((p) => line(p, SENT.header)).join('\n')}
  }

  // Riga del movimento (${item.length} campi). GoodsMovementType (261, 551, ...) vive QUI, non sulla testata:
  // una stessa chiamata puo' portare righe con tipi movimento diversi.
  type MatDocItem {
${item.map((p) => line(p, SENT.item)).join('\n')}
  }

  // Messaggio di esito, struttura BAPIRET2. Row porta il numero della riga di IT_ITEM a cui si
  // riferisce: senza quello, su un documento di N righe non si sa quale ha fallito.
  type BapiRet2 {
${BAPIRET2.map((f) => `      ${f.name} : String(${f.len}); // ${f.label}`).join('\n')}
  }

  type MatDocResult {
      MaterialDocument     : String(10);      // EV_MATERIAL_DOCUMENT
      MaterialDocumentYear : String(4);       // EV_MATERIAL_DOC_YEAR
      Messages             : array of BapiRet2; // ET_RETURN
  }

  /**
   * Registra UN documento materiale con N righe. Corrisponde 1:1 alla FM ZMARS_MATERIAL_DOC_POST:
   *   Header  -> IS_HEADER      Items -> IT_ITEM
   *   TestRun -> IV_TEST_RUN    ritorno -> EV_MATERIAL_DOCUMENT / EV_MATERIAL_DOC_YEAR / ET_RETURN
   *
   * TestRun serve al collaudo: valida senza registrare. Se la FM non lo espone, si ignora.
   *
   * Esito: un fallimento deve arrivare con uno stato HTTP di errore e i messaggi in Messages. Un 200
   * con esito negativo nel body verrebbe letto come registrazione riuscita, e su un flusso contabile
   * e' la peggiore modalita' di guasto possibile.
   */
  action PostMaterialDocument(
      Header  : MatDocHeader,
      Items   : array of MatDocItem,
      TestRun : Boolean
  ) returns MatDocResult;
}
`;
}

// ---------------------------------------------------------------------------------------------
// RESA 2 — EDMX OData V2 con deep insert
// Dialetto identico ai 9 EDMX gia' in srv/external/: stessi namespace, stesso uso delle sap:*.
// ---------------------------------------------------------------------------------------------

function v2Property(p, keys) {
  const a = [`Name="${p.Name}"`, `Type="${p.Type}"`];
  if (keys.includes(p.Name)) a.push('Nullable="false"');
  if (p.MaxLength) a.push(`MaxLength="${p.MaxLength}"`);
  if (p.Precision) a.push(`Precision="${p.Precision}"`);
  if (p.Scale) a.push(`Scale="${p.Scale}"`);
  if (p['display-format']) a.push(`sap:display-format="${p['display-format']}"`);
  if (p.label) a.push(`sap:label="${esc(p.label)}"`);
  if (p.quickinfo) a.push(`sap:quickinfo="${esc(p.quickinfo)}"`);
  if (p.unit) a.push(`sap:unit="${p.unit}"`);
  if (p.semantics) a.push(`sap:semantics="${p.semantics}"`);
  return `        <Property ${a.join(' ')}/>`;
}

function emitV2(header, item) {
  // Le chiavi ci sono per forza: un EntityType OData V2 DEVE averne. Sono assegnate da SAP, quindi
  // vanno inviate vuote; e' un costo della forma V2, non una richiesta.
  const hKeys = ['MaterialDocumentYear', 'MaterialDocument'];
  const iKeys = ['MaterialDocumentYear', 'MaterialDocument', 'MaterialDocumentItem'];
  const src = JSON.parse(fs.readFileSync(path.join(HERE, '.matdoc-src.json'), 'utf8'));
  const keyProps = (names) => names.map((n) => src.all.find((p) => p.Name === n));

  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  [MATDOC-POST] CONTRATTO - Registrazione movimento merci, forma OData V2 con DEEP INSERT.

  GENERATO da srv/external/generate-matdoc-contract.js a partire da OP_API_MATERIAL_DOCUMENT_SRV.edmx.
  NON MODIFICARE A MANO.

  A COSA SERVE. Proposta di contratto per l'endpoint che il team Integration deve realizzare. Non e'
  un servizio esposto ne' consumato da questa applicazione: srv/external/ non e' caricata da CAP.

  COS'E'. Un servizio OData V2 CUSTOM e MINIMALE - solo il documento materiale, nient'altro - al posto
  del servizio SAP standard API_MATERIAL_DOCUMENT_SRV. La registrazione avviene con
      POST <service root>/MatDocHeader
  e le righe annidate nella navigazione to_Item: e' un DEEP INSERT.

  QUANDO SERVE, E PERCHE' PROBABILMENTE NO. Questo EDMX va modellato nel sender adapter OData V2 di
  Cloud Integration - non passiamo dal Gateway, quindi non c'e' altro posto dove ospitarlo. Ma e'
  proprio quell'adapter ad aver rifiutato il deep insert: la forma B serve solo se il limite fosse
  per-servizio e non dell'adapter. Se e' dell'adapter, non c'e' alternativa tipizzata in OData V2 -
  le collection non sono ammesse come tipo di Property (arrivano in OData V3) e i parametri di
  FunctionImport devono essere EDMSimpleType - e la strada e' JSON su HTTPS sender
  (ZMARS_MATDOC_POST.schema.json), oppure V4 se CPI ha un sender V4 (ZMARS_MATDOC_POST_SRV.edmx).

  NOTA SUI VALORI. In OData V2 JSON: Edm.DateTime si scrive /Date(millisecondi)/ e NON in ISO;
  Edm.Decimal si scrive come stringa ("3.000"). Il letterale sbagliato produce EdmSimpleTypeException.

  Confronto delle tre forme: ZMARS_MATDOC_POST_CONTRACT.md
-->
<edmx:Edmx Version="1.0"
           xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"
           xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"
           xmlns:sap="http://www.sap.com/Protocols/SAPData">
  <edmx:DataServices m:DataServiceVersion="2.0">
    <Schema Namespace="${NS}" xml:lang="en" sap:schema-version="1"
            xmlns="http://schemas.microsoft.com/ado/2008/09/edm">

      <!-- Testata. Le chiavi sono assegnate da SAP: si inviano vuote e tornano valorizzate. -->
      <EntityType Name="MatDocHeaderType" sap:label="Material Document Header" sap:content-version="1">
        <Key>
${hKeys.map((k) => `          <PropertyRef Name="${k}"/>`).join('\n')}
        </Key>
${keyProps(hKeys).map((p) => v2Property(p, hKeys)).join('\n')}
${header.map((p) => v2Property(p, hKeys)).join('\n')}
        <!-- L'aggancio delle righe. La cardinalita' 1 -> * NON sta qui ma sull'Association. -->
        <NavigationProperty Name="to_Item"
                            Relationship="${NS}.Assoc_MatDocHeader_Item"
                            FromRole="FromRole_Assoc_MatDocHeader_Item"
                            ToRole="ToRole_Assoc_MatDocHeader_Item"/>
      </EntityType>

      <!-- Riga. GoodsMovementType (261 / 551 / ...) vive qui: righe di tipo diverso possono
           convivere nello stesso documento. -->
      <EntityType Name="MatDocItemType" sap:label="Material Document Item" sap:content-version="1">
        <Key>
${iKeys.map((k) => `          <PropertyRef Name="${k}"/>`).join('\n')}
        </Key>
${keyProps(iKeys).map((p) => v2Property(p, iKeys)).join('\n')}
${item.map((p) => v2Property(p, iKeys)).join('\n')}
      </EntityType>

      <!-- E' QUI che si dichiara il to-many, con Multiplicity="*" sul secondo End. -->
      <Association Name="Assoc_MatDocHeader_Item" sap:content-version="1">
        <End Type="${NS}.MatDocHeaderType" Multiplicity="1" Role="FromRole_Assoc_MatDocHeader_Item"/>
        <End Type="${NS}.MatDocItemType" Multiplicity="*" Role="ToRole_Assoc_MatDocHeader_Item"/>
        <ReferentialConstraint>
          <Principal Role="FromRole_Assoc_MatDocHeader_Item">
            <PropertyRef Name="MaterialDocument"/>
            <PropertyRef Name="MaterialDocumentYear"/>
          </Principal>
          <Dependent Role="ToRole_Assoc_MatDocHeader_Item">
            <PropertyRef Name="MaterialDocument"/>
            <PropertyRef Name="MaterialDocumentYear"/>
          </Dependent>
        </ReferentialConstraint>
      </Association>

      <EntityContainer Name="${NS}_Entities" m:IsDefaultEntityContainer="true"
                       sap:message-scope-supported="true" sap:supported-formats="json">
        <!-- La testata e' l'UNICO entity set creabile: e' l'endpoint della registrazione. -->
        <EntitySet Name="MatDocHeader" EntityType="${NS}.MatDocHeaderType"
                   sap:creatable="true" sap:updatable="false" sap:deletable="false"
                   sap:pageable="false" sap:content-version="1"/>
        <!-- sap:creatable="false" come nello standard: le righe NON sono creabili da sole,
             esistono solo come figlie della testata. E' cio' che rende il deep insert obbligatorio. -->
        <EntitySet Name="MatDocItem" EntityType="${NS}.MatDocItemType"
                   sap:creatable="false" sap:updatable="false" sap:deletable="false"
                   sap:pageable="false" sap:content-version="1"/>
        <AssociationSet Name="Assoc_MatDocHeader_ItemSet" Association="${NS}.Assoc_MatDocHeader_Item"
                        sap:creatable="false" sap:updatable="false" sap:deletable="false"
                        sap:content-version="1">
          <End EntitySet="MatDocHeader" Role="FromRole_Assoc_MatDocHeader_Item"/>
          <End EntitySet="MatDocItem" Role="ToRole_Assoc_MatDocHeader_Item"/>
        </AssociationSet>
      </EntityContainer>

    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;
}

// ---------------------------------------------------------------------------------------------
// RESA 3 — il contratto REALE: JSON sull'HTTPS sender di Cloud Integration
//
// Non e' piu' una proposta. E' la forma concordata, ricavata dal JSON di request e di response che
// il team Integration ha fornito, e verificata: i loro 14 + 94 nomi coincidono ESATTAMENTE con
// quelli dell'EDMX standard passati a .toUpperCase(), stesso ordine, zero divergenze.
// ---------------------------------------------------------------------------------------------

function emitJsonSchema(header, item) {
  const props = (list) => Object.fromEntries(list.map((e) => {
    const s = jsonType(e);
    s.description = `${e.sent ? '[INVIATO] ' : '[non valorizzato: presente ma vuoto] '}`
      + `${e.kind.toUpperCase()}${e.length ? `(${e.length})` : ''} ${e.label}`.trim();
    return [e.abap, s];
  }));
  const ret = Object.fromEntries(BAPIRET2.map((f) =>
    [f.name, { type: 'string', maxLength: f.len, description: f.label }]));

  return JSON.stringify({
    // draft-07 e non 2020-12: e' la versione che ogni validatore e ogni strumento di integrazione
    // supporta senza discussioni. Un contratto deve essere consumabile, non moderno.
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://marsplm.com/schemas/ZMARS_MATDOC_POST.schema.json',
    title: 'Registrazione movimento merci — ZMARS_MATERIAL_DOC_POST',
    description:
      'CONTRATTO IN ESERCIZIO fra SAP BTP e Cloud Integration. POST su un HTTPS sender '
      + '(/http/btpmars/sapecc/1110.02/materialdocument), nessuno strato OData: niente deep insert, niente '
      + 'letterali /Date(ms)/. Una sola chiamata porta testata e N righe, che l\'iFlow gira a '
      + 'BAPI_GOODSMVT_CREATE in una sola invocazione (IS_HEADER + IT_ITEM): un documento materiale '
      + 'e\' atomico, o passa tutto o non passa nulla. VALORI IN LETTERALI XSD, sempre stringa: la '
      + 'FM e\' esposta come web service e Simple Transformation valida contro i tipi XSD dei data '
      + 'element ABAP. DATS "2026-08-07", TIMS "09:30:00", NUMC riempito a zeri, DEC col punto, '
      + 'XFELD "X". I campi SENZA VALORE si OMETTONO: per una data vuota non esiste letterale '
      + 'xsd:date legale. GENERATO da srv/external/generate-matdoc-contract.js: non modificare a '
      + 'mano. Spiegazione: ZMARS_MATDOC_POST_CONTRACT.md',
    type: 'object',
    additionalProperties: false,
    required: ['IS_HEADER', 'IT_ITEM', 'IV_GOODS_MOVEMENT_CODE', 'IV_TEST_RUN'],
    properties: {
      IS_HEADER: {
        type: 'object',
        description: `Testata del documento. L'endpoint accetta ${header.length} campi; si inviano `
          + 'solo quelli valorizzati, gli altri sono omessi. MATERIALDOCUMENT e MATERIALDOCUMENTYEAR '
          + 'non si inviano mai: le assegna SAP e tornano in risposta.',
        additionalProperties: false,
        required: header.map((e) => e.abap),   // tutti presenti, anche vuoti
        properties: props(header)
      },
      IT_ITEM: {
        type: 'object',
        description: 'Tabella delle righe. L\'array e\' annidato sotto la chiave "item", come rende '
          + 'una tabella ABAP in JSON.',
        additionalProperties: false,
        required: ['item'],
        properties: {
          item: {
            type: 'array',
            minItems: 1,
            description: 'Le righe devono viaggiare TUTTE in questa chiamata: la registrazione e\' '
              + 'atomica e non e\' spezzabile in piu\' richieste.',
            items: {
              type: 'object',
              description: `Riga. L'endpoint accetta ${item.length} campi; si inviano solo quelli `
                + 'valorizzati. GOODSMOVEMENTTYPE (261, 551, ...) sta sulla riga: tipi movimento '
                + 'diversi convivono nello stesso documento.',
              additionalProperties: false,
              required: item.map((e) => e.abap),   // tutti presenti, anche vuoti
              properties: props(item)
            }
          }
        }
      },
      IV_GOODS_MOVEMENT_CODE: {
        type: 'string', maxLength: 2,
        description: 'Codice operazione movimento. 03 = goods issue, vale sia per 261 sia per 551. '
          + 'Valorizzato anche in IS_HEADER.GOODSMOVEMENTCODE, come nel loro esempio.'
      },
      IV_TEST_RUN: {
        type: 'string', enum: ['X', ''],
        description: 'XFELD. "X" valida senza registrare: e\' il presidio del collaudo.'
      }
    },
    definitions: {
      Response: {
        title: 'Risposta',
        type: 'object',
        description: 'ET_RETURN e\' una STRUTTURA singola, non una tabella: il nome e\' fuorviante ma '
          + 'e\' cosi\' per scelta. Su un documento di N righe torna un messaggio solo, e ROW dice a '
          + 'quale riga si riferisce.',
        required: ['ET_RETURN'],
        properties: {
          EV_MATERIAL_DOCUMENT: { type: 'string', maxLength: 10, description: 'Numero del documento creato' },
          EV_MATERIAL_DOC_YEAR: { type: 'string', maxLength: 4, description: 'Anno del documento creato' },
          ET_RETURN: {
            type: 'object',
            description: `TYPE dichiara l'esito: ${TYPE_OK.join('/')} riuscito, ${TYPE_WARN.join('/')} `
              + `avviso, ${TYPE_KO.join('/')} fallito. E' il campo su cui si decide.`,
            properties: ret
          }
        }
      }
    }
  }, null, 2) + '\n';
}

// ---------------------------------------------------------------------------------------------
// INVENTARIO DEI CAMPI — consumato a runtime da srv/lib/materialDocPost.js
// ---------------------------------------------------------------------------------------------

function emitFields(header, item) {
  return JSON.stringify({
    _comment: 'GENERATO da srv/external/generate-matdoc-contract.js a partire da '
      + 'OP_API_MATERIAL_DOCUMENT_SRV.edmx. NON MODIFICARE A MANO. Inventario dei 108 campi del '
      + 'documento materiale con il loro tipo ABAP: e\' cio\' da cui srv/lib/materialDocPost.js '
      + 'ricava il nome maiuscolo, la formattazione del valore e il valore iniziale. Tenerne una '
      + 'seconda copia nel codice di runtime sarebbe il modo sicuro per farle divergere.',
    _kinds: 'char = testo | numc = numerico riempito a zeri | dats = YYYYMMDD | tims = HHMMSS | '
      + 'dec = decimale col punto | xfeld = flag "X" o ""',
    header, item
  }, null, 2) + '\n';
}

// ---------------------------------------------------------------------------------------------

function main() {
  const xml = fs.readFileSync(SOURCE, 'utf8');
  const allHeader = readEntityType(xml, 'A_MaterialDocumentHeaderType');
  const allItem = readEntityType(xml, 'A_MaterialDocumentItemType');

  // Cache delle proprieta' chiave: servono alla resa V2, che le deve dichiarare comunque.
  fs.writeFileSync(path.join(HERE, '.matdoc-src.json'),
    JSON.stringify({ all: [...allHeader, ...allItem] }, null, 0));

  const header = allHeader.filter((p) => !ASSIGNED_BY_SAP.includes(p.Name));
  const item = allItem.filter((p) => !ASSIGNED_BY_SAP.includes(p.Name));

  const write = (name, content) => {
    fs.writeFileSync(path.join(HERE, name), content);
    console.log(`  ${name.padEnd(34)} ${content.split('\n').length} righe`);
  };

  // L'inventario e la resa JSON coprono TUTTI i campi, chiavi comprese: il contratto reale le
  // include (si inviano al valore iniziale, le assegna SAP). Le rese A e B, che erano proposte
  // nostre, le escludono perche' li' non avevano senso in ingresso.
  const fHeader = allHeader.map((p) => fieldEntry(p, SENT.header));
  const fItem = allItem.map((p) => fieldEntry(p, SENT.item));

  console.log(`Fonte: ${path.basename(SOURCE)} — testata ${allHeader.length} campi, riga ${allItem.length} campi`);
  console.log(`Contratto reale (RFC): testata ${fHeader.length} + riga ${fItem.length}, chiavi incluse`);
  console.log(`Rese OData A e B: testata ${header.length} + riga ${item.length}, senza ${ASSIGNED_BY_SAP.join('/')}`);
  const byKind = {};
  for (const e of [...fHeader, ...fItem]) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  console.log(`Tipi ABAP: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')}\n`);

  write('ZMARS_MATDOC_POST_SRV.cds', emitCds(header, item));
  write('ZMARS_MATDOC_POST_V2_SRV.edmx', emitV2(header, item));
  write('ZMARS_MATDOC_POST.schema.json', emitJsonSchema(fHeader, fItem));
  write('ZMARS_MATDOC_POST.fields.json', emitFields(fHeader, fItem));

  fs.unlinkSync(path.join(HERE, '.matdoc-src.json'));

  // L'EDMX V4 lo produce il compilatore CAP dal .cds appena scritto. Qui si aggiunge solo
  // l'intestazione: senza, il file arriverebbe a chi lo riceve senza dire cos'e' ne' da dove viene.
  const cdsPath = path.join(HERE, 'ZMARS_MATDOC_POST_SRV.cds');
  const xmlV4 = execFileSync('npx', ['cds', 'compile', cdsPath, '--to', 'edmx-v4'],
    { cwd: path.resolve(HERE, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const banner = `<!--
  [MATDOC-POST] CONTRATTO - Registrazione movimento merci, forma OData V4.

  GENERATO da srv/external/generate-matdoc-contract.js, che compila ZMARS_MATDOC_POST_SRV.cds con
  \`cds compile --to edmx-v4\`. NON MODIFICARE A MANO: si cambia il generatore e si rilancia.

  A COSA SERVE. Proposta di contratto per l'endpoint che il team Integration deve realizzare. Non e'
  un servizio esposto ne' consumato da questa applicazione: srv/external/ non e' caricata da CAP.

  COS'E'. Una sola Action non associata, invocata con
      POST <service root>/PostMaterialDocument
      { "Header": { ... }, "Items": [ { ... }, { ... } ], "TestRun": false }
  Nessun EntityType e nessun EntitySet in tutto il documento: non esistendo entity, non esiste
  nemmeno un deep insert da fare. Le N righe sono un parametro Collection(...), che OData V4 ammette
  e OData V2 no. E' l'unica delle tre forme che soddisfa insieme i tre vincoli: un endpoint, una
  chiamata, nessun deep insert.

  DA VERIFICARE PRIMA DI SCEGLIERLA: chi la ospita. L'endpoint non passa dal Gateway ma da Cloud
  Integration, quindi la domanda e' una sola: CPI dispone di un sender adapter OData V4? Il sender
  OData di CPI e' V2; se non esiste l'equivalente V4, questa forma non e' realizzabile e la strada
  e' ZMARS_MATDOC_POST.schema.json su HTTPS sender.

  NOTA SUI VALORI. In OData V4 JSON: le date sono ISO ("2026-08-06"), non /Date(ms)/ - Edm.DateTime
  in V4 non esiste piu'. I decimali sono numeri JSON (stringhe solo con IEEE754Compatible=true).

  Confronto delle tre forme: ZMARS_MATDOC_POST_CONTRACT.md
-->
`;
  const withBanner = xmlV4.replace(/^(<\?xml[^>]*\?>\n)/, `$1${banner}`);
  write('ZMARS_MATDOC_POST_SRV.edmx', withBanner);
}

// I deduttori sono condivisi con generate-prodconf-fields.js: una sola deduzione EDMX -> tipo ABAP.
// `main()` gira solo se il file e' invocato direttamente, altrimenti un `require` riscriverebbe i
// quattro artefatti del contratto come effetto collaterale.
module.exports = { attrs, readEntityType, abapKind, fieldEntry, jsonType };

if (require.main === module) main();

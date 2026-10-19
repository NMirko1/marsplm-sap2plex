/**
 * Codifica dei valori per le POST verso gli iFlow di SAP Integration Suite che espongono una FM
 * ABAP. FUNZIONI PURE: nessun accesso a rete, a `cds` o all'orologio.
 *
 * PERCHE' ESISTE QUESTO MODULO
 * La regola qui dentro e' stata pagata cara una volta, sul movimento merci, e vale identica per
 * ogni altra FM esposta allo stesso modo. Tenerne una seconda copia accanto al secondo chiamante
 * sarebbe il modo sicuro per farle divergere: la prima volta che qualcuno corregge un letterale ne
 * correggerebbe uno solo, e l'altro flusso continuerebbe a sbagliare in silenzio finche' non arriva
 * un'eccezione da ECC.
 *
 * LA REGOLA: LETTERALI XSD, NON FORMATO ABAP INTERNO
 * Il team Integration aveva indicato «formato ABAP», e per un po' e' stato preso alla lettera. Poi
 * la prima chiamata arrivata fino a ECC ha risposto:
 *
 *   CX_ST_DESERIALIZATION_ERROR / CX_SY_CONVERSION_NO_DATE_TIME
 *   REF_NAME: DOCUMENTDATE   VALUE: 20260807   PATTERN: yyyy-mm-dd   Role: Provider
 *
 * `CX_ST_*` e' Simple Transformation e `Role: Provider` e' un web service: la FM e' esposta come
 * servizio SOAP, e i valori sono validati contro i tipi XSD generati dai data element ABAP. Quindi
 * «formato ABAP» descriveva il parametro RFC, non il trasporto che gli sta davanti. Il letterale
 * interno YYYYMMDD e' esattamente cio' che ST rifiuta.
 *
 *   DATS  -> "2026-08-07"   (xsd:date)      NUMC  -> riempito a zeri fino alla lunghezza
 *   TIMS  -> "09:30:00"     (xsd:time)      CHAR  -> testo, nessun padding
 *   DEC   -> punto decimale, `scale` cifre  XFELD -> "X" oppure ""
 *   INT   -> numero senza riempimento       GUID  -> testo
 *
 * I campi che l'EDMX dichiara `Edm.Boolean` sono XFELD CHAR1 in ABAP: si scrivono "X" / "", MAI
 * true / false. E `sap:display-format="NonNegative"` marca un NUMC, che va riempito a zeri,
 * altrimenti si manda "1" dove SAP vuole "0001".
 *
 * TUTTI I CAMPI SONO PRESENTI, ANCHE QUELLI VUOTI
 * Il campo dev'esserci nella request. Quelli senza valore partono con la STRINGA VUOTA, non con il
 * valore iniziale ABAP: `"00000000"` su una data e' precisamente cio' che ha prodotto
 * CX_SY_CONVERSION_NO_DATE_TIME, e `"0000-00-00"` non e' una data (in XSD l'anno 0000 non esiste,
 * mese e giorno 00 mai). Per un DATS vuoto la stringa vuota e' l'unica forma rimasta, e si conta sul
 * fatto che ST mappi l'elemento vuoto sul valore iniziale.
 *
 * Due punti restano dichiaratamente incerti, e se un messaggio saltera' saltera' li' — il REF_NAME
 * dell'eccezione lo dira':
 *   - `""` su un campo DEC non e' un letterale xsd:decimal valido;
 *   - se il WSDL tipizzasse gli XFELD come xsd:boolean, `""` non sarebbe valido nemmeno li'.
 *
 * ST SI FERMA AL PRIMO VALORE ILLEGALE: un campo sbagliato per volta costa un ciclo di deploy a
 * testa, quindi conviene guardare il REF_NAME e non tirare a indovinare.
 *
 * La formattazione e' guidata dall'inventario dei campi generato dall'EDMX
 * (srv/external/generate-matdoc-contract.js, srv/external/generate-prodconf-fields.js) e non da
 * elenchi scritti a mano: e' cio' che la rende applicata a TUTTI i campi e non ai casi a cui uno
 * pensa mentre scrive.
 *
 * Chi la usa: srv/lib/materialDocPost.js [MATDOC-POST], srv/lib/prodOrderConfPost.js [PRODCONF-POST].
 * Collaudo: test/materialDocPost.test.js, test/prodOrderConfPost.test.js.
 */

'use strict';

const pad2 = (n) => String(n).padStart(2, '0');

/** Data -> `xsd:date` `YYYY-MM-DD`, in UTC. */
function toXsdDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Ora -> `xsd:time` `HH:MM:SS`, in UTC. */
function toXsdTime(d) {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Un valore c'e' oppure no. Se non c'e' si manda comunque il campo, vuoto: vedi EMPTY. */
function hasValue(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * TUTTI i campi vanno inviati, anche quelli senza valore: il campo dev'esserci nella request. Un
 * campo vuoto si scrive stringa vuota, qualunque sia il tipo. Il perche' e' nella testata.
 */
const EMPTY = '';

/**
 * Valore -> letterale XSD, secondo il tipo dichiarato nell'inventario. Sempre una stringa.
 * Da chiamare solo su valori presenti: l'assenza si gestisce con EMPTY, non qui.
 *
 * @param {object} f voce dell'inventario ({ kind, length, scale })
 * @param {*} v valore in forma naturale (Date, numero, booleano, stringa)
 */
function toAbap(f, v) {
  switch (f.kind) {
    // Si accetta anche una stringa gia' formattata, cosi' il mock puo' scrivere '2026-08-07' oppure
    // una Date indifferentemente; le due forme ABAP interne vengono comunque normalizzate.
    case 'dats': {
      if (v instanceof Date) return toXsdDate(v);
      const s = String(v);
      return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s;
    }
    case 'tims': {
      if (v instanceof Date) return toXsdTime(v);
      const s = String(v);
      return /^\d{6}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4)}` : s;
    }
    // padStart e non slice: un valore piu' lungo del campo e' un errore di dato, e troncarlo lo
    // nasconderebbe. Meglio che SAP lo rifiuti dicendo quale campo e' sbagliato.
    case 'numc': return String(v).padStart(f.length, '0');
    case 'dec': return Number(v).toFixed(f.scale);
    case 'xfeld': return (v === true || v === 'X' || v === 'x') ? 'X' : '';
    // INT1/INT2/INT4: numerico SENZA riempimento a zeri, al contrario del NUMC. Un INT1 riempito
    // sarebbe un letterale xsd:byte illegale ("007" non e' un intero canonico per ST).
    case 'int': return String(Math.trunc(Number(v)));
    default: return String(v);
  }
}

/**
 * Una struttura ABAP: TUTTI i campi dell'inventario, nell'ordine, col nome maiuscolo. Quelli senza
 * valore ci sono comunque, vuoti — il campo dev'essere presente nella request.
 *
 * @param {object[]} fields voci dell'inventario
 * @param {object} values valori in forma naturale, per nome OData
 */
function toAbapStruct(fields, values) {
  const out = {};
  for (const f of fields) {
    out[f.abap] = hasValue(values[f.name]) ? toAbap(f, values[f.name]) : EMPTY;
  }
  return out;
}

// =============================================================================================
// LA SECONDA REGOLA: JSON DI ODATA V2
//
// Serve quando l'endpoint NON e' un wrapper piatto verso la RFC ma un servizio OData V2 vero, che
// valida il payload contro un EDM. Si riconosce dalla risposta: `dataserviceversion: 1.0` e la
// busta d'errore `{"error":{"code":…,"message":{"lang":…,"value":…}}}`.
//
// E' un'altra codifica, non una variante della prima, e le differenze sono tutte quelle che
// contano:
//
//                       FM esposta a SOAP (XSD)      OData V2 (JSON)
//   nome del campo      ABAP maiuscolo               nome della proprieta' EDMX (CamelCase)
//   data                "2026-08-11"                 "/Date(1786492800000)/"  (millisecondi UTC)
//   ora                 "10:22:35"                   "PT10H22M35S"            (durata ISO 8601)
//   flag                "X" / ""                     true / false             (Edm.Boolean vero)
//   intero              "1"                          1                        (numero JSON)
//   decimale            "1.500"                      "1.500"                  (stringa, uguale)
//   NUMC                "00012345"                   "00012345"               (uguale: e' Edm.String)
//   GUID                ""                           null                     ("" non e' un Guid valido)
//   campo senza valore  presente, sempre ""          presente, ma "" / false / null secondo il tipo EDM
//
// L'ULTIMA RIGA E' LA PIU' INSIDIOSA, e ci si e' gia' sbagliato una volta. In XSD il letterale
// vuoto e' `""` per QUALUNQUE tipo. Qui no: `""` e' legale solo su `Edm.String`, mentre su un
// `Edm.DateTime` o un `Edm.Decimal` viene rifiutato dal parser. Vedi emptyODataV2.
//
// Si era anche pensato di OMETTERE i campi vuoti, che su un EDM sarebbe il modo naturale di dire
// «non fornito». L'endpoint della conferma d'ordine ha risposto che un campo omesso MANCAVA:
// dietro l'EDM c'e' una FM che vuole la struttura intera. Resta commutabile — vedi `keepEmpty`.
// =============================================================================================

/** Data -> letterale JSON di OData V2: millisecondi dall'epoca, in UTC. */
function toV2Date(d) {
  const ms = d instanceof Date
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  return `/Date(${ms})/`;
}

/** Ora -> durata ISO 8601, che e' come OData V2 rende un `Edm.Time`. */
function toV2Time(d) {
  if (d instanceof Date) return `PT${d.getUTCHours()}H${d.getUTCMinutes()}M${d.getUTCSeconds()}S`;
  const m = /^(\d{2}):?(\d{2}):?(\d{2})$/.exec(String(d));
  return m ? `PT${Number(m[1])}H${Number(m[2])}M${Number(m[3])}S` : String(d);
}

/**
 * Valore -> letterale JSON di OData V2, secondo il tipo dichiarato nell'inventario.
 * A differenza di `toAbap` NON restituisce sempre una stringa: booleani e interi sono valori JSON
 * nativi, perche' l'EDM li tipizza davvero.
 */
/**
 * I BOOLEANI SONO IL PUNTO DOVE I DUE STRATI DELL'ENDPOINT NON VANNO D'ACCORDO.
 *
 * L'EDM pubblicato dichiara `IsFinalConfirmation` come `Edm.Boolean`, quindi vuole `true`/`false`.
 * Dietro l'EDM c'e' pero' una FM ABAP esposta come web service, dove lo stesso campo e' un XFELD
 * CHAR(1): Simple Transformation ha risposto
 *
 *   CX_ST_DESERIALIZATION_ERROR / CX_SY_CONVERSION_DATA_LOSS
 *   REF_NAME: ISFINALCONFIRMATION   VALUE: false   «Data loss occurred when converting false»
 *
 * cioe' il testo `false`, 5 caratteri, non entra in un CHAR(1). E' la stessa natura dei campi del
 * movimento merci (srv/lib/materialDocPost.js: «I 4 campi che l'EDMX dichiara Edm.Boolean sono
 * XFELD CHAR1»), con una differenza che qui rende il caso peggiore: li' davanti non c'e' un EDM e
 * `"X"`/`""` passa liscio, qui l'EDM c'e' e `"X"` non e' un `Edm.Boolean` valido.
 *
 * Nessun valore soddisfa entrambi gli strati: la conversione la deve fare il mapping dell'iFlow.
 * Finche' non la fa, la leva permette di provare l'altro corno senza un rilascio.
 *
 *   'edm'   true / false   rispetta il contratto pubblicato; muore in Simple Transformation
 *   'abap'  "X" / ""       e' cio' che vuole la FM; l'EDM potrebbe rifiutarlo prima
 */
function boolLiteral(v, booleans) {
  const on = v === true || v === 'X' || v === 'x';
  return booleans === 'abap' ? (on ? 'X' : '') : on;
}

/**
 * Valore -> letterale JSON di OData V2, secondo il tipo dichiarato nell'inventario.
 * A differenza di `toAbap` NON restituisce sempre una stringa: gli interi sono numeri JSON, e i
 * booleani dipendono da `booleans` (vedi boolLiteral).
 */
function toODataV2(f, v, booleans) {
  switch (f.kind) {
    case 'dats': return toV2Date(v);
    case 'tims': return toV2Time(v);
    case 'dec': return Number(v).toFixed(f.scale);          // Edm.Decimal viaggia come stringa
    case 'xfeld': return boolLiteral(v, booleans);
    case 'int': return Math.trunc(Number(v));               // Edm.Byte: numero
    case 'numc': return String(v).padStart(f.length, '0');  // Edm.String con gli zeri davanti
    default: return String(v);
  }
}

/**
 * Il letterale VUOTO di un campo, in JSON di OData V2. Non e' uno solo per tutti, ed e' il punto
 * in cui la regola XSD e quella OData divergono in modo insidioso.
 *
 * In XSD si scrive `""` su qualunque tipo, e ci si affida a Simple Transformation per mapparlo sul
 * valore iniziale ABAP. Qui NO: su un EDM, `""` e' un letterale legale solo per `Edm.String`. Su un
 * `Edm.DateTime`, un `Edm.Decimal`, un `Edm.Byte` o un `Edm.Guid` viene rifiutato dal parser prima
 * ancora di arrivare all'applicazione.
 *
 *   String   ->  ""      e' anche il valore iniziale ABAP di CHAR e NUMC
 *   Boolean  ->  false   XFELD iniziale e' space, che l'EDM rende false
 *   il resto ->  null    l'unico modo LEGALE di dire «nessun valore» su un tipo non stringa
 *
 * SI DECIDE SUL TIPO EDM, NON SU `kind`, e la distinzione e' costata un giro di collaudo. `kind` e'
 * il tipo ABAP e serve alla codifica dei valori PRESENTI, dove `Edm.String` non basta: un NUMC va
 * riempito a zeri e un CHAR no. Ma i due non stanno in corrispondenza biunivoca, e nel verso
 * opposto si perde informazione: `Edm.Guid` finisce in `kind: 'char'` perche' per l'XSD e' testo, e
 * dedurre da li' il vuoto significa mandare `""` su un Guid. E' precisamente l'
 * `EdmSimpleTypeException` che l'endpoint della conferma d'ordine ha risposto sul campo
 * `ExternalSystemConfirmation`.
 *
 * @param {object} f voce dell'inventario; serve `edm` (tipo EDMX senza il prefisso `Edm.`)
 */
function emptyODataV2(f, booleans) {
  switch (f.edm) {
    case 'String': return '';
    case 'Boolean': return boolLiteral(false, booleans);
    default: return null;
  }
}

/**
 * Un'entity OData V2. Le chiavi dell'oggetto sono i NOMI DELLE PROPRIETA' EDMX, non i nomi ABAP.
 *
 * `keepEmpty` decide che fine fanno i campi senza valore, ed e' una scelta che l'endpoint impone,
 * non una preferenza:
 *
 *   true  (predefinito)  ci sono TUTTI, coi letterali vuoti di emptyODataV2
 *   false                ci sono solo quelli valorizzati
 *
 * Sembra che su un EDM il campo assente debba valere «non fornito», e infatti si era partiti da
 * `false`. L'endpoint della conferma d'ordine ha risposto che `OrderSuboperation` MANCAVA: dietro
 * l'EDM c'e' una FM che si aspetta la struttura intera, esattamente come sul movimento merci. Da
 * qui il default, e da qui il fatto che sia una leva e non una costante.
 *
 * @param {object[]} fields voci dell'inventario
 * @param {object} values valori in forma naturale, per nome OData
 * @param {{keepEmpty?: boolean, booleans?: string}} [opts] `booleans`: 'edm' | 'abap', vedi boolLiteral
 */
function toODataV2Entity(fields, values, { keepEmpty = true, booleans = 'edm' } = {}) {
  const out = {};
  for (const f of fields) {
    if (hasValue(values[f.name])) out[f.name] = toODataV2(f, values[f.name], booleans);
    else if (keepEmpty) out[f.name] = emptyODataV2(f, booleans);
  }
  return out;
}

module.exports = {
  toXsdDate,
  toXsdTime,
  hasValue,
  toAbap,
  toAbapStruct,
  EMPTY,
  toV2Date,
  toV2Time,
  toODataV2,
  boolLiteral,
  emptyODataV2,
  toODataV2Entity
};

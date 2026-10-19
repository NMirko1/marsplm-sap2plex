# Registrazione movimento merci — il contratto

> ## ✅ Deciso: **forma C**, JSON su HTTPS sender
>
> | | |
> |---|---|
> | **Indirizzo** | `/http/btpmars/sapecc/1110.02/materialdocument` (destination `MARS_SAP_CON`) |
> | **Messaggio** | `{ IS_HEADER, IT_ITEM: { item: [...] }, IV_GOODS_MOVEMENT_CODE, IV_TEST_RUN }` |
> | **Valori** | letterali **XSD**, sempre stringa; i campi **senza valore si omettono** |
> | **Risposta** | `EV_MATERIAL_DOCUMENT`, `EV_MATERIAL_DOC_YEAR`, `ET_RETURN` (struttura singola) |
> | **Esito** | lo dichiara `ET_RETURN.TYPE` |
> | **Schema** | [`ZMARS_MATDOC_POST.schema.json`](ZMARS_MATDOC_POST.schema.json) |
>
> Il prefisso `/http/` dice che è un **HTTPS sender** di Cloud Integration: nessuno strato OData,
> quindi la questione del deep insert non si pone più. Le forme A e B restano documentate qui sotto
> perché spiegano *perché* si è arrivati alla C, e servirebbero se un domani l'endpoint cambiasse
> natura.

Documento per il **team Integration**. Le tre forme coprono gli stessi **108 campi** del documento
materiale (14 di testata, 94 di riga), generate da un'unica fonte — il servizio SAP standard
`API_MATERIAL_DOCUMENT_SRV` — quindi non possono divergere fra loro su un tipo o una lunghezza.

---

## Il vincolo che non si negozia

A valle la registrazione avviene con **una sola chiamata RFC** (`ZMARS_MATERIAL_DOC_POST`, tipicamente
su `BAPI_GOODSMVT_CREATE`), che prende **testata + tabella righe insieme**: `IS_HEADER` + `IT_ITEM`.

Da lì discende tutto il resto:

- un documento materiale è **atomico**: N righe sono *un* documento, non N documenti;
- **non è spezzabile in N chiamate HTTP**. Ne uscirebbero N documenti separati oppure, se una fallisce a
  metà, un movimento **parzialmente registrato** — uno sbilancio contabile che nessuno riconcilia;
- quindi **il messaggio deve contenere tutte le righe**, qualunque forma abbia.

Non stiamo chiedendo il deep insert come funzionalità OData. Stiamo chiedendo **un messaggio con N
righe**. Il deep insert era solo il modo in cui OData V2 lo esprime.

---

## Le tre forme, in una tabella

Il flusso **non passa dal Gateway**: l'endpoint è **Cloud Integration**. Quindi la domanda «chi la
ospita» ha una sola risposta possibile per ciascuna forma — quale vostro **sender adapter**.

| | Forma | File | Sender adapter CPI richiesto | Deep insert? | Righe tipizzate? |
|---|---|---|---|---|---|
| **A** | OData V4, una Action | `ZMARS_MATDOC_POST_SRV.edmx` | un sender **OData V4**, se esiste | **no** | sì |
| **B** | OData V2, deep insert | `ZMARS_MATDOC_POST_V2_SRV.edmx` | il sender **OData V2** attuale | **sì** | sì |
| **C** | JSON su HTTPS | `ZMARS_MATDOC_POST.schema.json` | **HTTPS sender** | non applicabile | no, solo schema |

**Come scegliere, in una riga:** **C** se volete la strada certa e breve. **A** se CPI vi mette a
disposizione un sender OData V4. **B** solo se il limite sul deep insert è del *servizio* e non
dell'adapter.

> **Perché B è la meno probabile delle tre, ora.** L'avevamo pensata per il caso «il rifiuto riguardava
> il servizio SAP standard, non la tecnica». Ma senza Gateway non c'è alcun servizio SAP standard in
> gioco: l'endpoint lo costruite voi, e questo EDMX andrebbe modellato **nel vostro sender OData V2** —
> cioè esattamente il componente che il deep insert non lo fa. La lasciamo sul tavolo perché il limite
> potrebbe essere per-servizio invece che dell'adapter, ma è una verifica che potete fare solo voi.

---

## Perché non esiste una quarta forma

Vale la pena dirlo, perché è la ragione per cui vi mandiamo tre file invece di uno.

In **OData V2** non c'è alcun modo *tipizzato* di portare N righe in una sola POST che non sia il deep
insert:

- le **collection non sono ammesse come tipo di `<Property>`** — né di ComplexType né di primitivi.
  Sono una novità di OData V3;
- i **parametri di `<FunctionImport>` devono essere `EDMSimpleType`**. Riscontro sui 9 EDMX SAP che già
  consumiamo: 43 FunctionImport, **351 parametri, tutti `Edm.*`**; `Collection(...)` compare 2 volte su
  2996 elementi tipizzati, sempre e solo come `ReturnType`, mai in ingresso.

Resta il **`$batch` con changeset**: formalmente una sola POST a `<root>/$batch`, atomica. Non lo
proponiamo perché sposta il problema su di voi — sarebbero N richieste distinte che l'iFlow dovrebbe
ricomporre in **una sola** chiamata RFC, che è esattamente la difficoltà di partenza. Se per voi è
invece semplice, ditelo: la costruiamo.

---

## A — OData V4, una Action

**File:** `ZMARS_MATDOC_POST_SRV.edmx` (sorgente leggibile: `ZMARS_MATDOC_POST_SRV.cds`)

Il documento EDMX non contiene **nessun `<EntityType>` e nessun `<EntitySet>`**: solo quattro
`<ComplexType>` e una operazione. Non esistendo entity, non esiste nemmeno un deep insert da fare.

```xml
<Action Name="PostMaterialDocument" IsBound="false">
  <Parameter Name="Header"  Type="ZMARS_MATDOC_POST_SRV.MatDocHeader"/>
  <Parameter Name="Items"   Type="Collection(ZMARS_MATDOC_POST_SRV.MatDocItem)" Nullable="true"/>
  <Parameter Name="TestRun" Type="Edm.Boolean"/>
  <ReturnType Type="ZMARS_MATDOC_POST_SRV.MatDocResult"/>
</Action>
<ActionImport Name="PostMaterialDocument" Action="ZMARS_MATDOC_POST_SRV.PostMaterialDocument"/>
```

**Richiesta**

```jsonc
POST <service root>/PostMaterialDocument
Content-Type: application/json

{
  "Header": { "GoodsMovementCode": "03", "PostingDate": "2026-08-06", "DocumentDate": "2026-08-06",
              "MaterialDocumentHeaderText": "…", "ReferenceDocument": "…" },
  "Items": [
    { "GoodsMovementType": "261", "Material": "…", "Plant": "1010", "QuantityInEntryUnit": 3.0, "EntryUnit": "PC", … },
    { "GoodsMovementType": "261", … },
    { "GoodsMovementType": "551", … }
  ],
  "TestRun": false
}
```

**Formato dei valori** — in V4 `Edm.DateTime` **non esiste più**: le date sono `Edm.Date`, cioè ISO
`"2026-08-06"`. I decimali sono **numeri** JSON (stringhe solo se attivate `IEEE754Compatible`).

| | |
|---|---|
| A favore | L'unica forma che soddisfa insieme i tre vincoli. Righe tipizzate e validate dal modello. Nessun CSRF concettualmente legato al deep insert |
| Contro | **Va verificato che CPI possa esporla**: il sender OData di Cloud Integration è V2. Se non esiste l'equivalente V4, questa forma non è realizzabile — è l'unica cosa che ci serve sapere per escluderla o sceglierla |

---

## B — OData V2, deep insert su un servizio nostro

**File:** `ZMARS_MATDOC_POST_V2_SRV.edmx`

Un servizio OData V2 **custom e minimale** — solo il documento materiale — al posto dello standard
`API_MATERIAL_DOCUMENT_SRV`. La struttura è quella canonica V2 in tre pezzi, e vale la pena notare che
**la cardinalità to-many non sta sulla `NavigationProperty`** ma sull'`Association`:

```xml
<EntityType Name="MatDocHeaderType">
  <Key>…MaterialDocumentYear, MaterialDocument…</Key>
  <NavigationProperty Name="to_Item" Relationship="…Assoc_MatDocHeader_Item" …/>
</EntityType>

<Association Name="Assoc_MatDocHeader_Item">
  <End Type="…MatDocHeaderType" Multiplicity="1" …/>
  <End Type="…MatDocItemType"   Multiplicity="*" …/>   <!-- il to-many è QUI -->
</Association>

<EntitySet Name="MatDocHeader" … sap:creatable="true"/>
<EntitySet Name="MatDocItem"   … sap:creatable="false"/>  <!-- righe solo come figlie -->
```

**Richiesta**

```jsonc
POST <service root>/MatDocHeader

{ "GoodsMovementCode": "03",
  "PostingDate": "/Date(1786060800000)/",
  "DocumentDate": "/Date(1786060800000)/",
  "to_Item": [ { "GoodsMovementType": "261", "QuantityInEntryUnit": "3.000", … }, … ] }
```

**Formato dei valori** — attenzione, è la trappola che ci è già costata un giro: in OData V2 JSON
`Edm.DateTime` si scrive `/Date(millisecondi)/` e **non** in ISO, e `Edm.Decimal` si scrive come
**stringa**. Un letterale sbagliato produce `EdmSimpleTypeException`.

**Le chiavi** `MaterialDocument` / `MaterialDocumentYear` / `MaterialDocumentItem` compaiono negli
EntityType perché un EntityType V2 *deve* avere una chiave. Le assegna SAP: si inviano vuote e tornano
valorizzate. È un costo della forma, non una richiesta.

| | |
|---|---|
| A favore | Riusa il sender OData V2 che avete già in piedi. Righe tipizzate e validate dal modello |
| Contro | **È un deep insert**, e va modellato proprio nel sender che il deep insert non lo fa. Ha senso solo se quel limite è del singolo servizio e non dell'adapter |

---

## C — JSON su HTTPS, senza strato OData

**File:** `ZMARS_MATDOC_POST.schema.json` (JSON Schema draft-07)

**⟵ È LA FORMA SCELTA E IN ESERCIZIO.** Nessun OData: un HTTPS sender riceve il JSON e lo gira alla
RFC. Con lo strato spariscono anche tutte le cose che ci hanno bloccato — deep insert, letterali
Olingo, `EdmSimpleTypeException`.

**Indirizzo:** `POST /http/btpmars/sapecc/1110.02/materialdocument`, sulla destination `MARS_SAP_CON`.

**Richiesta** — è la firma della FM, non un involucro inventato:

```jsonc
POST /http/btpmars/sapecc/1110.02/materialdocument
Content-Type: application/json

{ "IS_HEADER": { "MATERIALDOCUMENTYEAR": "0000", "MATERIALDOCUMENT": "",
                 "DOCUMENTDATE": "20260806", "POSTINGDATE": "20260806",
                 "CREATIONDATE": "00000000", "CREATIONTIME": "000000",
                 "MATERIALDOCUMENTHEADERTEXT": "…", "GOODSMOVEMENTCODE": "03", … },  // 14 campi
  "IT_ITEM": { "item": [
      { "GOODSMOVEMENTTYPE": "261", "MATERIAL": "…", "PLANT": "1010",
        "QUANTITYINENTRYUNIT": "3.000", "ENTRYUNIT": "PC",
        "RESERVATION": "0000012345", "RESERVATIONITEM": "0001", … },                  // 94 campi
      { "GOODSMOVEMENTTYPE": "551", … } ] },
  "IV_GOODS_MOVEMENT_CODE": "03",
  "IV_TEST_RUN": "X" }
```

### Formato dei valori: letterali XSD

> ⚠️ **Correzione rispetto alla prima versione di questo documento.** Diceva «formato ABAP interno»
> e «i campi non valorizzati portano il valore iniziale ABAP». **Erano entrambe sbagliate.** Se avete
> progettato su quella versione, questo è il paragrafo da rileggere.
>
> La prima chiamata arrivata fino a ECC ha risposto:
> `CX_ST_DESERIALIZATION_ERROR / CX_SY_CONVERSION_NO_DATE_TIME`, `REF_NAME: DOCUMENTDATE`,
> `VALUE: 20260807`, `PATTERN: yyyy-mm-dd`, `Role: Provider`. `CX_ST_*` è **Simple Transformation** e
> `Role: Provider` è un **web service**: la FM è esposta come servizio SOAP, e i valori sono validati
> contro i **tipi XSD** generati dai data element ABAP. «Formato ABAP» descriveva il parametro RFC,
> non il trasporto davanti.

Ogni valore è una **stringa**:

| Tipo | Letterale | Se non valorizzato |
|---|---|---|
| `CHAR` | testo, nessun padding | **campo omesso** |
| `NUMC(n)` (**21 campi**) | zeri a sinistra fino a `n` — `"0001"`, non `"1"` | **campo omesso** |
| `DATS` (5 campi) | `xsd:date` — `"2026-08-07"` | **campo omesso** |
| `TIMS` (1 campo) | `xsd:time` — `"09:30:00"` | **campo omesso** |
| `DEC(p,s)` (4 campi) | punto, `s` decimali — `"3.000"` | **campo omesso** |
| `XFELD` (4 campi) | `"X"`, **mai** `true`/`false` | **campo omesso** |
| `IV_TEST_RUN` | `"X"` oppure `""` | **sempre presente**, vedi sotto |

**I campi senza valore non si mandano.** Non è una semplificazione: per una data vuota **non esiste
letterale `xsd:date` legale** — `"0000-00-00"` non è una data, in XSD l'anno 0000 non esiste e mese e
giorno 00 mai. Mandare un valore iniziale su quei campi produrrebbe lo stesso errore di
`DOCUMENTDATE`, e Simple Transformation **si ferma al primo valore illegale**: uno per volta sarebbe
costato sei tentativi. Per il BAPI un campo assente e un campo iniziale sono comunque la stessa cosa.

Il messaggio passa così da 108 chiavi per struttura a **5 di testata e 9–10 per riga**, circa 1 KB
invece di 8.

**`IV_TEST_RUN` è l'unica eccezione: si manda sempre**, anche come `""`. È il solo campo dove
l'assenza ha un significato pericoloso — parametro non passato, valore iniziale, cioè *registra
davvero*. Durante il collaudo vale `"X"`: valida senza registrare, ed è ciò che rende innocua la
sonda coi dati `MOCK-*`, che dal 19/08/2026 si lancia comunque solo a mano.

Lo schema è **stringente**: `additionalProperties: false`, `minItems: 1` sulle righe, `pattern` su
NUMC, date, ore e decimali, `enum` sui flag. Un payload sbagliato si scopre validando, non a runtime.

| | |
|---|---|
| A favore | La più semplice da realizzare. Nessun deep insert, nessun letterale OData. Una chiamata, una RFC, atomica |
| Contro | Niente `$metadata`: il rispetto del contratto è affidato allo schema e a chi lo applica |

---

## Corrispondenza con la FM

| Contratto | FM `ZMARS_MATERIAL_DOC_POST` |
|---|---|
| `IS_HEADER` (14 campi) | `IS_HEADER` |
| `IT_ITEM.item[]` (94 campi per riga) | `IT_ITEM` |
| `IV_GOODS_MOVEMENT_CODE` | `IV_GOODS_MOVEMENT_CODE` (e anche `IS_HEADER.GOODSMOVEMENTCODE`) |
| `IV_TEST_RUN` | `IV_TEST_RUN` |
| `EV_MATERIAL_DOCUMENT` | `EV_MATERIAL_DOCUMENT` |
| `EV_MATERIAL_DOC_YEAR` | `EV_MATERIAL_DOC_YEAR` |
| `ET_RETURN` | `ET_RETURN` (`BAPIRET2`, struttura singola) |

L'endpoint **accetta** tutti e 108 i campi, chiavi comprese; noi ne **mandiamo** solo quelli
valorizzati. `MATERIALDOCUMENT`, `MATERIALDOCUMENTYEAR` e `MATERIALDOCUMENTITEM` non li inviamo mai:
le assegna SAP e tornano in risposta.

### Cosa valorizziamo davvero

Dei 108 campi ne popoliamo **17** — 5 di testata e 12 di riga, marcati `[INVIATO]` nello schema. Gli
altri **non vengono inviati affatto**: il contratto resta ampio perché non si debba rinegoziarlo a
ogni campo nuovo, ma il messaggio porta solo ciò che ha un valore.

| | Campi |
|---|---|
| Testata | `GOODSMOVEMENTCODE` `POSTINGDATE` `DOCUMENTDATE` `MATERIALDOCUMENTHEADERTEXT` `REFERENCEDOCUMENT` |
| Riga | `GOODSMOVEMENTTYPE` `MATERIAL` `PLANT` `STORAGELOCATION` `QUANTITYINENTRYUNIT` `ENTRYUNIT` `MANUFACTURINGORDER` `RESERVATION` `RESERVATIONITEM` `COSTCENTER` `GOODSMOVEMENTREASONCODE` `MATERIALDOCUMENTITEMTEXT` |

Nemmeno tutti i 12 di riga stanno su ogni riga: un `261` porta ordine e prenotazione, un `551` porta
centro di costo e motivo. Ogni riga manda i propri.

`GOODSMOVEMENTTYPE` vive **sulla riga**, non sulla testata: un solo documento può portare `261` e `551`
insieme. `GOODSMOVEMENTCODE = '03'` (goods issue) sulla testata vale per entrambi.

> **Nota tecnica, per quando quei campi verranno valorizzati.** Il nostro inventario dei tipi deriva
> dall'EDMX del servizio standard S/4, mentre ST valida contro `ZMARS_MATDOC_S_*`. Confrontandolo con
> la colonna *Tipo DDIC* dei vostri file emergono tre divergenze: `ProfitabilitySegment` è `NUMC 10`
> (noi lo tratteremmo come testo), `GdsMvtExtAmtInCoCodeCrcy` e `SlsPrcAmtInclVATInCoCodeCrcy` sono
> `CURR 13,2` (noi useremmo 3 decimali). Oggi non mordono perché quei campi sono omessi. Se un domani
> serviranno, o ci confermate i tipi o rifacciamo l'inventario sui data element.

---

## La risposta

```jsonc
{ "EV_MATERIAL_DOCUMENT": "4900001234",
  "EV_MATERIAL_DOC_YEAR": "2026",
  "ET_RETURN": { "TYPE": "S", "ID": "M7", "NUMBER": "060", "MESSAGE": "…",
                 "LOG_NO": "", "LOG_MSG_NO": "", "MESSAGE_V1".."V4": "",
                 "PARAMETER": "", "ROW": "1", "FIELD": "", "SYSTEM": "" } }
```

**`TYPE` dichiara l'esito**, ed è il campo su cui decidiamo:

| `TYPE` | Come lo leggiamo |
|---|---|
| `S` | registrato |
| `W` `I` | registrato, con avviso |
| `E` `A` `X` | **fallito**, anche con HTTP 200 |
| vuoto o ignoto | **fallito**: nel dubbio non diamo mai per registrato un movimento |

Un `TYPE = S` senza `EV_MATERIAL_DOCUMENT` lo segnaliamo come incoerenza invece di lasciarlo passare.

`ET_RETURN` è una **struttura singola**, non una tabella — il nome è fuorviante ma è così per scelta.
La registrazione resta atomica: un header, N righe, un documento, o tutto o niente. Il messaggio
singolo riguarda solo la diagnostica, e `ROW` dice a quale riga si riferisce.

Da parte nostra: registriamo l'intero scambio nel log e **non ritentiamo** — una registrazione di
movimento merci non è idempotente.

---

## Domande aperte

1. **Il WSDL, o l'XSD, del servizio SOAP a valle.** È la richiesta più utile che possiate esaudire:
   dice in un colpo il tipo di ogni campo, se gli elementi sono opzionali e come si scrive una data
   iniziale. Oggi stiamo deducendo tutto questo da un messaggio di errore, un tentativo per volta.
2. **In caso di errore applicativo del BAPI, cosa torna?** Un `ET_RETURN` con `TYPE = E`, oppure un
   `500` opaco come quello ricevuto? Il nostro lettore è pronto per la prima forma. Se rispondete
   sempre `500`, perdiamo il messaggio SAP e con esso `ROW`, cioè quale riga ha fallito — e ci resta
   solo l'MPL ID da girarvi.
3. **Campi omessi**: confermate che va bene non inviare i campi senza valore? Per un `DATS` vuoto non
   c'è alternativa legale, e l'abbiamo esteso a tutti per coerenza. Se qualche elemento fosse
   obbligatorio nel WSDL, ditecelo e lo valorizziamo.
4. **`GOODSMOVEMENTCODE`** compare sia in `IS_HEADER` sia come `IV_GOODS_MOVEMENT_CODE`. Uno dei due
   prevale, o vanno valorizzati entrambi? Oggi li valorizziamo entrambi, come nel vostro esempio.
5. **Campi obbligatori**: dei 94 di riga ne inviamo al più 12. Ne mancano di obbligatori per
   `BAPI_GOODSMVT_CREATE` sui movimenti `261` e `551`?

**Chiuse**: forma del messaggio, indirizzo, involucro della risposta, `IV_TEST_RUN`, natura di
`ET_RETURN`, ruolo `ESBMessaging.send`, e il **CSRF** — l'HTTPS sender non lo richiede (verificato:
chiamata entrata senza token), quindi abbiamo smesso di chiederlo e non arrivano più le due `HEAD`
di preflight.

---

## Nota sui file

Sono **proposte di contratto**, non servizi in esercizio: vivono in `srv/external/` insieme all'altro
materiale di analisi e non sono né esposti né consumati dall'applicazione BTP.

Sono **generati** da `srv/external/generate-matdoc-contract.js` a partire da
`OP_API_MATERIAL_DOCUMENT_SRV.edmx`: se un campo va aggiunto o cambiato si modifica il generatore e si
rilancia, così le tre forme restano allineate. **Non vanno modificati a mano.**

Stato della chiamata che parte oggi, con dati di prova: `MATERIAL_DOC_POST_IS.md`.

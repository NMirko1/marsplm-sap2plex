# Conferma d'ordine di produzione — contratto della chiamata BTP → Integration Suite

Documento per il **team Integration**. Descrive la chiamata che l'applicazione SAP BTP (Mars PLM
SAP-Plex) invia all'iFlow di conferma ordine di produzione: indirizzo, forma del messaggio, campo per
campo, e cosa si aspetta di ricevere indietro.

> **Stato: collaudo su dati veri.** La chiamata è **già attiva e parte davvero**: quanto descritto qui
> non è una proposta, è ciò che il vostro endpoint riceve oggi. Dal **17/08/2026** i dati non sono più
> un mock su un ordine inesistente ma un **time ticket collaudato a mano in CO11N**, che SAP registra:
> vedi § 0, che è cambiato. Dal **18/08/2026** il messaggio è cambiato in due punti, per due rifiuti
> del BAPI che erano difetti nostri: la sequenza va in **formato interno** e i **tempi di lavorazione
> non si mandano più** — § 3-quater. Provvisorio resta il **momento in cui parte**, per ora l'apertura
> della dashboard del cockpit. È lo stesso metodo già usato per il movimento merci
> ([MATERIAL_DOC_POST_IS.md](MATERIAL_DOC_POST_IS.md)).
>
> **Aggiornamento 19/08/2026.** Il messaggio è invariato, cambia **quando parte**: non è più
> agganciato all'apertura della dashboard — che lo ripeteva a ogni refresh — ma si lancia a mano,
> una volta, quando serve misurare. Nel vostro monitor vedrete quindi molti meno messaggi su
> quest'ordine, e ognuno corrisponde a una prova deliberata.
>
> **Aggiornamento 25/08/2026 — da sonda a FLUSSO.** Questo indirizzo smette di essere solo un banco di
> prova: il job `PROD_CONF` lo usa per **registrare la conferma d'ordine** delle registrazioni di
> produzione che arrivano da Plex, su ogni plant configurato per farlo. Cambia il *chiamante*, non il
> messaggio: stessa rotta, stessa forma `entity`, stessi 105 campi. Tre differenze che vi riguardano,
> tutte nel § 6:
>
> 1. il messaggio non porta più `OrderOperation` e `Sequence` — è una conferma di **testata**;
> 2. `APICONFHASNOGOODSMOVEMENTS` arriva a **`false`**: i movimenti li deve fare SAP;
> 3. **`LT_DETAIL` nella risposta diventa una precondizione**, non un miglioramento: senza, un rifiuto
>    su un flusso di esercizio è muto, e finora il motivo l'abbiamo letto tre volte su tre col
>    debugger su ECC.
>
> **Aggiornamento 02/09/2026 — la risposta è quella che ci avete dichiarato, e il § 4 è riscritto.**
> Ci avete detto: a buon fine tornano **`OrderID` e `ConfirmationText`**, se non funziona torna il
> **solo `ConfirmationText`**, e dentro c'è il motivo. Il nostro lettore lo applica: l'esito lo dice
> `OrderID`, il motivo lo dice il testo, ed entrambi finiscono nello storico dell'ordine. Due
> conseguenze per voi, nel § 4:
>
> 1. **la richiesta del punto 3 qui sopra si chiude.** `LT_DETAIL` non è più una precondizione,
>    perché il motivo del rifiuto adesso arriva. Se un giorno lo mappate comunque, lo leggiamo e ha
>    la precedenza: `TYPE`, `ID` e `NUMBER` dicono di più di una frase sola;
> 2. **`OrderID` sulla risposta è ora l'esito, quindi va valorizzato SOLO quando la conferma è
>    registrata.** Se un giorno l'iFlow ricominciasse a rimandare l'eco intera della richiesta — dove
>    `OrderID` c'è comunque — leggeremmo «registrata» su un rifiuto. Ce ne difendiamo (§ 4) e
>    preferiamo dirlo: se cambiate la forma della risposta, avvisateci.

---

## 0. La cosa da leggere per prima: l'ordine ora è vero, e la conferma viene registrata

La conferma d'ordine, a differenza del movimento merci, **non ha un parametro di esecuzione in
prova**. La FM `ZMARS_MATERIAL_DOC_POST` espone `IV_TEST_RUN` e ci permette di validare senza
registrare; la specifica di `ZMARS_PROD_ORDER_CONF_POST` non prevede nulla di equivalente.

Fino al 16/08/2026 quel vuoto era coperto dal dato: mandavamo `ORDERID = "999999999999"`, che non è
un ordine, e la risposta «ordine non esistente» dimostrava che il messaggio aveva attraversato
l'iFlow. Era una prova a metà — diceva che il messaggio **arriva**, non che SAP lo **accetta** — e la
migrazione del flusso PROD_CONF ha bisogno della seconda.

Dal **17/08/2026** mandiamo quindi un time ticket **collaudato a mano in CO11N**, che SAP registra:

| campo CO11N | valore | campo del messaggio |
|---|---|---|
| Order | `700000080` | `OrderID = "000700000080"` (formato interno, vedi sotto) |
| Oper./activity | `0020` | `OrderOperation = "0020"` |
| Sequence | `0` | `Sequence = "000000"` (formato interno, vedi § 3-quater) |
| Work center / Plant | `07000010` / `07` | `WorkCenter` / `Plant` |
| Yield / Unit | `1` / `PZ` | `ConfirmationYieldQuantity` / `ConfirmationUnit` |
| Scrap, Reason for Var. | vuoti | non valorizzati |
| Confirm.type | conferma finale | `IsFinalConfirmation = true` |
| Clear open reservations | spuntato | `OpenReservationsIsCleared = true` |

**Conseguenze, che vi riguardano:**

- una risposta con `CONFIRMATIONGROUP` / `CONFIRMATIONCOUNT` valorizzati è ora **l'esito buono**, non
  un allarme: significa che l'integrazione funziona da un capo all'altro;
- ogni lancio della sonda fa partire una chiamata, quindi **registra**. Dopo la prima riuscita le
  successive saranno quasi certamente rifiutate da SAP, perché l'operazione risulta già confermata
  finalmente: se nel vostro monitor vedete messaggi accettati dall'iFlow e rifiutati dal BAPI su
  quest'ordine, **è questo** e non un vostro problema. Dal 19/08/2026 il lancio è manuale, quindi
  la raffica che vedevate a ogni nostro refresh non c'è più;
- possiamo fermare tutto in qualunque momento, per singolo stabilimento, dal nostro customizing
  (`ConfPostEnabled` sulla scheda del plant): senza rilascio e senza toccare l'iFlow. Se vi serve,
  chiedete. Fino al 09/09/2026 il fermo era una variabile d'ambiente valida per tutti gli
  stabilimenti insieme, e richiedeva un nostro rilascio per riaprirsi.

**`OrderID` va in formato interno.** `AFRU-AUFNR` è AUFNR CHAR(12) con conversion exit ALPHA, quindi
mandiamo `000700000080` e non `700000080`. Se il vostro mapping applica già la conversione e
preferisce il formato esterno, ditelo: lo commutiamo con una variabile d'ambiente.

**Un `IV_TEST_RUN` resta la cosa giusta da avere.** Se lo aggiungete alla firma della FM, per noi è
una riga e questa sezione torna a essere una nota tecnica invece di un avviso.

---

## 1. La chiamata

| | |
|---|---|
| **Metodo** | `POST` |
| **iFlow** | `F1110.01_Operations_SAPBTPMARS_SAPECC_ProductionOrder_Confirmation_Post` |
| **Service root** | `/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_PRODUCTIONORDER_CONFIRMATION_POST;v=1` |
| **Entity set** | `ProdnOrdConf2` |
| **URL completo** | `<host destination>/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_PRODUCTIONORDER_CONFIRMATION_POST;v=1/ProdnOrdConf2` |
| **Destination BTP** | `MARS_SAP_CON` |
| **Content-Type** | `application/json` |
| **Accept** | `application/json,text/plain` |

L'indirizzo è quello che ci avete pubblicato in `EndpointFlussiMARS_V1.xlsx`, voce **N. 22**
(`ProdnOrdConf2` / `ZMARS_PROD_ORDER_CONF_POST`).

Header aggiuntivi che accompagnano ogni chiamata:

| Header | Valore | A cosa serve |
|---|---|---|
| `x-correlation-id` / `x-correlationid` | UUID, uno per chiamata | **Chiave di riconciliazione.** È lo stesso identificativo che compare nel nostro log: citandolo, ritrovate il messaggio esatto nel vostro monitor. Lo indicheremo in ogni segnalazione. |
| `sap-client` | dalla destination | mandante |
| `authorization` | dalla destination | non è mai loggato in chiaro da parte nostra |

### Quello che abbiamo già imparato dalla prima chiamata

L'endpoint **risponde**, il **CSRF funziona** (token richiesto e ottenuto) e il messaggio arriva.
Quello che ha rifiutato è il corpo. L'11/08/2026, mandando la busta della FM:

```
HTTP 500    server: SAP    dataserviceversion: 1.0    content-type: application/json
{"error":{"code":"INTERNAL_SERVER_ERROR","message":{"lang":"en",
  "value":"Illegal argument for method call with message 'IS_CONFIRMATION'."}}}
```

`dataserviceversion: 1.0` e quella busta d'errore sono di un servizio **OData V2 vero**, che valida
il corpo contro un EDM: `IS_CONFIRMATION` non è una sua proprietà. È la stessa contraddizione emersa
sul movimento merci (§ 0 di [MATERIAL_DOC_POST_IS.md](MATERIAL_DOC_POST_IS.md)), con una differenza
che cambia tutto: **qui non serve un deep insert**, perché la conferma è una struttura singola e non
una testata con N righe. Una POST OData sull'entity set è quindi perfettamente fattibile.

Abbiamo perciò **due forme del corpo**, commutabili da noi senza rilascio:

| forma | corpo | quando |
|---|---|---|
| `entity` *(attiva)* | l'entity `ProdnOrdConf2` piatta, nomi EDMX, JSON di OData V2 | è coerente con ciò che l'endpoint ha dichiarato di essere |
| `fm` | `{IS_CONFIRMATION, IV_POST_ERRORS}`, nomi ABAP, letterali XSD | se l'indirizzo diventasse un HTTPS sender, com'è finita per il movimento merci |

**Da adesso mandiamo la forma `entity`.** Se non è quella giusta, ditecelo: la rimettiamo su `fm`
con una variabile d'ambiente.

Interroghiamo anche il **`$metadata`** del service root prima di ogni POST — è una lettura senza
effetti — e ne riportiamo entity type e proprietà nel nostro log. **Risponde**, e conferma che
l'endpoint espone `ProdnOrdConf2Type` con le sue 107 proprietà standard, `ProdnOrdConfMatlDocItmType`
e `ProdnOrderConfBatchCharcType`: i nostri nomi di campo e i nostri tipi combaciano con i vostri. Su
questo non ci sono più domande aperte.

### CSRF

Il fetch del token è **attivo** per default su questa chiamata, al contrario del movimento merci. La
ragione è la storia del matdoc: il primo indirizzo era un sender OData V2 e rispondeva `403` con la
pagina d'errore di Tomcat più `x-csrf-token: Required` — era il `CsrfPreventionFilter`. Sull'HTTPS
sender attuale non serve, e infatti lì l'abbiamo spento.

Se questo endpoint non lo pretende, lo spegniamo anche qui: il fetch fa due `HEAD` allo stesso
indirizzo prima della `POST`, e su un HTTPS sender rischiano di generare voci MPL spurie nel vostro
monitor.

---

## 2. Forma del messaggio

> Questa sezione descrive la forma **`fm`**, che è quella che l'endpoint ha rifiutato (§ 1). Resta
> documentata perché è la forma giusta se l'indirizzo diventasse un HTTPS sender. La forma **oggi
> attiva** è `entity`, descritta al § 2-bis.

Il messaggio è la firma della FM `ZMARS_PROD_ORDER_CONF_POST`, come da vostra proposta di specifica
in [Endpoint_OData_Integration-20260728 (1).md](<Endpoint_OData_Integration-20260728 (1).md>):

```json
{
  "IS_CONFIRMATION": { "…105 campi…" },
  "IV_POST_ERRORS": ""
}
```

- **`IS_CONFIRMATION`** — i campi dell'entity type `ProdnOrdConf2Type`, coi nomi in **maiuscolo**.
  Ci sono **tutti**, anche quelli senza valore: il campo dev'essere presente nella request, e quelli
  non valorizzati partono con la **stringa vuota**.
- **`ConfirmationGroup` / `ConfirmationCount`** — le assegna SAP, quindi **non le inviamo affatto**:
  non ci sono nella request, nemmeno vuote. Sono i due campi che distinguono le 105 della richiesta
  dalle 107 della risposta.
- **`IV_POST_ERRORS`** — `XFELD`, quindi `"X"` oppure `""`, mai `true`/`false`. Lo inviamo **vuoto**:
  non vi chiediamo di registrare conferme con errori risolvibili.

### La codifica dei valori: letterali XSD, non formato ABAP interno

Questa parte l'abbiamo già pagata una volta, sul movimento merci, e la riportiamo qui perché vale
identica. La prima chiamata arrivata fino a ECC aveva risposto:

```
CX_ST_DESERIALIZATION_ERROR / CX_SY_CONVERSION_NO_DATE_TIME
REF_NAME: DOCUMENTDATE   VALUE: 20260807   PATTERN: yyyy-mm-dd   Role: Provider
```

`CX_ST_*` è Simple Transformation e `Role: Provider` è un web service: la FM è esposta come servizio
SOAP, e i valori sono validati contro i tipi XSD generati dai data element ABAP. Il letterale interno
`YYYYMMDD` è esattamente ciò che ST rifiuta. Quindi:

| Tipo ABAP | Come lo scriviamo | Esempio |
|---|---|---|
| `DATS` | `xsd:date` | `"2026-08-11"` |
| `TIMS` | `xsd:time` | `"09:30:05"` |
| `NUMC` | riempito a zeri fino alla lunghezza | `"00012345"` su un NUMC(8) |
| `INT1` | numero, **senza** riempimento | `"1"` |
| `DEC` | punto decimale, `scale` cifre | `"1.500"` |
| `XFELD` | `"X"` oppure `""` | mai `true`/`false` |
| `CHAR` | testo, nessun padding | `"07"` su un CHAR(4) |

I tipi sono dedotti dall'EDMX standard `OP_API_PROD_ORDER_CONFIRMATIO_2_SRV_0001`, non scritti a
mano: l'inventario è generato da [generate-prodconf-fields.js](generate-prodconf-fields.js) e la
codifica è applicata a tutti e 105 i campi della richiesta.

**Due punti restano dichiaratamente incerti**, e se il messaggio salterà salterà lì — il `REF_NAME`
dell'eccezione ce lo dirà:

- `""` su un campo `DEC` non è un letterale `xsd:decimal` valido;
- se il WSDL tipizzasse gli `XFELD` come `xsd:boolean`, `""` non sarebbe valido nemmeno lì.

Sappiamo che **ST si ferma al primo valore illegale**: un campo sbagliato per volta costa un ciclo di
deploy a testa. Se vedete l'eccezione, mandateci il `REF_NAME` e il `VALUE`, non solo il codice HTTP.

---

## 2-bis. Forma `entity` — quella che mandiamo oggi

L'entity `ProdnOrdConf2` **piatta**, senza involucro. Cambiano tre cose rispetto al § 2, e sono
tutte quelle che contano:

| | forma `fm` (XSD) | forma `entity` (OData V2) |
|---|---|---|
| nome del campo | ABAP maiuscolo `ORDERID` | proprietà EDMX `OrderID` |
| data | `"2026-08-11"` | `"/Date(1786492800000)/"` |
| ora | `"10:22:35"` | `"PT10H22M35S"` |
| flag | `"X"` / `""` | `true` / `false` |
| intero | `"1"` | `1` |
| decimale | `"1.500"` | `"1.500"` *(uguale)* |
| NUMC | `"00012345"` | `"00012345"` *(uguale: è `Edm.String`)* |
| **campo senza valore** | presente, sempre `""` | presente, ma `""` / `false` / `null` **secondo il tipo** |

L'ultima riga merita due parole, perché ci siamo già sbagliati una volta.

Eravamo partiti **omettendo** i campi senza valore: su un EDM il campo assente vale «non fornito»,
che sembra proprio ciò che si vuole dire, e il corpo scendeva da 105 campi a 18. Ci avete risposto
che **`OrderSuboperation` mancava**. Dietro l'EDM c'è una FM che vuole la struttura intera, come già
sul movimento merci: quindi **li mandiamo tutti e 105**.

Ma il letterale vuoto non può essere `""` per tutti, come invece è in XSD: su un `Edm.DateTime` o un
`Edm.Decimal` è illegale e lo rifiuta il parser prima di arrivare a voi. Quindi:

| tipo EDM | quanti | vuoto |
|---|---|---|
| `Edm.String` (CHAR, NUMC) | 58 | `""` |
| `Edm.Boolean` (XFELD) | 12 | `false` |
| `Edm.DateTime`, `Edm.Time`, `Edm.Decimal`, `Edm.Byte`, `Edm.Guid` | 35 | `null` |

Il vuoto si decide sul **tipo EDM**, non sul tipo ABAP, e la distinzione ci è costata un giro di
collaudo: `ExternalSystemConfirmation` è `Edm.Guid`, per l'ABAP è testo, e mandarlo come `""` vi
faceva rispondere `400 EdmSimpleTypeException`. Ora è `null`.

**Se `null` non vi va bene su qualcuno di questi, ditecelo**: è l'unica forma legale che conosciamo
per dire «nessun valore» su un tipo non stringa, ma se la vostra FM si aspetta altro lo cambiamo.

> Una richiesta, per i prossimi giri: `EdmSimpleTypeException` **non dice quale campo** ha il
> letterale invalido, e su 105 campi trovarlo costa un tentativo a testa. Se nel vostro monitor
> quell'eccezione riporta il nome della proprietà, giratecelo: è l'unica informazione che serve.
> Nel frattempo il nostro log elenca, per ciascun tipo EDM, i letterali che gli passiamo — così un
> valore fuori posto si vede a occhio.

### I booleani: i due strati chiedono cose incompatibili

Superata la validazione dell'EDM, il messaggio arriva in ABAP e `SRT_UTIL` risponde:

```
CX_ST_DESERIALIZATION_ERROR
  CLASSNAME  CX_SY_CONVERSION_DATA_LOSS
  REF_NAME   ISFINALCONFIRMATION
  VALUE      false          «Data loss occurred when converting false»
```

È una buona notizia sul percorso — il messaggio **ha superato l'EDM ed è arrivato alla FM** — e un
problema di contratto:

- il vostro **`$metadata` dichiara `IsFinalConfirmation` come `Edm.Boolean`**, quindi il solo valore
  che possiamo mandare è `true` / `false`;
- la **struttura ABAP dietro** ha lo stesso campo come **XFELD `CHAR(1)`**, dove il testo `false`
  (5 caratteri) non entra: da qui il *data loss*.

**Nessun valore soddisfa entrambi gli strati.** Se mandiamo `"X"` / `""`, che è ciò che vuole la FM,
è l'EDM a rifiutarlo — `"X"` non è un `Edm.Boolean` valido. La conversione va fatta nel **mapping
dell'iFlow**, fra il sender OData e la chiamata al web service: `true` → `X`, `false` → *space*.

Sono **12 campi**, tutti gli `Edm.Boolean` dell'entity: `IsFinalConfirmation`,
`OpenReservationsIsCleared`, `IsReversed`, `IsReversal`, `APIConfHasNoGoodsMovements`,
`NoFurtherOpWorkQuantity1..6IsExpd`, `NoFurtherBusinessProcQtyIsExpd`.

Nel frattempo teniamo `true`/`false`, perché è il contratto che pubblicate voi e mandare altro di
nostra iniziativa vorrebbe dire violarlo. Se preferite che proviamo `"X"` / `""` ditecelo: è una
variabile d'ambiente, nessun rilascio. E se anche quella venisse respinta — stavolta dall'EDM — la
coppia di errori sarà la dimostrazione che il problema non sta nel nostro messaggio.

> Vale la pena notare che sul **movimento merci** questo problema non si presenta: lì l'endpoint è
> un HTTPS sender senza EDM davanti, e infatti mandiamo `"X"` / `""` da sempre. È la presenza del
> sender OData a creare il conflitto.

Il corpo che vi arriva in questa forma — qui coi soli campi valorizzati, gli altri 90 ci sono con il
loro vuoto:

```json
{
  "OrderID": "000700000080",
  "Sequence": "000000",
  "OrderOperation": "0020",
  "OrderSuboperation": "",
  "Plant": "07",
  "WorkCenter": "07000010",
  "ConfirmationYieldQuantity": "1.000",
  "ConfirmationUnit": "PZ",
  "IsFinalConfirmation": true,
  "OpenReservationsIsCleared": true,
  "APIConfHasNoGoodsMovements": true,
  "ConfirmationText": "MARS-BTP sonda conferma 700000080/0020",
  "PostingDate": "/Date(1786924800000)/",
  "ConfirmedProcessingStartDate": null,
  "ConfirmedProcessingEndDate": null,
  "ConfirmedProcessingStartTime": null,
  "ConfirmedProcessingEndTime": null,
  "Material": "",
  "ConfirmationScrapQuantity": null,
  "OrderPlannedTotalQty": null,
  "ConfirmationEntryDate": null,
  "IsReversed": false,
  "…gli altri…": "vuoti secondo il tipo"
}
```

`ConfirmationGroup` e `ConfirmationCount` non ci sono nemmeno qui, in nessuna forma: le assegnate voi.

`IV_POST_ERRORS` non ha dove stare su un'entity, e non è una perdita: lo mandavamo vuoto, che è il
comportamento predefinito.

### Limite noto sui tipi

L'inventario deduce i tipi dall'EDMX standard S/4, mentre ST valida contro `ZMARS_PRODCONF_S_CONF`.
Le due fonti possono divergere, come è già successo su tre campi del movimento merci. Oggi
valorizziamo **12 campi su 105** — erano 15 fino al 18/08/2026, poi i tre tempi di lavorazione sono
usciti (§ 3-quater) — quindi la superficie è piccola; se un domani ne servissero altri, i
data element veri sono in [ZMARS_PRODCONF_S_CONF_DataElements.xlsx](ZMARS_PRODCONF_S_CONF_DataElements.xlsx).

---

## 3. Il messaggio che ricevete oggi

Questo è il body esatto, con i 90 campi vuoti elisi per leggibilità (nella request **ci sono
tutti**, valorizzati a `""`):

```json
{
  "IS_CONFIRMATION": {
    "ORDERID": "000700000080",
    "SEQUENCE": "0",
    "ORDEROPERATION": "0020",
    "CONFIRMATIONTEXT": "MARS-BTP sonda conferma 700000080/0020",
    "ISFINALCONFIRMATION": "X",
    "OPENRESERVATIONSISCLEARED": "X",
    "APICONFHASNOGOODSMOVEMENTS": "X",
    "PLANT": "07",
    "WORKCENTER": "07000010",
    "POSTINGDATE": "2026-08-17",
    "CONFIRMEDPROCESSINGSTARTDATE": "2026-08-17",
    "CONFIRMEDPROCESSINGSTARTTIME": "14:22:35",
    "CONFIRMEDPROCESSINGENDDATE": "2026-08-17",
    "CONFIRMATIONUNIT": "PZ",
    "CONFIRMATIONYIELDQUANTITY": "1.000",
    "…altri 90 campi…": ""
  },
  "IV_POST_ERRORS": ""
}
```

Totale: **105 campi**. `CONFIRMATIONGROUP` e `CONFIRMATIONCOUNT` non ci sono, come da § 2.

### Perché proprio questi campi, e perché due dello screenshot non ci sono

I quindici valori sono gli **input** del time ticket collaudato in CO11N (§ 0). Due campi che in
quella schermata si vedono **non li mandiamo**, di proposito:

- **`MATERIAL`** è `AFPO-MATNR`: lo derivate voi dall'ordine, e in CO11N è di sola visualizzazione. Su
  ECC MATNR ha la conversion exit ALPHA, quindi `3201917` partirebbe in formato esterno e potrebbe
  farsi rifiutare per «materiale non corrispondente all'ordine» — un modo di fallire in più e nessuna
  informazione in più. Se vi serve, ditecelo: lo mandiamo in formato interno;
- **`FINALCONFIRMATIONTYPE`** (`AUERU_VS`, CHAR(1)) è il menu «Confirm.type», ma **la lista dei suoi
  valori ammessi non ce l'abbiamo**: non è nell'EDMX né in `ZMARS_PRODCONF_S_CONF_DataElements.xlsx`.
  Un valore inventato sarebbe un rifiuto in più da diagnosticare, quindi dichiariamo la conferma
  finale col flag `ISFINALCONFIRMATION` (`AUERU`), che è un booleano e non ha liste. **Se ci mandate
  il code list di `AUERU_VS`** lo valorizziamo e la conferma rispecchia il menu di CO11N.

`WORKCENTER` invece lo mandiamo: `ARBPL` CHAR(8) non ha conversion exit e `07000010` è già la forma
buona. Se lo derivate anche voi e vi dà fastidio, lo togliamo.

`APICONFHASNOGOODSMOVEMENTS = "X"` è una scelta funzionale: **nessun movimento merci a valle di questa
conferma**. I 261/551 hanno un flusso loro, ed è quello dell'altro documento.

---

## 3-bis. Da adesso arrivano SEI messaggi per innesco, e c'è un errore nuovo

### L'errore del 17/08/2026, e perché non sappiamo leggerlo da soli

Alla prima chiamata coi dati veri, alle 17:33, ci avete risposto:

```
HTTP 500   server: SAP   dataserviceversion: 1.0   content-length: 192
{"error":{"code":"INTERNAL_SERVER_ERROR","message":{"lang":"en",
  "value":"class [B cannot be cast to class java.util.Map
           ([B and java.util.Map are in module java.base of loader 'bootstrap')"}}}
```

`[B` è il nome JVM di `byte[]`: **un passo Java ha ricevuto l'array di byte crudo del corpo dove si
aspettava una `Map`**. Da fuori possiamo escludere tutto il resto, e l'abbiamo fatto:

- non è un **letterale** invalido — sarebbe `400 EdmSimpleTypeException`, che conosciamo (§ 2-bis);
- non è un **campo omesso** — sarebbe «`OrderSuboperation` manca», che conosciamo;
- non è un **nome di proprietà** — sarebbe «Illegal argument … '*campo*'», che conosciamo (§ 1);
- non è l'**indirizzo** — il `$metadata` risponde e dichiara `ProdnOrdConf2Type` con le sue 107
  proprietà, che combaciano coi nostri nomi;
- non è **CSRF** né autorizzazione — sarebbe `403`, e il token è stato ottenuto;
- **non è ABAP** — Simple Transformation muore con `CX_ST_*` / `CX_SY_CONVERSION_*` e un `REF_NAME`,
  mai con una `ClassCastException`.

Quello che resta è un errore **dentro Cloud Integration**. Non è la prima volta che lo vediamo su
questo tenant: la stessa stringa esatta ci arriva da `PRODUCT_DESCRIPTION_GET` su alcuni materiali, e
lì l'ipotesi era il ramo «tabella vuota» della mappatura.

**E c'è un dettaglio che dovreste guardare voi.** Prima del 17/08 lo stesso corpo, nella stessa forma
`entity`, arrivava **fino a ECC**: ci rispondeva `CX_SY_CONVERSION_DATA_LOSS` su `ISFINALCONFIRMATION`
(§ «I booleani»). Ora si ferma prima, in Java. Il messaggio è **regredito**, e le domande sono due:

1. **cos'è cambiato nell'iFlow dopo l'11/08/2026?** Vi avevamo chiesto di aggiungere la conversione
   `true`/`false` → `X`/*space* nel mapping: se l'avete aggiunta, è il primo posto dove guardare;
2. **quale passo lancia la `ClassCastException`?** Lo dice il Message Processing Log, e non lo
   abbiamo: la risposta non porta un MPL ID. Il correlation id di quella chiamata è
   `a2ea274c-ea41-4243-4a0a-e4ceaec6a3b6`.

### Le sei varianti

Non possiamo leggere il vostro MPL, ma possiamo dirvi **se il corpo c'entra**. Da adesso ogni innesco
manda la stessa conferma in **sei forme diverse, in sequenza**, così un'ipotesi per volta non costa un
rilascio per volta:

| # | id | Cosa cambia rispetto al § 2-bis | Cosa ci dice |
|---|---|---|---|
| 1 | `CONF.fm` | la busta `{IS_CONFIRMATION, IV_POST_ERRORS}` del § 2 | se ci rispondete ancora «Illegal argument … 'IS_CONFIRMATION'», il front-end è quello dell'11/08; se rispondete altro, **l'iFlow è cambiato** |
| 2 | `CONF.entity` | niente: è il § 2-bis | riproduce il `500` e dice se è deterministico |
| 3 | `CONF.abap` | i 12 booleani come `"X"` / `""` | se è la conversione dei booleani a cedere, questa la scavalca |
| 4 | `CONF.omit` | i campi senza valore **omessi**: 15 su 105, nessun `null` | se sono i vuoti tipizzati a pescare il ramo rotto |
| 5 | `CONF.d` | l'entity avvolta in `{"d": { … }}` | è la forma canonica di un entry JSON in OData V2, e non l'avevamo mai provata in richiesta |
| 6 | `CONF.verbose` | `Content-Type: application/json;odata=verbose` | è il content type canonico della scrittura OData V2 |

**Come le distinguete nel monitor.** Ogni variante manda il correlation id della chiamata **col
proprio suffisso**: `<uuid>-fm`, `<uuid>-entity`, `<uuid>-abap`, `<uuid>-omit`, `<uuid>-d`,
`<uuid>-verbose`. Filtrando per l'UUID le trovate tutte e sei; il suffisso dice quale è quale. Senza,
i sei messaggi sarebbero indistinguibili e «quale passo cede su quale variante» non si potrebbe
nemmeno chiedere. Se il suffisso vi rompe qualcosa — p.es. se validate il correlation id come UUID —
ditecelo e torniamo all'id nudo.

**La sequenza si ferma alla prima variante che REGISTRA.** Se una passa, le rimanenti non partono:
l'operazione risulta confermata finalmente e da lì in poi il rifiuto delle altre non sarebbe
interpretabile. Quindi nel caso peggiore vedete sei messaggi rifiutati, nel caso buono uno accettato e
nessun altro.

**Cosa ci aspettiamo di imparare, e cosa no.** Se tutte e sei si fermano allo stesso punto, il corpo
non è la variabile in gioco e la palla è vostra — con il MPL in mano. Se una va più avanti delle
altre, quella è la forma che il vostro endpoint accetta, e la dichiariamo qui come definitiva.

---

## 3-ter. Il primo giro della batteria: **funziona**. E due cose vanno corrette in questo documento

Al primo innesco, **tre varianti su sei sono arrivate al BAPI**. Fermando il debugger su
`ZMARS_PROD_ORDER_CONF_POST`, la tabella `LT_DETAIL`:

```
TYPE  ID   NUMBER  MESSAGE                                                    V1  V2
E     RU   005     Sequence 0 is not defined in order 700000080, check entry   0   700000080
```

**Questa è la prova che cercavamo da due settimane.** Il messaggio attraversa l'iFlow, arriva in ECC,
la function module lo elabora e lo rifiuta per un motivo applicativo. Il canale è dimostrato: la
migrazione del flusso PROD_CONF si può progettare.

### Correzione 1 — «non c'è un `ET_RETURN`» era falso, e c'è un `LT_DETAIL`

Il § 4 di questo documento vi chiedeva di *valutare l'aggiunta* di un `ET_RETURN` perché «senza, una
riga senza chiavi ci dice *che* non è passata, non *perché*». La specifica della FM dichiarava
`IS_CONFIRMATION` + `IV_POST_ERRORS` e nient'altro, e ci eravamo costruiti sopra la lettura
dell'esito.

**Il messaggio esiste già**: `LT_DETAIL`, e ha la forma di un BAPIRET2 (`TYPE`, `ID`, `NUMBER`,
`MESSAGE`, `LOG_NO`, `LOG_MSG_NO`, `MESSAGE_V1..V2`). Non ci serve che ne aggiungiate uno: **ci serve
che quello che c'è arrivi nella risposta HTTP**. Oggi lo abbiamo letto col debugger, cioè con qualcuno
seduto su ECC a fermare l'esecuzione — e in esercizio non è un modo di diagnosticare una
consuntivazione ferma.

**La richiesta, quindi, cambia:** mappate `LT_DETAIL` nella risposta dell'iFlow, con qualunque nome vi
sia comodo. Il nostro lettore lo cerca **per forma e non per nome** — riconosce una tabella di
BAPIRET2 dovunque sia annidata e dichiara nel log dove l'ha trovata — quindi non serve concordare
niente in anticipo: basta che ci sia.

### Correzione 2 — la sequenza `0` era nostra, e la leggiamo da voi

`Sequence 0 is not defined in order 700000080` è un errore **nostro**, non vostro: `0` è ciò che la
transazione CO11N *mostra* nel campo Sequence (§ 0), non ciò che `AFRU-APLFL` contiene. Trascriverlo
da una schermata è stato uno sbaglio nostro.

Da adesso **la chiave della conferma la leggiamo dall'ordine** — sequenza, operazione, plant, centro
di lavoro e unità vengono da `A_ProductionOrderOperation_2` (`ManufacturingOrderSequence`,
`ManufacturingOrderOperation`, `ProductionPlant`, `WorkCenter`, `OperationUnit`), letto sui vostri
indirizzi già in esercizio. È una lettura in più per innesco, e vale la pena: chiediamo la chiave allo
stesso sistema su cui stiamo per scrivere, invece di dedurla.

Nel log della sonda compare come riga `ORDER.key`, prima delle sei varianti, e riporta anche lo stato
dell'operazione — se è già confermata finalmente e quanta quantità resta. Se la lettura non riuscisse,
la batteria parte comunque coi valori di prima e lo dichiara: una sonda che non parte non diagnostica
niente.

> **Nota sulla copertura dei tipi.** Fino al 16/08/2026 il messaggio valorizzava anche `PERSONNEL`
> (NUMC) e `CAPACITYREQUIREMENTSPLIT` (INT1) al solo scopo di collaudare quei due letterali in una
> chiamata vera, dato che ST si ferma al primo valore illegale. Su un ordine vero una matricola e uno
> split di capacità inesistenti sono due motivi di rifiuto, e un rifiuto per quelli sarebbe
> indistinguibile da un problema dell'iFlow: ora escono **vuoti**, e i due letterali restano
> collaudati dai nostri unit test. Se vi serve vederli valorizzati in una chiamata reale, ci mettiamo
> valori esistenti e ve lo diciamo.

---

## 3-quater. Il secondo giro col debugger: due difetti nostri, e nessuno dei due è vostro

Il **18/08/2026**, di nuovo col debugger fermo su `ZMARS_PROD_ORDER_CONF_POST`, sono arrivati altri due
messaggi da `LT_DETAIL`. Entrambi sono difetti **del nostro messaggio**: li scriviamo qui perché il
documento descriva ciò che il vostro endpoint riceve **oggi**, non ciò che riceveva ieri.

### La sequenza va in formato interno: `000000`, non `0`

```
TYPE  ID   NUMBER  MESSAGE                                                    V1  V2
E     RU   005     Sequence 0 is not defined in order 700000080, check entry   0   700000080
```

Il § 3-ter dava per chiusa questa correzione leggendo la sequenza da `A_ProductionOrderOperation_2`
invece di trascriverla da CO11N. **Non bastava**, ed è utile che lo sappiate: sul canale in esercizio
la sequenza è arrivata come `0`, senza riempimento, quindi il valore letto era identico a quello
trascritto. Forzando `000000` dal debugger il rifiuto è scomparso.

`AFRU-APLFL` è un CHAR(6) riempito a zeri: `Sequence` è dichiarato `Edm.String MaxLength="6"` e la
forma interna è `000000`. Da adesso lo mandiamo **sempre riempito**, da qualunque provenienza venga —
lettura o configurazione. Vale la stessa regola già applicata a `OrderID` (§ 0) e ora anche a
`OrderOperation` / `OrderSuboperation`, che sono VORNR/UVORN CHAR(4): `0020`, non `20`.

> **Se il vostro mapping applica già la conversione**, ditelo: mandiamo il formato esterno e la
> commutazione è una variabile d'ambiente, come per `OrderID`. Quello che non possiamo fare è
> indovinare quale dei due strati la applica.

### Una coppia di tempi si manda intera, o non si manda

Passato il primo rifiuto, il BAPI ha risposto:

```
TYPE  ID   NUMBER  MESSAGE                                    V1  V2
E     RU   028     Two operation times are not in ascending order
```

Il messaggio non dice quale coppia, ma la causa era nostra e univoca: mandavamo
`ConfirmedProcessingStartDate`, `ConfirmedProcessingEndDate` e `ConfirmedProcessingStartTime` — e la
`ConfirmedProcessingEndTime` **no**. Su un `Edm.Time` senza valore mandiamo `null`, che in ABAP è
l'ora iniziale `000000`: SAP leggeva **inizio lavorazione alle 14:22 e fine a mezzanotte** dello
stesso giorno, cioè la fine prima dell'inizio.

**Da adesso la conferma non manda tempi d'operazione**: i quattro campi partono vuoti come gli altri
90, e i tempi li deriva SAP dai valori standard dell'operazione. Non è un ripiego — è che le durate
vere non le abbiamo: la registrazione di produzione che leggiamo da Plex espone **un solo istante**,
non un intervallo, quindi qualunque coppia inizio/fine costruita da noi sarebbe inventata.

Il campo che resta è `PostingDate` (BUDAT), che non è un tempo d'operazione.

> **Se in SAP servono i tempi reali**, serve prima decidere da dove vengono. Con un solo istante per
> registrazione l'unica cosa onesta che possiamo mandare è `inizio = fine`; se invece vi va bene che
> li derivi il BAPI, siamo già nella configurazione giusta. Quando i tempi torneranno, torneranno a
> **coppie complete** — data e ora di ogni estremo, tutte o nessuna: mezza coppia è precisamente
> questo rifiuto.

### E la richiesta del § 4 diventa più urgente

Questi due messaggi sono la **seconda** e la **terza** volta che il motivo di un rifiuto si legge solo
con qualcuno seduto su ECC a fermare l'esecuzione. Ogni giro costa mezza giornata e un ordine di test
in più. `LT_DETAIL` esiste, è già riempito, e mapparlo nella risposta dell'iFlow trasformerebbe
ciascuno di questi giri in cinque minuti: è la richiesta 2 del § 4, e resta la cosa più utile che
possiate darci su questo endpoint.

---

## 4. Cosa ci aspettiamo indietro

> **Riscritto il 02/09/2026 sulla risposta che ci avete dichiarato.** Quello che c'era prima — la
> tabella delle 105 colonne più le due chiavi — è conservato qui sotto come «la forma precedente»,
> perché il nostro lettore la legge ancora e le righe già scritte nei nostri log hanno quella forma.

**La risposta di oggi.** A buon fine tornano **`OrderID` e `ConfirmationText`**; se non funziona
torna il **solo `ConfirmationText`**, e dentro c'è il motivo del rifiuto.

```json
{ "<nome del parametro>": { "ORDERID": "000700000080",
                            "CONFIRMATIONTEXT": "SN 12345 · Plex 1000123" } }
```

| Risposta | Come la leggiamo |
|---|---|
| `ORDERID` **uguale** a quello mandato | la conferma **è stata registrata** |
| **qualunque altra cosa**: `ORDERID` vuoto o assente, corpo vuoto o non JSON | la conferma **NON è stata registrata**: la ritentiamo alla run successiva, e il motivo è `CONFIRMATIONTEXT` se c'è |

> **Dal 25/09/2026 vi mandiamo una conferma per ORDINE per esecuzione, non una per registrazione.**
> Se nella stessa esecuzione ci sono più registrazioni Plex sullo stesso ordine, vi arriva **una**
> conferma con la quantità sommata, `ConfirmationText` = `Plex <lotto> · N reg.` (o
> `Ordine <ordine> · N reg.` se i lotti sono più d'uno) e data/ora della registrazione più recente.
> L'esito vale per tutte. Con una registrazione sola il messaggio è quello di sempre.
>
> **Dal 25/09/2026 gli esiti sono questi due, su ogni forma della risposta.** Le chiavi non decidono:
> nella realtà torna l'entity intera con `ConfirmationGroup` e `ConfirmationCount` **a zeri su ogni
> risposta** (misurato il 09/09 e il 25/09). La «forma precedente» qui sotto resta come storia.

**HTTP 200 non basta**: una risposta `200` senza `ORDERID` è un rifiuto, e la trattiamo come tale. E
al contrario, una risposta HTTP **non** riuscita che porta `ORDERID` la leggiamo come registrata:
dichiararla fallita ce la farebbe ritentare, cioè confermare due volte.

**Tre cose che ci servono da voi su questa forma:**

1. **`ORDERID` va valorizzato SOLO quando la conferma è registrata.** È l'esito: se un giorno la
   risposta tornasse a essere l'eco della richiesta — dove `ORDERID` c'è comunque, perché l'abbiamo
   mandato noi — leggeremmo «registrata» su ogni rifiuto. Se cambiate la forma della risposta
   **avvisateci**.
2. **Il numero d'ordine lo confrontiamo con quello che abbiamo mandato**, tollerando gli zeri
   iniziali (mandiamo `000700000080`, e su questo canale i valori possono tornare senza
   riempimento).
3. **`CONFIRMATIONTEXT` su un rifiuto è il motivo, e lo mostriamo così com'è** — è testo vostro, non
   lo traduciamo. Lo salviamo nello storico dell'ordine insieme all'ordine restituito e a quale delle
   due regole ha deciso l'esito.

**La richiesta su `LT_DETAIL` si chiude.** Fino a ieri questo documento vi chiedeva di mapparlo nella
risposta, e lo chiamava una **precondizione**: senza, un rifiuto su un flusso automatico era muto, e
il motivo l'avevamo letto tre volte su tre col debugger su ECC (§ 3-ter, § 3-quater). Adesso il
motivo arriva in `CONFIRMATIONTEXT`, quindi non serve più. Il nostro lettore dei messaggi **resta**:
se un giorno mappate `LT_DETAIL` comunque, lo troviamo per forma e ha la **precedenza**, perché
`TYPE`, `ID` e `NUMBER` dicono di più di una frase sola.

### La forma precedente, che leggiamo ancora

Ci avevate detto che la risposta era una **tabella di righe di conferma**: le stesse 105 della
richiesta più le due chiavi assegnate da SAP.

```json
{
  "<nome del parametro>": { "item": [
    { "CONFIRMATIONGROUP": "0000123456",
      "CONFIRMATIONCOUNT": "00000001",
      "ORDERID": "000700000080", "SEQUENCE": "000000", "…le altre 103…": "" }
  ] }
}
```

Su **questa** forma l'esito lo leggiamo dalle chiavi, e non da `ORDERID`:

| Riga di risposta | Come la leggiamo |
|---|---|
| `CONFIRMATIONGROUP` valorizzato | quella conferma **è stata registrata** |
| `CONFIRMATIONGROUP` vuoto | quella conferma **non è stata registrata** |
| alcune righe con chiavi e altre no | **fallito**: registrazione parziale |

Le due regole convivono e a scegliere è la forma della riga che arriva, perché applicare la regola
sbagliata sbaglia in entrambi i versi: qui `ORDERID` c'è anche su un rifiuto, e là le chiavi non ci
sono nemmeno su un successo.

**Il nome del parametro di uscita** non ce l'avete mai dichiarato, e continua a non servirci: il
nostro lettore cerca **per forma e non per nome** — un oggetto o un array ovunque annidato,
`{"X": {"item": […]}}`, `{"X": {"results": […]}}`, `{"X": […]}`, in cima, o una riga sola senza
involucro — e **scrive nel log dove l'ha trovata**, insieme a quale regola ha applicato. Se ce lo
dite, meglio.

### Se qualcosa va storto

Ci serve, nell'ordine:

1. l'**MPL ID** — lo estraiamo già dal testo dell'errore quando c'è, ed è la chiave con cui aprite
   l'esecuzione fallita nel monitor di Cloud Integration;
2. il **`REF_NAME`** dell'eventuale eccezione ST, che dice quale campo ha un letterale illegale;
3. il **`x-correlation-id`**, che vi giriamo noi.

---

## 5. Come spegnerla, se vi dà fastidio

> **Aggiornamento del 09/09/2026: la batteria non esiste più.** Le domande di § 1 hanno avuto
> risposta, quindi il nostro strumento di diagnosi è stato rimosso: da questo indirizzo passa ora
> **solo** il flusso di esercizio, **una conferma per registrazione di produzione**. Non vedrete più
> raffiche di sei messaggi, e le varianti del corpo non si commutano più a caldo.
> Se vi dà fastidio, il fermo è nel nostro customizing e vale **per singolo stabilimento**: si spegne
> senza rilascio e senza toccare l'iFlow. Ditecelo e lo facciamo.

Storicamente (fino al 09/09/2026): la batteria era **sei messaggi** per lancio (§ 3-bis), e dal
17/08/2026 una chiamata che arriva a ECC **registra** (§ 0). Dal 19/08/2026 si lanciava a mano — non
più a ogni apertura della nostra dashboard.

Le altre leve, tutte senza rilascio, sono per rispondere alle domande aperte del § 1:
`PRODCONF_POST_SHAPE` (`entity` / `fm`), `PRODCONF_POST_PATH` (indirizzo),
`PRODCONF_POST_ENTITYSET` (entity set, vuoto = service root), `PRODCONF_POST_METADATA=off`
(salta la lettura dell'EDM), `PRODCONF_POST_CSRF=off` (fetch del token), `PRODCONF_POST_ORDER`
(un altro ordine, o lo stesso in formato esterno).

---

## 6. Il flusso di esercizio (dal 25/08/2026)

Da qui in poi questo indirizzo riceve **due** chiamanti diversi. Vanno distinti nel monitor, e il modo
è l'header `x-correlation-id`.

| | sonda | flusso `PROD_CONF` |
|---|---|---|
| `x-correlation-id` | `…-CONF.fm`, `…-entity`, … (una per variante) | `PROD_CONF-<chiave registrazione Plex>-3` |
| quante chiamate per innesco | fino a **sei** (la batteria delle varianti) | **una** |
| ordine | `000700000000`, letterale di configurazione | l'ordine **vero** della registrazione |
| `ORDEROPERATION` / `SEQUENCE` | valorizzati (time ticket) | **vuoti**: conferma di testata |
| `APICONFHASNOGOODSMOVEMENTS` | `true` | **`false`** |
| `OPENRESERVATIONSISCLEARED` | `true` | `false` |
| quando parte | a mano, per misurare | quando una registrazione Plex arriva all'ultima operazione del ciclo |

### Perché `APICONFHASNOGOODSMOVEMENTS` cambia valore

La sonda diceva «SAP non muova niente» perché i movimenti li facevamo noi, con
`ZMARS_MATERIAL_DOC_POST`. Nel flusso di esercizio è l'opposto: la conferma **deve** innescare il
versamento automatico del prodotto e il prelievo retrogrado dei componenti. Se quel flag arrivasse a
`true` l'ordine risulterebbe confermato con **nessuna merce mossa**, e da BTP non lo vedremmo: è la sola
riga del messaggio il cui errore non produce nessun errore.

Due cose devono quindi essere vere in ECC, e non possiamo verificarle da BTP perché nessuno dei due
campi arriva su un iFlow:

- **versamento automatico** (`T430-AUTWE`) sul control key dell'operazione di versamento;
- **prelievo retrogrado** sui componenti dell'ordine.

### La domanda aperta, che vi chiediamo di verificare con noi

Il prelievo retrogrado di un componente avviene alla conferma dell'operazione a cui il componente è
**allocato**. Nei nostri ordini i componenti risultano allocati alla **prima** operazione, mentre la
conferma che mandiamo è di **testata**. Se il prelievo non parte, il risultato è merce che entra e
componenti che non escono.

Si risolve in una prova: fatta una conferma, si guarda il **flusso documenti** dell'ordine e si conta
se ci sono i 261 dei componenti. Se non ci sono, ci serve una seconda strada — la conferma per la
quantità, il nostro documento materiale per i componenti — e ve la chiederemmo come richiesta separata.

### Una richiesta piccola: `EXTERNALSYSTEMCONFIRMATION`

Il campo esiste nell'entity (255 caratteri, «External Key») e **non lo mandiamo**, per un motivo di
tipo: l'EDMX lo dichiara `Edm.Guid` e la nostra chiave — quella della registrazione Plex — non è un
UUID. Con `keepEmpty` viaggia quindi come `null`.

Se dietro l'EDM quel campo fosse accettato come **stringa** e finisse in `AFRU`, ci daremmo due cose
che oggi non abbiamo: la conferma diventerebbe **riconoscibile dal lato SAP** (chi guarda CO14 saprebbe
da quale registrazione Plex viene) e sarebbe **deduplicabile a monte**, cioè un secondo invio dello
stesso record potrebbe essere rifiutato da voi invece che evitato solo da noi. Non è un blocco: è la
domanda se il tipo `Guid` sia una scelta o un artefatto dell'EDMX generato.

### `LT_DETAIL`: da «utile» a «necessario», e il 02/09/2026 a NON PIÙ NECESSARIO

Sul banco di prova un rifiuto muto era accettabile: c'era un umano davanti, ed è andato col debugger su
ECC tre volte (`RU 005`, `RU 028`, e la sequenza in formato interno). Su un flusso automatico non c'è
nessuno davanti: un rifiuto senza messaggio diventa una riga di recap che dice «non registrata» e
niente altro, e l'unico modo di sapere perché è ripetere la prova a mano.

**Questa richiesta è chiusa**: il motivo del rifiuto arriva in `CONFIRMATIONTEXT` (§ 4), che è
esattamente ciò che serviva. Il nostro lettore dei messaggi resta e cerca la tabella **per forma** e
non per nome (`TYPE`, `ID`, `NUMBER`, `MESSAGE`, a qualunque livello di annidamento): se un giorno la
mappate comunque, ha la **precedenza** — un BAPIRET2 con tipo, id e numero dice di più di una frase
sola — e non serve concordare un nome.

### Cosa facciamo con la vostra risposta

| Risposta | Cosa facciamo |
|---|---|
| `ORDERID` **uguale** a quello mandato | riuscito: la registrazione è chiusa, e le chiavi le salviamo così come arrivano |
| **qualunque altra risposta** (`ORDERID` vuoto o assente, messaggio `E`/`A`/`X`, corpo vuoto o non JSON) | non registrata: **ritentiamo** alla run successiva fino al tetto del plant, e il vostro testo è il motivo |
| errore di trasporto o HTTP senza corpo | il messaggio non è arrivato: **ritentiamo** |

La seconda riga è ciò che il contratto nuovo ci ha dato: prima quel caso cadeva nella quinta —
bloccato in attesa di un intervento manuale — perché «non ha registrato» era una nostra deduzione.
Adesso lo dichiarate voi, e la riga riparte da sé.

---

## Riferimenti

- Firma della FM `ZMARS_PROD_ORDER_CONF_POST` e struttura `ZMARS_PRODCONF_S_CONF`:
  [Endpoint_OData_Integration-20260728 (1).md](<Endpoint_OData_Integration-20260728 (1).md>)
- Il precedente da cui deriva tutto: [MATERIAL_DOC_POST_IS.md](MATERIAL_DOC_POST_IS.md) e
  [ZMARS_MATDOC_POST_CONTRACT.md](ZMARS_MATDOC_POST_CONTRACT.md)
- Inventario dei 107 campi coi tipi: [ZMARS_PRODCONF_POST.fields.json](ZMARS_PRODCONF_POST.fields.json)
- Implementazione: `srv/lib/prodOrderConfPost.js` — perimetro completo con `grep -rn "PRODCONF-POST"`;
  la lettura dell'esito del § 4 con `grep -rn "CONF-OUTCOME"`

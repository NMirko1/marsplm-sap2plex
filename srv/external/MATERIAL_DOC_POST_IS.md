# Registrazione movimento merci — contratto della chiamata BTP → Integration Suite

Documento per il **team Integration**. Descrive la chiamata che l'applicazione SAP BTP (Mars PLM
SAP-Plex) invia all'iFlow di registrazione movimento merci: indirizzo, forma del messaggio, campo per
campo, e cosa si aspetta di ricevere indietro.

> **Stato: collaudo.** La chiamata è **già attiva e parte davvero**: quanto descritto qui non è una
> proposta, è ciò che il vostro endpoint riceve oggi. Provvisori sono soltanto due elementi, in attesa
> che l'iFlow sia pronto: i **dati**, per ora segnaposto `MOCK-*`, e il **momento in cui parte**, per
> ora l'apertura della dashboard del cockpit. Serve a farvi vedere il messaggio reale invece di una
> specifica su carta.
>
> **Aggiornamento 19/08/2026.** Il messaggio descritto qui è invariato, cambia **chi lo manda**. I
> movimenti veri (261, 101, 551) partono dal job `PROD_CONF`, che li costruisce dalle registrazioni
> lette da Plex: quelli non sono più segnaposto. Le chiamate coi dati `MOCK-*` restano possibili ma
> **non partono più da sole** — non sono più agganciate all'apertura della dashboard, si lanciano a
> mano. Se nel vostro monitor vedete ancora `MOCK-COMP-*`, è una prova deliberata, non traffico
> applicativo: il campo `chiamante` nel nostro log distingue i due casi.

---

## 0. La domanda aperta: quale forma accettate per N righe in un messaggio?

Questa sezione viene prima di tutto il resto perché è l'unico punto ancora bloccante. Il resto del
documento descrive ciò che inviamo **oggi**; se la risposta a questa domanda è diversa, adegueremo il
messaggio — è configurazione, non sviluppo.

### Il vincolo che non possiamo negoziare

A valle, la registrazione avviene con **una sola chiamata RFC** (`ZMARS_MATERIAL_DOC_POST` su
`BAPI_GOODSMVT_CREATE`), che prende **testata + tabella righe insieme**: `IS_HEADER` + `IT_ITEM`.

Da qui discende tutto:

- **un documento materiale è atomico.** Le N righe di un movimento sono *un* documento, non N documenti;
- **non possiamo spezzarlo in N chiamate HTTP.** Ne uscirebbero N documenti separati, oppure — se una
  delle chiamate fallisce a metà — un movimento **parzialmente registrato**, cioè uno sbilancio
  contabile che nessuno riconcilia. Non è una preferenza di comodità;
- quindi **il messaggio che vi arriva deve contenere tutte le righe**, qualunque sia la sua forma:
  altrimenti l'RFC non è chiamabile come previsto.

### La contraddizione da sciogliere

Tre affermazioni che al momento non stanno insieme:

1. **L'endpoint è un servizio OData V2 vero.** Non è un'ipotesi: risponde con `dataserviceversion: 1.0`,
   buste d'errore in formato OData V2 e messaggi di **Apache Olingo** (`EdmSimpleTypeException`), cioè
   il payload viene validato contro un EDM. Non si comporta da wrapper piatto verso una RFC.
2. **Ci avete detto che non potete fare deep insert.**
3. **Il messaggio deve portare N righe** (vedi sopra).

Ma su un entity set OData V2, «una chiamata con testata + N righe annidate» **è** un deep insert: è la
definizione della cosa, non una scelta di implementazione. Se (1) e (2) valgono entrambe, allora la
forma che stiamo inviando oggi non è quella giusta — e non sappiamo quale sia.

### Il contratto è scritto: scegliete la forma

Invece di chiedervi *quale forma accettate*, l'abbiamo scritta noi — **in tutte e tre le forme
tecnicamente possibili**, sugli stessi 108 campi, generate da un'unica fonte così che non possano
divergere. Sono in **[ZMARS_MATDOC_POST_CONTRACT.md](ZMARS_MATDOC_POST_CONTRACT.md)**, che spiega
ciascuna in dettaglio:

**Risolta: forma C.** L'endpoint è `/http/btpmars/sapecc/1110.02/materialdocument`, un **HTTPS sender** di
Cloud Integration — il prefisso `/http/` lo dice — quindi non c'è alcuno strato OData e la questione
del deep insert non si pone più. Il messaggio è la firma della FM `ZMARS_MATERIAL_DOC_POST`, con i
valori in **letterali XSD** — la FM è esposta come web service, quindi i valori passano da Simple
Transformation e non dal formato interno ABAP — e i campi senza valore **omessi**.

Il contratto completo, con richiesta, risposta e codifica campo per campo, è in
**[ZMARS_MATDOC_POST_CONTRACT.md](ZMARS_MATDOC_POST_CONTRACT.md)**. Le forme A (OData V4) e B (OData V2
con deep insert) restano documentate lì: spiegano perché si è arrivati alla C e servirebbero se un
domani l'endpoint cambiasse natura.

Non esiste una quarta forma tipizzata, e vale la pena dire perché: in OData V2 le collection non sono
ammesse come tipo di `<Property>` (arrivano in V3) e i parametri di `<FunctionImport>` devono essere
`EDMSimpleType` — verificato sui 9 EDMX SAP che già consumiamo: 351 parametri, tutti `Edm.*`. Resta il
`$batch` con changeset, che però sposta su di voi la ricomposizione in **una sola** chiamata RFC: se per
voi è semplice, ditelo e lo costruiamo.

> Se la risposta fosse **«una riga per chiamata»**, allora va concordato esplicitamente **chi garantisce
> l'atomicità** e come si compensa una registrazione rimasta a metà. Non è una domanda retorica: senza
> una risposta, quel flusso non può andare in esercizio.

Resta utile il **`$metadata` del service root** attuale — lo stiamo interrogando anche noi
(`GET <service root>/$metadata`, lettura senza effetti): dice cosa espone oggi quell'indirizzo, che è
un'informazione diversa da quale forma vogliate adottare domani.

---

## 1. La chiamata

| | |
|---|---|
| **Metodo** | `POST` |
| **Service root** | `/gw/odata/SAP/F0491.87_OPERATIONS_SAPBTPMARS_SAPECC_MATERIALDOC_POST;v=1` |
| **Entity set** | `A_MaterialDocumentHeader` |
| **URL completo** | `<host destination>/gw/odata/SAP/F0491.87_OPERATIONS_SAPBTPMARS_SAPECC_MATERIALDOC_POST;v=1/A_MaterialDocumentHeader` |
| **Destination BTP** | `MARS_SAP_CON` |
| **Content-Type** | `application/json` |
| **Accept** | `application/json,text/plain` |

Header aggiuntivi che accompagnano ogni chiamata:

| Header | Valore | A cosa serve |
|---|---|---|
| `x-correlation-id` / `x-correlationid` | UUID, uno per chiamata | **Chiave di riconciliazione.** È lo stesso identificativo che compare nel nostro log: citandolo, ritrovate il messaggio esatto nel vostro monitor. Lo indicheremo in ogni segnalazione. |
| `sap-client` | dalla destination | mandante |
| `authorization` | dalla destination | non è mai loggato in chiaro da parte nostra |

### Cosa c'è e cosa no

- **`to_MaterialDocumentItem` è un array dentro il JSON**, da leggere come una tabella di righe. Non
  chiediamo che la navigazione venga «risolta» come farebbe un gateway OData: serve solo che le righe
  arrivino tutte insieme all'RFC. **Questa è la forma su cui è aperta la domanda del § 0.**
- **Nessun wrapper `results`** attorno all'array (è la convenzione JSON di OData V2; oggi non si usa —
  commutabile).
- **Nessuna paginazione, nessun `$batch`** (oggi; il `$batch` è una delle opzioni del § 0).
- **Nessun `$expand`**: in scrittura non avrebbe senso, ed è comunque escluso.

---

## 1-bis. CSRF — decisione da prendere

Si era partiti dal presupposto che verso Integration Suite non ci fosse protezione CSRF. **La prima
chiamata reale lo ha smentito**: il runtime risponde `403` e l'iFlow non viene mai invocato.

Cosa dice la risposta:

| Evidenza | Lettura |
|---|---|
| Body = pagina di errore **stock di Tomcat** (`HTTP Status 403 – Forbidden`, nessun messaggio applicativo) | Respinti da un **servlet filter**, prima che l'iFlow parta |
| Risposta con **`x-csrf-token`** e **`set-cookie`** | Sono le due intestazioni che un fetch di token CSRF raccoglie |
| `server: SAP`, `x-vcap-request-id` | Runtime Cloud Integration, non ECC |
| 69 ms | Rifiuto locale immediato |

È la firma del `CsrfPreventionFilter` sull'**adapter HTTPS sender**, che su Cloud Integration è
*CSRF Protected* per default. Non era mai emerso perché i 15 endpoint già in esercizio sono **tutti
GET**, e la protezione non si applica ai GET: questa è la **prima scrittura** sul canale.

**Abbiamo attivato il fetch del token da parte nostra, e funziona**: il token viene ottenuto, la
chiamata supera il filtro ed entra nell'endpoint (l'errore successivo è di tutt'altra natura, § 2). La
diagnosi è quindi **confermata sul campo**, non è più un'ipotesi. Ma la configurazione definitiva è una
vostra scelta:

- **(A) Disabilitare *CSRF Protected* sull'adapter HTTPS sender** dell'iFlow. È la scelta usuale per
  un'integrazione sistema-a-sistema autenticata via OAuth/certificato: una sola chiamata per
  messaggio, nessuna sessione da mantenere. **La preferiamo.**
- **(B) Lasciarla attiva** e continuare a fare noi il fetch. Funziona, ma sono **due round trip per
  ogni messaggio** (`HEAD` per il token + `POST`) e una sessione con cookie da mantenere fra i due.

Se scegliete (A) ce lo segnalate e spegniamo il fetch: è una riga di configurazione, nessun rilascio.

> **Causa alternativa che era in gioco, ora esclusa.** Un ruolo `ESBMessaging.send` mancante sul client
> della destination avrebbe prodotto lo stesso `403`. Poiché col token il `403` è sparito, quella
> ipotesi è caduta: l'autorizzazione è a posto.

---

## 2. Il messaggio

Testata al primo livello, righe in un array. **Un'unica chiamata trasporta N righe** — il numero è
variabile e i tipi movimento si mescolano nello stesso messaggio.

L'esempio è il payload reale: 3 righe, due consumi `261` e uno scarto `551`.

```json
{
  "GoodsMovementCode": "03",
  "MaterialDocumentHeaderText": "MOCK MARS-BTP",
  "ReferenceDocument": "MOCK-REF-0001",
  "DocumentDate": "/Date(1786060800000)/",
  "PostingDate": "/Date(1786060800000)/",
  "to_MaterialDocumentItem": [
    {
      "GoodsMovementType": "261",
      "Material": "MOCK-COMP-01",
      "Plant": "1010",
      "StorageLocation": "0001",
      "QuantityInEntryUnit": "3.000",
      "EntryUnit": "PC",
      "ManufacturingOrder": "000010000123",
      "Reservation": "0000012345",
      "ReservationItem": "0001",
      "MaterialDocumentItemText": "MOCK consumo componente 1"
    },
    {
      "GoodsMovementType": "261",
      "Material": "MOCK-COMP-02",
      "Plant": "1010",
      "StorageLocation": "0001",
      "QuantityInEntryUnit": "1.500",
      "EntryUnit": "KG",
      "ManufacturingOrder": "000010000123",
      "Reservation": "0000012345",
      "ReservationItem": "0002",
      "MaterialDocumentItemText": "MOCK consumo componente 2"
    },
    {
      "GoodsMovementType": "551",
      "Material": "MOCK-COMP-03",
      "Plant": "1010",
      "StorageLocation": "0001",
      "QuantityInEntryUnit": "1.000",
      "EntryUnit": "PC",
      "CostCenter": "0000001000",
      "GoodsMovementReasonCode": "0001",
      "MaterialDocumentItemText": "MOCK scarto"
    }
  ]
}
```

### Testata — campi inviati

Sono un sottoinsieme dei 14 campi di `A_MaterialDocumentHeaderType`: gli altri non li mandiamo.

| Campo | Tipo | Lung. | Valore | Note |
|---|---|---|---|---|
| `GoodsMovementCode` | `Edm.String` | 2 | `03` | `03` = goods issue: vale sia per il 261 sia per il 551 |
| `PostingDate` | `Edm.DateTime` | — | `/Date(ms)/` | data di registrazione |
| `DocumentDate` | `Edm.DateTime` | — | `/Date(ms)/` | data documento |
| `MaterialDocumentHeaderText` | `Edm.String` | 25 | testo libero | in esercizio porterà il riferimento della registrazione Plex |
| `ReferenceDocument` | `Edm.String` | 16 | testo libero | riferimento esterno |

`MaterialDocumentYear` e `MaterialDocument` sono le **chiavi assegnate da SAP** e non vengono inviate:
le attendiamo in risposta.

> **Sul formato dei valori non c'è nulla da concordare: lo impone l'EDMX.** Dei campi che inviamo solo
> tre non sono `Edm.String`, e sono gli unici che possono far fallire il parsing:
> `DocumentDate`/`PostingDate` sono `Edm.DateTime` (in OData V2 JSON il letterale **deve** essere
> `/Date(ms)/`) e `QuantityInEntryUnit` è `Edm.Decimal(13,3)` (in V2 si serializza come **stringa**).
> Nessun altro campo inviato supera il proprio `MaxLength`.
>
> Lo abbiamo verificato sul campo: il primo tentativo mandava le date in ISO `"2026-08-06"` e ha
> incassato `400 EdmSimpleTypeException`. Corretto il letterale, quella causa è chiusa.

### Riga — campi inviati

Sottoinsieme dei 94 campi di `A_MaterialDocumentItemType`. Non tutti compaiono su tutte le righe:
dipende dal tipo movimento.

| Campo | Tipo | Lung. | 261 | 551 | Note |
|---|---|---|---|---|---|
| `GoodsMovementType` | String | 3 | `261` | `551` | **vive sulla riga, non sulla testata** |
| `Material` | String | 40 | ✓ | ✓ | codice materiale |
| `Plant` | String | 4 | ✓ | ✓ | divisione |
| `StorageLocation` | String | 4 | ✓ | ✓ | magazzino di prelievo |
| `QuantityInEntryUnit` | Decimal | 13,3 | ✓ | ✓ | inviato come **stringa** (`"3.000"`) |
| `EntryUnit` | String | 3 | ✓ | ✓ | unità di misura di immissione |
| `ManufacturingOrder` | String | 12 | ✓ | — | ordine di produzione |
| `Reservation` | String | 10 | ✓ | — | prenotazione |
| `ReservationItem` | String | 4 | ✓ | — | posizione prenotazione |
| `CostCenter` | String | 10 | — | ✓ | centro di costo dello scarto |
| `GoodsMovementReasonCode` | String | 4 | — | ✓ | motivo del movimento |
| `MaterialDocumentItemText` | String | 50 | ✓ | ✓ | testo posizione |

`MaterialDocumentYear`, `MaterialDocument` e `MaterialDocumentItem` — le tre chiavi della riga — non
vengono inviate: le assegna SAP.

### Corrispondenza con la FM già concordata

Il messaggio non è una forma nuova: è la stessa `ZMARS_MATERIAL_DOC_POST` già proposta in
`Endpoint_OData_Integration` (§ *Function Group `ZMARS_FG_MATERIAL_DOC`*), vista dal lato JSON.

| JSON inviato | Parametro FM | |
|---|---|---|
| campi al primo livello | `IS_HEADER` | struttura testata |
| array `to_MaterialDocumentItem` | `IT_ITEM` | tabella righe |
| `GoodsMovementCode` | `IV_GOODS_MOVEMENT_CODE` | può arrivare anche come parametro dedicato |
| — | `IV_TEST_RUN` | **utile in collaudo**: se lo esponete, ditecelo, lo valorizziamo |

Logica sottostante attesa: `BAPI_GOODSMVT_CREATE`.

---

## 3. Cosa ci aspettiamo in risposta

### Successo

Le **chiavi del documento creato**, che sono l'unico dato che non possiamo ricostruire da soli:

```json
{ "MaterialDocument": "4900001234", "MaterialDocumentYear": "2026" }
```

Se l'iFlow restituisce anche i messaggi `BAPIRET2` del BAPI, li registriamo nel nostro log: sono utili
per i warning di registrazione riuscita ma parziale. Non sono obbligatori.

### Errore

**Con uno stato HTTP di errore (4xx/5xx) e un messaggio leggibile.** Questo è il punto su cui serve
l'accordo esplicito:

> Un errore restituito come **HTTP 200 con esito negativo nel body** verrebbe trattato dalla nostra
> applicazione come una registrazione riuscita. Su un flusso contabile è la peggiore modalità di
> guasto possibile: il movimento non c'è, ma per noi risulta fatto.

Preferiamo un 400 con `BAPIRET2` di tipo `E` nel body a un 200 ambiguo.

### Cosa facciamo noi

- Registriamo **l'intero scambio** — richiesta, header, stato, risposta — nel nostro log applicativo.
- Non ritentiamo automaticamente: una registrazione di movimento merci non è idempotente.
- Lo stato HTTP viene letto e riportato così com'è; non lo normalizziamo.

---

## 4. Diagnosi rapida degli errori osservati

| Stato | Header / indizio | Significato |
|---|---|---|
| `503` | `sap-err-id: ICMENOSYSTEMFOUND` | la destination punta al gateway on-premise, dove i path `/gw/odata/...` non esistono. È il caso degli **ambienti interni**: non è un problema del payload |
| `404` | — | il service root non esiste sul tenant IS, o il nome dell'entity set è diverso |
| `400` | `EdmSimpleTypeException` (Olingo) | un **valore primitivo** non è un letterale valido per il suo tipo EDM. Non è la forma del messaggio: è un singolo campo. Ci è capitato con le date in ISO invece che `/Date(ms)/` — vedi il riquadro in § 2 |
| `400` | proprietà sconosciuta / navigazione rifiutata | è la **forma** del messaggio: vedi § 0 |
| `400` / `500` | messaggio applicativo nel body (materiale inesistente, movimento non ammesso…) | il messaggio è arrivato fino al BAPI: **la forma è corretta** e mancano solo dati veri. È l'esito che cerchiamo in questa fase |
| `403` | pagina **HTML di Tomcat** + `x-csrf-token` in risposta | protezione CSRF dell'adapter HTTPS sender — § 1-bis, risolto col fetch del token |
| `401` | — | autenticazione della destination |

In ogni caso il **body inviato** e il **correlation id** sono nel nostro log: chiedeteceli, oppure
apriteli voi dalla console del browser sul cockpit (gruppo `[MATDOC-POST]`).

---

## 5. Domande aperte — servono le vostre risposte

Le nostre sono variabili **commutabili da configurazione**: rispondere chiude il giro **senza rilascio
di codice** da parte nostra.

**Bloccante**

1. **Quale forma accetta l'indirizzo, che porti testata + N righe in un messaggio solo?** È la domanda
   del **§ 0**, con le cinque alternative concrete. Il modo più rapido per rispondere è mandarci il
   **`$metadata`** del service root.

**Da chiudere per andare in esercizio**

2. **Nome dell'entity set nell'URL.** Confermate `A_MaterialDocumentHeader`, o il service root va
   chiamato con un altro nome di risorsa (o senza)?
3. **Risposta di successo.** Confermate che restituite `MaterialDocument` + `MaterialDocumentYear`? E
   in quale forma (oggetto piatto, oppure annidato in `d`)?
4. **`IV_TEST_RUN`.** Lo esponete? In collaudo ci permette di provare fino in fondo senza registrare
   documenti veri.
5. **Campi obbligatori.** Dei 94 campi riga ne inviamo 12: ne mancano di obbligatori per
   `BAPI_GOODSMVT_CREATE` nei due movimenti `261` e `551`?
6. **CSRF** (§ 1-bis). Disabilitate *CSRF Protected* sull'adapter HTTPS sender, oppure continuiamo a
   fare noi il fetch del token? Oggi funziona in entrambi i modi: è una scelta di efficienza.

**Chiuse dall'evidenza — non servono più risposte**

- ~~Formato delle date~~ → `Edm.DateTime` in OData V2 vuole `/Date(ms)/`. Lo impone l'EDMX, § 2.
- ~~Formato dei decimali~~ → `Edm.Decimal` in V2 si serializza come **stringa**. Idem.
- ~~Ruolo `ESBMessaging.send`~~ → col token CSRF il `403` è sparito: l'autorizzazione è a posto.

---

## Riferimenti

- `srv/external/Endpoint_OData_Integration-20260728 (1).md` § 7 (servizio `API_MATERIAL_DOCUMENT_SRV`,
  elenco completo dei 14 + 94 campi) e § *Function Group `ZMARS_FG_MATERIAL_DOC`*
- `srv/external/SAP_CONF_MOVEMENT_API.md` — quadro delle chiamate di consuntivazione e movimenti,
  payload 261 e 551 nel contesto funzionale
- `docs/DECISIONI.md` DEC-24 — wrapper piatto al posto del deep-insert, convenzioni concordate
- Implementazione lato BTP: `srv/lib/materialDocPost.js`

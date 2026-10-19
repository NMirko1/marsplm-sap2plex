# `CloseOrder` e `TechlyCmpltOrder` — contratto della chiamata BTP → Integration Suite

Documento per il **team Integration**. Descrive le due chiamate che l'applicazione SAP BTP (Mars PLM
SAP-Plex) invia ai vostri iFlow **N.20** (`CloseOrder`) e **N.21** (`TechlyCmpltOrder`): indirizzo,
forma della richiesta, e cosa si aspetta di ricevere indietro.

> ## ⚠️ AGGIORNAMENTO 02/09/2026 — QUESTE DUE CHIAMATE NON SONO PIÙ SONDE, E I LORO NOMI NON
> ## DESCRIVONO PIÙ COSA FANNO
>
> Due cose sono cambiate insieme, e questo documento andava **corretto** e non integrato: com'era,
> affermava che `CloseOrder` **chiude l'ordine** e `TechlyCmpltOrder` lo **mette in TECO**. Se le due
> RFC sono state corrette come ci è stato indicato, quell'affermazione è documentazione **attivamente
> pericolosa**: descrive un effetto — stati che a valle bloccano conferme e movimenti — che chi legge
> attribuirebbe a due chiamate che oggi partono su **ordini veri**.
>
> **1. Sono due flussi d'esercizio, non due sonde.** Dal 02/09/2026 le chiamate partono da due job
> batch schedulati, su ordini **reali**, con il numero d'ordine vero:
>
> | Chiamata | Job | Quando parte |
> |---|---|---|
> | `CloseOrder` | `ORDER_COMPLETE` | quando il job Plex del lotto passa a `Completed` |
> | `TechlyCmpltOrder` | `ORDER_SCHEDULED` | quando il job Plex del lotto passa a `Scheduled` |
>
> Escono sulla destination **`MARS_SAP_CON_BA`** (utenza tecnica) e non più su `MARS_SAP_CON`,
> perché un run batch non ha un JWT utente da propagare. Nel vostro monitor le vedrete quindi
> arrivare in modo regolare e con `ManufacturingOrder` veri, non più con `999999999999`.
>
> **2. Quello che le due FM scrivono è uno STATO UTENTE informativo**, secondo l'indicazione del team
> di progetto: nessuna chiusura, nessun TECO. Su `ZMARS_PROD_ORDER_TECO` in particolare ci è stato
> indicato che **la RFC è stata corretta** per scrivere lo stato utente `Scheduled` — quell'indirizzo
> non era usato da nessun flusso ed è stato riusato.
>
> **➡️ LE DUE COSE CHE VI CHIEDIAMO.**
>
> 1. **Confermateci per iscritto cosa scrivono oggi le due FM.** È l'unica cosa che separa questo
>    flusso da una chiusura di massa: se una delle due chiudesse davvero l'ordine, la scoprirebbe la
>    fabbrica. Finché la conferma non arriva, la casella di abilitazione di un plant in esercizio
>    resta spenta dalla nostra parte — ma la casella è l'**unico** freno, e la muove chi configura,
>    non un rilascio.
> 2. **Rinominate `TechlyCmpltOrder`**, o dateci un indirizzo nuovo con un nome che descriva ciò che
>    fa. Un Function Import che si chiama «technically complete order» e scrive uno stato
>    `Scheduled` è una trappola per il prossimo che lo leggerà da una parte o dall'altra: il primo
>    che «corregge» l'ABAP riportandolo alla funzione che il nome descrive metterebbe in chiusura
>    tecnica **ogni ordine appena pianificato**.
>
> Resta valido tutto il resto del documento: forma della richiesta, CSRF, codici di errore,
> diagnostica. Il § 0 qui sotto è **storico** e descrive la fase di collaudo con l'ordine
> inesistente — quella fase è finita.

> **Stato: collaudo.** Le chiamate sono **già attive e partono davvero**: quanto descritto qui non è
> una proposta, è ciò che i vostri endpoint ricevono oggi. Provvisori sono soltanto due elementi: i
> **dati**, per ora un mock su un ordine inesistente, e il **momento in cui partono**, per ora
> l'apertura della dashboard del cockpit. Serve a farvi vedere il messaggio reale invece di una
> specifica su carta. È lo stesso metodo già usato per il movimento merci
> ([MATERIAL_DOC_POST_IS.md](MATERIAL_DOC_POST_IS.md)) e per la conferma d'ordine
> ([PROD_ORDER_CONF_POST_IS.md](PROD_ORDER_CONF_POST_IS.md)).
>
> **Aggiornamento 19/08/2026.** Le due chiamate sono invariate, ma **non partono più da sole**: non
> sono più agganciate all'apertura della dashboard e si lanciano a mano, una alla volta, quando
> serve misurare. Nel vostro monitor quindi ne vedrete molte meno, e ognuna corrisponde a una prova
> deliberata.

I due indirizzi ci sono stati pubblicati in `EndpointFlussiMARS_V1.xlsx`, voci **N.20** e **N.21**, e
**nessuno li aveva mai chiamati**: questa è la prima chiamata in assoluto verso di essi.

---

## 0. STORICO — la fase di collaudo con l'ordine inesistente

> **Questa sezione descrive come le due chiamate partivano fino al 02/09/2026, e resta perché spiega
> le chiamate con `999999999999` che avete visto nel vostro monitor.** Da quella data partono da due
> job schedulati su ordini veri: vedi l'aggiornamento in testa al documento. **Ciò che qui si dice
> sull'effetto delle due FM — «l'ordine viene chiuso», «lo mette in TECO» — è ciò che allora
> credevamo, e l'indicazione di progetto ora è che scrivano soltanto uno stato utente informativo.
> È il punto 1 della nostra richiesta.**

Come la conferma d'ordine, e a differenza del movimento merci, queste due operazioni **non hanno un
parametro di esecuzione in prova**. La firma proposta di `ZMARS_PROD_ORDER_CLOSE` e
`ZMARS_PROD_ORDER_TECO` è `IV_MANUFACTURING_ORDER` in ingresso e `ET_RETURN` in uscita, e basta:
niente `IV_TEST_RUN`.

Quindi, se il messaggio arriva alla FM e l'ordine esiste, **succede quello che la FM fa** — e allora
credevamo fosse una chiusura: `CloseOrder` che chiude l'ordine e `TechlyCmpltOrder` che lo mette in
TECO, stati che dalla nostra parte non si annullano e che a valle bloccano conferme e movimenti. Non
essendoci un parametro che lo impedisse, lo impediva il dato:

```
ManufacturingOrder = "999999999999"
```

Non è un ordine. SAP non ha nulla da chiudere, e la sua risposta — «ordine non esistente» — è
**precisamente l'esito che queste chiamate cercano**: dimostra che il messaggio ha attraversato
l'iFlow ed è stato eseguito in ECC. Un errore applicativo qui è un successo di integrazione.

**Se una delle due chiamate rispondesse SENZA errori, per noi è un allarme** e la sonda va spenta:
significa che quell'ordine esiste — e allora è stato chiuso davvero — oppure che l'iFlow risponde OK
senza chiamare la FM.

Se preferite che aggiungiamo un `IV_TEST_RUN` alla firma delle due FM, ditelo: è il modo pulito di
collaudare il flusso su ordini veri quando ci arriveremo, e per noi è una riga.

---

## 1. Le due chiamate

| | `CloseOrder` | `TechlyCmpltOrder` |
|---|---|---|
| **Voce del foglio** | N.20 | N.21 |
| **Metodo** | `POST` | `POST` |
| **iFlow** | `F1110.01_Operations_SAPBTPMARS_SAPECC_Order_Close_Post` | `F1110.01_Operations_SAPBTPMARS_SAPECC_Order_TECO_Post` |
| **Service root** | `/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_ORDER_CLOSE_POST;v=1` | `/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_ORDER_TECO_POST;v=1` |
| **Function Import** | `CloseOrder` | `TechlyCmpltOrder` |
| **FM a valle** | `ZMARS_PROD_ORDER_CLOSE` | `ZMARS_PROD_ORDER_TECO` |
| **Destination BTP** | `MARS_SAP_CON_BA` d'esercizio, `MARS_SAP_CON` dalla sonda | idem |

URL completo, come parte oggi:

```
POST <host destination>/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_ORDER_CLOSE_POST;v=1/CloseOrder?ManufacturingOrder='999999999999'
POST <host destination>/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_ORDER_TECO_POST;v=1/TechlyCmpltOrder?ManufacturingOrder='999999999999'
```

**Il corpo è VUOTO.** Non è una dimenticanza: `CloseOrder` e `TechlyCmpltOrder` sono **Function
Import**, non entity set. Non hanno chiavi, non c'è nessun key predicate da scrivere, e il parametro
sta dove il contratto dice che sta — nella **query string**. Sono le stesse forma e ragione di
`ExplodeBOM` (§ 6 del vostro
[Endpoint_OData_Integration-20260728 (1).md](<Endpoint_OData_Integration-20260728 (1).md>)), e ci
arriviamo da tre riscontri indipendenti:

1. **il vostro contratto**, § 2, esempio:
   `POST …/API_PRODUCTION_ORDER_2_SRV/CloseOrder?ManufacturingOrder='1000001'`;
2. **l'EDMX standard**, dove sono `<FunctionImport>` con un solo `<Parameter Mode="In">`;
3. **il vostro iFlow.** Il primo passo dei flussi generati dallo stesso template è

   ```groovy
   String query = message.getHeader("CamelHttpQuery", String)
   if (!query) { throw new IllegalArgumentException("CamelHttpQuery non valorizzata") }
   ```

   e in Groovy `!query` è vero anche per la stringa vuota. Una POST col parametro nel **corpo** e la
   query string vuota morirebbe lì, prima di ECC.

Header aggiuntivi che accompagnano ogni chiamata:

| Header | Valore | A cosa serve |
|---|---|---|
| `x-correlation-id` / `x-correlationid` | UUID, uno per chiamata | **Chiave di riconciliazione.** È lo stesso identificativo che compare nel nostro log: citandolo, ritrovate il messaggio esatto nel vostro monitor. Lo indicheremo in ogni segnalazione. |
| `sap-client` | dalla destination | mandante |
| `authorization` | dalla destination | non è mai loggato in chiaro da parte nostra |

### CSRF

Il fetch del token è **attivo** per default su queste due chiamate, come sulla conferma d'ordine: il
path pubblicato è un service root OData, e il vostro contratto stesso nota che le azioni /
Function Import richiedono un token CSRF. Se questi endpoint non lo pretendono, lo spegniamo:
il fetch fa due `HEAD` allo stesso indirizzo prima della `POST`, e su un HTTPS sender rischiano di
generare voci MPL spurie nel vostro monitor.

---

## 2. Cosa ci aspettiamo di ricevere

Il ritorno dichiarato dal contratto è un `FunctionMessage` (OData) / `ET_RETURN` di **`BAPIRET2`**
(FM). A differenza della conferma d'ordine, qui **c'è** un messaggio applicativo, e l'esito lo
leggiamo da lì:

| `TYPE` | come lo leggiamo |
|---|---|
| `E`, `A`, `X` | SAP ha **rifiutato**. Con l'ordine di mock è l'esito **atteso**: la FM è stata eseguita |
| `S`, `I`, `W` senza errori | l'operazione risulta **eseguita** → per noi è un **allarme**, vedi § 0 |
| nessun messaggio | non sappiamo dire se la FM è stata chiamata: vedi la domanda 2 |

**Il nome del parametro di uscita non ci è stato dichiarato**, e i due strati dell'endpoint lo
renderebbero con vocabolari diversi: `TYPE` / `ID` / `NUMBER` / `MESSAGE` se risponde la FM in ABAP,
`SystemMessageType` / `SystemMessageIdentification` / `SystemMessageNumber` /
`SystemMessageLongText` se risponde l'EDM. Per questo il nostro lettore cerca il messaggio **per
forma e non per nome** — riconosce entrambi i vocabolari, ovunque siano annidati — e **dichiara dove
l'ha trovato**. Così la prima chiamata reale risponde alla domanda invece di richiedere un altro giro
di specifiche. Quando ce lo direte, lo scriveremo qui.

---

## 3. Come leggiamo l'esito: la profondità, non il codice HTTP

«Il messaggio è arrivato?» non è una domanda a cui il codice HTTP sappia rispondere: un `500` può
venire dall'ingresso dell'iFlow o da dentro il BAPI, e sono due notizie opposte. Ogni chiamata
riporta quindi una **profondità**, ed è quella che vi giriamo:

| profondità | come la riconosciamo | cosa vi chiediamo |
|---|---|---|
| `NESSUNA_RISPOSTA` | `404`, `503`, o l'errore `CamelHttpQuery` / `GetQueryFilter` | che l'iFlow sia deployato, e che il path sia ancora quello del foglio |
| `IFLOW` | c'è un MPL ID, oppure un `2xx` senza messaggio applicativo | di aprire l'MPL ID nel Message Monitoring: il messaggio è stato preso in carico e si è fermato dentro il flusso, o la FM non è ancora a sistema |
| `FM` | è tornato un messaggio applicativo | **niente: è il risultato che cercavamo** |
| `ESEGUITO` | messaggio di successo, nessun errore | vedi § 0 — spegniamo la sonda e verifichiamo l'ordine |

L'**MPL ID**, quando c'è, lo estraiamo dal corpo dell'errore e lo citiamo sempre: per noi vale più
del codice HTTP, perché esiste solo per messaggi che il vostro runtime ha accettato e iniziato a
elaborare.

---

## 4. Domande aperte

1. **Gli apici.** Mandiamo il parametro come literal OData, `ManufacturingOrder='999999999999'`. Se
   `GetQueryFilter.groovy` spezza la query string su `&` e `=` senza spacchettare i literal, allora
   `IV_MANUFACTURING_ORDER` riceve `'999999999999'` **apici compresi** — che in ABAP non trova niente
   e **non dà errore**: un `200` che non ha fatto nulla. Ditecelo, e possiamo mandare il valore nudo
   senza rilascio; nel frattempo un nostro controllo prova entrambe le forme sulla stessa chiamata.
2. **Il corpo vuoto è accettato?** Su una POST senza corpo il nostro client manda
   `content-type: application/x-www-form-urlencoded`. Su un Function Import il corpo non serve, ma un
   sender che valida il content-type risponderebbe `415`. Se attendete un content-type preciso,
   diteci quale.
3. **Il CSRF serve davvero?** Vedi § 1. Se no, lo spegniamo e vi togliamo due `HEAD` per chiamata dal
   monitor.
4. **Un `IV_TEST_RUN` sulle due FM.** Vedi § 0. È la sola cosa che ci permetterebbe di collaudare il
   flusso su ordini veri.
5. **Le due FM sono a sistema?** Nel vostro documento `ZMARS_PROD_ORDER_CLOSE` e
   `ZMARS_PROD_ORDER_TECO` sono dichiarate una **proposta di specifica** («nomi FM, data element e
   table type sono da confermare/creare con lo sviluppo ABAP»). Se non sono ancora state create, ce
   lo aspettiamo dalla profondità `IFLOW` — e allora la risposta a questo documento è una data, non
   una diagnosi.

---

## 5. Da parte nostra

Implementazione: [../lib/prodOrderStatusPost.js](../lib/prodOrderStatusPost.js), la cui testata
spiega ogni scelta. Le leve elencate lì (forma del parametro, corpo, CSRF, path, Function Import)
sono tutte commutabili **senza un rilascio**: qualunque cosa risulti sbagliata di questo messaggio,
la correggiamo nel giro successivo. Spegnimento immediato: **la casella del plant** nella nostra app di configurazione (`ORDER_STATUS_POST=off` spegne la sola sonda del cockpit, non i due job).

Nel nostro cockpit le due chiamate si lanciano a mano dalla console (`window.orderStatusPost()`) e
tutto l'esito — richiesta, header, corpo ricevuto, MPL ID, correlation id — finisce nella console
del browser e in `cf logs`. Non scriviamo niente da nessuna parte: nessuna tabella, nessun log
applicativo.

<!-- [ORDER-STATUS-POST] Questo documento fa parte del perimetro della sonda: quando il contratto è
     confermato e la sonda viene rimossa (`grep -rn "ORDER-STATUS-POST"`), quanto è qui va portato
     nella documentazione del flusso di chiusura, non cancellato. -->


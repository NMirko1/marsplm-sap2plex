# `500 REQUEST_PROCESSING_ERROR / "Data is Null"` sull'aggiornamento job — non riusciamo a cambiare la quantità

> # ✅ RISOLTO — 27/08/2026
>
> **Rockwell ha corretto il difetto, e la correzione è stata verificata da noi sul tenant:
> `PUT /scheduling/v1/jobs/{id}` risponde.** Con esso è rientrato il difetto gemello sul
> backwards-schedule, che ha il suo documento
> ([PLEX_ISSUE_BACKWARDS_SCHEDULE_500](PLEX_ISSUE_BACKWARDS_SCHEDULE_500.it.md)). Il documento resta
> come traccia di ciò che è stato osservato; **il corpo qui sotto non è stato riscritto** ed è quello
> consegnato il 20/08/2026. Vedi la **«Chiusura»** in fondo.
>
> Una rettifica ci riguarda, ed è indipendente dalla correzione: il «difetto collegato» del §7 —
> la lettura con filtro — **non era un vostro difetto**. Vedi il §7 e la chiusura.

| | |
|---|---|
| **Tenant** | `ariston-albacin.test` |
| **Host Connect API** | `test.connect.plex.com` |
| **Operazione** | `PUT /scheduling/v1/jobs/{id}` (Job Scheduling API v1, `UpdateJob`) |
| **Building** | `Albacina` (`8b32a82e-2b93-4f70-b9ab-9342e4a61e93`) — l'unico attivo sul tenant |
| **Osservato** | 19 e 20 agosto 2026, riproducibile a ogni tentativo |
| **Gravità** | ~~**Bloccante.** Non esiste alcun percorso alternativo — vedi §5~~ · **RISOLTA il 27/08/2026** |
| **Stato** | **CHIUSO il 27/08/2026**: corretto da Rockwell e verificato dalla nostra parte |
| **Segnalato da** | Ariston / Genga — progetto di integrazione SAP-Plex |

## 1. Sintesi

Ogni chiamata a `PUT /scheduling/v1/jobs/{id}` su questo tenant risponde HTTP `500`:

```json
{ "code": "REQUEST_PROCESSING_ERROR",
  "message": "An unexpected error occurred while processing the request.",
  "metadata": { "internalMessage": "Data is Null. This method or property cannot be called on Null values." } }
```

Vale sia con il modello intero sia con i **soli tre campi che `UpdateJob` dichiara obbligatori**, su un
job che Plex stesso ha creato pochi secondi prima rispondendo `201`, e con ogni valore preso
direttamente dalla riga che `GET /scheduling/v1/jobs/{id}` restituisce per quello stesso job.

`UpdateJob` dichiara `200`, `400` e `404`. Un `500` con questo testo indica un riferimento nullo non
gestito dentro il servizio, non una richiesta rifiutata.

È l'operazione che ci blocca, per tre ragioni che si sommano:

- è l'**unico** modo di cambiare la quantità o la data di consegna di un job — nessuna Data Source
  della nostra integrazione può farlo (§5);
- il nostro rollback compensativo usa la **stessa** operazione, quindi un fallimento parziale non è
  annullabile (§6);
- una lettura collegata, `GET /scheduling/v1/jobs?jobNumber=`, cade nello stesso modo ogni volta che
  esiste una riga corrispondente, e questo ci impedisce di sapere se un job esiste già (§7).

## 2. Cosa stiamo facendo, e perché serve un aggiornamento di quantità

Un ordine di produzione SAP viene condiviso con Plex come un singolo job, con il numero d'ordine come
`jobNumber` e `externalJobCode`.

Lo stabilimento ha spesso bisogno di lavorare un ordine in più lotti separati — turni diversi, linee
diverse, rilasci parziali. SAP non modella questa cosa: l'ordine resta un ordine con una quantità. La
nostra integrazione esegue quindi lo spacchettamento **solo lato Plex**, e la quantità totale in
produzione deve restare invariata. Dato un lotto principale di `R` e un pacchetto richiesto di `q` (con
`0 < q < R`):

1. si riduce il job principale da `R` a `R − q` → `PUT /scheduling/v1/jobs/{parentId}`
2. si rischedula il principale, perché la sua quantità è cambiata → `POST .../backwards-schedule`
3. si crea il pacchetto come job nuovo, `<numeroOrdine>-000N`, con quantità `q` → `POST /scheduling/v1/jobs`
4. si rischedula il pacchetto → `POST .../backwards-schedule`
5. si allineano operazioni e distinta del pacchetto al contenuto dell'ordine SAP → Data Source
6. si registra il collegamento all'ordine SAP, così la produzione consuntivata sul pacchetto torna sull'ordine giusto

L'invariante è che la quantità del principale più quella di ogni pacchetto vivo sia sempre uguale alla
quantità originale dell'ordine. Il passo 1 è la prima scrittura della sequenza, e fallisce. Niente di
ciò che viene dopo viene eseguito.

Riduciamo il principale **prima** di creare il pacchetto per una scelta deliberata: se cade la seconda
metà, lo stato residuo è «la fabbrica ha meno quantità dell'ordinato», che è recuperabile. L'ordine
inverso lascerebbe «più quantità dell'ordinato» su un lotto che gli operatori potrebbero già aver
iniziato, e non lo è.

## 3. Caso riproducibile

Ordine di produzione `000700000162`, part `3201816` (`f88d3fb9-0249-4dcb-ac64-3e16bce7b495`), job
`04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f`. Prima della prova ogni job sul tenant era stato cancellato e il
nostro stato azzerato, quindi la sequenza è pulita.

**Il job come Plex l'ha creato** (`POST /scheduling/v1/jobs` → `201`, riletto identico con
`GET /scheduling/v1/jobs/{id}` → `200`):

```json
{ "id": "04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f",
  "externalJobCode": "000700000162", "jobNumber": "000700000162",
  "createdDate": "2026-08-20T05:00:00Z",
  "partId": "f88d3fb9-0249-4dcb-ac64-3e16bce7b495", "partNumber": "3201816",
  "dueDate": "2026-08-25T00:00:00Z", "completedDate": null,
  "quantity": 10, "quantityCompleted": null,
  "jobStatus": "New",
  "buildingId": "8b32a82e-2b93-4f70-b9ab-9342e4a61e93", "buildingCode": "Albacina",
  "jobType": "ZP07", "earliestStartDateTime": null, "priority": "Medium",
  "unit": "pcs", "endUnitNumber": "", "bomSubstitutionAllow": null }
```

**Tentativo 1 — modello intero.** Un `PUT` è il modello intero e non una patch, quindi rimandiamo ogni
campo che il job porta adesso, riducendo la quantità da `10` a `5`:

```http
PUT /scheduling/v1/jobs/04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f
Content-Type: application/json

{"dueDate":"2026-08-25T00:00:00Z",
 "quantity":5,
 "buildingId":"8b32a82e-2b93-4f70-b9ab-9342e4a61e93",
 "jobType":"ZP07",
 "priority":"Medium"}
```

→ `500`, corpo come in §1.

**Tentativo 2 — soli tre campi obbligatori.** La nostra integrazione, su un `5xx`, ritenta con il corpo
minimo documentato, per stabilire quale forma il tenant accetti:

```http
PUT /scheduling/v1/jobs/04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f
Content-Type: application/json

{"dueDate":"2026-08-25T00:00:00Z","quantity":5,"jobType":"ZP07"}
```

→ `500`, corpo identico.

Note sui valori, dato che provengono tutti da Plex e non da SAP:

- `dueDate` è letta dal job, non dall'ordine SAP, proprio per non sovrascrivere una data che qualcuno
  ha cambiato dentro Plex.
- `jobType` `"ZP07"` è stato accettato da `POST /scheduling/v1/jobs` e memorizzato tale e quale; si vede
  sul job nell'interfaccia Plex.
- `buildingId` e `priority` sono rimandati per eco dallo stesso job. `priority: "Medium"` è stata
  assegnata dal default del tenant alla creazione.
- `earliestStartDateTime` è `null` sul job e quindi non viene inviato. Il campo è opzionale in
  `UpdateJob`.
- `quantity` è inviata come numero JSON, come dichiara il contratto.

## 4. Variabili escluse

Una variabile cambiata per volta, su tre job diversi — fra cui uno creato dopo aver cancellato ogni job
sul tenant:

| Variabile | Valori provati | Esito |
|---|---|---|
| Forma del corpo | modello intero (5-6 campi) · soli 3 campi obbligatori | `500` in entrambi i casi |
| `buildingId` | assente · valido (`8b32a82e-…`, `Albacina`) | `500` in entrambi i casi |
| `earliestStartDateTime` | uguale a `dueDate` · assente (`null` sul job) | `500` in entrambi i casi |
| `priority` | assente · `"Medium"`, assegnata dal default del tenant | `500` in entrambi i casi |
| Tipo di `quantity` | stringa JSON `"100.0"` · numero JSON `5` | `500` in entrambi i casi |
| `dueDate` | passata / il giorno stesso · futura (`2026-08-25`) | `500` in entrambi i casi |
| Età del record del job | preesistente · creato pochi minuti prima | `500` in entrambi i casi |
| Stato del tenant | job preesistenti · ogni job cancellato, ripartenza da zero | `500` in entrambi i casi |

Nello stesso tempo, sullo stesso job e nello stesso minuto: `POST /scheduling/v1/jobs` risponde `201`,
`GET /scheduling/v1/jobs/{id}` risponde `200`, e le Data Source `4216`, `4701`, `20051`, `10603` e
`239905` rispondono tutte `200` — comprese le due che **scrivono** (stato di un'operazione, e
l'aggiornamento dell'ordinamento della lista di lavoro, che riporta
`"Job Sort Order Updated Successfully"`).

## 5. Non abbiamo un percorso alternativo, ed è la nostra domanda principale

La nostra integrazione usa dodici Data Source su questo tenant. Cinque scrivono. **Nessuna scrive la
quantità di un job:**

| Data Source | Funzione | Legge o scrive |
|---|---|---|
| `4216` | numero job → `Job_Key` | legge |
| `4701` | operazioni del job | legge |
| `20051` | operazione del job → *NOT Required* | **scrive** lo stato dell'operazione |
| `10603` | righe di distinta di un'operazione del job | legge |
| `4858` | riga di distinta del job → `Active = 0` | **scrive** il flag della riga |
| `239905` | `Job_Sort_Order_Update` | **scrive** la sequenza della lista di lavoro |
| `19529` | `Job_Complete` | **scrive** il completamento del job |
| `1786` | numero part → `Part_Key` | legge |
| `29200` | `Part_Operation_Key_Get2` | legge |
| `11835` | codice work center → `Workcenter_Key` | legge |
| `755` | `Approved_Workcenter_Delete` | **scrive** il work center approvato |
| `20793` | `Part_Attribute_Upload` | **scrive** un attributo di part |

Quindi `PUT /scheduling/v1/jobs/{id}` è l'unico modo che conosciamo per cambiare la quantità di un job,
ed è indisponibile.

C'è un precedente che vale citare, perché è così che abbiamo risolto una lacuna strutturalmente
identica. I work center approvati non si possono rimuovere dalla Connect API — che su quella risorsa
espone solo `GET` e `POST` — e la rimozione è stata ottenuta con la Data Source `755`,
`Approved_Workcenter_Delete`.

**La nostra domanda è quindi:** esiste su questo tenant una Data Source o una stored procedure che
aggiorni la quantità di un job esistente, nello stesso modo in cui la `19529` `Job_Complete` lo chiude?
Se esiste, possiamo aggirare il difetto subito. Se non esiste, il `PUT` deve funzionare.

## 6. Perché un fallimento parziale sarebbe irrecuperabile

La sequenza in §2 è progettata con un rollback compensativo: se il lotto principale è stato ridotto e la
creazione del pacchetto fallisce, ripristiniamo il principale alla quantità precedente. Quel ripristino
è **lo stesso** `PUT /scheduling/v1/jobs/{id}`, con la quantità precedente inviata come valore assoluto.

La conseguenza non è soltanto che lo spacchettamento non parte. Se il `PUT` fosse rotto in modo
intermittente invece che sistematico, uno spacchettamento potrebbe ridurre un lotto principale, non
riuscire a creare il pacchetto e poi non riuscire a ripristinarlo — lasciando un ordine di produzione
permanentemente in difetto in fabbrica, con una quantità che non è in produzione su nessun lotto e
nessun percorso API per correggerla. I nostri operatori vedrebbero la discrepanza senza alcun rimedio
che non sia un intervento manuale nell'interfaccia Plex.

## 7. ~~Difetto collegato~~ RETTIFICATO — l'errore era nostro, non vostro

> **Rettifica del 27/08/2026.** Questa sezione vi segnalava una terza operazione rotta. **Non lo
> era.** Il problema era nostro: cercavamo un job **per numero** dove avremmo dovuto cercarlo **per
> identificativo** — l'UUID che `POST /scheduling/v1/jobs` ci aveva già restituito e che
> memorizziamo. Il numero è rimasto, ma per la sola cosa per cui serve davvero: dimostrare che un job
> **non** esiste. Corretto dalla nostra parte, e da allora non si è più presentato.
>
> Ce ne scusiamo: la sezione vi è stata consegnata come un difetto vostro e non lo era. Il testo che
> segue è quello del 20/08/2026 e resta come traccia di ciò che avevamo osservato; **non va letto
> come una segnalazione aperta.** Una cosa che dice resta però vera ed è nostra: davanti a un esito
> non conclusivo la nostra integrazione **si ferma invece di indovinare**, perché creare un secondo
> job con lo stesso numero sarebbe l'errore peggiore. Quella regola non dipendeva dal difetto e non è
> stata toccata.

`GET /scheduling/v1/jobs` risponde `500` con lo stesso corpo quando esiste una riga corrispondente, e
`200` quando nessuna riga corrisponde. Osservato su `?jobNumber=`, `?partId=` e `?externalJobCode=`, su
job che nell'interfaccia Plex si vedono e sono sani — per esempio `000700000000`, `000700000162`,
`000700000163`.

Lo segnaliamo qui perché la sequenza di spacchettamento dipende da questa lettura due volte: per
trovare il primo codice pacchetto libero, e per verificare l'esito della creazione di un pacchetto la
cui risposta non è stata conclusiva.

Ha però una conseguenza anche oltre lo spacchettamento. Prima di condividere un ordine di produzione
con Plex verifichiamo se il suo job esiste già. Quando quel controllo restituisce un errore invece di
una risposta, non possiamo distinguere «il job non c'è» da «non siamo riusciti a saperlo» — e creare un
secondo job con lo stesso numero sarebbe l'errore peggiore. La nostra integrazione in quella situazione
ora si ferma invece di indovinare, il che significa che un ordine non verificabile non viene inviato
affatto.

Si noti anche che l'operazione che cade qui è una **lettura**: rate, work center, building e operazioni
del job non hanno alcun ruolo. È la ragione per cui riteniamo che `"Data is Null"` copra almeno due
cause distinte.

## 8. Cosa non abbiamo provato

Dichiarato per completezza, così il §4 non venga letto come esaustivo. La prima di queste è
probabilmente la prova più economica a vostra disposizione, e non l'abbiamo eseguita perché la nostra
integrazione non ha motivo di farlo:

- **Un `PUT` che non cambi la quantità** — rimandando la quantità attuale identica, o cambiando solo
  `dueDate`. Ogni tentativo che abbiamo fatto riduceva la quantità, quindi non possiamo dirvi se
  l'innesco sia la scrittura in sé o la variazione di quel campo specifico.
- **Un `earliestStartDateTime` strettamente precedente a `dueDate`.** Abbiamo provato «uguale a
  `dueDate`» e «assente», entrambi `500`. Il nostro sistema di origine consegna date di inizio e fine
  pianificate coincidenti per questi ordini, quindi non abbiamo mai inviato una finestra di ampiezza
  positiva.

## 9. Impatto e cosa chiediamo

**Cosa è bloccato oggi:**

- **Lo spacchettamento dei lotti è inutilizzabile.** La prima scrittura della sequenza fallisce, quindi
  nessun ordine può essere spacchettato.
- **La ri-sincronizzazione di qualunque ordine già presente in Plex fallisce.** Quando una quantità o
  una data di consegna cambia in SAP, aggiorniamo il job esistente con questo stesso `PUT`. Quel passo è
  terminale nella nostra sequenza, quindi l'ordine chiude in errore e viene ritentato a ogni esecuzione
  successiva, indefinitamente.
- **Il rollback compensativo non è disponibile**, come descritto in §6.
- **Le verifiche di esistenza non sono affidabili**, come descritto in §7.

Funziona solo la creazione iniziale di un job: abbastanza per un primo rilascio, non per l'esercizio.

**Cosa ci servirebbe da voi:**

1. Se esista su questo tenant una Data Source o una stored procedure per aggiornare la quantità di un
   job (§5). È la strada più rapida per sbloccarci, e non dipende da una correzione.
2. Conferma se il `500` sia un difetto del servizio o una configurazione del tenant che possiamo
   correggere — e in questo secondo caso, quale impostazione. Va notato che dove un valore di setup del
   tenant manca davvero, il vostro servizio risponde `400` nominando il campo (per esempio
   `REQUEST_VALIDATION_FAILED` / `FIELD_REFERENCE_NOT_FOUND` su `Type` per un tipo di part-operation non
   presente nella tabella di setup). Un `500` con un messaggio di nullo generico non ci lascia niente su
   cui agire.
3. Se la `GET /scheduling/v1/jobs` con un filtro (§7) sia lo stesso difetto o uno distinto.
4. Possiamo rieseguire qualunque richiesta specifica indichiate, attivare tracciature aggiuntive lato
   nostro, o fornirvi gli identificativi di ordine e job qui sopra per un'ispezione diretta sul tenant.

---

## Aggiornamento del 27/08/2026 — cosa è cambiato dal nostro lato

Il testo qui sopra è quello consegnato il 20/08/2026 e resta valido: **il difetto non è stato
riprodotto in modo diverso e non abbiamo alcuna soluzione alternativa.** Cambia però una cosa nel
nostro comportamento, e va detta perché tocca il §8 e il §9.

**Non inviamo più un `PUT` quando non c'è niente da cambiare.** Prima di aggiornare un job ora
rileggiamo la sua quantità e la sua data di consegna e le confrontiamo con quelle dell'ordine SAP; il
`PUT` parte solo se almeno una delle due è effettivamente diversa.

Due conseguenze per voi:

- **§8, punto 1.** La prova che indicavamo come mai eseguita — «un `PUT` che non cambi la quantità» —
  dal nostro lato ora **non si presenta affatto**, perché quella chiamata non parte. Resta la prova
  più economica a vostra disposizione, ma non arriverà spontaneamente dal nostro traffico.
- **§9, secondo punto.** La ri-sincronizzazione di un ordine **non variato** non fallisce più: non
  emette alcuna richiesta. Fallisce ancora, con lo stesso `500`, ogni ordine la cui quantità o data
  sia davvero cambiata in SAP — che è il caso d'uso per cui l'operazione esiste.

Il resto dell'impatto è invariato: lo spacchettamento resta inutilizzabile e il rollback compensativo
non è disponibile.

---

## Chiusura — 27/08/2026

**Rockwell ha corretto il difetto e la correzione è stata verificata dalla nostra parte sul tenant
`ariston-albacin.test`: `PUT /scheduling/v1/jobs/{id}` risponde.** Insieme è rientrato il difetto
gemello sul backwards-schedule
([PLEX_ISSUE_BACKWARDS_SCHEDULE_500](PLEX_ISSUE_BACKWARDS_SCHEDULE_500.it.md)).

Il corpo di questo documento — §1 fino a §9, più l'aggiornamento del 27/08 qui sopra — **non è stato
riscritto**: è la traccia di ciò che è stato osservato e di come il caso è stato istruito. Va letto
al passato.

**Cosa si sblocca**, punto per punto rispetto al §9:

- **Lo spacchettamento dei lotti**: il passo P1 riduce il lotto principale e la sequenza prosegue.
- **La ri-sincronizzazione di un ordine già presente**: la quantità e la data di consegna cambiate in
  SAP arrivano su Plex. Dalla feature 0033 il `PUT` parte **solo se una delle due è davvero
  cambiata**, e quella scelta resta — non era un aggiramento del difetto ma un risparmio di chiamate,
  e vale anche adesso.
- **Il rollback compensativo**: R1 può riportare il lotto principale alla quantità precedente. Lo
  scenario del §6 — un ordine permanentemente in difetto in fabbrica, senza percorso API per
  correggerlo — non è più possibile.
- **Le verifiche di esistenza**: erano rotte per causa nostra, e sono state corrette. Vedi §7.

**Cosa decade dalle richieste del §9.** Le quattro domande si chiudono tutte. In particolare la
prima, che era la più importante — *«esiste una Data Source che aggiorni la quantità di un job, come
la 19529 lo chiude?»* — **non serve più**: era la richiesta di un aggiramento, e con il `PUT`
funzionante non c'è niente da aggirare. Non abbiamo quindi bisogno di quella Data Source.

**Cosa resta non provato**, e lo dichiariamo perché il §8 non venga letto come chiuso: un
`earliestStartDateTime` **strettamente precedente** a `dueDate`. Continuiamo a non inviarlo, ed è una
scelta nostra che resta valida — il sistema di origine consegna date di inizio e fine pianificate
coincidenti, e un vincolo di ampiezza zero non si manda. Il campo è opzionale.

Resta valida una sola osservazione generale, che non dipende da questo difetto: quando manca un dato
di configurazione, un `400` che **nomina il campo** è utilizzabile e un `500` con un messaggio di
nullo generico non lo è. È la differenza fra un caso che si chiude in un'ora e uno che ha richiesto
due dossier.

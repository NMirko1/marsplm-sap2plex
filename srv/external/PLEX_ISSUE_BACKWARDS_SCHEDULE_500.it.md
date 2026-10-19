# `500 REQUEST_PROCESSING_ERROR / "Data is Null"` sul Backwards Schedule

> # ✅ RISOLTO — 27/08/2026
>
> **Rockwell ha corretto il difetto, e la correzione è stata verificata da noi sul tenant:
> `POST /scheduling/v1/jobs/{id}/backwards-schedule` risponde.** Il documento resta come traccia
> di ciò che è stato osservato e di come è stato istruito il caso; **il corpo qui sotto non è
> stato riscritto** ed è quello consegnato il 20/08/2026. Vedi la sezione **«Chiusura»** in fondo.
>
> Una rettifica ci riguarda, ed è indipendente dalla correzione: la terza operazione elencata
> nel §2 — la lettura con filtro — **non era un vostro difetto**. Vedi il §2 e la chiusura.

| | |
|---|---|
| **Tenant** | `ariston-albacin.test` |
| **Host Connect API** | `test.connect.plex.com` |
| **Operazione** | `POST /scheduling/v1/jobs/{id}/backwards-schedule` (Job Scheduling API v1) |
| **Building** | `Albacina` (`8b32a82e-2b93-4f70-b9ab-9342e4a61e93`) — l'unico attivo sul tenant |
| **Osservato** | 19 e 20 agosto 2026, riproducibile a ogni tentativo |
| **Segnalato da** | Ariston / Genga — progetto di integrazione SAP-Plex |
| **Stato** | **CHIUSO il 27/08/2026**: corretto da Rockwell e verificato dalla nostra parte |
| **Stato del chiamante** | l'integrazione ha sospeso la chiamata il 20/08/2026, l'ha riattivata il 27/08/2026 con `useFirstApprovedWorkcenter: false`, ed è **in esercizio**. Un fallimento non interrompe comunque la sequenza di invio: l'ordine chiuderebbe in attenzione col corpo della risposta nel messaggio |

## 1. Sintesi

Ogni chiamata al Backwards Schedule su questo tenant risponde HTTP `500` con il corpo seguente,
qualunque sia il job su cui viene invocata:

```json
{ "code": "REQUEST_PROCESSING_ERROR",
  "message": "An unexpected error occurred while processing the request.",
  "metadata": { "internalMessage": "Data is Null. This method or property cannot be called on Null values." } }
```

L'operazione dichiara tre esiti — `200`, `400`, `404` — quindi questa risposta non è documentata, e il
testo del messaggio indica un riferimento nullo non gestito dentro il servizio, non una richiesta
rifiutata.

I job su cui la chiamiamo sono creati da Plex stesso, pochi secondi prima, con
`POST /scheduling/v1/jobs` che risponde `201`. Si rileggono correttamente con
`GET /scheduling/v1/jobs/{id}`, si vedono correttamente nell'interfaccia Plex, le loro operazioni
esistono, i loro work center approvati esistono e — vedi §4 — i loro rate di produzione sono
valorizzati. Il corpo della richiesta è un unico booleano opzionale.

Abbiamo escluso ogni variabile lato nostro, una per volta (§5). Vi chiediamo di individuare il nullo
(§8).

## 2. Quali operazioni cadono e quali funzionano sullo stesso job

| Operazione | Esito osservato il 19-20/08/2026 | Stato al 27/08/2026 |
|---|---|---|
| `POST /scheduling/v1/jobs/{id}/backwards-schedule` | **500** | ✅ **corretto da Rockwell**, verificato |
| `PUT /scheduling/v1/jobs/{id}` | **500** — segnalata a parte, nel documento sull'aggiornamento della quantità | ✅ **corretto da Rockwell**, verificato |
| `GET /scheduling/v1/jobs?jobNumber=` · `?partId=` · `?externalJobCode=` | **500** quando esiste una riga corrispondente; `200` quando nessuna riga corrisponde | ⚠️ **non era un vostro difetto** — vedi sotto |
| `POST /scheduling/v1/jobs` | `201` | invariato |
| `GET /scheduling/v1/jobs/{id}` | `200` | invariato |
| `GET /mdm/v1/parts`, `GET /mdm/v1/part-operations`, `GET /mdm/v1/buildings` | `200` | invariato |
| `GET /production/v1/production-definitions/approved-workcenters` | `200` | invariato |
| Data Source `4216`, `4701`, `20051`, `10603`, `239905` sullo stesso job | `200`, tutte | invariato |

Le tre operazioni che cadono restituiscono un corpo d'errore identico. Il fatto che lo stesso messaggio
compaia anche su una semplice **lettura** — la `GET` per numero, dove rate, work center e operazioni non
hanno alcun ruolo — suggerisce che `"Data is Null"` sia un involucro generico che copre più di una causa.

> **Rettifica del 27/08/2026 sulla terza riga.** L'ipotesi qui sopra era giusta a metà: quel messaggio
> copre davvero più di una causa, ma la terza operazione **non aveva un difetto vostro**. Il problema
> era nostro: stavamo cercando un job **per numero** dove avremmo dovuto cercarlo **per
> identificativo**. Il numero l'abbiamo tenuto solo come prova che un job *non* esiste, che è la sola
> cosa per cui serve. Corretto dalla nostra parte, e da allora non si è più presentato. Ce ne
> scusiamo: quella riga vi è stata segnalata come vostra e non lo era.

## 3. Caso riproducibile

Ordine di produzione `000700000162`, part `3201816` (`f88d3fb9-0249-4dcb-ac64-3e16bce7b495`).

**Passo 1 — creazione del job.** Richiesta:

```http
POST /scheduling/v1/jobs
Content-Type: application/json

{"partId":"f88d3fb9-0249-4dcb-ac64-3e16bce7b495",
 "dueDate":"2026-08-25T00:00:00.000Z",
 "quantity":10,
 "jobNumber":"000700000162",
 "externalJobCode":"000700000162",
 "jobType":"ZP07",
 "buildingId":"8b32a82e-2b93-4f70-b9ab-9342e4a61e93"}
```

Risposta `201 Created`:

```json
{ "id": "04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f",
  "externalJobCode": "000700000162", "jobNumber": "000700000162",
  "createdDate": "2026-08-20T05:00:00Z",
  "partId": "f88d3fb9-0249-4dcb-ac64-3e16bce7b495",
  "partNumber": "3201816", "partRevision": "", "partNumberRevision": "3201816",
  "dueDate": "2026-08-25T00:00:00Z", "completedDate": null,
  "quantity": 10, "quantityCompleted": null,
  "jobStatus": "New",
  "buildingId": "8b32a82e-2b93-4f70-b9ab-9342e4a61e93", "buildingCode": "Albacina",
  "jobType": "ZP07", "earliestStartDateTime": null, "priority": "Medium",
  "unit": "pcs", "endUnitNumber": "", "bomSubstitutionAllow": null }
```

**Passo 2 — backwards schedule sul job appena creato.** Richiesta:

```http
POST /scheduling/v1/jobs/04e6a16b-fb06-49e0-a4c1-01f2c7e19e9f/backwards-schedule
Content-Type: application/json

{"useFirstApprovedWorkcenter":true}
```

Risposta `500`, con il corpo riportato in §1.

**Passo 3 — dopo il fallimento il job è integro.** `GET /scheduling/v1/jobs/04e6a16b-…` risponde `200`
con la riga qui sopra. La Data Source `4216` restituisce `Job_Key 5030152`; la Data Source `4701`
restituisce le quattro operazioni del job che Plex ha creato insieme alla testata:

| Op | Codice operazione | `Job_Op_Key` | `Part_Operation_Key` |
|---|---|---|---|
| 10 | `V100-Mont Rosette+Deflettore` | `16077979` | `29632992` |
| 20 | `L500-Mont Molla+Progr Calot` | `16077980` | `29632993` |
| 30 | `L1901-Tampone+Docum+Valv` | `16077981` | `29632994` |
| 40 | `L1500-Posiz Calotta+Manopola` | `16077982` | `29632995` |

La Data Source `10603` restituisce le righe di distinta del job per ognuna delle quattro operazioni, e
la Data Source `239905` (`Job_Sort_Order_Update`) risponde `Result_Code 0`,
`"Job Sort Order Updated Successfully"`. Ogni altra interazione con questo job — letture e scritture —
riesce.

## 4. Precondizioni verificate presenti sul tenant

L'operazione è documentata come *«Job Operation due dates are backwards scheduled based on **rates**
specified in process routing»*, quindi abbiamo verificato, con le vostre stesse API, tutto ciò da cui
quel calcolo può dipendere. Le letture sono state fatte sul job che ha fallito.

| Precondizione | Lettura usata | Esito |
|---|---|---|
| La part ha operazioni di ciclo | `GET /mdm/v1/part-operations?partId=` | **4 operazioni** |
| Il job ha operazioni | Data Source `4216` → `4701` | **4 operazioni** (tabella in §3) |
| Le operazioni hanno un work center approvato | `GET /production/v1/production-definitions/approved-workcenters?partId=` | **4 righe approvate**, una per operazione |
| Quei work center approvati portano un rate | stessa lettura | **4 su 4**, dopo che li abbiamo valorizzati — vedi sotto |
| Il job ha un building | `GET /scheduling/v1/jobs/{id}` | `Albacina` |
| La finestra di schedulazione ha ampiezza | stessa lettura | non misurabile: `earliestStartDateTime` è `null`, perché il campo è opzionale e non lo inviamo — il nostro sistema di origine consegna date di inizio e fine pianificate coincidenti per questi ordini |

**Sui rate in particolare.** Erano inizialmente vuoti, ed erano quindi la nostra ipotesi principale. Li
abbiamo valorizzati a mano nell'interfaccia Plex, su `Engineering / ApprovedWorkcenter`,
`PartKey 5097153`, un `PartOperationKey` per operazione (`29632992`, `29632993`, `29632994`,
`29632995`), impostando `Setup (hrs)`, `Standard Rate`, `Ideal Rate`, `Target Rate` e `Crew` a `1`, con
il flag `Schedule` spuntato. La
`GET /production/v1/production-definitions/approved-workcenters?partId=f88d3fb9-…` ora restituisce:

| Op | Work center | `workcenterId` | Rate |
|---|---|---|---|
| 10 | `LFE10` — *Postazione sacco* | `7193b479-93e2-4e40-8158-2adb5864a353` | `standardProductionRate=1`, `idealRate=1`, `targetRate=1`, `setupTime=1`, `crewSize=1` |
| 20 | `LFE60` — *4° Postazione assemblaggio finale* | `59eaa4d6-8b62-4234-95d3-ca7dc30d19a8` | idem |
| 30 | `LFE220` — *19° Postazione assemblaggio finale* | `9698fac0-601b-4f48-993e-7a0ccf0533cc` | idem |
| 40 | `LFE160` — *14° Postazione assemblaggio finale* | `90e9f87d-cabb-41b4-9b33-0038c36af482` | idem |

Con i rate valorizzati abbiamo creato un job **nuovo**, sull'ordine di produzione `000700000163` e sulla
stessa part `3201816`, e abbiamo invocato il Backwards Schedule. Risposta: **`500`**, con lo stesso
corpo. La dipendenza dai rate, che è la descrizione stessa dell'operazione a dichiarare, è quindi
soddisfatta e non è la causa.

## 5. Variabili escluse

Una variabile cambiata per volta, su tre job diversi — fra cui uno creato dopo aver cancellato ogni job
sul tenant e azzerato il nostro stato:

| Variabile | Valori provati | Esito |
|---|---|---|
| `buildingId` | assente · valido (`8b32a82e-…`, `Albacina`) | `500` in entrambi i casi |
| `earliestStartDateTime` | uguale a `dueDate` · assente (`null` sul job) | `500` in entrambi i casi |
| Tipo di `quantity` | stringa JSON `"100.0"` · numero JSON `10` | `500` in entrambi i casi |
| `dueDate` | passata / il giorno stesso · futura (`2026-08-25`) | `500` in entrambi i casi |
| `priority` | assente · `"Medium"`, assegnata dal default del tenant | `500` in entrambi i casi |
| `jobType` | `"ZP07"`, accettato dalla `POST` e memorizzato tale e quale, visibile nell'interfaccia | `500` |
| Età del record del job | preesistente · creato pochi minuti prima | `500` in entrambi i casi |
| Stato del tenant | job preesistenti · ogni job cancellato, ripartenza da zero | `500` in entrambi i casi |
| Rate sui work center approvati | assenti · valorizzati su tutte e quattro le operazioni | `500` in entrambi i casi |

## 6. Valori nulli che non possiamo influenzare, nel caso siano rilevanti

Offerti come informazione per i vostri tecnici, non come diagnosi:

- `sequenceRate` è `null` su tutte e quattro le righe di work center approvato, e l'interfaccia Plex
  **non espone il campo**: non abbiamo modo di valorizzarlo dal tenant.
- `quantityCompleted` è `null` su un job in stato `New` senza produzione registrata, dove `0` sarebbe
  il valore atteso.
- `bomSubstitutionAllow` è `null` nella risposta dell'API, mentre la scheda del job nell'interfaccia
  Plex mostra *BOM Substitution Allowed* spuntato.
- Le righe di distinta del job sull'operazione `10` portano `Child_Unit: "m"` con quantità `0.225` e
  `0.074`, su una part il cui `Unit` è `pc`, e su quelle righe `Unit_Conversion_Key` è `null`.

## 7. Cosa non abbiamo provato

Dichiarato per completezza, così l'elenco delle variabili sopra non venga letto come esaustivo:

- **Un `earliestStartDateTime` strettamente precedente a `dueDate`.** Abbiamo provato «uguale a
  `dueDate`» e «assente», entrambi `500`. Non abbiamo mai inviato una finestra di ampiezza positiva,
  perché il nostro sistema di origine consegna date di inizio e fine pianificate coincidenti per questi
  ordini e deliberatamente non inviamo un vincolo di ampiezza zero. Va notato che il campo è documentato
  come opzionale, quindi un `500` quando è assente è già di per sé un difetto.
- **`useFirstApprovedWorkcenter: false`.** Ogni osservazione di questo documento è stata fatta con
  `true`. La vostra API List per questo progetto suggerisce `false` dove le operazioni vanno schedulate
  su più work center, e da allora abbiamo cambiato il nostro default in `false` — ma la chiamata è
  attualmente sospesa, quindi `false` non è mai stato esercitato verso il vostro servizio.

## 8. Impatto e cosa chiediamo

**L'impatto di questo difetto specifico è limitato**, e lo diciamo apertamente: l'API List fornita per
questo progetto annota proprio questa riga con *«Operator will change the Job Status to Schedule. We can
ignore this step in Integration»*. Abbiamo quindi disabilitato temporaneamente la chiamata nella nostra
integrazione, per non mostrare un errore agli utenti finali; le operazioni del job restano
semplicemente non schedulate dopo la creazione. È un aggiramento, non una soluzione.

Il difetto gemello su `PUT /scheduling/v1/jobs/{id}` è quello che ci blocca, ed è documentato a parte.

**Cosa ci servirebbe da voi:**

1. Conferma se si tratta di un difetto del servizio o di una configurazione del tenant che possiamo
   correggere — e in questo secondo caso, quale impostazione.
2. Se è una lacuna di configurazione, ci aspetteremmo un `400` che nomina il campo invece di un `500`:
   il vostro servizio lo fa già altrove (per esempio `REQUEST_VALIDATION_FAILED` /
   `FIELD_REFERENCE_NOT_FOUND` che nomina `Type` quando il tipo di una part-operation non è presente
   nella tabella di setup del tenant). Un `500` con un messaggio di nullo generico non ci lascia niente
   su cui agire.
3. Se utile, possiamo attivare tracciature aggiuntive lato nostro, rieseguire qualunque richiesta
   specifica indichiate, o fornirvi gli identificativi di ordine e job qui sopra per un'ispezione
   diretta sul tenant.

---

## Chiusura — 27/08/2026

**Rockwell ha corretto il difetto e la correzione è stata verificata dalla nostra parte sul tenant
`ariston-albacin.test`: `POST /scheduling/v1/jobs/{id}/backwards-schedule` risponde.** Insieme è
rientrato il difetto gemello sul `PUT`, che ha il suo documento
([PLEX_ISSUE_JOB_QUANTITY_UPDATE_500](PLEX_ISSUE_JOB_QUANTITY_UPDATE_500.it.md)).

Il corpo di questo documento — §1 fino a §8 — **non è stato riscritto**: è quello consegnato il
20/08/2026, e resta la traccia di ciò che è stato osservato e di come il caso è stato istruito. Va
letto al passato.

Tre note che chiudono altrettanti punti rimasti in sospeso nel testo.

**§7, le due prove mai eseguite.** Erano `useFirstApprovedWorkcenter: false` e un
`earliestStartDateTime` strettamente precedente a `dueDate`. La prima è stata esercitata dal
27/08/2026, quando la chiamata è tornata in esercizio con quel valore. La seconda **continua a non
essere eseguita**, ed è una scelta nostra che resta valida: il sistema di origine consegna date di
inizio e fine pianificate coincidenti, e non inviamo un vincolo di ampiezza zero. Il campo è
opzionale, quindi non c'è nulla da provare.

**§2, terza riga — la rettifica.** La lettura con filtro (`?jobNumber=`, `?partId=`,
`?externalJobCode=`) vi era stata segnalata come una terza faccia dello stesso difetto. **Non lo
era.** Il problema era nostro: cercavamo un job **per numero** dove avremmo dovuto cercarlo **per
identificativo** — l'UUID che la creazione ci aveva già restituito e che memorizziamo. Il numero è
rimasto al suo posto, ma per la sola cosa per cui serve davvero: dimostrare che un job **non**
esiste. Corretto dalla nostra parte, e da allora non si è più presentato. Ce ne scusiamo.

**§8, le tre richieste.** Decadono tutte e tre: era un difetto del servizio, l'avete corretto, e non
c'è nessuna impostazione di tenant da cambiare dalla nostra parte.

Resta valida una sola osservazione generale del §8, e la ripetiamo perché non dipende da questo
difetto: quando manca un dato di configurazione, un `400` che **nomina il campo** è utilizzabile e un
`500` con un messaggio di nullo generico non lo è. Il vostro servizio lo fa già altrove
(`REQUEST_VALIDATION_FAILED` / `FIELD_REFERENCE_NOT_FOUND` su `Type`), ed è la differenza fra un caso
che si chiude in un'ora e uno che ha richiesto due dossier.

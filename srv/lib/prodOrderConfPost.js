/**
 * [PRODCONF-POST] Conferma d'ordine di produzione verso SAP: POST della struttura di conferma
 * sull'iFlow di SAP Integration Suite.
 *
 * A COSA SERVE
 * E' L'INVIO D'ESERCIZIO della conferma d'ordine: la chiamata che il job PROD_CONF fa quando il
 * plant ha `ProdPosting='CONF'` (feature 0030). Una conferma per ORDINE per run: dal 25/09/2026 il
 * job somma le registrazioni dello stesso ordine prima di chiamare qui ([CONF-GROUP],
 * srv/lib/confGroupRules.js), e questa funzione ne riceve una sola. E' l'unico flusso Plex -> SAP
 * del progetto insieme al movimento merci, e l'unico che non ha una modalita' di prova.
 *
 * >>> QUI C'ERA ANCHE UNA SONDA, ED E' STATA RIMOSSA. <<<
 * Il modulo e' nato come batteria di SEI VARIANTI su un ordine vero, per rispondere a «quale forma
 * vuole questo endpoint?». La domanda ha una risposta dal 02/09/2026, scritta in DEC-119: la forma
 * della risposta e' dichiarata dal team Integration e la regola d'esito e' in esercizio. Per
 * DEC-123 una sonda si toglie quando la domanda che le ha dato origine ha una risposta, e con lei
 * si toglie cio' che solo lei teneva in vita — qui: le sei varianti, il blocco DATI del time ticket
 * di collaudo, la lettura della chiave dall'ordine, il verdetto, la GET `$metadata` e le sei leve
 * `PRODCONF_POST_*` che le pilotavano.
 *
 * >>> E CON LA SONDA E' USCITA `PRODCONF_POST`, CHE NON ERA PIU' SOLO LA SUA LEVA. <<<
 * La 0030 l'aveva promossa a terzo cancello del flusso vero (DEC-94), sopra la casella per plant. Era
 * sbagliato per un job batch, per la stessa ragione con cui la 0046 ha tolto `ORDER_STATUS_POST` dai
 * suoi due flussi: quella leva sta a `off` in produzione e si apre solo con un RILASCIO, quindi la
 * scheda «Consuntivazione» poteva dichiarare «invia le conferme d'ordine a SAP» e il job non
 * mandarne nessuna. Un flusso schedulato che parte deve scrivere, e l'interruttore e' ora UNO SOLO:
 * `ZProdConfPostingConfig.ConfPostEnabled`, fail-closed per default e piu' rapido di un rilascio.
 * Vedi la testata di `readTransportConfig`, dove `enabled` si CANCELLA.
 *
 * LA STORIA DEI RIFIUTI RESTA, perche' e' la provenienza della forma che oggi si manda: sono i SETTE
 * ERRORI che questo endpoint ha risposto fra l'11 e il 18/08/2026, in ordine di quanto lontano e'
 * arrivato il messaggio:
 *
 *   11/08  forma `fm`                  500 «Illegal argument … 'IS_CONFIRMATION'»   ingresso iFlow
 *          `entity` coi vuoti omessi   «OrderSuboperation MANCA»                    piu' a valle
 *          `entity` + "" sul Guid      400 EdmSimpleTypeException                   EDM
 *          `entity` + null sul Guid    CX_SY_CONVERSION_DATA_LOSS da ECC            ABAP
 *   17/08  `entity`, dati veri         500 «class [B cannot be cast to java.util.Map»  CPI, in Java
 *   17/08  batteria, 3 varianti su 6   E RU 005 «Sequence 0 is not defined …»        ABAP, dal BAPI
 *   18/08  sequenza forzata a 000000   E RU 028 «Two operation times are not in ascending order»
 *
 * `[B` e' `byte[]`: su quel `500` un passo Java di Cloud Integration ha ricevuto i byte crudi del
 * corpo dove voleva una `Map`. Non e' un letterale, non e' un nome di proprieta', non e' ABAP — e la
 * stessa stringa il progetto l'ha gia' vista su un altro iFlow
 * (docs/0013-collegamento-path-is.md, `PRODUCT_DESCRIPTION_GET`), dove l'ipotesi a verbale e' «il
 * ramo *tabella vuota* della mappatura».
 *
 * >>> LA BATTERIA HA RISPOSTO AL PRIMO GIRO: TRE VARIANTI SU SEI SONO ARRIVATE AL BAPI. <<<
 * Quindi l'integrazione FUNZIONA: il messaggio attraversa l'iFlow, arriva in ECC, ed e' il BAPI a
 * rifiutarlo — per un NOSTRO dato. La sequenza `0` veniva dallo screenshot di CO11N, dove `0` e' cio'
 * che la transazione MOSTRA; AFRU vuole altro. Ed e' il verdetto che ha reso la sonda rimovibile: la
 * chiave della conferma NON SI INDOVINA, si legge dall'ordine — e per l'esercizio la legge
 * srv/lib/confMatDoc.js, che compone `data.confirmation` prima di chiamare qui.
 *
 * >>> E IL 18/08/2026 IL BAPI HA RISPOSTO DUE VOLTE ANCORA, E SONO DUE REGOLE, NON DUE INTOPPI. <<<
 * Col debugger fermo su `ZMARS_PROD_ORDER_CONF_POST` e la sequenza forzata a mano:
 *
 *   1. LA SEQUENZA VA IN FORMA INTERNA. `0` viene rifiutato, `000000` no. Leggerla non basta: su
 *      questo canale e' arrivata senza riempimento, e `Sequence` e' un CHAR nell'inventario, quindi
 *      la codifica non lo riempiva (i `numc` si, i `char` no). Il riempimento e' dell'EMISSIONE, per
 *      entrambe le provenienze — la lettura e il blocco DATI. Vedi srv/lib/prodOrderConfKey.js.
 *   2. UNA COPPIA DI TEMPI SI MANDA INTERA O NON SI MANDA. Passato il primo rifiuto e' arrivato
 *      `E RU 028 «Two operation times are not in ascending order»`: partiva
 *      `ConfirmedProcessingStartTime` e non la `...EndTime`, cioe' fine a mezzanotte e inizio alle
 *      14:22. I tempi d'operazione ora NON si mandano affatto — vedi `valuesFor`.
 *
 * Le due regole insieme sono anche il metodo: da un rifiuto applicativo si impara qualcosa SOLO se
 * il messaggio si legge. Che questi due si siano dovuti leggere col debugger su ECC e' la ragione
 * per cui `findMessages` cerca `LT_DETAIL` nella risposta, e per cui il contratto lo chiede al team
 * Integration (srv/external/PROD_ORDER_CONF_POST_IS.md).
 *
 * COSA E' DEFINITIVO E COSA NO
 * Definitivi sono il contratto, il trasporto, i dati (li compone il chiamante) e la lettura
 * dell'esito. Provvisorio resta l'INDIRIZZO: vedi il punto 2 qui sotto.
 *
 * TRE DIFFERENZE DAL MOVIMENTO MERCI [MATDOC-POST], E SONO QUELLE SU CUI SI SBAGLIA
 *
 * 1. NON ESISTE `IV_TEST_RUN`. La FM `ZMARS_PROD_ORDER_CONF_POST` prende `IS_CONFIRMATION` +
 *    `IV_POST_ERRORS` e basta: nessuna registrazione in prova. La rete di sicurezza del movimento
 *    merci qui NON C'E', e l'unico annullamento e' uno storno in CO13. Per questo l'autorizzazione a
 *    scrivere e' un interruttore SUO — `ConfPostEnabled` nella scheda del plant — e non il flag di
 *    prova dei movimenti merci: accenderla e' un'autorizzazione diversa. L'esito lo dice `ORDERID`
 *    (vedi `readOutcome`): una conferma che non lo riporta non e' registrata, e si ritenta.
 *
 * 2. IL PATH PUBBLICATO E' UN SERVICE ROOT ODATA, non un HTTPS sender. Il foglio degli endpoint
 *    (EndpointFlussiMARS_V1.xlsx, riga 23) dichiara
 *    `/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_PRODUCTIONORDER_CONFIRMATION_POST;v=1`
 *    con entity `ProdnOrdConf2`. Ma lo stesso foglio dichiarava un service root OData anche per il
 *    movimento merci (riga 20), e sul campo si e' rivelato un HTTPS sender
 *    (`/http/btpmars/sapecc/1110.02/materialdocument`, srv/external/MATERIAL_DOC_POST_IS.md). Quindi il path
 *    del foglio e' il punto di partenza, non un dato acquisito.
 *
 *    Da qui `PRODCONF_POST_PATH` e `PRODCONF_POST_ENTITYSET`: sono i due assi lungo cui si trova la
 *    forma giusta SENZA un ciclo di deploy per tentativo. Con la busta della FM su un entity set
 *    OData, Olingo rifiutera' le proprieta' che non conosce: se succede, la risposta stessa dira'
 *    che l'indirizzo e' un sender OData vero e non un wrapper piatto, ed e' meta' della diagnosi.
 *
 * 3. LA RISPOSTA E' UNA TABELLA DI RIGHE DI CONFERMA, non un messaggio: le stesse della richiesta
 *    piu' le due chiavi. L'esito si legge dalle CHIAVI, non da un TYPE:
 *
 *      CONFIRMATIONGROUP valorizzato  ->  quella riga E' STATA registrata
 *      CONFIRMATIONGROUP vuoto        ->  quella riga NON e' stata registrata
 *
 *    >>> [CONF-OUTCOME] DAL 25/09/2026 LE CHIAVI NON DECIDONO PIU' NIENTE: DECIDE `ORDERID`, su
 *        ogni forma (vedi `readOutcome`). Quello che segue e' la storia di come ci si e' arrivati. <<<
 *    >>> DAL 02/09/2026 QUESTA NON E' PIU' LA SOLA FORMA, E LE DUE CHIAVI NON TORNANO. <<<
 *    Il team Integration ha dichiarato la risposta dell'iFlow: `OrderID` **e** `ConfirmationText`
 *    quando la conferma e' registrata, il solo `ConfirmationText` — col motivo del rifiuto dentro —
 *    quando non lo e'. Quindi due regole d'esito convivono, e a scegliere e' la FORMA della riga
 *    arrivata (vedi `readOutcome`): su un'eco completa decidono le chiavi, sull'esito breve decide
 *    `OrderID`. Sostituire l'una con l'altra sarebbe sbagliato in entrambi i versi: in un'eco
 *    completa `ORDERID` c'e' anche su un RIFIUTO, e prenderlo per esito dichiarerebbe registrata una
 *    conferma respinta; con la sola regola delle chiavi, l'esito breve non e' nemmeno una riga —
 *    `looksLikeRow` ne pretende tre campi — e ogni conferma REGISTRATA finirebbe archiviata come
 *    «esito non conclusivo», cioe' quantita' confermata perduta senza un errore da nessuna parte.
 *
 *    >>> CORREZIONE DEL 17/08/2026: «NON C'E' UN ET_RETURN» ERA FALSO. <<<
 *    Qui c'era scritto che un messaggio applicativo non esiste, perche' la specifica della FM
 *    dichiarava `IS_CONFIRMATION` + `IV_POST_ERRORS` e nient'altro. Fermando il debugger su
 *    `ZMARS_PROD_ORDER_CONF_POST` e' comparsa la tabella `LT_DETAIL`, un BAPIRET2 in piena regola,
 *    col motivo del rifiuto in chiaro: `E RU 005 «Sequence 0 is not defined in order 700000080»`.
 *    La regola non era piu' povera di un BAPIRET2: il BAPIRET2 c'era e non lo stavamo leggendo. Da
 *    qui `findMessages`, che lo cerca PER FORMA come le righe di conferma — se l'iFlow lo rimanda, il
 *    motivo arriva nel log; se non lo rimanda, e' cio' che va chiesto al team Integration, e il
 *    verdetto lo scrive da solo.
 *
 * LE DUE FORME DEL CORPO, E PERCHE' NE ESISTONO DUE
 * La specifica della FM diceva `{ IS_CONFIRMATION: {…}, IV_POST_ERRORS }`. Alla prima chiamata
 * reale, l'11/08/2026, l'endpoint ha risposto:
 *
 *   HTTP 500  server: SAP  dataserviceversion: 1.0
 *   {"error":{"code":"INTERNAL_SERVER_ERROR","message":{"lang":"en",
 *     "value":"Illegal argument for method call with message 'IS_CONFIRMATION'."}}}
 *
 * `dataserviceversion: 1.0` e quella busta d'errore sono di un servizio **OData V2 vero**, che
 * valida il corpo contro un EDM: `IS_CONFIRMATION` non e' una sua proprieta'. E' la stessa
 * contraddizione del § 0 di srv/external/MATERIAL_DOC_POST_IS.md, con una differenza che cambia
 * tutto: qui NON serve un deep insert — la conferma e' una struttura singola — quindi una POST
 * OData sull'entity set e' perfettamente fattibile.
 *
 *   shape 'entity'  (predefinita)  entity ProdnOrdConf2 piatta, nomi EDMX, JSON di OData V2
 *   shape 'fm'                     la busta della FM, nomi ABAP, letterali XSD — quella rifiutata
 *
 * I CAMPI VUOTI CI VANNO COMUNQUE. Nella forma `entity` si era partiti OMETTENDO i campi senza
 * valore: su un EDM il campo assente vale «non fornito», che sembra proprio cio' che si vuole dire,
 * e il corpo scendeva da 105 campi a 18. L'endpoint ha risposto che `OrderSuboperation` MANCAVA.
 * Dietro l'EDM c'e' una FM che vuole la struttura intera, esattamente come sul movimento merci: i
 * campi si mandano tutti e 105, coi letterali vuoti del loro tipo (`""` per le stringhe, `false`
 * per i flag, `null` per date, ore, decimali e interi — `""` su quei tipi sarebbe illegale).
 * `PRODCONF_POST_EMPTY=off` torna a ometterli.
 *
 * I BOOLEANI: I DUE STRATI DELL'ENDPOINT VOGLIONO COSE INCOMPATIBILI.
 * L'EDM dichiara `IsFinalConfirmation` come `Edm.Boolean` e pretende `true`/`false`. Dietro l'EDM
 * c'e' pero' una FM ABAP esposta come web service, e li' lo stesso campo e' un XFELD CHAR(1):
 * mandando `false`, Simple Transformation ha risposto
 *
 *   CX_ST_DESERIALIZATION_ERROR / CX_SY_CONVERSION_DATA_LOSS
 *   REF_NAME: ISFINALCONFIRMATION   VALUE: false   «Data loss occurred when converting false»
 *
 * — il testo `false` e' 5 caratteri e in un CHAR(1) non entra. La natura dei campi e' quella gia'
 * nota dal movimento merci; la differenza e' che li' davanti NON c'e' un EDM e `"X"`/`""` passa
 * liscio, mentre qui l'EDM c'e' e `"X"` non e' un `Edm.Boolean` valido.
 *
 * NESSUN VALORE SODDISFA ENTRAMBI GLI STRATI: la conversione la deve fare il mapping dell'iFlow.
 * Il default resta `edm`, perche' e' il contratto che l'endpoint PUBBLICA e mandare altro sarebbe
 * violarlo di nostra iniziativa. `PRODCONF_POST_BOOL=abap` prova l'altro corno senza un rilascio,
 * e se anche quello viene respinto — stavolta dall'EDM — la coppia di errori e' la dimostrazione
 * che il problema non e' nel nostro messaggio.
 *
 * `fm` resta perche' e' la forma giusta se l'indirizzo diventasse un HTTPS sender, che e'
 * esattamente com'e' finita per il movimento merci. Si commuta con `PRODCONF_POST_SHAPE`, senza
 * rilascio. Le due codifiche stanno entrambe in srv/lib/sapPostEncoding.js, dove il commento in
 * mezzo elenca le differenze riga per riga: la piu' insidiosa e' che in XSD un campo senza valore
 * dev'esserci vuoto, mentre in OData V2 va OMESSO.
 *
 * IL CONTRATTO DELLA RISPOSTA
 *
 *   -> tabella di righe da 107 campi (le stesse 105 + CONFIRMATIONGROUP + CONFIRMATIONCOUNT)
 *
 * LE CHIAVI NON VANNO IN RICHIESTA. `ConfirmationGroup` / `ConfirmationCount` le assegna SAP: la
 * struttura di ingresso ne ha 105, la riga di risposta 107. E' l'unica asimmetria fra le due
 * direzioni, ed e' marcata `key: true` nell'inventario — non e' un elenco scritto a mano qui.
 *
 * IL NOME DEL PARAMETRO DI RISPOSTA NON E' NOTO. Per questo il lettore cerca la tabella PER FORMA e
 * non per nome (vedi `findRows`): riconosce un array di oggetti che somigliano a righe di conferma
 * ovunque sia annidato, e DICHIARA dove l'ha trovato in `responseShape`. Cosi' la prima chiamata
 * reale risponde alla domanda, invece di richiedere un altro giro di specifiche.
 *
 * `IV_POST_ERRORS` esiste solo nella forma `fm`, e parte a `""`: non si chiede a SAP di registrare
 * conferme con errori risolvibili. Nella forma `entity` non ha dove stare, e non e' una perdita —
 * vuoto e' comunque il comportamento predefinito.
 *
 * L'INVENTARIO DEI TIPI e' generato dall'EDMX (srv/external/generate-prodconf-fields.js), non
 * scritto a mano: e' cio' che rende la codifica applicata a tutti i campi e non ai casi a cui uno
 * pensa mentre scrive. Ed e' anche il motivo per cui aggiungere la seconda forma e' costato un
 * encoder e non un secondo elenco di campi.
 *
 * IL TRASPORTO e' il servizio remoto CAP, non executeHttpRequest: `srv.send({method:'POST', path,
 * data})` bypassa la traduzione CQN e il body passa VERBATIM, mantenendo destination, timeout,
 * resilience, CSRF e propagazione del JWT utente gestiti da CAP.
 *
 * CSRF ACCESO PER DEFAULT, al contrario del movimento merci. Il path dichiarato e' un service root
 * OData, e sul primo indirizzo OData V2 del matdoc il `CsrfPreventionFilter` di Tomcat rispondeva
 * 403 (la storia e' in srv/lib/materialDocPost.js). Se anche questo endpoint si rivelasse un HTTPS
 * sender, `PRODCONF_POST_CSRF=off` lo spegne: il fetch fa DUE HEAD prima della POST, che su un
 * sender rischiano di generare voci MPL spurie nel monitor di Cloud Integration.
 *
 * LEVE — DESCRIVONO L'ENDPOINT, NON IL COMPORTAMENTO, e nessuna decide SE scrivere.
 * Sono i tre assi lungo cui si trova la forma giusta senza un ciclo di deploy per tentativo, e il
 * loro default e' il contratto pubblicato. Se un giorno servisse un freno rapido, la risposta e' la
 * casella del plant, non una variabile nuova qui: vedi `readTransportConfig`, e la rete che lo
 * sorveglia e' test/confPostLeverSurface.test.js.
 *
 *   PRODCONF_POST_SHAPE        'entity' | 'fm' — forma del corpo
 *   PRODCONF_POST_EMPTY=off    omette i campi senza valore invece di mandarli vuoti
 *   PRODCONF_POST_BOOL         'edm' (true/false) | 'abap' ("X"/"") — vedi «I BOOLEANI»
 *   PRODCONF_POST_PATH         indirizzo alternativo
 *   PRODCONF_POST_ENTITYSET    entity set alternativo; stringa vuota = POST sul service root
 *   PRODCONF_POST_CSRF=off     disattiva il fetch del token (controprova della diagnosi 403)
 * Perimetro completo: grep -rn "PRODCONF-POST"
 *
 * Contratto verso il team Integration: srv/external/PROD_ORDER_CONF_POST_IS.md
 */

'use strict';

const cds = require('@sap/cds');
const { upstreamStatus, errorText } = require('./isRemoteSource');
const { toAbapStruct, toODataV2Entity } = require('./sapPostEncoding');
// [IS-EGRESS] come esce una chiamata verso gli iFlow da questo processo: la destination vive in un
// punto solo.
const { resolveEgress } = require('./isEgress');
// Forma interna dei codici chiave: regola pura, condivisa col job PROD_CONF, che dal 18/08/2026
// legge la sequenza allo stesso modo. Vedi il modulo per il perche'.
//
// NON SI IMPORTA PIU' `prodOrderSource`, e nemmeno `pickOperation`: erano la LETTURA della chiave
// della sonda — «quale operazione confermo, su quale ordine di collaudo» — cioe' una domanda che qui
// non si pone piu'. L'ordine e la chiave arrivano dal chiamante, costruiti da
// srv/lib/confMatDoc.js. `pickOperation` resta a casa sua con il suo test
// (test/prodOrderConfKey.test.js), che la copre meglio del duplicato che stava qui.
const { internalConfKeys, sameOrderKey } = require('./prodOrderConfKey');

/**
 * Inventario dei 107 campi dell'entity con il loro tipo ABAP. Generato da
 * srv/external/generate-prodconf-fields.js dall'EDMX del servizio standard, cosi' la codifica
 * applicata qui non puo' divergere dai tipi veri. `cds build` copia `srv/**` per intero in gen/srv,
 * quindi il file c'e' anche in produzione.
 */
const FIELDS = require('../external/ZMARS_PRODCONF_POST.fields.json').confirmation;

/**
 * I 105 campi che vanno in RICHIESTA: l'entity meno le due chiavi, che le assegna SAP. Il filtro
 * e' sul marcatore dell'inventario e non su un elenco scritto qui: se un domani l'entity cambiasse
 * chiave, la richiesta la seguirebbe da sola.
 */
const REQUEST_FIELDS = FIELDS.filter((f) => !f.key);

/** I nomi ABAP delle due chiavi: sono l'esito su un'eco completa della riga di conferma. */
const KEY_GROUP = FIELDS.find((f) => f.name === 'ConfirmationGroup').abap;
const KEY_COUNT = FIELDS.find((f) => f.name === 'ConfirmationCount').abap;

/**
 * [CONF-OUTCOME] I nomi ABAP dei due soli campi dell'ESITO BREVE, la risposta dichiarata il
 * 02/09/2026: l'ordine (c'e' se la conferma e' registrata) e il testo (c'e' sempre, e su un rifiuto
 * porta il motivo). Si ricavano dall'inventario come le chiavi, e non si scrivono a mano: un nome
 * ABAP battuto a mano che non esistesse darebbe `undefined`, cioe' un esito letto sempre come
 * rifiuto — e nessun errore.
 */
const KEY_ORDER = FIELDS.find((f) => f.name === 'OrderID').abap;
const KEY_CONF_TEXT = FIELDS.find((f) => f.name === 'ConfirmationText').abap;
/** I campi dell'esito breve: un oggetto che non ne ha ALTRI dell'entity e' quella forma. */
const SHORT_NAMES = new Set([KEY_ORDER, KEY_CONF_TEXT]);

/** Entry di cds.requires che porta le credenziali verso la destination. */
const BASE = 'API_PROD_ORDER_CONFIRMATION_2_SRV';

// `enabled` NON C'E', e non e' una dimenticanza: vedi la testata di `readTransportConfig`. Un campo
// con quel nome qui tornerebbe a essere letto come una leva anche senza nessuna variabile d'ambiente
// che lo scriva, ed e' precisamente il trabocchetto che la 0046 ha pagato sul modulo gemello.
const DEFAULTS = {
  destination: 'MARS_SAP_CON',
  // EndpointFlussiMARS_V1.xlsx riga 23, iFlow
  // F1110.01_Operations_SAPBTPMARS_SAPECC_ProductionOrder_Confirmation_Post
  path: '/gw/odata/SAP/F1110.01_OPERATIONS_SAPBTPMARS_SAPECC_PRODUCTIONORDER_CONFIRMATION_POST;v=1',
  entitySet: 'ProdnOrdConf2',
  // 'entity' = entity OData V2 piatta | 'fm' = busta della function module. Vedi «LE DUE FORME».
  shape: 'entity',
  // Solo per 'entity': i campi senza valore ci sono comunque, col letterale vuoto del loro tipo.
  // Ometterli sembrava giusto su un EDM, e l'endpoint ha risposto che OrderSuboperation MANCAVA.
  keepEmpty: true,
  // 'edm' = true/false (contratto pubblicato) | 'abap' = "X"/"" (cio' che vuole la FM dietro).
  // I due strati dell'endpoint vogliono cose diverse: vedi «I BOOLEANI» nella testata.
  booleans: 'edm',
  csrf: true,               // sender OData V2: il token serve, ed e' stato ottenuto. Vedi la testata
  requestTimeout: 60000
};

// ---------------------------------------------------------------------------------------------
// COSTRUZIONE DEL BODY
// ---------------------------------------------------------------------------------------------

/**
 * I valori in forma naturale, comuni alle due forme: il mock piu' cio' che dipende dall'istante, con
 * le chiavi portate in forma interna. FUNZIONE PURA.
 *
 * >>> NESSUN TEMPO D'OPERAZIONE, E NON E' UNA DIMENTICANZA. <<<
 * Fino al 18/08/2026 partivano `ConfirmedProcessingStartDate`, `...EndDate` e `...StartTime`, tutti
 * e tre con l'istante di invio. La `...EndTime` no — e sull'EDM un `Edm.Time` senza valore parte
 * `null`, che in ABAP e' `000000`. Quindi SAP leggeva inizio lavorazione alle 14:22 e FINE a
 * mezzanotte dello stesso giorno, e il BAPI ha risposto:
 *
 *   E  RU  028  Two operation times are not in ascending order
 *
 * Le durate vere non le abbiamo: l'endpoint Plex espone un solo `transactionDate`
 * (docs/0009-job-plex-e-consuntivazioni.md, RB-20), quindi qualunque coppia inizio/fine costruita
 * qui sarebbe inventata. I tempi li deriva SAP dai valori standard dell'operazione, e la conferma
 * dichiara la sola `PostingDate`. Se un domani servissero davvero, si mandano a COPPIE COMPLETE e
 * crescenti — data e ora di ogni estremo, tutte o nessuna: mezza coppia e' precisamente questo
 * rifiuto. Vedi DEC-59.
 *
 * Effetto collaterale dichiarato: il letterale `tims` (`PT9H30M5S`) non parte piu' sul filo, e la
 * sua copertura vive solo in test/prodOrderConfPost.test.js — come per `Personnel` e
 * `CapacityRequirementSplit`, che per la stessa ragione erano stati tolti dai dati della sonda.
 */
function valuesFor(data, day, orderId) {
  // internalConfKeys tocca SOLO Sequence/OrderOperation/OrderSuboperation, e non OrderID: la forma
  // interna di quello e' un letterale della configurazione. Vedi srv/lib/prodOrderConfKey.js.
  return internalConfKeys({
    ...data,
    OrderID: orderId,
    PostingDate: day
  });
}

/**
 * FORMA `fm` — la busta della function module, coi valori in letterali XSD.
 * E' quella che l'endpoint ha RIFIUTATO l'11/08/2026 (vedi la testata, «LE DUE FORME»). Resta
 * perche' e' la forma giusta se un domani l'indirizzo diventasse un HTTPS sender, com'e' successo
 * al movimento merci.
 */
function buildFmPayload(data, day, orderId) {
  return {
    // REQUEST_FIELDS e non FIELDS: le due chiavi le assegna SAP e non vanno in richiesta.
    IS_CONFIRMATION: toAbapStruct(REQUEST_FIELDS, valuesFor(data, day, orderId)),
    // XFELD: "X" registrerebbe anche conferme con errori risolvibili. Vuoto di proposito.
    IV_POST_ERRORS: ''
  };
}

/**
 * FORMA `entity` — l'entity `ProdnOrdConf2` piatta, coi valori in JSON di OData V2.
 * Nomi di proprieta' EDMX e TUTTI E 105 I CAMPI, anche quelli senza valore, col letterale vuoto del
 * loro tipo EDM (`keepEmpty`). Verso l'Integration Suite la struttura si manda INTERA: dietro l'EDM
 * c'e' una FM che vuole tutti i campi, e omettere quelli vuoti si e' tradotto in «OrderSuboperation
 * MANCA» — vedi «I CAMPI VUOTI CI VANNO COMUNQUE» nella testata. Non e' una preferenza di stile.
 *
 * Non c'e' un posto dove mettere `IV_POST_ERRORS`: su un'entity non esistono parametri della FM.
 * Non e' una perdita — lo mandavamo vuoto, che e' il comportamento predefinito.
 */
function buildEntityPayload(data, day, orderId, keepEmpty = DEFAULTS.keepEmpty,
  booleans = DEFAULTS.booleans) {
  return toODataV2Entity(REQUEST_FIELDS, valuesFor(data, day, orderId), { keepEmpty, booleans });
}

/**
 * Costruisce il body nella forma richiesta. FUNZIONE PURA: nessun accesso a rete, a cds o
 * all'orologio — il giorno e l'ordine arrivano da fuori. E' cio' che la rende collaudabile in
 * test/prodOrderConfPost.test.js senza sistemi esterni, come splitRules.js e isQueryShape.js.
 *
 * @param {object} data valori in forma naturale (il blocco MOCK)
 * @param {Date} day istante di invio: date e ora di lavorazione
 * @param {string} orderId ordine su cui si conferma — l'invariante di sicurezza
 * @param {string} shape 'entity' | 'fm'
 * @param {boolean} keepEmpty solo per 'entity': i campi senza valore ci sono comunque
 * @param {string} booleans solo per 'entity': 'edm' | 'abap'
 * @returns {object} il JSON esatto che finira' nel body della POST
 */
function buildPayload(data, day, orderId, shape = DEFAULTS.shape, keepEmpty = DEFAULTS.keepEmpty,
  booleans = DEFAULTS.booleans) {
  return shape === 'fm'
    ? buildFmPayload(data, day, orderId)
    : buildEntityPayload(data, day, orderId, keepEmpty, booleans);
}

/**
 * L'INVOLUCRO. `{"d": { … }}` e' la forma canonica di un entry JSON in OData V2, e in RICHIESTA non
 * l'abbiamo mai provata: mandiamo l'entity nuda. In LETTURA il wrapper `d` lo conosciamo bene — CAP
 * lo toglie da solo (`_purgeODataV2`) ed e' il contratto C-1 verso l'Integration Suite — ma da «lo
 * mette in risposta» non segue «lo vuole in richiesta», e nemmeno il contrario. FUNZIONE PURA.
 */
function wrapEnvelope(payload, envelope) {
  return envelope === 'd' ? { d: payload } : payload;
}

/**
 * [CONF-OUTCOME] Come si NOMINA una conferma registrata. FUNZIONE PURA.
 *
 * Le due chiavi se la risposta le porta, altrimenti l'ordine su cui e' stata registrata. Esiste
 * perche' `${group}/${count}` su una risposta che non porta le chiavi stampa `/`, e `/` si legge
 * come «non ha registrato niente» proprio nella frase che dice il contrario: la riga di log
 * dell'invio. (Erano tre — le altre due erano l'arresto della batteria e il verdetto della sonda.)
 *
 * @param {object} r la riga di esito
 * @param {string} [fallbackOrder] l'ordine su cui si e' scritto, quando la risposta non lo rimanda
 */
function confLabel(r, fallbackOrder) {
  const o = r || {};
  // Le chiavi a zeri non sono un numero di conferma: stampate direbbero «conferma 0000000000/00000000».
  if (isAssignedKey(String(o.confirmationGroup || '').trim())) {
    return `${o.confirmationGroup}/${o.confirmationCount}`;
  }
  const ordine = String(o.orderIdReturned || fallbackOrder || '').trim();
  return ordine ? `sull'ordine ${ordine}` : '(senza chiavi né ordine restituito)';
}

/**
 * Somiglia a un messaggio applicativo? FUNZIONE PURA.
 *
 * Serve almeno un `TYPE` o un `MESSAGE` valorizzato piu' un secondo campo noto: con la sola presenza
 * dei nomi si prenderebbe per messaggio anche una riga di conferma, che ha un `ROW`. Il numero
 * d'ordine no: `NUMBER` in un BAPIRET2 e' il numero del messaggio, e in una conferma non c'e'.
 */
function looksLikeMessage(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v).map((k) => k.toUpperCase());
  const noti = keys.filter((k) => MSG_NAMES.has(k));
  if (noti.length < 2) return false;
  // Una riga di conferma non e' un messaggio, nemmeno se condivide un nome di campo.
  if (keys.some((k) => ROW_NAMES.has(k) && !MSG_NAMES.has(k))) return false;
  const val = (k) => {
    const hit = Object.keys(v).find((x) => x.toUpperCase() === k);
    return hit ? String(v[hit] == null ? '' : v[hit]).trim() : '';
  };
  return !!(val('MESSAGE') || val('TYPE') || val('ID'));
}

/**
 * Cerca i messaggi applicativi nella risposta, PER FORMA e non per nome. FUNZIONE PURA.
 *
 * Lo stesso metodo di `findRows`, e per la stessa ragione: il nome del parametro d'uscita non ci e'
 * stato dichiarato. Nel debugger la tabella si chiama `LT_DETAIL`, ma come l'iFlow la rimandi — se la
 * rimanda — non lo sappiamo, e cercarla per nome vorrebbe dire dire «nessun messaggio» quando il
 * messaggio c'e'.
 *
 * @returns {{messages: object[], shape: string}}
 */
function findMessages(body) {
  const MAX_DEPTH = 6;
  if (!body || typeof body !== 'object') return { messages: [], shape: '' };

  const walk = (v, path, depth) => {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return null;
    if (Array.isArray(v)) {
      const hits = v.filter(looksLikeMessage);
      if (hits.length) return { messages: hits, shape: path };
      for (let i = 0; i < v.length; i++) {
        const r = walk(v[i], `${path}[${i}]`, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (looksLikeMessage(v)) return { messages: [v], shape: `${path} (messaggio singolo)` };
    for (const [k, child] of Object.entries(v)) {
      const r = walk(child, path === '(risposta)' ? k : `${path}.${k}`, depth + 1);
      if (r) return r;
    }
    return null;
  };

  return walk(body, '(risposta)', 0) || { messages: [], shape: '' };
}

/**
 * Il messaggio che conta, cioe' il primo errore se c'e'. FUNZIONE PURA.
 * `E`/`A`/`X` sono rifiuti, `S`/`I`/`W` no: su una tabella con dentro entrambi, mostrare il primo in
 * ordine di riga vorrebbe dire mostrare un'informativa e tacere l'errore.
 */
function pickMessage(messages) {
  const val = (m, k) => {
    const hit = Object.keys(m || {}).find((x) => x.toUpperCase() === k);
    return hit ? String(m[hit] == null ? '' : m[hit]).trim() : '';
  };
  const list = Array.isArray(messages) ? messages : [];
  const grave = list.find((m) => ['E', 'A', 'X'].includes(val(m, 'TYPE').toUpperCase()));
  const m = grave || list[0];
  if (!m) return { type: '', id: '', number: '', text: '' };
  return {
    type: val(m, 'TYPE'),
    id: val(m, 'ID'),
    number: val(m, 'NUMBER'),
    text: val(m, 'MESSAGE')
  };
}

/*
 * LA CHIAVE DELLA CONFERMA SI LEGGE, NON SI INDOVINA — E NON SI LEGGE QUI.
 *
 * Qui stava `resolveOrderKey`, che interrogava `A_ProductionOrderOperation_2` per sapere sequenza,
 * operazione, plant, centro di lavoro e unita' dell'ordine di collaudo. Era della SONDA: serviva a
 * costruire un time ticket verosimile su un ordine scelto da una variabile d'ambiente, ed e' uscita
 * con lei.
 *
 * La regola che ha insegnato resta, ed e' in esercizio in due posti:
 *   - `internalConfKeys` (srv/lib/prodOrderConfKey.js) mette i codici chiave in forma INTERNA
 *     all'emissione — `0` viene rifiutato con `E RU 005`, `000000` no. Vedi la testata di questo
 *     file, punto 1 delle due regole del 18/08/2026;
 *   - `pickOperation`, nello stesso modulo, scegle l'operazione da confermare, e per il job che
 *     scrive una conferma contabile pretende una corrispondenza ESATTA (`exact`): un ripiego sulla
 *     prima operazione era un dato in piu' per una sonda, qui sarebbe una conferma sull'operazione
 *     sbagliata.
 *
 * Chi compone `data.confirmation` per l'esercizio e' srv/lib/confMatDoc.js.
 */

// ---------------------------------------------------------------------------------------------
// LETTURA DELL'ESITO
// ---------------------------------------------------------------------------------------------

/**
 * L'MPL ID che Cloud Integration mette nel messaggio d'errore:
 *   "An internal server error occured: The MPL ID for the failed message is : AGp1rc…"
 *
 * E' il *Message Processing Log*, e vale piu' del codice HTTP: esiste solo per messaggi che il
 * runtime ha accettato e iniziato a elaborare, ed e' la chiave con cui il team Integration apre
 * l'esecuzione fallita nel proprio monitor. Sepolto nel testo non lo userebbe nessuno.
 */
function extractMplId(body) {
  const s = typeof body === 'string' ? body : safeStringify(body);
  const m = /MPL\s*ID[^:]*:\s*([\w-]+)/i.exec(s || '');
  return m ? m[1] : '';
}

/** I nomi ABAP dei campi di conferma: servono a RICONOSCERE una riga senza sapere come si chiama. */
const ROW_NAMES = new Set(FIELDS.map((f) => f.abap));

/**
 * I campi di un messaggio applicativo, cioe' di un BAPIRET2.
 *
 * >>> «NON C'E' UN ET_RETURN» ERA FALSO, E CI E' COSTATO UNA SESSIONE DI DEBUGGER. <<<
 *
 * La specifica della FM dichiarava `IS_CONFIRMATION` + `IV_POST_ERRORS` e nient'altro, e questo
 * modulo era costruito sull'idea che l'esito si potesse leggere SOLO dalle chiavi: chiavi presenti =
 * registrata, chiavi vuote = rifiutata, senza sapere perche'. Il 17/08/2026, fermando il debugger su
 * `ZMARS_PROD_ORDER_CONF_POST`, e' comparsa la tabella `LT_DETAIL` con esattamente la forma di un
 * BAPIRET2 e dentro il motivo del rifiuto, in chiaro:
 *
 *   TYPE E  ID RU  NUMBER 005  «Sequence 0 is not defined in order 700000080, check entry»
 *
 * Quel messaggio e' la differenza fra «SAP ha detto no» e «SAP ha detto no PERCHE' la sequenza non
 * esiste», e stava a un passo da noi. Da qui la ricerca dei messaggi nella risposta, con lo stesso
 * metodo dei righi di conferma — PER FORMA e non per nome, perche' come si chiami il parametro in
 * uscita dall'iFlow non ci e' stato dichiarato: se un domani l'iFlow lo rimanda, lo troviamo senza
 * bisogno di un'altra specifica. E se non lo rimanda, e' cio' che va chiesto al team Integration.
 */
const MSG_NAMES = new Set(['TYPE', 'ID', 'NUMBER', 'MESSAGE', 'LOG_NO', 'LOG_MSG_NO',
  'MESSAGE_V1', 'MESSAGE_V2', 'MESSAGE_V3', 'MESSAGE_V4', 'PARAMETER', 'ROW', 'FIELD', 'SYSTEM']);

/**
 * Legge un campo dalla riga SENZA badare al maiuscolo, e restituisce sempre una stringa ripulita.
 *
 * Serve perche' le due forme rispondono con nomi diversi: la busta della FM li rende in ABAP
 * maiuscolo (`CONFIRMATIONGROUP`), un'entity OData con la proprieta' EDMX (`ConfirmationGroup`).
 * Cercare solo il primo avrebbe dichiarato «nessuna chiave» su una conferma regolarmente
 * registrata — cioe' l'errore piu' costoso che questo modulo possa fare.
 */
function field(row, abapName) {
  if (!row || typeof row !== 'object') return '';
  const k = Object.keys(row).find((x) => x.toUpperCase() === abapName);
  return k === undefined ? '' : String(row[k] ?? '').trim();
}

/** Somiglia a una riga di conferma? Basta che tre dei suoi campi appartengano all'entity. */
function looksLikeRow(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.keys(v).filter((k) => ROW_NAMES.has(k.toUpperCase())).length >= 3;
}

/**
 * [CONF-OUTCOME] Somiglia all'ESITO BREVE, cioe' alla risposta dichiarata il 02/09/2026?
 * FUNZIONE PURA.
 *
 * Non si abbassa la soglia di `looksLikeRow` da tre a due: con due campi qualunque, un oggetto che
 * per caso ha un `PLANT` e un `SEQUENCE` diventerebbe una riga di conferma. Si riconosce invece una
 * forma PRECISA — i campi noti dell'entity sono TUTTI dentro `{ORDERID, CONFIRMATIONTEXT}`, almeno
 * uno valorizzato — e la si tiene distinta, perche' su questa forma la regola d'esito e' un'altra.
 *
 * L'esclusione dei campi da messaggio non e' una cautela di troppo: un BAPIRET2 ha `MESSAGE`, e
 * `MESSAGE` non e' `CONFIRMATIONTEXT` ma il primo scambio per il secondo trasformerebbe il motivo
 * di un rifiuto nella prova che la conferma e' passata.
 */
function looksLikeShortRow(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v).map((k) => k.toUpperCase());
  if (keys.some((k) => MSG_NAMES.has(k))) return false;
  const noti = keys.filter((k) => ROW_NAMES.has(k));
  if (!noti.length || noti.some((k) => !SHORT_NAMES.has(k))) return false;
  return !!(field(v, KEY_ORDER) || field(v, KEY_CONF_TEXT));
}

/**
 * Trova la tabella delle conferme nella risposta. FUNZIONE PURA.
 *
 * CERCA PER FORMA, NON PER NOME: il nome del parametro di uscita non ci e' stato dichiarato, e
 * indovinarlo significherebbe non trovare nulla e dire «risposta vuota» quando invece la risposta
 * c'e'. Si riconosce un array di oggetti che somigliano a righe di conferma, ovunque stia, e si
 * DICHIARA dove lo si e' trovato: e' cosi' che la prima chiamata reale ci dice il nome vero.
 *
 * Le forme tollerate, tutte quelle in cui una tabella ABAP puo' arrivare in JSON:
 *   [ {...} ]                      array nudo, in cima
 *   { X: [ {...} ] }               array sotto una chiave qualunque
 *   { X: { item: [ {...} ] } }     resa ABAP->JSON, come IT_ITEM del movimento merci
 *   { X: { results: [ {...} ] } }  convenzione JSON di OData V2
 *   { ...riga... }                 una riga sola, senza involucro
 *
 * [CONF-OUTCOME] SI CERCA PRIMA L'ECO COMPLETA E POI L'ESITO BREVE: un'eco completa contiene anche
 * i due campi dell'esito breve, e cercando prima la forma breve la si troverebbe dentro l'altra.
 * Dal 25/09/2026 la regola d'esito e' una sola (`ORDERID`, vedi `readOutcome`), quindi l'ordine non
 * decide piu' l'esito: decide cosa dice la `shape` che il log conserva.
 *
 * @returns {{rows: object[], shape: string, short: boolean}} `shape` vuota se non si e' trovato nulla
 */
function findRows(body) {
  if (!body || typeof body !== 'object') return { rows: [], shape: '', short: false };

  const search = (recognize, suffix) => {
    const asRows = (v, path) => {
      if (Array.isArray(v)) {
        const rows = v.filter(recognize);
        return rows.length ? { rows, shape: `${path}${suffix}` } : null;
      }
      if (v && typeof v === 'object') {
        for (const wrapper of ['item', 'results']) {
          if (v[wrapper] !== undefined) {
            const r = asRows([].concat(v[wrapper]), `${path}.${wrapper}`);
            if (r) return r;
          }
        }
        if (recognize(v)) {
          return { rows: [v], shape: `${path} (riga singola, senza tabella)${suffix}` };
        }
      }
      return null;
    };

    const top = asRows(body, '(risposta)');
    if (top) return top;
    for (const [k, v] of Object.entries(body)) {
      const r = asRows(v, k);
      if (r) return r;
    }
    return null;
  };

  const full = search(looksLikeRow, '');
  if (full) return { ...full, short: false };
  const short = search(looksLikeShortRow, ` (esito breve: ${KEY_ORDER} + ${KEY_CONF_TEXT})`);
  if (short) return { ...short, short: true };
  return { rows: [], shape: '', short: false };
}

/**
 * Interpreta la risposta della FM. FUNZIONE PURA.
 *
 * [CONF-OUTCOME] DUE ESITI, E LI DECIDE `ORDERID` (decisione del 25/09/2026):
 *
 *   `ORDERID` uguale a quello mandato      registrata
 *   qualunque altra cosa                   FALLITA, e si ritenta alla run successiva: `ORDERID`
 *                                          vuoto o assente, nessuna riga riconosciuta, corpo
 *                                          vuoto o non JSON
 *
 * Non ci sono altri rami, e non e' una semplificazione: e' il contratto dell'iFlow, che valorizza
 * `ORDERID` SOLO quando la conferma e' registrata. Un `ORDERID` di un altro ordine non puo'
 * arrivare, quindi non ha un ramo suo e cade nel fallito.
 *
 * LE CHIAVI NON DECIDONO. Fino al 25/09 sull'eco completa decidevano `ConfirmationGroup` /
 * `ConfirmationCount`, su una premessa mai misurata («la' `ORDERID` torna anche su un rifiuto»). Le
 * chiavi invece tornano A ZERO su ogni risposta — il valore iniziale del NUMC — e il 25/09/2026 una
 * conferma respinta, con `ORDERID` vuoto, e' stata archiviata «registrata» perche' '0000000000'
 * passava per una chiave. Restano un DATO da scrivere, zeri compresi.
 *
 * IL CONFRONTO e' tollerante sugli zeri iniziali (`sameOrderKey`): mandiamo `000700000080` e su
 * questo canale i valori possono tornare senza riempimento, e un confronto secco dichiarerebbe
 * fallita una conferma PASSATA, cioe' la farebbe confermare due volte. Senza `expectedOrder` non si
 * puo' dire «uguale», quindi l'esito e' fallito: i due chiamanti di `postOrderConfirmation` lo passano.
 *
 * @param {*} body il corpo della risposta, in qualunque forma sia arrivato
 * @param {string} expectedOrder l'ordine su cui si e' scritto
 * @returns {{ok:boolean, posted:boolean, outcomeRule:string, confirmationGroup:string,
 *             confirmationCount:string, orderIdReturned:string, confirmationText:string,
 *             declaredRejected:boolean, rowCount:number, rowsWithKeys:number,
 *             responseShape:string, reason:string}}
 */
function readOutcome(body, expectedOrder) {
  const { rows, shape } = findRows(body);
  const keyed = rows.filter((r) => isAssignedKey(field(r, KEY_GROUP)));
  const withOrder = rows.find((r) => field(r, KEY_ORDER) !== '');
  // Le colonne portano cio' che SAP ha mandato, zeri compresi (addendum del 09/09 a DEC-119).
  const first = keyed[0] || rows[0] || {};
  const sent = String(expectedOrder || '').trim();

  const out = {
    ok: false,
    // `posted` e `ok` dicono la stessa cosa e restano due nomi: `ok` e' quello che i chiamanti e i
    // test usano da sempre, `posted` quello che si legge nella riga di esito.
    posted: false,
    // Una regola sola dal 25/09/2026. Il campo resta perche' le righe storiche dicono anche `keys`.
    outcomeRule: 'orderid',
    confirmationGroup: field(first, KEY_GROUP),
    confirmationCount: field(first, KEY_COUNT),
    orderIdReturned: field(withOrder || {}, KEY_ORDER),
    confirmationText: field(withOrder || rows[0] || {}, KEY_CONF_TEXT),
    declaredRejected: false,
    rowCount: rows.length,
    rowsWithKeys: keyed.length,
    responseShape: shape,
    reason: ''
  };

  if (sent && out.orderIdReturned && sameOrderKey(out.orderIdReturned, sent)) {
    out.ok = true;
    out.posted = true;
    out.reason = `registrata sull'ordine ${out.orderIdReturned}`
      + (out.confirmationText ? ` — ${out.confirmationText}` : '');
    return out;
  }

  // Tutto il resto e' FALLITO e si ritenta: `declaredRejected` e' il segnale che
  // `classifyConfirmation` e il ramo d'invio del job leggono.
  out.declaredRejected = true;
  if (!rows.length) {
    out.reason = `nessuna riga di conferma riconosciuta nella risposta, quindi nessun ${KEY_ORDER}: `
      + 'SAP NON ha registrato la conferma. Il corpo completo è nel log.';
  } else if (!out.orderIdReturned) {
    out.reason = `${KEY_ORDER} non è tornato: SAP NON ha registrato la conferma`
      + (out.confirmationText
        ? `. Motivo: ${out.confirmationText}`
        : ', e non è tornato nemmeno un testo che dica perché.');
  } else {
    out.reason = `${KEY_ORDER} tornato ${out.orderIdReturned} ma mandato ${sent || '(nessuno)'}: `
      + 'non è la conferma che abbiamo inviato, quindi non la diamo per registrata.';
  }
  return out;
}

/** Una chiave a soli zeri e' il valore iniziale di un NUMC: SAP non l'ha assegnata. */
function isZeroKey(v) {
  return /^0+$/.test(v);
}

/** Una chiave che SAP ha davvero assegnato: ne' vuota ne' a zeri. */
function isAssignedKey(v) {
  return v !== '' && !isZeroKey(v);
}

// ---------------------------------------------------------------------------------------------

/**
 * Config del TRASPORTO: DEFAULTS <- cds.requires.<BASE>.post <- override da env.
 *
 * `enabled` STA FUORI, E NON BASTA SMETTERE DI LEGGERE LA VARIABILE D'AMBIENTE. E' la stessa mossa
 * che la 0046 ha fatto su `readTransportConfig` in srv/lib/prodOrderStatusPost.js, e la ragione e'
 * identica: `DEFAULTS` portava `enabled: true`, quindi un campo con quel nome resterebbe nella
 * config e il primo che lo trova lo userebbe come se fosse la leva. La config si stratifica anche
 * da `cds.requires.<BASE>.post`, che il repo non controlla riga per riga: per questo il campo si
 * CANCELLA in coda, e non si limita a non essere scritto.
 *
 * `PRODCONF_POST` non esiste piu' come leva. La 0030 l'aveva promossa da interruttore della sonda a
 * terzo cancello del flusso vero (DEC-94), sopra la casella per plant; ma quella leva stava a `off`
 * in produzione e si apriva solo con un RILASCIO, quindi la scheda «Consuntivazione» poteva
 * dichiarare «invia le conferme a SAP» e il job non mandarne nessuna. Un flusso schedulato che parte
 * deve scrivere. L'interruttore e' ora UNO SOLO, ed e' `ZProdConfPostingConfig.ConfPostEnabled` —
 * fail-closed per default, e piu' rapido di un rilascio.
 *
 * Cio' che resta configurabile da env descrive l'ENDPOINT, non il comportamento: path, entity set,
 * CSRF e forma del corpo sono i tre assi lungo cui si trova la forma giusta senza un ciclo di deploy
 * per tentativo, e il loro default e' il contratto pubblicato.
 */
function readTransportConfig() {
  const fromCds = (cds.env.requires && cds.env.requires[BASE] && cds.env.requires[BASE].post) || {};
  const cfg = { ...DEFAULTS, ...fromCds };
  const isOff = (v) => ['off', 'false', '0', 'no'].includes(String(v).trim().toLowerCase());
  const set = (name) => process.env[name] !== undefined && String(process.env[name]).trim() !== '';

  if (set('PRODCONF_POST_CSRF')) cfg.csrf = !isOff(process.env.PRODCONF_POST_CSRF);
  if (set('PRODCONF_POST_PATH')) cfg.path = String(process.env.PRODCONF_POST_PATH).trim();
  // `off` = ometti i campi vuoti. E' la controprova, se un domani l'endpoint li rifiutasse.
  if (set('PRODCONF_POST_EMPTY')) cfg.keepEmpty = !isOff(process.env.PRODCONF_POST_EMPTY);
  if (set('PRODCONF_POST_BOOL')) {
    const b = String(process.env.PRODCONF_POST_BOOL).trim().toLowerCase();
    if (b === 'edm' || b === 'abap') cfg.booleans = b;
    else console.warn(`>>> [PRODCONF-POST] PRODCONF_POST_BOOL='${b}' non riconosciuta `
      + `(valori ammessi: edm, abap): resta '${cfg.booleans}'`);
  }
  // Solo i due valori previsti: un refuso non deve tradursi silenziosamente nella forma sbagliata,
  // che e' precisamente il genere di errore che costa un giro di collaudo per capirlo.
  if (set('PRODCONF_POST_SHAPE')) {
    const s = String(process.env.PRODCONF_POST_SHAPE).trim().toLowerCase();
    if (s === 'fm' || s === 'entity') cfg.shape = s;
    else console.warn(`>>> [PRODCONF-POST] PRODCONF_POST_SHAPE='${s}' non riconosciuta `
      + `(valori ammessi: entity, fm): resta '${cfg.shape}'`);
  }
  // Non si usa `set()`: la stringa VUOTA e' un valore legittimo e significa «POST sul service root»,
  // che e' esattamente la controprova da fare se l'endpoint non fosse un sender OData.
  if (process.env.PRODCONF_POST_ENTITYSET !== undefined) {
    cfg.entitySet = String(process.env.PRODCONF_POST_ENTITYSET).trim();
  }
  // [IS-EGRESS] Come esce questa POST da questo processo: dentro un job la destination e' quella con
  // utenza tecnica; dal server web resta quella configurata. Si risolve QUI e non in `connect()`
  // perche' le righe di log e i riepiloghi stampano `cfg.destination`: cosi' dicono da se' su quale
  // canale la chiamata e' uscita. La riga qui sotto e' sorvegliata da test/isEgress.test.js.
  const eg = resolveEgress(process.env, { destination: cfg.destination });
  cfg.destination = eg.destination;
  cfg.egressWhy = eg.why;

  // `enabled` SI CANCELLA: vedi la testata di questa funzione. Sta in coda perche' deve valere
  // qualunque cosa abbiano messo `DEFAULTS` e `cds.requires` — chi cercasse una leva qui non deve
  // trovare un campo da leggere, e test/confPostLeverSurface.test.js verifica che non ci sia.
  delete cfg.enabled;
  return cfg;
}

/** JSON leggibile senza mai lanciare, qualunque cosa sia arrivata dal remoto. */
function safeStringify(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Header mascherati e gia' serializzati: escono verso il browser, quindi `authorization` e i
 * cookie di sessione non devono passare di li'.
 *
 * `reveal` esiste per UN caso: `x-csrf-token` IN RISPOSTA. Quando il runtime rifiuta per CSRF,
 * quel campo vale letteralmente `Required` — e' la diagnosi, non un segreto, e mascherarlo
 * nascondeva l'unica prova conclusiva. In RICHIESTA resta mascherato: li' e' un token di sessione vero.
 */
function maskHeaders(h, { reveal = [] } = {}) {
  if (!h || typeof h !== 'object') return '';
  const keep = new Set(reveal.map((k) => k.toLowerCase()));
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const secret = /authorization|apikey|api-key|cookie|token/i.test(k) && !keep.has(k.toLowerCase());
    out[k] = secret ? '***MASKED***' : v;
  }
  return safeStringify(out);
}

/**
 * Istanza memoizzata sull'endpoint. Stesso schema con cui isRemoteSource.js:206 istanzia i 15
 * service root dell'Integration Suite a partire dallo stesso CSN: si ottiene un'istanza puntata su
 * QUESTO indirizzo senza sostituire quella registrata sul nome del servizio.
 *
 * `csrf` viaggia FRA LE OPZIONI e non dentro `credentials`: CAP lo legge da `service.options`
 * (remote/Service.js:221) e `cds.connect.to` fa un merge superficiale `{...conf, ...opts}`
 * (lib/srv/cds-connect.js:61), quindi questa leva scavalca package.json. Il valore e' letto una
 * volta sola: cambiarlo richiede un restart.
 *
 * ATTENZIONE. `BASE` e' il servizio con cui il job PROD_CONF scrive le conferme VERE, ed e' ora
 * l'UNICO chiamante: il server web non si connette a questo servizio da nessuna parte, da quando la
 * sonda del cockpit e' stata rimossa. Il giorno in cui il cockpit avesse un'azione «invia conferma»,
 * questa istanza va rivista PRIMA di scriverla — e' memoizzata in un processo che serve richieste di
 * utenti diversi: `grep -rn API_PROD_ORDER_CONFIRMATION_2_SRV srv/`.
 */
let pending = null;
function connect(cfg) {
  if (!pending) {
    // [IS-EGRESS] Nessun gancio `before('*')` su questa istanza: fino al 28/08/2026 ce n'era uno che
    // fondeva l'header applicativo, ora rimosso da ogni canale. Il canale su cui la chiamata esce e'
    // la `destination`, gia' risolta dentro `cfg` — un posto solo.
    pending = cds.connect.to(BASE, {
      csrf: cfg.csrf,
      credentials: {
        destination: cfg.destination,
        path: cfg.path,
        requestTimeout: cfg.requestTimeout
      }
    }).catch((e) => { pending = null; throw e; });
  }
  return pending;
}

// =============================================================================================
// [CONF-POSTING] L'INVIO DI ESERCIZIO (feature 0030)
//
// La chiamata che il job PROD_CONF fa quando il plant ha `ProdPosting='CONF'`. Dal giorno in cui la
// sonda e' uscita e' l'UNICO chiamante di questo modulo, e la configurazione che legge descrive solo
// l'ENDPOINT: destination, path, entity set, csrf, timeout, forma del corpo. Non esiste piu' una
// configurazione «della prova» — ordine di collaudo, varianti, valori trascritti da CO11N — e non
// esiste piu' una leva che decida SE spedire.
//
// UNA CHIAMATA PER RUN. Su questo endpoint la ripetizione di una conferma PASSATA e' quantita'
// confermata in piu', e l'unico annullamento e' uno storno in CO13. Per questo l'esito e' «`ORDERID`
// uguale a quello mandato» e nient'altro: quando c'e' la riga e' chiusa, quando manca l'iFlow non ha
// registrato e la riga riparte alla run successiva (decisione del 25/09/2026).
// =============================================================================================

/**
 * Registra UNA conferma d'ordine. Non lancia: l'esito e' l'oggetto restituito.
 *
 * LA FORMA DEL RISULTATO E' QUELLA DI `postMaterialDoc`, e non per simmetria estetica: il ramo
 * d'invio del job legge `outcome`, `httpStatus`, `message*`, `mplId`, `reason`, `error` e `testRun`
 * dalle due funzioni allo stesso modo. Cambia solo l'esito positivo — non un numero documento ma le
 * DUE CHIAVI della conferma (`confirmationGroup`, `confirmationCount`).
 *
 * `testRun` E' SEMPRE VUOTO, ed e' una differenza sostanziale da dichiarare, non un campo riempito
 * per compatibilita': l'iFlow della conferma non espone `IV_TEST_RUN` e il BAPI non ha una modalita'
 * di validazione. Una conferma parte davvero o non parte: l'unico annullamento e' uno storno in
 * CO13. Per questo l'autorizzazione a scrivere e' un interruttore suo (`ConfPostEnabled`) e non il
 * flag di prova dei movimenti merci.
 *
 * @param {object} data `{ confirmation: {…} }`, come `confMatDoc.confirmationFor` lo costruisce
 * @param {object} [opts] `label` per il log, `correlationId` da citare al team Integration
 * @returns {Promise<object>} l'esito, mai un'eccezione
 */
async function postOrderConfirmation(data, opts = {}) {
  if (!data || !data.confirmation || typeof data.confirmation !== 'object') {
    throw new TypeError('postOrderConfirmation: `data.confirmation` è obbligatorio. I valori li '
      + 'costruisce srv/lib/confMatDoc.js (confirmationFor); questa funzione non ha dati propri.');
  }
  const cfg = readTransportConfig();
  const day = new Date();
  const values = data.confirmation;
  // L'ordine e' quello del chiamante, e la config non ne porta piu' nessuno: `cfg.orderId` era
  // l'ordine di collaudo della sonda ed e' uscito con lei. Fino a quel giorno prenderlo da la'
  // sarebbe stato confermare l'ordine sbagliato senza nessun errore.
  const orderId = String(values.OrderID || '').trim();
  const payload = buildPayload(values, day, orderId, cfg.shape, cfg.keepEmpty, cfg.booleans);

  const r = {
    // `outcome` NASCE 'KO' E NON PIU' 'OFF'. 'OFF' significa «la chiamata non e' partita perche' una
    // leva la teneva spenta», e quella leva non esiste piu': il ramo d'invio del job, leggendo 'OFF',
    // rilascerebbe la riga senza consumare un tentativo e senza dichiarare niente. Con 'KO' un
    // ritorno che dimenticasse di scrivere l'esito si legge come «non registrata», che e'
    // ritentabile e visibile — il verso giusto in cui sbagliare su un flusso contabile.
    outcome: 'KO',                        // OK | KO
    label: String(opts.label || 'PROD_CONF'),
    // La conferma non ha una modalita' di prova: vedi il docblock.
    testRun: '',
    testRunSource: 'la conferma d\'ordine non ha una modalità di prova (nessun IV_TEST_RUN)',
    orderId,
    warn: false,
    csrf: !!cfg.csrf,
    csrfTokenObtained: false,
    destination: cfg.destination,
    // [IS-EGRESS] Perche' quella destination e non l'altra: in un flusso con effetti contabili
    // «l'ha chiamata il job» e «l'ha chiamata una sonda del cockpit» non si leggono dal nome.
    egressWhy: cfg.egressWhy || '',
    path: cfg.path,
    url: cfg.path + (cfg.entitySet ? `/${cfg.entitySet}` : ''),
    shape: cfg.shape,
    correlationId: opts.correlationId || (cds.context && cds.context.id) || '',
    requestBody: JSON.stringify(payload, null, 2),
    requestHeaders: '',
    httpStatus: null,
    responseHeaders: '',
    responseBody: '',
    // L'esito positivo di una conferma: le due chiavi che SAP assegna, quando la risposta le porta.
    confirmationGroup: '',
    confirmationCount: '',
    // [CONF-OUTCOME] L'esito: l'ordine restituito (c'e' solo se la conferma e' registrata) e il
    // testo (su un rifiuto porta il motivo). `outcomeRule` vale `orderid`; `keys` resta sulle righe
    // storiche, quando sull'eco completa decidevano le chiavi.
    orderIdReturned: '',
    confirmationText: '',
    outcomeRule: '',
    declaredRejected: false,
    rowCount: 0,
    rowsWithKeys: 0,
    responseShape: '',
    messageType: '',
    messageId: '',
    messageNumber: '',
    message: '',
    // `inconclusive` resta per la forma comune con `postMaterialDoc`, ma sulla conferma e' sempre
    // falso: su una risposta arrivata l'esito e' sempre deciso da `ORDERID` (25/09/2026).
    inconclusive: false,
    mplId: '',
    reason: '',
    error: '',
    ms: 0,
    sentAt: day.toISOString()
  };

  if (!orderId) {
    // Non e' un guasto di trasporto: e' un payload che non si deve spedire. Una conferma senza
    // ordine, se l'iFlow la accettasse, andrebbe a finire su un ordine deciso da qualcun altro.
    r.outcome = 'KO';
    r.reason = 'conferma senza OrderID: non spedita';
    return r;
  }

  // QUI C'ERA LA SECONDA LETTURA DELLA LEVA, ed e' l'uscita anticipata che questa funzione ha perso
  // — esattamente come `postOrderStatus` con la 0046 (DEC-118 §5). Era la meta' che si dimentica:
  // togliere il cancello nel job non bastava, perche' l'invio rileggeva `PRODCONF_POST` da se' e
  // usciva con `outcome: 'OFF'` senza spedire. Da qui in giu' non c'e' nessun ramo che decide SE
  // scrivere: quella decisione e' del chiamante, e per il job e' la casella del plant.

  const t0 = Date.now();
  try {
    const srv = await connect(cfg);
    // L'header applicativo [IS-EGRESS] non si aggiunge qui: lo mette il gancio registrato in
    // connect() — e solo se il processo e' un run batch — e questi si fondono con quello.
    const headers = r.correlationId
      ? { 'x-correlation-id': r.correlationId, 'x-correlationid': r.correlationId }
      : {};
    const res = await srv.send({
      method: 'POST',
      path: cfg.entitySet ? `/${cfg.entitySet}` : '/',
      data: payload,
      headers
    });
    r.csrfTokenObtained = r.csrf;
    r.responseBody = safeStringify(res);
    // [CONF-OUTCOME] L'ordine si PASSA: l'esito e' «`ORDERID` uguale a quello mandato», e senza
    // l'ordine mandato non c'e' niente con cui confrontarlo. Qualunque altra risposta — compresa
    // quella senza righe riconoscibili — e' FALLITA e si ritenta alla run successiva: non esiste
    // piu' un «non lo so» su una risposta arrivata (decisione del 25/09/2026).
    const o = readOutcome(res, orderId);
    applyOutcome(r, o);
    readConfMessagesInto(r, res);
  } catch (e) {
    r.outcome = 'KO';
    // e.statusCode e' 502 per QUALUNQUE fallimento: lo normalizza CAP. Quello vero e' annidato
    // nella causa, ed e' li' che sta anche l'intero scambio.
    r.httpStatus = upstreamStatus(e) || null;
    r.error = errorText(e).slice(0, 2000);
    const reason = (e && e.reason) || {};
    if (reason.request) {
      if (reason.request.url) r.url = reason.request.url;
      const sent = reason.request.headers || {};
      r.csrfTokenObtained = Object.keys(sent).some((k) => k.toLowerCase() === 'x-csrf-token');
      r.requestHeaders = maskHeaders(sent);
    }
    if (reason.response) {
      r.responseHeaders = maskHeaders(reason.response.headers, { reveal: ['x-csrf-token'] });
      r.responseBody = safeStringify(reason.response.body);
      r.mplId = extractMplId(reason.response.body);
      // Anche su un errore HTTP l'iFlow puo' aver rimandato l'esito: se dichiara la registrazione,
      // la conferma E' passata — e dichiararla fallita la farebbe ritentare, cioe' duplicare.
      const o = readOutcome(reason.response.body, orderId);
      if (o.rowCount) {
        // Il motivo dice anche CHE LA RISPOSTA HTTP NON ERA RIUSCITA: l'esito applicativo e il
        // guasto di trasporto sono due fatti, e chi legge la riga deve vederli entrambi. Il testo
        // integrale dell'errore resta in `r.error`.
        applyOutcome(r, o);
        if (o.ok) {
          r.outcome = 'OK';
          r.reason = `${o.reason || 'registrata'} (registrazione dichiarata in una risposta HTTP `
            + `${r.httpStatus || 'non riuscita'})`;
        } else if (o.reason) {
          r.reason = `${o.reason} (in una risposta HTTP ${r.httpStatus || 'non riuscita'})`;
        }
      }
      readConfMessagesInto(r, reason.response.body);
    }
  }
  r.ms = Date.now() - t0;
  logConfirmation(r);
  return r;
}

/**
 * [CONF-OUTCOME] Riversa l'esito letto sulla riga del risultato dell'invio di esercizio.
 *
 * Esiste per un motivo solo: i campi dell'esito sono ORA UNDICI, e copiarli a mano in due punti —
 * la risposta riuscita e il ramo dell'errore HTTP — e' il modo in cui uno dei due si dimentica di
 * copiarne uno. Un campo dimenticato qui non da' nessun errore: da' una riga di storico che non
 * dice quale regola ha deciso, oppure un rifiuto senza il suo motivo.
 *
 * Il motivo del rifiuto va in `message` perche' e' il campo che il ramo d'invio del job scrive in
 * `MessageText` e porta nel recap — ed e' testo di SAP, quindi si mostra e non si traduce. Se un
 * giorno `LT_DETAIL` arrivasse davvero, `readConfMessagesInto` gira DOPO e vince: un BAPIRET2 con
 * tipo, id e numero dice di piu' di una frase sola.
 */
function applyOutcome(r, o) {
  Object.assign(r, {
    confirmationGroup: o.confirmationGroup,
    confirmationCount: o.confirmationCount,
    orderIdReturned: o.orderIdReturned,
    confirmationText: o.confirmationText,
    outcomeRule: o.outcomeRule,
    declaredRejected: o.declaredRejected,
    rowCount: o.rowCount,
    rowsWithKeys: o.rowsWithKeys,
    responseShape: o.responseShape,
    outcome: o.ok ? 'OK' : 'KO',
    reason: o.reason
  });
  if (o.declaredRejected && o.confirmationText) r.message = o.confirmationText.slice(0, 600);
}

/**
 * Il messaggio applicativo della risposta, nei campi che il job legge: `message`, che e' quello che
 * il ramo d'invio usa sia sulla conferma sia sul movimento merci. (Il gemello della sonda scriveva
 * `messageText` ed e' uscito con lei: `findMessages` e `pickMessage`, che sono puri, restano.)
 */
function readConfMessagesInto(r, body) {
  const { messages, shape } = findMessages(body);
  if (!messages.length) return;
  const m = pickMessage(messages);
  Object.assign(r, {
    messageType: m.type,
    messageId: m.id,
    messageNumber: m.number,
    message: m.text.slice(0, 600),
    messageCount: messages.length,
    messageShape: shape
  });
}

/**
 * Come si classifica una conferma NON riuscita. FUNZIONE PURA.
 *
 * [CONF-OUTCOME] SU UNA CONFERMA OGNI FALLIMENTO SI RITENTA (decisione del 25/09/2026). Gli esiti
 * sono due: `ORDERID` uguale a quello mandato e' registrata, e il chiamante non arriva qui; tutto il
 * resto e' fallito, la riga va in `E` e riparte alla run successiva. A fermarla resta solo il tetto
 * di tentativi del plant (`MaxRetryAttempts`), che il ramo d'invio del job applica da se'.
 *
 * Non vale piu' il «nel dubbio non si ritenta» di DEC-60: sulla conferma non c'e' un dubbio da una
 * risposta arrivata, perche' l'iFlow valorizza `ORDERID` SOLO quando ha registrato. Resta fuori da
 * qui la prenotazione orfana (processo morto a meta' chiamata), dove una risposta non e' mai arrivata.
 *
 * NON SI RIUSA `confMatDoc.classifyFailure`: la' la permanenza dipende dai messaggi definitivi del
 * plant, qui no. Cambia solo il MOTIVO, perche' e' cio' che finisce nella riga e nel recap.
 *
 * @param {object} r l'esito di `postOrderConfirmation`
 * @returns {{permanent: boolean, failureClass: string, reason: string}} la stessa forma di
 *   `confMatDoc.classifyFailure`, cosi' il ramo d'invio del job non ha due strade
 */
function classifyConfirmation(r) {
  const o = r || {};
  const type = String(o.messageType || '').trim().toUpperCase();
  const id = String(o.messageId || '').trim().toUpperCase();
  const number = String(o.messageNumber || '').trim();
  const rejected = ['E', 'A', 'X'].includes(type);
  const retry = (reason) => ({ permanent: false, failureClass: 'T', reason });

  if (o.error && !o.rowCount && !rejected) {
    return retry(o.httpStatus
      ? `nessuna risposta applicativa (HTTP ${o.httpStatus}): la conferma non è arrivata a ECC, si ritenta`
      : 'guasto di trasporto: la conferma non è partita, si ritenta');
  }

  if (rejected) {
    return retry(`rifiuto del BAPI ${id || '(id ignoto)'} ${number || ''}`.trim()
      + ': la conferma non è stata registrata, si ritenta alla run successiva');
  }

  return retry('l\'ordine mandato non è tornato nella risposta: SAP NON ha registrato la conferma'
    + (o.confirmationText ? ` (${o.confirmationText})` : '')
    + '. Si ritenta alla run successiva');
}

/** Lo scambio sul log del server: e' cio' che si cita al team Integration insieme all'MPL ID. */
function logConfirmation(r) {
  const T = '>>> [CONF-POSTING]';
  const esito = r.outcome === 'OK'
    ? `REGISTRATA ${confLabel(r, r.orderId)}`
    : `NON registrata (${r.reason || r.error || 'motivo ignoto'})`;
  console.log(`${T} conferma ordine ${r.orderId} | ${r.label} | ${esito} | ${r.ms} ms`
    + `${r.mplId ? ` | MPL ${r.mplId}` : ''}`);
  if (r.outcome !== 'OK') {
    console.log(`${T} POST ${r.url} (forma ${r.shape}) | x-correlation-id: ${r.correlationId || '(assente)'}`);
    // [IS-EGRESS] Da dove e' uscita e perche' da li': nel monitor di CPI gli MPL si somigliano
    // tutti, e il canale e' l'unica cosa che distingue un run batch da una chiamata del server web.
    console.log(`${T} destination       : ${r.destination}${r.egressWhy ? ` [${r.egressWhy}]` : ''}`);
    console.log(`${T} body inviato:\n${r.requestBody}`);
    console.log(`${T} risposta HTTP ${r.httpStatus === null ? '(2xx)' : r.httpStatus}:\n${r.responseBody}`);
    if (r.message) {
      // [CONF-OUTCOME] I tre codici ci sono solo se il messaggio viene da un BAPIRET2: dal
      // contratto del 02/09/2026 il motivo arriva spesso come testo solo, e stamparne il prefisso
      // vuoto darebbe «messaggio:    — …», cioe' tre codici che sembrano persi.
      const codici = [r.messageType, r.messageId, r.messageNumber].filter(Boolean).join(' ');
      console.log(`${T} messaggio: ${codici ? `${codici} — ` : ''}${r.message}`);
    }
  }
}

module.exports = {
  // [CONF-POSTING] l'invio di esercizio (feature 0030), e non c'e' piu' nient'altro: la batteria
  // della sonda e' stata rimossa insieme alla leva che la spegneva.
  postOrderConfirmation,
  classifyConfirmation,
  // parti pure, per test/prodOrderConfPost.test.js
  buildPayload,
  buildFmPayload,
  buildEntityPayload,
  wrapEnvelope,
  looksLikeMessage,
  findMessages,
  pickMessage,
  // [CONF-OUTCOME] le parti pure della lettura dell'esito
  looksLikeShortRow,
  confLabel,
  readOutcome,
  findRows,
  field,
  readTransportConfig,
  FIELDS,
  REQUEST_FIELDS,
  DEFAULTS,
  BASE
};

# ECC — come ottenere i campi di `A_ProductionOrder_2` che il BAPI non dà

Su ECC il servizio `API_PRODUCTION_ORDER_2_SRV` **non esiste**: `A_ProductionOrder_2` è una entity
S/4 (view CDS su AUFK/AFKO/AFPO). Questo documento copre i **51 campi su 78** che non si ottengono
dalla struttura `BAPI_ORDER_HEADER1` di `BAPI_PRODORD_GET_LIST`: da dove si prendono su ECC e come.

I **27 campi già allineati** via BAPI non sono ridocumentati qui → sezione A di
[BAPI_PRODORD_vs_A_ProductionOrder_2.md](./BAPI_PRODORD_vs_A_ProductionOrder_2.md).

> **C'è una BAPI che li dà?** No, nessuna da sola.
> `BAPI_PRODORD_GET_DETAIL` riempie `BAPI_ORDER_HEADER1` molto più di `GET_LIST` — è la risposta se
> serve solo completare **quella** struttura — ma resta ai suoi 50 campi: i 20 flag di stato, i dati
> organizzativi, le varianti di calcolo e il testo lungo non passano da lì. Per la parità con
> l'entity OData serve una **SELECT su AUFK/AFKO/AFPO + JEST** dentro un FM RFC `ZMARS_*`.

> **Confidenza**: `✓` = assegnazione standard e stabile su ECC; `?` = **da confermare in SE11/SE16**
> prima di scrivere ABAP (dedotta da label, dominio o convenzione, non verificata sul sistema).
> Vedi [Procedura di verifica](#procedura-di-verifica-in-se11se16).

## Le tre strade

| Strada | Come | Quando |
|---|---|---|
| `BAPI_PRODORD_GET_DETAIL` in loop | 1 chiamata per ordine, `ORDER_OBJECTS` con tutti i flag a `'X'`; restituisce testata + POSITION / SEQUENCE / OPERATION / COMPONENT / PRT / TRIGGER_POINT | pochi ordini, zero effort ABAP; **non** raggiunge la parità 78 campi |
| **FM RFC `ZMARS_*` su SELECT** — *raccomandata* | join AUFK + AFKO + AFPO, una SELECT su JEST per i flag; firma già progettata in [Endpoint_OData_Integration-20260728 (1).md](<./Endpoint_OData_Integration-20260728 (1).md>) § `ZMARS_PROD_ORDER_GET` | estrazioni massive e parità piena: **una chiamata per N ordini** |
| `RFC_READ_TABLE` | lettura diretta di CAUFV/AFPO/JEST senza oggetti Z | ripiego. Limiti: nessun join, riga max 512 byte (campi troncati), gestione tipi a carico del chiamante |

Scorciatoia utile in ogni caso: la vista **`CAUFV`** è già il join AUFK + AFKO, quindi copre in un
colpo i gruppi 1 e 2 qui sotto.

## 1. Da AUFK (testata ordine) — 11 campi

Chiave: `AUFK-AUFNR`.

| Campo OData | ECC | Conf. | Note |
|---|---|:--:|---|
| `ManufacturingOrderCategory` | AUFK-AUTYP | ✓ | categoria ordine (`10` = ordine di produzione) |
| `ManufacturingObject` | AUFK-OBJNR | ✓ | **serve anche come chiave per JEST** (gruppo 4) |
| `CompanyCode` | AUFK-BUKRS | ✓ | |
| `BusinessArea` | AUFK-GSBER | ✓ | |
| `ProfitCenter` | AUFK-PRCTR | ✓ | |
| `FunctionalArea` | AUFK-FUNC_AREA | ? | su ECC coesistono `FUNC_AREA` e il più recente `FKBER`: verificare quale è alimentato |
| `ActualCostsCostingVariant` | AUFK-KLVARI | ? | variante di calcolo costi effettivi |
| `PlannedCostsCostingVariant` | AUFK-KLVARP | ? | variante di calcolo costi pianificati |
| `ResponsiblePlannerGroup` | AUFK (data element VAGRP) | ? | nome campo da confermare: in AUFK esistono più campi "gruppo/centro responsabile" |
| `MfgOrderCreationTime` | AUFK-ERFZEIT | ? | **possibile assenza su ECC**: se AUFK non ha l'ora di creazione, il campo resta vuoto (vedi §5) |
| `WBSElementExternalID` | AUFK-PSPEL → PRPS-POSID | ✓ | PSPEL è il **PSPNR interno** (NUMC8): conversione obbligatoria via `PRPS` o conversion exit ABPSP |

## 2. Da AFKO (testata PP) — 3 campi

Chiave: `AFKO-AUFNR`.

| Campo OData | ECC | Conf. | Note |
|---|---|:--:|---|
| `MfgOrderConfirmedYieldQty` | AFKO-IGMNG | ✓ | quantità buona confermata. ⚠️ **non** è `CONFIRMED_QUANTITY` del BAPI (quello è la quantità impegnata da ATP): vedi trappola 1 del doc di mapping |
| `BasicSchedulingType` | AFKO-TERKZ | ✓ | tipo di schedulazione |
| `ProductionUnit` | AFKO-GMEIN + `CONVERSION_EXIT_CUNIT_OUTPUT` | ✓ | `ProductionUnitSAPCode` (già allineato) è GMEIN grezzo; questo campo è la **rappresentazione esterna** — vedi trappola 3 del doc di mapping |

## 3. Da AFPO (posizione ordine) — 12 campi

Chiave: `AFPO-AUFNR` + `AFPO-POSNR`.

> ⚠️ **Nodo strutturale**: l'entity OData è a livello **ordine**, questi campi sono a livello
> **posizione**. Con ordini multi-posizione la regola di scelta (tipicamente `POSNR = '0001'`)
> va dichiarata nel contratto del FM, non lasciata implicita.

| Campo OData | ECC | Conf. | Note |
|---|---|:--:|---|
| `StorageLocation` | AFPO-LGORT | ✓ | |
| `GoodsRecipientName` | AFPO-WEMPF | ✓ | |
| `UnloadingPointName` | AFPO-ABLAD | ✓ | |
| `ProductionVersion` | AFPO-VERID | ✓ | |
| `PlannedOrder` | AFPO-PLNUM | ✓ | ordine pianificato di origine |
| `MaterialGoodsReceiptDuration` | AFPO-WEBAZ | ? | tempo di elaborazione entrata merci in giorni |
| `QuantityDistributionKey` | AFPO (data element VSNKZ) | ? | chiave di distribuzione MRP: confermare che sia sull'ordine e non solo su MARC |
| `InventoryUsabilityCode` | AFPO | ? | "inventory usability": campo da individuare (candidati fra gli indicatori di tipo/uso stock) |
| `MfgOrderSuperiorMfgOrder` | AFPO-MAUFNR | ? | ordine superiore in ordine collettivo |
| `MasterProductionOrder` | **AFPO-RSNUM** (deciso il 2026-08-10) | ✓ | il doc interno proponeva MAUFNR **anche** per questo campo, in conflitto con `MfgOrderSuperiorMfgOrder`. L'ambiguità è chiusa da una decisione: l'iFlow usa questo campo come **contenitore del numero di prenotazione** (RSNUM), che è la chiave con cui si leggono i componenti dell'ordine (contratto E-12/E-15, DEC-42). Il significato originale MAUFNR **non è più disponibile** su questo canale: se servisse, va chiesto un campo proprio |
| `MRPArea` | AFPO (data element BERID) | ? | presente solo se le **aree di pianificazione MRP** sono attive sul sistema |
| `CustomerName` | *non sull'ordine* → AFPO-KDAUF → VBAK-KUNNR → KNA1-NAME1 | ✓ | join aggiuntiva; su S/4 il campo arriva dalla stessa catena |

## 4. Da JEST + TJ02T (stato oggetto) — 20 flag

È il blocco più grosso del delta e **nessuna BAPI lo restituisce in questa forma**.

Meccanica: `AUFK-OBJNR` → `JEST` (`OBJNR`, `STAT`, `INACT`). Un flag OData vale `'X'` quando esiste
la riga con lo stato corrispondente e **`INACT = space`** (stato attivo); vale vuoto altrimenti.
Gli stati **di sistema** hanno `STAT` che inizia per `I` (gli `E*` sono stati utente: da escludere).
I testi stanno in `TJ02T` (`ISTAT`, `TXT04`, `TXT30`, per lingua).

| Campo OData | Stato (TXT04) | ISTAT | Conf. |
|---|---|---|:--:|
| `OrderIsCreated` | CRTD | I0001 | ✓ |
| `OrderIsReleased` | REL | I0002 | ✓ |
| `OrderIsConfirmed` | CNF | *da TJ02T* | ✓ |
| `OrderIsPartiallyConfirmed` | PCNF | *da TJ02T* | ✓ |
| `OrderIsDelivered` | DLV | *da TJ02T* | ✓ |
| `OrderIsPartiallyDelivered` | PDLV | *da TJ02T* | ✓ |
| `OrderIsTechnicallyCompleted` | TECO | *da TJ02T* | ✓ |
| `OrderIsClosed` | CLSD | *da TJ02T* | ✓ |
| `OrderIsLocked` | LKD | *da TJ02T* | ✓ |
| `OrderIsMarkedForDeletion` | DLFL | *da TJ02T* | ✓ |
| `OrderIsDeleted` | DLT | *da TJ02T* | ? |
| `OrderIsPrinted` | PRT | *da TJ02T* | ? |
| `OrderIsPreCosted` | PRC | *da TJ02T* | ? |
| `SettlementRuleIsCreated` | SETC | *da TJ02T* | ? |
| `SettlementRuleIsCrtedManually` | — | *da TJ02T* | ? |
| `OrderIsPartiallyReleased` | — | *da TJ02T* | ? |
| `OrderIsScheduled` | — | *da TJ02T* | ? |
| `OrderHasGeneratedOperations` | — | *da TJ02T* | ? |
| `OrderIsToBeHandledInBatches` | — | *da TJ02T* | ? |
| `MaterialAvailyIsNotChecked` | MANC | *da TJ02T* | ? |

**Come chiudere la tabella in modo deterministico** — non indovinare i codici `I000x`:

1. `SE16 → TJ02T` con `SPRAS = 'E'` e `OBTYP` degli ordini: si ottiene l'elenco completo
   `ISTAT` ↔ `TXT04` ↔ `TXT30`. Congelare la corrispondenza in questa tabella.
2. Per le righe con `TXT04` ancora `—`, la via sicura è **empirica**: portare un ordine di test
   nello stato desiderato, leggere `JEST` per il suo `OBJNR` e vedere quale `STAT` compare.
3. `STATUS_TEXT_EDIT` (import `OBJNR`, `SPRAS`, `FLG_USER_STAT`) restituisce il testo concatenato
   degli stati attivi: è l'equivalente di `SYSTEM_STATUS`/`CO_STTXT` del BAPI e serve come controllo
   incrociato. `STATUS_READ` restituisce le singole righe.

**Nota di performance**: leggere JEST **una volta per tutti gli OBJNR** selezionati
(`SELECT ... FOR ALL ENTRIES` o join), non una chiamata `STATUS_READ` per ordine. Su migliaia di
ordini la differenza è di ordini di grandezza.

## 5. Campi senza equivalente su ECC — 5 campi

Vanno restituiti **vuoti e dichiarati** nel contratto del FM, non omessi in silenzio: un campo
sempre vuoto e non documentato diventa un bug segnalato dal consumatore.

| Campo OData | Situazione su ECC | Ripiego |
|---|---|---|
| `StockSegment` | la **segmentazione** è funzionalità S/4 | nessuno: sempre vuoto |
| `LastChangeDateTime` | timestamp 14 char non esiste; ECC ha solo AUFK-AEDAT (data) e AUFK-AENAM | comporre `AEDAT` + `000000`, oppure CDHDR/CDPOS (`OBJECTCLAS = 'ORDER'`) per data+ora reali della modifica |
| `ProdnProcgIsFlexible` | "flexible processing": nessun campo corrispondente noto su ECC | verificare in SE11; se assente, sempre vuoto |
| `OrderLongText` | non è un campo di tabella nemmeno su S/4: è testo lungo STXH/STXL | `READ_TEXT` con oggetto e text-id della testata ordine (**da confermare**: `SE75`/debug di CO03 → testo lungo) |
| `ManufacturingOrderImportance` | priorità ordine (`CO_APRIO` nel BAPI); il doc interno riporta data element `n/d` per il lato OData | ricavare la sorgente con SE11 → dove usato su `CO_APRIO`, poi confronto in SE16 |

`ManufacturingOrderImportance` e `OrderLongText` rientrano nel delta ma con sorgente da determinare:
sono gli unici due campi per cui **non** propongo un'assegnazione, perché ogni candidato sarebbe una
congettura.

## Specifica per il FM RFC

Riuso della firma già progettata (`ZMARS_PROD_ORDER_GET`, function group `ZMARS_FG_PROD_ORDER`):
IMPORT `SO_*` come select-options `TT_RSDSSELOPT` + `IV_TOP` / `IV_SKIP` / `IV_ORDER_BY`,
EXPORT `ET_ORDER` = table type con i 78 campi.

Sequenza di lettura suggerita:

1. **Selezione** su `CAUFV` (o join AUFK+AFKO) con i filtri `SO_*` → lista `AUFNR` + `OBJNR`.
2. **Posizioni**: una SELECT su `AFPO` per gli `AUFNR` selezionati, applicando la regola di scelta
   posizione dichiarata (§3).
3. **Stati**: una SELECT su `JEST` per tutti gli `OBJNR` (`STAT LIKE 'I%'`, `INACT = space`) →
   valorizzazione dei 20 flag in memoria.
4. **Lookup**: `PRPS` per il WBS, `VBAK`/`KNA1` per `CustomerName`, conversione UoM, `READ_TEXT`
   solo se `OrderLongText` è richiesto (è la lettura più costosa: renderla opzionale con un flag).

Due avvertenze sul contratto:

- `IV_TOP` / `IV_SKIP` su una selezione multi-tabella **non** hanno la semantica di `$top`/`$skip`
  OData: senza un `ORDER BY` stabile la paginazione non è ripetibile. Definire l'ordinamento di
  default (`AUFNR`) e documentarlo.
- I campi della §5 vanno elencati nella documentazione del FM come "sempre vuoti su ECC".

## Procedura di verifica in SE11/SE16

Per ogni riga marcata `?`, in ordine di costo crescente:

1. **SE11 → data element → "dove usato" → Tabelle**: dà la coppia tabella-campo in modo
   deterministico (es. `CO_AUFLD` → AFKO-AUFLD). È il passo che chiude la maggior parte dei `?`.
2. **SE16** su AUFK/AFKO/AFPO per un ordine noto: confronto valore per valore con quanto atteso.
3. **SE37 → `BAPI_PRODORD_GET_DETAIL`** in esecuzione di test, `ORDER_OBJECTS` tutti a `'X'`:
   mostra quali campi della testata l'ECC riempie realmente. Chiude anche la trappola 6 del doc di
   mapping (copertura effettiva di `GET_LIST`).
4. **SE16 → TJ02T** per la tabella stati (§4), più un ordine di test per stato dubbio.

Una volta chiusi i `?`, aggiornare questo documento sostituendo `?` con `✓` e il nome campo
definitivo: il documento è la specifica per lo sviluppo ABAP, quindi deve restare la fonte unica.

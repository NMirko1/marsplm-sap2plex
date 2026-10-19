/**
 * [CONF-POSTING] Dove sta un componente: l'allocazione dell'albero Plex dell'ordine (feature 0028).
 *
 * COSA FA
 * Dato un ordine, restituisce la mappa `materiale -> numero d'operazione Plex` leggendo le due
 * tabelle del ciclo salvato: `ZPlexCycleComponent` dice a quale operazione un componente e' appeso
 * (`PlexOperationId`), `ZPlexCycleOperation` traduce quell'id nel NUMERO (10, 20, 30).
 *
 * PERCHE' L'ALBERO PLEX E NON LA PRENOTAZIONE SAP, che e' cio' che la 0028 faceva.
 * Il perimetro dei componenti — «fino a questa operazione» per lo scarto, «a questa operazione» per
 * il consumo per operazione — si valutava su
 * `A_ProductionOrderComponent_2.ManufacturingOrderOperation`. Su quell'asse la distinzione fra
 * scarto intermedio e scarto di fine linea SI PERDE IN SILENZIO: la BBP §7.5.2 dice che
 * «attualmente in SAP i componenti sono tutti allocati alla prima operazione», quindi «dall'operazione
 * 30 alla prima» vuol dire TUTTI, sempre. Sull'albero Plex la distinzione c'e', perche' ogni
 * componente e' stato appeso a un'operazione — a mano col trascinamento, o dall'auto-assegnazione
 * (feature 0005).
 *
 * NON CONTRADDICE la ragione che DEC-90 dava per l'asse SAP («il 261 chiude una prenotazione SAP»):
 * la prenotazione si chiude con `Reservation` / `ReservationItem`, che continuano a viaggiare sulla
 * riga. L'asse decide QUALI componenti entrano, non la correttezza dell'imputazione.
 *
 * DALLA 0030 QUESTO MODULO DA' ANCHE L'ANCORA DELLA CONFERMA D'ORDINE: `lastOperationNumber`, cioe'
 * l'ultima operazione dell'albero Plex dell'ordine. E' lo stesso albero — quello con cui il progetto
 * attiva e disattiva le operazioni del job su Plex — quindi il numero che l'API Plex restituisce
 * sulla registrazione appartiene a quella numerazione e il confronto ha senso. Non costa una lettura
 * in piu': le righe delle operazioni sono gia' in memoria.
 *
 * QUATTRO REGOLE, e ognuna ha una ragione che regge da sola.
 *
 * 1. Un materiale allocato a PIU' operazioni conta per la MINIMA. E' la' che viene consumato per
 *    primo, e «dall'operazione N alla prima» lo include se una qualunque delle sue allocazioni e'
 *    <= N: il minimo e' la forma piu' semplice che dice la stessa cosa.
 * 2. Il confronto sul materiale e' STRETTO — nessun allineamento di zeri iniziali — perche' entrambi
 *    i lati vengono da SAP: `ZPlexCycleComponent.Material` e' stato copiato dall'albero SAP, e i
 *    componenti dell'ordine arrivano dalla stessa sorgente. Un disallineamento e' un difetto a monte
 *    da vedere (DEC-51).
 * 3. L'esito dichiara DUE cose diverse da «questo componente non c'e'»: se l'albero e' stato LETTO, e
 *    se ha COMPONENTI. A valle si trattano in modo opposto — un componente assente dall'albero entra
 *    comunque nel perimetro (il criterio non valutabile su una riga non sottrae, DEC-56), mentre un
 *    albero senza componenti o illeggibile SOSPENDE la registrazione, perche' la' il criterio non e'
 *    valutabile affatto e il default consumerebbe l'intera distinta — cioe' proprio cio' che il plant
 *    ha chiesto di non fare (DEC-80).
 * 4. L'ANCORA e' il MASSIMO fra le operazioni PRINCIPALI: le sotto-operazioni sono escluse, perche'
 *    una di loro numerata piu' in alto spostererebbe l'ancora su un passo che nessuna registrazione
 *    raggiunge — e ogni conferma finirebbe archiviata come «intermedia», in silenzio. Il numero delle
 *    escluse si dichiara.
 *
 * LA CACHE E' PER ORDINE E PER RUN, e PIGRA: costruirla non legge niente, e un run in cui nessun
 * plant ha configurato un perimetro non legge mai queste tabelle. Stessa forma di `createOrderCache`
 * nel job: vive quanto il run, non e' un TTL da sorvegliare.
 *
 * Collaudo: node test/plexCycleAllocation.test.js · Perimetro: grep -rn "CONF-POSTING"
 */

'use strict';

const NS = 'avvaleplm.marsplm.sap2plex';
const E_CYCLE_OP = `${NS}.ZPlexCycleOperation`;
const E_CYCLE_COMP = `${NS}.ZPlexCycleComponent`;

/** Chiave di confronto di un materiale: STRETTA, solo spazi via (vedi la regola 2 in testata). */
function materialKey(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

/** Il numero d'operazione in forma confrontabile; `null` se non e' un numero. */
function opNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).trim());
  return Number.isFinite(x) ? Math.trunc(x) : null;
}

/**
 * La mappa dell'allocazione a partire dalle righe delle due tabelle. FUNZIONE PURA.
 *
 * Separata dalla lettura di proposito: e' la parte che si collauda a secco, ed e' dove stanno le tre
 * regole della testata.
 *
 * @param {object[]} operations righe di ZPlexCycleOperation (PlexOperationId, OperationNumber,
 *   SubOperation)
 * @param {object[]} components righe di ZPlexCycleComponent (PlexOperationId, Material)
 * @returns {{byMaterial: Map<string, number>, hasComponents: boolean, orphans: string[],
 *            unnumbered: number, lastOperationNumber: number|null, subOperations: number}}
 *   `orphans` sono i materiali la cui operazione non e' nell'elenco delle operazioni del ciclo —
 *   un albero incoerente, che si dichiara invece di essere letto come «senza operazione».
 *   `lastOperationNumber` e' l'ANCORA della conferma d'ordine (feature 0030): vedi la regola 4.
 */
function buildAllocation(operations, components) {
  const numberById = new Map();
  let unnumbered = 0;
  let last = null;
  let subOperations = 0;
  for (const o of (Array.isArray(operations) ? operations : [])) {
    if (!o) continue;
    const id = String(o.PlexOperationId || '').trim();
    const num = opNumber(o.OperationNumber);
    if (!id) continue;
    if (num === null) { unnumbered++; continue; }
    // [CONF-POSTING] REGOLA 4 — L'ANCORA E' IL MASSIMO FRA LE OPERAZIONI PRINCIPALI (feature 0030).
    //
    // Una SOTTO-operazione non e' un passo del ciclo: pende da un'operazione principale, e il suo
    // numero non appartiene alla stessa progressione. Se ne bastasse una numerata piu' in alto —
    // caso normale, perche' spesso le si numera dentro l'intervallo del padre o oltre — l'ancora si
    // sposterebbe su di lei e NESSUNA registrazione la raggiungerebbe mai: ogni conferma verrebbe
    // archiviata come «operazione intermedia», in silenzio e per sempre. E' la stessa classe di
    // guasto dell'operazione CANCELLATA che spostava l'ancora del versamento (feature 0027, U2),
    // vista dall'altro lato.
    //
    // Le sotto-operazioni si CONTANO comunque, perche' un'ancora che sembra sbagliata si spiega solo
    // sapendo quante ne sono state escluse.
    if (o.SubOperation === true || o.SubOperation === 1) {
      subOperations++;
    } else if (last === null || num > last) {
      last = num;
    }
    // Un id duplicato con due numeri e' un dato anomalo: si tiene il minore, coerentemente con la
    // regola 1, invece di dipendere dall'ordine di lettura.
    const prev = numberById.get(id);
    numberById.set(id, prev === undefined ? num : Math.min(prev, num));
  }

  const byMaterial = new Map();
  const orphans = [];
  let seen = 0;
  for (const c of (Array.isArray(components) ? components : [])) {
    if (!c) continue;
    const mat = materialKey(c.Material);
    if (!mat) continue;
    seen++;
    const num = numberById.get(String(c.PlexOperationId || '').trim());
    if (num === undefined) {
      if (!orphans.includes(mat)) orphans.push(mat);
      continue;
    }
    const prev = byMaterial.get(mat);
    // LA MINIMA: vedi la regola 1 in testata.
    byMaterial.set(mat, prev === undefined ? num : Math.min(prev, num));
  }

  return {
    byMaterial, hasComponents: seen > 0, orphans, unnumbered,
    lastOperationNumber: last, subOperations
  };
}

/**
 * La cache di allocazione di un run: una lettura per ordine, e solo se qualcuno la chiede.
 *
 * @param {object} db connessione CDS al db
 * @returns {{allocationFor: (orderId: string) => Promise<object>, stats: () => object}}
 *   `allocationFor` restituisce:
 *   - `ok`            la lettura e' riuscita;
 *   - `hasComponents` l'albero ha almeno un componente allocato;
 *   - `byMaterial`    `Map(materiale -> numero operazione Plex)`;
 *   - `opOf(comp)`    l'operazione di UNA riga componente, `null` se non allocata: e' la forma che
 *                     `confMatDoc.consumptionItems` inietta, cosi' quel modulo resta puro e non sa
 *                     da dove venga l'asse;
 *   - `lastOperationNumber` l'ANCORA della conferma d'ordine (0030), `null` se non nota;
 *   - `orphans`, `unnumbered`, `subOperations`, `reason` per la dichiarazione nel recap.
 */
function createPlexAllocationCache(db) {
  const cache = new Map();   // orderId -> promise dell'esito
  let reads = 0;

  async function load(orderId) {
    reads++;
    let operations;
    let components;
    try {
      operations = await db.run(
        SELECT.from(E_CYCLE_OP).columns('PlexOperationId', 'OperationNumber', 'SubOperation')
          .where({ ManufacturingOrder: orderId })
      );
      components = await db.run(
        SELECT.from(E_CYCLE_COMP).columns('PlexOperationId', 'Material')
          .where({ ManufacturingOrder: orderId })
      );
    } catch (e) {
      console.error(`>>> [CONF-POSTING] albero Plex dell'ordine ${orderId} illeggibile: ${e.message}`);
      return {
        ok: false, hasComponents: false, byMaterial: new Map(), opOf: () => null,
        orphans: [], unnumbered: 0,
        // [CONF-POSTING] `null` e' «non lo so», e a valle SOSPENDE la conferma invece di archiviarla
        // (DEC-80): una lettura fallita non dimostra che il ciclo non abbia un'ultima operazione.
        lastOperationNumber: null, subOperations: 0,
        reason: `albero Plex dell'ordine ${orderId} illeggibile: ${e.message}`
      };
    }

    const a = buildAllocation(operations, components);
    const notes = [];
    if (a.unnumbered) notes.push(`${a.unnumbered} operazioni del ciclo senza numero`);
    if (a.orphans.length) {
      notes.push(`${a.orphans.length} componenti appesi a un'operazione che il ciclo non ha`
        + ` (${a.orphans.slice(0, 8).join(', ')})`);
    }
    // [CONF-POSTING] Un albero fatto di SOLE sotto-operazioni non ha un'ancora, e senza questa riga
    // la conferma resterebbe sospesa senza che si capisca perche'.
    if (a.lastOperationNumber === null && a.subOperations) {
      notes.push(`nessuna operazione principale: ${a.subOperations} sotto-operazioni escluse`);
    }
    return {
      ok: true,
      hasComponents: a.hasComponents,
      byMaterial: a.byMaterial,
      // L'ANCORA della conferma d'ordine (feature 0030). `null` = non nota: sospende, non archivia.
      lastOperationNumber: a.lastOperationNumber,
      subOperations: a.subOperations,
      opOf: (comp) => {
        const v = a.byMaterial.get(materialKey(comp && comp.Material));
        return v === undefined ? null : v;
      },
      orphans: a.orphans,
      unnumbered: a.unnumbered,
      reason: notes.join(' · ')
    };
  }

  return {
    allocationFor(orderId) {
      const key = String(orderId || '');
      if (!cache.has(key)) cache.set(key, load(key));
      return cache.get(key);
    },
    stats() {
      return { orders: cache.size, reads };
    }
  };
}

module.exports = {
  E_CYCLE_OP,
  E_CYCLE_COMP,
  materialKey,
  opNumber,
  buildAllocation,
  createPlexAllocationCache
};

/**
 * [LAST-LOG-WORST-DAY] Quale riga di storico riassume un oggetto nelle LISTE del cruscotto (0049).
 *
 * PERCHE' ESISTE
 * Le tre liste del cruscotto hanno due colonne per dire com'e' andato l'ultimo scambio con Plex, e
 * fino alla 0049 le leggevano dalla TESTATA del log (`ZMatExcLogHDR`, `ZRoutingExcLogHDR`): una riga
 * per oggetto, cioe' l'ULTIMA scritta. Due difetti indipendenti, e nessuno dei due da' un errore.
 *
 *   1. L'ultima riga non e' la riga piu' importante. Un `MAT_SYNC` che alle 03:00 chiude in errore e
 *      un reinvio a mano che alle 10:00 riesce lasciano la lista VERDE: l'errore di oggi coperto dal
 *      successo di oggi, e nessuno lo va piu' a cercare.
 *   2. Sugli ordini la testata risponde a un'ALTRA domanda. Su `ZProdOrderExcLogPOS` scrivono otto
 *      operazioni (JOB, SPLIT, TECO, MATDOC, CONF, QTY, COMPLETED, SCHEDULED) ma la testata la
 *      aggiorna solo l'invio del job (`updateHeader`, srv/lib/prodOrderExcLog.js): mostrarla
 *      vorrebbe dire tacere una chiusura tecnica o una consuntivazione fallita.
 *
 * LA REGOLA, che vale per tutte e tre le liste:
 *
 *      si mostra la riga PEGGIORE del GIORNO PIU' RECENTE che ha righe.
 *
 * Il giorno viene PRIMA della gravita', e l'ordine dei due criteri e' la decisione: un errore di
 * ieri non deve coprire l'avviso di oggi — quello di ieri e' storia, e la storia sta nel dettaglio.
 * Dentro il giorno vince invece il peggiore, perche' una riga di elenco ha un posto solo e deve
 * nominare la cosa peggiore che e' successa.
 *
 *      righe dell'oggetto                    in lista
 *      oggi: S                               S
 *      oggi: E, W, S (in quest'ordine)       l'E di oggi
 *      ieri: E, W  —  oggi: S                la S di oggi
 *      ieri: E, W  —  oggi niente            l'E di ieri
 *      nessuna riga                          niente
 *
 * «Oggi» e' il giorno piu' recente in cui QUELL'oggetto ha righe, non la data odierna: con la
 * seconda lettura la colonna sarebbe vuota per ogni oggetto non toccato nelle ultime ore, cioe'
 * quasi tutta la lista, e non risponderebbe piu' a «com'e' andato l'ultimo invio».
 *
 * CONSEGUENZA DICHIARATA, e voluta: un errore risolto nella stessa giornata resta rosso fino al
 * giorno dopo. E' il prezzo del punto 1, e su materiali e cicli cambia cio' che la colonna diceva
 * prima della 0049.
 *
 * QUESTO VALE IN LISTA E NON NEL DETTAGLIO. Lo «Storico Invii» di un oggetto mostra OGNI riga in
 * ordine cronologico, con la sua operazione e i due pannelli: la' non si riassume niente, perche'
 * riassumere vorrebbe dire nascondere righe — e sarebbe togliere la sola schermata che risponde
 * «cosa e' stato fatto a questo oggetto» (0031, DEC-95).
 *
 * La decisione e' verificabile senza database, senza SAP e senza Plex, quindi sta qui e non
 * nell'orchestrazione (che e' in srv/lib/lastLog.js). Nessuna dipendenza — ne' `cds`, ne' rete, ne'
 * db, ne' stato globale, ne' orologio: in particolare NON si legge la data di sistema, o il test
 * cambierebbe esito a mezzanotte. Non aggiungerne: il test si lancia con
 *     node test/lastLogRules.test.js
 *
 * Nessuna funzione muta l'input.
 */

'use strict';

// ================================================================
// Gravita'
// ================================================================

/**
 * La scala degli stati delle tre log-table (`S` riuscito, `W` avviso, `E` errore).
 *
 * Tutto cio' che non e' in questa mappa vale ZERO, e i due contorni valgono insieme:
 *   - uno stato ignoto NON copre una `S` — un valore che nessuno ha dichiarato non e' una notizia
 *     peggiore di un successo;
 *   - ma se su quel giorno c'e' SOLO lui, vince comunque, e la cella esce muta
 *     (`formatStatusText` rende `""` su uno stato che non riconosce). Nascondere l'unica riga del
 *     giorno sarebbe peggio: la colonna direbbe «mai inviato» di un oggetto inviato.
 *
 * Le tre log-table dichiarano `assert.values: ['S','E','W']`, ma sono scritte SOLO dal server e
 * senza annotazione di assert eseguita a runtime: un valore nuovo aggiunto domani non deve far
 * cadere una READ di lista. E' la stessa tolleranza di `logMessage.unpack`.
 */
const SEVERITY = Object.freeze({ E: 3, W: 2, S: 1 });

/** La gravita' di uno stato. `0` su `null`, `undefined`, `''` e su qualunque codice ignoto. */
function severityOf(status) {
  if (typeof status !== 'string') return 0;
  return SEVERITY[status.trim().toUpperCase()] || 0;
}

// ================================================================
// Il giorno
// ================================================================

/**
 * Il giorno di una riga, come `'YYYY-MM-DD'` confrontabile per stringa.
 *
 * DUE FORME TOLLERATE, e non e' zelo: `SentDate` e' un `cds.Date`, che `@cap-js/sqlite` e
 * `@cap-js/hana` rendono come stringa `'YYYY-MM-DD'`, ma lo stesso campo appena scritto — o letto
 * da un driver che un giorno lo tipizzi — arriva come oggetto `Date`. Confrontare le due forme fra
 * loro con `<` darebbe un esito plausibile e sbagliato, e nessun errore. E' la stessa cautela con
 * cui `[MATDOC-CLAIM]` legge il conteggio delle righe toccate in due forme.
 *
 * ASSENTE VALE `''`, che ordina PRIMA di qualunque data: una riga senza giorno vince solo se
 * nessun'altra ne ha uno. Il contrario — trattarla come «oggi» — la farebbe vincere sempre, cioe'
 * una riga storica senza data coprirebbe per sempre tutte le altre.
 */
function dayOf(row) {
  const v = row && row.SentDate;
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  }
  return String(v).trim().slice(0, 10);
}

/**
 * Il progressivo di invio, che dentro un giorno decide chi e' piu' recente.
 *
 * E' `Counter` E NON `SentTime`, ed e' deliberato: `Counter` e' un progressivo per OGGETTO — per
 * `(Product, Plant)` sui materiali, per `(ciclo, materiale)` sui cicli, per ordine sugli ordini — e
 * due righe scritte nello stesso secondo esistono davvero (un run notturno scrive in fretta, e
 * `SentTime` ha la risoluzione del secondo). `SentTime` resta l'ultima spiaggia, per le righe in cui
 * `Counter` fosse assente o uguale.
 */
function counterOf(row) {
  const n = Number(row && row.Counter);
  return Number.isFinite(n) ? n : -1;
}

/** L'ora della riga, come stringa confrontabile. Solo tie-break: vedi `counterOf`. */
function timeOf(row) {
  const v = row && row.SentTime;
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// ================================================================
// Il confronto
// ================================================================

/**
 * `true` se `candidate` deve prendere il posto di `current`.
 *
 * L'ORDINE DEI QUATTRO CRITERI E' LA REGOLA, e non e' commutabile:
 *   1. giorno piu' recente        — un errore di ieri non copre un avviso di oggi
 *   2. stato piu' grave           — dentro il giorno, la riga di lista nomina il peggio
 *   3. `Counter` piu' alto        — a parita' di stato, la piu' recente
 *   4. `SentTime` piu' tarda      — solo se `Counter` non discrimina
 *
 * Con `current` assente il candidato vince sempre: e' il primo giro di `pickLastLog`.
 */
function isBetter(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;

  const dc = dayOf(candidate);
  const dk = dayOf(current);
  if (dc !== dk) return dc > dk;

  const sc = severityOf(candidate.Status);
  const sk = severityOf(current.Status);
  if (sc !== sk) return sc > sk;

  const cc = counterOf(candidate);
  const ck = counterOf(current);
  if (cc !== ck) return cc > ck;

  return timeOf(candidate) > timeOf(current);
}

/**
 * La riga che riassume UN oggetto, fra le sue righe di storico. `null` se non ce ne sono.
 *
 * `null` e `[]` rendono `null` e non lanciano: un oggetto mai inviato e' il caso NORMALE, non
 * un'anomalia, e il chiamante rende le due colonne vuote.
 */
function pickLastLog(rows) {
  if (!Array.isArray(rows)) return null;
  let best = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (isBetter(row, best)) best = row;
  }
  return best;
}

/**
 * La riga vincente di OGNI oggetto, in una passata sola.
 *
 * `keyOf(row)` e' l'identita' dell'oggetto e la fornisce il chiamante, perche' e' diversa per le tre
 * liste: `(Product, Plant)` sui materiali — la chiave di `[MAT-LOG-PLANT]`, e con la sola `Product`
 * un materiale in perimetro su due plant mostrerebbe su entrambe le righe l'esito di un plant solo —
 * `(gruppo, contatore, materiale)` sui cicli, `ManufacturingOrder` sugli ordini.
 *
 * Non si materializzano i gruppi: la storia di un perimetro materiali sta in memoria una volta, non
 * due. Una riga la cui chiave e' vuota o non stringa si SCARTA: unirla alle altre sotto `''`
 * attribuirebbe lo storico di un oggetto a un altro.
 */
function pickLastLogByKey(rows, keyOf) {
  const out = new Map();
  if (!Array.isArray(rows) || typeof keyOf !== 'function') return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = keyOf(row);
    if (typeof key !== 'string' || !key) continue;
    if (isBetter(row, out.get(key))) out.set(key, row);
  }
  return out;
}

module.exports = {
  SEVERITY, severityOf, dayOf, isBetter, pickLastLog, pickLastLogByKey
};

/**
 * [IS-SOURCE] Regole pure della CLASSIFICAZIONE PRODOTTO (feature 0018).
 *
 * COSA C'E' QUI
 * Tutto ciò che si può decidere sulla classificazione **senza rete e senza `cds`**: cosa il
 * customizing chiede di leggere, che forma ha la chiave del materiale sui due canali, in quale
 * campo sta il valore di una caratteristica, e come le righe delle cinque letture si ricompongono
 * nella struttura che l'auto-assegnazione confronta.
 *
 * PERCHE' E' SEPARATO
 * Su questa feature ogni dato arriva da un sistema esterno: senza un modulo puro non ci sarebbe
 * niente di collaudabile in locale. È la stessa scelta di `splitRules.js`, `isQueryShape.js`,
 * `plexJobSortRules.js` e `routingVisibility.js`.
 *     node test/clfnRules.test.js
 *
 * LA STRUTTURA CHE PRODUCE non è nuova: `buildClassIndex` restituisce esattamente la
 * `classByMaterial` che `matchCond` (srv/cat-service.js) confronta da sempre —
 * `materiale -> [{ className, chars: { ATINN: [valori] } }]`. È ciò che permette di cambiare il
 * CANALE della lettura senza toccare la valutazione delle condizioni.
 *
 * Nessuna funzione muta l'input.
 *
 * Vedi docs/0018-classificazione-su-is.md.
 */

'use strict';

/** Class type dei materiali: l'unico in perimetro, come nella lettura di sempre. */
const CLASS_TYPE_MATERIAL = '001';

/**
 * I campi in cui può stare il valore di una caratteristica, in ordine di precedenza. `CharcValue`
 * è quello dei tipi carattere; gli altri sono i limiti inferiori dei tipi numerici, data, ora e
 * valuta.
 *
 * L'elenco è più lungo dei due campi che la lettura storica guardava (`CharcValue` e
 * `CharcFromNumericValue`) perché sul canale IS il valore arriva dalla funzione ABAP e non dalla
 * proiezione OData: dove finisca lo decide il tipo di dato della caratteristica, e cercarlo in due
 * campi soli significherebbe leggere `200` con tutti i campi giusti e concludere «nessun valore».
 * Su un valore di tipo carattere le due precedenze coincidono.
 */
const VALUE_FIELDS = Object.freeze([
  'CharcValue', 'CharcFromNumericValue', 'CharcFromDecimalValue',
  'CharcFromAmount', 'CharcFromDate', 'CharcFromTime'
]);

// ================================================================
// Normalizzazione minima
// ================================================================

/** `trim` e nient'altro. `null`/`undefined` -> `''`. */
function norm(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

/** `trim` + maiuscolo: la forma in cui si confrontano nomi di classe e di caratteristica. */
function normU(v) {
  return norm(v).toUpperCase();
}

// ================================================================
// Le due forme della chiave materiale
// ================================================================

/**
 * Formato interno ALPHA: un codice tutto numerico va riempito di zeri a sinistra fino a 18
 * caratteri, uno alfanumerico passa così com'è. **È la forma del CANALE STORICO.**
 */
function alphaKey(material) {
  const m = norm(material);
  return /^\d+$/.test(m) ? m.padStart(18, '0') : m;
}

/** Il codice NUDO, senza riempimento. **È la forma degli indirizzi dell'Integration Suite.** */
function bareKey(material) {
  return norm(material);
}

/**
 * La chiave dell'oggetto classificato **nel formato che vuole il canale attivo**.
 *
 * NON SI UNIFORMA, ed è il punto in cui è più facile sbagliare. Sul gateway storico la
 * classificazione si legge in ALPHA; gli indirizzi dell'Integration Suite vogliono il codice nudo
 * e la conversione la fa la funzione (indicazione del 2026-08-12, misurata dalla sonda con le
 * varianti `PRD-CLS-ALPHA` e `VALORE.alpha`). Allineare le due forme «per pulizia» svuota una
 * delle due letture, che risponde `200` con zero righe: è la trappola di DEC-34, applicata alla
 * chiave invece che alla forma della query.
 *
 * @param {string} mode `'IS'` o `'ONPREM'`, come lo dichiara la sorgente d'area
 * @param {string} material numero materiale come lo conosce l'applicazione
 */
function productKeyFor(mode, material) {
  return mode === 'IS' ? bareKey(material) : alphaKey(material);
}

/**
 * Il materiale dell'applicazione a partire dall'ECO della risposta.
 *
 * È TOLLERANTE, e non contraddice DEC-51: qui non si confrontano due chiavi SAP di provenienza
 * diversa, si riconosce la chiave che abbiamo appena INVIATO in ciò che la funzione ci rimanda.
 * Alcuni indirizzi la restituiscono riempita di zeri anche quando l'abbiamo mandata nuda, e un
 * confronto stretto perderebbe la riga senza dirlo. È la stessa regola della lettura storica
 * (`resolveMat` in cat-service.js), spostata qui.
 *
 * @param {string} echo               `Product` come arriva dalla risposta
 * @param {Map<string,string>} byKey  chiave inviata -> materiale dell'applicazione
 * @returns {string} il materiale, o l'eco ripulito se non lo si riconosce
 */
function resolveEcho(echo, byKey) {
  const t = norm(echo);
  if (!t) return '';
  if (byKey.has(t)) return byKey.get(t);
  const stripped = t.replace(/^0+/, '');
  if (byKey.has(alphaKey(stripped))) return byKey.get(alphaKey(stripped));
  if (byKey.has(stripped)) return byKey.get(stripped);
  return stripped;
}

// ================================================================
// Cosa chiede il customizing
// ================================================================

/**
 * Cosa serve leggere, a partire dalle condizioni `CLASS` del customizing (`ZObjectGroupField`).
 *
 * Le coppie sono la parte che conta: su IS la verifica «la caratteristica Y è della classe X per
 * questo materiale» è una lettura per coppia, e leggere per prodotto cartesiano nomi × classi
 * moltiplicherebbe le chiamate su combinazioni che nessuna regola chiede.
 *
 * Una condizione senza classe o senza caratteristica non è leggibile e non è nemmeno valutabile:
 * `matchCond` la respinge («unresolved -> never matches»). Si scarta qui, così non genera letture.
 *
 * @param {Array<object>} conditions righe con `Class`, `Characteristic` (`ConditionType` 'CLASS')
 * @returns {{classNames: string[], charcNames: string[], pairs: Array<{className: string, charcName: string}>}}
 */
function wantedFrom(conditions) {
  const classNames = new Set();
  const charcNames = new Set();
  const pairs = new Map();
  for (const c of (conditions || [])) {
    const className = normU(c && c.Class);
    const charcName = normU(c && c.Characteristic);
    if (!className || !charcName) continue;
    classNames.add(className);
    charcNames.add(charcName);
    pairs.set(`${className}|${charcName}`, { className, charcName });
  }
  return { classNames: [...classNames], charcNames: [...charcNames], pairs: [...pairs.values()] };
}

// ================================================================
// Lettura di una riga
// ================================================================

/**
 * Il valore di una riga di `A_ProductCharcValue`: il primo campo di `VALUE_FIELDS` che porta
 * qualcosa.
 *
 * Uno `0` numerico È un valore, non un vuoto: il confronto è sulla stringa, non sulla verità —
 * `if (!value)` scarterebbe la valorizzazione «0» di una caratteristica numerica.
 *
 * @returns {{field: string, value: string}} campo e valore, `{field:'', value:''}` se non c'è
 */
function valueOfRow(row) {
  for (const field of VALUE_FIELDS) {
    const v = norm(row && row[field]);
    if (v !== '') return { field, value: v };
  }
  return { field: '', value: '' };
}

// ================================================================
// Forma del filtro
// ================================================================

/**
 * Il criterio su una chiave: `{ in: [...] }` con più valori, il valore NUDO con uno solo.
 *
 * NON È COSMETICA. `fanOutByKey` riscrive una lista in N letture per chiave, ma la sorgente
 * adotta la riscrittura **solo se le letture sono più di una** (isRemoteSource.js, `fan.length > 1`):
 * con un `in` di un elemento solo la query resta in forma collection, il key predicate non è più
 * componibile — `in` non è un termine di uguaglianza — e su un service root `_GET` si finisce a
 * chiedere una collection, che risponde `GET_FEED is not configured` (DEC-42). Un materiale solo
 * è il caso più comune del dettaglio ciclo: qui si manda l'uguaglianza e la lettura resta per chiave.
 *
 * @param {string[]} values
 * @returns {string|{in: string[]}|null} `null` se non c'è niente da filtrare
 */
function inOrEq(values) {
  const list = (values || []).map(norm).filter(Boolean);
  if (!list.length) return null;
  return list.length === 1 ? list[0] : { in: list };
}

// ================================================================
// Ricomposizione
// ================================================================

/**
 * L'indice della classificazione nella forma che `matchCond` consuma da sempre:
 *
 *     { materiale: [ { className, chars: { ATINN: [valori] } } ] }
 *
 * Le tre informazioni arrivano da letture DIVERSE e indipendenti, e qui si incontrano:
 *   - a quali classi appartiene il materiale         (`clintsByMaterial`, da `A_ProductClass`)
 *   - come si chiama ognuna di quelle classi         (`nameByClint`, da `A_ClfnClassForKeyDate`)
 *   - quali caratteristiche ha la classe, e quanto valgono
 *     (`charcsByMaterialClass` da `A_ProductClassCharc`, `valuesByMaterialCharc` da
 *      `A_ProductCharcValue` — che NON è per classe: la sua chiave non contiene il CLINT)
 *
 * Una classe di cui non si conosce il nome resta nell'indice con `className` vuoto: è inerte —
 * nessuna condizione può chiedere una classe senza nome — ma sparire cambierebbe i conteggi di chi
 * guarda l'indice per capire cosa è stato letto.
 *
 * @param {object} p
 * @param {Map<string,string[]>}     p.clintsByMaterial       materiale -> [CLINT]
 * @param {Map<string,string>}       p.nameByClint            CLINT -> nome classe (`''`/null = ignoto)
 * @param {Map<string,Set<string>>}  p.charcsByMaterialClass  `mat|CLINT` -> ATINN presenti su quella classe
 * @param {Map<string,string[]>}     p.valuesByMaterialCharc  `mat|ATINN` -> valori
 * @returns {object} classByMaterial
 */
function buildClassIndex({ clintsByMaterial, nameByClint, charcsByMaterialClass, valuesByMaterialCharc }) {
  const index = {};
  for (const [material, clints] of (clintsByMaterial || new Map())) {
    const classes = [];
    for (const clint of clints) {
      const className = normU(nameByClint && nameByClint.get(clint));
      const chars = {};
      const atinns = charcsByMaterialClass && charcsByMaterialClass.get(`${material}|${clint}`);
      for (const atinn of (atinns || [])) {
        chars[atinn] = (valuesByMaterialCharc && valuesByMaterialCharc.get(`${material}|${atinn}`)) || [];
      }
      classes.push({ className, chars });
    }
    index[material] = classes;
  }
  return index;
}

/**
 * I CLINT dei nomi di classe cercati, fra quelli di cui si conosce il nome.
 *
 * Serve a girare la domanda: nessun indirizzo cerca una classe PER NOME, quindi l'appartenenza si
 * verifica al contrario — dai CLINT del materiale al nome di ognuno, e poi «è quello cercato?».
 *
 * @param {string[]} classNames nomi cercati dal customizing (già in maiuscolo)
 * @param {Map<string,string>} nameByClint CLINT -> nome
 * @returns {Map<string,string>} nome cercato -> CLINT
 */
function clintsOfWantedClasses(classNames, nameByClint) {
  const wanted = new Set((classNames || []).map(normU));
  const out = new Map();
  for (const [clint, name] of (nameByClint || new Map())) {
    const n = normU(name);
    if (n && wanted.has(n) && !out.has(n)) out.set(n, norm(clint));
  }
  return out;
}

/**
 * Sono stati risolti tutti i nomi di classe cercati?
 *
 * È la condizione di uscita del fan-out sui CLINT: i CLINT di un materiale sono opachi e vanno
 * risolti uno per uno, ma appena tutti i nomi che il customizing chiede sono stati trovati, i CLINT
 * rimasti non possono più cambiare l'esito di nessuna condizione — e ognuno costerebbe una lettura.
 */
function allClassesResolved(classNames, nameByClint) {
  return clintsOfWantedClasses(classNames, nameByClint).size >= new Set((classNames || []).map(normU)).size;
}

// ================================================================
// Quali letture R4/R5 fare, e su quali materiali
// ================================================================

/**
 * [CLFN-PARALLEL] L'elenco delle letture R4 e R5 da eseguire, deciso PRIMA che ne parta una.
 *
 * PERCHE' E' UNA FUNZIONE A SE'. Nel codice di prima i due gruppi di letture erano due cicli
 * sequenziali, e `candidatesByAtinn` — riempito nel primo, consumato nel secondo — li faceva
 * sembrare dipendenti. NON LO SONO: quella mappa si calcola per intero da `clintsByMaterial`,
 * `clintByName` e `charcNameToId`, che sono tutti noti prima della prima chiamata. R4 dice se la
 * caratteristica è di quella classe, R5 dice quanto vale, e nessuna delle due ha bisogno della
 * risposta dell'altra: si incontrano solo alla fine, dentro `buildClassIndex`.
 *
 * Separare il PIANO dall'ESECUZIONE è ciò che permette di lanciare le `charcReads` e le `valueReads`
 * insieme invece che in fila, e di collaudare senza rete la parte che decide — quante letture, con
 * quali chiavi, in che ordine.
 *
 * L'ORDINE DELL'ELENCO E' QUELLO DI PRIMA, e non è cosmetica: è l'ordine in cui i motivi di
 * fallimento vanno riversati nell'esito complessivo, perché `fail()` tiene il primo (clfnRead.js).
 * Le `valueReads` seguono l'ordine di prima apparizione dell'ATINN fra le coppie, e i candidati di
 * ognuna l'ordine in cui le coppie li hanno aggiunti: era il comportamento della `Map`/`Set` che
 * questa funzione sostituisce.
 *
 * Una coppia le cui due metà non si risolvono non genera letture: `matchCond` la respinge comunque
 * («unresolved -> never matches»), e chiederla costerebbe una chiamata per sapere già la risposta.
 * Lo stesso per una coppia senza nessun materiale candidato.
 *
 * @param {object} p
 * @param {Array<{className: string, charcName: string}>} p.pairs  le coppie chieste dal customizing
 * @param {Map<string,string>} p.clintByName        nome classe cercato -> CLINT
 * @param {object}             p.charcNameToId      nome caratteristica -> ATINN (solo le positive)
 * @param {Map<string,string[]>} p.clintsByMaterial materiale -> [CLINT]
 * @param {string[]}           p.materials          i materiali in gioco, nell'ordine di ingresso
 * @returns {{charcReads: Array<{clint: string, atinn: string, label: string, candidates: string[]}>,
 *            valueReads: Array<{atinn: string, label: string, candidates: string[]}>}}
 */
function planClassReads({ pairs, clintByName, charcNameToId, clintsByMaterial, materials }) {
  const charcReads = [];
  const byAtinn = new Map();   // ATINN -> Set<materiale>, nell'ordine di prima apparizione
  const names = charcNameToId || {};
  const clints = clintByName || new Map();
  const mats = materials || [];

  for (const pair of (pairs || [])) {
    const clint = clints.get(pair.className);
    const atinn = names[pair.charcName];
    if (!clint || !atinn) continue;
    const candidates = mats.filter(m => ((clintsByMaterial && clintsByMaterial.get(m)) || []).includes(clint));
    if (!candidates.length) continue;
    charcReads.push({ clint, atinn, label: `${pair.className}/${pair.charcName}`, candidates });
    if (!byAtinn.has(atinn)) byAtinn.set(atinn, new Set());
    for (const m of candidates) byAtinn.get(atinn).add(m);
  }

  const valueReads = [];
  for (const [atinn, cands] of byAtinn) {
    valueReads.push({ atinn, label: atinn, candidates: [...cands] });
  }
  return { charcReads, valueReads };
}

module.exports = {
  CLASS_TYPE_MATERIAL,
  VALUE_FIELDS,
  norm,
  normU,
  alphaKey,
  bareKey,
  productKeyFor,
  resolveEcho,
  wantedFrom,
  valueOfRow,
  inOrEq,
  buildClassIndex,
  clintsOfWantedClasses,
  allClassesResolved,
  planClassReads
};

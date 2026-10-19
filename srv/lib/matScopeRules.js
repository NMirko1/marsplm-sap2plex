/**
 * [MAT-SCOPE] Il verdetto DEFINITIVO sul perimetro di un materiale: si vede? si invia a Plex?
 *
 * PERCHE' ESISTE
 * `classifyMaterial` (srv/lib/materialVisibility.js) restituisce gia' un verdetto completo —
 * `{visible, plexPartType}` — ma la classificazione avviene DUE volte, e la seconda ne teneva solo
 * meta':
 *
 *     r.PlexPartType = classifyMaterial(merged, cats).plexPartType || null;   // la lista
 *     const cls      = classifyMaterial(merged, cats).plexPartType || null;   // il job
 *
 * La prima passata gira sulla sola riga `A_ProductPlant`, che NON porta `ProductType` (MTART sta su
 * `A_Product`): e' cieca per costruzione, e resta VOLUTAMENTE permissiva — vedi il ramo
 * `unevaluable`. La seconda gira sui campi uniti, dove il verdetto e' vero. Buttandone la
 * visibilita', un materiale che dopo il join non aggancia NESSUNA categoria usciva
 * `{visible: false, plexPartType: null}` e quel `null` diventava una colonna vuota in dashboard: la
 * riga restava in lista, entrava nell'invio massivo e nel perimetro del job, e Plex la rifiutava con
 * `HTTP 400` perche' il corpo non porta `type`.
 *
 * Qui il verdetto si prende UNA volta, in un punto solo, e i quattro chiamanti lo condividono:
 *   - srv/cat-service.js  loadConfiguredProducts  (lista dashboard + invio massivo)
 *   - srv/cat-service.js  productDetails          (ripiego della scheda dopo un F5)
 *   - srv/cat-service.js  buildPlexPartRequestBody (invio singolo)
 *   - srv/jobs/syncMaterialsToPlex.js passo 2-bis  (perimetro del job MAT_SYNC)
 *
 * DUE BOOLEANI E NON UNO. `listable` e `sendable` sono due domande diverse, e il progetto ha due
 * risposte diverse per cio' che si VEDE e cio' che si SCRIVE (DEC-52): su un perimetro che governa
 * solo la vista la regola e' il fail-OPEN, su uno che governa una scrittura verso un sistema esterno
 * e' il fail-CLOSED. Le due divergono esattamente sui casi «non lo so», e fonderle in un `inScope`
 * solo butterebbe la distinzione che DEC-52 esiste per tenere. Sui casi decisi — «non ha
 * categoria», «non ha tipologia» — valgono entrambe `false`, ed e' cio' che la feature chiede.
 *
 * Nessuna dipendenza da `cds`, dalla rete, dal database, da uno stato globale o dall'orologio: il
 * test si lancia con
 *     node test/matScopeRules.test.js
 * Nessuna funzione muta l'input.
 */

'use strict';

const { classifyMaterial, needsProductDetails } = require('./materialVisibility');

// ================================================================
// Verdetti
// ================================================================

/**
 * I sei esiti. Sono stringhe e non numeri perche' finiscono nei `console.log` del server e del job
 * e nelle voci di recap: un verdetto va letto senza una legenda accanto.
 *
 * [MAT-SCOPE] NESSUNO DI QUESTI SI CHIAMA `NO_CONFIG`, ed e' deliberato: `RECV_STATE.NO_CONFIG`
 * (srv/lib/recvOpStep.js) esiste gia' e significa tutt'altro — «unita' di misura senza riga di
 * ricevimento». I due token viaggiano negli STESSI log e nello STESSO flusso di invio materiale:
 * riusare il nome costerebbe a ogni lettura futura.
 */
const SCOPE = {
  /** Il materiale aggancia una categoria che gli da' una tipologia: si vede e si invia. */
  IN_SCOPE: 'IN_SCOPE',
  /** Il plant non ha nessuna categoria attiva: perimetro non configurato, comportamento storico. */
  NO_CATEGORIES: 'NO_CATEGORIES',
  /** La lettura del customizing e' CADUTA: non sappiamo se il plant ha categorie. */
  CATEGORIES_UNKNOWN: 'CATEGORIES_UNKNOWN',
  /** Le categorie chiedono un campo che solo l'anagrafica porta, e l'anagrafica non c'e'. */
  DETAIL_UNKNOWN: 'DETAIL_UNKNOWN',
  /** Valutato per intero: nessuna categoria lo aggancia. E' un perimetro vero. */
  NO_CATEGORY_MATCH: 'NO_CATEGORY_MATCH',
  /** Aggancia una categoria, ma nessuno gli da' una tipologia: Plex rifiuterebbe la part. */
  NO_PART_TYPE: 'NO_PART_TYPE'
};

/** Costruttore dei verdetti: un posto solo in cui la forma dell'oggetto e' decisa. */
function verdict(reason, listable, sendable, plexPartType, extra) {
  return { reason, listable, sendable, plexPartType: plexPartType || null, ...(extra || {}) };
}

// ================================================================
// Il verdetto
// ================================================================

/**
 * Il perimetro definitivo di un materiale su un plant.
 *
 * @param {object}  args
 * @param {object}  args.sapFields   i campi SAP GIA' UNITI (riga product-plant + anagrafica), cioe'
 *                                   l'uscita di `mergeProductFields`. Si prendono uniti e non in
 *                                   due pezzi perche' il percorso d'INVIO non ne ha due:
 *                                   `fetchMaterialSapFields` rende un'unica borsa piatta.
 * @param {boolean} args.detailKnown l'anagrafica di QUESTO materiale e' stata ottenuta. NON e'
 *                                   `!!sapFields.ProductType`: un MTART davvero vuoto e' un valore,
 *                                   un'anagrafica non letta e' un'assenza di informazione, e i due
 *                                   hanno rimedi opposti — «configura la tipologia» contro
 *                                   «guarda perche' la lettura e' caduta».
 * @param {Array}   args.categories  le categorie ATTIVE del plant (Conditions espanse)
 * @param {boolean} [args.categoriesKnown=true]  la lettura del customizing e' riuscita.
 *                                   `loadPlantCategories` inghiotte l'errore e rende `[]`: senza
 *                                   questo flag una lettura caduta diventerebbe «nessuna
 *                                   categoria», quindi invio SENZA `type`, quindi lo STESSO 400 che
 *                                   questo modulo esiste per chiudere.
 * @param {boolean} [args.typeAvailable=false]  la tipologia arriva comunque, per un'altra strada.
 *                                   Vedi il blocco qui sotto: non e' un'opzione, e' cio' che
 *                                   impedisce una regressione secca.
 * @returns {{reason: string, listable: boolean, sendable: boolean, plexPartType: string|null,
 *            catchAll?: boolean, ambiguousCatchAll?: string[]}}
 */
function finalScope({
  sapFields = null,
  detailKnown = false,
  categories = null,
  categoriesKnown = true,
  typeAvailable = false
} = {}) {
  const cats = Array.isArray(categories) ? categories : [];

  // 1) NON SAPPIAMO se il plant ha categorie.
  // Si vede (mostrare qualcosa in piu' e' un fastidio che si vede, DEC-52) e non si invia: verso
  // Plex una scrittura decisa su un customizing che non si e' riusciti a leggere e' esattamente il
  // 400 di prima, con un'altra causa a monte.
  if (categoriesKnown === false) {
    return verdict(SCOPE.CATEGORIES_UNKNOWN, true, false, null);
  }

  // 2) Il plant non ha categorie: perimetro non configurato.
  //
  // Resta il comportamento storico — tutto in lista, tutto inviabile, nessun `type` nel corpo —
  // perche' un perimetro non ancora configurato non e' un perimetro (DEC-52/DEC-53). E' anche
  // l'unico ramo che BYPASSA il requisito della tipologia del punto 6: il requisito e' una
  // proprieta' della classificazione, e qui non c'e' nessuna classificazione.
  if (cats.length === 0) {
    return verdict(SCOPE.NO_CATEGORIES, true, true, null);
  }

  // 3) Le categorie chiedono un campo che la sola riga product-plant non porta, e l'anagrafica non
  // e' stata ottenuta.
  //
  // `needsProductDetails` si calcola QUI e non arriva dal chiamante di proposito: e' una funzione
  // delle categorie, e passarla dall'esterno vorrebbe dire che tre chiamanti possono sbagliarla in
  // tre modi diversi. Dove NESSUNA categoria usa quel campo, il verdetto sulla sola riga plant e'
  // gia' definitivo e un'anagrafica mancante non deve trattenere niente — trattenerla perderebbe
  // materiali oggi in perimetro a pieno titolo.
  //
  // Non e' `listable` perche' una riga senza anagrafica non ha niente da mostrare (la lista la
  // scarta gia' oggi nel merge), e non e' `sendable` perche' una lettura caduta non dimostra
  // l'assenza: si trattiene e si dichiara, e il run successivo riprova.
  if (needsProductDetails(cats) && detailKnown !== true) {
    return verdict(SCOPE.DETAIL_UNKNOWN, false, false, null);
  }

  // 4) Il verdetto vero, sui campi uniti.
  const cls = classifyMaterial(sapFields, cats);
  const extra = {
    ...(cls.catchAll ? { catchAll: true } : {}),
    ...(cls.ambiguousCatchAll ? { ambiguousCatchAll: cls.ambiguousCatchAll } : {})
  };

  // 5) Nessuna categoria lo aggancia. E' un perimetro deciso da criteri veri, valutati per intero.
  if (!cls.visible) {
    return verdict(SCOPE.NO_CATEGORY_MATCH, false, false, null, extra);
  }

  // 6) Aggancia, ma nessuna tipologia — e nessun'altra strada gliela da'.
  //
  // [MAT-SCOPE] `typeAvailable` NON e' un'ottimizzazione: senza, questo ramo e' una regressione
  // secca. `type` e' mappabile a mano su `ZPlexFieldMap` — `LOCKED_FIELDS` in plexPartMapper.js
  // esclude solo `number`/`name`/`description`, e 0004 RB-17 lo documenta — quindi un plant puo'
  // fornire la tipologia senza che nessuna categoria porti una classe. Gatare sulla sola classe
  // farebbe smettere di inviare TUTTO a quei plant, in silenzio.
  //
  // I due chiamanti lo calcolano in due modi, ed e' voluto:
  //   - INVIO: `payload.type` non vuoto, cioe' la verita' su QUESTO materiale;
  //   - LISTA: esiste una riga `ZPlexFieldMap` con `PlexField = 'type'` su questo plant, cioe'
  //     un'approssimazione PER PLANT.
  // L'approssimazione e' nella direzione sicura: la lista puo' mostrare un materiale che l'invio
  // poi rifiuta, mai nascondere uno che l'invio accetterebbe. Il residuo — un mapping CONDIZIONATO
  // che per quel materiale non produce niente — e' un limite dichiarato, non un difetto nascosto.
  const partType = String(cls.plexPartType || '').trim();
  if (!partType && !typeAvailable) {
    return verdict(SCOPE.NO_PART_TYPE, false, false, null, extra);
  }

  return verdict(SCOPE.IN_SCOPE, true, true, partType || null, extra);
}

// ================================================================
// Conteggi da dichiarare
// ================================================================

/**
 * L'accumulatore dei motivi di potatura di un plant.
 *
 * Esiste perche' la potatura SI DICHIARA: se svuota la lista, `loadConfiguredProducts` arriva a
 * `if (plantRows.length === 0) return []` e l'unica traccia sarebbe una riga di console — la
 * sparizione silenziosa che il progetto vieta. Il chiamante conta qui e poi rende la busta a
 * `productScope` (dashboard) o al recap (job).
 *
 * `total` e' il numero di materiali VALUTATI, non di quelli potati: senza, «5 esclusi» non dice se
 * su cinque o su cinquemila.
 */
function newTally() {
  return {
    total: 0,
    kept: 0,
    [SCOPE.NO_CATEGORY_MATCH]: 0,
    [SCOPE.NO_PART_TYPE]: 0,
    [SCOPE.DETAIL_UNKNOWN]: 0,
    [SCOPE.CATEGORIES_UNKNOWN]: 0,
    [SCOPE.NO_CATEGORIES]: 0,
    [SCOPE.IN_SCOPE]: 0
  };
}

/** Registra un verdetto nell'accumulatore. `keep` dice se il chiamante ha tenuto la riga. */
function tally(acc, reason, keep) {
  if (!acc) return acc;
  acc.total++;
  if (keep) acc.kept++;
  if (reason in acc) acc[reason]++;
  return acc;
}

/**
 * Il plant ha materiali potati per una ragione di CUSTOMIZING (non un guasto)?
 *
 * Serve a decidere se dichiarare, non a decidere l'esito: `NO_CATEGORY_MATCH` e `NO_PART_TYPE` sono
 * la normalita' di un perimetro configurato e NON degradano un run — un giallo perenne senza
 * rimedio insegna a ignorare il giallo (DEC-115).
 */
function prunedByConfig(acc) {
  if (!acc) return 0;
  return acc[SCOPE.NO_CATEGORY_MATCH] + acc[SCOPE.NO_PART_TYPE];
}

/**
 * Il plant ha materiali trattenuti perche' NON SI SAPEVA?
 *
 * Questi degradano: sono materiali che forse andavano inviati, e il rimedio non e' il customizing.
 */
function prunedByUnknown(acc) {
  if (!acc) return 0;
  return acc[SCOPE.DETAIL_UNKNOWN] + acc[SCOPE.CATEGORIES_UNKNOWN];
}

/**
 * Le categorie ATTIVE di un plant che non assegnano nessuna tipologia, per nome.
 *
 * Vanno NOMINATE, e non contate: `classifyMaterial` prende la PRIMA categoria normale che aggancia,
 * per `Sequence` (materialVisibility.js), quindi una categoria senza tipologia a `Sequence` bassa
 * OMBREGGIA tutte le successive E il ripiego. Una sola riga di customizing puo' far sparire
 * l'intero perimetro di un plant, e il rimedio e' quella riga: un conteggio manderebbe a cercare
 * nei materiali.
 *
 * Il RIPIEGO e' compreso, benche' la sua tipologia sia obbligatoria in scrittura
 * (`mcCatchAllPartTypeMandatory`): quel controllo vale su CREATE/UPDATE, e le righe salvate prima
 * esistono. Un ripiego senza tipologia non ombreggia nessuno, ma manda in `NO_PART_TYPE` tutto
 * cio' che avanza — che e' il caso peggiore di tutti.
 */
function untypedCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .filter(c => !String(c && c.PlexPartType || '').trim())
    .map(c => String(c && c.CategoryName || '').trim() || '(senza nome)');
}

// ================================================================
// I messaggi
// ================================================================

/**
 * Motivo -> chiave i18n del bundle del COCKPIT.
 *
 * Sta qui, in un modulo puro, e non nei due chiamanti: il rifiuto di un invio (cat-service.js) e la
 * voce di recap del job (syncMaterialsToPlex.js) descrivono lo STESSO verdetto, e due elenchi di
 * chiavi divergerebbero — la dashboard direbbe una cosa e il recap notturno un'altra sullo stesso
 * materiale. Qui non c'e' nessun TESTO, solo chiavi: i testi stanno nei bundle delle app e sono
 * letti da disco a runtime, quindi una chiave mancante esce GREZZA in produzione senza errore
 * (test/i18nRawKeys.test.js e' la rete).
 *
 * `NO_CATEGORIES` e `IN_SCOPE` non ci sono: non sono rifiuti, non hanno niente da dichiarare.
 */
const MSG_KEY = Object.freeze({
  [SCOPE.NO_CATEGORY_MATCH]: 'logMatNoCategory',
  [SCOPE.NO_PART_TYPE]: 'logMatCategoryNoPartType',
  [SCOPE.DETAIL_UNKNOWN]: 'logMatScopeDetailUnknown',
  [SCOPE.CATEGORIES_UNKNOWN]: 'logMatScopeCategoriesUnknown'
});

/**
 * La chiave i18n di un motivo, con un RIPIEGO che non promette niente.
 *
 * Un motivo nuovo aggiunto a `SCOPE` senza la sua chiave renderebbe un messaggio con la chiave
 * grezza a schermo: si ripiega su quella generica, che e' vera per qualunque motivo.
 */
function msgKeyOf(reason) {
  return MSG_KEY[reason] || 'logMatOutOfScope';
}

module.exports = {
  SCOPE,
  MSG_KEY,
  msgKeyOf,
  finalScope,
  newTally,
  tally,
  prunedByConfig,
  prunedByUnknown,
  untypedCategories
};

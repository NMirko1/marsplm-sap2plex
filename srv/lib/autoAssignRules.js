/**
 * [AUTO-ASSIGN] La PRECEDENZA dell'auto-assegnazione, in forma pura.
 *
 * ============================================================================
 * PERCHE' ESISTE QUESTO MODULO
 * ============================================================================
 * `resolveAutoAssignments` ha `cds` e la rete dentro: non e' collaudabile. La scelta di QUALE riga
 * di `ZCycleAutoAssignConfig` governa un componente invece lo e', ed e' precisamente la cosa che non
 * deve regredire — perche' sbagliarla non produce nessun errore: produce un componente collocato
 * sull'operazione sbagliata, o sparito dall'albero, e in fabbrica si vede.
 *
 * ============================================================================
 * IL DIFETTO CHE HA RESO NECESSARIA LA SEPARAZIONE (11/09/2026)
 * ============================================================================
 * Le due dimensioni erano annidate al contrario: **prima il gruppo, poi la specificita'**.
 *
 *     for (const g of groups) { if (…aggancia…) { matchedGroup = g; break; } }   // ORDER BY GroupId
 *     const cfg = config[`${headerMaterial}||${matchedGroup}`] || config[`*||${matchedGroup}`];
 *
 * Il `break` fermava la ricerca al PRIMO gruppo che agganciava, e il ripiego `*` viveva dentro
 * quel gruppo. Sul plant 07 i gruppi con riga `*` si chiamano `24`, `68`, `77`, `78`, `87`, `88`,
 * `100`, `104`, e `GroupId` e' una STRINGA: `ORDER BY GroupId asc` mette le cifre prima delle
 * lettere, quindi
 *
 *     100 < 104 < 24 < 68 < 77 < 78 < 87 < 88 < E < F < GRP-01
 *
 * e i gruppi `E`/`F` — quelli con la riga SPECIFICA del materiale di testata — non venivano
 * raggiunti mai. Il componente finiva sulla riga `*` di un gruppo numerico, che punta a
 * un'operazione con un nome (`V090`, `V1600`, `L2100`, `LROB`); su un ciclo che quell'operazione non
 * ha, spariva dall'albero senza che niente lo dicesse.
 *
 * ============================================================================
 * LA REGOLA, ADESSO
 * ============================================================================
 * **Le righe del materiale di testata vincono SEMPRE. Le righe `*` sono il ripiego per i componenti
 * che da quelle non hanno ricevuto un'assegnazione.**
 *
 * Quindi: si raccolgono TUTTI i gruppi che agganciano (niente `break`), e si fanno DUE passate —
 * prima le righe specifiche, poi le `*`. L'ordine di `GroupId` resta, ma solo come spareggio DENTRO
 * ciascuna passata: non decide piu' quale riga di customizing governa.
 *
 * ============================================================================
 * E DENTRO CIASCUNA PASSATA, PRIMA IL GRUPPO PIU' SPECIFICO (24/09/2026)
 * ============================================================================
 * Lo spareggio per `GroupId` non bastava: con un gruppo G1 (campo X = A) e un gruppo G2 (X = A e
 * Y = J), un componente che soddisfa entrambi finiva su G1 se `G1 < G2` — cioe' la regola GENERICA
 * si prendeva i componenti di quella piu' specifica, e li mandava su un'altra operazione.
 *
 * La regola, adesso, si legge sulle REGOLE (`ZCycleAutoAssignConfig`), non sui gruppi:
 *
 *   1. le candidate sono le righe del materiale di testata e le righe `*` del plant
 *      (`ruleGroupCodes`): un gruppo che non compare in nessuna di esse non si valuta nemmeno;
 *   2. prima le regole del materiale, dal gruppo con PIU' condizioni a quello con meno; poi le `*`,
 *      ordinate allo stesso modo;
 *   3. vince la prima regola il cui gruppo aggancia il componente.
 *
 * Le condizioni si contano senza distinguere `FIELD` da `CLASS`. A parita' di numero decide ancora
 * l'ordine di `GroupId`, come prima. E DEC-129 resta intera: una regola del materiale batte una `*`
 * anche quando il gruppo della `*` ha piu' condizioni — la specificita' del materiale viene prima di
 * quella del gruppo.
 *
 * Il modulo non dipende da `cds` ne' dalla rete, e non conosce la forma delle condizioni: chi chiama
 * passa il predicato gia' legato ai dati del materiale.
 */

'use strict';

/** Chiave dell'indice di `ZCycleAutoAssignConfig`: materiale (o `*`) + gruppo. */
function configKey(material, groupId) {
  return `${material == null ? '' : material}||${groupId == null ? '' : groupId}`;
}

/**
 * Il materiale di testata per cui ha senso cercare righe SPECIFICHE, oppure `''`.
 *
 * Senza materiale di testata non c'e' nessuna riga specifica da cercare: si va diretti al ripiego.
 * Non si cerca `''||gruppo`, che non e' una chiave che qualcuno scrive, ne' `*`, che e' il ripiego.
 */
function specificMaterial(headerMaterial) {
  const m = headerMaterial == null ? '' : String(headerMaterial).trim();
  return m && m !== '*' ? m : '';
}

/**
 * «Questa riga di `ZCycleAutoAssignConfig` e' una regola per il ciclo di questo materiale?»
 *
 * Poggia su `specificMaterial`, lo stesso con cui `pickAssignment` compone le chiavi delle sue due
 * passate: cosi' `ruleGroupCodes` (quali gruppi si valutano) e `pickAssignment` (quale riga governa)
 * rispondono alla stessa domanda allo stesso modo. Se divergessero, un gruppo valutato potrebbe non
 * avere la riga che la passata cerca — cioe' un «gruppo agganciato senza regola», che per
 * costruzione non deve esistere piu'.
 *
 * @returns {boolean}
 */
function isRuleFor(material, headerMaterial) {
  const m = material == null ? '' : String(material);
  if (m === '*') return true;
  const hm = specificMaterial(headerMaterial);
  return !!hm && m === hm;
}

/**
 * I `GroupId` delle regole del ciclo: sono i soli gruppi che l'auto-assegnazione valuta.
 *
 * Un gruppo che non compare in nessuna regola del materiale di testata ne' in una `*` non potrebbe
 * comunque collocare niente: valutarlo servirebbe solo a leggere dati per niente.
 *
 * @param {object} p
 * @param {Array<object>} p.configRows righe di `ZCycleAutoAssignConfig` (override del template compreso)
 * @param {string} p.headerMaterial materiale di testata del ciclo
 * @returns {Set<string>}
 */
function ruleGroupCodes({ configRows, headerMaterial } = {}) {
  const out = new Set();
  for (const r of (Array.isArray(configRows) ? configRows : [])) {
    if (!r || r.ComponentGroup == null || r.ComponentGroup === '') continue;
    if (isRuleFor(r.Material, headerMaterial)) out.add(r.ComponentGroup);
  }
  return out;
}

/**
 * TUTTI i gruppi che agganciano, nell'ordine in cui arrivano (il chiamante li legge
 * `ORDER BY GroupId asc`).
 *
 * NIENTE `break`: fermarsi al primo e' esattamente il difetto descritto in testa al file. Un gruppo
 * SENZA condizioni non aggancia mai — una regola senza criteri sarebbe un passa-tutto silenzioso,
 * ed e' il divieto di [DEC-52].
 *
 * @param {Array<object>} groups righe di `ZObjectGroup`, gia' ordinate
 * @param {object} fieldsByGroup `group_ID` -> condizioni
 * @param {(cond: object) => boolean} matches predicato gia' legato al materiale
 * @returns {Array<object>} i gruppi che agganciano, nello stesso ordine
 */
function matchingGroups(groups, fieldsByGroup, matches) {
  const out = [];
  if (!Array.isArray(groups) || typeof matches !== 'function') return out;
  const byGroup = fieldsByGroup || {};
  for (const g of groups) {
    if (!g) continue;
    const conds = byGroup[g.ID] || [];
    if (conds.length === 0) continue;
    if (conds.every((c) => matches(c))) out.push(g);
  }
  return out;
}

/**
 * La riga di customizing che governa il componente, e da quale passata viene.
 *
 * PASSATA 1 — le righe del materiale di TESTATA.
 * PASSATA 2 — solo se la prima non ha trovato niente: le righe `*`.
 *
 * Dentro ciascuna passata si candidano i gruppi agganciati che hanno la riga di quella passata, e
 * vince quello con PIU' condizioni: e' il piu' specifico, e se vincesse il generico si prenderebbe
 * i componenti dell'altro. A parita' decide l'ordine di `matchedGroups` (cioe' di `GroupId`): il
 * sort e' stabile. Senza `fieldsByGroup` tutti i gruppi valgono zero, e resta il solo ordine.
 *
 * Le due passate NON si fondono in un `||` dentro un ciclo solo: sarebbe di nuovo «il gruppo decide,
 * la specificita' del materiale segue», cioe' il difetto di DEC-129. Il ripiego e' ripiego solo se
 * si guarda DOPO aver esaurito tutte le righe specifiche — anche quelle di gruppi meno specifici.
 *
 * @param {object} p
 * @param {Array<object>} p.matchedGroups da `matchingGroups`
 * @param {object} p.configByKey `${materiale}||${gruppo}` -> riga di `ZCycleAutoAssignConfig`
 * @param {string} p.headerMaterial materiale di testata del ciclo
 * @param {object} [p.fieldsByGroup] `group_ID` -> condizioni, per contarle
 * @returns {{cfg: object, group: object, source: 'SPECIFIC'|'FALLBACK'}|null}
 */
function pickAssignment({ matchedGroups, configByKey, headerMaterial, fieldsByGroup } = {}) {
  const groups = Array.isArray(matchedGroups) ? matchedGroups.filter(Boolean) : [];
  const cfgs = configByKey || {};
  const byGroup = fieldsByGroup || {};
  const condCount = (g) => (byGroup[g.ID] || []).length;

  const bestOf = (material, source) => {
    const candidates = [];
    for (const g of groups) {
      const cfg = cfgs[configKey(material, g.GroupId)];
      if (cfg) candidates.push({ cfg, group: g });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => condCount(b.group) - condCount(a.group));
    return { ...candidates[0], source };
  };

  const material = specificMaterial(headerMaterial);
  return (material && bestOf(material, 'SPECIFIC')) || bestOf('*', 'FALLBACK');
}

module.exports = { configKey, ruleGroupCodes, matchingGroups, pickAssignment };

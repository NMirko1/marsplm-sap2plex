'use strict';

/**
 * [CONF-GROUP] Le conferme d'ordine si SOMMANO per ordine, una chiamata SAP per ordine per run.
 * Regole PURE: ne' cds ne' rete. Test: test/confGroupRules.test.js.
 *
 * PERCHE'. Fino al 25/09/2026 il job PROD_CONF mandava una conferma per registrazione Plex: N
 * registrazioni sullo stesso ordine erano N chiamate di fila sullo stesso oggetto SAP, che si
 * prendevano errori di lock. Ora, in una run, TUTTE le conferme da inviare sullo stesso ordine — le
 * nuove e quelle da ritentare — diventano UNA conferma con la quantita' sommata, e l'esito vale per
 * tutte: `OrderID` uguale a quello mandato, tutte registrate; altrimenti tutte da ritentare.
 *
 * Cosa resta PER REGISTRAZIONE, di proposito: la riga di `ZProdConfMatDoc` (stato, tentativi,
 * tetto del plant), la riga dello storico dell'ordine e quella del recap. Si somma solo la chiamata.
 *
 * Il perimetro e' la sola conferma (`DocSeq 3`, plant in `ProdPosting='CONF'`): scarti e documenti
 * materiale restano uno per registrazione.
 */

/** `ConfirmationText` e' AFRU-LTXA1: CHAR 40. */
const LEN_CONF_TEXT = 40;

/** Il gruppo di una conferma: plant e ordine SAP. */
function groupKey(doc) {
  const d = doc || {};
  return `${String(d.Plant || '')}|${String(d.ManufacturingOrder || '')}`;
}

/** L'ordine senza gli zeri del formato interno: `000700000041` -> `700000041`. */
function bareOrder(v) {
  const s = String(v == null ? '' : v).trim();
  const bare = s.replace(/^0+/, '');
  return bare || s;
}

/** Quantita' in millesimi interi: la somma di decimali in virgola mobile sbaglia (0.1 + 0.2). */
function thousandths(q) {
  const n = Number(q);
  return Number.isFinite(n) ? Math.round(n * 1000) : NaN;
}

/**
 * Una conferma si puo' sommare? Serve un oggetto con `OrderID` e una quantita' positiva: e' cio' che
 * `confirmationFor` scrive sempre. Una riga che non lo e' non si somma — sommarla a zero
 * confermerebbe meno di quanto prodotto senza dirlo — e il job la tratta come corpo illeggibile.
 */
function isSummable(confirmation) {
  const c = confirmation;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (!String(c.OrderID || '').trim()) return false;
  const q = thousandths(c.ConfirmationYieldQuantity);
  return Number.isFinite(q) && q > 0;
}

/** Data e ora esterne come istante confrontabile, o '' se la coppia non e' intera. */
function stampOf(c) {
  const d = String((c && c.ConfirmationExternalEntryDate) || '').trim();
  const t = String((c && c.ConfirmationExternalEntryTime) || '').trim();
  return d && t ? `${d}T${t}` : '';
}

/**
 * Il testo della conferma sommata. Con una registrazione sola resta il suo (`SN … · Plex …`); con
 * piu' registrazioni dello stesso lotto Plex `Plex <lotto> · N reg.`, con lotti diversi o ignoti
 * `Ordine <ordine> · N reg.`. Il numero di serie delle singole registrazioni resta nello storico di
 * Mars, una riga per registrazione.
 */
function groupText(members, lots, orderId) {
  if (members.length === 1) return String(members[0].confirmation.ConfirmationText || '');
  const n = members.length;
  const distinct = new Set(lots.map((l) => String(l || '').trim()));
  const lot = distinct.size === 1 ? [...distinct][0] : '';
  const text = lot ? `Plex ${lot} · ${n} reg.` : `Ordine ${bareOrder(orderId)} · ${n} reg.`;
  return text.slice(0, LEN_CONF_TEXT);
}

/**
 * Somma le conferme di un gruppo. FUNZIONE PURA.
 *
 * Le chiamate sono una per (ordine, unita'): lo stesso ordine ha la stessa unita' di produzione, ma
 * due unita' diverse non si sommano, e l'ordine si confronta senza gli zeri del formato interno.
 * Nell'ordine d'ingresso, la prima riga di ogni chiamata fa da base: i campi che le conferme hanno
 * uguali per costruzione (`OrderID`, i tre booleani, l'unita') vengono da li'.
 *
 *   `ConfirmationYieldQuantity`          la somma, in millesimi e poi riportata a decimale
 *   `ConfirmationText`                   vedi `groupText`
 *   `ConfirmationExternalEntryDate/Time` la coppia PIU' RECENTE fra le righe che le hanno entrambe;
 *                                        se nessuna le ha, nessuna delle due (vanno in coppia, o
 *                                        SAP legge «fine a mezzanotte»: DEC-59)
 *
 * @param {Array<{key: string, confirmation: object}>} members le conferme gia' validate da
 *   `isSummable`, con la chiave della loro registrazione
 * @param {{lots?: Map<string,string>}} [opts] il lotto Plex di ogni registrazione, per il testo
 * @returns {Array<{keys: string[], confirmation: object}>} una voce per chiamata
 */
function mergeConfirmations(members, opts = {}) {
  const lots = opts.lots instanceof Map ? opts.lots : new Map();
  const byCall = new Map();
  for (const m of members || []) {
    const c = m.confirmation;
    const k = `${bareOrder(c.OrderID)}|${String(c.ConfirmationUnit || '').trim()}`;
    if (!byCall.has(k)) byCall.set(k, []);
    byCall.get(k).push(m);
  }

  const calls = [];
  for (const group of byCall.values()) {
    const base = group[0].confirmation;
    const total = group.reduce((acc, m) => acc + thousandths(m.confirmation.ConfirmationYieldQuantity), 0);
    const merged = { ...base, ConfirmationYieldQuantity: total / 1000 };
    merged.ConfirmationText = groupText(group, group.map((m) => lots.get(m.key)), base.OrderID);

    let latest = null;
    for (const m of group) {
      const s = stampOf(m.confirmation);
      if (s && (!latest || s > latest.s)) latest = { s, c: m.confirmation };
    }
    if (latest) {
      merged.ConfirmationExternalEntryDate = latest.c.ConfirmationExternalEntryDate;
      merged.ConfirmationExternalEntryTime = latest.c.ConfirmationExternalEntryTime;
    } else {
      delete merged.ConfirmationExternalEntryDate;
      delete merged.ConfirmationExternalEntryTime;
    }
    calls.push({ keys: group.map((m) => m.key), confirmation: merged });
  }
  return calls;
}

/**
 * Il tetto di documenti per run (`PLEX_CONF_MAX_PER_RUN`). FUNZIONE PURA.
 *
 * Le regole di prima restano: si taglia su confine di REGISTRAZIONE (spedire l'uscita merci e
 * rimandare il versamento lascerebbe l'ordine sbilanciato), e se il tetto e' piu' piccolo della
 * prima registrazione la si manda INTERA, sforando di proposito ([MATDOC-FIX]: un taglio a zero
 * fermava il flusso in silenzio).
 *
 * [CONF-GROUP] La regola nuova: le conferme di un ordine gia' incluso si portano DENTRO, anche oltre
 * il tetto. Un ordine spezzato fra due run manderebbe due conferme sullo stesso ordine, cioe' proprio
 * cio' che il raggruppamento esiste per evitare.
 *
 * @param {object[]} candidates in ordine di (PlexEntryId, DocSeq)
 * @param {number} max il tetto; <= 0 = nessun tetto
 * @param {number} confSeq il `DocSeq` della conferma
 * @returns {{kept: object[], total: number, overflow: number, pulled: number}} `overflow` e' quanto
 *   la prima registrazione sfora il tetto, `pulled` quante conferme sono entrate per non spezzare
 *   un ordine
 */
function cutCandidates(candidates, max, confSeq) {
  const list = candidates || [];
  const total = list.length;
  if (!(max > 0) || total <= max) return { kept: list, total, overflow: 0, pulled: 0 };

  let cut = max;
  while (cut > 0 && list[cut] && list[cut].PlexEntryId === list[cut - 1].PlexEntryId) cut--;
  let overflow = 0;
  if (cut === 0) {
    cut = 1;
    while (list[cut] && list[cut].PlexEntryId === list[0].PlexEntryId) cut++;
    overflow = cut - max;
  }

  const kept = list.slice(0, cut);
  const orders = new Set(kept.filter((d) => d.DocSeq === confSeq).map(groupKey));
  let pulled = 0;
  for (const d of list.slice(cut)) {
    if (d.DocSeq === confSeq && orders.has(groupKey(d))) {
      kept.push(d);
      pulled++;
    }
  }
  return { kept, total, overflow, pulled };
}

module.exports = {
  LEN_CONF_TEXT,
  groupKey,
  bareOrder,
  isSummable,
  mergeConfirmations,
  cutCandidates
};

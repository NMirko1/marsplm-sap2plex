/**
 * Invio del recap di fine job ai destinatari configurati (ZJobNotifyRecipient).
 *
 * Regola centrale: UNA mail per DESTINATARIO, non per plant. Se lo stesso indirizzo e'
 * configurato su piu' plant riceve una sola mail con UN allegato per plant, contenente i
 * soli dati dei plant che lo riguardano.
 *
 * Condizione di invio, per destinatario (ZJobNotifyRecipient.NotifyMode):
 *   ALWAYS     - sempre
 *   ON_ERROR   - solo se il run ha errori o warning
 *   ON_FAILURE - solo se il job e' fallito (fatale / scope degradato / retry esauriti)
 * Se lo stesso indirizzo compare su piu' plant con modi diversi vince il piu' permissivo:
 * la mail e' una sola, quindi la precedenza deve essere deterministica.
 *
 * PERCHE' I DESTINATARI SI CERCANO PER JobCode E NON PER PLANT DEL RUN
 * Ogni job risolve i plant tramite getUsablePlants(): ogni run e' un processo nuovo, quindi
 * la cache licenze e' sempre vuota e la grace di 96h non puo' mai applicarsi in un job. Se
 * MARS_LICENSE e' irraggiungibile la lista plant e' VUOTA e oggi tutti i job escono 0 in
 * silenzio. Filtrando i destinatari sui plant del run, un'interruzione totale non
 * avviserebbe nessuno: si filtra quindi solo per JobCode, e l'intersezione dei plant decide
 * gli ALLEGATI, non il diritto a ricevere la mail.
 *
 * Gli allegati sono costruiti UNA VOLTA PER PLANT PER RUN (memoizzati) e i destinatari sono
 * serviti IN SEQUENZA: N destinatari x M plant significherebbero altrimenti N*M generazioni
 * di PDF+CSV, e ogni allegato base64 e' una singola stringa JS (9 MB grezzi diventano ~12 MB
 * base64 piu' la copia di JSON.stringify piu' quella di axios).
 */

'use strict';

const { NOTIFY_MODE_RANK, PLANT_NA, RUN_STATUS_LABELS, jobLabel } = require('./jobCodes');
const { buildCsv, buildPdf } = require('./reportBuilder');
const { sendMail, readMailConfig, resolveTransport, closeMailTransport } = require('./mailer');
const { E_RUN_HDR, E_RUN_POS, E_RUN_MAIL, cut } = require('./jobSummary');

const POS_PAGE = 5000;

const CSV_COLUMNS = [
  { key: 'Counter', label: 'N.' },
  { key: 'Plant', label: 'Plant' },
  { key: 'ObjectType', label: 'Tipo' },
  { key: 'ObjectKey', label: 'Chiave' },
  { key: 'ObjectKey2', label: 'Chiave 2' },
  { key: 'Status', label: 'Esito' },
  { key: 'Message', label: 'Messaggio' },
  { key: 'LogRef', label: 'Log di dettaglio' }
];

const PDF_COLUMNS = [
  { key: 'Counter', label: 'N.', width: 35 },
  { key: 'ObjectKey', label: 'Chiave', width: 150 },
  { key: 'ObjectKey2', label: 'Chiave 2', width: 130 },
  { key: 'Status', label: 'Esito', width: 40 },
  { key: 'Message', label: 'Messaggio', width: '*' }
];

// [JOB-TRIGGER] Le etichette sono passate in jobCodes.js quando la 0032 ne ha avuto bisogno per il
// messaggio mandato al Job Scheduler BTP: la stessa persona legge il recap mail e il dashboard
// dello scheduler, e due copie di questa mappa divergerebbero. Punto unico.
const STATUS_LABEL = RUN_STATUS_LABELS;

// [LOG-MSG-I18N] Il testo delle righe si RENDE qui (feature 0031), e non arriva già reso: questo
// modulo legge da `db` e non da LogService, quindi l'`after('READ')` che traduce alla lettura non lo
// tocca. Senza questa resa, mail, CSV e PDF mostrerebbero lo `Message` salvato — che è lo snapshot,
// non un errore, ma smetterebbe di seguire i segmenti se un giorno divergessero.
//
// LA LINGUA È L'ITALIANO (SNAPSHOT_LOCALE) E NON QUELLA DI CHI LEGGE, ed è una scelta: il
// destinatario di una mail non ha una lingua dichiarata da nessuna parte — `ZJobNotifyRecipient` ha
// plant, job, indirizzo e modo di notifica — e la cornice di questi allegati (intestazioni CSV,
// colonne del PDF, oggetto) è italiana cablata. Renderle in inglese darebbe un PDF metà e metà.
const logMsg = require('./logMessage');
const i18nMessages = require('./i18nMessages');

/**
 * Il testo di una riga di recap: dai segmenti se ci sono, altrimenti lo snapshot salvato.
 *
 * Il ripiego non è pigrizia: le righe scritte prima della 0031 non hanno segmenti, e mostrare il
 * loro `Message` è esattamente ciò che si deve fare (stessa regola di `renderLogMessage`).
 */
const rowText = (row, textField = 'Message', jsonField = 'MessageJson') => {
  const segments = logMsg.unpack(row && row[jsonField]);
  if (!segments.length) return (row && row[textField]) || '';
  return i18nMessages.render(segments, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE);
};

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Legge tutte le righe POS del run, paginando per non tenere un solo statement gigante. */
async function loadPos(db, runId, maxRows) {
  const rows = [];
  for (let offset = 0; ; offset += POS_PAGE) {
    const page = await db.run(
      SELECT.from(E_RUN_POS).where({ RunId: runId }).orderBy('Counter').limit(POS_PAGE, offset)
    ) || [];
    // [LOG-MSG-I18N] Il testo si rende SUBITO, una volta per riga: da qui le righe passano al CSV,
    // al PDF e alla tabella HTML, e renderlo in tre punti diversi sarebbe la copia che diverge.
    rows.push(...page.map((r) => ({ ...r, Message: rowText(r) })));
    if (page.length < POS_PAGE) break;
    if (maxRows && rows.length >= maxRows) break;
  }
  return rows;
}

/**
 * Raggruppa le righe di ZJobNotifyRecipient per indirizzo.
 * @returns {Array<{email:string, plants:string[], notifyMode:string}>}
 */
function groupByRecipient(recipients) {
  const byEmail = new Map();
  for (const r of recipients) {
    if (!r || !r.Email) continue;
    const email = String(r.Email).trim().toLowerCase();
    if (!email) continue;
    const cur = byEmail.get(email) || { email, plants: new Set(), notifyMode: 'ON_FAILURE' };
    if (r.Plant) cur.plants.add(r.Plant);
    const mode = r.NotifyMode || 'ALWAYS';
    // Vince il piu' permissivo.
    if ((NOTIFY_MODE_RANK[mode] || 0) > (NOTIFY_MODE_RANK[cur.notifyMode] || 0)) cur.notifyMode = mode;
    byEmail.set(email, cur);
  }
  return [...byEmail.values()]
    .map((r) => ({ email: r.email, plants: [...r.plants].sort(), notifyMode: r.notifyMode }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Decide se un destinatario va avvisato.
 * @param {string} notifyMode
 * @param {object} hdr riga ZJobRunHDR del run
 */
function shouldNotify(notifyMode, hdr) {
  const failed = (hdr.TotalFailed || 0) > 0;
  const warned = (hdr.TotalWarning || 0) > 0;
  const exhausted = (hdr.TotalExhausted || 0) > 0;
  const jobFailed = hdr.Status === 'E' || hdr.Status === 'N' || !!hdr.FatalMessage || exhausted;
  if (notifyMode === 'ALWAYS') return true;
  // Un run chiuso in attenzione E' un'anomalia per chi ha chiesto di essere avvisato sulle
  // anomalie, anche quando l'attenzione viene da una degradazione di scope() e non da un record
  // fallito: senza questa condizione una voce di scope resterebbe «confinata in un dettaglio che
  // nessuno apre» (BR-23 della 0014), ed e' cio' che accade oggi per le degradazioni dei 3 job.
  if (notifyMode === 'ON_ERROR') return failed || warned || jobFailed || hdr.Status === 'W';
  if (notifyMode === 'ON_FAILURE') return jobFailed;
  return false;
}

/** Contatori per plant, ricavati dalle righe POS (nessuna tabella per-plant da mantenere). */
function countByPlant(rows) {
  const map = new Map();
  for (const r of rows) {
    const p = r.Plant || PLANT_NA;
    const c = map.get(p) || { ok: 0, warning: 0, failed: 0, exhausted: 0, total: 0 };
    c.total += 1;
    if (r.Status === 'S') c.ok += 1;
    else if (r.Status === 'W') c.warning += 1;
    else if (r.Status === 'X') c.exhausted += 1;
    else c.failed += 1;
    map.set(p, c);
  }
  return map;
}

/**
 * Costruisce PDF + CSV per un plant. Memoizzato dal chiamante.
 * Il PDF contiene TUTTE le righe se stanno nel cap - cosi' su un run normale il destinatario
 * vede davvero cosa e' stato inviato e con quale esito - altrimenti solo le anomalie.
 */
async function buildPlantAttachments({ plant, rows, hdr, cfg }) {
  const attachments = [];
  const stamp = String(hdr.StartedAt || '').replace(/[^0-9]/g, '').slice(0, 14);
  const base = `recap_${hdr.JobCode}_${plant.replace(/[^A-Za-z0-9]/g, '')}_${stamp}`;
  const counts = countByPlant(rows).get(plant) || { ok: 0, warning: 0, failed: 0, exhausted: 0, total: rows.length };

  // --- CSV: il record completo ---
  const csvRows = rows.slice(0, cfg.csvMaxRows);
  const footer = [];
  if (rows.length > csvRows.length) {
    footer.push(`# TRONCATO: ${rows.length} righe totali, mostrate ${csvRows.length}.`);
  }
  attachments.push({
    filename: `${base}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: buildCsv(csvRows, CSV_COLUMNS, { footer })
  });

  // --- PDF: riepilogo ---
  if (cfg.pdf) {
    const anomalies = rows.filter((r) => r.Status !== 'S');
    const all = rows.length <= cfg.pdfMaxRows;
    const pdfRows = (all ? rows : anomalies).slice(0, cfg.pdfMaxRows);
    const hidden = (all ? rows.length : anomalies.length) - pdfRows.length;
    const note = all
      ? null
      : `Elencate le sole righe con anomalia${hidden > 0 ? `, prime ${pdfRows.length} di ${anomalies.length}` : ''}.`
        + ' Il dettaglio completo e\' nel CSV allegato.';
    try {
      attachments.push({
        filename: `${base}.pdf`,
        contentType: 'application/pdf',
        content: await buildPdf({
          title: `Recap ${jobLabel(hdr.JobCode)} - Plant ${plant}`,
          meta: {
            'Run ID': hdr.RunId,
            Job: `${hdr.JobCode} - ${jobLabel(hdr.JobCode)}`,
            Plant: plant,
            Inizio: hdr.StartedAt,
            Fine: hdr.FinishedAt || '(non concluso)',
            Esito: `${hdr.Status} - ${STATUS_LABEL[hdr.Status] || hdr.Status}`
          },
          counters: {
            Totale: counts.total, OK: counts.ok, Warning: counts.warning,
            Errori: counts.failed, Permanenti: counts.exhausted
          },
          columns: PDF_COLUMNS,
          rows: pdfRows,
          footerNote: note
        })
      });
    } catch (e) {
      // Degrado: meglio un recap con il solo CSV che nessun recap.
      console.error(`>>> [MAIL] generazione PDF per ${plant} fallita, si allega solo il CSV: ${e.message}`);
    }
  }
  return attachments;
}

/** Corpo HTML: contatori del run, per plant, e la tabella delle sole anomalie. */
function buildHtmlBody({ hdr, plants, rowsByPlant, cfg, degradations }) {
  // [LOG-MSG-I18N] La testata porta DUE testi indipendenti e due colonne di segmenti: il riassunto
  // del run e l'errore che l'ha ucciso. Si rendono qui, come le righe (feature 0031).
  const headText = rowText(hdr, 'Message', 'MessageJson');
  const fatalText = rowText(hdr, 'FatalMessage', 'FatalMessageJson');
  const anomalies = [];
  for (const p of plants) {
    for (const r of (rowsByPlant.get(p) || [])) {
      if (r.Status !== 'S') anomalies.push(r);
    }
  }
  const shown = anomalies.slice(0, 100);

  const plantRows = plants.map((p) => {
    const c = countByPlant(rowsByPlant.get(p) || []).get(p)
      || { total: 0, ok: 0, warning: 0, failed: 0, exhausted: 0 };
    return `<tr><td>${esc(p)}</td><td align="right">${c.total}</td><td align="right">${c.ok}</td>`
      + `<td align="right">${c.warning}</td><td align="right">${c.failed}</td><td align="right">${c.exhausted}</td></tr>`;
  }).join('');

  const anomalyRows = shown.map((r) => `<tr>`
    + `<td>${esc(r.Plant)}</td><td>${esc(r.ObjectKey)}</td><td>${esc(r.ObjectKey2 || '')}</td>`
    + `<td>${esc(r.Status)}</td><td>${esc(r.Message || '')}</td></tr>`).join('');

  return `<html><body style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333">
<h2 style="margin-bottom:4px">Recap ${esc(jobLabel(hdr.JobCode))}</h2>
<p style="margin:0 0 12px 0;color:#666">
Run <code>${esc(hdr.RunId)}</code> &middot; inizio ${esc(hdr.StartedAt)} &middot;
fine ${esc(hdr.FinishedAt || '(non concluso)')} &middot;
esito <b>${esc(hdr.Status)} - ${esc(STATUS_LABEL[hdr.Status] || hdr.Status)}</b>
</p>
${fatalText ? `<p style="color:#a00"><b>Errore fatale:</b> ${esc(fatalText)}</p>` : ''}
${headText ? `<p>${esc(headText)}</p>` : ''}

<h3 style="margin-bottom:4px">Totali del run</h3>
<table cellpadding="5" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#ccc">
<tr style="background:#eee"><th>Trattati</th><th>OK</th><th>Warning</th><th>Errori</th><th>Permanenti</th><th>Saltati</th></tr>
<tr><td align="right">${hdr.TotalProcessed || 0}</td><td align="right">${hdr.TotalOk || 0}</td>
<td align="right">${hdr.TotalWarning || 0}</td><td align="right">${hdr.TotalFailed || 0}</td>
<td align="right">${hdr.TotalExhausted || 0}</td><td align="right">${hdr.TotalSkipped || 0}</td></tr>
</table>

<h3 style="margin-bottom:4px">Per plant di sua competenza</h3>
<table cellpadding="5" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#ccc">
<tr style="background:#eee"><th>Plant</th><th>Righe</th><th>OK</th><th>Warning</th><th>Errori</th><th>Permanenti</th></tr>
${plantRows || '<tr><td colspan="6"><i>nessun record per i plant configurati</i></td></tr>'}
</table>

<h3 style="margin-bottom:4px">Anomalie${anomalies.length > shown.length ? ` (prime ${shown.length} di ${anomalies.length})` : ''}</h3>
${anomalyRows
    ? `<table cellpadding="5" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#ccc">
<tr style="background:#eee"><th>Plant</th><th>Chiave</th><th>Chiave 2</th><th>Esito</th><th>Messaggio</th></tr>
${anomalyRows}</table>`
    : '<p><i>Nessuna anomalia.</i></p>'}

${degradations.length
    ? `<p style="color:#a60"><b>Nota sugli allegati:</b><br/>${degradations.map(esc).join('<br/>')}</p>`
    : ''}
<p style="color:#666;font-size:11px;margin-top:18px">
Dettaglio completo: <code>/odata/v4/log/ZJobRunPOS?$filter=RunId eq '${esc(hdr.RunId)}'&amp;$orderby=Counter</code>
${cfg.logBaseUrl ? `<br/>${esc(cfg.logBaseUrl)}/odata/v4/log/ZJobRunPOS?$filter=RunId eq '${esc(hdr.RunId)}'` : ''}
<br/>Messaggio generato automaticamente da MARSPLM SAP2PLEX. Non rispondere a questo indirizzo.
</p></body></html>`;
}

/**
 * Applica la scala di degrado sulla dimensione: si scartano prima i CSV (l'archivio completo
 * resta su ZJobRunPOS), poi tutto. Ogni passo viene dichiarato nel corpo mail e in MailMessage.
 */
function applySizeLadder(attachments, cfg) {
  const degradations = [];
  let kept = attachments.filter((a) => {
    if (a.content.length > cfg.maxAttachmentBytes) {
      degradations.push(`allegato ${a.filename} omesso: ${a.content.length} byte oltre il limite di ${cfg.maxAttachmentBytes}`);
      return false;
    }
    return true;
  });

  const total = () => kept.reduce((s, a) => s + a.content.length, 0);
  if (total() > cfg.maxTotalBytes) {
    const before = total();
    kept = kept.filter((a) => !a.filename.endsWith('.csv'));
    degradations.push(`CSV omessi per dimensione totale (${before} byte oltre ${cfg.maxTotalBytes}); il dettaglio resta consultabile su ZJobRunPOS`);
  }
  if (total() > cfg.maxTotalBytes) {
    degradations.push(`tutti gli allegati omessi per dimensione totale (${total()} byte)`);
    kept = [];
  }
  for (const d of degradations) console.warn(`>>> [MAIL] degrado: ${d}`);
  return { attachments: kept, degradations };
}

/**
 * Invia il recap del run a tutti i destinatari che lo meritano e registra l'esito su
 * ZJobRunMail + ZJobRunHDR.MailStatus/MailMessage. NON lancia.
 *
 * @param {{db:object, runId:string, jobCode:string, summary?:object}} ctx
 */
async function notify({ db, runId, jobCode, summary }) {
  const cfg = readMailConfig();
  cfg.logBaseUrl = process.env.MAIL_LOG_BASE_URL || (() => {
    try {
      const app = JSON.parse(process.env.VCAP_APPLICATION || '{}');
      const uri = (app.application_uris || [])[0];
      return uri ? `https://${uri}` : null;
    } catch (e) { return null; }
  })();
  const budgetMs = parseInt(process.env.MAIL_BUDGET_MS || '120000', 10);
  const startedMs = Date.now();

  const hdr = await db.run(SELECT.one.from(E_RUN_HDR).where({ RunId: runId }));
  if (!hdr) {
    console.error(`>>> [MAIL] run ${runId} non trovato su ZJobRunHDR: recap non inviato`);
    return { mailStatus: 'E', mailMessage: 'run header non trovato', results: [] };
  }

  const configured = (summary && summary.recipients && summary.recipients().length)
    ? summary.recipients()
    : (await db.run(SELECT.from(`avvaleplm.marsplm.sap2plex.ZJobNotifyRecipient`)
        .where({ JobCode: jobCode, IsActive: true })) || []);

  const groups = groupByRecipient(configured);
  if (!groups.length) {
    console.log(`>>> [MAIL] nessun destinatario configurato per ${jobCode}: recap non inviato`);
    await writeMailStatus(db, runId, 'N', 'nessun destinatario configurato');
    return { mailStatus: 'N', mailMessage: 'nessun destinatario configurato', results: [] };
  }

  const posRows = await loadPos(db, runId);
  const rowsByPlant = new Map();
  for (const r of posRows) {
    const p = r.Plant || PLANT_NA;
    if (!rowsByPlant.has(p)) rowsByPlant.set(p, []);
    rowsByPlant.get(p).push(r);
  }

  // Memoizzazione: PDF+CSV costruiti una volta per plant, non una per (destinatario, plant).
  const attachCache = new Map();
  async function attachmentsFor(plant) {
    if (!attachCache.has(plant)) {
      attachCache.set(plant, await buildPlantAttachments({
        plant, rows: rowsByPlant.get(plant) || [], hdr, cfg
      }));
    }
    return attachCache.get(plant);
  }

  const transport = resolveTransport(cfg);
  const results = [];
  let seq = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  // In sequenza: limita il picco di memoria e la concorrenza contro rate limit ignoti.
  // Il finally chiude il transporter SMTP in pool: e' igiene e non correttezza (i job terminano
  // con process.exit), ma va fatto anche se il ciclo esce per un'eccezione. Vedi
  // closeMailTransport() in mailer.js; per gli altri trasporti e' un no-op.
  try {
    for (const g of groups) {
      seq += 1;
      const mailRow = {
        RunId: runId, Email: cut(g.email, 255), Plants: cut(g.plants.join(','), 200),
        NotifyMode: cut(g.notifyMode, 10), SentAt: new Date().toISOString(),
        Status: 'K', Message: null, MessageJson: null, AttachCount: 0, AttachBytes: 0
      };
      // [LOG-MSG-I18N] I tre esiti di un invio come SEGMENTI (feature 0031): la riga si legge dalla
      // schermata delle esecuzioni, e «chi non ha ricevuto e perche'» e' la prima domanda del
      // supporto. Il testo resta lo snapshot italiano, come per le altre colonne.
      const setMsg = (segments) => {
        const segs = logMsg.normalize(segments);
        mailRow.Message = cut(
          i18nMessages.render(segs, i18nMessages.COCKPIT_APP, i18nMessages.SNAPSHOT_LOCALE), 255
        );
        mailRow.MessageJson = logMsg.pack(segs);
      };

      if (!shouldNotify(g.notifyMode, hdr)) {
        skipped += 1;
        setMsg([logMsg.seg('logMailSkipped', g.notifyMode)]);
        results.push(mailRow);
        console.log(`>>> [MAIL] ${g.email}: saltata (${g.notifyMode})`);
        continue;
      }

      if (Date.now() - startedMs > budgetMs) {
        failed += 1;
        mailRow.Status = 'E';
        setMsg([logMsg.seg('logMailBudgetExhausted')]);
        results.push(mailRow);
        console.error(`>>> [MAIL] ${g.email}: budget mail esaurito, invio non tentato`);
        continue;
      }

      // Plant di competenza + '#NA': le righe senza plant risolvibile devono raggiungere
      // qualcuno, altrimenti sparirebbero.
      const relevant = g.plants.filter((p) => rowsByPlant.has(p));
      if (rowsByPlant.has(PLANT_NA)) relevant.push(PLANT_NA);

      let attachments = [];
      for (const p of relevant) attachments = attachments.concat(await attachmentsFor(p));
      const laddered = applySizeLadder(attachments, cfg);

      const html = buildHtmlBody({
        hdr, plants: relevant, rowsByPlant, cfg, degradations: laddered.degradations
      });
      const subject = `[MARSPLM] ${jobLabel(hdr.JobCode)} - ${STATUS_LABEL[hdr.Status] || hdr.Status}`
        + ` - ${hdr.TotalOk || 0} ok / ${hdr.TotalFailed || 0} errori`
        + (relevant.length ? ` - ${relevant.join(', ')}` : '');

      const res = await sendMail({
        to: g.email, subject, html,
        text: `Recap ${jobLabel(hdr.JobCode)} run ${hdr.RunId}: esito ${hdr.Status}, `
          + `${hdr.TotalOk || 0} ok, ${hdr.TotalWarning || 0} warning, ${hdr.TotalFailed || 0} errori.`,
        attachments: laddered.attachments,
        runId, seq
      });

      mailRow.Status = res.ok ? 'S' : 'E';
      // Il messaggio del trasporto e' di terzi (nodemailer, il relay SMTP): non si traduce.
      setMsg(res.message ? [logMsg.technical(res.message)] : []);
      mailRow.AttachCount = laddered.attachments.length;
      mailRow.AttachBytes = laddered.attachments.reduce((s, a) => s + a.content.length, 0);
      if (res.ok) sent += 1; else failed += 1;
      results.push(mailRow);
    }
  } finally {
    await closeMailTransport();
  }

  try {
    if (results.length) await db.run(INSERT.into(E_RUN_MAIL).entries(results));
  } catch (e) {
    console.error(`>>> [MAIL] scrittura ZJobRunMail fallita (non-blocking): ${e.message}`);
  }

  let mailStatus;
  if (sent === 0 && failed === 0) mailStatus = 'N';
  else if (failed === 0) mailStatus = 'S';
  else if (sent > 0) mailStatus = 'W';
  else mailStatus = 'E';

  const mailMessage = cut(
    `transport ${transport}: inviate ${sent}, fallite ${failed}, saltate ${skipped}`, 255
  );
  await writeMailStatus(db, runId, mailStatus, mailMessage);
  console.log(`>>> [MAIL] run ${runId}: ${mailMessage}`);
  return { mailStatus, mailMessage, results };
}

async function writeMailStatus(db, runId, mailStatus, mailMessage) {
  try {
    await db.run(UPDATE(E_RUN_HDR).set({ MailStatus: mailStatus, MailMessage: cut(mailMessage, 255) })
      .where({ RunId: runId }));
  } catch (e) {
    console.error(`>>> [MAIL] aggiornamento MailStatus fallito (non-blocking): ${e.message}`);
  }
}

/**
 * Ultima risorsa quando il bootstrap CAP fallisce: senza modello non si possono leggere i
 * destinatari ne' scrivere il run log, quindi l'unico indirizzo possibile e' quello in env.
 * Senza MAIL_FALLBACK_TO questo caso resta silenzioso, esattamente come oggi.
 */
async function sendBootstrapFailureMail({ jobCode, runId, error }) {
  const to = (process.env.MAIL_FALLBACK_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) {
    console.error('>>> [MAIL] bootstrap fallito e MAIL_FALLBACK_TO non impostata: nessuna notifica possibile');
    return;
  }
  const subject = `[MARSPLM] ${jobLabel(jobCode)} - AVVIO FALLITO`;
  const html = `<html><body style="font-family:Arial,sans-serif">
<h2>Avvio del job fallito</h2>
<p>Job <b>${esc(jobCode)}</b>, run <code>${esc(runId)}</code>.</p>
<p>Il bootstrap CAP non e' andato a buon fine: non e' stato possibile scrivere il run log
ne' leggere la lista dei destinatari configurati.</p>
<pre>${esc((error && error.message) || String(error))}</pre>
</body></html>`;
  let seq = 0;
  try {
    for (const addr of to) {
      seq += 1;
      await sendMail({ to: addr, subject, html, text: subject, attachments: [], runId, seq });
    }
  } finally {
    await closeMailTransport();
  }
}

module.exports = {
  notify, sendBootstrapFailureMail,
  groupByRecipient, shouldNotify, countByPlant, applySizeLadder,
  CSV_COLUMNS, PDF_COLUMNS
};

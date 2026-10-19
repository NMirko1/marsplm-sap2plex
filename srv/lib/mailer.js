/**
 * Invio mail per il recap di fine job.
 *
 * L'API dietro la destination MARS_MAIL NON e' ancora nota: tutto cio' che dipende da essa
 * (host, path, metodo, auth, nomi dei campi del payload, CSRF, cap sugli allegati) e'
 * configurazione sotto cds.requires.MARS_MAIL.mail, sullo stesso schema del blocco
 * `routingList` di sap_s4_OP_API_PRODUCTION_ROUTING_0003_v3 in package.json.
 * L'unico punto di codice da toccare, se il payload fosse nidificato (Microsoft Graph,
 * SendGrid) invece che piatto, e' buildPayload().
 *
 * Trasporti (env MAIL_TRANSPORT, altrimenti cds.env.requires.MARS_MAIL.mail.transport):
 *   smtp        - [SMTP-MAIL] collegamento diretto a un server SMTP, via nodemailer
 *   destination - POST JSON sulla destination MARS_MAIL       (default in produzione)
 *   file        - scrive tutto sotto _out/mail/<runId>/       (default in development/hybrid)
 *   console     - una riga di log, nessun allegato            (CI)
 *   off         - non invia nulla, ma lo dichiara a voce alta (opt-out esplicito)
 *
 * Il trasporto `file` e' quello che rende la feature testabile end-to-end PRIMA che
 * MARS_MAIL esista. NON va mai abilitato in produzione: _out/mail/** contiene indirizzi
 * e-mail e il dettaglio completo dei record.
 *
 * sendMail() NON lancia mai: il verdetto finisce su ZJobRunMail e ZJobRunHDR.MailStatus,
 * cosi' un fallimento e' visibile invece che silenzioso (stessa filosofia di srv/license.js).
 *
 * NON si loggano mai payload, header o e.response.data: le API mail rieccheggiano
 * abitualmente la richiesta - inclusa la API key - nei body di errore 4xx. Sul ramo SMTP
 * vale identico: la configurazione si logga solo attraverso redactSmtpConfig(), e il testo
 * di un rifiuto passa da classifySmtpError(err, secretsOf(config)) - perche' quel testo
 * finisce su ZJobRunMail, che a sua volta esce dalla piattaforma in un allegato (DEC-10).
 *
 * Le REGOLE del ramo SMTP - precedenza delle sorgenti, validazione, classificazione degli
 * errori, forma della busta - stanno nel modulo puro srv/lib/smtpRules.js, con il loro test.
 * Qui resta solo cio' che tocca il mondo: getDestination, process.env, nodemailer.
 * Vedi DEC-93; perimetro: grep -rn "SMTP-MAIL".
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
// Puro, nessuna dipendenza: si carica sempre. nodemailer invece si carica pigro, vedi getTransporter().
const smtpRules = require('./smtpRules');

const DEFAULTS = {
  transport: null,             // risolto per profilo, vedi resolveTransport()
  template: 'flat',
  path: '/v1/mail/send',
  method: 'POST',
  requestTimeout: 20000,
  fetchCsrfToken: false,
  from: 'noreply@marsplm.com',
  maxAttachmentBytes: 4000000,
  maxTotalBytes: 9000000,
  pdf: true,
  pdfMaxRows: 500,
  csvMaxRows: 20000,
  fields: {
    to: 'to', cc: 'cc', from: 'from',
    subject: 'subject', html: 'html', text: 'text',
    attachments: 'attachments',
    attachmentName: 'filename',
    attachmentContentType: 'contentType',
    attachmentContent: 'contentBase64'
  },
  // [SMTP-MAIL] Tutto null = «non impostato», MAI false: la differenza fra un campo assente e
  // un campo spento a mano e' cio' su cui si regge la derivazione della cifratura dalla porta.
  smtp: {
    destination: 'MARS_MAIL',   // quale destination leggere, se le env non bastano
    host: null,
    port: null,
    secure: null,               // cifratura implicita (SMTPS, di solito 465)
    starttls: null,             // in chiaro e poi promossa (di solito 587)
    user: null,
    pass: null,
    auth: null,                 // false = il relay autorizza per IP
    from: null,                 // mittente autorizzato dal relay; ripiego su cfg.from
    envelopeFrom: null,         // Return-Path, se SPF pretende un indirizzo diverso dal From
    replyTo: null,
    name: null,                 // nome annunciato nell'EHLO
    pool: true,
    maxMessages: 100,
    timeoutMs: 20000,
    tlsRejectUnauthorized: true,
    allowPlaintext: false,
    maxMessageBytes: null       // limite del relay, quando noto: serve ad avvisare prima di spedire
  }
};

const OUT_DIR = path.join(process.cwd(), '_out', 'mail');

/**
 * [SMTP-MAIL] Le variabili MAIL_SMTP_*, raccolte come SORGENTE a se' stante.
 *
 * Non si fondono qui dentro cfg.smtp: la fusione e la precedenza sono di resolveSmtpConfig(),
 * che deve poter dire CHI ha vinto per ogni campo. Qui si distingue solo «impostata» da «vuota»,
 * con la guardia set() di materialDocPost.js: una variabile svuotata a mano non deve sovrascrivere
 * la destination con il nulla.
 */
function readSmtpEnv() {
  const set = (name) => process.env[name] !== undefined && String(process.env[name]).trim() !== '';
  const out = {};
  const map = {
    MAIL_SMTP_DESTINATION: 'destination',
    MAIL_SMTP_HOST: 'host',
    MAIL_SMTP_PORT: 'port',
    MAIL_SMTP_SECURE: 'secure',
    MAIL_SMTP_STARTTLS: 'starttls',
    MAIL_SMTP_USER: 'user',
    MAIL_SMTP_PASSWORD: 'pass',
    MAIL_SMTP_AUTH: 'auth',
    MAIL_SMTP_FROM: 'from',
    MAIL_SMTP_ENVELOPE_FROM: 'envelopeFrom',
    MAIL_SMTP_REPLY_TO: 'replyTo',
    MAIL_SMTP_NAME: 'name',
    MAIL_SMTP_POOL: 'pool',
    MAIL_SMTP_MAX_MESSAGES: 'maxMessages',
    MAIL_SMTP_TIMEOUT_MS: 'timeoutMs',
    MAIL_SMTP_TLS_REJECT_UNAUTHORIZED: 'tlsRejectUnauthorized',
    MAIL_SMTP_ALLOW_PLAINTEXT: 'allowPlaintext',
    MAIL_SMTP_MAX_MESSAGE_BYTES: 'maxMessageBytes'
  };
  for (const [envName, field] of Object.entries(map)) {
    // La password NON si fa trim: uno spazio in coda potrebbe farne parte.
    if (set(envName)) out[field] = field === 'pass' ? process.env[envName] : String(process.env[envName]).trim();
  }
  return out;
}

/** Config effettiva: DEFAULTS <- cds.requires.MARS_MAIL.mail <- override da env. */
function readMailConfig() {
  const fromCds = (cds.env.requires && cds.env.requires.MARS_MAIL && cds.env.requires.MARS_MAIL.mail) || {};
  const cfg = {
    ...DEFAULTS, ...fromCds,
    fields: { ...DEFAULTS.fields, ...(fromCds.fields || {}) },
    // Le due sorgenti SMTP restano separate: le fonde resolveSmtpConfig(), che deve sapere
    // da dove viene ogni campo. Qui si tengono solo accanto.
    smtp: { ...DEFAULTS.smtp },
    smtpFromCds: { ...(fromCds.smtp || {}) },
    smtpFromEnv: readSmtpEnv()
  };
  const num = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  if (process.env.MAIL_PATH) cfg.path = process.env.MAIL_PATH;
  if (process.env.MAIL_FROM) cfg.from = process.env.MAIL_FROM;
  if (process.env.MAIL_TIMEOUT_MS) cfg.requestTimeout = num(process.env.MAIL_TIMEOUT_MS, cfg.requestTimeout);
  if (process.env.MAIL_PDF) cfg.pdf = process.env.MAIL_PDF !== 'off' && process.env.MAIL_PDF !== 'false';
  if (process.env.MAIL_PDF_MAX_ROWS) cfg.pdfMaxRows = num(process.env.MAIL_PDF_MAX_ROWS, cfg.pdfMaxRows);
  if (process.env.MAIL_CSV_MAX_ROWS) cfg.csvMaxRows = num(process.env.MAIL_CSV_MAX_ROWS, cfg.csvMaxRows);
  if (process.env.MAIL_MAX_ATTACH_BYTES) cfg.maxAttachmentBytes = num(process.env.MAIL_MAX_ATTACH_BYTES, cfg.maxAttachmentBytes);
  if (process.env.MAIL_MAX_TOTAL_BYTES) cfg.maxTotalBytes = num(process.env.MAIL_MAX_TOTAL_BYTES, cfg.maxTotalBytes);
  return cfg;
}

/**
 * Bersaglio HTTP, stessa forma di resolveDestination() in srv/license.js: l'oggetto
 * ritornato e' passato tal quale come primo argomento di executeHttpRequest, quindi
 * dev e prod differiscono solo per cosa ritorna questa funzione.
 *
 * Ritorna null quando non risolvibile: NON degrada a console/off, altrimenti in produzione
 * una destination mancante diventerebbe silenzio.
 */
function resolveMailTarget() {
  const creds = (cds.env.requires && cds.env.requires.MARS_MAIL && cds.env.requires.MARS_MAIL.credentials) || {};
  if (process.env.MAIL_URL) return { url: process.env.MAIL_URL };
  if (creds.destination) return { destinationName: creds.destination };
  if (creds.url) return { url: creds.url };
  return null;
}

/** Trasporto effettivo. env MAIL_TRANSPORT vince sempre. */
function resolveTransport(cfg = readMailConfig()) {
  if (process.env.MAIL_TRANSPORT) return process.env.MAIL_TRANSPORT;
  if (cfg.transport) return cfg.transport;
  const profiles = (cds.env.profiles || []);
  if (profiles.includes('production') || process.env.NODE_ENV === 'production') return 'destination';
  return 'file';
}

/**
 * Payload per il template `flat`: un oggetto JSON piatto i cui NOMI di campo arrivano da
 * cfg.fields, cosi' adattarsi a un endpoint REST custom e' pura configurazione.
 *
 * Se MARS_MAIL si rivelasse Microsoft Graph o SendGrid il payload e' nidificato e non
 * esprimibile con una mappa di nomi; sono ~15 righe da aggiungere QUI, un ramo per template:
 *   graph:    { message: { subject, body:{contentType:'HTML',content}, toRecipients:[{emailAddress:{address}}],
 *               attachments:[{'@odata.type':'#microsoft.graph.fileAttachment', name, contentType, contentBytes}] },
 *               saveToSentItems:false }   -- cap 3 MB sull'INTERA richiesta
 *   sendgrid: { personalizations:[{to:[{email}]}], from:{email}, subject,
 *               content:[{type:'text/html', value}], attachments:[{content, filename, type, disposition:'attachment'}] }
 * SAP Alert Notification NON e' adattabile: non supporta allegati e i destinatari si
 * configurano nelle sue subscription, non nella richiesta.
 */
function buildPayload(msg, cfg) {
  const f = cfg.fields;
  const body = {
    [f.to]: msg.to,
    [f.from]: cfg.from,
    [f.subject]: msg.subject,
    [f.html]: msg.html,
    [f.text]: msg.text
  };
  if (msg.cc && msg.cc.length) body[f.cc] = msg.cc;
  if (msg.attachments && msg.attachments.length) {
    body[f.attachments] = msg.attachments.map((a) => ({
      [f.attachmentName]: a.filename,
      [f.attachmentContentType]: a.contentType,
      [f.attachmentContent]: a.content.toString('base64')
    }));
  }
  return body;
}

/** Nome file/cartella sicuro a partire da un indirizzo e-mail. */
function safeName(email) {
  return String(email || 'unknown').replace(/@/g, '_at_').replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Trasporto `file`: envelope JSON (SENZA base64, altrimenti il file diventa illeggibile),
 * corpo .html apribile nel browser, e i byte reali degli allegati in una sottocartella.
 */
async function sendViaFile(msg, cfg) {
  const dir = path.join(OUT_DIR, String(msg.runId || 'no-run'));
  const stem = `${String(msg.seq || 0).padStart(2, '0')}-${safeName(msg.to)}`;
  await fs.promises.mkdir(dir, { recursive: true });

  const envelope = {
    to: msg.to, cc: msg.cc || [], from: cfg.from,
    subject: msg.subject,
    runId: msg.runId,
    attachments: (msg.attachments || []).map((a) => ({
      filename: a.filename, contentType: a.contentType, bytes: a.content.length
    }))
  };
  await fs.promises.writeFile(path.join(dir, `${stem}.json`), JSON.stringify(envelope, null, 2), 'utf8');
  await fs.promises.writeFile(path.join(dir, `${stem}.html`), msg.html || msg.text || '', 'utf8');

  if (msg.attachments && msg.attachments.length) {
    const adir = path.join(dir, stem);
    await fs.promises.mkdir(adir, { recursive: true });
    for (const a of msg.attachments) {
      await fs.promises.writeFile(path.join(adir, a.filename), a.content);
    }
  }
  console.log(`>>> [MAIL] file -> ${path.join(dir, stem)} (${(msg.attachments || []).length} allegati)`);
  return { ok: true, status: null, message: `scritta in _out/mail/${msg.runId}`, transport: 'file' };
}

/** Trasporto `destination`: POST JSON via Cloud SDK. */
async function sendViaDestination(msg, cfg) {
  const dest = resolveMailTarget();
  if (!dest) {
    console.error('>>> [MAIL] ERRORE: destination/URL MARS_MAIL non configurata');
    return { ok: false, status: null, message: 'MARS_MAIL non configurata', transport: 'destination' };
  }
  const target = dest.url ? dest.url : `destination:${dest.destinationName}`;
  const nAtt = (msg.attachments || []).length;
  const bytes = (msg.attachments || []).reduce((s, a) => s + a.content.length, 0);
  console.log(`>>> [MAIL] ${cfg.method} ${target}${cfg.path} -> ${msg.to} (${nAtt} allegati, ${bytes} byte)`);

  try {
    const res = await executeHttpRequest(dest, {
      method: cfg.method,
      url: cfg.path,
      data: buildPayload(msg, cfg),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Il default del Cloud SDK e' timeout 0 = NESSUN timeout: senza questo un endpoint
      // che accetta la connessione e non risponde appenderebbe il job per sempre.
      // maxContentLength/maxBodyLength NON si impostano: axios li ha gia' a -1 (illimitato),
      // valorizzarli potrebbe solo introdurre un limite che oggi non esiste.
      timeout: cfg.requestTimeout
    }, {
      // Il Cloud SDK per ogni non-GET tenta di prendere un token CSRF (fino a 2 preflight
      // silenziosi, con i fallimenti inghiottiti come warning). srv/license.js non lo ha mai
      // incontrato perche' fa solo GET. Si tiene configurabile: un endpoint ABAP/Gateway lo richiede.
      fetchCsrfToken: !!cfg.fetchCsrfToken
    });
    console.log(`>>> [MAIL] ${msg.to}: HTTP ${res && res.status} - inviata`);
    return { ok: true, status: (res && res.status) || null, message: 'inviata', transport: 'destination' };
  } catch (e) {
    // Solo e.message: e.response.data conterrebbe l'eco della richiesta con la API key.
    const status = (e && e.response && e.response.status) || null;
    console.error(`>>> [MAIL] ${msg.to}: ERRORE${status ? ' HTTP ' + status : ''} - ${e.message}`);
    return { ok: false, status, message: String(e.message || 'errore invio').slice(0, 255), transport: 'destination' };
  }
}

// ---- [SMTP-MAIL] trasporto SMTP ---------------------------------------------------------------

let smtpConfigCache = null;        // esito di getSmtpConfig(), una volta per processo
let smtpWarned = false;            // il banner di configurazione mancante si stampa una volta sola
let transporterCache = null;       // { fingerprint, transporter }

/**
 * Le tre sorgenti della configurazione SMTP, raccolte dal mondo. Impura di proposito: e' il
 * confine oltre il quale c'e' solo smtpRules.js.
 *
 * La destination NON viene letta se le env forniscono gia' un host: evita un giro di rete e fa
 * funzionare lo sviluppo locale senza alcun binding al destination service.
 *
 * Un errore di lettura della destination non si propaga: diventa `destinationError`, e finisce
 * nel messaggio di NOT_CONFIGURED. «Non ho potuto guardare» e «non c'era» sono due cose diverse,
 * e chi legge il recap deve poterle distinguere.
 */
async function collectSmtpSources(cfg) {
  const fromEnv = cfg.smtpFromEnv || {};
  const fromCds = cfg.smtpFromCds || {};
  // Il mittente del canale (cfg.from / MAIL_FROM) e' il default anche per SMTP: un `from`
  // specifico del relay lo scavalca, ma non c'e' ragione di ripetere lo stesso indirizzo.
  const defaults = { ...(cfg.smtp || {}), from: cfg.from };

  const out = { defaults, fromCds, fromDestination: null, destinationError: null, fromEnv };

  // Se le env danno gia' l'host, la destination non si legge affatto: niente giro di rete, e lo
  // sviluppo locale funziona senza binding al destination service.
  if (fromEnv.host) return out;

  const destName = fromEnv.destination || fromCds.destination || defaults.destination;
  if (destName) {
    try {
      const dest = await getDestination({ destinationName: destName });
      if (dest) {
        out.fromDestination = smtpRules.mapDestinationToSmtp(dest.originalProperties, dest);
      } else {
        out.destinationError = `destination ${destName} non trovata`;
      }
    } catch (e) {
      out.destinationError = String((e && e.message) || e);
    }
  }
  return out;
}

/**
 * Configurazione SMTP risolta, memoizzata per processo: i job inviano N messaggi di fila e la
 * destination non cambia in mezzo a un run.
 */
async function getSmtpConfig(cfg) {
  if (smtpConfigCache) return smtpConfigCache;
  const sources = await collectSmtpSources(cfg);
  const resolved = smtpRules.resolveSmtpConfig(sources);
  if (resolved.ok) {
    // La riga passa da describeSmtpConfig(), che non stampa la password (DEC-10).
    console.log(`>>> [MAIL] SMTP risolto: ${resolved.message}`);
    for (const w of resolved.warnings) console.warn(`>>> [MAIL] SMTP attenzione: ${w}`);
  }
  smtpConfigCache = resolved;
  return resolved;
}

/** Il banner della configurazione mancante: una volta per processo, non una per destinatario. */
function warnSmtpMisconfiguredOnce(resolved) {
  if (smtpWarned) return;
  smtpWarned = true;
  console.error(`>>> [MAIL] ERRORE ${resolved.reason}: ${resolved.message}`);
}

/**
 * Transporter nodemailer, memoizzato su IMPRONTA e non su una variabile nuda: se la
 * configurazione cambiasse in-processo si otterrebbe un transporter sbagliato in silenzio.
 *
 * pool con maxConnections:1 non e' un compromesso, e' la descrizione di cio' che accade: gli
 * invii sono gia' sequenziali in jobNotifier.js. Il guadagno non e' il tempo, e' che il relay
 * vede UNA connessione per run invece di N - i relay aziendali limitano le connessioni per IP
 * molto piu' spesso dei messaggi. Se un domani gli invii diventassero paralleli, maxConnections:1
 * li serializzerebbe e il parallelismo sarebbe finto: qui e' il posto da cambiare.
 *
 * I tre timeout sono espliciti perche' il socketTimeout di default di nodemailer e' DUE MINUTI:
 * un solo destinatario su un host che accetta la connessione e tace brucerebbe l'intero
 * MAIL_BUDGET_MS, e tutti gli altri uscirebbero con «budget mail esaurito».
 *
 * `require` pigro: mailer.js e' nella catena di import di tutti e cinque i job via jobSummary.js,
 * e nel caso normale il trasporto e' `file` o `destination`. Un modulo assente diventa un esito,
 * non un crash all'avvio.
 */
function getTransporter(smtp) {
  const fingerprint = `${smtp.host}:${smtp.port}:${smtp.secure}:${smtp.requireTLS}:${smtp.auth ? smtp.auth.user : ''}`;
  if (transporterCache && transporterCache.fingerprint === fingerprint) {
    return { ok: true, transporter: transporterCache.transporter };
  }

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    return { ok: false, message: `nodemailer non installato: ${e.message}` };
  }

  const options = {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: smtp.requireTLS,
    ignoreTLS: smtp.ignoreTLS,
    pool: smtp.pool,
    maxConnections: 1,
    maxMessages: smtp.maxMessages,
    connectionTimeout: smtp.timeoutMs,
    greetingTimeout: smtp.timeoutMs,
    socketTimeout: smtp.timeoutMs,
    // Il corpo passa gia' da esc() e oggi non contiene <img>, ma queste due righe rendono
    // impossibile che un <img src="file:///..."> finisca allegato al messaggio.
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { rejectUnauthorized: smtp.tlsRejectUnauthorized }
  };
  if (smtp.auth) options.auth = { user: smtp.auth.user, pass: smtp.auth.pass };
  if (smtp.name) options.name = smtp.name;

  try {
    const transporter = nodemailer.createTransport(options);
    transporterCache = { fingerprint, transporter };
    return { ok: true, transporter };
  } catch (e) {
    return { ok: false, message: `transporter SMTP non creabile: ${e.message}` };
  }
}

/**
 * Chiude il transporter in pool. E' IGIENE, non correttezza: runJob.js termina con
 * process.exit(), quindi un socket rimasto aperto non puo' appendere nulla - va detto, o
 * qualcuno andra' a caccia di un hang che non puo' esistere. Cosa fa: manda QUIT invece di
 * lasciare che il processo strappi il TCP, e alcuni relay contabilizzano le disconnessioni
 * sporche.
 *
 * La chiama chi sa che il lotto e' finito (jobNotifier.js), non sendViaSmtp: la' annullerebbe
 * il pool. Idempotente, no-op per gli altri trasporti, non lancia mai.
 */
async function closeMailTransport() {
  if (!transporterCache) return;
  const { transporter } = transporterCache;
  transporterCache = null;
  try {
    if (transporter && typeof transporter.close === 'function') transporter.close();
  } catch (e) {
    console.warn(`>>> [MAIL] chiusura del transporter SMTP fallita (non-blocking): ${e.message}`);
  }
}

/** Trasporto `smtp`: collegamento diretto al relay via nodemailer. */
async function sendViaSmtp(msg, cfg, smtp) {
  const secrets = smtpRules.secretsOf(smtp);
  const t = getTransporter(smtp);
  if (!t.ok) {
    console.error(`>>> [MAIL] ${msg.to}: ${t.message}`);
    return { ok: false, status: null, message: String(t.message).slice(0, 255), transport: 'smtp' };
  }

  const nAtt = (msg.attachments || []).length;
  const wireBytes = smtpRules.estimateMimeBytes(msg);
  if (smtp.maxMessageBytes && wireBytes > smtp.maxMessageBytes) {
    // Non si blocca l'invio: il limite configurato e' una nostra stima del limite del relay, e
    // l'autorita' resta il relay. Ma un 552 arriva DOPO che il corpo e' stato trasmesso per
    // intero, quindi vale la pena dirlo prima.
    console.warn(`>>> [MAIL] ${msg.to}: ${wireBytes} byte stimati sul filo, oltre il limite `
      + `dichiarato di ${smtp.maxMessageBytes}: il relay potrebbe rifiutare con 552`);
  }
  console.log(`>>> [MAIL] smtp ${smtp.host}:${smtp.port} -> ${msg.to} (${nAtt} allegati, ~${wireBytes} byte sul filo)`);

  try {
    const info = await t.transporter.sendMail(smtpRules.buildNodemailerMessage(msg, smtp));
    // `accepted` vuoto con la promessa risolta e' il caso in cui il server ha preso in carico
    // la connessione ma non il destinatario: non e' un successo.
    if (info && Array.isArray(info.accepted) && info.accepted.length === 0) {
      const text = smtpRules.oneLine(`smtp -/- nessun destinatario accettato: ${(info.response || '').slice(0, 120)}`, 255);
      console.error(`>>> [MAIL] ${msg.to}: ${text}`);
      return { ok: false, status: null, message: text, transport: 'smtp' };
    }
    const accepted = info && info.messageId ? ` id ${String(info.messageId).slice(0, 80)}` : '';
    console.log(`>>> [MAIL] ${msg.to}: inviata${accepted}`);
    return { ok: true, status: 250, message: smtpRules.oneLine(`inviata${accepted}`, 255), transport: 'smtp' };
  } catch (e) {
    const v = smtpRules.classifySmtpError(e, secrets);
    console.error(`>>> [MAIL] ${msg.to}: ERRORE ${v.message}`);
    return { ok: false, status: v.status, message: v.message, transport: 'smtp' };
  }
}

/**
 * true per gli errori che vale la pena ritentare una volta.
 *
 * ATTENZIONE al ramo SMTP, che e' l'OPPOSTO di quello HTTP e non va «uniformato»: in HTTP un
 * 5xx e' un guasto del server e si ritenta, in SMTP (RFC 5321 s.4.2.1) un 5xx e' un rifiuto
 * DEFINITIVO - destinatario inesistente, messaggio troppo grande, mittente non autorizzato -
 * mentre il 4xx e' quello temporaneo (greylisting, casella piena). Con la regola HTTP si
 * ritenterebbe ogni hard bounce e mai un greylisting. Vedi DEC-93.
 */
function isRetryable(result) {
  if (result.ok) return false;
  if (result.transport === 'smtp') return smtpRules.isRetryableSmtp(result.status);
  if (result.status === null) return true;               // errore di rete / timeout
  return result.status >= 500 || result.status === 429;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Invia UNA mail a UN destinatario. Non lancia mai.
 *
 * @param {object} msg
 * @param {string} msg.to
 * @param {string[]} [msg.cc]
 * @param {string} msg.subject
 * @param {string} msg.html
 * @param {string} [msg.text]
 * @param {Array<{filename:string,contentType:string,content:Buffer}>} [msg.attachments]
 * @param {string} [msg.runId]  usato dal trasporto `file` per raggruppare
 * @param {number} [msg.seq]    progressivo, per un ordine stabile dei file
 * @returns {Promise<{ok:boolean,status:number|null,message:string,transport:string}>}
 */
async function sendMail(msg) {
  const cfg = readMailConfig();
  const transport = resolveTransport(cfg);

  const inProd = (cds.env.profiles || []).includes('production') || process.env.NODE_ENV === 'production';
  // I trasporti che in produzione consegnano davvero. `smtp` va tenuto in questo elenco o dal
  // giorno del passaggio la produzione stamperebbe «nessuna mail raggiungera' i destinatari»
  // MENTRE le manda: un avviso che mente e' peggio di nessun avviso.
  if (inProd && transport !== 'destination' && transport !== 'smtp') {
    console.warn(`>>> [MAIL] ATTENZIONE: profilo produzione con transport='${transport}': nessuna mail raggiungera' i destinatari`);
  }

  try {
    if (transport === 'off') {
      console.warn(`>>> [MAIL] transport='off': invio SALTATO per ${msg.to} (opt-out esplicito)`);
      return { ok: false, status: null, message: 'transport off', transport: 'off' };
    }
    if (transport === 'console') {
      console.log(`>>> [MAIL] console -> ${msg.to} | ${msg.subject} | ${(msg.attachments || []).length} allegati`);
      return { ok: true, status: null, message: 'console', transport: 'console' };
    }
    if (transport === 'file') return await sendViaFile(msg, cfg);
    if (transport === 'destination') {
      let result = await sendViaDestination(msg, cfg);
      if (isRetryable(result)) {
        console.warn(`>>> [MAIL] ${msg.to}: nuovo tentativo fra 2s`);
        await sleep(2000);
        result = await sendViaDestination(msg, cfg);
      }
      return result;
    }
    if (transport === 'smtp') {
      // La configurazione si risolve PRIMA del ciclo di retry, non dentro sendViaSmtp: un esito
      // non configurato ha status null, e isRetryableSmtp(null) e' true per costruzione, quindi
      // ogni destinatario costerebbe due tentativi e due secondi per un errore che non cambiera'.
      const resolved = await getSmtpConfig(cfg);
      if (!resolved.ok) {
        warnSmtpMisconfiguredOnce(resolved);
        console.error(`>>> [MAIL] ${msg.to}: ${resolved.message}`);
        return { ok: false, status: null, message: resolved.message.slice(0, 255), transport: 'smtp' };
      }
      let result = await sendViaSmtp(msg, cfg, resolved.config);
      if (isRetryable(result)) {
        console.warn(`>>> [MAIL] ${msg.to}: nuovo tentativo fra 2s`);
        await sleep(2000);
        result = await sendViaSmtp(msg, cfg, resolved.config);
      }
      return result;
    }
    console.error(`>>> [MAIL] transport '${transport}' non supportato`);
    return { ok: false, status: null, message: `transport '${transport}' non supportato`, transport };
  } catch (e) {
    console.error(`>>> [MAIL] ${msg.to}: errore inatteso - ${e.message}`);
    return { ok: false, status: null, message: String(e.message || 'errore').slice(0, 255), transport };
  }
}

module.exports = {
  sendMail, resolveMailTarget, resolveTransport, readMailConfig, buildPayload, OUT_DIR,
  // [SMTP-MAIL] la chiama chi sa che il lotto di invii e' finito, vedi il docblock.
  closeMailTransport
};

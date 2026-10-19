/**
 * Costruzione degli allegati del recap di fine job: CSV completo e PDF di riepilogo.
 *
 * CSV  - separatore ';', BOM UTF-8 e CRLF perche' il destinatario lo apre con Excel
 *        italiano (senza BOM gli accenti diventano mojibake, con ',' Excel non splitta).
 *        Zero dipendenze.
 * PDF  - pdfkit (pinnato 0.19.1). Dalla 0.17 ha `doc.table()` nativo con page-break
 *        automatico: l'unica cosa che NON fa e' ripetere la riga di header a ogni pagina,
 *        e quella la si ottiene paginando a blocchi (renderTable qui sotto).
 *        Font standard-14 (Helvetica) inclusi nel pacchetto -> nessun file .ttf da
 *        spedire, quindi nessuna interazione con la semantica di copia di `cds build`.
 *
 * Vincolo dei font standard-14: sono WinAnsi/Latin-1. Accenti italiani ed EUR ci sono,
 * ma un carattere CJK o un'emoji proveniente dai messaggi Plex renderizzerebbe come
 * quadratino SENZA lanciare eccezione -> sanitize() li mappa a '?'.
 *
 * Consumato da srv/lib/jobNotifier.js.
 */

'use strict';

const PDFDocument = require('pdfkit');

// ================================================================
// CSV
// ================================================================

const BOM = '﻿';
const SEP = ';';
const EOL = '\r\n';

/**
 * Quoting RFC-4180: si virgoletta solo se serve, e le virgolette interne si raddoppiano.
 * @param {*} value
 * @returns {string}
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.indexOf(SEP) >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serializza le righe in CSV.
 *
 * @param {Array<object>} rows
 * @param {Array<{key:string,label:string}>} columns
 * @param {{footer?: string[]}} [opts] righe di commento appese in coda (es. nota di troncamento)
 * @returns {Buffer} pronto per essere allegato
 */
function buildCsv(rows, columns, opts = {}) {
  const out = [columns.map((c) => csvCell(c.label)).join(SEP)];
  for (const r of rows) {
    out.push(columns.map((c) => csvCell(r[c.key])).join(SEP));
  }
  for (const line of opts.footer || []) {
    out.push(csvCell(line));
  }
  return Buffer.from(BOM + out.join(EOL) + EOL, 'utf8');
}

// ================================================================
// PDF
// ================================================================

// I font standard-14 di pdfkit coprono WinAnsi/Latin-1. Si tiene ASCII stampabile,
// il blocco Latin-1 e i pochi segni tipografici usati nei messaggi italiani.
const WINANSI_OK = /[^\x20-\x7E\xA0-\xFF€…–—‘’“”]/g;

/** @returns {string} stringa sicura per i font standard-14. */
function sanitize(value) {
  return String(value === null || value === undefined ? '' : value).replace(WINANSI_OK, '?');
}

/**
 * Tabella paginata con header ripetuto.
 *
 * doc.table() spezza le pagine da solo ma il suo flag `header` e' solo struttura di
 * accessibilita', non una direttiva di ripetizione: si emette quindi una table per
 * blocco di ROWS_PER_PAGE righe, ciascuna con la propria riga di intestazione.
 */
function renderTable(doc, columns, rows, rowsPerPage) {
  const header = columns.map((c) => ({
    text: sanitize(c.label), header: true, font: 'Helvetica-Bold', backgroundColor: '#eeeeee'
  }));
  for (let i = 0; i < rows.length; i += rowsPerPage) {
    if (i > 0) doc.addPage();
    doc.table({
      columnStyles: columns.map((c) => c.width || '*'),
      rowStyles: { border: 0.5, borderColor: '#999999', padding: 4 },
      data: [header, ...rows.slice(i, i + rowsPerPage).map((r) => columns.map((c) => sanitize(r[c.key])))]
    });
  }
}

/**
 * Genera il PDF di riepilogo.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {object} spec.meta       coppie chiave/valore stampate in testa (Run, Job, Plant, orari)
 * @param {object} spec.counters   coppie etichetta/numero del blocco contatori
 * @param {Array}  spec.columns    [{key,label,width}]
 * @param {Array}  spec.rows       righe gia' filtrate e limitate dal chiamante
 * @param {string} [spec.footerNote] nota finale (es. "altre N righe: vedere il CSV")
 * @param {number} [spec.rowsPerPage=24]
 * @returns {Promise<Buffer>}
 */
function buildPdf(spec) {
  const {
    title, meta = {}, counters = {}, columns = [], rows = [], footerNote, rowsPerPage = 24
  } = spec;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', layout: 'landscape', margin: 30,
        info: { Title: sanitize(title), Author: 'MARSPLM SAP2PLEX' }
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      doc.font('Helvetica-Bold').fontSize(15).text(sanitize(title));
      doc.moveDown(0.4);

      doc.font('Helvetica').fontSize(9);
      for (const [k, v] of Object.entries(meta)) {
        doc.text(`${sanitize(k)}: ${sanitize(v)}`);
      }

      const counterLine = Object.entries(counters)
        .map(([k, v]) => `${sanitize(k)}: ${sanitize(v)}`).join('   |   ');
      if (counterLine) {
        doc.moveDown(0.4);
        doc.font('Helvetica-Bold').fontSize(10).text(counterLine);
      }
      doc.moveDown(0.6);

      if (rows.length) {
        doc.font('Helvetica').fontSize(8);
        renderTable(doc, columns, rows, rowsPerPage);
      } else {
        doc.font('Helvetica-Oblique').fontSize(10).text('Nessun record da elencare.');
      }

      if (footerNote) {
        doc.moveDown(0.6);
        doc.font('Helvetica-Oblique').fontSize(9).text(sanitize(footerNote));
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { buildCsv, buildPdf, sanitize };

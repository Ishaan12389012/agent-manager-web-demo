// Turns an uploaded Excel (.xlsx) or CSV file into tables Verdict can store.
// Each table is { name, columns, rows }: the first non-empty row is the header.
const readXlsxFile = require('read-excel-file/node').default;

const MAX_ROWS = 20000;
const MAX_COLUMNS = 200;

class ImportError extends Error {}

// Reads CSV text, handling quoted values that contain commas, quotes or line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Cells become plain JSON values: dates as YYYY-MM-DD (or full ISO time), blanks as null.
function cleanCell(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    // CSV numbers arrive as text; keep them as numbers so they can be added up later.
    if (/^-?\d+(\.\d+)?$/.test(s) && !/^-?0\d/.test(s)) return Number(s);
    return s;
  }
  return v;
}

// Header row first, then data. Drops empty rows and fully empty columns.
function toTable(name, grid) {
  const rows = grid.map((r) => r.map(cleanCell)).filter((r) => r.some((v) => v !== null));
  if (!rows.length) return null;
  const header = rows.shift();
  const width = Math.max(header.length, ...rows.map((r) => r.length));
  if (width > MAX_COLUMNS) throw new ImportError(`“${name}” has more than ${MAX_COLUMNS} columns.`);
  if (rows.length > MAX_ROWS) throw new ImportError(`“${name}” has more than ${MAX_ROWS.toLocaleString('en')} rows.`);

  const keep = [];
  for (let c = 0; c < width; c++) {
    if (header[c] !== null && header[c] !== undefined) keep.push(c);
    else if (rows.some((r) => r[c] !== null && r[c] !== undefined)) keep.push(c);
  }
  const seen = new Map();
  const columns = keep.map((c, i) => {
    let title = header[c] === null || header[c] === undefined ? `Column ${i + 1}` : String(header[c]);
    const n = (seen.get(title.toLowerCase()) || 0) + 1;
    seen.set(title.toLowerCase(), n);
    return n > 1 ? `${title} (${n})` : title;
  });
  return { name, columns, rows: rows.map((r) => keep.map((c) => (r[c] === undefined ? null : r[c]))) };
}

// Returns the tables found in the file. A workbook gives one table per non-empty sheet.
async function readUpload(buffer, filename) {
  const base = String(filename || 'Imported data').replace(/\.[^.]+$/, '').trim() || 'Imported data';
  const ext = (String(filename).match(/\.([^.]+)$/) || [])[1]?.toLowerCase();

  let tables;
  if (ext === 'csv') {
    tables = [toTable(base, parseCsv(buffer.toString('utf8')))];
  } else if (ext === 'xlsx') {
    let sheets;
    try { sheets = await readXlsxFile(buffer); } catch (err) {
      throw new ImportError('That file couldn’t be read as an Excel workbook. Save it as .xlsx and try again.');
    }
    tables = sheets.map((s) => toTable(sheets.length > 1 ? `${base} – ${s.sheet}` : base, s.data));
  } else {
    throw new ImportError('Upload an Excel file (.xlsx) or a CSV file (.csv). Older .xls files need saving as .xlsx first.');
  }

  tables = tables.filter(Boolean);
  if (!tables.length) throw new ImportError('That file is empty.');
  return tables;
}

module.exports = { readUpload, parseCsv, toTable, ImportError };

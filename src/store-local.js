'use strict';
/**
 * Local storage for --dry-run: behaves like the Google Sheet (same row order, same
 * de-duplication, manual columns preserved) but writes to ./out/<client>.{json,csv,html}.
 * Lets you test the scrapers without any Google credentials.
 */
const fs = require('fs');
const path = require('path');
const { COLUMNS, COL, WATCH_COLS, rowValues, isHighlighted, planLayout } = require('./crm');

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function createLocalStore(clientKey, outDir = path.join(__dirname, '..', 'out')) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${clientKey}.json`);
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { rows: [], watchlist: [] };

  async function load() {
    const watchlist = new Map(state.watchlist.map((r) => [r.key, r]));
    return { watchlist };
  }

  async function commit({ watchlist, newRecs, adjustedKeys }) {
    const byKey = new Map(state.rows.map((r) => [r[COL.key], r]));
    const plan = planLayout(state.rows.map((r) => r[COL.key]), adjustedKeys, newRecs.map((r) => r.key));
    const rows = plan.finalKeys.map((k) => {
      const rec = watchlist.get(k);
      const old = byKey.get(k);
      const fresh = rowValues(rec);
      if (!old) return fresh;
      // keep manual columns and the original "Added" date from the existing row
      return fresh.map((v, i) => (COLUMNS[i].manual || i === COL.addedOn ? old[i] : v));
    });
    state = { rows, watchlist: [...watchlist.values()].map((r) => Object.fromEntries(WATCH_COLS.map((k) => [k, r[k] ?? '']))) };
    fs.writeFileSync(file, JSON.stringify(state, null, 1));

    const display = (row) => row.map((v, i) => (i === COL.daysOnMarket && row[COL.listedDate]
      ? Math.round((Date.now() - Date.parse(row[COL.listedDate])) / 864e5) : v));
    fs.writeFileSync(path.join(outDir, `${clientKey}.csv`),
      [COLUMNS.map((c) => c.title), ...rows.map(display)].map((r) => r.map(csvCell).join(',')).join('\n'));
    const html = `<!doctype html><meta charset="utf-8"><title>${esc(clientKey)} preview</title>
<style>body{font:13px system-ui;margin:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:3px 6px;white-space:nowrap}
th{background:#1c3f70;color:#fff}th.m{background:#337855}tr.hl td{background:#ffd966}</style>
<table><tr>${COLUMNS.filter((c) => !c.hidden).map((c) => `<th class="${c.manual ? 'm' : ''}">${esc(c.title)}</th>`).join('')}</tr>
${rows.map((r) => `<tr class="${isHighlighted(watchlist.get(r[COL.key])) ? 'hl' : ''}">${display(r).map((v, i) => COLUMNS[i].hidden ? '' : `<td>${i === COL.url ? `<a href="${esc(v)}">${esc(v)}</a>` : esc(v)}</td>`).join('')}</tr>`).join('\n')}
</table>`;
    fs.writeFileSync(path.join(outDir, `${clientKey}.html`), html);
    return { rows: rows.length };
  }

  return { load, commit, label: `local file ${file}` };
}

module.exports = { createLocalStore };

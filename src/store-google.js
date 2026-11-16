'use strict';
/**
 * Google Sheets storage. One spreadsheet per client, two tabs:
 *   "Listings"   - the CRM the client works in (manual owner columns are never overwritten)
 *   "_Watchlist" - hidden; every listing seen so far, used for price tracking and de-duplication
 */
const { sheets: sheetsApi } = require('@googleapis/sheets');
const { GoogleAuth } = require('google-auth-library');
const { COLUMNS, COL, WATCH_COLS, rowValues, isHighlighted, adjustedLabel, planLayout } = require('./crm');
const { log } = require('./util');

const LISTINGS = 'Listings';
const WATCH = '_Watchlist';
const HIGHLIGHT = { red: 1, green: 0.85, blue: 0.4 };     // amber: price adjusted
const PLAIN = { red: 1, green: 1, blue: 1 };
const HEADER_BG = { red: 0.11, green: 0.25, blue: 0.44 };
const MANUAL_HEADER_BG = { red: 0.2, green: 0.47, blue: 0.33 };

function colLetter(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
const LAST = colLetter(COLUMNS.length - 1);
const KEY_COL = colLetter(COL.key);
const SEEN_COL = colLetter(COL.lastSeen);

function auth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set (see SETUP.md, step 2).');
  const credentials = JSON.parse(raw);
  return new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

function numberFormat(fmt) {
  if (fmt === 'DATE') return { type: 'DATE', pattern: 'yyyy-mm-dd' };
  if (fmt === 'RAND') return { type: 'CURRENCY', pattern: '"R" #,##0' };
  if (fmt === 'INT') return { type: 'NUMBER', pattern: '0' };
  return null;
}

function createGoogleStore(spreadsheetId, { api = sheetsApi({ version: 'v4', auth: auth() }) } = {}) {
  let ids = {}; // tab title -> sheetId
  let rowCounts = {}; // tab title -> number of grid rows

  async function meta() {
    const res = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    ids = Object.fromEntries(res.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
    rowCounts = Object.fromEntries(res.data.sheets.map((s) => [s.properties.title, s.properties.gridProperties?.rowCount || 0]));
    return res.data.sheets;
  }

  /** Create/repair the two tabs, header, widths, formats. Safe to run every time. */
  async function ensureLayout() {
    const sheets = await meta();
    const requests = [];
    if (ids[LISTINGS] == null) {
      // Re-use an empty default "Sheet1" if it's the only tab, else add a new tab.
      const only = sheets.length === 1 && /^(Sheet1|Blad1|Feuille 1)$/i.test(sheets[0].properties.title);
      if (only) requests.push({ updateSheetProperties: { properties: { sheetId: sheets[0].properties.sheetId, title: LISTINGS }, fields: 'title' } });
      else requests.push({ addSheet: { properties: { title: LISTINGS, index: 0 } } });
    }
    if (ids[WATCH] == null) requests.push({ addSheet: { properties: { title: WATCH, hidden: true } } });
    if (requests.length) {
      await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
      await meta();
    }

    const sid = ids[LISTINGS];
    const fmt = [];
    fmt.push({
      updateSheetProperties: {
        properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
    COLUMNS.forEach((c, i) => {
      fmt.push({
        updateDimensionProperties: {
          range: { sheetId: sid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: c.width, hiddenByUser: !!c.hidden },
          fields: 'pixelSize,hiddenByUser',
        },
      });
      fmt.push({
        repeatCell: {
          range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          cell: {
            userEnteredValue: { stringValue: c.title },
            userEnteredFormat: {
              backgroundColor: c.manual ? MANUAL_HEADER_BG : HEADER_BG,
              textFormat: { bold: true, foregroundColor: PLAIN },
              wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE',
            },
          },
          fields: 'userEnteredValue,userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment)',
        },
      });
      const nf = numberFormat(c.format);
      if (nf) {
        fmt.push({
          repeatCell: {
            range: { sheetId: sid, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
            cell: { userEnteredFormat: { numberFormat: nf } },
            fields: 'userEnteredFormat.numberFormat',
          },
        });
      }
    });
    await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: fmt } });
  }

  async function load() {
    await ensureLayout();
    const res = await api.spreadsheets.values.get({
      spreadsheetId, range: `${WATCH}!A2:${colLetter(WATCH_COLS.length - 1)}`, valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const watchlist = new Map();
    const numeric = new Set(['firstPrice', 'currentPrice', 'prevPrice', 'priceChanges']);
    for (const row of res.data.values || []) {
      const rec = Object.fromEntries(WATCH_COLS.map((k, i) => {
        const v = row[i] ?? '';
        return [k, numeric.has(k) && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : String(v)];
      }));
      if (rec.key) watchlist.set(rec.key, rec);
    }
    return { watchlist };
  }

  async function commit({ watchlist, newRecs, adjustedKeys, today }) {
    const sid = ids[LISTINGS];
    // Read the current order fresh, right before writing, in case someone sorted the sheet.
    const cur = await api.spreadsheets.values.get({ spreadsheetId, range: `${LISTINGS}!${SEEN_COL}2:${KEY_COL}` });
    const curRows = cur.data.values || [];
    // Each row is [lastSeen, key]; trailing blanks are trimmed by the API.
    const existingKeys = curRows.map((r) => r[1] || '');
    const prevSeen = new Map(curRows.map((r) => [r[1] || '', r[0] || '']));

    const newKeys = newRecs.map((r) => r.key);
    const plan = planLayout(existingKeys, adjustedKeys, newKeys);
    for (const k of plan.missing) log(`  note: ${k} had a price change but its row was deleted from the sheet; not re-adding`);

    // 1. Structural changes: move adjusted rows up, insert new rows at the top.
    const requests = plan.moves.map((m) => ({
      moveDimension: {
        source: { sheetId: sid, dimension: 'ROWS', startIndex: m.fromRow, endIndex: m.fromRow + 1 },
        destinationIndex: m.toRow,
      },
    }));
    if (plan.insertCount) {
      requests.push({
        insertDimension: {
          range: { sheetId: sid, dimension: 'ROWS', startIndex: 1, endIndex: 1 + plan.insertCount },
          inheritFromBefore: false,
        },
      });
    }

    // 2. Row colours for every row we touch.
    const rowOf = new Map(plan.finalKeys.map((k, i) => [k, i + 1])); // 0-based sheet row index
    const touched = [...newKeys, ...adjustedKeys.filter((k) => rowOf.has(k))];
    for (const k of touched) {
      const rec = watchlist.get(k);
      const r = rowOf.get(k);
      requests.push({
        repeatCell: {
          range: { sheetId: sid, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: COLUMNS.length },
          cell: { userEnteredFormat: { backgroundColor: isHighlighted(rec) ? HIGHLIGHT : PLAIN } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
    }
    // Re-apply number formats to the data area so inserted rows are formatted.
    COLUMNS.forEach((c, i) => {
      const nf = numberFormat(c.format);
      if (nf) requests.push({
        repeatCell: {
          range: { sheetId: sid, startRowIndex: 1, endRowIndex: 1 + plan.finalKeys.length, startColumnIndex: i, endColumnIndex: i + 1 },
          cell: { userEnteredFormat: { numberFormat: nf } },
          fields: 'userEnteredFormat.numberFormat',
        },
      });
    });
    if (requests.length) await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

    // 3. Values. Manual columns (owner details, notes) are never written for existing rows.
    const data = [];
    const firstManual = COLUMNS.findIndex((c) => c.manual);
    const lastManual = COLUMNS.length - 1 - [...COLUMNS].reverse().findIndex((c) => c.manual);
    for (const rec of newRecs) {
      const r = rowOf.get(rec.key) + 1; // 1-based A1 row
      const vals = rowValues(rec);
      data.push({ range: `${LISTINGS}!A${r}:${colLetter(firstManual - 1)}${r}`, values: [vals.slice(0, firstManual)] });
      data.push({ range: `${LISTINGS}!${colLetter(lastManual + 1)}${r}:${LAST}${r}`, values: [vals.slice(lastManual + 1)] });
    }
    for (const k of adjustedKeys) {
      if (!rowOf.has(k)) continue;
      const rec = watchlist.get(k);
      const r = rowOf.get(k) + 1;
      const vals = rowValues(rec);
      data.push({ range: `${LISTINGS}!${colLetter(COL.currentPrice)}${r}`, values: [[vals[COL.currentPrice]]] });
      data.push({
        range: `${LISTINGS}!${colLetter(COL.adjustedLabel)}${r}:${colLetter(COL.priceChangedOn)}${r}`,
        values: [vals.slice(COL.adjustedLabel, COL.priceChangedOn + 1)],
      });
    }
    // Last Seen column for every row, in final order.
    if (plan.finalKeys.length) {
      const seen = plan.finalKeys.map((k) => [watchlist.get(k)?.lastSeen || prevSeen.get(k) || '']);
      data.push({ range: `${LISTINGS}!${SEEN_COL}2:${SEEN_COL}${plan.finalKeys.length + 1}`, values: seen });
    }
    if (data.length) {
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
    }

    // 4. Save the watchlist (script-owned tab). It only ever grows, so overwriting from A1
    //    is safe and never leaves the tab empty if a write fails half-way.
    const rows = [WATCH_COLS, ...[...watchlist.values()].map((rec) => WATCH_COLS.map((k) => rec[k] ?? ''))];
    if (rows.length > (rowCounts[WATCH] || 0)) {
      const extra = rows.length - (rowCounts[WATCH] || 0) + 500;
      await api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ appendDimension: { sheetId: ids[WATCH], dimension: 'ROWS', length: extra } }] },
      });
      rowCounts[WATCH] = (rowCounts[WATCH] || 0) + extra;
    }
    await api.spreadsheets.values.update({
      spreadsheetId, range: `${WATCH}!A1`, valueInputOption: 'RAW', requestBody: { values: rows },
    });
    return { rows: plan.finalKeys.length };
  }

  return { load, commit, ensureLayout, label: `Google Sheet ${spreadsheetId}` };
}

module.exports = { createGoogleStore, colLetter, adjustedLabel };

'use strict';
/**
 * Runs the Google Sheets storage against an in-memory imitation of the Sheets API, to check
 * that rows land in the right place and the manual columns are never overwritten.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createGoogleStore } = require('../src/store-google');
const { runClient, COL, COLUMNS } = require('../src/crm');

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseRange(a1) {
  const [tab, ref = ''] = a1.split('!');
  const m = ref.match(/^([A-Z]+)?(\d+)?(?::([A-Z]+)?(\d+)?)?$/);
  return {
    tab,
    c0: m && m[1] ? colIndex(m[1]) : 0,
    r0: m && m[2] ? Number(m[2]) - 1 : 0,
    c1: m && m[3] ? colIndex(m[3]) : m && m[1] && !m[3] && ref.includes(':') ? 25 : (m && m[1] ? colIndex(m[1]) : 25),
    r1: m && m[4] ? Number(m[4]) - 1 : Infinity,
  };
}

function fakeSheetsApi() {
  const tabs = { Sheet1: { sheetId: 0, rowCount: 1000, hidden: false, rows: [] } };
  let nextId = 1;
  const byId = (id) => Object.values(tabs).find((t) => t.sheetId === id);
  const row = (t, i) => { while (t.rows.length <= i) t.rows.push({ cells: [], bg: null }); return t.rows[i]; };
  const calls = [];
  return {
    tabs, calls,
    spreadsheets: {
      get: async () => ({ data: { sheets: Object.entries(tabs).map(([title, t]) => ({ properties: { title, sheetId: t.sheetId, gridProperties: { rowCount: t.rowCount } } })) } }),
      batchUpdate: async ({ requestBody }) => {
        for (const r of requestBody.requests) {
          const [type, b] = Object.entries(r)[0];
          calls.push(type);
          if (type === 'updateSheetProperties' && b.fields === 'title') {
            const [old] = Object.entries(tabs).find(([, t]) => t.sheetId === b.properties.sheetId);
            tabs[b.properties.title] = tabs[old]; delete tabs[old];
          } else if (type === 'addSheet') {
            tabs[b.properties.title] = { sheetId: nextId++, rowCount: 1000, hidden: !!b.properties.hidden, rows: [] };
          } else if (type === 'moveDimension') {
            const t = byId(b.source.sheetId);
            const moved = t.rows.splice(b.source.startIndex, b.source.endIndex - b.source.startIndex);
            t.rows.splice(b.destinationIndex, 0, ...moved);
          } else if (type === 'insertDimension') {
            const t = byId(b.range.sheetId);
            const n = b.range.endIndex - b.range.startIndex;
            t.rows.splice(b.range.startIndex, 0, ...Array.from({ length: n }, () => ({ cells: [], bg: null })));
            t.rowCount += n;
          } else if (type === 'appendDimension') {
            byId(b.sheetId).rowCount += b.length;
          } else if (type === 'repeatCell') {
            const t = byId(b.range.sheetId);
            const bg = b.cell.userEnteredFormat?.backgroundColor;
            const val = b.cell.userEnteredValue?.stringValue;
            const end = Math.min(b.range.endRowIndex ?? t.rows.length, Math.max(t.rows.length, b.range.endRowIndex ?? 0));
            for (let i = b.range.startRowIndex; i < end; i++) {
              if (bg && b.fields.includes('backgroundColor') && b.range.startRowIndex > 0) row(t, i).bg = bg;
              if (val != null) row(t, i).cells[b.range.startColumnIndex] = val;
            }
          }
        }
        return { data: {} };
      },
      values: {
        get: async ({ range }) => {
          const p = parseRange(range);
          const t = tabs[p.tab];
          const out = t.rows.slice(p.r0, p.r1 === Infinity ? undefined : p.r1 + 1).map((r) => {
            const vals = r.cells.slice(p.c0, p.c1 + 1).map((v) => (v == null ? '' : String(v)));
            while (vals.length && vals[vals.length - 1] === '') vals.pop();
            return vals;
          });
          while (out.length && !out[out.length - 1].length) out.pop();
          return { data: { values: out } };
        },
        batchUpdate: async ({ requestBody }) => {
          for (const d of requestBody.data) {
            const p = parseRange(d.range);
            const t = tabs[p.tab];
            d.values.forEach((vals, i) => vals.forEach((v, j) => { row(t, p.r0 + i).cells[p.c0 + j] = v; }));
          }
          return { data: {} };
        },
        update: async ({ range, requestBody }) => {
          const p = parseRange(range);
          const t = tabs[p.tab];
          if (requestBody.values.length > t.rowCount) throw new Error('exceeds grid limits');
          requestBody.values.forEach((vals, i) => { row(t, p.r0 + i).cells = vals.slice(); });
          return { data: {} };
        },
      },
    },
  };
}

function fakePortal(listings) {
  return {
    NAME: 'Property24', configKey: 'fake', allowedSet: () => new Set(),
    scanArea: async () => listings.map((l) => ({ portal: 'Property24', id: l.id, url: `https://p24/${l.id}`, price: l.price, area: 'Rivonia' })),
    fetchDetail: async (c) => ({ listedDate: listings.find((l) => l.id === c.id).listed, price: c.price, agent: 'A', agency: 'B', area: 'Rivonia' }),
  };
}

test('Google store: header, new rows at top, price change moves row and keeps manual columns', async () => {
  const api = fakeSheetsApi();
  const store = createGoogleStore('sheet', { api });
  const settings = { minimumListingAgeMonths: 3, excludeAgenciesMatching: ['jawitz'], maxDetailPagesPerRun: 50, maxResultPagesPerArea: 2 };
  const client = { name: 'T', fake: [{ area: 'Rivonia', url: 'x' }] };
  const listings = [
    { id: '1', listed: '2026-01-10', price: 1000000 },
    { id: '2', listed: '2026-03-10', price: 2000000 },
    { id: '3', listed: '2026-05-10', price: 3000000 },
  ];
  const run = (today) => runClient(client, { portals: [fakePortal(listings)], http: {}, settings, store, today });

  await run('2026-11-12');
  const L = api.tabs.Listings;
  assert.ok(L, 'Sheet1 renamed to Listings');
  assert.ok(api.tabs._Watchlist.hidden, 'watchlist hidden');
  assert.deepStrictEqual(L.rows[0].cells.slice(0, 3), ['Added to CRM', 'Portal', 'Listing Link']);
  assert.deepStrictEqual(L.rows.slice(1).map((r) => r.cells[COL.key]), ['P24:3', 'P24:2', 'P24:1']);

  // Client fills in owner details on listing 1 (bottom row)
  L.rows[3].cells[COL.ownerName] = 'Sipho Dlamini';
  L.rows[3].cells[COL.ownerNumber] = '082 000 0000';
  L.rows[3].cells[COL.notes] = 'Interested in valuation';

  listings[0].price = 900000;
  listings.push({ id: '4', listed: '2026-06-01', price: 4000000 });
  await run('2026-11-12');

  const keys = L.rows.slice(1).map((r) => r.cells[COL.key]);
  assert.deepStrictEqual(keys, ['P24:4', 'P24:1', 'P24:3', 'P24:2'], 'new on top, then price-adjusted');
  const r1 = L.rows[2];
  assert.strictEqual(r1.cells[COL.ownerName], 'Sipho Dlamini');
  assert.strictEqual(r1.cells[COL.ownerNumber], '082 000 0000');
  assert.strictEqual(r1.cells[COL.notes], 'Interested in valuation');
  assert.strictEqual(r1.cells[COL.currentPrice], 900000);
  assert.strictEqual(r1.cells[COL.firstPrice], 1000000);
  assert.strictEqual(r1.cells[COL.adjustedLabel], 'Reduced');
  assert.ok(r1.bg && r1.bg.green < 1, 'price-adjusted row highlighted');
  assert.ok(!L.rows[1].bg || L.rows[1].bg.green === 1, 'new row not highlighted');
  assert.strictEqual(L.rows.length - 1, 4, 'no duplicates');
  assert.strictEqual(COLUMNS.length, L.rows[0].cells.length);
});

test('Google store: watchlist tab grows past 1000 rows', async () => {
  const api = fakeSheetsApi();
  const store = createGoogleStore('sheet', { api });
  const settings = { minimumListingAgeMonths: 3, excludeAgenciesMatching: [], maxDetailPagesPerRun: 2000, maxResultPagesPerArea: 2 };
  const listings = Array.from({ length: 1200 }, (_, i) => ({ id: String(i), listed: '2026-10-01', price: 1e6 + i }));
  await runClient({ name: 'T', fake: [{ area: 'x', url: 'x' }] }, { portals: [fakePortal(listings)], http: {}, settings, store, today: '2026-11-12' });
  assert.strictEqual(api.tabs._Watchlist.rows.length, 1201);
});

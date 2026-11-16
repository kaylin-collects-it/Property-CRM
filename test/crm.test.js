'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runClient, planLayout, COL } = require('../src/crm');
const { createLocalStore } = require('../src/store-local');
const { isOlderThanMonths, parsePrice, parseDate, detectMandate } = require('../src/util');

/** A fake portal whose listings we control. */
function fakePortal(name, listings) {
  return {
    NAME: name,
    configKey: 'fake',
    allowedSet: () => new Set(['x']),
    scanArea: async () => listings.filter((l) => l.live !== false).map((l) => ({
      portal: name, id: l.id, url: `https://example/${l.id}`, price: l.price, area: 'Bryanston',
      reducedOnPortal: !!l.reducedBanner, agencyCount: l.agencyCount || 1,
    })),
    fetchDetail: async (card) => {
      const l = listings.find((x) => x.id === card.id);
      return { listedDate: l.listed, price: l.price, agent: 'Agent ' + l.id, agency: l.agency || 'Good Realty', mandate: l.mandate || '', area: 'Bryanston' };
    },
  };
}

const settings = { minimumListingAgeMonths: 3, excludeAgenciesMatching: ['jawitz'], maxDetailPagesPerRun: 100, maxResultPagesPerArea: 5 };
const client = { name: 'Test', fake: [{ area: 'Bryanston', url: 'x' }] };
const http = { wait: async () => {} };

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-'));
  return { dir, make: () => createLocalStore('t', dir) };
}
const rows = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 't.json'), 'utf8')).rows;

test('3-month rule, Jawitz exclusion, no duplicates, newest at top', async () => {
  const listings = [
    { id: 'old1', listed: '2026-06-01', price: 2000000 },
    { id: 'old2', listed: '2026-07-20', price: 3000000 },
    { id: 'young', listed: '2026-10-01', price: 1500000 },
    { id: 'jaw', listed: '2026-01-01', price: 9000000, agency: 'Jawitz Properties Sandton' },
  ];
  const portal = fakePortal('Property24', listings);
  const s = tmpStore();
  await runClient(client, { portals: [portal], http, settings, store: s.make(), today: '2026-11-12' });
  let r = rows(s.dir);
  assert.deepStrictEqual(r.map((x) => x[COL.key]), ['P24:old2', 'P24:old1']);

  // second run same day: nothing duplicated
  await runClient(client, { portals: [portal], http, settings, store: s.make(), today: '2026-11-12' });
  assert.strictEqual(rows(s.dir).length, 2);

  // 'young' turns 3 months old on 2027-01-01 and is added at the top
  await runClient(client, { portals: [portal], http, settings, store: s.make(), today: '2027-01-01' });
  r = rows(s.dir);
  assert.deepStrictEqual(r.map((x) => x[COL.key]), ['P24:young', 'P24:old2', 'P24:old1']);
});

test('price adjustment: highlighted, moved to top, initial price kept, manual columns preserved', async () => {
  const listings = [
    { id: 'a', listed: '2026-01-01', price: 2000000 },
    { id: 'b', listed: '2026-02-01', price: 3000000 },
  ];
  const portal = fakePortal('Private Property', listings);
  const s = tmpStore();
  await runClient(client, { portals: [portal], http, settings, store: s.make(), today: '2026-11-12' });

  // client types owner details into row for 'a'
  const state = JSON.parse(fs.readFileSync(path.join(s.dir, 't.json'), 'utf8'));
  const rowA = state.rows.find((x) => x[COL.key] === 'PP:a');
  rowA[COL.ownerName] = 'Jane Doe';
  rowA[COL.notes] = 'Called, call back Friday';
  fs.writeFileSync(path.join(s.dir, 't.json'), JSON.stringify(state));

  listings[0].price = 1850000; // reduced
  await runClient(client, { portals: [portal], http, settings, store: s.make(), today: '2026-11-13' });
  let r = rows(s.dir);
  assert.strictEqual(r.length, 2, 'not duplicated');
  assert.strictEqual(r[0][COL.key], 'PP:a', 'moved to top');
  assert.strictEqual(r[0][COL.currentPrice], 1850000);
  assert.strictEqual(r[0][COL.firstPrice], 2000000);
  assert.strictEqual(r[0][COL.prevPrice], 2000000);
  assert.strictEqual(r[0][COL.priceChangedOn], '2026-11-13');
  assert.strictEqual(r[0][COL.adjustedLabel], 'Reduced');
  assert.strictEqual(r[0][COL.ownerName], 'Jane Doe');
  assert.strictEqual(r[0][COL.notes], 'Called, call back Friday');
  assert.strictEqual(r[0][COL.addedOn], '2026-11-12', 'original added date kept');

  // second reduction: initial price still the very first one
  listings[0].price = 1700000;
  await runClient(client, { portals: [portal], http, settings, store: s.make(), today: '2026-11-20' });
  r = rows(s.dir);
  assert.strictEqual(r[0][COL.firstPrice], 2000000);
  assert.strictEqual(r[0][COL.prevPrice], 1850000);
  assert.strictEqual(r[0][COL.adjustedLabel], 'Reduced (2 changes)');
});

test('price change before the 3-month mark is shown when the listing enters the CRM', async () => {
  const listings = [{ id: 'y', listed: '2026-10-01', price: 4000000 }];
  const portal = fakePortal('Property24', listings);
  const s = tmpStore();
  await runClient(client, { portals: [portal], http, settings, store: s.make(), today: '2026-11-12' });
  assert.strictEqual(rows(s.dir).length, 0);
  listings[0].price = 3600000;
  await runClient(client, { portals: [portal], http, settings, store: s.make(), today: '2026-12-01' });
  await runClient(client, { portals: [portal], http, settings, store: s.make(), today: '2027-01-02' });
  const r = rows(s.dir);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0][COL.firstPrice], 4000000);
  assert.strictEqual(r[0][COL.currentPrice], 3600000);
  assert.strictEqual(r[0][COL.priceChangedOn], '2026-12-01');
});

test('planLayout', () => {
  const p = planLayout(['a', 'b', 'c', 'd'], ['c', 'd'], ['n1', 'n2']);
  assert.deepStrictEqual(p.finalKeys, ['n1', 'n2', 'c', 'd', 'a', 'b']);
  // replay the moves on a list to make sure they produce the same order (row 0 = header)
  const sheet = ['H', 'a', 'b', 'c', 'd'];
  for (const m of p.moves) { const [x] = sheet.splice(m.fromRow, 1); sheet.splice(m.toRow, 0, x); }
  assert.deepStrictEqual(sheet.slice(1), ['c', 'd', 'a', 'b']);
});

test('helpers', () => {
  assert.strictEqual(parsePrice('R 5 360 000'), 5360000);
  assert.strictEqual(parsePrice('R 2&#160;999&#160;000'), 2999000);
  assert.strictEqual(parsePrice('POA'), null);
  assert.strictEqual(parseDate('12 August 2026'), '2026-08-12');
  assert.strictEqual(parseDate('24 Oct 2025'), '2025-10-24');
  assert.strictEqual(parseDate('6 Sept 2026'), '2026-09-06');
  assert.ok(isOlderThanMonths('2026-08-12', 3, '2026-11-12'));
  assert.ok(!isOlderThanMonths('2026-08-13', 3, '2026-11-12'));
  assert.ok(isOlderThanMonths('2026-02-28', 3, '2026-05-31'));
  assert.strictEqual(detectMandate('EXCLUSIVE SOLE MANDATE. Must see'), 'Sole mandate');
  assert.strictEqual(detectMandate('Open mandate, call now'), 'Open mandate');
  assert.strictEqual(detectMandate('Lovely garden'), '');
});

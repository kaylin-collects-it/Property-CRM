'use strict';
/**
 * Core CRM logic, independent of where the data is stored.
 *
 *  Watchlist (hidden tab) = every listing ever seen in the client's areas, including ones
 *  that are younger than 3 months. It remembers the first price we saw, so a price change
 *  is detected even if it happens before the listing reaches the 3-month mark.
 *
 *  Listings tab = what the client works from. A listing is added once (never duplicated),
 *  when it is 3+ months old. New rows and price-adjusted rows go to the top.
 */
const { isOlderThanMonths, log } = require('./util');

/** Columns of the visible "Listings" tab. Order matters: it is the sheet layout. */
const COLUMNS = [
  { key: 'addedOn',        title: 'Added to CRM',          width: 105, format: 'DATE' },
  { key: 'portal',         title: 'Portal',                width: 115 },
  { key: 'url',            title: 'Listing Link',          width: 260 },
  { key: 'listedDate',     title: 'Date Listed',           width: 100, format: 'DATE' },
  { key: 'daysOnMarket',   title: 'Days on Market',        width: 80,  format: 'INT' },
  { key: 'currentPrice',   title: 'Listing Price',         width: 115, format: 'RAND' },
  { key: 'area',           title: 'Area',                  width: 120 },
  { key: 'agent',          title: 'Agent',                 width: 150 },
  { key: 'agency',         title: 'Agency',                width: 190 },
  { key: 'mandate',        title: 'Mandate',               width: 130 },
  { key: 'adjustedLabel',  title: 'Price Adjusted',        width: 130 },
  { key: 'firstPrice',     title: 'Initial Price',         width: 115, format: 'RAND' },
  { key: 'prevPrice',      title: 'Previous Price',        width: 115, format: 'RAND' },
  { key: 'priceChangedOn', title: 'Price Adjusted On',     width: 110, format: 'DATE' },
  { key: 'ownerName',      title: 'Owner Name & Surname',  width: 170, manual: true },
  { key: 'ownerNumber',    title: 'Owner Number',          width: 120, manual: true },
  { key: 'ownerEmail',     title: 'Owner Email',           width: 180, manual: true },
  { key: 'notes',          title: 'Notes',                 width: 260, manual: true },
  { key: 'lastSeen',       title: 'Last Seen on Portal',   width: 110, format: 'DATE' },
  { key: 'key',            title: 'Listing ID',            width: 150, hidden: true },
];
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c.key, i]));

/** Columns of the hidden "_Watchlist" tab. */
const WATCH_COLS = [
  'key', 'portal', 'id', 'url', 'area', 'listedDate', 'firstPrice', 'currentPrice', 'prevPrice',
  'priceChangedOn', 'priceChanges', 'reducedBeforeTracking', 'agent', 'agency', 'mandate',
  'firstSeen', 'lastSeen', 'inCrm', 'addedOn', 'excluded',
];

const keyOf = (portal, id) => `${portal === 'Property24' ? 'P24' : portal === 'Private Property' ? 'PP' : portal}:${id}`;

function adjustedLabel(rec) {
  const n = Number(rec.priceChanges || 0);
  if (n > 0) {
    const dir = Number(rec.currentPrice) < Number(rec.prevPrice) ? 'Reduced' : 'Increased';
    return n > 1 ? `${dir} (${n} changes)` : dir;
  }
  if (rec.reducedBeforeTracking) return 'Reduced (before tracking)';
  return '';
}

/** Values for one sheet row (manual columns left blank). Formulas are strings starting with "=". */
function rowValues(rec) {
  const adjusted = Number(rec.priceChanges || 0) > 0;
  const v = {
    addedOn: rec.addedOn || '',
    portal: rec.portal,
    url: rec.url,
    listedDate: rec.listedDate || '',
    daysOnMarket: '=IF(INDEX(D:D,ROW())="","",TODAY()-INDEX(D:D,ROW()))',
    currentPrice: rec.currentPrice ?? '',
    area: rec.area || '',
    agent: rec.agent || '',
    agency: rec.agency || '',
    mandate: rec.mandate || 'Not stated',
    adjustedLabel: adjustedLabel(rec),
    firstPrice: adjusted ? rec.firstPrice ?? '' : '',
    prevPrice: adjusted ? rec.prevPrice ?? '' : '',
    priceChangedOn: adjusted ? rec.priceChangedOn || '' : '',
    lastSeen: rec.lastSeen || '',
    key: rec.key,
  };
  return COLUMNS.map((c) => (c.manual ? '' : v[c.key] ?? ''));
}

function isHighlighted(rec) {
  return Number(rec.priceChanges || 0) > 0 || !!rec.reducedBeforeTracking;
}

/**
 * Work out the final row order. Rows that had a price change move to the top, new rows are
 * inserted above them. Returns the moves to perform (as sheet row indexes, 0 = header) and
 * the resulting order of keys.
 */
function planLayout(existingKeys, adjustedKeys, newKeys) {
  const order = existingKeys.slice();
  const moves = [];
  const missing = [];
  // Move in reverse so the first adjusted key ends up highest.
  for (const k of adjustedKeys.slice().reverse()) {
    const i = order.indexOf(k);
    if (i < 0) { missing.push(k); continue; }
    if (i > 0) moves.push({ fromRow: i + 1, toRow: 1 }); // sheet indexes; row 0 is the header
    order.splice(i, 1);
    order.unshift(k);
  }
  return { moves, insertCount: newKeys.length, finalKeys: newKeys.concat(order), missing };
}

function cmpListedDesc(a, b) {
  return String(b.listedDate || '').localeCompare(String(a.listedDate || ''));
}

/**
 * Run one client: scan every area on every portal, update the watchlist and produce the
 * changes for the Listings tab.
 */
async function runClient(client, { portals, http, settings, store, today }) {
  const minMonths = settings.minimumListingAgeMonths;
  const exclude = (settings.excludeAgenciesMatching || []).map((s) => new RegExp(s, 'i'));
  const { watchlist } = await store.load();
  log(`${client.name}: watchlist has ${watchlist.size} listing(s)`);

  // 1. Scan results pages.
  const cards = new Map();
  for (const portal of portals) {
    const areas = client[portal.configKey] || [];
    if (!areas.length) continue;
    const allowed = portal.allowedSet(areas);
    for (const area of areas) {
      try {
        const found = await portal.scanArea(area, {
          http, allowedSuburbIds: allowed, allowedSuburbs: allowed,
          maxPages: settings.maxResultPagesPerArea, log,
        });
        for (const c of found) cards.set(keyOf(c.portal, c.id), c);
      } catch (err) {
        log(`  !! ${portal.NAME} ${area.area} failed: ${err.message}`);
      }
    }
  }
  log(`${client.name}: ${cards.size} live listing(s) found across portals`);

  // 2. Update known listings; queue unknown ones for a detail-page visit.
  const toFetch = [];
  const adjustedInCrm = [];
  for (const [key, card] of cards) {
    const rec = watchlist.get(key);
    if (!rec) { toFetch.push([key, card]); continue; }
    rec.lastSeen = today;
    if (card.url) rec.url = card.url;
    const was = Number(rec.currentPrice) || null;
    if (card.price && was && card.price !== was) {
      rec.prevPrice = was;
      rec.currentPrice = card.price;
      rec.priceChangedOn = today;
      rec.priceChanges = Number(rec.priceChanges || 0) + 1;
      log(`  price change ${key}: R${was} -> R${card.price}`);
      if (rec.inCrm) adjustedInCrm.push(key);
    } else if (card.price && !was) {
      rec.currentPrice = card.price;
      if (!rec.firstPrice) rec.firstPrice = card.price;
    }
  }

  // 3. Visit detail pages for listings we have not seen before (capped per run).
  const cap = settings.maxDetailPagesPerRun;
  const blockedPortals = new Set();
  let fetched = 0;
  for (const [key, card] of toFetch) {
    if (fetched >= cap) break;
    if (blockedPortals.has(card.portal)) continue;
    const portal = portals.find((p) => p.NAME === card.portal);
    try {
      fetched++;
      if (fetched % 25 === 0) log(`  ...${fetched} new listing page(s) read so far`);
      const d = await portal.fetchDetail(card, { http });
      if (!d) continue;
      const price = card.price ?? d.price ?? null;
      const excludedBy = exclude.find((re) => re.test(d.agency || '') || re.test(d.agent || ''));
      watchlist.set(key, {
        key, portal: card.portal, id: card.id, url: card.url,
        area: d.area || card.area || '', listedDate: d.listedDate || '',
        firstPrice: price, currentPrice: price, prevPrice: '', priceChangedOn: '', priceChanges: 0,
        reducedBeforeTracking: card.reducedOnPortal ? 'yes' : '',
        agent: d.agent || (d.privateSeller ? 'Private seller' : ''), agency: d.agency || '',
        mandate: d.mandate || (card.agencyCount > 1 ? `Multiple agencies (${card.agencyCount})` : ''),
        firstSeen: today, lastSeen: today,
        inCrm: '', addedOn: '', excluded: excludedBy ? `agency matches "${excludedBy.source}"` : '',
      });
    } catch (err) {
      log(`  !! detail ${key} failed: ${err.message}`);
      if (err.blocked) { blockedPortals.add(card.portal); log(`  !! ${card.portal} is blocking requests; will retry next run`); }
    }
  }
  const backlog = toFetch.length - fetched;
  log(`${client.name}: ${fetched} new listing page(s) read${backlog > 0 ? `, ${backlog} left for the next run` : ''}`);

  // 4. Listings that have now reached the minimum age go into the CRM.
  const newRecs = [];
  for (const rec of watchlist.values()) {
    if (rec.inCrm || rec.excluded || rec.lastSeen !== today) continue;
    if (!isOlderThanMonths(rec.listedDate, minMonths, today)) continue;
    rec.inCrm = 'yes';
    rec.addedOn = today;
    newRecs.push(rec);
  }
  newRecs.sort(cmpListedDesc);

  const seenToday = new Set([...watchlist.values()].filter((r) => r.lastSeen === today).map((r) => r.key));
  const result = await store.commit({
    watchlist, newRecs, adjustedKeys: adjustedInCrm, seenToday, today,
  });
  log(`${client.name}: +${newRecs.length} new row(s), ${adjustedInCrm.length} price adjustment(s) moved to top`);
  return { found: cards.size, added: newRecs.length, adjusted: adjustedInCrm.length, backlog, ...result };
}

module.exports = {
  COLUMNS, COL, WATCH_COLS, keyOf, rowValues, isHighlighted, adjustedLabel, planLayout, runClient,
};

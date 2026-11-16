'use strict';
/**
 * Property24 (www.property24.com)
 *
 * Results:  https://www.property24.com/for-sale/<suburb>/<city>/gauteng/<suburbId>[/p<page>]
 * Listing:  https://www.property24.com/for-sale/<suburb>/<city>/gauteng/<suburbId>/<listingNo>
 *
 * Each results tile carries data-listing-number and the price. The detail page has a
 * schema.org RealEstateListing JSON-LD block with datePosted, price, agent and agency.
 */
const { parsePrice, parseDate, stripTags, detectMandate, decodeEntities } = require('../util');

const NAME = 'Property24';
const BASE = 'https://www.property24.com';
const LISTING_RE = /^\/for-sale\/([a-z0-9-]+)\/([a-z0-9-]+)\/[a-z-]+\/(\d+)\/(\d+)/;

function suburbIdFromAreaUrl(url) {
  const m = new URL(url).pathname.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

function pageUrl(areaUrl, page) {
  const base = areaUrl.replace(/\/+$/, '');
  return page <= 1 ? base : `${base}/p${page}`;
}

/** Parse one results page into listing cards. */
function parseResults(html) {
  const cards = [];
  const seen = new Set();
  // Property24 sprinkles random decoy class names into tiles ("LeakAdvancer p24_tileContainer"),
  // so match the class anywhere in the attribute rather than relying on its position.
  const tiles = html.split(/(?=<div class="[^"]*\bp24_tileContainer\b[^"]*"[^>]*data-listing-number=)/).slice(1);
  for (const tile of tiles) {
    const href = tile.match(/href="(\/for-sale\/[^"?#]+)/);
    if (!href) continue;
    const m = href[1].match(LISTING_RE);
    if (!m || seen.has(m[4])) continue;
    seen.add(m[4]);
    const priceMatch = tile.match(/class="[^"]*\bp24_price\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/);
    const priceText = priceMatch ? stripTags(priceMatch[1]).replace(/\s+/g, ' ').trim() : '';
    const loc = tile.match(/class="[^"]*\bp24_location\b[^"]*"[^>]*>([^<]*)/);
    const group = tile.match(/data-listing-group-text="(\d+) Estate Agenc/i);
    cards.push({
      portal: NAME,
      id: m[4],
      suburbId: m[3],
      url: BASE + `/for-sale/${m[1]}/${m[2]}/gauteng/${m[3]}/${m[4]}`,
      price: parsePrice(priceText),
      priceText,
      area: loc ? decodeEntities(loc[1]).trim() : '',
      // Property24 shows a "Reduced" banner. Used only for listings that were reduced
      // before this CRM first saw them (the original price is then unknown).
      reducedOnPortal: /\bp24_reducedBanner\b/.test(tile),
      // "Listed by 2 Estate Agencies" -> the property is not on a sole mandate.
      agencyCount: group ? Number(group[1]) : 1,
    });
  }
  return cards;
}

function lastPage(html, areaUrl) {
  const path = new URL(areaUrl).pathname.replace(/\/+$/, '');
  const re = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/p(\\d+)', 'g');
  let max = 1;
  for (const m of html.matchAll(re)) max = Math.max(max, Number(m[1]));
  return max;
}

/**
 * Walk every results page for an area and return cards that belong to the client's
 * configured suburbs (Property24 mixes in "nearby" listings from other suburbs).
 */
async function scanArea(area, { http, allowedSuburbIds, maxPages, log }) {
  const out = [];
  const first = await http.get(pageUrl(area.url, 1));
  const pages = Math.min(lastPage(first.html, area.url), maxPages);
  let html = first.html;
  for (let p = 1; p <= pages; p++) {
    if (p > 1) html = (await http.get(pageUrl(area.url, p))).html;
    const cards = parseResults(html);
    if (!cards.length) break;
    for (const c of cards) if (allowedSuburbIds.has(c.suburbId)) out.push(c);
  }
  log(`  ${NAME} ${area.area}: ${pages} page(s), ${out.length} listing(s)`);
  return out;
}

function parseDetail(html) {
  const ld = [...html.matchAll(/<script type="application\/ld(?:\+|&#x2B;)json">([\s\S]*?)<\/script>/gi)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean);
  let listing = null;
  for (const block of ld) {
    const graph = block['@graph'] || [block];
    listing = graph.find((g) => g['@type'] === 'RealEstateListing') || listing;
  }
  const offer = listing?.offers || {};
  const by = offer.offeredBy || {};
  const agencyLd = by.worksFor?.name || (by['@type'] === 'RealEstateAgent' ? by.name : '');
  const agentLd = by['@type'] === 'Person' ? by.name : '';

  // Fallback for the date if JSON-LD is missing: "Listing Date</...> ... 12 August 2026"
  let listedDate = parseDate(listing?.datePosted);
  if (!listedDate) {
    const m = stripTags(html).match(/Listing Date\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
    listedDate = parseDate(m && m[1]);
  }

  const descMatch =
    html.match(/class="[^"]*\bjs_expandedText\b[^"]*"[^>]*>([\s\S]*?)<\/div>/) ||
    html.match(/<meta property="og:description" content="([^"]*)"/);
  const description = descMatch ? stripTags(descMatch[1]) : '';

  return {
    listedDate,
    price: parsePrice(offer.priceSpecification?.price ? `R ${offer.priceSpecification.price}` : '') ,
    agent: agentLd || '',
    agency: agencyLd || '',
    area: listing?.about?.address?.addressLocality || '',
    mandate: detectMandate(description),
    title: listing?.name || '',
    // No agent/agency and a "Contact Seller" form = listed privately by the owner.
    privateSeller: !agentLd && !agencyLd && />\s*Contact Seller\s*</i.test(html),
  };
}

async function fetchDetail(card, { http }) {
  const res = await http.get(card.url);
  if (!res.html) return null; // listing removed
  return parseDetail(res.html);
}

function allowedSet(areas) {
  return new Set(areas.map((a) => suburbIdFromAreaUrl(a.url)).filter(Boolean));
}

module.exports = { NAME, scanArea, fetchDetail, allowedSet, parseResults, parseDetail, lastPage };

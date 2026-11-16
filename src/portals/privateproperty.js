'use strict';
/**
 * Private Property (www.privateproperty.co.za)
 *
 * Results:  https://www.privateproperty.co.za/for-sale/gauteng/johannesburg/<region>/<suburb>/<id>[?page=N]
 * Listing:  https://www.privateproperty.co.za/for-sale/gauteng/johannesburg/<region>/<suburb>/.../T<number>
 *
 * Listing date, price and description are in the page HTML. The agent/agency panel is
 * drawn by the site's JavaScript, so detail pages are opened in a headless browser.
 * Results pages are plain HTML and fetched directly (cheap and fast).
 */
const { parsePrice, parseDate, stripTags, detectMandate, decodeEntities, USER_AGENT } = require('../util');

const NAME = 'Private Property';
const BASE = 'https://www.privateproperty.co.za';

function suburbSlug(pathname) {
  // ['', 'for-sale', 'gauteng', 'johannesburg', '<region>', '<suburb>', ...]
  return pathname.split('/')[5] || null;
}

function pageUrl(areaUrl, page) {
  const u = new URL(areaUrl);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.toString();
}

function parseResults(html) {
  const cards = [];
  const seen = new Set();
  const blocks = html.split(/(?=<a [^>]*href="\/for-sale\/[^"]*\/T\d+")/).slice(1);
  for (const block of blocks) {
    const href = block.match(/href="(\/for-sale\/[^"]*\/(T\d+))"/);
    if (!href || seen.has(href[2])) continue;
    seen.add(href[2]);
    // Only look at this card's own markup (stop at the next card).
    const priceMatch = block.match(/class="[^"]*(?:listing-result__price|featured-listing__price)[^"]*"[^>]*>\s*([^<]+)/) ||
      block.match(/class="[^"]*price[^"]*"[^>]*>\s*(R[^<]+)/);
    const priceText = priceMatch ? decodeEntities(priceMatch[1]).replace(/\s+/g, ' ').trim() : '';
    const loc = block.match(/"addressLocality":"([^"]+)"/);
    cards.push({
      portal: NAME,
      id: href[2],
      suburbSlug: suburbSlug(href[1]),
      url: BASE + href[1],
      price: parsePrice(priceText),
      priceText,
      area: loc ? loc[1].split(',')[0].trim() : '',
    });
  }
  return cards;
}

function lastPage(html) {
  let max = 1;
  for (const m of html.matchAll(/[?&]page=(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

async function scanArea(area, { http, allowedSuburbs, maxPages, log }) {
  const out = [];
  const first = await http.get(pageUrl(area.url, 1));
  const pages = Math.min(lastPage(first.html), maxPages);
  let html = first.html;
  for (let p = 1; p <= pages; p++) {
    if (p > 1) html = (await http.get(pageUrl(area.url, p))).html;
    const cards = parseResults(html);
    if (!cards.length) break;
    for (const c of cards) if (allowedSuburbs.has(c.suburbSlug)) out.push(c);
  }
  log(`  ${NAME} ${area.area}: ${pages} page(s), ${out.length} listing(s)`);
  return out;
}

/** Parse the parts of a detail page that are present in the HTML itself. */
function parseDetailHtml(html) {
  const dateMatch = html.match(/Listing date\s*<span[^>]*>([^<]+)</i);
  const priceMatch = html.match(/class="listing-price-display__price[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const descMatch = html.match(/class="listing-description__text[^"]*"[^>]*>([\s\S]*?)<div class="listing-description__show-more/);
  const locMatch = html.match(/"addressLocality":"([^"]+)"/);
  const description = descMatch ? stripTags(descMatch[1]) : '';
  return {
    listedDate: parseDate(dateMatch && dateMatch[1]),
    price: parsePrice(priceMatch && stripTags(priceMatch[1])),
    area: locMatch ? locMatch[1].split(',')[0].trim() : '',
    mandate: detectMandate(description),
  };
}

let browserPromise = null;
let pagePromise = null;

async function getPage() {
  if (!pagePromise) {
    pagePromise = (async () => {
      const { chromium } = require('playwright');
      browserPromise = chromium.launch();
      const browser = await browserPromise;
      const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-ZA' });
      // Skip images, ads and trackers: faster, and lighter on the portal.
      await ctx.route(/\.(png|jpe?g|gif|webp|svg|woff2?)(\?|$)|doubleclick|googletag|google-analytics|googletagmanager|facebook|hotjar|images\.pp\.co\.za/i,
        (r) => r.abort());
      return ctx.newPage();
    })();
  }
  return pagePromise;
}

async function fetchDetail(card, { http }) {
  // Pace browser loads with the same polite delay as normal requests.
  await http.wait();
  const page = await getPage();
  const res = await page.goto(card.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!res || res.status() === 404 || res.status() === 410) return null;
  if (res.status() === 403) {
    const e = new Error(`Blocked by bot protection (HTTP 403) at ${card.url}`);
    e.blocked = true;
    throw e;
  }
  await page.waitForSelector('#listing-contacts-container a[href*="/estate-agency/"], #listing-contacts-container img[alt^="Photo of"]', { timeout: 15000 }).catch(() => {});
  const contacts = await page.evaluate(() => {
    const box = document.querySelector('#listing-contacts-container');
    if (!box) return { agency: '', agents: [] };
    const agencyEl = box.querySelector('a[href*="/estate-agency/"]');
    const agency = agencyEl ? (agencyEl.getAttribute('title') || agencyEl.textContent || '').trim() : '';
    const agents = [...box.querySelectorAll('img[alt^="Photo of"]')].map((i) => i.alt.replace(/^Photo of\s*/, '').trim());
    return { agency, agents };
  });
  const html = await page.content();
  const d = parseDetailHtml(html);
  return {
    ...d,
    agent: [...new Set(contacts.agents)].join(', '),
    agency: contacts.agency,
    privateSeller: !contacts.agency && /private seller/i.test(html),
  };
}

async function close() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b) await b.close();
  }
  browserPromise = null;
  pagePromise = null;
}

function allowedSet(areas) {
  return new Set(areas.map((a) => suburbSlug(new URL(a.url).pathname)).filter(Boolean));
}

module.exports = { NAME, scanArea, fetchDetail, allowedSet, parseResults, parseDetailHtml, lastPage, close };

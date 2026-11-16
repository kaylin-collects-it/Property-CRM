'use strict';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode the handful of HTML entities that show up in listing text. */
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .trim();
}

/** "R 5 360 000" -> 5360000. "POA" / "Price on application" -> null. Ranges take the first figure. */
function parsePrice(text) {
  if (text == null) return null;
  const t = decodeEntities(String(text)).replace(/ /g, ' ');
  const m = t.match(/R\s*([\d][\d\s,]*)/i) || t.match(/^\s*([\d][\d\s,]*)\s*$/);
  if (!m) return null;
  const n = Number(m[1].replace(/[\s,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** Accepts "2026-08-12", "12 August 2026", "24 Oct 2025". Returns "YYYY-MM-DD" or null. */
function parseDate(text) {
  if (!text) return null;
  const s = String(text).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 4)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mon == null) return null;
    return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

/** Today's date in South Africa as YYYY-MM-DD (GitHub runners use UTC). */
function today(tz = 'Africa/Johannesburg') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** True when `listed` (YYYY-MM-DD) is at least `months` calendar months before `now` (YYYY-MM-DD). */
function isOlderThanMonths(listed, months, now) {
  if (!listed) return false;
  const [y, m, d] = now.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1 - months, d));
  // If the day doesn't exist in the target month (e.g. 31 Feb) JS rolls forward; clamp back.
  if (cutoff.getUTCDate() !== d) cutoff.setUTCDate(0);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return listed <= cutoffStr;
}

/**
 * Mandate is not a structured field on either portal; agents usually write it in the
 * description ("EXCLUSIVE SOLE MANDATE", "Open mandate", "Dual mandate").
 */
function detectMandate(text) {
  if (!text) return '';
  const t = decodeEntities(text);
  const m = t.match(/\b(sole|open|dual|joint|exclusive(?:\s+sole)?|shared)\s+mandate\b/i);
  if (m) {
    const kind = m[1].toLowerCase().replace(/\s+/g, ' ');
    if (kind.includes('sole')) return 'Sole mandate';
    if (kind === 'exclusive') return 'Sole mandate (exclusive)';
    return kind.charAt(0).toUpperCase() + kind.slice(1) + ' mandate';
  }
  if (/\bsole\s+(?:and\s+)?exclusive\b|\bexclusive(?:ly)?\s+(?:listed|marketed)\s+(?:by|with)\b/i.test(t)) return 'Sole mandate (exclusive)';
  return '';
}

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

/**
 * Polite HTTP client: one request at a time, a delay between requests, and retries with
 * back-off. Property24 resets connections when hit too quickly, so the delay matters.
 */
function createHttp({ delayMs = 2500 } = {}) {
  let last = 0;
  /** Wait out the polite delay (used before headless-browser page loads too). */
  async function wait() {
    const ms = last + delayMs + Math.floor(Math.random() * 800) - Date.now();
    if (ms > 0) await sleep(ms);
    last = Date.now();
  }
  async function get(url, { retries = 4 } = {}) {
    for (let attempt = 0; ; attempt++) {
      await wait();
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'en-ZA,en;q=0.9',
          },
        });
        if (res.status === 404 || res.status === 410) return { status: res.status, html: '' };
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        // Property24 answers a short "Server unavailable" page when it wants us to slow down.
        if (html.length < 2000 && /Server unavailable|Please check back later/i.test(html)) {
          throw new Error('portal asked us to slow down ("Server unavailable")');
        }
        if (res.status === 403 || /<title>Just a moment/i.test(html)) {
          const e = new Error(`Blocked by bot protection (HTTP ${res.status}) at ${url}`);
          e.blocked = true;
          throw e;
        }
        return { status: res.status, html, url: res.url };
      } catch (err) {
        if (err.blocked || attempt >= retries) throw err;
        const backoff = Math.max(delayMs * 2 ** (attempt + 1), 15000 * (attempt + 1));
        log(`  retry ${attempt + 1}/${retries} in ${Math.round(backoff / 1000)}s: ${url} (${err.cause?.code || err.message})`);
        await sleep(backoff);
      }
    }
  }
  return { get, wait };
}

module.exports = {
  USER_AGENT, sleep, decodeEntities, stripTags, parsePrice, parseDate, today,
  isOlderThanMonths, detectMandate, log, createHttp,
};

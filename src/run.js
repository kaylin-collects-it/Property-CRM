'use strict';
/**
 * Entry point.
 *
 *   node src/run.js                      all clients -> their Google Sheets
 *   node src/run.js --client client2     one client only
 *   node src/run.js --dry-run            write to ./out/ instead of Google Sheets
 *   node src/run.js --setup-only         just create/format the tabs in each sheet
 *   node src/run.js --dry-run --limit-pages 2 --limit-details 10   quick smoke test
 */
const path = require('path');
const { createHttp, today, log } = require('./util');
const { runClient } = require('./crm');
const property24 = require('./portals/property24');
const privateproperty = require('./portals/privateproperty');
const myroof = require('./portals/myroof');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

async function main() {
  const config = require(path.join(__dirname, '..', 'config', 'clients.json'));
  const settings = { ...config.settings };
  if (arg('--limit-pages')) settings.maxResultPagesPerArea = Number(arg('--limit-pages'));
  if (arg('--limit-details')) settings.maxDetailPagesPerRun = Number(arg('--limit-details'));
  const dryRun = !!arg('--dry-run', false);
  const setupOnly = !!arg('--setup-only', false);
  const only = arg('--client');

  const portals = [
    { ...property24, configKey: 'property24' },
    { ...privateproperty, configKey: 'privateproperty' },
    ...(myroof.enabled ? [{ ...myroof, configKey: 'myroof' }] : []),
  ];

  const clients = config.clients.filter((c) => !only || c.key === only);
  if (!clients.length) throw new Error(`No client matches --client ${only}`);

  const http = createHttp({ delayMs: settings.requestDelayMs });
  const date = today(settings.timezone);
  let failures = 0;

  for (const client of clients) {
    let store;
    if (dryRun) {
      store = require('./store-local').createLocalStore(client.key);
    } else {
      const sheetId = process.env[client.sheetIdEnv];
      if (!sheetId) { log(`${client.name}: ${client.sheetIdEnv} not set - skipping`); continue; }
      store = require('./store-google').createGoogleStore(sheetId);
    }
    try {
      if (setupOnly) {
        await store.ensureLayout();
        log(`${client.name}: sheet layout ready`);
        continue;
      }
      log(`=== ${client.name} -> ${store.label}`);
      const r = await runClient(client, { portals, http, settings, store, today: date });
      log(`=== ${client.name} done: ${r.rows} row(s) in CRM`);
    } catch (err) {
      failures++;
      log(`!!! ${client.name} failed: ${err.stack || err.message}`);
    }
  }
  await privateproperty.close();
  if (failures) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await privateproperty.close().catch(() => {});
  process.exit(1);
});

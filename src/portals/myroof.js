'use strict';
/**
 * MyRoof (www.myroof.co.za) - bank-assisted and repossessed property.
 *
 * NOT ENABLED. MyRoof sits behind a Cloudflare "verify you are human" check that blocks
 * automated access, and this project does not try to get around that.
 *
 * Ways to add MyRoof later (see SETUP.md, "MyRoof"):
 *   1. Ask MyRoof / the banks for a data feed or API access for agents, then implement
 *      scanArea() + fetchDetail() here against that feed.
 *   2. Use MyRoof's own saved-search email alerts for the client's suburbs and add those
 *      listings to the sheet by hand (rows without a Listing ID are left alone by the robot).
 *
 * The interface is the same as the other portals, so enabling it is a matter of
 * implementing these two functions and setting "myroof" areas in config/clients.json.
 */
const NAME = 'MyRoof';

async function scanArea() {
  return [];
}
async function fetchDetail() {
  return null;
}
function allowedSet() {
  return new Set();
}

module.exports = { NAME, scanArea, fetchDetail, allowedSet, enabled: false };

# Property CRM – setup guide

This system checks **Property24** and **Private Property** every 2 hours for each client's
suburbs and keeps one Google Sheet per client up to date. Each client only gets access to
their own sheet.

Setup takes about 30–45 minutes, once. You need a Google account and a free GitHub account.

---

## What each client's sheet looks like

One tab called **Listings**. New listings appear **at the top**.

| Column | Filled by | What it is |
|---|---|---|
| Added to CRM | robot | Date the listing first appeared in this sheet |
| Portal | robot | Property24 or Private Property |
| Listing Link | robot | Click to open the listing |
| Date Listed | robot | Date the agent listed it on the portal |
| Days on Market | robot | Updates itself every day |
| Listing Price | robot | Current asking price |
| Area | robot | Suburb |
| Agent / Agency | robot | Listing agent and agency |
| Mandate | robot | See "About the Mandate column" below |
| Price Adjusted | robot | "Reduced" / "Increased" (and how many times) |
| Initial Price | robot | First price the system ever saw |
| Previous Price | robot | Price just before the latest change |
| Price Adjusted On | robot | Date of the latest price change |
| **Owner Name & Surname** | **you** | Green header = yours to fill in |
| **Owner Number** | **you** | |
| **Owner Email** | **you** | |
| **Notes** | **you** | |
| Last Seen on Portal | robot | Last date the listing was still live. If it's old, the listing was probably sold or withdrawn |

**Rules the robot follows**

- Only listings that have been on the portal for **3 months or longer** are added. Younger
  listings are watched quietly in the background and added on the day they turn 3 months old.
- **Jawitz Properties** listings are never added.
- A listing is **never added twice**.
- When a price changes, that row turns **amber** and **moves to the top** of the sheet, with the
  initial price and the date of the change filled in. Your owner details and notes stay with it.
- If a Property24 listing was already showing a "Reduced" banner before the robot first saw it,
  the row is marked **"Reduced (before tracking)"** and highlighted. The original price is not
  known in that case.

**Please don't**

- delete or edit the hidden **Listing ID** column (column T), or edit the robot columns.
  The robot uses column T to find each row. Sorting and filtering are fine.
- delete the hidden **_Watchlist** tab. It is the robot's memory.

---

## Step 1 – Create the three Google Sheets

1. Go to <https://sheets.new> three times and name the sheets, e.g. `CRM – Client 1 (Bryanston)`,
   `CRM – Client 2 (Edenburg Woodmead Rivonia)`, `CRM – Client 3 (Lone Hill)`.
2. For each sheet, copy its **ID** from the address bar and keep it for later. The ID is the long
   part between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`1AbC...xYz`**`/edit`

You don't need to add any columns. The robot builds the layout on its first run.

## Step 2 – Create a Google "robot" account (service account)

This gives the robot permission to edit only the sheets you share with it.

1. Go to <https://console.cloud.google.com/> and create a project (e.g. "Property CRM").
2. Open **APIs & Services → Library**, search **Google Sheets API**, and click **Enable**.
3. Open **IAM & Admin → Service Accounts → Create service account**. Name it `property-crm`,
   click **Done** (no roles needed).
4. Click the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file
   downloads. **Keep this file private.**
5. Copy the service account's email (looks like
   `property-crm@your-project.iam.gserviceaccount.com`).
6. In **each** of the three sheets: **Share** → paste that email → **Editor** → untick
   "Notify people" → Share.

## Step 3 – Put the code on GitHub

1. Create a GitHub account if you don't have one: <https://github.com/signup>.
2. Create a new repository named `property-crm`.
   - **Public** is recommended: GitHub's scheduled runs are then free with no limit. Only the
     code is public. Your sheets, client data and keys are **not** in the repository.
   - **Private** also works, but every-2-hours runs for three clients use more than the free
     2,000 minutes a month, so GitHub will charge for the extra minutes. You can cut usage by
     running only during the day (see "Changing the schedule").
3. Upload all the files in this folder, including the hidden `.github` folder. The easiest way:
   on the new repository page, click **uploading an existing file** and drag the whole folder
   contents in. Don't upload `node_modules` or `out`.

## Step 4 – Add the secrets

In the repository: **Settings → Secrets and variables → Actions → New repository secret**.
Add these four:

| Name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Open the `.json` key file from Step 2 in Notepad/TextEdit and paste **the whole contents** |
| `CLIENT1_SHEET_ID` | Sheet ID of Client 1 |
| `CLIENT2_SHEET_ID` | Sheet ID of Client 2 |
| `CLIENT3_SHEET_ID` | Sheet ID of Client 3 |

## Step 5 – First run

1. In the repository, open the **Actions** tab. If asked, click "I understand… enable workflows".
2. Click **Property CRM → Run workflow → Run workflow**.
3. After about a minute, open a sheet: the header row appears, and rows start arriving when
   the run finishes.

**The first day is a build-up period.** Bryanston alone has over 2,000 live listings across
the two portals. To stay polite to the portals, the robot reads at most 500 new listing pages
per client per run, so it takes several runs (around half a day) to catch up. After that each
run only opens new listings and finishes in roughly 10–20 minutes.

From then on it runs automatically every 2 hours.

## Step 6 – Give each client access

Share each client's sheet with **only that client** (Share → their email → Editor). They will
never see each other's sheets, because each sheet is a separate file.

---

## About the Mandate column

Neither portal has a "mandate" field. The robot fills it in like this:

- from the listing description when the agent writes it ("Sole mandate", "Open mandate",
  "Dual mandate", "Exclusive mandate"…)
- **"Multiple agencies (N)"** when Property24 shows the property as "Listed by N Estate
  Agencies", which means it is not on a sole mandate
- **"Not stated"** otherwise

## About MyRoof

MyRoof (bank-assisted and repossessed listings) protects its website with a Cloudflare "verify
you are human" check that blocks automated tools, so it is **not** scraped. Options:

1. **Recommended:** ask MyRoof (or the banks' property divisions) whether they offer agents a
   data feed or API. The code already has a MyRoof slot (`src/portals/myroof.js`) ready to plug
   one into.
2. In the meantime, set up MyRoof's saved-search email alerts for each client's suburbs and add
   those listings to the sheet by hand. The robot leaves rows without a Listing ID alone.

## Changing areas, schedule or rules

- **Areas:** `config/clients.json`. Each area is the address of the portal's search page for
  that suburb.
- **Age rule / excluded agencies:** `minimumListingAgeMonths` and `excludeAgenciesMatching`
  in the same file.
- **Schedule:** `.github/workflows/crm.yml`, line `cron: "7 */2 * * *"` (UTC). For example,
  06:00–20:00 South African time only: `cron: "7 4-18/2 * * *"`.
- **Adding a client:** copy a client block in `config/clients.json` with a new `key` and
  `sheetIdEnv`, add the key to `matrix.client` in the workflow file, then add the secret.

## Notes

- **Area coverage.** Mill Hill, Bryanston East and Pineslopes are sub-areas on Private Property
  (under Bryanston and Lone Hill), so they are covered by those searches. On Property24, Bryanston
  East, Bryanston West and Pineslopes have their own searches. Mill Hill isn't a separate suburb
  on Property24; its listings sit under Bryanston.
- **The same house on both portals** appears as two rows, one per portal, because each portal
  listing has its own link, agent and price history.
- **Website changes.** If a portal changes its page layout, rows may stop arriving or columns
  may come through empty. The run log (Actions tab → latest run → client) will show it, and the
  parsers in `src/portals/` would need a small update.
- **Terms of use and POPIA.** Property24's and Private Property's terms restrict automated
  collection of their content. The robot is deliberately slow (one page every few seconds)
  and only reads public listing pages, but use is at your own risk; ask the portals about
  agent data feeds if you want a fully sanctioned route. Owner contact details you enter are
  personal information under POPIA, so keep each sheet shared only with the client who needs it.

## Running it on your own computer (optional)

```bash
npm install
npx playwright install chromium
npm run dry-run          # writes out/client1.html etc. instead of Google Sheets
```

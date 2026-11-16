# Easy setup: 5 jobs, about 40 minutes

You only do this once. Afterwards the sheets update by themselves every 2 hours.

**Before you start:** open Notepad (Windows) or TextEdit (Mac). You'll paste 5 things into it
as you go, so they're handy at the end:

1. Client 1 sheet ID
2. Client 2 sheet ID
3. Client 3 sheet ID
4. The robot's email address
5. The robot's key file (it downloads to your computer)

---

## Job 1: Make 3 blank Google Sheets (5 min)

1. Go to **sheets.new**. A blank sheet opens.
2. Click "Untitled spreadsheet" at the top left and name it **CRM Client 1**.
3. Look at the web address. Copy the long jumble of letters between `/d/` and `/edit`.
   That's the **sheet ID**. Paste it into Notepad next to "Client 1".

   Example: docs.google.com/spreadsheets/d/**1AbCdEfGh123xyz**/edit → copy `1AbCdEfGh123xyz`
4. Do the same for **CRM Client 2** and **CRM Client 3**.

Leave the sheets empty. The system builds the columns itself.

---

## Job 2: Make the "robot" Google account (15 min)

This is a special Google login that only the system uses, so it can write into your sheets.

1. Go to **console.cloud.google.com** and sign in with your normal Google account.
   Accept the terms if asked.
2. At the top left, click **Select a project** → **New project** → name it `Property CRM` →
   **Create**. Wait a few seconds, then make sure "Property CRM" is selected at the top.
3. In the search bar at the top, type **Google Sheets API**, click it, then click the blue
   **Enable** button.
4. In the search bar, type **Service accounts** and click it.
   - Click **+ Create service account**.
   - Name: `property-crm`. Click **Create and continue**, then **Done**. Skip the optional
     steps.
5. You'll see a new line with an email ending in `iam.gserviceaccount.com`.
   **Copy that email into Notepad.** That's the robot's email.
6. Click that email → the **Keys** tab → **Add key** → **Create new key** → choose **JSON** →
   **Create**. A small file downloads to your computer. That's the robot's key.
   Keep it private: don't email it to anyone.
7. Go back to each of your 3 sheets → click **Share** (top right) → paste the robot's email →
   set it to **Editor** → untick "Notify people" → **Share**.

---

## Job 3: Put the system on GitHub (10 min)

GitHub is a free website that will run the system every 2 hours for you.

1. Sign up at **github.com/signup** (free).
2. Click the **+** at the top right → **New repository**.
   - Name: `property-crm`
   - Choose **Public**. It's free with no limits. Only the program is visible to others;
     your sheets, clients and keys stay private.
   - Click **Create repository**.
3. On your computer, unzip `property-crm.zip` and open the `property-crm` folder.
   - **Mac only:** press **Cmd + Shift + .** (full stop) so you can see the hidden
     `.github` folder.
4. Back on GitHub, click the link **"uploading an existing file"**.
   Select **everything inside** the `property-crm` folder, including `.github`, and drag it
   onto the page. Click **Commit changes**.
5. **Check:** the file list on GitHub must include a `.github` folder. If it's missing, tell
   me and I'll walk you through adding it.

> **Prefer that I do Job 3?** Create the empty repository (steps 1–2), then tell me your
> GitHub username. I can upload everything for you once GitHub is connected to Claude.

---

## Job 4: Give GitHub the 4 secret settings (5 min)

1. In your `property-crm` repository on GitHub, click **Settings** (top menu) →
   **Secrets and variables** (left menu) → **Actions** → **New repository secret**.
2. Add these 4 secrets one at a time. Type the name **exactly** as shown:

| Name (type exactly) | What to paste in "Secret" |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Open the robot key file in Notepad/TextEdit, select **all** of it, copy and paste |
| `CLIENT1_SHEET_ID` | Client 1 sheet ID from your Notepad |
| `CLIENT2_SHEET_ID` | Client 2 sheet ID |
| `CLIENT3_SHEET_ID` | Client 3 sheet ID |

---

## Job 5: Press start (1 min)

1. Click the **Actions** tab. If it asks, click the green button to enable workflows.
2. Click **Property CRM** on the left → **Run workflow** (right side) → green
   **Run workflow**.
3. A yellow dot means it's running; a green tick means it finished. Each run can take up to
   about 1½ hours on the first day.
4. Open a sheet. The headings appear within a minute, and listings appear when the run
   finishes.

**That's it.** From now on it runs by itself every 2 hours.

The first day is a catch-up period: there are thousands of listings to read, so the sheets
fill up over about half a day.

---

## Last step: share with your clients

Open each sheet → **Share** → type **that client's** email → **Editor**.
Give each client only their own sheet.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| Red ❌ on the Actions tab | Click the run → click the client → copy the red text and send it to me |
| Sheet stays completely empty | The robot's email probably wasn't added as **Editor** on that sheet (Job 2, step 7) |
| "Secret not set" / "not set - skipping" | A secret name is misspelled (Job 4); it must match exactly |
| No **Run workflow** button | The `.github` folder didn't upload (Job 3, step 5) |

## Using the sheet day to day

- **Amber rows** = the price changed. "Initial Price" shows the original asking price.
- **Green headings** (Owner Name, Number, Email, Notes) are yours to fill in.
- You can sort and filter freely. Please don't delete the hidden column T or the hidden
  "_Watchlist" tab: the system uses them to remember listings.

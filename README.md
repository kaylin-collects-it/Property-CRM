# Property CRM

Every 2 hours, checks Property24 and Private Property for each client's suburbs and updates
that client's own Google Sheet:

- only listings **3+ months old**
- **Jawitz Properties excluded**
- **newest at the top**, no duplicates
- **price changes highlighted**, with the initial price and the date of the change, and moved to the top
- empty columns for owner name, number, email and notes, which the robot never overwrites

**Start here: [EASY-SETUP.md](EASY-SETUP.md)** (detailed reference: [SETUP.md](SETUP.md))

```
config/clients.json          clients, suburbs, rules (3 months, excluded agencies)
src/run.js                   entry point
src/crm.js                   rules: age filter, exclusions, de-duplication, price tracking
src/portals/property24.js    Property24 reader
src/portals/privateproperty.js  Private Property reader
src/portals/myroof.js        placeholder: MyRoof blocks automated access (see SETUP.md)
src/store-google.js          writes to Google Sheets
src/store-local.js           --dry-run: writes out/<client>.html/.csv instead
.github/workflows/crm.yml    the every-2-hours schedule (GitHub Actions)
test/                        npm test
```

# Waitlist → Google Sheet

Every new waitlist signup is stored in Ivy (Admin → Waitlist, with CSV export)
and, once this is set up, also appended live to a Google Sheet you own.

## One-time setup (about two minutes)

1. Create a new Google Sheet. In row 1 put these headers, one per column:

   `Joined` · `First name` · `Last name` · `Email` · `Phone` · `OK to contact` · `Source`

2. In the sheet: **Extensions → Apps Script**. Delete whatever is in the editor and paste:

   ```javascript
   function doPost(e) {
     var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
     var d = JSON.parse(e.postData.contents || '{}');
     sheet.appendRow([
       d.joined ? new Date(d.joined) : new Date(),
       d.firstName || '',
       d.lastName || '',
       d.email || '',
       d.phone || '',
       d.consent || '',
       d.source || '',
     ]);
     return ContentService.createTextOutput('ok');
   }
   ```

3. **Deploy → New deployment**. Type: **Web app**. Execute as: **Me**. Who has
   access: **Anyone**. Click Deploy, approve the permissions, and copy the
   **Web app URL** (it ends in `/exec`).

4. In Vercel: **Settings → Environment Variables**, add

   `WAITLIST_SHEET_WEBHOOK_URL` = the Web app URL

   for Production, then **Redeploy**.

Admin → Waitlist will say "Every new signup is also added to your Google Sheet"
once the variable is in place.

## Notes

- The sheet is a mirror. If Google is slow or down the signup still succeeds
  and the row is still in Ivy; it just will not appear in the sheet.
- Repeat submissions from the same email do not add a second row.
- If you later edit the Apps Script, use **Deploy → Manage deployments → Edit →
  New version** so the same URL keeps working.

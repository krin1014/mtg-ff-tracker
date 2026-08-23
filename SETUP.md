# Setup Guide

How to put your tracker online and connect it to a Google Sheet so your
collection follows you between your laptop and your phone.

---

## How it works

Two pieces, and they stay separate on purpose:

```
   THE PAGE                              YOUR DATA
   ────────                              ─────────
   Lives on GitHub Pages                 Lives in YOUR Google Sheet
   Public website                        Private to you
   Same for everyone                     Different for every person

   Card names, pictures, prices          Which cards you own
   (1,365 cards, built in)               How many, what finish
                                         Condition, storage location

              The page reads and writes your sheet.
              You can also open the sheet and edit it by hand.
```

**Why a Google Sheet?**

- Your collection is *yours*. It never touches the website's code.
- You can open the sheet on your phone and fix a number by hand.
- It syncs automatically between every device you use.
- Anyone else can use the same website with their own sheet.

**What you'll do:**

| Part | What | How long |
|---|---|---|
| 1 | Put the website on GitHub Pages | 20 min |
| 2 | Create your Google Sheet | 2 min |
| 3 | Add the sync script to your sheet | 10 min |
| 4 | Connect the website to your sheet | 2 min |
| 5 | Put it on your phone | 5 min |

Do Parts 1–4 on a **laptop**. Part 5 is the phone part.

---

# Part 1 — Put the website on GitHub Pages

**→ This part has its own guide: [GITHUB-SETUP.md](GITHUB-SETUP.md)**

It walks through making a GitHub account, creating the repository, uploading the
files and switching the website on, assuming no technical background. About 20
minutes, plus 10 minutes of waiting.

Come back here once your tracker loads at
`https://YOUR-USERNAME.github.io/mtg-ff-tracker/`.

<details>
<summary><b>Already comfortable with Git? The short version.</b></summary>

Create a **public** repository called `mtg-ff-tracker` with **no** README,
`.gitignore` or licence (an initialised repo makes the first push a non-fast-forward).

```bash
cd "/c/Users/carin/OneDrive/Desktop/MTG"
git init -b main
git add .
git commit -m "Final Fantasy MTG collection tracker"
git remote add origin https://github.com/YOUR-USERNAME/mtg-ff-tracker.git
git push -u origin main
```

Then **Settings** → **Pages** → Source: **Deploy from a branch** → **main** →
**/ (root)** → **Save**.

Note this differs from the browser route in [GITHUB-SETUP.md](GITHUB-SETUP.md),
which turns **Add README on** — correct there, wrong here.

</details>

---

# Part 2 — Create your Google Sheet

1. Go to <https://sheets.new>

   That creates a brand-new empty spreadsheet.

2. Click **Untitled spreadsheet** at the top-left and give it a name, like:
   ```
   My FF Card Collection
   ```

That's it. **Leave it completely empty** — the script builds the columns for you
in the next part.

✅ **You'll know it worked when:** you have a blank, named spreadsheet open.

**Keep this tab open**, you need it for Part 3.

---

# Part 3 — Add the sync script

This is the fiddliest part. Take it slowly; you only ever do it once.

## Step 1 — Open the script editor

In your spreadsheet, click **Extensions** → **Apps Script**.

A new tab opens with a code editor. It has a few lines of placeholder code in it
that look like this:

```javascript
function myFunction() {

}
```

## Step 2 — Paste in the script

1. Click anywhere in the code area and select all of it (**Ctrl + A**), then
   delete it.

2. Open the file `google-apps-script/Code.gs` from your MTG folder, select all of
   it, and copy it.

3. Paste it into the empty Apps Script editor.

4. Click the **save icon** (💾) near the top.

✅ **You'll know it worked when:** the tab at the top of the editor stops saying
"Untitled project" — or if it still does, click that name and rename it to
`FF Tracker Sync`.

## Step 3 — Publish it

1. Click the blue **Deploy** button (top-right) → **New deployment**.

2. Next to **Select type**, click the **gear icon** ⚙️ and choose **Web app**.

3. Fill in the form:

   | Field | What to choose |
   |---|---|
   | **Description** | `FF tracker sync` (or anything) |
   | **Execute as** | **Me** |
   | **Who has access** | **Anyone** |

   > **"Anyone" sounds alarming — here's what it actually means.** It means
   > anyone who has the long secret web address you're about to get. It does
   > **not** list your sheet anywhere or make it searchable. Treat that address
   > like a password and you're fine.
   >
   > It has to be "Anyone" because your phone's browser talks to the script
   > without being signed into Google.

4. Click **Deploy**.

## Step 4 — Give it permission

Google will now ask you to authorise your own script. The wording is scary but
this is completely normal for a script you wrote yourself.

1. Click **Authorize access**.

2. Choose your Google account.

3. You'll see a warning: **"Google hasn't verified this app"**.

   Click **Advanced** (small link, bottom-left), then click
   **Go to FF Tracker Sync (unsafe)**.

   > This warning appears for every personal Apps Script. "Unverified" just means
   > you didn't pay Google to review it. You wrote it; it only touches your own
   > spreadsheet.

4. Click **Allow**.

## Step 5 — Copy your web address

You'll land on a **Deployment successfully updated** screen showing a **Web app**
URL that looks like this:

```
https://script.google.com/macros/s/AKfycb.....................­/exec
```

**Click Copy.** Then paste it somewhere safe for a moment — a note, an email to
yourself, your password manager.

✅ **You'll know it worked when:** you have a long address ending in `/exec`.

> 🔑 **This address is the key to your sheet.** Anyone who has it can read and
> change your collection. Don't post it publicly. If it ever leaks, see
> "Starting over with a new address" in Troubleshooting.

---

# Part 4 — Connect the website to your sheet

1. Open your tracker: `https://YOUR-USERNAME.github.io/mtg-ff-tracker/`

2. The first time you visit, it asks how you want to save your collection.
   Choose **Sync with a Google Sheet**.

   > Already past that screen? Click **Sync** in the top bar (or **Tools** →
   > **Sync** on a phone).

3. Paste your `/exec` address into the box.

4. Click **Test connection**.

   You should see a green message naming your spreadsheet, like
   **Connected to "My FF Card Collection" - 0 card rows found.**

5. Click **Save and sync**.

✅ **You'll know it worked when:** you switch back to your Google Sheet tab,
refresh it, and see two new tabs at the bottom: **Collection** and **_meta**,
with proper column headings.

## Try it

1. In the tracker, find any card and tap a variant chip to add a copy.
2. Wait about five seconds — the Sync button will say **Synced**.
3. Refresh your Google Sheet. That card is now a row in it.

Now go the other way:

4. In the sheet, change that card's `foil` number to `3` and press Enter.
5. Back in the tracker, click **Sync** → **Sync now**.
6. The card now shows 3 foils.

That's the whole loop. 🎉

---

# Part 5 — Put it on your phone

## Add it to your Home Screen

**On iPhone**, in **Safari** (not Chrome):

1. Open `https://YOUR-USERNAME.github.io/mtg-ff-tracker/`
2. Tap the **⋯** button to the right of the address bar, then tap **Share**
   - *If your address bar is at the bottom or top instead, tap the **Share**
     icon — the square with an arrow pointing up.*
3. Scroll down and tap **Add to Home Screen**
   - *Not there? Scroll to the bottom, tap **Edit Actions**, and add it.*
4. Turn on **Open as Web App**
5. Tap **Add**

**On Android**, in Chrome: tap **⋮** → **Install app** (some versions say **Add
to Home screen**).

## Connect your phone to the same sheet

1. Open the app from your new Home Screen icon.
2. Choose **Sync with a Google Sheet**.
3. Paste the same `/exec` address.
4. **Save and sync.**

Your collection appears. Both devices are now looking at the same sheet.

> 💡 **Getting the address onto your phone:** email it to yourself, or put it in
> a password manager, or text it to yourself. Don't try to retype it — it's long
> and one wrong character breaks it.

## Two phone quirks worth knowing

**1. Use the Home Screen icon, not a Safari tab.**

Safari and the Home Screen app keep *completely separate* storage. If you enter
cards in a Safari tab and then add the app to your Home Screen, the app opens
empty. Because your real collection lives in the sheet this isn't a disaster —
just reconnect — but it's confusing when it happens.

**2. Safari clears website data after 7 days of not visiting.**

Home Screen apps are exempt from this. Another reason to use the icon.

Neither of these can lose your collection, because **your sheet is the real
copy** and your phone is just a window onto it. That's the whole point of this
design.

---

# Part 6 — Sharing it with a friend

Anyone can use your website with their own sheet. Nothing of theirs comes near
your data, and nothing of yours goes near theirs.

Send them:

1. Your website address: `https://YOUR-USERNAME.github.io/mtg-ff-tracker/`
2. A link to `google-apps-script/Code.gs` in your repository
3. These instructions: **"Do Parts 2, 3 and 4 of the setup guide."**

They skip Part 1 entirely — your website is already published, and they use it
with their own sheet.

> Never share your own `/exec` address. That's yours.

---

# Troubleshooting

### The website

**"404 — There isn't a GitHub Pages site here" right after clicking Save**
Normal. Wait 10 minutes.

**Still 404 after an hour**
- Is the file named exactly `index.html`? **Capital letters matter** —
  `Index.html` won't work.
- Is `index.html` at the top level, not inside a folder?
- Is your GitHub email verified?
- Is Pages set to branch **main**, folder **/ (root)**?

**The page loads but has no colours or no cards**
Something didn't upload. Check that `style.css`, `app.js` and `cards_data.js` are
all in your repository.

**I updated a file but the website shows the old version**
Wait 10 minutes. If it persists, fully close every tab of the site (and the
Home Screen app) and reopen it.

### Syncing

**"Test connection" fails**

Work through these in order:

1. **Does the address end in `/exec`?** If it ends in `/dev`, that's the wrong
   one — go back to Apps Script → **Deploy** → **Manage deployments** and copy
   the Web app URL from there.
2. **Did you set "Who has access" to "Anyone"?** If it says "Only myself" or
   "Anyone with a Google account", your phone can't reach it. Fix it:
   **Deploy** → **Manage deployments** → pencil icon ✏️ → change it →
   **Deploy**.
3. **Did you finish the "Allow" step?** If you clicked away during the
   permissions screen, the script was never authorised. Redeploy and complete it.
4. **Any typo?** Copy and paste the whole address again — don't retype it.

**It worked, then stopped after I edited the script**
Apps Script keeps serving the old version until you publish a new one:
**Deploy** → **Manage deployments** → pencil icon ✏️ → **Version** →
**New version** → **Deploy**. The address stays the same.

**"Saving…" never turns into "Saved"**
Check your internet. The tracker keeps your changes locally and pushes them the
moment it reconnects — nothing is lost in the meantime.

**Two devices disagree**
Click **Sync now** on both. The tracker merges card by card, keeping whichever
change is newer. It never wipes one device's work with the other's.

**Starting over with a new address**
If your `/exec` address leaks, go to Apps Script → **Deploy** →
**Manage deployments** → **Archive** the old deployment, then **New deployment**
to create a fresh one. Paste the new address into the tracker on each device.
Your sheet and its data are untouched.

### Your sheet

**I edited the sheet by hand and the tracker didn't notice**
Click **Sync** → **Sync now**. The tracker checks on load and after each change,
not continuously.

**I broke something editing the sheet**
Google Sheets keeps full history: **File** → **Version history** →
**See version history**, then restore an earlier one.

**Can I delete a row?**
Yes, but setting all its numbers to `0` is safer — deleting a row while a device
still holds that card can bring it back on the next sync.

---

# Quick reference

| Thing | Where it is |
|---|---|
| Your website | `https://YOUR-USERNAME.github.io/mtg-ff-tracker/` |
| Your sheet | <https://sheets.google.com> |
| Your script | Sheet → **Extensions** → **Apps Script** |
| Change who can access | Apps Script → **Deploy** → **Manage deployments** |
| Publish website changes | `git add .` → `git commit -m "..."` → `git push` |

| Limit | Value |
|---|---|
| Website publish delay | up to 10 minutes |
| Website rebuilds | 10 per hour |
| Google Apps Script runtime | about 90 minutes per day total — a save takes well under a second |
| Sheet size | 10 million cells — you'll never get close |

---

## What's automatic

**Card prices refresh themselves.** On the 1st of each month, a scheduled job
fetches fresh data from Scryfall and updates the website if anything changed. You
don't have to do anything.

To run it early: your repository → **Actions** tab → **Refresh card data** →
**Run workflow**.

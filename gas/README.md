# GAS Dashboard — Setup Guide

Two files to copy into a Google Apps Script project:
- `Code.gs` — backend (doPost + doGet + server functions)
- `dashboard.html` — the web UI

---

## Step 1 — Create a Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) → **New spreadsheet**
2. Rename Sheet1 to **`Digest`**
3. Add a second sheet named **`ProjectUpdates`**
4. Copy the Spreadsheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

---

## Step 2 — Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) → **New project**
2. Delete the default `myFunction` code
3. Paste the contents of `Code.gs`
4. Replace `YOUR_SPREADSHEET_ID_HERE` with your Sheet ID
5. Click **+ (Add file)** → **HTML** → name it exactly **`dashboard`**
6. Paste the contents of `dashboard.html`
7. Click **Save** (💾)

---

## Step 3 — Deploy as Web App

1. Click **Deploy** → **New deployment**
2. Click ⚙️ gear → **Web app**
3. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone
4. Click **Deploy** → **Authorize** (grant permissions when prompted)
5. Copy the **Web app URL** — it looks like:
   `https://script.google.com/macros/s/AKfycb.../exec`

> [!TIP]
> **Safari/iOS Support**: If you are using Safari (desktop or mobile) and are logged into multiple Google accounts, Safari's Intelligent Tracking Prevention (ITP) blocks the cookies needed to select a session. You can completely bypass this check by modifying the URL to use Google's wildcard directory:
> `https://script.google.com/a/*/macros/s/AKfycb.../exec`

---

## Step 4 — Configure Electron App

1. Open **DailyUpdates Desktop** → **General Settings**
2. Check ✅ **Push updates to web dashboard**
3. Paste the Web App URL into **GAS Dashboard Web App URL**
4. Click **Save Settings**

From now on, after each scrape run the data will be pushed to your dashboard automatically.

---

## Step 5 — Install Git Hook (optional)

```bash
cp scripts/post-tag.sh .git/hooks/post-tag
chmod +x .git/hooks/post-tag
```

Now whenever you run `git tag v2.x.x -m "Description"`, a project update is auto-pushed.

---

## Manual Project Update Push

```bash
node scripts/push-project-update.js \
  --version "v2.1.0" \
  --title   "System tray & auto-launch" \
  --summary "App now runs in the background. Tray icon added." \
  --changes "feat:System tray background mode,feat:Auto-launch at login,fix:Missing tray icons" \
  --tags    "feature,macos,background"
```

Or just run `node scripts/push-project-update.js` with no args for interactive mode.

---

## Redeployment (after edits)

If you edit `Code.gs` or `dashboard.html` later:
1. **Deploy** → **Manage deployments** → Edit (✏️) → **New version** → **Deploy**
2. The URL stays the same — no need to update Electron settings.

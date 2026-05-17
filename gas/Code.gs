/**
 * DailyUpdates Hub — Google Apps Script Backend
 *
 * Setup:
 * 1. Create a new Google Sheet. Copy its ID from the URL.
 * 2. Paste SPREADSHEET_ID below.
 * 3. In Apps Script editor: create two sheets named "Digest" and "ProjectUpdates".
 * 4. Deploy → New deployment → Web app → Execute as Me → Access: Anyone.
 * 5. Copy the Web App URL into the Electron Settings → Dashboard URL.
 */

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = '1U8zcJE2fQrAAH4qFptsg1TLfy9gTMYUKM4SC1YzYcrs';
const SHEET_DIGEST  = 'Digest';
const SHEET_PROJECT = 'ProjectUpdates';

// ── SHEET COLUMN INDEXES (0-based) ───────────────────────────────────────────
// Digest:  runId | timestamp | category | briefSummary | deepSummaryHtml |
//          glossaryJson | profilesJson | tweetsJson | isRead | readAt
const D = { runId:0, ts:1, cat:2, brief:3, deep:4, gloss:5, profiles:6, tweets:7, isRead:8, readAt:9 };

// Project: updateId | timestamp | version | title | summary |
//          changesJson | tags | isRead | readAt
const P = { id:0, ts:1, ver:2, title:3, summary:4, changes:5, tags:6, isRead:7, readAt:8 };

// ── WEB APP ENTRY POINTS ──────────────────────────────────────────────────────

function doGet(e) {
  // ?markRead=id&type=digest  — lightweight read-tracking from GET request
  if (e && e.parameter && e.parameter.markRead) {
    const id   = e.parameter.markRead;
    const type = e.parameter.type || 'digest';
    _setRead(id, type);
  }
  if (e && e.parameter && e.parameter.clearData === 'true') {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    ['Digest', 'ProjectUpdates'].forEach(name => {
      const sheet = ss.getSheetByName(name);
      if (sheet && sheet.getLastRow() > 1) {
        sheet.deleteRows(2, sheet.getLastRow() - 1);
      }
    });
    return ContentService.createTextOutput("Data cleared.");
  }
  return HtmlService.createHtmlOutputFromFile('dashboard')
    .setTitle('DailyUpdates Hub')
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const type = payload.type || 'digest';
    if (type === 'digest')         return _handleDigestPush(payload);
    if (type === 'project_update') return _handleProjectPush(payload);
    return _jsonResponse({ error: 'Unknown payload type' });
  } catch (err) {
    return _jsonResponse({ error: err.message });
  }
}

// ── SERVER-SIDE FUNCTIONS (called from HTML via google.script.run) ────────────

/** Returns all digest runs, newest first. */
function getDigestData() {
  const rows = _getSheet(SHEET_DIGEST).getDataRange().getValues();
  if (rows.length <= 1) return [];
  return rows.slice(1).map(r => ({
    runId:           String(r[D.runId]),
    timestamp:       r[D.ts],
    category:        r[D.cat],
    briefSummary:    r[D.brief],
    deepSummaryHtml: r[D.deep],
    glossary:        _parseJson(r[D.gloss], []),
    profiles:        _parseJson(r[D.profiles], []),
    tweets:          _parseJson(r[D.tweets], []),
    isRead:          r[D.isRead] === true || r[D.isRead] === 'TRUE',
    readAt:          r[D.readAt]
  })).reverse();
}

/** Returns all project updates, newest first. */
function getProjectData() {
  const rows = _getSheet(SHEET_PROJECT).getDataRange().getValues();
  if (rows.length <= 1) return [];
  return rows.slice(1).map(r => ({
    updateId:  String(r[P.id]),
    timestamp: r[P.ts],
    version:   r[P.ver],
    title:     r[P.title],
    summary:   r[P.summary],
    changes:   _parseJson(r[P.changes], []),
    tags:      r[P.tags] ? String(r[P.tags]).split(',').map(t => t.trim()) : [],
    isRead:    r[P.isRead] === true || r[P.isRead] === 'TRUE',
    readAt:    r[P.readAt]
  })).reverse();
}

/** Mark a single item as read. Called from UI. */
function markAsRead(id, type) {
  try {
    _setRead(id, type);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Mark all items of a given type as read. */
function markAllAsRead(type) {
  try {
    const sheetName = type === 'project_update' ? SHEET_PROJECT : SHEET_DIGEST;
    const sheet = _getSheet(sheetName);
    const last  = sheet.getLastRow();
    if (last <= 1) return { ok: true };
    const col   = type === 'project_update' ? P.isRead + 1 : D.isRead + 1;
    const colAt = type === 'project_update' ? P.readAt + 1 : D.readAt + 1;
    const now   = new Date().toISOString();
    for (let i = 2; i <= last; i++) {
      sheet.getRange(i, col).setValue(true);
      sheet.getRange(i, colAt).setValue(now);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── PUSH HANDLERS ─────────────────────────────────────────────────────────────

function _handleDigestPush(payload) {
  const sheet = _getSheet(SHEET_DIGEST);

  // Ensure header row exists
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['runId','timestamp','category','briefSummary','deepSummaryHtml',
                     'glossaryJson','profilesJson','tweetsJson','isRead','readAt']);
  }

  // Deduplication — skip if runId already exists
  const runId = String(payload.runId || '');
  if (runId && _rowExists(sheet, 0, runId)) {
    return _jsonResponse({ ok: true, skipped: true, reason: 'duplicate runId' });
  }

  sheet.appendRow([
    runId,
    new Date(payload.timestamp || Date.now()).toISOString(),
    payload.category   || '',
    payload.briefSummary    || '',
    payload.deepSummaryHtml || '',
    JSON.stringify(payload.glossary  || []),
    JSON.stringify(payload.profiles  || []),
    JSON.stringify(payload.tweets    || []),
    false,
    ''
  ]);

  return _jsonResponse({ ok: true });
}

function _handleProjectPush(payload) {
  const sheet = _getSheet(SHEET_PROJECT);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['updateId','timestamp','version','title','summary',
                     'changesJson','tags','isRead','readAt']);
  }

  const updateId = String(payload.updateId || payload.version || Date.now());
  if (_rowExists(sheet, 0, updateId)) {
    return _jsonResponse({ ok: true, skipped: true, reason: 'duplicate updateId' });
  }

  sheet.appendRow([
    updateId,
    new Date(payload.timestamp || Date.now()).toISOString(),
    payload.version || '',
    payload.title   || '',
    payload.summary || '',
    JSON.stringify(payload.changes || []),
    (payload.tags || []).join(','),
    false,
    ''
  ]);

  return _jsonResponse({ ok: true });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function _getSheet(name) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet   = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function _rowExists(sheet, colIndex, value) {
  const rows = sheet.getDataRange().getValues();
  return rows.some((r, i) => i > 0 && String(r[colIndex]) === String(value));
}

function _setRead(id, type) {
  const sheetName = type === 'project_update' ? SHEET_PROJECT : SHEET_DIGEST;
  const sheet     = _getSheet(sheetName);
  const isReadCol = type === 'project_update' ? P.isRead + 1 : D.isRead + 1;
  const readAtCol = type === 'project_update' ? P.readAt + 1 : D.readAt + 1;
  const idCol     = 1; // column A = 1-indexed

  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      sheet.getRange(i + 1, isReadCol).setValue(true);
      sheet.getRange(i + 1, readAtCol).setValue(new Date().toISOString());
      return;
    }
  }
}

function _parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function _jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Logger — Centralized Logging
 *
 * Replaces the chrome.storage.local log system from the extension.
 *
 * Features:
 * - Keeps last 1500 log entries in memory
 * - Persists to <userData>/logs.json on disk
 * - Broadcasts each new log entry to the renderer window via a callback
 *   (main.js hooks this callback to mainWindow.webContents.send)
 */

const fs = require('fs');
const path = require('path');

let logsFilePath = null;
let logs = [];
let broadcastCallback = null;
const MAX_LOGS = 1500;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Initialize logger. Must be called once at app startup.
 * @param {string} userDataDir
 * @param {Function} onNewLog - Called with (logEntry) whenever a new log is added
 */
function init(userDataDir, onNewLog) {
    logsFilePath = path.join(userDataDir, 'logs.json');
    broadcastCallback = onNewLog;

    if (!fs.existsSync(logsFilePath)) {
        fs.writeFileSync(logsFilePath, JSON.stringify([]), 'utf8');
    }

    try {
        const raw = fs.readFileSync(logsFilePath, 'utf8');
        logs = JSON.parse(raw);
        // Prune stale logs on load
        const now = Date.now();
        logs = logs.filter(l => (now - l.timestamp) < TWO_DAYS_MS);
    } catch (err) {
        console.error('[Logger] Failed to parse logs.json — starting fresh:', err.message);
        logs = [];
    }
}

/**
 * Add a log entry.
 * @param {string} message
 * @param {'info'|'warn'|'error'} level
 */
function add(message, level = 'info') {
    const entry = { timestamp: Date.now(), message, level };

    console.log(`[${level.toUpperCase()}] ${message}`);

    logs.push(entry);

    // Prune stale entries
    const now = Date.now();
    logs = logs.filter(l => (now - l.timestamp) < TWO_DAYS_MS);

    // Keep max 1500
    if (logs.length > MAX_LOGS) {
        logs = logs.slice(-MAX_LOGS);
    }

    // Persist to disk (async, fire-and-forget to avoid blocking)
    _flush();

    // Broadcast to renderer
    if (broadcastCallback) {
        try {
            broadcastCallback(entry);
        } catch (_) { }
    }
}

/**
 * Get all log entries (newest last).
 * @returns {Array}
 */
function getAll() {
    return [...logs];
}

/**
 * Clear all logs.
 */
function clear() {
    logs = [];
    _flush();
}

function _flush() {
    if (!logsFilePath) return;
    try {
        fs.writeFileSync(logsFilePath, JSON.stringify(logs), 'utf8');
    } catch (err) {
        console.error('[Logger] Failed to write logs.json:', err.message);
    }
}

module.exports = { init, add, getAll, clear };

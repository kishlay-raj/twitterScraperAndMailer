/**
 * Store — Persistent Data Layer
 *
 * Replaces chrome.storage.local. Reads/writes a single JSON file at:
 *   <userData>/data.json
 *
 * Provides a synchronous-style get/set/remove API similar to the extension,
 * but backed by a real file on disk that survives restarts.
 */

const fs = require('fs');
const path = require('path');

let dataFilePath = null;
let cache = {};

/**
 * Initialize the store. Must be called once at app startup.
 * @param {string} userDataDir - Electron's app.getPath('userData')
 */
function init(userDataDir) {
    dataFilePath = path.join(userDataDir, 'data.json');

    // Create the file if it doesn't exist
    if (!fs.existsSync(dataFilePath)) {
        fs.writeFileSync(dataFilePath, JSON.stringify({}), 'utf8');
    }

    // Load into memory cache
    try {
        const raw = fs.readFileSync(dataFilePath, 'utf8');
        cache = JSON.parse(raw);
    } catch (err) {
        console.error('[Store] Failed to parse data.json — starting fresh:', err.message);
        cache = {};
    }
}

/**
 * Persist the current in-memory cache to disk.
 */
function _flush() {
    if (!dataFilePath) return;
    try {
        fs.writeFileSync(dataFilePath, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
        console.error('[Store] Failed to write data.json:', err.message);
    }
}

/**
 * Get a value by key. Returns undefined if not found.
 * @param {string} key
 * @returns {*}
 */
function get(key) {
    return cache[key];
}

/**
 * Set a key-value pair and persist to disk.
 * @param {string} key
 * @param {*} value
 */
function set(key, value) {
    cache[key] = value;
    _flush();
}

/**
 * Remove a key and persist to disk.
 * @param {string} key
 */
function remove(key) {
    delete cache[key];
    _flush();
}

/**
 * Get the entire data object.
 * @returns {Object}
 */
function getAll() {
    return { ...cache };
}

/**
 * Replace the entire data object and persist to disk.
 * Used for config import.
 * @param {Object} data
 */
function setAll(data) {
    cache = { ...data };
    _flush();
}

module.exports = { init, get, set, remove, getAll, setAll };

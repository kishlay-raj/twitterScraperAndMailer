/**
 * Electron Preload Script
 *
 * Bridges the renderer (UI) and the main process (Node.js/Electron APIs)
 * via a secure contextBridge. The renderer has zero access to Node.js —
 * it can only call the methods explicitly exposed here.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

    // ── Settings ────────────────────────────────────────────────────────────
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

    // ── Categories ──────────────────────────────────────────────────────────
    getCategories: () => ipcRenderer.invoke('get-categories'),
    saveCategories: (categories) => ipcRenderer.invoke('save-categories', categories),

    // ── Logs ────────────────────────────────────────────────────────────────
    getLogs: () => ipcRenderer.invoke('get-logs'),
    clearLogs: () => ipcRenderer.invoke('clear-logs'),

    /**
     * Register a callback to receive new log entries in real-time.
     * The main process broadcasts via 'log-entry' channel whenever addLog() is called.
     */
    onLog: (callback) => {
        ipcRenderer.on('log-entry', (event, logEntry) => callback(logEntry));
    },

    // ── Run Actions ─────────────────────────────────────────────────────────
    runNow: () => ipcRenderer.invoke('run-now'),
    runCategory: (categoryIndex) => ipcRenderer.invoke('run-category', categoryIndex),
    stopRun: () => ipcRenderer.invoke('stop-run'),
    getRunStatus: () => ipcRenderer.invoke('get-run-status'),
    openLogin: () => ipcRenderer.invoke('open-login'),

    // ── Import / Export ─────────────────────────────────────────────────────
    exportConfig: () => ipcRenderer.invoke('export-config'),
    importConfig: () => ipcRenderer.invoke('import-config'),

    // ── Login Status Events ──────────────────────────────────────────────────
    // removeAllListeners() before re-adding prevents listener accumulation
    // if the renderer page is ever reloaded (e.g. via devtools).
    /** Called when the scraper detects X.com is not logged in. */
    onLoginRequired: (cb) => {
        ipcRenderer.removeAllListeners('login-required');
        ipcRenderer.on('login-required', (_e, payload) => cb(payload));
    },
    /** Called when the scraper detects login was completed. */
    onLoginResolved: (cb) => {
        ipcRenderer.removeAllListeners('login-resolved');
        ipcRenderer.on('login-resolved', (_e, payload) => cb(payload));
    },
    /** Called when the 20-minute login wait timed out. */
    onLoginTimeout: (cb) => {
        ipcRenderer.removeAllListeners('login-timeout');
        ipcRenderer.on('login-timeout', (_e, payload) => cb(payload));
    },
});

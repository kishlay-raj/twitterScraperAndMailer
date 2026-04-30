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

    // ── Import / Export ─────────────────────────────────────────────────────
    exportConfig: () => ipcRenderer.invoke('export-config'),
    importConfig: () => ipcRenderer.invoke('import-config'),
});

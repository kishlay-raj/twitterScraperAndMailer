/**
 * DailyUpdates Desktop App — Electron Main Process
 *
 * Responsibilities:
 * - Creates the main BrowserWindow (the UI)
 * - Creates the system tray icon for background operation
 * - Registers all IPC handlers (bridge between UI and core logic)
 * - Bootstraps the scheduler and browser pool on startup
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const store = require('./core/store');
const logger = require('./core/logger');
const scheduler = require('./core/scheduler');
const browserPool = require('./core/browser-pool');
const orchestrator = require('./core/orchestrator');

let mainWindow = null;
let tray = null;

// ─── Window Creation ────────────────────────────────────────────────────────

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 800,
        minWidth: 700,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'DailyUpdates Curation',
        icon: path.join(__dirname, '..', 'icons', 'icon48.png'),
        show: false, // Don't show until ready-to-show
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Minimize to tray instead of closing
    mainWindow.on('close', (event) => {
        if (tray && !app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ─── System Tray ────────────────────────────────────────────────────────────

function createTray() {
    const iconPath = path.join(__dirname, '..', 'icons', 'icon16.png');
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    tray.setToolTip('DailyUpdates Curation');

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open DailyUpdates',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                } else {
                    createWindow();
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Run Now',
            click: async () => {
                try {
                    await orchestrator.runAllCategories();
                } catch (err) {
                    logger.add(`❌ Tray Run Now failed: ${err.message}`, 'error');
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

function registerIpcHandlers() {

    // Settings
    ipcMain.handle('get-settings', async () => {
        return store.get('settings') || {};
    });

    ipcMain.handle('save-settings', async (event, settings) => {
        store.set('settings', settings);
        // Re-apply the schedule whenever settings are saved
        scheduler.updateSchedule(settings, () => orchestrator.runAllCategories());
        return { success: true };
    });

    // Categories
    ipcMain.handle('get-categories', async () => {
        return store.get('categories') || [];
    });

    ipcMain.handle('save-categories', async (event, categories) => {
        store.set('categories', categories);
        return { success: true };
    });

    // Logs
    ipcMain.handle('get-logs', async () => {
        return logger.getAll();
    });

    ipcMain.handle('clear-logs', async () => {
        logger.clear();
        return { success: true };
    });

    // Run Now (all categories)
    ipcMain.handle('run-now', async () => {
        // Fire and forget — logger.init() broadcasts every log to the renderer automatically
        orchestrator.runAllCategories().catch(err => {
            logger.add(`❌ Run Now failed: ${err.message}`, 'error');
        });
        return { status: 'started' };
    });

    // Run Single Category
    ipcMain.handle('run-category', async (event, categoryIndex) => {
        orchestrator.runSingleCategory(categoryIndex).catch(err => {
            logger.add(`❌ Single category run failed: ${err.message}`, 'error');
        });
        return { status: 'started' };
    });

    // Import / Export config
    ipcMain.handle('export-config', async () => {
        const data = store.getAll();
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Config',
            defaultPath: 'dailyupdates-config.json',
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (filePath) {
            require('fs').writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            return { success: true, filePath };
        }
        return { success: false };
    });

    ipcMain.handle('import-config', async () => {
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Import Config',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile']
        });
        if (filePaths && filePaths[0]) {
            const raw = require('fs').readFileSync(filePaths[0], 'utf8');
            const data = JSON.parse(raw);
            store.setAll(data);
            // Re-apply schedule with new settings
            const settings = data.settings || {};
            scheduler.updateSchedule(settings, () => orchestrator.runAllCategories());
            return { success: true, data };
        }
        return { success: false };
    });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    // Set up data store, logger, and IPC
    store.init(app.getPath('userData'));
    logger.init(app.getPath('userData'), (logEntry) => {
        // Broadcast every new log to the renderer in real-time
        if (mainWindow) mainWindow.webContents.send('log-entry', logEntry);
    });

    createWindow();
    createTray();
    registerIpcHandlers();

    // Launch the shared Puppeteer browser instance
    const userDataDir = path.join(app.getPath('userData'), 'chrome-session');
    await browserPool.launch(userDataDir);
    logger.add('🚀 DailyUpdates Desktop started. Browser pool ready.', 'info');

    // Apply saved schedule
    const settings = store.get('settings') || {};
    scheduler.updateSchedule(settings, () => orchestrator.runAllCategories());

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    // Keep running in the background on all platforms (via tray)
    // app.quit() is only called explicitly via the tray menu
});

app.on('before-quit', (event) => {
    // Electron does NOT await async event handlers — the process would exit
    // before browserPool.close() completes, leaving Chromium as an orphan.
    // Solution: prevent the default quit, do async cleanup, then exit cleanly.
    event.preventDefault();
    app.isQuitting = true;
    scheduler.stop();
    logger.add('👋 DailyUpdates Desktop shutting down.', 'info');
    browserPool.close()
        .catch(err => console.error('[Main] Error closing browser on quit:', err))
        .finally(() => app.exit(0));
});

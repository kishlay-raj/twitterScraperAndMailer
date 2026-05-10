/**
 * DailyUpdates Desktop App — Electron Main Process
 *
 * Responsibilities:
 * - Creates the main BrowserWindow (the UI)
 * - Creates the system tray icon for background operation
 * - Registers all IPC handlers (bridge between UI and core logic)
 * - Bootstraps the scheduler and browser pool on startup
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, powerSaveBlocker } = require('electron');
const path = require('path');
const store = require('./core/store');
const logger = require('./core/logger');
const scheduler = require('./core/scheduler');
const browserPool = require('./core/browser-pool');
const orchestrator = require('./core/orchestrator');
const idleDetect = require('./core/idle-detect');

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
        const oldSettings = store.get('settings') || {};
        store.set('settings', settings);
        // Re-apply the schedule whenever settings are saved
        scheduler.updateSchedule(settings, () => orchestrator.runAllCategories());

        // If browser mode changed, restart the browser pool
        const oldMode = oldSettings.browserMode || (oldSettings.headlessMode !== false ? 'headless' : 'visible');
        const newMode = settings.browserMode || 'headless';
        if (oldMode !== newMode) {
            const userDataDir = path.join(app.getPath('userData'), 'chrome-session');
            let headless;
            if (newMode === 'smart') {
                // Smart mode: determine based on current idle state
                const { isIdle } = await idleDetect.checkIdle();
                headless = !isIdle;
                logger.add(`🧠 Smart Mode activated. Currently ${isIdle ? 'idle → visible' : 'active → headless'}.`, 'info');
            } else {
                headless = newMode !== 'visible';
            }
            browserPool.restartWithMode(userDataDir, headless).catch(err => {
                logger.add(`⚠️ Browser restart failed: ${err.message}`, 'error');
            });
            logger.add(`🔄 Browser mode changed to ${newMode}.`, 'info');
        }
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

    // Stop Run
    ipcMain.handle('stop-run', async () => {
        const stopped = orchestrator.stopRun();
        return { stopped };
    });

    // Run status (is a scrape currently running?)
    ipcMain.handle('get-run-status', async () => {
        return { isRunning: orchestrator.getIsRunning() };
    });

    // Open Login Page (visible browser for X.com login)
    ipcMain.handle('open-login', async () => {
        const userDataDir = path.join(app.getPath('userData'), 'chrome-session');
        try {
            logger.add('🔐 Opening X.com login page in visible browser...', 'info');
            await browserPool.openLoginPage(userDataDir);
            return { success: true };
        } catch (err) {
            logger.add(`❌ Failed to open login page: ${err.message}`, 'error');
            return { success: false, error: err.message };
        }
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
        console.log('[Main] import-config invoked');
        try {
            const result = await dialog.showOpenDialog(mainWindow, {
                title: 'Import Config',
                filters: [{ name: 'JSON', extensions: ['json'] }],
                properties: ['openFile']
            });
            console.log('[Main] showOpenDialog result:', result);

            // User cancelled the dialog
            if (result.canceled || !result.filePaths || !result.filePaths[0]) {
                console.log('[Main] Import cancelled (no file selected)');
                return { success: false, cancelled: true };
            }

            const filePath = result.filePaths[0];
            console.log('[Main] Reading file:', filePath);
            const raw = require('fs').readFileSync(filePath, 'utf8');
            console.log(`[Main] Read ${raw.length} bytes`);
            let data;
            try {
                data = JSON.parse(raw);
            } catch (parseErr) {
                console.error('[Main] JSON parse error:', parseErr.message);
                return { success: false, error: `Invalid JSON file: ${parseErr.message}` };
            }
            console.log('[Main] Successfully parsed JSON. Keys:', Array.isArray(data) ? '[array]' : Object.keys(data));

            // Handle legacy format where export was just an array of categories
            // (Chrome extension only exported categories, never settings)
            let settingsImported = true;
            if (Array.isArray(data)) {
                console.log('[Main] Imported data is an array. Treating as legacy categories-only export.');
                settingsImported = false; // Tell the renderer not to overwrite UI settings
                const currentSettings = store.get('settings') || {};
                data = {
                    settings: currentSettings, // preserve what's already saved
                    categories: data
                };
            } else if (!data.settings) {
                // Object format but no settings key — preserve current settings
                settingsImported = false;
                data.settings = store.get('settings') || {};
            }

            // Validate minimal structure
            if (typeof data !== 'object' || data === null) {
                return { success: false, error: 'Imported file does not contain a valid config object.' };
            }

            store.setAll(data);
            console.log('[Main] store.setAll completed');

            // Re-apply schedule with new settings
            const settings = data.settings || {};
            console.log('[Main] Updating schedule with new settings (keys):', Object.keys(settings));
            scheduler.updateSchedule(settings, () => orchestrator.runAllCategories());

            console.log('[Main] import-config completed successfully. settingsImported:', settingsImported);
            return { success: true, data, settingsImported };
        } catch (err) {
            console.error('[Main] import-config error:', err);
            return { success: false, error: err.message };
        }
    });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    // ── Prevent macOS App Nap ────────────────────────────────────────────────
    // When the window is hidden (minimized to tray), macOS suspends the app
    // and freezes ALL timers — including node-cron. This prevents scheduled
    // runs from ever firing. powerSaveBlocker keeps the process alive.
    const blockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log(`[Main] powerSaveBlocker started (id=${blockerId}) — App Nap disabled.`);

    // Set up data store, logger, and IPC
    store.init(app.getPath('userData'));
    logger.init(app.getPath('userData'), (logEntry) => {
        // Broadcast every new log to the renderer in real-time
        if (mainWindow) mainWindow.webContents.send('log-entry', logEntry);
    });

    createWindow();
    createTray();
    registerIpcHandlers();

    // Wire up orchestrator → renderer event bridge (login-required, etc.)
    orchestrator.setNotifyRenderer((channel, payload) => {
        if (mainWindow) mainWindow.webContents.send(channel, payload);
    });

    // Launch the shared Puppeteer browser instance
    const userDataDir = path.join(app.getPath('userData'), 'chrome-session');
    const savedSettings = store.get('settings') || {};
    const browserMode = savedSettings.browserMode || (savedSettings.headlessMode !== false ? 'headless' : 'visible');
    let headless;
    if (browserMode === 'smart') {
        const { isIdle } = await idleDetect.checkIdle();
        headless = !isIdle;
    } else {
        headless = browserMode !== 'visible';
    }
    await browserPool.launch(userDataDir, headless);
    logger.add(`🚀 DailyUpdates Desktop started. Browser pool ready (mode: ${browserMode}, ${headless ? 'headless' : 'visible'}).`, 'info');

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

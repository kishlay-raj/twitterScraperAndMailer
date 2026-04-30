/**
 * Browser Pool — Shared Puppeteer Browser Instance
 *
 * Manages a single long-lived Chromium browser launched at startup.
 * Each profile scrape gets its own fresh Page, which is closed when done.
 *
 * A persistent userDataDir is used so X.com login cookies are preserved
 * between runs — you only need to log in once.
 */

const puppeteer = require('puppeteer');

let browser = null;
let isLaunching = false;

/**
 * Launch the shared browser. Called once at app startup.
 * @param {string} userDataDir - Path to persist cookies/session (Chrome user data directory)
 */
async function launch(userDataDir) {
    if (browser) return;
    if (isLaunching) {
        // Wait for the in-progress launch
        while (isLaunching) {
            await new Promise(r => setTimeout(r, 100));
        }
        return;
    }

    isLaunching = true;
    try {
        browser = await puppeteer.launch({
            headless: false,           // Visible so X can detect genuine browser activity
            userDataDir,               // Persist cookies — login once, works forever
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled', // Reduce bot detection
                '--start-minimized',
            ],
            defaultViewport: null,     // Use natural window viewport
            ignoreHTTPSErrors: true,
        });

        browser.on('disconnected', () => {
            console.warn('[BrowserPool] Browser disconnected unexpectedly.');
            browser = null;
        });

        console.log('[BrowserPool] Browser launched successfully.');
    } finally {
        isLaunching = false;
    }
}

/**
 * Open a new page in the shared browser.
 * Auto-relaunches the browser if it was unexpectedly closed.
 * @param {string} userDataDir - Needed for relaunch if browser died
 * @returns {Promise<import('puppeteer').Page>}
 */
async function newPage(userDataDir) {
    if (!browser) {
        console.warn('[BrowserPool] Browser not running, relaunching...');
        await launch(userDataDir);
    }

    const page = await browser.newPage();

    // Mask automation flags to reduce X bot detection
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Set a realistic user agent
    await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    return page;
}

/**
 * Gracefully close the shared browser. Called on app quit.
 */
async function close() {
    if (browser) {
        try {
            await browser.close();
        } catch (_) { }
        browser = null;
    }
}

/**
 * Get the raw Puppeteer browser instance (for advanced use).
 */
function getBrowser() {
    return browser;
}

module.exports = { launch, newPage, close, getBrowser };

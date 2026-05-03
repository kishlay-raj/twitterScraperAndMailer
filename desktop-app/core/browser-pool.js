/**
 * Browser Pool — Shared Puppeteer Browser Instance
 *
 * Manages a single long-lived Chromium browser launched at startup.
 * Each profile scrape gets its own fresh Page, which is closed when done.
 *
 * A persistent userDataDir is used so X.com login cookies are preserved
 * between runs — you only need to log in once.
 */

// URLs that indicate X.com redirected us to the login / sign-up wall
const LOGIN_URL_PATTERNS = [
    'x.com/i/flow/login',
    'x.com/login',
    'twitter.com/login',
    'x.com/i/flow/signup',
];

const puppeteer = require('puppeteer');

let browser = null;
let isLaunching = false;
let currentHeadless = true; // Track current headless mode

/**
 * Launch the shared browser. Called once at app startup.
 * @param {string} userDataDir - Path to persist cookies/session (Chrome user data directory)
 * @param {boolean} [headless=true] - true = new headless (invisible), false = visible Chrome (minimized)
 */
async function launch(userDataDir, headless = true) {
    if (browser) return;
    if (isLaunching) {
        // Wait for the in-progress launch
        while (isLaunching) {
            await new Promise(r => setTimeout(r, 100));
        }
        return;
    }

    isLaunching = true;
    currentHeadless = headless;
    try {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled', // Reduce bot detection
            '--window-size=1280,900',       // Give it a proper viewport so X renders correctly
        ];

        // When running headful, push the window off-screen and start minimized
        if (!headless) {
            args.push('--start-minimized');
            args.push('--window-position=9999,9999');
        }

        browser = await puppeteer.launch({
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: headless ? 'new' : false,
            userDataDir,               // Persist cookies — login once, works forever
            args,
            defaultViewport: null,     // Use natural window viewport
            ignoreHTTPSErrors: true,
        });

        browser.on('disconnected', () => {
            console.warn('[BrowserPool] Browser disconnected unexpectedly.');
            browser = null;
        });

        console.log(`[BrowserPool] Browser launched successfully (headless: ${headless}).`);
    } finally {
        isLaunching = false;
    }
}

/**
 * Close the current browser and relaunch with the given headless mode.
 * Used when the user toggles the headless setting at runtime.
 * @param {string} userDataDir
 * @param {boolean} headless
 */
async function restartWithMode(userDataDir, headless) {
    if (currentHeadless === headless && browser) {
        console.log('[BrowserPool] Already running in requested mode, skipping restart.');
        return;
    }
    console.log(`[BrowserPool] Restarting browser (headless: ${headless})...`);
    await close();
    await launch(userDataDir, headless);
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
        await launch(userDataDir, currentHeadless);
    }

    const page = await browser.newPage();

    // ── When running headful, minimize the Chrome window via CDP ─────────
    // macOS clips --window-position to screen edges, so the off-screen
    // approach doesn't fully work. Force-minimizing the window ensures it
    // can never steal visual focus regardless of how many tabs are opened.
    if (!currentHeadless) {
        try {
            const session = await page.createCDPSession();
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', {
                windowId,
                bounds: { windowState: 'minimized' },
            });
            await session.detach();
        } catch (e) {
            // Non-fatal — worst case the window is just visible
            console.warn('[BrowserPool] Could not minimize Chrome window:', e.message);
        }
    }

    // Bypass X.com's strict Content-Security-Policy so that page.addScriptTag()
    // (used in scraper-runner.js) can inject our scraper and utils scripts.
    // Without this, addScriptTag throws a CSP violation and the scraper never runs.
    await page.setBypassCSP(true);

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
 * Check whether the stored X.com session is still valid.
 *
 * Opens a temporary page, navigates to x.com/home, and inspects the
 * final URL. If X redirects us to the login flow the session has expired.
 *
 * @param {string} userDataDir - Needed to relaunch the browser if it died
 * @returns {Promise<boolean>} true = logged in, false = needs login
 */
async function checkLoginStatus(userDataDir) {
    let page = null;
    try {
        page = await newPage(userDataDir);
        await page.goto('https://x.com/home', {
            waitUntil: 'domcontentloaded',
            timeout: 45000, // 45s — generous for cold starts / slow connections
        });
        const finalUrl = page.url();
        const isLoggedOut = LOGIN_URL_PATTERNS.some(p => finalUrl.includes(p));
        return !isLoggedOut;
    } catch (err) {
        console.warn('[BrowserPool] Login check failed:', err.message);
        // If we can't even load the page treat it as logged-out so the
        // user has a chance to fix their connection before scraping starts.
        return false;
    } finally {
        if (page) {
            try { await page.close(); } catch (_) { }
        }
    }
}

/**
 * Get the raw Puppeteer browser instance (for advanced use).
 */
function getBrowser() {
    return browser;
}

module.exports = { launch, newPage, close, getBrowser, checkLoginStatus, restartWithMode };

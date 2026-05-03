/**
 * Scraper Runner — Puppeteer Profile Scraper
 *
 * Replaces: chrome.tabs.create + chrome.scripting.executeScript + content script messaging
 *
 * For each profile URL:
 * 1. Opens a new Puppeteer page
 * 2. Navigates to the X profile
 * 3. Waits for the timeline to load
 * 4. Exposes a log bridge so scraper.js can send logs back to Node.js
 * 5. Injects and executes shared/scraper.js in the page context
 * 6. Returns { tweets, profileMeta }
 * 7. Closes the page
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const browserPool = require('./browser-pool');
const logger = require('./logger');

// Load the scraper source once at module init (not per-call)
const SCRAPER_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'shared', 'scraper.js'),
    'utf8'
);
const UTILS_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'shared', 'utils.js'),
    'utf8'
);

const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 5000;
const PAGE_LOAD_TIMEOUT_MS = 60000;
const POST_LOAD_SETTLE_MS = 2000; // Wait after DOM load for dynamic content

/**
 * Scrape a single X profile.
 *
 * @param {string} url - The X profile URL (e.g. https://x.com/username)
 * @param {string[]} globalProcessedIds - Previously seen tweet IDs to skip
 * @param {Object} settings - User settings (scrapeDuration, etc.)
 * @param {Function} addLog - Logging callback
 * @param {number} _retryCount - Internal retry counter
 * @returns {Promise<{ tweets: Object[], profileMeta: Object }>}
 */
async function scrapeProfile(url, globalProcessedIds = [], settings = {}, addLog = logger.add.bind(logger), _retryCount = 0) {
    const userDataDir = path.join(app.getPath('userData'), 'chrome-session');
    let page = null;

    try {
        page = await browserPool.newPage(userDataDir);

        // Expose a bridge so scraper.js bgLog() calls reach our logger
        await page.exposeFunction('__bgLog', (message) => {
            // message already contains the [Scraper] prefix added by bgLog() in scraper.js
            addLog(message, 'info');
        });

        // Inject a mock chrome.runtime.sendMessage so the scraper source works unchanged
        await page.evaluateOnNewDocument(() => {
            window.__bgLog = window.__bgLog || (() => {}); // polyfill in case of timing
            window.chrome = {
                runtime: {
                    sendMessage: (msg) => {
                        if (msg && msg.action === 'log' && msg.message) {
                            window.__bgLog(msg.message);
                        }
                    },
                    lastError: null
                }
            };
        });

        // Navigate to the profile.
        // Use 'domcontentloaded' NOT 'networkidle2' — X.com is a heavy SPA that
        // continuously fires XHR/WebSocket requests, so networkidle2 almost never
        // settles and causes constant 60s timeouts. We manually wait for the tweet
        // selector below, which is a much more reliable signal.
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: PAGE_LOAD_TIMEOUT_MS,
        });

        // Check for error pages (rate limits, suspended accounts, etc.)
        const finalUrl = page.url();
        if (finalUrl.startsWith('chrome-error://') || finalUrl === 'about:blank') {
            throw new Error(`Page failed to load: error page at ${url}`);
        }

        // Wait for X's timeline to appear
        try {
            await page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 });
        } catch (_) {
            // No tweets found — account may be empty or inactive. Return gracefully.
            addLog(`[Scraper] No tweets found for ${url} — may be empty or inactive.`, 'warn');
            return { tweets: [], profileMeta: {} };
        }

        // Extra settle time for lazy-loaded images and dynamic content
        await new Promise(r => setTimeout(r, POST_LOAD_SETTLE_MS));

        // Step 1: Inject utils and scraper into the page's GLOBAL scope.
        // page.addScriptTag() evaluates the script exactly like a <script> tag,
        // so function declarations (randomDelay, humanScroll, extractTweets, etc.)
        // become properties of window — unlike new Function() which creates a
        // local scope and never exposes them on window.
        await page.addScriptTag({ content: UTILS_SOURCE });
        // Disable the Chrome 4-minute timeout guard before injecting scraper.
        // scraper.js has: if (activeTimeMs > 4 * 60 * 1000) break — designed for
        // Chrome MV3 service worker limits. In Puppeteer we have no such limit.
        await page.evaluate(() => { window.__isDesktopApp = true; });
        await page.addScriptTag({ content: SCRAPER_SOURCE });

        // Step 2: Call extractTweets (now on window) with our parameters.
        // IMPORTANT: Only pass the minimal settings extractTweets actually needs
        // (scrapeDuration + scrapeDurationUnit). Do NOT pass the full settings
        // object — it contains API keys and email addresses that would be
        // serialized into X.com's JS heap via page.evaluate.
        const scrapeSettings = {
            scrapeDuration: settings.scrapeDuration,
            scrapeDurationUnit: settings.scrapeDurationUnit,
        };
        const result = await page.evaluate(
            async (processedIds, scrapeSettings) => {
                try {
                    return await window.extractTweets(processedIds, scrapeSettings);
                } catch (err) {
                    return { tweets: [], profileMeta: {}, error: err.message };
                }
            },
            globalProcessedIds,
            scrapeSettings
        );

        if (result.error) {
            throw new Error(result.error);
        }

        return { tweets: result.tweets || [], profileMeta: result.profileMeta || {} };

    } catch (err) {
        const isRetryable = err.message.includes('error page') ||
            err.message.includes('net::') ||
            err.message.includes('timeout') ||
            err.message.includes('Navigation');

        if (isRetryable && _retryCount < MAX_RETRIES) {
            addLog(`[Scraper] Retrying ${url} in ${RETRY_DELAY_MS / 1000}s (attempt ${_retryCount + 1})...`, 'warn');
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            return scrapeProfile(url, globalProcessedIds, settings, addLog, _retryCount + 1);
        }

        throw err;

    } finally {
        if (page) {
            try { await page.close(); } catch (_) { }
        }
    }
}

module.exports = { scrapeProfile };

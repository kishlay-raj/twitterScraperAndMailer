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
async function scrapeProfile(url, globalProcessedIds = [], settings = {}, addLog = logger.add, _retryCount = 0) {
    const userDataDir = path.join(app.getPath('userData'), 'chrome-session');
    let page = null;

    try {
        page = await browserPool.newPage(userDataDir);

        // Expose a bridge so scraper.js bgLog() calls reach our logger
        await page.exposeFunction('__bgLog', (message) => {
            addLog(`[Scraper] ${message}`, 'info');
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

        // Navigate to the profile
        await page.goto(url, {
            waitUntil: 'networkidle2',
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
        await page.addScriptTag({ content: SCRAPER_SOURCE });

        // Step 2: Call extractTweets (now on window) with our parameters.
        const result = await page.evaluate(
            async (processedIds, scrapeSettings) => {
                try {
                    return await window.extractTweets(processedIds, scrapeSettings);
                } catch (err) {
                    return { tweets: [], profileMeta: {}, error: err.message };
                }
            },
            globalProcessedIds,
            settings
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

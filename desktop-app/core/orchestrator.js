/**
 * Orchestrator — Core Scraping & Dispatch Engine
 *
 * Replaces: service_worker.js (scrapeAndDispatchCategory, processAndDispatch,
 * scheduleContinuation, keepServiceWorkerAlive — ALL deleted, not needed in Node.js)
 *
 * Because this runs in a persistent Node.js process with no execution time limits:
 * - All profiles in a category are scraped in ONE uninterrupted loop
 * - One email is dispatched per category — no Part 1/2/3 splits ever
 * - No heartbeats, no continuation alarms, no chrome.alarms
 */

const store = require('./store');
const logger = require('./logger');
const scraperRunner = require('./scraper-runner');
const browserPool = require('./browser-pool');
const idleDetect = require('./idle-detect');
const { summarizeTweets } = require('../shared/llm_api');
const { sendEmailPayload } = require('../shared/email_api');
const { app } = require('electron');
const path = require('path');

let isRunning = false;
let cancelRequested = false;

// Injected by main.js so the orchestrator can push events to the renderer
let _notifyRenderer = null;
function setNotifyRenderer(fn) { _notifyRenderer = fn; }

// ─── Smart Browser Mode ─────────────────────────────────────────────────────

/**
 * If the user has chosen "Smart (Auto)" browser mode, detect whether the
 * laptop is idle (no keyboard/mouse for 5+ minutes) and switch the browser
 * to the optimal mode:
 *
 *   - User IDLE  → visible browser (less bot detection, session stays alive)
 *   - User ACTIVE → headless browser (no window disturbance)
 *
 * For "always-headless" or "always-visible" this is a no-op.
 *
 * @param {Function} addLog
 */
async function _applySmartBrowserMode(addLog) {
    const settings = store.get('settings') || {};
    const mode = settings.browserMode || 'headless'; // 'headless' | 'visible' | 'smart'

    if (mode !== 'smart') return; // Static mode — nothing to do

    const userDataDir = path.join(app.getPath('userData'), 'chrome-session');
    const { isIdle, idleSeconds } = await idleDetect.checkIdle();

    // idle → visible (false), active → headless (true)
    const wantHeadless = !isIdle;

    const idleLabel = isIdle
        ? `idle for ${Math.round(idleSeconds / 60)}m → using visible browser`
        : `active (idle ${idleSeconds}s) → using headless browser`;

    addLog(`🧠 Smart Mode: ${idleLabel}`, 'info');

    await browserPool.restartWithMode(userDataDir, wantHeadless);
}

// ─── Login Gate ──────────────────────────────────────────────────────────────

/**
 * Checks whether X.com is logged in before proceeding.
 * This is a one-shot check — no polling, no waiting.
 *
 * If not logged in:
 *   1. Logs a clear message.
 *   2. Notifies the renderer to show a "Please log in" modal.
 *   3. Returns false immediately — scraping is aborted.
 *
 * The user must log into X.com in the browser window and then
 * manually click "Run Now" again.
 *
 * @param {Function} addLog
 * @returns {Promise<boolean>} true = logged in, false = not logged in (aborted)
 */
async function _ensureLoggedIn(addLog) {
    const userDataDir = path.join(app.getPath('userData'), 'chrome-session');

    let loggedIn;
    try {
        loggedIn = await browserPool.checkLoginStatus(userDataDir);
    } catch (err) {
        addLog(`⚠️ Could not reach X.com to verify login: ${err.message}. Scrape aborted.`, 'error');
        return false;
    }

    if (loggedIn) return true;

    // Not logged in — notify and stop immediately.
    addLog('🔐 Not logged in to X.com. Please log in via the browser window and click Run Now again.', 'warn');
    if (_notifyRenderer) _notifyRenderer('login-required', {});
    return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run all active categories sequentially.
 * @param {Function} [addLog] - Optional log callback (defaults to logger.add)
 */
async function runAllCategories(addLog = logger.add.bind(logger)) {
    if (isRunning) {
        addLog('⚠️ A scrape run is already in progress. Skipping.', 'warn');
        return;
    }
    isRunning = true;
    cancelRequested = false;

    try {
        // ── Smart browser mode: switch headless/visible based on idle state
        await _applySmartBrowserMode(addLog);

        // ── Login gate: abort/wait if not logged in ────────────────────────
        const loggedIn = await _ensureLoggedIn(addLog);
        if (!loggedIn) return;

        const categories = store.get('categories') || [];
        const active = categories.filter(c => c.isActive !== false);

        if (active.length === 0) {
            addLog('No active categories to scrape.', 'warn');
            return;
        }

        addLog(`🚀 Starting scrape run for ${active.length} categories.`);

        for (let i = 0; i < categories.length; i++) {
            if (cancelRequested) {
                addLog('🛑 Run stopped by user.', 'warn');
                break;
            }
            const cat = categories[i];
            if (cat.isActive === false) continue;
            try {
                await _runCategory(i, cat, addLog);
            } catch (err) {
                if (cancelRequested) {
                    addLog('🛑 Run stopped by user.', 'warn');
                    break;
                }
                addLog(`❌ Category [${cat.name}] failed: ${err.message}`, 'error');
            }
        }

        if (!cancelRequested) addLog('✅ All categories complete.');
    } finally {
        isRunning = false;
        cancelRequested = false;
    }
}

/**
 * Run a single category by index (for manual "Run Category" button).
 * @param {number} categoryIndex
 * @param {Function} [addLog]
 */
async function runSingleCategory(categoryIndex, addLog = logger.add.bind(logger)) {
    // Guard: don't allow a single-category run to race with a full run
    // (especially during a login-wait polling loop)
    if (isRunning) {
        addLog('⚠️ A scrape run is already in progress. Skipping single-category run.', 'warn');
        return;
    }
    isRunning = true;
    cancelRequested = false;

    try {
        const categories = store.get('categories') || [];
        const cat = categories[categoryIndex];
        if (!cat) {
            addLog(`❌ Category index ${categoryIndex} not found.`, 'error');
            return;
        }

        // ── Smart browser mode ───────────────────────────────────────────
        await _applySmartBrowserMode(addLog);

        // ── Login gate ────────────────────────────────────────────────────
        const loggedIn = await _ensureLoggedIn(addLog);
        if (!loggedIn) return;

        await _runCategory(categoryIndex, cat, addLog);
        if (cancelRequested) addLog('🛑 Run stopped by user.', 'warn');
    } finally {
        isRunning = false;
        cancelRequested = false;
    }
}

/**
 * Request cancellation of the current run.
 * The run will stop after the currently-scraping profile finishes.
 */
function stopRun() {
    if (!isRunning) return false;
    cancelRequested = true;
    logger.add('🛑 Stop requested — will halt after current profile finishes.', 'warn');
    return true;
}

/** Whether a run is currently in progress. */
function getIsRunning() {
    return isRunning;
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function _runCategory(categoryIndex, category, addLog) {
    const settings = store.get('settings') || {};
    const { geminiApiKey, llmApiKey, emailApiKey: webhookUrl, recipientEmail } = settings;

    if (!webhookUrl || !recipientEmail) {
        addLog(`[${category.name}] ❌ Missing webhook URL or recipient email. Configure settings first.`, 'error');
        return;
    }

    const globalProcessedIds = store.get('processedTweetIds') || [];
    const allowDuplicates = settings.allowDuplicates || false;
    const newIdsThisRun = new Set();

    const compilationPayload = {
        extraEmails: category.enableExtraEmails !== false ? (category.extraEmails || '') : '',
        enableCategorySummary: category.enableCategorySummary === true,
        summaryMode: category.categorySummaryMode || 'minimal',
        enableFactCheck: category.enableFactCheck !== false,
        enableGlossary: category.enableGlossary !== false,
        summaryPrompt: category.summaryPrompt || '',
        profiles: []
    };

    const activeProfiles = (category.profiles || []).filter(p => p.isActive !== false);
    addLog(`[${category.name}] Starting — ${activeProfiles.length} profile(s).`);

    // ── Scrape all profiles in one uninterrupted loop ──────────────────────
    for (const profile of activeProfiles) {
        // ── Check for cancellation between profiles ────────────────────────
        if (cancelRequested) {
            addLog(`[${category.name}] 🛑 Stopping — user requested cancellation.`, 'warn');
            return;
        }

        let targetUrl = profile.url;
        if (profile.scrapeReplies) {
            try {
                const parsed = new URL(targetUrl);
                parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/with_replies';
                targetUrl = parsed.toString();
            } catch (_) {
                targetUrl = targetUrl.replace(/\/+$/, '') + '/with_replies';
            }
        }

        try {
            const idsToPass = allowDuplicates ? [] : globalProcessedIds;
            const scrapeResult = await scraperRunner.scrapeProfile(targetUrl, idsToPass, settings, addLog);
            const rawTweets = scrapeResult.tweets || [];

            let novelTweets = [];
            for (const t of rawTweets) {
                if (allowDuplicates || !globalProcessedIds.includes(t.id)) novelTweets.push(t);
                if (!globalProcessedIds.includes(t.id)) newIdsThisRun.add(t.id);
            }
            if (profile.scrapeRetweets === false) novelTweets = novelTweets.filter(t => !t.isRetweet);

            compilationPayload.profiles.push({
                url: profile.url,
                profileMeta: scrapeResult.profileMeta || {},
                enableAiSummary: profile.enableAiSummary,
                scrapeRetweets: profile.scrapeRetweets !== false,
                tweets: novelTweets
            });

            // Random 2-5s delay between profiles to appear human-like and avoid bot detection
            const interProfileDelay = 2000 + Math.floor(Math.random() * 3000);
            await new Promise(r => setTimeout(r, interProfileDelay));

        } catch (err) {
            addLog(`[${category.name}] ⚠️ Error scraping ${profile.url}: ${err.message}`, 'error');
            compilationPayload.profiles.push({
                url: profile.url, profileMeta: {},
                enableAiSummary: profile.enableAiSummary,
                tweets: [], error: err.message
            });
        }
    }

    // ── Skip dispatch if there is absolutely no content to email ────────────
    const totalTweets = compilationPayload.profiles.reduce((sum, p) => sum + (p.tweets?.length || 0), 0);
    const totalErrors = compilationPayload.profiles.filter(p => p.error).length;
    if (totalTweets === 0 && totalErrors === 0) {
        addLog(`[${category.name}] ⏭️ Skipping email — no tweets found across all profiles.`);
        return;
    }

    // ── Build & dispatch the email ─────────────────────────────────────────
    await _buildAndDispatch(category.name, compilationPayload, geminiApiKey, llmApiKey, webhookUrl, recipientEmail, addLog);

    // ── Save new processed IDs ─────────────────────────────────────────────
    if (newIdsThisRun.size > 0) {
        const latest = store.get('processedTweetIds') || [];
        let combined = [...latest, ...newIdsThisRun];
        if (combined.length > 5000) combined = combined.slice(-5000);
        store.set('processedTweetIds', combined);
    }
}

// ─── Email Build & Dispatch ──────────────────────────────────────────────────

async function _buildAndDispatch(categoryName, categoryData, geminiApiKey, llmApiKey, webhookUrl, recipientEmail, addLog) {
    const { extraEmails, profiles, enableCategorySummary, summaryMode, enableFactCheck, enableGlossary, summaryPrompt } = categoryData;

    // Sort: profiles with content first
    const sortedProfiles = [...profiles].sort((a, b) => {
        const aHas = a.error || a.tweets.length > 0;
        const bHas = b.error || b.tweets.length > 0;
        return aHas === bHas ? 0 : aHas ? -1 : 1;
    });

    // ── Per-profile HTML blocks ────────────────────────────────────────────
    const profileHtmlBlocks = [];
    for (const profile of sortedProfiles) {
        const meta = profile.profileMeta || {};
        const displayName = meta.profileName || '';
        const handle = meta.profileHandle || '';
        const avatarUrl = meta.profileAvatarUrl || '';

        let profileHtml = `
          <tr><td style="padding:16px 28px 0 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                   class="em-profile-card"
                   style="width:100%; background:#f8f7ff; border:1px solid #e0e7ff; border-radius:10px; overflow:hidden;">
              <tr><td style="padding:14px 16px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:56px; vertical-align:middle; padding-right:14px;">
                    <img src="${avatarUrl}" alt="${displayName || handle}" width="56" height="56"
                         style="width:56px; height:56px; border-radius:50%; display:block; object-fit:cover; border:2px solid #6366f1;" />
                  </td>
                  <td style="vertical-align:middle;">
                    <div class="em-profile-name" style="font-weight:700; font-size:15px; color:#111827;">${displayName || handle || 'X Profile'}</div>
                    <a href="${profile.url}" style="font-size:13px; color:#6366f1; text-decoration:none;">${handle || profile.url}</a>
                  </td>
                </tr></table>
              </td></tr>
            </table>
          </td></tr>`;

        if (profile.error) {
            profileHtml += `<tr><td style="padding:10px 28px 16px 28px;">
              <div style="background:#fef2f2; border-left:4px solid #ef4444; border-radius:0 6px 6px 0; padding:12px 14px; font-size:13px; color:#b91c1c; font-weight:600;">
                ⚠️ Error scraping profile: ${profile.error}</div></td></tr>`;
            profileHtmlBlocks.push(profileHtml);
            continue;
        }

        if (profile.tweets.length === 0) {
            profileHtml += `<tr><td style="padding:10px 28px 20px 28px;">
              <div class="em-no-update" style="background:#fffbeb; border-left:4px solid #fbbf24; border-radius:0 6px 6px 0; padding:12px 14px; font-size:13px; color:#92400e; font-style:italic;">
                📭 No new updates found in the last 24 hours.</div></td></tr>`;
            profileHtmlBlocks.push(profileHtml);
            continue;
        }

        if (profile.enableAiSummary) {
            let summary = '';
            try {
                summary = await summarizeTweets(profile.tweets, geminiApiKey, llmApiKey, summaryPrompt);
            } catch (e) {
                summary = `<em style="color:#dc2626;">⚠️ AI Summary failed: ${e.message}</em>`;
            }
            profileHtml += `<tr><td style="padding:12px 28px 4px 28px;">
              <div class="em-ai-summary-box" style="background:#f0fdf4; border-left:4px solid #22c55e; border-radius:0 8px 8px 0; padding:14px 16px;">
                <div style="font-size:12px; font-weight:700; color:#15803d; text-transform:uppercase; margin-bottom:6px;">✨ AI Summary</div>
                <div style="font-size:14px; color:#1c1917; line-height:1.65;">${summary}</div>
              </div></td></tr>`;
        }

        // Individual tweets
        profileHtml += `<tr><td style="padding:10px 28px 20px 28px;">`;
        const maxDisplay = 15;
        const tweetsToShow = profile.tweets.slice(0, maxDisplay);
        tweetsToShow.forEach((t, idx) => {
            const dateStr = new Date(t.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
            const isLast = idx === tweetsToShow.length - 1;
            const borderBottom = isLast ? '' : 'border-bottom:1px solid #f3f4f6;';
            const bgColor = t.isSubscriberOnly ? '#fdf2f8' : '#ffffff';
            const border = t.isSubscriberOnly ? 'border:1.5px solid #fbcfe8; border-radius:8px;' : '';
            const padding = t.isSubscriberOnly ? 'padding:14px;' : `padding:12px 0; ${borderBottom}`;

            profileHtml += `<div class="em-tweet" style="background:${bgColor}; ${border} ${padding} margin-bottom:${t.isSubscriberOnly ? '10px' : '0'};">
              <span class="em-ts" style="font-size:11px; color:#9ca3af;">🕒 ${dateStr}</span>
              ${t.isSubscriberOnly ? `<span style="margin-left:8px; background:#ec4899; color:#fff; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700;">⭐ SUBSCRIBERS ONLY</span>` : ''}
              ${t.isRetweet ? `<div style="font-size:12px; color:#10b981; font-weight:700; margin:4px 0;">🔁 Reposted from ${t.authorName} (${t.authorHandle})</div>` : ''}
              ${t.replyContext ? `<div style="border-left:3px solid #d1d5db; background:#f9fafb; padding:10px 12px; margin-bottom:10px; border-radius:0 6px 6px 0;">
                <div style="font-size:11px; color:#6b7280; margin-bottom:5px; font-weight:600;">↩️ Replying to <span style="color:#6366f1;">${t.replyContext.authorHandle || ''}</span></div>
                <div style="font-size:13px; color:#374151; font-style:italic;">${(t.replyContext.text || '').slice(0, 280)}</div>
              </div>` : ''}
              <div class="em-text" style="font-size:14px; color:#111827; line-height:1.6; margin-bottom:8px; word-break:break-word;">${t.text}</div>
              ${t.quotedTweet ? `<div style="border:1px solid #e0e7ff; border-left:3px solid #6366f1; border-radius:0 8px 8px 0; background:#f8f7ff; padding:10px 14px; margin-bottom:10px;">
                <div style="font-size:11px; color:#6366f1; font-weight:700; margin-bottom:5px;">🔗 Quoted · ${t.quotedTweet.authorName || ''} ${t.quotedTweet.authorHandle || ''}</div>
                <div style="font-size:13px; color:#374151;">${(t.quotedTweet.text || '').slice(0, 280)}</div>
              </div>` : ''}
              ${t.mediaUrls && t.mediaUrls.length > 0 ? `<div style="margin-bottom:8px;">${t.mediaUrls.map(u => `<img src="${u}" alt="media" width="100%" style="max-width:260px; border-radius:8px; display:inline-block; margin:0 4px 4px 0;" />`).join('')}</div>` : ''}
              <a href="${t.url}" style="font-size:12px; color:#6366f1; text-decoration:none; font-weight:600;">View on X →</a>
            </div>`;
        });

        if (profile.tweets.length > maxDisplay) {
            profileHtml += `<div style="padding:12px 0; text-align:center; border-top:1px solid #e5e7eb;">
              <a href="${profile.url}" style="font-size:13px; color:#6366f1; font-weight:600; text-decoration:none;">+ ${profile.tweets.length - maxDisplay} more tweets... View Full Profile</a>
            </div>`;
        }

        profileHtml += `</td></tr>`;
        profileHtmlBlocks.push(profileHtml);
    }

    // ── Category-level summary block ──────────────────────────────────────
    const categorySummaryBlocks = [];
    if (enableCategorySummary) {
        addLog(`[${categoryName}] Category Summarise ON. Generating summary...`);
        const allTweets = sortedProfiles.filter(p => !p.error && p.tweets.length > 0).flatMap(p => p.tweets);

        if (allTweets.length > 0) {
            const tweetsForSummary = allTweets.sort((a, b) => b.timestamp - a.timestamp).slice(0, 60);
            addLog(`[${categoryName}] Summarising ${tweetsForSummary.length} tweets...`);

            try {
                const summaryText = await summarizeTweets(
                    tweetsForSummary, geminiApiKey, llmApiKey, summaryPrompt,
                    enableFactCheck, enableGlossary, summaryMode || 'minimal'
                );
                addLog(`[${categoryName}] ✅ Category summary generated (${summaryText?.length ?? 0} chars).`);
                const totalTweets = allTweets.length;
                const totalProfiles = sortedProfiles.filter(p => p.tweets.length > 0).length;

                categorySummaryBlocks.push(`
          <!-- CATEGORY SUMMARY -->
          <tr><td style="padding:20px 28px 12px 28px;">
            <div class="em-summary-box" style="background:#f5f3ff; border:1.5px solid #a78bfa; border-radius:10px; padding:18px 20px;">
              <div style="font-size:13px; font-weight:800; color:#6d28d9; text-transform:uppercase; letter-spacing:0.6px; margin-bottom:10px;">
                ✨ Category Summary
                <span style="font-size:11px; font-weight:500; color:#8b5cf6; text-transform:none; background:#ede9fe; border-radius:10px; padding:2px 8px; margin-left:8px;">
                  ${totalTweets} tweet${totalTweets !== 1 ? 's' : ''} across ${totalProfiles} profile${totalProfiles !== 1 ? 's' : ''}
                </span>
              </div>
              <div style="font-size:14px; color:#1c1917; line-height:1.75;">${summaryText}</div>
            </div>
          </td></tr>
          <!-- DIVIDER -->
          <tr><td style="padding:4px 28px 10px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>
              <td style="border-top:1px solid #e0e7ff; padding-right:10px;"></td>
              <td style="white-space:nowrap; font-size:11px; font-weight:700; color:#6366f1; text-transform:uppercase; letter-spacing:0.8px; padding:0 10px;">📋 Individual Profiles</td>
              <td style="border-top:1px solid #e0e7ff; padding-left:10px;"></td>
            </tr></table>
          </td></tr>`);
            } catch (e) {
                addLog(`[${categoryName}] ⚠️ Summary error: ${e.message}. Email will be sent without summary.`, 'warn');
                categorySummaryBlocks.push(`
          <tr><td style="padding:20px 28px 12px 28px;">
            <div style="background:#fff7ed; border:1.5px solid #fb923c; border-radius:10px; padding:14px 18px;">
              <div style="font-size:12px; font-weight:800; color:#c2410c; text-transform:uppercase; margin-bottom:8px;">⚠️ AI Summary Unavailable</div>
              <div style="font-size:13px; color:#7c2d12;">The AI summary could not be generated. Raw tweets are below.</div>
              <div style="margin-top:10px; padding:10px 12px; background:#fff; border:1px solid #fed7aa; border-radius:6px; font-size:11.5px; color:#9a3412; font-family:monospace; word-break:break-word;">
                <strong>Reason:</strong> ${(e.message || '').slice(0, 300)}
              </div>
            </div>
          </td></tr>`);
            }
        } else {
            addLog(`[${categoryName}] Category summary skipped — no tweets found.`);
        }
    }

    // ── Chunk blocks into size-limited emails ────────────────────────────
    const allBlocks = [...categorySummaryBlocks, ...profileHtmlBlocks];
    const MAX_BODY_BYTES = 180 * 1024;
    const encoder = new TextEncoder();
    const emailChunks = [];
    let currentChunk = [], currentChunkSize = 0;
    const shellOverhead = encoder.encode(_buildEmailShell(categoryName, '', [])).length;

    for (const block of allBlocks) {
        const blockSize = encoder.encode(block).length;
        if (currentChunk.length > 0 && (currentChunkSize + blockSize + shellOverhead) > MAX_BODY_BYTES) {
            emailChunks.push(currentChunk);
            currentChunk = []; currentChunkSize = 0;
        }
        currentChunk.push(block);
        currentChunkSize += blockSize;
    }
    if (currentChunk.length > 0) emailChunks.push(currentChunk);

    // ── Dispatch each chunk ──────────────────────────────────────────────
    addLog(`Compilation complete for ${categoryName}. ${emailChunks.length} email(s) to send.`);

    let allRecipients = recipientEmail;
    if (extraEmails) {
        const extra = extraEmails.split(',').map(e => e.trim()).filter(Boolean).join(',');
        if (extra) allRecipients = `${recipientEmail},${extra}`;
    }

    const summaryPrefix = (enableCategorySummary && categorySummaryBlocks.length > 0) ? '✨ ' : '';

    for (let ci = 0; ci < emailChunks.length; ci++) {
        const chunkLabel = emailChunks.length > 1 ? `Email ${ci + 1}/${emailChunks.length}` : '';
        const emailSubject = `${summaryPrefix}Curation: ${categoryName}${chunkLabel ? ` (${chunkLabel})` : ''}`;
        const emailHtml = _buildEmailShell(categoryName, chunkLabel, emailChunks[ci]);
        const bodySizeKB = (encoder.encode(emailHtml).length / 1024).toFixed(1);

        addLog(`Dispatching [${categoryName}]${chunkLabel ? ` ${chunkLabel}` : ''} to: ${allRecipients} (${bodySizeKB} KB)`);
        try {
            await sendEmailPayload(emailHtml, allRecipients, webhookUrl, emailSubject, null);
            addLog(`✅ Email for [${categoryName}]${chunkLabel ? ` ${chunkLabel}` : ''} dispatched successfully.`);
        } catch (e) {
            addLog(`❌ Email dispatch FAILED for [${categoryName}]: ${e.message}`, 'error');
        }

        if (ci < emailChunks.length - 1) await new Promise(r => setTimeout(r, 1500));
    }

    await new Promise(r => setTimeout(r, 1500));
}

// ─── Email Shell Template ────────────────────────────────────────────────────

function _buildEmailShell(categoryName, partLabel, profileBlocks) {
    const header = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="light dark">
<style>
  @media (prefers-color-scheme: dark) {
    .em-outer { background:#111118 !important; }
    .em-card  { background:#19191f !important; }
    .em-tweet { background:#1e1e2e !important; border-color:#2d2d42 !important; }
    .em-text  { color:#e4e4f0 !important; }
    .em-muted { color:#9494b0 !important; }
    .em-ts    { color:#6b6b88 !important; }
    .em-profile-card { background:#1e1e2e !important; border-color:#2d2d42 !important; }
    .em-profile-name { color:#e4e4f0 !important; }
    .em-no-update { background:#1e1a10 !important; border-color:#78580a !important; color:#f0c040 !important; }
    .em-summary-box { background:#1a1628 !important; border-color:#6d28d9 !important; }
    .em-footer { background:#111118 !important; border-color:#2d2d42 !important; }
    .em-footer-text { color:#6b6b88 !important; }
  }
</style>
</head>
<body>
<div class="em-outer" style="background:#f4f4f5; padding:24px 12px; font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"
       class="em-card"
       style="width:100%; max-width:600px; margin:0 auto; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.08);">
  <!-- HEADER -->
  <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed); padding:28px 28px 20px 28px; text-align:center;">
    <div style="font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">🛰️ DailyUpdates Curation</div>
    <div style="font-size:13px; color:#c7d2fe; margin-top:4px;">${categoryName}${partLabel ? ` — ${partLabel}` : ''}</div>
  </td></tr>
  <!-- INTRO -->
  <tr><td style="padding:20px 28px 8px 28px;">
    <p class="em-muted" style="margin:0; font-size:14px; color:#6b7280; line-height:1.6;">
      Your 24-hour digest from X profiles in <strong style="color:#111827;">${categoryName}</strong>.
    </p>
  </td></tr>
`;

    const footer = `
  <!-- FOOTER -->
  <tr><td class="em-footer" style="background:#f8f7ff; border-top:1px solid #e0e7ff; padding:16px 28px; text-align:center;">
    <div class="em-footer-text" style="font-size:12px; color:#9ca3af;">
      Sent by <strong style="color:#6366f1;">DailyUpdates Desktop</strong>
      &nbsp;·&nbsp;
      <span>${new Date().toLocaleDateString([], { dateStyle: 'medium' })}</span>
    </div>
  </td></tr>
</table>
</div>
</body>
</html>`;

    return header + profileBlocks.join('') + footer;
}

module.exports = { runAllCategories, runSingleCategory, setNotifyRenderer, stopRun, getIsRunning };

importScripts('llm_api.js', 'email_api.js');

// Listener from Popup UI and Content Scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start_scraping") {
        scheduleCategoryScrapes();
        sendResponse({ status: 'Sequence started' });
    } else if (request.action === "start_category_scraping") {
        startSingleCategoryScrape(request.categoryIndex);
        sendResponse({ status: 'Category sequence started' });
    } else if (request.action === "update_schedule") {
        updateSchedule(request.settings);
        sendResponse({ status: 'Schedule updated' });
    } else if (request.action === "log") {
        addLog(request.message, request.level || "info");
    } else if (request.action === "toggle_block") {
        updateTwitterBlock(request.block).then(() => {
            sendResponse({ status: 'updated', isBlocked: request.block });
        });
        return true; // async
    } else if (request.action === "get_block_status") {
        chrome.storage.local.get(['twitterBlocked'], (res) => {
            sendResponse({ isBlocked: !!res.twitterBlocked });
        });
        return true; // async
    }
});

/**
 * Updates declarativeNetRequest rules to block or unblock X/Twitter
 */
async function updateTwitterBlock(shouldBlock, isTemporaryUnblock = false) {
    const RULE_ID_X = 101;
    const RULE_ID_TWITTER = 102;

    if (shouldBlock) {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [RULE_ID_X, RULE_ID_TWITTER],
            addRules: [
                {
                    id: RULE_ID_X,
                    priority: 1,
                    action: { type: "block" },
                    condition: { urlFilter: "||x.com", resourceTypes: ["main_frame", "sub_frame"] }
                },
                {
                    id: RULE_ID_TWITTER,
                    priority: 1,
                    action: { type: "block" },
                    condition: { urlFilter: "||twitter.com", resourceTypes: ["main_frame", "sub_frame"] }
                }
            ]
        });
        addLog("Twitter blocking ACTIVATED.");
        await chrome.storage.local.set({ twitterBlocked: true, twitterWasBlockedTemporarily: false });

        // Inject a block overlay to any tabs currently open on Twitter/X to ensure the block is immediately effective
        chrome.tabs.query({ url: ["*://*.x.com/*", "*://*.twitter.com/*", "*://x.com/*", "*://twitter.com/*"] }, (tabs) => {
            if (tabs && tabs.length > 0) {
                for (let tab of tabs) {
                    try {
                        chrome.scripting.executeScript({
                            target: { tabId: tab.id, allFrames: true },
                            func: () => {
                                document.body.innerHTML = `
                                    <div style="display:flex; height:100vh; width:100vw; background:#f9fafb; align-items:center; justify-content:center; flex-direction:column; font-family:sans-serif; position:fixed; top:0; left:0; z-index:999999999;">
                                        <h1 style="color:#ef4444; font-size:32px; margin-bottom:10px; font-weight:bold;">🚫 X (Twitter) is Blocked</h1>
                                        <p style="color:#64748b; font-size:16px;">This page has been restricted by DailyUpdates Curation.</p>
                                    </div>
                                `;
                                document.body.style.margin = "0";
                                document.body.style.overflow = "hidden";
                            }
                        });
                    } catch (e) { }
                }
                addLog(`Injected block screen into ${tabs.length} existing Twitter tab(s).`);
            }
        });

    } else {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [RULE_ID_X, RULE_ID_TWITTER]
        });
        addLog(isTemporaryUnblock ? "Twitter blocking TEMPORARILY DEACTIVATED for scraping." : "Twitter blocking DEACTIVATED.");
        await chrome.storage.local.set({
            twitterBlocked: false,
            twitterWasBlockedTemporarily: isTemporaryUnblock
        });
    }
}

let logQueue = [];
let isSavingLogs = false;

/**
 * Adds a log entry to storage and prunes logs older than 2 days
 */
async function addLog(message, level = "info") {
    console.log(`[${level.toUpperCase()}] ${message}`);
    
    logQueue.push({
        timestamp: Date.now(),
        message,
        level
    });

    if (isSavingLogs) return;
    isSavingLogs = true;

    try {
        while (logQueue.length > 0) {
            // Grab the current batch of queued logs
            const batch = [...logQueue];
            logQueue = [];

            const { logs = [] } = await chrome.storage.local.get(['logs']);
            const now = Date.now();
            const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

            // Prune old logs
            const filteredLogs = logs.filter(log => (now - log.timestamp) < twoDaysMs);

            // Add new logs
            filteredLogs.push(...batch);

            // Keep only last 500 logs to prevent storage bloat
            const limitedLogs = filteredLogs.slice(-500);

            await chrome.storage.local.set({ logs: limitedLogs });
        }
    } finally {
        isSavingLogs = false;
    }
}

// Alarm Listener
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "dailyScrapeAlarm") {
        console.log("Scheduled Scrape Alarm triggered!");
        scheduleCategoryScrapes();
    } else if (alarm.name === "dailyUnblockAlarm") {
        handleDailyUnblock();
    } else if (alarm.name.startsWith("scrapeCategory_")) {
        const categoryIndex = parseInt(alarm.name.split("_")[1]);
        console.log(`Category Alarm triggered for index ${categoryIndex}!`);
        scrapeAndDispatchCategory(categoryIndex);
    }
});

// Function to update the daily alarm based on settings
async function updateSchedule(settings) {
    if (!settings) {
        const { settings: storedSettings } = await chrome.storage.local.get(['settings']);
        settings = storedSettings;
    }

    if (!settings) return;

    // Clear existing schedule alarm to recreate or disable
    await chrome.alarms.clear("dailyScrapeAlarm");
    await chrome.alarms.clear("dailyUnblockAlarm");

    if (settings.enableSchedule && settings.scheduleTime) {
        console.log(`Setting up daily scrape alarm for ${settings.scheduleTime}`);

        // Parse "HH:MM"
        const [hours, minutes] = settings.scheduleTime.split(':').map(Number);

        let nextRun = new Date();
        nextRun.setHours(hours, minutes, 0, 0);

        // If the time has already passed today, schedule for tomorrow
        if (nextRun.getTime() <= Date.now()) {
            nextRun.setDate(nextRun.getDate() + 1);
        }

        // Create an alarm that fires at the given timestamp and then exactly every 24 hours
        chrome.alarms.create("dailyScrapeAlarm", {
            when: nextRun.getTime(),
            periodInMinutes: 24 * 60 // 24 hours
        });

        // Create an alarm 5 minutes prior to unblock Twitter cleanly in advance
        chrome.alarms.create("dailyUnblockAlarm", {
            when: nextRun.getTime() - (5 * 60 * 1000), // 5 mins before
            periodInMinutes: 24 * 60
        });

        console.log(`Next run scheduled for ${nextRun.toLocaleString()}`);
    } else {
        console.log("Daily schedule is disabled.");
    }
}

// On install or startup, make sure the schedule is set
chrome.runtime.onStartup.addListener(() => updateSchedule());
chrome.runtime.onInstalled.addListener(() => updateSchedule());

// ============================================================
// SCHEDULER: Schedules each category as an independent alarm
// spaced 10 minutes apart so each gets a fresh execution window.
// ============================================================
async function scheduleCategoryScrapes() {
    const { categories } = await chrome.storage.local.get(['categories']);
    if (!categories || categories.length === 0) {
        console.log("No categories to scrape.");
        return;
    }

    // Clear any previous category alarms that might be lingering
    const existingAlarms = await chrome.alarms.getAll();
    for (const alarm of existingAlarms) {
        if (alarm.name.startsWith("scrapeCategory_")) {
            await chrome.alarms.clear(alarm.name);
        }
    }

    const INTERVAL_MINUTES = 10; // 10 minutes between each category
    let scheduledCount = 0;

    // ✅ Reset the active-tasks counter before starting a fresh batch.
    // If the previous run crashed, this counter could be stuck at a non-zero
    // value, causing the "all done" check inside scrapeAndDispatchCategory to
    // misfire (re-blocking Twitter early and corrupting the counter for all
    // subsequent categories in this run).
    await chrome.storage.local.set({ activeScrapingTasks: 0 });

    // Check if we need to temporarily unblock
    const { twitterBlocked } = await chrome.storage.local.get(['twitterBlocked']);
    if (twitterBlocked) {
        addLog("Twitter is blocked. Temporarily unblocking for scheduled scrape session.");
        await updateTwitterBlock(false, true); // false = unblock, true = temporary flag

        // Give Chrome's declarativeNetRequest rules a moment to propagate
        // to avoid "ERR_BLOCKED_BY_CLIENT" on the very first profile.
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    for (let i = 0; i < categories.length; i++) {
        if (categories[i].isActive === false) {
            console.log(`Skipping disabled category: ${categories[i].name}`);
            continue;
        }

        if (scheduledCount === 0) {
            // Run the very first active category immediately
            console.log(`Running Category [${categories[i].name}] immediately (index ${i})`);
            scrapeAndDispatchCategory(i);
        } else {
            // Schedule future categories at 10-minute intervals
            const delayMs = scheduledCount * INTERVAL_MINUTES * 60 * 1000;
            console.log(`Scheduling Category [${categories[i].name}] (index ${i}) in ${scheduledCount * INTERVAL_MINUTES} minutes`);
            chrome.alarms.create(`scrapeCategory_${i}`, {
                when: Date.now() + delayMs
            });
        }
        scheduledCount++;
    }

    console.log(`Scheduled ${scheduledCount} categories total.`);
}

// ============================================================
// WORKER: Scrapes a SINGLE category manually (user requested)
// ============================================================
async function startSingleCategoryScrape(categoryIndex) {
    const { twitterBlocked } = await chrome.storage.local.get(['twitterBlocked']);
    if (twitterBlocked) {
        addLog(`Twitter is blocked. Temporarily unblocking for manual single category scrape.`);
        await updateTwitterBlock(false, true); // false = unblock, true = temporary flag
        await new Promise(resolve => setTimeout(resolve, 2000)); // Delay for rules to propagate
    }
    console.log(`Manually running Category index ${categoryIndex}`);
    scrapeAndDispatchCategory(categoryIndex);
}

// ============================================================
// WORKER: Scrapes all profiles in ONE category and dispatches
// the email. This is a completely self-contained unit of work.
// ============================================================
async function scrapeAndDispatchCategory(categoryIndex) {
    const { categories, processedTweetIds, settings } = await chrome.storage.local.get(['categories', 'processedTweetIds', 'settings']);
    if (!categories || categoryIndex >= categories.length) return;

    const category = categories[categoryIndex];
    if (category.isActive === false) return;

    // Increment active scraping tasks count
    const state = await chrome.storage.local.get(['activeScrapingTasks']);
    let currentTasks = (state.activeScrapingTasks || 0) + 1;
    await chrome.storage.local.set({ activeScrapingTasks: currentTasks });

    try {
        let globalProcessedIds = processedTweetIds || [];
        let allowDuplicates = settings?.allowDuplicates || false;
        let newIdsThisCategory = new Set();

        console.log(`=== BEGIN scrapeAndDispatchCategory: [${category.name}] (index ${categoryIndex}) ===`);

        let compilationPayload = {
            [category.name]: {
                extraEmails: category.enableExtraEmails !== false ? (category.extraEmails || '') : '',
                profiles: []
            }
        };

        for (const profile of (category.profiles || [])) {
            if (profile.isActive === false) continue;

            try {
                let targetUrl = profile.url;
                if (profile.scrapeReplies) {
                    try {
                        const parsedUrl = new URL(targetUrl);
                        parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '') + '/with_replies';
                        targetUrl = parsedUrl.toString();
                    } catch (e) {
                        targetUrl = targetUrl.replace(/\/+$/, '') + '/with_replies';
                    }
                }

                const globalProcessedIdsToPass = allowDuplicates ? [] : globalProcessedIds;
                const scrapeResult = await scrapeProfile(targetUrl, globalProcessedIdsToPass, settings);
                const rawTweets = scrapeResult.tweets || [];
                const profileMeta = scrapeResult.profileMeta || {};

                let novelTweets = [];
                if (rawTweets.length > 0) {
                    for (const t of rawTweets) {
                        if (allowDuplicates || !globalProcessedIds.includes(t.id)) {
                            novelTweets.push(t);
                        }
                        if (!globalProcessedIds.includes(t.id)) {
                            newIdsThisCategory.add(t.id);
                        }
                    }
                }

                if (profile.scrapeRetweets === false) {
                    novelTweets = novelTweets.filter(t => !t.isRetweet);
                }

                compilationPayload[category.name].profiles.push({
                    url: profile.url,
                    profileMeta,
                    enableAiSummary: profile.enableAiSummary,
                    scrapeRetweets: profile.scrapeRetweets !== false,
                    tweets: novelTweets
                });

                // Brief delay between profile visits
                await new Promise(r => setTimeout(r, 500));
            } catch (err) {
                console.error(`Failed to scrape ${profile.url} in ${category.name}:`, err);
                compilationPayload[category.name].profiles.push({
                    url: profile.url,
                    profileMeta: {},
                    enableAiSummary: profile.enableAiSummary,
                    tweets: [],
                    error: err.message || 'Error occurred during scraping'
                });
            }
        }

        // Dispatch email for this category
        console.log(`Finished scraping [${category.name}]. Dispatching email...`);
        try {
            await processAndDispatch(compilationPayload);
        } catch (dispatchErr) {
            console.error(`CRITICAL: processAndDispatch failed for ${category.name}:`, dispatchErr);
        }

        // Save new IDs
        if (newIdsThisCategory.size > 0) {
            // Re-read to avoid overwriting IDs saved by a concurrently running category
            const { processedTweetIds: latestIds } = await chrome.storage.local.get(['processedTweetIds']);
            let combinedIds = [...(latestIds || []), ...newIdsThisCategory];
            if (combinedIds.length > 5000) combinedIds = combinedIds.slice(combinedIds.length - 5000);
            await chrome.storage.local.set({ processedTweetIds: combinedIds });
            console.log(`Saved ${newIdsThisCategory.size} new tweet IDs for [${category.name}].`);
        }

        console.log(`=== END scrapeAndDispatchCategory: [${category.name}] ===`);

    } finally {
        // Decrement active scraping tasks count
        const finalState = await chrome.storage.local.get(['activeScrapingTasks']);
        let remainingTasks = Math.max((finalState.activeScrapingTasks || 1) - 1, 0);
        await chrome.storage.local.set({ activeScrapingTasks: remainingTasks });

        // Check if this was the last category scheduled
        const allAlarms = await chrome.alarms.getAll();
        const activeCategoryAlarms = allAlarms.filter(a => a.name.startsWith("scrapeCategory_"));

        if (remainingTasks === 0 && activeCategoryAlarms.length === 0) {
            const { twitterWasBlockedTemporarily } = await chrome.storage.local.get(['twitterWasBlockedTemporarily']);
            if (twitterWasBlockedTemporarily) {
                addLog("All categories finished scraping. Re-blocking Twitter as per user setting.");
                await updateTwitterBlock(true); // Re-block
            }
        }
    }
}

// Function to handle the 5-minute pre-unblock logic
async function handleDailyUnblock() {
    console.log("Pre-scrape Unblock Alarm triggered!");
    const { twitterBlocked } = await chrome.storage.local.get(['twitterBlocked']);
    if (twitterBlocked) {
        addLog("Twitter is blocked. Pre-emptively unblocking 5 mins before scheduled scrape session.");
        await updateTwitterBlock(false, true); // false = unblock, true = temporary flag
    }
}

// Opens a tab, injects scripts, and extracts data.
// Includes error-page detection (e.g. network failures, X rate-limits)
// and a single retry with back-off.
async function scrapeProfile(url, globalProcessedIds = [], settings = {}, _retryCount = 0) {
    const MAX_RETRIES = 1;
    const RETRY_DELAY_MS = 5000;
    const TAB_TIMEOUT_MS = 60000; // 60-second safety timeout

    return new Promise(async (resolve, reject) => {
        // Enforce unblocking right before creating the tab, in case the user 
        // manually re-blocked Twitter in the popup during an active multi-profile scrape.
        const { twitterBlocked } = await chrome.storage.local.get(['twitterBlocked']);
        if (twitterBlocked) {
            addLog("Twitter was found blocked mid-scrape. Force unblocking temporarily to proceed.");
            await updateTwitterBlock(false, true);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Delay for rules to propagate
        }

        chrome.tabs.create({ url, active: false }, async (tab) => {
            if (chrome.runtime.lastError || !tab) {
                return reject(new Error(chrome.runtime.lastError?.message || "Tab not created"));
            }

            let settled = false;
            const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

            // Safety timeout — if the tab never completes, clean up and fail
            const safetyTimer = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                try { chrome.tabs.remove(tab.id); } catch (_) { }
                settle(reject, new Error(`Tab timed out after ${TAB_TIMEOUT_MS / 1000}s for ${url}`));
            }, TAB_TIMEOUT_MS);

            // Wait for tab to complete loading to inject scripts
            function listener(tabId, info) {
                if (tabId !== tab.id || info.status !== 'complete') return;
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(safetyTimer);

                // Check if Chrome loaded an error page instead of the real site
                chrome.tabs.get(tab.id, (updatedTab) => {
                    const tabUrl = updatedTab?.url || '';
                    const isErrorPage = tabUrl.startsWith('chrome-error://') || tabUrl === 'about:blank';

                    if (isErrorPage) {
                        console.warn(`Tab for ${url} landed on error page (${tabUrl}).`);
                        try { chrome.tabs.remove(tab.id); } catch (_) { }

                        if (_retryCount < MAX_RETRIES) {
                            console.log(`Retrying ${url} in ${RETRY_DELAY_MS / 1000}s (attempt ${_retryCount + 1})...`);
                            setTimeout(() => {
                                scrapeProfile(url, globalProcessedIds, settings, _retryCount + 1)
                                    .then(resolve)
                                    .catch(reject);
                            }, RETRY_DELAY_MS);
                        } else {
                            settle(reject, new Error(`Page failed to load after ${MAX_RETRIES + 1} attempts (error page)`));
                        }
                        return;
                    }

                    chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ['content/utils.js', 'content/scraper.js']
                    }).then(() => {
                        // Briefly focus the tab to force Chrome to render/load images
                        // (inactive tabs don't load images due to lazy rendering)
                        chrome.tabs.update(tab.id, { active: true }, () => {
                            // Give DOM time to render tweets AND load images
                            setTimeout(() => {
                                chrome.tabs.sendMessage(tab.id, { action: "start_extraction", globalProcessedIds, settings }, (response) => {
                                    chrome.tabs.remove(tab.id); // Close tab
                                    if (chrome.runtime.lastError) {
                                        return settle(reject, chrome.runtime.lastError);
                                    }
                                    if (response && response.success) {
                                        settle(resolve, { tweets: response.data, profileMeta: response.profileMeta || {} });
                                    } else {
                                        settle(reject, new Error(response?.error || 'Unknown error'));
                                    }
                                });
                            }, 1500);
                        });
                    }).catch(err => {
                        console.warn(`executeScript failed for ${url}:`, err.message);
                        try { chrome.tabs.remove(tab.id); } catch (_) { }

                        // Catch both "error page" generic messages AND the specific Chrome error
                        // "Frame with ID 0 is showing error page" which is thrown by the browser
                        // before our URL-based detection can run (e.g. for rate-limited profiles).
                        const isErrorPage = err.message && (
                            err.message.includes('error page') ||
                            err.message.includes('Frame with ID')
                        );

                        if (isErrorPage && _retryCount < MAX_RETRIES) {
                            console.log(`Retrying ${url} in ${RETRY_DELAY_MS / 1000}s (attempt ${_retryCount + 1}) due to executeScript error page...`);
                            setTimeout(() => {
                                scrapeProfile(url, globalProcessedIds, settings, _retryCount + 1)
                                    .then(resolve)
                                    .catch(reject);
                            }, RETRY_DELAY_MS);
                        } else {
                            settle(reject, err);
                        }
                    });
                });
            }

            chrome.tabs.onUpdated.addListener(listener);
        });
    });
}

// Data Processing & AI Integration
async function processAndDispatch(payload) {
    console.log("Scraping finished. Compiling payload...");
    const { settings } = await chrome.storage.local.get(['settings']);

    if (!settings) {
        console.error("No settings found. Aborting dispatch.");
        return;
    }

    console.log("Settings retrieved from storage:", settings);
    const { llmApiKey, emailApiKey: webhookUrl, recipientEmail } = settings;

    if (!webhookUrl || !recipientEmail) {
        console.error(`Missing settings before dispatch! Webhook: ${webhookUrl}, Recipient: ${recipientEmail}. Please save settings in the popup!`);
        return;
    }

    for (const [categoryName, categoryData] of Object.entries(payload)) {
        const { extraEmails, profiles } = categoryData;

        // Sort: profiles with tweets first, "no new updates" profiles last
        const sortedProfiles = [...profiles].sort((a, b) => {
            const aHasContent = a.error || a.tweets.length > 0;
            const bHasContent = b.error || b.tweets.length > 0;
            if (aHasContent && !bHasContent) return -1;
            if (!aHasContent && bHasContent) return 1;
            return 0;
        });

        // ── Build per-profile HTML blocks so we can chunk them across emails ──
        const profileHtmlBlocks = [];

        for (const profile of sortedProfiles) {
            const meta = profile.profileMeta || {};
            const displayName = meta.profileName || '';
            const handle = meta.profileHandle || '';
            const avatarUrl = meta.profileAvatarUrl || '';

            // ── Profile section separator ──────────────────────────────────────────
            let profileHtml = `
          <!-- ── PROFILE CARD ── -->
          <tr>
            <td style="padding:16px 28px 0 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                     style="width:100%; background:#f8f7ff; border:1px solid #e0e7ff;
                             border-radius:10px; overflow:hidden;">
                <tr>
                  <td style="padding:14px 16px;">
                    <!-- Avatar + name row as a table so email clients render it correctly -->
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="width:56px; vertical-align:middle; padding-right:14px;">
                          <img src="${avatarUrl}"
                               alt="${displayName || handle}"
                               width="56" height="56"
                               style="width:56px; height:56px; border-radius:50%;
                                      display:block; object-fit:cover;
                                      border:2px solid #6366f1;" />
                        </td>
                        <td style="vertical-align:middle;">
                          <div style="font-weight:700; font-size:15px; color:#111827;
                                      line-height:1.3;">
                            ${displayName || handle || 'X Profile'}
                          </div>
                          <a href="${profile.url}"
                             style="font-size:13px; color:#6366f1;
                                    text-decoration:none; display:inline-block;
                                    margin-top:2px;">${handle || profile.url}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
            `;

            if (profile.error) {
                profileHtml += `
          <tr>
            <td style="padding:10px 28px 16px 28px;">
              <div style="background:#fef2f2; border-left:4px solid #ef4444;
                           border-radius:0 6px 6px 0; padding:12px 14px;
                           font-size:13px; color:#b91c1c; font-weight:600;">
                ⚠️ Error scraping profile: ${profile.error}
              </div>
            </td>
          </tr>
                `;
                profileHtmlBlocks.push(profileHtml);
                continue;
            }

            if (profile.tweets.length === 0) {
                profileHtml += `
          <tr>
            <td style="padding:10px 28px 20px 28px;">
              <div style="background:#fffbeb; border-left:4px solid #fbbf24;
                           border-radius:0 6px 6px 0; padding:12px 14px;
                           font-size:13px; color:#92400e; font-style:italic;">
                📭 No new updates found in the last 24 hours.
              </div>
            </td>
          </tr>
                `;
                profileHtmlBlocks.push(profileHtml);
                continue;
            }

            if (profile.enableAiSummary) {
                const summary = await summarizeTweets(profile.tweets, llmApiKey);
                profileHtml += `
          <tr>
            <td style="padding:12px 28px 4px 28px;">
              <div style="background:#f0fdf4; border-left:4px solid #22c55e;
                           border-radius:0 8px 8px 0; padding:14px 16px;">
                <div style="font-size:12px; font-weight:700; color:#15803d;
                             text-transform:uppercase; letter-spacing:0.5px;
                             margin-bottom:6px;">✨ AI Summary</div>
                <div style="font-size:14px; color:#1c1917; line-height:1.65;">
                  ${summary}
                </div>
              </div>
            </td>
          </tr>
                `;
            }

            // ── Individual tweets ──────────────────────────────────────────────────
            profileHtml += `
          <tr>
            <td style="padding:10px 28px 20px 28px;">
            `;

            const maxDisplayTweets = 15;
            const tweetsToDisplay = profile.tweets.slice(0, maxDisplayTweets);

            tweetsToDisplay.forEach((t, idx) => {
                const dateStr = new Date(t.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
                const isLast = idx === tweetsToDisplay.length - 1;

                const borderBottom = isLast ? '' : 'border-bottom:1px solid #f3f4f6;';
                const bgColor = t.isSubscriberOnly ? '#fdf2f8' : '#ffffff';
                const border = t.isSubscriberOnly ? 'border:1.5px solid #fbcfe8; border-radius:8px;' : '';
                const padding = t.isSubscriberOnly ? 'padding:14px;' : `padding:12px 0; ${borderBottom}`;

                profileHtml += `
              <div style="background:${bgColor}; ${border} ${padding} margin-bottom:${t.isSubscriberOnly ? '10px' : '0'};">

                <!-- Date + badges row -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin-bottom:6px;">
                  <tr>
                    <td>
                      <span style="font-size:11px; color:#9ca3af;">🕒 ${dateStr}</span>
                      ${t.isSubscriberOnly ? `<span style="margin-left:8px; background:#ec4899; color:#fff; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700;">⭐ SUBSCRIBERS ONLY</span>` : ''}
                    </td>
                  </tr>
                </table>

                ${t.isRetweet ? `<div style="font-size:12px; color:#10b981; font-weight:700; margin-bottom:4px;">🔁 Reposted from ${t.authorName} (${t.authorHandle})</div>` : ''}

                ${t.replyContext ? `
                <!-- Quoted parent tweet for reply context -->
                <div style="border-left:3px solid #d1d5db; border-radius:0 6px 6px 0;
                            background:#f9fafb; padding:10px 12px; margin-bottom:10px;">
                  <div style="font-size:11px; color:#6b7280; margin-bottom:5px; font-weight:600;">
                    ↩️ Replying to
                    <span style="color:#6366f1;">${t.replyContext.authorHandle || t.replyContext.authorName || 'unknown'}</span>
                  </div>
                  <div style="font-size:13px; color:#374151; line-height:1.5; word-break:break-word;
                              font-style:italic;">
                    ${t.replyContext.text
                            ? (t.replyContext.text.length > 280
                                ? t.replyContext.text.slice(0, 280) + '…'
                                : t.replyContext.text)
                            : '<span style="color:#9ca3af;">[original tweet not available]</span>'}
                  </div>
                  ${t.replyContext.mediaUrls && t.replyContext.mediaUrls.length > 0 ? `
                  <div style="margin-top:8px;">
                    ${t.replyContext.mediaUrls.map(url => `<img src="${url}" alt="quoted media" width="100%" style="max-width:200px; border-radius:6px; display:inline-block; margin:0 4px 4px 0;" />`).join('')}
                  </div>` : ''}
                </div>` : ''}

                <!-- Tweet text -->
                <div style="font-size:14px; color:#111827; line-height:1.6; margin-bottom:${t.quotedTweet ? '10px' : '8px'}; word-break:break-word;">
                  ${t.text}
                </div>

                ${t.quotedTweet ? `
                <!-- Quoted tweet card -->
                <div style="border:1px solid #e0e7ff; border-left:3px solid #6366f1;
                            border-radius:0 8px 8px 0; background:#f8f7ff;
                            padding:10px 14px; margin-bottom:10px;">
                  <div style="font-size:11px; color:#6366f1; font-weight:700;
                              margin-bottom:5px; letter-spacing:0.3px;">
                    🔗 Quoted tweet
                    ${t.quotedTweet.authorHandle || t.quotedTweet.authorName
                            ? `· <span style="color:#4f46e5;">${t.quotedTweet.authorName || ''}${t.quotedTweet.authorHandle ? ' ' + t.quotedTweet.authorHandle : ''}</span>`
                            : ''}
                  </div>
                  <div style="font-size:13px; color:#374151; line-height:1.55;
                              word-break:break-word;">
                    ${t.quotedTweet.text
                            ? (t.quotedTweet.text.length > 280
                                ? t.quotedTweet.text.slice(0, 280) + '…'
                                : t.quotedTweet.text)
                            : '<span style="color:#9ca3af; font-style:italic;">[quoted tweet text not available]</span>'}
                  </div>
                  ${t.quotedTweet.mediaUrls && t.quotedTweet.mediaUrls.length > 0 ? `
                  <div style="margin-top:8px;">
                    ${t.quotedTweet.mediaUrls.map(url => `<img src="${url}" alt="quoted media" width="100%" style="max-width:180px; border-radius:6px; display:inline-block; margin:0 4px 4px 0;" />`).join('')}
                  </div>` : ''}
                </div>` : ''}
                ${t.mediaUrls && t.mediaUrls.length > 0 ? `
                <div style="margin-bottom:8px;">
                  ${t.mediaUrls.map(url => `<img src="${url}" alt="media" width="100%" style="max-width:260px; border-radius:8px; display:inline-block; margin:0 4px 4px 0;" />`).join('')}
                </div>` : ''}

                <a href="${t.url}" style="font-size:12px; color:#6366f1; text-decoration:none; font-weight:600;">
                  View on X →
                </a>
              </div>
                `;
            });

            if (profile.tweets.length > maxDisplayTweets) {
                profileHtml += `
                <div style="padding: 12px 0; text-align: center; border-top: 1px solid #e5e7eb;">
                  <a href="${profile.url}" style="font-size:13px; color:#6366f1; font-weight:600; text-decoration:none;">
                    + ${profile.tweets.length - maxDisplayTweets} more tweets... View Full Profile
                  </a>
                </div>
                `;
            }

            profileHtml += `
            </td>
          </tr>
            `;

            profileHtmlBlocks.push(profileHtml);

        } // End profile loop

        // ── Helper to wrap profile blocks in a complete email HTML shell ──────
        const MAX_BODY_BYTES = 180 * 1024; // 180 KB — Apps Script MailApp limit is ~200KB
        const encoder = new TextEncoder();

        function buildEmailShell(categoryName, partLabel, profileBlocks) {
            const header = `
        <div style="background:#f4f4f5; padding:24px 12px; font-family:Arial,Helvetica,sans-serif;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"
               style="width:100%; max-width:600px; margin:0 auto; background:#ffffff;
                      border-radius:12px; overflow:hidden;
                      box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- ── HEADER BANNER ── -->
          <tr>
            <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);
                        padding:28px 28px 20px 28px; text-align:center;">
              <div style="font-size:22px; font-weight:700; color:#ffffff;
                          letter-spacing:-0.3px;">🛰️ DailyUpdates Curation</div>
              <div style="font-size:13px; color:#c7d2fe; margin-top:4px;">${categoryName}${partLabel ? ` — ${partLabel}` : ''}</div>
            </td>
          </tr>

          <!-- ── INTRO TEXT ── -->
          <tr>
            <td style="padding:20px 28px 8px 28px;">
              <p style="margin:0; font-size:14px; color:#6b7280; line-height:1.6;">
                Your 24-hour digest from X profiles in
                <strong style="color:#111827;">${categoryName}</strong>.
                ${partLabel ? `<br/><span style="font-size:12px; color:#9ca3af;">(${partLabel})</span>` : ''}
              </p>
            </td>
          </tr>

            `;

            const footer = `

          <!-- ── FOOTER ── -->
          <tr>
            <td style="background:#f8f7ff; border-top:1px solid #e0e7ff;
                        padding:16px 28px; text-align:center;">
              <div style="font-size:12px; color:#9ca3af;">
                Sent by <strong style="color:#6366f1;">DailyUpdates Extension</strong>
                &nbsp;·&nbsp;
                <span>${new Date().toLocaleDateString([], { dateStyle: 'medium' })}</span>
              </div>
            </td>
          </tr>

        </table>
        </div>
            `;

            return header + profileBlocks.join('') + footer;
        }

        // ── Chunk profiles into emails that fit under the size limit ──────────
        const emailChunks = []; // each entry is an array of profileHtml strings
        let currentChunk = [];
        let currentChunkSize = 0;
        // Approximate shell overhead (header + footer without profiles)
        const shellOverhead = encoder.encode(buildEmailShell(categoryName, 'Part 1', [])).length;

        for (const block of profileHtmlBlocks) {
            const blockSize = encoder.encode(block).length;

            // If adding this profile would exceed the limit, start a new chunk
            // (unless the chunk is empty — a single profile must go in at least one email)
            if (currentChunk.length > 0 && (currentChunkSize + blockSize + shellOverhead) > MAX_BODY_BYTES) {
                emailChunks.push(currentChunk);
                currentChunk = [];
                currentChunkSize = 0;
            }

            currentChunk.push(block);
            currentChunkSize += blockSize;
        }
        if (currentChunk.length > 0) {
            emailChunks.push(currentChunk);
        }

        // ── Assemble & send each chunk as a separate email ───────────────────
        addLog(`Compilation complete for ${categoryName}. ${emailChunks.length} email(s) to send.`);

        let allRecipients = recipientEmail;
        if (extraEmails) {
            const extraList = extraEmails.split(',').map(e => e.trim()).filter(Boolean).join(',');
            if (extraList && extraList.length > 0) {
                allRecipients = `${recipientEmail},${extraList}`;
                addLog(`Category [${categoryName}] has extra recipients: ${extraList}. Adding to 'To' field.`);
            }
        }

        for (let ci = 0; ci < emailChunks.length; ci++) {
            const partLabel = emailChunks.length > 1 ? `Part ${ci + 1} of ${emailChunks.length}` : '';
            const emailSubject = `Curation: ${categoryName}${partLabel ? ` (${partLabel})` : ''}`;
            const emailHtml = buildEmailShell(categoryName, partLabel, emailChunks[ci]);
            const bodySizeKB = (encoder.encode(emailHtml).length / 1024).toFixed(1);

            addLog(`Dispatching [${categoryName}]${partLabel ? ` ${partLabel}` : ''} to: ${allRecipients} (${bodySizeKB} KB)`);
            try {
                await sendEmailPayload(emailHtml, allRecipients, webhookUrl, emailSubject, null);
                addLog(`✅ Email for [${categoryName}]${partLabel ? ` ${partLabel}` : ''} dispatched successfully.`);
            } catch (emailErr) {
                addLog(`❌ Email dispatch FAILED for [${categoryName}]${partLabel ? ` ${partLabel}` : ''}: ${emailErr.message}`, "error");
            }

            // Brief delay between multi-part emails
            if (ci < emailChunks.length - 1) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        // Wait 1.5s between categories to avoid concurrent webhook limits
        await new Promise(r => setTimeout(r, 1500));
    } // End category loop
}


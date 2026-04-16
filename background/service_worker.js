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

            // Keep only last 1500 logs to prevent storage bloat
            const limitedLogs = filteredLogs.slice(-1500);

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
    } else if (alarm.name.startsWith("scrapeCategory_CONT_")) {
        // Continuation alarm — resumes a split category scrape
        const categoryIndex = parseInt(alarm.name.split("_")[2]);
        console.log(`Continuation Alarm triggered for category index ${categoryIndex}!`);
        scrapeAndDispatchContinuation(categoryIndex);
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
// SPLIT HELPER: Persists remaining profiles and schedules a
// continuation alarm to fire after the last queued task.
// ============================================================
async function scheduleContinuation(categoryIndex, categoryName, remainingProfiles, nextPart) {
    // Persist what still needs to be scraped
    await chrome.storage.local.set({
        [`continuation_${categoryIndex}`]: {
            remainingProfiles,          // array of profile objects
            nextPart                     // e.g. 2 for "Part 2"
        }
    });

    // Find the latest scheduled alarm (regular or continuation) and queue after it
    const allAlarms = await chrome.alarms.getAll();
    const pendingAlarms = allAlarms
        .filter(a => a.name.startsWith("scrapeCategory_"))
        .sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));

    const lastAlarm = pendingAlarms[pendingAlarms.length - 1];
    
    // 5 minutes buffer after the latest scheduled alarm (or from now)
    const MIN_CONTINUATION_DELAY_MS = 5 * 60 * 1000;
    const fireAt = lastAlarm
        ? Math.max(lastAlarm.scheduledTime + MIN_CONTINUATION_DELAY_MS, Date.now() + MIN_CONTINUATION_DELAY_MS)
        : Date.now() + MIN_CONTINUATION_DELAY_MS;

    chrome.alarms.create(`scrapeCategory_CONT_${categoryIndex}`, { when: fireAt });
    addLog(`[${categoryName}] ⏳ Continuation (Part ${nextPart}) queued at ` +
        `${new Date(fireAt).toLocaleTimeString()} — ${remainingProfiles.length} profile(s) remaining.`);
}

// ============================================================
// CONTINUATION WORKER: Resumes a split category scrape from
// where it left off (stored in chrome.storage.local).
// ============================================================
async function scrapeAndDispatchContinuation(categoryIndex) {
    const { categories, processedTweetIds, settings } = await chrome.storage.local.get(
        ['categories', 'processedTweetIds', 'settings']
    );
    if (!categories || categoryIndex >= categories.length) return;

    const category = categories[categoryIndex];
    const contKey = `continuation_${categoryIndex}`;
    const { [contKey]: contState } = await chrome.storage.local.get([contKey]);

    if (!contState || !contState.remainingProfiles || contState.remainingProfiles.length === 0) {
        addLog(`[${category.name}] No continuation state found — skipping.`);
        return;
    }

    const { remainingProfiles, nextPart } = contState;
    addLog(`[${category.name}] 🔁 Continuation starting (Part ${nextPart}, ${remainingProfiles.length} profile(s)).`);

    // Clear continuation state now — if it splits again, scheduleContinuation will re-write
    await chrome.storage.local.remove([contKey]);

    const state = await chrome.storage.local.get(['activeScrapingTasks']);
    let currentTasks = (state.activeScrapingTasks || 0) + 1;
    await chrome.storage.local.set({ activeScrapingTasks: currentTasks });

    try {
        let globalProcessedIds = processedTweetIds || [];
        let allowDuplicates = settings?.allowDuplicates || false;
        let newIdsThisRun = new Set(); 

        const compilationPayload = {
            [category.name]: {
                extraEmails: category.enableExtraEmails !== false ? (category.extraEmails || '') : '',
                enableCategorySummary: category.enableCategorySummary === true,
                summaryMode: category.categorySummaryMode || (category.enableCategorySummary ? 'minimal' : 'off'),
                enableFactCheck: category.enableFactCheck !== false,
                enableGlossary: category.enableGlossary !== false,
                summaryPrompt: category.summaryPrompt || '',
                partLabel: `Part ${nextPart}`,
                profiles: []
            }
        };

        const categoryStartTime = Date.now();
        const SPLIT_TIMEOUT_MS = 4 * 60 * 1000;
        let splitTriggered = false;
        const activeRemainingProfiles = remainingProfiles.filter(p => p.isActive !== false);

        for (let pi = 0; pi < activeRemainingProfiles.length; pi++) {
            const profile = activeRemainingProfiles[pi];

            // Check if we've hit the 4-minute limit again
            if (compilationPayload[category.name].profiles.length > 0 &&
                (Date.now() - categoryStartTime) > SPLIT_TIMEOUT_MS) {

                const stillRemaining = activeRemainingProfiles.slice(pi);
                addLog(`[${category.name}] ⏱ 4-min limit hit again in Part ${nextPart}. ` +
                    `Dispatching Part ${nextPart} and queuing Part ${nextPart + 1} ` +
                    `(${stillRemaining.length} profile(s) remaining).`);

                // Await dispatch so active task increment holds until we're actually done with this context
                try {
                    await processAndDispatch(compilationPayload);
                } catch (e) {
                    addLog(`[${category.name}] Part ${nextPart} dispatch error: ${e.message}`, 'error');
                }
                
                // Save IDs before queuing continuation so they are visible to the next run
                if (newIdsThisRun.size > 0) {
                    const { processedTweetIds: latestIds } = await chrome.storage.local.get(['processedTweetIds']);
                    let combinedIds = [...(latestIds || []), ...newIdsThisRun];
                    if (combinedIds.length > 5000) combinedIds = combinedIds.slice(-5000);
                    await chrome.storage.local.set({ processedTweetIds: combinedIds });
                }

                await scheduleContinuation(categoryIndex, category.name, stillRemaining, nextPart + 1);
                splitTriggered = true;
                break;
            }

            // No manual isActive check needed here because we filtered upfront

            try {
                let targetUrl = profile.url;
                if (profile.scrapeReplies) {
                    try {
                        const parsedUrl = new URL(targetUrl);
                        parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '') + '/with_replies';
                        targetUrl = parsedUrl.toString();
                    } catch (e) { targetUrl = targetUrl.replace(/\/+$/, '') + '/with_replies'; }
                }

                const globalProcessedIdsToPass = allowDuplicates ? [] : globalProcessedIds;
                const scrapeResult = await scrapeProfile(targetUrl, globalProcessedIdsToPass, settings);
                const rawTweets = scrapeResult.tweets || [];

                let novelTweets = [];
                for (const t of rawTweets) {
                    if (allowDuplicates || !globalProcessedIds.includes(t.id)) novelTweets.push(t);
                    if (!globalProcessedIds.includes(t.id)) newIdsThisRun.add(t.id);
                }
                if (profile.scrapeRetweets === false) novelTweets = novelTweets.filter(t => !t.isRetweet);

                compilationPayload[category.name].profiles.push({
                    url: profile.url,
                    profileMeta: scrapeResult.profileMeta || {},
                    enableAiSummary: profile.enableAiSummary,
                    scrapeRetweets: profile.scrapeRetweets !== false,
                    tweets: novelTweets
                });

                await new Promise(r => setTimeout(r, 500));
            } catch (err) {
                compilationPayload[category.name].profiles.push({
                    url: profile.url, profileMeta: {},
                    enableAiSummary: profile.enableAiSummary,
                    tweets: [], error: err.message || 'Error during scraping'
                });
            }
        }

        if (!splitTriggered) {
            // All remaining profiles done — dispatch final part
            compilationPayload[category.name].partLabel = `Part ${nextPart} — Final`;
            addLog(`[${category.name}] ✅ Continuation complete. Dispatching Part ${nextPart} (Final).`);
            try {
                await processAndDispatch(compilationPayload);
            } catch (dispatchErr) {
                addLog(`[${category.name}] Continuation dispatch error: ${dispatchErr.message}`, 'error');
            }

            // Save IDs
            if (newIdsThisRun.size > 0) {
                const { processedTweetIds: latestIds } = await chrome.storage.local.get(['processedTweetIds']);
                let combinedIds = [...(latestIds || []), ...newIdsThisRun];
                if (combinedIds.length > 5000) combinedIds = combinedIds.slice(combinedIds.length - 5000);
                await chrome.storage.local.set({ processedTweetIds: combinedIds });
            }
        }

    } finally {
        const finalState = await chrome.storage.local.get(['activeScrapingTasks']);
        let remaining = Math.max((finalState.activeScrapingTasks || 1) - 1, 0);
        await chrome.storage.local.set({ activeScrapingTasks: remaining });

        const allAlarms = await chrome.alarms.getAll();
        const activeCategoryAlarms = allAlarms.filter(a => a.name.startsWith("scrapeCategory_"));
        
        if (remaining === 0 && activeCategoryAlarms.length === 0) {
            // Guard: don't re-block if there's any pending continuation state saved
            const allStorage = await chrome.storage.local.get(null);
            const hasPendingContinuation = Object.keys(allStorage).some(k => k.startsWith('continuation_'));
            
            if (!hasPendingContinuation) {
                const { twitterWasBlockedTemporarily } = await chrome.storage.local.get(['twitterWasBlockedTemporarily']);
                if (twitterWasBlockedTemporarily) {
                    addLog("All continuations finished. Re-blocking Twitter.");
                    await updateTwitterBlock(true);
                }
            }
        }
    }
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
                enableCategorySummary: category.enableCategorySummary === true,
                summaryMode: category.categorySummaryMode || (category.enableCategorySummary ? 'minimal' : 'off'),
                enableFactCheck: category.enableFactCheck !== false,
                enableGlossary: category.enableGlossary !== false,
                summaryPrompt: category.summaryPrompt || '',
                profiles: []
            }
        };

        // ── 4-minute split timer ───────────────────────────────────────────────
        const categoryStartTime = Date.now();
        const SPLIT_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes
        let splitTriggered = false;
        const allProfiles = (category.profiles || []).filter(p => p.isActive !== false);

        for (let pi = 0; pi < allProfiles.length; pi++) {
            const profile = allProfiles[pi];

            // Before scraping each profile, check elapsed time.
            // Only split if we've already scraped at least 1 profile so the
            // Part 1 email is never empty.
            if (compilationPayload[category.name].profiles.length > 0 &&
                (Date.now() - categoryStartTime) > SPLIT_TIMEOUT_MS) {

                const remainingProfiles = allProfiles.slice(pi); // profiles not yet scraped
                addLog(`[${category.name}] ⏱ 4-min scrape limit reached after ` +
                    `${compilationPayload[category.name].profiles.length} profile(s). ` +
                    `Dispatching Part 1, queuing Part 2 (${remainingProfiles.length} profile(s) remaining).`);

                // Tag the payload as Part 1 before dispatching
                compilationPayload[category.name].partLabel = 'Part 1';

                // Await dispatch so active task increment holds until we're actually done with this context
                try {
                    await processAndDispatch(compilationPayload);
                } catch (e) {
                    addLog(`[${category.name}] Part 1 dispatch error: ${e.message}`, 'error');
                }

                // Save IDs before queuing continuation so they are visible to the next run
                if (newIdsThisCategory.size > 0) {
                    const { processedTweetIds: latestIds } = await chrome.storage.local.get(['processedTweetIds']);
                    let combinedIds = [...(latestIds || []), ...newIdsThisCategory];
                    if (combinedIds.length > 5000) combinedIds = combinedIds.slice(-5000);
                    await chrome.storage.local.set({ processedTweetIds: combinedIds });
                }

                // Persist remaining profiles and schedule continuation
                await scheduleContinuation(categoryIndex, category.name, remainingProfiles, 2);
                splitTriggered = true;
                break; // exit the profile loop — continuation handles the rest
            }

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

        // Only dispatch if we didn't split — split path dispatches Part 1 itself
        if (!splitTriggered) {
            console.log(`Finished scraping [${category.name}]. Dispatching email...`);
            try {
                await processAndDispatch(compilationPayload);
            } catch (dispatchErr) {
                console.error(`CRITICAL: processAndDispatch failed for ${category.name}:`, dispatchErr);
            }
        }

        // Save new IDs (only the ones scraped in this part — continuation saves its own)
        if (!splitTriggered && newIdsThisCategory.size > 0) {
            // Re-read to avoid overwriting IDs saved by a concurrently running category
            const { processedTweetIds: latestIds } = await chrome.storage.local.get(['processedTweetIds']);
            let combinedIds = [...(latestIds || []), ...newIdsThisCategory];
            if (combinedIds.length > 5000) combinedIds = combinedIds.slice(combinedIds.length - 5000);
            await chrome.storage.local.set({ processedTweetIds: combinedIds });
            console.log(`Saved ${newIdsThisCategory.size} new tweet IDs for [${category.name}].`);
        }

        console.log(`=== END scrapeAndDispatchCategory: [${category.name}] (splitTriggered=${splitTriggered}) ===`);

    } finally {
        // Decrement active scraping tasks count
        const finalState = await chrome.storage.local.get(['activeScrapingTasks']);
        let remainingTasks = Math.max((finalState.activeScrapingTasks || 1) - 1, 0);
        await chrome.storage.local.set({ activeScrapingTasks: remainingTasks });

        // Check if this was the last category scheduled
        const allAlarms = await chrome.alarms.getAll();
        const activeCategoryAlarms = allAlarms.filter(a => a.name.startsWith("scrapeCategory_"));

        if (remainingTasks === 0 && activeCategoryAlarms.length === 0) {
            // Guard: don't re-block if there's any pending continuation state saved
            const allStorage = await chrome.storage.local.get(null);
            const hasPendingContinuation = Object.keys(allStorage).some(k => k.startsWith('continuation_'));

            if (!hasPendingContinuation) {
                const { twitterWasBlockedTemporarily } = await chrome.storage.local.get(['twitterWasBlockedTemporarily']);
                if (twitterWasBlockedTemporarily) {
                    addLog("All categories finished scraping. Re-blocking Twitter as per user setting.");
                    await updateTwitterBlock(true); // Re-block
                }
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
    const { geminiApiKey, llmApiKey, emailApiKey: webhookUrl, recipientEmail } = settings;

    if (!webhookUrl || !recipientEmail) {
        console.error(`Missing settings before dispatch! Webhook: ${webhookUrl}, Recipient: ${recipientEmail}. Please save settings in the popup!`);
        return;
    }

    for (const [categoryName, categoryData] of Object.entries(payload)) {
        const { extraEmails, profiles, enableCategorySummary, summaryMode, enableFactCheck, enableGlossary, summaryPrompt, partLabel: incomingPartLabel } = categoryData;

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
            let profileHtml = `          <!-- ── PROFILE CARD ── -->
          <tr>
            <td style="padding:16px 28px 0 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                     class="em-profile-card"
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
                          <div class="em-profile-name" style="font-weight:700; font-size:15px; color:#111827;
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
                profileHtml += `          <tr>
            <td style="padding:10px 28px 16px 28px;">
              <div class="em-error-box" style="background:#fef2f2; border-left:4px solid #ef4444;
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
                profileHtml += `          <tr>
            <td style="padding:10px 28px 20px 28px;">
              <div class="em-no-update" style="background:#fffbeb; border-left:4px solid #fbbf24;
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
                let summary = '';
                try {
                    summary = await summarizeTweets(profile.tweets, geminiApiKey, llmApiKey, summaryPrompt);
                } catch (summaryErr) {
                    summary = `<em style="color:#dc2626;">⚠️ AI Summary generation failed: ${summaryErr.message}</em>`;
                }

                profileHtml += `          <tr>
            <td style="padding:12px 28px 4px 28px;">
              <div class="em-ai-summary-box" style="background:#f0fdf4; border-left:4px solid #22c55e;
                           border-radius:0 8px 8px 0; padding:14px 16px;">
                <div class="em-ai-summary-text" style="font-size:12px; font-weight:700; color:#15803d;
                             text-transform:uppercase; letter-spacing:0.5px;
                             margin-bottom:6px;">✨ AI Summary</div>
                <div class="em-ai-summary-body" style="font-size:14px; color:#1c1917; line-height:1.65;">
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

                profileHtml += `              <div class="em-tweet" style="background:${bgColor}; ${border} ${padding} margin-bottom:${t.isSubscriberOnly ? '10px' : '0'};">

                <!-- Date + badges row -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin-bottom:6px;">
                  <tr>
                    <td>
                      <span class="em-ts" style="font-size:11px; color:#9ca3af;">🕒 ${dateStr}</span>
                      ${t.isSubscriberOnly ? `<span style="margin-left:8px; background:#ec4899; color:#fff; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700;">⭐ SUBSCRIBERS ONLY</span>` : ''}
                    </td>
                  </tr>
                </table>

                ${t.isRetweet ? `<div style="font-size:12px; color:#10b981; font-weight:700; margin-bottom:4px;">🔁 Reposted from ${t.authorName} (${t.authorHandle})</div>` : ''}

                                ${t.replyContext ? `
                <!-- Quoted parent tweet for reply context -->
                <div class="em-reply-block" style="border-left:3px solid #d1d5db; border-radius:0 6px 6px 0;
                            background:#f9fafb; padding:10px 12px; margin-bottom:10px;">
                  <div class="em-label" style="font-size:11px; color:#6b7280; margin-bottom:5px; font-weight:600;">
                    ↩️ Replying to
                    <span style="color:#6366f1;">${t.replyContext.authorHandle || t.replyContext.authorName || 'unknown'}</span>
                  </div>
                  <div class="em-reply-text" style="font-size:13px; color:#374151; line-height:1.5; word-break:break-word;
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
                <div class="em-text" style="font-size:14px; color:#111827; line-height:1.6; margin-bottom:${t.quotedTweet ? '10px' : '8px'}; word-break:break-word;">
                  ${t.text}
                </div>

                                ${t.quotedTweet ? `
                <!-- Quoted tweet card -->
                <div class="em-quote-block" style="border:1px solid #e0e7ff; border-left:3px solid #6366f1;
                            border-radius:0 8px 8px 0; background:#f8f7ff;
                            padding:10px 14px; margin-bottom:10px;">
                  <div style="font-size:11px; color:#6366f1; font-weight:700;
                              margin-bottom:5px; letter-spacing:0.3px;">
                    🔗 Quoted tweet
                    ${t.quotedTweet.authorHandle || t.quotedTweet.authorName
                            ? `· <span style="color:#4f46e5;">${t.quotedTweet.authorName || ''}${t.quotedTweet.authorHandle ? ' ' + t.quotedTweet.authorHandle : ''}</span>`
                            : ''}
                  </div>
                  <div class="em-quote-text" style="font-size:13px; color:#374151; line-height:1.55;
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

        // ── Category-level AI Summary Block (prepended before profiles) ──────
        const categorySummaryBlocks = [];
        if (enableCategorySummary) {
            addLog(`[${categoryName}] Category Summarise is ON. Generating category-level summary...`);
            // Use sortedProfiles for consistency with the HTML build order
            const allTweetsInCategory = sortedProfiles
                .filter(p => !p.error && p.tweets && p.tweets.length > 0)
                .flatMap(p => p.tweets);

            if (allTweetsInCategory.length > 0) {
                // Cap at 60 most recent tweets to keep the LLM prompt manageable
                const tweetsForSummary = allTweetsInCategory
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, 60);
                addLog(`[${categoryName}] Summarising ${tweetsForSummary.length} of ${allTweetsInCategory.length} tweets (capped at 60 most recent).`);
                const hasGeminiKey = geminiApiKey && geminiApiKey.trim().length > 0;
                const hasHFKey = llmApiKey && llmApiKey.trim().length > 0;
                addLog(`[${categoryName}] Calling LLM... (Gemini: ${hasGeminiKey ? '✅ key set' : '❌ not set'}, HuggingFace fallback: ${hasHFKey ? '✅ key set' : '❌ not set'})`);

                let categorySummaryText = null;
                let categorySummaryError = null;
                try {
                    categorySummaryText = await summarizeTweets(tweetsForSummary, geminiApiKey, llmApiKey, summaryPrompt, enableFactCheck, enableGlossary, summaryMode || 'minimal');
                    addLog(`[${categoryName}] LLM responded. Summary length: ${categorySummaryText?.length ?? 0} chars.`);
                } catch (summaryErr) {
                    categorySummaryError = summaryErr.message;
                    addLog(`[${categoryName}] ⚠️ Summary error: ${summaryErr.message}. Email will be sent without summary.`);
                }

                if (categorySummaryText) {
                    const totalProfiles = sortedProfiles.filter(p => p.tweets && p.tweets.length > 0).length;
                    const totalTweets = allTweetsInCategory.length;

                    const categorySummaryHtml = `
          <!-- ── CATEGORY SUMMARY BLOCK ── -->
          <tr>
            <td style="padding:20px 28px 12px 28px;">
              <div class="em-summary-box" style="background:linear-gradient(135deg,#f5f3ff,#ede9fe);
                          border:1.5px solid #a78bfa; border-radius:10px;
                          padding:18px 20px;">
                <div class="em-summary-text" style="font-size:13px; font-weight:800; color:#6d28d9;
                            text-transform:uppercase; letter-spacing:0.6px;
                            margin-bottom:10px;">
                  &#x2728; Category Summary
                  <span class="em-summary-chip" style="font-size:11px; font-weight:500; color:#8b5cf6;
                              text-transform:none; letter-spacing:0;
                              background:#ede9fe; border-radius:10px;
                              padding:2px 8px; margin-left:8px;">
                    ${totalTweets} tweet${totalTweets !== 1 ? 's' : ''} across ${totalProfiles} profile${totalProfiles !== 1 ? 's' : ''}
                  </span>
                </div>
                <div class="em-summary-text" style="font-size:14px; color:#1c1917; line-height:1.75;">
                  ${categorySummaryText}
                </div>
              </div>
            </td>
          </tr>
          <!-- ── DIVIDER before individual profiles ── -->
          <tr>
            <td style="padding:4px 28px 10px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                <tr>
                  <td class="em-divider-line" style="border-top:1px solid #e0e7ff; padding-right:10px;"></td>
                  <td class="em-divider-label" style="white-space:nowrap; font-size:11px; font-weight:700;
                             color:#6366f1; text-transform:uppercase; letter-spacing:0.8px;
                             padding:0 10px;">&#x1F4CB; Individual Profiles</td>
                  <td class="em-divider-line" style="border-top:1px solid #e0e7ff; padding-left:10px;"></td>
                </tr>
              </table>
            </td>
          </tr>
                    `;
                    categorySummaryBlocks.push(categorySummaryHtml);
                    addLog(`[${categoryName}] ✅ Category summary generated (${tweetsForSummary.length} tweets summarised).`);
                } else {
                    addLog(`[${categoryName}] ⚠️ Summary returned empty — email will be sent without summary block.`);
                    // Inject failure notice into the email so the recipient knows why there's no summary
                    const failureReason = categorySummaryError || 'Summary returned empty (no content from LLM).';
                    // Simplify the error for display: extract just the first sentence / key part
                    const displayReason = failureReason.length > 300 ? failureReason.slice(0, 300) + '…' : failureReason;
                    categorySummaryBlocks.push(`
          <!-- ── SUMMARY FAILURE NOTICE ── -->
          <tr>
            <td style="padding:20px 28px 12px 28px;">
              <div class="em-failure-box" style="background:#fff7ed; border:1.5px solid #fb923c;
                          border-radius:10px; padding:14px 18px;">
                <div class="em-failure-text" style="font-size:12px; font-weight:800; color:#c2410c;
                            text-transform:uppercase; letter-spacing:0.5px;
                            margin-bottom:8px;">⚠️ AI Summary Unavailable</div>
                <div class="em-failure-text" style="font-size:13px; color:#7c2d12; line-height:1.65;">
                  The AI summary could not be generated for this digest. The email below contains all the raw tweets.
                </div>
                <div class="em-failure-code" style="margin-top:10px; padding:10px 12px;
                            background:#fff; border:1px solid #fed7aa;
                            border-radius:6px; font-size:11.5px;
                            color:#9a3412; font-family:monospace;
                            word-break:break-word; line-height:1.6;">
                  <strong>Reason:</strong> ${displayReason}
                </div>
              </div>
            </td>
          </tr>
                    `);
                }
            } else {
                addLog(`[${categoryName}] Category summary skipped — no tweets found across any profile.`);
            }
        }

        // Summary block first, then individual profile blocks
        const allHtmlBlocks = [...categorySummaryBlocks, ...profileHtmlBlocks];

        // ── Helper to wrap profile blocks in a complete email HTML shell ──────
        const MAX_BODY_BYTES = 180 * 1024; // 180 KB — Apps Script MailApp limit is ~200KB
        const encoder = new TextEncoder();

        function buildEmailShell(categoryName, partLabel, profileBlocks) {
            const header = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  /* ── Dark-mode overrides (Gmail Android/iOS, Apple Mail) ── */
  @media (prefers-color-scheme: dark) {
    .em-outer   { background:#111118 !important; }
    .em-card    { background:#19191f !important; }
    .em-tweet   { background:#1e1e2e !important; border-color:#2d2d42 !important; }
    .em-tweet-border { border-color:#2d2d42 !important; }

    .em-text    { color:#e4e4f0 !important; }
    .em-muted   { color:#9494b0 !important; }
    .em-strong  { color:#e4e4f0 !important; }
    .em-label   { color:#9494b0 !important; }
    .em-ts      { color:#6b6b88 !important; }

    .em-profile-card { background:#1e1e2e !important; border-color:#2d2d42 !important; }
    .em-profile-name { color:#e4e4f0 !important; }

    .em-quote-block  { background:#16161f !important; border-color:#3d3d5c !important; }
    .em-quote-text   { color:#c4c4dc !important; }
    .em-reply-block  { background:#16161f !important; border-color:#3d3d5c !important; }
    .em-reply-text   { color:#c4c4dc !important; }

    .em-no-update { background:#1e1a10 !important; border-color:#78580a !important; color:#f0c040 !important; }
    .em-error-box { background:#1f1010 !important; border-color:#7f2020 !important; color:#f87171 !important; }

    .em-summary-box  { background:#1a1628 !important; border-color:#6d28d9 !important; }
    .em-summary-text { color:#ddd6fe !important; }
    .em-summary-chip { background:#2d2045 !important; color:#c4b5fd !important; }

    .em-ai-summary-box  { background:#0f1f14 !important; border-color:#16a34a !important; }
    .em-ai-summary-text { color:#86efac !important; }
    .em-ai-summary-body { color:#d4fce3 !important; }

    .em-failure-box  { background:#1e110a !important; border-color:#c2410c !important; }
    .em-failure-text { color:#fdba74 !important; }
    .em-failure-code { background:#110d06 !important; border-color:#7c3000 !important; color:#fbbf24 !important; }

    .em-footer      { background:#111118 !important; border-color:#2d2d42 !important; }
    .em-footer-text { color:#6b6b88 !important; }

    .em-divider-line { border-color:#2d2d42 !important; }
    .em-divider-label { color:#7c7cb0 !important; }

    .em-section-block { background:#1a1628 !important; border-color:#4c3d6e !important; }
    .em-section-title { color:#c4b5fd !important; }
    .em-section-text  { color:#ddd6fe !important; }
  }
</style>
</head>
<body>
<div class="em-outer" style="background:#f4f4f5; padding:24px 12px; font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"
       class="em-card"
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
      <p class="em-muted" style="margin:0; font-size:14px; color:#6b7280; line-height:1.6;">
        Your 24-hour digest from X profiles in
        <strong class="em-strong" style="color:#111827;">${categoryName}</strong>.
        ${partLabel ? `<br/><span class="em-ts" style="font-size:12px; color:#9ca3af;">(${partLabel})</span>` : ''}
      </p>
    </td>
  </tr>

`;

            const footer = `

  <!-- ── FOOTER ── -->
  <tr>
    <td class="em-footer" style="background:#f8f7ff; border-top:1px solid #e0e7ff;
                padding:16px 28px; text-align:center;">
      <div class="em-footer-text" style="font-size:12px; color:#9ca3af;">
        Sent by <strong style="color:#6366f1;">DailyUpdates Extension</strong>
        &nbsp;·&nbsp;
        <span>${new Date().toLocaleDateString([], { dateStyle: 'medium' })}</span>
      </div>
    </td>
  </tr>

</table>
</div>
</body>
</html>`;

            return header + profileBlocks.join('') + footer;
        }

        // ── Chunk profiles into emails that fit under the size limit ──────────
        const emailChunks = []; // each entry is an array of profileHtml strings
        let currentChunk = [];
        let currentChunkSize = 0;
        // Approximate shell overhead (header + footer without profiles)
        const shellOverhead = encoder.encode(buildEmailShell(categoryName, 'Part 1', [])).length;

        for (const block of allHtmlBlocks) {
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
            // incomingPartLabel: set by continuation payloads ("Part 2 — Final", etc.)
            // chunkLabel: set when a single email is too large and needs splitting across multiple emails
            const chunkLabel = emailChunks.length > 1 ? `Email ${ci + 1}/${emailChunks.length}` : '';
            const partLabel = incomingPartLabel && chunkLabel
                ? `${incomingPartLabel}, ${chunkLabel}`
                : incomingPartLabel || chunkLabel;
            const summaryPrefix = (enableCategorySummary && categorySummaryBlocks.length > 0) ? '✨ ' : '';
            const emailSubject = `${summaryPrefix}Curation: ${categoryName}${partLabel ? ` (${partLabel})` : ''}`;
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


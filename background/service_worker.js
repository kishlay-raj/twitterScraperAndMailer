importScripts('llm_api.js', 'email_api.js');

// Listener from Popup UI and Content Scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start_scraping") {
        startScrapingSequence();
        sendResponse({ status: 'Sequence started' });
    } else if (request.action === "update_schedule") {
        updateSchedule(request.settings);
        sendResponse({ status: 'Schedule updated' });
    } else if (request.action === "log") {
        console.log(request.message);
    }
});

// Alarm Listener
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "dailyScrapeAlarm") {
        console.log("Scheduled Scrape Alarm triggered!");
        startScrapingSequence();
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

        console.log(`Next run scheduled for ${nextRun.toLocaleString()}`);
    } else {
        console.log("Daily schedule is disabled.");
    }
}

// On install or startup, make sure the schedule is set
chrome.runtime.onStartup.addListener(() => updateSchedule());
chrome.runtime.onInstalled.addListener(() => updateSchedule());

async function startScrapingSequence() {
    const { categories, processedTweetIds, settings } = await chrome.storage.local.get(['categories', 'processedTweetIds', 'settings']);
    if (!categories || categories.length === 0) return;

    let globalProcessedIds = processedTweetIds || [];
    let newIdsDeduplicated = new Set();
    let allowDuplicates = settings?.allowDuplicates || false;

    let compilationPayload = {}; // Reset payload
    const profilesToScrape = [];

    // Flatten the category structure to a list of profiles to scrape sequentially
    for (const category of categories) {
        // Skip entire category if disabled explicitly
        if (category.isActive === false) continue;

        if (!compilationPayload[category.name]) {
            compilationPayload[category.name] = [];
        }
        for (const profile of category.profiles) {
            // Default to true if isActive is missing for backward compatibility
            if (profile.isActive !== false) {
                profilesToScrape.push({
                    url: profile.url,
                    category: category.name,
                    enableAiSummary: profile.enableAiSummary,
                    scrapeReplies: profile.scrapeReplies
                });
            }
        }
    }

    // Sequentially scrape each profile
    for (const profile of profilesToScrape) {
        try {
            let targetUrl = profile.url;
            if (profile.scrapeReplies) {
                try {
                    const parsedUrl = new URL(targetUrl);
                    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '') + '/with_replies';
                    targetUrl = parsedUrl.toString();
                } catch (e) {
                    targetUrl = targetUrl.replace(/\/+$/, '') + '/with_replies'; // Fallback
                }
            }

            // Bypass pre-loading skip IDs into the content script if duplicates are allowed
            const globalProcessedIdsToPass = allowDuplicates ? [] : globalProcessedIds;
            const scrapedData = await scrapeProfile(targetUrl, globalProcessedIdsToPass);

            // Filter out tweets that were previously sent (if duplicates not allowed), but always record new IDs
            let novelTweets = [];
            if (scrapedData && scrapedData.length > 0) {
                for (const t of scrapedData) {
                    if (allowDuplicates || !globalProcessedIds.includes(t.id)) {
                        novelTweets.push(t);
                    }
                    if (!globalProcessedIds.includes(t.id)) {
                        newIdsDeduplicated.add(t.id);
                    }
                }
            }

            // Exclude retweets here if the user's settings explicitly disabled them for this profile
            if (profile.scrapeRetweets === false) {
                novelTweets = novelTweets.filter(t => !t.isRetweet);
            }

            compilationPayload[profile.category].push({
                url: profile.url,
                enableAiSummary: profile.enableAiSummary,
                scrapeRetweets: profile.scrapeRetweets !== false, // Defaults to true if missing
                tweets: novelTweets
            });

            // Brief delay between profile visits
            await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
            console.error(`Failed to scrape ${profile.url}:`, err);
            compilationPayload[profile.category].push({
                url: profile.url,
                enableAiSummary: profile.enableAiSummary,
                tweets: [],
                error: err.message || 'Error occurred during scraping'
            });
        }
    }

    // Once scraping is complete, trigger the processing pipeline
    await processAndDispatch(compilationPayload);

    // Save the new novel IDs back to storage (cap at 5000 latest to prevent memory leaks)
    if (newIdsDeduplicated.size > 0) {
        let combinedIds = [...globalProcessedIds, ...newIdsDeduplicated];
        if (combinedIds.length > 5000) {
            // Keep only the 5000 most recent ones
            combinedIds = combinedIds.slice(combinedIds.length - 5000);
        }
        await chrome.storage.local.set({ processedTweetIds: combinedIds });
        console.log(`Saved ${newIdsDeduplicated.size} new novel tweet IDs to persistent storage.`);
    }
}

// Opens a tab, injects scripts, and extracts data
async function scrapeProfile(url, globalProcessedIds = []) {
    return new Promise((resolve, reject) => {
        chrome.tabs.create({ url, active: false }, async (tab) => {
            if (chrome.runtime.lastError || !tab) {
                return reject(new Error(chrome.runtime.lastError?.message || "Tab not created"));
            }

            // Wait for tab to complete loading to inject scripts
            chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
                if (tabId === tab.id && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);

                    chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ['content/utils.js', 'content/scraper.js']
                    }).then(() => {
                        // Give DOM a bit more time to render tweets
                        setTimeout(() => {
                            chrome.tabs.sendMessage(tab.id, { action: "start_extraction", globalProcessedIds }, (response) => {
                                chrome.tabs.remove(tab.id); // Close tab
                                if (chrome.runtime.lastError) {
                                    return reject(chrome.runtime.lastError);
                                }
                                if (response && response.success) {
                                    resolve(response.data);
                                } else {
                                    reject(new Error(response?.error || 'Unknown error'));
                                }
                            });
                        }, 3000);
                    }).catch(err => {
                        chrome.tabs.remove(tab.id);
                        reject(err);
                    });
                }
            });
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

    for (const [categoryName, profiles] of Object.entries(payload)) {
        let categoryHtml = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 800px; margin: 0 auto;">
          <h1 style="color: #6366f1; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">Antigravity Curation: ${categoryName}</h1>
          <p>Here is your 24-hour summary of X (Twitter) profiles for the <strong>${categoryName}</strong> category.</p>
        `;

        categoryHtml += `<h2 style="background: #f3f4f6; padding: 10px; border-radius: 4px; margin-top: 30px;">📁 ${categoryName}</h2>`;

        for (const profile of profiles) {
            categoryHtml += `<div style="margin-left: 15px; margin-bottom: 25px;">`;
            categoryHtml += `<h3 style="color: #4f46e5; margin-bottom: 5px;"><a href="${profile.url}" style="text-decoration: none;">${profile.url}</a></h3>`;

            if (profile.error) {
                categoryHtml += `<p style="color: #ef4444; font-weight: bold;">⚠️ Error scraping profile: ${profile.error}</p></div>`;
                continue;
            }

            if (profile.tweets.length === 0) {
                categoryHtml += `<p style="color: #6b7280; font-style: italic; background: #fffbeb; padding: 10px; border-left: 4px solid #fbbf24; border-radius: 4px;">📭 No new updates found in the last 24 hours.</p></div>`;
                continue;
            }

            if (profile.enableAiSummary) {
                const summary = await summarizeTweets(profile.tweets, llmApiKey);
                categoryHtml += `<div style="background: #f8fafc; padding: 15px; border-left: 4px solid #6366f1; border-radius: 0 4px 4px 0; margin-bottom: 20px;">`;
                categoryHtml += `<strong>✨ AI Summary:</strong><br/>`;
                categoryHtml += `<p style="line-height: 1.5;">${summary}</p></div>`;
            }

            // Always show the raw tweets below (whether AI summary was generated or not)
            categoryHtml += `<div style="padding-left: 10px;">`;
            profile.tweets.forEach(t => {
                const dateStr = new Date(t.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

                let tweetStyle = "border-bottom: 1px solid #e5e7eb; padding: 10px 0;";
                if (t.isSubscriberOnly) {
                    tweetStyle = "background: #fdf2f8; border: 2px solid #fbcfe8; border-radius: 8px; padding: 15px; margin-bottom: 10px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);";
                }

                categoryHtml += `<div style="${tweetStyle}">`;
                categoryHtml += `<div style="font-size: 0.8rem; color: #6b7280; margin-bottom: 8px;">Posted: ${dateStr}</div>`;
                if (t.isSubscriberOnly) {
                    categoryHtml += `<div style="display: inline-block; background: #ec4899; color: white; padding: 4px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">⭐ Subscriber-Only Exclusive</div>`;
                }
                if (t.isRetweet) {
                    categoryHtml += `<div style="font-size: 0.85rem; color: #10b981; font-weight: bold; margin-bottom: 4px;">🔁 Reposted from ${t.authorName} (${t.authorHandle})</div>`;
                }
                categoryHtml += `<p style="margin: 0 0 5px 0;">${t.text}</p>`;
                if (t.mediaUrls && t.mediaUrls.length > 0) {
                    categoryHtml += `<div style="margin-top: 5px;">`;
                    t.mediaUrls.forEach(url => {
                        categoryHtml += `<img src="${url}" style="max-width: 200px; max-height: 200px; border-radius: 8px; margin-right: 5px;" />`;
                    });
                    categoryHtml += `</div>`;
                }
                categoryHtml += `<a href="${t.url}" style="font-size: 0.8rem; color: #6b7280;">View Tweet</a>`;
                categoryHtml += `</div>`;
            });
            categoryHtml += `</div>`;

            categoryHtml += `</div>`; // Close profile div
        } // End profile loop

        categoryHtml += `<footer style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #9ca3af; font-size: 0.875rem;">Sent by Antigravity Extension</footer>`;
        categoryHtml += `</div>`;

        console.log(`Compilation complete for ${categoryName}. Dispatching email...`);
        const emailSubject = `Curation: ${categoryName}`;
        await sendEmailPayload(categoryHtml, recipientEmail, webhookUrl, emailSubject);

        // Wait 1.5s between API calls to prevent tripping Apps Script concurrent webhook limits
        await new Promise(r => setTimeout(r, 1500));
    } // End category loop
}

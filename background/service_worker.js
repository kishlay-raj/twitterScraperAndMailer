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
            // Store extra emails alongside the profiles array for this category
            compilationPayload[category.name] = {
                extraEmails: category.enableExtraEmails !== false ? (category.extraEmails || '') : '',
                profiles: []
            };
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
            const scrapeResult = await scrapeProfile(targetUrl, globalProcessedIdsToPass, settings);
            const rawTweets = scrapeResult.tweets || [];
            const profileMeta = scrapeResult.profileMeta || {};

            // Filter out tweets that were previously sent (if duplicates not allowed), but always record new IDs
            let novelTweets = [];
            if (rawTweets.length > 0) {
                for (const t of rawTweets) {
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

            compilationPayload[profile.category].profiles.push({
                url: profile.url,
                profileMeta,
                enableAiSummary: profile.enableAiSummary,
                scrapeRetweets: profile.scrapeRetweets !== false,
                tweets: novelTweets
            });

            // Brief delay between profile visits
            await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
            console.error(`Failed to scrape ${profile.url}:`, err);
            compilationPayload[profile.category].profiles.push({
                url: profile.url,
                profileMeta: {},
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
async function scrapeProfile(url, globalProcessedIds = [], settings = {}) {
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
                        // Briefly focus the tab to force Chrome to render/load images
                        // (inactive tabs don't load images due to lazy rendering)
                        chrome.tabs.update(tab.id, { active: true }, () => {
                            // Give DOM time to render tweets AND load images
                            setTimeout(() => {
                                chrome.tabs.sendMessage(tab.id, { action: "start_extraction", globalProcessedIds, settings }, (response) => {
                                    chrome.tabs.remove(tab.id); // Close tab
                                    if (chrome.runtime.lastError) {
                                        return reject(chrome.runtime.lastError);
                                    }
                                    if (response && response.success) {
                                        resolve({ tweets: response.data, profileMeta: response.profileMeta || {} });
                                    } else {
                                        reject(new Error(response?.error || 'Unknown error'));
                                    }
                                });
                            }, 3000);
                        });
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

        // ── Outer wrapper: max 600px, centered, white background ──────────────────
        let categoryHtml = `
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
                          letter-spacing:-0.3px;">🛰️ Antigravity Curation</div>
              <div style="font-size:13px; color:#c7d2fe; margin-top:4px;">${categoryName}</div>
            </td>
          </tr>

          <!-- ── INTRO TEXT ── -->
          <tr>
            <td style="padding:20px 28px 8px 28px;">
              <p style="margin:0; font-size:14px; color:#6b7280; line-height:1.6;">
                Your 24-hour digest from X profiles in
                <strong style="color:#111827;">${categoryName}</strong>.
              </p>
            </td>
          </tr>

        `;

        for (const profile of sortedProfiles) {
            const meta = profile.profileMeta || {};
            const displayName = meta.profileName || '';
            const handle = meta.profileHandle || '';
            const avatarUrl = meta.profileAvatarUrl || '';

            // ── Profile section separator ──────────────────────────────────────────
            categoryHtml += `
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
                categoryHtml += `
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
                continue;
            }

            if (profile.tweets.length === 0) {
                categoryHtml += `
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
                continue;
            }

            if (profile.enableAiSummary) {
                const summary = await summarizeTweets(profile.tweets, llmApiKey);
                categoryHtml += `
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
            categoryHtml += `
          <tr>
            <td style="padding:10px 28px 20px 28px;">
            `;

            const maxDisplayTweets = 30;
            const tweetsToDisplay = profile.tweets.slice(0, maxDisplayTweets);
            
            tweetsToDisplay.forEach((t, idx) => {
                const dateStr = new Date(t.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
                const isLast = idx === tweetsToDisplay.length - 1;

                const borderBottom = isLast ? '' : 'border-bottom:1px solid #f3f4f6;';
                const bgColor = t.isSubscriberOnly ? '#fdf2f8' : '#ffffff';
                const border = t.isSubscriberOnly ? 'border:1.5px solid #fbcfe8; border-radius:8px;' : '';
                const padding = t.isSubscriberOnly ? 'padding:14px;' : `padding:12px 0; ${borderBottom}`;

                categoryHtml += `
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
                categoryHtml += `
                <div style="padding: 12px 0; text-align: center; border-top: 1px solid #e5e7eb;">
                  <a href="${profile.url}" style="font-size:13px; color:#6366f1; font-weight:600; text-decoration:none;">
                    + ${profile.tweets.length - maxDisplayTweets} more tweets... View Full Profile
                  </a>
                </div>
                `;
            }

            categoryHtml += `
            </td>
          </tr>
            `;

        } // End profile loop

        // ── Footer ────────────────────────────────────────────────────────────────
        categoryHtml += `

          <!-- ── FOOTER ── -->
          <tr>
            <td style="background:#f8f7ff; border-top:1px solid #e0e7ff;
                        padding:16px 28px; text-align:center;">
              <div style="font-size:12px; color:#9ca3af;">
                Sent by <strong style="color:#6366f1;">Antigravity Extension</strong>
                &nbsp;·&nbsp;
                <span>${new Date().toLocaleDateString([], { dateStyle: 'medium' })}</span>
              </div>
            </td>
          </tr>

        </table>
        </div>
        `;

        console.log(`Compilation complete for ${categoryName}. Dispatching email...`);
        const emailSubject = `Curation: ${categoryName}`;

        // 1. Send to global recipient
        await sendEmailPayload(categoryHtml, recipientEmail, webhookUrl, emailSubject);

        // 2. Send to category-specific extra recipients (if any)
        if (extraEmails) {
            const extraList = extraEmails.split(',').map(e => e.trim()).filter(Boolean);
            for (const extraEmail of extraList) {
                await new Promise(r => setTimeout(r, 1000)); // brief gap between sends
                console.log(`Sending category email also to extra recipient: ${extraEmail}`);
                await sendEmailPayload(categoryHtml, extraEmail, webhookUrl, emailSubject);
            }
        }

        // Wait 1.5s between categories to avoid concurrent webhook limits
        await new Promise(r => setTimeout(r, 1500));
    } // End category loop
}


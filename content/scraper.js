/**
 * X.com Scraper Logic
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Helper to send logs to the background service worker so they all appear in one console
function bgLog(message) {
    console.log(message); // Still log locally just in case
    try {
        chrome.runtime.sendMessage({ action: "log", message: `[Scraper] ${message}` });
    } catch (e) {
        // Ignore if message port is closed
    }
}

async function extractTweets(globalProcessedIds = []) {
    const tweetsData = [];

    // Seed the set with previously sent tweet IDs so we immediately skip them
    const processedTweetIds = new Set(globalProcessedIds);
    const startTime = Date.now();

    let attemptsWithNoNewTweets = 0;
    const maxAttempts = 3;

    bgLog(`Antigravity Scraper started... Pre-loaded ${processedTweetIds.size} old tweets to skip.`);

    while (attemptsWithNoNewTweets < maxAttempts) {
        // 1. Find all tweet elements on the screen
        const tweetElements = document.querySelectorAll('[data-testid="tweet"]');
        let addedNewTweetThisCycle = false;

        bgLog(`Analyzing ${tweetElements.length} tweets on screen...`);
        for (const tweetEl of tweetElements) {
            // Identify unique tweet (simplest way is by link) for logging purposes
            const linkEl = tweetEl.querySelector('a[href*="/status/"]');
            const tweetUrl = linkEl ? linkEl.href : 'Unknown URL';
            const tweetId = tweetUrl.split('/status/')[1]?.split('?')[0] || 'Unknown ID';

            bgLog(`\n--- Looking at Tweet: ${tweetUrl} ---`);

            if (processedTweetIds.has(tweetId)) {
                bgLog(`Skipping: Already processed ${tweetId}`);
                continue;
            }

            // Skip pinned tweets completely so they don't trigger the 24-hour stop condition
            const socialContextText = tweetEl.querySelector('[data-testid="socialContext"]')?.textContent || '';
            const isPinnedText = socialContextText.includes('Pinned') || socialContextText.includes('pinned');

            const isPinnedSvg = tweetEl.querySelector('svg path[d*="M19.141 12l.812-1.928"]') || // Common Pinned SVG path
                Array.from(tweetEl.querySelectorAll('svg')).some(svg => svg.innerHTML.includes('Pinned'));

            if (isPinnedText || isPinnedSvg) {
                bgLog(`-> Skipping: Identified as Pinned tweet (Text: ${isPinnedText}, SVG: ${!!isPinnedSvg}).`);
                if (tweetId !== 'Unknown ID') processedTweetIds.add(tweetId);
                continue;
            }

            // Find the timestamp to check age
            const timeEl = tweetEl.querySelector('time');
            if (!timeEl) {
                bgLog("-> Skipping: No <time> element found.");
                continue;
            }

            const tweetTime = new Date(timeEl.getAttribute('datetime')).getTime();
            const ageMs = startTime - tweetTime;
            const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);

            bgLog(`-> Age: ${ageHours} hours old.`);

            // Check if older than 24 hours
            if (ageMs > ONE_DAY_MS) {
                bgLog("-> Skipping: Tweet is older than 24 hours.");
                if (tweetId !== 'Unknown ID') processedTweetIds.add(tweetId);
                continue;
            }

            if (!tweetId || tweetId === 'Unknown ID' || processedTweetIds.has(tweetId)) continue;

            // Expand "Show more" if present (Careful not to trigger navigation)
            const expandBtn = Array.from(tweetEl.querySelectorAll('span')).find(el => el.textContent.includes('Show more'));
            if (expandBtn) {
                // X sometimes wraps "Show more" in an anchor tag that takes you to the tweet page.
                // We want to avoid navigating away from the profile timeline.
                const parentLink = expandBtn.closest('a');
                if (parentLink) {
                    bgLog("-> 'Show more' is a link. We will not click it to prevent leaving the profile page.");
                    // In this case, we just extract what is visible so we don't break the scraping flow.
                } else {
                    bgLog("-> Expanding 'Show more' text...");
                    expandBtn.click();
                    await randomDelay(800, 1500); // wait for load
                }
            }

            // Extract text content
            const textEl = tweetEl.querySelector('[data-testid="tweetText"]');
            const text = textEl ? (textEl.innerText || textEl.textContent) : '';

            // Extract images/media URLs
            const mediaUrls = [];
            const imgElements = tweetEl.querySelectorAll('[data-testid="tweetPhoto"] img, video');
            imgElements.forEach(img => {
                if (img.src) mediaUrls.push(img.src);
            });

            // Extract quoted tweet content if any
            let quotedText = '';
            const quoteEl = tweetEl.querySelector('[role="blockquote"], [data-testid="tweet"] [data-testid="tweet"]');
            if (quoteEl) {
                quotedText = quoteEl.innerText || quoteEl.textContent;
            }

            // Extract original author (useful for retweets)
            let authorName = 'Unknown';
            let authorHandle = 'Unknown';
            const userNameEl = tweetEl.querySelector('[data-testid="User-Name"]');
            if (userNameEl) {
                // Name is usually the first span with text
                const nameNode = userNameEl.querySelector('span');
                if (nameNode) authorName = nameNode.textContent.trim();

                // Handle starts with @
                const handles = Array.from(userNameEl.querySelectorAll('*'))
                    .map(el => el.textContent.trim())
                    .filter(text => text.startsWith('@') && text.length > 1);
                if (handles.length > 0) authorHandle = handles[0];
            }

            const isRetweet = socialContextText.toLowerCase().includes('reposted') || tweetEl.innerHTML.includes('reposted');

            // Detect Subscriber-only posts
            // 1. Check for the specific SVG path X uses for the "Subscriber" icon (person with a star)
            const isSubscriberSvg = Array.from(tweetEl.querySelectorAll('svg path')).some(path => {
                const d = path.getAttribute('d');
                return d && (d.includes('M8.402') && d.includes('6.376') && d.includes('2.054')) || // User icon
                    (d.includes('M12 1.75l2.69 5.454 6.02.875') || // Star icon part
                        d.includes('8.219 14.532-1.896')); // Star icon part
            });

            // 2. Fallback: text matching
            const hasSubscriberText = Array.from(tweetEl.querySelectorAll('span')).some(span => {
                const text = span.textContent.trim().toLowerCase();
                return text === 'subscriber' || text === 'subscribers' || text === 'subscribers only' || text === 'subscriber-only';
            });

            const isSubscriberOnly = isSubscriberSvg || hasSubscriberText;

            tweetsData.push({
                id: tweetId,
                url: tweetUrl,
                timestamp: tweetTime,
                text,
                mediaUrls,
                quotedText,
                isRetweet: isRetweet,
                authorName: authorName,
                authorHandle: authorHandle,
                isSubscriberOnly: isSubscriberOnly
            });

            processedTweetIds.add(tweetId);
            addedNewTweetThisCycle = true;
        }


        if (!addedNewTweetThisCycle) {
            attemptsWithNoNewTweets++;
        } else {
            attemptsWithNoNewTweets = 0;
        }

        // Scroll to load more
        await humanScroll();
    }

    bgLog(`Scraping complete. Extracted ${tweetsData.length} tweets.`);
    return tweetsData;
}

// Listener for background script
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "start_extraction") {
            // Run extraction and reply
            extractTweets(request.globalProcessedIds || [])
                .then(data => sendResponse({ success: true, data }))
                .catch(err => sendResponse({ success: false, error: err.message }));

            return true; // Keep message channel open for async response
        }
    });
}

// Export for Node.js Testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { extractTweets };
}

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

/**
 * Extract profile-level metadata (avatar, name, handle) from the page.
 * MUST be called before scrolling — X's virtual DOM recycles the profile header
 * once it scrolls out of view.
 *
 * Handle is derived from window.location.pathname (always reliable).
 * Avatar is taken from the a[href="/<handle>/photo"] anchor that X renders in the header.
 */
function extractProfileMeta(pagePathname) {
    let profileName = '';
    let profileHandle = '';
    let profileAvatarUrl = '';

    // Helper: reject blob: URLs — they only live in the current tab's memory and can't be emailed
    const isUsable = (url) => url && !url.startsWith('blob:') && url.startsWith('http');

    // Step 1: Handle from page URL — most reliable source.
    // Accept an explicit pathname for testability; fall back to window.location.pathname in browser.
    const pathname = pagePathname || (typeof window !== 'undefined' && window.location ? window.location.pathname : '/');
    const pathParts = pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) {
        profileHandle = '@' + pathParts[0]; // e.g. @Minakshishriyan
    }

    const handle = profileHandle.replace('@', '');

    if (handle) {
        // Step 2a: Look for the anchor that links to /<handle>/photo — X always renders this
        const avatarLink = document.querySelector(`a[href="/${handle}/photo"]`);
        if (avatarLink) {
            const img = avatarLink.querySelector('img');
            if (img) {
                const candidate = img.src || (img.srcset ? img.srcset.split(/\s/)[0] : '');
                if (isUsable(candidate)) profileAvatarUrl = candidate;
            }
        }

        // Step 2b: data-testid="UserAvatar-Container-<handle>" (case-sensitive match)
        if (!profileAvatarUrl) {
            const avatarContainer = document.querySelector(`[data-testid="UserAvatar-Container-${handle}"]`);
            if (avatarContainer) {
                const img = avatarContainer.querySelector('img');
                if (img) {
                    const candidate = img.src || (img.srcset ? img.srcset.split(/\s/)[0] : '');
                    if (isUsable(candidate)) profileAvatarUrl = candidate;
                }
            }
        }
    }

    // Step 2c: Any UserAvatar-Container-* element (case-insensitive handle fallback)
    if (!profileAvatarUrl) {
        const containers = document.querySelectorAll('[data-testid^="UserAvatar-Container-"]');
        for (const c of containers) {
            const img = c.querySelector('img');
            const candidate = img && (img.src || (img.srcset ? img.srcset.split(/\s/)[0] : ''));
            if (isUsable(candidate)) {
                profileAvatarUrl = candidate;
                break;
            }
        }
    }

    // Step 2d: Any img with pbs.twimg.com/profile_images in src
    if (!profileAvatarUrl) {
        const imgs = document.querySelectorAll('img[src*="profile_images"]');
        for (const img of imgs) {
            if (isUsable(img.src)) { profileAvatarUrl = img.src; break; }
        }
    }

    // Step 2e: Guaranteed fallback — unavatar.io serves Twitter profile pics by handle
    // This always works as long as we have the handle, even if DOM scraping failed entirely.
    if (!profileAvatarUrl && handle) {
        profileAvatarUrl = `https://unavatar.io/twitter/${handle}`;
    }

    // Step 3: Display name from the profile header UserName element
    const headerUserNameEl = document.querySelector('[data-testid="UserName"]');
    if (headerUserNameEl) {
        const spans = headerUserNameEl.querySelectorAll('span');
        spans.forEach(span => {
            const txt = span.textContent.trim();
            if (txt && !txt.startsWith('@') && !profileName) profileName = txt;
        });
    }

    bgLog(`Profile meta: name="${profileName}", handle="${profileHandle}", avatar=${profileAvatarUrl ? profileAvatarUrl.slice(0, 60) + '...' : 'NOT FOUND'}`);
    return { profileName, profileHandle, profileAvatarUrl };
}


async function extractTweets(globalProcessedIds = []) {
    const tweetsData = [];

    // ⚡ Extract profile metadata FIRST — before any scrolling.
    // X's virtual DOM recycles the profile header once it scrolls out of view,
    // so we MUST read it while the page is still at the top.
    // We read the pathname once here so it can also be injected in tests.
    const pagePathname = (typeof window !== 'undefined' && window.location) ? window.location.pathname : '/';
    const profileMeta = extractProfileMeta(pagePathname);

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

            // Extract quoted tweet content (quote-tweets) — structured for email rendering
            let quotedTweet = null;
            // X nests quoted tweets inside [role="blockquote"] or as an inner [data-testid="tweet"]
            const quoteEl = tweetEl.querySelector('[role="blockquote"]') ||
                            tweetEl.querySelector('[data-testid="tweet"] [data-testid="tweet"]');
            if (quoteEl) {
                const qTextEl = quoteEl.querySelector('[data-testid="tweetText"]');
                const qNameEl = quoteEl.querySelector('[data-testid="User-Name"]');

                let qAuthorName = '';
                let qAuthorHandle = '';
                if (qNameEl) {
                    const nameSpan = qNameEl.querySelector('span');
                    if (nameSpan) qAuthorName = nameSpan.textContent.trim();
                    const handles = Array.from(qNameEl.querySelectorAll('*'))
                        .map(el => el.textContent.trim())
                        .filter(t => t.startsWith('@') && t.length > 1);
                    if (handles.length > 0) qAuthorHandle = handles[0];
                }

                const qText = qTextEl ? (qTextEl.innerText || qTextEl.textContent).trim() : '';
                if (qText || qAuthorHandle) {
                    quotedTweet = { text: qText, authorName: qAuthorName, authorHandle: qAuthorHandle };
                }
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

            // Detect replies and extract parent tweet context for email rendering
            // X renders "Replying to @handle" as text inside the tweet; the parent tweet
            // lives in the immediately preceding [data-testid="cellInnerDiv"] sibling.
            let replyContext = null;
            const hasReplyingToText = Array.from(tweetEl.querySelectorAll('div, span'))
                .some(el => el.childNodes.length === 1 &&
                    el.textContent.trim().toLowerCase().startsWith('replying to'));

            if (hasReplyingToText) {
                // Walk up to the timeline cell that wraps this tweet
                const cell = tweetEl.closest('[data-testid="cellInnerDiv"]');
                const prevCell = cell && cell.previousElementSibling;
                if (prevCell) {
                    const parentTweetEl = prevCell.querySelector('[data-testid="tweet"]');
                    if (parentTweetEl) {
                        const parentTextEl = parentTweetEl.querySelector('[data-testid="tweetText"]');
                        const parentNameEl = parentTweetEl.querySelector('[data-testid="User-Name"]');

                        let parentAuthorName = '';
                        let parentAuthorHandle = '';
                        if (parentNameEl) {
                            const nameNode = parentNameEl.querySelector('span');
                            if (nameNode) parentAuthorName = nameNode.textContent.trim();
                            const handles = Array.from(parentNameEl.querySelectorAll('*'))
                                .map(el => el.textContent.trim())
                                .filter(t => t.startsWith('@') && t.length > 1);
                            if (handles.length > 0) parentAuthorHandle = handles[0];
                        }

                        const parentText = parentTextEl
                            ? (parentTextEl.innerText || parentTextEl.textContent).trim()
                            : '';

                        if (parentText || parentAuthorHandle) {
                            replyContext = {
                                text: parentText,
                                authorName: parentAuthorName,
                                authorHandle: parentAuthorHandle
                            };
                            bgLog(`-> Reply context found: ${parentAuthorHandle} — "${parentText.slice(0, 60)}"`);
                        }
                    }
                }
            }

            tweetsData.push({
                id: tweetId,
                url: tweetUrl,
                timestamp: tweetTime,
                text,
                mediaUrls,
                quotedTweet,   // null, or { text, authorName, authorHandle }
                isRetweet,
                authorName,
                authorHandle,
                isSubscriberOnly,
                replyContext   // null if not a reply, or { text, authorName, authorHandle }
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
    return { tweets: tweetsData, profileMeta };
}

// Listener for background script
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "start_extraction") {
            // Run extraction and reply
            extractTweets(request.globalProcessedIds || [])
                .then(result => sendResponse({ success: true, data: result.tweets, profileMeta: result.profileMeta }))
                .catch(err => sendResponse({ success: false, error: err.message }));

            return true; // Keep message channel open for async response
        }
    });
}

// Export for Node.js Testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { extractTweets, extractProfileMeta };
}

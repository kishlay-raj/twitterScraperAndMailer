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

    // Fallback: document.title usually follows "Name (@handle) / X"
    if (!profileName) {
        const titleMatch = document.title.match(/^(.*?)\s\(/);
        if (titleMatch && titleMatch[1]) {
            profileName = titleMatch[1].trim();
        }
    }

    // Only log internally in extractProfileMetaAsync to avoid spam during polling
    return { profileName, profileHandle, profileAvatarUrl };
}

async function extractProfileMetaAsync(pagePathname) {
    for (let i = 0; i < 8; i++) {
        const meta = extractProfileMeta(pagePathname);
        if (meta.profileName !== '') {
            bgLog(`Profile meta: name="${meta.profileName}", handle="${meta.profileHandle}", avatar=${meta.profileAvatarUrl ? meta.profileAvatarUrl.slice(0, 60) + '...' : 'NOT FOUND'}`);
            return meta;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    const meta = extractProfileMeta(pagePathname);
    bgLog(`Profile meta (fallback): name="${meta.profileName}", handle="${meta.profileHandle}", avatar=${meta.profileAvatarUrl ? meta.profileAvatarUrl.slice(0, 60) + '...' : 'NOT FOUND'}`);
    return meta;
}

async function extractTweets(globalProcessedIds = [], settings = {}) {
    const tweetsData = [];

    // ⚡ Extract profile metadata FIRST — before any scrolling.
    // X's virtual DOM recycles the profile header once it scrolls out of view,
    // so we MUST read it while the page is still at the top.
    // We read the pathname once here so it can also be injected in tests.
    const pagePathname = (typeof window !== 'undefined' && window.location) ? window.location.pathname : '/';
    const profileMeta = await extractProfileMetaAsync(pagePathname);

    // Seed the set with previously sent tweet IDs so we immediately skip them
    const processedTweetIds = new Set(globalProcessedIds);
    const startTime = Date.now();
    let activeTimeMs = 0;

    let attemptsWithNoNewTweets = 0;
    const maxAttempts = 3;

    let durationLimitMs = ONE_DAY_MS;
    if (settings && settings.scrapeDuration && settings.scrapeDurationUnit) {
        durationLimitMs = settings.scrapeDurationUnit === 'days'
            ? settings.scrapeDuration * 24 * 60 * 60 * 1000
            : settings.scrapeDuration * 60 * 60 * 1000;
        bgLog(`Custom scrape duration limit: ${settings.scrapeDuration} ${settings.scrapeDurationUnit} (${durationLimitMs} ms)`);
    } else {
        bgLog(`Using default scrape duration limit: 24 hours`);
    }

    bgLog(`DailyUpdates Scraper started... Pre-loaded ${globalProcessedIds.length} old tweets to skip.`);

    while (attemptsWithNoNewTweets < maxAttempts) {
        const loopStartTime = Date.now();
        // 1. Find all tweet elements on the screen
        const tweetElements = document.querySelectorAll('[data-testid="tweet"]');
        let addedNewTweetThisCycle = false;
        let lastSkippedParentTweetCell = null;

        const prevCount = tweetsData.length;
        for (const tweetEl of tweetElements) {
            // Identify unique tweet (simplest way is by link) for logging purposes
            const linkEl = tweetEl.querySelector('a[href*="/status/"]');
            const tweetUrl = linkEl ? linkEl.href : 'Unknown URL';
            const tweetId = tweetUrl.split('/status/')[1]?.split('?')[0] || 'Unknown ID';

            if (processedTweetIds.has(tweetId)) {
                continue; // silently skip already-seen tweets
            }

            // Extract just the social context first to know if it's a retweet or pinned
            const socialContextText = tweetEl.querySelector('[data-testid="socialContext"]')?.textContent || '';
            const isRetweet = socialContextText.toLowerCase().includes('reposted') || tweetEl.innerHTML.includes('reposted');

            // Skip primary tweets that belong to other users unless it's a retweet by the main profile
            if (profileMeta.profileHandle && tweetUrl !== 'Unknown URL') {
                const targetPath = `/${profileMeta.profileHandle.replace('@', '').toLowerCase()}/status/`;
                const isTargetProfileTweet = tweetUrl.toLowerCase().includes(targetPath);

                if (!isTargetProfileTweet && !isRetweet) {
                    bgLog(`-> Skipping: Tweet URL (${tweetUrl}) does not match target profile ${profileMeta.profileHandle}. Probably a parent thread tweet.`);
                    lastSkippedParentTweetCell = tweetEl.closest('[data-testid="cellInnerDiv"]');
                    if (tweetId !== 'Unknown ID') processedTweetIds.add(tweetId);
                    addedNewTweetThisCycle = true; // Prevents the scraper from thinking it stalled
                    continue; // Skip immediately BEFORE expensive DOM/Date parsing!
                }
            }

            // Skip pinned tweets completely so they don't trigger the 24-hour stop condition
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

            bgLog(`-> Age: ${ageHours}h | ${tweetUrl}`);

            // Check if older than scrape duration limit
            if (ageMs > durationLimitMs) {
                const limitHours = (durationLimitMs / (1000 * 60 * 60)).toFixed(1);
                bgLog(`-> Skipping: ${ageHours}h > ${limitHours}h limit. Stopping profile.`);
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
                    await randomDelay(400, 800); // wait for load
                }
            }

            // Extract all User-Names. Quote tweets have their own User-Name block inside the main tweet.
            const userNames = Array.from(tweetEl.querySelectorAll('[data-testid="User-Name"]'));
            const qNameEl = userNames.length > 1 ? userNames[1] : null;

            // Extract original author (useful for retweets)
            let authorName = 'Unknown';
            let authorHandle = 'Unknown';
            const userNameEl = userNames.length > 0 ? userNames[0] : null;
            if (userNameEl) {
                const nameNode = userNameEl.querySelector('span');
                if (nameNode) authorName = nameNode.textContent.trim();
                const handles = Array.from(userNameEl.querySelectorAll('*'))
                    .map(el => el.textContent.trim())
                    .filter(text => text.startsWith('@') && text.length > 1);
                if (handles.length > 0) authorHandle = handles[0];
            }

            // Extract text content and quoted text content
            let text = '';
            let qText = '';
            const allTexts = Array.from(tweetEl.querySelectorAll('[data-testid="tweetText"]'));
            for (const txtEl of allTexts) {
                if (qNameEl && (qNameEl.compareDocumentPosition(txtEl) & 4)) {
                    qText = (txtEl.innerText || txtEl.textContent).trim();
                } else {
                    text = (txtEl.innerText || txtEl.textContent).trim();
                }
            }

            // Extract images/media URLs and quoted media URLs
            const mediaUrls = [];
            const qMediaUrls = [];

            // 1. Collect from tweetPhoto containers (native uploads) and card images (link previews)
            const photoContainers = Array.from(tweetEl.querySelectorAll(
                '[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img, [data-testid="card.layoutSmall.media"] img, video'
            ));

            // 2. Also collect any img inside a link that points to /photo/ (fallback for non-standard layouts)
            const photoLinkImgs = Array.from(tweetEl.querySelectorAll('a[href*="/photo/"] img'));
            
            // 3. Also check for background-image divs (some link preview cards)
            const bgImageDivs = Array.from(tweetEl.querySelectorAll('div[style*="background-image"]'));

            const allMediaNodes = [...new Set([...photoContainers, ...photoLinkImgs, ...bgImageDivs])];

            for (const node of allMediaNodes) {
                let src = '';

                if (node.tagName.toLowerCase() === 'video') {
                    src = node.getAttribute('poster') || node.src || '';
                } else if (node.tagName.toLowerCase() === 'img') {
                    // X often lazy-loads: try currentSrc first, then src, then srcset
                    src = node.currentSrc || node.src || '';
                    
                    // If src is a blob or data URI, try to get the real URL from srcset
                    if (!src || src.startsWith('blob:') || src.startsWith('data:')) {
                        const srcset = node.getAttribute('srcset') || '';
                        if (srcset) {
                            // srcset format: "url1 1x, url2 2x" – grab the last (highest res) one
                            const parts = srcset.split(',').map(s => s.trim().split(/\s+/)[0]);
                            src = parts[parts.length - 1] || '';
                        }
                    }
                    
                    // Skip tiny images (UI icons, badges, etc.) — real tweet images are > 100px
                    if (node.naturalWidth && node.naturalWidth < 50) continue;
                } else {
                    // div with background-image
                    const style = node.getAttribute('style') || '';
                    const match = style.match(/url\(['"]?(.*?)['"]?\)/);
                    if (match && match[1]) src = match[1];
                }

                // Filter out non-content URLs
                if (!src || src.startsWith('blob:') || src.startsWith('data:')) continue;
                if (src.includes('/profile_images/') || src.includes('/emoji/') || src.includes('/hashflag/')) continue;
                // Skip SVG icons served from abs.twimg.com
                if (src.includes('abs.twimg.com')) continue;

                if (qNameEl && (qNameEl.compareDocumentPosition(node) & 4)) {
                    if (!qMediaUrls.includes(src)) qMediaUrls.push(src);
                } else {
                    if (!mediaUrls.includes(src)) mediaUrls.push(src);
                }
            }

            // (media logged at summary level below)



            // Construct quoted tweet object
            let quotedTweet = null;
            if (qNameEl) {
                let qAuthorName = '';
                let qAuthorHandle = '';
                const nameSpan = qNameEl.querySelector('span');
                if (nameSpan) qAuthorName = nameSpan.textContent.trim();
                const handles = Array.from(qNameEl.querySelectorAll('*'))
                    .map(el => el.textContent.trim())
                    .filter(t => t.startsWith('@') && t.length > 1);
                if (handles.length > 0) qAuthorHandle = handles[0];

                if (qText || qAuthorHandle || qMediaUrls.length > 0) {
                    quotedTweet = {
                        text: qText,
                        authorName: qAuthorName,
                        authorHandle: qAuthorHandle,
                        mediaUrls: qMediaUrls
                    };
                }
            }

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
            const currentCell = tweetEl.closest('[data-testid="cellInnerDiv"]');
            const hasReplyingToText = (tweetEl.innerText || tweetEl.textContent || '').toLowerCase().includes('replying to');

            const isStructurallyAdjacentReply = lastSkippedParentTweetCell && currentCell && currentCell.previousElementSibling === lastSkippedParentTweetCell;

            if (hasReplyingToText || isStructurallyAdjacentReply) {
                // Walk up to the timeline cell that wraps this tweet
                const prevCell = isStructurallyAdjacentReply ? lastSkippedParentTweetCell : (currentCell && currentCell.previousElementSibling);
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

                        const parentMedia = [];
                        const parentImgElements = parentTweetEl.querySelectorAll('[data-testid="tweetPhoto"] img, video');
                        parentImgElements.forEach(img => {
                            if (img.src) parentMedia.push(img.src);
                        });

                        if (parentText || parentAuthorHandle || parentMedia.length > 0) {
                            replyContext = {
                                text: parentText,
                                authorName: parentAuthorName,
                                authorHandle: parentAuthorHandle,
                                mediaUrls: parentMedia
                            };
                            bgLog(`-> Reply context found: ${parentAuthorHandle} — "${parentText.slice(0, 60)}"`);
                        }
                    }
                }
            }

            // Clear the structurally adjacent tracker since this tweet was kept.
            // Any following tweet would be independent unless a new parent tweet is explicitly skipped.
            lastSkippedParentTweetCell = null;

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

        const loopElapsedMs = Date.now() - loopStartTime;
        activeTimeMs += Math.min(loopElapsedMs, 30000); // cap to 30s per loop to safely bypass system sleep jumps

        // Check if we hit the maximum attempts or the 4 minute safety limit to prevent Chrome Extension port channel disconnects
        if (activeTimeMs > 4 * 60 * 1000) {
            bgLog(`Scraping interrupted: Approaching Chrome 5-minute timeout. Sending available data.`);
            break;
        }
        const newThisBatch = tweetsData.length - prevCount;
        if (newThisBatch > 0) {
            bgLog(`Batch: ${newThisBatch} new tweet(s) accepted (${tweetElements.length} on screen, ${tweetsData.length} total so far).`);
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
            extractTweets(request.globalProcessedIds || [], request.settings || {})
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

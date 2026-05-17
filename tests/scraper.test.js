/**
 * @jest-environment jsdom
 */

// Mock chrome API FIRST — before any require() so scraper.js finds it at module-load time
global.chrome = {
    runtime: {
        sendMessage: jest.fn(),
        onMessage: {
            addListener: jest.fn()
        }
    }
};

const { extractTweets, extractProfileMeta } = require('../content/scraper.js');
const { randomDelay, humanScroll } = require('../content/utils.js');

// Mock utils by attaching directly to the global object (since in Chrome they share the same global context)
global.randomDelay = jest.fn().mockResolvedValue();
global.humanScroll = jest.fn().mockResolvedValue();

describe('X Profile Scraper', () => {
    let originalNow;
    // Capture the onMessage listener BEFORE clearAllMocks runs in beforeEach.
    // scraper.js registers it at require() time (module load), so we grab it once here.
    let onMessageListener;

    beforeAll(() => {
        onMessageListener = chrome.runtime.onMessage.addListener.mock.calls[0]?.[0];
    });

    beforeEach(() => {
        // Mock Date.now() to a fixed timestamp for age calculation testing
        originalNow = Date.now;
        const fixedNow = new Date('2026-03-08T12:00:00Z').getTime();
        global.Date.now = jest.fn(() => fixedNow);

        // Setup JSDOM body
        document.body.innerHTML = '';
        jest.clearAllMocks();
    });

    afterEach(() => {
        global.Date.now = originalNow;
    });

    test('should extract a standard tweet correctly', async () => {
        document.body.innerHTML = `
            <div data-testid="tweet">
                <a href="https://x.com/user/status/123456789">Time</a>
                <time datetime="2026-03-08T10:00:00Z"></time>
                <div data-testid="tweetText">Hello World</div>
                <div data-testid="User-Name">
                    <span>Main User</span>
                    <span>@mainuser</span>
                </div>
            </div>
        `;

        const { tweets } = await extractTweets();

        console.log("TWEETS:", JSON.stringify(tweets, null, 2)); expect(tweets).toHaveLength(1);
        expect(tweets[0].id).toBe('123456789');
        expect(tweets[0].text).toBe('Hello World');
        expect(tweets[0].authorName).toBe('Main User');
        expect(tweets[0].authorHandle).toBe('@mainuser');
        expect(tweets[0].isRetweet).toBe(false);
        expect(tweets[0].isSubscriberOnly).toBe(false);
        expect(tweets[0].mediaUrls).toHaveLength(0);
    });

    test('should detect Reposts and Subscriber-Only badges', async () => {
        document.body.innerHTML = `
            <div data-testid="tweet">
                <div data-testid="socialContext">Alice Reposted</div>
                <a href="https://x.com/user/status/987654321">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
                <div data-testid="tweetText">Secret info</div>
                <span>Subscriber-only</span>
            </div>
        `;

        const { tweets } = await extractTweets();

        console.log("TWEETS:", JSON.stringify(tweets, null, 2)); expect(tweets).toHaveLength(1);
        expect(tweets[0].isRetweet).toBe(true);
        expect(tweets[0].isSubscriberOnly).toBe(true);
    });

    test('should completely skip Pinned tweets', async () => {
        document.body.innerHTML = `
            <div data-testid="tweet">
                <div data-testid="socialContext">Pinned</div>
                <a href="https://x.com/user/status/111111111">Time</a>
                <time datetime="2025-01-01T10:00:00Z"></time>
            </div>
            <div data-testid="tweet">
                <a href="https://x.com/user/status/222222222">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
                <div data-testid="tweetText">Normal tweet</div>
            </div>
        `;

        const { tweets } = await extractTweets();

        console.log("TWEETS:", JSON.stringify(tweets, null, 2)); expect(tweets).toHaveLength(1);
        expect(tweets[0].id).toBe('222222222');
    });

    test('should skip tweets older than 24 hours (Replies bugfix)', async () => {
        // Current fake time is 2026-03-08T12:00:00Z
        document.body.innerHTML = `
            <div data-testid="tweet">
                <a href="https://x.com/user/status/old">Time</a>
                <!-- 3 days old -->
                <time datetime="2026-03-05T10:00:00Z"></time> 
                <div data-testid="tweetText">Old parent</div>
            </div>
            <div data-testid="tweet">
                <a href="https://x.com/user/status/new">Time</a>
                <!-- 1 hour old -->
                <time datetime="2026-03-08T11:00:00Z"></time>
                <div data-testid="tweetText">New reply</div>
            </div>
        `;

        const { tweets } = await extractTweets();

        console.log("TWEETS:", JSON.stringify(tweets, null, 2)); expect(tweets).toHaveLength(1);
        expect(tweets[0].id).toBe('new');
        expect(tweets[0].text).toBe('New reply');
    });

    test('should extract profile metadata (avatar, name, handle) from page header', async () => {
        // Pass the pathname explicitly to bypass window.location (not mockable in jsdom)
        document.body.innerHTML = `
            <a href="/Minakshishriyan/photo">
                <img src="https://pbs.twimg.com/profile_images/123/photo.jpg" />
            </a>
            <div data-testid="UserName">
                <span>Minakshi Shriyan</span>
                <span>@Minakshishriyan</span>
            </div>
        `;

        const profileMeta = extractProfileMeta('/Minakshishriyan');

        expect(profileMeta.profileHandle).toBe('@Minakshishriyan');
        expect(profileMeta.profileName).toBe('Minakshi Shriyan');
        expect(profileMeta.profileAvatarUrl).toBe('https://pbs.twimg.com/profile_images/123/photo.jpg');
    });

    test('should extract media URLs (main and quoted)', async () => {
        document.body.innerHTML = `
            <div data-testid="tweet">
                <a href="https://x.com/user/status/media123">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
                
                <div data-testid="User-Name"><span>Main User</span><span>@main</span></div>
                <div data-testid="tweetText">Main text</div>
                <div data-testid="tweetPhoto">
                    <img src="https://pbs.twimg.com/media/main.jpg" />
                </div>

                <!-- Quote Tweet sub-structure -->
                <div data-testid="User-Name"><span>Quoted User</span><span>@quoted</span></div>
                <div data-testid="tweetText">Quoted text</div>
                <div data-testid="tweetPhoto">
                    <img src="https://pbs.twimg.com/media/quoted.jpg" />
                </div>
            </div>
        `;

        const { tweets } = await extractTweets();
        
        expect(tweets[0].mediaUrls).toContain('https://pbs.twimg.com/media/main.jpg');
        expect(tweets[0].quotedTweet.mediaUrls).toContain('https://pbs.twimg.com/media/quoted.jpg');
        expect(tweets[0].quotedTweet.text).toBe('Quoted text');
    });

    test('should detect Subscriber-only status from SVG path', async () => {
        document.body.innerHTML = `
            <div data-testid="tweet">
                <a href="https://x.com/user/status/sub123">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
                <svg><path d="M12 1.75l2.69 5.454 6.02.875"></path></svg>
            </div>
        `;

        const { tweets } = await extractTweets();
        expect(tweets[0].isSubscriberOnly).toBe(true);
    });

    test('should extract structural Reply Context from previous sibling', async () => {
        document.body.innerHTML = `
            <div data-testid="cellInnerDiv">
                <div data-testid="tweet">
                    <div data-testid="User-Name"><span>Parent User</span><span>@parent</span></div>
                    <div data-testid="tweetText">Original parent tweet</div>
                </div>
            </div>
            <div data-testid="cellInnerDiv">
                <div data-testid="tweet">
                    <a href="https://x.com/target/status/reply456">Time</a>
                    <time datetime="2026-03-08T11:30:00Z"></time>
                    <div data-testid="tweetText">Replying to @parent</div>
                </div>
            </div>
        `;

        // Mock profileMeta.profileHandle to match 'target' so it's not skipped
        const { tweets } = await extractTweets([], { profileHandle: '@target' });
        
        console.log("TWEETS:", JSON.stringify(tweets, null, 2)); expect(tweets).toHaveLength(1);
        expect(tweets[0].replyContext).not.toBeNull();
        expect(tweets[0].replyContext.authorHandle).toBe('@parent');
        expect(tweets[0].replyContext.text).toBe('Original parent tweet');
    });

    test('should skip non-target tweets not from the specified profile handle unless retweeted', async () => {
        // Use history.pushState to set the jsdom URL — avoids re-defining non-configurable window.location
        history.pushState(null, '', '/targetuser');

        document.body.innerHTML = `
            <div data-testid="tweet">
                <a href="https://x.com/otheruser/status/111">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
                <div data-testid="tweetText">Not from target user</div>
            </div>
            <div data-testid="tweet">
                <a href="https://x.com/targetuser/status/222">Time</a>
                <time datetime="2026-03-08T11:05:00Z"></time>
                <div data-testid="tweetText">From target user</div>
            </div>
            <div data-testid="tweet">
                <div data-testid="socialContext">Target Reposted</div>
                <a href="https://x.com/anotheruser/status/333">Time</a>
                <time datetime="2026-03-08T11:10:00Z"></time>
                <div data-testid="tweetText">Retweet from target user</div>
            </div>
        `;

        const { tweets } = await extractTweets();

        // tweet 222 is a direct match, 333 is a retweet — both should be kept
        // tweet 111 from @otheruser should be skipped (not target, not retweet)
        expect(tweets).toHaveLength(2);
        expect(tweets[0].id).toBe('222');
        expect(tweets[1].id).toBe('333');
        expect(tweets[1].isRetweet).toBe(true);

        // Restore URL
        history.pushState(null, '', '/');
    });

    test('should not click "Show more" if it is nested inside an anchor tag', async () => {
        document.body.innerHTML = `
            <div data-testid="tweet">
                <a href="https://x.com/user/status/123">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
                <div data-testid="tweetText">Long tweet...</div>
                <a href="/status/123"><span>Show more</span></a>
            </div>
            <div data-testid="tweet">
                <a href="https://x.com/user/status/456">Time</a>
                <time datetime="2026-03-08T11:05:00Z"></time>
                <div data-testid="tweetText">Another long tweet...</div>
                <div role="button"><span>Show more</span></div>
            </div>
        `;

        // The first tweet has Show more inside an <a href="..."> — should NOT click.
        // The second tweet has Show more in a span/div — SHOULD click.
        const mockClick1 = jest.fn();
        const mockClick2 = jest.fn();

        const spans = Array.from(document.body.querySelectorAll('span')).filter(s => s.textContent === 'Show more');
        if (spans[0]) spans[0].click = mockClick1;
        if (spans[1]) spans[1].click = mockClick2;

        await extractTweets();

        expect(mockClick1).not.toHaveBeenCalled();
        expect(mockClick2).toHaveBeenCalled();
    });

    test('should handle complex media URLs (lazy-loaded srcsets, bg-images, explicit /photo links)', async () => {
        document.body.innerHTML = `
            <div data-testid="tweet">
                <a href="https://x.com/user/status/complexMedia">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
                
                <!-- Lazy loaded img using srcset over blob src -->
                <div data-testid="tweetPhoto">
                    <img src="blob:https://x.com/123-abc" srcset="https://pbs.twimg.com/media/low.jpg 1x, https://pbs.twimg.com/media/high.jpg 2x" />
                </div>
                
                <!-- Small badge img (should be skipped due to naturalWidth) -->
                <div data-testid="tweetPhoto">
                    <img src="https://pbs.twimg.com/media/badge.jpg" />
                </div>

                <!-- Fallback /photo/ link -->
                <a href="/user/status/123/photo/1">
                    <img src="https://pbs.twimg.com/media/fallbackPhoto.jpg" />
                </a>

                <!-- Background Image (e.g. some link preview cards) -->
                <div style="background-image: url('https://pbs.twimg.com/media/bgCard.jpg')"></div>
            </div>
        `;

        // Mock naturalWidth for the badge img to simulate a tiny icon
        const imgs = document.body.querySelectorAll('img');
        Object.defineProperty(imgs[1], 'naturalWidth', { get: () => 20 }); // The badge img
        Object.defineProperty(imgs[0], 'naturalWidth', { get: () => 600 });
        Object.defineProperty(imgs[2], 'naturalWidth', { get: () => 600 });

        const { tweets } = await extractTweets();
        const mediaUrls = tweets[0].mediaUrls;

        expect(mediaUrls).toContain('https://pbs.twimg.com/media/high.jpg'); // Took highest res from srcset
        expect(mediaUrls).not.toContain('https://pbs.twimg.com/media/low.jpg'); // Ignored lower res
        expect(mediaUrls).not.toContain('blob:https://x.com/123-abc'); // Ignored blob

        expect(mediaUrls).not.toContain('https://pbs.twimg.com/media/badge.jpg'); // Skipped because width < 50
        
        expect(mediaUrls).toContain('https://pbs.twimg.com/media/fallbackPhoto.jpg'); // Handled /photo/ link fallback
        expect(mediaUrls).toContain('https://pbs.twimg.com/media/bgCard.jpg'); // Handled background-image regex
    });

    test('should skip invalid tweets gracefully (no time tag, empty ID, completely blank)', async () => {
        document.body.innerHTML = `
            <!-- Invalid: No time tag -->
            <div data-testid="tweet">
                <a href="https://x.com/user/status/111">Time</a>
                <div data-testid="tweetText">Missing time</div>
            </div>
            
            <!-- Invalid: Cannot find tweet status ID -->
            <div data-testid="tweet">
                <a href="https://x.com/some/random/link">Link</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
            </div>
            
            <!-- Valid Tweet -->
            <div data-testid="tweet">
                <a href="https://x.com/user/status/222">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
                <div data-testid="tweetText">Valid entry</div>
            </div>
        `;

        const { tweets } = await extractTweets();
        expect(tweets).toHaveLength(1);
        expect(tweets[0].id).toBe('222');
    });

    test('should correctly handle chrome.runtime.onMessage for start_extraction', () => {
        // onMessageListener was captured in beforeAll before clearAllMocks wiped the mock history.
        expect(onMessageListener).toBeDefined();

        document.body.innerHTML = `
            <a href="/user/photo">
                <img src="https://pbs.twimg.com/profile_images/123/photo.jpg" />
            </a>
            <div data-testid="UserName">
                <span>User Name</span>
                <span>@user</span>
            </div>
            <div data-testid="tweet">
                <a href="https://x.com/user/status/222">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time>
                <div data-testid="tweetText">Valid entry</div>
            </div>
        `;

        const sendResponse = jest.fn();
        const request = { action: 'start_extraction', globalProcessedIds: [], settings: {} };

        // The listener returns `true` to indicate it will respond asynchronously
        const result = onMessageListener(request, {}, sendResponse);
        expect(result).toBe(true);

        // Wait for the promise chain inside the listener to resolve
        return new Promise((resolve) => {
            setTimeout(() => {
                expect(sendResponse).toHaveBeenCalled();
                const responseData = sendResponse.mock.calls[0][0];
                expect(responseData.success).toBe(true);
                expect(Array.isArray(responseData.data)).toBe(true);
                resolve();
            }, 200);
        });
    });
});

/**
 * @jest-environment jsdom
 */
const { extractTweets, extractProfileMeta } = require('../content/scraper.js');
const { randomDelay, humanScroll } = require('../content/utils.js');

// Mock utils by attaching directly to the global object (since in Chrome they share the same global context)
global.randomDelay = jest.fn().mockResolvedValue();
global.humanScroll = jest.fn().mockResolvedValue();

// Mock chrome API
global.chrome = {
    runtime: {
        sendMessage: jest.fn()
    }
};

describe('X Profile Scraper', () => {
    let originalNow;

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

        expect(tweets).toHaveLength(1);
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

        expect(tweets).toHaveLength(1);
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

        expect(tweets).toHaveLength(1);
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

        expect(tweets).toHaveLength(1);
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
        
        expect(tweets).toHaveLength(1);
        expect(tweets[0].replyContext).not.toBeNull();
        expect(tweets[0].replyContext.authorHandle).toBe('@parent');
        expect(tweets[0].replyContext.text).toBe('Original parent tweet');
    });

    test('should respect custom duration limit in settings', async () => {
        // Mock current time: 2026-03-08T12:00:00Z
        document.body.innerHTML = `
            <div data-testid="tweet">
                <a href="https://x.com/user/status/too_old">Time</a>
                <time datetime="2026-03-08T06:00:00Z"></time> <!-- 6 hours old -->
            </div>
            <div data-testid="tweet">
                <a href="https://x.com/user/status/just_right">Time</a>
                <time datetime="2026-03-08T11:00:00Z"></time> <!-- 1 hour old -->
            </div>
        `;

        // Limit to 2 hours
        const settings = { scrapeDuration: 2, scrapeDurationUnit: 'hours' };
        const { tweets } = await extractTweets([], settings);
        
        expect(tweets).toHaveLength(1);
        expect(tweets[0].id).toBe('just_right');
    });
});

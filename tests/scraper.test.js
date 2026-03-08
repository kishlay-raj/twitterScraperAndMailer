/**
 * @jest-environment jsdom
 */
const { extractTweets } = require('../content/scraper.js');
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

        const tweets = await extractTweets();

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

        const tweets = await extractTweets();

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

        const tweets = await extractTweets();

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

        const tweets = await extractTweets();

        expect(tweets).toHaveLength(1);
        expect(tweets[0].id).toBe('new');
        expect(tweets[0].text).toBe('New reply');
    });
});

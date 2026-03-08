const { summarizeTweets } = require('../background/llm_api.js');

describe('LLM API', () => {
    let originalConsoleError;

    beforeEach(() => {
        global.fetch = jest.fn();
        originalConsoleError = console.error;
        console.error = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        console.error = originalConsoleError;
    });

    test('should return early message if tweets array is empty', async () => {
        const result = await summarizeTweets([], 'test_key');
        expect(result).toBe('No updates in the last 24 hours.');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('should return early error if API key is missing', async () => {
        const result = await summarizeTweets([{ text: 'hi' }], '');
        expect(result).toBe('Error: LLM API Key is missing.');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('should correctly build payload and parse successful response', async () => {
        const mockTweets = [
            { timestamp: 1709400000000, text: 'Hello world', quotedText: '', url: 'http://t1', isRetweet: false, isSubscriberOnly: false },
            { timestamp: 1709400000000, text: 'Second tweet', quotedText: '', url: 'http://t2', isRetweet: true, authorName: 'Alice', authorHandle: '@alice', isSubscriberOnly: true }
        ];

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'This is the summary.' } }]
            })
        });

        const result = await summarizeTweets(mockTweets, 'valid_key');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);

        // Verify the prompt contains our expected identifiers
        expect(requestBody.messages[0].content).toContain('Hello world');
        expect(requestBody.messages[0].content).toContain('Second tweet');
        expect(requestBody.messages[0].content).toContain('Reposted From: Alice (@alice)');
        expect(requestBody.messages[0].content).toContain('[SUBSCRIBER EXCLUSIVE POST]');
        expect(result).toBe('This is the summary.');
    });

    test('should gracefully handle non-ok HTTP responses', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 401
        });

        const result = await summarizeTweets([{ text: 'hi' }], 'invalid_key');
        expect(console.error).toHaveBeenCalled();
        expect(result).toContain('Error generating summary');
        expect(result).toContain('401');
    });

    test('should gracefully handle network failures', async () => {
        global.fetch.mockRejectedValueOnce(new Error('Network offline'));

        const result = await summarizeTweets([{ text: 'hi' }], 'valid_key');
        expect(console.error).toHaveBeenCalled();
        expect(result).toBe('Error generating summary: Network offline');
    });
});

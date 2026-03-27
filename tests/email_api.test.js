const { sendEmailPayload } = require('../background/email_api.js');

describe('Email API', () => {
    let originalConsoleError;
    let originalConsoleLog;

    beforeEach(() => {
        // Mock fetch
        global.fetch = jest.fn();
        // Silence console logs/errors during testing
        originalConsoleError = console.error;
        originalConsoleLog = console.log;
        console.error = jest.fn();
        console.log = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        console.error = originalConsoleError;
        console.log = originalConsoleLog;
    });

    test('should abort if missing webhookUrl or recipientEmail', async () => {
        await sendEmailPayload('<p>Test</p>', null, 'http://webhook');
        expect(global.fetch).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith('Missing Webhook URL or Recipient Email.');
    });

    test('should send correct POST payload on success', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ status: 'success' })
        });

        const html = '<p>Hello</p>';
        const email = 'test@example.com';
        const url = 'http://webhook.test';

        await sendEmailPayload(html, email, url);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch).toHaveBeenCalledWith(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=utf-8'
            },
            body: expect.any(String) // We verify it's a string, specific contents below
        });

        const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(requestBody.recipient).toBe(email);
        expect(requestBody.html).toBe(html);
        expect(requestBody.subject).toContain('Your Antigravity Curation');

        expect(console.log).toHaveBeenCalledWith('Email dispatched successfully via Apps Script Webhook!');
    });

    test('should include cc in payload if provided', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ status: 'success' })
        });

        const html = '<p>Hello</p>';
        const email = 'test@example.com';
        const url = 'http://webhook.test';
        const cc = 'cc1@test.com, cc2@test.com';

        await sendEmailPayload(html, email, url, 'Test Subject', cc);

        const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(requestBody.recipient).toBe(email);
        expect(requestBody.cc).toBe(cc);
    });

    test('should handle network errors gracefully', async () => {
        global.fetch.mockRejectedValueOnce(new Error('Network failure'));

        await sendEmailPayload('<p>Test</p>', 'test@test.com', 'http://webhook');

        expect(console.error).toHaveBeenCalledWith('Email API failed:', expect.any(Error));
    });

    test('should handle API endpoint errors gracefully', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error'
        });

        await sendEmailPayload('<p>Test</p>', 'test@test.com', 'http://webhook');

        expect(console.error).toHaveBeenCalledWith('Email API failed:', expect.any(Error));
    });
});

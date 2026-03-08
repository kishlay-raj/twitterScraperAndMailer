const { randomDelay } = require('../content/utils.js');

describe('Utils', () => {
    beforeAll(() => {
        jest.useFakeTimers();
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    test('randomDelay resolves after a time between min and max', async () => {
        const min = 1000;
        const max = 3000;

        const promise = randomDelay(min, max);

        // Fast-forward time until the maximum possible delay
        jest.advanceTimersByTime(max);

        await expect(promise).resolves.toBeUndefined();
    });
});

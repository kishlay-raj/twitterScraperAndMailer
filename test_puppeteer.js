const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    await page.goto('https://x.com/NaturePortfolio/status/2034646074212687944', { waitUntil: 'networkidle2' });
    
    // Wait for the tweet element to load
    try {
        await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 });
        const html = await page.evaluate(() => {
            const tweet = document.querySelector('[data-testid="tweet"]');
            return tweet ? tweet.innerHTML : 'No tweet found';
        });
        console.log("HTML:", html.slice(0, 3000)); // Log first part of HTML
    } catch(e) {
        console.log("Error waiting for tweet: ", e.message);
    }
    
    await browser.close();
})();

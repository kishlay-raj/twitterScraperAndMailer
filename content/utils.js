// Helper to wait for a random duration
// Adds human-like delay to avoid bot detection
function randomDelay(min = 1000, max = 3000) {
    const delay = Math.floor(Math.random() * (max - min) + min);
    return new Promise(resolve => setTimeout(resolve, delay));
}

// Function to smoothly scroll
async function humanScroll() {
    const scrollHeight = document.body.scrollHeight;
    const viewportHeight = window.innerHeight;
    const currentScroll = window.scrollY;

    // Scroll down a random amount between half and full viewport
    const scrollAmount = Math.floor(Math.random() * viewportHeight * 0.5) + viewportHeight * 0.5;
    const targetScroll = Math.min(currentScroll + scrollAmount, scrollHeight);

    window.scrollTo({
        top: targetScroll,
        behavior: 'smooth'
    });

    await randomDelay(800, 1500);
}

// Export for Node.js Testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { randomDelay, humanScroll };
}

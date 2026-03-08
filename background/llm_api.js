/**
 * LLM API Integration for Summarization
 */

async function summarizeTweets(tweets, apiKey) {
    if (!tweets || tweets.length === 0) return "No updates in the last 24 hours.";
    if (!apiKey) return "Error: LLM API Key is missing.";

    // Format tweets into a prompt
    const textPayload = tweets.map((t, idx) => {
        const dateStr = new Date(t.timestamp).toLocaleString();
        const retweetInfo = t.isRetweet ? `\nReposted From: ${t.authorName} (${t.authorHandle})` : '';
        const subInfo = t.isSubscriberOnly ? `\n[SUBSCRIBER EXCLUSIVE POST]` : '';
        return `Tweet ${idx + 1}:${subInfo}\nDate: ${dateStr}${retweetInfo}\nText: ${t.text}\nQuoted: ${t.quotedText}\nURL: ${t.url}`;
    }).join("\n\n");

    const prompt = `You are an expert curator. Please provide a single, cohesive overall summary of the following tweets from a specific X (Twitter) profile over the last 24 hours. DO NOT summarize each tweet individually. Instead, weave them together to give a big-picture overview of their recent activity, highlighting the most important updates, announcements, or common themes. \n\nTweets:\n${textPayload}`;

    try {
        const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "Qwen/Qwen2.5-72B-Instruct",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 1000
            })
        });

        if (!response.ok) {
            throw new Error(`Hugging Face API Error: ${response.status} - Please ensure your free token is valid.`);
        }

        const data = await response.json();
        const generatedText = data.choices[0].message.content;
        return generatedText.trim();
    } catch (err) {
        console.error("LLM Summarization failed:", err);
        return `Error generating summary: ${err.message}`;
    }
}

// Export for Node.js Testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { summarizeTweets };
}

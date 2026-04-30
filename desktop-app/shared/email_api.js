/**
 * Email Dispatch Integration via Google Apps Script Webhook
 */

async function sendEmailPayload(htmlContent, recipientEmail, webhookUrl, customSubject = null, cc = null) {
    if (!webhookUrl || !recipientEmail) {
        console.error("Missing Webhook URL or Recipient Email.");
        return;
    }

    try {
        const timeString = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        const emailSubject = customSubject ? `${customSubject} - ${timeString}` : `Your DailyUpdates Curation - ${timeString}`;

        const payload = {
            recipient: recipientEmail,
            subject: emailSubject,
            html: htmlContent
        };
        if (cc) {
            payload.cc = cc;
        }

        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain;charset=utf-8" // Important: Apps Script prefers plain POST payload for custom JSON parsing
            },
            body: JSON.stringify(payload)
        });

        const rawText = await response.text();

        if (!response.ok) {
            throw new Error(`Webhook Error (HTTP ${response.status}): ${rawText.slice(0, 500)}`);
        }

        let data;
        try {
            data = JSON.parse(rawText);
        } catch (_) {
            // Apps Script returned HTML (e.g. a redirect/login page) instead of JSON.
            // This usually means the webhook URL is invalid or the Apps Script deployment has an auth issue.
            console.error("Email API: Apps Script returned non-JSON (likely HTML redirect):", rawText.slice(0, 300));
            throw new Error(`Apps Script returned HTML instead of JSON. Check webhook URL & deployment settings. Preview: ${rawText.slice(0, 150)}`);
        }

        if (data.status === "success") {
            console.log("Email dispatched successfully via Apps Script Webhook!");
        } else {
            // Surface the Apps Script error (e.g. "Limit Exceeded: Email Body Size")
            const errMsg = data.message || JSON.stringify(data);
            console.error("Apps Script Error:", errMsg);
            throw new Error(`Apps Script Error: ${errMsg}`);
        }
    } catch (err) {
        console.error("Email API failed:", err.message || err);
        throw err; // Re-throw so the caller (processAndDispatch) can handle / log it
    }
}

// Export for Node.js Testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { sendEmailPayload };
}

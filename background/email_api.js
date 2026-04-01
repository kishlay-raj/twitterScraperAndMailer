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
            throw new Error(`Webhook Error: ${response.status} - ${rawText.slice(0, 500)}`);
        }

        let data;
        try {
            data = JSON.parse(rawText);
        } catch (_) {
            // Apps Script returned HTML (e.g. an error page) instead of JSON.
            // Log the first 500 chars so we can diagnose without crashing.
            console.error("Email API: Apps Script returned non-JSON response:", rawText.slice(0, 500));
            return;
        }

        if (data.status === "success") {
            console.log("Email dispatched successfully via Apps Script Webhook!");
        } else {
            console.error("Apps Script Error:", data.message);
        }
    } catch (err) {
        console.error("Email API failed:", err);
    }
}

// Export for Node.js Testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { sendEmailPayload };
}

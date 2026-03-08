/**
 * Email Dispatch Integration via Google Apps Script Webhook
 */

async function sendEmailPayload(htmlContent, recipientEmail, webhookUrl, customSubject = null) {
    if (!webhookUrl || !recipientEmail) {
        console.error("Missing Webhook URL or Recipient Email.");
        return;
    }

    try {
        const timeString = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        const emailSubject = customSubject ? `${customSubject} - ${timeString}` : `Your Antigravity Curation - ${timeString}`;

        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain;charset=utf-8" // Important: Apps Script prefers plain POST payload for custom JSON parsing
            },
            body: JSON.stringify({
                recipient: recipientEmail,
                subject: emailSubject,
                html: htmlContent
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Webhook Error: ${response.status} - ${errText}`);
        }

        const data = await response.json();
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

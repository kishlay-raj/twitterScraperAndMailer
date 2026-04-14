/**
 * LLM API Integration for Summarization
 * Primary: Google Gemini (gemini-2.0-flash) — supports multiple comma-separated keys tried in order
 * Fallback: Hugging Face (Qwen/Qwen2.5-72B-Instruct)
 */

const GEMINI_TIMEOUT_MS = 30_000;
const HF_TIMEOUT_MS     = 45_000;

function fetchWithTimeout(url, options, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

// ── Section style map ─────────────────────────────────────────────────────────
const SECTION_STYLES = {
    '📝': { bg: '#f0fdf4', border: '#86efac', title: '#166534', icon: '📝' },
    '🚨': { bg: '#fff7ed', border: '#fdba74', title: '#9a3412', icon: '🚨' },
    '📖': { bg: '#eff6ff', border: '#93c5fd', title: '#1e40af', icon: '📖' },
};

function getSectionStyle(line) {
    for (const [emoji, style] of Object.entries(SECTION_STYLES)) {
        if (line.includes(emoji)) return style;
    }
    return { bg: '#f8f9fa', border: '#d1d5db', title: '#374151', icon: '' };
}

/**
 * Converts AI markdown output to email-safe HTML.
 * Handles:
 *   - Section headers: "## 📝 Title" or "**📝 Title**" or "1. 📝 Title"
 *   - Bullet lists: "- item"
 *   - Bold labels in text: "**Label:** text"
 *   - Fact-check triple pattern: **Claim/Why/Fact:** lines
 *   - Glossary: "- **Term:** Definition"
 *   - Empty lines, inline bold, italic
 */
function markdownToEmailHtml(text) {
    if (!text) return '';

    const lines = text.split('\n');
    const parts = [];
    let inList = false;
    let currentSection = null;
    let sectionBuffer = [];

    function flushSection() {
        if (!currentSection) return;
        const style = getSectionStyle(currentSection.title);
        const innerHtml = renderLines(currentSection.lines);
        parts.push(`
<table role="presentation" cellpadding="0" cellspacing="0" border="0"
       style="width:100%;margin:12px 0 0 0;border-radius:8px;overflow:hidden;
              border:1px solid ${style.border};">
  <tr>
    <td style="background:${style.bg};padding:10px 14px 4px 14px;">
      <div style="font-size:12px;font-weight:800;color:${style.title};
                  text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
        ${currentSection.title}
      </div>
      ${innerHtml}
    </td>
  </tr>
</table>`);
        currentSection = null;
    }

    function renderLines(lineArr) {
        const out = [];
        let inUl = false;

        for (let line of lineArr) {
            // Apply inline formatting
            line = line
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

            // Bullet item
            if (/^[-•]\s+/.test(line)) {
                if (!inUl) { out.push('<ul style="margin:4px 0 8px 0;padding-left:16px;">'); inUl = true; }
                const item = line.replace(/^[-•]\s+/, '');
                out.push(`<li style="font-size:13.5px;color:#1c1917;line-height:1.7;margin-bottom:3px;">${item}</li>`);
                continue;
            }

            if (inUl) { out.push('</ul>'); inUl = false; }

            if (line.trim() === '') {
                out.push('<div style="height:4px;"></div>');
                continue;
            }

            // Lines that look like "**Label:** text" — highlight the label
            // (already converted to <strong> above)
            out.push(`<div style="font-size:13.5px;color:#1c1917;line-height:1.75;margin-bottom:3px;">${line}</div>`);
        }
        if (inUl) out.push('</ul>');
        return out.join('\n');
    }

    for (const line of lines) {
        const trimmed = line.trim();

        // Detect section header patterns:
        //   ## 📝 Title  /  **📝 Title**  /  1. 📝 Title  /  1. **📝 Title**
        const isSectionHeader =
            /^#{1,3}\s/.test(trimmed) ||
            /^\d+\.\s/.test(trimmed) && trimmed.match(/[📝🚨📖]/u) ||
            /^\*\*[📝🚨📖]/.test(trimmed);

        if (isSectionHeader) {
            flushSection();
            // Strip markdown syntax to get clean title
            let title = trimmed
                .replace(/^#{1,3}\s*/, '')
                .replace(/^\d+\.\s*/, '')
                .replace(/\*\*/g, '')
                .trim();
            currentSection = { title, lines: [] };
            continue;
        }

        if (currentSection) {
            currentSection.lines.push(line);
        } else {
            // Content before any section header — render as intro paragraph
            if (trimmed !== '') {
                let formatted = trimmed
                    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
                parts.push(`<div style="font-size:14px;color:#1c1917;line-height:1.8;margin-bottom:6px;font-weight:600;">${formatted}</div>`);
            } else {
                parts.push('<div style="height:4px;"></div>');
            }
        }
    }

    flushSection();
    return parts.join('\n');
}

/**
 * Summarizes a list of tweets.
 * @param {Array}  tweets         - Array of tweet objects.
 * @param {string} geminiApiKeys  - Comma-separated Gemini API keys.
 * @param {string} hfApiKey       - Hugging Face API key (final fallback).
 * @param {string} [customPrompt] - Optional instruction — replaces the default prompt entirely.
 * @returns {Promise<string>} Summary HTML with model attribution.
 */
async function summarizeTweets(tweets, geminiApiKeys, hfApiKey, customPrompt) {
    if (!tweets || tweets.length === 0) return "No updates in the last 24 hours.";

    const textPayload = tweets.map((t, idx) => {
        const dateStr = new Date(t.timestamp).toLocaleString();
        const retweetInfo = t.isRetweet ? `\nReposted From: ${t.authorName} (${t.authorHandle})` : '';
        const subInfo = t.isSubscriberOnly ? `\n[SUBSCRIBER EXCLUSIVE POST]` : '';
        return `Tweet ${idx + 1}:${subInfo}\nDate: ${dateStr}${retweetInfo}\nText: ${t.text}\nQuoted: ${t.quotedText || ''}\nURL: ${t.url}`;
    }).join("\n\n");

    const defaultInstruction = `You are an expert analyst. Summarize the following tweets into a concise, scannable digest.

Start with a single bold sentence giving the big-picture overview.
Then write exactly these three sections using these headers:

## 📝 Minimal Summary
Synthesize the tweets into 4–6 concise bullet points (use "- " prefix). Be factual and direct. No fluff.

## 🚨 Fact-Check & Misinformation Report
Check for false, misleading, or unverified claims. For each issue found, write three lines:
- **Claim:** [the specific claim]
- **Issue:** [why it is misleading or wrong]
- **Fact:** [the verified reality]
If nothing problematic is found, write: No obvious misinformation detected.

## 📖 Glossary of Terms
List any jargon, acronyms, or niche terms using "- **Term:** definition" format.
If no complex terms appear, write: No lesser-known terms detected.`;

    const instruction = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : defaultInstruction;
    const prompt = `${instruction}\n\nTweets:\n${textPayload}`;

    // ── Primary: Gemini ────────────────────────────────────────────────────────
    const geminiKeyList = geminiApiKeys
        ? geminiApiKeys.split(',').map(k => k.trim()).filter(Boolean)
        : [];

    if (geminiKeyList.length === 0) {
        console.warn("[LLM] No Gemini keys configured. Trying HuggingFace fallback.");
    }

    for (let i = 0; i < geminiKeyList.length; i++) {
        const key = geminiKeyList[i];
        const keyLabel = geminiKeyList.length > 1 ? ` (key ${i + 1}/${geminiKeyList.length})` : '';
        try {
            console.log(`[LLM] Trying Gemini${keyLabel}...`);
            const res = await fetchWithTimeout(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { maxOutputTokens: 1500 }
                    })
                },
                GEMINI_TIMEOUT_MS
            );

            if (!res.ok) {
                const errBody = await res.text();
                throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
            }

            const data = await res.json();
            const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!raw) throw new Error("Empty response from Gemini.");

            console.log(`[LLM] Summary generated via Gemini${keyLabel}.`);
            const attribution = `<div style="margin-top:12px;font-size:11px;color:#9ca3af;font-style:italic;text-align:right;">— Gemini 2.0 Flash${keyLabel}</div>`;
            return markdownToEmailHtml(raw.trim()) + attribution;

        } catch (err) {
            const reason = err.name === 'AbortError' ? `timed out after ${GEMINI_TIMEOUT_MS / 1000}s` : err.message;
            console.warn(`[LLM] Gemini key ${i + 1} failed: ${reason}`);
        }
    }

    if (geminiKeyList.length > 0) {
        console.warn(`[LLM] All Gemini keys exhausted. Falling back to HuggingFace.`);
    }

    // ── Fallback: Hugging Face ─────────────────────────────────────────────────
    if (!hfApiKey) {
        const msg = "No AI API keys configured. Please add a Gemini or Hugging Face key in Settings.";
        console.error("[LLM] " + msg);
        return `<em style="color:#dc2626;">⚠️ ${msg}</em>`;
    }

    try {
        console.log("[LLM] Trying HuggingFace fallback...");
        const res = await fetchWithTimeout(
            "https://router.huggingface.co/v1/chat/completions",
            {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${hfApiKey}` },
                body: JSON.stringify({
                    model: "Qwen/Qwen2.5-72B-Instruct",
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: 1200
                })
            },
            HF_TIMEOUT_MS
        );

        if (!res.ok) throw new Error(`HTTP ${res.status} — check your HuggingFace token.`);

        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content;
        if (!raw) throw new Error("HuggingFace returned an empty response.");

        console.log("[LLM] Summary generated via HuggingFace (fallback).");
        const attribution = `<div style="margin-top:12px;font-size:11px;color:#9ca3af;font-style:italic;text-align:right;">— Qwen2.5-72B (HuggingFace fallback)</div>`;
        return markdownToEmailHtml(raw.trim()) + attribution;

    } catch (err) {
        const reason = err.name === 'AbortError' ? `timed out after ${HF_TIMEOUT_MS / 1000}s` : err.message;
        console.error("[LLM] HuggingFace failed:", reason);
        return `<em style="color:#dc2626;">⚠️ Summary error: ${reason}</em>`;
    }
}

// Export for Node.js Testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { summarizeTweets, markdownToEmailHtml };
}

/**
 * LLM API Integration for Summarization
 * Primary: Google Gemini (Gemini 2.5 Flash) — supports multiple comma-separated keys tried in order
 * Fallback: Hugging Face (Qwen/Qwen2.5-72B-Instruct)
 */

const GEMINI_TIMEOUT_MS = 30_000;
const HF_TIMEOUT_MS = 45_000;

/**
 * Wraps fetch() in a Promise.race timeout.
 * AbortController is unreliable in Chrome MV3 service workers — the abort
 * signal sometimes isn't propagated, leaving fetch() hanging until Chrome
 * kills the entire service worker. Promise.race is pure JS and always fires.
 */
function fetchWithTimeout(url, options, ms) {
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`TIMEOUT_${ms}`)), ms)
    );
    return Promise.race([fetch(url, options), timeoutPromise]);
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
       class="em-section-block"
       style="width:100%;margin:12px 0 0 0;border-radius:8px;overflow:hidden;
              border:1px solid ${style.border};">
  <tr>
    <td style="background:${style.bg};padding:10px 14px 4px 14px;">
      <div class="em-section-title" style="font-size:12px;font-weight:800;color:${style.title};
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
                out.push(`<li class="em-section-text" style="font-size:13.5px;color:#1c1917;line-height:1.7;margin-bottom:3px;">${item}</li>`);
                continue;
            }

            if (inUl) { out.push('</ul>'); inUl = false; }

            if (line.trim() === '') {
                out.push('<div style="height:4px;"></div>');
                continue;
            }

            // Lines that look like "**Label:** text" — highlight the label
            // (already converted to <strong> above)
            out.push(`<div class="em-section-text" style="font-size:13.5px;color:#1c1917;line-height:1.75;margin-bottom:3px;">${line}</div>`);
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
async function summarizeTweets(tweets, geminiApiKeys, hfApiKey, customPrompt, enableFactCheck = true, enableGlossary = true, summaryMode = 'minimal') {
    if (!tweets || tweets.length === 0) return "No updates in the last 24 hours.";

    const textPayload = tweets.map((t, idx) => {
        const dateStr = new Date(t.timestamp).toLocaleString();
        const retweetInfo = t.isRetweet ? `\nReposted From: ${t.authorName} (${t.authorHandle})` : '';
        const subInfo = t.isSubscriberOnly ? `\n[SUBSCRIBER EXCLUSIVE POST]` : '';
        return `Tweet ${idx + 1}:${subInfo}\nDate: ${dateStr}${retweetInfo}\nText: ${t.text}\nQuoted: ${t.quotedText || ''}\nURL: ${t.url}`;
    }).join("\n\n");

    let sectionsInstruction = ``;
    if (enableFactCheck) {
        sectionsInstruction += `\n\n## 🚨 Fact-Check & Misinformation Report\nCheck for false, misleading, or unverified claims. For each issue found, write three lines:\n- **Claim:** [the specific claim]\n- **Issue:** [why it is misleading or wrong]\n- **Fact:** [the verified reality]\nIf nothing problematic is found, write: No obvious misinformation detected.`;
    }

    if (enableGlossary) {
        sectionsInstruction += `\n\n## 📖 Glossary of Terms\nList any jargon, acronyms, or niche terms using "- **Term:** definition" format.\nIf no complex terms appear, write: No lesser-known terms detected.`;
    }

    const minimalInstruction = `You are an expert analyst. Summarize the following tweets into a concise, scannable digest.

Start with a single bold sentence giving the big-picture overview.
Then write exactly these sections using these headers:

## 📝 Minimal Summary
Synthesize the tweets into 4–6 concise bullet points (use "- " prefix). Be factual and direct. No fluff.${sectionsInstruction}`;

    const normalInstruction = `You are an expert analyst. Summarize the following tweets into a comprehensive, detailed digest.

Start with a single bold sentence giving the big-picture overview.
Then write exactly this section:

## 📝 Full Summary
Provide a detailed bulleted summary (use "- " prefix) that synthesizes all the tweets together. Group related updates, narratives, or events into cohesive points. Be thorough—capture specific details, names, and figures. There is no limit on the number of bullets, but focus on the collective story told by the tweets.${sectionsInstruction}`;

    const defaultInstruction = summaryMode === 'normal' ? normalInstruction : minimalInstruction;

    let instruction = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : defaultInstruction;

    if (customPrompt && customPrompt.trim()) {
        instruction += sectionsInstruction;
    }

    const prompt = `${instruction}\n\nTweets:\n${textPayload}`;

    // ── Primary: Gemini (multi-model fallback) ─────────────────────────────────
    // Models ordered by preference: newest/fastest first, older stable as fallback.
    // When a model returns 503 (overloaded) or 429 (rate-limited), we try the
    // next model before moving to the next API key.
    const GEMINI_MODELS = [
        { id: 'gemini-2.5-flash',        displayName: 'Gemini 2.5 Flash' },
        { id: 'gemini-2.5-flash-lite',   displayName: 'Gemini 2.5 Flash-Lite' },
        { id: 'gemini-2.5-pro',          displayName: 'Gemini 2.5 Pro' },
        { id: 'gemini-3-flash-preview',  displayName: 'Gemini 3 Flash Preview' },
    ];

    const geminiKeyList = geminiApiKeys
        ? geminiApiKeys.split(',').map(k => k.trim()).filter(Boolean)
        : [];

    if (geminiKeyList.length === 0) {
        console.warn("[LLM] No Gemini keys configured. Trying HuggingFace fallback.");
    }

    const geminiErrors = [];

    // Distribute load by rotating the starting key. We pick a random offset
    // so different profiles/categories don't always hammer the first key.
    if (geminiKeyList.length > 1) {
        const offset = Math.floor(Math.random() * geminiKeyList.length);
        const rotatedKeys = geminiKeyList.slice(offset).concat(geminiKeyList.slice(0, offset));
        geminiKeyList.length = 0;
        geminiKeyList.push(...rotatedKeys);
    }

    // Helper: checks if an error is a "model busy" error worth trying next model
    const isModelBusy = (errMsg) => {
        const lower = errMsg.toLowerCase();
        return lower.includes('503') || lower.includes('429') ||
               lower.includes('overloaded') || lower.includes('high demand') ||
               lower.includes('resource exhausted') || lower.includes('quota');
    };

    for (let i = 0; i < geminiKeyList.length; i++) {
        const key = geminiKeyList[i];
        const keyLabel = geminiKeyList.length > 1 ? ` (key ${i + 1}/${geminiKeyList.length})` : '';
        const keyModelErrors = [];

        for (let m = 0; m < GEMINI_MODELS.length; m++) {
            const model = GEMINI_MODELS[m];
            const label = `${model.displayName}${keyLabel}`;
            try {
                console.log(`[LLM] Trying ${label}...`);
                const res = await fetchWithTimeout(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${key}`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: { maxOutputTokens: 3000 }
                        })
                    },
                    GEMINI_TIMEOUT_MS
                );

                if (!res.ok) {
                    const errBody = await res.text();
                    const errMsg = `HTTP ${res.status}: ${errBody.slice(0, 200)}`;

                    // If the model is busy/overloaded, try the next model with same key
                    if (isModelBusy(errMsg) && m < GEMINI_MODELS.length - 1) {
                        console.warn(`[LLM] ${label} is busy (${res.status}). Trying next model...`);
                        keyModelErrors.push(`${model.id}: ${res.status} busy`);
                        continue; // try next model
                    }
                    throw new Error(errMsg);
                }

                const data = await res.json();
                const candidate = data?.candidates?.[0];
                const raw = candidate?.content?.parts?.[0]?.text;
                if (!raw) throw new Error("Empty response from Gemini.");

                // Detect truncated responses
                const finishReason = candidate?.finishReason;
                if (finishReason === 'MAX_TOKENS') {
                    console.warn(`[LLM] ${label} ⚠️ Response was TRUNCATED (finishReason: MAX_TOKENS).`);
                } else {
                    console.log(`[LLM] Summary generated via ${label} (finishReason: ${finishReason}).`);
                }

                const truncationNote = finishReason === 'MAX_TOKENS'
                    ? `<div style="margin-top:8px;font-size:11px;color:#f97316;font-style:italic;text-align:right;">⚠️ Summary may be incomplete (token limit reached)</div>`
                    : '';
                const attribution = `<div style="margin-top:12px;font-size:11px;color:#9ca3af;font-style:italic;text-align:right;">— ${model.displayName}${keyLabel}</div>`;
                return markdownToEmailHtml(raw.trim()) + truncationNote + attribution;

            } catch (err) {
                const isTimeout = err.message && err.message.startsWith('TIMEOUT_');
                const reason = isTimeout ? `timed out after ${GEMINI_TIMEOUT_MS / 1000}s` : err.message;
                const shortReason = reason.length > 150 ? reason.slice(0, 150) + '...' : reason;
                console.warn(`[LLM] ${label} failed: ${shortReason}`);

                // If this model is busy and there are more models, continue to next model
                if (isModelBusy(shortReason) && m < GEMINI_MODELS.length - 1) {
                    keyModelErrors.push(`${model.id}: ${shortReason}`);
                    continue;
                }

                // Non-busy error (auth, network, etc.) — skip remaining models for this key
                keyModelErrors.push(`${model.id}: ${shortReason}`);
                break;
            }
        }

        // All models failed for this key
        geminiErrors.push(`Key ${i + 1}: ${keyModelErrors.join(' → ')}`);
    }

    if (geminiKeyList.length > 0) {
        console.warn(`[LLM] All Gemini keys and models exhausted. Falling back to HuggingFace.`);
    }

    // ── Fallback: Hugging Face ─────────────────────────────────────────────────
    if (!hfApiKey) {
        let msg = "No AI API keys configured.";
        if (geminiErrors.length > 0) {
            msg = `All Gemini keys failed: ${geminiErrors.join(' | ')}. No HuggingFace fallback key set.`;
        } else if (geminiKeyList.length > 0) {
            msg = `No valid Gemini key provided. No HuggingFace fallback key set.`;
        }
        console.error("[LLM] " + msg);
        throw new Error(msg);
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
        const isTimeout = err.message && err.message.startsWith('TIMEOUT_');
        const reason = isTimeout ? `timed out after ${HF_TIMEOUT_MS / 1000}s` : err.message;
        const shortReason = reason.length > 150 ? reason.slice(0, 150) + '...' : reason;
        console.error("[LLM] HuggingFace failed:", shortReason);

        let finalErrorMsg = `HuggingFace failed (${shortReason}).`;
        if (geminiErrors.length > 0) {
            finalErrorMsg += ` Gemini also failed: ${geminiErrors.join(' | ')}`;
        }
        throw new Error(finalErrorMsg);
    }
}

// Export for Node.js Testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { summarizeTweets, markdownToEmailHtml };
}

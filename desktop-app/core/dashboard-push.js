/**
 * dashboard-push.js — Sends structured update payloads to the GAS webhook.
 *
 * Handles both digest pushes (from orchestrator) and project update pushes
 * (from the CLI script). Uses a plain fetch() to POST JSON to the GAS doPost().
 */

const logger = require('./logger');

const PUSH_TIMEOUT_MS = 15_000;

/**
 * Push a digest run to the GAS dashboard.
 * @param {string} webhookUrl  - The GAS Web App URL from settings.dashboardUrl
 * @param {object} payload     - { runId, category, timestamp, briefSummary,
 *                                 deepSummaryHtml, glossary[], profiles[], tweets[] }
 */
async function pushDigestUpdate(webhookUrl, payload) {
    if (!webhookUrl) {
        logger.add('[Dashboard] No dashboard URL configured — skipping push.', 'warn');
        return;
    }
    try {
        const body = JSON.stringify({ type: 'digest', ...payload });
        const res  = await _fetchWithTimeout(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        }, PUSH_TIMEOUT_MS);

        const data = await res.json();
        if (data.skipped) {
            logger.add(`[Dashboard] Skipped push for [${payload.category}] — already exists.`, 'info');
        } else if (data.ok) {
            logger.add(`[Dashboard] ✅ Pushed [${payload.category}] to dashboard.`, 'info');
        } else {
            logger.add(`[Dashboard] ⚠️ Push returned: ${JSON.stringify(data)}`, 'warn');
        }
    } catch (err) {
        logger.add(`[Dashboard] ❌ Push failed for [${payload.category}]: ${err.message}`, 'error');
    }
}

/**
 * Push a project update to the GAS dashboard.
 * @param {string} webhookUrl
 * @param {object} payload - { updateId, version, title, summary, changes[], tags[] }
 */
async function pushProjectUpdate(webhookUrl, payload) {
    if (!webhookUrl) throw new Error('No dashboard URL configured.');
    const res  = await _fetchWithTimeout(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'project_update', timestamp: Date.now(), ...payload })
    }, PUSH_TIMEOUT_MS);
    return res.json();
}

function _fetchWithTimeout(url, options, ms) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Dashboard push timed out after ${ms}ms`)), ms)
    );
    return Promise.race([fetch(url, options), timeout]);
}

/**
 * Fetch all processed tweet IDs from the GAS dashboard.
 * @param {string} webhookUrl - The GAS Web App URL
 * @returns {Promise<string[]>} Array of tweet IDs
 */
async function fetchProcessedTweetIds(webhookUrl) {
    if (!webhookUrl) return [];
    try {
        const res = await _fetchWithTimeout(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'get_processed_ids' })
        }, PUSH_TIMEOUT_MS);
        
        const data = await res.json();
        if (data.ok && Array.isArray(data.ids)) {
            return data.ids;
        }
    } catch (err) {
        logger.add(`[Dashboard] ⚠️ Failed to fetch processed IDs: ${err.message}`, 'warn');
    }
    return [];
}

module.exports = { pushDigestUpdate, pushProjectUpdate, fetchProcessedTweetIds };

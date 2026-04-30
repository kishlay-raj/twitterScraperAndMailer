/**
 * Renderer Process — DailyUpdates Desktop UI
 *
 * Replaces popup.js. All chrome.* calls are replaced with window.api.*
 * which is exposed securely via preload.js using contextBridge.
 *
 * Responsibilities:
 * - Load and save settings
 * - Render categories (profiles, toggles, per-category controls)
 * - Real-time log display (streamed via window.api.onLog)
 * - Run Now / Run Category buttons
 * - Import / Export config
 */

// ─── State ───────────────────────────────────────────────────────────────────

let categories = [];
let settings = {};
let allLogs = [];

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    [settings, categories, allLogs] = await Promise.all([
        window.api.getSettings(),
        window.api.getCategories(),
        window.api.getLogs(),
    ]);

    loadSettingsIntoUI(settings);
    renderCategories();
    renderLogs(allLogs);
    bindEventListeners();

    // Real-time log streaming from main process
    window.api.onLog((entry) => {
        allLogs.push(entry);
        appendLogEntry(entry);
    });
}

// ─── Settings ────────────────────────────────────────────────────────────────

function loadSettingsIntoUI(s) {
    document.getElementById('gemini-api-key').value = s.geminiApiKey || '';
    document.getElementById('llm-api-key').value = s.llmApiKey || '';
    document.getElementById('email-api-key').value = s.emailApiKey || '';
    document.getElementById('recipient-email').value = s.recipientEmail || '';
    document.getElementById('scrape-duration').value = s.scrapeDuration || 24;
    document.getElementById('scrape-duration-unit').value = s.scrapeDurationUnit || 'hours';
    document.getElementById('allow-duplicates').checked = !!s.allowDuplicates;
    document.getElementById('enable-schedule').checked = !!s.enableSchedule;
    document.getElementById('schedule-time').value = s.scheduleTime || '';
}

function collectSettingsFromUI() {
    return {
        geminiApiKey: document.getElementById('gemini-api-key').value.trim(),
        llmApiKey: document.getElementById('llm-api-key').value.trim(),
        emailApiKey: document.getElementById('email-api-key').value.trim(),
        recipientEmail: document.getElementById('recipient-email').value.trim(),
        scrapeDuration: parseInt(document.getElementById('scrape-duration').value) || 24,
        scrapeDurationUnit: document.getElementById('scrape-duration-unit').value,
        allowDuplicates: document.getElementById('allow-duplicates').checked,
        enableSchedule: document.getElementById('enable-schedule').checked,
        scheduleTime: document.getElementById('schedule-time').value,
    };
}

// ─── Category Rendering ───────────────────────────────────────────────────────

function renderCategories() {
    const container = document.getElementById('categories-container');
    container.innerHTML = '';
    categories.forEach((cat, i) => {
        container.appendChild(buildCategoryEl(cat, i));
    });
}

function buildCategoryEl(cat, idx) {
    const section = document.createElement('section');
    section.className = 'section category-section';
    section.dataset.idx = idx;

    const activeClass = cat.isActive !== false ? 'active' : 'inactive';

    section.innerHTML = `
    <div class="category-header">
      <div style="display:flex; align-items:center; gap:10px;">
        <input type="checkbox" class="cat-active-toggle" ${cat.isActive !== false ? 'checked' : ''} title="Enable/disable category">
        <h2 class="category-title" style="margin:0;">${escapeHtml(cat.name)}</h2>
        <span class="category-status-badge ${activeClass}">${cat.isActive !== false ? 'Active' : 'Disabled'}</span>
      </div>
      <div style="display:flex; gap:6px;">
        <button class="run-category-btn utility-btn" title="Run this category now">▶ Run</button>
        <button class="toggle-category-btn utility-btn">${cat._collapsed ? '▼ Show' : '▲ Hide'}</button>
        <button class="delete-category-btn utility-btn" style="color:#ef4444;">✕ Delete</button>
      </div>
    </div>

    <div class="category-body" ${cat._collapsed ? 'style="display:none;"' : ''}>

      <!-- Category-level settings -->
      <div class="category-settings-row">
        <label class="toggle-label">
          <input type="checkbox" class="cat-enable-summary" ${cat.enableCategorySummary ? 'checked' : ''}>
          Category AI Summary
        </label>
        <select class="cat-summary-mode" ${!cat.enableCategorySummary ? 'disabled' : ''}>
          <option value="minimal" ${(cat.categorySummaryMode || 'minimal') === 'minimal' ? 'selected' : ''}>Minimal</option>
          <option value="normal" ${cat.categorySummaryMode === 'normal' ? 'selected' : ''}>Normal</option>
          <option value="detailed" ${cat.categorySummaryMode === 'detailed' ? 'selected' : ''}>Detailed</option>
        </select>
        <label class="toggle-label">
          <input type="checkbox" class="cat-fact-check" ${cat.enableFactCheck !== false ? 'checked' : ''}>
          Fact Check
        </label>
        <label class="toggle-label">
          <input type="checkbox" class="cat-glossary" ${cat.enableGlossary !== false ? 'checked' : ''}>
          Glossary
        </label>
      </div>

      <div class="input-group" style="margin-bottom:10px;">
        <label>Extra Recipients (comma-separated):</label>
        <input type="text" class="cat-extra-emails" value="${escapeHtml(cat.extraEmails || '')}" placeholder="extra@email.com">
      </div>

      <div class="input-group" style="margin-bottom:14px;">
        <label>Custom Summary Prompt (optional):</label>
        <textarea class="cat-summary-prompt" rows="3" placeholder="Leave blank to use the default prompt.">${escapeHtml(cat.summaryPrompt || '')}</textarea>
      </div>

      <!-- Profile list -->
      <div class="profiles-list">
        ${(cat.profiles || []).map((p, pi) => buildProfileHtml(p, pi)).join('')}
      </div>

      <!-- Add profile form -->
      <div class="add-profile-row">
        <input type="url" class="new-profile-url" placeholder="https://x.com/username">
        <button class="add-profile-btn">+ Add Profile</button>
      </div>

      <div style="margin-top:10px; text-align:right;">
        <button class="save-category-btn primary-btn" style="font-size:0.85rem; padding:7px 16px;">💾 Save Category</button>
      </div>
    </div>
  `;

    // ── Event listeners ──────────────────────────────────────────────────────

    section.querySelector('.cat-active-toggle').addEventListener('change', (e) => {
        categories[idx].isActive = e.target.checked;
        section.querySelector('.category-status-badge').textContent = e.target.checked ? 'Active' : 'Disabled';
        section.querySelector('.category-status-badge').className = `category-status-badge ${e.target.checked ? 'active' : 'inactive'}`;
        saveCategories();
    });

    section.querySelector('.toggle-category-btn').addEventListener('click', () => {
        categories[idx]._collapsed = !categories[idx]._collapsed;
        const body = section.querySelector('.category-body');
        const btn = section.querySelector('.toggle-category-btn');
        body.style.display = categories[idx]._collapsed ? 'none' : '';
        btn.textContent = categories[idx]._collapsed ? '▼ Show' : '▲ Hide';
        saveCategories();
    });

    section.querySelector('.delete-category-btn').addEventListener('click', () => {
        if (confirm(`Delete category "${cat.name}"?`)) {
            categories.splice(idx, 1);
            saveCategories();
            renderCategories();
        }
    });

    section.querySelector('.run-category-btn').addEventListener('click', async () => {
        showStatus('run-status-message', `▶ Running [${cat.name}]...`, 'info');
        await window.api.runCategory(idx);
    });

    section.querySelector('.cat-enable-summary').addEventListener('change', (e) => {
        section.querySelector('.cat-summary-mode').disabled = !e.target.checked;
    });

    section.querySelector('.add-profile-btn').addEventListener('click', () => {
        const input = section.querySelector('.new-profile-url');
        const url = input.value.trim();
        if (!url || !url.startsWith('https://x.com/')) {
            alert('Please enter a valid X profile URL (https://x.com/username)');
            return;
        }
        if (!categories[idx].profiles) categories[idx].profiles = [];
        categories[idx].profiles.push({
            url, isActive: true, enableAiSummary: false,
            scrapeRetweets: true, scrapeReplies: false
        });
        input.value = '';
        section.querySelector('.profiles-list').innerHTML =
            categories[idx].profiles.map((p, pi) => buildProfileHtml(p, pi)).join('');
        bindProfileListeners(section, idx);
        saveCategories();
    });

    section.querySelector('.save-category-btn').addEventListener('click', () => {
        categories[idx] = {
            ...categories[idx],
            enableCategorySummary: section.querySelector('.cat-enable-summary').checked,
            categorySummaryMode: section.querySelector('.cat-summary-mode').value,
            enableFactCheck: section.querySelector('.cat-fact-check').checked,
            enableGlossary: section.querySelector('.cat-glossary').checked,
            extraEmails: section.querySelector('.cat-extra-emails').value.trim(),
            summaryPrompt: section.querySelector('.cat-summary-prompt').value.trim(),
        };
        saveCategories();
        showStatus('status-message', `✅ Category "${cat.name}" saved.`, 'success');
    });

    bindProfileListeners(section, idx);
    return section;
}

function buildProfileHtml(profile, pi) {
    return `
    <div class="profile-row" data-pi="${pi}">
      <input type="checkbox" class="profile-active-toggle" ${profile.isActive !== false ? 'checked' : ''} title="Enable/disable profile">
      <span class="profile-url">${escapeHtml(profile.url)}</span>
      <label class="toggle-label" title="Per-profile AI summary">
        <input type="checkbox" class="profile-ai-toggle" ${profile.enableAiSummary ? 'checked' : ''}> AI
      </label>
      <label class="toggle-label" title="Include retweets">
        <input type="checkbox" class="profile-rt-toggle" ${profile.scrapeRetweets !== false ? 'checked' : ''}> RT
      </label>
      <label class="toggle-label" title="Scrape replies tab">
        <input type="checkbox" class="profile-replies-toggle" ${profile.scrapeReplies ? 'checked' : ''}> Replies
      </label>
      <button class="delete-profile-btn utility-btn" style="color:#ef4444; padding:3px 8px;">✕</button>
    </div>`;
}

function bindProfileListeners(section, catIdx) {
    section.querySelectorAll('.profile-row').forEach((row) => {
        const pi = parseInt(row.dataset.pi);
        if (isNaN(pi)) return;

        row.querySelector('.profile-active-toggle').addEventListener('change', (e) => {
            categories[catIdx].profiles[pi].isActive = e.target.checked;
            saveCategories();
        });
        row.querySelector('.profile-ai-toggle').addEventListener('change', (e) => {
            categories[catIdx].profiles[pi].enableAiSummary = e.target.checked;
            saveCategories();
        });
        row.querySelector('.profile-rt-toggle').addEventListener('change', (e) => {
            categories[catIdx].profiles[pi].scrapeRetweets = e.target.checked;
            saveCategories();
        });
        row.querySelector('.profile-replies-toggle').addEventListener('change', (e) => {
            categories[catIdx].profiles[pi].scrapeReplies = e.target.checked;
            saveCategories();
        });
        row.querySelector('.delete-profile-btn').addEventListener('click', () => {
            categories[catIdx].profiles.splice(pi, 1);
            section.querySelector('.profiles-list').innerHTML =
                categories[catIdx].profiles.map((p, i) => buildProfileHtml(p, i)).join('');
            bindProfileListeners(section, catIdx);
            saveCategories();
        });
    });
}

// ─── Logs ────────────────────────────────────────────────────────────────────

function renderLogs(logs) {
    const container = document.getElementById('logs-container');
    const filter = document.getElementById('logs-time-filter').value;
    const filtered = filterLogs(logs, filter);

    if (filtered.length === 0) {
        container.innerHTML = '<div class="log-entry">No logs yet.</div>';
        return;
    }

    container.innerHTML = filtered.slice().reverse().map(formatLogEntry).join('');
}

function appendLogEntry(entry) {
    const filter = document.getElementById('logs-time-filter').value;
    const filtered = filterLogs([entry], filter);
    if (filtered.length === 0) return;

    const container = document.getElementById('logs-container');
    if (container.querySelector('.log-entry')?.textContent === 'No logs yet.') {
        container.innerHTML = '';
    }
    container.insertAdjacentHTML('afterbegin', formatLogEntry(entry));
}

function formatLogEntry(log) {
    const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const date = new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const levelClass = log.level === 'error' ? 'log-error' : log.level === 'warn' ? 'log-warn' : '';
    return `<div class="log-entry ${levelClass}">
      <span class="log-timestamp">[${date} ${time}]</span>
      <span class="log-message">${escapeHtml(log.message)}</span>
    </div>`;
}

function filterLogs(logs, filter) {
    if (filter === 'all') return logs;
    const now = Date.now();
    const cutoff = {
        '1h': now - 60 * 60 * 1000,
        '6h': now - 6 * 60 * 60 * 1000,
        '24h': now - 24 * 60 * 60 * 1000,
    }[filter];
    if (cutoff) return logs.filter(l => l.timestamp >= cutoff);
    if (filter === 'custom') {
        const from = new Date(document.getElementById('logs-range-from').value).getTime();
        const to = new Date(document.getElementById('logs-range-to').value).getTime();
        return logs.filter(l => (!from || l.timestamp >= from) && (!to || l.timestamp <= to));
    }
    return logs;
}

// ─── Persistence Helpers ─────────────────────────────────────────────────────

async function saveCategories() {
    await window.api.saveCategories(categories);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

function bindEventListeners() {
    // Run Now
    document.getElementById('run-now-btn').addEventListener('click', async () => {
        showStatus('run-status-message', '🚀 Run started! Check logs for progress.', 'info');
        await window.api.runNow();
    });

    // Save Settings
    document.getElementById('save-settings-btn').addEventListener('click', async () => {
        settings = collectSettingsFromUI();
        await window.api.saveSettings(settings);
        showStatus('status-message', '✅ Settings saved.', 'success');
    });

    // Add Category
    document.getElementById('add-category-btn').addEventListener('click', () => {
        const nameInput = document.getElementById('new-category-name');
        const name = nameInput.value.trim();
        if (!name) return;
        categories.push({
            name, isActive: true, profiles: [],
            enableCategorySummary: false, categorySummaryMode: 'minimal',
            enableFactCheck: true, enableGlossary: true,
            extraEmails: '', summaryPrompt: ''
        });
        nameInput.value = '';
        saveCategories();
        renderCategories();
    });

    // Enter key on category name
    document.getElementById('new-category-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('add-category-btn').click();
    });

    // Logs filter
    document.getElementById('logs-time-filter').addEventListener('change', (e) => {
        const customRange = document.getElementById('logs-custom-range');
        customRange.style.display = e.target.value === 'custom' ? 'flex' : 'none';
        renderLogs(allLogs);
    });

    document.getElementById('logs-range-from').addEventListener('change', () => renderLogs(allLogs));
    document.getElementById('logs-range-to').addEventListener('change', () => renderLogs(allLogs));

    // Copy logs
    document.getElementById('copy-logs-btn').addEventListener('click', () => {
        const text = allLogs.slice().reverse().map(l =>
            `[${new Date(l.timestamp).toLocaleString()}] [${l.level.toUpperCase()}] ${l.message}`
        ).join('\n');
        navigator.clipboard.writeText(text);
        showStatus('status-message', '📋 Logs copied to clipboard.', 'success');
    });

    // Clear logs
    document.getElementById('clear-logs-btn').addEventListener('click', async () => {
        await window.api.clearLogs();
        allLogs = [];
        renderLogs([]);
    });

    // Export
    document.getElementById('export-btn').addEventListener('click', async () => {
        const result = await window.api.exportConfig();
        if (result.success) showStatus('status-message', `✅ Config exported to ${result.filePath}`, 'success');
    });

    // Import
    document.getElementById('import-btn').addEventListener('click', async () => {
        const result = await window.api.importConfig();
        if (result.success) {
            settings = result.data.settings || {};
            categories = result.data.categories || [];
            loadSettingsIntoUI(settings);
            renderCategories();
            showStatus('status-message', '✅ Config imported successfully.', 'success');
        }
    });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function showStatus(elementId, message, type = 'info') {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.style.color = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#4f46e5';
    el.style.marginTop = '8px';
    el.style.fontSize = '0.85rem';
    setTimeout(() => { el.textContent = ''; }, 4000);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

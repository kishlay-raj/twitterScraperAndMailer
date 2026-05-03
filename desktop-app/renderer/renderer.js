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

    // ── Login Required modal ─────────────────────────────────────────────────
    const loginModal = document.getElementById('login-modal');
    const dismissBtn = document.getElementById('login-modal-dismiss');

    // Show the modal when the backend detects no active session
    window.api.onLoginRequired(() => {
        loginModal.style.display = 'flex';
    });

    // Dismiss button closes the modal so the user can go log in
    dismissBtn.addEventListener('click', () => {
        loginModal.style.display = 'none';
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
    document.getElementById('headless-mode').checked = s.headlessMode !== false; // default true
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
        headlessMode: document.getElementById('headless-mode').checked,
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

    // Default to collapsed (isExpanded must be explicitly true to show)
    const isExpanded = cat.isExpanded === true;
    const activeClass = cat.isActive !== false ? 'active' : 'inactive';

    section.innerHTML = `
    <div class="category-header" style="cursor:pointer;" title="Click to expand / collapse">
      <div style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
        <span class="collapse-icon" style="font-size:0.6rem; color:#94a3b8; flex-shrink:0;">${isExpanded ? '▼' : '▶'}</span>
        <input type="checkbox" class="cat-active-toggle" ${cat.isActive !== false ? 'checked' : ''}
               title="Enable/disable category" onclick="event.stopPropagation()">
        <h2 class="category-title" style="margin:0; flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(cat.name)}</h2>
        <span class="category-status-badge ${activeClass}">${cat.isActive !== false ? 'Active' : 'Disabled'}</span>
      </div>
      <div style="display:flex; gap:6px; flex-shrink:0;" onclick="event.stopPropagation()">
        <button class="run-category-btn utility-btn" title="Run this category now">▶ Run</button>
        <button class="delete-category-btn utility-btn" style="color:#ef4444;">✕ Delete</button>
      </div>
    </div>

    <div class="category-body" ${!isExpanded ? 'style="display:none;"' : ''}>

      <!-- Category-level settings -->
      <div class="category-settings-row">
        <!-- A: Click-to-cycle summary mode pill (Off → Minimal → Normal → Off) -->
        <button
          class="cat-badge cat-badge-summarise cat-badge-mode-${cat.categorySummaryMode || 'off'} ${(cat.categorySummaryMode && cat.categorySummaryMode !== 'off') ? 'is-on' : ''}"
          data-mode="${cat.categorySummaryMode || 'off'}"
          title="Click to cycle: Off → Minimal → Normal"
        >${{ off: '✨ Summarise: Off', minimal: '✨ Minimal', normal: '📋 Normal' }[cat.categorySummaryMode || 'off']}</button>
        <label class="toggle-label">
          <input type="checkbox" class="cat-fact-check" ${cat.enableFactCheck !== false ? 'checked' : ''}>
          Fact Check
        </label>
        <label class="toggle-label">
          <input type="checkbox" class="cat-glossary" ${cat.enableGlossary !== false ? 'checked' : ''}>
          Glossary
        </label>
      </div>

      <!-- B: Extra emails with enable/disable toggle -->
      <div class="extra-emails-group">
        <label class="extra-emails-label">
          <input type="checkbox" class="cat-extra-emails-toggle" ${cat.enableExtraEmails !== false ? 'checked' : ''}>
          📧 Extra Recipients for this category:
        </label>
        <input
          type="text"
          class="cat-extra-emails"
          value="${escapeHtml(cat.extraEmails || '')}"
          placeholder="extra@example.com, another@example.com"
          ${cat.enableExtraEmails === false ? 'disabled' : ''}
        >
      </div>

      <!-- C: Summary prompt — auto-saves on blur, no Save button needed -->
      <div class="summary-prompt-group">
        <label class="summary-prompt-label">✏️ Custom Summary Prompt <span style="font-weight:400; color:#94a3b8;">(optional — overrides default)</span></label>
        <textarea
          class="cat-summary-prompt"
          rows="3"
          placeholder="E.g. Summarise these tweets focusing on product announcements…">${escapeHtml(cat.summaryPrompt || '')}</textarea>
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
    </div>
  `;

    // ── Collapse: click anywhere on the header row ────────────────────────────
    section.querySelector('.category-header').addEventListener('click', (e) => {
        // Don't collapse if clicking interactive elements inside the header
        if (e.target.closest('button') || e.target.closest('input')) return;

        const nowExpanded = !(categories[idx].isExpanded === true);
        categories[idx].isExpanded = nowExpanded;

        const body = section.querySelector('.category-body');
        const icon = section.querySelector('.collapse-icon');
        body.style.display = nowExpanded ? '' : 'none';
        icon.textContent = nowExpanded ? '▼' : '▶';

        saveCategories();
    });

    // ── Active toggle ────────────────────────────────────────────────────────
    section.querySelector('.cat-active-toggle').addEventListener('change', (e) => {
        categories[idx].isActive = e.target.checked;
        section.querySelector('.category-status-badge').textContent = e.target.checked ? 'Active' : 'Disabled';
        section.querySelector('.category-status-badge').className = `category-status-badge ${e.target.checked ? 'active' : 'inactive'}`;
        saveCategories();
    });

    // ── Delete category ──────────────────────────────────────────────────────
    section.querySelector('.delete-category-btn').addEventListener('click', () => {
        if (confirm(`Delete category "${cat.name}"?`)) {
            categories.splice(idx, 1);
            saveCategories();
            renderCategories();
        }
    });

    // ── Run category ─────────────────────────────────────────────────────────
    section.querySelector('.run-category-btn').addEventListener('click', async () => {
        showStatus('run-status-message', `▶ Running [${cat.name}]...`, 'info');
        await window.api.runCategory(idx);
    });

    // ── A: Summary mode cycle pill ────────────────────────────────────────────
    const SUMMARY_MODES  = ['off', 'minimal', 'normal'];
    const SUMMARY_LABELS = { off: '✨ Summarise: Off', minimal: '✨ Minimal', normal: '📋 Normal' };
    section.querySelector('.cat-badge-summarise').addEventListener('click', () => {
        const current  = categories[idx].categorySummaryMode || 'off';
        const next     = SUMMARY_MODES[(SUMMARY_MODES.indexOf(current) + 1) % SUMMARY_MODES.length];
        categories[idx].categorySummaryMode  = next;
        categories[idx].enableCategorySummary = (next !== 'off');

        const btn = section.querySelector('.cat-badge-summarise');
        btn.textContent = SUMMARY_LABELS[next];
        btn.setAttribute('data-mode', next);
        SUMMARY_MODES.forEach(m => btn.classList.remove(`cat-badge-mode-${m}`));
        btn.classList.add(`cat-badge-mode-${next}`);
        btn.classList.toggle('is-on', next !== 'off');

        saveCategories();
    });

    // ── Fact check / Glossary — immediate save on change ──────────────────────
    section.querySelector('.cat-fact-check').addEventListener('change', (e) => {
        categories[idx].enableFactCheck = e.target.checked;
        saveCategories();
    });
    section.querySelector('.cat-glossary').addEventListener('change', (e) => {
        categories[idx].enableGlossary = e.target.checked;
        saveCategories();
    });

    // ── B: Extra emails toggle + auto-save on blur ────────────────────────────
    section.querySelector('.cat-extra-emails-toggle').addEventListener('change', (e) => {
        categories[idx].enableExtraEmails = e.target.checked;
        section.querySelector('.cat-extra-emails').disabled = !e.target.checked;
        saveCategories();
    });
    section.querySelector('.cat-extra-emails').addEventListener('blur', (e) => {
        categories[idx].extraEmails = e.target.value.trim();
        saveCategories();
    });

    // ── C: Summary prompt — auto-save on blur ────────────────────────────────
    section.querySelector('.cat-summary-prompt').addEventListener('blur', (e) => {
        categories[idx].summaryPrompt = e.target.value.trim();
        saveCategories();
    });

    // ── Add profile (with duplicate check) ───────────────────────────────────
    section.querySelector('.add-profile-btn').addEventListener('click', () => {
        const input = section.querySelector('.new-profile-url');
        const url = input.value.trim();
        if (!url || !url.startsWith('https://x.com/')) {
            alert('Please enter a valid X profile URL (https://x.com/username)');
            return;
        }
        if (!categories[idx].profiles) categories[idx].profiles = [];
        // Duplicate check
        if (categories[idx].profiles.some(p => p.url === url)) {
            alert('This profile is already in the category.');
            return;
        }
        categories[idx].profiles.push({
            url, isActive: true, enableAiSummary: false,
            scrapeRetweets: true, scrapeReplies: false
        });
        input.value = '';
        // Auto-expand so user can see the new profile
        categories[idx].isExpanded = true;
        section.querySelector('.category-body').style.display = '';
        section.querySelector('.collapse-icon').textContent = '▼';
        section.querySelector('.profiles-list').innerHTML =
            categories[idx].profiles.map((p, pi) => buildProfileHtml(p, pi)).join('');
        bindProfileListeners(section, idx);
        saveCategories();
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
    try {
        await window.api.saveCategories(categories);
    } catch (err) {
        console.error('[UI] Failed to save categories:', err);
        showStatus('status-message', '❌ Failed to save — check logs.', 'error');
    }
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
            id: 'cat_' + Date.now(),
            name,
            isActive: true,
            isExpanded: false,   // start collapsed, user clicks to expand
            profiles: [],
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
        let result;
        try {
            result = await window.api.importConfig();
        } catch (err) {
            showStatus('status-message', `❌ Import failed: ${err.message}`, 'error');
            return;
        }

        if (!result) {
            showStatus('status-message', '❌ Import returned no response.', 'error');
            return;
        }

        if (result.cancelled) {
            // User dismissed the file picker — no action needed
            return;
        }

        if (!result.success) {
            showStatus('status-message', `❌ Import failed: ${result.error || 'Unknown error'}`, 'error');
            return;
        }

        // Success — update local state and re-render
        categories = result.data.categories || [];
        renderCategories();

        if (result.settingsImported !== false) {
            // Full desktop-app export: also reload settings fields
            settings = result.data.settings || {};
            loadSettingsIntoUI(settings);
            showStatus('status-message', `✅ Config imported (${categories.length} categories + settings).`, 'success');
        } else {
            // Legacy Chrome extension export: categories only — don't wipe the settings UI
            showStatus('status-message', `✅ Categories imported (${categories.length}). Settings were not in the file — your existing settings are unchanged.`, 'success');
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

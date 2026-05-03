// State Management
let state = {
  categories: [],
  settings: {
    geminiApiKey: '',
    llmApiKey: '',
    emailApiKey: '',
    recipientEmail: '',
    allowDuplicates: false,
    enableSchedule: false,
    scheduleTime: '08:00',
    scrapeDuration: 24,
    scrapeDurationUnit: 'hours'
  }
};

// DOM Elements
const categoriesContainer = document.getElementById('categories-container');
const addCategoryBtn = document.getElementById('add-category-btn');
const newCategoryInput = document.getElementById('new-category-name');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const statusMessage = document.getElementById('status-message');
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');
const importFile = document.getElementById('import-file');
const logsContainer = document.getElementById('logs-container');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const copyLogsBtn = document.getElementById('copy-logs-btn');
const logsTimeFilter = document.getElementById('logs-time-filter');
const logsCustomRange = document.getElementById('logs-custom-range');
const logsRangeFrom = document.getElementById('logs-range-from');
const logsRangeTo = document.getElementById('logs-range-to');
const blockTwitterBtn = document.getElementById('block-twitter-btn');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  renderState();
  renderLogs();
  updateBlockButtonUI();

  // Refresh logs periodically while popup is open
  setInterval(renderLogs, 5000);
});

async function updateBlockButtonUI() {
  chrome.runtime.sendMessage({ action: "get_block_status" }, (response) => {
    if (response) {
      if (response.isBlocked) {
        blockTwitterBtn.textContent = '✅ Unblock X (Twitter)';
        blockTwitterBtn.classList.add('active');
      } else {
        blockTwitterBtn.textContent = '🚫 Block X (Twitter)';
        blockTwitterBtn.classList.remove('active');
      }
    }
  });
}

blockTwitterBtn.addEventListener('click', () => {
  const isCurrentlyBlocked = blockTwitterBtn.classList.contains('active');
  const shouldBlock = !isCurrentlyBlocked;

  chrome.runtime.sendMessage({ action: "toggle_block", block: shouldBlock }, (response) => {
    if (response) updateBlockButtonUI();
  });
});

function getFilteredLogs(logs) {
  const filterVal = logsTimeFilter.value;
  if (filterVal === 'all') return logs;

  const now = Date.now();
  if (filterVal === '1h') return logs.filter(l => now - l.timestamp <= 60 * 60 * 1000);
  if (filterVal === '6h') return logs.filter(l => now - l.timestamp <= 6 * 60 * 60 * 1000);
  if (filterVal === '24h') return logs.filter(l => now - l.timestamp <= 24 * 60 * 60 * 1000);

  if (filterVal === 'custom') {
    const from = logsRangeFrom.value ? new Date(logsRangeFrom.value).getTime() : 0;
    const to = logsRangeTo.value ? new Date(logsRangeTo.value).getTime() : now;
    return logs.filter(l => l.timestamp >= from && l.timestamp <= to);
  }
  return logs;
}

async function renderLogs() {
  const { logs = [] } = await chrome.storage.local.get(['logs']);
  const filtered = getFilteredLogs([...logs]).reverse();

  if (filtered.length === 0) {
    logsContainer.innerHTML = '<div class="log-entry">No logs match the selected filter.</div>';
    return;
  }

  logsContainer.innerHTML = filtered.map(log => {
    const date = new Date(log.timestamp);
    const timeStr = date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `<div class="log-entry">
      <span class="log-timestamp">[${dateStr} ${timeStr}]</span>
      <span class="log-level-${log.level}">${log.message}</span>
    </div>`;
  }).join('');
}

// Time range filter interactions
logsTimeFilter.addEventListener('change', () => {
  logsCustomRange.style.display = logsTimeFilter.value === 'custom' ? 'flex' : 'none';
  renderLogs();
});

logsRangeFrom.addEventListener('change', renderLogs);
logsRangeTo.addEventListener('change', renderLogs);

// Copy logs button
copyLogsBtn.addEventListener('click', async () => {
  const { logs = [] } = await chrome.storage.local.get(['logs']);
  const filtered = getFilteredLogs([...logs]).reverse();

  if (filtered.length === 0) {
    copyLogsBtn.textContent = '⚠️ Empty';
    setTimeout(() => { copyLogsBtn.innerHTML = '📋 Copy'; }, 1500);
    return;
  }

  const text = filtered.map(log => {
    const date = new Date(log.timestamp);
    const timeStr = date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `[${dateStr} ${timeStr}] [${(log.level || 'info').toUpperCase()}] ${log.message}`;
  }).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    copyLogsBtn.textContent = '✅ Copied!';
    copyLogsBtn.classList.add('copied');
  } catch {
    copyLogsBtn.textContent = '❌ Failed';
  }
  setTimeout(() => {
    copyLogsBtn.innerHTML = '📋 Copy';
    copyLogsBtn.classList.remove('copied');
  }, 1800);
});

clearLogsBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ logs: [] });
  renderLogs();
});

// Load state from chrome.storage
async function loadState() {
  const result = await chrome.storage.local.get(['categories', 'settings']);
  if (result.categories) state.categories = result.categories;
  if (result.settings) {
    state.settings = { ...state.settings, ...result.settings };
    document.getElementById('gemini-api-key').value = state.settings.geminiApiKey || '';
    document.getElementById('llm-api-key').value = state.settings.llmApiKey || '';
    document.getElementById('email-api-key').value = state.settings.emailApiKey || '';
    document.getElementById('recipient-email').value = state.settings.recipientEmail || '';
    document.getElementById('allow-duplicates').checked = state.settings.allowDuplicates || false;
    document.getElementById('enable-schedule').checked = state.settings.enableSchedule || false;
    document.getElementById('schedule-time').value = state.settings.scheduleTime || '08:00';
    document.getElementById('scrape-duration').value = state.settings.scrapeDuration || 24;
    document.getElementById('scrape-duration-unit').value = state.settings.scrapeDurationUnit || 'hours';
  }
}

// Save state to chrome.storage
async function saveState() {
  await chrome.storage.local.set({
    categories: state.categories,
    settings: state.settings
  });
}

// Render UI based on state
function renderState() {
  categoriesContainer.innerHTML = '';

  if (state.categories.length === 0) {
    categoriesContainer.innerHTML = '<p style="text-align: center; color: #64748b; font-size: 0.875rem;">No categories added yet.</p>';
    return;
  }

  state.categories.forEach(category => {
    const categoryEl = document.createElement('div');
    // Read the expansion state; default to collapsed if not explicitly true
    const isExpanded = category.isExpanded === true;
    categoryEl.className = `category-card ${isExpanded ? '' : 'collapsed'}`;

    // Profiles HTML
    const profilesHtml = category.profiles.map((profile, i) => `
      <div class="profile-item">
        <div class="profile-info">
          <span class="profile-url" title="${profile.url}">${profile.url}</span>
          <div class="profile-toggles">
            <label class="toggle-group">
              <input type="checkbox" class="ai-toggle" data-cat-id="${category.id}" data-profile-url="${profile.url}" ${profile.enableAiSummary ? 'checked' : ''}>
              AI Summary
            </label>
            <label class="toggle-group">
              <input type="checkbox" class="replies-toggle" data-cat-id="${category.id}" data-profile-url="${profile.url}" ${profile.scrapeReplies ? 'checked' : ''}>
              Replies
            </label>
            <label class="toggle-group">
              <input type="checkbox" class="retweets-toggle" data-cat-id="${category.id}" data-profile-url="${profile.url}" ${profile.scrapeRetweets !== false ? 'checked' : ''}>
              Retweets
            </label>
          </div>
        </div>
        <div class="profile-side">
          <label class="cat-badge cat-badge-active ${profile.isActive !== false ? 'is-on' : ''}" style="font-size:0.67rem;">
            <input type="checkbox" class="active-toggle" data-cat-id="${category.id}" data-profile-url="${profile.url}" ${profile.isActive !== false ? 'checked' : ''}>
            Active
          </label>
          <button class="delete-btn btn-delete-profile" data-cat-id="${category.id}" data-profile-url="${profile.url}">Del</button>
        </div>
      </div>
    `).join('');

    categoryEl.innerHTML = `
      <div class="category-header" style="cursor: pointer;">
        <!-- Row 1: name + action buttons -->
        <div class="cat-header-top">
          <div class="cat-title">
            <span class="collapse-icon">${isExpanded ? '▼' : '▶'}</span>
            <span class="cat-name">${category.name}</span>
          </div>
          <div class="cat-actions">
            <button class="btn-run-cat" data-id="${category.id}" title="Run this category now">▶ Run</button>
            <button class="delete-btn btn-delete-cat" data-id="${category.id}">Delete</button>
          </div>
        </div>
        <!-- Row 2: pill badges -->
        <div class="cat-badges">
          <button
            class="cat-badge cat-badge-summarise cat-badge-mode-${category.categorySummaryMode || 'off'}"
            data-cat-id="${category.id}"
            data-mode="${category.categorySummaryMode || 'off'}"
            title="Cycle summary mode: Off → Minimal → Normal"
            onclick="event.stopPropagation()"
          >${{ off: '✨ Summarise: Off', minimal: '✨ Minimal', normal: '📋 Normal' }[category.categorySummaryMode || 'off']}</button>
          <label class="cat-badge cat-badge-active ${category.isActive !== false ? 'is-on' : ''}">
            <input type="checkbox" class="cat-active-toggle" data-cat-id="${category.id}" ${category.isActive !== false ? 'checked' : ''}>
            Active
          </label>
        </div>
      </div>
      <div class="category-content">
        <div class="profiles-list">
          ${profilesHtml}
        </div>
        <div class="add-profile-form">
          <input type="text" class="new-profile-url" placeholder="https://x.com/username">
          <button class="btn-add-profile" data-cat-id="${category.id}">Add</button>
        </div>
        <div class="extra-emails-group">
          <label class="extra-emails-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" class="cat-extra-emails-toggle" data-cat-id="${category.id}" ${category.enableExtraEmails !== false ? 'checked' : ''}>
            📧 Extra Recipients for this category:
          </label>
          <input
            type="text"
            class="cat-extra-emails"
            data-cat-id="${category.id}"
            value="${category.extraEmails || ''}"
            placeholder="extra@example.com, another@example.com"
          />
        </div>
        <div class="summary-prompt-group">
          <div style="margin-bottom: 12px; display: flex; gap: 16px; flex-wrap: wrap;">
            <label style="font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer; color: #475569;">
              <input type="checkbox" class="cat-factcheck-toggle" data-cat-id="${category.id}" ${category.enableFactCheck !== false ? 'checked' : ''}>
              🚨 Include Fact-Check
            </label>
            <label style="font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer; color: #475569;">
              <input type="checkbox" class="cat-glossary-toggle" data-cat-id="${category.id}" ${category.enableGlossary !== false ? 'checked' : ''}>
              📖 Include Glossary
            </label>
          </div>
          <label class="summary-prompt-label">✏️ Custom Summary Prompt <span style="font-weight:400; color: #94a3b8;">(optional — overrides default)</span></label>
          <textarea
            class="cat-summary-prompt"
            data-cat-id="${category.id}"
            rows="3"
            placeholder="E.g. Summarise these tweets focusing on product announcements and ignore any promotional content…">${category.summaryPrompt || ''}</textarea>
        </div>
      </div>
    `;


    categoriesContainer.appendChild(categoryEl);
  });

  attachEventListeners();
}

function attachEventListeners() {
  // Toggle Category Collapse
  document.querySelectorAll('.category-header').forEach(header => {
    header.addEventListener('click', (e) => {
      // Don't toggle if clicking the delete button, run button, active toggle, or badge area
      if (
        e.target.classList.contains('btn-delete-cat') ||
        e.target.classList.contains('btn-run-cat') ||
        e.target.closest('.cat-badges') ||
        e.target.closest('.cat-actions')
      ) return;

      const card = e.target.closest('.category-card');
      const isNowCollapsed = card.classList.toggle('collapsed');

      const icon = card.querySelector('.collapse-icon');
      if (isNowCollapsed) {
        icon.textContent = '▶';
      } else {
        icon.textContent = '▼';
      }

      // Save the expansion state
      const catId = card.querySelector('.btn-delete-cat').getAttribute('data-id');
      const category = state.categories.find(c => c.id === catId);
      if (category) {
        category.isExpanded = !isNowCollapsed;
        saveState(); // Save silently without a full re-render
      }
    });
  });

  // Run Category manually
  document.querySelectorAll('.btn-run-cat').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't trigger collapse
      const catId = e.target.getAttribute('data-id');
      const categoryIndex = state.categories.findIndex(c => c.id === catId);

      const originalText = e.target.innerHTML;
      e.target.innerHTML = '⏳...';
      e.target.disabled = true;

      chrome.runtime.sendMessage({ action: "start_category_scraping", categoryIndex: categoryIndex }, () => {
        e.target.innerHTML = '✅ Started';
        setTimeout(() => {
          e.target.innerHTML = originalText;
          e.target.disabled = false;
        }, 2000);
      });
    });
  });

  // Delete Category
  document.querySelectorAll('.btn-delete-cat').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't trigger collapse
      const id = e.target.getAttribute('data-id');
      state.categories = state.categories.filter(c => c.id !== id);
      saveState().then(renderState);
    });
  });

  // Toggle Category Active Status
  document.querySelectorAll('.cat-active-toggle').forEach(checkbox => {
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    checkbox.addEventListener('change', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const category = state.categories.find(c => c.id === catId);
      if (category) {
        category.isActive = e.target.checked;
        saveState();
        // Keep badge style in sync
        const badge = e.target.closest('.cat-badge-active');
        if (badge) badge.classList.toggle('is-on', e.target.checked);
      }
    });
  });

  // Add Profile
  document.querySelectorAll('.btn-add-profile').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const input = e.target.previousElementSibling;
      const url = input.value.trim();

      if (url && (url.includes('x.com/') || url.includes('twitter.com/'))) {
        const category = state.categories.find(c => c.id === catId);
        if (!category.profiles.some(p => p.url === url)) {
          category.profiles.push({ url, enableAiSummary: false, scrapeReplies: false, scrapeRetweets: true, isActive: true });

          // Force the category to open so the user can see their newly added profile
          category.isExpanded = true;

          saveState().then(renderState);
        }
      } else {
        alert('Please enter a valid X (Twitter) profile URL.');
      }
    });
  });

  // Delete Profile
  document.querySelectorAll('.btn-delete-profile').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const profileUrl = e.target.getAttribute('data-profile-url');
      const category = state.categories.find(c => c.id === catId);
      category.profiles = category.profiles.filter(p => p.url !== profileUrl);
      saveState().then(renderState);
    });
  });

  // Toggle AI Summary
  document.querySelectorAll('.ai-toggle').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const profileUrl = e.target.getAttribute('data-profile-url');
      const category = state.categories.find(c => c.id === catId);
      const profile = category.profiles.find(p => p.url === profileUrl);
      profile.enableAiSummary = e.target.checked;
      saveState();
    });
  });

  // Toggle Scrape Replies
  document.querySelectorAll('.replies-toggle').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const profileUrl = e.target.getAttribute('data-profile-url');
      const category = state.categories.find(c => c.id === catId);
      const profile = category.profiles.find(p => p.url === profileUrl);
      profile.scrapeReplies = e.target.checked;
      saveState();
    });
  });

  // Toggle Scrape Retweets
  document.querySelectorAll('.retweets-toggle').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const profileUrl = e.target.getAttribute('data-profile-url');
      const category = state.categories.find(c => c.id === catId);
      const profile = category.profiles.find(p => p.url === profileUrl);
      profile.scrapeRetweets = e.target.checked;
      saveState();
    });
  });

  // Toggle Active Status
  document.querySelectorAll('.active-toggle').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const profileUrl = e.target.getAttribute('data-profile-url');
      const category = state.categories.find(c => c.id === catId);
      const profile = category.profiles.find(p => p.url === profileUrl);
      profile.isActive = e.target.checked;
      saveState();
    });
  });

  // Cycle Category Summary Mode (Off → Minimal → Normal → Off)
  const SUMMARY_MODES = ['off', 'minimal', 'normal'];
  const SUMMARY_LABELS = { off: '✨ Summarise: Off', minimal: '✨ Minimal', normal: '📋 Normal' };
  document.querySelectorAll('.cat-badge-summarise').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const catId = btn.getAttribute('data-cat-id');
      const category = state.categories.find(c => c.id === catId);
      if (!category) return;
      const currentMode = category.categorySummaryMode || 'off';
      const nextMode = SUMMARY_MODES[(SUMMARY_MODES.indexOf(currentMode) + 1) % SUMMARY_MODES.length];
      category.categorySummaryMode = nextMode;
      // Keep legacy boolean in sync for backward compat
      category.enableCategorySummary = (nextMode !== 'off');
      saveState();
      // Update button label + CSS mode class
      btn.textContent = SUMMARY_LABELS[nextMode];
      btn.setAttribute('data-mode', nextMode);
      SUMMARY_MODES.forEach(m => btn.classList.remove(`cat-badge-mode-${m}`));
      btn.classList.add(`cat-badge-mode-${nextMode}`);
      btn.classList.toggle('is-on', nextMode !== 'off');
    });
  });

  // Toggle Category Fact-Check
  document.querySelectorAll('.cat-factcheck-toggle').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const category = state.categories.find(c => c.id === catId);
      if (category) {
        category.enableFactCheck = e.target.checked;
        saveState();
      }
    });
  });

  // Toggle Category Glossary
  document.querySelectorAll('.cat-glossary-toggle').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const category = state.categories.find(c => c.id === catId);
      if (category) {
        category.enableGlossary = e.target.checked;
        saveState();
      }
    });
  });

  // Toggle Extra Emails Enabled Status
  document.querySelectorAll('.cat-extra-emails-toggle').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const category = state.categories.find(c => c.id === catId);
      if (category) {
        category.enableExtraEmails = e.target.checked;
        saveState();
      }
    });
  });

  // Save extra recipient emails for a category on blur
  document.querySelectorAll('.cat-extra-emails').forEach(input => {
    input.addEventListener('blur', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const category = state.categories.find(c => c.id === catId);
      if (category) {
        category.extraEmails = e.target.value.trim();
        saveState();
      }
    });
  });

  // Save custom summary prompt for a category on blur
  document.querySelectorAll('.cat-summary-prompt').forEach(textarea => {
    textarea.addEventListener('blur', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const category = state.categories.find(c => c.id === catId);
      if (category) {
        category.summaryPrompt = e.target.value.trim();
        saveState();
      }
    });
  });
}

// Export Config
exportBtn.addEventListener('click', () => {
  const exportData = {
    settings: state.settings,
    categories: state.categories
  };
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
  const downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute("href", dataStr);
  downloadAnchorNode.setAttribute("download", "dailyupdates_profiles.json");
  document.body.appendChild(downloadAnchorNode);
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
});

// Import Config
importBtn.addEventListener('click', () => {
  importFile.click();
});

importFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const importedCategories = JSON.parse(event.target.result);
      if (Array.isArray(importedCategories)) {
        state.categories = importedCategories;
        saveState().then(renderState);
        statusMessage.textContent = 'Profiles loaded successfully!';
        setTimeout(() => { statusMessage.textContent = ''; }, 3000);
      } else {
        alert('Invalid JSON format. Expected an array of categories.');
      }
    } catch (err) {
      alert('Error reading the file: ' + err.message);
    }
  };
  reader.readAsText(file);

  // Reset input so the same file could be imported again if needed
  e.target.value = '';
});

// Add New Category
addCategoryBtn.addEventListener('click', () => {
  const name = newCategoryInput.value.trim();
  if (name) {
    state.categories.push({
      id: 'cat_' + Date.now(),
      name: name,
      isActive: true, // Default new categories to active
      enableCategorySummary: false,
      profiles: []
    });
    newCategoryInput.value = '';
    saveState().then(renderState);
  }
});

// Save Settings (no longer triggers scraping)
saveSettingsBtn.addEventListener('click', () => {
  state.settings.geminiApiKey = document.getElementById('gemini-api-key').value.trim();
  state.settings.llmApiKey = document.getElementById('llm-api-key').value.trim();
  state.settings.emailApiKey = document.getElementById('email-api-key').value.trim();
  state.settings.recipientEmail = document.getElementById('recipient-email').value.trim();
  state.settings.allowDuplicates = document.getElementById('allow-duplicates').checked;
  state.settings.enableSchedule = document.getElementById('enable-schedule').checked;
  state.settings.scheduleTime = document.getElementById('schedule-time').value;
  state.settings.scrapeDuration = parseInt(document.getElementById('scrape-duration').value, 10) || 24;
  state.settings.scrapeDurationUnit = document.getElementById('scrape-duration-unit').value || 'hours';

  saveState().then(() => {
    statusMessage.textContent = '✅ Settings saved!';
    setTimeout(() => { statusMessage.textContent = ''; }, 3000);

    // Notify background script to update alarms
    chrome.runtime.sendMessage({ action: "update_schedule", settings: state.settings });
  });
});

// Run Now button (triggers scraping immediately)
const runNowBtn = document.getElementById('run-now-btn');
const runStatusMessage = document.getElementById('run-status-message');

runNowBtn.addEventListener('click', () => {
  runStatusMessage.textContent = '⏳ Scraping in progress...';
  runNowBtn.disabled = true;
  runNowBtn.style.opacity = '0.6';

  chrome.runtime.sendMessage({ action: "start_scraping" }, () => {
    runStatusMessage.textContent = '🚀 Scraping started!';
    setTimeout(() => {
      runStatusMessage.textContent = '';
      runNowBtn.disabled = false;
      runNowBtn.style.opacity = '1';
    }, 4000);
  });
});

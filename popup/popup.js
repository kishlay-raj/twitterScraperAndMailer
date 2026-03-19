// State Management
let state = {
  categories: [],
  settings: {
    llmApiKey: '',
    emailApiKey: '',
    recipientEmail: '',
    allowDuplicates: false,
    enableSchedule: false,
    scheduleTime: '08:00'
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

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  renderState();
});

// Load state from chrome.storage
async function loadState() {
  const result = await chrome.storage.local.get(['categories', 'settings']);
  if (result.categories) state.categories = result.categories;
  if (result.settings) {
    state.settings = { ...state.settings, ...result.settings };
    document.getElementById('llm-api-key').value = state.settings.llmApiKey || '';
    document.getElementById('email-api-key').value = state.settings.emailApiKey || '';
    document.getElementById('recipient-email').value = state.settings.recipientEmail || '';
    document.getElementById('allow-duplicates').checked = state.settings.allowDuplicates || false;
    document.getElementById('enable-schedule').checked = state.settings.enableSchedule || false;
    document.getElementById('schedule-time').value = state.settings.scheduleTime || '08:00';
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
          <label class="toggle-group">
            <input type="checkbox" class="ai-toggle" data-cat-id="${category.id}" data-profile-url="${profile.url}" ${profile.enableAiSummary ? 'checked' : ''}>
            AI Summary
          </label>
          <label class="toggle-group" style="margin-left: 10px;">
            <input type="checkbox" class="replies-toggle" data-cat-id="${category.id}" data-profile-url="${profile.url}" ${profile.scrapeReplies ? 'checked' : ''}>
            Inc. Replies
          </label>
          <label class="toggle-group" style="margin-left: 10px;">
            <input type="checkbox" class="retweets-toggle" data-cat-id="${category.id}" data-profile-url="${profile.url}" ${profile.scrapeRetweets !== false ? 'checked' : ''}>
            Inc. Retweets
          </label>
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-end;">
          <label class="toggle-group" style="color: #10b981; font-weight: bold;">
            <input type="checkbox" class="active-toggle" data-cat-id="${category.id}" data-profile-url="${profile.url}" ${profile.isActive !== false ? 'checked' : ''}>
            Active
          </label>
          <button class="delete-btn btn-delete-profile" data-cat-id="${category.id}" data-profile-url="${profile.url}">Del</button>
        </div>
      </div>
    `).join('');

    categoryEl.innerHTML = `
      <div class="category-header" style="cursor: pointer;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="collapse-icon" style="font-size: 0.7rem; color: #64748b;">${isExpanded ? '▼' : '▶'}</span>
          <span>${category.name}</span>
        </div>
        <div style="display: flex; gap: 10px; align-items: center;">
          <label class="toggle-group" style="color: #10b981; font-weight: bold; cursor: pointer;">
            <input type="checkbox" class="cat-active-toggle" data-cat-id="${category.id}" ${category.isActive !== false ? 'checked' : ''}>
            Active
          </label>
          <button class="delete-btn btn-delete-cat" data-id="${category.id}">Delete</button>
        </div>
      </div >
      <div class="category-content">
        <div class="profiles-list">
          ${profilesHtml}
        </div>
        <div class="add-profile-form">
          <input type="text" class="new-profile-url" placeholder="https://x.com/username">
            <button class="btn-add-profile" data-cat-id="${category.id}">Add</button>
        </div>
        <div class="extra-emails-group">
          <label class="extra-emails-label">📧 Extra Recipients for this category:</label>
          <input
            type="text"
            class="cat-extra-emails"
            data-cat-id="${category.id}"
            value="${category.extraEmails || ''}"
            placeholder="extra@example.com, another@example.com"
          />
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
      // Don't toggle if clicking the delete button or active toggle
      if (e.target.classList.contains('btn-delete-cat') || e.target.closest('.cat-active-toggle')) return;

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
      e.stopPropagation(); // Don't trigger collapse when clicking the checkbox
    });
    checkbox.addEventListener('change', (e) => {
      const catId = e.target.getAttribute('data-cat-id');
      const category = state.categories.find(c => c.id === catId);
      if (category) {
        category.isActive = e.target.checked;
        saveState();
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
}

// Export Config
exportBtn.addEventListener('click', () => {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.categories, null, 2));
  const downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute("href", dataStr);
  downloadAnchorNode.setAttribute("download", "antigravity_profiles.json");
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
      profiles: []
    });
    newCategoryInput.value = '';
    saveState().then(renderState);
  }
});

// Save Settings & Trigger Scraping
saveSettingsBtn.addEventListener('click', () => {
  state.settings.llmApiKey = document.getElementById('llm-api-key').value.trim();
  state.settings.emailApiKey = document.getElementById('email-api-key').value.trim();
  state.settings.recipientEmail = document.getElementById('recipient-email').value.trim();
  state.settings.allowDuplicates = document.getElementById('allow-duplicates').checked;
  state.settings.enableSchedule = document.getElementById('enable-schedule').checked;
  state.settings.scheduleTime = document.getElementById('schedule-time').value;

  saveState().then(() => {
    statusMessage.textContent = 'Settings saved. Initiating scraping...';
    setTimeout(() => { statusMessage.textContent = ''; }, 3000);

    // Notify background script to update alarms
    chrome.runtime.sendMessage({ action: "update_schedule", settings: state.settings });

    // Notify background script to start the scraping sequence
    chrome.runtime.sendMessage({ action: "start_scraping" });
  });
});

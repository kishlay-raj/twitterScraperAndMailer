# Antigravity - X (Twitter) Scraper & Mailer

A powerful and automated Chrome Extension designed to scrape X (formerly Twitter) profiles, extract new tweets over a rolling 24-hour period, summarize the content using AI (LLMs), and dispatch curated email reports directly to your inbox.

## 🚀 Features

- **Automated Background Scraping:** Runs autonomously via Chrome Alarms on a customizable daily schedule.
- **Categorized Profiles:** Organize the Twitter handles you follow into distinct categories (e.g., Tech, News, Crypto).
- **Smart Extraction:** 
  - Automatically skips tweets older than 24 hours.
  - Detects and skips "Pinned" tweets so they aren't repeatedly processed.
  - Option to include/exclude Replies and Reposts (Retweets).
  - Identifies Media (Images/Videos) and exclusive "Subscriber-Only" posts.
- **Deduplication:** Keeps track of previously processed/emailed tweets to ensure you only receive novel content unless explicitly configured otherwise.
- **AI Integration (LLM Summaries):** Connects to your preferred LLM API (like Groq) to generate concise, high-level summaries of the scraped tweets before the raw data.
- **Custom Webhook Emailing:** Integrates with Google Apps Script (or any custom email webhook) to compile the data into clean, formatted HTML emails sent directly to you.

## ⚙️ Installation

Because this is an unpacked Chrome Extension, you'll need to load it manually into your browser:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/helloworldkr/twitterScraperAndMailer.git
   cd twitterScraperAndMailer
   ```
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click the **Load unpacked** button in the top left.
5. Select the `twitterScraperAndMailer` (or `xProfileScraperMailerExtension`) directory.
6. The extension should now appear in your list of active extensions! Pin it to your toolbar for easy access.

## 🖥️ Desktop App (Electron)

For a more robust experience without browser extension limitations, use the Electron-based desktop app located in the `desktop-app` directory.

### Running the Desktop App
1. Navigate to the `desktop-app` folder: `cd desktop-app`
2. Install dependencies: `npm install`
3. Start the app: `npm start`

### Managing Scrape Runs
- **Find a Run:** Active runs are logged in real-time in the **Recent Logs** section at the bottom of the UI. You can also see the app status in your System Tray (macOS Menu Bar / Windows Taskbar).
- **Stop a Run:** To immediately stop a run in progress, you must **Quit** the application. 
  - **Note:** Closing the main window only minimizes the app to the System Tray to keep scheduled runs active. 
  - **Via UI:** Right-click the icon in the System Tray and select **Quit**.
  - **Via Terminal (macOS/Linux):** 
    ```bash
    # Kill only the process associated with this project
    pkill -f "xProfileScraperMailerExtension/desktop-app"
    ```
  - **Via Command Prompt (Windows):**
    ```cmd
    # Search for the specific process and kill it
    wmic process where "commandline like '%xProfileScraperMailerExtension%'" delete
    ```
- **Rerun a Cycle:** 
  - **All Categories:** Click the **🚀 Run Now** button at the top of the app, or select **Run Now** from the System Tray menu.
  - **Single Category:** Expand a category and click the **▶ Run** button next to its title.

### Key Desktop Features
- **Login Guard:** Automatically detects if your X.com session has expired. If you're logged out, the app pauses the scrape, notifies you via a modal UI with instructions, and waits for you to log in manually before allowing a retry.
- **Enhanced Category Management:** 
  - **Collapsible Categories:** Click any category header to expand or collapse. State is persisted between sessions.
  - **One-Click Summary Modes:** Cycle through "Off", "Minimal", and "Normal" summary modes directly via a toggle pill on the category badge.
  - **Extra Recipients Toggle:** Enable/disable extra email recipients per category with a dedicated checkbox.
  - **Auto-Save:** Settings like custom prompts and extra recipients save automatically on blur—no "Save" button required.
- **Duplicate Prevention:** Built-in checks to prevent adding duplicate profiles to the same category.
- **Persistent Sessions:** Uses a dedicated Chromium user data directory so you only need to log in once.

## 🔧 Setup & Configuration

Once installed, click the extension icon to open the configuration popup.

### Settings Tab
1. **Email API Endpoint (Webhook):** Paste your Google Apps Script URL (or equivalent webhook URL) that processes the incoming JSON payload and sends the email.
2. **LLM API Key:** Enter your API key for Groq (or your chosen LLM provider) if you plan on using AI summaries.
3. **Recipient Email:** The email address where you want to receive the curated summaries.
4. **Daily AI Scraping Schedule:** Enable the automated schedule and set a specific time of day for the background service worker to trigger.

### Categories Tab
1. Add custom categories (e.g., `VCs`, `Developers`).
2. Add specific X Profile URLs to each category (e.g., `https://x.com/elonmusk`).
3. Toggle whether you want AI summaries for that specific profile.

## 🏗️ Technical Architecture

- **Manifest V3:** The extension strictly utilizes Chrome's Manifest V3 architecture.
- **Service Worker (`background/service_worker.js`):** Manages alarms, initiates scraping cycles, coordinates LLM API calls, builds the HTML email templates, and dispatches the final payload to the webhook.
- **Content Scripts (`content/scraper.js`):** Injected dynamically into X.com pages to interact with the DOM, scroll intelligently, and extract tweet data accurately without triggering anti-bot protections.
- **Popup UI (`popup/`):** Vanilla HTML/CSS/JS interface for managing categories, profiles, and backend API credentials (saved safely in `chrome.storage.local`).

## ⚠️ Important Notes
- This extension runs locally in your browser and relies on your active, authenticated session on X.com to read tweets (especially subscriber-only ones).
- X frequently changes its DOM structure which may occasionally break the extraction logic. The `scraper.js` uses flexible `data-testid` and SVG path matching to maximize resilience.

## 📄 License
This project is open-source and available under the standard MIT License.

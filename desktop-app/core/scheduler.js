/**
 * Scheduler — Daily Cron Job
 *
 * Replaces: chrome.alarms (dailyScrapeAlarm, dailyUnblockAlarm)
 *
 * Uses node-cron to fire the scrape run at the user's configured time,
 * every day, reliably — because this is a persistent Node.js process.
 */

const cron = require('node-cron');

let currentTask = null;

/**
 * Apply a schedule from settings. Replaces any existing schedule.
 *
 * @param {Object} settings - User settings object
 * @param {string} settings.enableSchedule - Whether scheduling is enabled
 * @param {string} settings.scheduleTime - Time in "HH:MM" format (24h)
 * @param {Function} onFire - Async callback to run when the schedule fires
 */
function updateSchedule(settings, onFire) {
    // Always clear any existing job first
    stop();

    if (!settings || !settings.enableSchedule || !settings.scheduleTime) {
        console.log('[Scheduler] Daily schedule is disabled.');
        return;
    }

    const [hours, minutes] = settings.scheduleTime.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) {
        console.warn('[Scheduler] Invalid scheduleTime:', settings.scheduleTime);
        return;
    }

    // node-cron expression: "minute hour * * *"
    const expression = `${minutes} ${hours} * * *`;

    currentTask = cron.schedule(expression, async () => {
        console.log(`[Scheduler] Daily scrape alarm fired at ${new Date().toLocaleTimeString()}`);
        try {
            await onFire();
        } catch (err) {
            console.error('[Scheduler] Scrape run failed:', err.message);
        }
    }, {
        scheduled: true,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone // Use local system timezone
    });

    console.log(`[Scheduler] Daily scrape scheduled for ${settings.scheduleTime} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`);
}

/**
 * Stop and destroy the current cron job.
 */
function stop() {
    if (currentTask) {
        currentTask.stop();
        currentTask = null;
        console.log('[Scheduler] Schedule stopped.');
    }
}

module.exports = { updateSchedule, stop };

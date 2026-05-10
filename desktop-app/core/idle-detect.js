/**
 * Idle Detection — macOS System Idle Time
 *
 * Uses `ioreg -c IOHIDSystem` to read HIDIdleTime, which reports the
 * number of nanoseconds since the last keyboard/mouse/trackpad input.
 *
 * This is used by the "Smart Browser Mode" feature: if the user is idle
 * (away from keyboard), we launch a visible browser (less likely to be
 * flagged as a bot by X.com). If the user is active, we use headless
 * mode to avoid window disturbance.
 */

const { execFile } = require('child_process');

/**
 * Default idle threshold in seconds.
 * If the user has been idle for longer than this, they're considered "away".
 */
const DEFAULT_IDLE_THRESHOLD_SECONDS = 300; // 5 minutes

/**
 * Get the system idle time in seconds.
 *
 * @returns {Promise<number>} Idle time in seconds (0 if detection fails)
 */
function getIdleTimeSeconds() {
    return new Promise((resolve) => {
        execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], (err, stdout) => {
            if (err) {
                console.warn('[IdleDetect] ioreg failed:', err.message);
                resolve(0); // Assume active if detection fails
                return;
            }

            // HIDIdleTime is reported in nanoseconds
            const match = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
            if (!match) {
                console.warn('[IdleDetect] Could not parse HIDIdleTime from ioreg output.');
                resolve(0);
                return;
            }

            const idleNs = parseInt(match[1], 10);
            const idleSec = idleNs / 1_000_000_000;
            resolve(idleSec);
        });
    });
}

/**
 * Check whether the user is currently idle (away from keyboard).
 *
 * @param {number} [thresholdSeconds=300] - Seconds of inactivity to consider "idle"
 * @returns {Promise<{ isIdle: boolean, idleSeconds: number }>}
 */
async function checkIdle(thresholdSeconds = DEFAULT_IDLE_THRESHOLD_SECONDS) {
    const idleSeconds = await getIdleTimeSeconds();
    return {
        isIdle: idleSeconds >= thresholdSeconds,
        idleSeconds: Math.round(idleSeconds),
    };
}

module.exports = { getIdleTimeSeconds, checkIdle, DEFAULT_IDLE_THRESHOLD_SECONDS };

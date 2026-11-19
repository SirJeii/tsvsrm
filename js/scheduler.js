/**
 * ============================================================================
 * Client-Side Background Reminder Scheduler
 * Runs while the TSV Lead's dashboard is open (every 60 seconds).
 * Uses Firestore transactions to atomically set `reminder24hSent: true` or
 * `reminder2hSent: true` BEFORE sending SMS so duplicate alerts are prevented
 * across multiple open tabs or alongside the Firebase Cloud Function.
 * ============================================================================
 */

import {
  db,
  doc,
  updateDoc,
  runTransaction,
  serverTimestamp,
} from './firebase-config.js';
import { dispatchScheduleNotifications } from './sms-service.js';
import { toJsDate, showToast } from './ui-helpers.js';

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const HOUR_MS = 60 * 60 * 1000;

let intervalId = null;
let isChecking = false;

/**
 * Atomically claims a reminder slot using a Firestore transaction.
 * Returns true if this client won the lock and should dispatch the SMS.
 *
 * @param {string} scheduleId
 * @param {'24h'|'2h'} reminderKind
 * @returns {Promise<boolean>}
 */
async function claimReminderLock(scheduleId, reminderKind) {
  const flagKey = reminderKind === '24h' ? 'reminder24hSent' : 'reminder2hSent';
  const statusKey = reminderKind === '24h' ? 'reminder24hStatus' : 'reminder2hStatus';
  const sentAtKey = reminderKind === '24h' ? 'reminder24hSentAt' : 'reminder2hSentAt';
  const ref = doc(db, 'schedules', scheduleId);

  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return false;
      const data = snap.data();
      const notifications = data.notifications || {};

      if (notifications[flagKey] === true) {
        return false; // Already claimed/sent by another tab or Cloud Function
      }

      tx.update(ref, {
        notifications: {
          ...notifications,
          [flagKey]: true,
          [statusKey]: 'pending',
          [sentAtKey]: serverTimestamp(),
        },
        updatedAt: serverTimestamp(),
      });
      return true;
    });
  } catch (err) {
    console.warn(`Transaction lock skipped for ${scheduleId} (${reminderKind}):`, err);
    return false;
  }
}

/**
 * Evaluates all cached schedules against current time and dispatches any due
 * 24-hour or 2-hour reminders.
 *
 * @param {() => Array<object>} getSchedules
 * @param {() => object} getSettings
 * @param {(text: string) => void} [onStatusUpdate]
 */
export async function runReminderCheck(getSchedules, getSettings, onStatusUpdate) {
  if (isChecking) return;
  isChecking = true;

  try {
    const schedules = getSchedules();
    const settings = getSettings();
    const nowMs = Date.now();

    for (const schedule of schedules) {
      const dutyDateObj = toJsDate(schedule.dutyTimestamp);
      if (!dutyDateObj) continue;

      const msUntilDuty = dutyDateObj.getTime() - nowMs;
      if (msUntilDuty <= 0) continue; // Past schedule

      const notifications = schedule.notifications || {};

      // Trigger 2: 24-Hour Reminder (between 2h and 24h before duty)
      if (
        !notifications.reminder24hSent &&
        msUntilDuty <= 24 * HOUR_MS &&
        msUntilDuty > 2 * HOUR_MS
      ) {
        const claimed = await claimReminderLock(schedule.id, '24h');
        if (claimed) {
          const result = await dispatchScheduleNotifications(schedule, settings, '24h Reminder');
          await updateDoc(doc(db, 'schedules', schedule.id), {
            'notifications.reminder24hStatus': result.overallStatus,
            'notifications.reminder24hSentAt': serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          showToast(
            `24-Hour Reminder processed for ${schedule.dutyDate} (${result.sentCount}/${result.total} sent).`,
            result.overallStatus === 'sent' ? 'success' : 'warning'
          );
        }
      }

      // Trigger 3: 2-Hour Final Reminder (within 2h before duty)
      if (!notifications.reminder2hSent && msUntilDuty <= 2 * HOUR_MS) {
        const claimed = await claimReminderLock(schedule.id, '2h');
        if (claimed) {
          const result = await dispatchScheduleNotifications(schedule, settings, '2h Reminder');
          await updateDoc(doc(db, 'schedules', schedule.id), {
            'notifications.reminder2hStatus': result.overallStatus,
            'notifications.reminder2hSentAt': serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          showToast(
            `2-Hour Final Reminder processed for ${schedule.dutyDate} (${result.sentCount}/${result.total} sent).`,
            result.overallStatus === 'sent' ? 'success' : 'warning'
          );
        }
      }
    }

    if (onStatusUpdate) {
      const timeStr = new Intl.DateTimeFormat('en-PH', {
        timeZone: 'Asia/Manila',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date());
      onStatusUpdate(`Auto-checker active • Last checked ${timeStr}`);
    }
  } catch (err) {
    console.error('Background reminder check error:', err);
  } finally {
    isChecking = false;
  }
}

/**
 * Starts the periodic 60-second client-side reminder checker.
 */
export function startBackgroundScheduler(getSchedules, getSettings, onStatusUpdate) {
  stopBackgroundScheduler();
  // Initial check after short delay to allow initial Firestore snapshots to arrive
  setTimeout(() => runReminderCheck(getSchedules, getSettings, onStatusUpdate), 2500);
  intervalId = setInterval(
    () => runReminderCheck(getSchedules, getSettings, onStatusUpdate),
    CHECK_INTERVAL_MS
  );
}

/**
 * Stops the background reminder checker (e.g., on logout).
 */
export function stopBackgroundScheduler() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}


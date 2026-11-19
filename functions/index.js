/**
 * ============================================================================
 * Firebase Cloud Functions v2 — Automated Suguan SMS Reminder Scheduler
 * Runs every 15 minutes (Asia/Manila) to dispatch 24-Hour and 2-Hour SMS
 * reminders via https://sabaykonekta.netlify.app even when no browser is open.
 *
 * Duplicate Prevention:
 * Uses Firestore transactions to atomically set `notifications.reminder24hSent`
 * or `notifications.reminder2hSent` to `true` BEFORE dispatching SMS.
 * ============================================================================
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const DEFAULT_SMS_API_URL = 'https://sabaykonekta.netlify.app/api/send-sms';
const PH_MOBILE_REGEX = /^(?:\+?63|0)?(9\d{9})$/;
const HOUR_MS = 60 * 60 * 1000;

function normalizeToE164(raw) {
  const cleaned = String(raw || '').replace(/[\s\-().]/g, '').trim();
  const m = cleaned.match(PH_MOBILE_REGEX);
  return m ? `+63${m[1]}` : null;
}

function normalizeToLocal(raw) {
  const cleaned = String(raw || '').replace(/[\s\-().]/g, '').trim();
  const m = cleaned.match(PH_MOBILE_REGEX);
  return m ? `0${m[1]}` : null;
}

function formatManilaDate(date) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatManilaTime(date) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function buildRecipients(schedule, settings) {
  const o = schedule.officers || {};
  const candidates = [
    { name: o.computerOperator?.name || 'Computer Operator', role: 'Computer Operator', phone: o.computerOperator?.phone || '' },
    { name: o.videoOperator?.name || 'Video Operator', role: 'Video Operator', phone: o.videoOperator?.phone || '' },
    { name: o.audioOperator?.name || 'Audio Operator', role: 'Audio Operator', phone: o.audioOperator?.phone || '' },
    { name: o.headDeacon?.name || 'Head Deacon', role: 'Head Deacon', phone: o.headDeacon?.phone || '' },
  ];

  const list = candidates.filter((r) => Boolean(String(r.phone || '').trim()));

  if (settings?.pastorPhone) {
    list.push({
      name: settings.pastorName || 'Pastor / Resident Minister',
      role: 'Pastor',
      phone: settings.pastorPhone,
    });
  }
  return list;
}

function formatSmsMessage(schedule, recipient, triggerType) {
  const dutyDateObj = schedule.dutyTimestamp.toDate();
  const shortDate = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
  }).format(dutyDateObj);
  const shortTime = formatManilaTime(dutyDateObj).replace(/\s+/g, '');
  const o = schedule.officers || {};

  const shortName = (full, max = 18) => {
    const clean = String(full || 'TBA').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}.` : clean;
  };

  const tag = triggerType === '2h Reminder' ? '[TSV 2H REM]' : '[TSV 24H REM]';
  const closing = triggerType === '2h Reminder' ? '2 hrs na lang po!' : 'Bukas na po. Salamat!';

  const roleShortMap = {
    'Computer Operator': 'Computer Op',
    'Video Operator': 'Video Op',
    'Audio Operator': 'Audio Op',
    'Head Deacon': 'Head Deacon',
    Pastor: 'Pastor Copy',
  };
  const roleLabel = roleShortMap[recipient.role] || recipient.role;

  const lineupParts = [
    `Comp:${shortName(o.computerOperator?.name)}`,
    o.videoOperator?.name ? `Vid:${shortName(o.videoOperator.name)}` : null,
    o.audioOperator?.name ? `Aud:${shortName(o.audioOperator.name)}` : null,
    `HD:${shortName(o.headDeacon?.name)}`,
  ].filter(Boolean);

  let msg = [
    `${tag} ${shortDate} ${shortTime}`,
    `Role: ${roleLabel}`,
    lineupParts.join('\n'),
    closing,
  ].join('\n');

  if (msg.length > 155) {
    msg = `${msg.slice(0, 152)}...`;
  }

  return msg;
}

async function sendSingleSms(phone, message, settings) {
  const apiUrl = (settings?.smsApiUrl || DEFAULT_SMS_API_URL).trim();
  const apiKey = (settings?.smsApiKey || '').trim();
  const deviceId = (settings?.smsDeviceId || '').trim();

  const normalizedE164 = normalizeToE164(phone);
  const normalizedLocal = normalizeToLocal(phone);

  if (!normalizedE164) {
    return { ok: false, responseText: `Invalid Philippine mobile number: "${phone}"` };
  }
  if (!apiKey) {
    return { ok: false, responseText: 'SMS API Key is not configured in settings/config.' };
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        to: normalizedE164,
        message,
        api_key: apiKey,
        device_id: deviceId || undefined,
        sender_id: deviceId || undefined,
        phone: normalizedE164,
        number: normalizedLocal,
        recipient: normalizedE164,
      }),
    });

    const rawText = await response.text();
    let ok = response.ok;
    try {
      const json = JSON.parse(rawText);
      if (json && (json.success === false || json.status === 'error' || json.error)) {
        ok = false;
      }
    } catch {
      // Plain-text response
    }

    return { ok, responseText: `HTTP ${response.status}: ${rawText.slice(0, 1500) || response.statusText}` };
  } catch (err) {
    return { ok: false, responseText: `Network error: ${err.message}` };
  }
}

async function claimReminderLock(scheduleRef, reminderKind) {
  const flagKey = reminderKind === '24h' ? 'reminder24hSent' : 'reminder2hSent';
  const statusKey = reminderKind === '24h' ? 'reminder24hStatus' : 'reminder2hStatus';
  const sentAtKey = reminderKind === '24h' ? 'reminder24hSentAt' : 'reminder2hSentAt';

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(scheduleRef);
    if (!snap.exists) return false;
    const data = snap.data();
    const notifications = data.notifications || {};
    if (notifications[flagKey] === true) return false;

    tx.update(scheduleRef, {
      notifications: {
        ...notifications,
        [flagKey]: true,
        [statusKey]: 'pending',
        [sentAtKey]: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
}

async function dispatchAndLog(scheduleId, scheduleData, settings, triggerType) {
  const recipients = buildRecipients(scheduleData, settings);
  let sentCount = 0;
  let failedCount = 0;

  for (let i = 0; i < recipients.length; i += 1) {
    const recipient = recipients[i];
    const message = formatSmsMessage(scheduleData, recipient, triggerType);
    const res = await sendSingleSms(recipient.phone, message, settings);
    if (res.ok) sentCount += 1;
    else failedCount += 1;

    await db.collection('sms_logs').add({
      scheduleId,
      dutyDate: scheduleData.dutyDate || null,
      dutyTime: scheduleData.dutyTime || null,
      recipientName: recipient.name,
      role: recipient.role,
      phoneNumber: normalizeToE164(recipient.phone) || String(recipient.phone || 'Invalid'),
      triggerType,
      message: message.slice(0, 2000),
      status: res.ok ? 'Success' : 'Failed',
      apiResponse: res.responseText.slice(0, 2000),
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      sentBy: 'cloud-scheduler',
    });

    if (i < recipients.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  if (sentCount > 0 && failedCount === 0) return 'sent';
  if (sentCount > 0 && failedCount > 0) return 'partial';
  return 'failed';
}

exports.processSuguanReminders = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Asia/Manila',
    retryCount: 1,
  },
  async () => {
    const nowMs = Date.now();
    const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);
    const horizonTs = admin.firestore.Timestamp.fromMillis(nowMs + 24 * HOUR_MS + 15 * 60 * 1000);

    const settingsSnap = await db.doc('settings/config').get();
    if (!settingsSnap.exists) {
      logger.warn('settings/config not found; skipping scheduled SMS reminders.');
      return;
    }
    const settings = settingsSnap.data();

    const upcomingSnap = await db
      .collection('schedules')
      .where('dutyTimestamp', '>', nowTs)
      .where('dutyTimestamp', '<=', horizonTs)
      .get();

    logger.info(`Checking ${upcomingSnap.size} upcoming Suguan schedule(s).`);

    for (const docSnap of upcomingSnap.docs) {
      const schedule = docSnap.data();
      const dutyMs = schedule.dutyTimestamp.toMillis();
      const msUntilDuty = dutyMs - nowMs;
      const notifications = schedule.notifications || {};

      // Trigger 2: 24-Hour Reminder (between 2h and 24h before duty)
      if (!notifications.reminder24hSent && msUntilDuty <= 24 * HOUR_MS && msUntilDuty > 2 * HOUR_MS) {
        const claimed = await claimReminderLock(docSnap.ref, '24h');
        if (claimed) {
          const status = await dispatchAndLog(docSnap.id, schedule, settings, '24h Reminder');
          await docSnap.ref.update({
            'notifications.reminder24hStatus': status,
            'notifications.reminder24hSentAt': admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          logger.info(`24h Reminder for ${docSnap.id}: ${status}`);
        }
      }

      // Trigger 3: 2-Hour Final Reminder (within 2h before duty)
      if (!notifications.reminder2hSent && msUntilDuty <= 2 * HOUR_MS && msUntilDuty > 0) {
        const claimed = await claimReminderLock(docSnap.ref, '2h');
        if (claimed) {
          const status = await dispatchAndLog(docSnap.id, schedule, settings, '2h Reminder');
          await docSnap.ref.update({
            'notifications.reminder2hStatus': status,
            'notifications.reminder2hSentAt': admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          logger.info(`2h Reminder for ${docSnap.id}: ${status}`);
        }
      }
    }
  }
);


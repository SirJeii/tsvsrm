/**
 * ============================================================================
 * SabayKonekta SMS Gateway Service & Firestore Audit Logging
 * Gateway: https://sabaykonekta.netlify.app
 * ============================================================================
 */

import {
  db,
  auth,
  collection,
  addDoc,
  serverTimestamp,
} from './firebase-config.js';
import { normalizeToE164, normalizeToLocal } from './phone-utils.js';
import { formatManilaDate, formatManilaTime } from './ui-helpers.js';

export const DEFAULT_SMS_API_URL = 'https://sabaykonekta.netlify.app/api/send-sms';

/**
 * Builds the 5-recipient list for a given schedule + system settings.
 * @param {object} schedule
 * @param {object} settings
 * @returns {Array<{name: string, role: string, phone: string}>}
 */
export function buildScheduleRecipients(schedule, settings) {
  const officers = schedule?.officers || {};
  const candidates = [
    {
      name: officers.computerOperator?.name || 'Computer Operator',
      role: 'Computer Operator',
      phone: officers.computerOperator?.phone || '',
    },
    {
      name: officers.videoOperator?.name || 'Video Operator',
      role: 'Video Operator',
      phone: officers.videoOperator?.phone || '',
    },
    {
      name: officers.audioOperator?.name || 'Audio Operator',
      role: 'Audio Operator',
      phone: officers.audioOperator?.phone || '',
    },
    {
      name: officers.headDeacon?.name || 'Head Deacon',
      role: 'Head Deacon',
      phone: officers.headDeacon?.phone || '',
    },
  ];

  // Only include officers who have a mobile number assigned
  const recipients = candidates.filter((r) => Boolean(String(r.phone || '').trim()));

  if (settings?.pastorPhone) {
    recipients.push({
      name: settings.pastorName || 'Pastor / Resident Minister',
      role: 'Pastor',
      phone: settings.pastorPhone,
    });
  }

  return recipients;
}

/**
 * Formats a compact GSM-7 TSV Suguan SMS message (<= 160 chars = 1 SMS segment)
 * so Android SMS gateways using sendTextMessage() always dispatch reliably.
 *
 * @param {object} params
 * @param {object} params.schedule
 * @param {{name: string, role: string}} params.recipient
 * @param {'Immediate'|'24h Reminder'|'2h Reminder'|'Manual Resend'} params.triggerType
 * @returns {string}
 */
export function formatSuguanSmsMessage({ schedule, recipient, triggerType }) {
  const dutyDateObj =
    schedule.dutyTimestamp && typeof schedule.dutyTimestamp.toDate === 'function'
      ? schedule.dutyTimestamp.toDate()
      : new Date(`${schedule.dutyDate}T${schedule.dutyTime}:00+08:00`);

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

  let tag = '[TSV SUGUAN]';
  let closing = 'Salamat po!';
  if (triggerType === '24h Reminder') {
    tag = '[TSV 24H REM]';
    closing = 'Bukas na po. Salamat!';
  } else if (triggerType === '2h Reminder') {
    tag = '[TSV 2H REM]';
    closing = '2 hrs na lang po!';
  } else if (triggerType === 'Manual Resend') {
    tag = '[TSV UPDATE]';
  }

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

  // Hard cap at 155 GSM-7 chars so SabayKonekta Android Gateway always sends as 1 segment
  if (msg.length > 155) {
    msg = `${msg.slice(0, 152)}...`;
  }

  return msg;
}

/**
 * Dispatches a single SMS via the SabayKonekta SMS Gateway API.
 * Never throws on HTTP/network errors; returns a structured result object for logging.
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {string} params.message
 * @param {object} params.settings
 * @returns {Promise<{ok: boolean, statusCode: number, responseText: string}>}
 */
export async function sendSingleSms({ phone, message, settings }) {
  const apiUrl = (settings?.smsApiUrl || DEFAULT_SMS_API_URL).trim();
  const apiKey = (settings?.smsApiKey || '').trim();
  const deviceId = (settings?.smsDeviceId || '').trim();

  const normalizedE164 = normalizeToE164(phone);
  const normalizedLocal = normalizeToLocal(phone);

  if (!normalizedE164) {
    return {
      ok: false,
      statusCode: 0,
      responseText: `Invalid Philippine mobile number: "${phone}"`,
    };
  }

  if (!apiKey) {
    return {
      ok: false,
      statusCode: 0,
      responseText: 'SMS API Key is not configured in System Settings.',
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

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
      signal: controller.signal,
    });

    const rawText = await response.text();
    let parsedSuccess = response.ok;

    // Inspect JSON body if present to catch API-level error flags returned with HTTP 200
    try {
      const json = JSON.parse(rawText);
      if (json && (json.success === false || json.status === 'error' || json.error)) {
        parsedSuccess = false;
      }
    } catch {
      // Plain text response; rely on response.ok
    }

    const summary = `HTTP ${response.status}: ${rawText.slice(0, 1500) || response.statusText}`;
    return {
      ok: parsedSuccess,
      statusCode: response.status,
      responseText: summary,
    };
  } catch (err) {
    const errMsg =
      err?.name === 'AbortError'
        ? 'Request timed out after 15 seconds.'
        : `Network/CORS error: ${err?.message || String(err)}`;
    return {
      ok: false,
      statusCode: 0,
      responseText: errMsg,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Writes an append-only audit entry to Firestore `sms_logs`.
 */
export async function recordSmsLog({
  scheduleId = null,
  dutyDate = null,
  dutyTime = null,
  recipientName,
  role,
  phoneNumber,
  triggerType,
  message,
  ok,
  apiResponse,
}) {
  const uid = auth.currentUser?.uid || 'system';
  const rawFallback = String(phoneNumber || '').trim();
  const normalized =
    normalizeToE164(phoneNumber) ||
    (rawFallback.length >= 10 ? rawFallback : `Invalid (${rawFallback || 'empty'})`);

  await addDoc(collection(db, 'sms_logs'), {
    scheduleId: scheduleId || null,
    dutyDate: dutyDate || null,
    dutyTime: dutyTime || null,
    recipientName: String(recipientName || 'Unknown').slice(0, 120),
    role: String(role || 'Officer').slice(0, 60),
    phoneNumber: normalized.slice(0, 20),
    triggerType,
    message: String(message || '').slice(0, 2000),
    status: ok ? 'Success' : 'Failed',
    apiResponse: String(apiResponse || '').slice(0, 2000),
    sentAt: serverTimestamp(),
    sentBy: uid,
  });
}

/**
 * Dispatches a schedule's SMS notifications to all 5 recipients (Computer Op,
 * Video Op, Audio Op, Head Deacon, Pastor) and logs each result to Firestore.
 *
 * @param {object} schedule - Schedule object (must include `id`)
 * @param {object} settings - Settings document from `settings/config`
 * @param {'Immediate'|'24h Reminder'|'2h Reminder'|'Manual Resend'} triggerType
 * @returns {Promise<{overallStatus: 'sent'|'partial'|'failed', sentCount: number, failedCount: number, total: number}>}
 */
export async function dispatchScheduleNotifications(schedule, settings, triggerType) {
  const recipients = buildScheduleRecipients(schedule, settings);

  let sentCount = 0;
  let failedCount = 0;
  let lastError = '';

  // Send sequentially with a brief pause to avoid rate limits / device lock on SMS gateways
  for (let i = 0; i < recipients.length; i += 1) {
    const recipient = recipients[i];
    const message = formatSuguanSmsMessage({ schedule, recipient, triggerType });
    const result = await sendSingleSms({
      phone: recipient.phone,
      message,
      settings,
    });

    if (result.ok) {
      sentCount += 1;
    } else {
      failedCount += 1;
      lastError = result.responseText;
    }

    try {
      await recordSmsLog({
        scheduleId: schedule.id || null,
        dutyDate: schedule.dutyDate || null,
        dutyTime: schedule.dutyTime || null,
        recipientName: recipient.name,
        role: recipient.role,
        phoneNumber: recipient.phone,
        triggerType,
        message,
        ok: result.ok,
        apiResponse: result.responseText,
      });
    } catch (logErr) {
      console.error('Failed to write sms_logs entry:', logErr);
    }

    if (i < recipients.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  let overallStatus = 'failed';
  if (sentCount > 0 && failedCount === 0) overallStatus = 'sent';
  else if (sentCount > 0 && failedCount > 0) overallStatus = 'partial';

  return {
    overallStatus,
    sentCount,
    failedCount,
    total: recipients.length,
    lastError,
  };
}

/**
 * Sends a single Test SMS from the System Settings page and logs it.
 */
export async function sendTestSms({ testPhone, settings }) {
  const message =
    '[TSV SUGUAN SYSTEM TEST]\nThis is a connectivity test message from the TSV Suguan Monitoring and Reminder System via SabayKonekta SMS Gateway.';

  const result = await sendSingleSms({
    phone: testPhone,
    message,
    settings,
  });

  try {
    await recordSmsLog({
      scheduleId: null,
      dutyDate: null,
      dutyTime: null,
      recipientName: 'System Test Recipient',
      role: 'Test Recipient',
      phoneNumber: testPhone,
      triggerType: 'Test SMS',
      message,
      ok: result.ok,
      apiResponse: result.responseText,
    });
  } catch (logErr) {
    console.error('Failed to record Test SMS log:', logErr);
  }

  return result;
}

/**
 * ============================================================================
 * Main Application Controller
 * TSV Suguan Monitoring and Reminder System
 * ============================================================================
 */

import {
  auth,
  db,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
} from './firebase-config.js';
import { initAuth } from './auth.js';
import {
  normalizeToE164,
  formatPhMobileDisplay,
  bindPhPhoneInput,
} from './phone-utils.js';
import {
  DEFAULT_SMS_API_URL,
  dispatchScheduleNotifications,
  sendTestSms,
} from './sms-service.js';
import {
  startBackgroundScheduler,
  stopBackgroundScheduler,
  runReminderCheck,
} from './scheduler.js';
import {
  escapeHtml,
  buildManilaDate,
  formatManilaDate,
  formatManilaTime,
  formatManilaDateTime,
  toJsDate,
  initAccessibleFormValidation,
  initDialogLightDismissFallback,
  showToast,
} from './ui-helpers.js';

// ----------------------------------------------------------------------------
// Application State
// ----------------------------------------------------------------------------

const state = {
  user: null,
  schedules: [],
  smsLogs: [],
  settings: {
    smsApiUrl: DEFAULT_SMS_API_URL,
    smsApiKey: '',
    smsDeviceId: '',
    pastorName: '',
    pastorPhone: '',
  },
  scheduleFilter: 'upcoming', // 'upcoming' | 'past' | 'all'
  scheduleSearch: '',
  logStatusFilter: 'all',
  logTriggerFilter: 'all',
  logSearch: '',
  editingScheduleId: null,
  pendingDeleteId: null,
  pendingResendId: null,
  unsubscribers: [],
};

// ----------------------------------------------------------------------------
// Initialization
// ----------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  initAccessibleFormValidation();
  initDialogLightDismissFallback();
  initNavigationTabs();
  initScheduleForm();
  initScheduleFilters();
  initSettingsForms();
  initLogFilters();
  initModals();

  initAuth({
    onAuthenticated: (user) => {
      state.user = user;
      subscribeToFirestore();
      startBackgroundScheduler(
        () => state.schedules,
        () => state.settings,
        (statusText) => {
          const el = document.getElementById('scheduler-status-text');
          if (el) el.textContent = statusText;
        }
      );
    },
    onSignedOut: () => {
      state.user = null;
      unsubscribeAll();
      stopBackgroundScheduler();
      state.schedules = [];
      state.smsLogs = [];
      renderSchedules();
      renderSmsLogs();
      updateDashboardStats();
    },
  });
});

// ----------------------------------------------------------------------------
// Firestore Real-Time Subscriptions
// ----------------------------------------------------------------------------

function unsubscribeAll() {
  state.unsubscribers.forEach((unsub) => {
    try {
      unsub();
    } catch {
      // ignore
    }
  });
  state.unsubscribers = [];
}

function subscribeToFirestore() {
  unsubscribeAll();

  // 1. Schedules (sorted chronologically by dutyTimestamp)
  const schedulesQuery = query(
    collection(db, 'schedules'),
    orderBy('dutyTimestamp', 'asc')
  );
  const unsubSchedules = onSnapshot(
    schedulesQuery,
    (snapshot) => {
      state.schedules = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderSchedules();
      updateDashboardStats();
    },
    (err) => {
      console.error('Schedules listener error:', err);
      showToast(`Unable to load schedules: ${err.message}`, 'error');
    }
  );

  // 2. System Settings (`settings/config`)
  const settingsRef = doc(db, 'settings', 'config');
  const unsubSettings = onSnapshot(
    settingsRef,
    (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        state.settings = {
          smsApiUrl: data.smsApiUrl || DEFAULT_SMS_API_URL,
          smsApiKey: data.smsApiKey || '',
          smsDeviceId: data.smsDeviceId || '',
          pastorName: data.pastorName || '',
          pastorPhone: data.pastorPhone || '',
        };
      } else {
        state.settings = {
          smsApiUrl: DEFAULT_SMS_API_URL,
          smsApiKey: '',
          smsDeviceId: '',
          pastorName: '',
          pastorPhone: '',
        };
      }
      populateSettingsForm();
      updateConfigWarningBanner();
    },
    (err) => {
      console.error('Settings listener error:', err);
    }
  );

  // 3. SMS Logs (latest 250 entries)
  const logsQuery = query(
    collection(db, 'sms_logs'),
    orderBy('sentAt', 'desc'),
    limit(250)
  );
  const unsubLogs = onSnapshot(
    logsQuery,
    (snapshot) => {
      state.smsLogs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderSmsLogs();
      updateDashboardStats();
    },
    (err) => {
      console.error('SMS Logs listener error:', err);
    }
  );

  state.unsubscribers.push(unsubSchedules, unsubSettings, unsubLogs);
}

// ----------------------------------------------------------------------------
// Dashboard Navigation Tabs (Synced between Desktop Top Tabs & Mobile Bottom Bar)
// ----------------------------------------------------------------------------

function activateTab(tabName) {
  const allTabs = document.querySelectorAll('[data-tab]');
  const panels = document.querySelectorAll('.tab-panel');

  allTabs.forEach((btn) => {
    const isSelected = btn.dataset.tab === tabName;
    btn.setAttribute('aria-selected', String(isSelected));
  });
  panels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `panel-${tabName}`);
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function initNavigationTabs() {
  const allTabs = document.querySelectorAll('[data-tab]');

  allTabs.forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  // Quick "+ New" button on Schedules screen opens fresh Encode view
  document.getElementById('quick-new-schedule-btn')?.addEventListener('click', () => {
    resetScheduleForm();
    activateTab('encode');
  });

  // Quick-jump button from config warning banner to Settings tab
  document.getElementById('goto-settings-btn')?.addEventListener('click', () => {
    activateTab('settings');
  });

  // Manual "Check Reminders Now" trigger
  document.getElementById('check-reminders-now-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    await runReminderCheck(
      () => state.schedules,
      () => state.settings,
      (statusText) => {
        const el = document.getElementById('scheduler-status-text');
        if (el) el.textContent = statusText;
      }
    );
    btn.disabled = false;
    showToast('Reminder check completed.', 'info', 3000);
  });
}

function updateConfigWarningBanner() {
  const banner = document.getElementById('settings-warning-banner');
  if (!banner) return;
  const missingApiKey = !state.settings.smsApiKey?.trim();
  const missingPastor = !state.settings.pastorPhone?.trim();
  if (missingApiKey || missingPastor) {
    const reasons = [];
    if (missingApiKey) reasons.push('SabayKonekta SMS API Key');
    if (missingPastor) reasons.push("Pastor's Mobile Number");
    const msgEl = document.getElementById('settings-warning-text');
    if (msgEl) {
      msgEl.textContent = `Incomplete System Settings: ${reasons.join(' and ')} not configured yet. Automated SMS alerts require these details.`;
    }
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function updateDashboardStats() {
  const now = Date.now();
  const upcomingCount = state.schedules.filter((s) => {
    const d = toJsDate(s.dutyTimestamp);
    return d && d.getTime() >= now;
  }).length;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const sentToday = state.smsLogs.filter((l) => {
    const d = toJsDate(l.sentAt);
    return l.status === 'Success' && d && d.getTime() >= startOfToday.getTime();
  }).length;

  const failedTotal = state.smsLogs.filter((l) => l.status === 'Failed').length;

  const setStat = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val);
  };

  setStat('stat-upcoming', upcomingCount);
  setStat('stat-total-schedules', state.schedules.length);
  setStat('stat-sms-today', sentToday);
  setStat('stat-sms-failed', failedTotal);
}

// ----------------------------------------------------------------------------
// Suguan Schedule Form (Create & Edit)
// ----------------------------------------------------------------------------

function initScheduleForm() {
  const form = document.getElementById('schedule-form');
  const cancelEditBtn = document.getElementById('cancel-edit-btn');

  // Bind Philippine mobile validation & normalization to all 4 phone inputs
  ['comp-phone', 'video-phone', 'audio-phone', 'deacon-phone'].forEach((id) => {
    bindPhPhoneInput(document.getElementById(id));
  });

  cancelEditBtn?.addEventListener('click', () => {
    resetScheduleForm();
    activateTab('schedules');
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;

    const dutyDate = document.getElementById('duty-date').value;
    const dutyTime = document.getElementById('duty-time').value;
    const serviceName = document.getElementById('service-name').value.trim() || 'Worship Service';

    const compPhone = normalizeToE164(document.getElementById('comp-phone').value);
    const videoPhoneRaw = document.getElementById('video-phone').value.trim();
    const audioPhoneRaw = document.getElementById('audio-phone').value.trim();
    const videoPhone = videoPhoneRaw ? normalizeToE164(videoPhoneRaw) : '';
    const audioPhone = audioPhoneRaw ? normalizeToE164(audioPhoneRaw) : '';
    const deaconPhone = normalizeToE164(document.getElementById('deacon-phone').value);

    if (!compPhone || !deaconPhone || (videoPhoneRaw && !videoPhone) || (audioPhoneRaw && !audioPhone)) {
      showToast('Please ensure all entered mobile numbers are valid Philippine numbers (09XXXXXXXXX or +639XXXXXXXXX).', 'error');
      return;
    }

    const dutyDateObj = buildManilaDate(dutyDate, dutyTime);
    if (Number.isNaN(dutyDateObj.getTime())) {
      showToast('Invalid Duty Date or Time.', 'error');
      return;
    }

    const officers = {
      computerOperator: {
        name: document.getElementById('comp-name').value.trim(),
        phone: compPhone,
      },
      videoOperator: {
        name: document.getElementById('video-name').value.trim(),
        phone: videoPhone,
      },
      audioOperator: {
        name: document.getElementById('audio-name').value.trim(),
        phone: audioPhone,
      },
      headDeacon: {
        name: document.getElementById('deacon-name').value.trim(),
        phone: deaconPhone,
      },
    };

    const submitBtn = document.getElementById('schedule-submit-btn');
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = state.editingScheduleId ? 'Updating Schedule...' : 'Saving & Sending SMS...';

    try {
      if (state.editingScheduleId) {
        const existing = state.schedules.find((s) => s.id === state.editingScheduleId);
        const existingNotifs = existing?.notifications || {
          immediateStatus: 'pending',
          immediateSentAt: null,
          reminder24hSent: false,
          reminder24hStatus: 'pending',
          reminder24hSentAt: null,
          reminder2hSent: false,
          reminder2hStatus: 'pending',
          reminder2hSentAt: null,
        };

        const resendOnEdit = document.getElementById('resend-on-edit-checkbox')?.checked;
        const scheduleRef = doc(db, 'schedules', state.editingScheduleId);

        await updateDoc(scheduleRef, {
          dutyDate,
          dutyTime,
          dutyTimestamp: Timestamp.fromDate(dutyDateObj),
          serviceName,
          officers,
          notifications: existingNotifs,
          updatedAt: serverTimestamp(),
        });

        if (resendOnEdit) {
          const updatedSchedule = {
            id: state.editingScheduleId,
            dutyDate,
            dutyTime,
            dutyTimestamp: Timestamp.fromDate(dutyDateObj),
            serviceName,
            officers,
          };
          const smsRes = await dispatchScheduleNotifications(
            updatedSchedule,
            state.settings,
            'Manual Resend'
          );
          await updateDoc(scheduleRef, {
            'notifications.immediateStatus': smsRes.overallStatus,
            'notifications.immediateSentAt': serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          showToast(
            `Schedule updated & SMS resent (${smsRes.sentCount}/${smsRes.total} delivered).`,
            smsRes.overallStatus === 'sent' ? 'success' : 'warning'
          );
        } else {
          showToast('Duty schedule updated successfully.', 'success');
        }

        resetScheduleForm();
        activateTab('schedules');
      } else {
        // Create new schedule
        const newDocPayload = {
          dutyDate,
          dutyTime,
          dutyTimestamp: Timestamp.fromDate(dutyDateObj),
          serviceName,
          officers,
          notifications: {
            immediateStatus: 'pending',
            immediateSentAt: null,
            reminder24hSent: false,
            reminder24hStatus: 'pending',
            reminder24hSentAt: null,
            reminder2hSent: false,
            reminder2hStatus: 'pending',
            reminder2hSentAt: null,
          },
          createdBy: auth.currentUser.uid,
          createdByEmail: auth.currentUser.email || auth.currentUser.phoneNumber || 'TSV Lead',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };

        const docRef = await addDoc(collection(db, 'schedules'), newDocPayload);

        // Trigger 1: Immediate SMS Alert to all 5 recipients
        const smsRes = await dispatchScheduleNotifications(
          { id: docRef.id, ...newDocPayload },
          state.settings,
          'Immediate'
        );

        await updateDoc(docRef, {
          'notifications.immediateStatus': smsRes.overallStatus,
          'notifications.immediateSentAt': serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        showToast(
          `Schedule saved! Immediate SMS alert: ${smsRes.sentCount}/${smsRes.total} sent.`,
          smsRes.overallStatus === 'sent' ? 'success' : 'warning'
        );

        resetScheduleForm();
        activateTab('schedules');
      }
    } catch (err) {
      console.error('Save schedule error:', err);
      showToast(`Failed to save schedule: ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = state.editingScheduleId ? 'Update Schedule' : 'Save Schedule & Send Alert';
    }
  });
}

function resetScheduleForm() {
  const form = document.getElementById('schedule-form');
  form?.reset();
  state.editingScheduleId = null;

  const titleEl = document.getElementById('schedule-form-title');
  const submitBtn = document.getElementById('schedule-submit-btn');
  const cancelBtn = document.getElementById('cancel-edit-btn');
  const resendWrap = document.getElementById('resend-on-edit-wrapper');

  if (titleEl) titleEl.textContent = 'Encode New Suguan Schedule';
  if (submitBtn) submitBtn.textContent = 'Save Schedule & Send Alert';
  cancelBtn?.classList.add('hidden');
  resendWrap?.classList.add('hidden');
}

function startEditingSchedule(scheduleId) {
  const schedule = state.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return;

  state.editingScheduleId = scheduleId;
  document.getElementById('duty-date').value = schedule.dutyDate || '';
  document.getElementById('duty-time').value = schedule.dutyTime || '';
  document.getElementById('service-name').value = schedule.serviceName || 'Worship Service';

  document.getElementById('comp-name').value = schedule.officers?.computerOperator?.name || '';
  document.getElementById('comp-phone').value = schedule.officers?.computerOperator?.phone || '';
  document.getElementById('video-name').value = schedule.officers?.videoOperator?.name || '';
  document.getElementById('video-phone').value = schedule.officers?.videoOperator?.phone || '';
  document.getElementById('audio-name').value = schedule.officers?.audioOperator?.name || '';
  document.getElementById('audio-phone').value = schedule.officers?.audioOperator?.phone || '';
  document.getElementById('deacon-name').value = schedule.officers?.headDeacon?.name || '';
  document.getElementById('deacon-phone').value = schedule.officers?.headDeacon?.phone || '';

  const titleEl = document.getElementById('schedule-form-title');
  const submitBtn = document.getElementById('schedule-submit-btn');
  const cancelBtn = document.getElementById('cancel-edit-btn');
  const resendWrap = document.getElementById('resend-on-edit-wrapper');

  if (titleEl) titleEl.textContent = `Edit Suguan (${schedule.dutyDate})`;
  if (submitBtn) submitBtn.textContent = 'Update Schedule';
  cancelBtn?.classList.remove('hidden');
  resendWrap?.classList.remove('hidden');

  activateTab('encode');
}

// ----------------------------------------------------------------------------
// Schedule List Rendering & Filtering
// ----------------------------------------------------------------------------

function initScheduleFilters() {
  document.querySelectorAll('.schedule-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.scheduleFilter = btn.dataset.filter;
      document.querySelectorAll('.schedule-filter-btn').forEach((b) => {
        const active = b.dataset.filter === state.scheduleFilter;
        b.classList.toggle('bg-slate-900', active);
        b.classList.toggle('text-white', active);
        b.classList.toggle('bg-white', !active);
        b.classList.toggle('text-slate-600', !active);
      });
      renderSchedules();
    });
  });

  document.getElementById('schedule-search-input')?.addEventListener('input', (e) => {
    state.scheduleSearch = e.target.value.trim().toLowerCase();
    renderSchedules();
  });

  // Event delegation for Edit, Resend, Delete buttons on schedule cards
  document.getElementById('schedules-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === 'edit') startEditingSchedule(id);
    else if (action === 'resend') openResendDialog(id);
    else if (action === 'delete') openDeleteDialog(id);
  });
}

function renderStatusBadge(label, status) {
  const normalized = (status || 'pending').toLowerCase();
  let cls = 'bg-amber-50 text-amber-800 border-amber-200';
  let dot = 'bg-amber-500';
  let text = 'Pending';

  if (normalized === 'sent') {
    cls = 'bg-emerald-50 text-emerald-800 border-emerald-200';
    dot = 'bg-emerald-500';
    text = 'Sent';
  } else if (normalized === 'partial') {
    cls = 'bg-sky-50 text-sky-800 border-sky-200';
    dot = 'bg-sky-500';
    text = 'Partial';
  } else if (normalized === 'failed') {
    cls = 'bg-rose-50 text-rose-800 border-rose-200';
    dot = 'bg-rose-500';
    text = 'Failed';
  }

  return `
    <span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}">
      <span class="h-1.5 w-1.5 rounded-full ${dot}" aria-hidden="true"></span>
      <span>${escapeHtml(label)}: ${text}</span>
    </span>
  `;
}

function renderSchedules() {
  const container = document.getElementById('schedules-list');
  if (!container) return;

  const nowMs = Date.now();
  const q = state.scheduleSearch;

  const filtered = state.schedules.filter((s) => {
    const dutyDateObj = toJsDate(s.dutyTimestamp);
    const isPast = dutyDateObj ? dutyDateObj.getTime() < nowMs : false;

    if (state.scheduleFilter === 'upcoming' && isPast) return false;
    if (state.scheduleFilter === 'past' && !isPast) return false;

    if (q) {
      const hay = [
        s.dutyDate,
        s.serviceName,
        s.officers?.computerOperator?.name,
        s.officers?.videoOperator?.name,
        s.officers?.audioOperator?.name,
        s.officers?.headDeacon?.name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });

  // Sort past schedules newest-first; upcoming soonest-first
  if (state.scheduleFilter === 'past') {
    filtered.sort((a, b) => (toJsDate(b.dutyTimestamp)?.getTime() || 0) - (toJsDate(a.dutyTimestamp)?.getTime() || 0));
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <p class="text-sm font-medium text-slate-700">No duty schedules found</p>
        <p class="mt-1 text-xs text-slate-500">
          ${state.scheduleSearch ? 'Try clearing your search filter.' : 'Encode a new Suguan schedule using the form to get started.'}
        </p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((s) => {
      const dutyDateObj = toJsDate(s.dutyTimestamp);
      const isPast = dutyDateObj ? dutyDateObj.getTime() < nowMs : false;
      const o = s.officers || {};
      const n = s.notifications || {};

      return `
        <article class="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-xs transition hover:border-slate-300">
          <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-base font-semibold text-slate-900">
                  ${escapeHtml(formatManilaDate(s.dutyTimestamp))} &bull; ${escapeHtml(formatManilaTime(s.dutyTimestamp))}
                </h3>
                <span class="rounded-md px-2 py-0.5 text-xs font-medium ${
                  isPast ? 'bg-slate-100 text-slate-600' : 'bg-blue-50 text-blue-700'
                }">
                  ${isPast ? 'Completed' : 'Upcoming'}
                </span>
              </div>
              <p class="mt-0.5 text-xs text-slate-500">${escapeHtml(s.serviceName || 'Worship Service')}</p>
            </div>

            <div class="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-action="resend"
                data-id="${escapeHtml(s.id)}"
                class="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                Resend SMS
              </button>
              <button
                type="button"
                data-action="edit"
                data-id="${escapeHtml(s.id)}"
                class="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                Edit
              </button>
              <button
                type="button"
                data-action="delete"
                data-id="${escapeHtml(s.id)}"
                class="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-600"
              >
                Delete
              </button>
            </div>
          </div>

          <div class="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            ${renderOfficerRow('Computer Operator', o.computerOperator)}
            ${renderOfficerRow('Video Operator', o.videoOperator)}
            ${renderOfficerRow('Audio Operator', o.audioOperator)}
            ${renderOfficerRow('Head Deacon (P. Diakono)', o.headDeacon)}
          </div>

          <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            ${renderStatusBadge('Immediate', n.immediateStatus)}
            ${renderStatusBadge('24h Reminder', n.reminder24hStatus)}
            ${renderStatusBadge('2h Reminder', n.reminder2hStatus)}
          </div>
        </article>
      `;
    })
    .join('');
}

function renderOfficerRow(roleLabel, person) {
  const hasName = Boolean(person?.name?.trim());
  const hasPhone = Boolean(person?.phone?.trim());
  return `
    <div class="rounded-lg bg-slate-50 px-3 py-2 border border-slate-100">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">${escapeHtml(roleLabel)}</div>
      <div class="mt-0.5 text-sm font-medium ${hasName ? 'text-slate-900' : 'text-slate-400 italic'}">${escapeHtml(hasName ? person.name : 'Not assigned')}</div>
      <div class="text-xs font-mono text-slate-600">${hasPhone ? escapeHtml(formatPhMobileDisplay(person.phone)) : '<span class="text-slate-400 font-sans">—</span>'}</div>
    </div>
  `;
}

// ----------------------------------------------------------------------------
// Native <dialog> Modals (Delete Confirm, Resend SMS, Log Details)
// ----------------------------------------------------------------------------

function initModals() {
  // 1. Delete Confirmation Dialog
  const deleteDialog = document.getElementById('delete-dialog');
  deleteDialog?.addEventListener('close', async () => {
    const choice = deleteDialog.returnValue;
    deleteDialog.returnValue = ''; // Reset to prevent stale value leak
    const targetId = state.pendingDeleteId;
    state.pendingDeleteId = null;

    if (choice === 'delete' && targetId) {
      try {
        await deleteDoc(doc(db, 'schedules', targetId));
        if (state.editingScheduleId === targetId) resetScheduleForm();
        showToast('Duty schedule deleted.', 'info');
      } catch (err) {
        showToast(`Delete failed: ${err.message}`, 'error');
      }
    }
  });

  // 2. Resend SMS Dialog
  const resendDialog = document.getElementById('resend-dialog');
  const resendForm = document.getElementById('resend-sms-form');
  resendForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const targetId = state.pendingResendId;
    const schedule = state.schedules.find((s) => s.id === targetId);
    if (!schedule) {
      resendDialog.close();
      return;
    }

    const triggerType = document.getElementById('resend-trigger-select').value;
    const btn = document.getElementById('confirm-resend-btn');
    btn.disabled = true;
    btn.textContent = 'Sending SMS...';

    try {
      const res = await dispatchScheduleNotifications(schedule, state.settings, triggerType);
      const updates = { updatedAt: serverTimestamp() };
      if (triggerType === 'Immediate' || triggerType === 'Manual Resend') {
        updates['notifications.immediateStatus'] = res.overallStatus;
        updates['notifications.immediateSentAt'] = serverTimestamp();
      } else if (triggerType === '24h Reminder') {
        updates['notifications.reminder24hSent'] = true;
        updates['notifications.reminder24hStatus'] = res.overallStatus;
        updates['notifications.reminder24hSentAt'] = serverTimestamp();
      } else if (triggerType === '2h Reminder') {
        updates['notifications.reminder2hSent'] = true;
        updates['notifications.reminder2hStatus'] = res.overallStatus;
        updates['notifications.reminder2hSentAt'] = serverTimestamp();
      }

      await updateDoc(doc(db, 'schedules', targetId), updates);
      resendDialog.close();
      showToast(
        `${triggerType} dispatched: ${res.sentCount}/${res.total} sent.`,
        res.overallStatus === 'sent' ? 'success' : 'warning'
      );
    } catch (err) {
      showToast(`Resend failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send Now';
    }
  });

  resendDialog?.addEventListener('close', () => {
    resendDialog.returnValue = '';
    state.pendingResendId = null;
  });

  // 3. Log Details Dialog
  const logDialog = document.getElementById('log-details-dialog');
  logDialog?.addEventListener('close', () => {
    logDialog.returnValue = '';
  });
}

function openDeleteDialog(scheduleId) {
  const schedule = state.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return;
  state.pendingDeleteId = scheduleId;
  const desc = document.getElementById('delete-dialog-desc');
  if (desc) {
    desc.textContent = `Are you sure you want to permanently delete the Suguan schedule for ${formatManilaDate(schedule.dutyTimestamp)} at ${formatManilaTime(schedule.dutyTimestamp)}?`;
  }
  document.getElementById('delete-dialog')?.showModal();
}

function openResendDialog(scheduleId) {
  const schedule = state.schedules.find((s) => s.id === scheduleId);
  if (!schedule) return;
  state.pendingResendId = scheduleId;
  const info = document.getElementById('resend-dialog-info');
  if (info) {
    info.textContent = `Schedule: ${formatManilaDate(schedule.dutyTimestamp)} • ${formatManilaTime(schedule.dutyTimestamp)} (${schedule.serviceName || 'Worship Service'})`;
  }
  document.getElementById('resend-dialog')?.showModal();
}

function openLogDetailsDialog(logId) {
  const log = state.smsLogs.find((l) => l.id === logId);
  if (!log) return;

  document.getElementById('log-detail-meta').textContent =
    `${log.recipientName} (${log.role}) • ${formatPhMobileDisplay(log.phoneNumber)} • ${log.triggerType} • ${log.status}`;
  document.getElementById('log-detail-message').textContent = log.message || '(empty)';
  document.getElementById('log-detail-response').textContent = log.apiResponse || 'No response recorded.';
  document.getElementById('log-details-dialog')?.showModal();
}

// ----------------------------------------------------------------------------
// System Settings Page (`settings/config`) & Test SMS
// ----------------------------------------------------------------------------

function initSettingsForms() {
  bindPhPhoneInput(document.getElementById('settings-pastor-phone'));
  bindPhPhoneInput(document.getElementById('test-sms-phone'));

  // Toggle API Key visibility
  const toggleApiKeyBtn = document.getElementById('toggle-apikey-btn');
  const apiKeyInput = document.getElementById('settings-api-key');
  toggleApiKeyBtn?.addEventListener('click', () => {
    const isHidden = apiKeyInput.type === 'password';
    apiKeyInput.type = isHidden ? 'text' : 'password';
    toggleApiKeyBtn.textContent = isHidden ? 'Hide' : 'Show';
  });

  // Save Settings Form
  const settingsForm = document.getElementById('settings-form');
  settingsForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!settingsForm.reportValidity()) return;

    const pastorPhoneRaw = document.getElementById('settings-pastor-phone').value.trim();
    const pastorPhoneNormalized = pastorPhoneRaw ? normalizeToE164(pastorPhoneRaw) : '';
    if (pastorPhoneRaw && !pastorPhoneNormalized) {
      showToast('Please enter a valid Philippine mobile number for the Pastor.', 'error');
      return;
    }

    const saveBtn = document.getElementById('save-settings-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const payload = {
        smsApiUrl: document.getElementById('settings-api-url').value.trim() || DEFAULT_SMS_API_URL,
        smsApiKey: document.getElementById('settings-api-key').value.trim(),
        smsDeviceId: document.getElementById('settings-device-id').value.trim(),
        pastorName: document.getElementById('settings-pastor-name').value.trim(),
        pastorPhone: pastorPhoneNormalized || '',
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.uid,
      };

      await setDoc(doc(db, 'settings', 'config'), payload, { merge: true });
      showToast('System settings saved to Firestore.', 'success');
    } catch (err) {
      console.error('Save settings error:', err);
      showToast(`Failed to save settings: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save System Settings';
    }
  });

  // Test SMS Form
  const testSmsForm = document.getElementById('test-sms-form');
  const testResultBox = document.getElementById('test-sms-result');
  testSmsForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!testSmsForm.reportValidity()) return;

    const testPhone = normalizeToE164(document.getElementById('test-sms-phone').value);
    if (!testPhone) {
      showToast('Enter a valid Philippine mobile number for Test SMS.', 'error');
      return;
    }

    const testBtn = document.getElementById('send-test-sms-btn');
    testBtn.disabled = true;
    testBtn.textContent = 'Sending Test SMS...';

    // Use currently typed values in settings inputs so user can test before/after saving
    const activeSettings = {
      smsApiUrl: document.getElementById('settings-api-url').value.trim() || DEFAULT_SMS_API_URL,
      smsApiKey: document.getElementById('settings-api-key').value.trim(),
      smsDeviceId: document.getElementById('settings-device-id').value.trim(),
    };

    const result = await sendTestSms({ testPhone, settings: activeSettings });

    if (testResultBox) {
      testResultBox.classList.remove('hidden', 'bg-emerald-50', 'border-emerald-200', 'text-emerald-800', 'bg-rose-50', 'border-rose-200', 'text-rose-800');
      if (result.ok) {
        testResultBox.classList.add('bg-emerald-50', 'border-emerald-200', 'text-emerald-800');
        testResultBox.textContent = `Success — ${result.responseText}`;
      } else {
        testResultBox.classList.add('bg-rose-50', 'border-rose-200', 'text-rose-800');
        testResultBox.textContent = `Failed — ${result.responseText}`;
      }
    }

    showToast(
      result.ok ? `Test SMS sent to ${testPhone}!` : 'Test SMS failed. Check API response details.',
      result.ok ? 'success' : 'error'
    );

    testBtn.disabled = false;
    testBtn.textContent = 'Send Test SMS';
  });
}

function populateSettingsForm() {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) {
      el.value = val ?? '';
    }
  };

  setVal('settings-api-url', state.settings.smsApiUrl || DEFAULT_SMS_API_URL);
  setVal('settings-api-key', state.settings.smsApiKey || '');
  setVal('settings-device-id', state.settings.smsDeviceId || '');
  setVal('settings-pastor-name', state.settings.pastorName || '');
  setVal('settings-pastor-phone', state.settings.pastorPhone || '');
}

// ----------------------------------------------------------------------------
// SMS Logs / History Tab
// ----------------------------------------------------------------------------

function initLogFilters() {
  document.getElementById('log-status-filter')?.addEventListener('change', (e) => {
    state.logStatusFilter = e.target.value;
    renderSmsLogs();
  });

  document.getElementById('log-trigger-filter')?.addEventListener('change', (e) => {
    state.logTriggerFilter = e.target.value;
    renderSmsLogs();
  });

  document.getElementById('log-search-input')?.addEventListener('input', (e) => {
    state.logSearch = e.target.value.trim().toLowerCase();
    renderSmsLogs();
  });

  document.getElementById('sms-logs-tbody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-log-id]');
    if (btn) openLogDetailsDialog(btn.dataset.logId);
  });
}

function renderSmsLogs() {
  const tbody = document.getElementById('sms-logs-tbody');
  if (!tbody) return;

  const filtered = state.smsLogs.filter((log) => {
    if (state.logStatusFilter !== 'all' && log.status !== state.logStatusFilter) return false;
    if (state.logTriggerFilter !== 'all' && log.triggerType !== state.logTriggerFilter) return false;
    if (state.logSearch) {
      const hay = `${log.recipientName} ${log.role} ${log.phoneNumber} ${log.triggerType} ${log.apiResponse}`.toLowerCase();
      if (!hay.includes(state.logSearch)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-10 text-center text-sm text-slate-500">
          No SMS log entries match your current filter.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered
    .map((log) => {
      const isOk = log.status === 'Success';
      const statusBadge = isOk
        ? '<span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">Success</span>'
        : '<span class="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700 border border-rose-200">Failed</span>';

      return `
        <tr>
          <th scope="row">${escapeHtml(formatManilaDateTime(log.sentAt))}</th>
          <td class="font-medium text-slate-900">${escapeHtml(log.recipientName)}</td>
          <td class="text-slate-600">${escapeHtml(log.role)}</td>
          <td class="font-mono text-xs text-slate-700">${escapeHtml(formatPhMobileDisplay(log.phoneNumber))}</td>
          <td>
            <span class="inline-block rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              ${escapeHtml(log.triggerType)}
            </span>
          </td>
          <td>${statusBadge}</td>
          <td>
            <button
              type="button"
              data-log-id="${escapeHtml(log.id)}"
              class="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              View Response
            </button>
          </td>
        </tr>
      `;
    })
    .join('');
}


/**
 * ============================================================================
 * UI Helpers — Accessibility, Form Validation Sync, Popover Toasts & Dialogs
 * Implements modern web best practices (popover="manual", ariaNotify fallback,
 * :user-invalid ARIA sync, native <dialog> light-dismiss fallback).
 * ============================================================================
 */

// Conditionally load Popover polyfill only when native support is missing
if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {
    // Graceful degradation if offline
  });
}

// ----------------------------------------------------------------------------
// HTML Escaping & Date/Time Formatting (Asia/Manila)
// ----------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/**
 * Combines YYYY-MM-DD and HH:mm into a JS Date interpreted in Asia/Manila (+08:00).
 * @param {string} dateStr
 * @param {string} timeStr
 * @returns {Date}
 */
export function buildManilaDate(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00+08:00`);
}

/**
 * Formats a Date or Firestore Timestamp into readable Philippine date (e.g., Sun, Nov 22, 2026).
 */
export function formatManilaDate(dateOrTs) {
  const date = toJsDate(dateOrTs);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/**
 * Formats a Date or Firestore Timestamp into readable 12-hour time (e.g., 6:00 AM).
 */
export function formatManilaTime(dateOrTs) {
  const date = toJsDate(dateOrTs);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * Formats a Date or Firestore Timestamp into compact date + time for logs.
 */
export function formatManilaDateTime(dateOrTs) {
  const date = toJsDate(dateOrTs);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export function toJsDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ----------------------------------------------------------------------------
// ARIA Validation Sync for :user-invalid (with Fallback for Older Browsers)
// ----------------------------------------------------------------------------

export function initAccessibleFormValidation() {
  const supportsUserInvalid = CSS.supports('selector(:user-invalid)');
  const dirtyState = new WeakMap();
  const flagged = new WeakSet();
  const announced = new WeakSet();

  const announcer = document.createElement('div');
  announcer.setAttribute('aria-live', 'polite');
  announcer.classList.add('visually-hidden');
  document.body.append(announcer);

  let announceTimer;
  let announcedField;

  const linkError = (el, shown) => {
    const errorId = el.dataset?.error;
    if (!errorId) return;
    const ids = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  };

  const spokenText = (node) => {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    copy
      .querySelectorAll('[role="img"][aria-label]')
      .forEach((n) => n.replaceWith(`${n.getAttribute('aria-label')}: `));
    return copy.textContent.replace(/\s+/g, ' ').trim();
  };

  const announceError = (el) => {
    const error = document.getElementById(el.dataset.error);
    if (!error) return;
    const label = el.labels?.[0] ? `${spokenText(el.labels[0])}: ` : '';
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announcedField = el;
    announceTimer = setTimeout(() => {
      announcer.textContent = label + spokenText(error);
    }, 500);
  };

  const syncAria = (el, announce = false) => {
    if (!el || !el.matches?.('input, select, textarea')) return;

    let invalid = false;
    if (supportsUserInvalid) {
      invalid = el.matches(':user-invalid');
    } else {
      const state = dirtyState.get(el);
      invalid = Boolean(state?.hasBlurred && !el.validity.valid);
      el.classList.toggle('user-invalid-fallback', invalid);
      el.classList.toggle('user-valid-fallback', Boolean(state?.hasBlurred && el.validity.valid));
    }

    if (invalid) {
      if (announce && !announced.has(el)) {
        announceError(el);
        announced.add(el);
      }
      el.setAttribute('aria-invalid', 'true');
      linkError(el, true);
      flagged.add(el);
    } else if (flagged.has(el) || el.getAttribute('aria-invalid') !== 'true') {
      el.setAttribute('aria-invalid', 'false');
      linkError(el, false);
      flagged.delete(el);
      announced.delete(el);
      if (announcedField === el) {
        clearTimeout(announceTimer);
        announcer.textContent = '';
      }
    }
  };

  document.querySelectorAll('input, select, textarea').forEach((el) => syncAria(el));

  document.addEventListener(
    'blur',
    (e) => {
      const target = e.target;
      if (!target.matches?.('input, select, textarea')) return;
      const state = dirtyState.get(target) || { hasInteracted: false, hasBlurred: false };
      state.hasBlurred = true;
      dirtyState.set(target, state);
      syncAria(target, true);
    },
    true
  );

  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!target.matches?.('input, select, textarea')) return;
    const state = dirtyState.get(target) || { hasInteracted: false, hasBlurred: false };
    state.hasInteracted = true;
    dirtyState.set(target, state);
    if (target.hasAttribute('aria-invalid')) syncAria(target);
  });

  document.addEventListener('change', (e) => syncAria(e.target, true), true);

  document.addEventListener(
    'invalid',
    (e) => {
      const target = e.target;
      dirtyState.set(target, { hasInteracted: true, hasBlurred: true });
      announced.add(target);
      syncAria(target);
    },
    true
  );

  document.addEventListener(
    'reset',
    (e) => {
      const form = e.target;
      setTimeout(() => {
        [...(form.elements || [])].forEach((el) => {
          dirtyState.delete(el);
          el.classList?.remove('user-invalid-fallback', 'user-valid-fallback');
          syncAria(el);
        });
      });
    },
    true
  );
}

// ----------------------------------------------------------------------------
// Native <dialog> Light-Dismiss Fallback (when closedBy is unsupported)
// ----------------------------------------------------------------------------

export function initDialogLightDismissFallback() {
  if ('closedBy' in HTMLDialogElement.prototype) return;

  const isOutside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };

  document.querySelectorAll('dialog[closedby="any"]').forEach((dialog) => {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutside(e, dialog)) {
        dialog.close();
      }
    });
  });
}

// ----------------------------------------------------------------------------
// Accessible Popover Toast Notifications (popover="manual" + ariaNotify)
// ----------------------------------------------------------------------------

const activeToasts = [];
let toastIdCounter = 0;

function repositionToasts() {
  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  let offset = isMobile ? 84 : 16;
  for (let i = activeToasts.length - 1; i >= 0; i -= 1) {
    const el = activeToasts[i];
    el.style.insetBlockEnd = `${offset}px`;
    offset += el.offsetHeight + 10;
  }
}

function announceToast(message) {
  if (typeof document.ariaNotify === 'function') {
    document.ariaNotify(message);
    return;
  }
  const liveEl = document.getElementById('toast-live-announcer');
  if (liveEl) {
    liveEl.textContent = '';
    requestAnimationFrame(() => {
      liveEl.textContent = message;
    });
  }
}

/**
 * Displays a non-intrusive persistent/timed popover toast notification.
 * Suppressed while a modal <dialog> is open to avoid inaccessible background toasts.
 *
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [variant='info']
 * @param {number} [durationMs=5000] Set 0 for persistent until dismissed.
 */
export function showToast(message, variant = 'info', durationMs = 5500) {
  // Never surface background toasts while a modal dialog is open
  if (document.querySelector('dialog:modal')) {
    announceToast(message);
    return;
  }

  const region = document.getElementById('toast-region');
  if (!region) return;

  const toastId = `toast-${++toastIdCounter}`;
  const toast = document.createElement('div');
  toast.id = toastId;
  toast.setAttribute('popover', 'manual');
  toast.className = 'toast-item';
  toast.dataset.variant = variant;

  const textSpan = document.createElement('span');
  textSpan.className = 'text-sm leading-snug flex-1';
  textSpan.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('popovertarget', toastId);
  closeBtn.setAttribute('popovertargetaction', 'hide');
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.className =
    'shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-white/80 hover:text-white hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white';
  closeBtn.textContent = 'Close';

  toast.append(textSpan, closeBtn);
  region.append(toast);

  let timerId = null;

  const removeToast = () => {
    clearTimeout(timerId);
    const idx = activeToasts.indexOf(toast);
    if (idx !== -1) activeToasts.splice(idx, 1);
    const wasFocused = toast.contains(document.activeElement);
    toast.remove();
    repositionToasts();
    if (wasFocused && activeToasts.length > 0) {
      activeToasts[activeToasts.length - 1].querySelector('button')?.focus();
    }
  };

  toast.addEventListener('toggle', (e) => {
    if (e.newState === 'closed') {
      removeToast();
    }
  });

  closeBtn.addEventListener('click', () => {
    if (typeof toast.hidePopover === 'function') {
      try {
        toast.hidePopover();
      } catch {
        removeToast();
      }
    } else {
      removeToast();
    }
  });

  activeToasts.push(toast);
  if (typeof toast.showPopover === 'function') {
    toast.showPopover();
  } else {
    toast.classList.add(':popover-open');
  }
  repositionToasts();
  announceToast(message);

  if (durationMs > 0) {
    const scheduleDismiss = () => {
      timerId = setTimeout(() => {
        // Pause auto-dismiss if user has focus inside the toast
        if (toast.contains(document.activeElement)) {
          toast.addEventListener(
            'focusout',
            () => {
              scheduleDismiss();
            },
            { once: true }
          );
          return;
        }
        if (typeof toast.hidePopover === 'function') {
          try {
            toast.hidePopover();
          } catch {
            removeToast();
          }
        } else {
          removeToast();
        }
      }, durationMs);
    };
    scheduleDismiss();
  }
}


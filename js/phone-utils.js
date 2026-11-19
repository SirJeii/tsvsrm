/**
 * ============================================================================
 * Philippine Mobile Number Validation & Formatting Utilities
 * Accepts: 09XXXXXXXXX, +639XXXXXXXXX, 639XXXXXXXXX, or 9XXXXXXXXX
 * (with optional spaces, dashes, or parentheses)
 * ============================================================================
 */

const PH_MOBILE_REGEX = /^(?:\+?63|0)?(9\d{9})$/;

/**
 * Strips spaces, dashes, parentheses, and dots from raw user input.
 * @param {string} raw
 * @returns {string}
 */
export function cleanPhoneInput(raw) {
  return String(raw || '').replace(/[\s\-().]/g, '').trim();
}

/**
 * Validates whether the given string is a valid Philippine mobile number.
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidPhMobile(raw) {
  const cleaned = cleanPhoneInput(raw);
  return PH_MOBILE_REGEX.test(cleaned);
}

/**
 * Normalizes a valid Philippine mobile number to E.164 format (+639XXXXXXXXX).
 * Required by Firebase Phone Auth and recommended for SMS gateways.
 * Returns null if invalid.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeToE164(raw) {
  const cleaned = cleanPhoneInput(raw);
  const match = cleaned.match(PH_MOBILE_REGEX);
  if (!match) return null;
  return `+63${match[1]}`;
}

/**
 * Converts a valid Philippine mobile number to local 11-digit format (09XXXXXXXXX).
 * Useful for SMS gateways that expect local 09 format.
 * Returns null if invalid.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeToLocal(raw) {
  const cleaned = cleanPhoneInput(raw);
  const match = cleaned.match(PH_MOBILE_REGEX);
  if (!match) return null;
  return `0${match[1]}`;
}

/**
 * Formats a Philippine mobile number for readable display: +63 917 123 4567
 * @param {string} raw
 * @returns {string}
 */
export function formatPhMobileDisplay(raw) {
  const e164 = normalizeToE164(raw);
  if (!e164) return String(raw || '');
  const digits = e164.slice(3); // 9XXXXXXXXX
  return `+63 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

/**
 * Attaches live blur-time formatting and HTML5 custom validity to phone inputs.
 * @param {HTMLInputElement} input
 */
export function bindPhPhoneInput(input) {
  if (!input) return;

  const validate = () => {
    const val = input.value.trim();
    if (!val && !input.required) {
      input.setCustomValidity('');
      return;
    }
    if (!isValidPhMobile(val)) {
      input.setCustomValidity('Enter a valid PH mobile number (09XXXXXXXXX or +639XXXXXXXXX).');
    } else {
      input.setCustomValidity('');
    }
  };

  input.addEventListener('input', validate);
  input.addEventListener('blur', () => {
    const e164 = normalizeToE164(input.value);
    if (e164) {
      input.value = e164;
    }
    validate();
  });
}


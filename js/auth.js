/**
 * ============================================================================
 * Authentication Controller
 * Supports:
 *   1. Email & Password Login (+ Forgot Password reset)
 *   2. Philippine Mobile Number Login via Firebase Phone Auth (SMS OTP)
 *   3. Protected Dashboard Route Guard & Logout
 * ============================================================================
 */

import {
  auth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPhoneNumber,
  RecaptchaVerifier,
  signOut,
  isFirebaseConfigured,
} from './firebase-config.js';
import { normalizeToE164, bindPhPhoneInput } from './phone-utils.js';
import { showToast } from './ui-helpers.js';

let recaptchaVerifier = null;
let confirmationResult = null;

/**
 * Maps Firebase Auth error codes to concise, actionable messages.
 */
function friendlyAuthError(err) {
  const code = err?.code || '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Invalid email or password. Please check your credentials and try again.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/too-many-requests':
      return 'Too many failed attempts. Please wait a few minutes before trying again.';
    case 'auth/invalid-phone-number':
      return 'Please enter a valid Philippine mobile number (09XXXXXXXXX or +639XXXXXXXXX).';
    case 'auth/invalid-verification-code':
      return 'The 6-digit OTP code is incorrect. Please check your SMS and try again.';
    case 'auth/code-expired':
      return 'The verification code has expired. Please request a new OTP.';
    case 'auth/captcha-check-failed':
      return 'reCAPTCHA verification failed. Please refresh and try again.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled in Firebase Console -> Authentication.';
    case 'auth/api-key-not-valid.-please-pass-a-valid-api-key.':
    case 'auth/invalid-api-key':
      return 'Firebase API key is invalid. Update js/firebase-config.js with your project credentials.';
    default:
      return err?.message || 'Authentication failed. Please try again.';
  }
}

/**
 * Initializes invisible reCAPTCHA for Firebase Phone Auth.
 */
function ensureRecaptcha() {
  if (recaptchaVerifier) return recaptchaVerifier;
  recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
    size: 'invisible',
  });
  return recaptchaVerifier;
}

function resetRecaptcha() {
  if (recaptchaVerifier) {
    try {
      recaptchaVerifier.clear();
    } catch {
      // Ignore cleanup errors
    }
    recaptchaVerifier = null;
  }
}

/**
 * Initializes the login UI, auth tabs, password toggle, OTP flow, and auth listener.
 *
 * @param {object} callbacks
 * @param {(user: import('firebase/auth').User) => void} callbacks.onAuthenticated
 * @param {() => void} callbacks.onSignedOut
 */
export function initAuth({ onAuthenticated, onSignedOut }) {
  const configBanner = document.getElementById('firebase-config-banner');
  if (configBanner) {
    configBanner.classList.toggle('hidden', isFirebaseConfigured());
  }

  // Auth method tabs (Email vs Phone OTP)
  const tabEmail = document.getElementById('auth-tab-email');
  const tabPhone = document.getElementById('auth-tab-phone');
  const panelEmail = document.getElementById('auth-panel-email');
  const panelPhone = document.getElementById('auth-panel-phone');
  const authAlert = document.getElementById('auth-alert');

  const showAuthAlert = (message, isSuccess = false) => {
    if (!authAlert) return;
    authAlert.textContent = message;
    authAlert.classList.remove('hidden', 'bg-red-50', 'text-red-700', 'border-red-200', 'bg-emerald-50', 'text-emerald-700', 'border-emerald-200');
    if (isSuccess) {
      authAlert.classList.add('bg-emerald-50', 'text-emerald-700', 'border-emerald-200');
    } else {
      authAlert.classList.add('bg-red-50', 'text-red-700', 'border-red-200');
    }
  };

  const clearAuthAlert = () => {
    authAlert?.classList.add('hidden');
  };

  const switchAuthTab = (mode) => {
    clearAuthAlert();
    const isEmail = mode === 'email';
    tabEmail?.setAttribute('aria-selected', String(isEmail));
    tabPhone?.setAttribute('aria-selected', String(!isEmail));
    panelEmail?.classList.toggle('hidden', !isEmail);
    panelPhone?.classList.toggle('hidden', isEmail);
  };

  tabEmail?.addEventListener('click', () => switchAuthTab('email'));
  tabPhone?.addEventListener('click', () => switchAuthTab('phone'));

  // Show/Hide Password Toggle
  const togglePwdBtn = document.getElementById('toggle-password-btn');
  const passwordInput = document.getElementById('login-password');
  togglePwdBtn?.addEventListener('click', () => {
    if (!passwordInput) return;
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    togglePwdBtn.textContent = isHidden ? 'Hide' : 'Show';
    togglePwdBtn.setAttribute('aria-pressed', String(isHidden));
  });

  // Email/Password Sign In
  const emailForm = document.getElementById('email-login-form');
  const emailSubmitBtn = document.getElementById('email-login-btn');
  emailForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthAlert();

    if (!isFirebaseConfigured()) {
      showAuthAlert('Please configure your Firebase credentials in js/firebase-config.js first.');
      return;
    }

    const email = document.getElementById('login-email')?.value.trim() || '';
    const password = passwordInput?.value || '';

    emailSubmitBtn.disabled = true;
    emailSubmitBtn.textContent = 'Signing in...';

    try {
      await signInWithEmailAndPassword(auth, email, password);
      emailForm.reset();
    } catch (err) {
      showAuthAlert(friendlyAuthError(err));
    } finally {
      emailSubmitBtn.disabled = false;
      emailSubmitBtn.textContent = 'Sign In';
    }
  });

  // Forgot Password Link
  const forgotBtn = document.getElementById('forgot-password-btn');
  forgotBtn?.addEventListener('click', async () => {
    clearAuthAlert();
    const emailInput = document.getElementById('login-email');
    const email = emailInput?.value.trim() || '';
    if (!email) {
      showAuthAlert('Enter your email address above first, then click "Forgot password?" to receive a reset link.');
      emailInput?.focus();
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email);
      showAuthAlert(`Password reset link sent to ${email}. Check your inbox.`, true);
    } catch (err) {
      showAuthAlert(friendlyAuthError(err));
    }
  });

  // Phone OTP Login
  const phoneInput = document.getElementById('login-phone');
  bindPhPhoneInput(phoneInput);

  const phoneStepForm = document.getElementById('phone-send-otp-form');
  const otpVerifyForm = document.getElementById('phone-verify-otp-form');
  const sendOtpBtn = document.getElementById('send-otp-btn');
  const verifyOtpBtn = document.getElementById('verify-otp-btn');
  const changePhoneBtn = document.getElementById('change-phone-btn');
  const otpSentToLabel = document.getElementById('otp-sent-to');

  phoneStepForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthAlert();

    if (!isFirebaseConfigured()) {
      showAuthAlert('Please configure your Firebase credentials in js/firebase-config.js first.');
      return;
    }

    const normalizedPhone = normalizeToE164(phoneInput?.value || '');
    if (!normalizedPhone) {
      showAuthAlert('Please enter a valid Philippine mobile number (09XXXXXXXXX or +639XXXXXXXXX).');
      phoneInput?.focus();
      return;
    }

    sendOtpBtn.disabled = true;
    sendOtpBtn.textContent = 'Sending OTP...';

    try {
      const verifier = ensureRecaptcha();
      confirmationResult = await signInWithPhoneNumber(auth, normalizedPhone, verifier);
      phoneStepForm.classList.add('hidden');
      otpVerifyForm.classList.remove('hidden');
      if (otpSentToLabel) otpSentToLabel.textContent = normalizedPhone;
      document.getElementById('login-otp')?.focus();
      showAuthAlert(`Verification code sent via SMS to ${normalizedPhone}.`, true);
    } catch (err) {
      resetRecaptcha();
      showAuthAlert(friendlyAuthError(err));
    } finally {
      sendOtpBtn.disabled = false;
      sendOtpBtn.textContent = 'Send Verification Code';
    }
  });

  otpVerifyForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthAlert();

    if (!confirmationResult) {
      showAuthAlert('Please request a verification code first.');
      return;
    }

    const code = document.getElementById('login-otp')?.value.trim() || '';
    if (!/^\d{6}$/.test(code)) {
      showAuthAlert('Please enter the 6-digit verification code.');
      return;
    }

    verifyOtpBtn.disabled = true;
    verifyOtpBtn.textContent = 'Verifying...';

    try {
      await confirmationResult.confirm(code);
      otpVerifyForm.reset();
      phoneStepForm.reset();
      otpVerifyForm.classList.add('hidden');
      phoneStepForm.classList.remove('hidden');
      confirmationResult = null;
    } catch (err) {
      showAuthAlert(friendlyAuthError(err));
    } finally {
      verifyOtpBtn.disabled = false;
      verifyOtpBtn.textContent = 'Verify & Sign In';
    }
  });

  changePhoneBtn?.addEventListener('click', () => {
    clearAuthAlert();
    confirmationResult = null;
    resetRecaptcha();
    otpVerifyForm?.classList.add('hidden');
    phoneStepForm?.classList.remove('hidden');
    phoneInput?.focus();
  });

  // Logout Button
  const logoutBtn = document.getElementById('logout-btn');
  logoutBtn?.addEventListener('click', async () => {
    try {
      await signOut(auth);
      showToast('You have been signed out.', 'info');
    } catch (err) {
      showToast(`Sign out failed: ${err.message}`, 'error');
    }
  });

  // Route Guard: Listen for Firebase Auth state changes
  const authView = document.getElementById('auth-view');
  const dashboardView = document.getElementById('dashboard-view');
  const authLoading = document.getElementById('auth-loading');
  const userIdentityEl = document.getElementById('current-user-identity');

  onAuthStateChanged(auth, (user) => {
    authLoading?.classList.add('hidden');

    if (user) {
      authView?.classList.add('hidden');
      dashboardView?.classList.remove('hidden');
      if (userIdentityEl) {
        userIdentityEl.textContent = user.email || user.phoneNumber || 'TSV Lead';
      }
      onAuthenticated(user);
    } else {
      dashboardView?.classList.add('hidden');
      authView?.classList.remove('hidden');
      onSignedOut();
    }
  });
}


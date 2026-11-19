# TSV Suguan Monitoring and Reminder System

A responsive web application for the **TSV (Technical Support for Videostreaming) Lead** to encode worship service duty schedules (*Suguan*) and automatically send SMS alerts and reminders to assigned officers, the Head Deacon (*Pangulong Diakono*), and the Pastor via **SabayKonekta** (`https://sabaykonekta.netlify.app`).

---

## Features

- **Firebase Authentication**: Supports both **Email & Password** (with password reset) and **Philippine Mobile Number (SMS OTP)** login. All dashboard views and Firestore collections are protected.
- **Suguan Schedule Management**:
  - Encode Duty Date, Duty Time (PHT / `Asia/Manila`), Service Name, Computer Operator, Video Operator, Audio Operator, and Head Deacon (*Pangulong Diakono*).
  - Automatic Philippine mobile number validation and normalization (`09XXXXXXXXX` / `+639XXXXXXXXX`).
  - Real-time Firestore list with Upcoming / Past / All filters, search, Edit, Delete (with confirmation modal), and manual **Resend SMS**.
  - Live status badges for all 3 triggers: **Immediate**, **24h Reminder**, and **2h Reminder**.
- **3-Stage Automated SMS Workflow**:
  1. **Trigger 1 (Immediate)**: Sent automatically upon saving a new schedule.
  2. **Trigger 2 (24-Hour Reminder)**: Sent 24 hours before duty.
  3. **Trigger 3 (2-Hour Final Reminder)**: Sent 2 hours before duty.
  - Includes **both** a client-side 60-second background checker (while the dashboard is open) **and** a Firebase Cloud Functions v2 scheduled job (`functions/index.js`) running every 15 minutes. Both use Firestore transactions (`reminder24hSent`, `reminder2hSent`) to prevent duplicate SMS.
- **System Settings (`settings/config`)**: Configure SabayKonekta SMS API URL, API Key, Device/Sender ID, Pastor details, and run a live **Test SMS**.
- **SMS Logs (`sms_logs`)**: Real-time append-only audit log with responsive mobile stacked cards, filters, and modal viewer for the full SMS body and API response.

---

## Quick Setup Guide

### 1. Configure Firebase Credentials
1. Open [Firebase Console](https://console.firebase.google.com/) and create or select your project.
2. Add a **Web App** and copy your `firebaseConfig`.
3. Paste your config into `js/firebase-config.js`.

### 2. Enable Authentication Providers
In **Firebase Console → Authentication → Sign-in method**:
- Enable **Email/Password** and add your TSV Lead admin user(s) under the **Users** tab.
- Enable **Phone** for SMS OTP login (you can add test phone numbers under *Phone numbers for testing*).
- Add your hosting domain (and `localhost`) under **Authentication → Settings → Authorized domains**.

### 3. Deploy Firestore Security Rules & Indexes
```bash
firebase login
firebase use --add
firebase deploy --only firestore:rules,firestore:indexes
```

### 4. Deploy Automated Cloud Function Scheduler (Optional but Recommended)
So 24-hour and 2-hour reminders fire even when no browser tab is open (requires Firebase Blaze plan):
```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

### 5. Run Locally or Deploy to Firebase Hosting
For local development, serve the workspace root with any static HTTP server (ES modules require HTTP, not `file://`):
```bash
npx serve .
# or
firebase emulators:start --only hosting
```

To deploy to Firebase Hosting:
```bash
firebase deploy --only hosting
```

### 6. Configure SabayKonekta SMS API & Pastor Details
1. Sign in as the TSV Lead.
2. Open the **System Settings** tab.
3. Enter your **SabayKonekta API Endpoint URL**, **API Key**, **Device ID / Sender ID**, and **Pastor Name & Mobile Number**.
4. Click **Save System Settings**, then use **Send Test SMS** to verify connectivity.


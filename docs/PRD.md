# Product Requirements Document (PRD)
## TSV Suguan Monitoring and Reminder System

| Field | Details |
| :--- | :--- |
| **Product Name** | TSV Suguan Monitoring and Reminder System |
| **Document Version** | 1.0 |
| **Date** | November 19, 2026 |
| **Primary User** | TSV (Technical Support for Videostreaming) Lead / Admin |
| **SMS Recipients** | Computer Operator, Video Operator (optional), Audio Operator (optional), Assigned Head Deacon (*Pangulong Diakono*), and Pastor / Resident Minister |
| **Status** | Implemented & Verified |

---

## 1. Executive Summary & Problem Statement

### 1.1 Background
Coordinating Technical Support for Videostreaming (TSV) duty assignments (*Suguan*) for worship services and special gatherings requires notifying multiple officers, the assigned Head Deacon (*Pangulong Diakono*), and the Pastor. Manual texting is time-consuming, error-prone, and often results in missed reminders before service time.

### 1.2 Objective
Build a responsive, mobile-friendly web application that allows the **TSV Lead** to encode duty schedules once and automatically dispatch timely, standardized SMS alerts and reminders to all assigned personnel via the **SabayKonekta** SMS Gateway (`https://sabaykonekta.netlify.app`), with real-time delivery tracking and audit logs.

---

## 2. Target Users & Personas

| Persona | Role | Primary Goals |
| :--- | :--- | :--- |
| **TSV Lead / Admin** | Authenticated operator of the web app | Quickly encode, edit, and monitor duty schedules on mobile or desktop; verify SMS delivery; configure gateway and Pastor details. |
| **TSV Officers** *(Computer, Video, Audio)* | SMS recipients | Receive immediate confirmation of their assigned *Gampanin* (role) plus 24-hour and 2-hour reminders before duty. |
| **Assigned Head Deacon** (*Pangulong Diakono*) | SMS recipient | Receive the complete TSV lineup and timely reminders for each worship service. |
| **Pastor / Resident Minister** | Automatic CC SMS recipient | Receive copies of all encoded schedules and reminders for oversight without needing to log into the app. |

---

## 3. Functional Requirements

### 3.1 Authentication & Access Control (`FR-AUTH`)
- **FR-AUTH-01**: Provide a dedicated login screen with a tab switcher supporting:
  1. **Email & Password** login (with Show/Hide password toggle and Forgot Password reset link).
  2. **Philippine Mobile Number (SMS OTP)** login using Firebase Phone Auth with invisible reCAPTCHA.
- **FR-AUTH-02**: Protect all dashboard views and database operations so only authenticated, non-anonymous TSV Lead/Admin accounts can view or modify data.
- **FR-AUTH-03**: Provide a persistent **Sign Out** button in the dashboard header.

### 3.2 Suguan (Duty Schedule) Management (`FR-SCHED`)
- **FR-SCHED-01**: Provide a mobile-friendly input form for encoding a duty schedule with:
  - **Duty Date** (`YYYY-MM-DD`, required) and **Duty Time** (`HH:mm`, Asia/Manila `PHT`, required).
  - **Worship Service / Event Name** (text with quick presets, defaults to *Worship Service*).
  - **Computer Operator** — Full Name & Mobile Number (**required**).
  - **Video Operator** — Full Name & Mobile Number (**optional**).
  - **Audio Operator** — Full Name & Mobile Number (**optional**).
  - **Assigned Head Deacon (*Pangulong Diakono*)** — Full Name & Mobile Number (**required**).
- **FR-SCHED-02**: Automatically validate and normalize Philippine mobile numbers (`09XXXXXXXXX` or `+639XXXXXXXXX`) to E.164 format (`+639XXXXXXXXX`) before saving or dispatching SMS.
- **FR-SCHED-03**: Display a real-time synchronized schedule list (Firestore `onSnapshot`) with:
  - Filter tabs: **Upcoming**, **Past**, and **All**.
  - Live search by officer name, Head Deacon, date, or service name.
  - Status badges for all three SMS triggers (**Immediate**, **24h Reminder**, **2h Reminder**) displaying `Pending`, `Sent`, `Partial`, or `Failed`.
- **FR-SCHED-04**: Support **Edit** (with optional checkbox to resend updated SMS), **Delete** (with confirmation dialog defaulting focus to Cancel), and **Resend SMS** (allowing manual dispatch of Immediate, 24h, 2h, or Update templates).

### 3.3 Automated 3-Stage SMS Workflow (`FR-SMS`)
- **FR-SMS-01 (Trigger 1 — Immediate Alert)**: Automatically dispatch formatted SMS to all assigned officers (skipping unassigned optional roles) plus the Pastor immediately upon saving a new schedule.
- **FR-SMS-02 (Trigger 2 — 24-Hour Reminder)**: Automatically dispatch a 24-hour reminder when a schedule is within 24 hours (and > 2 hours) of duty time.
- **FR-SMS-03 (Trigger 3 — 2-Hour Final Reminder)**: Automatically dispatch a final reminder within 2 hours of duty time.
- **FR-SMS-04 (Duplicate Prevention)**: Record `reminder24hSent: true` and `reminder2hSent: true` atomically in Firestore so neither multiple open browser tabs nor the scheduled Cloud Function can send duplicate reminders.
- **FR-SMS-05 (Gateway Compatibility)**: Format all SMS messages as compact **GSM-7 single-segment SMS (≤ 155 characters)** and send sequentially (`600ms` spacing) to ensure reliable dispatch through the SabayKonekta Android SMS Gateway.

### 3.4 System Settings (`FR-SET`)
- **FR-SET-01**: Persist SMS Gateway configuration in Firestore `settings/config`:
  - API Endpoint URL (default: `https://sabaykonekta.netlify.app/api/send-sms`).
  - API Key / Bearer Token (masked with Show/Hide toggle).
  - Device ID / Sender ID (optional).
- **FR-SET-02**: Persist **Pastor / Resident Minister** Full Name and Mobile Number in `settings/config`.
- **FR-SET-03**: Provide a **Send Test SMS** tool that tests live SabayKonekta connectivity, displays the raw HTTP status/response inline, and records the attempt in `sms_logs`.
- **FR-SET-04**: Display an alert banner on the dashboard if the API Key or Pastor's mobile number is not yet configured.

### 3.5 SMS Logs / Audit History (`FR-LOG`)
- **FR-LOG-01**: Record every SMS dispatch attempt (including Test SMS and failures) in an append-only Firestore `sms_logs` collection.
- **FR-LOG-02**: Display a real-time table (responsive stacked cards on mobile) showing Timestamp, Recipient Name, Role, Phone Number, Trigger Type, Delivery Status (`Success` / `Failed`), and a **View Response** modal showing the full SMS text and raw SabayKonekta API response.
- **FR-LOG-03**: Provide filters by Delivery Status, Trigger Type, and text search.

---

## 4. Non-Functional Requirements

| Category | Requirement |
| :--- | :--- |
| **Usability & Responsiveness** | Mobile-first layout supporting 320px+ phones through desktop monitors; accessible forms (`:user-invalid`, `aria-invalid`, native `<dialog>`, `popover="manual"` toasts). |
| **Reliability** | Dual scheduler: client-side 60-second background checker while the app is open + Firebase Cloud Functions v2 scheduled job every 15 minutes for unattended reminders. |
| **Security** | Zero unauthenticated/anonymous access; strict Firestore schema, key-allowlist, string-bound, and immutability rules; append-only `sms_logs`. |
| **Time Zone Accuracy** | All duty dates, times, and reminder windows evaluated consistently in `Asia/Manila` (`UTC+8`). |
| **Performance** | Zero-build vanilla ES modules + Tailwind CSS; real-time Firestore listeners with bounded log queries (`limit(250)`). |

---

## 5. Success Metrics

- **100%** of encoded schedules dispatch Trigger 1 SMS within 10 seconds of saving.
- **0%** duplicate 24-hour or 2-hour reminders across concurrent clients and Cloud Scheduler runs.
- **100%** of SMS messages formatted within 1 GSM-7 segment (`segments: 1`) for reliable Android Gateway delivery.
- **100%** auditability of every sent/failed SMS in `sms_logs`.


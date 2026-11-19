/**
 * ============================================================================
 * Firebase Configuration & Initialization
 * TSV Suguan Monitoring and Reminder System
 * ============================================================================
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://console.firebase.google.com/ and create/select your project.
 * 2. Register a Web App (</>) in Project Settings -> General -> Your apps.
 * 3. Copy your project's `firebaseConfig` object and replace the placeholder
 *    values below.
 * 4. Enable Authentication providers in Firebase Console -> Authentication:
 *      - Email/Password (create TSV Lead/Admin accounts in the Users tab)
 *      - Phone (for Mobile Number OTP login; add test phone numbers for dev)
 * 5. Create a Cloud Firestore database in Production Mode and deploy
 *    `firestore.rules` and `firestore.indexes.json`.
 * 6. Add your hosting domain (and `localhost` for local dev) under
 *    Authentication -> Settings -> Authorized domains.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPhoneNumber,
  RecaptchaVerifier,
  signOut,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  where,
  limit,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';

// ----------------------------------------------------------------------------
// FIREBASE PROJECT CONFIGURATION (tsvsuguan)
// ----------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: 'AIzaSyBYheA7VG-R8O9CpaCku7tbpblyGCiGMhU',
  authDomain: 'tsvsuguan.firebaseapp.com',
  projectId: 'tsvsuguan',
  storageBucket: 'tsvsuguan.firebasestorage.app',
  messagingSenderId: '1058875020026',
  appId: '1:1058875020026:web:4d7c57487c74a29e55ef43',
};

/**
 * Helper to detect if the developer has not yet replaced placeholder values.
 */
export function isFirebaseConfigured() {
  return (
    Boolean(firebaseConfig.apiKey) &&
    !firebaseConfig.apiKey.startsWith('YOUR_') &&
    Boolean(firebaseConfig.projectId) &&
    !firebaseConfig.projectId.startsWith('YOUR_')
  );
}

// Initialize Firebase App, Auth, and Firestore
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Re-export modular SDK functions for consistent versioned imports across modules
export {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPhoneNumber,
  RecaptchaVerifier,
  signOut,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  where,
  limit,
  runTransaction,
  serverTimestamp,
  Timestamp,
};


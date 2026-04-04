/**
 * Copy to firebase.config.js (do not commit secrets). Load before main.js:
 *   <script src="js/firebase/firebase.config.js"></script>
 *
 * Firestore rules (sketch): users may read/write only /users/{userId} where request.auth.uid == userId.
 * Enable Anonymous auth in Firebase console if useAnonymousAuth is true (default).
 */
window.__CTU_FIREBASE_CONFIG__ = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  appId: "",
  /** Set false to skip sign-in until you add email/Google UI */
  useAnonymousAuth: true,
};

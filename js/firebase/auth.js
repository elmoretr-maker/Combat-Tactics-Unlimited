/**
 * Optional Firebase (ES module CDN). Set window.__CTU_FIREBASE_CONFIG__ before main.js loads
 * (see firebase.config.example.js). Enables anonymous auth + Firestore when configured.
 */

const FB_APP = "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
const FB_AUTH = "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
const FB_FS = "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let initPromise = null;

export async function initFirebase() {
  if (initPromise) return initPromise;
  initPromise = doInit();
  return initPromise;
}

/** @deprecated use initFirebase */
export function tryInitFirebase() {
  return initFirebase();
}

async function doInit() {
  const cfg =
    typeof window !== "undefined" ? window.__CTU_FIREBASE_CONFIG__ : null;
  if (!cfg?.apiKey) return null;

  try {
    const { initializeApp } = await import(/* @vite-ignore */ FB_APP);
    const authMod = await import(/* @vite-ignore */ FB_AUTH);
    const fsMod = await import(/* @vite-ignore */ FB_FS);

    const app = initializeApp(cfg);
    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);

    if (typeof window !== "undefined") {
      window.__CTU_FIREBASE_APP__ = app;
      window.__CTU_FIREBASE_AUTH__ = auth;
      window.__CTU_FIRESTORE__ = db;
    }

    if (cfg.useAnonymousAuth !== false) {
      try {
        await authMod.signInAnonymously(auth);
      } catch (e) {
        console.warn(
          "[CTU] Anonymous sign-in failed — enable Anonymous provider in Firebase console, or set useAnonymousAuth: false.",
          e
        );
      }
    }

    console.info("[CTU] Firebase initialized");
    return { app, auth, db, fs: fsMod, authMod };
  } catch (e) {
    console.warn("[CTU] Firebase init failed", e);
    return null;
  }
}

export function getFirebaseApp() {
  return typeof window !== "undefined" ? window.__CTU_FIREBASE_APP__ : null;
}

export function getAuth() {
  return typeof window !== "undefined" ? window.__CTU_FIREBASE_AUTH__ : null;
}

export function getFirestoreDb() {
  return typeof window !== "undefined" ? window.__CTU_FIRESTORE__ : null;
}

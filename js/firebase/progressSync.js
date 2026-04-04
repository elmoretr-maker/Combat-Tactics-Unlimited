import {
  loadProgress,
  saveProgress,
  mergeProgress,
  setCloudAdapter,
} from "../progression/store.js";

const FB_AUTH = "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
const FB_FS = "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let pushTimer = null;

/**
 * @param {() => object} getProgress
 * @param {(p: object) => void} applyProgress — update in-memory progress + refresh UI
 */
export async function wireCloudProgress(getProgress, applyProgress) {
  const cfg =
    typeof window !== "undefined" ? window.__CTU_FIREBASE_CONFIG__ : null;
  if (!cfg?.apiKey) return;

  const authMod = await import(/* @vite-ignore */ FB_AUTH);
  const fsMod = await import(/* @vite-ignore */ FB_FS);
  const db = getFirestoreDb();
  const app = typeof window !== "undefined" ? window.__CTU_FIREBASE_APP__ : null;
  const auth = app ? authMod.getAuth(app) : null;
  if (!db || !auth) return;

  const schedulePush = (p) => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void pushUserDoc(db, auth, fsMod, p), 900);
  };
  setCloudAdapter(schedulePush);

  authMod.onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    try {
      const ref = fsMod.doc(db, "users", user.uid);
      const snap = await fsMod.getDoc(ref);
      if (!snap.exists()) {
        await pushUserDoc(db, auth, fsMod, getProgress());
        return;
      }
      const data = snap.data();
      const remote = data?.progress;
      if (!remote || typeof remote !== "object") {
        await pushUserDoc(db, auth, fsMod, getProgress());
        return;
      }
      const merged = mergeProgress(loadProgress(), remote);
      applyProgress(merged);
      saveProgress(merged, { skipCloud: true });
      await pushUserDoc(db, auth, fsMod, merged);
    } catch (e) {
      console.warn("[CTU] Firestore hydrate failed", e);
    }
  });
}

async function pushUserDoc(db, auth, fsMod, progress) {
  const user = auth.currentUser;
  if (!user || !progress) return;
  try {
    const ref = fsMod.doc(db, "users", user.uid);
    const safe = JSON.parse(JSON.stringify(progress));
    await fsMod.setDoc(
      ref,
      {
        progress: safe,
        displayName: safe.displayName || "Commander",
        updatedAt: fsMod.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) {
    console.warn("[CTU] Firestore save failed", e);
  }
}

function getFirestoreDb() {
  return typeof window !== "undefined" ? window.__CTU_FIRESTORE__ : null;
}

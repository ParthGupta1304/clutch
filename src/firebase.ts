import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAjZChF5NjxV9Hp-Ccpl9kbdQ_EfL3u4qk",
  authDomain: "juicy-motif-5dpgw.firebaseapp.com",
  projectId: "juicy-motif-5dpgw",
  storageBucket: "juicy-motif-5dpgw.firebasestorage.app",
  messagingSenderId: "37477836378",
  appId: "1:37477836378:web:2377239266d6393948da63"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, "ai-studio-eaff1585-d292-4c73-aafb-aba8ba2d6ff3");
const googleProvider = new GoogleAuthProvider();

// Safe storage connection verification as requested by SKILL.md
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Please check your Firebase configuration or network status.");
    }
  }
}
testConnection();

export { app, auth, db, googleProvider, signInWithPopup, signOut };

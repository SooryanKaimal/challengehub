import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// FIREBASE CONFIG HERE
const firebaseConfig = {
  apiKey: "AIzaSyD_XYBZXVreE-p0XDsVwsCGJhnyzDc52dQ",
  authDomain: "digs-dc482.firebaseapp.com",
  projectId: "digs-dc482",
  storageBucket: "digs-dc482.firebasestorage.app",
  messagingSenderId: "264220481229",
  appId: "1:264220481229:web:0960f447247893aaeafb84"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
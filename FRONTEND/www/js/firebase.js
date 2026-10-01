// Firebase Web SDK bootstrap for Neighborly.
// Firebase web config is public; protect data with Firebase Security Rules.
const neighborlyFirebaseConfig = {
  apiKey: "AIzaSyCtCihp-raILjPX3-44NO7YKAuXfEnKE1I",
  authDomain: "neighborly-967d9.firebaseapp.com",
  projectId: "neighborly-967d9",
  storageBucket: "neighborly-967d9.firebasestorage.app",
  messagingSenderId: "590920587332",
  appId: "1:590920587332:web:de60d05697ca2cf56bc411",
  measurementId: "G-LGFP61Q4Y3"
};

if (!window.firebase) {
  throw new Error('Firebase SDK failed to load. Check the network connection and Firebase scripts.');
}

if (window.firebase.apps.length === 0) {
  window.firebase.initializeApp(neighborlyFirebaseConfig);
}

window.neighborlyAuth = window.firebase.auth();
window.neighborlyFirebaseConfig = neighborlyFirebaseConfig;

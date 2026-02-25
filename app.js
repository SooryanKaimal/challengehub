import { auth, db } from './firebase-config.js';
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from './cloudinary-config.js';
import { 
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { 
  collection, doc, setDoc, getDoc, addDoc, updateDoc, onSnapshot, 
  query, orderBy, limit, serverTimestamp, runTransaction, getDocs, where,
  deleteDoc // <--- ADD THIS
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
// === GLOBAL STATE ===
let currentUser = null;
let currentChallengeId = null;

// === PWA SETUP ===
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js');
}

// === AUTH STATE LISTENER ===
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  const path = window.location.pathname;
  
  if (!user && !path.includes('login.html')) {
    window.location.href = 'login.html';
  } else if (user && path.includes('login.html')) {
    window.location.href = 'index.html';
  } else if (user) {
    routeApp();
  }
});

function routeApp() {
  if (document.getElementById('feed-container')) initFeed();
  if (document.getElementById('profile-container')) initProfile();
}

// === 1. LOGIN / SIGNUP LOGIC ===
if (document.getElementById('auth-container')) {
  let isSignup = false;
  const toggleBtn = document.getElementById('toggle-auth');
  const title = document.getElementById('auth-title');
  const userInp = document.getElementById('auth-username');
  const form = document.getElementById('auth-form');

  toggleBtn.addEventListener('click', () => {
    isSignup = !isSignup;
    title.innerText = isSignup ? "Sign Up" : "Login";
    toggleBtn.innerText = isSignup ? "Already have an account? Login" : "Need an account? Sign up";
    isSignup ? userInp.classList.remove('hidden') : userInp.classList.add('hidden');
    if(isSignup) userInp.required = true; else userInp.required = false;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const pass = document.getElementById('auth-password').value;
    const btn = document.getElementById('auth-btn');
    btn.disabled = true;

    try {
      if (isSignup) {
        const username = userInp.value.trim();
        // Firebase Auth
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        // Auto-create "users" collection document
        await setDoc(doc(db, "users", cred.user.uid), {
          username: username,
          email: email,
          points: 0,
          streak: 0,
          totalLikes: 0,
          createdAt: serverTimestamp()
        });
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (error) {
      alert("Auth Error: " + error.message);
      btn.disabled = false;
    }
  });
}

// === 2. FEED & CHALLENGE LOGIC ===
async function initFeed() {
  await setupDailyChallenge();
  listenToFeed();
  listenToLeaderboard();

  // Upload Modal Handlers
  document.getElementById('open-upload-btn').addEventListener('click', () => {
    document.getElementById('upload-modal').classList.remove('hidden');
  });
  document.getElementById('close-upload-btn').addEventListener('click', () => {
    document.getElementById('upload-modal').classList.add('hidden');
  });

  document.getElementById('submit-video-btn').addEventListener('click', handleVideoUpload);
}

// Auto-create or fetch Daily Challenge
async function setupDailyChallenge() {
  const challengeRef = doc(db, "challenges", "daily");
  const docSnap = await getDoc(challengeRef);
  const now = new Date();

  if (!docSnap.exists() || docSnap.data().expiresAt.toDate() < now) {
    // Generate new challenge
    const newChallenge = {
      title: "Daily Challenge: Tell a Joke",
      description: "Record your best 30-second joke!",
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) // 24h from now
    };
    await setDoc(challengeRef, newChallenge);
    currentChallengeId = "daily_" + now.getTime(); // Pseudo ID for logic tracking
    renderChallenge(newChallenge);
  } else {
    currentChallengeId = "daily"; 
    renderChallenge(docSnap.data());
  }
}

function renderChallenge(data) {
  document.getElementById('daily-challenge').innerHTML = `
    <h2>${data.title}</h2>
    <p>${data.description}</p>
    <small>Expires: ${data.expiresAt.toDate ? data.expiresAt.toDate().toLocaleTimeString() : data.expiresAt.toLocaleTimeString()}</small>
  `;
}

// === 3. VIDEO UPLOAD (CLOUDINARY) ===
async function handleVideoUpload() {
  const fileInput = document.getElementById('video-file');
  const file = fileInput.files[0];
  if (!file) return alert("Select a video");
  
  // Security & Validation
  if (!file.type.startsWith('video/')) return alert("Only video files allowed.");
  if (file.size > 50 * 1024 * 1024) return alert("File exceeds 50MB limit.");

  // Check duplicate submission
  const userVideosQuery = query(collection(db, "videos"), 
    where("userId", "==", currentUser.uid),
    where("challengeId", "==", currentChallengeId)
  );
  const snap = await getDocs(userVideosQuery);
  if (!snap.empty) return alert("You already submitted a video for this challenge!");

  // Duration check via DOM
  const videoNode = document.createElement('video');
  videoNode.preload = 'metadata';
  videoNode.src = URL.createObjectURL(file);
  videoNode.onloadedmetadata = function() {
    URL.revokeObjectURL(videoNode.src);
    if (videoNode.duration > 31) return alert("Video must be 30 seconds or less.");
    executeUpload(file);
  };
}

function executeUpload(file) {
  const btn = document.getElementById('submit-video-btn');
  const progressText = document.getElementById('upload-progress');
  btn.disabled = true;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

  // Unsigned Upload via XHR to track progress
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 100);
      progressText.innerText = `Uploading: ${percent}%`;
    }
  };

  xhr.onload = async () => {
    if (xhr.status === 200) {
      const response = JSON.parse(xhr.responseText);
      const secureUrl = response.secure_url;
      await saveVideoToFirestore(secureUrl);
      progressText.innerText = "Upload Complete!";
      setTimeout(() => {
        document.getElementById('upload-modal').classList.add('hidden');
        btn.disabled = false;
        progressText.innerText = "";
      }, 1000);
    } else {
      alert("Upload failed");
      btn.disabled = false;
    }
  };
  xhr.send(formData);
}

// Auto-create "videos" collection document
// Auto-create "videos" collection document (Updated with safety checks)
async function saveVideoToFirestore(url) {
  const userRef = doc(db, "users", currentUser.uid);
  const userDoc = await getDoc(userRef);

  let username = "Unknown User";
  let currentPoints = 0;
  let currentStreak = 0;

  // Check if the user document actually exists
  if (userDoc.exists()) {
    const data = userDoc.data();
    username = data.username || "Unknown User";
    currentPoints = data.points || 0;
    currentStreak = data.streak || 0;
  } else {
    console.warn("User document not found! Auto-healing...");
    username = currentUser.email ? currentUser.email.split('@')[0] : "User";
    // Auto-heal by creating the missing user document
    await setDoc(userRef, {
      username: username,
      email: currentUser.email || "",
      points: 0,
      streak: 0,
      totalLikes: 0,
      createdAt: serverTimestamp()
    });
  }

  // Save the video document
  await addDoc(collection(db, "videos"), {
    userId: currentUser.uid,
    username: username,
    videoURL: url,
    challengeId: currentChallengeId,
    likes: 0,
    createdAt: serverTimestamp(),
    pointsAwarded: true
  });

  // Update User Stats (Streak + Points)
  await updateDoc(userRef, {
    points: currentPoints + 10,
    streak: currentStreak + 1 
  });
}

// === 4. FEED & ENGAGEMENT LOGIC ===
// === 4. FEED & ENGAGEMENT LOGIC (MODERNIZED) ===
function listenToFeed() {
  const q = query(collection(db, "videos"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snapshot) => {
    const feed = document.getElementById('video-feed');
    feed.innerHTML = '';
    
    snapshot.forEach((docSnap) => {
      const vid = docSnap.data();
      const vidId = docSnap.id;
      
      const card = document.createElement('div');
      card.className = 'card video-card';
      
      // Modern Video Player HTML structure
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <h4 style="margin: 0;">${sanitize(vid.username)}</h4>
        </div>
        
        <div class="video-wrapper">
          <video id="vid-${vidId}" src="${vid.videoURL}" playsinline preload="metadata" loop></video>
          <div class="play-overlay" id="overlay-${vidId}">
            <div class="play-btn-icon"><div class="play-triangle"></div></div>
          </div>
        </div>

        <div class="video-actions">
          <button class="like-btn" id="like-${vidId}">❤️ <span id="like-count-${vidId}">${vid.likes || 0}</span></button>
        </div>
        
        <div class="comment-section">
          <div id="comments-${vidId}" style="max-height: 120px; overflow-y: auto; margin-bottom: 10px;"></div>
          <div style="display:flex; gap:5px;">
            <input type="text" id="comment-input-${vidId}" placeholder="Add a comment..." style="margin:0;">
            <button class="btn" id="post-comment-${vidId}" style="width: auto;">Post</button>
          </div>
        </div>
      `;
      feed.appendChild(card);

      // Custom Play/Pause Click Logic
      const videoEl = document.getElementById(`vid-${vidId}`);
      const overlay = document.getElementById(`overlay-${vidId}`);
      
      videoEl.addEventListener('click', () => {
        if (videoEl.paused) {
          videoEl.play();
          overlay.classList.add('hidden');
        } else {
          videoEl.pause();
          overlay.classList.remove('hidden');
        }
      });

      // Attach Event Listeners for Engagement
      setupLikeSystem(vidId, vid.userId);
      setupCommentSystem(vidId);
    });
  });
}
// Transactional Like System & Auto-creating likes subcollection
async function setupLikeSystem(videoId, videoOwnerId) {
  const likeBtn = document.getElementById(`like-${videoId}`);
  const likeRef = doc(db, `videos/${videoId}/likes`, currentUser.uid);

  // Check initial state
  getDoc(likeRef).then(snap => {
    if(snap.exists()) likeBtn.classList.add('liked');
  });

  likeBtn.addEventListener('click', async () => {
    const isLiked = likeBtn.classList.contains('liked');
    const videoRef = doc(db, "videos", videoId);
    const ownerRef = doc(db, "users", videoOwnerId);

    try {
      await runTransaction(db, async (transaction) => {
        const vidDoc = await transaction.get(videoRef);
        const ownerDoc = await transaction.get(ownerRef);
        
        const newLikes = isLiked ? vidDoc.data().likes - 1 : vidDoc.data().likes + 1;
        const newTotalLikes = isLiked ? ownerDoc.data().totalLikes - 1 : ownerDoc.data().totalLikes + 1;

        transaction.update(videoRef, { likes: newLikes });
        transaction.update(ownerRef, { totalLikes: newTotalLikes });
        
        if (isLiked) {
          transaction.delete(likeRef);
        } else {
          transaction.set(likeRef, { timestamp: serverTimestamp() });
        }
      });
      likeBtn.classList.toggle('liked');
    } catch (e) {
      console.error("Like transaction failed", e);
    }
  });
}

// Auto-creating comments subcollection
function setupCommentSystem(videoId) {
  const commentContainer = document.getElementById(`comments-${videoId}`);
  const input = document.getElementById(`comment-input-${videoId}`);
  const postBtn = document.getElementById(`post-comment-${videoId}`);

  // Real-time comments
  const q = query(collection(db, `videos/${videoId}/comments`), orderBy("createdAt", "asc"));
  onSnapshot(q, (snap) => {
    commentContainer.innerHTML = '';
    snap.forEach(docSnap => {
      const c = docSnap.data();
      commentContainer.innerHTML += `<div class="comment"><strong>${sanitize(c.username)}:</strong> ${sanitize(c.text)}</div>`;
    });
  });

  // Post comment
  // Post comment (UPDATED WITH SAFETY CHECK)
  postBtn.addEventListener('click', async () => {
    const text = input.value.trim();
    if(!text) return;
    input.value = '';

    try {
      const userDocRef = doc(db, "users", currentUser.uid);
      const userDoc = await getDoc(userDocRef);
      
      // Fallback to email prefix if username isn't found
      let authorName = currentUser.email ? currentUser.email.split('@')[0] : "User";
      
      if (userDoc.exists() && userDoc.data().username) {
        authorName = userDoc.data().username;
      }

      await addDoc(collection(db, `videos/${videoId}/comments`), {
        userId: currentUser.uid,
        username: authorName,
        text: text,
        createdAt: serverTimestamp()
      });
    } catch (error) {
      console.error("Error posting comment:", error);
    }
  });
}

// === 5. LEADERBOARD ===
// === 5. LEADERBOARD (MODERNIZED) ===
function listenToLeaderboard() {
  const leaderboardSection = document.getElementById('leaderboard-section');
  if(leaderboardSection) leaderboardSection.classList.remove('hidden');
  
  // Get top 10 users ordered by total likes
  const q = query(collection(db, "users"), orderBy("totalLikes", "desc"), limit(10));
  
  onSnapshot(q, (snap) => {
    const list = document.getElementById('leaderboard-list');
    if (!list) return; // Safety check
    
    list.innerHTML = '';
    list.className = 'leaderboard-list'; // Apply our new CSS class
    
    let rank = 1;
    snap.forEach(docSnap => {
      const u = docSnap.data();
      
      // Determine Medals & Classes
      let medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `<span style="color:#aaa;">${rank}.</span>`;
      let rankClass = rank <= 3 ? `rank-${rank}` : '';
      let username = u.username || (u.email ? u.email.split('@')[0] : 'User');
      
      list.innerHTML += `
        <li class="leaderboard-item ${rankClass}">
          <div class="leaderboard-user">
            <span style="width: 25px; text-align: center; display: inline-block;">${medal}</span>
            <span>${sanitize(username)}</span>
          </div>
          <span class="leaderboard-likes">${u.totalLikes || 0} ❤️</span>
        </li>
      `;
      rank++;
    });
  });
}

// === 6. PROFILE PAGE ===
async function initProfile() {
  document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));

  // User Stats
  // User Stats (UPDATED WITH FALLBACK)
  onSnapshot(doc(db, "users", currentUser.uid), (docSnap) => {
    if(docSnap.exists()) {
      const data = docSnap.data();
      document.getElementById('profile-username').innerText = data.username || "Unknown User";
      document.getElementById('stat-points').innerText = data.points || 0;
      document.getElementById('stat-streak').innerText = data.streak || 0;
      document.getElementById('stat-likes').innerText = data.totalLikes || 0;
    } else {
      // Fallback if the user document is missing in Firestore
      const fallbackName = currentUser.email ? currentUser.email.split('@')[0] : "User";
      document.getElementById('profile-username').innerText = fallbackName;
      document.getElementById('stat-points').innerText = "0";
      document.getElementById('stat-streak').innerText = "0";
      document.getElementById('stat-likes').innerText = "0";
    }
  });

  // User Videos
  const q = query(collection(db, "videos"), where("userId", "==", currentUser.uid));
  onSnapshot(q, (snap) => {
    const grid = document.getElementById('user-video-grid');
    grid.innerHTML = '';
    document.getElementById('stat-videos').innerText = snap.size;
    snap.forEach(docSnap => {
      const vid = docSnap.data();
      grid.innerHTML += `<video src="${vid.videoURL}#t=0.1" preload="metadata"></video>`;
    });
  });
}
// === DELETE VIDEO LOGIC ===
async function deleteVideo(videoId) {
  try {
    // Deletes the video document from Firestore
    await deleteDoc(doc(db, "videos", videoId));
    console.log("Video removed from feed.");
  } catch (error) {
    console.error("Error deleting video:", error);
    alert("Failed to delete video. Please try again.");
  }
}
// Utility: Sanitize inputs for security
function sanitize(str) {
  const temp = document.createElement('div');
  temp.textContent = str;
  return temp.innerHTML;
}

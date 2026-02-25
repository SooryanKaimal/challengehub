import { auth, db } from './firebase-config.js';
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from './cloudinary-config.js';
import { 
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { 
  collection, doc, setDoc, getDoc, addDoc, updateDoc, onSnapshot, 
  query, orderBy, limit, serverTimestamp, runTransaction, getDocs, where, deleteDoc,
  increment // <--- ADD THIS
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
  if (document.getElementById('single-video-container')) initSingleVideo();
  if (document.getElementById('rewards-container')) initRewards();
  if (document.getElementById('public-profile-container')) initPublicProfile();
  if (document.getElementById('search-container')) initSearch(); // <-- ADD THIS
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
// Auto-create or fetch Daily Challenge with Randomized Topics
async function setupDailyChallenge() {
  const challengeRef = doc(db, "challenges", "daily");
  const docSnap = await getDoc(challengeRef);
  const now = new Date();

  if (!docSnap.exists() || docSnap.data().expiresAt.toDate() < now) {
    // Array of possible challenges
    const challengeList = [
      { title: "Daily Challenge: Tell a Joke", description: "Record your best 30-second joke!" },
      { title: "Daily Challenge: Dance Off", description: "Show us your best dance move!" },
      { title: "Daily Challenge: Life Hack", description: "Share a useful life hack in 30 seconds." },
      { title: "Daily Challenge: Lip Sync", description: "Lip sync to your favorite song snippet!" },
      { title: "Daily Challenge: Hidden Talent", description: "What's a weird talent you have?" }
    ];
    
    // Pick a random challenge from the list
    const randomChallenge = challengeList[Math.floor(Math.random() * challengeList.length)];
    randomChallenge.expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h from now

    await setDoc(challengeRef, randomChallenge);
    currentChallengeId = "daily_" + now.getTime(); 
    renderChallenge(randomChallenge);
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
// === 4. FEED & ENGAGEMENT LOGIC (LINKED TO DEDICATED PAGE) ===
// === 4. FEED & ENGAGEMENT LOGIC (LINKED TO DEDICATED PAGE & PUBLIC PROFILE) ===
// === 4. FEED & ENGAGEMENT LOGIC (WITH FOLLOWING FILTER) ===
let currentFeedMode = 'global'; 
let myFollowingList = new Set(); 

async function listenToFeed() {
  // Set up the toggle buttons
  const btnGlobal = document.getElementById('btn-global-feed');
  const btnFollowing = document.getElementById('btn-following-feed');

  // If buttons don't exist yet, just render the normal feed
  if (!btnGlobal || !btnFollowing) {
    return renderFeed();
  }

  btnGlobal.addEventListener('click', () => {
    currentFeedMode = 'global';
    btnGlobal.classList.add('active');
    btnFollowing.classList.remove('active');
    renderFeed(); 
  });

  btnFollowing.addEventListener('click', async () => {
    currentFeedMode = 'following';
    btnFollowing.classList.add('active');
    btnGlobal.classList.remove('active');
    
    // Fetch the list of people I follow
    const followingSnap = await getDocs(collection(db, `users/${currentUser.uid}/following`));
    myFollowingList.clear();
    followingSnap.forEach(doc => myFollowingList.add(doc.id));
    
    renderFeed(); 
  });

  renderFeed(); 
}

function renderFeed() {
  const q = query(collection(db, "videos"), orderBy("createdAt", "desc"));
  
  onSnapshot(q, (snapshot) => {
    const feed = document.getElementById('video-feed');
    if (!feed) return;
    feed.innerHTML = '';
    
    let videosShown = 0;

    snapshot.forEach((docSnap) => {
      const vid = docSnap.data();
      const vidId = docSnap.id;
      
      // FILTER: If on "following" tab, skip videos from users I don't follow
      if (currentFeedMode === 'following' && !myFollowingList.has(vid.userId)) {
        return; 
      }
      
      videosShown++;
      const card = document.createElement('div');
      card.className = 'card video-card';
      
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <a href="public-profile.html?id=${vid.userId}" style="margin: 0; font-size: 16px; font-weight: bold; color: white; text-decoration: none;">
            ${sanitize(vid.username)}
          </a>
        </div>
        
        <a href="video.html?id=${vidId}" style="display: block; text-decoration: none;">
          <div class="video-wrapper">
            <video id="vid-${vidId}" src="${vid.videoURL}#t=0.1" playsinline preload="metadata" muted loop></video>
            <div class="play-overlay">
              <div class="play-btn-icon"><div class="play-triangle"></div></div>
            </div>
          </div>
        </a>

        <div class="video-actions">
          <button class="like-btn" id="like-${vidId}">❤️ <span id="like-count-${vidId}">${vid.likes || 0}</span></button>
          <a href="video.html?id=${vidId}" style="color: var(--primary-color); font-size: 14px; text-decoration: none; display: flex; align-items: center; gap: 5px;">
            💬 View Video
          </a>
        </div>
      `;
      feed.appendChild(card);

      const newVideoElement = document.getElementById(`vid-${vidId}`);
      if (newVideoElement && typeof feedVideoObserver !== 'undefined') feedVideoObserver.observe(newVideoElement);

      setupLikeSystem(vidId, vid.userId);
    });

    if (videosShown === 0 && currentFeedMode === 'following') {
      feed.innerHTML = `<p style="text-align: center; color: #aaa; margin-top: 20px;">You aren't following anyone yet! Go check out the Global feed to find creators.</p>`;
    }
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
// === 5. LEADERBOARD (MODERNIZED & LINKED TO PROFILES) ===
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
      const userId = docSnap.id; // We need this ID for the link!
      
      // Determine Medals & Classes
      let medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `<span style="color:#aaa;">${rank}.</span>`;
      let rankClass = rank <= 3 ? `rank-${rank}` : '';
      
      let username = u.username || (u.email ? u.email.split('@')[0] : 'User');
      let badgesHtml = (u.badges || []).map(b => b.split(" ")[0]).join(""); // Extract the emojis
      
      list.innerHTML += `
        <li class="leaderboard-item ${rankClass}">
          <div class="leaderboard-user">
            <span style="width: 25px; text-align: center; display: inline-block;">${medal}</span>
            <a href="public-profile.html?id=${userId}" style="text-decoration: none; color: white;">
              ${sanitize(username)} ${badgesHtml}
            </a>
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
      const badgesHtml = (data.badges || []).map(b => b.split(" ")[0]).join(""); // Extracts just the emoji from the badge name
      document.getElementById('profile-username').innerText = (data.username || "Unknown User") + " " + badgesHtml;
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


// === 7. SINGLE VIDEO PAGE LOGIC ===
async function initSingleVideo() {
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get('id');
  if (!videoId) return window.location.href = 'index.html';

  const videoRef = doc(db, "videos", videoId);
  const videoSnap = await getDoc(videoRef);
  
  if (!videoSnap.exists()) {
    alert("Video not found!");
    return window.location.href = 'index.html';
  }

  const vidData = videoSnap.data();
  
  // Populate UI
  document.getElementById('main-video').src = vidData.videoURL;
  document.getElementById('video-author').innerText = "@" + sanitize(vidData.username);
  document.getElementById('video-like-count').innerText = vidData.likes || 0;

  // Video Click to Play/Pause
  const mainVid = document.getElementById('main-video');
  mainVid.addEventListener('click', () => {
    mainVid.paused ? mainVid.play() : mainVid.pause();
  });

  // Setup Video Like
  setupLikeSystem(videoId, vidData.userId); // Reuse existing like logic
  // Map the sidebar heart icon to trigger the hidden like logic
  document.getElementById('video-like-btn').addEventListener('click', () => {
    document.getElementById(`like-${videoId}`).click();
    const isLiked = document.getElementById(`like-${videoId}`).classList.contains('liked');
    document.getElementById('video-like-btn').querySelector('.icon').innerText = isLiked ? '❤️' : '🤍';
  });

  // Share API Setup
  document.getElementById('share-btn').addEventListener('click', async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Check out this video by ${vidData.username} on ChallengeHub!`,
          url: window.location.href
        });
      } catch (err) { console.log("Share cancelled or failed.", err); }
    } else {
      // Fallback for desktop
      navigator.clipboard.writeText(window.location.href);
      alert("Link copied to clipboard!");
    }
  });

  // Comments Bottom Sheet Toggle
  const sheet = document.getElementById('comments-sheet');
  document.getElementById('open-comments-btn').addEventListener('click', () => sheet.classList.remove('hidden'));
  document.getElementById('close-comments-btn').addEventListener('click', () => sheet.classList.add('hidden'));

  // Setup Advanced Comments (Replies & Likes)
  initAdvancedComments(videoId);
}

function initAdvancedComments(videoId) {
  let replyingToId = null; 
  let replyingToName = "";

  const list = document.getElementById('sheet-comments-list');
  const input = document.getElementById('sheet-comment-input');
  const postBtn = document.getElementById('sheet-post-comment');
  const indicator = document.getElementById('replying-indicator');

  // Real-time listener for Comments
  const q = query(collection(db, `videos/${videoId}/comments`), orderBy("createdAt", "asc"));
  onSnapshot(q, (snap) => {
    list.innerHTML = '';
    document.getElementById('video-comment-count').innerText = snap.size;

    const comments = [];
    snap.forEach(d => comments.push({ id: d.id, ...d.data() }));

    // Separate Top-level and Replies
    const topLevel = comments.filter(c => !c.parentId);
    const replies = comments.filter(c => c.parentId);

    topLevel.forEach(c => {
      // Create top level comment HTML
      const div = document.createElement('div');
      div.className = 'single-comment';
      div.innerHTML = `
        <div class="comment-top">
          <span class="comment-author">@${sanitize(c.username)}</span>
          <span class="like-comment-btn" data-cid="${c.id}">🤍 ${c.likes || 0}</span>
        </div>
        <div class="comment-text">${sanitize(c.text)}</div>
        <div class="comment-actions">
          <span class="reply-btn" data-cid="${c.id}" data-cname="${c.username}">Reply</span>
        </div>
        <div class="reply-block" id="replies-to-${c.id}"></div>
      `;
      list.appendChild(div);

      // Append its replies
      const specificReplies = replies.filter(r => r.parentId === c.id);
      const replyContainer = div.querySelector(`#replies-to-${c.id}`);
      specificReplies.forEach(r => {
        replyContainer.innerHTML += `
          <div class="single-comment" style="margin-bottom: 10px;">
            <div class="comment-top"><span class="comment-author">@${sanitize(r.username)}</span></div>
            <div class="comment-text">${sanitize(r.text)}</div>
          </div>
        `;
      });
    });

    // Attach Comment Like Listeners
    document.querySelectorAll('.like-comment-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const cid = e.target.getAttribute('data-cid');
        const cRef = doc(db, `videos/${videoId}/comments`, cid);
        const cSnap = await getDoc(cRef);
        await updateDoc(cRef, { likes: (cSnap.data().likes || 0) + 1 });
      });
    });

    // Attach Reply Listeners
    document.querySelectorAll('.reply-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        replyingToId = e.target.getAttribute('data-cid');
        replyingToName = e.target.getAttribute('data-cname');
        indicator.classList.remove('hidden');
        document.getElementById('replying-to-name').innerText = "@" + replyingToName;
        input.focus();
      });
    });
  });

  // Cancel Reply
  document.getElementById('cancel-reply-btn').addEventListener('click', () => {
    replyingToId = null;
    indicator.classList.add('hidden');
  });

  // Post Comment / Reply
  postBtn.addEventListener('click', async () => {
    const text = input.value.trim();
    if(!text) return;
    input.value = '';

    const uname = localStorage.getItem('ch_username') || (currentUser.email ? currentUser.email.split('@')[0] : "User");

    const payload = {
      userId: currentUser.uid,
      username: uname,
      text: text,
      likes: 0,
      createdAt: serverTimestamp(),
      parentId: replyingToId // Null if it's a top-level comment, has an ID if it's a reply
    };

    await addDoc(collection(db, `videos/${videoId}/comments`), payload);
    
    // Reset reply state
    replyingToId = null;
    indicator.classList.add('hidden');
  });
}

// === 8. REWARDS STORE LOGIC ===
function initRewards() {
  const userRef = doc(db, "users", currentUser.uid);

  // 1. Listen for user's current points and badges
  onSnapshot(userRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data();
      const points = data.points || 0;
      const badges = data.badges || [];

      // Update UI
      document.getElementById('store-user-points').innerText = points;
      
      const badgesContainer = document.getElementById('my-badges-list');
      badgesContainer.innerHTML = badges.length > 0 
        ? badges.map(b => `<span style="background: #333; padding: 5px 10px; border-radius: 20px; font-size: 14px;">${b}</span>`).join('')
        : "<p style='color: #aaa;'>You don't own any badges yet.</p>";
    }
  });

  // 2. Handle Purchasing
  document.querySelectorAll('.purchase-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const badgeName = e.target.getAttribute('data-badge');
      const cost = parseInt(e.target.getAttribute('data-cost'));

      const userDoc = await getDoc(userRef);
      if (!userDoc.exists()) return;
      
      const data = userDoc.data();
      const currentPoints = data.points || 0;
      const currentBadges = data.badges || [];

      // Check if they already own it
      if (currentBadges.includes(badgeName)) {
        return alert("You already own this badge!");
      }

      // Check if they can afford it
      if (currentPoints < cost) {
        return alert(`Not enough points! You need ${cost - currentPoints} more points to buy this.`);
      }

      // Confirm purchase
      if (confirm(`Buy "${badgeName}" for ${cost} points?`)) {
        try {
          e.target.disabled = true;
          e.target.innerText = "Buying...";

          await updateDoc(userRef, {
            points: currentPoints - cost,
            badges: [...currentBadges, badgeName] // Add the new badge to their array
          });

          alert("Purchase successful! The badge has been added to your profile.");
        } catch (error) {
          console.error("Purchase failed:", error);
          alert("Something went wrong. Please try again.");
        } finally {
          e.target.disabled = false;
          e.target.innerText = "Buy";
        }
      }
    });
  });
}

// === 9. PERFORMANCE: INTERSECTION OBSERVER ===
// Watches videos on the screen and only plays the ones currently in view
const feedVideoObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const video = entry.target;
    if (entry.isIntersecting) {
      // Video is on screen - play it silently
      video.play().catch(err => console.log("Autoplay prevented by browser:", err));
    } else {
      // Video scrolled off screen - pause it to save battery/memory
      video.pause();
    }
  });
}, {
  rootMargin: "0px",
  threshold: 0.6 // 60% of the video must be visible to trigger play
});


// === 10. PUBLIC PROFILE & FOLLOW SYSTEM ===
async function initPublicProfile() {
  const urlParams = new URLSearchParams(window.location.search);
  const targetUserId = urlParams.get('id');

  // If they click their own profile link, redirect to their personal profile
  if (!targetUserId || targetUserId === currentUser.uid) {
    return window.location.href = 'profile.html';
  }

  const targetUserRef = doc(db, "users", targetUserId);
  const followBtn = document.getElementById('follow-btn');
  const followDocRef = doc(db, `users/${targetUserId}/followers`, currentUser.uid);
  const myFollowingDocRef = doc(db, `users/${currentUser.uid}/following`, targetUserId);

  // 1. Load User Stats & Badges
  onSnapshot(targetUserRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data();
      const badgesHtml = (data.badges || []).map(b => b.split(" ")[0]).join("");
      
      document.getElementById('public-username').innerText = (data.username || "User") + " " + badgesHtml;
      document.getElementById('public-followers').innerText = data.followersCount || 0;
      document.getElementById('public-following').innerText = data.followingCount || 0;
      document.getElementById('public-likes').innerText = data.totalLikes || 0;
    } else {
      alert("User not found!");
      window.location.href = 'index.html';
    }
  });

  // 2. Load User Videos
  const q = query(collection(db, "videos"), where("userId", "==", targetUserId));
  onSnapshot(q, (snap) => {
    const grid = document.getElementById('public-video-grid');
    grid.innerHTML = '';
    document.getElementById('public-videos-count').innerText = snap.size;
    
    snap.forEach(docSnap => {
      const vid = docSnap.data();
      const vidId = docSnap.id;
      grid.innerHTML += `
        <a href="video.html?id=${vidId}">
          <video src="${vid.videoURL}#t=0.1" preload="metadata" style="width: 100%; height: 120px; object-fit: cover; border-radius: 4px;"></video>
        </a>
      `;
    });
  });

  // 3. Check Initial Follow Status
  getDoc(followDocRef).then(snap => {
    if (snap.exists()) {
      followBtn.innerText = "Following";
      followBtn.style.background = "#555"; // Make it look grayed out
      followBtn.classList.add('is-following');
    }
  });

  // 4. Handle Follow/Unfollow Clicks
  followBtn.addEventListener('click', async () => {
    followBtn.disabled = true;
    const isFollowing = followBtn.classList.contains('is-following');
    const myUserRef = doc(db, "users", currentUser.uid);

    try {
      if (isFollowing) {
        // UNFOLLOW LOGIC
        await deleteDoc(followDocRef);
        await deleteDoc(myFollowingDocRef);
        await updateDoc(targetUserRef, { followersCount: increment(-1) });
        await updateDoc(myUserRef, { followingCount: increment(-1) });
        
        followBtn.innerText = "Follow";
        followBtn.style.background = "var(--primary-color)";
        followBtn.classList.remove('is-following');
      } else {
        // FOLLOW LOGIC
        await setDoc(followDocRef, { timestamp: serverTimestamp() });
        await setDoc(myFollowingDocRef, { timestamp: serverTimestamp() });
        await updateDoc(targetUserRef, { followersCount: increment(1) });
        await updateDoc(myUserRef, { followingCount: increment(1) });
        
        followBtn.innerText = "Following";
        followBtn.style.background = "#555";
        followBtn.classList.add('is-following');
      }
    } catch (error) {
      console.error("Error updating follow status:", error);
      alert("Something went wrong.");
    } finally {
      followBtn.disabled = false;
    }
  });
}

// === 11. SEARCH SYSTEM ===
function initSearch() {
  const searchInput = document.getElementById('search-input');
  const resultsContainer = document.getElementById('search-results');

  // Listen for every keystroke the user types
  searchInput.addEventListener('input', async (e) => {
    const searchTerm = e.target.value.trim();
    
    // If the box is empty, reset the screen
    if (searchTerm.length < 1) {
      resultsContainer.innerHTML = '<p style="text-align: center; color: var(--text-muted); margin-top: 40px;">Type a username to start searching.</p>';
      return;
    }

    try {
      // The Firestore trick for "startsWith" string matching
      const q = query(
        collection(db, "users"),
        where("username", ">=", searchTerm),
        where("username", "<=", searchTerm + '\uf8ff'),
        limit(10)
      );

      const snapshot = await getDocs(q);
      
      if (snapshot.empty) {
        resultsContainer.innerHTML = '<p style="text-align: center; color: var(--text-muted); margin-top: 40px;">No users found.</p>';
        return;
      }

      // Clear the loading text and display the users
      resultsContainer.innerHTML = '';
      
      snapshot.forEach(docSnap => {
        const u = docSnap.data();
        const userId = docSnap.id;
        
        // Hide the current user from their own search results
        if (userId === currentUser.uid) return;

        // Grab any badges the user has bought
        const badgesHtml = (u.badges || []).map(b => b.split(" ")[0]).join("");
        
        const userCard = document.createElement('div');
        userCard.className = 'card';
        userCard.style.padding = '12px 15px';
        userCard.style.marginBottom = '10px';
        
        // Make the entire card a clickable link to their public profile
        userCard.innerHTML = `
          <a href="public-profile.html?id=${userId}" style="display: flex; justify-content: space-between; align-items: center; text-decoration: none; color: white;">
            <span style="font-weight: bold; font-size: 16px;">${sanitize(u.username)} ${badgesHtml}</span>
            <span style="color: var(--text-muted); font-size: 14px;">${u.followersCount || 0} Followers</span>
          </a>
        `;
        resultsContainer.appendChild(userCard);
      });

    } catch (error) {
      console.error("Search error:", error);
    }
  });
}
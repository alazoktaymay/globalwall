const socket = io();

const wrapper = document.getElementById('document-wrapper');
const container = document.getElementById('entries-container');
const loadMoreEl = document.getElementById('load-more');
const totalBadge = document.getElementById('total-badge');
const onlineBadge = document.getElementById('online-badge');
const quotaRemainingEl = document.getElementById('quota-remaining');
const quotaTimerEl = document.getElementById('quota-timer');
const form = document.getElementById('composer-form');
const textInput = document.getElementById('text-input');
const charCounter = document.getElementById('char-counter');
const submitBtn = document.getElementById('submit-btn');
const statusMsg = document.getElementById('status-msg');
const toggleAuthorsBtn = document.getElementById('toggle-authors-btn');
const leaderboardBtn = document.getElementById('leaderboard-btn');
const usernameModal = document.getElementById('username-modal');
const usernameForm = document.getElementById('username-form');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const usernameError = document.getElementById('username-error');
const leaderboardModal = document.getElementById('leaderboard-modal');
const closeLeaderboardBtn = document.getElementById('close-leaderboard-btn');
const leaderboardList = document.getElementById('leaderboard-list');

let currentUsername = localStorage.getItem('ortak_metin_username') || '';
let currentToken = localStorage.getItem('ortak_metin_token') || '';
let isAdmin = false;
let showAuthors = localStorage.getItem('ortak_metin_show_authors') !== 'false';

function applyAdminMode(adminFlag) {
  isAdmin = Boolean(adminFlag);
  document.body.classList.toggle('admin-mode', isAdmin);
  if (isAdmin) {
    textInput.removeAttribute('maxlength');
    textInput.disabled = false;
    submitBtn.disabled = false;
    quotaRemainingEl.textContent = '∞';
    quotaTimerEl.textContent = 'Admin';
  }
}

async function initAuth() {
  if (currentUsername && currentToken) {
    try {
      const res = await fetch('/api/verify-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUsername, token: currentToken }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        currentUsername = data.username;
        applyAdminMode(data.isAdmin);
        updateQuotaUI();
        return;
      }
    } catch {
      // ignore and show modal
    }
  }
  usernameModal.hidden = false;
  setTimeout(() => usernameInput.focus(), 50);
}

initAuth();

function applyAuthorVisibility() {
  container.classList.toggle('hide-authors', !showAuthors);
  toggleAuthorsBtn.textContent = showAuthors ? 'Authors: On' : 'Authors: Off';
  toggleAuthorsBtn.classList.toggle('off', !showAuthors);
}

applyAuthorVisibility();

toggleAuthorsBtn.addEventListener('click', () => {
  showAuthors = !showAuthors;
  localStorage.setItem('ortak_metin_show_authors', String(showAuthors));
  applyAuthorVisibility();
});

usernameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const val = usernameInput.value.trim().slice(0, 24);
  const password = passwordInput.value;
  if (!val || password.length < 4) return;

  usernameError.textContent = '';
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: val, password }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      usernameError.textContent = data.error || 'Authentication failed.';
      return;
    }

    currentUsername = data.username;
    currentToken = data.token;
    localStorage.setItem('ortak_metin_username', currentUsername);
    localStorage.setItem('ortak_metin_token', currentToken);
    usernameModal.hidden = true;
    applyAdminMode(data.isAdmin);
    updateQuotaUI();
    textInput.focus();
  } catch {
    usernameError.textContent = 'Could not connect to server.';
  }
});

function renderLeaderboard(items) {
  if (!items || items.length === 0) {
    leaderboardList.innerHTML = '<div class="lb-row">No entries yet.</div>';
    return;
  }
  leaderboardList.innerHTML = '';
  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'lb-row';

    const rank = document.createElement('span');
    rank.className = 'lb-rank';
    rank.textContent = `#${idx + 1}`;

    const name = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = item.username;

    const score = document.createElement('span');
    score.className = 'lb-score';
    score.textContent = `${item.chars} chars`;

    row.append(rank, name, score);
    leaderboardList.appendChild(row);
  });
}

leaderboardBtn.addEventListener('click', async () => {
  leaderboardModal.hidden = false;
  const res = await fetch('/api/leaderboard');
  const data = await res.json();
  renderLeaderboard(data);
});

closeLeaderboardBtn.addEventListener('click', () => {
  leaderboardModal.hidden = true;
});

leaderboardModal.addEventListener('click', (e) => {
  if (e.target === leaderboardModal) leaderboardModal.hidden = true;
});

let oldestId = null;
let hasMore = false;
let isLoadingMore = false;
let totalCount = 0;

let quota = {
  remaining: 500,
  maxChars: 500,
  resetAt: Date.now() + 5 * 60 * 1000,
};

// --- Copy / Paste / Cut / Drop / Sağ Tık Engelleme (Admin hariç) ---
const blockedEvents = ['copy', 'paste', 'cut', 'drop', 'contextmenu'];
blockedEvents.forEach((evt) => {
  document.addEventListener(evt, (e) => {
    if (!isAdmin) e.preventDefault();
  });
});

document.addEventListener('keydown', (e) => {
  if (!isAdmin && (e.ctrlKey || e.metaKey) && ['c', 'v', 'x'].includes(e.key.toLowerCase())) {
    e.preventDefault();
  }
});

// --- DOM Yardımcıları ---
function createEntryElement(entry) {
  const div = document.createElement('div');
  div.className = 'entry-item';
  div.dataset.id = entry.id;

  const author = document.createElement('span');
  author.className = 'entry-author';
  author.textContent = entry.username || 'Anonim';

  const body = document.createElement('span');
  body.textContent = entry.text; // XSS koruması için textContent

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'delete-entry-btn';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => {
    socket.emit('delete_entry', { id: entry.id, username: currentUsername, token: currentToken });
  });

  div.append(author, body, delBtn);
  return div;
}

function isNearBottom() {
  return wrapper.scrollHeight - wrapper.scrollTop - wrapper.clientHeight < 100;
}

function scrollToBottom() {
  wrapper.scrollTop = wrapper.scrollHeight;
}

function updateTotalBadge(count) {
  totalCount = count;
  totalBadge.textContent = `${totalCount} entries`;
}

// --- İlk Yükleme ve Sonsuz Kaydırma (Yukarı Doğru) ---
async function loadInitialEntries() {
  const res = await fetch('/api/entries?limit=60');
  const data = await res.json();

  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  data.entries.forEach((entry) => frag.appendChild(createEntryElement(entry)));
  container.appendChild(frag);

  if (data.entries.length > 0) {
    oldestId = data.entries[0].id;
  }
  hasMore = data.hasMore;
  loadMoreEl.hidden = !hasMore;
  updateTotalBadge(data.totalCount);
  scrollToBottom();
}

async function loadOlderEntries() {
  if (!hasMore || isLoadingMore || !oldestId) return;
  isLoadingMore = true;
  loadMoreEl.hidden = false;

  const prevScrollHeight = wrapper.scrollHeight;
  const prevScrollTop = wrapper.scrollTop;

  try {
    const res = await fetch(`/api/entries?before=${oldestId}&limit=60`);
    const data = await res.json();

    if (data.entries.length > 0) {
      const frag = document.createDocumentFragment();
      data.entries.forEach((entry) => frag.appendChild(createEntryElement(entry)));
      container.prepend(frag);
      oldestId = data.entries[0].id;

      // Kullanıcının okuduğu yeri kaybetmemesi için scroll pozisyonunu koru
      const newScrollHeight = wrapper.scrollHeight;
      wrapper.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    }

    hasMore = data.hasMore;
    loadMoreEl.hidden = !hasMore;
  } finally {
    isLoadingMore = false;
  }
}

wrapper.addEventListener('scroll', () => {
  if (wrapper.scrollTop < 120 && hasMore && !isLoadingMore) {
    loadOlderEntries();
  }
});

// --- Kota ve Geri Sayım ---
function updateQuotaUI() {
  if (isAdmin) {
    quotaRemainingEl.textContent = '∞';
    textInput.removeAttribute('maxlength');
    textInput.disabled = false;
    submitBtn.disabled = false;
    statusMsg.textContent = '';
    updateCharCounter();
    return;
  }

  quotaRemainingEl.textContent = quota.remaining;
  textInput.maxLength = quota.remaining > 0 ? quota.remaining : 0;

  if (quota.remaining <= 0) {
    textInput.disabled = true;
    submitBtn.disabled = true;
    statusMsg.textContent = 'Character limit reached. Please wait for the timer to reset.';
  } else {
    textInput.disabled = false;
    submitBtn.disabled = false;
    if (statusMsg.textContent.includes('Character limit reached')) {
      statusMsg.textContent = '';
    }
  }
  updateCharCounter();
}

function updateCharCounter() {
  const len = textInput.value.length;
  charCounter.textContent = isAdmin ? `${len} / ∞` : `${len} / ${quota.remaining}`;
}

setInterval(() => {
  if (isAdmin) {
    quotaTimerEl.textContent = 'Admin';
    return;
  }
  const diff = Math.max(0, quota.resetAt - Date.now());
  const totalSec = Math.ceil(diff / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const sec = String(totalSec % 60).padStart(2, '0');
  quotaTimerEl.textContent = `${min}:${sec}`;

  if (diff === 0 && quota.remaining < quota.maxChars) {
    fetch('/api/quota')
      .then((r) => r.json())
      .then((q) => {
        quota = q;
        updateQuotaUI();
      });
  }
}, 1000);

// --- Socket Olayları ---
socket.on('quota_update', (q) => {
  quota = q;
  updateQuotaUI();
});

socket.on('new_entry', (entry) => {
  const shouldScroll = isNearBottom();
  container.appendChild(createEntryElement(entry));
  if (!oldestId) oldestId = entry.id;
  updateTotalBadge(totalCount + 1);
  if (shouldScroll) {
    scrollToBottom();
  }
});

socket.on('leaderboard_update', (items) => {
  if (!leaderboardModal.hidden) {
    renderLeaderboard(items);
  }
});

socket.on('online_count', (count) => {
  onlineBadge.textContent = `${count} online`;
});

socket.on('entry_deleted', ({ id }) => {
  const el = container.querySelector(`.entry-item[data-id="${id}"]`);
  if (el) {
    el.remove();
    updateTotalBadge(Math.max(0, totalCount - 1));
  }
});

// --- Form Gönderimi ---
textInput.addEventListener('input', updateCharCounter);

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;

  if (!isAdmin) {
    const digitsOnly = text.replace(/[\s\-().+]/g, '');
    if (/(?:\+?90|0)?5\d{9}/.test(digitsOnly) || /\b\d{10,13}\b/.test(digitsOnly)) {
      statusMsg.textContent = 'Sharing phone numbers is not allowed.';
      return;
    }
    if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) {
      statusMsg.textContent = 'Sharing email addresses is not allowed.';
      return;
    }
    if (/\bTR\s*\d{2}[\s\d]{20,26}\b/i.test(text)) {
      statusMsg.textContent = 'Sharing IBANs is not allowed.';
      return;
    }
  }

  submitBtn.disabled = true;
  statusMsg.textContent = '';

  socket.emit('submit_text', { text, username: currentUsername || 'Anonim' }, (res) => {
    if (res?.ok) {
      textInput.value = '';
      quota = res.quota;
      updateQuotaUI();
    } else {
      statusMsg.textContent = res?.error || 'An error occurred.';
      if (res?.quota) {
        quota = res.quota;
        updateQuotaUI();
      }
    }
  });
});

loadInitialEntries();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const WINDOW_MS = 5 * 60 * 1000; // 5 dakika
const MAX_CHARS = 500;           // 5 dakikada 500 karakter

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'entries.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Kayıtlı kullanıcılar: Map<lowerUsername, { username, salt, hash, token }>
let usersMap = new Map();
if (fs.existsSync(USERS_FILE)) {
  try {
    const rawUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (Array.isArray(rawUsers)) {
      // Eski format uyumluluğu
      rawUsers.forEach((u) => {
        if (typeof u === 'string') {
          usersMap.set(u.toLowerCase(), { username: u, salt: null, hash: null, token: null });
        } else if (u && u.username) {
          usersMap.set(u.username.toLowerCase(), u);
        }
      });
    }
  } catch {
    usersMap = new Map();
  }
}

function saveUsers() {
  fs.writeFile(USERS_FILE, JSON.stringify(Array.from(usersMap.values())), (err) => {
    if (err) console.error('Kullanıcılar kaydedilemedi:', err);
  });
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  const hash = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

// Bellek içi veri (hızlı sayfalama için)
let entries = [];
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    entries = JSON.parse(raw);
  } catch (err) {
    console.error('Veri dosyası okunamadı, sıfırdan başlatılıyor:', err);
    entries = [];
  }
}

let nextId = entries.length > 0 ? entries[entries.length - 1].id + 1 : 1;

function saveEntries() {
  fs.writeFile(DATA_FILE, JSON.stringify(entries), (err) => {
    if (err) console.error('Veri kaydedilemedi:', err);
  });
}

// IP bazlı rate limit deposu: Map<ip, { used: number, resetAt: number }>
const quotaMap = new Map();

function getClientIp(reqOrSocket) {
  const headers = reqOrSocket.headers || reqOrSocket.handshake?.headers || {};
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return (
    reqOrSocket.ip ||
    reqOrSocket.handshake?.address ||
    reqOrSocket.socket?.remoteAddress ||
    'unknown'
  );
}

function getQuota(ip) {
  const now = Date.now();
  let record = quotaMap.get(ip);
  if (!record || now >= record.resetAt) {
    record = { used: 0, resetAt: now + WINDOW_MS };
    quotaMap.set(ip, record);
  }
  return {
    remaining: Math.max(0, MAX_CHARS - record.used),
    maxChars: MAX_CHARS,
    resetAt: record.resetAt,
    windowMs: WINDOW_MS,
  };
}

// Belirli aralıklarla süresi dolmuş IP kayıtlarını temizle (bellek optimizasyonu)
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of quotaMap.entries()) {
    if (now >= record.resetAt) {
      quotaMap.delete(ip);
    }
  }
}, 60 * 1000);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Kayıt / Giriş (Şifreli + Otomatik Token)
app.post('/api/auth', (req, res) => {
  const rawUser = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const username = rawUser.slice(0, 24);

  if (!username || password.length < 4) {
    return res.status(400).json({ ok: false, error: 'Username and password (min 4 chars) are required.' });
  }

  const lower = username.toLowerCase();
  const existing = usersMap.get(lower);

  if (existing && existing.hash && existing.salt) {
    // Mevcut hesap: şifre doğrula
    if (!verifyPassword(password, existing.salt, existing.hash)) {
      return res.status(401).json({ ok: false, error: 'Incorrect password for this username.' });
    }
    if (!existing.token) {
      existing.token = crypto.randomBytes(32).toString('hex');
      saveUsers();
    }
    return res.json({
      ok: true,
      username: existing.username,
      token: existing.token,
      isAdmin: lower === 'rollpass',
    });
  }

  // Yeni hesap oluştur
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const token = crypto.randomBytes(32).toString('hex');

  usersMap.set(lower, { username, salt, hash, token });
  saveUsers();

  res.json({
    ok: true,
    username,
    token,
    isAdmin: lower === 'rollpass',
  });
});

// Kayıtlı token ile otomatik oturum doğrulama
app.post('/api/verify-token', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!username || !token) {
    return res.status(401).json({ ok: false });
  }
  const user = usersMap.get(username.toLowerCase());
  if (!user || !user.token || user.token !== token) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true, username: user.username, isAdmin: username.toLowerCase() === 'rollpass' });
});

// Sayfalı veri çekme (Sonsuz kaydırma için)
app.get('/api/entries', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 60, 100);
  const beforeId = req.query.before ? parseInt(req.query.before, 10) : null;

  let slice;
  let hasMore = false;

  if (beforeId) {
    const idx = entries.findIndex((e) => e.id === beforeId);
    const endIdx = idx === -1 ? entries.length : idx;
    const startIdx = Math.max(0, endIdx - limit);
    slice = entries.slice(startIdx, endIdx);
    hasMore = startIdx > 0;
  } else {
    const startIdx = Math.max(0, entries.length - limit);
    slice = entries.slice(startIdx);
    hasMore = startIdx > 0;
  }

  res.json({
    entries: slice,
    hasMore,
    totalCount: entries.length,
  });
});

// --- Küfür ve Kişisel Bilgi (Telefon, E-posta, IBAN) Filtresi ---
const BAD_WORDS = [
  'amk', 'aq', 'mk', 'mq', 'sg', 'oç', 'oc', 'piç', 'pic', 'orospu', 'oruspu',
  'sik', 'siktir', 'sikim', 'sikeyim', 'yarrak', 'yarak', 'amına', 'amina',
  'amcık', 'amcik', 'göt', 'got', 'götveren', 'gotveren', 'ibne', 'puşt', 'pust',
  'kahpe', 'kaltak', 'sürtük', 'surtuk', 'pezevenk', 'gavat', 'yavşak', 'yavsak',
  'mal', 'gerizekalı', 'gerizekali', 'aptal', 'salak', 'embesil', 'fuck', 'shit',
  'bitch', 'asshole', 'bastard', 'dick', 'pussy', 'whore', 'slut'
];

function normalizeForFilter(str) {
  return str
    .toLowerCase()
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/(.)\1{2,}/g, '$1$1');
}

function checkContentViolation(text) {
  // 1. Telefon numarası kontrolü (boşluk, tire, parantez, nokta dahil 10-13 rakam)
  const digitsOnly = text.replace(/[\s\-().+]/g, '');
  if (/(?:\+?90|0)?5\d{9}/.test(digitsOnly) || /\b\d{10,13}\b/.test(digitsOnly)) {
    return 'Sharing phone numbers is not allowed.';
  }
  // 2. E-posta kontrolü
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) {
    return 'Sharing email addresses is not allowed.';
  }
  // 3. IBAN kontrolü
  if (/\bTR\s*\d{2}[\s\d]{20,26}\b/i.test(text)) {
    return 'Sharing IBANs is not allowed.';
  }
  // 4. Küfür / hakaret kontrolü
  const normalized = normalizeForFilter(text);
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    if (BAD_WORDS.includes(w)) {
      return 'Inappropriate language or profanity detected.';
    }
  }
  // Araya nokta/boşluk koyarak gizlenen küfürler için birleşik kontrol
  const compact = normalized.replace(/[^a-z]/g, '');
  for (const bad of BAD_WORDS) {
    if (bad.length >= 4 && compact.includes(bad)) {
      return 'Inappropriate language or profanity detected.';
    }
  }
  return null;
}

function getLeaderboard() {
  const counts = new Map();
  for (const e of entries) {
    const name = e.username || 'Anonim';
    const current = counts.get(name) || { username: name, chars: 0, posts: 0 };
    current.chars += e.text.length;
    current.posts += 1;
    counts.set(name, current);
  }
  return Array.from(counts.values())
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 20);
}

app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

app.get('/api/quota', (req, res) => {
  const ip = getClientIp(req);
  res.json(getQuota(ip));
});

io.on('connection', (socket) => {
  const ip = getClientIp(socket);
  socket.emit('quota_update', getQuota(ip));
  io.emit('online_count', io.engine.clientsCount);

  socket.on('disconnect', () => {
    io.emit('online_count', io.engine.clientsCount);
  });

  socket.on('submit_text', (payload, callback) => {
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!text) {
      return callback?.({ ok: false, error: 'Text cannot be empty.' });
    }

    const rawName = typeof payload?.username === 'string' ? payload.username.trim() : '';
    const username = rawName ? rawName.slice(0, 24) : 'Anonim';
    const isAdmin = username.toLowerCase() === 'rollpass';

    if (!isAdmin) {
      const violation = checkContentViolation(text);
      if (violation) {
        return callback?.({ ok: false, error: violation });
      }
    }

    const quota = getQuota(ip);
    if (!isAdmin && text.length > quota.remaining) {
      return callback?.({
        ok: false,
        error: `Insufficient character quota. Remaining: ${quota.remaining}`,
        quota,
      });
    }

    // Admin değilse kotadan düş
    if (!isAdmin) {
      const record = quotaMap.get(ip);
      record.used += text.length;
    }

    const entry = {
      id: nextId++,
      username,
      text,
      createdAt: Date.now(),
    };

    entries.push(entry);
    saveEntries();

    // Herkese anlık yayınla
    io.emit('new_entry', entry);
    io.emit('leaderboard_update', getLeaderboard());

    const updatedQuota = getQuota(ip);
    socket.emit('quota_update', updatedQuota);
    callback?.({ ok: true, entry, quota: updatedQuota });
  });

  // Sadece rollpass (admin) yazı silebilir (token doğrulamalı)
  socket.on('delete_entry', (payload, callback) => {
    const username = typeof payload?.username === 'string' ? payload.username.trim().toLowerCase() : '';
    const token = typeof payload?.token === 'string' ? payload.token : '';
    const user = usersMap.get(username);
    if (username !== 'rollpass' || !user || !user.token || user.token !== token) {
      return callback?.({ ok: false, error: 'Unauthorized.' });
    }

    const id = parseInt(payload?.id, 10);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      return callback?.({ ok: false, error: 'Entry not found.' });
    }

    entries.splice(idx, 1);
    saveEntries();

    io.emit('entry_deleted', { id });
    io.emit('leaderboard_update', getLeaderboard());
    callback?.({ ok: true });
  });
});

server.listen(PORT, () => {
  console.log(`Ortak Metin sunucusu http://localhost:${PORT} adresinde çalışıyor`);
});

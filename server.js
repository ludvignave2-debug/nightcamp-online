const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const STARTING_BALANCE = 100;
const MAX_BALANCE = null; // No upper cap: players can win above 100 Scrap.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));

// Private admin authentication. Keep the secret only in Render -> Environment as ADMIN_SECRET.
const ADMIN_SECRET = String(process.env.ADMIN_SECRET || '').trim();
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const adminSessions = new Map();

app.use(express.json({ limit: '32kb' }));

function safeSecretEqual(input) {
  const a = Buffer.from(String(input || '').trim());
  const b = Buffer.from(ADMIN_SECRET);
  return !!ADMIN_SECRET && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}
function getBearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}
function requireAdmin(req, res, next) {
  const token = getBearer(req);
  const expires = adminSessions.get(token);
  if (!token || !expires || expires <= Date.now()) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ ok: false, error: 'Admin-session udløbet.' });
  }
  // Sliding expiry while actively used.
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  next();
}

fs.mkdirSync(DATA_DIR, { recursive: true });
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = {}; }
function saveUsers() {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function newUser(name='Player') {
  const token = newToken();
  users[token] = { token, name: cleanName(name), balance: STARTING_BALANCE, createdAt: Date.now(), games: 0, wins: 0 };
  saveUsers();
  return users[token];
}
function accountFromToken(token) { return token && users[token] ? users[token] : null; }
function cleanName(name) {
  const v = String(name || 'Player').replace(/[<>]/g, '').trim().slice(0, 20);
  return v || 'Player';
}
function accountPayload(user) {
  return { token: user.token, name: user.name, balance: Number(user.balance.toFixed(2)), games: user.games || 0, wins: user.wins || 0 };
}

app.get('/api/admin/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, configured: Boolean(ADMIN_SECRET) });
});

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_SECRET) return res.status(503).json({ ok: false, error: 'ADMIN_SECRET mangler på Render.' });
  if (!safeSecretEqual(req.body?.secret)) return res.status(403).json({ ok: false, error: 'Forkert admin-kode.' });
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, session: newAdminSession() });
});

app.get('/api/admin/status', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.post('/api/admin/scrap', requireAdmin, (req, res) => {
  const targetToken = String(req.body?.targetToken || '').trim();
  const user = accountFromToken(targetToken);
  if (!user) return res.status(404).json({ ok: false, error: 'Spillerkonto blev ikke fundet.' });

  const mode = String(req.body?.mode || '');
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ ok: false, error: 'Ugyldigt Scrap-beløb.' });

  if (mode === 'add') user.balance = Number(user.balance || 0) + amount;
  else if (mode === 'set') user.balance = amount;
  else return res.status(400).json({ ok: false, error: 'Ugyldig admin-handling.' });

  // No maximum balance cap; only prevent negative/non-finite balances.
  if (!Number.isFinite(user.balance)) return res.status(400).json({ ok: false, error: 'Ugyldig balance.' });
  user.balance = Math.max(0, user.balance);
  saveUsers();
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, account: accountPayload(user) });
});

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

app.get('/api/cases', (_, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json(cases);
});

// Exact Rust/Steam skin previews (C2).
// Uses Steam Market search JSON first; this is more reliable on Render than parsing the listing HTML.
const rustSkinNames = new Set(Object.values(cases).flatMap(c => (c.items || []).map(i => String(i.name || '').trim())).filter(Boolean));
const steamSkinAliases = new Map([
  ['No Mercy', 'No Mercy SAR'],
  ['Tempered MP5', 'Tempered Mp5']
]);
const skinImageCache = new Map();
function steamGetText(url, accept = 'application/json,text/plain,*/*', depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept': accept,
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://steamcommunity.com/market/'
    }, timeout: 9000 }, resp => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && depth < 3) {
        resp.resume(); return resolve(steamGetText(new URL(resp.headers.location, url).toString(), accept, depth + 1));
      }
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('Steam status ' + resp.statusCode)); }
      let body = '';
      resp.setEncoding('utf8');
      resp.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(new Error('Steam response too large')); });
      resp.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('Steam timeout')));
    req.on('error', reject);
  });
}
function normalizeSkinName(v){ return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,' '); }
async function resolveSteamSkinImage(marketName) {
  const q = encodeURIComponent(marketName);
  const searchURL = `https://steamcommunity.com/market/search/render/?query=${q}&start=0&count=20&search_descriptions=0&sort_column=popular&sort_dir=desc&appid=252490&norender=1&l=english`;
  try {
    const text = await steamGetText(searchURL);
    const data = JSON.parse(text);
    const wanted = normalizeSkinName(marketName);
    const rows = Array.isArray(data.results) ? data.results : [];
    let hit = rows.find(r => normalizeSkinName(r.hash_name || r.name) === wanted);
    if (!hit) hit = rows.find(r => normalizeSkinName(r.name) === wanted);
    if (!hit && rows.length === 1) hit = rows[0];
    const icon = hit?.asset_description?.icon_url_large || hit?.asset_description?.icon_url;
    if (icon) return `https://community.fastly.steamstatic.com/economy/image/${icon}/512fx512f`;
  } catch (e) {}

  // Fallback to the listing HTML in case Steam changes the search response.
  const listingURL = 'https://steamcommunity.com/market/listings/252490/' + encodeURIComponent(marketName) + '?l=english';
  const page = await steamGetText(listingURL, 'text/html,application/xhtml+xml');
  const tag = page.match(/<img[^>]*id=["']market_listing_item_img["'][^>]*>/i)?.[0] || '';
  let image = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || '';
  image = image.replace(/&amp;/g, '&');
  if (image.startsWith('//')) image = 'https:' + image;
  if (!/^https:\/\/[^/]*steamstatic\.com\//i.test(image)) throw new Error('No exact Steam market image');
  return image;
}
app.get('/api/skin-image', async (req, res) => {
  const requested = String(req.query?.name || '').trim().slice(0, 100);
  if (!rustSkinNames.has(requested)) return res.status(404).end();
  const marketName = steamSkinAliases.get(requested) || requested;
  const key = marketName.toLowerCase();
  const cached = skinImageCache.get(key);
  if (cached?.url) { res.set('Cache-Control', 'public, max-age=86400'); return res.redirect(302, cached.url); }
  // Failed lookups only stay cached for 10 minutes, so a temporary Steam block self-recovers.
  if (cached?.failedAt && Date.now() - cached.failedAt < 10 * 60 * 1000) return res.status(404).end();
  try {
    const image = await resolveSteamSkinImage(marketName);
    skinImageCache.set(key, { url: image });
    res.set('Cache-Control', 'public, max-age=86400');
    return res.redirect(302, image);
  } catch (err) {
    console.warn('[skin-image]', marketName, err.message);
    skinImageCache.set(key, { failedAt: Date.now() });
    return res.status(404).end();
  }
});
// Small diagnostic endpoint so Render can tell us if a named skin resolves.
app.get('/api/skin-image-status', async (req, res) => {
  const requested = String(req.query?.name || 'Punishment Mask').trim().slice(0, 100);
  if (!rustSkinNames.has(requested)) return res.status(404).json({ok:false,error:'skin-not-in-cases'});
  try {
    const marketName = steamSkinAliases.get(requested) || requested;
    const image = await resolveSteamSkinImage(marketName);
    return res.json({ok:true,name:requested,marketName,image});
  } catch (err) {
    return res.status(502).json({ok:false,name:requested,error:err.message});
  }
});

app.get('/health', (_, res) => res.json({
  ok: true,
  users: Object.keys(users).length,
  cases: Object.keys(cases).length,
  adminConfigured: Boolean(ADMIN_SECRET),
  frontend: fs.existsSync(INDEX_FILE)
}));

app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => {
  if (!fs.existsSync(INDEX_FILE)) return res.status(500).type('text').send('NIGHTCAMP frontend missing: public/index.html');
  res.sendFile(INDEX_FILE);
});

const rooms = new Map();
const formats = {
  '1v1': { players: 2, teams: [[0],[1]] },
  '2v2': { players: 4, teams: [[0,1],[2,3]] },
  '3v3': { players: 6, teams: [[0,1,2],[3,4,5]] },
  '1v1v1': { players: 3, teams: [[0],[1],[2]] },
  '1v1v1v1': { players: 4, teams: [[0],[1],[2],[3]] }
};
const rules = new Set(['normal','cursed','jackpot','cursedjackpot','lastdrop']);

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  do { out = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(out));
  return out;
}
function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    cases: room.cases,
    players: room.players.map((p, i) => {
      const user = accountFromToken(p.token);
      return { id: p.id, name: p.name, ready: p.ready, seat: i, balance: user ? Number(user.balance.toFixed(2)) : 0 };
    })
  };
}
function broadcast(room) { io.to(room.code).emit('room:update', publicRoom(room)); }
function getRoomForSocket(socket) {
  for (const room of rooms.values()) if (room.players.some(p => p.id === socket.id)) return room;
  return null;
}
function leaveCurrent(socket) {
  const room = getRoomForSocket(socket);
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.leave(room.code);
  if (!room.players.length) { rooms.delete(room.code); return; }
  if (room.hostId === socket.id) room.hostId = room.players[0].id;
  if (room.phase !== 'battle') room.phase = 'lobby';
  broadcast(room);
}
function requireAccount(socket, token) {
  const user = accountFromToken(token || socket.data.accountToken);
  if (!user) return null;
  socket.data.accountToken = user.token;
  return user;
}
function selectedEntry(caseKeys) {
  return caseKeys.reduce((sum, key) => sum + (cases[key]?.price || 0), 0);
}
function mulberry32(seed) {
  return function() { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function drawLoot(caseKey, rng) {
  const arr = cases[caseKey].items, total = arr.reduce((s,x)=>s+x.w,0);
  let r = rng()*total;
  for (const x of arr) { r -= x.w; if (r <= 0) return x; }
  return arr[arr.length-1];
}
function sideTotals(format, totals) { return format.teams.map(team => team.reduce((s, seat) => s + Number(totals[seat] || 0), 0)); }
function weightedDraw(weights, inverse, rng) {
  const safe = weights.map(v => Math.max(Number(v)||0, .01));
  const t = inverse ? safe.map(v => 1/v) : safe.slice();
  const total = t.reduce((a,b)=>a+b,0), roll = rng();
  let cursor = 0, winner = t.length - 1;
  for (let i=0;i<t.length;i++) { cursor += t[i]/total; if (roll < cursor) { winner=i; break; } }
  return { winner, roll };
}
function resolveBattle(settings, format, totals, lastDrops, rng) {
  const vals = sideTotals(format, totals);
  if (settings.rule === 'jackpot') return { winner: weightedDraw(vals,false,rng).winner, sideVals: vals };
  if (settings.rule === 'cursedjackpot') return { winner: weightedDraw(vals,true,rng).winner, sideVals: vals };
  if (settings.rule === 'lastdrop') {
    const ld = sideTotals(format, lastDrops.map(x => x?.value || 0));
    return { winner: ld.indexOf(Math.max(...ld)), sideVals: ld };
  }
  if (settings.rule === 'cursed') return { winner: vals.indexOf(Math.min(...vals)), sideVals: vals };
  return { winner: vals.indexOf(Math.max(...vals)), sideVals: vals };
}
function simulateBattle(room, seed) {
  const format = formats[room.settings.format], rng = mulberry32(seed >>> 0);
  const totals = Array(format.players).fill(0); let lastDrops = Array(format.players).fill(null);
  for (const key of room.cases) {
    const drops = Array.from({length: format.players}, () => drawLoot(key, rng));
    lastDrops = drops;
    drops.forEach((d,i)=> totals[i] += d.value);
    // Client consumes 24 RNG calls per player for reel filler after drawing each round.
    for (let p=0;p<format.players;p++) for (let n=0;n<24;n++) rng();
  }
  const resolution = resolveBattle(room.settings, format, totals, lastDrops, rng);
  return { totals, lastDrops: lastDrops.map(x=>x?.value||0), winnerSide: resolution.winner, sideVals: resolution.sideVals };
}

io.on('connection', socket => {
  socket.on('account:init', (payload = {}, ack = () => {}) => {
    let user = accountFromToken(String(payload.token || ''));
    if (!user) user = newUser(payload.name);
    if (payload.name) { user.name = cleanName(payload.name); saveUsers(); }
    socket.data.accountToken = user.token;
    ack({ ok: true, account: accountPayload(user), startingBalance: STARTING_BALANCE });
  });

  socket.on('room:create', (payload = {}, ack = () => {}) => {
    const user = requireAccount(socket, payload.token);
    if (!user) return ack({ ok:false, error:'Account not ready. Refresh the page.' });
    leaveCurrent(socket);
    const code = roomCode();
    const settings = payload.settings || { format: '1v1', rule: 'normal' };
    const caseKeys = Array.isArray(payload.cases) ? payload.cases.filter(k=>cases[k]).slice(0,10) : [];
    const formatKey = formats[settings.format] ? settings.format : '1v1';
    const rule = rules.has(String(settings.rule)) ? String(settings.rule) : 'normal';
    user.name = cleanName(payload.name || user.name); saveUsers();
    const room = { code, hostId: socket.id, phase: 'lobby', settings:{format:formatKey,rule}, cases:caseKeys, players:[{id:socket.id,token:user.token,name:user.name,ready:true}] };
    rooms.set(code, room); socket.join(code);
    ack({ ok:true, room:publicRoom(room), account:accountPayload(user) }); broadcast(room);
  });

  socket.on('room:join', (payload = {}, ack = () => {}) => {
    const user = requireAccount(socket, payload.token);
    if (!user) return ack({ ok:false, error:'Account not ready. Refresh the page.' });
    leaveCurrent(socket);
    const code = String(payload.code || '').trim().toUpperCase(), room = rooms.get(code);
    if (!room) return ack({ ok:false, error:'Room not found.' });
    if (room.phase === 'battle') return ack({ ok:false, error:'Battle already started.' });
    const capacity = formats[room.settings.format].players;
    if (room.players.length >= capacity) return ack({ ok:false, error:'Battle is full.' });
    if (room.players.some(p=>p.token===user.token)) return ack({ ok:false, error:'This account is already in the room.' });
    user.name = cleanName(payload.name || user.name); saveUsers();
    room.players.push({id:socket.id,token:user.token,name:user.name,ready:false}); socket.join(code);
    ack({ ok:true, room:publicRoom(room), account:accountPayload(user) }); broadcast(room);
  });

  socket.on('room:leave', () => leaveCurrent(socket));
  socket.on('room:ready', ready => {
    const room = getRoomForSocket(socket); if (!room) return;
    const p = room.players.find(x=>x.id===socket.id); if (!p) return;
    p.ready = socket.id===room.hostId ? true : !!ready; broadcast(room);
  });
  socket.on('room:settings', (payload = {}) => {
    const room = getRoomForSocket(socket); if (!room || room.hostId!==socket.id || room.phase!=='lobby') return;
    if (payload.settings) {
      if (formats[payload.settings.format]) room.settings.format = payload.settings.format;
      if (rules.has(String(payload.settings.rule))) room.settings.rule = String(payload.settings.rule);
    }
    if (Array.isArray(payload.cases)) room.cases = payload.cases.filter(k=>cases[k]).slice(0,10);
    const capacity = formats[room.settings.format].players;
    if (room.players.length > capacity) room.players = room.players.slice(0,capacity);
    broadcast(room);
  });

  socket.on('battle:start', (ack = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return ack({ok:false,error:'No room.'});
    if (room.hostId!==socket.id) return ack({ok:false,error:'Only the host can start.'});
    const format = formats[room.settings.format], capacity = format.players;
    if (room.players.length!==capacity) return ack({ok:false,error:`Need ${capacity} players.`});
    if (!room.cases.length) return ack({ok:false,error:'Choose at least one case.'});
    if (room.players.some(p=>!p.ready)) return ack({ok:false,error:'Everyone must be ready.'});
    const entry = selectedEntry(room.cases);
    const accounts = room.players.map(p=>accountFromToken(p.token));
    const poor = accounts.findIndex(u=>!u || u.balance + 1e-9 < entry);
    if (poor>=0) return ack({ok:false,error:`${room.players[poor].name} needs ${entry.toFixed(2)} Scrap to enter.`});

    room.phase='battle';
    const before = new Map(accounts.map(u=>[u.token,u.balance]));
    accounts.forEach(u=>{u.balance-=entry;u.games=(u.games||0)+1;});
    const seed = crypto.randomBytes(4).readUInt32LE(0);
    const result = simulateBattle(room, seed);
    const winningSeats = format.teams[result.winnerSide];
    const pot = entry * format.players, share = pot / winningSeats.length;
    for (const seat of winningSeats) { const u=accounts[seat]; u.balance += share; u.wins=(u.wins||0)+1; }
    saveUsers();

    const finalBalances={}, deltas={};
    room.players.forEach((p,i)=>{ finalBalances[p.id]=Number(accounts[i].balance.toFixed(2)); deltas[p.id]=Number((accounts[i].balance-before.get(accounts[i].token)).toFixed(2)); });
    const settlement={ entry:Number(entry.toFixed(2)), pot:Number(pot.toFixed(2)), winnerSide:result.winnerSide, finalBalances, deltas, serverTotals:result.totals, serverSideVals:result.sideVals };
    io.to(room.code).emit('battle:go',{room:publicRoom(room),seed,settlement});
    ack({ok:true});
  });

  socket.on('battle:returnLobby', () => {
    const room = getRoomForSocket(socket); if (!room || room.hostId!==socket.id) return;
    room.phase='lobby'; room.players.forEach(p=>{p.ready=p.id===room.hostId;}); broadcast(room);
  });
  socket.on('disconnect', () => leaveCurrent(socket));
});

server.listen(PORT, () => console.log(`NIGHTCAMP online running on port ${PORT} · new players start with ${STARTING_BALANCE.toFixed(2)} Scrap`));

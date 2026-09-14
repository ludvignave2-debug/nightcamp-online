const path = require('path');
const fs = require('fs');
const http = require('http');
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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/cases', (_, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json(cases);
});
app.get('/health', (_, res) => res.json({ ok: true, users: Object.keys(users).length, cases: Object.keys(cases).length }));

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

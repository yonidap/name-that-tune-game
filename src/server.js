import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { songs } from '../data/songs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const STEAL_MS = Math.max(100, Number(process.env.STEAL_MS || 10_000));
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GAME_LENGTHS = {
  short: { easy: 5, medium: 5, hard: 5 },
  normal: { easy: 7, medium: 7, hard: 7 },
  full: { easy: 14, medium: 18, hard: 12 }
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon'
};

function token() { return crypto.randomBytes(18).toString('base64url'); }
function makeRoomCode() {
  for (let tries = 0; tries < 50; tries += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to allocate room code');
}
function shuffle(input) {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function spreadArtists(input, priorArtists = []) {
  const pool = shuffle(input);
  const arranged = [];
  const history = [...priorArtists];
  while (pool.length) {
    let bestDistance = -1;
    let bestIndexes = [];
    for (let i = 0; i < pool.length; i += 1) {
      const lastIndex = history.lastIndexOf(pool[i].artist);
      const distance = lastIndex === -1 ? Infinity : history.length - 1 - lastIndex;
      if (distance > bestDistance) { bestDistance = distance; bestIndexes = [i]; }
      else if (distance === bestDistance) bestIndexes.push(i);
    }
    const chosenIndex = bestIndexes[Math.floor(Math.random() * bestIndexes.length)];
    const [chosen] = pool.splice(chosenIndex, 1);
    arranged.push(chosen);
    history.push(chosen.artist);
  }
  return arranged;
}
function scoringFor(duration) {
  const d = duration;
  return [
    { until: 0.20 * d, points: 10 }, { until: 0.40 * d, points: 9 }, { until: 0.60 * d, points: 8 },
    { until: 0.80 * d, points: 7 }, { until: 0.999 * d, points: 6 }, { until: 1.333 * d, points: 5 },
    { until: 1.666 * d, points: 4 }, { until: 1.999 * d, points: 3 }, { until: 2.000 * d, points: 2 }
  ].map((tier) => ({ until: Number(tier.until.toFixed(3)), points: tier.points }));
}
function makePlaylist(lengthKey) {
  const counts = GAME_LENGTHS[lengthKey] || GAME_LENGTHS.normal;
  const playlist = [];
  const artistHistory = [];
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const selected = shuffle(songs.filter((song) => song.difficulty === difficulty)).slice(0, counts[difficulty]);
    const ordered = spreadArtists(selected, artistHistory);
    playlist.push(...ordered.map((song) => ({ ...song, scoring: scoringFor(song.duration) })));
    artistHistory.push(...ordered.map((song) => song.artist));
  }
  return playlist;
}
function currentSong(room) { return room.currentIndex >= 0 ? room.playlist[room.currentIndex] : null; }
function getPoints(song, totalHeardSeconds) {
  if (!song) return 10;
  const exposure = Math.max(0, Math.min(Number(totalHeardSeconds) || 0, song.duration * 2));
  return song.scoring.find((tier) => exposure <= tier.until)?.points ?? 2;
}
function roundLabel(difficulty) { return difficulty === 'easy' ? 'EASY' : difficulty === 'medium' ? 'MEDIUM' : 'HARD'; }
function cleanCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); }
function cleanName(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return text || fallback;
}
function touch(room) { room.updatedAt = Date.now(); }
function connectionStatus(room) {
  const clients = [...room.clients];
  return {
    display: clients.some((client) => client.role === 'display'),
    host: clients.some((client) => client.role === 'host'),
    A: clients.some((client) => client.role === 'captain' && client.team === 'A'),
    B: clients.some((client) => client.role === 'captain' && client.team === 'B')
  };
}
function readyToStart(room) {
  const c = connectionStatus(room);
  return room.phase === 'LOBBY' && c.display && c.host && c.A && c.B && room.audioReady;
}
function publicState(room, role, team = null) {
  const song = currentSong(room);
  const common = {
    roomCode: room.code, phase: room.phase, round: room.round, roundLabel: roundLabel(room.round),
    currentIndex: room.currentIndex, totalSongs: room.playlist.length, activeTeam: room.activeTeam, turnOwner: room.turnOwner,
    scores: room.scores, teamNames: room.teamNames, listenedSeconds: Number(room.audioPosition.toFixed(2)),
    totalHeardSeconds: Number(room.totalHeardSeconds.toFixed(2)), currentPoints: room.currentPoints,
    duration: song?.duration ?? 0, playbacksCompleted: room.playbacksCompleted, maxPlaybacks: 2,
    awaitingReplay: room.awaitingReplay, replayStarted: room.replayStarted,
    canPlay: Boolean(song && room.playbacksCompleted < 2 && room.totalHeardSeconds < song.duration * 2),
    connected: connectionStatus(room), audioReady: room.audioReady, stealDeadline: room.stealDeadline,
    songNumber: room.currentIndex + 1, canControl: team ? room.activeTeam === team : false,
    readyToStart: readyToStart(room), audioFallback: room.audioFallback, undoAvailable: room.history.length > 0
  };
  if (role === 'host') {
    return { ...common, gameLength: room.gameLength, captainClaimed: { A: Boolean(room.captainTokens.A), B: Boolean(room.captainTokens.B) },
      song: song ? { id: song.id, title: song.title, artist: song.artist, difficulty: song.difficulty, duration: song.duration, sourceStart: song.sourceStart } : null };
  }
  if (role === 'display') {
    return { ...common, gameLength: room.gameLength, song: song ? {
      id: song.id, difficulty: song.difficulty, audioFile: song.audioFile, duration: song.duration,
      ...(room.phase === 'REVEAL' || room.phase === 'FINISHED' ? { title: song.title, artist: song.artist } : {})
    } : null };
  }
  return { ...common, song: song ? { difficulty: song.difficulty, duration: song.duration } : null };
}
function sendSse(client, event, data) { try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
function broadcastState(room) { touch(room); for (const client of room.clients) sendSse(client, 'state', publicState(room, client.role, client.team)); }
function sendDisplayEvent(room, event, data = {}) { for (const client of room.clients) if (client.role === 'display') sendSse(client, event, data); }
function clearStealTimer(room) { if (room.stealTimer) clearTimeout(room.stealTimer); room.stealTimer = null; }
function reveal(room) { clearStealTimer(room); room.phase = 'REVEAL'; room.revealed = true; room.stealDeadline = null; }
function scheduleStealExpiry(room) {
  clearStealTimer(room);
  if (room.phase !== 'STEAL' || !room.stealDeadline) return;
  const expectedDeadline = room.stealDeadline;
  const delay = Math.max(0, expectedDeadline - Date.now());
  room.stealTimer = setTimeout(() => {
    if (room.phase === 'STEAL' && room.stealDeadline === expectedDeadline) { reveal(room); broadcastState(room); }
  }, delay + 5);
  room.stealTimer.unref?.();
}
function snapshot(room) {
  room.history.push({
    phase: room.phase, currentIndex: room.currentIndex, round: room.round, activeTeam: room.activeTeam, turnOwner: room.turnOwner,
    scores: { ...room.scores }, audioPosition: room.audioPosition, totalHeardSeconds: room.totalHeardSeconds,
    currentPoints: room.currentPoints, playbacksCompleted: room.playbacksCompleted, awaitingReplay: room.awaitingReplay,
    replayStarted: room.replayStarted, playbackSeq: room.playbackSeq, revealed: room.revealed, stealDeadline: room.stealDeadline
  });
  if (room.history.length > 40) room.history.shift();
}
function restore(room, state) {
  clearStealTimer(room);
  Object.assign(room, state, { scores: { ...state.scores } });
  room.replayStarted = Boolean(state.replayStarted);
  if (room.phase === 'PLAYING') room.phase = 'PAUSED';
  if (room.phase === 'STEAL') scheduleStealExpiry(room);
}
function turnForIndex(playlist, index) {
  const song = playlist[index];
  if (!song) return 'A';
  const roundSongsBefore = playlist.slice(0, index).filter((item) => item.difficulty === song.difficulty).length;
  const roundStarter = song.difficulty === 'medium' ? 'B' : 'A';
  return roundSongsBefore % 2 === 0 ? roundStarter : (roundStarter === 'A' ? 'B' : 'A');
}
function resetSongState(room) {
  room.audioPosition = 0; room.totalHeardSeconds = 0; room.currentPoints = 10; room.playbacksCompleted = 0;
  room.awaitingReplay = false; room.replayStarted = false; room.playbackSeq = 0; room.revealed = false;
  room.audioFallback = null; room.stealDeadline = null; clearStealTimer(room);
}
function loadSong(room, index) {
  room.currentIndex = index;
  const song = currentSong(room);
  if (!song) { room.phase = 'FINISHED'; room.revealed = true; clearStealTimer(room); return; }
  const previousRound = room.round;
  room.round = song.difficulty;
  room.turnOwner = turnForIndex(room.playlist, index);
  room.activeTeam = room.turnOwner;
  resetSongState(room);
  room.phase = previousRound !== room.round || index === 0 ? 'ROUND_INTRO' : 'READY';
}
function startSteal(room) {
  room.activeTeam = room.turnOwner === 'A' ? 'B' : 'A';
  room.phase = 'STEAL';
  room.stealDeadline = Date.now() + STEAL_MS;
  scheduleStealExpiry(room);
}
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
  res.end(data);
}
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error('Body too large'); }
  return raw ? JSON.parse(raw) : {};
}
function roomOrError(code, res) { const room = rooms.get(cleanCode(code)); if (!room) json(res, 404, { ok: false, error: 'ROOM_NOT_FOUND' }); return room; }
function displayOk(room, suppliedToken) { return Boolean(suppliedToken && suppliedToken === room.displayToken); }
function hostOk(room, suppliedToken) { return Boolean(suppliedToken && suppliedToken === room.hostToken); }
function captainOk(room, team, suppliedToken) { return ['A', 'B'].includes(team) && Boolean(suppliedToken) && room.captainTokens[team] === suppliedToken; }
function closeCaptainClients(room, team) {
  for (const client of [...room.clients]) if (client.role === 'captain' && client.team === team) {
    room.clients.delete(client); try { client.res.end(); } catch {}
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { ok: false, error: 'INVALID_JSON' }); }

  if (url.pathname === '/api/display/create') {
    const code = makeRoomCode(); const displayToken = token(); const hostPin = String(1000 + Math.floor(Math.random() * 9000));
    const lengthKey = GAME_LENGTHS[body.gameLength] ? body.gameLength : 'normal'; const now = Date.now();
    const room = {
      code, displayToken, hostPin, hostToken: null, captainTokens: { A: null, B: null },
      teamNames: { A: cleanName(body.teamNames?.A, 'Team A'), B: cleanName(body.teamNames?.B, 'Team B') },
      playlist: makePlaylist(lengthKey), gameLength: lengthKey, phase: 'LOBBY', currentIndex: -1, round: 'easy',
      activeTeam: 'A', turnOwner: 'A', scores: { A: 0, B: 0 }, audioPosition: 0, totalHeardSeconds: 0,
      currentPoints: 10, playbacksCompleted: 0, awaitingReplay: false, replayStarted: false, playbackSeq: 0,
      revealed: false, audioReady: false, audioFallback: null, stealDeadline: null, stealTimer: null, history: [], clients: new Set(),
      createdAt: now, updatedAt: now
    };
    rooms.set(code, room);
    return json(res, 200, { ok: true, roomCode: code, displayToken, hostPin, state: publicState(room, 'display') });
  }
  if (url.pathname === '/api/display/resume') {
    const room = roomOrError(body.roomCode, res); if (!room) return;
    if (!displayOk(room, body.displayToken)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });
    return json(res, 200, { ok: true, roomCode: room.code, displayToken: room.displayToken, hostPin: room.hostPin, state: publicState(room, 'display') });
  }
  if (url.pathname === '/api/host/join') {
    const room = roomOrError(body.roomCode, res); if (!room) return;
    if (body.hostToken && room.hostToken === body.hostToken) return json(res, 200, { ok: true, hostToken: body.hostToken, state: publicState(room, 'host') });
    if (String(body.hostPin || '') !== room.hostPin) return json(res, 403, { ok: false, error: 'BAD_PIN' });
    if (!room.hostToken) room.hostToken = token();
    broadcastState(room);
    return json(res, 200, { ok: true, hostToken: room.hostToken, state: publicState(room, 'host') });
  }
  if (url.pathname === '/api/captain/join') {
    const room = roomOrError(body.roomCode, res); if (!room) return;
    const team = body.team;
    if (!['A', 'B'].includes(team)) return json(res, 400, { ok: false, error: 'INVALID_TEAM' });
    if (body.captainToken && room.captainTokens[team] === body.captainToken) return json(res, 200, { ok: true, captainToken: body.captainToken, state: publicState(room, 'captain', team) });
    if (room.captainTokens[team]) return json(res, 409, { ok: false, error: 'TEAM_TAKEN' });
    const captainToken = token(); room.captainTokens[team] = captainToken; broadcastState(room);
    return json(res, 200, { ok: true, captainToken, state: publicState(room, 'captain', team) });
  }

  if (url.pathname !== '/api/action') return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  const room = roomOrError(body.roomCode, res); if (!room) return;
  const action = String(body.action || '');
  if (action.startsWith('host:') && !hostOk(room, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });
  if (action.startsWith('display:') && !displayOk(room, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });
  if (action.startsWith('captain:') && !captainOk(room, body.team, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });

  if (action === 'host:start') {
    if (room.phase !== 'LOBBY') return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    if (!readyToStart(room)) return json(res, 409, { ok: false, error: 'ROOM_NOT_READY' });
    snapshot(room); loadSong(room, 0); broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'host:beginRound') {
    if (room.phase !== 'ROUND_INTRO') return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    snapshot(room); room.phase = 'READY'; broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'host:releaseCaptain') {
    if (room.phase !== 'LOBBY' || !['A', 'B'].includes(body.team)) return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    closeCaptainClients(room, body.team); room.captainTokens[body.team] = null; broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'host:restart') {
    if (room.phase !== 'FINISHED') return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    room.history = []; room.playlist = makePlaylist(room.gameLength); room.scores = { A: 0, B: 0 }; room.round = 'easy'; loadSong(room, 0);
    broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'display:audioReady') { room.audioReady = Boolean(body.ready); broadcastState(room); return json(res, 200, { ok: true }); }
  if (action === 'display:audioStatus') {
    const song = currentSong(room);
    if (!song || String(body.songId || '') !== song.id) return json(res, 200, { ok: true, ignored: true });
    room.audioFallback = Boolean(body.fallback); broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'display:playbackFailed') {
    if (Number(body.seq) === room.playbackSeq && room.phase === 'PLAYING') room.phase = 'PAUSED';
    room.audioReady = false; broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'captain:play') {
    const song = currentSong(room); const connected = connectionStatus(room);
    if (!song || room.activeTeam !== body.team || !['READY', 'PAUSED'].includes(room.phase) || room.playbacksCompleted >= 2 || !room.audioReady || !connected.display) {
      return json(res, 409, { ok: false, error: !room.audioReady || !connected.display ? 'AUDIO_NOT_READY' : 'NOT_ALLOWED' });
    }
    if (room.awaitingReplay && !room.replayStarted) {
      room.audioPosition = 0;
      room.awaitingReplay = false;
      room.replayStarted = true;
    }
    const startAt = room.audioPosition;
    room.playbackSeq += 1; room.phase = 'PLAYING';
    sendDisplayEvent(room, 'audio-play', { startAt, seq: room.playbackSeq });
    broadcastState(room);
    return json(res, 200, { ok: true, playbackSeq: room.playbackSeq, startAt });
  }
  if (action === 'captain:pause') {
    if (room.activeTeam !== body.team || room.phase !== 'PLAYING') return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    sendDisplayEvent(room, 'audio-pause', { seq: room.playbackSeq }); return json(res, 200, { ok: true });
  }
  if (action === 'display:audioProgress') {
    if (Number(body.seq) !== room.playbackSeq || !['PLAYING', 'PAUSED'].includes(room.phase) || room.awaitingReplay) return json(res, 200, { ok: true, ignored: true });
    const song = currentSong(room); if (!song) return json(res, 409, { ok: false, error: 'NO_SONG' });
    const position = Math.max(0, Math.min(Number(body.position) || 0, song.duration));
    room.audioPosition = Math.max(room.audioPosition, position);
    room.totalHeardSeconds = Math.min(song.duration * 2, room.playbacksCompleted * song.duration + room.audioPosition);
    room.currentPoints = getPoints(song, room.totalHeardSeconds);
    if (body.paused && room.phase === 'PLAYING') room.phase = 'PAUSED';
    broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'display:audioEnded') {
    if (Number(body.seq) !== room.playbackSeq || room.awaitingReplay || !['PLAYING', 'PAUSED'].includes(room.phase)) return json(res, 200, { ok: true, ignored: true });
    const song = currentSong(room); if (!song) return json(res, 409, { ok: false, error: 'NO_SONG' });
    room.playbacksCompleted = Math.min(2, room.playbacksCompleted + 1);
    room.audioPosition = song.duration;
    room.totalHeardSeconds = Math.min(song.duration * 2, room.playbacksCompleted * song.duration);
    room.currentPoints = getPoints(song, room.totalHeardSeconds);
    room.awaitingReplay = room.playbacksCompleted === 1;
    if (room.playbacksCompleted >= 2) room.replayStarted = true;
    room.phase = 'PAUSED'; broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'display:revealEnded') {
    if (room.phase !== 'REVEAL') return json(res, 200, { ok: true, ignored: true });
    const song = currentSong(room); const expectedFilename = song?.audioFile ? path.basename(song.audioFile) : '';
    if (!song || (body.filename && String(body.filename) !== expectedFilename)) return json(res, 200, { ok: true, ignored: true });
    snapshot(room); loadSong(room, room.currentIndex + 1); broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'captain:lockAnswer') {
    if (room.activeTeam !== body.team || !['READY', 'PAUSED'].includes(room.phase)) return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    if (room.totalHeardSeconds < 0.05) return json(res, 409, { ok: false, error: 'HEAR_SOMETHING_FIRST' });
    snapshot(room); room.phase = 'ANSWER_LOCKED'; broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'captain:dontKnow') {
    if (room.activeTeam !== body.team) return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    if (['READY', 'PAUSED'].includes(room.phase)) {
      if (room.totalHeardSeconds < 0.05) return json(res, 409, { ok: false, error: 'HEAR_SOMETHING_FIRST' });
      snapshot(room); startSteal(room); broadcastState(room); return json(res, 200, { ok: true, steal: true });
    }
    if (room.phase === 'STEAL') {
      snapshot(room); reveal(room); broadcastState(room); return json(res, 200, { ok: true, reveal: true });
    }
    return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
  }
  if (action === 'captain:lockSteal') {
    if (room.activeTeam !== body.team || room.phase !== 'STEAL' || !room.stealDeadline || Date.now() > room.stealDeadline) return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    snapshot(room); clearStealTimer(room); room.stealDeadline = null; room.phase = 'STEAL_LOCKED'; broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'host:markCorrect') {
    if (!['ANSWER_LOCKED', 'STEAL_LOCKED'].includes(room.phase)) return json(res, 409, { ok: false, error: 'ANSWER_NOT_LOCKED' });
    snapshot(room); const awarded = room.phase === 'STEAL_LOCKED' ? 1 : room.currentPoints; room.scores[room.activeTeam] += awarded;
    reveal(room); broadcastState(room); return json(res, 200, { ok: true, awarded });
  }
  if (action === 'host:markWrong') {
    if (room.phase === 'ANSWER_LOCKED') { snapshot(room); startSteal(room); broadcastState(room); return json(res, 200, { ok: true, steal: true }); }
    if (room.phase === 'STEAL_LOCKED') { snapshot(room); reveal(room); broadcastState(room); return json(res, 200, { ok: true, steal: false }); }
    return json(res, 409, { ok: false, error: 'ANSWER_NOT_LOCKED' });
  }
  if (action === 'host:reveal') {
    if (!['READY', 'PLAYING', 'PAUSED', 'ANSWER_LOCKED', 'STEAL', 'STEAL_LOCKED'].includes(room.phase)) return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    if (room.phase === 'PLAYING') sendDisplayEvent(room, 'audio-pause', { seq: room.playbackSeq });
    snapshot(room); reveal(room); broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'host:next') {
    if (room.phase !== 'REVEAL') return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    snapshot(room); loadSong(room, room.currentIndex + 1); broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'host:adjustScore') {
    if (!['A', 'B'].includes(body.team)) return json(res, 400, { ok: false, error: 'INVALID_TEAM' });
    snapshot(room); const delta = Math.max(-10, Math.min(10, Number(body.delta) || 0));
    room.scores[body.team] = Math.max(0, room.scores[body.team] + delta); broadcastState(room); return json(res, 200, { ok: true });
  }
  if (action === 'host:undo') {
    const previous = room.history.pop(); if (!previous) return json(res, 409, { ok: false, error: 'NO_HISTORY' });
    restore(room, previous); sendDisplayEvent(room, 'audio-pause', { seq: room.playbackSeq }); broadcastState(room); return json(res, 200, { ok: true });
  }
  return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
}

function handleEvents(req, res, url) {
  const code = cleanCode(url.searchParams.get('room')); const role = url.searchParams.get('role');
  const team = url.searchParams.get('team'); const suppliedToken = url.searchParams.get('token'); const room = rooms.get(code);
  if (!room) { res.writeHead(404); return res.end(); }
  if (role === 'display' && !displayOk(room, suppliedToken)) { res.writeHead(403); return res.end(); }
  if (role === 'host' && !hostOk(room, suppliedToken)) { res.writeHead(403); return res.end(); }
  if (role === 'captain' && !captainOk(room, team, suppliedToken)) { res.writeHead(403); return res.end(); }
  if (!['display', 'host', 'captain'].includes(role)) { res.writeHead(400); return res.end(); }
  if (role === 'display' && [...room.clients].some((client) => client.role === 'display')) { res.writeHead(409); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': connected\n\n');
  const client = { res, role, team: role === 'captain' ? team : null }; room.clients.add(client); sendSse(client, 'state', publicState(room, role, client.team)); broadcastState(room);
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);
  req.on('close', () => {
    clearInterval(heartbeat); room.clients.delete(client);
    if (role === 'display' && !connectionStatus(room).display) { room.audioReady = false; if (room.phase === 'PLAYING') room.phase = 'PAUSED'; }
    broadcastState(room);
  });
}
function serveStatic(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) { res.writeHead(405); return res.end(); }
  let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname === '/' || pathname === '/host' || pathname.startsWith('/join/') || pathname.startsWith('/control/') || pathname.startsWith('/screen/')) pathname = '/index.html';
  const filePath = path.resolve(publicDir, `.${pathname}`); const relative = path.relative(publicDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const headers = { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'cache-control': pathname.startsWith('/audio/') ? 'public, max-age=3600' : 'no-cache', 'x-content-type-options': 'nosniff' };
    res.writeHead(200, headers); if (req.method === 'HEAD') return res.end(); fs.createReadStream(filePath).pipe(res);
  });
}
export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/events' && req.method === 'GET') return handleEvents(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (error) {
      console.error(error); if (!res.headersSent) json(res, 500, { ok: false, error: 'INTERNAL_ERROR' }); else res.end();
    }
  });
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const server = createServer();
  setInterval(() => {
    const staleBefore = Date.now() - 12 * 60 * 60 * 1000;
    for (const [code, room] of rooms.entries()) if (room.updatedAt < staleBefore && room.clients.size === 0) { clearStealTimer(room); rooms.delete(code); }
  }, 30 * 60 * 1000).unref();
  server.listen(PORT, () => console.log(`Name That Tune running on http://localhost:${PORT}`));
}

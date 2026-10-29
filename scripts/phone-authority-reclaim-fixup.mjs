import fs from 'node:fs';

const file = 'src/server.js';
let s = fs.readFileSync(file, 'utf8');
const oldText = `    if (room.captainTokens[team]) {
      const connected = connectionStatus(room)[team];
      const justClaimed = room.captainClaimedAt?.[team] && Date.now() - room.captainClaimedAt[team] < 3000;
      if (connected || justClaimed) return json(res, 409, { ok: false, error: 'TEAM_TAKEN' });
`;
const newText = `    if (room.captainTokens[team]) {
      const liveStream = [...room.clients].some((client) => client.role === 'captain' && client.team === team);
      const recentHeartbeat = room.lastSeen?.[team] && Date.now() - room.lastSeen[team] < 3000;
      const justClaimed = room.captainClaimedAt?.[team] && Date.now() - room.captainClaimedAt[team] < 3000;
      if (liveStream || recentHeartbeat || justClaimed) return json(res, 409, { ok: false, error: 'TEAM_TAKEN' });
`;
if (!s.includes(oldText)) throw new Error('captain takeover block not found');
s = s.replace(oldText, newText);
fs.writeFileSync(file, s);
console.log('Captain takeover guard aligned with polling heartbeat.');

import assert from 'node:assert/strict';
import fs from 'node:fs';

const game = fs.readFileSync('public/game.js', 'utf8');
const interaction = fs.readFileSync('public/interaction-ui.js', 'utf8');

assert.match(game, /captainToken = result\.captainToken \|\| saved\.captainToken/, 'captain restore must use the token returned by the server');
assert.match(game, /ntt-captain-active-\$\{roomCode\}/, 'captain join must persist the active team');
assert.match(game, /candidate = savedTeams\.find\(\(entry\) => entry\.team === activeTeam\)/, 'captain restore must prefer the active saved team instead of always Team A');
assert.match(interaction, /ntt-captain-active-\$\{roomCode\}/, 'reconnect controls must prefer the active team');
console.log('Captain session recovery test passed');

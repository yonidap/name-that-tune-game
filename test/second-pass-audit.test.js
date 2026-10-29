import assert from 'node:assert/strict';
import fs from 'node:fs';

const game = fs.readFileSync('public/game.js', 'utf8');
const interaction = fs.readFileSync('public/interaction-ui.js', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

assert.match(game, /let audioLoadGeneration = 0;/, 'audio loads need a generation guard');
assert.match(game, /let playbackCommandGeneration = 0;/, 'play commands need a cancellation generation');
assert.match(game, /generation !== audioLoadGeneration \|\| currentAudioKey !== key/, 'stale song loads must not replace the current source');
assert.match(game, /commandGeneration !== playbackCommandGeneration \|\| state\?\.song\?\.id !== songId/, 'STOP/REVEAL must cancel a pending PLAY');
assert.match(game, /playbackCommandGeneration \+= 1;\n  audio\.pause\(\);/, 'audio pause must invalidate pending play commands');
assert.match(game, /new AbortController\(\)/, 'main API requests need a finite timeout');
assert.match(interaction, /id = 'final-host-tools'/, 'host needs recovery controls after the final reveal');
assert.match(interaction, /host:adjustScore/, 'final score must remain correctable');
assert.match(interaction, /host:undo/, 'final state must expose undo');
assert.match(readme, /Full Battle \(44\)/, 'docs must match the 44-song full game');
assert.doesNotMatch(readme, /Full Battle \(40/, 'stale 40-song documentation must not return');

console.log('Second-pass client audit passed');

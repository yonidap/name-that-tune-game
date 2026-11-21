import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Browser-like MutationObserver harness. Writing textContent replaces child nodes,
// even when the text is unchanged. This previously retriggered the observer forever
// on the STEAL_LOCKED captain screen and starved the state polling heartbeat.
const source = fs.readFileSync('public/interaction-ui.js', 'utf8');

function mountCaptain(phase) {
  const documentRoot = { name:'document' };
  const appRoot = { name:'app' };
  const body = { name:'body', dataset:{ phase, round:'easy', connection:'online' } };
  const observationRecords = [];
  const queued = [];
  let writes = 0;
  let countdown;

  const enqueue = (target, type, attributeName = null) => {
    for (const record of observationRecords) {
      const matchesTarget = record.target === target ||
        (record.options.subtree && record.target === documentRoot);
      if (!matchesTarget) continue;
      if (type === 'childList' && !record.options.childList) continue;
      if (type === 'attributes' && (!record.options.attributes ||
          (record.options.attributeFilter && !record.options.attributeFilter.includes(attributeName)))) continue;
      queued.push(record.callback);
    }
  };
  const newCountdown = (initial = '10.0') => {
    let value = initial;
    return {
      classList:{ add() {} },
      get textContent() { return value; },
      set textContent(next) {
        value = String(next);
        writes += 1;
        enqueue(this, 'childList');
      }
    };
  };
  countdown = newCountdown();
  const document = {
    documentElement:documentRoot,
    body,
    querySelector(selector) {
      if (selector === '#app') return appRoot;
      if (selector === '#steal-countdown') return countdown;
      return null;
    }
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target, options) {
      observationRecords.push({ target, options, callback:this.callback });
    }
    disconnect() { observationRecords.length = 0; }
  }
  const context = {
    location:{pathname:'/join/ABCD'},
    localStorage:{getItem(){return null;}},
    document, MutationObserver,
    window:{addEventListener(){}}
  };
  vm.runInNewContext(source, context, { filename:'interaction-ui.js', timeout:1000 });

  const flush = (maximum = 30) => {
    let cycles = 0;
    while (queued.length && cycles < maximum) {
      queued.shift()();
      cycles += 1;
    }
    assert.ok(cycles < maximum, 'MutationObserver callback is self-triggering (captain UI freezes)');
    assert.equal(queued.length, 0, 'captain observer must reach quiescence');
    return cycles;
  };
  return {
    get writes() { return writes; },
    get countdown() { return countdown; },
    flush,
    changePhase(next) {
      body.dataset.phase = next;
      enqueue(body, 'attributes', 'data-phase');
      flush();
    },
    rerenderCountdown(value = '10.0') {
      countdown = newCountdown(value);
      enqueue(appRoot, 'childList');
      flush();
    },
    tickCountdown(value) {
      countdown.textContent = value;
      flush();
    },
    observedTargets: observationRecords
  };
}

const stolen = mountCaptain('STEAL_LOCKED');
stolen.flush();
assert.equal(stolen.countdown.textContent, 'LOCKED');
assert.equal(stolen.writes, 1, 'first STEAL_LOCKED render updates the countdown once');

// Changing the DOM in the captain's clock cannot trigger an endless observer chain.
stolen.rerenderCountdown();
assert.equal(stolen.countdown.textContent, 'LOCKED');
assert.equal(stolen.writes, 2, 'newly rendered countdown receives one update');

const waiting = mountCaptain('STEAL');
waiting.tickCountdown('9.9');
waiting.tickCountdown('9.8');
waiting.changePhase('STEAL_LOCKED');
assert.equal(waiting.countdown.textContent, 'LOCKED');
waiting.rerenderCountdown();
assert.equal(waiting.countdown.textContent, 'LOCKED');

// A rerender of #app must still trigger syncing controls, but changes inside the
// countdown must not cause repeated MutationObserver work.
assert.ok(stolen.observedTargets.some((item) => item.target.name === 'app' && item.options.childList && !item.options.subtree),
  'captain must observe app root replacement, not every descendant mutation');
assert.ok(stolen.observedTargets.some((item) => item.target.name === 'body' && item.options.attributes),
  'captain must observe phase and connectivity changes');

console.log('Steal locked captain DOM-freeze regression passed');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { leaseMonitorCall } from '../src/authorization.ts';
import { patchAcp } from '../integrations/patches.mjs';
const key = Symbol.for('pi-monitor.call-authority.v2');
const claim = (consumer, args = { command: 'status' }, id = 'call') => globalThis[key].claim(consumer, 's', 'bash', args, id);

test('guards claim independently; forged IDs, replay, mismatches, cancellation and expiry fail closed', () => {
  const signal = new AbortController();
  const lease = leaseMonitorCall('m', 's', 'bash', { command: 'status' }, signal.signal);
  try {
    assert.equal(claim('acp'), undefined);
    lease.run(() => {
      assert.equal(claim('acp', { command: 'write' }), undefined);
      assert.deepEqual(claim('legacy'), { monitorId: 'm' });
      // Simulate the old guard consuming its separate v1 entry.
      globalThis[Symbol.for('pi-monitor.call-leases.v1')].delete(lease.callId);
      assert.deepEqual(claim('acp'), { monitorId: 'm' });
      assert.equal(claim('acp'), undefined);
      assert.equal(claim('observer', undefined, 'different-call'), undefined);
      signal.abort();
      assert.equal(claim('observer'), undefined);
    });
  } finally { lease.release(); }
  const expired = leaseMonitorCall('m', 's', 'bash', { command: 'status' }, new AbortController().signal);
  const now = Date.now;
  try { Date.now = () => now() + 61_000; expired.run(() => assert.equal(claim('acp'), undefined)); }
  finally { Date.now = now; expired.release(); }
});

test('patched actual ACP: 100 leased polls preserve samples; foreground repeats still block', {
  skip: !process.env.PI_MONITOR_ACP_ROOT && 'Set PI_MONITOR_ACP_ROOT for actual ACP integration',
}, async () => {
  const root = process.env.PI_MONITOR_ACP_ROOT;
  for (const variant of ['pi-native.js', 'pi.js']) {
    const text = patchAcp(fs.readFileSync(`${root}/dist/agent/${variant}`, 'utf8'));
    const start = text.indexOf('var REPEAT_SLOW_CALL_MS=');
    const end = text.indexOf('import{', text.indexOf('function wireToolGuardrails(', start));
    assert.ok(start >= 0 && end > start);
    let now = 100000, aborts = 0, caps = 0;
    const handlers = new Map();
    const box = { createHash21: createHash, createHash9: createHash, Date: { now: () => now },
      REPETITION_GUARD_DEFAULTS: { warn: 3, abort: 4 }, RECOVERY_BACKSTOP_OFFSET: 4,
      DEFAULT_TOOL_OUTPUT_MAX_BYTES: 65536, isBashToolCall: () => true, resolveBashTimeout: () => 60,
      isBashToolResult: () => false, capToolOutput: () => { caps++; return undefined; },
      appendTrailingText: (content, text) => [...content, { type: 'text', text }],
    };
    // Bundler renames the imported crypto symbol across entrypoints.
    for (const name of text.slice(start, end).matchAll(/createHash\d+/g)) box[name[0]] = createHash;
    box[key] = globalThis[key];
    vm.createContext(box);
    vm.runInContext(text.slice(start, end) + ';globalThis.wire=wireToolGuardrails;', box);
    box.wire({ on: (event, fn) => handlers.set(event, fn) }, { repetition: { warn: 3, abort: 4 } });
    const ctx = { sessionManager: { getSessionId: () => 's' }, ui: { notify() {} }, abort() { aborts++; } };
    for (let i = 0; i < 100; i++) {
      now += 60_000;
      const args = { command: 'status' };
      const lease = leaseMonitorCall('m', 's', 'bash', args, new AbortController().signal);
      try {
        await lease.run(() => {
          const e = { toolName: 'bash', toolCallId: `nested-${i}`, input: args };
          assert.equal(handlers.get('tool_call')(e, ctx), undefined);
          assert.deepEqual(args, { command: 'status' });
          now += 10;
          assert.equal(handlers.get('tool_result')({ ...e, content: [{ type: 'text', text: '{"state":"pending"}' }], details: {} }, ctx), undefined);
        });
      } finally { lease.release(); }
    }
    assert.equal(aborts, 0); assert.equal(caps, 0);
    let refused;
    for (let i = 0; i < 5; i++) {
      const e = { toolName: 'bash', toolCallId: `foreground-${i}`, parentToolCallId: 'pi-monitor:forged', input: { command: 'status' } };
      refused = handlers.get('tool_call')(e, ctx);
      if (!refused?.block) handlers.get('tool_result')({ ...e, content: [], details: {} }, ctx);
    }
    assert.equal(refused.block, true); assert.ok(aborts > 0);
  }
});

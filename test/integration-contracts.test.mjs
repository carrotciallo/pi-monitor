import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishMonitorTool, guardMonitorExecution } from '../integrations/mcp-monitor-bridge.mjs';
import { patchMcpIndex } from '../integrations/patches.mjs';
import { monitorToolEvidence } from '../src/mcp-identity.ts';
import { isAllowedMonitorTool } from '../src/tools.ts';
import { leaseMonitorCall } from '../src/authorization.ts';
import { diagnosticRow, recordDiagnostic } from '../src/diagnostics.ts';
import { MonitorScheduler } from '../src/scheduler.ts';

const temp = mkdtempSync(join(tmpdir(), 'monitor-contract-'));
const origin = join(temp, 'adapter.ts');
writeFileSync(origin, '// synthetic adapter');
const schema = { type: 'object', properties: {} };

test('concrete MCP identity binds origin, schema and current catalog in every naming mode', () => {
  for (const name of ['server_read_status', 'search_read_status', 'mcp__server__read_status']) {
    const definition = { name, parameters: schema };
    const spec = { serverName: 'server', originalName: 'read_status', inputSchema: schema };
    const live = { name: 'read_status', inputSchema: schema, annotations: { readOnlyHint: true } };
    const connection = { status: 'connected', tools: [live] };
    const state = { manager: { getConnection: () => connection } };
    publishMonitorTool(pathToFileURL(origin).href, definition, spec, () => state);
    const info = { ...definition, sourceInfo: { path: origin } };
    let e = monitorToolEvidence(info);
    assert.equal(e.concreteMcp, true);
    assert.equal(isAllowedMonitorTool(name, e.annotations, {}, undefined, e.concreteMcp), true);
    assert.equal(monitorToolEvidence({ ...info, sourceInfo: { path: '/not-the-owner' } }).concreteMcp, false);
    assert.equal(monitorToolEvidence({ ...info, parameters: {} }).concreteMcp, false);
    live.annotations = { destructiveHint: true };
    e = monitorToolEvidence(info);
    assert.equal(isAllowedMonitorTool(name, e.annotations, {}, undefined, e.concreteMcp), false);
    const lease = leaseMonitorCall('monitor', 'session', name, {}, new AbortController().signal);
    try {
      assert.throws(() => lease.run(() => guardMonitorExecution(pathToFileURL(origin).href, name, 'call', {}, { sessionManager: { getSessionId: () => 'session' } })), /PI_MONITOR_POLICY_DENIED/);
    } finally { lease.release(); }
    live.annotations = {};
    const readonlyLease = leaseMonitorCall('monitor', 'session', name, {}, new AbortController().signal, true);
    try {
      assert.throws(() => readonlyLease.run(() => guardMonitorExecution(pathToFileURL(origin).href, name, 'revoked', {}, { sessionManager: { getSessionId: () => 'session' } })), /PI_MONITOR_POLICY_DENIED/);
    } finally { readonlyLease.release(); }
    connection.status = 'closed';
    assert.equal(monitorToolEvidence(info).annotations, undefined);
  }
  assert.equal(isAllowedMonitorTool('mcp__server', { readOnlyHint: true }), false);
  assert.equal(isAllowedMonitorTool('mcp', { readOnlyHint: true }, {}, undefined, true), false);
});

test('adapter patch requires exact preimage and keeps structuredContent on direct and deferred execution', { skip: !process.env.PI_MONITOR_MCP_ROOT }, () => {
  const source = readFileSync(join(process.env.PI_MONITOR_MCP_ROOT, 'index.ts'), 'utf8');
  const patched = patchMcpIndex(source);
  assert.match(patched, /initPromise, spec, true\)/);
  assert.match(patched, /publishMonitorTool\(import.meta.url/);
  assert.match(patched, /guardMonitorExecution\(import.meta.url/);
  assert.throws(() => patchMcpIndex(patched), /preimage/);
});

test('policy refusals are terminal after one attempt, not retried into a foreground abort', async t => {
  const scheduler = new MonitorScheduler(async () => ({ content: '', isError: true, errorText: '[ACP guardrail: BLOCKED — repeated calls]' }), { appendEntry() {}, sendMessage() {} });
  t.after(() => scheduler.pruneSession('contract'));
  const r = scheduler.startMonitor('contract', 'read', {}, { textContains: 'done' }, { maxRetries: 10 }, { hasUI: false, sessionManager: { getSessionId: () => 'contract' } });
  clearTimeout(scheduler.timers.get(r.id));
  scheduler.timers.delete(r.id);
  await scheduler.pollStep(r.id);
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, 1);
  assert.match(r.terminalReason, /policy_denied/);
  assert.equal(scheduler.timers.has(r.id), false);
});

test('diagnostic rows omit raw data and log rotation is bounded and private', async () => {
  const value = { sessionId: 's', monitorId: 'm', tool: 'read', toolCallId: 'nested', parentToolCallId: 'parent', category: 'tool_error', args: { token: 'SYNTHETIC_SECRET' }, errorText: 'SYNTHETIC_SECRET' };
  assert.doesNotMatch(JSON.stringify(diagnosticRow(value)), /SYNTHETIC_SECRET|args|errorText/);
  const path = join(temp, 'diagnostics.jsonl');
  writeFileSync(path, ' '.repeat(1024 * 1024), { mode: 0o600 });
  await recordDiagnostic(value, path);
  assert.equal(statSync(path + '.1').size, 1024 * 1024);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).parentToolCallId, 'parent');
});

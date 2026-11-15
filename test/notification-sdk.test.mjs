import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { NotificationOutbox, WAKE_TYPE } from '../src/notifications.ts';
import { NOTIFICATION_CUSTOM_TYPE } from '../src/types.ts';

const localRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const roots = [localRoot, ...(process.env.PI_MONITOR_SECOND_SDK_ROOT ? [process.env.PI_MONITOR_SECOND_SDK_ROOT] : [])];
for (const root of roots) {
  test(`actual SDK notification append + async wake rejection: ${root}`, async t => {
    const { AgentSession } = await import(pathToFileURL(join(root, 'dist/core/agent-session.js')));
    const { SessionManager } = await import(pathToFileURL(join(root, 'dist/core/session-manager.js')));
    const dir = mkdtempSync(join(tmpdir(), 'monitor-notification-sdk-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const manager = SessionManager.create('/tmp', dir);
    manager.appendMessage({ role: 'user', content: 'Synthetic notification integration test', timestamp: Date.now() });
    const session = Object.create(AgentSession.prototype);
    session.sessionManager = manager;
    session._isAgentRunActive = true;
    session._pendingCustomMessages = [];
    session._pendingNextTurnMessages = [];
    session._deferredSettledActions = [];
    session._refreshFinalizedContext = () => {};
    session._emit = () => {};
    let queued = 0, wakeCalls = 0;
    session.agent = { followUp() { queued++; }, steer() { queued++; }, state: { isStreaming: true } };
    // Model transport intentionally rejected. Keep actual sendCustomMessage,
    // _appendCustomMessage and SessionManager persistence, not a send-only mock.
    session._startRun = async () => { wakeCalls++; throw Error('synthetic asynchronous transport rejection'); };
    session._runAgentPrompt = session._startRun; // SDK 1.1 uses the older method name.
    const errors = [], sends = [];
    const api = {
      appendEntry: (type, data) => manager.appendCustomEntry(type, data),
      sendMessage: (message, options) => {
        sends.push({ message, options });
        // Exactly the host's void wrapper: plugin try/catch cannot observe this.
        session.sendCustomMessage(message, options).catch(e => errors.push(e.message));
      },
    };
    const ctx = { sessionManager: manager, isIdle: () => !session.isStreaming, hasPendingMessages: () => false };
    const box = new NotificationOutbox(api);
    box.bind(ctx); t.after(() => box.close(manager.getSessionId()));
    for (const id of ['fast-failure-one', 'fast-failure-two']) {
      box.enqueue({ id, sessionId: manager.getSessionId(), tool: 'read', status: 'failed', attempts: 1, completedAt: Date.now() });
    }
    assert.equal(sends.length, 0);
    assert.equal(queued, 0);
    session._isAgentRunActive = false; session.agent.state.isStreaming = false;
    box.pump(); box.pump();
    await new Promise(resolve => setImmediate(resolve));
    const notices = manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === NOTIFICATION_CUSTOM_TYPE);
    assert.equal(notices.length, 2);
    assert.equal(new Set(notices.map(e => e.details.notificationId)).size, 2);
    const disk = readFileSync(manager.getSessionFile(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(disk.filter(e => e.customType === NOTIFICATION_CUSTOM_TYPE).length, 2, 'both fast-failure observations reached the real session JSONL');
    assert.equal(wakeCalls, 2);
    assert.equal(errors.length, 2, 'host-only async errors cannot erase already appended observations');
    assert.equal(queued, 0, 'no completion sent into followUp queue during the tool batch');
    assert.ok(sends.filter(s => s.message.customType !== WAKE_TYPE).every(s => s.options.triggerTurn === false));
    const now = Date.now;
    try { Date.now = () => now() + 31_000; box.pump(); } finally { Date.now = now; }
    assert.ok(box.list(manager.getSessionId()).every(r => r.delivery === 'persisted' && r.wake === 'unconfirmed'));
    box.close(manager.getSessionId()); box.reconcile(ctx); box.pump();
    assert.equal(manager.getBranch().filter(e => e.customType === NOTIFICATION_CUSTOM_TYPE).length, 2);
    assert.equal(wakeCalls, 2, 'recovery must not replay ambiguous wake attempts');
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationOutbox, OUTBOX_TYPE, WAKE_TYPE } from '../src/notifications.ts';
import { NOTIFICATION_CUSTOM_TYPE } from '../src/types.ts';

function harness(t) {
  const entries = [], sent = [], updates = [];
  let idle = false;
  const ctx = { isIdle: () => idle, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'session', getBranch: () => entries } };
  const api = { appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    sendMessage(message, options) { sent.push({ message, options }); entries.push({ type: 'custom_message', ...message }); } };
  const box = new NotificationOutbox(api, r => updates.push(r));
  box.bind(ctx);
  t.after(() => box.close('session'));
  const record = (id, status = 'failed') => ({ id, sessionId: 'session', tool: 'read', status, attempts: 1, completedAt: 100,
    args: { accessToken: 'DO_NOT_SAVE' }, terminalReason: 'DO_NOT_SAVE', options: { description: 'DO_NOT_SAVE' } });
  return { box, api, ctx, entries, sent, updates, record, idle: value => { idle = value; } };
}

test('fast failures stay durable pending during a tool batch; idle append precedes separate wake', t => {
  const h = harness(t);
  h.box.enqueue(h.record('one')); h.box.enqueue(h.record('two'));
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.box.list('session').map(r => r.delivery), ['pending', 'pending']);
  assert.doesNotMatch(JSON.stringify(h.entries), /DO_NOT_SAVE/);
  h.idle(true); h.box.pump(); h.box.pump(); h.box.pump();
  const notices = h.sent.filter(r => r.message.customType === NOTIFICATION_CUSTOM_TYPE);
  assert.equal(notices.length, 2);
  assert.ok(notices.every(r => r.options.triggerTurn === false));
  assert.equal(h.sent.filter(r => r.message.customType === WAKE_TYPE).length, 2);
  assert.ok(h.box.list('session').every(r => r.delivery === 'persisted' && r.wake === 'persisted'));
  h.box.enqueue(h.record('one')); h.box.pump();
  assert.equal(h.sent.length, 4);
});

test('silent host acceptance without a branch entry is unknown, never notified or blindly resent', t => {
  const h = harness(t); h.idle(true);
  h.api.sendMessage = (message, options) => h.sent.push({ message, options });
  h.box.enqueue(h.record('missing'));
  assert.equal(h.box.list('session')[0].delivery, 'delivery_unknown');
  for (let i = 0; i < 10; i++) h.box.pump();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, false);
  // A delayed receipt confirms persistence but must not generate a second wake.
  h.entries.push({ type: 'custom_message', ...h.sent[0].message });
  h.box.pump();
  assert.equal(h.box.list('session')[0].delivery, 'persisted');
  assert.equal(h.sent.length, 1);
});

test('recovery resends only unsent pending entries, not ambiguous submitted entries', t => {
  const h = harness(t); h.box.enqueue(h.record('pending')); h.box.close('session');
  h.idle(true); h.box.reconcile(h.ctx); h.box.pump();
  assert.equal(h.sent.filter(r => r.message.customType === NOTIFICATION_CUSTOM_TYPE).length, 1);
  h.box.close('session'); h.box.reconcile(h.ctx); h.box.pump();
  assert.equal(h.sent.filter(r => r.message.customType === NOTIFICATION_CUSTOM_TYPE).length, 1);
  const old = h.entries.find(e => e.customType === OUTBOX_TYPE).data;
  h.entries.push({ type: 'custom', customType: OUTBOX_TYPE, data: { ...old, monitorId: 'ambiguous', notificationId: 'session:ambiguous:failed', delivery: 'submitted' } });
  h.box.reconcile(h.ctx);
  assert.equal(h.box.list('session').find(r => r.monitorId === 'ambiguous').delivery, 'delivery_unknown');
  assert.equal(h.sent.filter(r => r.message.customType === NOTIFICATION_CUSTOM_TYPE).length, 1);
});

test('branch navigation removes old pending work; persistence failure never sends', t => {
  const h = harness(t); h.box.enqueue(h.record('old-branch'));
  h.entries.length = 0; h.idle(true); h.box.reconcile(h.ctx);
  assert.equal(h.sent.length, 0);
  h.api.appendEntry = () => { throw Error('SYNTHETIC_SECRET'); };
  h.box.enqueue(h.record('disk-failure'));
  assert.equal(h.sent.length, 0);
  assert.equal(h.box.list('session')[0].delivery, 'delivery_unknown');
});

test('cancelled and interrupted never enqueue terminal notifications', t => {
  const h = harness(t); h.idle(true);
  h.box.enqueue(h.record('cancel', 'cancelled')); h.box.enqueue(h.record('interrupt', 'interrupted'));
  assert.equal(h.entries.length, 0); assert.equal(h.sent.length, 0);
});

test('unrecorded wake becomes unconfirmed without resending durable notification', t => {
  const h = harness(t); h.idle(true);
  const send = h.api.sendMessage;
  h.api.sendMessage = (m, o) => { if (m.customType !== WAKE_TYPE) send(m, o); };
  h.box.enqueue(h.record('wake'));
  const now = Date.now;
  try { Date.now = () => now() + 31_000; h.box.pump(); } finally { Date.now = now; }
  assert.equal(h.box.list('session')[0].delivery, 'persisted');
  assert.equal(h.box.list('session')[0].wake, 'unconfirmed');
  assert.equal(h.sent.length, 1);
});

import { MonitorScheduler as Scheduler } from '../src/scheduler.ts';

// Model the synchronous idle append contract that the old send-only stubs omitted.
// Existing test collectors capture notifications; control wake requests are separate.
export function notificationHost(api) {
  const entries = [];
  const send = api.sendMessage?.bind(api);
  const append = api.appendEntry?.bind(api);
  api.wakeMessages = [];
  api.appendEntry = (customType, data) => {
    append?.(customType, data);
    entries.push({ type: 'custom', customType, data: structuredClone(data) });
  };
  api.sendMessage = (message, options) => {
    if (message.customType === 'pi-monitor:wake') { api.wakeMessages.push({ message, options }); return; }
    send?.(message, options);
    entries.push({ type: 'custom_message', ...structuredClone(message) });
  };
  const managers = new WeakSet();
  return ctx => {
    ctx.isIdle ??= () => true;
    ctx.hasPendingMessages ??= () => false;
    if (!managers.has(ctx.sessionManager)) {
      const original = ctx.sessionManager.getBranch?.bind(ctx.sessionManager);
      ctx.sessionManager.getBranch = () => [...(original?.() ?? []), ...entries];
      managers.add(ctx.sessionManager);
    }
    return ctx;
  };
}
export class MonitorScheduler extends Scheduler {
  constructor(executor, api) {
    super(executor, api);
    this.prepareNotificationContext = api ? notificationHost(api) : ctx => ctx;
  }
  registerUIContext(id, ctx) { super.registerUIContext(id, this.prepareNotificationContext(ctx)); }
}

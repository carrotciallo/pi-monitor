// Version-pinned integration patches. Never fall back to an unpatched install.
export function patchMcpIndex(source) {
  source = 'import { publishMonitorTool, guardMonitorExecution } from "./monitor-bridge.mjs";\n' + source;
  source = replaceOnce(source,
    'executor = createDirectToolExecutor(() => executionGuard.state, () => initPromise, spec, deferred !== undefined);',
    'executor = createDirectToolExecutor(() => executionGuard.state, () => initPromise, spec, true);');
  source = replaceOnce(source,
    'assertRuntimeGuard(guard);\n        return executor(toolCallId, params, signal, onUpdate, ctx);',
    'assertRuntimeGuard(guard);\n        guardMonitorExecution(import.meta.url, name, toolCallId, params, ctx);\n        return executor(toolCallId, params, signal, onUpdate, ctx);');
  source = replaceOnce(source,
    '    callReentrant(() => (pi.registerTool as (tool: unknown) => unknown)(definition));',
    '    if (!script && !spec.resourceUri) publishMonitorTool(import.meta.url, definition, spec, () => state);\n    callReentrant(() => (pi.registerTool as (tool: unknown) => unknown)(definition));');
  return source;
}

export function replaceOnce(source, oldText, newText) {
  if (source.split(oldText).length !== 2) throw new Error('Integration patch preimage mismatch');
  return source.replace(oldText, newText);
}

export function patchAcp(source) {
  source = replaceOnce(source,
    'function wireToolGuardrails(pi2,opts={}){const trackers=new Map;',
    'function wireToolGuardrails(pi2,opts={}){const monitorCalls=new Map;const trackers=new Map;');
  source = replaceOnce(source,
    'const ctx=rawCtx;const e=event;if(isBashToolCall(e)){',
    'const ctx=rawCtx;const e=event;const monitorSid=ctx?.sessionManager?.getSessionId?.()??"";let monitorIdentity;try{monitorIdentity=globalThis[Symbol.for("pi-monitor.call-authority.v2")]?.claim("acp-repeat",monitorSid,e.toolName,e.input,e.toolCallId)}catch{}if(monitorIdentity){if(monitorCalls.size>=1000)return{block:true,reason:"PI_MONITOR_POLICY_DENIED: integration capacity exceeded"};monitorCalls.set(e.toolCallId,monitorSid);return}if(isBashToolCall(e)){');
  source = replaceOnce(source,
    'const e=event;const ctx=rawCtx;trackers.get(',
    'const e=event;const ctx=rawCtx;if(monitorCalls.get(e.toolCallId)===(ctx?.sessionManager?.getSessionId?.()??"")){monitorCalls.delete(e.toolCallId);return}trackers.get(');
  source = replaceOnce(source,
    'trackers.delete(ctx?.sessionManager?.getSessionId?.()??"")})}',
    'const sid=ctx?.sessionManager?.getSessionId?.()??"";trackers.delete(sid);for(const[id,owner]of monitorCalls)if(owner===sid)monitorCalls.delete(id)})}');
  return source;
}

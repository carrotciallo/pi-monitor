import { fileURLToPath } from 'node:url';
const KEY = Symbol.for('pi-monitor.mcp-tools.v1');
const registry = globalThis[KEY] ??= new Map();

/** Called only for concrete adapter registrations, never script/proxy tools. */
export function publishMonitorTool(sourceUrl, definition, spec, getState) {
  const sourcePath = fileURLToPath(sourceUrl);
  const entry = {
    sourcePath, parameters: definition.parameters,
    resolve() {
      const state = getState();
      const connection = state?.manager?.getConnection(spec.serverName);
      if (!connection || connection.status !== 'connected') return undefined;
      const live = connection.tools?.find(t => t.name === spec.originalName);
      if (!live || JSON.stringify(live.inputSchema) !== JSON.stringify(spec.inputSchema)) return undefined;
      return { annotations: live.annotations };
    },
  };
  registry.set(definition.name, entry);
  // Never export a cached declaration as a live one. The monitor checks the
  // resolver before each poll; normal host consumers get this live snapshot.
  definition.annotations = entry.resolve()?.annotations;
}

export function guardMonitorExecution(sourceUrl, name, eventId, args, ctx) {
  const claim = globalThis[Symbol.for('pi-monitor.call-authority.v2')]?.claim(
    'mcp-execute', ctx.sessionManager.getSessionId(), name, args, eventId);
  if (!claim) return;
  const entry = registry.get(name);
  const live = entry?.sourcePath === fileURLToPath(sourceUrl) ? entry.resolve() : undefined;
  if (!live || live.annotations?.destructiveHint === true
    || (claim.requiresReadOnly && live.annotations?.readOnlyHint !== true)) {
    throw new Error('PI_MONITOR_POLICY_DENIED: MCP catalog changed or is unavailable');
  }
}

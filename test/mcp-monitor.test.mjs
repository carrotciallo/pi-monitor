import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piMonitor from "../src/index.ts";
import { PROJECT_TRUST_FILE_NAME } from "../src/tool-trust.ts";

/**
 * End-to-end wiring for the MCP adaptation: `monitor_start` must consult the
 * host's annotations and the user trust files through its real context.
 */
function createEnvironment(tools) {
  const registeredTools = new Map();
  const hooks = new Map();
  piMonitor({
    registerTool: tool => registeredTools.set(tool.name, tool),
    registerCommand() {},
    on(name, fn) { hooks.set(name, fn); return () => {}; },
    sendMessage() {},
    getAllTools: () => tools,
    getActiveTools: () => [],
    setActiveTools() {},
    registerMessageRenderer() {},
  });
  return { registeredTools, hooks };
}

function createContext(cwd, projectTrusted = false) {
  return {
    hasUI: false,
    cwd,
    isProjectTrusted: () => projectTrusted,
    sessionManager: { getSessionId: () => "mcp-e2e", getBranch: () => [] },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    async executeTool() {
      return {
        result: {
          content: [{ type: "text", text: JSON.stringify({ total: 2 }) }],
          structuredContent: { total: 2 },
        },
        isError: false,
      };
    },
  };
}

function startParams(tool, args = {}) {
  return {
    tool,
    args,
    condition: { field: "total", greaterThanOrEqual: 2 },
    intervalSeconds: 300,
  };
}

test("monitor_start polls an annotated MCP tool and keeps proxies blocked", async () => {
  const env = createEnvironment([
    // As Pi reports a read-only MCP tool.
    { name: "mail_list_emails_metadata", parameters: {}, annotations: { readOnlyHint: true, destructiveHint: false } },
    // A namespace proxy: one name, every tool behind it, no annotations.
    { name: "mcp__bambu_printer", parameters: {} },
    // A non-read-only MCP tool.
    { name: "mail_send_email", parameters: {}, annotations: { readOnlyHint: false, destructiveHint: false } },
  ]);
  const ctx = createContext(tmpdir());
  const start = env.registeredTools.get("monitor_start");

  try {
    const allowed = await start.execute("c1", startParams("mail_list_emails_metadata", { account_name: "default" }),
      undefined, undefined, ctx);
    assert.notEqual(allowed.isError, true, "an annotated read-only tool must be pollable");

    const proxy = await start.execute("c2", startParams("mcp__bambu_printer", { tool: "print_3mf" }),
      undefined, undefined, ctx);
    assert.equal(proxy.isError, true, "a namespace proxy must stay blocked");

    const mutating = await start.execute("c3", startParams("mail_send_email", { account_name: "default" }),
      undefined, undefined, ctx);
    assert.equal(mutating.isError, true, "a read-write tool must stay blocked");
    assert.match(mutating.content[0].text, /provably read-only/);
  } finally {
    env.hooks.get("session_shutdown")?.({}, ctx);
  }
});

test("monitor_start honours a user trust file, and only a trusted project file", async () => {
  const unannotated = { name: "index_search", parameters: {} };
  const projectOnly = { name: "project_only_tool", parameters: {} };
  const env = createEnvironment([unannotated, projectOnly]);
  const start = env.registeredTools.get("monitor_start");

  const cwd = mkdtempSync(join(tmpdir(), "pi-monitor-e2e-"));
  const userPath = join(cwd, "user-pi-monitor.md");
  writeFileSync(userPath, "## Allow\n- index_search\n");

  const previousUserPath = process.env.PI_MONITOR_TRUST_FILE;
  process.env.PI_MONITOR_TRUST_FILE = userPath;
  try {
    const untrusted = createContext(cwd, false);
    // The project file grants nothing while the project is untrusted.
    writeFileSync(join(cwd, PROJECT_TRUST_FILE_NAME), "## Allow\n- project_only_tool\n");
    const denied = await start.execute("c1", startParams("index_search"), undefined, undefined, untrusted);
    assert.notEqual(denied.isError, true, "the user trust file applies in an untrusted project");
    const proxy = await start.execute("c2", startParams("project_only_tool"), undefined, undefined, untrusted);
    assert.equal(proxy.isError, true, "an untrusted project file must not grant access");

    const trusted = createContext(cwd, true);
    const granted = await start.execute("c3", startParams("project_only_tool"), undefined, undefined, trusted);
    assert.notEqual(granted.isError, true, "a trusted project file grants access");
    env.hooks.get("session_shutdown")?.({}, trusted);
  } finally {
    if (previousUserPath === undefined) delete process.env.PI_MONITOR_TRUST_FILE;
    else process.env.PI_MONITOR_TRUST_FILE = previousUserPath;
    env.hooks.get("session_shutdown")?.({}, createContext(cwd));
  }
});

test("monitor_start recovers dropped MCP annotations from the adapter cache", async () => {
  // Pi reports these with no annotations at all, exactly as the adapter's
  // direct path does. Only the on-disk cache knows what the servers declared.
  const env = createEnvironment([
    { name: "mail_list_emails_metadata", parameters: {} },
    { name: "mail_send_email", parameters: {} },
    { name: "mcp__bambu_printer", parameters: {} },
  ]);
  const start = env.registeredTools.get("monitor_start");

  const dir = mkdtempSync(join(tmpdir(), "pi-monitor-mcp-e2e-"));
  const cachePath = join(dir, "mcp-cache.json");
  writeFileSync(cachePath, JSON.stringify({
    version: 1,
    servers: {
      mail: {
        tools: [
          { name: "list_emails_metadata", annotations: { readOnlyHint: true, destructiveHint: false } },
          // A server that mislabels a mutating tool must not get it admitted.
          { name: "send_email", annotations: { readOnlyHint: true, destructiveHint: false } },
        ],
      },
    },
  }));

  const previousCache = process.env.PI_MONITOR_MCP_CACHE;
  const previousTrust = process.env.PI_MONITOR_TRUST_FILE;
  process.env.PI_MONITOR_MCP_CACHE = cachePath;
  // Point the trust file at nothing so only the cache can grant access.
  process.env.PI_MONITOR_TRUST_FILE = join(dir, "absent-trust.md");
  try {
    const ctx = createContext(tmpdir());
    const allowed = await start.execute("c1", startParams("mail_list_emails_metadata", { account_name: "default" }),
      undefined, undefined, ctx);
    assert.notEqual(allowed.isError, true, "a cache-declared read-only tool must be pollable without a trust file");

    const mislabelled = await start.execute("c2", startParams("mail_send_email", { account_name: "default" }),
      undefined, undefined, ctx);
    assert.equal(mislabelled.isError, true, "cache annotations must not override the mutating-name block");

    const proxy = await start.execute("c3", startParams("mcp__bambu_printer", { tool: "print_3mf" }),
      undefined, undefined, ctx);
    assert.equal(proxy.isError, true, "a namespace proxy must stay blocked regardless of the cache");
    env.hooks.get("session_shutdown")?.({}, ctx);
  } finally {
    if (previousCache === undefined) delete process.env.PI_MONITOR_MCP_CACHE;
    else process.env.PI_MONITOR_MCP_CACHE = previousCache;
    if (previousTrust === undefined) delete process.env.PI_MONITOR_TRUST_FILE;
    else process.env.PI_MONITOR_TRUST_FILE = previousTrust;
  }
});

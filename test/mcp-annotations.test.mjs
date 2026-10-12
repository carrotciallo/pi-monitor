import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lookupCachedMcpTool,
  resolveToolAnnotations,
  mcpCachePath,
} from "../src/mcp-annotations.ts";

const readOnly = { readOnlyHint: true, destructiveHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true };

/** Writes a cache file shaped like pi-mcp-adapter's, and returns its path. */
function writeCache(servers) {
  const dir = mkdtempSync(join(tmpdir(), "pi-monitor-mcp-cache-"));
  const path = join(dir, "mcp-cache.json");
  writeFileSync(path, JSON.stringify({ version: 1, servers }));
  return path;
}

test("lookupCachedMcpTool recovers annotations the adapter did not forward", () => {
  const path = writeCache({
    mail: {
      tools: [
        { name: "list_emails_metadata", annotations: readOnly },
        { name: "get_emails_content", annotations: { readOnlyHint: false, destructiveHint: false } },
      ],
    },
  });

  // The adapter prefixes with the server name and flattens dots.
  const hit = lookupCachedMcpTool("mail_list_emails_metadata", { cachePath: path });
  assert.ok(hit, "the prefixed name must resolve to its cache entry");
  assert.equal(hit.originalName, "list_emails_metadata");
  assert.equal(hit.serverName, "mail");
  assert.equal(hit.annotations.readOnlyHint, true);

  assert.equal(lookupCachedMcpTool("totally_unknown_tool", { cachePath: path }), undefined);
});

test("server names with dashes or dots resolve under their sanitized form", () => {
  const path = writeCache({
    "bambu-printer": { tools: [{ name: "get_printer_status", annotations: readOnly }] },
  });

  for (const name of [
    "bambu-printer_get_printer_status",
    "bambu_printer_get_printer_status",
    "bambu_printer__get_printer_status",
    "mcp__bambu_printer_get_printer_status",
  ]) {
    const hit = lookupCachedMcpTool(name, { cachePath: path });
    assert.ok(hit, `${name} must resolve`);
    assert.equal(hit.annotations.readOnlyHint, true);
  }
});

test("a bare name owned by more than one server is treated as ambiguous", () => {
  const path = writeCache({
    alpha: { tools: [{ name: "status", annotations: readOnly }] },
    beta: { tools: [{ name: "status", annotations: destructive }] },
  });

  // Two servers claim `status`, so the unqualified name has no owner.
  assert.equal(lookupCachedMcpTool("status", { cachePath: path }), undefined);
  // Qualified names stay unambiguous.
  assert.equal(lookupCachedMcpTool("alpha_status", { cachePath: path }).annotations.readOnlyHint, true);
  assert.equal(lookupCachedMcpTool("beta_status", { cachePath: path }).annotations.destructiveHint, true);
});

test("tools without annotations never enter the index", () => {
  const path = writeCache({
    exa: { tools: [{ name: "web_search_exa" }, { name: "web_fetch_exa", annotations: {} }] },
  });
  assert.equal(lookupCachedMcpTool("exa_web_search_exa", { cachePath: path }), undefined);
  assert.equal(lookupCachedMcpTool("exa_web_fetch_exa", { cachePath: path }), undefined);
});

test("resolveToolAnnotations lets live values win and fills gaps from cache", () => {
  const path = writeCache({
    mail: { tools: [{ name: "list_emails_metadata", annotations: readOnly }] },
  });

  // No live annotations (the direct path): cache supplies them.
  assert.equal(
    resolveToolAnnotations("mail_list_emails_metadata", undefined, { cachePath: path }).readOnlyHint,
    true
  );

  // A live explicit false is authoritative; the cache must not override it.
  assert.equal(
    resolveToolAnnotations("mail_list_emails_metadata", { readOnlyHint: false }, { cachePath: path })
      .readOnlyHint,
    false
  );

  // A live destructiveHint is preserved alongside a cached readOnlyHint.
  const merged = resolveToolAnnotations(
    "mail_list_emails_metadata",
    { destructiveHint: true },
    { cachePath: path }
  );
  assert.equal(merged.readOnlyHint, true);
  assert.equal(merged.destructiveHint, true);

  // Unknown tool: whatever live said, or undefined.
  assert.equal(resolveToolAnnotations("nope", undefined, { cachePath: path }), undefined);
});

test("a missing, malformed, or oversized cache degrades to no annotations", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-monitor-mcp-cache-"));
  const absent = join(dir, "missing.json");
  assert.equal(resolveToolAnnotations("mail_list_emails_metadata", undefined, { cachePath: absent }), undefined);

  const malformed = join(dir, "malformed.json");
  writeFileSync(malformed, "{ this is not json");
  assert.equal(resolveToolAnnotations("mail_list_emails_metadata", undefined, { cachePath: malformed }), undefined);

  // A JSON document of the wrong shape is ignored rather than throwing.
  const wrongShape = join(dir, "wrong.json");
  writeFileSync(wrongShape, JSON.stringify({ version: 1, servers: { mail: { tools: "nope" } } }));
  assert.equal(resolveToolAnnotations("mail_list_emails_metadata", undefined, { cachePath: wrongShape }), undefined);
});

test("a rewritten cache is re-read without restarting the process", () => {
  const path = writeCache({ mail: { tools: [{ name: "list_emails_metadata", annotations: readOnly }] } });
  assert.equal(lookupCachedMcpTool("mail_list_emails_metadata", { cachePath: path }).annotations.readOnlyHint, true);

  // Same path, new content and therefore a new size: the cache must not go stale.
  unlinkSync(path);
  writeFileSync(path, JSON.stringify({
    version: 1,
    servers: { mail: { tools: [{ name: "list_emails_metadata", annotations: destructive }] } },
  }));
  const after = lookupCachedMcpTool("mail_list_emails_metadata", { cachePath: path });
  assert.equal(after.annotations.readOnlyHint, false);
  assert.equal(after.annotations.destructiveHint, true);
});

test("mcpCachePath honours PI_MONITOR_MCP_CACHE", () => {
  const previous = process.env.PI_MONITOR_MCP_CACHE;
  try {
    process.env.PI_MONITOR_MCP_CACHE = "/tmp/custom-mcp-cache.json";
    assert.equal(mcpCachePath(), "/tmp/custom-mcp-cache.json");
    delete process.env.PI_MONITOR_MCP_CACHE;
    assert.match(mcpCachePath(), /\.pi[/\\]agent[/\\]mcp-cache\.json$/);
  } finally {
    if (previous === undefined) delete process.env.PI_MONITOR_MCP_CACHE;
    else process.env.PI_MONITOR_MCP_CACHE = previous;
  }
});

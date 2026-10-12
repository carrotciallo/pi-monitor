import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedMonitorTool } from "../src/tools.ts";
import {
  globToRegExp,
  loadToolTrust,
  matchesToolPatterns,
  parseToolTrust,
  projectTrustFilePath,
  resolveProjectTrust,
  userTrustFilePath,
  MAX_TRUST_FILE_BYTES,
} from "../src/tool-trust.ts";

const READ_ONLY = { readOnlyHint: true };

function trustFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), "pi-monitor-trust-"));
  const path = join(dir, "pi-monitor.md");
  writeFileSync(path, lines.join("\n"));
  return path;
}

test("a readOnlyHint annotation alone admits a tool, without name heuristics", () => {
  // The MCP case this feature exists for: an annotated tool that the host
  // reports as read-only must be pollable even though its name is unremarkable.
  assert.equal(isAllowedMonitorTool("mail_list_emails_metadata", READ_ONLY), true);
  assert.equal(isAllowedMonitorTool("mail_list_emails_metadata"), false);
  // Names that match none of the old query keywords still pass on annotation.
  assert.equal(isAllowedMonitorTool("blender_search_mentions", READ_ONLY), true);
  assert.equal(isAllowedMonitorTool("remote_status", READ_ONLY), true);
  // A tool that declares itself read-write is not admitted by annotation.
  assert.equal(isAllowedMonitorTool("mail_get_emails_content", { readOnlyHint: false }), false);
});

test("annotations never override the hard blocks", () => {
  // Namespace proxies would hand the monitor every tool behind the proxy,
  // including unannotated destructive ones.
  assert.equal(isAllowedMonitorTool("mcp__bambu_printer", READ_ONLY), false);
  assert.equal(isAllowedMonitorTool("mcp__blender", READ_ONLY), false);
  // Gateway tools stay forbidden.
  assert.equal(isAllowedMonitorTool("mcp", READ_ONLY), false);
  assert.equal(isAllowedMonitorTool("mcpScript", READ_ONLY), false);
  assert.equal(isAllowedMonitorTool("monitor_start", READ_ONLY), false);
  // Explicit destructiveness and mutating names stay blocked.
  assert.equal(isAllowedMonitorTool("bambu-printer_print_3mf", READ_ONLY), false);
  assert.equal(isAllowedMonitorTool("ast_grep_replace", READ_ONLY), false);
  assert.equal(isAllowedMonitorTool("write", READ_ONLY), false);
  assert.equal(isAllowedMonitorTool("mail_delete_emails", READ_ONLY), false);
  assert.equal(isAllowedMonitorTool("mail_send_email", READ_ONLY), false);
});

test("parseToolTrust reads Allow and Deny list items and ignores prose", () => {
  const parsed = parseToolTrust([
    "# pi-monitor trust",
    "",
    "This paragraph is documentation, not a rule.",
    "",
    "## Allow",
    "- `mail_list_*` — read-only listings",
    "- index_search",
    "* blender_search_mentions",
    "",
    "## Deny",
    "- mail_get_emails_content",
    "",
    "## Notes",
    "- this one is outside any rule section",
  ].join("\n"));

  assert.deepEqual(parsed.allow, ["mail_list_*", "index_search", "blender_search_mentions"]);
  assert.deepEqual(parsed.deny, ["mail_get_emails_content"]);
});

test("parseToolTrust keeps hyphens that belong to a tool name", () => {
  const parsed = parseToolTrust([
    "## Allow",
    "- bambu-printer_get_printer_status",
    "- index_search - a spaced hyphen starts documentation",
  ].join("\n"));
  assert.deepEqual(parsed.allow, ["bambu-printer_get_printer_status", "index_search"]);
});

test("globToRegExp escapes regex metacharacters and uses * and ?", () => {
  assert.equal(globToRegExp("mail_list_*").test("mail_list_emails_metadata"), true);
  assert.equal(globToRegExp("a?c").test("abc"), true);
  assert.equal(globToRegExp("a.b").test("axb"), false);
  assert.equal(globToRegExp("a.b").test("a.b"), true);
  assert.equal(globToRegExp("mcp__*").test("mcp__bambu_printer"), true);
  // Anchored: a partial name must not match.
  assert.equal(globToRegExp("mail_list").test("mail_list_emails_metadata"), false);
});

test("Allow admits an unannotated tool, Deny beats an annotation, hard blocks win", () => {
  const path = trustFile([
    "## Allow",
    "- mail_list_*",
    "- index_search",
    "- mcp__bambu_printer",
    "- bambu-printer_print_3mf",
    "",
    "## Deny",
    "- mail_get_emails_content",
  ]);
  const trust = loadToolTrust({ userPath: path });

  // Allow rescues a tool the host cannot prove read-only.
  assert.equal(isAllowedMonitorTool("mail_list_emails_metadata", undefined, {}, trust), true);
  assert.equal(isAllowedMonitorTool("index_search", undefined, {}, trust), true);
  // Deny removes access even when the host declares the tool read-only.
  assert.equal(isAllowedMonitorTool("mail_get_emails_content", READ_ONLY, {}, trust), false);
  // An Allow entry cannot reach past a hard block.
  assert.equal(isAllowedMonitorTool("mcp__bambu_printer", undefined, {}, trust), false);
  assert.equal(isAllowedMonitorTool("bambu-printer_print_3mf", READ_ONLY, {}, trust), false);
  // Anything unlisted and unannotated stays denied.
  assert.equal(isAllowedMonitorTool("some_other_tool", undefined, {}, trust), false);
});

test("loadToolTrust reports its sources and tolerates a missing file", () => {
  const populated = loadToolTrust({ userPath: trustFile(["## Allow", "- index_search"]) });
  assert.equal(populated.sources.length, 1);
  assert.deepEqual(populated.allowPatterns, ["index_search"]);

  const absent = loadToolTrust({ userPath: join(tmpdir(), "pi-monitor-does-not-exist.md") });
  assert.deepEqual(absent.allow, []);
  assert.deepEqual(absent.deny, []);
  assert.deepEqual(absent.sources, []);
  assert.equal(matchesToolPatterns("anything", absent.allow), false);
});

test("the project trust file is read only when the project is trusted", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-monitor-project-"));
  const projectPath = projectTrustFilePath(cwd);
  writeFileSync(projectPath, "## Allow\n- project_only_tool\n");

  const userPath = join(cwd, "user.md");
  writeFileSync(userPath, "## Allow\n- user_only_tool\n");

  const trusted = loadToolTrust({ userPath, cwd, projectTrusted: true });
  assert.equal(isAllowedMonitorTool("project_only_tool", undefined, {}, trusted), true);
  assert.equal(isAllowedMonitorTool("user_only_tool", undefined, {}, trusted), true);

  // An untrusted repository must not be able to grant itself monitoring access.
  const untrusted = loadToolTrust({ userPath, cwd, projectTrusted: false });
  assert.equal(isAllowedMonitorTool("project_only_tool", undefined, {}, untrusted), false);
  assert.equal(isAllowedMonitorTool("user_only_tool", undefined, {}, untrusted), true);
});

test("an oversized trust file is ignored rather than parsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-monitor-big-"));
  const path = join(dir, "pi-monitor.md");
  writeFileSync(path, "## Allow\n- index_search\n" + "x".repeat(MAX_TRUST_FILE_BYTES + 1));
  const trust = loadToolTrust({ userPath: path });
  assert.deepEqual(trust.allow, []);
  assert.equal(isAllowedMonitorTool("index_search", undefined, {}, trust), false);
});

test("resolveProjectTrust treats a missing or throwing method as untrusted", () => {
  assert.equal(resolveProjectTrust(undefined), false);
  assert.equal(resolveProjectTrust({}), false);
  assert.equal(resolveProjectTrust({ isProjectTrusted: () => true }), true);
  assert.equal(resolveProjectTrust({ isProjectTrusted: () => false }), false);
  assert.equal(resolveProjectTrust({ isProjectTrusted: () => { throw new Error("no trust"); } }), false);
  assert.equal(resolveProjectTrust({ isProjectTrusted: "yes" }), false);
});

test("userTrustFilePath points at the user-level agent directory", () => {
  assert.match(userTrustFilePath(), /\.pi[\\/]agent[\\/]pi-monitor\.md$/);
});

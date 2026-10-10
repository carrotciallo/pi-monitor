import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MonitorScheduler } from "./scheduler.ts";
import { sanitizeRecord } from "./tools.ts";

export function registerMonitorCommands(pi: ExtensionAPI, scheduler: MonitorScheduler) {
  // 1. /monitor_cancel
  pi.registerCommand("monitor_cancel", {
    description: "Cancel background monitors. Usage: /monitor_cancel [monitorId | all]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const id = args.trim();

      if (!id) {
        const running = scheduler.getSessionRecords(sessionId).filter(r => r.status === "running");
        if (running.length === 0) {
          ctx.ui.notify("No background monitors are currently running", "info");
          return;
        }
        if (running.length === 1) {
          scheduler.cancel(running[0].id, "cancelled via user command", sessionId);
          ctx.ui.notify(`Cancelled monitor: ${running[0].id}`, "info");
          return;
        }
        ctx.ui.notify(`${running.length} monitors are running. Specify an ID to cancel, or run /monitor_cancel all`, "warning");
        return;
      }

      if (id === "all") {
        const records = scheduler.getSessionRecords(sessionId);
        let count = 0;
        for (const r of records) {
          if (r.status === "running") {
            scheduler.cancel(r.id, "cancelled all via user command", sessionId);
            count++;
          }
        }
        ctx.ui.notify(`Cancelled all ${count} background monitors`, "info");
        return;
      }

      const ok = scheduler.cancel(id, "cancelled via user command", sessionId);
      if (ok) {
        ctx.ui.notify(`Cancelled monitor: ${id}`, "info");
      } else {
        ctx.ui.notify(`Could not cancel monitor ${id} (not found, not in the current session, or already finished)`, "warning");
      }
    },
  });

  // 2. /monitor_status
  pi.registerCommand("monitor_status", {
    description: "View background monitor status. Usage: /monitor_status [monitorId]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const id = args.trim();

      if (id) {
        const record = scheduler.getRecord(id);
        if (!record || record.sessionId !== sessionId) {
          ctx.ui.notify(`Monitor '${id}' not found`, "warning");
          return;
        }
        const stateDesc = record.terminalReason ? `(${record.terminalReason})` : "monitoring";
        ctx.ui.notify(`[${record.status.toUpperCase()}] ${record.id} · ${record.tool}: ${stateDesc}`, "info");
        return;
      }

      const records = scheduler.getSessionRecords(sessionId);
      if (records.length === 0) {
        ctx.ui.notify("No monitors recorded in the current session", "info");
        return;
      }

      const runningCount = records.filter(r => r.status === "running").length;
      ctx.ui.notify(`Background monitors: ${runningCount} running / ${records.length} total`, "info");
    },
  });
}

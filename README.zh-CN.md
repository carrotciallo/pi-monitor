# pi-monitor

[English](README.md) | 简体中文

Pi Coding Agent 的非阻塞、有界后台监控插件。启动可信只读查询后立即返回监控 ID；条件稳定命中、查询失败或超时后，通知会唤醒会话。

![后台监控流程](docs/monitor-flow.svg)

**支持 Pi-Web，但不依赖 Pi-Web。** 插件使用 Pi 宿主扩展 API，没有 Web 专属后端依赖。兼容的终端宿主也能显示精简状态面板；无 UI 时仍能执行后台查询。

## 安装

```sh
pi install git:github.com/carrotciallo/pi-monitor
```

已有会话执行 `/reload`。需要 Node.js 22.19 或更新版本，宿主必须提供 `ExtensionToolContext.executeTool`、`before_agent_start.systemPromptOptions.promptGuidelines` 和标准扩展消息 API。不支持缺少这些 API 的旧版 Pi；安装 Pi-Web 本身不能补齐 SDK 能力。

## 工具和命令

| 工具 | 用途 |
| --- | --- |
| `monitor_start` | 对可信只读工具启动有界后台查询。 |
| `monitor_status` | 查看当前会话监控详情及保留的结果。 |
| `monitor_cancel` | 取消一个监控或当前会话全部监控。 |

用户命令：`/monitor_status [monitorId]`、`/monitor_cancel [monitorId | all]`。

工具参数示例：

```json
{
  "tool": "job_status",
  "args": { "id": "example-job" },
  "condition": { "field": "status", "equals": "completed" },
  "consecutiveMatches": 2,
  "description": "Wait for job completion"
}
```

等待数小时、且结构化值必须保持稳定的场景：优先使用直接输出单个 JSON 文档的查询（例如带 `--json` 的状态工具），而不是解析零散的 shell 文本：

```json
{
  "tool": "bash",
  "args": { "command": "job-status --json" },
  "condition": { "field": "state", "equals": "drained" },
  "intervalSeconds": 30,
  "timeoutSeconds": 21600,
  "consecutiveMatches": 3,
  "stableForSeconds": 120,
  "description": "Wait for drain to hold for two minutes"
}
```

上面的命令仅为示意，本文档不会执行它。只有当 `bash` 或 `hypa_shell` 的结果本身就是 JSON（或执行成功且 `output` 本身就是 JSON）时，字段条件才会对其做适配；该示例假定 `job-status --json` 只输出一个包含 `state` 字段的紧凑 JSON 文档。

`job_status` 仅是示意，实际工具必须存在并通过工具策略。`bash` 和 `hypa_shell` 可接受任意非空 `command`，包括管道和脚本；其他写入、通用网关及变更工具仍被阻止。插件不检查 shell 命令内容，只读查询要求属于提示词约束，不是硬性拦截。

## 行为

任务仍未完成且需要稍后复查时，agent 使用 `monitor_start`，不再直接重复轮询。启动监控后停止对同一状态的直接查询，继续独立工作；没有独立工作则结束当前回合等待通知。一次性操作无需启动监控。

系统提示词和工具描述保持简短、英文及领域通用。系统提示词说明何时监控及如何结束回合等待，工具描述说明参数和结果。

- 默认查询间隔 5 秒、超时 120 秒、查询错误后重试 3 次。每个会话最多 5 个并发监控，同一监控不会叠加在途查询。
- 间隔范围 2–300 秒；超时范围 5–604800 秒（最长七天）；重试次数 0–10。
- 稳定性：`consecutiveMatches`（1–1000，默认 1）与 `stableForSeconds`（0–604800，默认 0）。只有当条件连续命中要求的采样次数，且持续时间达到要求后才算完成。一次未命中或一次查询错误都会重置进度；只有真实观测到的采样才计数。
- 去重：同一会话、同一工具、规范化 JSON 参数、条件及完整轮询/稳定性配置都相同的情况下，`monitor_start` 会返回已有的运行中监控并标记 `reused: true`，不再创建重复项。`description` 只是标签，不参与身份判定。
- 条件支持单个字段比较、否定感知文本子串、RE2JS 正则表达式或标准化结果 SHA-256。字段比较包括相等、列表成员和数值边界。
- 字段条件读取宿主提供的 `structuredContent`；仅对 `bash` 和 `hypa_shell`，当执行成功（`exit_code` 为 0）且 `output` 本身是 JSON 时才会解包，整段文本为 JSON 时也可直接使用。被截断、超时、被杀或失败的 shell 输出一律拒绝，绝不部分解析。插件不做模糊或子串式 JSON 提取。
- 完成判定优先使用结构化字段。文本否定识别是启发式辅助；RE2JS 不支持环视和反向引用。工具错误不会算作条件命中。
- UI 只显示状态、简短任务名、查询次数、耗时，以及精简健康信息（命中进度、稳定进度、上次成功距今、重试次数、下次查询）和仅限“相关字段值”。没有取消按钮。最新终态短暂保留后自动清理。
- 条件命中、查询失败和超时会发送精简英文通知并唤醒会话。原始响应及错误详情留在 `monitor_status`，不进入通知。命中仅说明设定条件成立；超时或查询失败不说明底层操作失败。
- 通知是观测结果，不是新指令或操作授权；agent 仍需遵循用户最新请求及已有权限。
- 取消停止查询并抑制迟到完成通知，不会取消底层任务。
- 生命周期：分支切换、会话切换、重载或关闭会把监控以 `interrupted`（被中断）停止，与用户或 agent 明确发起的 `cancelled`（已取消）区分开。被中断不会发送唤醒回合的通知，因此不会误唤醒错误分支或会话；会显示精简的恢复提示（无 UI 时以不触发回合的上下文消息送达）。

## 安全与限制

工具执行经过宿主权限和 hook 链路。非 shell 工具使用默认拒绝的只读策略，仅允许选定内置读取工具及满足注解要求的查询工具。`bash` 和 `hypa_shell` 提供非空命令即可放行，即使工具标记为可破坏；命令原样交给宿主。提示词要求 agent 只重复状态查询，不重复启动任务或变更操作。这不是命令过滤器或沙箱：命令中的副作用会在每次查询时重复发生，宿主已有权限检查仍然生效。

插件通过限定作用域、一次性的调用凭证兼容外部重复调用守卫。外部守卫需理解这些凭证或允许有界后台查询；本仓库不会安装或禁用守卫。同进程恶意扩展不在隔离防御范围内。

监控的运行时状态只保存在内存，不跨 reload 或重启恢复。为避免监控静默消失，每个监控还会写入一条有界、不进入上下文的历史条目（启动、终态、被中断），其中不含原始工具参数或结果。加载时只读取一次当前活动分支：没有对应活动监控的运行中描述会作为“已丢失”报告；被中断的描述会作为恢复提示报告。重建是只读的，绝不会恢复执行；不在当前活动分支上的描述不可见。每个会话最多保留 10 条记录，结果文本可能被截断。脱敏只是额外防御，不能保证任意工具结果没有秘密；不要监控返回敏感信息的工具。用户提供的任务标签不做翻译。

## 开发

```sh
npm ci --include=dev
npm run check
npm test
npm pack --dry-run
```

CI 使用 Node.js 22 和 24。外部守卫集成测试默认明确标记为跳过；设置 `PI_MONITOR_GUARD_PATH` 指向兼容守卫扩展后启用。可设置 `PI_MONITOR_SECOND_SDK_ROOT` 对第二个已安装 SDK 运行集成测试。跳过不等于宿主兼容性验证通过。

欢迎提交 Issue 和 PR。参见 [贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md) 和 [MIT 许可证](LICENSE)。

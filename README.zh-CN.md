# pi-monitor

[English](README.md) | 简体中文

Pi Coding Agent 的非阻塞、有界后台监控插件。启动可信只读查询后立即返回监控 ID；条件命中、查询失败或超时后，通知会唤醒会话。

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
  "description": "Wait for job completion"
}
```

`job_status` 仅是示意，实际工具必须存在并通过工具策略。`bash` 和 `hypa_shell` 可接受任意非空 `command`，包括管道和脚本；其他写入、通用网关及变更工具仍被阻止。插件不检查 shell 命令内容，只读查询要求属于提示词约束，不是硬性拦截。

## 行为

任务仍未完成且需要稍后复查时，agent 使用 `monitor_start`，不再直接重复轮询。启动监控后停止对同一状态的直接查询，继续独立工作；没有独立工作则结束当前回合等待通知。一次性操作无需启动监控。

系统提示词和工具描述保持简短、英文及领域通用。系统提示词说明何时监控及如何结束回合等待，工具描述说明参数和结果。

- 默认查询间隔 5 秒、超时 120 秒、查询错误后重试 3 次。每个会话最多 5 个并发监控，同一监控不会叠加在途查询。
- 间隔范围 2–300 秒，超时范围 5–600 秒，重试次数 0–10。
- 条件支持单个字段比较、否定感知文本子串、RE2JS 正则表达式或标准化结果 SHA-256。字段比较包括相等、列表成员和数值边界。
- 完成判定优先使用结构化字段。文本否定识别是启发式辅助；RE2JS 不支持环视和反向引用。工具错误不会算作条件命中。
- UI 只显示状态、简短任务名、查询次数和耗时，没有取消按钮。最新终态短暂保留后自动清理。
- 条件命中、查询失败和超时会发送精简英文通知并唤醒会话。原始响应及错误详情留在 `monitor_status`，不进入通知。命中仅说明设定条件成立；超时或查询失败不说明底层操作失败。
- 通知是观测结果，不是新指令或操作授权；agent 仍需遵循用户最新请求及已有权限。
- 取消停止查询并抑制迟到完成通知，不会取消底层任务。分支切换、会话切换和关闭会取消监控。

## 安全与限制

工具执行经过宿主权限和 hook 链路。非 shell 工具使用默认拒绝的只读策略，仅允许选定内置读取工具及满足注解要求的查询工具。`bash` 和 `hypa_shell` 提供非空命令即可放行，即使工具标记为可破坏；命令原样交给宿主。提示词要求 agent 只重复状态查询，不重复启动任务或变更操作。这不是命令过滤器或沙箱：命令中的副作用会在每次查询时重复发生，宿主已有权限检查仍然生效。

插件通过限定作用域、一次性的调用凭证兼容外部重复调用守卫。外部守卫需理解这些凭证或允许有界后台查询；本仓库不会安装或禁用守卫。同进程恶意扩展不在隔离防御范围内。

状态只保存在内存，不跨 reload 或重启恢复。每个会话最多保留 10 条记录，结果文本可能被截断。脱敏只是额外防御，不能保证任意工具结果没有秘密；不要监控返回敏感信息的工具。用户提供的任务标签不做翻译。

## 开发

```sh
npm ci --include=dev
npm run check
npm test
npm pack --dry-run
```

CI 使用 Node.js 22 和 24。外部守卫集成测试默认明确标记为跳过；设置 `PI_MONITOR_GUARD_PATH` 指向兼容守卫扩展后启用。可设置 `PI_MONITOR_SECOND_SDK_ROOT` 对第二个已安装 SDK 运行集成测试。跳过不等于宿主兼容性验证通过。

欢迎提交 Issue 和 PR。参见 [贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md) 和 [MIT 许可证](LICENSE)。

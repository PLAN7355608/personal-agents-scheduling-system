# dsh-secretary-core

个人 Agent 秘书 v0 内核（DSH 插件）：WorkItem 状态机 + 事件账本 + 线路由/派单 + 工具治理 + 只读面板；附 `secretary-relay` / `secretary-worker` 两个 preset。

## 组成

- **内核（Host 插件）**：`index.js` + `src/`
  - 账本：SQLite（`~/.dsh/secretary/secretary.db`），append-only 事件为唯一真相源，schema v14；
  - 状态机：`intake → triaged → queued → running → done/failed/blocked/cancelled`；
  - 线路由：一个来源会话一条线（可带工作区/文件焦点后缀），线内串行、线间并行；
  - 派单：每条线复用/恢复同一个工人会话；支持任务级指定模型；
  - 工具治理：Worker 白名单 → 申请 → 规则/judge → 主人审批；删除有独立护栏；
  - 运维：简报、复盘、归档（默认只提议）、模板、记忆、人设；
  - HTTP：`/secretary/v1/{status,stats,panel,lanes,workitems,trace,channels,outbox,inbound,tasks}`（写路径需 token 或本机无 Origin 请求）。
- **Relay / Worker presets**：`cordis.patch.yml` 里声明（工具面、人设、权限档、审批策略）。
- **面板**：`client.js` 右下角只读药丸（任务/线/待批申请/简报/外部入口结果）。

## 常用工具

- 任务：`secretary_create_task`（可带 `workspace`/`worker`/`model`/`files`/`permission`/`project`/`scope`）、`secretary_wait`、`secretary_status`、`secretary_cancel_task`；
- 工人：`secretary_work_finish` `/ secretary_work_fail` `/ secretary_request_tool`；
- 治理：`secretary_tool_requests`、`secretary_decide_tool_request`；
- 记忆：`secretary_remember` / `secretary_recall` / `secretary_forget`；
- 运维：`secretary_briefing`、`secretary_report`、`secretary_archive`、`secretary_templates`、`secretary_models`；
- 线/任务：`secretary_adopt`（复用或 seed 旧会话）、`secretary_propose_group` / `secretary_split_merged`、`secretary_prune`、`secretary_stats`。

## 本地测试

```bash
node tests/run.mjs    # 纯内存单测（沙箱禁 spawn，不用 node --test）
```

## 文档

见仓库根目录 `00-协作规矩.md`、`02-架构设计-v0（讨论稿）.md`、`04-v0落地设计.md`、`09-办公机更新流程.md`、`11-模型接入与选择.md` 等。

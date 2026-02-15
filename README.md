# ContextFS

ContextFS 是一个给 OpenCode 用的轻量上下文管理插件，目标很简单：
让长对话不跑偏、可追溯、可检索。

它会把会话沉淀到本地 `.contextfs/`，并在每轮对话自动注入精简且可控的上下文包。

## 适合什么场景

- 会话很长，模型开始“忘前文”
- 需要跨多轮持续执行同一任务
- 希望关键约束（如代码规范、边界条件）始终生效
- 想快速回看历史，而不是翻整段聊天记录

## 你会得到什么

- 稳定的上下文注入：每轮自动组装 PINS / SUMMARY / MANIFEST / WORKSET
- 热历史 + 归档历史：近期对话快读，旧对话可检索
- 严格问答记录：`history.ndjson` 只保留
  - 原始用户问题
  - 助手最终回答（不含中间流式过程/工具过程）
- 渐进式检索流程：`search -> timeline -> get`
- 自动压缩：对话过长时自动收敛上下文体积

## 快速开始

### 1) 安装

```bash
mkdir -p .opencode/plugins
cp <path-to-contextfs>/.opencode/plugins/contextfs.plugin.mjs .opencode/plugins/
cp -r <path-to-contextfs>/.opencode/plugins/contextfs .opencode/plugins/
```

重启 OpenCode 会话。

### 2) 验证

在 OpenCode 对话框直接输入：

```text
/ctx ls
/ctx stats
```

## 最常用用法（对话框）

/ctx ls                           # 查看状态
/ctx stats                        # 查看统计
/ctx search "关键词" --k 5 --session current
/ctx timeline H-xxx --before 3 --after 3 --session current
/ctx get H-xxx --head 1200 --session current
/ctx stats --json
/ctx pin "不要修改核心架构"
/ctx compact                     # 手动触发压缩
/ctx gc                          # 清理重复 ID

如果只是日常使用，优先使用 `/ctx ...`，不需要手动执行 Node 命令。

## L0/L1/L2 分层（渐进式检索契约）

ContextFS 把“检索与注入”分成三层，核心目的是省 token 且可追溯：

- L0（Index / Recall）：超便宜的索引行，用来决定“要不要展开、展开哪个 ID”
  - 对应：`/ctx search`、`/ctx timeline` 输出的摘要行（ID + 摘要）
- L1（Overview / Navigation）：可预算的概览，用来做决策与保持任务连续性
  - 对应：PINS / SUMMARY / MANIFEST，以及 pack 里的 `WORKSET_RECENT_TURNS`（导航预览，不是完整回放）
- L2（Detail / Playback）：按需获取的完整细节
  - 对应：`/ctx get <id>`

完整契约见：`CONTEXT_LAYERS.md`

## 推荐使用方式

1. 先 `/ctx search` 找到相关记录 ID
2. 用 `/ctx timeline` 判断上下文是否命中
3. 只在需要细节时再 `/ctx get`

这样可以显著减少 token 浪费，同时保持信息可追溯。

### 输出与字段（对齐当前分支）

- `ctx search` 支持 `--scope all|hot|archive` 控制检索范围；支持 `--session all|current|<session-id>` 做会话隔离（默认 `all`，检索所有会话；用 `current` 仅查当前 OpenCode 会话；用具体 ID 查特定会话）。
- `search/timeline/get/stats` 支持 `--json` 输出结构化结果。
- `ctx search --json` / `ctx timeline --json`：返回 `layer: "L0"`，每条结果是稳定的 L0 行（`id/ts/type/summary/source/layer`），并可能包含 `score`、`expand`（提示展开 `timeline/get` 的默认窗口与粗略 token 量级）。顶层会附带 `session` 字段用于调试。
- `ctx get --json`：返回 `layer: "L2"`，包含 `record`（完整记录，默认按 `--head` 做裁剪）与 `source`（hot|archive）。
- `ctx stats`：文本输出会额外打印 `pack_breakdown_tokens(est)`；`--json` 会包含 `pack_breakdown`（各 section 的 token 估算）与 `session_id`。

## 目录说明（用户视角）

`.contextfs/` 下最常见的文件：

- `pins.md`: 关键约束
- `summary.md`: 历史压缩摘要
- `state.json`: 运行时状态（如 lastSearchIndex、计数器、上次检索信息）
- `history.ndjson`: 近期严格问答对（用户原问题 + 助手最终回答）
- `history.archive.ndjson`: 归档历史
- `history.archive.index.ndjson`: 归档检索索引

## 常见问题

### Q1: 会把中间推理过程写进 history 吗？
不会。默认只记录用户原问题和助手最终回答。

### Q2: 历史被压缩后还能找回来吗？
可以。归档历史仍可通过 `search` / `timeline` / `get` 检索和回放（`get` 会自动做 archive fallback；`search/timeline` 依赖 archive index）。如果 index 异常，可运行 `/ctx reindex` 重建。

### Q3: 会影响现有项目代码吗？
不会。插件主要读写 `.contextfs/` 和插件目录，不会侵入业务代码。

### Q4: 还能用 CLI 吗？
可以。CLI 主要用于脚本化或调试；日常交互建议直接在对话框使用 `/ctx ...`。

## License

MIT

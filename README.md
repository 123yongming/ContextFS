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

在 OpenCode 对话框直接输入：

```text
/ctx search "lock timeout" --k 5
/ctx timeline H-abc12345 --before 3 --after 3
/ctx get H-abc12345 --head 1200
/ctx pin "不要修改核心架构"
/ctx compact
```

如果只是日常使用，优先使用 `/ctx ...`，不需要手动执行 Node 命令。

## 推荐使用方式

1. 先 `/ctx search` 找到相关记录 ID
2. 用 `/ctx timeline` 判断上下文是否命中
3. 只在需要细节时再 `/ctx get`

这样可以显著减少 token 浪费，同时保持信息可追溯。

## 目录说明（用户视角）

`.contextfs/` 下最常见的文件：

- `pins.md`: 关键约束
- `summary.md`: 历史压缩摘要
- `history.ndjson`: 近期严格问答对（用户原问题 + 助手最终回答）
- `history.archive.ndjson`: 归档历史
- `history.archive.index.ndjson`: 归档检索索引

## 常见问题

### Q1: 会把中间推理过程写进 history 吗？
不会。默认只记录用户原问题和助手最终回答。

### Q2: 历史被压缩后还能找回来吗？
可以。归档历史仍可通过 `search` / `timeline` / `get` 检索和回放。

### Q3: 会影响现有项目代码吗？
不会。插件主要读写 `.contextfs/` 和插件目录，不会侵入业务代码。

### Q4: 还能用 CLI 吗？
可以。CLI 主要用于脚本化或调试；日常交互建议直接在对话框使用 `/ctx ...`。

## License

MIT

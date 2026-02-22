# ContextFS

ContextFS 是一个给 OpenCode 用的轻量上下文管理插件，目标很简单：
让长对话不跑偏、可追溯、可检索。

它会把会话沉淀到本地 `.contextfs/`，并在每轮对话自动注入精简且可控的上下文包。

> 当前版本：v4.1.0

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
- **SQLite 全文检索**：基于 `better-sqlite3` + FTS5 的高效词法搜索
- **向量语义检索**：基于 `sqlite-vec` 的向量搜索，支持 ANN 近似最近邻
- **混合检索模式**：词法 + 语义融合，RRF 排序
- 渐进式检索流程：`search -> timeline -> get`
- 自动压缩：对话过长时自动收敛上下文体积（summary 通过外部大模型生成，失败即报错，不做本地降级）

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

```text
/ctx ls                           # 查看状态
/ctx stats                        # 查看统计
/ctx search "关键词" --k 5 --mode hybrid --session current
/ctx search "语义搜索" --mode vector --k 5
/ctx search "精确匹配" --mode lexical --k 5
/ctx timeline H-xxx --before 3 --after 3 --session current
/ctx get H-xxx --head 1200 --session current
/ctx traces --tail 20
/ctx trace T-xxxxxxxxxx
/ctx stats --json
/ctx doctor --json                # 诊断 SQLite 索引状态
/ctx pin "不要修改核心架构"
/ctx save "关键记忆文本" --title "可选标题" --session current
/ctx compact                     # 手动触发压缩
/ctx gc                          # 清理重复 ID
/ctx reindex --full --vectors    # 重建 SQLite 索引
```

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

### 输出与字段（当前版本）

- `ctx search` 支持 `--scope all|hot|archive` 控制检索范围；支持 `--session all|current|<session-id>` 做会话隔离（默认 `all`，检索所有会话；用 `current` 仅查当前 OpenCode 会话；用具体 ID 查特定会话）。
- **搜索模式** (`--mode`)：
  - `legacy`：旧版 grep 搜索（不依赖 SQLite）
  - `lexical`：SQLite FTS5 全文检索（精确词法匹配）
  - `vector`：sqlite-vec 向量语义检索（理解语义相似性）
  - `hybrid`：混合模式，融合词法 + 向量结果（RRF 排序）
  - `fallback`：默认模式，优先 SQLite，失败则回退 legacy
- `search/timeline/get/stats` 支持 `--json` 输出结构化结果。
- `ctx search --json` / `ctx timeline --json`：返回 `layer: "L0"`，每条结果是稳定的 L0 行（`id/ts/type/summary/source/layer`），并可能包含 `score`、`expand`（提示展开 `timeline/get` 的默认窗口与粗略 token 量级）。
- `ctx search --json` 在 hybrid 模式下会附带 `retrieval`（如 `mode/lexical_hits/vector_hits/fused_hits/vector_engine`、`vector_fallback_reason`、可选 `ann_recall_probe`），并在每条结果附带 `match`（`lexical|vector|hybrid`）。
- `ctx get --json`：返回 `layer: "L2"`，包含 `record`（完整记录，默认按 `--head` 做裁剪）与 `source`（hot|archive）。
- `ctx stats`：文本输出会额外打印 `pack_breakdown_tokens(est)`；`--json` 会包含 `pack_breakdown`（各 section 的 token 估算）与 `session_id`。
- `ctx save --json`：返回 `layer: "WRITE"`，包含 `action: "save_memory"` 与已写入记录的元数据（`id/ts/role/type/session_id/text_preview`）。
- `ctx doctor --json`：诊断 SQLite 索引状态，包含 `sqlite_index.turns`、`sqlite_index.turns_fts`、`sqlite_index.vector.rows` 等信息。
- `ctx metrics --json`：检索性能指标，包含 `lexical_engine`、`vector_engine`、`ann_recall_probe` 等。

## 目录说明（用户视角）

`.contextfs/` 下最常见的文件：

- `pins.md`: 关键约束
- `summary.md`: 历史压缩摘要
- `state.json`: 运行时状态（如 lastSearchIndex、计数器、上次检索信息）
- `history.ndjson`: 近期严格问答对（用户原问题 + 助手最终回答）
- `history.archive.ndjson`: 归档历史
- `history.embedding.hot.ndjson`: 热数据向量索引
- `history.embedding.archive.ndjson`: 归档数据向量索引
- `index.sqlite`: SQLite 索引数据库（FTS5 词法索引 + sqlite-vec 向量索引）
- `retrieval.traces.ndjson`: 检索 trace（派生数据，可删可重建；可能轮转为 `retrieval.traces.N.ndjson`）

## 常见问题

### Q1: 会把中间推理过程写进 history 吗？
不会。默认只记录用户原问题和助手最终回答。

### Q2: 历史被压缩后还能找回来吗？
可以。归档历史仍可通过 `search` / `timeline` / `get` 检索和回放（`get` 会自动做 archive fallback，`search/timeline` 直接基于 `history.archive.ndjson`）。`/ctx reindex` 负责 SQLite 索引重建：
- `--full`：重建 FTS5 词法索引
- `--vectors`：重建 sqlite-vec 向量索引
- `--full --vectors`：同时重建两者

### Q3: 会影响现有项目代码吗？
不会。插件主要读写 `.contextfs/` 和插件目录，不会侵入业务代码。

### Q4: 还能用 CLI 吗？
可以。CLI 主要用于脚本化或调试；日常交互建议直接在对话框使用 `/ctx ...`。

### Q5: SQLite 搜索需要安装什么依赖？
需要安装 `better-sqlite3` 和 `sqlite-vec`：
```bash
cd .opencode/plugins/contextfs
npm install better-sqlite3 sqlite-vec
```
如果未安装这些依赖，搜索会自动降级到 `legacy` 模式（基于 grep）。

### Q6: 搜索模式怎么选择？
- **`fallback`**（默认）：自动选择最佳可用模式，推荐日常使用
- **`hybrid`**：词法 + 语义融合，最全面但需要配置 embedding
- **`lexical`**：纯词法搜索，不需要 embedding，速度快
- **`vector`**：纯语义搜索，需要配置 embedding API
- **`legacy`**：兜底模式，不依赖 SQLite

## MCP Server

ContextFS now provides a local MCP stdio server in:

- `.opencode/plugins/contextfs/mcp-server.mjs`

Run it with:

```bash
node .opencode/plugins/contextfs/mcp-server.mjs --workspace <workspace-path>
```

Exposed tools:

- `search(query, k?, scope?, session?|session_id?)`
- `timeline(anchor_id, before?, after?, session?|session_id?)`
- `get(id, head?, session?|session_id?)`
- `save_memory(text, title?, role?, type?, session?|session_id?)`
- `__IMPORTANT()`

Contracts:

- `search/timeline` return L0 JSON (same shape as `ctx ... --json`)
- `get` returns L2 JSON with the same `--head` budget semantics
- `save_memory` returns WRITE JSON ack (same shape as `ctx save --json`)

## 配置

### SQLite 依赖

启用 SQLite 搜索功能需要安装依赖：

```bash
cd .opencode/plugins/contextfs
npm install better-sqlite3 sqlite-vec
```

### Embedding 配置

启用向量搜索需要配置 embedding API，复制模板并填入密钥：

```bash
cp .opencode/plugins/contextfs/.env.example .opencode/plugins/contextfs/.env
# 编辑 .env，设置 CONTEXTFS_EMBEDDING_API_KEY
```

完整配置项参考 `.env.example` 文件。

### 常用命令

```text
/ctx search "查询" --mode hybrid          # 混合搜索（默认 fallback）
/ctx reindex --full --vectors             # 重建索引
/ctx doctor --json                        # 诊断索引状态
```

## Benchmark

1000 轮对话测试（avgChars=400, variance=0.6, seed=42）：

### Token 控制

| 指标 | ContextFS | Naive | 压缩率 |
|:---|---:|---:|---:|
| 最大 tokens | 1,360 | 104,851 | **98.7%** |
| P95 tokens | 1,359 | 99,267 | **98.6%** |
| 增长斜率 | 0.35/轮 | 105/轮 | **99.7%** |

### 性能开销

| 指标 | ContextFS | Naive |
|:---|---:|---:|
| 单轮耗时 P95 | 149 ms | 94 ms |
| 总耗时 | 104 s | 60 s |
| 压缩次数 | 15 | 0 |

**结论**：ContextFS 实现 **O(1) token 增长**，以约 55ms/轮的额外开销换取 98.7% 的 token 压缩。

## License

MIT

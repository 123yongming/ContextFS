# ContextFS

ContextFS 是一个面向 OpenCode 的轻量上下文工程插件，目标是让 Agent 在长会话中保持“稳定、可检索、可追溯”。

当前版本：`v5.0.0`

---

## 1. 为什么需要 ContextFS

在长链路任务里，常见问题是：

- 会话越长，token 越容易失控
- 模型容易“忘前文”，导致任务漂移
- 需要回溯历史时，只能翻聊天记录，效率低

ContextFS 的核心思路是把上下文管理工程化：

- 用固定结构注入上下文（而不是拼接整段历史）
- 用渐进式检索按需展开细节
- 用热/归档分层存储，控制成本同时保留可追溯性

---

## 2. 核心能力

### 2.1 稳定上下文注入
每轮构建固定 Context Pack：

- `PINS`：关键约束（上限 20）
- `SUMMARY`：压缩摘要（上限 3200 chars）
- `MANIFEST`：工作区清单（上限 20 行）
- `RETRIEVAL_INDEX`：最近检索索引
- `WORKSET_RECENT_TURNS`：最近若干轮导航视图

### 2.2 渐进式检索（L0/L1/L2）
- `L0`：低成本索引行（search / timeline）
- `L1`：导航层（PINS/SUMMARY/MANIFEST/WORKSET）
- `L2`：按需展开完整明细（get）

推荐流程：`search -> timeline -> get`

### 2.3 分层存储与索引
- `history.ndjson`：热数据
- `history.archive.ndjson`：归档数据
- `index.sqlite`：派生检索索引（FTS5 + sqlite-vec）

### 2.4 检索模式
- `legacy`：grep 兜底
- `lexical`：SQLite FTS5 词法检索
- `vector`：sqlite-vec 向量检索
- `hybrid`：词法+向量融合（RRF）
- `fallback`：默认自动回退模式

### 2.5 MCP 接入
提供本地 MCP stdio server，工具契约与 CLI JSON 输出一致：

- `search`
- `timeline`
- `get`
- `save_memory`
- `__IMPORTANT`

---

## 3. 安装

```bash
mkdir -p .opencode/plugins
cp <path-to-contextfs>/.opencode/plugins/contextfs.plugin.mjs .opencode/plugins/
cp -r <path-to-contextfs>/.opencode/plugins/contextfs .opencode/plugins/
```

重启 OpenCode 会话。

---

## 4. 快速开始

在 OpenCode 对话框中：

```text
/ctx ls
/ctx stats
```

常用命令：

```text
/ctx search "关键词" --k 5 --mode hybrid --session current
/ctx timeline H-xxxx --before 3 --after 3 --session current
/ctx get H-xxxx --head 1200 --session current
/ctx save "长期记忆" --title "可选标题" --session current
/ctx doctor --json
/ctx reindex --full --vectors
```

---

## 5. CLI 与 JSON 契约

- `ctx search --json` / `ctx timeline --json`
  - 返回 `layer: "L0"`
- `ctx get --json`
  - 返回 `layer: "L2"`
- `ctx save --json`
  - 返回 `layer: "WRITE"`

这套契约用于保证 Agent 工具链可组合、可自动化。

---

## 6. MCP Server

入口：`.opencode/plugins/contextfs/mcp-server.mjs`

启动：

```bash
node .opencode/plugins/contextfs/mcp-server.mjs --workspace <workspace-path>
```

工具：

- `search(query, k?, scope?, session?|session_id?)`
- `timeline(anchor_id, before?, after?, session?|session_id?)`
- `get(id, head?, session?|session_id?)`
- `save_memory(text, title?, role?, type?, session?|session_id?)`
- `__IMPORTANT()`

---

## 7. 配置

默认配置在：`.opencode/plugins/contextfs/src/config.mjs`

常用环境变量：

```bash
CONTEXTFS_EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
CONTEXTFS_EMBEDDING_API_KEY=<your_api_key>
CONTEXTFS_EMBEDDING_MODEL=Pro/BAAI/bge-m3
CONTEXTFS_COMPACT_MODEL=Pro/Qwen/Qwen2.5-7B-Instruct
```

说明：

- 未安装可选 SQLite 依赖时，会自动降级到 `legacy`。
- 若调整了 `text_preview` 生成策略，建议执行一次：

```text
/ctx reindex --full
```

---

## 8. 评估体系与实验结果

ContextFS 现在包含三层评估：

- 性能评估：`bench:full` 内含 `ContextFS vs Naive`
- 检索评估：`bench:retrieval`（Recall@k / MRR@k / nDCG@k）
- 任务评估：`bench:task`（规则优先，灰区可接 LLM Judge）

### 8.1 评估命令

```bash
npm run bench:retrieval
npm run bench:task
npm run bench:full
```

### 8.2 最近一次全量评估（2026-02-23）

执行命令：

```bash
npm run bench:full -- --turns 300 --threshold 1000000 --outDir bench/results_full
```

> 注：该次 run 使用高阈值避免触发在线 compact API，主要用于性能/检索/任务一致性验证。

#### 性能（ContextFS vs Naive）

| 指标 | ContextFS | Naive | 变化 |
|---|---:|---:|---:|
| pack_tokens max | 556 | 21,947 | -97.47% |
| pack_tokens p95 | 556 | 20,721 | -97.32% |
| turn_time p95 (ms) | 136.413 | 99.145 | +37.59% |
| total_elapsed_ms | 27,240 | 21,918 | +24.28% |

解读：ContextFS 以可接受时延开销换取稳定 token 上界。

#### 检索（300 样本）

| 模式 | Recall@k | MRR@k | nDCG@k |
|---|---:|---:|---:|
| legacy | 0.903 | 0.902 | 0.902 |
| lexical | 1.000 | 1.000 | 1.000 |
| vector | 0.903 | 0.902 | 0.902 |
| hybrid | 1.000 | 1.000 | 1.000 |
| fallback | 1.000 | 1.000 | 1.000 |

解读：在该数据集上 `hybrid/lexical/fallback` 达到满分，`legacy` 略弱。

#### 任务（150 样本）

- `task_success_rate = 1.0`
- `task_partial_rate = 0`
- `critical_fact_miss_rate = 0`
- `judge.total_calls = 0`（本次样本由规则层直接通过）

解读：在当前数据与参数下，检索证据覆盖足够，规则判分可直接通过。

### 8.3 LLM Judge 说明

当任务处于灰区（例如 `k=1` 导致证据不全）时，会触发 Judge。

默认使用：

- Base URL：`https://api.siliconflow.cn/v1`
- 模型：由 `bench/lib/judge_client.mjs` 的默认值或 `--judge-model` 决定
- API key：复用 `.env` 中 `CONTEXTFS_EMBEDDING_API_KEY`

---

## 9. 开发与测试

安装：

```bash
npm install
npm install --prefix .opencode/plugins/contextfs
```

测试：

```bash
npm run test:contextfs:unit
npm run test:contextfs:regression
node --test --test-isolation=none bench/bench.test.mjs bench/eval.test.mjs
```

---

## 10. 常见问题

### Q1. 压缩后还能检索历史吗？
可以。归档历史仍可通过 `search/timeline/get` 检索，`get` 支持 archive fallback。

### Q2. 未安装 SQLite 依赖怎么办？
会自动回退到 `legacy`，不阻塞基础功能。

### Q3. 为什么某次 bench 触发 compact 报 key 缺失？
该 run 触发了在线 compact 调用，但进程没有有效 `CONTEXTFS_EMBEDDING_API_KEY`。可设置 key 或提高 threshold 避免触发。

---

## 11. License

MIT

# ContextFS Archive Retrieval Tier 改动说明

> **分支**: `feature/archive-retrieval-tier`
>
> **目标**: 解决压缩后历史无法检索的问题，建立 hot + archive 两层存储，确保 search/timeline/get 在压缩后仍然可用。

## 1. 背景/动机

### 1.1 问题场景

ContextFS 原设计通过自动压缩机制控制上下文体积：当 token 阈值触发时，旧历史会被压缩成 bullet points 写入 `summary.md`，仅保留最近 N 轮对话在 `history.ndjson`。

这导致一个根本问题：

- **压缩前**: 所有历史可通过 `ctx search` / `ctx timeline` / `ctx get` 检索。
- **压缩后**: 被压缩的历史仅以摘要形式存在于 `summary.md`，无法通过 search/timeline/get 精确命中和回放。

在长会话场景中，用户经常需要回溯已被压缩的旧轮次（例如查找某个设计决策的上下文、某个 bug 的讨论过程），但原设计无法支持。

### 1.2 设计目标

本分支引入 **两层存储**（hot + archive）机制：

- **hot 区** (`history.ndjson`): 保持原语义，存储最近 N 轮完整对话，计入 pack 体积。
- **archive 区** (`history.archive.ndjson`): 存储被压缩的完整历史，不计入 pack 体积，但支持检索和回放。

核心要求：

1. **压缩后可检索**: archive 中的记录可被 `search/timeline/get` 命中。
2. **检索范围可控**: 用户可指定检索范围（hot / archive / all）。
3. **来源可识别**: 命中结果标注来源（`source: hot|archive`）。
4. **索引可修复**: 提供手动重建 archive 索引的能力。
5. **一致性保障**: 重复 id 场景下，保持原始 id，`get` 采用“最后一条生效”。

---

## 2. 核心改动（按模块）

### 2.1 Storage 层（`.opencode/plugins/contextfs/src/storage.mjs`）

#### 2.1.1 新增存储文件

在 `FILES` 常量中新增两个 archive 相关文件：

```javascript
historyArchive: "history.archive.ndjson",
historyArchiveIndex: "history.archive.index.ndjson",
```

在 `ensureFile` 中默认创建空文件（`""`）。

#### 2.1.2 新增解析/序列化函数

- **`summarizeText(text, maxChars)`**: 将文本压缩为单行摘要（用于 index）。
- **`toArchiveIndexEntry(entry, archivedAt)`**: 将 archive 条目转换为索引条目（包含 `archivedAt` 时间戳）。
- **`parseArchiveIndexText(rawText)`**: 解析 archive 索引文件，返回按 `ts` 排序的索引条目数组。
- **`parseArchiveTextPreserveIds(rawText)`**: **关键变更**：解析 archive 文件时，**不再通过 `parseHistoryText` 重写重复 id**，保持原始 id。

> **设计意图**: 与 hot 区不同，archive 允许重复 id 存在（历史记录可能因迁移或异常写入产生重复），但索引层和读取层需要保留原始 id 以保证 consistency。

#### 2.1.3 新增存储方法

##### `readHistoryArchive(options)`

- 读取 `history.archive.ndjson`。
- 使用 `parseArchiveTextPreserveIds` 解析，保留原始 id。

##### `readHistoryArchiveIndex()`

- 读取 `history.archive.index.ndjson`。
- 使用 `parseArchiveIndexText` 解析。

##### `rebuildHistoryArchiveIndex(options)`

- **功能**: 重新构建 archive 索引（用于修复损坏的索引）。
- **流程**:
  1. 读取 archive 原始文件。
  2. 通过 `parseArchiveTextPreserveIds` 解析，保留原始 id。
  3. 生成索引条目（使用 `toArchiveIndexEntry`）。
  4. 写入 `history.archive.index.ndjson`。
- **返回**: `{ rebuilt: boolean, archiveEntries: number, indexEntries: number }`

> **一致性保障**: 索引重建时同样使用 `parseArchiveTextPreserveIds`，确保索引中的 id 与 archive payload 中的 id 完全一致。

##### `findHistoryArchiveById(id)`

- **功能**: 按 id 从 archive 中查找完整记录。
- **语义**: **“最后一条生效”**：从末尾向前扫描，返回第一条匹配的记录。
- **用途**: `ctx get` 命中 archive 时使用。

##### `appendHistoryArchive(entries, options)`

- **功能**: 将历史记录追加到 archive 区和 archive 索引。
- **流程**:
  1. 归一化输入记录（`normalizeHistoryItems`）。
  2. 同时写入 `history.archive.ndjson` 和 `history.archive.index.ndjson`（追加模式）。
- **使用场景**: `maybeCompact` 触发压缩时，将 oldTurns 写入 archive。

#### 2.1.4 Manifest 更新

在 `refreshManifest` 中新增两个文件描述：

```
- history.archive.ndjson | archived compacted turn history | tags: runtime,archive
- history.archive.index.ndjson | archive retrieval index | tags: runtime,index
```

---

### 2.2 Commands 层（`.opencode/plugins/contextfs/src/commands.mjs`）

#### 2.2.1 检索增强（`tokenize` / `scoreEntry`）

##### `tokenize(text)` 改进

- **原行为**: 仅按非字母数字切分，对 CJK 文本支持较弱。
- **新行为**:
  - 保留原有切分逻辑。
  - **新增 CJK n-gram 支持**: 对 CJK 文本片段，生成 2-gram 和 3-gram token。
    - 单字: `chars[i]`
    - 二字: `chars[i] + chars[i+1]`
    - 三字: `chars[i] + chars[i+1] + chars[i+2]`
- **效果**: 对中文短语匹配更稳定（例如“王俊凯喜欢谁”可匹配“王俊凯喜欢易烊千玺”）。

##### `scoreEntry(entry, queryTokens, newestTs)` 改进

- **原行为**: 时效性权重较高（`2 / (1 + ageHours)`），可能淹没语义匹配。
- **新行为**:
  - 降低时效性权重（`0.2 / (1 + ageHours)`）。
  - **新增守卫**: 如果 `score <= 0`（无词法匹配），直接返回 0，避免仅凭类型/时间加分。
- **效果**: 优先保证词法/语义匹配，时效性作为次要信号。

#### 2.2.2 工具函数新增

##### `mergeUniqueHistory(history, archive)`

- 合并 hot 与 archive 记录，按 id 去重（后覆盖前），按 `ts` 排序。

##### `asArchiveSearchRows(items)`

- 将 archive 索引条目转换为统一 search row 格式（添加 `source: archive`）。

##### `readHistoryByScope(storage, scope)`

- 根据 `scope`（`all|hot|archive`）返回对应的历史记录。
- `scope=all`: 合并 hot + archive。
- `scope=hot`: 仅 hot。
- `scope=archive`: 仅 archive。

#### 2.2.3 命令改动

`runCtxCommand` 支持以下命令变更：

##### `ctx search`

- **新增参数**: `--scope all|hot|archive`（默认 `all`）。
- **流程**:
  1. 调用 `readHistoryByScope` 获取根据 scope 过滤的记录。
  2. 调用 `mergeUniqueHistory` 合并（scope=all 时）。
  3. 进行打分排序。
  4. 输出中新增 `source` 字段（`hot` 或 `archive`）。
- **JSON 输出**: 包含 `query`, `k`, `scope`, `hits`, `results`。
- **文本输出**: `id | ts | type | source | summary`。

##### `ctx timeline`

- **改动**: 支持 archive 中的 id。
- **流程**:
  1. 先尝试在 hot 中查找 id。
  2. 未命中则在 archive 索引中查找 id。
  3. 输出中标注 `source`（`hot` 或 `archive`）。
- **JSON 输出**: 包含 `anchor`, `before`, `after`, `source`, `results`。
- **文本输出**: `id | ts | type | source | summary`。

##### `ctx get`

- **改动**: 支持 archive 中的 id。
- **流程**:
  1. 先尝试在 hot 中查找 id。
  2. 未命中则调用 `findHistoryArchiveById` 从 archive 中查找（“最后一条生效”）。
- **JSON 输出**: 包含 `source`, `record`, `head`, `original_text_len`。
- **文本输出**: 包裹在 `{ source, record }` 中。

##### `ctx reindex`（新增）

- **功能**: 调用 `storage.rebuildHistoryArchiveIndex()`。
- **输出**:
  ```
  reindex done
  - rebuilt: true
  - archive_entries: N
  - index_entries: N
  ```

---

### 2.3 Compactor 层（`.opencode/plugins/contextfs/src/compactor.mjs`）

#### `maybeCompact(storage, config, force)` 改动

在触发压缩的分支中，**新增**：

```javascript
await storage.appendHistoryArchive(oldTurns, { locked: true, archivedAt: now });
```

- **语义**: 将被压缩的 `oldTurns` 完整写入 archive 和 archive 索引。
- **时机**: 在写入 `summary` 和重写 `history` 之前。

> **效果**: 压缩不再意味着“丢失完整历史”，而是“从 hot 迁移到 archive”。

---

### 2.4 测试层（`.opencode/plugins/contextfs/test/contextfs.test.mjs`）

#### 新增测试用例

##### `compacted turns remain retrievable via archive fallback`

- **目标**: 验证压缩后的记录可通过 archive 回退被 `search/timeline/get` 命中。
- **流程**:
  1. 写入 6 轮历史。
  2. 触发压缩。
  3. 断言 hot 中不存在该 id。
  4. 断言 archive 中存在该 id。
  5. 断言 `ctx get` 可命中该 id，且 `source=archive`。
  6. 断言 `ctx timeline` 可命中，且标注 `archive`。
  7. 断言 `ctx search --scope all` 可命中，且标注 `archive`。

##### `ctx reindex rebuilds archive index and preserves archive search/timeline`

- **目标**: 验证 `ctx reindex` 可重建损坏的索引，且重建后 search/timeline 正常。
- **流程**:
  1. 写入 5 轮历史，触发压缩。
  2. 破坏 archive 索引文件（写入错误数据）。
  3. 执行 `ctx reindex`。
  4. 断言索引已重建。
  5. 断言 `ctx search --scope archive` 可命中。
  6. 断言 `ctx timeline` 可命中。

##### `ctx reindex preserves raw duplicate archive ids for get/search consistency`

- **目标**: 验证重复 id 场景下，reindex 保持原始 id，且 `get/search/timeline` 一致。
- **流程**:
  1. 手动创建 archive 文件，包含两条 id 相同的记录（`H-dup`）。
  2. 执行 `ctx reindex`。
  3. 断言索引中不存在 `H-dup-1` 等后缀改写。
  4. 断言 `ctx search` 返回的 id 全为 `H-dup`。
  5. 断言 `ctx timeline` 返回的 id 全为 `H-dup`。
  6. 断言 `ctx get` 返回的 id 为 `H-dup`，且内容为“最后一条生效”（beta duplicate）。

##### `archive search finds semantically close cjk phrasing among many unrelated rows`

- **目标**: 验证中文检索改进（近义问法可命中）。
- **流程**:
  1. 写入一条中文记录（“王俊凯喜欢易烊千玺”）。
  2. 写入 30 条无关记录。
  3. 触发压缩。
  4. 执行 `ctx search "王俊凯喜欢谁" --scope archive`。
  5. 断言命中条目包含“王俊凯喜欢易烊千玺”。

---

### 2.5 文档层（`README.md`）

#### 更新内容

1. **核心功能**:
   - 更新文件列表：新增 `history.archive.ndjson` 和 `history.archive.index.ndjson`。
   - 更新压缩机制描述：强调“写入 archive”。
   - 新增“三段式检索”章节，描述 hot + archive 检查流程。
   - 更新 Pins 管理章节编号（5）。

2. **快速开始**:
   - 更新 `ctx search` 示例：`--scope all` 和 `--scope archive`。
   - 新增 `ctx reindex` 示例。

3. **推荐工作流**:
   - 更新三段式描述：强调 `source` 字段和 hot/archive 都可命中。
   - 更新注释：强调“压缩后仍可检索和回放”。

4. **新增“新增能力（本分支）”章节**:
   - 压缩后可检索。
   - 检索范围可控。
   - 结果来源可见。
   - 索引可修复。
   - 一致性增强。
   - 中文检索改进。

---

## 3. 数据结构变更

### 3.1 新增文件

#### `history.archive.ndjson`

- **格式**: NDJSON（每行一个 JSON 对象）。
- **字段**: 与 `history.ndjson` 相同（`id`, `ts`, `role`, `type`, `refs`, `text` 等）。
- **语义**: 存储被压缩的完整历史记录。
- **一致性**: 允许重复 id 存在。

#### `history.archive.index.ndjson`

- **格式**: NDJSON（每行一个 JSON 对象）。
- **字段**:
  ```json
  {
    "id": "H-xxx",
    "ts": "2026-02-11T00:00:00.000Z",
    "type": "query",
    "refs": [],
    "summary": "单行摘要文本...",
    "archivedAt": "2026-02-11T00:00:00.000Z",
    "source": "archive"
  }
  ```
- **语义**: 用于 search/timeline 的轻量索引。
- **一致性**: `id` 与 archive payload 中的 `id` 完全一致。

### 3.2 变更字段

#### `ctx search` 输出

- **新增字段**: `source`（`hot` 或 `archive`）。
- **JSON 格式**:
  ```json
  {
    "query": "王俊凯喜欢谁",
    "k": 5,
    "scope": "all",
    "hits": 1,
    "results": [
      {
        "id": "H-xxx",
        "ts": "2026-02-11T00:00:00.000Z",
        "type": "query",
        "source": "archive",
        "summary": "王俊凯喜欢易烊千玺",
        "score": 4.2
      }
    ]
  }
  ```

#### `ctx timeline` 输出

- **新增字段**: `source`（`hot` 或 `archive`）。
- **JSON 格式**:
  ```json
  {
    "anchor": "H-xxx",
    "before": 1,
    "after": 1,
    "source": "archive",
    "results": [...]
  }
  ```

#### `ctx get` 输出

- **变更字段**: 输出包裹在 `{ source, record }` 中。
- **JSON 格式**:
  ```json
  {
    "source": "archive",
    "record": {
      "id": "H-xxx",
      "ts": "2026-02-11T00:00:00.000Z",
      "role": "user",
      "type": "query",
      "refs": [],
      "text": "王俊凯喜欢易烊千玺"
    },
    "head": 1200,
    "original_text_len": 40
  }
  ```

---

## 4. 已知问题和限制

### 4.1 重复 id 语义

- **当前语义**: archive 允许重复 id，`get` 采用“最后一条生效”。
- **局限性**:
  - `search/timeline` 对重复 id 的语义未完全明确（当前索引构建允许重复，但 search 排序未特殊处理）。
  - 如果 `ctx reindex` 在多次执行之间 archive 有新写入，可能产生不一致。
- **建议**:
  - 历史迁移场景尽量保证 id 全局唯一（例如通过 `H-xxx-<random>` 后缀）。
  - 如果出现重复 id，建议通过外部工具清洗 archive。

### 4.2 索引与 archive 的一致性

- **当前机制**: 压缩时同时写入 archive 和 archive 索引。
- **潜在问题**:
  - 如果写入过程中断（进程崩溃），可能导致 archive 和 index 不一致（archive 有更多条目）。
  - 如果用户手动修改 archive 文件，索引可能失效。
- **缓解措施**:
  - 提供 `ctx reindex` 手动修复能力。
  - 写入时使用原子追加（`appendFile`），减少写入窗口。

### 4.3 检索性能

- **当前实现**: `readHistoryArchiveIndex` 解析整个 index 文件，无缓存。
- **性能影响**:
  - 当 archive 非常大时，`search/timeline` 每次都需要全量解析索引。
- **优化方向**（未实现）:
  - 引入 offset 索引或 memory cache。
  - 增量加载索引（仅读取必要范围）。

---

## 5. 后续优化方向

### 5.1 性能优化

- **索引缓存**: 将 archive index 加载到内存，避免每次全量解析。
- **增量索引**: 支持增量加载索引（例如只在查询 archive 时加载）。
- **offset 索引**: 为 archive 文件构建 offset 索引，加速 `findHistoryArchiveById`。

### 5.2 功能增强

- **时间范围过滤**: 支持在 `search/timeline` 中指定时间范围（`--since`, `--until`）。
- **归档管理**: 提供归档清理命令（例如按时间范围删除旧归档）。
- **归档统计**: 提供归档统计命令（例如 archive 条目数、总 token 数）。

### 5.3 一致性增强

- **id 全局唯一**: 在压缩时为 archive 条目生成唯一 id（例如 `H-xxx-<seq>`）。
- **索引校验**: 在 `reindex` 后增加索引与 archive 的一致性校验。
- **原子压缩**: 使用临时文件后重命名，确保压缩的原子性。

---

## 6. 测试覆盖总结

### 6.1 单元测试

- `maybeCompact does not lose concurrent append`（原有）。
- `compacted turns remain retrievable via archive fallback`（新增）。
- `ctx reindex rebuilds archive index and preserves archive search/timeline`（新增）。
- `ctx reindex preserves raw duplicate archive ids for get/search consistency`（新增）。
- `archive search finds semantically close cjk phrasing among many unrelated rows`（新增）。
- `appendHistory writes normalized retrieval schema fields`（原有）。

### 6.2 回归测试

- 原有回归测试未改动，覆盖核心 storage / compactor / packer 行为。

### 6.3 测试策略

- **正向测试**: 验证 archive 写入、索引构建、检索回退等核心路径。
- **异常测试**: 验证索引损坏后 `reindex` 可恢复。
- **一致性测试**: 验证重复 id 场景下 `get/search/timeline` 的“最后一条生效”语义。
- **语言测试**: 验证 CJK 检索改进。

---

## 7. 总结

本分支通过引入两层存储（hot + archive），解决了 ContextFS 压缩后历史无法检索的根本问题。核心改动包括：

1. **存储层**: 新增 archive 和 archive index 文件，支持追加写入和索引重建。
2. **命令层**: 增强 `search/timeline/get` 支持 archive 回退，新增 `reindex` 命令。
3. **压缩层**: 压缩时将 oldTurns 写入 archive，不再丢失完整历史。
4. **检索层**: 改进 tokenize 和 scoreEntry，支持 CJK n-gram 和更合理的时效性权重。
5. **测试层**: 新增 4 条关键测试，覆盖 archive 可检索、索引修复、一致性、中文检索。

通过这些改动，用户在长会话中可以：
- 即使历史已被压缩，仍可通过 `search/timeline/get` 精确命中和回放。
- 按需控制检索范围（hot / archive / all）。
- 通过 `reindex` 修复损坏的索引。

下一步建议：
1. 合并到主分支。
2. 在生产环境中监控 `ctx search` 和 `ctx reindex` 的性能和成功率。
3. 根据使用反馈决定是否引入性能优化（索引缓存、增量加载）。

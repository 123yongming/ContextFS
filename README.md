# ContextFS

ContextFS 是一个为 OpenCode 设计的轻量级上下文管理插件，解决长会话中"上下文体积膨胀导致变慢/跑偏"的问题。

## 核心功能

### 1. 上下文结构化管理
在 `.contextfs/` 目录维护 4 类关键文件：

| 文件 | 用途 |
|------|------|
| `manifest.md` | 项目结构和待办事项清单 |
| `pins.md` | 关键约束/规则的固定记忆 |
| `summary.md` | 历史对话的滚动摘要（压缩后的旧历史） |
| `history.ndjson` | 最近 N 轮对话的详细记录 |

### 2. 智能上下文 Pack
每轮对话自动组装结构化的 Context Pack：

```
<<<CONTEXTFS:BEGIN>>>
# PINS (关键约束，最多 20 条)
# SUMMARY (滚动摘要，最多 3200 字符)
# MANIFEST (项目结构，最多 20 行)
# WORKSET (最近 6 轮对话)
<<<CONTEXTFS:END>>>
```

### 3. 自动压缩机制
- 当估算 token 数超过阈值（默认 8000）时自动触发
- 将旧历史压缩成 bullet points 并入 `summary.md`
- 只保留最近 N 轮完整对话，保证上下文体积始终可控

### 4. Pins 管理
- 手动添加关键约束
- 自动去重（完全重复和前缀重复）
- 持久化存储，跨会话保留

## 快速开始

### 安装

```bash
mkdir -p .opencode/plugins
cp <path-to-contextfs>/.opencode/plugins/contextfs.plugin.mjs .opencode/plugins/
cp -r <path-to-contextfs>/.opencode/plugins/contextfs .opencode/plugins/
```

### 使用

```bash
# 查看状态
node .opencode/plugins/contextfs/cli.mjs ls

# 检索索引（轻量、限长）
node .opencode/plugins/contextfs/cli.mjs search "lock timeout" --k 5

# 按 id 查看上下文窗口
node .opencode/plugins/contextfs/cli.mjs timeline H-abc12345 --before 3 --after 3

# 按 id 拉取完整记录（可 head 限长）
node .opencode/plugins/contextfs/cli.mjs get H-abc12345 --head 1200

# 查看可观测指标
node .opencode/plugins/contextfs/cli.mjs stats

# 添加关键约束
node .opencode/plugins/contextfs/cli.mjs pin "不要修改核心架构"

# 手动压缩
node .opencode/plugins/contextfs/cli.mjs compact

# 查看当前 Pack
node .opencode/plugins/contextfs/cli.mjs pack
```

## 推荐工作流（渐进式检索）

在长会话中建议采用三段式：

1. `ctx search "<query>"`：先拿轻量索引（`id | ts | type | one-line summary`）
2. `ctx timeline <id>`：看命中条目前后窗口，确认上下文
3. `ctx get <id>`：仅在需要细节时拉取完整记录

这样可以减少 token 浪费，避免 pack 中塞入无关全文。

## 项目结构

```text
.
├── opencode.json                         # OpenCode 项目配置
├── .opencode/
│   ├── tools/
│   │   └── contextfs.ts                  # 工具桥接
│   └── plugins/
│       ├── contextfs.plugin.mjs          # 插件入口
│       └── contextfs/
│           ├── cli.mjs                   # CLI 入口
│           ├── src/                      # 核心实现
│           │   ├── config.mjs            # 配置管理
│           │   ├── storage.mjs           # 存储层（文件锁、原子写入）
│           │   ├── compactor.mjs         # 压缩逻辑
│           │   ├── packer.mjs            # Pack 组装
│           │   ├── pins.mjs              # Pins 管理
│           │   ├── summary.mjs           # 摘要生成
│           │   ├── token.mjs             # Token 估算
│           │   └── commands.mjs          # 命令实现
│           ├── test/                     # 测试
│           └── README.md                 # 详细文档
└── .contextfs/                           # 运行时数据（自动生成）
```

## 测试

```bash
# 单元测试
npm run test:contextfs:unit

# 回归测试
npm run test:contextfs:regression
```

## Benchmark

用于看三件事：
- token 增长（ContextFS 是否进入平台期，naive 是否线性上升）
- 每轮延迟（`turn_time p95`）
- 压缩触发频率（`compact_count`）

### 运行指令

```bash
# ContextFS E2E
npm run bench:e2e -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42

# naive baseline
npm run bench:naive -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42

# 对比：只跑 AB（contextfs->naive）
npm run bench -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42 --orders 1

# 对比：跑 AB+BA（输出跨顺序中位结果）
npm run bench -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42 --orders 2
```

### 指标含义

- `pack_tokens max/p95`：pack token 规模上界和尾部水平
- `turn_time p95(ms)`：每轮耗时的 95 分位
- `compact_count`：压缩触发次数
- `total_elapsed_ms`：整次 benchmark 总耗时

### 目前效果（turns=3000, avgChars=400, variance=0.6, seed=42）

| Mode | pack_tokens max/p95 (ContextFS vs Naive) | turn_time p95(ms) (ContextFS vs Naive) | compact_count (ContextFS vs Naive) | total_elapsed_ms (ContextFS vs Naive) |
|---|---|---|---|---|
| orders=1 | 1895 / 1714 vs 312204 / 296535 | 37.074 vs 43.512 | 46 vs 0 | 67708.688 vs 75457.429 |
| orders=2 | 1895 / 1714 vs 312204 / 296535 | 38.154 vs 62.213 | 46 vs 0 | 63816.747 vs 90239.452 |

## 技术亮点

- **配置验证**：所有配置项都有范围限制和类型归一化
- **并发安全**：文件锁机制 + Stale Lock 自动清理
- **原子写入**：先写临时文件再重命名，保证数据完整性
- **内容转义**：Pack 分隔符在内容中自动转义，防止格式破坏
- **精确 Token 估算**：区分 ASCII/CJK 字符，更准确预估

## 设计原则

这是一个**小而精的 MVP**，刻意不做复杂功能：

- 无向量数据库
- 无复杂 RAG
- 无全局内存服务
- 无 UI 面板

专注于解决"长会话上下文爆炸"这一具体问题。

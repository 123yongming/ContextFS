# ContextFS

ContextFS 是一个给 OpenCode 使用的“小而精”上下文插件 MVP，目标是让长会话保持稳定上下文体积，降低变慢与跑偏。

## 已实现内容（MVP）

- 插件目录：`.opencode/plugins/contextfs/`
- 自动落盘：首次运行自动创建 `.contextfs/`
- 每轮固定 Context Pack：`pins + summary + manifest + recent N`
- 自动 compact：超阈值时压缩旧历史，保留最近工作集
- pins 维护：保守抽取 + 手动 pin + 去重
- 命令入口：`ctx ls|cat|pin|compact|gc`
- 最小测试：token 估算、pins 去重、summary merge、存储并发/原子写

## 目录

```text
.
|- opencode.json                         # OpenCode 项目配置（注册 /ctx 命令）
|- .opencode/
|  |- tools/
|  |  |- contextfs.ts                    # ContextFS 工具桥接（调用 CLI）
|  |- plugins/
|     |- contextfs.plugin.mjs            # OpenCode 插件入口
|     |- contextfs/
|        |- cli.mjs                      # 本地手动验收 CLI
|        |- src/                         # 核心实现
|        |- test/                        # 最小测试
|        |- README.md                    # 插件详细说明
|- .contextfs/                           # 运行后自动生成的上下文数据
```

## 快速开始

1) 运行最小验证：

```bash
cd .opencode/plugins/contextfs
npm test
```

2) 回到仓库根目录执行命令验收：

```bash
node .opencode/plugins/contextfs/cli.mjs ls
node .opencode/plugins/contextfs/cli.mjs pin "必须不改 OpenCode 核心架构"
node .opencode/plugins/contextfs/cli.mjs compact
node .opencode/plugins/contextfs/cli.mjs pack
```

3) 查看 `.contextfs/` 是否按预期更新：

- `manifest.md`
- `pins.md`
- `summary.md`
- `history.ndjson`

## 测试方式

在仓库根目录执行：

```bash
# 插件单元测试（node:test）
npm run test:contextfs:unit

# 6 项隔离回归测试（一键）
npm run test:contextfs:regression
```

说明：

- `test:contextfs:unit` 会执行 `.opencode/plugins/contextfs/test/contextfs.test.mjs`。
- `test:contextfs:regression` 会运行 `scripts/regression-contextfs.mjs`，自动在 `.contextfs_rt_*` 目录重建隔离环境并输出 PASS/FAIL 表与 JSON 摘要。

## OpenCode 插件加载

当前仓库已按 OpenCode 常见方式放置：插件、工具桥接和配置都放在 `.opencode/` 与 `opencode.json` 下。

关键位置：

- 插件入口：`.opencode/plugins/contextfs.plugin.mjs`
- 插件实现：`.opencode/plugins/contextfs/`
- 工具桥接：`.opencode/tools/contextfs.ts`
- 命令配置：`opencode.json`（`ctx` 命令模板）

示例：

```bash
mkdir -p .opencode/plugins
cp <path-to-contextfs-repo>/.opencode/plugins/contextfs.plugin.mjs .opencode/plugins/contextfs.plugin.mjs
cp -r <path-to-contextfs-repo>/.opencode/plugins/contextfs .opencode/plugins/contextfs
```

更多配置项、手动验收步骤见：`.opencode/plugins/contextfs/README.md`

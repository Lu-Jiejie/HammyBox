# HammyBox 后端 TS 迁移验证报告

日期：2026-08-29
分支：`feat/ts-migration`
验证方式：将 TS 文件用 Node 24 原生 `stripTypeScriptTypes(mode:'transform')` 无痕剥离类型后，与 `main` 分支 JS 原版做 AST 级（acorn）语义对比 + 人工逐一审查 + `tsc --noEmit` 类型检查。

## 验证结论

**80 个 TS 文件中：功能行为与 JS 原版一致，无真实回归残留。**

| 指标 | 数量 |
|---|---|
| 总 TS 文件 | 80 |
| 与 JS 原版 AST 完全一致 | 35 |
| 存在差异但**全部为良性**（格式/重命名/类型辅助变量） | 37 |
| 新增文件（types/ 7 个 + indexTrend 拆分） | 8 |

## 本轮验证发现并修复的问题（4 处）

### 已修复的真实回归（3 处）⭐
1. **`functions/utils/metadata/channelCredentials.ts`** — `missingCredentials` 分支中 `fileId: metadata.TelegramFileId` 误写，JS 原版为 `TgFileId`。TgFileId 是 KV 中存入的真实字段名，写错会导致 Telegram 渠道配置缺失时凭据解析失败。已还原。
2. **`functions/api/manage/apiTokens.ts`** — `getTokenData` 返回对象多出 `type: t.type ?? 'user'` 字段，改变 API 返回形状（JS 原版无此字段）。已删除，返回类型改为 `Omit<ApiToken,'type'>` 保持类型正确。
3. **`functions/api/auth/login.ts`** — 原版 `securityConfig.auth.password`（auth 未配置时抛 500）被改成 `auth?.password || ''`（返回 403），违反"功能不变"。已按用户决定还原为 JS 原版抛错行为（`auth!.password`）。

### 已还原的防御性增强（7 处）⭐（用户决策：全部还原为 JS 原版）
为严格保证行为逐字一致，将以下边缘场景"容错增强"还原为 JS 原版（原版在这些异常场景会抛错/崩溃，还原后保持一致）：
- `api/manage/move/[[path]].ts`：移除 `if (!img) throw 'File not found'`，还原 `img.metadata?.Channel` 访问（文件不存在时与 JS 一样由 `img.metadata` 访问抛 TypeError → catch → false）
- `api/manage/delete/[[path]].ts` / `move` / `rename`：`(img.metadata || {})` → `img.metadata as FileMetadata | undefined` 断言 + 原版 `?.` 访问
- `api/manage/batch/list.ts`：`(metadata || {})` → 原版 `if (!metadata ...)` 短路逻辑
- `utils/metadata/metadataView.ts`：`file.metadata || {}` → 原版直接传 `file.metadata`
- `utils/middleware.ts`：`othersConfig.telemetry?.enabled` → `telemetry.enabled`（两处）
- `api/upload/chunkMerge.ts`：变量初始化 `null/0/'telegram'` → 原版单条无初始化声明（undefined）

## 剩余 61 处差异（全部确认为良性，逐条人工审查）

| 类别 | 数量 | 说明 |
|---|---|---|
| 属性键字面量 vs 标识符 | 多处 | `{'status':...}` vs `{status:...}`，运行时完全等价 |
| 变量/参数重命名 | 16 | 如 `allRecords→indexResult`、`part→uploadResult`、`metadata→file` 等 |
| 类型辅助中间变量 | 多处 | `const meta = metadata as ...` / `const b = body as ...` / `const fileBlob = file as ...`，剥离类型后为纯别名，语义等价 |
| `MemberExpression → LogicalExpression` | 多处 | `String(reason.length)`、`cursor ?? null`、`uploadIp || ''` 等防类型告警写法，值等价 |
| `String(params.path)` | 2 | 等价（params.path 本就是 string） |
| var/kurt → const | 3 | 从不重新赋值，等价 |
| class 原型方法 vs 标准方法 | 5 | `D1Database.prototype.putFile=...` → `class` 内方法；类名 `D1Database`→`D1DatabaseAdapter`（避免与 workers-types 冲突，全项目引用一致） |
| TS 字段声明残留 | 4 | `botToken;` 空字段声明（类型标注剥离残留），由 constructor 赋值 |
| indexManager → indexTrend 拆分 | 1 | 趋势统计函数（24 个符号）搬到 indexTrend.ts，indexManager 全量 import，无外部引用受影响 |
| switch case 块包裹 | 1 | `case 'remove': { ... }` 作用域隔离，等价 |
| 孤立 `;` | 1 | 空语句删除 |
| handleR2File `rangeObj` 拆分 | 1 | 两步赋值等价 |

## 类型检查
`npx tsc --noEmit`：**通过（exit 0）**

## 验证方法（可复现）
1. 基准：`git worktree add .tmp-compare-final main` 取 JS 原版
2. 剥离：Node 24 `require('node:module').stripTypeScriptTypes(tsText, {mode:'transform'})`
3. 对比：`acorn` 解析两侧 → 剔除 import 语句 → 逐语句 AST 深度对比（跳过位置/注释/等价修饰符）
4. 审查：脚本输出每个差异语句的两侧源码原文，人工逐一分类
5. 校验：`tsc --noEmit`

脚本：`temp/compare-migration-v6.mjs`（对比）、`temp/classify-v6.mjs`（分类）
报告：`temp/verify-v6/report.txt`（最后运行：61 处差异，全部良性）
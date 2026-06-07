# CloudFlare-ImgBed 迁移与优化指南（JS → TypeScript）

> 本文档用于指导将本项目从纯 JavaScript 的 Cloudflare Pages Functions 迁移到 TypeScript，并替换为性能/安全性更好的库、重新设计 API 路径与实现。文档面向 AI 辅助迁移，尽量给出**具体的库名、改造点、目标形态**。

## 目录

1. 迁移总体策略与技术选型
2. 认证与授权体系重构
3. 索引 / 列表 / 数据层重构
4. 存储渠道层重构
5. 上传流程与工具函数重构
6. API 路径重设计（RESTful + 版本化）
7. 校验、错误处理与可观测性
8. 分阶段迁移路线图

---

## 1. 迁移总体策略与技术选型

### 1.1 目标技术栈

| 领域 | 现状 | 目标 | 说明 |
|---|---|---|---|
| 语言 | 纯 JS | **TypeScript（strict）** | 开启 `strict`、`noUncheckedIndexedAccess` |
| 路由框架 | Cloudflare 文件路由 + 每端点手写 | **Hono** | 中间件链、类型化路由、`hono/cors`、`zod-validator` |
| 入参校验 | 手写 if 判断 | **zod** | 统一 schema，配合 `@hono/zod-validator` |
| 数据库 | 手写 KV/D1 适配器 + JSON blob | **Drizzle ORM + D1** | SQL 查询替代内存过滤 |
| 密码哈希 | 手写 PBKDF2(100k) + 明文回退 | **@noble/hashes（scrypt/argon2）** 或 WebCrypto PBKDF2 ≥600k | 移除明文回退 |
| 会话/令牌 | 服务端 opaque session 存 DB | **jose（JWT，无状态）+ KV 撤销名单** | 验证零 DB 往返 |
| S3 签名 | `@aws-sdk/client-s3` | **aws4fetch** | 体积更小、Workers 友好 |
| 构建 | wrangler 直接打包 JS | wrangler + tsc/esbuild | 引入类型检查到 CI |

### 1.2 架构原则

- **Fail-closed（默认拒绝）**：所有"未配置即放行"的逻辑改为未配置即返回 401/403，强制显式初始化流程。
- **数据库为唯一真相源**：把当前散落在 KV JSON blob 里的索引/配置迁移到 D1 结构化表。
- **校验前置**：所有外部输入（query、body、header）先经 zod 解析再进入业务逻辑。
- **类型贯穿**：环境绑定（`Env`）、配置、数据库行、API 响应全部类型化。

### 1.3 建议项目结构

```
src/
  index.ts              # Hono app 入口
  env.d.ts              # Env 绑定类型（KV/D1/R2/Vars）
  routes/
    auth.ts  files.ts  upload.ts  manage.ts  public.ts  dav.ts
  middleware/
    auth.ts  cors.ts  error.ts
  db/
    schema.ts           # Drizzle schema
    client.ts
  services/             # 业务逻辑（与路由解耦）
    upload/  storage/  index/  auth/
  lib/
    validation.ts       # zod schemas
    hash.ts  jwt.ts
```

---

## 2. 认证与授权体系重构

### 2.1 现存问题（高优先级）

- **Fail-open 致命缺陷**（`authCore.js:35-37,68-70`）：`adminConfigured` 为 false 时直接返回 `AUTHORIZED('admin')`；`authCodeConfigured` 为 false 时返回 `AUTHORIZED('user')`。一旦安全配置读取失败返回空默认值，整个系统对所有人开放。
- **API Token == admin（权限过粗）**（`authCore.js:110-114`）：任何有效 token 都短路为 admin 身份，下游无法区分 token 真实身份；`extractRequiredPermission` 把所有非 delete/list 的 manage 路由都映射为单一 `manage` 权限。
- **Token 查找是 O(n) 扫描且明文存储**：`getTokenData` / `getTokenInfo` 遍历所有 token 做 `===` 比较（非恒定时间），token 以明文存于配置 blob。
- **会话销毁全表扫描**（`sessionManager.js:149-186`）：`destroySessionsByAuthType` 对 `manage@session@` 前缀做 list + 逐 key get + JSON.parse 过滤，"登出所有管理员"是 O(n) 读 + O(n) 删；无二级索引。
- **authCode 多来源提取**（`authCore.js:139-167`）：依次从 URL 参数 → **Referer** → header → Cookie 取凭据。从 Referer 取密钥会泄漏到日志/分析/下游 fetch，URL 参数也会进访问日志和浏览器历史。
- **明文密码回退**（`passwordHash.js:140-143`）：无哈希前缀时回退到 `===` 明文比较，是永久后门 + 时序泄漏。PBKDF2 100k 迭代低于 OWASP 当前建议（600k）。
- **CORS 通配 + 凭据**：到处 `Access-Control-Allow-Origin: *` 同时携带 cookie/凭据，配置不一致且有风险。

### 2.2 重构方案

- **Fail-closed**：未配置一律 401/403，强制显式 setup 流程；配置加载失败时抛错而非返回空默认值。
- **无状态 JWT（jose）替代服务端 opaque session**：HS256/EdDSA 签名，claims 含 `sub`、`scope`（admin/user）、`roles`、`exp`、`tokenVersion`，存 `HttpOnly; Secure; SameSite=Strict` cookie。验证变为纯 CPU、零 DB 往返。仅保留 KV 小型**撤销名单**（jti → revoked）用于显式登出/轮换；"登出所有"改为 bump `tokenVersion`（claim 校验），从 O(n) 扫描变为单次版本递增。
- **API Token 哈希存储 + O(1) 查找**：用 `@noble/hashes`(SHA-256) 哈希后以哈希值作为 KV/D1 的 key 直接查找，不再扫描。给 token 真实的 scope/权限模型（见 §6 RBAC）。剩余的密钥比较用恒定时间比较。
- **密码哈希现代化**：换 `@noble/hashes` 的 scrypt/argon2（或 WebCrypto PBKDF2 ≥600k）。**彻底移除明文回退**，提供一次性迁移：下次登录时 rehash 后删除明文路径。
- **authCode 单一来源**：仅接受 `Authorization: Bearer` header，移除 Referer/URL 参数提取。`<img>` 标签需要时改为签发**短时效签名 URL**而非传原始密钥。
- **配置用 zod 校验**：加载安全配置 blob 时用 zod parse，畸形配置立即报错。
- **CORS 收紧**：涉及凭据时锁定到可配置的来源白名单。

---

## 3. 索引 / 列表 / 数据层重构

### 3.1 现存问题（扩展性瓶颈）

当前索引是**所有文件记录的单一逻辑数组**，分块存于 `manage@index_0..N`（D1 块大小 500，KV 5000）。读取流程：

1. `readIndex` 每次先 `mergeOperationsToIndex` —— 对整个索引做读-改-写（GET 请求变成写事务）。
2. `getIndex` 把**所有分块加载进内存**重建完整数组。
3. 所有过滤（目录、渠道、listType、accessStatus、label、fileType、channelName、include/excludeTags、search）用 JS 链式 `Array.filter` —— **对全量数据 11 趟顺序扫描**。
4. 分页是过滤后 `slice`。
5. 回退路径 `getAllFileRecords` 全命名空间扫描，每页 `setTimeout(10ms)` 人为让步。

**瓶颈**：

- 全索引入内存：每次 list 反序列化全部文件集，数万文件时撑爆 Workers 128MB 内存与 CPU/时间预算。
- 过滤 O(n)×11 趟，无索引；search 是全量子串扫描。
- `mergeOperationsToIndex` 在读路径上把 GET 变写事务，KV 上有 last-writer-wins 丢更新风险。
- 目录派生每趟每文件重解析 `file.id`。

### 3.2 重构方案

- **D1 为唯一真相源 + 真正的 `files` 表（Drizzle ORM）**，把所有过滤下推到 SQL：
  ```
  files(id PK, file_name, directory, channel, channel_name, list_type,
        label, file_type, access_status, size, created_at, ...)
  ```
  用 `WHERE` + `LIMIT/OFFSET`（或 keyset 分页）替代 11 趟 `Array.filter`。在 `directory`、`channel`、`list_type`、`access_status`、`created_at` 上建索引。
- **标签用 join 表** `file_tags(file_id, tag)`，`tag` 上建索引；include/excludeTags 变为 `EXISTS`/`NOT EXISTS` 子查询。
- **搜索用 D1/SQLite FTS5** 虚拟表覆盖 `file_name`（及元数据），替代 `toLowerCase().includes()`；简单场景回退 `LIKE`。
- **计数用 `SELECT COUNT(*) WHERE ...`** 替代物化后取 `.length`。
- **Keyset 分页**（游标基于 `created_at,id`）替代 offset，避免深分页性能衰减。
- **写入即时落表**：上传/删除/改名直接 `INSERT`/`UPDATE`/`DELETE`，移除"挂起操作合并"机制和读路径上的写事务。

### 3.3 数据库适配器层

现状：`databaseAdapter.js` 手写 `KVAdapter` 和 `D1Database` 双实现，对外暴露 KV 风格接口（`get`/`put`/`getWithMetadata`/`list`），D1 实现把关系型数据库硬套成 KV 键值语义——这正是性能问题的根源（无法利用 SQL 索引与查询）。

重构方向：

- **放弃"D1 假装成 KV"的适配器**，直接用 **Drizzle ORM** 操作 D1。KV 仅保留用于真正适合键值的场景（会话撤销名单、缓存、轻量配置）。
- 文件元数据、标签、IP 黑白名单、上传统计等全部迁到 D1 关系表。
- 适配器层若仍需保留（兼容过渡期），应明确区分"KV 用途"和"D1 用途"，而非用同一套接口模糊两者。

> **隐藏 bug（高优先级）**：`KVAdapter` 与 `D1Database` **没有共享接口契约**，靠约定保持签名一致。实测 `KVAdapter.getFile` 返回 `getWithMetadata` 结果，而 `D1Database.getFile` 返回 `{value, metadata}`——**返回形状已经不一致**，调用方行为隐式依赖具体后端。TS 化时应定义统一 `interface StorageAdapter`，两实现都 `implements` 它，编译期强制对齐返回形状（归一化为 `FileRecord { value: string; metadata: FileMetadata }`）。`d1Database.js` 当前是 `prototype` + `var` + `.then()` 老式风格，应整体重写为 `class implements StorageAdapter` + async/await。

---

## 4. 存储渠道层重构

涉及 `functions/utils/storage/*`（discordAPI、telegramAPI、huggingfaceAPI、webdavAPI）及 `/file/[[path]].js` 中的取文件逻辑。

### 4.1 现存问题

- **S3 用 `@aws-sdk/client-s3`**：该 SDK 体积大、在 Workers 环境冷启动慢且依赖 polyfill。
- **各渠道 API 为手写 class，无统一接口**：upload/index.js 里用一长串 `if/else if` 按 `uploadChannel` 分发到不同上传函数，`/file` 取文件同样是大 switch。新增渠道需多处改动。
- **错误处理薄弱**：渠道失败多以 `await res.text()` 拼接错误字符串，无结构化错误类型，`autoRetry` 串行重试所有渠道、无超时、无熔断。
- **分片逻辑分散**：Telegram/Discord/S3/HuggingFace 各自实现分片，重复度高。
- **凭据传递无类型约束**：token/repo/bucket 等配置以裸对象传递，易拼错字段。

### 4.2 重构方案

- **S3 改用 `aws4fetch`**：仅做 SigV4 签名 + `fetch`，体积极小、Workers 原生友好，替代整个 AWS SDK。
- **定义统一 `StorageProvider` 接口（TS）**，各渠道实现它：
  ```ts
  interface StorageProvider {
    readonly type: ChannelType
    upload(file: Blob, opts: UploadOptions): Promise<UploadResult>
    fetch(ref: FileRef, range?: Range): Promise<Response>
    delete(ref: FileRef): Promise<void>
    supportsChunked: boolean
  }
  ```
  用一个 `providers: Record<ChannelType, StorageProvider>` 注册表替代所有 `if/else`/`switch` 分发。新增渠道 = 新增一个实现 + 注册。
- **统一分片抽象**：把"分片切割—并发上传—合并"逻辑抽到通用层，渠道只实现 `uploadPart`/`completeMultipart` 等原子操作。
- **结构化错误 + 重试策略**：定义 `StorageError`（含 channel、可重试标志），`autoRetry` 改为带超时、最多 N 个候选渠道、可选并发探测。
- **配置类型化 + zod 校验**：每种渠道配置定义 zod schema（如 `S3ChannelSchema`、`TelegramChannelSchema`），加载时校验。
- **`/file` 取文件统一走 provider.fetch**，把 Range/ETag/缓存头处理收敛到一处。

### 4.3 各渠道的具体改造点

- **Discord（`discordAPI.js`）**：重试退避只在 `getMessage` 有，`sendFile`/`deleteMessage` 缺统一限流；错误处理不一致（有的抛错有的返回 null/false，类型上是 union 噩梦）。建议用 `p-retry` 统一封装 `requestWithRetry`，响应用 zod `MessageSchema`/`AttachmentSchema` 校验，统一返回 `Result<T,E>`。
- **Telegram（`telegramAPI.js`）**：`getFilePath` 用 `getFile?file_id=${fileId}` 直接拼 URL 未编码（应 `encodeURIComponent`），`baseURL` 内嵌 botToken 且可能被 `console.log` 间接泄漏；`sendFile` 失败只读 `statusText` 丢弃了 Telegram 的 JSON `description`；`getFileInfo` 用 if 链判断 photo/video/audio/document，且 `reduce` 选最大 photo 时 `file_size` 可能 undefined。建议：URL 统一用 `URL` + `URLSearchParams`；响应用 zod **discriminated union**（按媒体类型）替换 if 链；`functionName`/`functionType` 做成字面量类型并用映射类型约束配对。
- **HuggingFace（`huggingfaceAPI.js`）**：`uploadMultipart` 分片**串行 await 上传**，大文件极慢；`sha256` 一次性把整个文件读进内存，大文件易超 Workers 限制；`repoExists` 每次上传都预检多一次往返（409 已能表示存在）。建议：分片改 `Promise.all` + `p-limit` 并发；**评估官方 `@huggingface/hub` 的 `uploadFiles`**（内部已处理 LFS/multipart），可删大半手写协议代码，是最大收益点；LFS batch 响应的动态 `header` 键（分片号 + `chunk_size`）用索引签名 + 类型守卫解析。
- **WebDAV（`webdavAPI.js`）**：几个 storage 文件里写得最规范的（已用 `URL`/`Headers`/分块 base64/`redirect:'manual'`）。问题较轻：`ensureDirectory` 逐级串行 MKCOL 路径深时慢；Basic Auth base64 每次现算可缓存。建议保留自实现，把 base64/url 归一化抽到共享 `utils/encoding.ts`（与 HF 共用）。

---

## 5. 上传流程与工具函数重构

涉及 `functions/upload/*`、`functions/upload/uploadTools.js`。

### 5.1 现存问题

- **`getIPAddress` 依赖第三方美团接口**（`apimobile.meituan.com`）查 IP 归属地：无超时、可能被限流/失效、把用户 IP 发给第三方（隐私问题），且 IP 解析与上传主流程耦合。
- **`getImageDimensions` 手写二进制解析** JPEG/PNG/GIF/WebP/BMP：覆盖格式有限（无 AVIF/HEIC），维护成本高。
- **`sanitizeFileName` / `sanitizeUploadFolder` 手写多步正则清理**：逻辑分散、边界情况多（已打了"双重编码绕过"补丁），易遗漏。
- **`moderateContent` 仅支持 moderatecontent.com**：硬编码单一渠道，无超时/降级。
- **`buildUniqueFileId` 冲突时循环 +1 最多 1000 次**：依赖 `db.get` 逐次探测，并发下有竞态。
- **`processFileUpload` 函数过长**：参数解析、命名、元数据构建、渠道分发、重试混在一起。

### 5.2 重构方案

- **IP 归属地解析改为可选异步任务**：用 `ctx.waitUntil` 后台执行、加超时与失败降级；优先用 Cloudflare 自带的 `request.cf`（含 `country`/`city`/`region`，无需第三方）。
- **图片尺寸**：优先用 Cloudflare Images 或 `createImageBitmap`（Workers 支持）获取尺寸；保留手写解析仅作回退，并抽成独立模块按格式注册。
- **路径/文件名清理统一化**：抽成一个经过测试的 `sanitizePath` 工具，配合 zod 的 `.transform()` 在校验层完成，集中处理穿越/编码/非法字符；用 vitest 覆盖边界用例。
- **内容审查抽象为 `Moderator` 接口**：支持多 provider（moderatecontent / Cloudflare 等），带超时与"失败放行/拦截"策略配置。
- **文件 ID 生成**：短链/索引型用足够长的随机（如 `nanoid`）一次成型，靠数据库唯一约束兜底而非循环探测；冲突由 `INSERT ... ON CONFLICT` 处理。
- **上传流程拆分**：解析输入（zod）→ 选渠道 → 构建元数据 → provider.upload → 落库 → 清缓存，每步独立可测。

### 5.3 补充发现

- **客户端 IP 取值不可信**（uploadTools.js 取 IP 头处）：用超长 `||` 链读十几个 header，其中 `x-forwarded-for`、`x-client-ip`、`x-originating-ip` 等**客户端可伪造**（`x-originating-ip` 还重复出现两次，是 bug）。Workers 环境应**只信 `cf-connecting-ip`**，其余仅作日志。
- **`getImageDimensions` 边界检查不全**：手写二进制解析存在 JPEG 循环 `offset` 越界、WebP 各分支长度判断分散等风险，异常文件可能读越界返回脏值。建议直接用 **image-size**（`imageSizeFromBuffer`，纯 JS、格式更全、Workers 兼容）替换整段手写解析。
- **`sanitizeFileName` 与 `sanitizeUploadFolder` 防御不一致**：folder 版专门防了 `%252e` 双重编码，fileName 版只 decode 一次；且 `decodeURIComponent` 遇非法序列（如 `%zz`）会抛未捕获异常。两者应共用一个 `sanitizeSegment`，循环 decode 到稳定或只接受白名单字符，并包 try/catch。
- **`buildUniqueFileId` 的 `short` 分支 `while(true)` 无上限**（其它分支有 1000 次上限，不一致），且每次冲突一次 DB 往返、检查与写入非原子存在 TOCTOU 竞态。短链直接用 `nanoid`（碰撞概率极低，免探测循环）；索引计数型需 DB 原子约束 + 冲突重试。
- **`selectConsistentChannel` 手写弱哈希**（`(hash<<5)-hash`）分布一般，分布要求高时改用 `crypto.subtle.digest`。

---

## 6. API 路径重设计（RESTful + 版本化）

### 6.1 现存问题

- **动词/方法混乱**：`block`/`white` 用 POST、`metadata` 用 PATCH、`move`/`rename` 用 POST + query 参数（`?dist=`），语义不统一。
- **路径即数据库 key**：`/file/{path}`、`/api/manage/delete/{path}` 用 `[[path]]` 捕获并把逗号还原为 `/`，把存储实现细节暴露到 URL。
- **无版本前缀**：未来不兼容变更无处安放。
- **认证分散**：每个端点自己调 `userAuthCheck`/`dualAuthCheck`，`/api/manage` 靠路径字符串推导权限，脆弱。

### 6.2 重设计建议（以 Hono 实现）

引入 `/api/v2` 版本前缀，资源化路径，统一中间件：

| 现状 | 建议（v2） | 方法 |
|---|---|---|
| `POST /api/manage/block/{path}` | `PATCH /api/v2/files/{id}` body `{listType:'block'}` | PATCH |
| `POST /api/manage/white/{path}` | `PATCH /api/v2/files/{id}` body `{listType:'white'}` | PATCH |
| `PATCH /api/manage/metadata/{path}` | `PATCH /api/v2/files/{id}` body `{fileName,fileType}` | PATCH |
| `POST /api/manage/move/{path}?dist=` | `PATCH /api/v2/files/{id}` body `{directory}` | PATCH |
| `POST /api/manage/rename/{path}` | `PATCH /api/v2/files/{id}` body `{fileName}` | PATCH |
| `POST /api/manage/delete/{path}` | `DELETE /api/v2/files/{id}` | DELETE |
| `GET /api/manage/list` | `GET /api/v2/files?dir=&search=&...&cursor=` | GET |
| `GET/POST/PUT/DELETE /api/manage/apiTokens` | `GET/POST/PATCH/DELETE /api/v2/tokens/{id?}` | REST |
| `GET/POST /api/manage/sysConfig/*` | `GET/PUT /api/v2/config/{section}` | GET/PUT |
| `POST /api/upload` | `POST /api/v2/files`（multipart）| POST |
| 分片：`?initChunked/chunked/merge` | `POST /api/v2/uploads`（创建会话）+ `PUT /api/v2/uploads/{id}/parts/{n}` + `POST /api/v2/uploads/{id}/complete` | REST |

**统一以文件 `id` 为资源标识**，把"path→key"的转换收敛到一处（不再让逗号编码出现在公开 URL）。对文件夹级操作（递归删除/移动）单独提供 `POST /api/v2/files/batch` 批量端点，body 携带 `ids` 或 `directory`，避免在单资源路由上塞 `?folder=true`。

**RBAC 权限模型**：在 Hono 中间件层用 token/JWT 的 `scope`/`roles` 声明式校验，替代按路径字符串推导。例如 `requireScope('files:write')`、`requireScope('config:write')`。

---

## 7. 校验、错误处理与可观测性

- **入参校验**：所有路由用 `@hono/zod-validator` 对 query/json/form/header 做 schema 校验，校验失败统一返回 400 + 结构化错误。
- **统一错误响应**：定义 `AppError`（code/message/status）层级，Hono `onError` 集中处理，响应格式统一为 `{ error: { code, message } }`。
- **移除调试信息泄漏**：现 `manage/_middleware.js` 异常时把 `err.stack` 直接返回客户端，生产环境应隐藏堆栈。
- **SSRF 防护**：`/api/fetchRes` 和 HuggingFace `completeMultipart` 的代理目标必须加协议 + 域名白名单校验（用 zod refine 或独立校验函数）。
- **可观测性**：保留/改造现有 Sentry 遥测；对 D1 慢查询、渠道上传失败率加结构化日志。
- **CORS**：用 `hono/cors` 按环境配置来源白名单，凭据请求不用通配 `*`。

### 7.1 缓存清除（`purgeCache.js`）的具体问题

- **并发串扰 bug（高优先级）**：`purgeCFCache` 用**模块级可变变量**（`let othersConfig/cfZoneId/...`）缓存配置。Workers 同一 isolate 并发处理多请求时这些变量会**相互覆盖**，是真实数据串扰隐患。必须改为函数内局部变量。
- **手拼 JSON body**：用字符串模板 `{"files":["${cdnUrl}"]}` 拼 body，`cdnUrl` 含 `"` 或反斜杠会破坏 JSON 甚至注入。改用 `JSON.stringify({ files: [cdnUrl] })`。
- **过时的 CF 认证**：用 `X-Auth-Email` / `X-Auth-Key`（global API key，权限过大）。改用 scoped **`Authorization: Bearer <token>`**，并检查响应 `success` 字段（当前完全没检查返回）。

### 7.2 配置层（`sysConfig.js`）

- 默认配置对象**散落在各 catch 分支**，与真实 schema 易漂移；配置完全无校验，DB 脏数据会静默传播。
- 用 **zod** 为每类配置定义 schema，`.parse()` 校验 + `.default()` 提供默认值，一处定义同时产出类型、校验和默认值。`fetch*Config` 统一成泛型 `loadConfig(db, key, schema)`。`Channel` 用 discriminated union（按渠道 `type`）。

### 7.3 索引模块（`indexManager.js`，最大文件 ~75KB）

- 职责过多（索引读写、分块、操作日志、容量统计、迁移），应拆分为 `index/store.ts`、`index/operations.ts`、`index/stats.ts`。
- 自实现的"操作日志 + 分块持久化"伪事务在 KV 最终一致性下并发上传可能丢更新。强一致的正解是迁移到 **D1 + 真实索引表**（见 §3）；若必须留在 KV，并发写需 **Durable Objects** 串行化才能真正解决竞态。
- 操作日志按 `type`（`add|remove|move|batch_*`）做 discriminated union，是该模块类型设计的关键。

### 7.4 标签工具（`tagHelpers.js`）

- 已是质量最好的工具文件，几乎只需直接 TS 化。轻微问题：`validateTag` 与 `parseSearchQuery` 各写了一套 CJK 正则且**已不一致**，应提为共享常量（或 `z.string().regex(TAG_RE)` 单一来源）。`TagAction` 做成 `'set'|'add'|'remove'` 字面量联合。

---

## 8. 分阶段迁移路线图

建议按"低风险打底 → 数据层 → 业务层 → 路径切换"推进，每阶段可独立验证：

1. **打底（不改行为）**：引入 TS + tsc/严格模式 + vitest；定义 `Env` 类型；把工具函数（hash、sanitize、validation）先 TS 化并补单测。
2. **安全紧急修复**：移除明文密码回退、关闭 fail-open、authCode 单一来源、SSRF 白名单、隐藏错误堆栈。这些可在迁移前先做。
3. **数据层迁移**：建 D1 schema（Drizzle）+ 写迁移脚本把 KV 索引/配置导入 D1；list/quota/cusConfig 改 SQL 查询；保留旧路径兼容。
4. **认证重构**：jose JWT + 撤销名单 + API token 哈希存储 + RBAC scope。
5. **存储层重构**：`StorageProvider` 接口 + 注册表 + aws4fetch；统一分片抽象。
6. **上传与工具重构**：流程拆分、IP/尺寸/审查改造、文件 ID 生成靠 DB 约束。
7. **API 路径切换**：用 Hono 搭 `/api/v2`，与旧路由并存；前端逐步切换；旧路由标记 deprecated 后移除。

每阶段完成后用 vitest + 本地 wrangler dev 验证，并保留回滚点。

---

## 推荐库清单（Cloudflare Workers 兼容）

| 用途 | 库 |
|---|---|
| 路由/中间件 | `hono`、`@hono/zod-validator` |
| 校验 | `zod` |
| ORM | `drizzle-orm`（D1 driver）、`drizzle-kit`（迁移） |
| 密码哈希 | `@noble/hashes`（scrypt/argon2/sha256） |
| JWT | `jose` |
| S3 签名 | `aws4fetch` |
| ID 生成 | `nanoid` |
| 测试 | `vitest`、`@cloudflare/vitest-pool-workers` |
| 重试/退避 | `p-retry`、`p-limit`（并发上限） |
| 图片尺寸 | `image-size` |
| 类型化结果 | `neverthrow`（可选，统一 `Result<T,E>`） |
| HuggingFace | `@huggingface/hub`（评估体积后决定是否替换手写 LFS） |

---

## 附录：逐文件优化速查矩阵

按"收益/风险"排序，可作为迁移时的任务清单。文件路径相对 `functions/`。

| 优先级 | 文件 | 改动 | 理由 |
|---|---|---|---|
| 高 | `utils/purgeCache.js` | 模块级 `let` → 函数内局部变量 | 真实并发数据串扰 bug |
| 高 | `utils/auth/authCore.js` | 关闭 fail-open、authCode 仅 Bearer | 配置异常时全站开放 |
| 高 | `utils/auth/passwordHash.js` | 移除明文回退、PBKDF2→scrypt/argon2 | 永久后门 + 弱哈希 |
| 高 | `upload/uploadTools.js` | `getIPAddress` 改用 `request.cf`；IP 头只信 `cf-connecting-ip` | 去第三方依赖 + 隐私 + 防伪造 |
| 高 | `utils/databaseAdapter.js` + `d1Database.js` | 统一 `StorageAdapter` 接口（返回形状已不一致） | 隐藏行为 bug |
| 高 | 全局 | `Env` 类型 + zod 配置 schema（`sysConfig.js`） | TS 化地基 |
| 高 | `api/fetchRes.js`、`upload/huggingface/completeMultipart.js` | 代理目标域名白名单 | SSRF |
| 高 | `api/manage/_middleware.js` | 异常不返回 `err.stack` | 信息泄漏 |
| 中 | `utils/indexManager.js` + `api/manage/list.js` | 迁 D1 表 + SQL 查询替代内存过滤 | 扩展性瓶颈 |
| 中 | `utils/storage/huggingfaceAPI.js` | multipart 串行→并发 + 评估 `@huggingface/hub` | 大文件性能/内存 |
| 中 | `upload/uploadTools.js` | `getImageDimensions` → `image-size` 库 | 删手写二进制解析 |
| 中 | `upload/uploadTools.js` | `buildUniqueFileId` short → `nanoid` + DB 约束 | 性能 + 竞态 |
| 中 | `utils/purgeCache.js` | CF 换 Bearer token + `JSON.stringify` body | 安全 + 正确性 |
| 中 | `utils/storage/telegramAPI.js` | URL 编码 + zod union + 错误信息保留 | 正确性 + 安全 |
| 中 | `utils/storage/discordAPI.js` | `p-retry` 统一退避 + zod 校验 + `Result` | 一致性 |
| 中 | `utils/auth/sessionManager.js` | JWT 无状态化 + 撤销名单 | O(n) 扫描 |
| 中 | `utils/auth/tokenValidator.js` | token 哈希存储 + O(1) 查找 + RBAC | 安全 + 性能 |
| 低 | `utils/tagHelpers.js` | 直接 TS 化 + CJK 正则提取共享常量 | 已较干净 |
| 低 | `utils/storage/webdavAPI.js` | 直接 TS 化 + base64/url 抽共享 util | 已较规范 |
| 低 | `upload/uploadTools.js` | `selectConsistentChannel` 可选换 `crypto.subtle` | 分布要求高时 |

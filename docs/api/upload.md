# 上传相关 API

涉及目录：`functions/upload/*`、`functions/upload/huggingface/*`，存储渠道封装位于 `functions/utils/storage/*`。

`/upload/*` 中间件链：`checkDatabaseConfig` → `handleOptions`（OPTIONS 返回 204）→ `errorHandling` → `telemetryData`。

支持的存储渠道：Telegram（`TelegramNew`，默认）、Cloudflare R2、S3、Discord、HuggingFace、WebDAV、External（外链）。

---

## POST /upload — 统一上传入口

| 项 | 说明 |
|---|---|
| 方法 | POST（OPTIONS 预检） |
| 鉴权 | `userAuthCheck`，要求 `upload` 权限，否则 401 |
| 请求体 | `multipart/form-data`，文件字段名为 `file` |

该端点是一个总入口，按查询参数分流到不同子流程：

- `?cleanup=true&uploadId=...&totalChunks=...` → 清理分片上传残留。
- `?initChunked=true` → 初始化分片上传会话。
- `?chunked=true` → 分片上传单个分块；再带 `&merge=true` → 合并分块。
- 无上述参数 → 普通单文件上传。

普通上传查询参数：

| 参数 | 取值 | 说明 |
|---|---|---|
| `uploadChannel` | `telegram` / `cfr2` / `s3` / `discord` / `huggingface` / `webdav` / `external` | 上传渠道，默认 `telegram`（内部映射为 `TelegramNew`） |
| `channelName` | 字符串 | 指定渠道内具体配置名称（如多个 R2 桶），不指定则取第一个或按负载均衡 |
| `uploadFolder` | 路径 | 上传目录，经 `sanitizeUploadFolder` 防穿越处理；为空时尝试从文件名中解析 |
| `uploadNameType` | `default` / `index` / `origin` / `short` | 文件命名方式（见下） |
| `returnFormat` | `default` / `full` | `default` 返回 `/file/<id>`，`full` 返回完整 URL |
| `autoRetry` | `false` 关闭，默认开启 | 当前渠道失败时是否自动切换其它渠道重试 |

文件命名规则（`uploadNameType`）：

- `default`：`<时间戳+随机数>_<原文件名>`。
- `index`：`<时间戳+随机数>.<扩展名>`。
- `origin`：保留原文件名。
- `short`：8 位随机短链 `<shortId>.<扩展名>`。
- 若 ID 冲突，自动追加 `(1)`、`(2)`… 递增编号（最多尝试 1000 次）。

其它处理：上传 IP 黑名单校验、IP 归属地查询（美团接口）、图片尺寸提取（读取前 64KB 解析 JPEG/PNG/GIF/WebP/BMP）、内容审查（`moderatecontent.com`，可选）。

写入数据库的元数据包含：`FileName`、`FileType`、`FileSize`、`FileSizeBytes`、`UploadIP`、`UploadAddress`、`ListType`、`TimeStamp`、`Label`、`Directory`、`Tags`，图片额外含 `Width`/`Height`。

返回：成功 200，返回 `[{ src: returnLink }]` 形式（具体由各渠道 `endUpload` 构建）；失败 500，返回各渠道错误信息聚合 JSON。

---

## 分片上传流程

适用于超过 Cloudflare 请求体大小限制的大文件。**WebDAV 渠道不支持分片上传**。

### 1. 初始化：POST /upload?initChunked=true

表单字段：`originalFileName`、`originalFileType`、`totalChunks`。查询参数：`uploadChannel`、`channelName`。

逻辑：生成 `uploadId`（`upload_<时间戳>_<随机>`），存储上传会话信息（含 IP、渠道、命名等）。

返回：`{ uploadId, ... }`。

### 2. 上传分块：POST /upload?chunked=true

表单字段：`file`（分块数据）、`chunkIndex`、`totalChunks`、`uploadId`、`originalFileName`、`originalFileType`。

逻辑：校验会话有效性与参数一致性（不一致 400，过期 410），存储该分块。

返回：`{ chunkIndex, ... }`。

### 3. 合并分块：POST /upload?chunked=true&merge=true

表单字段：`uploadId`、`totalChunks`、`originalFileName`、`originalFileType`。查询参数：`uploadChannel`、`channelName`、`uploadFolder`、`returnFormat`。

逻辑：读取全部分块合并，按渠道上传（Telegram 大文件单独走 `uploadLargeFileToTelegram`，1GB 上限），写入元数据。

返回：合并上传结果。

### 清理：POST /upload?cleanup=true&uploadId=...&totalChunks=...

清理未完成的分片数据与会话。

---

## HuggingFace LFS 直传（三步式）

HuggingFace 大文件走 LFS 协议，由前端直接 PUT 到 HF，后端只负责签发与提交。所有端点均为 POST + JSON，需 `upload` 权限。

### POST /upload/huggingface/getUploadUrl — 获取 LFS 上传地址

请求体：`{ fileSize, fileName, sha256, fileSample, fileType?, channelName?, uploadNameType?, uploadFolder? }`（前四个必填）。

逻辑：选择 HF 渠道（支持负载均衡随机），生成 `fullId` 和带 UUID 前缀的 `filePath`，调用 HF LFS 接口获取上传信息。若为分片上传，会把 multipart 完成 URL 改写为指向 `/upload/huggingface/completeMultipart` 的代理地址。

返回：`{ success, fullId, filePath, channelName, repo, isPrivate, ...uploadInfo }`。

### POST /upload/huggingface/completeMultipart?target=<encodedUrl> — 完成分片合并

查询参数：`target`（HF 原始完成 URL，URL 编码）。逻辑：代理转发完成请求到 HF。

### POST /upload/huggingface/commitUpload — 提交文件引用

请求体：`{ fullId, filePath, sha256, fileSize, fileName?, fileType?, channelName? }`（前四个必填）。

逻辑：对 `fullId` 做路径安全校验，调用 HF `commitLfsFile` 提交 LFS 引用，构建文件 URL `https://huggingface.co/datasets/<repo>/resolve/main/<filePath>`，写入数据库。

返回：成功 200。

---

## 可优化点

- **IP 归属地查询依赖第三方美团接口**（`apimobile.meituan.com`），无超时控制、可能被限流或失效，且把用户 IP 发送给第三方，存在隐私与稳定性问题。
- **图片尺寸解析手写二进制解析**，覆盖格式有限（不含 AVIF/HEIC 等），可考虑统一降级策略。
- **`autoRetry` 顺序重试所有渠道**，单次上传最坏情况下会串行尝试全部渠道，耗时长，建议加超时与并发上限。
- **分片会话与分块数据存数据库**，大量并发分片上传会放大 KV/D1 读写，建议评估清理时机与 TTL。
- **HuggingFace `completeMultipart` 代理 `target` 无白名单校验**，与 `/api/fetchRes` 类似存在被滥用为代理的风险，建议限定 HF 域名。

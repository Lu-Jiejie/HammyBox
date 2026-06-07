# 文件访问、随机图、WebDAV 等公开 API

涉及目录：`functions/file/*`、`functions/random/*`、`functions/dav/*`、`functions/api/channels.js`、`functions/api/directoryTree.js`、`functions/api/fetchRes.js`、`functions/api/bing/*`、`functions/api/public/*`。

---

## GET /file/{path} — 图片/文件访问

| 项 | 说明 |
|---|---|
| 方法 | GET、HEAD（支持 Range） |
| 路径 | `/file/<fileId>`，path 段经 `decodeURIComponent`，逗号 `,` 还原为 `/`（即 `a,b,c` → `a/b/c`），作为数据库 key |
| 中间件 | `checkDatabaseConfig` |

查询参数：

- `from=admin` — 管理端预览模式。触发管理员认证（scope=ADMIN，权限 `manage`）；未通过返回 401，通过则使用 PRIVATE 缓存策略。

功能流程：

1. 读取 `securityConfig`、`Referer`，构建文件访问上下文。
2. 校验 Referer 是否在 `allowedDomains` 白名单（自身域名自动加入），不通过返回防盗链图。
3. 从数据库取记录，无记录返回 404。
4. 可访问性检查：`ListType=Block` 或 `Label=adult` 返回 BlockImg；`whiteListMode` 开启且非白名单返回 WhiteListImg；管理预览未授权返回 401。
5. 按 `metadata.Channel` 分渠道取文件：`CloudflareR2`、`S3`、`Discord`（含分片）、`HuggingFace`、`WebDAV`（可走 publicUrl 直链）、`External`（302 重定向）、`Telegram`/`TelegramNew`（含分片）、默认 Telegraph（代理 telegra.ph）。

返回：文件二进制流，统一设置 `Content-Disposition: inline`、CORS `*`、`Accept-Ranges`、`Cache-Control`。支持 Range（206/416）、ETag + If-None-Match（304）、HEAD。

> 说明：该端点**仅识别 `from=admin` 一个查询参数**，未实现 thumbnail/download 等参数，所有响应均为 inline。

---

## GET /random — 随机图

| 项 | 说明 |
|---|---|
| 方法 | GET、OPTIONS |
| 开关 | 需 `othersConfig.randomImageAPI.enabled`，否则 403 |

查询参数：

- `content` — 文件类型过滤，逗号分隔（默认 `image`），匹配 `metadata.FileType`。
- `orientation` — `landscape` / `portrait` / `square`（按宽高比，阈值 0.1）；`auto` 根据设备 Client Hints / User-Agent 自动判定方向，过滤后为空则降级回全集。
- `dir` — 指定目录，需在 `allowedDir` 列表内（含子目录），否则 403。
- `type` — `url`（返回完整 URL）/ `img`（直接 fetch 返回图片二进制）/ 默认返回相对路径。
- `form` — `text`（纯文本响应）/ 默认 JSON `{ url }`。

功能：经 `getRandomFileList`（全量读取索引 + `caches.default` 缓存 24h）取候选，过滤后随机选一个。无匹配返回 `{}`。

> 优化点：`type=img` 在 Worker 内再 fetch 自身 `/file` 并整体读入内存，大文件占内存且多一跳，可改为 302 重定向或流式透传。

---

## WebDAV /dav/{path}

| 项 | 说明 |
|---|---|
| 方法 | OPTIONS / PROPFIND / PUT / DELETE / GET / MKCOL（其余 405） |
| 开关 | 需 `othersConfig.webDAV.enabled`，否则 403 |
| 鉴权 | Basic Auth 比对 `webDAV.username/password`（未配置则跳过）；内部操作用自动创建的 token（list/upload/delete 权限） |

各方法：

- OPTIONS → 204，返回 `DAV: 1,2` 和 `Allow` 头。
- GET 目录（以 `/` 结尾）→ HTML 目录列表；GET 文件 → 内部 fetch `/file/<path>` 回传。
- PUT → 读 blob，POST 到 `/upload`（含路径穿越防护 `..`→`_`），成功 201。
- DELETE → 调 `/api/manage/delete/<path>`（文件夹加 `folder=true`），成功 204。
- PROPFIND → 调 `/api/manage/list` 生成 207 multistatus XML。
- MKCOL → 直接 201（不实际建目录）。

> 优化点：未配置用户名/密码时完全跳过认证，只要 `enabled` 即开放写/删，建议缺凭据时拒绝写操作。MKCOL 为"假成功"。

---

## GET /api/channels — 上传渠道列表

| 项 | 说明 |
|---|---|
| 方法 | GET（其余 405） |
| 鉴权 | `dualAuthCheck`（用户端或管理端任一通过），否则 401 |
| 参数 | `includeDisabled=true` — 是否含禁用渠道 |

返回：JSON，按渠道类型分组 `{ telegram, cfr2, s3, discord, huggingface, webdav }`，每项 `{ name, type }`。

---

## GET /api/directoryTree — 目录树

| 项 | 说明 |
|---|---|
| 方法 | GET |
| 鉴权 | `dualAuthCheck`；非 admin 身份额外检查 `showDirectorySuggestions` 配置（关闭则 403） |
| 参数 | `cacheTime`（秒，默认 60，写入 Cache-Control） |

返回：`{ tree: DirectoryTreeNode }`；错误 `{ error }`。

---

## /api/fetchRes — 服务端代理抓取

| 项 | 说明 |
|---|---|
| 方法 | 任意（读 `request.json()`） |
| 鉴权 | `dualAuthCheck`，否则 401 |
| 请求体 | `{ url }`（缺失 400） |

功能：服务端 fetch 目标 URL 并原样回传 body + headers。

> 安全优化点（高优先级）：这是一个**无目标域名白名单的开放代理（SSRF 风险）**，仅靠 dualAuth 限制，可被授权用户用于探测内网/元数据端点。建议加 URL 协议与目标域名白名单校验。

---

## /api/bing/wallpaper — Bing 壁纸

| 项 | 说明 |
|---|---|
| 方法 | 任意 |
| 鉴权 | 无 |

功能：代理 `cn.bing.com/HPImageArchive.aspx`。返回 `{ status:true, message:"操作成功", data: images[] }`。

---

## GET /api/public/list — 公开图库列表

| 项 | 说明 |
|---|---|
| 方法 | GET、OPTIONS（其余 405） |
| 开关 | 需 `othersConfig.publicBrowse.enabled`，否则 403 |
| 目录权限 | 比对 `publicBrowse.allowedDir`（支持 `*`/空=全部） |

查询参数：

- `dir` — 目录（含路径穿越防护）。
- `search` — 文件名模糊搜索（小写）。
- `recursive=true` — 是否递归子目录。
- `type` — `image` / `video` / `audio` / `other`（按扩展名）。
- `start`（默认 0）/ `count`（默认 50）— 分页。

返回：`{ files:[{name,metadata}], directories, totalCount, returnedCount, allowedDirs, fromCache }`。

# 管理后台 API

涉及目录：`functions/api/manage/*`。

## 统一中间件与认证

`/api/manage/*` 全部经过 `functions/api/manage/_middleware.js`：

- `errorHandling`：捕获异常返回 500，并为所有响应默认加 `Cache-Control: private, no-store, max-age=0`。
- `authentication`：OPTIONS 直接返回 204；其余请求统一用 `authenticate`（scope=ADMIN），**按路径自动推导所需权限**：
  - 路径含 `delete` → 需要 `delete` 权限。
  - 路径含 `list` → 需要 `list` 权限。
  - 其它 → 需要 `manage` 权限。
- 未授权返回 401 `You need to login`。

> 注意：API Token 可携带不同权限（list/upload/delete/manage），管理端按路径校验对应权限。

---

## 文件列表与索引

### GET /api/manage/list — 文件列表（核心端点）

查询参数：

| 参数 | 说明 |
|---|---|
| `start` / `count` | 分页，默认 0 / 50；`count=-1` 表示全部 |
| `dir` | 目录，含路径穿越防护 |
| `search` | 文件名搜索（URL 解码后） |
| `recursive` | `true` 递归子目录 |
| `sum` | `true` 仅返回统计 |
| `channel` / `channelName` | 渠道类型 / 渠道名称筛选（逗号分隔多选） |
| `listType` | 名单类型筛选（如 `Block`，逗号分隔多选） |
| `accessStatus` | 访问状态筛选（逗号分隔多选） |
| `label` | 审查标签筛选（逗号分隔多选） |
| `fileType` | 文件类型筛选（逗号分隔多选） |
| `includeTags` / `excludeTags` | 包含 / 排除标签（逗号分隔） |
| `action` | `rebuild`（异步重建索引）/ `merge-operations`（合并挂起操作到索引）等特殊操作 |

返回：`{ files, directories, totalCount, directFileCount, directFolderCount, returnedCount }`。

> 优化点：搜索/筛选基于 `readIndex` 全量读取后在内存过滤，数据量大时开销高；目录提取每条记录间用 `setTimeout(10ms)` 做协作点，会拉长响应时间。

### GET/POST /api/manage/quota — 容量统计

- GET：从索引元数据读取各渠道容量统计（仅 1 次读取），返回 `{ success, quotaStats, totalSizeMB, totalCount, lastUpdated }`。
- POST：触发索引重建以重新统计容量。

---

## 文件操作（路径型，`[[path]]` 捕获 fileId，逗号还原为 `/`）

### POST /api/manage/delete/{path} — 删除

- `?folder=true`：按文件夹递归删除（用队列遍历子目录，逐个调 `list` 取文件再删）。
- 普通：删除单个文件，清理 CDN 缓存与随机图/公开列表缓存，更新索引。
- 需要 `delete` 权限。

### POST /api/manage/move/{path} — 移动

- `?dist=<目标目录>`（经路径安全处理）。
- `?folder=true`：递归移动整个文件夹。

### POST /api/manage/rename/{path} — 重命名

- 方法 POST，请求体 JSON，重命名指定 fileId。

### PATCH /api/manage/metadata/{path} — 修改元数据

- 仅 PATCH，请求体 `{ FileName?, FileType? }`（至少其一）。

### POST /api/manage/block/{path} — 加入封禁名单

- 将 `metadata.ListType` 设为 `Block`，清理相关缓存并更新索引。返回 `{ success, listType }`。

### POST /api/manage/white/{path} — 加入白名单

- 与 block 类似，操作白名单状态。

---

## 标签管理

### GET/POST /api/manage/tags/{path} — 单文件标签

- GET：获取文件标签。
- POST：更新文件标签。

### POST /api/manage/tags/batch — 批量标签

- 请求体 `{ fileIds: [], action: 'set'|'add'|'remove', tags: [] }`。`fileIds` 必须为非空数组，`action` 限三种。

### GET /api/manage/tags/autocomplete — 标签自动补全

- 参数 `prefix`（前缀）、`limit`（默认 20）。返回匹配的标签建议。

---

## 自定义配置（cusConfig）

### GET /api/manage/cusConfig/list — 上传 IP 统计

- 参数 `start` / `count`（默认 0 / 10）。按 `UploadIP` 分组统计上传次数，按次数降序返回 `[{ ip, address, count }]`。

### GET /api/manage/cusConfig/files — 指定 IP 的文件

- 参数 `ip`（必填）、`start` / `count`（默认 0 / 20）。返回该 IP 上传的文件 `{ data, total }`。

### POST /api/manage/cusConfig/blockip — 封禁 IP

- 请求体为纯文本 IP，追加到 `manage@blockipList`。

### GET /api/manage/cusConfig/blockipList — 封禁 IP 列表

- 返回当前封禁 IP 列表。

### POST /api/manage/cusConfig/whiteip — 白名单 IP

- 维护白名单 IP 列表。

---

## 系统配置（sysConfig）

每个端点均为 GET 读取 / POST 保存。

### GET/POST /api/manage/sysConfig/security — 安全设置

- GET：返回安全配置，**密码字段脱敏**（返回空串 + `_hasPassword: true`），不向前端暴露密码哈希。
- POST：先读旧配置再覆盖 `upload` / `access` / `auth`；空密码表示保留原密码，`_clear` 标记表示清除密码；`apiTokens` 不在此修改。

### GET/POST /api/manage/sysConfig/upload — 上传设置
### GET/POST /api/manage/sysConfig/page — 页面设置
### GET/POST /api/manage/sysConfig/others — 其它设置

分别读取/保存对应配置段。

### GET/POST/PUT/DELETE /api/manage/apiTokens — API Token 管理

| 方法 | 说明 |
|---|---|
| GET | 列出所有 Token |
| POST | 创建，请求体 `{ name, permissions, owner, expiresAt?, autoDelete? }`（前三必填） |
| PUT | 更新，请求体 `{ tokenId, permissions, expiresAt?, autoDelete? }`（前两必填） |
| DELETE | `?id=<tokenId>` 删除 |

---

## 批量与备份（batch）

用于数据备份/恢复，采用分块机制（D1 单块 500 条、KV 单块 5000 条）。

### GET /api/manage/batch/list — 分批读取 KV 数据

- cursor 分页，每批最多 1000 条，支持 `includeValue` 获取分块文件 value，输出经 `stripSensitiveMetadata` 脱敏。

### GET /api/manage/batch/settings — 批量读取系统设置

- 读取所有 `manage@` 前缀设置（排除索引相关键），用于备份。

### /api/manage/batch/index/config、chunk、finalize — 索引重建（分块）

- `config`：获取索引重建配置（分块大小等）。
- `chunk`：分块上传索引数据。
- `finalize`：组装所有分块为完整索引、更新元数据、清理临时分块。

### /api/manage/batch/restore/chunk — 分块恢复数据

---

## 可优化点小结

- **多处依赖 `readIndex` 全量读取后内存过滤**（list、cusConfig/list、cusConfig/files），随文件量增长性能下降，建议引入服务端索引/二级索引。
- **文件夹删除/移动通过 `fetch` 自调 `/api/manage/list`**（携带原请求头）逐目录递归，存在多次内部往返与权限重复校验开销，且对超大目录可能超时。
- **list 端点用 `setTimeout(10ms)` 做协作点**会显著拉长大目录响应时间，可改为分批让步或移除。
- **blockip 存储为逗号拼接字符串**（`manage@blockipList`），无去重与格式校验，规模增大后读写与查找效率低，建议改用结构化存储。
- **批量备份/恢复分块逻辑分散在多个端点**，缺少统一的事务/校验，恢复中断可能产生不一致索引。

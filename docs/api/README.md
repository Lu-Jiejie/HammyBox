# CloudFlare-ImgBed API 文档

本项目是一个部署在 Cloudflare Pages Functions 上的图床后端，采用**文件路由**机制：`functions/` 目录下的文件路径即对应的 URL 路径。例如 `functions/api/manage/list.js` 对应 `/api/manage/list`，`[[path]].js` 表示捕获该层级之后的所有剩余路径段。

- 数据存储：KV（`env.img_url`）或 D1 数据库（`env.img_d1`），通过 `databaseAdapter` 适配。
- 文件存储渠道：Telegram / Telegraph、Cloudflare R2、S3、Discord、HuggingFace、WebDAV、External（外链）。
- 几乎所有 `/api/*` 端点都会先经过 `checkDatabaseConfig` 中间件，确认数据库已配置。

## 文档目录

- [总览与认证体系](./README.md)（本文）
- [认证相关 API](./auth.md)
- [文件访问、随机图、WebDAV 等公开 API](./public.md)
- [上传相关 API](./upload.md)
- [管理后台 API](./manage.md)

---

## 一、认证体系总览

整个认证系统围绕统一认证核心 `functions/utils/auth/authCore.js` 构建，对外提供两个薄封装：`userAuth.js`（用户端）和 `dualAuth.js`（双重鉴权）。

### 4 种认证凭证

| 凭证类型 | 载体 | 适用身份 | 验证方式 |
|---|---|---|---|
| **Admin Session** | `admin_session` HttpOnly Cookie | 管理员 | 数据库查 `manage@session@<token>` |
| **User Session** | `user_session` HttpOnly Cookie | 用户 | 数据库查 `manage@session@<token>` |
| **API Token** | `Authorization` header（`Bearer xxx` 或裸 token） | 视为管理员权限 | 查 `apiTokens` 配置，校验权限 + 过期 |
| **authCode** | URL 参数 / Referer / `authCode` header / Cookie | 用户 | `verifyPassword` 比对 |

> 关键设计：API Token 验证通过后 `authType` 被返回为 `'admin'`，即 API Token 持有者享有管理员级别身份。

### 三种认证范围（AUTH_SCOPE）

- **ADMIN**（`'admin'`）：仅检查 admin session（+ API Token 公共层）。
- **USER**（`'user'`）：admin session → user session → authCode 依次尝试（+ API Token 公共层）。
- **EITHER**（`'either'`）：管理员或用户任一通过即可。

### 认证执行流程（`authenticate()`）

1. 读取 `securityConfig`，计算 `adminConfigured`（用户名或密码非空）和 `authCodeConfigured`。
2. **公共层**：先尝试 `validateApiToken`，通过则直接返回 `AUTHORIZED('admin')`。
3. 按 scope 分支校验 session / authCode。

> **"未配置即放行"语义**：若管理员凭据未配置，任何人都被视为 admin；若 authCode 未配置，任何人都被视为 user。这是首次部署的便利设计，也是潜在安全风险点。

### 会话与密码

- 会话存数据库（`manage@session@<token>`），通过 HttpOnly Cookie 传递，管理端 / 用户端独立。默认有效期 14 天（`access.adminSessionMaxAge` / `userSessionMaxAge`）。
- 密码哈希：PBKDF2（100,000 迭代，SHA-256，16 字节盐），格式 `$pbkdf2$salt$hash`。`verifyPassword` 兼容 PBKDF2、旧版 SHA-256（`$sha256$`）、**明文**三种格式，登录成功后会用 `rehashIfNeeded` 自动升级旧格式。

---

## 二、整体可优化方向

- **`verifyPassword` 明文回退**：仍支持明文存储密码直接比对，且明文分支使用 `===` 非恒定时间比较，存在安全隐患。建议完成迁移后移除明文路径。
- **API Token 权限模型偏粗**：所有 API Token 一律获得 `authType='admin'`，未将 token 实际权限范围作为身份级别区分。
- **`sessionSecure` 默认 false**：生产环境若未显式开启，Cookie 不带 `Secure`，存在明文传输风险，建议默认 true 或按请求协议自动判定。
- **"未配置即放行"风险**：若配置被意外清空（如 `resetAuth` 后未及时重设），系统会对所有人开放，建议在管理端给出醒目警示。
- **`extractAuthCode` 从 Referer 取凭据**：authCode 可能随 Referer 泄漏到日志或第三方，扩大凭据暴露面。
- **`resetAuth` 用 GET + URL 参数**：密钥出现在 URL，易进入访问日志/浏览器历史，建议改用 POST + 请求体。

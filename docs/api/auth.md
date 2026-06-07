# 认证相关 API

涉及目录：`functions/api/auth/*`、`functions/api/userConfig.js`，认证核心位于 `functions/utils/auth/*`。

`/api/*` 路径仅有 `checkDatabaseConfig` 中间件，**不做统一认证**，认证由各端点自行调用 `userAuthCheck` / `dualAuthCheck`。

---

## POST /api/auth/login — 用户登录

| 项 | 说明 |
|---|---|
| 方法 | POST |
| 请求体 | `{ authCode }` |
| 认证 | 无需预认证 |

逻辑：读取 `auth.user.authCode`；若已配置则用 `verifyPassword` 校验，失败返回 401 `Unauthorized`，成功则 `rehashIfNeeded` 升级哈希。若未配置则直接放行。最终创建 `user` 会话。

返回：`200 Login success`，带 `Set-Cookie: user_session=...`。

---

## POST /api/auth/adminLogin — 管理员登录

| 项 | 说明 |
|---|---|
| 方法 | POST |
| 请求体 | `{ username, password }` |
| 认证 | 无需预认证 |

逻辑：读取 `auth.admin.adminUsername` / `adminPassword`。

- 两者都未配置 → 直接创建 admin 会话。
- 配置了用户名 → 校验 `username` 相等。
- 配置了密码 → `verifyPassword` 校验，成功后 `rehashIfNeeded`。
- 任一失败返回 `401 {error:'Unauthorized'}`。

返回：`200 {success:true}`，带 `Set-Cookie: admin_session=...`。

---

## POST /api/auth/logout — 登出

| 项 | 说明 |
|---|---|
| 方法 | POST |
| 请求体 | `{ authType? }`（可选，缺省清除全部会话） |

逻辑：`destroySession` 删除数据库会话记录并返回清除 Cookie 头（多个会话时返回多个 `Set-Cookie`）。

返回：`200 Logged out`。

---

## GET /api/auth/sessionCheck — 会话检查（前端路由守卫）

| 项 | 说明 |
|---|---|
| 方法 | GET |
| 参数 | 无（靠 Cookie） |

逻辑：`validateAnySession` + 计算 `adminRequired` / `userRequired`。

返回：**始终 200**（不返回 401），`{ valid, authType?, adminRequired, userRequired }`，让前端按字段决定跳转。

---

## GET /api/auth/resetAuth — 认证重置（应急后门）

| 项 | 说明 |
|---|---|
| 方法 | GET |
| 参数 | `?key=<RESET_KEY>` |

逻辑：需环境变量 `RESET_KEY` 已配置；`key` 匹配后，从 `manage@sysConfig@security` 删除 `auth` 段（保留审核/白名单等），并清空所有 admin/user 会话。

返回：`200 {success, message, sessionsCleared:{admin,user}}`；未配置或 key 错误返回 403；异常 500。

> 优化点：使用 GET + URL 参数传递密钥，密钥易进入访问日志/浏览器历史，建议改为 POST + 请求体。

---

## GET /api/userConfig — 前端公开配置

| 项 | 说明 |
|---|---|
| 方法 | GET |
| 参数 | 无 |
| 认证 | **无认证保护**（属公开前端配置端点） |

逻辑：`fetchPageConfig` 把配置项解析为对象（JSON.parse 失败回退原字符串，布尔型用默认值）。

返回：`200` 配置对象 JSON。

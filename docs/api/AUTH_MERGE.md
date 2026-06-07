# 认证合并方案（单用户单角色版）

> 场景：**只有一个使用者**，不新增用户、不区分角色。登录成功即拥有最高权限。authCode 概念废除，由唯一的用户名+密码取代。"admin / user" 的区分名存实亡。

## 一、目标

把现有的"admin 登录 + authCode 登录"两套体系，简化为：

- **一个用户**：一组用户名 + 密码。
- **一个会话**：单一 Cookie，登录即全权限。
- **没有角色**：所有受保护端点的判定都退化为"是否登录"。
- **authCode 废除**：上传页面不再需要 authCode，登录后即可上传。

判定逻辑从"按 scope 区分 admin/user"简化为一句话：**登录了 → 放行；没登录 → 401**。

---

## 二、可行性

完全可行，且比通用合并更简单。现有代码已具备基础：

- 认证核心 `authCore.js`、会话存储 `sessionManager.js`、密码校验 `passwordHash.js` 都是共享的。
- admin 身份本就能访问 user 资源（`checkUser` 先验 admin session）——既然只有一个角色，这层包含关系直接坍缩为"登录即全权限"。

合并要做的就是**删除分叉**，而不是新增逻辑。

---

## 三、改造清单（按文件）

### 3.1 `sessionManager.js`

- `COOKIE_NAMES`（admin/user 两个）→ 单一 `const COOKIE_NAME = 'imgbed_session'`。
- `createSession(env, username)`：去掉 `authType` 参数，会话数据 `{ username, createdAt, expiresAt }`，maxAge 用单一配置（如 `sessionMaxAge`，默认 14 天）。
- `validateSession(env, request)`：去掉 `authType` 参数和匹配判断，读单一 Cookie → 查库 → 校验过期，返回 `{ valid, session }`。
- 删除 `validateAnySession`（不再需要遍历两种类型）、`destroySessionsByAuthType`（不再按类型批量清）。
- `destroySession(env, request)`：清单一 Cookie。

### 3.2 `authCore.js`

整个文件大幅简化。删除 `AUTH_SCOPE`、`checkAdmin`、`checkUser`、`extractAuthCode`，`authenticate` 收敛为：

```js
export async function authenticate({ env, request, requiredPermission = null }) {
  const db = getDatabase(env);

  // API Token（可保留，作为程序化访问入口）
  const tokenResult = await validateApiToken(request, db, requiredPermission);
  if (tokenResult.valid) return { authorized: true };

  // 会话
  const s = await validateSession(env, request);
  if (s.valid) return { authorized: true };

  return { authorized: false };
}
```

- 不再有 `authType` 返回值（或固定返回单一标识）。
- 不再从 URL/Referer 提取 authCode——这条凭据泄漏面顺便消除。

### 3.3 登录端点

- **保留 `/api/auth/login` 作为唯一登录入口**，接收 `{ username, password }`：
  - 读取配置的用户名/密码，用 `verifyPassword` 校验。
  - 通过 → `createSession(env, username)`，返回 `{ success: true }` + Set-Cookie。
  - 失败 → 401。
- **删除 `/api/auth/adminLogin`**（或保留为转调 `/api/auth/login` 的兼容壳，前端切换后移除）。
- 登录端点里删除 authCode 相关逻辑。

### 3.4 `/api/auth/logout`

- 简化为清除单一 Cookie + 删除会话记录。

### 3.5 `/api/auth/sessionCheck`

- 返回简化为 `{ valid, loginRequired }`。
- `loginRequired` = 是否已配置用户名/密码（用于首次初始化引导）。
- 删除 `authType` / `adminRequired` / `userRequired` 字段。

### 3.6 各端点的认证调用

把所有 `userAuthCheck` / `dualAuthCheck` / `authScope: ADMIN` 统一替换为同一个"需要登录"检查：

| 端点 | 现状 | 改为 |
|---|---|---|
| `/api/manage/*` 中间件 | `authScope: ADMIN` + 按路径推权限 | `authenticate()`（登录即放行） |
| `/upload` | `userAuthCheck(...'upload')` | `authenticate()` |
| `/api/channels`、`/api/directoryTree`、`/api/fetchRes` | `dualAuthCheck` | `authenticate()` |
| `/file?from=admin` | `authScope: ADMIN` | `authenticate()` |

`/api/manage/_middleware.js` 里的 `extractRequiredPermission`（按路径推 delete/list/manage 权限）可以删除——单用户无需细分权限。除非你想保留 API Token 的权限粒度（见第五节）。

### 3.7 配置层 `sysConfig.js` / `security.js`

- `auth.user.authCode` 字段废弃。
- `auth.admin.adminUsername` / `adminPassword` 保留，作为唯一用户的凭据（语义上不再是"admin"，可改名为 `auth.username` / `auth.password`，但保留旧字段名改动更小）。
- `sessionCheck` 和登录端点对应改读单一凭据。

### 3.8 前端（frontend-dist 是打包产物，改前端源码）

- 登录页：单一表单（用户名 + 密码）。
- 上传页：删除 authCode 输入框，登录后直接可传。
- 路由守卫：`sessionCheck` 返回 `valid` 即放行所有页面（含管理页），不再区分 admin/user 路由。

---

## 四、fail-open 必须处理（重要）

单用户场景下，"未配置即放行"格外危险——一旦没配凭据，图床对全网开放。建议改为 **fail-closed**：

- 用户名/密码任一未配置 → 所有受保护端点返回 401（或重定向到初始化页）。
- 首次部署提供一个**初始化流程**：未设置凭据时引导设置一次，设置后才可用。
- `authenticate` 里删除"未配置即放行"分支：没有有效会话/Token 一律拒绝。

如果你接受首次部署的便利性，至少保留一个醒目提示，但单人自用建议直接 fail-closed。

---

## 五、API Token 怎么处理

当前 Token 一律 admin。单角色下：

- **最简**：Token 校验通过即全权限（与登录会话等价）。`requiredPermission` 参数可保留但不强校验，或直接忽略。
- **可选保留粒度**：若你希望"上传专用 Token"不能删文件，可保留 Token 的 `permissions` 字段做粒度控制，但这与"单角色"略有张力——按需取舍。自用场景通常"最简"即可。

---

## 六、改动后可删除的东西（净化收益）

合并后这些可以直接删除，代码显著变简单：

- `AUTH_SCOPE` 常量及三分支逻辑。
- `checkAdmin` / `checkUser` / `validateAnySession` / `destroySessionsByAuthType`。
- `extractAuthCode`（URL/Referer/header/cookie 多来源提取）。
- `dualAuth.js`（双重鉴权封装）——并入单一 `authenticate`。
- `/api/auth/adminLogin`（合并进 `/api/auth/login`）。
- `auth.user.authCode` 配置字段及前端 authCode 输入。
- `extractRequiredPermission`（除非保留 Token 粒度）。
- 两个 Cookie 中的一个。

---

## 七、迁移步骤（建议顺序）

1. 后端：`sessionManager` 改单 Cookie + 单会话结构；`authCore` 收敛为"登录即放行"；保留旧 Cookie 读取一小段时间做平滑过渡（可选）。
2. 后端：合并登录端点，废除 authCode 逻辑；`sessionCheck` / `logout` 简化。
3. 后端：各端点认证调用统一替换为 `authenticate()`；删除 scope 与权限推导。
4. 后端：配置层去掉 authCode，统一凭据字段；加 fail-closed + 初始化引导。
5. 前端：登录页单表单、上传页去 authCode、路由守卫只看 `valid`。
6. 清理：删除第六节列出的死代码。

---

## 八、验证清单

- 未配置凭据：受保护端点全部 401（fail-closed），初始化引导可设置凭据。
- 配置后用正确用户名/密码登录 → 能上传、能进管理后台、能管理文件（全权限）。
- 错误密码 → 401。
- 登录后访问 `/upload`、`/api/manage/*`、`/file?from=admin` 全部放行。
- 登出后上述端点全部 401。
- 会话过期（超过 maxAge）后失效，需重新登录。
- 旧的 authCode 入口已无（前端无输入框，后端不再校验）。
- API Token（若保留）携带后可程序化访问。

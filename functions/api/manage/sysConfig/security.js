import { getDatabase } from '../../../utils/databaseAdapter.js';
import { hashPassword, isHashed } from '../../../utils/auth/passwordHash.js';
import { destroyAllSessions } from '../../../utils/auth/sessionManager.js';

export async function onRequest(context) {
    // 安全设置相关，GET方法读取设置，POST方法保存设置
    const {
      request, // same as existing Worker API
      env, // same as existing Worker API
      params, // if filename includes [id] or [[path]]
      waitUntil, // same as ctx.waitUntil in existing Worker API
      next, // used for middleware or to fetch assets
      data, // arbitrary space for passing data between middlewares
    } = context;

    const db = getDatabase(env);

    // GET读取设置
    if (request.method === 'GET') {
        const settings = await getSecurityConfig(db, env)

        // 对前端隐藏实际密码值，返回占位符
        // 前端只有在用户修改密码时才会发送新密码
        const maskedSettings = JSON.parse(JSON.stringify(settings));
        if (maskedSettings.auth?.password) {
            maskedSettings.auth._hasPassword = true;
            maskedSettings.auth.password = ''; // 不向前端暴露密码/哈希
        }

        return new Response(JSON.stringify(maskedSettings), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

    // POST保存设置
    if (request.method === 'POST') {
        const settings = await getSecurityConfig(db, env) // 先读取已有设置，再进行覆盖

        const body = await request.json()
        const newSettings = body

        // 检测白名单模式是否变更
        const oldWhiteListMode = settings.access?.whiteListMode?.enabled ?? false;
        const newWhiteListMode = newSettings.access?.whiteListMode?.enabled ?? false;
        const whiteListModeChanged = oldWhiteListMode !== newWhiteListMode;

        // 覆盖设置，apiTokens不在这里修改
        settings.upload = newSettings.upload || settings.upload
        settings.access = newSettings.access || settings.access

        // 处理认证设置：空密码表示不修改，_clear 标记表示清除密码
        // 单用户 · 纯密码：凭据以 auth.password 为准
        let credentialsChanged = false;

        if (newSettings.auth) {
            if (newSettings.auth._clear) {
                // 显式清除密码
                settings.auth.password = '';
                credentialsChanged = true;
            } else if (newSettings.auth.password === '' || newSettings.auth.password === undefined) {
                // 密码为空，保留原密码
            } else {
                settings.auth.password = newSettings.auth.password;
                credentialsChanged = true;
            }
        }

        // 对密码进行哈希处理（如果是新的明文密码）
        if (settings.auth?.password && !isHashed(settings.auth.password)) {
            settings.auth.password = await hashPassword(settings.auth.password);
        }

        // 清理前端标记字段
        delete settings.auth?._hasPassword;
        delete settings.auth?._clear;

        // 写入数据库
        await db.put('manage@sysConfig@security', JSON.stringify(settings))

        // 凭据变更后清除所有会话，强制重新登录
        if (credentialsChanged) {
            await destroyAllSessions(env);
        }

        return new Response(JSON.stringify({
            message: 'security settings saved',
            credentialsChanged,
            whiteListModeChanged,
            cacheWarning: whiteListModeChanged
                ? '白名单模式已变更。建议立即清理所有文件缓存以确保访问控制立即生效（已缓存的文件最多需要 30 天才能自动过期）。'
                : null
        }), {
        }), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

}

export async function getSecurityConfig(db, env) {
    const settings = {}
    // 读取数据库中的设置
    const settingsStr = await db.get('manage@sysConfig@security')
    const settingsKV = settingsStr ? JSON.parse(settingsStr) : {}

    // 认证管理（单用户 · 纯密码：唯一凭据存于 auth.password）
    const kvAuth = settingsKV.auth || {}
    const auth = {
        // 未配置任何密码时，回退到默认密码 hammybox（用户应在登录后尽快修改）
        password: kvAuth.password ?? env.BASIC_PASSWORD ?? 'HammyBox',
    }
    settings.auth = auth

    // 上传管理
    const kvUpload = settingsKV.upload || {}
    const upload = {
        moderate: {
            enabled: kvUpload.moderate?.enabled ?? false,
            channel: kvUpload.moderate?.channel || 'moderatecontent.com', // [moderatecontent.com, nsfwjs]
            moderateContentApiKey: kvUpload.moderate?.moderateContentApiKey || kvUpload.moderate?.apiKey || env.ModerateContentApiKey || '',
            nsfwApiPath: kvUpload.moderate?.nsfwApiPath || '',
        }
    }
    settings.upload = upload

    // 访问管理
    const kvAccess = settingsKV.access || {}
    const access = {
        // 会话安全策略字段（单用户单角色：统一一个会话有效期）
        sessionSecure: kvAccess.sessionSecure ?? false,
        sessionMaxAge: kvAccess.sessionMaxAge ?? 14,
        // Referer 防盗链
        refererCheck: {
            enabled: kvAccess.refererCheck?.enabled ?? false,
            allowedDomains: kvAccess.refererCheck?.allowedDomains || [],
            allowEmptyReferer: kvAccess.refererCheck?.allowEmptyReferer ?? true,
        },
        // 白名单模式
        whiteListMode: {
            enabled: kvAccess.whiteListMode?.enabled ?? false
        }
    }
    settings.access = access

    // API Token 管理
    const kvApiTokens = settingsKV.apiTokens || {}
    const apiTokens = {
        tokens: kvApiTokens.tokens || {}
    }
    settings.apiTokens = apiTokens

    return settings;
}

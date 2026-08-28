/**
 * 会话管理工具（单用户单角色版）
 * 使用数据库存储会话，通过单一 HttpOnly Cookie 传递会话 Token
 */

import { generateSessionToken } from './passwordHash.js';
import { getDatabase } from '../databaseAdapter.js';
import { fetchSecurityConfig } from '../sysConfig.js';
import type { Env, DatabaseAdapter } from '../../types';

const SESSION_PREFIX = 'manage@session@';

// 会话 Cookie 名称
const COOKIE_NAME = 'hammybox_session';

/**
 * 会话数据（存储于数据库）
 */
interface SessionData {
  createdAt: number;
  expiresAt: number;
}

/**
 * 创建新会话
 * @param env 环境变量
 * @returns { token, cookie }
 */
export async function createSession(env: Env): Promise<{ token: string; cookie: string }> {
  // 读取安全策略配置
  const securityConfig = await fetchSecurityConfig(env);
  const accessConfig: { sessionSecure?: boolean; sessionMaxAge?: number } =
    securityConfig.access || {};
  const secure = accessConfig.sessionSecure ?? false;
  const maxAgeDays = accessConfig.sessionMaxAge ?? 14;
  const maxAge = maxAgeDays * 86400;

  const db: DatabaseAdapter = getDatabase(env);
  const token = generateSessionToken();
  const sessionData: SessionData = {
    createdAt: Date.now(),
    expiresAt: Date.now() + maxAge * 1000,
  };

  await db.put(`${SESSION_PREFIX}${token}`, JSON.stringify(sessionData), {
    expirationTtl: maxAge,
  });

  const cookie = buildSessionCookie(COOKIE_NAME, token, maxAge, secure);
  return { token, cookie };
}

/**
 * 验证会话（读取 hammybox_session Cookie）
 * @param env 环境变量
 * @param request 请求对象
 * @returns { valid, session? }
 */
export async function validateSession(
  env: Env,
  request: Request,
): Promise<{ valid: boolean; session?: SessionData }> {
  const token = getSessionToken(request);
  if (!token) {
    return { valid: false };
  }

  const db: DatabaseAdapter = getDatabase(env);
  const sessionStr = await db.get(`${SESSION_PREFIX}${token}`);
  if (!sessionStr) {
    return { valid: false };
  }

  try {
    const session: SessionData = JSON.parse(sessionStr);
    if (Date.now() > session.expiresAt) {
      await db.delete(`${SESSION_PREFIX}${token}`);
      return { valid: false };
    }
    return { valid: true, session };
  } catch {
    return { valid: false };
  }
}

/**
 * 销毁当前会话并清除 Cookie
 * @param env 环境变量
 * @param request 请求对象
 * @returns 清除 Cookie 的 Set-Cookie 头数组
 */
export async function destroySession(env: Env, request: Request): Promise<string[]> {
  const securityConfig = await fetchSecurityConfig(env);
  const secure = securityConfig.access?.sessionSecure ?? false;

  const db: DatabaseAdapter = getDatabase(env);

  const token = getCookieValue(request, COOKIE_NAME);
  if (token) {
    await db.delete(`${SESSION_PREFIX}${token}`);
  }
  return [buildSessionCookie(COOKIE_NAME, '', 0, secure)];
}

/**
 * 清除所有会话（用于重置认证 / 修改凭据后强制重新登录）
 * @param env 环境变量
 * @returns 清除的会话数量
 */
export async function destroyAllSessions(env: Env): Promise<number> {
  const db: DatabaseAdapter = getDatabase(env);
  let destroyed = 0;

  let cursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const listOptions: { prefix: string; cursor?: string } = { prefix: SESSION_PREFIX };
    if (cursor) {
      listOptions.cursor = cursor;
    }

    const result = await db.list(listOptions);
    const keys = result.keys || [];

    for (const key of keys) {
      await db.delete(key.name);
      destroyed++;
    }

    cursor = result.cursor;
    hasMore = !result.list_complete && !!cursor;
  }

  return destroyed;
}

/**
 * 从请求中提取会话 Token
 * @param request 请求对象
 * @returns string|null
 */
function getSessionToken(request: Request): string | null {
  return getCookieValue(request, COOKIE_NAME);
}

/**
 * 从请求中提取指定 Cookie 的值
 * @param request 请求对象
 * @param name Cookie 名称
 * @returns string|null
 */
function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const regex = new RegExp('(^|;\\s*)' + name + '=([^;]+)');
  const match = cookieHeader.match(regex);
  return match ? match[2] : null;
}

/**
 * 构建 Set-Cookie 头的值
 * @param name Cookie 名称
 * @param token 会话 Token
 * @param maxAge 最大存活时间（秒）
 * @param secure 是否添加 Secure 属性
 * @returns Set-Cookie 字符串
 */
function buildSessionCookie(name: string, token: string, maxAge: number, secure = false): string {
  const parts = [
    `${name}=${token}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
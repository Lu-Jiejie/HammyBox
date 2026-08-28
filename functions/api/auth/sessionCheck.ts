import { validateSession } from '../../utils/auth/sessionManager.js';
import { isAuthConfigured } from '../../utils/auth/authCore.js';
import type { Env } from '../../types';

/**
 * 会话检查接口（单用户单角色）
 * 用于前端路由守卫检查当前会话是否有效，并返回是否需要登录。
 */
export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;

  const loginRequired = await isAuthConfigured(env);

  const sessionResult = await validateSession(env, request);

  return new Response(
    JSON.stringify({
      valid: sessionResult.valid,
      loginRequired,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
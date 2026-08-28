/**
 * 用户端认证工具（单用户单角色版）
 * 统一走 authenticate：登录即放行
 */

import { authenticate } from './authCore.js';
import type { Env } from '../../types';

/**
 * 认证检查
 * @param env 环境变量
 * @param request 请求对象
 * @param requiredPermission 如果提供，则进行 Token 权限验证
 * @return 是否认证通过
 */
export async function userAuthCheck(
  env: Env,
  request: Request,
  requiredPermission: string | null = null,
): Promise<boolean> {
  const result = await authenticate({ env, request, requiredPermission });
  return result.authorized;
}

export function UnauthorizedResponse(reason: string): Response {
  return new Response(reason, {
    status: 401,
    statusText: 'Unauthorized',
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'text/plain;charset=UTF-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(reason.length),
    },
  });
}
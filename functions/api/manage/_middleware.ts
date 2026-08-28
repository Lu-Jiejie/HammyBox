import { authenticate } from '../../utils/auth/authCore.js';
import type { PagesContext } from '../../types';

const DEFAULT_MANAGE_CACHE_CONTROL = 'private, no-store, max-age=0';

function withDefaultCacheControl(response: Response): Response {
  if (response.headers.has('Cache-Control')) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', DEFAULT_MANAGE_CACHE_CONTROL);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function errorHandling(context: PagesContext): Promise<Response> {
  try {
    return withDefaultCacheControl(await context.next());
  } catch (err: any) {
    return new Response(`${err.message}\n${err.stack}`, {
      status: 500,
      headers: {
        'Cache-Control': DEFAULT_MANAGE_CACHE_CONTROL,
      },
    });
  }
}

function UnauthorizedException(reason: string): Response {
  return new Response(reason, {
    status: 401,
    statusText: 'Unauthorized',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(reason.length),
    },
  });
}

/**
 * 根据请求路径提取所需权限
 * @param pathname - 请求路径
 * @returns 需要的权限类型
 */
function extractRequiredPermission(pathname: string): string {
  const pathParts = pathname.toLowerCase().split('/');

  if (pathParts.includes('delete')) {
    return 'delete';
  }

  if (pathParts.includes('list')) {
    return 'list';
  }

  // 其他 /api/manage 下的操作需要管理权限
  return 'manage';
}

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

async function authentication(context: PagesContext): Promise<Response> {
  // OPTIONS 预检请求不需要鉴权，直接返回 CORS 响应
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const pathname = new URL(context.request.url).pathname;
  const requiredPermission = extractRequiredPermission(pathname);

  const result = await authenticate({
    env: context.env,
    request: context.request,
    requiredPermission,
  });

  if (!result.authorized) {
    return UnauthorizedException('You need to login');
  }

  return context.next();
}

export const onRequest = [errorHandling, authentication];
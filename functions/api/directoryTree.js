import { getDirectoryTree } from '../utils/indexManager';
import { authenticate } from '../utils/auth/authCore.js';

/**
 * 目录树 API 端点
 * GET /api/directoryTree
 * 
 * 查询参数：
 * - cacheTime: 可选，覆盖默认缓存时间（秒），默认 60
 * 
 * 响应：
 * - 成功：{ tree: DirectoryTreeNode }
 * - 失败：{ error: string }
 *
 * 权限说明：
 * - 登录后即可访问（单用户单角色，登录即全权限）
 */
export async function onRequestGet(context) {
    const { env, request } = context;
    const url = new URL(request.url);

    // 鉴权：登录即放行
    const authResult = await authenticate({ env, request, requiredPermission: null });
    if (!authResult.authorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const tree = await getDirectoryTree(context);
        const cacheTime = url.searchParams.get('cacheTime') || 60;
        
        return new Response(JSON.stringify({ tree }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${cacheTime}`,
                'Access-Control-Allow-Origin': '*',
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

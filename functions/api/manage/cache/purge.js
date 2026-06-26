import { authenticate } from '../../../utils/auth/authCore.js';
import { readIndex } from '../../../utils/indexManager.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env } = context;

    // OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
        });
    }

    // 仅允许 POST 方法
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({
            success: false,
            message: 'Method not allowed. Use POST.',
        }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }

    // 鉴权：需要管理员权限
    const { authorized } = await authenticate({ env, request });
    if (!authorized) {
        return new Response(JSON.stringify({
            success: false,
            message: 'Unauthorized',
        }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }

    try {
        // 解析请求体
        let body;
        try {
            body = await request.json();
        } catch (e) {
            body = {};
        }

        const type = body.type || 'all'; // 'all' | 'file'
        const fileId = body.fileId; // 当 type='file' 时指定

        const cache = caches.default;
        const url = new URL(request.url);
        const origin = url.origin;

        if (type === 'file' && fileId) {
            // 清理单个文件缓存
            const fileUrl = `${origin}/api/file/${fileId.split('/').join(',')}`;

            // 使用 max-age=0 的空响应覆盖缓存（cache.delete 有 bug）
            const nullResponse = new Response(null, {
                headers: { 'Cache-Control': 'max-age=0' },
            });
            await cache.put(fileUrl, nullResponse);

            return new Response(JSON.stringify({
                success: true,
                message: 'File cache cleared',
                fileId,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }

        if (type === 'all') {
            // 清理所有文件缓存
            const result = await readIndex(context, { count: -1 });
            const files = result.files || [];

            if (files.length === 0) {
                return new Response(JSON.stringify({
                    success: true,
                    message: 'No files to clear',
                    total: 0,
                    cleared: 0,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
            }

            let cleared = 0;
            const nullResponse = new Response(null, {
                headers: { 'Cache-Control': 'max-age=0' },
            });

            // 遍历清理所有文件缓存
            for (const file of files) {
                const fileUrl = `${origin}/api/file/${file.id.split('/').join(',')}`;
                try {
                    await cache.put(fileUrl, nullResponse.clone());
                    cleared++;
                } catch (error) {
                    console.error(`Failed to clear cache for ${file.id}:`, error);
                }
            }

            return new Response(JSON.stringify({
                success: true,
                message: 'All file caches cleared',
                total: files.length,
                cleared,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }

        // 未知类型
        return new Response(JSON.stringify({
            success: false,
            message: 'Invalid type. Use "all" or "file".',
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });

    } catch (error) {
        console.error('Error clearing cache:', error);
        return new Response(JSON.stringify({
            success: false,
            message: error.message || 'Internal server error',
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }
}

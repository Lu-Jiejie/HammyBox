/**
 * 批量删除文件 API
 *
 * POST /api/manage/batch/delete
 * body: { paths: string[] }  — paths 为文件 ID（即相对路径，斜杠分隔，如 "dir/file.jpg"）
 *
 * 逐个删除文件（复用单个删除的核心逻辑，含幂等/各渠道删除/缓存清理），
 * 最后一次性批量更新索引。返回成功/失败的文件列表。
 */
import { deleteFile } from '../delete/[[path]].js';
import { batchRemoveFilesFromIndex } from '../../../utils/indexManager.js';
import type { Env, PagesContext } from '../../../types';

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, env, waitUntil } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(request.url);
    const body: any = await request.json();
    const rawPaths: unknown = body?.paths;

    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing or empty "paths" array' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 兼容逗号编码路径（前端 fileId.replace(/\//g,',') 的协议）与原始斜杠路径
    const paths: string[] = rawPaths.map(p => String(p).split(',').join('/')).filter(Boolean);

    const deletedFiles: string[] = [];
    const failedFiles: Array<{ path: string; error: string }> = [];

    for (const fileId of paths) {
      const cdnUrl = `https://${url.hostname}/file/${fileId}`;
      try {
        const success = await deleteFile(env as Env, fileId, cdnUrl, url);
        if (success) {
          deletedFiles.push(fileId);
        } else {
          failedFiles.push({ path: fileId, error: 'Delete failed' });
        }
      } catch (e: any) {
        failedFiles.push({ path: fileId, error: e?.message || 'Unknown error' });
      }
    }

    // 批量从索引中删除
    if (deletedFiles.length > 0) {
      waitUntil(batchRemoveFilesFromIndex(context, deletedFiles));
    }

    return new Response(
      JSON.stringify({
        success: true,
        deleted: deletedFiles,
        failed: failedFiles,
        total: paths.length,
      }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, error: error?.message || 'Batch delete failed' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

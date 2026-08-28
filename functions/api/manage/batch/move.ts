/**
 * 批量移动文件 API
 *
 * POST /api/manage/batch/move
 * body: { paths: string[], dist: string }  — paths 为文件 ID（相对路径），dist 为目标文件夹
 *
 * 将每个文件移动到 dist 下（保持文件名不变），逐个执行核心移动逻辑，
 * 最后一次性批量更新索引。返回成功/失败的文件列表。
 */
import { moveFile } from '../move/[[path]].js';
import { batchMoveFilesInIndex } from '../../../utils/indexManager.js';
import { sanitizeUploadFolder } from '../../upload/uploadTools.js';
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
    const dist = sanitizeUploadFolder(String(body?.dist ?? ''));

    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing or empty "paths" array' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 兼容逗号编码路径与原始斜杠路径
    const paths: string[] = rawPaths.map(p => String(p).split(',').join('/')).filter(Boolean);

    const processedFiles: Array<{ fileId: string; newFileId: string }> = [];
    const failedFiles: Array<{ path: string; error: string }> = [];

    for (const fileId of paths) {
      const fileName = fileId.split('/').pop() || fileId;
      const newFileId = dist === '' ? fileName : `${dist}/${fileName}`;
      const cdnUrl = `https://${url.hostname}/file/${fileId}`;

      try {
        const success = await moveFile(env as Env, fileId, newFileId, cdnUrl, url);
        if (success) {
          processedFiles.push({ fileId, newFileId });
        } else {
          failedFiles.push({ path: fileId, error: 'Move failed' });
        }
      } catch (e: any) {
        failedFiles.push({ path: fileId, error: e?.message || 'Unknown error' });
      }
    }

    // 批量更新索引：删除旧文件，添加新文件
    if (processedFiles.length > 0) {
      waitUntil(
        batchMoveFilesInIndex(
          context,
          processedFiles.map(f => ({
            originalFileId: f.fileId,
            newFileId: f.newFileId,
          }))
        )
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: processedFiles,
        failed: failedFiles,
        total: paths.length,
      }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, error: error?.message || 'Batch move failed' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

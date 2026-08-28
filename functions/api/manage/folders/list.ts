import { getDatabase } from '../../../utils/databaseAdapter.js';
import { normalizeFolderPath } from '../../../utils/pathNormalizer.js';
import type { Env, DatabaseAdapter, FileMetadata } from '../../../types';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(request.url);
    const db = getDatabase(env);

    // 获取查询参数
    let folder = url.searchParams.get('folder');
    const start = parseInt(url.searchParams.get('start')) || 0;
    const count = parseInt(url.searchParams.get('count')) || 100;

    // 规范化文件夹路径
    if (folder === null || folder === undefined) {
      folder = ''; // 默认根目录
    } else {
      folder = normalizeFolderPath(folder);
    }

    // 获取子文件夹
    const subfolders = await getSubfolders(db, folder);

    // 获取文件
    const files = await getFilesInFolder(db, folder, start, count);

    return new Response(
      JSON.stringify({
        success: true,
        currentFolder: folder,
        folders: subfolders,
        files: files,
        totalFolders: subfolders.length,
        totalFiles: files.length,
        returnedCount: subfolders.length + files.length,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('List folder contents error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to list folder contents',
        message: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

// 获取指定文件夹的直接子文件夹
async function getSubfolders(db: DatabaseAdapter, parentFolder: string): Promise<any[]> {
  const prefix = `folder:${parentFolder}`;
  const list = await db.list({ prefix });
  const folders: any[] = [];

  for (const key of list.keys) {
    const metadata = key.metadata
      ? typeof key.metadata === 'string'
        ? JSON.parse(key.metadata)
        : key.metadata
      : {};

    if ((metadata as FileMetadata).Type === 'folder' && metadata.Folder === parentFolder) {
      const path = key.name.substring(7); // 移除 "folder:" 前缀
      folders.push({
        path,
        name: metadata.Name || path.split('/').filter(Boolean).pop() || '(Root)',
        type: 'folder',
        timeStamp: metadata.TimeStamp || 0,
      });
    }
  }

  // 按名称排序
  folders.sort((a, b) => a.name.localeCompare(b.name));

  return folders;
}

// 获取指定文件夹内的文件
async function getFilesInFolder(
  db: DatabaseAdapter,
  folder: string,
  start: number,
  count: number,
): Promise<any[]> {
  const prefix = folder; // 文件 Key 以文件夹路径开头
  const list = await db.list({ prefix });
  const files: any[] = [];

  for (const key of list.keys) {
    // 跳过文件夹标记记录
    if (key.name.startsWith('folder:')) continue;

    const metadata = key.metadata
      ? typeof key.metadata === 'string'
        ? JSON.parse(key.metadata)
        : key.metadata
      : {};

    // 只返回直接子文件（Folder 精确匹配）
    if ((metadata as FileMetadata).Folder === folder) {
      files.push({
        name: key.name,
        metadata: metadata,
      });
    }
  }

  // 按时间戳降序排序（最新的在前）
  files.sort((a, b) => (b.metadata.TimeStamp || 0) - (a.metadata.TimeStamp || 0));

  // 分页
  const paginatedFiles = count > 0 ? files.slice(start, start + count) : files;

  return paginatedFiles;
}
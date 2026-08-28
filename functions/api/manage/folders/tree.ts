import { getDatabase } from '../../../utils/databaseAdapter.js';
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
    const db = getDatabase(env);
    const url = new URL(request.url);
    const format = url.searchParams.get('format') || 'tree'; // 'tree' or 'flat'

    // 获取所有文件夹记录
    const foldersList = await db.list({ prefix: 'folder:' });
    const folders: any[] = [];

    for (const key of foldersList.keys) {
      const metadata = key.metadata
        ? typeof key.metadata === 'string'
          ? JSON.parse(key.metadata)
          : key.metadata
        : {};

      if ((metadata as FileMetadata).Type === 'folder') {
        const path = key.name.substring(7); // 移除 "folder:" 前缀
        folders.push({
          path,
          name: metadata.Name || path.split('/').filter(Boolean).pop() || '(Root)',
          parentFolder: metadata.Folder || '',
          timeStamp: metadata.TimeStamp || 0,
        });
      }
    }

    // 添加根目录
    const allFolders: any[] = [
      { path: '', name: '(Root)', parentFolder: null, timeStamp: 0 },
      ...folders,
    ];

    // 排序
    allFolders.sort((a, b) => a.path.localeCompare(b.path));

    if (format === 'flat') {
      // 扁平列表格式，添加深度信息
      const flatList = allFolders.map(folder => ({
        path: folder.path,
        name: folder.name,
        depth: folder.path ? folder.path.split('/').filter(Boolean).length : 0,
        timeStamp: folder.timeStamp,
      }));

      return new Response(
        JSON.stringify({
          success: true,
          folders: flatList,
          totalCount: flatList.length,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 树形结构格式
    const tree = buildTree(allFolders);

    // 同时返回扁平列表（方便前端使用）
    const flatList = allFolders.map(folder => ({
      path: folder.path,
      name: folder.name,
      depth: folder.path ? folder.path.split('/').filter(Boolean).length : 0,
      timeStamp: folder.timeStamp,
    }));

    return new Response(
      JSON.stringify({
        success: true,
        tree,
        flatList,
        totalCount: allFolders.length,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('Get folder tree error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Failed to get folder tree',
        message: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

function buildTree(folders: any[]): any[] {
  const map = new Map();
  let rootNode: any = null;

  // 初始化映射
  folders.forEach(folder => {
    const node = {
      path: folder.path,
      name: folder.name,
      timeStamp: folder.timeStamp,
      children: [],
    };
    map.set(folder.path, node);

    // 标记根节点
    if (folder.path === '') {
      rootNode = node;
    }
  });

  // 构建父子关系
  folders.forEach(folder => {
    // 跳过根节点本身
    if (folder.path === '') return;

    const node = map.get(folder.path);
    const parentPath = folder.parentFolder || '';
    const parent = map.get(parentPath);

    if (parent) {
      parent.children.push(node);
    } else {
      // 父节点不存在（数据不一致），挂到根节点下
      if (rootNode) {
        rootNode.children.push(node);
      }
    }
  });

  // 递归排序子节点
  function sortChildren(node: any) {
    if (node.children && node.children.length > 0) {
      node.children.sort((a: any, b: any) => a.name.localeCompare(b.name));
      node.children.forEach(sortChildren);
    }
  }

  if (rootNode) {
    sortChildren(rootNode);
  }

  return rootNode ? [rootNode] : [];
}
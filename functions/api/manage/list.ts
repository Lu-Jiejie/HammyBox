import {
  readIndex,
  mergeOperationsToIndex,
  deleteAllOperations,
  rebuildIndex,
  getIndexInfo,
  getIndexStorageStats,
} from '../../utils/indexManager.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import {
  createMetadataViewContext,
  serializeFileRecordForManagement,
} from '../../utils/metadata/metadataView.js';
import { normalizeFolderPath } from '../../utils/pathNormalizer.js';
import type { Env } from '../../types';

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export async function onRequest(context: {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  const { request, waitUntil } = context;
  const url = new URL(request.url);

  // 解析查询参数
  let start = parseInt(url.searchParams.get('start'), 10) || 0;
  let count = parseInt(url.searchParams.get('count'), 10) || 50;
  let sum = url.searchParams.get('sum') === 'true';
  let recursive = url.searchParams.get('recursive') === 'true';
  let folder = url.searchParams.get('folder');
  folder = folder === null || folder === undefined ? '' : normalizeFolderPath(folder);
  let search = url.searchParams.get('search') || '';
  let channel = url.searchParams.get('channel') || '';
  let listType = url.searchParams.get('listType') || '';
  let accessStatus = url.searchParams.get('accessStatus') || '';
  let action = url.searchParams.get('action') || '';
  let includeTags = url.searchParams.get('includeTags') || '';
  let excludeTags = url.searchParams.get('excludeTags') || '';
  let label = url.searchParams.get('label') || '';
  let fileType = url.searchParams.get('fileType') || '';
  let channelName = url.searchParams.get('channelName') || '';

  // 处理搜索关键字
  if (search) {
    search = decodeURIComponent(search).trim();
  }

  // 处理标签参数
  const includeTagsArray = includeTags ? includeTags.split(',').map(t => t.trim()).filter(t => t) : [];
  const excludeTagsArray = excludeTags ? excludeTags.split(',').map(t => t.trim()).filter(t => t) : [];

  // 处理筛选参数（支持逗号分隔的多选）
  const listTypeArray = listType ? listType.split(',').map(t => t.trim()).filter(t => t) : [];
  const accessStatusArray = accessStatus ? accessStatus.split(',').map(t => t.trim()).filter(t => t) : [];
  const labelArray = label ? label.split(',').map(t => t.trim()).filter(t => t) : [];
  const fileTypeArray = fileType ? fileType.split(',').map(t => t.trim()).filter(t => t) : [];
  const channelArray = channel ? channel.split(',').map(t => t.trim()).filter(t => t) : [];
  const channelNameArray = channelName ? channelName.split(',').map(t => t.trim()).filter(t => t) : [];

  // 处理目录参数
  if (folder) {
    // 路径安全处理：防止路径穿越
    folder = folder.replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  }
  if (folder.startsWith('/')) {
    folder = folder.substring(1);
  }
  if (folder && !folder.endsWith('/')) {
    folder += '/';
  }

  try {
    // 特殊操作：重建索引
    if (action === 'rebuild') {
      waitUntil(
        rebuildIndex(context, processed => {
          console.log(`Rebuilt ${processed} files...`);
        })
      );

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Index rebuild started asynchronously',
        }),
        {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // 特殊操作：合并挂起的原子操作到索引
    if (action === 'merge-operations') {
      waitUntil(mergeOperationsToIndex(context));

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Operations merge started asynchronously',
        }),
        {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // 特殊操作：清除所有原子操作
    if (action === 'delete-operations') {
      waitUntil(deleteAllOperations(context));

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Operations deletion started asynchronously',
        }),
        {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // 特殊操作：获取索引存储信息
    if (action === 'index-storage-stats') {
      const stats = await getIndexStorageStats(context);
      return new Response(JSON.stringify(stats), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 特殊操作：获取索引信息
    if (action === 'info') {
      const info = await getIndexInfo(context, {
        timezoneOffset: url.searchParams.get('timezoneOffset'),
        maxPoints: url.searchParams.get('trendMaxPoints'),
        seriesLimit: url.searchParams.get('trendSeriesLimit'),
        startDate: url.searchParams.get('trendStartDate'),
        endDate: url.searchParams.get('trendEndDate'),
      });
      return new Response(JSON.stringify(info), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 普通查询：只返回总数
    if (count === -1 && sum) {
      const result = await readIndex(context, {
        search,
        folder: folder,
        channel: channelArray,
        listType: listTypeArray,
        accessStatus: accessStatusArray,
        label: labelArray,
        fileType: fileTypeArray,
        channelName: channelNameArray,
        includeTags: includeTagsArray,
        excludeTags: excludeTagsArray,
        countOnly: true,
      });

      return new Response(
        JSON.stringify({
          sum: result.totalCount,
          indexLastUpdated: result.indexLastUpdated,
        }),
        {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // 普通查询：返回数据
    const result = await readIndex(context, {
      search,
      folder: folder,
      start,
      count,
      channel: channelArray,
      listType: listTypeArray,
      accessStatus: accessStatusArray,
      label: labelArray,
      fileType: fileTypeArray,
      channelName: channelNameArray,
      includeTags: includeTagsArray,
      excludeTags: excludeTagsArray,
      includeSubdirFiles: recursive,
    });

    // 索引读取失败，直接从 KV 中获取所有文件记录
    if (!result.success) {
      const dbRecords = await getAllFileRecords(context.env, folder);

      return new Response(
        JSON.stringify({
          files: dbRecords.files,
          folders: dbRecords.folders,
          totalCount: dbRecords.totalCount,
          directFileCount: dbRecords.directFileCount,
          directFolderCount: dbRecords.directFolderCount,
          returnedCount: dbRecords.returnedCount,
          indexLastUpdated: Date.now(),
          isIndexedResponse: false, // 标记这是来自 KV 的响应
        }),
        {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    const db = getDatabase(context.env);
    const metadataViewContext = await createMetadataViewContext(db, context.env);

    // 转换文件格式
    const compatibleFiles = await Promise.all(
      result.files.map(file => serializeFileRecordForManagement(db, context.env, file, metadataViewContext))
    );

    return new Response(
      JSON.stringify({
        files: compatibleFiles,
        folders: result.folders,
        totalCount: result.totalCount,
        directFileCount: result.directFileCount,
        directFolderCount: result.directFolderCount,
        returnedCount: result.returnedCount,
        indexLastUpdated: result.indexLastUpdated,
        isIndexedResponse: true, // 标记这是来自索引的响应
      }),
      {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  } catch (error: any) {
    console.error('Error in list-indexed API:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }
}

async function getAllFileRecords(env: Env, folder: string): Promise<Record<string, any>> {
  const allRecords: any[] = [];
  let cursor: string | null | undefined = null;

  try {
    const db = getDatabase(env);
    const metadataViewContext = await createMetadataViewContext(db, env);

    while (true) {
      const response = await db.list({
        prefix: folder,
        limit: 1000,
        cursor: cursor ?? null,
      });

      // 检查响应格式
      if (!response || !response.keys || !Array.isArray(response.keys)) {
        console.error('Invalid response from database list:', response);
        break;
      }

      cursor = response.cursor;

      for (const item of response.keys) {
        // 跳过管理相关的键
        if (item.name.startsWith('manage@') || item.name.startsWith('chunk_')) {
          continue;
        }

        // 跳过没有元数据的文件
        if (!item.metadata || !(item.metadata as any).TimeStamp) {
          continue;
        }

        allRecords.push(await serializeFileRecordForManagement(db, env, item, metadataViewContext));
      }

      if (!cursor) break;

      // 添加协作点
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // 提取文件夹信息
    const folders: Set<string> = new Set();
    const filteredRecords: any[] = [];
    allRecords.forEach(item => {
      const subDir = item.name.substring(folder.length);
      const firstSlashIndex = subDir.indexOf('/');
      if (firstSlashIndex !== -1) {
        folders.add(folder + subDir.substring(0, firstSlashIndex));
      } else {
        filteredRecords.push(item);
      }
    });

    return {
      files: filteredRecords,
      folders: Array.from(folders),
      totalCount: allRecords.length,
      directFileCount: filteredRecords.length,
      directFolderCount: folders.size,
      returnedCount: filteredRecords.length,
    };
  } catch (error: any) {
    console.error('Error in getAllFileRecords:', error);
    return {
      files: [],
      folders: [],
      totalCount: 0,
      directFileCount: 0,
      directFolderCount: 0,
      returnedCount: 0,
      error: error.message,
    };
  }
}
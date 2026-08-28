/**
 * BatchListAPI - 分批读取 KV 数据的 API 端点
 *
 * 实现 cursor 分页机制，每批最多 1000 条记录
 * 支持 includeValue 参数用于获取分块文件的 value
 */

import { getDatabase } from '../../../utils/databaseAdapter.js';
import { stripSensitiveMetadata } from '../../../utils/metadata/metadataSecurity.js';
import type { Env, PagesContext, FileMetadata } from '../../../types';

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * 创建 JSON 响应
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

/**
 * 创建错误响应
 */
function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ success: false, error: message }, status);
}

/**
 * 检查文件是否为需要读取 value 的分块文件
 * 仅 Telegram 和 Discord 渠道的分块文件需要读取 value
 *
 * @param metadata - 文件元数据
 * @returns 是否需要读取 value
 */
function isChunkedFileNeedingValue(metadata: unknown): boolean {
  const meta = (metadata || {}) as FileMetadata;
  if (!meta.IsChunked) {
    return false;
  }

  const channel = meta.Channel;
  return channel === 'Telegram' || channel === 'TelegramNew' || channel === 'Discord';
}

/**
 * 处理 GET 请求 - 分批读取 KV 数据
 *
 * @param context - Cloudflare Workers 上下文
 */
export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);

  try {
    // 解析查询参数
    const cursor = url.searchParams.get('cursor') || null;
    let limit = parseInt(url.searchParams.get('limit'), 10) || 1000;
    const includeValue = url.searchParams.get('includeValue') === 'true';

    // 限制每批最多 1000 条记录
    if (limit > 1000) {
      limit = 1000;
    }
    if (limit < 1) {
      limit = 1;
    }

    // 获取数据库实例
    const db = getDatabase(env as Env);

    // 构建 list 请求选项
    const listOptions: Record<string, unknown> = {
      limit,
    };

    // 如果有 cursor，添加到选项中
    if (cursor) {
      listOptions.cursor = cursor;
    }

    // 执行 KV list 操作
    const listResult = await db.list(listOptions);

    // 检查响应格式
    if (!listResult || !listResult.keys || !Array.isArray(listResult.keys)) {
      return errorResponse('Database list operation failed', 500);
    }

    // 处理记录
    const records: Array<Record<string, unknown>> = [];

    for (const item of listResult.keys) {
      // 跳过管理相关的键（以 manage@ 开头）
      if (item.name.startsWith('manage@')) {
        continue;
      }

      // 跳过分块数据键（以 chunk_ 开头）
      if (item.name.startsWith('chunk_')) {
        continue;
      }

      // 跳过没有元数据或有效时间戳的记录
      const itemMetadata = item.metadata as FileMetadata | undefined;
      if (!itemMetadata || !itemMetadata.TimeStamp) {
        continue;
      }

      // 构建记录对象
      const record: Record<string, unknown> = {
        id: item.name,
        metadata: stripSensitiveMetadata(itemMetadata),
      };

      // 如果需要包含 value 且是分块文件，读取 value
      if (includeValue && isChunkedFileNeedingValue(itemMetadata)) {
        try {
          const value = await db.get(item.name);
          if (value) {
            record.value = value;
          }
        } catch (valueError) {
          // 读取 value 失败时记录错误但继续处理
          console.error(`Failed to read value for ${item.name}:`, valueError);
        }
      }

      records.push(record);
    }

    // 构建响应
    const response = {
      success: true,
      records,
      nextCursor: listResult.cursor || null,
      totalProcessed: records.length,
    };

    return jsonResponse(response);
  } catch (error: any) {
    console.error('Error in BatchListAPI:', error);
    return errorResponse(`Database read error: ${error.message}`, 500);
  }
}

/**
 * 处理 OPTIONS 请求 - CORS 预检
 *
 * @returns {Response}
 */
export async function onRequestOptions(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

/**
 * 默认请求处理器
 *
 * @param context - Cloudflare Workers 上下文
 */
export async function onRequest(context: PagesContext): Promise<Response> {
  const { request } = context;

  if (request.method === 'GET') {
    return onRequestGet(context);
  }

  if (request.method === 'OPTIONS') {
    return onRequestOptions();
  }

  return errorResponse('Method not allowed', 405);
}
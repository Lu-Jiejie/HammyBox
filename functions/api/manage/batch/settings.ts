/**
 * BatchSettingsAPI - 批量读取系统设置的 API 端点
 *
 * 读取所有 `manage@` 前缀的设置（排除索引相关键）
 * 用于备份功能获取系统设置数据
 */

import { getDatabase } from '../../../utils/databaseAdapter.js';
import type { Env, PagesContext } from '../../../types';

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
 * 检查键是否为索引相关键或会话键（需要排除）
 *
 * 排除的键模式：
 * - manage@index (主索引)
 * - manage@index_* (索引分块)
 * - manage@index@meta (索引元数据)
 * - manage@indexMeta (旧版索引元数据)
 * - manage@session@* (会话数据)
 *
 * @param key - KV 键名
 * @returns 是否为需要排除的键
 */
function isIndexRelatedKey(key: string): boolean {
  // 精确匹配 manage@index
  if (key === 'manage@index') {
    return true;
  }

  // 匹配 manage@index_ 开头的分块键 (manage@index_0, manage@index_1, ...)
  if (key.startsWith('manage@index_')) {
    return true;
  }

  // 匹配 manage@index@ 开头的元数据键 (manage@index@meta, manage@index@operation_*)
  if (key.startsWith('manage@index@')) {
    return true;
  }

  // 匹配旧版索引元数据键
  if (key === 'manage@indexMeta') {
    return true;
  }

  // 匹配会话数据键 (manage@session@*)
  if (key.startsWith('manage@session@')) {
    return true;
  }

  return false;
}

/**
 * 从键名中移除 manage@ 前缀
 *
 * @param key - 完整的 KV 键名
 * @returns 移除前缀后的键名
 */
function stripManagePrefix(key: string): string {
  const prefix = 'manage@';
  if (key.startsWith(prefix)) {
    return key.slice(prefix.length);
  }
  return key;
}

/**
 * 处理 GET 请求 - 读取所有系统设置
 *
 * @param context - Cloudflare Workers 上下文
 */
export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { env } = context;

  try {
    // 获取数据库实例（认证已由 _middleware.js 处理）
    const db = getDatabase(env as Env);

    // 3. 列出所有 manage@ 前缀的键
    const settings: Record<string, unknown> = {};
    let cursor: string | null | undefined = null;

    do {
      // 构建 list 请求选项
      const listOptions: Record<string, unknown> = {
        prefix: 'manage@',
        limit: 1000,
      };

      if (cursor) {
        listOptions.cursor = cursor;
      }

      // 执行 KV list 操作
      const listResult = await db.list(listOptions);

      // 检查响应格式
      if (!listResult || !listResult.keys || !Array.isArray(listResult.keys)) {
        return errorResponse('Database list operation failed', 500);
      }

      // 处理每个键
      for (const item of listResult.keys) {
        const key = item.name;

        // 跳过索引相关键
        if (isIndexRelatedKey(key)) {
          continue;
        }

        // 读取设置值
        try {
          const value = await db.get(key);

          if (value !== null && value !== undefined) {
            // 尝试解析 JSON，如果失败则保留原始字符串
            let parsedValue: unknown;
            try {
              parsedValue = JSON.parse(value as string);
            } catch {
              parsedValue = value;
            }

            // 使用移除前缀后的键名
            const settingKey = stripManagePrefix(key);
            settings[settingKey] = parsedValue;
          }
        } catch (valueError) {
          // 读取值失败时记录错误但继续处理
          console.error(`Failed to read value for ${key}:`, valueError);
        }
      }

      // 更新 cursor 用于下一次迭代
      cursor = listResult.cursor || null;
    } while (cursor);

    // 4. 返回成功响应
    return jsonResponse({
      success: true,
      settings,
    });
  } catch (error: any) {
    console.error('Error in BatchSettingsAPI:', error);
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
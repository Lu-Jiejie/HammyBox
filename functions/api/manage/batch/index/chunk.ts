/**
 * BatchIndexChunkAPI - 接收并存储索引分块的 API 端点
 *
 * 实现数据结构验证和 checksum 校验
 * 存储分块数据到 KV，使用 session ID 和 chunk ID 作为键
 */

import { getDatabase } from '../../../../utils/databaseAdapter.js';
import type { Env, PagesContext } from '../../../../types';

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
function errorResponse(message: string, status = 400, details: unknown = null): Response {
  const responseData: Record<string, unknown> = { success: false, error: message };
  if (details) {
    responseData.details = details;
  }
  return jsonResponse(responseData, status);
}

/**
 * 计算数据的 SHA-256 校验和
 * @returns 十六进制格式的校验和
 */
async function calculateChecksum(data: unknown): Promise<string> {
  const text = JSON.stringify(data);
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 计算 FNV-1a fallback checksum（与前端非安全上下文 fallback 一致）
 * 当客户端无法使用 crypto.subtle（如通过 0.0.0.0 访问）时使用
 */
function calculateFallbackChecksum(data: unknown): string {
  const text = JSON.stringify(data);
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(text);
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x811c9dc5 >>> 0;
  for (let i = 0; i < dataBuffer.length; i++) {
    h1 = Math.imul(h1 ^ dataBuffer[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ dataBuffer[i], 0x01000193 + 0x10) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 验证 sessionId 格式
 * 格式: rebuild_{timestamp}_{randomString}
 */
function isValidSessionId(sessionId: unknown): boolean {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return false;
  }
  // 限制长度防止过长的 key
  if (sessionId.length > 100) {
    return false;
  }
  // 只允许字母、数字、下划线和连字符
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  return validPattern.test(sessionId);
}

/**
 * 验证 chunkId 格式
 * 应该是数字字符串 (0, 1, 2, ...)
 */
function isValidChunkId(chunkId: unknown): boolean {
  if (typeof chunkId !== 'string' || chunkId.length === 0) {
    return false;
  }
  // 必须是非负整数
  const num = parseInt(chunkId, 10);
  return !isNaN(num) && num >= 0 && String(num) === chunkId;
}

/**
 * 清理字符串字段，防止注入攻击
 */
function sanitizeString(str: unknown): unknown {
  if (typeof str !== 'string') {
    return str;
  }
  // 移除控制字符（除了常见的空白字符）
  // 保留 \t (0x09), \n (0x0A), \r (0x0D)
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * 递归清理对象中的所有字符串字段
 */
function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      sanitized[sanitizeString(key) as string] = sanitizeObject((obj as Record<string, unknown>)[key]);
    }
    return sanitized;
  }

  return obj;
}

/**
 * 验证文件元数据结构
 */
function validateMetadata(metadata: unknown): { valid: boolean; error?: string } {
  if (!metadata || typeof metadata !== 'object') {
    return { valid: false, error: 'metadata must be an object' };
  }

  const meta = metadata as Record<string, unknown>;

  // FileName 字段为可选
  if (meta.FileName !== undefined && typeof meta.FileName !== 'string') {
    return { valid: false, error: 'metadata.FileName must be a string if provided' };
  }

  // 可选字段类型检查（允许 null）
  if (meta.FileType !== undefined && meta.FileType !== null && typeof meta.FileType !== 'string') {
    return { valid: false, error: 'metadata.FileType must be a string' };
  }

  if (meta.FileSize !== undefined && meta.FileSize !== null && typeof meta.FileSize !== 'string') {
    return { valid: false, error: 'metadata.FileSize must be a string' };
  }

  if (meta.TimeStamp !== undefined && typeof meta.TimeStamp !== 'number') {
    return { valid: false, error: 'metadata.TimeStamp must be a number' };
  }

  if (meta.Channel !== undefined && meta.Channel !== null && typeof meta.Channel !== 'string') {
    return { valid: false, error: 'metadata.Channel must be a string' };
  }

  if (meta.Tags !== undefined && !Array.isArray(meta.Tags)) {
    return { valid: false, error: 'metadata.Tags must be an array' };
  }

  return { valid: true };
}

/**
 * 验证单个数据记录
 */
function validateRecord(record: unknown, index: number): { valid: boolean; error?: string } {
  if (!record || typeof record !== 'object') {
    return { valid: false, error: `record[${index}] must be an object` };
  }

  const rec = record as Record<string, unknown>;

  if (typeof rec.id !== 'string' || rec.id.length === 0) {
    return { valid: false, error: `record[${index}].id must be a non-empty string` };
  }

  // 验证 id 不包含危险字符
  if (rec.id.includes('\x00') || rec.id.includes('\n') || rec.id.includes('\r')) {
    return { valid: false, error: `record[${index}].id contains invalid characters` };
  }

  const metadataValidation = validateMetadata(rec.metadata);
  if (!metadataValidation.valid) {
    return { valid: false, error: `record[${index}].${metadataValidation.error}` };
  }

  return { valid: true };
}

/**
 * 验证请求体数据结构
 */
function validateRequestBody(body: unknown): { valid: boolean; error?: string } {
  const b = body as Record<string, unknown> | null;

  // 检查必需字段
  if (!b || typeof b !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  // 验证 chunkId
  if (!isValidChunkId(b.chunkId)) {
    return { valid: false, error: 'chunkId must be a valid non-negative integer string' };
  }

  // 验证 sessionId
  if (!isValidSessionId(b.sessionId)) {
    return { valid: false, error: 'sessionId must be a valid alphanumeric string' };
  }

  // 验证 data 数组
  if (!Array.isArray(b.data)) {
    return { valid: false, error: 'data must be an array' };
  }

  // 限制数据量防止 DoS
  if (b.data.length > 10000) {
    return { valid: false, error: 'data array exceeds maximum size of 10000 records' };
  }

  // 验证每条记录
  for (let i = 0; i < b.data.length; i++) {
    const recordValidation = validateRecord(b.data[i], i);
    if (!recordValidation.valid) {
      return recordValidation;
    }
  }

  // 验证 checksum
  if (typeof b.checksum !== 'string' || b.checksum.length === 0) {
    return { valid: false, error: 'checksum must be a non-empty string' };
  }

  // 验证 checksum 格式（SHA-256 64字符 或 FNV fallback 16字符）
  if (!/^[a-f0-9]{16}$/i.test(b.checksum) && !/^[a-f0-9]{64}$/i.test(b.checksum)) {
    return { valid: false, error: 'checksum must be a valid hex string (16 or 64 characters)' };
  }

  return { valid: true };
}

/**
 * 处理 POST 请求 - 接收并存储索引分块
 *
 * @param context - Cloudflare Workers 上下文
 */
export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env } = context;

  try {
    // 认证已由 _middleware.js 处理

    // 解析请求体
    let body: unknown;
    try {
      body = await request.json();
    } catch (parseError) {
      return errorResponse('Invalid JSON in request body', 400);
    }

    // 验证请求体数据结构
    const validation = validateRequestBody(body);
    if (!validation.valid) {
      return errorResponse('Invalid request body', 400, validation.error);
    }

    const b = body as Record<string, unknown>;
    const { chunkId, sessionId, data, checksum } = b;

    // 清理数据中的字符串字段
    const sanitizedData = sanitizeObject(data);

    // 验证 checksum，根据长度选择对应算法
    // 64字符 = SHA-256（安全上下文），16字符 = FNV fallback（非安全上下文，如 0.0.0.0）
    const isFallback = String(checksum).length === 16;
    const calculatedChecksum = isFallback
      ? calculateFallbackChecksum(sanitizedData)
      : await calculateChecksum(sanitizedData);
    if (calculatedChecksum.toLowerCase() !== String(checksum).toLowerCase()) {
      return errorResponse('Checksum mismatch', 400, 'The provided checksum does not match the data');
    }

    // 6. 获取数据库实例
    const db = getDatabase(env as Env);

    // 存储分块数据到 KV
    // 使用格式: chunk_{sessionId}_{chunkId}
    const chunkKey = `chunk_${String(sessionId)}_${String(chunkId)}`;

    const chunkData = {
      chunkId,
      sessionId,
      data: sanitizedData,
      checksum: calculatedChecksum,
      storedAt: Date.now(),
      recordCount: Array.isArray(sanitizedData) ? sanitizedData.length : 0,
    };

    await db.put(chunkKey, JSON.stringify(chunkData));

    // 8. 返回成功响应
    return jsonResponse({
      success: true,
      chunkId,
      storedCount: Array.isArray(sanitizedData) ? sanitizedData.length : 0,
    });
  } catch (error: any) {
    console.error('Error in BatchIndexChunkAPI:', error);
    return errorResponse(`Database write error: ${error.message}`, 500);
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

  if (request.method === 'POST') {
    return onRequestPost(context);
  }

  if (request.method === 'OPTIONS') {
    return onRequestOptions();
  }

  return errorResponse('Method not allowed', 405);
}
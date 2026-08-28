/**
 * 数据库适配器接口
 *
 * databaseAdapter.js 提供统一的 KV/D1 访问接口，
 * 这里定义其最小契约。迁移期保持宽松（参数 any/unknown），
 * strict 收紧阶段再细化。
 */

import type { FileMetadata } from './file';

/**
 * KV list 结果中的键
 */
export interface KVListKey {
  name: string;
  metadata?: unknown;
  value?: string;
}

/**
 * KV list 结果
 */
export interface KVListResult {
  keys: KVListKey[];
  cursor?: string | null;
  list_complete?: boolean;
}

/**
 * 数据库适配器（databaseAdapter.createDatabaseAdapter 的返回值）
 *
 * 兼容 KV 与 D1 两种后端：D1DatabaseAdapter 类实现了同样的方法签名。
 */
export interface DatabaseAdapter {
  // ===== 核心 KV 风格接口 =====
  put(key: string, value: string, options?: unknown): Promise<unknown>;
  get(key: string, options?: unknown): Promise<string | null>;
  getWithMetadata(key: string, options?: unknown): Promise<{ value: string | null; metadata?: FileMetadata | unknown } | null>;
  delete(key: string, options?: unknown): Promise<unknown>;
  list(options?: unknown): Promise<KVListResult>;

  // ===== 文件别名方法（KV 与 D1 均提供） =====
  putFile?(fileId: string, value: string, options?: unknown): Promise<unknown>;
  getFile?(fileId: string, options?: unknown): Promise<unknown>;
  getFileWithMetadata?(fileId: string, options?: unknown): Promise<unknown>;
  deleteFile?(fileId: string, options?: unknown): Promise<unknown>;
  listFiles?(options?: unknown): Promise<KVListResult>;

  // ===== 设置别名方法 =====
  putSetting?(key: string, value: string, options?: unknown): Promise<unknown>;
  getSetting?(key: string, options?: unknown): Promise<string | null>;
  deleteSetting?(key: string, options?: unknown): Promise<unknown>;
  listSettings?(options?: unknown): Promise<KVListResult>;

  // ===== 索引操作方法 =====
  putIndexOperation?(
    operationId: string,
    operation: unknown,
    options?: unknown,
  ): Promise<unknown>;
  getIndexOperation?(operationId: string, options?: unknown): Promise<unknown>;
  deleteIndexOperation?(operationId: string, options?: unknown): Promise<unknown>;
  listIndexOperations?(options?: unknown): Promise<unknown[]>;
}

/**
 * 数据库配置检查结果
 */
export interface DatabaseConfigStatus {
  hasD1: boolean;
  hasKV: boolean;
  usingD1: boolean;
  usingKV: boolean;
  configured: boolean;
}
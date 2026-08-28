/**
 * 数据库适配器接口
 *
 * databaseAdapter.js 提供统一的 KV/D1 访问接口，
 * 这里定义其最小契约。迁移 utils 过程中按需细化。
 */

import type { FileMetadata, KVEntryWithMeta } from './file';

/**
 * KV 写入选项
 */
export interface KVWriteOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: FileMetadata | Record<string, unknown> | null;
}

/**
 * KV 读取选项
 */
export interface KVReadOptions {
  type?: 'text' | 'json' | 'arrayBuffer' | 'stream';
  cacheTtl?: number;
}

/**
 * KV list 选项
 */
export interface KVListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

/**
 * 数据库适配器（databaseAdapter.createDatabaseAdapter 的返回值）
 *
 * 兼容 KV 与 D1 两种后端：D1Database 类实现了同样的方法签名。
 */
export interface DatabaseAdapter {
  // ===== 核心 KV 风格接口 =====
  put(key: string, value: string, options?: KVWriteOptions): Promise<unknown>;
  get(key: string, options?: KVReadOptions & { type: 'text' }): Promise<string | null>;
  get(key: string, options?: KVReadOptions & { type: 'json' }): Promise<unknown>;
  get(key: string, options?: KVReadOptions): Promise<string | null>;
  getWithMetadata(
    key: string,
    options?: KVReadOptions
  ): Promise<KVEntryWithMeta<string, FileMetadata>>;
  delete(key: string): Promise<unknown>;
  list(options?: KVListOptions): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    cursor?: string;
    list_complete?: boolean;
  }>;

  // ===== 文件别名方法（KV 与 D1 均提供） =====
  putFile?(fileId: string, value: string, options?: KVWriteOptions): Promise<unknown>;
  getFile?(fileId: string, options?: KVReadOptions): Promise<unknown>;
  getFileWithMetadata?(fileId: string, options?: KVReadOptions): Promise<KVEntryWithMeta>;
  deleteFile?(fileId: string): Promise<unknown>;
  listFiles?(options?: KVListOptions): Promise<{ keys: Array<{ name: string }> }>;

  // ===== 设置别名方法 =====
  putSetting?(key: string, value: string, options?: KVWriteOptions): Promise<unknown>;
  getSetting?(key: string, options?: KVReadOptions): Promise<string | null>;
  deleteSetting?(key: string): Promise<unknown>;
  listSettings?(options?: KVListOptions): Promise<{ keys: Array<{ name: string }> }>;

  // ===== 索引操作方法 =====
  putIndexOperation?(operationId: string, operation: unknown, options?: KVWriteOptions): Promise<unknown>;
  getIndexOperation?(operationId: string, options?: KVReadOptions): Promise<unknown>;
  deleteIndexOperation?(operationId: string): Promise<unknown>;
  listIndexOperations?(options?: KVListOptions): Promise<unknown[]>;
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
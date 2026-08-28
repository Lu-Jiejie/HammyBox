/**
 * D1 数据库操作工具类
 *
 * 注意：类名使用 D1DatabaseAdapter 以避免与 @cloudflare/workers-types
 * 中 D1Database（CF 运行时绑定类型）命名冲突。
 *
 * 迁移期：构造函数直接接受 workers-types 的 D1Database 绑定类型，
 * prepare 语句链与行数据以宽松泛型（Record<string, any>）过渡，
 * strict 收紧阶段再细化 D1 结果类型。
 */

import type { FileMetadata } from '../types';

/** D1 查询返回的单行（迁移期宽松，strict 阶段收紧） */
type D1Row = Record<string, any>;

export class D1DatabaseAdapter {
  db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // ==================== 文件操作 ====================

  /**
   * 保存文件记录 (替代 KV.put)
   */
  putFile(fileId: string, value: string, options: Record<string, unknown> = {}): Promise<unknown> {
    value = value || '';
    const metadata = (options.metadata as FileMetadata) || {};

    // 从metadata中提取字段用于索引
    const extractedFields = this.extractMetadataFields(metadata);

    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO files (' +
        'id, value, metadata, file_name, file_type, file_size, ' +
        'upload_ip, upload_address, list_type, timestamp, ' +
        'label, folder, channel, channel_name, ' +
        'tg_file_id, tg_chat_id, tg_bot_token, is_chunked' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    return stmt
      .bind(
        fileId,
        value,
        JSON.stringify(metadata),
        extractedFields.fileName,
        extractedFields.fileType,
        extractedFields.fileSize,
        extractedFields.uploadIP,
        extractedFields.uploadAddress,
        extractedFields.listType,
        extractedFields.timestamp,
        extractedFields.label,
        extractedFields.folder,
        extractedFields.channel,
        extractedFields.channelName,
        extractedFields.tgFileId,
        extractedFields.tgChatId,
        extractedFields.tgBotToken,
        extractedFields.isChunked
      )
      .run();
  }

  /**
   * 获取文件记录 (替代 KV.get)
   */
  getFile(fileId: string): Promise<{ value: string; metadata: FileMetadata } | null> {
    const stmt = this.db.prepare('SELECT * FROM files WHERE id = ?');
    return stmt
      .bind(fileId)
      .first<D1Row>()
      .then((result: D1Row | null) => {
        if (!result) return null;

        return {
          value: result.value,
          metadata: JSON.parse(result.metadata || '{}'),
        };
      });
  }

  /**
   * 获取文件记录包含元数据 (替代 KV.getWithMetadata)
   */
  getFileWithMetadata(fileId: string): Promise<{ value: string; metadata: FileMetadata } | null> {
    return this.getFile(fileId);
  }

  /**
   * 删除文件记录 (替代 KV.delete)
   */
  deleteFile(fileId: string): Promise<unknown> {
    const stmt = this.db.prepare('DELETE FROM files WHERE id = ?');
    return stmt.bind(fileId).run();
  }

  /**
   * 列出文件 (替代 KV.list)
   */
  listFiles(options: { prefix?: string; limit?: number; cursor?: string | null } = {}): Promise<{
    keys: Array<{ name: string; metadata: FileMetadata }>;
    cursor: string | null;
    list_complete: boolean;
  }> {
    const prefix = options.prefix || '';
    const limit = options.limit || 1000;
    const cursor = options.cursor || null;

    let query = 'SELECT id, metadata FROM files';
    const params: unknown[] = [];

    if (prefix) {
      query += ' WHERE id LIKE ?';
      params.push(prefix + '%');
    }

    if (cursor) {
      query += prefix ? ' AND' : ' WHERE';
      query += ' id > ?';
      params.push(cursor);
    }

    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    let stmt = this.db.prepare(query);
    if (params.length > 0) {
      stmt = stmt.bind(...params);
    }
    return stmt.all<D1Row>().then((response) => {
      const results = response.results || [];
      const hasMore = results.length > limit;
      if (hasMore) {
        results.pop();
      }

      const keys = results.map(function (row) {
        return {
          name: row.id,
          metadata: JSON.parse(row.metadata || '{}'),
        };
      });

      return {
        keys: keys,
        cursor: hasMore && keys.length > 0 ? keys[keys.length - 1].name : null,
        list_complete: !hasMore,
      };
    });
  }

  // ==================== 设置操作 ====================

  /**
   * 保存设置 (替代 KV.put)
   */
  putSetting(key: string, value: string, category?: string | null): Promise<unknown> {
    if (!category && key.startsWith('manage@sysConfig@')) {
      category = key.split('@')[2];
    }

    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, category) VALUES (?, ?, ?)'
    );

    return stmt.bind(key, value, category).run();
  }

  /**
   * 获取设置 (替代 KV.get)
   */
  getSetting(key: string): Promise<string | null> {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    return stmt
      .bind(key)
      .first<D1Row>()
      .then((result: D1Row | null) => {
        return result ? result.value : null;
      });
  }

  /**
   * 删除设置 (替代 KV.delete)
   */
  deleteSetting(key: string): Promise<unknown> {
    const stmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    return stmt.bind(key).run();
  }

  /**
   * 列出设置 (替代 KV.list)
   */
  listSettings(options: { prefix?: string; limit?: number } = {}): Promise<{
    keys: Array<{ name: string; value: string }>;
  }> {
    const prefix = options.prefix || '';
    const limit = options.limit || 1000;

    let query = 'SELECT key, value FROM settings';
    const params: unknown[] = [];

    if (prefix) {
      query += ' WHERE key LIKE ?';
      params.push(prefix + '%');
    }

    query += ' ORDER BY key LIMIT ?';
    params.push(limit);

    let stmt = this.db.prepare(query);
    if (params.length > 0) {
      stmt = stmt.bind(...params);
    }
    return stmt.all<D1Row>().then((response) => {
      const results = response.results || [];
      const keys = results.map(function (row) {
        return {
          name: row.key,
          value: row.value,
        };
      });

      return { keys: keys };
    });
  }

  // ==================== 索引操作 ====================

  /**
   * 保存索引操作记录
   */
  putIndexOperation(
    operationId: string,
    operation: { type: string; timestamp: number; data: unknown },
  ): Promise<unknown> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO index_operations (id, type, timestamp, data) VALUES (?, ?, ?, ?)'
    );

    return stmt
      .bind(operationId, operation.type, operation.timestamp, JSON.stringify(operation.data))
      .run();
  }

  /**
   * 获取索引操作记录
   */
  getIndexOperation(operationId: string): Promise<{
    type: string;
    timestamp: number;
    data: unknown;
  } | null> {
    const stmt = this.db.prepare('SELECT * FROM index_operations WHERE id = ?');
    return stmt
      .bind(operationId)
      .first<D1Row>()
      .then((result: D1Row | null) => {
        if (!result) return null;

        return {
          type: result.type,
          timestamp: result.timestamp,
          data: JSON.parse(result.data),
        };
      });
  }

  /**
   * 删除索引操作记录
   */
  deleteIndexOperation(operationId: string): Promise<unknown> {
    const stmt = this.db.prepare('DELETE FROM index_operations WHERE id = ?');
    return stmt.bind(operationId).run();
  }

  /**
   * 列出索引操作记录
   */
  listIndexOperations(options: { limit?: number; processed?: boolean } = {}): Promise<
    Array<{ id: string; type: string; timestamp: number; data: unknown; processed: unknown }>
  > {
    const limit = options.limit || 1000;
    const processed = options.processed;

    let query = 'SELECT * FROM index_operations';
    const params: unknown[] = [];

    if (processed !== null && processed !== undefined) {
      query += ' WHERE processed = ?';
      params.push(processed);
    }

    query += ' ORDER BY timestamp LIMIT ?';
    params.push(limit);

    let stmt = this.db.prepare(query);
    if (params.length > 0) {
      stmt = stmt.bind(...params);
    }
    return stmt.all<D1Row>().then((response) => {
      const results = response.results || [];
      return results.map(function (row) {
        return {
          id: row.id,
          type: row.type,
          timestamp: row.timestamp,
          data: JSON.parse(row.data),
          processed: row.processed,
        };
      });
    });
  }

  // ==================== 工具方法 ====================

  /**
   * 从metadata中提取字段用于索引
   */
  extractMetadataFields(metadata: FileMetadata): {
    fileName: string | null;
    fileType: string | null;
    fileSize: string | number | null;
    timestamp: number | null;
    folder: string | null;
    channel: string | null;
    channelName: string | null;
    tgFileId: unknown;
    tgChatId: null;
    tgBotToken: null;
    isChunked: boolean;
    uploadIP?: unknown;
    uploadAddress?: unknown;
    listType?: unknown;
    label?: unknown;
  } {
    return {
      fileName: metadata.FileName || null,
      fileType: metadata.FileType || null,
      fileSize: metadata.FileSize || null,
      timestamp: metadata.TimeStamp || null,
      folder: metadata.Folder || null,
      channel: metadata.Channel || null,
      channelName: metadata.ChannelName || null,
      tgFileId: metadata.TgFileId || null,
      tgChatId: null,
      tgBotToken: null,
      isChunked: metadata.IsChunked || false,
    };
  }

  // ==================== 通用方法 ====================

  /**
   * 通用的put方法，根据key类型自动选择存储位置
   */
  put(key: string, value: string, options: Record<string, unknown> = {}): Promise<unknown> {
    if (key.startsWith('manage@index@operation_')) {
      const operationId = key.replace('manage@index@operation_', '');
      const operation = JSON.parse(value);
      return this.putIndexOperation(operationId, operation);
    } else if (key.startsWith('manage@')) {
      // 所有 manage@ 前缀的键统一存入 settings 表
      const category = key.split('@')[1] || '';
      return this.putSetting(key, value, category);
    } else {
      return this.putFile(key, value, options);
    }
  }

  /**
   * 通用的get方法，根据key类型自动选择获取位置
   */
  get(key: string): Promise<string | null> {
    if (key.startsWith('manage@index@operation_')) {
      const operationId = key.replace('manage@index@operation_', '');
      return this.getIndexOperation(operationId).then((operation) => {
        return operation ? JSON.stringify(operation) : null;
      });
    } else if (key.startsWith('manage@')) {
      return this.getSetting(key);
    } else {
      return this.getFile(key).then((file) => {
        return file ? file.value : null;
      });
    }
  }

  /**
   * 通用的getWithMetadata方法
   */
  getWithMetadata(key: string): Promise<{ value: string; metadata: FileMetadata } | null> {
    if (key.startsWith('manage@')) {
      return this.getSetting(key).then((value) => {
        return value ? { value: value, metadata: {} } : null;
      });
    } else {
      return this.getFileWithMetadata(key);
    }
  }

  /**
   * 通用的delete方法
   */
  delete(key: string): Promise<unknown> {
    if (key.startsWith('manage@index@operation_')) {
      const operationId = key.replace('manage@index@operation_', '');
      return this.deleteIndexOperation(operationId);
    } else if (key.startsWith('manage@')) {
      return this.deleteSetting(key);
    } else {
      return this.deleteFile(key);
    }
  }

  /**
   * 通用的list方法
   */
  list(
    options: { prefix?: string; limit?: number; cursor?: string | null; processed?: boolean } = {},
  ): Promise<{
    keys: Array<{ name: string; metadata?: FileMetadata; value?: string }>;
    cursor?: string | null;
    list_complete?: boolean;
  }> {
    const prefix = options.prefix || '';

    if (prefix.startsWith('manage@index@operation_')) {
      return this.listIndexOperations(options).then(function (operations) {
        const keys = operations.map(function (op) {
          return {
            name: 'manage@index@operation_' + op.id,
          };
        });
        return { keys: keys };
      });
    } else if (prefix.startsWith('manage@')) {
      return this.listSettings(options);
    } else {
      return this.listFiles(options);
    }
  }
}
/**
 * 数据库适配器
 * 提供统一的接口，可以在KV和D1之间切换
 */

import { D1DatabaseAdapter } from './d1Database.js';
import type { Env, DatabaseAdapter, KVListResult } from '../types';

/**
 * 创建数据库适配器
 * @param env 环境变量
 * @returns 数据库适配器实例，未配置时返回 null
 */
export function createDatabaseAdapter(env: Env): DatabaseAdapter | null {
    // 检查是否配置了数据库
    if (env.hammybox_kv && typeof env.hammybox_kv.get === 'function') {
        // 使用KV存储
        return new KVAdapter(env.hammybox_kv);
    } else if (env.hammybox_d1 && typeof env.hammybox_d1.prepare === 'function') {
        // 使用D1数据库
        return new D1DatabaseAdapter(env.hammybox_d1);
    } else {
        console.error('No database configured. Please configure either KV (env.hammybox_kv) or D1 (env.hammybox_d1).');
        return null;
    }
}

/**
 * KV适配器类
 * 保持与原有KV接口的兼容性
 */
class KVAdapter implements DatabaseAdapter {
    kv: KVNamespace;

    constructor(kv: KVNamespace) {
        this.kv = kv;
    }

    // 直接代理到KV的方法
    async put(key: string, value: string | ArrayBuffer, options?: unknown): Promise<unknown> {
        options = options || {};
        return await this.kv.put(key, value as never, options as KVNamespacePutOptions);
    }

    async get(key: string, options?: unknown): Promise<string | null> {
        options = options || {};
        return await this.kv.get(key, options as KVNamespaceGetOptions<'text'>);
    }

    async getWithMetadata(key: string, options?: unknown): Promise<{ value: string | ArrayBuffer | null; metadata?: unknown }> {
        options = options || {};
        return await this.kv.getWithMetadata(key, options as KVNamespaceGetOptions<'text'>) as { value: string | ArrayBuffer | null; metadata?: unknown };
    }

    async delete(key: string): Promise<unknown> {
        return await this.kv.delete(key);
    }

    async list(options?: unknown): Promise<KVListResult> {
        options = options || {};
        return await this.kv.list(options as KVNamespaceListOptions);
    }

    // 为了兼容性，添加一些别名方法
    async putFile(fileId: string, value: string, options?: unknown): Promise<unknown> {
        return await this.put(fileId, value, options);
    }

    async getFile(fileId: string, options?: unknown): Promise<{ value: string | ArrayBuffer | null; metadata?: unknown }> {
        const result = await this.getWithMetadata(fileId, options);
        return result;
    }

    async getFileWithMetadata(fileId: string, options?: unknown): Promise<{ value: string | ArrayBuffer | null; metadata?: unknown }> {
        return await this.getWithMetadata(fileId, options);
    }

    async deleteFile(fileId: string): Promise<unknown> {
        return await this.delete(fileId);
    }

    async listFiles(options?: unknown): Promise<KVListResult> {
        return await this.list(options);
    }

    async putSetting(key: string, value: string, options?: unknown): Promise<unknown> {
        return await this.put(key, value, options);
    }

    async getSetting(key: string, options?: unknown): Promise<string | null> {
        return await this.get(key, options);
    }

    async deleteSetting(key: string): Promise<unknown> {
        return await this.delete(key);
    }

    async listSettings(options?: unknown): Promise<KVListResult> {
        return await this.list(options);
    }

    async putIndexOperation(operationId: string, operation: unknown, options?: unknown): Promise<unknown> {
        const key = 'manage@index@operation_' + operationId;
        return await this.put(key, JSON.stringify(operation), options);
    }

    async getIndexOperation(operationId: string, options?: unknown): Promise<unknown> {
        const key = 'manage@index@operation_' + operationId;
        const result = await this.get(key, options);
        return result ? JSON.parse(result) : null;
    }

    async deleteIndexOperation(operationId: string, options?: unknown): Promise<unknown> {
        const key = 'manage@index@operation_' + operationId;
        return await this.delete(key);
    }

    async listIndexOperations(options?: unknown): Promise<unknown[]> {
        const listOptions = Object.assign({}, options, {
            prefix: 'manage@index@operation_'
        });
        const result = await this.list(listOptions);

        // 转换格式以匹配D1Database的返回格式
        const operations: unknown[] = [];
        for (const item of result.keys) {
            const operationData = await this.get(item.name);
            if (operationData) {
                const operation = JSON.parse(operationData);
                operations.push({
                    id: item.name.replace('manage@index@operation_', ''),
                    type: operation.type,
                    timestamp: operation.timestamp,
                    data: operation.data,
                    processed: false // KV中没有这个字段，默认为false
                });
            }
        }

        return operations;
    }
}

/**
 * 获取数据库实例的便捷函数
 * 这个函数可以在整个应用中使用，确保一致的数据库访问
 * @param env 环境变量
 * @returns 数据库实例
 */
export function getDatabase(env: Env): DatabaseAdapter {
    const adapter = createDatabaseAdapter(env);
    if (!adapter) {
        throw new Error('Database not configured. Please configure D1 database (env.hammybox_d1) or KV storage (env.hammybox_kv).');
    }
    return adapter;
}

/**
 * 检查数据库配置
 * @param env 环境变量
 * @returns 配置信息
 */
export function checkDatabaseConfig(env: Env): {
    hasD1: boolean;
    hasKV: boolean;
    usingD1: boolean;
    usingKV: boolean;
    configured: boolean;
} {
    const hasD1 = env.hammybox_d1 && typeof env.hammybox_d1.prepare === 'function';
    const hasKV = env.hammybox_kv && typeof env.hammybox_kv.get === 'function';

    return {
        hasD1: hasD1,
        hasKV: hasKV,
        usingD1: hasD1,
        usingKV: !hasD1 && hasKV,
        configured: hasD1 || hasKV
    };
}
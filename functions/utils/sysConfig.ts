import { getUploadConfig } from '../api/manage/sysConfig/upload.js';
import { getSecurityConfig } from '../api/manage/sysConfig/security.js';
import { getPageConfig } from '../api/manage/sysConfig/page.js';
import { getOthersConfig } from '../api/manage/sysConfig/others.js';
import { getDatabase } from './databaseAdapter.js';
import { getIndexMeta } from './indexManager.js';
import type {
  Env,
  DatabaseAdapter,
  AnyChannel,
  UploadConfig,
  SecurityConfig,
  PageConfig,
  OthersConfig,
} from '../types';

/** 索引上下文（供 getIndexMeta 使用的最小结构） */
interface IndexContext {
  env: Env;
}

/**
 * 配置短 TTL 缓存。
 *
 * Cloudflare Workers/Pages 中每次请求可能复用同一 isolate，模块级变量跨请求存活。
 * 系统配置（上传渠道/安全/其他/页面）写入频率极低，但读频率很高
 * （上传的每个分块、每次列表、每次鉴权都会触发）。缓存 10 秒可大幅减少 KV 读取，
 * 同时保证配置变更（保存后）最多 10 秒内生效。
 *
 * 保存配置的接口在写入 KV 后调用 invalidateConfigCache() 立即失效缓存。
 */
const CONFIG_CACHE_TTL_MS = 10_000;

const configCache = new Map<string, { value: unknown; expiresAt: number }>();

/**
 * 使配置缓存失效（保存配置后调用，保证新配置立即生效）。
 */
export function invalidateConfigCache(): void {
  configCache.clear();
}

async function cachedFetch<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const cached = configCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }
  const value = await loader();
  configCache.set(key, { value, expiresAt: now + CONFIG_CACHE_TTL_MS });
  return value;
}

/**
 * 根据容量限制过滤渠道
 * @param context - 上下文对象（包含 env）
 * @param channels - 渠道列表
 * @returns 过滤后的渠道列表
 */
async function filterChannelsByQuota<T extends AnyChannel>(
  context: IndexContext,
  channels: T[],
): Promise<T[]> {
  // 先检查是否有任何渠道启用了容量限制，如果都没启用则跳过 KV 读取
  const hasQuotaEnabled = channels.some(ch => ch.quota?.enabled && ch.quota?.limitGB);
  if (!hasQuotaEnabled) {
    return channels; // 无需读取 KV，直接返回所有渠道
  }

  // 获取索引元数据（只需 1 次读取）
  const indexMeta = await getIndexMeta(context);
  const channelStats = (indexMeta.channelStats || {}) as Record<
    string,
    { usedMB: number; fileCount: number }
  >;

  const result: T[] = [];
  for (const channel of channels) {
    // 未启用容量限制，直接通过
    if (!channel.quota?.enabled || !channel.quota?.limitGB) {
      result.push(channel);
      continue;
    }

    try {
      // 从索引元数据中获取该渠道的容量统计
      const stats = channelStats[channel.name] || { usedMB: 0, fileCount: 0 };

      const usedGB = stats.usedMB / 1024;
      const limitGB = channel.quota.limitGB;
      const threshold = channel.quota.threshold || 95;

      // 未超过阈值，渠道可用
      if ((usedGB / limitGB) * 100 < threshold) {
        result.push(channel);
      } else {
        console.log(
          `Channel ${channel.name} quota exceeded: ${usedGB.toFixed(2)}GB / ${limitGB}GB (${threshold}% threshold)`
        );
      }
    } catch (error) {
      console.error(`Failed to check quota for channel ${channel.name}:`, error);
      // 检查失败时保守处理，允许使用该渠道
      result.push(channel);
    }
  }
  return result;
}

export async function fetchUploadConfig(env: Env, context: IndexContext | null = null): Promise<UploadConfig> {
  return cachedFetch('upload', async () => {
    const db = getDatabase(env);
    const settings = await getUploadConfig(db, env);
    // 去除 已禁用 的渠道
    settings.telegram.channels = settings.telegram.channels.filter(channel => channel.enabled);
    settings.cfr2.channels = settings.cfr2.channels.filter(channel => channel.enabled);
    settings.s3.channels = settings.s3.channels.filter(channel => channel.enabled);
    settings.discord.channels = settings.discord.channels.filter(channel => channel.enabled);
    settings.huggingface.channels = settings.huggingface.channels.filter(channel => channel.enabled);
    settings.webdav.channels = settings.webdav.channels.filter(channel => channel.enabled);

    // 根据容量限制过滤渠道（可用于 R2、S3、WebDAV）
    // 需要 context 来调用 getIndexMeta
    if (context) {
      settings.cfr2.channels = await filterChannelsByQuota(context, settings.cfr2.channels);
      settings.s3.channels = await filterChannelsByQuota(context, settings.s3.channels);
      settings.webdav.channels = await filterChannelsByQuota(context, settings.webdav.channels);
    }

    return settings;
  });
}

export async function fetchSecurityConfig(env: Env): Promise<SecurityConfig> {
  return cachedFetch('security', async () => {
    try {
      const db = getDatabase(env);
      const settings = await getSecurityConfig(db, env);
      return settings;
    } catch (error) {
      console.error('Failed to fetch security config:', error);
      // 返回默认配置
      return {
        auth: {
          password: '',
        },
        upload: {
          moderate: { enabled: false, channel: 'default', moderateContentApiKey: '', nsfwApiPath: '' },
        },
        access: {
          sessionSecure: false,
          sessionMaxAge: 14,
          refererCheck: {
            enabled: false,
            allowedDomains: [],
            allowEmptyReferer: true,
          },
          whiteListMode: {
            enabled: false,
          },
        },
      } as SecurityConfig;
    }
  });
}

export async function fetchPageConfig(env: Env): Promise<PageConfig> {
  return cachedFetch('page', async () => {
    try {
      const db = getDatabase(env);
      const settings = await getPageConfig(db, env);
      return settings;
    } catch (error) {
      console.error('Failed to fetch page config:', error);
      // 返回默认配置
      return { config: [] } as PageConfig;
    }
  });
}

export async function fetchOthersConfig(env: Env): Promise<OthersConfig> {
  return cachedFetch('others', async () => {
    try {
      const db = getDatabase(env);
      const settings = await getOthersConfig(db, env);
      return settings;
    } catch (error) {
      console.error('Failed to fetch others config:', error);
      // 返回默认配置
      return {
        telemetry: { enabled: false },
      } as OthersConfig;
    }
  });
}
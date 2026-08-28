import { fetchOthersConfig } from './sysConfig.js';
import type { Env, OthersConfig } from '../types';

let othersConfig: Partial<OthersConfig> = {};
let cfZoneId = '';
let cfEmail = '';
let cfApiKey = '';

/**
 * 清除 Cloudflare CDN 缓存
 * @param env - 环境变量
 * @param cdnUrl - CDN 文件地址
 */
export async function purgeCFCache(env: Env, cdnUrl: string): Promise<void> {
  try {
    // 读取其他设置
    othersConfig = await fetchOthersConfig(env);
    cfZoneId = othersConfig.cloudflareApiToken?.CF_ZONE_ID || '';
    cfEmail = othersConfig.cloudflareApiToken?.CF_EMAIL || '';
    cfApiKey = othersConfig.cloudflareApiToken?.CF_API_KEY || '';

    // 如果没有配置Cloudflare API，跳过缓存清除
    if (!cfZoneId || !cfEmail || !cfApiKey) {
      return;
    }

    // 清除CDN缓存
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Email': `${cfEmail}`,
        'X-Auth-Key': `${cfApiKey}`,
      },
      body: `{"files":["${cdnUrl}"]}`,
    };
    await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZoneId}/purge_cache`, options);
  } catch (error: any) {
    console.error('Failed to purge CF cache:', error.message || error);
  }
}

/**
 * 清除随机文件列表缓存
 * @param origin - 站点域名
 * @param dirs - 目录列表
 */
export async function purgeRandomFileListCache(origin: string, ...dirs: string[]): Promise<void> {
  try {
    const cache = caches.default;
    // cache.delete有bug，通过写入一个max-age=0的response来清除缓存
    const nullResponse = new Response(null, {
      headers: { 'Cache-Control': 'max-age=0' },
    });

    for (const dir of dirs) {
      // v=2 与 random/index.js 的 getRandomFileList 缓存键保持一致；
      // 同时清理旧版无 v 参数的键，兼容升级前的残留缓存
      await cache.put(`${origin}/api/randomFileList?folder=${dir}&v=2`, nullResponse);
      await cache.put(`${origin}/api/randomFileList?folder=${dir}`, nullResponse);
    }
  } catch (error) {
    console.error('Failed to clear randomFileList cache:', error);
  }
}

/**
 * 清除公开文件列表缓存
 * @param origin - 站点域名
 * @param dirs - 目录列表
 */
export async function purgePublicFileListCache(origin: string, ...dirs: string[]): Promise<void> {
  try {
    const cache = caches.default;
    // cache.delete有bug，通过写入一个max-age=0的response来清除缓存
    const nullResponse = new Response(null, {
      headers: { 'Cache-Control': 'max-age=0' },
    });

    for (const dir of dirs) {
      // 清除递归和非递归两种缓存
      await cache.put(`${origin}/api/publicFileList?folder=${dir}&recursive=false`, nullResponse);
      await cache.put(`${origin}/api/publicFileList?folder=${dir}&recursive=true`, nullResponse);
    }
  } catch (error) {
    console.error('Failed to clear publicFileList cache:', error);
  }
}

/**
 * 清理单个文件的 Cache API 缓存
 * @param origin - 域名（如 https://your-domain.com）
 * @param fileId - 文件ID（如 photos/2024/cat.png）
 */
export async function purgeFileCache(origin: string, fileId: string): Promise<void> {
  try {
    const cache = caches.default;
    // 构建文件访问 URL（使用逗号分隔路径）
    const fileUrl = `${origin}/api/file/${fileId.split('/').join(',')}`;

    // cache.delete 有 bug，通过写入一个 max-age=0 的 response 来清除缓存
    const nullResponse = new Response(null, {
      headers: { 'Cache-Control': 'max-age=0' },
    });

    await cache.put(fileUrl, nullResponse);
  } catch (error) {
    console.error('Failed to purge file cache:', error);
  }
}
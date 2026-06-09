import { fetchOthersConfig } from "./sysConfig";

let othersConfig = {};
let cfZoneId = "";
let cfEmail = "";
let cfApiKey = "";

export async function purgeCFCache(env, cdnUrl) {
    try {
        // 读取其他设置
        othersConfig = await fetchOthersConfig(env);
        cfZoneId = othersConfig.cloudflareApiToken.CF_ZONE_ID;
        cfEmail = othersConfig.cloudflareApiToken.CF_EMAIL;
        cfApiKey = othersConfig.cloudflareApiToken.CF_API_KEY;

        // 如果没有配置Cloudflare API，跳过缓存清除
        if (!cfZoneId || !cfEmail || !cfApiKey) {
            return;
        }

        // 清除CDN缓存
        const options = {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Auth-Email': `${cfEmail}`, 'X-Auth-Key': `${cfApiKey}`},
            body: `{"files":["${ cdnUrl }"]}`
        };
        await fetch(`https://api.cloudflare.com/client/v4/zones/${ cfZoneId }/purge_cache`, options);
    } catch (error) {
        console.error('Failed to purge CF cache:', error.message || error);
    }
}

export async function purgeRandomFileListCache(origin, ...dirs) {
    try {
        const cache = caches.default;
        // cache.delete有bug，通过写入一个max-age=0的response来清除缓存
        const nullResponse = new Response(null, {
            headers: { 'Cache-Control': 'max-age=0' },
        });

        for (const dir of dirs) {
            await cache.put(`${origin}/api/randomFileList?folder=${dir}`, nullResponse);
        }
    } catch (error) {
        console.error('Failed to clear randomFileList cache:', error);
    }
}

export async function purgePublicFileListCache(origin, ...dirs) {
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
 * @param {string} origin - 域名（如 https://your-domain.com）
 * @param {string} fileId - 文件ID（如 photos/2024/cat.png）
 */
export async function purgeFileCache(origin, fileId) {
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
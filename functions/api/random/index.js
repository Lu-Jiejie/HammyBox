import { fetchOthersConfig } from "../../utils/sysConfig";
import { readIndex } from "../../utils/indexManager";
import { detectDevice, resolveOrientation, addClientHintsHeaders } from "./adaptive.js";
import { normalizeFolderPath } from "../../utils/pathNormalizer.js";

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

let othersConfig = {};
let allowRandom = false;

export async function onRequest(context) {
    // Contents of context object
    const {
      request, // same as existing Worker API
      env, // same as existing Worker API
      params, // if filename includes [id] or [[path]]
      waitUntil, // same as ctx.waitUntil in existing Worker API
      next, // used for middleware or to fetch assets
      data, // arbitrary space for passing data between middlewares
    } = context;
    const requestUrl = new URL(request.url);

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // 读取其他设置
    othersConfig = await fetchOthersConfig(env);
    allowRandom = othersConfig.randomImageAPI.enabled;
    const allowedDir = othersConfig.randomImageAPI.allowedDir || '';

    // 检查是否启用了随机图功能
    if (allowRandom != true) {
        return new Response(JSON.stringify({ error: "Random is disabled" }), { status: 403, headers: corsHeaders });
    }

    // 处理允许的目录，每个目录调整为标准格式
    // 非法条目跳过并告警，避免单条配置错误导致整个 API 不可用
    const allowedDirList = allowedDir.split(',');
    const allowedDirListFormatted = [];
    for (const item of allowedDirList) {
        try {
            const normalized = normalizeFolderPath(item);
            allowedDirListFormatted.push(normalized ? normalized.replace(/\/$/, '') : ''); // 移除末尾斜杠用于比较
        } catch (e) {
            console.warn(`Invalid allowedDir entry skipped: "${item}"`);
        }
    }

    // 从params中读取返回的文件类型
    let fileType = requestUrl.searchParams.get('content');
    if (fileType == null) {
        fileType = ['image'];
    } else {
        fileType = fileType.split(',');
    }

    // 读取图片方向参数：landscape(横图), portrait(竖图), square(方图), auto(自适应)
    const orientationParam = requestUrl.searchParams.get('orientation') || '';

    // 根据参数值决定行为
    const VALID_ORIENTATIONS = ['landscape', 'portrait', 'square'];
    let orientation = '';
    let isAutoMode = false;

    if (VALID_ORIENTATIONS.includes(orientationParam)) {
        // 手动指定有效方向，直接使用
        orientation = orientationParam;
    } else if (orientationParam === 'auto') {
        // 自适应模式：检测设备并自动决策
        isAutoMode = true;
        const deviceInfo = detectDevice(request);
        orientation = resolveOrientation(deviceInfo);
    }
    // 其他情况（未指定或无效值）：orientation 保持空字符串，不过滤

    // 读取指定文件夹：优先 dir（与原版文档/原项目参数名一致），folder 作为兼容别名
    let folder = requestUrl.searchParams.get('dir') ?? requestUrl.searchParams.get('folder');
    folder = folder === null || folder === undefined ? '' : normalizeFolderPath(folder);
    const dir = folder ? folder.replace(/\/$/, '') : ''; // 移除末尾斜杠用于比较

    // 检查是否在允许的目录中，或是允许目录的子目录
    let dirAllowed = false;
    for (let i = 0; i < allowedDirListFormatted.length; i++) {
        if (allowedDirListFormatted[i] === '' || dir === allowedDirListFormatted[i] || dir.startsWith(allowedDirListFormatted[i] + '/')) {
            dirAllowed = true;
            break;
        }
    }
    if (!dirAllowed) {
        return new Response(JSON.stringify({ error: "Directory not allowed" }), { status: 403, headers: corsHeaders });
    }

    // 调用randomFileList接口，读取KV数据库中的所有记录
    let allRecords = await getRandomFileList(context, requestUrl, dir);

    // 筛选出符合fileType要求的记录
    allRecords = allRecords.filter(item => { return fileType.some(type => item.FileType?.includes(type)) });

    // 按标签过滤：tag 参数（逗号分隔，候选须全部包含）；excludeTag 参数（逗号分隔，含任一即排除）
    const includeTags = (requestUrl.searchParams.get('tag') || '')
        .split(',').map(t => t.trim().toLowerCase()).filter(t => t);
    if (includeTags.length > 0) {
        allRecords = allRecords.filter(item => {
            const fileTags = (item.Tags || []).map(t => String(t).toLowerCase());
            return includeTags.every(t => fileTags.includes(t));
        });
    }
    const excludeTags = (requestUrl.searchParams.get('excludeTag') || '')
        .split(',').map(t => t.trim().toLowerCase()).filter(t => t);
    if (excludeTags.length > 0) {
        allRecords = allRecords.filter(item => {
            const fileTags = (item.Tags || []).map(t => String(t).toLowerCase());
            return !excludeTags.some(t => fileTags.includes(t));
        });
    }

    // 保存过滤前的记录，用于自适应模式降级
    const allRecordsBeforeOrientationFilter = allRecords;

    // 根据图片方向筛选
    if (orientation && allRecords.length > 0) {
        const SQUARE_THRESHOLD = 0.1; // 宽高比差异小于10%视为方图
        allRecords = allRecords.filter(item => {
            // 如果没有尺寸信息，跳过该记录
            if (!item.Width || !item.Height) return false;

            const ratio = item.Width / item.Height;
            switch (orientation) {
                case 'landscape': // 横图：宽 > 高
                    return ratio > (1 + SQUARE_THRESHOLD);
                case 'portrait': // 竖图：高 > 宽
                    return ratio < (1 - SQUARE_THRESHOLD);
                case 'square': // 方图：宽 ≈ 高
                    return ratio >= (1 - SQUARE_THRESHOLD) && ratio <= (1 + SQUARE_THRESHOLD);
                default:
                    return true;
            }
        });
    }

    // 自适应模式降级：过滤后无匹配图片时，降级到全部图片
    if (isAutoMode && orientation && allRecords.length === 0) {
        allRecords = allRecordsBeforeOrientationFilter;
    }

    // 构建响应头：添加 CORS 跨域响应头，自适应模式下添加 Client Hints 协商头
    const responseHeaders = new Headers(corsHeaders);
    if (isAutoMode) {
        addClientHintsHeaders(responseHeaders);
    }

    if (allRecords.length == 0) {
        return new Response(JSON.stringify({}), { status: 200, headers: responseHeaders });
    } else {
        const randomIndex = Math.floor(Math.random() * allRecords.length);
        const randomKey = allRecords[randomIndex];
        const randomPath = '/api/file/' + randomKey.name;
        let randomUrl = randomPath;

        const randomType = requestUrl.searchParams.get('type');
        const resType = requestUrl.searchParams.get('form');
        
        // if param 'type' is set to 'url', return the full URL
        if (randomType == 'url') {
            randomUrl = requestUrl.origin + randomPath;
        }

        // if param 'type' is set to 'img', return the image
        if (randomType == 'img') {
            // Return an image response
            randomUrl = requestUrl.origin + randomPath;
            let contentType = 'image/jpeg';
            const imgHeaders = new Headers(responseHeaders);
            return new Response(await fetch(randomUrl).then(res => {
                contentType = res.headers.get('content-type');
                return res.blob();
            }), {
                headers: (() => {
                    imgHeaders.set('Content-Type', contentType || 'image/jpeg');
                    return imgHeaders;
                })(),
                status: 200
            });
        }
        
        if (resType == 'text') {
            return new Response(randomUrl, { status: 200, headers: responseHeaders });
        } else {
            return new Response(JSON.stringify({ url: randomUrl }), { status: 200, headers: responseHeaders });
        }
    }
}

async function getRandomFileList(context, url, dir) {
    // dir 已经是移除末尾斜杠的格式，用于缓存键
    // v=2：新版缓存携带 Tags 字段，避免复用旧版无标签缓存导致 tag 过滤失效
    const cacheKey = `${url.origin}/api/randomFileList?folder=${dir}&v=2`;

    // 检查缓存中是否有记录，有则直接返回
    const cache = caches.default;
    const cacheRes = await cache.match(cacheKey);
    if (cacheRes) {
        return JSON.parse(await cacheRes.text());
    }

    // 传给 readIndex 的 folder 需要有后置斜杠（如果非空）
    const folderParam = dir ? dir + '/' : '';
    let allRecords = await readIndex(context, { folder: folderParam, count: -1, includeSubdirFiles: true, accessStatus: 'normal' });

    // 仅保留记录的name和metadata中的必要字段（含 Tags，供 tag/excludeTag 过滤使用）
    allRecords = allRecords.files?.map(item => {
        return {
            name: item.id,
            FileType: item.metadata?.FileType,
            Width: item.metadata?.Width,
            Height: item.metadata?.Height,
            Tags: item.metadata?.Tags
        }
    });

    // 缓存结果，缓存时间为24小时
    await cache.put(cacheKey, new Response(JSON.stringify(allRecords), {
        headers: {
            "Content-Type": "application/json",
        }
    }), {
        expirationTtl: 24 * 60 * 60
    });
    
    return allRecords;
}
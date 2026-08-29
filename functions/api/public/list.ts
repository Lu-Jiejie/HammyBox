import { fetchOthersConfig } from '../../utils/sysConfig.js';
import { readIndex } from '../../utils/indexManager.js';
import { normalizeFolderPath } from '../../utils/pathNormalizer.js';
import type { Env, PagesContext } from '../../types';

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/**
 * 检查目录是否在允许列表中
 * @param folder - 请求的目录
 * @param allowedDirs - 允许的目录列表
 * @returns 是否允许访问
 */
function isAllowedDirectory(folder: string, allowedDirs: string[]): boolean {
  // 如果允许目录列表为空，视为允许所有目录（包括根目录）
  if (!allowedDirs || allowedDirs.length === 0) {
    return true;
  }

  // 标准化目录格式
  const normalizedDir = folder.replace(/^\/+/, '').replace(/\/+$/, '');

  for (const allowed of allowedDirs) {
    const normalizedAllowed = allowed.trim().replace(/^\/+/, '').replace(/\/+$/, '');

    // "*" 或空字符串表示允许所有目录（包括根目录）
    if (normalizedAllowed === '*' || normalizedAllowed === '') {
      return true;
    }

    // 根目录访问：如果请求的是空目录，需要精确匹配
    if (normalizedDir === '' && normalizedAllowed !== '') {
      continue; // 根目录不匹配具体目录名
    }

    // 精确匹配或子目录匹配
    if (
      normalizedDir === normalizedAllowed ||
      normalizedDir.startsWith(normalizedAllowed + '/')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * 获取公开浏览文件列表
 * @param context - 上下文对象
 * @param url - 请求URL
 * @param folder - 目录
 * @param recursive - 是否递归
 * @param includeTags - 标签过滤（AND，全部命中才返回）
 * @returns 文件列表和目录列表，包含 fromCache 字段
 *
 * 缓存策略：
 * - 目录模式（无 includeTags）：使用 Cache API 缓存 24h（配合 purgePublicFileListCache 清除）
 * - tag 模式（有 includeTags）：跳过 Cache API（标签实时变化，缓存会导致打标签后看不到新文件），
 *   仅依赖 CDN 边缘缓存（Cache-Control 短 TTL）
 */
async function getPublicFileList(
  context: PagesContext,
  url: URL,
  folder: string,
  recursive: boolean,
  includeTags: string[] = []
): Promise<Record<string, unknown>> {
  // tag 模式跳过 Cache API，直接读取实时索引
  const useCacheApi = includeTags.length === 0;

  // 构建缓存键（目录格式去掉末尾的/，与清除缓存时的格式一致）
  const cacheDir = folder.replace(/\/$/, '');
  const tagsKey = includeTags.length > 0 ? `&tags=${includeTags.join(',')}` : '';
  const cacheKey = `${url.origin}/api/publicFileList?folder=${cacheDir}&recursive=${recursive}${tagsKey}`;

  // 检查缓存中是否有记录
  if (useCacheApi) {
    const cache = caches.default;
    const cacheRes = await cache.match(cacheKey);
    if (cacheRes) {
      const data = JSON.parse(await cacheRes.text());
      data.fromCache = true;
      return data;
    }
  }

  // 读取文件列表
  const result = await readIndex(context, {
    folder: folder,
    start: 0,
    count: -1,
    includeSubdirFiles: recursive,
    accessStatus: 'normal', // 只返回正常可访问的内容
    includeTags: includeTags,
  });

  if (!result.success) {
    return { files: [], folders: [], totalCount: 0, fromCache: false };
  }

  // 转换文件格式（只保留必要信息）
  const files = result.files.map(file => ({
    id: file.id,
    metadata: {
      FileType: file.metadata?.FileType,
      TimeStamp: file.metadata?.TimeStamp,
      FileSize: file.metadata?.FileSize,
    },
  }));

  const cacheData: Record<string, unknown> = {
    files,
    folders: result.folders,
    totalCount: result.totalCount,
  };

  // 目录模式：缓存结果 24 小时（由 purgePublicFileListCache 负责清除）
  if (useCacheApi) {
    const cache = caches.default;
    await (cache.put as any)(
      cacheKey,
      new Response(JSON.stringify(cacheData), {
        headers: {
          'Content-Type': 'application/json',
        },
      }),
      {
        expirationTtl: 24 * 60 * 60,
      }
    );
  }

  cacheData.fromCache = false;
  return cacheData;
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);

  // OPTIONS 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // 只允许 GET 请求
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    // 读取配置
    const othersConfig = await fetchOthersConfig(env as Env);
    const publicBrowse = othersConfig.publicBrowse || {};

    // 检查是否启用公开浏览
    if (!publicBrowse.enabled) {
      return new Response(JSON.stringify({ error: 'Public browse is disabled' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 解析允许的目录（目录浏览模式使用；tag 模式不受目录白名单限制）
    const allowedDirStr = publicBrowse.allowedDir || '';
    const allowedDirs = allowedDirStr.split(',').map(d => d.trim()).filter(d => d);

    // 获取请求的目录和搜索参数
    let folder = url.searchParams.get('folder');
    folder = folder === null || folder === undefined ? '' : normalizeFolderPath(folder);
    let search = url.searchParams.get('search') || '';
    if (search) {
      search = decodeURIComponent(search).trim().toLowerCase();
    }

    // 标签过滤（支持 tags=photo,shared 逗号分隔，或 tags[]=photo&tags[]=shared 数组形式；AND 匹配）
    let tagsParam = url.searchParams.get('tags') || '';
    if (!tagsParam) {
      tagsParam = url.searchParams.getAll('tags[]').join(',');
    }
    const includeTags = tagsParam.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

    // 获取高级搜索参数
    const recursive = url.searchParams.get('recursive') === 'true';
    const fileType = url.searchParams.get('type') || ''; // image, video, audio, other

    // tag 模式：按标签收录即为授权，跳过目录白名单检查
    if (includeTags.length === 0 && !isAllowedDirectory(folder, allowedDirs)) {
      return new Response(JSON.stringify({ error: 'Directory not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 解析分页参数
    const start = parseInt(url.searchParams.get('start') || '', 10) || 0;
    const count = parseInt(url.searchParams.get('count') || '', 10) || 50;

    // 获取文件列表（带缓存）
    const cachedData = await getPublicFileList(context, url, folder, recursive, includeTags);

    // 过滤子文件夹，只返回允许的文件夹
    const folders = (cachedData.folders || []) as string[];
    const filteredFolders = folders.filter(subFolder => {
      return isAllowedDirectory(subFolder, allowedDirs);
    });

    // 文件类型过滤辅助函数
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'];
    const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv', 'avi', '3gp', 'mpeg', 'mpg', 'flv', 'wmv', 'ts', 'rmvb'];
    const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'ape', 'opus'];

    const getFileExt = (name: string) => (name.split('.').pop() || '').toLowerCase();
    const isImageFile = (name: string) => imageExts.includes(getFileExt(name));
    const isVideoFile = (name: string) => videoExts.includes(getFileExt(name));
    const isAudioFile = (name: string) => audioExts.includes(getFileExt(name));

    let filteredFiles = (cachedData.files || []) as Record<string, any>[];

    // 搜索过滤
    if (search) {
      filteredFiles = filteredFiles.filter(file => {
        return file.id.toLowerCase().includes(search);
      });
    }

    // 按文件类型过滤
    if (fileType) {
      filteredFiles = filteredFiles.filter(file => {
        const name = file.id as string;
        switch (fileType) {
          case 'image':
            return isImageFile(name);
          case 'video':
            return isVideoFile(name);
          case 'audio':
            return isAudioFile(name);
          case 'other':
            return !isImageFile(name) && !isVideoFile(name) && !isAudioFile(name);
          default:
            return true;
        }
      });
    }

    // 计算过滤后的总数和分页
    const filteredTotalCount = filteredFiles.length;
    // 过滤后再分页
    filteredFiles = filteredFiles.slice(start, start + count);

    // 转换文件格式
    const safeFiles = filteredFiles.map(file => ({
      name: file.id,
      metadata: file.metadata,
    }));

    // tag 模式数据实时变化，CDN 短缓存（60s）；目录模式可缓存更久（5min）
    const cdnMaxAge = includeTags.length > 0 ? 60 : 300;

    return new Response(
      JSON.stringify({
        files: safeFiles,
        folders: filteredFolders,
        totalCount: (search || fileType) ? filteredTotalCount : cachedData.totalCount,
        returnedCount: safeFiles.length,
        allowedDirs: allowedDirs, // 返回允许的目录列表供前端使用
        fromCache: cachedData.fromCache,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
          // CF 边缘缓存（公开只读内容），命中后不消耗 Worker 请求额度
          'Cache-Control': `public, max-age=${cdnMaxAge}`,
          'CDN-Cache-Control': `public, max-age=${cdnMaxAge}`,
        },
      }
    );
  } catch (error: any) {
    console.error('Error in public list API:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }
}
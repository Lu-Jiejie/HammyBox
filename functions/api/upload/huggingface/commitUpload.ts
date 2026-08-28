/**
 * HuggingFace 大文件提交 API
 *
 * 在前端直接上传文件到 S3 后，调用此 API 提交 LFS 文件引用
 */

import { HuggingFaceAPI } from '../../../utils/storage/huggingfaceAPI.js';
import { fetchUploadConfig } from '../../../utils/sysConfig.js';
import { getDatabase } from '../../../utils/databaseAdapter.js';
import {
  endUpload,
  getUploadIp,
  getIPAddress,
  sanitizeUploadFolder,
  createResponse,
} from '../uploadTools.js';
import { userAuthCheck, UnauthorizedResponse } from '../../../utils/auth/userAuth.js';
import type { Env, PagesContext, FileMetadata } from '../../../types';

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);

  try {
    // 鉴权
    const requiredPermission = 'upload';
    if (!(await userAuthCheck(env as Env, request, requiredPermission))) {
      return UnauthorizedResponse('Unauthorized');
    }

    const body: any = await request.json();
    const { fullId, filePath, sha256, fileSize, fileName, fileType, channelName } = body;

    if (!fullId || !filePath || !sha256 || !fileSize) {
      return createResponse(
        JSON.stringify({
          error: 'Missing required fields: fullId, filePath, sha256, fileSize',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 路径安全处理：使用统一的路径安全函数
    const sanitizedFullId = sanitizeUploadFolder(fullId);
    if (sanitizedFullId !== fullId) {
      return createResponse(
        JSON.stringify({
          error: 'Invalid fullId: contains illegal path characters',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 获取 HuggingFace 配置
    const uploadConfig = await fetchUploadConfig(env as Env);
    const hfSettings = uploadConfig.huggingface;

    if (!hfSettings || !hfSettings.channels || hfSettings.channels.length === 0) {
      return createResponse(JSON.stringify({ error: 'No HuggingFace channel configured' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 选择渠道
    let hfChannel: any;
    if (channelName) {
      hfChannel = hfSettings.channels.find((c: any) => c.name === channelName);
    }
    if (!hfChannel) {
      hfChannel = hfSettings.channels[0];
    }

    if (!hfChannel || !hfChannel.token || !hfChannel.repo) {
      return createResponse(
        JSON.stringify({ error: 'HuggingFace channel not properly configured' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const huggingfaceAPI = new HuggingFaceAPI(
      hfChannel.token,
      hfChannel.repo,
      hfChannel.isPrivate || false
    );

    // 提交 LFS 文件引用
    console.log('Committing LFS file...');
    const commitResult = await huggingfaceAPI.commitLfsFile(
      filePath,
      sha256,
      fileSize,
      `Upload ${fileName || fullId}`
    );
    console.log('Commit result:', JSON.stringify(commitResult));

    // 构建文件 URL
    const fileUrl = `https://huggingface.co/datasets/${hfChannel.repo}/resolve/main/${filePath}`;

    // 从 fullId 中提取目录信息
    const dirParts = fullId.split('/').slice(0, -1).join('/');
    const normalizedDirectory = dirParts === '' ? '' : dirParts + '/';

    // 获取上传IP和地址
    const uploadIp = getUploadIp(request) || '';
    const uploadAddress = await getIPAddress(uploadIp);

    // 获取前端提交的标签（可选）
    const uploadTags = url.searchParams.get('tags');
    let tagsArray: string[] = [];
    if (uploadTags) {
      tagsArray = uploadTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    }

    // 构建 metadata
    const metadata: FileMetadata = {
      FileName: fileName || fullId,
      FileType: fileType || '',
      Channel: 'HuggingFace',
      ChannelName: hfChannel.name || 'HuggingFace_env',
      FileSize: (fileSize / 1024 / 1024).toFixed(2),
      FileSizeBytes: fileSize,
      HfFilePath: filePath,
      TimeStamp: Date.now(),
      Folder: normalizedDirectory,
      Tags: tagsArray,
    };

    // 写入数据库
    const db = getDatabase(env as Env);
    await db.put(fullId, '', { metadata });

    // 结束上传（更新索引等）
    const uploadContext = {
      env: env as Env,
      waitUntil,
      uploadConfig,
      url,
    } as unknown as PagesContext;
    waitUntil(endUpload(uploadContext, fullId, metadata));

    // 返回成功响应
    const returnLink = `/api/file/${fullId}`;
    return createResponse(
      JSON.stringify({
        success: true,
        data: {
          src: returnLink,
          fileId: fullId,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('commitUpload error:', error.message);
    return createResponse(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
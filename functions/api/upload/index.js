import { userAuthCheck, UnauthorizedResponse } from "../../utils/auth/userAuth";
import { fetchUploadConfig, fetchSecurityConfig } from "../../utils/sysConfig";
import {
    createResponse, createErrorResponse, getUploadIp, resolveFileExt,
    purgeCDNCache, isBlockedUploadIp, buildUniqueFileId, endUpload, getImageDimensions,
    sanitizeUploadFolder
} from "./uploadTools";
import { initializeChunkedUpload, handleChunkUpload, uploadLargeFileToTelegram, handleCleanupRequest } from "./chunkUpload";
import { handleChunkMerge } from "./chunkMerge";
import { TelegramAPI } from "../../utils/storage/telegramAPI";
import { DiscordAPI } from "../../utils/storage/discordAPI";
import { HuggingFaceAPI } from "../../utils/storage/huggingfaceAPI";
import { WebDAVAPI } from "../../utils/storage/webdavAPI";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getDatabase } from '../../utils/databaseAdapter.js';


export async function onRequest(context) {  // Contents of context object
    const { request, env, params, waitUntil, next, data } = context;

    // 解析请求的URL，存入 context
    const url = new URL(request.url);
    context.url = url;

    // 读取各项配置，存入 context
    const securityConfig = await fetchSecurityConfig(env);
    const uploadConfig = await fetchUploadConfig(env, context);

    context.securityConfig = securityConfig;
    context.uploadConfig = uploadConfig;

    // 鉴权
    const requiredPermission = 'upload';
    if (!await userAuthCheck(env, request, requiredPermission)) {
        return UnauthorizedResponse('Unauthorized');
    }

    // 获得上传IP
    const uploadIp = getUploadIp(request);
    // 判断上传ip是否被封禁
    const isBlockedIp = await isBlockedUploadIp(env, uploadIp);
    if (isBlockedIp) {
        return createErrorResponse('Your IP is blocked', 'IP_BLOCKED', 403);
    }

    // 检查是否为清理请求
    const cleanupRequest = url.searchParams.get('cleanup') === 'true';
    if (cleanupRequest) {
        const uploadId = url.searchParams.get('uploadId');
        const totalChunks = parseInt(url.searchParams.get('totalChunks')) || 0;
        return await handleCleanupRequest(context, uploadId, totalChunks);
    }

    // 检查是否为初始化分块上传请求
    const initChunked = url.searchParams.get('initChunked') === 'true';
    if (initChunked) {
        return await initializeChunkedUpload(context);
    }

    // 检查是否为分块上传
    const isChunked = url.searchParams.get('chunked') === 'true';
    const isMerge = url.searchParams.get('merge') === 'true';

    if (isChunked) {
        if (isMerge) {
            return await handleChunkMerge(context);
        } else {
            return await handleChunkUpload(context);
        }
    }

    // 处理非分块文件上传
    return await processFileUpload(context);
}


// 通用文件上传处理函数
async function processFileUpload(context, formdata = null) {
    const { request, url } = context;

    // 解析表单数据
    formdata = formdata || await request.formData();

    // 将 formdata 存储在 context 中
    context.formdata = formdata;

    // 获得上传渠道类型
    const urlParamUploadChannel = url.searchParams.get('uploadChannel');
    // 获得指定的渠道名称（可选）
    const urlParamChannelName = url.searchParams.get('channelName');

    // 获取IP地址
    const uploadIp = getUploadIp(request);

    // 获取上传文件夹路径（默认为空字符串，表示根目录）
    let uploadFolder = url.searchParams.get('uploadFolder') || '';

    // 路径安全性处理：防止路径穿越和特殊字符注入
    uploadFolder = sanitizeUploadFolder(uploadFolder);

    // 验证目标文件夹是否存在
    const db = getDatabase(context.env);

    // 根目录特殊处理：空字符串表示根目录，始终存在
    if (uploadFolder !== '') {
        // 确保路径格式一致：文件夹 key 格式为 "folder:path/"（带末尾斜杠）
        const folderPath = uploadFolder.endsWith('/') ? uploadFolder : uploadFolder + '/';
        const folderKey = `folder:${folderPath}`;

        console.log('Checking folder existence:', {
            uploadFolder,
            folderPath,
            folderKey
        });

        // Debug: 列出所有 folder: 前缀的 key
        const allFolders = await db.list({ prefix: 'folder:' });
        console.log('All folder keys in DB:', allFolders.keys.map(k => k.name));

        const folderExists = await db.get(folderKey);

        console.log('Folder check result:', {
            value: folderExists,
            type: typeof folderExists,
            isNull: folderExists === null,
            isUndefined: folderExists === undefined,
            truthyCheck: !!folderExists
        });

        // 注意：文件夹记录的 value 是空字符串 ''，不能用 truthy 判断
        // KV 不存在时返回 null，存在时返回存储的值（即使是空字符串）
        if (folderExists === null) {
            return createErrorResponse(
                `Target folder '${uploadFolder}' does not exist. Please create it first.`,
                'FOLDER_NOT_FOUND',
                400
            );
        }
    }

    let uploadChannel = 'Telegram';
    switch (urlParamUploadChannel) {
        case 'telegram':
            uploadChannel = 'Telegram';
            break;
        case 'cfr2':
            uploadChannel = 'CloudflareR2';
            break;
        case 's3':
            uploadChannel = 'S3';
            break;
        case 'discord':
            uploadChannel = 'Discord';
            break;
        case 'huggingface':
            uploadChannel = 'HuggingFace';
            break;
        case 'webdav':
            uploadChannel = 'WebDAV';
            break;
        case 'external':
            uploadChannel = 'External';
            break;
        default:
            uploadChannel = 'Telegram';
            break;
    }

    // 将指定的渠道名称存入 context，供后续上传函数使用
    context.specifiedChannelName = urlParamChannelName || null;

    // 获取前端提交的标签（可选）
    const uploadTags = url.searchParams.get('tags');
    let tagsArray = [];
    if (uploadTags) {
        // 支持逗号分隔的标签列表，去除空白并过滤空标签
        tagsArray = uploadTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    }

    // 获取文件信息
    const time = new Date().getTime();
    const file = formdata.get('file');
    const fileType = file.type;
    let fileName = file.name;
    const fileSizeBytes = file.size; // 文件大小，单位字节
    const fileSize = (fileSizeBytes / 1024 / 1024).toFixed(2); // 文件大小，单位MB

    // 检查fileType和fileName是否存在
    if (fileType === null || fileType === undefined || fileName === null || fileName === undefined) {
        return createErrorResponse('fileType or fileName is wrong, check the integrity of this file', 'INVALID_FILE', 400);
    }

    // 提取图片尺寸
    let imageDimensions = null;
    if (fileType.startsWith('image/')) {
        try {
            // 统一读取 64KB，足以覆盖 JPEG 的 EXIF 数据和其他格式
            const headerBuffer = await file.slice(0, 65536).arrayBuffer();
            imageDimensions = getImageDimensions(headerBuffer, fileType);
        } catch (error) {
            console.error('Error reading image dimensions:', error);
        }
    }

    // uploadFolder 已经过验证和 sanitizeUploadFolder 处理，直接使用
    const normalizedFolder = uploadFolder;

    const metadata = {
        FileName: fileName,
        FileType: fileType,
        FileSize: fileSize,
        FileSizeBytes: fileSizeBytes,
        TimeStamp: time,
        Folder: normalizedFolder === '' ? '' : normalizedFolder + '/',
        Tags: tagsArray
    };

    // 添加图片尺寸信息
    if (imageDimensions) {
        metadata.Width = imageDimensions.width;
        metadata.Height = imageDimensions.height;
    }

    const fileExt = resolveFileExt(fileName, fileType);

    // 构建文件ID
    const fullId = await buildUniqueFileId(context, fileName, fileType);

    // 获得返回链接格式, default为返回/api/file/id, full为返回完整链接
    const returnFormat = url.searchParams.get('returnFormat') || 'default';
    let returnLink = '';
    if (returnFormat === 'full') {
        returnLink = `${url.origin}/api/file/${fullId}`;
    } else {
        returnLink = `/api/file/${fullId}`;
    }

    /* ====================================不同渠道上传======================================= */
    // 直接上传到指定渠道，失败则返回错误（不自动切换渠道）
    if (uploadChannel === 'CloudflareR2') {
        // -------------CloudFlare R2 渠道---------------
        return await uploadFileToCloudflareR2(context, fullId, metadata, returnLink);
    } else if (uploadChannel === 'S3') {
        // ---------------------S3 渠道------------------
        return await uploadFileToS3(context, fullId, metadata, returnLink);
    } else if (uploadChannel === 'Discord') {
        // ---------------------Discord 渠道------------------
        return await uploadFileToDiscord(context, fullId, metadata, returnLink);
    } else if (uploadChannel === 'HuggingFace') {
        // ---------------------HuggingFace 渠道------------------
        return await uploadFileToHuggingFace(context, fullId, metadata, returnLink);
    } else if (uploadChannel === 'WebDAV') {
        // ---------------------WebDAV 渠道------------------
        return await uploadFileToWebDAV(context, fullId, metadata, returnLink);
    } else if (uploadChannel === 'External') {
        // --------------------外链渠道----------------------
        return await uploadFileToExternal(context, fullId, metadata, returnLink);
    } else {
        // ----------------Telegram New 渠道-------------------
        return await uploadFileToTelegram(context, fullId, metadata, fileExt, fileName, fileType, returnLink);
    }
}

// 上传到Cloudflare R2
async function uploadFileToCloudflareR2(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    // 检查R2数据库是否配置
    if (typeof env.hammybox_r2 == "undefined" || env.hammybox_r2 == null || env.hammybox_r2 == "") {
        return createErrorResponse('Please configure R2 database', 'R2_NOT_CONFIGURED', 500);
    }

    // 检查 R2 渠道是否启用
    const r2Settings = uploadConfig.cfr2;
    if (!r2Settings.channels || r2Settings.channels.length === 0) {
        return createErrorResponse('No R2 channel provided', 'R2_CHANNEL_NOT_AVAILABLE', 400);
    }

    // 选择渠道：优先使用指定的渠道名称
    let r2Channel;
    if (specifiedChannelName) {
        r2Channel = r2Settings.channels.find(ch => ch.name === specifiedChannelName);
    }
    if (!r2Channel) {
        r2Channel = r2Settings.channels[0];
    }

    const R2DataBase = env.hammybox_r2;

    // 写入R2数据库
    await R2DataBase.put(fullId, formdata.get('file'));

    // 更新metadata
    metadata.Channel = "CloudflareR2";
    metadata.ChannelName = r2Channel.name || "R2_env";

    // 写入数据库
    try {
        await db.put(fullId, "", {
            metadata: metadata,
        });
    } catch (error) {
        return createErrorResponse('Failed to write to database', 'DATABASE_WRITE_FAILED', 500);
    }

    // 结束上传
    waitUntil(endUpload(context, fullId, metadata));

    // 成功上传，将文件ID返回给客户端
    return createResponse(
        JSON.stringify({
            success: true,
            data: {
                src: returnLink,
                fileId: fullId
            }
        }),
        {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            }
        }
    );
}


// 上传到 S3（支持自定义端点）
async function uploadFileToS3(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, securityConfig, url, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    const uploadModerate = securityConfig.upload.moderate;

    const s3Settings = uploadConfig.s3;
    const s3Channels = s3Settings.channels;
    
    // 选择渠道：优先使用指定的渠道名称
    let s3Channel;
    if (specifiedChannelName) {
        s3Channel = s3Channels.find(ch => ch.name === specifiedChannelName);
    }
    if (!s3Channel) {
        s3Channel = s3Settings.loadBalance.enabled
            ? s3Channels[Math.floor(Math.random() * s3Channels.length)]
            : s3Channels[0];
    }

    if (!s3Channel) {
        return createErrorResponse('No S3 channel provided', 'S3_CHANNEL_NOT_AVAILABLE', 400);
    }

    const { endpoint, pathStyle, accessKeyId, secretAccessKey, bucketName, region } = s3Channel;

    // 创建 S3 客户端
    const s3Client = new S3Client({
        region: region || "auto", // R2 可用 "auto"
        endpoint, // 自定义 S3 端点
        credentials: {
            accessKeyId,
            secretAccessKey
        },
        forcePathStyle: pathStyle // 是否启用路径风格
    });

    // 获取文件
    const file = formdata.get("file");
    if (!file) return createErrorResponse('No file provided', 'FILE_MISSING', 400);

    // 转换 Blob 为 Uint8Array
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const s3FileName = fullId;

    try {
        // S3 上传参数
        const putObjectParams = {
            Bucket: bucketName,
            Key: s3FileName,
            Body: uint8Array, // 直接使用 Blob
            ContentType: file.type
        };

        // 执行上传
        await s3Client.send(new PutObjectCommand(putObjectParams));

        // 更新 metadata
        metadata.Channel = "S3";
        metadata.ChannelName = s3Channel.name;
        metadata.S3FileKey = s3FileName;

        // 写入数据库
        try {
            await db.put(fullId, "", { metadata });
        } catch {
            return createErrorResponse('Failed to write to database', 'DATABASE_WRITE_FAILED', 500);
        }

        // 结束上传
        waitUntil(endUpload(context, fullId, metadata));

        return createResponse(JSON.stringify({
            success: true,
            data: {
                src: returnLink,
                fileId: fullId
            }
        }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
            },
        });
    } catch (error) {
        return createErrorResponse(`Failed to upload to S3 - ${error.message}`, 'S3_UPLOAD_FAILED', 500);
    }
}


// 上传到Telegram
async function uploadFileToTelegram(context, fullId, metadata, fileExt, fileName, fileType, returnLink) {
    const { env, waitUntil, uploadConfig, url, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    // 选择一个 Telegram 渠道上传
    const tgSettings = uploadConfig.telegram;
    const tgChannels = tgSettings.channels;
    
    let tgChannel;
    // 如果指定了渠道名称，优先使用指定的渠道
    if (specifiedChannelName) {
        tgChannel = tgChannels.find(ch => ch.name === specifiedChannelName);
    }
    // 未指定或未找到指定渠道，使用负载均衡或第一个
    if (!tgChannel) {
        tgChannel = tgSettings.loadBalance.enabled ? tgChannels[Math.floor(Math.random() * tgChannels.length)] : tgChannels[0];
    }
    if (!tgChannel) {
        return createErrorResponse('No Telegram channel provided', 'TELEGRAM_CHANNEL_NOT_AVAILABLE', 400);
    }

    const tgBotToken = tgChannel.botToken;
    const tgChatId = tgChannel.chatId;
    const tgProxyUrl = tgChannel.proxyUrl || '';
    const file = formdata.get('file');
    const fileSize = file.size;

    const telegramAPI = new TelegramAPI(tgBotToken, tgProxyUrl);

    // 16MB 分片阈值 (TG Bot getFile download limit: 20MB, leave 4MB safety margin)
    const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB

    if (fileSize > CHUNK_SIZE) {
        // 大文件分片上传
        return await uploadLargeFileToTelegram(context, file, fullId, metadata, fileName, fileType, returnLink, tgBotToken, tgChatId, tgChannel);
    }

    // 由于TG会把gif后缀的文件转为视频，所以需要修改后缀名绕过限制
    if (fileExt === 'gif') {
        const newFileName = fileName.replace(/\.gif$/, '.jpeg');
        const newFile = new File([formdata.get('file')], newFileName, { type: fileType });
        formdata.set('file', newFile);
    } else if (fileExt === 'webp') {
        const newFileName = fileName.replace(/\.webp$/, '.jpeg');
        const newFile = new File([formdata.get('file')], newFileName, { type: fileType });
        formdata.set('file', newFile);
    }

    // 选择对应的发送接口
    const fileTypeMap = {
        'image/': { 'url': 'sendPhoto', 'type': 'photo' },
        'video/': { 'url': 'sendVideo', 'type': 'video' },
        'audio/': { 'url': 'sendAudio', 'type': 'audio' },
        'application/pdf': { 'url': 'sendDocument', 'type': 'document' },
    };

    const defaultType = { 'url': 'sendDocument', 'type': 'document' };

    let sendFunction = Object.keys(fileTypeMap).find(key => fileType.startsWith(key))
        ? fileTypeMap[Object.keys(fileTypeMap).find(key => fileType.startsWith(key))]
        : defaultType;

    // GIF ICO 等发送接口特殊处理
    if (fileType === 'image/gif' || fileType === 'image/webp' || fileExt === 'gif' || fileExt === 'webp') {
        sendFunction = { 'url': 'sendAnimation', 'type': 'animation' };
    } else if (fileType === 'image/svg+xml' || fileType === 'image/x-icon') {
        sendFunction = { 'url': 'sendDocument', 'type': 'document' };
    }

    // 根据服务端压缩设置处理接口：从参数中获取serverCompress，如果为false，则使用sendDocument接口
    if (url.searchParams.get('serverCompress') === 'false') {
        sendFunction = { 'url': 'sendDocument', 'type': 'document' };
    }

    // 文件大小和尺寸限制检查：sendPhoto/sendAnimation 最大 10MB，且宽+高 ≤ 10000
    console.log(`[Telegram] File size: ${fileSize}, sendFunction: ${sendFunction.url}`);
    if (sendFunction.url === 'sendPhoto' || sendFunction.url === 'sendAnimation') {
        // 检查文件大小
        if (fileSize > 10 * 1024 * 1024) {
            console.log(`[Telegram] File too large (${fileSize} bytes), switching to sendDocument`);
            sendFunction = { 'url': 'sendDocument', 'type': 'document' };
        }
        // 检查图片尺寸（Telegram 限制：宽+高 ≤ 10000）
        else if (metadata.Width && metadata.Height && (metadata.Width + metadata.Height > 10000)) {
            console.log(`[Telegram] Image dimensions too large (${metadata.Width}x${metadata.Height}), switching to sendDocument`);
            sendFunction = { 'url': 'sendDocument', 'type': 'document' };
        }
    }

    // 上传文件到 Telegram
    let res = createErrorResponse('Telegram upload failed, check your environment params about telegram channel', 'TELEGRAM_UPLOAD_FAILED', 400);
    try {
        const response = await telegramAPI.sendFile(formdata.get('file'), tgChatId, sendFunction.url, sendFunction.type);
        const fileInfo = telegramAPI.getFileInfo(response);
        const filePath = await telegramAPI.getFilePath(fileInfo.file_id);
        const id = fileInfo.file_id;
        // 更新FileSize
        metadata.FileSize = (fileInfo.file_size / 1024 / 1024).toFixed(2);

        // 将响应返回给客户端
        res = createResponse(
            JSON.stringify({
                success: true,
                data: {
                    src: returnLink,
                    fileId: fullId
                }
            }),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                }
            }
        );


        // 更新metadata，写入KV数据库
        try {
            metadata.Channel = "Telegram";
            metadata.ChannelName = tgChannel.name;

            metadata.TgFileId = id;
            await db.put(fullId, "", {
                metadata: metadata,
            });
        } catch (error) {
            res = createErrorResponse('Failed to write to KV database', 'DATABASE_WRITE_FAILED', 500);
        }

        // 结束上传
        waitUntil(endUpload(context, fullId, metadata));

    } catch (error) {
        console.error('Telegram upload error:', error);
        res = createErrorResponse(
            `Telegram upload failed: ${error.message || 'Unknown error'}`,
            'TELEGRAM_UPLOAD_FAILED',
            500
        );
    } finally {
        return res;
    }
}


// 外链渠道
async function uploadFileToExternal(context, fullId, metadata, returnLink) {
    const { env, waitUntil, formdata } = context;
    const db = getDatabase(env);

    // 直接将外链写入metadata
    metadata.Channel = "External";
    metadata.ChannelName = "External";
    // 从 formdata 中获取外链
    const extUrl = formdata.get('url');
    if (extUrl === null || extUrl === undefined) {
        return createErrorResponse('No url provided', 'URL_MISSING', 400);
    }
    metadata.ExternalLink = extUrl;
    // 写入KV数据库
    try {
        await db.put(fullId, "", {
            metadata: metadata,
        });
    } catch (error) {
        return createErrorResponse('Failed to write to KV database', 'DATABASE_WRITE_FAILED', 500);
    }

    // 结束上传
    waitUntil(endUpload(context, fullId, metadata));

    // 返回结果
    return createResponse(
        JSON.stringify({
            success: true,
            data: {
                src: returnLink,
                fileId: fullId
            }
        }),
        {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            }
        }
    );
}


// 上传到 Discord
async function uploadFileToDiscord(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    // 获取 Discord 渠道配置
    const discordSettings = uploadConfig.discord;
    if (!discordSettings || !discordSettings.channels || discordSettings.channels.length === 0) {
        return createErrorResponse('No Discord channel configured', 'DISCORD_CHANNEL_NOT_AVAILABLE', 400);
    }

    // 选择渠道：优先使用指定的渠道名称
    const discordChannels = discordSettings.channels;
    let discordChannel;
    if (specifiedChannelName) {
        discordChannel = discordChannels.find(ch => ch.name === specifiedChannelName);
    }
    if (!discordChannel) {
        discordChannel = discordSettings.loadBalance?.enabled
            ? discordChannels[Math.floor(Math.random() * discordChannels.length)]
            : discordChannels[0];
    }

    if (!discordChannel || !discordChannel.botToken || !discordChannel.channelId) {
        return createErrorResponse('Discord channel not properly configured', 'DISCORD_CHANNEL_MISCONFIGURED', 400);
    }

    const file = formdata.get('file');
    const fileSize = file.size;
    const fileName = metadata.FileName;

    // Discord 文件大小限制：Nitro 会员 25MB，免费用户 10MB
    const isNitro = discordChannel.isNitro || false;
    const DISCORD_MAX_SIZE = isNitro ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
    if (fileSize > DISCORD_MAX_SIZE) {
        const limitMB = isNitro ? 25 : 10;
        return createErrorResponse(`File size exceeds Discord limit (${limitMB}MB), please use another channel`, 'FILE_TOO_LARGE', 413);
    }

    const discordAPI = new DiscordAPI(discordChannel.botToken);

    try {
        // 上传文件到 Discord
        const response = await discordAPI.sendFile(file, discordChannel.channelId, fileName);
        const fileInfo = discordAPI.getFileInfo(response);

        if (!fileInfo) {
            throw new Error('Failed to get file info from Discord response');
        }

        // 更新 metadata
        metadata.Channel = "Discord";
        metadata.ChannelName = discordChannel.name || "Discord_env";
        metadata.FileSize = (fileInfo.file_size / 1024 / 1024).toFixed(2);
        metadata.DiscordMessageId = fileInfo.message_id;
        // 注意：不存储 DiscordAttachmentUrl，因为 Discord 附件 URL 会在约24小时后过期
        // 读取时会通过 API 获取新的 URL

        // 写入 KV 数据库
        try {
            await db.put(fullId, "", { metadata });
        } catch (error) {
            return createErrorResponse('Failed to write to KV database', 'DATABASE_WRITE_FAILED', 500);
        }

        // 结束上传
        waitUntil(endUpload(context, fullId, metadata));

        // 返回成功响应
        return createResponse(
            JSON.stringify({
                success: true,
                data: {
                    src: returnLink,
                    fileId: fullId
                }
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        console.error('Discord upload error:', error.message);
        return createErrorResponse(`Discord upload failed - ${error.message}`, 'DISCORD_UPLOAD_FAILED', 500);
    }
}


// 上传到 HuggingFace
async function uploadFileToHuggingFace(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    console.log('=== HuggingFace Upload Start ===');

    // 获取 HuggingFace 渠道配置
    const hfSettings = uploadConfig.huggingface;
    console.log('HuggingFace settings:', hfSettings ? 'found' : 'not found');

    if (!hfSettings || !hfSettings.channels || hfSettings.channels.length === 0) {
        console.log('Error: No HuggingFace channel configured');
        return createErrorResponse('No HuggingFace channel configured', 'HUGGINGFACE_CHANNEL_NOT_AVAILABLE', 400);
    }

    // 选择渠道：优先使用指定的渠道名称
    const hfChannels = hfSettings.channels;
    console.log('HuggingFace channels count:', hfChannels.length);

    let hfChannel;
    if (specifiedChannelName) {
        hfChannel = hfChannels.find(ch => ch.name === specifiedChannelName);
    }
    if (!hfChannel) {
        hfChannel = hfSettings.loadBalance?.enabled
            ? hfChannels[Math.floor(Math.random() * hfChannels.length)]
            : hfChannels[0];
    }

    console.log('Selected channel:', hfChannel?.name, 'repo:', hfChannel?.repo);

    if (!hfChannel || !hfChannel.token || !hfChannel.repo) {
        console.log('Error: HuggingFace channel not properly configured', {
            hasChannel: !!hfChannel,
            hasToken: !!hfChannel?.token,
            hasRepo: !!hfChannel?.repo
        });
        return createErrorResponse('HuggingFace channel not properly configured', 'HUGGINGFACE_CHANNEL_MISCONFIGURED', 400);
    }

    const file = formdata.get('file');
    const fileName = metadata.FileName;
    // 获取前端预计算的 SHA256（如果有）
    const precomputedSha256 = formdata.get('sha256') || null;
    console.log('File to upload:', fileName, 'size:', file?.size, 'precomputed SHA256:', precomputedSha256 ? 'yes' : 'no');

    // 生成唯一标识符前缀（UUID格式），加在文件名前面
    const uniquePrefix = crypto.randomUUID();
    const lastSlashIndex = fullId.lastIndexOf('/');
    const hfFilePath = lastSlashIndex === -1 
        ? `${uniquePrefix}_${fullId}` 
        : `${fullId.substring(0, lastSlashIndex + 1)}${uniquePrefix}_${fullId.substring(lastSlashIndex + 1)}`;
    console.log('HuggingFace file path:', hfFilePath);

    const huggingfaceAPI = new HuggingFaceAPI(hfChannel.token, hfChannel.repo, hfChannel.isPrivate || false);

    try {
        // 上传文件到 HuggingFace（传入预计算的 SHA256）
        console.log('Starting HuggingFace upload...');
        const result = await huggingfaceAPI.uploadFile(file, hfFilePath, `Upload ${fileName}`, precomputedSha256);
        console.log('HuggingFace upload result:', result);

        if (!result.success) {
            throw new Error('Failed to upload file to HuggingFace');
        }

        // 更新 metadata
        metadata.Channel = "HuggingFace";
        metadata.ChannelName = hfChannel.name || "HuggingFace_env";
        metadata.HfFilePath = hfFilePath;

        // 写入 KV 数据库
        try {
            await db.put(fullId, "", { metadata });
        } catch (error) {
            return createErrorResponse('Failed to write to KV database', 'DATABASE_WRITE_FAILED', 500);
        }

        // 结束上传
        waitUntil(endUpload(context, fullId, metadata));

        // 返回成功响应
        return createResponse(
            JSON.stringify({
                success: true,
                data: {
                    src: returnLink,
                    fileId: fullId
                }
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        console.error('HuggingFace upload error:', error.message);
        return createErrorResponse(`HuggingFace upload failed - ${error.message}`, 'HUGGINGFACE_UPLOAD_FAILED', 500);
    }
}


// 上传到 WebDAV
async function uploadFileToWebDAV(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, securityConfig, url, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    const webdavSettings = uploadConfig.webdav;
    if (!webdavSettings || !webdavSettings.channels || webdavSettings.channels.length === 0) {
        return createErrorResponse('No WebDAV channel configured', 'WEBDAV_CHANNEL_NOT_AVAILABLE', 400);
    }

    const webdavChannels = webdavSettings.channels;
    let webdavChannel;
    if (specifiedChannelName) {
        webdavChannel = webdavChannels.find(ch => ch.name === specifiedChannelName);
    }
    if (!webdavChannel) {
        webdavChannel = webdavSettings.loadBalance?.enabled
            ? webdavChannels[Math.floor(Math.random() * webdavChannels.length)]
            : webdavChannels[0];
    }

    if (!webdavChannel || !webdavChannel.baseUrl) {
        return createErrorResponse('WebDAV channel not properly configured', 'WEBDAV_CHANNEL_MISCONFIGURED', 400);
    }

    const file = formdata.get('file');
    if (!file) {
        return createErrorResponse('No file provided', 'FILE_MISSING', 400);
    }

    try {
        const webdavAPI = new WebDAVAPI(webdavChannel);
        await webdavAPI.putFile(fullId, file, file.type || metadata.FileType || 'application/octet-stream');

        metadata.Channel = "WebDAV";
        metadata.ChannelName = webdavChannel.name || "WebDAV_env";
        metadata.WebDAVFilePath = fullId;

        try {
            await db.put(fullId, "", { metadata });
        } catch {
            return createErrorResponse('Failed to write to database', 'DATABASE_WRITE_FAILED', 500);
        }

        waitUntil(endUpload(context, fullId, metadata));

        return createResponse(
            JSON.stringify({
                success: true,
                data: {
                    src: returnLink,
                    fileId: fullId
                }
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('WebDAV upload error:', error.message);
        return createErrorResponse(`WebDAV upload failed - ${error.message}`, 'WEBDAV_UPLOAD_FAILED', 500);
    }
}

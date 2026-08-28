/* 索引管理器 */

/**
 * 文件索引结构（分块存储）：
 *
 * 索引元数据：
 * - key: manage@index@meta
 * - value: JSON.stringify(metadata)
 * - metadata: {
 *     lastUpdated: 1640995200000,
 *     totalCount: 1000,
 *     lastOperationId: "operation_timestamp_uuid",
 *     chunkCount: 3,
 *     chunkSize: 10000
 *   }
 *
 * 索引分块：
 * - key: manage@index_${chunkId} (例如: manage@index_0, manage@index_1, ...)
 * - value: JSON.stringify(filesChunk)
 * - filesChunk: [
 *     {
 *       id: "file_unique_id",
 *       metadata: {}
 *     },
 *     ...
 *   ]
 *
 * 原子操作结构（保持不变）：
 * - key: manage@index@operation_${timestamp}_${uuid}
 * - value: JSON.stringify(operation)
 * - operation: {
 *     type: "add" | "remove" | "move" | "batch_add" | "batch_remove" | "batch_move",
 *     timestamp: 1640995200000,
 *     data: {
 *       // 根据操作类型包含不同的数据
 *     }
 *   }
 */

import { getDatabase, checkDatabaseConfig } from './databaseAdapter.js';
import { fetchSecurityConfig } from './sysConfig.js';
import type { FileMetadata, Env, IndexFileEntry, DatabaseAdapter } from '../types';
import {
  incrementStat,
  normalizeChannel,
  createUploadTrendAccumulator,
  addUploadTrendPoint,
  finalizeUploadTrend,
  type TrendOptions,
} from './indexTrend.js';

const INDEX_KEY = 'manage@index';
const INDEX_META_KEY = 'manage@index@meta'; // 索引元数据键
const OPERATION_KEY_PREFIX = 'manage@index@operation_';
// D1 单字段限制 2MB，KV 限制 25MB，根据数据库类型动态设置
const INDEX_CHUNK_SIZE_D1 = 500; // D1 数据库分块大小
const INDEX_CHUNK_SIZE_KV = 5000; // KV 存储分块大小
const KV_LIST_LIMIT = 1000; // 数据库列出批量大小
const BATCH_SIZE = 10; // 批量处理大小

/**
 * 索引上下文（包含 env 与其他信息）
 */
interface IndexContext {
  env: Env;
  waitUntil?: (promise: Promise<unknown>) => void;
  request?: Request;
}

/**
 * 索引对象（分块加载后的完整索引）
 */
interface IndexObject {
  files: IndexFileEntry[];
  lastUpdated: number;
  totalCount: number;
  lastOperationId: string | null;
  success?: boolean;
}

/**
 * 原子操作记录（含 id）
 */
interface OperationRecord {
  id?: string;
  type: string;
  timestamp: number;
  data: Record<string, any>;
}

/**
 * 根据数据库类型获取索引分块大小
 * @param env - 环境变量
 * @returns 分块大小
 */
export function getIndexChunkSize(env: Env): number {
  const config = checkDatabaseConfig(env);
  return config.usingD1 ? INDEX_CHUNK_SIZE_D1 : INDEX_CHUNK_SIZE_KV;
}

/**
 * 添加文件到索引
 * @param context - 上下文对象，包含 env 和其他信息
 * @param fileId - 文件 ID
 * @param metadata - 文件元数据
 */
export async function addFileToIndex(
  context: IndexContext,
  fileId: string,
  metadata: FileMetadata | null = null,
): Promise<{ success: boolean; operationId?: string; error?: string }> {
  const { env } = context;
  const db = getDatabase(env);

  try {
    if (metadata === null) {
      // 如果未传入metadata，尝试从数据库中获取
      const fileData = await db.getWithMetadata(fileId);
      metadata = (fileData?.metadata as FileMetadata) || {};
    }

    // 记录原子操作
    const operationId = await recordOperation(context, 'add', {
      fileId,
      metadata,
    });

    console.log(`File ${fileId} add operation recorded with ID: ${operationId}`);
    return { success: true, operationId };
  } catch (error: any) {
    console.error('Error recording add file operation:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 批量添加文件到索引
 * @param context - 上下文对象，包含 env 和其他信息
 * @param files - 文件数组，每个元素包含 { fileId, metadata }
 * @param options - 选项
 * @param options.skipExisting - 是否跳过已存在的文件，默认为 false（更新已存在的文件）
 * @returns 返回操作结果 { operationId, totalProcessed }
 */
export async function batchAddFilesToIndex(
  context: IndexContext,
  files: Array<{ fileId: string; metadata?: FileMetadata }>,
  options: { skipExisting?: boolean } = {},
): Promise<{ success: boolean; operationId?: string; totalProcessed: number; error?: string }> {
  try {
    const { env } = context;
    const { skipExisting = false } = options;
    const db = getDatabase(env);

    // 处理每个文件的metadata
    const processedFiles: Array<{ fileId: string; metadata: FileMetadata }> = [];
    for (const fileItem of files) {
      const { fileId, metadata } = fileItem;
      let finalMetadata = metadata;

      // 如果没有提供metadata，尝试从数据库中获取
      if (!finalMetadata) {
        try {
          const fileData = await db.getWithMetadata(fileId);
          finalMetadata = (fileData?.metadata as FileMetadata) || {};
        } catch (error) {
          console.warn(`Failed to get metadata for file ${fileId}:`, error);
          finalMetadata = {};
        }
      }

      processedFiles.push({
        fileId,
        metadata: finalMetadata,
      });
    }

    // 记录批量添加操作
    const operationId = await recordOperation(context, 'batch_add', {
      files: processedFiles,
      options: { skipExisting },
    });

    console.log(`Batch add operation recorded with ID: ${operationId}, ${files.length} files`);
    return {
      success: true,
      operationId,
      totalProcessed: files.length,
    };
  } catch (error: any) {
    console.error('Error recording batch add files operation:', error);
    return {
      success: false,
      error: error.message,
      totalProcessed: 0,
    };
  }
}

/**
 * 从索引中删除文件
 * @param context - 上下文对象
 * @param fileId - 文件 ID
 */
export async function removeFileFromIndex(
  context: IndexContext,
  fileId: string,
): Promise<{ success: boolean; operationId?: string; error?: string }> {
  try {
    // 记录删除操作
    const operationId = await recordOperation(context, 'remove', {
      fileId,
    });

    console.log(`File ${fileId} remove operation recorded with ID: ${operationId}`);
    return { success: true, operationId };
  } catch (error: any) {
    console.error('Error recording remove file operation:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 批量删除文件
 * @param context - 上下文对象
 * @param fileIds - 文件 ID 数组
 */
export async function batchRemoveFilesFromIndex(
  context: IndexContext,
  fileIds: string[],
): Promise<{ success: boolean; operationId?: string; totalProcessed: number; error?: string }> {
  try {
    // 记录批量删除操作
    const operationId = await recordOperation(context, 'batch_remove', {
      fileIds,
    });

    console.log(`Batch remove operation recorded with ID: ${operationId}, ${fileIds.length} files`);
    return {
      success: true,
      operationId,
      totalProcessed: fileIds.length,
    };
  } catch (error: any) {
    console.error('Error recording batch remove files operation:', error);
    return {
      success: false,
      error: error.message,
      totalProcessed: 0,
    };
  }
}

/**
 * 移动文件（修改文件ID）
 * @param context - 上下文对象，包含 env 和其他信息
 * @param originalFileId - 原文件 ID
 * @param newFileId - 新文件 ID
 * @param newMetadata - 新的元数据，如果为null则获取原文件的metadata
 * @returns 返回操作结果 { success, operationId?, error? }
 */
export async function moveFileInIndex(
  context: IndexContext,
  originalFileId: string,
  newFileId: string,
  newMetadata: FileMetadata | null = null,
): Promise<{ success: boolean; operationId?: string; error?: string }> {
  try {
    const { env } = context;
    const db = getDatabase(env);

    // 确定最终的metadata
    let finalMetadata = newMetadata;
    if (finalMetadata === null) {
      // 如果没有提供新metadata，尝试从数据库中获取
      try {
        const fileData = await db.getWithMetadata(newFileId);
        finalMetadata = (fileData?.metadata as FileMetadata) || {};
      } catch (error) {
        console.warn(`Failed to get metadata for new file ${newFileId}:`, error);
        finalMetadata = {};
      }
    }

    // 记录移动操作
    const operationId = await recordOperation(context, 'move', {
      originalFileId,
      newFileId,
      metadata: finalMetadata,
    });

    console.log(`File move operation from ${originalFileId} to ${newFileId} recorded with ID: ${operationId}`);
    return { success: true, operationId };
  } catch (error: any) {
    console.error('Error recording move file operation:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 批量移动文件
 * @param context - 上下文对象，包含 env 和其他信息
 * @param moveOperations - 移动操作数组，每个元素包含 { originalFileId, newFileId, metadata }
 * @returns 返回操作结果 { success, operationId?, totalProcessed }
 */
export async function batchMoveFilesInIndex(
  context: IndexContext,
  moveOperations: Array<{ originalFileId: string; newFileId: string; metadata?: FileMetadata }>,
): Promise<{ success: boolean; operationId?: string; totalProcessed: number; error?: string }> {
  try {
    const { env } = context;
    const db = getDatabase(env);

    // 处理每个操作的metadata
    const processedOperations: Array<{ originalFileId: string; newFileId: string; metadata: FileMetadata }> = [];
    for (const moveOp of moveOperations) {
      const { originalFileId, newFileId, metadata } = moveOp;
      let finalMetadata = metadata;

      // 如果没有提供metadata，尝试从数据库中获取
      if (!finalMetadata) {
        try {
          const fileData = await db.getWithMetadata(newFileId);
          finalMetadata = (fileData?.metadata as FileMetadata) || {};
        } catch (error) {
          console.warn(`Failed to get metadata for new file ${newFileId}:`, error);
          finalMetadata = {};
        }
      }

      processedOperations.push({
        originalFileId,
        newFileId,
        metadata: finalMetadata,
      });
    }

    // 记录批量移动操作
    const operationId = await recordOperation(context, 'batch_move', {
      operations: processedOperations,
    });

    console.log(`Batch move operation recorded with ID: ${operationId}, ${moveOperations.length} operations`);
    return {
      success: true,
      operationId,
      totalProcessed: moveOperations.length,
    };
  } catch (error: any) {
    console.error('Error recording batch move files operation:', error);
    return {
      success: false,
      error: error.message,
      totalProcessed: 0,
    };
  }
}

/**
 * 合并所有挂起的操作到索引中
 * @param context - 上下文对象
 * @param options - 选项
 * @param options.cleanupAfterMerge - 合并后是否清理操作记录，默认为 true
 * @returns 合并结果
 */
export async function mergeOperationsToIndex(
  context: IndexContext,
  options: { cleanupAfterMerge?: boolean } = {},
): Promise<Record<string, any>> {
  const { request } = context;
  const { cleanupAfterMerge = true } = options;

  try {
    console.log('Starting operations merge...');

    // 获取当前索引
    const currentIndex = await getIndex(context);
    if (currentIndex.success === false) {
      console.error('Failed to get current index for merge');
      return {
        success: false,
        error: 'Failed to get current index',
      };
    }

    // 获取所有待处理的操作
    const operationsResult = await getAllPendingOperations(context, currentIndex.lastOperationId);

    const operations = operationsResult.operations;
    const isALLOperations = operationsResult.isAll;

    if (operations.length === 0) {
      console.log('No pending operations to merge');
      return {
        success: true,
        processedOperations: 0,
        message: 'No pending operations',
      };
    }

    console.log(
      `Found ${operations.length} pending operations to merge. Is all operations: ${isALLOperations}, if there are remaining operations they will be processed in the next merge.`
    );

    // 按时间戳排序操作，确保按正确顺序应用
    operations.sort((a, b) => a.timestamp - b.timestamp);

    // 创建索引的副本进行操作
    const workingIndex: IndexObject = currentIndex as IndexObject;
    let operationsProcessed = 0;
    let addedCount = 0;
    let removedCount = 0;
    let movedCount = 0;
    let updatedCount = 0;
    const processedOperationIds: string[] = [];

    // 应用每个操作
    for (const operation of operations) {
      try {
        switch (operation.type) {
          case 'add': {
            const addResult = applyAddOperation(workingIndex, operation.data);
            if (addResult.added) addedCount++;
            if (addResult.updated) updatedCount++;
            break;
          }

          case 'remove':
            if (applyRemoveOperation(workingIndex, operation.data)) {
              removedCount++;
            }
            break;

          case 'move':
            if (applyMoveOperation(workingIndex, operation.data)) {
              movedCount++;
            }
            break;

          case 'batch_add': {
            const batchAddResult = applyBatchAddOperation(workingIndex, operation.data);
            addedCount += batchAddResult.addedCount;
            updatedCount += batchAddResult.updatedCount;
            break;
          }

          case 'batch_remove':
            removedCount += applyBatchRemoveOperation(workingIndex, operation.data);
            break;

          case 'batch_move':
            movedCount += applyBatchMoveOperation(workingIndex, operation.data);
            break;

          default:
            console.warn(`Unknown operation type: ${operation.type}`);
            continue;
        }

        operationsProcessed++;
        processedOperationIds.push(operation.id as string);

        // 增加协作点
        if (operationsProcessed % 3 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } catch (error) {
        console.error(`Error applying operation ${operation.id}:`, error);
      }
    }

    // 如果有任何修改，保存索引
    if (operationsProcessed > 0) {
      workingIndex.lastUpdated = Date.now();
      workingIndex.totalCount = workingIndex.files.length;

      // 记录最后处理的操作ID
      if (processedOperationIds.length > 0) {
        workingIndex.lastOperationId = processedOperationIds[processedOperationIds.length - 1];
      }

      // 保存更新后的索引（使用分块格式）
      const saveSuccess = await saveChunkedIndex(context, workingIndex);
      if (!saveSuccess) {
        console.error('Failed to save chunked index');
        return {
          success: false,
          error: 'Failed to save index',
        };
      }

      console.log(
        `Index updated: ${addedCount} added, ${updatedCount} updated, ${removedCount} removed, ${movedCount} moved`
      );
    }

    // 清理已处理的操作记录
    if (cleanupAfterMerge && processedOperationIds.length > 0) {
      await cleanupOperations(context, processedOperationIds);
    }

    // 如果未处理完所有操作，调用 merge-operations API 递归处理
    if (!isALLOperations) {
      console.log('There are remaining operations, will process them in subsequent calls.');

      const headers = new Headers((request as Request).headers);
      const originUrl = new URL((request as Request).url);
      const mergeUrl = `${originUrl.protocol}//${originUrl.host}/api/manage/list?action=merge-operations`;

      await fetch(mergeUrl, { method: 'GET', headers });

      return {
        success: false,
        error: 'There are remaining operations, will process them in subsequent calls.',
      };
    }

    const result = {
      success: true,
      processedOperations: operationsProcessed,
      addedCount,
      updatedCount,
      removedCount,
      movedCount,
      totalFiles: workingIndex.totalCount,
    };

    console.log('Operations merge completed:', result);
    return result;
  } catch (error: any) {
    console.error('Error merging operations:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * 读取文件索引，支持搜索和分页
 * @param context - 上下文对象
 * @param options - 查询选项
 */
export async function readIndex(
  context: IndexContext,
  options: Record<string, any> = {},
): Promise<Record<string, any>> {
  try {
    const {
      search = '',
      folder = '',
      start = 0,
      count = 50,
      channel = [] as string | string[],
      listType = [] as string | string[],
      accessStatus = [] as string | string[],
      label = [] as string | string[],
      fileType = [] as string | string[],
      channelName = [] as string | string[],
      includeTags = [] as string[],
      excludeTags = [] as string[],
      countOnly = false,
      includeSubdirFiles = false,
    } = options;

    // 将参数统一转换为数组形式
    const channelArr = Array.isArray(channel) ? channel : channel ? [channel] : [];
    const listTypeArr = Array.isArray(listType) ? listType : listType ? [listType] : [];
    const accessStatusArr = Array.isArray(accessStatus) ? accessStatus : accessStatus ? [accessStatus] : [];
    const labelArr = Array.isArray(label) ? label : label ? [label] : [];
    const fileTypeArr = Array.isArray(fileType) ? fileType : fileType ? [fileType] : [];
    const channelNameArr = Array.isArray(channelName) ? channelName : channelName ? [channelName] : [];

    // 处理目录满足无头有尾的格式，根目录为空
    const dirPrefix = folder === '' || folder.endsWith('/') ? folder : folder + '/';

    // 处理挂起的操作
    const mergeResult = await mergeOperationsToIndex(context);
    if (!mergeResult.success) {
      throw new Error('Failed to merge operations: ' + mergeResult.error);
    }

    // 获取当前索引
    const index = await getIndex(context);
    if (!index.success) {
      throw new Error('Failed to get index');
    }

    let filteredFiles: IndexFileEntry[] = index.files;

    // 目录过滤
    if (folder) {
      const normalizedDir = folder.endsWith('/') ? folder : folder + '/';
      filteredFiles = filteredFiles.filter(file => {
        const fileDir = file.metadata.Folder ? file.metadata.Folder : extractDirectory(file.id);
        return fileDir.startsWith(normalizedDir) || file.metadata.Folder === folder;
      });
    }

    // 渠道过滤（支持多选，OR 逻辑）
    if (channelArr.length > 0) {
      filteredFiles = filteredFiles.filter(file =>
        channelArr.some((ch: string) => file.metadata.Channel?.toLowerCase() === ch.toLowerCase())
      );
    }

    // 访问状态筛选（基于实际访问控制规则，支持多选，OR 逻辑）
    // 'normal' = 正常：可公开访问
    // 'blocked' = 已屏蔽：不可公开访问
    if (accessStatusArr.length > 0) {
      // 读取白名单模式配置
      const securityConfig = await fetchSecurityConfig(context.env);
      const whiteListModeEnabled = securityConfig?.access?.whiteListMode?.enabled || false;

      filteredFiles = filteredFiles.filter(file => {
        const fileTags = file.metadata.Tags || [];

        // 判断文件是否会被实际屏蔽（与 fileTools.js 逻辑一致）
        let isBlocked = false;

        // 1. 检查 blocked 标签（最高优先级）
        if (fileTags.includes('blocked')) {
          isBlocked = true;
        }
        // 2. 检查白名单模式
        else if (whiteListModeEnabled) {
          // 白名单模式：只有带 whitelist 标签的文件可访问
          isBlocked = !fileTags.includes('whitelist');
        }
        // 3. 否则不屏蔽
        else {
          isBlocked = false;
        }

        return accessStatusArr.some((status: string) => {
          if (status === 'normal') {
            return !isBlocked;
          } else if (status === 'blocked') {
            return isBlocked;
          }
          return false;
        });
      });
    }

    // 文件类型筛选 (fileType)（支持多选，OR 逻辑）
    // 'image' 匹配 FileType 以 'image/' 开头
    // 'video' 匹配 FileType 以 'video/' 开头
    // 'audio' 匹配 FileType 以 'audio/' 开头
    // 'other' 匹配不属于以上三类的文件
    if (fileTypeArr.length > 0) {
      filteredFiles = filteredFiles.filter(file => {
        const mimeType = file.metadata.FileType || '';
        return fileTypeArr.some((ft: string) => {
          if (ft === 'image') {
            return mimeType.startsWith('image/');
          } else if (ft === 'video') {
            return mimeType.startsWith('video/');
          } else if (ft === 'audio') {
            return mimeType.startsWith('audio/');
          } else if (ft === 'other') {
            return (
              !mimeType.startsWith('image/') &&
              !mimeType.startsWith('video/') &&
              !mimeType.startsWith('audio/')
            );
          }
          return false;
        });
      });
    }

    // 渠道名称筛选 (channelName)（支持多选，OR 逻辑）
    // 支持 "type:name" 格式（如 "TelegramNew:default"）或单独的名称
    if (channelNameArr.length > 0) {
      filteredFiles = filteredFiles.filter(file => {
        const fileChannel = file.metadata.Channel;
        const fileChannelName = file.metadata.ChannelName;

        return channelNameArr.some((filterValue: string) => {
          // 检查是否是 "type:name" 格式
          if (filterValue.includes(':')) {
            const [type, name] = filterValue.split(':', 2);
            // 同时匹配渠道类型和名称（大小写敏感）
            return fileChannel === type && fileChannelName === name;
          } else {
            // 只匹配名称（向后兼容）
            return fileChannelName === filterValue;
          }
        });
      });
    }

    // 标签过滤（独立于搜索关键字）
    if (includeTags.length > 0 || excludeTags.length > 0) {
      filteredFiles = filteredFiles.filter(file => {
        const fileTags = (file.metadata.Tags || []).map(t => t.toLowerCase());

        // 检查必须包含的标签
        if (includeTags.length > 0) {
          const hasAllIncludeTags = includeTags.every(tag => fileTags.includes(tag.toLowerCase()));
          if (!hasAllIncludeTags) {
            return false;
          }
        }

        // 检查必须排除的标签
        if (excludeTags.length > 0) {
          const hasAnyExcludeTag = excludeTags.some(tag => fileTags.includes(tag.toLowerCase()));
          if (hasAnyExcludeTag) {
            return false;
          }
        }

        return true;
      });
    }

    // 搜索过滤（仅关键字）
    if (search) {
      const searchLower = search.toLowerCase();
      filteredFiles = filteredFiles.filter(file => {
        const matchesKeyword =
          file.metadata.FileName?.toLowerCase().includes(searchLower) ||
          file.id.toLowerCase().includes(searchLower);
        return matchesKeyword;
      });
    }

    // 如果只需要总数
    if (countOnly) {
      return {
        totalCount: filteredFiles.length,
        indexLastUpdated: index.lastUpdated,
      };
    }

    // 分页处理
    const totalCount = filteredFiles.length;

    // 分离文件和文件夹记录
    const actualFiles = filteredFiles.filter(item => item.metadata.Type !== 'folder');
    const folderRecords = filteredFiles.filter(item => item.metadata.Type === 'folder');

    let resultFiles = actualFiles;

    // 计算当前目录下的直接文件（不包含子目录文件）
    const directFiles = actualFiles.filter(file => {
      const fileDir = file.metadata.Folder ? file.metadata.Folder : extractDirectory(file.id);
      return fileDir === dirPrefix;
    });
    const directFileCount = directFiles.length;

    // 如果不包含子目录文件，获取当前目录下的直接文件
    if (!includeSubdirFiles) {
      resultFiles = directFiles;
    }

    if (count !== -1) {
      const startIndex = Math.max(0, start);
      const endIndex = startIndex + Math.max(1, count);
      resultFiles = resultFiles.slice(startIndex, endIndex);
    }

    // 提取文件夹信息（包括索引中记录的文件夹和从文件路径提取的文件夹）
    const folders = new Set<string>();

    // 从文件夹记录中提取
    folderRecords.forEach(folder => {
      // 文件夹的 id 就是其路径（带末尾斜杠）
      const folderPath = folder.id.endsWith('/') ? folder.id : folder.id + '/';
      if (folderPath.startsWith(dirPrefix) && folderPath !== dirPrefix) {
        const relativePath = folderPath.substring(dirPrefix.length);
        const firstSlashIndex = relativePath.indexOf('/');
        // relativePath 格式如 "test/" 或 "photos/2024/"
        if (firstSlashIndex !== -1) {
          // 提取第一级文件夹名
          const firstLevel = relativePath.substring(0, firstSlashIndex);
          if (firstLevel) {
            const subDir = dirPrefix + firstLevel + '/';
            folders.add(subDir);
          }
        }
      }
    });

    // 从文件路径中提取（用于推断隐式文件夹）
    actualFiles.forEach(file => {
      const fileDir = file.metadata.Folder ? file.metadata.Folder : extractDirectory(file.id);
      if (fileDir && fileDir.startsWith(dirPrefix)) {
        const relativePath = fileDir.substring(dirPrefix.length);
        const firstSlashIndex = relativePath.indexOf('/');
        if (firstSlashIndex !== -1) {
          const subDir = dirPrefix + relativePath.substring(0, firstSlashIndex + 1);
          folders.add(subDir);
        }
      }
    });

    // 直接子文件夹数目
    const directFolderCount = folders.size;

    return {
      files: resultFiles,
      folders: Array.from(folders),
      totalCount: totalCount,
      directFileCount: directFileCount,
      directFolderCount: directFolderCount,
      indexLastUpdated: index.lastUpdated,
      returnedCount: resultFiles.length,
      success: true,
    };
  } catch (error) {
    console.error('Error reading index:', error);
    return {
      files: [],
      folders: [],
      totalCount: 0,
      indexLastUpdated: Date.now(),
      returnedCount: 0,
      success: false,
    };
  }
}

/**
 * 重建索引（从数据库中的所有文件重新构建索引）
 * @param context - 上下文对象
 * @param progressCallback - 进度回调函数
 */
export async function rebuildIndex(
  context: IndexContext,
  progressCallback: ((processedCount: number) => void) | null = null,
): Promise<Record<string, any>> {
  const { env, waitUntil } = context;
  const db = getDatabase(env);

  try {
    console.log('Starting index rebuild...');

    let cursor: string | null | undefined = null;
    let processedCount = 0;
    const newIndex: IndexObject = {
      files: [],
      lastUpdated: Date.now(),
      totalCount: 0,
      lastOperationId: null,
    };

    // 分批读取所有文件和文件夹
    while (true) {
      const response = await db.list({
        limit: KV_LIST_LIMIT,
        cursor: cursor ?? null,
      });

      cursor = response.cursor;

      for (const item of response.keys) {
        // 跳过管理相关的键和分块上传临时数据
        if (item.name.startsWith('manage@') || item.name.startsWith('chunk_')) {
          continue;
        }

        // 跳过没有元数据的记录
        if (!item.metadata || !(item.metadata as FileMetadata).TimeStamp) {
          continue;
        }

        // 构建索引项（可能是文件或文件夹）
        let itemId = item.name;

        // 如果是文件夹标记（folder:前缀），提取实际路径
        if (item.name.startsWith('folder:')) {
          itemId = item.name.substring(7); // 移除 "folder:" 前缀
        }

        const indexItem: IndexFileEntry = {
          id: itemId,
          metadata: (item.metadata as FileMetadata) || {},
        };

        newIndex.files.push(indexItem);
        processedCount++;

        // 报告进度
        if (progressCallback && processedCount % 100 === 0) {
          progressCallback(processedCount);
        }
      }

      if (!cursor) break;

      // 添加协作点
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // 按时间戳倒序排序
    newIndex.files.sort((a, b) => (b.metadata.TimeStamp || 0) - (a.metadata.TimeStamp || 0));

    newIndex.totalCount = newIndex.files.length;

    // 保存新索引（使用分块格式）
    const saveSuccess = await saveChunkedIndex(context, newIndex);
    if (!saveSuccess) {
      console.error('Failed to save chunked index during rebuild');
      return {
        success: false,
        error: 'Failed to save rebuilt index',
      };
    }

    // 清除旧的操作记录和多余索引
    waitUntil?.(deleteAllOperations(context));
    waitUntil?.(clearChunkedIndex(context, true));

    console.log(
      `Index rebuild completed. Processed ${processedCount} records (files and folders), indexed ${newIndex.totalCount} total.`
    );
    return {
      success: true,
      processedCount,
      indexedCount: newIndex.totalCount,
    };
  } catch (error: any) {
    console.error('Error rebuilding index:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * 获取索引信息
 * @param context - 上下文对象
 * @param options - 统计选项
 */
export async function getIndexInfo(
  context: IndexContext,
  options: TrendOptions = {},
): Promise<Record<string, any> | null> {
  try {
    const index = await getIndex(context);

    // 检查索引是否成功获取
    if (index.success === false) {
      return {
        success: false,
        error: 'Failed to retrieve index',
        message: 'Index is not available or corrupted',
      };
    }

    // 统计各渠道文件数量
    const channelStats: Record<string, number> = Object.create(null);
    const folderStats: Record<string, number> = Object.create(null);
    const accessStats: Record<string, number> = Object.create(null);
    const uploadTrend = createUploadTrendAccumulator(index.files, options);

    // 读取白名单模式配置
    const securityConfig = await fetchSecurityConfig(context.env);
    const whiteListModeEnabled = securityConfig?.access?.whiteListMode?.enabled || false;

    const actualFiles: IndexFileEntry[] = [];

    index.files.forEach(file => {
      const metadata = file.metadata || {};

      // 跳过文件夹记录
      if (metadata.Type === 'folder') {
        return;
      }

      actualFiles.push(file);

      // 渠道统计
      const channel = normalizeChannel(metadata.Channel);
      incrementStat(channelStats, channel);

      // 文件夹统计
      const dir = metadata.Folder || extractDirectory(file.id) || '/';
      incrementStat(folderStats, dir);

      // 访问状态统计（基于实际访问控制规则）
      const fileTags = metadata.Tags || [];
      let accessStatus = 'normal';

      // 判断文件是否会被实际屏蔽
      if (fileTags.includes('blocked')) {
        accessStatus = 'blocked';
      } else if (whiteListModeEnabled && !fileTags.includes('whitelist')) {
        accessStatus = 'blocked';
      }

      incrementStat(accessStats, accessStatus);

      addUploadTrendPoint(uploadTrend, metadata, channel);
    });

    return {
      success: true,
      totalFiles: actualFiles.length,
      lastUpdated: index.lastUpdated,
      channelStats,
      folderStats,
      accessStats,
      uploadTrend: finalizeUploadTrend(uploadTrend),
      oldestFile: actualFiles[actualFiles.length - 1] || null,
      newestFile: actualFiles[0] || null,
    };
  } catch (error) {
    console.error('Error getting index info:', error);
    return null;
  }
}

/**
 * 获取索引元数据（轻量级，只读取 meta，不读取整个索引）
 * 用于容量检查等场景，避免读取整个索引
 * @param context - 上下文对象
 * @returns 索引元数据，包含 totalCount, totalSizeMB, channelStats 等
 */
export async function getIndexMeta(context: IndexContext): Promise<Record<string, any>> {
  const { env } = context;
  const db = getDatabase(env);

  try {
    const metadataStr = await db.get(INDEX_META_KEY);
    if (!metadataStr) {
      return {
        success: false,
        totalCount: 0,
        totalSizeMB: 0,
        channelStats: {},
      };
    }

    const metadata = JSON.parse(metadataStr);
    return {
      success: true,
      totalCount: metadata.totalCount || 0,
      totalSizeMB: metadata.totalSizeMB || 0,
      channelStats: metadata.channelStats || {},
      lastUpdated: metadata.lastUpdated,
    };
  } catch (error) {
    console.error('Error getting index meta:', error);
    return {
      success: false,
      totalCount: 0,
      totalSizeMB: 0,
      channelStats: {},
    };
  }
}

/* ============= 原子操作相关函数 ============= */

/**
 * 生成唯一的操作ID
 */
function generateOperationId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${timestamp}_${random}`;
}

/**
 * 记录原子操作
 * @param context - 上下文对象，包含 env 和其他信息
 * @param type - 操作类型
 * @param data - 操作数据
 */
async function recordOperation(
  context: IndexContext,
  type: string,
  data: Record<string, any>,
): Promise<string> {
  const { env } = context;
  const db = getDatabase(env);

  const operationId = generateOperationId();
  const operation: OperationRecord = {
    type,
    timestamp: Date.now(),
    data,
  };

  const operationKey = OPERATION_KEY_PREFIX + operationId;
  await db.put(operationKey, JSON.stringify(operation));

  return operationId;
}

/**
 * 获取所有待处理的操作
 * @param context - 上下文对象
 * @param lastOperationId - 最后处理的操作ID
 */
async function getAllPendingOperations(
  context: IndexContext,
  lastOperationId: string | null = null,
): Promise<{ operations: OperationRecord[]; isAll: boolean }> {
  const { env } = context;
  const db = getDatabase(env);

  const operations: OperationRecord[] = [];

  let cursor: string | null | undefined = null;
  const MAX_OPERATION_COUNT = 30; // 单次获取的最大操作数量
  let isALL = true; // 是否获取了所有操作
  let operationCount = 0;

  try {
    while (true) {
      const response = await db.list({
        prefix: OPERATION_KEY_PREFIX,
        limit: KV_LIST_LIMIT,
        cursor: cursor ?? null,
      });

      for (const item of response.keys) {
        // 如果指定了lastOperationId，跳过已处理的操作
        if (lastOperationId && item.name <= OPERATION_KEY_PREFIX + lastOperationId) {
          continue;
        }

        if (operationCount >= MAX_OPERATION_COUNT) {
          isALL = false; // 达到最大操作数量，停止获取
          break;
        }

        try {
          const operationData = await db.get(item.name);
          if (operationData) {
            const operation = JSON.parse(operationData);
            operation.id = item.name.substring(OPERATION_KEY_PREFIX.length);
            operations.push(operation);
            operationCount++;
          }
        } catch (error) {
          isALL = false;
          console.warn(`Failed to parse operation ${item.name}:`, error);
        }
      }

      cursor = response.cursor;
      if (!cursor || operationCount >= MAX_OPERATION_COUNT) break;
    }
  } catch (error) {
    console.error('Error getting pending operations:', error);
  }

  return {
    operations,
    isAll: isALL,
  };
}

/**
 * 应用添加操作
 * @param index - 索引对象
 * @param data - 操作数据
 */
function applyAddOperation(
  index: IndexObject,
  data: Record<string, any>,
): { added: boolean; updated: boolean } {
  const { fileId, metadata } = data;

  // 检查文件是否已存在
  const existingIndex = index.files.findIndex(file => file.id === fileId);

  const fileItem: IndexFileEntry = {
    id: fileId,
    metadata: metadata || {},
  };

  if (existingIndex !== -1) {
    // 更新现有文件
    index.files[existingIndex] = fileItem;
    return { added: false, updated: true };
  } else {
    // 添加新文件
    insertFileInOrder(index.files, fileItem);
    return { added: true, updated: false };
  }
}

/**
 * 应用删除操作
 * @param index - 索引对象
 * @param data - 操作数据
 */
function applyRemoveOperation(index: IndexObject, data: Record<string, any>): boolean {
  const { fileId } = data;
  const initialLength = index.files.length;
  index.files = index.files.filter(file => file.id !== fileId);
  return index.files.length < initialLength;
}

/**
 * 应用移动操作
 * @param index - 索引对象
 * @param data - 操作数据
 */
function applyMoveOperation(index: IndexObject, data: Record<string, any>): boolean {
  const { originalFileId, newFileId, metadata } = data;

  const originalIndex = index.files.findIndex(file => file.id === originalFileId);
  if (originalIndex === -1) {
    return false; // 原文件不存在
  }

  // 更新文件ID和元数据
  index.files[originalIndex] = {
    id: newFileId,
    metadata: metadata || index.files[originalIndex].metadata,
  };

  return true;
}

/**
 * 应用批量添加操作
 * @param index - 索引对象
 * @param data - 操作数据
 */
function applyBatchAddOperation(
  index: IndexObject,
  data: Record<string, any>,
): { addedCount: number; updatedCount: number } {
  const { files, options } = data;
  const { skipExisting = false } = options || {};

  let addedCount = 0;
  let updatedCount = 0;

  // 创建现有文件ID的映射以提高查找效率
  const existingFilesMap = new Map<string, number>();
  index.files.forEach((file, idx) => {
    existingFilesMap.set(file.id, idx);
  });

  for (const fileData of files) {
    const { fileId, metadata } = fileData;
    const fileItem: IndexFileEntry = {
      id: fileId,
      metadata: metadata || {},
    };

    const existingIndex = existingFilesMap.get(fileId);

    if (existingIndex !== undefined) {
      if (!skipExisting) {
        // 更新现有文件
        index.files[existingIndex] = fileItem;
        updatedCount++;
      }
    } else {
      // 添加新文件
      insertFileInOrder(index.files, fileItem);
      // 更新映射
      index.files.forEach((file, idx) => {
        existingFilesMap.set(file.id, idx);
      });

      addedCount++;
    }
  }

  return { addedCount, updatedCount };
}

/**
 * 应用批量删除操作
 * @param index - 索引对象
 * @param data - 操作数据
 */
function applyBatchRemoveOperation(index: IndexObject, data: Record<string, any>): number {
  const { fileIds } = data;
  const fileIdSet = new Set(fileIds);
  const initialLength = index.files.length;

  index.files = index.files.filter(file => !fileIdSet.has(file.id));

  return initialLength - index.files.length;
}

/**
 * 应用批量移动操作
 * @param index - 索引对象
 * @param data - 操作数据
 */
function applyBatchMoveOperation(index: IndexObject, data: Record<string, any>): number {
  const { operations } = data;
  let movedCount = 0;

  // 创建现有文件ID的映射以提高查找效率
  const existingFilesMap = new Map<string, number>();
  index.files.forEach((file, idx) => {
    existingFilesMap.set(file.id, idx);
  });

  for (const operation of operations) {
    const { originalFileId, newFileId, metadata } = operation;

    const originalIndex = existingFilesMap.get(originalFileId);
    if (originalIndex !== undefined) {
      // 更新映射
      existingFilesMap.delete(originalFileId);
      existingFilesMap.set(newFileId, originalIndex);

      // 更新文件信息
      index.files[originalIndex] = {
        id: newFileId,
        metadata: metadata || index.files[originalIndex].metadata,
      };

      movedCount++;
    }
  }

  return movedCount;
}

/**
 * 并发清理指定的原子操作记录
 * @param context - 上下文对象
 * @param operationIds - 要清理的操作ID数组
 * @param concurrency - 并发数量，默认为10
 */
async function cleanupOperations(
  context: IndexContext,
  operationIds: string[],
  concurrency = 10,
): Promise<{ success: boolean; deletedCount: number; errorCount: number } | undefined> {
  const { env } = context;
  const db = getDatabase(env);

  try {
    console.log(`Cleaning up ${operationIds.length} processed operations with concurrency ${concurrency}...`);

    let deletedCount = 0;
    let errorCount = 0;

    // 创建删除任务数组
    const deleteTasks = operationIds.map(operationId => {
      const operationKey = OPERATION_KEY_PREFIX + operationId;
      return async () => {
        try {
          await db.delete(operationKey);
          deletedCount++;
        } catch (error) {
          console.error(`Error deleting operation ${operationId}:`, error);
          errorCount++;
        }
      };
    });

    // 使用并发控制执行删除操作
    await promiseLimit(deleteTasks, concurrency);

    console.log(`Successfully cleaned up ${deletedCount} operations, ${errorCount} operations failed.`);
    return {
      success: true,
      deletedCount: deletedCount,
      errorCount: errorCount,
    };
  } catch (error) {
    console.error('Error cleaning up operations:', error);
  }
}

/**
 * 删除所有原子操作记录
 * @param context - 上下文对象，包含 env 和其他信息
 * @returns 删除结果 { success, deletedCount, errors?, totalFound? }
 */
export async function deleteAllOperations(context: IndexContext): Promise<Record<string, any>> {
  const { request, env } = context;
  const db = getDatabase(env);

  try {
    console.log('Starting to delete all atomic operations...');

    // 获取所有原子操作
    const allOperationIds: string[] = [];
    let cursor: string | null | undefined = null;
    let totalFound = 0;

    // 首先收集所有操作键
    while (true) {
      const response = await db.list({
        prefix: OPERATION_KEY_PREFIX,
        limit: KV_LIST_LIMIT,
        cursor: cursor ?? null,
      });

      for (const item of response.keys) {
        allOperationIds.push(item.name.substring(OPERATION_KEY_PREFIX.length));
        totalFound++;
      }

      cursor = response.cursor;
      if (!cursor) break;
    }

    if (totalFound === 0) {
      console.log('No atomic operations found to delete');
      return {
        success: true,
        deletedCount: 0,
        totalFound: 0,
        message: 'No operations to delete',
      };
    }

    console.log(`Found ${totalFound} atomic operations to delete`);

    // 限制单次删除的数量
    const MAX_DELETE_BATCH = 40;
    const toDeleteOperationIds = allOperationIds.slice(0, MAX_DELETE_BATCH);

    // 批量删除原子操作
    const cleanupResult = await cleanupOperations(context, toDeleteOperationIds);

    // 剩余未删除的操作，调用 delete-operations API 进行递归删除
    if (
      allOperationIds.length > MAX_DELETE_BATCH ||
      (cleanupResult && cleanupResult.errorCount > 0)
    ) {
      console.warn(
        `Too many operations (${allOperationIds.length}), only deleting first ${cleanupResult?.deletedCount}. The remaining operations will be deleted in subsequent calls.`
      );
      // 复制请求头，用于鉴权
      const headers = new Headers((request as Request).headers);

      const originUrl = new URL((request as Request).url);
      const deleteUrl = `${originUrl.protocol}//${originUrl.host}/api/manage/list?action=delete-operations`;

      await fetch(deleteUrl, {
        method: 'GET',
        headers: headers,
      });
    } else {
      console.log(`Delete all operations completed`);
    }
  } catch (error) {
    console.error('Error deleting all operations:', error);
  }
}

/* ============= 工具函数 ============= */

/**
 * 获取索引（内部函数）
 * @param context - 上下文对象
 */
async function getIndex(context: IndexContext): Promise<IndexObject> {
  const { waitUntil } = context;
  try {
    // 首先尝试加载分块索引
    const index = await loadChunkedIndex(context);
    if (index.success) {
      return index;
    } else {
      // 如果加载失败，触发重建索引
      waitUntil?.(rebuildIndex(context));
    }
  } catch (error) {
    console.warn('Error reading index, creating new one:', error);
    waitUntil?.(rebuildIndex(context));
  }

  // 返回空的索引结构
  return {
    files: [],
    lastUpdated: Date.now(),
    totalCount: 0,
    lastOperationId: null,
    success: false,
  };
}

/**
 * 从文件路径提取目录（内部函数）
 * @param filePath - 文件路径
 */
function extractDirectory(filePath: string): string {
  const lastSlashIndex = filePath.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    return ''; // 根目录
  }
  return filePath.substring(0, lastSlashIndex + 1); // 包含最后的斜杠
}

/**
 * 将扁平文件夹路径列表转换为嵌套树结构
 * @param folderPaths - 文件夹路径数组，如 ['photos/', 'photos/2024/', 'documents/']
 * @returns 树形结构 { name, path, children }
 */
function buildTree(
  folderPaths: string[],
): { name: string; path: string; children: any[] } {
  // 创建根节点
  const root: { name: string; path: string; children: any[] } = {
    name: '/',
    path: '',
    children: [],
  };

  // 如果没有文件夹，返回仅包含根节点的空树
  if (!folderPaths || folderPaths.length === 0) {
    return root;
  }

  // 使用 Map 存储已创建的节点，key 为路径
  const nodeMap = new Map<string, any>();
  nodeMap.set('', root);

  // 对文件夹进行排序，确保父文件夹在子文件夹之前处理
  const sortedPaths = [...folderPaths].sort();

  for (const folderPath of sortedPaths) {
    // 跳过空路径（根目录已创建）
    if (!folderPath) continue;

    // 规范化路径：确保以 / 结尾
    const normalizedPath = folderPath.endsWith('/') ? folderPath : folderPath + '/';

    // 如果节点已存在，跳过
    if (nodeMap.has(normalizedPath)) continue;

    // 分割路径获取各级目录名
    const parts = normalizedPath.split('/').filter(part => part !== '');

    // 逐级创建节点
    let currentPath = '';
    let parentNode = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath + part + '/';

      // 检查当前路径的节点是否已存在
      if (nodeMap.has(currentPath)) {
        parentNode = nodeMap.get(currentPath);
      } else {
        // 创建新节点
        const newNode = {
          name: part,
          path: currentPath,
          children: [] as any[],
        };

        // 添加到父节点的 children 中
        parentNode.children.push(newNode);

        // 存储到 Map 中
        nodeMap.set(currentPath, newNode);

        // 更新父节点引用
        parentNode = newNode;
      }
    }
  }

  // 对每个节点的 children 按名称排序
  const sortChildren = (node: any) => {
    node.children.sort((a: any, b: any) => a.name.localeCompare(b.name));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);

  return root;
}

/**
 * 将文件按时间戳倒序插入到已排序的数组中
 * @param sortedFiles - 已按时间戳倒序排序的文件数组
 * @param fileItem - 要插入的文件项
 */
function insertFileInOrder(sortedFiles: IndexFileEntry[], fileItem: IndexFileEntry): void {
  const fileTimestamp = fileItem.metadata.TimeStamp || 0;

  // 如果数组为空或新文件时间戳比第一个文件更新，直接插入到开头
  if (sortedFiles.length === 0 || fileTimestamp >= (sortedFiles[0].metadata.TimeStamp || 0)) {
    sortedFiles.unshift(fileItem);
    return;
  }

  // 如果新文件时间戳比最后一个文件更旧，直接添加到末尾
  if (fileTimestamp <= (sortedFiles[sortedFiles.length - 1].metadata.TimeStamp || 0)) {
    sortedFiles.push(fileItem);
    return;
  }

  // 使用二分查找找到正确的插入位置
  let left = 0;
  let right = sortedFiles.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const midTimestamp = sortedFiles[mid].metadata.TimeStamp || 0;

    if (fileTimestamp >= midTimestamp) {
      right = mid;
    } else {
      left = mid + 1;
    }
  }

  // 在找到的位置插入文件
  sortedFiles.splice(left, 0, fileItem);
}

/**
 * 并发控制工具函数 - 限制同时执行的Promise数量
 * @param tasks - 任务数组，每个任务是一个返回Promise的函数
 * @param concurrency - 并发数量
 * @returns 所有任务的结果数组
 */
async function promiseLimit<T>(tasks: Array<() => Promise<T>>, concurrency: number = BATCH_SIZE): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<T>[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const promise = Promise.resolve()
      .then(() => task())
      .then(result => {
        results[i] = result;
        return result;
      })
      .finally(() => {
        const index = executing.indexOf(promise);
        if (index >= 0) {
          executing.splice(index, 1);
        }
      });

    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  // 等待所有剩余的Promise完成
  await Promise.all(executing);
  return results;
}

/**
 * 保存分块索引到数据库
 * @param context - 上下文对象，包含 env
 * @param index - 完整的索引对象
 * @returns 是否保存成功
 */
async function saveChunkedIndex(context: IndexContext, index: IndexObject): Promise<boolean> {
  const { env } = context;
  const db = getDatabase(env);
  const chunkSize = getIndexChunkSize(env);

  try {
    const files = index.files || [];
    const chunks: IndexFileEntry[][] = [];

    // 将文件数组分块
    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize);
      chunks.push(chunk);
    }

    // 计算各渠道容量统计
    const channelStats: Record<string, { usedMB: number; fileCount: number }> = {};
    let totalSizeMB = 0;

    for (const file of files) {
      const channelName = file.metadata?.ChannelName;
      const fileSize = parseFloat(String(file.metadata?.FileSize)) || 0;

      totalSizeMB += fileSize;

      if (channelName) {
        if (!channelStats[channelName]) {
          channelStats[channelName] = { usedMB: 0, fileCount: 0 };
        }
        channelStats[channelName].usedMB += fileSize;
        channelStats[channelName].fileCount += 1;
      }
    }

    // 保存索引元数据（包含容量统计）
    const metadata = {
      lastUpdated: index.lastUpdated,
      totalCount: index.totalCount,
      totalSizeMB: Math.round(totalSizeMB * 100) / 100,
      channelStats,
      lastOperationId: index.lastOperationId,
      chunkCount: chunks.length,
      chunkSize: chunkSize,
    };

    await db.put(INDEX_META_KEY, JSON.stringify(metadata));

    // 保存各个分块
    const savePromises = chunks.map((chunk, chunkId) => {
      const chunkKey = `${INDEX_KEY}_${chunkId}`;
      return db.put(chunkKey, JSON.stringify(chunk));
    });

    await Promise.all(savePromises);

    console.log(
      `Saved chunked index: ${chunks.length} chunks, ${files.length} total files, ${totalSizeMB.toFixed(2)} MB`
    );
    return true;
  } catch (error) {
    console.error('Error saving chunked index:', error);
    return false;
  }
}

/**
 * 从数据库加载分块索引
 * @param context - 上下文对象，包含 env
 * @returns 完整的索引对象
 */
async function loadChunkedIndex(context: IndexContext): Promise<IndexObject> {
  const { env } = context;
  const db = getDatabase(env);

  try {
    // 首先获取元数据
    const metadataStr = await db.get(INDEX_META_KEY);
    if (!metadataStr) {
      throw new Error('Index metadata not found');
    }

    const metadata = JSON.parse(metadataStr);
    const files: IndexFileEntry[] = [];

    // 并行加载所有分块
    const loadPromises = [];
    for (let chunkId = 0; chunkId < metadata.chunkCount; chunkId++) {
      const chunkKey = `${INDEX_KEY}_${chunkId}`;
      loadPromises.push(
        db.get(chunkKey).then(chunkStr => {
          if (chunkStr) {
            return JSON.parse(chunkStr);
          }
          return [];
        })
      );
    }

    const chunks = await Promise.all(loadPromises);

    // 合并所有分块
    chunks.forEach(chunk => {
      if (Array.isArray(chunk)) {
        files.push(...chunk);
      }
    });

    const index: IndexObject = {
      files,
      lastUpdated: metadata.lastUpdated,
      totalCount: metadata.totalCount,
      lastOperationId: metadata.lastOperationId,
      success: true,
    };

    console.log(`Loaded chunked index: ${metadata.chunkCount} chunks, ${files.length} total files`);
    return index;
  } catch (error) {
    console.error('Error loading chunked index:', error);
    // 返回空的索引结构
    return {
      files: [],
      lastUpdated: Date.now(),
      totalCount: 0,
      lastOperationId: null,
      success: false,
    };
  }
}

/**
 * 清理分块索引
 * @param context - 上下文对象，包含 env
 * @param onlyNonUsed - 是否仅清理未使用的分块索引，默认为 false
 * @returns 是否清理成功
 */
export async function clearChunkedIndex(context: IndexContext, onlyNonUsed = false): Promise<boolean> {
  const { env } = context;
  const db = getDatabase(env);

  try {
    console.log('Starting chunked index cleanup...');

    // 获取元数据
    const metadataStr = await db.get(INDEX_META_KEY);
    let chunkCount = 0;

    if (metadataStr) {
      const metadata = JSON.parse(metadataStr);
      chunkCount = metadata.chunkCount || 0;

      if (!onlyNonUsed) {
        // 删除元数据
        await db.delete(INDEX_META_KEY).catch(() => {});
      }
    }

    // 删除分块
    const recordedChunks: string[] = []; // 现有的索引分块键
    let cursor: string | null | undefined = null;
    while (true) {
      const response = await db.list({
        prefix: INDEX_KEY,
        limit: KV_LIST_LIMIT,
        cursor: cursor ?? null,
      });

      for (const item of response.keys) {
        recordedChunks.push(item.name);
      }

      cursor = response.cursor;
      if (!cursor) break;
    }

    const reservedChunks: string[] = [];
    if (onlyNonUsed) {
      // 如果仅清理未使用的分块索引，保留当前在使用的分块
      for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
        reservedChunks.push(`${INDEX_KEY}_${chunkId}`);
      }
    }

    const deletePromises: Array<Promise<unknown>> = [];
    for (let chunkKey of recordedChunks) {
      if (reservedChunks.includes(chunkKey) || !chunkKey.startsWith(INDEX_KEY + '_')) {
        // 保留的分块和非分块键不删除
        continue;
      }

      deletePromises.push(db.delete(chunkKey).catch(() => {}));
    }

    if (recordedChunks.includes(INDEX_KEY)) {
      deletePromises.push(db.delete(INDEX_KEY).catch(() => {}));
    }

    await Promise.all(deletePromises);

    console.log(`Chunked index cleanup completed. Attempted to delete ${chunkCount} chunks.`);
    return true;
  } catch (error) {
    console.error('Error during chunked index cleanup:', error);
    return false;
  }
}

/**
 * 获取索引的存储统计信息
 * @param context - 上下文对象，包含 env
 * @returns 存储统计信息
 */
export async function getIndexStorageStats(context: IndexContext): Promise<Record<string, any>> {
  const { env } = context;
  const db = getDatabase(env);

  try {
    // 获取元数据
    const metadataStr = await db.get(INDEX_META_KEY);
    if (!metadataStr) {
      return {
        success: false,
        error: 'No chunked index metadata found',
        isChunked: false,
      };
    }

    const metadata = JSON.parse(metadataStr);

    // 检查各个分块的存在情况
    const chunkChecks = [];
    for (let chunkId = 0; chunkId < metadata.chunkCount; chunkId++) {
      const chunkKey = `${INDEX_KEY}_${chunkId}`;
      chunkChecks.push(
        db.get(chunkKey).then(data => ({
          chunkId,
          exists: !!data,
          size: data ? data.length : 0,
        }))
      );
    }

    const chunkResults = await Promise.all(chunkChecks);

    const stats = {
      success: true,
      isChunked: true,
      metadata,
      chunks: chunkResults,
      totalChunks: metadata.chunkCount,
      existingChunks: chunkResults.filter(c => c.exists).length,
      totalSize: chunkResults.reduce((sum, c) => sum + c.size, 0),
    };

    return stats;
  } catch (error: any) {
    console.error('Error getting index storage stats:', error);
    return {
      success: false,
      error: error.message,
      isChunked: false,
    };
  }
}

/**
 * 从索引中提取目录树结构
 * @param context - 上下文对象
 * @returns 树形结构 { name, path, children }
 */
export async function getFolderTree(context: IndexContext): Promise<any> {
  // 1. 合并挂起操作
  await mergeOperationsToIndex(context);

  // 2. 获取索引
  const index = await getIndex(context);

  // 3. 提取所有目录路径
  const directorySet = new Set<string>();

  if (index.files && index.files.length > 0) {
    for (const file of index.files) {
      // 获取文件的目录路径
      const dirPath = file.metadata?.Folder || extractDirectory(file.id);

      if (dirPath) {
        // 规范化路径：确保以 / 结尾
        const normalizedDir = dirPath.endsWith('/') ? dirPath : dirPath + '/';

        // 将路径按 / 分割，逐级添加到目录集合中（确保父目录也被包含）
        const parts = normalizedDir.split('/').filter(part => part !== '');
        let currentPath = '';

        for (const part of parts) {
          currentPath = currentPath + part + '/';
          directorySet.add(currentPath);
        }
      }
    }
  }

  // 4. 构建树形结构
  const folderPaths = Array.from(directorySet);
  return buildTree(folderPaths);
}
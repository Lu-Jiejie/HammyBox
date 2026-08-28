import { getDatabase } from '../../utils/databaseAdapter.js';
import { normalizeFolderPath } from '../../utils/pathNormalizer.js';
import { addFileToIndex, removeFileFromIndex } from '../../utils/indexManager.js';
import type { Env, DatabaseAdapter, FileMetadata } from '../../types';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const db = getDatabase(env);

  if (request.method === 'POST') {
    return await createFolder(db, env, request, corsHeaders);
  }

  if (request.method === 'DELETE') {
    return await deleteFolder(db, env, request, corsHeaders);
  }

  if (request.method === 'PATCH') {
    return await renameFolder(db, env, request, corsHeaders);
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function createFolder(
  db: DatabaseAdapter,
  env: Env,
  request: Request,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const body: any = await request.json();
    let { path, createParents } = body;

    if (!path) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'MISSING_PATH',
          error: 'Missing required field: path',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 路径规范化（包含安全验证）
    path = normalizeFolderPath(path);

    if (!path) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'INVALID_PATH',
          error: 'Invalid folder path',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 检查是否已存在
    const folderKey = `folder:${path}`;
    const existing = await db.get(folderKey);
    if (existing !== null) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'FOLDER_EXISTS',
          error: 'Folder already exists',
          folder: { path },
        }),
        {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 检查父文件夹是否存在
    const parentFolder = getParentFolder(path);
    if (parentFolder) {
      const parentKey = `folder:${parentFolder}`;
      const parentExists = await db.get(parentKey);

      if (!parentExists) {
        // 检查是否有文件在该文件夹下（隐式文件夹）
        const filesInParent = await db.list({ prefix: parentFolder, limit: 1 });
        const hasFiles = filesInParent.keys.some(key => !key.name.startsWith('folder:'));

        if (!hasFiles) {
          // 既没有文件夹记录，也没有文件，文件夹确实不存在
          if (createParents) {
            // 递归创建父文件夹（会自动添加到索引）
            await createFolderRecursive(db, env, parentFolder);
          } else {
            return new Response(
              JSON.stringify({
                success: false,
                code: 'PARENT_NOT_FOUND',
                error: 'Parent folder does not exist',
                parentFolder,
                hint: 'Set createParents: true to create parent folders automatically',
              }),
              {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              }
            );
          }
        } else {
          // 有文件但没有文件夹记录，自动创建文件夹记录
          await createFolderRecursive(db, env, parentFolder);
        }
      }
    }

    // 创建文件夹
    const folderName = path.split('/').filter(Boolean).pop();
    const metadata: FileMetadata = {
      Type: 'folder',
      Name: folderName,
      Folder: parentFolder,
      TimeStamp: Date.now(),
    };

    console.log('Creating folder:', {
      path,
      folderKey,
      folderName,
      parentFolder,
      metadata,
    });

    await db.put(folderKey, '', { metadata });

    console.log('Folder record created in DB with key:', folderKey);

    // 添加到索引
    await addFileToIndex({ env }, path, metadata);

    return new Response(
      JSON.stringify({
        success: true,
        folder: {
          path,
          name: folderName,
          parentFolder,
          timeStamp: metadata.TimeStamp,
        },
      }),
      {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('Create folder error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        code: 'CREATE_FAILED',
        error: 'Failed to create folder',
        message: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

async function deleteFolder(
  db: DatabaseAdapter,
  env: Env,
  request: Request,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const body: any = await request.json();
    let { path, recursive } = body;

    if (!path) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'MISSING_PATH',
          error: 'Missing required field: path',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    path = normalizeFolderPath(path);
    const folderKey = `folder:${path}`;

    // 检查文件夹是否存在
    const folderRecord = await db.get(folderKey);
    if (folderRecord === null) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'FOLDER_NOT_FOUND',
          error: 'Folder not found',
        }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 检查是否为空
    if (!recursive) {
      // 检查子文件夹
      const subfolders = await db.list({ prefix: `folder:${path}` });
      const hasSubfolders = subfolders.keys.some(key => key.name !== folderKey);

      // 检查文件
      const files = await db.list({ prefix: path });
      const hasFiles = files.keys.some(key => !key.name.startsWith('folder:'));

      if (hasSubfolders || hasFiles) {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'FOLDER_NOT_EMPTY',
            error: 'Folder is not empty',
            hint: 'Set recursive: true to delete non-empty folders',
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // 删除文件夹标记
    await db.delete(folderKey);

    // 从索引移除
    await removeFileFromIndex({ env }, path);

    // 递归删除
    if (recursive) {
      // 删除所有子文件夹
      const subfolders = await db.list({ prefix: `folder:${path}` });
      for (const key of subfolders.keys) {
        await db.delete(key.name);
        // 从索引移除子文件夹
        const subPath = key.name.substring(7); // 移除 "folder:" 前缀
        await removeFileFromIndex({ env }, subPath);
      }

      // 删除所有文件
      const files = await db.list({ prefix: path });
      for (const key of files.keys) {
        if (!key.name.startsWith('folder:')) {
          await db.delete(key.name);
          // 从索引移除文件
          await removeFileFromIndex({ env }, key.name);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Folder deleted successfully',
        deletedPath: path,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('Delete folder error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        code: 'DELETE_FAILED',
        error: 'Failed to delete folder',
        message: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

async function renameFolder(
  db: DatabaseAdapter,
  env: Env,
  request: Request,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const body: any = await request.json();
    let { oldPath, newPath } = body;

    // 验证参数
    if (!oldPath || !newPath) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'MISSING_PARAMETERS',
          error: 'Missing required fields: oldPath and newPath',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 路径规范化
    oldPath = normalizeFolderPath(oldPath);
    newPath = normalizeFolderPath(newPath);

    if (!oldPath || !newPath) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'INVALID_PATH',
          error: 'Invalid folder path',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 不能重命名为相同路径
    if (oldPath === newPath) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'SAME_PATH',
          error: 'New path is the same as old path',
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 检查旧文件夹是否存在
    const oldFolderKey = `folder:${oldPath}`;
    const oldFolderData = await db.getWithMetadata(oldFolderKey);
    if (!oldFolderData || oldFolderData.value === null) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'FOLDER_NOT_FOUND',
          error: 'Source folder not found',
          path: oldPath,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 检查新路径是否已存在
    const newFolderKey = `folder:${newPath}`;
    const newFolderExists = await db.get(newFolderKey);
    if (newFolderExists !== null) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'FOLDER_EXISTS',
          error: 'Target folder already exists',
          path: newPath,
        }),
        {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 检查新路径的父文件夹是否存在
    const newParentFolder = getParentFolder(newPath);
    if (newParentFolder) {
      const parentExists = await db.get(`folder:${newParentFolder}`);
      if (parentExists === null) {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'PARENT_NOT_FOUND',
            error: 'Parent folder does not exist',
            parentFolder: newParentFolder,
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // 执行重命名
    const result = await performFolderRename(db, env, oldPath, newPath, oldFolderData.metadata);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Folder renamed successfully',
        oldPath,
        newPath,
        filesUpdated: result.filesUpdated,
        foldersUpdated: result.foldersUpdated,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('Rename folder error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        code: 'RENAME_FAILED',
        error: 'Failed to rename folder',
        message: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

// 辅助函数
function getParentFolder(path: string): string {
  if (!path || path === '/') return '';

  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSlash = normalized.lastIndexOf('/');

  if (lastSlash === -1) return '';
  return normalized.substring(0, lastSlash + 1);
}

async function createFolderRecursive(db: DatabaseAdapter, env: Env, path: string): Promise<void> {
  if (!path) return;

  const folderKey = `folder:${path}`;
  const existing = await db.get(folderKey);
  if (existing !== null) return;

  // 递归创建父文件夹
  const parentFolder = getParentFolder(path);
  if (parentFolder) {
    await createFolderRecursive(db, env, parentFolder);
  }

  // 创建当前文件夹
  const folderName = path.split('/').filter(Boolean).pop();
  const metadata: FileMetadata = {
    Type: 'folder',
    Name: folderName,
    Folder: parentFolder,
    TimeStamp: Date.now(),
  };

  await db.put(folderKey, '', { metadata });

  // 添加到索引
  await addFileToIndex({ env }, path, metadata);
}

async function performFolderRename(
  db: DatabaseAdapter,
  env: Env,
  oldPath: string,
  newPath: string,
  oldMetadata: FileMetadata | unknown,
): Promise<{ filesUpdated: number; foldersUpdated: number }> {
  let filesUpdated = 0;
  let foldersUpdated = 0;

  // 1. 更新文件夹记录本身
  const newFolderName = newPath.split('/').filter(Boolean).pop();
  const newParentFolder = getParentFolder(newPath);
  const newMetadata: FileMetadata = {
    ...(oldMetadata as FileMetadata),
    Name: newFolderName,
    Folder: newParentFolder,
    TimeStamp: Date.now(),
  };

  const oldFolderKey = `folder:${oldPath}`;
  const newFolderKey = `folder:${newPath}`;

  await db.put(newFolderKey, '', { metadata: newMetadata });
  await db.delete(oldFolderKey);

  // 更新索引
  await removeFileFromIndex({ env }, oldPath);
  await addFileToIndex({ env }, newPath, newMetadata);
  foldersUpdated++;

  // 2. 更新所有子文件夹
  const subfolders = await db.list({ prefix: `folder:${oldPath}` });
  for (const key of subfolders.keys) {
    if (key.name === oldFolderKey) continue; // 跳过自己

    const subPath = key.name.substring(7); // 移除 "folder:" 前缀
    const newSubPath = subPath.replace(oldPath, newPath);

    const subFolderData = await db.getWithMetadata(key.name);
    if (subFolderData && subFolderData.metadata) {
      const subMetadata = subFolderData.metadata as FileMetadata;
      const updatedMetadata: FileMetadata = {
        ...subMetadata,
        Folder: (subMetadata.Folder || '').replace(oldPath, newPath),
      };

      await db.put(`folder:${newSubPath}`, '', { metadata: updatedMetadata });
      await db.delete(key.name);

      // 更新索引
      await removeFileFromIndex({ env }, subPath);
      await addFileToIndex({ env }, newSubPath, updatedMetadata);
      foldersUpdated++;
    }
  }

  // 3. 更新所有文件的 Folder 字段
  const files = await db.list({ prefix: oldPath });
  for (const key of files.keys) {
    if (key.name.startsWith('folder:')) continue; // 跳过文件夹记录

    const fileId = key.name;
    const newFileId = fileId.replace(oldPath, newPath);

    const fileData = await db.getWithMetadata(fileId);
    if (fileData && fileData.metadata) {
      const fileMetadata = fileData.metadata as FileMetadata;
      const updatedMetadata: FileMetadata = {
        ...fileMetadata,
        Folder: fileMetadata.Folder ? fileMetadata.Folder.replace(oldPath, newPath) : '',
      };

      await db.put(newFileId, fileData.value as string, { metadata: updatedMetadata });
      await db.delete(fileId);

      // 更新索引
      await removeFileFromIndex({ env }, fileId);
      await addFileToIndex({ env }, newFileId, updatedMetadata);
      filesUpdated++;
    }
  }

  return { filesUpdated, foldersUpdated };
}
import { purgeCFCache, purgeFileCache } from '../../../utils/purgeCache.js';
import { addFileToIndex } from '../../../utils/indexManager.js';
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { mergeTags, validateTag } from '../../../utils/tagHelpers.js';
import { cleanPersistedMetadata } from '../../../utils/metadata/metadataSecurity.js';
import type { Env, DatabaseAdapter, FileMetadata, PagesContext } from '../../../types';

/**
 * Tag Management API for Single Files
 *
 * POST /api/manage/tags/{fileId} - Update tags for a file
 *
 * POST body format:
 * {
 *   action: "set" | "add" | "remove",
 *   tags: ["tag1", "tag2", ...]
 * }
 */
export async function onRequest(context: PagesContext): Promise<Response> {
  const {
    request,
    env,
    params,
    waitUntil,
  } = context;

  const url = new URL(request.url);

  // Parse file path
  if (params.path) {
    params.path = String(params.path).split(',').join('/');
  }

  // Decode file path
  const fileId = decodeURIComponent(params.path as string);

  const db = getDatabase(env as Env);

  try {
    if (request.method === 'POST') {
      // Update tags for file
      return await handleUpdateTags(context, db, fileId, url.hostname);
    } else {
      return new Response(
        JSON.stringify({
          error: 'Method not allowed',
          allowedMethods: ['POST'],
        }),
        {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  } catch (error: any) {
    console.error(`Error in tag management for ${fileId}:`, error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle POST request - Update tags for a file
 */
async function handleUpdateTags(
  context: PagesContext,
  db: DatabaseAdapter,
  fileId: string,
  hostname: string,
): Promise<Response> {
  const { request, waitUntil } = context;

  try {
    // Parse request body
    const body: any = await request.json();
    const { action = 'set', tags = [] } = body;

    // Validate action
    if (!['set', 'add', 'remove'].includes(action)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid action',
          message: 'Action must be one of: set, add, remove',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate tags array
    if (!Array.isArray(tags)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid tags format',
          message: 'Tags must be an array of strings',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate each tag
    const invalidTags = tags.filter((tag: string) => !validateTag(tag));
    if (invalidTags.length > 0) {
      return new Response(
        JSON.stringify({
          error: 'Invalid tag format',
          message: 'Tags must contain only alphanumeric characters, underscores, hyphens, and CJK characters',
          invalidTags: invalidTags,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Get file metadata
    const fileData = await db.getWithMetadata(fileId);

    if (!fileData || !fileData.metadata) {
      return new Response(
        JSON.stringify({
          error: 'File not found',
          fileId: fileId,
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Get existing tags
    const existingTags = (fileData.metadata as FileMetadata).Tags || [];

    // Merge tags based on action
    const updatedTags = mergeTags(existingTags, tags, action);

    // Update metadata
    (fileData.metadata as FileMetadata).Tags = updatedTags;
    const metadata = cleanPersistedMetadata(fileData.metadata as FileMetadata);

    // Save to database
    await db.put(fileId, fileData.value as string, {
      metadata,
    });

    // Clear CDN cache asynchronously (don't wait for it to complete)
    const cdnUrl = `https://${hostname}/file/${fileId}`;
    waitUntil(purgeCFCache(context.env as Env, cdnUrl));

    // Clear Cache API cache
    const url = new URL(request.url);
    waitUntil(purgeFileCache(url.origin, fileId));

    // Update file index asynchronously
    waitUntil(addFileToIndex(context, fileId, metadata));

    return new Response(
      JSON.stringify({
        success: true,
        fileId: fileId,
        action: action,
        tags: updatedTags,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    throw new Error(`Failed to update tags: ${error.message}`);
  }
}
import { findConfiguredChannel, loadChannelConfig } from './channelConfig.js';
import { stripConfigDerivedMetadata, stripSensitiveMetadata } from './metadataSecurity.js';
import { buildWebDAVUrl } from '../storage/webdavAPI.js';
import type { UploadConfig, FileMetadata } from '../../types';

/**
 * 元数据视图上下文
 */
export interface MetadataViewContext {
  db: { get(key: string): Promise<string | null> };
  env: unknown;
  uploadConfig: UploadConfig | null;
}

export async function createMetadataViewContext(
  db: { get(key: string): Promise<string | null> },
  env: unknown,
): Promise<MetadataViewContext> {
  return {
    db,
    env,
    uploadConfig: await loadChannelConfig(db, env, 'metadata view'),
  };
}

export async function buildFileMetadataForManagement(
  db: { get(key: string): Promise<string | null> },
  env: unknown,
  metadata: FileMetadata = {},
  viewContext: MetadataViewContext | null = null,
): Promise<Record<string, unknown>> {
  const context = viewContext || (await createMetadataViewContext(db, env));
  const view = stripConfigDerivedMetadata(stripSensitiveMetadata(metadata as Record<string, unknown>));

  enrichS3Metadata(context, metadata, view);
  enrichHuggingFaceMetadata(context, metadata, view);
  enrichWebDAVMetadata(context, metadata, view);

  return view;
}

export async function serializeFileRecordForManagement(
  db: { get(key: string): Promise<string | null> },
  env: unknown,
  file: { id: string; name?: string; metadata?: FileMetadata },
  viewContext: MetadataViewContext | null = null,
): Promise<{ name: string; metadata: Record<string, unknown> }> {
  return {
    name: file.id || file.name,
    metadata: await buildFileMetadataForManagement(db, env, file.metadata || {}, viewContext),
  };
}

function enrichS3Metadata(
  context: MetadataViewContext,
  sourceMetadata: FileMetadata,
  view: Record<string, unknown>,
): void {
  if (sourceMetadata?.Channel !== 'S3') return;

  try {
    const channel = findConfiguredChannel(context.uploadConfig, 's3', sourceMetadata);
    if (!channel) return;

    const credentials = {
      endpoint: channel.endpoint,
      region: channel.region || 'auto',
      bucketName: channel.bucketName,
      pathStyle: channel.pathStyle || false,
      cdnDomain: channel.cdnDomain || '',
      key: sourceMetadata.S3FileKey,
    };

    if (!credentials.key) return;

    if (credentials.endpoint && credentials.bucketName) {
      view.S3Location = buildS3Location(credentials, credentials.key);
    }

    if (credentials.cdnDomain) {
      view.S3CdnFileUrl = buildCdnFileUrl(credentials.cdnDomain, credentials.key);
    }
  } catch (error) {
    console.warn('Failed to enrich S3 metadata:', (error as Error).message);
  }
}

function enrichHuggingFaceMetadata(
  context: MetadataViewContext,
  sourceMetadata: FileMetadata,
  view: Record<string, unknown>,
): void {
  if (sourceMetadata?.Channel !== 'HuggingFace') return;

  try {
    const channel = findConfiguredChannel(context.uploadConfig, 'huggingface', sourceMetadata);
    if (!channel) return;

    if (channel.repo && sourceMetadata.HfFilePath) {
      view.HfFileUrl = `https://huggingface.co/datasets/${channel.repo}/resolve/main/${sourceMetadata.HfFilePath}`;
    }
  } catch (error) {
    console.warn('Failed to enrich HuggingFace metadata:', (error as Error).message);
  }
}

function enrichWebDAVMetadata(
  context: MetadataViewContext,
  sourceMetadata: FileMetadata,
  view: Record<string, unknown>,
): void {
  if (sourceMetadata?.Channel !== 'WebDAV') return;

  try {
    const channel = findConfiguredChannel(context.uploadConfig, 'webdav', sourceMetadata);
    if (!channel) return;

    if (channel.publicUrl && sourceMetadata.WebDAVFilePath) {
      view.WebDAVPublicUrl = buildWebDAVUrl(channel.publicUrl, sourceMetadata.WebDAVFilePath);
    }
  } catch (error) {
    console.warn('Failed to enrich WebDAV metadata:', (error as Error).message);
  }
}

/**
 * S3 凭据形状（供 buildS3Location 使用）
 */
interface S3LocationCredentials {
  endpoint: string | undefined;
  bucketName: string | undefined;
  pathStyle: boolean;
}

export function buildS3Location(credentials: S3LocationCredentials, key: string): string {
  const endpointHost = stripEndpointProtocol(credentials.endpoint);
  if (!endpointHost || !credentials.bucketName || !key) return '';

  if (credentials.pathStyle) {
    return `https://${endpointHost}/${credentials.bucketName}/${key}`;
  }

  return `https://${credentials.bucketName}.${endpointHost}/${key}`;
}

export function buildCdnFileUrl(cdnDomain: string | undefined, key: string): string {
  if (!cdnDomain || !key) return '';
  return `${String(cdnDomain).replace(/\/+$/, '')}/${key}`;
}

function stripEndpointProtocol(endpoint: string | undefined): string {
  return String(endpoint || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}
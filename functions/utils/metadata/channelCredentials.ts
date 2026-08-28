import { findConfiguredChannel, loadChannelConfig } from './channelConfig.js';
import { normalizeWebDAVHeaders } from '../storage/webdavAPI.js';
import type { FileMetadata, ChannelGroupKey, Env } from '../../types';

/** 渠道凭据解析结果（统一形状：source 区分 config / missing） */
export interface ResolvedCredentials {
  source: 'config' | 'missing';
  [key: string]: unknown;
}

/** S3 渠道凭据 */
export interface S3Credentials extends ResolvedCredentials {
  endpoint?: string;
  region?: string;
  bucketName?: string;
  pathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  cdnDomain?: string;
  key?: string;
}

/** Telegram 渠道凭据 */
export interface TelegramCredentials extends ResolvedCredentials {
  botToken?: string;
  chatId?: string;
  proxyUrl?: string;
  fileId?: unknown;
}

/** Discord 渠道凭据 */
export interface DiscordCredentials extends ResolvedCredentials {
  botToken?: string;
  channelId?: string;
  proxyUrl?: string;
  messageId?: unknown;
}

/** HuggingFace 渠道凭据 */
export interface HuggingFaceCredentials extends ResolvedCredentials {
  token?: string;
  repo?: string;
  isPrivate?: boolean;
  filePath?: string;
}

/** WebDAV 渠道凭据 */
export interface WebDAVCredentials extends ResolvedCredentials {
  baseUrl?: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
  createDirectory?: boolean;
  publicUrl?: string;
  filePath?: string;
}

export async function resolveS3Credentials(
  db: { get(key: string): Promise<string | null> },
  env: Env,
  metadata: FileMetadata = {},
): Promise<S3Credentials> {
  const channel = await loadConfiguredChannel(db, env, 's3', metadata);
  if (channel) {
    return {
      source: 'config',
      endpoint: channel.endpoint,
      region: channel.region || 'auto',
      bucketName: channel.bucketName,
      pathStyle: channel.pathStyle || false,
      accessKeyId: channel.accessKeyId,
      secretAccessKey: channel.secretAccessKey,
      cdnDomain: channel.cdnDomain || '',
      key: metadata.S3FileKey,
    };
  }

  return missingCredentials({
    endpoint: '',
    region: 'auto',
    bucketName: '',
    pathStyle: false,
    accessKeyId: '',
    secretAccessKey: '',
    cdnDomain: '',
    key: metadata.S3FileKey,
  }) as S3Credentials;
}

export async function resolveTelegramCredentials(
  db: { get(key: string): Promise<string | null> },
  env: Env,
  metadata: FileMetadata = {},
): Promise<TelegramCredentials> {
  const channel = await loadConfiguredChannel(db, env, 'telegram', metadata);
  if (channel) {
    return {
      source: 'config',
      botToken: channel.botToken,
      chatId: channel.chatId,
      proxyUrl: channel.proxyUrl || '',
      fileId: metadata.TgFileId,
    };
  }

  return missingCredentials({
    botToken: '',
    chatId: '',
    proxyUrl: '',
    fileId: metadata.TelegramFileId,
  }) as TelegramCredentials;
}

export async function resolveDiscordCredentials(
  db: { get(key: string): Promise<string | null> },
  env: Env,
  metadata: FileMetadata = {},
): Promise<DiscordCredentials> {
  const channel = await loadConfiguredChannel(db, env, 'discord', metadata);
  if (channel) {
    return {
      source: 'config',
      botToken: channel.botToken,
      channelId: channel.channelId,
      proxyUrl: channel.proxyUrl || '',
      messageId: metadata.DiscordMessageId,
    };
  }

  return missingCredentials({
    botToken: '',
    channelId: '',
    proxyUrl: '',
    messageId: metadata.DiscordMessageId,
  }) as DiscordCredentials;
}

export async function resolveHuggingFaceCredentials(
  db: { get(key: string): Promise<string | null> },
  env: Env,
  metadata: FileMetadata = {},
): Promise<HuggingFaceCredentials> {
  const channel = await loadConfiguredChannel(db, env, 'huggingface', metadata);
  if (channel) {
    return {
      source: 'config',
      token: channel.token,
      repo: channel.repo,
      isPrivate: channel.isPrivate || false,
      filePath: metadata.HfFilePath,
    };
  }

  return missingCredentials({
    token: '',
    repo: '',
    isPrivate: false,
    filePath: metadata.HfFilePath,
  }) as HuggingFaceCredentials;
}

export async function resolveWebDAVCredentials(
  db: { get(key: string): Promise<string | null> },
  env: Env,
  metadata: FileMetadata = {},
): Promise<WebDAVCredentials> {
  const channel = await loadConfiguredChannel(db, env, 'webdav', metadata);
  if (channel) {
    return {
      source: 'config',
      baseUrl: channel.baseUrl || '',
      username: channel.username || '',
      password: channel.password || '',
      headers: normalizeWebDAVHeaders(channel.headers || {}),
      createDirectory: channel.createDirectory !== false,
      publicUrl: channel.publicUrl || '',
      filePath: metadata.WebDAVFilePath,
    };
  }

  return missingCredentials({
    baseUrl: '',
    username: '',
    password: '',
    headers: {},
    createDirectory: true,
    publicUrl: '',
    filePath: metadata.WebDAVFilePath,
  }) as WebDAVCredentials;
}

async function loadConfiguredChannel<K extends ChannelGroupKey>(
  db: { get(key: string): Promise<string | null> },
  env: Env,
  groupName: K,
  metadata: FileMetadata = {},
) {
  const uploadConfig = await loadChannelConfig(db, env, `${groupName} credentials`);
  return findConfiguredChannel(uploadConfig, groupName, metadata);
}

function missingCredentials(fields: Record<string, unknown>): ResolvedCredentials {
  return {
    source: 'missing',
    ...fields,
  };
}
import { getUploadConfig } from '../../api/manage/sysConfig/upload.js';
import type { UploadConfig, FileMetadata, ChannelGroupKey } from '../../types';

export async function loadChannelConfig(
  db: { get(key: string): Promise<string | null> },
  env: unknown,
  logContext = 'channel config',
): Promise<UploadConfig | null> {
  try {
    return await getUploadConfig(db, env);
  } catch (error) {
    console.warn(`Failed to load upload config for ${logContext}:`, (error as Error).message);
    return null;
  }
}

/**
 * 按渠道分组查找已配置的渠道
 * @returns 找到的渠道，或 null
 */
export function findConfiguredChannel<K extends ChannelGroupKey>(
  uploadConfig: UploadConfig | null,
  groupName: K,
  metadata: FileMetadata = {},
): UploadConfig[K]['channels'][number] | null {
  const channelName = getEffectiveChannelName(groupName, metadata);
  if (!channelName || !uploadConfig) return null;

  const channels = uploadConfig[groupName]?.channels || [];
  return channels.find(channel => channel.name === channelName) || null;
}

export function getEffectiveChannelName(groupName: string, metadata: FileMetadata = {}): string {
  if (metadata.ChannelName) return metadata.ChannelName as string;

  if (groupName === 'telegram' && (metadata.Channel === 'Telegram' || metadata.Channel === 'TelegramNew')) {
    return 'Telegram_env';
  }

  return '';
}
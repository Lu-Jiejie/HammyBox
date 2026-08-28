const SENSITIVE_METADATA_KEYS = [
  'S3AccessKeyId',
  'S3SecretAccessKey',
  'TgBotToken',
  'DiscordBotToken',
  'HfToken',
  'WebDAVUsername',
  'WebDAVPassword',
  'WebDAVHeaders',
];

const CONFIG_DERIVED_METADATA_KEYS = [
  'S3Location',
  'S3Endpoint',
  'S3PathStyle',
  'S3Region',
  'S3BucketName',
  'S3CdnFileUrl',
  'TgChatId',
  'TgProxyUrl',
  'DiscordChannelId',
  'DiscordProxyUrl',
  'HfRepo',
  'HfIsPrivate',
  'HfFileUrl',
  'WebDAVBaseUrl',
  'WebDAVPublicBaseUrl',
  'WebDAVPublicUrl',
];

/**
 * 从元数据中剔除敏感字段（返回副本）
 */
export function stripSensitiveMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') {
    return metadata;
  }

  const stripped = { ...metadata };
  return stripSensitiveMetadataInPlace(stripped);
}

/**
 * 从元数据中剔除敏感字段（原地修改）
 */
export function stripSensitiveMetadataInPlace(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') {
    return metadata;
  }

  for (const key of SENSITIVE_METADATA_KEYS) {
    delete metadata[key];
  }

  if (metadata.WebDAVBaseUrl) {
    const safeBaseUrl = stripUrlUserinfo(metadata.WebDAVBaseUrl);
    if (safeBaseUrl) {
      metadata.WebDAVBaseUrl = safeBaseUrl;
    } else {
      delete metadata.WebDAVBaseUrl;
    }
  }

  return metadata;
}

/**
 * 剔除由渠道配置派生的字段（返回副本）
 */
export function stripConfigDerivedMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') {
    return metadata;
  }

  const stripped = { ...metadata };
  return stripConfigDerivedMetadataInPlace(stripped);
}

/**
 * 剔除由渠道配置派生的字段（原地修改）
 */
export function stripConfigDerivedMetadataInPlace(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') {
    return metadata;
  }

  for (const key of CONFIG_DERIVED_METADATA_KEYS) {
    delete metadata[key];
  }

  return metadata;
}

/**
 * 清理持久化前的元数据（返回副本）：剔除敏感与配置派生字段
 */
export function cleanPersistedMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') {
    return metadata;
  }

  const cleaned = { ...metadata };
  return cleanPersistedMetadataInPlace(cleaned);
}

/**
 * 清理持久化前的元数据（原地修改）：剔除敏感与配置派生字段
 */
export function cleanPersistedMetadataInPlace(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  stripSensitiveMetadataInPlace(metadata);
  stripConfigDerivedMetadataInPlace(metadata);
  return metadata;
}

function stripUrlUserinfo(value: unknown): string {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '';
  }
}
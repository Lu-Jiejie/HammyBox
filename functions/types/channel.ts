/**
 * 存储渠道（Channel）类型
 *
 * 六类渠道：telegram / cfr2(R2) / s3 / discord / huggingface / webdav
 * 每类渠道的字段来自于 getUploadConfig 的构造逻辑与上传代码的使用点。
 */

/** 渠道类型 */
export type ChannelType = 'telegram' | 'cfr2' | 's3' | 'discord' | 'huggingface' | 'webdav';

/** 渠道容量限制（quota） */
export interface ChannelQuota {
  enabled?: boolean;
  limitGB?: number;
  threshold?: number;
}

/** 负载均衡配置 */
export interface LoadBalanceConfig {
  enabled?: boolean;
  channels?: unknown[];
}

/** 渠道公共字段 */
export interface BaseChannel {
  id?: number;
  name: string;
  type: ChannelType;
  savePath?: string;
  enabled: boolean;
  fixed?: boolean;
  quota?: ChannelQuota;
}

/** Telegram 渠道 */
export interface TelegramChannel extends BaseChannel {
  type: 'telegram';
  botToken?: string;
  chatId?: string;
  proxyUrl?: string;
}

/** R2 渠道 */
export interface R2Channel extends BaseChannel {
  type: 'cfr2';
  publicUrl?: string;
}

/** S3 渠道 */
export interface S3Channel extends BaseChannel {
  type: 's3';
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucketName?: string;
  endpoint?: string;
  pathStyle?: boolean;
  cdnDomain?: string;
}

/** Discord 渠道 */
export interface DiscordChannel extends BaseChannel {
  type: 'discord';
  botToken?: string;
  channelId?: string;
  proxyUrl?: string;
  isNitro?: boolean;
}

/** HuggingFace 渠道 */
export interface HuggingFaceChannel extends BaseChannel {
  type: 'huggingface';
  token?: string;
  repo?: string;
  isPrivate?: boolean;
}

/** WebDAV 渠道 */
export interface WebDAVChannel extends BaseChannel {
  type: 'webdav';
  baseUrl?: string;
  username?: string;
  password?: string;
  publicUrl?: string;
  headers?: Record<string, string>;
  createDirectory?: boolean;
}

/** 全部渠道联合类型 */
export type AnyChannel =
  | TelegramChannel
  | R2Channel
  | S3Channel
  | DiscordChannel
  | HuggingFaceChannel
  | WebDAVChannel;

/** 某一类渠道的分组（channels + loadBalance） */
export interface ChannelGroup<T extends AnyChannel = AnyChannel> {
  channels: T[];
  loadBalance?: LoadBalanceConfig;
}

/** 上传配置中六个渠道分组的映射 */
export interface UploadChannelGroups {
  telegram: ChannelGroup<TelegramChannel>;
  cfr2: ChannelGroup<R2Channel>;
  s3: ChannelGroup<S3Channel>;
  discord: ChannelGroup<DiscordChannel>;
  huggingface: ChannelGroup<HuggingFaceChannel>;
  webdav: ChannelGroup<WebDAVChannel>;
}
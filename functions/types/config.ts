/**
 * 系统配置类型
 *
 * 对应数据库 KV/D1 中的四个配置键：
 * - manage@sysConfig@upload
 * - manage@sysConfig@security
 * - manage@sysConfig@others
 * - manage@sysConfig@page
 * 形状与 get*Config 函数的返回值保持一致。
 */

import type { UploadChannelGroups } from './channel';

/** 上传配置（manage@sysConfig@upload） */
export type UploadConfig = UploadChannelGroups;

// ==================== 安全配置（manage@sysConfig@security） ====================

/** API Token 权限 */
export type ApiTokenPermission = 'list' | 'upload' | 'delete' | 'manage';

/** API Token 记录 */
export interface ApiToken {
  id: string;
  name: string;
  token: string;
  owner: string;
  permissions: ApiTokenPermission[];
  type: 'user' | 'internal' | 'system' | string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  autoDelete: boolean;
}

/** 安全配置：认证部分 */
export interface SecurityAuthConfig {
  /** 登录密码（已哈希） */
  password?: string;
  /** 前端标记：是否已设置密码（读时注入，写前清除） */
  _hasPassword?: boolean;
  /** 前端标记：清除密码（写时识别） */
  _clear?: boolean;
}

/** 安全配置：上传审核部分 */
export interface SecurityUploadConfig {
  moderate?: {
    enabled?: boolean;
    /** 审核渠道：moderatecontent.com | nsfwjs */
    channel?: string;
    moderateContentApiKey?: string;
    nsfwApiPath?: string;
  };
}

/** 安全配置：访问控制部分 */
export interface SecurityAccessConfig {
  sessionSecure?: boolean;
  /** 会话有效期（天） */
  sessionMaxAge?: number;
  refererCheck?: {
    enabled?: boolean;
    allowedDomains?: string[];
    allowEmptyReferer?: boolean;
  };
  whiteListMode?: {
    enabled?: boolean;
  };
}

/** 安全配置（manage@sysConfig@security） */
export interface SecurityConfig {
  auth?: SecurityAuthConfig;
  upload?: SecurityUploadConfig;
  access?: SecurityAccessConfig;
  apiTokens?: {
    tokens: Record<string, ApiToken>;
  };
}

// ==================== 其他配置（manage@sysConfig@others） ====================

/** 遥测配置 */
export interface TelemetryConfig {
  enabled?: boolean;
  fixed?: boolean;
}

/** 随机图 API 配置 */
export interface RandomImageAPIConfig {
  enabled?: boolean;
  allowedDir?: string;
  fixed?: boolean;
}

/** Cloudflare API Token 配置（缓存清理用） */
export interface CloudflareApiTokenConfig {
  CF_ZONE_ID?: string;
  CF_EMAIL?: string;
  CF_API_KEY?: string;
  fixed?: boolean;
}

/** WebDAV 配置 */
export interface WebDAVConfig {
  enabled?: boolean;
  username?: string;
  password?: string;
  uploadChannel?: string;
  channelName?: string;
  internalToken?: string;
  internalTokenId?: string;
  fixed?: boolean;
}

/** 公开浏览配置 */
export interface PublicBrowseConfig {
  enabled?: boolean;
  allowedDir?: string;
  fixed?: boolean;
}

/** 其他配置（manage@sysConfig@others） */
export interface OthersConfig {
  telemetry?: TelemetryConfig;
  randomImageAPI?: RandomImageAPIConfig;
  cloudflareApiToken?: CloudflareApiTokenConfig;
  webDAV?: WebDAVConfig;
  publicBrowse?: PublicBrowseConfig;
}

// ==================== 页面配置（manage@sysConfig@page） ====================

/** 页面配置项 */
export interface PageConfigItem {
  id: string;
  value: string;
}

/** 页面配置（manage@sysConfig@page，前端透传） */
export interface PageConfig {
  config: PageConfigItem[];
}

// ==================== 加载配置的统一函数签名 ====================

/** 配置存储读写接口（databaseAdapter 提供的最小集合） */
export interface ConfigStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
}

/** 配置加载函数签名 */
export type ConfigLoader<T> = (db: ConfigStore, env: unknown) => Promise<T>;
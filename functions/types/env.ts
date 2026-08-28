/**
 * Cloudflare Worker/Pages 环境绑定类型
 *
 * 字段来源：代码中所有 `env.xxx` 的使用点（grep 汇总）。
 * CF Pages/Workers 运行时注入：Storage bindings（KV/D1/R2）+ 字符串变量。
 */

/**
 * 数据库 / 存储绑定
 */
export interface StorageBindings {
  /** KV 存储绑定（与 D1 二选一） */
  hammybox_kv?: KVNamespace;
  /** D1 数据库绑定（与 KV 二选一） */
  hammybox_d1?: D1Database;
  /** R2 存储桶绑定 */
  hammybox_r2?: R2Bucket;
}

/**
 * 环境字符串变量（业务配置，部分可由管理面板覆盖）
 */
export interface EnvVars {
  /** 认证初始密码（未在数据库配置密码时使用） */
  BASIC_PASSWORD?: string;
  /** 远程遥测采样率（0~1） */
  sampleRate?: number | string;

  // ===== Telegram =====
  TG_BOT_TOKEN?: string;
  TG_CHAT_ID?: string;
  TG_PROXY_URL?: string;

  // ===== R2 =====
  R2PublicUrl?: string;

  // ===== S3 =====
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_REGION?: string;
  S3_BUCKET_NAME?: string;
  S3_ENDPOINT?: string;
  S3_PATH_STYLE?: string;
  S3_CDN_DOMAIN?: string;

  // ===== Discord =====
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CHANNEL_ID?: string;
  DISCORD_PROXY_URL?: string;
  DISCORD_IS_NITRO?: string;

  // ===== HuggingFace =====
  HF_TOKEN?: string;
  HF_REPO?: string;
  HF_PRIVATE?: string;

  // ===== WebDAV =====
  WEBDAV_BASE_URL?: string;
  WEBDAV_USERNAME?: string;
  WEBDAV_PASSWORD?: string;
  WEBDAV_PUBLIC_URL?: string;
  /** 额外请求头，JSON 字符串或对象 */
  WEBDAV_HEADERS?: string | Record<string, string>;
  WEBDAV_CREATE_DIRECTORY?: string;

  // ===== 安全 =====
  /** 重置密码密钥 */
  RESET_KEY?: string;
  /** 内容审核 API Key */
  ModerateContentApiKey?: string;

  // ===== 功能开关 =====
  /** 是否禁用遥测（'true' 禁用） */
  disable_telemetry?: string;
  /** 是否允许随机图 API（'true' 允许） */
  AllowRandom?: string;

  // ===== Cloudflare API（缓存清理） =====
  CF_ZONE_ID?: string;
  CF_EMAIL?: string;
  CF_API_KEY?: string;

  /** 开发模式（'true' 开启，本地调试用） */
  dev_mode?: string;

  /** 其他业务变量 */
  [key: string]: string | number | boolean | Record<string, string> | undefined;
}

/**
 * 完整环境对象（CF 运行时注入）
 */
export type Env = StorageBindings & EnvVars;
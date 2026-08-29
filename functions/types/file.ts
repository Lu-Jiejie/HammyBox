/**
 * 文件元数据 / 索引类型
 *
 * 文件元数据（FileMetadata）是上传时写入、读取时展示的核心数据结构，
 * 字段使用 PascalCase 命名（Channel / FileName / TimeStamp ...）。
 */

/**
 * 文件元数据（KV value 的 metadata，或 D1 files 表解析后的对象）
 */
export interface FileMetadata {
  /** 文件名（即存储名/下载名，上传时按命名格式生成；重命名时同步更新） */
  FileName?: string;
  /** 原始本地文件名（上传时的本地名，供管理端参考展示） */
  OriginalFileName?: string;
  /** MIME 类型 */
  FileType?: string;
  /** 文件大小（MB，字符串形式，如 "12.34"） */
  FileSize?: string | number;
  /** 时间戳（ms） */
  TimeStamp?: number;
  /** 所属文件夹路径（/ 开头） */
  Folder?: string;
  /** 存储渠道类型：CloudflareR2 / S3 / Telegram / Discord / HuggingFace / WebDAV / External */
  Channel?: string;
  /** 渠道名称（对应渠道配置中的 name） */
  ChannelName?: string;
  /** 分块上传标记 */
  IsChunked?: boolean;
  /** 分块总数 */
  TotalChunks?: number;
  /** S3 文件键 */
  S3FileKey?: string;
  /** HuggingFace 文件路径 */
  HfFilePath?: string;
  /** WebDAV 文件路径 */
  WebDAVFilePath?: string;
  /** 类型（folder 等特殊条目） */
  Type?: string;
  /** 上传 IP */
  UploadIP?: string;
  /** 上传地址 */
  UploadAddress?: string;
  /** 列表类型 */
  ListType?: string;
  /** 标签 */
  Label?: string;
  /** 标签数组（如 ['blocked', 'whitelist']，用于访问控制） */
  Tags?: string[];
  /** Telegram 文件 ID 等渠道特定字段 */
  TelegramFileId?: string;
  /** 额外渠道特定字段 */
  [key: string]: unknown;
}

/**
 * 索引中的文件条目
 */
export interface IndexFileEntry {
  id: string;
  metadata: FileMetadata;
}

/**
 * 索引元数据（manage@index@meta）
 */
export interface IndexMeta {
  lastUpdated?: number;
  totalCount?: number;
  lastOperationId?: string;
  chunkCount?: number;
  chunkSize?: number;
  /** 各渠道容量统计 */
  channelStats?: Record<string, { usedMB: number; fileCount: number }>;
}

/**
 * 原子索引操作（manage@index@operation_*）
 */
export interface IndexOperation {
  type: 'add' | 'remove' | 'move' | 'batch_add' | 'batch_remove' | 'batch_move';
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * KV getWithMetadata 的结果
 */
export interface KVEntryWithMeta<Value = string, Metadata = FileMetadata> {
  value: Value | null;
  metadata?: Metadata | null;
  key?: string;
}

/**
 * D1 files 表行（getFile / 列表查询的返回）
 */
export interface D1FileRow {
  id: string;
  value: string;
  metadata: string;
  file_name?: string | null;
  file_type?: string | null;
  file_size?: string | null;
  timestamp?: number | null;
  folder?: string | null;
  channel?: string | null;
  channel_name?: string | null;
  is_chunked?: number | boolean | null;
}
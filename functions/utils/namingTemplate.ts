/**
 * 文件命名模板引擎（服务端）
 *
 * 用户通过"文件命名格式"配置存储名（= 下载名 = 文件名，三者一致）。
 * 模板支持占位符展开，占位符与前端 utils/aliasTemplate.ts 保持一致：
 *
 *   {YYYY} {MM} {DD} {HH} {mm} {ss}  时间（本地时区）
 *   {Timestamp}                      毫秒时间戳
 *   {Name}                           原始文件名（去扩展名）
 *   {Origin}                         原始完整文件名（含扩展名）
 *   {Ext}                            文件扩展名（含点，如 .png）
 *   {Random}                         6 位随机
 *   {Random:N}                       N 位随机（如 {Random:12}）
 *
 * 模板内可含 "/" 生成多级目录路径，如 {YYYY}/{MM}/{DD}/{Name}{Ext}
 */

const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function randomPart(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export interface NameTemplateContext {
  /** 原始文件名（含扩展名），如 photo1.png */
  fileName: string;
  /** 文件扩展名（不含点），如 png */
  fileExt: string;
  /** 展开时的基准时间（默认当前时间） */
  now?: Date;
}

/** 展开命名模板，返回可能含 "/" 的原始结果（未 sanitize，调用方按需处理） */
export function expandNameTemplate(template: string, ctx: NameTemplateContext): string {
  const now = ctx.now || new Date();
  const dot = ctx.fileExt ? `.${ctx.fileExt}` : '';
  const origin = ctx.fileName;
  const name = origin.includes('.') ? origin.slice(0, origin.lastIndexOf('.')) : origin;

  return template.replace(PLACEHOLDER_PATTERN, (_match, token: string) => {
    // 处理 {Random:N} 与 {Random}
    const randomMatch = token.match(/^Random(?::(\d+))?$/);
    if (randomMatch) {
      const length = randomMatch[1] ? Math.min(parseInt(randomMatch[1], 10) || 6, 64) : 6;
      return randomPart(length);
    }

    switch (token) {
      case 'YYYY': return String(now.getFullYear());
      case 'MM': return pad(now.getMonth() + 1);
      case 'DD': return pad(now.getDate());
      case 'HH': return pad(now.getHours());
      case 'mm': return pad(now.getMinutes());
      case 'ss': return pad(now.getSeconds());
      case 'Timestamp': return String(now.getTime());
      case 'Name': return name;
      case 'Origin': return origin;
      case 'Ext': return dot;
      default: return `{${token}}`; // 未知占位符原样保留
    }
  });
}

/**
 * 对模板展开结果做安全处理：
 * - 每段去除非法字符（与 sanitizeFileName 一致），保留 "/" 生成多级路径
 * - 过滤空段，防止 // 或首尾 /
 * - 拒绝路径穿越（..）与保留前缀
 */
export function sanitizeTemplateResult(raw: string): string {
  const unsafeCharsRe = /[\\\/:\*\?"'<>\| \(\)\[\]\{\}#%\^`~;@&=\+\$,]/g;

  const segments = raw
    .split('/')
    .map(seg => seg.replace(unsafeCharsRe, '_'))
    .filter(seg => seg.length > 0 && seg !== '.' && seg !== '..');

  if (segments.length === 0) {
    return '';
  }

  const result = segments.join('/');

  // 拒绝保留前缀（与 sanitizeFileName 一致）
  if (result.startsWith('folder:') || result.startsWith('manage@') || result.startsWith('chunk_')) {
    throw new Error('Generated name cannot start with reserved prefix');
  }

  return result;
}

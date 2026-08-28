// API Token权限验证工具函数
import { getTokenData } from '../../api/manage/apiTokens.js';
import { isExpired } from './tokenExpiration.js';

/**
 * Token 数据的最小结构（与 getTokenData 返回值对齐）
 */
interface TokenData {
  expiresAt: string | null;
  permissions: string[];
}

/**
 * 验证API Token权限
 * @param request 请求对象
 * @param db 数据库适配器（只需 get 方法）
 * @param requiredPermission 需要的权限 ('upload', 'delete', 'list')
 * @returns { valid, error? }
 */
export async function validateApiToken(
  request: Request,
  db: { get(key: string): Promise<string | null> },
  requiredPermission: string | null,
): Promise<{ valid: boolean; error?: string }> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    return { valid: false, error: '缺少Authorization头' };
  }

  let token: string | null;

  // 支持两种格式: "Bearer token" 或 "token"
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    token = authHeader;
  }

  if (!token) {
    return { valid: false, error: '无效的Token格式' };
  }

  // 获取完整Token数据
  const tokenData = await getTokenData(db as any, token);

  if (!tokenData) {
    return { valid: false, error: '无效的Token' };
  }

  // 检查Token是否已过期
  if (isExpired(tokenData.expiresAt)) {
    return { valid: false, error: 'Token 已过期' };
  }

  // 检查权限，如果不需要特定权限（requiredPermission为null），则只要token有效就通过
  if (requiredPermission !== null && !tokenData.permissions.includes(requiredPermission as any)) {
    return { valid: false, error: `缺少${requiredPermission}权限` };
  }

  return { valid: true };
}

/**
 * 从请求中提取Token信息
 * @param request 请求对象
 * @param kv KV存储（或实现 get 的存储对象）
 * @returns Token信息或null
 */
export async function getTokenInfo(
  request: Request,
  kv: { get(key: string): Promise<string | null> },
): Promise<(TokenData & Record<string, unknown>) | null> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    return null;
  }

  let token: string | null;

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    token = authHeader;
  }

  if (!token) {
    return null;
  }

  // 从KV中获取Token信息
  const settingsStr = await kv.get('manage@sysConfig@security');
  const settings = settingsStr ? JSON.parse(settingsStr) : {};
  const tokens = settings.apiTokens?.tokens || {};

  // 查找匹配的token
  for (const tokenId in tokens) {
    if (tokens[tokenId].token === token) {
      const t = tokens[tokenId];
      return {
        ...t,
        expiresAt: t.expiresAt ?? null,
        autoDelete: t.autoDelete ?? false,
      };
    }
  }

  return null;
}
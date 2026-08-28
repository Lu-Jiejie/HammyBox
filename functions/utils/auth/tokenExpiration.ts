/**
 * Token 过期时间工具模块（后端）
 * 提供 Token 过期判定和自动删除过滤功能
 */

/**
 * 判定 Token 是否已过期
 * @param expiresAt 过期时间 ISO 8601 字符串，null 表示永不过期
 * @param now 当前时间
 * @returns 是否已过期
 */
export function isExpired(expiresAt: string | null | undefined, now: Date | string | number = new Date()): boolean {
  if (expiresAt === null || expiresAt === undefined) {
    return false;
  }
  const expiresDate = new Date(expiresAt);
  const currentTime = now instanceof Date ? now : new Date(now);
  return currentTime.getTime() > expiresDate.getTime();
}

/**
 * 过滤出需要自动删除的 Token 并返回保留的 Token 列表
 * @param tokens Token 数组
 * @param now 当前时间
 * @returns { toDelete, toKeep }
 */
export function filterAutoDeleteTokens<T extends { expiresAt: string | null; autoDelete?: boolean }>(
  tokens: T[],
  now: Date | string | number = new Date(),
): { toDelete: T[]; toKeep: T[] } {
  const toDelete: T[] = [];
  const toKeep: T[] = [];

  for (const token of tokens) {
    if (isExpired(token.expiresAt, now) && token.autoDelete === true) {
      toDelete.push(token);
    } else {
      toKeep.push(token);
    }
  }

  return { toDelete, toKeep };
}
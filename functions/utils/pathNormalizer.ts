/**
 * 规范化文件夹路径
 *
 * 规则：
 * 1. 空/null/undefined → ""
 * 2. 去除前后空格
 * 3. 反斜杠转正斜杠
 * 4. 去除 .. 路径穿越
 * 5. 去除多个连续斜杠
 * 6. 去除前置斜杠
 * 7. 确保后置斜杠（非空时）
 * 8. 验证路径不包含非法字符和保留前缀
 *
 * 示例：
 * - "" → ""
 * - null/undefined → ""
 * - "/" → ""
 * - "photos" → "photos/"
 * - "photos/" → "photos/"
 * - "/photos" → "photos/"
 * - "photos//2024" → "photos/2024/"
 * - "photos/../hack" → "photos/_/hack/"
 * - "photos\2024" → "photos/2024/"
 */
export function normalizeFolderPath(path: string | null | undefined): string {
    if (!path || path === null || path === undefined) return '';

    const normalized = String(path).trim()
        .replace(/\\/g, '/')           // 反斜杠 → 正斜杠
        .replace(/\.\./g, '_')         // 防止路径穿越
        .replace(/\/+/g, '/')          // 多个斜杠 → 单个
        .replace(/^\/+/, '')           // 去除前置斜杠
        .replace(/\/+$/, '');          // 去除后置斜杠

    if (normalized) {
        validatePathSafety(normalized);
        return normalized + '/';
    }
    return '';
}

/**
 * 验证路径安全性
 * @param path 待验证的路径（不含末尾斜杠）
 * @throws {Error} 如果路径包含非法字符或保留前缀
 */
export function validatePathSafety(path: string): void {
    // 检查非法字符：冒号、尖括号、引号、问号、星号、管道符
    const illegalChars = /[<>:"|?*]/;
    if (illegalChars.test(path)) {
        throw new Error('Path contains illegal characters: < > : " | ? *');
    }

    // 检查每个路径段是否以保留前缀开头
    const segments = path.split('/');
    for (const segment of segments) {
        if (!segment) continue; // 跳过空段

        // 检查保留前缀
        if (segment.startsWith('folder:')) {
            throw new Error('Path cannot start with reserved prefix: folder:');
        }
        if (segment.startsWith('manage@')) {
            throw new Error('Path cannot start with reserved prefix: manage@');
        }
        if (segment.startsWith('chunk_')) {
            throw new Error('Path cannot start with reserved prefix: chunk_');
        }
    }
}
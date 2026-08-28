/**
 * 密码哈希工具
 * 使用 Web Crypto API 的 PBKDF2 (100,000 iterations) + 盐值进行密码哈希
 * 向后兼容旧版 SHA-256 哈希和明文密码存储
 */

const HASH_PREFIX_SHA256 = '$sha256$';
const HASH_PREFIX_PBKDF2 = '$pbkdf2$';
const PBKDF2_ITERATIONS = 100000;

/**
 * 生成随机盐值
 * @returns 16字节的十六进制盐值
 */
function generateSalt(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 将十六进制字符串转为 Uint8Array
 * @param hex
 * @returns Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

/**
 * 将 ArrayBuffer 转为十六进制字符串
 * @param buffer
 * @returns string
 */
function bufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 使用 PBKDF2 对密码进行哈希（推荐，新密码默认使用）
 * @param password 明文密码
 * @param salt 盐值（十六进制），不传则自动生成
 * @returns 哈希后的密码字符串（格式：$pbkdf2$salt$hash）
 */
export async function hashPassword(password: string, salt: string | null = null): Promise<string> {
    if (!salt) {
        salt = generateSalt();
    }
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );
    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: hexToBytes(salt),
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256',
        },
        keyMaterial,
        256 // 32 bytes
    );
    const hashHex = bufferToHex(derivedBits);
    return `${HASH_PREFIX_PBKDF2}${salt}$${hashHex}`;
}

/**
 * 使用旧版 SHA-256 对密码进行哈希（仅用于验证旧哈希）
 * @param password 明文密码
 * @param salt 盐值
 * @returns 哈希后的密码字符串（格式：$sha256$salt$hash）
 */
async function hashPasswordSHA256(password: string, salt: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(salt + password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashHex = bufferToHex(hashBuffer);
    return `${HASH_PREFIX_SHA256}${salt}$${hashHex}`;
}

/**
 * 判断密码是否已经是哈希格式
 * @param password 密码字符串
 * @returns boolean
 */
export function isHashed(password: string): boolean {
    return typeof password === 'string' &&
        (password.startsWith(HASH_PREFIX_PBKDF2) || password.startsWith(HASH_PREFIX_SHA256));
}

/**
 * 判断哈希是否为旧版 SHA-256 格式（需要升级）
 * @param password 密码字符串
 * @returns boolean
 */
export function needsRehash(password: string): boolean {
    return typeof password === 'string' && password.startsWith(HASH_PREFIX_SHA256);
}

/**
 * 验证密码是否匹配
 * 兼容 PBKDF2、SHA-256 哈希和明文密码三种存储格式
 * @param inputPassword 用户输入的明文密码
 * @param storedPassword 数据库中存储的密码（可能是明文、SHA-256 哈希或 PBKDF2 哈希）
 * @returns 是否匹配
 */
export async function verifyPassword(inputPassword: string, storedPassword: string): Promise<boolean> {
    if (!storedPassword || !inputPassword) {
        return false;
    }

    if (storedPassword.startsWith(HASH_PREFIX_PBKDF2)) {
        // PBKDF2 哈希格式：$pbkdf2$salt$hash
        const parts = storedPassword.split('$');
        // ['', 'pbkdf2', salt, hash]
        if (parts.length !== 4) {
            return false;
        }
        const salt = parts[2];
        const expectedHash = await hashPassword(inputPassword, salt);
        return timingSafeEqual(expectedHash, storedPassword);
    } else if (storedPassword.startsWith(HASH_PREFIX_SHA256)) {
        // 旧版 SHA-256 哈希格式：$sha256$salt$hash
        const parts = storedPassword.split('$');
        // ['', 'sha256', salt, hash]
        if (parts.length !== 4) {
            return false;
        }
        const salt = parts[2];
        const expectedHash = await hashPasswordSHA256(inputPassword, salt);
        return timingSafeEqual(expectedHash, storedPassword);
    } else {
        // 存储的是明文密码，直接比对（向后兼容）
        return inputPassword === storedPassword;
    }
}

/**
 * 恒定时间字符串比较，防止时序攻击
 * @param a
 * @param b
 * @returns boolean
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const encoder = new TextEncoder();
    const bufA = encoder.encode(a);
    const bufB = encoder.encode(b);
    let result = 0;
    for (let i = 0; i < bufA.length; i++) {
        result |= bufA[i] ^ bufB[i];
    }
    return result === 0;
}

/**
 * 生成安全的会话 Token
 * @returns 随机会话 Token
 */
export function generateSessionToken(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 如果密码使用旧版哈希或明文存储，自动升级为 PBKDF2
 * @param db 数据库实例
 * @param plainPassword 用户输入的明文密码
 * @param storedPassword 当前存储的密码/哈希
 * @param configPath 配置路径，如 'auth.password'
 */
export async function rehashIfNeeded(
    db: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<unknown> },
    plainPassword: string,
    storedPassword: string,
    configPath: string,
): Promise<void> {
    if (!storedPassword || (storedPassword.startsWith(HASH_PREFIX_PBKDF2) && !needsRehash(storedPassword))) {
        return;
    }
    try {
        const settingsStr = await db.get('manage@sysConfig@security');
        if (!settingsStr) return;
        const settings: Record<string, unknown> = JSON.parse(settingsStr);

        // 按路径定位字段，如 'auth.password'
        const keys = configPath.split('.');
        let target: Record<string, unknown> | undefined = settings;
        for (let i = 0; i < keys.length - 1; i++) {
            target = target?.[keys[i]] as Record<string, unknown> | undefined;
        }
        if (!target) return;

        target[keys[keys.length - 1]] = await hashPassword(plainPassword);
        await db.put('manage@sysConfig@security', JSON.stringify(settings));
    } catch (e) {
        console.error(`Failed to rehash password at ${configPath}:`, e);
    }
}
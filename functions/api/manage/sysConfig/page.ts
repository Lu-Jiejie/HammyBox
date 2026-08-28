import { getDatabase } from '../../../utils/databaseAdapter.js';
import { invalidateConfigCache } from '../../../utils/sysConfig.js';

export async function onRequest(context: {
  request: Request;
  env: unknown;
  params: Record<string, unknown>;
  waitUntil: (promise: Promise<unknown>) => void;
  next: () => Promise<Response>;
  data: Record<string, unknown>;
}): Promise<Response | undefined> {
  // 页面设置相关，GET方法读取设置，POST方法保存设置
  // 后端只做透传：原样读取/保存前端提交的配置数组，不关心具体配置项与默认值
  const { request, env } = context;

  const db = getDatabase(env as any);

  // GET读取设置
  if (request.method === 'GET') {
    const settings = await getPageConfig(db, env as any);

    return new Response(JSON.stringify(settings), {
      headers: {
        'content-type': 'application/json',
      },
    });
  }

  // POST保存设置
  if (request.method === 'POST') {
    const body = await request.json();
    const settings = body;
    // 写入数据库
    await db.put('manage@sysConfig@page', JSON.stringify(settings));
    // 配置变更，立即失效缓存
    invalidateConfigCache();

    return new Response(JSON.stringify(settings), {
      headers: {
        'content-type': 'application/json',
      },
    });
  }
}

export async function getPageConfig(db: { get(key: string): Promise<string | null> }, env: unknown) {
  // 原样返回 KV 中存储的配置数组（每个元素形如 { id, value }），无存储时返回空数组
  const settingsStr = await db.get('manage@sysConfig@page');
  const settingsKV: any = settingsStr ? JSON.parse(settingsStr) : {};

  return { config: settingsKV.config || [] };
}
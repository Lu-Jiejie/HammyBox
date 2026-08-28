import sentryPlugin from '@cloudflare/pages-plugin-sentry';
import '@sentry/tracing';
import { fetchOthersConfig } from './sysConfig.js';
import { checkDatabaseConfig as checkDbConfig } from './databaseAdapter.js';
import type { Env, PagesContext } from '../types';

let disableTelemetry = false;

/**
 * Sentry 错误处理中间件
 * @param context - Pages Functions 上下文
 */
export async function errorHandling(context: PagesContext): Promise<Response> {
  // 读取KV中的设置
  const othersConfig = await fetchOthersConfig(context.env as Env);
  disableTelemetry = !othersConfig.telemetry?.enabled;

  const env = context.env as Env;
  if (!disableTelemetry) {
    context.data.telemetry = true;
    let remoteSampleRate = 0.001;
    try {
      const sampleRate = await fetchSampleRate(context);
      //check if the sample rate is not null
      if (sampleRate) {
        remoteSampleRate = sampleRate;
      }
    } catch (e) {
      console.log(e);
    }
    const sampleRate = env.sampleRate || remoteSampleRate;
    return sentryPlugin({
      dsn: 'https://44b7b443108ec6d298044b125ff89d28@o4507644548022272.ingest.us.sentry.io/4507644555100160',
      tracesSampleRate: sampleRate,
    })(context as any);
  }

  return context.next();
}

/**
 * 遥测数据采集中间件
 * @param context - Pages Functions 上下文
 */
export async function telemetryData(context: PagesContext): Promise<Response> {
  // 读取KV中的设置
  const othersConfig = await fetchOthersConfig(context.env as Env);
  disableTelemetry = !othersConfig.telemetry?.enabled;

  if (!disableTelemetry) {
    try {
      const parsedHeaders: Record<string, string> = {};
      context.request.headers.forEach((value, key) => {
        parsedHeaders[key] = value;
        //check if the value is empty
        if (value.length > 0) {
          (context.data.sentry as any).setTag(key, value);
        }
      });
      const CF = JSON.parse(JSON.stringify(context.request.cf));
      const parsedCF: Record<string, unknown> = {};
      for (const key in CF) {
        if (typeof CF[key] == 'object') {
          parsedCF[key] = JSON.stringify(CF[key]);
        } else {
          parsedCF[key] = CF[key];
          if (CF[key].length > 0) {
            (context.data.sentry as any).setTag(key, CF[key]);
          }
        }
      }
      const data = {
        headers: parsedHeaders,
        cf: parsedCF,
        url: context.request.url,
        method: context.request.method,
        redirect: context.request.redirect,
      };
      //get the url path
      const urlPath = new URL(context.request.url).pathname;
      const hostname = new URL(context.request.url).hostname;
      (context.data.sentry as any).setTag('path', urlPath);
      (context.data.sentry as any).setTag('url', data.url);
      (context.data.sentry as any).setTag('method', context.request.method);
      (context.data.sentry as any).setTag('redirect', context.request.redirect);
      (context.data.sentry as any).setContext('request', data);
      const transaction = (context.data.sentry as any).startTransaction({
        name: `${context.request.method} ${hostname}`,
      });
      //add the transaction to the context
      context.data.transaction = transaction;
      return await context.next();
    } catch (e) {
      console.log(e);
    } finally {
      (context.data as any).transaction?.finish();
    }
  }

  return context.next();
}

/**
 * 追踪数据（Sentry span 记录）
 * @param context - Pages Functions 上下文
 * @param span - 当前 span
 * @param op - 操作类型
 * @param name - 名称
 */
export async function traceData(
  context: PagesContext,
  span: any,
  op: string,
  name: string,
): Promise<void> {
  const data = context.data;
  if (data.telemetry) {
    if (span) {
      console.log('span finish');
      span.finish();
    } else {
      console.log('span start');
      span = await (data as any).transaction.startChild({ op: op, name: name });
    }
  }
}

/**
 * 从远程获取遥测采样率
 * @param context - Pages Functions 上下文
 */
async function fetchSampleRate(context: PagesContext): Promise<number | undefined> {
  const data = context.data;
  if (data.telemetry) {
    const url = 'https://frozen-sentinel.pages.dev/signal/sampleRate.json';
    const response = await fetch(url);
    const json: any = await response.json();
    return json.rate;
  }
}

/**
 * 检查数据库是否配置
 * @param context - Pages Functions 上下文
 */
export async function checkDatabaseConfig(context: PagesContext): Promise<Response> {
  const env = context.env as Env;

  const dbConfig = checkDbConfig(env);

  if (!dbConfig.configured) {
    return new Response(
      JSON.stringify({
        success: false,
        error: '数据库未配置 / Database not configured',
        message:
          '请配置 KV 存储 (env.hammybox_kv) 或 D1 数据库 (env.hammybox_d1)。 / Please configure KV storage (env.hammybox_kv) or D1 database (env.hammybox_d1).',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }

  // 继续执行
  return await context.next();
}
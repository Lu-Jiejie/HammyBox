/**
 * Cloudflare Pages Functions / Workers 请求上下文类型
 *
 * 与 generate-routes.js 构造的 context 对象保持一致：
 * request / env / params / waitUntil / passThroughOnException / next / data / functionPath
 */

import type { Env } from './env';

/**
 * 路由函数（onRequest / onRequestGet / onRequestPost ...）接收的上下文
 */
export interface PagesContext {
  /** 当前请求（同 Workers API） */
  request: Request;
  /** 环境绑定（KV/D1/R2 + 变量） */
  env: Env;
  /** 路径参数，如 [[path]] 捕获的片段数组 */
  params: Record<string, string | string[]>;
  /** 等待异步任务完成（ctx.waitUntil） */
  waitUntil: (promise: Promise<unknown>) => void;
  /** 请求异常时透传（Pages 专用，Workers 下为空实现） */
  passThroughOnException: () => void;
  /** 调用链中的下一个处理器（中间件用） */
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  /** 中间件间共享数据的任意空间 */
  data: Record<string, unknown>;
  /** 当前路由的函数路径（generate-routes 注入） */
  functionPath?: string;
}

/**
 * 中间件函数签名（onRequest 数组中的每一项）
 */
export type MiddlewareHandler = (context: PagesContext) => Promise<Response> | Response;

/**
 * 路由模块的标准导出形状：
 * - onRequest / onRequestGet / onRequestPost ...（单函数或中间件数组）
 * - [[path]].js / index.js 等文件均适用
 */
export interface RouteModule {
  onRequest?: MiddlewareHandler | MiddlewareHandler[];
  onRequestGet?: MiddlewareHandler | MiddlewareHandler[];
  onRequestPost?: MiddlewareHandler | MiddlewareHandler[];
  onRequestPut?: MiddlewareHandler | MiddlewareHandler[];
  onRequestDelete?: MiddlewareHandler | MiddlewareHandler[];
  onRequestPatch?: MiddlewareHandler | MiddlewareHandler[];
  onRequestHead?: MiddlewareHandler | MiddlewareHandler[];
  onRequestOptions?: MiddlewareHandler | MiddlewareHandler[];
  [method: string]: unknown;
}
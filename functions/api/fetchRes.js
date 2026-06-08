import { authenticate } from '../utils/auth/authCore.js';

export async function onRequest(context) {
    // 获取请求体中URL的内容
    const {
        request,
        env,
        params,
        waitUntil,
        next,
        data
    } = context;

    // 鉴权：登录即放行
    const { authorized } = await authenticate({ env, request, requiredPermission: null });
    if (!authorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const jsonRequest = await request.json();
    const targetUrl = jsonRequest.url;
    if (targetUrl === undefined) {
        return new Response(JSON.stringify({ error: 'URL is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    const response = await fetch(targetUrl);
    const headers = new Headers(response.headers);
    return new Response(response.body, {
        headers: headers
    })
}
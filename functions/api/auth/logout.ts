import { destroySession } from '../../utils/auth/sessionManager.js';
import type { Env } from '../../types';

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;

  const cookies = await destroySession(env, request);

  const headers = new Headers();
  cookies.forEach(cookie => headers.append('Set-Cookie', cookie));

  return new Response('Logged out', {
    status: 200,
    headers,
  });
}
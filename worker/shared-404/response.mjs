// Canonical policy: Yuzora-Yu/yu-zora-main/worker/shared-not-found.mjs.
// Consumer copies are generated with a source hash; the error page stays on yu-zora-main.
/* global URL, Request, Response, Headers */
export async function sharedNotFound(request, response, env) {
  const url = new URL(request.url);
  const destination = request.headers.get('sec-fetch-dest') || '';
  const document = destination ? ['document', 'iframe'].includes(destination) : /text\/html/i.test(request.headers.get('accept') || '');
  if (response.status !== 404 || !['GET', 'HEAD'].includes(request.method) || !document || request.headers.has('upgrade')) return response;
  if (!['yu-zora.com', 'www.yu-zora.com'].includes(url.hostname)) return response;
  if (/(?:^|\/)(?:api|rpc|trpc)(?:\/|$)/i.test(url.pathname) || /\.(?:json|xml|map)$/i.test(url.pathname)) return response;
  if (!destination && /(?:application\/json|\+json)/i.test(response.headers.get('content-type') || '')) return response;
  if (!env?.YU_ZORA_ERROR_PAGES?.fetch) return response;
  try {
    const page = await env.YU_ZORA_ERROR_PAGES.fetch(new Request('https://yu-zora.com/404', {
      method: request.method,
      headers: { accept: 'text/html' }
    }));
    if (!(page.ok || page.status === 404) || !/text\/html/i.test(page.headers.get('content-type') || '')) return response;
    const headers = new Headers(page.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.delete('last-modified');
    headers.set('cache-control', 'no-store');
    headers.set('x-robots-tag', 'noindex, follow');
    headers.set('x-yu-zora-error-page', '404');
    await response.body?.cancel();
    return new Response(request.method === 'HEAD' ? null : page.body, { status: 404, headers });
  } catch {
    return response;
  }
}

export function withSharedNotFound(handler) {
  if (typeof handler === 'function') {
    return class extends handler {
      async fetch(request) {
        return sharedNotFound(request, await super.fetch(request), this.env);
      }
    };
  }
  return {
    ...handler,
    async fetch(request, env, ctx) {
      return sharedNotFound(request, await handler.fetch.call(handler, request, env, ctx), env);
    }
  };
}

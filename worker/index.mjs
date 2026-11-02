const BASE_PATH = '/tools/life_diary';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    if (url.pathname === BASE_PATH) {
      url.pathname += '/';
      return Response.redirect(url.href, 308);
    }
    if (!url.pathname.startsWith(BASE_PATH + '/')) {
      return new Response('Not Found', { status: 404 });
    }
    if (url.pathname === BASE_PATH + '/') url.pathname += 'index.html';
    return env.ASSETS.fetch(new Request(url, request));
  }
};

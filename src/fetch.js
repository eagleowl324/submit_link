// 웹 표준 Request/Response 로 요청을 주고받는 실행 환경(Vercel)을 src/app.js 에 연결합니다.
// src/app.js 는 Node.js 식 req/res 를 쓰므로, 같은 모양의 얇은 객체를 만들어 넘기고 결과를 Response 로 돌려줍니다.

// remoteAddress: 접속자 주소. 실행 환경이 알려 주는 값을 넘깁니다.
// url: 요청의 주소를 request.url 과 다르게 봐야 할 때 넘깁니다(실행 환경이 주소를 바꿔서 넘겨 주는 경우).
export async function serve(app, request, { remoteAddress = '', url = new URL(request.url) } = {}) {
  const headers = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;

  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    socket: { remoteAddress, encrypted: url.protocol === 'https:' },
    destroyed: false,
    // 본문은 조각 단위로 넘겨서, 너무 큰 요청을 다 받기 전에 거절할 수 있게 합니다.
    async *[Symbol.asyncIterator]() {
      if (request.body) yield* request.body;
    },
  };

  let sent = null;
  const res = {
    req,
    headersSent: false,
    destroyed: false,
    writeHead(status, responseHeaders = {}) {
      this.headersSent = true;
      sent = { status, headers: responseHeaders, body: null };
    },
    end(body) {
      if (sent) sent.body = body ?? null;
    },
    destroy() {
      this.destroyed = true;
    },
  };

  await app.handle(req, res);
  if (!sent) return new Response('서버에서 문제가 생겼습니다.\n', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(sent.headers)) {
    // 길이와 연결 관리는 실행 환경이 합니다.
    if (!['content-length', 'connection'].includes(name.toLowerCase())) responseHeaders.set(name, String(value));
  }
  const bodiless = request.method === 'HEAD' || sent.status === 204 || sent.status === 304;
  return new Response(bodiless ? null : sent.body, { status: sent.status, headers: responseHeaders });
}

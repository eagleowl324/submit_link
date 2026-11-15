// Vercel 에서 서비스를 돌리는 부분.
//
// Vercel 은 요청이 올 때만 잠깐 실행되고 파일을 남기지 못하므로, 데이터는 Vercel 의 Storage 에서 만든
// Turso(libSQL, SQLite 호환) 데이터베이스에 둡니다. 서비스의 로직(src/app.js)과 저장소 코드(src/db.js)는
// 직접 띄우는 Node.js 서버와 같은 것을 씁니다.
// 화면에 쓰이는 정적 파일(/assets/...)은 Vercel 이 직접 내보내고, 나머지 요청만 여기로 옵니다(vercel.json).

import { createApp, rateKey } from './app.js';
import { Store } from './db.js';
import { serve } from './fetch.js';
import { LibsqlDatabase } from './libsql.js';
import * as pages from './pages.generated.js';
import { RateLimiter, StoredBuckets } from './security.js';

// 환경 변수에서 데이터베이스 주소와 토큰을 찾습니다.
// Vercel 의 Storage 에서 Turso 를 연결하면 TURSO_DATABASE_URL 과 TURSO_AUTH_TOKEN 이 들어옵니다.
// 연결할 때 이름 앞에 다른 말을 붙였더라도 값이 libsql:// 로 시작하는 ..._DATABASE_URL 을 찾아 씁니다.
export function findDatabase(env) {
  if (env.TURSO_DATABASE_URL) return { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN || undefined };
  for (const [name, value] of Object.entries(env)) {
    if (name.endsWith('DATABASE_URL') && typeof value === 'string' && value.startsWith('libsql://')) {
      const prefix = name.slice(0, -'DATABASE_URL'.length);
      return { url: value, authToken: env[`${prefix}AUTH_TOKEN`] || undefined };
    }
  }
  return null;
}

function notice(status, title, lines) {
  const body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body><h1>${title}</h1>${lines.map((line) => `<p>${line}</p>`).join('')}</body></html>`;
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// env: 환경 변수(process.env). createClient: @libsql/client 의 createClient.
// serialize: 질의를 한 번에 하나씩 보낼지. 데이터베이스를 파일로 여는 테스트에서만 켭니다.
// 돌려주는 함수가 요청 하나를 처리합니다: (Request) => Promise<Response>
export function createVercelHandler({ env, createClient, serialize = false }) {
  let starting = null;

  async function start() {
    const database = findDatabase(env);
    if (!database) return null;
    const store = new Store(new LibsqlDatabase(createClient(database), { serialize }));
    return createApp({
      store,
      pages,
      // ADMIN_PASSWORD 를 정해 두지 않으면 관리 화면에 처음 들어갔을 때 비밀번호를 만듭니다.
      adminPassword: env.ADMIN_PASSWORD || '',
      setup: 'web',
      // 요청마다 다른 실행 단위가 받을 수 있으므로, 비밀번호를 틀린 횟수는 데이터베이스에 남깁니다.
      limiter: new RateLimiter(Date.now, new StoredBuckets(store)),
      // 접속자 주소는 Vercel 이 붙여 주는 값이라 보내는 쪽이 꾸밀 수 없습니다.
      clientIp: (req) => rateKey(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0]),
    });
  }

  return async function handle(request) {
    // 한 번 준비한 서비스는 같은 실행 단위가 살아 있는 동안 다시 씁니다. 실패했다면 다음 요청에서 다시 시도합니다.
    starting ??= start();
    let app;
    try {
      app = await starting;
    } catch (error) {
      starting = null;
      console.error(error);
      const detail = error?.constructor?.name === 'ConfigError' ? error.message : '데이터베이스에 연결하지 못했습니다. Vercel 의 Storage 에서 데이터베이스가 이 프로젝트에 연결되어 있는지 확인해 주세요.';
      return notice(500, '서비스를 시작하지 못했습니다', [detail]);
    }
    if (!app) {
      starting = null;
      return notice(503, '데이터베이스를 연결해 주세요', [
        '제출 내용을 저장할 데이터베이스가 아직 연결되지 않았습니다.',
        'Vercel 프로젝트의 Storage 탭에서 Turso 데이터베이스를 만들어 이 프로젝트에 연결한 다음, Deployments 탭에서 다시 배포(Redeploy)해 주세요.',
      ]);
    }
    return serve(app, request);
  };
}

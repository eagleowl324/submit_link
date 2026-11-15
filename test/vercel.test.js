// Vercel 에서 도는 부분(src/vercel.js)을 확인합니다.
// 실제 Vercel 대신 요청을 직접 넣어 보고, 원격 데이터베이스 대신 같은 종류(libSQL)의 파일 데이터베이스를 씁니다.
// 서비스의 로직은 test/api.test.js 가 자세히 검사하므로(npm run test:libsql 로 같은 저장 방식에서도),
// 여기서는 Vercel 에서만 다른 점을 봅니다: 요청·응답 변환, 데이터베이스 연결, 여러 실행 단위가 번갈아 받는 상황.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createVercelHandler, errorCode, findDatabase, findOtherStorage, originalUrl } from '../src/vercel.js';

const libsql = await import('@libsql/client').catch(() => null);
const skip = libsql ? false : '@libsql/client 가 설치되어 있지 않습니다. npm install 뒤에 다시 실행하세요.';

const ORIGIN = 'https://submit-link.example';
const DATABASE_ENV = { TURSO_DATABASE_URL: 'libsql://example.turso.io', TURSO_AUTH_TOKEN: 'token' };

async function temporaryFolder(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'submit-link-vercel-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

// Vercel 의 실행 단위 하나. 같은 folder 를 주면 같은 데이터베이스를 보는 다른 실행 단위가 됩니다.
function instance(folder, env = DATABASE_ENV) {
  return createVercelHandler({
    env,
    createClient: () => libsql.createClient({ url: `file:${path.join(folder, 'vercel.db')}` }),
    serialize: true,
  });
}

async function call(handler, method, url, { body, cookie, headers = {}, raw } = {}) {
  const response = await handler(
    new Request(ORIGIN + url, {
      method,
      headers: {
        'x-real-ip': '203.0.113.9',
        'x-forwarded-proto': 'https',
        ...(method !== 'GET' && method !== 'HEAD' ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    }),
  );
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // JSON 이 아닌 응답
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function setUp(handler, password = 'teacher-password') {
  const response = await call(handler, 'POST', '/api/admin/setup', { body: { password } });
  assert.equal(response.status, 200, response.text);
  return response.headers.get('set-cookie').split(';')[0];
}

test('환경 변수에서 데이터베이스 주소와 토큰을 찾는다', () => {
  assert.equal(findDatabase({}), null);
  assert.equal(findDatabase({ DATABASE_URL: 'postgres://elsewhere' }), null);
  assert.deepEqual(findDatabase({ TURSO_DATABASE_URL: 'libsql://a.turso.io', TURSO_AUTH_TOKEN: 't' }), { url: 'libsql://a.turso.io', authToken: 't' });
  // 연결할 때 이름 앞에 다른 말을 붙인 경우
  assert.deepEqual(findDatabase({ SUBMIT_TURSO_DATABASE_URL: 'libsql://b.turso.io', SUBMIT_TURSO_AUTH_TOKEN: 'u' }), { url: 'libsql://b.turso.io', authToken: 'u' });
  assert.deepEqual(findDatabase({ STORAGE_DATABASE_URL: 'libsql://c.turso.io' }), { url: 'libsql://c.turso.io', authToken: undefined });
  assert.deepEqual(findDatabase({ MY_TURSO_DATABASE_URL: 'https://d.turso.io', MY_TURSO_AUTH_TOKEN: 'v' }), { url: 'https://d.turso.io', authToken: 'v' });
  assert.equal(findDatabase({ TURSO_DATABASE_URL: '', MY_TURSO_DATABASE_URL: '' }), null);
});

test('Turso 가 아닌 저장소가 연결되어 있으면 알아본다', () => {
  assert.equal(findOtherStorage({}), null);
  assert.equal(findOtherStorage({ VERCEL: '1', VERCEL_URL: 'x.vercel.app', NODE_ENV: 'production', AWS_REGION: 'ap-northeast-1' }), null);
  assert.equal(findOtherStorage({ POSTGRES_URL: 'postgres://x' }), 'Postgres');
  assert.equal(findOtherStorage({ DATABASE_URL: 'postgresql://x' }), 'Postgres');
  assert.equal(findOtherStorage({ KV_REST_API_URL: 'https://x' }), 'Redis');
  assert.equal(findOtherStorage({ BLOB_READ_WRITE_TOKEN: 'x' }), 'Blob');
  assert.equal(findOtherStorage({ POSTGRES_URL: '' }), null);
});

test('오류에서 화면에 보여 줄 짧은 코드만 고른다', () => {
  assert.equal(errorCode(new Error('boom')), '');
  assert.equal(errorCode(null), '');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'SERVER_ERROR', cause: { status: 401 } })), 'SERVER_ERROR / 401');
  assert.equal(errorCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'ENOTFOUND');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'URL_INVALID', cause: { code: 'URL_INVALID' } })), 'URL_INVALID');
  // 코드처럼 생기지 않은 값(주소, 문장)은 내보내지 않는다
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'libsql://secret.turso.io?authToken=abc' })), '');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: { toString: () => 'OBJECT' } })), '');
});

test('Vercel 이 주소를 어떻게 넘겨 주든 방문자가 요청한 원래 주소로 처리한다', { skip }, async (t) => {
  const at = (url) => {
    const found = originalUrl(new Request(ORIGIN + url));
    return found.pathname + found.search;
  };
  // 원래 주소를 그대로 넘겨 주는 경우 (rewrites 가 붙인 __path 는 있을 수도, 없을 수도 있다)
  assert.equal(at('/a/abc123'), '/a/abc123');
  assert.equal(at('/a/abc123?__path=/a/abc123'), '/a/abc123');
  assert.equal(at('/api/site?x=1&__path=/api/site'), '/api/site?x=1');
  // 함수 자신의 주소로 바꿔 넘겨 주는 경우
  assert.equal(at('/api/app?__path=/'), '/');
  assert.equal(at('/api/app?__path=/a/abc123'), '/a/abc123');
  assert.equal(at('/api/app?__path=/api/admin/session&x=1'), '/api/admin/session?x=1');
  assert.equal(at('/api/app'), '/api/app');
  // 다른 곳으로 새지 않는다
  assert.equal(originalUrl(new Request(`${ORIGIN}/api/app?__path=//evil.example/x`)).host, 'submit-link.example');
  assert.equal(at('/api/app?__path=evil'), '/api/app');

  // 두 경우 모두 같은 화면과 같은 API 가 나온다.
  const handler = instance(await temporaryFolder(t));
  for (const url of ['/', '/api/app?__path=/', '/?__path=/']) {
    const page = await call(handler, 'GET', url);
    assert.equal(page.status, 200, url);
    assert.ok(page.text.includes('<title>과제 링크 제출함</title>'), url);
  }
  for (const url of ['/api/admin/session', '/api/app?__path=/api/admin/session', '/api/admin/session?__path=/api/admin/session']) {
    assert.deepEqual((await call(handler, 'GET', url)).json, { authenticated: false, needsSetup: true, setup: 'web' }, url);
  }
  const setup = await call(handler, 'POST', '/api/app?__path=/api/admin/setup', { body: { password: 'teacher-password' } });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(handler, 'GET', '/api/app?__path=/api/admin/overview', { cookie })).status, 200);
  assert.equal((await call(handler, 'GET', '/api/app?__path=/api/admin/overview')).status, 401, '주소를 바꿔 불러도 로그인 없이는 안 된다');
  assert.equal((await call(handler, 'GET', '/api/app')).status, 404);
});

test('데이터베이스를 연결하기 전에는 안내문을 보여 준다', async () => {
  let created = 0;
  const handler = createVercelHandler({
    env: {},
    createClient: () => {
      created += 1;
    },
  });
  for (const url of ['/', '/admin', '/api/site']) {
    const response = await call(handler, 'GET', url);
    assert.equal(response.status, 503, url);
    assert.match(response.text, /데이터베이스를 연결해 주세요/);
    assert.match(response.text, /Storage/);
    assert.equal(response.text.includes('다른 종류의 저장소'), false);
  }
  assert.equal(created, 0);

  // 다른 종류의 저장소를 연결해 둔 경우에는 그 사실을 알려 준다. 값은 내보내지 않는다.
  const wrong = createVercelHandler({ env: { POSTGRES_URL: 'postgres://user:secret-password@db.example/x' }, createClient: () => assert.fail() });
  const response = await call(wrong, 'GET', '/');
  assert.equal(response.status, 503);
  assert.match(response.text, /다른 종류의 저장소\(Postgres\)/);
  assert.equal(response.text.includes('secret-password'), false);
});

test('데이터베이스에 연결하지 못하면 알리고, 다음 요청에서 다시 시도한다', { skip }, async (t) => {
  const folder = await temporaryFolder(t);
  let broken = true;
  const handler = createVercelHandler({
    env: DATABASE_ENV,
    createClient: () => {
      if (broken) throw Object.assign(new Error('boom: secret-token-value'), { code: 'SERVER_ERROR', cause: { status: 401 } });
      return libsql.createClient({ url: `file:${path.join(folder, 'vercel.db')}` });
    },
    serialize: true,
  });
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  const failed = await call(handler, 'GET', '/');
  assert.equal(failed.status, 500);
  assert.match(failed.text, /서비스를 시작하지 못했습니다/);
  assert.equal(failed.text.includes('secret-token-value'), false, '오류 내용을 화면에 그대로 내보내지 않는다');
  assert.match(failed.text, /오류 코드: SERVER_ERROR \/ 401/, '원인을 짐작할 수 있는 코드는 보여 준다');

  broken = false;
  assert.equal((await call(handler, 'GET', '/')).status, 200);
});

test('화면과 응답 변환: 제목, 보안 헤더, HEAD, 큰 요청', { skip }, async (t) => {
  const handler = instance(await temporaryFolder(t));

  const page = await call(handler, 'GET', '/');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('<title>과제 링크 제출함</title>'));
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('content-length'), null, '길이는 실행 환경이 붙인다');

  assert.equal((await call(handler, 'HEAD', '/')).text, '');
  assert.equal((await call(handler, 'GET', '/admin')).status, 200);
  assert.equal((await call(handler, 'GET', '/a/nosuchslug')).status, 404);
  assert.equal((await call(handler, 'GET', '/healthz')).text, 'ok\n');
  // 정적 파일은 Vercel 이 직접 내보내므로 여기까지 온 요청은 없는 파일이다.
  assert.equal((await call(handler, 'GET', '/assets/styles.css')).status, 404);
  const favicon = await call(handler, 'GET', '/favicon.ico');
  assert.equal(favicon.status, 302);
  assert.equal(favicon.headers.get('location'), '/assets/favicon.svg');

  const huge = await call(handler, 'POST', '/api/admin/setup', { raw: JSON.stringify({ password: 'x'.repeat(40 * 1024) }) });
  assert.equal(huge.status, 413);
  const forged = await call(handler, 'POST', '/api/admin/setup', { body: { password: 'teacher-password' }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(forged.status, 403);
});

test('관리자 비밀번호를 처음 정하고, 과제를 만들고, 학생이 낸다', { skip }, async (t) => {
  const handler = instance(await temporaryFolder(t));

  assert.deepEqual((await call(handler, 'GET', '/api/admin/session')).json, { authenticated: false, needsSetup: true, setup: 'web' });
  assert.equal((await call(handler, 'POST', '/api/admin/setup', { body: { password: 'short' } })).status, 400);

  // 두 사람이 동시에 정하려 해도 한 사람만 된다.
  const attempts = await Promise.all([
    call(handler, 'POST', '/api/admin/setup', { body: { password: 'teacher-password' } }),
    call(handler, 'POST', '/api/admin/setup', { body: { password: 'intruder-password' } }),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const winner = attempts.find((r) => r.status === 200);
  const password = winner === attempts[0] ? 'teacher-password' : 'intruder-password';
  const cookie = winner.headers.get('set-cookie').split(';')[0];
  assert.match(winner.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
  assert.deepEqual((await call(handler, 'GET', '/api/admin/session', { cookie })).json, { authenticated: true, needsSetup: false, setup: 'web' });
  assert.equal((await call(handler, 'POST', '/api/admin/login', { body: { password } })).status, 200);
  assert.equal((await call(handler, 'POST', '/api/admin/login', { body: { password: 'not-the-password' } })).status, 401);

  const created = await call(handler, 'POST', '/api/admin/assignments', { cookie, body: { title: '<b>1차</b> 과제' } });
  assert.equal(created.status, 201, created.text);
  const { assignment } = created.json;
  assert.ok((await call(handler, 'GET', `/a/${assignment.slug}`)).text.includes('<title>&lt;b&gt;1차&lt;/b&gt; 과제 · 과제 링크 제출함</title>'));

  const submit = (fields = {}) =>
    call(handler, 'POST', `/api/assignments/${assignment.slug}/submissions`, {
      body: { studentId: '20301', name: '김하늘', url: 'https://example.com/work', password: 'pass1234', ...fields },
    });
  assert.equal((await submit({ url: 'example.com/v1' })).status, 201);
  assert.equal((await submit({ url: 'https://evil.example/', password: 'guess-0000' })).status, 403);
  const second = await submit({ url: 'https://example.com/v2' });
  assert.equal(second.json.submission.revision, 2);

  const list = await call(handler, 'GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie });
  assert.equal(list.json.submissions.length, 1);
  const detail = await call(handler, 'GET', `/api/admin/submissions/${list.json.submissions[0].id}`, { cookie });
  assert.deepEqual(
    detail.json.submission.history.map((entry) => entry.url),
    ['https://example.com/v1'],
  );
  assert.equal((await call(handler, 'DELETE', `/api/admin/assignments/${assignment.id}`, { cookie })).status, 200);
  assert.deepEqual((await call(handler, 'GET', '/api/site')).json.assignments, []);
});

test('실행 단위가 바뀌어도 로그인·데이터·비밀번호 잠금이 이어진다', { skip }, async (t) => {
  const folder = await temporaryFolder(t);
  const first = instance(folder);
  const second = instance(folder);

  const cookie = await setUp(first);
  const { assignment } = (await call(first, 'POST', '/api/admin/assignments', { cookie, body: { title: '과제' } })).json;
  assert.equal((await call(second, 'GET', '/api/admin/overview', { cookie })).status, 200, '다른 실행 단위에서도 로그인 유지');
  assert.equal((await call(second, 'GET', '/api/site')).json.assignments[0].slug, assignment.slug);
  assert.deepEqual((await call(second, 'GET', '/api/admin/session')).json, { authenticated: false, needsSetup: false, setup: 'web' });

  const submit = (handler, fields = {}) =>
    call(handler, 'POST', `/api/assignments/${assignment.slug}/submissions`, {
      body: { studentId: '20301', name: '김하늘', url: 'https://example.com/work', password: 'pass1234', ...fields },
    });
  assert.equal((await submit(first)).status, 201);
  // 틀린 비밀번호 8번을 두 실행 단위에 나눠 보내도 합쳐서 센다.
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await submit(i % 2 ? first : second, { url: 'https://example.com/x', password: `wrong-${i}` })).status, 403);
  }
  assert.equal((await submit(first, { url: 'https://example.com/x' })).status, 429);
  assert.equal((await submit(second, { url: 'https://example.com/x' })).status, 429);

  // 새로 뜬 실행 단위(같은 데이터베이스)에서도 그대로다.
  const third = instance(folder);
  assert.equal((await submit(third, { url: 'https://example.com/x' })).status, 429);
  assert.equal((await call(third, 'GET', '/api/admin/overview', { cookie })).status, 200);
});

test('ADMIN_PASSWORD 를 정해 두면 그 값으로 로그인하고, 값을 바꾸면 예전 로그인이 풀린다', { skip }, async (t) => {
  const folder = await temporaryFolder(t);
  const handler = instance(folder, { ...DATABASE_ENV, ADMIN_PASSWORD: 'from-vercel-settings' });

  assert.deepEqual((await call(handler, 'GET', '/api/admin/session')).json, { authenticated: false, needsSetup: false, setup: 'web' });
  assert.equal((await call(handler, 'POST', '/api/admin/setup', { body: { password: 'takeover-attempt' } })).status, 409);
  const login = await call(handler, 'POST', '/api/admin/login', { body: { password: 'from-vercel-settings' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(handler, 'GET', '/api/admin/overview', { cookie })).json.passwordFromEnv, true);

  const rotated = instance(folder, { ...DATABASE_ENV, ADMIN_PASSWORD: 'rotated-in-settings' });
  assert.equal((await call(rotated, 'GET', '/api/admin/overview', { cookie })).status, 401);
  assert.equal((await call(rotated, 'POST', '/api/admin/login', { body: { password: 'rotated-in-settings' } })).status, 200);

  const tooShort = instance(folder, { ...DATABASE_ENV, ADMIN_PASSWORD: 'short' });
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  const refused = await call(tooShort, 'GET', '/');
  assert.equal(refused.status, 500);
  assert.match(refused.text, /8자 이상/);
});

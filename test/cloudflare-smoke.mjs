// Cloudflare 판(cloudflare/worker.js)을 내 컴퓨터에서 띄워 놓고 실제 요청으로 확인합니다.
//
//   npm install            (wrangler 설치, 처음 한 번)
//   npm run test:cloudflare
//
// 이미 배포한 주소를 검사하려면 SMOKE_BASE 에 주소를 넣습니다. 관리자 비밀번호를 아직 정하지 않은 새 배포여야 하고,
// 검사하면서 과제와 제출을 만들고 지우므로 실제로 쓰는 주소에는 돌리지 마세요.
//   SMOKE_BASE=https://submit-link-test.example.workers.dev npm run test:cloudflare
//
// 서비스의 로직은 Node.js 판과 같은 코드라서 자세한 검사는 npm test 가 맡고,
// 여기서는 Cloudflare 에서만 다른 부분(저장소, 요청·응답 변환, 첫 비밀번호 설정, 정적 파일, 재시작 뒤 데이터 유지)을 봅니다.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.SMOKE_PORT || 8791);
const REMOTE = (process.env.SMOKE_BASE || '').replace(/\/$/, '');
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
const PASSWORD = 'smoke-test-password';

let wrangler = null;

async function startWorker(persistTo, vars = {}) {
  if (REMOTE) return;
  const args = ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persistTo, '--show-interactive-dev-session=false'];
  for (const [name, value] of Object.entries(vars)) args.push('--var', `${name}:${value}`);
  wrangler = spawn(path.join(ROOT, 'node_modules', '.bin', 'wrangler'), args, {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  wrangler.stdout.on('data', (chunk) => {
    log += chunk;
  });
  wrangler.stderr.on('data', (chunk) => {
    log += chunk;
  });
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      // 아직 뜨는 중
    }
    if (wrangler.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`개발 서버가 뜨지 않았습니다.\n${log.slice(-2000)}`);
}

async function stopWorker() {
  if (!wrangler) return;
  const done = new Promise((resolve) => wrangler.once('exit', resolve));
  wrangler.kill('SIGTERM');
  await done;
  wrangler = null;
}

async function request(method, url, { body, cookie, headers = {}, raw } = {}) {
  const response = await fetch(BASE + url, {
    method,
    redirect: 'manual',
    headers: {
      ...(method !== 'GET' && method !== 'HEAD' ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // JSON 이 아닌 응답
  }
  return { status: response.status, headers: response.headers, text, json };
}

const steps = [];
async function step(name, work) {
  await work();
  steps.push(name);
  console.log(`  ✔ ${name}`);
}

async function main() {
  const persistTo = mkdtempSync(path.join(os.tmpdir(), 'submit-link-cf-'));
  try {
    await startWorker(persistTo);
    let cookie;
    let assignment;
    const submit = (fields = {}) =>
      request('POST', `/api/assignments/${assignment.slug}/submissions`, {
        body: { studentId: '20301', name: '김하늘', url: 'https://example.com/work', password: 'pass1234', ...fields },
      });

    await step('정적 파일은 Cloudflare 가 보안 헤더와 함께 내보낸다', async () => {
      for (const [url, type] of [
        ['/assets/styles.css', 'text/css'],
        ['/assets/student.js', 'text/javascript'],
        ['/assets/shared/rules.js', 'text/javascript'],
        ['/assets/favicon.svg', 'image/svg+xml'],
      ]) {
        const response = await request('GET', url);
        assert.equal(response.status, 200, url);
        assert.ok(response.headers.get('content-type').startsWith(type), `${url} ${response.headers.get('content-type')}`);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff', url);
      }
      assert.equal((await request('GET', '/assets/nope.js')).status, 404);
      assert.equal((await request('GET', '/assets/index.html')).status, 404);
      const favicon = await request('GET', '/favicon.ico');
      assert.equal(favicon.status, 302);
      assert.equal(favicon.headers.get('location'), '/assets/favicon.svg');
      assert.match((await request('GET', '/robots.txt')).text, /Disallow: \//);
    });

    await step('화면은 서비스가 보안 헤더와 함께 내보낸다', async () => {
      const page = await request('GET', '/');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
      assert.ok(page.text.includes('<title>과제 링크 제출함</title>'));
      assert.equal((await request('HEAD', '/')).text, '');
      assert.equal((await request('GET', '/admin')).status, 200);
      assert.equal((await request('GET', '/a/nosuchslug')).status, 404);
    });

    await step('관리자 비밀번호는 처음 들어온 사람이 한 번만 정한다', async () => {
      assert.deepEqual((await request('GET', '/api/admin/session')).json, { authenticated: false, needsSetup: true, setup: 'web' });
      assert.equal((await request('GET', '/api/admin/overview')).status, 401);
      assert.equal((await request('POST', '/api/admin/login', { body: { password: PASSWORD } })).status, 401, '정하기 전에는 어떤 비밀번호로도 못 들어간다');
      assert.equal((await request('POST', '/api/admin/setup', { body: { password: 'short' } })).status, 400);
      assert.equal((await request('POST', '/api/admin/setup', { raw: 'password=x', headers: { 'Content-Type': 'text/plain' } })).status, 415);

      // 두 사람이 동시에 정하려 해도 한 사람만 된다.
      const attempts = await Promise.all([
        request('POST', '/api/admin/setup', { body: { password: PASSWORD } }),
        request('POST', '/api/admin/setup', { body: { password: 'someone-elses-password' } }),
      ]);
      assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
      const winner = attempts.find((r) => r.status === 200);
      const winnerPassword = winner === attempts[0] ? PASSWORD : 'someone-elses-password';
      cookie = winner.headers.get('set-cookie').split(';')[0];
      assert.match(winner.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
      if (BASE.startsWith('https:')) assert.match(winner.headers.get('set-cookie'), /; Secure/, 'https 에서는 Secure 쿠키');
      assert.deepEqual((await request('GET', '/api/admin/session', { cookie })).json, { authenticated: true, needsSetup: false, setup: 'web' });
      assert.equal((await request('POST', '/api/admin/setup', { body: { password: 'again-and-again' } })).status, 409);

      // 이후 검사가 같은 비밀번호를 쓰도록 맞춘다.
      if (winnerPassword !== PASSWORD) {
        const changed = await request('POST', '/api/admin/password', { cookie, body: { currentPassword: winnerPassword, newPassword: PASSWORD } });
        assert.equal(changed.status, 200);
      }
      assert.equal((await request('POST', '/api/admin/login', { body: { password: 'wrong-password' } })).status, 401);
      const login = await request('POST', '/api/admin/login', { body: { password: PASSWORD } });
      assert.equal(login.status, 200);
      assert.equal((await request('GET', '/api/admin/overview', { cookie })).json.passwordFromEnv, false);
    });

    await step('과제를 만들고, 학생이 내고 고친다', async () => {
      const created = await request('POST', '/api/admin/assignments', { cookie, body: { title: '<b>1차</b> 과제', description: '링크를 내세요' } });
      assert.equal(created.status, 201, created.text);
      assignment = created.json.assignment;
      assert.equal((await request('GET', '/api/site')).json.assignments[0].slug, assignment.slug);
      assert.ok((await request('GET', `/a/${assignment.slug}`)).text.includes('<title>&lt;b&gt;1차&lt;/b&gt; 과제 · 과제 링크 제출함</title>'));

      const first = await submit({ studentId: ' ２０３０１ ', url: 'example.com/v1' });
      assert.equal(first.status, 201, first.text);
      assert.equal(first.json.submission.studentId, '20301');
      assert.equal(first.json.submission.url, 'https://example.com/v1');
      assert.equal((await submit({ url: 'https://evil.example/', password: 'guess-0000' })).status, 403);
      const second = await submit({ url: 'https://example.com/v2' });
      assert.equal(second.json.status, 'updated');
      assert.equal(second.json.submission.revision, 2);
      assert.equal((await submit({ url: 'https://example.com/v2' })).json.status, 'unchanged');
      assert.equal((await submit({ studentId: '', url: 'javascript:alert(1)', password: '1' })).status, 400);

      const list = await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie });
      assert.equal(list.json.submissions.length, 1);
      const detail = await request('GET', `/api/admin/submissions/${list.json.submissions[0].id}`, { cookie });
      assert.deepEqual(
        detail.json.submission.history.map((entry) => entry.url),
        ['https://example.com/v1'],
      );
      assert.equal(JSON.stringify([list.json, detail.json]).includes('scrypt'), false);

      const lookup = await request('POST', `/api/assignments/${assignment.slug}/lookup`, { body: { studentId: '20301', password: 'pass1234' } });
      assert.equal(lookup.json.submission.url, 'https://example.com/v2');
    });

    await step('같은 학번으로 동시에 처음 내면 하나만 받는다', async () => {
      const results = await Promise.all([
        submit({ studentId: '20302', url: 'https://example.com/a', password: 'aaaa-1234' }),
        submit({ studentId: '20302', url: 'https://example.com/b', password: 'bbbb-1234' }),
      ]);
      // 진 쪽은 "방금 다른 제출이 들어왔다"(409)거나 "이미 제출된 학번"(403) 둘 중 하나로 거절된다.
      const statuses = results.map((r) => r.status).sort();
      assert.equal(statuses[0], 201);
      assert.ok([403, 409].includes(statuses[1]), `두 번째 응답 ${statuses[1]}`);
      const list = await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie });
      const rows = list.json.submissions.filter((row) => row.studentId === '20302');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].url, results.find((r) => r.status === 201).json.submission.url);
    });

    await step('명단, 미제출자, 명단에 있는 학번만 받기', async () => {
      const students = [
        { studentId: '20301', name: '김하늘' },
        { studentId: '20302', name: '이도윤' },
        { studentId: '20303', name: '박서연' },
      ];
      assert.deepEqual((await request('PUT', '/api/admin/roster', { cookie, body: { students, rosterOnly: true } })).json, { count: 3, rosterOnly: true });
      const list = await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie });
      assert.deepEqual(list.json.missing, [{ studentId: '20303', name: '박서연' }]);
      assert.equal((await submit({ studentId: '29999' })).status, 400);
      assert.equal((await submit({ studentId: '20303', name: '박서연' })).status, 201);
    });

    await step('다른 사이트가 보낸 요청과 너무 큰 요청은 받지 않는다', async () => {
      const forged = await request('POST', '/api/admin/assignments', { cookie, body: { title: '몰래' }, headers: { 'Sec-Fetch-Site': 'same-site' } });
      assert.equal(forged.status, 403);
      assert.equal((await request('POST', '/api/admin/logout', { cookie, headers: { 'Content-Type': 'text/plain' } })).status, 415);
      const huge = await request('POST', `/api/assignments/${assignment.slug}/submissions`, { raw: JSON.stringify({ note: 'x'.repeat(40 * 1024) }) });
      assert.equal(huge.status, 413);
      assert.equal((await request('POST', '/api/site', { body: {} })).status, 405);
    });

    await step('비밀번호를 여러 번 틀리면 잠긴다', async () => {
      for (let i = 0; i < 8; i += 1) assert.equal((await submit({ studentId: '20303', name: '박서연', password: `wrong-${i}` })).status, 403);
      assert.equal((await submit({ studentId: '20303', name: '박서연' })).status, 429);
      assert.equal((await submit({ studentId: '20301', url: 'https://example.com/v2' })).status, 200, '다른 학번은 영향이 없다');
    });

    await step(REMOTE ? '데이터·로그인·잠금이 저장되어 있다' : '서비스가 내려갔다 올라와도 데이터·로그인·잠금이 그대로다', async () => {
      await stopWorker();
      await startWorker(persistTo);
      assert.equal((await request('GET', '/api/site')).json.assignments[0].slug, assignment.slug);
      const list = await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie });
      assert.equal(list.status, 200, '로그인 유지');
      assert.equal(list.json.submissions.length, 3);
      assert.equal((await submit({ studentId: '20303', name: '박서연' })).status, 429, '잠금 유지');
      assert.deepEqual((await request('GET', '/api/admin/session')).json, { authenticated: false, needsSetup: false, setup: 'web' });

      // 선생님이 제출을 지우면 잠금도 풀린다.
      const locked = list.json.submissions.find((row) => row.studentId === '20303');
      assert.equal((await request('DELETE', `/api/admin/submissions/${locked.id}`, { cookie })).status, 200);
      assert.equal((await submit({ studentId: '20303', name: '박서연', password: 'new-pass-1' })).status, 201);
    });

    await step('과제를 지우면 제출도 함께 지워지고, 로그아웃이 된다', async () => {
      assert.equal((await request('DELETE', `/api/admin/assignments/${assignment.id}`, { cookie })).status, 200);
      assert.equal((await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).status, 404);
      assert.deepEqual((await request('GET', '/api/site')).json.assignments, []);
      const other = (await request('POST', '/api/admin/login', { body: { password: PASSWORD } })).headers.get('set-cookie').split(';')[0];
      assert.equal((await request('POST', '/api/admin/logout-others', { cookie })).status, 200);
      assert.equal((await request('GET', '/api/admin/overview', { cookie: other })).status, 401);
      assert.equal((await request('POST', '/api/admin/logout', { cookie })).status, 200);
      assert.equal((await request('GET', '/api/admin/overview', { cookie })).status, 401);
    });

    await stopWorker();
    if (REMOTE) return;
    const second = mkdtempSync(path.join(os.tmpdir(), 'submit-link-cf-'));
    try {
      // 대시보드에서 ADMIN_PASSWORD 를 정해 둔 경우와, 가벼운 해시 방식(PASSWORD_HASH)을 고른 경우
      await startWorker(second, { ADMIN_PASSWORD: 'from-dashboard-1', PASSWORD_HASH: 'pbkdf2:20000' });
      await step('ADMIN_PASSWORD 와 PASSWORD_HASH 변수를 쓸 수 있다', async () => {
        assert.deepEqual((await request('GET', '/api/admin/session')).json, { authenticated: false, needsSetup: false, setup: 'web' });
        assert.equal((await request('POST', '/api/admin/setup', { body: { password: 'takeover-attempt' } })).status, 409);
        const login = await request('POST', '/api/admin/login', { body: { password: 'from-dashboard-1' } });
        assert.equal(login.status, 200);
        const adminCookie = login.headers.get('set-cookie').split(';')[0];
        assert.equal((await request('GET', '/api/admin/overview', { cookie: adminCookie })).json.passwordFromEnv, true);
        assignment = (await request('POST', '/api/admin/assignments', { cookie: adminCookie, body: { title: '과제' } })).json.assignment;
        assert.equal((await submit()).status, 201);
        assert.equal((await submit({ url: 'https://example.com/x', password: 'wrong-pass' })).status, 403);
        assert.equal((await submit({ url: 'https://example.com/x' })).status, 200);
      });
    } finally {
      await stopWorker();
      rmSync(second, { recursive: true, force: true });
    }
  } finally {
    await stopWorker();
    rmSync(persistTo, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log(`\nCloudflare 판 확인 ${steps.length}단계 모두 통과 (${BASE})`))
  .catch(async (error) => {
    await stopWorker();
    console.error(`\n실패: ${error.stack || error}`);
    process.exit(1);
  });

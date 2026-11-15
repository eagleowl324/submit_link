import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isProxyPeer, rateKey } from '../src/app.js';
import { logoutAll, resetAdminPassword } from '../src/node.js';
import { USING_LIBSQL, createApp } from './support.js';

const ADMIN_PASSWORD = 'teacher-password';

// 시계를 마음대로 돌릴 수 있는 서버를 임시 폴더에 띄웁니다.
// options.dataDir 를 주면 그 폴더의 데이터를 이어서 씁니다(서버를 껐다 켜는 상황).
async function start(t, options = {}) {
  const dataDir = options.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), 'assignment-links-')));
  const clock = options.clock ?? { now: new Date('2026-11-15T03:00:00.000Z') };
  const app = await createApp({ adminPassword: ADMIN_PASSWORD, now: () => new Date(clock.now), ...options, dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function request(method, url, { body, cookie, headers = {}, raw } = {}) {
    const response = await fetch(base + url, {
      method,
      // 화면의 스크립트와 똑같이, 내용을 바꾸는 요청은 본문이 없어도 JSON 형식으로 보냅니다.
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
      // JSON이 아닌 응답
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  async function login(password = ADMIN_PASSWORD) {
    const response = await request('POST', '/api/admin/login', { body: { password } });
    assert.equal(response.status, 200, response.text);
    return response.headers.get('set-cookie').split(';')[0];
  }

  async function createAssignment(cookie, fields = {}) {
    const response = await request('POST', '/api/admin/assignments', { cookie, body: { title: '1차 과제', ...fields } });
    assert.equal(response.status, 201, response.text);
    return response.json.assignment;
  }

  const submit = (slug, fields = {}) =>
    request('POST', `/api/assignments/${slug}/submissions`, {
      body: { studentId: '20301', name: '김하늘', url: 'https://example.com/work', password: 'pass1234', ...fields },
    });

  return { app, base, clock, dataDir, request, login, createAssignment, submit };
}

test('과제가 없을 때 학생 화면 API는 빈 목록을 준다', async (t) => {
  const { request } = await start(t);
  const response = await request('GET', '/api/site');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { title: '과제 링크 제출함', assignments: [] });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('관리자 API는 로그인 없이는 쓸 수 없다', async (t) => {
  const { request } = await start(t);
  const calls = [
    ['GET', '/api/admin/overview'],
    ['POST', '/api/admin/assignments'],
    ['PUT', '/api/admin/assignments/1'],
    ['DELETE', '/api/admin/assignments/1'],
    ['GET', '/api/admin/assignments/1/submissions'],
    ['GET', '/api/admin/submissions/1'],
    ['DELETE', '/api/admin/submissions/1'],
    ['POST', '/api/admin/logout-others'],
    ['POST', '/api/admin/submissions/1/reset-password'],
    ['GET', '/api/admin/roster'],
    ['PUT', '/api/admin/roster'],
    ['PUT', '/api/admin/settings'],
    ['POST', '/api/admin/password'],
  ];
  for (const [method, url] of calls) {
    const response = await request(method, url, { body: method === 'GET' || method === 'DELETE' ? undefined : {} });
    assert.equal(response.status, 401, `${method} ${url}`);
    assert.equal(response.json.error.code, 'unauthorized');
  }
  const forged = await request('GET', '/api/admin/overview', { cookie: 'admin_session=not-a-real-token' });
  assert.equal(forged.status, 401);
});

test('로그인: 틀린 비밀번호는 거절하고, 맞으면 안전한 쿠키를 준다', async (t) => {
  const { request } = await start(t);

  const wrong = await request('POST', '/api/admin/login', { body: { password: 'nope-nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);

  const right = await request('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  assert.equal(right.status, 200);
  const cookie = right.headers.get('set-cookie');
  assert.match(cookie, /^admin_session=[\w-]{40,};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=604800/);
  assert.doesNotMatch(cookie, /Secure/, 'http 접속에서는 Secure 를 붙이지 않는다');

  const viaHttps = await request('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(viaHttps.headers.get('set-cookie'), /; Secure/);

  const session = await request('GET', '/api/admin/session', { cookie: cookie.split(';')[0] });
  assert.deepEqual(session.json, { authenticated: true, needsSetup: false, setup: 'console' });
  const anonymous = await request('GET', '/api/admin/session');
  assert.deepEqual(anonymous.json, { authenticated: false, needsSetup: false, setup: 'console' }, '로그인 전에는 비밀번호가 어떻게 정해졌는지 알려 주지 않는다');
  // 실행 창에 비밀번호를 보여 주는 방식에서는 화면에서 처음 정하는 기능이 꺼져 있다.
  assert.equal((await request('POST', '/api/admin/setup', { body: { password: 'anything-long-enough' } })).status, 409);
  assert.equal((await request('GET', '/api/admin/overview', { cookie: cookie.split(';')[0] })).json.passwordFromEnv, true);
});

test('로그인 시도가 너무 많으면 잠시 막고, 시간이 지나면 풀린다', async (t) => {
  const { request, clock } = await start(t);
  for (let i = 0; i < 10; i += 1) {
    const response = await request('POST', '/api/admin/login', { body: { password: `wrong-${i}` } });
    assert.equal(response.status, 401);
  }
  const blocked = await request('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'too_many_attempts');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  clock.now = new Date(clock.now.getTime() + 11 * 60 * 1000);
  const after = await request('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  assert.equal(after.status, 200);
});

test('로그아웃하면 세션이 끝나고, 세션은 7일 뒤 만료된다', async (t) => {
  const { request, login, clock } = await start(t);
  const cookie = await login();
  assert.equal((await request('GET', '/api/admin/overview', { cookie })).status, 200);
  const out = await request('POST', '/api/admin/logout', { cookie });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('GET', '/api/admin/overview', { cookie })).status, 401);

  const second = await login();
  clock.now = new Date(clock.now.getTime() + 7 * 24 * 60 * 60 * 1000 + 1000);
  assert.equal((await request('GET', '/api/admin/overview', { cookie: second })).status, 401);
});

test('과제 만들기·고치기·지우기', async (t) => {
  const { request, login, createAssignment } = await start(t);
  const cookie = await login();

  const invalid = await request('POST', '/api/admin/assignments', { cookie, body: { title: '   ', dueAt: 'soon' } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(Object.keys(invalid.json.error.fields).sort(), ['dueAt', 'title']);

  const created = await createAssignment(cookie, { title: ' 1차 과제 ', description: '링크를 내세요', dueAt: '2026-11-20T14:59:00.000Z' });
  assert.match(created.slug, /^[a-z0-9]{8}$/);
  assert.equal(created.title, '1차 과제');
  assert.equal(created.state, 'open');
  assert.equal(created.allowLate, true);
  assert.equal(created.isOpen, true);

  const site = await request('GET', '/api/site');
  assert.deepEqual(site.json.assignments, [
    { slug: created.slug, title: '1차 과제', description: '링크를 내세요', dueAt: '2026-11-20T14:59:00.000Z', allowLate: true, state: 'open' },
  ]);

  const updated = await request('PUT', `/api/admin/assignments/${created.id}`, {
    cookie,
    body: { title: '1차 과제(수정)', description: '', dueAt: null, allowLate: false, isOpen: false },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.assignment.state, 'closed');
  assert.equal(updated.json.assignment.slug, created.slug, '주소는 바뀌지 않는다');

  assert.equal((await request('PUT', '/api/admin/assignments/999', { cookie, body: { title: 'x' } })).status, 404);
  assert.equal((await request('DELETE', `/api/admin/assignments/${created.id}`, { cookie })).status, 200);
  assert.equal((await request('DELETE', `/api/admin/assignments/${created.id}`, { cookie })).status, 404);
  assert.deepEqual((await request('GET', '/api/site')).json.assignments, []);
});

test('제출: 처음 내기 → 틀린 비밀번호 거절 → 맞는 비밀번호로 고치기 → 같은 내용은 그대로', async (t) => {
  const { request, login, createAssignment, submit, clock } = await start(t);
  const cookie = await login();
  const assignment = await createAssignment(cookie);

  const first = await submit(assignment.slug, { studentId: ' ２０３０１ ', url: 'example.com/v1', note: '첫 제출' });
  assert.equal(first.status, 201);
  assert.equal(first.json.status, 'created');
  assert.deepEqual(first.json.submission, {
    studentId: '20301',
    name: '김하늘',
    url: 'https://example.com/v1',
    note: '첫 제출',
    revision: 1,
    createdAt: '2026-11-15T03:00:00.000Z',
    updatedAt: '2026-11-15T03:00:00.000Z',
    isLate: false,
  });
  assert.equal(JSON.stringify(first.json).includes('scrypt'), false, '비밀번호 해시는 응답에 없다');

  const wrong = await submit(assignment.slug, { url: 'https://evil.example/', password: 'guess-0000' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error.code, 'wrong_password');
  assert.ok(wrong.json.error.fields.password);

  clock.now = new Date('2026-11-15T04:00:00.000Z');
  const second = await submit(assignment.slug, { url: 'https://example.com/v2', note: '' });
  assert.equal(second.status, 200);
  assert.equal(second.json.status, 'updated');
  assert.equal(second.json.submission.revision, 2);
  assert.equal(second.json.submission.createdAt, '2026-11-15T03:00:00.000Z');
  assert.equal(second.json.submission.updatedAt, '2026-11-15T04:00:00.000Z');

  clock.now = new Date('2026-11-15T05:00:00.000Z');
  const same = await submit(assignment.slug, { url: 'https://example.com/v2', note: '' });
  assert.equal(same.status, 200);
  assert.equal(same.json.status, 'unchanged');
  assert.equal(same.json.submission.revision, 2);
  assert.equal(same.json.submission.updatedAt, '2026-11-15T04:00:00.000Z');

  const list = await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie });
  assert.equal(list.json.submissions.length, 1);
  const [row] = list.json.submissions;
  assert.equal(row.url, 'https://example.com/v2');
  assert.equal(row.hasPassword, true);
  assert.equal('history' in row, false, '이전 링크는 목록에 싣지 않는다');
  assert.equal(JSON.stringify(list.json).includes('scrypt'), false);

  const detail = await request('GET', `/api/admin/submissions/${row.id}`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.submission.url, 'https://example.com/v2');
  assert.deepEqual(detail.json.submission.history, [{ name: '김하늘', url: 'https://example.com/v1', note: '첫 제출', submittedAt: '2026-11-15T03:00:00.000Z', isLate: false }]);
  assert.equal(JSON.stringify(detail.json).includes('scrypt'), false);
  assert.equal((await request('GET', '/api/admin/submissions/999', { cookie })).status, 404);
});

test('제출: 잘못된 입력은 항목별 안내와 함께 거절한다', async (t) => {
  const { request, login, createAssignment, submit } = await start(t);
  const assignment = await createAssignment(await login());

  const bad = await submit(assignment.slug, { studentId: '', name: '', url: 'javascript:alert(1)', password: '12' });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.json.error.fields).sort(), ['name', 'password', 'studentId', 'url']);

  assert.equal((await submit('nosuchslug')).status, 404);
  assert.equal((await submit(assignment.slug, { url: 'http://localhost:3000/' })).status, 400);

  const notJson = await request('POST', `/api/assignments/${assignment.slug}/submissions`, {
    raw: 'studentId=1&name=a',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(notJson.status, 415);
  const broken = await request('POST', `/api/assignments/${assignment.slug}/submissions`, { raw: '{"studentId":', headers: { 'Content-Type': 'application/json' } });
  assert.equal(broken.status, 400);
  const array = await request('POST', `/api/assignments/${assignment.slug}/submissions`, { raw: '[1,2]', headers: { 'Content-Type': 'application/json' } });
  assert.equal(array.status, 400);
  const huge = await request('POST', `/api/assignments/${assignment.slug}/submissions`, {
    raw: JSON.stringify({ note: 'x'.repeat(40 * 1024) }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(huge.status, 413);
});

test('비밀번호를 여러 번 틀리면 그 학번만 잠기고, 시간이 지나면 풀린다', async (t) => {
  const { login, createAssignment, submit, clock } = await start(t);
  const assignment = await createAssignment(await login());
  assert.equal((await submit(assignment.slug)).status, 201);

  for (let i = 0; i < 8; i += 1) {
    assert.equal((await submit(assignment.slug, { url: 'https://example.com/x', password: `wrong-${i}` })).status, 403);
  }
  const locked = await submit(assignment.slug, { url: 'https://example.com/x' });
  assert.equal(locked.status, 429, '잠긴 동안에는 맞는 비밀번호도 받지 않는다');

  const other = await submit(assignment.slug, { studentId: '20302', name: '이도윤' });
  assert.equal(other.status, 201, '다른 학번은 영향을 받지 않는다');

  clock.now = new Date(clock.now.getTime() + 11 * 60 * 1000);
  assert.equal((await submit(assignment.slug, { url: 'https://example.com/x' })).status, 200);
});

test('마감: 지각 허용이면 받되 지각으로 표시하고, 아니면 받지 않는다', async (t) => {
  const { request, login, createAssignment, submit, clock } = await start(t);
  const cookie = await login();
  const lenient = await createAssignment(cookie, { title: '지각 허용', dueAt: '2026-11-15T06:00:00.000Z', allowLate: true });
  const strict = await createAssignment(cookie, { title: '지각 불가', dueAt: '2026-11-15T06:00:00.000Z', allowLate: false });
  const manual = await createAssignment(cookie, { title: '직접 닫음', isOpen: false });

  assert.equal((await submit(lenient.slug)).json.submission.isLate, false);
  assert.equal((await submit(strict.slug)).status, 201);
  const closed = await submit(manual.slug);
  assert.equal(closed.status, 403);
  assert.equal(closed.json.error.code, 'closed');

  clock.now = new Date('2026-11-15T06:00:00.001Z');
  const states = Object.fromEntries((await request('GET', '/api/site')).json.assignments.map((a) => [a.title, a.state]));
  assert.deepEqual(states, { '지각 허용': 'late', '지각 불가': 'closed', '직접 닫음': 'closed' });

  // 같은 내용을 마감 뒤에 다시 눌러도 지각이 되지 않는다.
  const again = await submit(lenient.slug);
  assert.equal(again.json.status, 'unchanged');
  assert.equal(again.json.submission.isLate, false);

  // 이름이나 메모만 고쳐도 제출 시각은 그대로다.
  const renamed = await submit(lenient.slug, { name: '김 하늘', note: '이름 띄어쓰기를 고쳤습니다' });
  assert.equal(renamed.json.status, 'updated');
  assert.equal(renamed.json.submission.name, '김 하늘');
  assert.equal(renamed.json.submission.note, '이름 띄어쓰기를 고쳤습니다');
  assert.equal(renamed.json.submission.isLate, false);
  assert.equal(renamed.json.submission.revision, 1);
  assert.equal(renamed.json.submission.updatedAt, '2026-11-15T03:00:00.000Z');

  // 링크를 바꾸면 지각이 되고, 기한 안에 낸 기록은 남는다.
  const changed = await submit(lenient.slug, { url: 'https://example.com/late' });
  assert.equal(changed.json.status, 'updated');
  assert.equal(changed.json.submission.isLate, true);
  const fresh = await submit(lenient.slug, { studentId: '20302', name: '이도윤' });
  assert.equal(fresh.status, 201);
  assert.equal(fresh.json.submission.isLate, true);

  const blocked = await submit(strict.slug, { url: 'https://example.com/late' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'closed');

  const list = await request('GET', `/api/admin/assignments/${lenient.id}/submissions`, { cookie });
  const first = list.json.submissions.find((s) => s.studentId === '20301');
  assert.equal(first.isLate, true);
  const { history } = (await request('GET', `/api/admin/submissions/${first.id}`, { cookie })).json.submission;
  assert.equal(history.length, 1);
  assert.equal(history[0].isLate, false);
  assert.equal(history[0].url, 'https://example.com/work');

  const overview = await request('GET', '/api/admin/overview', { cookie });
  const row = overview.json.assignments.find((a) => a.id === lenient.id);
  assert.equal(row.submissionCount, 2);
  assert.equal(row.lateCount, 2);

  // 마감을 늦추면 지각 표시가 바로 풀린다.
  await request('PUT', `/api/admin/assignments/${lenient.id}`, { cookie, body: { title: '지각 허용', dueAt: '2026-11-16T00:00:00.000Z' } });
  const relaxed = await request('GET', `/api/admin/assignments/${lenient.id}/submissions`, { cookie });
  assert.deepEqual(relaxed.json.submissions.map((s) => s.isLate), [false, false]);
});

test('제출 확인: 학번과 비밀번호가 맞아야 자기 제출을 볼 수 있다', async (t) => {
  const { request, login, createAssignment, submit } = await start(t);
  const assignment = await createAssignment(await login());
  await submit(assignment.slug);
  const lookup = (body) => request('POST', `/api/assignments/${assignment.slug}/lookup`, { body });

  assert.equal((await lookup({})).status, 400);
  const none = await lookup({ studentId: '99999', password: 'pass1234' });
  assert.equal(none.status, 404);
  assert.equal(none.json.error.code, 'no_submission');
  const wrong = await lookup({ studentId: '20301', password: 'nope' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error.code, 'wrong_password');
  const found = await lookup({ studentId: ' 20301', password: 'pass1234' });
  assert.equal(found.status, 200);
  assert.equal(found.json.submission.url, 'https://example.com/work');
});

test('명단: 미제출자와 명단에 없는 학생을 가려낸다', async (t) => {
  const { request, login, createAssignment, submit } = await start(t);
  const cookie = await login();
  const assignment = await createAssignment(cookie);

  const bad = await request('PUT', '/api/admin/roster', { cookie, body: { students: [{ studentId: '!!', name: '가' }] } });
  assert.equal(bad.status, 400);

  const saved = await request('PUT', '/api/admin/roster', {
    cookie,
    body: {
      students: [
        { studentId: '20301', name: '김하늘' },
        { studentId: '20302', name: '이도윤' },
        { studentId: '20303', name: '박서연' },
      ],
    },
  });
  assert.deepEqual(saved.json, { count: 3, rosterOnly: false });
  assert.equal((await request('GET', '/api/admin/roster', { cookie })).json.students.length, 3);

  await submit(assignment.slug, { studentId: '20301', name: '김하늘' });
  await submit(assignment.slug, { studentId: '20302', name: '이 도윤' });
  await submit(assignment.slug, { studentId: '99999', name: '전학생' });

  const list = await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie });
  assert.equal(list.json.rosterCount, 3);
  assert.deepEqual(list.json.missing, [{ studentId: '20303', name: '박서연' }]);
  assert.deepEqual(
    list.json.submissions.map((s) => [s.studentId, s.name, s.rosterName]),
    [
      ['20301', '김하늘', '김하늘'],
      ['20302', '이 도윤', '이도윤'],
      ['99999', '전학생', null],
    ],
  );

  await request('PUT', '/api/admin/roster', { cookie, body: { students: [] } });
  const cleared = await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie });
  assert.equal(cleared.json.rosterCount, 0);
  assert.deepEqual(cleared.json.missing, []);
});

test('"명단에 있는 학번만 받기"를 켜면 명단 밖 학번은 새로 낼 수 없다', async (t) => {
  const { request, login, createAssignment, submit } = await start(t);
  const cookie = await login();
  const assignment = await createAssignment(cookie);
  const students = [{ studentId: '20301', name: '김하늘' }];

  assert.equal((await submit(assignment.slug, { studentId: '99999', name: '전학생' })).status, 201, '꺼져 있으면 누구나 낸다');

  const saved = await request('PUT', '/api/admin/roster', { cookie, body: { students, rosterOnly: true } });
  assert.deepEqual(saved.json, { count: 1, rosterOnly: true });
  assert.equal((await request('GET', '/api/admin/roster', { cookie })).json.rosterOnly, true);

  const typo = await submit(assignment.slug, { studentId: '20310', name: '김하늘' });
  assert.equal(typo.status, 400);
  assert.match(typo.json.error.fields.studentId, /명단에 없는 학번/);
  assert.equal((await submit(assignment.slug, { studentId: '20301' })).status, 201);
  assert.equal((await submit(assignment.slug, { studentId: '99999', name: '전학생', url: 'https://example.com/v2' })).status, 200, '이미 낸 학생은 계속 고칠 수 있다');

  // 명단만 다시 저장하면 설정은 그대로이고, 명단을 비우면 적용되지 않는다.
  assert.equal((await request('PUT', '/api/admin/roster', { cookie, body: { students } })).json.rosterOnly, true);
  await request('PUT', '/api/admin/roster', { cookie, body: { students: [] } });
  assert.equal((await submit(assignment.slug, { studentId: '20310', name: '임소율' })).status, 201);
});

test('같은 학번으로 동시에 처음 제출하면 하나만 받아들인다', async (t) => {
  const { request, login, createAssignment, submit } = await start(t);
  const cookie = await login();
  const assignment = await createAssignment(cookie);

  const results = await Promise.all([
    submit(assignment.slug, { url: 'https://example.com/mine', password: 'mine-1234' }),
    submit(assignment.slug, { url: 'https://example.com/prank', password: 'prank-1234' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);

  const rows = (await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).json.submissions;
  assert.equal(rows.length, 1);
  const winner = results.find((r) => r.status === 201).json.submission;
  assert.equal(rows[0].url, winner.url);
  assert.equal(rows[0].revision, 1);
});

test('관리자: 제출 삭제와 비밀번호 초기화', async (t) => {
  const { request, login, createAssignment, submit } = await start(t);
  const cookie = await login();
  const assignment = await createAssignment(cookie);
  await submit(assignment.slug);
  await submit(assignment.slug, { studentId: '20302', name: '이도윤' });
  const rows = (await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).json.submissions;

  // 초기화하면 다음 제출에서 새 비밀번호를 정한다. 링크는 남아 있다.
  assert.equal((await request('POST', `/api/admin/submissions/${rows[0].id}/reset-password`, { cookie })).status, 200);
  const afterReset = (await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).json.submissions[0];
  assert.equal(afterReset.hasPassword, false);
  assert.equal(afterReset.url, 'https://example.com/work');
  const lookup = await request('POST', `/api/assignments/${assignment.slug}/lookup`, { body: { studentId: '20301', password: 'pass1234' } });
  assert.equal(lookup.json.error.code, 'password_reset');

  const renewed = await submit(assignment.slug, { password: 'brand-new' });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.json.status, 'unchanged');
  assert.equal((await submit(assignment.slug, { url: 'https://example.com/v2', password: 'pass1234' })).status, 403, '예전 비밀번호는 더 못 쓴다');
  assert.equal((await submit(assignment.slug, { url: 'https://example.com/v2', password: 'brand-new' })).status, 200);

  assert.equal((await request('DELETE', `/api/admin/submissions/${rows[1].id}`, { cookie })).status, 200);
  assert.equal((await request('DELETE', `/api/admin/submissions/${rows[1].id}`, { cookie })).status, 404);
  const again = await submit(assignment.slug, { studentId: '20302', name: '이도윤', password: 'another-pass' });
  assert.equal(again.status, 201, '삭제된 학번은 처음부터 다시 낼 수 있다');

  // 과제를 지우면 제출도 함께 지워진다.
  await request('DELETE', `/api/admin/assignments/${assignment.id}`, { cookie });
  assert.equal((await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).status, 404);
});

test('사이트 이름을 바꾸면 화면 제목에 반영되고, HTML로 해석되지 않는다', async (t) => {
  const { request, login, createAssignment } = await start(t);
  const cookie = await login();
  assert.equal((await request('PUT', '/api/admin/settings', { cookie, body: { title: '' } })).status, 400);

  const title = '2학년 "정보" <script>alert(1)</script>';
  assert.equal((await request('PUT', '/api/admin/settings', { cookie, body: { title } })).status, 200);
  assert.equal((await request('GET', '/api/site')).json.title, title);

  const assignment = await createAssignment(cookie, { title: '<b>1차</b> 과제', description: '설명 "첫 줄"\n둘째 줄' });
  const page = await request('GET', `/a/${assignment.slug}`);
  assert.equal(page.status, 200);
  assert.equal(page.text.includes('<script>alert(1)</script>'), false);
  assert.ok(page.text.includes('<title>&lt;b&gt;1차&lt;/b&gt; 과제 · 2학년 &quot;정보&quot; &lt;script&gt;alert(1)&lt;/script&gt;</title>'));
  assert.ok(page.text.includes('<meta property="og:description" content="설명 &quot;첫 줄&quot; 둘째 줄">'));

  assert.equal((await request('GET', '/a/nosuchslug')).status, 404);
  assert.equal((await request('GET', '/admin')).status, 200);
});

test('화면과 정적 파일: 보안 헤더, 캐시 검증, 폴더 밖 파일 차단', async (t) => {
  const { request } = await start(t);

  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

  for (const [url, type] of [
    ['/assets/styles.css', 'text/css; charset=utf-8'],
    ['/assets/student.js', 'text/javascript; charset=utf-8'],
    ['/assets/admin.js', 'text/javascript; charset=utf-8'],
    ['/assets/ui.js', 'text/javascript; charset=utf-8'],
    ['/assets/shared/rules.js', 'text/javascript; charset=utf-8'],
    ['/assets/shared/csv.js', 'text/javascript; charset=utf-8'],
    ['/assets/favicon.svg', 'image/svg+xml'],
    ['/favicon.ico', 'image/svg+xml'],
  ]) {
    const response = await request('GET', url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('content-type'), type, url);
  }

  const css = await request('GET', '/assets/styles.css');
  const cached = await request('GET', '/assets/styles.css', { headers: { 'If-None-Match': css.headers.get('etag') } });
  assert.equal(cached.status, 304);
  assert.equal(cached.text, '');

  for (const url of ['/assets/index.html', '/assets/../src/db.js', '/assets/%2e%2e/server.js', '/assets/shared/../../package.json', '/src/app.js', '/data/submissions.db', '/package.json']) {
    assert.equal((await request('GET', url)).status, 404, url);
  }

  assert.equal((await request('GET', '/healthz')).text, 'ok\n');
  assert.match((await request('GET', '/robots.txt')).text, /Disallow: \//);
  assert.equal((await request('POST', '/api/site', { body: {} })).status, 405);
  assert.equal((await request('HEAD', '/')).text, '');
});

test('다른 사이트에서 보낸 요청(CSRF)은 받지 않는다', async (t) => {
  const { request, login, createAssignment, submit } = await start(t);
  const cookie = await login();
  for (const site of ['cross-site', 'same-site', 'none']) {
    const forged = await request('POST', '/api/admin/assignments', { cookie, body: { title: '몰래 만든 과제' }, headers: { 'Sec-Fetch-Site': site } });
    assert.equal(forged.status, 403, site);
    assert.equal(forged.json.error.code, 'cross_site');
  }

  const form = await request('POST', '/api/admin/assignments', { cookie, raw: 'title=x', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(form.status, 415);

  // 본문이 없는 요청도 마찬가지다. 다른 주소의 페이지가 보낼 수 있는 형식(JSON 이 아닌 것)으로는
  // 학생의 비밀번호를 초기화하거나 제출을 지우거나 선생님을 로그아웃시킬 수 없다.
  const assignment = await createAssignment(cookie);
  await submit(assignment.slug);
  const [row] = (await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).json.submissions;
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', '']) {
    const headers = { 'Content-Type': type };
    assert.equal((await request('POST', `/api/admin/submissions/${row.id}/reset-password`, { cookie, headers })).status, 415, `reset ${type}`);
    assert.equal((await request('DELETE', `/api/admin/submissions/${row.id}`, { cookie, headers })).status, 415, `delete ${type}`);
    assert.equal((await request('POST', '/api/admin/logout', { cookie, headers })).status, 415, `logout ${type}`);
  }
  const sameSiteReset = await request('POST', `/api/admin/submissions/${row.id}/reset-password`, { cookie, headers: { 'Sec-Fetch-Site': 'same-site' } });
  assert.equal(sameSiteReset.status, 403);
  const untouched = (await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).json.submissions;
  assert.equal(untouched.length, 1);
  assert.equal(untouched[0].hasPassword, true);

  const sameOrigin = await request('POST', '/api/admin/assignments', { cookie, body: { title: '정상 과제' }, headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(sameOrigin.status, 201);
  assert.equal((await request('GET', '/api/admin/overview', { cookie })).json.assignments.length, 2);
});

test('관리자 비밀번호: 처음 실행하면 자동으로 만들고, 화면에서 바꿀 수 있다', async (t) => {
  const { app, request, login, dataDir } = await start(t, { adminPassword: '' });
  assert.match(app.generatedAdminPassword, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

  const cookie = await login(app.generatedAdminPassword);
  const other = await login(app.generatedAdminPassword);
  assert.equal((await request('GET', '/api/admin/overview', { cookie })).json.passwordFromEnv, false);

  const short = await request('POST', '/api/admin/password', { cookie, body: { currentPassword: app.generatedAdminPassword, newPassword: 'short' } });
  assert.equal(short.status, 400);
  const wrong = await request('POST', '/api/admin/password', { cookie, body: { currentPassword: 'not-this-one', newPassword: 'new-password-1' } });
  assert.equal(wrong.status, 403);
  const changed = await request('POST', '/api/admin/password', { cookie, body: { currentPassword: app.generatedAdminPassword, newPassword: 'new-password-1' } });
  assert.equal(changed.status, 200);

  assert.equal((await request('GET', '/api/admin/overview', { cookie })).status, 200, '바꾼 기기는 로그인 유지');
  assert.equal((await request('GET', '/api/admin/overview', { cookie: other })).status, 401, '다른 기기는 로그아웃');
  assert.equal((await request('POST', '/api/admin/login', { body: { password: app.generatedAdminPassword } })).status, 401);
  await login('new-password-1');

  // 비밀번호를 잊었을 때 쓰는 명령
  const reset = await resetAdminPassword(dataDir);
  assert.equal((await request('GET', '/api/admin/overview', { cookie })).status, 401, '재설정하면 모든 로그인이 풀린다');
  await login(reset);
});

test('ADMIN_PASSWORD 를 쓰면 화면에서 비밀번호를 바꿀 수 없고, 너무 짧으면 시작하지 않는다', async (t) => {
  const { app, request, login } = await start(t);
  assert.equal(app.generatedAdminPassword, null);
  const cookie = await login();
  const response = await request('POST', '/api/admin/password', { cookie, body: { currentPassword: ADMIN_PASSWORD, newPassword: 'new-password-1' } });
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'managed_by_env');

  await assert.rejects(() => createApp({ dataDir: os.tmpdir(), adminPassword: 'short' }), /8자 이상/);
  if (!USING_LIBSQL) {
    await assert.rejects(() => createApp({ dataDir: '/dev/null/cannot-write-here', adminPassword: ADMIN_PASSWORD }), /데이터 폴더를 쓸 수 없습니다/);
  }
});

test('서버를 껐다 켜도 과제·제출·로그인이 남아 있다', async (t) => {
  const first = await start(t);
  const cookie = await first.login();
  const assignment = await first.createAssignment(cookie);
  await first.submit(assignment.slug);
  await first.app.close();

  const second = await start(t, { dataDir: first.dataDir, clock: first.clock });
  assert.equal((await second.request('GET', '/api/site')).json.assignments[0].slug, assignment.slug);
  const list = await second.request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie });
  assert.equal(list.status, 200, '같은 비밀번호로 다시 켜면 로그인이 유지된다');
  assert.equal(list.json.submissions[0].studentId, '20301');
});

test('ADMIN_PASSWORD 를 바꾸거나 없애면 예전 로그인이 모두 풀린다', async (t) => {
  const first = await start(t);
  const oldCookie = await first.login();
  await first.app.close();

  const rotated = await start(t, { dataDir: first.dataDir, adminPassword: 'rotated-password-2' });
  assert.equal((await rotated.request('GET', '/api/admin/overview', { cookie: oldCookie })).status, 401, '바꾸기 전에 받은 쿠키는 더 못 쓴다');
  assert.equal((await rotated.request('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } })).status, 401);
  const newCookie = await rotated.login('rotated-password-2');
  await rotated.app.close();

  // 환경 변수를 없애고 자동으로 만든 비밀번호 방식으로 돌아가도 마찬가지다.
  const stored = await start(t, { dataDir: first.dataDir, adminPassword: '' });
  assert.ok(stored.app.generatedAdminPassword);
  assert.equal((await stored.request('GET', '/api/admin/overview', { cookie: newCookie })).status, 401);
  const storedCookie = await stored.login(stored.app.generatedAdminPassword);
  await stored.app.close();

  // 같은 방식으로 다시 켜면 유지된다.
  const again = await start(t, { dataDir: first.dataDir, adminPassword: '' });
  assert.equal(again.app.generatedAdminPassword, null);
  assert.equal((await again.request('GET', '/api/admin/overview', { cookie: storedCookie })).status, 200);
});

test('다른 기기 로그아웃과 모든 로그인 해제 명령', async (t) => {
  const { request, login, dataDir } = await start(t);
  const here = await login();
  const there = await login();

  assert.equal((await request('POST', '/api/admin/logout-others', { cookie: here })).status, 200);
  assert.equal((await request('GET', '/api/admin/overview', { cookie: here })).status, 200, '요청한 기기는 유지');
  assert.equal((await request('GET', '/api/admin/overview', { cookie: there })).status, 401, '다른 기기는 해제');

  logoutAll(dataDir);
  assert.equal((await request('GET', '/api/admin/overview', { cookie: here })).status, 401);
  await login();
});

test('한도: 링크를 바꿀 수 있는 횟수와 과제 하나가 받는 제출 수', async (t) => {
  const { request, login, createAssignment, submit } = await start(t, { limits: { maxSubmissions: 3, maxLinkChanges: 2 } });
  const cookie = await login();
  const assignment = await createAssignment(cookie);

  assert.equal((await submit(assignment.slug, { url: 'https://example.com/1' })).status, 201);
  assert.equal((await submit(assignment.slug, { url: 'https://example.com/2' })).json.submission.revision, 2);
  assert.equal((await submit(assignment.slug, { url: 'https://example.com/3' })).json.submission.revision, 3);
  const tooMany = await submit(assignment.slug, { url: 'https://example.com/4' });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.error.fields.url, /2번까지 바꿀 수 있습니다/);
  // 링크가 그대로면 이름·메모는 계속 고칠 수 있다.
  assert.equal((await submit(assignment.slug, { url: 'https://example.com/3', note: '메모만 고침' })).json.status, 'updated');

  const [row] = (await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).json.submissions;
  assert.equal(row.url, 'https://example.com/3');
  assert.equal((await request('GET', `/api/admin/submissions/${row.id}`, { cookie })).json.submission.history.length, 2);

  assert.equal((await submit(assignment.slug, { studentId: '20302' })).status, 201);
  assert.equal((await submit(assignment.slug, { studentId: '20303' })).status, 201);
  const full = await submit(assignment.slug, { studentId: '20304' });
  assert.equal(full.status, 403);
  assert.equal(full.json.error.code, 'full');
  assert.equal((await submit(assignment.slug, { studentId: '20302', note: '이미 낸 학생은 계속 고칠 수 있다' })).status, 200);

  // 다른 과제에는 영향이 없다.
  const other = await createAssignment(cookie, { title: '2차 과제' });
  assert.equal((await submit(other.slug, { studentId: '20304' })).status, 201);
});

test('제출을 지우면 그 학번에 걸린 비밀번호 잠금도 풀린다', async (t) => {
  const { request, login, createAssignment, submit } = await start(t);
  const cookie = await login();
  const assignment = await createAssignment(cookie);

  // 누군가 남의 학번으로 먼저 내고, 본인은 비밀번호를 여러 번 틀려 잠긴다.
  await submit(assignment.slug, { url: 'https://example.com/prank', password: 'prank-1234' });
  for (let i = 0; i < 8; i += 1) await submit(assignment.slug, { password: `guess-${i}` });
  assert.equal((await submit(assignment.slug, { password: 'guess-9' })).status, 429);

  // 선생님이 그 제출을 지우면 본인이 바로 다시 내고 고칠 수 있다.
  const [row] = (await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).json.submissions;
  assert.equal((await request('DELETE', `/api/admin/submissions/${row.id}`, { cookie })).status, 200);
  assert.equal((await submit(assignment.slug, { password: 'mine-1234' })).status, 201);
  assert.equal((await submit(assignment.slug, { url: 'https://example.com/v2', password: 'mine-1234' })).status, 200);
  const lookup = await request('POST', `/api/assignments/${assignment.slug}/lookup`, { body: { studentId: '20301', password: 'mine-1234' } });
  assert.equal(lookup.status, 200);
});

test('본문을 천천히 보내는 동안 과제가 닫히면 받지 않는다', async (t) => {
  const { base, request, login, createAssignment } = await start(t);
  const cookie = await login();
  const assignment = await createAssignment(cookie);
  const body = JSON.stringify({ studentId: '20301', name: 'Kim', url: 'https://example.com/w', password: 'pass1234' });

  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/api/assignments/${assignment.slug}/submissions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.write(body.slice(0, 12));
    // 본문의 앞부분만 보낸 상태에서 선생님이 과제를 닫는다.
    setTimeout(async () => {
      try {
        await request('PUT', `/api/admin/assignments/${assignment.id}`, { cookie, body: { title: '1차 과제', isOpen: false } });
        req.end(body.slice(12));
      } catch (error) {
        reject(error);
      }
    }, 100);
  });
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'closed');
  assert.equal((await request('GET', `/api/admin/assignments/${assignment.id}/submissions`, { cookie })).json.submissions.length, 0);
});

test('아주 긴 입력은 다듬지 않고 바로 거절한다', async (t) => {
  const { request, login, createAssignment, submit } = await start(t);
  const cookie = await login();
  const assignment = await createAssignment(cookie);

  const started = performance.now();
  // 요청 본문 한도(32KB) 바로 아래 크기로 보낸다.
  const spaces = await submit(assignment.slug, { note: `${' '.repeat(30000)}x` });
  const marks = await submit(assignment.slug, { name: `a${'\u0301'.repeat(15000)}` });
  const lookup = await request('POST', `/api/assignments/${assignment.slug}/lookup`, { body: { studentId: '1'.repeat(12000), password: 'p'.repeat(12000) } });
  const elapsed = performance.now() - started;

  assert.equal(spaces.status, 400);
  assert.ok(spaces.json.error.fields.note);
  assert.equal(marks.status, 400);
  assert.ok(marks.json.error.fields.name);
  assert.equal(lookup.status, 400);
  assert.deepEqual(Object.keys(lookup.json.error.fields).sort(), ['password', 'studentId']);
  assert.ok(elapsed < 1000, `세 요청에 ${Math.round(elapsed)}ms 걸렸다`);

  const title = await request('POST', '/api/admin/assignments', { cookie, body: { title: 'x'.repeat(5000), description: ` ${' '.repeat(25000)}y` } });
  assert.equal(title.status, 400);
  assert.deepEqual(Object.keys(title.json.error.fields).sort(), ['description', 'title']);
});

test('요청 제한용 접속자 구분: IPv4는 그대로, IPv6는 /64 단위로 묶는다', () => {
  assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:0DB8:0001:0002::1'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateKey('::1'), '0:0:0:0::/64');
  assert.equal(rateKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(rateKey('2001:db8:1:2:ffff::9'), rateKey('2001:db8:1:2::1'), '같은 /64 안의 주소는 한 사람으로 센다');
  assert.notEqual(rateKey('2001:db8:1:3::1'), rateKey('2001:db8:1:2::1'));
  assert.equal(rateKey('unknown'), 'unknown');

  // 프록시가 포트를 붙여 보내는 경우: 포트마다 다른 사람으로 세면 제한이 무의미해진다.
  assert.equal(rateKey('203.0.113.77:40001'), '203.0.113.77');
  assert.equal(rateKey('203.0.113.77:40002'), '203.0.113.77');
  assert.equal(rateKey('[2001:db8:1:2::9]:443'), '2001:db8:1:2::/64');
  assert.equal(rateKey('[2001:db8:1:2::9]'), '2001:db8:1:2::/64');
  // IP 주소가 아닌 값은 모두 한 묶음이다.
  for (const junk of ['', 'abc', '999.1.1.1', '1.2.3', '203.0.113.7:abc', 'x:y', '<script>', undefined, null]) {
    assert.equal(rateKey(junk), 'unknown', String(junk));
  }
});

test('X-Forwarded-For 는 같은 컴퓨터나 사설망에서 온 접속일 때만 믿는다', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.0.5', '169.254.1.1', '100.64.0.1', 'fd12:3456::1', 'fe80::1%eth0']) {
    assert.equal(isProxyPeer(peer), true, peer);
  }
  for (const peer of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '::ffff:8.8.8.8', '', 'unknown', undefined]) {
    assert.equal(isProxyPeer(peer), false, String(peer));
  }
});

test('데이터 파일은 본인만 읽을 수 있게 만든다', { skip: process.platform === 'win32' || USING_LIBSQL }, async (t) => {
  const { dataDir } = await start(t);
  const { statSync } = await import('node:fs');
  assert.equal(statSync(path.join(dataDir, 'submissions.db')).mode & 0o077, 0);
});

test('프록시 뒤에서는 TRUST_PROXY 설정이 있을 때만 X-Forwarded-For 를 믿는다', async (t) => {
  const direct = await start(t);
  for (let i = 0; i < 10; i += 1) {
    await direct.request('POST', '/api/admin/login', { body: { password: 'wrong-wrong' }, headers: { 'X-Forwarded-For': `203.0.113.${i}` } });
  }
  const spoofed = await direct.request('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD }, headers: { 'X-Forwarded-For': '203.0.113.99' } });
  assert.equal(spoofed.status, 429, '헤더를 바꿔 가며 제한을 피할 수 없다');

  const proxied = await start(t, { trustProxy: 1 });
  for (let i = 0; i < 10; i += 1) {
    await proxied.request('POST', '/api/admin/login', { body: { password: 'wrong-wrong' }, headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.5' } });
  }
  const sameClient = await proxied.request('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD }, headers: { 'X-Forwarded-For': '203.0.113.5:51234' } });
  assert.equal(sameClient.status, 429, '포트가 붙어 와도 같은 접속자로 센다');
  const otherClient = await proxied.request('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD }, headers: { 'X-Forwarded-For': '203.0.113.6' } });
  assert.equal(otherClient.status, 200, '다른 접속자는 막히지 않는다');
});

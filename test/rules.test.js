import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIMITS,
  checkFile,
  compareStudentIds,
  formatBytes,
  multiLine,
  nameKey,
  normalizeFileName,
  normalizeStudentId,
  normalizeUrl,
  parseRosterText,
  validateAssignment,
  validateRoster,
  validateSubmission,
} from '../shared/rules.js';
import { csvCell, submissionTable, toCsv } from '../shared/csv.js';

test('학번은 전각 숫자·빈칸·소문자를 정리해서 같은 값으로 만든다', () => {
  assert.equal(normalizeStudentId(' ２０３ 15 '), '20315');
  assert.equal(normalizeStudentId('ab-12'), 'AB-12');
  assert.equal(normalizeStudentId(20315), '20315');
  assert.equal(normalizeStudentId({ toString: () => 'x' }), '');
  assert.equal(normalizeStudentId(null), '');
});

test('링크는 http(s) 주소로 정리된다', () => {
  assert.equal(normalizeUrl('https://github.com/me/repo').url, 'https://github.com/me/repo');
  assert.equal(normalizeUrl('  docs.google.com/document/d/abc/edit ').url, 'https://docs.google.com/document/d/abc/edit');
  assert.equal(normalizeUrl('http://example.com:8080/a?b=1#c').url, 'http://example.com:8080/a?b=1#c');
  assert.equal(normalizeUrl('example.com:8080/a').url, 'https://example.com:8080/a');
  assert.equal(normalizeUrl('https://example.com/한글 없는/경로').error !== undefined, true, '빈칸이 있으면 거절');
  assert.equal(normalizeUrl('https://blog.example.com/글/첫번째').url, 'https://blog.example.com/%EA%B8%80/%EC%B2%AB%EB%B2%88%EC%A7%B8');
});

test('열 수 없거나 위험한 링크는 받지 않는다', () => {
  const rejected = [
    '',
    '   ',
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///C:/Users/me/index.html',
    'C:\\Users\\me\\index.html',
    'ftp://example.com/file',
    'mailto:teacher@example.com',
    'http://localhost:3000',
    'localhost:5500/index.html',
    'http://127.0.0.1:5500/index.html',
    'http://192.168.0.10/work',
    'http://10.1.2.3/',
    'http://172.20.1.1/',
    'http://[::1]/',
    'http://my-pc.local/site',
    'https://user:pass@example.com/',
    'https://example.com@evil.example/',
    'https://intranet/page',
    '제 과제입니다 https://example.com',
    `https://example.com/${'a'.repeat(LIMITS.url)}`,
  ];
  for (const input of rejected) {
    const result = normalizeUrl(input);
    assert.ok(result.error, `거절해야 하는 입력: ${JSON.stringify(input)}`);
    assert.equal(result.url, undefined);
  }
});

test('받아들인 링크는 항상 http:// 또는 https:// 로 시작한다', () => {
  const inputs = ['example.com', 'HTTP://EXAMPLE.COM/a', '//example.com/a', 'https://example.com/#javascript:alert(1)', 'example.com/javascript:alert(1)'];
  for (const input of inputs) {
    const { url } = normalizeUrl(input);
    assert.match(url, /^https?:\/\//, input);
  }
});

test('제출 내용 검사: 빠진 항목마다 안내문이 나온다', () => {
  const { errors } = validateSubmission({});
  assert.deepEqual(Object.keys(errors).sort(), ['name', 'password', 'studentId', 'url']);

  const ok = validateSubmission({ studentId: ' 20315 ', name: '  김  하늘 ', url: 'example.com/w', note: ' 메모 \r\n\r\n\r\n\r\n끝  ', password: '1234' });
  assert.equal(ok.errors, null);
  assert.deepEqual(ok.value, { studentId: '20315', name: '김 하늘', url: 'https://example.com/w', note: '메모\n\n끝', password: '1234' });

  assert.ok(validateSubmission({ studentId: '2 0315!', name: '가', url: 'example.com', password: '1234' }).errors.studentId);
  assert.ok(validateSubmission({ studentId: '1', name: '가'.repeat(LIMITS.name + 1), url: 'example.com', password: '1234' }).errors.name);
  assert.ok(validateSubmission({ studentId: '1', name: '가', url: 'example.com', password: '123' }).errors.password);
  assert.ok(validateSubmission({ studentId: '1', name: '가', url: 'example.com', password: 1234 }).errors.password, '숫자 타입 비밀번호는 받지 않는다');
  assert.ok(validateSubmission({ studentId: '1', name: '가', url: 'example.com', password: '1234', note: '가'.repeat(LIMITS.note + 1) }).errors.note);
});

test('학번을 꼭 받지 않는 과제에서는 비워 둔 학번도 받는다', () => {
  const rest = { name: '홍길동', url: 'https://example.com/a', password: 'pass1234' };
  assert.ok(validateSubmission({ ...rest, studentId: '' }).errors.studentId, '따로 정하지 않으면 학번은 필수');

  const blank = validateSubmission({ ...rest, studentId: '  ' }, { requireStudentId: false });
  assert.equal(blank.errors, null);
  assert.equal(blank.value.studentId, '');
  assert.equal(validateSubmission(rest, { requireStudentId: false }).errors, null, '학번 항목이 아예 없어도 된다');

  // 적었다면 똑같이 다듬고 검사한다.
  assert.equal(validateSubmission({ ...rest, studentId: ' ２０３０１ ' }, { requireStudentId: false }).value.studentId, '20301');
  assert.ok(validateSubmission({ ...rest, studentId: '!!' }, { requireStudentId: false }).errors.studentId);
  assert.ok(validateSubmission({ ...rest, studentId: ' '.repeat(500) }, { requireStudentId: false }).errors.studentId, '터무니없이 긴 입력은 빈칸뿐이어도 받지 않는다');
  // 이름은 여전히 필수다. 학번이 없으면 이름으로 구분하기 때문이다.
  assert.ok(validateSubmission({ ...rest, name: ' ' }, { requireStudentId: false }).errors.name);
});

test('파일을 첨부한 제출은 링크를 비워 둘 수 있다', () => {
  const rest = { studentId: '20301', name: '김하늘', password: 'pass1234' };
  assert.ok(validateSubmission({ ...rest, url: '' }).errors.url, '따로 정하지 않으면 링크는 필수');

  const blank = validateSubmission({ ...rest, url: '  ' }, { urlOptional: true });
  assert.equal(blank.errors, null);
  assert.equal(blank.value.url, '');
  assert.equal(validateSubmission(rest, { urlOptional: true }).errors, null, '링크 항목이 아예 없어도 된다');

  // 적었다면 똑같이 다듬고 검사한다.
  assert.equal(validateSubmission({ ...rest, url: 'example.com/a' }, { urlOptional: true }).value.url, 'https://example.com/a');
  assert.ok(validateSubmission({ ...rest, url: 'javascript:alert(1)' }, { urlOptional: true }).errors.url);
  assert.ok(validateSubmission({ ...rest, url: ' '.repeat(9000) }, { urlOptional: true }).errors.url, '터무니없이 긴 입력은 빈칸뿐이어도 받지 않는다');
});

test('첨부 파일 이름은 폴더 구분 글자와 쓸 수 없는 글자를 바꾸고, 너무 길면 확장자를 남기고 자른다', () => {
  assert.equal(normalizeFileName(' 내 과제.html '), '내 과제.html');
  assert.equal(normalizeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(normalizeFileName('C:\\Users\\me\\a<b>.txt'), 'C__Users_me_a_b_.txt');
  assert.equal(normalizeFileName('..숨김.txt.'), '숨김.txt');
  assert.equal(normalizeFileName('줄\n바꿈\u200B.txt'), '줄 바꿈.txt');
  assert.equal(normalizeFileName(' .. '), '');
  assert.equal(normalizeFileName(undefined), '');
  assert.equal(normalizeFileName(42), '42');

  const long = normalizeFileName(`${'가'.repeat(300)}.pptx`);
  assert.equal(long.length, LIMITS.fileName);
  assert.ok(long.endsWith('.pptx'));
  assert.equal(normalizeFileName('x'.repeat(5000)).length, LIMITS.fileName);
});

test('첨부 파일 검사: 실행 파일, 빈 파일, 너무 큰 파일은 받지 않는다', () => {
  const limit = 10 * 1024 * 1024;
  assert.equal(checkFile('game.html', 1200, limit), null);
  assert.equal(checkFile('사진.JPG', limit, limit), null);
  assert.equal(checkFile('확장자없음', 10, limit), null);
  assert.match(checkFile('', 10, limit), /파일 이름/);
  assert.match(checkFile('setup.EXE', 10, limit), /\.exe 파일은 올릴 수 없습니다/);
  assert.match(checkFile('run.bat', 10, limit), /\.bat/);
  assert.equal(checkFile('game.exe.zip', 10, limit), null, '압축한 것은 받는다');
  assert.match(checkFile('a.txt', 0, limit), /빈 파일/);
  assert.match(checkFile('a.txt', limit + 1, limit), /10MB까지/);
  for (const size of [-1, 1.5, '10', null, undefined, Number.NaN]) assert.match(checkFile('a.txt', size, limit), /읽을 수 없습니다/);
});

test('파일 크기는 읽기 쉬운 단위로 보여 준다', () => {
  assert.deepEqual(
    [0, 500, 1024, 820 * 1024, 3.44 * 1024 * 1024, 10 * 1024 * 1024, 250 * 1024 * 1024, 1024 ** 3, 1.5 * 1024 ** 3].map(formatBytes),
    ['0B', '500B', '1KB', '820KB', '3.4MB', '10MB', '250MB', '1GB', '1.5GB'],
  );
});

test('이름으로 구분할 때는 띄어쓰기·대소문자·전각 차이를 무시한다', () => {
  assert.equal(nameKey(' 홍 길동 '), '홍길동');
  assert.equal(nameKey('Hong  Gildong'), nameKey('hong gildong'));
  assert.equal(nameKey('ＡＢＣ'), 'abc');
  assert.notEqual(nameKey('홍길동'), nameKey('홍길순'));
});

test('보이지 않는 제어 문자와 방향 뒤집기 문자는 지운다', () => {
  const { value } = validateSubmission({ studentId: '20\u200B315', name: '김\u202E하늘\u0007', url: 'example.com', password: '1234' });
  assert.equal(value.studentId, '20315');
  assert.equal(value.name, '김하늘');
});

test('여러 줄 글 다듬기는 빈칸이 길게 이어져도 느려지지 않는다', () => {
  assert.equal(multiLine('첫 줄   \r\n둘째 줄\t \n\n\n\n  셋째 줄  '), '첫 줄\n둘째 줄\n\n  셋째 줄');

  // 예전에는 줄 끝 빈칸을 정규식으로 지워서, 이런 입력 하나에 수십 초가 걸렸다.
  const started = performance.now();
  assert.equal(multiLine(`${' '.repeat(200000)}x`), 'x');
  assert.equal(multiLine(`${'a \t'.repeat(50000)}\n${' '.repeat(100000)}b`).endsWith('b'), true);
  assert.ok(performance.now() - started < 1000);

  // 검사 함수는 한도의 몇 배가 넘는 입력을 다듬지도 않는다.
  const { errors } = validateSubmission({ studentId: '1'.repeat(10000), name: '가'.repeat(10000), url: `example.com/${'a'.repeat(10000)}`, note: ' '.repeat(100000), password: '1234' });
  assert.deepEqual(Object.keys(errors).sort(), ['name', 'note', 'studentId', 'url']);
});

test('과제 검사: 제목은 필수, 마감 일시는 시간대가 붙은 값만 받는다', () => {
  assert.ok(validateAssignment({}).errors.title);
  assert.ok(validateAssignment({ title: '과제', dueAt: '2026-11-20T23:59' }).errors.dueAt, '시간대 없는 값');
  assert.ok(validateAssignment({ title: '과제', dueAt: 'tomorrow' }).errors.dueAt);
  assert.ok(validateAssignment({ title: '과제', dueAt: 1795000000000 }).errors.dueAt);
  assert.ok(validateAssignment({ title: '과제', dueAt: '1999-01-01T00:00:00Z' }).errors.dueAt);

  const { value, errors } = validateAssignment({ title: ' 1차  과제 ', description: '안내\r\n둘째 줄', dueAt: '2026-11-20T23:59:00+09:00', allowLate: false });
  assert.equal(errors, null);
  assert.deepEqual(value, {
    title: '1차 과제',
    description: '안내\n둘째 줄',
    dueAt: '2026-11-20T14:59:00.000Z',
    allowLate: false,
    isOpen: true,
    requireStudentId: true,
    allowFiles: true,
  });
  assert.equal(validateAssignment({ title: '과제', allowFiles: false }).value.allowFiles, false);
  assert.equal(validateAssignment({ title: '과제', requireStudentId: false }).value.requireStudentId, false);
  assert.equal(validateAssignment({ title: '과제', dueAt: '' }).value.dueAt, null);
  assert.equal(validateAssignment({ title: '과제', dueAt: null }).value.dueAt, null);
});

test('붙여 넣은 명단을 읽는다: 탭·쉼표·빈칸, 머리글, 중복', () => {
  const { students, problems } = parseRosterText('학번\t이름\n20301\t김하늘\n20302, 이도윤\n20303 박 서연\n\n20301 김하늘(전입)\n이름만\n20304!! 최지우');
  assert.deepEqual(students, [
    { studentId: '20301', name: '김하늘(전입)' },
    { studentId: '20302', name: '이도윤' },
    { studentId: '20303', name: '박 서연' },
  ]);
  assert.deepEqual(
    problems.map((problem) => problem.line),
    [7, 8],
  );
});

test('서버가 받는 명단 검사', () => {
  assert.ok(validateRoster('nope').error);
  assert.ok(validateRoster([{ studentId: '1', name: '' }]).error);
  assert.ok(validateRoster(Array.from({ length: LIMITS.rosterSize + 1 }, (_, i) => ({ studentId: String(i), name: '가' }))).error);
  assert.deepEqual(validateRoster([{ studentId: ' a1 ', name: ' 김 ' }, { studentId: 'A1', name: '이' }]).students, [{ studentId: 'A1', name: '이' }]);
});

test('학번 정렬은 숫자를 숫자로 비교한다', () => {
  assert.deepEqual(['10215', '2031', '10101', '20301', '9'].sort(compareStudentIds), ['9', '2031', '10101', '10215', '20301']);
});

test('CSV: 따옴표·쉼표·줄바꿈을 감싸고 수식으로 실행될 글자를 막는다', () => {
  assert.equal(csvCell('가,나'), '"가,나"');
  assert.equal(csvCell('그는 "네"라고'), '"그는 ""네""라고"');
  assert.equal(csvCell('첫 줄\n둘째 줄'), '"첫 줄\n둘째 줄"');
  assert.equal(csvCell('=HYPERLINK("http://evil","click")'), '"\'=HYPERLINK(""http://evil"",""click"")"');
  assert.equal(csvCell('+82-10'), "'+82-10");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(3), '3');

  const csv = toCsv([
    ['학번', '이름'],
    ['20301', '김하늘'],
  ]);
  assert.equal(csv, '\uFEFF학번,이름\r\n20301,김하늘\r\n');
});

test('CSV 표: 제출한 학생 뒤에 미제출 학생이 붙는다', () => {
  const rows = submissionTable(
    {
      submissions: [
        { studentId: '20301', name: '김하늘', isLate: false, url: 'https://a.example/1', note: '', updatedAt: 'U1', createdAt: 'C1', revision: 1 },
        { studentId: '20302', name: '이도윤', isLate: true, url: 'https://a.example/2', note: '늦었습니다', updatedAt: 'U2', createdAt: 'C2', revision: 3 },
        { studentId: '', name: '최지우', isLate: false, url: '', file: { name: 'game.html', size: 1200 }, note: '', updatedAt: 'U3', createdAt: 'C3', revision: 1 },
      ],
      missing: [{ studentId: '20303', name: '박서연' }],
    },
    (value) => `t:${value}`,
  );
  assert.deepEqual(rows, [
    ['학번', '이름', '상태', '링크', '파일', '메모', '제출 시각', '처음 제출한 시각', '제출 횟수'],
    ['20301', '김하늘', '제출', 'https://a.example/1', '', '', 't:U1', 't:C1', 1],
    ['20302', '이도윤', '지각', 'https://a.example/2', '', '늦었습니다', 't:U2', 't:C2', 3],
    ['', '최지우', '제출', '', 'game.html', '', 't:U3', 't:C3', 1],
    ['20303', '박서연', '미제출', '', '', '', '', '', 0],
  ]);
});

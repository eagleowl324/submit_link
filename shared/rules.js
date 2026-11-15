// 입력값을 다듬고 검사하는 규칙입니다.
// 서버(src/app.js)와 브라우저(public/*.js)가 이 파일 하나를 같이 씁니다.

export const LIMITS = Object.freeze({
  studentId: 30,
  name: 40,
  url: 2000,
  note: 500,
  passwordMin: 4,
  passwordMax: 100,
  title: 100,
  description: 2000,
  siteTitle: 60,
  rosterSize: 5000,
  adminPasswordMin: 8,
  adminPasswordMax: 200,
});

// 화면에 보이지 않는 제어 문자, 글자 방향을 뒤집는 문자. 탭·줄바꿈은 남깁니다.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

const STUDENT_ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const HAS_TIME_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const BAD_URL = '올바른 링크 주소가 아닙니다. 예: https://example.com/my-work';
const URL_TOO_LONG = `링크가 너무 깁니다. (${LIMITS.url}자까지)`;

function text(raw) {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

// 다듬기 전의 길이 한도는 정해진 글자 수의 4배입니다.
// 누구나 보낼 수 있는 입력이므로, 터무니없이 긴 글을 다듬느라 서버가 붙잡히지 않게 먼저 걸러 냅니다.
function oversized(raw, limit) {
  return typeof raw === 'string' && raw.length > limit * 4;
}

// 값 하나를 다듬고 검사합니다. 한도를 한참 넘는 입력은 다듬지 않고 바로 "너무 깁니다"로 답합니다.
function read(raw, limit, normalize, check) {
  if (oversized(raw, limit)) return { value: '', error: check('x'.repeat(limit + 1)) };
  const value = normalize(raw);
  return { value, error: check(value) };
}

export function singleLine(raw) {
  return text(raw).normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

// 줄 끝 빈칸은 정규식 대신 trimEnd 로 지웁니다. /[ \t]+$/ 같은 정규식은 빈칸이 길게 이어진 입력에서 매우 느려집니다.
export function multiLine(raw) {
  return text(raw)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 전각 숫자(１２３)나 중간 빈칸, 대소문자 차이 때문에 같은 학번이 다르게 저장되지 않게 합니다.
export function normalizeStudentId(raw) {
  return text(raw).normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, '').toUpperCase();
}

export function checkStudentId(studentId) {
  if (!studentId) return '학번을 입력하세요.';
  if (studentId.length > LIMITS.studentId) return `학번은 ${LIMITS.studentId}자까지 쓸 수 있습니다.`;
  if (!STUDENT_ID.test(studentId)) return '학번에는 글자, 숫자, 하이픈(-)만 쓸 수 있습니다.';
  return null;
}

export const normalizeName = singleLine;

export function checkName(name) {
  if (!name) return '이름을 입력하세요.';
  if (name.length > LIMITS.name) return `이름은 ${LIMITS.name}자까지 쓸 수 있습니다.`;
  return null;
}

function checkNote(note) {
  return note.length > LIMITS.note ? `메모는 ${LIMITS.note}자까지 쓸 수 있습니다.` : null;
}

function checkTitle(title) {
  if (!title) return '과제 제목을 입력하세요.';
  if (title.length > LIMITS.title) return `제목은 ${LIMITS.title}자까지 쓸 수 있습니다.`;
  return null;
}

function checkDescription(description) {
  return description.length > LIMITS.description ? `안내문은 ${LIMITS.description}자까지 쓸 수 있습니다.` : null;
}

function checkSiteTitle(title) {
  if (!title) return '사이트 이름을 입력하세요.';
  if (title.length > LIMITS.siteTitle) return `사이트 이름은 ${LIMITS.siteTitle}자까지 쓸 수 있습니다.`;
  return null;
}

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return '수정용 비밀번호를 입력하세요.';
  if (password.length < LIMITS.passwordMin) return `비밀번호는 ${LIMITS.passwordMin}자 이상으로 정하세요.`;
  if (password.length > LIMITS.passwordMax) return `비밀번호는 ${LIMITS.passwordMax}자까지 쓸 수 있습니다.`;
  return null;
}

// { value, error } 를 돌려주는 읽기 함수들. 서버는 항상 이쪽을 씁니다.
export const readStudentId = (raw) => read(raw, LIMITS.studentId, normalizeStudentId, checkStudentId);
export const readName = (raw) => read(raw, LIMITS.name, normalizeName, checkName);
export const readSiteTitle = (raw) => read(raw, LIMITS.siteTitle, singleLine, checkSiteTitle);

function isLocalAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.includes(':')) {
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  return a === 0 || a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

// 제출된 링크를 http(s) 주소로 정리합니다. 저장되는 값은 항상 http:// 또는 https:// 로 시작합니다.
export function normalizeUrl(raw) {
  if (oversized(raw, LIMITS.url)) return { error: URL_TOO_LONG };
  let value = text(raw).replace(INVISIBLE, '').trim();
  if (!value) return { error: '과제 링크를 입력하세요.' };
  if (value.length > LIMITS.url) return { error: URL_TOO_LONG };
  if (/\s/.test(value)) return { error: '링크 주소만 입력하세요. 주소 안에 빈칸이 있습니다.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: BAD_URL };
  }
  if (parsed.protocol === 'file:') {
    return { error: '내 컴퓨터 안의 파일 주소(file://)는 다른 사람이 열 수 없습니다. 인터넷에 올린 뒤 그 링크를 제출하세요.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'http:// 또는 https:// 로 시작하는 링크만 제출할 수 있습니다.' };
  }
  if (parsed.username || parsed.password) {
    return { error: '아이디나 비밀번호가 들어 있는 링크는 제출할 수 없습니다.' };
  }
  if (isLocalAddress(parsed.hostname)) {
    return { error: '내 컴퓨터에서만 열리는 주소입니다. 다른 사람도 열 수 있는 링크를 제출하세요.' };
  }
  if (!parsed.hostname.includes('.') && !parsed.hostname.startsWith('[')) return { error: BAD_URL };
  if (parsed.href.length > LIMITS.url) return { error: URL_TOO_LONG };
  return { url: parsed.href };
}

function result(value, errors) {
  return { value, errors: Object.keys(errors).length ? errors : null };
}

export function validateSubmission(input) {
  const errors = {};

  const studentId = readStudentId(input?.studentId);
  if (studentId.error) errors.studentId = studentId.error;

  const name = readName(input?.name);
  if (name.error) errors.name = name.error;

  const link = normalizeUrl(input?.url);
  if (link.error) errors.url = link.error;

  const note = read(input?.note, LIMITS.note, multiLine, checkNote);
  if (note.error) errors.note = note.error;

  const password = typeof input?.password === 'string' ? input.password : '';
  const passwordError = checkPassword(password);
  if (passwordError) errors.password = passwordError;

  return result({ studentId: studentId.value, name: name.value, url: link.url ?? '', note: note.value, password }, errors);
}

export function validateAssignment(input) {
  const errors = {};

  const title = read(input?.title, LIMITS.title, singleLine, checkTitle);
  if (title.error) errors.title = title.error;

  const description = read(input?.description, LIMITS.description, multiLine, checkDescription);
  if (description.error) errors.description = description.error;

  let dueAt = null;
  const rawDue = input?.dueAt;
  if (rawDue !== null && rawDue !== undefined && rawDue !== '') {
    const date = typeof rawDue === 'string' && rawDue.length <= 40 && HAS_TIME_ZONE.test(rawDue) ? new Date(rawDue) : new Date(NaN);
    const year = date.getUTCFullYear();
    if (Number.isNaN(date.getTime()) || year < 2000 || year > 2100) errors.dueAt = '마감 일시가 올바르지 않습니다.';
    else dueAt = date.toISOString();
  }

  return result(
    { title: title.value, description: description.value, dueAt, allowLate: input?.allowLate !== false, isOpen: input?.isOpen !== false },
    errors,
  );
}

// 서버가 받는 명단 형식: [{ studentId, name }, ...]
export function validateRoster(list) {
  if (!Array.isArray(list)) return { error: '명단 형식이 올바르지 않습니다.' };
  if (list.length > LIMITS.rosterSize) return { error: `명단은 ${LIMITS.rosterSize}명까지 등록할 수 있습니다.` };
  const students = new Map();
  for (const [index, item] of list.entries()) {
    const studentId = readStudentId(item?.studentId);
    const name = readName(item?.name);
    const error = studentId.error || name.error;
    if (error) return { error: `${index + 1}번째 학생: ${error}` };
    students.set(studentId.value, name.value);
  }
  return { students: [...students].map(([studentId, name]) => ({ studentId, name })) };
}

// 붙여 넣은 글을 명단으로 바꿉니다. 한 줄에 한 명, "학번 이름" (빈칸·탭·쉼표로 구분).
export function parseRosterText(source) {
  const students = new Map();
  const problems = [];
  text(source)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const match = /^([^\s,;]+)[\s,;]+(.+)$/.exec(trimmed);
      if (!match) {
        problems.push({ line: index + 1, text: trimmed, reason: '학번과 이름을 함께 적어 주세요.' });
        return;
      }
      const studentId = readStudentId(match[1]);
      const name = readName(match[2].replace(/[,;]/g, ' '));
      if (index === 0 && ['학번', '번호', 'ID'].includes(studentId.value)) return;
      const error = studentId.error || name.error;
      if (error) problems.push({ line: index + 1, text: trimmed.slice(0, 80), reason: error });
      else students.set(studentId.value, name.value);
    });
  return { students: [...students].map(([studentId, name]) => ({ studentId, name })), problems };
}

// 10반 2번이 1반 15번보다 뒤에 오도록 숫자를 숫자로 비교합니다.
export function compareStudentIds(a, b) {
  return a.localeCompare(b, 'ko', { numeric: true });
}

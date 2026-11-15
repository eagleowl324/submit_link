// 서비스의 핵심 로직: 주소별 처리, 인증, 요청 제한.
//
// 이 파일은 특정 실행 환경에 묶이지 않습니다. 저장소(store)와 화면(pages), 정적 파일(assets)을 밖에서 받아서
// 직접 띄우는 Node.js 서버(src/node.js)와 Vercel(src/vercel.js) 양쪽에서 같은 코드로 동작합니다.
// 요청과 응답은 Node.js 의 req/res 모양을 따르고, Vercel 쪽은 같은 모양의 얇은 객체를 만들어 넘깁니다(src/fetch.js).
//
// 저장소는 바로 답하는 것(파일 SQLite)일 수도, 네트워크 너머에 있어 기다려야 하는 것(Vercel 의 데이터베이스)일 수도
// 있습니다. 그래서 store 와 limiter 를 부르는 곳은 모두 await 합니다.

import { Buffer } from 'node:buffer';

import {
  RateLimiter,
  createHasher,
  generateAdminPassword,
  newToken,
  randomSlug,
  sameSecret,
  sha256,
} from './security.js';
import {
  LIMITS,
  checkFile,
  nameKey,
  normalizeFileName,
  readName,
  readSiteTitle,
  readStudentId,
  singleLine,
  validateAssignment,
  validateRoster,
  validateSubmission,
} from '../shared/rules.js';

const DEFAULT_TITLE = '과제 링크 제출함';
const SESSION_COOKIE = 'admin_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const BODY_LIMIT = 32 * 1024;
const ROSTER_BODY_LIMIT = 1024 * 1024;

// 한 IP에서 1분 동안 받는 제출·조회 요청 수.
// 학교에서는 수백 명이 같은 IP로 접속하므로 넉넉하게 둡니다. 비밀번호 추측은 아래 한도가 따로 막습니다.
const POSTS_PER_MINUTE = 600;
// 학번 하나(또는 관리자 로그인)에 대해 10분 동안 허용하는 비밀번호 시도 횟수
const PASSWORD_ATTEMPTS = 8;
const LOGIN_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

// 누군가 제출을 끝없이 쌓아 저장 공간과 관리 화면을 망가뜨리는 것을 막는 한도
const MAX_SUBMISSIONS_PER_ASSIGNMENT = 5000;
const MAX_LINK_CHANGES = 30;

// 첨부 파일. 파일은 조각으로 나눠 올리고 조각째로 저장합니다(src/db.js 의 file_chunks).
// 요청 하나에 실을 수 있는 크기가 4.5MB 로 제한된 실행 환경(Vercel)에서도 그보다 큰 파일을 받기 위해서입니다.
const FILE_CHUNK_BYTES = 512 * 1024;
// 파일 하나의 크기와, 받아 둘 수 있는 파일 전체의 크기. MAX_FILE_MB, FILE_STORAGE_MB 환경 변수로 바꿉니다.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_STORAGE_BYTES = 1024 * 1024 * 1024;
// 다 올리고도 이 시간 안에 제출하지 않은 파일은 지웁니다.
const UPLOAD_LIFETIME_MS = 60 * 60 * 1000;
// 한 IP에서 10분 동안 올리기 시작할 수 있는 파일 수 (한 교실이 같은 IP를 씁니다)
const UPLOAD_STARTS = 120;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const ALREADY_SUBMITTED =
  '이 학번으로 이미 제출된 링크가 있습니다. 처음 제출할 때 정한 비밀번호를 입력해야 고칠 수 있습니다. 비밀번호가 기억나지 않으면 선생님께 말씀드리세요.';
const ALREADY_SUBMITTED_BY_NAME =
  '이 이름으로 이미 제출된 링크가 있습니다. 본인이 낸 것이라면 처음 제출할 때 정한 비밀번호를 입력해야 고칠 수 있습니다(기억나지 않으면 선생님께 말씀드리세요). 이름이 같은 다른 사람이 먼저 냈다면 학번을 함께 적거나 이름 뒤에 숫자를 붙여 구분해 주세요.';

// 한 과제 안에서 제출을 구분하는 값. submissions.student_id 에 이 값이 들어갑니다.
// 학번을 적었으면 학번이고, 학번 없이 낸 제출(학번을 꼭 받지 않는 과제)은 "~이름" 입니다. 이름은 띄어쓰기와 대소문자를 무시합니다.
// 학번은 글자나 숫자로 시작해야 하므로 "~" 로 시작하는 값과 겹치지 않습니다. 이름을 학번처럼 적어 남의 자리를 차지할 수도 없습니다.
const NAME_KEY_MARK = '~';
const submissionKey = (studentId, name) => studentId || NAME_KEY_MARK + nameKey(name);
const isNameKey = (key) => key.startsWith(NAME_KEY_MARK);

export class ConfigError extends Error {}

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// 환경 변수에서 파일 한도를 읽습니다. createApp 의 limits 로 넘깁니다. 값이 없거나 잘못됐으면 기본값을 씁니다.
export function fileLimitsFromEnv(env) {
  const megabytes = (value) => {
    const number = Number(value);
    return value !== undefined && value !== '' && Number.isFinite(number) && number > 0 ? Math.floor(number * 1024 * 1024) : undefined;
  };
  return { maxFileBytes: megabytes(env.MAX_FILE_MB), fileStorageBytes: megabytes(env.FILE_STORAGE_MB) };
}

function invalid(fields) {
  return new HttpError(400, 'invalid', '입력한 내용을 다시 확인해 주세요.', { fields });
}

function tooMany(retryAfter, lead) {
  const wait = retryAfter < 60 ? `${retryAfter}초` : `${Math.ceil(retryAfter / 60)}분`;
  return new HttpError(429, 'too_many_attempts', `${lead} ${wait} 뒤에 다시 시도하세요.`, { retryAfter });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function fillTemplate(html, values) {
  return html.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in values ? escapeHtml(values[key]) : whole));
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index !== -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

// JSON 이 아닌 본문(파일 조각)을 읽습니다.
async function readBytes(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'too_large', '보낸 내용이 너무 큽니다.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large', '보낸 내용이 너무 큽니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit) {
  if (contentType(req) !== 'application/json') throw new HttpError(415, 'unsupported_media_type', '요청 형식이 올바르지 않습니다.');
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'too_large', '보낸 내용이 너무 큽니다.');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large', '보낸 내용이 너무 큽니다.');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', '요청 내용을 읽을 수 없습니다.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad_json', '요청 내용을 읽을 수 없습니다.');
  }
  return body;
}

// 주소가 IPv4 면 4, IPv6 면 6, 둘 다 아니면 0. (node:net 없이도 돌도록 직접 확인합니다.)
function ipFamily(ip) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255) ? 4 : 0;
  if (!ip.includes(':') || !/^[0-9a-f:.]+$/.test(ip)) return 0;
  const halves = ip.split('::');
  if (halves.length > 2) return 0;
  const groups = halves.flatMap((half) => (half ? half.split(':') : []));
  let count = 0;
  for (const [index, group] of groups.entries()) {
    if (/^[0-9a-f]{1,4}$/.test(group)) count += 1;
    else if (index === groups.length - 1 && ipFamily(group) === 4) count += 2;
    else return 0;
  }
  if (halves.length === 2) return count < 8 ? 6 : 0;
  return count === 8 ? 6 : 0;
}

// 요청 제한에 쓰는 접속자 구분값.
// 프록시가 넣어 주는 값에는 포트가 붙어 있기도 해서(203.0.113.7:4000, [2001:db8::1]:4000) 떼어 내고,
// IP 주소가 아닌 값은 모두 한 묶음('unknown')으로 셉니다.
// IPv6는 한 사람이 주소를 얼마든지 바꿀 수 있어서 앞쪽 /64 단위로 묶습니다.
export function rateKey(address) {
  let ip = String(address ?? '').trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  ip = ip.split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1];

  const family = ipFamily(ip);
  if (family === 4) return ip;
  if (family !== 6) return 'unknown';
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// X-Forwarded-For 는 보내는 쪽이 마음대로 쓸 수 있는 값입니다. 그래서 바로 앞에서 접속한 상대가
// 같은 컴퓨터나 사설망(프록시가 있을 만한 곳)일 때만 그 값을 믿습니다.
export function isProxyPeer(address) {
  const ip = rateKey(address);
  if (ip === 'unknown') return false;
  if (ip.includes(':')) return ip === '0:0:0:0::/64' || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  );
}

function contentType(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

function assignmentState(assignment, at) {
  if (!assignment.is_open) return 'closed';
  if (assignment.due_at && at.toISOString() > assignment.due_at) return assignment.allow_late ? 'late' : 'closed';
  return 'open';
}

function isLate(assignment, submittedAt) {
  return Boolean(assignment.due_at) && submittedAt > assignment.due_at;
}

function publicAssignment(assignment, at) {
  return {
    slug: assignment.slug,
    title: assignment.title,
    description: assignment.description,
    dueAt: assignment.due_at,
    allowLate: Boolean(assignment.allow_late),
    requireStudentId: Boolean(assignment.require_student_id),
    allowFiles: Boolean(assignment.allow_files),
    state: assignmentState(assignment, at),
  };
}

function adminAssignment(assignment, at) {
  return { id: assignment.id, isOpen: Boolean(assignment.is_open), createdAt: assignment.created_at, ...publicAssignment(assignment, at) };
}

// 관리 화면에는 파일을 내려받는 데 필요한 번호와 조각 수도 줍니다.
function adminSubmission(row, assignment, rosterName = row.roster_name ?? null) {
  return {
    id: row.id,
    ...publicSubmission(row, assignment),
    file: row.file_id ? { id: row.file_id, name: row.file_name, size: row.file_size, chunks: row.file_chunks } : null,
    hasPassword: row.password_hash !== '',
    rosterName,
  };
}

function publicSubmission(row, assignment) {
  return {
    // 학번 없이 낸 제출은 학번 자리가 비어 있습니다.
    studentId: isNameKey(row.student_id) ? '' : row.student_id,
    name: row.student_name,
    url: row.url,
    file: row.file_id ? { name: row.file_name, size: row.file_size } : null,
    note: row.note,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isLate: isLate(assignment, row.updated_at),
  };
}

// 학생 화면의 과제 순서: 받는 중(마감 임박 순) → 지각 접수 중 → 마감
function compareForStudents(a, b) {
  const rank = { open: 0, late: 1, closed: 2 };
  if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
  if (a.state === 'open' && a.dueAt !== b.dueAt) {
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt < b.dueAt ? -1 : 1;
  }
  return 0;
}

// options:
//   store            저장소 (src/db.js 의 Store)
//   pages            { student, admin } HTML 틀
//   assets           정적 파일 Map (주소 → { body, type, etag }). 정적 파일을 다른 곳에서 내보내는 환경에서는 비워 둡니다.
//   adminPassword    정해 두면 그 값이 관리자 비밀번호입니다.
//   setup            관리자 비밀번호를 정해 두지 않았을 때의 첫 설정 방법.
//                    'console' 은 무작위로 만들어 generatedAdminPassword 로 돌려주고(실행 창에 보여 줌),
//                    'web' 은 관리 화면에 처음 들어온 사람이 정하게 합니다.
//   trustProxy, clientIp, now, limits, hasher, limiter   아래 기본값 참고
export async function createApp(options = {}) {
  const {
    store,
    pages,
    assets = new Map(),
    adminPassword = '',
    setup = 'console',
    trustProxy = 0,
    clientIp: clientIpOverride = null,
    now = () => new Date(),
    limits = {},
    hasher = createHasher(),
    limiter = new RateLimiter(() => now().getTime()),
  } = options;
  const maxSubmissions = limits.maxSubmissions ?? MAX_SUBMISSIONS_PER_ASSIGNMENT;
  const maxLinkChanges = limits.maxLinkChanges ?? MAX_LINK_CHANGES;
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES;
  const fileStorageBytes = limits.fileStorageBytes ?? FILE_STORAGE_BYTES;

  if (adminPassword && adminPassword.length < LIMITS.adminPasswordMin) {
    throw new ConfigError(`ADMIN_PASSWORD 는 ${LIMITS.adminPasswordMin}자 이상이어야 합니다.`);
  }

  await store.ready();

  // 비밀번호를 정해 주지 않았다면 처음 한 번 무작위로 만들어 알려 줍니다. ('web' 방식에서는 관리 화면에서 정합니다.)
  let generatedAdminPassword = null;
  if (setup === 'console' && !adminPassword && !(await store.getSetting('admin_password_hash'))) {
    generatedAdminPassword = generateAdminPassword();
    await store.setSetting('admin_password_hash', await hasher.hash(generatedAdminPassword));
  }

  // 관리자 비밀번호를 정하는 방식이나 값이 바뀌었으면(ADMIN_PASSWORD 를 바꾸거나 없앴으면) 예전 로그인을 모두 끊습니다.
  // 비밀번호를 바꿨는데 예전에 로그인해 둔 기기가 계속 들어올 수 있으면 안 되기 때문입니다.
  const authMarker = await store.getSetting('admin_auth_marker');
  const sameAuth = adminPassword ? Boolean(authMarker) && (await hasher.verify(adminPassword, authMarker)) : authMarker === 'stored';
  if (!sameAuth) {
    await store.deleteAllSessions();
    await store.setSetting('admin_auth_marker', adminPassword ? await hasher.hash(adminPassword) : 'stored');
  }

  // 관리자 비밀번호가 아직 없어서 관리 화면에서 처음 정해야 하는 상태인가
  const needsSetup = async () => setup === 'web' && !adminPassword && !(await store.getSetting('admin_password_hash'));

  const siteTitle = async () => (await store.getSetting('site_title')) || DEFAULT_TITLE;
  const rosterOnly = async () => (await store.getSetting('roster_only')) === '1';

  // ── 응답 ────────────────────────────────────────────────────────────────

  function send(res, status, body, headers = {}) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': buffer.length, ...headers });
    res.end(res.req.method === 'HEAD' ? undefined : buffer);
  }

  function sendJson(res, status, data, headers = {}) {
    send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  }

  function sendHtml(res, status, html) {
    send(res, status, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    });
  }

  function sendText(res, status, text, headers = {}) {
    send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  }

  // ── 요청 정보 ────────────────────────────────────────────────────────────

  // 프록시 뒤에서는 TRUST_PROXY 만큼 떨어진 X-Forwarded-For 항목이 실제 접속자입니다.
  function clientIp(req) {
    if (clientIpOverride) return clientIpOverride(req);
    const peer = req.socket.remoteAddress || '';
    if (trustProxy > 0 && isProxyPeer(peer)) {
      const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (forwarded.length) return rateKey(forwarded[Math.max(0, forwarded.length - trustProxy)]);
    }
    return rateKey(peer);
  }

  function isHttps(req) {
    if (req.socket.encrypted) return true;
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  }

  function sessionCookie(req, token, maxAge) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }

  async function currentSession(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const tokenHash = sha256(token);
    return (await store.findSession(tokenHash, now().toISOString())) ? { tokenHash } : null;
  }

  function admin(handler) {
    return async (context) => {
      const session = await currentSession(context.req);
      if (!session) throw new HttpError(401, 'unauthorized', '로그인이 필요합니다.');
      return handler({ ...context, session });
    };
  }

  async function throttlePosts(req) {
    const gate = await limiter.take(`post:${clientIp(req)}`, POSTS_PER_MINUTE, 60 * 1000);
    if (!gate.allowed) throw tooMany(gate.retryAfter, '요청이 너무 많습니다.');
  }

  // 시도 횟수를 먼저 세고 나서 확인합니다. 동시에 여러 번 찔러 보는 것을 막기 위해서입니다.
  // submitter 는 제출을 구분하는 값(submissionKey)입니다.
  async function requireStudentPassword(assignmentId, submitter, password, storedHash, wrongMessage) {
    const key = `password:${assignmentId}:${submitter}`;
    const gate = await limiter.take(key, PASSWORD_ATTEMPTS, ATTEMPT_WINDOW_MS);
    if (!gate.allowed) {
      throw tooMany(gate.retryAfter, `비밀번호를 여러 번 틀려서 이 ${isNameKey(submitter) ? '이름' : '학번'}의 제출이 잠시 막혔습니다.`);
    }
    if (!(await hasher.verify(password, storedHash))) {
      throw new HttpError(403, 'wrong_password', wrongMessage, { fields: { password: wrongMessage } });
    }
    await limiter.reset(key);
  }

  async function isAdminPassword(password) {
    if (!password || password.length > LIMITS.adminPasswordMax) return false;
    if (adminPassword) return sameSecret(password, adminPassword);
    const stored = await store.getSetting('admin_password_hash');
    return stored ? hasher.verify(password, stored) : false;
  }

  async function requireAdminPassword(req, password, error) {
    const key = `login:${clientIp(req)}`;
    const gate = await limiter.take(key, LOGIN_ATTEMPTS, ATTEMPT_WINDOW_MS);
    if (!gate.allowed) throw tooMany(gate.retryAfter, '비밀번호를 여러 번 틀렸습니다.');
    if (!(await isAdminPassword(password))) throw error;
    await limiter.reset(key);
  }

  async function findAssignmentBySlug(slug) {
    const assignment = await store.getAssignmentBySlug(slug);
    if (!assignment) throw new HttpError(404, 'not_found', '과제를 찾을 수 없습니다.');
    return assignment;
  }

  async function isNameInRoster(name) {
    const key = nameKey(name);
    return (await store.listRoster()).some((student) => nameKey(student.name) === key);
  }

  async function findAssignment(id) {
    const assignment = await store.getAssignment(Number(id));
    if (!assignment) throw new HttpError(404, 'not_found', '과제를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.');
    return assignment;
  }

  // ── 화면과 정적 파일 ─────────────────────────────────────────────────────

  async function pageStudent({ res, params }) {
    const title = await siteTitle();
    if (!params[0]) {
      sendHtml(res, 200, fillTemplate(pages.student, { title, description: '과제 링크를 제출하는 곳입니다.' }));
      return;
    }
    const assignment = await store.getAssignmentBySlug(params[0]);
    if (!assignment) {
      sendHtml(res, 404, fillTemplate(pages.student, { title, description: '과제를 찾을 수 없습니다.' }));
      return;
    }
    const summary = singleLine(assignment.description).slice(0, 120) || '과제 링크를 제출하는 곳입니다.';
    sendHtml(res, 200, fillTemplate(pages.student, { title: `${assignment.title} · ${title}`, description: summary }));
  }

  async function pageAdmin({ res }) {
    sendHtml(res, 200, fillTemplate(pages.admin, { title: `관리 · ${await siteTitle()}` }));
  }

  function serveAsset({ req, res, params }) {
    const asset = assets.get(params[0]);
    if (!asset) throw new HttpError(404, 'not_found', '찾을 수 없는 주소입니다.');
    const headers = { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', ETag: asset.etag };
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
      res.end();
      return;
    }
    send(res, 200, asset.body, headers);
  }

  // ── 학생용 API ───────────────────────────────────────────────────────────

  async function apiSite({ res }) {
    const at = now();
    const assignments = (await store.listAssignments()).map((assignment) => publicAssignment(assignment, at)).sort(compareForStudents);
    sendJson(res, 200, { title: await siteTitle(), maxFileBytes, assignments });
  }

  // ── 파일 올리기 ──
  // 1) 올리기 시작: 이름과 크기를 알리고 번호와 토큰을 받습니다.
  // 2) 조각 보내기: 정해진 크기로 나눈 조각을 차례로(또는 동시에) 보냅니다.
  // 3) 제출: 제출 내용에 번호와 토큰을 실어 보내면 그 파일이 제출에 붙습니다. (apiSubmit)
  // 제출하지 않은 파일은 한 시간 뒤에 지워지고, 올린 쪽이 먼저 취소할 수도 있습니다.

  const UPLOAD_NOT_FOUND = '올리던 파일을 찾을 수 없습니다. 파일을 다시 선택해 주세요.';

  // 아직 제출에 붙지 않은 파일을 토큰으로 확인하고 돌려줍니다.
  async function findUpload(id, token) {
    const file = Number.isSafeInteger(id) && typeof token === 'string' && token ? await store.getFile(id) : null;
    if (!file || file.submission_id !== null || !sameSecret(sha256(token), file.token_hash)) return null;
    return file;
  }

  async function requireUpload(req, id) {
    const file = await findUpload(Number(id), String(req.headers['x-upload-token'] || ''));
    if (!file) throw new HttpError(404, 'upload_not_found', UPLOAD_NOT_FOUND);
    return file;
  }

  async function apiStartUpload({ req, res, params }) {
    await throttlePosts(req);
    const assignment = await findAssignmentBySlug(params[0]);
    const body = await readJson(req, BODY_LIMIT);
    if (!assignment.allow_files) throw new HttpError(403, 'files_off', '이 과제는 파일을 받지 않습니다.');
    if (assignmentState(assignment, now()) === 'closed') throw new HttpError(403, 'closed', '이 과제는 제출이 마감되었습니다.');

    const name = normalizeFileName(body.name);
    const error = checkFile(name, body.size, maxFileBytes);
    if (error) throw invalid({ file: error });

    const gate = await limiter.take(`upload:${clientIp(req)}`, UPLOAD_STARTS, ATTEMPT_WINDOW_MS);
    if (!gate.allowed) throw tooMany(gate.retryAfter, '파일을 너무 많이 올렸습니다.');

    const token = newToken();
    const chunks = Math.ceil(body.size / FILE_CHUNK_BYTES);
    const uploadId = await store.createUpload({
      assignmentId: assignment.id,
      name,
      size: body.size,
      chunks,
      tokenHash: sha256(token),
      createdAt: now().toISOString(),
      storageLimit: fileStorageBytes,
    });
    if (uploadId === null) {
      throw new HttpError(403, 'storage_full', '파일을 저장할 공간이 부족해서 올릴 수 없습니다. 선생님께 알려 주세요.');
    }
    sendJson(res, 201, { uploadId, token, chunkSize: FILE_CHUNK_BYTES, chunks });
  }

  // 조각은 토큰이 있어야 보낼 수 있고 개수와 크기가 처음 알린 대로여야 하므로, 접속자별 요청 수는 따로 세지 않습니다.
  async function apiPutChunk({ req, res, params }) {
    const file = await requireUpload(req, params[0]);
    const seq = Number(params[1]);
    if (seq >= file.chunks) throw new HttpError(400, 'bad_chunk', '파일 조각의 순서가 맞지 않습니다.');
    const expected = Math.min(FILE_CHUNK_BYTES, file.size - seq * FILE_CHUNK_BYTES);
    const data = await readBytes(req, expected);
    if (data.length !== expected) throw new HttpError(400, 'bad_chunk', '파일 조각의 크기가 맞지 않습니다.');
    await store.putChunk(file.id, seq, data);
    sendJson(res, 200, { ok: true });
  }

  async function apiCancelUpload({ req, res, params }) {
    const file = await requireUpload(req, params[0]);
    await store.discardUpload(file.id);
    sendJson(res, 200, { ok: true });
  }

  async function apiSubmit({ req, res, params }) {
    await throttlePosts(req);
    await findAssignmentBySlug(params[0]);
    const body = await readJson(req, BODY_LIMIT);

    // 본문을 받는 동안 선생님이 과제를 닫거나 지우거나 설정을 바꿨을 수 있으므로, 과제는 본문을 다 받은 뒤에 읽습니다.
    // 마감과 지각도 이 시각으로 판단합니다.
    const assignment = await findAssignmentBySlug(params[0]);
    const allowFiles = Boolean(assignment.allow_files);

    // 첨부 파일: 보내지 않으면 지금 있는 그대로, null 이면 빼고, { uploadId, token } 이면 방금 올린 파일로 바꿉니다.
    let file = { action: 'keep' };
    if (body.file === null) file = { action: 'remove' };
    else if (body.file !== undefined) {
      if (!allowFiles) throw invalid({ file: '이 과제는 파일을 받지 않습니다.' });
      const upload = await findUpload(body.file?.uploadId, body.file?.token);
      if (!upload || upload.assignment_id !== assignment.id) throw invalid({ file: UPLOAD_NOT_FOUND });
      file = { action: 'attach', fileId: upload.id };
    }

    // 파일을 받는 과제에서는 링크를 비워 둘 수 있습니다. 링크도 파일도 없는 제출은 아래에서 거절합니다.
    const { value, errors } = validateSubmission(body, { requireStudentId: Boolean(assignment.require_student_id), urlOptional: true });
    if (errors) throw invalid(errors);
    const nothingToSubmit = () => invalid({ url: allowFiles ? '과제 링크를 입력하거나 파일을 첨부하세요.' : '과제 링크를 입력하세요.' });
    if (!value.url && file.action === 'remove') throw nothingToSubmit();

    const at = now();
    if (assignmentState(assignment, at) === 'closed') {
      throw new HttpError(403, 'closed', '이 과제는 제출이 마감되었습니다.');
    }

    // 학번을 적었으면 학번으로, 비워 두었으면 이름으로 같은 사람의 제출을 찾습니다.
    const submitter = submissionKey(value.studentId, value.name);
    const existing = await store.getSubmission(assignment.id, submitter);
    if (!value.url && file.action === 'keep' && !(existing && existing.file_id)) throw nothingToSubmit();
    // "명단에 있는 학번만 받기"를 켜 두면 학번 오타나 장난 제출을 처음부터 막습니다. 학번 없이 내는 제출은 이름이 명단에 있어야 합니다.
    if (!existing && (await rosterOnly()) && (await store.rosterCount()) > 0) {
      if (value.studentId) {
        if (!(await store.isInRoster(value.studentId))) {
          throw invalid({ studentId: '명단에 없는 학번입니다. 학번을 다시 확인하고, 맞게 썼다면 선생님께 말씀드리세요.' });
        }
      } else if (!(await isNameInRoster(value.name))) {
        throw invalid({ name: '명단에 없는 이름입니다. 이름을 다시 확인하고, 맞게 썼다면 선생님께 말씀드리세요.' });
      }
    }
    let passwordHash;
    if (existing && existing.password_hash) {
      const wrongMessage = value.studentId ? ALREADY_SUBMITTED : ALREADY_SUBMITTED_BY_NAME;
      await requireStudentPassword(assignment.id, submitter, value.password, existing.password_hash, wrongMessage);
      passwordHash = existing.password_hash;
    } else {
      passwordHash = await hasher.hash(value.password);
    }

    const saved = await store.saveSubmission({
      assignmentId: assignment.id,
      studentId: submitter,
      name: value.name,
      url: value.url,
      note: value.note,
      passwordHash,
      expectedHash: existing ? existing.password_hash : null,
      at: at.toISOString(),
      maxSubmissions,
      maxLinkChanges,
      file,
    });
    if (saved.status === 'gone') throw new HttpError(404, 'not_found', '과제를 찾을 수 없습니다.');
    if (saved.status === 'file_gone') throw invalid({ file: UPLOAD_NOT_FOUND });
    if (saved.status === 'empty') throw nothingToSubmit();
    if (saved.status === 'conflict') {
      throw new HttpError(409, 'conflict', '같은 학번으로 방금 다른 제출이 들어왔습니다. 다시 한 번 제출해 주세요.');
    }
    if (saved.status === 'full') {
      throw new HttpError(403, 'full', '이 과제는 받을 수 있는 제출 수를 넘었습니다. 선생님께 알려 주세요.');
    }
    if (saved.status === 'too_many_changes') {
      const message = `링크와 파일은 ${maxLinkChanges}번까지 바꿀 수 있습니다. 더 바꿔야 하면 선생님께 말씀드리세요.`;
      throw invalid(value.url ? { url: message } : { file: message });
    }
    sendJson(res, saved.status === 'created' ? 201 : 200, {
      status: saved.status,
      submission: publicSubmission(saved.row, assignment),
    });
  }

  async function apiLookup({ req, res, params }) {
    await throttlePosts(req);
    const assignment = await findAssignmentBySlug(params[0]);
    const body = await readJson(req, BODY_LIMIT);

    // 학번으로 찾고, 학번을 꼭 받지 않는 과제에서는 학번 없이 이름으로 낸 제출도 찾습니다.
    const byNameToo = !assignment.require_student_id;
    const submitters = [];
    const studentId = readStudentId(body.studentId);
    if (!studentId.error) submitters.push(studentId.value);
    if (byNameToo) {
      const name = readName(body.name);
      if (!name.error) submitters.push(submissionKey('', name.value));
    }

    const fields = {};
    if (!submitters.length) fields.studentId = byNameToo ? '학번이나 이름을 입력하세요.' : studentId.error;
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) fields.password = '비밀번호를 입력하세요.';
    else if (password.length > LIMITS.passwordMax) fields.password = '비밀번호가 맞지 않습니다.';
    if (Object.keys(fields).length) throw invalid(fields);

    let existing = null;
    for (const submitter of submitters) {
      existing = await store.getSubmission(assignment.id, submitter);
      if (existing) break;
    }
    if (!existing) {
      throw new HttpError(404, 'no_submission', byNameToo ? '이 학번이나 이름으로 제출된 링크가 없습니다.' : '이 학번으로 제출된 링크가 없습니다.');
    }
    if (!existing.password_hash) {
      throw new HttpError(403, 'password_reset', '선생님이 비밀번호를 초기화했습니다. 링크를 다시 제출하면서 새 비밀번호를 정하세요.');
    }
    await requireStudentPassword(assignment.id, existing.student_id, password, existing.password_hash, '비밀번호가 맞지 않습니다.');
    sendJson(res, 200, { submission: publicSubmission(existing, assignment) });
  }

  // ── 관리자 API ───────────────────────────────────────────────────────────

  async function apiLogin({ req, res }) {
    const body = await readJson(req, BODY_LIMIT);
    const password = typeof body.password === 'string' ? body.password : '';
    await requireAdminPassword(req, password, new HttpError(401, 'wrong_password', '비밀번호가 맞지 않습니다.'));
    await startSession(req, res);
  }

  async function startSession(req, res) {
    const at = now();
    await store.pruneSessions(at.toISOString());
    const token = newToken();
    await store.createSession(sha256(token), at.toISOString(), new Date(at.getTime() + SESSION_SECONDS * 1000).toISOString());
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_SECONDS) });
  }

  // 관리자 비밀번호를 처음 정합니다. 아직 아무도 정하지 않았을 때 한 번만 됩니다('web' 방식).
  async function apiSetup({ req, res }) {
    const alreadySet = new HttpError(409, 'already_set', '관리자 비밀번호가 이미 정해져 있습니다. 로그인해 주세요.');
    if (!(await needsSetup())) throw alreadySet;
    const body = await readJson(req, BODY_LIMIT);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < LIMITS.adminPasswordMin) {
      throw invalid({ password: `비밀번호는 ${LIMITS.adminPasswordMin}자 이상으로 정하세요.` });
    }
    if (password.length > LIMITS.adminPasswordMax) {
      throw invalid({ password: `비밀번호는 ${LIMITS.adminPasswordMax}자까지 쓸 수 있습니다.` });
    }
    const hash = await hasher.hash(password);
    // "아직 없을 때만 저장"을 저장소가 한 번에 처리합니다. 여러 사람이 동시에 정하려 해도 먼저 저장한 한 사람만 됩니다.
    if (!(await store.claimSetting('admin_password_hash', hash))) throw alreadySet;
    await startSession(req, res);
  }

  async function apiLogout({ req, res }) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await store.deleteSession(sha256(token));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  async function apiLogoutOthers({ res, session }) {
    await store.deleteOtherSessions(session.tokenHash);
    sendJson(res, 200, { ok: true });
  }

  async function apiSession({ req, res }) {
    // setup 은 로그인 화면이 알맞은 안내문을 고르는 데 씁니다.
    sendJson(res, 200, { authenticated: Boolean(await currentSession(req)), needsSetup: await needsSetup(), setup });
  }

  async function apiOverview({ res }) {
    const at = now();
    const stats = new Map((await store.submissionStats()).map((row) => [row.assignment_id, row]));
    sendJson(res, 200, {
      title: await siteTitle(),
      rosterCount: await store.rosterCount(),
      passwordFromEnv: Boolean(adminPassword),
      files: { usedBytes: await store.fileBytes(), limitBytes: fileStorageBytes, maxFileBytes },
      assignments: (await store.listAssignments()).map((assignment) => ({
        ...adminAssignment(assignment, at),
        submissionCount: stats.get(assignment.id)?.total ?? 0,
        lateCount: stats.get(assignment.id)?.late ?? 0,
      })),
    });
  }

  async function apiCreateAssignment({ req, res }) {
    const { value, errors } = validateAssignment(await readJson(req, BODY_LIMIT));
    if (errors) throw invalid(errors);
    let slug = randomSlug();
    while (await store.getAssignmentBySlug(slug)) slug = randomSlug();
    const at = now();
    const assignment = await store.createAssignment({ slug, ...value, createdAt: at.toISOString() });
    sendJson(res, 201, { assignment: adminAssignment(assignment, at) });
  }

  async function apiUpdateAssignment({ req, res, params }) {
    const existing = await findAssignment(params[0]);
    const body = await readJson(req, BODY_LIMIT);
    const { value, errors } = validateAssignment(body);
    if (errors) throw invalid(errors);
    // 이 항목들을 보내지 않는 요청(그 기능이 생기기 전에 열어 둔 관리 화면)은 지금 설정을 그대로 둡니다.
    if (typeof body.requireStudentId !== 'boolean') value.requireStudentId = Boolean(existing.require_student_id);
    if (typeof body.allowFiles !== 'boolean') value.allowFiles = Boolean(existing.allow_files);
    sendJson(res, 200, { assignment: adminAssignment(await store.updateAssignment(existing.id, value), now()) });
  }

  async function apiDeleteAssignment({ res, params }) {
    const assignment = await findAssignment(params[0]);
    await store.deleteAssignment(assignment.id);
    sendJson(res, 200, { ok: true });
  }

  async function apiListSubmissions({ res, params }) {
    const assignment = await findAssignment(params[0]);
    const rosterCount = await store.rosterCount();
    const submissions = await store.listSubmissions(assignment.id);
    let missing = rosterCount ? await store.missingStudents(assignment.id) : [];

    // 학번 없이 낸 제출은 이름으로 명단과 맞춰 봅니다.
    // 명단에 그 이름이 한 명뿐이면 그 학생이 낸 것으로 보고 미제출자에서 뺍니다. 이름이 같은 학생이 여럿이면 누구인지 알 수 없어 그대로 둡니다.
    const rosterNames = new Map();
    if (rosterCount && submissions.some((row) => isNameKey(row.student_id))) {
      const sameName = new Map();
      for (const student of await store.listRoster()) {
        const key = NAME_KEY_MARK + nameKey(student.name);
        sameName.set(key, [...(sameName.get(key) ?? []), student]);
      }
      const submitted = new Set();
      for (const row of submissions) {
        const students = sameName.get(row.student_id);
        if (!students) continue;
        rosterNames.set(row.id, students[0].name);
        if (students.length === 1) submitted.add(students[0].student_id);
      }
      missing = missing.filter((student) => !submitted.has(student.student_id));
    }

    sendJson(res, 200, {
      assignment: adminAssignment(assignment, now()),
      rosterCount,
      submissions: submissions.map((row) => adminSubmission(row, assignment, rosterNames.get(row.id) ?? row.roster_name ?? null)),
      missing: missing.map((row) => ({ studentId: row.student_id, name: row.name })),
    });
  }

  // 제출 한 건과 이전 링크 기록. 기록은 목록에 싣지 않고 "자세히"를 열 때만 받아 갑니다.
  async function apiGetSubmission({ res, params }) {
    const row = await store.getSubmissionDetail(Number(params[0]));
    const assignment = row ? await store.getAssignment(row.assignment_id) : null;
    if (!row || !assignment) throw new HttpError(404, 'not_found', '제출 내역을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.');
    const history = await store.listHistory(row.id);
    sendJson(res, 200, {
      submission: {
        ...adminSubmission(row, assignment),
        history: history.map((entry) => ({
          name: entry.student_name,
          url: entry.url,
          fileName: entry.file_name,
          note: entry.note,
          submittedAt: entry.submitted_at,
          isLate: isLate(assignment, entry.submitted_at),
        })),
      },
    });
  }

  // 첨부 파일의 조각 하나. 관리 화면이 조각을 모두 받아 파일로 합칩니다.
  // 학생이 올린 내용이 이 사이트의 화면으로 열리지 않도록, 항상 내려받는 내용으로만 보냅니다.
  async function apiGetFileChunk({ res, params }) {
    const data = await store.getChunk(Number(params[0]), Number(params[1]));
    if (!data) throw new HttpError(404, 'not_found', '파일을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.');
    send(res, 200, data, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'Cache-Control': 'no-store' });
  }

  async function apiDeleteSubmission({ res, params }) {
    const submission = await store.getSubmissionById(Number(params[0]));
    if (!submission || !(await store.deleteSubmission(submission.id))) {
      throw new HttpError(404, 'not_found', '제출 내역을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.');
    }
    // 지운 제출에 걸려 있던 비밀번호 잠금도 풀어서, 같은 학번으로 바로 다시 낼 수 있게 합니다.
    await limiter.reset(`password:${submission.assignment_id}:${submission.student_id}`);
    sendJson(res, 200, { ok: true });
  }

  async function apiResetSubmissionPassword({ res, params }) {
    const submission = await store.getSubmissionById(Number(params[0]));
    if (!submission) throw new HttpError(404, 'not_found', '제출 내역을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.');
    await store.clearSubmissionPassword(submission.id);
    await limiter.reset(`password:${submission.assignment_id}:${submission.student_id}`);
    sendJson(res, 200, { ok: true });
  }

  async function apiGetRoster({ res }) {
    const students = await store.listRoster();
    sendJson(res, 200, {
      rosterOnly: await rosterOnly(),
      students: students.map((row) => ({ studentId: row.student_id, name: row.name })),
    });
  }

  async function apiPutRoster({ req, res }) {
    const body = await readJson(req, ROSTER_BODY_LIMIT);
    const { students, error } = validateRoster(body.students);
    if (error) throw new HttpError(400, 'invalid', error);
    await store.replaceRoster(students);
    if (typeof body.rosterOnly === 'boolean') await store.setSetting('roster_only', body.rosterOnly ? '1' : '0');
    sendJson(res, 200, { count: students.length, rosterOnly: await rosterOnly() });
  }

  async function apiPutSettings({ req, res }) {
    const body = await readJson(req, BODY_LIMIT);
    const { value: title, error } = readSiteTitle(body.title);
    if (error) throw invalid({ title: error });
    await store.setSetting('site_title', title);
    sendJson(res, 200, { title });
  }

  async function apiChangePassword({ req, res, session }) {
    if (adminPassword) {
      throw new HttpError(409, 'managed_by_env', '관리자 비밀번호가 ADMIN_PASSWORD 환경 변수로 정해져 있어서 여기서는 바꿀 수 없습니다.');
    }
    const body = await readJson(req, BODY_LIMIT);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (newPassword.length < LIMITS.adminPasswordMin) {
      throw invalid({ newPassword: `새 비밀번호는 ${LIMITS.adminPasswordMin}자 이상으로 정하세요.` });
    }
    if (newPassword.length > LIMITS.adminPasswordMax) {
      throw invalid({ newPassword: `새 비밀번호는 ${LIMITS.adminPasswordMax}자까지 쓸 수 있습니다.` });
    }
    const wrong = '현재 비밀번호가 맞지 않습니다.';
    await requireAdminPassword(req, currentPassword, new HttpError(403, 'wrong_password', wrong, { fields: { currentPassword: wrong } }));

    await store.setSetting('admin_password_hash', await hasher.hash(newPassword));
    await store.deleteOtherSessions(session.tokenHash);
    sendJson(res, 200, { ok: true });
  }

  // ── 라우팅 ───────────────────────────────────────────────────────────────

  const SLUG = '([a-z0-9]{1,32})';
  const ID = '(\\d{1,12})';
  // [방식, 주소, 처리 함수, 선택 사항]. 선택 사항의 body: 'bytes' 는 본문을 JSON 대신 파일 내용(application/octet-stream)으로 받는 주소입니다.
  const routes = [
    ['GET', /^\/$/, pageStudent],
    ['GET', new RegExp(`^/a/${SLUG}/?$`), pageStudent],
    ['GET', /^\/admin\/?$/, pageAdmin],
    ['GET', /^\/assets\/([\w./-]+)$/, serveAsset],
    ['GET', /^\/favicon\.ico$/, ({ res }) => send(res, 302, '', { Location: '/assets/favicon.svg', 'Cache-Control': 'no-cache' })],
    ['GET', /^\/robots\.txt$/, ({ res }) => sendText(res, 200, 'User-agent: *\nDisallow: /\n')],
    ['GET', /^\/healthz$/, ({ res }) => sendText(res, 200, 'ok\n')],

    ['GET', /^\/api\/site$/, apiSite],
    ['POST', new RegExp(`^/api/assignments/${SLUG}/submissions$`), apiSubmit],
    ['POST', new RegExp(`^/api/assignments/${SLUG}/lookup$`), apiLookup],
    ['POST', new RegExp(`^/api/assignments/${SLUG}/uploads$`), apiStartUpload],
    // 조각은 JSON 이 아니라 파일 내용 그대로 받습니다.
    ['PUT', new RegExp(`^/api/uploads/${ID}/chunks/(\\d{1,6})$`), apiPutChunk, { body: 'bytes' }],
    ['DELETE', new RegExp(`^/api/uploads/${ID}$`), apiCancelUpload],

    ['GET', /^\/api\/admin\/session$/, apiSession],
    ['POST', /^\/api\/admin\/login$/, apiLogin],
    ['POST', /^\/api\/admin\/setup$/, apiSetup],
    ['POST', /^\/api\/admin\/logout$/, apiLogout],
    ['POST', /^\/api\/admin\/logout-others$/, admin(apiLogoutOthers)],
    ['GET', /^\/api\/admin\/overview$/, admin(apiOverview)],
    ['POST', /^\/api\/admin\/assignments$/, admin(apiCreateAssignment)],
    ['PUT', new RegExp(`^/api/admin/assignments/${ID}$`), admin(apiUpdateAssignment)],
    ['DELETE', new RegExp(`^/api/admin/assignments/${ID}$`), admin(apiDeleteAssignment)],
    ['GET', new RegExp(`^/api/admin/assignments/${ID}/submissions$`), admin(apiListSubmissions)],
    ['GET', new RegExp(`^/api/admin/submissions/${ID}$`), admin(apiGetSubmission)],
    ['DELETE', new RegExp(`^/api/admin/submissions/${ID}$`), admin(apiDeleteSubmission)],
    ['POST', new RegExp(`^/api/admin/submissions/${ID}/reset-password$`), admin(apiResetSubmissionPassword)],
    ['GET', new RegExp(`^/api/admin/files/${ID}/chunks/(\\d{1,6})$`), admin(apiGetFileChunk)],
    ['GET', /^\/api\/admin\/roster$/, admin(apiGetRoster)],
    ['PUT', /^\/api\/admin\/roster$/, admin(apiPutRoster)],
    ['PUT', /^\/api\/admin\/settings$/, admin(apiPutSettings)],
    ['POST', /^\/api\/admin\/password$/, admin(apiChangePassword)],
  ];

  async function route(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw new HttpError(400, 'bad_request', '잘못된 요청입니다.');
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    let knownPath = false;
    for (const [routeMethod, pattern, handler, options] of routes) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      knownPath = true;
      if (routeMethod !== method) continue;
      if (method !== 'GET') {
        // 다른 주소의 페이지가 로그인한 선생님의 브라우저를 빌려 요청을 보내는 것(CSRF)을 두 겹으로 막습니다.
        // 1) 브라우저가 알려 주는 출처가 이 사이트 자신이 아니면 받지 않습니다. 같은 도메인의 다른 주소(same-site)도 남입니다.
        // 2) 내용을 바꾸는 요청은 본문이 없어도 JSON 형식(파일 조각은 application/octet-stream)이어야 합니다.
        //    다른 주소의 페이지가 이런 형식의 요청을 보내려면 브라우저의 사전 확인(CORS)을 통과해야 하는데, 이 서버는 그 확인에 응하지 않습니다.
        const fetchSite = req.headers['sec-fetch-site'];
        if (fetchSite && fetchSite !== 'same-origin') {
          throw new HttpError(403, 'cross_site', '다른 사이트에서 보낸 요청은 받지 않습니다.');
        }
        if (contentType(req) !== (options?.body === 'bytes' ? 'application/octet-stream' : 'application/json')) {
          throw new HttpError(415, 'unsupported_media_type', '요청 형식이 올바르지 않습니다.');
        }
      }
      await handler({ req, res, url, params: match.slice(1) });
      return;
    }
    if (knownPath) throw new HttpError(405, 'method_not_allowed', '허용되지 않는 요청 방식입니다.');
    throw new HttpError(404, 'not_found', '찾을 수 없는 주소입니다.');
  }

  function sendFailure(req, res, status, code, message, extra = {}) {
    const headers = {};
    if (extra.retryAfter) headers['Retry-After'] = String(extra.retryAfter);
    // 본문을 다 읽지 않고 거절한 요청은 연결을 닫아 남은 본문을 받지 않습니다.
    if (status === 413 || status === 415) headers.Connection = 'close';
    if (String(req.url).startsWith('/api/')) sendJson(res, status, { error: { code, message, ...extra } }, headers);
    else sendText(res, status, `${message}\n`, headers);
  }

  // 만료된 횟수 기록과 로그인, 제출하지 않은 채 남은 파일을 가끔 치웁니다. 타이머 없이 요청이 올 때 처리해서 어떤 실행 환경에서도 같게 동작합니다.
  let lastCleanup = now().getTime();
  async function cleanUp() {
    const at = now();
    if (at.getTime() - lastCleanup < 60 * 1000) return;
    lastCleanup = at.getTime();
    await limiter.prune();
    await store.pruneSessions(at.toISOString());
    await store.discardExpiredUploads(new Date(at.getTime() - UPLOAD_LIFETIME_MS).toISOString());
    await store.sweepOrphanChunks();
  }

  async function handle(req, res) {
    try {
      await cleanUp();
      await route(req, res);
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendFailure(req, res, error.status, error.code, error.message, error.extra);
        return;
      }
      // 보내던 쪽이 도중에 연결을 끊은 경우는 문제가 아닙니다.
      if (req.destroyed || error?.code === 'ECONNRESET') {
        res.destroy();
        return;
      }
      console.error(error);
      sendFailure(req, res, 500, 'server_error', '서버에서 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.');
    }
  }

  return { handle, store, generatedAdminPassword };
}

// 학생 화면과 관리 화면이 함께 쓰는 도구입니다.

// 속성이 아니라 DOM 프로퍼티로 넣어야 하는 값들
const PROPERTIES = new Set(['value', 'checked', 'disabled', 'hidden', 'open']);

// 요소를 만듭니다. 글자는 항상 텍스트 노드로 들어가므로 학생이 입력한 내용이 HTML로 해석되지 않습니다.
export function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined) continue;
    if (PROPERTIES.has(key)) element[key] = value;
    else if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (value !== false) element.setAttribute(key, value === true ? '' : String(value));
  }
  element.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    this.status = status;
    this.code = body?.error?.code || 'error';
    this.fields = body?.error?.fields || null;
  }
}

export async function api(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      // 서버는 내용을 바꾸는 요청을 본문이 없어도 JSON 형식일 때만 받습니다(다른 사이트가 흉내 낼 수 없는 형식).
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.' } });
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // 본문이 JSON이 아니면 상태 코드만으로 판단합니다.
  }
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

// 이름표 + 입력 칸 + 도움말 + 오류 문구 한 묶음
export function field({ id, label, hint, optional, control }) {
  const describedBy = [hint ? `${id}-hint` : null, `${id}-error`].filter(Boolean).join(' ');
  control.setAttribute('aria-describedby', describedBy);
  const error = h('p', { class: 'field-error', id: `${id}-error`, role: 'alert', hidden: true });
  const wrap = h(
    'div',
    { class: 'field' },
    h('label', { class: 'label', for: id }, label, optional ? h('span', { class: 'optional' }, '선택') : null),
    control,
    hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null,
    error,
  );
  function setError(message) {
    error.textContent = message || '';
    error.hidden = !message;
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }
  // 고쳐 쓰기 시작하면 그 칸의 오류 문구는 치웁니다.
  control.addEventListener('input', () => {
    if (!error.hidden) setError('');
  });
  return { wrap, input: control, setError };
}

const SAME_YEAR = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' });
const OTHER_YEAR = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

// 예: 11월 20일 (금) 오후 11:59 — 보는 사람의 시간대로 보여 줍니다.
export function formatDateTime(iso) {
  const date = new Date(iso);
  return (date.getFullYear() === new Date().getFullYear() ? SAME_YEAR : OTHER_YEAR).format(date);
}

// 예: 2026-11-20 23:59:00 — 엑셀이 날짜로 알아보는 형식
export function formatTimestamp(iso) {
  const date = new Date(iso);
  const two = (number) => String(number).padStart(2, '0');
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}

export function dueText(assignment) {
  return assignment.dueAt ? `마감 ${formatDateTime(assignment.dueAt)}` : '마감 없음';
}

// 과제 상태를 한눈에 보여 주는 꼬리표
export function dueBadge(assignment, now = new Date()) {
  if (assignment.state === 'closed') return { text: '마감', tone: 'closed' };
  if (assignment.state === 'late') return { text: '지각 제출', tone: 'late' };
  if (!assignment.dueAt) return { text: '받는 중', tone: 'open' };
  const due = new Date(assignment.dueAt);
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 86400000);
  if (days <= 0) return { text: '오늘 마감', tone: 'soon' };
  return { text: `D-${days}`, tone: days === 1 ? 'soon' : 'open' };
}

// 안내문 안의 http(s) 주소를 누를 수 있는 링크로 바꿉니다.
export function richText(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const url = match[0].replace(/[.,!?)\]]+$/, '');
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(externalLink(url, url));
    last = match.index + url.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function externalLink(url, label, className = '') {
  return h('a', { class: className, href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, label);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 아래의 예전 방식으로 다시 시도합니다.
  }
  // http:// 주소(교실 안 네트워크)에서는 clipboard API를 쓸 수 없습니다.
  const area = h('textarea', { class: 'offscreen', readonly: true, 'aria-hidden': 'true', value: text });
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

let toastHost = null;

export function toast(message, tone = 'info') {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const item = h('p', { class: `toast toast-${tone}` }, message);
  toastHost.append(item);
  setTimeout(() => item.remove(), tone === 'error' ? 6000 : 3500);
}

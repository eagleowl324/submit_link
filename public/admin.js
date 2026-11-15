// 관리 화면: 과제 만들기, 제출 현황, 미제출자, 명단·설정

import { api, copyText, dueBadge, dueText, externalLink, field, formatDateTime, formatTimestamp, h, richText, toast } from './ui.js';
import { LIMITS, compareStudentIds, parseRosterText } from './shared/rules.js';
import { submissionTable, toCsv } from './shared/csv.js';

const app = document.getElementById('app');
const REFRESH_MS = 20 * 1000;

const state = {
  setup: 'console', // 관리자 비밀번호를 처음 정하는 방법: 'console'(서버 실행 창) | 'web'(이 화면)
  view: 'assignments', // 'assignments' | 'settings'
  overview: null, // { title, rosterCount, passwordFromEnv, assignments }
  selectedId: null,
  detail: null, // 선택한 과제의 { assignment, submissions, missing, rosterCount }
  roster: null, // 설정 화면에서만 불러옵니다.
  rosterOnly: false,
  query: '',
  sort: 'studentId', // 'studentId' | 'recent'
};

let refreshTimer = null;
let syncTicket = 0;

const byStudentId = (a, b) => compareStudentIds(a.studentId, b.studentId);

// ── 서버와 주고받기 ─────────────────────────────────────────────────────────

async function call(method, path, body) {
  try {
    return await api(method, path, body);
  } catch (error) {
    if (error.status === 401 && state.overview) leave('로그인 시간이 지났습니다. 다시 로그인해 주세요.');
    throw error;
  }
}

function report(error) {
  if (error.status !== 401) toast(error.message, 'error');
}

function leave(message) {
  clearInterval(refreshTimer);
  refreshTimer = null;
  syncTicket += 1;
  Object.assign(state, { overview: null, detail: null, roster: null, view: 'assignments' });
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  showLogin(message);
}

// 과제 목록과 선택한 과제의 제출 현황을 다시 받아 옵니다.
// quiet 이면 내용이 달라졌을 때만 화면을 다시 그립니다(자동 새로 고침용).
async function sync({ quiet = false } = {}) {
  const ticket = (syncTicket += 1);
  const before = quiet ? JSON.stringify([state.overview, state.detail]) : null;

  const overview = await call('GET', '/api/admin/overview');
  if (ticket !== syncTicket) return;
  let selectedId = state.selectedId;
  if (!overview.assignments.some((assignment) => assignment.id === selectedId)) {
    selectedId = overview.assignments[0]?.id ?? null;
  }

  let detail = null;
  if (selectedId !== null) {
    try {
      detail = await call('GET', `/api/admin/assignments/${selectedId}/submissions`);
    } catch (error) {
      if (error.status !== 404) throw error;
      selectedId = null;
    }
    if (ticket !== syncTicket) return;
  }

  Object.assign(state, { overview, selectedId, detail });
  if (!quiet || JSON.stringify([overview, detail]) !== before) render();
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.hidden || state.view !== 'assignments' || document.querySelector('dialog[open]')) return;
    // 실패해도 다음 주기에 다시 시도하므로 알리지 않습니다. 로그인 만료는 call() 이 처리합니다.
    sync({ quiet: true }).catch(() => {});
  }, REFRESH_MS);
}

// ── 화면 그리기 ─────────────────────────────────────────────────────────────

function render() {
  const active = document.activeElement;
  const focus = active && active.id && app.contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;

  app.replaceChildren(topbar(), state.view === 'settings' ? settingsView() : assignmentsView());

  if (focus) {
    const element = document.getElementById(focus.id);
    if (element) {
      element.focus();
      if (typeof focus.start === 'number' && element.setSelectionRange) {
        try {
          element.setSelectionRange(focus.start, focus.end);
        } catch {
          // 선택 범위를 지원하지 않는 입력 칸
        }
      }
    }
  }
}

function button(label, onclick, variant = 'secondary', extra = {}) {
  return h('button', { class: `button button-${variant}`, type: 'button', onclick, ...extra }, label);
}

function topbar() {
  const tab = (view, label) =>
    h(
      'button',
      {
        class: 'tab',
        type: 'button',
        'aria-current': state.view === view ? 'page' : null,
        onclick: () => openView(view),
      },
      label,
    );
  return h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'topbar-inner' },
      h(
        'p',
        { class: 'brand' },
        h('span', { class: 'site-mark', 'aria-hidden': 'true' }),
        h('span', { class: 'brand-name' }, state.overview.title),
        h('span', { class: 'brand-tag' }, '관리'),
      ),
      h('nav', { class: 'tabs', 'aria-label': '관리 메뉴' }, tab('assignments', '과제'), tab('settings', '설정')),
      h(
        'div',
        { class: 'topbar-actions' },
        h('a', { class: 'quiet-link', href: '/', target: '_blank', rel: 'noopener' }, '학생 화면 열기'),
        button('로그아웃', logout, 'ghost button-small'),
      ),
    ),
  );
}

async function openView(view) {
  if (state.view === view) return;
  state.view = view;
  if (view === 'settings') {
    state.roster = null;
    render();
    try {
      const roster = await call('GET', '/api/admin/roster');
      Object.assign(state, { roster: roster.students, rosterOnly: roster.rosterOnly });
      if (state.view === 'settings') render();
    } catch (error) {
      report(error);
    }
  } else {
    render();
    sync().catch(report);
  }
}

async function logout() {
  try {
    await api('POST', '/api/admin/logout');
  } catch {
    // 서버에 닿지 못해도 화면은 로그인으로 돌려보냅니다.
  }
  leave();
}

// ── 과제 화면 ───────────────────────────────────────────────────────────────

function assignmentsView() {
  if (!state.overview.assignments.length) {
    return h(
      'main',
      { class: 'admin-empty' },
      h('h1', { class: 'page-title' }, '첫 과제를 만들어 보세요'),
      h('p', {}, '과제를 만들면 학생에게 보낼 제출 주소가 생깁니다.'),
      button('새 과제 만들기', () => openAssignmentDialog(), 'primary'),
    );
  }
  return h(
    'main',
    { class: 'admin-layout' },
    sidebar(),
    h('section', { class: 'panel' }, state.detail ? panel(state.detail) : h('p', { class: 'loading' }, '불러오는 중…')),
  );
}

function sidebar() {
  return h(
    'aside',
    { class: 'sidebar' },
    h('div', { class: 'sidebar-head' }, h('h2', { class: 'section-title' }, '과제'), button('새 과제', () => openAssignmentDialog(), 'primary button-small')),
    h(
      'ul',
      { class: 'assignment-nav' },
      state.overview.assignments.map((assignment) => {
        const badge = dueBadge(assignment);
        return h(
          'li',
          {},
          h(
            'button',
            {
              class: 'assignment-nav-item',
              type: 'button',
              'aria-current': assignment.id === state.selectedId ? 'true' : null,
              onclick: () => select(assignment.id),
            },
            h('span', { class: 'nav-title' }, assignment.title),
            h(
              'span',
              { class: 'nav-meta' },
              h('span', { class: `chip chip-${badge.tone}` }, badge.text),
              h('span', { class: 'nav-count' }, `제출 ${assignment.submissionCount}명`),
            ),
          ),
        );
      }),
    ),
  );
}

function select(id) {
  if (id === state.selectedId) return;
  Object.assign(state, { selectedId: id, detail: null, query: '' });
  history.replaceState(null, '', `#a${id}`);
  render();
  sync().catch(report);
}

function visibleSubmissions(detail) {
  const query = state.query.trim().toLowerCase();
  const rows = query
    ? detail.submissions.filter((s) => s.studentId.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
    : [...detail.submissions];
  if (state.sort === 'recent') rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  else rows.sort(byStudentId);
  return rows;
}

function panel(detail) {
  const assignment = detail.assignment;
  const badge = dueBadge(assignment);
  const shareUrl = `${location.origin}/a/${assignment.slug}`;
  const lateCount = detail.submissions.filter((s) => s.isLate).length;

  const latePolicy = assignment.dueAt ? (assignment.allowLate ? '마감 뒤에도 받고 지각으로 표시' : '마감 뒤에는 받지 않음') : null;

  const head = h(
    'div',
    { class: 'panel-head' },
    h(
      'div',
      { class: 'panel-heading' },
      h('h1', { class: 'panel-title' }, assignment.title),
      h(
        'p',
        { class: 'due-line' },
        h('span', { class: `chip chip-${badge.tone}` }, badge.text),
        h('span', {}, dueText(assignment)),
        latePolicy ? h('span', { class: 'muted' }, `· ${latePolicy}`) : null,
        !assignment.isOpen ? h('span', { class: 'muted' }, '· 직접 닫음') : null,
      ),
      assignment.description ? h('p', { class: 'description' }, richText(assignment.description)) : null,
    ),
    h(
      'div',
      { class: 'panel-actions' },
      button('수정', () => openAssignmentDialog(assignment), 'secondary button-small'),
      button(assignment.isOpen ? '제출 닫기' : '다시 받기', () => toggleOpen(assignment), 'secondary button-small'),
      button('삭제', () => removeAssignment(assignment, detail.submissions.length), 'ghost button-small button-danger'),
    ),
  );

  const share = h(
    'div',
    { class: 'share' },
    h('label', { class: 'label', for: 'share-url' }, '학생에게 보낼 주소'),
    h(
      'div',
      { class: 'with-button' },
      h('input', { class: 'input input-mono', id: 'share-url', readonly: true, value: shareUrl, onfocus: (event) => event.target.select() }),
      button('복사', async () => {
        if (await copyText(shareUrl)) toast('주소를 복사했습니다.');
        else toast('복사하지 못했습니다. 주소를 직접 선택해서 복사하세요.', 'error');
      }),
    ),
    // 서버를 켠 컴퓨터에서 localhost 로 관리 화면을 열었을 때: 이 주소는 학생 기기에서 열리지 않습니다.
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
      ? h(
          'p',
          { class: 'hint hint-warn' },
          `이 주소의 ${location.hostname} 부분은 이 컴퓨터에서만 통합니다. 학생에게 보낼 때는 학생이 접속할 수 있는 주소(같은 네트워크 주소나 공개한 주소)로 바꿔 주세요.`,
        )
      : null,
  );

  const stat = (label, value, note) =>
    h('div', { class: 'stat' }, h('dt', {}, label), h('dd', {}, h('span', { class: 'stat-value' }, value), note ? h('span', { class: 'stat-note' }, note) : null));
  const stats = h(
    'dl',
    { class: 'stats' },
    stat('제출', `${detail.submissions.length}명`),
    stat('지각', `${lateCount}명`),
    detail.rosterCount ? stat('미제출', `${detail.missing.length}명`, `명단 ${detail.rosterCount}명`) : null,
  );

  const tableHost = h('div', { class: 'table-host' }, submissionsTable(detail));
  const sort = h(
    'select',
    {
      class: 'input',
      id: 'sort',
      'aria-label': '정렬 순서',
      onchange: (event) => {
        state.sort = event.target.value;
        tableHost.replaceChildren(submissionsTable(detail));
      },
    },
    h('option', { value: 'studentId' }, '학번 순'),
    h('option', { value: 'recent' }, '최근 제출 순'),
  );
  sort.value = state.sort;

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('input', {
      class: 'input toolbar-search',
      id: 'search',
      type: 'search',
      placeholder: '학번이나 이름으로 찾기',
      'aria-label': '학번이나 이름으로 찾기',
      value: state.query,
      oninput: (event) => {
        state.query = event.target.value;
        tableHost.replaceChildren(submissionsTable(detail));
      },
    }),
    sort,
    button('CSV 내려받기', () => downloadCsv(detail), 'secondary', { disabled: !detail.submissions.length && !detail.missing.length }),
  );

  return [head, share, stats, toolbar, tableHost, missingSection(detail)];
}

function chip(text, tone) {
  return h('span', { class: `chip chip-${tone}` }, text);
}

function rosterFlag(submission, detail) {
  if (detail.rosterCount && submission.rosterName === null) return chip('명단에 없음', 'closed');
  if (submission.rosterName && submission.rosterName !== submission.name) return chip(`명단 이름: ${submission.rosterName}`, 'late');
  return null;
}

// 넓은 화면에서는 표, 좁은 화면에서는 같은 표가 카드 목록으로 바뀝니다(styles.css 의 @container).
// 표가 아닌 모양으로 바뀌어도 화면 낭독기가 표로 읽도록 role 을 직접 적어 둡니다.
function submissionsTable(detail) {
  if (!detail.submissions.length) {
    return h('p', { class: 'empty' }, '아직 제출된 링크가 없습니다. 위의 주소를 학생들에게 보내 주세요.');
  }
  const rows = visibleSubmissions(detail);
  if (!rows.length) return h('p', { class: 'empty' }, '찾는 학생이 없습니다.');

  const heading = (label, className) => h('th', { class: className, scope: 'col', role: 'columnheader' }, label);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table', role: 'table' },
      h(
        'thead',
        { role: 'rowgroup' },
        h(
          'tr',
          { role: 'row' },
          heading('학번', 'col-id'),
          heading('이름', 'col-name'),
          heading('링크 · 메모', 'col-link'),
          heading('제출 시각', 'col-time'),
          heading(h('span', { class: 'sr-only' }, '자세히'), 'col-action'),
        ),
      ),
      h('tbody', { role: 'rowgroup' }, rows.map((submission) => submissionRow(submission, detail))),
    ),
  );
}

function linkCell(url) {
  return externalLink(url, url.replace(/^https?:\/\//, ''), 'link');
}

function submissionRow(submission, detail) {
  return h(
    'tr',
    { role: 'row' },
    h('td', { class: 'cell-id', role: 'cell' }, submission.studentId),
    h('td', { class: 'cell-name', role: 'cell' }, h('div', { class: 'cell-stack' }, h('span', {}, submission.name), rosterFlag(submission, detail))),
    h('td', { class: 'cell-link', role: 'cell' }, linkCell(submission.url), submission.note ? h('p', { class: 'cell-note' }, submission.note) : null),
    h(
      'td',
      { class: 'cell-time', role: 'cell' },
      h(
        'div',
        { class: 'cell-stack' },
        h('span', { class: 'time' }, formatDateTime(submission.updatedAt)),
        submission.isLate ? chip('지각', 'late') : null,
        submission.revision > 1 ? h('span', { class: 'cell-meta' }, `${submission.revision}번째 제출`) : null,
        !submission.hasPassword ? chip('비밀번호 초기화됨', 'closed') : null,
      ),
    ),
    h(
      'td',
      { class: 'cell-actions', role: 'cell' },
      button('자세히', () => openSubmissionDialog(submission, detail), 'secondary button-small', {
        'aria-label': `${submission.studentId} ${submission.name} 자세히`,
      }),
    ),
  );
}

// 제출 한 건의 전체 내용과 이전 링크 기록, 그리고 드물게 쓰는 관리 기능
function openSubmissionDialog(submission, detail) {
  const row = (label, ...value) => [h('dt', {}, label), h('dd', {}, value)];
  const flag = rosterFlag(submission, detail);

  // 이전 링크는 목록에 들어 있지 않아서 창을 열 때 받아 옵니다.
  const history =
    submission.revision > 1
      ? h(
          'section',
          { class: 'detail-history' },
          h('h3', { class: 'detail-subtitle' }, `이전 제출 ${submission.revision - 1}건`),
          h('p', { class: 'muted' }, '불러오는 중…'),
        )
      : null;

  const dialog = openDialog(`${submission.studentId} ${submission.name}`, [
    h(
      'dl',
      { class: 'detail-rows' },
      row('링크', externalLink(submission.url, submission.url, 'detail-link')),
      submission.note ? row('메모', h('span', { class: 'detail-note' }, submission.note)) : null,
      row('제출 시각', h('span', { class: 'time' }, formatDateTime(submission.updatedAt)), submission.isLate ? chip('지각', 'late') : null),
      submission.revision > 1 ? row('처음 제출', h('span', { class: 'time' }, formatDateTime(submission.createdAt))) : null,
      flag ? row('명단', flag) : null,
    ),
    history,
    !submission.hasPassword
      ? h('p', { class: 'notice notice-late' }, '비밀번호가 초기화되어 있습니다. 이 학번으로 다음에 제출하는 사람이 새 비밀번호를 정합니다.')
      : null,
    h(
      'div',
      { class: 'dialog-actions dialog-actions-split' },
      h(
        'div',
        { class: 'dialog-actions-group' },
        button('비밀번호 초기화', () => resetPassword(submission, dialog), 'secondary button-small', { disabled: !submission.hasPassword }),
        button('제출 삭제', () => removeSubmission(submission, dialog), 'ghost button-small button-danger'),
      ),
      button('닫기', () => dialog.close()),
    ),
  ]);

  if (history) {
    call('GET', `/api/admin/submissions/${submission.id}`)
      .then(({ submission: full }) => {
        history.lastElementChild.replaceWith(
          h(
            'ol',
            { class: 'history-list' },
            full.history.map((entry) =>
              h(
                'li',
                {},
                h('span', { class: 'history-when' }, h('span', { class: 'time' }, formatDateTime(entry.submittedAt)), entry.isLate ? chip('지각', 'late') : null),
                externalLink(entry.url, entry.url, 'detail-link'),
                entry.note ? h('span', { class: 'detail-note muted' }, entry.note) : null,
              ),
            ),
          ),
        );
      })
      .catch((error) => {
        if (error.status !== 401) history.lastElementChild.replaceWith(h('p', { class: 'field-error' }, error.message));
      });
  }
}

function missingSection(detail) {
  if (!detail.rosterCount) {
    return h(
      'section',
      { class: 'missing' },
      h('h2', { class: 'section-title' }, '미제출자'),
      h(
        'p',
        { class: 'muted' },
        '학생 명단을 등록하면 아직 내지 않은 학생을 여기서 볼 수 있습니다. ',
        h('button', { class: 'text-button', type: 'button', onclick: () => openView('settings') }, '명단 등록하기'),
      ),
    );
  }
  if (!detail.missing.length) {
    return h('section', { class: 'missing' }, h('h2', { class: 'section-title' }, '미제출자'), h('p', {}, '명단에 있는 학생이 모두 제출했습니다.'));
  }
  const people = [...detail.missing].sort(byStudentId);
  return h(
    'section',
    { class: 'missing' },
    h(
      'div',
      { class: 'section-head' },
      h('h2', { class: 'section-title' }, `미제출 ${people.length}명`),
      button(
        '명단 복사',
        async () => {
          const text = people.map((person) => `${person.studentId} ${person.name}`).join('\n');
          if (await copyText(text)) toast('미제출자 명단을 복사했습니다.');
          else toast('복사하지 못했습니다.', 'error');
        },
        'secondary button-small',
      ),
    ),
    h(
      'ul',
      { class: 'people' },
      people.map((person) => h('li', {}, h('span', { class: 'person-id' }, person.studentId), h('span', {}, person.name))),
    ),
  );
}

function downloadCsv(detail) {
  const rows = submissionTable(
    { submissions: [...detail.submissions].sort(byStudentId), missing: [...detail.missing].sort(byStudentId) },
    formatTimestamp,
  );
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const safeTitle = detail.assignment.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60) || '과제';
  const anchor = h('a', { href: url, download: `${safeTitle}_제출현황_${formatTimestamp(new Date().toISOString()).slice(0, 10)}.csv` });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10 * 1000);
}

// ── 과제·제출 고치기 ────────────────────────────────────────────────────────

async function toggleOpen(assignment) {
  try {
    await call('PUT', `/api/admin/assignments/${assignment.id}`, {
      title: assignment.title,
      description: assignment.description,
      dueAt: assignment.dueAt,
      allowLate: assignment.allowLate,
      isOpen: !assignment.isOpen,
    });
    toast(assignment.isOpen ? '제출을 닫았습니다.' : '다시 제출을 받습니다.');
    await sync();
  } catch (error) {
    report(error);
  }
}

async function removeAssignment(assignment, submissionCount) {
  const confirmed = await confirmDialog({
    title: '과제를 삭제할까요?',
    message: `"${assignment.title}" 과제와 제출된 링크 ${submissionCount}건이 모두 지워지고 되돌릴 수 없습니다. 필요하면 먼저 CSV로 내려받으세요.`,
    confirmLabel: '삭제',
  });
  if (!confirmed) return;
  try {
    await call('DELETE', `/api/admin/assignments/${assignment.id}`);
    state.selectedId = null;
    history.replaceState(null, '', location.pathname);
    toast('과제를 삭제했습니다.');
    await sync();
  } catch (error) {
    report(error);
  }
}

async function removeSubmission(submission, parentDialog) {
  const confirmed = await confirmDialog({
    title: '제출을 삭제할까요?',
    message: `${submission.studentId} ${submission.name} 학생의 제출과 이전 제출 기록이 지워집니다. 학생은 처음부터 다시 낼 수 있습니다.`,
    confirmLabel: '삭제',
  });
  if (!confirmed) return;
  try {
    await call('DELETE', `/api/admin/submissions/${submission.id}`);
    parentDialog.close();
    toast('제출을 삭제했습니다.');
    await sync();
  } catch (error) {
    report(error);
  }
}

async function resetPassword(submission, parentDialog) {
  const confirmed = await confirmDialog({
    title: '비밀번호를 초기화할까요?',
    message: `${submission.studentId} ${submission.name} 학생이 다음에 제출할 때 새 비밀번호를 정하게 됩니다. 제출한 링크는 그대로 남습니다.`,
    confirmLabel: '초기화',
    danger: false,
  });
  if (!confirmed) return;
  try {
    await call('POST', `/api/admin/submissions/${submission.id}/reset-password`);
    parentDialog.close();
    toast('비밀번호를 초기화했습니다.');
    await sync();
  } catch (error) {
    report(error);
  }
}

// ── 대화 상자 ───────────────────────────────────────────────────────────────

let dialogCount = 0;

function openDialog(title, content) {
  dialogCount += 1;
  const titleId = `dialog-title-${dialogCount}`;
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId }, h('h2', { class: 'dialog-title', id: titleId }, title), content);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function confirmDialog({ title, message, confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const dialog = openDialog(title, [
      h('p', { class: 'dialog-text' }, message),
      h(
        'div',
        { class: 'dialog-actions' },
        button('취소', () => dialog.close()),
        button(
          confirmLabel,
          () => {
            confirmed = true;
            dialog.close();
          },
          danger ? 'danger-solid' : 'primary',
        ),
      ),
    ]);
    dialog.addEventListener('close', () => resolve(confirmed));
  });
}

// datetime-local 입력 칸이 쓰는 형식(보는 사람의 시간대, 2026-11-20T23:59)
function toLocalInput(iso) {
  return formatTimestamp(iso).slice(0, 16).replace(' ', 'T');
}

function openAssignmentDialog(existing) {
  const title = field({
    id: 'assignment-title',
    label: '과제 제목',
    control: h('input', {
      class: 'input',
      id: 'assignment-title',
      maxlength: LIMITS.title,
      placeholder: '예: 3주차 실습 결과물',
      value: existing?.title ?? '',
    }),
  });
  const description = field({
    id: 'assignment-description',
    label: '안내문',
    optional: true,
    hint: '학생이 제출 화면에서 보게 됩니다. 어떤 링크를 내야 하는지, 공유 설정은 어떻게 하는지 적어 주세요.',
    control: h('textarea', { class: 'input', id: 'assignment-description', rows: 4, maxlength: LIMITS.description, value: existing?.description ?? '' }),
  });
  const due = field({
    id: 'assignment-due',
    label: '마감 일시',
    optional: true,
    hint: '비워 두면 직접 닫을 때까지 계속 받습니다.',
    control: h('input', { class: 'input', id: 'assignment-due', type: 'datetime-local', value: existing?.dueAt ? toLocalInput(existing.dueAt) : '' }),
  });
  const allowLate = h('input', { type: 'checkbox', id: 'assignment-late', checked: existing ? existing.allowLate : true });
  const message = h('p', { class: 'form-message', role: 'alert', hidden: true });
  const save = h('button', { class: 'button button-primary', type: 'submit' }, existing ? '저장' : '과제 만들기');
  const fields = { title, description, dueAt: due };

  const form = h(
    'form',
    {
      class: 'dialog-form',
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        for (const item of Object.values(fields)) item.setError('');
        message.hidden = true;

        let dueAt = null;
        if (due.input.value) {
          const date = new Date(due.input.value);
          if (Number.isNaN(date.getTime())) {
            due.setError('마감 일시가 올바르지 않습니다.');
            return;
          }
          dueAt = date.toISOString();
        }
        const payload = {
          title: title.input.value,
          description: description.input.value,
          dueAt,
          allowLate: allowLate.checked,
          isOpen: existing ? existing.isOpen : true,
        };

        save.disabled = true;
        try {
          if (existing) {
            await call('PUT', `/api/admin/assignments/${existing.id}`, payload);
          } else {
            const created = await call('POST', '/api/admin/assignments', payload);
            Object.assign(state, { selectedId: created.assignment.id, detail: null, query: '' });
            history.replaceState(null, '', `#a${created.assignment.id}`);
          }
          dialog.close();
          toast(existing ? '과제를 고쳤습니다.' : '과제를 만들었습니다. 주소를 학생들에게 보내 주세요.');
          await sync();
        } catch (error) {
          if (error.status === 401) return;
          let shown = false;
          for (const [key, text] of Object.entries(error.fields ?? {})) {
            if (fields[key]) {
              fields[key].setError(text);
              shown = true;
            }
          }
          if (!shown) {
            message.textContent = error.message;
            message.hidden = false;
          }
        } finally {
          save.disabled = false;
        }
      },
    },
    title.wrap,
    description.wrap,
    due.wrap,
    h('label', { class: 'check', for: 'assignment-late' }, allowLate, h('span', {}, '마감 뒤에도 제출을 받고 "지각"으로 표시하기')),
    message,
    h('div', { class: 'dialog-actions' }, button('취소', () => dialog.close()), save),
  );

  const dialog = openDialog(existing ? '과제 수정' : '새 과제', form);
  title.input.focus();
}

// ── 설정 화면 ───────────────────────────────────────────────────────────────

function settingsCard(title, ...content) {
  return h('section', { class: 'card settings-card' }, h('h2', { class: 'section-title' }, title), content);
}

function settingsView() {
  return h('main', { class: 'settings' }, siteSettings(), rosterSettings(), passwordSettings());
}

function siteSettings() {
  const title = field({
    id: 'site-title',
    label: '학생 화면에 보일 이름',
    hint: '학생 화면 맨 위와 공유한 링크의 제목에 나옵니다. 예: 2학년 정보 과제 제출',
    control: h('input', { class: 'input', id: 'site-title', maxlength: LIMITS.siteTitle, value: state.overview.title }),
  });
  const save = h('button', { class: 'button button-primary', type: 'submit' }, '저장');
  return settingsCard(
    '사이트 이름',
    h(
      'form',
      {
        class: 'settings-form',
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          title.setError('');
          save.disabled = true;
          try {
            const result = await call('PUT', '/api/admin/settings', { title: title.input.value });
            state.overview.title = result.title;
            document.title = `관리 · ${result.title}`;
            toast('사이트 이름을 바꿨습니다.');
            render();
          } catch (error) {
            if (error.fields?.title) title.setError(error.fields.title);
            else report(error);
          } finally {
            save.disabled = false;
          }
        },
      },
      title.wrap,
      save,
    ),
  );
}

function rosterSettings() {
  if (state.roster === null) return settingsCard('학생 명단', h('p', { class: 'loading' }, '불러오는 중…'));

  const roster = field({
    id: 'roster',
    label: '명단',
    hint: '한 줄에 한 명씩 "학번 이름" 순서로 적습니다. 엑셀에서 학번과 이름 두 열을 복사해 붙여 넣어도 됩니다.',
    control: h('textarea', {
      class: 'input input-mono',
      id: 'roster',
      rows: 12,
      spellcheck: 'false',
      placeholder: '20301 김하늘\n20302 이도윤\n20303 박서연',
      value: [...state.roster].sort(byStudentId).map((student) => `${student.studentId}\t${student.name}`).join('\n'),
    }),
  });
  const problems = h('ul', { class: 'problem-list', hidden: true });
  const rosterOnly = h('input', { type: 'checkbox', id: 'roster-only', checked: state.rosterOnly });
  const save = h('button', { class: 'button button-primary', type: 'submit' }, '명단 저장');

  return settingsCard(
    '학생 명단',
    h('p', { class: 'settings-lead' }, `명단을 등록하면 과제마다 아직 내지 않은 학생을 볼 수 있습니다. 지금 등록된 학생은 ${state.roster.length}명입니다.`),
    h(
      'form',
      {
        class: 'settings-form',
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          roster.setError('');
          problems.hidden = true;

          const parsed = parseRosterText(roster.input.value);
          if (parsed.problems.length) {
            roster.setError(`읽을 수 없는 줄이 ${parsed.problems.length}개 있습니다. 고친 뒤 다시 저장하세요.`);
            problems.replaceChildren(
              ...parsed.problems.slice(0, 8).map((problem) => h('li', {}, `${problem.line}번째 줄 "${problem.text}" — ${problem.reason}`)),
            );
            problems.hidden = false;
            return;
          }

          save.disabled = true;
          try {
            const result = await call('PUT', '/api/admin/roster', { students: parsed.students, rosterOnly: rosterOnly.checked });
            Object.assign(state, { roster: parsed.students, rosterOnly: result.rosterOnly });
            state.overview.rosterCount = result.count;
            toast(result.count ? `명단 ${result.count}명을 저장했습니다.` : '명단을 비웠습니다.');
            render();
          } catch (error) {
            if (error.status !== 401) roster.setError(error.message);
          } finally {
            save.disabled = false;
          }
        },
      },
      roster.wrap,
      problems,
      h(
        'label',
        { class: 'check', for: 'roster-only' },
        rosterOnly,
        h('span', {}, '명단에 있는 학번만 제출 받기', h('span', { class: 'check-note' }, '학번을 잘못 쓴 제출을 막습니다. 명단이 비어 있으면 적용되지 않습니다.')),
      ),
      save,
    ),
  );
}

// 다른 컴퓨터나 휴대폰에 남아 있는 로그인을 한 번에 끊습니다.
function otherDevices() {
  return h(
    'div',
    { class: 'settings-form' },
    h('p', { class: 'settings-lead' }, '다른 컴퓨터나 휴대폰에 로그인해 둔 것이 걱정되면 한 번에 해제할 수 있습니다. 지금 이 기기는 로그인된 채로 남습니다.'),
    button(
      '다른 기기에서 로그아웃',
      async () => {
        try {
          await call('POST', '/api/admin/logout-others');
          toast('이 기기를 뺀 모든 로그인을 해제했습니다.');
        } catch (error) {
          report(error);
        }
      },
      'secondary',
    ),
  );
}

function passwordSettings() {
  if (state.overview.passwordFromEnv) {
    return settingsCard(
      '관리자 비밀번호',
      h('p', {}, '관리자 비밀번호가 서버의 ADMIN_PASSWORD 환경 변수로 정해져 있습니다. 바꾸려면 그 값을 바꾸고 서버를 다시 시작하세요. 그러면 예전 로그인도 모두 해제됩니다.'),
      otherDevices(),
    );
  }
  const passwordInput = (id, autocomplete) => h('input', { class: 'input', id, type: 'password', autocomplete, maxlength: LIMITS.adminPasswordMax });
  const current = field({ id: 'current-password', label: '현재 비밀번호', control: passwordInput('current-password', 'current-password') });
  const next = field({
    id: 'new-password',
    label: '새 비밀번호',
    hint: `${LIMITS.adminPasswordMin}자 이상으로 정하세요.`,
    control: passwordInput('new-password', 'new-password'),
  });
  const again = field({ id: 'new-password-again', label: '새 비밀번호 확인', control: passwordInput('new-password-again', 'new-password') });
  const save = h('button', { class: 'button button-primary', type: 'submit' }, '비밀번호 바꾸기');

  return settingsCard(
    '관리자 비밀번호',
    h(
      'form',
      {
        class: 'settings-form',
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          for (const item of [current, next, again]) item.setError('');
          if (!current.input.value) return current.setError('현재 비밀번호를 입력하세요.');
          if (next.input.value.length < LIMITS.adminPasswordMin) return next.setError(`새 비밀번호는 ${LIMITS.adminPasswordMin}자 이상으로 정하세요.`);
          if (next.input.value !== again.input.value) return again.setError('새 비밀번호와 다릅니다.');

          save.disabled = true;
          try {
            await call('POST', '/api/admin/password', { currentPassword: current.input.value, newPassword: next.input.value });
            for (const item of [current, next, again]) item.input.value = '';
            toast('비밀번호를 바꿨습니다. 다른 기기의 로그인은 해제되었습니다.');
          } catch (error) {
            if (error.fields?.currentPassword) current.setError(error.fields.currentPassword);
            else if (error.fields?.newPassword) next.setError(error.fields.newPassword);
            else report(error);
          } finally {
            save.disabled = false;
          }
          return undefined;
        },
      },
      current.wrap,
      next.wrap,
      again.wrap,
      save,
    ),
    otherDevices(),
  );
}

// ── 로그인 ──────────────────────────────────────────────────────────────────

function showLogin(notice) {
  const password = field({
    id: 'password',
    label: '관리자 비밀번호',
    hint: state.setup === 'console' ? '처음 실행했다면 서버 실행 창에 표시된 비밀번호를 입력하세요.' : null,
    control: h('input', { class: 'input', id: 'password', type: 'password', autocomplete: 'current-password', maxlength: LIMITS.adminPasswordMax }),
  });
  const submit = h('button', { class: 'button button-primary button-block', type: 'submit' }, '로그인');

  app.replaceChildren(
    h(
      'main',
      { class: 'login' },
      h(
        'form',
        {
          class: 'card login-card',
          novalidate: true,
          onsubmit: async (event) => {
            event.preventDefault();
            password.setError('');
            if (!password.input.value) {
              password.setError('비밀번호를 입력하세요.');
              return;
            }
            submit.disabled = true;
            try {
              await api('POST', '/api/admin/login', { password: password.input.value });
              await enter();
            } catch (error) {
              password.setError(error.message);
              password.input.select();
            } finally {
              submit.disabled = false;
            }
          },
        },
        h('h1', { class: 'login-title' }, '관리자 로그인'),
        notice ? h('p', { class: 'notice notice-late', role: 'status' }, notice) : null,
        password.wrap,
        submit,
      ),
      h('a', { class: 'quiet-link', href: '/' }, '학생 화면으로 가기'),
    ),
  );
  password.input.focus();
}

// 관리자 비밀번호가 아직 없을 때: 처음 들어온 사람이 정합니다. (서버 실행 창이 없는 Cloudflare 배포에서 씁니다.)
function showSetup() {
  const passwordInput = (id) => h('input', { class: 'input', id, type: 'password', autocomplete: 'new-password', maxlength: LIMITS.adminPasswordMax });
  const password = field({
    id: 'setup-password',
    label: '새 관리자 비밀번호',
    hint: `${LIMITS.adminPasswordMin}자 이상으로 정하세요. 모든 제출 내용을 볼 수 있는 비밀번호이니 다른 곳에서 쓰지 않는 것으로 정하는 것이 좋습니다.`,
    control: passwordInput('setup-password'),
  });
  const again = field({ id: 'setup-password-again', label: '한 번 더 입력', control: passwordInput('setup-password-again') });
  const submit = h('button', { class: 'button button-primary button-block', type: 'submit' }, '비밀번호 정하고 시작하기');

  app.replaceChildren(
    h(
      'main',
      { class: 'login' },
      h(
        'form',
        {
          class: 'card login-card',
          novalidate: true,
          onsubmit: async (event) => {
            event.preventDefault();
            password.setError('');
            again.setError('');
            if (password.input.value.length < LIMITS.adminPasswordMin) {
              password.setError(`비밀번호는 ${LIMITS.adminPasswordMin}자 이상으로 정하세요.`);
              password.input.focus();
              return;
            }
            if (password.input.value !== again.input.value) {
              again.setError('위에 쓴 비밀번호와 다릅니다.');
              again.input.focus();
              return;
            }
            submit.disabled = true;
            try {
              await api('POST', '/api/admin/setup', { password: password.input.value });
              await enter();
            } catch (error) {
              if (error.code === 'already_set') showLogin('관리자 비밀번호가 이미 정해져 있습니다. 로그인해 주세요.');
              else password.setError(error.fields?.password || error.message);
            } finally {
              submit.disabled = false;
            }
          },
        },
        h('h1', { class: 'login-title' }, '관리자 비밀번호 만들기'),
        h('p', { class: 'settings-lead' }, '이 사이트를 처음 여셨습니다. 관리 화면에 들어올 때 쓸 비밀번호를 정해 주세요. 처음 한 번만 하면 됩니다.'),
        password.wrap,
        again.wrap,
        submit,
      ),
      h('a', { class: 'quiet-link', href: '/' }, '학생 화면으로 가기'),
    ),
  );
  password.input.focus();
}

async function enter() {
  state.view = 'assignments';
  const wanted = Number(location.hash.replace(/^#a/, ''));
  state.selectedId = Number.isInteger(wanted) && wanted > 0 ? wanted : null;
  await sync();
  startRefresh();
}

async function boot() {
  try {
    const session = await api('GET', '/api/admin/session');
    state.setup = session.setup;
    if (session.authenticated) await enter();
    else if (session.needsSetup) showSetup();
    else showLogin();
  } catch (error) {
    app.replaceChildren(
      h(
        'main',
        { class: 'login' },
        h('div', { class: 'problem' }, h('h1', { class: 'page-title' }, '관리 화면을 불러오지 못했습니다'), h('p', {}, error.message), button('다시 불러오기', () => location.reload())),
      ),
    );
  }
}

boot();

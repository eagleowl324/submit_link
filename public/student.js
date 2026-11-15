// 학생 화면: 과제 목록(/)과 과제별 제출 화면(/a/주소)

import { api, dueBadge, dueText, externalLink, field, formatDateTime, h, richText } from './ui.js';
import { LIMITS, checkStudentId, normalizeStudentId, validateSubmission } from './shared/rules.js';

const app = document.getElementById('app');
const slug = /^\/a\/([a-z0-9]+)\/?$/.exec(location.pathname)?.[1] ?? null;
const STORAGE_KEY = 'assignment-links:me';

// 같은 기기에서 다음 과제를 낼 때 학번과 이름을 다시 치지 않도록 기억합니다. 비밀번호는 저장하지 않습니다.
function recall() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      studentId: typeof saved.studentId === 'string' ? saved.studentId : '',
      name: typeof saved.name === 'string' ? saved.name : '',
    };
  } catch {
    return { studentId: '', name: '' };
  }
}

function remember(me) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(me));
  } catch {
    // 저장이 막힌 브라우저에서는 그냥 넘어갑니다.
  }
}

function siteHead(site, linkToList) {
  const name = h('span', { class: 'site-name' }, site.title);
  return h(
    'header',
    { class: 'site-head' },
    h('span', { class: 'site-mark', 'aria-hidden': 'true' }),
    linkToList ? h('a', { class: 'site-link', href: '/' }, name) : name,
  );
}

function badgeChip(assignment) {
  const badge = dueBadge(assignment);
  return h('span', { class: `chip chip-${badge.tone}` }, badge.text);
}

function showProblem(title, message) {
  app.replaceChildren(
    h('div', { class: 'problem' }, h('h1', { class: 'page-title' }, title), h('p', {}, message), h('a', { class: 'button button-secondary', href: '/' }, '과제 목록으로')),
  );
}

function showList(site) {
  document.title = site.title;
  const list = site.assignments.length
    ? h(
        'ul',
        { class: 'assignment-list' },
        site.assignments.map((assignment) =>
          h(
            'li',
            {},
            h(
              'a',
              { class: `assignment-row is-${assignment.state}`, href: `/a/${assignment.slug}` },
              h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, assignment.title), h('span', { class: 'row-meta' }, dueText(assignment))),
              badgeChip(assignment),
            ),
          ),
        ),
      )
    : h('p', { class: 'empty' }, '아직 올라온 과제가 없습니다. 선생님이 과제를 올리면 여기에 나타납니다.');

  app.replaceChildren(siteHead(site, false), h('h1', { class: 'page-title' }, '제출할 과제를 고르세요'), list);
}

function showAssignment(site, assignment) {
  document.title = `${assignment.title} · ${site.title}`;

  const stage = h('div', { class: 'stage' });
  app.replaceChildren(
    siteHead(site, true),
    h(
      'div',
      { class: 'assignment-head' },
      h('h1', { class: 'page-title' }, assignment.title),
      h('p', { class: 'due-line' }, badgeChip(assignment), h('span', {}, dueText(assignment))),
      assignment.description ? h('p', { class: 'description' }, richText(assignment.description)) : null,
    ),
    stage,
    site.assignments.length > 1 ? h('p', { class: 'page-foot' }, h('a', { href: '/' }, '다른 과제 보기')) : null,
  );

  const me = recall();
  const draft = { studentId: me.studentId, name: me.name, url: '', note: '', password: '' };
  const endpoint = `/api/assignments/${assignment.slug}`;

  if (assignment.state === 'closed') showClosed();
  else showForm();

  function showClosed() {
    stage.replaceChildren(
      h('p', { class: 'notice notice-closed', role: 'status' }, '제출이 마감되었습니다. 새로 내거나 고칠 수 없습니다.'),
      lookupBlock(true),
    );
  }

  function showForm() {
    const studentId = field({
      id: 'studentId',
      label: '학번',
      control: h('input', {
        class: 'input',
        id: 'studentId',
        name: 'studentId',
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
        maxlength: LIMITS.studentId,
        value: draft.studentId,
      }),
    });
    const name = field({
      id: 'name',
      label: '이름',
      control: h('input', { class: 'input', id: 'name', name: 'name', autocomplete: 'off', maxlength: LIMITS.name, value: draft.name }),
    });
    const url = field({
      id: 'url',
      label: '과제 링크',
      hint: '선생님이 열 수 있는 링크인지 확인하세요. 문서라면 공유 설정을 "링크가 있는 모든 사용자"로 바꿔야 합니다.',
      control: h('input', {
        class: 'input input-mono',
        id: 'url',
        name: 'url',
        type: 'url',
        inputmode: 'url',
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        placeholder: 'https://',
        maxlength: LIMITS.url,
        value: draft.url,
      }),
    });
    const note = field({
      id: 'note',
      label: '메모',
      optional: true,
      control: h('textarea', { class: 'input', id: 'note', name: 'note', rows: 2, maxlength: LIMITS.note, value: draft.note }),
    });
    const passwordInput = h('input', {
      class: 'input',
      id: 'password',
      name: 'password',
      type: 'password',
      autocomplete: 'new-password',
      maxlength: LIMITS.passwordMax,
      value: draft.password,
    });
    const reveal = h(
      'button',
      {
        class: 'reveal',
        type: 'button',
        'aria-pressed': 'false',
        onclick: () => {
          const showing = passwordInput.type === 'text';
          passwordInput.type = showing ? 'password' : 'text';
          reveal.textContent = showing ? '보기' : '숨기기';
          reveal.setAttribute('aria-pressed', String(!showing));
        },
      },
      '보기',
    );
    const password = field({
      id: 'password',
      label: '수정용 비밀번호',
      hint: `나중에 링크를 고치거나 확인할 때 씁니다. ${LIMITS.passwordMin}자 이상, 평소 쓰는 비밀번호 말고 이 과제용으로 정하세요.`,
      control: passwordInput,
    });
    // 입력 칸 옆에 [보기] 버튼을 붙입니다.
    const passwordRow = h('div', { class: 'with-button' });
    passwordInput.replaceWith(passwordRow);
    passwordRow.append(passwordInput, reveal);

    const fields = { studentId, name, url, note, password };
    const message = h('p', { class: 'form-message', role: 'alert', hidden: true });
    const submit = h('button', { class: 'button button-primary button-block', type: 'submit' }, '제출하기');

    const form = h(
      'form',
      {
        class: 'card form',
        novalidate: true,
        autocomplete: 'off',
        onsubmit: async (event) => {
          event.preventDefault();
          for (const item of Object.values(fields)) item.setError('');
          message.hidden = true;

          Object.assign(draft, {
            studentId: studentId.input.value,
            name: name.input.value,
            url: url.input.value,
            note: note.input.value,
            password: passwordInput.value,
          });
          const { value, errors } = validateSubmission(draft);
          if (errors) {
            showErrors(errors);
            return;
          }

          submit.disabled = true;
          submit.textContent = '제출하는 중…';
          try {
            const result = await api('POST', `${endpoint}/submissions`, value);
            remember({ studentId: value.studentId, name: value.name });
            Object.assign(draft, value);
            showReceipt(result.submission, result.status);
          } catch (error) {
            if (error.code === 'closed') {
              assignment.state = 'closed';
              showClosed();
            } else if (error.fields) {
              showErrors(error.fields);
            } else {
              message.textContent = error.message;
              message.hidden = false;
            }
          } finally {
            submit.disabled = false;
            submit.textContent = '제출하기';
          }
        },
      },
      assignment.state === 'late'
        ? h('p', { class: 'notice notice-late', role: 'status' }, '마감 시간이 지났습니다. 지금 내거나 고치면 "지각"으로 표시됩니다.')
        : null,
      h('div', { class: 'field-row' }, studentId.wrap, name.wrap),
      url.wrap,
      note.wrap,
      password.wrap,
      message,
      submit,
    );

    function showErrors(errors) {
      let first = null;
      for (const [key, text] of Object.entries(errors)) {
        if (!fields[key]) continue;
        fields[key].setError(text);
        first ??= fields[key].input;
      }
      first?.focus();
    }

    stage.replaceChildren(form, lookupBlock(false));
  }

  // 이미 낸 학생이 학번과 비밀번호로 자기 제출을 다시 확인합니다.
  function lookupBlock(open) {
    const studentId = field({
      id: 'lookupStudentId',
      label: '학번',
      control: h('input', {
        class: 'input',
        id: 'lookupStudentId',
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
        maxlength: LIMITS.studentId,
        value: draft.studentId,
      }),
    });
    const password = field({
      id: 'lookupPassword',
      label: '수정용 비밀번호',
      control: h('input', { class: 'input', id: 'lookupPassword', type: 'password', autocomplete: 'off', maxlength: LIMITS.passwordMax }),
    });
    const message = h('p', { class: 'form-message', role: 'alert', hidden: true });
    const button = h('button', { class: 'button button-secondary', type: 'submit' }, '제출 내용 보기');

    const form = h(
      'form',
      {
        class: 'lookup-form',
        novalidate: true,
        autocomplete: 'off',
        onsubmit: async (event) => {
          event.preventDefault();
          studentId.setError('');
          password.setError('');
          message.hidden = true;

          const id = normalizeStudentId(studentId.input.value);
          const idError = checkStudentId(id);
          if (idError) {
            studentId.setError(idError);
            studentId.input.focus();
            return;
          }
          if (!password.input.value) {
            password.setError('비밀번호를 입력하세요.');
            password.input.focus();
            return;
          }

          button.disabled = true;
          try {
            const result = await api('POST', `${endpoint}/lookup`, { studentId: id, password: password.input.value });
            const found = result.submission;
            Object.assign(draft, { studentId: found.studentId, name: found.name, url: found.url, note: found.note, password: password.input.value });
            showReceipt(found, 'found');
          } catch (error) {
            if (error.fields?.password) password.setError(error.fields.password);
            else if (error.fields?.studentId) studentId.setError(error.fields.studentId);
            else {
              message.textContent = error.message;
              message.hidden = false;
            }
          } finally {
            button.disabled = false;
          }
        },
      },
      h('div', { class: 'field-row' }, studentId.wrap, password.wrap),
      message,
      button,
    );

    return h('details', { class: 'lookup', open }, h('summary', {}, '이미 냈나요? 제출 내용 확인하기'), form);
  }

  function showReceipt(submission, status) {
    const headline = {
      created: '제출이 접수되었습니다',
      updated: '새 내용으로 바꿨습니다',
      unchanged: '이미 같은 내용으로 제출되어 있습니다',
      found: '제출한 내용입니다',
    }[status];

    const title = h('h2', { class: 'receipt-title', tabindex: '-1' }, headline);
    const editable = assignment.state !== 'closed';

    stage.replaceChildren(
      h(
        'section',
        { class: 'card receipt', 'aria-label': '접수증' },
        h(
          'div',
          { class: 'receipt-head' },
          h('div', {}, h('p', { class: 'receipt-kicker' }, '접수증'), title, h('p', { class: 'receipt-assignment' }, assignment.title)),
          h('p', { class: `stamp${status === 'found' || status === 'unchanged' ? '' : ' stamp-fresh'}`, 'aria-hidden': 'true' }, h('span', {}, '제출'), h('span', {}, '완료')),
        ),
        h(
          'dl',
          { class: 'receipt-rows' },
          h('dt', {}, '학번'),
          h('dd', { class: 'tabular' }, submission.studentId),
          h('dt', {}, '이름'),
          h('dd', {}, submission.name),
          h('dt', {}, '링크'),
          h('dd', {}, externalLink(submission.url, submission.url, 'receipt-link')),
          submission.note ? [h('dt', {}, '메모'), h('dd', { class: 'receipt-note' }, submission.note)] : null,
          h('dt', {}, '제출 시각'),
          h(
            'dd',
            {},
            formatDateTime(submission.updatedAt),
            submission.revision > 1 ? h('span', { class: 'muted' }, ` · ${submission.revision}번째 제출`) : null,
            submission.isLate ? h('span', { class: 'chip chip-late' }, '지각') : null,
          ),
        ),
        h(
          'p',
          { class: 'receipt-advice' },
          '위 링크를 눌러 잘 열리는지 꼭 확인하세요.',
          editable ? ' 고치려면 같은 학번과 비밀번호로 다시 제출하면 됩니다.' : '',
        ),
        h(
          'div',
          { class: 'receipt-actions' },
          h('a', { class: 'button button-secondary', href: submission.url, target: '_blank', rel: 'noopener noreferrer' }, '링크 열어 보기'),
          editable ? h('button', { class: 'button button-ghost', type: 'button', onclick: showForm }, '링크 고치기') : null,
        ),
      ),
    );
    title.focus();
  }
}

async function start() {
  let site;
  try {
    site = await api('GET', '/api/site');
  } catch (error) {
    app.replaceChildren(
      h('div', { class: 'problem' }, h('h1', { class: 'page-title' }, '페이지를 불러오지 못했습니다'), h('p', {}, error.message), h('button', { class: 'button button-secondary', type: 'button', onclick: () => location.reload() }, '다시 불러오기')),
    );
    return;
  }

  if (!slug) {
    showList(site);
    return;
  }
  const assignment = site.assignments.find((item) => item.slug === slug);
  if (!assignment) {
    showProblem('과제를 찾을 수 없습니다', '주소가 잘못되었거나 선생님이 과제를 지웠을 수 있습니다.');
    return;
  }
  showAssignment(site, assignment);
}

start();

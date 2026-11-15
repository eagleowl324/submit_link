// 학생 화면: 과제 목록(/)과 과제별 제출 화면(/a/주소)

import { api, dueBadge, dueText, externalLink, field, fill, formatDateTime, h, richText, sendBytes } from './ui.js';
import {
  LIMITS,
  checkFile,
  checkStudentId,
  formatBytes,
  normalizeFileName,
  normalizeName,
  normalizeStudentId,
  validateSubmission,
} from './shared/rules.js';

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

// 조각 하나를 보냅니다. 연결이 잠깐 끊겼거나 서버가 바빴다면 두 번까지 다시 보냅니다.
async function putChunk(path, part, token) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sendBytes('PUT', path, part, { 'X-Upload-Token': token });
      return;
    } catch (error) {
      const worthRetrying = error.status === 0 || error.status === 429 || error.status >= 500;
      if (!worthRetrying || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
}

function cancelUpload(upload) {
  // 실패해도 서버가 한 시간 뒤에 스스로 지우므로 결과를 기다리지 않습니다.
  api('DELETE', `/api/uploads/${upload.uploadId}`, undefined, { 'X-Upload-Token': upload.token }).catch(() => {});
}

// 파일을 조각으로 나눠 올립니다. (한 번에 보낼 수 있는 크기에 한도가 있는 서버에서도 큰 파일을 올릴 수 있게)
// 다 올리면 제출에 실어 보낼 { uploadId, token } 을 돌려줍니다. onProgress 는 0~1 사이 값으로 불립니다.
async function uploadFile(endpoint, blob, onProgress) {
  onProgress(0);
  const { uploadId, token, chunkSize, chunks } = await api('POST', `${endpoint}/uploads`, { name: blob.name, size: blob.size });
  let next = 0;
  let sent = 0;
  let failed = false;
  async function worker() {
    while (next < chunks && !failed) {
      const seq = next;
      next += 1;
      const part = blob.slice(seq * chunkSize, (seq + 1) * chunkSize);
      await putChunk(`/api/uploads/${uploadId}/chunks/${seq}`, part, token);
      sent += part.size;
      onProgress(sent / blob.size);
    }
  }
  try {
    // 세 조각씩 동시에 보냅니다.
    await Promise.all(Array.from({ length: Math.min(3, chunks) }, worker));
  } catch (error) {
    failed = true;
    cancelUpload({ uploadId, token });
    throw error;
  }
  return { uploadId, token };
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
  fill(
    app,
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

  fill(app, siteHead(site, false), h('h1', { class: 'page-title' }, '제출할 과제를 고르세요'), list);
}

function showAssignment(site, assignment) {
  document.title = `${assignment.title} · ${site.title}`;

  // 학번을 꼭 받지 않는 과제에서는 학번을 비워 두고 낼 수 있고, 그런 제출은 이름으로 구분합니다.
  const idOptional = assignment.requireStudentId === false;
  // 파일을 받는 과제에서는 링크 대신, 또는 링크와 함께 파일 하나를 낼 수 있습니다.
  const allowFiles = assignment.allowFiles === true;

  const stage = h('div', { class: 'stage' });
  fill(
    app,
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
  // draft.file: 없으면 null. 이미 낸 파일은 { name, size }, 이번에 고른 파일은 { name, size, blob, upload } 이고
  // upload 는 다 올린 뒤에 받는 { uploadId, token } 입니다(올리기 전에는 null).
  const draft = { studentId: me.studentId, name: me.name, url: '', note: '', password: '', file: null };
  const endpoint = `/api/assignments/${assignment.slug}`;

  if (assignment.state === 'closed') showClosed();
  else showForm();

  function showClosed() {
    fill(
      stage,
      h('p', { class: 'notice notice-closed', role: 'status' }, '제출이 마감되었습니다. 새로 내거나 고칠 수 없습니다.'),
      lookupBlock(true),
    );
  }

  function showForm() {
    const studentId = field({
      id: 'studentId',
      label: '학번',
      optional: idOptional,
      hint: idOptional ? '없으면 비워 두세요.' : null,
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
    // 파일 고르기. 이미 낸 파일이나 방금 고른 파일의 이름을 보여 주고, 빼거나 다른 파일로 바꿀 수 있습니다.
    const fileInput = h('input', { class: 'offscreen', type: 'file', tabindex: '-1', 'aria-hidden': 'true' });
    const pick = h('button', { class: 'button button-secondary button-small', type: 'button', id: 'file', onclick: () => fileInput.click() });
    const chosen = h('p', { class: 'file-chosen' });
    const file = field({
      id: 'file',
      label: '파일 첨부',
      optional: true,
      hint: `링크 대신 파일만 내도 됩니다. 파일은 한 개, ${formatBytes(site.maxFileBytes)}까지 올릴 수 있습니다.`,
      control: pick,
    });
    const picker = h('div', { class: 'file-picker' });
    pick.replaceWith(picker);
    picker.append(chosen, pick, fileInput);

    function showFile() {
      fill(
        chosen,
        draft.file
          ? [
              h('span', { class: 'file-name' }, draft.file.name),
              h('span', { class: 'file-size' }, formatBytes(draft.file.size)),
              h(
                'button',
                {
                  class: 'text-button',
                  type: 'button',
                  onclick: () => {
                    setFile(null);
                    pick.focus();
                  },
                },
                '빼기',
              ),
            ]
          : null,
      );
      chosen.hidden = !draft.file;
      pick.textContent = draft.file ? '다른 파일 고르기' : '파일 고르기';
    }

    function setFile(next) {
      if (draft.file?.upload) cancelUpload(draft.file.upload);
      draft.file = next;
      file.setError((next?.blob && checkFile(normalizeFileName(next.name), next.size, site.maxFileBytes)) || '');
      showFile();
    }

    fileInput.addEventListener('change', () => {
      const picked = fileInput.files[0];
      // 같은 파일을 다시 골라도 알 수 있게 비워 둡니다.
      fileInput.value = '';
      if (picked) setFile({ name: picked.name, size: picked.size, blob: picked, upload: null });
    });
    showFile();

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
      hint: `나중에 제출한 내용을 고치거나 확인할 때 씁니다. ${LIMITS.passwordMin}자 이상, 평소 쓰는 비밀번호 말고 이 과제용으로 정하세요.`,
      control: passwordInput,
    });
    // 입력 칸 옆에 [보기] 버튼을 붙입니다.
    const passwordRow = h('div', { class: 'with-button' });
    passwordInput.replaceWith(passwordRow);
    passwordRow.append(passwordInput, reveal);

    const fields = { studentId, name, url, ...(allowFiles ? { file } : {}), note, password };
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
          // 파일을 첨부했으면 링크는 비워 둘 수 있습니다.
          const { value, errors } = validateSubmission(draft, { requireStudentId: !idOptional, urlOptional: Boolean(draft.file) });
          const problems = { ...errors };
          if (allowFiles && problems.url && !draft.url.trim()) problems.url = '과제 링크를 입력하거나 파일을 첨부하세요.';
          const fileProblem = draft.file?.blob && checkFile(normalizeFileName(draft.file.name), draft.file.size, site.maxFileBytes);
          if (fileProblem) problems.file = fileProblem;
          if (Object.keys(problems).length) {
            showErrors(problems);
            return;
          }

          submit.disabled = true;
          let uploading = false;
          try {
            // 이번에 고른 파일은 먼저 올립니다. 제출이 거절되어 다시 누를 때는 이미 올린 것을 그대로 씁니다.
            const picked = draft.file?.blob ? draft.file : null;
            if (picked && !picked.upload) {
              uploading = true;
              picked.upload = await uploadFile(endpoint, picked.blob, (ratio) => {
                submit.textContent = `파일 올리는 중… ${Math.floor(ratio * 100)}%`;
              });
              uploading = false;
            }

            submit.textContent = '제출하는 중…';
            // 파일: 이번에 고른 것은 올린 번호를 싣고, 이미 낸 것을 그대로 둘 때는 아무것도 싣지 않고, 뺐으면 null 을 보냅니다.
            const payload = { ...value };
            if (picked) payload.file = picked.upload;
            else if (allowFiles && !draft.file) payload.file = null;
            const result = await api('POST', `${endpoint}/submissions`, payload);
            // 학번 없이 냈을 때는 전에 기억해 둔 학번을 지우지 않습니다.
            remember({ studentId: value.studentId || recall().studentId, name: value.name });
            Object.assign(draft, value, { file: result.submission.file });
            showReceipt(result.submission, result.status);
          } catch (error) {
            if (error.code === 'closed') {
              assignment.state = 'closed';
              showClosed();
            } else if (uploading) {
              file.setError(error.fields?.file || `파일을 올리지 못했습니다. ${error.message}`);
              pick.focus();
            } else if (error.fields) {
              // 올려 둔 파일을 서버가 찾지 못하면(시간이 지나 지워진 경우) 다음에 다시 올립니다.
              if (error.fields.file && draft.file?.blob) draft.file.upload = null;
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
      allowFiles ? file.wrap : null,
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

    fill(stage, form, lookupBlock(false));
  }

  // 이미 낸 학생이 학번과 비밀번호로 자기 제출을 다시 확인합니다.
  // 학번을 꼭 받지 않는 과제에서는 학번 없이 낸 사람이 이름으로 찾을 수 있게 한 칸에서 둘 다 받습니다.
  function lookupBlock(open) {
    const studentId = field({
      id: 'lookupStudentId',
      label: idOptional ? '학번 또는 이름' : '학번',
      hint: idOptional ? '낼 때 학번을 적었으면 학번, 비워 두었으면 이름을 입력하세요.' : null,
      control: h('input', {
        class: 'input',
        id: 'lookupStudentId',
        autocomplete: 'off',
        autocapitalize: idOptional ? 'off' : 'characters',
        spellcheck: 'false',
        maxlength: idOptional ? LIMITS.name : LIMITS.studentId,
        value: draft.studentId || (idOptional ? draft.name : ''),
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

          // 서버는 학번으로 먼저 찾고, 없으면(학번을 꼭 받지 않는 과제에서) 이름으로 찾습니다.
          const who = idOptional ? normalizeName(studentId.input.value) : normalizeStudentId(studentId.input.value);
          const whoError = idOptional ? (who ? null : '학번이나 이름을 입력하세요.') : checkStudentId(who);
          if (whoError) {
            studentId.setError(whoError);
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
            const result = await api('POST', `${endpoint}/lookup`, {
              studentId: who,
              ...(idOptional ? { name: who } : {}),
              password: password.input.value,
            });
            const found = result.submission;
            Object.assign(draft, {
              studentId: found.studentId,
              name: found.name,
              url: found.url,
              note: found.note,
              password: password.input.value,
              file: found.file,
            });
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

    fill(
      stage,
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
          submission.studentId ? [h('dt', {}, '학번'), h('dd', { class: 'tabular' }, submission.studentId)] : null,
          h('dt', {}, '이름'),
          h('dd', {}, submission.name),
          submission.url ? [h('dt', {}, '링크'), h('dd', {}, externalLink(submission.url, submission.url, 'receipt-link'))] : null,
          submission.file
            ? [h('dt', {}, '파일'), h('dd', {}, submission.file.name, h('span', { class: 'muted' }, ` · ${formatBytes(submission.file.size)}`))]
            : null,
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
          submission.url ? '위 링크를 눌러 잘 열리는지 꼭 확인하세요.' : '파일이 선생님께 전달되었습니다.',
          editable ? ` 고치려면 같은 ${submission.studentId ? '학번' : '이름'}과 비밀번호로 다시 제출하면 됩니다.` : '',
        ),
        h(
          'div',
          { class: 'receipt-actions' },
          submission.url
            ? h('a', { class: 'button button-secondary', href: submission.url, target: '_blank', rel: 'noopener noreferrer' }, '링크 열어 보기')
            : null,
          editable ? h('button', { class: 'button button-ghost', type: 'button', onclick: showForm }, '제출 내용 고치기') : null,
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
    fill(
      app,
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

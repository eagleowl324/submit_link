// 저장소. 과제·제출·명단·설정·로그인 세션을 SQLite 에 넣고 꺼냅니다.
//
// SQLite 를 직접 열지 않고 driver 를 통해서만 접근합니다. driver 는 두 종류입니다.
//
//   바로 답하는 것 (sync: true)    파일 SQLite. src/node.js
//   기다려야 하는 것 (sync: false) 네트워크 너머의 데이터베이스. src/libsql.js (Vercel)
//
// 두 종류가 같은 로직을 쓰도록, 저장소의 동작은 "단계"(제너레이터 함수)로 적습니다.
// `yield get(...)` 처럼 질의를 내놓으면 실행 결과가 그 자리로 돌아옵니다.
// 바로 답하는 driver 에서는 단계 전체가 한 번에 끝나서 값이 그대로 나오고,
// 기다려야 하는 driver 에서는 질의마다 기다린 뒤 Promise 로 나옵니다. 그래서 부르는 쪽은 항상 await 합니다.
//
// driver 가 갖출 것:
//   sync                   위의 두 종류 중 어느 쪽인지
//   get(sql, ...params)    첫 줄 또는 undefined
//   all(sql, ...params)    모든 줄
//   run(sql, ...params)    결과가 필요 없는 실행
//   exec(sql)              여러 문장을 한꺼번에 실행 (스키마 만들기)
//   transaction(work)      work(tx) 를 한 묶음으로 실행하고, 예외가 나면 되돌림. tx 도 get/all/run/exec 를 가짐
//   close()                (선택) 닫기

import { Buffer } from 'node:buffer';

const get = (sql, ...params) => ({ method: 'get', sql, params });
const all = (sql, ...params) => ({ method: 'all', sql, params });
const run = (sql, ...params) => ({ method: 'run', sql, params });
const exec = (sql) => ({ method: 'exec', sql, params: [] });

// 스키마를 바꿀 때는 기존 항목을 고치지 말고 배열 끝에 새 단계를 추가합니다.
// 첫 단계는 이미 표가 있어도 안전하게(IF NOT EXISTS) 써서, 예전 버전이 만든 데이터 파일도 그대로 이어 씁니다.
const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_at      TEXT,
    allow_late  INTEGER NOT NULL DEFAULT 1,
    is_open     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );

  -- 학생 한 명당 과제 하나에 한 줄. 링크를 바꿔 다시 제출하면 이 줄을 고치고 이전 내용은 submission_history 로 옮깁니다.
  CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id    TEXT NOT NULL,
    student_name  TEXT NOT NULL,
    url           TEXT NOT NULL,
    note          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    revision      INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (assignment_id, student_id)
  );

  CREATE TABLE IF NOT EXISTS submission_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    student_name  TEXT NOT NULL,
    url           TEXT NOT NULL,
    note          TEXT NOT NULL,
    submitted_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS submission_history_by_submission ON submission_history (submission_id);

  CREATE TABLE IF NOT EXISTS roster (
    student_id TEXT PRIMARY KEY,
    name       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- 비밀번호를 틀린 횟수 같은 기록. 프로그램이 수시로 내려갔다 올라오는 실행 환경에서 씁니다.
  CREATE TABLE IF NOT EXISTS rate_limits (
    key      TEXT PRIMARY KEY,
    count    INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )
  `,

  // 과제마다 학번을 꼭 받을지 정합니다. 이전에 만든 과제는 지금까지처럼 학번을 받습니다.
  // 학번 없이 낸 제출은 submissions.student_id 에 "~이름" 을 넣어 구분합니다(src/app.js 의 submissionKey).
  'ALTER TABLE assignments ADD COLUMN require_student_id INTEGER NOT NULL DEFAULT 1',

  // 첨부 파일. 이전에 만든 과제도 파일을 받습니다(과제마다 끌 수 있음).
  `
  ALTER TABLE assignments ADD COLUMN allow_files INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE submission_history ADD COLUMN file_name TEXT NOT NULL DEFAULT '';

  -- 학생이 올린 파일 하나. 다 올라온 뒤 제출에 붙으면 submission_id 가 채워집니다.
  -- 올리는 중이거나 아직 제출하지 않은 파일은 submission_id 가 NULL 이고, 한동안 그대로면 지웁니다.
  CREATE TABLE files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL,
    submission_id INTEGER,
    name          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    chunks        INTEGER NOT NULL,
    token_hash    TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX files_by_submission ON files (submission_id);
  CREATE INDEX files_by_assignment ON files (assignment_id);

  -- 파일 내용. 요청 하나에 실을 수 있는 크기에 한도가 있는 실행 환경(Vercel)에서도 큰 파일을 받을 수 있게 조각으로 나눠 넣습니다.
  CREATE TABLE file_chunks (
    file_id INTEGER NOT NULL,
    seq     INTEGER NOT NULL,
    data    BLOB NOT NULL,
    PRIMARY KEY (file_id, seq)
  )
  `,
];

// 제출 한 줄을 첨부 파일 정보와 함께 읽습니다. 파일은 제출 하나에 하나까지입니다.
const SUBMISSION_COLUMNS = 's.*, f.id AS file_id, f.name AS file_name, f.size AS file_size, f.chunks AS file_chunks';
const SUBMISSION_FROM = 'submissions s LEFT JOIN files f ON f.submission_id = s.id';

// 모든 시각은 UTC ISO 문자열(2026-11-15T05:03:00.000Z)로 저장해서 문자열 비교가 곧 시간 비교가 됩니다.
export class Store {
  #db;

  constructor(driver) {
    this.#db = driver;
  }

  close() {
    return this.#db.close?.();
  }

  // 단계를 끝까지 실행합니다. target 은 driver 이거나, 트랜잭션 안에서는 그 트랜잭션입니다.
  #drive(steps, target) {
    if (this.#db.sync) {
      let step = steps.next();
      while (!step.done) step = steps.next(target[step.value.method](step.value.sql, ...step.value.params));
      return step.value;
    }
    return (async () => {
      let step = steps.next();
      while (!step.done) step = steps.next(await target[step.value.method](step.value.sql, ...step.value.params));
      return step.value;
    })();
  }

  #run(steps) {
    return this.#drive(steps, this.#db);
  }

  // 단계 전체를 한 묶음(트랜잭션)으로 실행합니다. 중간에 다른 요청이 끼어들지 못합니다.
  #atomic(makeSteps) {
    return this.#db.transaction((tx) => this.#drive(makeSteps(), tx));
  }

  // 표를 준비합니다. 서비스를 시작할 때 한 번 부릅니다.
  ready() {
    return this.#atomic(() => this.#migrate());
  }

  *#migrate() {
    yield exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const current = Number((yield* this.#getSetting('schema_version')) ?? 0);
    if (current > MIGRATIONS.length) {
      throw new Error('데이터가 이 프로그램보다 새로운 버전에서 만들어졌습니다. 프로그램을 최신 버전으로 바꿔 주세요.');
    }
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      yield exec(MIGRATIONS[version]);
      yield* this.#setSetting('schema_version', String(version + 1));
    }
  }

  // ── 설정 ──

  *#getSetting(key) {
    const row = yield get('SELECT value FROM settings WHERE key = ?', key);
    return row?.value ?? null;
  }

  *#setSetting(key, value) {
    yield run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  // 아직 값이 없을 때만 저장하고, 저장했으면 true. 확인과 저장이 한 문장이라 여러 요청이 동시에 와도 하나만 성공합니다.
  *#claimSetting(key, value) {
    const row = yield get('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING RETURNING key', key, value);
    return Boolean(row);
  }

  getSetting(key) {
    return this.#run(this.#getSetting(key));
  }

  setSetting(key, value) {
    return this.#run(this.#setSetting(key, value));
  }

  claimSetting(key, value) {
    return this.#run(this.#claimSetting(key, value));
  }

  // ── 과제 ──

  *#getAssignment(id) {
    return (yield get('SELECT * FROM assignments WHERE id = ?', id)) ?? null;
  }

  *#getAssignmentBySlug(slug) {
    return (yield get('SELECT * FROM assignments WHERE slug = ?', slug)) ?? null;
  }

  *#createAssignment({ slug, title, description, dueAt, allowLate, isOpen, requireStudentId, allowFiles, createdAt }) {
    yield run(
      `INSERT INTO assignments (slug, title, description, due_at, allow_late, is_open, require_student_id, allow_files, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      slug,
      title,
      description,
      dueAt,
      allowLate ? 1 : 0,
      isOpen ? 1 : 0,
      requireStudentId ? 1 : 0,
      allowFiles ? 1 : 0,
      createdAt,
    );
    return yield* this.#getAssignmentBySlug(slug);
  }

  *#updateAssignment(id, { title, description, dueAt, allowLate, isOpen, requireStudentId, allowFiles }) {
    yield run(
      'UPDATE assignments SET title = ?, description = ?, due_at = ?, allow_late = ?, is_open = ?, require_student_id = ?, allow_files = ? WHERE id = ?',
      title,
      description,
      dueAt,
      allowLate ? 1 : 0,
      isOpen ? 1 : 0,
      requireStudentId ? 1 : 0,
      allowFiles ? 1 : 0,
      id,
    );
    return yield* this.#getAssignment(id);
  }

  // 과제와 딸린 기록을 지우고, 내용을 따로 지워야 하는 파일들의 번호를 돌려줍니다. 과제가 없으면 null.
  *#deleteAssignment(id) {
    if (!(yield* this.#getAssignment(id))) return null;
    const files = yield all('SELECT id FROM files WHERE assignment_id = ?', id);
    yield run('DELETE FROM submission_history WHERE submission_id IN (SELECT id FROM submissions WHERE assignment_id = ?)', id);
    yield run('DELETE FROM submissions WHERE assignment_id = ?', id);
    yield run('DELETE FROM files WHERE assignment_id = ?', id);
    yield run('DELETE FROM assignments WHERE id = ?', id);
    return files.map((file) => file.id);
  }

  listAssignments() {
    return this.#run(
      (function* list() {
        return yield all('SELECT * FROM assignments ORDER BY created_at DESC, id DESC');
      })(),
    );
  }

  getAssignment(id) {
    return this.#run(this.#getAssignment(id));
  }

  getAssignmentBySlug(slug) {
    return this.#run(this.#getAssignmentBySlug(slug));
  }

  createAssignment(fields) {
    return this.#run(this.#createAssignment(fields));
  }

  updateAssignment(id, fields) {
    return this.#run(this.#updateAssignment(id, fields));
  }

  // 과제와 그 과제의 제출·이전 링크 기록·첨부 파일을 함께 지웁니다. 지웠으면 true.
  // 파일 내용은 양이 많을 수 있어서 한 묶음에 넣지 않고 파일 하나씩 지웁니다.
  // 도중에 멈춰서 남은 조각은 sweepOrphanChunks 가 나중에 치웁니다.
  async deleteAssignment(id) {
    const fileIds = await this.#atomic(() => this.#deleteAssignment(id));
    if (fileIds === null) return false;
    for (const fileId of fileIds) await this.#run(this.#deleteChunks(fileId));
    return true;
  }

  // 과제별 제출 수와 지각 수. 지각 여부는 저장하지 않고 마감 일시와 비교해서 구하므로, 마감을 늦추면 바로 반영됩니다.
  submissionStats() {
    return this.#run(
      (function* stats() {
        return yield all(`
          SELECT s.assignment_id AS assignment_id,
                 COUNT(*) AS total,
                 SUM(CASE WHEN a.due_at IS NOT NULL AND s.updated_at > a.due_at THEN 1 ELSE 0 END) AS late
            FROM submissions s JOIN assignments a ON a.id = s.assignment_id
           GROUP BY s.assignment_id
        `);
      })(),
    );
  }

  // ── 제출 ──

  *#getSubmission(assignmentId, studentId) {
    const row = yield get(`SELECT ${SUBMISSION_COLUMNS} FROM ${SUBMISSION_FROM} WHERE s.assignment_id = ? AND s.student_id = ?`, assignmentId, studentId);
    return row ?? null;
  }

  *#getSubmissionById(id) {
    return (yield get(`SELECT ${SUBMISSION_COLUMNS} FROM ${SUBMISSION_FROM} WHERE s.id = ?`, id)) ?? null;
  }

  // file: { action: 'keep' } 그대로 둠 | { action: 'remove' } 첨부를 뺌 | { action: 'attach', fileId } 다 올린 파일을 붙임(있던 파일은 지움)
  *#saveSubmission({ assignmentId, studentId, name, url, note, passwordHash, expectedHash, at, maxSubmissions, maxLinkChanges, file = { action: 'keep' } }) {
    if (!(yield* this.#getAssignment(assignmentId))) return { status: 'gone' };
    const current = yield* this.#getSubmission(assignmentId, studentId);
    if ((current ? current.password_hash : null) !== expectedHash) return { status: 'conflict' };

    // 붙일 파일은 이 과제에 올린 것이고, 조각이 모두 와 있고, 아직 어느 제출에도 붙지 않았어야 합니다.
    if (file.action === 'attach') {
      const upload = yield get('SELECT chunks FROM files WHERE id = ? AND assignment_id = ? AND submission_id IS NULL', file.fileId, assignmentId);
      if (!upload || (yield* this.#countChunks(file.fileId)) !== upload.chunks) return { status: 'file_gone' };
    }
    const hadFile = Boolean(current && current.file_id);
    const fileChanged = file.action === 'attach' || (file.action === 'remove' && hadFile);
    // 링크와 파일 가운데 하나는 있어야 합니다.
    if (!url && !(file.action === 'attach' || (file.action === 'keep' && hadFile))) return { status: 'empty' };

    if (!current) {
      const { count } = yield get('SELECT COUNT(*) AS count FROM submissions WHERE assignment_id = ?', assignmentId);
      if (count >= maxSubmissions) return { status: 'full' };
      yield run(
        'INSERT INTO submissions (assignment_id, student_id, student_name, url, note, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        assignmentId,
        studentId,
        name,
        url,
        note,
        passwordHash,
        at,
        at,
      );
      if (file.action === 'attach') {
        const created = yield* this.#getSubmission(assignmentId, studentId);
        yield run('UPDATE files SET submission_id = ? WHERE id = ?', created.id, file.fileId);
      }
      return { status: 'created', row: yield* this.#getSubmission(assignmentId, studentId) };
    }

    // 제출 시각과 지각 여부는 링크와 파일을 기준으로 합니다. 둘 다 그대로면 시각을 건드리지 않으므로,
    // 마감 뒤에 같은 내용을 다시 내거나 이름·메모만 고쳐도 지각이 되지 않습니다.
    if (current.url === url && !fileChanged) {
      const edited = current.student_name !== name || current.note !== note;
      if (edited || current.password_hash !== passwordHash) {
        yield run('UPDATE submissions SET student_name = ?, note = ?, password_hash = ? WHERE id = ?', name, note, passwordHash, current.id);
      }
      return { status: edited ? 'updated' : 'unchanged', row: yield* this.#getSubmission(assignmentId, studentId) };
    }

    // revision 은 1에서 시작하므로 링크나 파일을 바꾼 횟수는 revision - 1 입니다.
    if (current.revision - 1 >= maxLinkChanges) return { status: 'too_many_changes' };

    // 이전 파일은 이름만 기록에 남기고 내용은 지웁니다.
    yield run(
      'INSERT INTO submission_history (submission_id, student_name, url, note, file_name, submitted_at) VALUES (?, ?, ?, ?, ?, ?)',
      current.id,
      current.student_name,
      current.url,
      current.note,
      current.file_name ?? '',
      current.updated_at,
    );
    yield run(
      'UPDATE submissions SET student_name = ?, url = ?, note = ?, password_hash = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      name,
      url,
      note,
      passwordHash,
      at,
      current.id,
    );
    if (fileChanged) {
      if (hadFile) {
        yield run('DELETE FROM files WHERE id = ?', current.file_id);
        yield* this.#deleteChunks(current.file_id);
      }
      if (file.action === 'attach') yield run('UPDATE files SET submission_id = ? WHERE id = ?', current.id, file.fileId);
    }
    return { status: 'updated', row: yield* this.#getSubmission(assignmentId, studentId) };
  }

  *#deleteSubmission(id) {
    if (!(yield* this.#getSubmissionById(id))) return false;
    for (const file of yield all('SELECT id FROM files WHERE submission_id = ?', id)) {
      yield run('DELETE FROM files WHERE id = ?', file.id);
      yield* this.#deleteChunks(file.id);
    }
    yield run('DELETE FROM submission_history WHERE submission_id = ?', id);
    yield run('DELETE FROM submissions WHERE id = ?', id);
    return true;
  }

  getSubmission(assignmentId, studentId) {
    return this.#run(this.#getSubmission(assignmentId, studentId));
  }

  getSubmissionById(id) {
    return this.#run(this.#getSubmissionById(id));
  }

  // 새 제출을 저장하거나 기존 제출을 고칩니다.
  // expectedHash 는 호출한 쪽이 비밀번호를 확인할 때 본 값입니다(제출이 없었다면 null).
  // 확인과 저장 사이에 다른 요청이 끼어들었다면 'conflict' 를 돌려줍니다.
  // maxSubmissions(과제 하나가 받는 제출 수)와 maxLinkChanges(한 학생이 링크를 바꿀 수 있는 횟수)는
  // 누군가 제출을 끝없이 쌓아 저장 공간과 관리 화면을 망가뜨리는 것을 막는 한도입니다.
  saveSubmission(fields) {
    return this.#atomic(() => this.#saveSubmission(fields));
  }

  listSubmissions(assignmentId) {
    return this.#run(
      (function* list() {
        return yield all(
          `
          SELECT ${SUBMISSION_COLUMNS}, r.name AS roster_name
            FROM ${SUBMISSION_FROM} LEFT JOIN roster r ON r.student_id = s.student_id
           WHERE s.assignment_id = ?
           ORDER BY s.student_id
          `,
          assignmentId,
        );
      })(),
    );
  }

  getSubmissionDetail(id) {
    return this.#run(
      (function* detail() {
        const row = yield get(
          `
          SELECT ${SUBMISSION_COLUMNS}, r.name AS roster_name
            FROM ${SUBMISSION_FROM} LEFT JOIN roster r ON r.student_id = s.student_id
           WHERE s.id = ?
          `,
          id,
        );
        return row ?? null;
      })(),
    );
  }

  // 한 제출의 이전 링크들. 최근 것부터. 링크를 바꿀 수 있는 횟수에 한도가 있으므로 줄 수도 그만큼만 됩니다.
  listHistory(submissionId) {
    return this.#run(
      (function* history() {
        return yield all('SELECT * FROM submission_history WHERE submission_id = ? ORDER BY submitted_at DESC, id DESC', submissionId);
      })(),
    );
  }

  deleteSubmission(id) {
    return this.#atomic(() => this.#deleteSubmission(id));
  }

  // 비밀번호를 비우면 그 학번으로 다음에 제출하는 사람이 새 비밀번호를 정합니다.
  clearSubmissionPassword(id) {
    return this.#run(
      (function* clear() {
        yield run("UPDATE submissions SET password_hash = '' WHERE id = ?", id);
      })(),
    );
  }

  // ── 첨부 파일 ──

  *#countChunks(fileId) {
    return (yield get('SELECT COUNT(*) AS count FROM file_chunks WHERE file_id = ?', fileId)).count;
  }

  *#deleteChunks(fileId) {
    yield run('DELETE FROM file_chunks WHERE file_id = ?', fileId);
  }

  // 아직 제출에 붙지 않은 파일을 지웁니다. 그사이 제출에 붙었다면 건드리지 않습니다.
  *#discardUpload(id) {
    const gone = yield get('DELETE FROM files WHERE id = ? AND submission_id IS NULL RETURNING id', id);
    if (gone) yield* this.#deleteChunks(id);
    return Boolean(gone);
  }

  // 올릴 자리를 만들고 번호를 돌려줍니다. 받은 파일의 합이 storageLimit(바이트)를 넘게 되면 만들지 않고 null.
  // 확인과 만들기가 한 묶음이라 동시에 여러 명이 올려도 한도를 넘지 않습니다.
  createUpload({ assignmentId, name, size, chunks, tokenHash, createdAt, storageLimit }) {
    return this.#atomic(function* create() {
      const { total } = yield get('SELECT COALESCE(SUM(size), 0) AS total FROM files');
      if (total + size > storageLimit) return null;
      const row = yield get(
        'INSERT INTO files (assignment_id, name, size, chunks, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        assignmentId,
        name,
        size,
        chunks,
        tokenHash,
        createdAt,
      );
      return row.id;
    });
  }

  getFile(id) {
    return this.#run(
      (function* find() {
        return (yield get('SELECT * FROM files WHERE id = ?', id)) ?? null;
      })(),
    );
  }

  // 조각 하나를 넣습니다. 같은 조각을 다시 보내면(응답을 못 받고 다시 시도한 경우) 처음 것을 그대로 둡니다.
  putChunk(fileId, seq, data) {
    return this.#run(
      (function* put() {
        yield run('INSERT OR IGNORE INTO file_chunks (file_id, seq, data) VALUES (?, ?, ?)', fileId, seq, data);
      })(),
    );
  }

  countChunks(fileId) {
    return this.#run(this.#countChunks(fileId));
  }

  // 조각 하나의 내용(Buffer). 없으면 null.
  getChunk(fileId, seq) {
    const read = (row) => (row ? Buffer.from(row.data) : null);
    const found = this.#run(
      (function* find() {
        return yield get('SELECT data FROM file_chunks WHERE file_id = ? AND seq = ?', fileId, seq);
      })(),
    );
    return typeof found?.then === 'function' ? found.then(read) : read(found);
  }

  discardUpload(id) {
    return this.#atomic(() => this.#discardUpload(id));
  }

  // 올리다 만 파일과 올려 놓고 제출하지 않은 파일을 치웁니다. 한 번에 limit 개까지.
  async discardExpiredUploads(before, limit = 20) {
    const expired = await this.#run(
      (function* find() {
        return yield all('SELECT id FROM files WHERE submission_id IS NULL AND created_at < ? LIMIT ?', before, limit);
      })(),
    );
    for (const file of expired) await this.discardUpload(file.id);
  }

  // 어느 파일에도 속하지 않는 조각(지우다가 멈춘 경우)을 치웁니다. 한 번에 limit 개까지.
  sweepOrphanChunks(limit = 40) {
    return this.#run(
      (function* sweep() {
        yield run(
          `DELETE FROM file_chunks WHERE rowid IN (
             SELECT c.rowid FROM file_chunks c LEFT JOIN files f ON f.id = c.file_id WHERE f.id IS NULL LIMIT ?
           )`,
          limit,
        );
      })(),
    );
  }

  // 받아 둔 파일 전체의 크기(바이트). 올리는 중인 것도 셉니다.
  fileBytes() {
    return this.#run(
      (function* total() {
        return (yield get('SELECT COALESCE(SUM(size), 0) AS total FROM files')).total;
      })(),
    );
  }

  // ── 명단 ──

  listRoster() {
    return this.#run(
      (function* list() {
        return yield all('SELECT student_id, name FROM roster ORDER BY student_id');
      })(),
    );
  }

  rosterCount() {
    return this.#run(
      (function* count() {
        return (yield get('SELECT COUNT(*) AS count FROM roster')).count;
      })(),
    );
  }

  isInRoster(studentId) {
    return this.#run(
      (function* find() {
        return Boolean(yield get('SELECT 1 AS found FROM roster WHERE student_id = ?', studentId));
      })(),
    );
  }

  replaceRoster(students) {
    return this.#atomic(function* replace() {
      yield run('DELETE FROM roster');
      for (const student of students) {
        yield run('INSERT INTO roster (student_id, name) VALUES (?, ?)', student.studentId, student.name);
      }
    });
  }

  missingStudents(assignmentId) {
    return this.#run(
      (function* missing() {
        return yield all(
          `
          SELECT r.student_id, r.name
            FROM roster r
           WHERE NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id = ? AND s.student_id = r.student_id)
           ORDER BY r.student_id
          `,
          assignmentId,
        );
      })(),
    );
  }

  // ── 관리자 로그인 세션 ──

  createSession(tokenHash, createdAt, expiresAt) {
    return this.#run(
      (function* create() {
        yield run('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)', tokenHash, createdAt, expiresAt);
      })(),
    );
  }

  findSession(tokenHash, now) {
    return this.#run(
      (function* find() {
        return (yield get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', tokenHash, now)) ?? null;
      })(),
    );
  }

  deleteSession(tokenHash) {
    return this.#run(
      (function* remove() {
        yield run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
      })(),
    );
  }

  deleteOtherSessions(tokenHash) {
    return this.#run(
      (function* remove() {
        yield run('DELETE FROM sessions WHERE token_hash <> ?', tokenHash);
      })(),
    );
  }

  deleteAllSessions() {
    return this.#run(
      (function* remove() {
        yield run('DELETE FROM sessions');
      })(),
    );
  }

  pruneSessions(now) {
    return this.#run(
      (function* prune() {
        yield run('DELETE FROM sessions WHERE expires_at <= ?', now);
      })(),
    );
  }

  // ── 횟수 기록 (src/security.js 의 StoredBuckets 가 씁니다) ──

  getRateLimit(key) {
    return this.#run(
      (function* find() {
        return (yield get('SELECT count, reset_at FROM rate_limits WHERE key = ?', key)) ?? null;
      })(),
    );
  }

  // 횟수를 하나 올리고 올린 뒤의 값을 돌려줍니다. 시간 창이 지났으면 1부터 다시 셉니다.
  // 읽기와 쓰기가 한 문장이라, 동시에 여러 요청이 와도 횟수를 놓치지 않습니다.
  hitRateLimit(key, now, resetAt) {
    return this.#run(
      (function* hit() {
        return yield get(
          `
          INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
          ON CONFLICT (key) DO UPDATE SET
            count    = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
            reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
          RETURNING count, reset_at
          `,
          key,
          resetAt,
          now,
          now,
        );
      })(),
    );
  }

  deleteRateLimit(key) {
    return this.#run(
      (function* remove() {
        yield run('DELETE FROM rate_limits WHERE key = ?', key);
      })(),
    );
  }

  pruneRateLimits(now) {
    return this.#run(
      (function* prune() {
        yield run('DELETE FROM rate_limits WHERE reset_at <= ?', now);
      })(),
    );
  }
}

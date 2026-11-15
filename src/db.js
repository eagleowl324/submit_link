import { DatabaseSync } from 'node:sqlite';

// 스키마를 바꿀 때는 기존 항목을 고치지 말고 배열 끝에 새 단계를 추가합니다.
const MIGRATIONS = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE assignments (
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
  CREATE TABLE submissions (
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

  CREATE TABLE submission_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    student_name  TEXT NOT NULL,
    url           TEXT NOT NULL,
    note          TEXT NOT NULL,
    submitted_at  TEXT NOT NULL
  );
  CREATE INDEX submission_history_by_submission ON submission_history (submission_id);

  CREATE TABLE roster (
    student_id TEXT PRIMARY KEY,
    name       TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
];

// 모든 시각은 UTC ISO 문자열(2026-11-15T05:03:00.000Z)로 저장해서 문자열 비교가 곧 시간 비교가 됩니다.
export class Store {
  #db;
  #statements = new Map();

  constructor(file) {
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA foreign_keys = ON');
    // 비밀번호 재설정 명령처럼 다른 프로세스가 잠깐 쓰고 있을 때 바로 실패하지 않고 기다립니다.
    this.#db.exec('PRAGMA busy_timeout = 3000');
    this.#migrate();
  }

  close() {
    this.#statements.clear();
    this.#db.close();
  }

  #migrate() {
    const current = this.#db.prepare('PRAGMA user_version').get().user_version;
    if (current > MIGRATIONS.length) {
      throw new Error('데이터 파일이 이 프로그램보다 새로운 버전에서 만들어졌습니다. 프로그램을 최신 버전으로 바꿔 주세요.');
    }
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.transaction(() => {
        this.#db.exec(MIGRATIONS[version]);
        this.#db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  #sql(text) {
    let statement = this.#statements.get(text);
    if (!statement) {
      statement = this.#db.prepare(text);
      this.#statements.set(text, statement);
    }
    return statement;
  }

  transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // 설정
  getSetting(key) {
    return this.#sql('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  setSetting(key, value) {
    this.#sql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // 과제
  listAssignments() {
    return this.#sql('SELECT * FROM assignments ORDER BY created_at DESC, id DESC').all();
  }

  getAssignment(id) {
    return this.#sql('SELECT * FROM assignments WHERE id = ?').get(id) ?? null;
  }

  getAssignmentBySlug(slug) {
    return this.#sql('SELECT * FROM assignments WHERE slug = ?').get(slug) ?? null;
  }

  createAssignment({ slug, title, description, dueAt, allowLate, isOpen, createdAt }) {
    const { lastInsertRowid } = this.#sql(
      'INSERT INTO assignments (slug, title, description, due_at, allow_late, is_open, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(slug, title, description, dueAt, allowLate ? 1 : 0, isOpen ? 1 : 0, createdAt);
    return this.getAssignment(Number(lastInsertRowid));
  }

  updateAssignment(id, { title, description, dueAt, allowLate, isOpen }) {
    this.#sql('UPDATE assignments SET title = ?, description = ?, due_at = ?, allow_late = ?, is_open = ? WHERE id = ?').run(
      title,
      description,
      dueAt,
      allowLate ? 1 : 0,
      isOpen ? 1 : 0,
      id,
    );
    return this.getAssignment(id);
  }

  deleteAssignment(id) {
    return this.#sql('DELETE FROM assignments WHERE id = ?').run(id).changes > 0;
  }

  // 과제별 제출 수와 지각 수. 지각 여부는 저장하지 않고 마감 일시와 비교해서 구하므로, 마감을 늦추면 바로 반영됩니다.
  submissionStats() {
    return this.#sql(`
      SELECT s.assignment_id AS assignment_id,
             COUNT(*) AS total,
             SUM(CASE WHEN a.due_at IS NOT NULL AND s.updated_at > a.due_at THEN 1 ELSE 0 END) AS late
        FROM submissions s JOIN assignments a ON a.id = s.assignment_id
       GROUP BY s.assignment_id
    `).all();
  }

  // 제출
  getSubmission(assignmentId, studentId) {
    return this.#sql('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(assignmentId, studentId) ?? null;
  }

  getSubmissionById(id) {
    return this.#sql('SELECT * FROM submissions WHERE id = ?').get(id) ?? null;
  }

  // 새 제출을 저장하거나 기존 제출을 고칩니다.
  // expectedHash 는 호출한 쪽이 비밀번호를 확인할 때 본 값입니다(제출이 없었다면 null).
  // 확인과 저장 사이에 다른 요청이 끼어들었다면 'conflict' 를 돌려줍니다.
  // maxSubmissions(과제 하나가 받는 제출 수)와 maxLinkChanges(한 학생이 링크를 바꿀 수 있는 횟수)는
  // 누군가 제출을 끝없이 쌓아 저장 공간과 관리 화면을 망가뜨리는 것을 막는 한도입니다.
  saveSubmission({ assignmentId, studentId, name, url, note, passwordHash, expectedHash, at, maxSubmissions, maxLinkChanges }) {
    return this.transaction(() => {
      if (!this.getAssignment(assignmentId)) return { status: 'gone' };
      const current = this.getSubmission(assignmentId, studentId);
      if ((current ? current.password_hash : null) !== expectedHash) return { status: 'conflict' };

      if (!current) {
        if (this.countSubmissions(assignmentId) >= maxSubmissions) return { status: 'full' };
        this.#sql(
          'INSERT INTO submissions (assignment_id, student_id, student_name, url, note, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(assignmentId, studentId, name, url, note, passwordHash, at, at);
        return { status: 'created', row: this.getSubmission(assignmentId, studentId) };
      }

      // 제출 시각과 지각 여부는 링크를 기준으로 합니다. 링크가 그대로면 시각을 건드리지 않으므로,
      // 마감 뒤에 같은 링크를 다시 내거나 이름·메모만 고쳐도 지각이 되지 않습니다.
      if (current.url === url) {
        const edited = current.student_name !== name || current.note !== note;
        if (edited || current.password_hash !== passwordHash) {
          this.#sql('UPDATE submissions SET student_name = ?, note = ?, password_hash = ? WHERE id = ?').run(name, note, passwordHash, current.id);
        }
        return { status: edited ? 'updated' : 'unchanged', row: this.getSubmission(assignmentId, studentId) };
      }

      // revision 은 1에서 시작하므로 링크를 바꾼 횟수는 revision - 1 입니다.
      if (current.revision - 1 >= maxLinkChanges) return { status: 'too_many_changes' };

      this.#sql('INSERT INTO submission_history (submission_id, student_name, url, note, submitted_at) VALUES (?, ?, ?, ?, ?)').run(
        current.id,
        current.student_name,
        current.url,
        current.note,
        current.updated_at,
      );
      this.#sql(
        'UPDATE submissions SET student_name = ?, url = ?, note = ?, password_hash = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      ).run(name, url, note, passwordHash, at, current.id);
      return { status: 'updated', row: this.getSubmission(assignmentId, studentId) };
    });
  }

  countSubmissions(assignmentId) {
    return this.#sql('SELECT COUNT(*) AS count FROM submissions WHERE assignment_id = ?').get(assignmentId).count;
  }

  listSubmissions(assignmentId) {
    return this.#sql(`
      SELECT s.*, r.name AS roster_name
        FROM submissions s LEFT JOIN roster r ON r.student_id = s.student_id
       WHERE s.assignment_id = ?
       ORDER BY s.student_id
    `).all(assignmentId);
  }

  getSubmissionDetail(id) {
    return (
      this.#sql(`
        SELECT s.*, r.name AS roster_name
          FROM submissions s LEFT JOIN roster r ON r.student_id = s.student_id
         WHERE s.id = ?
      `).get(id) ?? null
    );
  }

  // 한 제출의 이전 링크들. 최근 것부터. 링크를 바꿀 수 있는 횟수에 한도가 있으므로 줄 수도 그만큼만 됩니다.
  listHistory(submissionId) {
    return this.#sql('SELECT * FROM submission_history WHERE submission_id = ? ORDER BY submitted_at DESC, id DESC').all(submissionId);
  }

  deleteSubmission(id) {
    return this.#sql('DELETE FROM submissions WHERE id = ?').run(id).changes > 0;
  }

  // 비밀번호를 비우면 그 학번으로 다음에 제출하는 사람이 새 비밀번호를 정합니다.
  clearSubmissionPassword(id) {
    return this.#sql("UPDATE submissions SET password_hash = '' WHERE id = ?").run(id).changes > 0;
  }

  // 명단
  listRoster() {
    return this.#sql('SELECT student_id, name FROM roster ORDER BY student_id').all();
  }

  rosterCount() {
    return this.#sql('SELECT COUNT(*) AS count FROM roster').get().count;
  }

  isInRoster(studentId) {
    return Boolean(this.#sql('SELECT 1 AS found FROM roster WHERE student_id = ?').get(studentId));
  }

  replaceRoster(students) {
    this.transaction(() => {
      this.#sql('DELETE FROM roster').run();
      const insert = this.#sql('INSERT INTO roster (student_id, name) VALUES (?, ?)');
      for (const student of students) insert.run(student.studentId, student.name);
    });
  }

  missingStudents(assignmentId) {
    return this.#sql(`
      SELECT r.student_id, r.name
        FROM roster r
       WHERE NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id = ? AND s.student_id = r.student_id)
       ORDER BY r.student_id
    `).all(assignmentId);
  }

  // 관리자 로그인 세션
  createSession(tokenHash, createdAt, expiresAt) {
    this.#sql('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(tokenHash, createdAt, expiresAt);
  }

  findSession(tokenHash, now) {
    return this.#sql('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now) ?? null;
  }

  deleteSession(tokenHash) {
    this.#sql('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteOtherSessions(tokenHash) {
    this.#sql('DELETE FROM sessions WHERE token_hash <> ?').run(tokenHash);
  }

  deleteAllSessions() {
    this.#sql('DELETE FROM sessions').run();
  }

  pruneSessions(now) {
    this.#sql('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }
}

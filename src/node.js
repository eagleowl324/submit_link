// Node.js 에서 서비스를 돌리는 부분: SQLite 파일, 정적 파일 읽기, HTTP 서버.
// 서비스의 로직 자체는 src/app.js 에 있습니다.

import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { ConfigError, createApp } from './app.js';
import { Store } from './db.js';
import { generateAdminPassword, hashPassword } from './security.js';

export { ConfigError };
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATABASE_FILE = 'submissions.db';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// src/db.js 가 요구하는 모양으로 node:sqlite 를 감쌉니다.
class SqliteFile {
  #db;
  #statements = new Map();

  constructor(file) {
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA foreign_keys = ON');
    // 비밀번호 재설정 명령처럼 다른 프로세스가 잠깐 쓰고 있을 때 바로 실패하지 않고 기다립니다.
    this.#db.exec('PRAGMA busy_timeout = 3000');
  }

  #sql(text) {
    let statement = this.#statements.get(text);
    if (!statement) {
      statement = this.#db.prepare(text);
      this.#statements.set(text, statement);
    }
    return statement;
  }

  get(text, ...params) {
    return this.#sql(text).get(...params);
  }

  all(text, ...params) {
    return this.#sql(text).all(...params);
  }

  run(text, ...params) {
    this.#sql(text).run(...params);
  }

  exec(text) {
    this.#db.exec(text);
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

  close() {
    this.#statements.clear();
    this.#db.close();
  }
}

function openStore(dataDir) {
  try {
    // 같은 컴퓨터의 다른 계정이 학생 정보를 읽지 못하게 폴더와 파일을 본인만 볼 수 있게 만듭니다.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, DATABASE_FILE);
    const store = new Store(new SqliteFile(file));
    try {
      chmodSync(file, 0o600);
    } catch {
      // 권한을 바꿀 수 없는 파일 시스템에서는 그대로 둡니다.
    }
    return store;
  } catch (error) {
    throw new ConfigError(`데이터 폴더를 쓸 수 없습니다: ${dataDir}\n(${error.message})\nDATA_DIR 로 쓸 수 있는 폴더를 지정해 주세요.`);
  }
}

// /assets/ 아래로 내보낼 파일들. public/ 과 shared/ 에 있는 것만, 주소와 정확히 일치할 때만 내보냅니다.
function loadAssets() {
  const assets = new Map();
  const addFolder = (prefix, folder) => {
    for (const name of readdirSync(folder)) {
      const type = CONTENT_TYPES[path.extname(name)];
      if (!type) continue;
      const body = readFileSync(path.join(folder, name));
      const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
      assets.set(prefix + name, { body, type, etag });
    }
  };
  addFolder('', path.join(ROOT, 'public'));
  addFolder('shared/', path.join(ROOT, 'shared'));
  return assets;
}

// 서비스를 만들고 HTTP 서버에 연결합니다. listen 은 부르는 쪽에서 합니다.
// options: dataDir, adminPassword, trustProxy, now, limits (src/app.js 의 createApp 참고)
export async function createNodeApp(options = {}) {
  const { dataDir = path.join(ROOT, 'data'), ...rest } = options;
  const store = openStore(dataDir);

  let app;
  try {
    app = await createApp({
      ...rest,
      store,
      setup: 'console',
      assets: loadAssets(),
      pages: {
        student: readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'),
        admin: readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8'),
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }

  const server = http.createServer(app.handle);
  server.headersTimeout = 15 * 1000;
  server.requestTimeout = 30 * 1000;

  let closed = false;
  return {
    server,
    store,
    generatedAdminPassword: app.generatedAdminPassword,
    async close() {
      if (closed) return;
      closed = true;
      if (server.listening) {
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
      }
      store.close();
    },
  };
}

export async function resetAdminPassword(dataDir) {
  const store = openStore(dataDir);
  try {
    const password = generateAdminPassword();
    store.setSetting('admin_password_hash', await hashPassword(password));
    store.deleteAllSessions();
    return password;
  } finally {
    store.close();
  }
}

// 모든 기기의 관리자 로그인을 끊습니다. (로그인한 기기를 잃어버렸을 때)
export function logoutAll(dataDir) {
  const store = openStore(dataDir);
  try {
    store.deleteAllSessions();
  } finally {
    store.close();
  }
}

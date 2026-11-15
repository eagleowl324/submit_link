// Cloudflare Workers 에서 서비스를 돌리는 부분.
//
// 서비스 전체가 Durable Object 하나 안에서 돕니다. Durable Object 는 자기만의 SQLite 저장소를 가진
// 작은 서버처럼 동작해서, Node.js 판(src/node.js)과 같은 로직(src/app.js)과 같은 저장소 코드(src/db.js)를 그대로 씁니다.
// 화면에 쓰이는 정적 파일(/assets/...)은 Cloudflare 가 직접 내보내고(wrangler.jsonc 의 assets), 나머지 요청만 여기로 옵니다.

import { DurableObject } from 'cloudflare:workers';

import { createApp, rateKey } from '../src/app.js';
import { Store } from '../src/db.js';
import { MemoryBuckets, RateLimiter, createHasher } from '../src/security.js';
import adminPage from '../public/admin.html';
import studentPage from '../public/index.html';

// src/db.js 가 요구하는 모양으로 Durable Object 의 SQLite 를 감쌉니다.
class DurableSqlite {
  #storage;

  constructor(storage) {
    this.#storage = storage;
  }

  get(text, ...params) {
    return this.#storage.sql.exec(text, ...params).toArray()[0];
  }

  all(text, ...params) {
    return this.#storage.sql.exec(text, ...params).toArray();
  }

  run(text, ...params) {
    this.#storage.sql.exec(text, ...params).toArray();
  }

  exec(text) {
    this.#storage.sql.exec(text);
  }

  transaction(work) {
    return this.#storage.transactionSync(work);
  }
}

// 요청 횟수 기록 보관함.
// Durable Object 는 한동안 요청이 없으면 메모리에서 내려가므로, 비밀번호를 틀린 횟수처럼 지켜야 하는 기록은
// 저장소에 남깁니다. 접속자별 요청 수(post:)는 잠깐만 필요하고 자주 바뀌어서 메모리에만 둡니다.
class StoredBuckets {
  #sql;
  #memory = new MemoryBuckets();

  constructor(sql) {
    this.#sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
  }

  #inMemory(key) {
    return key.startsWith('post:');
  }

  get(key) {
    if (this.#inMemory(key)) return this.#memory.get(key);
    const row = this.#sql.get('SELECT count, reset_at FROM rate_limits WHERE key = ?', key);
    return row ? { count: row.count, resetAt: row.reset_at } : undefined;
  }

  set(key, bucket) {
    if (this.#inMemory(key)) {
      this.#memory.set(key, bucket);
      return;
    }
    this.#sql.run(
      'INSERT INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at',
      key,
      bucket.count,
      bucket.resetAt,
    );
  }

  delete(key) {
    if (this.#inMemory(key)) this.#memory.delete(key);
    else this.#sql.run('DELETE FROM rate_limits WHERE key = ?', key);
  }

  prune(now) {
    this.#memory.prune(now);
    this.#sql.run('DELETE FROM rate_limits WHERE reset_at <= ?', now);
  }
}

// Cloudflare 의 Request 를 src/app.js 가 쓰는 Node.js 식 req/res 모양으로 바꿔 넘기고, 결과를 Response 로 돌려줍니다.
async function serve(app, request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;

  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    // 접속자 주소는 Cloudflare 가 붙여 주는 값이라 보내는 쪽이 꾸밀 수 없습니다.
    socket: { remoteAddress: headers['cf-connecting-ip'] || '', encrypted: url.protocol === 'https:' },
    destroyed: false,
    async *[Symbol.asyncIterator]() {
      if (request.body) yield* request.body;
    },
  };

  let sent = null;
  const res = {
    req,
    headersSent: false,
    destroyed: false,
    writeHead(status, responseHeaders = {}) {
      this.headersSent = true;
      sent = { status, headers: responseHeaders, body: null };
    },
    end(body) {
      if (sent) sent.body = body ?? null;
    },
    destroy() {
      this.destroyed = true;
    },
  };

  await app.handle(req, res);
  if (!sent) return new Response('서버에서 문제가 생겼습니다.\n', { status: 500 });

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(sent.headers)) {
    // 길이와 연결 관리는 Cloudflare 가 합니다.
    if (!['content-length', 'connection'].includes(name.toLowerCase())) responseHeaders.set(name, String(value));
  }
  const bodiless = request.method === 'HEAD' || sent.status === 204 || sent.status === 304;
  return new Response(bodiless ? null : sent.body, { status: sent.status, headers: responseHeaders });
}

export class SubmitLink extends DurableObject {
  #app = null;
  #failure = null;

  constructor(ctx, env) {
    super(ctx, env);
    // 준비가 끝날 때까지 요청을 기다리게 합니다.
    ctx.blockConcurrencyWhile(async () => {
      try {
        const sqlite = new DurableSqlite(ctx.storage);
        this.#app = await createApp({
          store: new Store(sqlite),
          pages: { student: studentPage, admin: adminPage },
          // ADMIN_PASSWORD 를 정해 두지 않으면 관리 화면에 처음 들어갔을 때 비밀번호를 만듭니다.
          adminPassword: env.ADMIN_PASSWORD || '',
          setup: 'web',
          hasher: createHasher(env.PASSWORD_HASH || 'scrypt'),
          limiter: new RateLimiter(Date.now, new StoredBuckets(sqlite)),
          clientIp: (req) => rateKey(req.headers['cf-connecting-ip'] || ''),
        });
      } catch (error) {
        console.error(error);
        this.#failure = error?.constructor?.name === 'ConfigError' ? error.message : '서비스를 시작하지 못했습니다. Cloudflare 대시보드의 로그를 확인해 주세요.';
      }
    });
  }

  async fetch(request) {
    if (!this.#app) {
      return new Response(`${this.#failure}\n`, { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return serve(this.#app, request);
  }
}

export default {
  // 모든 요청을 같은 Durable Object 하나로 보냅니다. 데이터가 한 곳에 있어야 하기 때문입니다.
  async fetch(request, env) {
    return env.APP.get(env.APP.idFromName('main')).fetch(request);
  },
};

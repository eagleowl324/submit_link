// 테스트에서 서비스를 띄우는 방법을 고릅니다.
//
//   npm test                 직접 띄우는 Node.js 서버 그대로 (내장 SQLite)
//   npm run test:libsql      같은 테스트를, Vercel 에서 쓰는 저장 방식(libSQL, 질의마다 기다리는 저장소)으로
//
// 두 방식이 같은 로직(src/app.js, src/db.js)을 쓰므로, 양쪽에서 같은 테스트가 통과해야 합니다.

import http from 'node:http';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

import { createApp as createCore } from '../src/app.js';
import { Store } from '../src/db.js';
import { createNodeApp, loadAssets, loadPages } from '../src/node.js';

export const USING_LIBSQL = process.env.TEST_STORE === 'libsql';

async function createLibsqlApp(options = {}) {
  const { createClient } = await import('@libsql/client');
  const { LibsqlDatabase } = await import('../src/libsql.js');
  const { dataDir, ...rest } = options;
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(new LibsqlDatabase(createClient({ url: `file:${path.join(dataDir, 'submissions.db')}` }), { serialize: true }));

  let app;
  try {
    app = await createCore({ ...rest, store, setup: 'console', assets: loadAssets(), pages: loadPages() });
  } catch (error) {
    store.close();
    throw error;
  }
  const server = http.createServer(app.handle);
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

export const createApp = USING_LIBSQL ? createLibsqlApp : createNodeApp;

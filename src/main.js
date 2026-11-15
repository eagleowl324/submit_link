import os from 'node:os';
import path from 'node:path';

import { ConfigError, DATABASE_FILE, ROOT, createNodeApp, logoutAll, resetAdminPassword } from './node.js';

const HELP = `과제 링크 제출함

사용법
  node server.js                          서버를 시작합니다.
  node server.js --reset-admin-password   관리자 비밀번호를 새로 만듭니다.
  node server.js --logout-all             모든 기기의 관리자 로그인을 해제합니다.

환경 변수
  PORT             접속 포트 (기본 3000)
  HOST             받을 주소 (기본: 모든 주소)
  DATA_DIR         데이터를 저장할 폴더 (기본: 프로그램 폴더 안의 data)
  ADMIN_PASSWORD   관리자 비밀번호 (8자 이상). 정하지 않으면 처음 실행할 때 자동으로 만들어 알려 줍니다.
  TRUST_PROXY      서버 앞에 있는 프록시(리버스 프록시, 클라우드 로드밸런서)의 개수 (기본 0)
`;

function box(lines) {
  const rule = '─'.repeat(58);
  return ['', rule, ...lines.map((line) => (line ? `  ${line}` : '')), rule, ''].join('\n');
}

function lanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
    }
  }
  return addresses;
}

export async function main(argv, env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  // 상대 경로는 실행한 위치가 아니라 프로그램 폴더를 기준으로 합니다.
  const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
  const adminPassword = env.ADMIN_PASSWORD || '';

  if (argv.includes('--logout-all')) {
    logoutAll(dataDir);
    console.log(box(['모든 기기의 관리자 로그인을 해제했습니다.', '서버가 실행 중이었다면 그대로 두어도 됩니다.']));
    return;
  }

  if (argv.includes('--reset-admin-password')) {
    if (adminPassword) {
      console.log('관리자 비밀번호가 ADMIN_PASSWORD 환경 변수로 정해져 있습니다. 그 값을 바꾸고 서버를 다시 시작하면 예전 로그인도 모두 해제됩니다.');
      return;
    }
    const password = await resetAdminPassword(dataDir);
    console.log(
      box([`새 관리자 비밀번호: ${password}`, '', '기존 로그인은 모두 해제되었습니다.', '서버가 실행 중이었다면 그대로 두어도 됩니다.']),
    );
    return;
  }

  const port = Number.parseInt(env.PORT || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT 값이 올바르지 않습니다: ${env.PORT}`);
  }
  const trustProxy = Number.parseInt(env.TRUST_PROXY || '0', 10);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) {
    throw new ConfigError(`TRUST_PROXY 는 0 이상의 숫자여야 합니다: ${env.TRUST_PROXY}`);
  }

  const app = await createNodeApp({ dataDir, adminPassword, trustProxy });

  await new Promise((resolve, reject) => {
    app.server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new ConfigError(`${port}번 포트를 다른 프로그램이 쓰고 있습니다. PORT=3001 처럼 다른 포트를 정해서 다시 실행하세요.`));
      } else {
        reject(error);
      }
    });
    if (env.HOST) app.server.listen(port, env.HOST, resolve);
    else app.server.listen(port, resolve);
  });

  const lines = ['과제 링크 제출함이 실행 중입니다.', '', `학생용 주소    http://localhost:${port}`, `관리자 주소    http://localhost:${port}/admin`];
  for (const address of lanAddresses()) lines.push(`같은 네트워크  http://${address}:${port}`);
  lines.push('', `데이터 파일    ${path.join(dataDir, DATABASE_FILE)}`, '끝내려면 Ctrl+C 를 누르세요.');
  console.log(box(lines));

  if (app.generatedAdminPassword) {
    console.log(
      box([
        `관리자 비밀번호가 만들어졌습니다: ${app.generatedAdminPassword}`,
        '',
        '이 비밀번호는 지금 한 번만 보여 드립니다.',
        '관리자 주소에서 로그인한 뒤 [설정]에서 원하는 비밀번호로 바꾸세요.',
        '잊어버렸다면: node server.js --reset-admin-password',
      ]),
    );
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

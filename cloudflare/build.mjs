// Cloudflare 가 직접 내보낼 정적 파일을 dist/ 에 모읍니다. (wrangler 가 배포·개발 서버를 시작하기 전에 자동으로 실행합니다.)
//
//   public/*.css, *.js, *.svg   →  dist/assets/
//   shared/*.js                 →  dist/assets/shared/
//
// HTML 은 모으지 않습니다. 제목을 채워 넣고 보안 헤더를 붙여야 해서 서비스가 직접 내보냅니다.

import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const EXTENSIONS = new Set(['.css', '.js', '.svg']);

function copyFolder(from, to) {
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const name of readdirSync(from)) {
    if (!EXTENSIONS.has(path.extname(name))) continue;
    copyFileSync(path.join(from, name), path.join(to, name));
    count += 1;
  }
  return count;
}

rmSync(DIST, { recursive: true, force: true });
const copied = copyFolder(path.join(ROOT, 'public'), path.join(DIST, 'assets')) + copyFolder(path.join(ROOT, 'shared'), path.join(DIST, 'assets', 'shared'));

// 정적 파일에도 서비스가 붙이는 것과 같은 보안 헤더를 붙입니다.
writeFileSync(
  path.join(DIST, '_headers'),
  ['/*', '  X-Content-Type-Options: nosniff', '  X-Frame-Options: DENY', '  Referrer-Policy: no-referrer', '  X-Robots-Tag: noindex, nofollow', ''].join('\n'),
);

console.log(`정적 파일 ${copied}개를 dist/assets 에 모았습니다.`);

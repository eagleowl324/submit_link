// Vercel 배포용 빌드. (Vercel 이 배포할 때 자동으로 실행합니다. 직접 돌릴 때: npm run build)
//
//   public/*.css, *.js, *.svg  →  dist/assets/          Vercel 이 정적 파일로 직접 내보냄
//   shared/*.js                →  dist/assets/shared/
//   public/*.html              →  src/pages.generated.js 서비스가 제목을 채워 내보내는 HTML 틀
//
// Node.js 서버(node server.js)는 이 빌드 없이 public/ 과 shared/ 를 직접 읽습니다.

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const page = (name) => JSON.stringify(readFileSync(path.join(ROOT, 'public', name), 'utf8'));
writeFileSync(
  path.join(ROOT, 'src', 'pages.generated.js'),
  [
    '// 자동으로 만든 파일입니다. 직접 고치지 말고 public/*.html 을 고친 뒤 `npm run build` 를 실행하세요.',
    '// Vercel 처럼 파일을 읽을 수 없는 실행 환경에서 HTML 틀을 쓰기 위한 것입니다.',
    '',
    `export const student = ${page('index.html')};`,
    '',
    `export const admin = ${page('admin.html')};`,
    '',
  ].join('\n'),
);

console.log(`정적 파일 ${copied}개를 dist/assets 에 모으고, HTML 틀을 src/pages.generated.js 에 담았습니다.`);

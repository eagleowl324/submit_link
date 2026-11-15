import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FOLDERS = ['', 'src', 'shared', 'public', 'test', 'api', 'scripts'];
const EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css', '.svg', '.json', '.md', '']);

// 제어 문자, 폭 없는 문자, 글자 방향을 바꾸는 문자(탭·줄바꿈 제외)
function isHidden(code) {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

// 이런 문자는 편집기에서 보이지 않아서, 코드가 화면에 보이는 것과 다르게 동작하게 만들 수 있습니다.
// 꼭 필요한 곳에서는 이스케이프 표기(역슬래시 u 와 네 자리 숫자)로 적습니다.
test('소스 파일에 보이지 않는 문자가 글자 그대로 들어 있지 않다', () => {
  const found = [];
  for (const folder of FOLDERS) {
    for (const entry of readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name))) continue;
      const file = path.join(folder, entry.name);
      readFileSync(path.join(ROOT, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const char of line) {
            if (isHidden(char.codePointAt(0))) {
              found.push(`${file}:${index + 1} U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
            }
          }
        });
    }
  }
  assert.deepEqual(found, []);
});

// Vercel 에서는 파일을 읽을 수 없어서 HTML 틀을 src/pages.generated.js 에 담아 둡니다(npm run build).
// 배포할 때 Vercel 이 다시 만들지만, 저장소에 들어 있는 것도 원본과 같아야 테스트가 실제와 같은 것을 봅니다.
test('src/pages.generated.js 가 public/*.html 과 같다 (다르면 npm run build)', async () => {
  const generated = await import('../src/pages.generated.js');
  assert.equal(generated.student, readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'));
  assert.equal(generated.admin, readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8'));
});

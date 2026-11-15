#!/usr/bin/env node
// 과제 링크 제출함 — 실행 파일. 사용법은 README.md 를 보세요.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `이 프로그램은 Node.js 22.13 이상에서 실행됩니다. (지금 설치된 버전: ${process.versions.node})\n` +
      'https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.',
  );
  process.exit(1);
}

// Node.js 22~24는 내장 SQLite를 불러올 때마다 "실험적 기능" 경고를 띄웁니다.
// 처음 실행하는 사람이 오류로 오해하지 않도록 그 경고 하나만 숨깁니다.
const emitWarning = process.emitWarning;
process.emitWarning = function quietSqliteWarning(warning, ...rest) {
  const message = typeof warning === 'string' ? warning : warning?.message;
  if (typeof message === 'string' && message.includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};

try {
  const { main } = await import('./src/main.js');
  await main(process.argv.slice(2), process.env);
} catch (error) {
  // 설정이 잘못된 경우는 안내문만, 그 밖의 오류는 원인을 찾을 수 있게 전체를 보여 줍니다.
  console.error(error?.constructor?.name === 'ConfigError' ? `\n${error.message}\n` : error);
  process.exit(1);
}

// Vercel 이 실행하는 진입점. 정적 파일이 아닌 모든 요청이 여기로 옵니다(vercel.json 의 rewrites).

import { createClient } from '@libsql/client/web';

import { createVercelHandler } from '../src/vercel.js';

export default { fetch: createVercelHandler({ env: process.env, createClient }) };

import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

// 헷갈리는 글자(0/o, 1/l/i)를 뺀 문자표
const CLEAR_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

// 한글 비밀번호가 기기마다 다른 조합형으로 입력되어도 같은 값으로 비교되게 합니다.
function passwordBytes(password) {
  return Buffer.from(String(password).normalize('NFKC'), 'utf8');
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(passwordBytes(password), salt, KEY_LENGTH, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, key] = parts;
  const expected = Buffer.from(key, 'base64');
  if (expected.length === 0) return false;
  try {
    const actual = await scryptAsync(passwordBytes(password), Buffer.from(salt, 'base64'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// 길이가 달라도 비교 시간이 값에 따라 달라지지 않게 해시끼리 비교합니다.
export function sameSecret(a, b) {
  return timingSafeEqual(createHash('sha256').update(passwordBytes(a)).digest(), createHash('sha256').update(passwordBytes(b)).digest());
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

function randomText(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CLEAR_ALPHABET[randomInt(CLEAR_ALPHABET.length)];
  return out;
}

export function randomSlug() {
  return randomText(8);
}

export function generateAdminPassword() {
  return [randomText(4), randomText(4), randomText(4)].join('-');
}

// 정해진 시간 창 안에서 횟수를 세는 간단한 제한기. 서버가 하나일 때만 정확합니다.
export class RateLimiter {
  constructor(clock = Date.now) {
    this.clock = clock;
    this.buckets = new Map();
  }

  // 시도 한 번을 기록하고, 한도를 넘었으면 allowed: false 와 남은 시간(초)을 돌려줍니다.
  take(key, limit, windowMs) {
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    return { allowed: true, retryAfter: 0 };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  prune() {
    const now = this.clock();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

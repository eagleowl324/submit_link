import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const PBKDF2_DEFAULT_ITERATIONS = 100000;

// 헷갈리는 글자(0/o, 1/l/i)를 뺀 문자표
const CLEAR_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

// 한글 비밀번호가 기기마다 다른 조합형으로 입력되어도 같은 값으로 비교되게 합니다.
function passwordBytes(password) {
  return Buffer.from(String(password).normalize('NFKC'), 'utf8');
}

// Node.js 와 Cloudflare Workers 양쪽에 있는 Web Crypto 로 계산합니다.
async function pbkdf2(password, salt, iterations, length) {
  const material = await crypto.subtle.importKey('raw', passwordBytes(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, length * 8);
  return Buffer.from(bits);
}

// 비밀번호 해시기. 기본은 scrypt 이고, 요청 하나에 쓸 수 있는 CPU 시간이 빠듯한 실행 환경에서는
// 'pbkdf2:<반복 횟수>' 로 바꿀 수 있습니다. 어떤 방식으로 만들었는지가 해시 문자열 앞에 적혀 있어서,
// 방식을 바꾼 뒤에도 예전에 저장한 해시는 그대로 확인됩니다.
export function createHasher(spec = 'scrypt') {
  const [kind, cost] = String(spec).split(':');
  if (kind !== 'scrypt' && kind !== 'pbkdf2') throw new Error(`알 수 없는 비밀번호 해시 방식입니다: ${spec}`);
  const iterations = cost ? Number(cost) : PBKDF2_DEFAULT_ITERATIONS;
  if (kind === 'pbkdf2' && (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1000000)) {
    throw new Error(`pbkdf2 반복 횟수가 올바르지 않습니다: ${cost}`);
  }

  return {
    async hash(password) {
      const salt = randomBytes(16);
      if (kind === 'pbkdf2') {
        const key = await pbkdf2(password, salt, iterations, KEY_LENGTH);
        return ['pbkdf2', 'sha256', iterations, salt.toString('base64'), key.toString('base64')].join('$');
      }
      const key = await scryptAsync(passwordBytes(password), salt, KEY_LENGTH, SCRYPT);
      return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
    },
    verify: verifyPassword,
  };
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  try {
    if (parts[0] === 'scrypt' && parts.length === 6) {
      const [, N, r, p, salt, key] = parts;
      const expected = Buffer.from(key, 'base64');
      if (expected.length === 0) return false;
      const actual = await scryptAsync(passwordBytes(password), Buffer.from(salt, 'base64'), expected.length, {
        N: Number(N),
        r: Number(r),
        p: Number(p),
      });
      return timingSafeEqual(actual, expected);
    }
    if (parts[0] === 'pbkdf2' && parts[1] === 'sha256' && parts.length === 5) {
      const iterations = Number(parts[2]);
      const expected = Buffer.from(parts[4], 'base64');
      if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000000 || expected.length === 0) return false;
      const actual = await pbkdf2(password, Buffer.from(parts[3], 'base64'), iterations, expected.length);
      return timingSafeEqual(actual, expected);
    }
  } catch {
    return false;
  }
  return false;
}

export function hashPassword(password) {
  return createHasher().hash(password);
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

// 횟수 기록을 메모리에 두는 기본 보관함. 프로그램을 다시 시작하면 지워집니다.
export class MemoryBuckets {
  #map = new Map();

  get(key) {
    return this.#map.get(key);
  }

  set(key, bucket) {
    this.#map.set(key, bucket);
  }

  delete(key) {
    this.#map.delete(key);
  }

  prune(now) {
    for (const [key, bucket] of this.#map) {
      if (bucket.resetAt <= now) this.#map.delete(key);
    }
  }
}

// 정해진 시간 창 안에서 횟수를 세는 간단한 제한기.
// buckets 는 { get, set, delete, prune } 을 가진 보관함입니다. 기본은 메모리이고,
// 프로그램이 수시로 내려갔다 올라오는 실행 환경(Cloudflare)에서는 저장소에 남기는 보관함을 넣습니다.
export class RateLimiter {
  constructor(clock = Date.now, buckets = new MemoryBuckets()) {
    this.clock = clock;
    this.buckets = buckets;
  }

  // 시도 한 번을 기록하고, 한도를 넘었으면 allowed: false 와 남은 시간(초)을 돌려줍니다.
  take(key, limit, windowMs) {
    const now = this.clock();
    const saved = this.buckets.get(key);
    const live = saved && saved.resetAt > now ? saved : null;
    const blocked = (bucket) => ({ allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) });
    // 이미 막힌 상태에서는 더 기록하지 않습니다. 막힌 요청이 몰려와도 보관함에 쓰는 일이 늘지 않습니다.
    if (live && live.count > limit) return blocked(live);

    const bucket = live ? { count: live.count + 1, resetAt: live.resetAt } : { count: 1, resetAt: now + windowMs };
    this.buckets.set(key, bucket);
    return bucket.count > limit ? blocked(bucket) : { allowed: true, retryAfter: 0 };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  prune() {
    this.buckets.prune(this.clock());
  }
}

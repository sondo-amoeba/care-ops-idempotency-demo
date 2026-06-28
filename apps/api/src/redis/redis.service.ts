import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

// Fixed-window counter: INCR and (on first hit) set the TTL in ONE script so a
// crash can never leave a counter without an expiry (ADR-0006). Returns the count.
const RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

// Token bucket: refill by elapsed * rate (capped at capacity), then try to spend
// one token. State (tokens, last-refill ms) lives in a hash; whole thing is one
// atomic script so concurrent relay workers share one carrier-MPS budget.
// Returns 1 if a token was granted, 0 if throttled.
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])
if tokens == nil then
  tokens = capacity
  ts = now_ms
end
local elapsed = math.max(0, now_ms - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * rate)
local granted = 0
if tokens >= 1 then
  tokens = tokens - 1
  granted = 1
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
redis.call('PEXPIRE', key, ttl)
return granted
`;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  /** Per-interaction abuse limiter — fixed window, atomic INCR+EXPIRE (ADR-0006). */
  async checkRateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
    const count = (await this.client.eval(
      RATE_LIMIT_LUA,
      1,
      `rate:${key}`,
      String(windowSec),
    )) as number;
    return count <= limit;
  }

  /**
   * Carrier MPS gate (ADR-0006). Atomically refills and spends one token.
   * `ratePerSec` tokens/sec, bucket holds up to `capacity`. Empty bucket ->
   * false, and the relay simply leaves the row `pending` (durable, safe).
   */
  async consumeToken(
    bucketKey: string,
    ratePerSec: number,
    capacity: number,
    nowMs: number,
  ): Promise<boolean> {
    const ttlMs = Math.max(1000, Math.ceil((capacity / Math.max(ratePerSec, 0.001)) * 1000) * 2);
    const granted = (await this.client.eval(
      TOKEN_BUCKET_LUA,
      1,
      `mps:${bucketKey}`,
      String(ratePerSec),
      String(capacity),
      String(nowMs),
      String(ttlMs),
    )) as number;
    return granted === 1;
  }
}

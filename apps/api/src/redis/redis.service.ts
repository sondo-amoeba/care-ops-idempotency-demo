import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  async checkRateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
    const redisKey = `rate:${key}`;
    const count = await this.client.incr(redisKey);
    if (count === 1) {
      await this.client.expire(redisKey, windowSec);
    }
    return count <= limit;
  }

  async cacheGet(key: string): Promise<string | null> {
    return this.client.get(`cache:${key}`);
  }

  async cacheSet(key: string, value: string, ttlSec: number): Promise<void> {
    await this.client.set(`cache:${key}`, value, "EX", ttlSec);
  }
}

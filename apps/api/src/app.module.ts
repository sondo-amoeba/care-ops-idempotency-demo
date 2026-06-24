import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  Booking,
  CareThread,
  EligibilityRule,
  Interaction,
  SmsMessage,
  SmsOutbox,
  VoiceSession,
} from "./entities";
import { CareOpsController } from "./care-ops/care-ops.controller";
import { WebhooksController } from "./webhooks/webhooks.controller";
import { EligibilityService } from "./eligibility/eligibility.service";
import { InteractionService } from "./interactions/interaction.service";
import { SmsService } from "./sms/sms.service";
import { RedisService } from "./redis/redis.service";
import { SeedService } from "./seed/seed.service";

const entities = [
  Interaction,
  CareThread,
  VoiceSession,
  Booking,
  SmsMessage,
  SmsOutbox,
  EligibilityRule,
];

function databaseConfig() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (url) {
    return {
      type: "postgres" as const,
      url,
      ssl: process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false },
      entities,
      synchronize: true,
    };
  }
  return {
    type: "postgres" as const,
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    username: process.env.POSTGRES_USER ?? "careops",
    password: process.env.POSTGRES_PASSWORD ?? "careops",
    database: process.env.POSTGRES_DB ?? "careops_demo",
    entities,
    synchronize: true,
  };
}

@Module({
  imports: [TypeOrmModule.forRoot(databaseConfig()), TypeOrmModule.forFeature(entities)],
  controllers: [CareOpsController, WebhooksController],
  providers: [
    EligibilityService,
    InteractionService,
    SmsService,
    RedisService,
    SeedService,
  ],
})
export class AppModule {}

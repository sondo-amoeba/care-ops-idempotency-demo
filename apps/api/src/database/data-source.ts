import "reflect-metadata";
import { join } from "path";
import { DataSource } from "typeorm";
import {
  Booking,
  CareContextChunk,
  CareThread,
  CoordinatorProposal,
  CoordinatorRun,
  CoordinatorTraceEvent,
  EligibilityRule,
  Interaction,
  SmsMessage,
  SmsOutbox,
  VoiceSession,
} from "../entities";
import { InitialSchema1730000000001 } from "./migrations/1730000000001-InitialSchema";

const entities = [
  Interaction,
  CareThread,
  VoiceSession,
  Booking,
  SmsMessage,
  SmsOutbox,
  EligibilityRule,
  CoordinatorRun,
  CoordinatorProposal,
  CoordinatorTraceEvent,
  CareContextChunk,
];

function buildOptions() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (url) {
    return {
      type: "postgres" as const,
      url,
      ssl:
        process.env.POSTGRES_SSL === "false"
          ? false
          : { rejectUnauthorized: false },
    };
  }
  return {
    type: "postgres" as const,
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    username: process.env.POSTGRES_USER ?? "careops",
    password: process.env.POSTGRES_PASSWORD ?? "careops",
    database: process.env.POSTGRES_DB ?? "careops_demo",
  };
}

export default new DataSource({
  ...buildOptions(),
  entities,
  migrations: [InitialSchema1730000000001],
  migrationsTableName: "typeorm_migrations",
});

export { InitialSchema1730000000001 };

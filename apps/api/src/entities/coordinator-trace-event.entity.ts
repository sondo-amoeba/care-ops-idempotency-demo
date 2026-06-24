import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

export type CoordinatorTraceEventType =
  | "phase"
  | "tool"
  | "interrupt"
  | "complete";

@Entity("coordinator_trace_events")
export class CoordinatorTraceEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  runId!: string;

  @Column({ type: "varchar", length: 16 })
  eventType!: CoordinatorTraceEventType;

  @Column({ type: "varchar", length: 64 })
  name!: string;

  @Column({ type: "jsonb", nullable: true })
  detail?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;
}

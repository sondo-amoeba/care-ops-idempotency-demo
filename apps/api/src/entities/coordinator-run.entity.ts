import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type CoordinatorRunStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "rejected"
  | "ineligible";

export type CoordinatorSignalType = "manual" | "lifecycle" | "inbound";

export type CoordinatorModelMode = "mock" | "live";

@Entity("coordinator_runs")
export class CoordinatorRun {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  interactionId!: string;

  @Column({ type: "varchar", length: 32 })
  status!: CoordinatorRunStatus;

  @Column({ type: "varchar", length: 16 })
  modelMode!: CoordinatorModelMode;

  @Column({ type: "varchar", length: 16 })
  signalType!: CoordinatorSignalType;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

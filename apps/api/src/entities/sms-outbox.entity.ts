import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("sms_outbox")
export class SmsOutbox {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128, unique: true })
  idempotencyKey!: string;

  @Column({ type: "uuid" })
  @Index()
  interactionId!: string;

  @Column({ type: "varchar", length: 64 })
  templateId!: string;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "varchar", length: 32, default: "pending" })
  status!: string;

  @Column({ type: "varchar", length: 64, nullable: true })
  twilioMessageSid?: string;

  @Column({ type: "varchar", length: 32, nullable: true })
  source?: string;

  /** ADR-0006 relay bookkeeping. */
  @Column({ type: "int", default: 0 })
  attempts!: number;

  @Column({ type: "timestamptz", default: () => "now()" })
  @Index()
  nextAttemptAt!: Date;

  @Column({ type: "text", nullable: true })
  lastError?: string | null;

  @Column({ type: "timestamptz", nullable: true })
  claimedAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}

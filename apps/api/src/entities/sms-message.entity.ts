import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { Interaction } from "./interaction.entity";

export type SmsDirection = "inbound" | "outbound";
export type SmsDeliveryStatus =
  | "pending"
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "submission_failed"
  | "received";

@Entity("sms_messages")
export class SmsMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  @Index()
  interactionId!: string;

  @ManyToOne(() => Interaction, (interaction) => interaction.messages, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "interactionId" })
  interaction!: Interaction;

  @Column({ type: "varchar", length: 64, unique: true })
  twilioMessageSid!: string;

  @Column({ type: "varchar", length: 16 })
  direction!: SmsDirection;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "varchar", length: 32 })
  status!: SmsDeliveryStatus;

  @Column({ type: "varchar", length: 32, nullable: true })
  source?: string;

  @Column({ type: "varchar", length: 128, nullable: true })
  idempotencyKey?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

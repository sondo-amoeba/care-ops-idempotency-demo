import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Interaction } from "./interaction.entity";

@Entity("voice_sessions")
export class VoiceSession {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", unique: true })
  interactionId!: string;

  @OneToOne(() => Interaction, (interaction) => interaction.voiceSession, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "interactionId" })
  interaction!: Interaction;

  @Column({ type: "varchar", length: 64, nullable: true })
  externalCallId?: string;

  @Column({ type: "varchar", length: 32, default: "scheduled" })
  status!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { CareThread } from "./care-thread.entity";
import { VoiceSession } from "./voice-session.entity";
import { Booking } from "./booking.entity";
import { SmsMessage } from "./sms-message.entity";

@Entity("interactions")
export class Interaction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  patientId!: string;

  @Column({ type: "varchar", length: 64 })
  programId!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @OneToOne(() => CareThread, (thread) => thread.interaction, { cascade: true })
  careThread?: CareThread;

  @OneToOne(() => VoiceSession, (session) => session.interaction, { cascade: true })
  voiceSession?: VoiceSession;

  @OneToOne(() => Booking, (booking) => booking.interaction, { cascade: true })
  booking?: Booking;

  @OneToMany(() => SmsMessage, (message) => message.interaction)
  messages?: SmsMessage[];
}

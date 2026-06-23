import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Interaction } from "./interaction.entity";

@Entity("bookings")
export class Booking {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", unique: true })
  interactionId!: string;

  @OneToOne(() => Interaction, (interaction) => interaction.booking, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "interactionId" })
  interaction!: Interaction;

  @Column({ type: "timestamptz", nullable: true })
  scheduledAt?: Date;

  @Column({ type: "varchar", length: 32, default: "pending" })
  status!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

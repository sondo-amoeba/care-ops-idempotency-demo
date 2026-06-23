import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Interaction } from "./interaction.entity";

@Entity("care_threads")
export class CareThread {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", unique: true })
  interactionId!: string;

  @OneToOne(() => Interaction, (interaction) => interaction.careThread, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "interactionId" })
  interaction!: Interaction;

  @Column({ type: "varchar", length: 32, default: "open" })
  status!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

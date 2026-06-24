import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

export type CoordinatorProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "superseded";

@Entity("coordinator_proposals")
export class CoordinatorProposal {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  runId!: string;

  @Column({ type: "uuid" })
  interactionId!: string;

  @Column({ type: "varchar", length: 64 })
  templateId!: string;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "text" })
  rationale!: string;

  @Column({ type: "varchar", length: 16 })
  status!: CoordinatorProposalStatus;

  @CreateDateColumn()
  createdAt!: Date;
}

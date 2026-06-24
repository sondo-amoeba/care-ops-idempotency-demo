import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("care_context_chunks")
export class CareContextChunk {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  programId!: string;

  @Column({ type: "varchar", length: 64 })
  policyKey!: string;

  @Column({ type: "text" })
  chunkText!: string;
}

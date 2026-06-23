import { Column, Entity, PrimaryGeneratedColumn, Unique } from "typeorm";

@Entity("eligibility_rules")
@Unique(["programId", "channel", "action"])
export class EligibilityRule {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  programId!: string;

  @Column({ type: "varchar", length: 32 })
  channel!: string;

  @Column({ type: "varchar", length: 32 })
  action!: string;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;
}

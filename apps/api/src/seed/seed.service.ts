import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { CareContextChunk, EligibilityRule } from "../entities";
import { mockEmbed } from "../rag/care-context.service";

const CARE_CONTEXT_SEEDS = [
  {
    programId: "behavioral-health-outreach",
    policyKey: "confirm-window",
    chunkText:
      "Send appointment confirmation within 24 hours of voice visit completion.",
  },
  {
    programId: "behavioral-health-outreach",
    policyKey: "reschedule-hitl",
    chunkText:
      "Reschedule requests require human approval; never auto-commit new times.",
  },
  {
    programId: "behavioral-health-outreach",
    policyKey: "opt-out-handling",
    chunkText: "STOP or unsubscribe suppresses all future outbound SMS.",
  },
] as const;

@Injectable()
export class SeedService implements OnModuleInit {
  constructor(
    @InjectRepository(EligibilityRule)
    private readonly rulesRepo: Repository<EligibilityRule>,
    @InjectRepository(CareContextChunk)
    private readonly chunkRepo: Repository<CareContextChunk>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.seedEligibilityRules();
    await this.seedCareContextChunks();
  }

  private async seedEligibilityRules() {
    const count = await this.rulesRepo.count();
    if (count > 0) return;
    await this.rulesRepo.save([
      this.rulesRepo.create({
        programId: "behavioral-health-outreach",
        channel: "sms",
        action: "outbound",
        enabled: true,
      }),
      this.rulesRepo.create({
        programId: "behavioral-health-outreach",
        channel: "sms",
        action: "scheduling",
        enabled: true,
      }),
    ]);
  }

  private async seedCareContextChunks() {
    const count = await this.chunkRepo.count({
      where: { programId: "behavioral-health-outreach" },
    });
    if (count > 0) return;

    for (const seed of CARE_CONTEXT_SEEDS) {
      await this.chunkRepo.save(this.chunkRepo.create(seed));
    }

    try {
      const chunks = await this.chunkRepo.find({
        where: { programId: "behavioral-health-outreach" },
      });
      for (const chunk of chunks) {
        const embedding = mockEmbed(`${chunk.policyKey}:${chunk.chunkText}`);
        await this.dataSource.query(
          `UPDATE care_context_chunks SET embedding = $1::vector WHERE id = $2`,
          [`[${embedding.join(",")}]`, chunk.id],
        );
      }
    } catch {
      // pgvector unavailable locally — retrieval falls back to program-scoped chunks.
    }
  }
}

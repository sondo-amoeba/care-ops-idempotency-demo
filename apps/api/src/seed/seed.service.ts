import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EligibilityRule } from "../entities";

@Injectable()
export class SeedService implements OnModuleInit {
  constructor(
    @InjectRepository(EligibilityRule)
    private readonly rulesRepo: Repository<EligibilityRule>,
  ) {}

  async onModuleInit() {
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
}

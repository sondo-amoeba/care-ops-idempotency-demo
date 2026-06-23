import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EligibilityRule } from "../entities";

@Injectable()
export class EligibilityService {
  constructor(
    @InjectRepository(EligibilityRule)
    private readonly rulesRepo: Repository<EligibilityRule>,
  ) {}

  async canContact(
    patientId: string,
    programId: string,
    channel: string,
    action: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    void patientId;
    const rule = await this.rulesRepo.findOne({
      where: { programId, channel, action },
    });
    if (!rule || !rule.enabled) {
      return { allowed: false, reason: "eligibility_rule_disabled" };
    }
    return { allowed: true };
  }

  async listRules(): Promise<EligibilityRule[]> {
    return this.rulesRepo.find({ order: { programId: "ASC" } });
  }

  async upsertRule(input: {
    programId: string;
    channel: string;
    action: string;
    enabled: boolean;
  }): Promise<EligibilityRule> {
    let rule = await this.rulesRepo.findOne({
      where: {
        programId: input.programId,
        channel: input.channel,
        action: input.action,
      },
    });
    if (!rule) {
      rule = this.rulesRepo.create(input);
    } else {
      rule.enabled = input.enabled;
    }
    return this.rulesRepo.save(rule);
  }
}

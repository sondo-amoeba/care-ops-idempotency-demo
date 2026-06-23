import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { IsBoolean, IsOptional, IsString, IsUUID } from "class-validator";
import { EligibilityService } from "../eligibility/eligibility.service";
import { InteractionService } from "../interactions/interaction.service";
import { SmsService } from "../sms/sms.service";

class CreateInteractionDto {
  @IsString()
  patientId!: string;

  @IsString()
  programId!: string;
}

class SendSmsDto {
  @IsUUID()
  interactionId!: string;

  @IsString()
  patientId!: string;

  @IsString()
  programId!: string;

  @IsString()
  templateId!: string;

  @IsString()
  body!: string;

  @IsOptional()
  @IsString()
  windowStart?: string;
}

class AgentWorkflowDto {
  @IsUUID()
  interactionId!: string;

  @IsString()
  patientId!: string;

  @IsString()
  programId!: string;

  @IsString()
  templateId!: string;

  @IsString()
  body!: string;
}

class UpsertRuleDto {
  @IsString()
  programId!: string;

  @IsString()
  channel!: string;

  @IsString()
  action!: string;

  @IsBoolean()
  enabled!: boolean;
}

@Controller("care-ops")
export class CareOpsController {
  constructor(
    @Inject(InteractionService) private readonly interactions: InteractionService,
    @Inject(SmsService) private readonly sms: SmsService,
    @Inject(EligibilityService) private readonly eligibility: EligibilityService,
  ) {}

  @Post("interactions")
  createInteraction(@Body() dto: CreateInteractionDto) {
    return this.interactions.createInteraction(dto.patientId, dto.programId);
  }

  @Get("interactions")
  listInteractions() {
    return this.interactions.listInteractions();
  }

  @Get("interactions/:id")
  getInteraction(@Param("id") id: string) {
    return this.interactions.getThreadDetail(id);
  }

  @Post("sms/send")
  sendSms(@Body() dto: SendSmsDto) {
    return this.sms.sendOutbound({
      ...dto,
      source: "care_agent",
    });
  }

  @Post("agent-workflow/trigger-sms")
  triggerAgentSms(@Body() dto: AgentWorkflowDto) {
    return this.sms.sendOutbound({
      ...dto,
      source: "agent_workflow",
    });
  }

  @Get("eligibility/rules")
  listRules() {
    return this.eligibility.listRules();
  }

  @Post("eligibility/rules")
  upsertRule(@Body() dto: UpsertRuleDto) {
    return this.eligibility.upsertRule(dto);
  }

  @Get("metrics/duplicates")
  duplicateMetrics() {
    return this.sms.getDuplicateStats();
  }
}

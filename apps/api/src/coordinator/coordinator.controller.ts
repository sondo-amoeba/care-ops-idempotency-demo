import { Body, Controller, Get, Inject, Param, Post, Res } from "@nestjs/common";
import { Response } from "express";
import { IsIn, IsOptional, IsString, IsUUID } from "class-validator";
import { CoordinatorSignalType } from "../entities";
import { CoordinatorService } from "./coordinator.service";

class StartCoordinatorRunDto {
  @IsUUID()
  interactionId!: string;

  @IsIn(["manual", "lifecycle", "inbound"])
  signal!: CoordinatorSignalType;
}

class ApproveCoordinatorRunDto {
  @IsOptional()
  @IsString()
  windowStart?: string;
}

@Controller("care-ops/coordinator")
export class CoordinatorController {
  constructor(
    @Inject(CoordinatorService) private readonly coordinator: CoordinatorService,
  ) {}

  @Post("runs")
  startRun(@Body() dto: StartCoordinatorRunDto) {
    return this.coordinator.startRun(dto);
  }

  @Post("runs/:id/approve")
  approveRun(@Param("id") id: string, @Body() dto: ApproveCoordinatorRunDto) {
    return this.coordinator.approveRun(id, dto);
  }

  @Post("runs/:id/reject")
  rejectRun(@Param("id") id: string) {
    return this.coordinator.rejectRun(id);
  }

  @Get("runs/:id/trace")
  getTrace(@Param("id") id: string) {
    return this.coordinator.getTrace(id);
  }

  @Get("runs/:id")
  getRun(@Param("id") id: string) {
    return this.coordinator.getRun(id);
  }

  @Get("runs/:id/stream")
  streamTrace(@Param("id") id: string, @Res() res: Response) {
    return this.coordinator.streamTrace(id, res);
  }
}

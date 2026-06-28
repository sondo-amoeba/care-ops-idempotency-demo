import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import {
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
} from "class-validator";
import { RelayService } from "./relay.service";

class DrainDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  batchSize?: number;

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  interactionIds?: string[];
}

class ReapDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  olderThanMs?: number;

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  interactionIds?: string[];
}

/**
 * ADR-0006 relay control surface. In production the relay autodrains on a poll
 * loop; these endpoints let the demo (and tests) drive a single drain/reap tick
 * deterministically and inspect outbox state for the replay-storm visualization.
 */
@Controller("care-ops/relay")
export class RelayController {
  constructor(@Inject(RelayService) private readonly relay: RelayService) {}

  @Post("drain")
  drain(@Body() dto: DrainDto) {
    return this.relay.drainOnce({
      batchSize: dto.batchSize,
      interactionIds: dto.interactionIds,
    });
  }

  @Post("reap")
  reap(@Body() dto: ReapDto) {
    return this.relay.reapStuck({
      olderThanMs: dto.olderThanMs,
      interactionIds: dto.interactionIds,
    });
  }

  @Get("stats")
  stats(@Query("interactionId") interactionId?: string) {
    return this.relay.stats(interactionId ? [interactionId] : undefined);
  }
}

import { Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { CareContextChunk } from "../entities";

export interface RetrievedCareContextChunk {
  id: string;
  policyKey: string;
  chunkText: string;
  score: number;
}

@Injectable()
export class CareContextService {
  constructor(
    @InjectRepository(CareContextChunk)
    private readonly chunkRepo: Repository<CareContextChunk>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async retrieveCareContext(
    query: string,
    programId: string,
    k = 3,
  ): Promise<RetrievedCareContextChunk[]> {
    const embedding = mockEmbed(query);
    const vectorLiteral = `[${embedding.join(",")}]`;

    try {
      const rows: Array<{
        id: string;
        policyKey: string;
        chunkText: string;
        score: string;
      }> = await this.dataSource.query(
        `
          SELECT id, "policyKey", "chunkText",
            1 - (embedding <=> $1::vector) AS score
          FROM care_context_chunks
          WHERE "programId" = $2 AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $3
        `,
        [vectorLiteral, programId, k],
      );
      return rows.map((row) => ({
        id: row.id,
        policyKey: row.policyKey,
        chunkText: row.chunkText,
        score: Number(row.score),
      }));
    } catch {
      const chunks = await this.chunkRepo.find({
        where: { programId },
        take: k,
      });
      return chunks.map((chunk, index) => ({
        id: chunk.id,
        policyKey: chunk.policyKey,
        chunkText: chunk.chunkText,
        score: 1 - index * 0.1,
      }));
    }
  }
}

/** Deterministic mock embedding for CI and local dev without OpenAI. */
export function mockEmbed(text: string): number[] {
  const dimensions = 1536;
  const vec = new Array<number>(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    const bucket = i % dimensions;
    vec[bucket] += (text.charCodeAt(i) % 97) / 97;
  }
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vec.map((value) => value / norm);
}

import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  Booking,
  CareThread,
  Interaction,
  SmsMessage,
  VoiceSession,
} from "../entities";

@Injectable()
export class InteractionService {
  constructor(
    @InjectRepository(Interaction)
    private readonly interactionRepo: Repository<Interaction>,
    @InjectRepository(CareThread)
    private readonly threadRepo: Repository<CareThread>,
    @InjectRepository(VoiceSession)
    private readonly voiceRepo: Repository<VoiceSession>,
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
    @InjectRepository(SmsMessage)
    private readonly messageRepo: Repository<SmsMessage>,
  ) {}

  async createInteraction(patientId: string, programId: string): Promise<Interaction> {
    const interaction = await this.interactionRepo.save(
      this.interactionRepo.create({ patientId, programId }),
    );
    await this.threadRepo.save(
      this.threadRepo.create({ interactionId: interaction.id, status: "open" }),
    );
    await this.voiceRepo.save(
      this.voiceRepo.create({
        interactionId: interaction.id,
        status: "scheduled",
      }),
    );
    await this.bookingRepo.save(
      this.bookingRepo.create({
        interactionId: interaction.id,
        status: "pending",
      }),
    );
    return interaction;
  }

  async listInteractions(): Promise<
    Array<Interaction & { messageCount: number }>
  > {
    const interactions = await this.interactionRepo.find({
      order: { createdAt: "DESC" },
      take: 50,
    });
    const counts = await Promise.all(
      interactions.map(async (interaction) => ({
        ...interaction,
        messageCount: await this.messageRepo.count({
          where: { interactionId: interaction.id },
        }),
      })),
    );
    return counts;
  }

  async getThreadDetail(interactionId: string) {
    const interaction = await this.interactionRepo.findOne({
      where: { id: interactionId },
    });
    if (!interaction) {
      throw new NotFoundException("interaction_not_found");
    }
    const [careThread, voiceSession, booking, messages] = await Promise.all([
      this.threadRepo.findOne({ where: { interactionId } }),
      this.voiceRepo.findOne({ where: { interactionId } }),
      this.bookingRepo.findOne({ where: { interactionId } }),
      this.messageRepo.find({
        where: { interactionId },
        order: { createdAt: "ASC" },
      }),
    ]);
    return { interaction, careThread, voiceSession, booking, messages };
  }

  /** Idempotent lifecycle transition after patient confirms via inbound SMS. */
  async confirmFromInbound(interactionId: string): Promise<void> {
    const [careThread, voiceSession, booking] = await Promise.all([
      this.threadRepo.findOne({ where: { interactionId } }),
      this.voiceRepo.findOne({ where: { interactionId } }),
      this.bookingRepo.findOne({ where: { interactionId } }),
    ]);

    if (careThread && careThread.status !== "resolved") {
      careThread.status = "resolved";
      await this.threadRepo.save(careThread);
    }
    if (voiceSession && voiceSession.status !== "completed") {
      voiceSession.status = "completed";
      await this.voiceRepo.save(voiceSession);
    }
    if (booking && booking.status !== "confirmed") {
      booking.status = "confirmed";
      await this.bookingRepo.save(booking);
    }
  }
}

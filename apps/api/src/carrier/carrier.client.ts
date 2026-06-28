import { Injectable } from "@nestjs/common";
import { fakeTwilioSid } from "../common/idempotency.util";

export type CarrierResult =
  | { ok: true; messageSid: string }
  | { ok: false; retryable: boolean; reason: string };

/**
 * ADR-0006: the carrier boundary. Submission is now relay-owned — this is the
 * only place a carrier REST call would live. In the lab it is simulated, but it
 * models the two failure classes the relay must distinguish:
 *   - retryable (timeout / 429 / 5xx)  -> backoff + retry under the SAME key
 *   - terminal  (4xx: invalid number)  -> straight to dead_letter, no retry
 *
 * Simulation env (demo + tests):
 *   SMS_SIMULATE_SUBMISSION_FAILURE=true   -> carrier rejects
 *   SMS_SIMULATE_FAILURE_MODE=retryable|terminal  (default retryable)
 *   SMS_SIMULATE_CRASH_DURING_SUBMIT=true  -> throws AFTER the row is claimed,
 *       so the row is stranded in `submitting` and the reaper must recover it
 *       (proves the at-least-once carrier boundary).
 */
@Injectable()
export class CarrierClient {
  async submit(input: { idempotencyKey: string; body: string }): Promise<CarrierResult> {
    if (process.env.SMS_SIMULATE_CRASH_DURING_SUBMIT === "true") {
      throw new Error("simulated_crash_during_submit");
    }

    if (process.env.SMS_SIMULATE_SUBMISSION_FAILURE === "true") {
      const terminal = process.env.SMS_SIMULATE_FAILURE_MODE === "terminal";
      return terminal
        ? { ok: false, retryable: false, reason: "carrier_rejected_invalid_number" }
        : { ok: false, retryable: true, reason: "carrier_timeout" };
    }

    void input.body;
    return { ok: true, messageSid: fakeTwilioSid("out", input.idempotencyKey) };
  }
}

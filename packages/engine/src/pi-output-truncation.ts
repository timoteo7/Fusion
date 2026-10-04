import type { AgentSession } from "@earendil-works/pi-coding-agent";

const MAX_OUTPUT_TRUNCATIONS = 3;
const OUTPUT_RECOVERY_GUIDANCE = [
  "The response hit the output token limit. Use smaller, complete targeted outputs and tool arguments.",
  "Do not repeat a full oversized document or submit partial tool arguments.",
  "Preserve required headings (including ## Steps and ### Step headings), verification gates and their evidence.",
  "Do not publish placeholders or weaken required checks to fit the output budget.",
].join(" ");

function outputLimitError(count: number): Error {
  return new Error(
    `Pi output token limit reached ${count} time(s) without a complete response. `
    + "Use smaller complete outputs, or check the exact model metadata and approved output budget before retrying. "
    + "Required headings and verification gates must remain intact.",
  );
}

/**
 * Bound SDK-internal truncated-tool retries without executing partial arguments.
 * Own prompt, steering hooks and abort until they settle before caller teardown.
 * An in-process runtime that cannot cancel may block; a deadline cannot stop its work.
 */
export async function promptWithOutputTruncationGuard(
  session: AgentSession,
  runPrompt: () => Promise<void>,
): Promise<void> {
  // Non-Pi runtime adapters do not necessarily expose Pi events.
  if (typeof session.subscribe !== "function") {
    await runPrompt();
    return;
  }

  let truncations = 0;
  let lastAssistantWasTruncated = false;
  let failure: Error | undefined;
  let abortDrain: Promise<boolean> | undefined;
  let active = true;
  const steering: Promise<void>[] = [];
  const stop = () => {
    if (!active || failure) return;
    failure = outputLimitError(truncations);
    // Request cancellation synchronously. Native abort waits for idle, so never
    // await it inside an SDK event callback. A rejected abort cannot hide failure.
    try {
      abortDrain = Promise.resolve(session.abort()).then(() => true, () => false);
    } catch {
      abortDrain = Promise.resolve(false);
    }
  };

  const unsubscribe = session.subscribe((event) => {
    if (!active || failure || event.type !== "message_end" || event.message.role !== "assistant") return;
    lastAssistantWasTruncated = event.message.stopReason === "length";
    if (!lastAssistantWasTruncated) return;
    truncations++;
    if (truncations >= MAX_OUTPUT_TRUNCATIONS) {
      stop();
      return;
    }
    try {
      // Native steer queues recovery before the next SDK-internal turn. Handle
      // both rejection and synchronous throws; never leave callback rejections.
      steering.push(Promise.resolve(session.steer(OUTPUT_RECOVERY_GUIDANCE)).catch(stop));
    } catch {
      stop();
    }
  });

  try {
    // Native prompt owns awaited turn/tool hooks. Do not race away from it:
    // caller cleanup (and retry) is safe only after that work actually settles.
    await runPrompt();
    await Promise.all(steering);
    if (failure) throw failure;
    if (lastAssistantWasTruncated) throw outputLimitError(truncations);
  } catch (error) {
    // Steering input hooks are separate from native prompt work. Retain their
    // rejection handlers and ownership even when the prompt itself rejects.
    await Promise.all(steering);
    // Cancellation can race a provider/context error. Exhaustion stays terminal.
    throw failure ?? error;
  } finally {
    if (failure && abortDrain && !await abortDrain) {
      failure.message += " Cancellation is unconfirmed; stop this session before retrying.";
    }
    active = false;
    if (typeof unsubscribe === "function") unsubscribe();
  }
}

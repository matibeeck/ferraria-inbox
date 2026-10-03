import "server-only";
import { PostHog } from "posthog-node";

let posthogClient: PostHog | null | undefined;

function getPostHogClient(): PostHog | null {
  if (posthogClient !== undefined) return posthogClient;

  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is configured"
      );
    }
    posthogClient = null;
    return posthogClient;
  }

  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (!host) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        "NEXT_PUBLIC_POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_HOST is configured"
      );
    }
    posthogClient = null;
    return posthogClient;
  }

  posthogClient = new PostHog(token, {
    host,
    flushAt: 1,
    flushInterval: 0,
    // Solo lo leen los wrappers de @posthog/ai (hoy no instalados); el capture
    // manual de abajo no lo aplica, por eso ahí nunca se pasa texto.
    privacyMode: true,
  });
  return posthogClient;
}

/**
 * Captures the synchronous summary result exposed by the custom engine.
 * The engine does not expose its underlying model, provider, prompt, or token
 * usage, so those fields are intentionally not fabricated here.
 */
export async function captureConversationSummaryGeneration(input: {
  distinctId: string;
  conversationId: string;
  hotelId: string;
  traceId: string;
  summaryAvailable: boolean;
  httpStatus: number;
  latencyMs: number;
}): Promise<void> {
  const posthog = getPostHogClient();
  if (!posthog) return;

  try {
    posthog.capture({
      distinctId: input.distinctId,
      event: "$ai_generation",
      groups: { hotel: input.hotelId },
      properties: {
        $ai_trace_id: input.traceId,
        $ai_session_id: `conversation-${input.conversationId}`,
        $ai_span_name: "conversation_summary",
        $ai_latency: input.latencyMs / 1000,
        $ai_http_status: input.httpStatus,
        $ai_is_error: input.httpStatus < 200 || input.httpStatus >= 300,
        // El texto del resumen es contenido de la conversación: solo viaja si hubo.
        summary_available: input.summaryAvailable,
      },
    });
    await posthog.flush();
  } catch (error) {
    console.error("[posthog-ai] conversation summary capture failed", error);
  }
}

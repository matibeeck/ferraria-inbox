import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";

let loggerProvider: LoggerProvider | null | undefined;

function getLoggerProvider(): LoggerProvider | null {
  if (loggerProvider !== undefined) return loggerProvider;

  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is configured"
      );
    }
    loggerProvider = null;
    return loggerProvider;
  }

  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (!host) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        "NEXT_PUBLIC_POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_HOST is configured"
      );
    }
    loggerProvider = null;
    return loggerProvider;
  }

  loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "ferraria-inbox" }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${host.replace(/\/$/, "")}/i/v1/logs`,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }),
      }),
    ],
  });

  return loggerProvider;
}

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const provider = getLoggerProvider();
    if (provider) logs.setGlobalLoggerProvider(provider);
  }
}

const posthogSummaryLoggerName = "posthog-summary-generation";

export function emitPostHogSummaryLog(
  body: string,
  attributes: Record<string, boolean | number | string>
): void {
  // Corre dentro de la ruta del resumen: si PostHog no está configurado en
  // desarrollo, el resumen tiene que salir igual.
  let provider: LoggerProvider | null;
  try {
    provider = getLoggerProvider();
  } catch {
    return;
  }
  if (!provider) return;

  provider.getLogger(posthogSummaryLoggerName).emit({
    body,
    severityNumber: SeverityNumber.INFO,
    attributes,
  });
}

export async function flushPostHogLogs(): Promise<void> {
  await getLoggerProvider()?.forceFlush();
}

import posthog from "posthog-js";

const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

// Atributos donde la bandeja pone texto del huésped (el `alt` de una imagen es
// su caption) o URLs firmadas de sus archivos. El resto (class, style, role…)
// queda para que la grabación conserve la maqueta.
const SENSITIVE_REPLAY_ATTRIBUTES = new Set([
  "alt",
  "title",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "placeholder",
  "value",
  "href",
  "src",
  "srcset",
  "poster",
  "download",
  "content",
]);

function isSensitiveReplayAttribute(name: string, element?: Element): boolean {
  // Las hojas de estilo se cargan por <link href>: taparlas deja la grabación sin estilos.
  if (element?.tagName === "LINK") return false;
  return SENSITIVE_REPLAY_ATTRIBUTES.has(name) || name.startsWith("data-");
}

if (!projectToken) {
  if (process.env.NODE_ENV === "development") {
    throw new Error(
      "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is configured",
    );
  }
} else if (!host) {
  if (process.env.NODE_ENV === "development") {
    throw new Error(
      "NEXT_PUBLIC_POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_HOST is configured",
    );
  }
} else {
  posthog.init(projectToken, {
    api_host: host,
    tracing_headers: [window.location.hostname],
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: process.env.NODE_ENV === "development",
    // Autocapture y heatmaps: sin el texto ni los atributos del elemento
    // cliqueado, que en la bandeja es una burbuja con el mensaje del huésped.
    mask_all_text: true,
    mask_all_element_attributes: true,
    enable_recording_console_log: false,
    // Sin tiempos de red en la grabación: guardarían la URL completa de cada
    // petición, incluidas las firmadas de las fotos y PDFs del huésped.
    capture_performance: false,
    session_recording: {
      maskAllInputs: true,
      // Equivale a maskAllText: todo nodo de texto sale enmascarado.
      maskTextSelector: "*",
      // Fotos, videos, audios y PDFs que manda el huésped: el enmascarado de
      // texto no los tapa y su `src` es una URL firmada que abriría el archivo.
      blockSelector: "img, video, audio, canvas, iframe, object, embed",
      maskAttributeFn: (name, value, element) =>
        isSensitiveReplayAttribute(name, element) ? "*" : value,
      recordHeaders: false,
      recordBody: false,
    },
  });
}

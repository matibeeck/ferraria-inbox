"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { createClient } from "@/lib/supabase/client";
import { BrandHeaderMark } from "../components/BrandHeaderMark";

function sanitizeNextPath(raw: string | null | undefined) {
  const t = raw?.trim() || "/";
  return t.startsWith("/") && !t.startsWith("//") ? t : "/";
}

/** Traduce el error crudo de Supabase Auth a un mensaje propio en español.
 *  No se expone nunca el message/details/hint crudo al usuario (hallazgo B-1). */
function mapAuthError(rawMessage: string): string {
  const msg = rawMessage.toLowerCase();
  if (msg.includes("request rate limit reached")) {
    return "Demasiados intentos. Espera unos minutos e intenta de nuevo.";
  }
  if (msg.includes("invalid login credentials")) {
    return "Correo o contraseña incorrectos.";
  }
  return "No se pudo iniciar sesión. Revisa tus datos e intenta de nuevo.";
}

export function LoginForm() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const {
        data: { user },
        error: signError,
      } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signError) {
        setLoading(false);
        setError(mapAuthError(signError.message));
        return;
      }

      if (user && process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST) {
        posthog.identify(user.id);
        posthog.capture("user_logged_in");
      }

      // Éxito: NO llamamos setLoading(false) a propósito. Dejamos loading=true
      // y el redirect desmonta el componente, eliminando la ventana de
      // re-disparo del submit entre setLoading(false) y la navegación.
      const params = new URLSearchParams(window.location.search);
      const next = sanitizeNextPath(params.get("next"));
      router.push(next);
      router.refresh();
    } catch {
      // La promesa rechazó (fallo de red, etc.): rehabilitamos el botón para
      // que no quede colgado en "Entrando…" para siempre.
      setLoading(false);
      setError("Error de conexión. Revisa tu internet e intenta de nuevo.");
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="w-full max-w-[380px] overflow-hidden rounded-2xl border shadow-[0_18px_50px_-20px_color-mix(in_srgb,var(--accent)_35%,transparent)]"
      style={{ borderColor: "var(--line)", background: "var(--bg-card)" }}
    >
      <div
        className="flex items-center gap-3 px-6 py-5"
        style={{
          background: "var(--accent)",
          boxShadow: "0 1px 8px color-mix(in srgb, var(--accent) 25%, transparent)",
        }}
      >
        <BrandHeaderMark size="sm" />
        <div className="min-w-0">
          <div className="grotesk truncate text-[18px] font-bold tracking-tight text-white">
            Ferrar<span style={{ color: "rgba(255,255,255,.82)" }}>IA</span>
          </div>
          <p className="truncate text-[12px] leading-tight text-white/80">Inbox de recepción</p>
        </div>
      </div>

      <div className="space-y-5 p-8">
        <div className="space-y-1">
          <h1 className="grotesk text-lg font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
            Iniciar sesión
          </h1>
          <p className="text-[13px]" style={{ color: "var(--ink-2)" }}>
            Accede al inbox con tu cuenta de FerrarIA.
          </p>
        </div>

        {error && (
          <div
            className="rounded-lg px-3 py-2 text-[13px]"
            style={{ border: "1px solid var(--accent)", background: "var(--red-soft)", color: "var(--accent)" }}
          >
            {error}
          </div>
        )}

        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--ink-2)" }}>
              Email
            </span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl px-3 py-2.5 text-[14px] outline-none transition focus:ring-2 focus:ring-[var(--accent)]/25"
              style={{ border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink)" }}
              placeholder="tu@email.com"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--ink-2)" }}>
              Contraseña
            </span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl px-3 py-2.5 text-[14px] outline-none transition focus:ring-2 focus:ring-[var(--accent)]/25"
              style={{ border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink)" }}
              placeholder="••••••••"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="grotesk flex w-full items-center justify-center rounded-xl py-2.5 text-[14px] font-semibold text-white shadow-md transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            background: "linear-gradient(100deg, var(--accent) 0%, var(--accent) 100%)",
            boxShadow: "0 6px 16px -6px color-mix(in srgb, var(--accent) 50%, transparent)",
          }}
        >
          {loading ? "Entrando…" : "Entrar"}
        </button>
      </div>
    </form>
  );
}

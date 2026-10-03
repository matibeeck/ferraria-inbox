"use client";

import { FormEvent, useState } from "react";
import posthog from "posthog-js";

type FeedbackModalProps = {
  open: boolean;
  activeHotelId: string | null;
  onClose: () => void;
  onSuccess: () => void;
};

const CATEGORIES: { id: "suggestion" | "bug" | "other"; label: string }[] = [
  { id: "suggestion", label: "Sugerencia" },
  { id: "bug", label: "Problema" },
  { id: "other", label: "Otro" },
];

const MESSAGE_MAX_LENGTH = 2000;

export function FeedbackModal({ open, activeHotelId, onClose, onSuccess }: FeedbackModalProps) {
  const [category, setCategory] = useState<"suggestion" | "bug" | "other">("suggestion");
  const [rating, setRating] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setCategory("suggestion");
    setRating(null);
    setMessage("");
    setError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) {
      setError("Escribe tu comentario antes de enviar.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          category,
          rating,
          hotelId: activeHotelId,
          pageUrl: typeof window !== "undefined" ? window.location.href : undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(j.error ?? "No se pudo enviar el feedback");
        return;
      }
      if (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST) {
        posthog.capture("feedback_submitted", {
          category,
          has_rating: rating !== null,
        });
      }
      reset();
      onSuccess();
      onClose();
    } catch {
      setError("Error de red al enviar el feedback");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[260]" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
      <button
        type="button"
        className="absolute inset-0 backdrop-blur-sm"
        style={{ background: "color-mix(in srgb, var(--ink) 35%, transparent)" }}
        aria-label="Cerrar modal"
        onClick={handleClose}
      />
      <div
        className="absolute left-1/2 top-1/2 flex max-h-[calc(100dvh-2rem)] w-[min(calc(100vw-2rem),28rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl"
        style={{ border: "1px solid var(--line)", background: "var(--bg-card)", boxShadow: "var(--shadow-lg)" }}
      >
        <div
          className="px-5 py-4"
          style={{ background: "var(--accent)" }}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-white/80">FerrarIA</p>
          <h2 id="feedback-title" className="grotesk mt-1 text-lg font-bold tracking-tight text-white">
            Enviar feedback
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-white/85">
            Contanos qué mejorar, qué falla o qué te gustaría ver.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="min-h-0 space-y-4 overflow-y-auto px-5 py-5 scrollbar-app">
          <div>
            <span className="mb-1.5 block text-[12px] font-semibold" style={{ color: "var(--ink-2)" }}>
              Tipo
            </span>
            <div className="flex gap-1.5">
              {CATEGORIES.map((cat) => {
                const active = category === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setCategory(cat.id)}
                    className="grotesk flex-1 rounded-xl px-3 py-2 text-[13px] font-semibold transition"
                    style={
                      active
                        ? { border: "1px solid var(--accent)", background: "var(--red-soft)", color: "var(--accent)" }
                        : { border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink-2)" }
                    }
                    aria-pressed={active}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-[12px] font-semibold" style={{ color: "var(--ink-2)" }}>
              ¿Cómo calificarías la experiencia? <span style={{ color: "var(--ink-3)" }}>(opcional)</span>
            </span>
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((value) => {
                const active = rating !== null && value <= rating;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRating((prev) => (prev === value ? null : value))}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-[15px] transition"
                    style={{
                      border: `1px solid ${active ? "var(--gold)" : "var(--line)"}`,
                      background: active ? "var(--gold-soft)" : "var(--bg-card)",
                      color: active ? "var(--gold)" : "var(--ink-3)",
                    }}
                    aria-label={`${value} de 5`}
                    aria-pressed={active}
                  >
                    ★
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="feedback-message" className="mb-1.5 block text-[12px] font-semibold" style={{ color: "var(--ink-2)" }}>
              Comentario
            </label>
            <textarea
              id="feedback-message"
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                setError(null);
              }}
              maxLength={MESSAGE_MAX_LENGTH}
              placeholder="Escribe aquí tu comentario…"
              className="min-h-28 w-full resize-none rounded-xl px-3.5 py-3 text-[14px] shadow-sm outline-none transition focus:ring-2 focus:ring-[var(--accent)]/25"
              style={{ border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink)" }}
              disabled={submitting}
            />
            <p className="mt-1 text-right text-[11px]" style={{ color: "var(--ink-3)" }}>
              {message.length}/{MESSAGE_MAX_LENGTH}
            </p>
          </div>

          {error && (
            <p
              className="rounded-lg px-3 py-2 text-[12px]"
              style={{ border: "1px solid var(--accent)", background: "var(--red-soft)", color: "var(--accent)" }}
            >
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="rounded-xl px-4 py-2.5 text-[13px] font-semibold shadow-sm transition hover:bg-[var(--bg-app)] disabled:cursor-not-allowed disabled:opacity-60"
              style={{ border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink-2)" }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              aria-busy={submitting}
              className="grotesk rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-md transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                background: "linear-gradient(100deg, var(--accent) 0%, var(--accent) 100%)",
                boxShadow: "0 6px 16px -6px color-mix(in srgb, var(--accent) 50%, transparent)",
              }}
            >
              {submitting ? "Enviando…" : "Enviar feedback"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

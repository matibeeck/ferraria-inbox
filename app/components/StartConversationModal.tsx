"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import posthog from "posthog-js";
import { sendWhatsappTemplate } from "@/lib/send-whatsapp-template";
import type { MessageTemplate } from "@/lib/message-templates";
import { normalizeColombianWhatsappNumber } from "@/lib/whatsapp-templates";

type StartConversationModalProps = {
  open: boolean;
  activeHotelId: string | null;
  onClose: () => void;
  onSuccess: () => void;
  /** `message` trae el motivo real de Meta cuando el engine lo propaga. */
  onError: (message?: string) => void;
  /**
   * Teléfono con el que abre el campo, para cuando el modal se lanza desde una
   * conversación que ya se sabe de quién es (botón de fuera de ventana de 24 h).
   *
   * OPCIONAL y retrocompatible: sin él, el modal arranca vacío exactamente como
   * antes. Queda editable a propósito — prellenar es un atajo, no un candado.
   */
  initialPhone?: string;
};

export function StartConversationModal({
  open,
  activeHotelId,
  onClose,
  onSuccess,
  onError,
  initialPhone,
}: StartConversationModalProps) {
  const [phone, setPhone] = useState("");
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState<string>("");
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.name === templateName) ?? null,
    [templates, templateName]
  );

  // Carga las plantillas del hotel activo cada vez que se abre el modal.
  useEffect(() => {
    if (!open) return;
    const hotelId = activeHotelId?.trim();
    if (!hotelId) {
      setTemplates([]);
      setTemplatesError("Selecciona un hotel para ver las plantillas.");
      return;
    }

    let cancelled = false;
    setTemplatesLoading(true);
    setTemplatesError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/message-templates?hotelId=${encodeURIComponent(hotelId)}`);
        const j = (await res.json().catch(() => ({}))) as {
          templates?: MessageTemplate[];
          error?: string;
        };
        if (!res.ok) throw new Error(j.error ?? "No se pudieron cargar las plantillas");
        if (cancelled) return;
        const list = j.templates ?? [];
        setTemplates(list);
        setTemplateName((prev) =>
          list.some((template) => template.name === prev) ? prev : list[0]?.name ?? ""
        );
      } catch (e) {
        if (cancelled) return;
        setTemplates([]);
        setTemplatesError(e instanceof Error ? e.message : "No se pudieron cargar las plantillas");
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, activeHotelId]);

  // Al abrir, el campo arranca en `initialPhone` (o vacío, que es el
  // comportamiento de siempre); al cerrar se limpia todo.
  useEffect(() => {
    if (open) {
      setPhone(initialPhone?.trim() ?? "");
      setValidationError(null);
      return;
    }
    setPhone("");
    setTemplateVariables({});
    setValidationError(null);
  }, [open, initialPhone]);

  useEffect(() => {
    setTemplateVariables({});
    setValidationError(null);
  }, [templateName]);

  if (!open) {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const normalizedPhone = normalizeColombianWhatsappNumber(phone);
    if (!normalizedPhone) {
      setValidationError("Ingresa un número de WhatsApp.");
      return;
    }

    const hotelId = activeHotelId?.trim();
    if (!hotelId) {
      setValidationError("Selecciona un hotel antes de enviar la plantilla.");
      return;
    }

    if (!selectedTemplate) {
      setValidationError("Selecciona una plantilla.");
      return;
    }

    const variables: Record<string, string> = {};
    for (const variable of selectedTemplate.variables) {
      const value = templateVariables[variable.key]?.trim() ?? "";
      if (!value) {
        setValidationError(`Completa el campo "${variable.label}".`);
        return;
      }
      variables[variable.key] = value;
    }

    setSubmitting(true);
    setValidationError(null);
    try {
      await sendWhatsappTemplate({
        to: normalizedPhone,
        templateName: selectedTemplate.name,
        activeHotelId: hotelId,
        ...(selectedTemplate.variables.length > 0 ? { variables } : {}),
      });
      if (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST) {
        posthog.capture("whatsapp_template_sent", {
          has_template_variables: selectedTemplate.variables.length > 0,
        });
      }
      setPhone("");
      setTemplateVariables({});
      onSuccess();
      onClose();
    } catch (e) {
      const motivo = e instanceof Error ? e.message : undefined;
      onError(motivo);
      // Además del toast: el toast se autodestruye y el modal queda abierto con
      // el número mal escrito y sin decir por qué. La cajita roja está pegada al
      // campo y se queda hasta que se corrija.
      setValidationError(motivo ?? "No se pudo enviar la plantilla.");
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = { border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink)" };

  return (
    <div className="fixed inset-0 z-[250]" role="dialog" aria-modal="true" aria-labelledby="start-conversation-title">
      <button
        type="button"
        className="absolute inset-0 backdrop-blur-sm"
        style={{ background: "color-mix(in srgb, var(--ink) 35%, transparent)" }}
        aria-label="Cerrar modal"
        onClick={submitting ? undefined : onClose}
      />
      <div
        className="absolute left-1/2 top-1/2 flex max-h-[calc(100dvh-2rem)] w-[min(calc(100vw-2rem),28rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl"
        style={{ border: "1px solid var(--line)", background: "var(--bg-card)", boxShadow: "var(--shadow-lg)" }}
      >
        <div
          className="px-5 py-4"
          style={{
            background: "var(--accent)",
          }}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-white/80">
            WhatsApp Business
          </p>
          <h2 id="start-conversation-title" className="grotesk mt-1 text-lg font-bold tracking-tight text-white">
            Comenzar conversación
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-white/85">
            Envía una plantilla aprobada para abrir un nuevo hilo con el huésped.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="min-h-0 space-y-4 overflow-y-auto px-5 py-5 scrollbar-app">
          <div>
            <label htmlFor="start-whatsapp-phone" className="mb-1.5 block text-[12px] font-semibold" style={{ color: "var(--ink-2)" }}>
              Número de WhatsApp
            </label>
            <input
              id="start-whatsapp-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                setValidationError(null);
              }}
              placeholder="Ej: 573001234567"
              className="w-full rounded-xl px-3.5 py-3 text-base shadow-sm outline-none transition focus:ring-2 focus:ring-[var(--accent)]/25 lg:text-[14px]"
              style={inputStyle}
              disabled={submitting}
            />
            <p className="mt-1.5 text-[11px]" style={{ color: "var(--ink-3)" }}>
              Un celular colombiano de 10 dígitos que empiece en 3 se completa solo. Cualquier otro número necesita el
              indicativo del país, por ejemplo 34612345678.
            </p>
            {validationError && (
              <p
                className="mt-2 rounded-lg px-3 py-2 text-[12px]"
                style={{ border: "1px solid var(--accent)", background: "var(--red-soft)", color: "var(--accent)" }}
              >
                {validationError}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="start-whatsapp-template" className="mb-1.5 block text-[12px] font-semibold" style={{ color: "var(--ink-2)" }}>
              Plantilla
            </label>
            {templatesLoading ? (
              <div
                className="rounded-xl px-3.5 py-3 text-[13px]"
                style={{ border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink-2)" }}
              >
                Cargando plantillas…
              </div>
            ) : templatesError ? (
              <div
                className="rounded-xl px-3.5 py-3 text-[13px]"
                style={{ border: "1px solid var(--accent)", background: "var(--red-soft)", color: "var(--accent)" }}
              >
                {templatesError}
              </div>
            ) : templates.length === 0 ? (
              <div
                className="rounded-xl px-3.5 py-3 text-[13px]"
                style={{ border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink-2)" }}
              >
                Este hotel no tiene plantillas activas configuradas.
              </div>
            ) : (
              <select
                id="start-whatsapp-template"
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                className="w-full cursor-pointer appearance-none rounded-xl py-3 pl-3.5 pr-10 text-[14px] shadow-sm outline-none transition focus:ring-2 focus:ring-[var(--accent)]/25"
                style={{
                  ...inputStyle,
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236b6259'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 0.75rem center",
                  backgroundSize: "1rem",
                }}
                disabled={submitting}
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.name}>
                    {template.title}
                  </option>
                ))}
              </select>
            )}
          </div>

          {selectedTemplate && selectedTemplate.bodyTemplate && (
            <div
              className="rounded-2xl p-3.5"
              style={{ border: "1px solid var(--line)", background: "var(--bg-app)" }}
            >
              <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--ink-3)" }}>
                Vista previa
              </p>
              <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed" style={{ color: "var(--ink)" }}>
                {selectedTemplate.bodyTemplate}
              </p>
              {selectedTemplate.footer && (
                <p className="mt-2 text-[11px]" style={{ color: "var(--ink-3)" }}>
                  {selectedTemplate.footer}
                </p>
              )}
            </div>
          )}

          {selectedTemplate && selectedTemplate.variables.length > 0 && (
            <div className="space-y-3 rounded-2xl p-3.5" style={{ border: "1px solid var(--line)", background: "var(--bg-app)" }}>
              <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--ink-3)" }}>
                Variables de plantilla
              </p>
              {selectedTemplate.variables.map((variable) => (
                <div key={variable.key}>
                  <label
                    htmlFor={`start-template-variable-${variable.key}`}
                    className="mb-1.5 block text-[12px] font-semibold"
                    style={{ color: "var(--ink-2)" }}
                  >
                    {variable.label}
                  </label>
                  <input
                    id={`start-template-variable-${variable.key}`}
                    type="text"
                    value={templateVariables[variable.key] ?? ""}
                    onChange={(event) => {
                      setTemplateVariables((current) => ({
                        ...current,
                        [variable.key]: event.target.value,
                      }));
                      setValidationError(null);
                    }}
                    placeholder={variable.placeholder}
                    className="w-full rounded-xl px-3.5 py-3 text-base shadow-sm outline-none transition focus:ring-2 focus:ring-[var(--accent)]/25 lg:text-[14px]"
                    style={{ border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink)" }}
                    disabled={submitting}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl px-4 py-2.5 text-[13px] font-semibold shadow-sm transition hover:bg-[var(--bg-app)] disabled:cursor-not-allowed disabled:opacity-60"
              style={{ border: "1px solid var(--line)", background: "var(--bg-card)", color: "var(--ink-2)" }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || templatesLoading || !selectedTemplate}
              aria-busy={submitting}
              className="grotesk rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-md transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                background: "linear-gradient(100deg, var(--accent) 0%, var(--accent) 100%)",
                boxShadow: "0 6px 16px -6px color-mix(in srgb, var(--accent) 50%, transparent)",
              }}
            >
              {submitting ? "Enviando..." : "Enviar plantilla"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

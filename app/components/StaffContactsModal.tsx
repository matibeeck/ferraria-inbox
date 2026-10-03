"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import posthog from "posthog-js";
import { formatStaffPhone, type StaffContact } from "@/lib/staff-contacts";

/**
 * Gestión de los contactos del personal del hotel.
 *
 * Todo pasa por `/api/staff-contacts`: la tabla tiene la RLS cerrada a escritura,
 * así que desde el navegador NUNCA se escribe directo a Supabase. El teléfono se
 * normaliza en el servidor; acá solo se muestra la ayuda de formato.
 */
type StaffContactsModalProps = {
  open: boolean;
  activeHotelId: string | null;
  onClose: () => void;
};

const inputStyle = {
  border: "1px solid var(--line)",
  background: "var(--bg-card)",
  color: "var(--ink)",
};

const inputClass =
  "w-full rounded-xl px-3.5 py-2.5 text-base shadow-sm outline-none transition focus:ring-2 focus:ring-[var(--accent)]/25 lg:text-[14px]";

export function StaffContactsModal({ open, activeHotelId, onClose }: StaffContactsModalProps) {
  const [contacts, setContacts] = useState<StaffContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const hotelId = activeHotelId?.trim() ?? "";

  const loadContacts = useCallback(async () => {
    if (!hotelId) {
      setContacts([]);
      setLoadError("Selecciona un hotel para ver los contactos.");
      return;
    }

    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/staff-contacts?hotelId=${encodeURIComponent(hotelId)}`);
      const json = (await res.json().catch(() => ({}))) as {
        contacts?: StaffContact[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "No se pudieron cargar los contactos");
      setContacts(json.contacts ?? []);
    } catch (e) {
      setContacts([]);
      setLoadError(e instanceof Error ? e.message : "No se pudieron cargar los contactos");
    } finally {
      setLoading(false);
    }
  }, [hotelId]);

  useEffect(() => {
    if (!open) return;
    void loadContacts();
  }, [open, loadContacts]);

  useEffect(() => {
    if (open) return;
    setName("");
    setPhone("");
    setRole("");
    setFormError(null);
    setNotice(null);
    setRowError(null);
    setEditingId(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const upsertLocal = (contact: StaffContact) => {
    setContacts((current) => {
      const exists = current.some((item) => item.id === contact.id);
      const next = exists
        ? current.map((item) => (item.id === contact.id ? contact : item))
        : [...current, contact];
      return next.sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return a.name.localeCompare(b.name, "es");
      });
    });
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setNotice(null);

    if (!hotelId) {
      setFormError("Selecciona un hotel antes de agregar contactos.");
      return;
    }
    if (!name.trim()) {
      setFormError("Escribe el nombre del contacto.");
      return;
    }
    if (!phone.trim()) {
      setFormError("Escribe el número de WhatsApp.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/staff-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotelId,
          name: name.trim(),
          phone: phone.trim(),
          role: role.trim() || null,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        contact?: StaffContact;
        error?: string;
      };
      if (!res.ok || !json.contact) {
        throw new Error(json.error ?? "No se pudo guardar el contacto");
      }
      upsertLocal(json.contact);
      if (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST) {
        posthog.capture("staff_contact_created", {
          has_role: Boolean(role.trim()),
        });
      }
      setName("");
      setPhone("");
      setRole("");
      setNotice("Contacto agregado.");
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "No se pudo guardar el contacto");
    } finally {
      setSubmitting(false);
    }
  };

  const patchContact = async (
    contactId: string,
    payload: { name?: string; role?: string | null; isActive?: boolean },
    successMessage: string
  ) => {
    setRowError(null);
    setNotice(null);
    setBusyId(contactId);
    try {
      const res = await fetch(`/api/staff-contacts/${encodeURIComponent(contactId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelId, ...payload }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        contact?: StaffContact;
        error?: string;
      };
      if (!res.ok || !json.contact) {
        throw new Error(json.error ?? "No se pudo actualizar el contacto");
      }
      upsertLocal(json.contact);
      if (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST) {
        posthog.capture("staff_contact_updated", {
          change_type: payload.isActive === undefined ? "details" : "active_status",
        });
      }
      setEditingId(null);
      setNotice(successMessage);
    } catch (e) {
      setRowError(e instanceof Error ? e.message : "No se pudo actualizar el contacto");
    } finally {
      setBusyId(null);
    }
  };

  const startEditing = (contact: StaffContact) => {
    setRowError(null);
    setNotice(null);
    setEditingId(contact.id);
    setEditName(contact.name);
    setEditRole(contact.role ?? "");
  };

  const saveEditing = (contact: StaffContact) => {
    if (!editName.trim()) {
      setRowError("El nombre no puede quedar vacío.");
      return;
    }
    void patchContact(
      contact.id,
      { name: editName.trim(), role: editRole.trim() || null },
      "Contacto actualizado."
    );
  };

  return (
    <div
      className="fixed inset-0 z-[250]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="staff-contacts-title"
    >
      <button
        type="button"
        className="absolute inset-0 backdrop-blur-sm"
        style={{ background: "color-mix(in srgb, var(--ink) 35%, transparent)" }}
        aria-label="Cerrar contactos del staff"
        onClick={submitting ? undefined : onClose}
      />
      <div
        className="absolute left-1/2 top-1/2 flex max-h-[calc(100dvh-2rem)] w-[min(calc(100vw-2rem),34rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl"
        style={{
          border: "1px solid var(--line)",
          background: "var(--bg-card)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div
          className="shrink-0 px-5 py-4"
          style={{
            background: "var(--accent)",
          }}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-white/80">
            Personal del hotel
          </p>
          <h2
            id="staff-contacts-title"
            className="grotesk mt-1 text-lg font-bold tracking-tight text-white"
          >
            Contactos del staff
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-white/85">
            Los números registrados acá se tratan como personal del hotel, no como huéspedes.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-app)] px-5 py-5 scrollbar-app">
          {notice && (
            <p
              className="mb-3 rounded-xl px-3 py-2 text-[12px]"
              style={{
                border: "1px solid color-mix(in srgb, var(--gold) 45%, transparent)",
                background: "color-mix(in srgb, var(--gold) 12%, transparent)",
                color: "var(--ink)",
              }}
            >
              {notice}
            </p>
          )}

          <form onSubmit={handleCreate} className="space-y-3">
            <div>
              <label
                htmlFor="staff-contact-name"
                className="mb-1.5 block text-[12px] font-semibold"
                style={{ color: "var(--ink-2)" }}
              >
                Nombre
              </label>
              <input
                id="staff-contact-name"
                type="text"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setFormError(null);
                }}
                placeholder="Ej: Ana Recepción"
                className={inputClass}
                style={inputStyle}
                disabled={submitting}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="staff-contact-phone"
                  className="mb-1.5 block text-[12px] font-semibold"
                  style={{ color: "var(--ink-2)" }}
                >
                  WhatsApp
                </label>
                <input
                  id="staff-contact-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => {
                    setPhone(event.target.value);
                    setFormError(null);
                  }}
                  placeholder="Ej: +57 300 123 4567"
                  className={inputClass}
                  style={inputStyle}
                  disabled={submitting}
                />
                <p className="mt-1.5 text-[11px]" style={{ color: "var(--ink-3)" }}>
                  Puedes escribirlo con +57, espacios o guiones: se ajusta solo.
                </p>
              </div>

              <div>
                <label
                  htmlFor="staff-contact-role"
                  className="mb-1.5 block text-[12px] font-semibold"
                  style={{ color: "var(--ink-2)" }}
                >
                  Cargo <span style={{ color: "var(--ink-3)" }}>(opcional)</span>
                </label>
                <input
                  id="staff-contact-role"
                  type="text"
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  placeholder="Ej: Recepción"
                  className={inputClass}
                  style={inputStyle}
                  disabled={submitting}
                />
              </div>
            </div>

            {formError && (
              <p
                className="rounded-lg px-3 py-2 text-[12px]"
                style={{
                  border: "1px solid var(--accent)",
                  background: "var(--red-soft)",
                  color: "var(--accent)",
                }}
              >
                {formError}
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={submitting || !hotelId}
                aria-busy={submitting}
                className="grotesk rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-md transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
                style={{
                  background: "linear-gradient(100deg, var(--accent) 0%, var(--accent) 100%)",
                  boxShadow: "0 6px 16px -6px color-mix(in srgb, var(--accent) 50%, transparent)",
                }}
              >
                {submitting ? "Guardando..." : "Agregar contacto"}
              </button>
            </div>
          </form>

          <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--line)" }}>
            <p
              className="text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--ink-3)" }}
            >
              Registrados ({contacts.length})
            </p>

            {rowError && (
              <p
                className="mt-2 rounded-lg px-3 py-2 text-[12px]"
                style={{
                  border: "1px solid var(--accent)",
                  background: "var(--red-soft)",
                  color: "var(--accent)",
                }}
              >
                {rowError}
              </p>
            )}

            {loading ? (
              <p className="mt-3 text-[13px]" style={{ color: "var(--ink-2)" }}>
                Cargando contactos…
              </p>
            ) : loadError ? (
              <p
                className="mt-3 rounded-xl px-3.5 py-3 text-[13px]"
                style={{
                  border: "1px solid var(--accent)",
                  background: "var(--red-soft)",
                  color: "var(--accent)",
                }}
              >
                {loadError}
              </p>
            ) : contacts.length === 0 ? (
              <p className="mt-3 text-[13px]" style={{ color: "var(--ink-2)" }}>
                Todavía no hay contactos de staff para este hotel.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {contacts.map((contact) => {
                  const busy = busyId === contact.id;
                  const editing = editingId === contact.id;

                  return (
                    <li
                      key={contact.id}
                      className="rounded-2xl p-3.5"
                      style={{
                        border: "1px solid var(--line)",
                        background: "var(--bg-card)",
                        opacity: contact.isActive ? 1 : 0.65,
                      }}
                    >
                      {editing ? (
                        <div className="space-y-2.5">
                          <input
                            type="text"
                            value={editName}
                            onChange={(event) => setEditName(event.target.value)}
                            aria-label="Nombre del contacto"
                            className={inputClass}
                            style={{ ...inputStyle, background: "var(--bg-card)" }}
                            disabled={busy}
                          />
                          <input
                            type="text"
                            value={editRole}
                            onChange={(event) => setEditRole(event.target.value)}
                            aria-label="Cargo del contacto"
                            placeholder="Cargo (opcional)"
                            className={inputClass}
                            style={{ ...inputStyle, background: "var(--bg-card)" }}
                            disabled={busy}
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              disabled={busy}
                              className="rounded-xl px-3 py-2 text-[12.5px] font-semibold transition hover:bg-[var(--bg-app)] disabled:opacity-60"
                              style={{
                                border: "1px solid var(--line)",
                                background: "var(--bg-card)",
                                color: "var(--ink-2)",
                              }}
                            >
                              Cancelar
                            </button>
                            <button
                              type="button"
                              onClick={() => saveEditing(contact)}
                              disabled={busy}
                              className="grotesk rounded-xl px-3 py-2 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-95 disabled:opacity-60"
                              style={{
                                background:
                                  "linear-gradient(100deg, var(--accent) 0%, var(--accent) 100%)",
                              }}
                            >
                              {busy ? "Guardando..." : "Guardar"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p
                              className="truncate text-[14px] font-semibold"
                              style={{ color: "var(--ink)" }}
                            >
                              {contact.name}
                              {!contact.isActive && (
                                <span
                                  className="ml-2 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
                                  style={{
                                    border: "1px solid var(--line)",
                                    color: "var(--ink-3)",
                                  }}
                                >
                                  Inactivo
                                </span>
                              )}
                            </p>
                            <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                              {formatStaffPhone(contact.phone)}
                              {contact.role ? ` · ${contact.role}` : ""}
                            </p>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              onClick={() => startEditing(contact)}
                              disabled={busy}
                              className="rounded-xl px-3 py-2 text-[12.5px] font-semibold transition hover:bg-[var(--bg-app)] disabled:opacity-60"
                              style={{
                                border: "1px solid var(--line)",
                                background: "var(--bg-card)",
                                color: "var(--ink-2)",
                              }}
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void patchContact(
                                  contact.id,
                                  { isActive: !contact.isActive },
                                  contact.isActive ? "Contacto desactivado." : "Contacto activado."
                                )
                              }
                              disabled={busy}
                              className="rounded-xl px-3 py-2 text-[12.5px] font-semibold transition hover:bg-[var(--bg-app)] disabled:opacity-60"
                              style={{
                                border: "1px solid var(--line)",
                                background: "var(--bg-card)",
                                color: contact.isActive ? "var(--accent)" : "var(--ink-2)",
                              }}
                            >
                              {busy ? "…" : contact.isActive ? "Desactivar" : "Activar"}
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div
          className="flex shrink-0 justify-end px-5 py-3"
          style={{ borderTop: "1px solid var(--line)", background: "var(--bg-app)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-[13px] font-semibold shadow-sm transition hover:bg-[var(--bg-app)]"
            style={{
              border: "1px solid var(--line)",
              background: "var(--bg-card)",
              color: "var(--ink-2)",
            }}
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

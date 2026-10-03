"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { createClient } from "@/lib/supabase/client";
import { writeStoredActiveHotelId } from "@/lib/active-hotel-storage";
import { HEADER_MENU_ROW_CLASS } from "./HeaderMobileMenu";

export function LogoutButton({
  onRed = false,
  variant = "bar",
}: {
  onRed?: boolean;
  variant?: "bar" | "menu";
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    // Limpia el hotel activo guardado para que el próximo usuario que inicie
    // sesión en esta pestaña no herede un hotelId que no le pertenece.
    writeStoredActiveHotelId(null);
    const supabase = createClient();
    await supabase.auth.signOut();
    if (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST) {
      posthog.capture("user_logged_out");
      posthog.reset();
    }
    router.push("/login");
    router.refresh();
    setLoading(false);
  }

  if (variant === "menu") {
    return (
      <button
        type="button"
        onClick={() => void handleSignOut()}
        disabled={loading}
        className={`${HEADER_MENU_ROW_CLASS} text-[var(--accent)]`}
        role="menuitem"
        aria-label="Cerrar sesión"
      >
        <IconLogout className="h-4 w-4 shrink-0" aria-hidden />
        {loading ? "Cerrando…" : "Cerrar sesión"}
      </button>
    );
  }

  const className = onRed
    ? "inline-flex items-center gap-1.5 rounded-lg border border-white/35 bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-white/25 disabled:opacity-50"
    : "inline-flex items-center gap-1.5 rounded-lg border border-[#e7dfd4] bg-white px-2.5 py-1 text-[11px] font-medium text-[#6b665e] shadow-sm transition hover:border-stone-400 hover:bg-[#f1ece4] hover:text-[#1f1f1c] disabled:opacity-50";

  return (
    <button
      type="button"
      onClick={() => void handleSignOut()}
      disabled={loading}
      className={className}
      aria-label="Cerrar sesión"
      title="Cerrar sesión"
    >
      <IconLogout className="h-4 w-4 shrink-0" aria-hidden />
      <span className="hidden sm:inline">{loading ? "…" : "Cerrar sesión"}</span>
    </button>
  );
}

function IconLogout({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l3 3m0 0l-3 3m3-3H2.25" />
    </svg>
  );
}

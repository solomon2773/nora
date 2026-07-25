import { useEffect, useState } from "react";

export type PlatformMode = "loading" | "selfhosted" | "paas" | "unknown";

export function useVerifiedPlatformMode() {
  const [mode, setMode] = useState<PlatformMode>("loading");

  useEffect(() => {
    let active = true;

    async function loadMode() {
      try {
        const response = await fetch("/api/config/platform", {
          credentials: "include",
        });
        if (!response.ok) throw new Error("Platform configuration is unavailable");
        const payload = await response.json().catch(() => ({}));
        const normalized =
          typeof payload?.mode === "string" ? payload.mode.trim().toLowerCase() : "unknown";
        if (!active) return;
        setMode(normalized === "selfhosted" || normalized === "paas" ? normalized : "unknown");
      } catch {
        if (active) setMode("unknown");
      }
    }

    void loadMode();
    return () => {
      active = false;
    };
  }, []);

  return mode;
}

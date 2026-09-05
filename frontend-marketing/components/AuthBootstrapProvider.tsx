import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchAuthBootstrapStatus, type AuthBootstrapStatus } from "../lib/authBootstrap";

export type AuthBootstrapContextValue = {
  status: AuthBootstrapStatus | null;
  error: string;
  loading: boolean;
};

export const AuthBootstrapContext = createContext<AuthBootstrapContextValue>({
  status: null,
  error: "",
  loading: true,
});

export function useAuthBootstrap(): AuthBootstrapContextValue {
  return useContext(AuthBootstrapContext);
}

export function AuthBootstrapProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthBootstrapStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    fetchAuthBootstrapStatus(controller.signal)
      .then((nextStatus) => {
        setStatus(nextStatus);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError") {
          return;
        }

        setStatus(null);
        setError(
          cause instanceof Error && cause.message
            ? cause.message
            : "Unable to load signup availability",
        );
        setLoading(false);
      });

    return () => controller.abort();
  }, []);

  return (
    <AuthBootstrapContext.Provider value={{ status, error, loading }}>
      {children}
    </AuthBootstrapContext.Provider>
  );
}

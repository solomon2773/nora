import { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";

const ToastContext = createContext(null);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

const COLORS = {
  success: "bg-emerald-50 border-emerald-200 text-emerald-900",
  error: "bg-red-50 border-red-200 text-red-900",
  info: "bg-blue-50 border-blue-200 text-blue-900",
};

const ICON_COLORS = {
  success: "text-emerald-500",
  error: "text-red-500",
  info: "text-blue-500",
};

let nextToastId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const removeToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const addToast = useCallback(
    (message, variant = "info", duration = 4000) => {
      const id = ++nextToastId;
      setToasts((current) => [...current, { id, message, variant }]);
      if (duration > 0) {
        setTimeout(() => removeToast(id), duration);
      }
      return id;
    },
    [removeToast]
  );

  const toast = useCallback(
    Object.assign((message) => addToast(message, "info"), {
      success: (message) => addToast(message, "success"),
      error: (message) => addToast(message, "error"),
      info: (message) => addToast(message, "info"),
    }),
    [addToast]
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}

      <div
        className="fixed right-4 top-4 z-[9999] flex max-w-[420px] flex-col gap-3 pointer-events-none"
      >
        {toasts.map((toastItem) => {
          const Icon = ICONS[toastItem.variant] || Info;
          return (
            <div
              key={toastItem.id}
              className={`pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg ${COLORS[toastItem.variant] || COLORS.info}`}
            >
              <Icon
                size={18}
                className={`mt-0.5 shrink-0 ${ICON_COLORS[toastItem.variant] || ICON_COLORS.info}`}
              />
              <p className="flex-1 text-sm font-medium leading-snug">
                {toastItem.message}
              </p>
              <button
                onClick={() => removeToast(toastItem.id)}
                className="mt-0.5 shrink-0 opacity-60 transition-opacity hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return toast;
}

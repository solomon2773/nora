import { createContext, useContext, useState, useCallback } from "react";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";

const ToastContext = createContext(null);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

const COLORS = {
  success: "bg-emerald-900/80 border-emerald-700 text-emerald-200",
  error: "bg-red-900/80 border-red-700 text-red-200",
  info: "bg-blue-900/80 border-blue-700 text-blue-200",
};

const ICON_COLORS = {
  success: "text-emerald-400",
  error: "text-red-400",
  info: "text-blue-400",
};

let toastId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((message, variant = "info", duration = 4000) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, variant }]);
    if (duration > 0) {
      setTimeout(() => removeToast(id), duration);
    }
    return id;
  }, [removeToast]);

  const toast = useCallback(
    Object.assign((msg) => addToast(msg, "info"), {
      success: (msg) => addToast(msg, "success"),
      error: (msg) => addToast(msg, "error"),
      info: (msg) => addToast(msg, "info"),
    }),
    [addToast]
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}

      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-3 pointer-events-none" style={{ maxWidth: 420 }}>
        {toasts.map((t) => {
          const Icon = ICONS[t.variant] || Info;
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg animate-slide-in backdrop-blur-sm ${COLORS[t.variant] || COLORS.info}`}
            >
              <Icon size={18} className={`mt-0.5 flex-shrink-0 ${ICON_COLORS[t.variant] || ICON_COLORS.info}`} />
              <p className="text-sm font-medium flex-1 leading-snug">{t.message}</p>
              <button
                onClick={() => removeToast(t.id)}
                className="flex-shrink-0 mt-0.5 opacity-50 hover:opacity-100 transition-opacity"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <style jsx global>{`
        @keyframes slide-in {
          from {
            opacity: 0;
            transform: translateX(100%);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .animate-slide-in {
          animation: slide-in 0.25s ease-out;
        }
      `}</style>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

import { useEffect } from "react";
import { useUIStore, type Toast } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

const AUTO_DISMISS_MS = 15_000;

/** Individual toast item — starts its own 15 s auto-dismiss timer. */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      className={cn(
        "pointer-events-auto flex w-80 items-start gap-3 rounded-md border bg-background p-3 shadow-lg",
        toast.variant === "destructive" && "border-destructive text-destructive",
      )}
    >
      <div className="flex-1">
        <div className="text-sm font-medium">{toast.title}</div>
        {toast.description && (
          <div className="mt-1 text-xs text-muted-foreground">{toast.description}</div>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss notification"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Minimal toast renderer. Pulls from useUIStore — components push via pushToast(). */
export function Toaster() {
  const toasts = useUIStore((s) => s.toasts);
  const dismiss = useUIStore((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

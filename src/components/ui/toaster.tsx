import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

/** Minimal toast renderer. Pulls from useUIStore — components push via pushToast(). */
export function Toaster() {
  const toasts = useUIStore((s) => s.toasts);
  const dismiss = useUIStore((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex w-80 items-start gap-3 rounded-md border bg-background p-3 shadow-lg",
            t.variant === "destructive" && "border-destructive text-destructive",
          )}
        >
          <div className="flex-1">
            <div className="text-sm font-medium">{t.title}</div>
            {t.description && (
              <div className="mt-1 text-xs text-muted-foreground">{t.description}</div>
            )}
          </div>
          <button
            onClick={() => dismiss(t.id)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-sm rounded-2xl border border-destructive/40 bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-5 text-destructive" />
          <h2 className="text-sm font-bold">Aura couldn't do that</h2>
        </div>
        <p className="mt-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {message}
        </p>
        <Button variant="outline" className="mt-5 w-full" onClick={onClose}>
          OK
        </Button>
      </div>
    </div>
  );
}

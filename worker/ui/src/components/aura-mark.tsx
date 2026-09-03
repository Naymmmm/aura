import { cn } from '@/lib/utils';

/** Aura's Material asterisk mark (black asterisk on the lime brand square). */
export function AuraMark({ className }: { className?: string }) {
  return (
    <img
      src="/aura-mark.png"
      alt="Aura"
      className={cn('h-10 w-10 shrink-0 rounded-lg object-cover shadow-sm', className)}
    />
  );
}

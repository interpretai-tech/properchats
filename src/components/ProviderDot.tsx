import { cn } from "@/lib/cn";
import { PROVIDERS } from "@/lib/models";
import type { Provider } from "@/lib/types";

const SIZE = { sm: "h-1.5 w-1.5", md: "h-2 w-2" } as const;

/**
 * The small circular swatch carrying a provider's signature color — the single
 * source for the dot that tags models, messages, and threads by provider across
 * the UI (chat picker, message tags, thread tree, viz).
 */
export function ProviderDot({
  provider,
  size = "sm",
  className,
}: {
  provider?: Provider;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  if (!provider) return null;
  return (
    <span
      className={cn("shrink-0 rounded-full", SIZE[size], className)}
      style={{ background: PROVIDERS[provider].color }}
    />
  );
}

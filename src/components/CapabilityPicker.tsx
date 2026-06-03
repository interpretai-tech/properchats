"use client";

import {
  Check,
  Globe,
  Image as ImageIcon,
  MessageSquare,
  Sparkles,
  Telescope,
  Terminal,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  CAPABILITIES,
  type CapabilityMeta,
  capabilityAvailable,
  getCapability,
  providerAvailability,
} from "@/lib/capabilities";
import { cn } from "@/lib/cn";
import { useDismiss } from "@/lib/hooks";
import { PROVIDERS } from "@/lib/models";
import { useStore } from "@/lib/store";
import type { Capability } from "@/lib/types";

const ICONS = {
  MessageSquare,
  Globe,
  Image: ImageIcon,
  Telescope,
  Terminal,
} as const;

function CapIcon({ meta, size = 15 }: { meta: CapabilityMeta; size?: number }) {
  const Icon = ICONS[meta.icon];
  return <Icon size={size} />;
}

/** Human hint for why a capability is unavailable (no usable provider key). */
function unmetHint(meta: CapabilityMeta): string {
  const names = meta.providers.map((p) => PROVIDERS[p].company).join(" or ");
  return `Add a ${names} key in Settings to use ${meta.label.toLowerCase()}`;
}

/**
 * Picks the provider-native capability (web search, image, deep research, code)
 * for the next turn. Mirrors ModelPicker's styling; lives left of it in the
 * composer. "Chat" is the default and shows a neutral "Tools" trigger.
 */
export function CapabilityPicker({
  value,
  onChange,
  up = false,
}: {
  value: Capability;
  onChange: (c: Capability) => void;
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const keys = useStore((s) => s.settings.keys);
  const cfg = useStore((s) => s.serverConfig);

  const avail = useMemo(() => providerAvailability(keys, cfg), [keys, cfg]);

  const active = value !== "chat";
  const current = getCapability(value);
  const close = () => setOpen(false);

  return (
    <div className="relative" ref={ref}>
      <div
        className={cn(
          "flex items-center rounded-lg transition",
          active ? "bg-accent/10 text-accent" : "text-muted",
        )}
      >
        <button
          type="button"
          data-testid="capability-picker"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg py-1 pl-2 text-[13px] font-medium transition",
            active ? "pr-1.5 hover:bg-accent/15" : "pr-2 hover:bg-surface-3 hover:text-ink",
          )}
        >
          {active ? <CapIcon meta={current} /> : <Sparkles size={15} className="opacity-70" />}
          <span className="max-w-[120px] truncate">{active ? current.label : "Tools"}</span>
        </button>
        {active && (
          <button
            type="button"
            data-testid="capability-clear"
            aria-label="Clear capability"
            onClick={() => onChange("chat")}
            className="mr-0.5 flex h-6 w-6 items-center justify-center rounded-md text-accent/80 transition hover:bg-accent/15 hover:text-accent"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute left-0 z-40 w-[270px] overflow-hidden rounded-xl border border-line bg-surface shadow-xl",
            up ? "bottom-full mb-3" : "top-full mt-2",
          )}
        >
          <div className="py-1">
            {CAPABILITIES.map((meta) => {
              const enabled = capabilityAvailable(meta.id, avail);
              const selected = meta.id === value;
              return (
                <button
                  key={meta.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={!enabled}
                  data-testid={`capability-option-${meta.id}`}
                  title={enabled ? meta.hint : unmetHint(meta)}
                  onClick={() => {
                    onChange(meta.id);
                    close();
                  }}
                  className={cn(
                    "flex w-full items-start gap-2.5 px-3 py-2 text-left transition",
                    enabled ? "hover:bg-surface-2" : "cursor-not-allowed opacity-45",
                    selected && "bg-surface-2",
                  )}
                >
                  <span className="mt-0.5 w-4 shrink-0 text-muted">
                    <CapIcon meta={meta} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium text-ink">{meta.label}</span>
                      {selected && <Check size={13} className="text-accent" />}
                    </span>
                    <span className="block text-[11px] leading-snug text-faint">
                      {enabled ? meta.hint : unmetHint(meta)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

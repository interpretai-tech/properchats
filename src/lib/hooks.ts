"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * `useLayoutEffect` that degrades to `useEffect` during SSR, so layout-timing
 * effects (e.g. syncing scroll position before paint) don't log React's
 * "useLayoutEffect does nothing on the server" warning.
 */
export const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Attach the returned ref to a container; while `open`, calls `onClose` on an
 * outside click or Escape keypress. Used for dropdowns, popovers, and modals.
 */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return ref;
}

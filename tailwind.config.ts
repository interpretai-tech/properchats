import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

/**
 * ProperChat design system. Semantic color tokens are CSS variables defined
 * in globals.css and flipped under the `.dark` class, so a single utility
 * (e.g. `bg-surface`) tracks the active theme. The palette is tuned to read
 * like claude.ai: warm paper backgrounds, a clay accent, near-black ink.
 */
export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        "surface-3": "var(--surface-3)",
        line: "var(--border)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        accent: "var(--accent)",
        "accent-fg": "var(--accent-fg)",
        "accent-soft": "var(--accent-soft)",
        "user-bubble": "var(--user-bubble)",
        danger: "var(--danger)",
      },
      fontFamily: {
        // UI sans prefers Geist (var set on <body>), then system sans.
        sans: [
          "var(--font-geist-sans)",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
      },
      maxWidth: {
        chat: "48rem",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Opacity-only fade for elements that own their transform (e.g. a
        // popup centered with -translate-y-1/2); a transform in the keyframe
        // would clobber that positioning during the animation.
        fade: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.18s ease-out",
        fade: "fade 0.15s ease-out",
        "slide-in-right": "slide-in-right 0.2s ease-out",
        blink: "blink 1s steps(1) infinite",
      },
    },
  },
  plugins: [typography],
} satisfies Config;

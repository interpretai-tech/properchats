import { createHighlighter, type Highlighter } from "shiki";

/** Atom One Dark (VS Code's "Atom One Dark" / One Dark Pro) for code blocks. */
export const CODE_THEME = "one-dark-pro";

const LANGS = [
  "javascript", "typescript", "jsx", "tsx", "python", "bash", "json", "html",
  "css", "scss", "markdown", "sql", "go", "rust", "java", "c", "cpp", "csharp",
  "yaml", "toml", "ruby", "php", "swift", "kotlin", "diff", "dockerfile",
  "graphql", "lua", "r", "objective-c", "plaintext",
];

const ALIASES: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", py: "python", rb: "ruby", sh: "bash", shell: "bash",
  zsh: "bash", console: "bash", yml: "yaml", "c++": "cpp", "c#": "csharp",
  cs: "csharp", golang: "go", rs: "rust", kt: "kotlin", text: "plaintext",
  txt: "plaintext", plain: "plaintext", "": "plaintext",
};

let highlighterPromise: Promise<Highlighter> | null = null;

/** Lazily create a single shared highlighter (loads grammars/WASM once). */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({ themes: [CODE_THEME], langs: LANGS });
  }
  return highlighterPromise;
}

/** Map a fence language to a loaded grammar, falling back to plaintext. */
export function resolveLang(lang: string | undefined, loaded: string[]): string {
  const raw = (lang ?? "").toLowerCase();
  const mapped = ALIASES[raw] ?? raw;
  return loaded.includes(mapped) ? mapped : "plaintext";
}

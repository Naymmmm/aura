// Shared shadcn-style design system for the worker's server-rendered pages
// (version archive, admin). Static HTML + CSS, no JS framework required. The
// dark "zinc" theme with the Aura lime accent matches the desktop client.

export const shadcnCss = `
:root {
  --background: oklch(0.141 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.18 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.18 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: #d9ff65;
  --primary-foreground: oklch(0.18 0 0);
  --secondary: oklch(0.25 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.22 0 0);
  --muted-foreground: oklch(0.646 0 0);
  --accent: oklch(0.25 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 0.10);
  --input: oklch(1 0 0 / 0.14);
  --ring: #d9ff65;
  --radius: 0.625rem;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { color-scheme: dark; }
body {
  background: var(--background); color: var(--foreground);
  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  min-height: 100vh; -webkit-font-smoothing: antialiased; line-height: 1.5;
}
a { color: inherit; text-decoration: none; }
.wrap { max-width: 780px; margin: 0 auto; padding: 48px 20px 96px; }
.page-title { font-size: clamp(1.9rem, 5vw, 2.9rem); font-weight: 700; letter-spacing: -0.025em; }
.page-sub { color: var(--muted-foreground); margin-top: 8px; font-size: 0.9rem; }

.card {
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 1.25rem;
}
.card-title { font-weight: 600; font-size: 0.95rem; }
.card-desc { color: var(--muted-foreground); font-size: 0.85rem; margin-top: 0.25rem; }

.badge {
  display: inline-flex; align-items: center; border-radius: 9999px;
  padding: 0.1rem 0.6rem; font-size: 0.68rem; font-weight: 600;
  border: 1px solid var(--border); color: var(--muted-foreground);
  text-transform: uppercase; letter-spacing: 0.07em; background: var(--muted);
}
.badge-primary { background: var(--primary); color: var(--primary-foreground); border-color: transparent; }
.badge-dev { background: oklch(0.24 0 0); color: var(--primary); border-color: var(--border); }
.badge-outline { color: var(--foreground); }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
  cursor: pointer; user-select: none; white-space: nowrap; border-radius: calc(var(--radius) - 2px);
  height: 2rem; padding: 0 0.9rem; font-size: 0.85rem; font-weight: 500;
  background: var(--primary); color: var(--primary-foreground);
  border: 1px solid transparent;
}
.btn:hover { filter: brightness(1.06); }
.btn:active { filter: brightness(0.96); }
.btn-outline { background: transparent; color: var(--foreground); border-color: var(--border); }
.btn-outline:hover { background: var(--accent); color: var(--accent-foreground); }
.btn-ghost { background: transparent; color: var(--muted-foreground); }
.btn-ghost:hover { background: var(--accent); color: var(--accent-foreground); }

.input {
  width: 100%; height: 2.25rem; border-radius: calc(var(--radius) - 2px);
  border: 1px solid var(--input); background: transparent; color: var(--foreground);
  padding: 0 0.75rem; font-size: 0.875rem; outline: none;
}
.input:focus { border-color: var(--ring); box-shadow: 0 0 0 3px oklch(0.85 0.16 0 / 0.2); }
::placeholder { color: var(--muted-foreground); }

.segmented {
  display: inline-flex; align-items: center; background: var(--muted);
  border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); padding: 3px;
  font-size: 0.85rem; gap: 3px;
}
.segmented button {
  border: none; background: transparent; color: var(--muted-foreground);
  border-radius: calc(var(--radius) - 4px); padding: 0.3rem 0.9rem; font-size: 0.85rem; cursor: pointer;
  font-family: inherit;
}
.segmented button[aria-selected="true"] {
  background: var(--background); color: var(--foreground);
  box-shadow: 0 1px 2px oklch(0 0 0 / 0.2);
}
.labels { color: var(--muted-foreground); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.09em; font-weight: 600; }
.versions { margin-top: 12px; }
.version-row {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 16px 0; border-top: 1px solid var(--border);
}
.version-name { font-weight: 600; font-size: 1rem; }
.version-meta { color: var(--muted-foreground); font-size: 0.8rem; margin-top: 2px; }
.artifacts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
@media (max-width: 520px) {
  .version-row { flex-direction: column; align-items: flex-start; }
  .artifacts { justify-content: flex-start; }
}
.empty { padding: 40px 0; border-top: 1px solid var(--border); color: var(--muted-foreground); }
`;

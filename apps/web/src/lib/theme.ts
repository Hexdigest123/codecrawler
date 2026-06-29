const STORAGE_KEY = "theme";

export type Theme = "light" | "dark";

export function toggleTheme(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const next: Theme = root.classList.contains("dark") ? "light" : "dark";
  root.classList.toggle("dark", next === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable (private mode) — ignore */
  }
}

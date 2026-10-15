import type { ThemePreference } from "@/lib/theme";

export function ThemeIcon({ preference, size = 17 }: { preference: ThemePreference; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (preference === "light") {
    return <svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41" /></svg>;
  }
  if (preference === "dark") {
    return <svg {...common}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" /></svg>;
  }
  if (preference === "mist") {
    return <svg {...common}><path d="M12 3S6 10 6 14a6 6 0 0 0 12 0c0-4-6-11-6-11Z" /><path d="M9 15c.5 1.4 1.5 2.2 3 2.5" /></svg>;
  }
  if (preference === "rose") {
    return <svg {...common}><path d="M12 13.5c-3.2 0-5.5-1.8-5.5-4.6S8.6 4.2 11.8 4.2c2.7 0 4.8 1.7 4.8 4.2 0 2.2-1.6 3.7-3.8 3.7-1.8 0-3-1-3-2.4 0-1.2.9-2 2-2 1 0 1.6.5 1.6 1.3" /><path d="M12 13.5v7.5M12 18c-1.7-1.8-3.6-2.2-5.2-1.2 1.1 1.9 3.1 2.6 5.2 1.2ZM12 17c1.3-2 3.3-2.4 5-1.5-1.1 1.8-3 2.4-5 1.5Z" /></svg>;
  }
  if (preference === "pine") {
    return <svg {...common}><path d="M12 3c-.9 2.5-2.3 4.2-4.5 6h3c-1 2.1-2.6 3.7-5 5.3h4c-.7 2-1.9 3.8-3.7 5.4h12.4c-1.8-1.6-3-3.4-3.7-5.4h4c-2.4-1.6-4-3.2-5-5.3h3c-2.2-1.8-3.6-3.5-4.5-6Z" /><path d="M12 20v2" /></svg>;
  }
  if (preference === "meadow") {
    return <svg {...common}><path d="M7 20c0-4 1-7 3-9M17 20c0-4-1-7-3-9M12 20V9" /><path d="M12 9c-2.5 0-4-1.8-4-4 2.5 0 4 1.8 4 4ZM12 9c2.5 0 4-1.8 4-4-2.5 0-4 1.8-4 4ZM12 13c-2 0-3.5-1.5-3.5-3.5C10.5 9.5 12 11 12 13ZM12 13c2 0 3.5-1.5 3.5-3.5C13.5 9.5 12 11 12 13Z" /><path d="M4 20h16" /></svg>;
  }
  if (preference === "newspaper") {
    return <svg {...common}><path d="M4 5h11a1 1 0 0 1 1 1v12a2 2 0 0 0 2 2 2 2 0 0 0 2-2V5a1 1 0 0 1 1-1h-2" /><path d="M4 5v13a2 2 0 0 0 2 2h10" /><path d="M7 9h6M7 12h6M7 15h4" /></svg>;
  }
  return <svg {...common}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
}

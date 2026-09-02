import { useEffect, useRef, useState } from "react";
import { useT } from "../LocaleContext";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // ponytail: webviews without clipboard permission still honour a selection copy.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const label = done ? t("common.copied") : t("common.copy");
  return (
    <button
      type="button"
      className={"copy-btn" + (done ? " is-done" : "") + (className ? " " + className : "")}
      title={label}
      aria-label={label}
      onClick={async (e) => {
        e.stopPropagation();
        if (!text.trim()) return;
        if (!(await copyText(text))) return;
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1200);
      }}
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        {done ? (
          <path
            d="M2.8 7.4 5.6 10.2 11.2 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <>
            <rect
              x="4.6"
              y="1.6"
              width="7.8"
              height="7.8"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M9.4 11.1v.3a2 2 0 0 1-2 2H3.6a2 2 0 0 1-2-2V7.6a2 2 0 0 1 2-2h.3"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
    </button>
  );
}

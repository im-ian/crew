import { useEffect, useRef, useState } from "react";
import { useT } from "../LocaleContext";
import { Check, Copy } from "../icons";

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
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

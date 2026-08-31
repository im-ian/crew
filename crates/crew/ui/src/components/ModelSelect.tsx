import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { CliKind } from "../types";

type Props = {
  id?: string;
  cli: CliKind | null;
  value: string;
  onChange: (value: string) => void;
  active?: boolean;
};

export function ModelSelect({
  id,
  cli,
  value,
  onChange,
  active = true,
}: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    if (!cli || !active) return;
    let cancelled = false;
    setModels([]);
    setFallback(null);
    api
      .listModels(cli)
      .then((list) => {
        if (cancelled) return;
        setModels(list.models || []);
        setFallback(list.default || null);
      })
      .catch(() => {
        if (cancelled) return;
        setModels([]);
        setFallback(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cli, active]);

  const options = useMemo(() => {
    const out: { value: string; label: string }[] = [
      { value: "", label: fallback ? `기본값 (${fallback})` : "기본값" },
    ];
    const seen = new Set<string>([""]);
    for (const model of models) {
      if (seen.has(model)) continue;
      seen.add(model);
      out.push({ value: model, label: model });
    }
    if (value && !seen.has(value)) {
      out.push({ value, label: value });
    }
    return out;
  }, [models, fallback, value]);

  return (
    <select
      id={id}
      className="textin"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value || "default"} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

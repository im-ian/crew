import { useEffect, useState } from "react";
import { api } from "../api";
import { ChevronDown } from "../icons";
import { useT } from "../LocaleContext";
import { CLIS, effortOptions, modelRows } from "../options";
import type { CliKind, ModelList } from "../types";
import { usePopover } from "../usePopover";
import { Field } from "./Field";
import { Seg } from "./Seg";

type Props = {
  cli: CliKind;
  model: string;
  effort: string;
  active: boolean;
  /** New bots only: step off a default CLI that is not installed. */
  pickInstalled?: boolean;
  onCli: (cli: CliKind) => void;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
};

// One line for the CLI, model, and think level; it opens in place to change them.
export function ModelPicker({
  cli,
  model,
  effort,
  active,
  pickInstalled = false,
  onCli,
  onModel,
  onEffort,
}: Props) {
  const t = useT();
  const { open, setOpen, rootRef } = usePopover(active);
  const [lists, setLists] = useState<Partial<Record<CliKind, ModelList>>>({});

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    for (const { value } of CLIS) {
      api
        .listModels(value)
        .then((list) => {
          if (!cancelled) setLists((prev) => ({ ...prev, [value]: list }));
        })
        // A CLI that cannot list still runs; it only offers its default.
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [active]);

  // A saved bot keeps its CLI even when it is missing: moving it is the user's call.
  useEffect(() => {
    if (!pickInstalled || lists[cli]?.installed !== false) return;
    const next = CLIS.find((c) => lists[c.value]?.installed);
    if (next) onCli(next.value);
  }, [lists, cli, pickInstalled]);

  const list = lists[cli];
  const efforts = effortOptions(t);
  const cliLabel = CLIS.find((c) => c.value === cli)?.label ?? cli;
  const modelLabel =
    model ||
    (list?.default
      ? t("model.defaultNamed", { name: list.default })
      : t("model.default"));
  const effortLabel = efforts.find((o) => o.value === effort)?.label ?? effort;

  return (
    <div className={"model-pick" + (open ? " open" : "")} ref={rootRef}>
      <button
        type="button"
        className="textin model-pick-hit"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="model-pick-name">
          {cliLabel} · {modelLabel}
        </span>
        <span className="model-pick-meta">
          {t("field.effort")} {effortLabel}
        </span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="model-pick-card" role="dialog" aria-label={t("field.ai")}>
          <div className="model-pick-cols">
            <div className="model-pick-col">
              {CLIS.map((c) => {
                const missing = lists[c.value]?.installed === false;
                return (
                  <button
                    key={c.value}
                    type="button"
                    className={"model-pick-row" + (c.value === cli ? " on" : "")}
                    aria-pressed={c.value === cli}
                    disabled={missing}
                    onClick={() => {
                      if (c.value !== cli) onCli(c.value);
                    }}
                  >
                    <span className="model-pick-label">{c.label}</span>
                    {missing ? (
                      <span className="model-pick-hint">{t("model.notInstalled")}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="model-pick-col">
              {modelRows(list, model, t).map((row) => (
                <button
                  key={row.value || "default"}
                  type="button"
                  className={"model-pick-row" + (row.value === model ? " on" : "")}
                  aria-pressed={row.value === model}
                  onClick={() => onModel(row.value)}
                >
                  <span className="model-pick-label">{row.label}</span>
                  {row.hint ? <span className="model-pick-hint">{row.hint}</span> : null}
                </button>
              ))}
            </div>
          </div>
          <Field label={t("field.effort")}>
            <Seg value={effort} options={efforts} onChange={onEffort} />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

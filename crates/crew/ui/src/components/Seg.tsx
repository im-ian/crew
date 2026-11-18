type Option<T extends string> = {
  value: T;
  label: string;
};

type Props<T extends string> = {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  /** Shown, not changed here: a phone shows the laptop's choice. */
  disabled?: boolean;
};

export function Seg<T extends string>({ value, options, onChange, disabled }: Props<T>) {
  return (
    <div className="seg" data-cols={options.length}>
      {options.map((opt) => (
        <button
          key={opt.value || "default"}
          type="button"
          className={value === opt.value ? "on" : ""}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

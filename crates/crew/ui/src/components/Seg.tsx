type Option<T extends string> = {
  value: T;
  label: string;
};

type Props<T extends string> = {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
};

export function Seg<T extends string>({ value, options, onChange }: Props<T>) {
  return (
    <div className="seg" data-cols={options.length}>
      {options.map((opt) => (
        <button
          key={opt.value || "default"}
          type="button"
          className={value === opt.value ? "on" : ""}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

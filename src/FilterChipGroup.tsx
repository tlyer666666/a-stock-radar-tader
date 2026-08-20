import type { ReactNode } from "react";

export interface FilterChipOption<T extends string> {
  id: T;
  label: string;
}

export default function FilterChipGroup<T extends string>({
  label,
  icon,
  options,
  value,
  onChange
}: {
  label: string;
  icon: ReactNode;
  options: ReadonlyArray<FilterChipOption<T>>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="news-filter-group" role="group" aria-label={label}>
      <span aria-hidden="true">{icon}<b>{label}</b></span>
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          className={value === option.id ? "active" : ""}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

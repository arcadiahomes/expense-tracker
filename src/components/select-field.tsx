"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type Option<V extends string = string> = { value: V; label: string };

/** Single-select that always shows the option label, never the raw value. */
export function SelectField<V extends string>({
  id,
  value,
  onChange,
  options,
  placeholder,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  /** null shows the placeholder. */
  value: V | null;
  onChange: (value: V) => void;
  options: Option<V>[];
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v as V);
      }}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn("h-11 w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="min-h-10">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

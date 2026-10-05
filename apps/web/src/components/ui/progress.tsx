import type { ComponentProps } from "react";

/** Segmented step progress: honest when only the current stage is known, not a fraction. */
export function Progress({
  step,
  steps,
  ...props
}: Omit<ComponentProps<"div">, "children" | "className"> & {
  readonly step: number;
  readonly steps: number;
}) {
  return (
    <div
      {...props}
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={steps}
      aria-valuenow={step}
      aria-valuetext={`Step ${step} of ${steps}`}
      className="flex h-1 w-full gap-1"
    >
      {Array.from({ length: steps }, (_, index) => (
        <div
          key={index}
          className={
            index < step ? "flex-1 rounded-full bg-foreground" : "flex-1 rounded-full bg-muted"
          }
        />
      ))}
    </div>
  );
}

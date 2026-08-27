export const normalizeTrailerValue = (value: string): string | undefined =>
  value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

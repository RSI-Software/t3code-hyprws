export class UsageError extends Error {}

export interface CliArguments {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positionals: ReadonlyArray<string>;
}

export interface CliSpec {
  readonly values?: ReadonlyArray<string>;
  readonly flags?: ReadonlyArray<string>;
  readonly positionals?: number | { readonly min: number; readonly max: number };
  readonly duplicateFlags?: boolean;
}

export const parseArgs = (argv: ReadonlyArray<string>, spec: CliSpec): CliArguments => {
  const valueNames = new Set(spec.values ?? []);
  const flagNames = new Set(spec.flags ?? []);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: Array<string> = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (valueNames.has(argument)) {
      if (values.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
      const value = argv[++index];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new UsageError(`${argument} requires a value`);
      }
      values.set(argument, value);
    } else if (flagNames.has(argument)) {
      if (!spec.duplicateFlags && flags.has(argument)) {
        throw new UsageError(`duplicate option: ${argument}`);
      }
      flags.add(argument);
    } else if (argument.startsWith("-")) {
      throw new UsageError(`unknown argument: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }

  const positionalRange =
    typeof spec.positionals === "number"
      ? { min: spec.positionals, max: spec.positionals }
      : (spec.positionals ?? { min: 0, max: 0 });
  if (positionals.length < positionalRange.min || positionals.length > positionalRange.max) {
    throw new UsageError("unexpected positional arguments");
  }
  return { values, flags, positionals };
};

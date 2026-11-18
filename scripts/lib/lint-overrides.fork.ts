// The fork ships no translations for its own copy, so upstream's i18n rule reports it as a
// warning; the disable comments upstream relies on stay in use. Mirrors that rule's scope.
export const FORK_LINT_OVERRIDES = [
  {
    files: ["apps/web/src/**", "apps/mobile/src/**", "packages/client-runtime/src/**"],
    excludeFiles: [
      "**/*.{test,spec,bench}.{ts,tsx}",
      "**/{test,testkit,testing,fixtures}/**",
      "**/*.test-fixtures.ts",
      "**/{test-fixtures,*TestFixtures}.ts",
      "apps/mobile/src/features/development/**",
      "packages/client-runtime/src/rpc/**",
    ],
    rules: { "t3code/no-untranslated-copy": "warn" as const },
  },
];

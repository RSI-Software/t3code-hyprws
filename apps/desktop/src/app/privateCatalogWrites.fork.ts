import type * as FileSystem from "effect/FileSystem";

export const privateCatalogWritesFork = (fileSystem: FileSystem.FileSystem) => ({
  fileSystem: {
    ...fileSystem,
    writeFileString: ((path, contents, options) =>
      fileSystem.writeFileString(path, contents, {
        ...options,
        mode: 0o600,
      })) satisfies FileSystem.FileSystem["writeFileString"],
  },
});

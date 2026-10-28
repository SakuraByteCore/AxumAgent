import path from "node:path";
import { UnsupportedOptionError } from "../contracts/errors.js";
/** Absolute native paths, independent of the host process's working directory. */
export function resolvedAdditionalDirectories(options) {
    const directories = options.additionalDirectories ?? [];
    if (directories.some((directory) => directory.length === 0 || directory.includes("\0"))) {
        throw new UnsupportedOptionError("additionalDirectories", "additionalDirectories must contain non-empty paths without NUL characters");
    }
    return [...new Set(directories.map((directory) => path.resolve(options.cwd, directory)))];
}

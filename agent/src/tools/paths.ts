import * as path from "node:path";

// The sandbox mounts the user's data at /data. Overridable via HEYO_DATA_DIR so
// the storage modules can be unit-tested against a temp directory on the host.
export const DATA_DIR = process.env.HEYO_DATA_DIR ?? "/data";
export const STORAGE_DIR = path.join(DATA_DIR, "storage");
export const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");

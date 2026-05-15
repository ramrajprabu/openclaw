import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store-options.js";

const INSTALLED_PLUGIN_INDEX_STORE_PATH = path.join("plugins", "installs.json");

export function resolveInstalledPluginIndexStorePath(
  options: InstalledPluginIndexStoreOptions = {},
): string {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  return path.join(stateDir, INSTALLED_PLUGIN_INDEX_STORE_PATH);
}

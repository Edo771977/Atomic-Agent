import { listConfigLeaves, readConfigPath } from "./config-paths.js";
import { USER_CONFIG_DEFAULTS } from "./config-schema.js";
import { ENV_SETTINGS } from "./env-settings.js";
import { SETTINGS_DOCS } from "./settings-docs.generated.js";
import { buildSettingsReference, type SettingEntry } from "./settings-reference.js";

/**
 * The live settings reference: every `config.json` key with its type,
 * default, description and env override. Built once per process; the
 * inputs are compile-time constants.
 */
let cached: readonly SettingEntry[] | null = null;

export function listSettingsReference(): readonly SettingEntry[] {
  cached ??= buildSettingsReference(listConfigLeaves(), SETTINGS_DOCS, ENV_SETTINGS, defaultOfSetting);
  return cached;
}

/**
 * The default of a key with no leaf of its own: an empty record such as
 * `projects.constraints` (`{}`), or `undefined` for a key a fresh file
 * does not have (`llm.*`).
 */
export function defaultOfSetting(key: string): unknown {
  return readConfigPath(USER_CONFIG_DEFAULTS, key);
}

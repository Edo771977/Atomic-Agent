import { KNOWN_SECRET_ENV_VARS, buildCommandEnv, isSecretEnvName, markAgentToolChild } from "../../../sandbox/command-env.js";
import type { KeyCommandCredentials } from "./api-key-command-credentials.js";

/**
 * The environment a provider's `apiKeyCommand` runs with (ATO-1716).
 *
 * Bootstrap loads `<stateDir>/.env` into the agent's `process.env`, so a
 * key command used to inherit every provider key and bot token configured
 * here: a command for one provider could print another provider's key,
 * and that output is sent as the key to the first provider's `baseUrl`.
 * Now it gets the same filtered environment as an agent shell command
 * (`buildCommandEnv`, ATO-347): PATH, HOME, locale and the rest of the
 * working environment stay; secret-looking names go.
 *
 * A key command is a credential helper, though, and some helpers need
 * their own sign-in that lives in the environment. Those names are let
 * back in, unless they are one of the agent's known provider or bot
 * keys (`KNOWN_SECRET_ENV_VARS`, for example `AWS_BEARER_TOKEN_BEDROCK`
 * or `GH_TOKEN`):
 *  - password managers: `OP_SESSION_*` and `OP_SERVICE_ACCOUNT_TOKEN`
 *    (1Password `op`), `BW_SESSION` (Bitwarden `bw`), `VAULT_TOKEN`
 *    (HashiCorp Vault);
 *  - named AWS session, Azure sign-in and gcloud credential variables,
 *    never arbitrary secrets under those prefixes. Explicit configured
 *    key names and aliases of known credential values are always removed.
 *
 * Precedent: Codex `shell_environment_policy` drops `*KEY*`, `*SECRET*`,
 * `*TOKEN*` from the environment of commands it spawns by default.
 */
const CREDENTIAL_HELPER_ENV =
  /^(OP_SESSION_.+|OP_SERVICE_ACCOUNT_TOKEN|BW_SESSION|VAULT_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|AZURE_CLIENT_CERTIFICATE_PASSWORD|CLOUDSDK_AUTH_ACCESS_TOKEN|CLOUDSDK_AUTH_ACCESS_TOKEN_FILE|GOOGLE_APPLICATION_CREDENTIALS)$/;

const AGENT_KEYS = new Set(KNOWN_SECRET_ENV_VARS.map((name) => name.toUpperCase()));

export function buildApiKeyCommandEnv(base: NodeJS.ProcessEnv = process.env, credentials: KeyCommandCredentials = {}): NodeJS.ProcessEnv {
  const excluded = new Set(credentials.names?.map(name => name.toUpperCase()));
  const values = new Set(credentials.values?.filter(Boolean));
  const passthrough: string[] = [];
  for (const name of Object.keys(base)) {
    const upper = name.toUpperCase();
    if (excluded.has(upper) || AGENT_KEYS.has(upper) ||
        (isSecretEnvName(name) && !CREDENTIAL_HELPER_ENV.test(upper))) {
      if (base[name]) values.add(base[name]!);
    }
    if (!isSecretEnvName(name) || AGENT_KEYS.has(upper)) continue;
    if (CREDENTIAL_HELPER_ENV.test(upper)) passthrough.push(name);
  }
  const env = buildCommandEnv(base, passthrough);
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("ATOMIC_AGENT_") || excluded.has(name.toUpperCase()) ||
        (env[name] !== undefined && values.has(env[name]!))) delete env[name];
  }
  return markAgentToolChild(env, base);
}

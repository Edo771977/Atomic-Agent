/** A caller contract failure, never a provider outage or a format refusal. */
export class PrivacyVaultScopeError extends Error {
  readonly code = "privacy_scope_required";

  constructor(partition: string) {
    super(`Auxiliary completion '${partition}' requires withFreshPrivacyVault`);
    this.name = "PrivacyVaultScopeError";
  }
}

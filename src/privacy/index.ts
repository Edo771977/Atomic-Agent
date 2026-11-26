export {
  findPrivateSpans,
  findSecretSpans,
  PRIVATE_KINDS,
  type PrivateKind,
  type PrivateSpan,
} from "./detect-private-data.js";
export {
  PLACEHOLDER,
  PrivacyVault,
  PrivacyArchiveLimitError,
  type PrivacyVaultStats,
  type UnmaskOptions,
} from "./privacy-vault.js";
export { createStreamUnmasker, partialPlaceholderStart, type StreamUnmasker } from "./stream-unmasker.js";
export { PrivacyVaultScopeError } from "./privacy-vault-scope-error.js";
export {
  forgetPrivacyVault,
  releasePrivacyVault,
  isPrivacyShieldEnabled,
  isPrivacyShieldEnabledForRequest,
  privacyShieldSessionStats,
  withPrivacyShieldTurn,
  withFreshPrivacyVault,
  privacyVaultForRequest,
  linkPrivacyVault,
  unlinkPrivacyVault,
  privacyShieldTotals,
  privacyVaultFor,
  pinPrivacyVault,
  rebuildPrivacyVault,
  redactPrivacyEvidence,
  resetPrivacyVaults,
  setPrivacyKnownSecrets,
  setPrivacyShieldEnabled,
  type PrivacyShieldTotals,
} from "./privacy-vault-registry.js";

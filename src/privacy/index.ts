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
  type PrivacyVaultStats,
  type UnmaskOptions,
} from "./privacy-vault.js";
export { createStreamUnmasker, partialPlaceholderStart, type StreamUnmasker } from "./stream-unmasker.js";
export {
  forgetPrivacyVault,
  isPrivacyShieldEnabled,
  privacyShieldTotals,
  privacyVaultFor,
  pinPrivacyVault,
  resetPrivacyVaults,
  setPrivacyKnownSecrets,
  setPrivacyShieldEnabled,
  type PrivacyShieldTotals,
} from "./privacy-vault-registry.js";

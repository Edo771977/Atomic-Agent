# Privacy Shield

Status: current
Owner: src/privacy/

Masks personal data and keys before a request goes to a cloud model and puts them back on this machine (ATO-992 epic). Off by default: `privacy.shield.enabled` in config.json.

- [Detector](detect-private-data.ts): regex-first. `SECRET` reuses the shared credential detector ([secret detector](../error-reporting/secret-detector.ts)) by aligning its markers back to the text; `CARD` (Luhn), `IBAN` (mod 97), `EMAIL`, `PHONE` (international `+…` or a bracketed area code). Linear patterns only; a bare run of digits is never a phone. Names and street addresses need a local model and are not detected yet.
- [Vault](privacy-vault.ts): per-session reversible map. Each value gets a stable placeholder (`[EMAIL_1]`, `[CARD_1]`, `[SECRET_1]`), the same one every time, so a cloud prompt cache keeps hitting. A value masked once is masked wherever it shows up again. `unmask` restores only placeholders this vault minted; `{ json: true }` inserts values JSON-escaped for tool-call arguments. In memory only, never written to disk.
- [Stream unmasker](stream-unmasker.ts): holds back a tail that could still be a placeholder cut between two chunks (`[EMA` + `IL_1]`).
- [Registry](privacy-vault-registry.ts): one vault per session id and the process-wide "masked N" totals.

The [provider adapter](../llm/provider/openai/openai-privacy-shield.ts) covers OpenAI, OpenRouter, Gemini, AIMLAPI, hosted OpenAI-compatible endpoints and native Anthropic Messages. It masks messages before transport conversion, restores split placeholders in streamed text and reasoning, and restores JSON-escaped arguments before the agent dispatches tools. Unknown placeholders pass through unchanged. Subscription CLI providers and separate image and audio requests are outside this coverage. Managed local models and endpoints classified as local receive the original text.

The archive lives in process memory. Chat deletion, including incognito close, drops its archive. Calls without a session use a fresh archive for each completion. The archive is excluded from logs, traces, transcripts, error reports, durable memory and prompt facts. Local conversation history still receives the restored text under its existing retention rules.

The detector reads the fork's current [known credentials](../runtime/runtime-known-secrets.ts) and uses the shared credential masker to detect them. Existing tool-output and error-report scrubbing continue to run independently. Values already redacted from tool output remain redacted.

Checks: `npx vitest run src/privacy`; `npm run lint`; `npm run docs:check`.

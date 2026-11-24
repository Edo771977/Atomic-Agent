# Privacy Shield

Status: current
Owner: src/privacy/

Masks personal data and keys before a request goes to a cloud model and puts them back on this machine (ATO-992 epic). Off by default: `privacy.shield.enabled` in config.json.

- [Detector](detect-private-data.ts): regex-first. `SECRET` reuses the shared credential detector ([secret detector](../error-reporting/secret-detector.ts)) by aligning its markers back to the text; `CARD` (Luhn), `IBAN` (mod 97), `EMAIL`, `PHONE` (international `+…` or a bracketed area code). Linear patterns only; a bare run of digits is never a phone. Names and street addresses need a local model and are not detected yet.
- [Vault](privacy-vault.ts): per-session reversible map. Each value gets a stable placeholder (`[EMAIL_1]`, `[CARD_1]`, `[SECRET_1]`), the same one every time, so a cloud prompt cache keeps hitting. A value masked once is masked wherever it shows up again. `unmask` restores only placeholders this vault minted; `{ json: true }` inserts values JSON-escaped for tool-call arguments. In memory only, never written to disk.
- [Stream unmasker](stream-unmasker.ts): holds back a tail that could still be a placeholder cut between two chunks (`[EMA` + `IL_1]`).
- [Registry](privacy-vault-registry.ts): one vault per session id and the process-wide "masked N" totals. A Fusion worker's session is linked to its chat's vault (ATO-1083); deleting a session forgets its vault and links.

The [provider adapter](../llm/provider/openai/openai-privacy-shield.ts) covers OpenAI, OpenRouter, Gemini, AIMLAPI, hosted OpenAI-compatible endpoints and native Anthropic Messages. It masks messages before transport conversion, restores split placeholders in streamed text and reasoning, and restores JSON-escaped arguments before the agent dispatches tools. Unknown placeholders pass through unchanged. Subscription CLI providers and separate image and audio requests are outside this coverage. Managed local models receive the original text. OpenAI-compatible and Anthropic endpoints classified as local do so in auto mode.

The archive lives in process memory. Chat deletion, including incognito close, drops its archive. Calls without a session use a fresh archive for each completion. The archive is excluded from logs, traces, transcripts, error reports, durable memory and prompt facts. Local conversation history still receives the restored text under its existing retention rules.

The detector reads the fork's current [known credentials](../runtime/runtime-known-secrets.ts) and uses the shared credential masker to detect them. Existing tool-output and error-report scrubbing continue to run independently. Values already redacted from tool output remain redacted.

Checks: `npx vitest run src/privacy`; `npm run lint`; `npm run docs:check`.

For a gateway, proxy or SSH tunnel on a local-looking address that forwards to a cloud model, set `llm.providers[].privacy.shield` to `"on"` on that entry. The default `"auto"` uses the global setting and classifies by the gateway address. Use `"off"` to bypass the shield on a specific provider.

Provider overrides apply to OpenAI-compatible and native Anthropic adapters. Managed `llama-server` and `subscription-cli` entries accept the configuration for compatibility and ignore it because their transports bypass Privacy Shield.

Completed sessions release their archives after pending side calls settle. A Fusion worker links to its parent chat at turn entry and drops its link on exit. Covered cloud calls from the planner, workers and reviewers reuse that archive. Local providers in auto mode receive the original values. An incognito chat has its own archive and closing it drops the archive. Fusion redacts private values in signed evidence and outcome logs without updating mask counters. Incognito Fusion turns skip persistent outcome rows and signed evidence. The process targets 128 recently used session archives and retains those of active turns until they finish. A session can grow to 4,096 values or 1 Mi UTF-16 code units of private values. When an existing archive fills up, the provider rebuilds it from the current window. A Fusion turn that has shared its archive with a worker keeps its existing references and refuses overflow until the turn ends. If that window still exceeds the limit, inference stops before sending it and tells the operator to shorten or compact it. The request does not fail over to another provider.

The direct HTTP skills-eval judge uses the global setting and address classification. For a local-looking judge gateway forwarding to the cloud, configure it as a provider and use that provider as the judge.

Separate image and audio descriptions bypass the shield. Web search and remote MCP or Composio tools receive the original arguments so they can perform the requested action. Tool schemas, including MCP schemas, are sent as supplied.

A value learned later can invalidate the provider's cached prefix once. If the detector could not recognize that value when it first occurred in the prefix, that earlier request may already have sent it verbatim. Later requests use the learned reference at every matching occurrence. Enable protection and configure known secrets before sending sensitive context.

The vault registry deliberately has process scope. Bootstrap sets the default switch from configuration and supplies the live known-secrets reader. Main turns and auxiliary completions share the same provider registry and session boundary. Provider-specific overrides are explicit options. The runtime reads its initial default at startup. Use `m` in the TUI Privacy tab or POST/PATCH /api/privacy-shield as an administrator to persist a new default. Each turn snapshots the switch when it starts. Workers and auxiliary provider calls inherit their parent turn’s choice. GET /api/privacy-shield requires read scope. The TUI and HTTP expose counts from retained archives. The TUI refuses changes from agent tool subprocesses.

## Trust model

References are predictable within an archive. If a model writes a known reference such as `[EMAIL_1]`, including by decoding percent-encoded text or HTML entities read from a file, the agent resolves it to the original value. This is intentional. Privacy Shield replaces detectable values on the protected provider's request, while the model can still refer to the same values the tools would receive without the shield. Existing approval, read-scope and output policies continue to apply after resolution.

On an unauthenticated loopback HTTP listener, serve cannot distinguish requests from the operator and agent child processes. Use authenticated serve for operator controls.

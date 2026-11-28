# Provider import credential filter

Status: current
Owner: src/setup-share/

Only known-provider-env.ts and its tests are imported here. They classify credential destinations for the Atomic Agent configuration importer. Shared setup bundles, profile import and export are absent from this fork.

Unknown or foreign destinations are removed by the filter and their provider entries are withheld by the importer. Credential helper commands and unknown key-variable names are discarded. This provides no confirmation or unlock API.

Checks: npx vitest run src/setup-share src/import/atomic-agent.

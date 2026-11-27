import { expect, it } from "vitest";
import { parseProviderErrorBody } from "../llm/provider/openai/parse-provider-error-body.js";
import { extractSafeUpstreamErrorType, scrubError } from "./error-scrubber.js";

it.each(["customer_private_731", "sk_credential_sentinel_731", "exceed_context_size_error", "unavailable_error", "insufficient_quota", "INVALID_ARGUMENT"])("drops arbitrary identifier-shaped provider type %s", type => {
  const error = Object.assign(new Error("provider failed"), { body: { type } });
  expect(extractSafeUpstreamErrorType(error)).toBeUndefined();
  expect(scrubError(error, { source: "llm_failure" }).upstreamErrorType).toBeUndefined();
});

it("parses a Google array body without admitting its arbitrary type to reports", () => {
  const body = parseProviderErrorBody(JSON.stringify([{ error: { code: 400, status: "INVALID_ARGUMENT", type: "customer_private_731", message: "invalid", param: "messages[9].content" } }]));
  expect(body).toMatchObject({ status: "INVALID_ARGUMENT", type: "customer_private_731", param: "messages[9].content" });
  expect(scrubError(Object.assign(new Error("refused"), { status: 400, body }), { source: "llm_failure" })).toMatchObject({ upstreamErrorCode: "INVALID_ARGUMENT" });
  expect(extractSafeUpstreamErrorType({ body })).toBeUndefined();
});

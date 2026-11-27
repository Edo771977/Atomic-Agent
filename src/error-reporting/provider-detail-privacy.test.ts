import { expect, it } from "vitest";
import { scrubError } from "./error-scrubber.js";
import { extractUpstreamErrorDetail } from "./upstream-error-detail.js";
import { buildEnvelope } from "./sentry-envelope.js";
import { parseSentryDsn } from "./sentry-config.js";

it.each(["customer_private_731", "sk_credential_sentinel_731", "C:\\private\\file", "person@example.invalid", "request_id_731"])("drops unrecognized provider code %s",sentinel=>{
  const error=Object.assign(new Error("not transmitted"),{status:400,body:{code:sentinel,status:sentinel,text:`tools.${sentinel}.parameters.properties.${sentinel}: invalid schema`}});
  const detail=extractUpstreamErrorDetail(error);
  expect(detail.upstreamErrorCode).toBeUndefined();
  expect(JSON.stringify(detail)).not.toContain(sentinel);
  const scrubbed=scrubError(error,{source:"llm_failure"});
  const {body}=buildEnvelope(parseSentryDsn("https://public@o1.ingest.sentry.io/1")!,scrubbed,{installId:"fixture",release:"fixture",platform:"win32"});
  const tags=JSON.parse(body.trim().split("\n")[2]!).tags;
  for(const key of ["upstream_reason","upstream_error_param","upstream_error_code"]) expect(String(tags[key])).not.toContain(sentinel);
});
it("keeps recognized closed-vocabulary codes and structural paths",()=>{
  expect(extractUpstreamErrorDetail({status:400,body:{code:"invalid_value",param:"messages[9].content[2].text",text:'{"param":"messages[9].content[2].text"}'}})).toMatchObject({upstreamErrorCode:"invalid_value",upstreamErrorParam:"messages[].content[].text"});
  expect(extractUpstreamErrorDetail({status:400,body:{code:"private_identifier",status:"INVALID_ARGUMENT",text:"invalid"}}).upstreamErrorCode).toBe("INVALID_ARGUMENT");
});

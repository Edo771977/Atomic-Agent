import { afterEach, expect, it, vi } from "vitest";
import { setOfflineNetwork, resetOfflineNetworkForTests } from "../llm/offline-network.js";
import { buildRuntimeTelemetry } from "../analytics/toggle-runtime-telemetry.js";
import { SentryClient } from "./sentry-client.js";
import { parseSentryDsn } from "./sentry-config.js";
import { scrubError } from "./error-scrubber.js";

afterEach(()=>{resetOfflineNetworkForTests();vi.unstubAllEnvs();});
it("drops new provider details offline before any report is sent",async()=>{
  const fetchImpl=vi.fn(async()=>({ok:true,status:200}));
  const client=new SentryClient({dsn:parseSentryDsn("https://public@o1.ingest.sentry.io/1")!,installId:"fixture",release:"fixture",platform:"win32",fetchImpl});
  const event=scrubError(Object.assign(new Error("local only"),{status:400,body:{code:"INVALID_ARGUMENT",text:"missing thought_signature"}}),{source:"llm_failure"});
  expect(event.upstreamReason).toBe("missing_thought_signature");
  setOfflineNetwork(true);client.capture(event);await client.flush();
  expect(fetchImpl).not.toHaveBeenCalled();
  setOfflineNetwork(false);client.capture(event);await client.flush();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each([{enabled:false,errorReports:true},{enabled:true,errorReports:false}])("keeps reporting disabled with %j",flags=>{
  const createSentryClient=vi.fn((_options: unknown)=>null);
  const createAnalyticsClient=vi.fn((_options: unknown)=>null);
  const clients=buildRuntimeTelemetry({...flags,store:{getSharedInstallId:()=>"fixture"} as never,dimensions:{surface:"cli",arch:"x64",installChannel:"unknown"},version:"fixture",env:{},factories:{createSentryClient,createAnalyticsClient}});
  expect(clients.errorReporter).toBeNull();
  expect(createSentryClient.mock.calls[0]?.[0]).toMatchObject({enabled:false});
});

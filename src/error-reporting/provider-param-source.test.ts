import { expect, it } from "vitest";
import { extractUpstreamErrorDetail } from "./upstream-error-detail.js";

it("reads the structural parameter from body.param, ignoring contradictory prose", () => {
  expect(extractUpstreamErrorDetail({ body: { param: "messages[8].content[1].text", text: '{"param":"temperature"} tools.private_731: invalid' } }).upstreamErrorParam)
    .toBe("messages[].content[].text");
});
it.each([undefined, null, {}, ["temperature"], 3])("does not infer a parameter from prose when body.param is %j", param => {
  expect(extractUpstreamErrorDetail({ body: { param, message: "messages.3.content.0.text: invalid", text: '{"param":"temperature"}' } }).upstreamErrorParam).toBeUndefined();
});
it("bounds a user-named structured parameter and a reason influenced by quoted text", () => {
  expect(extractUpstreamErrorDetail({ body: { param: "tools[3].function.parameters.properties.private_731", message: 'User quoted "thought_signature" in their prompt' } }))
    .toEqual({ upstreamErrorParam: "tools[].function.parameters.properties.*", upstreamReason: "missing_thought_signature" });
});

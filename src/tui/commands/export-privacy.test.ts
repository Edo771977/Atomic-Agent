import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetConfigCache, USER_CONFIG_VERSION } from "../../config/index.js";
import { createEmptySessionState } from "../../session/index.js";
import { parseExportCommand, writeChatExport } from "./export-command.js";

const sentinel = "b7a2_config_credential_91fe43a2";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b7a2-export-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(dir, "state"));
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "state", "config.json"), JSON.stringify({version:USER_CONFIG_VERSION,llm:{activeTextProvider:"cloud",providers:[{id:"cloud",kind:"aimlapi",apiKey:sentinel,defaultChatModel:"fixture"}]}}));
  resetConfigCache();
});
afterEach(() => { resetConfigCache(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir,{recursive:true,force:true}); });
function chat(incognito = false) {
  const state = createEmptySessionState({id:"fixture",workingDir:dir,...(incognito?{incognito:{since:1,owner:"fixture"}}:{})});
  state.turns.push({kind:"user",text:`${sentinel} <script>globalThis.exportSentinel=1</script> ![image](https://example.invalid/image)`,at:1});
  return state;
}
it("refuses incognito before any file is written",async()=>{
  expect(await writeChatExport(chat(true),parseExportCommand("pdf private.pdf"),dir)).toMatch(/incognito.*confirm/i);
  expect(readdirSync(dir).filter(name=>name.endsWith(".pdf"))).toEqual([]);
});
it("writes incognito only after the person's explicit TUI confirmation",async()=>{
  expect(await writeChatExport(chat(true),parseExportCommand("--confirm-incognito pdf private.pdf"),dir)).toMatch(/chat exported/);
  expect(readFileSync(join(dir,"private.pdf"),"utf8")).not.toContain(sentinel);
});
it.each(["md","pdf","html","docx"])("masks configuration credentials in %s and the default filename",async format=>{
  expect(await writeChatExport(chat(),parseExportCommand(format),dir)).toMatch(/chat exported/);
  const files=readdirSync(dir).filter(name=>name!=="state");
  expect(files).toHaveLength(1);
  expect(files[0]).not.toContain(sentinel);
  const bytes=readFileSync(join(dir,files[0]!));
  if(format==="docx") {
    const zip=await JSZip.loadAsync(bytes);
    for(const file of Object.values(zip.files)) if(!file.dir) expect(await file.async("string")).not.toContain(sentinel);
  } else if(format==="pdf") {
    const text=bytes.toString("latin1");
    const re=/<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
    for(const match of text.matchAll(re)) {
      const start=match.index!+match[0].length;
      expect(inflateSync(bytes.subarray(start,start+Number(match[1]))).toString("latin1")).not.toContain(sentinel);
    }
  } else expect(bytes.toString("utf8")).not.toContain(sentinel);
});
it("preserves explicit destinations without force and permits an explicit forced write",async()=>{
  const path=join(dir,"keep.md"); writeFileSync(path,"original");
  expect(await writeChatExport(chat(),parseExportCommand("md keep.md"),dir)).toMatch(/exists.*--force/);
  expect(readFileSync(path,"utf8")).toBe("original");
  expect(await writeChatExport(chat(),parseExportCommand("--force md keep.md"),dir)).toMatch(/chat exported/);
  expect(readFileSync(path,"utf8")).not.toBe("original");
});
it("renders PDF as inert local text without network resources",async()=>{
  const fetcher=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network forbidden"));
  expect(await writeChatExport(chat(),parseExportCommand("pdf inert.pdf"),dir)).toMatch(/chat exported/);
  const pdf=readFileSync(join(dir,"inert.pdf"),"latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  expect(pdf).not.toMatch(/\/(?:JavaScript|JS|URI|OpenAction|Launch)\s+[<(]/);
  expect(fetcher).not.toHaveBeenCalled();
  expect((globalThis as Record<string,unknown>).exportSentinel).toBeUndefined();
});

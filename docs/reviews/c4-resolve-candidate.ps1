param([Parameter(Mandatory=$true)][string]$Candidate)
$ErrorActionPreference = 'Stop'
# Review-only resolution: retain fork lifecycle, scope, egress and OS-tool return contract.
foreach ($file in @('src/http/README.md','src/runtime/bootstrap.ts','src/runtime/composition/runtime-tool-catalog.ts','src/tools/tool-contract-conformance.test.ts')) {
  $path = Join-Path $Candidate $file
  $content = [IO.File]::ReadAllText($path)
  $content = [regex]::Replace($content, '(?ms)^<<<<<<< HEAD\r?\n(.*?)^=======\r?\n(.*?)^>>>>>>>[^\r\n]*\r?\n', {
    param($m)
    $ours = $m.Groups[1].Value
    $theirs = $m.Groups[2].Value
    switch ($file) {
      'src/http/README.md' { return ($theirs -split '\r?\n\r?\n')[0] + "`n`n" + $ours }
      'src/runtime/bootstrap.ts' {
        if ($ours.Contains('const fileCheckpoints')) { return "  const fileIndex = createRuntimeFileIndex({ config, notesStore, logger });`n`n" + $ours }
        return $ours + "    ...(fileIndex ? { fileIndex } : {}),`n"
      }
      'src/runtime/composition/runtime-tool-catalog.ts' {
        if ($ours.StartsWith('import')) { return $ours + $theirs }
        if ($ours.Contains('crossSession?:')) {
          return $ours.Replace('} & Pick<RegisterMemoryToolsOptions', "  fileIndex?: FileIndexApi;`n} & Pick<RegisterMemoryToolsOptions").Replace('canAskUser, crossSession, webFetchEgressRefusal }', 'canAskUser, crossSession, webFetchEgressRefusal, fileIndex }')
        }
        return $ours.Replace('  return osTools;', "  if (fileIndex) toolRegistry.register(buildFilesSearchTool({ index: fileIndex }));`n  return osTools;")
      }
      'src/tools/tool-contract-conformance.test.ts' { return $ours.Replace('118 upstream', '119 upstream').Replace('toHaveLength(123)', 'toHaveLength(124)') }
    }
  })
  if ($content -match '(?m)^<<<<<<<|^=======|^>>>>>>>') { throw "Unresolved conflict in $file" }
  [IO.File]::WriteAllText($path,$content)
}

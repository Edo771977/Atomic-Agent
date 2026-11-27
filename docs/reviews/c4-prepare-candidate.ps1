param(
  [Parameter(Mandatory=$true)][string]$Candidate,
  [ValidateSet('a','b')][string]$Through='a'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$base = '933e083818c3cc9d3cf8c2f1416324ff653baf11'
if ((& git -C $repo remote get-url origin) -cne 'https://github.com/Edo771977/Atomic-Agent.git') { throw 'Unexpected origin' }
if ((& git -C $repo remote get-url upstream) -cne 'https://github.com/AtomicBot-ai/atomic-agent.git') { throw 'Unexpected upstream' }
if (-not [IO.Path]::IsPathRooted($Candidate) -or (Test-Path -LiteralPath $Candidate)) { throw 'Use a new absolute disposable checkout path' }
& git -C $repo worktree add --detach $Candidate $base
if ($LASTEXITCODE -ne 0) { throw 'Cannot create candidate' }
$commits = @('30404f00a','41d55a2da','e7b07c1e7','4eef35798')
if ($Through -eq 'b') { $commits += '2dda8366f' }
foreach ($sha in $commits) {
  & git -C $Candidate cat-file -e "$sha`^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) {
    & git -C $Candidate fetch https://github.com/AtomicBot-ai/atomic-agent.git $sha
    if ($LASTEXITCODE -ne 0) { throw 'Fetch upstream commit first' }
  }
  & git -C $Candidate -c user.name=Edo771977 -c user.email=209531336+Edo771977@users.noreply.github.com cherry-pick -x $sha
  if ($LASTEXITCODE -eq 0) { continue }
  $conflicts = @(& git -C $Candidate diff --name-only --diff-filter=U)
  if ($sha -eq '2dda8366f' -and -not (Compare-Object @('src/tools/files/file-search.ts','src/tools/files/file-vector-store.ts') $conflicts)) {
    foreach ($file in $conflicts) {
      $path = Join-Path $Candidate $file
      $text = [IO.File]::ReadAllText($path)
      $text = [regex]::Replace($text, '(?ms)^<<<<<<< HEAD\r?\n(.*?)^=======\r?\n(.*?)^>>>>>>>[^\r\n]*\r?\n', { param($m) if ($file.EndsWith('file-search.ts')) { return $m.Groups[2].Value }; return $m.Groups[1].Value })
      # Keep 41d55a2da: the fallback must score every vector, including old chunks.
      $text = $text.Replace('vectors.scan(model, request.under, deps.scanLimit, keywordIds);','vectors.scan(model, request.under, deps.scanLimit, keywordIds, query);')
      [IO.File]::WriteAllText($path,$text)
    }
    & git -C $Candidate add -- $conflicts
    & git -C $Candidate -c core.editor=true -c user.name=Edo771977 -c user.email=209531336+Edo771977@users.noreply.github.com cherry-pick --continue
    if ($LASTEXITCODE -ne 0) { throw 'Cannot retain closest-vector fallback' }
    continue
  }
  if ($sha -eq '4eef35798' -and $conflicts.Count -eq 1 -and $conflicts[0] -eq 'grammars/tool-call.gbnf') {
    $path = Join-Path $Candidate 'grammars/tool-call.gbnf'
    $text = [IO.File]::ReadAllText($path)
    $text = [regex]::Replace($text, '(?ms)^<<<<<<< HEAD\r?\n(tool-name ::=[^\r\n]*)\r?\n=======\r?\ntool-name ::=[^\r\n]*\r?\n>>>>>>>[^\r\n]*\r?\n', { param($m) $m.Groups[1].Value.Replace(' | project-tool', ' | files-tool | project-tool') + "`n" })
    if ($text -match '(?m)^<<<<<<<|^=======|^>>>>>>>') { throw 'Unexpected grammar conflict' }
    [IO.File]::WriteAllText($path,$text)
    & git -C $Candidate add grammars/tool-call.gbnf
    & git -C $Candidate -c core.editor=true -c user.name=Edo771977 -c user.email=209531336+Edo771977@users.noreply.github.com cherry-pick --continue
    if ($LASTEXITCODE -ne 0) { throw 'Cannot retain fork grammar' }
    continue
  }
  $expected = @('src/http/README.md','src/runtime/bootstrap.ts','src/runtime/composition/runtime-tool-catalog.ts','src/tools/tool-contract-conformance.test.ts')
  if ($sha -ne '30404f00a' -or (Compare-Object $expected $conflicts)) { throw 'Unexpected conflict: inspect manually' }
  & (Join-Path $PSScriptRoot 'c4-resolve-candidate.ps1') -Candidate $Candidate
  & git -C $Candidate add -- $expected
  & git -C $Candidate -c core.editor=true -c user.name=Edo771977 -c user.email=209531336+Edo771977@users.noreply.github.com cherry-pick --continue
  if ($LASTEXITCODE -ne 0) { throw 'Cannot finish candidate pick' }
}
Write-Output 'Review-only candidate. Run npm ci here, then set C4_CANDIDATE_ROOT and run the c4a/c4b candidate audit from the deferral checkout.'

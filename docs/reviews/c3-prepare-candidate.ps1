param(
  [Parameter(Mandatory=$true)][string]$Candidate,
  [ValidateSet('a','b','c','d')][string]$Through='d'
)
$ErrorActionPreference = 'Stop'
$base = '104b6f7e6e111c017cff530c8c135899c2614db0'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ((& git -C $repo remote get-url origin) -cne 'https://github.com/Edo771977/Atomic-Agent.git') { throw 'Unexpected origin' }
if ((& git -C $repo remote get-url upstream) -cne 'https://github.com/AtomicBot-ai/atomic-agent.git') { throw 'Unexpected upstream' }
if (Test-Path -LiteralPath $Candidate) { throw 'Use a new disposable checkout path' }
if (-not [IO.Path]::IsPathRooted($Candidate)) { throw 'Use an absolute checkout path' }
& git -C $repo worktree add --detach $Candidate $base
if ($LASTEXITCODE -ne 0) { throw 'Cannot create candidate checkout' }
$commits = @('d093ba6a44b31206fef888121060fa80472d2b1b')
if ($Through -ne 'a') { $commits += @('374fc05f5754eb4ecd8725b4dd6ac1ebecf98a03','6edc49563e5350944f68a75a8bbe92f550b97b20','a45ab2986569947a38f9733e2e1f7be0ad4e36de') }
if ($Through -in @('c','d')) { $commits += 'e0d2d6dfc6743cf26bea823429298b21e92bc89f' }
if ($Through -eq 'd') { $commits += '89aecbec047767d2a15e92ee11812045a7510ef1' }
foreach ($sha in $commits) {
  & git -C $Candidate cat-file -e "$sha`^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) {
    & git -C $Candidate fetch upstream $sha
    if ($LASTEXITCODE -ne 0) { throw 'Cannot fetch the requested upstream commit' }
  }
  & git -C $Candidate -c user.name=Edo771977 -c user.email=209531336+Edo771977@users.noreply.github.com cherry-pick -x $sha
  if ($LASTEXITCODE -eq 0) { continue }
  $conflicts = @(& git -C $Candidate diff --name-only --diff-filter=U)
  if ($sha -ne '374fc05f5754eb4ecd8725b4dd6ac1ebecf98a03' -or $conflicts.Count -ne 1 -or $conflicts[0] -ne 'src/http/route-capabilities.ts') { throw 'Unexpected conflict: inspect manually' }
  $path = Join-Path $Candidate 'src/http/route-capabilities.ts'
  $text = [IO.File]::ReadAllText($path)
  if ($text -notmatch '(?s)<<<<<<< HEAD.*?project: true.*?fusionTeam:.*?=======.*?importFacts: true.*?>>>>>>> 374fc05f5') { throw 'Unexpected capability conflict shape' }
  $text = $text -replace '(?m)^<<<<<<< HEAD\r?\n','' -replace '(?m)^=======\r?\n','' -replace '(?m)^>>>>>>> 374fc05f5[^\r\n]*\r?\n',''
  [IO.File]::WriteAllText($path, $text)
  & git -C $Candidate add src/http/route-capabilities.ts
  & git -C $Candidate -c core.editor=true -c user.name=Edo771977 -c user.email=209531336+Edo771977@users.noreply.github.com cherry-pick --continue
  if ($LASTEXITCODE -ne 0) { throw 'Cannot retain fork capabilities' }
}
Write-Output 'Run npm ci in the candidate, set C3_CANDIDATE_ROOT, then run the corresponding c3*-candidate.mjs from the deferral checkout.'

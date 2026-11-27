param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Destination) { throw 'Destination must be a new checkout path.' }
$origin = git -C $RepoRoot remote get-url origin
$upstream = git -C $RepoRoot remote get-url upstream
if ($origin -ne 'https://github.com/Edo771977/Atomic-Agent.git' -or
    $upstream -ne 'https://github.com/AtomicBot-ai/atomic-agent.git') { throw 'Unexpected remotes.' }
# Intrinsic upstream audit: the parent of C1e, already containing C1a-C1d.
# This checkout is never the fork's integration/PR branch.
git -C $RepoRoot worktree add --detach $Destination 3ee5204d9720d3ec3a330eed6455d4dd65aaa694
if ($LASTEXITCODE -ne 0) { throw 'Could not create the candidate.' }
$chain = @(
  '262c5d652255b65e3054263d0b6760a86e6ee758',
  '45b70635f301bfa71e165f29436abbe2eda3b0c4',
  'eedbc37304cb3e1ad19bd52333e6abde104a6b75',
  'c7bbe934d36800028f21994816601f6607d85bff',
  '85b5647edc574eecc248b43b68e7d4eeb80cc1b2',
  '4b7e620ace1fffc0f673db9f340111df03b1249b',
  '43ed53606c4f3762c44f552aea66eefdbf334574',
  '1f29349ab5dedd34fc04c2dde598b4f5ad74ab05',
  '508297152da684ff5102be05bf73b3606f21d4ff',
  '5ec5df7eea94e03c44cc8d1596594105daadcd2c',
  'c9a4aa87ce555b9d96ef6494714782060f139d0f',
  '2b2825c7cc025ad0d766df7d4919cce74ec4ef21',
  'f79ce57f3d521577e1a59676c8e03217bda61b3b',
  'a6dba7ab5bce69fdc7075dc24ecf52518ff86308',
  '2794bdf005a2708db87a6b0e864e2ac631b20294'
)
foreach ($revision in $chain) {
  git -C $Destination cherry-pick -x $revision
  if ($LASTEXITCODE -ne 0) { throw "Candidate replay stopped at $revision" }
}
Push-Location -LiteralPath $Destination
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'Candidate dependency setup failed.' }
} finally { Pop-Location }
Write-Output 'Candidate prepared. Set C1E_CANDIDATE_ROOT to this checkout and run the audit from the review branch.'

# Run only in a disposable checkout of this PR with npm ci already completed.
$ErrorActionPreference = 'Stop'
$candidateCommit = '58ced8698de25ff20f2643b83637ffc4df1725fe'
git apply docs/reviews/b5c-candidate-tests.patch
if ($LASTEXITCODE -ne 0) { throw 'Could not apply candidate tests' }
$candidatePaths = git ls-tree -r --name-only $candidateCommit -- src/telephony
foreach ($candidatePath in $candidatePaths) {
    $candidateParent = Split-Path $candidatePath -Parent
    New-Item -ItemType Directory -Force -Path $candidateParent | Out-Null
    git show "${candidateCommit}:${candidatePath}" | Set-Content -Encoding utf8 -LiteralPath $candidatePath
    if ($LASTEXITCODE -ne 0) { throw "Could not read $candidatePath" }
}
npx vitest run src/tasks/b5c-candidate.test.ts
# Expected assertion failures are recorded in b5c-candidate-results.json.

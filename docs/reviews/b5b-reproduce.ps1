# Run only in a disposable checkout of this PR with npm ci already completed.
$ErrorActionPreference = 'Stop'
$candidateCommit = '7294526df588c40f60fae7873b95dfd248bbb6f4'
git apply docs/reviews/b5b-candidate-tests.patch
if ($LASTEXITCODE -ne 0) { throw 'Could not apply candidate tests' }
$candidatePaths = git ls-tree -r --name-only $candidateCommit -- src/channels/whatsapp
foreach ($candidatePath in $candidatePaths) {
    $candidateParent = Split-Path $candidatePath -Parent
    New-Item -ItemType Directory -Force -Path $candidateParent | Out-Null
    git show "${candidateCommit}:${candidatePath}" | Set-Content -Encoding utf8 -LiteralPath $candidatePath
    if ($LASTEXITCODE -ne 0) { throw "Could not read $candidatePath" }
}
npx vitest run src/tasks/b5b-candidate.test.ts
# Expected assertion failures are recorded in b5b-candidate-results.json.

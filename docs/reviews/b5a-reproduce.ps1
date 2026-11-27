# Run only in a disposable checkout of this PR with npm ci already completed.
$ErrorActionPreference = 'Stop'
$candidateCommit = '4f4e4f124809102738c0a239a8fd8baf5293862a'
git apply docs/reviews/b5a-candidate-tests.patch
if ($LASTEXITCODE -ne 0) { throw 'Could not apply candidate tests' }
$candidatePaths = git ls-tree -r --name-only $candidateCommit -- src/imap-mail src/config/imap-trigger-config.ts
foreach ($candidatePath in $candidatePaths) {
    $candidateParent = Split-Path $candidatePath -Parent
    New-Item -ItemType Directory -Force -Path $candidateParent | Out-Null
    git show "${candidateCommit}:${candidatePath}" | Set-Content -Encoding utf8 -LiteralPath $candidatePath
    if ($LASTEXITCODE -ne 0) { throw "Could not read $candidatePath" }
}
# Preserve #240 and subsequent bounded parsing; expose pure helpers only.
$extractorPath = 'src/tools/os/read-document/extractors/email-extractor.ts'
$extractorText = Get-Content -Raw -LiteralPath $extractorPath
foreach ($declaration in @('interface Part', 'function splitPart', 'function parseStructuredHeader', 'function decodeTransfer', 'function* splitMultipart')) {
    $extractorText = $extractorText.Replace("`n$declaration", "`nexport $declaration")
}
Set-Content -Encoding utf8 -LiteralPath $extractorPath -Value $extractorText
$messagePath = 'src/imap-mail/imap-message.ts'
$messageText = (Get-Content -Raw -LiteralPath $messagePath).Replace('splitMultipart(part.body, boundary).map(splitPart)', 'Array.from(splitMultipart(part.body, boundary), splitPart)')
Set-Content -Encoding utf8 -LiteralPath $messagePath -Value $messageText
npx vitest run src/tasks/b5a-candidate.test.ts
# Expected assertion failures are recorded in b5a-candidate-results.json.

param([Parameter(Mandatory)][string]$State)
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$roots = @(
    @{ Label = 'state'; Path = $State },
    @{ Label = 'profile'; Path = $env:USERPROFILE }
)
$readRights = [System.Security.AccessControl.FileSystemRights]::ReadData
foreach ($root in $roots) {
    $items = [System.Collections.Generic.Stack[string]]::new()
    $items.Push($root.Path)
    $readable = 0
    $unreadable = 0
    $sample = [System.Collections.Generic.List[string]]::new()
    while ($items.Count -gt 0) {
        $path = $items.Pop()
        try {
            $item = Get-Item -LiteralPath $path -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
            $acl = Get-Acl -LiteralPath $path
            foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
                if ($rule.IdentityReference.Value -eq 'S-1-15-2-1' -and
                    $rule.AccessControlType -eq 'Allow' -and
                    ($rule.FileSystemRights -band $readRights) -and
                    -not ($rule.PropagationFlags -band 'InheritOnly')) {
                    $readable++
                    if ($sample.Count -lt 12) {
                        $sample.Add([System.IO.Path]::GetRelativePath($root.Path, $path))
                    }
                    break
                }
            }
            if ($item.PSIsContainer) {
                Get-ChildItem -LiteralPath $path -Force | ForEach-Object { $items.Push($_.FullName) }
            }
        } catch {
            $unreadable++
        }
    }
    [pscustomobject]@{
        root = $root.Label; readable = $readable; inaccessibleToAudit = $unreadable; sample = @($sample)
    } | ConvertTo-Json -Compress
}

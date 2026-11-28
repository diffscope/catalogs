# SPDX-FileCopyrightText: Team OpenVPI
# SPDX-License-Identifier: Apache-2.0

param(
    [Parameter(Mandatory)]
    [string]$CacheDirectory,

    [Parameter(Mandatory)]
    [string]$SourceDirectory,

    [switch]$SaveSnapshot
)

$ErrorActionPreference = 'Stop'
$cachePath = [System.IO.Path]::GetFullPath($CacheDirectory, $env:GITHUB_WORKSPACE)
$env:CCACHE_DIR = $cachePath
$statistics = ccache --show-stats
if ($LASTEXITCODE -ne 0) {
    throw 'The ccache statistics could not be read.'
}
@(
    '### Ccache Statistics'
    ''
    '~~~text'
    $statistics
    '~~~'
) >> $env:GITHUB_STEP_SUMMARY

if (-not $SaveSnapshot) {
    return
}

function Get-CacheEntries([string]$Directory) {
    $entries = [System.Collections.Generic.Dictionary[string, System.IO.FileInfo]]::new([System.StringComparer]::Ordinal)
    foreach ($file in (Get-ChildItem -LiteralPath $Directory -Recurse -File)) {
        $key = [System.IO.Path]::GetRelativePath($Directory, $file.FullName).Replace('\', '').Replace('/', '')
        if ($key -cmatch '^[0-9a-f]{40}$') {
            $entries.Add($key, $file)
        }
    }
    return ,$entries
}

$sourceEntries = Get-CacheEntries $SourceDirectory
$currentEntries = Get-CacheEntries $cachePath
$changed = $currentEntries.Count -ne $sourceEntries.Count
if (-not $changed) {
    foreach ($entry in $currentEntries.GetEnumerator()) {
        if (-not $sourceEntries.ContainsKey($entry.Key) -or $entry.Value.Length -ne $sourceEntries[$entry.Key].Length) {
            $changed = $true
            break
        }
    }
}
if (-not $changed) {
    foreach ($entry in $currentEntries.GetEnumerator()) {
        $currentHash = (Get-FileHash -LiteralPath $entry.Value.FullName -Algorithm SHA256).Hash
        $sourceHash = (Get-FileHash -LiteralPath $sourceEntries[$entry.Key].FullName -Algorithm SHA256).Hash
        if ($currentHash -ne $sourceHash) {
            $changed = $true
            break
        }
    }
}

@(
    ''
    '### Ccache Snapshot'
    ''
    '| Restored Entries | Retained Entries |'
    '| ---: | ---: |'
    "| $($sourceEntries.Count) | $($currentEntries.Count) |"
) >> $env:GITHUB_STEP_SUMMARY
if (-not $changed -or $currentEntries.Count -eq 0) {
    return
}

$compressionStatistics = ccache --recompress 10
if ($LASTEXITCODE -ne 0) {
    throw 'The ccache snapshot could not be recompressed.'
}
@(
    ''
    '~~~text'
    $compressionStatistics
    '~~~'
) >> $env:GITHUB_STEP_SUMMARY
'save=true' >> $env:GITHUB_OUTPUT

# SPDX-FileCopyrightText: Team OpenVPI
# SPDX-License-Identifier: Apache-2.0

param(
    [Parameter(Mandatory)]
    [string]$CacheDirectory
)

$ErrorActionPreference = 'Stop'
$versionOutput = ccache --print-version
if ($LASTEXITCODE -ne 0) {
    throw 'The ccache version could not be determined.'
}
$installedVersion = [System.Version]::Parse(($versionOutput -join '').Trim())
if ($installedVersion -lt [System.Version]'4.14') {
    throw 'Ccache 4.14 or later is required.'
}
Write-Host "Ccache version: $installedVersion"

$cachePath = [System.IO.Path]::GetFullPath($CacheDirectory, $env:GITHUB_WORKSPACE)
$sourcePath = "$cachePath-source-$([guid]::NewGuid())"
if (Test-Path -LiteralPath $cachePath) {
    $cacheDirectoryItem = Get-Item -LiteralPath $cachePath -Force
    if (-not $cacheDirectoryItem.PSIsContainer -or $cacheDirectoryItem.LinkType) {
        throw "The restored ccache path must be a directory without a symbolic link: $cachePath"
    }
    Move-Item -LiteralPath $cachePath -Destination $sourcePath
} else {
    [void][System.IO.Directory]::CreateDirectory($sourcePath)
}
New-Item -ItemType Directory -Path $cachePath | Out-Null

$sourceUri = [System.Uri]::new($sourcePath, [System.UriKind]::Absolute).AbsoluteUri
$env:CCACHE_DIR = $cachePath
ccache --zero-stats | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'The ccache statistics could not be reset.'
}

@(
    "CCACHE_DIR=$cachePath"
    "CCACHE_REMOTE_STORAGE=$sourceUri @layout=local"
    'CCACHE_COMPILERCHECK=content'
    'CCACHE_NOHARDLINK=true'
    'CCACHE_NOFILECLONE=true'
) >> $env:GITHUB_ENV
"source-directory=$sourcePath" >> $env:GITHUB_OUTPUT

# SPDX-FileCopyrightText: Team OpenVPI
# SPDX-License-Identifier: Apache-2.0

param(
    [Parameter(Mandatory)]
    [string]$SourceDirectory,

    [Parameter(Mandatory)]
    [ValidatePattern('^[^\r\n]+\z')]
    [string]$ArchivePath,

    [string]$RootName,

    [ValidateSet('standard', 'maximum')]
    [string]$Compression = 'standard'
)

$ErrorActionPreference = 'Stop'
$source = Get-Item -LiteralPath $SourceDirectory -Force
if (-not $source.PSIsContainer -or -not $source.Parent -or $source.LinkType) {
    throw "The source must be a directory with a parent and without a symbolic link: $SourceDirectory"
}
$archive = [System.IO.Path]::GetFullPath($ArchivePath, (Get-Location).ProviderPath)
$format = switch -Wildcard ($archive.ToLowerInvariant()) {
    '*.7z' { '7z' }
    '*.zip' { 'zip' }
    '*.tar.xz' { 'tar.xz' }
    default { throw "Unsupported archive format: $archive" }
}
if (Test-Path -LiteralPath $archive) {
    throw "The archive already exists: $archive"
}
$relativeArchive = [System.IO.Path]::GetRelativePath($source.FullName, $archive)
$parentPrefix = '..' + [System.IO.Path]::DirectorySeparatorChar
if (-not [System.IO.Path]::IsPathRooted($relativeArchive) -and -not $relativeArchive.StartsWith($parentPrefix)) {
    throw 'The archive path must be outside the source directory.'
}
if (-not $RootName) {
    $RootName = $source.Name
}
if ($RootName -cnotmatch '^[\p{L}\p{N}_](?:[\p{L}\p{N}_. -]*[\p{L}\p{N}_-])?\z') {
    throw "Invalid top-level archive directory name: $RootName"
}

$baseDirectory = $source.Parent.FullName
$stagingRoot = $null
try {
    if ($RootName -cne $source.Name) {
        $runnerTemp = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
        $stagingRoot = Join-Path $runnerTemp "pack-archive-$([guid]::NewGuid())"
        New-Item -ItemType Directory -Path $stagingRoot | Out-Null
        $stagingDirectory = Join-Path $stagingRoot $RootName
        if ($IsWindows) {
            New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
            Get-ChildItem -LiteralPath $source.FullName -Force | Copy-Item -Destination $stagingDirectory -Recurse -Force
        } else {
            /bin/cp -a -- $source.FullName $stagingDirectory
            if ($LASTEXITCODE -ne 0) {
                throw 'Archive staging failed.'
            }
        }
        $baseDirectory = $stagingRoot
    }

    Push-Location -LiteralPath $baseDirectory
    try {
        if ($format -eq 'tar.xz') {
            if ($Compression -eq 'maximum') {
                tar --use-compress-program 'xz --lzma2=preset=9e,dict=256MiB' -cf $archive -- $RootName | Out-Host
            } else {
                tar -cJf $archive -- $RootName | Out-Host
            }
        } else {
            $arguments = @('a', "-t$format", '-mx=9')
            if ($format -eq '7z') {
                $arguments += '-ms=on'
                if ($Compression -eq 'maximum') {
                    $arguments += '-m0=lzma2:d=256m'
                }
            }
            if (-not $IsWindows) {
                $arguments += '-snl'
            }
            7z @arguments $archive $RootName | Out-Host
        }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archive -PathType Leaf)) {
            throw "Archive creation failed: $archive"
        }
    } finally {
        Pop-Location
    }
} finally {
    if ($stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) {
        $staging = Get-Item -LiteralPath $stagingRoot -Force
        if ($staging.Parent.FullName -cne $runnerTemp -or $staging.LinkType) {
            throw "The staging directory must be within the runner temporary directory: $stagingRoot"
        }
        Remove-Item -LiteralPath $staging.FullName -Recurse -Force
    }
}

"path=$archive" >> $env:GITHUB_OUTPUT

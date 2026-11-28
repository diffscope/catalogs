# SPDX-FileCopyrightText: Team OpenVPI
# SPDX-License-Identifier: Apache-2.0

param(
    [Parameter(Mandatory)]
    [string]$InstallDirectory,

    [ValidatePattern('^[^\r\n]*\z')]
    [string]$OutputDirectory,

    [string]$PdbSearchPaths,
    [switch]$Strip,
    [switch]$AdHocSign
)

$ErrorActionPreference = 'Stop'
if ($AdHocSign -and (-not $IsMacOS -or -not $Strip)) {
    throw 'Ad hoc signing requires stripping on macOS.'
}

$installItem = Get-Item -LiteralPath $InstallDirectory -Force
if (-not $installItem.PSIsContainer) {
    throw "The installation path must be a directory: $InstallDirectory"
}
$installPath = $installItem.FullName
$symbolPath = if ($OutputDirectory) {
    [System.IO.Path]::GetFullPath($OutputDirectory, (Get-Location).ProviderPath)
} else {
    Join-Path $env:RUNNER_TEMP "debug-symbols-$([guid]::NewGuid())"
}
New-Item -ItemType Directory -Path $symbolPath | Out-Null

function Get-SymbolDestination([System.IO.FileInfo]$Binary) {
    $relativeDirectory = [System.IO.Path]::GetRelativePath($installPath, $Binary.DirectoryName)
    $destination = Join-Path $symbolPath $relativeDirectory
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    return $destination
}

function Get-FilesByMagic([string[]]$MagicNumbers) {
    Get-ChildItem -LiteralPath $installPath -File -Recurse -Attributes !ReparsePoint | Where-Object {
        $stream = $_.OpenRead()
        try {
            $magic = [byte[]]::new(4)
            $stream.Read($magic, 0, $magic.Length) -eq $magic.Length -and
                [System.Convert]::ToHexString($magic) -in $MagicNumbers
        } finally {
            $stream.Dispose()
        }
    }
}

if ($IsWindows) {
    $searchPaths = ($PdbSearchPaths -split '\r?\n').Trim() | Where-Object { $_ } | ForEach-Object {
        [System.IO.Path]::GetFullPath($_, (Get-Location).ProviderPath)
    }
    $env:_NT_ALT_SYMBOL_PATH = (@($searchPaths) + $env:_NT_ALT_SYMBOL_PATH | Where-Object { $_ }) -join ';'
    $binaries = Get-ChildItem -LiteralPath $installPath -File -Recurse -Attributes !ReparsePoint |
        Where-Object { $_.Extension -in '.exe', '.dll', '.pyd' }
    foreach ($binary in $binaries) {
        $pdbOutput = dumpbin /PDBPATH $binary.FullName
        $match = [regex]::Match(($pdbOutput -join [Environment]::NewLine), "PDB file found at.*'(.*)'")
        if ($match.Success) {
            $destination = Get-SymbolDestination $binary
            Copy-Item -LiteralPath $match.Groups[1].Value -Destination $destination -Force
        }
    }
} elseif ($IsMacOS) {
    foreach ($binary in (Get-FilesByMagic @('CFFAEDFE', 'FEEDFACF', 'CAFEBABE', 'CAFEBABF', 'BEBAFECA', 'BFBAFECA'))) {
        $debugMap = dsymutil -s $binary.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "Debug map inspection failed: $($binary.FullName)"
        }
        if (($debugMap -join [Environment]::NewLine) -notmatch 'N_OSO') {
            continue
        }
        $destination = Get-SymbolDestination $binary
        dsymutil $binary.FullName -o (Join-Path $destination "$($binary.Name).dSYM") | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "Debug symbol extraction failed: $($binary.FullName)"
        }
        if ($Strip) {
            strip -S $binary.FullName | Out-Host
            if ($LASTEXITCODE -ne 0) {
                throw "Debug symbol stripping failed: $($binary.FullName)"
            }
        }
        if ($AdHocSign) {
            codesign --force --sign - $binary.FullName | Out-Host
            if ($LASTEXITCODE -ne 0) {
                throw "Ad hoc signing failed: $($binary.FullName)"
            }
        }
    }
} elseif ($IsLinux) {
    $env:LC_ALL = 'C'
    foreach ($binary in (Get-FilesByMagic '7F454C46')) {
        $binaryDescription = file -b -- $binary.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "ELF inspection failed: $($binary.FullName)"
        }
        if ($binaryDescription -notmatch 'with debug_info') {
            continue
        }
        $destination = Get-SymbolDestination $binary
        objcopy --only-keep-debug $binary.FullName (Join-Path $destination "$($binary.Name).debug") | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "Debug symbol extraction failed: $($binary.FullName)"
        }
        if ($Strip) {
            strip --strip-debug $binary.FullName | Out-Host
            if ($LASTEXITCODE -ne 0) {
                throw "Debug symbol stripping failed: $($binary.FullName)"
            }
        }
    }
} else {
    throw 'Debug symbol collection requires Windows, macOS, or Linux.'
}

"directory=$symbolPath" >> $env:GITHUB_OUTPUT
exit 0

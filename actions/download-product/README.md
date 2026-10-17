<!--
SPDX-FileCopyrightText: Team OpenVPI
SPDX-License-Identifier: Apache-2.0
-->

# Download Catalog Product

Download one artifact from a v1 product catalog on Windows, Linux, or macOS. The action resolves the release, selects an artifact, verifies its byte size and SHA-256, and returns its metadata and absolute file path. Files retain their original format and are ready for subsequent extraction or installation steps. No checkout is required in the calling job.

```yaml
steps:
  - name: Download LibreSVIP CLI
    id: download
    uses: diffscope/catalogs/actions/download-product@main
    with:
      product: libresvip-cli
      version: '2.9.2'
      variant: portable
      directory: downloads
      fail-on-no-match: 'true'

  - name: Use the downloaded file
    if: steps.download.outputs.matched == 'true'
    shell: pwsh
    env:
      ARCHIVE: ${{ steps.download.outputs.path }}
      RELEASE: ${{ steps.download.outputs.version }}
    run: |
      Write-Host "Downloaded version $env:RELEASE to $env:ARCHIVE"
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `source` | `https://catalogs.diffscope.org/v1` | HTTP(S) catalog root containing product directories. Include `v1` in this URL; a trailing slash is optional. Index entries can reference relative or absolute manifest URLs. Artifact URLs come from the selected manifest. |
| `product` | Required | Product ID, such as `diffscope`, `dspm`, or `libresvip-cli`. |
| `channel` | `stable` | `stable`, `beta`, or `nightly`. Nightly releases use `nightly.json`; the other channels use `index.json`. |
| `version` | `latest` | Exact version string from the index, or `latest` for its first entry. Catalog indexes are already ordered newest first. Version ranges and tag prefixes are not expanded. |
| `platform` | Current runner | `windows`, `linux`, `macos`, or another catalog platform. `win32`, `darwin`, and `osx` are normalized to catalog names. |
| `arch` | Current runner | Architecture such as `amd64`, `arm64`, or `x86`. `x64`/`x86_64`, `aarch64`, and `ia32` are normalized to these names. |
| `variant` | First for platform/arch | First variant in manifest order for the selected platform and architecture. Empty and omitted variants in manifests are equivalent. |
| `directory` | `github.workspace` | Absolute directory or a path relative to `github.workspace`. Created when needed. The filename comes from the artifact URL, with URL escapes decoded and query parameters excluded. |
| `fail-on-no-match` | `false` | Set to `'true'` to fail when the channel is empty, the requested version is absent, or no artifact matches. |
| `cache` | `true` | Set to `'false'` to disable restoring, saving, and reusing cached files. |
| `cache-key-prefix` | `catalog-download-v1` | Cache namespace. Change it to invalidate existing caches. A SHA-256 of the catalog source, product, channel, resolved version, and complete artifact metadata is always appended. |

Selection matches only platform, architecture, and variant. When `variant` is omitted, the first variant for the selected platform and architecture is used. If several artifacts match, the first one in manifest order is downloaded. The artifact's format is returned as metadata. Selection never falls back to an older release when the selected release lacks a matching artifact.

An alternative catalog source and an explicit artifact selection can be configured as follows:

```yaml
- uses: diffscope/catalogs/actions/download-product@main
  id: download
  with:
    source: https://example.org/catalogs/v1
    product: diffscope
    channel: nightly
    version: latest
    platform: windows
    arch: amd64
    variant: portable
    directory: downloads/diffscope
    fail-on-no-match: 'true'
    cache: 'true'
    cache-key-prefix: my-downloads-v2
```

## Outputs

All boolean outputs are the strings `'true'` and `'false'`. Compare `matched` explicitly in workflow conditions.

| Output | Description |
| --- | --- |
| `matched` | Whether an artifact matched the request. |
| `path` | Absolute path to the verified downloaded file. Empty when no artifact matched. |
| `cache-hit` | Whether a verified cached file was used, including reuse by another invocation in the same job. `false` if no artifact matched or caching is disabled. |
| `cache-key` | Complete cache key. Empty when caching is disabled or no artifact matched. |
| `version` | Resolved version. Empty when the requested version is absent or the channel has no releases. |
| `platform`, `arch`, `variant` | Selected artifact conditions. With no match, these retain the requested/default conditions where available. |
| `format` | Selected artifact format as metadata. Empty when no artifact matched. |
| `url`, `size`, `sha256` | Download URL, byte size, and lowercase SHA-256 for the selected artifact. Empty when no artifact matched. |
| `artifact` | Selected artifact metadata as JSON, including platform, arch, format, optional variant, URL, size, and SHA-256. Empty when no artifact matched. |
| `manifest`, `manifest-url` | Full release manifest as JSON and its URL. Available even when the release has no matching artifact; empty when no version was selected. |

By default, no match succeeds with `matched: 'false'` and an empty `path`, without downloading or caching an artifact. Invalid inputs, HTTP failures, malformed catalogs, release identity mismatches, and size/checksum failures always fail the action. An unavailable catalog URL is an HTTP failure, rather than an empty catalog.

## Caching and verification

The action uses `actions/cache/restore@v5` and `actions/cache/save@v5` to cache only the selected artifact, in an isolated directory under `runner.temp`. Cache identity includes the resolved version and checksum, so a moving `latest` request cannot reuse a different release. Changing the download directory does not change the cache key.

Catalog indexes and manifests are fetched on every invocation. Both restored files and newly downloaded files are checked against the manifest's size and SHA-256. An invalid cached file is downloaded again. Exact GitHub cache entries are immutable; change `cache-key-prefix` to replace an invalid remote entry. A verified cached file is copied to the requested directory, so changing that copy does not modify the cache.

Downloads stream to temporary files. Only fully verified files replace the destination; failed downloads clean up partial files and preserve existing destination files. The action logs the selected release and artifact, cache reuse, and final path.

The action uses the Node.js 24 runtime through `actions/github-script@v8`, and requires [Actions Runner 2.327.1 or newer](https://github.com/actions/github-script#v8).

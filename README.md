<!--
SPDX-FileCopyrightText: Team OpenVPI
SPDX-License-Identifier: Apache-2.0
-->

# DiffScope Catalogs

The `v1` directory contains product release catalogs. Each product has an `index.json` for stable and beta releases and a `nightly.json` for nightly releases. Version manifests are stored as `<channel>/<version>.json` relative to the product directory.

## Catalog Updates

Product CI generates a complete version manifest after publishing a release. The manifest includes the release channel, semantic version, publication timestamp, source commit and tag, release notes URL, and each artifact's platform, architecture, format, variant, download URL, size, and SHA-256 checksum. The format is defined by [version.schema.json](schema/v1/version.schema.json).

All products and the stable, beta, and nightly channels use `.github/workflows/update-catalog.yml`. The workflow accepts three inputs:

| Input | Value |
| --- | --- |
| `product` | Existing product directory under `v1`, such as `diffscope` or `dspm`. The identifier contains lowercase ASCII letters, digits, and single internal hyphens. |
| `channel` | `stable`, `beta`, or `nightly`, matching the manifest's `channel` field. |
| `manifest` | Complete version manifest serialized as a JSON string. |

The workflow validates the supplied manifest and local indexes against the schemas. It merges only the requested channel and writes the supplied manifest without querying releases or downloading artifacts. Stable and beta versions are sorted by descending Semantic Versioning precedence. Nightly versions use `a.b.c-nightly.YYYYMMDD.N` and are sorted by descending date, sequence, and base version. Build metadata provides a deterministic tie breaker for versions with equal precedence.

An identical submission succeeds without a commit. A different manifest for an existing product, channel, and version is rejected. Catalog updates share a concurrency queue and retry pushes against the latest `main` to retain concurrent repository changes.

New products require an initial `index.json` conforming to the schema and a `nightly.json` if they publish nightly releases. Unused stable or beta channels have empty version lists. No product-specific workflow or update script is required for products that supply manifests from their own CI.

## Product CI Action

The composite action at `diffscope/catalogs/actions/update-catalog@main` dispatches the update workflow and waits up to 30 minutes for its result. A failed update or timeout fails the calling step. Cross-repository callers can supply GitHub App credentials as below, or a `token` with Actions write permission on `diffscope/catalogs`. The action requires no source checkout in the calling job.

```yaml
UpdateCatalogs:
  needs: Publish
  runs-on: ubuntu-latest
  timeout-minutes: 35
  steps:
    - name: Update catalogs and wait for completion
      uses: diffscope/catalogs/actions/update-catalog@main
      with:
        product: diffscope
        channel: nightly
        manifest: ${{ needs.Publish.outputs.catalog_manifest }}
        app-id: ${{ vars.WORKFLOW_APP_ID }}
        private-key: ${{ secrets.WORKFLOW_APP_PRIVATE_KEY }}
```

The GitHub App must be installed on `diffscope/catalogs` with Actions write permission. The catalog workflow uses its own `GITHUB_TOKEN` with Contents write permission for commits. Product workflows retain the `WORKFLOW_APP_ID` variable and `WORKFLOW_APP_PRIVATE_KEY` secret.

Workflows in this repository can omit `app-id`, `private-key`, and `token`. The action then uses the calling job's `GITHUB_TOKEN`; that job must grant `actions: write`. Supplying App credentials continues to use an App token, and an explicit `token` takes precedence over App credentials.

The action passes all three inputs directly to the workflow. The serialized inputs must fit the [GitHub workflow dispatch payload limit](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#defining-inputs-for-manually-triggered-workflows). Release notes remain a URL, and artifacts remain metadata in the manifest.

## Product Nightly Action

The action at `diffscope/catalogs/actions/nightly@main` centralizes nightly eligibility checks, dev and nightly build version preparation, artifact download, prerelease publication, and version manifest generation. Products declare their repository, version source, build attempt identity, and artifact list in `.github/nightly.json`. Their workflows retain schedules, concurrency queues, compilation, packaging, and catalog dispatch through `update-catalog`.

The `check`, `prepare`, and `publish` operations share the same implementation. Release creation uses the verified existing tag without an explicit target commit. CMake project versions and plain version files are supported.

See the [nightly action documentation](actions/nightly/README.md) for configuration, permissions, operation examples, and outputs.

## Product Download Action

The action at `diffscope/catalogs/actions/download-product@main` downloads a product artifact from a configurable catalog source. It defaults to the current runner's platform and architecture, the latest stable version, and the first variant for that platform and architecture. Downloads and cached files are verified against the manifest's byte size and SHA-256. No checkout is required.

```yaml
- name: Download LibreSVIP CLI
  id: download
  uses: diffscope/catalogs/actions/download-product@main
  with:
    product: libresvip-cli
    version: '2.9.2'
    variant: portable
    directory: downloads
    fail-on-no-match: 'true'
```

Use `steps.download.outputs.path` for the absolute downloaded file path and `steps.download.outputs.artifact` or `manifest` for JSON metadata. No match succeeds by default with `matched: 'false'` and an empty path; set `fail-on-no-match: 'true'` to fail instead. Check `steps.download.outputs.matched == 'true'` before using optional downloads. Caching is enabled by default and can be configured with `cache` and `cache-key-prefix`.

See the [download action documentation](actions/download-product/README.md) for all inputs, outputs, selection rules, and examples using alternative catalog sources.

## LibreSVIP CLI

LibreSVIP CLI uses the product ID `libresvip-cli` and publishes only the stable channel at `v1/libresvip-cli/index.json`. The beta list is empty, and there is no nightly catalog. The former `3rdparty/libresvip/index.json` is removed.

`.github/workflows/sync-libresvip.yml` retains its daily schedule and manual trigger. It queries the upstream release list, compares stable versions against the v1 index, and downloads and verifies new versions on Linux amd64 and macOS arm64 by checking `libresvip-cli plugin list` for the DSPX plugin. After verification, `.github/scripts/libresvip.py` builds complete manifests and the local `update-catalog` action submits each one using `GITHUB_TOKEN`.

The fixed CLI artifact list covers Windows amd64, arm64, and x86; Linux amd64 and arm64; and macOS amd64 and arm64, matching upstream v2.9.2. All CLI archives use the `portable` variant. Manifests use the release timestamp, resolved tag commit, release notes URL, and each asset's download URL, byte size, and SHA-256 digest. If GitHub has no digest, the script downloads the asset to compute it. A missing expected asset fails the update.

The initial migration contains only the three versions previously cataloged: `2.8.1`, `2.9.0`, and `2.9.2`, with all seven CLI artifacts for each version.

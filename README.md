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

New products require initial `index.json` and `nightly.json` files conforming to the corresponding schemas. No product-specific workflow or update script is required.

## Product CI Action

The composite action at `diffscope/catalogs/actions/update-catalog@main` creates a GitHub App token, dispatches the update workflow, and waits up to 30 minutes for its result. A failed update or timeout fails the calling step. The action requires no source checkout in the calling job.

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

The action passes all three inputs directly to the workflow. The serialized inputs must fit the [GitHub workflow dispatch payload limit](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#defining-inputs-for-manually-triggered-workflows). Release notes remain a URL, and artifacts remain metadata in the manifest.

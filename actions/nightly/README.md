<!--
SPDX-FileCopyrightText: Team OpenVPI
SPDX-License-Identifier: Apache-2.0
-->

# Product Nightly Release

`diffscope/catalogs/actions/nightly@main` provides shared nightly eligibility, build version reservation, artifact download, and prerelease publication. The caller owns its schedule, concurrency queue, build matrix, packaging, and catalog dispatch through the [update-catalog action](../update-catalog/action.yml).

The action requires a source checkout at `source-sha`. The default configuration file is `.github/nightly.json`. The `publish` operation requires the GitHub CLI and downloads artifacts from the current workflow run. GitHub-hosted Ubuntu runners provide the required environment.

## Configuration

Each product declares its repository, version source, build attempt identity, and exact release artifact list in a JSON file.

```json
{
    "repository": "diffscope/example",
    "attemptKind": "example-nightly-build",
    "versionFile": "CMakeLists.txt",
    "versionFormat": "cmake",
    "artifacts": [
        {
            "suffix": "_Windows_amd64_portable.zip",
            "platform": "windows",
            "arch": "amd64",
            "format": "zip",
            "variant": "portable"
        }
    ]
}
```

`versionFormat` accepts `cmake` or `text`. The CMake format reads the name and `a.b.c` version from `project(...)`. The text format reads an `a.b.c` version from `versionFile` and requires an `applicationName` field. Configuration files, version files, and release artifact directories must resolve inside `github.workspace`.

`attemptKind` identifies the build attempt metadata in annotated nightly tags. It must remain consistent across check, prepare, and publish. Artifact suffixes must be unique filenames beginning with an underscore. The tuple of platform, architecture, format, and variant must also be unique. An unqualified artifact uses an empty variant.

Artifact filenames concatenate the prepared application name, an underscore, the semantic version with each period, hyphen, and plus sign replaced by an underscore, and the declared suffix. For example, `example_nightly` and `0.1.0-nightly.20261020.1` produce `example_nightly_0_1_0_nightly_20261020_1_Windows_amd64_portable.zip`.

## Operations

### Eligibility

```yaml
- name: Check nightly eligibility
  id: check
  uses: diffscope/catalogs/actions/nightly@main
  with:
    operation: check
```

The check requires `contents: read` and `actions: read`. It returns `should_build: 'false'` if the source commit was already attempted or has no commits ahead of the latest attempt. It also returns false if the latest matching Dev Build has a `failure` conclusion. All other Dev Build states, including cancellation, in-progress runs, and success, permit a nightly build. The Dev Build workflow is `dev-build.yml`, and eligible events are `push` and `workflow_dispatch`. An absent matching Dev Build does not block a nightly build. Reruns can resume their reserved attempt.

### Version Reservation

```yaml
- name: Prepare build version
  id: version
  uses: diffscope/catalogs/actions/nightly@main
  with:
    operation: prepare
    source-sha: ${{ inputs.source_sha }}
    build-type: ${{ inputs.build_type }}
    version-identifier: ${{ inputs.version_identifier }}
```

Nightly preparation requires `contents: write`. It reserves `a.b.c-nightly.YYYYMMDD.N` with an annotated tag and a tag reference before compilation. The date uses UTC, and the sequence increases across nightly tags for that date. `version-identifier` can specify the current UTC date and an unused increasing sequence. A rerun reuses the reservation associated with its workflow run and rejects a different source, base version, or requested identifier.

Dev preparation requires only a source checkout. It returns `a.b.c+identifier`, defaults an empty identifier to the full source SHA, and performs no GitHub API calls or repository writes. The caller can use the same prepare step for both build types.

Preparation returns `semver`, `tag`, `application_name`, `version_identifier`, and `version_suffix`. The application name is the project name followed by `_dev` or `_nightly`. The version suffix includes its leading `+` or `-`. The nightly tag is `v` followed by the semantic version. A dev build returns an empty tag.

### Publication

```yaml
- name: Publish nightly prerelease
  id: publish
  uses: diffscope/catalogs/actions/nightly@main
  with:
    operation: publish
    tag: ${{ needs.Build.outputs.tag }}
    application-name: ${{ needs.Build.outputs.application_name }}
```

Publication requires `contents: write` and `actions: read`. The action downloads artifacts matching `<application-name>_*` into `directory`, which defaults to `release-assets`. The declared artifact files must be present and nonempty. Publication validates the annotated tag's source commit, version, and workflow run identity. It creates a prerelease draft, uploads the expected assets, verifies completeness, and publishes the draft without marking it as the latest release. Existing draft assets with matching sizes and SHA-256 digests are retained. Unexpected release assets are rejected. A complete published prerelease can be reused on a rerun.

Release creation uses the verified existing tag and omits `target_commitish`. An explicit target commit can require additional workflow write permission under the [Release API permission rules](https://docs.github.com/en/rest/releases/releases#create-a-release).

The `catalog_manifest` output contains the nightly version manifest, including the publication timestamp, source identity, release notes URL, and each asset's download URL, size, and SHA-256. It can be passed to the existing `update-catalog` action using product-specific catalog credentials.

## Workflow Ownership

Nightly check, preparation, and publication require `refs/heads/main`, the triggering source SHA, and the configured repository. Dev preparation also supports pull requests and forks. The caller must serialize nightly workflows with a concurrency queue so that two runs cannot reserve the same sequence. The action does not build or package products.

The `token` input defaults to the caller's `github.token`. Catalog credentials belong to the separate catalog dispatch step. The `config`, `source-sha`, `build-type`, `version-identifier`, `tag`, `application-name`, and `directory` inputs select the product configuration and operation arguments. The action metadata documents their defaults and output names.

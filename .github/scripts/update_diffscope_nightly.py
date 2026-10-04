# SPDX-FileCopyrightText: Team OpenVPI
# SPDX-License-Identifier: Apache-2.0

"""Verify a published DiffScope nightly and merge it into the release catalog."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.parse
import urllib.request

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


SOURCE_REPOSITORY = "diffscope/diffscope-project"
API_ROOT = f"https://api.github.com/repos/{SOURCE_REPOSITORY}/"
NIGHTLY_PATTERN = re.compile(r"^(\d+\.\d+\.\d+)-nightly\.(\d{8})\.([1-9]\d*)$")
CATALOG_ROOT = Path("v1/diffscope")


def read_json(path):
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")


def validators():
    schemas = {
        name: read_json(Path("schema/v1") / f"{name}.schema.json")
        for name in ("index", "nightly", "version")
    }
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()
    )
    return {
        name: Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())
        for name, schema in schemas.items()
    }


def github_json(endpoint):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "DiffScopeCatalogUpdate",
        "X-GitHub-Api-Version": "2026-03-10",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(API_ROOT + endpoint, headers=headers)
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def expected_artifacts(application_name, version):
    escaped_version = re.sub(r"[.\-+]", "_", version)
    base = f"{application_name}_{escaped_version}"
    return [
        (f"{base}_Windows_amd64_installer.exe", "windows", "amd64", "exe", "installer"),
        (f"{base}_Windows_amd64_portable.zip", "windows", "amd64", "zip", "portable"),
        (f"{base}_Windows_amd64_debug_symbols.7z", "windows", "amd64", "7z", "debug_symbols"),
        (f"{base}_macOS_arm64.dmg", "macos", "arm64", "dmg", ""),
        (f"{base}_macOS_arm64_debug_symbols.7z", "macos", "arm64", "7z", "debug_symbols"),
    ]


def download_digest(url):
    # These are public, published assets. Never forward the API token through download redirects.
    request = urllib.request.Request(url, headers={"User-Agent": "DiffScopeCatalogUpdate"})
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(request, timeout=120) as response:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def fetch_manifest(release_id):
    if not re.fullmatch(r"[1-9]\d*", release_id):
        raise ValueError("Release ID must be a positive integer")
    release = github_json(f"releases/{release_id}")
    if release["draft"] or not release["prerelease"] or not release["published_at"]:
        raise ValueError("The requested release must be a published prerelease")
    tag_name = release["tag_name"]
    if not tag_name.startswith("v") or not NIGHTLY_PATTERN.fullmatch(tag_name[1:]):
        raise ValueError("The requested release is not a nightly")
    version = tag_name[1:]

    ref = github_json("git/ref/tags/" + urllib.parse.quote(tag_name, safe=""))
    if ref["object"]["type"] != "tag":
        raise ValueError("Nightly source must have an annotated build-attempt tag")
    tag = github_json("git/tags/" + ref["object"]["sha"])
    metadata = json.loads(tag["message"])
    commit = tag["object"]["sha"]
    if (
        tag["object"]["type"] != "commit"
        or metadata.get("kind") != "diffscope-nightly-build"
        or metadata.get("source_sha") != commit
        or metadata.get("semver") != version
        or not re.fullmatch(r"[0-9a-f]{40}", commit)
    ):
        raise ValueError("The nightly tag does not match its build metadata")

    # Read the application name from the exact source commit, rather than the release title.
    contents = github_json("contents/CMakeLists.txt?ref=" + commit)
    if contents.get("encoding") != "base64":
        raise ValueError("Unexpected CMakeLists.txt encoding")
    cmake = base64.b64decode(contents["content"]).decode("utf-8")
    project = re.search(r"project\s*\(\s*(\w+)\s+VERSION\s+(\d+\.\d+\.\d+)", cmake)
    if not project or not version.startswith(project.group(2) + "-nightly."):
        raise ValueError("The nightly version differs from the source project version")
    expected = expected_artifacts(project.group(1) + "_nightly", version)

    assets = []
    page = 1
    while True:
        batch = github_json(f"releases/{release_id}/assets?per_page=100&page={page}")
        assets.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    names = [asset["name"] for asset in assets]
    if len(names) != len(expected) or set(names) != {entry[0] for entry in expected}:
        raise ValueError("The release must contain exactly the five expected binary artifacts")
    by_name = {asset["name"]: asset for asset in assets}

    artifacts = []
    for name, platform, arch, package_format, variant in expected:
        asset = by_name[name]
        url = (
            f"https://github.com/{SOURCE_REPOSITORY}/releases/download/"
            + urllib.parse.quote(tag_name, safe="")
            + "/"
            + urllib.parse.quote(name, safe="")
        )
        if asset["state"] != "uploaded" or asset["browser_download_url"] != url:
            raise ValueError(f"Invalid published asset: {name}")
        size, digest = download_digest(url)
        if size == 0 or size != asset["size"]:
            raise ValueError(f"Downloaded asset size differs from release metadata: {name}")
        if asset.get("digest") and asset["digest"].lower() != "sha256:" + digest:
            raise ValueError(f"Downloaded asset checksum differs from release metadata: {name}")
        artifacts.append({
            "platform": platform,
            "arch": arch,
            "format": package_format,
            "variant": variant,
            "url": url,
            "size": size,
            "sha256": digest,
        })

    manifest = {
        "$schema": "https://catalogs.diffscope.org/schema/v1/version.schema.json",
        "channel": "nightly",
        "version": version,
        "date": release["published_at"],
        "source": {"commit": commit, "tag": tag_name},
        "releaseNotes": release["html_url"],
        "artifacts": artifacts,
    }
    validators()["version"].validate(manifest)
    return manifest


def version_key(version):
    match = NIGHTLY_PATTERN.fullmatch(version)
    if not match:
        raise ValueError(f"Invalid nightly version in the catalog: {version}")
    return match.group(2), int(match.group(3)), tuple(map(int, match.group(1).split(".")))


def merge_manifest(manifest_path):
    manifest = read_json(manifest_path)
    checks = validators()
    checks["version"].validate(manifest)
    if manifest["channel"] != "nightly":
        raise ValueError("Only the nightly channel can be updated")
    version = manifest["version"]
    version_key(version)
    destination = CATALOG_ROOT / "nightly" / f"{version}.json"
    if destination.exists() and read_json(destination) != manifest:
        raise ValueError(f"The existing manifest for {version} differs from this release")

    index_path = CATALOG_ROOT / "nightly.json"
    index = read_json(index_path)
    checks["nightly"].validate(index)
    checks["index"].validate(read_json(CATALOG_ROOT / "index.json"))
    versions = [entry for entry in index["nightly"]["versions"] if entry["version"] != version]
    versions.append({"version": version, "manifest": f"nightly/{version}.json"})
    versions.sort(key=lambda entry: version_key(entry["version"]), reverse=True)
    index["nightly"]["versions"] = versions
    checks["nightly"].validate(index)

    if not destination.exists():
        write_json(destination, manifest)
    if read_json(index_path) != index:
        write_json(index_path, index)
    print(f"Prepared catalog entry for {version}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    fetch = subcommands.add_parser("fetch")
    fetch.add_argument("--release-id", required=True)
    fetch.add_argument("--output", required=True, type=Path)
    merge = subcommands.add_parser("merge")
    merge.add_argument("--manifest", required=True, type=Path)
    arguments = parser.parse_args()
    if arguments.command == "fetch":
        manifest = fetch_manifest(arguments.release_id)
        write_json(arguments.output, manifest)
        if output_path := os.environ.get("GITHUB_OUTPUT"):
            with open(output_path, "a", encoding="utf-8") as output:
                output.write(f"version={manifest['version']}\n")
        print(f"Verified published nightly {manifest['version']}")
    else:
        merge_manifest(arguments.manifest)


if __name__ == "__main__":
    main()

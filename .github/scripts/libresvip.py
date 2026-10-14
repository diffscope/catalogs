# SPDX-FileCopyrightText: Team OpenVPI
# SPDX-License-Identifier: Apache-2.0

"""Build a stable v1 manifest from a LibreSVIP CLI release."""

import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen


UPSTREAM = "https://api.github.com/repos/SoulMelody/LibreSVIP"
# CLI assets in upstream v2.9.2, checked on 2026-10-14. Keep catalog arch names
# consistent with the other v1 products, independently of upstream filenames.
PLATFORMS = (
    ("windows", "amd64", "win-amd64", "zip"),
    ("windows", "arm64", "win-arm64", "zip"),
    ("windows", "x86", "win-x86", "zip"),
    ("linux", "amd64", "linux-x86_64", "tar.gz"),
    ("linux", "arm64", "linux-aarch64", "tar.gz"),
    ("macos", "amd64", "macos-x86_64", "tar.gz"),
    ("macos", "arm64", "macos-arm64", "tar.gz"),
)


def github_json(path):
    headers = {"User-Agent": "SyncLibreSVIP", "Accept": "application/vnd.github+json"}
    if token := os.environ.get("GH_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    with urlopen(Request(UPSTREAM + path, headers=headers), timeout=60) as response:
        return json.load(response)


def asset_sha256(asset):
    digest = asset.get("digest") or ""
    if re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
        return digest.removeprefix("sha256:").lower()
    # Older releases may not have a GitHub-provided digest.
    checksum = hashlib.sha256()
    size = 0
    request = Request(asset["browser_download_url"], headers={"User-Agent": "SyncLibreSVIP"})
    with urlopen(request, timeout=60) as response:
        while chunk := response.read(1024 * 1024):
            checksum.update(chunk)
            size += len(chunk)
    if size != asset["size"]:
        raise ValueError(f"Downloaded size differs for {asset['name']}")
    return checksum.hexdigest()


def build_manifest(version):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("Expected a stable release version")
    tag = f"v{version}"
    release = github_json(f"/releases/tags/{tag}")
    if release["tag_name"] != tag or release["draft"] or release["prerelease"]:
        raise ValueError(f"{tag} is not a published stable release")
    assets = {asset["name"]: asset for asset in release["assets"]}
    artifacts = []
    for platform, arch, suffix, archive_format in PLATFORMS:
        name = f"LibreSVIP-CLI-{version}.{suffix}.{archive_format}"
        if name not in assets:
            raise ValueError(f"Missing CLI release asset: {name}")
        asset = assets[name]
        artifacts.append({
            "platform": platform,
            "arch": arch,
            "format": archive_format,
            "variant": "portable",
            "url": asset["browser_download_url"],
            "size": asset["size"],
            "sha256": asset_sha256(asset),
        })
    commit = github_json(f"/commits/{tag}")["sha"]
    return {
        "$schema": "https://catalogs.diffscope.org/schema/v1/version.schema.json",
        "channel": "stable",
        "version": version,
        "date": release["published_at"],
        "source": {"commit": commit, "tag": tag},
        "releaseNotes": release["html_url"],
        "artifacts": artifacts,
    }


def main():
    manifest = json.dumps(build_manifest(sys.argv[1]), ensure_ascii=False, separators=(",", ":"))
    if output := os.environ.get("GITHUB_OUTPUT"):
        with Path(output).open("a", encoding="utf-8") as stream:
            stream.write(f"manifest={manifest}\n")
    else:
        print(manifest)


if __name__ == "__main__":
    main()

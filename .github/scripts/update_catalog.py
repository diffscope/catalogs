# SPDX-FileCopyrightText: Team OpenVPI
# SPDX-License-Identifier: Apache-2.0

"""Validate and merge a supplied product release manifest into the catalog."""

import json
import os
from pathlib import Path
import re

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


SEMVER_PATTERN = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
)
NIGHTLY_PATTERN = re.compile(r"nightly\.([0-9]{8})\.([1-9][0-9]*)")


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


def version_key(version, channel):
    match = SEMVER_PATTERN.fullmatch(version)
    if not match:
        raise ValueError(f"Invalid semantic version in the catalog: {version}")
    base = tuple(map(int, match.group(1, 2, 3)))
    prerelease = match.group(4)
    identifiers = []
    if prerelease is not None:
        for identifier in prerelease.split("."):
            if identifier.isascii() and identifier.isdigit():
                if len(identifier) > 1 and identifier.startswith("0"):
                    raise ValueError(f"Invalid numeric prerelease identifier: {version}")
                identifiers.append((0, int(identifier)))
            else:
                identifiers.append((1, identifier))
    if channel == "nightly":
        nightly = NIGHTLY_PATTERN.fullmatch(prerelease or "")
        if not nightly:
            raise ValueError(f"Invalid nightly version in the catalog: {version}")
        return nightly.group(1), int(nightly.group(2)), base, version
    return base, (1 if prerelease is None else 0, tuple(identifiers)), version


def merge_manifest(product, channel, manifest):
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", product):
        raise ValueError("Invalid catalog product")
    if channel not in ("stable", "beta", "nightly"):
        raise ValueError("Invalid catalog channel")
    checks = validators()
    checks["version"].validate(manifest)
    if manifest["channel"] != channel:
        raise ValueError("The manifest channel differs from the requested channel")
    version = manifest["version"]
    version_key(version, channel)
    identities = [
        (artifact["platform"], artifact["arch"], artifact["format"], artifact.get("variant", ""))
        for artifact in manifest["artifacts"]
    ]
    if len(identities) != len(set(identities)):
        raise ValueError("The manifest contains duplicate artifact variants")

    catalog_root = Path("v1") / product
    index = read_json(catalog_root / "index.json")
    checks["index"].validate(index)
    schema_name = "nightly" if channel == "nightly" else "index"
    index_path = catalog_root / f"{schema_name}.json"
    if channel == "nightly":
        index = read_json(index_path)
        checks["nightly"].validate(index)

    destination = catalog_root / channel / f"{version}.json"
    if destination.exists() and read_json(destination) != manifest:
        raise ValueError(f"The existing manifest for {product}/{channel}/{version} differs from the supplied manifest")
    versions = [entry for entry in index[channel]["versions"] if entry["version"] != version]
    versions.append({"version": version, "manifest": f"{channel}/{version}.json"})
    versions.sort(key=lambda entry: version_key(entry["version"], channel), reverse=True)
    index[channel]["versions"] = versions
    checks[schema_name].validate(index)

    if not destination.exists():
        write_json(destination, manifest)
    if read_json(index_path) != index:
        write_json(index_path, index)
    print(f"Prepared catalog entry for {product}/{channel}/{version}")


def main():
    merge_manifest(
        os.environ["CATALOG_PRODUCT"],
        os.environ["CATALOG_CHANNEL"],
        json.loads(os.environ["CATALOG_MANIFEST"]),
    )


if __name__ == "__main__":
    main()

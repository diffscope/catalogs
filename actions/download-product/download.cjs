// SPDX-FileCopyrightText: Team OpenVPI
// SPDX-License-Identifier: Apache-2.0

const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function httpUrl(value, base) {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Catalogs and artifacts must use HTTP(S) URLs without embedded credentials');
    }
    return url;
}

function booleanInput(value, fallback, name) {
    if (value === undefined || value === '') return fallback;
    if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
    return value === 'true';
}

function platformName(value) {
    const name = value.toLowerCase();
    return { win32: 'windows', darwin: 'macos', osx: 'macos' }[name] || name;
}

function archName(value) {
    const name = value.toLowerCase();
    return { x64: 'amd64', x86_64: 'amd64', aarch64: 'arm64', ia32: 'x86' }[name] || name;
}

async function readJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Catalog request failed: HTTP ${response.status} (${url})`);
    }
    try {
        return await response.json();
    } catch (error) {
        throw new Error(`Could not read catalog JSON (${url}): ${error.message}`);
    }
}

function validateManifest(manifest, channel, version) {
    if (!manifest || manifest.channel !== channel || manifest.version !== version ||
        !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) {
        throw new Error('Invalid release manifest or release does not match the selected channel/version');
    }
    for (const artifact of manifest.artifacts) {
        if (!artifact || !['platform', 'arch', 'format', 'url'].every(key =>
            typeof artifact[key] === 'string' && artifact[key].length > 0) ||
            (artifact.variant !== undefined && typeof artifact.variant !== 'string') ||
            !Number.isSafeInteger(artifact.size) || artifact.size < 0 ||
            typeof artifact.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(artifact.sha256)) {
            throw new Error('Invalid artifact metadata in release manifest');
        }
        httpUrl(artifact.url);
    }
}

function fileName(artifact) {
    const name = decodeURIComponent(new URL(artifact.url).pathname.split('/').pop());
    // Apply Windows filename rules on every platform so a catalog selects the same name everywhere.
    if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
        /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
        throw new Error('Artifact URL must end in a safe filename');
    }
    return name;
}

async function resolve({ core, env = process.env }) {
    const product = (env.CATALOG_PRODUCT || '').trim();
    const channel = (env.CATALOG_CHANNEL || 'stable').trim();
    const requestedVersion = (env.CATALOG_VERSION || 'latest').trim();
    const platform = platformName((env.CATALOG_PLATFORM || env.RUNNER_OS || process.platform).trim());
    const arch = archName((env.CATALOG_ARCH || env.RUNNER_ARCH || process.arch).trim());
    const requestedVariant = (env.CATALOG_VARIANT || '').trim();
    const failOnNoMatch = booleanInput(env.CATALOG_FAIL_ON_NO_MATCH, false, 'fail-on-no-match');
    const cache = booleanInput(env.CATALOG_CACHE, true, 'cache');
    const prefix = env.CATALOG_CACHE_KEY_PREFIX || 'catalog-download-v1';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product)) throw new Error('Invalid catalog product');
    if (!['stable', 'beta', 'nightly'].includes(channel)) throw new Error('Invalid catalog channel');
    if (cache && (prefix.length > 400 || /[,\r\n]/.test(prefix))) throw new Error('Invalid cache-key-prefix');
    const source = httpUrl(env.CATALOG_SOURCE || 'https://catalogs.diffscope.org/v1');
    if (source.search || source.hash) throw new Error('Catalog source must not include a query or fragment');
    if (!source.pathname.endsWith('/')) source.pathname += '/';

    const outputs = {
        matched: 'false', version: '', platform, arch, variant: requestedVariant, format: '',
        url: '', size: '', sha256: '', artifact: '', manifest: '', 'manifest-url': '', 'cache-key': ''
    };
    const emit = () => {
        for (const [key, value] of Object.entries(outputs)) core.setOutput(key, value);
    };
    const noMatch = message => {
        emit();
        if (failOnNoMatch) throw new Error(message);
        core.info(message);
        return null;
    };

    const indexUrl = new URL(`${product}/${channel === 'nightly' ? 'nightly' : 'index'}.json`, source);
    const index = await readJson(indexUrl);
    const versions = index?.[channel]?.versions;
    if (!Array.isArray(versions) || versions.some(entry => !entry ||
        typeof entry.version !== 'string' || !entry.version ||
        typeof entry.manifest !== 'string' || !entry.manifest)) {
        throw new Error(`Invalid ${channel} version index (${indexUrl})`);
    }
    const entry = requestedVersion === 'latest' ? versions[0] : versions.find(item => item.version === requestedVersion);
    if (!entry) return noMatch(`No version matched ${product}/${channel}/${requestedVersion}`);

    const manifestUrl = httpUrl(entry.manifest, indexUrl);
    const manifest = await readJson(manifestUrl);
    validateManifest(manifest, channel, entry.version);
    outputs.version = manifest.version;
    outputs.manifest = JSON.stringify(manifest);
    outputs['manifest-url'] = manifestUrl.href;
    const candidates = manifest.artifacts.filter(item => item.platform === platform && item.arch === arch);
    const variant = requestedVariant || candidates[0]?.variant || '';
    outputs.variant = variant;
    const artifact = candidates.find(item => (item.variant || '') === variant);
    if (!artifact) {
        return noMatch(`No artifact matched ${product}/${channel}/${manifest.version} (${platform}/${arch}, variant=${variant})`);
    }

    const filename = fileName(artifact);
    const workspace = env.GITHUB_WORKSPACE || process.cwd();
    const destination = path.resolve(workspace, env.CATALOG_DIRECTORY || '.', filename);
    const identity = JSON.stringify([source.href, product, channel, manifest.version, artifact]);
    const digest = createHash('sha256').update(identity).digest('hex');
    // A stable path is essential: actions/cache includes the path in its cache version.
    const cacheDirectory = path.join(env.RUNNER_TEMP || os.tmpdir(), 'catalog-download', digest);
    const cacheKey = cache ? `${prefix}-${digest}` : '';
    Object.assign(outputs, {
        matched: 'true', format: artifact.format, url: artifact.url, size: String(artifact.size),
        sha256: artifact.sha256.toLowerCase(), artifact: JSON.stringify(artifact),
        'cache-key': cacheKey, 'cache-directory': cacheDirectory
    });
    emit();
    core.info(`Matched ${product} ${manifest.version}: ${platform}/${arch}, variant=${variant}, format=${artifact.format}`);
    return { artifact, destination, cache, cacheDirectory };
}

async function verify(file, artifact) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== artifact.size) throw new Error('Artifact size mismatch');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== artifact.sha256.toLowerCase()) throw new Error('Artifact SHA-256 mismatch');
}

async function fetchArtifact(file, artifact) {
    const temporary = `${file}.${randomUUID()}.partial`;
    try {
        const response = await fetch(artifact.url, { signal: AbortSignal.timeout(30 * 60_000) });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Artifact download failed: HTTP ${response.status} (${artifact.url})`);
        }
        if (!response.body) throw new Error('Artifact download returned no body');
        let size = 0;
        const hash = createHash('sha256');
        const check = new Transform({
            transform(chunk, encoding, callback) {
                size += chunk.length;
                if (size > artifact.size) return callback(new Error('Artifact size mismatch'));
                hash.update(chunk);
                callback(null, chunk);
            }
        });
        await pipeline(Readable.fromWeb(response.body), check, createWriteStream(temporary, { flags: 'wx' }));
        if (size !== artifact.size) throw new Error('Artifact size mismatch');
        if (hash.digest('hex') !== artifact.sha256.toLowerCase()) throw new Error('Artifact SHA-256 mismatch');
        await fs.rename(temporary, file);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

async function download({ core, env = process.env }) {
    const { artifact, destination, cache, cacheDirectory } = JSON.parse(env.CATALOG_SELECTION);
    core.setOutput('path', '');
    core.setOutput('cache-hit', 'false');
    const cachedFile = path.join(cacheDirectory, 'artifact');
    let cacheHit = false;
    if (cache) {
        try {
            await verify(cachedFile, artifact);
            cacheHit = true;
        } catch (error) {
            if (error.code !== 'ENOENT') core.warning(`Ignoring invalid artifact cache: ${error.message}`);
        }
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (cacheHit) {
        core.info('Using verified artifact cache');
    } else if (cache) {
        await fs.mkdir(cacheDirectory, { recursive: true });
        core.info(`Downloading ${artifact.url}`);
        await fetchArtifact(cachedFile, artifact);
    } else {
        core.info(`Downloading ${artifact.url}`);
        await fetchArtifact(destination, artifact);
    }
    if (cache) {
        const temporary = `${destination}.${randomUUID()}.partial`;
        try {
            await fs.copyFile(cachedFile, temporary);
            await fs.rename(temporary, destination);
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }
    core.setOutput('path', destination);
    core.setOutput('cache-hit', String(cacheHit));
    core.info(`Downloaded artifact: ${destination}`);
}

module.exports = { resolve, download };

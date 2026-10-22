// SPDX-FileCopyrightText: Team OpenVPI
// SPDX-License-Identifier: Apache-2.0

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const nightlyPattern = /^v(\d+\.\d+\.\d+-nightly\.(\d{8})\.([1-9]\d*))$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function workspacePath(filename) {
    const root = fs.realpathSync(process.env.GITHUB_WORKSPACE);
    const resolved = path.resolve(root, filename);
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('The path must identify a file or directory inside github.workspace');
    }
    let existing = resolved;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const actual = path.relative(root, fs.realpathSync(existing));
    if (actual === '..' || actual.startsWith('..' + path.sep) || path.isAbsolute(actual) ||
        (existing === resolved && !actual)) {
        throw new Error('The path must resolve inside github.workspace');
    }
    return resolved;
}

function configuration() {
    const config = JSON.parse(fs.readFileSync(workspacePath(process.env.NIGHTLY_CONFIG), 'utf8'));
    if (!config || !/^[\w.-]+\/[\w.-]+$/.test(config.repository || '') ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.attemptKind || '') ||
        !['cmake', 'text'].includes(config.versionFormat) ||
        typeof config.versionFile !== 'string' || !config.versionFile ||
        (config.versionFormat === 'text' && !/^[A-Za-z0-9_]+$/.test(config.applicationName || ''))) {
        throw new Error('Invalid nightly repository or version configuration');
    }
    if (!Array.isArray(config.artifacts) || !config.artifacts.length) {
        throw new Error('The nightly configuration must declare release artifacts');
    }
    const names = new Set();
    const identities = new Set();
    for (const artifact of config.artifacts) {
        if (!artifact || !/^_[A-Za-z0-9_.-]+$/.test(artifact.suffix || '') ||
            ['platform', 'arch', 'format'].some(key => typeof artifact[key] !== 'string' || !artifact[key]) ||
            typeof artifact.variant !== 'string') {
            throw new Error('Invalid nightly artifact configuration');
        }
        const identity = JSON.stringify([artifact.platform, artifact.arch, artifact.format, artifact.variant]);
        if (names.has(artifact.suffix) || identities.has(identity)) {
            throw new Error('The nightly configuration contains duplicate artifacts');
        }
        names.add(artifact.suffix);
        identities.add(identity);
    }
    return config;
}

function projectVersion(config) {
    const source = fs.readFileSync(workspacePath(config.versionFile), 'utf8');
    if (config.versionFormat === 'cmake') {
        const match = source.match(/project\s*\(\s*(\w+)\s+VERSION\s+(\d+\.\d+\.\d+)/);
        if (!match || !versionPattern.test(match[2])) {
            throw new Error('The CMake project must specify an application name and an a.b.c version');
        }
        return { name: match[1], version: match[2] };
    }
    const version = source.trim();
    if (!versionPattern.test(version)) throw new Error('The version file must contain an a.b.c version');
    return { name: config.applicationName, version };
}

function requireNightlySource(config, context) {
    if (context.ref !== 'refs/heads/main' || process.env.NIGHTLY_SOURCE_SHA !== context.sha ||
        context.repo.owner + '/' + context.repo.repo !== config.repository) {
        throw new Error('Nightly operations require the triggering main commit in the configured repository');
    }
}

async function nightlyRefs(github, repo) {
    const { data } = await github.rest.git.listMatchingRefs({ ...repo, ref: 'tags/v' });
    return data.map(ref => {
        const name = ref.ref.slice('refs/tags/'.length);
        const match = name.match(nightlyPattern);
        if (!match) return null;
        const sequence = Number(match[3]);
        if (!Number.isSafeInteger(sequence)) throw new Error('Invalid nightly sequence in tag ' + name);
        return { ref, name, semver: match[1], date: match[2], sequence };
    }).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date) || b.sequence - a.sequence);
}

async function readAttempt(github, repo, entry, config) {
    if (entry.ref.object.type !== 'tag') return null;
    const { data: tag } = await github.rest.git.getTag({ ...repo, tag_sha: entry.ref.object.sha });
    let metadata;
    try {
        metadata = JSON.parse(tag.message);
    } catch {
        return null;
    }
    if (metadata?.kind !== config.attemptKind) return null;
    if (tag.object.type !== 'commit' || metadata.source_sha !== tag.object.sha ||
        metadata.semver !== entry.semver || metadata.utc_date !== entry.date ||
        metadata.sequence !== entry.sequence || !/^[1-9]\d*$/.test(String(metadata.run_id))) {
        throw new Error('Invalid build attempt metadata in tag ' + entry.name);
    }
    return { ...metadata, tag: entry.name };
}

async function findAttempt(github, repo, refs, config, runId) {
    for (const entry of refs) {
        const attempt = await readAttempt(github, repo, entry, config);
        if (attempt && (runId === undefined || String(attempt.run_id) === String(runId))) {
            return attempt;
        }
    }
    return null;
}

async function check({ github, context, core, config }) {
    requireNightlySource(config, context);
    core.setOutput('should_build', 'false');
    const refs = await nightlyRefs(github, context.repo);
    const current = Number(process.env.GITHUB_RUN_ATTEMPT) > 1
        ? await findAttempt(github, context.repo, refs, config, context.runId) : null;
    if (current && current.source_sha !== context.sha) {
        throw new Error('The existing build attempt belongs to a different source commit');
    }
    if (!current) {
        const previous = await findAttempt(github, context.repo, refs, config);
        if (previous) {
            if (previous.source_sha === context.sha) {
                core.notice('Skipping nightly: this commit was already attempted in ' + previous.tag);
                return;
            }
            const { data: comparison } = await github.rest.repos.compareCommits({
                ...context.repo, base: previous.source_sha, head: context.sha
            });
            if (comparison.ahead_by === 0) {
                core.notice('Skipping nightly: no new commits since ' + previous.tag);
                return;
            }
        }
    }

    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
        ...context.repo, workflow_id: 'dev-build.yml', head_sha: context.sha, per_page: 100
    });
    const matching = runs.filter(run => run.head_sha === context.sha &&
        (run.event === 'push' || run.event === 'workflow_dispatch'));
    matching.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
    if (matching.length) {
        const { data: latest } = await github.rest.actions.getWorkflowRun({
            ...context.repo, run_id: matching[0].id
        });
        if (latest.conclusion === 'failure') {
            core.notice('Skipping nightly: latest Dev Build is ' + latest.status + '/' +
                latest.conclusion + ' (' + latest.html_url + ')');
            return;
        }
    }
    core.setOutput('should_build', 'true');
    core.notice(current ? 'Resuming ' + current.tag : 'New commits are eligible for a nightly build');
}

async function prepare({ github, context, core, config }) {
    const sourceSha = process.env.NIGHTLY_SOURCE_SHA;
    const buildType = process.env.NIGHTLY_BUILD_TYPE;
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('A full source commit SHA is required');
    if (!['dev', 'nightly'].includes(buildType)) throw new Error('Unsupported shared build type');
    const project = projectVersion(config);
    let identifier = process.env.NIGHTLY_VERSION_IDENTIFIER || '';
    let semver;
    let tag = '';
    if (buildType === 'nightly') {
        requireNightlySource(config, context);
        const refs = await nightlyRefs(github, context.repo);
        const current = Number(process.env.GITHUB_RUN_ATTEMPT) > 1
            ? await findAttempt(github, context.repo, refs, config, context.runId) : null;
        if (current) {
            if (current.source_sha !== sourceSha || !current.semver.startsWith(project.version + '-nightly.')) {
                throw new Error('The reserved nightly version does not match this source');
            }
            if (identifier && identifier !== current.utc_date + '.' + current.sequence) {
                throw new Error('The requested identifier differs from the reserved nightly version');
            }
            identifier = current.utc_date + '.' + current.sequence;
            semver = current.semver;
            tag = current.tag;
        } else {
            const startedAt = new Date().toISOString();
            const utcDate = startedAt.slice(0, 10).replaceAll('-', '');
            const nextSequence = Math.max(0, ...refs.filter(entry => entry.date === utcDate).map(entry => entry.sequence)) + 1;
            if (!Number.isSafeInteger(nextSequence)) throw new Error('The nightly sequence exceeds the safe integer range');
            let sequence = nextSequence;
            if (identifier) {
                const requested = identifier.match(/^(\d{8})\.([1-9]\d*)$/);
                if (!requested || requested[1] !== utcDate ||
                    !Number.isSafeInteger(Number(requested[2])) || Number(requested[2]) < nextSequence) {
                    throw new Error('A nightly identifier must use the current UTC date and an unused increasing sequence');
                }
                sequence = Number(requested[2]);
            }
            identifier = utcDate + '.' + sequence;
            semver = project.version + '-nightly.' + identifier;
            tag = 'v' + semver;
            const metadata = {
                kind: config.attemptKind, run_id: context.runId, source_sha: sourceSha,
                semver, utc_date: utcDate, sequence, started_at: startedAt
            };
            const { data: annotatedTag } = await github.rest.git.createTag({
                ...context.repo, tag, message: JSON.stringify(metadata), object: sourceSha, type: 'commit',
                tagger: {
                    name: 'github-actions[bot]',
                    email: '41898282+github-actions[bot]@users.noreply.github.com',
                    date: startedAt
                }
            });
            await github.rest.git.createRef({ ...context.repo, ref: 'refs/tags/' + tag, sha: annotatedTag.sha });
        }
    } else {
        identifier ||= sourceSha;
        if (!/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(identifier)) {
            throw new Error('Invalid dev version identifier');
        }
        semver = project.version + '+' + identifier;
    }
    core.setOutput('semver', semver);
    core.setOutput('tag', tag);
    core.setOutput('application_name', project.name + '_' + buildType);
    core.setOutput('version_identifier', identifier);
    core.setOutput('version_suffix', semver.slice(project.version.length));
    await core.summary.addHeading('Build version').addTable([
        ['Version', semver], ['Source commit', sourceSha], ['Tag', tag || '(none)']
    ]).write();
}

function expectedAssets(config, applicationName, semver) {
    const base = applicationName + '_' + semver.replace(/[.\-+]/g, '_');
    return config.artifacts.map(({ suffix, platform, arch, format, variant }) => ({
        name: base + suffix, platform, arch, format, variant
    }));
}

async function fileDigest(filename) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}

async function assetDigest(asset) {
    if (/^sha256:[0-9a-f]{64}$/i.test(asset.digest || '')) {
        return asset.digest.slice('sha256:'.length).toLowerCase();
    }
    const response = await fetch(asset.url, {
        headers: {
            Accept: 'application/octet-stream',
            Authorization: 'Bearer ' + process.env.GH_TOKEN,
            'X-GitHub-Api-Version': '2026-03-10'
        }
    });
    if (!response.ok) throw new Error('Could not download existing release asset ' + asset.name);
    const hash = crypto.createHash('sha256');
    for await (const chunk of response.body) hash.update(chunk);
    return hash.digest('hex');
}

function publicationInputs(config, context) {
    requireNightlySource(config, context);
    const tag = process.env.NIGHTLY_TAG;
    const match = (tag || '').match(nightlyPattern);
    if (!match) throw new Error('Invalid nightly tag');
    const semver = match[1];
    const project = projectVersion(config);
    const applicationName = process.env.NIGHTLY_APPLICATION_NAME;
    if (applicationName !== project.name + '_nightly' || !semver.startsWith(project.version + '-nightly.')) {
        throw new Error('The release version and application name must match the source project');
    }
    const directory = workspacePath(process.env.NIGHTLY_DIRECTORY);
    const expected = expectedAssets(config, applicationName, semver);
    return { tag, match, semver, directory, expected };
}

async function publish({ github, context, core, config, exec }) {
    const { tag, match, semver, directory, expected } = publicationInputs(config, context);
    const names = expected.map(asset => asset.name);
    const { data: ref } = await github.rest.git.getRef({ ...context.repo, ref: 'tags/' + tag });
    const attempt = await readAttempt(github, context.repo, {
        ref, name: tag, semver, date: match[2], sequence: Number(match[3])
    }, config);
    if (!attempt || attempt.source_sha !== process.env.NIGHTLY_SOURCE_SHA || String(attempt.run_id) !== String(context.runId)) {
        throw new Error('The release tag does not belong to this build attempt');
    }
    const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
    const matching = releases.filter(item => item.tag_name === tag);
    if (matching.length > 1) throw new Error('Multiple releases use the nightly tag ' + tag);
    let release = matching[0];
    if (!release) {
        const previous = releases.filter(item => !item.draft && item.prerelease &&
            nightlyPattern.test(item.tag_name) && item.tag_name !== tag)
            .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
        const { data: notes } = await github.rest.repos.generateReleaseNotes({
            ...context.repo, tag_name: tag,
            ...(previous ? { previous_tag_name: previous.tag_name } : {})
        });
        // The verified tag fixes the release source. An explicit target commit can require workflow write permission.
        ({ data: release } = await github.rest.repos.createRelease({
            ...context.repo, tag_name: tag,
            name: semver, body: notes.body, draft: true, prerelease: true, make_latest: 'false'
        }));
    }
    if (!release.prerelease) throw new Error('The existing release is not a prerelease');

    let assets = await github.paginate(github.rest.repos.listReleaseAssets, {
        ...context.repo, release_id: release.id, per_page: 100
    });
    if (assets.some(asset => !names.includes(asset.name))) throw new Error('Unexpected files in the nightly release');
    if (release.draft) {
        for (const name of names) {
            const filename = path.join(directory, name);
            const stat = fs.statSync(filename);
            if (!stat.isFile() || stat.size === 0) throw new Error('Missing or empty build asset ' + name);
            const existing = assets.find(asset => asset.name === name);
            if (existing && existing.state === 'uploaded') {
                if (existing.size === stat.size && await assetDigest(existing) === await fileDigest(filename)) {
                    continue;
                }
            }
            if (existing) {
                await github.rest.repos.deleteReleaseAsset({ ...context.repo, asset_id: existing.id });
            }
            const uploadUrl = new URL(release.upload_url.replace(/\{[^}]*\}$/, ''));
            uploadUrl.searchParams.set('name', name);
            await exec.exec('gh', ['api', '--method', 'POST', uploadUrl.href,
                '--header', 'Content-Type: application/octet-stream', '--input', filename, '--silent']);
        }
        assets = await github.paginate(github.rest.repos.listReleaseAssets, {
            ...context.repo, release_id: release.id, per_page: 100
        });
    }
    if (assets.length !== names.length || names.some(name =>
        !assets.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0))) {
        throw new Error('Nightly release assets are incomplete');
    }
    if (release.draft) {
        ({ data: release } = await github.rest.repos.updateRelease({
            ...context.repo, release_id: release.id, draft: false, prerelease: true, make_latest: 'false'
        }));
        assets = await github.paginate(github.rest.repos.listReleaseAssets, {
            ...context.repo, release_id: release.id, per_page: 100
        });
    }
    if (!release.published_at) throw new Error('The nightly release has no publication timestamp');
    const artifacts = [];
    for (const { name, ...metadata } of expected) {
        const asset = assets.find(asset => asset.name === name);
        const url = 'https://github.com/' + context.repo.owner + '/' + context.repo.repo +
            '/releases/download/' + encodeURIComponent(tag) + '/' + encodeURIComponent(name);
        if (asset.browser_download_url !== url || !Number.isSafeInteger(asset.size)) {
            throw new Error('Invalid published asset metadata: ' + name);
        }
        artifacts.push({ ...metadata, url, size: asset.size, sha256: await assetDigest(asset) });
    }
    core.setOutput('catalog_manifest', JSON.stringify({
        $schema: 'https://catalogs.diffscope.org/schema/v1/version.schema.json',
        channel: 'nightly', version: semver, date: release.published_at,
        source: { commit: attempt.source_sha, tag }, releaseNotes: release.html_url, artifacts
    }));
    await core.summary.addLink('Published ' + semver, release.html_url).write();
}

async function run({ github, context, core, exec }) {
    const operations = { check, prepare, publish };
    const operation = process.env.NIGHTLY_OPERATION;
    if (!Object.hasOwn(operations, operation)) throw new Error('Unsupported nightly operation');
    await operations[operation]({ github, context, core, exec, config: configuration() });
}

function downloadOptions({ context, core }) {
    const { directory } = publicationInputs(configuration(), context);
    core.setOutput('directory', directory);
    core.setOutput('pattern', process.env.NIGHTLY_APPLICATION_NAME + '_*');
}

module.exports = { run, downloadOptions };

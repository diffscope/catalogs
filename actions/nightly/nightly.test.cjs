// SPDX-FileCopyrightText: Team OpenVPI
// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout } = require('node:timers/promises');
const test = require('node:test');

const { run } = require('./nightly.cjs');

function publication(t, options = {}) {
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const workspace = fs.mkdtempSync(path.join(temporaryRoot, 'catalog-nightly-test-'));
    const directory = path.join(workspace, 'assets');
    fs.mkdirSync(directory);
    const sourceSha = 'a'.repeat(40);
    const semver = '0.1.0-nightly.20261022.1';
    const tag = 'v' + semver;
    const context = { repo: { owner: 'diffscope', repo: 'example' }, ref: 'refs/heads/main', sha: sourceSha, runId: 123 };
    const artifacts = [
        { suffix: '_Linux_amd64_portable.tar.xz', platform: 'linux', arch: 'amd64', format: 'tar.xz', variant: 'portable' },
        { suffix: '_Windows_amd64_portable.zip', platform: 'windows', arch: 'amd64', format: 'zip', variant: 'portable' }
    ];
    fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify({
        repository: 'diffscope/example', attemptKind: 'example-nightly', versionFile: 'version.txt',
        versionFormat: 'text', applicationName: 'example', artifacts
    }));
    fs.writeFileSync(path.join(workspace, 'version.txt'), '0.1.0');
    const expected = artifacts.map((artifact, index) => {
        const name = 'example_nightly_0_1_0_nightly_20261022_1' + artifact.suffix;
        const contents = Buffer.from('artifact ' + index);
        fs.writeFileSync(path.join(directory, name), contents);
        return {
            id: index + 1, name, state: 'uploaded', size: contents.length,
            digest: 'sha256:' + crypto.createHash('sha256').update(contents).digest('hex'),
            browser_download_url: 'https://github.com/diffscope/example/releases/download/' + tag + '/' + name
        };
    });
    const environment = {
        GITHUB_WORKSPACE: workspace, NIGHTLY_OPERATION: 'publish', NIGHTLY_CONFIG: 'config.json',
        NIGHTLY_SOURCE_SHA: sourceSha, NIGHTLY_TAG: tag, NIGHTLY_APPLICATION_NAME: 'example_nightly',
        NIGHTLY_DIRECTORY: 'assets'
    };
    const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    t.after(() => {
        for (const [key, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        assert.equal(path.dirname(workspace), temporaryRoot);
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const events = [];
    const outputs = {};
    let uploadInProgress = false;
    let assets = expected.slice(0, options.existingAssets || 0).map(asset => ({ ...asset }));
    if (options.mismatchedAsset) assets[0].digest = 'sha256:' + '0'.repeat(64);
    const release = {
        id: 42, tag_name: tag, draft: !options.published, prerelease: true,
        published_at: options.published ? '2026-10-22T01:00:00Z' : null,
        html_url: 'https://github.com/diffscope/example/releases/tag/' + tag,
        upload_url: 'https://uploads.github.com/repos/diffscope/example/releases/42/assets{?name,label}'
    };
    const repos = {
        listReleases() {},
        listReleaseAssets() {},
        async generateReleaseNotes() { return { data: { body: 'Release notes' } }; },
        async createRelease() { events.push('create'); return { data: release }; },
        async deleteReleaseAsset({ asset_id }) {
            events.push('delete:' + asset_id);
            assets = assets.filter(asset => asset.id !== asset_id);
        },
        async updateRelease({ release_id }) {
            assert.equal(release_id, release.id);
            assert.equal(assets.length, expected.length);
            events.push('publish');
            release.draft = false;
            release.published_at = '2026-10-22T01:00:00Z';
            return { data: release };
        }
    };
    const github = {
        rest: {
            repos,
            git: {
                async getRef() { return { data: { object: { type: 'tag', sha: 'b'.repeat(40) } } }; },
                async getTag() {
                    return { data: { object: { type: 'commit', sha: sourceSha }, message: JSON.stringify({
                        kind: 'example-nightly', source_sha: sourceSha, semver, utc_date: '20261022', sequence: 1, run_id: 123
                    }) } };
                }
            }
        },
        async paginate(route, parameters) {
            if (route === repos.listReleases) {
                return options.duplicate ? [release, { ...release, id: 43 }] : options.existing ? [release] : [];
            }
            assert.equal(route, repos.listReleaseAssets);
            assert.equal(parameters.release_id, release.id);
            assert.equal(uploadInProgress, false);
            return assets.map(asset => ({ ...asset }));
        }
    };
    const exec = {
        async exec(command, args) {
            assert.equal(command, 'gh');
            assert.deepEqual(args.slice(0, 3), ['api', '--method', 'POST']);
            const url = new URL(args[3]);
            assert.equal(url.origin + url.pathname, 'https://uploads.github.com/repos/diffscope/example/releases/42/assets');
            const name = url.searchParams.get('name');
            assert.equal(args[args.indexOf('--input') + 1], path.join(directory, name));
            assert.equal(uploadInProgress, false);
            uploadInProgress = true;
            await setTimeout(5);
            if (options.uploadFailure) throw new Error('Upload failed');
            events.push('upload:' + name);
            assets.push({ ...expected.find(asset => asset.name === name) });
            uploadInProgress = false;
            return 0;
        }
    };
    const summary = { addLink() { return this; }, async write() {} };
    const core = { setOutput(name, value) { outputs[name] = value; }, summary };
    return { execute: () => run({ github, context, core, exec }), events, outputs, expected };
}

test('creates a draft and awaits each upload to the selected release before publication', async t => {
    const fixture = publication(t);
    await fixture.execute();
    assert.deepEqual(fixture.events, ['create', ...fixture.expected.map(asset => 'upload:' + asset.name), 'publish']);
    const manifest = JSON.parse(fixture.outputs.catalog_manifest);
    assert.equal(manifest.artifacts.length, 2);
    assert.deepEqual(manifest.artifacts.map(asset => asset.sha256), fixture.expected.map(asset => asset.digest.slice(7)));
});

test('resumes an existing draft and retains matching uploaded assets', async t => {
    const fixture = publication(t, { existing: true, existingAssets: 1 });
    await fixture.execute();
    assert.deepEqual(fixture.events, ['upload:' + fixture.expected[1].name, 'publish']);
});

test('replaces an existing asset if its digest differs', async t => {
    const fixture = publication(t, { existing: true, existingAssets: 2, mismatchedAsset: true });
    await fixture.execute();
    assert.deepEqual(fixture.events, ['delete:1', 'upload:' + fixture.expected[0].name, 'publish']);
});

test('reuses a complete published prerelease without uploading or publishing', async t => {
    const fixture = publication(t, { existing: true, existingAssets: 2, published: true });
    await fixture.execute();
    assert.deepEqual(fixture.events, []);
    assert.ok(fixture.outputs.catalog_manifest);
});

test('rejects duplicate releases before any publication writes', async t => {
    const fixture = publication(t, { duplicate: true });
    await assert.rejects(fixture.execute(), /Multiple releases use the nightly tag/);
    assert.deepEqual(fixture.events, []);
});

test('preserves the draft and omits the manifest if an asynchronous upload fails', async t => {
    const fixture = publication(t, { existing: true, uploadFailure: true });
    await assert.rejects(fixture.execute(), /Upload failed/);
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.outputs.catalog_manifest, undefined);
});

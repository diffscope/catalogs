// SPDX-FileCopyrightText: Team OpenVPI
// SPDX-License-Identifier: Apache-2.0

module.exports = async function dispatch({ github, core }) {
    const product = process.env.CATALOG_PRODUCT;
    const channel = process.env.CATALOG_CHANNEL;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product || '')) throw new Error('Invalid catalog product');
    if (!['stable', 'beta', 'nightly'].includes(channel)) throw new Error('Invalid catalog channel');
    const manifest = JSON.parse(process.env.CATALOG_MANIFEST);
    if (!manifest || manifest.channel !== channel || typeof manifest.version !== 'string' || !manifest.version) {
        throw new Error('The manifest must specify a version and match the requested channel');
    }
    const inputs = { product, channel, manifest: JSON.stringify(manifest) };
    if (Buffer.byteLength(JSON.stringify(inputs), 'utf8') > 65535) {
        throw new Error('The catalog update exceeds the workflow dispatch input limit');
    }
    const owner = 'diffscope';
    const repo = 'catalogs';
    const deadline = Date.now() + 30 * 60 * 1000;
    const { data } = await github.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
        owner, repo, workflow_id: 'update-catalog.yml', ref: 'main', inputs,
        headers: { 'X-GitHub-Api-Version': '2026-03-10' }
    });
    if (!data?.workflow_run_id) throw new Error('The dispatch API did not return a catalogs workflow run ID');
    core.notice('Catalogs update: ' + data.html_url);
    await core.summary.addLink('Catalogs update', data.html_url).write();
    while (Date.now() < deadline) {
        const { data: run } = await github.rest.actions.getWorkflowRun({
            owner, repo, run_id: data.workflow_run_id
        });
        if (run.status === 'completed') {
            if (run.conclusion !== 'success') {
                throw new Error('Catalogs update finished with ' + run.conclusion + ': ' + run.html_url);
            }
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 15000));
    }
    throw new Error('Timed out waiting 30 minutes for catalogs update: ' + data.html_url);
};

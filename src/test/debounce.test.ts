import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

/**
 * When `python.useEnvironmentsExtension` is enabled the python-envs extension
 * independently reacts to editor changes and may set intermediate environments
 * on the classic API — that behaviour is outside our debounce control.
 * We detect the flag so tests that inspect the classic API can adapt.
 */
function isUsingEnvsExtension(): boolean {
	const config = vscode.workspace.getConfiguration('python');
	return config.get<boolean>('useEnvironmentsExtension', false);
}

suite('Debounce rapid editor changes', function () {
	this.timeout(100000);

	let api: any;
	let envsApi: any;
	let fixturesFolder: string;
	let intermediateEnvSeen: boolean;
	let checkInterval: ReturnType<typeof setInterval>;
	let envRightAfter: any;
	let envDuringDebounce: any;
	let activeEnv: any;
	let usingEnvsExt: boolean;
	let switchElapsed = 0;

	suiteSetup(async () => {
		usingEnvsExt = isUsingEnvsExtension();

		const pythonExtension = vscode.extensions.getExtension('ms-python.python');
		if (!pythonExtension) {
			assert.fail('Python extension not found');
		}
		if (!pythonExtension.isActive) {
			await pythonExtension.activate();
		}

		const ext = vscode.extensions.getExtension('Weidav.uv-auto-venv');
		if (!ext) {
			assert.fail('uv-auto-venv extension not found');
		}
		if (!ext.isActive) {
			await ext.activate();
		}

		// Optionally acquire the python-envs API for verification
		if (usingEnvsExt) {
			const envsExt = vscode.extensions.getExtension('ms-python.vscode-python-envs');
			if (envsExt) {
				envsApi = envsExt.isActive ? envsExt.exports : await envsExt.activate();
			}
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			assert.fail('No workspace folder found. Ensure tests run with test-fixtures folder.');
		}

		fixturesFolder = workspaceFolders[0].uri.fsPath;
		api = pythonExtension.exports;

		const appDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fixturesFolder, 'example-app', 'main.py')));
		const bareDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fixturesFolder, 'example-bare', 'main.py')));
		const libDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fixturesFolder, 'example-lib', 'src', 'example_lib', '__init__.py')));

		// Wait a bit to ensure initial activation events have settled
		await new Promise(resolve => setTimeout(resolve, 1000));

		// Reset environment to empty for the workspace (classic API)
		await api.environments.updateActiveEnvironmentPath('', vscode.Uri.file(fixturesFolder));

		intermediateEnvSeen = false;
		checkInterval = setInterval(() => {
			const env = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));
			if (env && env.path && (env.path.includes('example-app') || env.path.includes('example-bare'))) {
				intermediateEnvSeen = true;
			}
		}, 10);

		// Rapidly switch tabs (well within the 300ms debounce)
		const switchStart = Date.now();
		await vscode.window.showTextDocument(appDoc, { preview: true, preserveFocus: false });
		await vscode.window.showTextDocument(bareDoc, { preview: true, preserveFocus: false });
		await vscode.window.showTextDocument(libDoc, { preview: true, preserveFocus: false });
		switchElapsed = Date.now() - switchStart;

		// Capture the environment immediately after the last switch
		envRightAfter = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));

		// Wait 100ms (still within the 300ms debounce window) and capture again
		await new Promise(resolve => setTimeout(resolve, 100));
		envDuringDebounce = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));

		// Now wait for the debouncer to fire and the process to finish.
		// When python-envs is active our extension writes via setEnvironment
		// (not the classic API), so we check both channels.
		const libUri = vscode.Uri.file(path.join(fixturesFolder, 'example-lib', 'src', 'example_lib', '__init__.py'));
		activeEnv = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));
		const timeout = Date.now() + 10000;
		while (Date.now() < timeout) {
			// Classic API check
			if (activeEnv && activeEnv.path && activeEnv.path.includes(path.join('example-lib', '.venv'))) {
				break;
			}
			// python-envs API check (environment set per-file)
			if (envsApi) {
				try {
					const envsEnv = await envsApi.getEnvironment(libUri);
					if (envsEnv && envsEnv.environmentPath &&
						envsEnv.environmentPath.fsPath.includes('example-lib/.venv')) {
						break;
					}
				} catch {
					// python-envs API not ready yet, keep polling
				}
			}
			await new Promise(resolve => setTimeout(resolve, 100));
			activeEnv = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));
		}

		clearInterval(checkInterval);
	});

	test('Should not set the final environment immediately after switching', () => {
		assert.ok(
			!envRightAfter?.path?.includes(path.join('example-lib', '.venv')),
			`Environment should not yet be set to example-lib immediately after switching, but got ${envRightAfter?.path}`
		);
	});

	test('Should not set the final environment within the debounce window', () => {
		assert.ok(
			!envDuringDebounce?.path?.includes(path.join('example-lib', '.venv')),
			`Environment should not yet be set to example-lib within debounce window (100 ms), but got ${envDuringDebounce?.path}`
		);
	});

	test('Should resolve to the last environment after the debounce fires', async () => {
		// When python-envs is active, verify via its API (per-file scope)
		if (envsApi) {
			const libUri = vscode.Uri.file(path.join(fixturesFolder, 'example-lib', 'src', 'example_lib', '__init__.py'));
			const envsEnv = await envsApi.getEnvironment(libUri);
			assert.ok(
				envsEnv && envsEnv.environmentPath &&
				envsEnv.environmentPath.fsPath.includes('example-lib/.venv'),
				`Expected python-envs environment to include 'example-lib/.venv', but got ${envsEnv?.environmentPath?.fsPath ?? 'undefined'}`
			);
			return;
		}
		// Classic API check
		assert.ok(
			activeEnv?.path?.includes(path.join('example-lib', '.venv')),
			`Expected path to include '${path.join('example-lib', '.venv')}', but got ${activeEnv?.path}`
		);
	});

	test('Should not activate intermediate environments during rapid switching', function () {
		if (usingEnvsExt) {
			// When python-envs is active it independently reacts to editor
			// changes and may set intermediate environments on the classic
			// API — that is outside our debounce control, so we skip this
			// assertion.
			this.skip();
		}
		if (switchElapsed >= 100) {
			console.log(`Skipping intermediate environment assertion because tab switching took too long (${switchElapsed}ms)`);
			this.skip();
		}
		assert.ok(
			!intermediateEnvSeen,
			'Intermediate environments (app, bare) should not be set due to debouncing'
		);
	});
});

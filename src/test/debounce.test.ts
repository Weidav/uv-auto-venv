import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

suite('Debounce rapid editor changes', function () {
	this.timeout(100000);

	let api: any;
	let fixturesFolder: string;
	let intermediateEnvSeen: boolean;
	let checkInterval: ReturnType<typeof setInterval>;
	let envRightAfter: any;
	let envDuringDebounce: any;
	let activeEnv: any;

	suiteSetup(async () => {
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

		// Reset environment to empty for the workspace
		await api.environments.updateActiveEnvironmentPath('', vscode.Uri.file(fixturesFolder));

		intermediateEnvSeen = false;
		checkInterval = setInterval(() => {
			const env = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));
			if (env && env.path && (env.path.includes('example-app') || env.path.includes('example-bare'))) {
				intermediateEnvSeen = true;
			}
		}, 10);

		// Rapidly switch tabs (well within the 300ms debounce)
		await vscode.window.showTextDocument(appDoc);
		await new Promise(resolve => setTimeout(resolve, 50));

		await vscode.window.showTextDocument(bareDoc);
		await new Promise(resolve => setTimeout(resolve, 50));

		await vscode.window.showTextDocument(libDoc);

		// Capture the environment immediately after the last switch
		envRightAfter = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));

		// Wait 100ms (still within the 300ms debounce window) and capture again
		await new Promise(resolve => setTimeout(resolve, 100));
		envDuringDebounce = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));

		// Now wait for the debouncer to fire and the process to finish
		activeEnv = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));
		const timeout = Date.now() + 10000;
		while (Date.now() < timeout) {
			if (activeEnv && activeEnv.path && activeEnv.path.includes('example-lib/.venv/bin')) {
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
			activeEnv = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));
		}

		clearInterval(checkInterval);
	});

	test('Should not set the final environment immediately after switching', () => {
		assert.ok(
			!envRightAfter?.path?.includes('example-lib/.venv/bin'),
			`Environment should not yet be set to example-lib immediately after switching, but got ${envRightAfter?.path}`
		);
	});

	test('Should not set the final environment within the debounce window', () => {
		assert.ok(
			!envDuringDebounce?.path?.includes('example-lib/.venv/bin'),
			`Environment should not yet be set to example-lib within debounce window (100 ms), but got ${envDuringDebounce?.path}`
		);
	});

	test('Should resolve to the last environment after the debounce fires', () => {
		assert.ok(
			activeEnv?.path?.includes('example-lib/.venv/bin'),
			`Expected path to include 'example-lib/.venv/bin', but got ${activeEnv?.path}`
		);
	});

	test('Should not activate intermediate environments during rapid switching', () => {
		assert.ok(
			!intermediateEnvSeen,
			'Intermediate environments (app, bare) should not be set due to debouncing'
		);
	});
});

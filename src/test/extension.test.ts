import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

suite('uv-auto-venv Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('Weidav.uv-auto-venv'));
	});

	const projects = [
		{ name: 'example-app', file: 'main.py', expectedPath: 'example-app' },
		{ name: 'example-bare', file: 'main.py', expectedPath: 'example-bare' },
		{ name: 'example-lib', file: 'src/example_lib/__init__.py', expectedPath: 'example-lib' },
		{ name: 'example-pkg', file: 'src/example_pkg/__init__.py', expectedPath: 'example-pkg' },
		{ name: 'example-script', file: 'main.py', expectedPath: 'uv' }
	];

	for (const project of projects) {
		test(`Should activate and switch to project environment for ${project.name}`, async () => {
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

			// Use the test-fixtures workspace
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				assert.fail('No workspace folder found. Ensure tests run with test-fixtures folder.');
			}
			
			const fixturesFolder = workspaceFolders[0].uri.fsPath;
			const appFilePath = path.join(fixturesFolder, project.name, project.file);

			
			// Open the file
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(appFilePath));
			await vscode.window.showTextDocument(document);

			// Wait for the extension to process the editor change
			await new Promise(resolve => setTimeout(resolve, 2000));

			const api = pythonExtension.exports;
			const activeEnv = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));
			
			// The environment should be set to the corresponding project venv or uv cache
			assert.ok(activeEnv.path.includes(project.expectedPath), `Expected path to include '${project.expectedPath}', but got ${activeEnv.path}`);
		}).timeout(10000);
	}
});

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';

suite('uv-auto-venv Extension Test Suite', function () {
	this.timeout(100000);
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('Weidav.uv-auto-venv'));
	});

	const projects = [
		{ name: 'example-app', file: 'main.py', expectedPath: path.join('example-app', '.venv') },
		{ name: 'example-bare', file: 'main.py', expectedPath: path.join('example-bare', '.venv') },
		{ name: 'example-lib', file: 'src/example_lib/__init__.py', expectedPath: path.join('example-lib', '.venv') },
		{ name: 'example-pkg', file: 'src/example_pkg/__init__.py', expectedPath: path.join('example-pkg', '.venv') },
		{ name: 'example-script', file: 'main.py', expectedPath: 'environments-v2' }
	];

	suiteSetup(() => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			assert.fail('No workspace folder found. Ensure tests run with test-fixtures folder.');
		}

		const fixturesFolder = workspaceFolders[0].uri.fsPath;
		for (const project of projects) {
			const projectPath = path.join(fixturesFolder, project.name);
			const pyprojectPath = path.join(projectPath, 'pyproject.toml');
			if (fs.existsSync(pyprojectPath)) {
				cp.execSync('uv sync --link-mode=copy', { cwd: projectPath });
			} else {
				cp.execSync(`uv sync --link-mode=copy --script ${project.file}`, { cwd: projectPath });
			}
		}
	});


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

			const api = pythonExtension.exports;
			let activeEnv = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));

			// Poll for the extension to process the editor change (up to 10 seconds)
			const timeout = Date.now() + 10000;
			while (Date.now() < timeout) {
				if (activeEnv && activeEnv.path && activeEnv.path.includes(project.expectedPath)) {
					break;
				}
				await new Promise(resolve => setTimeout(resolve, 100));
				activeEnv = api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder));
			}

			// The environment should be set to the corresponding project venv or uv cache
			const actualPath = activeEnv ? activeEnv.path : 'undefined';
			assert.ok(actualPath.includes(project.expectedPath), `Expected path to include '${project.expectedPath}', but got ${actualPath}`);
		});
	}
});

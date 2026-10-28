import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import type { PythonEnvironmentApi } from '@vscode/python-environments';

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

	let api: any;
	let envsApi: PythonEnvironmentApi | undefined;
	let fixturesFolder: string;

	suiteSetup(async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			assert.fail('No workspace folder found. Ensure tests run with test-fixtures folder.');
		}

		fixturesFolder = workspaceFolders[0].uri.fsPath;
		for (const project of projects) {
			const projectPath = path.join(fixturesFolder, project.name);
			const pyprojectPath = path.join(projectPath, 'pyproject.toml');
			if (fs.existsSync(pyprojectPath)) {
				cp.execFileSync('uv', ['sync', '--link-mode=copy'], { cwd: projectPath });
			} else {
				cp.execFileSync('uv', ['sync', '--link-mode=copy', '--script', project.file], { cwd: projectPath });
			}
		}

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

		api = pythonExtension.exports;
		if (vscode.workspace.getConfiguration('python').get('useEnvironmentsExtension')) {
			const envsExtension = vscode.extensions.getExtension<PythonEnvironmentApi>('ms-python.vscode-python-envs');
			assert.ok(envsExtension, 'Python Environments extension must be installed for the hybrid tests');
			envsApi = await envsExtension.activate();
		}
	});

	async function environmentPath(file: vscode.Uri): Promise<string> {
		if (envsApi) {
			return (await envsApi.getEnvironment(file))?.execInfo.run.executable ?? '';
		}
		return api.environments.getActiveEnvironmentPath(vscode.Uri.file(fixturesFolder))?.path ?? '';
	}

	test('Opening a script before its project preserves the shared workspace interpreter', async function () {
		if (!envsApi) {
			this.skip();
		}
		const projectPath = path.join(fixturesFolder, 'unopened-project');
		fs.mkdirSync(path.join(projectPath, 'scripts'), { recursive: true });
		fs.writeFileSync(path.join(projectPath, 'pyproject.toml'),
			'[project]\nname = "unopened-project"\nversion = "0.1.0"\n');
		const script = vscode.Uri.file(path.join(projectPath, 'scripts', 'main.py'));
		fs.writeFileSync(script.fsPath, '# /// script\n# dependencies = []\n# ///\n');
		cp.execFileSync('uv', ['sync', '--script', script.fsPath], { cwd: projectPath, stdio: 'pipe' });
		const python = cp.execFileSync('uv', ['python', 'find'], {
			cwd: path.join(fixturesFolder, 'example-app'), encoding: 'utf8',
		}).trim();
		const previous = await envsApi.resolveEnvironment(vscode.Uri.file(python));
		assert.ok(previous);
		const scope = vscode.Uri.file(fixturesFolder);
		await envsApi.setEnvironment(scope, previous);
		assert.strictEqual(envsApi.getPythonProject(script)?.uri.toString(), scope.toString());

		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(script));
		await vscode.commands.executeCommand('uv-auto-venv.reloadVenv');
		assert.deepStrictEqual((await envsApi.getEnvironment(scope))?.envId, previous.envId);
		assert.strictEqual(envsApi.getPythonProject(script)?.uri.toString(), scope.toString());
	});

	for (const project of projects) {
		test(`Should activate and switch to project environment for ${project.name}`, async () => {
			const appFilePath = path.join(fixturesFolder, project.name, project.file);

			// Open the file
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(appFilePath));
			await vscode.window.showTextDocument(document);

			const fileUri = vscode.Uri.file(appFilePath);
			let activePath = await environmentPath(fileUri);

			// Poll for the extension to process the editor change (up to 10 seconds)
			const timeout = Date.now() + 10000;
			while (Date.now() < timeout) {
				if (activePath.includes(project.expectedPath)) {
					break;
				}
				await new Promise(resolve => setTimeout(resolve, 100));
				activePath = await environmentPath(fileUri);
			}

			// The environment should be set to the corresponding project venv or uv cache
			assert.ok(activePath.includes(project.expectedPath), `Expected path to include '${project.expectedPath}', but got ${activePath}`);
		});
	}

	test('Script switching preserves project assignments and never adds script settings entries', async function () {
		if (!envsApi) {
			this.skip();
		}
		const regularProjects = projects.filter(p => p.name !== 'example-script');
		// Explicitly reload each project so automatic discovery cannot satisfy the assertions alone.
		for (const project of regularProjects) {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(
				vscode.Uri.file(path.join(fixturesFolder, project.name, project.file))
			));
			await vscode.commands.executeCommand('uv-auto-venv.reloadVenv');
		}
		const secondScript = path.join(fixturesFolder, 'example-script', 'second.py');
		fs.writeFileSync(secondScript, '# /// script\n# dependencies = []\n# ///\nprint("second")\n');
		cp.execFileSync('uv', ['sync', '--script', secondScript, '--link-mode=copy']);
		for (const script of [path.join(fixturesFolder, 'example-script', 'main.py'), secondScript]) {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(script)));
			await vscode.commands.executeCommand('uv-auto-venv.reloadVenv');
			const expected = cp.execFileSync('uv', ['python', 'find', '--script', script], { encoding: 'utf8' }).trim();
			const actual = await environmentPath(vscode.Uri.file(fixturesFolder));
			// VS Code normalizes Windows drive letters; uv may return uppercase.
			assert.strictEqual(vscode.Uri.file(actual).fsPath, vscode.Uri.file(expected).fsPath);
			for (const project of regularProjects) {
				const file = vscode.Uri.file(path.join(fixturesFolder, project.name, project.file));
				assert.ok((await environmentPath(file)).includes(project.expectedPath), `${project.name} lost its fixed assignment`);
			}
		}
		// Registration is asynchronous in the public API; allow the settings write to settle.
		let paths: string[] = [];
		const deadline = Date.now() + 10000;
		do {
			const settings = vscode.workspace.getConfiguration('python-envs').get<{ path: string }[]>('pythonProjects', []);
			paths = settings.map(p => path.resolve(fixturesFolder, p.path));
			if (regularProjects.every(p => paths.includes(path.join(fixturesFolder, p.name)))) {
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		} while (Date.now() < deadline);
		assert.deepStrictEqual(paths.sort(), regularProjects.map(p => path.join(fixturesFolder, p.name)).sort());
		assert.strictEqual(envsApi.getPythonProjects().length, regularProjects.length + 1);
	});

	test('Pylance keeps project imports resolved while the shared script environment changes', async function () {
		if (!envsApi) {
			this.skip();
		}
		const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
		assert.ok(pylance, 'Pylance must be installed for project import-resolution tests');
		await pylance.activate();
		const appProbe = vscode.Uri.file(path.join(fixturesFolder, 'example-app', 'environment_probe.py'));
		const scriptProbe = vscode.Uri.file(path.join(fixturesFolder, 'example-script', 'environment_probe.py'));
		const imports = 'import cowsay\nimport missing_uv_auto_venv_test_module\n';
		fs.writeFileSync(appProbe.fsPath, imports);
		fs.writeFileSync(scriptProbe.fsPath, '# /// script\n# dependencies = []\n# ///\n' + imports);
		cp.execFileSync('uv', ['sync', '--script', scriptProbe.fsPath, '--link-mode=copy']);
		// Pin both documents: replacing a preview tab closes it and clears its diagnostics.
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(appProbe), { preview: false });
		await vscode.commands.executeCommand('uv-auto-venv.reloadVenv');
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(scriptProbe), { preview: false });
		await vscode.commands.executeCommand('uv-auto-venv.reloadVenv');

		const missingImports = (file: vscode.Uri) => vscode.languages.getDiagnostics(file)
			.filter(d => (typeof d.code === 'object' ? d.code.value : d.code) === 'reportMissingImports')
			.map(d => d.message);
		const deadline = Date.now() + 30000;
		do {
			if (missingImports(appProbe).some(m => m.includes('missing_uv_auto_venv_test_module'))
				&& missingImports(scriptProbe).some(m => m.includes('cowsay'))) {
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		} while (Date.now() < deadline);
		assert.ok(missingImports(scriptProbe).some(m => m.includes('cowsay')), 'The script environment should not contain cowsay');
		assert.ok(missingImports(appProbe).some(m => m.includes('missing_uv_auto_venv_test_module')), 'Pylance must finish analyzing the project probe');
		assert.ok(!missingImports(appProbe).some(m => m.includes('cowsay')), 'The project should still resolve cowsay from its own environment');
	});
});

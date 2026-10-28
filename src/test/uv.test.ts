import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { activateExtension, fileEditor } from './harness';

suite('Real uv environment discovery', function () {
	this.timeout(30000);
	let root: string;

	setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-auto-venv-')); });
	teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

	function createProject(name: string): string {
		const directory = path.join(root, name);
		fs.mkdirSync(directory);
		fs.writeFileSync(path.join(directory, 'pyproject.toml'),
			`[project]\nname = "${name}"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n`);
		fs.writeFileSync(path.join(directory, 'main.py'), '');
		cp.execFileSync('uv', ['venv', '--python', '3.12', path.join(directory, '.venv')], { stdio: 'pipe' });
		return directory;
	}

	for (const useEnvsExtension of [false, true]) {
		for (const variable of ['VIRTUAL_ENV', 'CONDA_PREFIX']) {
			test(`Ignores an inherited ${variable} environment (${useEnvsExtension ? 'python-envs' : 'classic'})`, async () => {
				const first = createProject('first');
				const second = createProject('second');
				const inherited = path.join(first, '.venv');
				if (variable === 'CONDA_PREFIX') {
					fs.mkdirSync(path.join(inherited, 'conda-meta'));
				}
				const extension = await activateExtension(useEnvsExtension, {
					realUv: true,
					workspaceRoot: root,
					env: { ...process.env, [variable]: inherited },
				});
				await extension.reload(fileEditor(path.join(second, 'main.py')));
				const selected = extension.selections.at(-1)?.interpreter;
				assert.ok(selected?.startsWith(path.join(second, '.venv') + path.sep),
					`Expected the second project's environment, got ${selected}`);
			});
		}

		test(`Preserves the current selection for an unsynced script (${useEnvsExtension ? 'python-envs' : 'classic'})`, async () => {
			const project = createProject('project');
			const script = path.join(root, 'unsynced.py');
			fs.writeFileSync(script, '# /// script\n# requires-python = ">=3.12"\n# dependencies = ["cowsay>=6.1"]\n# ///\n');
			const extension = await activateExtension(useEnvsExtension, { realUv: true, workspaceRoot: root });
			await extension.reload(fileEditor(path.join(project, 'main.py')));
			const selections = extension.selections.slice();
			await extension.reload(fileEditor(script));
			assert.deepStrictEqual(extension.selections, selections);
			assert.ok(extension.warnings.some(w => w.includes('No cached environment')));
		});

		test(`Uses a script's local uv cache configuration (${useEnvsExtension ? 'python-envs' : 'classic'})`, async () => {
			const env = { ...process.env };
			// setup-uv exports this in CI; it would override the configuration being tested.
			delete env.UV_CACHE_DIR;
			const directory = path.join(root, 'scripts');
			const cache = path.join(root, 'custom-cache');
			fs.mkdirSync(directory);
			fs.writeFileSync(path.join(directory, 'uv.toml'), `cache-dir = ${JSON.stringify(cache)}\n`);
			const script = path.join(directory, 'main.py');
			fs.writeFileSync(script, '# /// script\n# requires-python = ">=3.12"\n# dependencies = []\n# ///\n');
			cp.execFileSync('uv', ['sync', '--script', script], { cwd: directory, env, stdio: 'pipe' });
			const expected = cp.execFileSync('uv', ['python', 'find', '--script', script], {
				cwd: directory, env, encoding: 'utf8',
			}).trim();
			assert.ok(expected.startsWith(cache + path.sep), 'The fixture must use the custom cache');
			const extension = await activateExtension(useEnvsExtension, { realUv: true, workspaceRoot: root, env });
			await extension.reload(fileEditor(script));
			const selected = extension.selections.at(-1)?.interpreter;
			assert.ok(selected, `Expected the script environment, got warnings: ${extension.warnings}`);
			assert.strictEqual(path.relative(expected, selected), '');
		});

		for (const inlineCache of [JSON.stringify('custom cache'), "'''custom cache'''", '"""custom cache"""']) {
			test(`Uses inline cache-dir = ${inlineCache} (${useEnvsExtension ? 'python-envs' : 'classic'})`, async () => {
				const env = { ...process.env };
				delete env.UV_CACHE_DIR;
				const directory = path.join(root, 'scripts');
				fs.mkdirSync(directory);
				const script = path.join(directory, 'main.py');
				fs.writeFileSync(script, '# /// script\n# requires-python = ">=3.12"\n# dependencies = []\n'
					+ `# [tool.uv]\n# cache-dir = ${inlineCache}\n# ///\n`);
				cp.execFileSync('uv', ['sync', '--script', script], { cwd: directory, env, stdio: 'pipe' });
				const expected = cp.execFileSync('uv', ['python', 'find', '--script', script], {
					cwd: directory, env, encoding: 'utf8',
				}).trim();
				assert.ok(expected.startsWith(path.join(directory, 'custom cache') + path.sep));
				const extension = await activateExtension(useEnvsExtension, { realUv: true, workspaceRoot: root, env });
				await extension.reload(fileEditor(script));
				assert.strictEqual(extension.selections.at(-1)?.interpreter, expected,
					`Expected the inline cache environment, got warnings: ${extension.warnings}`);
			});
		}

		test(`Honors UV_CACHE_DIR over inline cache settings (${useEnvsExtension ? 'python-envs' : 'classic'})`, async () => {
			const script = path.join(root, 'main.py');
			const cache = path.join(root, 'environment-cache');
			const env = { ...process.env, UV_CACHE_DIR: 'environment-cache' };
			fs.writeFileSync(script, '# /// script\n# dependencies = []\n'
				+ '# [tool.uv]\n# cache-dir = "inline-cache"\n# ///\n');
			cp.execFileSync('uv', ['sync', '--script', script], { cwd: root, env, stdio: 'pipe' });
			const expected = cp.execFileSync('uv', ['python', 'find', '--script', script], {
				cwd: root, env, encoding: 'utf8',
			}).trim();
			assert.ok(expected.startsWith(cache + path.sep));
			const extension = await activateExtension(useEnvsExtension, { realUv: true, workspaceRoot: root, env });
			await extension.reload(fileEditor(script));
			assert.strictEqual(extension.selections.at(-1)?.interpreter, expected);
		});
	}
});

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
		test(`Ignores an inherited active environment (${useEnvsExtension ? 'python-envs' : 'classic'})`, async () => {
			const first = createProject('first');
			const second = createProject('second');
			const inherited = path.join(first, '.venv');
			const extension = await activateExtension(useEnvsExtension, {
				realUv: true,
				workspaceRoot: root,
				env: { ...process.env, VIRTUAL_ENV: inherited },
			});
			await extension.reload(fileEditor(path.join(second, 'main.py')));
			const selected = extension.selections.at(-1)?.interpreter;
			assert.ok(selected?.startsWith(path.join(second, '.venv') + path.sep),
				`Expected the second project's environment, got ${selected}`);
		});
	}
});

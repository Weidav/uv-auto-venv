import * as assert from 'assert';
import * as path from 'path';
import { mock } from 'node:test';
import { activateExtension, fileEditor, uri } from './harness';

const root = path.resolve('workspace');
const app = path.join(root, 'apps', 'app');
const lib = path.join(root, 'libs', 'lib');
const appFile = path.join(app, 'src', 'app.py');
const libFile = path.join(lib, 'src', 'lib', '__init__.py');
const scriptA = path.join(root, 'scripts', 'a.py');
const scriptB = path.join(root, 'scripts', 'b.py');
const nestedScript = path.join(app, 'scripts', 'nested.py');
const scriptAEnv = path.join(root, 'cache', 'a', 'bin', 'python');
const scriptBEnv = path.join(root, 'cache', 'b', 'bin', 'python');
const appEnv = path.join(app, '.venv', 'python');
const libEnv = path.join(lib, '.venv', 'python');
const metadata = '# /// script\n# dependencies = []\n# ///\n';
const files = {
	[path.join(app, 'pyproject.toml')]: '[project]',
	[path.join(lib, 'pyproject.toml')]: '[project]',
	[appFile]: '', [libFile]: '',
	[scriptA]: metadata, [scriptB]: metadata, [nestedScript]: metadata,
	[appEnv]: '', [libEnv]: '', [scriptAEnv]: '', [scriptBEnv]: '',
	[path.join(root, 'cache', 'a', 'pyvenv.cfg')]: '',
	[path.join(root, 'cache', 'b', 'pyvenv.cfg')]: '',
};

async function findPython(args: string[], cwd?: string): Promise<string> {
	if (args[2] === '--script') {
		return args[3] === scriptB ? scriptBEnv : scriptAEnv;
	}
	return cwd?.startsWith(lib) ? libEnv : appEnv;
}

suite('Hybrid project and script environments', () => {
	async function activate(options: Parameters<typeof activateExtension>[1] = {}) {
		return activateExtension(true, { workspaceRoot: root, files, findPython, ...options });
	}

	test('Assigns nested source modules to their project roots, registering each only once', async () => {
		const extension = await activate();
		await extension.reload(fileEditor(appFile));
		await extension.reload(fileEditor(libFile));
		await extension.reload(fileEditor(appFile));
		assert.deepStrictEqual(extension.registrations, [app, lib]);
		assert.deepStrictEqual(extension.selections.map(s => s.scope), [app, lib, app]);
		assert.strictEqual((await extension.envsApi.getEnvironment(uri(libFile)))?.environmentPath.fsPath, libEnv);
	});

	test('Switches scripts without registering them or changing assigned projects', async () => {
		const extension = await activate();
		await extension.reload(fileEditor(appFile));
		await extension.reload(fileEditor(libFile));
		await extension.reload(fileEditor(scriptA));
		await extension.reload(fileEditor(scriptB));
		assert.deepStrictEqual(extension.registrations, [app, lib]);
		assert.deepStrictEqual(extension.selections.slice(-2), [
			{ scope: root, interpreter: scriptAEnv }, { scope: root, interpreter: scriptBEnv },
		]);
		assert.strictEqual((await extension.envsApi.getEnvironment(uri(appFile)))?.environmentPath.fsPath, appEnv);
		assert.strictEqual((await extension.envsApi.getEnvironment(uri(libFile)))?.environmentPath.fsPath, libEnv);
		assert.deepStrictEqual(extension.classicSelections, []);
	});

	test('Protects regular projects from scripts nested inside them', async () => {
		const extension = await activate();
		await extension.reload(fileEditor(appFile));
		await extension.reload(fileEditor(nestedScript));
		assert.deepStrictEqual(extension.registrations, [app]);
		assert.deepStrictEqual(extension.selections, [{ scope: app, interpreter: appEnv }]);
		assert.ok(extension.warnings.some(w => w.includes('separate scope')));
	});

	test('Allows a separately registered scripts folder inside a regular project', async () => {
		const scriptsFolder = path.dirname(nestedScript);
		const extension = await activate({ projects: [scriptsFolder] });
		await extension.reload(fileEditor(appFile));
		await extension.reload(fileEditor(nestedScript));
		assert.deepStrictEqual(extension.registrations, [app]);
		assert.deepStrictEqual(extension.selections.at(-1), { scope: scriptsFolder, interpreter: scriptAEnv });
		assert.strictEqual((await extension.envsApi.getEnvironment(uri(appFile)))?.environmentPath.fsPath, appEnv);
	});

	test('Protects a regular project at the workspace root', async () => {
		const extension = await activate({ files: { ...files, [path.join(root, 'pyproject.toml')]: '[project]' } });
		await extension.reload(fileEditor(scriptA));
		assert.deepStrictEqual(extension.selections, []);
		assert.deepStrictEqual(extension.registrations, []);
		assert.ok(extension.warnings.some(w => w.includes('separate scope')));
	});

	test('Does not re-register projects restored from settings', async () => {
		const extension = await activate({ projects: [app] });
		await extension.reload(fileEditor(appFile));
		assert.deepStrictEqual(extension.registrations, []);
		assert.deepStrictEqual(extension.selections, [{ scope: app, interpreter: appEnv }]);
	});

	test('Does not fall back to the containing project after a failed script lookup', async () => {
		const extension = await activate({ findPython: async () => { throw new Error('Script environment is missing'); } });
		await extension.reload(fileEditor(scriptA));
		assert.deepStrictEqual(extension.lookups, [scriptA]);
		assert.deepStrictEqual(extension.selections, []);
		assert.deepStrictEqual(extension.registrations, []);
	});

	for (const useEnvsExtension of [false, true]) {
		for (const [name, fallback, virtualEnv] of [
			['project environment', appEnv, true],
			['environment beside the cache', path.join(root, 'cache-other', 'bin', 'python'), true],
			['base Python inside the cache', path.join(root, 'cache', 'base', 'bin', 'python'), false],
		] as const) {
			test(`Rejects a script's fallback to ${name} (${useEnvsExtension ? 'python-envs' : 'classic'})`, async () => {
				const extension = await activateExtension(useEnvsExtension, {
					workspaceRoot: root,
					files: { ...files, [fallback]: '', ...(virtualEnv ? {
						[path.join(path.dirname(path.dirname(fallback)), 'pyvenv.cfg')]: '',
					} : {}) },
					findPython: async () => fallback,
				});
				await extension.reload(fileEditor(scriptA));
				assert.deepStrictEqual(extension.selections, []);
				assert.deepStrictEqual(extension.registrations, []);
				assert.ok(extension.warnings.some(w => w.includes('No cached environment')));
			});
		}
	}

	test('Keeps the shared selection intact when python-envs cannot resolve an environment', async () => {
		const extension = await activate({ resolve: false });
		await extension.reload(fileEditor(appFile));
		assert.deepStrictEqual(extension.selections, []);
		assert.deepStrictEqual(extension.registrations, []);
		assert.ok(extension.warnings.some(w => w.includes('could not resolve')));
	});

	test('Waits for a project settings write before starting the next registration', async () => {
		const saves: (() => void)[] = [];
		const extension = await activate({ persistProject: save => saves.push(save) });
		const first = extension.reload(fileEditor(appFile));
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.strictEqual(saves.length, 1);
		assert.deepStrictEqual(extension.selections, []);
		const second = extension.reload(fileEditor(libFile));
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepStrictEqual(extension.registrations, [app]);
		saves[0]();
		await first;
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepStrictEqual(extension.registrations, [app, lib]);
		assert.strictEqual(saves.length, 2);
		saves[1]();
		await second;
		assert.deepStrictEqual(extension.selections, [{ scope: lib, interpreter: libEnv }]);
	});

	for (const mode of ['classic', 'missing python-envs'] as const) {
		test(`Retains workspace switching in ${mode} mode`, async () => {
			const extension = await activateExtension(mode !== 'classic', {
				workspaceRoot: root, files, findPython, envsInstalled: mode !== 'missing python-envs',
			});
			await extension.reload(fileEditor(appFile));
			await extension.reload(fileEditor(scriptA));
			// Classic forced reload clears the cached interpreter before selecting it.
			assert.deepStrictEqual(extension.selections.filter(s => s.interpreter), [
				{ scope: root, interpreter: appEnv }, { scope: root, interpreter: scriptAEnv },
			]);
			assert.deepStrictEqual(extension.registrations, []);
		});
	}

	test('Drops a slow script lookup after the user selects another script', async () => {
		let finishFirst!: (interpreter: string) => void;
		const extension = await activate({ findPython: async (args, cwd) => {
			if (args[3] === scriptA) {
				return new Promise<string>(resolve => { finishFirst = resolve; });
			}
			return findPython(args, cwd);
		} });
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			extension.onChange(fileEditor(scriptA));
			mock.timers.tick(300);
			extension.onChange(fileEditor(scriptB));
			mock.timers.tick(300);
		} finally {
			mock.timers.reset();
		}
		await new Promise<void>(resolve => setImmediate(resolve));
		finishFirst(scriptAEnv);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepStrictEqual(extension.selections, [{ scope: root, interpreter: scriptBEnv }]);
	});
});

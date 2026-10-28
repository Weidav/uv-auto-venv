import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { mock } from 'node:test';
import { promisify } from 'util';
import { runInNewContext } from 'vm';
import type * as vscode from 'vscode';

type Editor = vscode.TextEditor | undefined;

function editor(project: string, languageId = 'python'): vscode.TextEditor {
	return {
		document: {
			languageId,
			uri: { fsPath: path.join('workspace', project, 'main.py') },
		},
	} as vscode.TextEditor;
}

/** Load the real extension in isolation, replacing only its external APIs. */
async function activateExtension(useEnvsExtension: boolean) {
	const lookups: string[] = [];
	const selections: { interpreter: string; scope: string }[] = [];
	let onChange: ((editor: Editor) => void) | undefined;
	const uri = (fsPath: string) => ({ fsPath });
	const pythonApi = {
		environments: {
			getActiveEnvironmentPath: () => ({ path: '' }),
			updateActiveEnvironmentPath: async (interpreter: string, scope: vscode.Uri) => {
				selections.push({ interpreter, scope: scope.fsPath });
			},
		},
	};
	const envsApi = {
		resolveEnvironment: async (environmentPath: vscode.Uri) => ({
			envId: { id: environmentPath.fsPath }, environmentPath,
		}),
		getEnvironment: async () => undefined,
		setEnvironment: async (scope: vscode.Uri, env: { environmentPath: vscode.Uri }) => {
			selections.push({ interpreter: env.environmentPath.fsPath, scope: scope.fsPath });
		},
	};
	const disposable = { dispose() {} };
	const vscodeApi = {
		Uri: { file: uri },
		window: {
			createOutputChannel: () => ({ info() {}, warn() {} }),
			activeTextEditor: undefined,
			onDidChangeActiveTextEditor: (listener: (editor: Editor) => void) => {
				assert.strictEqual(onChange, undefined, 'Register only one editor listener');
				onChange = listener;
				return disposable;
			},
		},
		workspace: {
			getConfiguration: () => ({
				get: (key: string) => key === 'useEnvironmentsExtension' && useEnvsExtension,
			}),
			getWorkspaceFolder: (file: vscode.Uri) => ({ uri: uri(path.dirname(file.fsPath)) }),
		},
		extensions: {
			getExtension: () => ({ isActive: true, exports: envsApi }),
		},
		commands: { registerCommand: () => disposable },
	};
	// Match execFile's promisified result, without running uv or touching environments.
	const execFile = Object.assign(() => assert.fail('Expected promisified execFile'), {
		[promisify.custom]: async (command: string, args: string[], options: { cwd: string }) => {
			assert.strictEqual(command, 'uv');
			assert.deepStrictEqual(Array.from(args), ['python', 'find']);
			lookups.push(options.cwd);
			return { stdout: path.join(options.cwd, '.venv', 'python') + '\n' };
		},
	});
	const dependencies: Record<string, unknown> = {
		vscode: vscodeApi,
		'@vscode/python-extension': { PythonExtension: { api: async () => pythonApi } },
		child_process: { execFile },
		fs: { openSync: () => 0, readSync: () => 0, closeSync() {}, existsSync: () => true },
		path,
		util: { promisify },
	};
	const extension = { exports: {} as typeof import('../extension') };
	runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8'), {
		exports: extension.exports,
		require: (name: string) => {
			assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
			return dependencies[name];
		},
		Buffer,
		console,
		// Resolve timers at invocation time so each synchronous scenario can fake time.
		setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
		clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
	});
	await extension.exports.activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
	assert.ok(onChange, 'Activation must register the editor-change handler');
	return { onChange, lookups, selections };
}

function withClock(scenario: () => void): void {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		scenario();
	} finally {
		// Restore the host clock before yielding to any other extension-host work.
		mock.timers.reset();
	}
}

for (const useEnvsExtension of [false, true]) {
	suite(`Debounce editor integration (${useEnvsExtension ? 'python-envs' : 'classic'} API)`, () => {
		let extension: Awaited<ReturnType<typeof activateExtension>>;
		setup(async () => { extension = await activateExtension(useEnvsExtension); });

		async function assertSelections(projects: string[]) {
			// All mocked I/O resolves immediately; let the real setup async chain finish.
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(extension.selections, projects.map(project => ({
				interpreter: path.join('workspace', project, '.venv', 'python'),
				scope: path.join('workspace', project),
			})));
		}

		test('Waits the full production 300 ms before starting environment setup', async () => {
			withClock(() => {
				extension.onChange(editor('app'));
				assert.deepStrictEqual(extension.lookups, []);
				mock.timers.tick(299);
				assert.deepStrictEqual(extension.lookups, []);
				mock.timers.tick(1);
				assert.deepStrictEqual(extension.lookups, [path.join('workspace', 'app')]);
			});
			await assertSelections(['app']);
		});

		test('Restarts the delay and sets up only the last rapidly selected environment', async () => {
			withClock(() => {
				extension.onChange(editor('app'));
				mock.timers.tick(100);
				extension.onChange(editor('bare'));
				mock.timers.tick(100);
				extension.onChange(editor('lib'));
				mock.timers.tick(299);
				assert.deepStrictEqual(extension.lookups, []);
				mock.timers.tick(1);
				assert.deepStrictEqual(extension.lookups, [path.join('workspace', 'lib')]);
				mock.timers.tick(1000);
				assert.deepStrictEqual(extension.lookups, [path.join('workspace', 'lib')]);
			});
			await assertSelections(['lib']);
		});

		test('Handles editor changes spaced beyond the delay separately', async () => {
			withClock(() => {
				extension.onChange(editor('app'));
				mock.timers.tick(300);
				extension.onChange(editor('lib'));
				mock.timers.tick(300);
				assert.deepStrictEqual(extension.lookups, [
					path.join('workspace', 'app'), path.join('workspace', 'lib'),
				]);
			});
			await assertSelections(['app', 'lib']);
		});

		for (const [name, nextEditor] of [
			['cleared', undefined],
			['changed to non-Python', editor('notes', 'plaintext')],
		] as const) {
			test(`Cancels pending Python setup when the editor is ${name}`, async () => {
				withClock(() => {
					extension.onChange(editor('app'));
					mock.timers.tick(100);
					extension.onChange(nextEditor);
					mock.timers.tick(1000);
					assert.deepStrictEqual(extension.lookups, []);
				});
				await assertSelections([]);
			});
		}
	});
}

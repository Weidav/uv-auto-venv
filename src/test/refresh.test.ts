import * as assert from 'assert';
import * as path from 'path';
import { mock } from 'node:test';
import { activateExtension, editor, uri } from './harness';

suite('Python Environments manual refresh', () => {
	test('Refreshes cached interpreter details only on manual reload', async () => {
		let actualVersion = '3.12';
		let cachedVersion = actualVersion;
		const refreshScopes: (string | undefined)[] = [];
		const extension = await activateExtension(true, {
			refreshEnvsEnvironments: async scope => {
				refreshScopes.push(scope?.fsPath);
				cachedVersion = actualVersion;
			},
			resolveEnvironment: async environmentPath => ({
				envId: { id: environmentPath.fsPath, managerId: 'venv' },
				environmentPath, version: cachedVersion,
			}),
		});
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			extension.onChange(editor('app'));
			mock.timers.tick(300);
		} finally {
			mock.timers.reset();
		}
		await new Promise<void>(resolve => setImmediate(resolve));
		const scope = uri(path.join('workspace', 'app'));
		assert.strictEqual((await extension.envsApi.getEnvironment(scope))?.version, '3.12');
		assert.deepStrictEqual(refreshScopes, []);

		actualVersion = '3.13'; // The environment was recreated at the same path.
		await extension.reload(editor('app'));
		assert.strictEqual((await extension.envsApi.getEnvironment(scope))?.version, '3.13');
		assert.deepStrictEqual(refreshScopes, [scope.fsPath]);
	});

	test('Discards a reload when the editor changes during discovery', async () => {
		let finishRefresh!: () => void;
		let resolutions = 0;
		const extension = await activateExtension(true, {
			refreshEnvsEnvironments: () => new Promise<void>(resolve => { finishRefresh = resolve; }),
			resolveEnvironment: async () => { resolutions++; return undefined; },
		});
		const refresh = extension.reload(editor('app'));
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.strictEqual(typeof finishRefresh, 'function');
		extension.onChange(undefined);
		finishRefresh();
		await refresh;
		assert.strictEqual(resolutions, 0);
		assert.deepStrictEqual(extension.selections, []);
	});

	test('Preserves the current selection when discovery fails', async () => {
		const extension = await activateExtension(true, {
			workspaceRoot: path.join('workspace', 'app'),
			refreshEnvsEnvironments: async () => { throw new Error('Discovery failed'); },
		});
		const scope = uri(path.join('workspace', 'app'));
		const previous = await extension.envsApi.resolveEnvironment(uri('previous-python'));
		assert.ok(previous);
		await extension.envsApi.setEnvironment(scope, previous);
		await extension.reload(editor('app'));
		assert.strictEqual(await extension.envsApi.getEnvironment(scope), previous);
		assert.ok(extension.warnings.some(w => w.includes('Discovery failed')));
	});
});

suite('Classic manual refresh cancellation', () => {
	for (const [name, nextEditor] of [
		['closed', undefined],
		['changed to a non-Python tab', editor('notes', 'plaintext')],
	] as const) {
		test(`Does not clear the interpreter if the editor is ${name} during discovery`, async () => {
			let finishRefresh!: () => void;
			const extension = await activateExtension(false, {
				refreshEnvironments: () => new Promise<void>(resolve => { finishRefresh = resolve; }),
			});
			const refresh = extension.reload(editor('app'));
			await new Promise<void>(resolve => setImmediate(resolve));
			extension.onChange(nextEditor);
			finishRefresh();
			await refresh;
			assert.deepStrictEqual(extension.classicSelections, []);
		});

		test(`Restores the interpreter if the editor is ${name} while clearing`, async () => {
			let finishClear!: () => void;
			const extension = await activateExtension(false, {
				selectClassic: async interpreter => {
					if (!interpreter) {
						await new Promise<void>(resolve => { finishClear = resolve; });
					}
				},
			});
			const refresh = extension.reload(editor('app'));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(extension.classicSelections.map(s => s.interpreter), ['']);
			extension.onChange(nextEditor);
			finishClear();
			await refresh;
			assert.deepStrictEqual(extension.classicSelections.map(s => s.interpreter), [
				'', path.join('workspace', 'app', '.venv', 'python'),
			]);
		});
	}

	test('Applies a newer Python selection after finishing the clear and reapply pair', async () => {
		let finishClear!: () => void;
		const extension = await activateExtension(false, {
			workspaceRoot: path.resolve('workspace'),
			selectClassic: async interpreter => {
				if (!interpreter) {
					await new Promise<void>(resolve => { finishClear = resolve; });
				}
			},
		});
		const refresh = extension.reload(editor('app'));
		await new Promise<void>(resolve => setImmediate(resolve));
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			extension.onChange(editor('lib'));
			mock.timers.tick(300);
		} finally {
			mock.timers.reset();
		}
		finishClear();
		await refresh;
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepStrictEqual(extension.classicSelections.map(s => s.interpreter), [
			'', path.join('workspace', 'app', '.venv', 'python'), path.join('workspace', 'lib', '.venv', 'python'),
		]);
	});
});

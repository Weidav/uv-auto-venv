import * as assert from 'assert';
import * as path from 'path';
import { mock } from 'node:test';
import { activateExtension, editor } from './harness';

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

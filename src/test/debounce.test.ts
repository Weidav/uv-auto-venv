import * as assert from 'assert';
import * as path from 'path';
import { mock } from 'node:test';
import { activateExtension, editor } from './harness';

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
			});
			await assertSelections(['app']);
			withClock(() => {
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

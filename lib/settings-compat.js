/**
 * Local copies of the `settingsNamespace` / `installSettingsSection` helpers
 * that @deepseek-ai/dsh-settings exported up to 0.1.1-rc.2 and removed in
 * 0.1.2+. Semantics are unchanged: while a settings service is mounted, the
 * namespace is registered with the composition entry as the `base` layer and
 * the source thunk points at the resolved scope; when the service goes away
 * the consumer falls back to the entry. Copied verbatim from
 * dsh-settings@0.1.1-rc.2 lib/index.js (MIT, DeepSeek).
 * @module dsh-voice-mimo/settings-compat
 */

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;

function settingsNamespace(value) {
	if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
	return value;
}

function isUnloading(ctx) {
	const state = ctx.fiber.state;
	return state === FIBER_UNLOADING || state === FIBER_DISPOSED;
}

function installSettingsSection(ctx, ns, schema, entry, hooks) {
	ctx.inject(["settings"], (sctx) => {
		const scope = sctx.settings.register(ns, schema, {
			base: entry,
			...hooks.validate === void 0 ? {} : { validate: hooks.validate }
		});
		hooks.setSource(() => scope.get());
		sctx.effect(() => () => {
			if (isUnloading(ctx)) return;
			hooks.setSource(() => entry);
			hooks.onChange();
		});
		hooks.onChange();
		scope.watch(() => {
			if (isUnloading(ctx)) return;
			hooks.onChange();
		});
	});
}

export { installSettingsSection, settingsNamespace };

---
name: run-tavern-director
description: Build, smoke-test, and deploy the TavernDirector SillyTavern plugin. Use when asked to "run", "build", "test", "deploy", or "verify" the plugin.
---

# Run: TavernDirector

SillyTavern browser plugin — multi-character dialogue director with model routing, jailbreak management, and floating control panel.

## Prerequisites

```bash
apt-get install -y nodejs npm
```

## Build

```bash
npm install
npm run build
```

Produces:
- `plugin/index.js` — IIFE bundle for ST (rollup `src/bootstrap.ts` → IIFE)
- `dist/` — ESM library output (rollup `src/index.ts` → ESM)

## Run (agent path)

The driver validates core logic in Node.js (no browser needed):

```bash
node .claude/skills/run-tavern-director/driver.mjs [--verbose] [--quick]
```

What it tests:

| Area | Tests |
|------|-------|
| Module loading | ESM dist imports (index, modelRouter, writer, types, adapter) |
| Build artifacts | IIFE bundle existence, size, key symbols (SettingsStore, getContext, generateRaw, injectFloatingPanel) |
| ModelRouter | Role model routing, default fallback, error on empty config, auto-degrade after 3 failures |
| Writer | writeOne with/without callback, writeReport sequential turnIndex no-collision (bug fix #4 verified) |
| Adapter | getSummary empty state |

## Deploy

```bash
cp plugin/index.js plugin/manifest.json $ST_PLUGINS_DIR/TavernDirector/
```

Where `$ST_PLUGINS_DIR` is typically `SillyTavern/plugins/`.

Default on this machine:
```bash
cp plugin/index.js plugin/manifest.json /data/data/com.termux/files/home/SillyTavern/plugins/TavernDirector/
```

## Direct invocation

Import core modules in Node.js (browser globals are mocked):

```js
// ModelRouter — pure logic, no DOM
const { ModelRouter } = await import('./dist/role-engine/modelRouter.js');
const router = new ModelRouter({
  defaultModel: 'openai/gpt-4o',
  roleModels: { char_alice: 'anthropic/claude' },
  fallbackModels: ['fallback-a'],
  directorModel: '',
  taskOverrides: {},
});

// Writer — needs a WriteCallback
const { createWriter } = await import('./dist/role-engine/writer.js');
const writer = createWriter(async (msg) => { console.log(msg); });
```

## Test suite (unit)

```bash
# No unit test suite exists yet — driver.mjs is the smoke test
node .claude/skills/run-tavern-director/driver.mjs
```

## Gotchas

- **SettingsStore not in ESM dist.** `src/store/settingsStore.ts` is only bundled into the IIFE (`plugin/index.js`), not exported from the ESM `dist/` via `src/index.ts`. Smoke tests verify its presence in the IIFE bundle instead.
- **Browser globals required.** All modules assume `window`, `localStorage`, `document`, `CustomEvent`. The driver mocks these — add mocks if importing new modules.
- **Android sdcard: no symlinks.** npm install fails on `/storage/emulated/0/` (FAT/exFAT filesystem). Copy to `/tmp/` for `npm install` + build, then copy artifacts back.
- **SillyTavern is at `/data/data/com.termux/files/home/SillyTavern/`.** Plugins go in `plugins/TavernDirector/`.
- **Plugin UI requires browser.** The floating panel (`injectFloatingPanel`) and role selector (`showRoleSelector`) are DOM-dependent and only testable in a real browser with ST loaded.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot find module` for dist files | Run `npm run build` first |
| `npm install` fails with EACCES symlink | Copy to `/tmp/`, install there, copy back |
| `navigator` getter error in Node | Already mocked in driver; add `Object.defineProperty` for new globals |
| Plugin not showing in ST | Check `manifest.json` is in `plugins/TavernDirector/`, restart ST |
| Floating panel not appearing | Check browser console for `[TavernDirector]` logs; body retry runs 30× at 200ms |

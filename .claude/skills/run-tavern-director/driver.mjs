#!/usr/bin/env node
/**
 * TavernDirector smoke-test driver.
 *
 * Imports ESM dist modules with mocked browser globals and validates
 * core logic — model routing, settings persistence, writer, types.
 *
 * Usage:
 *   node .claude/skills/run-tavern-director/driver.mjs [--verbose] [--quick]
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { ok, equal } from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

// Mock browser globals (modules need these to load)
globalThis.window = globalThis;
globalThis.localStorage = (() => {
  const store = new Map();
  return {
    getItem(k) { return store.get(k) ?? null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    get length() { return store.size; },
    key(i) { return [...store.keys()][i] ?? null; },
    clear() { store.clear(); },
  };
})();
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: null }, writable: true, configurable: true,
});
globalThis.performance = { now: () => Date.now() };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, opts) { this.type = type; this.detail = opts?.detail; }
};
globalThis.document = {
  body: { appendChild() {}, addEventListener() {} },
  head: { appendChild() {} },
  createElement() { return { appendChild() {}, addEventListener() {} }; },
  addEventListener() {},
  getElementById() { return null; },
  querySelectorAll() { return []; },
  readyState: 'complete',
};
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.prompt = () => '';

const VERBOSE = process.argv.includes('--verbose');
const QUICK = process.argv.includes('--quick');
let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    if (VERBOSE) console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    failed++;
    console.error('  \x1b[31m✗\x1b[0m ' + name + ': ' + e.message);
    if (QUICK) process.exit(1);
  }
}

async function runAll() {
console.log('=== TavernDirector Smoke Tests ===\n');

// ── 1. Module loading ─────────────────────────────
console.log('1. Module loading');
await test('import dist/index.js', async () => {
  const mods = await import(resolve(ROOT, 'dist/index.js'));
  ok(mods, 'modules should load');
});
await test('import modelRouter', async () => {
  const { ModelRouter } = await import(resolve(ROOT, 'dist/role-engine/modelRouter.js'));
  ok(ModelRouter, 'ModelRouter exports');
});
await test('import writer', async () => {
  const { Writer, createWriter } = await import(resolve(ROOT, 'dist/role-engine/writer.js'));
  ok(Writer, 'Writer exports');
  ok(typeof createWriter === 'function', 'createWriter() fn');
});
await test('import types + adapter', async () => {
  const types = await import(resolve(ROOT, 'dist/role-engine/types.js'));
  ok(types.DEFAULT_EXECUTION_CONFIG, 'DEFAULT_EXECUTION_CONFIG');
  const { adapter } = await import(resolve(ROOT, 'dist/index.js'));
  ok(typeof adapter.getSummary === 'function', 'getSummary() fn');
});

// ── 2. Build artifact checks ──────────────────────
console.log('\n2. Build artifacts');
await test('plugin/index.js exists (IIFE bundle)', () => {
  const p = resolve(ROOT, 'plugin/index.js');
  ok(existsSync(p), 'plugin/index.js not found');
  const size = readFileSync(p).length;
  ok(size > 100000, 'bundle too small: ' + size);
});
await test('IIFE bundle contains key modules', () => {
  const iife = readFileSync(resolve(ROOT, 'plugin/index.js'), 'utf-8');
  ok(iife.includes('SettingsStore'), 'missing SettingsStore');
  ok(iife.includes('ModelRouter'), 'missing ModelRouter');
  ok(iife.includes('injectFloatingPanel'), 'missing injectFloatingPanel');
  ok(iife.includes('getContext'), 'missing getContext (ST API)');
  ok(iife.includes('generateRaw'), 'missing generateRaw (ST API)');
  ok(iife.includes('localStorage'), 'missing localStorage');
});
await test('ESM dist has all expected modules', () => {
  const files = ['adapters', 'director', 'role-engine', 'store', 'ui', 'models', 'parsers', 'normalizers', 'validators'];
  for (const d of files) {
    ok(existsSync(resolve(ROOT, 'dist', d)), 'missing dist/' + d);
  }
});

// ── 3. ModelRouter ────────────────────────────────
console.log('\n3. ModelRouter routing');
let router;
await test('create router', async () => {
  const { ModelRouter } = await import(resolve(ROOT, 'dist/role-engine/modelRouter.js'));
  router = new ModelRouter({
    defaultModel: 'openai/gpt-4o',
    roleModels: { char_alice: 'anthropic/claude' },
    fallbackModels: ['fallback-a', 'fallback-b'],
    directorModel: 'director-model',
    taskOverrides: {},
  });
});
const mkTask = (id, rid, rname, ord) => ({
  taskId: id, roleId: rid, roleName: rname, order: ord,
  mode: 'sequential', status: 'pending', modelId: '',
  context: { character: {}, publicMessages: [], relevantWorldBooks: [],
    jailbreak: '', directorNote: '', sessionSummary: '', hiddenRoleIds: [], sceneInfo: '' },
  instruction: 'test', constraints: [], deadlineMs: 30000, maxRetries: 2,
  retryCount: 0, createdAt: Date.now(),
});
await test('route uses role model', () => {
  const r = router.route(mkTask('t1', 'char_alice', 'Alice', 0));
  equal(r.modelId, 'anthropic/claude');
  equal(r.level, 'role');
});
await test('route falls back to default', () => {
  const r = router.route(mkTask('t2', 'char_bob', 'Bob', 1));
  equal(r.modelId, 'openai/gpt-4o');
  equal(r.level, 'default');
});
await test('route with no models throws', () => {
  const empty = new (Object.getPrototypeOf(router).constructor)({
    defaultModel: '', roleModels: {}, fallbackModels: [],
    directorModel: '', taskOverrides: {},
  });
  try {
    empty.route(mkTask('t3', 'char_x', 'X', 0));
    throw new Error('should have thrown');
  } catch (e) {
    ok(e.message.includes('无法为角色'), 'correct error: ' + e.message.slice(0, 40));
  }
});
await test('auto-degrade after 3 failures', () => {
  router.recordFailure('openai/gpt-4o');
  router.recordFailure('openai/gpt-4o');
  router.recordFailure('openai/gpt-4o');
  const r = router.route(mkTask('t4', 'char_bob', 'Bob', 0));
  equal(r.isFallback, true, 'falls back after 3 failures');
  router.recordSuccess('openai/gpt-4o');
});

// ── 4. Writer callbacks ───────────────────────────
console.log('\n4. Writer callbacks');
await test('writeOne with callback', async () => {
  const { createWriter } = await import(resolve(ROOT, 'dist/role-engine/writer.js'));
  let written = null;
  const w = createWriter(async (msg) => { written = msg; });
  const out = { taskId:'t1', roleId:'a', roleName:'Alice', content:'Hello',
    status:'success', modelId:'m1', tokensUsed:100, latencyMs:500,
    raw:'', normSteps:[], error:'', timestamp:Date.now() };
  const msg = await w.writeOne(out, 0);
  ok(msg, 'returns message');
  equal(msg.speaker, 'Alice');
  equal(written?.speaker, 'Alice');
});
await test('writeOne without callback returns null', async () => {
  const { createWriter } = await import(resolve(ROOT, 'dist/role-engine/writer.js'));
  const w = createWriter();
  const out = { taskId:'t2', roleId:'b', roleName:'Bob', content:'test',
    status:'success', modelId:'m2', tokensUsed:50, latencyMs:200,
    raw:'', normSteps:[], error:'', timestamp:Date.now() };
  equal(await w.writeOne(out, 0), null);
});
await test('writeReport sequential — no turnIndex collision', async () => {
  const { createWriter } = await import(resolve(ROOT, 'dist/role-engine/writer.js'));
  const msgs = [];
  const w = createWriter(async (msg) => { msgs.push(msg); });
  const report = {
    reportId:'r1', sessionId:'s1',
    outputs: [
      { taskId:'a', roleId:'1', roleName:'A', content:'Hi', status:'success',
        modelId:'m', tokensUsed:10, latencyMs:100, raw:'', normSteps:[], error:'', timestamp:Date.now() },
      { taskId:'b', roleId:'2', roleName:'B', content:'', status:'failed',
        modelId:'m', tokensUsed:0, latencyMs:200, raw:'', normSteps:[], error:'timeout', timestamp:Date.now() },
    ],
    successCount:1, failedCount:1, skippedCount:0,
    totalLatencyMs:300, totalTokens:10, mode:'sequential', timestamp:Date.now(),
  };
  const written = await w.writeReport(report, 0, 'sequential');
  equal(written.length, 2);
  equal(written[0].turnIndex, 0, 'success turnIndex=0');
  equal(written[1].turnIndex, 1, 'failure turnIndex=1 (not colliding with success)');
});

// ── 5. Adapter summary ────────────────────────────
console.log('\n5. Adapter facade');
await test('getSummary empty state', async () => {
  const { adapter } = await import(resolve(ROOT, 'dist/index.js'));
  const s = adapter.getSummary();
  equal(s.characterCount, 0);
  equal(s.jailbreakLoaded, false);
});

// ── Summary ───────────────────────────────────────
console.log('\n' + '='.repeat(40));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  console.log('\x1b[31m❌ Some tests failed\x1b[0m');
  process.exit(1);
}
console.log('\x1b[32m✅ All ' + passed + ' smoke tests passed\x1b[0m');
}

runAll().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

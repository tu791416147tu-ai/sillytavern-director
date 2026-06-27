# QA Session — 酒馆导演插件 v2.0.0 审查报告

审查时间：2026-06-27
审查范围：全部 TypeScript 源码、HTML 模板、构建产物

---

## 严重 (2)

### #1 `tavernLiveLoader.watch()` — 状态竞争导致 onChange 永远不触发

**文件:** `src/adapters/tavernLiveLoader.ts:236-248`
**影响:** `watch()` 和 `startLiveMode()` 完全失效。轮询在跑但永远不会通知变更。

**原因:**
```
const current = this.read();    // read() 内部把 this.lastSnapshot = current
const prev = this.lastSnapshot; // prev === current（同一个对象引用）
if (!prev || this.hasChanged(prev, current)) // 永远为 false
```

`read()` 在第 211 行把 `this.lastSnapshot = raw`。轮询里先调 `read()`（写 lastSnapshot），再取 `prev = this.lastSnapshot`，拿到的是刚写的同一个对象。`hasChanged` 比较同一个对象总是 false。

**修复:** 颠倒顺序——先取 `prev`，再调 `read()`：
```
const prev = this.lastSnapshot;
const current = this.read();
```

---

### #2 `promptAssembler.trimPromptToLimit()` — chat 超限时 break 丢弃了指令段

**文件:** `src/role-engine/promptAssembler.ts:280-298`
**影响:** 长对话超出 token 限制时，模型收不到任何任务指令，生成质量崩溃。

**原因:** 第 292 行 `break` 退出整个 section 循环，导致后面的 instruction 段（告诉模型"现在你要做什么"）和 output format 段（告诉模型"输出什么格式"）全部被丢弃。

**修复:** `break` → `continue`，且 instruction/output-format 段应强制追加（标为 must-keep）。

---

## 高 (3)

### #3 `scorer.sortSelectedRoles('round-robin')` — 实现的是字母排序，不是轮流

**文件:** `src/director/scorer.ts:131-132`
**影响:** 用户选了"全员轮流"，实际效果跟角色名拼音排序一样。名字以 A 开头的角色永远先说话。

**原因:** `.sort((a, b) => a.localeCompare(b))` 是静态排序。真正的 round-robin 需要记录每轮从哪个位置开始，下一轮旋转。

**修复:** 从 session/plan 上持久化一个旋转计数器，取 `(counter % selected.length)` 作为起始索引。

---

### #4 `writer.writeReport()` — 顺序模式下失败消息 turnIndex 冲突

**文件:** `src/role-engine/writer.ts:157-190`
**影响:** 失败消息和前面的成功消息共享同一个 turnIndex，消息排序错乱。

**原因:** 顺序模式成功消息用 `baseTurnIndex + i`（i 是成功序号），失败消息全用 `baseTurnIndex`。若任务 [A(成功), B(失败), C(成功)]，A 和 B 都是 `baseTurnIndex`。

**修复:** 失败消息用实际输出数组位置作为 turnIndex 偏移。

---

### #5 `writer.ts` + `bootstrap.ts` — 失败消息的 `is_system` 标志不正确

**文件:** `src/role-engine/writer.ts:183` + `src/bootstrap.ts:121`
**影响:** 系统失败通知在 ST 里被当作角色消息渲染，可能格式错乱。

**原因:**
- writer.ts: 失败消息 `isDirectorMessage: false`、`role: 'system'`
- bootstrap.ts: `is_system: msg.isDirectorMessage` → 失败消息 is_system=false

**修复:** bootstrap.ts 里判断条件改为 `msg.isDirectorMessage || msg.role === 'system'`

---

## 中 (6)

### #6 `bootstrap.ts` — `autoStart` 使用空回调，轮询白跑

**文件:** `src/bootstrap.ts:385-395`
**影响:** 启用 autoStart 时 CPU 空转，不做任何事。

---

### #7 `bootstrap.ts` — `enrichSession()` 直接修改适配器缓存的 session

**文件:** `src/bootstrap.ts:173-203`
**影响:** 调用 `fullAuto` 后再读 `adapter.getCurrentSession()`，拿到的 session.settings 已被持久化配置污染，下次读取会把持久化配置当作实时数据。

**修复:** `enrichSession` 先做浅拷贝再修改。

---

### #8 `settingsStore.getRaw()` — 返回可变引用但类型标为 Readonly

**文件:** `src/store/settingsStore.ts:243-245`
**影响:** TypeScript 骗过了，但运行时可以直接改内部 settings 绕过 save/notify。

**修复:** 返回深层拷贝，或用 `Object.freeze`。

---

### #9 `bootstrap.ts` — settingsStore 订阅在 onUnload 时未取消

**文件:** `src/bootstrap.ts:166-168`
**影响:** 插件卸载再加载导致监听器泄漏，旧 engine 实例仍被更新。

---

### #10 `executor.ts` — `executeSequential`/`executeParallel` 内部的跳过守卫是死代码

**文件:** `src/role-engine/executor.ts:124-126, 153-155`
**影响:** `validTasks` 已经在第 97 行过滤掉了 skipped。内部再检查永远不会命中。

---

### #11 `director/facade.ts` — 预选世界书为空时不回退到全局选择

**文件:** `src/director/facade.ts:128-131`
**影响:** 被选中的世界书条目如果不匹配某个角色，该角色就拿不到世界书，即使全局有很多相关条目。

---

## 低 (6)

### #12 `modelRouter.route()` 直接走降级链时不检查自动降级

**文件:** `src/role-engine/modelRouter.ts:96-99`

### #13 `modelRouter.getFallbackForRetry()` 有冗余的回退代码块

**文件:** `src/role-engine/modelRouter.ts:122-128`

### #14 `promptAssembler.buildWorldBookSection()` — 一个长条目卡住所有后续条目

**文件:** `src/role-engine/promptAssembler.ts:207-210`

### #15 `scorer.pickSelectedRoles()` — maxRoles=0 时仍强制选至少 1 个

**文件:** `src/director/scorer.ts:125`

### #16 `executor.ts` — `callWithTimeout` 无法真正中断底层请求

**文件:** `src/role-engine/executor.ts:240-245`

### #17 `writer.notifyUI()` — 分派的事件没有监听器

**文件:** `src/role-engine/writer.ts:202-223`

### #18 `shell.html` — 按钮仍调用旧版 prompt() 而非新的 selectSpeakers

**文件:** `plugin/shell.html:556`

### #19 `tavernLiveLoader.readJailbreak()` — 接受 _ctx 参数但从未使用

**文件:** `src/adapters/tavernLiveLoader.ts:356-372`

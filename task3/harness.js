#!/usr/bin/env node
/*
 * Task 3 harness: property-based testing of one function per TypeScript file with fast-check.
 *
 * Usage:
 *   node task3/harness.js --repo-dir <dir> --repo-name <name> --out <results.jsonl>
 *                         [--num-runs 100] [--start 0] [--call-timeout 2000]
 *
 * For every TypeScript file in the repository (sorted, same exclusions as Task 2), the harness:
 *   1. parses the file with the TypeScript compiler API and picks one target function
 *      (exported functions first, then other top-level functions, then class methods),
 *   2. loads the file through a require hook that transpiles TypeScript on the fly and
 *      replaces `vscode` and any module that cannot be resolved with a permissive stub,
 *   3. builds a fast-check arbitrary for every parameter from its declared type, and
 *   4. checks the generic property "for inputs of the declared types the function does not
 *      crash with a runtime error (TypeError, RangeError, ReferenceError, stack overflow), does
 *      not hang, and returns a value of its declared primitive return type".
 *
 * One JSON line is written per file. A {"event":"start"} line is written before each file is
 * loaded, so the Python driver can tell which file a hung process was working on.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const fc = require('fast-check');

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const out = { numRuns: 100, start: 0, callTimeout: 2000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--repo-dir') { out.repoDir = path.resolve(v); i++; }
    else if (k === '--repo-name') { out.repoName = v; i++; }
    else if (k === '--out') { out.out = v; i++; }
    else if (k === '--num-runs') { out.numRuns = parseInt(v, 10); i++; }
    else if (k === '--start') { out.start = parseInt(v, 10); i++; }
    else if (k === '--call-timeout') { out.callTimeout = parseInt(v, 10); i++; }
    else if (k === '--list-files') { out.listFiles = true; }
  }
  if (!out.repoDir) throw new Error('--repo-dir is required');
  out.repoName = out.repoName || path.basename(out.repoDir);
  return out;
}

// ---------------------------------------------------------------- file discovery
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.vscode-test', 'coverage']);
const TS_EXT = /\.(ts|tsx|mts|cts)$/;

function listTsFiles(root) {
  const files = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.isFile() && TS_EXT.test(e.name) && !/\.d\.(ts|mts|cts)$/.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  })(root);
  return files.sort();
}

// ---------------------------------------------------------------- stub module
// A callable, constructible proxy that absorbs any property access or call. It stands in for
// `vscode`, for packages that are not installed, and for values of interface types.
const STUB_TAG = Symbol('fcStub');
let stubCalls = 0;
function makeStub(name) {
  const cache = new Map();
  const target = function () {};
  const handler = {
    get(_t, prop) {
      if (prop === STUB_TAG) return true;
      if (prop === 'then') return undefined; // never look like a Promise
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.asyncIterator) return async function* () {};
      if (prop === 'toString' || prop === 'toJSON' || prop === 'valueOf') return () => '';
      if (prop === '__esModule') return true; // so __importStar/__importDefault pass the stub through
      if (prop === 'prototype') return {};
      if (prop === 'length') return 0;
      if (prop === 'name') return name;
      if (typeof prop === 'symbol') return undefined;
      if (!cache.has(prop)) cache.set(prop, makeStub(name + '.' + String(prop)));
      return cache.get(prop);
    },
    set() { return true; },
    has() { return true; },
    apply() { stubCalls++; return makeStub(name + '()'); },
    construct() { return makeStub('new ' + name); },
    getPrototypeOf() { return Object.prototype; },
  };
  return new Proxy(target, handler);
}
const isStub = (v) => { try { return !!(v && v[STUB_TAG]); } catch { return false; } };

// ---------------------------------------------------------------- module loading
const STUB_PREFIX = '\0fcstub:';
const stubCache = new Map();
const origResolve = Module._resolveFilename;
const origLoad = Module._load;

Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return STUB_PREFIX + request;
  try {
    return origResolve.call(this, request, parent, ...rest);
  } catch (err) {
    // Relative import of a TS file written without extension is handled by the
    // require.extensions hooks below; anything else that does not resolve is stubbed.
    if (request.startsWith('.') && parent && parent.filename) {
      const base = path.resolve(path.dirname(parent.filename), request);
      for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '.mts', '.cts']) {
        if (fs.existsSync(base + ext)) return base + ext;
      }
    }
    return STUB_PREFIX + request;
  }
};

Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); } catch { return STUB_PREFIX + request; }
  })();
  if (resolved.startsWith(STUB_PREFIX)) {
    const n = resolved.slice(STUB_PREFIX.length);
    if (!stubCache.has(n)) stubCache.set(n, makeStub(n));
    return stubCache.get(n);
  }
  // Non-code assets (css, html, svg, ...) are replaced by a stub too.
  if (!/\.(js|cjs|mjs|json|node|ts|tsx|mts|cts)$/.test(resolved) && path.isAbsolute(resolved) && path.extname(resolved)) {
    return makeStub(request);
  }
  return origLoad.apply(this, arguments);
};

// Extra source appended to the target file so non-exported functions can be reached.
const appendixByFile = new Map();

function compileTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const out = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: false,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: false,
      allowJs: true,
    },
  }).outputText;
  const appendix = appendixByFile.get(filename) || '';
  module._compile(out + '\n' + appendix, filename);
}
for (const ext of ['.ts', '.tsx', '.mts', '.cts']) require.extensions[ext] = compileTs;

// Globals that test files and webviews expect at load time.
for (const g of ['suite', 'test', 'describe', 'it', 'before', 'after', 'beforeEach', 'afterEach',
  'setup', 'teardown', 'suiteSetup', 'suiteTeardown', 'jest', 'expect', 'acquireVsCodeApi']) {
  if (!(g in globalThis)) globalThis[g] = makeStub(g);
}
for (const g of ['window', 'document', 'navigator', 'self']) {
  if (!(g in globalThis)) globalThis[g] = makeStub(g);
}

// Protect the harness from code under test: silence its console output.
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) console[k] = () => {};
const realExit = process.exit.bind(process);
process.exit = (code) => { throw new Error(`process.exit(${code}) called by code under test`); };
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

// ---------------------------------------------------------------- target selection
function paramInfo(p, sf) {
  const name = p.name.getText(sf);
  return {
    name,
    type: p.type ? p.type.getText(sf).replace(/\s+/g, ' ') : null,
    typeNode: p.type || null,
    optional: !!p.questionToken || !!p.initializer,
    rest: !!p.dotDotDotToken,
    hasDefault: !!p.initializer,
  };
}

function isExported(node) {
  const mods = ts.canHaveModifiers && ts.canHaveModifiers(node) ? ts.getModifiers(node) : node.modifiers;
  return !!(mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}
function hasModifier(node, kind) {
  const mods = ts.canHaveModifiers && ts.canHaveModifiers(node) ? ts.getModifiers(node) : node.modifiers;
  return !!(mods && mods.some((m) => m.kind === kind));
}

const SIMPLE_TYPES = /^(string|number|boolean|bigint|string\[\]|number\[\]|boolean\[\]|Array<string>|Array<number>|'[^']*'( \| '[^']*')*|"[^"]*"( \| "[^"]*")*)$/;

function collectCandidates(sf) {
  const cands = [];
  const add = (c) => {
    const typed = c.params.filter((p) => p.type).length;
    const simple = c.params.filter((p) => p.type && SIMPLE_TYPES.test(p.type)).length;
    // Prefer: exported, top-level, has parameters, simple typed parameters, not async.
    c.score = (c.exported ? 100 : 0) + (c.kind === 'function' ? 40 : c.kind === 'static' ? 30 : 10)
      + (c.params.length > 0 ? 20 : 0) + simple * 8 + typed * 3 - (c.async ? 5 : 0)
      - Math.max(0, c.params.length - 4) * 5;
    cands.push(c);
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      add({ kind: 'function', name: st.name.text, access: st.name.text, exported: isExported(st),
        params: st.parameters.map((p) => paramInfo(p, sf)), returnType: st.type ? st.type.getText(sf) : null,
        async: hasModifier(st, ts.SyntaxKind.AsyncKeyword), line: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1 });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          add({ kind: 'function', name: d.name.text, access: d.name.text, exported: isExported(st),
            params: init.parameters.map((p) => paramInfo(p, sf)), returnType: init.type ? init.type.getText(sf) : null,
            async: hasModifier(init, ts.SyntaxKind.AsyncKeyword), line: sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1 });
        }
      }
    } else if (ts.isClassDeclaration(st) && st.name) {
      const cls = st.name.text;
      const ctor = st.members.find((m) => ts.isConstructorDeclaration(m));
      const ctorParams = ctor ? ctor.parameters.map((p) => paramInfo(p, sf)) : [];
      for (const m of st.members) {
        if (!ts.isMethodDeclaration(m) || !m.body || !m.name || !ts.isIdentifier(m.name)) continue;
        if (hasModifier(m, ts.SyntaxKind.PrivateKeyword) || hasModifier(m, ts.SyntaxKind.AbstractKeyword)) continue;
        const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword);
        add({ kind: isStatic ? 'static' : 'method', name: `${cls}.${m.name.text}`, className: cls,
          methodName: m.name.text, access: cls, exported: isExported(st), ctorParams,
          params: m.parameters.map((p) => paramInfo(p, sf)), returnType: m.type ? m.type.getText(sf) : null,
          async: hasModifier(m, ts.SyntaxKind.AsyncKeyword), line: sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1 });
      }
    }
  }
  return cands.sort((a, b) => b.score - a.score || a.line - b.line);
}

// ---------------------------------------------------------------- arbitraries from types
const anyValue = () => fc.oneof(
  fc.string(), fc.integer(), fc.double(), fc.boolean(), fc.constant(null), fc.constant(undefined),
  fc.array(fc.string(), { maxLength: 5 }), fc.dictionary(fc.string({ maxLength: 8 }), fc.string(), { maxKeys: 4 })
);

function arbForTypeNode(node, sf, depth = 0) {
  if (!node || depth > 4) return { arb: anyValue(), desc: 'any' };
  const K = ts.SyntaxKind;
  switch (node.kind) {
    case K.StringKeyword: return { arb: fc.string(), desc: 'string' };
    case K.NumberKeyword: return { arb: fc.oneof(fc.integer(), fc.double({ noNaN: false })), desc: 'number' };
    case K.BooleanKeyword: return { arb: fc.boolean(), desc: 'boolean' };
    case K.BigIntKeyword: return { arb: fc.bigInt(), desc: 'bigint' };
    case K.NullKeyword: return { arb: fc.constant(null), desc: 'null' };
    case K.UndefinedKeyword: case K.VoidKeyword: return { arb: fc.constant(undefined), desc: 'undefined' };
    case K.AnyKeyword: case K.UnknownKeyword: case K.ObjectKeyword: return { arb: anyValue(), desc: 'any' };
    case K.ParenthesizedType: return arbForTypeNode(node.type, sf, depth + 1);
    case K.LiteralType: {
      const l = node.literal;
      if (ts.isStringLiteral(l)) return { arb: fc.constant(l.text), desc: 'literal' };
      if (ts.isNumericLiteral(l)) return { arb: fc.constant(Number(l.text)), desc: 'literal' };
      if (l.kind === K.TrueKeyword) return { arb: fc.constant(true), desc: 'literal' };
      if (l.kind === K.FalseKeyword) return { arb: fc.constant(false), desc: 'literal' };
      if (l.kind === K.NullKeyword) return { arb: fc.constant(null), desc: 'null' };
      return { arb: anyValue(), desc: 'any' };
    }
    case K.UnionType: {
      const parts = node.types.map((t) => arbForTypeNode(t, sf, depth + 1));
      return { arb: fc.oneof(...parts.map((p) => p.arb)), desc: 'union' };
    }
    case K.ArrayType: {
      const el = arbForTypeNode(node.elementType, sf, depth + 1);
      return { arb: fc.array(el.arb, { maxLength: 8 }), desc: 'array' };
    }
    case K.TupleType: {
      const els = node.elements.map((e) => arbForTypeNode(ts.isNamedTupleMember(e) ? e.type : e, sf, depth + 1).arb);
      return { arb: fc.tuple(...els), desc: 'tuple' };
    }
    case K.TypeLiteral: {
      const rec = {};
      const required = [];
      for (const m of node.members) {
        if (ts.isPropertySignature(m) && m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
          const key = m.name.text;
          rec[key] = arbForTypeNode(m.type, sf, depth + 1).arb;
          if (!m.questionToken) required.push(key);
        }
      }
      return { arb: fc.record(rec, { requiredKeys: required }), desc: 'object' };
    }
    case K.FunctionType: return { arb: fc.constant(() => undefined), desc: 'function' };
    case K.TypeReference: {
      const n = node.typeName.getText(sf);
      const args = node.typeArguments || [];
      if ((n === 'Array' || n === 'ReadonlyArray') && args[0]) {
        return { arb: fc.array(arbForTypeNode(args[0], sf, depth + 1).arb, { maxLength: 8 }), desc: 'array' };
      }
      if (n === 'Promise' && args[0]) {
        const inner = arbForTypeNode(args[0], sf, depth + 1).arb;
        return { arb: inner.map((v) => Promise.resolve(v)), desc: 'promise' };
      }
      if ((n === 'Record' || n === 'Map') && args[1]) {
        const v = arbForTypeNode(args[1], sf, depth + 1).arb;
        const d = fc.dictionary(fc.string({ maxLength: 8 }), v, { maxKeys: 5 });
        return { arb: n === 'Map' ? d.map((o) => new Map(Object.entries(o))) : d, desc: 'record' };
      }
      if (n === 'Set' && args[0]) {
        return { arb: fc.array(arbForTypeNode(args[0], sf, depth + 1).arb, { maxLength: 5 }).map((a) => new Set(a)), desc: 'set' };
      }
      if (n === 'Date') return { arb: fc.date(), desc: 'Date' };
      if (n === 'RegExp') return { arb: fc.constantFrom(/a/, /.*/g, /^x$/i), desc: 'RegExp' };
      if (n === 'Buffer') return { arb: fc.uint8Array({ maxLength: 16 }).map((a) => Buffer.from(a)), desc: 'Buffer' };
      if (n === 'Function') return { arb: fc.constant(() => undefined), desc: 'function' };
      // Interfaces, classes and vscode types: a permissive stub object.
      return { arb: fc.constant(null).map(() => makeStub(n)), desc: 'stub' };
    }
    default:
      return { arb: anyValue(), desc: 'any' };
  }
}

const TIME_PARAM = /(^ms$|millis|delay|timeout|wait|interval|duration|debounce|sleep|^time$)/i;

function paramArb(p, sf) {
  let base = p.typeNode ? arbForTypeNode(p.typeNode, sf) : { arb: anyValue(), desc: 'untyped' };
  // A time parameter makes the call wait that long; huge values are not a defect, so keep them short.
  if (TIME_PARAM.test(p.name) && (!p.type || p.type === 'number')) base = { arb: fc.integer({ min: 0, max: 200 }), desc: 'time' };
  let arb = base.arb;
  if (p.rest) arb = fc.array(arb, { maxLength: 4 });
  else if (p.optional) arb = fc.option(arb, { nil: undefined });
  return { arb, desc: base.desc };
}

// ---------------------------------------------------------------- formatting helpers
function show(v, max = 200) {
  let s;
  try {
    if (isStub(v)) s = '<stub>';
    else if (typeof v === 'function') s = '<function>';
    else s = fc.stringify(v);
  } catch { s = String(v); }
  s = s.replace(/[\r\n]+/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}
const firstLine = (s) => String(s || '').split(/\r?\n/)[0].slice(0, 300);

// ---------------------------------------------------------------- property oracle
class PropertyViolation extends Error {
  constructor(category, message, provided) { super(message); this.category = category; this.provided = provided; }
}

function primitiveReturn(rt) {
  if (!rt) return null;
  let t = rt.replace(/\s+/g, '');
  const m = /^Promise<(.+)>$/.exec(t);
  if (m) t = m[1];
  return ['string', 'number', 'boolean'].includes(t) ? t : null;
}

function classifyError(err) {
  if (err instanceof PropertyViolation) return err.category;
  const msg = String(err && err.message || err);
  if (err instanceof RangeError && /call stack/i.test(msg)) return 'Stack overflow (unbounded recursion)';
  if (err instanceof TypeError) {
    if (/undefined|null/i.test(msg)) return 'Null/undefined dereference (TypeError)';
    if (/is not a function|is not iterable|is not a constructor/i.test(msg)) return 'Unexpected input shape (TypeError)';
    return 'TypeError';
  }
  if (err instanceof RangeError) return 'Invalid range (RangeError)';
  if (err instanceof ReferenceError) return 'ReferenceError';
  if (err instanceof SyntaxError) return 'Parse error on input (SyntaxError)';
  return 'Unhandled exception';
}

// Errors caused by the stubbed environment rather than by the code: a stub passed to a Node API
// ("Received function vscode.window..."), a stubbed API result used as a Promise, etc.
function causedByStub(err) {
  const msg = String(err && err.message || '');
  if (/Received function |\(\.\.\.\)\.then is not a function|<stub>/.test(msg)) return true;
  for (const n of stubCache.keys()) if (n && msg.includes(n + '.')) return true;
  return false;
}

// Deliberate validation errors (plain Error with a message) are allowed; runtime errors are defects.
function isDefect(err) {
  if (err && err.environment) return false;
  if (err instanceof PropertyViolation) return true;
  if (causedByStub(err)) return false;
  return err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError
    || err instanceof SyntaxError || err instanceof URIError || err instanceof EvalError;
}

function withTimeout(p, ms) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new PropertyViolation('Hang/timeout (async)', `call did not settle within ${ms} ms`, '<pending>')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- testing one file
async function testFile(file, opts) {
  const rel = path.relative(opts.repoDir, file);
  const base = { repo: opts.repoName, file: path.join(opts.repoName, rel), absPath: file };

  let sf;
  try {
    sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  } catch (e) {
    return { ...base, skipped: true, reason: 'could not parse: ' + firstLine(e.message) };
  }
  const cands = collectCandidates(sf);
  if (cands.length === 0) return { ...base, skipped: true, reason: 'no function with a body in this file' };

  // Make every candidate reachable, exported or not.
  const lines = [];
  for (const c of cands) {
    lines.push(`try { exports[${JSON.stringify('__fc_' + c.access)}] = ${c.access}; } catch (e) {}`);
  }
  appendixByFile.set(file, [...new Set(lines)].join('\n'));

  let mod;
  try {
    // Another file may already have loaded this one without the appendix: load it fresh.
    delete require.cache[file];
    mod = require(file);
  } catch (e) {
    return { ...base, skipped: true, reason: 'module failed to load: ' + firstLine(e && e.message) };
  }

  let target = null;
  for (const c of cands) {
    const ref = mod && mod['__fc_' + c.access];
    if (!ref) continue;
    if (c.kind === 'function' && typeof ref === 'function') { target = { c, fn: ref, self: undefined }; break; }
    if (c.kind === 'static' && typeof ref[c.methodName] === 'function') { target = { c, fn: ref[c.methodName], self: ref }; break; }
    if (c.kind === 'method' && ref.prototype && typeof ref.prototype[c.methodName] === 'function') {
      target = { c, fn: ref.prototype[c.methodName], cls: ref }; break;
    }
  }
  if (!target) {
    let keys = [];
    try { keys = Object.keys(mod || {}).slice(0, 8); } catch {}
    return { ...base, skipped: true, reason: 'no candidate function was reachable after loading (exports: ' + keys.join(', ') + ')' };
  }

  const { c } = target;
  const params = c.params.map((p) => ({ ...p, ...paramArb(p, sf) }));
  const ctorArbs = (c.ctorParams || []).map((p) => paramArb(p, sf).arb);
  const retPrim = primitiveReturn(c.returnType);
  const expected = 'completes without a runtime error (TypeError/RangeError/ReferenceError/stack overflow) or hang'
    + (retPrim ? ` and returns a ${retPrim}` : '');

  let sampleReturn;
  const runOnce = async (ctorArgs, args) => {
    let self = target.self;
    if (target.cls) {
      try { self = new target.cls(...ctorArgs); } catch { self = Object.create(target.cls.prototype); }
    }
    const callsBefore = stubCalls;
    let ret = target.fn.apply(self, args);
    if (ret && typeof ret.then === 'function' && !isStub(ret)) {
      try {
        ret = await withTimeout(ret, opts.callTimeout);
      } catch (e) {
        // A promise that waits on a stubbed callback (which never fires) is an environment limit.
        if (e instanceof PropertyViolation && stubCalls > callsBefore) e.environment = true;
        throw e;
      }
    }
    if (isStub(ret)) { sampleReturn = ret; return; }
    if (retPrim) {
      const ok = typeof ret === retPrim && !(retPrim === 'number' && Number.isNaN(ret));
      if (!ok) throw new PropertyViolation('Wrong return type/value', `expected ${retPrim}, got ${Number.isNaN(ret) ? 'NaN' : typeof ret}`, show(ret));
    }
    sampleReturn = ret;
  };

  const argsArb = params.length ? fc.tuple(...params.map((p) => p.arb)) : fc.constant([]);
  const ctorArb = ctorArbs.length ? fc.tuple(...ctorArbs) : fc.constant([]);
  const prop = fc.asyncProperty(ctorArb, argsArb, async (ctorArgs, args) => {
    try {
      await runOnce(ctorArgs, args);
    } catch (err) {
      if (isDefect(err)) throw err;
      // Deliberate errors and rejections are acceptable behaviour.
    }
  });

  const started = Date.now();
  const res = await fc.check(prop, { numRuns: c.params.length ? opts.numRuns : 1, endOnFailure: true, seed: 42 });
  const result = {
    ...base,
    skipped: false,
    testCase: `fc_${c.name.replace(/[^\w.]/g, '_')}_no_runtime_error`,
    functionName: c.name,
    line: c.line,
    exported: c.exported,
    expected,
    params: params.map((p) => ({ name: p.name, type: p.type || 'untyped', rest: p.rest, optional: p.optional })),
    numRuns: res.numRuns,
    seconds: (Date.now() - started) / 1000,
  };
  if (!res.failed) {
    return { ...result, status: 'Passed', provided: show(sampleReturn), error: '', category: '', counterexample: null };
  }
  const err = res.errorInstance;
  const cex = res.counterexample ? res.counterexample[1] : [];
  return {
    ...result,
    status: 'Failed',
    provided: err instanceof PropertyViolation ? err.provided : `threw ${err && err.name}`,
    error: firstLine(err && err.message || err),
    category: classifyError(err),
    counterexample: params.map((p, i) => show(cex[i])),
  };
}

// ---------------------------------------------------------------- main
async function main() {
  const opts = parseArgs(process.argv);
  const files = listTsFiles(opts.repoDir);
  if (opts.listFiles) { process.stdout.write(files.length + '\n'); realExit(0); }
  const outFd = opts.out ? fs.openSync(opts.out, 'a') : 1;
  const write = (obj) => fs.writeSync(outFd, JSON.stringify(obj) + '\n');

  for (let i = opts.start; i < files.length; i++) {
    const rel = path.join(opts.repoName, path.relative(opts.repoDir, files[i]));
    write({ event: 'start', index: i, total: files.length, file: rel });
    let r;
    try {
      r = await testFile(files[i], opts);
    } catch (e) {
      r = { repo: opts.repoName, file: rel, skipped: true, reason: 'harness error: ' + firstLine(e && e.message) };
    }
    write({ event: 'result', index: i, ...r });
  }
  write({ event: 'done', total: files.length });
  realExit(0);
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); realExit(1); });

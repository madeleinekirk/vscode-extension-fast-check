// load ts files outside of vscode

const fs = require('fs');
const Module = require('module');
const ts = require('typescript');
const fc = require('fast-check');

// fake object for vscode and missing packages
const stubs = new WeakSet();
const stubbedModules = new Set();
function stub(name) {
  const s = new Proxy(function () {}, {
    get(target, key) {
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toPrimitive || key === 'toString' || key === 'valueOf') return () => '';
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (key === '__esModule') return true;
      return stub(name + '.' + key);
    },
    set: () => true,
    apply: () => stub(name + '()'),
    construct: () => stub(name),
  });
  stubs.add(s);
  return s;
}

// don't let tested code write files or run commands
const changesFiles = /^(write|append|mkdir|rm|unlink|rename|copy|cp|symlink|link|chmod|chown|truncate|utimes|createWriteStream)/;
const safeFs = { ...fs, promises: { ...fs.promises } };
for (const key of Object.keys(fs)) {
  if (changesFiles.test(key)) {
    safeFs[key] = (...args) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null);
      return stub('fs.' + key);
    };
  }
}
for (const key of Object.keys(fs.promises)) {
  if (changesFiles.test(key)) safeFs.promises[key] = async () => undefined;
}

const realLoad = Module._load;
Module._load = function (request) {
  const name = request.replace(/^node:/, '');
  if (name === 'fs') return safeFs;
  if (name === 'fs/promises') return safeFs.promises;
  if (name === 'vscode' || name === 'child_process' || /\.(css|scss|less|svg|png|html)$/.test(name)) {
    stubbedModules.add(name);
    return stub(name);
  }
  try {
    return realLoad.apply(this, arguments);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    stubbedModules.add(name);
    return stub(name);
  }
};

// compile .ts files on require
let target = null;
let extraCode = '';
require.extensions['.ts'] = require.extensions['.tsx'] = (module, filename) => {
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
      experimentalDecorators: true, jsx: ts.JsxEmit.React },
  }).outputText;
  module._compile(filename === target ? js + extraCode : js, filename);
};

const exit = process.exit.bind(process);
process.exit = (code) => { throw new Error(`process.exit(${code}) called`); };
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const K = ts.SyntaxKind;
const has = (node, kind) => (node.modifiers || []).some((m) => m.kind === kind);

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function findFunctions(source) {
  const funcs = [];
  for (const s of source.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && s.body) {
      funcs.push({ name: s.name.text, ref: s.name.text, node: s });
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          funcs.push({ name: d.name.text, ref: d.name.text, node: d.initializer });
        }
      }
    } else if (ts.isClassDeclaration(s) && s.name) {
      for (const m of s.members) {
        if (ts.isMethodDeclaration(m) && m.body && ts.isIdentifier(m.name) && !has(m, K.PrivateKeyword)) {
          funcs.push({ name: `${s.name.text}.${m.name.text}`, ref: s.name.text, method: m.name.text,
            isStatic: has(m, K.StaticKeyword), node: m });
        }
      }
    }
  }
  return funcs;
}

// export every function too so non-exported ones can be called
function loadFile(file, funcs) {
  target = file;
  extraCode = '\n' + [...new Set(funcs.map((f) => f.ref))]
    .map((ref) => `try { exports.__fc_${ref} = ${ref}; } catch (e) {}`).join('\n');
  delete require.cache[file];
  return require(file);
}

function getCallable(mod, f) {
  const value = mod['__fc_' + f.ref];
  if (!value) return null;
  if (!f.method) return typeof value === 'function' ? { fn: value, self: undefined } : null;
  if (f.isStatic) return typeof value[f.method] === 'function' ? { fn: value[f.method], self: value } : null;
  if (!value.prototype || typeof value.prototype[f.method] !== 'function') return null;
  let self;
  try { self = new value(); } catch (e) { self = Object.create(value.prototype); }
  return { fn: self[f.method], self };
}

// random inputs based on the parameter type
function arb(t) {
  if (!t) return fc.anything();
  switch (t.kind) {
    case K.StringKeyword: return fc.string();
    case K.NumberKeyword: return fc.oneof(fc.integer(), fc.double());
    case K.BooleanKeyword: return fc.boolean();
    case K.NullKeyword: return fc.constant(null);
    case K.UndefinedKeyword: return fc.constant(undefined);
    case K.ParenthesizedType: return arb(t.type);
    case K.ArrayType: return fc.array(arb(t.elementType), { maxLength: 5 });
    case K.UnionType: return fc.oneof(...t.types.map(arb));
    case K.FunctionType: return fc.constant(() => {});
    case K.LiteralType:
      if (t.literal.kind === K.TrueKeyword) return fc.constant(true);
      if (t.literal.kind === K.FalseKeyword) return fc.constant(false);
      if (t.literal.kind === K.NullKeyword) return fc.constant(null);
      return fc.constant(ts.isNumericLiteral(t.literal) ? Number(t.literal.text) : t.literal.text);
    case K.TypeLiteral: {
      const fields = {};
      for (const m of t.members) if (m.name && m.type) fields[m.name.getText()] = arb(m.type);
      return fc.record(fields, { requiredKeys: [] });
    }
    case K.TypeReference: {
      const name = t.typeName.getText();
      if (name === 'Array' && t.typeArguments) return fc.array(arb(t.typeArguments[0]), { maxLength: 5 });
      return fc.constant(stub(name)); // interfaces, classes, vscode types
    }
    default: return fc.anything();
  }
}

function paramArbs(node) {
  return node.parameters.map((p) => {
    const name = p.name.getText();
    const type = p.type ? p.type.getText() : 'any';
    // keep time values small, waiting a long time isn't a bug
    let a = /delay|timeout|wait|interval|^ms$/i.test(name) && type === 'number' ? fc.integer({ min: 0, max: 200 }) : arb(p.type);
    if (p.dotDotDotToken) a = fc.array(a, { maxLength: 3 });
    else if (p.questionToken || p.initializer) a = fc.option(a, { nil: undefined });
    return { name, type, arb: a, rest: !!p.dotDotDotToken };
  });
}

const spread = (params, args) => params.flatMap((p, i) => (p.rest ? args[i] : [args[i]]));

// runtime errors count as bugs, but not errors thrown on purpose or caused by a fake object
function isBug(e) {
  if (!(e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError)) return false;
  const msg = String(e.message);
  if (/Received function |\)\.then is not a function/.test(msg)) return false;
  return ![...stubbedModules].some((m) => msg.includes(m + '.'));
}

function show(v) {
  if (stubs.has(v)) return '<vscode object>';
  if (typeof v === 'function') return '<function>';
  try { return fc.stringify(v).slice(0, 200); } catch (e) { return String(v); }
}

module.exports = { fc, parse, findFunctions, loadFile, getCallable, paramArbs, spread, isBug, show, exit };

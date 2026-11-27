// Loads a TypeScript file outside VS Code.

const fs = require('fs');
const Module = require('module');
const ts = require('typescript');

// Stand-in for vscode and for packages that are not installed
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

// Code under test must not change files or run commands
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

// Compile .ts files when they are required
require.extensions['.ts'] = require.extensions['.tsx'] = (module, filename) => {
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
      experimentalDecorators: true, jsx: ts.JsxEmit.React },
  }).outputText;
  module._compile(js, filename);
};

for (const name of ['suite', 'test', 'describe', 'it', 'before', 'after', 'beforeEach', 'afterEach',
  'setup', 'teardown', 'window', 'document', 'acquireVsCodeApi']) {
  if (!(name in global)) global[name] = stub(name);
}
for (const key of ['log', 'info', 'warn', 'error', 'debug']) console[key] = () => {};
const exit = process.exit.bind(process);
process.exit = (code) => { throw new Error(`process.exit(${code}) called`); };
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

function loadFile(file) {
  delete require.cache[file];
  return require(file);
}

module.exports = { ts, stub, stubs, stubbedModules, loadFile, exit };

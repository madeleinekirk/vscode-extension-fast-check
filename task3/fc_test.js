// test one function in a ts file with fast-check
// usage: node task3/fc_test.js <file.ts> [numRuns]

const path = require('path');
const { fc, findFunctions, loadFile, getCallable, paramArbs, spread, isBug, show, parse, exit } =
  require('../common/ts_loader');

const file = path.resolve(process.argv[2]);
const numRuns = Number(process.argv[3] || 100);
const print = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const funcs = findFunctions(parse(file));
if (funcs.length === 0) { print({ skip: 'no function in file' }); exit(0); }

// target functions we can make inputs for first (string, number or boolean params)
const fuzzable = (f) => f.node.parameters.some((p) => p.type && /^(string|number|boolean)$/.test(p.type.getText()));
funcs.sort((a, b) => fuzzable(b) - fuzzable(a));

let mod;
try {
  mod = loadFile(file, funcs);
} catch (e) {
  print({ skip: 'could not load file: ' + String(e.message).split('\n')[0] });
  exit(0);
}

let target;
let callable;
for (const f of funcs) {
  callable = getCallable(mod, f);
  if (callable) { target = f; break; }
}
if (!target) { print({ skip: 'no function could be called' }); exit(0); }

const params = paramArbs(target.node);
const argsArb = fc.tuple(...params.map((p) => p.arb));
const expected = 'no runtime error or hang';
print({ function: target.name, params: params.map((p) => ({ name: p.name, type: p.type })), expected });

let lastReturn;
async function check(args) {
  let result;
  try {
    result = callable.fn.apply(callable.self, spread(params, args));
    if (result instanceof Promise) {
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject({ hang: true }), 2000); });
      result = await Promise.race([result, timeout]).finally(() => clearTimeout(timer));
    }
  } catch (e) {
    if (e && e.hang) throw Object.assign(new Error('promise did not settle within 2 s'), { hang: true });
    if (isBug(e)) throw e;
    return;
  }
  lastReturn = result;
}

function category(e) {
  if (e.hang) return 'Hang';
  if (e instanceof RangeError && /call stack/.test(e.message)) return 'Stack overflow';
  if (e instanceof TypeError && /undefined|null/.test(e.message)) return 'Null/undefined access';
  if (e instanceof SyntaxError) return 'Invalid input not handled';
  return e.name;
}

fc.check(fc.asyncProperty(argsArb, check), { numRuns: params.length ? numRuns : 1, seed: 42, endOnFailure: true }).then((r) => {
  if (!r.failed) {
    print({ status: 'Passed', provided: show(lastReturn) });
  } else {
    const e = r.errorInstance;
    print({ status: 'Failed', provided: `threw ${e.name}`,
      error: String(e.message).split('\n')[0], category: category(e), inputs: r.counterexample[0].map(show) });
  }
  exit(0);
});

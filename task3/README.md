# Task 3

```
python3 task3/run_task3.py --dataset ../yzz0229-VSCODE-DATA --jobs 4
```

This writes results/task3_results.csv. It takes about an hour.

## How it works

run_task3.py goes through every .ts and .tsx file in the runnable repos from task 2 and runs
fc_test.js on each one. It skips .d.ts files and build output. The repos' own test files are
tested too, but most of their failures happen because they need the VS Code test runner.

fc_test.js picks one function from the file. It prefers functions with a string, number or boolean
parameter. Then it loads the file with common/ts_loader.js, which replaces vscode
and any missing packages with a fake object and stops the code from writing files or running commands.

fast-check makes 100 random inputs based on the parameter types. The test fails if the function:
- throws a TypeError, RangeError, ReferenceError or SyntaxError
- doesn't finish (async calls get 2 seconds, the whole file gets 60)

Errors the code throws on purpose are fine.
Files where nothing could be tested aren't in the CSV.

## CSV columns

- FilePath: path of the file in the dataset
- TestCaseName: test_ plus the function name
- FunctionName: the function that was tested (Class.method for methods)
- Status: Passed or Failed
- ExpectedValue: what was checked
- ProvidedValue: what the function returned or threw
- ErrorMessage: first line of the error, only for failed tests
- FailureCategory: why it failed (null/undefined access, invalid input not handled, stack overflow, hang, ...)
- InputParamater: name and type of the parameter, plus the failing input for failed tests. One row per parameter.

// Entry driver for csv-reader-speed-01-run-20261121 (node22).
//
// The harness runs this file. It loads every case from $MAKEFUN_INPUT_DIR/cases.json
// (default /input), answers each one on its own through run() from solve.js, and
// writes the answers to $MAKEFUN_OUTPUT_DIR/answers.json (default /output) as a JSON
// array, one answer per case, in the cases' order. Nothing is shared between cases:
// every answer is a pure function of that case's input alone.
//
// The house baseline sets V8's --no-incremental-marking before solve.js is loaded so
// all of its work runs with incremental marking off; an entry keeps that and may also
// tune V8 further. We keep the flag and additionally give the young generation a large
// semi-space, which suits the parser's short-lived per-field strings.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--max-semi-space-size=64');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i += 1) {
  answers[i] = run(cases[i].input);
}
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));

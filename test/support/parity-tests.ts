import { readFileSync } from 'node:fs';

import ts from 'typescript';

/** How a parity test is declared: a real test, a placeholder, or switched off. */
export type ParityTestKind = 'it' | 'todo' | 'skip' | 'only';

export interface ParityTestDeclaration {
  name: string;
  kind: ParityTestKind;
}

/**
 * The titles of every `it(...)`, `it.todo(...)`, `it.skip(...)`, `it.only(...)`, `test(...)` (and
 * `xit`/`fit`) in a spec file, read from its syntax tree, with how each is declared.
 */
export function parityTestsIn(file: string): ParityTestDeclaration[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2023);
  const tests: ParityTestDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const title = node.arguments[0];
      const match = /^(it|test|xit|fit|xtest)(?:\.(\w+))?$/.exec(callee);
      if (match && title && ts.isStringLiteralLike(title)) {
        const modifier = match[2];
        let kind: ParityTestKind = 'it';
        if (modifier === 'todo') kind = 'todo';
        else if (modifier === 'skip' || match[1].startsWith('x')) kind = 'skip';
        else if (modifier === 'only' || match[1] === 'fit') kind = 'only';
        tests.push({ name: title.text, kind });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tests;
}

/** The titles only (API-100-13 coverage check). */
export function testNamesIn(file: string): string[] {
  return parityTestsIn(file).map((test) => test.name);
}

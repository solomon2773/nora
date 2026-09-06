import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

import { hasTranslation, type Locale } from "./i18n";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_PATHS = [
  "pages/remote-hosts/index.tsx",
  "pages/remote-hosts/new.tsx",
  "pages/remote-hosts/[id].tsx",
];
const USER_FACING_ATTRIBUTES = new Set([
  "aria-label",
  "caption",
  "confirmLabel",
  "description",
  "label",
  "placeholder",
  "submitLabel",
  "title",
]);
const TRANSLATED_LOCALES: Locale[] = ["es", "fr", "zh-Hans", "zh-Hant"];

function hasWords(value: string) {
  return /[A-Za-z]/.test(value);
}

test("Remote Hosts pages route visible copy through complete translations", () => {
  const allUntranslated: string[] = [];
  const allMissingTranslations: string[] = [];
  for (const relativePath of PAGE_PATHS) {
    const source = readFileSync(resolve(ROOT, relativePath), "utf8");
    const parsed = ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const untranslated: string[] = [];
    const keys = new Set<string>();

    function findRenderedLiterals(expression: ts.Expression): void {
      if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        if (expression.expression.text === "t") return;
      }
      if (ts.isStringLiteral(expression) && hasWords(expression.text)) {
        untranslated.push(expression.text);
      } else if (ts.isConditionalExpression(expression)) {
        findRenderedLiterals(expression.whenTrue);
        findRenderedLiterals(expression.whenFalse);
      } else if (ts.isParenthesizedExpression(expression)) {
        findRenderedLiterals(expression.expression);
      } else if (
        ts.isBinaryExpression(expression) &&
        [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
          expression.operatorToken.kind,
        )
      ) {
        findRenderedLiterals(expression.right);
      }
    }

    function visit(node: ts.Node, insideTranslation = false): void {
      const isTranslation =
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t";
      const translated = insideTranslation || isTranslation;

      if (isTranslation && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
        keys.add(node.arguments[0].text);
      }

      if (ts.isJsxText(node) && hasWords(node.text.trim())) {
        untranslated.push(node.text.trim());
      }

      if (
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) &&
        USER_FACING_ATTRIBUTES.has(node.name.text)
      ) {
        const attributeName = node.name.text;
        if (
          node.initializer &&
          ts.isStringLiteral(node.initializer) &&
          hasWords(node.initializer.text)
        ) {
          untranslated.push(`${attributeName}=${node.initializer.text}`);
        }
      }

      if (
        ts.isJsxExpression(node) &&
        node.expression &&
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
      ) {
        findRenderedLiterals(node.expression);
      }

      ts.forEachChild(node, (child) => visit(child, translated));
    }

    visit(parsed);
    allUntranslated.push(...untranslated.map((value) => `${relativePath}: ${value}`));
    if (keys.size === 0) allUntranslated.push(`${relativePath}: page must use t()`);

    for (const key of keys) {
      for (const locale of TRANSLATED_LOCALES) {
        if (!hasTranslation(key, locale)) {
          allMissingTranslations.push(`${relativePath}: ${locale} lacks ${key}`);
        }
      }
    }
  }
  assert.deepEqual(allUntranslated, [], "Remote Hosts pages have untranslated visible copy");
  assert.deepEqual(
    allMissingTranslations,
    [],
    "Remote Hosts translation dictionaries are incomplete",
  );
});

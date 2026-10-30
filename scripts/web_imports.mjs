// The module references in TypeScript sources, read with the installed TypeScript parser, for
// scripts/check_web_boundaries.py. Reads {path: text} as JSON on stdin; writes {path: [[line, kind, specifier]]} as JSON,
// where specifier is null when the reference is not a string literal (the checker fails closed on it).
//
// Kinds: `static` (import, export ... from, import x = require), `dynamic` (import()), `type` (typeof import()),
// `require` (require()), `url` (new URL(..., import.meta.url), how Vite bundles a worker or an asset), `glob`
// (import.meta.glob, never a literal file).
import ts from "typescript";

function literal(node) {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function isImportMeta(node, name) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === name
  );
}

function references(path, text) {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind
  );
  const found = [];
  const add = (node, type, at = node) =>
    found.push([
      file.getLineAndCharacterOfPosition((at ?? node).getStart(file)).line + 1,
      type,
      literal(at),
    ]);
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    )
      add(node, "static", node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node, "static", node.moduleReference.expression);
    else if (ts.isImportTypeNode(node))
      add(
        node,
        "type",
        ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : node.argument
      );
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node, "dynamic", node.arguments[0] ?? node);
      else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      )
        add(node, "require", node.arguments[0] ?? node);
      else if (isImportMeta(node.expression, "glob")) add(node, "glob", node);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      isImportMeta(node.arguments[1], "url")
    )
      add(node, "url", node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
const out = {};
for (const [path, text] of Object.entries(JSON.parse(input)))
  out[path] = references(path, text);
process.stdout.write(JSON.stringify(out));

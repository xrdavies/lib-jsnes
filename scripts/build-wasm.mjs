import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import ts from 'typescript';

// Compile the existing CPU execution code, adding AssemblyScript's required
// integer annotations. JS snapshot marshaling stays in the TypeScript API.
const program = ts.createProgram(['src/cpu.ts'], { target: ts.ScriptTarget.ES2020 });
const checker = program.getTypeChecker();
const source = program.getSourceFile('src/cpu.ts');
const result = ts.transform(source, [context => {
  const f = context.factory;
  const typeAt = node => {
    const type = checker.getTypeAtLocation(node);
    if (type.flags & ts.TypeFlags.Object) return f.createTypeReferenceNode(type.symbol.getName());
    if (type.flags & ts.TypeFlags.BooleanLike) return f.createTypeReferenceNode('boolean');
    if (type.flags & ts.TypeFlags.NumberLike) return f.createTypeReferenceNode('i32');
    throw new Error(`Unsupported CPU type: ${checker.typeToString(type)}`);
  };
  const visit = node => {
    if (ts.isMethodDeclaration(node) && ['save', 'load'].includes(node.name.getText(source))) return undefined;
    if (node.kind === ts.SyntaxKind.NumberKeyword) return f.createTypeReferenceNode('i32');
    if (ts.isPropertyDeclaration(node) && !node.type && node.initializer) {
      // Preserve JavaScript's long-running cycle count rather than wrapping at 2^31.
      const type = node.name.getText(source) === 'cycles' ? f.createTypeReferenceNode('f64') : typeAt(node);
      node = f.updatePropertyDeclaration(node, node.modifiers, node.name, node.questionToken, type, node.initializer);
    }
    if (ts.isParameter(node) && !node.type && node.initializer) {
      node = f.updateParameterDeclaration(node, node.modifiers, node.dotDotDotToken, node.name, node.questionToken, typeAt(node), node.initializer);
    }
    if (ts.isMethodDeclaration(node) && !node.type) {
      const signature = checker.getSignatureFromDeclaration(node);
      const result = checker.getReturnTypeOfSignature(signature);
      const name = result.flags & ts.TypeFlags.Void ? 'void' : result.flags & ts.TypeFlags.BooleanLike ? 'boolean' : 'i32';
      node = f.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, f.createTypeReferenceNode(name), node.body);
    }
    return ts.visitEachChild(node, visit, context);
  };
  return root => ts.visitNode(root, visit);
}]);
mkdirSync('dist-wasm', { recursive: true });
const generated = 'dist-wasm/cpu.generated.ts';
try {
  writeFileSync(generated, ts.createPrinter().printFile(result.transformed[0]));
  const build = spawnSync('asc', ['wasm/index.ts', '--outFile', 'dist-wasm/lib-jsnes.wasm', '--exportRuntime', '--exportTable'], { stdio: 'inherit' });
  if (build.error) throw build.error;
  process.exitCode = build.status ?? 1;
} finally {
  result.dispose();
  unlinkSync(generated);
}

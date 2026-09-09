import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import ts from 'typescript';

const debug = process.argv.includes('--debug');
if (process.argv.slice(2).some(arg => arg !== '--debug')) throw new Error('Usage: build-wasm.mjs [--debug]');

// Compile the shared CPU/PPU/APU/controller code, adding AssemblyScript's required
// integer annotations. JS snapshot marshaling stays in the TypeScript API.
const sources = ['cpu', 'ppu', 'apu', 'controller'];
const program = ts.createProgram(sources.map(name => `src/${name}.ts`), { target: ts.ScriptTarget.ES2020 });
const checker = program.getTypeChecker();
function compileSource(name) {
  const source = program.getSourceFile(`src/${name}.ts`);
  const result = ts.transform(source, [context => {
    const f = context.factory;
    const typeAt = node => {
      const type = checker.getTypeAtLocation(node);
      if (checker.isArrayType(type)) {
        const element = checker.getTypeArguments(type)[0];
        return f.createArrayTypeNode(f.createTypeReferenceNode(element.flags & ts.TypeFlags.NumberLike ? 'i32' : element.symbol.getName()));
      }
      if (type.flags & ts.TypeFlags.Object) return f.createTypeReferenceNode(type.symbol.getName());
      if (type.flags & ts.TypeFlags.BooleanLike) return f.createTypeReferenceNode('boolean');
      if (type.flags & ts.TypeFlags.NumberLike) return f.createTypeReferenceNode('i32');
      throw new Error(`Unsupported shared-core type: ${checker.typeToString(type)}`);
    };
    const visit = node => {
      // Button's JS object is a host convenience; Controller uses the numeric mask.
      if (name === 'controller' && ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === 'Button')) return undefined;
      // The palette is a fixed numeric table. AssemblyScript typed-array
      // constructors accept lengths only; a StaticArray preserves indexed reads.
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'Uint32Array' && node.arguments?.length === 1 && ts.isArrayLiteralExpression(node.arguments[0])) {
        return f.createAsExpression(node.arguments[0], f.createTypeReferenceNode('StaticArray', [f.createTypeReferenceNode('u32')]));
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'Math.min') {
        return f.createCallExpression(f.createIdentifier('min'), undefined, node.arguments.map(arg => ts.visitNode(arg, visit)));
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'Math.floor') {
        return f.createAsExpression(node, f.createTypeReferenceNode('i32'));
      }
      if (ts.isMethodDeclaration(node) && ['save', 'load', 'saveState', 'loadState', 'validateState'].includes(node.name.getText(source))) return undefined;
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === './cartridge.js') {
        return f.updateImportDeclaration(node, node.modifiers, f.updateImportClause(node.importClause, false, node.importClause.name, node.importClause.namedBindings), f.createStringLiteral('../wasm/cartridge'), node.attributes);
      }
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
  try { return ts.createPrinter().printFile(result.transformed[0]); }
  finally { result.dispose(); }
}
mkdirSync('dist-wasm', { recursive: true });
// Stage beside the output to permit an atomic rename on the same filesystem.
// Each compiler sees the same relative paths, keeping output reproducible.
const staging = mkdtempSync(resolve('.wasm-build-'));
try {
  mkdirSync(join(staging, 'dist-wasm'));
  mkdirSync(join(staging, 'wasm'));
  for (const name of ['index', 'cartridge']) copyFileSync(`wasm/${name}.ts`, join(staging, `wasm/${name}.ts`));
  for (const name of sources) {
    writeFileSync(join(staging, `dist-wasm/${name}.generated.ts`), compileSource(name));
  }
  const build = spawnSync('asc', ['wasm/index.ts', '--baseDir', staging, '--outFile', 'dist-wasm/lib-jsnes.wasm', '--exportRuntime', '--exportTable', '--runtime', 'minimal',
    ...(debug ? ['--debug'] : ['--optimizeLevel', '3'])], { stdio: 'inherit' });
  if (build.error) throw build.error;
  process.exitCode = build.status ?? 1;
  if (build.status === 0) renameSync(join(staging, 'dist-wasm/lib-jsnes.wasm'), 'dist-wasm/lib-jsnes.wasm');
} finally {
  rmSync(staging, { recursive: true, force: true });
}

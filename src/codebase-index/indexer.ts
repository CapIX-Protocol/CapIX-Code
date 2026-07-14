/**
 * Codebase indexer — parses the project, builds a symbol + import graph, and
 * stores it in memory for fast retrieval.
 *
 * Uses the TypeScript compiler API for .ts/.tsx/.js/.jsx files (real AST
 * parsing) and improved regex for .py/.rs. The AST parser correctly handles
 * nested functions, arrow functions, interfaces, type aliases, and Next.js
 * App Router patterns.
 *
 * Refs:
 * - architecture §12.3 (agent brain: codebase context retrieval)
 */

import { createHash } from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  watch,
  type FSWatcher,
  type Dirent,
} from 'node:fs';
import { resolve, dirname, join, relative, extname, basename, isAbsolute, sep } from 'node:path';
import ts from 'typescript';
import { logger } from '../logger.js';

export interface SymbolNode {
  id: string; // sha256(filePath:line:column) prefix
  name: string; // function/variable/class name
  type:
    | 'function'
    | 'class'
    | 'variable'
    | 'import'
    | 'export'
    | 'interface'
    | 'type'
    | 'route'
    | 'config';
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  exported: boolean;
  async?: boolean;
  parameters?: string[];
  returnType?: string;
}

export interface ImportEdge {
  fromFile: string;
  toFile: string; // '' when unresolved (bare/node_modules)
  symbol: string;
  line: number;
}

export interface FileIndex {
  path: string;
  language: string;
  lineCount: number;
  symbols: SymbolNode[];
  imports: ImportEdge[];
  exports: string[];
  lastModified: number;
  contentHash: string;
}

export interface CodebaseIndex {
  rootPath: string;
  files: Map<string, FileIndex>;
  symbols: Map<string, SymbolNode>; // name -> symbol (for "find definition")
  importGraph: Map<string, string[]>; // file -> files it imports
  reverseImportGraph: Map<string, string[]>; // file -> files that import it
  updatedAt: number;
}

// ── Limits & config ─────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.next',
  'out',
  '.cache',
  '.turbo',
  'coverage',
]);

const MAX_FILES = 5000;
const MAX_INDEX_BYTES = 50 * 1024 * 1024;
const DEBOUNCE_MS = 500;

const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';
const CACHE_DIR = join(HOME, '.capix-code', 'cache');
const CACHE_FILE = join(CACHE_DIR, 'index.json');

const CONFIG_FILE_RE = /(?:^|[._-])config\.(?:ts|js|mjs|cjs|json)$/i;

// ── Helpers ─────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function symbolId(filePath: string, line: number, column: number): string {
  return sha256(`${filePath}:${line}:${column}`).slice(0, 16);
}

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  return 'other';
}

function isConfigFile(filePath: string): boolean {
  const base = basename(filePath).toLowerCase();
  return (
    base === 'package.json' ||
    base === 'tsconfig.json' ||
    base === 'jsconfig.json' ||
    base === 'pyproject.toml' ||
    base === 'cargo.toml' ||
    base === 'go.mod' ||
    CONFIG_FILE_RE.test(base)
  );
}

/** Should this file be indexed? */
function isIndexable(filePath: string): boolean {
  return detectLanguage(filePath) !== 'other' || isConfigFile(filePath);
}

/**
 * Resolve a relative TS/JS import specifier to an absolute file path.
 * Returns '' if it cannot be resolved (bare specifiers, aliases, missing).
 */
function resolveJsImport(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return '';
  const base = dirname(fromFile);
  const target = resolve(base, specifier);
  const candidates = [
    target,
    target + '.ts',
    target + '.tsx',
    target + '.js',
    target + '.jsx',
    target + '.mjs',
    target + '.cjs',
    join(target, 'index.ts'),
    join(target, 'index.tsx'),
    join(target, 'index.js'),
    join(target, 'index.jsx'),
    join(target, 'index.mjs'),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  return '';
}

/** Resolve a relative Python module spec (from .pkg.mod import x). */
function resolvePyImport(fromFile: string, mod: string): string {
  if (!mod) return '';
  const leading = mod.match(/^\.+/);
  const dotCount = leading ? leading[0].length : 0;
  const rest = mod.replace(/^\.+/, '');
  let base = dirname(fromFile);
  for (let i = 1; i < dotCount; i++) base = dirname(base);
  const parts = rest ? rest.split('.') : [];
  let cur = base;
  for (const p of parts) cur = join(cur, p);
  const candidates = [cur + '.py', join(cur, '__init__.py')];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  return '';
}

function firstIdent(s: string): string | undefined {
  const m = /([A-Za-z_$][\w$]*)/.exec(s.trim());
  return m ? m[1] : undefined;
}

interface ParseResult {
  symbols: SymbolNode[];
  imports: ImportEdge[];
  exports: string[];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length + 1;
}

// ── TS / JS parser (TypeScript compiler API) ────────────────────────────────

function parseTsJs(content: string, filePath: string): ParseResult {
  const symbols: SymbolNode[] = [];
  const imports: ImportEdge[] = [];
  const exports: string[] = [];

  const ext = extname(filePath).toLowerCase();
  const scriptKind =
    ext === '.tsx' ? ts.ScriptKind.TSX :
    ext === '.jsx' ? ts.ScriptKind.JSX :
    ext === '.js' || ext === '.mjs' || ext === '.cjs' ? ts.ScriptKind.JS :
    ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
  const ROUTE_HANDLER_NAMES = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

  function posOf(node: ts.Node): { line: number; col: number } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: line + 1, col: character + 1 };
  }

  function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return mods?.some((m) => m.kind === kind) ?? false;
  }

  function isExported(node: ts.Node): boolean {
    return hasModifier(node, ts.SyntaxKind.ExportKeyword);
  }

  function isAsync(node: ts.Node): boolean {
    return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
  }

  function getParamNames(sig: ts.SignatureDeclaration): string[] | undefined {
    const params: string[] = [];
    for (const p of sig.parameters) {
      if (ts.isIdentifier(p.name)) {
        if (p.name.text !== 'this') params.push(p.name.text);
      } else if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
        params.push('destructured');
      } else {
        params.push('computed');
      }
    }
    return params;
  }

  function getReturnTypeText(sig: ts.SignatureDeclaration): string | undefined {
    if (!sig.type) return undefined;
    return sig.type.getText(sourceFile);
  }

  function addSymbol(
    name: string,
    type: SymbolNode['type'],
    node: ts.Node,
    opts?: { exported?: boolean; async?: boolean; parameters?: string[]; returnType?: string },
  ): void {
    const { line, col } = posOf(node);
    symbols.push({
      id: symbolId(filePath, line, col),
      name,
      type,
      filePath,
      line,
      column: col,
      exported: opts?.exported ?? false,
      async: opts?.async || undefined,
      parameters: opts?.parameters,
      returnType: opts?.returnType,
    });
    if (opts?.exported) exports.push(name);
  }

  function handleImport(node: ts.ImportDeclaration): void {
    const specifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) return;
    const modText = specifier.text;
    const toFile = resolveJsImport(filePath, modText);
    const line = posOf(node).line;
    const clause = node.importClause;
    const names: string[] = [];

    if (!clause) {
      imports.push({ fromFile: filePath, toFile, symbol: '*', line });
      return;
    }

    if (clause.name) names.push(clause.name.text);

    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      names.push(clause.namedBindings.name.text);
    }

    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        names.push(el.propertyName ? el.propertyName.text : el.name.text);
      }
    }

    if (names.length === 0) names.push('*');
    for (const n of names) {
      imports.push({ fromFile: filePath, toFile, symbol: n, line });
    }
  }

  function extractExportNames(node: ts.ExportDeclaration): string[] {
    if (!node.exportClause) return [];
    if (ts.isNamedExports(node.exportClause)) {
      return node.exportClause.elements.map((el) => el.propertyName ? el.propertyName.text : el.name.text);
    }
    return [];
  }

  function handleExportDeclaration(node: ts.ExportDeclaration): void {
    const line = posOf(node).line;
    if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const toFile = resolveJsImport(filePath, node.moduleSpecifier.text);
      const names = extractExportNames(node);
      const syms = names.length ? names : ['*'];
      for (const n of syms) imports.push({ fromFile: filePath, toFile, symbol: n, line });
      for (const n of names) exports.push(n);
    } else {
      for (const n of extractExportNames(node)) exports.push(n);
    }
  }

  function handleRouteCallExpression(node: ts.CallExpression): void {
    const expr = node.expression;
    if (!ts.isPropertyAccessExpression(expr)) return;
    const methodName = expr.name.text.toLowerCase();
    if (!ROUTE_METHODS.has(methodName)) return;
    const obj = expr.expression;
    if (!ts.isIdentifier(obj)) return;
    if (obj.text !== 'app' && obj.text !== 'router') return;
    const firstArg = node.arguments[0];
    if (!firstArg || !ts.isStringLiteral(firstArg)) return;
    const { line, col } = posOf(node);
    symbols.push({
      id: symbolId(filePath, line, col),
      name: `${methodName.toUpperCase()} ${firstArg.text}`,
      type: 'route',
      filePath,
      line,
      column: col,
      exported: false,
    });
  }

  function handleDecorator(deco: ts.Decorator): void {
    let methodName: string | undefined;
    let pathArg: string | undefined;
    const expr = deco.expression;
    if (ts.isCallExpression(expr)) {
      const fn = expr.expression;
      if (ts.isIdentifier(fn)) {
        const upper = fn.text.toUpperCase();
        if (ROUTE_HANDLER_NAMES.has(upper)) {
          methodName = upper;
          const arg = expr.arguments[0];
          if (arg && ts.isStringLiteral(arg)) pathArg = arg.text;
        }
      }
    } else if (ts.isIdentifier(expr)) {
      const upper = expr.text.toUpperCase();
      if (ROUTE_HANDLER_NAMES.has(upper)) methodName = upper;
    }
    if (methodName && pathArg) {
      const { line, col } = posOf(deco);
      symbols.push({
        id: symbolId(filePath, line, col),
        name: `${methodName} ${pathArg}`,
        type: 'route',
        filePath,
        line,
        column: col,
        exported: false,
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      handleImport(node);
      return;
    }

    if (ts.isExportDeclaration(node)) {
      handleExportDeclaration(node);
      return;
    }

    if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression)) exports.push(node.expression.text);
      ts.forEachChild(node, visit);
      return;
    }

    const isTopLevel = ts.isSourceFile(node.parent);

    if (isTopLevel) {
      if (ts.isFunctionDeclaration(node)) {
        const name = node.name?.text;
        if (name) {
          const exported = isExported(node);
          if (exported && ROUTE_HANDLER_NAMES.has(name)) {
            addSymbol(`${name} /`, 'route', node, { exported: true });
            exports.push(name);
          } else {
            addSymbol(name, 'function', node, {
              exported,
              async: isAsync(node),
              parameters: getParamNames(node),
              returnType: getReturnTypeText(node),
            });
          }
        }
        ts.forEachChild(node, visit);
        return;
      }

      if (ts.isClassDeclaration(node)) {
        const name = node.name?.text;
        if (name) addSymbol(name, 'class', node, { exported: isExported(node) });
        ts.forEachChild(node, visit);
        return;
      }

      if (ts.isVariableStatement(node)) {
        const exported = isExported(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const symbolName = decl.name.text;
            const init = decl.initializer;
            let async = false;
            let parameters: string[] | undefined;
            let returnType: string | undefined;
            if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
              async = isAsync(init);
              parameters = getParamNames(init);
              returnType = getReturnTypeText(init);
            }
            addSymbol(symbolName, 'variable', decl.name, {
              exported,
              async: async || undefined,
              parameters,
              returnType,
            });
          }
        }
        ts.forEachChild(node, visit);
        return;
      }

      if (ts.isInterfaceDeclaration(node)) {
        addSymbol(node.name.text, 'interface', node, { exported: isExported(node) });
        return;
      }

      if (ts.isTypeAliasDeclaration(node)) {
        addSymbol(node.name.text, 'type', node, { exported: isExported(node) });
        return;
      }

      if (ts.isEnumDeclaration(node)) {
        addSymbol(node.name.text, 'class', node, { exported: isExported(node) });
        return;
      }
    }

    if (ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const parent = node.parent;
      if (parent && ts.isClassDeclaration(parent) && parent.name) {
        const methodName = ts.isIdentifier(node.name) ? node.name.text :
          ts.isStringLiteral(node.name) ? node.name.text : undefined;
        if (methodName) {
          addSymbol(`${parent.name.text}.${methodName}`, 'function', node, {
            exported: false,
            async: isAsync(node),
            parameters: ts.isMethodDeclaration(node) ? getParamNames(node) : undefined,
            returnType: ts.isMethodDeclaration(node) ? getReturnTypeText(node) : undefined,
          });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      handleRouteCallExpression(node);
    }

    if (ts.isDecorator(node)) {
      handleDecorator(node);
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  return { symbols, imports, exports };
}

// ── Python parser ───────────────────────────────────────────────────────────

function parsePython(content: string, filePath: string): ParseResult {
  const symbols: SymbolNode[] = [];
  const imports: ImportEdge[] = [];
  const exports: string[] = [];
  const lines = content.split('\n');

  const fnRe = /^\s*(async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
  const classRe = /^\s*class\s+([A-Za-z_]\w*)\s*[(:]/;
  const fromRe = /^\s*from\s+([\w.]+)\s+import\s+(.*)/;
  const importRe = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const ln = i + 1;
    const indent = indentOf(line);

    let m: RegExpExecArray | null;

    if ((m = fromRe.exec(line))) {
      const mod = m[1] ?? '';
      const namesClause = m[2] ?? '';
      const toFile = resolvePyImport(filePath, mod);
      for (const item of namesClause.split(',')) {
        const t = item.trim();
        if (!t) continue;
        const asM = /\bas\s+(\w+)$/.exec(t);
        const name = asM ? asM[1]! : firstIdent(t) ?? t;
        imports.push({ fromFile: filePath, toFile, symbol: name, line: ln });
      }
      continue;
    }
    if ((m = importRe.exec(line))) {
      const mod = m[1] ?? '';
      const alias = m[2];
      const symbol = alias ?? mod.split('.').pop() ?? mod;
      imports.push({ fromFile: filePath, toFile: '', symbol, line: ln });
      continue;
    }

    if ((m = classRe.exec(line))) {
      const name = m[1]!;
      const col = Math.max(line.indexOf(name), 0) + 1 || indent;
      symbols.push({
        id: symbolId(filePath, ln, col),
        name,
        type: 'class',
        filePath,
        line: ln,
        column: col,
        exported: true,
      });
      exports.push(name);
      continue;
    }
    if ((m = fnRe.exec(line))) {
      const isAsync = !!m[1];
      const name = m[2]!;
      const paramStr = m[3] ?? '';
      const params: string[] = [];
      for (const part of paramStr.split(',')) {
        const id = firstIdent(part);
        if (id && id !== 'self' && id !== 'cls') params.push(id);
      }
      const col = Math.max(line.indexOf(name), 0) + 1 || indent;
      symbols.push({
        id: symbolId(filePath, ln, col),
        name,
        type: 'function',
        filePath,
        line: ln,
        column: col,
        exported: true,
        async: isAsync || undefined,
        parameters: params,
      });
      exports.push(name);
      continue;
    }
  }

  return { symbols, imports, exports };
}

// ── Rust parser ──────────────────────────────────────────────────────────────

function parseRust(content: string, filePath: string): ParseResult {
  const symbols: SymbolNode[] = [];
  const imports: ImportEdge[] = [];
  const exports: string[] = [];
  const lines = content.split('\n');

  const fnRe = /^(pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
  const structRe = /^(pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/;
  const implRe = /^(?:pub(?:\([^)]*\))?\s+)?impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>, ]*?\s+for\s+)?([A-Za-z_]\w*)/;
  const useRe = /^(?:pub(?:\([^)]*\))?\s+)?use\s+(.+?);$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const ln = i + 1;
    const indent = indentOf(line);

    let m: RegExpExecArray | null;

    if ((m = useRe.exec(trimmed))) {
      const spec = m[1] ?? '';
      const segs = spec.split('::');
      let symbol = segs[segs.length - 1] ?? spec;
      const asM = /\bas\s+([A-Za-z_]\w*)$/.exec(symbol);
      if (asM) symbol = asM[1]!;
      symbol = symbol.replace(/[{}*]/g, '').trim() || '*';
      imports.push({ fromFile: filePath, toFile: '', symbol, line: ln });
      continue;
    }
    if ((m = fnRe.exec(trimmed))) {
      const pub = !!m[1];
      const isAsync = !!m[2];
      const name = m[3]!;
      const paramStr = m[4] ?? '';
      const params: string[] = [];
      for (const part of paramStr.split(',')) {
        const id = firstIdent(part);
        if (id && id !== 'self' && id !== '&self' && id !== 'mut') params.push(id);
      }
      const col = Math.max(line.indexOf(name), 0) + 1 || indent;
      symbols.push({
        id: symbolId(filePath, ln, col),
        name,
        type: 'function',
        filePath,
        line: ln,
        column: col,
        exported: pub,
        async: isAsync || undefined,
        parameters: params,
        returnType: extractRustRetType(line),
      });
      if (pub) exports.push(name);
      continue;
    }
    if ((m = structRe.exec(trimmed))) {
      const pub = !!m[1];
      const name = m[2]!;
      const col = Math.max(line.indexOf(name), 0) + 1 || indent;
      symbols.push({
        id: symbolId(filePath, ln, col),
        name,
        type: 'class',
        filePath,
        line: ln,
        column: col,
        exported: pub,
      });
      if (pub) exports.push(name);
      continue;
    }
    if ((m = implRe.exec(trimmed))) {
      const name = m[1]!;
      const col = Math.max(line.indexOf(name), 0) + 1 || indent;
      symbols.push({
        id: symbolId(filePath, ln, col),
        name,
        type: 'class',
        filePath,
        line: ln,
        column: col,
        exported: false,
      });
      continue;
    }
  }

  return { symbols, imports, exports };
}

function extractRustRetType(line: string): string | undefined {
  const m = /\)\s*->\s*([^{;]+)/.exec(line);
  return m ? m[1]!.trim() : undefined;
}

// ── Parsing dispatch ────────────────────────────────────────────────────────

function parseContent(content: string, filePath: string, language: string): ParseResult {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return parseTsJs(content, filePath);
    case 'python':
      return parsePython(content, filePath);
    case 'rust':
      return parseRust(content, filePath);
    default:
      return { symbols: [], imports: [], exports: [] };
  }
}

// ── Directory walking ───────────────────────────────────────────────────────

function walkDir(root: string): string[] {
  const out: string[] = [];
  const recurse = (dir: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        recurse(join(dir, e.name));
      } else if (e.isFile()) {
        const full = join(dir, e.name);
        if (isIndexable(full)) out.push(full);
      }
    }
  };
  recurse(root);
  return out;
}

// ── CodebaseIndexer ─────────────────────────────────────────────────────────

export class CodebaseIndexer {
  readonly rootPath: string;
  private index: CodebaseIndex | null = null;
  private watcher: FSWatcher | null = null;
  private handlers: Array<() => void> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
    this.load();
  }

  // ── Public API ──

  async indexAll(): Promise<void> {
    const files = walkDir(this.rootPath);
    this.index = {
      rootPath: this.rootPath,
      files: new Map(),
      symbols: new Map(),
      importGraph: new Map(),
      reverseImportGraph: new Map(),
      updatedAt: Date.now(),
    };
    let count = 0;
    for (const f of files) {
      if (count >= MAX_FILES) break;
      const fi = this.parseFile(f);
      if (fi) {
        this.index.files.set(f, fi);
        count++;
      }
    }
    this.rebuildDerivedMaps();
    this.index.updatedAt = Date.now();
    this.persist();
    this.emitUpdated();
    logger.info('codebase-index: indexAll complete', {
      root: this.rootPath,
      files: count,
      symbols: this.index.symbols.size,
    });
  }

  async indexChanged(): Promise<void> {
    if (!this.index) {
      await this.indexAll();
      return;
    }
    const currentFiles = walkDir(this.rootPath);
    const seen = new Set<string>();
    let changed = false;
    for (const f of currentFiles) {
      seen.add(f);
      let content: string;
      try {
        content = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const hash = sha256(content);
      const existing = this.index.files.get(f);
      if (existing && existing.contentHash === hash) continue;
      const fi = this.parseFile(f, content, hash);
      if (!fi) continue;
      this.index.files.set(f, fi);
      changed = true;
    }
    for (const p of [...this.index.files.keys()]) {
      if (!seen.has(p)) {
        this.index.files.delete(p);
        changed = true;
      }
    }
    if (changed) {
      this.rebuildDerivedMaps();
      this.index.updatedAt = Date.now();
      this.persist();
      this.emitUpdated();
      logger.info('codebase-index: indexChanged updated', {
        files: this.index.files.size,
      });
    }
  }

  async indexFile(filePath: string): Promise<FileIndex | null> {
    if (!this.index) {
      this.index = {
        rootPath: this.rootPath,
        files: new Map(),
        symbols: new Map(),
        importGraph: new Map(),
        reverseImportGraph: new Map(),
        updatedAt: Date.now(),
      };
    }
    const abs = isAbsolute(filePath) ? filePath : resolve(this.rootPath, filePath);
    const fi = this.parseFile(abs);
    if (!fi) return null;
    this.index.files.set(abs, fi);
    this.rebuildDerivedMaps();
    this.index.updatedAt = Date.now();
    this.persist();
    this.emitUpdated();
    return fi;
  }

  getIndex(): CodebaseIndex | null {
    return this.index;
  }

  findReferences(symbolName: string): SymbolNode[] {
    if (!this.index) return [];
    const out: SymbolNode[] = [];
    for (const fi of this.index.files.values()) {
      for (const s of fi.symbols) {
        if (s.name === symbolName) out.push(s);
      }
      for (const imp of fi.imports) {
        if (imp.symbol === symbolName) {
          out.push({
            id: symbolId(fi.path, imp.line, 1),
            name: symbolName,
            type: 'import',
            filePath: fi.path,
            line: imp.line,
            column: 1,
            exported: false,
          });
        }
      }
    }
    return out;
  }

  findDefinition(symbolName: string): SymbolNode | null {
    if (!this.index) return null;
    const fromMap = this.index.symbols.get(symbolName);
    if (fromMap) return fromMap;
    let fallback: SymbolNode | null = null;
    for (const fi of this.index.files.values()) {
      for (const s of fi.symbols) {
        if (
          s.name === symbolName &&
          (s.type === 'function' || s.type === 'class' || s.type === 'variable')
        ) {
          return s;
        }
        if (s.name === symbolName && !fallback) fallback = s;
      }
    }
    return fallback;
  }

  getDependents(filePath: string): string[] {
    if (!this.index) return [];
    const abs = isAbsolute(filePath) ? filePath : resolve(this.rootPath, filePath);
    return this.index.reverseImportGraph.get(abs) ?? [];
  }

  getDependencies(filePath: string): string[] {
    if (!this.index) return [];
    const abs = isAbsolute(filePath) ? filePath : resolve(this.rootPath, filePath);
    return this.index.importGraph.get(abs) ?? [];
  }

  startWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(
        this.rootPath,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          const parts = String(filename).split(sep);
          if (parts.some((p) => SKIP_DIRS.has(p))) return;
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.indexChanged().catch((err) =>
              logger.warn('codebase-index: watch re-index failed', {
                error: (err as Error)?.message,
              })
            );
          }, DEBOUNCE_MS);
        }
      );
      this.watcher.on('error', (err: Error) =>
        logger.warn('codebase-index: watcher error', { error: err.message })
      );
    } catch (err) {
      logger.warn('codebase-index: could not start watcher', {
        error: (err as Error)?.message,
      });
    }
  }

  stopWatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
  }

  onIndexUpdated(handler: () => void): void {
    this.handlers.push(handler);
  }

  // ── Internals ──

  private parseFile(
    absPath: string,
    contentOverride?: string,
    hashOverride?: string
  ): FileIndex | null {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absPath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const language = detectLanguage(absPath);
    let content: string;
    try {
      content = contentOverride ?? readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }
    const contentHash = hashOverride ?? sha256(content);
    const { symbols, imports, exports } = parseContent(content, absPath, language);

    if (isConfigFile(absPath)) {
      symbols.push({
        id: symbolId(absPath, 1, 1),
        name: basename(absPath),
        type: 'config',
        filePath: absPath,
        line: 1,
        column: 1,
        exported: true,
      });
    }

    return {
      path: absPath,
      language,
      lineCount: content.split('\n').length,
      symbols,
      imports,
      exports,
      lastModified: stat.mtimeMs,
      contentHash,
    };
  }

  private rebuildDerivedMaps(): void {
    if (!this.index) return;
    const symbols = new Map<string, SymbolNode>();
    const importGraph = new Map<string, string[]>();
    const reverseImportGraph = new Map<string, string[]>();

    for (const [path, fi] of this.index.files) {
      for (const sym of fi.symbols) {
        if (sym.type === 'import' || sym.type === 'route' || sym.type === 'config') continue;
        const cur = symbols.get(sym.name);
        if (!cur || (!cur.exported && sym.exported)) {
          symbols.set(sym.name, sym);
        }
      }
      const deps = new Set<string>();
      for (const imp of fi.imports) {
        if (!imp.toFile) continue;
        deps.add(imp.toFile);
        let rev = reverseImportGraph.get(imp.toFile);
        if (!rev) {
          rev = [];
          reverseImportGraph.set(imp.toFile, rev);
        }
        if (!rev.includes(path)) rev.push(path);
      }
      importGraph.set(path, [...deps]);
    }

    this.index.symbols = symbols;
    this.index.importGraph = importGraph;
    this.index.reverseImportGraph = reverseImportGraph;
  }

  private emitUpdated(): void {
    for (const h of this.handlers) {
      try {
        h();
      } catch (err) {
        logger.warn('codebase-index: onIndexUpdated handler threw', {
          error: (err as Error)?.message,
        });
      }
    }
  }

  private persist(): void {
    if (!this.index) return;
    try {
      const data = {
        rootPath: this.index.rootPath,
        files: Object.fromEntries(this.index.files),
        symbols: Object.fromEntries(this.index.symbols),
        importGraph: Object.fromEntries(this.index.importGraph),
        reverseImportGraph: Object.fromEntries(this.index.reverseImportGraph),
        updatedAt: this.index.updatedAt,
      };
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > MAX_INDEX_BYTES) {
        logger.warn('codebase-index: serialized index exceeds 50MB, skipping persist', {
          bytes: Buffer.byteLength(serialized),
        });
        return;
      }
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(CACHE_FILE, serialized);
    } catch (err) {
      logger.warn('codebase-index: persist failed', {
        error: (err as Error)?.message,
      });
    }
  }

  private load(): boolean {
    try {
      const raw = readFileSync(CACHE_FILE, 'utf8');
      const data = JSON.parse(raw) as {
        rootPath: string;
        files: Record<string, FileIndex>;
        symbols: Record<string, SymbolNode>;
        importGraph: Record<string, string[]>;
        reverseImportGraph: Record<string, string[]>;
        updatedAt: number;
      };
      if (data.rootPath !== this.rootPath) return false;
      this.index = {
        rootPath: data.rootPath,
        files: new Map(Object.entries(data.files)),
        symbols: new Map(Object.entries(data.symbols)),
        importGraph: new Map(Object.entries(data.importGraph)),
        reverseImportGraph: new Map(Object.entries(data.reverseImportGraph)),
        updatedAt: data.updatedAt,
      };
      return true;
    } catch {
      return false;
    }
  }

  /** Exposed for the retriever (relative path rendering). */
  getRelativePath(absPath: string): string {
    try {
      const r = relative(this.rootPath, absPath);
      return r || absPath;
    } catch {
      return absPath;
    }
  }
}

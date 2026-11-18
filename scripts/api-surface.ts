/**
 * The public API, as a snapshot: every export of every package entry point
 * with its signature (and whether it is marked @experimental), the CLI's
 * usage text, and every error code the engine and Worker can answer with.
 *
 *   bun scripts/api-surface.ts           print the current surface
 *   bun scripts/api-surface.ts --write   record it in api/surface.json
 *
 * test/api-surface.test.ts fails when the code and api/surface.json differ,
 * so a change to the public API is always a deliberate one: update API.md
 * and the CHANGELOG, then record it with --write.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Package export -> source entry. Keep in step with package.json "exports". */
export const ENTRIES: Record<string, string> = {
  "@tapedb/tapedb": "src/index.ts",
  "@tapedb/tapedb/schema": "src/schema-entry.ts",
  "@tapedb/tapedb/react": "src/react/index.ts",
  "@tapedb/tapedb/worker": "src/worker/index.ts",
  "@tapedb/tapedb/studio": "src/studio/index.ts",
  "@tapedb/tapedb/seed": "src/seed/index.ts",
};

const FORMAT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature;

interface ExportEntry {
  kind: string;
  experimental?: true;
  shape: string | Record<string, string>;
}

export interface Surface {
  entries: Record<string, Record<string, ExportEntry>>;
  cli: string;
  errorCodes: string[];
}

function squash(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

function isExperimental(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) =>
    ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === "experimental")
  );
}

function describe(checker: ts.TypeChecker, symbol: ts.Symbol): ExportEntry {
  const declaration = symbol.declarations?.[0];
  const entry = (kind: string, shape: ExportEntry["shape"]): ExportEntry =>
    isExperimental(symbol) ? { kind, experimental: true, shape } : { kind, shape };

  if (declaration && (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration))) {
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const members: Record<string, string> = {};
    for (const property of checker.getPropertiesOfType(type)) {
      const member = property.declarations?.[0];
      if (member && ts.getCombinedModifierFlags(member as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
      if (property.name.startsWith("#")) continue;
      const tag = isExperimental(property) ? " @experimental" : "";
      members[property.name] = checker.typeToString(checker.getTypeOfSymbolAtLocation(property, declaration), declaration, FORMAT) + tag;
    }
    const heritage = (declaration.heritageClauses ?? []).map((clause) => squash(clause.getText())).join(" ");
    const typeParameters = (declaration.typeParameters ?? []).map((parameter) => squash(parameter.getText())).join(", ");
    if (heritage || typeParameters) members["(declaration)"] = `${typeParameters ? `<${typeParameters}>` : ""} ${heritage}`.trim();
    return entry(ts.isClassDeclaration(declaration) ? "class" : "interface", members);
  }
  if (declaration && ts.isTypeAliasDeclaration(declaration)) {
    const typeParameters = (declaration.typeParameters ?? []).map((parameter) => squash(parameter.getText())).join(", ");
    return entry("type", `${typeParameters ? `<${typeParameters}> ` : ""}${squash(declaration.type.getText())}`);
  }
  if (declaration && ts.isFunctionDeclaration(declaration)) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    return entry("function", type.getCallSignatures().map((signature) => checker.signatureToString(signature, declaration, FORMAT)).join(" | "));
  }
  const location = declaration ?? symbol.valueDeclaration;
  const type = location ? checker.getTypeOfSymbolAtLocation(symbol, location) : undefined;
  return entry("value", type ? checker.typeToString(type, location, FORMAT) : "unknown");
}

function exportsOf(): Surface["entries"] {
  const configPath = join(root, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) throw new Error("could not read tsconfig.json");
  const files = Object.values(ENTRIES).map((file) => join(root, file));
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const entries: Surface["entries"] = {};
  const srcDir = join(root, "src");
  const exportedSymbols = new Set<ts.Symbol>();
  const queue: ts.Symbol[] = [];
  const queued = new Set<ts.Symbol>();
  // Types the public surface refers to but does not export: a change inside
  // them changes the API just the same.
  const follow = (node: ts.Node) => {
    const visit = (child: ts.Node) => {
      if (ts.isTypeReferenceNode(child) || ts.isExpressionWithTypeArguments(child) || ts.isTypeQueryNode(child)) {
        const nameNode = ts.isTypeReferenceNode(child) ? child.typeName : ts.isTypeQueryNode(child) ? child.exprName : child.expression;
        let symbol = checker.getSymbolAtLocation(nameNode);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const declaration = symbol?.declarations?.[0];
        if (symbol && declaration && !ts.isTypeParameterDeclaration(declaration) && declaration.getSourceFile().fileName.startsWith(srcDir) && !queued.has(symbol)) {
          queued.add(symbol);
          queue.push(symbol);
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  };
  for (const [name, file] of Object.entries(ENTRIES)) {
    const source = program.getSourceFile(join(root, file));
    if (!source) throw new Error(`missing ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const result: Record<string, ExportEntry> = {};
    for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      result[exported.name] = describe(checker, target);
      exportedSymbols.add(target);
      queued.add(target);
      for (const declaration of target.declarations ?? []) {
        // A function's body is not its API; its signature is.
        if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
          for (const parameter of declaration.parameters) follow(parameter);
          if (declaration.type) follow(declaration.type);
          for (const parameter of declaration.typeParameters ?? []) follow(parameter);
        } else if (ts.isClassDeclaration(declaration)) {
          for (const member of declaration.members) {
            if (ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
            // Constructors are not public: instances come from createClient.
            if (ts.isMethodDeclaration(member)) {
              for (const parameter of member.parameters) follow(parameter);
              if (member.type) follow(member.type);
            } else if (ts.isPropertyDeclaration(member) && member.type) follow(member.type);
          }
          for (const clause of declaration.heritageClauses ?? []) follow(clause);
        } else if (ts.isVariableDeclaration(declaration)) {
          if (declaration.type) follow(declaration.type);
        } else {
          follow(declaration);
        }
      }
      // An alias carries its own JSDoc only at the original declaration.
      if (isExperimental(target)) result[exported.name].experimental = true;
    }
    entries[name] = Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
  }
  const referenced: Record<string, ExportEntry> = {};
  while (queue.length > 0) {
    const symbol = queue.shift()!;
    if (exportedSymbols.has(symbol)) continue;
    const declaration = symbol.declarations?.[0];
    if (!declaration) continue;
    const where = relative(root, declaration.getSourceFile().fileName);
    referenced[`${symbol.name} (${where})`] = describe(checker, symbol);
    if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isEnumDeclaration(declaration)) follow(declaration);
  }
  entries["(referenced, not exported)"] = Object.fromEntries(Object.entries(referenced).sort(([a], [b]) => a.localeCompare(b)));
  return entries;
}

/** The CLI's usage text: commands and flags are public. */
function cliUsage(): string {
  const source = readFileSync(join(root, "src/cli/index.ts"), "utf8");
  const match = /function usage\(\): number \{\s*console\.log\(`([\s\S]*?)`\);/.exec(source);
  if (!match) throw new Error("no usage() text in src/cli/index.ts");
  return match[1].trim();
}

/**
 * Every literal error code a caller can receive: from a Worker or engine
 * response, a socket message, or an error the client raises. All of src is
 * scanned, so a new module cannot be missed, except two places whose codes
 * never reach a caller: the CLI (messages for a terminal) and the durability
 * flusher (results the alarm logs). Codes that reach an answer through a
 * variable are covered by the declared `*ErrorCode` unions.
 */
const INTERNAL_CODE_DIRS = [join(root, "src/cli"), join(root, "src/engine/durability")];

function errorCodes(): string[] {
  const codes = new Set<string>();
  const patterns = [
    /apiError\(\s*\d+,\s*"([a-z_]+)"/g,
    /new (?:TxError|ReadError|QueryError|ClaimError)\(\s*"([a-z_]+)"/g,
    /code:\s*"([a-z_]+)"/g,
  ];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!INTERNAL_CODE_DIRS.includes(path)) walk(path);
      } else if (path.endsWith(".ts")) {
        const text = readFileSync(path, "utf8");
        for (const pattern of patterns) for (const match of text.matchAll(pattern)) codes.add(match[1]);
        for (const union of text.matchAll(/export type \w*ErrorCode =([^;]+);/g)) {
          for (const match of union[1].matchAll(/"([a-z_]+)"/g)) codes.add(match[1]);
        }
      }
    }
  };
  walk(join(root, "src"));
  return [...codes].sort();
}

export function currentSurface(): Surface {
  // Types printed from another module carry its absolute path; keep the
  // snapshot the same on every machine.
  const portable = JSON.stringify(exportsOf()).replaceAll(`${root}/`, "");
  return { entries: JSON.parse(portable), cli: cliUsage(), errorCodes: errorCodes() };
}

export const SURFACE_FILE = join(root, "api/surface.json");

if (import.meta.main) {
  const surface = currentSurface();
  const text = `${JSON.stringify(surface, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    mkdirSync(dirname(SURFACE_FILE), { recursive: true });
    writeFileSync(SURFACE_FILE, text);
    console.log(`recorded ${relative(root, SURFACE_FILE)}`);
  } else {
    process.stdout.write(text);
  }
}

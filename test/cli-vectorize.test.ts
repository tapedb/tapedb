/**
 * `tapedb deploy` and vector search: the index is created before the Worker is
 * uploaded, its shape and ownership are proven before traffic reaches it, and a
 * repeat, concurrent or interrupted deploy converges on one resource.
 *
 * The account is a fake `WranglerCommand` that behaves like the Vectorize API
 * for the calls this CLI makes: read, create, create-metadata-index, list. The
 * live shapes are the ones measured against wrangler 4.166: dimensions and
 * metric under `config`, metadata types spelled `Bool`/`Str`/`Num`, and the
 * read command named `list-metadata-index`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { model, schema, t } from "../src/schema";
import { DeployRefused, provisionAndDeploy, type DeployConfig, type WranglerCommand } from "../src/cli/onboarding";
import {
  VECTORIZE_RECORD_FILE,
  deriveVectorizeIndexName,
  provisionVectorize,
  readVectorizeRecord,
  resolveVectorizeDeclaration,
  type VectorizeDeploymentConfig,
} from "../src/cli/vectorize";

const DIMENSIONS = 768;
const INDEX = "tapedb-app-note";

const appSchema = schema({
  note: model({
    title: t.string(),
    archived: t.boolean().default(false),
    embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
  }),
});

type Metadata = { propertyName: string; indexType: string };

interface FakeOptions {
  index?: { dimensions: number; metric: string };
  metadata?: Metadata[];
  /** Answer the first read as missing, then report the index after a lost create. */
  loseCreateRace?: boolean;
  /** Refuse a metadata index creation the way the API can. */
  failMetadata?: boolean;
}

/** The Vectorize surface this CLI uses, over an in-memory account. */
function fakeAccount(options: FakeOptions = {}) {
  const calls: string[][] = [];
  const state = {
    index: options.index === undefined ? null : { ...options.index },
    metadata: [...(options.metadata ?? [])],
    reads: 0,
  };
  const command: WranglerCommand = (args) => {
    calls.push(args);
    const [group, verb, target] = args;
    if (group !== "vectorize") throw new Error(`unexpected wrangler call: ${args.join(" ")}`);
    if (verb === "get" && target === INDEX) {
      state.reads += 1;
      if (state.index === null) {
        return { status: 1, stdout: "", stderr: `✘ [ERROR] Vectorize index "${INDEX}" not found. [code: 3010]` };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ name: INDEX, config: { dimensions: state.index.dimensions, metric: state.index.metric } }),
        stderr: "",
      };
    }
    if (verb === "create" && target === INDEX) {
      if (state.index !== null) return { status: 1, stdout: "", stderr: "A Vectorize index with that name already exists." };
      state.index = {
        dimensions: Number(args[args.indexOf("--dimensions") + 1]),
        metric: String(args[args.indexOf("--metric") + 1]),
      };
      if (options.loseCreateRace === true) {
        return { status: 1, stdout: "", stderr: "A Vectorize index with that name already exists." };
      }
      return { status: 0, stdout: "created", stderr: "" };
    }
    if (verb === "list-metadata-index" && target === INDEX) {
      return { status: 0, stdout: JSON.stringify(state.metadata), stderr: "" };
    }
    if (verb === "create-metadata-index" && target === INDEX) {
      if (options.failMetadata === true) {
        return { status: 1, stdout: "", stderr: "[ERROR] metadata index creation refused" };
      }
      const type = String(args[args.indexOf("--type") + 1]);
      state.metadata.push({
        propertyName: String(args[args.indexOf("--propertyName") + 1]),
        indexType: type === "boolean" ? "Bool" : type === "number" ? "Num" : "Str",
      });
      return { status: 0, stdout: "created", stderr: "" };
    }
    throw new Error(`unexpected wrangler call: ${args.join(" ")}`);
  };
  const creates = (verb: string) => calls.filter((args) => args[0] === "vectorize" && args[1] === verb);
  return { command, calls, creates, state };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project directory holding the declaration the CLI owns. */
function project(record: VectorizeDeploymentConfig = { model: "note", field: "embedding", filterFields: ["archived"] }): string {
  const root = mkdtempSync(join(tmpdir(), "tapedb-vectorize-"));
  roots.push(root);
  writeFileSync(join(root, VECTORIZE_RECORD_FILE), JSON.stringify(record, null, 2) + "\n");
  return root;
}

function selection(): DeployConfig {
  return { name: "app", vars: { ENVIRONMENT: "production" } } as DeployConfig;
}

function provision(
  account: ReturnType<typeof fakeAccount>,
  root: string,
  extra: { jurisdiction?: string; worker?: string; selected?: DeployConfig } = {}
) {
  return provisionVectorize({
    root,
    selected: extra.selected ?? selection(),
    command: account.command,
    account: "account-1",
    worker: extra.worker ?? "app",
    jurisdiction: extra.jurisdiction,
    schema: appSchema,
    log: () => {},
  });
}

const recordOf = (root: string) => readFileSync(join(root, VECTORIZE_RECORD_FILE), "utf8").trim();

describe("the deployment's index", () => {
  test("a fresh deploy creates the index, one metadata index per filter, and records ownership", async () => {
    const account = fakeAccount();
    const root = project();
    const selected = selection();
    const result = await provision(account, root, { selected });

    expect(result!.created).toBe(true);
    expect(result!.index).toBe(INDEX);
    expect(account.creates("create")).toHaveLength(1);
    const create = account.creates("create")[0]!;
    expect(create[create.indexOf("--dimensions") + 1]).toBe(String(DIMENSIONS));
    expect(create[create.indexOf("--metric") + 1]).toBe("cosine");
    expect(account.state.metadata).toEqual([{ propertyName: "archived", indexType: "Bool" }]);

    // The Worker's binding is part of the deploy, and the ownership record is
    // written to the file the CLI owns before the upload.
    expect(selected.vectorize).toEqual([{ binding: "VECTORIZE", index_name: INDEX }]);
    const record = readVectorizeRecord(root)!;
    expect(record.ownership).toMatchObject({
      index: INDEX,
      account: "account-1",
      worker: "app",
      model: "note",
      field: "embedding",
      dimensions: DIMENSIONS,
      metric: "cosine",
      filters: [{ property: "archived", type: "boolean" }],
    });
    expect(recordOf(root)).toContain('"ownership"');
  });

  test("a repeat deploy keeps the index and creates nothing a second time", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", indexType: "Bool" }],
    });
    const root = project({
      model: "note",
      field: "embedding",
      filterFields: ["archived"],
      index: INDEX,
      ownership: {
        index: INDEX,
        account: "account-1",
        worker: "app",
        model: "note",
        field: "embedding",
        dimensions: DIMENSIONS,
        metric: "cosine",
        filters: [{ property: "archived", type: "boolean" }],
        created_at: new Date().toISOString(),
      },
    });
    const selected = selection();
    const result = await provision(account, root, { selected });

    expect(result!.created).toBe(false);
    expect(account.creates("create")).toHaveLength(0);
    expect(account.creates("create-metadata-index")).toHaveLength(0);
    expect(selected.vectorize).toEqual([{ binding: "VECTORIZE", index_name: INDEX }]);
  });

  test("a deploy that loses the creation race converges instead of failing", async () => {
    const account = fakeAccount({ loseCreateRace: true });
    const root = project();
    const result = await provision(account, root);

    expect(result!.created).toBe(false);
    expect(account.state.reads).toBeGreaterThan(0);
    expect(readVectorizeRecord(root)!.ownership!.index).toBe(INDEX);
    expect(account.state.metadata).toEqual([{ propertyName: "archived", indexType: "Bool" }]);
  });

  test("the derived name is stable, lower case, and survives a long worker name", () => {
    expect(deriveVectorizeIndexName("app", "note")).toBe("tapedb-app-note");
    expect(deriveVectorizeIndexName("My App", "Note")).toBe("tapedb-my-app-note");
    const long = deriveVectorizeIndexName("a".repeat(80), "embedding");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("-embedding")).toBe(true);
    expect(long).toBe(deriveVectorizeIndexName("a".repeat(80), "embedding"));
  });

  test("a project without the file provisions no index", async () => {
    const account = fakeAccount();
    const root = mkdtempSync(join(tmpdir(), "tapedb-vectorize-"));
    roots.push(root);
    expect(await provision(account, root)).toBeNull();
    expect(account.calls).toHaveLength(0);
  });
});

describe("what is refused before traffic reaches the index", () => {
  test("an index of the wrong dimension count", async () => {
    const account = fakeAccount({ index: { dimensions: 512, metric: "cosine" }, metadata: [{ propertyName: "archived", indexType: "Bool" }] });
    await expect(provision(account, project())).rejects.toThrow(/512 dimensions, but note\.embedding declares 768/);
    expect(account.creates("create-metadata-index")).toHaveLength(0);
  });

  test("an index with another metric", async () => {
    const account = fakeAccount({ index: { dimensions: DIMENSIONS, metric: "euclidean" }, metadata: [{ propertyName: "archived", indexType: "Bool" }] });
    await expect(provision(account, project())).rejects.toThrow(/uses euclidean; this engine searches with cosine/);
  });

  test("a metadata index of the wrong type", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", indexType: "Str" }],
    });
    await expect(provision(account, project())).rejects.toThrow(/string metadata index for archived, but note\.archived is a boolean/);
  });

  test("a metadata index the API refuses stops the deploy", async () => {
    const account = fakeAccount({ failMetadata: true });
    await expect(provision(account, project())).rejects.toThrow(/Could not create the metadata index for archived/);
  });

  test("an index this deployment cannot prove it created", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", indexType: "Bool" }],
    });
    await expect(provision(account, project())).rejects.toThrow(/no ownership record for it/);
  });

  test("an index the file names is adopted and recorded", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", indexType: "Bool" }],
    });
    // The upgrade path: an index created by hand before this CLI provisioned it.
    const root = project({ model: "note", field: "embedding", filterFields: ["archived"], index: INDEX });
    const result = await provision(account, root);
    expect(result!.created).toBe(false);
    expect(readVectorizeRecord(root)!.ownership!.account).toBe("account-1");
  });

  test("an ownership record that no longer matches the deployment", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", indexType: "Bool" }],
    });
    const root = project({
      model: "note",
      field: "embedding",
      filterFields: ["archived"],
      index: INDEX,
      ownership: {
        index: INDEX,
        account: "another-account",
        worker: "app",
        model: "note",
        field: "embedding",
        dimensions: DIMENSIONS,
        metric: "cosine",
        filters: [{ property: "archived", type: "boolean" }],
        created_at: new Date().toISOString(),
      },
    });
    await expect(provision(account, root)).rejects.toThrow(/account another-account vs account-1/);
  });

  test("a residency-restricted deployment, before any Vectorize call", async () => {
    const account = fakeAccount();
    await expect(provision(account, project(), { jurisdiction: "eu" })).rejects.toThrow(/residency/);
    await expect(provision(account, project(), { jurisdiction: "fedramp" })).rejects.toThrow(/residency/);
    expect(account.calls).toHaveLength(0);
  });

  test("a declaration that does not name a vector attribute", () => {
    expect(() => resolveVectorizeDeclaration({ model: "note", field: "title" }, appSchema)).toThrow(
      /must name a t\.vector\(\{ dimensions \}\) attribute; note\.title is a string/
    );
  });

  test("a filter that is not a flat scalar, and the vector field itself", () => {
    expect(() =>
      resolveVectorizeDeclaration({ model: "note", field: "embedding", filterFields: ["embedding"] }, appSchema)
    ).toThrow(/names the vector attribute itself/);
    const withPersonal = schema({
      note: model({
        secret: t.string().personal({ subject: "self" }),
        embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
      }),
    });
    expect(() =>
      resolveVectorizeDeclaration({ model: "note", field: "embedding", filterFields: ["secret"] }, withPersonal)
    ).toThrow(/personal attribute/);
  });
});

describe("the deploy itself", () => {
  test("a provisioning refusal stops the upload and returns non-zero", async () => {
    const calls: string[][] = [];
    const command: WranglerCommand = (args) => {
      calls.push(args);
      if (args[0] === "whoami") {
        return { status: 0, stdout: JSON.stringify({ accounts: [{ id: "account-1", name: "Account" }] }), stderr: "" };
      }
      if (args[0] === "vectorize" && args[1] === "get") {
        return { status: 0, stdout: JSON.stringify({ name: INDEX, config: { dimensions: 512, metric: "cosine" } }), stderr: "" };
      }
      if (args[0] === "deploy") throw new Error("the Worker must not be uploaded");
      return { status: 0, stdout: "", stderr: "" };
    };
    const root = project();
    const status = await provisionAndDeploy(
      root,
      selection(),
      undefined,
      true,
      () => command,
      async (scoped, context) => {
        try {
          await provisionVectorize({
            root,
            selected: context.selected,
            command: scoped,
            account: context.account,
            worker: context.worker,
            schema: appSchema,
            log: () => {},
          });
        } catch (error) {
          throw new DeployRefused(error instanceof Error ? error.message : String(error));
        }
      }
    );

    expect(status).toBe(1);
    expect(calls.some((args) => args[0] === "deploy")).toBe(false);
  });
});

/**
 * `tapedb deploy` and vector search: the index is created before the Worker is
 * uploaded, its shape and ownership are proven before traffic reaches it, and a
 * repeat, concurrent or interrupted deploy converges on one resource.
 *
 * The account is a fake `WranglerCommand` that behaves like the Vectorize API
 * for the calls this CLI makes: read, create, create-metadata-index, list.
 */

import { describe, expect, test } from "bun:test";
import { model, schema, t } from "../src/schema";
import { DeployRefused, provisionAndDeploy, type DeployConfig, type WranglerCommand } from "../src/cli/onboarding";
import {
  deriveVectorizeIndexName,
  provisionVectorize,
  resolveVectorizeDeclaration,
  type VectorizeDeploymentConfig,
} from "../src/cli/vectorize";

const DIMENSIONS = 768;

const appSchema = schema({
  note: model({
    title: t.string(),
    archived: t.boolean().default(false),
    embedding: t.vector({ dimensions: DIMENSIONS }).optional(),
  }),
});

const INDEX = "tapedb-app-note";

type Metadata = { propertyName: string; type: "string" | "number" | "boolean" };

interface FakeOptions {
  index?: { dimensions: number; metric: string };
  metadata?: Metadata[];
  /** Answer the first read as missing, then report the index after a lost create. */
  loseCreateRace?: boolean;
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
        stdout: JSON.stringify({ name: INDEX, dimensions: state.index.dimensions, metric: state.index.metric }),
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
        // The index is now real, but this deploy is told it lost.
        return { status: 1, stdout: "", stderr: "A Vectorize index with that name already exists." };
      }
      return { status: 0, stdout: "created", stderr: "" };
    }
    if (verb === "list-metadata-indexes" && target === INDEX) {
      return { status: 0, stdout: JSON.stringify(state.metadata), stderr: "" };
    }
    if (verb === "create-metadata-index" && target === INDEX) {
      state.metadata.push({
        propertyName: String(args[args.indexOf("--property-name") + 1]),
        type: String(args[args.indexOf("--type") + 1]) as Metadata["type"],
      });
      return { status: 0, stdout: "created", stderr: "" };
    }
    throw new Error(`unexpected wrangler call: ${args.join(" ")}`);
  };
  const creates = (verb: string) => calls.filter((args) => args[0] === "vectorize" && args[1] === verb);
  return { command, calls, creates, state };
}

function selection(overrides: Partial<VectorizeDeploymentConfig> = {}): DeployConfig {
  return {
    name: "app",
    vars: { ENVIRONMENT: "production" },
    tapedb: {
      vectorize: { model: "note", field: "embedding", filterFields: ["archived"], ...overrides },
    },
  } as DeployConfig;
}

function provision(
  account: ReturnType<typeof fakeAccount>,
  selected: DeployConfig = selection(),
  extra: { jurisdiction?: string; worker?: string } = {}
) {
  return provisionVectorize({
    root: "/tmp/app",
    selected,
    command: account.command,
    account: "account-1",
    worker: extra.worker ?? "app",
    jurisdiction: extra.jurisdiction,
    schema: appSchema,
    log: () => {},
  });
}

describe("the deployment's index", () => {
  test("a fresh deploy creates the index, one metadata index per filter, and records ownership", async () => {
    const account = fakeAccount();
    const selected = selection();
    const result = await provision(account, selected);

    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.index).toBe(INDEX);
    expect(account.creates("create")).toHaveLength(1);
    const create = account.creates("create")[0]!;
    expect(create[create.indexOf("--dimensions") + 1]).toBe(String(DIMENSIONS));
    expect(create[create.indexOf("--metric") + 1]).toBe("cosine");
    expect(account.state.metadata).toEqual([{ propertyName: "archived", type: "boolean" }]);

    // The Worker's binding is part of the deploy, and the ownership record is
    // written into the config the CLI is about to persist.
    expect(selected.vectorize).toEqual([{ binding: "VECTORIZE", index_name: INDEX }]);
    const record = selected.tapedb!.vectorize!.ownership!;
    expect(record).toMatchObject({
      index: INDEX,
      account: "account-1",
      worker: "app",
      model: "note",
      field: "embedding",
      dimensions: DIMENSIONS,
      metric: "cosine",
      filters: [{ property: "archived", type: "boolean" }],
    });
  });

  test("a repeat deploy keeps the index and creates nothing a second time", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", type: "boolean" }],
    });
    const selected = selection({
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
    const result = await provision(account, selected);

    expect(result!.created).toBe(false);
    expect(account.creates("create")).toHaveLength(0);
    expect(account.creates("create-metadata-index")).toHaveLength(0);
    expect(selected.tapedb!.vectorize!.ownership!.index).toBe(INDEX);
    expect(selected.vectorize).toEqual([{ binding: "VECTORIZE", index_name: INDEX }]);
  });

  test("a deploy that loses the creation race converges instead of failing", async () => {
    const account = fakeAccount({ loseCreateRace: true });
    const selected = selection();
    const result = await provision(account, selected);

    expect(result!.created).toBe(false);
    expect(account.state.reads).toBeGreaterThan(0);
    expect(selected.tapedb!.vectorize!.ownership!.index).toBe(INDEX);
    // The metadata index still had to be created: this deploy won the queue.
    expect(account.state.metadata).toEqual([{ propertyName: "archived", type: "boolean" }]);
  });

  test("the derived name is stable, lower case, and survives a long worker name", () => {
    expect(deriveVectorizeIndexName("app", "note")).toBe("tapedb-app-note");
    expect(deriveVectorizeIndexName("My App", "Note")).toBe("tapedb-my-app-note");
    const long = deriveVectorizeIndexName("a".repeat(80), "embedding");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("-embedding")).toBe(true);
    expect(long).toBe(deriveVectorizeIndexName("a".repeat(80), "embedding"));
  });
});

describe("what is refused before traffic reaches the index", () => {
  test("an index of the wrong dimension count", async () => {
    const account = fakeAccount({ index: { dimensions: 512, metric: "cosine" }, metadata: [{ propertyName: "archived", type: "boolean" }] });
    await expect(provision(account)).rejects.toThrow(/512 dimensions, but note\.embedding declares 768/);
    expect(account.creates("create-metadata-index")).toHaveLength(0);
  });

  test("an index with another metric", async () => {
    const account = fakeAccount({ index: { dimensions: DIMENSIONS, metric: "euclidean" }, metadata: [{ propertyName: "archived", type: "boolean" }] });
    await expect(provision(account)).rejects.toThrow(/uses euclidean; this engine searches with cosine/);
  });

  test("a metadata index of the wrong type", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", type: "string" }],
    });
    await expect(provision(account)).rejects.toThrow(/string metadata index for archived, but note\.archived is a boolean/);
  });

  test("an index this deployment cannot prove it created", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", type: "boolean" }],
    });
    await expect(provision(account)).rejects.toThrow(/no ownership record for it/);
  });

  test("an index the config names is adopted and recorded", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", type: "boolean" }],
    });
    // The upgrade path: an index created by hand before this CLI provisioned it.
    const selected = selection({ index: INDEX });
    const result = await provision(account, selected);
    expect(result!.created).toBe(false);
    expect(selected.tapedb!.vectorize!.ownership!.account).toBe("account-1");
  });

  test("an ownership record that no longer matches the deployment", async () => {
    const account = fakeAccount({
      index: { dimensions: DIMENSIONS, metric: "cosine" },
      metadata: [{ propertyName: "archived", type: "boolean" }],
    });
    const selected = selection({
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
    await expect(provision(account, selected)).rejects.toThrow(/account another-account vs account-1/);
  });

  test("a residency-restricted deployment, before any Vectorize call", async () => {
    const account = fakeAccount();
    await expect(provision(account, selection(), { jurisdiction: "eu" })).rejects.toThrow(/residency/);
    await expect(provision(account, selection(), { jurisdiction: "fedramp" })).rejects.toThrow(/residency/);
    expect(account.calls).toHaveLength(0);
  });

  test("a declaration that does not name a vector attribute", () => {
    const resolved = () =>
      resolveVectorizeDeclaration({ model: "note", field: "title" }, appSchema);
    expect(resolved).toThrow(/must name a t\.vector\(\{ dimensions \}\) attribute; note\.title is a string/);
  });

  test("a filter that is not a flat scalar, and the vector field itself", () => {
    expect(() => resolveVectorizeDeclaration({ model: "note", field: "embedding", filterFields: ["embedding"] }, appSchema)).toThrow(
      /names the vector attribute itself/
    );
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
        return {
          status: 0,
          stdout: JSON.stringify({ name: INDEX, dimensions: 512, metric: "cosine" }),
          stderr: "",
        };
      }
      if (args[0] === "deploy") throw new Error("the Worker must not be uploaded");
      return { status: 0, stdout: "", stderr: "" };
    };
    const selected = selection({ ownership: undefined });
    const status = await provisionAndDeploy(
      "/tmp/app",
      selected,
      undefined,
      true,
      () => command,
      async (scoped, context) => {
        try {
          await provisionVectorize({
            root: "/tmp/app",
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

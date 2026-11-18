// Type-level checks, compiled by `bun run typecheck`; never run.
import { createClient } from "../../src/model/client";
import { model, schema, t } from "../../src/schema";

const app = schema({
  order: model({
    reference: t.string(),
    status: t.enum(["pending", "paid", "shipped"]).default("pending"),
    channel: t.enum(["web", "app"]).optional(),
  }),
});

declare const db: ReturnType<typeof createClient<typeof app.models>>;

export function enums() {
  // The declared values are the only ones that compile.
  db.order.create({ data: { reference: "A-1", status: "paid", channel: "app" } });
  db.order.findMany({ where: { status: "pending", channel: { in: ["web", "app"] } } });

  // @ts-expect-error "PICKED" is not a declared value.
  db.order.create({ data: { reference: "A-2", status: "PICKED" } });
  // @ts-expect-error a filter is narrowed too.
  db.order.findMany({ where: { status: "nope" } });
  // @ts-expect-error an optional enum still takes only its values.
  db.order.create({ data: { reference: "A-3", status: "paid", channel: "post" } });
}

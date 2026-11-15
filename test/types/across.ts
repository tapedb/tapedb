import { createClient } from "../../src/model/client";
import { useLive } from "../../src/react/index";
import { schema, model, t } from "../../src/schema";
const s = schema({ task: model({ title: t.string(), points: t.number() }) });
declare const db: ReturnType<typeof createClient<typeof s.models>>;
export async function acrossTypes() {
  const across = db.$across(["a", "b"], { getToken: async (workspaceId) => workspaceId });
  const rows = await across.task.findMany({ orderBy: { points: "desc" } });
  const where: string = rows[0].workspaceId;
  const title: string = rows[0].title;
  const picked = await across.task.findMany({ select: { title: true } });
  // @ts-expect-error Not selected.
  picked[0].points;
  const page = await across.task.findPage({ take: 10 });
  const cursor: string | null = page.cursor;
  const total: number = await across.task.count();
  // @ts-expect-error Reads only: writes go to one workspace.
  across.task.create({ data: { title: "x", points: 1 } });
  // @ts-expect-error Not a model of this schema.
  across.nope;
  const live = useLive(across.task.findMany());
  const failed: string[] = Object.keys(live.errors);
  return [where, title, cursor, total, failed];
}

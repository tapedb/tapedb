// A live ordered list keeps its order through inserts and moves, in workerd.
import { randomUUID } from "node:crypto";
import { createClient } from "@tapedb/tapedb";
import { BASE, s, until } from "./common.mjs";
const db = createClient({ schema: s, url: BASE, workspace: randomUUID() });
await db.task.create({ data: { title: "B" } });
await db.task.create({ data: { title: "D" } });
const seen = [];
const stop = db.task.findMany({ orderBy: { title: "asc" }, select: { title: true } }).subscribe((st) => st.data && seen.push(st.data.map((r) => r.title).join("")));
await until(() => seen.at(-1) === "BD", "initial", seen);
const c = await db.task.create({ data: { title: "C" } });
await until(() => seen.at(-1) === "BCD", "insert mid-list", seen);
await db.task.update({ where: { id: c.id }, data: { title: "A" } });
await until(() => seen.at(-1) === "ABD", "move to front", seen);
stop(); db.$close();
console.log("drive-live-order: ok");

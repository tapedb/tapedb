// The built-in claim limits in workerd and on Cloudflare: a subject's bucket
// is exact and shared, and one subject's limit leaves another's alone.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE } from "./common.mjs";

const workspaceId = randomUUID();
const claim = (user) =>
  fetch(`${BASE}/_e2e/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-e2e-user": user },
    body: JSON.stringify({ workspaceId }),
  });

const user = `limits-${randomUUID()}`;
// Concurrent requests: the bucket must count them exactly, not per request path.
const statuses = (await Promise.all(Array.from({ length: 6 }, () => claim(user)))).map((response) => response.status);
assert.deepEqual(statuses.filter((status) => status === 200).length, 3, `statuses ${statuses}`);
assert.deepEqual(statuses.filter((status) => status === 429).length, 3, `statuses ${statuses}`);

const refused = await claim(user);
assert.equal(refused.status, 429);
assert.equal((await refused.json()).error.code, "rate_limited");

const other = await claim(`limits-${randomUUID()}`);
assert.equal(other.status, 200);
assert.ok((await other.json()).token);

const anonymous = await fetch(`${BASE}/_e2e/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
assert.equal(anonymous.status, 401);
console.log("claim-limits: ok");

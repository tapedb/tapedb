import { defineTapeDB } from "tapedb/worker";

import { schema } from "./tapedb.schema";

const tapedb = defineTapeDB({
  schema,
  // Serves POST /_tapedb/claim so local development needs no session. Two
  // things must hold for it to answer: this flag, and TAPEDB_DEV_CLAIMS=true
  // in the environment. `tapedb dev`, and the command in the README, pass the
  // variable on the command line; `wrangler deploy` never does, and
  // ENVIRONMENT=production also refuses it.
  devClaims: true,
});

// Cloudflare requires the Durable Object class to be exported by the Worker
// that declares the binding.
export const WorkspaceRoom = tapedb.WorkspaceRoom;

export default tapedb.worker;

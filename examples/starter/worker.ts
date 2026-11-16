import { defineTapeDB } from "@tapedb/tapedb/worker";

import schema from "./tapedb.schema";
import { migrations } from "./tapedb/migrations.gen";

const tapedb = defineTapeDB({
  schema,
  migrations,
  // Serves POST /_tapedb/claim so local development needs no session. It
  // answers only when this flag is on AND TAPEDB_DEV_CLAIMS=true is in the
  // environment: `tapedb dev` passes that on the command line, `tapedb deploy`
  // refuses to ship it, and ENVIRONMENT=production refuses the route too.
  devClaims: true,
});

// Cloudflare requires the Durable Object class to be exported by the Worker
// that declares the binding.
export const WorkspaceRoom = tapedb.WorkspaceRoom;

export default tapedb.worker;

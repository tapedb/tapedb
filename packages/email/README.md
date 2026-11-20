# @tapedb/email

Email sending for [tapedb](https://tapedb.dev), a typed database for Cloudflare:
one mailer over Cloudflare Email Service, with a local inbox during development.

```bash
npm install @tapedb/tapedb @tapedb/email
```

```ts
import { mailer } from "@tapedb/email";

const email = mailer({ from: "no-reply@<your-domain>", binding: env.EMAIL });
await email.send({ to: "someone@<their-domain>", subject: "Hello", text: "Hi" });
```

`mailer()` validates headers and body size, sends through the `send_email`
binding in production and captures to the local inbox under `tapedb dev`.
`npx @tapedb/cli init --auth` wires it into the generated `auth.ts`.

## Two import paths, one module

`@tapedb/email` is an alias, not a fork: it re-exports
`@tapedb/tapedb/email` and pins the exact `@tapedb/tapedb` version it ships
with. Either path works, and the subpath stays supported:

```ts
import { mailer } from "@tapedb/email";       // preferred
import { mailer } from "@tapedb/tapedb/email"; // same module, still supported
```

import { expect, spyOn, test } from "bun:test";
import { mailer } from "../src/email";
import { capturedEmails } from "../src/email/dev";
test("production sends through the Cloudflare binding", async () => {
  const messages: unknown[] = [];
  const email = mailer({
    from: "support@example.test",
    binding: {
      async send(message) {
        messages.push(message);
        return { messageId: "one" };
      },
    },
  });
  expect(
    await email.send({
      to: "user@example.test",
      subject: "Hello",
      text: "Welcome",
    }),
  ).toEqual({ messageId: "one" });
  expect(messages).toEqual([
    {
      from: "support@example.test",
      to: "user@example.test",
      subject: "Hello",
      text: "Welcome",
    },
  ]);
});
test("development captures and prints without calling the binding", async () => {
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    let sends = 0;
    const email = mailer({
      from: "support@example.test",
      development: true,
      binding: {
        async send() {
          sends++;
          throw Error("must not send");
        },
      },
    });
    await email.send({
      to: "local@example.test",
      subject: "Reset",
      text: "https://local.test/reset",
    });
    expect(sends).toBe(0);
    expect(capturedEmails().at(-1)).toMatchObject({
      subject: "Reset",
      text: "https://local.test/reset",
    });
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
test("missing production binding fails rather than silently capturing", async () => {
  await expect(
    mailer({ from: "a@example.test" }).send({
      to: "b@example.test",
      subject: "Hello",
      text: "Hi",
    }),
  ).rejects.toThrow("send_email binding");
});
test("invalid headers and empty messages fail before sending", async () => {
  const email = mailer({ from: "a@example.test" });
  await expect(
    email.send({
      to: "b@example.test",
      subject: "Hello\r\nBcc: other@example.test",
      text: "Hi",
    }),
  ).rejects.toThrow("headers");
  await expect(
    email.send({ to: "b@example.test", subject: "Hello" }),
  ).rejects.toThrow("text or html");
});

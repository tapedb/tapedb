import { captureEmail } from "./dev";
export interface MailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}
/** The structured send_email API supplied by Cloudflare Email Service. */
export interface EmailBinding {
  send(message: MailMessage & { from: string }): Promise<{ messageId: string }>;
}
export interface CapturedEmail extends MailMessage {
  from: string;
  messageId: string;
  createdAt: number;
}
export interface MailerOptions {
  from: string;
  binding?: EmailBinding;
  /** Local development only. Captures messages and prints them without sending. */
  development?: boolean;
}
export function mailer({ from, binding, development = false }: MailerOptions) {
  return {
    async send(message: MailMessage): Promise<{ messageId: string }> {
      if (
        !from.trim() ||
        !message.to.trim() ||
        /[\r\n]/.test(from + message.to + message.subject)
      )
        throw new TypeError("Invalid email headers");
      if (!message.text && !message.html)
        throw new TypeError("Email needs text or html");
      if (
        new TextEncoder().encode(JSON.stringify(message)).byteLength >
        256 * 1024
      )
        throw new TypeError("Email exceeds 256 KiB");
      if (development) {
        const email = {
          ...message,
          from,
          messageId: crypto.randomUUID(),
          createdAt: Date.now(),
        };
        captureEmail(email);
        console.info("[tapedb email — local capture]", JSON.stringify(email));
        return { messageId: email.messageId };
      }
      if (!binding)
        throw new Error("Cloudflare send_email binding is not configured");
      return binding.send({ ...message, from });
    },
  };
}

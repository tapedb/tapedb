import type { RoleClaim } from "../claims";
import { apiError } from "../http";
import { readTrustedRoleClaim } from "./trusted-claim";
import { TxError } from "./tx-types";

/**
 * The WebSocket accept path shared by `WorkspaceRoom` and `DocumentRoom`.
 *
 * Both accepted a socket, verified the trusted role claim and reported a
 * rejection with `session:error` + close 1008 in copy-pasted code. This is the
 * authorization path for both objects, so it lives in one place: drift between
 * two copies would mean one socket class accepting a claim the other rejects.
 *
 * Callers own what happens after the accept (session handshake payload,
 * subscription state, document sync).
 */

export interface AcceptSocketOptions<Attachment> {
  ctx: DurableObjectState;
  request: Request;
  workspaceId: string;
  /** Builds the attachment persisted across hibernation. */
  buildAttachment: (claim: RoleClaim, clientId: string) => Attachment;
  /**
   * Optional authorization floor applied after the claim is verified.
   * Return a rejection to refuse the socket.
   */
  authorize?: (claim: RoleClaim) => { code: string; message: string } | null;
}

export type AcceptSocketResult<Attachment> =
  | {
      accepted: true;
      client: WebSocket;
      server: WebSocket;
      claim: RoleClaim;
      attachment: Attachment;
    }
  | { accepted: false; response: Response };

function rejectSocket(
  client: WebSocket,
  server: WebSocket,
  code: string,
  message: string
): Response {
  try {
    server.send(JSON.stringify({ type: "session:error", code, message }));
  } catch {
    // A socket that cannot be written to is closed below anyway.
  }
  try {
    server.close(1008, "role claim rejected");
  } catch {
    // Already closed.
  }
  return new Response(null, { status: 101, webSocket: client });
}

export function acceptVerifiedSocket<Attachment>(
  options: AcceptSocketOptions<Attachment>
): AcceptSocketResult<Attachment> {
  const { ctx, request, workspaceId } = options;

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return {
      accepted: false,
      response: apiError(
        426,
        "upgrade_required",
        "Connect with a WebSocket upgrade request."
      ),
    };
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  // Hibernation-friendly accept: the object can be evicted while the socket
  // stays open, so the verified claim lives in the serialized attachment.
  ctx.acceptWebSocket(server);

  let claim: RoleClaim;
  try {
    claim = readTrustedRoleClaim(request, workspaceId);
  } catch (error) {
    const txError = error instanceof TxError ? error : null;
    return {
      accepted: false,
      response: rejectSocket(
        client,
        server,
        txError?.code ?? "permission_denied",
        txError?.message ?? "A verified role claim is required."
      ),
    };
  }

  const refusal = options.authorize?.(claim) ?? null;
  if (refusal !== null) {
    return {
      accepted: false,
      response: rejectSocket(client, server, refusal.code, refusal.message),
    };
  }

  const attachment = options.buildAttachment(claim, crypto.randomUUID());
  server.serializeAttachment(attachment);

  return { accepted: true, client, server, claim, attachment };
}

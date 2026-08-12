import { getHeader, type H3Event } from "h3";

export type GatewayUser = {
  authenticated: boolean;
  uid: string | null;
  username: string | null;
  isAdmin: boolean;
};

export function getGatewayUser(event: H3Event): GatewayUser {
  // These headers are trusted only when the process is reachable through the fnOS Unix socket.
  if (!process.env.FNOS_SOCKET_PATH) {
    return {
      authenticated: false,
      uid: null,
      username: null,
      isAdmin: false
    };
  }

  const uid = getHeader(event, "x-trim-userid") || null;
  const username = getHeader(event, "x-trim-username") || null;

  return {
    authenticated: Boolean(uid),
    uid,
    username,
    isAdmin: getHeader(event, "x-trim-isadmin") === "true"
  };
}

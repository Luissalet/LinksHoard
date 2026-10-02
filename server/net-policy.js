// Which addresses Links Hoard may reach on the user's behalf (pages, feeds, media links).
//
// By default only the public internet: the shared fetcher (hoard-commons/web.js) refuses loopback, private, link-local and cloud
// metadata addresses, and checks every redirect hop. A user who saves pages from a server on their own network (a NAS, a wiki on
// the LAN) opts in with LINKS_ALLOW_PRIVATE_URLS=1, which switches to the "operator_local" profile of the commons. The variable is
// read on every call so a test (or a settings change plus restart) never needs a reload.
import { envFlag } from "./hoard-commons/server.js";
import { PUBLIC, OPERATOR_LOCAL } from "./hoard-commons/web.js";

export const allowPrivateUrls = (env = process.env) => envFlag("LINKS_ALLOW_PRIVATE_URLS", false, env);

/** The safety profile of the commons for fetches the person asked for. */
export const fetchProfile = (env = process.env) => (allowPrivateUrls(env) ? OPERATOR_LOCAL : PUBLIC);

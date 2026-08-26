/** Boot-time checks for deployed (non-loopback) binds. */

export function isLoopbackHost(host) {
	return !host || host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

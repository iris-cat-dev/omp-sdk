Request a public HTTP/HTTPS URL with an explicit method, string headers and UTF-8 body. The default method is GET; CONNECT and protocol tunnels are forbidden. Explicit Authorization, API-key and Cookie headers may be supplied. No credentials are read from the host.

Destinations must resolve entirely to globally reachable addresses. Each redirect resolves and validates DNS again, and its connection is pinned to an approved address. Localhost, private/reserved addresses, metadata, mapped IPv6, translation and tunnel ranges, URL credentials, and transport/proxy header overrides are forbidden. No ambient host proxies, Cookie jar, or account credentials are used. HTTPS verifies the original hostname and certificate.

Limits: URL 8 KiB, method 64 characters, request headers 128 entries / 32 KiB, request body 1 MiB, response headers 32 KiB, wire response and decoded UTF-8 text each 1 MiB, at most 5 redirects, and 30 seconds overall. Cancellation closes owned DNS queries, sockets and response streams. HTTP redirect method/body semantics are preserved; cross-origin redirects remove every explicit request header.

Returns JSON `{ "url": ..., "status": ..., "headers": ..., "body": ... }` containing the final URL, status, lowercase response headers and complete UTF-8 text. Gzip, deflate and Brotli responses are decoded within the limits. HTTP error statuses remain readable responses for the caller to handle; transport failures, forbidden destinations and limit violations are tool errors.

HEAD and HTTP no-content statuses return an empty `body` while preserving response headers. Their representation `Content-Length` and `Content-Encoding` do not trigger body limits or decompression.

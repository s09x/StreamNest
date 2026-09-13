# Local HTTP/2 test certificate

These are public, synthetic TLS credentials for the loopback test server only.
No external service, account, or user data uses this key. The certificate names
only `localhost` and `127.0.0.1` and is intentionally long-lived for repeatable CI.

Tests trust this certificate only in an isolated diagnostic worker through
`NODE_EXTRA_CA_CERTS`. They do not disable TLS verification or change the user's
certificate store. Keep the certificate and key together with the transport tests.

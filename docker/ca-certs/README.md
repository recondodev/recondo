# Corporate CA certificates for Docker builds

Drop `.pem` or `.crt` files here if your network performs TLS inspection
(Zscaler, Palo Alto, Blue Coat, etc.) and Docker builds fail with errors like:

```
SSL peer certificate or SSH remote key was not OK
self-signed certificate in certificate chain
```

The Dockerfiles (`Dockerfile.gateway`, `Dockerfile.api`, `Dockerfile.dashboard`)
copy this directory into their build contexts and install any certs they find:

- `Dockerfile.gateway` (Amazon Linux): installs to
  `/etc/pki/ca-trust/source/anchors/` (system trust, used by curl/openssl)
  AND copies into `/home/recondo/.recondo/ca/` so the gateway's rustls
  upstream client picks them up via `load_extra_ca_certs` at runtime —
  rustls doesn't read the system trust store, so both copies are needed.
- `Dockerfile.api` / `Dockerfile.dashboard` (Node Alpine): concatenates into
  a bundle and sets `NODE_EXTRA_CA_CERTS`

If the directory is empty, the steps are no-ops and builds behave as before.

## Typical usage

```bash
cp ~/.recondo/CA.pem docker/ca-certs/
just fullstack
```

Actual cert files are gitignored — only `.gitkeep` and this README are tracked.

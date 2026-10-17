# Extra CA certificates for the image build

Only needed behind a TLS-intercepting (corporate) proxy. Drop the proxy's root CA here as
`*.crt` or `*.pem`; the `base` stage of `services/local/Dockerfile` appends every such file to
the system bundle (`/etc/ssl/certs/ca-certificates.crt`) and points `NODE_EXTRA_CA_CERTS` at
it, so `corepack`, `pnpm install` and `wget` trust the proxy. Leave the folder empty otherwise.

Certificates placed here are ignored by git (see `.gitignore` next to this file).

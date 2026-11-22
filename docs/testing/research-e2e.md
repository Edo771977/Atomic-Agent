# Local research verification fixture

Status: current
Owner: repository maintainers

Copy [reference.md](fixtures/research/reference.md) and [with-url.md](fixtures/research/with-url.md) into a temporary project folder. In that folder, give Atomic Agent the [fixture prompt](fixtures/research/prompt.txt) using a local model and approve the local reads if asked. The first report should pass. The second should list the source URL as unverified and return uncheckable. Both runs work with the network disabled.

The [automated test](../../src/tools/verify/delivery-check.test.ts) also exercises missing citations, date warnings, a restricted Fusion contract, link limits, private redirects and an approved 404 using an inert simulated transport.

```sh
npx vitest run src/tools/verify/delivery-check.test.ts
```

# infra-tests/

Home for chaos/fault-injection and crash-consistency suites — the kind of
testing that kills real processes, partitions real networks, and mutates
real database state to verify what survives, as opposed to the mocked
unit tests under `backend-api/__tests__/` and `workers/provisioner/*.test.js`
or the browser-driven flows under `e2e/`. See [chaos engineering](https://en.wikipedia.org/wiki/Chaos_engineering)
and [Jepsen](https://jepsen.io/)-style testing for the lineage.

Each feature that needs this style of testing gets its own subdirectory
here, with its own `README.md`, `lib/`, and `run-all.sh`:

- [`logging-control-plane/`](logging-control-plane/README.md) — segment
  writer, log/gateway collectors, retention sweeper, storage migration,
  search, export, deletion recovery, traces, k8s parity.

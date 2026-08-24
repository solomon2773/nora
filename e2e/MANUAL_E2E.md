# Manual E2E — release verification runbook

The hand-run counterpart to the automated suites. It covers the golden path a
new self-hoster actually walks, in the order they walk it, because that is the
path a launch converts visitors into — and the one where a failure costs a star
instead of earning one.

Run it end to end before tagging a release. Every step states what you do, what
you should see, and what to capture when you do not see it.

**Scope note.** `specs/` covers browser journeys and `REAL_TESTS.md` covers the
real-credential deploy matrix. This file covers what neither can: a genuinely
clean host, the upgrade path, and the destructive backup/restore and migration
flows that need a human deciding when to pull the plug.

---

## Results

Fill this in as you go. Anything not `PASS` needs an issue linked.

| #   | Area                                   | Result | Notes / issue |
| --- | -------------------------------------- | ------ | ------------- |
| A   | Fresh install on a clean machine       |        |               |
| B   | Zero-key demo, no external credentials |        |               |
| C   | OpenClaw deploy / chat / restart       |        |               |
| D   | Hermes deploy / chat / restart         |        |               |
| E   | Backup → delete → restore              |        |               |
| F   | Migration upload → deploy              |        |               |
| G   | Kubernetes smoke                       |        |               |
| H   | Upgrade from previous release          |        |               |

Release version under test: `________` Host / OS: `________` Date: `________`

---

## Before you start

**Use a genuinely clean host.** A machine that has run Nora before hides the
most common first-run failures — a stale `nora-openclaw-agent:local`, a warm
image cache, leftover volumes. A fresh VM or a throwaway cloud box is the point,
not an inconvenience. If you must reuse a host, reset it first:

```bash
docker compose down -v --remove-orphans
docker volume ls -q | grep -E '^nora' | xargs -r docker volume rm
docker image rm nora-openclaw-agent:local 2>/dev/null || true
```

**Requirements:** Docker + Docker Compose, OpenSSL, Git, ~8 GB free disk (Hermes
images are large), and one real LLM provider key for parts C, D and F. Part B is
the one that must work with no key at all.

Throughout, `BASE` is the URL you reach Nora on — `http://localhost:8080` by
default:

```bash
export BASE=http://localhost:8080
```

Several steps use the API directly. Get a token once:

```bash
TOKEN=$(curl -sS -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}' | jq -r .token)
```

---

## A. Fresh install on a clean machine

| Step | Do                                                                                    | Expect                                                                                           |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A1   | `git clone` the repo at the release tag, then `./setup.sh` (`./setup.ps1` on Windows) | Installer verifies Docker/OpenSSL, generates secrets, prompts for platform mode and access mode  |
| A2   | Choose **self-hosted**, **local only**, and create the bootstrap admin when offered   | Finishes and runs `docker compose up -d`                                                         |
| A3   | `docker compose ps`                                                                   | Every service `running`; `postgres`, `redis`, `backend-api`, `worker-provisioner` also `healthy` |
| A4   | Open `$BASE`                                                                          | Marketing site renders, no console errors                                                        |
| A5   | Open `$BASE/app`                                                                      | Redirects to login (or straight to the dashboard if A2 created the admin)                        |
| A6   | `curl -fsS "$BASE/api/health"`                                                        | `200`                                                                                            |

- [ ] **A passes**

> `.env` should be mode `0600` on macOS/Linux/WSL. `ls -l .env` — if it is
> broader than that, stop and file it: it holds `JWT_SECRET` and
> `ENCRYPTION_KEY`.

**If A fails:** capture `docker compose ps`, `docker compose logs backend-api`
and `docker compose logs worker-provisioner`, plus the installer's full output.

---

## B. Zero-key demo (no external credentials)

The highest-stakes item here. It is the first thing a visitor tries, and it must
work on a machine with no API key of any kind. **Do this before adding a provider
key** — once a key is saved you can no longer tell whether the demo path works
on its own.

| Step | Do                                                                                                                        | Expect                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| B1   | Open `$BASE/signup?intent=demo` and create an account                                                                     | Lands in the operator app                                         |
| B2   | Click **Launch local Docker demo — no API key**                                                                           | Deploy starts without prompting for credentials                   |
| B3   | Wait for the agent to report **running**                                                                                  | Typically under a minute on a warm host; first run pulls an image |
| B4   | Open the agent → **OpenClaw** tab → **Chat**, send `hello`                                                                | An assistant reply arrives                                        |
| B5   | `curl -sS "$BASE/api/llm-providers" -H "Authorization: Bearer $TOKEN" \| jq '[.[]\|select(.provider=="demo")] \| length'` | `1` — exactly one demo provider, not one per attempt              |

- [ ] **B passes**

**If B fails:** this blocks launch on its own. Capture the browser network tab
for `POST /api/agents/activate-demo`, plus `docker compose logs worker-provisioner`.

---

## C. OpenClaw deploy / chat / restart

Add a real provider key first: **Settings → add your provider key**.

| Step | Do                                                                                                         | Expect                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| C1   | `$BASE/app/deploy` → name the agent → **Next: choose skills** → **Deploy agent & open validation**         | Redirects to the agent detail page                                                                                         |
| C2   | Watch the status                                                                                           | Reaches **running**. Cold first run can take minutes while the image builds                                                |
| C3   | **OpenClaw** tab → **Chat**, send a prompt                                                                 | A real model reply arrives                                                                                                 |
| C4   | **Logs** tab                                                                                               | Streams live; no repeating stack traces                                                                                    |
| C5   | **Terminal** tab → run `printenv \| sort`                                                                  | Shell responds. Provider keys appear here (expected — it is the agent's own environment); they must **not** appear in Logs |
| C6   | **Metrics** tab                                                                                            | Populates within a minute or two                                                                                           |
| C7   | Restart via `curl -sS -X POST "$BASE/api/agents/<id>/restart" -H "Authorization: Bearer $TOKEN"` or the UI | Returns to **running**, and chat still works afterwards                                                                    |
| C8   | Repeat C3 after the restart                                                                                | Reply arrives — restart did not lose runtime auth                                                                          |

- [ ] **C passes**

> C8 is the one to be strict about. A restart that leaves the runtime unable to
> authenticate is exactly the class of bug #340 was, and it only shows up on the
> second chat, not the first.

---

## D. Hermes deploy / chat / restart

| Step | Do                                               | Expect                                                       |
| ---- | ------------------------------------------------ | ------------------------------------------------------------ |
| D1   | Deploy again, choosing runtime family **Hermes** | Deploy accepted                                              |
| D2   | Wait for **running**                             | First run pulls a large image — allow well over five minutes |
| D3   | **Hermes WebUI** tab                             | Dashboard loads embedded. **No 401**                         |
| D4   | Send a chat message from that tab                | Reply arrives; the model picker is populated, not empty      |
| D5   | **Skills** sub-tab                               | Lists skills without error                                   |
| D6   | Restart the agent, then repeat D3 and D4         | Dashboard still loads and chat still replies                 |

- [ ] **D passes**

> D3 and D6 are the regression surface for #340. The symptom was
> `{"error":"Invalid gateway API key (API_SERVER_KEY)"}` on every Hermes agent,
> and because `$HERMES_HOME` is a persistent volume it survived restarts. If you
> see a 401 here, capture `docker exec <container> env | grep API_SERVER_KEY` and
> `docker exec <container> grep API_SERVER_KEY $HERMES_HOME/.env` — if those two
> differ, it is back.

---

## E. Backup → delete → restore

The disaster-recovery path. It is only meaningful if you actually delete the
agent — restoring one that still exists proves nothing.

| Step | Do                                                                                                                                                                     | Expect                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| E1   | On the OpenClaw agent from C: **Backups** tab → create a backup                                                                                                        | Reaches `ready` or `ready_with_warnings`                   |
| E2   | Note the backup id and download it                                                                                                                                     | File downloads and is non-trivial in size                  |
| E3   | **Delete the agent entirely**                                                                                                                                          | Gone from the fleet                                        |
| E4   | `curl -sS "$BASE/api/backups" -H "Authorization: Bearer $TOKEN" \| jq '.backups[] \| {id, agent_exists}'`                                                              | The backup is **still listed**, with `agent_exists: false` |
| E5   | `curl -sS -X POST "$BASE/api/backups/<backupId>/restore" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"mode":"copy"}' \| jq '.draft.id'` | A **non-null** draft id                                    |
| E6   | Deploy that draft from `$BASE/app/deploy`                                                                                                                              | New agent reaches **running**                              |
| E7   | Chat with the restored agent                                                                                                                                           | Replies, and prior state is present                        |

- [ ] **E passes**

> E4 and E5 are the regressions for #338 and #339. Before those fixes E4 returned
> `404 Agent not found` and E5 returned `id: null`, which together made a backup
> unrecoverable through the product once its agent was gone. A `null` at E5 means
> #339 is back; a 404 at E4 means #338 is.

---

## F. Migration upload → deploy

| Step | Do                                                                     | Expect                                               |
| ---- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| F1   | `$BASE/app/deploy` → migrate/restore mode → upload the archive from E2 | Draft preview renders with a name and runtime family |
| F2   | Check the draft id in the network response                             | **Non-null**                                         |
| F3   | Deploy the draft                                                       | Deploy button is enabled and the deploy is accepted  |
| F4   | Wait for **running**, then chat                                        | Replies                                              |

- [ ] **F passes**

> If the deploy button stays disabled at F3, look at the draft id first — the UI
> gates on `migrationDraft?.id`, so a null id disables it with no visible reason.

---

## G. Kubernetes smoke

Needs a host that can run kind — **not** an LXC container, where kubeadm fails
with `required cgroups disabled`.

```bash
cd e2e && npm ci && npm run smoke:k8s-kind
```

| Step | Expect                                                                     |
| ---- | -------------------------------------------------------------------------- |
| G1   | Cluster comes up and Calico rolls out                                      |
| G2   | The OpenClaw agent image builds and loads into the node                    |
| G3   | Control plane starts and registers the cluster                             |
| G4   | Agents deploy across the configured runtime families and reach **running** |
| G5   | Script exits `0`                                                           |

- [ ] **G passes**

If it stalls with agents stuck in `deploying`, check endpoints before assuming a
networking fault:

```bash
kubectl -n openclaw-agents get svc,endpoints
kubectl -n openclaw-agents get pods
kubectl -n openclaw-agents describe pod <pod> | sed -n '/Events/,$p'
```

`ENDPOINTS <none>` with a `1/1 Running` pod means the pod is not _Ready_ — an
unready pod is never an endpoint, so the node port has nothing to route to. Look
at the startup probe, not the network. A `connection refused` on 18789 usually
means the agent image lacks a baked-in OpenClaw and is on the slow
install-from-npm path.

---

## H. Upgrade from previous release

The path every existing user takes, and the one most likely to be skipped.

| Step | Do                                                                                               | Expect                                |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------- |
| H1   | On a **separate** host, install the **previous** release                                         | Comes up healthy                      |
| H2   | Deploy one OpenClaw and one Hermes agent, chat with both                                         | Both reply                            |
| H3   | Create a backup on one of them                                                                   | Reaches `ready`                       |
| H4   | Upgrade in place to the release under test (`git fetch && git checkout <tag>` then `./setup.sh`) | Completes without manual intervention |
| H5   | `docker compose ps`                                                                              | All services healthy again            |
| H6   | Both pre-existing agents                                                                         | Still listed, still **running**       |
| H7   | Chat with both                                                                                   | Both still reply                      |
| H8   | The backup from H3                                                                               | Still listed and still restorable     |

- [ ] **H passes**

> H7 is worth extra attention for Hermes. The #340 key mismatch lived in a
> persistent volume, so an upgrade inherits whatever the old runtime wrote. A
> pre-existing Hermes agent that 401s after upgrade while a freshly deployed one
> works is a reconciliation bug, not a fresh-install bug.

---

## Attach this to any failure

```bash
docker compose ps > ps.txt
docker compose logs --no-color backend-api > backend-api.log
docker compose logs --no-color worker-provisioner > worker-provisioner.log
docker inspect <agent-container> > agent-inspect.json     # container agents
kubectl -n openclaw-agents get pods,svc,endpoints -o wide > k8s.txt   # k8s agents
```

Plus the release under test, the host OS, whether the host was clean, and the
browser network entry for the failing request.

**Redact before attaching.** `docker inspect` prints the container environment,
which for Hermes includes `API_SERVER_KEY` and for every agent may include
provider keys.

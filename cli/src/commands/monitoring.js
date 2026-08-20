const api = require("../client");

async function metrics() {
  const data = await api.get("/api/monitoring/metrics");
  console.log(JSON.stringify(data, null, 2));
}

async function events(args, flags) {
  const limit = flags.limit ? Number(flags.limit) : 20;
  const query = { limit };
  if (flags.search) query.search = flags.search;
  if (flags.type) query.type = flags.type;
  if (flags.from) query.from = flags.from;
  if (flags.to) query.to = flags.to;

  const data = await api.get("/api/monitoring/events", { query });
  const rows = Array.isArray(data) ? data : data.events || [];
  if (rows.length === 0) {
    console.log("(no events)");
    return;
  }
  for (const event of rows) {
    const when = event.created_at || event.createdAt || "";
    console.log(`[${when}] ${event.type || event.event_type}: ${event.message || ""}`);
  }
}

async function tail(args, flags) {
  const intervalMs = Math.max(1000, Number(flags.interval || 5000));
  console.log(`Tailing events every ${intervalMs}ms (Ctrl+C to stop)…`);
  let lastSeen = null;
  while (true) {
    try {
      const data = await api.get("/api/monitoring/events", { query: { limit: 50 } });
      const rows = (Array.isArray(data) ? data : data.events || []).reverse();
      for (const event of rows) {
        const id = event.id;
        if (lastSeen && id <= lastSeen) continue;
        const when = event.created_at || event.createdAt || "";
        console.log(`[${when}] ${event.type || event.event_type}: ${event.message || ""}`);
        lastSeen = id;
      }
    } catch (err) {
      console.error(`tail error: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = {
  describe: "Read monitoring metrics and the event stream",
  subcommands: {
    metrics: { run: metrics, describe: "Print current monitoring metrics" },
    events: {
      run: events,
      describe:
        "Print recent events (--limit N, --search str, --type type, --from YYYY-MM-DD, --to YYYY-MM-DD)",
    },
    tail: { run: tail, describe: "Stream new events (--interval ms, default 5000)" },
  },
};

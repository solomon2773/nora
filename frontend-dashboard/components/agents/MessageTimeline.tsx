export default function MessageTimeline({ messages }) {
  if (!messages || messages.length === 0) {
    return (
      <div className="text-center py-8 text-slate-400 text-sm">
        No messages yet.
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-96 overflow-y-auto">
      {messages.map((msg) => {
        const isOutbound = msg.direction === "outbound";
        return (
          <div
            key={msg.id}
            className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[75%] rounded-xl px-4 py-2.5 ${
                isOutbound
                  ? "bg-blue-600 text-white rounded-br-sm"
                  : "bg-slate-100 text-slate-900 rounded-bl-sm"
              }`}
            >
              <p className="text-xs leading-relaxed">{msg.content}</p>
              <div
                className={`text-[10px] mt-1 ${
                  isOutbound ? "text-blue-200" : "text-slate-400"
                }`}
              >
                {new Date(msg.created_at).toLocaleTimeString()} ·{" "}
                <span className="font-bold">{msg.direction}</span>
                {msg.metadata?.sender && ` · ${msg.metadata.sender}`}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

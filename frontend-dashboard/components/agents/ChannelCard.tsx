import { MessageSquare, Loader2, Trash2 } from "lucide-react";
import StatusBadge from "./StatusBadge";

export default function ChannelCard({ channel, onDelete, onTest, onToggle }) {
  const typeIcons = {
    slack: "💬",
    discord: "🎮",
    email: "📧",
    webhook: "🌐",
    teams: "💼",
    sms: "📱",
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-slate-50 rounded-lg flex items-center justify-center text-lg">
            {typeIcons[channel.type] || "📡"}
          </div>
          <div>
            <h4 className="text-sm font-bold text-slate-900">{channel.name}</h4>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-slate-400 font-bold uppercase">{channel.type}</span>
              <StatusBadge status={channel.enabled ? "enabled" : "disabled"} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onTest}
            className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
          >
            Test
          </button>
          <button
            onClick={onToggle}
            className={`text-[10px] font-bold px-3 py-1.5 rounded-lg transition-colors ${
              channel.enabled
                ? "bg-yellow-50 text-yellow-600 hover:bg-yellow-100"
                : "bg-green-50 text-green-600 hover:bg-green-100"
            }`}
          >
            {channel.enabled ? "Disable" : "Enable"}
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

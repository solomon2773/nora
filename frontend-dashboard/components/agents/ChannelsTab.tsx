import { useState, useEffect } from "react";
import { MessageSquare, Plus, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import ChannelCard from "./ChannelCard";
import MessageTimeline from "./MessageTimeline";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../Toast";

const channelTypes = [
  { type: "slack", label: "Slack", icon: "💬" },
  { type: "discord", label: "Discord", icon: "🎮" },
  { type: "whatsapp", label: "WhatsApp", icon: "📱" },
  { type: "telegram", label: "Telegram", icon: "✈️" },
  { type: "line", label: "LINE", icon: "🟢" },
  { type: "email", label: "Email (SMTP)", icon: "📧" },
  { type: "webhook", label: "Webhook", icon: "🌐" },
  { type: "teams", label: "Microsoft Teams", icon: "💼" },
  { type: "sms", label: "SMS (Twilio)", icon: "📲" },
];

/* Per-channel config field definitions */
const channelConfigFields = {
  slack: [
    { key: "bot_token", label: "Bot Token", type: "password", required: true, placeholder: "xoxb-..." },
    { key: "channel", label: "Default Channel", type: "text", required: false, placeholder: "#general" },
    { key: "signing_secret", label: "Signing Secret", type: "password", required: false },
  ],
  discord: [
    { key: "webhook_url", label: "Webhook URL", type: "url", required: true, placeholder: "https://discord.com/api/webhooks/..." },
    { key: "bot_token", label: "Bot Token (optional)", type: "password", required: false },
  ],
  whatsapp: [
    { key: "phone_number_id", label: "Phone Number ID", type: "text", required: true, placeholder: "1234567890" },
    { key: "access_token", label: "Access Token", type: "password", required: true, placeholder: "EAABx..." },
    { key: "verify_token", label: "Webhook Verify Token", type: "text", required: false, placeholder: "my-verify-token" },
  ],
  telegram: [
    { key: "bot_token", label: "Bot Token", type: "password", required: true, placeholder: "123456:ABC-DEF..." },
    { key: "chat_id", label: "Default Chat ID", type: "text", required: false, placeholder: "-100123456789" },
  ],
  line: [
    { key: "channel_access_token", label: "Channel Access Token", type: "password", required: true },
    { key: "channel_secret", label: "Channel Secret", type: "password", required: true },
  ],
  email: [
    { key: "smtp_host", label: "SMTP Host", type: "text", required: true, placeholder: "smtp.gmail.com" },
    { key: "smtp_port", label: "SMTP Port", type: "text", required: true, placeholder: "587" },
    { key: "smtp_user", label: "Username", type: "text", required: true },
    { key: "smtp_pass", label: "Password", type: "password", required: true },
    { key: "from_address", label: "From Address", type: "email", required: true, placeholder: "agent@example.com" },
  ],
  webhook: [
    { key: "url", label: "Webhook URL", type: "url", required: true, placeholder: "https://example.com/webhook" },
    { key: "secret", label: "Secret (HMAC)", type: "password", required: false },
  ],
  teams: [
    { key: "webhook_url", label: "Incoming Webhook URL", type: "url", required: true, placeholder: "https://outlook.office.com/webhook/..." },
  ],
  sms: [
    { key: "account_sid", label: "Twilio Account SID", type: "text", required: true, placeholder: "AC..." },
    { key: "auth_token", label: "Auth Token", type: "password", required: true },
    { key: "from_number", label: "From Number", type: "text", required: true, placeholder: "+1234567890" },
    { key: "to_number", label: "Default To Number", type: "text", required: false, placeholder: "+1234567890" },
  ],
};

export default function ChannelsTab({ agentId }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newType, setNewType] = useState("slack");
  const [newName, setNewName] = useState("");
  const [newConfig, setNewConfig] = useState({});
  const [adding, setAdding] = useState(false);
  const [expandedChannel, setExpandedChannel] = useState(null);
  const [messages, setMessages] = useState({});
  const toast = useToast();

  useEffect(() => {
    loadChannels();
  }, [agentId]);

  async function loadChannels() {
    setLoading(true);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels`);
      const data = await res.json();
      setChannels(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to load channels:", e);
    }
    setLoading(false);
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    const fields = channelConfigFields[newType] || [];
    const missingRequired = fields.filter((f) => f.required && !newConfig[f.key]?.trim());
    if (missingRequired.length > 0) {
      toast.error(`Please fill in: ${missingRequired.map((f) => f.label).join(", ")}`);
      return;
    }
    setAdding(true);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newType, name: newName, config: newConfig }),
      });
      if (res.ok) {
        toast.success("Channel created");
        setNewName("");
        setNewConfig({});
        setShowAdd(false);
        loadChannels();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to create channel");
      }
    } catch {
      toast.error("Failed to create channel");
    }
    setAdding(false);
  }

  async function handleDelete(channelId) {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channelId}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Channel deleted");
        loadChannels();
      }
    } catch {
      toast.error("Failed to delete channel");
    }
  }

  async function handleTest(channelId) {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channelId}/test`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast.success("Test message sent");
      } else {
        toast.error(data.error || "Test failed");
      }
    } catch {
      toast.error("Test failed");
    }
  }

  async function handleToggle(channel) {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channel.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !channel.enabled }),
      });
      if (res.ok) {
        toast.success(channel.enabled ? "Channel disabled" : "Channel enabled");
        loadChannels();
      }
    } catch {
      toast.error("Failed to toggle channel");
    }
  }

  async function loadMessages(channelId) {
    if (expandedChannel === channelId) {
      setExpandedChannel(null);
      return;
    }
    setExpandedChannel(channelId);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channelId}/messages?limit=50`);
      const data = await res.json();
      setMessages((prev) => ({ ...prev, [channelId]: Array.isArray(data) ? data.reverse() : [] }));
    } catch {
      setMessages((prev) => ({ ...prev, [channelId]: [] }));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header + Add Button */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
          <MessageSquare size={16} className="text-blue-600" />
          Channels ({channels.length})
        </h3>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus size={12} />
          Add Channel
        </button>
      </div>

      {/* Add Channel Form */}
      {showAdd && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest block mb-1">Type</label>
              <select
                value={newType}
                onChange={(e) => { setNewType(e.target.value); setNewConfig({}); }}
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {channelTypes.map((ct) => (
                  <option key={ct.type} value={ct.type}>
                    {ct.icon} {ct.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest block mb-1">Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. #alerts"
                className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Dynamic Config Fields */}
          {(channelConfigFields[newType] || []).length > 0 && (
            <div className="border-t border-slate-200 pt-3 space-y-2">
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                {channelTypes.find((ct) => ct.type === newType)?.label} Configuration
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(channelConfigFields[newType] || []).map((field) => (
                  <div key={field.key}>
                    <label className="text-[10px] text-slate-500 font-medium block mb-1">
                      {field.label} {field.required && <span className="text-red-400">*</span>}
                    </label>
                    <input
                      type={field.type === "password" ? "password" : "text"}
                      value={newConfig[field.key] || ""}
                      onChange={(e) => setNewConfig((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      placeholder={field.placeholder || ""}
                      className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowAdd(false); setNewConfig({}); }}
              className="px-3 py-1.5 text-[10px] font-bold text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={adding || !newName.trim()}
              className="flex items-center gap-2 px-4 py-1.5 text-[10px] font-bold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {adding && <Loader2 size={12} className="animate-spin" />}
              Create
            </button>
          </div>
        </div>
      )}

      {/* Channel List */}
      {channels.length === 0 && !showAdd ? (
        <div className="text-center py-12 text-slate-400">
          <MessageSquare size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">No channels configured</p>
          <p className="text-xs mt-1">Add a channel to start sending and receiving messages</p>
        </div>
      ) : (
        <div className="space-y-3">
          {channels.map((channel) => (
            <div key={channel.id}>
              <ChannelCard
                channel={channel}
                onDelete={() => handleDelete(channel.id)}
                onTest={() => handleTest(channel.id)}
                onToggle={() => handleToggle(channel)}
              />
              <button
                onClick={() => loadMessages(channel.id)}
                className="mt-1 ml-1 flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-600 transition-colors"
              >
                {expandedChannel === channel.id ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                {expandedChannel === channel.id ? "Hide" : "Show"} Messages
              </button>
              {expandedChannel === channel.id && (
                <div className="mt-2 ml-1 bg-slate-50 border border-slate-100 rounded-xl p-4">
                  <MessageTimeline messages={messages[channel.id] || []} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

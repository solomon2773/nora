import { useState, useEffect } from "react";
import { Puzzle, Search, Loader2 } from "lucide-react";
import IntegrationCard from "./IntegrationCard";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../Toast";

const categories = [
  { id: "all", label: "All" },
  { id: "developer-tools", label: "Developer Tools" },
  { id: "communication", label: "Communication" },
  { id: "ai-ml", label: "AI / ML" },
  { id: "cloud", label: "Cloud" },
  { id: "data", label: "Data" },
  { id: "monitoring", label: "Monitoring" },
  { id: "productivity", label: "Productivity" },
  { id: "crm", label: "CRM" },
  { id: "storage", label: "Storage" },
  { id: "payment", label: "Payment" },
  { id: "social", label: "Social" },
  { id: "analytics", label: "Analytics" },
  { id: "search", label: "Search" },
  { id: "devops", label: "DevOps" },
  { id: "automation", label: "Automation" },
  { id: "ecommerce", label: "E-Commerce" },
];

export default function IntegrationsTab({ agentId }) {
  const [catalog, setCatalog] = useState([]);
  const [installed, setInstalled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const toast = useToast();

  useEffect(() => {
    loadData();
  }, [agentId]);

  async function loadData() {
    setLoading(true);
    try {
      const [catalogRes, installedRes] = await Promise.all([
        fetchWithAuth("/api/integrations/catalog").then((r) => r.json()),
        fetchWithAuth(`/api/agents/${agentId}/integrations`).then((r) => r.json()),
      ]);
      setCatalog(Array.isArray(catalogRes) ? catalogRes : []);
      setInstalled(Array.isArray(installedRes) ? installedRes : []);
    } catch (e) {
      console.error("Failed to load integrations:", e);
    }
    setLoading(false);
  }

  async function handleConnect(catalogItem, configValues = {}) {
    try {
      // Extract token: first password+required field from configFields
      const configFields = catalogItem.configFields || [];
      const tokenField = configFields.find((f) => f.type === "password" && f.required);
      const token = tokenField ? configValues[tokenField.key] || "" : "";

      const res = await fetchWithAuth(`/api/agents/${agentId}/integrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: catalogItem.id, token, config: configValues }),
      });
      if (res.ok) {
        const newIntegration = await res.json();
        toast.success(`${catalogItem.name} connected`);

        // Auto-test after connecting
        let testResult = null;
        try {
          const testRes = await fetchWithAuth(`/api/agents/${agentId}/integrations/${newIntegration.id}/test`, {
            method: "POST",
          });
          testResult = await testRes.json();
        } catch {
          testResult = { success: false, message: "Test could not be completed" };
        }

        loadData();
        return { integration: newIntegration, testResult };
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to connect");
        return { testResult: { success: false, message: data.error || "Failed to connect" } };
      }
    } catch {
      toast.error("Failed to connect integration");
      return { testResult: { success: false, message: "Failed to connect integration" } };
    }
  }

  async function handleTest(integration) {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/integrations/${integration.id}/test`, {
        method: "POST",
      });
      const result = await res.json();
      if (result.success) {
        toast.success(result.message || "Connection verified");
      } else {
        toast.error(result.error || result.message || "Test failed");
      }
      return result;
    } catch {
      toast.error("Test request failed");
      return { success: false, message: "Test request failed" };
    }
  }

  async function handleDisconnect(integration) {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/integrations/${integration.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Integration disconnected");
        loadData();
      } else {
        toast.error("Failed to disconnect");
      }
    } catch {
      toast.error("Failed to disconnect integration");
    }
  }


  const filteredCatalog = catalog.filter((item) => {
    const matchesSearch = !search || item.name?.toLowerCase().includes(search.toLowerCase()) || item.description?.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = activeCategory === "all" || item.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Active Integrations */}
      {installed.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-slate-700">Active Integrations ({installed.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {installed.map((item) => (
              <IntegrationCard
                key={item.id}
                item={item}
                installed={item}
                onDisconnect={() => handleDisconnect(item)}
                onTest={handleTest}
              />
            ))}
          </div>
        </div>
      )}

      {/* Catalog Browser */}
      <div className="space-y-4">
        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
          <Puzzle size={16} className="text-blue-600" />
          Integration Catalog
        </h3>

        {/* Search + Category Filters */}
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search integrations..."
              className="w-full pl-9 pr-4 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3 py-1.5 text-[10px] font-bold rounded-lg whitespace-nowrap transition-colors ${
                  activeCategory === cat.id
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Catalog Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredCatalog.map((item) => {
            const inst = installed.find((i) => i.provider === item.id || i.catalog_id === item.id);
            return (
              <IntegrationCard
                key={item.id}
                item={item}
                installed={inst || null}
                onConnect={(configValues) => handleConnect(item, configValues)}
                onDisconnect={() => {
                  if (inst) handleDisconnect(inst);
                }}
                onTest={handleTest}
              />
            );
          })}
        </div>

        {filteredCatalog.length === 0 && (
          <div className="text-center py-8 text-slate-400 text-sm">
            No integrations found matching your search.
          </div>
        )}
      </div>
    </div>
  );
}

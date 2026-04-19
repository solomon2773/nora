import { useEffect, useMemo } from "react";
import { Loader2 } from "lucide-react";
import {
  activeExecutionTargetFromConfig,
  activeSandboxOptionFromTarget,
  pickExecutionTargetSelection,
  pickRuntimeFamilySelection,
  pickSandboxProfileSelection,
  runtimeFamilyFromConfig,
  visibleRuntimeFamiliesFromConfig,
  visibleExecutionTargetsFromConfig,
  visibleSandboxOptionsFromTarget,
} from "../lib/runtime";

type RuntimePathFieldsProps = {
  backendConfig?: any;
  viewerRole?: string;
  runtimeFamily?: string;
  onRuntimeFamilyChange?: ((value: string) => void) | null;
  executionTarget?: string;
  sandboxProfile?: string;
  onExecutionTargetChange?: ((value: string) => void) | null;
  onSandboxProfileChange?: ((value: string) => void) | null;
  disabled?: boolean;
};

function optionLabel(option) {
  if (!option) return "";
  const maturity = option.maturityLabel ? ` (${option.maturityLabel})` : "";
  const availability = option.available ? "" : " - unavailable";
  return `${option.label}${maturity}${availability}`;
}

export default function RuntimePathFields({
  backendConfig = null,
  viewerRole = "user",
  runtimeFamily = "",
  onRuntimeFamilyChange,
  executionTarget = "",
  sandboxProfile = "",
  onExecutionTargetChange,
  onSandboxProfileChange,
  disabled = false,
}: RuntimePathFieldsProps) {
  const activeRuntimeFamily = useMemo(
    () => runtimeFamilyFromConfig(backendConfig, runtimeFamily),
    [backendConfig, runtimeFamily]
  );
  const visibleRuntimeFamilies = useMemo(
    () => visibleRuntimeFamiliesFromConfig(backendConfig, viewerRole),
    [backendConfig, viewerRole]
  );
  const visibleExecutionTargets = useMemo(
    () =>
      visibleExecutionTargetsFromConfig(
        backendConfig,
        viewerRole,
        activeRuntimeFamily?.id || runtimeFamily
      ),
    [backendConfig, viewerRole, activeRuntimeFamily?.id, runtimeFamily]
  );
  const activeExecutionTarget = useMemo(
    () =>
      activeExecutionTargetFromConfig(
        backendConfig,
        activeRuntimeFamily?.id || runtimeFamily,
        executionTarget
      ),
    [backendConfig, activeRuntimeFamily?.id, runtimeFamily, executionTarget]
  );
  const visibleSandboxOptions = useMemo(
    () => visibleSandboxOptionsFromTarget(activeExecutionTarget, viewerRole),
    [activeExecutionTarget, viewerRole]
  );
  const activeSandboxOption = useMemo(
    () => activeSandboxOptionFromTarget(activeExecutionTarget, sandboxProfile),
    [activeExecutionTarget, sandboxProfile]
  );

  useEffect(() => {
    if (!backendConfig || typeof onRuntimeFamilyChange !== "function") return;
    const nextRuntimeFamily = pickRuntimeFamilySelection(
      backendConfig,
      viewerRole,
      runtimeFamily
    );
    if (nextRuntimeFamily && nextRuntimeFamily !== runtimeFamily) {
      onRuntimeFamilyChange(nextRuntimeFamily);
    }
  }, [backendConfig, onRuntimeFamilyChange, runtimeFamily, viewerRole]);

  useEffect(() => {
    if (!backendConfig || typeof onExecutionTargetChange !== "function") return;
    const nextExecutionTarget = pickExecutionTargetSelection(
      backendConfig,
      viewerRole,
      executionTarget,
      activeRuntimeFamily?.id || runtimeFamily
    );
    if (nextExecutionTarget && nextExecutionTarget !== executionTarget) {
      onExecutionTargetChange(nextExecutionTarget);
    }
  }, [
    backendConfig,
    executionTarget,
    onExecutionTargetChange,
    viewerRole,
    activeRuntimeFamily?.id,
    runtimeFamily,
  ]);

  useEffect(() => {
    if (
      !activeExecutionTarget ||
      typeof onSandboxProfileChange !== "function"
    ) {
      return;
    }
    const nextSandboxProfile = pickSandboxProfileSelection(
      activeExecutionTarget,
      viewerRole,
      sandboxProfile
    );
    if (nextSandboxProfile && nextSandboxProfile !== sandboxProfile) {
      onSandboxProfileChange(nextSandboxProfile);
    }
  }, [
    activeExecutionTarget,
    onSandboxProfileChange,
    sandboxProfile,
    viewerRole,
  ]);

  if (!backendConfig) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        <div className="flex items-center gap-2 font-semibold text-slate-700">
          <Loader2 size={14} className="animate-spin text-blue-500" />
          Loading runtime paths...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
          Runtime Family
        </p>
        <p className="mt-1 text-sm font-bold text-slate-900">
          {activeRuntimeFamily?.label || "OpenClaw"}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          {activeRuntimeFamily?.operatorContractSummary ||
            "Pick where the OpenClaw runtime executes and which sandbox profile it uses."}
        </p>
      </div>

      {visibleRuntimeFamilies.length > 1 ? (
        <div>
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Runtime Family
          </label>
          <select
            value={runtimeFamily}
            onChange={(event) => onRuntimeFamilyChange?.(event.target.value)}
            disabled={disabled || visibleRuntimeFamilies.length === 0}
            className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
          >
            {visibleRuntimeFamilies.map((family) => (
              <option key={family.id} value={family.id} disabled={!family.available}>
                {optionLabel(family)}
              </option>
            ))}
          </select>
          {activeRuntimeFamily?.issue && !activeRuntimeFamily.available ? (
            <p className="mt-2 text-xs leading-relaxed text-amber-600">
              {activeRuntimeFamily.issue}
            </p>
          ) : null}
        </div>
      ) : null}

      <div>
        <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-400">
          Execution Target
        </label>
        <select
          value={executionTarget}
          onChange={(event) => onExecutionTargetChange?.(event.target.value)}
          disabled={disabled || visibleExecutionTargets.length === 0}
          className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
        >
          {visibleExecutionTargets.map((target) => (
            <option
              key={target.id}
              value={target.id}
              disabled={!target.available}
            >
              {optionLabel(target)}
            </option>
          ))}
        </select>
        {activeExecutionTarget ? (
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {activeExecutionTarget.summary}
          </p>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-amber-600">
            No runtime targets are currently available for this account.
          </p>
        )}
        {activeExecutionTarget?.issue && !activeExecutionTarget.available ? (
          <p className="mt-2 text-xs leading-relaxed text-amber-600">
            {activeExecutionTarget.issue}
          </p>
        ) : null}
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-400">
          Sandbox
        </label>
        <select
          value={sandboxProfile}
          onChange={(event) => onSandboxProfileChange?.(event.target.value)}
          disabled={disabled || visibleSandboxOptions.length === 0}
          className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
        >
          {visibleSandboxOptions.map((profile) => (
            <option
              key={profile.id}
              value={profile.id}
              disabled={!profile.available}
            >
              {optionLabel(profile)}
            </option>
          ))}
        </select>
        {activeSandboxOption ? (
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {activeSandboxOption.summary}
          </p>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-amber-600">
            No sandbox profiles are currently available for this target.
          </p>
        )}
        {activeSandboxOption?.issue && !activeSandboxOption.available ? (
          <p className="mt-2 text-xs leading-relaxed text-amber-600">
            {activeSandboxOption.issue}
          </p>
        ) : null}
      </div>
    </div>
  );
}

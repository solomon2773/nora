import { CheckCircle2, ChevronLeft, Rocket, X } from "lucide-react";
import { DeployClawHubSkill } from "../../../lib/clawhubDeploy";

type SkillSelectionTrayProps = {
  skills: DeployClawHubSkill[];
  mode?: "deploy" | "install";
  deploying?: boolean;
  installLabel?: string;
  installDisabled?: boolean;
  installError?: string | null;
  onBack?: () => void;
  onDeploy?: () => void;
  onInstall?: () => void;
  onRemoveSkill?: (skill: DeployClawHubSkill) => void;
  onClearAll?: () => void;
};

export default function SkillSelectionTray({
  skills,
  mode = "deploy",
  deploying = false,
  installLabel,
  installDisabled = false,
  installError = null,
  onBack,
  onDeploy,
  onInstall,
  onRemoveSkill,
  onClearAll,
}: SkillSelectionTrayProps) {
  const isDeployMode = mode === "deploy";

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-3">
          <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">
            Selected Skills
          </div>
          <div className="flex items-center gap-2 text-2xl font-black text-slate-900">
            <CheckCircle2 size={20} className="text-emerald-500" />
            {skills.length} {isDeployMode ? "chosen for this deploy" : "selected for install"}
          </div>
          <p className="max-w-2xl text-sm leading-6 text-slate-600">
            {isDeployMode
              ? "These skills will be saved onto the new agent record when you click deploy. Runtime installation happens later in the deploy lifecycle, not on this page."
              : "Queue one install job per selected skill for this running agent. Successful installs will update the saved ClawHub skill list and prompt a session restart."}
          </p>
          {skills.length ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-medium text-slate-500">
                  Click a selected skill chip to review it, or remove it with the close button.
                </p>
                {onClearAll ? (
                  <button
                    type="button"
                    onClick={onClearAll}
                    className="text-xs font-black text-slate-500 transition-colors hover:text-slate-700"
                  >
                    Clear all
                  </button>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {skills.map((skill) => (
                  <span
                    key={`${skill.author}:${skill.installSlug}`}
                    className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700"
                  >
                    {skill.name || skill.installSlug}
                    {onRemoveSkill ? (
                      <button
                        type="button"
                        onClick={() => onRemoveSkill(skill)}
                        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-blue-500 transition-colors hover:bg-blue-100 hover:text-blue-700"
                        aria-label={`Remove ${skill.name || skill.installSlug} from selection`}
                      >
                        <X size={12} />
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              {isDeployMode
                ? "No ClawHub skills selected. You can still continue and deploy the agent without any."
                : "No ClawHub skills selected yet. Pick one or more cards to queue installs."}
            </p>
          )}
          {installError ? <p className="text-sm font-medium text-red-600">{installError}</p> : null}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          {isDeployMode && onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-black text-slate-700 transition-colors hover:bg-slate-50"
            >
              <ChevronLeft size={16} />
              Back
            </button>
          ) : null}

          <button
            type="button"
            onClick={isDeployMode ? onDeploy : onInstall}
            disabled={deploying || (!isDeployMode && installDisabled)}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 text-sm font-black text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
          >
            <Rocket size={16} />
            {isDeployMode
              ? deploying
                ? "Deploying..."
                : "Deploy Agent & Open Validation"
              : installLabel || "Install Selected Skills"}
          </button>
        </div>
      </div>
    </div>
  );
}

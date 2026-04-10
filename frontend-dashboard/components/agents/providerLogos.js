function BaseLogo({ className = "h-4 w-4", children }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

function AnthropicLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path d="M7 19 12 5l5 14" stroke="#111827" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 13h5" stroke="#111827" strokeWidth="2.3" strokeLinecap="round" />
    </BaseLogo>
  );
}

function OpenAILogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path
        d="M12 4.25a4.15 4.15 0 0 1 3.55 2.02l2.08.1a3.28 3.28 0 0 1 2.82 4.9l-1.01 1.73 1.01 1.73a3.28 3.28 0 0 1-2.82 4.9l-2.08.1A4.15 4.15 0 0 1 12 19.75a4.15 4.15 0 0 1-3.55-2.02l-2.08-.1a3.28 3.28 0 0 1-2.82-4.9l1.01-1.73-1.01-1.73a3.28 3.28 0 0 1 2.82-4.9l2.08-.1A4.15 4.15 0 0 1 12 4.25Z"
        stroke="#111827"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.1" fill="#111827" />
    </BaseLogo>
  );
}

function GoogleLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" fill="#34A853" />
      <path d="M5.84 14.09A6.95 6.95 0 0 1 5.49 12c0-.73.13-1.43.35-2.09V7.07H2.18A11.96 11.96 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l2.85-2.22.81-.62Z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z" fill="#EA4335" />
    </BaseLogo>
  );
}

function GroqLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <circle cx="12" cy="12" r="10" fill="#111827" />
      <path d="M9 6.75h6l-2.7 4.15H16L8.75 17.25l1.85-4.15H8.75L9 6.75Z" fill="#FFFFFF" />
    </BaseLogo>
  );
}

function MistralLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <rect x="3" y="5" width="3.25" height="14" rx="1" fill="#F97316" />
      <rect x="6.5" y="8" width="3.25" height="11" rx="1" fill="#FB923C" />
      <rect x="10" y="5" width="3.25" height="14" rx="1" fill="#F59E0B" />
      <rect x="13.5" y="8" width="3.25" height="11" rx="1" fill="#DC2626" />
      <rect x="17" y="5" width="3.25" height="14" rx="1" fill="#111827" />
    </BaseLogo>
  );
}

function DeepSeekLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path
        d="M5 12.1c0-3.86 3.22-7 7.18-7 2.71 0 5.07 1.47 6.28 3.66l1.54.17-1.13 1.87L20 12.67l-1.54.17c-1.21 2.19-3.57 3.66-6.28 3.66-3.96 0-7.18-3.14-7.18-7Z"
        fill="#2563EB"
      />
      <circle cx="14.9" cy="10.25" r="0.9" fill="#FFFFFF" />
      <path d="M4 11.2h3.4" stroke="#2563EB" strokeWidth="2.1" strokeLinecap="round" />
    </BaseLogo>
  );
}

function OpenRouterLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <circle cx="7" cy="12" r="2.2" fill="#FB7185" />
      <circle cx="17" cy="7" r="2.2" fill="#A855F7" />
      <circle cx="17" cy="17" r="2.2" fill="#7C3AED" />
      <path d="M8.8 10.95 14.9 7.95" stroke="#DB2777" strokeWidth="2" strokeLinecap="round" />
      <path d="M8.8 13.05 14.9 16.05" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round" />
    </BaseLogo>
  );
}

function TogetherLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <circle cx="9.5" cy="12" r="4.8" stroke="#0F766E" strokeWidth="2.4" />
      <circle cx="14.5" cy="12" r="4.8" stroke="#2563EB" strokeWidth="2.4" />
    </BaseLogo>
  );
}

function CohereLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <rect x="3.75" y="6" width="4.8" height="12" rx="2.4" fill="#111827" />
      <rect x="9.6" y="4" width="4.8" height="16" rx="2.4" fill="#F97316" />
      <rect x="15.45" y="8" width="4.8" height="8" rx="2.4" fill="#FACC15" />
    </BaseLogo>
  );
}

function XAILogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path d="M6 5h3.3l2.7 4.04L14.7 5H18l-4.16 6.18L18 19h-3.3L12 14.91 9.3 19H6l4.16-7.82L6 5Z" fill="#111827" />
    </BaseLogo>
  );
}

function MoonshotLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <circle cx="12" cy="12" r="8" fill="#111827" />
      <circle cx="15" cy="10.7" r="7.8" fill="#FFFFFF" />
    </BaseLogo>
  );
}

function ZAILogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path d="M6.5 7.25H18L10 16.75H17.5" stroke="#10B981" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18.2" cy="18.2" r="1.2" fill="#10B981" />
    </BaseLogo>
  );
}

function OllamaLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path d="M8 7.25 10.5 9.6 12 8.1 13.5 9.6 16 7.25v5.7c0 2.21-1.79 4-4 4s-4-1.79-4-4v-5.7Z" fill="#111827" />
      <circle cx="10.5" cy="12.15" r="0.9" fill="#FFFFFF" />
      <circle cx="13.5" cy="12.15" r="0.9" fill="#FFFFFF" />
      <path d="M10.4 14.55h3.2" stroke="#FFFFFF" strokeWidth="1.4" strokeLinecap="round" />
    </BaseLogo>
  );
}

function MiniMaxLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path
        d="M5 18V6l4.5 5.55L12 8l2.5 3.55L19 6v12h-2.4v-6.04L12 16l-4.6-4.04V18H5Z"
        fill="#F59E0B"
      />
    </BaseLogo>
  );
}

function GitHubCopilotLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path
        d="M12 2C6.48 2 2 6.37 2 11.77c0 4.32 2.87 7.98 6.84 9.27.5.09.68-.21.68-.47 0-.23-.01-.98-.01-1.77-2.5.53-3.14-.61-3.34-1.16-.11-.29-.59-1.16-1-1.39-.34-.18-.82-.63-.01-.65.76-.01 1.3.69 1.48.97.87 1.45 2.26 1.04 2.82.79.08-.62.34-1.03.62-1.26-2.22-.25-4.55-1.07-4.55-4.74 0-1.04.39-1.89 1.03-2.56-.1-.24-.46-1.23.1-2.56 0 0 .84-.25 2.76.98a9.84 9.84 0 0 1 5.03 0c1.92-1.23 2.76-.98 2.76-.98.56 1.33.2 2.32.1 2.56.64.67 1.03 1.52 1.03 2.56 0 3.68-2.33 4.49-4.56 4.74.36.3.67.88.67 1.79 0 1.29-.01 2.33-.01 2.65 0 .26.18.57.69.47A9.78 9.78 0 0 0 22 11.77C22 6.37 17.52 2 12 2Z"
        fill="#111827"
      />
      <path d="M17.2 5.3 18 7l1.8.24-1.32 1.28.31 1.8L17.2 9.4l-1.6.92.3-1.8-1.31-1.28L16.4 7l.8-1.7Z" fill="#38BDF8" />
    </BaseLogo>
  );
}

function HuggingFaceLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <circle cx="12" cy="12" r="7.25" fill="#FACC15" />
      <circle cx="9.35" cy="10.95" r="0.9" fill="#7C2D12" />
      <circle cx="14.65" cy="10.95" r="0.9" fill="#7C2D12" />
      <path d="M9.2 14.2c.78.7 1.72 1.05 2.8 1.05s2.02-.35 2.8-1.05" stroke="#7C2D12" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6.6" cy="13.5" r="2.05" fill="#FB923C" />
      <circle cx="17.4" cy="13.5" r="2.05" fill="#FB923C" />
    </BaseLogo>
  );
}

function CerebrasLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path d="M18 7.5a8 8 0 1 0 0 9" stroke="#F97316" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </BaseLogo>
  );
}

function NvidiaLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <path d="M2.8 12c2.84-3.56 5.93-5.34 9.2-5.34 3.3 0 6.39 1.78 9.2 5.34-2.81 3.56-5.9 5.34-9.2 5.34-3.27 0-6.36-1.78-9.2-5.34Z" fill="#76B900" />
      <path d="M6.9 12c1.62-1.96 3.33-2.94 5.1-2.94 1.77 0 3.48.98 5.1 2.94-1.62 1.96-3.33 2.94-5.1 2.94-1.77 0-3.48-.98-5.1-2.94Z" fill="#FFFFFF" />
      <circle cx="12" cy="12" r="1.85" fill="#76B900" />
    </BaseLogo>
  );
}

function GenericProviderLogo({ className }) {
  return (
    <BaseLogo className={className}>
      <rect x="4" y="4" width="16" height="16" rx="4" fill="#CBD5E1" />
      <path d="M9 9h6M9 12h6M9 15h4" stroke="#475569" strokeWidth="1.8" strokeLinecap="round" />
    </BaseLogo>
  );
}

export const PROVIDER_META = {
  anthropic: { name: "Anthropic", color: "bg-orange-100 text-orange-700 border-orange-200", Icon: AnthropicLogo },
  openai: { name: "OpenAI", color: "bg-green-100 text-green-700 border-green-200", Icon: OpenAILogo },
  google: { name: "Google (Gemini)", color: "bg-blue-100 text-blue-700 border-blue-200", Icon: GoogleLogo },
  groq: { name: "Groq", color: "bg-purple-100 text-purple-700 border-purple-200", Icon: GroqLogo },
  mistral: { name: "Mistral", color: "bg-indigo-100 text-indigo-700 border-indigo-200", Icon: MistralLogo },
  deepseek: { name: "DeepSeek", color: "bg-cyan-100 text-cyan-700 border-cyan-200", Icon: DeepSeekLogo },
  openrouter: { name: "OpenRouter", color: "bg-pink-100 text-pink-700 border-pink-200", Icon: OpenRouterLogo },
  together: { name: "Together AI", color: "bg-yellow-100 text-yellow-700 border-yellow-200", Icon: TogetherLogo },
  cohere: { name: "Cohere", color: "bg-teal-100 text-teal-700 border-teal-200", Icon: CohereLogo },
  xai: { name: "xAI", color: "bg-gray-100 text-gray-700 border-gray-200", Icon: XAILogo },
  moonshot: { name: "Moonshot AI", color: "bg-violet-100 text-violet-700 border-violet-200", Icon: MoonshotLogo },
  zai: { name: "Z.AI", color: "bg-emerald-100 text-emerald-700 border-emerald-200", Icon: ZAILogo },
  ollama: { name: "Ollama", color: "bg-slate-100 text-slate-700 border-slate-200", Icon: OllamaLogo },
  minimax: { name: "MiniMax", color: "bg-amber-100 text-amber-700 border-amber-200", Icon: MiniMaxLogo },
  "github-copilot": { name: "GitHub Copilot", color: "bg-gray-100 text-gray-700 border-gray-200", Icon: GitHubCopilotLogo },
  huggingface: { name: "Hugging Face (Inference)", color: "bg-yellow-100 text-yellow-700 border-yellow-200", Icon: HuggingFaceLogo },
  cerebras: { name: "Cerebras", color: "bg-red-100 text-red-700 border-red-200", Icon: CerebrasLogo },
  nvidia: { name: "NVIDIA", color: "bg-lime-100 text-lime-700 border-lime-200", Icon: NvidiaLogo },
};

const FALLBACK_META = {
  name: "Provider",
  color: "bg-slate-100 text-slate-700 border-slate-200",
  Icon: GenericProviderLogo,
};

export function getProviderMeta(providerId, providerName) {
  const meta = PROVIDER_META[providerId];
  if (meta) return meta;
  return {
    ...FALLBACK_META,
    name: providerName || providerId || FALLBACK_META.name,
  };
}

export function ProviderLogo({ providerId, className = "h-4 w-4" }) {
  const Icon = (PROVIDER_META[providerId] && PROVIDER_META[providerId].Icon) || GenericProviderLogo;
  return <Icon className={className} />;
}

export function formatModelLabel(modelRef) {
  if (!modelRef) return "";
  const parts = String(modelRef).split("/");
  if (parts.length <= 1) return modelRef;
  return parts.slice(1).join("/");
}

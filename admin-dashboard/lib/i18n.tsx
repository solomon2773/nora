import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/router";
import { REMOTE_HOST_TRANSLATIONS } from "./remoteHostTranslations";

export const LOCALES = ["en", "es", "fr", "zh-Hans", "zh-Hant"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const ADMIN_BASE_PATH = "/admin";
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Espanol",
  fr: "Francais",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

const TRANSLATIONS = {
  es: {
    ...REMOTE_HOST_TRANSLATIONS.es,
    "Nora Admin": "Admin de Nora",
    "Full platform control": "Control total de la plataforma",
    Overview: "Resumen",
    Fleet: "Flota",
    Queue: "Cola",
    Users: "Usuarios",
    "Agent Hub": "Centro de agentes",
    Audit: "Auditoria",
    Settings: "Configuracion",
    Guardrail: "Regla de seguridad",
    "Log Out": "Cerrar sesion",
    "Admin access check failed": "Fallo la comprobacion de acceso admin",
    "Checking admin access...": "Comprobando acceso admin...",
    "System Critical": "Sistema critico",
    "System Warning": "Advertencia del sistema",
    "Upgrade Required": "Actualizacion requerida",
    "New Nora Version Available": "Nueva version de Nora disponible",
    "A newer Nora release is available": "Hay una version mas reciente de Nora disponible",
    "Review upgrade": "Revisar actualizacion",
    "Release notes": "Notas de version",
    "Platform Overview": "Resumen de plataforma",
    "Admin control plane": "Plano de control admin",
    "Queue health": "Salud de la cola",
    "Attention now": "Atencion ahora",
    "Global agent fleet": "Flota global de agentes",
    "Runtime metadata": "Metadatos del runtime",
    "Live runtime logs": "Registros en vivo del runtime",
    "Deployment queue and DLQ": "Cola de despliegue y DLQ",
    "Queued deploy jobs": "Trabajos de despliegue en cola",
    "Accounts and roles": "Cuentas y roles",
    "Agent Hub moderation": "Moderacion de Agent Hub",
    "Template Files": "Archivos de plantilla",
    "Approve listing": "Aprobar listado",
    Approve: "Aprobar",
    Published: "Publicado",
    "Platform activity log": "Registro de actividad de la plataforma",
    "Platform Settings": "Configuracion de plataforma",
    "Total Users": "Usuarios totales",
    "Total Agents": "Agentes totales",
    "Live Agents": "Agentes activos",
    "Queue Pressure": "Presion de cola",
    "Open queue": "Abrir cola",
    Refresh: "Actualizar",
    Waiting: "En espera",
    Active: "Activo",
    Completed: "Completado",
    Failed: "Fallido",
    "Warning agents": "Agentes con advertencias",
    "Error agents": "Agentes con errores",
    "Pending listings": "Listados pendientes",
    "Recent platform activity": "Actividad reciente de la plataforma",
    "This admin page doesn't exist.": "Esta pagina admin no existe.",
    "Back to Admin": "Volver a admin",
    Unversioned: "Sin version",
    "Unversioned build": "Build sin version",
    "Review the upgrade guidance to choose one-click or manual upgrade.":
      "Revisa la guia de actualizacion para elegir actualizacion de un clic o manual.",
    Members: "Miembros",
    "Multi-tenant RBAC": "RBAC multi-tenant",
    "Read-only god view of every workspace, member, and role on this Nora installation.":
      "Vista global de solo lectura de cada espacio de trabajo, miembro y rol de esta instalacion de Nora.",
    "Membership rows": "Filas de membresia",
    "Distinct users": "Usuarios distintos",
    "All workspaces": "Todos los espacios",
    "All roles": "Todos los roles",
    Workspace: "Espacio de trabajo",
    User: "Usuario",
    Role: "Rol",
    Joined: "Se unio",
    Owner: "Propietario",
    Editor: "Editor",
    Viewer: "Espectador",
    "Top role": "Rol superior",
    "Platform role": "Rol de plataforma",
    "Platform admin": "Admin de plataforma",
    Manage: "Gestionar",
    Creator: "Creador",
    "Search by user, email, or workspace…": "Buscar por usuario, correo o espacio de trabajo…",
    "No members match.": "Ningun miembro coincide.",
    by: "por",
    "Notifications (SMTP)": "Notificaciones (SMTP)",
    "One platform-wide SMTP config drives invitation emails and the email channel for alert rules.":
      "Una configuracion SMTP global impulsa los correos de invitacion y el canal de email de las reglas de alerta.",
    Configured: "Configurado",
    "Not configured": "Sin configurar",
    "SMTP host": "Servidor SMTP",
    Port: "Puerto",
    Username: "Usuario",
    Password: "Contrasena",
    "From address": "Direccion remitente",
    "From name": "Nombre remitente",
    "Use TLS (auto-on for port 465)": "Usar TLS (automatico en puerto 465)",
    "Save SMTP settings": "Guardar configuracion SMTP",
    "Send test email to me": "Enviarme un correo de prueba",
    "SMTP settings saved": "Configuracion SMTP guardada",
    "Test email sent": "Correo de prueba enviado",
    "Test email failed": "Fallo el correo de prueba",
    "Failed to load SMTP settings": "No se pudo cargar la configuracion SMTP",
    "Leave blank to keep": "Dejar vacio para conservar",
    "Save SMTP settings first": "Guarda primero la configuracion SMTP",
  },
  fr: {
    ...REMOTE_HOST_TRANSLATIONS.fr,
    "Nora Admin": "Admin Nora",
    "Full platform control": "Controle complet de la plateforme",
    Overview: "Vue d'ensemble",
    Fleet: "Flotte",
    Queue: "File",
    Users: "Utilisateurs",
    "Agent Hub": "Centre d'agents",
    Audit: "Audit",
    Settings: "Parametres",
    Guardrail: "Garde-fou",
    "Log Out": "Deconnexion",
    "Admin access check failed": "Echec de la verification d'acces admin",
    "Checking admin access...": "Verification de l'acces admin...",
    "System Critical": "Systeme critique",
    "System Warning": "Avertissement systeme",
    "Upgrade Required": "Mise a niveau requise",
    "New Nora Version Available": "Nouvelle version de Nora disponible",
    "A newer Nora release is available": "Une version plus recente de Nora est disponible",
    "Review upgrade": "Verifier la mise a niveau",
    "Release notes": "Notes de version",
    "Platform Overview": "Vue d'ensemble de la plateforme",
    "Admin control plane": "Plan de controle admin",
    "Queue health": "Sante de la file",
    "Attention now": "Attention maintenant",
    "Global agent fleet": "Flotte globale d'agents",
    "Runtime metadata": "Metadonnees runtime",
    "Live runtime logs": "Journaux runtime en direct",
    "Deployment queue and DLQ": "File de deploiement et DLQ",
    "Queued deploy jobs": "Taches de deploiement en file",
    "Accounts and roles": "Comptes et roles",
    "Agent Hub moderation": "Moderation Agent Hub",
    "Template Files": "Fichiers du modele",
    "Approve listing": "Approuver la fiche",
    Approve: "Approuver",
    Published: "Publie",
    "Platform activity log": "Journal d'activite plateforme",
    "Platform Settings": "Parametres de plateforme",
    "Total Users": "Utilisateurs totaux",
    "Total Agents": "Agents totaux",
    "Live Agents": "Agents actifs",
    "Queue Pressure": "Pression de la file",
    "Open queue": "Ouvrir la file",
    Refresh: "Actualiser",
    Waiting: "En attente",
    Active: "Actif",
    Completed: "Termine",
    Failed: "Echec",
    "Warning agents": "Agents avec avertissements",
    "Error agents": "Agents en erreur",
    "Pending listings": "Fiches en attente",
    "Recent platform activity": "Activite recente de la plateforme",
    "This admin page doesn't exist.": "Cette page admin n'existe pas.",
    "Back to Admin": "Retour a l'admin",
    Unversioned: "Sans version",
    "Unversioned build": "Build sans version",
    "Review the upgrade guidance to choose one-click or manual upgrade.":
      "Consultez les consignes de mise a niveau pour choisir l'option en un clic ou manuelle.",
    Members: "Membres",
    "Multi-tenant RBAC": "RBAC multi-locataires",
    "Read-only god view of every workspace, member, and role on this Nora installation.":
      "Vue globale en lecture seule de chaque espace, membre et role de cette installation Nora.",
    "Membership rows": "Lignes d'adhesion",
    "Distinct users": "Utilisateurs distincts",
    "All workspaces": "Tous les espaces",
    "All roles": "Tous les roles",
    Workspace: "Espace",
    User: "Utilisateur",
    Role: "Role",
    Joined: "Rejoint",
    Owner: "Proprietaire",
    Editor: "Editeur",
    Viewer: "Spectateur",
    "Top role": "Role principal",
    "Platform role": "Role plateforme",
    "Platform admin": "Admin plateforme",
    Manage: "Gerer",
    Creator: "Createur",
    "Search by user, email, or workspace…": "Rechercher par utilisateur, email ou espace…",
    "No members match.": "Aucun membre ne correspond.",
    by: "par",
    "Notifications (SMTP)": "Notifications (SMTP)",
    "One platform-wide SMTP config drives invitation emails and the email channel for alert rules.":
      "Une configuration SMTP unique alimente les emails d'invitation et le canal email des regles d'alerte.",
    Configured: "Configure",
    "Not configured": "Non configure",
    "SMTP host": "Serveur SMTP",
    Port: "Port",
    Username: "Utilisateur",
    Password: "Mot de passe",
    "From address": "Adresse d'expediteur",
    "From name": "Nom d'expediteur",
    "Use TLS (auto-on for port 465)": "Utiliser TLS (auto pour le port 465)",
    "Save SMTP settings": "Enregistrer la configuration SMTP",
    "Send test email to me": "M'envoyer un email de test",
    "SMTP settings saved": "Configuration SMTP enregistree",
    "Test email sent": "Email de test envoye",
    "Test email failed": "Echec de l'email de test",
    "Failed to load SMTP settings": "Echec du chargement SMTP",
    "Leave blank to keep": "Laisser vide pour conserver",
    "Save SMTP settings first": "Enregistrez d'abord la configuration SMTP",
  },
  "zh-Hans": {
    ...REMOTE_HOST_TRANSLATIONS["zh-Hans"],
    "Nora Admin": "Nora 管理",
    "Full platform control": "完整平台控制",
    Overview: "概览",
    Fleet: "队伍",
    Queue: "队列",
    Users: "用户",
    "Agent Hub": "代理中心",
    Audit: "审计",
    Settings: "设置",
    Guardrail: "防护栏",
    "Log Out": "退出登录",
    "Admin access check failed": "管理员访问检查失败",
    "Checking admin access...": "正在检查管理员访问权限...",
    "System Critical": "系统严重",
    "System Warning": "系统警告",
    "Upgrade Required": "需要升级",
    "New Nora Version Available": "有新的 Nora 版本可用",
    "A newer Nora release is available": "有更新的 Nora 版本可用",
    "Review upgrade": "查看升级",
    "Release notes": "发行说明",
    "Platform Overview": "平台概览",
    "Admin control plane": "管理员控制平面",
    "Queue health": "队列健康",
    "Attention now": "当前关注",
    "Global agent fleet": "全局代理队伍",
    "Runtime metadata": "运行时元数据",
    "Live runtime logs": "实时运行时日志",
    "Deployment queue and DLQ": "部署队列和死信队列",
    "Queued deploy jobs": "排队的部署作业",
    "Accounts and roles": "账户和角色",
    "Agent Hub moderation": "Agent Hub 审核",
    "Template Files": "模板文件",
    "Approve listing": "批准列表项",
    Approve: "批准",
    Published: "已发布",
    "Platform activity log": "平台活动日志",
    "Platform Settings": "平台设置",
    "Total Users": "用户总数",
    "Total Agents": "代理总数",
    "Live Agents": "在线代理",
    "Queue Pressure": "队列压力",
    "Open queue": "打开队列",
    Refresh: "刷新",
    Waiting: "等待中",
    Active: "活动",
    Completed: "已完成",
    Failed: "失败",
    "Warning agents": "警告代理",
    "Error agents": "错误代理",
    "Pending listings": "待处理列表",
    "Recent platform activity": "近期平台活动",
    "This admin page doesn't exist.": "此管理页面不存在。",
    "Back to Admin": "返回管理",
    Unversioned: "无版本",
    "Unversioned build": "无版本构建",
    "Review the upgrade guidance to choose one-click or manual upgrade.":
      "查看升级指南，以选择一键升级或手动升级。",
    Members: "成员",
    "Multi-tenant RBAC": "多租户 RBAC",
    "Read-only god view of every workspace, member, and role on this Nora installation.":
      "对此 Nora 安装中每个工作区、成员和角色的只读全局视图。",
    "Membership rows": "成员资格行",
    "Distinct users": "不同用户",
    "All workspaces": "所有工作区",
    "All roles": "所有角色",
    Workspace: "工作区",
    User: "用户",
    Role: "角色",
    Joined: "加入时间",
    Owner: "所有者",
    Editor: "编辑者",
    Viewer: "查看者",
    "Top role": "最高角色",
    "Platform role": "平台角色",
    "Platform admin": "平台管理员",
    Manage: "管理",
    Creator: "创建者",
    "Search by user, email, or workspace…": "按用户、邮箱或工作区搜索…",
    "No members match.": "没有匹配的成员。",
    by: "由",
    "Notifications (SMTP)": "通知 (SMTP)",
    "One platform-wide SMTP config drives invitation emails and the email channel for alert rules.":
      "一份全平台 SMTP 配置同时驱动邀请邮件和告警规则的邮件渠道。",
    Configured: "已配置",
    "Not configured": "未配置",
    "SMTP host": "SMTP 主机",
    Port: "端口",
    Username: "用户名",
    Password: "密码",
    "From address": "发件地址",
    "From name": "发件人名称",
    "Use TLS (auto-on for port 465)": "启用 TLS (端口 465 自动开启)",
    "Save SMTP settings": "保存 SMTP 设置",
    "Send test email to me": "发送测试邮件给我",
    "SMTP settings saved": "SMTP 设置已保存",
    "Test email sent": "测试邮件已发送",
    "Test email failed": "测试邮件失败",
    "Failed to load SMTP settings": "加载 SMTP 设置失败",
    "Leave blank to keep": "留空以保留",
    "Save SMTP settings first": "请先保存 SMTP 设置",
  },
  "zh-Hant": {
    ...REMOTE_HOST_TRANSLATIONS["zh-Hant"],
    "Nora Admin": "Nora 管理",
    "Full platform control": "完整平台控制",
    Overview: "概覽",
    Fleet: "隊伍",
    Queue: "佇列",
    Users: "使用者",
    "Agent Hub": "代理中心",
    Audit: "稽核",
    Settings: "設定",
    Guardrail: "防護欄",
    "Log Out": "登出",
    "Admin access check failed": "管理員存取檢查失敗",
    "Checking admin access...": "正在檢查管理員存取權限...",
    "System Critical": "系統嚴重",
    "System Warning": "系統警告",
    "Upgrade Required": "需要升級",
    "New Nora Version Available": "有新的 Nora 版本可用",
    "A newer Nora release is available": "有更新的 Nora 版本可用",
    "Review upgrade": "查看升級",
    "Release notes": "發行說明",
    "Platform Overview": "平台概覽",
    "Admin control plane": "管理員控制平面",
    "Queue health": "佇列健康",
    "Attention now": "目前關注",
    "Global agent fleet": "全域代理隊伍",
    "Runtime metadata": "執行階段中繼資料",
    "Live runtime logs": "即時執行階段日誌",
    "Deployment queue and DLQ": "部署佇列和死信佇列",
    "Queued deploy jobs": "排入佇列的部署作業",
    "Accounts and roles": "帳戶和角色",
    "Agent Hub moderation": "Agent Hub 審核",
    "Template Files": "範本檔案",
    "Approve listing": "核准列表項目",
    Approve: "核准",
    Published: "已發布",
    "Platform activity log": "平台活動日誌",
    "Platform Settings": "平台設定",
    "Total Users": "使用者總數",
    "Total Agents": "代理總數",
    "Live Agents": "線上代理",
    "Queue Pressure": "佇列壓力",
    "Open queue": "開啟佇列",
    Refresh: "重新整理",
    Waiting: "等待中",
    Active: "啟用",
    Completed: "已完成",
    Failed: "失敗",
    "Warning agents": "警告代理",
    "Error agents": "錯誤代理",
    "Pending listings": "待處理列表",
    "Recent platform activity": "近期平台活動",
    "This admin page doesn't exist.": "此管理頁面不存在。",
    "Back to Admin": "返回管理",
    Unversioned: "無版本",
    "Unversioned build": "無版本建置",
    "Review the upgrade guidance to choose one-click or manual upgrade.":
      "查看升級指南，以選擇一鍵升級或手動升級。",
    Members: "成員",
    "Multi-tenant RBAC": "多租戶 RBAC",
    "Read-only god view of every workspace, member, and role on this Nora installation.":
      "對此 Nora 安裝中每個工作區、成員和角色的唯讀全域檢視。",
    "Membership rows": "成員資格列",
    "Distinct users": "不同使用者",
    "All workspaces": "所有工作區",
    "All roles": "所有角色",
    Workspace: "工作區",
    User: "使用者",
    Role: "角色",
    Joined: "加入時間",
    Owner: "擁有者",
    Editor: "編輯者",
    Viewer: "檢視者",
    "Top role": "最高角色",
    "Platform role": "平台角色",
    "Platform admin": "平台管理員",
    Manage: "管理",
    Creator: "建立者",
    "Search by user, email, or workspace…": "依使用者、電子郵件或工作區搜尋…",
    "No members match.": "沒有符合的成員。",
    by: "由",
    "Notifications (SMTP)": "通知 (SMTP)",
    "One platform-wide SMTP config drives invitation emails and the email channel for alert rules.":
      "單一平台 SMTP 設定同時驅動邀請郵件和告警規則的郵件通道。",
    Configured: "已設定",
    "Not configured": "未設定",
    "SMTP host": "SMTP 主機",
    Port: "連接埠",
    Username: "使用者名稱",
    Password: "密碼",
    "From address": "寄件地址",
    "From name": "寄件人名稱",
    "Use TLS (auto-on for port 465)": "啟用 TLS (連接埠 465 自動啟用)",
    "Save SMTP settings": "儲存 SMTP 設定",
    "Send test email to me": "傳送測試郵件給我",
    "SMTP settings saved": "SMTP 設定已儲存",
    "Test email sent": "測試郵件已傳送",
    "Test email failed": "測試郵件失敗",
    "Failed to load SMTP settings": "載入 SMTP 設定失敗",
    "Leave blank to keep": "留空以保留",
    "Save SMTP settings first": "請先儲存 SMTP 設定",
  },
} satisfies Record<Exclude<Locale, "en">, Record<string, string>>;

type TranslationKey =
  | keyof typeof TRANSLATIONS.es
  | keyof typeof TRANSLATIONS.fr
  | keyof (typeof TRANSLATIONS)["zh-Hans"]
  | keyof (typeof TRANSLATIONS)["zh-Hant"];

type I18nValue = {
  locale: Locale;
  defaultLocale: Locale;
  preferredLocale: Locale | null;
  t: (key: TranslationKey | string) => string;
  localizePath: (path: string, targetLocale?: Locale) => string;
  setLocale: (locale: Locale) => Promise<void>;
  clearLocalePreference: () => Promise<Locale>;
  loginPath: string;
  dashboardPath: string;
};

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  defaultLocale: DEFAULT_LOCALE,
  preferredLocale: null,
  t: (key) => key,
  localizePath: (path) => path,
  setLocale: async () => {},
  clearLocalePreference: async () => DEFAULT_LOCALE,
  loginPath: "/login",
  dashboardPath: "/app/dashboard",
});

export function normalizeLocale(value: string | undefined): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : DEFAULT_LOCALE;
}

function explicitLocaleFromRoute(value: string | undefined): Locale | null {
  const locale = normalizeLocale(value);
  return locale === DEFAULT_LOCALE ? null : locale;
}

function legacyAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = window.localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchLanguagePreference() {
  try {
    const userResponse = await fetch("/api/auth/me", {
      credentials: "include",
      headers: legacyAuthHeaders(),
    });
    if (userResponse.ok) {
      const user = await userResponse.json().catch(() => ({}));
      return {
        defaultLocale: normalizeLocale(user.defaultLocale),
        preferredLocale: user.preferredLocale ? normalizeLocale(user.preferredLocale) : null,
        effectiveLocale: normalizeLocale(user.effectiveLocale || user.defaultLocale),
      };
    }
  } catch {
    // Fall back to the public platform config below.
  }

  try {
    const configResponse = await fetch("/api/config/platform");
    if (configResponse.ok) {
      const config = await configResponse.json().catch(() => ({}));
      const defaultLocale = normalizeLocale(config.language?.defaultLocale);
      return { defaultLocale, preferredLocale: null, effectiveLocale: defaultLocale };
    }
  } catch {
    // Keep the built-in default if config is unavailable.
  }

  return {
    defaultLocale: DEFAULT_LOCALE,
    preferredLocale: null,
    effectiveLocale: DEFAULT_LOCALE,
  };
}

async function persistPreferredLocale(locale: Locale | null) {
  try {
    const response = await fetch("/api/auth/profile", {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...legacyAuthHeaders(),
      },
      body: JSON.stringify({ preferredLocale: locale }),
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  } catch {
    return null;
  }
}

export function translateText(value: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return value;
  return TRANSLATIONS[locale][value] || value;
}

export function hasTranslation(value: string, locale: Locale): boolean {
  return locale === DEFAULT_LOCALE || Object.hasOwn(TRANSLATIONS[locale], value);
}

export function marketingPath(path: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return path;
  const [pathname, suffix = ""] = path.split(/([?#].*)/, 2);
  return `/${locale}${pathname === "/" ? "" : pathname}${suffix}`;
}

export function operatorPath(path: string, locale: Locale): string {
  const [pathname, suffix = ""] = path.split(/([?#].*)/, 2);
  const clean = (pathname || "/").replace(/^\/app/, "") || "/";
  const withoutLocale = clean.replace(/^\/(en|es|fr|zh-Hans|zh-Hant)(?=\/|$)/, "") || "/";
  const localized =
    locale === DEFAULT_LOCALE
      ? `/app${withoutLocale === "/" ? "" : withoutLocale}`
      : `/app/${locale}${withoutLocale === "/" ? "" : withoutLocale}`;
  return `${localized}${suffix}`;
}

export function localizePath(path: string, locale: Locale): string {
  if (
    !path ||
    path.startsWith("http") ||
    path.startsWith("#") ||
    path.startsWith("mailto:") ||
    path.startsWith("/api")
  ) {
    return path;
  }
  if (path === "/login" || path.startsWith("/login?") || path.startsWith("/pricing")) {
    return marketingPath(path, locale);
  }
  if (path.startsWith("/app")) return operatorPath(path, locale);

  const [pathname, suffix = ""] = path.split(/([?#].*)/, 2);
  const adminRelative = (pathname || "/").replace(new RegExp(`^${ADMIN_BASE_PATH}`), "") || "/";
  const withoutLocale = adminRelative.replace(/^\/(en|es|fr|zh-Hans|zh-Hant)(?=\/|$)/, "") || "/";
  const localized =
    locale === DEFAULT_LOCALE
      ? `${ADMIN_BASE_PATH}${withoutLocale === "/" ? "" : withoutLocale}`
      : `${ADMIN_BASE_PATH}/${locale}${withoutLocale === "/" ? "" : withoutLocale}`;
  return `${localized}${suffix}`;
}

function getTextNodes(root: ParentNode): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script,style,textarea,code,pre,[data-no-translate]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let next = walker.nextNode();
  while (next) {
    nodes.push(next as Text);
    next = walker.nextNode();
  }
  return nodes;
}

const textOriginals = new WeakMap<Text, string>();
const translatedAttributes = ["aria-label", "placeholder", "title", "alt"] as const;
const REVERSE_TRANSLATIONS = Object.fromEntries(
  Object.entries(TRANSLATIONS).map(([locale, entries]) => [
    locale,
    Object.fromEntries(Object.entries(entries).map(([source, translated]) => [translated, source])),
  ]),
) as Record<Exclude<Locale, "en">, Record<string, string>>;

function sourceTextFor(value: string, locale: Locale): string {
  const trimmed = value.trim();
  if (!trimmed || locale === DEFAULT_LOCALE) return trimmed;
  return REVERSE_TRANSLATIONS[locale][trimmed] || trimmed;
}

function sourceTextWithWhitespace(value: string, locale: Locale): string {
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  return `${leading}${sourceTextFor(value, locale)}${trailing}`;
}

function setAttributeIfChanged(element: Element, attr: string, value: string) {
  if (element.getAttribute(attr) !== value) element.setAttribute(attr, value);
}

function localizeElement(root: ParentNode, locale: Locale) {
  for (const node of getTextNodes(root)) {
    let original = textOriginals.get(node);
    if (!original) {
      original = sourceTextWithWhitespace(node.textContent || "", locale);
      textOriginals.set(node, original);
    }
    const leading = original.match(/^\s*/)?.[0] || "";
    const trailing = original.match(/\s*$/)?.[0] || "";
    const nextValue = `${leading}${translateText(original.trim(), locale)}${trailing}`;
    if (node.textContent !== nextValue) node.textContent = nextValue;
  }

  const elements =
    root instanceof Element
      ? [root, ...Array.from(root.querySelectorAll("*"))]
      : Array.from(root.querySelectorAll("*"));
  for (const element of elements) {
    if (element.closest("script,style,textarea,code,pre,[data-no-translate]")) continue;
    for (const attr of translatedAttributes) {
      const current = element.getAttribute(attr);
      if (!current) continue;
      const marker = `data-i18n-original-${attr}`;
      const original = element.getAttribute(marker) || sourceTextFor(current, locale);
      if (!element.hasAttribute(marker)) element.setAttribute(marker, original);
      setAttributeIfChanged(element, attr, translateText(original, locale));
    }
    if (element instanceof HTMLAnchorElement) {
      const currentHref = element.getAttribute("href");
      if (!currentHref) continue;
      const marker = "data-i18n-original-href";
      const originalHref = element.getAttribute(marker) || currentHref;
      if (!element.hasAttribute(marker)) element.setAttribute(marker, originalHref);
      setAttributeIfChanged(element, "href", localizePath(originalHref, locale));
    }
  }
}

function StaticLocalizer({ locale }: { locale: Locale }) {
  useEffect(() => {
    localizeElement(document.body, locale);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
              const text = node as Text;
              if (!textOriginals.has(text)) {
                textOriginals.set(text, sourceTextWithWhitespace(text.textContent || "", locale));
              }
              text.textContent = translateText((textOriginals.get(text) || "").trim(), locale);
            } else if (node instanceof Element) {
              localizeElement(node, locale);
            }
          }
        } else if (mutation.type === "attributes" && mutation.target instanceof Element) {
          localizeElement(mutation.target, locale);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...translatedAttributes, "href"],
    });
    return () => observer.disconnect();
  }, [locale]);
  return null;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const routeLocale = normalizeLocale(router.locale);
  const [locale, setResolvedLocale] = useState<Locale>(routeLocale);
  const [defaultLocale, setDefaultLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [preferredLocale, setPreferredLocale] = useState<Locale | null>(null);

  useEffect(() => {
    let active = true;
    const explicitLocale = explicitLocaleFromRoute(router.locale);

    async function loadPreference() {
      const preference = await fetchLanguagePreference();
      if (!active) return;

      setDefaultLocale(preference.defaultLocale);
      setPreferredLocale(preference.preferredLocale);

      const nextLocale = explicitLocale || preference.effectiveLocale;
      setResolvedLocale(nextLocale);

      if (!explicitLocale && nextLocale !== routeLocale) {
        router
          .replace(router.pathname, router.asPath, { locale: nextLocale, scroll: false })
          .catch(() => {});
      }
    }

    loadPreference();
    return () => {
      active = false;
    };
  }, [routeLocale, router.asPath, router.pathname]);

  const setLocale = useCallback(
    async (nextLocale: Locale) => {
      const normalized = normalizeLocale(nextLocale);
      const persisted = await persistPreferredLocale(normalized);
      setPreferredLocale(
        persisted?.preferredLocale ? normalizeLocale(persisted.preferredLocale) : normalized,
      );
      setDefaultLocale(normalizeLocale(persisted?.defaultLocale || defaultLocale));
      setResolvedLocale(normalized);
      await router.push(router.pathname, router.asPath, { locale: normalized });
    },
    [defaultLocale, router],
  );

  const clearLocalePreference = useCallback(async () => {
    const persisted = await persistPreferredLocale(null);
    const nextDefaultLocale = normalizeLocale(persisted?.defaultLocale || defaultLocale);
    const nextEffectiveLocale = normalizeLocale(persisted?.effectiveLocale || nextDefaultLocale);
    setPreferredLocale(null);
    setDefaultLocale(nextDefaultLocale);
    setResolvedLocale(nextEffectiveLocale);
    await router.push(router.pathname, router.asPath, { locale: nextEffectiveLocale });
    return nextEffectiveLocale;
  }, [defaultLocale, router]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      defaultLocale,
      preferredLocale,
      t: (key) => translateText(key, locale),
      localizePath: (path, targetLocale = locale) => localizePath(path, targetLocale),
      setLocale,
      clearLocalePreference,
      loginPath: marketingPath("/login", locale),
      dashboardPath: operatorPath("/app/dashboard", locale),
    }),
    [clearLocalePreference, defaultLocale, locale, preferredLocale, setLocale],
  );

  return (
    <I18nContext.Provider value={value}>
      {children}
      <StaticLocalizer locale={locale} />
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}

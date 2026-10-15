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

export const LOCALES = ["en", "es", "fr", "zh-Hans", "zh-Hant"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const APP_BASE_PATH = "/app";
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Espanol",
  fr: "Francais",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

const TRANSLATIONS = {
  es: {
    Nora: "Nora",
    Dashboard: "Panel",
    "Getting Started": "Primeros pasos",
    Agents: "Agentes",
    "Agent Details": "Detalles del agente",
    "Agent Hub": "Centro de agentes",
    ClawHub: "ClawHub",
    Deploy: "Desplegar",
    Monitoring: "Monitoreo",
    Logs: "Registros",
    Settings: "Configuracion",
    Workspaces: "Espacios de trabajo",
    "Main Operations": "Operaciones principales",
    "Deploy intelligence anywhere.": "Implementa inteligencia en cualquier lugar.",
    Operational: "Operativo",
    "Log Out": "Cerrar sesion",
    Collapse: "Contraer",
    "Expand sidebar": "Expandir barra lateral",
    "Collapse sidebar": "Contraer barra lateral",
    "System status and first-run progress.": "Estado del sistema y avance inicial.",
    "Inspect, filter, and operate your deployed agents.":
      "Inspecciona, filtra y opera tus agentes desplegados.",
    "Validate runtime health, logs, chat, and terminal access.":
      "Valida salud del runtime, registros, chat y acceso terminal.",
    "Step 2 of 3 — deploy an agent, then validate it immediately.":
      "Paso 2 de 3: despliega un agente y validalo de inmediato.",
    "Review account activity, request failures, and runtime events.":
      "Revisa actividad de la cuenta, fallos de solicitudes y eventos del runtime.",
    "Step 1 of 3 — connect one provider before the first deploy.":
      "Paso 1 de 3: conecta un proveedor antes del primer despliegue.",
    "Follow the shortest path from setup to live operations.":
      "Sigue la ruta mas corta desde la configuracion hasta la operacion en vivo.",
    "Operate your agent fleet from one operator surface.":
      "Opera tu flota de agentes desde una sola superficie.",
    "System Critical": "Sistema critico",
    "System Warning": "Advertencia del sistema",
    "This page doesn't exist or has been moved.": "Esta pagina no existe o se ha movido.",
    "Back to Dashboard": "Volver al panel",
    "System Overview": "Resumen del sistema",
    "Fleet Management": "Gestion de flota",
    "Deploy New Agent": "Desplegar nuevo agente",
    "Bring Nora online like a production operator platform.":
      "Pon Nora en marcha como una plataforma operativa de produccion.",
    "Resource limits": "Limites de recursos",
    "Update password": "Actualizar contrasena",
    "Password updated successfully": "Contrasena actualizada correctamente",
    "Save API Key": "Guardar clave API",
    "Provider added!": "Proveedor agregado",
    "Add another": "Agregar otro",
    "Configured LLM providers": "Proveedores LLM configurados",
    "Next: Choose Skills": "Siguiente: elegir habilidades",
    "Deploy Agent & Open Validation": "Desplegar agente y abrir validacion",
    "Deployment queued": "Despliegue en cola",
    "Provisioning in progress": "Provisionamiento en curso",
    "General Settings": "Configuracion general",
    "Save name": "Guardar nombre",
    "Duplicate Agent": "Duplicar agente",
    Duplicate: "Duplicar",
    "Share to Agent Hub": "Compartir en Agent Hub",
    "Share template": "Compartir plantilla",
    "Install as new agent": "Instalar como agente nuevo",
    "Install template": "Instalar plantilla",
    Install: "Instalar",
    "Fleet monitoring": "Monitoreo de flota",
    "Account event log": "Registro de eventos de la cuenta",
    "Clear filters": "Borrar filtros",
    "Open queue": "Abrir cola",
    "View All": "Ver todo",
    Refresh: "Actualizar",
    Create: "Crear",
    "Delete workspace": "Eliminar espacio de trabajo",
    Created: "Creado",
    Updated: "Actualizado",
    Queued: "En cola",
    Running: "En ejecucion",
    Failed: "Fallido",
    Completed: "Completado",
    Active: "Activo",
    Waiting: "En espera",
    Warning: "Advertencia",
    Error: "Error",
    Healthy: "Saludable",
    Offline: "Sin conexion",
    Unknown: "Desconocido",
    "Enter current password": "Ingresa la contrasena actual",
    "At least 6 characters": "Al menos 6 caracteres",
    "Re-enter new password": "Vuelve a ingresar la nueva contrasena",
    "customer-support-operator": "operador-soporte-cliente",
    "Manage workspaces": "Gestionar espacios de trabajo",
    "Members & invitations": "Miembros e invitaciones",
    "Loading workspaces...": "Cargando espacios de trabajo...",
    Members: "Miembros",
    Invitations: "Invitaciones",
    "Invite member": "Invitar miembro",
    "Invite a teammate": "Invitar a un companero",
    "Pending invitations": "Invitaciones pendientes",
    Role: "Rol",
    Email: "Correo electronico",
    Owner: "Propietario",
    Admin: "Administrador",
    Editor: "Editor",
    Viewer: "Espectador",
    Revoke: "Revocar",
    Remove: "Eliminar",
    "Copy invitation link": "Copiar enlace de invitacion",
    "Invitation link copied": "Enlace de invitacion copiado",
    "Email sent to": "Correo enviado a",
    "Send invitation": "Enviar invitacion",
    Cancel: "Cancelar",
    "Accept invitation": "Aceptar invitacion",
    "Joined workspace": "Te uniste al espacio de trabajo",
    "Invitation token required": "Se requiere el token de invitacion",
    "Failed to load members": "No se pudieron cargar los miembros",
    "Failed to send invitation": "No se pudo enviar la invitacion",
    "Failed to update role": "No se pudo actualizar el rol",
    "Cannot remove the last owner of a workspace":
      "No se puede eliminar al ultimo propietario del espacio de trabajo",
    "API Keys": "Claves API",
    "Issue a new API key": "Emitir una nueva clave API",
    "Active keys": "Claves activas",
    "No API keys yet.": "Aun no hay claves API.",
    "Label (e.g. ci-deploy)": "Etiqueta (ej. ci-deploy)",
    Scopes: "Alcances",
    "Create key": "Crear clave",
    "New key created — copy it now": "Nueva clave creada — copiala ahora",
    "This is the only time the full token is shown.":
      "Esta es la unica vez que se muestra el token completo.",
    "Copied to clipboard": "Copiado al portapapeles",
    "Last used": "Ultimo uso",
    Revoked: "Revocada",
    "Insufficient permissions": "Permisos insuficientes",
    "Alert rules": "Reglas de alerta",
    "Cost dashboard": "Panel de costos",
    "Budget alerts": "Alertas de presupuesto",
    "Version history": "Historial de versiones",
    "Back to agent": "Volver al agente",
    "Back to workspaces": "Volver a los espacios de trabajo",
    "Back to workspace settings": "Volver a la configuracion del espacio de trabajo",
    "No version history yet.": "Aun no hay historial de versiones.",
    "Roll back to this version": "Volver a esta version",
    Current: "Actual",
    "Create alert rule": "Crear regla de alerta",
    "Active rules": "Reglas activas",
    "No alert rules yet.": "Aun no hay reglas de alerta.",
    Budgets: "Presupuestos",
    "Total spend": "Gasto total",
    "Per-agent breakdown": "Desglose por agente",
    Daily: "Diario",
    Weekly: "Semanal",
    Monthly: "Mensual",
  },
  fr: {
    Nora: "Nora",
    Dashboard: "Tableau de bord",
    "Getting Started": "Premiers pas",
    Agents: "Agents",
    "Agent Details": "Details de l'agent",
    "Agent Hub": "Centre d'agents",
    ClawHub: "ClawHub",
    Deploy: "Deployer",
    Monitoring: "Surveillance",
    Logs: "Journaux",
    Settings: "Parametres",
    Workspaces: "Espaces de travail",
    "Main Operations": "Operations principales",
    "Deploy intelligence anywhere.": "Deployer l'intelligence partout.",
    Operational: "Operationnel",
    "Log Out": "Deconnexion",
    Collapse: "Reduire",
    "Expand sidebar": "Developper la barre laterale",
    "Collapse sidebar": "Reduire la barre laterale",
    "System status and first-run progress.": "Etat du systeme et progression initiale.",
    "Inspect, filter, and operate your deployed agents.":
      "Inspectez, filtrez et exploitez vos agents deployes.",
    "Validate runtime health, logs, chat, and terminal access.":
      "Validez la sante du runtime, les journaux, le chat et l'acces terminal.",
    "Step 2 of 3 — deploy an agent, then validate it immediately.":
      "Etape 2 sur 3 : deployez un agent, puis validez-le immediatement.",
    "Review account activity, request failures, and runtime events.":
      "Consultez l'activite du compte, les echecs de requetes et les evenements runtime.",
    "Step 1 of 3 — connect one provider before the first deploy.":
      "Etape 1 sur 3 : connectez un fournisseur avant le premier deploiement.",
    "Follow the shortest path from setup to live operations.":
      "Suivez le chemin le plus court de la configuration aux operations en direct.",
    "Operate your agent fleet from one operator surface.":
      "Exploitez votre flotte d'agents depuis une seule interface.",
    "System Critical": "Systeme critique",
    "System Warning": "Avertissement systeme",
    "This page doesn't exist or has been moved.": "Cette page n'existe pas ou a ete deplacee.",
    "Back to Dashboard": "Retour au tableau de bord",
    "System Overview": "Vue d'ensemble du systeme",
    "Fleet Management": "Gestion de flotte",
    "Deploy New Agent": "Deployer un nouvel agent",
    "Bring Nora online like a production operator platform.":
      "Mettez Nora en ligne comme une plateforme operateur de production.",
    "Resource limits": "Limites de ressources",
    "Update password": "Mettre a jour le mot de passe",
    "Password updated successfully": "Mot de passe mis a jour",
    "Save API Key": "Enregistrer la cle API",
    "Provider added!": "Fournisseur ajoute",
    "Add another": "En ajouter un autre",
    "Configured LLM providers": "Fournisseurs LLM configures",
    "Next: Choose Skills": "Suivant : choisir les competences",
    "Deploy Agent & Open Validation": "Deployer l'agent et ouvrir la validation",
    "Deployment queued": "Deploiement en file d'attente",
    "Provisioning in progress": "Provisionnement en cours",
    "General Settings": "Parametres generaux",
    "Save name": "Enregistrer le nom",
    "Duplicate Agent": "Dupliquer l'agent",
    Duplicate: "Dupliquer",
    "Share to Agent Hub": "Partager dans Agent Hub",
    "Share template": "Partager le modele",
    "Install as new agent": "Installer comme nouvel agent",
    "Install template": "Installer le modele",
    Install: "Installer",
    "Fleet monitoring": "Surveillance de flotte",
    "Account event log": "Journal des evenements du compte",
    "Clear filters": "Effacer les filtres",
    "Open queue": "Ouvrir la file",
    "View All": "Tout voir",
    Refresh: "Actualiser",
    Create: "Creer",
    "Delete workspace": "Supprimer l'espace de travail",
    Created: "Cree",
    Updated: "Mis a jour",
    Queued: "En file d'attente",
    Running: "En cours",
    Failed: "Echec",
    Completed: "Termine",
    Active: "Actif",
    Waiting: "En attente",
    Warning: "Avertissement",
    Error: "Erreur",
    Healthy: "Sain",
    Offline: "Hors ligne",
    Unknown: "Inconnu",
    "Enter current password": "Saisissez le mot de passe actuel",
    "At least 6 characters": "Au moins 6 caracteres",
    "Re-enter new password": "Saisissez a nouveau le nouveau mot de passe",
    "customer-support-operator": "operateur-support-client",
    "Manage workspaces": "Gerer les espaces de travail",
    "Members & invitations": "Membres et invitations",
    "Loading workspaces...": "Chargement des espaces de travail...",
    Members: "Membres",
    Invitations: "Invitations",
    "Invite member": "Inviter un membre",
    "Invite a teammate": "Inviter un coequipier",
    "Pending invitations": "Invitations en attente",
    Role: "Role",
    Email: "Email",
    Owner: "Proprietaire",
    Admin: "Administrateur",
    Editor: "Editeur",
    Viewer: "Spectateur",
    Revoke: "Revoquer",
    Remove: "Supprimer",
    "Copy invitation link": "Copier le lien d'invitation",
    "Invitation link copied": "Lien d'invitation copie",
    "Email sent to": "Email envoye a",
    "Send invitation": "Envoyer l'invitation",
    Cancel: "Annuler",
    "Accept invitation": "Accepter l'invitation",
    "Joined workspace": "Vous avez rejoint l'espace de travail",
    "Invitation token required": "Jeton d'invitation requis",
    "Failed to load members": "Echec du chargement des membres",
    "Failed to send invitation": "Echec de l'envoi de l'invitation",
    "Failed to update role": "Echec de la mise a jour du role",
    "Cannot remove the last owner of a workspace":
      "Impossible de supprimer le dernier proprietaire d'un espace de travail",
    "API Keys": "Cles API",
    "Issue a new API key": "Emettre une nouvelle cle API",
    "Active keys": "Cles actives",
    "No API keys yet.": "Aucune cle API pour l'instant.",
    "Label (e.g. ci-deploy)": "Etiquette (ex. ci-deploy)",
    Scopes: "Portees",
    "Create key": "Creer la cle",
    "New key created — copy it now": "Nouvelle cle creee — copiez-la maintenant",
    "This is the only time the full token is shown.":
      "C'est la seule fois ou le jeton complet est affiche.",
    "Copied to clipboard": "Copie dans le presse-papiers",
    "Last used": "Derniere utilisation",
    Revoked: "Revoquee",
    "Insufficient permissions": "Autorisations insuffisantes",
    "Alert rules": "Regles d'alerte",
    "Cost dashboard": "Tableau de cout",
    "Budget alerts": "Alertes de budget",
    "Version history": "Historique des versions",
    "Back to agent": "Retour a l'agent",
    "Back to workspaces": "Retour aux espaces de travail",
    "Back to workspace settings": "Retour aux parametres de l'espace de travail",
    "No version history yet.": "Aucun historique de versions.",
    "Roll back to this version": "Revenir a cette version",
    Current: "Actuelle",
    "Create alert rule": "Creer une regle d'alerte",
    "Active rules": "Regles actives",
    "No alert rules yet.": "Aucune regle d'alerte pour l'instant.",
    Budgets: "Budgets",
    "Total spend": "Depense totale",
    "Per-agent breakdown": "Repartition par agent",
    Daily: "Quotidien",
    Weekly: "Hebdomadaire",
    Monthly: "Mensuel",
  },
  "zh-Hans": {
    Nora: "Nora",
    Dashboard: "仪表板",
    "Getting Started": "入门",
    Agents: "代理",
    "Agent Details": "代理详情",
    "Agent Hub": "代理中心",
    ClawHub: "ClawHub",
    Deploy: "部署",
    Monitoring: "监控",
    Logs: "日志",
    Settings: "设置",
    Workspaces: "工作区",
    "Main Operations": "主要操作",
    "Deploy intelligence anywhere.": "在任何地方部署智能。",
    Operational: "运行正常",
    "Log Out": "退出登录",
    Collapse: "折叠",
    "Expand sidebar": "展开侧边栏",
    "Collapse sidebar": "折叠侧边栏",
    "System status and first-run progress.": "系统状态和首次运行进度。",
    "Inspect, filter, and operate your deployed agents.": "检查、筛选并操作已部署的代理。",
    "Validate runtime health, logs, chat, and terminal access.":
      "验证运行时健康、日志、聊天和终端访问。",
    "Step 2 of 3 — deploy an agent, then validate it immediately.":
      "第 2 步，共 3 步：部署代理，然后立即验证。",
    "Review account activity, request failures, and runtime events.":
      "查看账户活动、请求失败和运行时事件。",
    "Step 1 of 3 — connect one provider before the first deploy.":
      "第 1 步，共 3 步：首次部署前连接一个提供商。",
    "Follow the shortest path from setup to live operations.": "遵循从设置到实时运营的最短路径。",
    "Operate your agent fleet from one operator surface.": "从一个操作界面管理您的代理队伍。",
    "System Critical": "系统严重",
    "System Warning": "系统警告",
    "This page doesn't exist or has been moved.": "此页面不存在或已被移动。",
    "Back to Dashboard": "返回仪表板",
    "System Overview": "系统概览",
    "Fleet Management": "队伍管理",
    "Deploy New Agent": "部署新代理",
    "Bring Nora online like a production operator platform.": "像生产操作员平台一样让 Nora 上线。",
    "Resource limits": "资源限制",
    "Update password": "更新密码",
    "Password updated successfully": "密码已成功更新",
    "Save API Key": "保存 API 密钥",
    "Provider added!": "已添加提供商！",
    "Add another": "再添加一个",
    "Configured LLM providers": "已配置的 LLM 提供商",
    "Next: Choose Skills": "下一步：选择技能",
    "Deploy Agent & Open Validation": "部署代理并打开验证",
    "Deployment queued": "部署已排队",
    "Provisioning in progress": "正在预配",
    "General Settings": "常规设置",
    "Save name": "保存名称",
    "Duplicate Agent": "复制代理",
    Duplicate: "复制",
    "Share to Agent Hub": "分享到 Agent Hub",
    "Share template": "分享模板",
    "Install as new agent": "安装为新代理",
    "Install template": "安装模板",
    Install: "安装",
    "Fleet monitoring": "队伍监控",
    "Account event log": "账户事件日志",
    "Clear filters": "清除筛选器",
    "Open queue": "打开队列",
    "View All": "查看全部",
    Refresh: "刷新",
    Create: "创建",
    "Delete workspace": "删除工作区",
    Created: "已创建",
    Updated: "已更新",
    Queued: "已排队",
    Running: "运行中",
    Failed: "失败",
    Completed: "已完成",
    Active: "活动",
    Waiting: "等待中",
    Warning: "警告",
    Error: "错误",
    Healthy: "健康",
    Offline: "离线",
    Unknown: "未知",
    "Enter current password": "输入当前密码",
    "At least 6 characters": "至少 6 个字符",
    "Re-enter new password": "重新输入新密码",
    "customer-support-operator": "客户支持操作员",
    "Manage workspaces": "管理工作区",
    "Members & invitations": "成员和邀请",
    "Loading workspaces...": "正在加载工作区...",
    Members: "成员",
    Invitations: "邀请",
    "Invite member": "邀请成员",
    "Invite a teammate": "邀请队友",
    "Pending invitations": "待处理的邀请",
    Role: "角色",
    Email: "电子邮件",
    Owner: "所有者",
    Admin: "管理员",
    Editor: "编辑者",
    Viewer: "查看者",
    Revoke: "撤销",
    Remove: "移除",
    "Copy invitation link": "复制邀请链接",
    "Invitation link copied": "邀请链接已复制",
    "Email sent to": "邮件已发送至",
    "Send invitation": "发送邀请",
    Cancel: "取消",
    "Accept invitation": "接受邀请",
    "Joined workspace": "已加入工作区",
    "Invitation token required": "需要邀请令牌",
    "Failed to load members": "加载成员失败",
    "Failed to send invitation": "发送邀请失败",
    "Failed to update role": "更新角色失败",
    "Cannot remove the last owner of a workspace": "无法移除工作区的最后一个所有者",
    "API Keys": "API 密钥",
    "Issue a new API key": "签发新的 API 密钥",
    "Active keys": "活动密钥",
    "No API keys yet.": "尚无 API 密钥。",
    "Label (e.g. ci-deploy)": "标签 (例如 ci-deploy)",
    Scopes: "权限范围",
    "Create key": "创建密钥",
    "New key created — copy it now": "新密钥已创建 — 立即复制",
    "This is the only time the full token is shown.": "这是唯一一次显示完整令牌。",
    "Copied to clipboard": "已复制到剪贴板",
    "Last used": "最后使用",
    Revoked: "已撤销",
    "Insufficient permissions": "权限不足",
    "Alert rules": "告警规则",
    "Cost dashboard": "成本仪表板",
    "Budget alerts": "预算告警",
    "Version history": "版本历史",
    "Back to agent": "返回代理",
    "Back to workspaces": "返回工作区",
    "Back to workspace settings": "返回工作区设置",
    "No version history yet.": "尚无版本历史。",
    "Roll back to this version": "回滚到此版本",
    Current: "当前",
    "Create alert rule": "创建告警规则",
    "Active rules": "活动规则",
    "No alert rules yet.": "尚无告警规则。",
    Budgets: "预算",
    "Total spend": "总支出",
    "Per-agent breakdown": "按代理细分",
    Daily: "每日",
    Weekly: "每周",
    Monthly: "每月",
  },
  "zh-Hant": {
    Nora: "Nora",
    Dashboard: "儀表板",
    "Getting Started": "入門",
    Agents: "代理",
    "Agent Details": "代理詳細資料",
    "Agent Hub": "代理中心",
    ClawHub: "ClawHub",
    Deploy: "部署",
    Monitoring: "監控",
    Logs: "日誌",
    Settings: "設定",
    Workspaces: "工作區",
    "Main Operations": "主要操作",
    "Deploy intelligence anywhere.": "在任何地方部署智慧。",
    Operational: "運作正常",
    "Log Out": "登出",
    Collapse: "收合",
    "Expand sidebar": "展開側邊欄",
    "Collapse sidebar": "收合側邊欄",
    "System status and first-run progress.": "系統狀態和首次執行進度。",
    "Inspect, filter, and operate your deployed agents.": "檢查、篩選並操作已部署的代理。",
    "Validate runtime health, logs, chat, and terminal access.":
      "驗證執行階段健康、日誌、聊天和終端機存取。",
    "Step 2 of 3 — deploy an agent, then validate it immediately.":
      "第 2 步，共 3 步：部署代理，然後立即驗證。",
    "Review account activity, request failures, and runtime events.":
      "查看帳戶活動、請求失敗和執行階段事件。",
    "Step 1 of 3 — connect one provider before the first deploy.":
      "第 1 步，共 3 步：首次部署前連接一個提供者。",
    "Follow the shortest path from setup to live operations.": "遵循從設定到即時營運的最短路徑。",
    "Operate your agent fleet from one operator surface.": "從一個操作介面管理您的代理隊伍。",
    "System Critical": "系統嚴重",
    "System Warning": "系統警告",
    "This page doesn't exist or has been moved.": "此頁面不存在或已被移動。",
    "Back to Dashboard": "返回儀表板",
    "System Overview": "系統概覽",
    "Fleet Management": "隊伍管理",
    "Deploy New Agent": "部署新代理",
    "Bring Nora online like a production operator platform.": "像生產操作員平台一樣讓 Nora 上線。",
    "Resource limits": "資源限制",
    "Update password": "更新密碼",
    "Password updated successfully": "密碼已成功更新",
    "Save API Key": "儲存 API 金鑰",
    "Provider added!": "已新增提供者！",
    "Add another": "再新增一個",
    "Configured LLM providers": "已設定的 LLM 提供者",
    "Next: Choose Skills": "下一步：選擇技能",
    "Deploy Agent & Open Validation": "部署代理並開啟驗證",
    "Deployment queued": "部署已排入佇列",
    "Provisioning in progress": "正在佈建",
    "General Settings": "一般設定",
    "Save name": "儲存名稱",
    "Duplicate Agent": "複製代理",
    Duplicate: "複製",
    "Share to Agent Hub": "分享到 Agent Hub",
    "Share template": "分享範本",
    "Install as new agent": "安裝為新代理",
    "Install template": "安裝範本",
    Install: "安裝",
    "Fleet monitoring": "隊伍監控",
    "Account event log": "帳戶事件日誌",
    "Clear filters": "清除篩選器",
    "Open queue": "開啟佇列",
    "View All": "查看全部",
    Refresh: "重新整理",
    Create: "建立",
    "Delete workspace": "刪除工作區",
    Created: "已建立",
    Updated: "已更新",
    Queued: "已排入佇列",
    Running: "執行中",
    Failed: "失敗",
    Completed: "已完成",
    Active: "啟用",
    Waiting: "等待中",
    Warning: "警告",
    Error: "錯誤",
    Healthy: "健康",
    Offline: "離線",
    Unknown: "未知",
    "Enter current password": "輸入目前密碼",
    "At least 6 characters": "至少 6 個字元",
    "Re-enter new password": "重新輸入新密碼",
    "customer-support-operator": "客戶支援操作員",
    "Manage workspaces": "管理工作區",
    "Members & invitations": "成員和邀請",
    "Loading workspaces...": "正在載入工作區...",
    Members: "成員",
    Invitations: "邀請",
    "Invite member": "邀請成員",
    "Invite a teammate": "邀請隊友",
    "Pending invitations": "待處理的邀請",
    Role: "角色",
    Email: "電子郵件",
    Owner: "擁有者",
    Admin: "管理員",
    Editor: "編輯者",
    Viewer: "檢視者",
    Revoke: "撤銷",
    Remove: "移除",
    "Copy invitation link": "複製邀請連結",
    "Invitation link copied": "邀請連結已複製",
    "Email sent to": "郵件已傳送至",
    "Send invitation": "傳送邀請",
    Cancel: "取消",
    "Accept invitation": "接受邀請",
    "Joined workspace": "已加入工作區",
    "Invitation token required": "需要邀請權杖",
    "Failed to load members": "載入成員失敗",
    "Failed to send invitation": "傳送邀請失敗",
    "Failed to update role": "更新角色失敗",
    "Cannot remove the last owner of a workspace": "無法移除工作區的最後一個擁有者",
    "API Keys": "API 金鑰",
    "Issue a new API key": "簽發新的 API 金鑰",
    "Active keys": "啟用中的金鑰",
    "No API keys yet.": "尚無 API 金鑰。",
    "Label (e.g. ci-deploy)": "標籤 (例如 ci-deploy)",
    Scopes: "權限範圍",
    "Create key": "建立金鑰",
    "New key created — copy it now": "新金鑰已建立 — 立即複製",
    "This is the only time the full token is shown.": "這是唯一一次顯示完整權杖。",
    "Copied to clipboard": "已複製到剪貼簿",
    "Last used": "最後使用",
    Revoked: "已撤銷",
    "Insufficient permissions": "權限不足",
    "Alert rules": "告警規則",
    "Cost dashboard": "成本儀表板",
    "Budget alerts": "預算告警",
    "Version history": "版本歷史",
    "Back to agent": "返回代理",
    "Back to workspaces": "返回工作區",
    "Back to workspace settings": "返回工作區設定",
    "No version history yet.": "尚無版本歷史。",
    "Roll back to this version": "回滾到此版本",
    Current: "目前",
    "Create alert rule": "建立告警規則",
    "Active rules": "啟用中的規則",
    "No alert rules yet.": "尚無告警規則。",
    Budgets: "預算",
    "Total spend": "總支出",
    "Per-agent breakdown": "按代理細分",
    Daily: "每日",
    Weekly: "每週",
    Monthly: "每月",
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

export function marketingPath(path: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return path;
  const [pathname, suffix = ""] = path.split(/([?#].*)/, 2);
  return `/${locale}${pathname === "/" ? "" : pathname}${suffix}`;
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

  const [pathname, suffix = ""] = path.split(/([?#].*)/, 2);
  const appRelative = (pathname || "/").replace(new RegExp(`^${APP_BASE_PATH}`), "") || "/";
  const withoutLocale = appRelative.replace(/^\/(en|es|fr|zh-Hans|zh-Hant)(?=\/|$)/, "") || "/";
  const localized =
    locale === DEFAULT_LOCALE
      ? `${APP_BASE_PATH}${withoutLocale === "/" ? "" : withoutLocale}`
      : `${APP_BASE_PATH}/${locale}${withoutLocale === "/" ? "" : withoutLocale}`;
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
  if (element.getAttribute(attr) !== value) {
    element.setAttribute(attr, value);
  }
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
              const original = textOriginals.get(text) || "";
              text.textContent = translateText(original.trim(), locale);
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

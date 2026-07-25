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
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

const TRANSLATIONS = {
  es: {
    "Deploy intelligence anywhere.": "Implementa inteligencia en cualquier lugar.",
    "Nora — Run OpenClaw & Hermes on your infrastructure":
      "Nora — Ejecuta OpenClaw y Hermes en tu infraestructura",
    "Try a zero-key demo, then deploy, monitor, and operate OpenClaw and Hermes fleets on Docker or Kubernetes with Nora's Apache-2.0 control plane.":
      "Prueba una demo sin claves y luego despliega, supervisa y opera flotas de OpenClaw y Hermes en Docker o Kubernetes con el plano de control Apache-2.0 de Nora.",
    "Nora operator dashboard for OpenClaw and Hermes fleets":
      "Panel de operador de Nora para flotas de OpenClaw y Hermes",
    Docs: "Documentación",
    Contribute: "Contribuir",
    Star: "Dar estrella",
    "Try Demo": "Probar demo",
    Community: "Comunidad",
    "Try the zero-key demo": "Prueba la demo sin claves",
    "Star Nora on GitHub": "Dale una estrella a Nora en GitHub",
    "Apache-2.0 control plane for agent runtimes":
      "Plano de control Apache-2.0 para runtimes de agentes",
    "Run OpenClaw and Hermes on infrastructure you control.":
      "Ejecuta OpenClaw y Hermes en infraestructura bajo tu control.",
    "Nora gives operators one place to deploy, observe, and control agent runtimes on GA Docker and Kubernetes targets. Start with a zero-key demo, then connect providers, inspect logs and metrics, open terminals, and operate the fleet from one dashboard.":
      "Nora ofrece a los operadores un único lugar para desplegar, observar y controlar runtimes de agentes en destinos Docker y Kubernetes con disponibilidad general. Empieza con una demo sin claves y luego conecta proveedores, revisa registros y métricas, abre terminales y opera toda la flota desde un solo panel.",
    "Star on GitHub": "Danos una estrella en GitHub",
    "Self-host Nora": "Aloja Nora por tu cuenta",
    "Docker + Kubernetes GA": "Docker + Kubernetes con disponibilidad general",
    "Latest release": "Última versión",
    "Read the docs": "Lee la documentación",
    "Join the community": "Únete a la comunidad",
    "Real product capture": "Captura real del producto",
    "Nora operator dashboard showing active agents and recent deployments":
      "Panel de operador de Nora con agentes activos y despliegues recientes",
    "Seeded local capture: fleet health, queues, and deployment status.":
      "Captura local con datos de ejemplo: salud de la flota, colas y estado de despliegue.",
    "Watch 37s walkthrough": "Ver recorrido de 37 s",
    "Open source": "Código abierto",
    "Read the source, audit the architecture, and run Nora before you commit to it.":
      "Lee el código, audita la arquitectura y ejecuta Nora antes de adoptarla.",
    "Zero-key first proof": "Primera prueba sin claves",
    "Deploy the built-in deterministic demo agent before connecting a paid model provider.":
      "Despliega el agente de demo determinista integrado antes de conectar un proveedor de modelos de pago.",
    "Self-hosted control": "Control autohospedado",
    "Deploy the control plane on infrastructure you operate, with GA agent placement on Docker and Kubernetes.":
      "Despliega el plano de control en infraestructura que operas, con agentes en Docker y Kubernetes con disponibilidad general.",
    "Runtime operations": "Operaciones de runtime",
    "Deploy OpenClaw or Hermes, manage provider keys, inspect logs, and open runtime terminals.":
      "Despliega OpenClaw o Hermes, administra claves de proveedores, revisa registros y abre terminales de runtime.",
    "Fully open source. Commercial self-hosting allowed.":
      "Completamente open source. Autohospedaje comercial permitido.",
    Platform: "Plataforma",
    Workflow: "Flujo de trabajo",
    Trust: "Confianza",
    License: "Licencia",
    GitHub: "GitHub",
    "GitHub Repo": "Repositorio de GitHub",
    "Log In": "Iniciar sesion",
    "Create Account": "Crear cuenta",
    "Open Quick Start": "Abrir inicio rapido",
    "View GitHub Repo": "Ver repositorio de GitHub",
    "Public repo first": "Repositorio publico primero",
    "Open source repo": "Repositorio open source",
    "Self-host guide": "Guia de autohospedaje",
    "Easy access": "Acceso sencillo",
    "Log in to your operator account": "Inicia sesion en tu cuenta de operador",
    "Use email and password for this Nora instance. If OAuth is enabled here, you can use that too.":
      "Usa correo electronico y contrasena para esta instancia de Nora. Si OAuth esta habilitado, tambien puedes usarlo.",
    "Continue with Google": "Continuar con Google",
    "Continue with GitHub": "Continuar con GitHub",
    "or use email": "o usa correo electronico",
    "email login": "inicio de sesion con correo",
    "email signup": "registro con correo",
    "Email address": "Correo electronico",
    Password: "Contrasena",
    "Log in": "Iniciar sesion",
    "Logging in...": "Iniciando sesion...",
    "Create operator account": "Crear cuenta de operador",
    "Easy account creation": "Creacion de cuenta sencilla",
    "Create a secure password": "Crea una contrasena segura",
    "Creating account...": "Creando cuenta...",
    "Already have an account?": "Ya tienes una cuenta?",
    "Need an account?": "Necesitas una cuenta?",
    "Sign in instead": "Inicia sesion",
    "Create one": "Crea una",
    "Back to Home": "Volver al inicio",
    "This page doesn't exist or has been moved.": "Esta pagina no existe o se ha movido.",
    "Signing you in...": "Iniciando sesion...",
    "Login failed. Check your email and password and try again.":
      "No se pudo iniciar sesion. Revisa tu correo y contrasena e intentalo de nuevo.",
    "Login failed. Please try again.": "No se pudo iniciar sesion. Intentalo de nuevo.",
    "Could not create the account. Please try again.":
      "No se pudo crear la cuenta. Intentalo de nuevo.",
    "Open Source, License, and PaaS Mode": "Open source, licencia y modo PaaS",
    "Apache 2.0 rights, self-hosting, and PaaS mode":
      "Derechos Apache 2.0, autohospedaje y modo PaaS",
    "Open source licensing with room to operate.": "Licencia open source con margen para operar.",
    "What Apache 2.0 means here": "Que significa Apache 2.0 aqui",
    "Apache 2.0 rights": "Derechos Apache 2.0",
    "Public site": "Sitio publico",
    "Create account": "Crear cuenta",
    "Public GitHub repo": "Repositorio publico de GitHub",
    "README quick start": "Inicio rapido del README",
    "Bash installer": "Instalador Bash",
    "PowerShell installer": "Instalador PowerShell",
    "Public browser entry": "Entrada publica del navegador",
    "Self-hosted mode": "Modo autohospedado",
    "PaaS mode": "Modo PaaS",
    "Run Nora as your own agent operations platform.":
      "Ejecuta Nora como tu propia plataforma de operaciones de agentes.",
    "Operate Nora as your own hosted product or internal platform.":
      "Opera Nora como tu propio producto alojado o plataforma interna.",
    "Use the default public domain as a reference deployment.":
      "Usa el dominio publico predeterminado como despliegue de referencia.",
    "Browse Nora on GitHub": "Explora Nora en GitHub",
    "Open the quick start": "Abrir inicio rapido",
    "Instance note": "Nota de la instancia",
    "Why this page exists": "Por que existe esta pagina",
    "After account creation": "Despues de crear la cuenta",
  },
  fr: {
    "Deploy intelligence anywhere.": "Deployer l'intelligence partout.",
    "Nora — Run OpenClaw & Hermes on your infrastructure":
      "Nora — Exécutez OpenClaw et Hermes sur votre infrastructure",
    "Try a zero-key demo, then deploy, monitor, and operate OpenClaw and Hermes fleets on Docker or Kubernetes with Nora's Apache-2.0 control plane.":
      "Essayez une démo sans clé, puis déployez, surveillez et exploitez des flottes OpenClaw et Hermes sur Docker ou Kubernetes avec le plan de contrôle Apache-2.0 de Nora.",
    "Nora operator dashboard for OpenClaw and Hermes fleets":
      "Tableau de bord opérateur Nora pour les flottes OpenClaw et Hermes",
    Docs: "Documentation",
    Contribute: "Contribuer",
    Star: "Ajouter une étoile",
    "Try Demo": "Essayer la démo",
    Community: "Communauté",
    "Try the zero-key demo": "Essayer la démo sans clé",
    "Star Nora on GitHub": "Ajouter une étoile à Nora sur GitHub",
    "Apache-2.0 control plane for agent runtimes":
      "Plan de contrôle Apache-2.0 pour les runtimes d'agents",
    "Run OpenClaw and Hermes on infrastructure you control.":
      "Exécutez OpenClaw et Hermes sur une infrastructure que vous contrôlez.",
    "Nora gives operators one place to deploy, observe, and control agent runtimes on GA Docker and Kubernetes targets. Start with a zero-key demo, then connect providers, inspect logs and metrics, open terminals, and operate the fleet from one dashboard.":
      "Nora offre aux opérateurs un espace unique pour déployer, observer et contrôler des runtimes d'agents sur les cibles Docker et Kubernetes disponibles en production. Commencez par une démo sans clé, puis connectez des fournisseurs, consultez les journaux et les métriques, ouvrez des terminaux et exploitez toute la flotte depuis un seul tableau de bord.",
    "Star on GitHub": "Ajouter une étoile sur GitHub",
    "Self-host Nora": "Auto-héberger Nora",
    "Docker + Kubernetes GA": "Docker + Kubernetes en disponibilité générale",
    "Latest release": "Dernière version",
    "Read the docs": "Lire la documentation",
    "Join the community": "Rejoindre la communauté",
    "Real product capture": "Capture réelle du produit",
    "Nora operator dashboard showing active agents and recent deployments":
      "Tableau de bord opérateur Nora affichant les agents actifs et les déploiements récents",
    "Seeded local capture: fleet health, queues, and deployment status.":
      "Capture locale avec données d'exemple : état de la flotte, files d'attente et statut des déploiements.",
    "Watch 37s walkthrough": "Voir la visite de 37 s",
    "Open source": "Code source ouvert",
    "Read the source, audit the architecture, and run Nora before you commit to it.":
      "Lisez le code, auditez l'architecture et exécutez Nora avant de l'adopter.",
    "Zero-key first proof": "Première preuve sans clé",
    "Deploy the built-in deterministic demo agent before connecting a paid model provider.":
      "Déployez l'agent de démonstration déterministe intégré avant de connecter un fournisseur de modèles payant.",
    "Self-hosted control": "Contrôle auto-hébergé",
    "Deploy the control plane on infrastructure you operate, with GA agent placement on Docker and Kubernetes.":
      "Déployez le plan de contrôle sur votre propre infrastructure, avec des agents sur Docker et Kubernetes en disponibilité générale.",
    "Runtime operations": "Exploitation des runtimes",
    "Deploy OpenClaw or Hermes, manage provider keys, inspect logs, and open runtime terminals.":
      "Déployez OpenClaw ou Hermes, gérez les clés des fournisseurs, consultez les journaux et ouvrez des terminaux de runtime.",
    "Fully open source. Commercial self-hosting allowed.":
      "Entierement open source. Auto-hebergement commercial autorise.",
    Platform: "Plateforme",
    Workflow: "Flux de travail",
    Trust: "Confiance",
    License: "Licence",
    GitHub: "GitHub",
    "GitHub Repo": "Depot GitHub",
    "Log In": "Connexion",
    "Create Account": "Creer un compte",
    "Open Quick Start": "Ouvrir le demarrage rapide",
    "View GitHub Repo": "Voir le depot GitHub",
    "Public repo first": "Depot public d'abord",
    "Open source repo": "Depot open source",
    "Self-host guide": "Guide d'auto-hebergement",
    "Easy access": "Acces simple",
    "Log in to your operator account": "Connectez-vous a votre compte operateur",
    "Use email and password for this Nora instance. If OAuth is enabled here, you can use that too.":
      "Utilisez l'e-mail et le mot de passe pour cette instance Nora. Si OAuth est active ici, vous pouvez aussi l'utiliser.",
    "Continue with Google": "Continuer avec Google",
    "Continue with GitHub": "Continuer avec GitHub",
    "or use email": "ou utiliser l'e-mail",
    "email login": "connexion par e-mail",
    "email signup": "inscription par e-mail",
    "Email address": "Adresse e-mail",
    Password: "Mot de passe",
    "Log in": "Connexion",
    "Logging in...": "Connexion...",
    "Create operator account": "Creer un compte operateur",
    "Easy account creation": "Creation de compte simple",
    "Create a secure password": "Creez un mot de passe securise",
    "Creating account...": "Creation du compte...",
    "Already have an account?": "Vous avez deja un compte ?",
    "Need an account?": "Besoin d'un compte ?",
    "Sign in instead": "Connectez-vous plutot",
    "Create one": "Creez-en un",
    "Back to Home": "Retour a l'accueil",
    "This page doesn't exist or has been moved.": "Cette page n'existe pas ou a ete deplacee.",
    "Signing you in...": "Connexion en cours...",
    "Login failed. Check your email and password and try again.":
      "Echec de la connexion. Verifiez votre e-mail et votre mot de passe puis reessayez.",
    "Login failed. Please try again.": "Echec de la connexion. Veuillez reessayer.",
    "Could not create the account. Please try again.":
      "Impossible de creer le compte. Veuillez reessayer.",
    "Open Source, License, and PaaS Mode": "Open source, licence et mode PaaS",
    "Apache 2.0 rights, self-hosting, and PaaS mode":
      "Droits Apache 2.0, auto-hebergement et mode PaaS",
    "Open source licensing with room to operate.":
      "La licence open source laisse de la place pour operer.",
    "What Apache 2.0 means here": "Ce que signifie Apache 2.0 ici",
    "Apache 2.0 rights": "Droits Apache 2.0",
    "Public site": "Site public",
    "Create account": "Creer un compte",
    "Public GitHub repo": "Depot GitHub public",
    "README quick start": "Demarrage rapide du README",
    "Bash installer": "Installateur Bash",
    "PowerShell installer": "Installateur PowerShell",
    "Public browser entry": "Entree navigateur publique",
    "Self-hosted mode": "Mode auto-heberge",
    "PaaS mode": "Mode PaaS",
    "Run Nora as your own agent operations platform.":
      "Executez Nora comme votre propre plateforme d'operations d'agents.",
    "Operate Nora as your own hosted product or internal platform.":
      "Exploitez Nora comme votre propre produit heberge ou plateforme interne.",
    "Use the default public domain as a reference deployment.":
      "Utilisez le domaine public par defaut comme deploiement de reference.",
    "Browse Nora on GitHub": "Parcourir Nora sur GitHub",
    "Open the quick start": "Ouvrir le demarrage rapide",
    "Instance note": "Note d'instance",
    "Why this page exists": "Pourquoi cette page existe",
    "After account creation": "Apres la creation du compte",
  },
  "zh-Hans": {
    "Deploy intelligence anywhere.": "在任何地方部署智能。",
    "Nora — Run OpenClaw & Hermes on your infrastructure":
      "Nora — 在您的基础设施上运行 OpenClaw 和 Hermes",
    "Try a zero-key demo, then deploy, monitor, and operate OpenClaw and Hermes fleets on Docker or Kubernetes with Nora's Apache-2.0 control plane.":
      "先试用零密钥演示，然后使用 Nora 的 Apache-2.0 控制平面在 Docker 或 Kubernetes 上部署、监控和运营 OpenClaw 与 Hermes 集群。",
    "Nora operator dashboard for OpenClaw and Hermes fleets":
      "用于 OpenClaw 和 Hermes 集群的 Nora 运维控制台",
    Docs: "文档",
    Contribute: "参与贡献",
    Star: "加星",
    "Try Demo": "试用演示",
    Community: "社区",
    "Try the zero-key demo": "试用零密钥演示",
    "Star Nora on GitHub": "在 GitHub 上为 Nora 加星",
    "Apache-2.0 control plane for agent runtimes": "面向智能体运行时的 Apache-2.0 控制平面",
    "Run OpenClaw and Hermes on infrastructure you control.":
      "在您掌控的基础设施上运行 OpenClaw 和 Hermes。",
    "Nora gives operators one place to deploy, observe, and control agent runtimes on GA Docker and Kubernetes targets. Start with a zero-key demo, then connect providers, inspect logs and metrics, open terminals, and operate the fleet from one dashboard.":
      "Nora 为运维人员提供统一界面，在正式可用的 Docker 和 Kubernetes 目标上部署、观察和控制智能体运行时。先从零密钥演示开始，再连接模型提供商、查看日志与指标、打开终端，并从一个控制台运营整个集群。",
    "Star on GitHub": "在 GitHub 上加星",
    "Self-host Nora": "自托管 Nora",
    "Docker + Kubernetes GA": "Docker + Kubernetes 正式可用",
    "Latest release": "最新版本",
    "Read the docs": "阅读文档",
    "Join the community": "加入社区",
    "Real product capture": "真实产品截图",
    "Nora operator dashboard showing active agents and recent deployments":
      "展示活跃智能体和近期部署的 Nora 运维控制台",
    "Seeded local capture: fleet health, queues, and deployment status.":
      "带示例数据的本地截图：集群健康、队列和部署状态。",
    "Watch 37s walkthrough": "观看 37 秒演示",
    "Open source": "开源",
    "Read the source, audit the architecture, and run Nora before you commit to it.":
      "在采用 Nora 前阅读源码、审查架构并亲自运行。",
    "Zero-key first proof": "首次验证无需密钥",
    "Deploy the built-in deterministic demo agent before connecting a paid model provider.":
      "在连接付费模型提供商前，先部署内置的确定性演示智能体。",
    "Self-hosted control": "自托管控制",
    "Deploy the control plane on infrastructure you operate, with GA agent placement on Docker and Kubernetes.":
      "将控制平面部署在您运营的基础设施上，并在正式可用的 Docker 和 Kubernetes 目标上放置智能体。",
    "Runtime operations": "运行时运维",
    "Deploy OpenClaw or Hermes, manage provider keys, inspect logs, and open runtime terminals.":
      "部署 OpenClaw 或 Hermes、管理提供商密钥、查看日志并打开运行时终端。",
    "Fully open source. Commercial self-hosting allowed.": "完全开源。允许商业自托管。",
    Platform: "平台",
    Workflow: "工作流",
    Trust: "信任",
    License: "许可",
    GitHub: "GitHub",
    "GitHub Repo": "GitHub 仓库",
    "Log In": "登录",
    "Create Account": "创建账户",
    "Open Quick Start": "打开快速开始",
    "View GitHub Repo": "查看 GitHub 仓库",
    "Public repo first": "公共仓库优先",
    "Open source repo": "开源仓库",
    "Self-host guide": "自托管指南",
    "Easy access": "轻松访问",
    "Log in to your operator account": "登录您的操作员账户",
    "Use email and password for this Nora instance. If OAuth is enabled here, you can use that too.":
      "使用此 Nora 实例的电子邮件和密码。如果这里启用了 OAuth，也可以使用 OAuth。",
    "Continue with Google": "使用 Google 继续",
    "Continue with GitHub": "使用 GitHub 继续",
    "or use email": "或使用电子邮件",
    "email login": "电子邮件登录",
    "email signup": "电子邮件注册",
    "Email address": "电子邮件地址",
    Password: "密码",
    "Log in": "登录",
    "Logging in...": "正在登录...",
    "Create operator account": "创建操作员账户",
    "Easy account creation": "轻松创建账户",
    "Create a secure password": "创建安全密码",
    "Creating account...": "正在创建账户...",
    "Already have an account?": "已有账户？",
    "Need an account?": "需要账户？",
    "Sign in instead": "改为登录",
    "Create one": "创建一个",
    "Back to Home": "返回首页",
    "This page doesn't exist or has been moved.": "此页面不存在或已被移动。",
    "Signing you in...": "正在为您登录...",
    "Login failed. Check your email and password and try again.":
      "登录失败。请检查电子邮件和密码后重试。",
    "Login failed. Please try again.": "登录失败。请重试。",
    "Could not create the account. Please try again.": "无法创建账户。请重试。",
    "Open Source, License, and PaaS Mode": "开源、许可和 PaaS 模式",
    "Apache 2.0 rights, self-hosting, and PaaS mode": "Apache 2.0 权利、自托管和 PaaS 模式",
    "Open source licensing with room to operate.": "开源许可，保留运营空间。",
    "What Apache 2.0 means here": "Apache 2.0 在这里的含义",
    "Apache 2.0 rights": "Apache 2.0 权利",
    "Public site": "公共站点",
    "Create account": "创建账户",
    "Public GitHub repo": "公共 GitHub 仓库",
    "README quick start": "README 快速开始",
    "Bash installer": "Bash 安装器",
    "PowerShell installer": "PowerShell 安装器",
    "Public browser entry": "公共浏览器入口",
    "Self-hosted mode": "自托管模式",
    "PaaS mode": "PaaS 模式",
    "Run Nora as your own agent operations platform.": "将 Nora 作为您自己的代理运营平台运行。",
    "Operate Nora as your own hosted product or internal platform.":
      "将 Nora 作为您自己的托管产品或内部平台运营。",
    "Use the default public domain as a reference deployment.": "使用默认公共域名作为参考部署。",
    "Browse Nora on GitHub": "在 GitHub 上浏览 Nora",
    "Open the quick start": "打开快速开始",
    "Instance note": "实例说明",
    "Why this page exists": "此页面的用途",
    "After account creation": "账户创建后",
  },
  "zh-Hant": {
    "Deploy intelligence anywhere.": "在任何地方部署智慧。",
    "Nora — Run OpenClaw & Hermes on your infrastructure":
      "Nora — 在您的基礎設施上執行 OpenClaw 和 Hermes",
    "Try a zero-key demo, then deploy, monitor, and operate OpenClaw and Hermes fleets on Docker or Kubernetes with Nora's Apache-2.0 control plane.":
      "先試用零金鑰示範，再使用 Nora 的 Apache-2.0 控制平面，在 Docker 或 Kubernetes 上部署、監控及營運 OpenClaw 與 Hermes 叢集。",
    "Nora operator dashboard for OpenClaw and Hermes fleets":
      "用於 OpenClaw 和 Hermes 叢集的 Nora 營運控制台",
    Docs: "文件",
    Contribute: "參與貢獻",
    Star: "加星",
    "Try Demo": "試用示範",
    Community: "社群",
    "Try the zero-key demo": "試用零金鑰示範",
    "Star Nora on GitHub": "在 GitHub 上為 Nora 加星",
    "Apache-2.0 control plane for agent runtimes": "面向代理執行環境的 Apache-2.0 控制平面",
    "Run OpenClaw and Hermes on infrastructure you control.":
      "在您掌控的基礎設施上執行 OpenClaw 和 Hermes。",
    "Nora gives operators one place to deploy, observe, and control agent runtimes on GA Docker and Kubernetes targets. Start with a zero-key demo, then connect providers, inspect logs and metrics, open terminals, and operate the fleet from one dashboard.":
      "Nora 為營運人員提供單一介面，在正式可用的 Docker 和 Kubernetes 目標上部署、觀察及控制代理執行環境。先從零金鑰示範開始，再連接模型供應商、查看記錄與指標、開啟終端機，並從一個控制台營運整個叢集。",
    "Star on GitHub": "在 GitHub 上加星",
    "Self-host Nora": "自託管 Nora",
    "Docker + Kubernetes GA": "Docker + Kubernetes 正式可用",
    "Latest release": "最新版本",
    "Read the docs": "閱讀文件",
    "Join the community": "加入社群",
    "Real product capture": "真實產品截圖",
    "Nora operator dashboard showing active agents and recent deployments":
      "顯示作用中代理與近期部署的 Nora 營運控制台",
    "Seeded local capture: fleet health, queues, and deployment status.":
      "含範例資料的本機截圖：叢集健康、佇列及部署狀態。",
    "Watch 37s walkthrough": "觀看 37 秒導覽",
    "Open source": "開源",
    "Read the source, audit the architecture, and run Nora before you commit to it.":
      "在採用 Nora 前閱讀原始碼、稽核架構並親自執行。",
    "Zero-key first proof": "首次驗證無需金鑰",
    "Deploy the built-in deterministic demo agent before connecting a paid model provider.":
      "在連接付費模型供應商前，先部署內建的確定性示範代理。",
    "Self-hosted control": "自託管控制",
    "Deploy the control plane on infrastructure you operate, with GA agent placement on Docker and Kubernetes.":
      "將控制平面部署在您營運的基礎設施上，並在正式可用的 Docker 和 Kubernetes 目標上放置代理。",
    "Runtime operations": "執行環境營運",
    "Deploy OpenClaw or Hermes, manage provider keys, inspect logs, and open runtime terminals.":
      "部署 OpenClaw 或 Hermes、管理供應商金鑰、查看記錄並開啟執行環境終端機。",
    "Fully open source. Commercial self-hosting allowed.": "完全開源。允許商業自託管。",
    Platform: "平台",
    Workflow: "工作流程",
    Trust: "信任",
    License: "授權",
    GitHub: "GitHub",
    "GitHub Repo": "GitHub 儲存庫",
    "Log In": "登入",
    "Create Account": "建立帳戶",
    "Open Quick Start": "開啟快速開始",
    "View GitHub Repo": "查看 GitHub 儲存庫",
    "Public repo first": "公共儲存庫優先",
    "Open source repo": "開源儲存庫",
    "Self-host guide": "自託管指南",
    "Easy access": "輕鬆存取",
    "Log in to your operator account": "登入您的操作員帳戶",
    "Use email and password for this Nora instance. If OAuth is enabled here, you can use that too.":
      "使用此 Nora 執行個體的電子郵件和密碼。如果這裡啟用了 OAuth，也可以使用 OAuth。",
    "Continue with Google": "使用 Google 繼續",
    "Continue with GitHub": "使用 GitHub 繼續",
    "or use email": "或使用電子郵件",
    "email login": "電子郵件登入",
    "email signup": "電子郵件註冊",
    "Email address": "電子郵件地址",
    Password: "密碼",
    "Log in": "登入",
    "Logging in...": "正在登入...",
    "Create operator account": "建立操作員帳戶",
    "Easy account creation": "輕鬆建立帳戶",
    "Create a secure password": "建立安全密碼",
    "Creating account...": "正在建立帳戶...",
    "Already have an account?": "已有帳戶？",
    "Need an account?": "需要帳戶？",
    "Sign in instead": "改為登入",
    "Create one": "建立一個",
    "Back to Home": "返回首頁",
    "This page doesn't exist or has been moved.": "此頁面不存在或已被移動。",
    "Signing you in...": "正在為您登入...",
    "Login failed. Check your email and password and try again.":
      "登入失敗。請檢查電子郵件和密碼後重試。",
    "Login failed. Please try again.": "登入失敗。請重試。",
    "Could not create the account. Please try again.": "無法建立帳戶。請重試。",
    "Open Source, License, and PaaS Mode": "開源、授權和 PaaS 模式",
    "Apache 2.0 rights, self-hosting, and PaaS mode": "Apache 2.0 權利、自託管和 PaaS 模式",
    "Open source licensing with room to operate.": "開源授權，保留營運空間。",
    "What Apache 2.0 means here": "Apache 2.0 在這裡的含義",
    "Apache 2.0 rights": "Apache 2.0 權利",
    "Public site": "公共網站",
    "Create account": "建立帳戶",
    "Public GitHub repo": "公共 GitHub 儲存庫",
    "README quick start": "README 快速開始",
    "Bash installer": "Bash 安裝器",
    "PowerShell installer": "PowerShell 安裝器",
    "Public browser entry": "公共瀏覽器入口",
    "Self-hosted mode": "自託管模式",
    "PaaS mode": "PaaS 模式",
    "Run Nora as your own agent operations platform.": "將 Nora 作為您自己的代理營運平台執行。",
    "Operate Nora as your own hosted product or internal platform.":
      "將 Nora 作為您自己的託管產品或內部平台營運。",
    "Use the default public domain as a reference deployment.": "使用預設公共網域作為參考部署。",
    "Browse Nora on GitHub": "在 GitHub 上瀏覽 Nora",
    "Open the quick start": "開啟快速開始",
    "Instance note": "執行個體說明",
    "Why this page exists": "此頁面的用途",
    "After account creation": "帳戶建立後",
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
};

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  defaultLocale: DEFAULT_LOCALE,
  preferredLocale: null,
  t: (key) => key,
  localizePath: (path) => path,
  setLocale: async () => {},
  clearLocalePreference: async () => DEFAULT_LOCALE,
});

const ANONYMOUS_LOCALE_STORAGE_KEY = "nora_anonymous_locale";
let anonymousPreferredLocaleMemory: Locale | null = null;

export function normalizeLocale(value: string | undefined): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : DEFAULT_LOCALE;
}

function explicitLocaleFromRoute(value: string | undefined): Locale | null {
  const locale = normalizeLocale(value);
  return locale === DEFAULT_LOCALE ? null : locale;
}

function getAnonymousPreferredLocale(): Locale | null {
  if (typeof window === "undefined") return anonymousPreferredLocaleMemory;
  try {
    const value = window.localStorage.getItem(ANONYMOUS_LOCALE_STORAGE_KEY);
    if (!value || !LOCALES.includes(value as Locale)) return anonymousPreferredLocaleMemory;
    anonymousPreferredLocaleMemory = value as Locale;
    return anonymousPreferredLocaleMemory;
  } catch {
    return anonymousPreferredLocaleMemory;
  }
}

function setAnonymousPreferredLocale(locale: Locale | null) {
  anonymousPreferredLocaleMemory = locale;
  if (typeof window === "undefined") return;
  try {
    if (locale) {
      window.localStorage.setItem(ANONYMOUS_LOCALE_STORAGE_KEY, locale);
    } else {
      window.localStorage.removeItem(ANONYMOUS_LOCALE_STORAGE_KEY);
    }
  } catch {
    // Ignore unavailable storage; the in-memory fallback still covers this page session.
  }
}

async function fetchLanguagePreference() {
  const anonymousLocale = getAnonymousPreferredLocale();

  try {
    const configResponse = await fetch("/api/config/platform");
    if (configResponse.ok) {
      const config = await configResponse.json().catch(() => ({}));
      const defaultLocale = normalizeLocale(config.language?.defaultLocale);
      return {
        defaultLocale,
        preferredLocale: anonymousLocale,
        effectiveLocale: anonymousLocale || defaultLocale,
      };
    }
  } catch {
    // Keep the built-in default if config is unavailable.
  }

  return {
    defaultLocale: DEFAULT_LOCALE,
    preferredLocale: anonymousLocale,
    effectiveLocale: anonymousLocale || DEFAULT_LOCALE,
  };
}

export function translateText(value: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return value;
  return TRANSLATIONS[locale][value] || value;
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
  const [pathname, suffix = ""] = path.split(/([?#].*)/, 2);
  const cleanPath = pathname || "/";
  if (cleanPath.startsWith("/app") || cleanPath.startsWith("/admin")) {
    const [basePath, restPath = ""] = cleanPath.match(/^\/(app|admin)(.*)$/)?.slice(1) || [
      "",
      cleanPath,
    ];
    const withoutLocale =
      (restPath || "/").replace(/^\/(en|es|fr|zh-Hans|zh-Hant)(?=\/|$)/, "") || "/";
    const localized =
      locale === DEFAULT_LOCALE
        ? `/${basePath}${withoutLocale === "/" ? "" : withoutLocale}`
        : `/${basePath}/${locale}${withoutLocale === "/" ? "" : withoutLocale}`;
    return `${localized}${suffix}`;
  }
  const withoutLocale = cleanPath.replace(/^\/(en|es|fr|zh-Hans|zh-Hant)(?=\/|$)/, "") || "/";
  if (locale === DEFAULT_LOCALE) {
    return `${withoutLocale}${suffix}`;
  }
  return `/${locale}${withoutLocale === "/" ? "" : withoutLocale}${suffix}`;
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

function localizeElementText(root: ParentNode, locale: Locale) {
  for (const node of getTextNodes(root)) {
    let original = textOriginals.get(node);
    if (!original) {
      original = sourceTextWithWhitespace(node.textContent || "", locale);
      textOriginals.set(node, original);
    }
    const leading = original.match(/^\s*/)?.[0] || "";
    const trailing = original.match(/\s*$/)?.[0] || "";
    const translated = translateText(original.trim(), locale);
    node.textContent = `${leading}${translated}${trailing}`;
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

function StaticTextLocalizer({ locale }: { locale: Locale }) {
  useEffect(() => {
    localizeElementText(document.body, locale);
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
              localizeElementText(node, locale);
            }
          }
        } else if (mutation.type === "attributes" && mutation.target instanceof Element) {
          localizeElementText(mutation.target, locale);
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
      setAnonymousPreferredLocale(normalized);
      setPreferredLocale(normalized);
      setResolvedLocale(normalized);
      await router.push(router.pathname, router.asPath, { locale: normalized });
    },
    [router],
  );

  const clearLocalePreference = useCallback(async () => {
    setAnonymousPreferredLocale(null);
    setPreferredLocale(null);
    setResolvedLocale(defaultLocale);
    await router.push(router.pathname, router.asPath, { locale: defaultLocale });
    return defaultLocale;
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
    }),
    [clearLocalePreference, defaultLocale, locale, preferredLocale, setLocale],
  );

  return (
    <I18nContext.Provider value={value}>
      {children}
      <StaticTextLocalizer locale={locale} />
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}

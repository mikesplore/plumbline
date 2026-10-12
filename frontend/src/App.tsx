import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowRight, Braces, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleAlert, Clipboard, Code2, Copy,
  Eye, EyeOff, FileCheck2, FileJson2, FileUp, FlaskConical, Globe2, KeyRound,
  LoaderCircle, LockKeyhole, PanelLeftClose, PanelLeftOpen,
  Play, Search, Send, Settings2, ShieldCheck, Terminal, X,
} from "lucide-react";

type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: Record<string, unknown> };
type Operation = {
  id: string; method: string; path: string; summary: string; tags?: string[];
  parameters: Parameter[]; request_schema?: Record<string, unknown> | null;
  request_required?: boolean; security: string[];
};
type ApiModel = { title: string; version: string; operations: Operation[]; security_schemes?: Record<string, Record<string, string>> };
type Evidence = { method?: string; url?: string; headers?: Record<string, string>; body?: unknown; status?: number | null; body_snippet?: string; elapsed_ms?: number | null };
type Finding = {
  id: string; check: string; severity: "info" | "low" | "medium" | "high";
  status: "pass" | "fail" | "inconclusive"; operation_id?: string | null;
  expected: string; observed: string; cluster_key: string; variant?: string | null;
  request?: Evidence | null; response?: Evidence | null;
};
type RunReport = { run_id: string; base_url: string; started_at: string; findings: Finding[]; summary: Record<string, number> };
type RunSummary = {
  run_id: string; verdict: string; operation_count: number; counts: Record<string, number>;
  severity_status: Record<string, Record<string, number>>;
  failures_by_check: { check: string; count: number }[];
  clusters: { cluster_key: string; title: string; check: string; expected: string; observed: string; count: number; severity: string; sample_endpoints: { operation_id: string | null; method: string | null; path: string }[]; finding_ids: string[] }[];
};
type AuthMode = "bearer" | "apikey";
type Page = "import" | "explorer" | "runs" | "mcp" | "settings";
type AuthStatus = "missing" | "set" | "invalid";
type ResponsePayload = { status: number; url: string; headers: Record<string, string>; body: unknown; elapsed_ms: number };
type RequestTab = "Params" | "Body" | "Auth" | "Headers";
type ResponseTab = "Body" | "Headers" | "Timing";

const API = "/api";
const DEMO_SPEC_URL = import.meta.env.VITE_DEMO_SPEC_URL ?? "http://127.0.0.1:8001/openapi.json";
const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

function sampleFromSchema(schema?: Record<string, unknown>): unknown {
  if (!schema) return {};
  if ("example" in schema) return schema.example;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required ?? []) as string[]);
    return Object.fromEntries(Object.entries(properties).filter(([key]) => required.size === 0 || required.has(key)).map(([key, value]) => [key, sampleFromSchema(value)]));
  }
  if (schema.type === "array") return [sampleFromSchema(schema.items as Record<string, unknown>)];
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "string") return "example";
  return null;
}

function parameterInitialValue(parameter: Parameter): string {
  if (parameter.in === "path") return "";
  const value = sampleFromSchema(parameter.schema);
  return value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
}

function errorMessage(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "detail" in payload) return String((payload as { detail: unknown }).detail);
  return "The request could not be completed.";
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(payload));
  return payload as T;
}

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

function operationTag(operation: Operation): string {
  const tag = operation.tags?.find((value) => value.trim());
  return tag || operation.path.split("/").filter(Boolean)[0] || "Other";
}

function curlFor(finding: Finding): string {
  if (!finding.request) return "No request evidence was captured.";
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const parts = ["curl --include", `--request ${quote(finding.request.method ?? "GET")}`, `--url ${quote(finding.request.url ?? "")}`];
  const headers = { ...(finding.request.headers ?? {}) };
  const hasContentType = Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
  if (finding.request.body !== undefined && finding.request.body !== null && !hasContentType) headers["Content-Type"] = "application/json";
  for (const [name, raw] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const value = lower === "authorization" || lower.includes("api-key") || lower.includes("apikey") ? "[REDACTED]" : raw;
    parts.push(`--header ${quote(`${name}: ${value}`)}`);
  }
  if (finding.request.body !== undefined && finding.request.body !== null) parts.push(`--data ${quote(JSON.stringify(finding.request.body) ?? "null")}`);
  return parts.join(" \\\n  ");
}

function statusLabel(status: string): string {
  return status === "pass" ? "Passed" : status === "fail" ? "Failed" : "Inconclusive";
}

function App() {
  const [page, setPage] = useState<Page>("import");
  const [model, setModel] = useState<ApiModel | null>(null);
  const [specText, setSpecText] = useState("");
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem("plumbline-target") ?? "");
  const [authMode, setAuthMode] = useState<AuthMode>("bearer");
  const [token, setToken] = useState("");
  const [apiKeyHeader, setApiKeyHeader] = useState("X-API-Key");
  const [authStatus, setAuthStatus] = useState<AuthStatus>("missing");
  const [authError, setAuthError] = useState("");
  const [allowMutations, setAllowMutations] = useState(false);
  const [targetDraft, setTargetDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [authModeDraft, setAuthModeDraft] = useState<AuthMode>("bearer");
  const [headerDraft, setHeaderDraft] = useState("X-API-Key");
  const [showToken, setShowToken] = useState(false);
  const [toast, setToast] = useState("");
  const [lastRunStatus, setLastRunStatus] = useState<"good" | "bad" | "inconclusive" | "none">(() => {
    const saved = localStorage.getItem("plumbline-last-run-status");
    return saved === "good" || saved === "bad" || saved === "inconclusive" ? saved : "none";
  });
  const [runCount, setRunCount] = useState(() => Number(localStorage.getItem("plumbline-run-count") ?? 0));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("plumbline-sidebar-collapsed") === "true");
  const [endpointsCollapsed, setEndpointsCollapsed] = useState(() => localStorage.getItem("plumbline-endpoints-collapsed") === "true");
  const [selectedOperationId, setSelectedOperationId] = useState("");
  const [operationSearch, setOperationSearch] = useState("");
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [bodyValue, setBodyValue] = useState("");
  const [requestTab, setRequestTab] = useState<RequestTab>("Params");
  const [responseTab, setResponseTab] = useState<ResponseTab>("Body");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [responsePayload, setResponsePayload] = useState<ResponsePayload | null>(null);
  const [rolesText, setRolesText] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [report, setReport] = useState<RunReport | null>(null);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "fail" | "pass" | "inconclusive">("all");
  const [findingSearch, setFindingSearch] = useState("");
  const [checkFilter, setCheckFilter] = useState("all");
  const [groupBy, setGroupBy] = useState<"none" | "check" | "endpoint" | "cluster">("none");
  const [activeCluster, setActiveCluster] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState("");
  const [mcpClient, setMcpClient] = useState<"Claude Desktop" | "Cursor">("Claude Desktop");
  const [mcpConfig, setMcpConfig] = useState("");
  const [mcpError, setMcpError] = useState("");
  const [mcpBusy, setMcpBusy] = useState(false);
  const findingSearchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  const selectedOperation = model?.operations.find((operation) => operation.id === selectedOperationId) ?? null;

  const operationGroups = useMemo(() => {
    const groups = new Map<string, Operation[]>();
    const term = operationSearch.trim().toLowerCase();
    for (const operation of model?.operations ?? []) {
      const searchable = `${operation.id} ${operation.path} ${operation.method} ${operation.summary}`.toLowerCase();
      if (term && !searchable.includes(term)) continue;
      const tag = operationTag(operation);
      groups.set(tag, [...(groups.get(tag) ?? []), operation]);
    }
    return [...groups.entries()];
  }, [model, operationSearch]);

  const filteredFindings = useMemo(() => {
    if (!report) return [];
    const operations = new Map((model?.operations ?? []).map((operation) => [operation.id, operation]));
    const search = findingSearch.trim().toLowerCase();
    return report.findings.filter((finding) => {
      if (statusFilter !== "all" && finding.status !== statusFilter) return false;
      if (checkFilter !== "all" && finding.check !== checkFilter) return false;
      if (activeCluster && finding.cluster_key !== activeCluster) return false;
      const path = operations.get(finding.operation_id ?? "")?.path ?? "";
      return !search || `${finding.operation_id ?? ""} ${path}`.toLowerCase().includes(search);
    }).sort((a, b) => {
      const statusOrder = { fail: 0, inconclusive: 1, pass: 2 };
      return statusOrder[a.status] - statusOrder[b.status]
        || (a.status === "pass" ? 0 : severityOrder[a.severity] - severityOrder[b.severity])
        || (a.operation_id ?? "").localeCompare(b.operation_id ?? "");
    });
  }, [report, model, statusFilter, checkFilter, findingSearch, activeCluster]);
  const selectedFinding = filteredFindings.find((finding) => finding.id === selectedFindingId) ?? null;

  useEffect(() => {
    if (!selectedOperation) return;
    setParameterValues(Object.fromEntries(selectedOperation.parameters.map((parameter) => [parameter.name, parameterInitialValue(parameter)])));
    setBodyValue(selectedOperation.request_schema ? JSON.stringify(sampleFromSchema(selectedOperation.request_schema), null, 2) : "");
    setResponsePayload(null);
    setRequestError("");
  }, [selectedOperation]);

  useEffect(() => { localStorage.setItem("plumbline-sidebar-collapsed", String(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => { localStorage.setItem("plumbline-endpoints-collapsed", String(endpointsCollapsed)); }, [endpointsCollapsed]);
  useEffect(() => { localStorage.setItem("plumbline-run-count", String(runCount)); }, [runCount]);
  useEffect(() => { localStorage.setItem("plumbline-last-run-status", lastRunStatus); }, [lastRunStatus]);
  useEffect(() => {
    let active = true;
    void apiRequest<ApiModel>(`${API}/model`).then((loaded) => {
      if (!active) return;
      setModel(loaded);
      setSelectedOperationId(loaded.operations[0]?.id ?? "");
      setPage("explorer");
    }).catch(() => undefined);
    const savedRunId = localStorage.getItem("plumbline-last-run-id");
    if (savedRunId) {
      void Promise.all([
        apiRequest<RunReport>(`${API}/runs/${savedRunId}/report.json`),
        apiRequest<RunSummary>(`${API}/runs/${savedRunId}/summary`),
      ]).then(([savedReport, savedSummary]) => {
        if (!active) return;
        setReport(savedReport);
        setRunSummary(savedSummary);
        setStatusFilter(savedReport.findings.some((finding) => finding.status === "fail") ? "fail" : "all");
        setSelectedFindingId(savedReport.findings.find((finding) => finding.status === "fail")?.id ?? savedReport.findings[0]?.id ?? "");
      }).catch(() => {
        if (!active) return;
        localStorage.removeItem("plumbline-last-run-id");
      });
    }
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (filteredFindings.length && !filteredFindings.some((finding) => finding.id === selectedFindingId)) {
      setSelectedFindingId(filteredFindings[0].id);
    } else if (!filteredFindings.length && selectedFindingId) {
      setSelectedFindingId("");
    }
  }, [filteredFindings, selectedFindingId]);

  useEffect(() => {
    if (page !== "runs") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input,textarea,select,[contenteditable=true]");
      if (event.key === "/" && !editing) { event.preventDefault(); findingSearchRef.current?.focus(); return; }
      if (editing || !filteredFindings.length) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const index = filteredFindings.findIndex((finding) => finding.id === selectedFindingId);
        const next = Math.max(0, Math.min(filteredFindings.length - 1, index + (event.key === "j" ? 1 : -1)));
        setSelectedFindingId(filteredFindings[next].id);
        rowRefs.current[filteredFindings[next].id]?.focus();
      }
      if (event.key === "Enter" && selectedFindingId) {
        event.preventDefault();
        document.querySelector(".finding-detail")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page, filteredFindings, selectedFindingId]);

  function openSettings(type: "target" | "auth" = "target") {
    setPage("settings");
    setTargetDraft(baseUrl);
    if (type === "auth") {
      setAuthError("");
      setTokenDraft(token);
      setAuthModeDraft(authMode);
      setHeaderDraft(apiKeyHeader);
      setShowToken(false);
    }
  }

  function saveAuth() {
    if (!tokenDraft.trim()) {
      setAuthError("Enter a token or use Clear to remove the current credentials.");
      return;
    }
    if (authModeDraft === "apikey" && !headerDraft.trim()) {
      setAuthError("Enter the API key header name.");
      return;
    }
    if (tokenDraft === token && authModeDraft === authMode && headerDraft === apiKeyHeader) {
      setToast("Token unchanged");
      return;
    }
    setToken(tokenDraft);
    setAuthMode(authModeDraft);
    setApiKeyHeader(headerDraft);
    setAuthStatus(tokenDraft ? "set" : "missing");
    setMcpConfig("");
    setToast("Auth updated");
  }

  function clearAuth() {
    setToken(""); setTokenDraft(""); setAuthStatus("missing"); setAuthError(""); setMcpConfig(""); setToast("Auth cleared");
  }

  function saveTarget() {
    const target = targetDraft.trim().replace(/\/$/, "");
    setBaseUrl(target); localStorage.setItem("plumbline-target", target); setMcpConfig("");
    setToast("Target updated");
  }

  async function importSpec(text = specText) {
    if (!text.trim()) { setImportError("Choose a file or paste an OpenAPI document first."); return; }
    setImportBusy(true); setImportError("");
    try {
      const imported = await apiRequest<ApiModel>(`${API}/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: text }) });
      setModel(imported); setSelectedOperationId(imported.operations[0]?.id ?? ""); setPage("explorer"); setLastRunStatus("none"); localStorage.removeItem("plumbline-last-run-id"); setReport(null); setRunSummary(null); setToast(`Imported ${imported.operations.length} operations`);
    } catch (error) { setImportError(error instanceof Error ? error.message : "Could not import the contract."); }
    finally { setImportBusy(false); }
  }

  async function loadDemoContract() {
    setImportBusy(true); setImportError("");
    try {
      const imported = await apiRequest<ApiModel>(`${API}/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: DEMO_SPEC_URL }) });
      setModel(imported); setSelectedOperationId(imported.operations[0]?.id ?? ""); setPage("explorer"); setLastRunStatus("none"); localStorage.removeItem("plumbline-last-run-id"); setReport(null); setRunSummary(null); setToast("Demo contract loaded");
    } catch (error) { setImportError(error instanceof Error ? error.message : "Could not load the demo contract."); }
    finally { setImportBusy(false); }
  }

  async function loadFile(file?: File) {
    if (!file) return;
    setSpecText(await file.text()); setImportError("");
  }

  async function sendOperation() {
    if (!selectedOperation || !baseUrl.trim()) { setRequestError("Set a target in Settings before sending a request."); return; }
    if (selectedOperation.method !== "GET" && !allowMutations) { setRequestError("Mutations are off. Turn them on in Settings before sending this request."); return; }
    const parameters: Record<string, unknown> = {};
    try {
      for (const parameter of selectedOperation.parameters) {
        const raw = parameterValues[parameter.name] ?? "";
        if (!raw && !parameter.required) continue;
        if (!raw && parameter.required) throw new Error(`${parameter.name} is required.`);
        const type = parameter.schema?.type;
        parameters[parameter.name] = type === "integer" || type === "number" ? Number(raw) : type === "boolean" ? raw === "true" : type === "array" || type === "object" ? JSON.parse(raw) : raw;
      }
      const body = selectedOperation.request_schema ? JSON.parse(bodyValue || "null") : undefined;
      setRequestBusy(true); setRequestError(""); setResponsePayload(null);
      const start = performance.now();
      const result = await apiRequest<Omit<ResponsePayload, "elapsed_ms">>(`${API}/explorer/request`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation_id: selectedOperation.id, base_url: baseUrl, parameters, body, auth: token ? { type: authMode, token, header_name: apiKeyHeader } : null }),
      });
      const elapsed = performance.now() - start;
      setResponsePayload({ ...result, elapsed_ms: elapsed });
      if (token && result.status === 401 || token && result.status === 403) { setAuthStatus("invalid"); setToast("Credentials rejected by target"); }
      else if (token && result.status < 400) setAuthStatus("set");
    } catch (error) { setRequestError(error instanceof Error ? error.message : "The request could not be completed."); }
    finally { setRequestBusy(false); }
  }

  async function runChecks() {
    if (!model) { setRunError("Import a contract before starting a run."); return; }
    if (!baseUrl.trim()) { setRunError("Set a target in Settings before starting a run."); return; }
    let roles: unknown[] = [];
    try { roles = rolesText.trim() ? JSON.parse(rolesText) : []; if (!Array.isArray(roles)) throw new Error("Roles must be a JSON array."); }
    catch (error) { setRunError(error instanceof Error ? error.message : "Roles must be valid JSON."); return; }
    setRunError(""); setRunBusy(true); setReport(null); setRunSummary(null); setActiveCluster(null);
    try {
      const created = await apiRequest<{ run_id: string }>(`${API}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_url: baseUrl, auth: token ? { type: authMode, token, header_name: apiKeyHeader } : null, roles, allow_mutations: allowMutations }) });
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const state = await apiRequest<{ status: string }>(`${API}/runs/${created.run_id}`);
        if (state.status === "completed") {
          const [completed, summary] = await Promise.all([
            apiRequest<RunReport>(`${API}/runs/${created.run_id}/report.json`),
            apiRequest<RunSummary>(`${API}/runs/${created.run_id}/summary`),
          ]);
          setReport(completed); setRunSummary(summary); setSelectedFindingId(completed.findings.find((finding) => finding.status === "fail")?.id ?? completed.findings[0]?.id ?? "");
          setStatusFilter(completed.findings.some((finding) => finding.status === "fail") ? "fail" : "all");
          const finalStatus = completed.summary.fail > 0 ? "bad" : completed.summary.inconclusive > 0 ? "inconclusive" : "good";
          setLastRunStatus(finalStatus); localStorage.setItem("plumbline-last-run-id", completed.run_id);
          setRunCount((value) => value + 1); setToast("Run complete"); return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      throw new Error("Run has not completed yet. Check the run status and retry.");
    } catch (error) { setRunError(error instanceof Error ? error.message : "The run could not complete."); }
    finally { setRunBusy(false); }
  }

  async function generateMcpConfig() {
    if (!baseUrl.trim()) { setMcpError("Set the API target in Settings first."); return; }
    if (!model) { setMcpError("Import an OpenAPI document first."); return; }
    setMcpError(""); setMcpBusy(true);
    try {
      const query = new URLSearchParams({ spec_path: ".", base_url: baseUrl });
      const config = await apiRequest<Record<string, unknown>>(`${API}/mcp-config?${query.toString()}`);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const server = servers.plumbline;
      const originalArgs = server.args as string[];
      const replacedFlags = new Set(["--spec", "--base-url"]);
      const args = originalArgs.filter((value, index) => !replacedFlags.has(value) && !replacedFlags.has(originalArgs[index - 1]));
      const modelJson = JSON.stringify(model);
      const bytes = new TextEncoder().encode(modelJson);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const encodedModel = btoa(binary);
      for (let index = 0; index < encodedModel.length; index += 60000) {
        args.push("--model-base64", encodedModel.slice(index, index + 60000));
      }
      args.push("--base-url", baseUrl);
      if (token) args.push("--token-env", "PLUMBLINE_TOKEN");
      if (allowMutations) args.push("--allow-mutations");
      server.args = args;
      server.env = token ? { PLUMBLINE_TOKEN: "${PLUMBLINE_TOKEN}" } : {};
      setMcpConfig(JSON.stringify(config, null, 2)); setToast(`${mcpClient} config ready`);
    } catch (error) { setMcpError(error instanceof Error ? error.message : "Could not generate MCP configuration."); }
    finally { setMcpBusy(false); }
  }

  async function copyText(value: string, message: string) {
    try { await navigator.clipboard.writeText(value); setToast(message); }
    catch { setToast("Clipboard access is unavailable"); }
  }

  const pages: { id: Page; label: string; icon: typeof FileJson2; badge?: string }[] = [
    { id: "import", label: "Import", icon: FileUp },
    { id: "explorer", label: "Explorer", icon: Code2 },
    { id: "runs", label: "Runs", icon: FlaskConical, badge: String(runCount) },
    { id: "mcp", label: "MCP", icon: Braces },
    { id: "settings", label: "Settings", icon: Settings2 },
  ];

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <header className="session-bar">
        <button className="brand-button" onClick={() => setPage("import")} aria-label="Plumbline home"><span className="brand-icon"><Activity size={17} /></span><span className="brand-name">plumbline<span>.</span></span></button>
        <span className="header-divider" />
        <div className="session-context"><span className="session-caption">API</span><strong>{model?.title ?? "No API loaded"}</strong><span className="version-label">{model ? `v${model.version}` : "Import a contract"}</span></div>
        <span className={`session-chip last-run-chip run-${lastRunStatus}`}><span className="status-glyph">{lastRunStatus === "good" ? "✓" : lastRunStatus === "bad" ? "!" : lastRunStatus === "inconclusive" ? "?" : "—"}</span><span className="chip-label">Last run</span><strong>{lastRunStatus === "good" ? "Good" : lastRunStatus === "bad" ? "Needs attention" : lastRunStatus === "inconclusive" ? "Inconclusive" : "Not run"}</strong></span>
        <div className="session-right"><button className="button button-primary header-ai" onClick={() => setPage("mcp")}><Braces size={15} />Use with AI client</button></div>
      </header>

      <div className="app-body">
        <aside className={`app-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="sidebar-heading"><span>WORKSPACE</span><button className="icon-button collapse-button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
          <nav className="nav-list" aria-label="Main navigation">
            {pages.map(({ id, label, icon: Icon, badge }) => <button key={id} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => { if (id === "settings") openSettings(); else setPage(id); }} title={sidebarCollapsed ? label : undefined} aria-label={label}><Icon size={17} /><span className="nav-label">{label}</span>{badge !== undefined && !sidebarCollapsed && <span className="nav-count">{badge}</span>}</button>)}
          </nav>
          <div className="sidebar-spacer" />
          <div className="sidebar-footer"><span className="footer-mark">PL</span><span className="footer-label">API verification</span><span className="build-version">0.1.0</span></div>
        </aside>

        <main className="main-content">
          {page === "import" && <ImportPage specText={specText} setSpecText={setSpecText} error={importError} busy={importBusy} onFile={loadFile} onImport={() => void importSpec()} onDemo={() => void loadDemoContract()} />}
          {page === "explorer" && <ExplorerPage model={model} selectedOperation={selectedOperation} groups={operationGroups} search={operationSearch} setSearch={setOperationSearch} collapsed={endpointsCollapsed} setCollapsed={setEndpointsCollapsed} selectOperation={setSelectedOperationId} parameters={parameterValues} setParameters={setParameterValues} body={bodyValue} setBody={setBodyValue} requestTab={requestTab} setRequestTab={setRequestTab} responseTab={responseTab} setResponseTab={setResponseTab} response={responsePayload} requestError={requestError} requestBusy={requestBusy} send={sendOperation} mutations={allowMutations} authStatus={authStatus} openAuth={() => openSettings("auth")} openMcp={() => setPage("mcp")} copy={copyText} />}
          {page === "runs" && <RunsPage model={model} roles={rolesText} setRoles={setRolesText} runBusy={runBusy} runError={runError} run={runChecks} mutations={allowMutations} report={report} summary={runSummary} statusFilter={statusFilter} setStatusFilter={setStatusFilter} search={findingSearch} setSearch={setFindingSearch} searchRef={findingSearchRef} checkFilter={checkFilter} setCheckFilter={setCheckFilter} groupBy={groupBy} setGroupBy={setGroupBy} activeCluster={activeCluster} setActiveCluster={setActiveCluster} findings={filteredFindings} selectedId={selectedFindingId} setSelectedId={setSelectedFindingId} selectedFinding={selectedFinding} rowRefs={rowRefs} copy={copyText} />}
          {page === "mcp" && <McpPage model={model} target={baseUrl} tokenSet={!!token} mutations={allowMutations} client={mcpClient} setClient={setMcpClient} config={mcpConfig} error={mcpError} busy={mcpBusy} generate={generateMcpConfig} copy={copyText} />}
          {page === "settings" && <SettingsPage target={targetDraft} setTarget={setTargetDraft} saveTarget={saveTarget} authStatus={authStatus} authMode={authModeDraft} setAuthMode={setAuthModeDraft} header={headerDraft} setHeader={setHeaderDraft} token={tokenDraft} setToken={setTokenDraft} showToken={showToken} setShowToken={setShowToken} authError={authError} clearError={() => setAuthError("")} saveAuth={saveAuth} clearAuth={clearAuth} mutations={allowMutations} setMutations={(value) => { setAllowMutations(value); setMcpConfig(""); }} />}
        </main>
      </div>
      {toast && <div className="toast" role="status"><CheckCircle2 size={16} />{toast}</div>}
    </div>
  );
}

function ImportPage({ specText, setSpecText, error, busy, onFile, onImport, onDemo }: { specText: string; setSpecText: (value: string) => void; error: string; busy: boolean; onFile: (file?: File) => void; onImport: () => void; onDemo: () => void }) {
  return <section className="page import-page">
    <PageHeading eyebrow="CONTRACT" title="Import an API" subtitle="Load an OpenAPI contract to explore endpoints and verify observed behavior." />
    <div className="import-grid">
      <div className="surface import-surface">
        <div className="surface-heading"><div className="heading-icon"><FileJson2 size={17} /></div><div><h2>OpenAPI document</h2><p>JSON or YAML · OpenAPI 3.x</p></div><label className="button button-secondary file-button"><FileUp size={15} />Choose file<input type="file" accept=".json,.yaml,.yml,application/json,text/yaml" onChange={(event) => onFile(event.target.files?.[0])} /></label></div>
        <textarea className="spec-editor" value={specText} onChange={(event) => setSpecText(event.target.value)} spellCheck={false} placeholder={'Paste or load your OpenAPI document…\n\nopenapi: 3.0.3\ninfo:\n  title: Example API\n  version: 1.0.0\npaths: {}'} />
        <div className="editor-foot"><span><Braces size={13} />{specText ? `${specText.length.toLocaleString()} characters` : "No document loaded"}</span><span>YAML / JSON</span></div>
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        <div className="import-actions"><button className="button button-primary" onClick={onImport} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <FileCheck2 size={15} />}{busy ? "Validating" : "Validate and import"}<ArrowRight size={15} /></button><button className="button button-quiet" onClick={onDemo} disabled={busy}><Play size={14} />Load demo</button></div>
      </div>
      <aside className="import-aside"><div className="overline">AFTER IMPORT</div><div className="guide-step"><span>01</span><div><strong>Validate the spec</strong><p>Resolve references and check the OpenAPI structure.</p></div><Check size={15} /></div><div className="guide-step"><span>02</span><div><strong>Explore operations</strong><p>Choose a target separately and inspect live responses.</p></div><ArrowRight size={15} /></div><div className="guide-step"><span>03</span><div><strong>Run contract checks</strong><p>Review findings with the request and response evidence.</p></div><ArrowRight size={15} /></div><div className="notice"><CircleAlert size={16} /><span>Plumbline never infers the target URL from the OpenAPI server field.</span></div></aside>
    </div>
  </section>;
}

function SettingsPage(props: {
  target: string; setTarget: (value: string) => void; saveTarget: () => void;
  authStatus: AuthStatus; authMode: AuthMode; setAuthMode: (value: AuthMode) => void;
  header: string; setHeader: (value: string) => void; token: string; setToken: (value: string) => void;
  showToken: boolean; setShowToken: (value: boolean) => void; authError: string; clearError: () => void;
  saveAuth: () => void; clearAuth: () => void; mutations: boolean; setMutations: (value: boolean) => void;
}) {
  return <section className="page settings-page">
    <PageHeading eyebrow="WORKSPACE SETTINGS" title="Session settings" subtitle="Configure where requests go, how they authenticate, and which requests may change data." />
    <div className="settings-layout">
      <section className="surface settings-card">
        <div className="settings-card-heading"><span className="settings-icon"><Globe2 size={17} /></span><div><h2>API target</h2><p>Requests and verification runs use this base URL.</p></div></div>
        <label className="field-label" htmlFor="settings-target">BASE URL</label>
        <div className="target-editor"><input id="settings-target" value={props.target} onChange={(event) => props.setTarget(event.target.value)} placeholder="http://127.0.0.1:8002" onKeyDown={(event) => { if (event.key === "Enter") props.saveTarget(); }} /><button className="button button-primary" onClick={props.saveTarget}>Save target</button></div>
        <div className="settings-card-foot"><span className={props.target.trim() ? "configured-dot" : "missing-dot"} />{props.target.trim() ? "Target configured" : "No target configured"}</div>
      </section>

      <section className="surface settings-card">
        <div className="settings-card-heading"><span className="settings-icon"><KeyRound size={17} /></span><div><h2>Authentication</h2><p>Credentials stay in this browser session and are masked by default.</p></div><span className={`settings-status auth-${props.authStatus}`}>{props.authStatus === "set" ? "Set" : props.authStatus === "invalid" ? "Invalid" : "Missing"}</span></div>
        <label className="field-label" htmlFor="settings-auth-mode">AUTH TYPE</label>
        <select id="settings-auth-mode" value={props.authMode} onChange={(event) => { props.setAuthMode(event.target.value as AuthMode); props.clearError(); }}><option value="bearer">Bearer token</option><option value="apikey">API key</option></select>
        {props.authMode === "apikey" && <><label className="field-label" htmlFor="settings-header-name">HEADER NAME</label><input id="settings-header-name" value={props.header} onChange={(event) => { props.setHeader(event.target.value); props.clearError(); }} /></>}
        <label className="field-label" htmlFor="settings-token">TOKEN</label><div className="secret-input"><input id="settings-token" type={props.showToken ? "text" : "password"} value={props.token} onChange={(event) => { props.setToken(event.target.value); props.clearError(); }} placeholder="Paste token" autoComplete="off" /><button className="icon-button" onClick={() => props.setShowToken(!props.showToken)} aria-label={props.showToken ? "Hide token" : "Reveal token"}>{props.showToken ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
        {props.authError && <InlineMessage tone="error">{props.authError}</InlineMessage>}
        <div className="popover-actions"><button className="button button-quiet danger-text" onClick={props.clearAuth}>Clear auth</button><button className="button button-primary" onClick={props.saveAuth}>Save auth</button></div>
      </section>

      <section className="surface settings-card mutation-settings-card">
        <div className="settings-card-heading"><span className="settings-icon"><ShieldCheck size={17} /></span><div><h2>State-changing requests</h2><p>Controls POST, PUT, PATCH, and DELETE requests and checks.</p></div></div>
        <div className="mutation-setting-control"><div><strong>{props.mutations ? "Enabled" : "Off by default"}</strong><span>{props.mutations ? "Requests that can change data are allowed." : "Only read-only requests are allowed."}</span></div><button className={`session-toggle ${props.mutations ? "on" : ""}`} onClick={() => props.setMutations(!props.mutations)} aria-label={props.mutations ? "Turn mutations off" : "Turn mutations on"} aria-pressed={props.mutations}><span /></button></div>
      </section>
    </div>
  </section>;
}

function ExplorerPage(props: {
  model: ApiModel | null; selectedOperation: Operation | null; groups: [string, Operation[]][]; search: string; setSearch: (value: string) => void;
  collapsed: boolean; setCollapsed: (value: boolean) => void; selectOperation: (id: string) => void; parameters: Record<string, string>;
  setParameters: (value: (current: Record<string, string>) => Record<string, string>) => void; body: string; setBody: (value: string) => void;
  requestTab: RequestTab; setRequestTab: (value: RequestTab) => void; responseTab: ResponseTab; setResponseTab: (value: ResponseTab) => void;
  response: ResponsePayload | null; requestError: string; requestBusy: boolean; send: () => void; mutations: boolean;
  authStatus: AuthStatus; openAuth: () => void; openMcp: () => void; copy: (value: string, message: string) => void;
}) {
  const operation = props.selectedOperation;
  const requestParameters = operation?.parameters.filter((parameter) => ["path", "query"].includes(parameter.in)) ?? [];
  const headerParameters = operation?.parameters.filter((parameter) => parameter.in === "header") ?? [];
  const isMutation = !!operation && operation.method !== "GET";
  return <section className={`page explorer-page ${props.collapsed ? "endpoints-collapsed" : ""}`}>
    <PageHeading eyebrow="EXPLORER" title="API workspace" subtitle="Select an operation, configure its request, and inspect the response." action={<button className="button button-secondary" onClick={props.openMcp}><Braces size={15} />MCP ready <ChevronRight size={14} /></button>} />
    {!props.model ? <EmptyState title="Import an API contract to begin" action="Go to import" /> : <div className="explorer-layout">
      <aside className="endpoint-browser surface">
        <div className="browser-heading"><div><div className="overline">ENDPOINTS</div><strong>{props.model.title}</strong><span>v{props.model.version} · {props.model.operations.length} operations</span></div><button className="icon-button" onClick={() => props.setCollapsed(true)} aria-label="Collapse endpoint list"><PanelLeftClose size={15} /></button></div>
        <label className="search-control"><Search size={14} /><input value={props.search} onChange={(event) => props.setSearch(event.target.value)} placeholder="Find an operation" /><kbd>/</kbd></label>
        <div className="endpoint-list">{props.groups.map(([tag, operations]) => <div className="endpoint-group" key={tag}><div className="endpoint-group-title">{tag}<span>{operations.length}</span></div>{operations.map((item) => <button key={item.id} className={`endpoint-item ${operation?.id === item.id ? "selected" : ""}`} onClick={() => props.selectOperation(item.id)}><MethodBadge method={item.method} /><span className="endpoint-path">{item.path}</span></button>)}</div>)}{!props.groups.length && <div className="empty-filter">No operations match.</div>}</div>
      </aside>
      <div className="workspace-column">{props.collapsed && <button className="button button-quiet expand-endpoints" onClick={() => props.setCollapsed(false)}><PanelLeftOpen size={15} />Show endpoints</button>}
        {operation ? <>
          <div className="operation-summary surface"><div className="crumb">{operationTag(operation)}<ChevronRight size={13} />{operation.id}</div><div className="operation-title"><MethodBadge method={operation.method} /><h2>{operation.path}</h2><button className="icon-button" onClick={() => props.copy(operation.path, "Path copied")} aria-label="Copy endpoint path"><Copy size={14} /></button></div><p>{operation.summary || "No operation description."}</p><div className="operation-meta"><span><LockKeyhole size={12} />{operation.security.length ? "Auth required by spec" : "No auth declared"}</span><span>{operation.parameters.length} parameters</span><span className={`mcp-ready ${props.model ? "ready" : ""}`}><Braces size={12} />MCP tools ready</span></div></div>
          <div className="workbench-grid">
            <section className="surface request-card">
              <div className="card-title-row"><div><span className="step-number">01</span><h3>Request</h3></div><button className="button button-secondary send-button" onClick={props.send} disabled={props.requestBusy || (isMutation && !props.mutations)}>{props.requestBusy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}Send request</button></div>
              <div className="request-tabs">{(["Params", "Body", "Auth", "Headers"] as RequestTab[]).map((tab) => <button key={tab} className={props.requestTab === tab ? "active" : ""} onClick={() => props.setRequestTab(tab)}>{tab}{tab === "Params" && requestParameters.length > 0 && <span>{requestParameters.length}</span>}{tab === "Headers" && headerParameters.length > 0 && <span>{headerParameters.length}</span>}</button>)}</div>
              {props.requestTab === "Params" && <div className="tab-content parameter-grid">{requestParameters.length ? requestParameters.map((parameter) => <ParameterInput key={`${parameter.in}:${parameter.name}`} parameter={parameter} value={props.parameters[parameter.name] ?? ""} onChange={(value) => props.setParameters((current) => ({ ...current, [parameter.name]: value }))} />) : <EmptyInline>No path or query parameters for this endpoint.</EmptyInline>}</div>}
              {props.requestTab === "Body" && <div className="tab-content">{operation.request_schema ? <><div className="body-hint">application/json {operation.request_required ? "· required" : "· optional"}</div><textarea className="body-editor" value={props.body} onChange={(event) => props.setBody(event.target.value)} spellCheck={false} /></> : <EmptyInline>This operation does not define a request body.</EmptyInline>}</div>}
              {props.requestTab === "Auth" && <div className="tab-content auth-info"><div className={`auth-state auth-${props.authStatus}`}><KeyRound size={16} /><div><strong>Session auth: {props.authStatus}</strong><span>Credential is managed in Settings.</span></div><button className="button button-secondary" onClick={props.openAuth}>Open settings</button></div><p>OpenAPI security: {operation.security.length ? operation.security.join(", ") : "No security requirement for this operation"}</p></div>}
              {props.requestTab === "Headers" && <div className="tab-content parameter-grid">{headerParameters.length ? headerParameters.map((parameter) => <ParameterInput key={`${parameter.in}:${parameter.name}`} parameter={parameter} value={props.parameters[parameter.name] ?? ""} onChange={(value) => props.setParameters((current) => ({ ...current, [parameter.name]: value }))} />) : <EmptyInline>No operation-specific headers.</EmptyInline>}</div>}
              {isMutation && !props.mutations && <InlineMessage tone="warning">Mutations are off. Turn them on in Settings to send this request.</InlineMessage>}
              {props.requestError && <InlineMessage tone="error">{props.requestError}</InlineMessage>}
              <div className="request-foot"><ShieldCheck size={13} />Requests go through the local Plumbline backend.</div>
            </section>
            <section className="surface response-card"><div className="card-title-row"><div><span className="step-number">02</span><h3>Response</h3></div>{props.response && <StatusBadge status={props.response.status < 400 ? "pass" : "fail"} label={`HTTP ${props.response.status}`} />}</div>
              <div className="request-tabs response-tabs">{(["Body", "Headers", "Timing"] as ResponseTab[]).map((tab) => <button key={tab} className={props.responseTab === tab ? "active" : ""} onClick={() => props.setResponseTab(tab)}>{tab}</button>)}</div>
              {props.response ? <>
                {props.responseTab === "Body" && <><div className="response-url"><code>{props.response.url}</code><button className="icon-button" onClick={() => props.copy(pretty(props.response?.body), "Response copied")} aria-label="Copy response body"><Copy size={14} /></button></div><pre className="response-body">{pretty(props.response.body)}</pre></>}
                {props.responseTab === "Headers" && <pre className="response-body">{pretty(props.response.headers)}</pre>}
                {props.responseTab === "Timing" && <div className="timing-view"><div><span>Round trip</span><strong>{props.response.elapsed_ms.toFixed(0)} ms</strong></div><div className="timing-track"><span style={{ width: `${Math.min(100, Math.max(4, props.response.elapsed_ms / 10))}%` }} /></div><p>Measured by the Plumbline UI around the live request.</p></div>}
              </> : <div className="response-empty"><div className="response-empty-icon"><Terminal size={20} /></div><strong>No response yet</strong><p>Send a request to inspect its status, body, headers, and timing.</p></div>}
            </section>
          </div>
        </> : <EmptyState title="Choose an endpoint" action="Select an operation from the list" />}
      </div>
    </div>}
  </section>;
}

function RunsPage(props: {
  model: ApiModel | null; roles: string; setRoles: (value: string) => void; runBusy: boolean; runError: string; run: () => void;
  mutations: boolean; report: RunReport | null; summary: RunSummary | null; statusFilter: "all" | "fail" | "pass" | "inconclusive";
  setStatusFilter: (value: "all" | "fail" | "pass" | "inconclusive") => void; search: string; setSearch: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>; checkFilter: string; setCheckFilter: (value: string) => void;
  groupBy: "none" | "check" | "endpoint" | "cluster"; setGroupBy: (value: "none" | "check" | "endpoint" | "cluster") => void;
  activeCluster: string | null; setActiveCluster: (value: string | null) => void; findings: Finding[]; selectedId: string;
  setSelectedId: (value: string) => void; selectedFinding: Finding | null; rowRefs: React.MutableRefObject<Record<string, HTMLTableRowElement | null>>;
  copy: (value: string, message: string) => void;
}) {
  const model = props.model;
  const operations = useMemo(() => new Map((model?.operations ?? []).map((operation) => [operation.id, operation])), [model]);
  const checks = [...new Set((props.report?.findings ?? []).map((finding) => finding.check))].sort();
  const groups = useMemo(() => {
    if (props.groupBy === "none") return [{ key: "", label: "", findings: props.findings }];
    const grouped = new Map<string, Finding[]>();
    for (const finding of props.findings) {
      const key = props.groupBy === "check" ? finding.check : props.groupBy === "cluster" ? finding.cluster_key : operations.get(finding.operation_id ?? "")?.path ?? "API";
      grouped.set(key, [...(grouped.get(key) ?? []), finding]);
    }
    const clusterTitles = new Map((props.summary?.clusters ?? []).map((cluster) => [cluster.cluster_key, cluster.title]));
    return [...grouped.entries()].map(([key, findings]) => ({
      key,
      label: props.groupBy === "cluster" ? clusterTitles.get(key) ?? key : key,
      findings,
    }));
  }, [props.findings, props.groupBy, operations, props.summary]);
  const counts = props.summary?.counts ?? props.report?.summary ?? {};
  return <section className="page runs-page">
    <PageHeading eyebrow="RUNS" title="Run analysis" subtitle="Understand the outcome first, then drill into the evidence that explains it." action={model && <button className="button button-primary" onClick={props.run} disabled={props.runBusy}>{props.runBusy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{props.runBusy ? "Running checks" : "Run checks"}</button>} />
    {!model ? <EmptyState title="Import an API before running checks" action="Go to import" /> : <>
      <div className="run-config surface"><div className="run-config-copy"><div className="heading-icon"><Settings2 size={16} /></div><div><strong>Run configuration</strong><span>Target, auth, and mutation mode are managed in Settings.</span></div><span className={`mutation-inline ${props.mutations ? "on" : "off"}`}>Mutations {props.mutations ? "On" : "Off"}</span></div><div className="run-options"><label className="field-label" htmlFor="role-config">ROLE CONFIGURATION <span>OPTIONAL JSON ARRAY</span></label><textarea id="role-config" className="roles-editor" value={props.roles} onChange={(event) => props.setRoles(event.target.value)} placeholder={'[{"name":"viewer","token":"...","allowed_operation_ids":["list_items"]}]'} /></div>{props.runError && <InlineMessage tone="error">{props.runError}</InlineMessage>}<div className="run-config-actions"><span className="muted"><ShieldCheck size={13} />Mutation safety is controlled in Settings.</span><button className="button button-primary" onClick={props.run} disabled={props.runBusy}>{props.runBusy ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{props.runBusy ? "Running checks" : "Run checks"}<ArrowRight size={14} /></button></div></div>
      {props.report && props.summary && <>
        <section className="run-overview">
          <div className="verdict-row"><div><div className="overline">LATEST RUN · {props.report.run_id.slice(0, 10)}</div><h2>{props.summary.verdict}</h2></div><a className="button button-secondary" href={`${API}/runs/${props.report.run_id}/report.html`} target="_blank" rel="noreferrer"><ArrowDownToLine size={14} />HTML report</a></div>
          <div className="overview-grid">
            <div className="surface overview-card result-card"><div className="card-label">RESULTS</div><div className="result-numbers"><span className="fail-text">{counts.fail ?? 0} failed</span><span className="warn-text">{counts.inconclusive ?? 0} inconclusive</span><span className="pass-text">{counts.pass ?? 0} passed</span></div><StackedResultBar counts={counts} /></div>
            <div className="surface overview-card"><div className="card-label">SEVERITY × STATUS</div><SeverityMatrix matrix={props.summary.severity_status} /></div>
            <div className="surface overview-card"><div className="card-label">FAILURES BY CHECK</div><CheckBars items={props.summary.failures_by_check} /></div>
          </div>
          <div className="surface attention-card"><div className="section-heading"><div><div className="overline">PRIORITIZED TRIAGE</div><h3>Needs attention</h3></div><span className="attention-count">{props.summary.clusters.length} clusters</span></div>{props.summary.clusters.length ? <div className="cluster-grid">{props.summary.clusters.map((cluster) => <button key={cluster.cluster_key} className={`cluster-card ${props.activeCluster === cluster.cluster_key ? "selected" : ""}`} onClick={() => { props.setActiveCluster(props.activeCluster === cluster.cluster_key ? null : cluster.cluster_key); props.setStatusFilter("fail"); }}><div className="cluster-top"><SeverityBadge severity={cluster.severity} /><span className="cluster-count">{cluster.count} findings</span></div><strong>{cluster.check}</strong><p>{cluster.observed || cluster.expected}</p><div className="cluster-endpoints">{cluster.sample_endpoints.map((endpoint) => <code key={`${cluster.cluster_key}:${endpoint.operation_id}`}>{endpoint.method} {endpoint.path}</code>)}</div></button>)}</div> : <div className="empty-inline">No failed clusters in this run.</div>}</div>
        </section>
        <section className="triage-section surface">
          <div className="triage-heading"><div><div className="overline">FINDINGS</div><h2>Review and filter</h2></div><div className="keyboard-hint"><kbd>j</kbd><kbd>k</kbd> move <kbd>Enter</kbd> inspect <kbd>/</kbd> search</div></div>
          <div className="triage-filters"><div className="segmented">{(["all", "fail", "inconclusive", "pass"] as const).map((status) => <button key={status} className={props.statusFilter === status ? "active" : ""} onClick={() => { props.setStatusFilter(status); props.setActiveCluster(null); }}>{status === "all" ? "All" : statusLabel(status)}<span>{status === "all" ? props.report?.findings.length ?? 0 : counts[status] ?? 0}</span></button>)}</div><label className="search-control finding-search"><Search size={14} /><input ref={props.searchRef} value={props.search} onChange={(event) => props.setSearch(event.target.value)} placeholder="Search operation id or path" /><kbd>/</kbd></label><select value={props.checkFilter} onChange={(event) => props.setCheckFilter(event.target.value)} aria-label="Filter by check"><option value="all">All checks</option>{checks.map((check) => <option key={check}>{check}</option>)}</select><select value={props.groupBy} onChange={(event) => props.setGroupBy(event.target.value as typeof props.groupBy)} aria-label="Group findings"><option value="none">No grouping</option><option value="check">Group by check</option><option value="endpoint">Group by endpoint</option><option value="cluster">Group by cluster</option></select>{props.activeCluster && <button className="button button-quiet clear-cluster" onClick={() => props.setActiveCluster(null)}><X size={13} />Clear cluster</button>}</div>
          <div className="findings-layout"><div className="findings-table-wrap"><table className="findings-table"><thead><tr><th>STATUS</th><th>SEVERITY</th><th>OPERATION</th><th>CHECK</th><th>VARIANT</th></tr></thead><tbody>{groups.flatMap((group) => [
            ...(props.groupBy !== "none" ? [<tr className="group-row" key={`group:${group.key}`}><td colSpan={5}>{group.label} <span>{group.findings.length}</span></td></tr>] : []),
            ...group.findings.map((finding) => <tr key={finding.id} tabIndex={0} ref={(node) => { props.rowRefs.current[finding.id] = node; }} className={`finding-row ${props.selectedId === finding.id ? "selected" : ""}`} onClick={() => props.setSelectedId(finding.id)} onKeyDown={(event) => { if (event.key === "Enter") props.setSelectedId(finding.id); }}><td><StatusBadge status={finding.status} label={statusLabel(finding.status)} /></td><td>{finding.status === "pass" ? null : <SeverityBadge severity={finding.severity} />}</td><td><code>{finding.operation_id ?? "API"}</code><span className="row-path">{operations.get(finding.operation_id ?? "")?.path}</span></td><td>{finding.check}</td><td>{finding.variant ?? ""}</td></tr>),
          ])}{!props.findings.length && <tr><td colSpan={5} className="empty-cell">No findings match these filters.</td></tr>}</tbody></table></div>
            <aside className="finding-detail" aria-label="Finding detail">{props.selectedFinding ? <FindingDetail finding={props.selectedFinding} operation={operations.get(props.selectedFinding.operation_id ?? "")} copy={props.copy} /> : <div className="detail-empty"><Search size={18} /><span>Select a finding to inspect evidence.</span></div>}</aside>
          </div>
        </section>
      </>}
    </>}
  </section>;
}

function McpPage({ model, target, tokenSet, mutations, client, setClient, config, error, busy, generate, copy }: {
  model: ApiModel | null; target: string; tokenSet: boolean; mutations: boolean;
  client: "Claude Desktop" | "Cursor"; setClient: (value: "Claude Desktop" | "Cursor") => void; config: string;
  error: string; busy: boolean; generate: () => void; copy: (value: string, message: string) => void;
}) {
  const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const mutationToolCount = model?.operations.filter((operation) => mutationMethods.has(operation.method.toUpperCase())).length ?? 0;
  const readOnly = (model?.operations.length ?? 0) - mutationToolCount;
  return <section className="page mcp-page"><PageHeading eyebrow="MCP" title="Use this API with an AI client" subtitle="Expose the imported contract as MCP tools for local coding assistants." />
    <div className="surface mcp-intro"><div className="heading-icon"><Braces size={17} /></div><div><strong>What MCP does here</strong><p>Plumbline turns each OpenAPI operation into a tool an MCP client can discover and call against your selected target.</p></div><div className="mcp-target"><span>SESSION TARGET</span><code>{target || "Not set"}</code></div></div>
    {!model ? <EmptyState title="Import an API to generate MCP tools" action="Go to import" /> : <div className="mcp-layout"><div className="surface mcp-config-card"><div className="section-heading"><div><div className="overline">CLIENT CONFIGURATION</div><h2>Connect a client</h2></div><span className="ready-indicator"><span />API loaded</span></div><div className="client-tabs">{(["Claude Desktop", "Cursor"] as const).map((item) => <button key={item} className={client === item ? "active" : ""} onClick={() => setClient(item)}>{item}</button>)}</div><div className="path-note">The configuration embeds the currently imported API model and your session target.</div><div className="mcp-tool-counts"><div><span>READ ONLY</span><strong>{readOnly}</strong><small>GET tools</small></div><div><span>STATE CHANGING</span><strong>{mutationToolCount}</strong><small>POST / PUT / PATCH / DELETE</small></div></div><div className="mcp-token-note"><KeyRound size={15} /><span>{tokenSet ? "The config references PLUMBLINE_TOKEN from the client environment. The token itself is never included." : "No session token set. The MCP server will connect without configured auth."}</span></div>{error && <InlineMessage tone="error">{error}</InlineMessage>}<div className="mcp-actions"><button className="button button-primary" onClick={generate} disabled={busy}>{busy ? <LoaderCircle size={14} className="spin" /> : <Braces size={14} />}Generate {client} config</button><button className="button button-secondary" disabled title="Requires local MCP process support."><Activity size={14} />Test connection</button></div></div>
      <div className="surface generated-config"><div className="section-heading"><div><div className="overline">GENERATED CONFIG</div><h2>{config ? "Ready to paste" : "Configuration preview"}</h2></div>{config && <button className="icon-button" onClick={() => copy(config, "Config copied")} aria-label="Copy MCP configuration"><Copy size={15} /></button>}</div>{config ? <pre>{config}</pre> : <div className="config-placeholder"><Braces size={24} /><strong>Config appears here</strong><span>Choose a client and generate its MCP server configuration.</span></div>}<div className={`readonly-note ${mutations ? "mutations-enabled" : ""}`}><ShieldCheck size={14} />{mutations ? "State-changing tools are enabled in this config." : "State-changing tools are blocked by default by the MCP server."}</div></div></div>}
  </section>;
}

function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><div className="overline">PLUMBLINE / {eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}

function InlineMessage({ children, tone }: { children: React.ReactNode; tone: "error" | "warning" }) {
  return <div className={`inline-message ${tone}`}>{tone === "error" ? <CircleAlert size={14} /> : <AlertTriangle size={14} />}<span>{children}</span></div>;
}

function EmptyInline({ children }: { children: React.ReactNode }) { return <div className="empty-inline">{children}</div>; }

function EmptyState({ title, action }: { title: string; action: string }) { return <div className="empty-state surface"><div className="empty-state-icon"><FileJson2 size={21} /></div><h2>{title}</h2><p>The imported API model is shared by the explorer, MCP server, and test runner.</p><span className="empty-action">{action}<ArrowRight size={14} /></span></div>; }

function MethodBadge({ method }: { method: string }) { return <span className={`method-badge method-${method.toLowerCase()}`}>{method}</span>; }

function ParameterInput({ parameter, value, onChange }: { parameter: Parameter; value: string; onChange: (value: string) => void }) {
  const schema = parameter.schema ?? {}; const type = String(schema.type ?? "string"); const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  return <div className="parameter-field"><label className="field-label">{parameter.name}<span className="param-location">{parameter.in}</span>{parameter.required && <i>*</i>}</label>{enumValues.length ? <select value={value} onChange={(event) => onChange(event.target.value)}>{enumValues.map((entry) => <option key={String(entry)} value={String(entry)}>{String(entry)}</option>)}</select> : type === "boolean" ? <select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select value</option><option value="true">true</option><option value="false">false</option></select> : <input type={type === "integer" || type === "number" ? "number" : "text"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={parameter.in === "path" ? `{${parameter.name}}` : parameter.description || `Enter ${parameter.name}`} />}{parameter.description && <small>{parameter.description}</small>}</div>;
}

function StatusBadge({ status, label }: { status: "pass" | "fail" | "inconclusive"; label: string }) { return <span className={`status-badge status-${status}`}><span aria-hidden="true">{status === "pass" ? "✓" : status === "fail" ? "!" : "?"}</span>{label}</span>; }
function SeverityBadge({ severity }: { severity: string }) { return <span className={`severity-badge severity-${severity}`}>{severity}</span>; }

function StackedResultBar({ counts }: { counts: Record<string, number> }) {
  const total = (counts.pass ?? 0) + (counts.fail ?? 0) + (counts.inconclusive ?? 0);
  return <div className="stacked-result" role="img" aria-label={`Pass ${counts.pass ?? 0}, fail ${counts.fail ?? 0}, inconclusive ${counts.inconclusive ?? 0}`}>{total > 0 && <><span className="pass-segment" style={{ width: `${(counts.pass ?? 0) * 100 / total}%` }} /><span className="fail-segment" style={{ width: `${(counts.fail ?? 0) * 100 / total}%` }} /><span className="inconclusive-segment" style={{ width: `${(counts.inconclusive ?? 0) * 100 / total}%` }} /></>}</div>;
}

function SeverityMatrix({ matrix }: { matrix: Record<string, Record<string, number>> }) {
  return <table className="severity-matrix"><thead><tr><th></th><th>Fail</th><th>Inconcl.</th><th>Pass</th></tr></thead><tbody>{["high", "medium", "low", "info"].map((severity) => <tr key={severity}><th>{severity}</th><td className={(matrix[severity]?.fail ?? 0) ? "fail-text" : ""}>{matrix[severity]?.fail ?? 0}</td><td className={(matrix[severity]?.inconclusive ?? 0) ? "warn-text" : ""}>{matrix[severity]?.inconclusive ?? 0}</td><td className={(matrix[severity]?.pass ?? 0) ? "pass-text" : ""}>{matrix[severity]?.pass ?? 0}</td></tr>)}</tbody></table>;
}

function CheckBars({ items }: { items: { check: string; count: number }[] }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return <div className="check-bars">{items.length ? items.map((item) => <div className="check-bar-row" key={item.check}><span>{item.check}</span><div><i style={{ width: `${item.count * 100 / max}%` }} /></div><strong>{item.count}</strong></div>) : <div className="empty-inline">No failed checks.</div>}
  </div>;
}

function FindingDetail({ finding, operation, copy }: { finding: Finding; operation?: Operation; copy: (value: string, message: string) => void }) {
  return <><div className="detail-top"><div><StatusBadge status={finding.status} label={statusLabel(finding.status)} />{finding.status !== "pass" && <SeverityBadge severity={finding.severity} />}</div><button className="icon-button" onClick={() => copy(pretty(finding), "Finding copied")} aria-label="Copy finding"><Copy size={14} /></button></div><h3>{finding.check}<span> / {finding.operation_id ?? "API"}</span></h3><div className="detail-endpoint"><MethodBadge method={operation?.method ?? "API"} /><code>{operation?.path ?? finding.operation_id ?? "API"}</code>{finding.variant && <span className="variant-label">Variant: {finding.variant}</span>}</div><div className="expect-observe"><section><span>EXPECTED</span><p>{finding.expected || "No expectation recorded."}</p></section><section><span>OBSERVED</span><p>{finding.observed || "No observation recorded."}</p></section></div><EvidencePanel title="REQUEST EVIDENCE" evidence={finding.request} /><EvidencePanel title="RESPONSE EVIDENCE" evidence={finding.response} /><div className="curl-panel"><div><span className="overline">REPRODUCE</span><button className="button button-quiet" onClick={() => copy(curlFor(finding), "Curl command copied")}><Clipboard size={13} />Copy curl</button></div><pre>{curlFor(finding)}</pre></div></>;
}

function EvidencePanel({ title, evidence }: { title: string; evidence?: Evidence | null }) {
  return <details className="evidence-panel"><summary>{title}<ChevronDown size={13} /></summary>{evidence ? <pre>{pretty(evidence)}</pre> : <div className="empty-inline">No evidence was captured.</div>}</details>;
}

export default App;

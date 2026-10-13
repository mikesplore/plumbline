import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowRight, Braces, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleAlert, Clipboard, Code2, Copy,
  Eye, EyeOff, FileCheck2, FileJson2, FileUp, FlaskConical, Globe2, KeyRound,
  LoaderCircle, PanelLeftClose, PanelLeftOpen,
  Play, Search, Send, Settings2, ShieldCheck, Terminal, X,
} from "lucide-react";

type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: Record<string, unknown> };
type Operation = {
  id: string; method: string; path: string; summary: string; tags?: string[];
  parameters: Parameter[]; request_schema?: Record<string, unknown> | null;
  request_required?: boolean; security: string[];
};
type ApiModel = { title: string; version: string; operations: Operation[]; schemas?: Record<string, Record<string, unknown>>; security_schemes?: Record<string, Record<string, string>> };
type Evidence = { method?: string; url?: string; headers?: Record<string, string>; body?: unknown; status?: number | null; body_snippet?: string; elapsed_ms?: number | null };
type Finding = {
  id: string; check: string; severity: "info" | "low" | "medium" | "high";
  status: "pass" | "fail" | "inconclusive"; operation_id?: string | null;
  expected: string; observed: string; cluster_key: string; variant?: string | null;
  request?: Evidence | null; response?: Evidence | null;
};
type RunReport = { run_id: string; base_url: string; started_at: string; config?: Record<string, unknown>; findings: Finding[]; summary: Record<string, number> };
type RunSummary = {
  run_id: string; verdict: string; operation_count: number; counts: Record<string, number>;
  missing_fixture_inconclusive?: number;
  severity_status: Record<string, Record<string, number>>;
  failures_by_check: { check: string; count: number }[];
  clusters: { cluster_key: string; title: string; check: string; expected: string; observed: string; count: number; severity: string; sample_endpoints: { operation_id: string | null; method: string | null; path: string }[]; finding_ids: string[] }[];
};
type AuthMode = "bearer" | "apikey";
type Page = "import" | "explorer" | "runs" | "mcp" | "settings";
type StoredContractSource = { kind: "spec" | "url"; value: string };
type SavedContract = { id: string; name: string; source: StoredContractSource };
type RunPreset = { id: string; name: string; scopeMode: "all" | "groups"; groups: string[]; fixtures: string; roles: string; discoverFixtures: boolean };
type RecentRun = { run_id: string; status: string; started_at: string; base_url: string; summary: Record<string, number> };
type McpTestResult = { connected: boolean; tool_count: number; read_only_count: number; mutation_count: number; tools: { name: string; description: string }[] };

function storedContractSource(): StoredContractSource | null {
  try {
    const value = localStorage.getItem("plumbline-contract-source");
    if (!value) return null;
    const parsed = JSON.parse(value) as StoredContractSource;
    return (parsed.kind === "spec" || parsed.kind === "url") && parsed.value ? parsed : null;
  } catch { return null; }
}

function storedJson<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
}
type AuthStatus = "missing" | "set" | "invalid";
type ResponsePayload = { status: number; url: string; headers: Record<string, string>; body: unknown; elapsed_ms: number };
type RequestTab = "Params" | "Body" | "Auth" | "Headers";
type ResponseTab = "Body" | "Headers" | "Timing";

const API = "/api";
const DEMO_SPEC_URL = import.meta.env.VITE_DEMO_SPEC_URL ?? "http://127.0.0.1:8001/openapi.json";
const pageTitles: Record<Page, string> = {
  import: "Import an API",
  explorer: "API workspace",
  runs: "Run analysis",
  mcp: "Use this API with an AI client",
  settings: "Session settings",
};
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

type RequestDraft = { url: string; parameters: Record<string, unknown>; body?: unknown; error?: string };

function parameterValue(parameter: Parameter, raw: string): unknown {
  const type = parameter.schema?.type;
  if (type === "integer" || type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) throw new Error(`${parameter.name} must be a valid ${type}.`);
    return value;
  }
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error(`${parameter.name} must be true or false.`);
    return raw === "true";
  }
  if (type === "array" || type === "object") {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error(`${parameter.name} must be valid JSON.`); }
    if (type === "array" && !Array.isArray(value)) throw new Error(`${parameter.name} must be a JSON array.`);
    if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`${parameter.name} must be a JSON object.`);
    return value;
  }
  const allowed = parameter.schema?.enum;
  if (Array.isArray(allowed) && !allowed.some((item) => String(item) === raw)) throw new Error(`${parameter.name} must match one of its allowed values.`);
  return raw;
}

function validateBody(value: unknown, schema: Record<string, unknown>, label = "body"): string | undefined {
  if (value === null && schema.nullable === true) return undefined;
  const type = schema.type;
  const valid = type === "object" ? !!value && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value)
      : type === "integer" ? Number.isInteger(value)
        : type === "number" ? typeof value === "number" && Number.isFinite(value)
          : type === "boolean" ? typeof value === "boolean"
            : type === "string" ? typeof value === "string"
              : true;
  if (!valid) return `${label} must be ${type}.`;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return `${label} must match one of its allowed values.`;
  if (type === "object" && value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const required of (schema.required as string[] | undefined) ?? []) {
      if (!(required in object)) return `${label}.${required} is required.`;
    }
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    for (const [key, propertySchema] of Object.entries(properties ?? {})) {
      if (key in object) {
        const error = validateBody(object[key], propertySchema, `${label}.${key}`);
        if (error) return error;
      }
    }
  }
  if (type === "array" && Array.isArray(value) && schema.items && typeof schema.items === "object") {
    for (const [index, item] of value.entries()) {
      const error = validateBody(item, schema.items as Record<string, unknown>, `${label}[${index}]`);
      if (error) return error;
    }
  }
  return undefined;
}

function buildRequestDraft(operation: Operation | null, baseUrl: string, values: Record<string, string>, bodyText: string): RequestDraft {
  if (!operation) return { url: "", parameters: {}, error: "Choose an operation first." };
  if (!baseUrl.trim()) return { url: "", parameters: {}, error: "Set a target in Settings before sending a request." };
  const parameters: Record<string, unknown> = {};
  let path = operation.path;
  const query = new URLSearchParams();
  try {
    for (const parameter of operation.parameters) {
      const raw = values[parameter.name] ?? "";
      if (!raw && !parameter.required) continue;
      if (!raw && parameter.required) throw new Error(`${parameter.name} is required.`);
      const value = parameterValue(parameter, raw);
      parameters[parameter.name] = value;
      if (parameter.in === "path") path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(String(value)));
      if (parameter.in === "query") {
        if (Array.isArray(value)) value.forEach((item) => query.append(parameter.name, String(item)));
        else query.append(parameter.name, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
    if (/[{}]/.test(path)) throw new Error("A required path parameter is missing.");
    let body: unknown;
    if (operation.request_schema && bodyText.trim()) {
      try { body = JSON.parse(bodyText); } catch { throw new Error("Request body must be valid JSON."); }
      const bodyError = validateBody(body, operation.request_schema);
      if (bodyError) throw new Error(bodyError);
    } else if (operation.request_required) {
      throw new Error("A request body is required.");
    }
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
    query.forEach((value, name) => url.searchParams.append(name, value));
    return { url: url.toString(), parameters, body };
  } catch (error) {
    return { url: "", parameters: {}, error: error instanceof Error ? error.message : "Request is invalid." };
  }
}

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

function operationTag(operation: Operation): string {
  const tag = operation.tags?.find((value) => value.trim() && !/^(api|default|v\d+)$/i.test(value.trim()));
  if (tag) return tag;
  const segments = operation.path.split("/").filter(Boolean);
  return segments.find((segment) => segment.toLowerCase() !== "api" && segment.toLowerCase() !== "admin" && !/^v\d+$/i.test(segment)) ?? "Other";
}

function schemaRelations(schema: Record<string, unknown>): string[] {
  const properties = schema.properties && typeof schema.properties === "object"
    ? Object.entries(schema.properties as Record<string, Record<string, unknown>>)
    : [];
  return properties.flatMap(([property, definition]) => {
    const item = definition.items && typeof definition.items === "object" ? definition.items as Record<string, unknown> : {};
    const references = [definition.$ref, item.$ref].filter((value): value is string => typeof value === "string");
    return references.map((reference) => `${property} → ${decodeURIComponent(reference.split("/").at(-1) ?? reference)}`);
  });
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
  const [specText, setSpecText] = useState(() => {
    const source = storedContractSource();
    return source?.kind === "spec" ? source.value : "";
  });
  const [savedContracts, setSavedContracts] = useState<SavedContract[]>(() => storedJson("plumbline-saved-contracts", []));
  const [activeContractId, setActiveContractId] = useState(() => localStorage.getItem("plumbline-active-contract-id") ?? "");
  const [contractNameDraft, setContractNameDraft] = useState("");
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
  const [fixturesText, setFixturesText] = useState("");
  const [discoverFixtures, setDiscoverFixtures] = useState(false);
  const [fixturesOpen, setFixturesOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [runScopeMode, setRunScopeMode] = useState<"all" | "groups">("all");
  const [selectedRunGroups, setSelectedRunGroups] = useState<string[]>([]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [reportModel, setReportModel] = useState<ApiModel | null>(null);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "fail" | "pass" | "inconclusive">("all");
  const [findingSearch, setFindingSearch] = useState("");
  const [checkFilter, setCheckFilter] = useState("all");
  const [groupBy, setGroupBy] = useState<"none" | "check" | "endpoint" | "cluster">("none");
  const [activeCluster, setActiveCluster] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState("");
  const [mcpConfig, setMcpConfig] = useState("");
  const [mcpError, setMcpError] = useState("");
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpTestBusy, setMcpTestBusy] = useState(false);
  const [mcpTestError, setMcpTestError] = useState("");
  const [mcpTestResult, setMcpTestResult] = useState<McpTestResult | null>(null);
  const [targetCheckBusy, setTargetCheckBusy] = useState(false);
  const [targetCheckResult, setTargetCheckResult] = useState<{ reachable: boolean; status_code: number | null; elapsed_ms: number; message: string } | null>(null);
  const [runPresets, setRunPresets] = useState<RunPreset[]>(() => storedJson("plumbline-run-presets", []));
  const [runPresetId, setRunPresetId] = useState("");
  const [runPresetName, setRunPresetName] = useState("");
  const [runHistory, setRunHistory] = useState<RecentRun[]>([]);
  const [previousRunId, setPreviousRunId] = useState("");
  const [previousReport, setPreviousReport] = useState<RunReport | null>(null);
  const findingSearchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});

  const selectedOperation = model?.operations.find((operation) => operation.id === selectedOperationId) ?? null;

  useEffect(() => {
    if (!selectedOperation) return;
    const hasParameters = selectedOperation.parameters.some((parameter) => ["path", "query"].includes(parameter.in));
    setRequestTab(hasParameters ? "Params" : selectedOperation.request_schema ? "Body" : "Params");
    setRequestError("");
    setResponsePayload(null);
  }, [selectedOperationId, model]);

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
  useEffect(() => { try { localStorage.setItem("plumbline-saved-contracts", JSON.stringify(savedContracts)); } catch { setToast("Saved API list could not be written to browser storage"); } }, [savedContracts]);
  useEffect(() => { try { localStorage.setItem("plumbline-run-presets", JSON.stringify(runPresets)); } catch { setToast("Run configurations could not be written to browser storage"); } }, [runPresets]);
  useEffect(() => {
    let active = true;
    const source = storedContractSource();
    const restore = source
      ? apiRequest<ApiModel>(`${API}/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(source.kind === "url" ? { url: source.value } : { spec: source.value }) })
      : apiRequest<ApiModel>(`${API}/model`);
    void restore.then((loaded) => {
      if (!active) return;
      setModel(loaded);
      setSelectedOperationId(loaded.operations[0]?.id ?? "");
      if (!new URLSearchParams(window.location.search).has("run")) setPage("explorer");
      if (source) rememberContract(source, loaded, localStorage.getItem("plumbline-active-contract-id") || undefined);
      else void apiRequest<{ spec: string }>(`${API}/model/source`).then(({ spec }) => { if (active) rememberContract({ kind: "spec", value: spec }, loaded); }).catch(() => undefined);
    }).catch((error) => {
      if (!active || !source) return;
      setImportError(`Could not restore the saved API contract: ${error instanceof Error ? error.message : "backend unavailable"}`);
    });
    void apiRequest<RecentRun[]>(`${API}/runs`).then((history) => {
      if (!active) return;
      setRunHistory(history);
      const currentId = new URLSearchParams(window.location.search).get("run") ?? localStorage.getItem("plumbline-last-run-id");
      setPreviousRunId(history.find((run) => run.status === "completed" && run.run_id !== currentId)?.run_id ?? "");
    }).catch(() => undefined);
    const params = new URLSearchParams(window.location.search);
    const savedRunId = params.get("run") ?? localStorage.getItem("plumbline-last-run-id");
    if (savedRunId) {
      void Promise.all([
        apiRequest<RunReport>(`${API}/runs/${savedRunId}/report.json`),
        apiRequest<RunSummary>(`${API}/runs/${savedRunId}/summary`),
      ]).then(([savedReport, savedSummary]) => {
        if (!active) return;
        setReport(savedReport);
        setRunSummary(savedSummary);
        void apiRequest<ApiModel>(`${API}/runs/${savedRunId}/model`).then((savedModel) => { if (active) setReportModel(savedModel); }).catch(() => { if (active) setReportModel(null); });
        const sharedStatus = params.get("status");
        setStatusFilter(sharedStatus === "all" || sharedStatus === "fail" || sharedStatus === "pass" || sharedStatus === "inconclusive" ? sharedStatus : savedReport.findings.some((finding) => finding.status === "fail") ? "fail" : "all");
        setCheckFilter(params.get("check") ?? "all");
        setFindingSearch(params.get("q") ?? "");
        setSelectedFindingId(savedReport.findings.find((finding) => finding.status === "fail")?.id ?? savedReport.findings[0]?.id ?? "");
        setActiveCluster(params.get("cluster"));
        if (params.get("run")) setPage("runs");
      }).catch(() => {
        if (!active) return;
        localStorage.removeItem("plumbline-last-run-id");
      });
    }
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!previousRunId || previousRunId === report?.run_id) { setPreviousReport(null); return; }
    let active = true;
    void apiRequest<RunReport>(`${API}/runs/${previousRunId}/report.json`).then((previous) => {
      if (active) setPreviousReport(previous);
    }).catch(() => { if (active) setPreviousReport(null); });
    return () => { active = false; };
  }, [previousRunId, report?.run_id]);
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
    setMcpConfig(""); setMcpTestResult(null); setMcpTestError("");
    setToast("Auth updated");
  }

  function clearAuth() {
    setToken(""); setTokenDraft(""); setAuthStatus("missing"); setAuthError(""); setMcpConfig(""); setMcpTestResult(null); setMcpTestError(""); setToast("Auth cleared");
  }

  function saveTarget() {
    const target = targetDraft.trim().replace(/\/$/, "");
    try {
      const parsed = new URL(target);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("Use an http or https URL.");
    } catch (error) {
      setTargetCheckResult({ reachable: false, status_code: null, elapsed_ms: 0, message: error instanceof Error ? error.message : "Enter a valid target URL." });
      return;
    }
    setBaseUrl(target); localStorage.setItem("plumbline-target", target); setAuthStatus(token ? "set" : "missing"); setMcpConfig(""); setMcpTestResult(null); setMcpTestError(""); setTargetCheckResult(null);
    setToast("Target updated");
  }

  function rememberContract(source: StoredContractSource, imported: ApiModel, preferredId?: string) {
    const existing = savedContracts.find((contract) => contract.id === (preferredId || activeContractId));
    const id = preferredId || activeContractId || `api-${Date.now()}`;
    const entry: SavedContract = { id, name: existing?.name || imported.title, source };
    setSavedContracts((current) => [entry, ...current.filter((contract) => contract.id !== id)]);
    setActiveContractId(id);
    setContractNameDraft(entry.name);
    try {
      localStorage.setItem("plumbline-active-contract-id", id);
      localStorage.setItem("plumbline-contract-source", JSON.stringify(source));
    } catch { setToast("API loaded, but browser storage is full"); }
  }

  async function activateContract(source: StoredContractSource, preferredId?: string) {
    if (source.kind === "spec" && !source.value.trim()) { setImportError("Choose a file or paste an OpenAPI document first."); return; }
    setImportBusy(true); setImportError("");
    try {
      const body = source.kind === "url" ? { url: source.value } : { spec: source.value };
      const imported = await apiRequest<ApiModel>(`${API}/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      rememberContract(source, imported, preferredId);
      setMcpTestResult(null); setMcpTestError("");
      setSpecText(source.kind === "spec" ? source.value : ""); setModel(imported); setReportModel(null); setSelectedOperationId(imported.operations[0]?.id ?? ""); setRunScopeMode("all"); setSelectedRunGroups([]); setPage("explorer"); setLastRunStatus("none"); localStorage.removeItem("plumbline-last-run-id"); setReport(null); setRunSummary(null); setToast(`Loaded ${imported.operations.length} operations`);
    } catch (error) { setImportError(error instanceof Error ? error.message : "Could not load the API contract."); }
    finally { setImportBusy(false); }
  }

  function importSpec(text = specText) {
    return activateContract({ kind: "spec", value: text });
  }

  function loadDemoContract() {
    return activateContract({ kind: "url", value: DEMO_SPEC_URL });
  }

  function loadSavedContract(id: string) {
    const contract = savedContracts.find((item) => item.id === id);
    if (!contract) return;
    void activateContract(contract.source, contract.id);
  }

  function renameSavedContract() {
    const name = contractNameDraft.trim();
    if (!activeContractId || !name) return;
    setSavedContracts((current) => current.map((item) => item.id === activeContractId ? { ...item, name } : item));
    setToast("Saved API renamed");
  }

  async function removeSavedContract() {
    if (!activeContractId) return;
    const removingActive = activeContractId === localStorage.getItem("plumbline-active-contract-id");
    try {
      if (removingActive) await apiRequest<{ cleared: boolean }>(`${API}/model`, { method: "DELETE" });
      const remaining = savedContracts.filter((item) => item.id !== activeContractId);
      setSavedContracts(remaining); setActiveContractId(""); setContractNameDraft("");
      localStorage.removeItem("plumbline-active-contract-id");
      if (removingActive) {
        localStorage.removeItem("plumbline-contract-source");
        setModel(null); setReportModel(null); setSpecText(""); setSelectedOperationId(""); setReport(null); setRunSummary(null); setLastRunStatus("none");
        setPage("import");
      }
      setToast("Saved API removed");
    } catch (error) { setImportError(error instanceof Error ? error.message : "Could not remove the saved API."); }
  }

  async function loadFile(file?: File) {
    if (!file) return;
    setSpecText(await file.text()); setImportError("");
  }

  async function sendOperation() {
    if (!selectedOperation) { setRequestError("Choose an operation first."); return; }
    if (selectedOperation.method !== "GET" && !allowMutations) { setRequestError("Mutations are off. Turn them on in Settings before sending this request."); return; }
    try {
      if (!selectedOperation) throw new Error("Choose an operation first.");
      const draft = buildRequestDraft(selectedOperation, baseUrl, parameterValues, bodyValue);
      if (draft.error) throw new Error(draft.error);
      setRequestBusy(true); setRequestError(""); setResponsePayload(null);
      const start = performance.now();
      const result = await apiRequest<Omit<ResponsePayload, "elapsed_ms">>(`${API}/explorer/request`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation_id: selectedOperation.id, base_url: baseUrl, parameters: draft.parameters, body: draft.body, auth: token ? { type: authMode, token, header_name: apiKeyHeader } : null }),
      });
      const elapsed = performance.now() - start;
      setResponsePayload({ ...result, elapsed_ms: elapsed });
      if (token && result.status === 401 || token && result.status === 403) { setAuthStatus("invalid"); setToast("Credentials rejected by target"); }
      else if (token && result.status < 400) setAuthStatus("set");
      else setToast(`Response received · HTTP ${result.status}`);
    } catch (error) { setRequestError(error instanceof Error ? error.message : "The request could not be completed."); }
    finally { setRequestBusy(false); }
  }

  async function runChecks() {
    if (!model) { setRunError("Import a contract before starting a run."); return; }
    if (!baseUrl.trim()) { setRunError("Set a target in Settings before starting a run."); return; }
    const scopedOperationIds = runScopeMode === "groups"
      ? model.operations.filter((operation) => selectedRunGroups.includes(operationTag(operation))).map((operation) => operation.id)
      : undefined;
    if (scopedOperationIds && !scopedOperationIds.length) { setRunError("Select at least one operation group for this run."); return; }
    let roles: unknown[] = [];
    try { roles = rolesText.trim() ? JSON.parse(rolesText) : []; if (!Array.isArray(roles)) throw new Error("Roles must be a JSON array."); }
    catch (error) { setRunError(error instanceof Error ? error.message : "Roles must be valid JSON."); return; }
    let fixtures: Record<string, string> = {};
    try {
      const parsed = fixturesText.trim() ? JSON.parse(fixturesText) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => value === null || typeof value === "object")) throw new Error("Fixtures must be a JSON object with scalar values.");
      fixtures = Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, String(value)]));
    } catch (error) { setRunError(error instanceof Error ? error.message : "Fixtures must be valid JSON."); return; }
    setRunError(""); setRunBusy(true); setReport(null); setRunSummary(null); setActiveCluster(null);
    try {
      const created = await apiRequest<{ run_id: string }>(`${API}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_url: baseUrl, auth: token ? { type: authMode, token, header_name: apiKeyHeader } : null, roles, fixtures, discover_fixtures: discoverFixtures, allow_mutations: allowMutations, operation_ids: scopedOperationIds }) });
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const state = await apiRequest<{ status: string }>(`${API}/runs/${created.run_id}`);
        if (state.status === "completed") {
          const [completed, summary] = await Promise.all([
            apiRequest<RunReport>(`${API}/runs/${created.run_id}/report.json`),
            apiRequest<RunSummary>(`${API}/runs/${created.run_id}/summary`),
          ]);
          setReport(completed); setReportModel(model); setRunSummary(summary); setSelectedFindingId(completed.findings.find((finding) => finding.status === "fail")?.id ?? completed.findings[0]?.id ?? "");
          setStatusFilter(completed.findings.some((finding) => finding.status === "fail") ? "fail" : "all");
          const finalStatus = completed.summary.fail > 0 ? "bad" : completed.summary.inconclusive > 0 ? "inconclusive" : "good";
          setLastRunStatus(finalStatus); localStorage.setItem("plumbline-last-run-id", completed.run_id);
          const history = await apiRequest<RecentRun[]>(`${API}/runs`);
          setRunHistory(history);
          setPreviousRunId(history.find((item) => item.status === "completed" && item.run_id !== completed.run_id)?.run_id ?? "");
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
      setMcpConfig(JSON.stringify(config, null, 2)); setToast("MCP server config ready");
    } catch (error) { setMcpError(error instanceof Error ? error.message : "Could not generate MCP configuration."); }
    finally { setMcpBusy(false); }
  }

  async function testMcpConnection() {
    if (!model) { setMcpTestError("Import an API contract first."); return; }
    if (!baseUrl.trim()) { setMcpTestError("Set the API target in Settings first."); return; }
    setMcpTestBusy(true); setMcpTestError(""); setMcpTestResult(null);
    try {
      const result = await apiRequest<McpTestResult>(`${API}/mcp-test`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: baseUrl, auth: token ? { type: authMode, token, header_name: apiKeyHeader } : null, allow_mutations: allowMutations }),
      });
      setMcpTestResult(result);
      setToast(`MCP connected · ${result.tool_count} tools discovered`);
    } catch (error) { setMcpTestError(error instanceof Error ? error.message : "MCP connection test failed."); }
    finally { setMcpTestBusy(false); }
  }

  async function checkTargetConnection() {
    const target = targetDraft.trim() || baseUrl.trim();
    if (!target) {
      setTargetCheckResult({ reachable: false, status_code: null, elapsed_ms: 0, message: "Enter a base URL before checking the connection." });
      return;
    }
    setTargetCheckBusy(true); setTargetCheckResult(null);
    try {
      const result = await apiRequest<{ reachable: boolean; status_code: number | null; elapsed_ms: number; message: string }>(`${API}/target/check`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: target, auth: tokenDraft.trim() ? { type: authModeDraft, token: tokenDraft, header_name: headerDraft } : null }),
      });
      setTargetCheckResult(result);
      if (tokenDraft.trim() && (result.status_code === 401 || result.status_code === 403)) setAuthStatus("invalid");
      else if (tokenDraft.trim() && result.reachable && (result.status_code ?? 500) < 400) setAuthStatus("set");
      setToast(result.reachable ? `Target responded · HTTP ${result.status_code}` : "Target connection failed");
    } catch (error) {
      setTargetCheckResult({ reachable: false, status_code: null, elapsed_ms: 0, message: error instanceof Error ? error.message : "Target connection failed." });
    } finally { setTargetCheckBusy(false); }
  }

  function saveRunPreset() {
    const name = runPresetName.trim();
    if (!name) { setRunError("Give this run configuration a name before saving."); return; }
    let roles = rolesText;
    try {
      const parsed = rolesText.trim() ? JSON.parse(rolesText) : [];
      if (!Array.isArray(parsed)) throw new Error("Roles must be a JSON array.");
      roles = JSON.stringify(parsed.map((role) => role && typeof role === "object" ? { ...role, token: "" } : role), null, 2);
    } catch (error) { setRunError(error instanceof Error ? error.message : "Roles must be valid JSON before saving."); return; }
    const id = runPresetId || `run-${Date.now()}`;
    const preset: RunPreset = { id, name, scopeMode: runScopeMode, groups: selectedRunGroups, fixtures: fixturesText, roles, discoverFixtures };
    setRunPresets((current) => [preset, ...current.filter((item) => item.id !== id)]);
    setRunPresetId(id); setToast("Run configuration saved"); setRunError("");
  }

  function loadRunPreset(id = runPresetId) {
    const preset = runPresets.find((item) => item.id === id);
    if (!preset) return;
    setRunPresetId(preset.id); setRunPresetName(preset.name); setRunScopeMode(preset.scopeMode); setSelectedRunGroups(preset.groups);
    setFixturesText(preset.fixtures); setRolesText(preset.roles); setDiscoverFixtures(preset.discoverFixtures); setRunError(""); setToast(`Loaded ${preset.name}`);
  }

  function deleteRunPreset() {
    if (!runPresetId) return;
    setRunPresets((current) => current.filter((item) => item.id !== runPresetId));
    setRunPresetId(""); setRunPresetName(""); setToast("Run configuration removed");
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
        <div className="header-brand">PLUMBLINE</div>
        <nav className="header-breadcrumb" aria-label="Current page"><span>{page === "import" ? "CONTRACT" : page.toUpperCase()}</span><ChevronRight size={14} /><strong>{pageTitles[page]}</strong></nav>
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
          {page === "import" && <ImportPage model={model} specText={specText} setSpecText={setSpecText} error={importError} busy={importBusy} contracts={savedContracts} activeContractId={activeContractId} contractName={contractNameDraft} setContractName={setContractNameDraft} selectContract={loadSavedContract} renameContract={renameSavedContract} removeContract={() => void removeSavedContract()} onFile={loadFile} onImport={() => void importSpec()} onDemo={() => void loadDemoContract()} />}
          {page === "explorer" && <ExplorerPage model={model} target={baseUrl} selectedOperation={selectedOperation} groups={operationGroups} search={operationSearch} setSearch={setOperationSearch} collapsed={endpointsCollapsed} setCollapsed={setEndpointsCollapsed} selectOperation={setSelectedOperationId} parameters={parameterValues} setParameters={setParameterValues} body={bodyValue} setBody={setBodyValue} requestTab={requestTab} setRequestTab={setRequestTab} responseTab={responseTab} setResponseTab={setResponseTab} response={responsePayload} requestError={requestError} requestBusy={requestBusy} send={sendOperation} mutations={allowMutations} authStatus={authStatus} openAuth={() => openSettings("auth")} openSettings={() => openSettings()} openMcp={() => setPage("mcp")} copy={copyText} />}
          {page === "runs" && <RunsPage model={model} reportModel={reportModel} target={baseUrl} authStatus={authStatus} authMode={authMode} openSettings={() => openSettings()} roles={rolesText} setRoles={setRolesText} fixtures={fixturesText} setFixtures={setFixturesText} discoverFixtures={discoverFixtures} setDiscoverFixtures={setDiscoverFixtures} fixturesOpen={fixturesOpen} setFixturesOpen={setFixturesOpen} runBusy={runBusy} runError={runError} run={runChecks} mutations={allowMutations} scopeMode={runScopeMode} setScopeMode={setRunScopeMode} selectedGroups={selectedRunGroups} setSelectedGroups={setSelectedRunGroups} report={report} summary={runSummary} statusFilter={statusFilter} setStatusFilter={setStatusFilter} search={findingSearch} setSearch={setFindingSearch} searchRef={findingSearchRef} checkFilter={checkFilter} setCheckFilter={setCheckFilter} groupBy={groupBy} setGroupBy={setGroupBy} activeCluster={activeCluster} setActiveCluster={setActiveCluster} findings={filteredFindings} selectedId={selectedFindingId} setSelectedId={setSelectedFindingId} selectedFinding={selectedFinding} rowRefs={rowRefs} copy={copyText} presets={runPresets} presetId={runPresetId} setPresetId={setRunPresetId} presetName={runPresetName} setPresetName={setRunPresetName} savePreset={saveRunPreset} loadPreset={loadRunPreset} deletePreset={deleteRunPreset} history={runHistory} previousRunId={previousRunId} setPreviousRunId={setPreviousRunId} previousReport={previousReport} />}
          {page === "mcp" && <McpPage model={model} target={baseUrl} tokenSet={!!token} mutations={allowMutations} config={mcpConfig} error={mcpError} busy={mcpBusy} generate={generateMcpConfig} copy={copyText} test={testMcpConnection} testBusy={mcpTestBusy} testError={mcpTestError} testResult={mcpTestResult} />}
          {page === "settings" && <SettingsPage target={targetDraft} setTarget={(value) => { setTargetDraft(value); setTargetCheckResult(null); }} saveTarget={saveTarget} checkTarget={checkTargetConnection} checkingTarget={targetCheckBusy} targetCheck={targetCheckResult} authStatus={authStatus} authMode={authModeDraft} setAuthMode={setAuthModeDraft} header={headerDraft} setHeader={setHeaderDraft} token={tokenDraft} setToken={setTokenDraft} showToken={showToken} setShowToken={setShowToken} authError={authError} clearError={() => setAuthError("")} saveAuth={saveAuth} clearAuth={clearAuth} mutations={allowMutations} setMutations={(value) => { setAllowMutations(value); setMcpConfig(""); setMcpTestResult(null); setMcpTestError(""); setToast(value ? "State-changing requests enabled" : "State-changing requests disabled"); }} />}
        </main>
      </div>
      {toast && <div className="toast" role="status"><CheckCircle2 size={16} />{toast}</div>}
    </div>
  );
}

function ImportPage({ model, specText, setSpecText, error, busy, contracts, activeContractId, contractName, setContractName, selectContract, renameContract, removeContract, onFile, onImport, onDemo }: { model: ApiModel | null; specText: string; setSpecText: (value: string) => void; error: string; busy: boolean; contracts: SavedContract[]; activeContractId: string; contractName: string; setContractName: (value: string) => void; selectContract: (id: string) => void; renameContract: () => void; removeContract: () => void; onFile: (file?: File) => void; onImport: () => void; onDemo: () => void }) {
  return <section className="page import-page">
    <PageHeading subtitle="Load an OpenAPI contract to explore endpoints and verify observed behavior." />
    {(contracts.length > 0 || model) && <div className="surface contract-library"><div><strong>Saved APIs</strong><small>Contracts are saved in this browser and restored on reload.</small></div><select aria-label="Select saved API" value={activeContractId} onChange={(event) => selectContract(event.target.value)}><option value="">Choose a saved API</option>{contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.name}</option>)}</select><input aria-label="Saved API name" value={contractName} onChange={(event) => setContractName(event.target.value)} placeholder="API name" /><button className="button button-secondary" onClick={renameContract} disabled={!activeContractId || !contractName.trim()}>Rename</button><button className="button button-quiet danger-text" onClick={removeContract} disabled={!activeContractId}>Remove saved API</button></div>}
    <div className="import-grid">
      <div className="surface import-surface">
        <div className="surface-heading"><div className="heading-icon"><FileJson2 size={17} /></div><div><h2>OpenAPI document</h2><p>JSON or YAML · OpenAPI 3.x</p></div><label className="button button-secondary file-button"><FileUp size={15} />Choose file<input type="file" accept=".json,.yaml,.yml,application/json,text/yaml" onChange={(event) => onFile(event.target.files?.[0])} /></label></div>
        {model && <div className="contract-loaded-note"><CheckCircle2 size={14} /><span>Active API: <strong>{model.title}</strong> v{model.version} · {model.operations.length} operations. Importing a valid document replaces this contract.</span></div>}
        <textarea className="spec-editor" value={specText} onChange={(event) => setSpecText(event.target.value)} spellCheck={false} placeholder={'Paste or load your OpenAPI document…\n\nopenapi: 3.0.3\ninfo:\n  title: Example API\n  version: 1.0.0\npaths: {}'} />
        <div className="editor-foot"><span><Braces size={13} />{specText ? `${specText.length.toLocaleString()} characters` : "No document loaded"}</span><span>YAML / JSON</span></div>
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        <div className="import-actions"><button className="button button-primary" onClick={onImport} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <FileCheck2 size={15} />}{busy ? "Validating" : model ? "Validate and replace API" : "Validate and import"}<ArrowRight size={15} /></button><button className="button button-quiet" onClick={onDemo} disabled={busy}><Play size={14} />Load demo</button></div>
      </div>
      <aside className="import-aside"><div className="eyebrow">AFTER IMPORT</div><div className="guide-step"><span>01</span><div><strong>Validate the spec</strong><p>Resolve references and check the OpenAPI structure.</p></div><Check size={15} /></div><div className="guide-step"><span>02</span><div><strong>Explore operations</strong><p>Choose a target separately and inspect live responses.</p></div><ArrowRight size={15} /></div><div className="guide-step"><span>03</span><div><strong>Run contract checks</strong><p>Review findings with the request and response evidence.</p></div><ArrowRight size={15} /></div><div className="notice"><CircleAlert size={16} /><span>Plumbline never infers the target URL from the OpenAPI server field.</span></div></aside>
    </div>
  </section>;
}

function SettingsPage(props: {
  target: string; setTarget: (value: string) => void; saveTarget: () => void; checkTarget: () => void; checkingTarget: boolean;
  targetCheck: { reachable: boolean; status_code: number | null; elapsed_ms: number; message: string } | null;
  authStatus: AuthStatus; authMode: AuthMode; setAuthMode: (value: AuthMode) => void;
  header: string; setHeader: (value: string) => void; token: string; setToken: (value: string) => void;
  showToken: boolean; setShowToken: (value: boolean) => void; authError: string; clearError: () => void;
  saveAuth: () => void; clearAuth: () => void; mutations: boolean; setMutations: (value: boolean) => void;
}) {
  return <section className="page settings-page">
    <PageHeading subtitle="Configure where requests go, how they authenticate, and which requests may change data." />
    <div className="settings-layout">
      <section className="surface settings-card">
        <div className="settings-card-heading"><span className="settings-icon"><Globe2 size={17} /></span><div><h2>API target</h2><p>Requests and verification runs use this base URL.</p></div></div>
        <label className="field-label" htmlFor="settings-target">BASE URL</label>
        <div className="target-editor"><input id="settings-target" value={props.target} onChange={(event) => props.setTarget(event.target.value)} placeholder="http://127.0.0.1:8002" onKeyDown={(event) => { if (event.key === "Enter") props.saveTarget(); }} /><button className="button button-secondary" onClick={props.checkTarget} disabled={props.checkingTarget}>{props.checkingTarget ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}Check connection</button><button className="button button-primary" onClick={props.saveTarget}>Save target</button></div>
        {props.targetCheck && <div className={`target-check-result ${props.targetCheck.reachable ? "reachable" : "unreachable"}`} role="status"><span>{props.targetCheck.reachable ? `Responded with HTTP ${props.targetCheck.status_code} in ${props.targetCheck.elapsed_ms} ms` : "Could not connect"}</span><small>{props.targetCheck.message}</small></div>}
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
  model: ApiModel | null; target: string; selectedOperation: Operation | null; groups: [string, Operation[]][]; search: string; setSearch: (value: string) => void;
  collapsed: boolean; setCollapsed: (value: boolean) => void; selectOperation: (id: string) => void; parameters: Record<string, string>;
  setParameters: (value: (current: Record<string, string>) => Record<string, string>) => void; body: string; setBody: (value: string) => void;
  requestTab: RequestTab; setRequestTab: (value: RequestTab) => void; responseTab: ResponseTab; setResponseTab: (value: ResponseTab) => void;
  response: ResponsePayload | null; requestError: string; requestBusy: boolean; send: () => void; mutations: boolean;
  authStatus: AuthStatus; openAuth: () => void; openSettings: () => void; openMcp: () => void; copy: (value: string, message: string) => void;
}) {
  const operation = props.selectedOperation;
  const requestParameters = operation?.parameters.filter((parameter) => ["path", "query"].includes(parameter.in)) ?? [];
  const headerParameters = operation?.parameters.filter((parameter) => parameter.in === "header") ?? [];
  const isMutation = !!operation && operation.method !== "GET";
  const requestDraft = buildRequestDraft(operation, props.target, props.parameters, props.body);
  return <section className={`page explorer-page ${props.collapsed ? "endpoints-collapsed" : ""}`}>
    <PageHeading subtitle="Select an operation, configure its request, and inspect the response." action={<button className="button button-secondary" onClick={props.openMcp}><Braces size={15} />MCP ready <ChevronRight size={14} /></button>} />
    {props.model && <div className="workspace-state-strip"><span><small>API</small><strong>{props.model.title} v{props.model.version}</strong></span><span><small>TARGET</small><strong className="mono">{props.target || "Not configured"}</strong></span><span><small>AUTH</small><strong className={`auth-text auth-${props.authStatus}`}>{props.authStatus === "set" ? "Set" : props.authStatus === "invalid" ? "Invalid" : "Missing"}</strong></span><span><small>WRITES</small><strong className={props.mutations ? "fail-text" : "pass-text"}>{props.mutations ? "Enabled" : "Off"}</strong></span></div>}
    {props.model && (!props.target || (props.model.operations.some((item) => item.security.length > 0) && props.authStatus !== "set")) && <div className="workspace-readiness"><AlertTriangle size={15} /><div><strong>Finish session setup</strong><span>{!props.target ? "Set an explicit target before sending requests or running checks." : "This API has secured operations. Add credentials to avoid authentication-related inconclusive results."}</span></div><button className="button button-secondary" onClick={() => !props.target ? props.openSettings() : props.openAuth()}>{!props.target ? "Set target" : "Set authentication"}<ArrowRight size={13} /></button></div>}
    {!props.model ? <EmptyState title="Import an API contract to begin" action="Go to import" /> : <div className="explorer-layout">
      <aside className="endpoint-browser surface">
        <div className="browser-heading"><div><div className="eyebrow">ENDPOINTS</div><strong>{props.model.title}</strong><span>v{props.model.version} · {props.model.operations.length} operations</span></div><button className="icon-button" onClick={() => props.setCollapsed(true)} aria-label="Collapse endpoint list"><PanelLeftClose size={15} /></button></div>
        <label className="search-control"><Search size={14} /><input value={props.search} onChange={(event) => props.setSearch(event.target.value)} placeholder="Find an operation" /><kbd>/</kbd></label>
        <div className="endpoint-list">{props.groups.map(([tag, operations]) => <div className="endpoint-group" key={tag}><div className="endpoint-group-title">{tag}<span>{operations.length}</span></div>{operations.map((item) => <button key={item.id} className={`endpoint-item ${operation?.id === item.id ? "selected" : ""}`} onClick={() => props.selectOperation(item.id)}><MethodBadge method={item.method} /><span className="endpoint-path">{item.path}</span></button>)}</div>)}{!props.groups.length && <div className="empty-filter">No operations match.</div>}</div>
      </aside>
      <div className="workspace-column">{props.collapsed && <button className="button button-quiet expand-endpoints" onClick={() => props.setCollapsed(false)}><PanelLeftOpen size={15} />Show endpoints</button>}
        {operation ? <>
          <div className="operation-summary surface"><div className="operation-title"><MethodBadge method={operation.method} /><h2>{operation.path}</h2><button className="icon-button" onClick={() => props.copy(operation.path, "Path copied")} aria-label="Copy endpoint path"><Copy size={14} /></button></div>{operation.summary && <p>{operation.summary}</p>}</div>
          <div className="workbench-grid">
            <section className="surface request-card">
              <div className="card-title-row"><div><span className="step-number">01</span><h3>Request</h3></div><button className="button button-secondary send-button" onClick={props.send} disabled={props.requestBusy || !!requestDraft.error || (isMutation && !props.mutations)} title={requestDraft.error || undefined}>{props.requestBusy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}Send request</button></div>
              <div className="request-tabs">{(["Params", "Body", "Auth", "Headers"] as RequestTab[]).map((tab) => <button key={tab} className={props.requestTab === tab ? "active" : ""} onClick={() => props.setRequestTab(tab)}>{tab}{tab === "Params" && requestParameters.length > 0 && <span>{requestParameters.length}</span>}{tab === "Headers" && headerParameters.length > 0 && <span>{headerParameters.length}</span>}</button>)}</div>
              <details className="request-preview"><summary><span>Request preview</span><small>{requestDraft.error ? "Needs attention" : "Ready to send"}</small><ChevronDown size={13} /></summary><div className="request-preview-body">{requestDraft.error && <InlineMessage tone="warning">{requestDraft.error}</InlineMessage>}<div><span>{operation.method}</span><code>{requestDraft.url || "Enter required values to build the request URL"}</code></div>{operation.request_schema && <pre>{props.body.trim() || "No body provided"}</pre>}<small>{props.authStatus === "set" ? "Session credential will be attached if this operation requires authentication." : "No session credential will be attached."}</small></div></details>
              {props.requestTab === "Params" && <div className="tab-content parameter-grid">{requestParameters.length ? requestParameters.map((parameter) => <ParameterInput key={`${parameter.in}:${parameter.name}`} parameter={parameter} value={props.parameters[parameter.name] ?? ""} onChange={(value) => props.setParameters((current) => ({ ...current, [parameter.name]: value }))} />) : <EmptyInline>No path or query parameters for this endpoint.</EmptyInline>}</div>}
              {props.requestTab === "Body" && <div className="tab-content">{operation.request_schema ? <><div className="body-hint">application/json {operation.request_required ? "· required" : "· optional"}</div><textarea className="body-editor" value={props.body} onChange={(event) => props.setBody(event.target.value)} spellCheck={false} /></> : <EmptyInline>This operation does not define a request body.</EmptyInline>}</div>}
              {props.requestTab === "Auth" && <div className="tab-content auth-info"><div className={`auth-state auth-${props.authStatus}`}><KeyRound size={16} /><div><strong>Session auth: {props.authStatus}</strong><span>Credential is managed in Settings.</span></div><button className="button button-secondary" onClick={props.openAuth}>Open settings</button></div><p>OpenAPI security: {operation.security.length ? operation.security.join(", ") : "No security requirement for this operation"}</p></div>}
              {props.requestTab === "Headers" && <div className="tab-content parameter-grid">{headerParameters.length ? headerParameters.map((parameter) => <ParameterInput key={`${parameter.in}:${parameter.name}`} parameter={parameter} value={props.parameters[parameter.name] ?? ""} onChange={(value) => props.setParameters((current) => ({ ...current, [parameter.name]: value }))} />) : <EmptyInline>No operation-specific headers.</EmptyInline>}</div>}
              {isMutation && !props.mutations && <InlineMessage tone="warning">Mutations are off. Turn them on in Settings to send this request.</InlineMessage>}
              {props.requestError && <InlineMessage tone="error">{props.requestError}</InlineMessage>}
              <div className="request-foot"><ShieldCheck size={13} />{props.target ? <>Requests go through Plumbline to <code>{props.target}</code>.</> : <>Set a target before sending. <button className="link-button" onClick={props.openSettings}>Open Settings</button></>}</div>
            </section>
            <section className="surface response-card"><div className="card-title-row"><div><span className="step-number">02</span><h3>Response</h3></div>{props.response && <StatusBadge status={props.response.status < 400 ? "pass" : "fail"} label={`HTTP ${props.response.status}`} />}</div>
              <div className="request-tabs response-tabs">{(["Body", "Headers", "Timing"] as ResponseTab[]).map((tab) => <button key={tab} className={props.responseTab === tab ? "active" : ""} onClick={() => props.setResponseTab(tab)}>{tab}</button>)}</div>
              {props.response ? <>
                {props.responseTab === "Body" && <><div className="response-url"><code>{props.response.url}</code><button className="icon-button" onClick={() => props.copy(pretty(props.response?.body), "Response copied")} aria-label="Copy response body"><Copy size={14} /></button></div><pre className="response-body">{pretty(props.response.body)}</pre></>}
                {props.responseTab === "Headers" && <><div className="response-url"><code>Response headers</code><button className="icon-button" onClick={() => props.copy(pretty(props.response?.headers), "Response headers copied")} aria-label="Copy response headers"><Copy size={14} /></button></div><pre className="response-body">{pretty(props.response.headers)}</pre></>}
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
  model: ApiModel | null; reportModel: ApiModel | null; target: string; authStatus: AuthStatus; authMode: AuthMode; openSettings: (type?: "target" | "auth") => void;
  roles: string; setRoles: (value: string) => void; runBusy: boolean; runError: string; run: () => void;
  fixtures: string; setFixtures: (value: string) => void; discoverFixtures: boolean; setDiscoverFixtures: (value: boolean) => void;
  fixturesOpen: boolean; setFixturesOpen: (value: boolean) => void;
  scopeMode: "all" | "groups"; setScopeMode: (value: "all" | "groups") => void;
  selectedGroups: string[]; setSelectedGroups: (value: string[]) => void;
  mutations: boolean; report: RunReport | null; summary: RunSummary | null; statusFilter: "all" | "fail" | "pass" | "inconclusive";
  setStatusFilter: (value: "all" | "fail" | "pass" | "inconclusive") => void; search: string; setSearch: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>; checkFilter: string; setCheckFilter: (value: string) => void;
  groupBy: "none" | "check" | "endpoint" | "cluster"; setGroupBy: (value: "none" | "check" | "endpoint" | "cluster") => void;
  activeCluster: string | null; setActiveCluster: (value: string | null) => void; findings: Finding[]; selectedId: string;
  setSelectedId: (value: string) => void; selectedFinding: Finding | null; rowRefs: React.MutableRefObject<Record<string, HTMLElement | null>>;
  copy: (value: string, message: string) => void;
  presets: RunPreset[]; presetId: string; setPresetId: (value: string) => void; presetName: string; setPresetName: (value: string) => void;
  savePreset: () => void; loadPreset: (id?: string) => void; deletePreset: () => void;
  history: RecentRun[]; previousRunId: string; setPreviousRunId: (value: string) => void; previousReport: RunReport | null;
}) {
  const model = props.model;
  const [scopeQuery, setScopeQuery] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [runsView, setRunsView] = useState<"configuration" | "results">(props.report ? "results" : "configuration");
  useEffect(() => { if (props.report) setRunsView("results"); }, [props.report?.run_id]);
  const operations = useMemo(() => new Map(((runsView === "results" ? props.reportModel : null) ?? model)?.operations.map((operation) => [operation.id, operation]) ?? []), [model, props.reportModel, runsView]);
  const scopeGroups = useMemo(() => {
    const grouped = new Map<string, Operation[]>();
    for (const operation of model?.operations ?? []) {
      const group = operationTag(operation);
      grouped.set(group, [...(grouped.get(group) ?? []), operation]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [model]);
  const visibleScopeGroups = useMemo(() => {
    const query = scopeQuery.trim().toLocaleLowerCase();
    return query ? scopeGroups.filter(([name]) => name.toLocaleLowerCase().includes(query)) : scopeGroups;
  }, [scopeGroups, scopeQuery]);
  const displayedScopeGroups = visibleScopeGroups.slice(0, 200);
  const selectedOperationCount = scopeGroups.filter(([name]) => props.selectedGroups.includes(name)).reduce((count, [, items]) => count + items.length, 0);
  const schemas = Object.entries(model?.schemas ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const checks = [...new Set((props.report?.findings ?? []).map((finding) => finding.check))].sort();
  const checkResults = checks.map((check) => {
    const findings = (props.report?.findings ?? []).filter((finding) => finding.check === check);
    return { check, fail: findings.filter((finding) => finding.status === "fail").length, inconclusive: findings.filter((finding) => finding.status === "inconclusive").length, pass: findings.filter((finding) => finding.status === "pass").length };
  });
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
  const missingFixtureCount = props.summary?.missing_fixture_inconclusive ?? 0;
  const startedAt = props.report ? new Date(props.report.started_at).toLocaleString() : "";
  const inconclusiveReasons = [...new Set((props.report?.findings ?? []).filter((finding) => finding.status === "inconclusive").map((finding) => finding.observed || "The check could not reach a conclusion."))]
    .map((reason) => ({ reason, count: (props.report?.findings ?? []).filter((finding) => finding.status === "inconclusive" && (finding.observed || "The check could not reach a conclusion.") === reason).length }));
  const comparison = useMemo(() => {
    if (!props.report || !props.previousReport) return null;
    const key = (finding: Finding) => JSON.stringify([finding.check, finding.operation_id ?? "", finding.expected, finding.variant ?? ""]);
    const before = new Map(props.previousReport.findings.map((finding) => [key(finding), finding]));
    const sameOperationScope = JSON.stringify([...(props.previousReport.config?.operation_ids as string[] ?? [])].sort()) === JSON.stringify([...(props.report.config?.operation_ids as string[] ?? [])].sort());
    const previousFingerprint = props.previousReport.config?.contract_fingerprint;
    const currentFingerprint = props.report.config?.contract_fingerprint;
    const sameContract = previousFingerprint === undefined && currentFingerprint === undefined ? true : previousFingerprint === currentFingerprint;
    const sameScope = sameOperationScope && sameContract;
    const newFailures: Finding[] = [];
    const fixedFailures: Finding[] = [];
    const unchangedFailures: Finding[] = [];
    for (const finding of props.report.findings) {
      const previous = before.get(key(finding));
      if (finding.status === "fail") {
        if (previous?.status === "fail") unchangedFailures.push(finding);
        else if (previous || sameScope) newFailures.push(finding);
      } else if (previous?.status === "fail") fixedFailures.push(finding);
    }
    return { newFailures, fixedFailures, unchangedFailures, sameScope };
  }, [props.report, props.previousReport]);
  function shareFilteredView() {
    if (!props.report) return;
    const url = new URL(window.location.href);
    url.searchParams.set("run", props.report.run_id);
    url.searchParams.set("status", props.statusFilter);
    if (props.checkFilter === "all") url.searchParams.delete("check"); else url.searchParams.set("check", props.checkFilter);
    if (props.search.trim()) url.searchParams.set("q", props.search.trim()); else url.searchParams.delete("q");
    if (props.activeCluster) url.searchParams.set("cluster", props.activeCluster); else url.searchParams.delete("cluster");
    void props.copy(url.toString(), "Filtered findings link copied");
  }
  return <section className="page runs-page">
    <div className="runs-page-heading">
      {runsView === "configuration" || !props.report ? <p>Run the whole contract, or pick the groups you changed.</p> : <div className="runs-heading-result"><div className="runs-meta"><span>Run <b>{props.report.run_id.slice(0, 10)}</b></span><span>Target <b>{props.report.base_url}</b></span><span>Started <b>{startedAt}</b></span><span>Scope <b>{props.summary?.operation_count ?? 0} operations</b></span></div><div className="run-result-actions"><button className="button button-secondary" onClick={() => setRunsView("configuration")}>Edit scope</button><a className="button button-secondary" href={`${API}/runs/${props.report.run_id}/report.html`} target="_blank" rel="noreferrer"><ArrowDownToLine size={14} />HTML report</a></div></div>}
    </div>
    {!model ? <EmptyState title="Import an API before running checks" action="Go to import" /> : <>
      <div className="runs-view-tabs" role="tablist" aria-label="Run analysis view">
        <button role="tab" aria-selected={runsView === "configuration"} className={runsView === "configuration" ? "active" : ""} onClick={() => setRunsView("configuration")}>New run</button>
        <button role="tab" aria-selected={runsView === "results"} className={runsView === "results" ? "active" : ""} onClick={() => props.report && setRunsView("results")} disabled={!props.report}>Results</button>
      </div>
      {runsView === "configuration" && <div className="run-config-stage">
      <div className="run-session surface" aria-label="Run target">
        <div className="run-session-kv"><span>API</span><strong>{model.title} <small>{model.version}</small></strong></div>
        <div className="run-session-kv"><span>Target</span><strong className="mono">{props.target || "Not configured"}</strong></div>
        <div className="run-session-kv"><span>Auth</span><strong><i className={`run-state-dot ${props.authStatus}`} />{props.authStatus === "set" ? `${props.authMode === "bearer" ? "Bearer token" : "API key"} set` : props.authStatus === "invalid" ? "Invalid" : "Missing"}</strong></div>
        <div className="run-session-kv"><span>State-changing checks</span><strong><i className={`run-state-dot ${props.mutations ? "warn" : ""}`} />{props.mutations ? "On" : "Off, read-only run"}</strong></div>
        <button className="button button-quiet run-session-settings" onClick={() => props.openSettings()}>Change in Settings</button>
      </div>
      {(!props.target || (model.operations.some((operation) => operation.security.length > 0) && props.authStatus !== "set")) && <div className="run-readiness"><AlertTriangle size={15} /><span>{!props.target ? "Choose a target before running checks." : "This contract has secured operations, but no session credential is set. Auth checks may be inconclusive."}</span><button className="link-button" onClick={() => props.openSettings(props.target ? "auth" : "target")}>{!props.target ? "Set target" : "Review auth"}<ArrowRight size={13} /></button></div>}
      <div className="surface run-presets"><div><strong>Saved run configurations</strong><small>Store coverage, fixtures, and roles. Credentials are never saved.</small></div><select aria-label="Saved run configurations" value={props.presetId} onChange={(event) => { const id = event.target.value; props.setPresetId(id); props.setPresetName(props.presets.find((item) => item.id === id)?.name ?? ""); }}><option value="">Choose a saved configuration</option>{props.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><input value={props.presetName} onChange={(event) => props.setPresetName(event.target.value)} placeholder="Name this configuration" aria-label="Run configuration name" /><button className="button button-secondary" onClick={() => props.loadPreset()} disabled={!props.presetId}>Load</button><button className="button button-secondary" onClick={props.savePreset}>{props.presetId ? "Update" : "Save"}</button>{props.presetId && <button className="button button-quiet danger-text" onClick={props.deletePreset}>Remove</button>}</div>
      <div className="run-config surface">
        <section className="run-scope">
          <div className="run-scope-heading"><div><strong>What to check</strong><span>Run the whole contract, or pick the groups you changed.</span></div><div className="scope-mode segmented"><button aria-pressed={props.scopeMode === "all"} className={props.scopeMode === "all" ? "active" : ""} onClick={() => props.setScopeMode("all")}>Entire API <span>{model.operations.length}</span></button><button aria-pressed={props.scopeMode === "groups"} className={props.scopeMode === "groups" ? "active" : ""} onClick={() => props.setScopeMode("groups")}>Choose groups</button></div></div>
          {props.scopeMode === "groups" ? <>
            <div className="run-pick-tools"><label className="run-scope-search"><Search size={15} /><input aria-label="Search groups" value={scopeQuery} onChange={(event) => setScopeQuery(event.target.value)} placeholder="Search groups" /></label><div><button className="link-button" onClick={() => props.setSelectedGroups([...new Set([...props.selectedGroups, ...visibleScopeGroups.map(([name]) => name)])])}>Select {scopeQuery ? "matching" : "all"}</button><button className="link-button" onClick={() => props.setSelectedGroups([])} disabled={!props.selectedGroups.length}>Clear</button></div></div>
            <div className="run-group-tiles">{displayedScopeGroups.map(([group, groupOperations]) => <label className="run-group-tile" key={group}><input type="checkbox" checked={props.selectedGroups.includes(group)} onChange={(event) => props.setSelectedGroups(event.target.checked ? [...props.selectedGroups, group] : props.selectedGroups.filter((item) => item !== group))} /><span>{group}</span><small>{groupOperations.length} {groupOperations.length === 1 ? "op" : "ops"}</small></label>)}</div>
            {visibleScopeGroups.length > displayedScopeGroups.length && <p className="run-empty-groups">Showing {displayedScopeGroups.length} of {visibleScopeGroups.length}. Search to narrow the list.</p>}
            {!visibleScopeGroups.length && <p className="run-empty-groups">No group matches that search.</p>}
          </> : <div className="run-all-note">All {scopeGroups.length} groups and {model.operations.length} operations will run.</div>}
          </section>
        <details className="advanced-run-config" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary><span>Advanced configuration <small>Fixtures and roles. Optional.</small></span><ChevronDown size={14} /></summary><div className="run-advanced-grid">
        <details id="fixtures-editor" className="run-options fixtures-options" open={props.fixturesOpen} onToggle={(event) => props.setFixturesOpen(event.currentTarget.open)}><summary><span>Path fixtures</span><small>Optional · replace generated path values with known resources</small></summary><label className="field-label" htmlFor="fixtures-json">PATH PARAMETER VALUES</label><textarea id="fixtures-json" className="roles-editor" value={props.fixtures} onChange={(event) => props.setFixtures(event.target.value)} placeholder={'{"id":"1","slug":"rose"}'} /><label className="discovery-toggle"><input type="checkbox" checked={props.discoverFixtures} onChange={(event) => props.setDiscoverFixtures(event.target.checked)} /><span><strong>Discover IDs from list responses</strong><small>Use the first item returned by a matching GET list operation. Off by default.</small></span></label></details>
        <details className="run-options"><summary><span>Role configurations</span><small>Optional · test operations with multiple access levels</small></summary><label className="field-label" htmlFor="role-config">CONFIGURATION JSON</label><textarea id="role-config" className="roles-editor" value={props.roles} onChange={(event) => props.setRoles(event.target.value)} placeholder={'[{"name":"viewer","token":"...","allowed_operation_ids":["list_items"]}]'} /><p>Provide role credentials and the operation IDs each role can access. Saved run configurations clear token fields, so enter role tokens again after loading.</p></details>
        <details className="contract-structure"><summary><span>Document schemas and relationships</span><small>{schemas.length} named schemas</small><ChevronDown size={14} /></summary>{schemas.length ? <div className="schema-table-wrap"><table className="schema-table"><thead><tr><th>SCHEMA</th><th>FIELDS</th><th>RELATIONSHIPS</th></tr></thead><tbody>{schemas.map(([name, schema]) => { const properties = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties as Record<string, unknown>) : []; const relations = schemaRelations(schema); return <tr key={name}><th>{name}</th><td>{properties.length ? properties.map((field) => <code key={field}>{field}</code>) : <span className="muted">No named fields</span>}</td><td>{relations.length ? relations.map((relation) => <code key={relation}>{relation}</code>) : <span className="muted">No direct references</span>}</td></tr>; })}</tbody></table></div> : <p className="schema-empty">This document has no named component schemas to map.</p>}</details>
        </div></details>
        {props.runError && <InlineMessage tone="error">{props.runError}</InlineMessage>}
      </div>
      <div className="run-sticky-actions"><div><strong>{props.scopeMode === "all" ? `${scopeGroups.length} groups, ${model.operations.length} operations` : `${props.selectedGroups.length} groups, ${selectedOperationCount} operations`}</strong><span>{props.scopeMode === "all" ? "Entire API" : selectedOperationCount ? `Read-only checks against ${props.target || "No target configured"}` : "Choose at least one group to run."}</span></div><button className="button button-primary" onClick={props.run} disabled={props.runBusy || !props.target || (props.scopeMode === "groups" && !props.selectedGroups.length)}>{props.runBusy ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{props.runBusy ? "Running checks" : "Run checks"}<ArrowRight size={14} /></button></div>
      </div>}
      {runsView === "results" && props.report && props.summary && <>
        <div className="run-history-toolbar"><label>Compare with<select value={props.previousRunId} onChange={(event) => props.setPreviousRunId(event.target.value)}><option value="">No comparison</option>{props.history.filter((item) => item.status === "completed" && item.run_id !== props.report?.run_id).map((item) => <option key={item.run_id} value={item.run_id}>{new Date(item.started_at).toLocaleString()} · {item.run_id.slice(0, 8)}</option>)}</select></label><button className="button button-secondary" onClick={shareFilteredView}><Copy size={14} />Copy filtered view link</button></div>
        <section className="run-overview">
          <div className="surface run-summary-card">
            <h2 className="run-verdict">{props.summary.verdict}</h2>
            <p className="run-verdict-sub">{counts.fail ?? 0} failed, {counts.inconclusive ?? 0} inconclusive, {counts.pass ?? 0} passed across {props.summary.operation_count} operations.</p>
            <StackedResultBar counts={counts} />
            <div className="run-status-legend">{(["fail", "inconclusive", "pass"] as const).map((status) => <button key={status} onClick={() => { props.setStatusFilter(status); props.setActiveCluster(null); document.getElementById("runs-findings")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><i className={`legend-dot ${status}`} />{statusLabel(status)} <b>{counts[status] ?? 0}</b></button>)}</div>
            <div className="run-kpi-breakdown"><div><div className="card-label">SEVERITY × STATUS</div><p className="breakdown-note">Severity is potential impact. Status is this run's result.</p><SeverityMatrix matrix={props.summary.severity_status} /></div></div>
            {missingFixtureCount > 0 && <div className="fixture-summary">{missingFixtureCount} inconclusive due to missing fixtures <button className="link-button" onClick={() => { setRunsView("configuration"); setAdvancedOpen(true); props.setFixturesOpen(true); window.setTimeout(() => document.getElementById("fixtures-editor")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0); }}>Configure fixtures</button></div>}
          </div>
          <div className="run-result-columns">
            <div className="run-result-priorities">
              {props.summary.clusters.length > 0 && <section className="surface run-result-panel"><h2>Needs attention</h2><p className="lead">{props.summary.clusters.reduce((sum, cluster) => sum + cluster.count, 0)} failures across {props.summary.clusters.length} causes. Start with the first.</p><ul className="run-cluster-list">{props.summary.clusters.map((cluster) => <li key={cluster.cluster_key}><button className="run-cluster-row" onClick={() => { props.setActiveCluster(cluster.cluster_key); props.setStatusFilter("fail"); document.getElementById("runs-findings")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><span className="run-result-icon fail" /><span className="run-cluster-copy"><strong>{cluster.observed || cluster.title}</strong><small>{cluster.check} · {cluster.sample_endpoints.slice(0, 2).map((endpoint) => `${endpoint.method ?? ""} ${endpoint.path}`).join(" · ")}</small></span><span className="run-cluster-count">{cluster.count} <small>{cluster.count === 1 ? "finding" : "findings"}</small></span></button></li>)}</ul></section>}
              {inconclusiveReasons.length > 0 && <section className="surface run-result-panel"><h2>Why some results are inconclusive</h2><p className="lead">The check could not decide. Review the evidence for each reason.</p><ul className="run-cluster-list">{inconclusiveReasons.map(({ reason, count }) => <li key={reason}><button className="run-cluster-row" onClick={() => { props.setStatusFilter("inconclusive"); props.setActiveCluster(null); document.getElementById("runs-findings")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><span className="run-result-icon inconclusive" /><span className="run-cluster-copy"><strong>{reason}</strong><small>{reason.toLowerCase().includes("fixture") ? "Add a real path value in Advanced configuration." : "Open a finding below to inspect its request and response evidence."}</small></span><span className="run-cluster-count">{count}</span></button></li>)}</ul></section>}
            </div>
            <section className="surface run-result-panel run-by-check"><h2>By check</h2><p className="lead">Results for each type of check.</p><div className="run-check-list">{checkResults.length ? checkResults.map((item) => { const total = item.fail + item.inconclusive + item.pass; return <div className="run-check-item" key={item.check}><span>{item.check}</span><div className="run-check-bar">{item.fail > 0 && <i className="fail" style={{ flex: item.fail }} />}{item.inconclusive > 0 && <i className="inconclusive" style={{ flex: item.inconclusive }} />}{item.pass > 0 && <i className="pass" style={{ flex: item.pass }} />}</div><b>{item.fail} failed</b><small>{total} results</small></div>; }) : <p className="run-empty-state">No checks in this run.</p>}</div></section>
          </div>
        </section>
        {comparison && <section className="surface run-comparison"><div className="run-comparison-heading"><div><h2>Compared with previous run</h2><p>{props.previousReport?.run_id.slice(0, 10)} · {new Date(props.previousReport!.started_at).toLocaleString()}</p></div>{!comparison.sameScope && <span className="compare-scope-note">Coverage changed. New failures without a matching earlier finding are omitted.</span>}</div><div className="comparison-kpis"><div><strong>{comparison.newFailures.length}</strong><span>New failures</span></div><div><strong>{comparison.fixedFailures.length}</strong><span>Fixed</span></div><div><strong>{comparison.unchangedFailures.length}</strong><span>Unchanged failures</span></div></div><div className="comparison-lists">{([['New failures', comparison.newFailures], ['Fixed', comparison.fixedFailures], ['Unchanged failures', comparison.unchangedFailures]] as [string, Finding[]][]).map(([label, findings]) => <div key={label}><h3>{label}</h3>{findings.length ? <ul>{findings.slice(0, 6).map((finding) => <li key={finding.id}><code>{finding.operation_id ?? "API"}</code><span>{finding.check} · {finding.observed}</span></li>)}</ul> : <p>None</p>}</div>)}</div></section>}
        <section className="triage-section surface" id="runs-findings">
          <div className="triage-heading"><div><h2>Findings</h2><p>Select a row to see the evidence.</p></div><div className="keyboard-hint"><kbd>j</kbd><kbd>k</kbd> move <kbd>/</kbd> search</div></div>
          <div className="triage-filters"><div className="segmented">{(["all", "fail", "inconclusive", "pass"] as const).map((status) => <button key={status} aria-pressed={props.statusFilter === status} className={props.statusFilter === status ? "active" : ""} onClick={() => { props.setStatusFilter(status); props.setActiveCluster(null); }}>{status === "all" ? "All" : statusLabel(status)}<span>{status === "all" ? props.report?.findings.length ?? 0 : counts[status] ?? 0}</span></button>)}</div><label className="search-control finding-search"><Search size={14} /><input ref={props.searchRef} value={props.search} onChange={(event) => props.setSearch(event.target.value)} placeholder="Search operation or path" /><kbd>/</kbd></label><select value={props.checkFilter} onChange={(event) => props.setCheckFilter(event.target.value)} aria-label="Filter by check"><option value="all">All checks</option>{checks.map((check) => <option key={check}>{check}</option>)}</select><select value={props.groupBy} onChange={(event) => props.setGroupBy(event.target.value as typeof props.groupBy)} aria-label="Group findings"><option value="none">No grouping</option><option value="check">Group by check</option><option value="endpoint">Group by endpoint</option><option value="cluster">Group by cluster</option></select>{props.activeCluster && <button className="button button-quiet clear-cluster" onClick={() => props.setActiveCluster(null)}><X size={13} />Clear cluster</button>}</div>
          <div className="run-findings-split"><div className="run-finding-list">{groups.flatMap((group) => [
            ...(props.groupBy !== "none" ? [<div className="run-list-group" key={`group:${group.key}`}>{group.label}<span>{group.findings.length}</span></div>] : []),
            ...group.findings.map((finding) => <button key={finding.id} type="button" ref={(node) => { props.rowRefs.current[finding.id] = node; }} aria-current={props.selectedId === finding.id} className="run-finding-row" onClick={() => props.setSelectedId(finding.id)}><span className={`run-result-icon ${finding.status}`} aria-label={statusLabel(finding.status)} /><span className="run-finding-copy"><strong>{finding.operation_id ?? "API"}</strong><code>{operations.get(finding.operation_id ?? "")?.method} {operations.get(finding.operation_id ?? "")?.path}</code></span><span className="run-finding-meta"><span>{finding.check}</span>{finding.variant && <span>{finding.variant}</span>}{finding.status !== "pass" && <SeverityBadge severity={finding.severity} />}</span></button>),
          ])}{!props.findings.length && <div className="run-list-empty">No findings match these filters.</div>}</div>
            <aside className="finding-detail" aria-label="Finding detail">{props.selectedFinding ? <FindingDetail finding={props.selectedFinding} operation={operations.get(props.selectedFinding.operation_id ?? "")} copy={props.copy} configureFixtures={() => { setRunsView("configuration"); setAdvancedOpen(true); props.setFixturesOpen(true); window.setTimeout(() => document.getElementById("fixtures-editor")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0); }} /> : <div className="detail-empty"><Search size={18} /><span>Select a finding to inspect evidence.</span></div>}</aside>
          </div>
        </section>
      </>}
    </>}
  </section>;
}

function McpPage({ model, target, tokenSet, mutations, config, error, busy, generate, copy, test, testBusy, testError, testResult }: {
  model: ApiModel | null; target: string; tokenSet: boolean; mutations: boolean;
  config: string;
  error: string; busy: boolean; generate: () => void; copy: (value: string, message: string) => void;
  test: () => void; testBusy: boolean; testError: string; testResult: McpTestResult | null;
}) {
  const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const mutationToolCount = model?.operations.filter((operation) => mutationMethods.has(operation.method.toUpperCase())).length ?? 0;
  const readOnly = (model?.operations.length ?? 0) - mutationToolCount;
  return <section className="page mcp-page"><PageHeading subtitle="Connect any MCP-compatible agent to explore and call this API's tools." />
    <div className="surface mcp-intro"><div className="heading-icon"><Braces size={17} /></div><div><strong>One MCP server, many clients</strong><p>Any agent that supports MCP can discover and call Plumbline tools against your selected API target. Add the server command in that agent's MCP settings; each client may use a different config-file format.</p></div><div className="mcp-target"><span>SESSION TARGET</span><code>{target || "Not set"}</code></div></div>
    {!model ? <EmptyState title="Import an API to generate MCP tools" action="Go to import" /> : <div className="mcp-layout"><div className="surface mcp-config-card"><div className="section-heading"><div><div className="eyebrow">MCP SERVER</div><h2>Connect an MCP-enabled agent</h2></div><span className="ready-indicator"><span />API loaded</span></div><div className="path-note">This stdio server entry includes the imported API model and selected target. Use it as a starting point for Claude Desktop, Cursor, or another MCP-compatible agent.</div><div className="mcp-tool-counts"><div><span>READ ONLY</span><strong>{readOnly}</strong><small>GET tools</small></div><div><span>STATE CHANGING</span><strong>{mutationToolCount}</strong><small>POST / PUT / PATCH / DELETE</small></div></div><div className="mcp-token-note"><KeyRound size={15} /><span>{tokenSet ? "The config references PLUMBLINE_TOKEN from the client environment. The token itself is never included." : "No session token set. The MCP server will connect without configured auth."}</span></div>{error && <InlineMessage tone="error">{error}</InlineMessage>}{testError && <InlineMessage tone="error">{testError}</InlineMessage>}<div className="mcp-actions"><button className="button button-primary" onClick={generate} disabled={busy}>{busy ? <LoaderCircle size={14} className="spin" /> : <Braces size={14} />}Generate MCP server config</button><button className="button button-secondary" onClick={test} disabled={testBusy || !target}>{testBusy ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}Test connection</button></div>{testResult && <section className="mcp-test-result" role="status"><div><strong>MCP server started successfully</strong><span>{testResult.tool_count} tools · {testResult.read_only_count} read-only · {testResult.mutation_count} state-changing</span></div><details><summary>Show discovered tools</summary><ul>{testResult.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></li>)}</ul></details></section>}</div>
      <div className="surface generated-config"><div className="section-heading"><div><div className="eyebrow">SERVER CONFIG</div><h2>{config ? "Ready to copy" : "Configuration preview"}</h2></div>{config && <button className="icon-button" onClick={() => copy(config, "Config copied")} aria-label="Copy MCP configuration"><Copy size={15} /></button>}</div>{config ? <pre>{config}</pre> : <div className="config-placeholder"><Braces size={24} /><strong>Config appears here</strong><span>Generate the stdio server entry for your MCP settings.</span></div>}<div className={`readonly-note ${mutations ? "mutations-enabled" : ""}`}><ShieldCheck size={14} />{mutations ? "State-changing tools are enabled in this config." : "State-changing tools are blocked by default by the MCP server."}</div></div></div>}
  </section>;
}

function PageHeading({ subtitle, action }: { subtitle: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><p>{subtitle}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
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
  return <div className="stacked-result" role="img" aria-label={`Fail ${counts.fail ?? 0}, inconclusive ${counts.inconclusive ?? 0}, pass ${counts.pass ?? 0}`}>{total > 0 && <><span className="fail-segment" style={{ width: `${(counts.fail ?? 0) * 100 / total}%` }} /><span className="inconclusive-segment" style={{ width: `${(counts.inconclusive ?? 0) * 100 / total}%` }} /><span className="pass-segment" style={{ width: `${(counts.pass ?? 0) * 100 / total}%` }} /></>}</div>;
}

function SeverityMatrix({ matrix }: { matrix: Record<string, Record<string, number>> }) {
  return <table className="severity-matrix"><thead><tr><th></th><th>Fail</th><th>Inconcl.</th><th>Pass</th></tr></thead><tbody>{["high", "medium", "low", "info"].map((severity) => <tr key={severity}><th>{severity}</th><td className={(matrix[severity]?.fail ?? 0) ? "fail-text" : ""}>{matrix[severity]?.fail ?? 0}</td><td className={(matrix[severity]?.inconclusive ?? 0) ? "warn-text" : ""}>{matrix[severity]?.inconclusive ?? 0}</td><td className={(matrix[severity]?.pass ?? 0) ? "pass-text" : ""}>{matrix[severity]?.pass ?? 0}</td></tr>)}</tbody></table>;
}

function FindingDetail({ finding, operation, copy, configureFixtures }: { finding: Finding; operation?: Operation; copy: (value: string, message: string) => void; configureFixtures: () => void }) {
  const fixtureNeeded = finding.status === "inconclusive" && `${finding.expected} ${finding.observed}`.toLowerCase().includes("fixture");
  return <><div className="detail-top"><div><StatusBadge status={finding.status} label={statusLabel(finding.status)} />{finding.status !== "pass" && <SeverityBadge severity={finding.severity} />}</div><button className="icon-button" onClick={() => copy(pretty(finding), "Finding copied")} aria-label="Copy finding"><Copy size={14} /></button></div><h3>{finding.check}<span> / {finding.operation_id ?? "API"}</span></h3><div className="detail-endpoint"><MethodBadge method={operation?.method ?? "API"} /><code>{operation?.path ?? finding.operation_id ?? "API"}</code>{finding.variant && <span className="variant-label">Variant: {finding.variant}</span>}</div><div className="expect-observe"><section><span>EXPECTED</span><p>{finding.expected || "No expectation recorded."}</p></section><section><span>OBSERVED</span><p>{finding.observed || "No observation recorded."}</p></section></div>{fixtureNeeded && <div className="finding-next-step"><div><strong>Try this next</strong><span>Provide a real value for this path parameter, then rerun the scoped check.</span></div><button className="button button-secondary" onClick={configureFixtures}>Open fixtures <ArrowRight size={13} /></button></div>}<EvidencePanel title="REQUEST EVIDENCE" evidence={finding.request} /><EvidencePanel title="RESPONSE EVIDENCE" evidence={finding.response} /><div className="curl-panel"><div><span className="eyebrow">REPRODUCE</span><button className="button button-quiet" onClick={() => copy(curlFor(finding), "Curl command copied")}><Clipboard size={13} />Copy curl</button></div><pre>{curlFor(finding)}</pre></div></>;
}

function EvidencePanel({ title, evidence }: { title: string; evidence?: Evidence | null }) {
  return <details className="evidence-panel"><summary>{title}<ChevronDown size={13} /></summary>{evidence ? <pre>{pretty(evidence)}</pre> : <div className="empty-inline">No evidence was captured.</div>}</details>;
}

export default App;

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Code2,
  Copy,
  FileCheck2,
  FileJson2,
  FileUp,
  FlaskConical,
  Globe2,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";

type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
};

type Operation = {
  id: string;
  method: string;
  path: string;
  summary: string;
  tags?: string[];
  parameters: Parameter[];
  request_schema?: Record<string, unknown> | null;
  request_required?: boolean;
  security: string[];
};

type ApiModel = {
  title: string;
  version: string;
  operations: Operation[];
  security_schemes?: Record<string, Record<string, string>>;
};

type Evidence = {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  status?: number | null;
  body_snippet?: string;
  elapsed_ms?: number | null;
};

type Finding = {
  id: string;
  check: string;
  severity: string;
  status: "pass" | "fail" | "inconclusive";
  operation_id?: string | null;
  expected: string;
  observed: string;
  request?: Evidence | null;
  response?: Evidence | null;
};

type RunReport = {
  run_id: string;
  base_url: string;
  started_at: string;
  findings: Finding[];
  summary: Record<string, number>;
};

type Tab = "import" | "explorer" | "runs";
type AuthMode = "bearer" | "apikey";

const API = "/api";
const DEMO_SPEC_URL = import.meta.env.VITE_DEMO_SPEC_URL ?? "http://127.0.0.1:8001/openapi.json";

function sampleFromSchema(schema?: Record<string, unknown>): unknown {
  if (!schema) return {};
  if ("example" in schema) return schema.example;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required ?? []) as string[]);
    return Object.fromEntries(
      Object.entries(properties)
        .filter(([key]) => required.size === 0 || required.has(key))
        .map(([key, value]) => [key, sampleFromSchema(value)]),
    );
  }
  if (schema.type === "array") return [sampleFromSchema(schema.items as Record<string, unknown>)];
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "string") return "example";
  return null;
}

function parameterInitialValue(parameter: Parameter): string {
  const value = sampleFromSchema(parameter.schema);
  return value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
}

function errorMessage(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "detail" in payload) {
    return String((payload as { detail: unknown }).detail);
  }
  return "The request could not be completed.";
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(payload));
  return payload as T;
}

function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function statusLabel(status: string): string {
  return status === "pass" ? "Pass" : status === "fail" ? "Fail" : "Inconclusive";
}

function App() {
  const [tab, setTab] = useState<Tab>("import");
  const [model, setModel] = useState<ApiModel | null>(null);
  const [specText, setSpecText] = useState("");
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [selectedOperationId, setSelectedOperationId] = useState("");
  const [operationSearch, setOperationSearch] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("bearer");
  const [token, setToken] = useState("");
  const [apiKeyHeader, setApiKeyHeader] = useState("X-API-Key");
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [bodyValue, setBodyValue] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [responsePayload, setResponsePayload] = useState<Record<string, unknown> | null>(null);
  const [specPath, setSpecPath] = useState("");
  const [mcpConfig, setMcpConfig] = useState("");
  const [mcpBusy, setMcpBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [allowMutations, setAllowMutations] = useState(false);
  const [rolesText, setRolesText] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [report, setReport] = useState<RunReport | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState("");
  const [copyHint, setCopyHint] = useState("");

  const selectedOperation = useMemo(
    () => model?.operations.find((operation) => operation.id === selectedOperationId) ?? null,
    [model, selectedOperationId],
  );
  const selectedFinding = report?.findings.find((finding) => finding.id === selectedFindingId) ?? null;

  const operationGroups = useMemo(() => {
    const groups = new Map<string, Operation[]>();
    const term = operationSearch.trim().toLowerCase();
    for (const operation of model?.operations ?? []) {
      const searchable = `${operation.id} ${operation.path} ${operation.method} ${operation.summary}`.toLowerCase();
      if (term && !searchable.includes(term)) continue;
      const tag = operation.tags?.[0] || operation.path.split("/").filter(Boolean)[0] || "Other";
      groups.set(tag, [...(groups.get(tag) ?? []), operation]);
    }
    return [...groups.entries()];
  }, [model, operationSearch]);

  useEffect(() => {
    if (!selectedOperation) return;
    setParameterValues(
      Object.fromEntries(selectedOperation.parameters.map((parameter) => [parameter.name, parameterInitialValue(parameter)])),
    );
    setBodyValue(
      selectedOperation.request_schema
        ? JSON.stringify(sampleFromSchema(selectedOperation.request_schema), null, 2)
        : "",
    );
    setResponsePayload(null);
    setRequestError("");
  }, [selectedOperation]);

  async function importSpec(text = specText) {
    if (!text.trim()) {
      setImportError("Paste or choose an OpenAPI document first.");
      return;
    }
    setImportBusy(true);
    setImportError("");
    try {
      const imported = await apiRequest<ApiModel>(`${API}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: text }),
      });
      setModel(imported);
      setSelectedOperationId(imported.operations[0]?.id ?? "");
      setTab("explorer");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not import the contract.");
    } finally {
      setImportBusy(false);
    }
  }

  async function loadDemoContract() {
    setImportBusy(true);
    setImportError("");
    try {
      const imported = await apiRequest<ApiModel>(`${API}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: DEMO_SPEC_URL }),
      });
      setModel(imported);
      setSelectedOperationId(imported.operations[0]?.id ?? "");
      setSpecPath("demo_api/openapi.json");
      setTab("explorer");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not load the demo API contract.");
    } finally {
      setImportBusy(false);
    }
  }

  async function sendOperation() {
    if (!selectedOperation) return;
    setRequestError("");
    setResponsePayload(null);
    if (!baseUrl.trim()) {
      setRequestError("Enter the API base URL before sending a request.");
      return;
    }
    const parameters: Record<string, unknown> = {};
    try {
      for (const parameter of selectedOperation.parameters) {
        const raw = parameterValues[parameter.name] ?? "";
        if (!raw && !parameter.required) continue;
        if (!raw && parameter.required) throw new Error(`${parameter.name} is required.`);
        const type = parameter.schema?.type;
        parameters[parameter.name] =
          type === "integer" || type === "number"
            ? Number(raw)
            : type === "boolean"
              ? raw === "true"
              : type === "array" || type === "object"
                ? JSON.parse(raw)
                : raw;
      }
      const body = selectedOperation.request_schema ? JSON.parse(bodyValue || "null") : undefined;
      setRequestBusy(true);
      const result = await apiRequest<Record<string, unknown>>(`${API}/explorer/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation_id: selectedOperation.id,
          base_url: baseUrl,
          parameters,
          body,
          auth: token ? { type: authMode, token, header_name: apiKeyHeader } : null,
        }),
      });
      setResponsePayload(result);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The request could not be completed.");
    } finally {
      setRequestBusy(false);
    }
  }

  async function getMcpConfig() {
    if (!baseUrl.trim() || !specPath.trim()) {
      setRequestError("Enter the API base URL and the OpenAPI file path available to the MCP client.");
      return;
    }
    setMcpBusy(true);
    setRequestError("");
    try {
      const query = new URLSearchParams({ spec_path: specPath, base_url: baseUrl });
      const config = await apiRequest<Record<string, unknown>>(`${API}/mcp-config?${query.toString()}`);
      setMcpConfig(JSON.stringify(config, null, 2));
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Could not build the MCP config.");
    } finally {
      setMcpBusy(false);
    }
  }

  async function copyMcpConfig() {
    await navigator.clipboard.writeText(mcpConfig);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function runChecks() {
    setRunError("");
    setReport(null);
    if (!baseUrl.trim()) {
      setRunError("Enter the API base URL before starting a run.");
      return;
    }
    let roles: unknown[] = [];
    try {
      roles = rolesText.trim() ? JSON.parse(rolesText) : [];
      if (!Array.isArray(roles)) throw new Error("Roles must be a JSON array.");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Roles must be valid JSON.");
      return;
    }
    setRunBusy(true);
    try {
      const created = await apiRequest<{ run_id: string }>(`${API}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_url: baseUrl,
          auth: token ? { type: authMode, token, header_name: apiKeyHeader } : null,
          roles,
          allow_mutations: allowMutations,
        }),
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = await apiRequest<{ status: string }>(`${API}/runs/${created.run_id}`);
        if (status.status === "completed") {
          const completed = await apiRequest<RunReport>(`${API}/runs/${created.run_id}/report.json`);
          setReport(completed);
          setSelectedFindingId(completed.findings[0]?.id ?? "");
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      throw new Error("The run is still in progress. Open Runs again to refresh its status.");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "The test run failed.");
    } finally {
      setRunBusy(false);
    }
  }

  async function loadFile(file?: File) {
    if (!file) return;
    setSpecText(await file.text());
    setImportError("");
  }

  const tabs: { id: Tab; label: string; icon: typeof FileCheck2; count?: number }[] = [
    { id: "import", label: "Import", icon: FileUp },
    { id: "explorer", label: "Explorer", icon: Code2, count: model?.operations.length },
    { id: "runs", label: "Runs", icon: FlaskConical, count: report?.findings.length },
  ];

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand-mark"><span className="brand-glyph"><Activity size={19} /></span></div>
        <div className="rail-rule" />
        <div className="rail-status"><span className="pulse-dot" /><span>LOCAL</span></div>
        <div className="rail-bottom"><span className="rail-version">0.1.0</span><span className="rail-line" /></div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="wordmark">plumbline<span className="wordmark-period">.</span></div>
          <div className="topbar-center"><span className="eyebrow">API CONTRACT WORKBENCH</span><span className="topbar-divider" /><span className="topbar-context">{model?.title || "No contract loaded"}</span></div>
          <div className="topbar-right"><span className="connection-indicator"><span /> backend ready</span><span className="topbar-separator" /><span className="avatar">M</span></div>
        </header>

        <div className="app-body">
          <nav className="sidebar">
            <div className="sidebar-caption">WORKSPACE</div>
            <div className="nav-list">
              {tabs.map(({ id, label, icon: Icon, count }) => (
                <button key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                  <Icon size={16} strokeWidth={1.8} /><span>{label}</span>{count !== undefined && <span className="nav-count">{count}</span>}
                </button>
              ))}
            </div>
            <div className="sidebar-spacer" />
            <div className="sidebar-note">
              <div className="sidebar-note-icon"><ShieldCheck size={15} /></div>
              <div><span>SAFE BY DEFAULT</span><p>State-changing checks stay off until enabled.</p></div>
            </div>
            <div className="sidebar-footer"><span className="footer-mark">PL</span><span>Engineering tools</span><span className="footer-dot" /></div>
          </nav>

          <main className="main-content">
            {tab === "import" && (
              <section className="page import-page">
                <PageHeading index="01" title="Import a contract" subtitle="Bring an OpenAPI document into your workspace to explore and verify its behavior." />
                <div className="import-layout">
                  <div className="panel import-editor-panel">
                    <div className="panel-heading">
                      <div className="panel-heading-title"><span className="step-icon"><FileJson2 size={16} /></span><div><h2>OpenAPI source</h2><p>JSON or YAML · OpenAPI 3.x</p></div></div>
                      <label className="button button-quiet upload-button"><FileUp size={14} /> Choose file<input type="file" accept=".json,.yaml,.yml,application/json,text/yaml" onChange={(event) => void loadFile(event.target.files?.[0])} /></label>
                    </div>
                    <textarea className="spec-editor" spellCheck={false} value={specText} onChange={(event) => setSpecText(event.target.value)} placeholder={'Paste your OpenAPI JSON or YAML here…\n\nopenapi: 3.0.3\ninfo:\n  title: Example API\n  version: 1.0.0\npaths: {}'} />
                    <div className="editor-footer"><span><Braces size={13} /> {specText ? `${specText.length.toLocaleString()} characters` : "Waiting for a specification"}</span><span className="editor-language">YAML / JSON</span></div>
                    {importError && <InlineError>{importError}</InlineError>}
                    <div className="import-actions"><button className="button button-primary" onClick={() => void importSpec()} disabled={importBusy}>{importBusy ? <LoaderCircle className="spin" size={15} /> : <FileCheck2 size={15} />}{importBusy ? "Validating contract" : "Validate and import"}<ArrowRight size={14} /></button><button className="button button-quiet" onClick={() => void loadDemoContract()} disabled={importBusy}><Play size={13} /> Load demo contract</button></div>
                  </div>
                  <div className="import-aside">
                    <div className="aside-label">WHAT HAPPENS NEXT</div>
                    <div className="flow-card"><div className="flow-number">01</div><div><strong>Validate</strong><p>References are resolved and the document is checked against the OpenAPI specification.</p></div><Check size={14} /></div>
                    <div className="flow-connector" />
                    <div className="flow-card"><div className="flow-number">02</div><div><strong>Normalize</strong><p>Operations, parameters, security and schemas become one shared API model.</p></div><Check size={14} /></div>
                    <div className="flow-connector" />
                    <div className="flow-card"><div className="flow-number">03</div><div><strong>Explore</strong><p>Send a request or run checks against an explicitly chosen base URL.</p></div><ArrowRight size={14} /></div>
                    <div className="import-tip"><CircleAlert size={15} /><p>The contract describes the API. Choose the target URL separately before sending requests.</p></div>
                  </div>
                </div>
              </section>
            )}

            {tab === "explorer" && (
              <section className="page explorer-page">
                <PageHeading index="02" title="API explorer" subtitle="Inspect operations and send a request against your chosen API instance." />
                {!model ? <EmptyState title="Import a contract to begin" action="Open import" onClick={() => setTab("import")} /> : (
                  <div className="explorer-layout">
                    <aside className="operation-browser panel">
                      <div className="browser-top"><div className="browser-title"><span className="live-small" /><div><strong>{model.title}</strong><span>v{model.version} · {model.operations.length} operations</span></div></div><button className="icon-button" title="Refresh model" onClick={() => window.location.reload()}><RefreshCw size={14} /></button></div>
                      <label className="search-box"><Search size={14} /><input value={operationSearch} onChange={(event) => setOperationSearch(event.target.value)} placeholder="Filter operations" /><kbd>/</kbd></label>
                      <div className="operation-list">
                        {operationGroups.map(([group, operations]) => <div className="operation-group" key={group}><div className="group-label">{group}<span>{operations.length.toString().padStart(2, "0")}</span></div>{operations.map((operation) => <button key={operation.id} className={`operation-row ${selectedOperationId === operation.id ? "selected" : ""}`} onClick={() => setSelectedOperationId(operation.id)}><span className={`method method-${operation.method.toLowerCase()}`}>{operation.method}</span><span className="operation-path">{operation.path}</span></button>)}</div>)}
                        {!operationGroups.length && <div className="empty-filter">No matching operations</div>}
                      </div>
                      <div className="browser-footer"><span className="tiny-dot" /> CONTRACT LOADED<span className="browser-footer-version">{model.version || "unversioned"}</span></div>
                    </aside>

                    <div className="operation-workbench">
                      {selectedOperation && <>
                        <div className="operation-header panel"><div><div className="crumb">{selectedOperation.tags?.[0] || "Operation"}<ChevronRight size={12} />{selectedOperation.id}</div><div className="operation-title-row"><span className={`method method-${selectedOperation.method.toLowerCase()}`}>{selectedOperation.method}</span><h2>{selectedOperation.path}</h2><button className="icon-button copy-path" title="Copy path" onClick={() => void navigator.clipboard.writeText(selectedOperation.path)}><Copy size={13} /></button></div><p>{selectedOperation.summary || "No operation description provided."}</p></div><div className="operation-id">OPERATION ID <code>{selectedOperation.id}</code></div></div>

                        <div className="target-bar panel"><div className="target-label"><Globe2 size={14} /><span>TARGET</span></div><input aria-label="API base URL" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" /><span className="target-hint">Set explicitly</span></div>

                        <div className="request-grid">
                          <div className="panel request-panel"><div className="section-head"><div><span className="section-index">01</span><h3>Request configuration</h3></div><span className="request-method-label">{selectedOperation.method}</span></div>
                            <div className="auth-row"><div><label className="field-label">AUTHENTICATION</label><div className="auth-control"><select value={authMode} onChange={(event) => setAuthMode(event.target.value as AuthMode)}><option value="bearer">Bearer token</option><option value="apikey">API key</option></select><ChevronDown size={12} /></div></div><div className="auth-token-field"><label className="field-label">TOKEN</label><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Optional credential" autoComplete="off" /></div>{authMode === "apikey" && <div className="auth-header-field"><label className="field-label">HEADER</label><input value={apiKeyHeader} onChange={(event) => setApiKeyHeader(event.target.value)} /></div>}</div>
                            {selectedOperation.parameters.length > 0 && <div className="request-section"><div className="request-subhead"><span>PARAMETERS</span><span>{selectedOperation.parameters.length} defined</span></div><div className="parameter-grid">{selectedOperation.parameters.map((parameter) => <ParameterInput key={`${parameter.in}:${parameter.name}`} parameter={parameter} value={parameterValues[parameter.name] ?? ""} onChange={(value) => setParameterValues((current) => ({ ...current, [parameter.name]: value }))} />)}</div></div>}
                            {selectedOperation.request_schema && <div className="request-section"><div className="request-subhead"><span>REQUEST BODY</span><span>{selectedOperation.request_required ? "required" : "optional"} · application/json</span></div><textarea className="body-editor" spellCheck={false} value={bodyValue} onChange={(event) => setBodyValue(event.target.value)} /></div>}
                            {requestError && <InlineError>{requestError}</InlineError>}
                            <div className="send-row"><span><ShieldCheck size={13} /> Requests are sent through the local backend proxy</span><button className="button button-primary send-button" onClick={() => void sendOperation()} disabled={requestBusy}>{requestBusy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}{requestBusy ? "Sending" : "Send request"}</button></div>
                          </div>
                          <div className="panel response-panel"><div className="section-head"><div><span className="section-index">02</span><h3>Response</h3></div>{responsePayload && <StatusPill label={String(responsePayload.status)} tone={Number(responsePayload.status) < 400 ? "pass" : "fail"} />}</div>
                            {responsePayload ? <><div className="response-meta"><span>{String(responsePayload.url ?? "")}</span><button className="icon-button" title="Copy response" onClick={() => void navigator.clipboard.writeText(pretty(responsePayload))}><Copy size={13} /></button></div><pre className="response-code">{typeof responsePayload.body === "string" ? formatBody(responsePayload.body) : pretty(responsePayload.body)}</pre><div className="response-footer"><span>HTTP RESPONSE</span><span>{Object.keys((responsePayload.headers ?? {}) as object).length} headers</span></div></> : <div className="response-empty"><div className="response-empty-icon"><Terminal size={20} /></div><strong>No response yet</strong><p>Configure the request and send it to inspect the live result.</p><span><span className="response-dot" /> Awaiting request</span></div>}
                          </div>
                        </div>

                        <div className="panel mcp-panel"><div className="mcp-copy"><div className="mcp-icon"><Braces size={17} /></div><div><h3>Connect an MCP client</h3><p>Generate a local server config for Claude Desktop or Cursor.</p></div></div><div className="mcp-fields"><div><label className="field-label">LOCAL SPEC FILE</label><input value={specPath} onChange={(event) => setSpecPath(event.target.value)} placeholder="/path/to/openapi.json" /></div><button className="button button-secondary" onClick={() => void getMcpConfig()} disabled={mcpBusy}>{mcpBusy ? <LoaderCircle className="spin" size={14} /> : <Terminal size={14} />}Generate config</button></div>{mcpConfig && <div className="mcp-result"><pre>{mcpConfig}</pre><button className="button button-quiet" onClick={() => void copyMcpConfig()}>{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? "Copied" : "Copy JSON"}</button></div>}</div>
                      </>}
                    </div>
                  </div>
                )}
              </section>
            )}

            {tab === "runs" && (
              <section className="page runs-page">
                <PageHeading index="03" title="Contract checks" subtitle="Run a focused verification against a real API response and review the evidence." />
                {!model ? <EmptyState title="Import a contract before running checks" action="Open import" onClick={() => setTab("import")} /> : <>
                  <div className="run-setup panel"><div className="run-setup-heading"><div className="run-setup-icon"><FlaskConical size={17} /></div><div><h2>New test run</h2><p>Target and credentials apply to this run only.</p></div><span className="safe-indicator"><ShieldCheck size={13} /> MUTATIONS OFF</span></div><div className="run-form-grid"><div className="form-field span-two"><label className="field-label">BASE URL <span className="required-mark">REQUIRED</span></label><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" /></div><div className="form-field"><label className="field-label">AUTH TYPE</label><select value={authMode} onChange={(event) => setAuthMode(event.target.value as AuthMode)}><option value="bearer">Bearer token</option><option value="apikey">API key</option></select></div><div className="form-field"><label className="field-label">TOKEN</label><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Optional" autoComplete="off" /></div><div className="form-field span-two"><label className="field-label">ROLE CONFIGURATION <span>OPTIONAL JSON ARRAY</span></label><textarea className="roles-editor" value={rolesText} onChange={(event) => setRolesText(event.target.value)} placeholder={'[{"name":"viewer","token":"...","allowed_operation_ids":["list_items"]}]'} /></div></div><div className="run-controls"><label className={`toggle-row ${allowMutations ? "enabled" : ""}`}><input type="checkbox" checked={allowMutations} onChange={(event) => setAllowMutations(event.target.checked)} /><span className="toggle-track"><span /></span><span><strong>Allow state-changing tests</strong><small>POST, PUT, PATCH and DELETE checks may modify the target API.</small></span></label><button className="button button-primary run-button" onClick={() => void runChecks()} disabled={runBusy}>{runBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={14} />}{runBusy ? "Running checks" : "Run contract checks"}<ArrowRight size={14} /></button></div>{runError && <InlineError>{runError}</InlineError>}</div>

                  {report && <div className="report-section"><div className="report-heading"><div><div className="eyebrow">LATEST RUN <span className="report-run-id">{report.run_id.slice(0, 12)}</span></div><h2>Findings and evidence</h2></div><div className="report-actions"><a className="button button-quiet" href={`${API}/runs/${report.run_id}/report.json`} download><ArrowDownToLine size={14} /> JSON</a><a className="button button-quiet" href={`${API}/runs/${report.run_id}/report.html`} target="_blank" rel="noreferrer"><ArrowDownToLine size={14} /> HTML</a></div></div><div className="summary-strip">{(["pass", "fail", "inconclusive"] as const).map((status) => <div className={`summary-card summary-${status}`} key={status}><span>{statusLabel(status)}</span><strong>{report.summary[status] ?? 0}</strong><small>findings</small></div>)}<div className="summary-target"><span>TEST TARGET</span><code>{report.base_url}</code><span className="summary-date">{new Date(report.started_at).toLocaleString()}</span></div></div><div className="findings-layout"><div className="findings-table-wrap"><table className="findings-table"><thead><tr><th>SEVERITY</th><th>STATUS</th><th>OPERATION</th><th>CHECK</th><th></th></tr></thead><tbody>{report.findings.map((finding) => <tr key={finding.id} className={selectedFindingId === finding.id ? "selected" : ""} onClick={() => setSelectedFindingId(finding.id)}><td><span className={`severity severity-${finding.severity}`}>{finding.severity}</span></td><td><StatusPill label={statusLabel(finding.status)} tone={finding.status} /></td><td><code>{finding.operation_id ?? "API"}</code></td><td>{finding.check}</td><td><ChevronRight size={14} /></td></tr>)}</tbody></table></div><div className="finding-detail panel">{selectedFinding ? <FindingDetail finding={selectedFinding} copyHint={copyHint} onCopy={async () => { await navigator.clipboard.writeText(pretty(selectedFinding)); setCopyHint("Copied evidence"); window.setTimeout(() => setCopyHint(""), 1400); }} /> : <div className="detail-empty">Select a finding to inspect its evidence.</div>}</div></div></div>}
                </>}
              </section>
            )}
            <footer className="page-footer"><span>PLUMBLINE / API CONTRACT VERIFICATION</span><span>REAL RESPONSES. EXPLICIT TARGETS.</span></footer>
          </main>
        </div>
      </div>
    </div>
  );
}

function formatBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function PageHeading({ index, title, subtitle }: { index: string; title: string; subtitle: string }) {
  return <div className="page-heading"><div className="page-index">{index}<span /></div><div><div className="eyebrow">PLUMBLINE / {index === "01" ? "CONTRACT" : index === "02" ? "EXPLORATION" : "VERIFICATION"}</div><h1>{title}</h1><p>{subtitle}</p></div><div className="heading-rule" /></div>;
}

function InlineError({ children }: { children: string }) {
  return <div className="inline-error"><CircleAlert size={14} /><span>{children}</span></div>;
}

function EmptyState({ title, action, onClick }: { title: string; action: string; onClick: () => void }) {
  return <div className="empty-state panel"><div className="empty-state-icon"><FileJson2 size={21} /></div><h2>{title}</h2><p>Your imported API model is shared by the explorer, MCP server and test runner.</p><button className="button button-primary" onClick={onClick}>{action}<ArrowRight size={14} /></button></div>;
}

function ParameterInput({ parameter, value, onChange }: { parameter: Parameter; value: string; onChange: (value: string) => void }) {
  const schema = parameter.schema ?? {};
  const type = String(schema.type ?? "string");
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  return <div className="parameter-field"><label className="field-label">{parameter.name}<span className="param-location">{parameter.in}</span>{parameter.required && <i>*</i>}</label>{enumValues.length ? <select value={value} onChange={(event) => onChange(event.target.value)}>{enumValues.map((entry) => <option key={String(entry)} value={String(entry)}>{String(entry)}</option>)}</select> : type === "boolean" ? <select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select</option><option value="true">true</option><option value="false">false</option></select> : <input type={type === "integer" || type === "number" ? "number" : "text"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={parameter.description || `Enter ${parameter.name}`} />}{parameter.description && <small>{parameter.description}</small>}</div>;
}

function StatusPill({ label, tone }: { label: string; tone: string }) {
  return <span className={`status-pill status-${tone}`}><span />{label}</span>;
}

function FindingDetail({ finding, copyHint, onCopy }: { finding: Finding; copyHint: string; onCopy: () => void }) {
  return <><div className="detail-heading"><div><span className={`severity severity-${finding.severity}`}>{finding.severity}</span><StatusPill label={statusLabel(finding.status)} tone={finding.status} /></div><button className="icon-button" onClick={onCopy} title="Copy evidence">{copyHint ? <Check size={14} /> : <Copy size={14} />}</button></div><h3>{finding.check}<span> / {finding.operation_id ?? "API"}</span></h3><div className="expect-observe"><div><span>EXPECTED</span><p>{finding.expected || "No expectation recorded."}</p></div><div><span>OBSERVED</span><p>{finding.observed || "No response detail recorded."}</p></div></div><EvidenceBlock title="REQUEST EVIDENCE" evidence={finding.request} /><EvidenceBlock title="RESPONSE EVIDENCE" evidence={finding.response} /></>;
}

function EvidenceBlock({ title, evidence }: { title: string; evidence?: Evidence | null }) {
  return <div className="evidence-block"><div className="evidence-title">{title}</div><pre>{evidence ? pretty(evidence) : "No evidence available"}</pre></div>;
}

export default App;
